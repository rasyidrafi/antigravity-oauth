import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, lstat, realpath, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { InternalError } from "./errors.js";
import type { SessionToolCallReceipt } from "./contracts.js";

const DIRECTORY_NAME = ".sdk-tool-receipts";
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
const SESSION_FILE = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

function unavailable(): InternalError {
  return new InternalError("Private session tool receipt storage is unavailable or unsafe.");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function assertPrivateMode(mode: number): void {
  if (platform() !== "win32" && (mode & 0o077) !== 0) throw unavailable();
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^acct_[0-9a-f-]{36}$/u.test(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

async function verifyDirectory(path: string, create: boolean): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (!create || !isErrno(error, "ENOENT")) throw unavailable();
    try {
      await mkdir(path, { mode: PRIVATE_DIR });
    } catch (mkdirError) {
      if (!isErrno(mkdirError, "EEXIST")) throw unavailable();
    }
    stats = await lstat(path).catch(() => { throw unavailable(); });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw unavailable();
  assertPrivateMode(stats.mode);
  const canonical = await realpath(path).catch(() => { throw unavailable(); });
  if (resolve(canonical) !== resolve(path)) throw unavailable();
}

async function safeProfileRoot(profileRoot: string): Promise<string> {
  if (typeof profileRoot !== "string" || !profileRoot.startsWith("/")) throw unavailable();
  const normalized = resolve(profileRoot);
  const stats = await lstat(normalized).catch(() => { throw unavailable(); });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw unavailable();
  assertPrivateMode(stats.mode);
  const canonical = await realpath(normalized).catch(() => { throw unavailable(); });
  if (resolve(canonical) !== normalized) throw unavailable();
  return normalized;
}

function validateReceiptArray(value: unknown, accountId: string, sessionId: string): readonly SessionToolCallReceipt[] {
  if (!Array.isArray(value) || value.length > 1_024) throw unavailable();
  const ids = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unavailable();
    const receipt = raw as Record<string, unknown>;
    const allowedReceiptKeys = [
      "accountId", "sessionId", "operationId", "callId", "catalogId", "name", "argumentsDigest",
      "exposureState", "resultState", "result", "createdAt", "updatedAt",
    ];
    if (
      Object.keys(receipt).some((key) => !allowedReceiptKeys.includes(key)) ||
      receipt.accountId !== accountId || receipt.sessionId !== sessionId ||
      typeof receipt.operationId !== "string" ||
      !/^op_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.operationId) ||
      typeof receipt.callId !== "string" || !/^toolu_[0-9a-f]{32}$/u.test(receipt.callId) || ids.has(receipt.callId) ||
      typeof receipt.catalogId !== "string" || !/^sha256-[0-9a-f]{64}$/u.test(receipt.catalogId) ||
      typeof receipt.name !== "string" || receipt.name.length === 0 || Buffer.byteLength(receipt.name, "utf8") > 128 ||
      typeof receipt.argumentsDigest !== "string" || !/^[0-9a-f]{64}$/u.test(receipt.argumentsDigest) ||
      !["not_exposed", "exposure_attempted", "exposed_or_uncertain"].includes(String(receipt.exposureState)) ||
      !["none", "saved", "delivery_attempted", "acknowledged", "uncertain"].includes(String(receipt.resultState)) ||
      typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt)) ||
      typeof receipt.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.updatedAt))
    ) throw unavailable();
    ids.add(receipt.callId);
    if (receipt.exposureState === "not_exposed" && receipt.resultState !== "none") throw unavailable();
    if (receipt.result !== undefined) {
      try {
        if (
          typeof receipt.result !== "object" || receipt.result === null || Array.isArray(receipt.result) ||
          Object.keys(receipt.result).some((key) => !["content", "isError", "structuredContent"].includes(key)) ||
          !Array.isArray((receipt.result as Record<string, unknown>).content) ||
          ((receipt.result as Record<string, unknown>).isError !== undefined &&
            typeof (receipt.result as Record<string, unknown>).isError !== "boolean") ||
          ((receipt.result as Record<string, unknown>).structuredContent !== undefined &&
            (typeof (receipt.result as Record<string, unknown>).structuredContent !== "object" ||
              (receipt.result as Record<string, unknown>).structuredContent === null ||
              Array.isArray((receipt.result as Record<string, unknown>).structuredContent))) ||
          Buffer.byteLength(JSON.stringify(receipt.result), "utf8") > 1_048_576
        ) throw unavailable();
        for (const block of (receipt.result as Record<string, unknown>).content as unknown[]) {
          if (
            typeof block !== "object" || block === null || Array.isArray(block) ||
            Object.keys(block).length !== 2 || (block as Record<string, unknown>).type !== "text" ||
            typeof (block as Record<string, unknown>).text !== "string"
          ) throw unavailable();
        }
      } catch {
        throw unavailable();
      }
      if (receipt.resultState === "none") throw unavailable();
    } else if (receipt.resultState !== "none") {
      throw unavailable();
    }
  }
  return deepFreeze(value as readonly SessionToolCallReceipt[]);
}

