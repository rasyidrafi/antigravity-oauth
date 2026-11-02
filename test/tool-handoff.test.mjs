import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  SessionBusyError,
  SessionInterruptedError,
  UnsupportedFeatureError,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const text = (value) => ({ type: "text", text: value });
const tools = [{
  name: "lookup",
  input_schema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
}];
const request = (messages, stream = false, max_tokens = 64) => ({ max_tokens, messages, ...(stream ? { stream: true } : {}) });

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s8-"));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function waitFor(predicate, message = "condition did not become true") {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function workerChannel(child) {
  const queue = [];
  const waiters = [];
  child.on("message", (message) => {
    const index = waiters.findIndex((waiter) => message.type === waiter.type || message.type === "error");
    if (index < 0) queue.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      if (message.type === "error") waiter.reject(new Error(`crash worker failed: ${message.message}`));
      else waiter.resolve(message);
    }
  });
  child.on("exit", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`crash worker exited early (${code ?? signal})`));
    }
  });
  return (type) => {
    const index = queue.findIndex((message) => message.type === type || message.type === "error");
    if (index >= 0) {
      const [message] = queue.splice(index, 1);
      return message.type === "error"
        ? Promise.reject(new Error(`crash worker failed: ${message.message}`))
        : Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const pending = waiters.indexOf(waiter);
        if (pending >= 0) waiters.splice(pending, 1);
        reject(new Error(`timed out waiting for crash worker message '${type}'`));
      }, 5_000);
      waiters.push(waiter);
    });
  };
}

function rpcBody(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

async function postMcp(server, body, { headers = {}, signal } = {}) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function initializeMcp(server) {
  const first = await postMcp(server, rpcBody("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "s8-test", version: "1" },
  }));
  assert.equal(first.status, 200);
  const session = first.headers.get("mcp-session-id");
  assert.ok(session);
  const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };
  const initialized = await postMcp(server, { jsonrpc: "2.0", method: "notifications/initialized" }, { headers });
  assert.equal(initialized.status, 202);
  return headers;
}

function toolAcknowledgement(calls, textValue = "working") {
  return {
    stage: "awaiting_tools",
    output: [assistant([
      ...(textValue === undefined ? [] : [text(textValue)]),
      ...calls.map((input, index) => ({ type: "tool_use", id: `worker-call-${index}`, name: "lookup", input })),
    ])],
    result: { stopReason: "tool_use", usage: { inputTokens: 7, outputTokens: 3 } },
  };
}

function finalAcknowledgement(answer) {
  return {
    stage: "completed",
    output: [assistant(answer)],
    result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 2 } },
  };
}

async function harness(root, callbacks = {}, { accountCount = 1, mcpLimits } = {}) {
  const registry = await createProfileRegistry({
    storageDir: join(root, "profiles"),
    environment: { PATH: "/safe/bin" },
  });
  const accounts = [];
  for (let i = 0; i < accountCount; i += 1) accounts.push(await registry.accounts.create());
  const managers = accounts.map(() => createProfileRuntimeManager());
  const engines = [];
  const sessions = [];
  const contexts = [];
  const drivers = [];
  const admissions = [];
  for (let i = 0; i < accounts.length; i += 1) {
    const engine = createProfileSessionEngine(registry.accounts, accounts[i].id, {
      workerManager: managers[i],
      driverFactory(context) {
        contexts[i] = context;
        const driver = {
          capabilities: { maxTokens: "enforced", streaming: "incremental" },
          async admitResponse(request) {
            admissions.push({ index: i, request });
            const grant = {
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
            const customGrant = await callbacks.admitResponse?.(i, request, sessions[i], driver);
            return customGrant ?? grant;
          },
          async dispatch(operation) {
            return callbacks.dispatch?.(i, operation, sessions[i], driver) ?? finalAcknowledgement("ordinary");
          },
          stream(operation) {
            return callbacks.stream?.(i, operation, sessions[i], driver) ?? (async function* () {
              yield { type: "text", text: "ordinary" };
              yield { type: "complete", acknowledgement: finalAcknowledgement("ordinary") };
            })();
          },
          async continueTools(continuation) {
            return callbacks.continueTools?.(i, continuation, sessions[i], driver) ?? finalAcknowledgement("continued");
          },
          streamTools(continuation) {
            return callbacks.streamTools?.(i, continuation, sessions[i], driver) ?? (async function* () {
              yield { type: "text", text: "continued" };
              yield { type: "complete", acknowledgement: finalAcknowledgement("continued") };
            })();
          },
          async bindCallerTools(server) {
            await callbacks.bindCallerTools?.(i, server, sessions[i], driver);
          },
          async close() {},
        };
        drivers[i] = driver;
        return driver;
      },
    });
    engines.push(engine);
    sessions.push(await engine.create({ model: `s8-model-${i}`, cwd: root, tools }));
  }
  const servers = [];
  const headers = [];
  for (const session of sessions) {
    const server = await session.tools.createMcpServer(mcpLimits === undefined ? {} : { limits: mcpLimits });
    servers.push(server);
    headers.push(await initializeMcp(server));
  }
  let nextRpcId = 10;
  const mcpCalls = [];
  const callTool = (index, key, signal, requestId) => {
    const id = requestId ?? nextRpcId++;
    const promise = postMcp(servers[index], rpcBody("tools/call", {
      name: "lookup",
      arguments: { key },
    }, id), { headers: headers[index], signal });
    void promise.catch(() => undefined);
    const call = { id, key, promise };
    mcpCalls.push(call);
    return call;
  };
  return {
    registry, accounts, managers, engines, sessions, contexts, drivers, admissions, servers, headers, mcpCalls, callTool,
    async close() {
      await Promise.allSettled(sessions.map((session) => session.close()));
      await Promise.allSettled(engines.map((engine) => engine.close()));
    },
  };
}

function resultBlock(callId, value, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: callId,
    content: [text(value)],
    ...(isError ? { is_error: true } : {}),
  };
}

