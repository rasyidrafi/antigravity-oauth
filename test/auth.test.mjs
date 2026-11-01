import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  UnsupportedFeatureError,
  createProfileAuth,
  createProfileRegistry,
  createProfileRuntimeManager,
} from "../dist/index.js";

const wait = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait();
  }
  assert.fail(message);
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s3-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeAcpChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  writes = [];
  authRequest;
  killSignals = [];
  ended = false;

  constructor({
    authMethods = [{ id: "oauth-personal", name: "Login with Google" }],
    onAuthenticate = (message, child) => child.reply(message.id, {}),
    stderrSecret,
  } = {}) {
    super();
    this.onAuthenticate = onAuthenticate;
    this.authMethods = authMethods;
    this.stderrSecret = stderrSecret;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
        this.writes.push(message);
        if (message.method === "initialize") {
          this.reply(message.id, { protocolVersion: 1, authMethods: this.authMethods });
        } else if (message.method === "authenticate") {
          this.authRequest = message;
          if (this.stderrSecret) this.stderr.write(this.stderrSecret);
          this.onAuthenticate(message, this);
        }
        queueMicrotask(() => callback());
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => this.exit(0));
      },
    });
  }

  reply(id, result, error) {
    const body = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };
    this.stdout.write(`${JSON.stringify(body)}\n`);
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.exit(0, signal);
    return true;
  }

  exit(code = 0, signal = null) {
    if (this.ended) return;
    this.ended = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.stdin.destroy();
    this.emit("close", code, signal);
  }
}

function fakeProcessFactory({
  authMethods,
  onAuthenticate,
  stderrSecret,
  children,
  spawnCalls,
} = {}) {
  return (executable, args, options) => {
    spawnCalls?.push({ executable, args, options });
    const child = new FakeAcpChild({ authMethods, onAuthenticate, stderrSecret });
    children?.push(child);
    return child;
  };
}

function makeAuth(registry, profile, options = {}) {
  return createProfileAuth(registry.accounts, profile.id, {
    executable: "/fake/agy-acp",
    args: ["--stdio"],
    shutdownTimeoutMs: 10,
    processFactory: fakeProcessFactory(options),
    ...options.authOptions,
  });
}

async function createRegistry(root, environment = { PATH: "/safe/bin" }) {
  return createProfileRegistry({ storageDir: join(root, "sdk"), environment });
}

test("login explicitly authenticates only an advertised supported method; status is inert", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root, {
      PATH: "/safe/bin",
      GEMINI_API_KEY: "ambient-secret",
      GOOGLE_API_KEY: "ambient-secret-2",
      HOME: "/ambient/home",
      NODE_OPTIONS: "--require=not-allowed",
      BROWSER: "/ambient/browser",
    });
    const profile = await registry.accounts.create();
    const children = [];
    const spawnCalls = [];
    const auth = makeAuth(registry, profile, { children, spawnCalls });
    const originalEnv = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      BROWSER: process.env.BROWSER,
    };

    assert.deepEqual(await auth.status(), {
      state: "unknown",
      accountId: profile.id,
      reason: "no-auth-result-observed-in-this-handle",
    });
    assert.equal(spawnCalls.length, 0, "status must not start ACP or a browser");

    await auth.login({ methodId: "oauth-personal" });
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].writes.map(({ method }) => method), ["initialize", "authenticate"]);
    assert.deepEqual(children[0].authRequest.params, { methodId: "oauth-personal" });
    assert.equal(children[0].ended, true, "the temporary login worker is closed before login resolves");
    assert.equal(spawnCalls[0].executable, "/fake/agy-acp");
    assert.deepEqual(spawnCalls[0].args, ["--stdio"]);
    assert.equal(spawnCalls[0].options.env.GEMINI_HOME, join(profile.context.storageRoot, "gemini"));
    assert.equal(spawnCalls[0].options.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.equal(Object.hasOwn(spawnCalls[0].options.env, "GEMINI_API_KEY"), false);
    assert.equal(Object.hasOwn(spawnCalls[0].options.env, "GOOGLE_API_KEY"), false);
    assert.equal(Object.hasOwn(spawnCalls[0].options.env, "NODE_OPTIONS"), false);
    assert.equal(Object.hasOwn(spawnCalls[0].options.env, "BROWSER"), false);
    assert.deepEqual({
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      BROWSER: process.env.BROWSER,
    }, originalEnv);
    assert.equal((await auth.status()).state, "authenticated");

    const newHandle = makeAuth(registry, profile, { children, spawnCalls });
    assert.equal((await newHandle.status()).state, "unknown");
    assert.equal(spawnCalls.length, 1, "status on a new handle also remains inert");
  });
});

