import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  SessionBusyError,
  SessionInterruptedError,
  SessionNotFoundError,
  UnsupportedFeatureError,
  createProfileAuth,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";

const text = (role, content) => ({ role, content });
const answer = (content) => text("assistant", content);

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s4-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function makeRegistry(root) {
  return createProfileRegistry({
    storageDir: join(root, "profiles"),
    environment: { PATH: "/safe/bin" },
  });
}

function makeEngine(registry, profile, {
  workerManager,
  onDispatch = async () => ({ stage: "completed", output: [answer("ok")] }),
  onCreate,
} = {}) {
  const drivers = [];
  const runtimeManager = workerManager ?? createProfileRuntimeManager();
  const engine = createProfileSessionEngine(registry.accounts, profile.id, {
    workerManager: runtimeManager,
    driverFactory(context) {
      onCreate?.(context);
      const driver = {
        context,
        closeCount: 0,
        async dispatch(operation) {
          return onDispatch(operation, driver);
        },
        async close() {
          driver.closeCount += 1;
        },
      };
      drivers.push(driver);
      return driver;
    },
  });
  return { engine, drivers };
}

function toolHistory() {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_old", name: "lookup", input: { key: "old" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "historical result" }],
    },
  ];
}

test("initial history, including historical tool blocks, is copied and committed as inert transcript", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const observed = [];
    const { engine, drivers } = makeEngine(registry, profile, {
      onDispatch: async (operation) => {
        observed.push(operation);
        return {
          stage: "completed",
          output: [answer(`reply-${observed.length}`)],
          result: { receipt: observed.length },
        };
      },
    });
    const system = [{ type: "text", text: "Original instructions" }];
    const tools = [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }];
    const createOptions = { model: "model-A", cwd: "/workspace", system, tools };
    const session = await engine.create(createOptions);
    system[0].text = "mutated caller value";
    tools[0].input_schema.properties.key = { type: "number" };

    assert.equal(session.accountId, profile.id);
    assert.match(session.sessionId, /^sess_[0-9a-f-]+$/u);
    assert.throws(() => { session.accountId = "acct_other"; }, TypeError);
    assert.throws(() => { session.sessionId = "sess_other"; }, TypeError);
    assert.equal(session.configuration.system[0].text, "Original instructions");
    assert.equal(session.configuration.tools[0].input_schema.properties.key.type, "string");
    assert.equal(Object.isFrozen(session.configuration), true);
    assert.equal(Object.isFrozen(session.configuration.system[0]), true);
    assert.equal(Object.isFrozen(session.configuration.tools[0].input_schema.properties.key), true);
    assert.throws(() => { session.configuration.tools[0].name = "changed"; }, TypeError);

    const initial = [text("user", "continuing from saved context"), ...toolHistory()];
    const first = await session.execute({ transcript: initial });
    assert.equal(first.stage, "completed");
    assert.match(first.operationId, /^op_[0-9a-f-]+$/u);
    assert.deepEqual(observed[0].messages, initial);
    assert.equal(observed[0].accountId, profile.id);
    assert.equal(observed[0].sessionId, session.sessionId);
    assert.equal(observed[0].configuration, session.configuration);
    assert.equal(session.state, "idle", "historical tool_use does not create active tool authority");
    assert.deepEqual(first.committedMessages, [...initial, answer("reply-1")]);
    assert.deepEqual(session.snapshot().transcript, [...initial, answer("reply-1")]);
    assert.equal(session.snapshot().revision, 1);

    const followup = [...initial, answer("reply-1"), text("user", "next question")];
    const second = await session.execute({ transcript: followup });
    assert.deepEqual(observed[1].messages, [text("user", "next question")]);
    assert.deepEqual(second.committedMessages, [text("user", "next question"), answer("reply-2")]);
    assert.deepEqual(session.snapshot().transcript, [...initial, answer("reply-1"), text("user", "next question"), answer("reply-2")]);
    assert.equal(session.snapshot().revision, 2, "the acknowledged output is appended only once");

    const snapshot = session.snapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.transcript), true);
    assert.equal(Object.isFrozen(snapshot.transcript[0]), true);
    assert.throws(() => snapshot.transcript.push(answer("external mutation")), TypeError);
    assert.equal(drivers.length, 1, "follow-ups use the same live worker");

    await session.close();
    await session.close();
    assert.equal(drivers[0].closeCount, 1, "close is idempotent");
    assert.equal(session.state, "closed");
    await assert.rejects(session.execute({ transcript: followup }), SessionNotFoundError);
    await engine.close();
  });
});