test("nonstream continuation admission uses each response bound and leaves a rejected batch wholly retryable", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let mcpCall;
    let continuationCalls = 0;
    let continuationAdmissions = 0;
    let enterAdmission;
    const admissionEntered = new Promise((resolve) => { enterAdmission = resolve; });
    let releaseAdmission;
    const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
    fixture = await harness(root, {
      async admitResponse(_index, request, session) {
        if (request.kind !== "tool_continuation") return;
        continuationAdmissions += 1;
        assert.equal(request.maxTokens, [71, 79, 83][continuationAdmissions - 1]);
        assert.equal(request.accountId, session.accountId);
        assert.equal(request.sessionId, session.sessionId);
        if (continuationAdmissions === 1) {
          assert.equal((await session.diagnostics.toolHandoffs())[0].resultState, "none");
          throw new UnsupportedFeatureError("fixture declined the first continuation limit");
        }
        if (continuationAdmissions === 2) {
          enterAdmission();
          await admissionGate;
        }
      },
      async dispatch(_index, _operation, session) {
        mcpCall = fixture.callTool(0, "admission-tool");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "admission-tool" }], undefined);
      },
      async continueTools(_index, continuation) {
        continuationCalls += 1;
        assert.equal(continuation.maxTokens, 83);
        assert.equal(continuation.admission.maxTokens, 83);
        assert.equal(continuation.admission.kind, "tool_continuation");
        const delivered = await mcpCall.promise;
        assert.equal(JSON.parse(delivered.text).result.content[0].text, "released after admission");
        return finalAcknowledgement("continued safely");
      },
    });
    try {
      const first = await fixture.sessions[0].messages.create(request([user("start tool turn")], false, 31));
      const use = first.content.find((block) => block.type === "tool_use");
      const prefix = fixture.sessions[0].snapshot().transcript;
      const transcript = [...prefix, user([resultBlock(use.id, "released after admission")])];

      await assert.rejects(
        fixture.sessions[0].messages.create(request(transcript, false, 71)),
        UnsupportedFeatureError,
      );
      assert.equal(fixture.sessions[0].state, "awaiting_tools");
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "none");
      assert.equal(continuationCalls, 0, "the continuation seam is not invoked on admission failure");
      assert.equal(await Promise.race([
        mcpCall.promise.then(() => "released"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]), "pending", "the MCP waiter remains parked until a retry is admitted");

      const controller = new AbortController();
      const abortedAdmission = fixture.sessions[0].messages.create(request(transcript, false, 79), { signal: controller.signal });
      await admissionEntered;
      await assert.rejects(
        fixture.sessions[0].messages.create(request(transcript, false, 101)),
        SessionBusyError,
      );
      controller.abort();
      await assert.rejects(abortedAdmission, RequestAbortedError);
      assert.equal(fixture.sessions[0].state, "awaiting_tools", "abort before release preserves the parked batch");
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "none");
      assert.equal(continuationCalls, 0);
      releaseAdmission();
      await new Promise((resolve) => setImmediate(resolve));

      const final = await fixture.sessions[0].messages.create(request(transcript, false, 83));
      assert.equal(final.stop_reason, "end_turn");
      assert.equal(final.content[0].text, "continued safely");
      assert.equal(fixture.sessions[0].state, "idle");
      assert.deepEqual(fixture.admissions.map(({ request: admission }) => [admission.kind, admission.maxTokens]), [
        ["prompt", 31],
        ["tool_continuation", 71],
        ["tool_continuation", 79],
        ["tool_continuation", 83],
      ]);
      assert.equal(continuationCalls, 1);
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "acknowledged");
    } finally {
      releaseAdmission();
      await fixture.close();
    }
  });
});

test("streamed continuation admission precedes result release and streamTools with a changed bound", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let mcpCall;
    let continuationAdmissions = 0;
    let continuationStreams = 0;
    fixture = await harness(root, {
      async admitResponse(_index, request, session) {
        if (request.kind !== "tool_continuation") return;
        continuationAdmissions += 1;
        assert.equal(request.maxTokens, continuationAdmissions === 1 ? 59 : 67);
        assert.equal((await session.diagnostics.toolHandoffs())[0].resultState, "none");
        if (continuationAdmissions === 1) throw new UnsupportedFeatureError("stream bound refused");
      },
      stream(_index, _operation, session) {
        return (async function* () {
          mcpCall = fixture.callTool(0, "stream-admission-tool");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          yield { type: "text", text: "working" };
          yield { type: "complete", acknowledgement: toolAcknowledgement([{ key: "stream-admission-tool" }], "working") };
        })();
      },
      async *streamTools(_index, continuation) {
        continuationStreams += 1;
        assert.equal(continuation.maxTokens, 67);
        assert.equal(continuation.admission.maxTokens, 67);
        const delivered = await mcpCall.promise;
        assert.equal(JSON.parse(delivered.text).result.content[0].text, "stream released after admission");
        yield { type: "text", text: "continued" };
        yield { type: "complete", acknowledgement: finalAcknowledgement("continued") };
      },
    });
    try {
      const initial = await fixture.sessions[0].messages.create(request([user("stream tool turn")], true, 37));
      for await (const _event of initial) { /* consume parked tool boundary */ }
      const use = fixture.sessions[0].snapshot().transcript.at(-1).content.find((block) => block.type === "tool_use");
      const transcript = [...fixture.sessions[0].snapshot().transcript, user([resultBlock(use.id, "stream released after admission")])];

      const rejected = await fixture.sessions[0].messages.create(request(transcript, true, 59));
      await assert.rejects(async () => {
        for await (const _event of rejected) { /* admission fails before the stream driver */ }
      }, UnsupportedFeatureError);
      assert.equal(fixture.sessions[0].state, "awaiting_tools");
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "none");
      assert.equal(continuationStreams, 0);
      assert.equal(await Promise.race([
        mcpCall.promise.then(() => "released"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]), "pending");

      const admitted = await fixture.sessions[0].messages.create(request(transcript, true, 67));
      const events = [];
      for await (const event of admitted) events.push(event);
      assert.equal(continuationStreams, 1);
      assert.equal(events.at(-1).type, "message_stop");
      assert.equal(fixture.sessions[0].state, "idle");
      assert.deepEqual(fixture.admissions.map(({ request: admission }) => [admission.kind, admission.maxTokens]), [
        ["prompt", 37],
        ["tool_continuation", 59],
        ["tool_continuation", 67],
      ]);
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "acknowledged");
    } finally {
      await fixture.close();
    }
  });
});

