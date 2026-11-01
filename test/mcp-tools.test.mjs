import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InvalidRequestError,
  UnsupportedFeatureError,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";

const toolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  $defs: {
    item: {
      type: "object",
      properties: { quantity: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["quantity"],
      additionalProperties: false,
    },
  },
  properties: {
    item: { $ref: "#/$defs/item" },
    label: { type: "string", minLength: 2, maxLength: 20 },
  },
  required: ["item"],
  additionalProperties: false,
};

const toolCatalog = (schema = toolSchema, name = "lookup") => [{
  name,
  description: "Look up a record.",
  input_schema: schema,
}];

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s7-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function setup(directory, { tools = toolCatalog(), onToolCall, limits, startServer = true } = {}) {
  const registry = await createProfileRegistry({
    storageDir: join(directory, "profiles"),
    environment: { PATH: "/safe/bin" },
  });
  const account = await registry.accounts.create();
  const workerManager = createProfileRuntimeManager();
  const engine = createProfileSessionEngine(registry.accounts, account.id, {
    workerManager,
    driverFactory: () => ({
      async dispatch() {
        return { stage: "completed", output: [{ role: "assistant", content: "ok" }] };
      },
      async close() {},
    }),
  });
  const session = await engine.create({ model: "test-model", cwd: directory, tools });
  let calls = 0;
  const server = startServer ? await session.tools.createMcpServer({
    limits,
    onToolCall: async (call, options) => {
      calls += 1;
      if (onToolCall) return onToolCall(call, options);
      return { content: [{ type: "text", text: `called:${call.name}` }] };
    },
  }) : undefined;
  return {
    registry,
    account,
    workerManager,
    engine,
    session,
    server,
    get calls() { return calls; },
  };
}

async function closeSetup(setupValue) {
  await setupValue.session.close();
  await setupValue.engine.close();
}

function rpcBody(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

async function post(server, body, {
  headers = {},
  signal,
  raw,
} = {}) {
  return fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
    signal,
  });
}

async function postWithHost(server, body, host, headers = {}) {
  const url = new URL(server.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        ...headers,
        host,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function initialize(server) {
  const response = await post(server, rpcBody("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "s7-offline-test", version: "1.0" },
  }));
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.equal(rpc.result.protocolVersion, "2025-06-18");
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const headers = {
    ["mcp-session-id"]: sessionId,
    "mcp-protocol-version": "2025-06-18",
  };
  const initialized = await post(server, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, { headers });
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), "");
  return headers;
}

async function waitFor(predicate, message = "condition did not become true") {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("loopback MCP initializes, lists the immutable schema, and validates local refs and nested constraints", async () => {
  await withTempDirectory(async (directory) => {
    const callerSchema = structuredClone(toolSchema);
    const configuredTools = toolCatalog(callerSchema);
    const value = await setup(directory, { tools: configuredTools });
    try {
      assert.match(value.server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      assert.equal(value.server.accountId, value.account.id);
      assert.equal(value.server.sessionId, value.session.sessionId);
      assert.match(value.server.catalogId, /^sha256-[a-f0-9]{64}$/u);

      // Mutating caller-owned input after session creation cannot change the registry.
      callerSchema.properties.label.maxLength = 1;
      const headers = await initialize(value.server);
      const listed = await post(value.server, rpcBody("tools/list", {}, 2), { headers });
      assert.equal(listed.status, 200);
      const listing = await listed.json();
      assert.equal(listing.result.tools.length, 1);
      assert.equal(listing.result.tools[0].name, "lookup");
      assert.equal(listing.result.tools[0].inputSchema.properties.label.maxLength, 20);
      assert.deepEqual(listing.result.tools[0].inputSchema.$defs.item.required, ["quantity"]);

      const valid = await post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 4 }, label: "ok" },
      }, 3), { headers });
      assert.equal(valid.status, 200);
      const result = await valid.json();
      assert.equal(result.result.content[0].text, "called:lookup");
      assert.equal(value.calls, 1);

      const badNested = await post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 11, extra: true }, label: "ok" },
      }, 4), { headers });
      assert.equal((await badNested.json()).error.code, -32602);
      const badRoot = await post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 4 }, unexpected: true },
      }, 5), { headers });
      assert.equal((await badRoot.json()).error.code, -32602);
      const unknown = await post(value.server, rpcBody("tools/call", {
        name: "not-in-catalog",
        arguments: {},
      }, 6), { headers });
      assert.equal((await unknown.json()).error.code, -32602);
      assert.equal(value.calls, 1);

      const primitive = await post(value.server, 5, { headers });
      assert.equal((await primitive.json()).error.code, -32600);
      const malformedMethod = await post(value.server, { jsonrpc: "2.0", id: 7, method: 3 }, { headers });
      assert.equal((await malformedMethod.json()).error.code, -32600);
      const invalidId = await post(value.server, { jsonrpc: "2.0", id: {}, method: "tools/list" }, { headers });
      const invalidIdResponse = await invalidId.json();
      assert.equal(invalidIdResponse.error.code, -32600);
      assert.equal(invalidIdResponse.id, null);
      const batch = await post(value.server, [rpcBody("tools/list", {}, 8)], { headers });
      assert.equal((await batch.json()).error.code, -32600);
      assert.equal(value.calls, 1);
    } finally {
      await closeSetup(value);
    }
  });
});

