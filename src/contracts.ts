import type Anthropic from "@anthropic-ai/sdk";
import type { ProfileContext } from "./profiles.js";
import type { ProfileAuth } from "./auth.js";

/** Anthropic Messages response type. */
export type Message = Anthropic.Messages.Message;

/** Anthropic raw streaming event type; events are not accumulated or transformed here. */
export type RawMessageStreamEvent = Anthropic.Messages.RawMessageStreamEvent;

/** System prompt configuration fixed when the session is created. */
export type SessionSystemPrompt = NonNullable<
  Anthropic.Messages.MessageCreateParamsNonStreaming["system"]
>;

/** A caller-managed custom tool in the session's fixed tool catalog. */
export type SessionTool = Anthropic.Messages.Tool;

/** Upstream request vocabulary; S5/S6 runtime validation enforces a narrow subset. */
type SessionPinnedFields = {
  /** The model is selected once when the session is created. */
  readonly model?: never;
  /** System instructions are fixed for the lifetime of the session. */
  readonly system?: never;
  /** The tool catalog is fixed for the lifetime of the session. */
  readonly tools?: never;
};

export type MessageCreateParamsNonStreaming = Omit<
  Anthropic.Messages.MessageCreateParamsNonStreaming,
  "model" | "system" | "tools" | "max_tokens"
> &
  SessionPinnedFields & { readonly max_tokens?: number };
export type MessageCreateParamsStreaming = Omit<
  Anthropic.Messages.MessageCreateParamsStreaming,
  "model" | "system" | "tools" | "max_tokens"
> &
  SessionPinnedFields & { readonly max_tokens?: number };

export interface MessageCreateOptions {
  readonly signal?: AbortSignal;
}

/** Legacy policy option retained for compatibility; it never makes ACP enforce a token bound. */
export type MaxTokensPolicy = "strict" | "allow-unenforced-max-tokens";

/** A permission option exposed by ACP. ACP option names/metadata are not forwarded. */
export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly kind: AcpPermissionOptionKind;
}

/** Bounded display-only tool details safe to provide to a permission callback. */
export interface AcpPermissionRequestDetails {
  readonly handling: "omitted" | "sanitized" | "redacted";
  /** True when a sensitive-looking title/name was replaced with `[redacted]`. */
  readonly redacted: boolean;
  /** True when a safe title/name was shortened to the supported UTF-8 byte bound. */
  readonly truncated: boolean;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  readonly status?: "pending" | "in_progress" | "completed" | "failed";
}

/**
 * Immutable, bounded context for an ambiguous ACP permission request. ACP
 * session identity is correlation only: `origin` is never proof of a caller
 * tool or trusted executable. Raw input/output, locations, metadata and
 * option names are omitted; only bounded sanitized/redacted display details
 * and offered option IDs/kinds may be surfaced. Descriptive title/name fields
 * are limited to 256 UTF-8 bytes. Known SDK endpoint authorization values and
 * their bearer tokens are exact-redacted before truncation; other sensitive
 * value/URL detection is heuristic, so arbitrary model-supplied text cannot
 * be guaranteed fully scrubbed. String identifiers/option IDs are bounded to
 * 512 UTF-8 bytes and the offered-option list to 64 entries.
 */
export interface AcpPermissionRequestContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly remoteSessionId: string;
  readonly requestId: string | number | null;
  readonly toolCallId: string;
  readonly origin: "unverified";
  readonly details: AcpPermissionRequestDetails;
  readonly offeredOptions: readonly AcpPermissionOption[];
  readonly signal: AbortSignal;
}

/** The handler may deny, or select an exact offered one-shot allow option. */
export type AcpPermissionDecision =
  | { readonly action: "deny" }
  | { readonly action: "select"; readonly optionId: string };

/** Caller callback for the opt-in one-shot ACP permission path. */
export type AcpPermissionHandler = (
  context: AcpPermissionRequestContext,
) => AcpPermissionDecision | Promise<AcpPermissionDecision>;