test("MCP disconnect during continuation admission remains terminal in both streaming modes", async () => {
  for (const mode of ["nonstream", "stream"]) {
    await withTempDirectory(async (root) => {
      let fixture;
      let pendingCall;
      let callController;
      let enterAdmission;
      const admissionEntered = new Promise((resolve) => { enterAdmission = resolve; });
      let releaseAdmission;
      const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
      let dispatchCalls = 0;
      let streamCalls = 0;
      let continuationCalls = 0;
      let streamContinuationCalls = 0;
      const startCall = async (session) => {
        callController = new AbortController();
        pendingCall = fixture.callTool(0, `${mode}-admission-disconnect`, callController.signal);
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
      };
      fixture = await harness(root, {
        async admitResponse(_index, admission) {
          if (admission.kind !== "tool_continuation") return;
          enterAdmission();
          await admissionGate;
        },
        async dispatch(_index, _operation, session) {
          dispatchCalls += 1;
          await startCall(session);
          return toolAcknowledgement([{ key: `${mode}-admission-disconnect` }], undefined);
        },
        stream(_index, _operation, session) {
          streamCalls += 1;
          return (async function* () {
            await startCall(session);
            yield { type: "text", text: "waiting" };
            yield {
              type: "complete",
              acknowledgement: toolAcknowledgement([{ key: `${mode}-admission-disconnect` }], "waiting"),
            };
          })();
        },
        async continueTools() {
          continuationCalls += 1;
          return finalAcknowledgement("must not resume after disconnect");
        },
        streamTools() {
          streamContinuationCalls += 1;
          return (async function* () {
            yield { type: "text", text: "must not resume after disconnect" };
            yield { type: "complete", acknowledgement: finalAcknowledgement("must not resume after disconnect") };
          })();
        },
      });
      const session = fixture.sessions[0];
      try {
        const initial = await session.messages.create(request([user(`start ${mode}`)], mode === "stream"));
        if (mode === "stream") {
          for await (const _event of initial) { /* consume the parked boundary */ }
        }
        const use = session.snapshot().transcript.at(-1).content.find((block) => block.type === "tool_use");
        const transcript = [...session.snapshot().transcript, user([resultBlock(use.id, "must not be released")])];

        let continuationPromise;
        let continuationIterator;
        let streamNext;
        if (mode === "nonstream") {
          continuationPromise = session.messages.create(request(transcript));
          void continuationPromise.catch(() => undefined);
        } else {
          const iterable = await session.messages.create(request(transcript, true));
          continuationIterator = iterable[Symbol.asyncIterator]();
          streamNext = continuationIterator.next();
          void streamNext.catch(() => undefined);
        }

        await admissionEntered;
        callController.abort();
        await pendingCall.promise.catch(() => undefined);
        await waitFor(() => session.state === "interrupted");
        releaseAdmission();

        if (mode === "nonstream") {
          await assert.rejects(continuationPromise, RequestAbortedError);
        } else {
          await assert.rejects(streamNext, RequestAbortedError);
          await continuationIterator.return().catch(() => undefined);
        }
        const receipt = (await session.diagnostics.toolHandoffs())[0];
        assert.equal(receipt.resultState, "none", "a disconnected waiter never admits result persistence");
        assert.equal(session.state, "interrupted", "late admission unwind must not revive the terminal session");
        assert.equal(dispatchCalls, mode === "nonstream" ? 1 : 0);
        assert.equal(streamCalls, mode === "stream" ? 1 : 0);
        assert.equal(continuationCalls, 0);
        assert.equal(streamContinuationCalls, 0, "no continuation prompt starts after the waiter is lost");
      } finally {
        releaseAdmission();
        await fixture.close();
      }
    });
  }
});

test("nonstream handoff validates whole parallel batch, delivers inverse order atomically, and accepts a late next batch", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let firstBatchCalls;
    let secondBatchCall;
    let signalContinuationEntered;
    const continuationEntered = new Promise((resolve) => { signalContinuationEntered = resolve; });
    let releaseContinuation;
    const hold = new Promise((resolve) => { releaseContinuation = resolve; });
    let continueCount = 0;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        const a = fixture.callTool(0, "alpha");
        const b = fixture.callTool(0, "beta");
        firstBatchCalls = [a, b];
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 2);
        return toolAcknowledgement([{ key: "alpha" }, { key: "beta" }]);
      },
      async continueTools(_index, continuation, session) {
        continueCount += 1;
        if (continueCount === 1) {
          assert.deepEqual(continuation.results.map(({ result }) => result.content[0].text), ["from-alpha", "from-beta"]);
          assert.equal(continuation.results[0].result.isError, true);
          const responses = await Promise.all(firstBatchCalls.map(({ promise }) => promise));
          const decoded = await Promise.all(responses.map(async (response) => JSON.parse(response.text)));
          assert.equal(decoded[0].result.content[0].text, "from-alpha");
          assert.equal(decoded[0].result.isError, true);
          assert.equal(decoded[1].result.content[0].text, "from-beta");
          signalContinuationEntered();
          await hold;
          secondBatchCall = fixture.callTool(0, "late-arrival");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 3);
          return toolAcknowledgement([{ key: "late-arrival" }], undefined);
        }
        const response = await secondBatchCall.promise;
        assert.equal(JSON.parse(response.text).result.content[0].text, "late-result");
        return finalAcknowledgement("all done");
      },
    });
    try {
      const initial = [user("look up both")];
      const first = await fixture.sessions[0].messages.create(request(initial));
      assert.equal(first.stop_reason, "tool_use");
      assert.deepEqual(first.content.map((block) => block.type), ["text", "tool_use", "tool_use"]);
      const uses = first.content.filter((block) => block.type === "tool_use");
      assert.deepEqual(uses.map((block) => block.input), [{ key: "alpha" }, { key: "beta" }]);
      assert.ok(uses.every((block) => block.id.startsWith("toolu_")));
      assert.equal(fixture.sessions[0].state, "awaiting_tools");

      const prefix = fixture.sessions[0].snapshot().transcript;
      const partial = [...prefix, user([resultBlock(uses[0].id, "from-alpha", true)])];
      await assert.rejects(fixture.sessions[0].messages.create(request(partial)), InvalidRequestError);
      const foreign = [...prefix, user([resultBlock("toolu_00000000000000000000000000000000", "foreign"), resultBlock(uses[1].id, "from-beta")])];
      await assert.rejects(fixture.sessions[0].messages.create(request(foreign)), InvalidRequestError);
      const duplicate = [...prefix, user([resultBlock(uses[0].id, "same"), resultBlock(uses[0].id, "conflict")])];
      await assert.rejects(fixture.sessions[0].messages.create(request(duplicate)), InvalidRequestError);
      const unsupported = [...prefix, user([
        { type: "tool_result", tool_use_id: uses[0].id, content: [{ type: "image", source: { type: "url", url: "https://invalid" } }] },
        resultBlock(uses[1].id, "from-beta"),
      ])];
      await assert.rejects(fixture.sessions[0].messages.create(request(unsupported)), UnsupportedFeatureError);
      const mixedText = [...prefix, user([text("also ask this"), resultBlock(uses[0].id, "from-alpha"), resultBlock(uses[1].id, "from-beta")])];
      await assert.rejects(fixture.sessions[0].messages.create(request(mixedText)), UnsupportedFeatureError);
      const incompleteReceipts = await fixture.sessions[0].diagnostics.toolHandoffs();
      assert.ok(incompleteReceipts.every((receipt) => receipt.resultState === "none"));
      assert.equal(fixture.sessions[0].state, "awaiting_tools");

      const fullBatch = [...prefix, user([
        resultBlock(uses[1].id, "from-beta"),
        resultBlock(uses[0].id, "from-alpha", true),
      ])];
      const handoffPromise = fixture.sessions[0].messages.create(request(fullBatch));
      void handoffPromise.catch(() => undefined);
      await continuationEntered;
      await assert.rejects(fixture.sessions[0].messages.create(request(fullBatch)), SessionBusyError);
      assert.deepEqual((await fixture.sessions[0].diagnostics.toolHandoffs()).slice(0, 2)
        .map((receipt) => receipt.resultState), ["delivery_attempted", "delivery_attempted"]);
      releaseContinuation();
      const second = await handoffPromise;
      assert.equal(second.stop_reason, "tool_use");
      const lateUse = second.content.find((block) => block.type === "tool_use");
      assert.equal(lateUse.input.key, "late-arrival");
      assert.equal(fixture.sessions[0].state, "awaiting_tools");

      const secondPrefix = fixture.sessions[0].snapshot().transcript;
      const final = await fixture.sessions[0].messages.create(request([
        ...secondPrefix,
        user([resultBlock(lateUse.id, "late-result")]),
      ]));
      assert.equal(final.stop_reason, "end_turn");
      assert.deepEqual(final.content, [text("all done")]);
      assert.equal(fixture.sessions[0].state, "idle");
      assert.equal(continueCount, 2);

      const receipts = await fixture.sessions[0].diagnostics.toolHandoffs();
      assert.equal(receipts.length, 3);
      assert.ok(receipts.every((receipt) => receipt.resultState === "acknowledged"));
      assert.ok(receipts.every((receipt) => receipt.exposureState === "exposed_or_uncertain"));
      assert.ok(receipts.every((receipt) => !Object.hasOwn(receipt, "arguments")));
      const recovery = await fixture.engines[0].recoveryDiagnostics();
      assert.deepEqual(recovery.map((receipt) => receipt.callId).sort(), receipts.map((receipt) => receipt.callId).sort());

      const profileDir = fixture.accounts[0].context.storageRoot;
      const receiptDir = join(profileDir, ".sdk-tool-receipts");
      const receiptFile = join(receiptDir, `${fixture.sessions[0].sessionId}.json`);
      const directoryStat = await stat(receiptDir);
      const fileStat = await stat(receiptFile);
      if (process.platform !== "win32") {
        assert.equal(directoryStat.mode & 0o777, 0o700);
        assert.equal(fileStat.mode & 0o777, 0o600);
      }
      assert.equal((await readFile(receiptFile, "utf8")).includes('"arguments":'), false);
    } finally {
      releaseContinuation();
      await fixture.close();
    }
  });
});

