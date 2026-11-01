/** Stable error codes intended for SDK errors, not remote provider payloads. */
export const SDK_ERROR_CODES = {
  authenticationRequired: "authentication_required",
  sessionBusy: "session_busy",
  accountNotFound: "account_not_found",
  sessionNotFound: "session_not_found",
  sessionInterrupted: "session_interrupted",
  invalidRequest: "invalid_request",
  unsupportedFeature: "unsupported_feature",
  requestAborted: "request_aborted",
  requestTimeout: "request_timeout",
  processFailure: "process_failure",
  protocolFailure: "protocol_failure",
  providerError: "provider_error",
  internalError: "internal_error",
  sdkClosed: "sdk_closed",
} as const;

export type SDKErrorCode = (typeof SDK_ERROR_CODES)[keyof typeof SDK_ERROR_CODES];

/** Structural bridge for Anthropic SDK APIError classes across duplicate versions. */
export interface AnthropicAPIErrorLike extends Error {
  readonly status: number | undefined;
  readonly headers: unknown;
  readonly error: unknown;
  readonly requestID: string | null | undefined;
  readonly workspaceID: string | null | undefined;
  readonly type: unknown;
}

/**
 * Recognize APIError from either the direct Anthropic SDK or a translator's
 * nested copy without loading either SDK at runtime in the core package.
 */
export function isAnthropicAPIError(value: unknown): value is AnthropicAPIErrorLike {
  try {
    if (!(value instanceof Error)) return false;
    const own = new Set(Object.getOwnPropertyNames(value));
    if (!["status", "headers", "error", "requestID", "workspaceID", "type"].every((key) => own.has(key))) return false;
    for (let prototype: object | null = Object.getPrototypeOf(value); prototype; prototype = Object.getPrototypeOf(prototype)) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (typeof constructor === "function" && constructor.name === "APIError") return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Base class for errors surfaced by the SDK. */
export class SDKError extends Error {
  readonly code: SDKErrorCode;

  constructor(message: string, code: SDKErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AuthenticationError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.authenticationRequired, options);
  }
}

export class SessionBusyError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.sessionBusy, options);
  }
}

export class AccountNotFoundError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.accountNotFound, options);
  }
}

export class SessionNotFoundError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.sessionNotFound, options);
  }
}

export class SessionInterruptedError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.sessionInterrupted, options);
  }
}

export class InvalidRequestError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.invalidRequest, options);
  }
}

export class UnsupportedFeatureError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.unsupportedFeature, options);
  }
}

export class RequestAbortedError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.requestAborted, options);
  }
}

export class RequestTimeoutError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.requestTimeout, options);
  }
}

export class ProcessFailureError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.processFailure, options);
  }
}

export class ProtocolFailureError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.protocolFailure, options);
  }
}

export class ProviderError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.providerError, options);
  }
}

export class InternalError extends SDKError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, SDK_ERROR_CODES.internalError, options);
  }
}

/** The SDK or one of its owned handles has begun shutdown. */
export class SDKClosedError extends SDKError {
  constructor(message = "The SDK is closed.") {
    super(message, SDK_ERROR_CODES.sdkClosed);
  }
}