test("unsupported JSON Schema dialect features are rejected before any worker starts", async () => {
  await withTempDirectory(async (directory) => {
    const registry = await createProfileRegistry({
      storageDir: join(directory, "profiles"),
      environment: { PATH: "/safe/bin" },
    });
    const account = await registry.accounts.create();
    let driverStarts = 0;
    const engine = createProfileSessionEngine(registry.accounts, account.id, {
      workerManager: createProfileRuntimeManager(),
      driverFactory: () => {
        driverStarts += 1;
        return { async dispatch() { throw new Error("not used"); }, async close() {} };
      },
    });
    try {
      await assert.rejects(
        engine.create({
          model: "test-model",
          cwd: directory,
          tools: toolCatalog({ type: "object", properties: { value: { type: "string", pattern: "^safe$" } } }),
        }),
        UnsupportedFeatureError,
      );
      await assert.rejects(
        engine.create({
          model: "test-model",
          cwd: directory,
          tools: toolCatalog({ type: "object", properties: { value: { $ref: "https://example.invalid/schema" } } }),
        }),
        UnsupportedFeatureError,
      );
      await assert.rejects(
        engine.create({
          model: "test-model",
          cwd: directory,
          tools: toolCatalog({ type: "object", properties: { value: { type: "string", format: "email" } } }),
        }),
        UnsupportedFeatureError,
      );
      await assert.rejects(
        engine.create({
          model: "test-model",
          cwd: directory,
          tools: toolCatalog({ type: "object", $ref: "#" }),
        }),
        UnsupportedFeatureError,
      );
      await assert.rejects(
        engine.create({
          model: "test-model",
          cwd: directory,
          tools: [{ name: "bash", type: "bash_20250124", input_schema: { type: "object" } }],
        }),
        UnsupportedFeatureError,
      );
      const prototypeSchema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"integer"}}}');
      const nestedPrototypeSchema = JSON.parse(
        '{"type":"object","properties":{"nested":{"type":"object","properties":{"__proto__":{"type":"integer"}}}}}',
      );
      const referencedPrototypeSchema = JSON.parse(
        '{"type":"object","$defs":{"nested":{"type":"object","properties":{"__proto__":{"type":"integer"}}}},"properties":{"nested":{"$ref":"#/$defs/nested"}}}',
      );
      for (const schema of [prototypeSchema, nestedPrototypeSchema, referencedPrototypeSchema]) {
        await assert.rejects(
          engine.create({ model: "test-model", cwd: directory, tools: toolCatalog(schema) }),
          UnsupportedFeatureError,
        );
      }
      assert.equal(driverStarts, 0);
    } finally {
      await engine.close();
    }
  });
});

