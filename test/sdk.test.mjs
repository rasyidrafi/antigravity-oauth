import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  AntigravitySDK,
  InvalidRequestError,
  ProcessFailureError,
  RequestAbortedError,
  SDKClosedError,
  SessionNotFoundError,
  UnsupportedFeatureError,
  createProfileRegistry,
} from "../dist/index.js";
import { normalizeAcpPermissionPolicy } from "../dist/acp-permissions.js";
import { createAntigravitySDKWithModelDiscoveryFactoryForTests } from "../dist/sdk.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s11-1-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeAuthChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  writes = [];
  ended = false;
  onAuthenticate;
  onAuthenticateStarted;

  constructor({ onAuthenticate = () => {}, onAuthenticateStarted = () => {} } = {}) {
    super();
    this.onAuthenticate = onAuthenticate;
    this.onAuthenticateStarted = onAuthenticateStarted;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
        this.writes.push(message);
        if (message.method === "initialize") {
          this.reply(message.id, {
            protocolVersion: 1,
            authMethods: [{ id: "oauth-personal", name: "OAuth" }],
          });
        } else if (message.method === "authenticate") {
          this.onAuthenticateStarted();
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
    this.stdout.write(`${JSON.stringify(error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result })}\n`);
  }

  kill(signal = "SIGTERM") {
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

const createFakeAuthProcessFactory = (options) => () => new FakeAuthChild(options);

const createSessionDriver = (context, onClose = () => {}) => ({
  capabilities: { maxTokens: "enforced" },
  async admitResponse(request) {
    return {
      kind: request.kind,
      operationId: request.operationId,
      accountId: request.accountId,
      sessionId: request.sessionId,
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      policy: request.policy,
      outcome: request.maxTokens === undefined ? "unbounded" : "enforced",
      reason: request.maxTokens === undefined
        ? "no-output-token-bound-requested"
        : "driver-admitted-requested-bound",
    };
  },
  async dispatch(operation) {
    return {
      stage: "completed",
      output: [{ role: "assistant", content: `${operation.accountId}/${operation.sessionId}` }],
      result: { stopReason: "end_turn" },
    };
  },
  async close() {
    onClose(context);
  },
});

test("construction is lazy, synchronous handles stay inert, and no default driver is invented", async () => {
  await withTempDirectory(async (root) => {
    let processCalls = 0;
    let registryCalls = 0;
    const storageDir = join(root, "not-created-until-used");
    const processListenersBefore = new Map(process.eventNames().map((event) => [
      event,
      process.listenerCount(event),
    ]));
    const sdk = new AntigravitySDK({
      storageDir,
      executable: "/fake/agy-acp",
      processFactory() {
        processCalls += 1;
        throw new Error("must not spawn");
      },
      profileRegistryFactory: async (options) => {
        registryCalls += 1;
        return createProfileRegistry(options);
      },
    });

    const account = sdk.accounts.get("acct_00000000-0000-4000-8000-000000000000");
    assert.equal(account.id, "acct_00000000-0000-4000-8000-000000000000");
    await assert.rejects(stat(storageDir), { code: "ENOENT" });
    assert.equal(registryCalls, 0);
    assert.equal(processCalls, 0);
    assert.deepEqual(
      new Map(process.eventNames().map((event) => [event, process.listenerCount(event)])),
      processListenersBefore,
    );

    await sdk.close();
    assert.throws(() => sdk.accounts.get(account.id), SDKClosedError);
    await assert.rejects(account.auth.status(), SDKClosedError);
    assert.equal(processCalls, 0);
  });
});

test("SDK policy options are copied per instance and pinned to immutable driver contexts", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const options = {
      storageDir: join(root, "profiles-one"),
      executable: "/fake/agy-acp",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      sessionDriverFactory(context) {
        contexts.push(context);
        return createSessionDriver(context);
      },
    };
    const first = new AntigravitySDK(options);
    options.maxTokensPolicy = "strict";
    options.sessionDriverFactory = () => { throw new Error("mutated factory must not be used"); };

    const second = new AntigravitySDK({
      storageDir: join(root, "profiles-two"),
      executable: "/fake/agy-acp",
      sessionDriverFactory(context) {
        contexts.push(context);
        return createSessionDriver(context);
      },
    });
    const firstAccount = await first.accounts.create();
    const secondAccount = await second.accounts.create();
    const firstSession = await firstAccount.sessions.create({ model: "model", cwd: "/workspace" });
    const secondSession = await secondAccount.sessions.create({ model: "model", cwd: "/workspace" });

    assert.deepEqual(contexts.map(({ maxTokensPolicy }) => maxTokensPolicy), [
      "allow-unenforced-max-tokens",
      "strict",
    ]);
    assert.equal(contexts.every(Object.isFrozen), true);
    assert.equal(firstSession.capabilities.maxTokens, "enforced");
    assert.equal(secondSession.capabilities.maxTokens, "enforced");
    await first.close();
    await second.close();
  });
});

