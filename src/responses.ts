import { ResponsesToMessagesConverter } from "@zenmux/rosetta-ai";
import {
  isAnthropicAPIError,
  InvalidRequestError,
  ProtocolFailureError,
  RequestAbortedError,
  SDKError,
  UnsupportedFeatureError,
  type AnthropicAPIErrorLike,
} from "./errors.js";
import {
  messageMaxTokensEnforcement,
  messageStreamMaxTokensEnforcement,
  messageUsageProvenance,
} from "./messages.js";
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
type ConverterRequest = Parameters<ResponsesToMessagesConverter["convertRequest"]>[0];
type ConverterResponse = ReturnType<ResponsesToMessagesConverter["convertResponse"]>;
type ConverterStreamEvent = ReturnType<ResponsesToMessagesConverter["convertStreamEvent"]>[number];
type SupportedConverterStreamEvent = Extract<ConverterStreamEvent, { type:
  | "response.created"
  | "response.in_progress"
  | "response.output_item.added"
  | "response.output_item.done"
  | "response.content_part.added"
  | "response.content_part.done"
  | "response.output_text.delta"
  | "response.output_text.done"
  | "response.function_call_arguments.delta"
  | "response.function_call_arguments.done"
  | "response.completed"
  | "response.incomplete"
  | "response.failed"
  | "error"
}>;
type ConverterResponseStreamEvent = Extract<SupportedConverterStreamEvent, { response: unknown }>;
type ConverterTerminalEvent = Extract<SupportedConverterStreamEvent, {
  type: "response.completed" | "response.incomplete" | "response.failed";
}>;
type ConverterNonterminalResponseEvent = Exclude<ConverterResponseStreamEvent, ConverterTerminalEvent>;
type NonStreamingSource = Extract<ConverterRequest, { stream?: false | null }>;
type StreamingSource = Extract<ConverterRequest, { stream: true }>;
type SourceRequest = NonStreamingSource | StreamingSource;
type ConvertedRequest = ReturnType<ResponsesToMessagesConverter["convertRequest"]>;

/** Responses usage keeps unknown cache/reasoning buckets explicit as null. */
export interface ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly input_tokens_details: {
    readonly cached_tokens: number;
    readonly cache_write_tokens: number;
  };
  readonly output_tokens_details: {
    readonly reasoning_tokens: number | null;
  };
}

/**
 * Rosetta's converted response with operation-scoped usage provenance. Usage is
 * null when the adapter cannot form the Responses API's cache-inclusive totals.
 */
export type ResponsesResponse = Omit<ConverterResponse, "output_text" | "usage"> & {
  readonly usage: ResponsesUsage | null;
  readonly usage_provenance: UsageProvenance;
  /** Immutable per-operation disclosure of the requested output-token bound. */
  readonly max_tokens_enforcement: MaxTokensEnforcementDiagnostic;
};

export type ResponsesTerminalResponse = Omit<ConverterTerminalEvent["response"], "output_text" | "usage"> & {
  readonly usage: ResponsesUsage | null;
  readonly usage_provenance: UsageProvenance;
  readonly max_tokens_enforcement?: MaxTokensEnforcementDiagnostic;
};
export type ResponsesTerminalEvent = Omit<ConverterTerminalEvent, "response"> & {
  readonly response: ResponsesTerminalResponse;
};
export type ResponsesNonterminalResponse = Omit<ConverterNonterminalResponseEvent["response"], "output_text" | "usage"> & {
  readonly usage?: ResponsesUsage | null;
  readonly usage_provenance?: UsageProvenance;
  readonly max_tokens_enforcement?: MaxTokensEnforcementDiagnostic;
};
type ResponsesNonterminalResponseEvent = ConverterNonterminalResponseEvent extends infer Event
  ? Event extends { response: unknown }
    ? Omit<Event, "response"> & { readonly response: ResponsesNonterminalResponse }
    : never
  : never;
export type ResponsesStreamEvent = (Exclude<SupportedConverterStreamEvent, ConverterResponseStreamEvent> |
  ResponsesNonterminalResponseEvent | ResponsesTerminalEvent) & {
    /** Present on events after a matching per-operation admission; absent only on pre-admission failures. */
    readonly max_tokens_enforcement?: MaxTokensEnforcementDiagnostic;
  };

export type ResponsesCreateParamsNonStreaming = Omit<NonStreamingSource, "model" | "input"> & {
  readonly model: string;
  readonly input: NonStreamingSource["input"];
};
export type ResponsesCreateParamsStreaming = Omit<StreamingSource, "model" | "input"> & {
  readonly model: string;
  readonly input: StreamingSource["input"];
  readonly stream: true;
};

export interface ResponsesCreateOptions {
  readonly signal?: AbortSignal;
}

export interface SessionResponses {
  create(
    request: ResponsesCreateParamsNonStreaming,
    options?: ResponsesCreateOptions,
  ): Promise<ResponsesResponse>;
  create(
    request: ResponsesCreateParamsStreaming,
    options?: ResponsesCreateOptions,
  ): Promise<AsyncIterable<ResponsesStreamEvent>>;
}

export interface ResponsesAdapter {
  readonly responses: SessionResponses;
}

const SOURCE_FIELDS = new Set([
  "model", "input", "instructions", "max_output_tokens", "tools", "tool_choice",
  "parallel_tool_calls", "stream",
]);
const TOOL_NAME_MAX_BYTES = 128;
const TOOL_ID_MAX_BYTES = 256;
const MAX_TOOL_ARGUMENT_BYTES = 1_048_576;
const RESPONSE_STOP_REASONS = new Set(["end_turn", "stop_sequence", "tool_use", "max_tokens", "refusal"]);

type Cancellation =
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "throw"; readonly error: unknown }
  | { readonly kind: "abort"; readonly error: RequestAbortedError };

interface AbortableSource {
  readonly iterable: AsyncIterable<RawMessageStreamEvent>;
  readonly wasReturned: () => boolean;
  readonly close: (kind: "return" | "throw", value: unknown) => Promise<IteratorResult<RawMessageStreamEvent>>;
  readonly cancel: (value: Cancellation) => Promise<IteratorResult<RawMessageStreamEvent>>;
  readonly cleanup: () => void;
}

function invalid(message = "The Responses request is invalid."): InvalidRequestError {
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
      for (const key of Reflect.ownKeys(value)) {
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

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = keys as string[];
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function onlyKeys(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** Matches Rosetta's splitNamespacedToolName exactly, without rewriting. */
function rosettaWouldDenamespaceToolName(name: string): boolean {
  const delimiter = name.indexOf("___");
  return delimiter > 0 && delimiter + 3 < name.length;
}

function validateToolName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > TOOL_NAME_MAX_BYTES) {
    throw invalid("Function names must be non-empty strings within the supported byte bound.");
  }
  if (rosettaWouldDenamespaceToolName(value)) {
    throw unsupported("Function names Rosetta would split as namespace___name are not supported by this adapter.");
  }
}

function validateToolId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > TOOL_ID_MAX_BYTES) {
    throw invalid("Function call IDs must be non-empty strings within the supported byte bound.");
  }
}

