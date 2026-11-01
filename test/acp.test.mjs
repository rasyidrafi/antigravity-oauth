import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable, PassThrough } from "node:stream";
import test from "node:test";
import {
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  ProviderError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  connectAcp,
} from "../dist/index.js";

const profile = Object.freeze({
  accountId: "acct_00000000-0000-4000-8000-000000000001",
  storageRoot: "/private/profile",
  childEnvironment: Object.freeze({ PATH: "/safe/bin", GEMINI_HOME: "/private/profile/gemini" }),
  async acquireAuthLock() {
    throw new Error("not used by transport tests");
  },
});

const sleep = (milliseconds = 2) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep();
  }
  assert.fail(message);
}

function messageLines(child) {
  return child.writes.map((bytes) => JSON.parse(bytes.toString("utf8").trim()));
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  writes = [];
  writeCallbacks = [];
  killSignals = [];
  ended = false;
  onWrite;
  holdWrites;

  constructor({ onWrite = () => {}, holdWrites = false, highWaterMark = 16_384 } = {}) {
    super();
    this.onWrite = onWrite;
    this.holdWrites = holdWrites;
    this.stdin = new Writable({
      highWaterMark,
      write: (chunk, _encoding, callback) => {
        const bytes = Buffer.from(chunk);
        this.writes.push(bytes);
        this.onWrite(bytes);
        if (this.holdWrites) this.writeCallbacks.push(callback);
        else queueMicrotask(() => callback());
      },
    });
  }

  reply(id, result, extra = {}) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result, ...extra })}\n`);
  }

  writeRaw(value) {
    this.stdout.write(value);
  }

  releaseWrite() {
    const callback = this.writeCallbacks.shift();
    assert.ok(callback, "expected a blocked stdin write callback");
    callback();
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.exit(signal);
    return true;
  }

  exit(signal = null) {
    if (this.ended) return;
    this.ended = true;
    this.emit("exit", 0, signal);
    this.stdout.end();
    this.stderr.end();
    this.stdin.destroy();
    this.emit("close", 0, signal);
  }
}

async function openConnection(options = {}) {
  let child;
  let spawnCall;
  const connection = await connectAcp({
    executable: "/opt/official/acp-agent",
    args: ["--stdio"],
    profile,
    shutdownTimeoutMs: 10,
    processFactory: (executable, args, spawnOptions) => {
      spawnCall = { executable, args, spawnOptions };
      child = new FakeChild({
        onWrite: (bytes) => {
          const message = JSON.parse(bytes.toString("utf8").trim());
          if (message.method === "initialize") {
            const response = Buffer.from(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: options.protocolVersion ?? 1,
                agentCapabilities: { loadSession: false },
              },
            }) + "\n");
            if (options.onInitializeOutput) {
              options.onInitializeOutput(response, child);
            } else {
              child.writeRaw(response.subarray(0, 9));
              setImmediate(() => child.writeRaw(response.subarray(9)));
            }
          } else {
            options.onRequestWritten?.(message, child);
          }
        },
        holdWrites: options.holdWrites ?? false,
        highWaterMark: options.highWaterMark ?? 16_384,
      });
      return child;
    },
    onRequest: options.onRequest,
    onNotification: options.onNotification,
    onStderr: options.onStderr,
    maxFrameBytes: options.maxFrameBytes,
    maxQueuedBytes: options.maxQueuedBytes,
    maxPendingRequests: options.maxPendingRequests,
    maxInboundMessages: options.maxInboundMessages,
    maxInboundQueuedBytes: options.maxInboundQueuedBytes,
    maxStderrBytes: options.maxStderrBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    ...options.connectionOptions,
  });
  return { connection, child, spawnCall };
}

test("connect performs ACP v1 initialization only and uses the explicit isolated profile environment", async () => {
  const { connection, child, spawnCall } = await openConnection();
  try {
    assert.deepEqual(messageLines(child).map(({ method }) => method), ["initialize"]);
    assert.deepEqual(messageLines(child)[0].params, { protocolVersion: 1, clientCapabilities: {} });
    assert.deepEqual(connection.initializeResult, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
    });
    assert.equal(spawnCall.executable, "/opt/official/acp-agent");
    assert.deepEqual(spawnCall.args, ["--stdio"]);
    assert.deepEqual(spawnCall.spawnOptions.env, profile.childEnvironment);
    assert.deepEqual(spawnCall.spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(Object.hasOwn(spawnCall.spawnOptions.env, "GOOGLE_API_KEY"), false);
    assert.equal(messageLines(child).some(({ method }) => method === "session/new"), false);
  } finally {
    await connection.close();
  }
});

test("initialization rejects unsupported protocol versions", async () => {
  let child;
  await assert.rejects(
    connectAcp({
      executable: "agent",
      profile,
      shutdownTimeoutMs: 10,
      processFactory: () => {
        child = new FakeChild({
          onWrite: (bytes) => {
            const message = JSON.parse(bytes.toString("utf8").trim());
            child.reply(message.id, { protocolVersion: 2 });
          },
        });
        return child;
      },
    }),
    ProtocolFailureError,
  );
  assert.ok(child.killSignals.includes("SIGTERM"));
});

test("initialization never returns a connection after a same-chunk protocol failure or immediate exit", async (t) => {
  await t.test("valid response followed by malformed frame in the same stdout chunk", async () => {
    let child;
    await assert.rejects(
      connectAcp({
        executable: "agent",
        profile,
        shutdownTimeoutMs: 10,
        processFactory: () => {
          child = new FakeChild({
            onWrite: (bytes) => {
              const message = JSON.parse(bytes.toString("utf8").trim());
              const response = Buffer.from(`${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { protocolVersion: 1 },
              })}\n`);
              child.writeRaw(Buffer.concat([response, Buffer.from("not-json\n")]));
            },
          });
          return child;
        },
      }),
      ProtocolFailureError,
    );
    assert.equal(child.ended, true);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.listenerCount("close"), 0);
  });

  await t.test("valid response immediately followed by process exit", async () => {
    let child;
    await assert.rejects(
      connectAcp({
        executable: "agent",
        profile,
        shutdownTimeoutMs: 10,
        processFactory: () => {
          child = new FakeChild({
            onWrite: (bytes) => {
              const message = JSON.parse(bytes.toString("utf8").trim());
              child.reply(message.id, { protocolVersion: 1 });
              child.exit(1);
            },
          });
          return child;
        },
      }),
      ProcessFailureError,
    );
    assert.equal(child.ended, true);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.listenerCount("close"), 0);
  });
});

test("partial and multiframe NDJSON supports out-of-order replies and inbound dispatch", async () => {
  const notifications = [];
  const requests = [];
  const writtenRequests = [];
  const { connection, child } = await openConnection({
    onRequestWritten: (message) => writtenRequests.push(message),
    onRequest: async (request) => {
      requests.push(request);
      return { accepted: request.method, params: request.params };
    },
    onNotification: async (notification) => notifications.push(notification),
  });
  try {
    const first = connection.request("fixture/first", { n: 1 });
    const second = connection.request("fixture/second", { n: 2 });
    await waitFor(() => writtenRequests.length === 2, "two outbound requests should be written");
    const [firstRequest, secondRequest] = writtenRequests;
    child.writeRaw(Buffer.from([
      JSON.stringify({ jsonrpc: "2.0", id: secondRequest.id, result: "second-result" }),
      JSON.stringify({ jsonrpc: "2.0", id: firstRequest.id, result: "first-result" }),
      JSON.stringify({ jsonrpc: "2.0", id: "server-req", method: "auth/continue", params: { step: 1 } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: "ready" } }),
    ].join("\n") + "\n"));

    assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);
    await connection.notify("client/notice", { flag: true });
    const outboundNotification = messageLines(child).find((message) => message.method === "client/notice");
    assert.equal(Object.hasOwn(outboundNotification, "id"), false);
    await waitFor(() => requests.length === 1 && notifications.length === 1);
    await waitFor(() => messageLines(child).some((message) => message.id === "server-req"));
    const response = messageLines(child).find((message) => message.id === "server-req");
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: "server-req",
      result: { accepted: "auth/continue", params: { step: 1 } },
    });
    assert.deepEqual(notifications, [{ method: "session/update", params: { update: "ready" } }]);
  } finally {
    await connection.close();
  }
});

test("unsupported server requests receive JSON-RPC method-not-found rather than fake success", async () => {
  const { connection, child } = await openConnection();
  try {
    child.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 55, method: "unsupported/call" })}\n`);
    await waitFor(() => messageLines(child).some((message) => message.id === 55));
    assert.deepEqual(messageLines(child).find((message) => message.id === 55), {
      jsonrpc: "2.0",
      id: 55,
      error: { code: -32601, message: "Method not found" },
    });
  } finally {
    await connection.close();
  }
});