test("divergent prefixes and pinned model/system/tools changes fail before dispatch", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    let dispatches = 0;
    const tools = [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }];
    const { engine } = makeEngine(registry, profile, {
      onDispatch: async () => {
        dispatches += 1;
        return { stage: "completed", output: [answer("ok")] };
      },
    });
    const session = await engine.create({ model: "model-A", cwd: "/workspace", system: "pinned", tools });
    const initial = [text("user", "first")];
    await session.execute({ transcript: initial });
    const committed = [...initial, answer("ok")];

    const invalidRequests = [
      { transcript: [text("user", "diverged"), answer("ok"), text("user", "followup")] },
      { transcript: [...committed, text("user", "followup")], configuration: { model: "model-B" } },
      { transcript: [...committed, text("user", "followup")], configuration: { system: "changed" } },
      { transcript: [...committed, text("user", "followup")], configuration: { tools: [] } },
      { transcript: [...committed, { role: "system", content: "not a Messages turn" }] },
      { transcript: [...committed, { role: "user", content: [{ bad: Number.NaN }] }] },
      { transcript: [...committed, { role: "user", get content() { throw new Error("must not read getter"); } }] },
    ];
    for (const request of invalidRequests) {
      await assert.rejects(session.execute(request), InvalidRequestError);
    }
    assert.equal(dispatches, 1, "all admission failures occur before worker dispatch");
    await session.close();
    await engine.close();
  });
});

test("one operation per session; separate sessions and accounts may dispatch in parallel", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const firstProfile = await registry.accounts.create();
    const secondProfile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();

    let enterFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    let finishFirst;
    const firstResult = new Promise((resolve) => { finishFirst = resolve; });
    const firstFixture = makeEngine(registry, firstProfile, {
      workerManager: manager,
      onDispatch: async () => {
        enterFirst();
        return firstResult;
      },
    });
    const firstSession = await firstFixture.engine.create({ model: "m", cwd: "/a" });
    const active = firstSession.execute({ transcript: [text("user", "busy")] });
    await firstEntered;
    await assert.rejects(firstSession.execute({ transcript: [text("user", "concurrent")] }), SessionBusyError);
    finishFirst({ stage: "completed", output: [answer("done")] });
    await active;

    const started = [];
    const pending = [];
    let releaseParallel;
    const parallelGate = new Promise((resolve) => { releaseParallel = resolve; });
    let bothEntered;
    const bothEnteredPromise = new Promise((resolve) => { bothEntered = resolve; });
    const parallelFactory = (profile) => makeEngine(registry, profile, {
      workerManager: manager,
      onDispatch: async (operation) => {
        started.push(operation.accountId);
        pending.push(operation);
        if (started.length === 2) bothEntered();
        await parallelGate;
        return { stage: "completed", output: [answer(`from-${operation.accountId}`)] };
      },
    });
    const firstParallelFixture = parallelFactory(firstProfile);
    const secondFixture = parallelFactory(secondProfile);
    const firstParallel = await firstParallelFixture.engine.create({ model: "m", cwd: "/a" });
    const secondParallel = await secondFixture.engine.create({ model: "m", cwd: "/b" });
    const firstCall = firstParallel.execute({ transcript: [text("user", "parallel-A")] });
    const secondCall = secondParallel.execute({ transcript: [text("user", "parallel-B")] });
    await bothEnteredPromise;
    assert.deepEqual(new Set(started), new Set([firstProfile.id, secondProfile.id]));
    releaseParallel();
    await Promise.all([firstCall, secondCall]);
    assert.notEqual(firstParallel.sessionId, secondParallel.sessionId);
    assert.equal(pending.length, 2);

    await firstParallelFixture.engine.close();
    await firstFixture.engine.close();
    await secondFixture.engine.close();
  });
});

test("abort or partial/crashed observation never commits and the operation cannot be replayed", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    let calls = 0;
    const { engine, drivers } = makeEngine(registry, profile, {
      onDispatch: async (operation) => {
        calls += 1;
        entered();
        // The fake worker has observed a partial assistant turn, but has not
        // returned the explicit completion acknowledgement required to commit.
        assert.equal(operation.messages[0].content, "user input");
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            operation.signal.addEventListener("abort", () => reject(new Error("worker cancelled")), { once: true });
          });
        }
        throw new Error("simulated ACP crash after partial observation");
      },
    });
    const session = await engine.create({ model: "m", cwd: "/workspace" });
    const controller = new AbortController();
    const request = { transcript: [text("user", "user input")] };
    const active = session.execute(request, { signal: controller.signal });
    await enteredPromise;
    controller.abort();
    await assert.rejects(active, RequestAbortedError);
    assert.equal(session.state, "interrupted");
    assert.deepEqual(session.snapshot().transcript, []);
    await assert.rejects(session.execute(request), SessionInterruptedError);
    assert.equal(calls, 1, "aborted input is not automatically replayed");

    await session.close();
    assert.equal(drivers[0].closeCount, 1);
    await engine.close();
  });
});

