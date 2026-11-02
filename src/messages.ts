import { randomUUID } from "node:crypto";
import {
  InvalidRequestError,
  ProtocolFailureError,
  RequestAbortedError,
  UnsupportedFeatureError,
} from "./errors.js";
import type {
  AcpTextBlock,
  ContextOccupancyDiagnostic,
  Message,
  MessageCreateOptions,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MaxTokensEnforcementDiagnostic,
  SessionConfiguration,
  SessionDriverAcknowledgement,
  SessionLedger,
  SessionLedgerReceipt,
  SessionMessages,
  SessionTranscript,
  SessionMessageSemanticEvent,
  SessionMessageStopReason,
  RawMessageStreamEvent,
  UsageProvenance,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;
type TextPart = { readonly type: "text"; readonly text: string };
type NormalizedRequest = {
  readonly messages: SessionTranscript;
  readonly maxTokens?: number;
  readonly stream: boolean;
};

const DEFAULT_UNKNOWN_USAGE_REASON = "The ACP driver did not report complete per-operation token usage.";
const RESPONSE_USAGE_PROVENANCE = new WeakMap<object, UsageProvenance>();
const RESPONSE_MAX_TOKENS_ENFORCEMENT = new WeakMap<object, MaxTokensEnforcementDiagnostic>();
const RESPONSE_STREAM_MAX_TOKENS_ENFORCEMENT = new WeakMap<
  object,
  Promise<MaxTokensEnforcementDiagnostic | undefined>
>();
const STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
  "tool_use",
]);

function invalidRequest(message = "The Messages request is invalid."): InvalidRequestError {
  return new InvalidRequestError(message);
}

function protocolFailure(message = "The session worker returned an invalid Messages result."): ProtocolFailureError {
  return new ProtocolFailureError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDataRecord(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const actualStrings = (actual as string[]).sort();
  const expected = [...keys].sort();
  return actualStrings.length === expected.length && actualStrings.every((key, index) => key === expected[index]);
}

function onlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.every((key) => typeof key === "string" && keys.includes(key));
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw invalidRequest();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
          throw invalidRequest();
        }
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidRequest();
        copy.push(cloneJsonValue(descriptor.value, ancestors));
      }
      return copy;
    }
    if (!isRecord(value)) throw invalidRequest();
    const copy: JsonRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalidRequest();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidRequest();
      Object.defineProperty(copy, key, {
        value: cloneJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  return cloneJsonValue(value, new Set()) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalidRequest("Message content must be text or an array of supported blocks.");
  const parts: string[] = [];
  for (const block of content) {
    if (!isDataRecord(block) || typeof block.type !== "string") {
      throw invalidRequest("Every message content block must be a supported plain object.");
    }
    if (block.type === "text") {
      if (!exactKeys(block, ["type", "text"])) {
        throw new UnsupportedFeatureError("Text block metadata and additional content fields are not supported.");
      }
      if (typeof block.text !== "string") throw invalidRequest("A text content block must contain string text.");
      parts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      if (!exactKeys(block, ["type", "id", "name", "input"]) ||
          typeof block.id !== "string" || typeof block.name !== "string" || !isDataRecord(block.input)) {
        throw invalidRequest("A historical tool_use block is malformed.");
      }
      parts.push(`[tool_use id=${block.id} name=${block.name}]\n${stableJson(block.input)}`);
      continue;
    }
    if (block.type === "tool_result") {
      if (!onlyKeys(block, ["type", "tool_use_id", "content", "is_error"]) ||
          !["type", "tool_use_id", "content"].every((key) => Object.prototype.hasOwnProperty.call(block, key)) ||
          typeof block.tool_use_id !== "string" ||
          (Object.prototype.hasOwnProperty.call(block, "is_error") && typeof block.is_error !== "boolean")) {
        throw invalidRequest("A historical tool_result block is malformed.");
      }
      let resultText: string;
      if (typeof block.content === "string") resultText = block.content;
      else if (Array.isArray(block.content)) {
        resultText = block.content.map((part) => {
          if (!isDataRecord(part) || part.type !== "text" || !exactKeys(part, ["type", "text"]) || typeof part.text !== "string") {
            throw new UnsupportedFeatureError("Only text tool_result content is supported.");
          }
          return part.text;
        }).join("");
      } else throw new UnsupportedFeatureError("Only string or text-block tool_result content is supported.");
      parts.push(`[tool_result id=${block.tool_use_id}${block.is_error === true ? " is_error=true" : ""}]\n${resultText}`);
      continue;
    }
    throw new UnsupportedFeatureError(`Messages content block '${block.type}' is not supported.`);
  }
  return parts.join("");
}

function normalizeMessages(value: unknown): SessionTranscript {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("messages must be a non-empty array.");
  }
  const messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];
  for (const message of value) {
    if (!isDataRecord(message)) throw invalidRequest("Every message must be a plain object.");
    if (typeof message.role !== "string") throw invalidRequest("Every message must have a string role.");
    if (message.role !== "user" && message.role !== "assistant") {
      throw new UnsupportedFeatureError(`Messages role '${message.role}' is not supported in S5.`);
    }
    if (!exactKeys(message, ["role", "content"])) {
      throw new UnsupportedFeatureError("Only role and content are supported in Messages history.");
    }
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw invalidRequest("Message content must be a string or an array of text blocks.");
    }
    // Retain caller-managed tool history exactly; active authority is checked
    // later against SDK-owned receipts, never inferred from historical blocks.
    const blocks: unknown[] = [];
    for (const block of message.content) {
      if (!isDataRecord(block) || typeof block.type !== "string") {
        throw invalidRequest("Every message content block must be a supported plain object.");
      }
      if (block.type === "text") {
        if (!exactKeys(block, ["type", "text"])) throw new UnsupportedFeatureError("Text block metadata and additional content fields are not supported.");
        if (typeof block.text !== "string") throw invalidRequest("A text content block must contain string text.");
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        if (message.role !== "assistant" || !exactKeys(block, ["type", "id", "name", "input"]) ||
            typeof block.id !== "string" || block.id.length === 0 || Buffer.byteLength(block.id, "utf8") > 256 ||
            typeof block.name !== "string" || block.name.length === 0 || Buffer.byteLength(block.name, "utf8") > 128 ||
            !isDataRecord(block.input)) throw invalidRequest("A tool_use block is malformed or has the wrong role.");
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: cloneJson(block.input) });
      } else if (block.type === "tool_result") {
        if (message.role !== "user" || !onlyKeys(block, ["type", "tool_use_id", "content", "is_error"]) ||
            !["type", "tool_use_id", "content"].every((key) => Object.prototype.hasOwnProperty.call(block, key)) ||
            typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0 || Buffer.byteLength(block.tool_use_id, "utf8") > 256 ||
            (Object.prototype.hasOwnProperty.call(block, "is_error") && typeof block.is_error !== "boolean")) {
          throw invalidRequest("A tool_result block is malformed or has the wrong role.");
        }
        let content: string | TextPart[];
        if (typeof block.content === "string") content = block.content;
        else if (Array.isArray(block.content)) {
          const textParts: TextPart[] = [];
          for (const part of block.content) {
            if (!isDataRecord(part) || part.type !== "text" || !exactKeys(part, ["type", "text"]) || typeof part.text !== "string") {
              throw new UnsupportedFeatureError("Only plain text tool_result content is supported.");
            }
            textParts.push({ type: "text", text: part.text });
          }
          content = textParts;
        } else throw new UnsupportedFeatureError("Only string or text-block tool_result content is supported.");
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content,
          ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
        });
      } else {
        throw new UnsupportedFeatureError(`Messages content block '${block.type}' is not supported.`);
      }
    }
    messages.push({ role: message.role, content: blocks });
  }
  return deepFreeze(messages) as unknown as SessionTranscript;
}

