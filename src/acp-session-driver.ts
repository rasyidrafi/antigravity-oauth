import { performance } from "node:perf_hooks";
import { InvalidRequestError, ProcessFailureError, ProtocolFailureError, RequestAbortedError, RequestTimeoutError, SessionBusyError, SessionNotFoundError, UnsupportedFeatureError } from "./errors.js";
import { AcpMethodNotFoundError, connectAcp, type AcpConnection, type ProcessFactory } from "./acp.js";
import { createGuardedPermissionResponse } from "./acp-permission-response.js";
import { assertReviewedAcpPair } from "./acp-compatibility.js";
import { extractAcpAdvertisedModels } from "./acp-models.js";
import { createNoninteractiveAuthGuard, type NoninteractiveAuthGuard } from "./noninteractive-auth.js";
import { normalizeAcpPermissionPolicy } from "./acp-permissions.js";
import type {
  AcpPermissionPolicy,
  AcpPermissionsOptions,
  AcpPermissionRequestDetails,
  AcpTextBlock,
  MaxTokensPolicy,
  SessionDriverAcknowledgement,
  SessionDriver,
  SessionDriverContext,
  SessionDriverNotification,
  SessionDriverOperation,
  SessionDriverResponseAdmission,
  SessionDriverResponseAdmissionRequest,
  SessionDriverStreamEvent,
  SessionDriverCallerToolBinding,
  SessionMcpServer,
  SessionTranscript,
  PendingToolCall,
} from "./contracts.js";

const DEFAULT_MODEL_CONFIRMATION_TIMEOUT_MS = 30_000;
const MAX_NOTIFICATION_COUNT = 256;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const MAX_PRE_SESSION_NOTIFICATION_COUNT = MAX_NOTIFICATION_COUNT;
const MAX_PRE_SESSION_NOTIFICATION_BYTES = MAX_NOTIFICATION_BYTES;
const MAX_DISCARDED_SESSION_UPDATE_BYTES = 256 * 1024;
const MAX_AVAILABLE_COMMANDS = 256;
const MAX_AVAILABLE_COMMAND_TEXT_BYTES = 16 * 1024;
const MAX_PLAN_ENTRIES = 256;
const MAX_CONFIG_OPTIONS = 256;
const MAX_CONFIG_OPTION_VALUES = 2_048;
const MAX_IDLE_DISCARDED_UPDATE_COUNT = 65_536;
const MAX_IDLE_DISCARDED_UPDATE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_QUEUE_EVENTS = 256;
const MAX_PROMPT_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_EVENTS = 65_536;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_ACTIVITY_EVENTS = 128;
const MAX_PROMPT_ACTIVITY_BYTES = 1024 * 1024;
const MAX_ACTIVITY_DIAGNOSTIC_COUNT = 65_536;
// Leave headroom inside the session engine's default one-second cleanup
// deadline for bounded ACP transport termination and profile-guard disposal.
const PROMPT_CLEANUP_TIMEOUT_MS = 150;
const MAX_PERMISSION_CALLBACK_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_PERMISSION_CALLBACKS = 8;
const MAX_PERMISSION_DETAIL_BYTES = 256;
const MCP_SERVER_NAME = "antigravity-sdk-session-tools";
const ACP_PERMISSION_OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const ACP_TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const ACP_TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

export interface AcpSessionDriverFactoryOptions {
  readonly executable: string;
  readonly args: readonly string[];
  /** Immutable policy copied from the owning SDK. */
  readonly maxTokensPolicy?: MaxTokensPolicy;
  /** Frozen normalized built-in permission policy selected by the SDK. */
  readonly permissions: AcpPermissionPolicy;
}

interface DriverOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly processFactory?: ProcessFactory;
}

interface TestFactoryOptions extends DriverOptions {
  readonly processFactory: ProcessFactory;
  /** Short deterministic timeout for tests that intentionally omit a model update. */
  readonly modelConfirmationTimeoutMs?: number;
  /** Internal test seam for exercising the SDK's one-shot callback path. */
  readonly permissions?: AcpPermissionsOptions;
}

interface TestEnforcingFactoryOptions extends TestFactoryOptions {
  /** Test-only substitute for backend max_tokens enforcement. Never used by the official factory. */
  readonly enforceMaxTokens: (request: import("./contracts.js").SessionDriverResponseAdmissionRequest) => boolean | Promise<boolean>;
}

interface ModelUpdate {
  readonly sequence: number;
  readonly value: string;
}

interface NotificationWaiter {
  readonly sessionId: string;
  readonly configId: string;
  readonly afterSequence: number;
  readonly resolve: (update: ModelUpdate) => void;
  readonly reject: (error: Error) => void;
}

interface PromptEventWaiter {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: IteratorResult<PromptPumpEvent>) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: (() => void) | undefined;
}

type PromptPumpEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly operationId: string };

class PromptEventBuffer {
  private readonly values: Array<{ readonly event: PromptPumpEvent; readonly bytes: number }> = [];
  private readonly waiters: PromptEventWaiter[] = [];
  private bufferedBytes = 0;
  private ended = false;
  private failure: Error | undefined;

  push(event: PromptPumpEvent): void {
    if (this.ended) throw new ProtocolFailureError("ACP sent prompt text after the prompt completed.");
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.values.length >= MAX_PROMPT_QUEUE_EVENTS || this.bufferedBytes + bytes > MAX_PROMPT_QUEUE_BYTES) {
      throw new ProtocolFailureError("ACP prompt event buffer exceeded its bounded capacity.");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.values.push({ event, bytes });
    this.bufferedBytes += bytes;
  }

  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  next(signal?: AbortSignal): Promise<IteratorResult<PromptPumpEvent>> {
    const entry = this.values.shift();
    if (entry) {
      this.bufferedBytes = Math.max(0, this.bufferedBytes - entry.bytes);
      return Promise.resolve({ done: false, value: entry.event });
    }
    if (this.ended) {
      return this.failure
        ? Promise.reject(this.failure)
        : Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      let waiter: PromptEventWaiter;
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(new RequestAbortedError("The ACP prompt was cancelled."));
      };
      waiter = { signal, resolve, reject, onAbort };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

interface ActivePromptTurn {
  readonly operationId: string;
  readonly sessionId: string;
  readonly events: PromptEventBuffer;
  readonly operationIds: Set<string>;
  readonly consumedBatchOperationIds: Set<string>;
  permissionSignal: AbortSignal;
  currentOperationId: string;
  eventCount: number;
  outputBytes: number;
  activityEventCount: number;
  activityBytes: number;
  terminalReceived: boolean;
  requestTimedOut: boolean;
  protocolFailure?: Error;
  promptPromise?: Promise<unknown>;
  consumerActive: boolean;
  awaitingContinuation: boolean;
  lastToolBatch?: { readonly operationId: string; readonly callIds: readonly string[] };
  continuationPrepared?: import("./contracts.js").SessionDriverToolContinuation;
  cleanupPromise?: Promise<void>;
  cleanup?: () => Promise<void>;
  initialAbortCleanup?: () => void;
}

interface PendingPermissionDecision {
  readonly turn: ActivePromptTurn;
  readonly operationId: string;
  readonly controller: AbortController;
}

interface PermissionCallbackBudget {
  active: number;
}

interface TestAdmissionRecord {
  readonly kind: "prompt" | "tool_continuation";
  readonly operationId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly maxTokens?: number;
  readonly policy: MaxTokensPolicy;
  readonly outcome: "enforced" | "ignored" | "unbounded";
  readonly reason: "driver-admitted-requested-bound" | "backend-does-not-enforce-requested-bound" | "no-output-token-bound-requested";
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

interface ValidPermissionRequest {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  readonly status?: "pending" | "in_progress" | "completed" | "failed";
  readonly options: readonly {
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
}

function validAcpIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512;
}

function validOptionalJsonMeta(value: unknown): boolean {
  return value === null || validJsonRecord(value);
}

/**
 * ACP leaves `_meta` opaque. The pinned Antigravity ACP 1.3.0 worker was
 * observed sending `_meta.mcp` with `server` and `tool`; retain the previously
 * accepted server-only shape as well. Validate these bounded strings for
 * syntax only: neither value is retained, shown to callers, or used as proof
 * of origin, tool identity, or permission authority.
 */
function validatePermissionRequest(value: unknown): ValidPermissionRequest | undefined {
  if (!isRecord(value) || !onlyKeys(value, ["sessionId", "toolCall", "options", "_meta"]) ||
      !validAcpIdentifier(value.sessionId) || !isRecord(value.toolCall) || !Array.isArray(value.options) ||
      value.options.length === 0 || value.options.length > 64 ||
      (Object.hasOwn(value, "_meta") && !validOptionalJsonMeta(value._meta))) return undefined;

  const toolCall = value.toolCall;
  if (!onlyKeys(toolCall, [
    "toolCallId", "kind", "status", "title", "name", "content", "locations", "rawInput", "rawOutput", "_meta",
  ]) || !validAcpIdentifier(toolCall.toolCallId)) return undefined;
  if (Object.hasOwn(toolCall, "kind") && toolCall.kind !== null &&
      (typeof toolCall.kind !== "string" || !ACP_TOOL_KINDS.has(toolCall.kind))) return undefined;
  if (Object.hasOwn(toolCall, "status") && toolCall.status !== null &&
      (typeof toolCall.status !== "string" || !ACP_TOOL_STATUSES.has(toolCall.status))) return undefined;
  for (const key of ["title", "name"] as const) {
    if (Object.hasOwn(toolCall, key) && toolCall[key] !== null &&
        (typeof toolCall[key] !== "string" || toolCall[key].includes("\0") ||
          Buffer.byteLength(toolCall[key], "utf8") > 4_096)) return undefined;
  }
  for (const key of ["content", "locations"] as const) {
    if (Object.hasOwn(toolCall, key) && toolCall[key] !== null && !Array.isArray(toolCall[key])) return undefined;
  }
  if (Object.hasOwn(toolCall, "_meta") && !validOptionalJsonMeta(toolCall._meta)) return undefined;

  if (isRecord(toolCall._meta) && Object.hasOwn(toolCall._meta, "mcp")) {
    const mcp = toolCall._meta.mcp;
    if (!isRecord(mcp)) return undefined;
    const serverOnly = exactKeys(mcp, ["server"]) && validAcpIdentifier(mcp.server);
    const serverAndTool = exactKeys(mcp, ["server", "tool"]) &&
      validAcpIdentifier(mcp.server) && validAcpIdentifier(mcp.tool);
    if (!serverOnly && !serverAndTool) return undefined;
  }

  const optionIds = new Set<string>();
  const options: ValidPermissionRequest["options"][number][] = [];
  for (const option of value.options) {
    if (!isRecord(option) || !onlyKeys(option, ["optionId", "name", "kind", "_meta"]) ||
        !validAcpIdentifier(option.optionId) || typeof option.name !== "string" || option.name.includes("\0") ||
        Buffer.byteLength(option.name, "utf8") > 4_096 ||
        typeof option.kind !== "string" || !ACP_PERMISSION_OPTION_KINDS.has(option.kind) ||
        (Object.hasOwn(option, "_meta") && !validOptionalJsonMeta(option._meta)) || optionIds.has(option.optionId)) {
      return undefined;
    }
    optionIds.add(option.optionId);
    options.push(Object.freeze({
      optionId: option.optionId,
      kind: option.kind as ValidPermissionRequest["options"][number]["kind"],
    }));
  }
  return Object.freeze({
    sessionId: value.sessionId,
    toolCallId: toolCall.toolCallId,
    ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
    ...(typeof toolCall.name === "string" ? { name: toolCall.name } : {}),
    ...(typeof toolCall.kind === "string" ? { kind: toolCall.kind as NonNullable<ValidPermissionRequest["kind"]> } : {}),
    ...(typeof toolCall.status === "string" ? { status: toolCall.status as NonNullable<ValidPermissionRequest["status"]> } : {}),
    options: Object.freeze(options),
  });
}

const SENSITIVE_PERMISSION_DETAIL = /(?:\b(?:bearer|access[_ -]?token|refresh[_ -]?token|oauth[_ -]?token|api[_ -]?key|authorization|credential|password|secret|token)\s*(?:[:=]\s*|\s+)(?:bearer\s+)?(?!\[redacted\])[^\s,;]+|(?<![a-z0-9_-])[a-z0-9_-]{43}(?![a-z0-9_-])|\bsk-ant-[a-z0-9_-]+|\bsk-[a-z0-9_-]{20,}|\bya29\.[a-z0-9_-]+|\bAIza[0-9a-z_-]{30,}|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/][^\s]*)?)/iu;
const PERMISSION_REDACTION_MARKER = "[redacted]";

function redactKnownPermissionSecrets(value: string, knownSecrets: readonly string[]): {
  readonly value: string;
  readonly redacted: boolean;
} {
  let sanitized = value;
  let redacted = false;
  const uniqueSecrets = [...new Set(knownSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of uniqueSecrets) {
    if (!sanitized.includes(secret)) continue;
    sanitized = sanitized.split(secret).join(PERMISSION_REDACTION_MARKER);
    redacted = true;
  }
  return { value: sanitized, redacted };
}

function truncatePermissionText(value: string): { readonly value: string; readonly truncated: boolean } {
  let bounded = "";
  let truncated = false;
  for (let index = 0; index < value.length;) {
    const isRedactionMarker = value.startsWith(PERMISSION_REDACTION_MARKER, index);
    const character = isRedactionMarker
      ? PERMISSION_REDACTION_MARKER
      : String.fromCodePoint(value.codePointAt(index)!);
    if (Buffer.byteLength(bounded + character, "utf8") > MAX_PERMISSION_DETAIL_BYTES) {
      truncated = true;
      break;
    }
    bounded += character;
    index += character.length;
  }
  return { value: bounded, truncated };
}

function boundedPermissionText(value: string | undefined, knownSecrets: readonly string[]): {
  readonly value?: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
} {
  if (value === undefined) return { redacted: false, truncated: false };
  const exactRedaction = redactKnownPermissionSecrets(value, knownSecrets);
  const normalized = exactRedaction.value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  if (normalized.length === 0) return { redacted: false, truncated: false };
  if (SENSITIVE_PERMISSION_DETAIL.test(normalized)) {
    return { value: "[redacted]", redacted: true, truncated: false };
  }
  const bounded = truncatePermissionText(normalized);
  return {
    ...(bounded.value.length === 0 ? {} : { value: bounded.value }),
    redacted: exactRedaction.redacted,
    truncated: bounded.truncated,
  };
}

function permissionDetails(
  request: ValidPermissionRequest,
  knownSecrets: readonly string[],
): AcpPermissionRequestDetails {
  const title = boundedPermissionText(request.title, knownSecrets);
  const name = boundedPermissionText(request.name, knownSecrets);
  const redacted = title.redacted || name.redacted;
  const truncated = title.truncated || name.truncated;
  const hasDisplayText = title.value !== undefined || name.value !== undefined;
  return Object.freeze({
    handling: !hasDisplayText && !redacted && !truncated ? "omitted" : redacted ? "redacted" : "sanitized",
    redacted,
    truncated,
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(name.value === undefined ? {} : { name: name.value }),
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.status === undefined ? {} : { status: request.status }),
  });
}

function permissionResponse(
  options: ValidPermissionRequest["options"] | undefined,
  allow: boolean,
  cancelled = false,
  selectedOptionId?: string,
): Readonly<Record<string, unknown>> {
  if (cancelled || !options) return Object.freeze({ outcome: Object.freeze({ outcome: "cancelled" }) });
  const selected = allow && selectedOptionId !== undefined
    ? options.find(({ optionId, kind }) => optionId === selectedOptionId && kind === "allow_once")
    : options.find(({ kind }) => kind === (allow ? "allow_once" : "reject_once"));
  return selected
    ? Object.freeze({ outcome: Object.freeze({ outcome: "selected", optionId: selected.optionId }) })
    : Object.freeze({ outcome: Object.freeze({ outcome: "cancelled" }) });
}

/**
 * Resolve an automatic/callback allow only when the exact option ID and kind
 * are still present in the validated offer. Both automatic and callback
 * approvals are restricted to `allow_once`.
 */
function selectedAllowPermissionResponse(
  options: ValidPermissionRequest["options"],
  optionId: string,
  kind: "allow_once",
): Readonly<Record<string, unknown>> | undefined {
  const selected = options.find((option) => option.optionId === optionId && option.kind === kind);
  return selected
    ? Object.freeze({ outcome: Object.freeze({ outcome: "selected", optionId: selected.optionId }) })
    : undefined;
}

function automaticPermissionSelection(
  request: ValidPermissionRequest,
): { readonly optionId: string; readonly kind: "allow_once" } | undefined {
  const selected = request.options.find(({ kind }) => kind === "allow_once");
  return selected
    ? Object.freeze({ optionId: selected.optionId, kind: "allow_once" as const })
    : undefined;
}

function validJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return validJsonValue(value);
}

