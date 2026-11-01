import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
assert.ok(Number.parseInt(process.versions.node.split(".")[0], 10) >= 22);

const temporaryRoot = await mkdtemp(join(tmpdir(), "antigravity-git-install-"));
const home = join(temporaryRoot, "empty-home");
const cache = join(temporaryRoot, "npm-cache");
const userConfig = join(temporaryRoot, "empty.npmrc");
const npmRunner = join(temporaryRoot, "npm-runner.cjs");
const gitSnapshot = join(temporaryRoot, "source-snapshot");
const consumer = join(temporaryRoot, "consumer");
await Promise.all([
  mkdir(home),
  mkdir(cache),
  mkdir(gitSnapshot),
  mkdir(consumer),
  writeFile(userConfig, ""),
]);

async function existingFile(path) {
  try {
    await access(path);
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function resolveNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  const nodeBin = dirname(process.execPath);
  candidates.push(
    join(nodeBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeBin, "node_modules", "npm", "bin", "npm-cli.js"),
  );
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(
      join(directory, "npm-cli.js"),
      join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
    for (const executable of ["npm", "npm.cmd"]) {
      const resolvedExecutable = await existingFile(join(directory, executable));
      if (resolvedExecutable) {
        candidates.push(
          join(dirname(resolvedExecutable), "npm-cli.js"),
          join(dirname(resolvedExecutable), "..", "npm-cli.js"),
        );
      }
    }
  }

  for (const candidate of candidates) {
    const resolved = await existingFile(resolve(candidate));
    if (!resolved || !resolved.endsWith(`${sep}npm-cli.js`)) continue;
    try {
      const npmManifestPath = join(dirname(dirname(resolved)), "package.json");
      const npmManifest = JSON.parse(await readFile(npmManifestPath, "utf8"));
      if (npmManifest.name === "npm") return resolved;
    } catch {
      // Ignore similarly named but unrelated files and try the next location.
    }
  }
  throw new Error("Could not resolve the npm CLI JavaScript entrypoint for the selected Node runtime.");
}

const npmCliPath = await resolveNpmCli();
await writeFile(npmRunner, `
  const npmCli = process.argv[2];
  const npmArgs = process.argv.slice(3);
  process.argv = [process.execPath, npmCli, ...npmArgs];
  process.stderr.write("GIT_INSTALL_NPM_NODE_VERSION=" + process.version + "\\n");
  require(npmCli);
`);

const selectedNodeBin = dirname(process.execPath);
const inheritedPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
const cleanEnvironment = {
  PATH: [selectedNodeBin, ...inheritedPath.filter((directory) => resolve(directory) !== resolve(selectedNodeBin))].join(delimiter),
  HOME: home,
  TMPDIR: temporaryRoot,
  npm_config_userconfig: userConfig,
  npm_config_cache: cache,
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_audit: "false",
  npm_config_fund: "false",
  GIT_CONFIG_GLOBAL: join(temporaryRoot, "empty.gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  CI: "true",
};
await writeFile(cleanEnvironment.GIT_CONFIG_GLOBAL, "");

function runNpm(args, cwd = consumer) {
  const result = spawnSync(process.execPath, [npmRunner, npmCliPath, ...args], {
    cwd,
    env: cleanEnvironment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const evidence = result.stderr.match(/^GIT_INSTALL_NPM_NODE_VERSION=(.+)$/mu)?.[1];
  assert.equal(evidence, process.version, "npm CLI itself must run under the selected Node runtime");
  return result.stdout;
}

function runGit(args, cwd = gitSnapshot) {
  const result = spawnSync("git", args, {
    cwd,
    env: cleanEnvironment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runNode(args, cwd = consumer) {
  return execFileSync(process.execPath, args, {
    cwd,
    env: cleanEnvironment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

try {
  // Build a disposable Git repository from only package inputs. In particular,
  // do not copy ignored dist/node_modules, credentials, or unrelated worktree files.
  for (const name of [".gitignore", "README.md", "package-lock.json", "package.json", "tsconfig.json"]) {
    await copyFile(join(projectRoot, name), join(gitSnapshot, name));
  }
  await mkdir(join(gitSnapshot, "src"));
  for (const entry of await readdir(join(projectRoot, "src"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      await copyFile(join(projectRoot, "src", entry.name), join(gitSnapshot, "src", entry.name));
    }
  }

  assert.deepEqual((await readdir(gitSnapshot)).sort(), [
    ".gitignore", "README.md", "package-lock.json", "package.json", "src", "tsconfig.json",
  ]);
  await assert.rejects(access(join(gitSnapshot, "dist")), { code: "ENOENT" });
  await assert.rejects(access(join(gitSnapshot, "node_modules")), { code: "ENOENT" });
  runGit(["init", "--quiet", "--initial-branch=main"]);
  assert.equal(runGit(["check-ignore", "--quiet", "dist/index.js"]), "");
  runGit(["add", "--all"]);
  runGit([
    "-c", "user.name=Git install smoke test",
    "-c", "user.email=git-install-smoke@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "temporary package source snapshot",
  ]);
  assert.equal(runGit(["status", "--porcelain"]), "", "the temporary source snapshot must be committed and clean");
  assert.equal(runGit(["ls-files", "dist"]).length, 0, "the snapshot must not track generated dist files");
  const commit = runGit(["rev-parse", "HEAD"]);
  const gitSpec = `git+${pathToFileURL(gitSnapshot).href}#${commit}`;

  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "antigravity-git-install-consumer",
    version: "1.0.0",
    type: "module",
    private: true,
  }, null, 2));

  // Scripts are intentionally enabled. npm clones the committed Git source,
  // installs its build dependencies, runs prepare, then installs its packed output.
  runNpm([
    "install", "--no-audit", "--no-fund", "--omit=dev", "--omit=peer",
    gitSpec,
    "@zenmux/rosetta-ai@1.0.38",
  ]);

  const installedPackage = join(consumer, "node_modules", manifest.name);
  assert.equal(JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")).version, manifest.version);
  await assert.rejects(access(join(consumer, "node_modules", "typescript")), { code: "ENOENT" },
    "the clean consumer must not need TypeScript as a runtime or development dependency");
  for (const generatedFile of ["index.js", "index.d.ts", "chat.js", "chat.d.ts", "responses.js", "responses.d.ts"]) {
    await access(join(installedPackage, "dist", generatedFile));
  }

  runNode(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import * as sdk from "antigravity-oauth-sdk";
    import { createChatAdapter } from "antigravity-oauth-sdk/chat";
    import { createResponsesAdapter } from "antigravity-oauth-sdk/responses";
    assert.equal(typeof sdk.AntigravitySDK, "function");
    assert.equal(typeof sdk.connectAcp, "function");
    assert.equal(typeof createChatAdapter, "function");
    assert.equal(typeof createResponsesAdapter, "function");
  `]);

  await writeFile(join(consumer, "consumer-types.ts"), `
    import { AntigravitySDK, type AcpPermissionsOptions, type Session } from "antigravity-oauth-sdk";
    import { createChatAdapter, type ChatAdapter } from "antigravity-oauth-sdk/chat";
    import { createResponsesAdapter, type ResponsesAdapter } from "antigravity-oauth-sdk/responses";
    const sdk = new AntigravitySDK({ storageDir: "/tmp/types", executable: "/explicit/agy-acp" });
    const permissions: AcpPermissionsOptions = { mode: "deny" };
    declare const session: Session;
    const chat: ChatAdapter = createChatAdapter(session);
    const responses: ResponsesAdapter = createResponsesAdapter(session);
    void sdk;
    void permissions;
    void chat;
    void responses;
  `);
  runNode([
    join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "consumer-types.ts",
  ]);

  console.log(`Git-source consumer install passed: ${gitSpec}; Node ${process.versions.node}.`);
  console.log("Verified: a clean local Git snapshot contained no generated dist, npm ran prepare to build it, and root/Chat/Responses runtime exports and declarations resolve from the installed Git package.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