function validateTextParts(value: unknown, role: string): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value) || value.length === 0) {
    throw unsupported(`${role} content must be a string or a non-empty text-only array.`);
  }
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== "string") throw invalid(`${role} content contains a malformed part.`);
    if (role === "assistant") {
      if (!onlyKeys(part, new Set(["type", "text", "annotations", "logprobs"])) ||
          part.type !== "output_text" || typeof part.text !== "string") {
        throw unsupported("Assistant input history supports only plain output_text blocks.");
      }
      if (Object.prototype.hasOwnProperty.call(part, "annotations") &&
          (!Array.isArray(part.annotations) || part.annotations.length !== 0)) {
        throw unsupported("Responses annotations cannot be represented by Messages history.");
      }
      if (Object.prototype.hasOwnProperty.call(part, "logprobs") &&
          part.logprobs !== null && (!Array.isArray(part.logprobs) || part.logprobs.length !== 0)) {
        throw unsupported("Responses log probabilities cannot be represented by Messages history.");
      }
    } else if (!exactKeys(part, ["type", "text"]) || part.type !== "input_text" || typeof part.text !== "string") {
      throw unsupported(`${role} input supports only plain input_text blocks.`);
    }
  }
}

function parseToolArguments(value: unknown): JsonRecord {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
    throw invalid("Function-call arguments must be a bounded JSON object string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalid("Function-call arguments are not valid JSON.");
  }
  if (!isRecord(parsed)) throw invalid("Function-call arguments must decode to a JSON object.");
  return parsed;
}

function validateCallMetadata(item: JsonRecord, allowed: ReadonlySet<string>): void {
  if (!onlyKeys(item, allowed)) throw unsupported("A Responses history item contains unsupported fields.");
  if (Object.prototype.hasOwnProperty.call(item, "id") &&
      (typeof item.id !== "string" || item.id.length === 0 || Buffer.byteLength(item.id, "utf8") > TOOL_ID_MAX_BYTES)) {
    throw invalid("Responses history item IDs must be non-empty bounded strings.");
  }
  if (Object.prototype.hasOwnProperty.call(item, "status") && item.status !== "completed") {
    throw unsupported("Only completed Responses history items can be replayed through this adapter.");
  }
}

function validateInputHistory(value: unknown, allowedToolNames: ReadonlySet<string>): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value) || value.length === 0) throw invalid("input must be a string or a non-empty full transcript array.");

  const allCallIds = new Set<string>();
  let pendingToolIds: Set<string> | undefined;
  let resultsStarted = false;
  let systemPrefix = true;
  let hasConversation = false;

  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type === "string" &&
        !["message", "function_call", "function_call_output"].includes(candidate.type)) {
      throw unsupported("Only text messages and function-call history items are supported in Responses input.");
    }
    const type = candidate.type;
    if (type === "function_call") {
      if (!exactKeys(candidate, ["type", "call_id", "name", "arguments"]) &&
          !onlyKeys(candidate, new Set(["type", "call_id", "name", "arguments", "id", "status"]))) {
        throw unsupported("Function-call history contains unsupported fields.");
      }
      validateCallMetadata(candidate, new Set(["type", "call_id", "name", "arguments", "id", "status"]));
      if (type !== "function_call" || typeof candidate.type !== "string") throw invalid("A function-call history item is malformed.");
      if (resultsStarted) throw invalid("Function calls cannot follow results within the same tool batch.");
      validateToolId(candidate.call_id);
      validateToolName(candidate.name);
      if (!allowedToolNames.has(candidate.name)) throw unsupported("A historical function call is not in the session's pinned tool catalog.");
      parseToolArguments(candidate.arguments);
      if (allCallIds.has(candidate.call_id)) throw invalid("Function call IDs must be unique throughout the supplied transcript.");
      allCallIds.add(candidate.call_id);
      pendingToolIds ??= new Set<string>();
      pendingToolIds.add(candidate.call_id);
      hasConversation = true;
      systemPrefix = false;
      continue;
    }

    if (type === "function_call_output") {
      validateCallMetadata(candidate, new Set(["type", "call_id", "output", "id", "status"]));
      if (pendingToolIds === undefined) throw invalid("A function-call output has no outstanding call.");
      validateToolId(candidate.call_id);
      if (!pendingToolIds.delete(candidate.call_id)) throw invalid("A function-call output ID is unknown or duplicated.");
      if (typeof candidate.output !== "string") {
        throw unsupported("Function-call outputs must be strings; multimodal or structured output is not supported.");
      }
      resultsStarted = true;
      if (pendingToolIds.size === 0) {
        pendingToolIds = undefined;
        resultsStarted = false;
      }
      continue;
    }

    if (type !== undefined && type !== "message") throw invalid("A message history item has an unsupported type.");
    if (typeof candidate.role !== "string") throw invalid("Every message history item needs a role.");
    const role = candidate.role;
    if (!["user", "assistant", "system", "developer"].includes(role)) {
      throw unsupported(`Responses input role '${role}' is not supported.`);
    }
    const allowedMessageKeys = new Set(["type", "role", "content", "id", "status"]);
    validateCallMetadata(candidate, allowedMessageKeys);
    if (!Object.prototype.hasOwnProperty.call(candidate, "content")) throw invalid("Every message history item needs content.");
    if (pendingToolIds?.size) throw invalid("Every function call in a batch needs a result before the next message.");
    validateTextParts(candidate.content, role);

    if (role === "system" || role === "developer") {
      if (!systemPrefix) throw unsupported("System and developer messages must precede the conversation transcript.");
      continue;
    }
    systemPrefix = false;
    hasConversation = true;
  }

  if (!hasConversation) throw invalid("At least one conversational message or function call is required.");
  if (pendingToolIds?.size) throw invalid("The transcript ends with an incomplete function-call batch.");
}

function validateSourceTools(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw invalid("tools must be an array of function tools.");
  const names = new Set<string>();
  return value.map((tool) => {
    if (!isRecord(tool) || !exactKeys(tool, ["type", "name", "parameters"]) &&
        !onlyKeys(tool, new Set(["type", "name", "description", "parameters", "strict"]))) {
      throw unsupported("Only Responses function tools are supported.");
    }
    if (tool.type !== "function") throw unsupported("Provider-hosted, custom, and namespace tools are not supported.");
    if (!onlyKeys(tool, new Set(["type", "name", "description", "parameters", "strict"]))) {
      throw unsupported("Function tool definitions contain unsupported fields.");
    }
    validateToolName(tool.name);
    if (names.has(tool.name)) throw invalid("Function tool names must be unique.");
    names.add(tool.name);
    if (tool.description !== undefined && typeof tool.description !== "string") throw invalid("Function descriptions must be strings.");
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") throw invalid("Function strict must be boolean when supplied.");
    if (tool.strict === true) throw unsupported("Strict JSON Schema mode is not supported by this Messages session.");
    if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
      throw unsupported("Function tools need an explicit object JSON Schema.");
    }
    return tool;
  });
}