test("late MCP calls after exposure and during exposure persistence are assigned to the next operation", async () => {
  for (const lateWindow of ["after-exposure", "during-exposure-write"]) {
    await withTempDirectory(async (root) => {
      let fixture;
      let firstCall;
      let lateCall;
      let exposureWritten;
      let reachExposure;
      let releaseExposure;
      const exposureGate = new Promise((resolve) => { releaseExposure = resolve; });
      if (lateWindow === "during-exposure-write") exposureWritten = new Promise((resolve) => { reachExposure = resolve; });
      let continueCount = 0;
      fixture = await harness(root, {
        async dispatch(_index, _operation, session) {
          firstCall = fixture.callTool(0, "first-call");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          return toolAcknowledgement([{ key: "first-call" }], undefined);
        },
        async continueTools(_index, continuation, session) {
          continueCount += 1;
          if (continueCount === 1) {
            const firstRpc = JSON.parse((await firstCall.promise).text);
            assert.equal(firstRpc.result.content[0].text, "first-result");
            await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 2);
            return toolAcknowledgement([{ key: "late-call" }], undefined);
          }
          const lateRpc = JSON.parse((await lateCall.promise).text);
          assert.equal(lateRpc.result.content[0].text, "late-result");
          return finalAcknowledgement("finished");
        },
      });
      try {
        if (lateWindow === "during-exposure-write") {
          const session = fixture.sessions[0];
          const original = session.mutateReceipts.bind(session);
          let paused = false;
          session.mutateReceipts = async (update) => {
            const result = await original(update);
            const receipts = await session.diagnostics.toolHandoffs();
            if (!paused && receipts.some((receipt) => receipt.exposureState === "exposure_attempted")) {
              paused = true;
              reachExposure();
              await exposureGate;
            }
            return result;
          };
        }
        const firstResponsePromise = fixture.sessions[0].messages.create(request([user("create first call")]));
        let firstResponse;
        if (lateWindow === "during-exposure-write") {
          await exposureWritten;
          lateCall = fixture.callTool(0, "late-call");
          await waitFor(async () => (await fixture.sessions[0].diagnostics.toolHandoffs()).length === 2);
          releaseExposure();
          firstResponse = await firstResponsePromise;
        } else {
          firstResponse = await firstResponsePromise;
          lateCall = fixture.callTool(0, "late-call");
          await waitFor(async () => (await fixture.sessions[0].diagnostics.toolHandoffs()).length === 2);
        }
        const firstUse = firstResponse.content.find((block) => block.type === "tool_use");
        assert.deepEqual(firstUse.input, { key: "first-call" });
        assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs()).find((receipt) => receipt.callId === firstUse.id).exposureState, "exposure_attempted");

        const nextResponse = await fixture.sessions[0].messages.create(request([
          ...fixture.sessions[0].snapshot().transcript,
          user([resultBlock(firstUse.id, "first-result")]),
        ]));
        assert.equal(nextResponse.stop_reason, "tool_use");
        const lateUse = nextResponse.content.find((block) => block.type === "tool_use");
        assert.deepEqual(lateUse.input, { key: "late-call" });
        const final = await fixture.sessions[0].messages.create(request([
          ...fixture.sessions[0].snapshot().transcript,
          user([resultBlock(lateUse.id, "late-result")]),
        ]));
        assert.deepEqual(final.content, [text("finished")]);
        assert.equal(continueCount, 2);
      } finally {
        releaseExposure();
        await fixture.close();
      }
    });
  }
});

test("worker completion cannot succeed while a queued late MCP waiter is unassigned", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let firstCall;
    let lateCall;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        firstCall = fixture.callTool(0, "current-call");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "current-call" }], undefined);
      },
      async continueTools() {
        const result = JSON.parse((await firstCall.promise).text);
        assert.equal(result.result.content[0].text, "current-result");
        return finalAcknowledgement("must not complete with another waiter pending");
      },
    });
    try {
      const exposed = await fixture.sessions[0].messages.create(request([user("start current call")]));
      const firstUse = exposed.content.find((block) => block.type === "tool_use");
      lateCall = fixture.callTool(0, "unassigned-late-call");
      await waitFor(async () => (await fixture.sessions[0].diagnostics.toolHandoffs()).length === 2);
      await assert.rejects(fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(firstUse.id, "current-result")]),
      ])), ProtocolFailureError);
      assert.equal(fixture.sessions[0].state, "interrupted");
      assert.equal(fixture.sessions[0].snapshot().transcript.at(-1).content.find((block) => block.type === "tool_use").id, firstUse.id);
      const lateRpc = JSON.parse((await lateCall.promise).text);
      assert.ok(lateRpc.error);
    } finally {
      await fixture.close();
    }
  });
});

