import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { TextDecoder } from "node:util";
import {
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  ProviderError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  UnsupportedFeatureError,
} from "./errors.js";
import {
  connectAcp,
  connectAcpForAuthentication,
  type AcpAuthBrowserCapture,
  type AcpConnectionOptions,
  type AcpInitializeResponse,
  type AcpOperationOptions,
  type ProcessFactory,
} from "./acp.js";
import type { AccountProfileRegistry, ProfileContext } from "./profiles.js";

const SUPPORTED_AUTH_METHOD = "oauth-personal";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_AUTHORIZATION_URL_BYTES = 64 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OAUTH_CAPTURE_FILE = "authorization-url";
const OAUTH_CAPTURE_ENV = "ANTIGRAVITY_SDK_OAUTH_CAPTURE_FILE";

export interface HeadlessAuthInteraction {
  /** Display the validated URL; the SDK never logs it. */
  showAuthorizationUrl(url: string, instructions: string): void | Promise<void>;
  /** Return the complete loopback callback URL copied from the browser. */
  promptForCallback(signal: AbortSignal): Promise<string>;
}

export interface AuthLoginOptions {
  readonly methodId?: string;
  readonly signal?: AbortSignal;
  /** Maximum ACP-auth and callback-relay wait; profile-lock wait is separate. */
  readonly timeoutMs?: number;
  /** Supplying this explicitly enables the manual/headless callback relay. */
  readonly interaction?: HeadlessAuthInteraction;
}

export interface AuthLogoutOptions {
  readonly signal?: AbortSignal;
  /** Maximum time to wait for another profile auth operation. */
  readonly lockTimeoutMs?: number;
}

export interface ProfileAuthOptions {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly processFactory?: ProcessFactory;
  readonly workerManager?: ProfileRuntimeManager;
  readonly loginTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly headlessCaptureTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
}

export type AuthStatus =
  | {
      readonly state: "unknown";
      readonly accountId: string;
      readonly reason:
        | "no-auth-result-observed-in-this-handle"
        | "no-recognized-profile-auth-files-found";
    }
  | {
      readonly state: "authenticated";
      readonly accountId: string;
      readonly methodId: typeof SUPPORTED_AUTH_METHOD;
      readonly evidence: "last-acp-authenticate-succeeded";
      readonly observedAt: string;
    }
  | {
      readonly state: "logged-out";
      readonly accountId: string;
      readonly evidence: "sdk-profile-auth-files-removed";
      readonly observedAt: string;
    };

export interface ProfileAuth {
  /** Explicitly authenticate using an advertised, SDK-supported ACP method. */
  login(options?: AuthLoginOptions): Promise<void>;
  /** Read the most recent result observed by this handle; never starts ACP. */
  status(): Promise<AuthStatus>;
  /** Stop this profile's workers and remove only recognized local auth files. */
  logout(options?: AuthLogoutOptions): Promise<void>;
}

/** Internal cleanup control used by the SDK composition root during shutdown. */
export interface ProfileAuthCleanupController {
  readonly pendingCount: number;
  /** Monotonic identity generation for cleanup obligations owned by this auth handle. */
  readonly generation: number;
  retryPending(): Promise<void>;
}

/** Typed operation failure that records cleanup still owned by an auth handle. */
export class ProfileAuthCleanupError extends ProcessFailureError {
  constructor(cause: unknown) {
    super("The profile auth operation could not complete cleanup safely.", { cause });
  }
}

const profileAuthCleanupControllerKey: unique symbol = Symbol("profileAuthCleanupController");
type ProfileAuthWithCleanup = ProfileAuth & {
  readonly [profileAuthCleanupControllerKey]: ProfileAuthCleanupController;
};

/** Internal bridge; deliberately not re-exported from the package root. */
export function getProfileAuthCleanupController(
  auth: ProfileAuth,
): ProfileAuthCleanupController | undefined {
  return (auth as Partial<ProfileAuthWithCleanup>)[profileAuthCleanupControllerKey];
}

export interface ProfileRuntimeWorker {
  close(): Promise<void>;
}

export interface ProfileRuntimeWorkerLease<T extends ProfileRuntimeWorker> {
  readonly worker: T;
  close(): Promise<void>;
}

/**
 * A profile transition excludes new workers while auth changes. Login may
 * start its short-lived ACP auth worker through the transition itself.
 */
export interface ProfileRuntimeTransition {
  connect<T extends ProfileRuntimeWorker>(factory: () => Promise<T>): Promise<ProfileRuntimeWorkerLease<T>>;
  release(): Promise<void>;
}

/** Injectable lifecycle seam shared by auth now and session workers later. */
export interface ProfileRuntimeManager {
  connect<T extends ProfileRuntimeWorker>(
    profile: ProfileContext,
    factory: () => Promise<T>,
  ): Promise<ProfileRuntimeWorkerLease<T>>;
  closeProfile(profile: ProfileContext): Promise<ProfileRuntimeTransition>;
}