/** Validate and copy a full supported Messages transcript for the ledger seam. */
export function validateTextMessagesTranscript(value: unknown): SessionTranscript {
  return normalizeMessages(cloneJson(value));
}

function normalizeRequest(value: unknown): NormalizedRequest {
  const request = cloneJson(value);
  if (!isDataRecord(request)) throw invalidRequest("The Messages request must be a plain object.");
  const allowed = new Set(["max_tokens", "messages", "stream"]);
  const keys = Reflect.ownKeys(request);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new UnsupportedFeatureError("The Messages request contains fields outside the supported S5 subset.");
  }
  if (!Object.prototype.hasOwnProperty.call(request, "messages")) {
    throw invalidRequest("messages is required by the Anthropic Messages contract.");
  }
  const maxTokens = request.max_tokens;
  if (maxTokens !== undefined &&
      (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw invalidRequest("max_tokens must be a positive safe integer.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "stream")) {
    if (typeof request.stream !== "boolean") throw invalidRequest("stream, when supplied, must be boolean.");
  }
  return Object.freeze({
    messages: normalizeMessages(request.messages),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    stream: request.stream === true,
  });
}

function validateSessionOptions(value: unknown): MessageCreateOptions {
  if (value === undefined) return Object.freeze({});
  if (!isDataRecord(value) || Reflect.ownKeys(value).some((key) => key !== "signal")) {
    throw invalidRequest("Message options may contain only an AbortSignal.");
  }
  const signal = value.signal as AbortSignal | undefined;
  if (
    signal !== undefined && (!signal || typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) throw invalidRequest("signal must be an AbortSignal.");
  return Object.freeze(signal === undefined ? {} : { signal: signal as AbortSignal });
}

function systemText(configuration: SessionConfiguration): string {
  const system = configuration.system;
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) throw new UnsupportedFeatureError("The pinned system prompt is not supported by the S5 text adapter.");
  const texts: string[] = [];
  for (const block of system) {
    if (!isDataRecord(block) || block.type !== "text") {
      throw new UnsupportedFeatureError("Only text blocks are supported in the pinned system prompt.");
    }
    if (!exactKeys(block, ["type", "text"])) {
      throw new UnsupportedFeatureError("System text block metadata is not supported in S5.");
    }
    if (typeof block.text !== "string") throw invalidRequest("A system text block must contain string text.");
    texts.push(block.text);
  }
  return texts.join("");
}

function checkedTranscript(value: unknown): SessionTranscript {
  return normalizeMessages(value);
}

/**
 * Map the not-yet-committed Messages suffix into ACP v1 text blocks. ACP v1
 * prompt has no role/system channels, so roles are explicitly tagged as
 * `[user]`/`[assistant]`; fixed system instructions are a single tagged
 * `<instruction>` text block on the first operation only. Message text blocks
 * are concatenated without inserted characters, while message boundaries are
 * retained as separate ACP text blocks. Callers must supply only the ledger
 * suffix, never the already committed full transcript.
 */
export function mapMessagesToAcpPrompt(
  configuration: SessionConfiguration,
  suffix: SessionTranscript,
  options: { readonly includeSystem?: boolean } = {},
): readonly AcpTextBlock[] {
  const messages = checkedTranscript(suffix);
  const prompt: AcpTextBlock[] = [];
  if (options.includeSystem !== false) {
    const instruction = systemText(configuration);
    if (instruction.length > 0) {
      prompt.push(Object.freeze({ type: "text", text: `<instruction>\n${instruction}\n</instruction>` }));
    }
  }
  for (const message of messages) {
    const body = contentText(message.content);
    prompt.push(Object.freeze({ type: "text", text: `[${message.role}]\n${body}` }));
  }
  return Object.freeze(prompt);
}

export type MessageStopReason = SessionMessageStopReason;

/** Semantic output events shared by non-stream accumulation and S6 mapping. */
export type MessageSemanticEvent = SessionMessageSemanticEvent;

export interface NormalizedMessagesAcknowledgement {
  readonly output: SessionTranscript;
  readonly events: readonly MessageSemanticEvent[];
  readonly usage: UsageProvenance;
  readonly contextOccupancy?: ContextOccupancyDiagnostic;
}

function readCounter(value: JsonRecord, aliases: readonly string[]): number | undefined | null {
  const supplied = aliases
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => value[key]);
  if (supplied.length === 0) return undefined;
  if (supplied.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) return null;
  const unique = new Set(supplied as number[]);
  if (unique.size !== 1) return null;
  return supplied[0] as number;
}

