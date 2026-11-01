import { ChatCompletionToMessagesConverter } from "@zenmux/rosetta-ai";
import { messageMaxTokensEnforcement, messageUsageProvenance } from "./messages.js";
import {
  InvalidRequestError,
  ProtocolFailureError,
  RequestAbortedError,
  SDKError,
  UnsupportedFeatureError,
} from "./errors.js";
import { isAccountBoundSession } from "./session.js";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MaxTokensEnforcementDiagnostic,
  RawMessageStreamEvent,
  Session,
  UsageProvenance,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;
type RosettaRequest = Parameters<ChatCompletionToMessagesConverter["convertRequest"]>[0];
type ChatCompletion = ReturnType<ChatCompletionToMessagesConverter["convertResponse"]>;
type ChatCompletionChunk = NonNullable<ReturnType<ChatCompletionToMessagesConverter["convertStreamEvent"]>>;
type CompletionUsage = NonNullable<ChatCompletion["usage"]>;
type SourceRequest = ChatCompletionRequestNonStreaming | ChatCompletionRequestStreaming;
type ConvertedRequest = ReturnType<ChatCompletionToMessagesConverter["convertRequest"]>;
type OpenAIUsage = CompletionUsage | null;

type RosettaNonStreamingRequest = Extract<RosettaRequest, { stream?: false | null }>;
export type ChatCompletionRequestNonStreaming = Omit<RosettaNonStreamingRequest, "stream"> & { stream?: false };
export type ChatCompletionRequestStreaming = Extract<RosettaRequest, { stream: true }>;

const SOURCE_FIELDS = new Set([
  "model", "messages", "max_tokens", "max_completion_tokens", "n", "stream", "stream_options", "tools",
]);
const TOOL_NAME_MAX_BYTES = 128;
const TOOL_ID_MAX_BYTES = 256;

export type ChatCompletionResponse = Omit<ChatCompletion, "usage"> & {
  /** `null` usage means the session driver did not report per-operation counts. */
  readonly usage: OpenAIUsage;
  /** Separate provenance keeps unknown usage distinguishable from measured zero. */
  readonly usage_provenance: UsageProvenance;
  /** Immutable per-operation disclosure of the requested output-token bound. */
  readonly max_tokens_enforcement: MaxTokensEnforcementDiagnostic;
};

export type ChatCompletionStreamChunk = ChatCompletionChunk & {
  /** Present on the optional terminal usage chunk when include_usage is requested. */
  readonly usage_provenance?: UsageProvenance;
  /** Immutable operation disclosure, attached from the initial chunk onward. */
  readonly max_tokens_enforcement: MaxTokensEnforcementDiagnostic;
};

export interface ChatCompletionRequestOptions {
  readonly signal?: AbortSignal;
}

export interface ChatCompletions {
  create(
    request: ChatCompletionRequestNonStreaming,
    options?: ChatCompletionRequestOptions,
  ): Promise<ChatCompletionResponse>;
  create(
    request: ChatCompletionRequestStreaming,
    options?: ChatCompletionRequestOptions,
  ): Promise<AsyncIterable<ChatCompletionStreamChunk>>;
}

export interface ChatAdapter {
  readonly completions: ChatCompletions;
}

function invalid(message = "The Chat Completions request is invalid."): InvalidRequestError {
  return new InvalidRequestError(message);
}

function unsupported(message: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(message);
}

function protocol(message: string): ProtocolFailureError {
  return new ProtocolFailureError(message);
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const actualStrings = actual as string[];
  return actualStrings.length === expected.length && expected.every((key) => actualStrings.includes(key));
}

function onlyKeys(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function copyJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value !== "object" || ancestors.has(value)) throw invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
          throw invalid();
        }
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
        result.push(copyJsonValue(descriptor.value, ancestors));
      }
      return result;
    }
    if (!isRecord(value)) throw invalid();
    const result: JsonRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      Object.defineProperty(result, key, {
        value: copyJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function copyJson<T>(value: T): T {
  return copyJsonValue(value, new Set()) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function textParts(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw unsupported(`${field} must be a string or text-only array.`);
  const chunks: string[] = [];
  for (const part of value) {
    if (!isRecord(part) || !exactKeys(part, ["type", "text"]) || part.type !== "text" || typeof part.text !== "string") {
      throw unsupported(`${field} contains content that is not representable by the Messages subset.`);
    }
    chunks.push(part.text);
  }
  return chunks.join("");
}

function checkTextContent(content: unknown, field: string): void {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) throw unsupported(`${field} must be text-only.`);
  for (const part of content) {
    if (!isRecord(part) || !exactKeys(part, ["type", "text"]) || part.type !== "text" || typeof part.text !== "string") {
      throw unsupported(`${field} contains content that is not representable by the Messages subset.`);
    }
  }
}

function parseToolArguments(value: unknown): JsonRecord {
  if (typeof value !== "string") throw invalid("Function-call arguments must be a JSON object string.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalid("Function-call arguments are not valid JSON.");
  }
  if (!isRecord(parsed)) throw invalid("Function-call arguments must decode to a JSON object.");
  return parsed;
}

function validateToolName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > TOOL_NAME_MAX_BYTES) {
    throw invalid("A function tool name is empty or exceeds the supported byte bound.");
  }
}

function validateToolId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > TOOL_ID_MAX_BYTES) {
    throw invalid("A tool-call ID is empty or exceeds the supported byte bound.");
  }
}