interface WorkerState {
  readonly workers: Set<ProfileRuntimeWorkerLease<ProfileRuntimeWorker>>;
  readonly pending: Set<Promise<ProfileRuntimeWorkerLease<ProfileRuntimeWorker>>>;
  transitioning: boolean;
}

interface PendingAuthCleanup {
  retry(): Promise<void>;
}

function profileKey(profile: ProfileContext): string {
  const root = resolve(profile.storageRoot);
  return `${profile.accountId}\0${platform() === "win32" ? root.toLowerCase() : root}`;
}

class DefaultProfileRuntimeManager implements ProfileRuntimeManager {
  private readonly states = new Map<string, WorkerState>();

  async connect<T extends ProfileRuntimeWorker>(
    profile: ProfileContext,
    factory: () => Promise<T>,
  ): Promise<ProfileRuntimeWorkerLease<T>> {
    const key = profileKey(profile);
    const state = this.state(profile);
    if (state.transitioning) throw new SessionBusyError("Profile workers are stopping for an auth transition.");
    return this.connectIntoState(key, state, factory);
  }

  async closeProfile(profile: ProfileContext): Promise<ProfileRuntimeTransition> {
    const key = profileKey(profile);
    const state = this.state(profile);
    if (state.transitioning) throw new SessionBusyError("A profile worker transition is already active.");
    state.transitioning = true;

    try {
      await this.awaitPending(state);
      await this.closeTrackedWorkers(state);
    } catch {
      state.transitioning = false;
      this.removeEmptyState(key, state);
      throw new ProcessFailureError("Profile workers could not be stopped safely.");
    }

    let released = false;
    const transition: ProfileRuntimeTransition = {
      connect: async <T extends ProfileRuntimeWorker>(factory: () => Promise<T>) => {
        if (released || !state.transitioning) {
          throw new SessionBusyError("The profile auth transition is no longer active.");
        }
        return this.connectIntoState(key, state, factory);
      },
      release: async () => {
        if (released) return;
        await this.awaitPending(state);
        await this.closeTrackedWorkers(state);
        state.transitioning = false;
        released = true;
        this.removeEmptyState(key, state);
      },
    };
    return Object.freeze(transition);
  }

  private state(profile: ProfileContext): WorkerState {
    const key = profileKey(profile);
    let state = this.states.get(key);
    if (!state) {
      state = { workers: new Set(), pending: new Set(), transitioning: false };
      this.states.set(key, state);
    }
    return state;
  }

  private async connectIntoState<T extends ProfileRuntimeWorker>(
    key: string,
    state: WorkerState,
    factory: () => Promise<T>,
  ): Promise<ProfileRuntimeWorkerLease<T>> {
    const pending = Promise.resolve()
      .then(factory)
      .then((worker) => this.track(key, state, worker));
    state.pending.add(pending as Promise<ProfileRuntimeWorkerLease<ProfileRuntimeWorker>>);
    try {
      return await pending;
    } finally {
      state.pending.delete(pending as Promise<ProfileRuntimeWorkerLease<ProfileRuntimeWorker>>);
      this.removeEmptyState(key, state);
    }
  }

  private track<T extends ProfileRuntimeWorker>(
    key: string,
    state: WorkerState,
    worker: T,
  ): ProfileRuntimeWorkerLease<T> {
    let closePromise: Promise<void> | undefined;
    let lease!: ProfileRuntimeWorkerLease<T>;
    lease = Object.freeze({
      worker,
      close: () => {
        if (closePromise) return closePromise;
        closePromise = Promise.resolve()
          .then(() => worker.close())
          .then(() => {
            state.workers.delete(lease as ProfileRuntimeWorkerLease<ProfileRuntimeWorker>);
            this.removeEmptyState(key, state);
          })
          .catch((error: unknown) => {
            closePromise = undefined;
            throw error;
          });
        return closePromise;
      },
    });
    state.workers.add(lease as ProfileRuntimeWorkerLease<ProfileRuntimeWorker>);
    return lease;
  }

  private async awaitPending(state: WorkerState): Promise<void> {
    while (state.pending.size > 0) {
      await Promise.allSettled([...state.pending]);
    }
  }

  private async closeTrackedWorkers(state: WorkerState): Promise<void> {
    const results = await Promise.allSettled([...state.workers].map((lease) => lease.close()));
    if (results.some((result) => result.status === "rejected")) {
      throw new ProcessFailureError("A profile worker did not finish closing.");
    }
  }

  private removeEmptyState(key: string, state: WorkerState): void {
    if (!state.transitioning && state.workers.size === 0 && state.pending.size === 0) {
      this.states.delete(key);
    }
  }
}

