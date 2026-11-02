import type {
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionRequestContext,
  AcpPermissionsOptions,
  Account,
  AccountIdentity,
  AccountQuotaSummary,
  AccountModel,
  AcpChildProcess,
  AcpConnection,
  AcpConnectionOptions,
  AcpInitializeResponse,
  AcpServerRequestHandler,
  AuthStatus,
  HeadlessAuthInteraction,
  ContextOccupancyDiagnostic,
  ProcessFactory,
  ProfileContext,
  ProfileAuth,
  ProfileRuntimeManager,
  ProfileRegistry,
  Message,
  MessageCreateOptions,
  MessageCreateParamsNonStreaming,
  MaxTokensEnforcementDiagnostic,
  MaxTokensEnforcementOutcome,
  MaxTokensPolicy,
  RawMessageStreamEvent,
  Session,
  SessionCreateOptions,
  SessionDriver,
  SessionDriverAcknowledgement,
  SessionDriverCapabilities,
  SessionDriverNotification,
  SessionDriverOperation,
  SessionDriverResponseAdmissionRequest,
  SessionDriverResponseAdmission,
  SessionDriverStreamEvent,
  SessionDriverToolContinuation,
  SessionDriverToolResult,
  SessionLedger,
  SessionLedgerReceipt,
  SessionDiagnosticsSnapshot,
  SessionSystemPrompt,
  SessionTool,
  SessionToolCallReceipt,
  SessionMcpServer,
  UsageProvenance,
} from "../src/index.js";
import {
  AntigravitySDK as SDKConstructor,
  connectAcp,
  createProfileAuth,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
  messageMaxTokensEnforcement,
} from "../src/index.js";
import type { AntigravitySDKOptions } from "../src/index.js";

declare const account: Account;
declare const session: Session;
declare const signal: AbortSignal;
declare const nativeMessage: Message;
declare const rawEvent: RawMessageStreamEvent;

const responseReceipt: MaxTokensEnforcementDiagnostic | undefined =
  messageMaxTokensEnforcement(nativeMessage);
void responseReceipt;
if (rawEvent.type === "message_start") {
  const startReceipt: MaxTokensEnforcementDiagnostic | undefined =
    messageMaxTokensEnforcement(rawEvent.message);
  void startReceipt;
}
// @ts-expect-error the response-scoped accessor requires an object identity.
messageMaxTokensEnforcement("not a native response");