test("cancellation during exposure persistence interrupts before durable uncertainty repair and prevents commit", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    let cancelController;
    let exposurePersisted;
    let uncertaintyWriteStarted;
    let releaseExposure;
    let releaseUncertainty;
    const exposureGate = new Promise((resolve) => { releaseExposure = resolve; });
    const uncertaintyGate = new Promise((resolve) => { releaseUncertainty = resolve; });
    const exposureReached = new Promise((resolve) => { exposurePersisted = resolve; });
    const uncertaintyReached = new Promise((resolve) => { uncertaintyWriteStarted = resolve; });
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        cancelController = new AbortController();
        pending = fixture.callTool(0, "cancel-during-exposure", cancelController.signal);
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "cancel-during-exposure" }], undefined);
      },
    });
    try {
      const session = fixture.sessions[0];
      const original = session.mutateReceipts.bind(session);
      let writes = 0;
      session.mutateReceipts = async (update) => {
        writes += 1;
        if (writes === 3) {
          uncertaintyWriteStarted();
          await uncertaintyGate;
        }
        const result = await original(update);
        if (writes === 2) {
          exposurePersisted();
          await exposureGate;
        }
        return result;
      };
      const operation = session.messages.create(request([user("cancel during exposure persistence")]));
      const operationOutcome = operation.then(
        (receipt) => ({ receipt }),
        (error) => ({ error }),
      );
      await exposureReached;
      assert.equal((await session.diagnostics.toolHandoffs())[0].exposureState, "exposure_attempted");
      cancelController.abort();
      await uncertaintyReached;
      assert.equal(session.state, "interrupted", "abort must interrupt synchronously before receipt persistence settles");
      releaseExposure();
      const outcomeWhileUncertaintyHeld = await Promise.race([
        operationOutcome,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 25)),
      ]);
      assert.equal(outcomeWhileUncertaintyHeld?.receipt, undefined, "cancelled tool exposure must never return a successful boundary");
      assert.deepEqual(session.snapshot().transcript, []);
      assert.equal(session.snapshot().revision, 0);
      releaseUncertainty();
      const finalOutcome = await operationOutcome;
      assert.ok(finalOutcome.error instanceof RequestAbortedError);
      await pending.promise.catch(() => undefined);
      const receipt = (await session.diagnostics.toolHandoffs())[0];
      assert.equal(receipt.exposureState, "exposed_or_uncertain");
      assert.equal(receipt.resultState, "none");
      assert.deepEqual(session.snapshot().transcript, []);
      assert.equal(session.state, "interrupted");
    } finally {
      releaseExposure();
      releaseUncertainty();
      await fixture.close();
    }
  });
});

test("streamed tool handoff emits complete serial Anthropic tool blocks and continues with parity", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let mcpCall;
    fixture = await harness(root, {
      stream(_index, _operation, session) {
        return (async function* () {
          mcpCall = fixture.callTool(0, "stream-key");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          yield { type: "text", text: "Checking" };
          yield { type: "complete", acknowledgement: toolAcknowledgement([{ key: "stream-key" }], "Checking") };
        })();
      },
      async *streamTools(_index, continuation) {
        assert.equal(continuation.results[0].result.content[0].text, "stream-result");
        const rpc = JSON.parse((await mcpCall.promise).text);
        assert.equal(rpc.result.content[0].text, "stream-result");
        yield { type: "text", text: "Finished" };
        yield { type: "complete", acknowledgement: finalAcknowledgement("Finished") };
      },
    });
    try {
      const stream = await fixture.sessions[0].messages.create(request([user("use a tool")], true));
      const events = [];
      for await (const event of stream) events.push(event);
      assert.equal(events[0].type, "message_start");
      assert.deepEqual(events.filter((event) => event.type === "content_block_start").map((event) => event.index), [0, 1]);
      const toolStart = events.find((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
      assert.ok(toolStart.content_block.id.startsWith("toolu_"));
      assert.deepEqual(events.filter((event) => event.type === "content_block_delta").map((event) => event.delta.type), ["text_delta", "input_json_delta"]);
      assert.deepEqual(events.filter((event) => event.type === "content_block_start" || event.type === "content_block_stop")
        .map((event) => `${event.type}:${event.index}`), [
          "content_block_start:0", "content_block_stop:0", "content_block_start:1", "content_block_stop:1",
        ]);
      assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
      assert.equal(events.at(-1).type, "message_stop");
      assert.equal(fixture.sessions[0].state, "awaiting_tools");
      const use = fixture.sessions[0].snapshot().transcript.at(-1).content.find((block) => block.type === "tool_use");

      const continuation = await fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, "stream-result")]),
      ], true));
      const continuedEvents = [];
      for await (const event of continuation) continuedEvents.push(event);
      assert.equal(continuedEvents.filter((event) => event.type === "content_block_delta")
        .map((event) => event.delta.text).join(""), "Finished");
      assert.equal(continuedEvents.find((event) => event.type === "message_delta").delta.stop_reason, "end_turn");
      assert.equal(fixture.sessions[0].state, "idle");
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "acknowledged");
    } finally {
      await fixture.close();
    }
  });
});

test("abort while a tool stream is suspended cancels MCP waiters without requiring another iterator pull", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let mcpCall;
    fixture = await harness(root, {
      stream(_index, _operation, session) {
        return (async function* () {
          mcpCall = fixture.callTool(0, "suspended-stream");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          yield { type: "text", text: "working" };
          yield { type: "complete", acknowledgement: toolAcknowledgement([{ key: "suspended-stream" }], "working") };
        })();
      },
    });
    try {
      const controller = new AbortController();
      const stream = await fixture.sessions[0].messages.create(
        request([user("suspend after tool block")], true),
        { signal: controller.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();
      let toolStart;
      while (!toolStart) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        if (next.value.type === "content_block_start" && next.value.content_block.type === "tool_use") {
          toolStart = next.value;
        }
      }
      controller.abort();
      await waitFor(() => fixture.sessions[0].state === "interrupted");
      const mcpResponse = await mcpCall.promise;
      assert.ok(JSON.parse(mcpResponse.text).error);
      const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
      assert.equal(receipt.exposureState, "exposed_or_uncertain");
      assert.equal(receipt.resultState, "none");
      assert.deepEqual(fixture.sessions[0].snapshot().transcript, []);
      await iterator.return();
    } finally {
      await fixture.close();
    }
  });
});