test("a worker crash after partial observation leaves an interrupted, uncommitted ledger", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    let calls = 0;
    let partialObserved = false;
    const { engine } = makeEngine(registry, profile, {
      onDispatch: async () => {
        calls += 1;
        partialObserved = true;
        throw new ProcessFailureError("fake ACP process exited");
      },
    });
    const session = await engine.create({ model: "m", cwd: "/workspace" });
    const request = { transcript: [text("user", "possibly observed") ] };
    await assert.rejects(session.execute(request), ProcessFailureError);
    assert.equal(partialObserved, true);
    assert.equal(session.state, "interrupted");
    assert.deepEqual(session.snapshot().transcript, []);
    await assert.rejects(session.execute(request), SessionInterruptedError);
    assert.equal(calls, 1);
    await engine.close();
  });
});

test("awaiting_tools is entered only by an explicit current-operation stage and has no S4 continuation", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    let calls = 0;
    const { engine } = makeEngine(registry, profile, {
      onDispatch: async () => {
        calls += 1;
        return {
          stage: "awaiting_tools",
          output: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_new", name: "lookup", input: {} }] }],
        };
      },
    });
    const session = await engine.create({ model: "m", cwd: "/workspace" });
    const result = await session.execute({ transcript: [text("user", "call tool")] });
    assert.equal(result.stage, "awaiting_tools");
    assert.equal(session.state, "awaiting_tools");
    await assert.rejects(session.execute({
      transcript: [
        text("user", "call tool"),
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_new", name: "lookup", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: "value" }] },
      ],
    }), UnsupportedFeatureError);
    assert.equal(calls, 1, "tool-result routing is not enabled in S4");
    await engine.close();
  });
});

test("explicit close cancels and awaits the active worker operation", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const { engine, drivers } = makeEngine(registry, profile, {
      onDispatch: async (operation) => {
        entered();
        return new Promise((_resolve, reject) => {
          operation.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        });
      },
    });
    const session = await engine.create({ model: "m", cwd: "/workspace" });
    const active = session.execute({ transcript: [text("user", "will be cancelled")] });
    await enteredPromise;
    const closing = session.close();
    await assert.rejects(active, RequestAbortedError);
    await closing;
    assert.equal(session.state, "closed");
    assert.deepEqual(session.snapshot().transcript, []);
    assert.equal(drivers[0].closeCount, 1);
    await session.close();
    assert.equal(drivers[0].closeCount, 1);
    await engine.close();
  });
});

test("engine shutdown retains a terminal session until failed worker cleanup is retried", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    let closeCalls = 0;
    const engine = createProfileSessionEngine(registry.accounts, profile.id, {
      workerManager: manager,
      driverFactory: () => ({
        async dispatch() { return { stage: "completed", output: [answer("unused")] }; },
        async close() {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("first close fails");
        },
      }),
    });
    const session = await engine.create({ model: "m", cwd: "/workspace" });

    await assert.rejects(engine.close(), ProcessFailureError);
    assert.equal(session.state, "closed", "public close is terminal even while cleanup remains owned");
    assert.equal(closeCalls, 1);
    await engine.close();
    assert.equal(closeCalls, 2, "the retained session lease is retried by the next shutdown");
    await engine.close();
    assert.equal(closeCalls, 2, "successful shutdown remains idempotent");
  });
});

test("shutdown racing a pending driver factory reports startup cleanup failure and can retry", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    let enteredFactory;
    const factoryEntered = new Promise((resolve) => { enteredFactory = resolve; });
    let resolveDriver;
    const driverPending = new Promise((resolve) => { resolveDriver = resolve; });
    let closeCalls = 0;
    const engine = createProfileSessionEngine(registry.accounts, profile.id, {
      workerManager: manager,
      async driverFactory() {
        enteredFactory();
        return driverPending;
      },
    });
    const creating = engine.create({ model: "m", cwd: "/workspace" });
    await factoryEntered;
    const shutdown = engine.close();
    const shutdownRejected = assert.rejects(shutdown, ProcessFailureError);
    const creationRejected = assert.rejects(creating, ProcessFailureError);

    resolveDriver({
      async dispatch() { return { stage: "completed", output: [answer("unused")] }; },
      async close() {
        closeCalls += 1;
        if (closeCalls === 1) throw new Error("startup cleanup failed");
      },
    });

    await creationRejected;
    await shutdownRejected;
    assert.equal(closeCalls, 1, "shutdown exposes the failed in-flight cleanup instead of swallowing it");
    await engine.close();
    assert.equal(closeCalls, 2, "the still-owned worker is retried on the next shutdown");
    await engine.close();
    assert.equal(closeCalls, 2);
  });
});

