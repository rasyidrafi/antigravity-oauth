import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AuthenticationError,
  AccountNotFoundError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  ProviderError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  SessionInterruptedError,
  SessionNotFoundError,
  UnsupportedFeatureError,
  isAnthropicAPIError,
} from "./errors.js";
import { createSessionToolRegistry, sessionMcpToolResultResponseBytes } from "./mcp-tools.js";
import { compileCallerToolCatalog, validateCallerToolArguments } from "./tool-schema.js";
import { SessionToolReceiptStore, readToolRecoveryDiagnostics } from "./tool-receipts.js";
import {
  createSessionMessages,
  mapMessagesToAcpPrompt,
  normalizeMessagesAcknowledgement,
  validateTextMessagesTranscript,
  type NormalizedMessagesAcknowledgement,
} from "./messages.js";
import {
  type ProfileRuntimeManager,
  type ProfileRuntimeWorkerLease,
} from "./auth.js";
import type {
  AccountProfileRegistry,
  ProfileContext,
} from "./profiles.js";
import type {
  AcpActivityDiagnostics,
  ProfileSessionEngine,
  ProfileSessionEngineOptions,
  SessionConfiguration,
  SessionConfigurationAssertion,
  SessionCreateOptions,
  SessionDiagnostics,
  SessionDiagnosticsSnapshot,
  SessionDriver,
  SessionDriverAcknowledgement,
  SessionDriverCapabilities,
  SessionDriverContext,
  SessionDriverOperation,
  SessionDriverResponseAdmission,
  SessionDriverResponseAdmissionRequest,
  SessionDriverToolContinuation,
  SessionDriverCallerToolBinding,
  SessionDriverToolResult,
  SessionDriverStreamEvent,
  SessionLedger,
  SessionLedgerMessageOptions,
  SessionLedgerOperationOptions,
  SessionLedgerReceipt,
  SessionLedgerRequest,
  SessionLedgerSnapshot,
  SessionMessages,
  SessionMessageSemanticEvent,
  SessionState,
  SessionTranscript,
  Session,
  SessionToolRegistry,
  SessionToolCallReceipt,
  SessionMcpToolResult,
  SessionMcpServer,
  SessionMcpDeliveryOutcome,
  SessionMcpToolCallOptions,
  PendingToolCall,
  MaxTokensEnforcementDiagnostic,
  MaxTokensPolicy,
  UsageProvenance,
} from "./contracts.js";

const SESSION_ID_PREFIX = "sess_";
const OPERATION_ID_PREFIX = "op_";
const CONFIGURATION_KEYS = new Set(["model", "cwd", "system", "tools"]);
const MAX_STREAM_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_EVENTS = 65_536;
const DEFAULT_STREAM_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TOOL_CALLS_PER_SESSION = 1_024;
const MAX_TOOL_CALLS_PER_BATCH = 128;
const MAX_TOOL_RESULT_BYTES = 1_048_576;
const MAX_ACP_ACTIVITY_DIAGNOSTIC_COUNT = 65_536;
const ACCOUNT_BOUND_SESSIONS = new WeakSet<object>();

/** Internal runtime brand used by optional protocol adapters. */
export function isAccountBoundSession(value: unknown): value is Session {
  return typeof value === "object" && value !== null && ACCOUNT_BOUND_SESSIONS.has(value);
}

type JsonRecord = Record<string, unknown>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface ParkedMcpCall {
  readonly call: PendingToolCall;
  readonly operationId: string;
  readonly deferred: Deferred<SessionMcpToolResult>;
  readonly delivery: Deferred<SessionMcpDeliveryOutcome>;
  readonly ready: Promise<void>;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
  readonly onAbort: () => void;
  settled: boolean;
  deliveryOutcome?: SessionMcpDeliveryOutcome;
  cancelTask?: Promise<void>;
}

interface ParkedToolBatch {
  readonly operationId: string;
  readonly callIds: readonly string[];
}

interface AcceptedToolBatch {
  readonly batch: ParkedToolBatch;
  readonly messages: SessionTranscript;
  readonly results: readonly SessionDriverToolResult[];
}

type SessionDriverToolContinuationPlan = Omit<SessionDriverToolContinuation, "admission">;

function invalidRequest(message = "The session configuration or transcript is invalid."): InvalidRequestError {
  return new InvalidRequestError(message);
}

function invalidWorkerResult(): ProtocolFailureError {
  return new ProtocolFailureError("The session worker returned an invalid acknowledgement.");
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
}

function boundedWait<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function boundedWaitUntil<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new RequestTimeoutError(message));
  return boundedWait(promise, remaining, message);
}

function streamCleanupTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_STREAM_CLEANUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_DELAY_MS) {
    throw new InvalidRequestError("streamCleanupTimeoutMs must be a positive integer within its supported bound.");
  }
  return timeout;
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") throw new Error("not-json");
  if (ancestors.has(value)) throw new Error("cyclic-json");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) {
          throw new Error("invalid-array-key");
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index >= value.length) throw new Error("invalid-array-index");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("sparse-or-accessor-array");
        }
        copy.push(cloneJsonValue(descriptor.value, ancestors));
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-record-json");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error("symbol-json-key");
    const copy: JsonRecord = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("non-data-json-property");
      }
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

function cloneJson<T>(value: T, makeError: () => Error): T {
  try {
    return cloneJsonValue(value, new Set()) as T;
  } catch {
    throw makeError();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T, makeError: () => Error): T {
  return deepFreeze(cloneJson(value, makeError));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function exactKeys(record: JsonRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function validateAcpActivityDiagnostics(value: unknown): AcpActivityDiagnostics {
  if (!isRecord(value) || !exactKeys(value, ["agentThoughtChunks", "toolCalls", "toolCallUpdates", "capped"]) ||
      typeof value.agentThoughtChunks !== "number" || typeof value.toolCalls !== "number" ||
      typeof value.toolCallUpdates !== "number" ||
      !Number.isSafeInteger(value.agentThoughtChunks) || value.agentThoughtChunks < 0 ||
      value.agentThoughtChunks > MAX_ACP_ACTIVITY_DIAGNOSTIC_COUNT ||
      !Number.isSafeInteger(value.toolCalls) || value.toolCalls < 0 ||
      value.toolCalls > MAX_ACP_ACTIVITY_DIAGNOSTIC_COUNT ||
      !Number.isSafeInteger(value.toolCallUpdates) || value.toolCallUpdates < 0 ||
      value.toolCallUpdates > MAX_ACP_ACTIVITY_DIAGNOSTIC_COUNT || typeof value.capped !== "boolean") {
    throw new ProtocolFailureError("The session worker returned invalid ACP activity diagnostics.");
  }
  return Object.freeze({
    agentThoughtChunks: value.agentThoughtChunks as number,
    toolCalls: value.toolCalls as number,
    toolCallUpdates: value.toolCallUpdates as number,
    capped: value.capped,
  });
}

function containsToolResult(messages: SessionTranscript): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((block) =>
    isRecord(block) && block.type === "tool_result"));
}

function validateConfiguration(input: unknown): SessionConfiguration {
  const cloned = cloneJson(input, invalidRequest);
  if (!isRecord(cloned)) throw invalidRequest();
  const allowed = new Set(CONFIGURATION_KEYS);
  if (Object.keys(cloned).some((key) => !allowed.has(key))) throw invalidRequest();
  if (
    typeof cloned.model !== "string" ||
    cloned.model.length === 0 ||
    cloned.model.includes("\0") ||
    typeof cloned.cwd !== "string" ||
    cloned.cwd.length === 0 ||
    cloned.cwd.includes("\0")
  ) {
    throw invalidRequest();
  }
  if (hasOwn(cloned, "system") && typeof cloned.system !== "string" && !Array.isArray(cloned.system)) {
    throw invalidRequest();
  }
  if (
    hasOwn(cloned, "tools") &&
    (!Array.isArray(cloned.tools) || cloned.tools.some((tool) => !isRecord(tool)))
  ) {
    throw invalidRequest();
  }
  return deepFreeze(cloned) as unknown as SessionConfiguration;
}

function validateConfigurationAssertion(
  input: SessionConfigurationAssertion | undefined,
  pinned: SessionConfiguration,
): void {
  if (input === undefined) return;
  const cloned = cloneJson(input, invalidRequest);
  if (!isRecord(cloned) || Object.keys(cloned).some((key) => !CONFIGURATION_KEYS.has(key))) {
    throw invalidRequest();
  }
  if (hasOwn(cloned, "model") && (typeof cloned.model !== "string" || cloned.model.includes("\0"))) {
    throw invalidRequest();
  }
  if (hasOwn(cloned, "cwd") && (typeof cloned.cwd !== "string" || cloned.cwd.includes("\0"))) {
    throw invalidRequest();
  }
  if (hasOwn(cloned, "system") && typeof cloned.system !== "string" && !Array.isArray(cloned.system)) {
    throw invalidRequest();
  }
  if (
    hasOwn(cloned, "tools") &&
    (!Array.isArray(cloned.tools) || cloned.tools.some((tool) => !isRecord(tool)))
  ) {
    throw invalidRequest();
  }
  for (const key of Object.keys(cloned)) {
    const pinnedHasKey = hasOwn(pinned, key);
    if (
      !pinnedHasKey ||
      !jsonEqual((cloned as JsonRecord)[key], (pinned as unknown as JsonRecord)[key])
    ) {
      throw invalidRequest();
    }
  }
}

function validateTranscript(input: unknown, makeError: () => Error): SessionTranscript {
  const cloned = cloneJson(input, makeError);
  if (!Array.isArray(cloned)) throw makeError();
  for (const message of cloned) {
    if (
      !isRecord(message) ||
      !exactKeys(message, ["role", "content"]) ||
      (message.role !== "user" && message.role !== "assistant") ||
      (typeof message.content !== "string" && !Array.isArray(message.content))
    ) {
      throw makeError();
    }
  }
  return deepFreeze(cloned) as unknown as SessionTranscript;
}

function validateWorkerAcknowledgement(input: unknown): SessionDriverAcknowledgement {
  const cloned = cloneJson(input, invalidWorkerResult);
  if (
    !isRecord(cloned) ||
    !["completed", "awaiting_tools"].includes(String(cloned.stage)) ||
    !hasOwn(cloned, "output") ||
    Object.keys(cloned).some((key) => !["stage", "output", "result"].includes(key))
  ) {
    throw invalidWorkerResult();
  }
  const output = validateTranscript(cloned.output, invalidWorkerResult);
  if (output.length === 0 || output.some((message) => message.role !== "assistant")) {
    throw invalidWorkerResult();
  }
  const acknowledgement: {
    stage: "completed" | "awaiting_tools";
    output: SessionTranscript;
    result?: unknown;
  } = {
    stage: cloned.stage as "completed" | "awaiting_tools",
    output,
  };
  if (hasOwn(cloned, "result")) acknowledgement.result = deepFreeze(cloned.result);
  return Object.freeze(acknowledgement);
}

function validateDriverCapabilities(input: unknown): SessionDriverCapabilities {
  if (input === undefined) return Object.freeze({});
  const cloned = cloneJson(input, invalidWorkerResult);
  if (
    !isRecord(cloned) || Object.keys(cloned).some((key) => !["maxTokens", "streaming"].includes(key)) ||
    (hasOwn(cloned, "maxTokens") && cloned.maxTokens !== "enforced" && cloned.maxTokens !== "not-enforced") ||
    (hasOwn(cloned, "streaming") && cloned.streaming !== "incremental")
  ) throw invalidWorkerResult();
  return Object.freeze({
    ...(hasOwn(cloned, "maxTokens") ? { maxTokens: cloned.maxTokens as "enforced" | "not-enforced" } : {}),
    ...(hasOwn(cloned, "streaming") ? { streaming: "incremental" as const } : {}),
  });
}

function validateDriverStreamEvent(input: unknown): SessionDriverStreamEvent {
  const cloned = cloneJson(input, invalidWorkerResult);
  if (!isRecord(cloned) || typeof cloned.type !== "string") throw invalidWorkerResult();
  if (cloned.type === "text") {
    if (!exactKeys(cloned, ["type", "text"]) || typeof cloned.text !== "string") throw invalidWorkerResult();
    return Object.freeze({ type: "text", text: cloned.text });
  }
  if (cloned.type === "complete" && exactKeys(cloned, ["type", "acknowledgement"])) {
    return Object.freeze({
      type: "complete",
      acknowledgement: validateWorkerAcknowledgement(cloned.acknowledgement),
    });
  }
  throw invalidWorkerResult();
}

function aborted(): RequestAbortedError {
  return new RequestAbortedError("The session operation was aborted.");
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => rejectPromise(aborted()));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error: unknown) => finish(() => rejectPromise(error)),
    );
  });
}