test("unsupported advertised auth methods fail without fallback or authenticate", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const children = [];
    const auth = makeAuth(registry, profile, {
      children,
      authMethods: [
        { id: "api-key", name: "Gemini API key" },
        { id: "enterprise-login", name: "Enterprise login" },
      ],
    });
    await assert.rejects(auth.login(), UnsupportedFeatureError);
    assert.deepEqual(children[0].writes.map(({ method }) => method), ["initialize"]);
    assert.equal(children[0].ended, true);
  });
});

test("an explicit unknown requested flow fails before spawning ACP", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const spawnCalls = [];
    const auth = makeAuth(registry, profile, { spawnCalls });
    await assert.rejects(auth.login({ methodId: "oauth-enterprise" }), UnsupportedFeatureError);
    assert.equal(spawnCalls.length, 0);
  });
});

test("ACP startup failure is typed and releases the profile auth lock", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const auth = createProfileAuth(registry.accounts, profile.id, {
      executable: "fake-agent",
      processFactory: () => { throw new Error("private startup detail"); },
    });
    await assert.rejects(auth.login(), ProcessFailureError);
    await auth.logout();
    assert.equal((await auth.status()).state, "unknown");
  });
});

test("ACP authentication rejection is typed, does not retry, and does not expose remote secrets", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const children = [];
    const secret = "remote-refresh-error-secret-do-not-log";
    const auth = makeAuth(registry, profile, {
      children,
      stderrSecret: secret,
      authMethods: [
        { id: "oauth-personal", name: "Login with Google" },
        { id: "api-key", name: "API key" },
      ],
      onAuthenticate: (message, child) => child.reply(message.id, undefined, {
        code: -32001,
        message: secret,
      }),
    });
    const emitted = [];
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    for (const name of Object.keys(originalConsole)) {
      console[name] = (...values) => emitted.push(values.join(" "));
    }
    try {
      await assert.rejects(auth.login(), (error) => {
        assert.ok(error instanceof AuthenticationError);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.cause?.message.includes(secret), false);
        return true;
      });
    } finally {
      for (const [name, original] of Object.entries(originalConsole)) console[name] = original;
    }
    assert.deepEqual(children[0].writes.map(({ method }) => method), ["initialize", "authenticate"]);
    assert.equal(children[0].ended, true);
    assert.deepEqual(emitted, []);
    assert.notEqual((await auth.status()).state, "authenticated");
  });
});

test("login propagates cancellation and timeout and closes the worker", async (t) => {
  await t.test("abort", async () => {
    await withTempDirectory(async (root) => {
      const registry = await createRegistry(root);
      const profile = await registry.accounts.create();
      const children = [];
      let entered;
      const enteredPromise = new Promise((resolve) => { entered = resolve; });
      const auth = makeAuth(registry, profile, {
        children,
        onAuthenticate: () => entered(),
      });
      const controller = new AbortController();
      const pending = auth.login({ signal: controller.signal });
      await enteredPromise;
      controller.abort();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal(children[0].ended, true);
    });
  });

  await t.test("timeout", async () => {
    await withTempDirectory(async (root) => {
      const registry = await createRegistry(root);
      const profile = await registry.accounts.create();
      const children = [];
      const auth = makeAuth(registry, profile, {
        children,
        onAuthenticate: () => {},
      });
      await assert.rejects(auth.login({ timeoutMs: 25 }), RequestTimeoutError);
      assert.equal(children[0].ended, true);
    });
  });
});