/**
 * Built-in ACP permission policy. Omitting this option selects `mode: "auto"`:
 * the driver automatically chooses the first offered `allow_once` and denies
 * when none is offered; it never selects `allow_always` and does not invoke a
 * caller callback or ask this SDK's caller for approval. `mode: "deny"`
 * explicitly denies.
 * The callback form preserves the existing opt-in one-shot decision API.
 *
 * ACP origin is unverified. Automatic approval can authorize arbitrary
 * agent-side effects; the SDK never requests a persistent `allow_always` grant,
 * and cancellation cannot retract approval bytes already written or grants
 * already persisted by the ACP agent. This SDK cannot revoke a prior written
 * approval or ACP-side persistent grant; `mode: "deny"` affects subsequent
 * requests only. The ACP agent may have its own prompting or persistence
 * behavior, which this option does not control.
 *
 * This option configures only the built-in ACP driver. A custom
 * `sessionDriverFactory` owns its permission policy; explicitly combining a
 * custom driver with this option is rejected.
 *
 * The timeout defaults to 10 seconds and is bounded to 1–60,000 ms. A timeout
 * cancels the ACP decision and, in callback mode, aborts the callback signal.
 * A monotonic elapsed deadline is checked after callback execution (when
 * applicable) and again at the final outbound permission write boundary, even
 * if the timer was delayed. The owning operation, terminal state, and driver
 * ownership are revalidated while the response is serialized immediately
 * before `stdin.write()`. Once that write accepts the frame, later
 * cancellation cannot retract bytes already buffered by the transport.
 * Callback decisions are never assumed to prove request origin. Handlers must
 * not block the JavaScript thread; synchronous code cannot be preempted.
 */
export type AcpPermissionsOptions =
  | {
      /** Automatically choose the first offered allow_once; deny if unavailable. */
      readonly mode: "auto";
      readonly timeoutMs?: number;
      readonly onRequest?: never;
    }
  | {
      /** Explicitly reject permission requests. */
      readonly mode: "deny";
      readonly timeoutMs?: number;
      readonly onRequest?: never;
    }
  | {
      /** Caller-managed callback; it can select only an exact offered allow_once. */
      readonly mode?: never;
      readonly onRequest: AcpPermissionHandler;
      readonly timeoutMs?: number;
    };

/** Frozen SDK-internal normalization; not part of the package-root API. */
export type AcpPermissionPolicy =
  | { readonly mode: "auto"; readonly timeoutMs: number }
  | { readonly mode: "deny"; readonly timeoutMs: number }
  | { readonly mode: "callback"; readonly onRequest: AcpPermissionHandler; readonly timeoutMs: number };

/** Truthful outcomes for an output-token bound or an explicitly unbounded request. */
export type MaxTokensEnforcementOutcome =
  | {
      readonly outcome: "enforced";
      readonly reason: "driver-admitted-requested-bound";
    }
  | {
      readonly outcome: "ignored";
      readonly reason: "backend-does-not-enforce-requested-bound";
    }
  | {
      readonly outcome: "unbounded";
      readonly reason: "no-output-token-bound-requested";
    };

/** Per-operation enforcement diagnostics; token usage is reported separately. */
type MaxTokensEnforcementDiagnosticBase = {
  readonly accountId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly kind: "prompt" | "tool_continuation";
  readonly policy: MaxTokensPolicy;
};

export type MaxTokensEnforcementDiagnostic = MaxTokensEnforcementDiagnosticBase & (
  | {
      readonly requestedMaxTokens: number;
      readonly outcome: "enforced";
      readonly reason: "driver-admitted-requested-bound";
    }
  | {
      readonly requestedMaxTokens: number;
      readonly outcome: "ignored";
      readonly reason: "backend-does-not-enforce-requested-bound";
    }
  | {
      readonly requestedMaxTokens?: never;
      readonly outcome: "unbounded";
      readonly reason: "no-output-token-bound-requested";
    }
);

/** Parameters fixed when constructing an account-bound session. */
export interface SessionCreateOptions {
  readonly model: string;
  readonly cwd: string;
  readonly system?: SessionSystemPrompt;
  readonly tools?: SessionTool[];
}

/** Anthropic Messages facade intended to be bound to one session. */
export interface SessionMessages {
  create(
    request: MessageCreateParamsNonStreaming,
    options?: MessageCreateOptions,
  ): Promise<Message>;
  create(
    request: MessageCreateParamsStreaming,
    options?: MessageCreateOptions,
  ): Promise<AsyncIterable<RawMessageStreamEvent>>;
}

