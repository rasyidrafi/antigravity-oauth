import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  AccountNotFoundError,
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  ProviderError,
  RequestAbortedError,
  RequestTimeoutError,
} from "./errors.js";
import type { ProfileAuthCleanupController } from "./auth.js";
import type { AccountProfileRegistry, ProfileContext } from "./profiles.js";
import type {
  AccountDataRequestOptions,
  AccountIdentity,
  AccountIdentityApi,
  AccountQuotaApi,
  AccountQuotaBucket,
  AccountQuotaGroup,
  AccountQuotaSummary,
} from "./contracts.js";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const USER_INFO_URI = "https://www.googleapis.com/oauth2/v2/userinfo";
const QUOTA_URI = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const QUOTA_USER_AGENT = "antigravity/2.24.0 linux/amd64";
const AUTH_DIRECTORY = "antigravity-acp";
const TOKEN_FILE = "acp_token.json";
const MAX_TOKEN_FILE_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const TOKEN_TIMEOUT_MS = 15_000;
const PROVIDER_TIMEOUT_MS = 20_000;
const AUTH_LOCK_TIMEOUT_MS = 60_000;
const MAX_LABEL_BYTES = 512;
const MAX_GROUPS = 128;
const MAX_BUCKETS_PER_GROUP = 512;

type JsonRecord = Record<string, unknown>;

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface PrivateTokenFile {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly projectId: string;
}

interface OAuthTokenResponse {
  readonly accessToken: string;
  readonly rotatedRefreshToken?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function unsafeProfileData(): InternalError {
  return new InternalError("SDK-managed profile auth data is unavailable or unsafe.");
}

function authRequired(): AuthenticationError {
  return new AuthenticationError("Sign in to this account before requesting account information.");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityOf(value: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: value.dev, inode: value.ino };
}

function assertPrivateMode(mode: number): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) {
    throw unsafeProfileData();
  }
}

async function assertPrivateDirectory(directory: string, missingAllowed = false): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (missingAllowed && isErrno(error, "ENOENT")) return false;
    throw unsafeProfileData();
  }
  if (details.isSymbolicLink() || !details.isDirectory()) throw unsafeProfileData();
  if (platform() !== "win32" && (details.mode & 0o077) !== 0) throw unsafeProfileData();
  try {
    if (resolve(await realpath(directory)) !== resolve(directory)) throw unsafeProfileData();
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  }
  return true;
}

function profileTokenPath(profile: ProfileContext): { readonly path: string } {
  const expectedGeminiHome = join(profile.storageRoot, "gemini");
  if (profile.childEnvironment.GEMINI_HOME !== expectedGeminiHome) throw unsafeProfileData();
  return { path: join(expectedGeminiHome, AUTH_DIRECTORY, TOKEN_FILE) };
}

async function readBoundedText(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<string> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset > maxBytes) throw unsafeProfileData();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw unsafeProfileData();
  }
}

function boundedCredential(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateScopes(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 8_192 && !value.includes("\0");
  return Array.isArray(value) && value.length <= 128 &&
    value.every((scope) => typeof scope === "string" && scope.length <= 1_024 && !scope.includes("\0"));
}

async function readTokenFile(profile: ProfileContext): Promise<PrivateTokenFile> {
  if (!profile || typeof profile !== "object" || typeof profile.storageRoot !== "string" ||
      !isAbsolute(profile.storageRoot) || !profile.accountId || !profile.childEnvironment) throw unsafeProfileData();
  const expectedGeminiHome = join(profile.storageRoot, "gemini");
  if (profile.childEnvironment.GEMINI_HOME !== expectedGeminiHome ||
      !(await assertPrivateDirectory(profile.storageRoot)) ||
      !(await assertPrivateDirectory(expectedGeminiHome)) ) {
    throw unsafeProfileData();
  }
  const authDirectory = join(expectedGeminiHome, AUTH_DIRECTORY);
  if (!(await assertPrivateDirectory(authDirectory, true))) throw authRequired();
  const { path } = profileTokenPath(profile);

  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw authRequired();
    throw unsafeProfileData();
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_TOKEN_FILE_BYTES) {
    throw unsafeProfileData();
  }
  assertPrivateMode(initial.mode);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identityOf(initial), identityOf(opened)) ||
        opened.size > MAX_TOKEN_FILE_BYTES) throw unsafeProfileData();
    assertPrivateMode(opened.mode);
    const contents = await readBoundedText(handle, MAX_TOKEN_FILE_BYTES);
    const current = await lstat(path);
    if (current.isSymbolicLink() || !current.isFile() ||
        !sameIdentity(identityOf(opened), identityOf(current)) || current.size > MAX_TOKEN_FILE_BYTES) {
      throw unsafeProfileData();
    }
    assertPrivateMode(current.mode);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      throw unsafeProfileData();
    }
    if (!isRecord(parsed) || !boundedCredential(parsed.client_id, 4_096) ||
        !boundedCredential(parsed.client_secret, 4_096) ||
        !boundedCredential(parsed.refresh_token, 16_384) || parsed.token_uri !== TOKEN_URI ||
        !validateScopes(parsed.scopes) || !boundedCredential(parsed.project_id, 4_096)) {
      throw unsafeProfileData();
    }
    return {
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
      refreshToken: parsed.refresh_token,
      projectId: parsed.project_id,
    };
  } catch (error) {
    if (error instanceof InternalError || error instanceof AuthenticationError) throw error;
    throw unsafeProfileData();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requestSignal(external: AbortSignal | undefined, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
} {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal,
    timeoutSignal,
  };
}