function validateAdmissionGrant(
  input: unknown,
  request: SessionDriverResponseAdmissionRequest,
  expectedOutcome: MaxTokensEnforcementDiagnostic["outcome"],
): SessionDriverResponseAdmission {
  const cloned = cloneJson(input, invalidWorkerResult);
  if (!isRecord(cloned)) throw invalidWorkerResult();
  const identityMatches = cloned.kind === request.kind && cloned.operationId === request.operationId &&
    cloned.accountId === request.accountId && cloned.sessionId === request.sessionId &&
    cloned.maxTokens === request.maxTokens;
  const expectedReason = expectedOutcome === "enforced"
    ? "driver-admitted-requested-bound"
    : "backend-does-not-enforce-requested-bound";
  const exactGrant = exactKeys(cloned, [
    "kind", "operationId", "accountId", "sessionId", "maxTokens", "policy", "outcome", "reason",
  ]);
  if (!identityMatches || !exactGrant || cloned.policy !== request.policy ||
      cloned.outcome !== expectedOutcome || cloned.reason !== expectedReason) {
    throw invalidWorkerResult();
  }
  const base = {
    kind: request.kind,
    operationId: request.operationId,
    accountId: request.accountId,
    sessionId: request.sessionId,
    maxTokens: request.maxTokens,
    policy: request.policy,
  };
  return expectedOutcome === "enforced"
    ? Object.freeze({ ...base, outcome: "enforced" as const, reason: "driver-admitted-requested-bound" as const })
    : Object.freeze({ ...base, outcome: "not-enforced" as const, reason: "backend-does-not-enforce-requested-bound" as const });
}

function enforcementDiagnostic(
  admission: SessionDriverResponseAdmission,
): MaxTokensEnforcementDiagnostic {
  const base = {
    accountId: admission.accountId,
    sessionId: admission.sessionId,
    operationId: admission.operationId,
    kind: admission.kind,
    requestedMaxTokens: admission.maxTokens,
    policy: admission.policy,
  };
  return admission.outcome === "enforced"
    ? Object.freeze({ ...base, outcome: "enforced" as const, reason: "driver-admitted-requested-bound" as const })
    : Object.freeze({ ...base, outcome: "not-enforced" as const, reason: "backend-does-not-enforce-requested-bound" as const });
}

function rejectUnenforcedMaxTokensStop(
  acknowledgement: SessionDriverAcknowledgement,
  admission: SessionDriverResponseAdmission,
): void {
  if (admission.outcome === "not-enforced" && isRecord(acknowledgement.result) &&
      acknowledgement.result.stopReason === "max_tokens") {
    throw new UnsupportedFeatureError(
      "The ACP max_tokens stop reason cannot be attributed to the requested bound when that bound was not enforced.",
    );
  }
}

function normalizeWorkerError(error: unknown): Error {
  if (isAnthropicAPIError(error)) return error;
  if (
    error instanceof AuthenticationError ||
    error instanceof RequestAbortedError ||
    error instanceof RequestTimeoutError ||
    error instanceof SessionBusyError ||
    error instanceof SessionInterruptedError ||
    error instanceof SessionNotFoundError ||
    error instanceof InvalidRequestError ||
    error instanceof UnsupportedFeatureError ||
    error instanceof ProcessFailureError ||
    error instanceof ProtocolFailureError ||
    error instanceof ProviderError ||
    error instanceof InternalError
  ) {
    return error;
  }
  return new ProcessFailureError("The session worker failed before acknowledging completion.");
}

function validateSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
  ) {
    throw invalidRequest();
  }
}

class SessionLedgerImpl implements SessionLedger {
  #maxTokensPolicy: MaxTokensPolicy;
  private readonly accountIdValue: string;
  private readonly sessionIdValue: string;
  private readonly configurationValue: SessionConfiguration;
  private readonly pendingStreamCleanups = new Set<Promise<void>>();

  private stateValue: SessionState = "idle";
  private transcriptValue: SessionTranscript = Object.freeze([]);
  private revisionValue = 0;
  private activeOperationIdValue: string | undefined;
  private activeController: AbortController | undefined;
  private activePromise: Promise<SessionLedgerReceipt> | undefined;
  private driver: SessionDriver | undefined;
  private driverSetupErrorValue: Error | undefined;
  private driverCapabilitiesValue: SessionDriverCapabilities = Object.freeze({});
  private usageValue: UsageProvenance = Object.freeze({
    kind: "unknown",
    reason: "No completed Messages operation has reported per-operation usage.",
  });
  private contextOccupancyValue: SessionDiagnosticsSnapshot["contextOccupancy"];
  private maxTokensEnforcementValue: MaxTokensEnforcementDiagnostic | undefined;
  private lease: ProfileRuntimeWorkerLease<SessionDriver> | undefined;
  private driverClosePromise: Promise<void> | undefined;
  private driverCloseRawPromise: Promise<void> | undefined;
  private driverClosed = false;
  private closePromise: Promise<void> | undefined;
  private readonly managedToolRegistry: ReturnType<typeof createSessionToolRegistry>;
  private readonly toolCatalog: ReturnType<typeof compileCallerToolCatalog>;
  private readonly toolReceiptStore: SessionToolReceiptStore;
  private receipts: readonly SessionToolCallReceipt[] = Object.freeze([]);
  private receiptQueue: Promise<void> = Promise.resolve();
  private readonly parkedMcpCalls = new Map<string, ParkedMcpCall>();
  private activeToolOperation: Pick<SessionDriverOperation, "operationId" | "signal"> | undefined;
  private toolAdmissionMode: "closed" | "collecting" | "next" = "closed";
  private nextToolOperationId: string | undefined;
  private parkedToolBatch: ParkedToolBatch | undefined;
  private authoritativeMcpCallCorrelation = false;

  readonly messages: SessionMessages;
  readonly diagnostics: SessionDiagnostics;
  readonly tools: SessionToolRegistry;

  readonly managedWorker: SessionDriver = Object.freeze({
    dispatch: (operation: SessionDriverOperation) => this.dispatch(operation),
    stream: (operation: SessionDriverOperation) => this.stream(operation),
    close: () => this.closeFromRuntimeManager(),
  });

  constructor(
    accountId: string,
    sessionId: string,
    configuration: SessionConfiguration,
    toolCatalog: ReturnType<typeof compileCallerToolCatalog>,
    maxTokensPolicy: MaxTokensPolicy,
    profileRoot: string,
    private readonly streamCleanupTimeoutMs: number,
    private readonly onCleanupComplete: () => void,
  ) {
    this.accountIdValue = accountId;
    this.sessionIdValue = sessionId;
    this.configurationValue = configuration;
    this.toolCatalog = toolCatalog;
    this.#maxTokensPolicy = maxTokensPolicy;
    this.toolReceiptStore = new SessionToolReceiptStore(profileRoot, accountId, sessionId);
    this.messages = createSessionMessages(this);
    this.diagnostics = Object.freeze({
      snapshot: () => this.diagnosticsSnapshot(),
      toolHandoffs: () => this.toolHandoffsSnapshot(),
    });
    this.managedToolRegistry = createSessionToolRegistry({
      accountId,
      sessionId,
      catalog: toolCatalog,
      defaultHandler: (call, options) => this.parkMcpToolCall(call, options),
      onServerCreated: async (server: SessionMcpServer) => {
        const driver = this.driver;
        if (!driver?.bindCallerTools) return;
        const binding: SessionDriverCallerToolBinding = Object.freeze({
          accountId: this.accountId,
          sessionId: this.sessionId,
          catalogId: this.toolCatalog.id,
          sealBatch: (operationId: string) => this.sealParkedMcpCallBatch(operationId),
          failTurn: (operationId: string, error: Error) => this.failParkedMcpTurn(operationId, error),
        });
        await driver.bindCallerTools(server, binding);
        this.authoritativeMcpCallCorrelation = typeof driver.notifyCallerToolCall === "function";
      },
      onDelivery: (callId, outcome) => this.reportMcpDelivery(callId, outcome),
    });
    this.tools = this.managedToolRegistry;
  }