/** A handle to an account's session-creation capability. */
export interface AccountSessions {
  create(options: SessionCreateOptions): Promise<Session>;
}

/** Optional cancellation for an account metadata request. */
export interface AccountDataRequestOptions {
  readonly signal?: AbortSignal;
}

/** Verified identity returned by Google's OAuth user-info endpoint. */
export interface AccountIdentity {
  readonly accountId: string;
  readonly providerId: string;
  readonly email: string;
  readonly emailVerified: true;
}

export interface AccountIdentityApi {
  get(options?: AccountDataRequestOptions): Promise<AccountIdentity>;
}

/** A safe, bounded projection of one provider quota bucket. */
export interface AccountQuotaBucket {
  readonly modelId?: string;
  readonly remainingFraction: number;
  readonly resetTime?: string;
  readonly window?: string | number | AccountQuotaWindow;
}

/** The supported scalar fields of a provider quota window descriptor. */
export interface AccountQuotaWindow {
  readonly startTime?: string;
  readonly endTime?: string;
  readonly duration?: string | number;
  readonly unit?: string;
  readonly type?: string;
}

export interface AccountQuotaGroup {
  readonly id?: string;
  readonly displayName?: string;
  readonly buckets: readonly AccountQuotaBucket[];
}

export interface AccountQuotaSummary {
  readonly accountId: string;
  readonly observedAt: string;
  readonly groups: readonly AccountQuotaGroup[];
}

export interface AccountQuotaApi {
  summary(options?: AccountDataRequestOptions): Promise<AccountQuotaSummary>;
}

/** One model value advertised by the active ACP session/new response. */
export interface AccountModel {
  /** Exact model selector value advertised by ACP; suitable for sessions.create(). */
  readonly id: string;
  readonly name?: string;
  readonly group?: string;
}

export interface AccountModelListOptions extends AccountDataRequestOptions {
  /** Working directory supplied to the temporary, non-inference ACP session. */
  readonly cwd: string;
}

export interface AccountModelCatalog {
  list(options: AccountModelListOptions): Promise<readonly AccountModel[]>;
}

/** An explicit account-bound session. */
export interface Account {
  readonly id: string;
  readonly auth: ProfileAuth;
  readonly sessions: AccountSessions;
  readonly identity: AccountIdentityApi;
  readonly quota: AccountQuotaApi;
  readonly models: AccountModelCatalog;
}

/**
 * Provenance for usage associated with an operation. Only the `reported`
 * variant carries token counts; unknown usage is never represented as a count.
 */
export type UsageProvenance =
  | {
      readonly kind: "reported";
      readonly source: string;
      /** Anthropic input_tokens: total input minus reported cached input. */
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      /** Included only when ACP explicitly reports the count. */
      readonly thinkingTokens?: number;
    }
  | {
      readonly kind: "unknown";
      readonly reason?: string;
    };

/** Context occupancy is diagnostic state, not per-operation token usage. */
export interface ContextOccupancyDiagnostic {
  readonly tokens: number;
  readonly source: string;
}

/**
 * Safe aggregate counts of ACP v1 non-message activity observed by the built-in
 * driver. No tool/thought payload, identifier, path, or metadata is retained.
 * Counts saturate at 65,536; `capped` indicates at least one later event was
 * omitted from its count.
 */
export interface AcpActivityDiagnostics {
  readonly agentThoughtChunks: number;
  readonly toolCalls: number;
  readonly toolCallUpdates: number;
  readonly capped: boolean;
}

/** A read-only diagnostics snapshot, kept separate from Anthropic Message data. */
export interface SessionDiagnosticsSnapshot {
  readonly usage: UsageProvenance;
  readonly contextOccupancy?: ContextOccupancyDiagnostic;
  /** Built-in ACP activity counts only; never caller-facing tool or thought content. */
  readonly acpActivity?: AcpActivityDiagnostics;
  /** Present only when a Messages operation has a truthful enforcement record. */
  readonly maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
}

/** Runtime diagnostics access point, separate from Anthropic Message payloads. */
export interface SessionDiagnostics {
  snapshot(): Promise<SessionDiagnosticsSnapshot>;
  /** Read-only SDK receipt records. Results may contain caller-supplied tool output. */
  toolHandoffs(): Promise<readonly SessionToolCallReceipt[]>;
}