async function readResponseJson(response: Response, maximumBytes: number): Promise<JsonRecord> {
  if (!response.body) throw new ProtocolFailureError("The account provider returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProtocolFailureError("The account provider response exceeded its supported size.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ProtocolFailureError) throw error;
    throw new ProviderError("The account provider response could not be read.");
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new ProtocolFailureError("The account provider returned invalid response text.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolFailureError("The account provider returned invalid JSON.");
  }
  if (!isRecord(parsed)) throw new ProtocolFailureError("The account provider returned an invalid response.");
  return parsed;
}

async function requestJson(
  url: string,
  init: Omit<RequestInit, "signal" | "redirect">,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  authenticationEndpoint = false,
): Promise<JsonRecord> {
  if (externalSignal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
  const { signal, timeoutSignal } = requestSignal(externalSignal, timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal });
  } catch {
    if (externalSignal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
    if (timeoutSignal.aborted) throw new RequestTimeoutError("The account information request exceeded its deadline.");
    throw new ProviderError("The account provider could not be reached.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProtocolFailureError("The account provider attempted an unsupported redirect.");
  }
  if (response.status === 401 || (authenticationEndpoint && response.status === 403)) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthenticationError("The account provider rejected these credentials; sign in again.");
  }
  if (authenticationEndpoint && response.status === 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthenticationError("The account credentials were rejected; sign in again.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 403) throw new ProviderError("The account provider did not permit this request.");
    throw new ProviderError("The account provider could not complete the request.");
  }
  try {
    return await readResponseJson(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (externalSignal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
    if (timeoutSignal.aborted) throw new RequestTimeoutError("The account information request exceeded its deadline.");
    if (error instanceof ProtocolFailureError || error instanceof ProviderError) throw error;
    throw new ProviderError("The account provider response could not be read.");
  }
}

function validateOAuthResponse(value: JsonRecord): OAuthTokenResponse {
  if (!boundedCredential(value.access_token, 16_384) ||
      (value.token_type !== undefined && value.token_type !== "Bearer") ||
      (value.expires_in !== undefined && (!Number.isSafeInteger(value.expires_in) ||
        (value.expires_in as number) < 1 || (value.expires_in as number) > 86_400)) ||
      (value.refresh_token !== undefined && !boundedCredential(value.refresh_token, 16_384))) {
    throw new ProtocolFailureError("The OAuth token endpoint returned an unsupported response.");
  }
  return {
    accessToken: value.access_token,
    ...(value.refresh_token === undefined ? {} : { rotatedRefreshToken: value.refresh_token }),
  };
}

async function refreshAccessToken(
  file: PrivateTokenFile,
  signal: AbortSignal | undefined,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: file.clientId,
    client_secret: file.clientSecret,
    refresh_token: file.refreshToken,
    grant_type: "refresh_token",
  });
  let response: JsonRecord;
  try {
    response = await requestJson(TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }, signal, TOKEN_TIMEOUT_MS, true);
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof RequestAbortedError ||
        error instanceof RequestTimeoutError || error instanceof ProtocolFailureError ||
        error instanceof ProviderError) throw error;
    throw new AuthenticationError("The account credentials could not be refreshed.");
  }
  const token = validateOAuthResponse(response);
  if (token.rotatedRefreshToken !== undefined && token.rotatedRefreshToken !== file.refreshToken) {
    throw new AuthenticationError(
      "The OAuth provider rotated this account's refresh token; account information was not returned. Sign in again.",
    );
  }
  return token.accessToken;
}

