import {
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";

const [stage, storageDir, accountId] = process.argv.slice(2);
const send = (message) => process.send(message);
const tools = [{
  name: "lookup",
  input_schema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
}];
const text = (value) => ({ type: "text", text: value });
let server;
let mcpHeaders;
let mcpCall;
let session;
let paused = false;

function holdForever() {
  return new Promise(() => {});
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("worker synchronization timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function postToolCall(key) {
  return fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      ...mcpHeaders,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "lookup", arguments: { key } },
    }),
  });
}

function toolAcknowledgement() {
  return {
    stage: "awaiting_tools",
    output: [{ role: "assistant", content: [{ type: "tool_use", id: "worker-id", name: "lookup", input: { key: "crash-key" } }] }],
    result: { stopReason: "tool_use" },
  };
}

function finalAcknowledgement() {
  return {
    stage: "completed",
    output: [{ role: "assistant", content: [text("continued")] }],
    result: { stopReason: "end_turn" },
  };
}

try {
  const registry = await createProfileRegistry({ storageDir, environment: { PATH: "/safe/bin" } });
  const manager = createProfileRuntimeManager();
  let engine;
  engine = createProfileSessionEngine(registry.accounts, accountId, {
    workerManager: manager,
    driverFactory() {
      return {
        capabilities: { maxTokens: "enforced" },
        async admitResponse(request) {
          return {
            kind: request.kind,
            operationId: request.operationId,
            accountId: request.accountId,
            sessionId: request.sessionId,
            maxTokens: request.maxTokens,
            policy: request.policy,
            outcome: "enforced",
            reason: "driver-admitted-requested-bound",
          };
        },
        async dispatch() {
          mcpCall = postToolCall("crash-key");
          void mcpCall.catch(() => undefined);
          await waitFor(async () => (await session.diagnostics.toolHandoffs()).length === 1);
          if (stage === "before-exposure") throw new Error("fake worker crash before acknowledgement");
          return toolAcknowledgement();
        },
        async continueTools() {
          if (stage === "after-delivery") {
            const response = await mcpCall;
            const rpc = await response.json();
            if (rpc.result?.content?.[0]?.text !== "result-value") throw new Error("MCP result was not delivered");
            send({ type: "checkpoint", state: "delivered" });
            return holdForever();
          }
          return finalAcknowledgement();
        },
        async close() {},
      };
    },
  });
  session = await engine.create({ model: "crash-test", cwd: storageDir, tools });
  server = await session.tools.createMcpServer();
  send({ type: "ready", server });
  const start = await new Promise((resolve) => process.once("message", resolve));
  if (start.type !== "start") throw new Error("unexpected parent command");
  mcpHeaders = start.mcpHeaders;

  if (stage === "after-save" || stage === "after-acknowledgement") {
    const original = session.mutateReceipts.bind(session);
    session.mutateReceipts = async (update) => {
      const result = await original(update);
      const receipt = (await session.diagnostics.toolHandoffs())[0];
      const expected = stage === "after-save" ? "saved" : "acknowledged";
      if (!paused && receipt?.resultState === expected) {
        paused = true;
        send({ type: "checkpoint", state: expected, receipt });
        await holdForever();
      }
      return result;
    };
  }

  try {
    const response = await session.messages.create({ max_tokens: 64, messages: [{ role: "user", content: "start" }] });
    send({ type: "exposed", response, sessionId: session.sessionId });
  } catch (error) {
    if (stage !== "before-exposure") throw error;
    const receipt = (await session.diagnostics.toolHandoffs())[0];
    send({ type: "checkpoint", state: "not_exposed", receipt });
    await holdForever();
  }

  if (stage === "after-exposure") await holdForever();
  const continuation = await new Promise((resolve) => process.once("message", resolve));
  if (continuation.type !== "continue" || typeof continuation.callId !== "string") {
    throw new Error("unexpected continuation command");
  }
  const transcript = [
    ...session.snapshot().transcript,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: continuation.callId, content: "result-value" }],
    },
  ];
  const responsePromise = session.messages.create({ max_tokens: 64, messages: transcript });
  if (stage === "after-acknowledgement") {
    await holdForever();
  }
  await responsePromise;
  send({ type: "completed" });
  await holdForever();
} catch (error) {
  try { send({ type: "error", message: error instanceof Error ? error.message : "unknown worker error" }); } catch {}
  await holdForever();
}