function authorizationUrl(redirectUri, state = "state-s3") {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", "mock-client");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("headless login validates and forwards a matching loopback callback", async (t) => {
  if (platform() === "win32") return t.skip("manual OAuth capture is not supported on Windows");
  await withTempDirectory(async (root) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      assert.equal(url.searchParams.get("state"), "state-s3");
      assert.equal(url.searchParams.get("code"), "mock-one-time-code");
      response.writeHead(200).end("ok");
      activeChild.reply(activeChild.authRequest.id, {});
    });
    const port = await listen(server);
    let activeChild;
    const children = [];
    const spawnCalls = [];
    const redirect = `http://127.0.0.1:${port}/oauth/callback`;
    const authUrl = authorizationUrl(redirect);
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const auth = makeAuth(registry, profile, {
      children,
      spawnCalls,
      onAuthenticate: (message, child) => {
        activeChild = child;
        const environment = spawnCalls[0].options.env;
        const captured = spawnSync(environment.BROWSER, [authUrl], { env: environment, encoding: "utf8" });
        assert.equal(captured.status, 0, captured.stderr);
      },
    });
    let displayedUrl;
    try {
      await auth.login({
        interaction: {
          showAuthorizationUrl(url) { displayedUrl = url; },
          async promptForCallback() {
            return `${redirect}?state=state-s3&code=mock-one-time-code`;
          },
        },
      });
      assert.equal(displayedUrl, authUrl);
      assert.equal(children[0].ended, true);
      assert.equal(spawnCalls[0].options.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
      const captureDirectory = spawnCalls[0].options.env.BROWSER.split("/").slice(0, -1).join("/");
      await assert.rejects(stat(captureDirectory), { code: "ENOENT" });
    } finally {
      await closeServer(server);
    }
  });
});