function validJsonValue(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 64 || ++visited > 65_536) return false;
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))) continue;
    if (typeof item !== "object") return false;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length > 0) return false;
      for (const key of Reflect.ownKeys(item)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length) return false;
      }
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) return false;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(item) || Object.getOwnPropertySymbols(item).length > 0) return false;
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return false;
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return true;
}

function validateMeta(value: unknown, location: string): void {
  if (value === null) return;
  if (!validJsonRecord(value)) {
    throw new ProtocolFailureError(`ACP ${location} metadata is malformed.`);
  }
}

function validateAnnotations(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value) || !onlyKeys(value, ["audience", "priority", "lastModified", "_meta"])) {
    throw new ProtocolFailureError("ACP text annotations are malformed or unsupported.");
  }
  if (Object.hasOwn(value, "audience") && value.audience !== null &&
      (!Array.isArray(value.audience) || value.audience.some((role) => role !== "user" && role !== "assistant"))) {
    throw new ProtocolFailureError("ACP text annotation audience is malformed.");
  }
  if (Object.hasOwn(value, "priority") && value.priority !== null &&
      (typeof value.priority !== "number" || !Number.isFinite(value.priority))) {
    throw new ProtocolFailureError("ACP text annotation priority is malformed.");
  }
  if (Object.hasOwn(value, "lastModified") && value.lastModified !== null && typeof value.lastModified !== "string") {
    throw new ProtocolFailureError("ACP text annotation lastModified is malformed.");
  }
  if (Object.hasOwn(value, "_meta")) validateMeta(value._meta, "text annotations");
}

function boundedAcpText(value: unknown, maximumBytes = 4_096): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function validNullableText(value: unknown, maximumBytes = 4_096): boolean {
  return value === null || boundedAcpText(value, maximumBytes);
}

function validatePlanEntry(value: unknown): void {
  if (!isRecord(value) || !onlyKeys(value, ["content", "priority", "status", "_meta"]) ||
      !Object.hasOwn(value, "content") || !boundedAcpText(value.content, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
      !Object.hasOwn(value, "priority") ||
      (value.priority !== "high" && value.priority !== "medium" && value.priority !== "low") ||
      !Object.hasOwn(value, "status") ||
      (value.status !== "pending" && value.status !== "in_progress" && value.status !== "completed")) {
    throw new ProtocolFailureError("ACP plan entry is malformed or oversized.");
  }
  if (Object.hasOwn(value, "_meta")) validateMeta(value._meta, "plan entry");
}

function validatePlanEntries(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_PLAN_ENTRIES) {
    throw new ProtocolFailureError("ACP plan entries are malformed or oversized.");
  }
  for (const entry of value) validatePlanEntry(entry);
}