/** A session with a pinned model/system/tool catalog and ordered operations. */
export interface Session {
  /** Account and session identity assigned by the owning SDK profile engine. */
  readonly accountId: string;
  readonly sessionId: string;
  /** Immutable model/system/tool configuration selected at session creation. */
  readonly configuration: SessionConfiguration;
  /** Explicit worker capability assertions for this session. */
  readonly capabilities: SessionDriverCapabilities;
  readonly messages: SessionMessages;
  readonly diagnostics: SessionDiagnostics;
  /** Caller-tool registry bound to the session's immutable catalog. */
  readonly tools: SessionToolRegistry;
  /** Close this session's worker and reject further operations. */
  close(): Promise<void>;
}

/** Messages transcript accepted by the S4 ledger. Content is retained as JSON. */
export type SessionTranscript = readonly Anthropic.Messages.MessageParam[];

/** Lifecycle state for the bounded, non-recovering S4 session engine. */
export type SessionState =
  | "idle"
  | "running"
  | "awaiting_tools"
  | "interrupted"
  | "closed";

/** A frozen configuration copied at session creation. */
export interface SessionConfiguration {
  readonly model: string;
  readonly cwd: string;
  readonly system?: SessionSystemPrompt;
  readonly tools?: readonly SessionTool[];
}

/** Optional operation-level assertions; supplied values must match the pin. */
export type SessionConfigurationAssertion = Partial<SessionConfiguration>;

/** Worker acknowledgement required before output is committed at an explicit stage. */
export type SessionOperationStage = "completed" | "awaiting_tools";

export interface SessionDriverContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly profile: ProfileContext;
  readonly configuration: SessionConfiguration;
  /** SDK-pinned policy; an injected driver cannot override the SDK's policy. */
  readonly maxTokensPolicy: MaxTokensPolicy;
}

/** A single response round admitted under the session's operation policy. */
type SessionDriverResponseAdmissionBase = {
  readonly kind: "prompt" | "tool_continuation";
  readonly operationId: string;
  readonly accountId: string;
  readonly sessionId: string;
  /** SDK policy pinned by the owning session engine. */
  readonly policy: MaxTokensPolicy;
};

export type SessionDriverResponseAdmission = SessionDriverResponseAdmissionBase & (
  | {
      readonly maxTokens: number;
      readonly outcome: "enforced";
      readonly reason: "driver-admitted-requested-bound";
    }
  | {
      readonly maxTokens: number;
      readonly outcome: "ignored";
      readonly reason: "backend-does-not-enforce-requested-bound";
    }
  | {
      readonly maxTokens?: never;
      readonly outcome: "unbounded";
      readonly reason: "no-output-token-bound-requested";
    }
);

/** Admission is a pre-inference reservation and must not start the response. */
export interface SessionDriverResponseAdmissionRequest {
  readonly kind: "prompt" | "tool_continuation";
  readonly operationId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly maxTokens?: number;
  /** SDK policy pinned by the owning session engine. */
  readonly policy: MaxTokensPolicy;
  readonly signal: AbortSignal;
}

/** An immutable dispatch containing only the not-yet-committed transcript suffix. */
export interface SessionDriverOperation {
  readonly operationId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly configuration: SessionConfiguration;
  readonly messages: SessionTranscript;
  /**
   * S5 ACP text-only prompt representation. Present only for Messages calls;
   * drivers must dispatch this exact content rather than remapping the full
   * caller transcript or silently dropping its role/system tags.
   */
  readonly acpPrompt?: readonly AcpTextBlock[];
  /** Caller-supplied Anthropic bound, present only when one was requested. */
  readonly maxTokens?: number;
  /** Driver-issued exact admission grant; present for every Messages response. */
  readonly admission?: SessionDriverResponseAdmission;
  readonly signal: AbortSignal;
}

/** One caller-supplied MCP result delivered to a parked ACP tool waiter. */
export interface SessionDriverToolResult {
  readonly callId: string;
  readonly result: SessionMcpToolResult;
}

export type SessionMcpDeliveryOutcome = "delivered" | "uncertain";

export interface SessionMcpToolCallOptions {
  readonly signal: AbortSignal;
  /** Actual server response bound and deadline for this MCP request. */
  readonly maxResponseBytes: number;
  readonly deadlineAt: number;
}