  get accountId(): string {
    return this.accountIdValue;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get configuration(): SessionConfiguration {
    return this.configurationValue;
  }

  get state(): SessionState {
    return this.stateValue;
  }

  get capabilities(): SessionDriverCapabilities {
    return this.driverCapabilitiesValue;
  }

  get driverSetupError(): Error | undefined {
    return this.driverSetupErrorValue;
  }

  setDriver(driver: SessionDriver): void {
    this.driver = driver;
    try {
      const declaredCapabilities = validateDriverCapabilities(driver.capabilities);
      if (declaredCapabilities.streaming === "incremental" && typeof driver.stream !== "function") {
        throw invalidWorkerResult();
      }
      const admitsMaxTokens = typeof driver.admitResponse === "function" &&
        (declaredCapabilities.maxTokens === "enforced" ||
          (declaredCapabilities.maxTokens === "not-enforced" &&
            this.#maxTokensPolicy === "allow-unenforced-max-tokens"));
      this.driverCapabilitiesValue = Object.freeze({
        ...(admitsMaxTokens
          ? { maxTokens: declaredCapabilities.maxTokens! }
          : {}),
        ...(declaredCapabilities.streaming === "incremental" ? { streaming: "incremental" as const } : {}),
      });
    } catch {
      // Do not reject the worker-manager factory after the application has
      // created a resource. Returning the managed worker lets the manager
      // lease it before session startup validates the capability contract.
      this.driverCapabilitiesValue = Object.freeze({});
      this.driverSetupErrorValue = invalidWorkerResult();
    }
  }

  attachLease(lease: ProfileRuntimeWorkerLease<SessionDriver>): void {
    this.lease = lease;
  }

  snapshot(): SessionLedgerSnapshot {
    const snapshot: {
      accountId: string;
      sessionId: string;
      state: SessionState;
      revision: number;
      configuration: SessionConfiguration;
      transcript: SessionTranscript;
      activeOperationId?: string;
    } = {
      accountId: this.accountId,
      sessionId: this.sessionId,
      state: this.stateValue,
      revision: this.revisionValue,
      configuration: cloneFrozen(this.configuration, invalidRequest),
      transcript: cloneFrozen(this.transcriptValue, invalidRequest),
    };
    if (this.activeOperationIdValue !== undefined) snapshot.activeOperationId = this.activeOperationIdValue;
    return Object.freeze(snapshot);
  }

  async diagnosticsSnapshot(): Promise<SessionDiagnosticsSnapshot> {
    const snapshot: {
      usage: UsageProvenance;
      contextOccupancy?: NonNullable<SessionDiagnosticsSnapshot["contextOccupancy"]>;
      acpActivity?: AcpActivityDiagnostics;
      maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
    } = {
      usage: Object.freeze({ ...this.usageValue }),
    };
    if (this.contextOccupancyValue !== undefined) {
      snapshot.contextOccupancy = Object.freeze({ ...this.contextOccupancyValue });
    }
    if (typeof this.driver?.acpActivityDiagnostics === "function") {
      let activity: unknown;
      try {
        activity = this.driver.acpActivityDiagnostics();
      } catch {
        throw new ProtocolFailureError("The session worker returned invalid ACP activity diagnostics.");
      }
      snapshot.acpActivity = validateAcpActivityDiagnostics(activity);
    }
    if (this.maxTokensEnforcementValue !== undefined) {
      snapshot.maxTokensEnforcement = Object.freeze({ ...this.maxTokensEnforcementValue });
    }
    return Object.freeze(snapshot);
  }

  async toolHandoffsSnapshot(): Promise<readonly SessionToolCallReceipt[]> {
    await this.receiptQueue;
    return cloneFrozen(this.receipts, invalidWorkerResult);
  }

  private mutateReceipts(
    update: (draft: SessionToolCallReceipt[]) => void,
  ): Promise<void> {
    const action = this.receiptQueue.then(async () => {
      const draft = this.receipts.map((receipt) => cloneJson(receipt, invalidWorkerResult));
      update(draft);
      if (draft.length > MAX_TOOL_CALLS_PER_SESSION) {
        throw new InternalError("The session tool receipt limit was reached.");
      }
      const frozen = deepFreeze(draft) as unknown as readonly SessionToolCallReceipt[];
      await this.toolReceiptStore.write(frozen);
      this.receipts = frozen;
    });
    this.receiptQueue = action.catch(() => undefined);
    return action;
  }

  private async parkMcpToolCall(
    call: PendingToolCall,
    options: SessionMcpToolCallOptions,
  ): Promise<SessionMcpToolResult> {
    const { signal } = options;
    const activeOperation = this.activeToolOperation;
    const operationId = this.stateValue === "running" && activeOperation
      ? this.toolAdmissionMode === "collecting"
        ? activeOperation.operationId
        : this.toolAdmissionMode === "next" ? this.nextToolOperationId : undefined
      : this.stateValue === "awaiting_tools" && this.toolAdmissionMode === "next"
        ? this.nextToolOperationId
        : undefined;
    if (
      !operationId ||
      call.accountId !== this.accountId || call.sessionId !== this.sessionId ||
      call.catalogId !== this.toolCatalog.id || signal.aborted
    ) throw new RequestAbortedError("The session is not accepting an MCP tool call.");
    const tool = this.toolCatalog.tools.find((entry) => entry.name === call.name);
    if (!tool || !validateCallerToolArguments(tool, call.arguments)) {
      throw new InvalidRequestError("The MCP tool arguments do not match the session's pinned schema.");
    }
    if (
      this.parkedMcpCalls.size >= MAX_TOOL_CALLS_PER_SESSION ||
      [...this.parkedMcpCalls.values()].filter((entry) => entry.operationId === operationId).length >= MAX_TOOL_CALLS_PER_BATCH ||
      this.parkedMcpCalls.has(call.callId) ||
      this.receipts.some((receipt) => receipt.callId === call.callId)
    ) throw new SessionBusyError("The bounded session tool-call ledger is full.");

    const timestamp = new Date().toISOString();
    const receipt: SessionToolCallReceipt = Object.freeze({
      accountId: this.accountId,
      sessionId: this.sessionId,
      operationId,
      callId: call.callId,
      catalogId: call.catalogId,
      name: call.name,
      argumentsDigest: digestJson(call.arguments),
      exposureState: "not_exposed",
      resultState: "none",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const waiting = deferred<SessionMcpToolResult>();
    const delivery = deferred<SessionMcpDeliveryOutcome>();
    let parked!: ParkedMcpCall;
    const onAbort = (): void => { void this.abortParkedMcpCall(parked); };
    const ready = this.mutateReceipts((draft) => { draft.push(receipt); });
    parked = {
      call,
      operationId,
      deferred: waiting,
      delivery,
      ready,
      signal,
      maxResponseBytes: options.maxResponseBytes,
      deadlineAt: options.deadlineAt,
      onAbort,
      settled: false,
    };
    this.parkedMcpCalls.set(call.callId, parked);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await ready;
    } catch (error) {
      this.parkedMcpCalls.delete(call.callId);
      parked.settled = true;
      signal.removeEventListener("abort", onAbort);
      waiting.reject(error instanceof Error ? error : new InternalError("Tool receipt persistence failed."));
      throw error;
    }
    if (parked.settled) throw new RequestAbortedError("The MCP tool call was cancelled before handoff.");
    if (signal.aborted || (activeOperation?.operationId === operationId && activeOperation.signal.aborted) || this.isClosed()) {
      await this.abortParkedMcpCall(parked);
      throw new RequestAbortedError("The MCP tool call was cancelled before handoff.");
    }
    try {
      await this.driver?.notifyCallerToolCall?.(call, operationId);
    } catch (error) {
      await this.abortParkedMcpCall(parked);
      throw error;
    }
    return waiting.promise;
  }

  private async sealParkedMcpCallBatch(operationId: string): Promise<readonly PendingToolCall[]> {
    const operation = this.activeToolOperation;
    if (
      this.stateValue !== "running" || !operation || operation.operationId !== operationId ||
      operation.signal.aborted || this.toolAdmissionMode !== "collecting" || !this.nextToolOperationId
    ) throw new ProtocolFailureError("The ACP driver tried to seal a caller-tool batch outside its active operation.");

    // This synchronous mode transition is the batch cutoff. Any MCP request
    // admitted after it receives the already-reserved next operation ID.
    this.toolAdmissionMode = "next";
    const calls = [...this.parkedMcpCalls.values()].filter((entry) => entry.operationId === operationId);
    if (calls.length === 0 || calls.length > MAX_TOOL_CALLS_PER_BATCH) {
      throw new ProtocolFailureError("The ACP driver sealed an empty or oversized caller-tool batch.");
    }
    await Promise.all(calls.map((entry) => entry.ready));
    if (
      operation.signal.aborted || this.isClosed() || this.stateValue !== "running" ||
      this.activeToolOperation !== operation || this.toolAdmissionMode !== "next" ||
      calls.some((entry) => entry.settled || this.parkedMcpCalls.get(entry.call.callId) !== entry)
    ) throw new ProtocolFailureError("A caller-tool waiter changed while its batch was being sealed.");
    return Object.freeze(calls.map((entry) => entry.call));
  }

  private async failParkedMcpTurn(operationId: string, _error: Error): Promise<void> {
    if (this.stateValue === "closed") return;
    const related = this.activeToolOperation?.operationId === operationId ||
      this.nextToolOperationId === operationId || this.parkedToolBatch?.operationId === operationId ||
      [...this.parkedMcpCalls.values()].some((entry) => entry.operationId === operationId);
    if (!related) throw new ProtocolFailureError("The ACP driver reported failure for a foreign session operation.");
    this.stateValue = "interrupted";
    this.toolAdmissionMode = "closed";
    this.nextToolOperationId = undefined;
    this.activeController?.abort();
    await this.cancelParkedCalls();
  }

  private abortParkedMcpCall(parked: ParkedMcpCall): Promise<void> {
    if (parked.cancelTask) return parked.cancelTask;
    if (!parked.settled) {
      parked.settled = true;
      parked.signal.removeEventListener("abort", parked.onAbort);
      parked.deferred.reject(new RequestAbortedError("The parked MCP tool call was cancelled."));
    }
    this.parkedMcpCalls.delete(parked.call.callId);
    if (parked.deliveryOutcome === undefined) {
      parked.deliveryOutcome = "uncertain";
      parked.delivery.resolve("uncertain");
    }
    const cancelTask = Promise.allSettled([
      this.markMcpCallUncertain(parked.call.callId, true),
      this.driver?.cancelCallerToolTurn?.(parked.operationId) ?? Promise.resolve(),
    ]).then(() => undefined).catch(() => {
      // Keep the in-memory terminal state conservative if durable repair fails.
    });
    parked.cancelTask = cancelTask;
    if (this.stateValue !== "closed" && this.stateValue !== "interrupted") {
      this.stateValue = "interrupted";
      this.toolAdmissionMode = "closed";
      this.nextToolOperationId = undefined;
      this.activeController?.abort();
    }
    this.managedToolRegistry.cancelToolCall(parked.call.callId);
    return cancelTask;
  }

  private async reportMcpDelivery(callId: string, outcome: SessionMcpDeliveryOutcome): Promise<void> {
    const parked = this.parkedMcpCalls.get(callId);
    if (!parked || parked.deliveryOutcome !== undefined) return;
    parked.deliveryOutcome = outcome;
    parked.delivery.resolve(outcome);
    if (outcome === "uncertain") {
      await this.markMcpCallUncertain(callId, true);
      if (this.stateValue !== "closed" && this.stateValue !== "interrupted") {
        this.stateValue = "interrupted";
        this.toolAdmissionMode = "closed";
        this.nextToolOperationId = undefined;
        this.activeController?.abort();
      }
    }
  }

  private async awaitMcpDeliveries(batch: ParkedToolBatch, signal: AbortSignal): Promise<void> {
    const calls = batch.callIds.map((callId) => this.parkedMcpCalls.get(callId));
    if (calls.some((call) => !call || !call.settled)) {
      throw new ProtocolFailureError("The complete MCP waiter batch was not released for delivery.");
    }
    const pendingCalls = calls as ParkedMcpCall[];
    const outcomes = pendingCalls.flatMap((call) => call.deliveryOutcome === undefined ? [] : [call.deliveryOutcome]);
    const unresolved = pendingCalls.filter((call) => call.deliveryOutcome === undefined);
    if (unresolved.length > 0) await this.waitForMcpDeliveryOutcomes(unresolved, outcomes, signal);
    if (signal.aborted || this.isClosed()) throw aborted();
    if (outcomes.some((outcome) => outcome !== "delivered")) {
      throw new ProtocolFailureError("The MCP server did not transmit the complete caller result batch.");
    }
  }

  private waitForMcpDeliveryOutcomes(
    calls: readonly ParkedMcpCall[],
    outcomes: SessionMcpDeliveryOutcome[],
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Math.min(...calls.map((call) => call.deadlineAt));
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new RequestTimeoutError("MCP result transport did not complete before its request deadline."));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, values?: readonly SessionMcpDeliveryOutcome[]): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else {
          outcomes.push(...(values ?? []));
          resolve();
        }
      };
      const onAbort = (): void => {
        // Abort/cancel the MCP transports and waiter records independently of
        // whether their HTTP response ever emits finish or close.
        for (const call of calls) void this.abortParkedMcpCall(call);
        finish(aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(new RequestTimeoutError(
        "MCP result transport did not complete before its request deadline.",
      )), remaining);
      if (signal.aborted) {
        onAbort();
        return;
      }
      Promise.all(calls.map((call) => call.delivery.promise)).then(
        (values) => finish(undefined, values),
        (error: unknown) => finish(error instanceof Error ? error : new InternalError("MCP delivery wait failed.")),
      );
    });
  }

  private retireParkedMcpCalls(callIds: readonly string[]): void {
    for (const callId of callIds) {
      const parked = this.parkedMcpCalls.get(callId);
      if (!parked || parked.deliveryOutcome !== "delivered") {
        throw new ProtocolFailureError("A parked MCP call cannot be retired without transport acknowledgement.");
      }
      parked.signal.removeEventListener("abort", parked.onAbort);
      this.parkedMcpCalls.delete(callId);
    }
  }

  private assertParkedMcpWaitersValid(callIds: readonly string[], signal?: AbortSignal): void {
    if (signal?.aborted || this.isClosed()) throw aborted();
    for (const callId of callIds) {
      const waiter = this.parkedMcpCalls.get(callId);
      if (!waiter || waiter.settled) {
        throw new ProtocolFailureError("A caller MCP tool waiter was cancelled before its boundary could be published.");
      }
    }
  }