function validateConfigSelectOption(value: unknown): void {
  if (!isRecord(value) || !onlyKeys(value, ["value", "name", "description", "_meta"]) ||
      !Object.hasOwn(value, "value") || !boundedAcpText(value.value, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
      !Object.hasOwn(value, "name") || !boundedAcpText(value.name, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
      (Object.hasOwn(value, "description") && !validNullableText(value.description, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) ||
      (Object.hasOwn(value, "_meta") && !validOptionalJsonMeta(value._meta))) {
    throw new ProtocolFailureError("ACP configuration option value is malformed or oversized.");
  }
}

function validateConfigOption(value: unknown, optionValueBudget: { count: number }): void {
  if (!isRecord(value) || !onlyKeys(value, [
    "id", "type", "currentValue", "options", "name", "description", "category", "_meta",
  ]) || !Object.hasOwn(value, "id") || !boundedAcpText(value.id, 512) ||
      !Object.hasOwn(value, "name") || !boundedAcpText(value.name, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
      (Object.hasOwn(value, "description") && !validNullableText(value.description, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) ||
      (Object.hasOwn(value, "category") && !validNullableText(value.category, 512)) ||
      (Object.hasOwn(value, "_meta") && !validOptionalJsonMeta(value._meta))) {
    throw new ProtocolFailureError("ACP session configuration option is malformed or oversized.");
  }

  if (value.type === "select") {
    if (!Object.hasOwn(value, "currentValue") || !boundedAcpText(value.currentValue, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
        !Object.hasOwn(value, "options") || !Array.isArray(value.options) ||
        value.options.length > MAX_CONFIG_OPTION_VALUES) {
      throw new ProtocolFailureError("ACP selectable configuration option is malformed or oversized.");
    }
    optionValueBudget.count += value.options.length;
    if (optionValueBudget.count > MAX_CONFIG_OPTION_VALUES) {
      throw new ProtocolFailureError("ACP configuration option values exceeded their bounded count.");
    }
    if (value.options.length === 0 || !isRecord(value.options[0]) || Object.hasOwn(value.options[0], "value")) {
      for (const option of value.options) validateConfigSelectOption(option);
      return;
    }
    for (const group of value.options) {
      if (!isRecord(group) || !onlyKeys(group, ["group", "name", "options", "_meta"]) ||
          !Object.hasOwn(group, "group") || !boundedAcpText(group.group, 512) ||
          !Object.hasOwn(group, "name") || !boundedAcpText(group.name, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
          !Object.hasOwn(group, "options") || !Array.isArray(group.options) ||
          group.options.length > MAX_CONFIG_OPTION_VALUES ||
          (Object.hasOwn(group, "_meta") && !validOptionalJsonMeta(group._meta))) {
        throw new ProtocolFailureError("ACP grouped configuration options are malformed or oversized.");
      }
      optionValueBudget.count += group.options.length;
      if (optionValueBudget.count > MAX_CONFIG_OPTION_VALUES) {
        throw new ProtocolFailureError("ACP configuration option values exceeded their bounded count.");
      }
      for (const option of group.options) validateConfigSelectOption(option);
    }
    return;
  }

  if (value.type !== "boolean" || !Object.hasOwn(value, "currentValue") || typeof value.currentValue !== "boolean" ||
      Object.hasOwn(value, "options")) {
    throw new ProtocolFailureError("ACP boolean configuration option is malformed.");
  }
}

interface ValidModelConfigSelection {
  readonly configId: string;
  readonly value: string;
}

/** ACP v1 config_option_update carries the complete configuration option list. */
function validateConfigOptionUpdate(
  update: Record<string, unknown>,
  selectedModelConfigId: string | undefined,
): { readonly bytes: number; readonly selected?: ValidModelConfigSelection } {
  if (!onlyKeys(update, ["sessionUpdate", "configOptions", "_meta"]) ||
      !Object.hasOwn(update, "configOptions") || !Array.isArray(update.configOptions) ||
      update.configOptions.length > MAX_CONFIG_OPTIONS) {
    throw new ProtocolFailureError("ACP configuration update is malformed or oversized.");
  }
  if (Object.hasOwn(update, "_meta")) validateMeta(update._meta, "configuration update");

  const optionValueBudget = { count: 0 };
  const ids = new Set<string>();
  const options: Record<string, unknown>[] = [];
  for (const option of update.configOptions) {
    validateConfigOption(option, optionValueBudget);
    const validatedOption = option as Record<string, unknown>;
    if (ids.has(validatedOption.id as string)) {
      throw new ProtocolFailureError("ACP configuration update contains duplicate option IDs.");
    }
    ids.add(validatedOption.id as string);
    options.push(validatedOption);
  }

  const modelTaggedOptions = options.filter((option) => option.category === "model" || option.id === "model");
  const candidates = selectedModelConfigId === undefined
    ? modelTaggedOptions
    : options.filter((option) => option.id === selectedModelConfigId);
  if (selectedModelConfigId !== undefined &&
      modelTaggedOptions.some((option) => option.id !== selectedModelConfigId)) {
    throw new ProtocolFailureError("ACP configuration update introduced an ambiguous model selector.");
  }
  if (candidates.length > 1) {
    throw new ProtocolFailureError("ACP configuration update contains an ambiguous model selector.");
  }
  const selector = candidates[0];
  let selected: ValidModelConfigSelection | undefined;
  if (selector) {
    if (selector.type !== "select" || typeof selector.currentValue !== "string" || !Array.isArray(selector.options)) {
      throw new ProtocolFailureError("ACP model configuration update has no selectable model value.");
    }
    const allowedValues: string[] = [];
    for (const option of selector.options) {
      if (isRecord(option) && typeof option.value === "string") {
        allowedValues.push(option.value);
      } else if (isRecord(option) && Array.isArray(option.options)) {
        for (const groupOption of option.options) {
          if (isRecord(groupOption) && typeof groupOption.value === "string") allowedValues.push(groupOption.value);
        }
      }
    }
    if (!allowedValues.includes(selector.currentValue)) {
      throw new ProtocolFailureError("ACP model configuration update selected a value that is not advertised.");
    }
    selected = Object.freeze({ configId: selector.id as string, value: selector.currentValue });
  }
  if (selectedModelConfigId !== undefined && !selected) {
    throw new ProtocolFailureError("ACP configuration update omitted the session's pinned model selector.");
  }

  const bytes = serializedNotificationBytes({ update });
  if (bytes > MAX_DISCARDED_SESSION_UPDATE_BYTES) {
    throw new ProtocolFailureError("ACP configuration update exceeded its bounded payload size.");
  }
  return Object.freeze({ bytes, ...(selected === undefined ? {} : { selected }) });
}

/**
 * Validate ACP v1 progress/session housekeeping that has no Messages mapping.
 * These updates are observational only; command and plan metadata do not
 * create tool authority, and context occupancy is not per-operation usage.
 */
function measureDiscardedSessionUpdate(update: Record<string, unknown>): number {
  const validateUpdateMeta = (): void => {
    if (Object.hasOwn(update, "_meta")) validateMeta(update._meta, "session update");
  };

  if (update.sessionUpdate === "available_commands_update") {
    if (!onlyKeys(update, ["sessionUpdate", "availableCommands", "_meta"]) ||
        !Object.hasOwn(update, "availableCommands") || !Array.isArray(update.availableCommands) ||
        update.availableCommands.length > MAX_AVAILABLE_COMMANDS) {
      throw new ProtocolFailureError("ACP available-commands update is malformed or oversized.");
    }
    validateUpdateMeta();
    for (const command of update.availableCommands) {
      if (!isRecord(command) || !onlyKeys(command, ["name", "description", "input", "_meta"]) ||
          !Object.hasOwn(command, "name") || !boundedAcpText(command.name, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
          !Object.hasOwn(command, "description") ||
          !boundedAcpText(command.description, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) {
        throw new ProtocolFailureError("ACP available command is malformed or oversized.");
      }
      if (Object.hasOwn(command, "_meta")) validateMeta(command._meta, "available command");
      if (Object.hasOwn(command, "input") && command.input !== null) {
        if (!isRecord(command.input) || !onlyKeys(command.input, ["hint", "_meta"]) ||
            !Object.hasOwn(command.input, "hint") ||
            !boundedAcpText(command.input.hint, MAX_AVAILABLE_COMMAND_TEXT_BYTES) ||
            (Object.hasOwn(command.input, "_meta") && !validOptionalJsonMeta(command.input._meta))) {
          throw new ProtocolFailureError("ACP available command input is malformed or oversized.");
        }
      }
    }
  } else if (update.sessionUpdate === "usage_update") {
    if (!onlyKeys(update, ["sessionUpdate", "used", "size", "cost", "_meta"]) ||
        !Object.hasOwn(update, "used") || typeof update.used !== "number" || !Number.isFinite(update.used) ||
        !Object.hasOwn(update, "size") || typeof update.size !== "number" || !Number.isFinite(update.size)) {
      throw new ProtocolFailureError("ACP usage update is malformed.");
    }
    validateUpdateMeta();
    if (Object.hasOwn(update, "cost") && update.cost !== null) {
      const cost = update.cost;
      if (!isRecord(cost) || !onlyKeys(cost, ["amount", "currency", "_meta"]) ||
          !Object.hasOwn(cost, "amount") || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) ||
          !Object.hasOwn(cost, "currency") || !boundedAcpText(cost.currency, 64) ||
          (Object.hasOwn(cost, "_meta") && !validOptionalJsonMeta(cost._meta))) {
        throw new ProtocolFailureError("ACP usage cost is malformed.");
      }
    }
  } else if (update.sessionUpdate === "plan") {
    if (!onlyKeys(update, ["sessionUpdate", "entries", "_meta"]) ||
        !Object.hasOwn(update, "entries")) {
      throw new ProtocolFailureError("ACP plan update is malformed.");
    }
    validateUpdateMeta();
    validatePlanEntries(update.entries);
  } else if (update.sessionUpdate === "plan_update") {
    if (!onlyKeys(update, ["sessionUpdate", "plan", "_meta"]) ||
        !Object.hasOwn(update, "plan") || !isRecord(update.plan)) {
      throw new ProtocolFailureError("ACP plan content update is malformed.");
    }
    validateUpdateMeta();
    const plan = update.plan;
    if (plan.type === "items") {
      if (!onlyKeys(plan, ["type", "planId", "entries", "_meta"]) ||
          !Object.hasOwn(plan, "planId") || !boundedAcpText(plan.planId, 512) ||
          !Object.hasOwn(plan, "entries")) {
        throw new ProtocolFailureError("ACP item plan update is malformed.");
      }
      if (Object.hasOwn(plan, "_meta")) validateMeta(plan._meta, "plan update content");
      validatePlanEntries(plan.entries);
    } else if (plan.type === "file") {
      if (!onlyKeys(plan, ["type", "planId", "uri", "_meta"]) ||
          !Object.hasOwn(plan, "planId") || !boundedAcpText(plan.planId, 512) ||
          !Object.hasOwn(plan, "uri") || !boundedAcpText(plan.uri, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) {
        throw new ProtocolFailureError("ACP file plan update is malformed or oversized.");
      }
      if (Object.hasOwn(plan, "_meta")) validateMeta(plan._meta, "plan update content");
    } else if (plan.type === "markdown") {
      if (!onlyKeys(plan, ["type", "planId", "content", "_meta"]) ||
          !Object.hasOwn(plan, "planId") || !boundedAcpText(plan.planId, 512) ||
          !Object.hasOwn(plan, "content") || !boundedAcpText(plan.content, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) {
        throw new ProtocolFailureError("ACP markdown plan update is malformed or oversized.");
      }
      if (Object.hasOwn(plan, "_meta")) validateMeta(plan._meta, "plan update content");
    } else {
      throw new ProtocolFailureError("ACP plan update uses an unsupported content variant.");
    }
  } else if (update.sessionUpdate === "plan_removed") {
    if (!onlyKeys(update, ["sessionUpdate", "planId", "_meta"]) ||
        !Object.hasOwn(update, "planId") || !boundedAcpText(update.planId, 512)) {
      throw new ProtocolFailureError("ACP plan removal update is malformed.");
    }
    validateUpdateMeta();
  } else if (update.sessionUpdate === "current_mode_update") {
    if (!onlyKeys(update, ["sessionUpdate", "currentModeId", "_meta"]) ||
        !Object.hasOwn(update, "currentModeId") || !boundedAcpText(update.currentModeId, 512)) {
      throw new ProtocolFailureError("ACP current-mode update is malformed.");
    }
    validateUpdateMeta();
  } else if (update.sessionUpdate === "session_info_update") {
    if (!onlyKeys(update, ["sessionUpdate", "title", "updatedAt", "_meta"]) ||
        (Object.hasOwn(update, "title") && !validNullableText(update.title, MAX_AVAILABLE_COMMAND_TEXT_BYTES)) ||
        (Object.hasOwn(update, "updatedAt") && !validNullableText(update.updatedAt, 512))) {
      throw new ProtocolFailureError("ACP session-info update is malformed or oversized.");
    }
    validateUpdateMeta();
  } else {
    throw new ProtocolFailureError("ACP session update is not a supported non-output housekeeping update.");
  }

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(update), "utf8");
  } catch {
    throw new ProtocolFailureError("ACP session update could not be measured within its resource bound.");
  }
  if (bytes > MAX_DISCARDED_SESSION_UPDATE_BYTES) {
    throw new ProtocolFailureError("ACP session housekeeping update exceeded its bounded payload size.");
  }
  return bytes;
}

function serializedNotificationBytes(notification: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(notification), "utf8");
  } catch {
    throw new ProtocolFailureError("ACP notification could not be measured within its resource bound.");
  }
}

/** ACP v1 ContentBlock/ToolCallContent unions are validated but never retained. */
function validateAcpContentBlock(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolFailureError("ACP activity content block is malformed.");
  }
  const validateCommon = (allowed: readonly string[]): void => {
    if (!onlyKeys(value, allowed)) throw new ProtocolFailureError("ACP activity content block has unsupported fields.");
    if (Object.hasOwn(value, "annotations")) validateAnnotations(value.annotations);
    if (Object.hasOwn(value, "_meta")) validateMeta(value._meta, "activity content block");
  };
  switch (value.type) {
    case "text":
      validateCommon(["type", "text", "annotations", "_meta"]);
      if (!Object.hasOwn(value, "text") || !boundedAcpText(value.text, MAX_PROMPT_ACTIVITY_BYTES)) {
        throw new ProtocolFailureError("ACP text activity content is malformed.");
      }
      return;
    case "image":
      validateCommon(["type", "data", "mimeType", "uri", "annotations", "_meta"]);
      if (!Object.hasOwn(value, "data") || !boundedAcpText(value.data, MAX_PROMPT_ACTIVITY_BYTES) ||
          !Object.hasOwn(value, "mimeType") || !boundedAcpText(value.mimeType) ||
          (Object.hasOwn(value, "uri") && !validNullableText(value.uri, MAX_PROMPT_ACTIVITY_BYTES))) {
        throw new ProtocolFailureError("ACP image activity content is malformed.");
      }
      return;
    case "audio":
      validateCommon(["type", "data", "mimeType", "annotations", "_meta"]);
      if (!Object.hasOwn(value, "data") || !boundedAcpText(value.data, MAX_PROMPT_ACTIVITY_BYTES) ||
          !Object.hasOwn(value, "mimeType") || !boundedAcpText(value.mimeType)) {
        throw new ProtocolFailureError("ACP audio activity content is malformed.");
      }
      return;
    case "resource_link":
      validateCommon(["type", "name", "uri", "description", "mimeType", "size", "title", "annotations", "_meta"]);
      if (!Object.hasOwn(value, "name") || !boundedAcpText(value.name) ||
          !Object.hasOwn(value, "uri") || !boundedAcpText(value.uri, MAX_PROMPT_ACTIVITY_BYTES) ||
          (Object.hasOwn(value, "description") && !validNullableText(value.description, MAX_PROMPT_ACTIVITY_BYTES)) ||
          (Object.hasOwn(value, "mimeType") && !validNullableText(value.mimeType)) ||
          (Object.hasOwn(value, "title") && !validNullableText(value.title)) ||
          (Object.hasOwn(value, "size") && value.size !== null &&
            !Number.isSafeInteger(value.size))) {
        throw new ProtocolFailureError("ACP resource-link activity content is malformed.");
      }
      return;
    case "resource": {
      validateCommon(["type", "resource", "annotations", "_meta"]);
      if (!Object.hasOwn(value, "resource") || !isRecord(value.resource)) {
        throw new ProtocolFailureError("ACP embedded-resource activity content is malformed.");
      }
      const resource = value.resource;
      if (Object.hasOwn(resource, "text")) {
        if (!onlyKeys(resource, ["text", "uri", "mimeType", "_meta"]) ||
            !Object.hasOwn(resource, "text") || !boundedAcpText(resource.text, MAX_PROMPT_ACTIVITY_BYTES) ||
            !Object.hasOwn(resource, "uri") || !boundedAcpText(resource.uri, MAX_PROMPT_ACTIVITY_BYTES) ||
            (Object.hasOwn(resource, "mimeType") && !validNullableText(resource.mimeType)) ||
            (Object.hasOwn(resource, "_meta") && !validOptionalJsonMeta(resource._meta))) {
          throw new ProtocolFailureError("ACP text resource activity content is malformed.");
        }
      } else if (Object.hasOwn(resource, "blob")) {
        if (!onlyKeys(resource, ["blob", "uri", "mimeType", "_meta"]) ||
            !Object.hasOwn(resource, "blob") || !boundedAcpText(resource.blob, MAX_PROMPT_ACTIVITY_BYTES) ||
            !Object.hasOwn(resource, "uri") || !boundedAcpText(resource.uri, MAX_PROMPT_ACTIVITY_BYTES) ||
            (Object.hasOwn(resource, "mimeType") && !validNullableText(resource.mimeType)) ||
            (Object.hasOwn(resource, "_meta") && !validOptionalJsonMeta(resource._meta))) {
          throw new ProtocolFailureError("ACP blob resource activity content is malformed.");
        }
      } else {
        throw new ProtocolFailureError("ACP embedded-resource activity content has no supported payload.");
      }
      return;
    }
    default:
      throw new ProtocolFailureError("ACP activity content block has an unsupported type.");
  }
}

function validateAcpToolCallContent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolFailureError("ACP tool-call activity content is malformed.");
  }
  if (value.type === "content") {
    if (!onlyKeys(value, ["type", "content", "_meta"]) || !Object.hasOwn(value, "content")) {
      throw new ProtocolFailureError("ACP tool-call content block is malformed.");
    }
    validateAcpContentBlock(value.content);
  } else if (value.type === "diff") {
    if (!onlyKeys(value, ["type", "path", "oldText", "newText", "_meta"]) ||
        !Object.hasOwn(value, "path") || !boundedAcpText(value.path) ||
        !Object.hasOwn(value, "newText") || !boundedAcpText(value.newText, MAX_PROMPT_ACTIVITY_BYTES) ||
        (Object.hasOwn(value, "oldText") && !validNullableText(value.oldText, MAX_PROMPT_ACTIVITY_BYTES))) {
      throw new ProtocolFailureError("ACP tool-call diff activity is malformed.");
    }
  } else if (value.type === "terminal") {
    if (!onlyKeys(value, ["type", "terminalId", "_meta"]) || !Object.hasOwn(value, "terminalId") ||
        !validAcpIdentifier(value.terminalId)) {
      throw new ProtocolFailureError("ACP tool-call terminal activity is malformed.");
    }
  } else {
    throw new ProtocolFailureError("ACP tool-call activity content has an unsupported type.");
  }
  if (Object.hasOwn(value, "_meta")) validateMeta(value._meta, "tool-call activity content");
}

function validateAcpToolCallLocations(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_PROMPT_ACTIVITY_EVENTS) {
    throw new ProtocolFailureError("ACP tool-call activity locations are malformed or oversized.");
  }
  for (const location of value) {
    if (!isRecord(location) || !onlyKeys(location, ["path", "line", "_meta"]) ||
        !Object.hasOwn(location, "path") || !boundedAcpText(location.path) ||
        (Object.hasOwn(location, "line") && location.line !== null &&
          (!Number.isSafeInteger(location.line) || (location.line as number) < 0 || (location.line as number) > 0xffff_ffff)) ||
        (Object.hasOwn(location, "_meta") && !validOptionalJsonMeta(location._meta))) {
      throw new ProtocolFailureError("ACP tool-call activity location is malformed.");
    }
  }
}

type ValidAcpActivity =
  | { readonly type: "thought" }
  | { readonly type: "tool_call" }
  | { readonly type: "tool_call_update" };

/** The required/optional fields follow ACP v1 ContentChunk, ToolCall, and ToolCallUpdate. */
function validateAcpActivityUpdate(update: Record<string, unknown>): ValidAcpActivity {
  if (update.sessionUpdate === "agent_thought_chunk") {
    if (!onlyKeys(update, ["sessionUpdate", "content", "messageId", "_meta"]) ||
        !Object.hasOwn(update, "content") ||
        (Object.hasOwn(update, "messageId") && !validNullableText(update.messageId, 512))) {
      throw new ProtocolFailureError("ACP thought activity update is malformed.");
    }
    validateAcpContentBlock(update.content);
    return { type: "thought" };
  }

  if (update.sessionUpdate === "tool_call") {
    if (!onlyKeys(update, [
      "sessionUpdate", "toolCallId", "title", "name", "kind", "status", "content", "locations", "rawInput", "rawOutput", "_meta",
    ]) || !Object.hasOwn(update, "toolCallId") || !validAcpIdentifier(update.toolCallId) ||
        !Object.hasOwn(update, "title") || !boundedAcpText(update.title) ||
        (Object.hasOwn(update, "name") && !validNullableText(update.name)) ||
        (Object.hasOwn(update, "kind") && (typeof update.kind !== "string" || !ACP_TOOL_KINDS.has(update.kind))) ||
        (Object.hasOwn(update, "status") && (typeof update.status !== "string" || !ACP_TOOL_STATUSES.has(update.status))) ||
        (Object.hasOwn(update, "rawInput") && !validJsonValue(update.rawInput)) ||
        (Object.hasOwn(update, "rawOutput") && !validJsonValue(update.rawOutput))) {
      throw new ProtocolFailureError("ACP tool-call activity update is malformed.");
    }
    if (Object.hasOwn(update, "content")) {
      if (!Array.isArray(update.content) || update.content.length > MAX_PROMPT_ACTIVITY_EVENTS) {
        throw new ProtocolFailureError("ACP tool-call activity content is malformed or oversized.");
      }
      for (const content of update.content) validateAcpToolCallContent(content);
    }
    if (Object.hasOwn(update, "locations")) validateAcpToolCallLocations(update.locations);
    if (Object.hasOwn(update, "_meta")) validateMeta(update._meta, "tool-call activity");
    return { type: "tool_call" };
  }

  if (update.sessionUpdate === "tool_call_update") {
    if (!onlyKeys(update, [
      "sessionUpdate", "toolCallId", "kind", "status", "title", "name", "content", "locations", "rawInput", "rawOutput", "_meta",
    ]) || !Object.hasOwn(update, "toolCallId") || !validAcpIdentifier(update.toolCallId) ||
        (Object.hasOwn(update, "kind") && update.kind !== null &&
          (typeof update.kind !== "string" || !ACP_TOOL_KINDS.has(update.kind))) ||
        (Object.hasOwn(update, "status") && update.status !== null &&
          (typeof update.status !== "string" || !ACP_TOOL_STATUSES.has(update.status))) ||
        (Object.hasOwn(update, "title") && !validNullableText(update.title)) ||
        (Object.hasOwn(update, "name") && !validNullableText(update.name)) ||
        (Object.hasOwn(update, "rawInput") && !validJsonValue(update.rawInput)) ||
        (Object.hasOwn(update, "rawOutput") && !validJsonValue(update.rawOutput))) {
      throw new ProtocolFailureError("ACP tool-call activity update is malformed.");
    }
    if (Object.hasOwn(update, "content") && update.content !== null) {
      if (!Array.isArray(update.content) || update.content.length > MAX_PROMPT_ACTIVITY_EVENTS) {
        throw new ProtocolFailureError("ACP tool-call activity content update is malformed or oversized.");
      }
      for (const content of update.content) validateAcpToolCallContent(content);
    }
    if (Object.hasOwn(update, "locations") && update.locations !== null) {
      validateAcpToolCallLocations(update.locations);
    }
    if (Object.hasOwn(update, "_meta")) validateMeta(update._meta, "tool-call activity update");
    return { type: "tool_call_update" };
  }

  throw new ProtocolFailureError("ACP activity update is unsupported.");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function";
}

function unsupported(message: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(message);
}

function mapPromptStopReason(value: unknown): "end_turn" | "max_tokens" | "refusal" {
  if (value === "end_turn" || value === "max_tokens" || value === "refusal") return value;
  if (value === "cancelled") throw new RequestAbortedError("The ACP prompt was cancelled.");
  if (value === "max_turn_requests" || value === "stop_sequence" || value === "pause_turn") {
    throw unsupported(`ACP stop reason '${value}' has no equivalent in the supported Messages request subset.`);
  }
  throw new ProtocolFailureError("ACP returned an unknown or malformed prompt stop reason.");
}

function promptAcknowledgement(text: string, response: unknown): SessionDriverAcknowledgement {
  if (!isRecord(response) || !Object.hasOwn(response, "stopReason") ||
      !onlyKeys(response, ["stopReason", "usage", "_meta"])) {
    throw new ProtocolFailureError("ACP session/prompt returned a malformed terminal response.");
  }
  const stopReason = mapPromptStopReason(response.stopReason);
  if (Object.hasOwn(response, "_meta")) validateMeta(response._meta, "prompt response");
  if (Object.hasOwn(response, "usage") && response.usage !== null && !isRecord(response.usage)) {
    throw new ProtocolFailureError("ACP session/prompt returned malformed usage metadata.");
  }
  return Object.freeze({
    stage: "completed",
    output: Object.freeze([Object.freeze({
      role: "assistant" as const,
      content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
    })]) as unknown as SessionTranscript,
    result: Object.freeze({
      stopReason,
      ...(Object.hasOwn(response, "usage") ? { usage: response.usage } : {}),
    }),
  });
}

function toolPromptAcknowledgement(
  text: string,
  hasText: boolean,
  calls: readonly PendingToolCall[],
): SessionDriverAcknowledgement {
  if (calls.length === 0 || calls.length > 128) {
    throw new ProtocolFailureError("The ACP prompt produced an empty or oversized caller-tool batch.");
  }
  const content = [
    ...(hasText ? [Object.freeze({ type: "text" as const, text })] : []),
    ...calls.map((call) => Object.freeze({
      type: "tool_use" as const,
      id: call.callId,
      name: call.name,
      input: call.arguments,
    })),
  ];
  return Object.freeze({
    stage: "awaiting_tools",
    output: Object.freeze([Object.freeze({ role: "assistant" as const, content: Object.freeze(content) })]) as unknown as SessionTranscript,
    result: Object.freeze({ stopReason: "tool_use" }),
  });
}

function validatePendingToolCall(
  value: unknown,
  binding: SessionDriverCallerToolBinding,
): PendingToolCall {
  if (!isRecord(value) || !exactKeys(value, [
    "callId", "requestId", "accountId", "sessionId", "catalogId", "name", "arguments",
  ]) ||
      typeof value.callId !== "string" || !/^toolu_[0-9a-f]{32}$/u.test(value.callId) ||
      !(typeof value.requestId === "string" || (typeof value.requestId === "number" && Number.isFinite(value.requestId))) ||
      value.accountId !== binding.accountId || value.sessionId !== binding.sessionId ||
      value.catalogId !== binding.catalogId || typeof value.name !== "string" || value.name.length === 0 ||
      Buffer.byteLength(value.name, "utf8") > 128 || !validJsonRecord(value.arguments)) {
    throw new ProtocolFailureError("The session engine returned an invalid authoritative MCP call.");
  }
  return value as unknown as PendingToolCall;
}

function validateContinuationResults(
  results: unknown,
  batch: { readonly operationId: string; readonly callIds: readonly string[] },
): void {
  if (!Array.isArray(results) || results.length !== batch.callIds.length) {
    throw new ProtocolFailureError("The ACP continuation does not match the parked MCP result batch.");
  }
  const resultIds = results.map((result) => isRecord(result) ? result.callId : undefined);
  if (resultIds.some((id, index) => id !== batch.callIds[index]) || new Set(resultIds).size !== resultIds.length) {
    throw new ProtocolFailureError("The ACP continuation has mismatched or duplicated MCP result IDs.");
  }
}

class NotificationBuffer implements AsyncIterable<SessionDriverNotification> {
  private readonly values: Array<{ readonly notification: SessionDriverNotification; readonly bytes: number }> = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<SessionDriverNotification>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private bufferedBytes = 0;
  private ended = false;
  private failure: Error | undefined;

  push(notification: SessionDriverNotification): void {
    if (this.ended) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    } catch {
      throw new ProtocolFailureError("ACP notification could not be retained safely.");
    }
    if (this.values.length >= MAX_NOTIFICATION_COUNT || this.bufferedBytes + bytes > MAX_NOTIFICATION_BYTES) {
      throw new ProtocolFailureError("ACP session notification buffer is full.");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: notification });
      return;
    }
    this.values.push({ notification, bytes });
    this.bufferedBytes += bytes;
  }

  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionDriverNotification> {
    return {
      next: () => this.next(),
      return: async () => ({ done: true, value: undefined }),
    };
  }

  private next(): Promise<IteratorResult<SessionDriverNotification>> {
    const entry = this.values.shift();
    if (entry) {
      this.bufferedBytes = Math.max(0, this.bufferedBytes - entry.bytes);
      return Promise.resolve({ done: false, value: entry.notification });
    }
    if (this.ended) {
      return this.failure
        ? Promise.reject(this.failure)
        : Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/** Production factory: only the pinned, reviewed official ACP pairs are accepted. */
export function createAcpSessionDriverFactory(options: AcpSessionDriverFactoryOptions): (context: SessionDriverContext) => Promise<SessionDriver> {
  const permissionCallbackBudget: PermissionCallbackBudget = { active: 0 };
  return (context) => createSessionDriver(context, options, {
    resolveExecutable: (executable, cwd, environment) => assertReviewedAcpPair(executable, cwd, environment),
    modelConfirmationTimeoutMs: DEFAULT_MODEL_CONFIRMATION_TIMEOUT_MS,
    permissionCallbackBudget,
    ...(options.maxTokensPolicy === undefined ? {} : { maxTokensPolicy: options.maxTokensPolicy }),
    permissions: options.permissions,
  });
}

/**
 * Test-only fake ACP seam. This is intentionally not re-exported from the
 * package root and has no capability override: it can never assert token
 * enforcement or make a real ACP executable appear reviewed.
 */
export function createFakeAcpSessionDriverFactory(options: TestFactoryOptions): (context: SessionDriverContext) => Promise<SessionDriver> {
  if (!options || typeof options.processFactory !== "function") {
    throw new InvalidRequestError("The fake ACP test factory requires a processFactory.");
  }
  const permissions = normalizeAcpPermissionPolicy(options.permissions);
  const timeout = options.modelConfirmationTimeoutMs ?? DEFAULT_MODEL_CONFIRMATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new InvalidRequestError("The fake ACP model verification timeout is invalid.");
  }
  const permissionCallbackBudget: PermissionCallbackBudget = { active: 0 };
  return (context) => createSessionDriver(context, options, {
    resolveExecutable: async (executable) => executable,
    modelConfirmationTimeoutMs: timeout,
    permissionCallbackBudget,
    permissions,
  });
}

/**
 * Internal fake-process harness for end-to-end pump tests. It is deliberately
 * absent from package-root exports and SDK configuration and cannot review a
 * real executable. Its optional callback setting exists only to exercise the
 * same one-shot caller-decision path as the SDK configuration.
 */
export function createFakeEnforcingAcpSessionDriverFactory(
  options: TestEnforcingFactoryOptions,
): (context: SessionDriverContext) => Promise<SessionDriver> {
  if (!options || typeof options.processFactory !== "function" || typeof options.enforceMaxTokens !== "function" ||
      Object.keys(options).some((key) => ![
        "executable", "args", "processFactory", "modelConfirmationTimeoutMs", "enforceMaxTokens", "permissions",
      ].includes(key))) {
    throw new InvalidRequestError("The fake enforcing ACP factory requires a processFactory and test enforcer.");
  }
  const permissions = normalizeAcpPermissionPolicy(options.permissions);
  const timeout = options.modelConfirmationTimeoutMs ?? DEFAULT_MODEL_CONFIRMATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new InvalidRequestError("The fake ACP model verification timeout is invalid.");
  }
  const permissionCallbackBudget: PermissionCallbackBudget = { active: 0 };
  return (context) => createSessionDriver(context, options, {
    resolveExecutable: async (executable) => executable,
    modelConfirmationTimeoutMs: timeout,
    permissionCallbackBudget,
    enforceMaxTokens: options.enforceMaxTokens,
    permissions,
  });
}

