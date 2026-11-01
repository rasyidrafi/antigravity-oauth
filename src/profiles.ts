import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname, platform } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  AccountNotFoundError,
  InternalError,
  InvalidRequestError,
  RequestAbortedError,
  SessionBusyError,
} from "./errors.js";

const ACCOUNT_ID_PREFIX = "acct_";
const ACCOUNT_ID_PATTERN =
  /^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_RECORD = "profile.json";
const LOCK_FILE = ".auth-operation.lock";
const REAPER_DIRECTORY = ".auth-operation.reaper";
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 35;
const MAX_LOCK_FILE_SIZE = 4_096;
const MAX_PROFILE_RECORD_SIZE = 4_096;

const SAFE_INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export type EnvironmentSource = Readonly<
  Record<string, string | undefined>
>;

export interface ProfileRegistryOptions {
  /** An absolute, private directory reserved for this SDK's local profiles. */
  readonly storageDir: string;
  /**
   * Environment source for the child-environment allowlist. Defaults to a
   * snapshot of process.env; only documented non-credential keys are copied.
   */
  readonly environment?: EnvironmentSource;
}

export interface AuthLockOptions {
  /** Maximum time to wait for another auth operation to finish. Defaults to 30s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AuthOperationLock {
  /** Releases only this lock's owned file; repeated calls are harmless. */
  release(): Promise<void>;
}

/**
 * Per-account filesystem and child-process context. It contains no OAuth
 * credentials and does not imply that platform keychains are isolated.
 */
export interface ProfileContext {
  readonly accountId: string;
  /** Canonical root reserved for this account's SDK-owned profile data. */
  readonly storageRoot: string;
  /** Immutable child environment with profile-specific home paths. */
  readonly childEnvironment: Readonly<Record<string, string>>;
  acquireAuthLock(options?: AuthLockOptions): Promise<AuthOperationLock>;
}

export interface AccountProfile {
  readonly id: string;
  readonly context: ProfileContext;
}

export interface AccountProfileRegistry {
  create(): Promise<AccountProfile>;
  get(id: string): Promise<AccountProfile>;
  list(): Promise<readonly AccountProfile[]>;
}

export interface ProfileRegistry {
  /** Canonical, private registry directory supplied by the caller. */
  readonly storageRoot: string;
  readonly accounts: AccountProfileRegistry;
}

interface ProfileRecord {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly host: string;
  readonly platform: string;
  readonly bootId: string | null;
  readonly processStart: string | null;
}

interface LockRecord extends ProcessIdentity {
  readonly version: 1;
  readonly token: string;
  readonly createdAt: number;
}

interface LockSnapshot {
  readonly record: LockRecord;
  readonly device: number;
  readonly inode: number;
}

interface FileSnapshot {
  readonly contents: string;
  readonly device: number;
  readonly inode: number;
}

interface LockOwnership {
  readonly token: string;
  readonly device: number;
  readonly inode: number;
  readonly lockPath: string;
  readonly profileRoot: string;
}

type OwnerLiveness = "live" | "dead" | "unknown";

let processIdentityPromise: Promise<ProcessIdentity> | undefined;

function internalStorageError(): InternalError {
  // Deliberately avoid attaching raw filesystem errors/paths to public errors.
  return new InternalError("Profile storage is unavailable or unsafe.");
}

function invalidStorageOptions(): InvalidRequestError {
  return new InvalidRequestError("storageDir must be an absolute path.");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function pathEquals(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform() === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function assertPrivateMode(mode: number): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) {
    throw internalStorageError();
  }
}

