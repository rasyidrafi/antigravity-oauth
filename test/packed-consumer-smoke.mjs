import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const packageExports = Object.keys(manifest.exports).sort();
assert.deepEqual(packageExports, [".", "./chat", "./responses"]);
assert.ok(Number.parseInt(process.versions.node.split(".")[0], 10) >= 22);

const temporaryRoot = await mkdtemp(join(tmpdir(), "antigravity-s11.7-pack-"));
const home = join(temporaryRoot, "empty-home");
const cache = join(temporaryRoot, "npm-cache");
const artifacts = join(temporaryRoot, "artifacts");
const userConfig = join(temporaryRoot, "empty.npmrc");
const npmRunner = join(temporaryRoot, "npm-runner.cjs");
await Promise.all([mkdir(home), mkdir(cache), mkdir(artifacts), writeFile(userConfig, "")]);

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
  process.stderr.write("S11.7_NPM_NODE_VERSION=" + process.version + "\\n");
  require(npmCli);
`);

// Keep the package install isolated from user npm configuration and ambient
// credentials. Network access is only for public package dependencies.
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
  CI: "true",
};

function runNpm(args, cwd = projectRoot) {
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
  const evidence = result.stderr.match(/^S11\.7_NPM_NODE_VERSION=(.+)$/mu)?.[1];
  assert.equal(evidence, process.version, "npm CLI itself must run under the selected Node runtime");
  process.stdout.write(`npm CLI child runtime: Node ${evidence} (${args[0]}).\n`);
  return result.stdout;
}

function runNode(args, cwd, environment = {}) {
  return execFileSync(process.execPath, args, {
    cwd,
    env: { ...cleanEnvironment, ...environment },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function createConsumer(name) {
  const directory = join(temporaryRoot, name);
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
    private: true,
  }, null, 2));
  return directory;
}

try {
  const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts]))[0];
  const packedPaths = packed.files.map(({ path }) => path);
  assert.equal(packedPaths.some((path) => path.startsWith("test/")), false,
    "the private ACP process/hash mock harness must not enter the published package");
  const tarball = join(artifacts, packed.filename);
  const coreConsumer = await createConsumer("antigravity-clean-core-consumer");
  const adapterConsumer = await createConsumer("antigravity-clean-adapter-consumer");

  runNpm([
    "install", "--prefix", coreConsumer, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=peer", tarball,
  ]);
  runNpm([
    "install", "--prefix", adapterConsumer, "--ignore-scripts", "--no-audit", "--no-fund",
    tarball, "@zenmux/rosetta-ai@1.0.38",
  ]);

  const coreConsumerManifestPath = join(coreConsumer, "package.json");
  const coreConsumerManifest = JSON.parse(await readFile(coreConsumerManifestPath, "utf8"));
  coreConsumerManifest.scripts = { "node-runtime-check": "node -p process.version" };
  await writeFile(coreConsumerManifestPath, JSON.stringify(coreConsumerManifest, null, 2));
  const lifecycleNodeVersion = runNpm(["run", "--silent", "node-runtime-check"], coreConsumer).trim();
  assert.equal(lifecycleNodeVersion, process.version, "npm lifecycle PATH must resolve the selected Node runtime");
  process.stdout.write(`npm lifecycle command runtime: Node ${lifecycleNodeVersion}.\n`);

  const denyRosettaLoader = join(projectRoot, "test", "deny-rosetta-loader.mjs");
  const coreSmoke = `
    import assert from "node:assert/strict";
    import { access } from "node:fs/promises";
    import { createRequire } from "node:module";
    import { join } from "node:path";

    const listeners = () => JSON.stringify(process.eventNames()
      .map((event) => [String(event), process.listenerCount(event)])
      .sort((left, right) => left[0].localeCompare(right[0])));
    const beforeImport = listeners();
    const sdkApi = await import("antigravity-oauth-sdk");
    assert.equal(listeners(), beforeImport, "importing the core adds no process listeners");
    const require = createRequire(join(process.cwd(), "package.json"));
    assert.throws(() => require.resolve("@zenmux/rosetta-ai"), { code: "MODULE_NOT_FOUND" });
    assert.equal(typeof sdkApi.AntigravitySDK, "function");
    assert.equal(typeof sdkApi.messageMaxTokensEnforcement, "function");
    assert.equal("createServer" in sdkApi, false);
    assert.equal("createInferenceServer" in sdkApi, false);
    assert.equal("serve" in sdkApi, false);
    for (const subpath of ["server", "inference", "cli"]) {
      await assert.rejects(import("antigravity-oauth-sdk/" + subpath), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
    const beforeConstruction = listeners();
    const storageDir = join(process.cwd(), ".constructor-must-not-create-storage");
    let authProcessCalls = 0;
    const sdk = new sdkApi.AntigravitySDK({
      storageDir,
      executable: "/unreviewed/no-credentials/agy-acp",
      processFactory() { authProcessCalls += 1; throw new Error("unexpected auth process"); },
    });
    const account = sdk.accounts.get("acct_00000000-0000-4000-8000-000000000000");
    assert.equal(account.id, "acct_00000000-0000-4000-8000-000000000000");
    assert.equal(listeners(), beforeConstruction, "construction and inert account selection add no process listeners");
    await assert.rejects(access(storageDir), { code: "ENOENT" });
    assert.equal(authProcessCalls, 0, "construction must not start an auth child");
    await sdk.close();
    assert.equal(listeners(), beforeConstruction, "close leaves no construction-time process listeners");

    const blockedSdk = new sdkApi.AntigravitySDK({
      storageDir: join(process.cwd(), ".default-driver-fails-closed"),
      executable: "/unreviewed/no-credentials/agy-acp",
    });
    const blockedAccount = await blockedSdk.accounts.create();
    await assert.rejects(
      blockedAccount.sessions.create({ model: "model", cwd: process.cwd() }),
      (error) => error instanceof sdkApi.UnsupportedFeatureError && /reviewed Antigravity/u.test(error.message),
    );
    await blockedSdk.close();
    assert.equal(listeners(), beforeConstruction, "failed default-driver startup leaves no process listeners");
  `;
  runNode([
    "--no-warnings", "--experimental-loader", denyRosettaLoader, "--input-type=module", "-e", coreSmoke,
  ], coreConsumer);

  const publicSdkIntegration = runNode([
    "--experimental-test-module-mocks", "--test",
    join(projectRoot, "test", "fixtures", "public-sdk-acp-integration.mjs"),
  ], coreConsumer, {
    ANTIGRAVITY_TEST_PACKAGE_ENTRY: join(coreConsumer, "node_modules", manifest.name, "dist", "index.js"),
  });
  process.stdout.write(publicSdkIntegration);

  const adapterIntegration = runNode([
    "--experimental-test-module-mocks", "--test",
    join(projectRoot, "test", "fixtures", "public-sdk-acp-integration.mjs"),
  ], adapterConsumer, {
    ANTIGRAVITY_TEST_PACKAGE_ENTRY: join(adapterConsumer, "node_modules", manifest.name, "dist", "index.js"),
    ANTIGRAVITY_TEST_ADAPTERS: "1",
  });
  process.stdout.write(adapterIntegration);

  const coreTypeSource = `
    import {
      AntigravitySDK,
      messageMaxTokensEnforcement,
      type MaxTokensEnforcementDiagnostic,
      type Message,
    } from "antigravity-oauth-sdk";
    const sdk = new AntigravitySDK({ storageDir: "/tmp/sdk-types", executable: "/explicit/agy-acp" });
    const account = sdk.accounts.get("account-id");
    const message: Message | undefined = undefined;
    const diagnostic: MaxTokensEnforcementDiagnostic | undefined = message
      ? messageMaxTokensEnforcement(message)
      : undefined;
    void account;
    void message;
    void diagnostic;
    void sdk;
  `;
  await writeFile(join(coreConsumer, "consumer-types.ts"), coreTypeSource);
  runNode([
    join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "consumer-types.ts",
  ], coreConsumer);

  const adapterSmoke = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import * as sdkApi from "antigravity-oauth-sdk";
    import { createChatAdapter } from "antigravity-oauth-sdk/chat";
    import { createResponsesAdapter } from "antigravity-oauth-sdk/responses";
    assert.doesNotThrow(() => createRequire(import.meta.url).resolve("@zenmux/rosetta-ai"));
    assert.equal(typeof sdkApi.AntigravitySDK, "function");
    assert.equal(typeof createChatAdapter, "function");
    assert.equal(typeof createResponsesAdapter, "function");
  `;
  runNode([
    "--no-warnings", "--experimental-loader", denyRosettaLoader, "--input-type=module", "-e",
    `await import("antigravity-oauth-sdk");`,
  ], adapterConsumer);
  runNode(["--input-type=module", "-e", adapterSmoke], adapterConsumer);

  const adapterTypeSource = `
    import { AntigravitySDK } from "antigravity-oauth-sdk";
    import { createChatAdapter, type ChatAdapter } from "antigravity-oauth-sdk/chat";
    import { createResponsesAdapter, type ResponsesAdapter } from "antigravity-oauth-sdk/responses";
    const sdk = new AntigravitySDK({ storageDir: "/tmp/sdk-types", executable: "/explicit/agy-acp" });
    const session = await sdk.accounts.get("account-id").sessions.create({ model: "model", cwd: "/workspace" });
    const chat: ChatAdapter = createChatAdapter(session);
    const responses: ResponsesAdapter = createResponsesAdapter(session);
    void chat;
    void responses;
  `;
  await writeFile(join(adapterConsumer, "consumer-types.ts"), adapterTypeSource);
  runNode([
    join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "consumer-types.ts",
  ], adapterConsumer);

  console.log(`Packed consumer smoke passed: ${packed.filename}; Node ${process.versions.node}.`);
  console.log("Verified: optional peer absent for core; root import does not resolve Rosetta; constructor is inert; default driver fails closed; built-in compatibility/permission path composes from the packed root using only in-memory fake ACP/MCP; Chat nonstream and Responses stream disclose not-enforced from that same driver when the pinned peer is installed; no public server/inference export; Chat/Responses imports and declarations resolve with @zenmux/rosetta-ai@1.0.38.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