const defaultWorkerManager = new DefaultProfileRuntimeManager();

/** Create a worker registry that can be shared by auth and future sessions. */
export function createProfileRuntimeManager(): ProfileRuntimeManager {
  return new DefaultProfileRuntimeManager();
}

interface AuthWorker extends ProfileRuntimeWorker {
  readonly initializeResult: AcpInitializeResponse;
  request(method: string, params?: unknown, options?: AcpOperationOptions): Promise<unknown>;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface PrivateFile {
  readonly contents: string;
  readonly identity: FileIdentity;
}

interface CapturedAuthorization {
  readonly url: string;
  readonly redirectUrl: URL;
  readonly state: string;
}

function invalidAuthOptions(): InvalidRequestError {
  return new InvalidRequestError("The profile auth configuration is invalid.");
}

function positiveTimeout(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMER_DELAY_MS) {
    throw new InvalidRequestError(`${name} must be a positive integer within its supported bound.`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function unsafeProfileData(): InternalError {
  return new InternalError("SDK-managed profile auth data is unavailable or unsafe.");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function samePath(left: string, right: string): boolean {
  const first = resolve(left);
  const second = resolve(right);
  return platform() === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function identityOf(details: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: details.dev, inode: details.ino };
}

function assertPrivateMode(mode: number): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) throw unsafeProfileData();
}

async function assertPrivateDirectory(directory: string): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw unsafeProfileData();
  }
  if (details.isSymbolicLink() || !details.isDirectory()) throw unsafeProfileData();
  assertPrivateMode(details.mode);
  try {
    if (!samePath(await realpath(directory), directory)) throw unsafeProfileData();
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  }
  return true;
}

async function readPrivateFileNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<PrivateFile | undefined> {
  let initial;
  try {
    initial = await lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw unsafeProfileData();
  }
  if (initial.isSymbolicLink() || !initial.isFile()) throw unsafeProfileData();
  assertPrivateMode(initial.mode);

  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identityOf(initial), identityOf(opened)) || opened.size > maxBytes) {
      throw unsafeProfileData();
    }
    assertPrivateMode(opened.mode);
    const contents = await readBoundedText(handle, maxBytes);
    const current = await lstat(filePath);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.size > maxBytes ||
      !sameIdentity(identityOf(opened), identityOf(current))
    ) {
      throw unsafeProfileData();
    }
    assertPrivateMode(current.mode);
    return { contents, identity: identityOf(opened) };
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectPrivateFileNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<FileIdentity | undefined> {
  let initial;
  try {
    initial = await lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw unsafeProfileData();
  }
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > maxBytes) throw unsafeProfileData();
  assertPrivateMode(initial.mode);
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      !sameIdentity(identityOf(initial), identityOf(opened))
    ) {
      throw unsafeProfileData();
    }
    assertPrivateMode(opened.mode);
    return identityOf(opened);
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedText(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<string> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maxBytes) throw unsafeProfileData();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw unsafeProfileData();
  }
}

async function assertProfileAuthDirectory(profile: ProfileContext): Promise<string | undefined> {
  if (!(await assertPrivateDirectory(profile.storageRoot))) throw unsafeProfileData();
  const expectedGeminiHome = join(profile.storageRoot, "gemini");
  const configuredGeminiHome = profile.childEnvironment.GEMINI_HOME;
  if (
    typeof configuredGeminiHome !== "string" ||
    !isAbsolute(configuredGeminiHome) ||
    resolve(configuredGeminiHome) !== resolve(expectedGeminiHome)
  ) {
    throw unsafeProfileData();
  }
  if (!(await assertPrivateDirectory(expectedGeminiHome))) throw unsafeProfileData();
  const authDirectory = join(expectedGeminiHome, "antigravity-acp");
  if (!(await assertPrivateDirectory(authDirectory))) return undefined;
  return authDirectory;
}

async function unlinkPrivateFileNoFollow(filePath: string, expected: FileIdentity): Promise<void> {
  let initial;
  try {
    initial = await lstat(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw unsafeProfileData();
  }
  if (initial.isSymbolicLink() || !initial.isFile() || !sameIdentity(identityOf(initial), expected)) {
    throw unsafeProfileData();
  }
  assertPrivateMode(initial.mode);

  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identityOf(initial), identityOf(opened))) throw unsafeProfileData();
    assertPrivateMode(opened.mode);
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const beforeUnlink = await lstat(filePath).catch(() => undefined);
  if (
    !beforeUnlink ||
    beforeUnlink.isSymbolicLink() ||
    !beforeUnlink.isFile() ||
    !sameIdentity(identityOf(beforeUnlink), expected)
  ) {
    throw unsafeProfileData();
  }
  assertPrivateMode(beforeUnlink.mode);
  await unlink(filePath).catch((error: unknown) => {
    if (!isErrno(error, "ENOENT")) throw unsafeProfileData();
  });
}