test("tool-result account separation, MCP cancellation, and disconnect are fail-closed", async () => {
  for (const abortKind of ["notification", "disconnect"]) {
    await withTempDirectory(async (root) => {
      let fixture;
      let pendingCall;
      let callController;
      fixture = await harness(root, {
        async dispatch(index, _operation, session) {
          if (index !== 0) {
            const call = fixture.callTool(index, "account-b");
            void call.promise.catch(() => undefined);
            await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
            return toolAcknowledgement([{ key: "account-b" }], undefined);
          }
          callController = new AbortController();
          pendingCall = fixture.callTool(index, "account-a", callController.signal);
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          return toolAcknowledgement([{ key: "account-a" }], undefined);
        },
      }, { accountCount: 2 });
      try {
        const first = await fixture.sessions[0].messages.create(request([user("account A")]));
        const foreign = await fixture.sessions[1].messages.create(request([user("account B")]));
        const useA = first.content.find((block) => block.type === "tool_use");
        const useB = foreign.content.find((block) => block.type === "tool_use");
        assert.notEqual(useA.id, useB.id);
        await assert.rejects(fixture.sessions[1].messages.create(request([
          ...fixture.sessions[1].snapshot().transcript,
          user([resultBlock(useA.id, "cross-account")]),
        ])), InvalidRequestError);
        assert.equal((await fixture.sessions[1].diagnostics.toolHandoffs())[0].resultState, "none");
        const accountBReceipts = await fixture.engines[1].recoveryDiagnostics();
        assert.deepEqual(accountBReceipts.map((receipt) => receipt.callId), [useB.id]);

        if (abortKind === "notification") {
          const cancelled = await postMcp(fixture.servers[0], {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: pendingCall.id },
          }, { headers: fixture.headers[0] });
          assert.equal(cancelled.status, 202);
        } else {
          callController.abort();
        }
        await pendingCall.promise.catch(() => undefined);
        await waitFor(() => fixture.sessions[0].state === "interrupted");
        const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
        assert.equal(receipt.exposureState, "exposed_or_uncertain");
        assert.equal(receipt.resultState, "none");
        await assert.rejects(fixture.sessions[0].messages.create(request([
          ...fixture.sessions[0].snapshot().transcript,
          user([resultBlock(useA.id, "not accepted")]),
        ])), SessionInterruptedError);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("worker tool arguments must exactly match the schema-validated parked MCP call", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "actual-arguments");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "different-arguments" }], undefined);
      },
    });
    try {
      await assert.rejects(fixture.sessions[0].messages.create(request([user("mismatched call")])), ProtocolFailureError);
      assert.equal(fixture.sessions[0].state, "interrupted");
      assert.deepEqual(fixture.sessions[0].snapshot().transcript, []);
      const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
      assert.equal(receipt.exposureState, "not_exposed");
      assert.equal(receipt.resultState, "none");
      const rpc = JSON.parse((await pending.promise).text);
      assert.equal(rpc.result, undefined);
      assert.ok(rpc.error);
    } finally {
      await fixture.close();
    }
  });
});

test("caller results exceeding the actual MCP JSON-RPC envelope bound fail before any waiter release", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    let continuationCalls = 0;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "bounded-result");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "bounded-result" }], undefined);
      },
      async continueTools() {
        continuationCalls += 1;
        return finalAcknowledgement("must not continue");
      },
    }, { mcpLimits: { maxResponseBytes: 1_024 } });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("park a bounded call")]));
      const use = response.content.find((block) => block.type === "tool_use");
      const history = [...fixture.sessions[0].snapshot().transcript, user([resultBlock(use.id, "x".repeat(2_000))])];
      await assert.rejects(fixture.sessions[0].messages.create(request(history)), InvalidRequestError);
      assert.equal(fixture.sessions[0].state, "awaiting_tools");
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "none");
      assert.equal(continuationCalls, 0);
      const notReleased = await Promise.race([
        pending.promise.then(() => false, () => false),
        new Promise((resolve) => setTimeout(() => resolve(true), 20)),
      ]);
      assert.equal(notReleased, true);
    } finally {
      await fixture.close();
    }
  });
});

test("tool-result preflight includes the admitted JSON-RPC request ID in the response envelope", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    const requestId = "r".repeat(254); // JSON serialization is exactly the S7 256-byte ID ceiling.
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "long-request-id", undefined, requestId);
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "long-request-id" }], undefined);
      },
    }, { mcpLimits: { maxResponseBytes: 1_024 } });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("long request ID")]));
      const use = response.content.find((block) => block.type === "tool_use");
      await assert.rejects(fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, "x".repeat(900))]),
      ])), InvalidRequestError);
      assert.equal((await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState, "none");
      assert.equal(fixture.sessions[0].state, "awaiting_tools");
      assert.equal(await Promise.race([
        pending.promise.then(() => false, () => false),
        new Promise((resolve) => setTimeout(() => resolve(true), 20)),
      ]), true);
    } finally {
      await fixture.close();
    }
  });
});

test("caller abort settles a held MCP delivery wait and cancels its response transport", async () => {
  await withTempDirectory(async (root) => {
    const marker = "disconnect-after-waiter-release";
    const originalEnd = ServerResponse.prototype.end;
    let interceptedResponse;
    let signalIntercepted;
    const intercepted = new Promise((resolve) => { signalIntercepted = resolve; });
    ServerResponse.prototype.end = function (...args) {
      const first = args[0];
      if (!interceptedResponse && typeof first === "string" && first.includes(marker)) {
        interceptedResponse = this;
        signalIntercepted();
        return this;
      }
      return originalEnd.apply(this, args);
    };
    let fixture;
    let mcpCall;
    let continuationCalls = 0;
    try {
      fixture = await harness(root, {
        async dispatch(_index, _operation, session) {
          mcpCall = fixture.callTool(0, "disconnect-call");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          return toolAcknowledgement([{ key: "disconnect-call" }], undefined);
        },
        async continueTools() {
          continuationCalls += 1;
          return finalAcknowledgement("must not acknowledge a lost MCP response");
        },
      });
      const exposed = await fixture.sessions[0].messages.create(request([user("disconnect test")]));
      const use = exposed.content.find((block) => block.type === "tool_use");
      const controller = new AbortController();
      const continuation = fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, marker)]),
      ]), { signal: controller.signal });
      await intercepted;
      const abortStarted = Date.now();
      controller.abort();
      await assert.rejects(continuation, (error) => error.code === "protocol_failure" || error.code === "request_aborted");
      assert.ok(Date.now() - abortStarted < 1_000, "caller abort must not wait for the MCP response deadline");
      assert.equal(interceptedResponse.destroyed, true, "session cancellation should terminate the held response transport");
      await mcpCall.promise.catch(() => undefined);
      const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
      assert.equal(receipt.resultState, "uncertain");
      assert.equal(receipt.result.content[0].text, marker);
      assert.equal(continuationCalls, 0);
      assert.equal(fixture.sessions[0].state, "interrupted");
    } finally {
      ServerResponse.prototype.end = originalEnd;
      if (fixture) await fixture.close();
    }
  });
});

