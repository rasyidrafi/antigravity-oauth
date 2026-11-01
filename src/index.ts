export {
  AccountNotFoundError,
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProviderError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  RequestTimeoutError,
  SDKError,
  SDKClosedError,
  SDK_ERROR_CODES,
  SessionBusyError,
  SessionInterruptedError,
  SessionNotFoundError,
  UnsupportedFeatureError,
} from "./errors.js";

export { AntigravitySDK } from "./sdk.js";
export type {
  AntigravitySDKOptions,
  SDKAccountCollection,
  ProfileRegistryFactory,
} from "./sdk.js";

export { AcpConnection, connectAcp } from "./acp.js";

export { createProfileAuth, createProfileRuntimeManager } from "./auth.js";
export { createProfileSessionEngine } from "./session.js";
export {
  mapMessagesToAcpPrompt,
  messageMaxTokensEnforcement,
  normalizeAcpUsage,
  MessageAccumulator,
} from "./messages.js";
export type { MessageSemanticEvent, MessageStopReason, NormalizedMessagesAcknowledgement } from "./messages.js";

export type {
  AuthLoginOptions,
  AuthLogoutOptions,
  AuthStatus,
  HeadlessAuthInteraction,
  ProfileAuth,
  ProfileAuthOptions,
  ProfileRuntimeManager,
  ProfileRuntimeTransition,
  ProfileRuntimeWorker,
  ProfileRuntimeWorkerLease,
} from "./auth.js";

export type {
  AcpChildProcess,
  AcpReadableStream,
  AcpConnectionOptions,
  AcpInitializeResponse,
  AcpOperationOptions,
  AcpServerNotification,
  AcpServerNotificationHandler,
  AcpServerRequest,
  AcpServerRequestHandler,
  AcpSpawnOptions,
  AcpWritableStream,
  ProcessFactory,
} from "./acp.js";

export type { SDKErrorCode } from "./errors.js";

export { createProfileRegistry } from "./profiles.js";

export type {
  AccountProfile,
  AccountProfileRegistry,
  AuthLockOptions,
  AuthOperationLock,
  EnvironmentSource,
  ProfileContext,
  ProfileRegistry,
  ProfileRegistryOptions,
} from "./profiles.js";

export type {
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionRequestContext,
  AcpPermissionRequestDetails,
  AcpPermissionsOptions,
  AcpActivityDiagnostics,
  Account,
  AccountSessions,
  ContextOccupancyDiagnostic,
  Message,
  MaxTokensEnforcementDiagnostic,
  MaxTokensEnforcementOutcome,
  MaxTokensPolicy,
  MessageCreateOptions,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  Session,
  SessionCreateOptions,
  SessionDiagnostics,
  SessionDiagnosticsSnapshot,
  SessionSystemPrompt,
  SessionTool,
  SessionMessages,
  SessionMcpServer,
  SessionMcpServerLimits,
  SessionMcpTextContent,
  SessionMcpDeliveryOutcome,
  SessionMcpToolCallOptions,
  SessionMcpToolCallHandler,
  SessionMcpToolResult,
  SessionToolRegistry,
  SessionToolCallReceipt,
  SessionToolExposureState,
  SessionToolResultState,
  PendingToolCall,
  UsageProvenance,
  ProfileSessionEngine,
  ProfileSessionEngineOptions,
  SessionConfiguration,
  SessionConfigurationAssertion,
  SessionDriver,
  SessionDriverAcknowledgement,
  SessionDriverCapabilities,
  SessionDriverContext,
  SessionDriverMessagesResult,
  SessionDriverNotification,
  SessionDriverFactory,
  SessionDriverOperation,
  SessionDriverResponseAdmission,
  SessionDriverResponseAdmissionRequest,
  SessionDriverToolContinuation,
  SessionDriverToolResult,
  SessionDriverStreamEvent,
  SessionMessageSemanticEvent,
  SessionMessageStopReason,
  AcpTextBlock,
  SessionLedger,
  SessionLedgerMessageOptions,
  SessionLedgerOperationOptions,
  SessionLedgerReceipt,
  SessionLedgerRequest,
  SessionLedgerSnapshot,
  SessionOperationStage,
  SessionState,
  SessionTranscript,
} from "./contracts.js";