test("malformed JSON, malformed UTF-8, oversized frames, and unknown response IDs fail closed", async (t) => {
  const cases = [
    ["malformed JSON", (child) => child.writeRaw("{bad json}\n")],
    ["malformed UTF-8", (child) => child.writeRaw(Buffer.from([0xff, 0x0a]))],
    ["oversized frame", (child) => child.writeRaw(Buffer.alloc(129, 0x61))],
    ["unknown ID", (child) => child.reply(999, "not-correlated")],
  ];
  for (const [name, sendBadFrame] of cases) {
    await t.test(name, async () => {
      const { connection, child } = await openConnection({
        maxFrameBytes: name === "oversized frame" ? 128 : undefined,
      });
      const pending = connection.request("fixture/pending");
      await waitFor(() => messageLines(child).some((message) => message.method === "fixture/pending"));
      sendBadFrame(child);
      await assert.rejects(pending, ProtocolFailureError);
      await connection.close();
    });
  }
});

test("a server callback error is returned as a JSON-RPC error without leaking its detail", async () => {
  const { connection, child } = await openConnection({
    onRequest: () => { throw new Error("secret callback detail"); },
  });
  try {
    child.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "auth/request" })}\n`);
    await waitFor(() => messageLines(child).some((message) => message.id === 8));
    const response = messageLines(child).find((message) => message.id === 8);
    assert.deepEqual(response.error, { code: -32603, message: "Internal error" });
    assert.equal(JSON.stringify(response).includes("secret callback detail"), false);
  } finally {
    await connection.close();
  }
});

test("timeouts and aborts reject callers, and late correlated replies do not become unknown IDs", async () => {
  const written = [];
  const { connection, child } = await openConnection({
    requestTimeoutMs: 200,
    onRequestWritten: (message) => written.push(message),
  });
  try {
    const timedOut = connection.request("fixture/timeout", undefined, { timeoutMs: 20 });
    await waitFor(() => written.some((message) => message.method === "fixture/timeout"));
    const timeoutId = written.find((message) => message.method === "fixture/timeout").id;
    await assert.rejects(timedOut, RequestTimeoutError);
    child.reply(timeoutId, "late-timeout-response");

    const deadlineCall = connection.request("fixture/deadline", undefined, {
      deadline: Date.now() + 50,
    });
    await waitFor(() => written.some((message) => message.method === "fixture/deadline"));
    const deadlineId = written.find((message) => message.method === "fixture/deadline").id;
    await assert.rejects(deadlineCall, RequestTimeoutError);
    child.reply(deadlineId, "late-deadline-response");

    const controller = new AbortController();
    const aborted = connection.request("fixture/abort", undefined, { signal: controller.signal });
    await waitFor(() => written.some((message) => message.method === "fixture/abort"));
    const abortId = written.find((message) => message.method === "fixture/abort").id;
    controller.abort();
    await assert.rejects(aborted, RequestAbortedError);
    child.reply(abortId, "late-abort-response");

    const healthy = connection.request("fixture/healthy");
    await waitFor(() => written.some((message) => message.method === "fixture/healthy"));
    const healthyId = written.find((message) => message.method === "fixture/healthy").id;
    child.reply(healthyId, "still-open");
    assert.equal(await healthy, "still-open");
  } finally {
    await connection.close();
  }
});

test("abandoned request IDs stay inside the outstanding-request bound until answered", async () => {
  const written = [];
  const { connection, child } = await openConnection({
    maxPendingRequests: 1,
    onRequestWritten: (message) => written.push(message),
  });
  try {
    const timedOut = connection.request("fixture/abandoned", undefined, { timeoutMs: 20 });
    await waitFor(() => written.some((message) => message.method === "fixture/abandoned"));
    const abandonedId = written.find((message) => message.method === "fixture/abandoned").id;
    await assert.rejects(timedOut, RequestTimeoutError);
    await assert.rejects(connection.request("fixture/blocked-by-abandoned-id"), SessionBusyError);
    child.reply(abandonedId, "late");

    const next = connection.request("fixture/after-late-response");
    await waitFor(() => written.some((message) => message.method === "fixture/after-late-response"));
    const nextId = written.find((message) => message.method === "fixture/after-late-response").id;
    child.reply(nextId, "ok");
    assert.equal(await next, "ok");
  } finally {
    await connection.close();
  }
});

test("abort before dispatch does not spawn a child", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    connectAcp({
      executable: "agent",
      profile,
      signal: controller.signal,
      processFactory: () => {
        calls += 1;
        throw new Error("must not be called");
      },
    }),
    RequestAbortedError,
  );
  assert.equal(calls, 0);
});

test("process errors, EOF, and exit reject all pending work with typed errors", async (t) => {
  await t.test("process error", async () => {
    const { connection, child } = await openConnection();
    const first = connection.request("fixture/one");
    const second = connection.request("fixture/two");
    await waitFor(() => messageLines(child).some((message) => message.method === "fixture/two"));
    child.emit("error", new Error("sensitive process diagnostic"));
    await assert.rejects(first, ProcessFailureError);
    await assert.rejects(second, ProcessFailureError);
    await connection.close();
  });

  await t.test("partial frame followed by EOF", async () => {
    const { connection, child } = await openConnection();
    const pending = connection.request("fixture/pending");
    await waitFor(() => messageLines(child).some((message) => message.method === "fixture/pending"));
    child.writeRaw(Buffer.from('{"jsonrpc":"2.0"'));
    child.stdout.end();
    await assert.rejects(pending, ProtocolFailureError);
    await connection.close();
  });

  await t.test("unexpected exit", async () => {
    const { connection, child } = await openConnection();
    const pending = connection.request("fixture/pending");
    await waitFor(() => messageLines(child).some((message) => message.method === "fixture/pending"));
    child.exit(1);
    await assert.rejects(pending, ProcessFailureError);
    await connection.close();
  });
});

test("inbound callback work is bounded and notification overflow fails visibly", async () => {
  const { connection, child } = await openConnection({
    maxInboundMessages: 1,
    onNotification: () => new Promise(() => {}),
  });
  child.writeRaw([
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { seq: 1 } }),
    JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { seq: 2 } }),
  ].join("\n") + "\n");
  await sleep(5);
  const pending = connection.request("fixture/check-after-overflow");
  await assert.rejects(pending, ProtocolFailureError);
  await connection.close();
});

test("inbound callback byte queue is bounded even when message count is available", async () => {
  const { connection, child } = await openConnection({
    maxInboundMessages: 8,
    maxInboundQueuedBytes: 128,
    onNotification: () => new Promise(() => {}),
  });
  child.writeRaw(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { payload: "x".repeat(100) },
  })}\n`);
  await sleep(5);
  await assert.rejects(connection.request("fixture/after-byte-overflow"), ProtocolFailureError);
  await connection.close();
});