async function ensureDirectoryTree(
  candidate: string,
  create: boolean,
  privateFinalDirectory: boolean,
): Promise<string> {
  const absolute = resolve(candidate);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  try {
    for (const part of parts) {
      current = join(current, part);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (!create || !isErrno(error, "ENOENT")) throw error;
        try {
          await mkdir(current, { mode: PRIVATE_MODE });
        } catch (mkdirError) {
          if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
        }
        stats = await lstat(current);
      }

      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw internalStorageError();
      }
      const canonical = await realpath(current);
      if (!pathEquals(canonical, current)) throw internalStorageError();
    }

    const stats = await lstat(absolute);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw internalStorageError();
    }
    if (privateFinalDirectory) assertPrivateMode(stats.mode);
    const canonical = await realpath(absolute);
    if (!pathEquals(canonical, absolute)) throw internalStorageError();
    return canonical;
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  await ensureDirectoryTree(directory, false, true);
}

function buildChildEnvironment(
  profileRoot: string,
  source: EnvironmentSource,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};

  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }

  const paths = {
    gemini: join(profileRoot, "gemini"),
    home: join(profileRoot, "home"),
    xdgConfig: join(profileRoot, "xdg", "config"),
    xdgData: join(profileRoot, "xdg", "data"),
    xdgCache: join(profileRoot, "xdg", "cache"),
    xdgState: join(profileRoot, "xdg", "state"),
  };

  environment.HOME = paths.home;
  environment.GEMINI_HOME = paths.gemini;
  environment.AGY_ACP_FORCE_FILE_STORAGE = "1";
  environment.XDG_CONFIG_HOME = paths.xdgConfig;
  environment.XDG_DATA_HOME = paths.xdgData;
  environment.XDG_CACHE_HOME = paths.xdgCache;
  environment.XDG_STATE_HOME = paths.xdgState;

  if (platform() === "win32") {
    environment.USERPROFILE = paths.home;
    environment.APPDATA = join(paths.home, "AppData", "Roaming");
    environment.LOCALAPPDATA = join(paths.home, "AppData", "Local");
  }

  return Object.freeze(environment);
}

function captureSafeEnvironment(source: EnvironmentSource): EnvironmentSource {
  const captured: Record<string, string> = {};
  for (const allowed of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    // Read only named allowlisted values; credential-related environment
    // values are never enumerated or copied into this registry snapshot.
    const value = source[allowed];
    if (typeof value === "string" && !value.includes("\0")) captured[allowed] = value;
  }
  return Object.freeze(captured);
}

function validAccountId(id: unknown): id is string {
  return typeof id === "string" && ACCOUNT_ID_PATTERN.test(id);
}

function validateProfileRecord(value: unknown, expectedId: string): ProfileRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    value.id !== expectedId ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw internalStorageError();
  }
  return value as ProfileRecord;
}