  private markMcpCallUncertain(callId: string, deliveryMayHaveStarted: boolean): Promise<void> {
    return this.mutateReceipts((draft) => {
      const index = draft.findIndex((receipt) => receipt.callId === callId);
      if (index < 0) return;
      const receipt = draft[index]!;
      draft[index] = Object.freeze({
        ...receipt,
        ...(deliveryMayHaveStarted && receipt.resultState === "delivery_attempted"
          ? { resultState: "uncertain" as const }
          : {}),
        ...(receipt.exposureState === "exposure_attempted" ? { exposureState: "exposed_or_uncertain" as const } : {}),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  private async cancelParkedCalls(operationId?: string): Promise<void> {
    const pending = [...this.parkedMcpCalls.values()].filter((entry) => operationId === undefined || entry.operationId === operationId);
    await Promise.allSettled(pending.map((entry) => this.abortParkedMcpCall(entry)));
  }

  private validateToolResultBatch(
    fullTranscript: SessionTranscript,
    suffix: SessionTranscript,
  ): AcceptedToolBatch {
    const batch = this.parkedToolBatch;
    if (this.stateValue !== "awaiting_tools" || !batch || suffix.length === 0) throw invalidRequest();
    const assistant = this.transcriptValue.at(-1);
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new ProtocolFailureError("The ledger lost the assistant tool-use batch that it exposed.");
    }
    const exposed = assistant.content.filter((block) => isRecord(block) && block.type === "tool_use");
    if (exposed.length !== batch.callIds.length) throw new ProtocolFailureError("The exposed tool batch no longer matches its receipts.");
    const expected = new Map<string, SessionToolCallReceipt>();
    for (let index = 0; index < batch.callIds.length; index += 1) {
      const callId = batch.callIds[index]!;
      const receipt = this.receipts.find((entry) => entry.callId === callId);
      const block = exposed[index];
      const waiter = this.parkedMcpCalls.get(callId);
      if (
        !receipt || receipt.accountId !== this.accountId || receipt.sessionId !== this.sessionId ||
        receipt.operationId !== batch.operationId || receipt.catalogId !== this.toolCatalog.id ||
        receipt.exposureState !== "exposure_attempted" || receipt.resultState !== "none" ||
        !waiter || waiter.settled || waiter.operationId !== batch.operationId || !isRecord(block) ||
        block.id !== callId || block.name !== receipt.name || !isRecord(block.input) ||
        digestJson(block.input) !== receipt.argumentsDigest
      ) throw new ProtocolFailureError("A tool result receipt is missing, foreign, or inconsistent with exposed arguments.");
      expected.set(callId, receipt);
    }

    const staged = new Map<string, SessionDriverToolResult>();
    for (const message of suffix) {
      if (message.role !== "user") throw invalidRequest("Only user tool_result messages may continue a parked tool turn.");
      if (typeof message.content === "string") {
        throw new UnsupportedFeatureError("A tool-result continuation cannot include new user text.");
      }
      if (!Array.isArray(message.content)) throw invalidRequest();
      for (const rawBlock of message.content) {
        if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") throw invalidRequest();
        if (rawBlock.type !== "tool_result") {
          throw new UnsupportedFeatureError("A tool-result continuation accepts only tool_result blocks.");
        }
        if (
          !exactKeys(rawBlock, ["type", "tool_use_id", "content", ...(hasOwn(rawBlock, "is_error") ? ["is_error"] : [])]) ||
          typeof rawBlock.tool_use_id !== "string" ||
          (hasOwn(rawBlock, "is_error") && typeof rawBlock.is_error !== "boolean")
        ) throw invalidRequest("A tool_result block is malformed.");
        const callId = rawBlock.tool_use_id;
        const receipt = expected.get(callId);
        if (!receipt || staged.has(callId)) throw invalidRequest("A tool_result ID is unknown, foreign, or duplicated.");
        let content: Array<{ type: "text"; text: string }>;
        if (typeof rawBlock.content === "string") content = [{ type: "text", text: rawBlock.content }];
        else if (Array.isArray(rawBlock.content)) {
          content = rawBlock.content.map((block) => {
            if (!isRecord(block) || block.type !== "text" || !exactKeys(block, ["type", "text"]) || typeof block.text !== "string") {
              throw new UnsupportedFeatureError("Only text content is supported in caller tool results.");
            }
            return Object.freeze({ type: "text" as const, text: block.text });
          });
        } else throw new UnsupportedFeatureError("Only string or text-block caller tool results are supported.");
        const result: SessionMcpToolResult = Object.freeze({
          content: Object.freeze(content),
          ...(hasOwn(rawBlock, "is_error") ? { isError: rawBlock.is_error as boolean } : {}),
        });
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TOOL_RESULT_BYTES) {
          throw new InvalidRequestError("A caller tool result exceeds the supported size bound.");
        }
        const waiter = this.parkedMcpCalls.get(callId);
        if (!waiter || sessionMcpToolResultResponseBytes(waiter.call.requestId, result) > waiter.maxResponseBytes) {
          throw new InvalidRequestError("A tool result exceeds the MCP response bound for its parked request.");
        }
        staged.set(callId, Object.freeze({ callId, result }));
      }
    }
    if (staged.size !== expected.size || [...expected.keys()].some((callId) => !staged.has(callId))) {
      throw invalidRequest("The entire exposed tool batch must be supplied before any waiter is released.");
    }
    const results = batch.callIds.map((callId) => staged.get(callId)!);
    if (Buffer.byteLength(JSON.stringify(results), "utf8") > MAX_TOOL_RESULT_BYTES) {
      throw new InvalidRequestError("The complete caller tool-result batch exceeds its supported size bound.");
    }
    return Object.freeze({
      batch,
      messages: deepFreeze(suffix) as unknown as SessionTranscript,
      results: Object.freeze(results),
    });
  }

  private startToolContinuation(
    accepted: AcceptedToolBatch,
    maxTokens: number,
    externalSignal: AbortSignal | undefined,
    streaming = false,
  ): { readonly continuation: SessionDriverToolContinuationPlan; readonly externalSignal: AbortSignal | undefined; readonly abortFromCaller: () => void } {
    if (
      this.stateValue !== "awaiting_tools" || !this.driver ||
      (streaming ? typeof this.driver.streamTools !== "function" : typeof this.driver.continueTools !== "function")
    ) {
      throw new UnsupportedFeatureError("The session worker does not support caller-tool continuation.");
    }
    if (externalSignal?.aborted) throw aborted();
    const operationId = this.nextToolOperationId;
    if (!operationId) throw new ProtocolFailureError("The parked tool turn has no reserved continuation operation.");
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (externalSignal?.aborted) controller.abort();
    this.stateValue = "running";
    this.activeOperationIdValue = operationId;
    this.activeController = controller;
    this.activeToolOperation = { operationId, signal: controller.signal };
    const continuation: SessionDriverToolContinuationPlan = Object.freeze({
      operationId,
      previousOperationId: accepted.batch.operationId,
      accountId: this.accountId,
      sessionId: this.sessionId,
      configuration: this.configuration,
      messages: accepted.messages,
      maxTokens,
      results: accepted.results,
      signal: controller.signal,
    });
    return { continuation, externalSignal, abortFromCaller };
  }

  private async admitMessageResponse(
    kind: SessionDriverResponseAdmissionRequest["kind"],
    operationId: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<SessionDriverResponseAdmission> {
    if (typeof this.driver?.admitResponse !== "function") {
      throw new UnsupportedFeatureError("The session worker does not implement explicit per-response max_tokens admission.");
    }
    if (signal.aborted || this.isClosed()) throw aborted();
    const request: SessionDriverResponseAdmissionRequest = Object.freeze({
      kind,
      operationId,
      accountId: this.accountId,
      sessionId: this.sessionId,
      maxTokens,
      policy: this.#maxTokensPolicy,
      signal,
    });
    const admissionPromise = Promise.resolve().then(() => this.driver!.admitResponse!(request));
    const grant = await waitForSignal(admissionPromise, signal);
    if (signal.aborted || this.isClosed()) throw aborted();
    const expectedOutcome = this.driverCapabilitiesValue.maxTokens;
    if (!expectedOutcome) {
      throw new UnsupportedFeatureError("The session worker does not implement an admitted max_tokens policy.");
    }
    const admission = validateAdmissionGrant(grant, request, expectedOutcome);
    this.maxTokensEnforcementValue = enforcementDiagnostic(admission);
    return admission;
  }

  private activateMessageOperation(operationId: string): void {
    if (
      this.stateValue !== "running" || this.activeToolOperation?.operationId !== operationId ||
      this.activeToolOperation.signal.aborted
    ) throw aborted();
    this.toolAdmissionMode = "collecting";
    this.nextToolOperationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
  }

  private activateToolContinuation(operationId: string): void {
    if (
      this.stateValue !== "running" || this.activeToolOperation?.operationId !== operationId ||
      this.activeToolOperation.signal.aborted
    ) throw aborted();
    this.toolAdmissionMode = "collecting";
    this.nextToolOperationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
  }

  private restoreUnadmittedInitialOperation(operationId: string): boolean {
    if (this.stateValue !== "running" || this.activeOperationIdValue !== operationId) return false;
    this.stateValue = "idle";
    this.toolAdmissionMode = "closed";
    this.nextToolOperationId = undefined;
    return true;
  }

  private restoreUnadmittedToolContinuation(
    operationId: string,
    originalBatch: ParkedToolBatch,
  ): boolean {
    if (this.stateValue !== "running" || this.activeOperationIdValue !== operationId) return false;
    const originalBoundaryIntact = this.parkedToolBatch === originalBatch &&
      this.toolAdmissionMode === "next" && this.nextToolOperationId === operationId &&
      originalBatch.callIds.every((callId) => {
        const waiter = this.parkedMcpCalls.get(callId);
        const receipt = this.receipts.find((entry) => entry.callId === callId);
        return waiter !== undefined && !waiter.settled && waiter.operationId === originalBatch.operationId &&
          receipt !== undefined && receipt.accountId === this.accountId && receipt.sessionId === this.sessionId &&
          receipt.operationId === originalBatch.operationId && receipt.exposureState === "exposure_attempted" &&
          receipt.resultState === "none";
      });
    if (!originalBoundaryIntact) {
      // An independently lost waiter or changed parked boundary is terminal;
      // never turn it back into a retryable awaiting_tools session.
      this.stateValue = "interrupted";
      this.toolAdmissionMode = "closed";
      this.nextToolOperationId = undefined;
      this.activeController?.abort();
      return false;
    }
    // Keep the original parked batch, receipts, and reserved next operation
    // ID intact. No result has been persisted or released at this point.
    this.stateValue = "awaiting_tools";
    return true;
  }

  private async continueToolMessage(
    fullTranscript: SessionTranscript,
    suffix: SessionTranscript,
    options: SessionLedgerMessageOptions,
  ): Promise<SessionLedgerReceipt> {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw invalidRequest();
    const accepted = this.validateToolResultBatch(fullTranscript, suffix);
    const started = this.startToolContinuation(accepted, options.maxTokens, options.signal);
    const active = this.runToolContinuation(started.continuation, accepted, started.externalSignal, started.abortFromCaller);
    this.activePromise = active;
    return active;
  }

  private async runToolContinuation(
    continuationPlan: SessionDriverToolContinuationPlan,
    accepted: AcceptedToolBatch,
    externalSignal: AbortSignal | undefined,
    abortFromCaller: () => void,
  ): Promise<SessionLedgerReceipt> {
    let admissionComplete = false;
    let deliveryAttempted = false;
    let admittedResponse: SessionDriverResponseAdmission | undefined;
    try {
      const admission = await this.admitMessageResponse(
        "tool_continuation",
        continuationPlan.operationId,
        continuationPlan.maxTokens,
        continuationPlan.signal,
      );
      if (continuationPlan.signal.aborted || this.isClosed()) throw aborted();
      const continuation: SessionDriverToolContinuation = Object.freeze({ ...continuationPlan, admission });
      admittedResponse = admission;
      this.activateToolContinuation(continuation.operationId);
      admissionComplete = true;
      await this.driver!.prepareToolContinuation?.(continuation);
      if (continuation.signal.aborted || this.isClosed()) throw aborted();
      await this.saveAndDeliverToolResults(accepted, continuation.signal);
      deliveryAttempted = true;
      await this.awaitMcpDeliveries(accepted.batch, continuation.signal);

      const raw = await this.driver!.continueTools!(continuation);
      if (continuation.signal.aborted || this.isClosed()) throw aborted();
      const acknowledgement = validateWorkerAcknowledgement(raw);
      rejectUnenforcedMaxTokensStop(acknowledgement, admission);
      const normalized = await this.prepareMessageAcknowledgement(
        acknowledgement,
        continuation.operationId,
        accepted.batch,
      );
      if (continuation.signal.aborted || this.isClosed()) throw aborted();
      const committedMessages = deepFreeze([
        ...accepted.messages,
        ...normalized.output,
      ]) as unknown as SessionTranscript;
      const nextTranscript = deepFreeze([
        ...this.transcriptValue,
        ...committedMessages,
      ]) as unknown as SessionTranscript;
      const declaresToolBoundary = acknowledgement.stage === "awaiting_tools" ||
        (isRecord(acknowledgement.result) && acknowledgement.result.stopReason === "tool_use");
      if (declaresToolBoundary) {
        this.assertParkedMcpWaitersValid(this.parkedToolBatch?.callIds ?? [], continuation.signal);
      }
      this.transcriptValue = nextTranscript;
      this.revisionValue += 1;
      this.stateValue = acknowledgement.stage === "awaiting_tools" ? "awaiting_tools" : "idle";
      if (acknowledgement.stage === "completed") {
        this.toolAdmissionMode = "closed";
        this.nextToolOperationId = undefined;
      }
      this.usageValue = normalized.usage;
      this.contextOccupancyValue = normalized.contextOccupancy;
      return Object.freeze({
        operationId: continuation.operationId,
        stage: acknowledgement.stage,
        committedMessages: cloneFrozen(committedMessages, invalidWorkerResult),
        ...(hasOwn(acknowledgement, "result") ? { result: cloneFrozen(acknowledgement.result, invalidWorkerResult) } : {}),
        ...(admittedResponse === undefined ? {} : { maxTokensEnforcement: enforcementDiagnostic(admittedResponse) }),
      });
    } catch (error) {
      if (!admissionComplete) {
        const retryable = this.restoreUnadmittedToolContinuation(continuationPlan.operationId, accepted.batch);
        if (!retryable && this.stateValue !== "closed") await this.cancelParkedCalls();
        throw continuationPlan.signal.aborted ? aborted() : normalizeWorkerError(error);
      }
      if (this.stateValue !== "closed") this.stateValue = "interrupted";
      this.toolAdmissionMode = "closed";
      this.nextToolOperationId = undefined;
      await this.cancelParkedCalls();
      if (deliveryAttempted) {
        try {
          await this.finishToolDelivery(accepted.batch, "uncertain");
        } catch {
          // Durable `delivery_attempted` is itself the conservative recovery state.
        }
      }
      throw continuationPlan.signal.aborted ? aborted() : normalizeWorkerError(error);
    } finally {
      externalSignal?.removeEventListener("abort", abortFromCaller);
      if (this.activeOperationIdValue === continuationPlan.operationId) {
        this.activeOperationIdValue = undefined;
        this.activeController = undefined;
        this.activePromise = undefined;
      }
      if (this.activeToolOperation?.operationId === continuationPlan.operationId) this.activeToolOperation = undefined;
    }
  }

  private async saveAndDeliverToolResults(
    accepted: AcceptedToolBatch,
    signal: AbortSignal,
  ): Promise<void> {
    await this.mutateReceipts((draft) => {
      if (signal.aborted || this.isClosed()) throw aborted();
      const now = new Date().toISOString();
      for (const entry of accepted.results) {
        const index = draft.findIndex((receipt) => receipt.callId === entry.callId);
        if (index < 0 || draft[index]!.resultState !== "none") throw invalidRequest("A tool result conflicts with its durable receipt.");
        draft[index] = Object.freeze({
          ...draft[index]!,
          exposureState: "exposed_or_uncertain",
          resultState: "saved",
          result: entry.result,
          updatedAt: now,
        });
      }
    });
    // Preserve a real cancellation point between durable save and delivery-attempt.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    if (signal.aborted || this.isClosed()) throw aborted();
    await this.mutateReceipts((draft) => {
      if (signal.aborted || this.isClosed()) throw aborted();
      const now = new Date().toISOString();
      for (const entry of accepted.results) {
        const index = draft.findIndex((receipt) => receipt.callId === entry.callId);
        if (index < 0 || draft[index]!.resultState !== "saved") throw invalidRequest("A saved tool result is not deliverable.");
        draft[index] = Object.freeze({ ...draft[index]!, resultState: "delivery_attempted", updatedAt: now });
      }
    });
    if (signal.aborted || this.isClosed()) throw aborted();
    for (const entry of accepted.results) this.settleParkedMcpCall(entry.callId, true, entry.result);
  }

  async execute(
    request: SessionLedgerRequest,
    options: SessionLedgerOperationOptions = {},
  ): Promise<SessionLedgerReceipt> {
    return this.executeOperation(request, options);
  }

  async executeMessage(
    request: SessionLedgerRequest,
    options: SessionLedgerMessageOptions,
  ): Promise<SessionLedgerReceipt> {
    if (!this.driverCapabilitiesValue.maxTokens || typeof this.driver?.admitResponse !== "function") {
      throw new UnsupportedFeatureError("The session driver has not implemented max_tokens response admission.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) throw invalidRequest();
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => typeof key !== "string" || !["signal", "maxTokens"].includes(key))) {
      throw invalidRequest();
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidRequest();
    }
    validateSignal(options.signal);
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw invalidRequest();

    const checkedRequest = cloneJson(request, invalidRequest);
    if (
      !isRecord(checkedRequest) || !hasOwn(checkedRequest, "transcript") ||
      Object.keys(checkedRequest).some((key) => !["transcript", "configuration"].includes(key))
    ) throw invalidRequest();
    const incoming = validateTextMessagesTranscript(checkedRequest.transcript);
    validateConfigurationAssertion(checkedRequest.configuration as SessionConfigurationAssertion | undefined, this.configuration);
    if (incoming.length < this.transcriptValue.length) throw invalidRequest();
    for (let index = 0; index < this.transcriptValue.length; index += 1) {
      if (!jsonEqual(incoming[index], this.transcriptValue[index])) throw invalidRequest();
    }
    const suffix = incoming.slice(this.transcriptValue.length);
    if (suffix.length === 0) throw invalidRequest();
    if (this.stateValue === "awaiting_tools") {
      return this.continueToolMessage(incoming, deepFreeze(suffix) as unknown as SessionTranscript, options);
    }
    this.assertCanExecute();
    if (this.revisionValue > 0 && containsToolResult(suffix)) {
      throw invalidRequest("New tool_result blocks require a matching active SDK tool receipt.");
    }
    const acpPrompt = mapMessagesToAcpPrompt(this.configuration, suffix, {
      includeSystem: this.revisionValue === 0,
    });
    const normalizedRequest: SessionLedgerRequest = {
      transcript: incoming,
      ...(hasOwn(checkedRequest, "configuration")
        ? { configuration: checkedRequest.configuration as SessionConfigurationAssertion }
        : {}),
    };
    return this.executeOperation(normalizedRequest, { ...(options.signal === undefined ? {} : { signal: options.signal }) }, {
      acpPrompt,
      maxTokens: options.maxTokens,
    });
  }

  streamMessage(
    request: SessionLedgerRequest,
    options: SessionLedgerMessageOptions,
  ): AsyncIterable<SessionMessageSemanticEvent> {
    if (
      !this.driverCapabilitiesValue.maxTokens ||
      this.driverCapabilitiesValue.streaming !== "incremental" ||
      typeof this.driver?.admitResponse !== "function" ||
      typeof this.driver?.stream !== "function"
    ) {
      throw new UnsupportedFeatureError("The session driver has not implemented bounded incremental Messages response admission.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) throw invalidRequest();
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => typeof key !== "string" || !["signal", "maxTokens"].includes(key))) throw invalidRequest();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidRequest();
    }
    validateSignal(options.signal);
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw invalidRequest();

    const checkedRequest = cloneJson(request, invalidRequest);
    if (
      !isRecord(checkedRequest) || !hasOwn(checkedRequest, "transcript") ||
      Object.keys(checkedRequest).some((key) => !["transcript", "configuration"].includes(key))
    ) throw invalidRequest();
    const incoming = validateTextMessagesTranscript(checkedRequest.transcript);
    validateConfigurationAssertion(checkedRequest.configuration as SessionConfigurationAssertion | undefined, this.configuration);
    if (incoming.length < this.transcriptValue.length) throw invalidRequest();
    for (let index = 0; index < this.transcriptValue.length; index += 1) {
      if (!jsonEqual(incoming[index], this.transcriptValue[index])) throw invalidRequest();
    }
    const suffix = incoming.slice(this.transcriptValue.length);
    if (suffix.length === 0) throw invalidRequest();
    if (this.stateValue === "awaiting_tools") {
      if (typeof this.driver?.streamTools !== "function") {
        throw new UnsupportedFeatureError("The session worker does not support streaming caller-tool continuation.");
      }
      return this.runMessageStream(
        deepFreeze(suffix) as unknown as SessionTranscript,
        mapMessagesToAcpPrompt(this.configuration, suffix, { includeSystem: false }),
        options.maxTokens,
        options.signal,
        this.revisionValue,
        incoming,
      );
    }
    this.assertCanExecute();
    if (this.revisionValue > 0 && containsToolResult(suffix)) {
      throw invalidRequest("New tool_result blocks require a matching active SDK tool receipt.");
    }
    const acpPrompt = mapMessagesToAcpPrompt(this.configuration, suffix, {
      includeSystem: this.revisionValue === 0,
    });
    return this.runMessageStream(
      deepFreeze(suffix) as unknown as SessionTranscript,
      acpPrompt,
      options.maxTokens,
      options.signal,
      this.revisionValue,
    );
  }

  private async executeOperation(
    request: SessionLedgerRequest,
    options: SessionLedgerOperationOptions,
    messageOperation?: {
      readonly acpPrompt: NonNullable<SessionDriverOperation["acpPrompt"]>;
      readonly maxTokens: number;
    },
  ): Promise<SessionLedgerReceipt> {
    this.assertCanExecute();
    const checkedRequest = cloneJson(request, invalidRequest);
    if (
      !isRecord(checkedRequest) ||
      !hasOwn(checkedRequest, "transcript") ||
      Object.keys(checkedRequest).some((key) => !["transcript", "configuration"].includes(key))
    ) {
      throw invalidRequest();
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) throw invalidRequest();
    validateSignal(options.signal);
    if (options.signal?.aborted) throw aborted();

    const incoming = validateTranscript(checkedRequest.transcript, invalidRequest);
    validateConfigurationAssertion(checkedRequest.configuration as SessionConfigurationAssertion | undefined, this.configuration);
    if (incoming.length < this.transcriptValue.length) throw invalidRequest();
    for (let index = 0; index < this.transcriptValue.length; index += 1) {
      if (!jsonEqual(incoming[index], this.transcriptValue[index])) throw invalidRequest();
    }
    const suffix = incoming.slice(this.transcriptValue.length);
    if (suffix.length === 0) throw invalidRequest();
    const started = this.startOperation(
      deepFreeze(suffix) as unknown as SessionTranscript,
      options.signal,
      messageOperation,
    );
    const active = this.runOperation(
      started.operation,
      started.externalSignal,
      started.abortFromCaller,
      messageOperation !== undefined,
    );
    this.activePromise = active;
    return active;
  }

  private startOperation(
    suffix: SessionTranscript,
    externalSignal: AbortSignal | undefined,
    messageOperation?: {
      readonly acpPrompt: NonNullable<SessionDriverOperation["acpPrompt"]>;
      readonly maxTokens: number;
    },
  ): {
    readonly operation: SessionDriverOperation;
    readonly externalSignal: AbortSignal | undefined;
    readonly abortFromCaller: () => void;
  } {
    this.assertCanExecute();
    if (externalSignal?.aborted) throw aborted();
    if (!this.driver || !this.lease) throw new SessionNotFoundError("The session worker is not available.");

    const operationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (externalSignal?.aborted) controller.abort();

    this.stateValue = "running";
    this.activeOperationIdValue = operationId;
    this.activeController = controller;
    const operation: SessionDriverOperation = Object.freeze({
      operationId,
      accountId: this.accountId,
      sessionId: this.sessionId,
      configuration: this.configuration,
      messages: suffix,
      ...(messageOperation === undefined ? {} : {
        acpPrompt: messageOperation.acpPrompt,
        maxTokens: messageOperation.maxTokens,
      }),
      signal: controller.signal,
    });
    this.activeToolOperation = messageOperation === undefined ? undefined : operation;
    // Message MCP calls are not accepted until the response has passed the
    // driver's explicit admission gate.
    this.toolAdmissionMode = "closed";
    this.nextToolOperationId = undefined;
    return { operation, externalSignal, abortFromCaller };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.markClosed();
    const active = this.activePromise;
    const toolWaiters = this.cancelParkedCalls();
    const closing = (async () => {
      await this.managedToolRegistry.close();
      await toolWaiters;
      try {
        await this.lease?.close();
      } catch (error) {
        throw new ProcessFailureError("The session worker could not be closed safely.", { cause: error });
      }
      await active?.catch(() => undefined);
      this.onCleanupComplete();
    })();
    this.closePromise = closing;
    try {
      await closing;
    } catch (error) {
      this.closePromise = undefined;
      throw error;
    }
  }

  private assertCanExecute(): void {
    if (this.stateValue === "running") throw new SessionBusyError("A session operation is already active.");
    if (this.stateValue === "closed") throw new SessionNotFoundError("The session is closed.");
    if (this.stateValue === "interrupted") {
      throw new SessionInterruptedError("The session was interrupted and cannot be resumed or replayed.");
    }
    if (this.stateValue === "awaiting_tools") {
      throw new UnsupportedFeatureError("Tool-result continuation is not implemented by the session ledger.");
    }
  }

  private async prepareMessageAcknowledgement(
    acknowledgement: SessionDriverAcknowledgement,
    operationId: string,
    previousBatch?: ParkedToolBatch,
    streaming = false,
  ): Promise<NormalizedMessagesAcknowledgement> {
    const result = acknowledgement.result;
    const declaresToolBoundary = acknowledgement.stage === "awaiting_tools" ||
      (isRecord(result) && result.stopReason === "tool_use");
    if (this.activeToolOperation?.operationId === operationId) {
      this.toolAdmissionMode = declaresToolBoundary ? "next" : "closed";
    }
    const pendingForOperation = [...this.parkedMcpCalls.values()]
      .filter((pending) => pending.operationId === operationId);
    await Promise.all(pendingForOperation.map((pending) => pending.ready));
    if (pendingForOperation.some((pending) =>
      pending.settled || this.parkedMcpCalls.get(pending.call.callId) !== pending)) {
      throw new ProtocolFailureError("A parked MCP call was cancelled before its worker boundary was acknowledged.");
    }
    if (!declaresToolBoundary) {
      if (pendingForOperation.length > 0) {
        throw new ProtocolFailureError("The worker completed while caller MCP tool waiters remained unresolved.");
      }
    const normalized = normalizeMessagesAcknowledgement(acknowledgement);
      if (previousBatch) {
        await this.finishToolDelivery(previousBatch, "acknowledged");
        this.retireParkedMcpCalls(previousBatch.callIds);
      }
      if (this.nextToolOperationId && [...this.parkedMcpCalls.values()].some((pending) => pending.operationId === this.nextToolOperationId)) {
        throw new ProtocolFailureError("The worker completed while a late MCP waiter remained unassigned.");
      }
      this.parkedToolBatch = undefined;
      return normalized;
    }

    if (
      acknowledgement.stage !== "awaiting_tools" || !isRecord(result) || result.stopReason !== "tool_use" ||
      !Array.isArray(this.configuration.tools) || this.configuration.tools.length === 0 ||
      (streaming ? typeof this.driver?.streamTools !== "function" : typeof this.driver?.continueTools !== "function")
    ) throw new ProtocolFailureError("The worker tool-use boundary is unsupported or incomplete.");
    const outputMessage = acknowledgement.output[0];
    if (!outputMessage || outputMessage.role !== "assistant" || !Array.isArray(outputMessage.content)) {
      throw new ProtocolFailureError("A tool-use acknowledgement must contain assistant content blocks.");
    }
    const toolBlocks = outputMessage.content.filter((block) => isRecord(block) && block.type === "tool_use");
    if (toolBlocks.length === 0 || toolBlocks.length > MAX_TOOL_CALLS_PER_BATCH || pendingForOperation.length !== toolBlocks.length) {
      throw new ProtocolFailureError("The worker tool-use blocks do not match the parked MCP call batch.");
    }

    const unmatched = [...pendingForOperation];
    const ids: string[] = [];
    for (const block of toolBlocks) {
      if (
        !isRecord(block) || typeof block.name !== "string" || !isRecord(block.input) ||
        !unmatched.length
      ) throw new ProtocolFailureError("The worker returned a malformed caller tool_use block.");
      const tool = this.toolCatalog.tools.find((entry) => entry.name === block.name);
      if (!tool || !validateCallerToolArguments(tool, block.input)) {
        throw new ProtocolFailureError("The worker tool arguments do not match the original caller schema.");
      }
      const digest = digestJson(block.input);
      const matchingIndices = unmatched.flatMap((pending, pendingIndex) =>
        (!this.authoritativeMcpCallCorrelation || block.id === pending.call.callId) &&
        pending.call.name === block.name && digestJson(pending.call.arguments) === digest &&
        pending.call.catalogId === this.toolCatalog.id && pending.call.accountId === this.accountId &&
        pending.call.sessionId === this.sessionId ? [pendingIndex] : []);
      if (matchingIndices.length !== 1) {
        throw new ProtocolFailureError("A worker tool_use block has no unique matching MCP call.");
      }
      const index = matchingIndices[0]!;
      const [matched] = unmatched.splice(index, 1);
      if (!matched) throw invalidWorkerResult();
      ids.push(matched.call.callId);
    }
    if (unmatched.length !== 0 || new Set(ids).size !== ids.length) {
      throw new ProtocolFailureError("The worker tool-use batch does not map one-to-one to MCP waiters.");
    }

    await this.mutateReceipts((draft) => {
      const now = new Date().toISOString();
      if (previousBatch) {
        for (const callId of previousBatch.callIds) {
          const index = draft.findIndex((receipt) => receipt.callId === callId);
          if (index < 0 || draft[index]!.resultState !== "delivery_attempted") {
            throw new InternalError("A tool delivery receipt is not in its expected state.");
          }
          draft[index] = Object.freeze({
            ...draft[index]!,
            exposureState: "exposed_or_uncertain",
            resultState: "acknowledged",
            updatedAt: now,
          });
        }
      }
      for (const callId of ids) {
        const index = draft.findIndex((receipt) => receipt.callId === callId);
        if (index < 0 || draft[index]!.operationId !== operationId || draft[index]!.resultState !== "none") {
          throw new InternalError("A new tool exposure receipt is missing or conflicting.");
        }
        draft[index] = Object.freeze({ ...draft[index]!, exposureState: "exposure_attempted", updatedAt: now });
      }
    });

    // Cancellation can race the durable exposure write. Do not publish or
    // commit a tool boundary whose MCP waiter disappeared while it was being
    // persisted.
    this.assertParkedMcpWaitersValid(ids, this.activeToolOperation?.operationId === operationId
      ? this.activeToolOperation.signal
      : undefined);

    if (previousBatch) {
      this.retireParkedMcpCalls(previousBatch.callIds);
    }
    this.parkedToolBatch = Object.freeze({ operationId, callIds: Object.freeze(ids) });
    return normalizeMessagesAcknowledgement(acknowledgement, ids);
  }

  private settleParkedMcpCall(callId: string, deliver: boolean, result?: SessionMcpToolResult): void {
    const parked = this.parkedMcpCalls.get(callId);
    if (!parked || parked.settled) return;
    parked.settled = true;
    parked.signal.removeEventListener("abort", parked.onAbort);
    if (deliver && result) parked.deferred.resolve(result);
    else void this.abortParkedMcpCall(parked);
  }

  private async finishToolDelivery(batch: ParkedToolBatch, state: "acknowledged" | "uncertain"): Promise<void> {
    await this.mutateReceipts((draft) => {
      const now = new Date().toISOString();
      for (const callId of batch.callIds) {
        const index = draft.findIndex((receipt) => receipt.callId === callId);
        if (index < 0 || draft[index]!.resultState !== "delivery_attempted") {
          throw new InternalError("A tool delivery receipt is not in its expected state.");
        }
        draft[index] = Object.freeze({
          ...draft[index]!,
          exposureState: "exposed_or_uncertain",
          resultState: state,
          updatedAt: now,
        });
      }
    });
  }

  private async runOperation(
    operation: SessionDriverOperation,
    externalSignal: AbortSignal | undefined,
    abortFromCaller: () => void,
    isMessageOperation: boolean,
  ): Promise<SessionLedgerReceipt> {
    let inferenceStarted = false;
    let admittedResponse: SessionDriverResponseAdmission | undefined;
    try {
      let admittedOperation = operation;
      if (isMessageOperation) {
        if (operation.maxTokens === undefined) throw invalidWorkerResult();
        const admission = await this.admitMessageResponse(
          "prompt",
          operation.operationId,
          operation.maxTokens,
          operation.signal,
        );
        if (operation.signal.aborted || this.isClosed()) throw aborted();
        admittedOperation = Object.freeze({ ...operation, admission });
        admittedResponse = admission;
        this.activateMessageOperation(operation.operationId);
      }
      if (operation.signal.aborted || this.isClosed()) throw aborted();
      inferenceStarted = true;
      const rawAcknowledgement = await this.managedWorker.dispatch(admittedOperation);
      if (operation.signal.aborted || this.isClosed()) throw aborted();
      let acknowledgement = validateWorkerAcknowledgement(rawAcknowledgement);
      let messageResult: NormalizedMessagesAcknowledgement | undefined;
      if (isMessageOperation) {
        if (!admittedResponse) throw invalidWorkerResult();
        rejectUnenforcedMaxTokensStop(acknowledgement, admittedResponse);
        messageResult = await this.prepareMessageAcknowledgement(acknowledgement, operation.operationId);
        acknowledgement = Object.freeze({ ...acknowledgement, output: messageResult.output });
      }
      const committedMessages = deepFreeze([
        ...operation.messages,
        ...acknowledgement.output,
      ]) as unknown as SessionTranscript;
      const nextTranscript = deepFreeze([
        ...this.transcriptValue,
        ...committedMessages,
      ]) as unknown as SessionTranscript;

      // This synchronous section is the sole commit point. No await is allowed
      // between the final cancellation check and publishing the new ledger.
      const declaresToolBoundary = acknowledgement.stage === "awaiting_tools" ||
        (isRecord(acknowledgement.result) && acknowledgement.result.stopReason === "tool_use");
      if (declaresToolBoundary) {
        this.assertParkedMcpWaitersValid(this.parkedToolBatch?.callIds ?? [], operation.signal);
      }
      if (operation.signal.aborted || this.isClosed()) throw aborted();
      this.transcriptValue = nextTranscript;
      this.revisionValue += 1;
      this.stateValue = acknowledgement.stage === "completed" ? "idle" : "awaiting_tools";
      if (acknowledgement.stage === "completed") {
        this.toolAdmissionMode = "closed";
        this.nextToolOperationId = undefined;
      }
      if (messageResult) {
        this.usageValue = messageResult.usage;
        this.contextOccupancyValue = messageResult.contextOccupancy;
      }

      const receipt: {
        operationId: string;
        stage: "completed" | "awaiting_tools";
        committedMessages: SessionTranscript;
        result?: unknown;
        maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
      } = {
        operationId: operation.operationId,
        stage: acknowledgement.stage,
        committedMessages: cloneFrozen(committedMessages, invalidWorkerResult),
      };
      if (hasOwn(acknowledgement, "result")) {
        receipt.result = cloneFrozen(acknowledgement.result, invalidWorkerResult);
      }
      if (admittedResponse !== undefined) {
        receipt.maxTokensEnforcement = enforcementDiagnostic(admittedResponse);
      }
      return Object.freeze(receipt);
    } catch (error) {
      if (isMessageOperation && !inferenceStarted) {
        const retryable = this.restoreUnadmittedInitialOperation(operation.operationId);
        if (!retryable && this.stateValue !== "closed") await this.cancelParkedCalls();
        throw operation.signal.aborted ? aborted() : normalizeWorkerError(error);
      }
      if (this.stateValue !== "closed") this.stateValue = "interrupted";
      this.toolAdmissionMode = "closed";
      this.nextToolOperationId = undefined;
      await this.cancelParkedCalls();
      const publicError = operation.signal.aborted ? aborted() : normalizeWorkerError(error);
      // A failed/uncertain dispatch is never resumed. Keep the existing lease
      // tracked for explicit close/logout; a replacement worker is never made.
      throw publicError;
    } finally {
      externalSignal?.removeEventListener("abort", abortFromCaller);
      if (this.activeOperationIdValue === operation.operationId) {
        this.activeOperationIdValue = undefined;
        this.activeController = undefined;
        this.activePromise = undefined;
      }
      if (this.activeToolOperation?.operationId === operation.operationId) this.activeToolOperation = undefined;
    }
  }

  private runMessageStream(
    suffix: SessionTranscript,
    acpPrompt: NonNullable<SessionDriverOperation["acpPrompt"]>,
    maxTokens: number,
    externalSignal: AbortSignal | undefined,
    expectedRevision: number,
    continuationTranscript?: SessionTranscript,
  ): AsyncIterable<SessionMessageSemanticEvent> {
    const core = this;
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<SessionMessageSemanticEvent> {
        let operationId: string | undefined;
        let activeOperation: Promise<SessionLedgerReceipt> | undefined;
        const generator = (async function* (): AsyncGenerator<SessionMessageSemanticEvent> {
          if (core.revisionValue !== expectedRevision) {
            throw new InvalidRequestError("The session changed before the Messages stream was consumed.");
          }
          let acceptedContinuation: AcceptedToolBatch | undefined;
          let continuation: SessionDriverToolContinuation | undefined;
          let continuationPlan: SessionDriverToolContinuationPlan | undefined;
          let started: {
            readonly externalSignal: AbortSignal | undefined;
            readonly abortFromCaller: () => void;
            readonly operation: SessionDriverOperation | SessionDriverToolContinuationPlan;
          };
          if (continuationTranscript) {
            acceptedContinuation = core.validateToolResultBatch(continuationTranscript, suffix);
            const startedContinuation = core.startToolContinuation(acceptedContinuation, maxTokens, externalSignal, true);
            continuationPlan = startedContinuation.continuation;
            started = { ...startedContinuation, operation: continuationPlan };
          } else {
            const startedOperation = core.startOperation(suffix, externalSignal, { acpPrompt, maxTokens });
            started = { ...startedOperation, operation: startedOperation.operation };
          }
          let operation: SessionDriverOperation | SessionDriverToolContinuationPlan = started.operation;
          operationId = operation.operationId;

          let resolveActive!: (receipt: SessionLedgerReceipt) => void;
      let rejectActive!: (error: Error) => void;
      let activeSettled = false;
      const active = new Promise<SessionLedgerReceipt>((resolvePromise, rejectPromise) => {
        resolveActive = resolvePromise;
        rejectActive = rejectPromise;
          });
          void active.catch(() => undefined);
          activeOperation = active;
          core.activePromise = active;

          let deliveryAttempted = false;
          let responseAdmitted = false;
          let safeAdmissionFailure = false;
          let admittedResponse: SessionDriverResponseAdmission | undefined;

      let workerIterator: AsyncIterator<SessionDriverStreamEvent> | undefined;
      let workerDone = false;
      let nextPending = false;
      let cleanupPromise: Promise<void> | undefined;
      let cancellationTask: Promise<void> | undefined;
      let completed = false;
      let committed = false;
      let failureInProgress = false;
      let toolBoundaryAcknowledged = false;
      let toolBoundaryParked = false;
      let accumulatedText = "";
      let accumulatedBytes = 0;
      let textEventCount = 0;
      let streamEventCount = 0;

      const settleSuccess = (receipt: SessionLedgerReceipt): void => {
        if (activeSettled) return;
        activeSettled = true;
        resolveActive(receipt);
      };
      const settleFailure = (error: Error): void => {
        if (activeSettled) return;
        activeSettled = true;
        rejectActive(error);
      };
      const clearActive = (): void => {
        externalSignal?.removeEventListener("abort", started.abortFromCaller);
        operation.signal.removeEventListener("abort", onOperationAbort);
        if (core.activeOperationIdValue === operation.operationId) {
          core.activeOperationIdValue = undefined;
          core.activeController = undefined;
          core.activePromise = undefined;
        }
        if (core.activeToolOperation?.operationId === operation.operationId) core.activeToolOperation = undefined;
      };
      const cleanupWorker = (): Promise<void> => {
        if (workerDone || !workerIterator) return Promise.resolve();
        if (cleanupPromise) return cleanupPromise;
        const rawCleanup = (async () => {
          const close = workerIterator?.return;
          if (typeof close === "function") {
            const result = await close.call(workerIterator);
            if (result && result.done === false) {
              throw new ProtocolFailureError("The session stream iterator did not stop during cleanup.");
            }
          }
          workerDone = true;
        })();
        core.trackStreamCleanup(rawCleanup);
        cleanupPromise = boundedWait(
          rawCleanup,
          core.streamCleanupTimeoutMs,
          "The session stream iterator did not close before the cleanup deadline.",
        );
        return cleanupPromise;
      };
      const onOperationAbort = (): void => {
        // Before admission the operation has not dispatched and a continuation
        // batch has not been persisted or released. Let the abortable admission
        // wait unwind without cancelling the parked MCP requests.
        if (!responseAdmitted) return;
        if (!committed && !toolBoundaryParked && core.stateValue !== "closed") {
          core.stateValue = "interrupted";
          core.toolAdmissionMode = "closed";
          core.nextToolOperationId = undefined;
        }
        const cancelWaiters = core.cancelParkedCalls();
        if (nextPending || committed || failureInProgress || toolBoundaryParked) {
          cancellationTask ??= cancelWaiters;
          return;
        }
        cancellationTask ??= (async () => {
          let failure: Error | undefined;
          await cancelWaiters;
          try {
            await cleanupWorker();
          } catch (error) {
            failure = new ProcessFailureError("The session stream iterator could not be closed safely.", { cause: error });
          }
          if (!committed && !toolBoundaryParked) {
            if (core.stateValue !== "closed") core.stateValue = "interrupted";
            settleFailure(failure ?? aborted());
          }
          clearActive();
        })();
      };
      operation.signal.addEventListener("abort", onOperationAbort, { once: true });
      if (externalSignal?.aborted) started.abortFromCaller();

      const nextWorkerEvent = async (): Promise<IteratorResult<SessionDriverStreamEvent>> => {
        if (!workerIterator) throw new ProtocolFailureError("The session driver did not provide a stream iterator.");
        if (operation.signal.aborted) throw aborted();
        let abortListener: (() => void) | undefined;
        const abortedWhileWaiting = new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(aborted());
          operation.signal.addEventListener("abort", abortListener, { once: true });
          if (operation.signal.aborted) abortListener();
        });
        nextPending = true;
        try {
          // Start the worker read synchronously before returning control to a
          // caller that might abort immediately. Deferring `next()` to a
          // microtask can miss the already-fired signal in simple iterators.
          const pending = workerIterator.next();
          return await Promise.race([Promise.resolve(pending), abortedWhileWaiting]);
        } finally {
          nextPending = false;
          if (abortListener) operation.signal.removeEventListener("abort", abortListener);
        }
      };

      try {
        if (operation.signal.aborted) throw aborted();
        if (continuationPlan) {
          const admission = await core.admitMessageResponse(
            "tool_continuation",
            continuationPlan.operationId,
            continuationPlan.maxTokens,
            continuationPlan.signal,
          );
          if (continuationPlan.signal.aborted || core.isClosed()) throw aborted();
          continuation = Object.freeze({ ...continuationPlan, admission });
          admittedResponse = admission;
          operation = continuation;
          core.activateToolContinuation(continuation.operationId);
        } else {
          const promptOperation = operation as SessionDriverOperation;
          if (promptOperation.maxTokens === undefined) throw invalidWorkerResult();
          const admission = await core.admitMessageResponse(
            "prompt",
            promptOperation.operationId,
            promptOperation.maxTokens,
            promptOperation.signal,
          );
          if (promptOperation.signal.aborted || core.isClosed()) throw aborted();
          operation = Object.freeze({ ...promptOperation, admission });
          admittedResponse = admission;
          core.activateMessageOperation(promptOperation.operationId);
        }
        responseAdmitted = true;
        if (!admittedResponse) throw invalidWorkerResult();
        yield Object.freeze({
          type: "admission",
          maxTokensEnforcement: enforcementDiagnostic(admittedResponse),
        });
        if (continuation) {
          await core.driver?.prepareToolContinuation?.(continuation);
          if (continuation.signal.aborted || core.isClosed()) throw aborted();
        }
        if (acceptedContinuation) {
          await core.saveAndDeliverToolResults(acceptedContinuation, operation.signal);
          deliveryAttempted = true;
          await core.awaitMcpDeliveries(acceptedContinuation.batch, operation.signal);
        }
        const source = continuation
          ? core.driver?.streamTools?.(continuation)
          : core.managedWorker.stream?.(operation as SessionDriverOperation);
        if (!source || typeof source[Symbol.asyncIterator] !== "function") {
          throw new ProtocolFailureError("The session driver did not return an async stream iterator.");
        }
        workerIterator = source[Symbol.asyncIterator]();
        if (!workerIterator || typeof workerIterator.next !== "function") {
          throw new ProtocolFailureError("The session driver returned an invalid stream iterator.");
        }

        let finalAcknowledgement: SessionDriverAcknowledgement | undefined;
        let normalized: NormalizedMessagesAcknowledgement | undefined;
        while (true) {
          const result = await nextWorkerEvent();
          if (result.done) {
            workerDone = true;
            if (!completed) {
              throw new ProtocolFailureError("The session stream ended without an explicit terminal acknowledgement.");
            }
            break;
          }
          streamEventCount += 1;
          if (streamEventCount > MAX_STREAM_EVENTS) {
            throw new ProtocolFailureError("The session stream exceeded the bounded event limit.");
          }
          const event = validateDriverStreamEvent(result.value);
          if (completed) {
            throw new ProtocolFailureError("The session stream emitted data after its terminal acknowledgement.");
          }
          if (event.type === "text") {
            const bytes = Buffer.byteLength(event.text, "utf8");
            if (accumulatedBytes + bytes > MAX_STREAM_TEXT_BYTES) {
              throw new ProtocolFailureError("The session stream exceeded the bounded text output limit.");
            }
            accumulatedBytes += bytes;
            accumulatedText += event.text;
            textEventCount += 1;
            yield Object.freeze({ type: "text", text: event.text });
            continue;
          }

          completed = true;
          finalAcknowledgement = event.acknowledgement;
          if (!admittedResponse) throw invalidWorkerResult();
          rejectUnenforcedMaxTokensStop(finalAcknowledgement, admittedResponse);
          const resultPayload = finalAcknowledgement.result;
          toolBoundaryAcknowledged = finalAcknowledgement.stage === "awaiting_tools" ||
            (isRecord(resultPayload) && resultPayload.stopReason === "tool_use");
          if (toolBoundaryAcknowledged) {
            normalized = await core.prepareMessageAcknowledgement(
              finalAcknowledgement,
              operation.operationId,
              acceptedContinuation?.batch,
              true,
            );
            finalAcknowledgement = Object.freeze({ ...finalAcknowledgement, output: normalized.output });
          } else {
            normalized = await core.prepareMessageAcknowledgement(
              finalAcknowledgement,
              operation.operationId,
              acceptedContinuation?.batch,
              true,
            );
          }
          const finalOutput = normalized.output[0];
          const finalContent = finalOutput?.content;
          const acknowledgementHasText = Array.isArray(finalContent) &&
            finalContent.some((block) => isRecord(block) && block.type === "text");
          if (acknowledgementHasText !== (textEventCount > 0)) {
            throw new ProtocolFailureError("The incremental text-block presence differs from the acknowledged response.");
          }
          const finalText = typeof finalContent === "string"
            ? finalContent
            : Array.isArray(finalContent)
              ? finalContent.filter((block) => isRecord(block) && block.type === "text")
                .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "").join("")
              : undefined;
          if (finalText === undefined || finalText !== accumulatedText) {
            throw new ProtocolFailureError("The incremental text differs from the acknowledged assistant response.");
          }
          if (!toolBoundaryAcknowledged && textEventCount === 0) {
            throw new ProtocolFailureError("The session stream completed without an assistant text event.");
          }
          continue;
        }

        if (toolBoundaryAcknowledged) {
          if (operation.signal.aborted || core.isClosed()) throw aborted();
          if (!normalized || !finalAcknowledgement) throw invalidWorkerResult();
          core.assertParkedMcpWaitersValid(core.parkedToolBatch?.callIds ?? [], operation.signal);
          for (const event of normalized.events) {
            if (event.type === "tool_use") {
              core.assertParkedMcpWaitersValid(core.parkedToolBatch?.callIds ?? [], operation.signal);
              yield event;
            }
          }
          const usageEvent = normalized.events.find((event) => event.type === "usage");
          const stopEvent = normalized.events.find((event) => event.type === "stop");
          if (!usageEvent || usageEvent.type !== "usage" || !stopEvent || stopEvent.type !== "stop") {
            throw new ProtocolFailureError("The tool stream omitted usage or terminal stop metadata.");
          }
          const diagnostic = enforcementDiagnostic(admittedResponse!);
          yield Object.freeze({ ...usageEvent, maxTokensEnforcement: diagnostic });
          if (operation.signal.aborted || core.isClosed()) throw aborted();
          yield stopEvent;
          if (operation.signal.aborted || core.isClosed()) throw aborted();
          const committedMessages = deepFreeze([
            ...operation.messages,
            ...normalized.output,
          ]) as unknown as SessionTranscript;
          const nextTranscript = deepFreeze([
            ...core.transcriptValue,
            ...committedMessages,
          ]) as unknown as SessionTranscript;
          core.assertParkedMcpWaitersValid(core.parkedToolBatch?.callIds ?? [], operation.signal);
          core.transcriptValue = nextTranscript;
          core.revisionValue += 1;
          core.stateValue = "awaiting_tools";
          core.usageValue = normalized.usage;
          core.contextOccupancyValue = normalized.contextOccupancy;
          const receipt: SessionLedgerReceipt = Object.freeze({
            operationId: operation.operationId,
            stage: "awaiting_tools",
            committedMessages: cloneFrozen(committedMessages, invalidWorkerResult),
            ...(hasOwn(finalAcknowledgement, "result")
              ? { result: cloneFrozen(finalAcknowledgement.result, invalidWorkerResult) }
              : {}),
            maxTokensEnforcement: diagnostic,
          });
          committed = true;
          toolBoundaryParked = true;
          settleSuccess(receipt);
          clearActive();
          return;
        }
        if (!normalized || !finalAcknowledgement) {
          throw new ProtocolFailureError("The session stream ended without a normalized completion.");
        }

        const usageEvent = normalized.events.find((event) => event.type === "usage");
        const stopEvent = normalized.events.find((event) => event.type === "stop");
        if (!usageEvent || usageEvent.type !== "usage" || !stopEvent || stopEvent.type !== "stop") {
          throw new ProtocolFailureError("The normalized stream omitted terminal usage or stop metadata.");
        }
        if (operation.signal.aborted || core.isClosed()) throw aborted();
        if (!admittedResponse) throw invalidWorkerResult();
        const diagnostic = enforcementDiagnostic(admittedResponse);
        yield Object.freeze({ ...usageEvent, maxTokensEnforcement: diagnostic });
        if (operation.signal.aborted || core.isClosed()) throw aborted();
        yield stopEvent;

        // The consumer must request the terminal raw message_stop event before
        // the facade resumes this generator. Returning after any earlier event
        // therefore aborts without reaching the sole ledger commit point.
        if (operation.signal.aborted || core.isClosed()) throw aborted();
        const acknowledgement = validateWorkerAcknowledgement(finalAcknowledgement);
        const committedMessages = deepFreeze([
          ...operation.messages,
          ...normalized.output,
        ]) as unknown as SessionTranscript;
        const nextTranscript = deepFreeze([
          ...core.transcriptValue,
          ...committedMessages,
        ]) as unknown as SessionTranscript;
        if (operation.signal.aborted || core.isClosed()) throw aborted();
        core.transcriptValue = nextTranscript;
        core.revisionValue += 1;
        core.stateValue = acknowledgement.stage === "awaiting_tools" ? "awaiting_tools" : "idle";
        if (acknowledgement.stage === "completed") {
          core.toolAdmissionMode = "closed";
          core.nextToolOperationId = undefined;
        }
        core.usageValue = normalized.usage;
        core.contextOccupancyValue = normalized.contextOccupancy;
        const receipt: SessionLedgerReceipt = Object.freeze({
          operationId: operation.operationId,
          stage: acknowledgement.stage,
          committedMessages: cloneFrozen(committedMessages, invalidWorkerResult),
          ...(hasOwn(acknowledgement, "result")
            ? { result: cloneFrozen(acknowledgement.result, invalidWorkerResult) }
            : {}),
          maxTokensEnforcement: diagnostic,
        });
        committed = true;
        settleSuccess(receipt);
        clearActive();
      } catch (error) {
        if (!responseAdmitted) {
          safeAdmissionFailure = true;
          const retryable = continuationPlan
            ? core.restoreUnadmittedToolContinuation(continuationPlan.operationId, acceptedContinuation!.batch)
            : core.restoreUnadmittedInitialOperation(operation.operationId);
          if (!retryable && core.stateValue !== "closed") await core.cancelParkedCalls();
          const admissionError = operation.signal.aborted ? aborted() : normalizeWorkerError(error);
          settleFailure(admissionError);
          throw admissionError;
        }
        if (toolBoundaryParked) throw error;
        if (!committed && core.stateValue !== "closed") core.stateValue = "interrupted";
        core.toolAdmissionMode = "closed";
        core.nextToolOperationId = undefined;
        const publicError = operation.signal.aborted ? aborted() : normalizeWorkerError(error);
        let finalError = publicError;
        failureInProgress = true;
        await core.cancelParkedCalls();
        if (acceptedContinuation && deliveryAttempted) {
          const stillAttempted = acceptedContinuation.batch.callIds.every((callId) =>
            core.receipts.find((receipt) => receipt.callId === callId)?.resultState === "delivery_attempted");
          if (stillAttempted) {
            try { await core.finishToolDelivery(acceptedContinuation.batch, "uncertain"); } catch { /* receipt remains conservative */ }
          }
        }
        if (!operation.signal.aborted) {
          // A failed stream cannot be replayed; signal the worker before asking
          // its iterator to release any in-flight resources.
          core.activeController?.abort();
        }
        try {
          await cleanupWorker();
        } catch (cleanupError) {
          finalError = new ProcessFailureError("The session stream iterator could not be closed safely.", { cause: cleanupError });
        }
        settleFailure(finalError);
        throw finalError;
      } finally {
        if (!committed && !toolBoundaryParked && !safeAdmissionFailure) {
          if (!operation.signal.aborted) core.activeController?.abort();
          if (core.stateValue !== "closed") core.stateValue = "interrupted";
          core.toolAdmissionMode = "closed";
          core.nextToolOperationId = undefined;
          await core.cancelParkedCalls();
          try {
            await cleanupWorker();
          } catch (cleanupError) {
            const error = new ProcessFailureError("The session stream iterator could not be closed safely.", { cause: cleanupError });
            settleFailure(error);
            clearActive();
            throw error;
          }
          settleFailure(aborted());
        }
        if (cancellationTask) await cancellationTask;
        clearActive();
          }
        })();
        const cancel = (): void => {
          if (operationId !== undefined && core.activeOperationIdValue === operationId) {
            core.activeController?.abort();
          }
        };
        const iterator: AsyncIterableIterator<SessionMessageSemanticEvent> = {
          [Symbol.asyncIterator]() { return this; },
          next(value?: unknown) { return generator.next(value); },
          async return(value?: unknown) {
            cancel();
            const result = await generator.return(value as never);
            await activeOperation?.catch((error: unknown) => {
              if (error instanceof ProcessFailureError || error instanceof RequestTimeoutError) throw error;
            });
            return result;
          },
          async throw(error?: unknown) {
            cancel();
            const result = await generator.throw(error);
            await activeOperation?.catch((failure: unknown) => {
              if (failure instanceof ProcessFailureError || failure instanceof RequestTimeoutError) throw failure;
            });
            return result;
          },
        };
        return iterator;
      },
    };
  }

  private async dispatch(operation: SessionDriverOperation): Promise<SessionDriverAcknowledgement> {
    if (this.stateValue === "closed" || !this.driver) {
      throw new SessionNotFoundError("The session worker is closed.");
    }
    return this.driver.dispatch(operation);
  }

  private stream(operation: SessionDriverOperation): AsyncIterable<SessionDriverStreamEvent> {
    if (this.stateValue === "closed" || !this.driver || typeof this.driver.stream !== "function") {
      throw new SessionNotFoundError("The session streaming worker is not available.");
    }
    return this.driver.stream(operation);
  }

  private trackStreamCleanup(promise: Promise<void>): void {
    this.pendingStreamCleanups.add(promise);
    void promise.then(
      () => this.pendingStreamCleanups.delete(promise),
      () => this.pendingStreamCleanups.delete(promise),
    ).catch(() => undefined);
  }

  private async awaitStreamCleanups(deadline: number): Promise<void> {
    const pending = [...this.pendingStreamCleanups];
    if (pending.length === 0) return;
    try {
      await boundedWaitUntil(
        Promise.all(pending).then(() => undefined),
        deadline,
        "Session stream cleanup did not finish before the shutdown deadline.",
      );
    } catch (error) {
      throw new ProcessFailureError("Session stream cleanup remains pending or failed.", { cause: error });
    }
  }

  private async closeDriverBounded(deadline: number): Promise<void> {
    if (this.driverClosed) return;
    let closing = this.driverCloseRawPromise;
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        await this.driver?.close();
      });
      this.driverCloseRawPromise = closing;
      const current = closing;
      void closing.then(
        () => {
          this.driverClosed = true;
          if (this.driverCloseRawPromise === current) this.driverCloseRawPromise = undefined;
        },
        () => {
          if (this.driverCloseRawPromise === current) this.driverCloseRawPromise = undefined;
        },
      ).catch(() => undefined);
    }
    await boundedWaitUntil(
      closing,
      deadline,
      "The session worker did not close before the shutdown deadline.",
    );
  }

  private isClosed(): boolean {
    return this.stateValue === "closed";
  }

  private closeFromRuntimeManager(): Promise<void> {
    this.markClosed();
    if (this.driverClosePromise) return this.driverClosePromise;
    const closing = (async () => {
      const deadline = Date.now() + this.streamCleanupTimeoutMs;
      const toolWaiters = boundedWaitUntil(
        this.cancelParkedCalls(),
        deadline,
        "Session tool waiters did not settle before the shutdown deadline.",
      );
      const active: Promise<void> = this.activePromise?.then(() => undefined, () => undefined) ?? Promise.resolve();
      const activeWait = boundedWaitUntil(
        active,
        deadline,
        "The active session stream did not settle before the shutdown deadline.",
      );
      const toolServerClose = boundedWaitUntil(
        this.managedToolRegistry.close(),
        deadline,
        "The session MCP tool server did not close before the shutdown deadline.",
      );
      const [driverResult, activeResult, toolServerResult, toolWaiterResult] = await Promise.allSettled([
        this.closeDriverBounded(deadline),
        activeWait,
        toolServerClose,
        toolWaiters,
      ]);
      let closeFailed =
        driverResult.status === "rejected" ||
        activeResult.status === "rejected" ||
        toolServerResult.status === "rejected" ||
        toolWaiterResult.status === "rejected";
      let closeFailure: unknown = driverResult.status === "rejected"
        ? driverResult.reason
        : activeResult.status === "rejected"
          ? activeResult.reason
          : toolServerResult.status === "rejected"
            ? toolServerResult.reason
            : toolWaiterResult.status === "rejected"
              ? toolWaiterResult.reason
            : undefined;
      try {
        await this.awaitStreamCleanups(deadline);
      } catch (error) {
        closeFailed = true;
        closeFailure ??= error;
      }
      if (closeFailed) {
        this.driverClosePromise = undefined;
        throw new ProcessFailureError("The session worker could not be closed safely.", { cause: closeFailure });
      }
      this.onCleanupComplete();
    })();
    this.driverClosePromise = closing;
    return closing;
  }

  private markClosed(): void {
    if (this.stateValue !== "closed") {
      this.stateValue = "closed";
      this.activeController?.abort();
    }
  }
}

