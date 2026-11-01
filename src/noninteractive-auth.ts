import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { platform } from "node:os";
import { promisify } from "node:util";
import { ProcessFailureError, UnsupportedFeatureError } from "./errors.js";
import type { ProfileContext } from "./profiles.js";

export const INTERACTIVE_LOGIN_BLOCK_MARKER = "AGY_INTERACTIVE_LOGIN_BLOCKED";
const runFile = promisify(execFile);
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface NoninteractiveAuthGuard {
  readonly profile: ProfileContext;
  dispose(): Promise<void>;
}

/**
 * Prepare and preflight a child-only browser blocker. The actual ACP child
 * receives only the profile environment plus BROWSER; no host environment is
 * merged. Unsupported hosts fail before the ACP process is started.
 */
export async function createNoninteractiveAuthGuard(
  profile: ProfileContext,
): Promise<NoninteractiveAuthGuard> {
  if (!profile || typeof profile !== "object" || !profile.childEnvironment) {
    throw blockerUnavailable();
  }
  const environment = { ...profile.childEnvironment };
  if (platform() !== "win32") {
    const browserCommand = ["/bin/sh", "-c", `echo ${INTERACTIVE_LOGIN_BLOCK_MARKER} >&2`, "%s"]
      .map((part, index) => index === 3 ? '"%s"' : JSON.stringify(part))
      .join(" ");
    await verifyBlocker("/bin/sh", ["-c", `echo ${INTERACTIVE_LOGIN_BLOCK_MARKER} >&2`], environment);
    return Object.freeze({
      profile: withBrowser(profile, environment, browserCommand),
      async dispose() {},
    });
  }

  const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR;
  const home = environment.HOME;
  if (!systemRoot || !home || !isAbsolute(home) || systemRoot.includes(";")) throw blockerUnavailable();
  const scriptHost = win32.join(systemRoot, "System32", "cscript.exe");
  const directory = await mkdtemp(join(home, ".agy-browser-blocker-"))
    .catch(() => { throw blockerUnavailable(); });
  let directoryIdentity: FileIdentity | undefined;
  let scriptIdentity: FileIdentity | undefined;
  const scriptPath = join(directory, "blocker.js");
  try {
    await chmod(directory, PRIVATE_MODE).catch(() => undefined);
    const dirStats = await lstat(directory);
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) throw blockerUnavailable();
    const canonical = await realpath(directory);
    if (resolve(canonical) !== resolve(directory)) throw blockerUnavailable();
    directoryIdentity = Object.freeze({ dev: dirStats.dev, ino: dirStats.ino });
    if (scriptHost.includes(";") || scriptPath.includes(";")) throw blockerUnavailable();

    const handle = await open(scriptPath, "wx", PRIVATE_FILE_MODE);
    try {
      const initialStats = await handle.stat();
      if (!initialStats.isFile()) throw blockerUnavailable();
      scriptIdentity = Object.freeze({ dev: initialStats.dev, ino: initialStats.ino });
      await handle.writeFile(
        `WScript.StdErr.WriteLine("${INTERACTIVE_LOGIN_BLOCK_MARKER}");\nWScript.Quit(0);\n`,
        { encoding: "utf8" },
      );
      await handle.sync();
      const fileStats = await handle.stat();
      if (!fileStats.isFile() || fileStats.dev !== scriptIdentity.dev || fileStats.ino !== scriptIdentity.ino) {
        throw blockerUnavailable();
      }
    } finally {
      await handle.close();
    }
    const browserCommand = [scriptHost, "//nologo", "//E:JScript", scriptPath, "%s"]
      .map((part, index) => index === 4 ? '"%s"' : JSON.stringify(part))
      .join(" ");
    await verifyBlocker(scriptHost, ["//nologo", "//E:JScript", scriptPath], environment);
    let disposed = false;
    return Object.freeze({
      profile: withBrowser(profile, environment, browserCommand),
      async dispose(): Promise<void> {
        if (disposed) return;
        await cleanupArtifacts(directory, scriptPath, directoryIdentity, scriptIdentity);
        disposed = true;
      },
    });
  } catch (error) {
    try {
      await cleanupArtifacts(directory, scriptPath, directoryIdentity, scriptIdentity);
    } catch {
      throw new ProcessFailureError("Noninteractive ACP setup failed and its temporary blocker could not be cleaned up safely.", {
        cause: error,
      });
    }
    if (error instanceof UnsupportedFeatureError) throw error;
    throw blockerUnavailable();
  }
}

async function cleanupArtifacts(
  directory: string,
  scriptPath: string,
  directoryIdentity: FileIdentity | undefined,
  scriptIdentity: FileIdentity | undefined,
): Promise<void> {
  const currentFile = await lstat(scriptPath).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (currentFile) {
    if (
      currentFile.isSymbolicLink() || !currentFile.isFile() || !scriptIdentity ||
      currentFile.dev !== scriptIdentity.dev || currentFile.ino !== scriptIdentity.ino
    ) throw cleanupFailure();
    await unlink(scriptPath);
  }
  const currentDirectory = await lstat(directory).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!currentDirectory) return;
  if (
    currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || !directoryIdentity ||
    currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino
  ) throw cleanupFailure();
  await rmdir(directory).catch(() => { throw cleanupFailure(); });
}

function withBrowser(
  profile: ProfileContext,
  environment: Readonly<Record<string, string>>,
  browser: string,
): ProfileContext {
  return Object.freeze({
    accountId: profile.accountId,
    storageRoot: profile.storageRoot,
    childEnvironment: Object.freeze({ ...environment, BROWSER: browser }),
    acquireAuthLock: profile.acquireAuthLock,
  });
}

async function verifyBlocker(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    const result = await runFile(executable, [...args], {
      env: { ...environment },
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4_096,
      encoding: "utf8",
    });
    if (result.stdout !== "" || result.stderr.trim() !== INTERACTIVE_LOGIN_BLOCK_MARKER) {
      throw blockerUnavailable();
    }
  } catch {
    throw blockerUnavailable();
  }
}

function blockerUnavailable(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    "Cannot establish the noninteractive ACP browser block on this host; the ACP process was not started.",
  );
}

function cleanupFailure(): ProcessFailureError {
  return new ProcessFailureError("The temporary noninteractive browser blocker could not be removed safely.");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