function rawUsage(value: unknown): UsageProvenance {
  if (!isDataRecord(value)) {
    return Object.freeze({ kind: "unknown", reason: DEFAULT_UNKNOWN_USAGE_REASON });
  }
  const totalInput = readCounter(value, ["inputTokens", "input_tokens"]);
  const outputTokens = readCounter(value, ["outputTokens", "output_tokens"]);
  const cacheRead = readCounter(value, ["cachedReadTokens", "cacheReadTokens", "cache_read_tokens", "cachedInputTokens"]);
  const cacheCreation = readCounter(value, ["cachedWriteTokens", "cacheCreationTokens", "cache_creation_input_tokens"]);
  const thinking = readCounter(value, ["thoughtTokens", "thinking_tokens", "reasoning_tokens"]);
  if (
    totalInput === null || outputTokens === null || cacheRead === null ||
    cacheCreation === null || thinking === null ||
    totalInput === undefined || outputTokens === undefined ||
    (thinking !== undefined && thinking > outputTokens) ||
    (cacheRead ?? 0) + (cacheCreation ?? 0) > totalInput
  ) {
    return Object.freeze({ kind: "unknown", reason: DEFAULT_UNKNOWN_USAGE_REASON });
  }
  const readTokens = cacheRead ?? 0;
  const creationTokens = cacheCreation ?? 0;
  return Object.freeze({
    kind: "reported",
    source: "ACP prompt response usage",
    inputTokens: totalInput - readTokens - creationTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: readTokens }),
    ...(cacheCreation === undefined ? {} : { cacheCreationInputTokens: creationTokens }),
    ...(thinking === undefined ? {} : { thinkingTokens: thinking }),
  });
}

/** Normalize only complete ACP per-operation totals; partial values stay unknown. */
export function normalizeAcpUsage(value: unknown): UsageProvenance {
  return rawUsage(value);
}

/** Internal response-scoped diagnostic link for optional protocol adapters. */
export function messageUsageProvenance(response: object): UsageProvenance | undefined {
  return RESPONSE_USAGE_PROVENANCE.get(response);
}

/**
 * Return the immutable admission receipt associated with this exact native
 * Messages response object. The native payload is not mutated; copied,
 * foreign, or otherwise unrecognized objects return `undefined`.
 */
export function messageMaxTokensEnforcement(
  response: object,
): MaxTokensEnforcementDiagnostic | undefined {
  if ((typeof response !== "object" && typeof response !== "function") || response === null) return undefined;
  return RESPONSE_MAX_TOKENS_ENFORCEMENT.get(response);
}

/** Internal admission receipt for the exact native Messages stream handle. */
export function messageStreamMaxTokensEnforcement(
  stream: object,
): Promise<MaxTokensEnforcementDiagnostic | undefined> | undefined {
  return RESPONSE_STREAM_MAX_TOKENS_ENFORCEMENT.get(stream);
}

function normalizeOccupancy(value: unknown): ContextOccupancyDiagnostic | undefined {
  if (value === undefined) return undefined;
  if (
    !isDataRecord(value) || !exactKeys(value, ["tokens", "source"]) ||
    !Number.isSafeInteger(value.tokens) || (value.tokens as number) < 0 ||
    typeof value.source !== "string" || value.source.length === 0
  ) throw protocolFailure("The session worker returned invalid context-occupancy diagnostics.");
  return Object.freeze({ tokens: value.tokens as number, source: value.source });
}

function stopReason(value: unknown): MessageStopReason {
  if (typeof value !== "string") throw protocolFailure("The session worker omitted the ACP stop reason.");
  if (STOP_REASONS.has(value)) return value as MessageStopReason;
  if (value === "cancelled") throw new RequestAbortedError("The ACP prompt was cancelled.");
  if (value === "tool_use") return "tool_use";
  if (value === "pause_turn" || value === "stop_sequence" || value === "max_turn_requests") {
    throw new UnsupportedFeatureError(`ACP stop reason '${value}' has no supported S5 Messages mapping.`);
  }
  throw protocolFailure("The session worker returned an unknown ACP stop reason.");
}