async function createSessionDriver(
  context: SessionDriverContext,
  options: DriverOptions,
  dependencies: {
    readonly resolveExecutable: (
      executable: string,
      cwd: string | undefined,
      environment: Readonly<Record<string, string>>,
    ) => Promise<string>;
    readonly modelConfirmationTimeoutMs: number;
    readonly permissionCallbackBudget?: PermissionCallbackBudget;
    readonly maxTokensPolicy?: MaxTokensPolicy;
    readonly permissions: AcpPermissionPolicy;
    readonly enforceMaxTokens?: TestEnforcingFactoryOptions["enforceMaxTokens"];
  },
): Promise<SessionDriver> {
  if (!context || !context.profile || context.profile.accountId !== context.accountId ||
      !context.configuration || typeof context.configuration.model !== "string" ||
      typeof context.configuration.cwd !== "string" ||
      (context.maxTokensPolicy !== "strict" && context.maxTokensPolicy !== "allow-unenforced-max-tokens") ||
      (dependencies.maxTokensPolicy !== undefined && context.maxTokensPolicy !== dependencies.maxTokensPolicy)) {
    throw new InvalidRequestError("The ACP session driver context is invalid.");
  }
  if (!dependencies.permissions ||
      (dependencies.permissions.mode !== "auto" && dependencies.permissions.mode !== "deny" &&
        dependencies.permissions.mode !== "callback") ||
      !Number.isSafeInteger(dependencies.permissions.timeoutMs) ||
      dependencies.permissions.timeoutMs < 1 || dependencies.permissions.timeoutMs > MAX_PERMISSION_CALLBACK_TIMEOUT_MS ||
      (dependencies.permissions.mode === "callback" && typeof dependencies.permissions.onRequest !== "function")) {
    throw new InvalidRequestError("The ACP permission policy configuration is invalid.");
  }
  const selectedExecutable = await dependencies.resolveExecutable(
    options.executable,
    context.configuration.cwd,
    context.profile.childEnvironment,
  );
  let guard: NoninteractiveAuthGuard | undefined;
  let connection: AcpConnection | undefined;
  const notificationBuffer = new NotificationBuffer();
  let notificationSequence = 0;
  const modelUpdates = new Map<string, ModelUpdate>();
  const notificationWaiters = new Set<NotificationWaiter>();
  const admissions = new Map<string, TestAdmissionRecord>();
  let isClosed = false;
  let remoteSessionId: string | undefined;
  let selectedModelConfigId: string | undefined;
  let activePromptTurn: ActivePromptTurn | undefined;
  const acpActivityDiagnostics = {
    agentThoughtChunks: 0,
    toolCalls: 0,
    toolCallUpdates: 0,
    capped: false,
  };
  const pendingPermissionDecisions = new Set<PendingPermissionDecision>();
  const permissionCallbackBudget = dependencies.permissionCallbackBudget ?? { active: 0 };
  const preSessionUpdateIds = new Set<string>();
  let preSessionNotificationCount = 0;
  let preSessionNotificationBytes = 0;
  let idleDiscardedUpdateCount = 0;
  let idleDiscardedUpdateBytes = 0;
  let startupPromise: Promise<void> | undefined;
  let boundServer: SessionMcpServer | undefined;
  let boundToolBinding: SessionDriverCallerToolBinding | undefined;
  let closePromise: Promise<void> | undefined;
  const maxTokensOutcome = dependencies.enforceMaxTokens !== undefined
    ? "enforced" as const
    : "not-enforced" as const;

  const abortPermissionDecisions = (turn?: ActivePromptTurn, operationId?: string): void => {
    for (const pending of pendingPermissionDecisions) {
      if ((turn === undefined || pending.turn === turn) &&
          (operationId === undefined || pending.operationId === operationId)) {
        pending.controller.abort();
      }
    }
  };

  const permissionContext = (
    request: ValidPermissionRequest,
    requestId: string | number | null,
    operationId: string,
    signal: AbortSignal,
    knownSecrets: readonly string[],
  ) => Object.freeze({
    accountId: context.accountId,
    sessionId: context.sessionId,
    operationId,
    remoteSessionId: request.sessionId,
    requestId,
    toolCallId: request.toolCallId,
    origin: "unverified" as const,
    details: permissionDetails(request, knownSecrets),
    offeredOptions: Object.freeze(request.options.map(({ optionId, kind }) => Object.freeze({ optionId, kind }))),
    signal,
  });

  const permissionEndpointSecrets = (): readonly string[] => {
    const authorization = boundServer?.headers.authorization;
    if (typeof authorization !== "string" || authorization.length === 0) return Object.freeze([]);
    const token = /^Bearer\s+(.+)$/iu.exec(authorization)?.[1];
    return Object.freeze([authorization, ...(token === undefined ? [] : [token])]);
  };

  const permissionRequestIsCurrent = (
    request: ValidPermissionRequest,
    turn: ActivePromptTurn,
    signal: AbortSignal,
    operationId: string,
  ): boolean => activePromptTurn === turn && !isClosed && !turn.terminalReceived && !signal.aborted &&
    !turn.requestTimedOut &&
    turn.permissionSignal === signal && turn.currentOperationId === operationId &&
    turn.operationIds.has(operationId) && turn.sessionId === request.sessionId &&
    remoteSessionId === request.sessionId && context.accountId.length > 0 && context.sessionId.length > 0;

  const selectPermission = (
    request: ValidPermissionRequest,
    decision: unknown,
  ): string | undefined => {
    try {
      if (!isRecord(decision)) return undefined;
      const ownKeys = Reflect.ownKeys(decision);
      if (ownKeys.some((key) => typeof key !== "string")) return undefined;
      const keys = (ownKeys as string[]).sort();
      const actionDescriptor = Object.getOwnPropertyDescriptor(decision, "action");
      if (!actionDescriptor?.enumerable || !("value" in actionDescriptor)) return undefined;
      const action = actionDescriptor.value;
      if (keys.length === 1 && keys[0] === "action" && action === "deny") return undefined;
      const optionDescriptor = Object.getOwnPropertyDescriptor(decision, "optionId");
      if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "optionId" || action !== "select" ||
          !optionDescriptor?.enumerable || !("value" in optionDescriptor) || !validAcpIdentifier(optionDescriptor.value)) {
        return undefined;
      }
      const optionId = optionDescriptor.value;
      return request.options.some(({ optionId: offeredId, kind }) => offeredId === optionId && kind === "allow_once")
        ? optionId
        : undefined;
    } catch {
      return undefined;
    }
  };

  const requestPermission = async (
    requestId: string | number | null,
    params: unknown,
  ): Promise<unknown> => {
    const request = validatePermissionRequest(params);
    if (!request) return permissionResponse(undefined, false, true);
    if (typeof requestId === "string" && Buffer.byteLength(requestId, "utf8") > 512) {
      return permissionResponse(request.options, false, true);
    }

    const turn = activePromptTurn;
    const signal = turn?.permissionSignal;
    const operationId = turn?.currentOperationId;
    if (!turn || !signal || !operationId ||
        !permissionRequestIsCurrent(request, turn, signal, operationId)) {
      return permissionResponse(request.options, false);
    }

    const permissions = dependencies.permissions;
    if (permissions.mode === "deny") {
      return permissionResponse(request.options, false);
    }

    const callbackMode = permissions.mode === "callback";
    if (callbackMode && permissionCallbackBudget.active >= MAX_CONCURRENT_PERMISSION_CALLBACKS) {
      return permissionResponse(request.options, false);
    }

    // Automatic policy never projects ACP descriptions, MCP authorization
    // values, or any other callback-only context. It also does not consume the
    // per-SDK callback concurrency budget.
    const knownSecrets = callbackMode ? permissionEndpointSecrets() : Object.freeze([]);
    if (callbackMode) {
      const correlationValues = [
        context.accountId,
        context.sessionId,
        operationId,
        request.sessionId,
        request.toolCallId,
        ...(typeof requestId === "string" ? [requestId] : []),
        ...request.options.map(({ optionId }) => optionId),
      ];
      if (knownSecrets.some((secret) => correlationValues.some((value) => value.includes(secret)))) {
        // Correlation values and option IDs must stay exact for the ACP protocol;
        // do not expose a known SDK secret through them to the caller callback.
        return permissionResponse(request.options, false);
      }
    }

    const controller = new AbortController();
    const pending = Object.freeze({ turn, operationId, controller });
    pendingPermissionDecisions.add(pending);
    const abortFromOperation = (): void => controller.abort();
    signal.addEventListener("abort", abortFromOperation, { once: true });
    if (signal.aborted) controller.abort();

    const timeoutMs = permissions.timeoutMs;
    const deadlineAt = performance.now() + timeoutMs;
    let timeoutFired = false;
    const expireIfDeadlinePassed = (): boolean => {
      if (timeoutFired) return true;
      if (performance.now() < deadlineAt) return false;
      timeoutFired = true;
      controller.abort();
      return true;
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadlineCheck = (): void => {
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        expireIfDeadlinePassed();
        return;
      }
      timeout = setTimeout(scheduleDeadlineCheck, Math.max(1, Math.ceil(remaining)));
    };
    scheduleDeadlineCheck();
    let removeCancelListener = (): void => undefined;
    const cancelled = new Promise<"cancelled">((resolve) => {
      const onAbort = (): void => resolve("cancelled");
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeCancelListener = () => controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) onAbort();
    });

    if (callbackMode) permissionCallbackBudget.active += 1;
    let workReleased = false;
    const releaseWork = (): void => {
      if (workReleased) return;
      workReleased = true;
      permissionCallbackBudget.active = Math.max(0, permissionCallbackBudget.active - 1);
    };
    const decisionResult = Promise.resolve().then(async () => {
      if (controller.signal.aborted || expireIfDeadlinePassed()) return undefined;
      if (permissions.mode === "auto") {
        return { mode: "auto" as const };
      }
      const projectedContext = permissionContext(request, requestId, operationId, controller.signal, knownSecrets);
      if (controller.signal.aborted || expireIfDeadlinePassed()) return undefined;
      return { mode: "callback" as const, decision: await permissions.onRequest(projectedContext) };
    });
    if (callbackMode) void decisionResult.then(releaseWork, releaseWork);
    const observedDecision = decisionResult.then(
      (decision) => ({ kind: "decision" as const, decision }),
      () => ({ kind: "error" as const }),
    );

    try {
      const result = await Promise.race([observedDecision, cancelled]);
      // Timer callbacks cannot run while synchronous user code blocks the
      // event loop. The monotonic deadline is authoritative when its promise
      // eventually resumes, regardless of whether setTimeout has fired.
      if (result === "cancelled" || expireIfDeadlinePassed() || controller.signal.aborted ||
          !permissionRequestIsCurrent(request, turn, signal, operationId)) {
        return permissionResponse(request.options, false, true);
      }
      let response: Readonly<Record<string, unknown>>;
      if (result.kind !== "decision" || result.decision === undefined) {
        response = permissionResponse(request.options, false);
      } else if (result.decision.mode === "auto") {
        const selection = automaticPermissionSelection(request);
        response = selection
          ? selectedAllowPermissionResponse(request.options, selection.optionId, selection.kind) ??
            permissionResponse(request.options, false)
          : permissionResponse(request.options, false);
      } else {
        const selectedOptionId = selectPermission(request, result.decision.decision);
        response = selectedOptionId === undefined
          ? permissionResponse(request.options, false)
          : selectedAllowPermissionResponse(request.options, selectedOptionId, "allow_once") ??
            permissionResponse(request.options, false);
      }
      // Recheck after validating the caller's decision. The branded internal
      // response carries this operation/deadline fence to the ACP transport,
      // which revalidates again when the queued response reaches stdin.write.
      if (expireIfDeadlinePassed() || controller.signal.aborted ||
          !permissionRequestIsCurrent(request, turn, signal, operationId)) {
        return permissionResponse(request.options, false, true);
      }
      const cancelledResponse = permissionResponse(request.options, false, true);
      return createGuardedPermissionResponse(response, cancelledResponse, () =>
        !expireIfDeadlinePassed() && !controller.signal.aborted &&
        permissionRequestIsCurrent(request, turn, signal, operationId));
    } catch {
      // Callback payloads and exceptions are deliberately never logged or
      // forwarded to the ACP peer.
      if (expireIfDeadlinePassed() || controller.signal.aborted ||
          !permissionRequestIsCurrent(request, turn, signal, operationId)) {
        return permissionResponse(request.options, false, true);
      }
      return permissionResponse(request.options, false);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeCancelListener();
      signal.removeEventListener("abort", abortFromOperation);
      pendingPermissionDecisions.delete(pending);
    }
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    isClosed = true;
    abortPermissionDecisions();
    const closedError = new SessionNotFoundError("The ACP session driver is closed.");
    notificationBuffer.close();
    for (const waiter of notificationWaiters) waiter.reject(closedError);
    notificationWaiters.clear();
    const closing = (async () => {
      try {
        // Keep the browser blocker installed until the ACP child is closed.
        await activePromptTurn?.cleanup?.();
        await connection?.close();
        await guard?.dispose();
      } catch (error) {
        throw new ProcessFailureError("The ACP session driver could not complete cleanup safely.", {
          cause: error,
        });
      }
    })();
    closePromise = closing;
    void closing.catch(() => {
      if (closePromise === closing) closePromise = undefined;
    });
    return closing;
  };

  const recordAcpActivity = (turn: ActivePromptTurn, update: Record<string, unknown>): void => {
    const activity = validateAcpActivityUpdate(update);
    // ACP activity is strictly observational. The validated payload is measured
    // and discarded. ToolCallUpdate is independently valid ACP activity; the
    // SDK does not require an observed creation event or retain its call ID.
    // Neither activity variant creates or authorizes a caller tool event.
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(update), "utf8");
    } catch {
      throw new ProtocolFailureError("ACP activity update could not be measured within its resource bound.");
    }
    turn.eventCount += 1;
    turn.activityEventCount += 1;
    if (turn.eventCount > MAX_PROMPT_EVENTS || turn.activityEventCount > MAX_PROMPT_ACTIVITY_EVENTS ||
        turn.activityBytes + bytes > MAX_PROMPT_ACTIVITY_BYTES ||
        turn.outputBytes + turn.activityBytes + bytes > MAX_PROMPT_BYTES) {
      throw new ProtocolFailureError("ACP prompt activity exceeded its bounded event or byte limit.");
    }
    turn.activityBytes += bytes;

    const counter = activity.type === "thought"
      ? "agentThoughtChunks"
      : activity.type === "tool_call" ? "toolCalls" : "toolCallUpdates";
    if (acpActivityDiagnostics[counter] >= MAX_ACTIVITY_DIAGNOSTIC_COUNT) {
      acpActivityDiagnostics.capped = true;
    } else {
      acpActivityDiagnostics[counter] += 1;
    }
  };

  const onNotification = (notification: { readonly method: string; readonly params?: unknown }): void => {
    notificationSequence += 1;
    if (notification.method !== "session/update") {
      if (activePromptTurn) {
        throw new ProtocolFailureError("ACP sent an unsupported notification during an owned prompt turn.");
      }
      notificationBuffer.push(notification);
      return;
    }
    if (!isRecord(notification.params) || !onlyKeys(notification.params, ["sessionId", "update", "_meta"]) ||
        !Object.hasOwn(notification.params, "sessionId") || !Object.hasOwn(notification.params, "update") ||
        !validAcpIdentifier(notification.params.sessionId) ||
        !isRecord(notification.params.update) || typeof notification.params.update.sessionUpdate !== "string") {
      throw new ProtocolFailureError("ACP session update notification is malformed.");
    }
    if (Object.hasOwn(notification.params, "_meta")) validateMeta(notification.params._meta, "session/update params");
    const sessionId = notification.params.sessionId;
    const update = notification.params.update;
    if (Object.hasOwn(update, "_meta")) validateMeta(update._meta, "session/update chunk");
    const isDiscardedSessionUpdate = update.sessionUpdate === "available_commands_update" ||
      update.sessionUpdate === "usage_update" || update.sessionUpdate === "plan" ||
      update.sessionUpdate === "plan_update" || update.sessionUpdate === "plan_removed" ||
      update.sessionUpdate === "current_mode_update" || update.sessionUpdate === "session_info_update";
    const discardedUpdateBytes = isDiscardedSessionUpdate ? measureDiscardedSessionUpdate(update) : undefined;
    const configOptionUpdate = update.sessionUpdate === "config_option_update"
      ? validateConfigOptionUpdate(update, selectedModelConfigId)
      : undefined;
    if (remoteSessionId && sessionId !== remoteSessionId) {
      throw new ProtocolFailureError("ACP sent an update for a foreign session.");
    }
    if (!remoteSessionId) {
      const notificationBytes = serializedNotificationBytes(notification);
      if (preSessionNotificationCount + 1 > MAX_PRE_SESSION_NOTIFICATION_COUNT ||
          preSessionNotificationBytes + notificationBytes > MAX_PRE_SESSION_NOTIFICATION_BYTES ||
          (!preSessionUpdateIds.has(sessionId) && preSessionUpdateIds.size >= MAX_PRE_SESSION_NOTIFICATION_COUNT)) {
        throw new ProtocolFailureError("ACP startup notifications exceeded their bounded count or byte capacity.");
      }
      preSessionNotificationCount += 1;
      preSessionNotificationBytes += notificationBytes;
      preSessionUpdateIds.add(sessionId);
    }

    if (activePromptTurn) {
      if (sessionId !== activePromptTurn.sessionId || activePromptTurn.operationId.length === 0) {
        throw new ProtocolFailureError("ACP prompt update does not belong to the current remote session turn.");
      }
    }

    if (configOptionUpdate !== undefined) {
      const selected = configOptionUpdate.selected;
      if (selectedModelConfigId !== undefined &&
          (selected?.configId !== selectedModelConfigId || selected.value !== context.configuration.model)) {
        throw new ProtocolFailureError("ACP changed the model pinned to this session.");
      }
      if (selected) {
        const key = updateKey(sessionId, selected.configId);
        const recorded = Object.freeze({ sequence: notificationSequence, value: selected.value });
        modelUpdates.set(key, recorded);
        for (const waiter of [...notificationWaiters]) {
          if (waiter.sessionId === sessionId && waiter.configId === selected.configId &&
              recorded.sequence > waiter.afterSequence) {
            notificationWaiters.delete(waiter);
            waiter.resolve(recorded);
          }
        }
      }
      if (activePromptTurn) {
        const turn = activePromptTurn;
        turn.eventCount += 1;
        if (turn.eventCount > MAX_PROMPT_EVENTS ||
            turn.outputBytes + turn.activityBytes + configOptionUpdate.bytes > MAX_PROMPT_BYTES) {
          throw new ProtocolFailureError("ACP configuration updates exceeded their bounded prompt event or byte limit.");
        }
        turn.outputBytes += configOptionUpdate.bytes;
      } else if (remoteSessionId) {
        idleDiscardedUpdateCount += 1;
        idleDiscardedUpdateBytes += configOptionUpdate.bytes;
        if (idleDiscardedUpdateCount > MAX_IDLE_DISCARDED_UPDATE_COUNT ||
            idleDiscardedUpdateBytes > MAX_IDLE_DISCARDED_UPDATE_BYTES) {
          throw new ProtocolFailureError("ACP idle session updates exceeded their bounded event or byte limit.");
        }
      }
      notificationBuffer.push(notification);
      return;
    }

    if (activePromptTurn) {
      if (discardedUpdateBytes !== undefined) {
        const turn = activePromptTurn;
        turn.eventCount += 1;
        if (turn.eventCount > MAX_PROMPT_EVENTS ||
            turn.outputBytes + turn.activityBytes + discardedUpdateBytes > MAX_PROMPT_BYTES) {
          throw new ProtocolFailureError("ACP prompt housekeeping updates exceeded their bounded event or byte limit.");
        }
        // The payload was validated and measured above, but deliberately isn't
        // retained, surfaced as an event, or treated as response usage.
        turn.outputBytes += discardedUpdateBytes;
        return;
      }
      if (activePromptTurn.terminalReceived) {
        const error = new ProtocolFailureError("ACP sent a prompt update after the terminal response.");
        activePromptTurn.protocolFailure = error;
        activePromptTurn.events.close(error);
        throw error;
      }
      if (update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update") {
        // These ACP v1 events are bound to this already-verified remote session
        // and active prompt turn, but never have caller-tool authority.
        recordAcpActivity(activePromptTurn, update);
        return;
      }
      if (update.sessionUpdate === "user_message_chunk") {
        throw new ProtocolFailureError("ACP user-message chunks cannot be safely mapped to Messages output.");
      }
      if (update.sessionUpdate !== "agent_message_chunk" ||
          !onlyKeys(update, ["sessionUpdate", "content", "messageId", "_meta"]) ||
          !Object.hasOwn(update, "content") ||
          (Object.hasOwn(update, "messageId") && !validNullableText(update.messageId, 512)) ||
          !isRecord(update.content) || !onlyKeys(update.content, ["type", "text", "annotations", "_meta"]) ||
          !Object.hasOwn(update.content, "type") || !Object.hasOwn(update.content, "text") ||
          update.content.type !== "text" || typeof update.content.text !== "string") {
        throw new ProtocolFailureError("ACP sent an unsupported or malformed update during a text prompt.");
      }
      if (Object.hasOwn(update.content, "annotations")) validateAnnotations(update.content.annotations);
      if (Object.hasOwn(update.content, "_meta")) validateMeta(update.content._meta, "text content");
      activePromptTurn.eventCount += 1;
      const bytes = Buffer.byteLength(update.content.text, "utf8");
      if (activePromptTurn.eventCount > MAX_PROMPT_EVENTS ||
          activePromptTurn.outputBytes + activePromptTurn.activityBytes + bytes > MAX_PROMPT_BYTES) {
        throw new ProtocolFailureError("ACP prompt output exceeded its bounded event or byte limit.");
      }
      activePromptTurn.outputBytes += bytes;
      activePromptTurn.events.push({ type: "text", text: update.content.text });
      return;
    }

    if (discardedUpdateBytes !== undefined) {
      if (remoteSessionId) {
        idleDiscardedUpdateCount += 1;
        idleDiscardedUpdateBytes += discardedUpdateBytes;
        if (idleDiscardedUpdateCount > MAX_IDLE_DISCARDED_UPDATE_COUNT ||
            idleDiscardedUpdateBytes > MAX_IDLE_DISCARDED_UPDATE_BYTES) {
          throw new ProtocolFailureError("ACP idle session housekeeping exceeded its bounded event or byte limit.");
        }
      }
      return;
    }

    if (update.sessionUpdate === "user_message_chunk") {
      throw new ProtocolFailureError("ACP user-message chunks cannot be safely mapped to Messages output.");
    }
    throw new ProtocolFailureError("ACP sent a session update without a current prompt owner.");
  };

  try {
    guard = await createNoninteractiveAuthGuard(context.profile);
    connection = await connectAcp({
      executable: selectedExecutable,
      args: options.args,
      profile: guard.profile,
      cwd: context.configuration.cwd,
      shutdownTimeoutMs: PROMPT_CLEANUP_TIMEOUT_MS,
      ...(options.processFactory === undefined ? {} : { processFactory: options.processFactory }),
      onRequest: ({ id, method, params }) => {
        if (method === "session/request_permission") {
          return requestPermission(id, params);
        }
        throw new AcpMethodNotFoundError();
      },
      onNotification,
      onFailure: (error) => {
        notificationBuffer.close(error);
        if (activePromptTurn) {
          abortPermissionDecisions(activePromptTurn);
          activePromptTurn.protocolFailure ??= error;
          activePromptTurn.events.close(error);
          const turn = activePromptTurn;
          if (boundToolBinding) {
            void boundToolBinding.failTurn(turn.currentOperationId, error).catch(() => undefined);
          }
        }
        for (const waiter of notificationWaiters) waiter.reject(error);
        notificationWaiters.clear();
      },
    });
    const agentCapabilities = connection.initializeResult.agentCapabilities;
    if (agentCapabilities !== undefined && !isRecord(agentCapabilities)) {
      throw new ProtocolFailureError("ACP initialize returned malformed agent capabilities.");
    }

    const driver: SessionDriver = {
      capabilities: Object.freeze({ maxTokens: maxTokensOutcome, streaming: "incremental" as const }),
      acpActivityDiagnostics: () => Object.freeze({ ...acpActivityDiagnostics }),
      notifications: () => notificationBuffer,
      async admitResponse(request) {
        const hasMaxTokens = isRecord(request) && Object.hasOwn(request, "maxTokens");
        if (!isRecord(request) || !exactKeys(request, [
          "kind", "operationId", "accountId", "sessionId", "policy", "signal",
          ...(hasMaxTokens ? ["maxTokens"] : []),
        ]) ||
            (request.kind !== "prompt" && request.kind !== "tool_continuation") ||
            typeof request.operationId !== "string" || request.operationId.length === 0 ||
            request.accountId !== context.accountId || request.sessionId !== context.sessionId ||
            (hasMaxTokens && (!Number.isSafeInteger(request.maxTokens) || (request.maxTokens as number) < 1)) ||
            request.policy !== context.maxTokensPolicy ||
            !isAbortSignal(request.signal)) {
          throw new InvalidRequestError("The ACP response admission request is invalid or belongs to another session.");
        }
        if (request.signal.aborted || isClosed) throw new RequestAbortedError("The ACP response admission was cancelled.");
        if ((context.configuration.tools?.length ?? 0) > 0 && (!boundServer || !boundToolBinding)) {
          throw new InvalidRequestError("Bind this session's MCP server before starting a tool-enabled prompt.");
        }
        const checked = request as unknown as SessionDriverResponseAdmissionRequest;
        const allowed = dependencies.enforceMaxTokens && hasMaxTokens
          ? await dependencies.enforceMaxTokens(checked)
          : true;
        if (request.signal.aborted || isClosed) throw new RequestAbortedError("The ACP response admission was cancelled.");
        if (allowed !== true) throw unsupported("The ACP response admission did not admit this response limit.");
        if (admissions.size >= MAX_NOTIFICATION_COUNT) {
          throw new SessionBusyError("The ACP admission table is full.");
        }
        const grantBase = {
          kind: checked.kind,
          operationId: checked.operationId,
          accountId: checked.accountId,
          sessionId: checked.sessionId,
          policy: checked.policy,
        };
        const requestedOutcome = checked.maxTokens === undefined
          ? "unbounded"
          : maxTokensOutcome === "enforced" ? "enforced" : "ignored";
        const requestedReason = requestedOutcome === "enforced"
          ? "driver-admitted-requested-bound"
          : requestedOutcome === "ignored"
            ? "backend-does-not-enforce-requested-bound"
            : "no-output-token-bound-requested";
        const grant: SessionDriverResponseAdmission = checked.maxTokens === undefined
          ? Object.freeze({
              ...grantBase,
              outcome: "unbounded",
              reason: "no-output-token-bound-requested",
            })
          : requestedOutcome === "enforced"
            ? Object.freeze({
                ...grantBase,
                maxTokens: checked.maxTokens,
                outcome: "enforced",
                reason: "driver-admitted-requested-bound",
              })
            : Object.freeze({
                ...grantBase,
                maxTokens: checked.maxTokens,
                outcome: "ignored",
                reason: "backend-does-not-enforce-requested-bound",
              });
        const key = admissionKey(
          checked.operationId, checked.accountId, checked.sessionId, checked.kind, checked.maxTokens, checked.policy,
        );
        if (admissions.has(key)) throw new SessionBusyError("This ACP response already has a pending admission grant.");
        const onAbort = (): void => {
          admissions.delete(key);
        };
        admissions.set(key, {
          kind: checked.kind,
          operationId: checked.operationId,
          accountId: checked.accountId,
          sessionId: checked.sessionId,
          ...(checked.maxTokens === undefined ? {} : { maxTokens: checked.maxTokens }),
          policy: checked.policy,
          outcome: requestedOutcome,
          reason: requestedReason,
          signal: checked.signal,
          onAbort,
        });
        checked.signal.addEventListener("abort", onAbort, { once: true });
        if (checked.signal.aborted) onAbort();
        return grant;
      },
      async dispatch(operation) {
        let acknowledgement: SessionDriverAcknowledgement | undefined;
        for await (const event of promptEvents(operation)) {
          if (event.type === "complete") acknowledgement = event.acknowledgement;
        }
        if (!acknowledgement) throw new ProtocolFailureError("The ACP prompt ended without a terminal acknowledgement.");
        return acknowledgement;
      },
      async *stream(operation) {
        yield* promptEvents(operation);
      },
      async continueTools(continuation) {
        let acknowledgement: SessionDriverAcknowledgement | undefined;
        for await (const event of continuePromptEvents(continuation)) {
          if (event.type === "complete") acknowledgement = event.acknowledgement;
        }
        if (!acknowledgement) throw new ProtocolFailureError("The ACP continuation ended without a terminal acknowledgement.");
        return acknowledgement;
      },
      async prepareToolContinuation(continuation) {
        preparePromptContinuation(continuation);
      },
      async *streamTools(continuation) {
        yield* continuePromptEvents(continuation);
      },
      async bindCallerTools(server, binding) {
        if ((context.configuration.tools?.length ?? 0) === 0) {
          throw new InvalidRequestError("This ACP session was created without caller tools.");
        }
        if (!isRecord(binding) || binding.accountId !== context.accountId ||
            binding.sessionId !== context.sessionId || typeof binding.catalogId !== "string" ||
            typeof binding.sealBatch !== "function" || typeof binding.failTurn !== "function") {
          throw new InvalidRequestError("The ACP caller-tool authority binding is invalid or belongs to another session.");
        }
        const mcpServer = validateMcpServer(server, context, binding.catalogId);
        if (boundServer && boundServer !== server) {
          throw new InvalidRequestError("The ACP session already has a different caller-tool binding.");
        }
        if ((remoteSessionId || startupPromise) && boundServer !== server) {
          throw new InvalidRequestError("Caller tools cannot be bound after an ACP session started without that server.");
        }
        if (boundServer === server) {
          if (boundToolBinding !== binding) throw new InvalidRequestError("The ACP caller-tool authority binding changed.");
          return;
        }
        boundServer = server;
        boundToolBinding = binding;
        try {
          await startRemoteSession([mcpServer]);
        } catch (error) {
          await close().catch(() => undefined);
          throw error;
        }
      },
      notifyCallerToolCall(call, operationId) {
        const binding = boundToolBinding;
        const turn = activePromptTurn;
        if (!binding || !turn || isClosed || typeof operationId !== "string" || operationId.length === 0) {
          throw new ProtocolFailureError("An MCP tool call arrived without an active session-bound ACP prompt.");
        }
        validatePendingToolCall(call, binding);
        if (turn.terminalReceived) {
          const error = new ProtocolFailureError("An MCP tool call arrived after its ACP prompt completed.");
          turn.protocolFailure ??= error;
          turn.events.close(error);
          throw error;
        }
        turn.operationIds.add(operationId);
        turn.events.push({ type: "tool_call", operationId });
      },
      async cancelCallerToolTurn(operationId) {
        const turn = activePromptTurn;
        if (!turn || typeof operationId !== "string" || operationId.length === 0) return;
        // The owning session engine supplies this ID only after binding this
        // driver's private feed; it can be the reserved next operation for a
        // late MCP request that has not emitted its wake yet.
        await turn.cleanup?.();
        if (activePromptTurn === turn) activePromptTurn = undefined;
      },
      close,
    };

    function consumeAdmission(
      kind: "prompt" | "tool_continuation",
      operationId: string,
      accountId: string,
      sessionId: string,
      maxTokens: number | undefined,
      policy: MaxTokensPolicy,
      signal: AbortSignal,
      admissionValue: unknown,
    ): void {
      const hasMaxTokens = isRecord(admissionValue) && Object.hasOwn(admissionValue, "maxTokens");
      const expectedOutcome = maxTokens === undefined
        ? "unbounded"
        : maxTokensOutcome === "enforced" ? "enforced" : "ignored";
      const expectedReason = expectedOutcome === "enforced"
        ? "driver-admitted-requested-bound"
        : expectedOutcome === "ignored"
          ? "backend-does-not-enforce-requested-bound"
          : "no-output-token-bound-requested";
      if (!isRecord(admissionValue) || !exactKeys(admissionValue, [
        "kind", "operationId", "accountId", "sessionId", "policy", "outcome", "reason",
        ...(hasMaxTokens ? ["maxTokens"] : []),
      ]) || admissionValue.kind !== kind || admissionValue.operationId !== operationId ||
          admissionValue.accountId !== accountId || admissionValue.sessionId !== sessionId ||
          (maxTokens === undefined ? hasMaxTokens : admissionValue.maxTokens !== maxTokens) ||
          admissionValue.policy !== policy || admissionValue.outcome !== expectedOutcome ||
          admissionValue.reason !== expectedReason) {
        throw unsupported("The ACP response has no matching per-response admission grant.");
      }
      const key = admissionKey(operationId, accountId, sessionId, kind, maxTokens, policy);
      const grant = admissions.get(key);
      if (!grant || grant.kind !== kind || grant.operationId !== operationId || grant.accountId !== accountId ||
          grant.sessionId !== sessionId || grant.maxTokens !== maxTokens || grant.policy !== policy ||
          grant.outcome !== expectedOutcome || grant.reason !== expectedReason || grant.signal !== signal) {
        throw unsupported("The ACP response admission grant is missing, mismatched, or already consumed.");
      }
      admissions.delete(key);
      signal.removeEventListener("abort", grant.onAbort);
    }

    function preparePromptContinuation(
      continuation: import("./contracts.js").SessionDriverToolContinuation,
    ): void {
      if (!isRecord(continuation) || !exactKeys(continuation, [
        "operationId", "previousOperationId", "accountId", "sessionId", "configuration",
        "messages", "admission", "results", "signal",
        ...(Object.hasOwn(continuation, "maxTokens") ? ["maxTokens"] : []),
      ]) || continuation.accountId !== context.accountId ||
          continuation.sessionId !== context.sessionId || continuation.configuration !== context.configuration ||
          typeof continuation.operationId !== "string" || continuation.operationId.length === 0 ||
          typeof continuation.previousOperationId !== "string" || !isAbortSignal(continuation.signal) ||
          (Object.hasOwn(continuation, "maxTokens") &&
            (!Number.isSafeInteger(continuation.maxTokens) || (continuation.maxTokens as number) < 1)) ||
          !Array.isArray(continuation.messages) || !Array.isArray(continuation.results)) {
        throw new InvalidRequestError("The ACP tool continuation is malformed or belongs to another session.");
      }
      if (continuation.signal.aborted || isClosed) throw new RequestAbortedError("The ACP tool continuation was cancelled.");
      const turn = activePromptTurn;
      if (!turn || !turn.awaitingContinuation || turn.continuationPrepared || turn.consumerActive ||
          turn.terminalReceived || !turn.lastToolBatch ||
          turn.lastToolBatch.operationId !== continuation.previousOperationId) {
        throw new ProtocolFailureError("The ACP continuation does not own the currently parked prompt turn.");
      }
      validateContinuationResults(continuation.results, turn.lastToolBatch);
      consumeAdmission(
        "tool_continuation", continuation.operationId, continuation.accountId, continuation.sessionId,
        continuation.maxTokens, context.maxTokensPolicy, continuation.signal, continuation.admission,
      );
      // A permission decision belongs only to the operation that created its
      // immutable context. Starting the next continuation revokes any pending
      // decisions from the parked operation before changing ownership.
      abortPermissionDecisions(turn);
      // This is the driver-side state transition that must precede any MCP
      // result release. ACP output can now arrive and remain buffered while
      // the session engine waits for the loopback response finish event.
      turn.operationIds.add(continuation.operationId);
      turn.currentOperationId = continuation.operationId;
      turn.permissionSignal = continuation.signal;
      turn.continuationPrepared = continuation;
      turn.awaitingContinuation = false;
    }

    async function* promptEvents(operation: SessionDriverOperation): AsyncGenerator<SessionDriverStreamEvent> {
      if (!isRecord(operation) || operation.accountId !== context.accountId || operation.sessionId !== context.sessionId ||
          operation.configuration !== context.configuration || typeof operation.operationId !== "string" ||
          operation.operationId.length === 0 || !isAbortSignal(operation.signal) ||
          (Object.hasOwn(operation, "maxTokens") &&
            (!Number.isSafeInteger(operation.maxTokens) || (operation.maxTokens as number) < 1)) ||
          !Array.isArray(operation.acpPrompt) || operation.acpPrompt.length === 0 ||
          operation.acpPrompt.some((block) => !isRecord(block) || !exactKeys(block, ["type", "text"]) ||
            block.type !== "text" || typeof block.text !== "string")) {
        throw new InvalidRequestError("The ACP prompt operation is malformed or belongs to another session.");
      }
      if (operation.signal.aborted) throw new RequestAbortedError("The ACP prompt was cancelled before dispatch.");
      if (activePromptTurn) throw new SessionBusyError("The ACP session already owns an active prompt turn.");
      if ((context.configuration.tools?.length ?? 0) > 0 && (!boundServer || !boundToolBinding)) {
        throw new InvalidRequestError("Bind this session's MCP server before starting a tool-enabled prompt.");
      }
      consumeAdmission(
        "prompt", operation.operationId, operation.accountId, operation.sessionId,
        operation.maxTokens, context.maxTokensPolicy, operation.signal, operation.admission,
      );

      const mcpServer = boundServer && boundToolBinding
        ? validateMcpServer(boundServer, context, boundToolBinding.catalogId)
        : undefined;
      await startRemoteSession(mcpServer ? [mcpServer] : []);
      if (operation.signal.aborted || isClosed) throw new RequestAbortedError("The ACP prompt was cancelled before dispatch.");
      if (!connection || !remoteSessionId) throw new SessionNotFoundError("The ACP remote session is not available.");

      const turn: ActivePromptTurn = {
        operationId: operation.operationId,
        sessionId: remoteSessionId,
        events: new PromptEventBuffer(),
        operationIds: new Set([operation.operationId]),
        consumedBatchOperationIds: new Set(),
        permissionSignal: operation.signal,
        currentOperationId: operation.operationId,
        eventCount: 0,
        outputBytes: 0,
        activityEventCount: 0,
        activityBytes: 0,
        terminalReceived: false,
        requestTimedOut: false,
        consumerActive: false,
        awaitingContinuation: false,
      };
      activePromptTurn = turn;
      const promptPromise = connection.request("session/prompt", {
        sessionId: remoteSessionId,
        prompt: operation.acpPrompt as readonly AcpTextBlock[],
      }, {
        onResponse: () => {
          abortPermissionDecisions(turn);
          turn.terminalReceived = true;
          if (turn.awaitingContinuation && !turn.continuationPrepared) {
            const error = new ProtocolFailureError("ACP completed a prompt while caller MCP results were still parked.");
            turn.protocolFailure ??= error;
            turn.events.close(error);
            if (boundToolBinding) {
              void boundToolBinding.failTurn(turn.currentOperationId, error).catch(() => undefined);
            }
            return;
          }
          turn.events.close();
        },
      }).then((response) => {
        abortPermissionDecisions(turn);
        turn.terminalReceived = true;
        turn.events.close();
        return response;
      }, (error: unknown) => {
        abortPermissionDecisions(turn);
        if (error instanceof RequestTimeoutError) turn.requestTimedOut = true;
        const failure = error instanceof Error ? error : new ProcessFailureError("ACP prompt failed.");
        turn.events.close(failure);
        if (boundToolBinding) {
          void boundToolBinding.failTurn(turn.currentOperationId, failure).catch(() => undefined);
        }
        throw error;
      });
      turn.promptPromise = promptPromise;
      void promptPromise.catch(() => undefined);

      turn.cleanup = (): Promise<void> => {
        if (turn.cleanupPromise) return turn.cleanupPromise;
        abortPermissionDecisions(turn);
        const cleaning = (async () => {
          turn.initialAbortCleanup?.();
          const currentConnection = connection;
          if (!currentConnection) return;
          let forceClose = turn.requestTimedOut;
          if (!turn.terminalReceived) {
            // A parked MCP waiter does not mean this ACP turn has completed.
            // Only cancellation/cleanup sends session/cancel.
            try {
              await currentConnection.notify("session/cancel", { sessionId: turn.sessionId }, {
                timeoutMs: PROMPT_CLEANUP_TIMEOUT_MS,
              });
            } catch {
              forceClose = true;
            }
            if (!turn.requestTimedOut) {
              const pending = turn.promptPromise;
              if (pending) {
                const settled = await settlesWithin(pending, PROMPT_CLEANUP_TIMEOUT_MS);
                if (!settled) forceClose = true;
              } else forceClose = true;
            }
          }
          turn.events.close();
          if (forceClose) {
            isClosed = true;
            await currentConnection.close().catch(() => undefined);
          }
        })();
        turn.cleanupPromise = cleaning;
        return cleaning;
      };

      const onInitialAbort = (): void => {
        void turn.cleanup?.().finally(() => {
          if (activePromptTurn === turn) activePromptTurn = undefined;
        });
      };
      operation.signal.addEventListener("abort", onInitialAbort, { once: true });
      turn.initialAbortCleanup = () => operation.signal.removeEventListener("abort", onInitialAbort);
      yield* consumePromptTurn(turn, operation.operationId, operation.signal);
    }

    async function* continuePromptEvents(
      continuation: import("./contracts.js").SessionDriverToolContinuation,
    ): AsyncGenerator<SessionDriverStreamEvent> {
      const turn = activePromptTurn;
      if (continuation.signal.aborted || isClosed) throw new RequestAbortedError("The ACP tool continuation was cancelled.");
      if (!turn || turn.continuationPrepared !== continuation || turn.awaitingContinuation || turn.consumerActive) {
        throw new ProtocolFailureError("The ACP continuation was not prepared before its MCP results were released.");
      }
      delete turn.continuationPrepared;
      yield* consumePromptTurn(turn, continuation.operationId, continuation.signal);
    }

    async function* consumePromptTurn(
      turn: ActivePromptTurn,
      operationId: string,
      signal: AbortSignal,
    ): AsyncGenerator<SessionDriverStreamEvent> {
      if (turn.consumerActive || !turn.operationIds.has(operationId)) {
        throw new SessionBusyError("The ACP prompt turn already has an event-pump consumer or a foreign operation.");
      }
      turn.consumerActive = true;
      turn.currentOperationId = operationId;
      let fullText = "";
      let hasTextDelta = false;
      let yieldedBoundary = false;
      try {
        while (true) {
          if (signal.aborted) throw new RequestAbortedError("The ACP prompt was cancelled.");
          const next = await turn.events.next(signal);
          if (next.done) {
            const response = await turn.promptPromise;
            if (signal.aborted) throw new RequestAbortedError("The ACP prompt was cancelled.");
            if (turn.protocolFailure) throw turn.protocolFailure;
            if (!hasTextDelta) throw new ProtocolFailureError("ACP completed the prompt without an agent_message_chunk.");
            yield Object.freeze({ type: "complete", acknowledgement: promptAcknowledgement(fullText, response) });
            if (signal.aborted) throw new RequestAbortedError("The ACP prompt was cancelled before stream completion.");
            if (turn.protocolFailure) throw turn.protocolFailure;
            return;
          }
          if (next.value.type === "text") {
            hasTextDelta = true;
            fullText += next.value.text;
            yield Object.freeze({ type: "text", text: next.value.text });
            continue;
          }
          if (turn.consumedBatchOperationIds.has(next.value.operationId)) continue;
          if (next.value.operationId !== operationId) {
            throw new ProtocolFailureError("An authoritative MCP call belongs to another ACP response operation.");
          }
          if (turn.terminalReceived || !boundToolBinding) {
            throw new ProtocolFailureError("The ACP prompt cannot park an MCP call after terminal completion.");
          }
          // Let already-readable concurrent loopback requests finish schema
          // validation and durable receipt publication before the engine's
          // synchronous batch cutoff. Requests accepted later belong to the
          // reserved next operation; no name/argument matching is involved.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (signal.aborted) throw new RequestAbortedError("The ACP prompt was cancelled while coalescing caller tools.");
          const rawCalls = await boundToolBinding.sealBatch(operationId);
          if (signal.aborted || turn.terminalReceived) throw new RequestAbortedError("The ACP prompt was cancelled while parking caller tools.");
          if (!Array.isArray(rawCalls) || rawCalls.length === 0 || rawCalls.length > 128) {
            throw new ProtocolFailureError("The session engine returned an empty or oversized MCP batch.");
          }
          const calls = rawCalls.map((call) => validatePendingToolCall(call, boundToolBinding!));
          const callIds = calls.map(({ callId }) => callId);
          if (new Set(callIds).size !== callIds.length) {
            throw new ProtocolFailureError("The session engine returned duplicate MCP call IDs.");
          }
          turn.consumedBatchOperationIds.add(operationId);
          turn.lastToolBatch = Object.freeze({ operationId, callIds: Object.freeze(callIds) });
          turn.awaitingContinuation = true;
          yieldedBoundary = true;
          yield Object.freeze({
            type: "complete",
            acknowledgement: toolPromptAcknowledgement(fullText, hasTextDelta, calls),
          });
          return;
        }
      } finally {
        turn.consumerActive = false;
        if (!yieldedBoundary) {
          if (!turn.terminalReceived || turn.requestTimedOut) await turn.cleanup?.();
          turn.initialAbortCleanup?.();
          if (activePromptTurn === turn) activePromptTurn = undefined;
        }
      }
    }

    const startRemoteSession = (mcpServers: readonly Record<string, unknown>[]): Promise<void> => {
      if ((context.configuration.tools?.length ?? 0) > 0) {
        if (!boundServer || !boundToolBinding || mcpServers.length !== 1) {
          return Promise.reject(new InvalidRequestError("A tool-enabled ACP session requires its bound MCP server at creation."));
        }
        const expected = validateMcpServer(boundServer, context, boundToolBinding.catalogId);
        if (JSON.stringify(mcpServers[0]) !== JSON.stringify(expected)) {
          return Promise.reject(new InvalidRequestError("The ACP session/new MCP server does not match its bound session endpoint."));
        }
      } else if (mcpServers.length !== 0) {
        return Promise.reject(new InvalidRequestError("An ACP session without caller tools cannot register an MCP server."));
      }
      if (startupPromise) return startupPromise;
      if (isClosed || !connection) return Promise.reject(new SessionNotFoundError("The ACP connection is closed."));
      if (remoteSessionId) return Promise.resolve();
      const starting = (async () => {
        const created = await connection!.request("session/new", {
          cwd: context.configuration.cwd,
          mcpServers,
          _meta: { agy: { enabledTools: [] } },
        });
        if (!isRecord(created) || !validAcpIdentifier(created.sessionId)) {
          throw new ProtocolFailureError("ACP session/new returned an invalid session identifier.");
        }
        remoteSessionId = created.sessionId;
        if ([...preSessionUpdateIds].some((sessionId) => sessionId !== remoteSessionId)) {
          throw new ProtocolFailureError("ACP sent an update for a foreign session during startup.");
        }
        preSessionUpdateIds.clear();
        const selector = findModelSelector(created);
        selectedModelConfigId = selector.id;
        const options = modelOptions(selector);
        if (!options.includes(context.configuration.model)) {
          throw unsupported("The requested model is not advertised by this ACP session.");
        }
        const updateSequenceBeforeSet = notificationSequence;
        const response = await connection!.request("session/set_config_option", {
          sessionId: remoteSessionId,
          configId: selector.id,
          value: context.configuration.model,
        });
        const responseValue = selectedModelFrom(response, selector.id);
        if (responseValue !== undefined && responseValue !== context.configuration.model) {
          throw new ProtocolFailureError("ACP did not confirm the requested model selection.");
        }
        if (responseValue === undefined) {
          const update = await waitForModelUpdate(
            remoteSessionId,
            selector.id,
            updateSequenceBeforeSet,
            dependencies.modelConfirmationTimeoutMs,
          );
          if (update.value !== context.configuration.model) {
            throw new ProtocolFailureError("ACP did not confirm the requested model selection.");
          }
        }
      })();
      startupPromise = starting;
      void starting.catch(() => {
        if (startupPromise === starting) startupPromise = undefined;
      });
      return starting;
    };

    function waitForModelUpdate(
      sessionId: string,
      configId: string,
      afterSequence: number,
      timeoutMs: number,
    ): Promise<ModelUpdate> {
      const latest = modelUpdates.get(updateKey(sessionId, configId));
      if (latest && latest.sequence > afterSequence) return Promise.resolve(latest);
      if (isClosed) return Promise.reject(new SessionNotFoundError("The ACP session driver is closed."));
      return new Promise((resolve, reject) => {
        let settled = false;
        const waiter: NotificationWaiter = { sessionId, configId, afterSequence, resolve: finish, reject: fail };
        const timer = setTimeout(() => fail(new RequestTimeoutError("ACP did not confirm the requested model.")), timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          notificationWaiters.delete(waiter);
        };
        function finish(update: ModelUpdate): void {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(update);
        }
        function fail(error: Error): void {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
        notificationWaiters.add(waiter);
      });
    }

    if ((context.configuration.tools?.length ?? 0) === 0) {
      try {
        await startRemoteSession([]);
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    }
    return driver;
  } catch (error) {
    notificationBuffer.close(error instanceof Error ? error : undefined);
    try {
      // connectAcp closes its own child before rejecting initialization. Once
      // a connection is returned, preserve the blocker until close completes.
      await connection?.close();
      await guard?.dispose();
    } catch {
      throw new ProcessFailureError("ACP session startup failed and cleanup could not complete safely.", {
        cause: error,
      });
    }
    throw error;
  }
}

function updateKey(sessionId: string, configId: string): string {
  return `${sessionId}\0${configId}`;
}

function admissionKey(
  operationId: string,
  accountId: string,
  sessionId: string,
  kind: "prompt" | "tool_continuation",
  maxTokens: number | undefined,
  policy: MaxTokensPolicy,
): string {
  return `${accountId}\0${sessionId}\0${operationId}\0${kind}\0${maxTokens}\0${policy}`;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function findModelSelector(created: Record<string, unknown>): { readonly id: string; readonly options: readonly unknown[] } {
  if (!Array.isArray(created.configOptions)) {
    throw unsupported("The ACP session does not advertise model configuration options.");
  }
  const candidates = created.configOptions.filter((option) => isRecord(option) &&
    (option.category === "model" || option.id === "model"));
  if (candidates.length !== 1 || !isRecord(candidates[0]) || typeof candidates[0].id !== "string" ||
      candidates[0].id.length === 0 || !Array.isArray(candidates[0].options)) {
    throw unsupported("The ACP session model selector is missing or unverifiable.");
  }
  return { id: candidates[0].id, options: candidates[0].options };
}

function modelOptions(selector: { readonly options: readonly unknown[] }): readonly string[] {
  return extractAcpAdvertisedModels([{
    id: "model",
    category: "model",
    options: selector.options,
  }]).map(({ id }) => id);
}

function selectedModelFrom(response: unknown, configId: string): string | undefined {
  if (!isRecord(response)) return undefined;
  if (Array.isArray(response.configOptions)) {
    const matching = response.configOptions.filter((option) => isRecord(option) && option.id === configId);
    if (matching.length > 1) throw new ProtocolFailureError("ACP returned duplicate model configuration entries.");
    if (matching.length === 1 && isRecord(matching[0])) {
      return typeof matching[0].currentValue === "string" ? matching[0].currentValue : undefined;
    }
  }
  if (response.configId === configId) {
    if (typeof response.value === "string") return response.value;
    if (typeof response.currentValue === "string") return response.currentValue;
  }
  if (isRecord(response.models) && typeof response.models.currentModelId === "string") {
    return response.models.currentModelId;
  }
  return undefined;
}

function validateMcpServer(
  server: SessionMcpServer,
  context: SessionDriverContext,
  catalogId: string,
): Readonly<Record<string, unknown>> {
  if (!server || typeof server !== "object" || server.accountId !== context.accountId ||
      server.sessionId !== context.sessionId || server.catalogId !== catalogId ||
      typeof server.url !== "string" || !isRecord(server.headers) || typeof server.close !== "function") {
    throw new InvalidRequestError("The ACP caller-tool binding is invalid or belongs to another session.");
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new InvalidRequestError("The ACP caller-tool endpoint is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" ||
      url.username || url.password || url.search || url.hash || !/^\d+$/u.test(url.port)) {
    throw new InvalidRequestError("The ACP caller-tool endpoint must be a session-bound loopback MCP server.");
  }
  const headerEntries = Object.entries(server.headers);
  const expectedHeaderNames = [
    "authorization",
    "x-antigravity-account-id",
    "x-antigravity-session-id",
    "x-antigravity-tool-catalog",
  ];
  if (headerEntries.length !== expectedHeaderNames.length ||
      headerEntries.some(([name, value]) => !expectedHeaderNames.includes(name) ||
        typeof value !== "string" || value.length === 0 || value.includes("\0")) ||
      typeof server.headers.authorization !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{43}$/u.test(server.headers.authorization) ||
      server.headers["x-antigravity-account-id"] !== context.accountId ||
      server.headers["x-antigravity-session-id"] !== context.sessionId ||
      server.headers["x-antigravity-tool-catalog"] !== catalogId ||
      !/^sha256-[0-9a-f]{64}$/u.test(catalogId)) {
    throw new InvalidRequestError("The ACP caller-tool server headers are invalid.");
  }
  const headers = headerEntries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => Object.freeze({ name, value }));
  return Object.freeze({ type: "http", name: MCP_SERVER_NAME, url: server.url, headers: Object.freeze(headers) });
}