function validateRequestOptions(options: AccountDataRequestOptions | undefined): AbortSignal | undefined {
  if (options === undefined) return undefined;
  if (!isRecord(options) || Reflect.ownKeys(options).some((key) => key !== "signal")) {
    throw new InvalidRequestError("Account data request options are invalid.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "signal");
  if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
    throw new InvalidRequestError("Account data request options are invalid.");
  }
  const signal = descriptor?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new InvalidRequestError("Account data request options are invalid.");
  }
  if (signal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
  return signal;
}

function optionalLabel(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!boundedCredential(value, MAX_LABEL_BYTES) || Buffer.byteLength(value, "utf8") > MAX_LABEL_BYTES) {
    throw new ProtocolFailureError("The account provider returned an unsupported quota label.");
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(Date.parse(value))) {
    throw new ProtocolFailureError(`The account provider returned an unsupported ${field}.`);
  }
  return value;
}

function projectWindow(value: unknown): AccountQuotaBucket["window"] {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length > MAX_LABEL_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
    }
    return value;
  }
  if (!isRecord(value)) throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
  const allowed = new Set(["startTime", "endTime", "duration", "unit", "type"]);
  const output: {
    startTime?: string;
    endTime?: string;
    duration?: string | number;
    unit?: string;
    type?: string;
  } = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) continue;
    const field = value[key];
    if (key === "startTime" || key === "endTime") {
      const timestamp = validateTimestamp(field, "quota window timestamp");
      if (timestamp !== undefined) output[key] = timestamp;
    } else if (key === "duration") {
      if ((typeof field !== "string" || field.length > 64 || /[\u0000-\u001f\u007f]/u.test(field)) &&
          (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1_000_000_000)) {
        throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
      }
      output.duration = field as string | number;
    } else if (key === "unit" || key === "type") {
      if (!boundedCredential(field, 64)) throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
      output[key] = field;
    }
  }
  if (Object.keys(output).length === 0) throw new ProtocolFailureError("The account provider returned an unsupported quota window.");
  return Object.freeze(output);
}

function projectQuotaSummary(accountId: string, input: JsonRecord): AccountQuotaSummary {
  if (!Array.isArray(input.groups) || input.groups.length > MAX_GROUPS) {
    throw new ProtocolFailureError("The account provider returned an unsupported quota summary.");
  }
  let totalBuckets = 0;
  const groups: AccountQuotaGroup[] = input.groups.map((rawGroup) => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.buckets) ||
        rawGroup.buckets.length > MAX_BUCKETS_PER_GROUP) {
      throw new ProtocolFailureError("The account provider returned an unsupported quota group.");
    }
    totalBuckets += rawGroup.buckets.length;
    if (totalBuckets > 4_096) throw new ProtocolFailureError("The account provider quota summary is too large.");
    const buckets: AccountQuotaBucket[] = rawGroup.buckets.map((rawBucket) => {
      if (!isRecord(rawBucket) || typeof rawBucket.remainingFraction !== "number" ||
          !Number.isFinite(rawBucket.remainingFraction) || rawBucket.remainingFraction < 0 ||
          rawBucket.remainingFraction > 1) {
        throw new ProtocolFailureError("The account provider returned an unsupported quota bucket.");
      }
      const modelId = optionalLabel(rawBucket, "modelId");
      const resetTime = validateTimestamp(rawBucket.resetTime, "quota reset time");
      const window = projectWindow(rawBucket.window);
      return Object.freeze({
        ...(modelId === undefined ? {} : { modelId }),
        remainingFraction: rawBucket.remainingFraction,
        ...(resetTime === undefined ? {} : { resetTime }),
        ...(window === undefined ? {} : { window }),
      });
    });
    const id = optionalLabel(rawGroup, "id");
    const displayName = optionalLabel(rawGroup, "displayName");
    return Object.freeze({
      ...(id === undefined ? {} : { id }),
      ...(displayName === undefined ? {} : { displayName }),
      buckets: Object.freeze(buckets),
    });
  });
  return Object.freeze({ accountId, observedAt: new Date().toISOString(), groups: Object.freeze(groups) });
}

/**
 * Account-bound OAuth identity and quota APIs. Credential reads and token
 * refresh/rotation share the profile auth lock with login and logout.
 */