test("SDK rejects malformed policy/permission options and callback bypass through a custom driver", async () => {
  const base = { storageDir: "/private/sdk-data", executable: "/fake/agy-acp" };
  for (const maxTokensPolicy of ["allow", "unbounded", true]) {
    assert.throws(
      () => new AntigravitySDK({ ...base, maxTokensPolicy }),
      InvalidRequestError,
    );
  }

  const handler = () => ({ action: "deny" });
  for (const permissions of [
    null,
    {},
    { onRequest: "not-a-function" },
    { onRequest: handler, timeoutMs: 0 },
    { onRequest: handler, timeoutMs: 60_001 },
    { onRequest: handler, timeoutMs: 1.5 },
    { onRequest: handler, extra: true },
    { mode: "unexpected" },
    { mode: "auto", onRequest: handler },
    { mode: "deny", onRequest: undefined },
    { onRequest: handler, mode: undefined },
    { mode: "auto", timeoutMs: 0 },
  ]) {
    assert.throws(() => new AntigravitySDK({ ...base, permissions }), InvalidRequestError);
  }

  let accessorCalled = false;
  const accessorPermissions = Object.defineProperty({}, "mode", {
    enumerable: true,
    get() {
      accessorCalled = true;
      return "auto";
    },
  });
  assert.throws(() => new AntigravitySDK({ ...base, permissions: accessorPermissions }), InvalidRequestError);
  assert.equal(accessorCalled, false, "permission accessors are rejected without execution");
  const symbolPermissions = { mode: "auto", [Symbol("unexpected")]: true };
  assert.throws(() => new AntigravitySDK({ ...base, permissions: symbolPermissions }), InvalidRequestError);
  const nonEnumerablePermissions = Object.defineProperty({}, "mode", { value: "auto" });
  assert.throws(() => new AntigravitySDK({ ...base, permissions: nonEnumerablePermissions }), InvalidRequestError);

  let callbackCalls = 0;
  for (const permissions of [
    { mode: "auto" },
    { mode: "deny" },
    { onRequest: () => { callbackCalls += 1; } },
  ]) {
    assert.throws(
      () => new AntigravitySDK({
        ...base,
        permissions,
        sessionDriverFactory: () => { throw new Error("not called during construction"); },
      }),
      InvalidRequestError,
    );
  }
  assert.equal(callbackCalls, 0);

  const permissions = { onRequest: () => { callbackCalls += 1; }, timeoutMs: 25 };
  const sdk = new AntigravitySDK({ ...base, permissions });
  permissions.onRequest = () => { callbackCalls += 100; };
  permissions.timeoutMs = 60_000;
  await sdk.close();
  assert.equal(callbackCalls, 0, "construction and close do not execute caller callbacks");
});

test("permission policy normalization defaults to frozen auto and isolates caller mutations", () => {
  const defaultPolicy = normalizeAcpPermissionPolicy(undefined);
  assert.deepEqual(defaultPolicy, { mode: "auto", timeoutMs: 10_000 });
  assert.equal(Object.isFrozen(defaultPolicy), true);

  const denyOptions = { mode: "deny", timeoutMs: 25 };
  const denyPolicy = normalizeAcpPermissionPolicy(denyOptions);
  denyOptions.mode = "auto";
  denyOptions.timeoutMs = 50;
  assert.deepEqual(denyPolicy, { mode: "deny", timeoutMs: 25 });
  assert.equal(Object.isFrozen(denyPolicy), true);

  const firstHandler = () => ({ action: "deny" });
  const secondHandler = () => ({ action: "select", optionId: "later" });
  const callbackOptions = { onRequest: firstHandler, timeoutMs: 100 };
  const callbackPolicy = normalizeAcpPermissionPolicy(callbackOptions);
  callbackOptions.onRequest = secondHandler;
  callbackOptions.timeoutMs = 500;
  assert.equal(callbackPolicy.mode, "callback");
  assert.equal(callbackPolicy.onRequest, firstHandler);
  assert.equal(callbackPolicy.timeoutMs, 100);
  assert.equal(Object.isFrozen(callbackPolicy), true);
});