test("capability, account/session/catalog binding, MCP session, and Origin checks reject foreign requests", async () => {
  await withTempDirectory(async (directory) => {
    const value = await setup(directory);
    try {
      const headers = await initialize(value.server);
      const wrongToken = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, authorization: "Bearer wrong-token" },
      });
      assert.equal(wrongToken.status, 401);
      const wrongAccount = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, "x-antigravity-account-id": "acct_foreign" },
      });
      assert.equal(wrongAccount.status, 404);
      const wrongSession = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, "x-antigravity-session-id": "sess_foreign" },
      });
      assert.equal(wrongSession.status, 404);
      const wrongCatalog = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, "x-antigravity-tool-catalog": "sha256-foreign" },
      });
      assert.equal(wrongCatalog.status, 404);
      const wrongMcpSession = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, "mcp-session-id": "foreign" },
      });
      assert.equal(wrongMcpSession.status, 404);
      const origin = await post(value.server, rpcBody("tools/list", {}), {
        headers: { ...headers, origin: "https://attacker.example" },
      });
      assert.equal(origin.status, 403);
      const wrongHost = await postWithHost(value.server, rpcBody("tools/list", {}), "localhost:12345", headers);
      assert.equal(wrongHost.status, 400);
    } finally {
      await closeSetup(value);
    }
  });
});

test("duplicate active JSON-RPC IDs are rejected and notifications/cancelled abort the injected handler", async () => {
  await withTempDirectory(async (directory) => {
    let enteredResolve;
    let aborted = false;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const value = await setup(directory, {
      onToolCall: (_call, { signal }) => new Promise((_resolve, reject) => {
        enteredResolve();
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });
    try {
      const headers = await initialize(value.server);
      const pending = post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 2 } },
      }, "duplicate"), { headers });
      await entered;
      const duplicate = await post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 2 } },
      }, "duplicate"), { headers });
      assert.equal((await duplicate.json()).error.code, -32600);

      const cancelled = await post(value.server, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "duplicate", reason: "offline test" },
      }, { headers });
      assert.equal(cancelled.status, 202);
      const response = await pending;
      assert.equal((await response.json()).error.code, -32800);
      assert.equal(aborted, true);
    } finally {
      await closeSetup(value);
    }
  });
});

test("body, request, and handler concurrency bounds are enforced", async () => {
  await withTempDirectory(async (directory) => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const value = await setup(directory, {
      limits: {
        maxRequestBytes: 256,
        maxConcurrentRequests: 1,
        maxConcurrentToolCalls: 1,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
      },
      onToolCall: (_call, { signal }) => new Promise((_resolve, reject) => {
        enteredResolve();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    try {
      const headers = await initialize(value.server);
      const oversized = await post(value.server, {}, {
        headers,
        raw: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: { huge: "x".repeat(300) }, id: 1 }),
      });
      assert.equal(oversized.status, 413);

      const pending = post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 2 } },
      }, 100), { headers });
      await entered;
      const limited = await post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 3 } },
      }, 101), { headers });
      assert.equal(limited.status, 503);
      const cancelled = await post(value.server, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 100 },
      }, { headers });
      assert.equal(cancelled.status, 202);
      assert.equal((await (await pending).json()).error.code, -32800);
    } finally {
      await closeSetup(value);
    }
  });
});