async function removeAuthSetting(filePath: string, file: PrivateFile): Promise<boolean> {
  let settings: unknown;
  try {
    settings = JSON.parse(file.contents) as unknown;
  } catch {
    throw unsafeProfileData();
  }
  if (!isRecord(settings)) throw unsafeProfileData();
  if (!Object.hasOwn(settings, "auth")) return false;
  delete settings.auth;
  const temporaryPath = join(dirname(filePath), `.settings.json.${randomUUID()}.tmp`);
  let handle;
  let temporaryIdentity: FileIdentity | undefined;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    const initialStats = await handle.stat();
    if (!initialStats.isFile()) throw unsafeProfileData();
    assertPrivateMode(initialStats.mode);
    temporaryIdentity = identityOf(initialStats);
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
    const writtenStats = await handle.stat();
    if (!writtenStats.isFile() || !sameIdentity(identityOf(writtenStats), temporaryIdentity)) {
      throw unsafeProfileData();
    }
    assertPrivateMode(writtenStats.mode);
    await handle.close();
    handle = undefined;

    const current = await readPrivateFileNoFollow(filePath, MAX_SETTINGS_BYTES);
    if (!current || !sameIdentity(current.identity, file.identity) || current.contents !== file.contents) {
      throw unsafeProfileData();
    }
    if (!(await assertPrivateDirectory(dirname(filePath)))) throw unsafeProfileData();
    await rename(temporaryPath, filePath);
    const published = await lstat(filePath);
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      !sameIdentity(identityOf(published), temporaryIdentity)
    ) {
      throw unsafeProfileData();
    }
    assertPrivateMode(published.mode);
    return true;
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unsafeProfileData();
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryIdentity) {
      const current = await lstat(temporaryPath).catch(() => undefined);
      if (
        current &&
        !current.isSymbolicLink() &&
        current.isFile() &&
        sameIdentity(identityOf(current), temporaryIdentity)
      ) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

async function clearRecognizedProfileAuth(profile: ProfileContext): Promise<boolean> {
  const authDirectory = await assertProfileAuthDirectory(profile);
  if (!authDirectory) return false;

  // This is the currently evidenced file-backed Antigravity ACP layout. Only
  // these auth-specific entries are changed; unrelated profile files remain.
  const settingsPath = join(authDirectory, "settings.json");
  const tokenPath = join(authDirectory, "acp_token.json");
  if (!(await assertPrivateDirectory(authDirectory))) throw unsafeProfileData();
  const settings = await readPrivateFileNoFollow(settingsPath, MAX_SETTINGS_BYTES);
  const token = await inspectPrivateFileNoFollow(tokenPath, MAX_SETTINGS_BYTES);
  let changed = false;
  if (settings) changed = await removeAuthSetting(settingsPath, settings) || changed;
  if (token) {
    if (!(await assertPrivateDirectory(authDirectory))) throw unsafeProfileData();
    await unlinkPrivateFileNoFollow(tokenPath, token);
    changed = true;
  }
  return changed;
}

class HeadlessOAuthBridge {
  readonly capture: AcpAuthBrowserCapture;
  private readonly directoryIdentity: FileIdentity;
  private disposed = false;

  private constructor(
    capture: AcpAuthBrowserCapture,
    directoryIdentity: FileIdentity,
  ) {
    this.capture = capture;
    this.directoryIdentity = directoryIdentity;
  }

  static async create(profile: ProfileContext): Promise<HeadlessOAuthBridge> {
    if (platform() === "win32") {
      throw new UnsupportedFeatureError("Manual ACP OAuth callback capture is not supported on Windows.");
    }
    let directory: string | undefined;
    try {
      if (!(await assertPrivateDirectory(profile.storageRoot))) throw unsafeProfileData();
      const temporaryParent = join(profile.storageRoot, "home");
      if (!(await assertPrivateDirectory(temporaryParent))) throw unsafeProfileData();
      directory = await mkdtemp(join(temporaryParent, ".oauth-capture-"));
      await chmod(directory, PRIVATE_MODE);
      const directoryStats = await lstat(directory);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) throw unsafeProfileData();
      assertPrivateMode(directoryStats.mode);
      const commandPath = join(directory, "capture-browser");
      const xdgOpenPath = join(directory, "xdg-open");
      const captureFile = join(directory, OAUTH_CAPTURE_FILE);
      const helper =
        "#!/bin/sh\numask 077\n[ \"$#\" -ge 1 ] || exit 2\nprintf '%s\\n' \"$1\" > \"$ANTIGRAVITY_SDK_OAUTH_CAPTURE_FILE\"\n";
      for (const path of [commandPath, xdgOpenPath]) {
        const handle = await open(path, "wx", PRIVATE_MODE);
        try {
          await handle.writeFile(helper, { encoding: "utf8" });
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(path, PRIVATE_MODE);
      }
      return new HeadlessOAuthBridge(
        { directory, commandPath, captureFile },
        identityOf(directoryStats),
      );
    } catch (error) {
      if (directory) await HeadlessOAuthBridge.removeOwnedDirectory(directory, undefined);
      if (error instanceof UnsupportedFeatureError || error instanceof InternalError) throw error;
      throw new InternalError("The temporary auth callback relay could not be prepared.");
    }
  }

  async waitForAuthorization(signal: AbortSignal | undefined, timeoutMs: number): Promise<CapturedAuthorization> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.disposed) throw new AuthenticationError("The temporary auth callback relay was closed.");
      if (signal?.aborted) throw abortedError();
      const capture = await readPrivateFileNoFollow(this.capture.captureFile, MAX_AUTHORIZATION_URL_BYTES);
      if (capture) {
        const value = capture.contents.replace(/\r?\n$/u, "");
        return parseAuthorization(value);
      }
      if (Date.now() >= deadline) throw new RequestTimeoutError("ACP did not provide an authorization URL before the deadline.");
      await delay(Math.min(100, deadline - Date.now()), signal);
    }
  }

  async forwardCallback(
    input: string,
    authorization: CapturedAuthorization,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const callback = parseCallback(input, authorization);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutController = new AbortController();
    timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    timeout.unref?.();
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const response = await fetch(callback, { redirect: "manual", signal: requestSignal });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 400) throw new AuthenticationError("The local ACP OAuth callback was rejected.");
    } catch (error) {
      if (signal?.aborted) throw abortedError();
      if (timeoutController.signal.aborted) throw new RequestTimeoutError("The local ACP callback exceeded its deadline.");
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("The validated callback could not be forwarded to the local ACP listener.");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await HeadlessOAuthBridge.removeOwnedDirectory(this.capture.directory, this.directoryIdentity);
  }

  private static async removeOwnedDirectory(directory: string, expected?: FileIdentity): Promise<void> {
    const current = await lstat(directory).catch(() => undefined);
    if (
      !current ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      (expected && !sameIdentity(identityOf(current), expected))
    ) return;
    try {
      if (!samePath(await realpath(directory), directory)) return;
    } catch {
      return;
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function abortedError(): RequestAbortedError {
  return new RequestAbortedError("The auth operation was aborted.");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, Math.max(1, milliseconds));
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(abortedError());
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function exactlyOneParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function validateLoopbackRedirect(url: URL): void {
  if (
    url.protocol !== "http:" ||
    !(url.hostname === "127.0.0.1" || url.hostname === "[::1]") ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new InvalidRequestError("ACP advertised a non-loopback OAuth redirect.");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidRequestError("ACP advertised an invalid OAuth redirect port.");
  }
}

function parseAuthorization(input: string): CapturedAuthorization {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidRequestError("ACP provided an invalid OAuth authorization URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new InvalidRequestError("ACP provided an authorization URL outside the supported Google OAuth origin.");
  }
  const redirect = exactlyOneParameter(url, "redirect_uri");
  const state = exactlyOneParameter(url, "state");
  if (!redirect || !state || state.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(state)) {
    throw new InvalidRequestError("ACP authorization data is missing a valid redirect or state.");
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    throw new InvalidRequestError("ACP advertised an invalid OAuth redirect.");
  }
  validateLoopbackRedirect(redirectUrl);
  return { url: url.toString(), redirectUrl, state };
}

function parseCallback(input: string, authorization: CapturedAuthorization): URL {
  let callback: URL;
  try {
    callback = new URL(input.trim());
  } catch {
    throw new InvalidRequestError("A complete loopback OAuth callback URL is required.");
  }
  validateLoopbackRedirect(new URL(
    `${callback.origin}${callback.pathname}`,
  ));
  if (
    callback.origin !== authorization.redirectUrl.origin ||
    callback.pathname !== authorization.redirectUrl.pathname ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    throw new InvalidRequestError("The callback origin or path does not match this login attempt.");
  }
  const state = exactlyOneParameter(callback, "state");
  const code = exactlyOneParameter(callback, "code");
  const oauthError = exactlyOneParameter(callback, "error");
  if (
    state !== authorization.state ||
    (code === undefined) === (oauthError === undefined) ||
    (code !== undefined && code.length === 0) ||
    (oauthError !== undefined && oauthError.length === 0)
  ) {
    throw new InvalidRequestError("The callback state or authorization result is invalid.");
  }
  return callback;
}

function normalizeAuthenticationError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return abortedError();
  if (
    error instanceof RequestAbortedError ||
    error instanceof RequestTimeoutError ||
    error instanceof ProcessFailureError ||
    error instanceof ProtocolFailureError ||
    error instanceof AuthenticationError ||
    error instanceof InvalidRequestError ||
    error instanceof UnsupportedFeatureError ||
    error instanceof SessionBusyError ||
    error instanceof InternalError
  ) {
    return error;
  }
  if (error instanceof ProviderError) {
    return new AuthenticationError("The ACP agent rejected authentication.", { cause: error });
  }
  return new AuthenticationError("The ACP authentication operation failed.");
}

function advertisedMethod(initialize: AcpInitializeResponse, requested: string): boolean {
  const methods = initialize.authMethods;
  if (!Array.isArray(methods)) return false;
  return methods.some((method) => isRecord(method) && method.id === requested);
}

async function raceWithAuthentication<T>(
  operation: Promise<T>,
  authentication: Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>,
): Promise<{ readonly kind: "operation"; readonly value: T } | { readonly kind: "authenticated" }> {
  const settledOperation = operation.then(
    (value) => ({ kind: "operation" as const, value }),
    (error: unknown) => ({ kind: "operation-error" as const, error }),
  );
  const settledAuthentication = authentication.then((result) => ({ kind: "authentication" as const, result }));
  const winner = await Promise.race([settledOperation, settledAuthentication]);
  if (winner.kind === "operation-error") throw winner.error;
  if (winner.kind === "authentication") {
    if (!winner.result.ok) throw winner.result.error;
    return { kind: "authenticated" };
  }
  return { kind: "operation", value: winner.value };
}

/**
 * Bind the explicit auth lifecycle to an account registry entry. The account
 * is reloaded before lock acquisition and once more before a worker is used,
 * repeating S1's symlink/private-path checks at the S2 process boundary.
 */
export function createProfileAuth(
  accounts: AccountProfileRegistry,
  accountId: string,
  options: ProfileAuthOptions,
): ProfileAuth {
  if (
    !options ||
    typeof options.executable !== "string" ||
    options.executable.length === 0 ||
    options.executable.includes("\0") ||
    (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.includes("\0"))) ||
    (options.args !== undefined &&
      (!Array.isArray(options.args) ||
        Array.from(options.args).some((value) => typeof value !== "string" || value.includes("\0"))))
  ) {
    throw invalidAuthOptions();
  }
  const loginTimeoutMs = positiveTimeout("loginTimeoutMs", options.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS);
  const initializeTimeoutMs = positiveTimeout(
    "initializeTimeoutMs",
    options.initializeTimeoutMs,
    DEFAULT_INITIALIZE_TIMEOUT_MS,
  );
  const captureTimeoutMs = positiveTimeout(
    "headlessCaptureTimeoutMs",
    options.headlessCaptureTimeoutMs,
    DEFAULT_CAPTURE_TIMEOUT_MS,
  );
  const lockTimeoutMs = positiveTimeout("lockTimeoutMs", options.lockTimeoutMs, 30_000);
  const workerManager = options.workerManager ?? defaultWorkerManager;
  const pendingCleanups = new Set<PendingAuthCleanup>();
  let cleanupGeneration = 0;

  let currentStatus: AuthStatus = Object.freeze({
    state: "unknown",
    accountId,
    reason: "no-auth-result-observed-in-this-handle",
  });

  function trackCleanup(action: () => Promise<void>): () => Promise<void> {
    let completed = false;
    let inFlight: Promise<void> | undefined;
    let record!: PendingAuthCleanup;
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

  async function finishCleanup(
    actions: readonly (() => Promise<void>)[],
    primaryError?: unknown,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const action of actions) {
      try {
        await trackCleanup(action)();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      // Preserve the original auth-operation error for compatibility. The
      // retryable cleanup debt remains owned by this handle and is surfaced
      // independently to the SDK during shutdown.
      if (primaryError !== undefined) return;
      throw new ProfileAuthCleanupError(
        new AggregateError(failures, "One or more profile auth cleanup steps failed."),
      );
    }
  }

  const cleanupController: ProfileAuthCleanupController = Object.freeze({
    get pendingCount() {
      return pendingCleanups.size;
    },
    get generation() {
      return cleanupGeneration;
    },
    retryPending: async () => {
      const results = await Promise.allSettled(
        [...pendingCleanups].map((cleanup) => cleanup.retry()),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new ProfileAuthCleanupError(
          new AggregateError(
            failures.map((result) => result.reason),
            "Pending profile auth cleanup could not be completed.",
          ),
        );
      }
    },
  });

  async function getProfile(): Promise<ProfileContext> {
    const profile = await accounts.get(accountId);
    if (profile.id !== accountId || profile.context.accountId !== accountId) throw unsafeProfileData();
    return profile.context;
  }

  async function lockedProfile(signal?: AbortSignal, timeoutMs = lockTimeoutMs): Promise<{
    readonly profile: ProfileContext;
    readonly release: () => Promise<void>;
  }> {
    if (signal?.aborted) throw abortedError();
    const initial = await getProfile();
    const lock = await initial.acquireAuthLock({ timeoutMs, ...(signal ? { signal } : {}) });
    try {
      const revalidated = await getProfile();
      if (resolve(revalidated.storageRoot) !== resolve(initial.storageRoot)) throw unsafeProfileData();
      return { profile: revalidated, release: () => lock.release() };
    } catch (error) {
      await finishCleanup([() => lock.release()], error);
      throw error;
    }
  }

  async function login(loginOptions: AuthLoginOptions = {}): Promise<void> {
    if (!loginOptions || typeof loginOptions !== "object") throw new InvalidRequestError("Login options must be an object.");
    const requestedMethod = loginOptions.methodId ?? SUPPORTED_AUTH_METHOD;
    if (typeof requestedMethod !== "string" || requestedMethod.length === 0 || requestedMethod.includes("\0")) {
      throw new InvalidRequestError("A non-empty ACP auth method ID is required.");
    }
    if (requestedMethod !== SUPPORTED_AUTH_METHOD) {
      throw new UnsupportedFeatureError("This SDK supports only the advertised oauth-personal ACP method.");
    }
    if (
      loginOptions.interaction !== undefined &&
      (!loginOptions.interaction ||
        typeof loginOptions.interaction.showAuthorizationUrl !== "function" ||
        typeof loginOptions.interaction.promptForCallback !== "function")
    ) {
      throw new InvalidRequestError("Headless auth interaction callbacks are required.");
    }
    const timeoutMs = positiveTimeout("timeoutMs", loginOptions.timeoutMs, loginTimeoutMs);
    const signal = loginOptions.signal;
    if (signal?.aborted) throw abortedError();

    const locked = await lockedProfile(signal);
    let transition: ProfileRuntimeTransition | undefined;
    let relay: HeadlessOAuthBridge | undefined;
    let authSucceeded = false;
    let operationFailed = false;
    let operationError: unknown;
    try {
      if (signal?.aborted) throw abortedError();
      transition = await workerManager.closeProfile(locked.profile);
      if (signal?.aborted) throw abortedError();
      const connectionProfile = await getProfile();
      if (resolve(connectionProfile.storageRoot) !== resolve(locked.profile.storageRoot)) {
        throw unsafeProfileData();
      }
      if (loginOptions.interaction) relay = await HeadlessOAuthBridge.create(connectionProfile);

      const connectionOptions: AcpConnectionOptions = {
        executable: options.executable,
        profile: connectionProfile,
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.processFactory === undefined ? {} : { processFactory: options.processFactory }),
        requestTimeoutMs: timeoutMs,
        initializeTimeoutMs: Math.min(initializeTimeoutMs, timeoutMs),
        ...(signal === undefined ? {} : { signal }),
      };
      const lease = await transition.connect(async () => {
        return relay
          ? connectAcpForAuthentication(connectionOptions, relay.capture)
          : connectAcp(connectionOptions);
      });

      try {
        if (!advertisedMethod(lease.worker.initializeResult, requestedMethod)) {
          throw new UnsupportedFeatureError(
            "The ACP agent did not advertise the supported oauth-personal authentication method.",
          );
        }
        currentStatus = Object.freeze({
          state: "unknown",
          accountId,
          reason: "no-auth-result-observed-in-this-handle",
        });
        const authentication = lease.worker.request(
          "authenticate",
          { methodId: requestedMethod },
          { ...(signal === undefined ? {} : { signal }), timeoutMs },
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: normalizeAuthenticationError(error, signal) }),
        );

        if (relay && loginOptions.interaction) {
          await performHeadlessInteraction(
            relay,
            loginOptions.interaction,
            authentication,
            signal,
            timeoutMs,
            captureTimeoutMs,
          );
        } else {
          const result = await authentication;
          if (!result.ok) throw result.error;
        }
        authSucceeded = true;
      } catch (error) {
        throw normalizeAuthenticationError(error, signal);
      }
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      const cleanupActions: Array<() => Promise<void>> = [];
      if (transition) cleanupActions.push(() => transition!.release());
      if (relay) cleanupActions.push(() => relay!.dispose());
      cleanupActions.push(() => locked.release());
      await finishCleanup(cleanupActions, operationFailed ? operationError : undefined);
    }

    if (authSucceeded) {
      currentStatus = Object.freeze({
        state: "authenticated",
        accountId,
        methodId: SUPPORTED_AUTH_METHOD,
        evidence: "last-acp-authenticate-succeeded",
        observedAt: new Date().toISOString(),
      });
    }
  }

  async function status(): Promise<AuthStatus> {
    // Validate the profile boundary, but do not launch an ACP worker or probe
    // token validity. ACP v1 initialize has no portable auth-status result.
    await getProfile();
    return Object.freeze({ ...currentStatus });
  }

  async function logout(logoutOptions: AuthLogoutOptions = {}): Promise<void> {
    if (!logoutOptions || typeof logoutOptions !== "object") throw new InvalidRequestError("Logout options must be an object.");
    if (logoutOptions.signal?.aborted) throw abortedError();
    const timeoutMs = positiveTimeout("lockTimeoutMs", logoutOptions.lockTimeoutMs, lockTimeoutMs);
    const locked = await lockedProfile(logoutOptions.signal, timeoutMs);
    let transition: ProfileRuntimeTransition | undefined;
    let logoutSucceeded = false;
    let operationFailed = false;
    let operationError: unknown;
    currentStatus = Object.freeze({
      state: "unknown",
      accountId,
      reason: "no-auth-result-observed-in-this-handle",
    });
    try {
      if (logoutOptions.signal?.aborted) throw abortedError();
      transition = await workerManager.closeProfile(locked.profile);
      if (logoutOptions.signal?.aborted) throw abortedError();
      const deletionProfile = await getProfile();
      if (resolve(deletionProfile.storageRoot) !== resolve(locked.profile.storageRoot)) {
        throw unsafeProfileData();
      }
      // Once local deletion starts it runs to completion without mid-operation
      // cancellation, avoiding an avoidable half-deleted credential state.
      logoutSucceeded = await clearRecognizedProfileAuth(deletionProfile);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      const cleanupActions: Array<() => Promise<void>> = [];
      if (transition) cleanupActions.push(() => transition!.release());
      cleanupActions.push(() => locked.release());
      await finishCleanup(cleanupActions, operationFailed ? operationError : undefined);
    }
    if (logoutSucceeded) {
      currentStatus = Object.freeze({
        state: "logged-out",
        accountId,
        evidence: "sdk-profile-auth-files-removed",
        observedAt: new Date().toISOString(),
      });
    } else {
      currentStatus = Object.freeze({
        state: "unknown",
        accountId,
        reason: "no-recognized-profile-auth-files-found",
      });
    }
  }

  const handle: ProfileAuth = Object.freeze({
    login,
    status,
    logout,
    [profileAuthCleanupControllerKey]: cleanupController,
  });
  return handle;
}

