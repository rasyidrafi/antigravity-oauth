/**
 * Private bridge between the ACP session driver and stdio transport. This
 * module is intentionally not re-exported from the package root or exports
 * map; callers cannot manufacture a response that bypasses the write fence.
 */
export interface GuardedPermissionResponse {
  readonly result: Readonly<Record<string, unknown>>;
  readonly fallback: Readonly<Record<string, unknown>>;
  readonly isCurrent: () => boolean;
}

const responses = new WeakMap<object, GuardedPermissionResponse>();

export function createGuardedPermissionResponse(
  result: Readonly<Record<string, unknown>>,
  fallback: Readonly<Record<string, unknown>>,
  isCurrent: () => boolean,
): object {
  const envelope = Object.freeze(Object.create(null)) as object;
  responses.set(envelope, Object.freeze({ result, fallback, isCurrent }));
  return envelope;
}

export function getGuardedPermissionResponse(value: unknown): GuardedPermissionResponse | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return responses.get(value);
}

/** Fail closed if internal validation itself unexpectedly throws. */
export function permissionResponseAtWrite(
  response: GuardedPermissionResponse,
): Readonly<Record<string, unknown>> {
  try {
    return response.isCurrent() ? response.result : response.fallback;
  } catch {
    return response.fallback;
  }
}