test("abort after durable save preserves a saved result without delivering or replaying it", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    let savedReached;
    const saved = new Promise((resolve) => { savedReached = resolve; });
    let releaseSaved;
    const savedGate = new Promise((resolve) => { releaseSaved = resolve; });
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "crash-window");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "crash-window" }], undefined);
      },
      async continueTools() { throw new Error("must not be reached before delivery"); },
    });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("park") ]));
      const use = response.content.find((block) => block.type === "tool_use");
      const session = fixture.sessions[0];
      const originalMutate = session.mutateReceipts.bind(session);
      let pausedAfterSave = false;
      session.mutateReceipts = async (update) => {
        const result = await originalMutate(update);
        const receipt = (await session.diagnostics.toolHandoffs())[0];
        if (!pausedAfterSave && receipt?.resultState === "saved") {
          pausedAfterSave = true;
          savedReached();
          await savedGate;
        }
        return result;
      };
      const controller = new AbortController();
      const operation = session.messages.create(request([
        ...session.snapshot().transcript,
        user([resultBlock(use.id, "durably saved")]),
      ]), { signal: controller.signal });
      await saved;
      controller.abort();
      releaseSaved();
      await assert.rejects(operation, RequestAbortedError);
      await waitFor(() => session.state === "interrupted");
      const receipt = (await session.diagnostics.toolHandoffs())[0];
      assert.equal(receipt.resultState, "saved");
      assert.equal(receipt.result.content[0].text, "durably saved");
      assert.equal((await session.diagnostics.toolHandoffs()).length, 1);
      await assert.rejects(session.messages.create(request([
        ...session.snapshot().transcript,
        user([resultBlock(use.id, "durably saved")]),
      ])), SessionInterruptedError);
      const recovery = await fixture.engines[0].recoveryDiagnostics();
      assert.equal(recovery[0].resultState, "saved");
      assert.equal(JSON.parse((await pending.promise).text).result, undefined, "the MCP waiter was not released");
    } finally {
      releaseSaved();
      await fixture.close();
    }
  });
});

test("crash before tool exposure leaves a private not-exposed receipt and never infers authority from history", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let parkedRequest;
    let dispatchCount = 0;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          parkedRequest = fixture.callTool(0, "crash-before-exposure");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          throw new Error("offline fake process crash");
        }
        return finalAcknowledgement("history is inert");
      },
    });
    try {
      await assert.rejects(fixture.sessions[0].messages.create(request([user("crash before exposure")])), ProcessFailureError);
      assert.equal(fixture.sessions[0].state, "interrupted");
      assert.deepEqual(fixture.sessions[0].snapshot().transcript, []);
      const recovered = await fixture.engines[0].recoveryDiagnostics();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].exposureState, "not_exposed");
      assert.equal(recovered[0].resultState, "none");

      // A new session may receive the old call/result as plain historical context,
      // but it has no receipt authority and cannot release the old waiter.
      const fresh = await fixture.engines[0].create({ model: "fresh", cwd: root, tools });
      const history = [
        user("historical prompt"),
        assistant([{ type: "tool_use", id: recovered[0].callId, name: "lookup", input: { key: "crash-before-exposure" } }]),
        user([resultBlock(recovered[0].callId, "old result")]),
        user("continue from history"),
      ];
      const output = await fresh.messages.create(request(history));
      assert.deepEqual(output.content, [text("history is inert")]);
      assert.deepEqual(await fresh.diagnostics.toolHandoffs(), []);
      assert.equal(dispatchCount, 2);
      assert.equal(JSON.parse((await parkedRequest.promise).text).result, undefined);
      await fresh.close();
    } finally {
      await fixture.close();
    }
  });
});

test("post-exposure recovery is read-only and a fresh session never replays historical calls", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let oldMcpCall;
    let dispatchCount = 0;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          oldMcpCall = fixture.callTool(0, "exposed-before-crash");
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          return toolAcknowledgement([{ key: "exposed-before-crash" }], undefined);
        }
        return finalAcknowledgement("fresh turn only");
      },
    });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("expose a tool") ]));
      const use = response.content.find((block) => block.type === "tool_use");
      await fixture.sessions[0].close();
      const recovered = await fixture.engines[0].recoveryDiagnostics();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].callId, use.id);
      assert.equal(recovered[0].exposureState, "exposed_or_uncertain");
      assert.equal(recovered[0].resultState, "none");

      const fresh = await fixture.engines[0].create({ model: "fresh", cwd: root, tools });
      const historical = [
        user("expose a tool"),
        assistant(response.content),
        user([resultBlock(use.id, "historical result")]),
        user("continue without resuming side effects"),
      ];
      const freshResponse = await fresh.messages.create(request(historical));
      assert.deepEqual(freshResponse.content, [text("fresh turn only")]);
      assert.deepEqual(await fresh.diagnostics.toolHandoffs(), []);
      assert.equal(dispatchCount, 2);
      const oldResponse = await oldMcpCall.promise.catch(() => undefined);
      assert.equal(oldResponse ? JSON.parse(oldResponse.text).result : undefined, undefined);
      await fresh.close();
    } finally {
      await fixture.close();
    }
  });
});

test("abort after delivery attempt records uncertainty and prohibits automatic replay", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let mcpCall;
    let signalDelivered;
    const delivered = new Promise((resolve) => { signalDelivered = resolve; });
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        mcpCall = fixture.callTool(0, "delivery-uncertain");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "delivery-uncertain" }], undefined);
      },
      async continueTools(continuation) {
        const response = await mcpCall.promise;
        assert.equal(JSON.parse(response.text).result.content[0].text, "delivered once");
        signalDelivered();
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new RequestAbortedError("fake continuation aborted"));
          continuation.signal.addEventListener("abort", onAbort, { once: true });
          if (continuation.signal.aborted) onAbort();
        });
      },
    });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("park for delivery")]));
      const use = response.content.find((block) => block.type === "tool_use");
      const controller = new AbortController();
      const continuation = fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, "delivered once")]),
      ]), { signal: controller.signal });
      await delivered;
      await waitFor(async () => (await fixture.sessions[0].diagnostics.toolHandoffs())[0].resultState === "delivery_attempted");
      controller.abort();
      await assert.rejects(continuation, RequestAbortedError);
      const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
      assert.equal(receipt.resultState, "uncertain");
      assert.equal(receipt.result.content[0].text, "delivered once");
      assert.equal(fixture.sessions[0].state, "interrupted");
      await assert.rejects(fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, "delivered once")]),
      ])), SessionInterruptedError);
      assert.equal((await fixture.engines[0].recoveryDiagnostics())[0].resultState, "uncertain");
    } finally {
      await fixture.close();
    }
  });
});

