import { InvalidRequestError } from "./errors.js";
import type { AcpPermissionHandler, AcpPermissionPolicy } from "./contracts.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 10_000;
const MAX_PERMISSION_TIMEOUT_MS = 60_000;

function invalidOptions(): InvalidRequestError {
  return new InvalidRequestError("The AntigravitySDK permission options are invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyDataProperties(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

/**
 * Validate and take an immutable snapshot of the public permission options.
 * An omitted policy is the built-in `auto` policy, which selects only
 * `allow_once` and denies when it is unavailable. This function deliberately
 * only normalizes the selected policy; enforcement and guarded ACP writes are
 * owned by the built-in session driver.
 */
export function normalizeAcpPermissionPolicy(value: unknown): AcpPermissionPolicy {
  if (value === undefined) return Object.freeze({ mode: "auto", timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS });

  try {
    const properties = copyDataProperties(value, ["mode", "onRequest", "timeoutMs"]);
    if (properties === undefined) throw invalidOptions();

    const hasMode = Object.hasOwn(properties, "mode");
    const hasOnRequest = Object.hasOwn(properties, "onRequest");
    const timeoutMs = properties.timeoutMs === undefined ? DEFAULT_PERMISSION_TIMEOUT_MS : properties.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 ||
        (timeoutMs as number) > MAX_PERMISSION_TIMEOUT_MS) {
      throw invalidOptions();
    }

    if (hasMode) {
      if (hasOnRequest || (properties.mode !== "auto" && properties.mode !== "deny")) throw invalidOptions();
      return Object.freeze({ mode: properties.mode, timeoutMs: timeoutMs as number });
    }

    if (!hasOnRequest || typeof properties.onRequest !== "function") throw invalidOptions();
    return Object.freeze({
      mode: "callback",
      onRequest: properties.onRequest as AcpPermissionHandler,
      timeoutMs: timeoutMs as number,
    });
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    // Proxies and exotic objects can throw from prototype/descriptor traps;
    // those are malformed option values, not caller-visible implementation errors.
    throw invalidOptions();
  }
}