/**
 * Continuation seam for a worker that previously acknowledged `awaiting_tools`.
 * Before saving/releasing any result in this batch, the SDK calls
 * `admitResponse` with this continuation's exact optional `maxTokens`. Only after the
 * matching grant returns does the SDK call `prepareToolContinuation`, then
 * durably save/release the results and wait for MCP delivery before consuming
 * this continuation. Preparation lets a parked protocol pump accept/buffer
 * output while the MCP transport finishes; it does not itself deliver results.
 * `results` is correlation metadata; implementations must not execute,
 * redeliver, or replay caller tools/results. An acknowledgement is valid only
 * after the underlying worker confirms continuation of the same parked turn.
 */
export interface SessionDriverToolContinuation {
  readonly operationId: string;
  readonly previousOperationId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly configuration: SessionConfiguration;
  /** New full-transcript suffix, including the caller's tool_result blocks. */
  readonly messages: SessionTranscript;
  readonly maxTokens?: number;
  /** Driver-issued grant produced before any result in this batch is released. */
  readonly admission: SessionDriverResponseAdmission;
  readonly results: readonly SessionDriverToolResult[];
  readonly signal: AbortSignal;
}

/** Internal authority bridge for calls admitted by the session MCP engine. */
export interface SessionDriverCallerToolBinding {
  readonly accountId: string;
  readonly sessionId: string;
  readonly catalogId: string;
  /** Atomically seal the calls assigned to this operation and move later calls to the next batch. */
  sealBatch(operationId: string): Promise<readonly PendingToolCall[]>;
  /** Interrupt the session if the still-running prompt/process fails while MCP waiters are parked. */
  failTurn(operationId: string, error: Error): Promise<void>;
}

/** Incremental worker output for the text-only S6 Messages stream. A complete
 * event is an explicit terminal acknowledgement, not a successful return on
 * its own; the iterator must then reach EOF before the SDK emits terminal
 * Messages events or commits the turn. */
export type SessionDriverStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "complete"; readonly acknowledgement: SessionDriverAcknowledgement };

/** Raw ACP notifications retained for a later session event pump. */
export interface SessionDriverNotification {
  readonly method: string;
  readonly params?: unknown;
}

export type SessionMessageStopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "model_context_window_exceeded"
  | "tool_use";

/** Shared internal events used by the non-stream accumulator and S6/S8 stream mapper. */
export type SessionMessageSemanticEvent =
  /** Internal out-of-band admission receipt emitted before worker stream output. */
  | {
      readonly type: "admission";
      readonly maxTokensEnforcement: MaxTokensEnforcementDiagnostic;
    }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "usage";
      readonly usage: UsageProvenance;
      readonly contextOccupancy?: ContextOccupancyDiagnostic;
      /** Immutable admission facts for this exact Messages response. */
      readonly maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
    }
  | { readonly type: "stop"; readonly stopReason: SessionMessageStopReason };

/** ACP v1 prompt content supported by the S5 text-only adapter. */
export interface AcpTextBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * Driver capabilities are explicit assertions. `maxTokens: "enforced"` is a
 * promise that every Messages operation applies the supplied hard per-response
 * output limit. `"not-enforced"` records that supplied bounds are ignored; it
 * never blocks admission. Runtime operation-bound admission is required either
 * way. Neither value is inferred from ACP initialization or the selected model,
 * and a declaration alone does not prove that an arbitrary injected driver is
 * honest.
 */
export interface SessionDriverCapabilities {
  /** Whether the driver applies supplied hard per-response output bounds. */
  readonly maxTokens?: "enforced" | "not-enforced";
  /** The driver provides a pull-based `stream()` iterator for text output. */
  readonly streaming?: "incremental";
}

/** Additional data accepted by the session-bound Messages protocol adapter. */
export interface SessionDriverMessagesResult {
  readonly stopReason: string;
  readonly usage?: unknown;
  readonly contextOccupancy?: ContextOccupancyDiagnostic;
}

/** Explicit worker acknowledgement required before any transcript is committed. */
export interface SessionDriverAcknowledgement {
  readonly stage: SessionOperationStage;
  /** Newly observed assistant turn(s); historical tool blocks remain inert. */
  readonly output: SessionTranscript;
  /**
   * Optional JSON terminal payload. S5/S6 require `{ stopReason, usage?,
   * contextOccupancy? }`; other S4 callers may retain arbitrary JSON receipts.
   */
  readonly result?: unknown;
}