/**
 * Validate worker output before the ledger commit point. Tool-use IDs are
 * supplied by the account/session ledger after it has matched calls to parked
 * MCP waiters; caller-provided history is never used for that authority.
 */
export function normalizeMessagesAcknowledgement(
  acknowledgement: SessionDriverAcknowledgement,
  toolUseIds?: readonly string[],
): NormalizedMessagesAcknowledgement {
  if (acknowledgement.output.length !== 1 || acknowledgement.output[0]?.role !== "assistant") {
    throw protocolFailure("Messages requires exactly one assistant response from the session worker.");
  }
  const outputMessage = acknowledgement.output[0];
  if (!isDataRecord(outputMessage) || !exactKeys(outputMessage, ["role", "content"])) {
    throw protocolFailure("The session worker returned a malformed assistant message.");
  }
  let text = "";
  let hasText = false;
  const toolUses: Array<{ readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }> = [];
  let sawToolUse = false;
  if (typeof outputMessage.content === "string") {
    text = outputMessage.content;
    hasText = true;
  } else if (Array.isArray(outputMessage.content)) {
    for (const block of outputMessage.content) {
      if (!isDataRecord(block) || typeof block.type !== "string") {
        throw protocolFailure("The worker returned a malformed assistant content block.");
      }
      if (block.type === "text" && exactKeys(block, ["type", "text"]) && typeof block.text === "string") {
        if (sawToolUse) throw protocolFailure("Assistant text after a tool_use block is not supported by this stream subset.");
        text += block.text;
        hasText = true;
        continue;
      }
      if (block.type === "tool_use" && exactKeys(block, ["type", "id", "name", "input"]) &&
          typeof block.id === "string" && typeof block.name === "string" && isDataRecord(block.input)) {
        sawToolUse = true;
        const id = toolUseIds === undefined ? block.id : toolUseIds[toolUses.length];
        if (typeof id !== "string" || id.length === 0) {
          throw protocolFailure("A worker tool_use block has no matched SDK-owned MCP call.");
        }
        toolUses.push(Object.freeze({ type: "tool_use", id, name: block.name, input: deepFreeze(cloneJson(block.input)) }));
        continue;
      }
      throw protocolFailure("Worker output may contain only plain text and matched caller tool_use blocks.");
    }
  } else {
    throw protocolFailure("The session worker returned invalid assistant output.");
  }
  if (!hasText && toolUses.length === 0) throw protocolFailure("The ACP turn completed without assistant output.");
  if (toolUseIds !== undefined && toolUses.length !== toolUseIds.length) {
    throw protocolFailure("Matched MCP calls and worker tool_use blocks differ.");
  }

  const result = acknowledgement.result;
  if (!isDataRecord(result) || !Object.prototype.hasOwnProperty.call(result, "stopReason")) {
    throw protocolFailure("The session worker omitted the terminal ACP result.");
  }
  if (Reflect.ownKeys(result).some((key) => typeof key !== "string" || !["stopReason", "usage", "contextOccupancy"].includes(key))) {
    throw protocolFailure("The session worker returned unsupported terminal result fields.");
  }
  const reason = stopReason(result.stopReason);
  if (
    (toolUses.length > 0 && (acknowledgement.stage !== "awaiting_tools" || reason !== "tool_use")) ||
    (toolUses.length === 0 && (acknowledgement.stage !== "completed" || reason === "tool_use"))
  ) throw protocolFailure("The worker tool-use stop reason and acknowledgement stage disagree.");
  const usage = rawUsage(result.usage);
  const occupancy = normalizeOccupancy(result.contextOccupancy);
  const events: MessageSemanticEvent[] = [];
  if (hasText) events.push(Object.freeze({ type: "text", text }));
  for (const toolUse of toolUses) events.push(Object.freeze({ ...toolUse }));
  events.push(Object.freeze({
    type: "usage",
    usage,
    ...(occupancy === undefined ? {} : { contextOccupancy: occupancy }),
  }));
  events.push(Object.freeze({ type: "stop", stopReason: reason }));
  const output = deepFreeze([{
    role: "assistant" as const,
    content: [
      ...(hasText ? [{ type: "text" as const, text }] : []),
      ...toolUses,
    ],
  }]) as unknown as SessionTranscript;
  return Object.freeze({
    output,
    events: Object.freeze(events),
    usage,
    ...(occupancy === undefined ? {} : { contextOccupancy: occupancy }),
  });
}