test("MCP request timeout aborts a parked call and leaves an uncertain exposed receipt", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "timeout-call");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "timeout-call" }], undefined);
      },
    }, { mcpLimits: { requestTimeoutMs: 150 } });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("timeout the bridge")]));
      assert.equal(response.stop_reason, "tool_use");
      await waitFor(() => fixture.sessions[0].state === "interrupted", "MCP deadline did not interrupt the parked call");
      const rpc = JSON.parse((await pending.promise).text);
      assert.equal(rpc.error.code, -32001);
      const receipt = (await fixture.sessions[0].diagnostics.toolHandoffs())[0];
      assert.equal(receipt.exposureState, "exposed_or_uncertain");
      assert.equal(receipt.resultState, "none");
    } finally {
      await fixture.close();
    }
  });
});

test("SIGKILL checkpoints retain durable receipts without startup replay", async () => {
  await withTempDirectory(async (root) => {
    const storageDir = join(root, "profiles");
    const registry = await createProfileRegistry({ storageDir, environment: { PATH: "/safe/bin" } });
    const account = await registry.accounts.create();
    const parentEngine = createProfileSessionEngine(registry.accounts, account.id, {
      workerManager: createProfileRuntimeManager(),
      driverFactory: () => ({ async dispatch() { throw new Error("parent engine must not start a session"); }, async close() {} }),
    });
    const workerPath = fileURLToPath(new URL("./tool-crash-worker.mjs", import.meta.url));
    const checkpoints = [
      { stage: "before-exposure", exposure: "not_exposed", result: "none" },
      { stage: "after-exposure", exposure: "exposure_attempted", result: "none" },
      { stage: "after-save", exposure: "exposed_or_uncertain", result: "saved" },
      { stage: "after-delivery", exposure: "exposed_or_uncertain", result: "delivery_attempted" },
      { stage: "after-acknowledgement", exposure: "exposed_or_uncertain", result: "acknowledged" },
    ];
    try {
      for (const expected of checkpoints) {
        const child = fork(workerPath, [expected.stage, storageDir, account.id], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
        });
        const nextMessage = workerChannel(child);
        try {
          const { server } = await nextMessage("ready");
          const mcpHeaders = await initializeMcp(server);
          child.send({ type: "start", mcpHeaders });
          let callId;
          let sessionId;
          if (expected.stage === "before-exposure") {
            const checkpoint = await nextMessage("checkpoint");
            assert.equal(checkpoint.state, "not_exposed");
            callId = checkpoint.receipt.callId;
            sessionId = checkpoint.receipt.sessionId;
          } else {
            const exposed = await nextMessage("exposed");
            callId = exposed.response.content.find((block) => block.type === "tool_use").id;
            sessionId = exposed.sessionId;
            if (expected.stage !== "after-exposure") {
              child.send({ type: "continue", callId });
              const checkpoint = await nextMessage("checkpoint");
              assert.equal(checkpoint.state, expected.result === "delivery_attempted" ? "delivered" : expected.result);
              assert.equal(checkpoint.receipt?.callId ?? callId, callId);
            }
          }

          const exit = once(child, "exit");
          child.kill("SIGKILL");
          const [, signal] = await exit;
          assert.equal(signal, "SIGKILL");
          const receipt = (await parentEngine.recoveryDiagnostics()).find((entry) => entry.callId === callId);
          assert.ok(receipt, `missing durable receipt at ${expected.stage}`);
          assert.equal(receipt.exposureState, expected.exposure);
          assert.equal(receipt.resultState, expected.result);
          assert.equal(receipt.sessionId, sessionId);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }
    } finally {
      await parentEngine.close();
    }
  });
});

test("private receipt storage symlink failure prevents tool exposure", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let call;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        call = fixture.callTool(0, "unsafe-path");
        await new Promise((resolve) => setTimeout(resolve, 30));
        return toolAcknowledgement([{ key: "unsafe-path" }], undefined);
      },
    });
    try {
      const storage = fixture.accounts[0].context.storageRoot;
      const maliciousTarget = join(root, "outside");
      await (await import("node:fs/promises")).mkdir(maliciousTarget);
      const { symlink } = await import("node:fs/promises");
      await symlink(maliciousTarget, join(storage, ".sdk-tool-receipts"));
      await assert.rejects(
        fixture.sessions[0].messages.create(request([user("tool path") ])),
        (error) => error instanceof InternalError || error instanceof ProtocolFailureError,
      );
      assert.deepEqual(await (await import("node:fs/promises")).readdir(maliciousTarget), []);
      await call?.promise.catch(() => undefined);
    } finally {
      await fixture.close();
    }
  });
});

test("receipt storage revalidates its directory after a successful write and refuses a swapped symlink", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    let pending;
    fixture = await harness(root, {
      async dispatch(_index, _operation, session) {
        pending = fixture.callTool(0, "swap-after-write");
        await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
        return toolAcknowledgement([{ key: "swap-after-write" }], undefined);
      },
    });
    try {
      const response = await fixture.sessions[0].messages.create(request([user("first durable call")]));
      const use = response.content.find((block) => block.type === "tool_use");
      const storage = fixture.accounts[0].context.storageRoot;
      const receiptDir = join(storage, ".sdk-tool-receipts");
      const preservedDir = join(storage, ".sdk-tool-receipts-original");
      const outside = join(root, "outside-target");
      await mkdir(outside);
      await rename(receiptDir, preservedDir);
      await symlink(outside, receiptDir);

      await assert.rejects(fixture.sessions[0].messages.create(request([
        ...fixture.sessions[0].snapshot().transcript,
        user([resultBlock(use.id, "must not deliver")]),
      ])), InternalError);
      assert.equal(fixture.sessions[0].state, "interrupted");
      assert.deepEqual(await readdir(outside), []);
      const preserved = JSON.parse(await readFile(join(preservedDir, `${fixture.sessions[0].sessionId}.json`), "utf8"));
      assert.equal(preserved.calls[0].resultState, "none");
      await assert.rejects(fixture.engines[0].recoveryDiagnostics(), InternalError);
      await pending.promise.catch(() => undefined);
    } finally {
      await fixture.close();
    }
  });
});

test("session MCP endpoint is passed directly to the injected driver binder", async () => {
  await withTempDirectory(async (root) => {
    let fixture;
    const bound = [];
    fixture = await harness(root, {
      bindCallerTools(index, server, session) {
        bound.push({ index, url: server.url, authorization: server.headers.authorization, accountId: server.accountId, sessionId: server.sessionId, catalogId: server.catalogId });
        assert.equal(server.accountId, session.accountId);
        assert.equal(server.sessionId, session.sessionId);
      },
    }, { accountCount: 2 });
    try {
      assert.equal(bound.length, 2);
      assert.ok(bound.every(({ url }) => /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(url)));
      assert.ok(bound.every(({ authorization }) => authorization.startsWith("Bearer ")));
      assert.notEqual(bound[0].authorization, bound[1].authorization);
      assert.notEqual(bound[0].sessionId, bound[1].sessionId);
      assert.notEqual(bound[0].accountId, bound[1].accountId);
    } finally {
      await fixture.close();
    }
  });
});