/** Injectable stateful ACP-session seam; every Messages operation still needs an operation-bound admission. */
export interface SessionDriver {
  /**
   * Atomically admits one response round without starting inference. The exact
   * SDK policy and grant outcome/reason are carried to dispatch/stream or
   * continuation. Implementations must bind grants to the exact
   * account/session/operation/kind/optional maxTokens/policy and consume them
   * once. `ignored` and `unbounded` report honestly when no bound is applied;
   * a fake implementation only qualifies mock behavior, not backend enforcement.
   */
  admitResponse?(request: SessionDriverResponseAdmissionRequest): Promise<SessionDriverResponseAdmission>;
  dispatch(operation: SessionDriverOperation): Promise<SessionDriverAcknowledgement>;
  /** Internal event-pump seam; notifications are never exposed as Messages data. */
  notifications?(): AsyncIterable<SessionDriverNotification>;
  /** Optional, explicitly capability-advertised incremental Messages seam. */
  stream?(operation: SessionDriverOperation): AsyncIterable<SessionDriverStreamEvent>;
  /** Continue a previously parked turn after its exact-bound admission and MCP delivery. */
  continueTools?(continuation: SessionDriverToolContinuation): Promise<SessionDriverAcknowledgement>;
  /** Incremental variant of `continueTools`; used for streaming Messages calls. */
  streamTools?(continuation: SessionDriverToolContinuation): AsyncIterable<SessionDriverStreamEvent>;
  /** Prepare an admitted continuation before the SDK releases any MCP results. */
  prepareToolContinuation?(continuation: SessionDriverToolContinuation): Promise<void>;
  /** Bind the session's authenticated MCP server to the worker transport. */
  bindCallerTools?(server: SessionMcpServer, binding: SessionDriverCallerToolBinding): Promise<void>;
  /** Internal wake after a schema-validated MCP call's receipt is durably ready. */
  notifyCallerToolCall?(call: PendingToolCall, operationId: string): void | Promise<void>;
  /** Safe, payload-free ACP v1 activity counts for the owning session diagnostics. */
  acpActivityDiagnostics?(): AcpActivityDiagnostics;
  /** Cancel the still-running ACP prompt when an associated MCP waiter is lost. */
  cancelCallerToolTurn?(operationId: string): Promise<void>;
  close(): Promise<void>;
  readonly capabilities?: SessionDriverCapabilities;
}

export type SessionDriverFactory = (
  context: SessionDriverContext,
) => Promise<SessionDriver> | SessionDriver;

export interface SessionLedgerRequest {
  /** Full caller transcript. The committed prefix is checked before dispatch. */
  readonly transcript: SessionTranscript;
  /** If supplied, each provided pinned field must match exactly. */
  readonly configuration?: SessionConfigurationAssertion;
}

export interface SessionLedgerOperationOptions {
  readonly signal?: AbortSignal;
}

export interface SessionLedgerReceipt {
  readonly operationId: string;
  readonly stage: SessionOperationStage;
  /** Input suffix plus acknowledged output, committed once by this operation. */
  readonly committedMessages: SessionTranscript;
  readonly result?: unknown;
  /** Present for a completed Messages operation with a valid admission grant. */
  readonly maxTokensEnforcement?: MaxTokensEnforcementDiagnostic;
}

export interface SessionLedgerSnapshot {
  readonly accountId: string;
  readonly sessionId: string;
  readonly state: SessionState;
  readonly revision: number;
  readonly configuration: SessionConfiguration;
  readonly transcript: SessionTranscript;
  readonly activeOperationId?: string;
}

/** Account-bound session ledger with the S5/S6 Messages facade attached. */
export interface SessionLedger {
  readonly accountId: string;
  readonly sessionId: string;
  readonly configuration: SessionConfiguration;
  readonly state: SessionState;
  readonly messages: SessionMessages;
  readonly diagnostics: SessionDiagnostics;
  readonly capabilities: SessionDriverCapabilities;
  /** Session-bound caller tool catalog and bounded internal MCP transport. */
  readonly tools: SessionToolRegistry;
  snapshot(): SessionLedgerSnapshot;
  execute(
    request: SessionLedgerRequest,
    options?: SessionLedgerOperationOptions,
  ): Promise<SessionLedgerReceipt>;
  /** S5-only dispatch path carrying the validated ACP text prompt and token bound. */
  executeMessage(
    request: SessionLedgerRequest,
    options: SessionLedgerMessageOptions,
  ): Promise<SessionLedgerReceipt>;
  /** S6 pull-based stream of validated semantic events; early return aborts it. */
  streamMessage(
    request: SessionLedgerRequest,
    options: SessionLedgerMessageOptions,
  ): AsyncIterable<SessionMessageSemanticEvent>;
  close(): Promise<void>;
}