const createOptions: SessionCreateOptions = {
  model: "example-model",
  cwd: "/workspace",
  system: "Follow the workspace instructions.",
  tools: [
    {
      name: "lookup",
      description: "Look up a record by key.",
      input_schema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  ],
};
void createOptions;

const structuredSystemPrompt: SessionSystemPrompt = [
  { type: "text", text: "Use the supplied tools when needed." },
];
const customTool: SessionTool = {
  name: "notify",
  input_schema: { type: "object", properties: {} },
};
void structuredSystemPrompt;
void customTool;

const request: MessageCreateParamsNonStreaming = {
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello" }],
};
const unboundedRequest: MessageCreateParamsNonStreaming = {
  messages: [{ role: "user", content: "No output bound supplied." }],
};

const nonStreaming: Promise<Message> = session.messages.create(request);
const withSignal: Promise<Message> = session.messages.create(request, { signal });
const streaming: Promise<AsyncIterable<RawMessageStreamEvent>> =
  session.messages.create({ ...request, stream: true }, { signal });
void nonStreaming;
void withSignal;
void streaming;
const unboundedMessage: Promise<Message> = session.messages.create(unboundedRequest);
void unboundedMessage;

const futureSession: Promise<Session> = account.sessions.create(createOptions);
void futureSession;
const providerIdentity: Promise<AccountIdentity> = account.identity.get({ signal });
const providerQuota: Promise<AccountQuotaSummary> = account.quota.summary({ signal });
const providerModels: Promise<readonly AccountModel[]> = account.models.list({ cwd: "/workspace", signal });
void providerIdentity;
void providerQuota;
void providerModels;
// @ts-expect-error ACP model discovery requires an explicit working directory.
account.models.list({ signal });
const closeSession: Promise<void> = session.close();
void closeSession;

async function lockedCompositionExample(accountId: string): Promise<void> {
  const sdk = new SDKConstructor({ storageDir: "/private/sdk-data", executable: "/opt/agy-acp" });
  const selectedAccount: Account = sdk.accounts.get(accountId);
  await selectedAccount.auth.login({ methodId: "oauth-personal" });
  const selectedSession = await selectedAccount.sessions.create({ model: "model-x", cwd: "/workspace" });
  await selectedSession.close();
  await sdk.close();
}
void lockedCompositionExample;

declare const ledgerHandle: SessionLedger;
const ledgerMessage: Promise<Message> = ledgerHandle.messages.create(request);
void ledgerMessage;
const ledgerMessages = ledgerHandle.executeMessage(
  { transcript: request.messages },
  { ...(request.max_tokens === undefined ? {} : { maxTokens: request.max_tokens }) },
);
void ledgerMessages;

const enforcedMaxTokens: SessionDriverCapabilities = { maxTokens: "enforced" };
void enforcedMaxTokens;
const unenforcedMaxTokens: SessionDriverCapabilities = { maxTokens: "not-enforced" };
void unenforcedMaxTokens;
const incrementalCapabilities: SessionDriverCapabilities = { maxTokens: "enforced", streaming: "incremental" };
const streamTextEvent: SessionDriverStreamEvent = { type: "text", text: "chunk" };
void incrementalCapabilities;
void streamTextEvent;
const incrementalDriver: SessionDriver = {
  capabilities: incrementalCapabilities,
  async admitResponse(request: SessionDriverResponseAdmissionRequest): Promise<SessionDriverResponseAdmission> {
    return {
      kind: request.kind,
      operationId: request.operationId,
      accountId: request.accountId,
      sessionId: request.sessionId,
      policy: request.policy,
      ...(request.maxTokens === undefined
        ? { outcome: "unbounded", reason: "no-output-token-bound-requested" }
        : { maxTokens: request.maxTokens, outcome: "enforced", reason: "driver-admitted-requested-bound" }),
    };
  },
  async dispatch(operation) {
    return { stage: "completed", output: [{ role: "assistant", content: `nonstream:${operation.operationId}` }] };
  },
  async *stream(operation) {
    const chunk: SessionDriverStreamEvent = { type: "text", text: `stream:${operation.operationId}` };
    yield chunk;
    yield {
      type: "complete",
      acknowledgement: {
        stage: "completed",
        output: [{ role: "assistant", content: `stream:${operation.operationId}` }],
        result: { stopReason: "end_turn" },
      },
    };
  },
  async close() {},
  async bindCallerTools(server: SessionMcpServer) {
    void server.url;
    void server.headers;
  },
};
void incrementalDriver;
declare const driverOperation: SessionDriverOperation;
const forwardedBound: number | undefined = driverOperation.maxTokens;
void forwardedBound;
const responseAdmission = driverOperation.admission;
void responseAdmission;
const retainedNotification: SessionDriverNotification = {
  method: "session/update",
  params: { sessionId: "remote-session", update: { sessionUpdate: "agent_message_chunk" } },
};
void retainedNotification;
// @ts-expect-error a generic boolean is not a hard-enforcement capability declaration.
const weakMaxTokensCapability: SessionDriverCapabilities = { maxTokens: true };
void weakMaxTokensCapability;

const diagnostics: Promise<SessionDiagnosticsSnapshot> = session.diagnostics.snapshot();
const toolReceipts: Promise<readonly SessionToolCallReceipt[]> = session.diagnostics.toolHandoffs();
void diagnostics;
void toolReceipts;

declare const toolContinuation: SessionDriverToolContinuation;
const deliveredToolResult: SessionDriverToolResult = toolContinuation.results[0]!;
void deliveredToolResult;

const measuredUsage: UsageProvenance = {
  kind: "reported",
  source: "acp",
  inputTokens: 12,
  outputTokens: 8,
};
const unknownUsage: UsageProvenance = { kind: "unknown", reason: "not reported" };
const occupancy: ContextOccupancyDiagnostic = { tokens: 256, source: "acp context status" };
const diagnosticSnapshot: SessionDiagnosticsSnapshot = {
  usage: unknownUsage,
  contextOccupancy: occupancy,
};
void measuredUsage;
void diagnosticSnapshot;

const strictPolicy: MaxTokensPolicy = "strict";
const compatibilityPolicy: MaxTokensPolicy = "allow-unenforced-max-tokens";
const sdkOptions: AntigravitySDKOptions = {
  storageDir: "/private/sdk-data",
  executable: "/opt/agy-acp",
  maxTokensPolicy: compatibilityPolicy,
};
const permissionHandler: AcpPermissionHandler = (context) => {
  const origin: "unverified" = context.origin;
  const remoteSession: string = context.remoteSessionId;
  void origin;
  void remoteSession;
  return { action: "deny" };
};
const permissionOptions: AcpPermissionsOptions = { onRequest: permissionHandler, timeoutMs: 10_000 };
const automaticPermissions: AcpPermissionsOptions = { mode: "auto" };
const explicitDenyPermissions: AcpPermissionsOptions = { mode: "deny", timeoutMs: 1_000 };
// @ts-expect-error automatic mode does not accept a callback.
const mixedAutomaticPermissions: AcpPermissionsOptions = { mode: "auto", onRequest: permissionHandler };
// @ts-expect-error callback mode does not accept an explicit policy mode.
const mixedCallbackPermissions: AcpPermissionsOptions = { mode: "deny", onRequest: permissionHandler };
// @ts-expect-error unknown permission modes are rejected.
const invalidPermissionMode: AcpPermissionsOptions = { mode: "prompt" };
void automaticPermissions;
void explicitDenyPermissions;
void mixedAutomaticPermissions;
void mixedCallbackPermissions;
void invalidPermissionMode;
const denyPermission: AcpPermissionDecision = { action: "deny" };
const selectPermission: AcpPermissionDecision = { action: "select", optionId: "allow-once" };
const permissionContext: AcpPermissionRequestContext = {
  accountId: "account",
  sessionId: "session",
  operationId: "operation",
  remoteSessionId: "remote-session",
  requestId: "request-1",
  toolCallId: "tool-1",
  origin: "unverified",
  details: { handling: "omitted", redacted: false, truncated: false },
  offeredOptions: [{ optionId: "allow-once", kind: "allow_once" }],
  signal,
};
const enforcedOutcome: MaxTokensEnforcementOutcome = {
  outcome: "enforced",
  reason: "driver-admitted-requested-bound",
};
const ignoredOutcome: MaxTokensEnforcementOutcome = {
  outcome: "ignored",
  reason: "backend-does-not-enforce-requested-bound",
};
const policyDiagnostic: MaxTokensEnforcementDiagnostic = {
  accountId: "account",
  sessionId: "session",
  operationId: "operation",
  kind: "prompt",
  requestedMaxTokens: 100,
  policy: compatibilityPolicy,
  ...ignoredOutcome,
};
const unboundedDiagnostic: MaxTokensEnforcementDiagnostic = {
  accountId: "account",
  sessionId: "session",
  operationId: "operation-unbounded",
  kind: "prompt",
  policy: strictPolicy,
  outcome: "unbounded",
  reason: "no-output-token-bound-requested",
};
void strictPolicy;
void sdkOptions;
void permissionOptions;
void denyPermission;
void selectPermission;
void permissionContext;
void enforcedOutcome;
void policyDiagnostic;
void unboundedDiagnostic;

// Policy and outcome fields remain discriminated and reject invented states.
// @ts-expect-error unknown policy values are not part of the public contract.
const unknownPolicy: MaxTokensPolicy = "best-effort";
void unknownPolicy;
// @ts-expect-error ACP origin is unverified and cannot be promoted by a caller.
const trustedOrigin: AcpPermissionRequestContext["origin"] = "trusted";
void trustedOrigin;
// @ts-expect-error an ignored result must use the truthful reason variant.
const incompleteEnforcement: MaxTokensEnforcementOutcome = { outcome: "ignored", reason: "driver-admitted-requested-bound" };
void incompleteEnforcement;
// @ts-expect-error callbacks cannot return arbitrary allow booleans.
const invalidPermissionHandler: AcpPermissionHandler = () => true;
void invalidPermissionHandler;
// @ts-expect-error details cannot carry raw tool input or metadata.
const unsafePermissionDetails: AcpPermissionRequestContext["details"] = { handling: "redacted", rawInput: "secret" };
void unsafePermissionDetails;

// Diagnostics are an independent type-level access point, not Message payload.
// @ts-expect-error a diagnostics snapshot is not an Anthropic Message.
const diagnosticsAsMessage: Promise<Message> = session.diagnostics.snapshot();
void diagnosticsAsMessage;

// Unknown usage has no numeric measurement fields.
// @ts-expect-error unknown usage cannot carry fabricated token counts.
const fabricatedUsage: UsageProvenance = { kind: "unknown", inputTokens: 0, outputTokens: 0 };
void fabricatedUsage;

// The stream discriminator must not resolve to the non-streaming response.
// @ts-expect-error stream:true resolves to an async iterable of raw events.
const wrongStreamResult: Promise<Message> = session.messages.create({
  ...request,
  stream: true,
});
void wrongStreamResult;

// A non-streaming request must not resolve to stream events.
// @ts-expect-error stream:false resolves to a single Message.
const wrongMessageResult: Promise<AsyncIterable<RawMessageStreamEvent>> = session.messages.create(request);
void wrongMessageResult;

// Session model is fixed at creation and cannot be overridden per message.
// @ts-expect-error request.model is not part of a session-bound message call.
session.messages.create({ ...request, model: "other-model" });

// The session's system instructions and tool catalog are fixed as well.
// @ts-expect-error request.system cannot override session instructions.
session.messages.create({ ...request, system: "replacement" });
// @ts-expect-error request.tools cannot override the session tool catalog.
session.messages.create({ ...request, tools: [] });

const options: MessageCreateOptions = { signal };
void options;

const profileRegistryPromise: Promise<ProfileRegistry> = createProfileRegistry({
  storageDir: "/private/sdk-data",
  environment: { PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "/ignored" },
});
void profileRegistryPromise;

declare const registry: Awaited<ReturnType<typeof createProfileRegistry>>;
declare const accountId: string;
declare const auth: ProfileAuth;
const authHandle: ProfileAuth = createProfileAuth(registry.accounts, accountId, {
  executable: "/opt/agy-acp",
});
const loginPromise: Promise<void> = authHandle.login({ methodId: "oauth-personal", signal });
const authStatusPromise: Promise<AuthStatus> = authHandle.status();
const logoutPromise: Promise<void> = authHandle.logout({ signal, lockTimeoutMs: 1_000 });
const interaction: HeadlessAuthInteraction = {
  showAuthorizationUrl() {},
  async promptForCallback() { return "http://127.0.0.1:1234/callback?state=x&code=y"; },
};
const manager: ProfileRuntimeManager = createProfileRuntimeManager();
void auth;
void loginPromise;
void authStatusPromise;
void logoutPromise;
void interaction;
void manager;

const sessionEngine = createProfileSessionEngine(registry.accounts, accountId, {
  workerManager: manager,
  driverFactory: async ({ accountId: boundAccountId, sessionId, configuration }) => {
    const driver: SessionDriver = {
      async dispatch(operation) {
        const acknowledgement: SessionDriverAcknowledgement = {
          stage: "completed",
          output: [{ role: "assistant", content: `response for ${operation.operationId}` }],
        };
        void boundAccountId;
        void sessionId;
        void configuration;
        return acknowledgement;
      },
      async close() {},
    };
    return driver;
  },
});
const ledger: Promise<SessionLedger> = sessionEngine.create(createOptions);
const receipt: Promise<SessionLedgerReceipt> = (await ledger).execute({
  transcript: [{ role: "user", content: "Hello" }],
});
void receipt;
void sessionEngine.close();

declare const profileContext: ProfileContext;
declare const childProcessFixture: AcpChildProcess;
const processFactory: ProcessFactory = () => childProcessFixture;
const requestHandler: AcpServerRequestHandler = async ({ method, params }) => ({ method, params });
const acpOptions: AcpConnectionOptions = {
  executable: "/opt/acp-agent",
  profile: profileContext,
  processFactory,
  onRequest: requestHandler,
};
const acpConnection: Promise<AcpConnection> = connectAcp(acpOptions);
void acpConnection;
declare const initializedConnection: AcpConnection;
const initialized: AcpInitializeResponse = initializedConnection.initializeResult;
const requestResult: Promise<unknown> = initializedConnection.request("agent/method", {}, {
  signal,
  timeoutMs: 100,
  deadline: Date.now() + 100,
});
const notificationResult: Promise<void> = initializedConnection.notify("agent/notification", {}, { signal });
const closeResult: Promise<void> = initializedConnection.close();
void initialized;
void requestResult;
void notificationResult;
void closeResult;