function validateMessageHistory(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) throw invalid("messages must be a non-empty array.");
  const allCallIds = new Set<string>();
  let pendingToolIds: Set<string> | undefined;
  let systemPrefix = true;
  let hasConversationMessage = false;

  for (const candidate of messages) {
    if (!isRecord(candidate) || typeof candidate.role !== "string") throw invalid("Every message needs a supported role.");
    const role = candidate.role;
    if (role === "system" || role === "developer") {
      if (!systemPrefix || pendingToolIds?.size) {
        throw unsupported("System and developer messages must precede the conversational transcript.");
      }
      if (!exactKeys(candidate, ["role", "content"])) throw unsupported("System message metadata is not supported.");
      textParts(candidate.content, `${role} content`);
      continue;
    }

    systemPrefix = false;
    hasConversationMessage = true;
    if (role === "tool") {
      if (!exactKeys(candidate, ["role", "content", "tool_call_id"])) {
        throw unsupported("Tool messages support only role, content, and tool_call_id.");
      }
      if (!pendingToolIds) throw invalid("A tool result does not match an outstanding function call.");
      validateToolId(candidate.tool_call_id);
      if (!pendingToolIds.delete(candidate.tool_call_id)) throw invalid("A tool result ID is unknown or duplicated.");
      checkTextContent(candidate.content, "Tool result content");
      if (pendingToolIds.size === 0) pendingToolIds = undefined;
      continue;
    }

    if (pendingToolIds?.size) throw invalid("Every call in a function-tool batch needs a result before the next message.");
    if (role === "user") {
      if (!exactKeys(candidate, ["role", "content"])) throw unsupported("User message metadata is not supported.");
      checkTextContent(candidate.content, "User content");
      continue;
    }
    if (role !== "assistant") throw unsupported(`Chat role '${role}' is not supported.`);
    if (!onlyKeys(candidate, new Set(["role", "content", "tool_calls", "refusal"]))) {
      throw unsupported("Only assistant text and function-tool history are supported.");
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "refusal") && candidate.refusal !== null) {
      throw unsupported("Assistant refusal metadata is not supported in request history.");
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "content")) {
      if (candidate.content !== null) checkTextContent(candidate.content, "Assistant content");
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "tool_calls")) {
      if (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length === 0) {
        throw invalid("tool_calls must be a non-empty array when supplied.");
      }
      pendingToolIds = new Set();
      for (const call of candidate.tool_calls) {
        if (!isRecord(call) || !exactKeys(call, ["id", "type", "function"]) || call.type !== "function" || !isRecord(call.function)) {
          throw unsupported("Only Chat Completions function tool calls are supported.");
        }
        validateToolId(call.id);
        if (allCallIds.has(call.id)) throw invalid("Tool-call IDs must be unique throughout the supplied transcript.");
        allCallIds.add(call.id);
        if (pendingToolIds.has(call.id)) throw invalid("Tool-call IDs in one assistant message must be unique.");
        pendingToolIds.add(call.id);
        if (!exactKeys(call.function, ["name", "arguments"])) {
          throw unsupported("Function-call data must contain only name and arguments.");
        }
        validateToolName(call.function.name);
        parseToolArguments(call.function.arguments);
      }
    } else if (!Object.prototype.hasOwnProperty.call(candidate, "content") || candidate.content === null) {
      throw invalid("An assistant message needs text content or function tool calls.");
    }
  }
  if (!hasConversationMessage) throw invalid("At least one non-system message is required.");
  if (pendingToolIds?.size) throw invalid("The transcript ends with an incomplete function-tool batch.");
}

function validateSourceRequestInternal(input: unknown): SourceRequest {
  const request = copyJson(input);
  if (!isRecord(request)) throw invalid("The Chat Completions request must be a plain object.");
  if (!onlyKeys(request, SOURCE_FIELDS)) {
    const unknown = Reflect.ownKeys(request).find((key) => typeof key !== "string" || !SOURCE_FIELDS.has(key));
    throw unsupported(`Chat request field '${String(unknown)}' is outside the supported subset.`);
  }
  if (typeof request.model !== "string" || request.model.length === 0) throw invalid("model must be a non-empty string.");
  validateMessageHistory(request.messages);

  const hasMaxTokens = Object.prototype.hasOwnProperty.call(request, "max_tokens");
  const hasMaxCompletionTokens = Object.prototype.hasOwnProperty.call(request, "max_completion_tokens");
  if (hasMaxTokens && hasMaxCompletionTokens) throw unsupported("Specify only one of max_tokens or max_completion_tokens.");
  const maxTokens = hasMaxCompletionTokens ? request.max_completion_tokens : request.max_tokens;
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1)) {
    throw invalid("max_tokens/max_completion_tokens must be a positive safe integer.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "n") && request.n !== 1) {
    throw unsupported("Only n=1 is supported.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "stream") && typeof request.stream !== "boolean") {
    throw invalid("stream, when supplied, must be boolean.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "stream_options")) {
    if (request.stream !== true || !isRecord(request.stream_options) ||
        !onlyKeys(request.stream_options, new Set(["include_usage"])) ||
        (Object.prototype.hasOwnProperty.call(request.stream_options, "include_usage") &&
          typeof request.stream_options.include_usage !== "boolean")) {
      throw unsupported("stream_options supports only include_usage on streaming requests.");
    }
  }
  if (Object.prototype.hasOwnProperty.call(request, "tools")) {
    if (!Array.isArray(request.tools)) throw invalid("tools must be an array of function tools.");
    for (const tool of request.tools) {
      if (!isRecord(tool) || !exactKeys(tool, ["type", "function"]) || tool.type !== "function" || !isRecord(tool.function)) {
        throw unsupported("Only function tools are supported; custom and provider-hosted tools are rejected.");
      }
      if (!onlyKeys(tool.function, new Set(["name", "description", "parameters", "strict"]))) {
        throw unsupported("Function definitions may contain only name, description, parameters, and strict.");
      }
      validateToolName(tool.function.name);
      if (Object.prototype.hasOwnProperty.call(tool.function, "description") && typeof tool.function.description !== "string") {
        throw invalid("Function descriptions must be strings.");
      }
      if (Object.prototype.hasOwnProperty.call(tool.function, "strict") && tool.function.strict !== false) {
        throw unsupported("Strict function schemas are not supported by this adapter.");
      }
      if (!isRecord(tool.function.parameters) || tool.function.parameters.type !== "object") {
        throw unsupported("Function parameters must be an explicit object JSON Schema.");
      }
    }
  }
  return request as unknown as SourceRequest;
}

function validateSourceRequest(input: unknown): SourceRequest {
  try {
    return validateSourceRequestInternal(input);
  } catch (error) {
    if (error instanceof SDKError) throw error;
    throw invalid();
  }
}

/**
 * Rosetta 1.0.38 checks assistant `content` by truthiness. An explicit empty
 * string is a real transcript block here, while null/absence means no text.
 * Change only that explicit representation to the converter's text-part form.
 */
function preserveExplicitEmptyAssistantText(request: SourceRequest): SourceRequest {
  return {
    ...request,
    messages: request.messages.map((message) =>
      message.role === "assistant" && message.content === ""
        ? { ...message, content: [{ type: "text" as const, text: "" }] }
        : message,
    ),
  } as SourceRequest;
}

function systemText(value: unknown, where: string): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw unsupported(`${where} system prompt is not text-only.`);
  const chunks: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || !exactKeys(block, ["type", "text"]) || block.type !== "text" || typeof block.text !== "string") {
      throw unsupported(`${where} system prompt contains unsupported block metadata or content.`);
    }
    chunks.push(block.text);
  }
  return chunks.join("");
}