/** A validated caller custom-tool request handed to S8; never an ACP activity event. */
export interface PendingToolCall {
  readonly callId: string;
  readonly requestId: string | number;
  readonly accountId: string;
  readonly sessionId: string;
  readonly catalogId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface SessionMcpTextContent {
  readonly type: "text";
  readonly text: string;
}

/** Bounded text-only MCP result accepted from the injected S8 continuation handler. */
export interface SessionMcpToolResult {
  readonly content: readonly SessionMcpTextContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export type SessionMcpToolCallHandler = (
  call: PendingToolCall,
  options: SessionMcpToolCallOptions,
) => Promise<SessionMcpToolResult> | SessionMcpToolResult;

export interface SessionMcpServerLimits {
  /** Wall-clock bound covering request-body read and tool handoff; default 30s. */
  readonly requestTimeoutMs?: number;
  /** Maximum UTF-8 JSON request body; default 1 MiB. */
  readonly maxRequestBytes?: number;
  /** Maximum serialized JSON-RPC response; default 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Concurrent HTTP requests, excluding a small reserved cancellation allowance; default 64. */
  readonly maxConcurrentRequests?: number;
  /** Concurrent injected tool handoffs; default 16. */
  readonly maxConcurrentToolCalls?: number;
  /** Maximum shutdown wait for injected handlers to observe abort; default 1s. */
  readonly shutdownTimeoutMs?: number;
}

/** Secret-bearing connection details; do not log or persist `headers`. */
export interface SessionMcpServer {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly accountId: string;
  readonly sessionId: string;
  readonly catalogId: string;
  close(): Promise<void>;
}

/** Fixed session catalog; one MCP endpoint may be created for the session. */
export interface SessionToolRegistry {
  readonly catalogId: string;
  createMcpServer(options?: {
    /** Omit to park calls for the session's Anthropic Messages handoff. */
    readonly onToolCall?: SessionMcpToolCallHandler;
    readonly limits?: SessionMcpServerLimits;
  }): Promise<SessionMcpServer>;
}

export type SessionToolExposureState = "not_exposed" | "exposure_attempted" | "exposed_or_uncertain";
export type SessionToolResultState = "none" | "saved" | "delivery_attempted" | "acknowledged" | "uncertain";

/** Durable, SDK-owned, read-only call receipt. Raw tool arguments are never stored. */
export interface SessionToolCallReceipt {
  readonly accountId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly callId: string;
  readonly catalogId: string;
  readonly name: string;
  readonly argumentsDigest: string;
  readonly exposureState: SessionToolExposureState;
  readonly resultState: SessionToolResultState;
  readonly result?: SessionMcpToolResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionLedgerMessageOptions extends SessionLedgerOperationOptions {
  readonly maxTokens?: number;
}

export interface ProfileSessionEngine {
  readonly accountId: string;
  create(options: SessionCreateOptions): Promise<SessionLedger>;
  /** Read-only crash receipts for this account. This never resumes a worker or replays results. */
  recoveryDiagnostics(): Promise<readonly SessionToolCallReceipt[]>;
  /** Closes every session created by this handle and prevents new sessions. */
  close(): Promise<void>;
}

export interface ProfileSessionEngineOptions {
  readonly driverFactory: SessionDriverFactory;
  /** Required; pass the same manager to createProfileAuth() so logout closes these workers. */
  readonly workerManager: import("./auth.js").ProfileRuntimeManager;
  /** Maximum wait for streaming iterator/worker cleanup; defaults to 1,000 ms. */
  readonly streamCleanupTimeoutMs?: number;
  /** Legacy setting carried as immutable context; it does not block unbounded ACP inference. */
  readonly maxTokensPolicy?: MaxTokensPolicy;
}