function anthropicUsage(usage: UsageProvenance): Message["usage"] {
  const measured = usage.kind === "reported";
  return {
    cache_creation: null,
    cache_creation_input_tokens: measured ? usage.cacheCreationInputTokens ?? null : null,
    cache_read_input_tokens: measured ? usage.cacheReadInputTokens ?? null : null,
    inference_geo: null,
    input_tokens: measured ? usage.inputTokens : 0,
    output_tokens: measured ? usage.outputTokens : 0,
    output_tokens_details: measured && usage.thinkingTokens !== undefined
      ? { thinking_tokens: usage.thinkingTokens }
      : null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

function checkedUsageProvenance(value: unknown): UsageProvenance {
  if (!isDataRecord(value)) throw protocolFailure("A semantic usage event has invalid provenance.");
  if (value.kind === "reported") {
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![
        "kind", "source", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "thinkingTokens",
      ].includes(key)) ||
      typeof value.source !== "string" || value.source.length === 0 ||
      !Number.isSafeInteger(value.inputTokens) || (value.inputTokens as number) < 0 ||
      !Number.isSafeInteger(value.outputTokens) || (value.outputTokens as number) < 0 ||
      (Object.prototype.hasOwnProperty.call(value, "cacheReadInputTokens") &&
        (!Number.isSafeInteger(value.cacheReadInputTokens) || (value.cacheReadInputTokens as number) < 0)) ||
      (Object.prototype.hasOwnProperty.call(value, "cacheCreationInputTokens") &&
        (!Number.isSafeInteger(value.cacheCreationInputTokens) || (value.cacheCreationInputTokens as number) < 0)) ||
      !Number.isSafeInteger(
        (value.inputTokens as number) +
          (value.cacheReadInputTokens as number | undefined ?? 0) +
          (value.cacheCreationInputTokens as number | undefined ?? 0),
      ) ||
      (Object.prototype.hasOwnProperty.call(value, "thinkingTokens") &&
        (!Number.isSafeInteger(value.thinkingTokens) || (value.thinkingTokens as number) < 0 || (value.thinkingTokens as number) > (value.outputTokens as number)))
    ) throw protocolFailure("A semantic usage event has invalid reported counts.");
    return Object.freeze({
      kind: "reported",
      source: value.source,
      inputTokens: value.inputTokens as number,
      outputTokens: value.outputTokens as number,
      ...(value.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: value.cacheReadInputTokens as number }),
      ...(value.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: value.cacheCreationInputTokens as number }),
      ...(value.thinkingTokens === undefined ? {} : { thinkingTokens: value.thinkingTokens as number }),
    });
  }
  if (value.kind === "unknown") {
    if (
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["kind", "reason"].includes(key)) ||
      (Object.prototype.hasOwnProperty.call(value, "reason") && typeof value.reason !== "string")
    ) throw protocolFailure("Unknown usage provenance must not contain token counts.");
    return Object.freeze({
      kind: "unknown",
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    });
  }
  throw protocolFailure("A semantic usage event has an unknown provenance kind.");
}

function checkedContextOccupancy(value: unknown): ContextOccupancyDiagnostic {
  if (
    !isDataRecord(value) || !exactKeys(value, ["tokens", "source"]) ||
    !Number.isSafeInteger(value.tokens) || (value.tokens as number) < 0 ||
    typeof value.source !== "string" || value.source.length === 0
  ) throw protocolFailure("A semantic usage event has invalid context occupancy.");
  return Object.freeze({ tokens: value.tokens as number, source: value.source });
}

function checkedMaxTokensEnforcement(value: unknown): MaxTokensEnforcementDiagnostic {
  if (!isDataRecord(value) || !exactKeys(value, [
      "accountId", "sessionId", "operationId", "kind", "policy", "outcome", "reason",
      ...(Object.hasOwn(value, "requestedMaxTokens") ? ["requestedMaxTokens"] : []),
  ]) || typeof value.accountId !== "string" || value.accountId.length === 0 ||
      typeof value.sessionId !== "string" || value.sessionId.length === 0 ||
      typeof value.operationId !== "string" || value.operationId.length === 0 ||
      (value.kind !== "prompt" && value.kind !== "tool_continuation") ||
      (Object.hasOwn(value, "requestedMaxTokens") &&
        (!Number.isSafeInteger(value.requestedMaxTokens) || (value.requestedMaxTokens as number) < 1)) ||
      (value.policy !== "strict" && value.policy !== "allow-unenforced-max-tokens") ||
      (value.outcome === "enforced"
        ? value.reason !== "driver-admitted-requested-bound" || !Object.hasOwn(value, "requestedMaxTokens")
        : value.outcome === "ignored"
          ? value.reason !== "backend-does-not-enforce-requested-bound" || !Object.hasOwn(value, "requestedMaxTokens")
          : value.outcome !== "unbounded" || value.reason !== "no-output-token-bound-requested" ||
            Object.hasOwn(value, "requestedMaxTokens"))) {
    throw protocolFailure("A Messages response has invalid max_tokens admission diagnostics.");
  }
  const base: Omit<MaxTokensEnforcementDiagnostic, "outcome" | "reason"> = {
    accountId: value.accountId as string,
    sessionId: value.sessionId as string,
    operationId: value.operationId as string,
    kind: value.kind as "prompt" | "tool_continuation",
    policy: value.policy as "strict" | "allow-unenforced-max-tokens",
  };
  return value.outcome === "enforced"
    ? Object.freeze({ ...base, requestedMaxTokens: value.requestedMaxTokens as number, outcome: "enforced" as const, reason: "driver-admitted-requested-bound" as const })
    : value.outcome === "ignored"
      ? Object.freeze({ ...base, requestedMaxTokens: value.requestedMaxTokens as number, outcome: "ignored" as const, reason: "backend-does-not-enforce-requested-bound" as const })
      : Object.freeze({
          accountId: value.accountId as string,
          sessionId: value.sessionId as string,
          operationId: value.operationId as string,
          kind: value.kind as "prompt" | "tool_continuation",
          policy: value.policy as "strict" | "allow-unenforced-max-tokens",
          outcome: "unbounded" as const,
          reason: "no-output-token-bound-requested" as const,
        });
}