test("outbound backpressure waits for drain before writing the next frame", async () => {
  const { connection, child } = await openConnection({ holdWrites: true, highWaterMark: 1 });
  try {
    const request = connection.request("fixture/backpressure");
    await waitFor(() => child.writeCallbacks.length === 1);
    await sleep(5);
    assert.equal(
      messageLines(child).some((message) => message.method === "fixture/backpressure"),
      false,
      "the next frame must wait behind the blocked initialize write",
    );
    child.releaseWrite();
    await waitFor(() => messageLines(child).some((message) => message.method === "fixture/backpressure"));
    assert.equal(child.writeCallbacks.length, 1);
    child.reply(messageLines(child).find((message) => message.method === "fixture/backpressure").id, "written");
    assert.equal(await request, "written");
  } finally {
    while (child.writeCallbacks.length > 0) child.releaseWrite();
    await connection.close();
  }
});

test("outbound queue limits and request concurrency are enforced", async (t) => {
  await t.test("queued bytes", async () => {
    const { connection } = await openConnection({ maxQueuedBytes: 128 });
    try {
      await assert.rejects(
        connection.request("x".repeat(200)),
        SessionBusyError,
      );
    } finally {
      await connection.close();
    }
  });

  await t.test("pending request count", async () => {
    const { connection, child } = await openConnection({ maxPendingRequests: 1 });
    try {
      const pending = connection.request("fixture/one");
      await waitFor(() => messageLines(child).some((message) => message.method === "fixture/one"));
      await assert.rejects(connection.request("fixture/two"), SessionBusyError);
      child.reply(messageLines(child).find((message) => message.method === "fixture/one").id, "done");
      assert.equal(await pending, "done");
    } finally {
      await connection.close();
    }
  });
});

