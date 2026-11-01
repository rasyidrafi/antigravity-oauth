import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { platform } from "node:os";
import { UnsupportedFeatureError } from "./errors.js";

interface ReviewedPair {
  readonly executable: string;
  readonly companion: string;
  readonly executableSha256: string;
  readonly companionSha256: string;
}

// These are the only ACP pairs reviewed for `_meta.agy.enabledTools: []`
// semantics. They match the reference plugin's ACP 1.3.0 compatibility gate.
// Unknown versions, platforms, and user-built binaries fail closed.
const REVIEWED: Readonly<Record<string, ReviewedPair>> = Object.freeze({
  "linux-x64": Object.freeze({
    executable: "agy_acp_server.par",
    companion: "localharness_external",
    executableSha256: "cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20",
    companionSha256: "63042ca43fc7a69600683920f7706689b82cf8aecefe21dc18cf35e99c9dde4d",
  }),
  "win32-x64": Object.freeze({
    executable: "agy_acp_server.exe",
    companion: "localharness_external.exe",
    executableSha256: "bc86a76bfe422a58aed70300fdab65457c7439b9fcb7d3f6c314ea6f79601fa3",
    companionSha256: "b200d5e01725784b45f99ee532b0da22f5fb43f01b16ecd69f225bf1ddf36557",
  }),
  "darwin-arm64": Object.freeze({
    executable: "agy_acp_server.par",
    companion: "localharness_external",
    executableSha256: "cb1f0725183ed922079ed6cd1d2422b4d8be44c5fb60be3e9a43d8d04f99a18e",
    companionSha256: "b04b00662c1821b953a409d43626b86d1229130eeb2078b4e1304c06199aa481",
  }),
});

function hasPathSeparator(value: string): boolean {
  return value.includes(sep) || value.includes("/") || value.includes("\\");
}

async function canonicalRegularFile(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

async function findExecutable(
  executable: string,
  cwd: string | undefined,
  environment: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (isAbsolute(executable)) {
    candidates.push(executable);
  } else if (hasPathSeparator(executable)) {
    candidates.push(resolve(cwd ?? process.cwd(), executable));
  } else {
    const searchPath = environment.PATH ?? "";
    const extensions = platform() === "win32" && !/\.[^\\/.]+$/u.test(executable)
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
    for (const directory of searchPath.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) candidates.push(join(directory, `${executable}${extension}`));
    }
  }
  for (const candidate of candidates) {
    const canonical = await canonicalRegularFile(candidate);
    if (!canonical) continue;
    try {
      await access(canonical, platform() === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return canonical;
    } catch {
      // Continue through the explicit profile PATH only.
    }
  }
  return undefined;
}

async function sha256Stable(path: string): Promise<string | undefined> {
  try {
    const before = await stat(path);
    if (!before.isFile()) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const after = await stat(path);
    if (
      !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    ) return undefined;
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Resolve and hash the configured ACP and its official companion. This is a
 * compatibility gate, not a sandbox or an operating-system isolation proof.
 */
export async function assertReviewedAcpPair(
  executable: string,
  cwd: string | undefined,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const pair = REVIEWED[`${process.platform}-${process.arch}`];
  const path = await findExecutable(executable, cwd, environment);
  if (!pair || !path || basenameMatches(path, pair.executable) === false) {
    throw incompatible();
  }
  const companion = await canonicalRegularFile(join(dirname(path), pair.companion));
  if (!companion || basenameMatches(companion, pair.companion) === false) throw incompatible();
  const [executableHash, companionHash] = await Promise.all([
    sha256Stable(path),
    sha256Stable(companion),
  ]);
  if (executableHash !== pair.executableSha256 || companionHash !== pair.companionSha256) {
    throw incompatible();
  }
  return path;
}

function basenameMatches(path: string, expected: string): boolean {
  const basename = path.slice(path.lastIndexOf(sep) + 1);
  return platform() === "win32"
    ? basename.toLowerCase() === expected.toLowerCase()
    : basename === expected;
}

function incompatible(): UnsupportedFeatureError {
  return new UnsupportedFeatureError(
    "The ACP executable and companion do not match a reviewed Antigravity 1.3.0 tool-isolation profile for this platform.",
  );
}