test("invalid driver capabilities close the created worker and preserve the protocol error", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    let closeCalls = 0;
    const engine = createProfileSessionEngine(registry.accounts, profile.id, {
      workerManager: manager,
      driverFactory: () => ({
        capabilities: { maxTokens: "unsupported" },
        async dispatch() { return { stage: "completed", output: [answer("unused")] }; },
        async close() { closeCalls += 1; },
      }),
    });

    await assert.rejects(engine.create({ model: "m", cwd: "/workspace" }), ProtocolFailureError);
    assert.equal(closeCalls, 1, "the worker is closed after capability validation fails");
    await engine.close();
    const transition = await manager.closeProfile(profile.context);
    await transition.release();
    assert.equal(closeCalls, 1, "successful startup cleanup removed the manager lease");
  });
});

test("invalid capabilities remain cleanup-owned and retryable across engine shutdown races", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    let enteredFactory;
    const factoryEntered = new Promise((resolve) => { enteredFactory = resolve; });
    let resolveDriver;
    const driverPending = new Promise((resolve) => { resolveDriver = resolve; });
    let closeCalls = 0;
    const engine = createProfileSessionEngine(registry.accounts, profile.id, {
      workerManager: manager,
      async driverFactory() {
        enteredFactory();
        return driverPending;
      },
    });
    const creating = engine.create({ model: "m", cwd: "/workspace" });
    await factoryEntered;
    const shutdown = engine.close();
    const creationRejected = assert.rejects(creating, ProcessFailureError);
    const shutdownRejected = assert.rejects(shutdown, ProcessFailureError);

    resolveDriver({
      capabilities: { maxTokens: "unsupported" },
      async dispatch() { return { stage: "completed", output: [answer("unused")] }; },
      async close() {
        closeCalls += 1;
        if (closeCalls < 3) throw new Error("cleanup remains retryable");
      },
    });

    await creationRejected;
    await shutdownRejected;
    assert.equal(closeCalls, 1, "the racing startup cleanup failed and was surfaced");
    await assert.rejects(engine.close(), ProcessFailureError);
    assert.equal(closeCalls, 2, "the retained worker is retried by engine shutdown");
    await engine.close();
    assert.equal(closeCalls, 3, "a later engine shutdown completes cleanup");
  });
});

test("invalid-capability cleanup failures stay tracked and retryable through profile-manager shutdown", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    let closeCalls = 0;
    const engine = createProfileSessionEngine(registry.accounts, profile.id, {
      workerManager: manager,
      driverFactory: () => ({
        capabilities: { maxTokens: "unsupported" },
        async dispatch() { return { stage: "completed", output: [answer("unused")] }; },
        async close() {
          closeCalls += 1;
          if (closeCalls < 3) throw new Error("profile cleanup remains retryable");
        },
      }),
    });

    await assert.rejects(engine.create({ model: "m", cwd: "/workspace" }), ProcessFailureError);
    assert.equal(closeCalls, 1, "startup cleanup failed but the manager still owns the lease");
    await assert.rejects(manager.closeProfile(profile.context), ProcessFailureError);
    assert.equal(closeCalls, 2, "the first profile shutdown reports its cleanup failure");
    const transition = await manager.closeProfile(profile.context);
    await transition.release();
    assert.equal(closeCalls, 3, "a later profile shutdown retries and closes the worker");
    await engine.close();
  });
});

test("logout through the shared profile manager closes account-bound sessions", async () => {
  await withTempDirectory(async (root) => {
    const registry = await makeRegistry(root);
    const profile = await registry.accounts.create();
    const manager = createProfileRuntimeManager();
    const { engine, drivers } = makeEngine(registry, profile, { workerManager: manager });
    const session = await engine.create({ model: "m", cwd: "/workspace" });
    const auth = createProfileAuth(registry.accounts, profile.id, {
      executable: "not-used-by-logout",
      workerManager: manager,
    });

    await auth.logout();
    assert.equal(drivers[0].closeCount, 1);
    assert.equal(session.state, "closed");
    await assert.rejects(session.execute({ transcript: [text("user", "after logout")] }), SessionNotFoundError);
    await engine.close();
    await auth.logout();
    assert.equal(drivers[0].closeCount, 1, "shared-manager and explicit closes remain idempotent");
  });
});