function normalizedTool(value: unknown, where: string): JsonRecord {
  if (!isRecord(value) || !onlyKeys(value, new Set(["type", "name", "description", "input_schema"]))) {
    throw unsupported(`${where} tool catalog contains a non-function tool or unsupported fields.`);
  }
  if (value.type !== undefined && value.type !== "custom" && value.type !== null) {
    throw unsupported(`${where} tool catalog contains a provider-hosted tool.`);
  }
  if (typeof value.name !== "string" || !isRecord(value.input_schema)) {
    throw invalid(`${where} tool catalog is malformed.`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw invalid(`${where} tool description is malformed.`);
  }
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    input_schema: value.input_schema,
  };
}

function toolCatalog(value: unknown, where: string): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${where} tool catalog is malformed.`);
  return value.map((tool) => normalizedTool(tool, where));
}

function validateConvertedRequest(
  request: SourceRequest,
  converted: ConvertedRequest,
  session: Session,
): {
  readonly includeUsage: boolean;
  readonly maxTokens: number;
  readonly native: MessageCreateParamsNonStreaming | MessageCreateParamsStreaming;
} {
  const output = converted as unknown as JsonRecord;
  if (!onlyKeys(output, new Set(["model", "max_tokens", "messages", "system", "tools", "stream"]))) {
    throw unsupported("The Rosetta conversion produced a Messages field outside the validated subset.");
  }
  const config = session.configuration;
  if (output.model !== config.model) throw unsupported("The converted model does not match the session's pinned model.");
  if (systemText(output.system, "Converted") !== systemText(config.system, "Pinned")) {
    throw unsupported("The converted system prompt must exactly match the session's pinned system prompt.");
  }
  const convertedTools = toolCatalog(output.tools, "Converted");
  const pinnedTools = toolCatalog(config.tools, "Pinned");
  if (!jsonEqual(convertedTools, pinnedTools)) {
    throw unsupported("The converted function catalog must exactly match the session's pinned function tools.");
  }
  const source = request as unknown as JsonRecord;
  const sourceTools = Array.isArray(source.tools) ? source.tools : [];
  for (let index = 0; index < convertedTools.length; index += 1) {
    const originalSchema = (sourceTools[index] as JsonRecord | undefined)?.function;
    const parameters = isRecord(originalSchema) ? originalSchema.parameters : undefined;
    if (!jsonEqual(parameters, convertedTools[index]!.input_schema)) {
      throw unsupported("Rosetta would weaken or otherwise alter a function JSON Schema; conversion was rejected.");
    }
  }
  const maxTokens = output.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) {
    throw protocol("Rosetta produced an invalid Messages max_tokens value.");
  }
  if (config.model !== request.model) throw unsupported("The requested model does not match the session's pinned model.");
  if (session.capabilities.maxTokens !== "enforced" && session.capabilities.maxTokens !== "not-enforced") {
    throw unsupported("The session driver has not established max-token response admission for the Chat token bound.");
  }
  if (request.stream === true && session.capabilities.streaming !== "incremental") {
    throw unsupported("The session driver has not declared incremental Messages streaming.");
  }
  validateConvertedMessages(output.messages);
  const streamOptions = (request as unknown as JsonRecord).stream_options;
  const includeUsage = request.stream === true && isRecord(streamOptions) && streamOptions.include_usage === true;
  const native = {
    max_tokens: maxTokens as number,
    messages: converted.messages,
    ...(converted.stream === undefined ? {} : { stream: converted.stream }),
  } as unknown as MessageCreateParamsNonStreaming | MessageCreateParamsStreaming;
  return { includeUsage, maxTokens: maxTokens as number, native };
}

function checkedMaxTokensEnforcement(
  response: object,
  session: Session,
  requestedMaxTokens: number,
): MaxTokensEnforcementDiagnostic {
  const value = messageMaxTokensEnforcement(response);
  if (!value || !isRecord(value) || !Object.isFrozen(value) ||
      !exactKeys(value, [
        "accountId", "sessionId", "operationId", "kind", "requestedMaxTokens", "policy", "outcome", "reason",
      ]) ||
      value.accountId !== session.accountId || value.sessionId !== session.sessionId ||
      typeof value.operationId !== "string" || value.operationId.length === 0 ||
      (value.kind !== "prompt" && value.kind !== "tool_continuation") ||
      value.requestedMaxTokens !== requestedMaxTokens ||
      (value.policy !== "strict" && value.policy !== "allow-unenforced-max-tokens")) {
    throw protocol("The Messages response has no valid matching max_tokens admission diagnostic.");
  }
  if (value.outcome === "enforced") {
    if (value.reason !== "driver-admitted-requested-bound" || session.capabilities.maxTokens !== "enforced") {
      throw protocol("The Messages response's enforced max_tokens admission does not match the session capability.");
    }
    return Object.freeze({
      accountId: value.accountId,
      sessionId: value.sessionId,
      operationId: value.operationId,
      kind: value.kind,
      requestedMaxTokens: value.requestedMaxTokens,
      policy: value.policy,
      outcome: "enforced",
      reason: "driver-admitted-requested-bound",
    });
  }
  if (value.outcome !== "not-enforced" || value.reason !== "backend-does-not-enforce-requested-bound" ||
      value.policy !== "allow-unenforced-max-tokens" || session.capabilities.maxTokens !== "not-enforced") {
    throw protocol("The Messages response's unenforced max_tokens admission does not match the explicit session policy.");
  }
  return Object.freeze({
    accountId: value.accountId,
    sessionId: value.sessionId,
    operationId: value.operationId,
    kind: value.kind,
    requestedMaxTokens: value.requestedMaxTokens,
    policy: value.policy,
    outcome: "not-enforced",
    reason: "backend-does-not-enforce-requested-bound",
  });
}

function validateConvertedMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw invalid("The converted transcript must contain at least one conversational message.");
  for (const message of value) {
    if (!isRecord(message) || !exactKeys(message, ["role", "content"]) ||
        (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content)) {
      throw unsupported("The converted transcript contains an unrepresentable message.");
    }
    for (const block of message.content) {
      if (!isRecord(block) || typeof block.type !== "string") throw invalid("The converted content block is malformed.");
      if (block.type === "text") {
        if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") {
          throw unsupported("The converted text block contains unsupported metadata.");
        }
      } else if (block.type === "tool_use") {
        if (message.role !== "assistant" || !exactKeys(block, ["type", "id", "name", "input"]) ||
            typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.input)) {
          throw unsupported("The converter produced an invalid function tool call.");
        }
      } else if (block.type === "tool_result") {
        if (message.role !== "user" || !onlyKeys(block, new Set(["type", "tool_use_id", "content", "is_error"])) ||
            typeof block.tool_use_id !== "string" || !Array.isArray(block.content) ||
            block.content.some((part) => !isRecord(part) || !exactKeys(part, ["type", "text"]) || part.type !== "text" || typeof part.text !== "string")) {
          throw unsupported("The converted tool result is not representable by the caller-tool ledger.");
        }
      } else {
        throw unsupported(`Rosetta produced unsupported Messages content '${block.type}'.`);
      }
    }
  }
}

function validateSessionOptionsInternal(value: ChatCompletionRequestOptions | undefined): ChatCompletionRequestOptions {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || !onlyKeys(value, new Set(["signal"]))) throw invalid("Only signal is supported in request options.");
  const signal = value.signal;
  if (signal !== undefined && (
    typeof signal !== "object" || signal === null || typeof (signal as AbortSignal).aborted !== "boolean" ||
    typeof (signal as AbortSignal).addEventListener !== "function" || typeof (signal as AbortSignal).removeEventListener !== "function"
  )) throw invalid("signal must be an AbortSignal.");
  return Object.freeze(signal === undefined ? {} : { signal: signal as AbortSignal });
}

function validateSessionOptions(value: ChatCompletionRequestOptions | undefined): ChatCompletionRequestOptions {
  try {
    return validateSessionOptionsInternal(value);
  } catch (error) {
    if (error instanceof SDKError) throw error;
    throw invalid("The Chat request options are invalid.");
  }
}

function assertMessageResponse(value: Message, session: Session): void {
  const response = value as unknown as JsonRecord;
  if (!isRecord(response) || response.type !== "message" || response.role !== "assistant" ||
      response.model !== session.configuration.model || !Array.isArray(response.content) || response.content.length === 0) {
    throw protocol("The session returned an invalid Anthropic Messages response.");
  }
  const toolNames = new Set(toolCatalog(session.configuration.tools, "Pinned").map((tool) => tool.name));
  for (const block of response.content) {
    if (!isRecord(block) || typeof block.type !== "string") throw protocol("The Messages response contains a malformed content block.");
    if (block.type === "text") {
      if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") {
        throw unsupported("The Messages response contains text metadata unsupported by Chat Completions.");
      }
    } else if (block.type === "tool_use") {
      if (!exactKeys(block, ["type", "id", "name", "input"]) || typeof block.id !== "string" ||
          typeof block.name !== "string" || !isRecord(block.input) || !toolNames.has(block.name)) {
        throw unsupported("The Messages response contains a non-catalog or malformed tool call.");
      }
    } else {
      throw unsupported(`Messages response block '${block.type}' has no supported Chat Completions mapping.`);
    }
  }
  if (!new Set(["end_turn", "stop_sequence", "tool_use", "max_tokens", "model_context_window_exceeded", "refusal"]).has(String(response.stop_reason))) {
    throw unsupported(`Messages stop reason '${String(response.stop_reason)}' has no supported Chat Completions mapping.`);
  }
  const hasToolUse = response.content.some((block) => isRecord(block) && block.type === "tool_use");
  if (hasToolUse !== (response.stop_reason === "tool_use")) {
    throw protocol("The Messages tool-use content and terminal stop reason disagree.");
  }
}

function preserveResponseTextPresence(message: Message, completion: ChatCompletion): ChatCompletion {
  const hasTextBlock = message.content.some((block) => block.type === "text");
  if (hasTextBlock) return completion;
  return {
    ...completion,
    choices: completion.choices.map((choice, index) => index === 0
      ? { ...choice, message: { ...choice.message, content: null } }
      : choice),
  };
}

function assertUsageMatchesMessage(usage: unknown, provenance: UsageProvenance): void {
  if (!isRecord(usage)) throw protocol("The Messages response omitted usage metadata.");
  const measured = provenance.kind === "reported";
  const expectedInput = measured ? provenance.inputTokens : 0;
  const expectedOutput = measured ? provenance.outputTokens : 0;
  const expectedRead = measured ? provenance.cacheReadInputTokens ?? null : null;
  const expectedCreation = measured ? provenance.cacheCreationInputTokens ?? null : null;
  if (
    usage.input_tokens !== expectedInput || usage.output_tokens !== expectedOutput ||
    (usage.cache_read_input_tokens ?? null) !== expectedRead ||
    (usage.cache_creation_input_tokens ?? null) !== expectedCreation
  ) throw protocol("Session usage diagnostics do not match the completed Messages operation.");
}

function openAIUsage(provenance: UsageProvenance): OpenAIUsage {
  if (provenance.kind === "unknown") return null;
  const cached = provenance.cacheReadInputTokens;
  const cacheWrite = provenance.cacheCreationInputTokens;
  const promptTokens = provenance.inputTokens + (cached ?? 0) + (cacheWrite ?? 0);
  const totalTokens = promptTokens + provenance.outputTokens;
  if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(totalTokens)) {
    throw protocol("The session reported token usage outside the supported integer range.");
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: provenance.outputTokens,
    total_tokens: totalTokens,
    ...((cached === undefined && cacheWrite === undefined) ? {} : {
      prompt_tokens_details: {
        ...(cached === undefined ? {} : { cached_tokens: cached }),
        ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
      },
    }),
    ...(provenance.thinkingTokens === undefined ? {} : {
      completion_tokens_details: { reasoning_tokens: provenance.thinkingTokens },
    }),
  };
}

function usageProvenance(responseMetadata: object): UsageProvenance {
  const provenance = messageUsageProvenance(responseMetadata);
  if (!provenance) throw protocol("The completed Messages response has no matching per-operation usage diagnostic.");
  return provenance;
}

function validateRawStreamEvent(value: unknown): asserts value is RawMessageStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") throw protocol("The Messages stream emitted a malformed event.");
  if (!["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"].includes(value.type)) {
    throw protocol(`The Messages stream emitted unsupported event '${value.type}'.`);
  }
}

function validateStreamMessageStart(event: JsonRecord, session: Session): void {
  if (!isRecord(event.message) || event.message.type !== "message" || event.message.role !== "assistant" ||
      event.message.model !== session.configuration.model || typeof event.message.id !== "string") {
    throw protocol("The Messages stream started with invalid response metadata.");
  }
}

function validateStreamBlockStart(event: JsonRecord, session: Session): void {
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0 || !isRecord(event.content_block)) {
    throw protocol("The Messages stream content block start is malformed.");
  }
  const block = event.content_block;
  if (block.type === "text") {
    if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") throw unsupported("Streamed text metadata is unsupported.");
    return;
  }
  if (block.type === "tool_use") {
    if (!exactKeys(block, ["type", "id", "name", "input"]) || typeof block.id !== "string" ||
        typeof block.name !== "string" || !isRecord(block.input)) throw protocol("The streamed function-call start is malformed.");
    if (block.id.length === 0 || Buffer.byteLength(block.id, "utf8") > TOOL_ID_MAX_BYTES ||
        block.name.length === 0 || Buffer.byteLength(block.name, "utf8") > TOOL_NAME_MAX_BYTES) {
      throw protocol("The streamed function-call ID or name exceeds its supported bounds.");
    }
    if (!toolCatalog(session.configuration.tools, "Pinned").some((tool) => tool.name === block.name)) {
      throw unsupported("The streamed function call is not in the session's pinned catalog.");
    }
    return;
  }
  throw unsupported(`Streamed Messages block '${String(block.type)}' is unsupported.`);
}

function validateStreamDelta(event: JsonRecord): void {
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0 || !isRecord(event.delta) || typeof event.delta.type !== "string") {
    throw protocol("The Messages stream content delta is malformed.");
  }
  if (event.delta.type === "text_delta" && typeof event.delta.text === "string") return;
  if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") return;
  throw unsupported(`Streamed Messages delta '${event.delta.type}' is unsupported.`);
}

function validateStreamTerminal(event: JsonRecord): void {
  if (!isRecord(event.delta) || !new Set(["end_turn", "stop_sequence", "tool_use", "max_tokens", "model_context_window_exceeded", "refusal"]).has(String(event.delta.stop_reason))) {
    throw protocol("The Messages stream omitted a supported terminal stop reason.");
  }
  if (!isRecord(event.usage)) throw protocol("The Messages stream terminal event omitted usage metadata.");
}

function checkedResponseChunk(chunk: ChatCompletionChunk | null): ChatCompletionChunk | null {
  if (chunk === null) return null;
  if (!isRecord(chunk) || chunk.object !== "chat.completion.chunk" || !Array.isArray(chunk.choices)) {
    throw protocol("Rosetta returned a malformed Chat Completion stream chunk.");
  }
  return chunk;
}

function withoutChoiceDeltaContent(chunk: ChatCompletionChunk): ChatCompletionChunk {
  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      const { content: _content, ...delta } = choice.delta;
      return { ...choice, delta };
    }),
  };
}

function usageChunk(
  template: ChatCompletionChunk,
  provenance: UsageProvenance,
  enforcement: MaxTokensEnforcementDiagnostic,
): ChatCompletionStreamChunk {
  return {
    ...template,
    choices: [],
    usage: openAIUsage(provenance),
    usage_provenance: provenance,
    max_tokens_enforcement: enforcement,
  } as ChatCompletionStreamChunk;
}

function convertStream(
  session: Session,
  converter: ChatCompletionToMessagesConverter,
  source: AsyncIterable<RawMessageStreamEvent>,
  includeUsage: boolean,
  requestedMaxTokens: number,
): AsyncIterable<ChatCompletionStreamChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<ChatCompletionStreamChunk> {
      type Cancellation =
        | { readonly kind: "return"; readonly value: unknown }
        | { readonly kind: "throw"; readonly error: unknown };
      type ReadOutcome =
        | { readonly kind: "read"; readonly result: IteratorResult<RawMessageStreamEvent> }
        | { readonly kind: "error"; readonly error: unknown };

      const sourceIterator = source[Symbol.asyncIterator]();
      let cancelled = false;
      let cancellationValue: Cancellation | undefined;
      let completed = false;
      let sourceEnded = false;
      let sourceClose: Promise<IteratorResult<RawMessageStreamEvent>> | undefined;
      let resolveCancellation!: (value: Cancellation) => void;
      const cancellation = new Promise<Cancellation>((resolve) => { resolveCancellation = resolve; });

      const doneResult = (value?: unknown): IteratorResult<ChatCompletionStreamChunk> => ({
        done: true,
        value: value as ChatCompletionStreamChunk,
      });

      const closeSource = (
        kind: "return" | "throw",
        value: unknown,
      ): Promise<IteratorResult<RawMessageStreamEvent>> => {
        if (sourceClose) return sourceClose;
        if (sourceEnded) return Promise.resolve({ done: true, value: value as RawMessageStreamEvent });
        sourceEnded = true;
        try {
          let operation: PromiseLike<IteratorResult<RawMessageStreamEvent>> | IteratorResult<RawMessageStreamEvent>;
          if (kind === "throw" && typeof sourceIterator.throw === "function") {
            operation = sourceIterator.throw(value);
          } else if (typeof sourceIterator.return === "function") {
            operation = sourceIterator.return(value as never);
          } else {
            operation = { done: true, value: value as RawMessageStreamEvent };
          }
          sourceClose = Promise.resolve(operation);
        } catch (error) {
          sourceClose = Promise.reject(error);
        }
        return sourceClose;
      };

      const guardedSource: AsyncIterableIterator<RawMessageStreamEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          if (cancelled || sourceEnded) return { done: true, value: undefined };
          let pending: PromiseLike<IteratorResult<RawMessageStreamEvent>> | IteratorResult<RawMessageStreamEvent>;
          try {
            pending = sourceIterator.next();
          } catch (error) {
            throw error;
          }
          const read: Promise<ReadOutcome> = Promise.resolve(pending).then(
            (result) => ({ kind: "read" as const, result }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          const outcome = await Promise.race([
            read,
            cancellation.then((signal) => ({ kind: "cancel" as const, signal })),
          ]);
          if (cancelled || outcome.kind === "cancel") return { done: true, value: undefined };
          if (outcome.kind === "error") throw outcome.error;
          if (outcome.result.done) sourceEnded = true;
          return outcome.result;
        },
        return(value?: unknown): Promise<IteratorResult<RawMessageStreamEvent>> {
          return closeSource("return", value);
        },
        throw(error?: unknown): Promise<IteratorResult<RawMessageStreamEvent>> {
          return closeSource("throw", error);
        },
      };

      const generator = (async function* (): AsyncGenerator<ChatCompletionStreamChunk> {
        let started = false;
        let terminal = false;
        let messageDeltaSeen = false;
        let previousFinishChunk: ChatCompletionChunk | undefined;
        let usageTemplate: ChatCompletionChunk | undefined;
        let terminalUsage: unknown;
        let responseMetadata: object | undefined;
        let enforcement: MaxTokensEnforcementDiagnostic | undefined;
        let nextBlockIndex = 0;
        let activeBlock: number | undefined;
        let toolBlockSeen = false;
        const blockKinds = new Map<number, "text" | "tool_use">();
        const blockHasText = new Map<number, boolean>();
        const toolJson = new Map<number, string>();

        const attachEnforcement = (chunk: ChatCompletionChunk): ChatCompletionStreamChunk => {
          if (!enforcement) throw protocol("The Chat stream has no matching per-operation max_tokens admission diagnostic.");
          return { ...chunk, max_tokens_enforcement: enforcement } as ChatCompletionStreamChunk;
        };

        for await (const raw of guardedSource) {
          validateRawStreamEvent(raw);
          const event = raw as unknown as JsonRecord;
          if (terminal) throw protocol("The Messages stream emitted data after message_stop.");
          if (event.type === "ping") continue;
          if (!started) {
            if (event.type !== "message_start") throw protocol("The Messages stream did not begin with message_start.");
            validateStreamMessageStart(event, session);
            responseMetadata = event.message as object;
            enforcement = checkedMaxTokensEnforcement(responseMetadata, session, requestedMaxTokens);
            started = true;
          } else if (event.type === "message_start") {
            throw protocol("The Messages stream emitted more than one message_start.");
          }

          if (event.type === "content_block_start") {
            if (messageDeltaSeen || activeBlock !== undefined) throw protocol("Messages content blocks are not serial or arrived after the terminal delta.");
            validateStreamBlockStart(event, session);
            if (event.index !== nextBlockIndex) throw protocol("Messages content block indices are not contiguous.");
            const block = event.content_block as JsonRecord;
            const kind = block.type as "text" | "tool_use";
            if (kind === "text" && toolBlockSeen) throw protocol("Assistant text cannot follow a function tool call.");
            if (kind === "tool_use") toolBlockSeen = true;
            blockKinds.set(event.index as number, kind);
            if (kind === "text") blockHasText.set(event.index as number, false);
            if (kind === "tool_use") toolJson.set(event.index as number, "");
            activeBlock = event.index as number;
          } else if (event.type === "content_block_delta") {
            if (activeBlock !== event.index || !blockKinds.has(event.index as number)) throw protocol("A content delta has no matching active block.");
            validateStreamDelta(event);
            if (blockKinds.get(event.index as number) === "tool_use") {
              const delta = event.delta as JsonRecord;
              if (delta.type !== "input_json_delta") throw protocol("A function call contained a non-JSON stream delta.");
              toolJson.set(event.index as number, `${toolJson.get(event.index as number) ?? ""}${delta.partial_json as string}`);
            } else {
              const delta = event.delta as JsonRecord;
              if (delta.type !== "text_delta") throw protocol("A text block contained a non-text stream delta.");
              if ((delta.text as string).length > 0) blockHasText.set(event.index as number, true);
            }
          } else if (event.type === "content_block_stop") {
            if (activeBlock !== event.index) throw protocol("A content block stop has no matching active block.");
            if (blockKinds.get(event.index as number) === "tool_use") {
              const rawArguments = toolJson.get(event.index as number);
              if (rawArguments === undefined) throw protocol("A function call omitted its argument JSON.");
              try {
                if (!isRecord(JSON.parse(rawArguments) as unknown)) throw new Error("not-object");
              } catch {
                throw protocol("A streamed function call ended with invalid JSON arguments.");
              }
            }
            activeBlock = undefined;
            nextBlockIndex += 1;
          } else if (event.type === "message_delta") {
            if (messageDeltaSeen || activeBlock !== undefined || nextBlockIndex === 0) throw protocol("The Messages stream terminal delta is duplicated, empty, or precedes a block stop.");
            validateStreamTerminal(event);
            if (toolBlockSeen !== ((event.delta as JsonRecord).stop_reason === "tool_use")) {
              throw protocol("The streamed tool-use content and terminal stop reason disagree.");
            }
            terminalUsage = event.usage;
            messageDeltaSeen = true;
          } else if (event.type === "message_stop") {
            if (!messageDeltaSeen || activeBlock !== undefined) throw protocol("The Messages stream ended without a valid terminal delta.");
            terminal = true;
          }

          const stoppedBlockKind = event.type === "content_block_stop"
            ? blockKinds.get(event.index as number)
            : undefined;
          const chunk = checkedResponseChunk(converter.convertStreamEvent(
            raw as unknown as Parameters<typeof converter.convertStreamEvent>[0],
          ));
          if (!chunk) continue;
          if (event.type === "message_delta") {
            const finishReason = chunk.choices[0]?.finish_reason;
            if (finishReason === undefined || finishReason === null) throw protocol("Rosetta did not preserve the terminal finish reason.");
            previousFinishChunk = withoutChoiceDeltaContent(chunk);
            continue;
          }
          if (event.type === "message_stop") {
            if (chunk.choices.length !== 0) throw protocol("Rosetta returned a non-terminal choice with its usage chunk.");
            usageTemplate = chunk;
            continue;
          }
          if (event.type === "content_block_stop" && (
            stoppedBlockKind === "tool_use" ||
            (stoppedBlockKind === "text" && blockHasText.get(event.index as number) === true)
          )) continue;
          if (event.type === "content_block_delta" && (event.delta as JsonRecord).type === "input_json_delta") {
            yield attachEnforcement(withoutChoiceDeltaContent(chunk));
            continue;
          }
          yield attachEnforcement(chunk);
        }

        // Cancellation is not a malformed EOF or successful terminal event.
        if (cancelled) return;
        if (!started || !terminal || !messageDeltaSeen || !previousFinishChunk || !usageTemplate) {
          throw protocol("The Messages stream ended without message_start, terminal delta, and message_stop.");
        }
        if (!responseMetadata) throw protocol("The completed Messages stream has no response-scoped diagnostic handle.");
        const provenance = usageProvenance(responseMetadata);
        assertUsageMatchesMessage(terminalUsage, provenance);
        if (!enforcement) throw protocol("The completed Chat stream has no max_tokens admission diagnostic.");
        yield attachEnforcement(previousFinishChunk);
        if (includeUsage) yield usageChunk(usageTemplate, provenance, enforcement);
      })();

      const iterator: AsyncIterableIterator<ChatCompletionStreamChunk> = {
        [Symbol.asyncIterator]() { return this; },
        async next(value?: unknown): Promise<IteratorResult<ChatCompletionStreamChunk>> {
          if (cancellationValue?.kind === "return") return doneResult(cancellationValue.value);
          if (cancellationValue?.kind === "throw") throw cancellationValue.error;
          if (completed) return doneResult(value);
          const pending = Promise.resolve(generator.next(value)).then(
            (result) => ({ kind: "result" as const, result }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          const outcome = await Promise.race([
            pending,
            cancellation.then((signal) => ({ kind: "cancel" as const, signal })),
          ]);
          if (outcome.kind === "cancel") {
            if (outcome.signal.kind === "throw") throw outcome.signal.error;
            return doneResult(outcome.signal.value);
          }
          if (outcome.kind === "error") {
            completed = true;
            throw outcome.error;
          }
          if (outcome.result.done) completed = true;
          return outcome.result;
        },
        async return(value?: unknown): Promise<IteratorResult<ChatCompletionStreamChunk>> {
          if (completed) return doneResult(value);
          if (!cancellationValue) {
            cancelled = true;
            cancellationValue = { kind: "return", value };
            resolveCancellation(cancellationValue);
          }
          const cleanup = closeSource("return", value);
          const closing = Promise.resolve(generator.return(value as never));
          const [cleanupResult, closingResult] = await Promise.allSettled([cleanup, closing]);
          completed = true;
          if (cleanupResult.status === "rejected") throw cleanupResult.reason;
          if (closingResult.status === "rejected") throw closingResult.reason;
          return closingResult.value;
        },
        async throw(error?: unknown): Promise<IteratorResult<ChatCompletionStreamChunk>> {
          if (completed) throw error;
          if (!cancellationValue) {
            cancelled = true;
            cancellationValue = { kind: "throw", error };
            resolveCancellation(cancellationValue);
          }
          const cleanup = closeSource("throw", error);
          const throwing = Promise.resolve(generator.throw(error));
          const [cleanupResult, throwingResult] = await Promise.allSettled([cleanup, throwing]);
          completed = true;
          if (cleanupResult.status === "rejected") throw cleanupResult.reason;
          if (throwingResult.status === "rejected") throw throwingResult.reason;
          return throwingResult.value;
        },
      };
      return iterator;
    },
  };
}

function makeAdapter(session: Session): ChatAdapter {
  const createNonStreaming = async (
    input: ChatCompletionRequestNonStreaming,
    options?: ChatCompletionRequestOptions,
  ): Promise<ChatCompletionResponse> => {
    const request = input as SourceRequest;
    if (request.stream === true) throw invalid("Use the streaming overload when stream is true.");
    const validatedOptions = validateSessionOptions(options);
    const converter = new ChatCompletionToMessagesConverter();
    const converted = converter.convertRequest(preserveExplicitEmptyAssistantText(request));
    const checked = validateConvertedRequest(request, converted, session);
    const nativeRequest = checked.native as MessageCreateParamsNonStreaming;
    const message = await session.messages.create(
      nativeRequest,
      validatedOptions.signal === undefined ? undefined : { signal: validatedOptions.signal },
    ) as Message;
    assertMessageResponse(message, session);
    const completion = preserveResponseTextPresence(
      message,
      converter.convertResponse(message as unknown as Parameters<typeof converter.convertResponse>[0]),
    );
    const provenance = usageProvenance(message);
    const enforcement = checkedMaxTokensEnforcement(message, session, checked.maxTokens);
    assertUsageMatchesMessage(message.usage, provenance);
    return {
      ...completion,
      usage: openAIUsage(provenance),
      usage_provenance: provenance,
      max_tokens_enforcement: enforcement,
    };
  };

  const createStreaming = async (
    input: ChatCompletionRequestStreaming,
    options?: ChatCompletionRequestOptions,
  ): Promise<AsyncIterable<ChatCompletionStreamChunk>> => {
    const request = input as SourceRequest;
    if (request.stream !== true) throw invalid("The streaming overload requires stream: true.");
    const validatedOptions = validateSessionOptions(options);
    if (validatedOptions.signal?.aborted) throw new RequestAbortedError("The Chat Completion operation was aborted.");
    const converter = new ChatCompletionToMessagesConverter();
    const converted = converter.convertRequest(preserveExplicitEmptyAssistantText(request));
    const checked = validateConvertedRequest(request, converted, session);
    const nativeRequest = {
      ...checked.native,
      stream: true,
    } as MessageCreateParamsStreaming;
    const rawStream = await session.messages.create(
      nativeRequest,
      validatedOptions.signal === undefined ? undefined : { signal: validatedOptions.signal },
    ) as AsyncIterable<RawMessageStreamEvent>;
    return convertStream(session, converter, rawStream, checked.includeUsage, checked.maxTokens);
  };

  const create = (
    request: ChatCompletionRequestNonStreaming | ChatCompletionRequestStreaming,
    options?: ChatCompletionRequestOptions,
  ): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionStreamChunk>> => {
    let checked: SourceRequest;
    try {
      checked = validateSourceRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return checked.stream === true
      ? createStreaming(checked as ChatCompletionRequestStreaming, options)
      : createNonStreaming(checked as ChatCompletionRequestNonStreaming, options);
  };

  return Object.freeze({
    completions: Object.freeze({ create: create as ChatCompletions["create"] }),
  });
}

/**
 * Bind the optional Rosetta Chat Completions subset to one SDK-owned account
 * session. No HTTP server, credential lookup, or shared converter is created.
 */
export function createChatAdapter(session: Session): ChatAdapter {
  if (!isAccountBoundSession(session)) {
    throw invalid("createChatAdapter requires a session created by an explicit SDK account profile.");
  }
  if (
    typeof session.accountId !== "string" || session.accountId.length === 0 ||
    typeof session.sessionId !== "string" || session.sessionId.length === 0 ||
    !session.configuration || typeof session.configuration.model !== "string" ||
    !session.messages || typeof session.messages.create !== "function" ||
    !session.diagnostics || typeof session.diagnostics.snapshot !== "function"
  ) throw invalid("The supplied SDK session does not expose a complete account-bound Messages capability.");
  return makeAdapter(session);
}