async function performHeadlessInteraction(
  relay: HeadlessOAuthBridge,
  interaction: HeadlessAuthInteraction,
  authentication: Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>,
  signal: AbortSignal | undefined,
  loginTimeoutMs: number,
  captureTimeoutMs: number,
): Promise<void> {
  const captureController = new AbortController();
  const captureSignal = signal
    ? AbortSignal.any([signal, captureController.signal])
    : captureController.signal;
  try {
    const captured = await raceWithAuthentication(
      relay.waitForAuthorization(captureSignal, Math.min(loginTimeoutMs, captureTimeoutMs)),
      authentication,
    );
    if (captured.kind === "authenticated") return;

    const promptController = new AbortController();
    const callerAbort = (): void => promptController.abort();
    signal?.addEventListener("abort", callerAbort, { once: true });
    try {
      const shown = await raceWithAuthentication(
        Promise.resolve(interaction.showAuthorizationUrl(
          captured.value.url,
          "Open this URL in a browser. After Google redirects to localhost, paste the complete callback URL here.",
        )),
        authentication,
      );
      if (shown.kind === "authenticated") return;

      const entered = await raceWithAuthentication(
        interaction.promptForCallback(promptController.signal),
        authentication,
      );
      if (entered.kind === "authenticated") return;
      const callbackController = new AbortController();
      const callbackSignal = signal
        ? AbortSignal.any([signal, callbackController.signal])
        : callbackController.signal;
      try {
        const forwarded = await raceWithAuthentication(
          relay.forwardCallback(entered.value, captured.value, callbackSignal, loginTimeoutMs),
          authentication,
        );
        if (forwarded.kind === "authenticated") return;
      } finally {
        callbackController.abort();
      }
      const result = await authentication;
      if (!result.ok) throw result.error;
    } catch (error) {
      if (signal?.aborted) throw abortedError();
      if (
        error instanceof InvalidRequestError ||
        error instanceof RequestTimeoutError ||
        error instanceof RequestAbortedError ||
        error instanceof AuthenticationError
      ) throw error;
      throw new AuthenticationError("The headless auth interaction did not complete.");
    } finally {
      promptController.abort();
      signal?.removeEventListener("abort", callerAbort);
    }
  } finally {
    captureController.abort();
  }
}