test("A1 compatibility policy does not bypass an injected worker's hard-bound admission gate", async () => {
  await withTempDirectory(async (root) => {
    let dispatches = 0;
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      sessionDriverFactory: () => ({
        async dispatch() {
          dispatches += 1;
          return { stage: "completed", output: [{ role: "assistant", content: "unexpected" }] };
        },
        async close() {},
      }),
    });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({ model: "model", cwd: "/workspace" });
    await assert.rejects(
      session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "must not run" }] }),
      UnsupportedFeatureError,
    );
    assert.equal(dispatches, 0);
    await sdk.close();
  });
});

test("the locked constructor/account/login/session-close example runs with offline injected workers", async () => {
  await withTempDirectory(async (root) => {
    const storageDir = join(root, "profiles");
    const existing = await createProfileRegistry({ storageDir, environment: {} });
    const profile = await existing.accounts.create();
    let authenticationProcessCount = 0;
    let sessionCloseCount = 0;
    const sdk = new AntigravitySDK({
      storageDir,
      executable: "/fake/agy-acp",
      processFactory: (...args) => {
        authenticationProcessCount += 1;
        return createFakeAuthProcessFactory({
          onAuthenticate: (message, child) => child.reply(message.id, {}),
        })(...args);
      },
      sessionDriverFactory: (context) => createSessionDriver(context, () => { sessionCloseCount += 1; }),
    });

    const account = sdk.accounts.get(profile.id);
    await account.auth.login({ methodId: "oauth-personal" });
    assert.equal((await account.auth.status()).state, "authenticated");
    const session = await account.sessions.create({ model: "model", cwd: "/workspace" });
    await session.close();
    await sdk.close();

    assert.equal(authenticationProcessCount, 1);
    assert.equal(sessionCloseCount, 1);
    assert.equal((await account.auth.status().catch((error) => error)) instanceof SDKClosedError, true);
  });
});

test("two accounts with two sessions each remain isolated and SDK shutdown owns their lifecycle", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const operations = [];
    const closeCounts = new Map();
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/explicit/safe/path", GOOGLE_API_KEY: "ignored" },
      sessionDriverFactory(context) {
        contexts.push(context);
        closeCounts.set(context.sessionId, 0);
        return {
          ...createSessionDriver(context, () => {
            closeCounts.set(context.sessionId, closeCounts.get(context.sessionId) + 1);
          }),
          async dispatch(operation) {
            operations.push(operation);
            return {
              stage: "completed",
              output: [{ role: "assistant", content: `${operation.accountId}/${operation.sessionId}` }],
              result: { stopReason: "end_turn" },
            };
          },
        };
      },
    });
    const first = await sdk.accounts.create();
    const second = await sdk.accounts.create();
    assert.notEqual(first.id, second.id);
    assert.equal(sdk.accounts.get(first.id), first, "account handles are stable within one SDK");
    assert.deepEqual((await sdk.accounts.list()).map(({ id }) => id).sort(), [first.id, second.id].sort());

    const sessions = await Promise.all([
      first.sessions.create({ model: "model-a", cwd: "/workspace/a" }),
      first.sessions.create({ model: "model-a", cwd: "/workspace/a" }),
      second.sessions.create({ model: "model-b", cwd: "/workspace/b" }),
      second.sessions.create({ model: "model-b", cwd: "/workspace/b" }),
    ]);
    assert.equal(new Set(sessions.map(({ sessionId }) => sessionId)).size, 4);
    assert.deepEqual(contexts.map(({ accountId }) => accountId).sort(), [first.id, first.id, second.id, second.id].sort());
    assert.equal(contexts.every(({ profile, accountId }) => profile.accountId === accountId), true);
    assert.equal(new Set(contexts.map(({ profile }) => profile.storageRoot)).size, 2);

    const responses = await Promise.all(sessions.map((session, index) =>
      session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: `private-input-${index}` }],
      }),
    ));
    for (let index = 0; index < sessions.length; index += 1) {
      assert.equal(responses[index].content[0].text, `${sessions[index].accountId}/${sessions[index].sessionId}`);
      assert.equal(operations[index].accountId, sessions[index].accountId);
      assert.equal(operations[index].sessionId, sessions[index].sessionId);
      assert.equal(operations[index].messages[0].content, `private-input-${index}`);
    }

    await sessions[0].close();
    assert.equal(closeCounts.get(sessions[0].sessionId), 1);
    await sdk.close();
    await sdk.close();
    assert.deepEqual([...closeCounts.values()].sort(), [1, 1, 1, 1]);
    assert.equal(sessions[1].state, "closed");
  });
});