/** Accumulate shared semantic events into one native Anthropic Message. */
export class MessageAccumulator {
  private text = "";
  private hasText = false;
  private readonly toolUses: Array<{ readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }> = [];
  private usage: UsageProvenance = Object.freeze({ kind: "unknown", reason: DEFAULT_UNKNOWN_USAGE_REASON });
  private terminalReason: MessageStopReason | undefined;
  private occupancy: ContextOccupancyDiagnostic | undefined;
  private maxTokensEnforcement: MaxTokensEnforcementDiagnostic | undefined;
  private finished = false;

  constructor(private readonly model: string, private readonly id = `msg_${randomUUID()}`) {
    if (typeof model !== "string" || model.length === 0 || model.includes("\0")) {
      throw invalidRequest("A non-empty pinned model is required to accumulate a Messages response.");
    }
  }

  /** Initial Anthropic message metadata for the native raw-event sequence. */
  messageStartEvent(): RawMessageStreamEvent {
    const unknownUsage = anthropicUsage(Object.freeze({
      kind: "unknown",
      reason: DEFAULT_UNKNOWN_USAGE_REASON,
    }));
    return {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        diagnostics: null,
        usage: unknownUsage,
      } as Message,
    };
  }

  /** Cumulative usage fields used by the terminal raw message_delta event. */
  messageDeltaUsage(): import("@anthropic-ai/sdk/resources/messages").MessageDeltaUsage {
    const usage = anthropicUsage(this.usage);
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      output_tokens_details: usage.output_tokens_details,
      server_tool_use: usage.server_tool_use,
    };
  }

  add(event: MessageSemanticEvent): void {
    if (this.finished || this.terminalReason !== undefined) {
      throw protocolFailure("Semantic content arrived after the terminal stop event.");
    }
    if (!isDataRecord(event) || typeof event.type !== "string") throw protocolFailure("A semantic event is malformed.");
    if (event.type === "admission") {
      if (!exactKeys(event, ["type", "maxTokensEnforcement"])) {
        throw protocolFailure("A semantic admission event is malformed.");
      }
      this.maxTokensEnforcement = checkedMaxTokensEnforcement(event.maxTokensEnforcement);
      return;
    }
    if (event.type === "text") {
      if (!exactKeys(event, ["type", "text"]) || typeof event.text !== "string") {
        throw protocolFailure("A semantic text event must contain only string text.");
      }
      if (this.toolUses.length > 0) throw protocolFailure("Assistant text cannot follow a tool_use block.");
      this.text += event.text;
      this.hasText = true;
      return;
    }
    if (event.type === "tool_use") {
      if (
        !exactKeys(event, ["type", "id", "name", "input"]) ||
        typeof event.id !== "string" || event.id.length === 0 ||
        typeof event.name !== "string" || event.name.length === 0 ||
        !isDataRecord(event.input)
      ) throw protocolFailure("A semantic tool_use event is malformed.");
      this.toolUses.push(Object.freeze({
        type: "tool_use",
        id: event.id,
        name: event.name,
        input: deepFreeze(cloneJson(event.input)),
      }));
      return;
    }
    if (event.type === "usage") {
      if (Reflect.ownKeys(event).some((key) => typeof key !== "string" || ![
        "type", "usage", "contextOccupancy", "maxTokensEnforcement",
      ].includes(key))) {
        throw protocolFailure("A semantic usage event contains unsupported fields.");
      }
      this.usage = checkedUsageProvenance(event.usage);
      this.occupancy = Object.prototype.hasOwnProperty.call(event, "contextOccupancy")
        ? checkedContextOccupancy(event.contextOccupancy)
        : undefined;
      this.maxTokensEnforcement = Object.prototype.hasOwnProperty.call(event, "maxTokensEnforcement")
        ? checkedMaxTokensEnforcement(event.maxTokensEnforcement)
        : undefined;
      return;
    }
    if (event.type !== "stop" || !exactKeys(event, ["type", "stopReason"])) {
      throw protocolFailure("The semantic event type is not supported.");
    }
    if (!STOP_REASONS.has(event.stopReason)) throw protocolFailure("The semantic stop reason is not supported.");
    if ((event.stopReason === "tool_use") !== (this.toolUses.length > 0)) {
      throw protocolFailure("The semantic stop reason does not match the assistant content.");
    }
    this.terminalReason = event.stopReason;
  }

  finish(): Message {
    if (this.finished) throw protocolFailure("The semantic response was already finalized.");
    if (this.terminalReason === undefined) throw protocolFailure("The ACP prompt ended without a terminal stop reason.");
    this.finished = true;
    const response = {
      id: this.id,
      type: "message" as const,
      role: "assistant" as const,
      content: [
        ...(this.hasText ? [{ type: "text" as const, text: this.text }] : []),
        ...this.toolUses,
      ],
      model: this.model,
      stop_reason: this.terminalReason,
      stop_sequence: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      usage: anthropicUsage(this.usage),
    };
    return response as Message;
  }

  /** Internal diagnostics for the matching completed response. */
  diagnostics(): {
    readonly usage: UsageProvenance;
    readonly contextOccupancy?: ContextOccupancyDiagnostic;
    readonly maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
  } {
    return Object.freeze({
      usage: this.usage,
      ...(this.occupancy === undefined ? {} : { contextOccupancy: this.occupancy }),
      ...(this.maxTokensEnforcement === undefined ? {} : { maxTokensEnforcement: this.maxTokensEnforcement }),
    });
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function readSuffix(transcript: SessionTranscript, committed: SessionTranscript): SessionTranscript {
  if (transcript.length < committed.length) throw invalidRequest("The full Messages transcript omitted committed history.");
  for (let index = 0; index < committed.length; index += 1) {
    if (stableJson(transcript[index]) !== stableJson(committed[index])) {
      throw invalidRequest("The full Messages transcript diverges from committed session history.");
    }
  }
  const suffix = transcript.slice(committed.length);
  if (suffix.length === 0) throw invalidRequest("The full Messages transcript must contain a new turn.");
  return deepFreeze(suffix) as SessionTranscript;
}

function outputFromReceipt(receipt: SessionLedgerReceipt): SessionDriverAcknowledgement {
  const assistant = receipt.committedMessages.at(-1);
  if (!assistant || assistant.role !== "assistant") throw protocolFailure();
  return {
    stage: receipt.stage,
    output: [assistant],
    ...(receipt.result === undefined ? {} : { result: receipt.result }),
  };
}

function validateMessagesCapability(ledger: SessionLedger, configuration: SessionConfiguration): void {
  // Validate pinned settings before any worker dispatch.
  systemText(configuration);
}

function streamMessages(
  semanticEvents: AsyncIterable<MessageSemanticEvent>,
  model: string,
): AsyncIterable<RawMessageStreamEvent> {
  let resolveAdmission!: (value: MaxTokensEnforcementDiagnostic | undefined) => void;
  let admissionSettled = false;
  const admissionPromise = new Promise<MaxTokensEnforcementDiagnostic | undefined>((resolve) => {
    resolveAdmission = resolve;
  });
  void admissionPromise.catch(() => undefined);
  const stream: AsyncIterable<RawMessageStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterableIterator<RawMessageStreamEvent> {
      const iterator = semanticEvents[Symbol.asyncIterator]();
      let complete = false;
      let semanticClose: Promise<unknown> | undefined;
      const closeSemantic = (): Promise<unknown> => {
        if (complete || typeof iterator.return !== "function") return Promise.resolve();
        semanticClose ??= Promise.resolve(iterator.return());
        return semanticClose;
      };
      const generator = (async function* (): AsyncGenerator<RawMessageStreamEvent> {
        const accumulator = new MessageAccumulator(model);
        let responseMetadata: Message | undefined;
        const startEvent = (): RawMessageStreamEvent => {
          const event = accumulator.messageStartEvent();
          if (event.type === "message_start") {
            responseMetadata = event.message;
            const enforcement = accumulator.diagnostics().maxTokensEnforcement;
            if (enforcement === undefined) {
              throw protocolFailure("The Messages stream has no matching per-operation admission diagnostic.");
            }
            RESPONSE_MAX_TOKENS_ENFORCEMENT.set(responseMetadata, enforcement);
          }
          return event;
        };
        let started = false;
        let textBlockStarted = false;
        let textBlockStopped = false;
        let textBlockIndex = -1;
        let nextBlockIndex = 0;
        let terminalSeen = false;
        try {
          while (true) {
            const result = await iterator.next();
            if (result.done) {
              if (!terminalSeen) throw protocolFailure("The semantic Messages stream ended without a terminal stop event.");
              throw protocolFailure("The semantic Messages stream ended before terminal completion was acknowledged.");
            }
            const event = result.value;
            if (event.type === "admission") {
              accumulator.add(event);
              const diagnostic = accumulator.diagnostics().maxTokensEnforcement;
              if (!diagnostic) throw protocolFailure("The Messages stream admission omitted its enforcement diagnostic.");
              admissionSettled = true;
              resolveAdmission(diagnostic);
              continue;
            }
            if (event.type === "text") {
              if (terminalSeen) throw protocolFailure("Text arrived after the semantic terminal stop event.");
              accumulator.add(event);
              if (!started) {
                started = true;
                yield startEvent();
              }
              if (!textBlockStarted) {
                textBlockStarted = true;
                textBlockIndex = nextBlockIndex++;
                yield {
                  type: "content_block_start",
                  index: textBlockIndex,
                  content_block: { type: "text", text: "" },
                } as RawMessageStreamEvent;
              }
              if (event.text.length > 0) {
                yield {
                  type: "content_block_delta",
                  index: textBlockIndex,
                  delta: { type: "text_delta", text: event.text },
                };
              }
              continue;
            }
            if (event.type === "tool_use") {
              if (terminalSeen) throw protocolFailure("A tool_use event arrived after terminal.");
              accumulator.add(event);
              if (!started) {
                started = true;
                yield startEvent();
              }
              if (textBlockStarted && !textBlockStopped) {
                yield { type: "content_block_stop", index: textBlockIndex };
                textBlockStopped = true;
              }
              const index = nextBlockIndex++;
              yield {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
              } as RawMessageStreamEvent;
              const partialJson = JSON.stringify(event.input);
              if (partialJson === undefined) throw protocolFailure("A tool_use input could not be serialized.");
              yield {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: partialJson },
              } as RawMessageStreamEvent;
              yield { type: "content_block_stop", index };
              continue;
            }
            if (event.type === "usage") {
              if (terminalSeen) throw protocolFailure("Usage arrived after the semantic terminal stop event.");
              accumulator.add(event);
              continue;
            }
            if (event.type !== "stop" || terminalSeen) {
              throw protocolFailure("The semantic Messages stream has an invalid terminal sequence.");
            }
            terminalSeen = true;
            accumulator.add(event);
            if (!started || (!textBlockStarted && nextBlockIndex === 0)) {
              throw protocolFailure("A successful Messages stream must contain assistant content.");
            }
            accumulator.finish();
            if (!responseMetadata) throw protocolFailure("The completed stream has no response-scoped diagnostic handle.");
            const diagnostics = accumulator.diagnostics();
            RESPONSE_USAGE_PROVENANCE.set(responseMetadata, diagnostics.usage);
            if (diagnostics.maxTokensEnforcement) {
              RESPONSE_MAX_TOKENS_ENFORCEMENT.set(responseMetadata, diagnostics.maxTokensEnforcement);
            }
            if (textBlockStarted && !textBlockStopped) {
              yield { type: "content_block_stop", index: textBlockIndex };
              textBlockStopped = true;
            }
            yield {
              type: "message_delta",
              delta: {
                stop_reason: event.stopReason,
                stop_sequence: null,
                stop_details: null,
                container: null,
              },
              usage: accumulator.messageDeltaUsage(),
            };

            // Resuming the semantic iterator after its stop event reaches the
            // ledger's commit point. Do this only when the caller asks for the
            // final raw event; break/return before then leaves no committed turn.
            const finished = await iterator.next();
            if (!finished.done) {
              throw protocolFailure("The semantic Messages stream emitted data after its terminal stop event.");
            }
            complete = true;
            yield { type: "message_stop" };
            return;
          }
        } finally {
          if (!admissionSettled) {
            admissionSettled = true;
            resolveAdmission(undefined);
          }
          if (!complete) await closeSemantic();
        }
      })();

      const finishIteratorAction = async (
        action: () => Promise<IteratorResult<RawMessageStreamEvent>>,
      ): Promise<IteratorResult<RawMessageStreamEvent>> => {
        let cleanupError: unknown;
        let cleanupFailed = false;
        try {
          await closeSemantic();
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
        try {
          const result = await action();
          if (cleanupFailed) throw cleanupError;
          return result;
        } catch (error) {
          throw cleanupFailed ? cleanupError : error;
        }
      };

      const rawIterator: AsyncIterableIterator<RawMessageStreamEvent> = {
        [Symbol.asyncIterator]() { return this; },
        next(value?: unknown) { return generator.next(value); },
        return(value?: unknown) {
          return finishIteratorAction(() => generator.return(value as never));
        },
        throw(error?: unknown) {
          return finishIteratorAction(() => generator.throw(error));
        },
      };
      return rawIterator;
    },
  };
  RESPONSE_STREAM_MAX_TOKENS_ENFORCEMENT.set(stream as object, admissionPromise);
  return stream;
}