async function readFileNoFollow(
  filePath: string,
  maxBytes: number,
  privateFile: boolean,
): Promise<FileSnapshot | undefined> {
  let handle;
  try {
    const initialStats = await lstat(filePath);
    if (initialStats.isSymbolicLink() || !initialStats.isFile()) throw internalStorageError();
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(filePath, flags);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) throw internalStorageError();
    if (privateFile) assertPrivateMode(stats.mode);
    const contents = await handle.readFile({ encoding: "utf8" });
    return { contents, device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readProfileRecord(
  profileRoot: string,
  id: string,
): Promise<ProfileRecord | undefined> {
  await assertPrivateDirectory(profileRoot);
  const file = await readFileNoFollow(join(profileRoot, PROFILE_RECORD), MAX_PROFILE_RECORD_SIZE, true);
  if (file === undefined) return undefined;
  try {
    return validateProfileRecord(JSON.parse(file.contents) as unknown, id);
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  }
}

function profileSubdirectories(profileRoot: string): readonly string[] {
  return [
    join(profileRoot, "gemini"),
    join(profileRoot, "home"),
    join(profileRoot, "xdg"),
    join(profileRoot, "xdg", "config"),
    join(profileRoot, "xdg", "data"),
    join(profileRoot, "xdg", "cache"),
    join(profileRoot, "xdg", "state"),
  ];
}

async function createProfileDirectories(profileRoot: string): Promise<void> {
  for (const directory of profileSubdirectories(profileRoot)) {
    await ensureDirectoryTree(directory, true, true);
  }
}

async function verifyProfileDirectories(profileRoot: string): Promise<void> {
  await assertPrivateDirectory(profileRoot);
  for (const directory of profileSubdirectories(profileRoot)) {
    await assertPrivateDirectory(directory);
  }
}

async function writeProfileRecord(profileRoot: string, record: ProfileRecord): Promise<void> {
  const recordPath = join(profileRoot, PROFILE_RECORD);
  const temporaryPath = join(profileRoot, `.${PROFILE_RECORD}.${randomUUID()}.tmp`);
  let handle;
  let ownedTemp: { readonly device: number; readonly inode: number } | undefined;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    const initialStats = await handle.stat();
    if (!initialStats.isFile()) throw internalStorageError();
    assertPrivateMode(initialStats.mode);
    ownedTemp = { device: initialStats.dev, inode: initialStats.ino };
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
    await handle.sync();
    const writtenStats = await handle.stat();
    if (
      !writtenStats.isFile() ||
      writtenStats.dev !== ownedTemp.device ||
      writtenStats.ino !== ownedTemp.inode
    ) {
      throw internalStorageError();
    }
    assertPrivateMode(writtenStats.mode);
    await handle.close();
    handle = undefined;

    // A same-directory hard link publishes the complete, synced record in one
    // no-clobber operation. `rename` is not used because it could replace a
    // record created by another actor between checks.
    await link(temporaryPath, recordPath);
    const publishedStats = await lstat(recordPath);
    if (
      publishedStats.isSymbolicLink() ||
      !publishedStats.isFile() ||
      publishedStats.dev !== ownedTemp.device ||
      publishedStats.ino !== ownedTemp.inode
    ) {
      throw internalStorageError();
    }
    assertPrivateMode(publishedStats.mode);
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  } finally {
    await handle?.close().catch(() => undefined);
    if (ownedTemp) {
      const currentTemp = await lstat(temporaryPath).catch(() => undefined);
      if (
        currentTemp &&
        !currentTemp.isSymbolicLink() &&
        currentTemp.dev === ownedTemp.device &&
        currentTemp.ino === ownedTemp.inode
      ) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

function parseProcessStart(statContents: string): { readonly state: string; readonly start: string } | undefined {
  const closingParen = statContents.lastIndexOf(")");
  if (closingParen < 0) return undefined;
  const fields = statContents.slice(closingParen + 1).trim().split(/\s+/);
  // The first value is field 3 (state); starttime is field 22.
  if (fields.length < 20 || fields[0] === undefined || fields[19] === undefined) return undefined;
  return { state: fields[0], start: fields[19] };
}

async function getProcessIdentity(): Promise<ProcessIdentity> {
  if (processIdentityPromise) return processIdentityPromise;
  processIdentityPromise = (async () => {
    let bootId: string | null = null;
    let processStart: string | null = null;
    if (platform() === "linux") {
      try {
        bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      } catch {
        // Without stable process identity the lock remains exclusive, but stale
        // recovery will fail closed rather than trusting a PID alone.
      }
      try {
        const stat = parseProcessStart(await readFile("/proc/self/stat", "utf8"));
        processStart = stat?.start ?? null;
      } catch {
        // See the fail-closed behavior above.
      }
    }
    return {
      pid: process.pid,
      host: hostname(),
      platform: platform(),
      bootId,
      processStart,
    };
  })();
  return processIdentityPromise;
}

function validateLockRecord(value: unknown): LockRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LockRecord>;
  if (
    candidate.version !== 1 ||
    typeof candidate.token !== "string" ||
    !/^[0-9a-f-]{36}$/.test(candidate.token) ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) < 1 ||
    typeof candidate.host !== "string" ||
    typeof candidate.platform !== "string" ||
    !(typeof candidate.bootId === "string" || candidate.bootId === null) ||
    !(typeof candidate.processStart === "string" || candidate.processStart === null) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return undefined;
  }
  return candidate as LockRecord;
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  const file = await readFileNoFollow(lockPath, MAX_LOCK_FILE_SIZE, true);
  if (file === undefined) return undefined;
  try {
    const record = validateLockRecord(JSON.parse(file.contents) as unknown);
    if (!record) return undefined;
    const stats = await lstat(lockPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.dev !== file.device ||
      stats.ino !== file.inode
    ) return undefined;
    assertPrivateMode(stats.mode);
    return { record, device: file.device, inode: file.inode };
  } catch (error) {
    if (error instanceof InternalError) throw error;
    return undefined;
  }
}

async function ownerLiveness(record: LockRecord): Promise<OwnerLiveness> {
  const current = await getProcessIdentity();
  if (
    record.host !== current.host ||
    record.platform !== "linux" ||
    current.platform !== "linux" ||
    record.bootId === null ||
    record.processStart === null ||
    current.bootId === null
  ) {
    return "unknown";
  }
  if (record.bootId !== current.bootId) return "dead";

  try {
    const contents = await readFile(`/proc/${record.pid}/stat`, "utf8");
    const process = parseProcessStart(contents);
    if (!process) return "unknown";
    if (process.state === "Z" || process.state === "X") return "dead";
    return process.start === record.processStart ? "live" : "dead";
  } catch (error) {
    return isErrno(error, "ENOENT") ? "dead" : "unknown";
  }
}

async function acquireReaperGuard(profileRoot: string): Promise<(() => Promise<void>) | undefined> {
  const guardPath = join(profileRoot, REAPER_DIRECTORY);
  try {
    await mkdir(guardPath, { mode: PRIVATE_MODE });
  } catch (error) {
    if (isErrno(error, "EEXIST")) return undefined;
    throw internalStorageError();
  }

  const token = randomUUID();
  const markerPath = join(guardPath, "owner");
  let markerHandle;
  try {
    markerHandle = await open(markerPath, "wx", PRIVATE_FILE_MODE);
    await markerHandle.writeFile(token, { encoding: "utf8" });
    await markerHandle.sync();
    const guardStats = await lstat(guardPath);
    const markerStats = await markerHandle.stat();
    assertPrivateMode(guardStats.mode);
    assertPrivateMode(markerStats.mode);
    await markerHandle.close();
    markerHandle = undefined;
    return async () => {
      try {
        await assertPrivateDirectory(guardPath);
        const current = await readFileNoFollow(markerPath, 128, true);
        const currentGuardStats = await lstat(guardPath);
        if (
          current?.contents !== token ||
          current.device !== markerStats.dev ||
          current.inode !== markerStats.ino ||
          currentGuardStats.dev !== guardStats.dev ||
          currentGuardStats.ino !== guardStats.ino
        ) return;
        await unlink(markerPath).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
        await rmdir(guardPath);
      } catch {
        // An abandoned reaper guard is intentionally fail-closed. It requires
        // manual recovery after verifying no reaper process still owns it.
      }
    };
  } catch {
    await markerHandle?.close().catch(() => undefined);
    // We created this empty guard and own its only possible entry.
    await unlink(markerPath).catch(() => undefined);
    await rmdir(guardPath).catch(() => undefined);
    throw internalStorageError();
  }
}

async function reapStaleLock(
  profileRoot: string,
  lockPath: string,
  observed: LockSnapshot,
): Promise<boolean> {
  const releaseGuard = await acquireReaperGuard(profileRoot);
  if (!releaseGuard) return false;
  try {
    await assertPrivateDirectory(profileRoot);
    const current = await readLockSnapshot(lockPath);
    if (
      !current ||
      current.record.token !== observed.record.token ||
      current.device !== observed.device ||
      current.inode !== observed.inode ||
      (await ownerLiveness(current.record)) !== "dead"
    ) {
      return false;
    }

    // The per-profile reaper guard serializes stale takeovers. Lock creation
    // itself is exclusive (hard-link of a fully written private temp file).
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  } finally {
    await releaseGuard();
  }
}

async function createLockFile(profileRoot: string, lockPath: string): Promise<AuthOperationLock | undefined> {
  const token = randomUUID();
  const identity = await getProcessIdentity();
  const record: LockRecord = { ...identity, version: 1, token, createdAt: Date.now() };
  const tempPath = `${lockPath}.${token}.tmp`;
  let handle;
  let created = false;
  try {
    await assertPrivateDirectory(profileRoot);
    handle = await open(tempPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
    await handle.sync();
    const stats = await handle.stat();
    assertPrivateMode(stats.mode);
    try {
      await link(tempPath, lockPath);
      created = true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return undefined;
      throw error;
    }
    const lockStats = await lstat(lockPath);
    if (
      lockStats.isSymbolicLink() ||
      !lockStats.isFile() ||
      lockStats.dev !== stats.dev ||
      lockStats.ino !== stats.ino
    ) {
      throw internalStorageError();
    }
    assertPrivateMode(lockStats.mode);
    const ownership: LockOwnership = {
      token,
      device: lockStats.dev,
      inode: lockStats.ino,
      lockPath,
      profileRoot,
    };
    let released = false;
    let releasePromise: Promise<void> | undefined;
    return Object.freeze({
      release: () => {
        if (released) return Promise.resolve();
        if (releasePromise) return releasePromise;
        const attempt = Promise.resolve().then(() => releaseOwnedLock(ownership));
        releasePromise = attempt.then(
          () => {
            released = true;
          },
          (error: unknown) => {
            releasePromise = undefined;
            throw error;
          },
        );
        return releasePromise;
      },
    });
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw internalStorageError();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    // If the hard-link was created but a later validation failed, do not
    // remove a path without proving its identity and owner token.
    void created;
  }
}

async function releaseOwnedLock(lock: LockOwnership): Promise<void> {
  try {
    await assertPrivateDirectory(lock.profileRoot);
    const current = await readLockSnapshot(lock.lockPath);
    if (
      !current ||
      current.record.token !== lock.token ||
      current.device !== lock.device ||
      current.inode !== lock.inode
    ) {
      throw internalStorageError();
    }
    const beforeUnlink = await lstat(lock.lockPath);
    if (
      beforeUnlink.isSymbolicLink() ||
      beforeUnlink.dev !== lock.device ||
      beforeUnlink.ino !== lock.inode
    ) {
      throw internalStorageError();
    }
    await unlink(lock.lockPath);
  } catch {
    throw new InternalError("Auth lock ownership changed; refusing to release it.");
  }
}

async function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new RequestAbortedError("The auth lock request was aborted.");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(new RequestAbortedError("The auth lock request was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function acquireProfileLock(
  profileRoot: string,
  options: AuthLockOptions = {},
): Promise<AuthOperationLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new InvalidRequestError("timeoutMs must be a non-negative finite number.");
  }
  const signal = options.signal;
  if (signal?.aborted) throw new RequestAbortedError("The auth lock request was aborted.");
  const deadline = performance.now() + timeoutMs;
  const lockPath = join(profileRoot, LOCK_FILE);

  while (true) {
    if (signal?.aborted) throw new RequestAbortedError("The auth lock request was aborted.");
    const acquired = await createLockFile(profileRoot, lockPath);
    if (acquired) {
      if (signal?.aborted) {
        await acquired.release();
        throw new RequestAbortedError("The auth lock request was aborted.");
      }
      return acquired;
    }

    const snapshot = await readLockSnapshot(lockPath);
    if (snapshot && (await ownerLiveness(snapshot.record)) === "dead") {
      if (await reapStaleLock(profileRoot, lockPath, snapshot)) continue;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new SessionBusyError("The profile auth operation is busy.");
    await sleepWithSignal(Math.min(remaining, LOCK_POLL_INTERVAL_MS), signal);
  }
}

async function makeAccountProfile(
  id: string,
  profileRoot: string,
  environment: EnvironmentSource,
): Promise<AccountProfile> {
  await verifyProfileDirectories(profileRoot);
  const context: ProfileContext = Object.freeze({
    accountId: id,
    storageRoot: profileRoot,
    childEnvironment: buildChildEnvironment(profileRoot, environment),
    acquireAuthLock: (options?: AuthLockOptions) => acquireProfileLock(profileRoot, options),
  });
  return Object.freeze({ id, context });
}

/**
 * Initializes the local, credential-free profile registry. This is not an
 * AntigravitySDK constructor and does not inspect CLI/IDE state or start work.
 */
export async function createProfileRegistry(
  options: ProfileRegistryOptions,
): Promise<ProfileRegistry> {
  if (!options || typeof options.storageDir !== "string" || !isAbsolute(options.storageDir)) {
    throw invalidStorageOptions();
  }

  const root = await ensureDirectoryTree(options.storageDir, true, true);
  const accountsRoot = await ensureDirectoryTree(join(root, "accounts"), true, true);
  // Capture a defensive environment snapshot, but only the builder's fixed
  // allowlist is later visible in each child environment.
  const source = captureSafeEnvironment(options.environment ?? process.env);

  const create = async (): Promise<AccountProfile> => {
    const id = `${ACCOUNT_ID_PREFIX}${randomUUID()}`;
    const profileRoot = join(accountsRoot, id);
    try {
      await assertPrivateDirectory(accountsRoot);
      await mkdir(profileRoot, { mode: PRIVATE_MODE });
      await ensureDirectoryTree(profileRoot, false, true);
      await createProfileDirectories(profileRoot);
      const record: ProfileRecord = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
      };
      await writeProfileRecord(profileRoot, record);
      return await makeAccountProfile(id, profileRoot, source);
    } catch (error) {
      if (error instanceof InternalError) throw error;
      throw internalStorageError();
    }
  };

  const get = async (id: string): Promise<AccountProfile> => {
    if (!validAccountId(id)) throw new InvalidRequestError("The account ID is invalid.");
    await assertPrivateDirectory(accountsRoot);
    const profileRoot = join(accountsRoot, id);
    let profileStats;
    try {
      profileStats = await lstat(profileRoot);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new AccountNotFoundError("The account profile was not found.");
      }
      throw internalStorageError();
    }
    if (profileStats.isSymbolicLink() || !profileStats.isDirectory()) {
      throw internalStorageError();
    }
    const record = await readProfileRecord(profileRoot, id);
    if (!record) throw new AccountNotFoundError("The account profile was not found.");
    return makeAccountProfile(id, profileRoot, source);
  };

  const list = async (): Promise<readonly AccountProfile[]> => {
    await assertPrivateDirectory(accountsRoot);
    let entries;
    try {
      entries = await readdir(accountsRoot, { withFileTypes: true });
    } catch {
      throw internalStorageError();
    }
    const profiles: AccountProfile[] = [];
    for (const entry of entries) {
      if (!validAccountId(entry.name)) continue;
      const profileRoot = join(accountsRoot, entry.name);
      let stats;
      try {
        stats = await lstat(profileRoot);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue; // Concurrent profile removal/create.
        throw internalStorageError();
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw internalStorageError();
      const record = await readProfileRecord(profileRoot, entry.name);
      if (!record) continue;
      profiles.push(await makeAccountProfile(record.id, profileRoot, source));
    }
    profiles.sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze(profiles);
  };

  const accounts: AccountProfileRegistry = Object.freeze({ create, get, list });
  return Object.freeze({ storageRoot: root, accounts });
}