interface PendingStartupCleanupFailure {
  readonly session: SessionLedgerImpl;
  readonly error: Error;
}

interface PendingSessionCreation {
  readonly promise: Promise<SessionLedger>;
  cleanupFailure?: PendingStartupCleanupFailure;
}

function ensureProfile(profile: ProfileContext, accountId: string): void {
  if (!profile || profile.accountId !== accountId || typeof profile.storageRoot !== "string") {
    throw new InternalError("The account profile could not be validated for a session.");
  }
}

function sameStorageRoot(left: ProfileContext, right: ProfileContext): boolean {
  return resolve(left.storageRoot) === resolve(right.storageRoot);
}

function normalizeStartupError(error: unknown): Error {
  if (
    error instanceof SessionBusyError ||
    error instanceof AccountNotFoundError ||
    error instanceof AuthenticationError ||
    error instanceof InvalidRequestError ||
    error instanceof InternalError ||
    error instanceof ProcessFailureError ||
    error instanceof ProtocolFailureError ||
    error instanceof ProviderError ||
    error instanceof RequestTimeoutError ||
    error instanceof SessionNotFoundError ||
    error instanceof UnsupportedFeatureError
  ) {
    return error;
  }
  return new ProcessFailureError("The session worker could not be started.");
}

/**
 * Bind S4 session ledgers to one explicit registry account. The supplied
 * worker factory is the only path to dispatch; there is no default ACP or
 * inference implementation.
 */