test("injected tool-call concurrency has its own bound", async () => {
  await withTempDirectory(async (directory) => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const value = await setup(directory, {
      limits: { maxConcurrentRequests: 4, maxConcurrentToolCalls: 1, requestTimeoutMs: 2_000 },
      onToolCall: (_call, { signal }) => new Promise((_resolve, reject) => {
        enteredResolve();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    try {
      const headers = await initialize(value.server);
      const pending = post(value.server, rpcBody("tools/call", {
        name: "lookup", arguments: { item: { quantity: 2 } },
      }, 301), { headers });
      await entered;
      const limited = await post(value.server, rpcBody("tools/call", {
        name: "lookup", arguments: { item: { quantity: 3 } },
      }, 302), { headers });
      assert.equal(limited.status, 200);
      assert.equal((await limited.json()).error.code, -32004);
      const cancel = await post(value.server, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 301 },
      }, { headers });
      assert.equal(cancel.status, 202);
      assert.equal((await (await pending).json()).error.code, -32800);
    } finally {
      await closeSetup(value);
    }
  });
});

test("serialized IDs and response-size fallbacks remain bounded", async () => {
  await withTempDirectory(async (directory) => {
    const catalog = toolCatalog({ type: "object" });
    catalog[0].description = "d".repeat(2_048);
    const value = await setup(directory, {
      tools: catalog,
      limits: { maxResponseBytes: 1_024 },
      onToolCall: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    try {
      const headers = await initialize(value.server);
      const normal = await post(value.server, rpcBody("tools/call", {
        name: "lookup", arguments: {},
      }, "normal-id"), { headers });
      const normalText = await normal.text();
      const normalBody = JSON.parse(normalText);
      assert.equal(normalBody.id, "normal-id");
      assert.ok(Buffer.byteLength(normalText) <= 1_024);

      const oversizedList = await post(value.server, rpcBody("tools/list", {}, "bounded-normal-id"), { headers });
      const oversizedListText = await oversizedList.text();
      const oversizedListBody = JSON.parse(oversizedListText);
      assert.equal(oversizedListBody.error.code, -32603);
      assert.equal(oversizedListBody.id, "bounded-normal-id");
      assert.ok(Buffer.byteLength(oversizedListText) <= 1_024);

      const ordinaryNearLimitId = "a".repeat(254); // quoted JSON form is exactly 256 bytes
      const ordinaryNearLimit = await post(value.server, rpcBody("tools/list", {}, ordinaryNearLimitId), { headers });
      const ordinaryNearLimitText = await ordinaryNearLimit.text();
      const ordinaryNearLimitBody = JSON.parse(ordinaryNearLimitText);
      assert.equal(ordinaryNearLimitBody.error.code, -32603);
      assert.equal(ordinaryNearLimitBody.id, ordinaryNearLimitId);
      assert.ok(Buffer.byteLength(ordinaryNearLimitText) <= 1_024);

      const escapedNearLimitId = "\u0001".repeat(42);
      const escapedNearLimit = await post(value.server, rpcBody("tools/list", {}, escapedNearLimitId), { headers });
      const escapedNearLimitText = await escapedNearLimit.text();
      const escapedNearLimitBody = JSON.parse(escapedNearLimitText);
      assert.equal(escapedNearLimitBody.error.code, -32603);
      assert.equal(escapedNearLimitBody.id, escapedNearLimitId);
      assert.ok(Buffer.byteLength(escapedNearLimitText) <= 1_024);

      for (const id of ["x".repeat(8_192), "\u0001".repeat(43)]) {
        const response = await post(value.server, rpcBody("tools/list", {}, id), { headers });
        const text = await response.text();
        const body = JSON.parse(text);
        assert.equal(body.error.code, -32600);
        assert.equal(body.id, null);
        assert.ok(Buffer.byteLength(text) <= 1_024);
      }
    } finally {
      await closeSetup(value);
    }
  });
});

test("a paused client cannot hold a large MCP response past the request deadline", async () => {
  await withTempDirectory(async (directory) => {
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const value = await setup(directory, {
      limits: {
        maxResponseBytes: 16 * 1_048_576,
        maxConcurrentRequests: 1,
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 100,
      },
      onToolCall: async () => {
        enteredResolve();
        return { content: [{ type: "text", text: "x".repeat(15 * 1_048_576) }] };
      },
    });
    let request;
    try {
      const headers = await initialize(value.server);
      const url = new URL(value.server.url);
      request = netConnect(Number(url.port), url.hostname);
      request.on("error", () => {});
      const connected = new Promise((resolve, reject) => {
        request.once("connect", resolve);
        request.once("error", reject);
      });
      let received = Buffer.alloc(0);
      let headersResolve;
      const headersReceived = new Promise((resolve) => { headersResolve = resolve; });
      const onReadable = () => {
        let chunk;
        while ((chunk = request.read()) !== null) {
          received = Buffer.concat([received, chunk]);
          if (received.indexOf("\r\n\r\n") !== -1) {
            request.pause();
            request.removeListener("readable", onReadable);
            headersResolve();
            return;
          }
        }
      };
      request.on("readable", onReadable);
      await connected;
      const body = JSON.stringify(rpcBody("tools/call", {
        name: "lookup", arguments: { item: { quantity: 2 } },
      }, "paused-client"));
      const wire = [
        "POST /mcp HTTP/1.1",
        `Host: 127.0.0.1:${url.port}`,
        `Authorization: ${value.server.headers.authorization}`,
        `x-antigravity-account-id: ${value.server.accountId}`,
        `x-antigravity-session-id: ${value.server.sessionId}`,
        `x-antigravity-tool-catalog: ${value.server.catalogId}`,
        `mcp-session-id: ${headers["mcp-session-id"]}`,
        `mcp-protocol-version: ${headers["mcp-protocol-version"]}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: keep-alive",
        "",
        body,
      ].join("\r\n");
      request.write(wire);
      await entered;
      await headersReceived;
      const whileResponsePaused = await post(value.server, rpcBody("tools/list", {}, 601), { headers });
      assert.equal(whileResponsePaused.status, 503, "an unfinished response must retain its request slot");
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const afterDeadline = await post(value.server, rpcBody("tools/list", {}, 602), { headers });
      assert.equal(afterDeadline.status, 200, "deadline must destroy the stalled response and release its slot");
      assert.equal(await afterDeadline.json().then((body) => body.result.tools.length), 1);
      const responseHeaders = received.subarray(0, received.indexOf("\r\n\r\n")).toString("latin1");
      assert.match(responseHeaders, /^HTTP\/1\.1 200 /u);
    } finally {
      request?.destroy();
      await closeSetup(value);
    }
  });
});

test("request deadline and aborted clients cancel pending calls; server/session close releases requests", async () => {
  await withTempDirectory(async (directory) => {
    let enteredResolve;
    let abortedSignals = 0;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const value = await setup(directory, {
      limits: { requestTimeoutMs: 100, shutdownTimeoutMs: 100 },
      onToolCall: (_call, { signal }) => new Promise((_resolve, reject) => {
        enteredResolve();
        signal.addEventListener("abort", () => {
          abortedSignals += 1;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });
    try {
      const headers = await initialize(value.server);
      const timedOut = post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 2 } },
      }, 202), { headers });
      await entered;
      assert.equal((await (await timedOut).json()).error.code, -32001);
      assert.equal(abortedSignals, 1);
    } finally {
      await closeSetup(value);
    }
  });

  await withTempDirectory(async (directory) => {
    let enteredResolve;
    let firstAbortResolve;
    let secondAbortResolve;
    let abortCount = 0;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const firstAborted = new Promise((resolve) => { firstAbortResolve = resolve; });
    const secondAborted = new Promise((resolve) => { secondAbortResolve = resolve; });
    const value = await setup(directory, {
      limits: { requestTimeoutMs: 5_000, shutdownTimeoutMs: 100 },
      onToolCall: (_call, { signal }) => new Promise((_resolve, reject) => {
        enteredResolve();
        signal.addEventListener("abort", () => {
          abortCount += 1;
          if (abortCount === 1) firstAbortResolve();
          if (abortCount === 2) secondAbortResolve();
          reject(new Error("aborted"));
        }, { once: true });
      }),
    });
    try {
      const headers = await initialize(value.server);
      const controller = new AbortController();
      const request = post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 3 } },
      }, 203), { headers, signal: controller.signal });
      await entered;
      controller.abort();
      await assert.rejects(request, { name: "AbortError" });
      await Promise.race([firstAborted, new Promise((_, reject) => setTimeout(() => reject(new Error("handler not aborted")), 1_000))]);

      const secondEntered = new Promise((resolve) => { enteredResolve = resolve; });
      const pending = post(value.server, rpcBody("tools/call", {
        name: "lookup",
        arguments: { item: { quantity: 1 } },
      }, 204), { headers });
      await secondEntered;
      await value.session.close();
      await Promise.race([secondAborted, new Promise((_, reject) => setTimeout(() => reject(new Error("session close did not abort handler")), 1_000))]);
      await assert.rejects(pending);
      assert.equal(abortCount, 2);
      await assert.rejects(fetch(value.server.url, { method: "POST" }));
    } finally {
      await value.server.close();
      await value.engine.close();
    }
  });
});

test("parallel session endpoints are independently capability- and catalog-bound; SDK emits no token logs", async () => {
  await withTempDirectory(async (directory) => {
    const registry = await createProfileRegistry({
      storageDir: join(directory, "profiles"),
      environment: { PATH: "/safe/bin" },
    });
    const account = await registry.accounts.create();
    const engine = createProfileSessionEngine(registry.accounts, account.id, {
      workerManager: createProfileRuntimeManager(),
      driverFactory: () => ({ async dispatch() { throw new Error("unused"); }, async close() {} }),
    });
    const calls = [];
    let first;
    let second;
    const original = { log: console.log, warn: console.warn, error: console.error };
    const output = [];
    console.log = (...args) => output.push(args.join(" "));
    console.warn = (...args) => output.push(args.join(" "));
    console.error = (...args) => output.push(args.join(" "));
    try {
      const firstSession = await engine.create({ model: "test-model", cwd: directory, tools: toolCatalog() });
      const secondSession = await engine.create({ model: "test-model", cwd: directory, tools: toolCatalog() });
      first = await firstSession.tools.createMcpServer({
        onToolCall: async (call) => {
          calls.push({ which: "first", call });
          return { content: [{ type: "text", text: "first" }] };
        },
      });
      second = await secondSession.tools.createMcpServer({
        onToolCall: async (call) => {
          calls.push({ which: "second", call });
          return { content: [{ type: "text", text: "second" }] };
        },
      });
      assert.notEqual(first.headers.authorization, second.headers.authorization);
      assert.notEqual(first.sessionId, second.sessionId);
      assert.equal(first.catalogId, second.catalogId);

      const firstHeaders = await initialize(first);
      const secondHeaders = await initialize(second);
      const wrongCapability = await post(second, rpcBody("tools/list", {}), {
        headers: { ...secondHeaders, authorization: first.headers.authorization },
      });
      assert.equal(wrongCapability.status, 401);

      const firstResult = await post(first, rpcBody("tools/call", {
        name: "lookup", arguments: { item: { quantity: 2 } },
      }), { headers: firstHeaders });
      const secondResult = await post(second, rpcBody("tools/call", {
        name: "lookup", arguments: { item: { quantity: 3 } },
      }), { headers: secondHeaders });
      assert.equal((await firstResult.json()).result.content[0].text, "first");
      assert.equal((await secondResult.json()).result.content[0].text, "second");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].call.sessionId, first.sessionId);
      assert.equal(calls[1].call.sessionId, second.sessionId);
      assert.equal(calls[0].call.accountId, account.id);
      assert.equal(calls[0].call.catalogId, first.catalogId);
      assert.equal(JSON.stringify(calls).includes(first.headers.authorization), false);
      assert.equal(JSON.stringify(output).includes(first.headers.authorization), false);
      assert.equal(JSON.stringify(output).includes(second.headers.authorization), false);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      if (first) await first.close();
      if (second) await second.close();
      await engine.close();
    }
  });
});

test("empty catalogs and invalid limits do not start an endpoint", async () => {
  await withTempDirectory(async (directory) => {
    const value = await setup(directory, { tools: [], startServer: false });
    try {
      await assert.rejects(
        value.session.tools.createMcpServer({ onToolCall: async () => ({ content: [] }) }),
        InvalidRequestError,
      );
    } finally {
      await closeSetup(value);
    }
  });
});

test("profile runtime shutdown also closes the session's MCP endpoint", async () => {
  await withTempDirectory(async (directory) => {
    const value = await setup(directory);
    try {
      await initialize(value.server);
      const transition = await value.workerManager.closeProfile(value.account.context);
      await transition.release();
      await assert.rejects(fetch(value.server.url, { method: "POST" }));
    } finally {
      await closeSetup(value);
    }
  });
});