test("auth logout closes only the selected account's composed session workers", async () => {
  await withTempDirectory(async (root) => {
    const closed = [];
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      sessionDriverFactory: (context) => createSessionDriver(context, (value) => closed.push(value.accountId)),
    });
    const first = await sdk.accounts.create();
    const second = await sdk.accounts.create();
    const firstSessions = await Promise.all([
      first.sessions.create({ model: "model", cwd: "/a" }),
      first.sessions.create({ model: "model", cwd: "/a" }),
    ]);
    const secondSession = await second.sessions.create({ model: "model", cwd: "/b" });

    await first.auth.logout();
    assert.deepEqual(closed, [first.id, first.id]);
    assert.equal(firstSessions.every(({ state }) => state === "closed"), true);
    assert.equal(secondSession.state, "idle");
    assert.deepEqual(await first.auth.status(), {
      state: "unknown",
      accountId: first.id,
      reason: "no-recognized-profile-auth-files-found",
    });

    await sdk.close();
    assert.deepEqual(closed.sort(), [first.id, first.id, second.id].sort());
  });
});

test("shutdown waits for registry startup and does not publish an account after closing", async () => {
  await withTempDirectory(async (root) => {
    const started = deferred();
    const release = deferred();
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      async profileRegistryFactory(options) {
        started.resolve();
        await release.promise;
        return createProfileRegistry(options);
      },
    });
    const creating = sdk.accounts.create();
    await started.promise;
    const closing = sdk.close();
    release.resolve();
    await closing;
    await assert.rejects(creating, SDKClosedError);
  });
});

test("shutdown during session startup closes the late worker and never publishes the session", async () => {
  await withTempDirectory(async (root) => {
    const started = deferred();
    const release = deferred();
    let closeCount = 0;
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      async sessionDriverFactory(context) {
        started.resolve();
        await release.promise;
        return createSessionDriver(context, () => { closeCount += 1; });
      },
    });
    const account = await sdk.accounts.create();
    const creating = account.sessions.create({ model: "model", cwd: "/workspace" });
    await started.promise;
    const closing = sdk.close();
    release.resolve();
    await assert.rejects(creating, SessionNotFoundError);
    await closing;
    assert.equal(closeCount, 1);
  });
});

test("SDK shutdown aborts and waits for an explicit in-flight ACP login", async () => {
  await withTempDirectory(async (root) => {
    const authenticated = deferred();
    const children = [];
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      processFactory: () => {
        const child = new FakeAuthChild({
          onAuthenticateStarted: () => authenticated.resolve(),
          onAuthenticate: () => {},
        });
        children.push(child);
        return child;
      },
    });
    const account = await sdk.accounts.create();
    const login = account.auth.login();
    await authenticated.promise;
    const closing = sdk.close();
    await closing;
    await assert.rejects(login);
    assert.equal(children[0].ended, true);
    assert.equal((await account.auth.status().catch((error) => error)) instanceof SDKClosedError, true);
  });
});

