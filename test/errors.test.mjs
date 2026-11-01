import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountNotFoundError,
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProviderError,
  ProtocolFailureError,
  RequestAbortedError,
  RequestTimeoutError,
  SDKError,
  SDK_ERROR_CODES,
  SessionBusyError,
  SessionInterruptedError,
  SessionNotFoundError,
  UnsupportedFeatureError,
} from "../dist/index.js";

test("SDK errors expose stable codes, subclass names, and causes", () => {
  const cause = new Error("underlying");
  const cases = [
    [AuthenticationError, SDK_ERROR_CODES.authenticationRequired],
    [SessionBusyError, SDK_ERROR_CODES.sessionBusy],
    [AccountNotFoundError, SDK_ERROR_CODES.accountNotFound],
    [SessionNotFoundError, SDK_ERROR_CODES.sessionNotFound],
    [SessionInterruptedError, SDK_ERROR_CODES.sessionInterrupted],
    [InvalidRequestError, SDK_ERROR_CODES.invalidRequest],
    [UnsupportedFeatureError, SDK_ERROR_CODES.unsupportedFeature],
    [RequestAbortedError, SDK_ERROR_CODES.requestAborted],
    [RequestTimeoutError, SDK_ERROR_CODES.requestTimeout],
    [ProcessFailureError, SDK_ERROR_CODES.processFailure],
    [ProtocolFailureError, SDK_ERROR_CODES.protocolFailure],
    [ProviderError, SDK_ERROR_CODES.providerError],
    [InternalError, SDK_ERROR_CODES.internalError],
  ];

  for (const [ErrorType, code] of cases) {
    const error = new ErrorType("example", { cause });
    assert.ok(error instanceof SDKError);
    assert.ok(error instanceof ErrorType);
    assert.equal(error.name, ErrorType.name);
    assert.equal(error.code, code);
    assert.equal(error.message, "example");
    assert.equal(error.cause, cause);
  }

  assert.equal(new SessionBusyError("busy").code, "session_busy");
  assert.equal(new ProcessFailureError("process stopped").code, "process_failure");
  assert.equal(new ProtocolFailureError("invalid frame").code, "protocol_failure");
  assert.equal(new SessionInterruptedError("crashed").code, "session_interrupted");
});

test("the base SDKError preserves its supplied typed code", () => {
  const error = new SDKError("example", SDK_ERROR_CODES.providerError);
  assert.equal(error.name, "SDKError");
  assert.equal(error.code, "provider_error");
});