test("headless OAuth rejects unsafe authorization origins and callback origin/path/state mismatches", async (t) => {
  if (platform() === "win32") return t.skip("manual OAuth capture is not supported on Windows");
  await t.test("unexpected authorization origin", async () => {
    await withTempDirectory(async (root) => {
      const registry = await createRegistry(root);
      const profile = await registry.accounts.create();
      const children = [];
      const spawnCalls = [];
      const auth = makeAuth(registry, profile, {
        children,
        spawnCalls,
        onAuthenticate: (_message, child) => {
          const env = spawnCalls[0].options.env;
          const url = authorizationUrl("http://127.0.0.1:32123/callback").replace(
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://evil.example/oauth",
          );
          const result = spawnSync(env.BROWSER, [url], { env, encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        },
      });
      let prompted = false;
      await assert.rejects(auth.login({
        interaction: {
          showAuthorizationUrl() {},
          async promptForCallback() { prompted = true; return ""; },
        },
      }), InvalidRequestError);
      assert.equal(prompted, false);
      assert.equal(children[0].ended, true);
    });
  });

  for (const [name, callback] of [
    ["different origin/port", (redirect) => `http://127.0.0.1:1/callback?state=state-s3&code=x`],
    ["different path", (redirect) => `${redirect.replace("/callback", "/other")}?state=state-s3&code=x`],
    ["wrong state", (redirect) => `${redirect}?state=wrong&code=x`],
    ["non-loopback host", (_redirect) => "http://example.com/callback?state=state-s3&code=x"],
  ]) {
    await t.test(name, async () => {
      await withTempDirectory(async (root) => {
        const registry = await createRegistry(root);
        const profile = await registry.accounts.create();
        const children = [];
        const spawnCalls = [];
        const redirect = "http://127.0.0.1:32123/callback";
        const auth = makeAuth(registry, profile, {
          children,
          spawnCalls,
          onAuthenticate: (_message, child) => {
            const env = spawnCalls[0].options.env;
            const result = spawnSync(env.BROWSER, [authorizationUrl(redirect)], { env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
          },
        });
        await assert.rejects(auth.login({
          interaction: {
            showAuthorizationUrl() {},
            async promptForCallback() { return callback(redirect); },
          },
        }), InvalidRequestError);
        assert.equal(children[0].ended, true);
      });
    });
  }
});

test("per-profile lock serializes login across OS processes", async () => {
  await withTempDirectory(async (root) => {
    const storageRoot = join(root, "sdk");
    const registry = await createProfileRegistry({ storageDir: storageRoot, environment: { PATH: process.env.PATH } });
    const profile = await registry.accounts.create();
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const children = [];
    const auth = makeAuth(registry, profile, {
      children,
      onAuthenticate: () => entered(),
    });
    const controller = new AbortController();
    const firstLogin = auth.login({ signal: controller.signal, timeoutMs: 5_000 });
    await enteredPromise;

    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const script = `
      import { createProfileAuth, createProfileRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = await createProfileRegistry({ storageDir: ${JSON.stringify(storageRoot)}, environment: { PATH: process.env.PATH } });
      let spawned = false;
      const auth = createProfileAuth(registry.accounts, ${JSON.stringify(profile.id)}, {
        executable: "fake-agent",
        lockTimeoutMs: 200,
        processFactory: () => { spawned = true; throw new Error("unexpected spawn"); },
      });
      try { await auth.login(); console.log("RESULT:unexpected-success"); }
      catch (error) { console.log("RESULT:" + error.code + ":spawned=" + spawned); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /RESULT:session_busy:spawned=false/u);
    controller.abort();
    await assert.rejects(firstLogin, RequestAbortedError);
    assert.equal(children[0].ended, true);
  });
});

test("login revalidates the registry profile after worker shutdown and before ACP spawn", async (t) => {
  if (platform() === "win32") return t.skip("directory symlink fixture requires elevated privileges on Windows");
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    const profileRoot = profile.context.storageRoot;
    const movedProfile = `${profileRoot}.moved`;
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    let replaced = false;
    await manager.connect(profile.context, async () => ({
      async close() {
        await rename(profileRoot, movedProfile);
        await symlink(outside, profileRoot, "dir");
        replaced = true;
      },
    }));
    let spawnCount = 0;
    const auth = createProfileAuth(registry.accounts, profile.id, {
      executable: "must-not-spawn",
      workerManager: manager,
      processFactory: () => {
        spawnCount += 1;
        throw new Error("unexpected spawn");
      },
    });
    try {
      await assert.rejects(auth.login(), InternalError);
      assert.equal(replaced, true);
      assert.equal(spawnCount, 0);
    } finally {
      await unlink(profileRoot).catch(() => undefined);
      await rename(movedProfile, profileRoot);
      await unlink(join(profileRoot, ".auth-operation.lock")).catch(() => undefined);
    }
  });
});

test("logout closes only the selected profile workers and preserves unrelated files/accounts", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const first = await registry.accounts.create();
    const second = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    const firstAuthDirectory = join(first.context.childEnvironment.GEMINI_HOME, "antigravity-acp");
    const secondAuthDirectory = join(second.context.childEnvironment.GEMINI_HOME, "antigravity-acp");
    await mkdir(firstAuthDirectory, { recursive: true, mode: 0o700 });
    await mkdir(secondAuthDirectory, { recursive: true, mode: 0o700 });
    const firstToken = join(firstAuthDirectory, "acp_token.json");
    const secondToken = join(secondAuthDirectory, "acp_token.json");
    const firstSettings = join(firstAuthDirectory, "settings.json");
    const secondSettings = join(secondAuthDirectory, "settings.json");
    await writeFile(firstToken, '{"refresh_token":"private-A"}\n', { mode: 0o600 });
    await writeFile(secondToken, '{"refresh_token":"private-B"}\n', { mode: 0o600 });
    await writeFile(firstSettings, JSON.stringify({ auth: { type: "oauth-personal" }, userSetting: "keep-A" }), { mode: 0o600 });
    await writeFile(secondSettings, JSON.stringify({ auth: { type: "oauth-personal" }, userSetting: "keep-B" }), { mode: 0o600 });
    await writeFile(join(firstAuthDirectory, "unrelated.json"), "keep this", { mode: 0o600 });

    let firstClosed = 0;
    let secondClosed = 0;
    await manager.connect(first.context, async () => ({
      async close() {
        assert.equal(await readFile(firstToken, "utf8"), '{"refresh_token":"private-A"}\n', "worker teardown precedes file deletion");
        firstClosed += 1;
      },
    }));
    await manager.connect(second.context, async () => ({ async close() { secondClosed += 1; } }));

    const auth = createProfileAuth(registry.accounts, first.id, {
      executable: "unused",
      workerManager: manager,
    });
    await auth.logout();

    assert.equal(firstClosed, 1);
    assert.equal(secondClosed, 0, "logging out A must not close B workers");
    await assert.rejects(readFile(firstToken), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(firstSettings, "utf8")), { userSetting: "keep-A" });
    assert.equal(await readFile(join(firstAuthDirectory, "unrelated.json"), "utf8"), "keep this");
    assert.equal(await readFile(secondToken, "utf8"), '{"refresh_token":"private-B"}\n');
    assert.deepEqual(JSON.parse(await readFile(secondSettings, "utf8")), {
      auth: { type: "oauth-personal" },
      userSetting: "keep-B",
    });
    assert.equal((await auth.status()).state, "logged-out");
    assert.deepEqual((await registry.accounts.list()).map((item) => item.id).sort(), [first.id, second.id].sort());
    const gate = await manager.closeProfile(second.context);
    await gate.release();
    assert.equal(secondClosed, 1);
  });
});

test("logout refuses symlinked credential state without touching the symlink target", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const authDirectory = join(profile.context.childEnvironment.GEMINI_HOME, "antigravity-acp");
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    const outside = join(root, "outside-secret.json");
    await writeFile(outside, "preserve-secret-file", { mode: 0o600 });
    await symlink(outside, join(authDirectory, "acp_token.json"));
    const auth = createProfileAuth(registry.accounts, profile.id, { executable: "unused" });

    await assert.rejects(auth.logout(), InternalError);
    assert.equal(await readFile(outside, "utf8"), "preserve-secret-file");
    assert.equal((await readdir(authDirectory)).includes("acp_token.json"), true);
    assert.equal((await auth.status()).state, "unknown");
  });
});

test("logout does not delete credentials when an active worker cannot be closed", async () => {
  await withTempDirectory(async (root) => {
    const registry = await createRegistry(root);
    const profile = await registry.accounts.create();
    const directory = join(profile.context.childEnvironment.GEMINI_HOME, "antigravity-acp");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const token = join(directory, "acp_token.json");
    await writeFile(token, "credential", { mode: 0o600 });
    const manager = createProfileRuntimeManager();
    await manager.connect(profile.context, async () => ({ async close() { throw new Error("private worker detail"); } }));
    const auth = createProfileAuth(registry.accounts, profile.id, { executable: "unused", workerManager: manager });

    await assert.rejects(auth.logout(), ProcessFailureError);
    assert.equal(await readFile(token, "utf8"), "credential");
  });
});

test("headless callback capture rejects duplicated state and non-numeric loopback hosts", async (t) => {
  if (platform() === "win32") return t.skip("manual OAuth capture is not supported on Windows");
  for (const [name, redirect] of [
    ["localhost hostname", "http://localhost:1234/callback"],
    ["duplicated state", "http://127.0.0.1:1234/callback?state=from-url"],
  ]) {
    await t.test(name, async () => {
      await withTempDirectory(async (root) => {
        const registry = await createRegistry(root);
        const profile = await registry.accounts.create();
        const children = [];
        const spawnCalls = [];
        const badUrl = name === "duplicated state"
          ? `${authorizationUrl("http://127.0.0.1:1234/callback", "state-s3")}&state=second`
          : authorizationUrl(redirect);
        const auth = makeAuth(registry, profile, {
          children,
          spawnCalls,
          onAuthenticate: (_message, child) => {
            const env = spawnCalls[0].options.env;
            const result = spawnSync(env.BROWSER, [badUrl], { env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
          },
        });
        await assert.rejects(auth.login({
          interaction: { showAuthorizationUrl() {}, async promptForCallback() { return ""; } },
        }), InvalidRequestError);
        assert.equal(children[0].ended, true);
      });
    });
  }
});