test("SDK shutdown reports and retries auth-lock cleanup after abort instead of caching false success", async () => {
  await withTempDirectory(async (root) => {
    const authenticating = deferred();
    const accountId = "acct_00000000-0000-4000-8000-000000000001";
    let releaseCalls = 0;
    let lockReleased = false;
    const profile = Object.freeze({
      id: accountId,
      context: Object.freeze({
        accountId,
        storageRoot: root,
        childEnvironment: Object.freeze({ PATH: "/safe/bin" }),
        async acquireAuthLock() {
          return Object.freeze({
            async release() {
              releaseCalls += 1;
              if (releaseCalls === 1) throw new Error("simulated transient lock-release failure");
              lockReleased = true;
            },
          });
        },
      }),
    });
    const registry = Object.freeze({
      storageRoot: root,
      accounts: Object.freeze({
        async create() { return profile; },
        async get(id) {
          if (id !== accountId) throw new Error("unexpected account lookup");
          return profile;
        },
        async list() { return [profile]; },
      }),
    });
    const sdk = new AntigravitySDK({
      storageDir: join(root, "unused"),
      executable: "/fake/agy-acp",
      async profileRegistryFactory() { return registry; },
      processFactory: () => new FakeAuthChild({
        onAuthenticateStarted: () => authenticating.resolve(),
        onAuthenticate: () => {},
      }),
    });
    const account = sdk.accounts.get(accountId);
    const login = account.auth.login();
    await authenticating.promise;

    await assert.rejects(sdk.close(), (error) =>
      error instanceof ProcessFailureError && /auth cleanup failed/iu.test(error.message),
    );
    await assert.rejects(login, RequestAbortedError);
    assert.equal(releaseCalls, 1);
    assert.equal(lockReleased, false);

    await sdk.close();
    await sdk.close();
    assert.equal(releaseCalls, 2);
    assert.equal(lockReleased, true);
  });
});

test("shutdown cleanup failures are typed and a later close retries safely", async () => {
  await withTempDirectory(async (root) => {
    let closeCount = 0;
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      sessionDriverFactory: (context) => ({
        ...createSessionDriver(context),
        async close() {
          closeCount += 1;
          if (closeCount === 1) throw new Error("private teardown detail");
        },
      }),
    });
    const account = await sdk.accounts.create();
    await account.sessions.create({ model: "model", cwd: "/workspace" });
    await assert.rejects(sdk.close(), ProcessFailureError);
    assert.equal(closeCount, 1);
    assert.throws(() => sdk.accounts.get(account.id), SDKClosedError);
    await sdk.close();
    await sdk.close();
    assert.equal(closeCount, 2);
  });
});

test("the built-in ACP driver fails closed for an unreviewed executable", async () => {
  await withTempDirectory(async (root) => {
    let processCalls = 0;
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      processFactory() {
        processCalls += 1;
        throw new Error("authentication process was not expected");
      },
    });
    const account = await sdk.accounts.create();
    await assert.rejects(
      account.sessions.create({ model: "model", cwd: "/workspace" }),
      (error) => error instanceof UnsupportedFeatureError && /reviewed Antigravity/u.test(error.message),
    );
    assert.equal(processCalls, 0);
    await sdk.close();
  });
});

test("SDK shutdown retains and retries a discovery lease whose request cleanup fails", async () => {
  await withTempDirectory(async (root) => {
    let closeAttempts = 0;
    const sdk = createAntigravitySDKWithModelDiscoveryFactoryForTests({
      storageDir: join(root, "profiles"),
      executable: "/unused/agy_acp_server.par",
    }, async () => ({
      async list() { return Object.freeze([{ id: "advertised-model" }]); },
      async close() {
        closeAttempts += 1;
        if (closeAttempts < 3) throw new Error("transient discovery cleanup failure");
      },
    }));
    const account = await sdk.accounts.create();
    await assert.rejects(account.models.list({ cwd: "/workspace" }), /transient discovery cleanup failure/);
    assert.equal(closeAttempts, 1);

    await assert.rejects(sdk.close(), ProcessFailureError);
    assert.equal(closeAttempts, 2, "shutdown retries the retained discovery lease");

    await sdk.close();
    assert.equal(closeAttempts, 3, "a later shutdown retries an incomplete cleanup obligation");
  });
});

test("the package root imports without resolving the optional Rosetta peer", () => {
  const loader = fileURLToPath(new URL("./deny-rosetta-loader.mjs", import.meta.url));
  const index = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const result = spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-loader",
    loader,
    "--input-type=module",
    "-e",
    `
      const listenerSnapshot = () => JSON.stringify(process.eventNames()
        .map((event) => [String(event), process.listenerCount(event)])
        .sort((left, right) => left[0].localeCompare(right[0])));
      const before = listenerSnapshot();
      await import(${JSON.stringify(index)});
      if (listenerSnapshot() !== before) throw new Error("The package root added process listeners.");
    `,
  ], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr);
});