function validateSourceRequest(input: unknown): SourceRequest {
  const request = copyJson(input);
  if (!isRecord(request)) throw invalid("The Responses request must be a plain object.");
  if (!onlyKeys(request, SOURCE_FIELDS)) {
    const unknown = Reflect.ownKeys(request).find((key) => typeof key !== "string" || !SOURCE_FIELDS.has(key));
    const name = String(unknown);
    if (["previous_response_id", "store", "background", "conversation"].includes(name)) {
      throw unsupported(`Responses ${name} semantics are unavailable; supply the complete input transcript for each operation.`);
    }
    throw unsupported(`Responses request field '${name}' is outside the supported session-bound subset.`);
  }
  if (typeof request.model !== "string" || request.model.length === 0 || request.model.includes("\0")) {
    throw invalid("model must be a non-empty string.");
  }
  if (!Object.prototype.hasOwnProperty.call(request, "input")) throw invalid("input is required; server-side conversation storage is not used.");
  if (Object.prototype.hasOwnProperty.call(request, "instructions") &&
      request.instructions !== null && typeof request.instructions !== "string") {
    throw invalid("instructions must be a string or null.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "max_output_tokens") && request.max_output_tokens !== null &&
      (!Number.isSafeInteger(request.max_output_tokens) || (request.max_output_tokens as number) < 1)) {
    throw invalid("max_output_tokens must be a positive safe integer or null.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "stream") &&
      request.stream !== true && request.stream !== false && request.stream !== null) {
    throw invalid("stream must be a boolean when supplied.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "parallel_tool_calls")) {
    if (request.parallel_tool_calls !== true && request.parallel_tool_calls !== false && request.parallel_tool_calls !== null) {
      throw invalid("parallel_tool_calls must be a boolean when supplied.");
    }
    if (request.parallel_tool_calls === false) {
      throw unsupported("parallel_tool_calls:false cannot be enforced by the session's native Messages capability.");
    }
  }
  if (Object.prototype.hasOwnProperty.call(request, "tool_choice") &&
      request.tool_choice !== null && request.tool_choice !== "auto") {
    throw unsupported("Only the default/auto function-tool choice is supported; forced, disabled, and hosted tool choices are rejected.");
  }
  if (Object.prototype.hasOwnProperty.call(request, "tools")) validateSourceTools(request.tools);
  const toolNames = new Set(
    (Array.isArray(request.tools) ? request.tools : []).map((tool) => isRecord(tool) && typeof tool.name === "string" ? tool.name : ""),
  );
  validateInputHistory(request.input, toolNames);
  return request as unknown as SourceRequest;
}

function systemText(value: unknown, where: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw unsupported(`${where} system prompt is not text-only.`);
  const chunks: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || !exactKeys(block, ["type", "text"]) || block.type !== "text" || typeof block.text !== "string") {
      throw unsupported(`${where} system prompt contains unsupported content or metadata.`);
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
  if (typeof value.name !== "string" || !isRecord(value.input_schema)) throw invalid(`${where} tool catalog is malformed.`);
  validateToolName(value.name);
  if (value.description !== undefined && typeof value.description !== "string") throw invalid(`${where} tool description is malformed.`);
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    input_schema: value.input_schema,
  };
}

function normalizedToolCatalog(value: unknown, where: string): JsonRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${where} tool catalog is malformed.`);
  return value.map((tool) => normalizedTool(tool, where));
}

function validateRequestPins(request: SourceRequest, session: Session): void {
  if (request.model !== session.configuration.model) {
    throw unsupported("The Responses model must match the session's pinned model.");
  }
  const sourceTools = Array.isArray(request.tools)
    ? request.tools.map((tool) => {
        if (!isRecord(tool)) throw invalid("A function tool is malformed.");
        return {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          input_schema: tool.parameters,
        };
      })
    : [];
  if (!jsonEqual(sourceTools, normalizedToolCatalog(session.configuration.tools, "Pinned"))) {
    throw unsupported("The Responses function catalog must exactly equal the session's pinned tools.");
  }
}

function validateConvertedMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw invalid("The converted input transcript must contain conversation content.");
  for (const message of value) {
    if (!isRecord(message) || !exactKeys(message, ["role", "content"]) ||
        (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content)) {
      throw unsupported("Rosetta produced an unrepresentable Messages transcript.");
    }
    for (const block of message.content) {
      if (!isRecord(block) || typeof block.type !== "string") throw invalid("Rosetta produced a malformed Messages block.");
      if (block.type === "text") {
        if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") {
          throw unsupported("Rosetta produced text metadata that native Messages cannot preserve.");
        }
      } else if (block.type === "tool_use") {
        if (message.role !== "assistant" || !exactKeys(block, ["type", "id", "name", "input"]) ||
            typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.input)) {
          throw unsupported("Rosetta produced an invalid function call.");
        }
      } else if (block.type === "tool_result") {
        if (message.role !== "user" || !onlyKeys(block, new Set(["type", "tool_use_id", "content", "is_error"])) ||
            typeof block.tool_use_id !== "string" || !Array.isArray(block.content) ||
            block.content.some((part) => !isRecord(part) || !exactKeys(part, ["type", "text"]) || part.type !== "text" || typeof part.text !== "string")) {
          throw unsupported("Rosetta produced a tool result that is not representable by the caller-tool ledger.");
        }
      } else {
        throw unsupported(`Rosetta produced unsupported Messages content '${block.type}'.`);
      }
    }
  }
}

function validateConvertedRequest(request: SourceRequest, converted: ConvertedRequest, session: Session): {
  readonly maxTokens: number;
  readonly messages: MessageCreateParamsNonStreaming["messages"];
  readonly stream: boolean;
} {
  const output = converted as unknown as JsonRecord;
  if (!onlyKeys(output, new Set(["model", "max_tokens", "messages", "system", "tools", "tool_choice", "stream"]))) {
    throw unsupported("Rosetta produced a Messages field outside the native session capability.");
  }
  if (output.model !== session.configuration.model || request.model !== session.configuration.model) {
    throw unsupported("The Responses model must match the session's pinned model.");
  }
  if (systemText(output.system, "Converted") !== systemText(session.configuration.system, "Pinned")) {
    throw unsupported("Responses instructions and system history must exactly match the pinned session system prompt.");
  }

  const convertedTools = normalizedToolCatalog(output.tools, "Converted");
  const pinnedTools = normalizedToolCatalog(session.configuration.tools, "Pinned");
  if (!jsonEqual(convertedTools, pinnedTools)) {
    throw unsupported("The converted function catalog must exactly match the session's pinned tools.");
  }
  if (Array.isArray(request.tools)) {
    const sourceTools = request.tools.map((tool) => {
      if (!isRecord(tool)) throw invalid();
      return {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        input_schema: tool.parameters,
      };
    });
    if (!jsonEqual(sourceTools, convertedTools)) {
      throw unsupported("Rosetta would alter or weaken a function JSON Schema; conversion was rejected.");
    }
  }
  const maxTokens = output.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1) {
    throw protocol("Rosetta produced an invalid Messages max_tokens value.");
  }
  if (session.capabilities.maxTokens !== "enforced" && session.capabilities.maxTokens !== "not-enforced") {
    throw unsupported("The session driver has not established max-token response admission for the Responses output bound.");
  }
  const isStreaming = request.stream === true;
  if (isStreaming && session.capabilities.streaming !== "incremental") {
    throw unsupported("The session driver has not declared incremental Messages streaming.");
  }
  if (output.stream !== undefined && output.stream !== isStreaming) {
    throw protocol("Rosetta changed the Responses stream mode during conversion.");
  }
  if (Object.prototype.hasOwnProperty.call(output, "tool_choice")) {
    const expected = request.tool_choice === "auto" ? { type: "auto" } : undefined;
    if (expected === undefined || !jsonEqual(output.tool_choice, expected)) {
      throw unsupported("Rosetta produced a tool choice that native Messages cannot enforce.");
    }
  }
  validateConvertedMessages(output.messages);
  return {
    maxTokens: maxTokens as number,
    messages: converted.messages as unknown as MessageCreateParamsNonStreaming["messages"],
    stream: isStreaming,
  };
}

function validateMaxTokensEnforcement(
  candidate: unknown,
  session: Session,
  requestedMaxTokens: number,
): MaxTokensEnforcementDiagnostic {
  const value = candidate;
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

function checkedMaxTokensEnforcement(
  response: object,
  session: Session,
  requestedMaxTokens: number,
): MaxTokensEnforcementDiagnostic {
  return validateMaxTokensEnforcement(messageMaxTokensEnforcement(response), session, requestedMaxTokens);
}

function validateSessionOptions(value: ResponsesCreateOptions | undefined): ResponsesCreateOptions {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value) || !onlyKeys(value, new Set(["signal"]))) throw invalid("Only signal is supported in Responses request options.");
  const descriptor = Object.getOwnPropertyDescriptor(value, "signal");
  if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
    throw invalid("Request options must contain only data properties.");
  }
  const signal = descriptor?.value as AbortSignal | undefined;
  if (signal !== undefined && (
    typeof signal !== "object" || signal === null || typeof (signal as AbortSignal).aborted !== "boolean" ||
    typeof (signal as AbortSignal).addEventListener !== "function" ||
    typeof (signal as AbortSignal).removeEventListener !== "function"
  )) throw invalid("signal must be an AbortSignal.");
  return Object.freeze(signal === undefined ? {} : { signal: signal as AbortSignal });
}

function toolNames(session: Session): Set<string> {
  return new Set(normalizedToolCatalog(session.configuration.tools, "Pinned")
    .map((tool) => tool.name).filter((name): name is string => typeof name === "string"));
}

function assertMessageResponse(value: Message, session: Session): void {
  const response = value as unknown as JsonRecord;
  if (!isRecord(response) || response.type !== "message" || response.role !== "assistant" ||
      response.model !== session.configuration.model || !Array.isArray(response.content) || response.content.length === 0) {
    throw protocol("The session returned an invalid Anthropic Messages response.");
  }
  const names = toolNames(session);
  let sawTool = false;
  for (const block of response.content) {
    if (!isRecord(block) || typeof block.type !== "string") throw protocol("The Messages response contains a malformed block.");
    if (block.type === "text") {
      if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") {
        throw unsupported("Messages response text metadata is unsupported by the Responses subset.");
      }
    } else if (block.type === "tool_use") {
      if (!exactKeys(block, ["type", "id", "name", "input"]) || typeof block.id !== "string" ||
          typeof block.name !== "string" || !isRecord(block.input) || !names.has(block.name)) {
        throw unsupported("The Messages response contains a non-catalog or malformed function call.");
      }
      validateToolId(block.id);
      sawTool = true;
    } else {
      throw unsupported(`Messages response block '${block.type}' is outside the text/function subset.`);
    }
  }
  if (!RESPONSE_STOP_REASONS.has(String(response.stop_reason))) {
    throw unsupported(`Messages stop reason '${String(response.stop_reason)}' has no supported Responses mapping.`);
  }
  if (sawTool !== (response.stop_reason === "tool_use")) {
    throw protocol("Messages function-call output and terminal stop reason disagree.");
  }
}

function expectedTerminalEvent(stopReason: unknown): "response.completed" | "response.incomplete" | "response.failed" {
  if (stopReason === "max_tokens") return "response.incomplete";
  if (stopReason === "refusal") return "response.failed";
  if (stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "tool_use") return "response.completed";
  throw unsupported(`Messages stop reason '${String(stopReason)}' has no supported Responses terminal status.`);
}

function assertUsageMatchesMessage(usage: unknown, provenance: UsageProvenance): void {
  if (!isRecord(usage)) throw protocol("The Messages response omitted usage metadata.");
  const measured = provenance.kind === "reported";
  const expectedInput = measured ? provenance.inputTokens : 0;
  const expectedOutput = measured ? provenance.outputTokens : 0;
  const expectedRead = measured ? provenance.cacheReadInputTokens ?? null : null;
  const expectedCreation = measured ? provenance.cacheCreationInputTokens ?? null : null;
  if (usage.input_tokens !== expectedInput || usage.output_tokens !== expectedOutput ||
      (usage.cache_read_input_tokens ?? null) !== expectedRead ||
      (usage.cache_creation_input_tokens ?? null) !== expectedCreation) {
    throw protocol("Session usage diagnostics do not match the completed Messages operation.");
  }
}

function responsesUsage(provenance: UsageProvenance): ResponsesUsage | null {
  if (provenance.kind !== "reported" || provenance.cacheReadInputTokens === undefined ||
      provenance.cacheCreationInputTokens === undefined) return null;
  const inputTokens = provenance.inputTokens + provenance.cacheReadInputTokens + provenance.cacheCreationInputTokens;
  const totalTokens = inputTokens + provenance.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(totalTokens)) {
    throw protocol("The session reported token usage outside the supported integer range.");
  }
  return {
    input_tokens: inputTokens,
    output_tokens: provenance.outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: {
      cached_tokens: provenance.cacheReadInputTokens,
      cache_write_tokens: provenance.cacheCreationInputTokens,
    },
    output_tokens_details: {
      reasoning_tokens: provenance.thinkingTokens ?? null,
    },
  };
}

function responseUsageProvenance(response: object): UsageProvenance {
  const provenance = messageUsageProvenance(response);
  if (!provenance) throw protocol("The completed Messages response has no matching per-operation usage diagnostic.");
  return provenance;
}

function validateRawUsage(value: unknown): void {
  if (!isRecord(value) || !Number.isSafeInteger(value.input_tokens) || (value.input_tokens as number) < 0 ||
      !Number.isSafeInteger(value.output_tokens) || (value.output_tokens as number) < 0) {
    throw protocol("The Messages stream emitted invalid usage counters.");
  }
  for (const key of ["cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const counter = value[key];
    if (counter !== undefined && counter !== null && (!Number.isSafeInteger(counter) || (counter as number) < 0)) {
      throw protocol("The Messages stream emitted invalid cache usage counters.");
    }
  }
}

function createAbortableSource(source: AsyncIterable<RawMessageStreamEvent>, signal?: AbortSignal): AbortableSource {
  let iterator: AsyncIterator<RawMessageStreamEvent>;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch {
    throw protocol("The Messages stream did not provide a usable async iterator.");
  }
  if (!iterator || typeof iterator.next !== "function") throw protocol("The Messages stream iterator is malformed.");

  let sourceEnded = false;
  let sourceClose: Promise<IteratorResult<RawMessageStreamEvent>> | undefined;
  let cancellationValue: Cancellation | undefined;
  let resolveCancellation!: (value: Cancellation) => void;
  const cancellation = new Promise<Cancellation>((resolve) => { resolveCancellation = resolve; });

  const close = (kind: "return" | "throw", value: unknown): Promise<IteratorResult<RawMessageStreamEvent>> => {
    if (sourceClose) return sourceClose;
    if (sourceEnded) return Promise.resolve({ done: true, value: value as RawMessageStreamEvent });
    sourceEnded = true;
    try {
      let operation: PromiseLike<IteratorResult<RawMessageStreamEvent>> | IteratorResult<RawMessageStreamEvent>;
      if (kind === "throw" && typeof iterator.throw === "function") operation = iterator.throw(value);
      else if (typeof iterator.return === "function") operation = iterator.return(value as never);
      else operation = { done: true, value: value as RawMessageStreamEvent };
      sourceClose = Promise.resolve(operation);
    } catch (error) {
      sourceClose = Promise.reject(error);
    }
    return sourceClose;
  };

  const cancel = (value: Cancellation): Promise<IteratorResult<RawMessageStreamEvent>> => {
    if (!cancellationValue) {
      cancellationValue = value;
      resolveCancellation(value);
    }
    if (cancellationValue.kind === "throw") return close("throw", cancellationValue.error);
    return close("return", cancellationValue.kind === "abort" ? cancellationValue.error : cancellationValue.value);
  };

  const onAbort = (): void => {
    void cancel({ kind: "abort", error: new RequestAbortedError("The Responses stream was aborted.") }).catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const guarded: AsyncIterableIterator<RawMessageStreamEvent> = {
    [Symbol.asyncIterator]() { return this; },
    async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
      if (cancellationValue) {
        if (cancellationValue.kind === "abort") throw cancellationValue.error;
        if (cancellationValue.kind === "throw") throw cancellationValue.error;
        return { done: true, value: undefined };
      }
      let pending: PromiseLike<IteratorResult<RawMessageStreamEvent>> | IteratorResult<RawMessageStreamEvent>;
      try {
        pending = iterator.next();
      } catch (error) {
        throw error;
      }
      const read = Promise.resolve(pending).then(
        (result) => ({ kind: "read" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const outcome = await Promise.race([
        read,
        cancellation.then((value) => ({ kind: "cancel" as const, value })),
      ]);
      if (outcome.kind === "cancel") {
        if (outcome.value.kind === "abort" || outcome.value.kind === "throw") throw outcome.value.error;
        return { done: true, value: undefined };
      }
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.result.done) sourceEnded = true;
      return outcome.result;
    },
    return(value?: unknown): Promise<IteratorResult<RawMessageStreamEvent>> {
      return cancel({ kind: "return", value });
    },
    throw(error?: unknown): Promise<IteratorResult<RawMessageStreamEvent>> {
      return cancel({ kind: "throw", error });
    },
  };

  return {
    iterable: guarded,
    wasReturned: () => cancellationValue?.kind === "return",
    close,
    cancel,
    cleanup: () => signal?.removeEventListener("abort", onAbort),
  };
}

function validateRawMessageStream(
  source: AbortableSource,
  sourceFailure: { value: unknown },
  sessionModel: string,
  sessionToolNames: ReadonlySet<string>,
): {
  readonly iterable: AsyncIterable<RawMessageStreamEvent>;
  readonly getMetadata: () => object | undefined;
  readonly getTerminalUsage: () => unknown;
  readonly getStopReason: () => string | undefined;
  readonly isComplete: () => boolean;
} {
  let started = false;
  let metadata: object | undefined;
  let terminalDelta = false;
  let stopped = false;
  let terminalUsage: unknown;
  let stopReason: string | undefined;
  let nextIndex = 0;
  let activeIndex: number | undefined;
  let sawTool = false;
  const blockKinds = new Map<number, "text" | "tool_use">();
  const toolJson = new Map<number, string>();

  const validate = (value: unknown): RawMessageStreamEvent => {
    if (!isRecord(value) || typeof value.type !== "string") throw protocol("The Messages stream emitted a malformed event.");
    if (!new Set(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop", "ping"]).has(value.type)) {
      throw protocol(`The Messages stream emitted unsupported event '${value.type}'.`);
    }
    if (stopped) throw protocol("The Messages stream emitted data after message_stop.");
    if (!started) {
      if (value.type !== "message_start") throw protocol("The Messages stream did not begin with message_start.");
      if (!isRecord(value.message) || value.message.type !== "message" || value.message.role !== "assistant" ||
          value.message.model !== sessionModel || typeof value.message.id !== "string" || value.message.id.length === 0 ||
          !Array.isArray(value.message.content) || value.message.content.length !== 0 || !isRecord(value.message.usage)) {
        throw protocol("The Messages stream started with invalid response metadata.");
      }
      validateRawUsage(value.message.usage);
      metadata = value.message;
      started = true;
      return value as unknown as RawMessageStreamEvent;
    }
    if (value.type === "ping") return value as unknown as RawMessageStreamEvent;
    if (value.type === "message_start") throw protocol("The Messages stream emitted more than one message_start.");
    if (terminalDelta && value.type !== "message_stop") throw protocol("Messages output arrived after its terminal delta.");

    if (value.type === "content_block_start") {
      if (terminalDelta || activeIndex !== undefined || !Number.isSafeInteger(value.index) || (value.index as number) !== nextIndex || !isRecord(value.content_block)) {
        throw protocol("The Messages stream content block start is malformed or out of sequence.");
      }
      const block = value.content_block;
      if (block.type === "text") {
        if (!exactKeys(block, ["type", "text"]) || typeof block.text !== "string") throw unsupported("Only plain streamed text blocks are supported.");
        if (sawTool) throw protocol("Assistant text cannot follow a function call.");
        blockKinds.set(nextIndex, "text");
      } else if (block.type === "tool_use") {
        if (!exactKeys(block, ["type", "id", "name", "input"]) || typeof block.id !== "string" ||
            typeof block.name !== "string" || !isRecord(block.input)) throw protocol("The streamed function-call start is malformed.");
        validateToolId(block.id);
        validateToolName(block.name);
        if (!sessionToolNames.has(block.name)) throw unsupported("The streamed function call is not in the session's pinned catalog.");
        if (sawTool && blockKinds.get(nextIndex - 1) !== "tool_use") throw protocol("Streamed function calls are not serially ordered.");
        sawTool = true;
        blockKinds.set(nextIndex, "tool_use");
        toolJson.set(nextIndex, "");
      } else {
        throw unsupported(`Messages stream block '${String(block.type)}' is not in the text/function subset.`);
      }
      activeIndex = nextIndex;
      return value as unknown as RawMessageStreamEvent;
    }

    if (value.type === "content_block_delta") {
      if (!Number.isSafeInteger(value.index) || value.index !== activeIndex || !isRecord(value.delta) || typeof value.delta.type !== "string") {
        throw protocol("A Messages delta has no matching active content block.");
      }
      const kind = blockKinds.get(activeIndex as number);
      if (kind === "text" && value.delta.type === "text_delta" && typeof value.delta.text === "string") {
        return value as unknown as RawMessageStreamEvent;
      }
      if (kind === "tool_use" && value.delta.type === "input_json_delta" && typeof value.delta.partial_json === "string") {
        toolJson.set(activeIndex as number, `${toolJson.get(activeIndex as number) ?? ""}${value.delta.partial_json}`);
        if (Buffer.byteLength(toolJson.get(activeIndex as number)!, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
          throw protocol("Streamed function-call arguments exceed the supported byte bound.");
        }
        return value as unknown as RawMessageStreamEvent;
      }
      throw unsupported("The Messages stream delta is incompatible with its active text/function block.");
    }

    if (value.type === "content_block_stop") {
      if (!Number.isSafeInteger(value.index) || value.index !== activeIndex) throw protocol("A content block stop has no matching active block.");
      if (blockKinds.get(activeIndex as number) === "tool_use") {
        parseToolArguments(toolJson.get(activeIndex as number));
      }
      activeIndex = undefined;
      nextIndex += 1;
      return value as unknown as RawMessageStreamEvent;
    }

    if (value.type === "message_delta") {
      if (terminalDelta || activeIndex !== undefined || nextIndex === 0 || !isRecord(value.delta) ||
          !RESPONSE_STOP_REASONS.has(String(value.delta.stop_reason))) {
        throw protocol("The Messages stream terminal delta is malformed or out of sequence.");
      }
      if ((value.delta.stop_reason === "tool_use") !== sawTool) throw protocol("Messages function-call output and terminal stop reason disagree.");
      validateRawUsage(value.usage);
      terminalUsage = value.usage;
      stopReason = value.delta.stop_reason as string;
      terminalDelta = true;
      return value as unknown as RawMessageStreamEvent;
    }

    if (value.type === "message_stop") {
      if (!terminalDelta || activeIndex !== undefined) throw protocol("The Messages stream ended without a valid terminal delta.");
      stopped = true;
      return value as unknown as RawMessageStreamEvent;
    }
    throw protocol("The Messages stream event sequence is invalid.");
  };

  const iterable: AsyncIterable<RawMessageStreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      const iterator = source.iterable[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<RawMessageStreamEvent>> {
          try {
            const result = await iterator.next();
            if (result.done) {
              if (source.wasReturned()) return result;
              if (!stopped) throw protocol("The Messages stream ended without message_stop.");
              return result;
            }
            return { done: false, value: validate(result.value) };
          } catch (error) {
            sourceFailure.value = error;
            throw error;
          }
        },
        return(value?: unknown) {
          return iterator.return ? iterator.return(value as never) : Promise.resolve({ done: true, value: value as RawMessageStreamEvent });
        },
        throw(error?: unknown) {
          return iterator.throw ? iterator.throw(error) : Promise.reject(error);
        },
      };
    },
  };
  return {
    iterable,
    getMetadata: () => metadata,
    getTerminalUsage: () => terminalUsage,
    getStopReason: () => stopReason,
    isComplete: () => stopped && terminalDelta,
  };
}

/**
 * Rosetta finalizes output items on message_stop. Feed it a synthetic stop
 * immediately after a validated message_delta, then defer consuming the real
 * native message_stop until Rosetta has yielded those final item events. This
 * keeps consumer return before the Responses terminal on the native
 * Messages iterator's uncommitted side of its message_stop boundary.
 */
function deferNativeMessageStop(source: AsyncIterable<RawMessageStreamEvent>): AsyncIterable<RawMessageStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RawMessageStreamEvent> {
      const iterator = source[Symbol.asyncIterator]();
      const deferred = (async function* (): AsyncGenerator<RawMessageStreamEvent> {
        for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
          if (event.type === "message_stop") continue;
          yield event;
          if (event.type === "message_delta") yield { type: "message_stop" };
        }
      })();
      return deferred;
    },
  };
}

function isTerminalEvent(event: ConverterStreamEvent): event is Extract<ConverterStreamEvent, {
  type: "response.completed" | "response.incomplete" | "response.failed";
}> {
  return event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed";
}

function validateConvertedStreamEvent(value: unknown, sequence: number): asserts value is SupportedConverterStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !Number.isSafeInteger(value.sequence_number) ||
      value.sequence_number !== sequence) {
    throw protocol("Rosetta emitted a malformed or out-of-order Responses stream event.");
  }
  const known = new Set([
    "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done",
    "response.content_part.added", "response.content_part.done", "response.output_text.delta",
    "response.output_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done",
    "response.completed", "response.incomplete", "response.failed", "error",
  ]);
  if (!known.has(value.type)) throw unsupported(`Rosetta emitted unsupported Responses event '${value.type}'.`);
  if (isTerminalEvent(value as unknown as ConverterStreamEvent)) {
    if (!isRecord(value.response)) throw protocol("Rosetta emitted a terminal event without its response object.");
    const expectedStatus = value.type === "response.completed" ? "completed" : value.type === "response.incomplete" ? "incomplete" : "failed";
    if (value.response.status !== expectedStatus) throw protocol("Rosetta terminal status does not match its event type.");
  }
}

function annotateStreamEvent(
  event: ConverterStreamEvent,
  enforcement: MaxTokensEnforcementDiagnostic | undefined,
): ResponsesStreamEvent {
  const record = event as unknown as JsonRecord;
  const result: JsonRecord = { ...record };
  if (enforcement !== undefined) result.max_tokens_enforcement = enforcement;
  if (isRecord(record.response)) {
    result.response = {
      ...record.response,
      ...(enforcement === undefined ? {} : { max_tokens_enforcement: enforcement }),
    };
  }
  return result as unknown as ResponsesStreamEvent;
}

function annotateTerminalEvent(
  event: ConverterStreamEvent,
  provenance: UsageProvenance,
  enforcement: MaxTokensEnforcementDiagnostic | undefined,
): ResponsesStreamEvent {
  if (!isTerminalEvent(event)) return annotateStreamEvent(event, enforcement);
  const annotated = annotateStreamEvent(event, enforcement) as unknown as JsonRecord;
  const response = annotated.response as JsonRecord;
  response.usage = responsesUsage(provenance);
  response.usage_provenance = provenance;
  return annotated as unknown as ResponsesTerminalEvent;
}

function apiErrorEvents(
  error: AnthropicAPIErrorLike,
  lastResponse: JsonRecord | undefined,
  firstSequence: number,
  model: string,
): [ConverterStreamEvent, ConverterStreamEvent] {
  const code = error.status === 429 ? "rate_limit_exceeded" : "server_error";
  const response: JsonRecord = lastResponse
    ? { ...lastResponse }
    : {
        id: "",
        object: "response",
        access_programs: null,
        created_at: Math.floor(Date.now() / 1000),
        model,
        output: [],
        status: "in_progress",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: {},
        temperature: null,
        top_p: null,
        max_output_tokens: null,
        previous_response_id: null,
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: [],
        text: { format: { type: "text" } },
        reasoning: null,
        truncation: null,
        user: undefined,
      };
  response.status = "failed";
  response.error = { code, message: error.message };
  return [
    { type: "response.failed", response, sequence_number: firstSequence } as ConverterStreamEvent,
    { type: "error", code, message: error.message, param: null, sequence_number: firstSequence + 1 } as ConverterStreamEvent,
  ];
}

function convertStream(
  session: Session,
  converter: ResponsesToMessagesConverter,
  source: AsyncIterable<RawMessageStreamEvent>,
  signal?: AbortSignal,
  requestedMaxTokens?: number,
): AsyncIterable<ResponsesStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<ResponsesStreamEvent> {
      const admissionReceipt = messageStreamMaxTokensEnforcement(source as object);
      const abortable = createAbortableSource(source, signal);
      const sourceFailure: { value: unknown } = { value: undefined };
      const validated = validateRawMessageStream(abortable, sourceFailure, session.configuration.model, toolNames(session));
      const converted = converter.convertStream(deferNativeMessageStop(validated.iterable));
      let cancelValue: Cancellation | undefined;
      let resolveCancellation!: (value: Cancellation) => void;
      const cancellation = new Promise<Cancellation>((resolve) => { resolveCancellation = resolve; });

      const generator = (async function* (): AsyncGenerator<ResponsesStreamEvent> {
        let expectedSequence = 0;
        let pendingTerminal: ConverterStreamEvent[] = [];
        let lastResponse: JsonRecord | undefined;
        let replacementErrorSequence: number | undefined;
        let enforcement: MaxTokensEnforcementDiagnostic | undefined;
        let completedNormally = false;
        try {
          try {
            for await (const event of converted) {
              validateConvertedStreamEvent(event, expectedSequence++);
              const nativeMetadata = validated.getMetadata();
              if (nativeMetadata !== undefined) {
                if (requestedMaxTokens === undefined) throw protocol("The Responses stream lost its converted output-token bound.");
                const observed = checkedMaxTokensEnforcement(nativeMetadata, session, requestedMaxTokens);
                if (enforcement !== undefined && !jsonEqual(enforcement, observed)) {
                  throw protocol("The Responses stream changed its response-scoped max_tokens admission.");
                }
                enforcement ??= observed;
              } else if (enforcement === undefined && admissionReceipt !== undefined) {
                const admitted = await admissionReceipt;
                if (admitted !== undefined) {
                  if (requestedMaxTokens === undefined) throw protocol("The Responses stream lost its converted output-token bound.");
                  enforcement = validateMaxTokensEnforcement(admitted, session, requestedMaxTokens);
                }
              }
              if (isRecord((event as unknown as JsonRecord).response)) {
                lastResponse = (event as unknown as JsonRecord).response as JsonRecord;
              }
              if (isTerminalEvent(event)) {
                if (pendingTerminal.length > 0) {
                  const previous = pendingTerminal[0];
                  if (event.type === "response.failed" && isAnthropicAPIError(sourceFailure.value) &&
                      previous && (previous.type === "response.completed" || previous.type === "response.incomplete")) {
                    replacementErrorSequence = previous.sequence_number;
                    (event as unknown as JsonRecord).sequence_number = replacementErrorSequence;
                    pendingTerminal = [event];
                    continue;
                  }
                  throw protocol("Rosetta emitted multiple terminal Responses events.");
                }
                pendingTerminal.push(event);
                continue;
              }
              if (event.type === "error") {
                if (pendingTerminal.length !== 1 || pendingTerminal[0]?.type !== "response.failed") {
                  throw protocol("Rosetta emitted an error event without a failed Responses terminal.");
                }
                if (replacementErrorSequence !== undefined) {
                  (event as unknown as JsonRecord).sequence_number = replacementErrorSequence + 1;
                  replacementErrorSequence = undefined;
                }
                pendingTerminal.push(event);
                continue;
              }
              if (pendingTerminal.length > 0) throw protocol("Rosetta emitted non-terminal data after a terminal Responses event.");
              yield annotateStreamEvent(event, enforcement);
            }
          } catch (error) {
            if (signal?.aborted) throw new RequestAbortedError("The Responses stream was aborted.");
            if (!isAnthropicAPIError(error)) throw error;
            sourceFailure.value = error;
            if (enforcement === undefined && admissionReceipt !== undefined) {
              const admitted = await admissionReceipt;
              if (admitted !== undefined) {
                if (requestedMaxTokens === undefined) throw protocol("The Responses stream lost its converted output-token bound.");
                enforcement = validateMaxTokensEnforcement(admitted, session, requestedMaxTokens);
              }
            }
            const terminalSequence = pendingTerminal[0]?.sequence_number ?? expectedSequence;
            const failure = apiErrorEvents(error, lastResponse, terminalSequence, session.configuration.model);
            expectedSequence += 2;
            pendingTerminal = failure;
          }

          if (isAnthropicAPIError(sourceFailure.value)) {
            if (pendingTerminal[0]?.type !== "response.failed") {
              throw protocol("The Anthropic API error was not retained as a failed Responses terminal.");
            }
          } else if (sourceFailure.value !== undefined) {
            throw sourceFailure.value;
          } else if (!validated.isComplete()) {
            throw protocol("The Responses stream ended without a complete Messages terminal sequence.");
          }
          if (pendingTerminal.length === 0) throw protocol("The Responses stream ended without a terminal event.");
          if (validated.isComplete() && !isAnthropicAPIError(sourceFailure.value) &&
              pendingTerminal[0]?.type !== expectedTerminalEvent(validated.getStopReason())) {
            throw protocol("Rosetta's Responses terminal event does not match the Messages stop reason.");
          }

          if (validated.isComplete() && enforcement === undefined) {
            throw protocol("The completed Responses stream has no matching max_tokens admission diagnostic.");
          }

          const metadata = validated.getMetadata();
          let provenance: UsageProvenance;
          const streamUsage = metadata ? messageUsageProvenance(metadata) : undefined;
          if (streamUsage) provenance = streamUsage;
          else if (isAnthropicAPIError(sourceFailure.value)) {
            provenance = {
              kind: "unknown",
              reason: "An Anthropic API error ended the stream before per-operation usage was reported.",
            };
          } else {
            throw protocol("The completed Responses stream has no matching usage diagnostic.");
          }
          if (validated.isComplete()) assertUsageMatchesMessage(validated.getTerminalUsage(), provenance);
          for (const terminal of pendingTerminal) yield annotateTerminalEvent(terminal, provenance, enforcement);
          completedNormally = true;
        } finally {
          if (!completedNormally) {
            abortable.cleanup();
            void abortable.close("return", undefined).catch(() => undefined);
          }
        }
      })();

      const iterator: AsyncIterableIterator<ResponsesStreamEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next(value?: unknown): Promise<IteratorResult<ResponsesStreamEvent>> {
          if (cancelValue?.kind === "return") return { done: true, value: cancelValue.value as ResponsesStreamEvent };
          if (cancelValue?.kind === "throw") throw cancelValue.error;
          if (cancelValue?.kind === "abort") throw cancelValue.error;
          const pending = Promise.resolve(generator.next(value)).then(
            (result) => ({ kind: "result" as const, result }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          const outcome = await Promise.race([
            pending,
            cancellation.then((cancel) => ({ kind: "cancel" as const, cancel })),
          ]);
          if (outcome.kind === "cancel") {
            if (outcome.cancel.kind === "return") return { done: true, value: outcome.cancel.value as ResponsesStreamEvent };
            throw outcome.cancel.error;
          }
          if (outcome.kind === "error") {
            abortable.cleanup();
            void abortable.close("return", outcome.error).catch(() => undefined);
            throw outcome.error;
          }
          if (outcome.result.done) abortable.cleanup();
          return outcome.result;
        },
        async return(value?: unknown): Promise<IteratorResult<ResponsesStreamEvent>> {
          if (!cancelValue) {
            cancelValue = { kind: "return", value };
            resolveCancellation(cancelValue);
          }
          const cleanup = abortable.cancel(cancelValue);
          const closing = Promise.resolve(generator.return(value as never));
          const [cleanupResult, closingResult] = await Promise.allSettled([cleanup, closing]);
          abortable.cleanup();
          if (cleanupResult.status === "rejected") throw cleanupResult.reason;
          if (closingResult.status === "rejected") throw closingResult.reason;
          return closingResult.value;
        },
        async throw(error?: unknown): Promise<IteratorResult<ResponsesStreamEvent>> {
          if (!cancelValue) {
            cancelValue = { kind: "throw", error };
            resolveCancellation(cancelValue);
          }
          const cleanup = abortable.cancel(cancelValue);
          const throwing = Promise.resolve(generator.throw(error));
          const [cleanupResult, throwingResult] = await Promise.allSettled([cleanup, throwing]);
          abortable.cleanup();
          if (cleanupResult.status === "rejected") throw cleanupResult.reason;
          if (throwingResult.status === "rejected") throw throwingResult.reason;
          return throwingResult.value;
        },
      };
      return iterator;
    },
  };
}

function makeAdapter(session: Session): ResponsesAdapter {
  const createNonStreaming = async (
    input: ResponsesCreateParamsNonStreaming,
    options?: ResponsesCreateOptions,
  ): Promise<ResponsesResponse> => {
    const request = input as SourceRequest;
    if (request.stream === true) throw invalid("Use the streaming overload when stream is true.");
    const validatedOptions = validateSessionOptions(options);
    if (validatedOptions.signal?.aborted) throw new RequestAbortedError("The Responses operation was aborted.");
    validateRequestPins(request, session);
    const converter = new ResponsesToMessagesConverter();
    let converted: ConvertedRequest;
    try {
      converted = converter.convertRequest(request);
    } catch (error) {
      if (error instanceof SDKError) throw error;
      throw new ProtocolFailureError("Rosetta could not convert the validated Responses request.", { cause: error });
    }
    const checked = validateConvertedRequest(request, converted, session);
    const nativeRequest = {
      max_tokens: checked.maxTokens,
      messages: checked.messages,
    } as MessageCreateParamsNonStreaming;
    const message = await session.messages.create(
      nativeRequest,
      validatedOptions.signal === undefined ? undefined : { signal: validatedOptions.signal },
    ) as Message;
    assertMessageResponse(message, session);
    const response = converter.convertResponse(message as unknown as Parameters<typeof converter.convertResponse>[0]);
    const expectedEvent = expectedTerminalEvent(message.stop_reason);
    const expectedStatus = expectedEvent === "response.completed" ? "completed" :
      expectedEvent === "response.incomplete" ? "incomplete" : "failed";
    if (response.status !== expectedStatus) {
      throw protocol("Rosetta's Responses status does not match the Messages stop reason.");
    }
    const provenance = responseUsageProvenance(message);
    const enforcement = checkedMaxTokensEnforcement(message, session, checked.maxTokens);
    assertUsageMatchesMessage(message.usage, provenance);
    return {
      ...response,
      usage: responsesUsage(provenance),
      usage_provenance: provenance,
      max_tokens_enforcement: enforcement,
    };
  };

  const createStreaming = async (
    input: ResponsesCreateParamsStreaming,
    options?: ResponsesCreateOptions,
  ): Promise<AsyncIterable<ResponsesStreamEvent>> => {
    const request = input as SourceRequest;
    if (request.stream !== true) throw invalid("The streaming overload requires stream: true.");
    const validatedOptions = validateSessionOptions(options);
    if (validatedOptions.signal?.aborted) throw new RequestAbortedError("The Responses stream was aborted.");
    validateRequestPins(request, session);
    const converter = new ResponsesToMessagesConverter();
    let converted: ConvertedRequest;
    try {
      converted = converter.convertRequest(request);
    } catch (error) {
      if (error instanceof SDKError) throw error;
      throw new ProtocolFailureError("Rosetta could not convert the validated Responses request.", { cause: error });
    }
    const checked = validateConvertedRequest(request, converted, session);
    const nativeRequest = {
      max_tokens: checked.maxTokens,
      messages: checked.messages,
      stream: true,
    } as MessageCreateParamsStreaming;
    const raw = await session.messages.create(
      nativeRequest,
      validatedOptions.signal === undefined ? undefined : { signal: validatedOptions.signal },
    ) as AsyncIterable<RawMessageStreamEvent>;
    if (validatedOptions.signal?.aborted) {
      const iterator = raw[Symbol.asyncIterator]();
      if (iterator.return) await iterator.return();
      throw new RequestAbortedError("The Responses stream was aborted.");
    }
    return convertStream(session, converter, raw, validatedOptions.signal, checked.maxTokens);
  };

  const create = (
    request: ResponsesCreateParamsNonStreaming | ResponsesCreateParamsStreaming,
    options?: ResponsesCreateOptions,
  ): Promise<ResponsesResponse | AsyncIterable<ResponsesStreamEvent>> => {
    let checked: SourceRequest;
    try {
      checked = validateSourceRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return checked.stream === true
      ? createStreaming(checked as ResponsesCreateParamsStreaming, options)
      : createNonStreaming(checked as ResponsesCreateParamsNonStreaming, options);
  };

  return Object.freeze({ responses: Object.freeze({ create: create as SessionResponses["create"] }) });
}

/**
 * Bind the optional Rosetta Responses subset to one explicit SDK account
 * session. No response store, server, credential discovery, or shared
 * converter is created.
 */
export function createResponsesAdapter(session: Session): ResponsesAdapter {
  if (!isAccountBoundSession(session)) {
    throw invalid("createResponsesAdapter requires a session created by an explicit SDK account profile.");
  }
  if (
    typeof session.accountId !== "string" || session.accountId.length === 0 ||
    typeof session.sessionId !== "string" || session.sessionId.length === 0 ||
    !session.configuration || typeof session.configuration.model !== "string" ||
    !session.messages || typeof session.messages.create !== "function" ||
    !session.diagnostics || typeof session.diagnostics.snapshot !== "function"
  ) throw invalid("The supplied SDK session does not expose a complete account-bound Messages capability.");
  // Rosetta denamespaced output names; fail before an operation if the pinned
  // catalog contains a flat name whose response representation would change.
  normalizedToolCatalog(session.configuration.tools, "Pinned");
  return makeAdapter(session);
}