/** Create the S6 facade attached to an account-bound S4 ledger. */
export function createSessionMessages(ledger: SessionLedger): SessionMessages {
  async function createNonStreaming(
    request: NormalizedRequest,
    options: MessageCreateOptions,
  ): Promise<Message> {
    const configuration = ledger.configuration;
    validateMessagesCapability(ledger, configuration);
    const before = ledger.snapshot();
    readSuffix(request.messages, before.transcript);
    const receipt = await ledger.executeMessage(
      { transcript: request.messages },
      { ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    const normalized = normalizeMessagesAcknowledgement(outputFromReceipt(receipt));
    const accumulator = new MessageAccumulator(configuration.model);
    for (const event of normalized.events) accumulator.add(event);
    const message = accumulator.finish();
    RESPONSE_USAGE_PROVENANCE.set(message, accumulator.diagnostics().usage);
    if (receipt.maxTokensEnforcement) {
      RESPONSE_MAX_TOKENS_ENFORCEMENT.set(message, checkedMaxTokensEnforcement(receipt.maxTokensEnforcement));
    }
    return message;
  }

  async function createStreaming(
    request: NormalizedRequest,
    options: MessageCreateOptions,
  ): Promise<AsyncIterable<RawMessageStreamEvent>> {
    const configuration = ledger.configuration;
    validateMessagesCapability(ledger, configuration);
    if (ledger.capabilities.streaming !== "incremental") {
      throw new UnsupportedFeatureError("The session driver has not declared incremental Messages streaming.");
    }
    if (options.signal?.aborted) throw new RequestAbortedError("The session operation was aborted.");
    const before = ledger.snapshot();
    readSuffix(request.messages, before.transcript);
    const semantic = ledger.streamMessage(
      { transcript: request.messages },
      { ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    return streamMessages(semantic, configuration.model);
  }

  const create = async (
    request: MessageCreateParamsNonStreaming | MessageCreateParamsStreaming,
    options?: MessageCreateOptions,
  ): Promise<Message | AsyncIterable<import("./contracts.js").RawMessageStreamEvent>> => {
    const normalized = normalizeRequest(request);
    const validatedOptions = validateSessionOptions(options);
    return normalized.stream
      ? createStreaming(normalized, validatedOptions)
      : createNonStreaming(normalized, validatedOptions);
  };
  return Object.freeze({ create: create as SessionMessages["create"] });
}