export function createAccountProviderData(
  accounts: AccountProfileRegistry,
  accountId: string,
): {
  readonly identity: AccountIdentityApi;
  readonly quota: AccountQuotaApi;
  readonly cleanupController: ProfileAuthCleanupController;
} {
  if (!accounts || typeof accounts.get !== "function" || typeof accountId !== "string" || accountId.length === 0) {
    throw new InvalidRequestError("The account provider data configuration is invalid.");
  }

  interface PendingCleanup {
    retry(): Promise<void>;
  }
  const pendingCleanups = new Set<PendingCleanup>();
  let cleanupGeneration = 0;

  function trackCleanup(action: () => Promise<void>): () => Promise<void> {
    let completed = false;
    let inFlight: Promise<void> | undefined;
    let record!: PendingCleanup;
    record = {
      retry: () => {
        if (completed) return Promise.resolve();
        if (inFlight) return inFlight;
        const attempt = Promise.resolve()
          .then(action)
          .then(() => {
            completed = true;
            pendingCleanups.delete(record);
          })
          .catch((error: unknown) => {
            inFlight = undefined;
            throw error;
          });
        inFlight = attempt;
        return attempt;
      },
    };
    cleanupGeneration += 1;
    pendingCleanups.add(record);
    return () => record.retry();
  }

  const cleanupController: ProfileAuthCleanupController = Object.freeze({
    get pendingCount() {
      return pendingCleanups.size;
    },
    get generation() {
      return cleanupGeneration;
    },
    retryPending: async () => {
      const results = await Promise.allSettled([...pendingCleanups].map((cleanup) => cleanup.retry()));
      if (results.some((result) => result.status === "rejected")) {
        throw new ProcessFailureError("Account profile auth-lock cleanup could not be completed safely.");
      }
    },
  });

  async function releaseProfileLock(lock: Awaited<ReturnType<ProfileContext["acquireAuthLock"]>>): Promise<void> {
    try {
      await trackCleanup(() => lock.release())();
    } catch {
      throw new ProcessFailureError("The account information request could not release its profile lock safely.");
    }
  }

  async function withAccessToken<T>(
    signal: AbortSignal | undefined,
    operation: (accessToken: string, tokenFile: PrivateTokenFile) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
    await cleanupController.retryPending();
    const initial = await accounts.get(accountId);
    if (initial.id !== accountId || initial.context.accountId !== accountId) {
      throw new AccountNotFoundError("The account profile could not be validated.");
    }
    const lock = await initial.context.acquireAuthLock({ timeoutMs: AUTH_LOCK_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    let operationFailed = false;
    try {
      if (signal?.aborted) throw new RequestAbortedError("The account information request was aborted.");
      const current = await accounts.get(accountId);
      if (current.id !== accountId || current.context.accountId !== accountId ||
          resolve(current.context.storageRoot) !== resolve(initial.context.storageRoot)) {
        throw new AccountNotFoundError("The account profile changed while account information was requested.");
      }
      const tokenFile = await readTokenFile(current.context);
      const accessToken = await refreshAccessToken(tokenFile, signal);
      return await operation(accessToken, tokenFile);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      if (operationFailed) {
        await releaseProfileLock(lock).catch(() => undefined);
      } else {
        await releaseProfileLock(lock);
      }
    }
  }

  const identity: AccountIdentityApi = Object.freeze({
    get: (options?: AccountDataRequestOptions): Promise<AccountIdentity> => {
      const signal = validateRequestOptions(options);
      return withAccessToken(signal, async (accessToken) => {
        const response = await requestJson(USER_INFO_URI, {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
        }, signal, PROVIDER_TIMEOUT_MS);
        if (response.verified_email !== true || !boundedCredential(response.email, MAX_LABEL_BYTES) ||
            !boundedCredential(response.id, MAX_LABEL_BYTES)) {
          throw new AuthenticationError("The account provider did not return a verified account identity.");
        }
        return Object.freeze({
          accountId,
          providerId: response.id,
          email: response.email,
          emailVerified: true,
        });
      });
    },
  });

  const quota: AccountQuotaApi = Object.freeze({
    summary: (options?: AccountDataRequestOptions): Promise<AccountQuotaSummary> => {
      const signal = validateRequestOptions(options);
      return withAccessToken(signal, async (accessToken, tokenFile) => {
        const response = await requestJson(QUOTA_URI, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "user-agent": QUOTA_USER_AGENT,
          },
          body: JSON.stringify({ project: tokenFile.projectId }),
        }, signal, PROVIDER_TIMEOUT_MS);
        return projectQuotaSummary(accountId, response);
      });
    },
  });

  return Object.freeze({ identity, quota, cleanupController });
}