test("stderr diagnostics withhold content across split secrets, incomplete PEM, and capped values", async () => {
  let diagnostic;
  const { connection, child } = await openConnection({
    maxStderrBytes: 128,
    onStderr: (text) => { diagnostic = text; },
  });
  child.stderr.write("Authorization: Bearer split-");
  child.stderr.write("secret-token\n-----BEGIN PRIVATE KEY-----\n");
  child.stderr.write("unfinished-private-key-secret\npassword=\"unterminated-password-secret");
  child.stderr.write("x".repeat(20_000));
  child.exit(2);
  await assert.rejects(connection.request("after-exit"), ProcessFailureError);
  await connection.close();
  assert.equal(diagnostic, "ACP stderr content withheld (at least 128 bytes observed).");
  for (const secret of [
    "split-secret-token",
    "unfinished-private-key-secret",
    "unterminated-password-secret",
    "Authorization",
    "PRIVATE KEY",
  ]) {
    assert.equal(diagnostic.includes(secret), false);
  }
});

test("close is idempotent, removes listeners, and later operations are rejected", async () => {
  const { connection, child } = await openConnection();
  const first = connection.close();
  const second = connection.close();
  assert.equal(first, second);
  await first;
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  await assert.rejects(connection.notify("fixture/closed"), ProcessFailureError);
});

test("request validation rejects non-JSON params and timeout options", async () => {
  const { connection } = await openConnection();
  try {
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(connection.request("fixture/cyclic", cyclic), InvalidRequestError);
    await assert.rejects(connection.request("fixture/timeout", undefined, { timeoutMs: 0 }), InvalidRequestError);
    await assert.rejects(connection.notify("fixture/bad", undefined, { deadline: 0 }), InvalidRequestError);
  } finally {
    await connection.close();
  }
});

test("valid remote JSON-RPC errors reject rather than becoming successful values", async () => {
  const written = [];
  const { connection, child } = await openConnection({ onRequestWritten: (message) => written.push(message) });
  try {
    const request = connection.request("fixture/rejected");
    await waitFor(() => written.some((message) => message.method === "fixture/rejected"));
    const id = written.find((message) => message.method === "fixture/rejected").id;
    child.writeRaw(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "sensitive remote details", data: { token: "never-expose" } },
    })}\n`);
    await assert.rejects(request, (error) => error instanceof ProviderError && !error.message.includes("sensitive"));
  } finally {
    await connection.close();
  }
});