async function readReceiptFile(filePath: string, accountId: string, expectedSessionId: string): Promise<readonly SessionToolCallReceipt[]> {
  let handle;
  try {
    const before = await lstat(filePath);
    if (before.isSymbolicLink() || !before.isFile()) throw unavailable();
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unavailable();
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw unavailable();
    assertPrivateMode(stats.mode);
    const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unavailable();
    const document = parsed as Record<string, unknown>;
    if (
      document.version !== 1 || document.accountId !== accountId ||
      document.sessionId !== expectedSessionId || !Array.isArray(document.calls)
    ) throw unavailable();
    return validateReceiptArray(document.calls, accountId, expectedSessionId);
  } catch (error) {
    if (error instanceof InternalError) throw error;
    throw unavailable();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + MAX_LOCK_WAIT_MS;
  const token = randomBytes(24).toString("hex");
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, "wx", PRIVATE_FILE);
      await handle.writeFile(token, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      return async () => {
        try {
          const existing = await open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
          try {
            const contents = await existing.readFile({ encoding: "utf8" });
            if (contents === token) await unlink(lockPath);
          } finally {
            await existing.close();
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw unavailable();
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isErrno(error, "EEXIST")) throw unavailable();
      if (Date.now() >= deadline) throw unavailable();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_POLL_MS));
    }
  }
}

async function writeAtomic(filePath: string, directory: string, value: unknown): Promise<void> {
  await verifyDirectory(directory, false);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw unavailable();
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw unavailable();
  const current = await lstat(filePath).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw unavailable();
  });
  if (current && (current.isSymbolicLink() || !current.isFile())) throw unavailable();
  if (current) assertPrivateMode(current.mode);

  const temporary = join(directory, `.tmp-${randomBytes(16).toString("hex")}`);
  let handle;
  try {
    handle = await open(temporary, "wx", PRIVATE_FILE);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verifyDirectory(directory, false);
    await rename(temporary, filePath);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw unavailable();
  }
}

export class SessionToolReceiptStore {
  readonly #accountId: string;
  readonly #sessionId: string;
  readonly #profileRoot: string;

  constructor(profileRoot: string, accountId: string, sessionId: string) {
    if (!validId(accountId) || !validSessionId(sessionId)) throw unavailable();
    this.#profileRoot = profileRoot;
    this.#accountId = accountId;
    this.#sessionId = sessionId;
  }

  async write(calls: readonly SessionToolCallReceipt[]): Promise<void> {
    const checked = validateReceiptArray(calls, this.#accountId, this.#sessionId);
    const paths = await this.#paths(true);
    await safeProfileRoot(this.#profileRoot);
    await verifyDirectory(paths.directory, false);
    const unlock = await acquireLock(`${paths.file}.lock`);
    try {
      await safeProfileRoot(this.#profileRoot);
      await verifyDirectory(paths.directory, false);
      await writeAtomic(paths.file, paths.directory, {
        version: 1,
        accountId: this.#accountId,
        sessionId: this.#sessionId,
        calls: checked,
      });
    } finally {
      await unlock();
    }
  }

  async read(): Promise<readonly SessionToolCallReceipt[]> {
    const root = await safeProfileRoot(this.#profileRoot);
    const directory = join(root, DIRECTORY_NAME);
    try {
      await lstat(directory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return Object.freeze([]);
      throw unavailable();
    }
    await verifyDirectory(directory, false);
    const file = join(directory, `${this.#sessionId}.json`);
    try {
      await lstat(file);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return Object.freeze([]);
      throw unavailable();
    }
    try {
      await safeProfileRoot(this.#profileRoot);
      await verifyDirectory(directory, false);
      return await readReceiptFile(file, this.#accountId, this.#sessionId);
    } catch (error) {
      if (error instanceof InternalError) throw error;
      throw unavailable();
    }
  }

  async #paths(create: boolean): Promise<{ readonly directory: string; readonly file: string }> {
    const root = await safeProfileRoot(this.#profileRoot);
    const directory = join(root, DIRECTORY_NAME);
    await verifyDirectory(directory, create);
    await safeProfileRoot(this.#profileRoot);
    await verifyDirectory(directory, false);
    return { directory, file: join(directory, `${this.#sessionId}.json`) };
  }
}

/** Scan only this account's SDK-owned receipt directory; no sessions are resumed. */
export async function readToolRecoveryDiagnostics(
  profileRoot: string,
  accountId: string,
): Promise<readonly SessionToolCallReceipt[]> {
  if (!validId(accountId)) throw unavailable();
  const root = await safeProfileRoot(profileRoot);
  const directory = join(root, DIRECTORY_NAME);
  try {
    await lstat(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return Object.freeze([]);
    throw unavailable();
  }
  try {
    await verifyDirectory(directory, false);
  } catch (error) {
    throw error;
  }
  const files = await readdir(directory).catch(() => { throw unavailable(); });
  const result: SessionToolCallReceipt[] = [];
  for (const name of files) {
    if (!SESSION_FILE.test(name)) continue;
    const sessionId = name.slice(0, -5);
    if (!validSessionId(sessionId)) throw unavailable();
    const receipts = await readReceiptFile(join(directory, name), accountId, sessionId);
    result.push(...receipts);
  }
  result.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.callId.localeCompare(right.callId));
  return deepFreeze(result);
}