export function createProfileSessionEngine(
  accounts: AccountProfileRegistry,
  accountId: string,
  options: ProfileSessionEngineOptions,
): ProfileSessionEngine {
  if (!accounts || typeof accounts.get !== "function" || typeof accountId !== "string" ||
      !options || typeof options !== "object" || typeof options.driverFactory !== "function") {
    throw invalidRequest();
  }
  const workerManager: ProfileRuntimeManager = options.workerManager;
  if (
    !workerManager ||
    typeof workerManager.connect !== "function" ||
    typeof workerManager.closeProfile !== "function"
  ) {
    throw invalidRequest();
  }
  const maxTokensPolicy: MaxTokensPolicy = options.maxTokensPolicy ?? "strict";
  if (maxTokensPolicy !== "strict" && maxTokensPolicy !== "allow-unenforced-max-tokens") {
    throw invalidRequest("maxTokensPolicy is invalid.");
  }
  const cleanupTimeoutMs = streamCleanupTimeout(options.streamCleanupTimeoutMs);
  let engineClosed = false;
  let closePromise: Promise<void> | undefined;
  const sessions = new Set<SessionLedgerImpl>();
  const pendingCreations = new Set<PendingSessionCreation>();

  async function getProfile(): Promise<ProfileContext> {
    const profile = await accounts.get(accountId);
    ensureProfile(profile.context, accountId);
    return profile.context;
  }

  async function createSession(
    sessionOptions: SessionCreateOptions,
    recordCleanupFailure: (failure: PendingStartupCleanupFailure) => void,
  ): Promise<SessionLedger> {
    if (engineClosed) throw new SessionNotFoundError("The account session engine is closed.");
    const configuration = validateConfiguration(sessionOptions);
    const toolCatalog = compileCallerToolCatalog(configuration.tools);
    const profile = await getProfile();
    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    let core!: SessionLedgerImpl;
    core = new SessionLedgerImpl(
      accountId,
      sessionId,
      configuration,
      toolCatalog,
      maxTokensPolicy,
      profile.storageRoot,
      cleanupTimeoutMs,
      () => sessions.delete(core),
    );

    try {
      const lease = await workerManager.connect(profile, async () => {
        const currentProfile = await getProfile();
        if (!sameStorageRoot(profile, currentProfile)) {
          throw new InternalError("The account profile changed while the session worker was starting.");
        }
        const driverContext: SessionDriverContext = Object.freeze({
          accountId,
          sessionId,
          profile: currentProfile,
          configuration,
          maxTokensPolicy,
        });
        const driver = await options.driverFactory(driverContext);
        if (!driver || typeof driver.dispatch !== "function" || typeof driver.close !== "function") {
          throw new ProcessFailureError("The session worker factory returned an invalid worker.");
        }
        core.setDriver(driver);
        return core.managedWorker;
      });
      core.attachLease(lease);
      const startupError = core.driverSetupError;
      if (startupError || core.state === "closed" || engineClosed) {
        // Keep cleanup owned by the engine before attempting it. A failed
        // close is surfaced to both this create call and a shutdown that was
        // waiting for this startup; a later engine.close() can retry it.
        sessions.add(core);
        try {
          await core.close();
        } catch (error) {
          recordCleanupFailure({ session: core, error: normalizeStartupError(error) });
          throw error;
        }
        if (startupError) throw startupError;
        throw new SessionNotFoundError("The session was closed while its worker was starting.");
      }
      sessions.add(core);
      ACCOUNT_BOUND_SESSIONS.add(core);
      return core;
    } catch (error) {
      throw normalizeStartupError(error);
    }
  }

  function create(sessionOptions: SessionCreateOptions): Promise<SessionLedger> {
    if (engineClosed) return Promise.reject(new SessionNotFoundError("The account session engine is closed."));
    let record!: PendingSessionCreation;
    const pending = createSession(sessionOptions, (failure) => {
      record.cleanupFailure = failure;
    });
    record = { promise: pending };
    pendingCreations.add(record);
    void pending.finally(() => pendingCreations.delete(record)).catch(() => undefined);
    return pending;
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    engineClosed = true;
    const creating = [...pendingCreations];
    const closing = (async () => {
      await Promise.allSettled(creating.map(({ promise }) => promise));
      const startupFailures = creating.flatMap((record) => record.cleanupFailure ? [record.cleanupFailure] : []);
      const startupFailedSessions = new Set(startupFailures.map(({ session }) => session));
      const current = [...sessions];
      const results = await Promise.allSettled(
        current.filter((session) => !startupFailedSessions.has(session)).map((session) => session.close()),
      );
      if (startupFailures.length > 0 || results.some((result) => result.status === "rejected")) {
        const failure = startupFailures[0]?.error ?? results.find((result) => result.status === "rejected");
        throw new ProcessFailureError(
          "One or more account session workers could not be closed safely.",
          { cause: failure && "reason" in failure ? failure.reason : failure },
        );
      }
    })();
    closePromise = closing;
    try {
      await closing;
    } catch (error) {
      closePromise = undefined;
      throw error;
    }
  }

  async function recoveryDiagnostics(): Promise<readonly SessionToolCallReceipt[]> {
    const profile = await getProfile();
    return readToolRecoveryDiagnostics(profile.storageRoot, accountId);
  }

  return Object.freeze({ accountId, create, recoveryDiagnostics, close });
}
