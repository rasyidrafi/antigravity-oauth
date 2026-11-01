import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ServerResponse } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AntigravitySDK,
  AuthenticationError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  UnsupportedFeatureError,
} from "../dist/index.js";
import {
  createFakeAcpSessionDriverFactory,
  createFakeEnforcingAcpSessionDriverFactory,
} from "../dist/acp-session-driver.js";
import { messageMaxTokensEnforcement } from "../dist/messages.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const sleep = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function modelConfigOption(id, currentValue, values = ["model-a", "model-b"]) {
  return {
    id,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
    name: "Model",
    category: "model",
  };
}

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 1_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await sleep();
  }
}

async function withTempDirectory(fn) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-s11-2-"));
  try { await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

class FakeAcpChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  writes = [];
  responses = [];
  ended = false;
  spawnOptions;
  behavior;
  blockedWrites = [];

  constructor(spawnOptions, behavior = {}) {
    super();
    this.spawnOptions = spawnOptions;
    this.behavior = behavior;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
        this.writes.push(message);
        try { this.behavior.onRequest?.(message, this); }
        catch (error) { callback(error); return; }
        if (this.behavior.holdWrite?.(message)) {
          this.blockedWrites.push({ message, callback });
        } else {
          queueMicrotask(() => callback());
        }
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => this.exit(0));
      },
    });
  }

  reply(id, result, error) {
    this.responses.push(error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result });
    this.stdout.write(`${JSON.stringify(error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result })}\n`);
  }

  send(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }

  releaseWrite(method) {
    const index = this.blockedWrites.findIndex((entry) => entry.message.method === method);
    assert.notEqual(index, -1, `expected a blocked ${method} write`);
    const [{ callback }] = this.blockedWrites.splice(index, 1);
    callback();
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

function createAgentBehavior({
  modelValues = ["model-a", "model-b"],
  remoteIdPrefix = "remote-session-",
  initialize = {},
  session = {},
  configResponse,
  setError,
  useNotification = false,
  notificationModelValue,
  notificationConfigOptions,
  notificationSessionId,
  malformedNotification = false,
  updateAtSessionNew = false,
  authError,
  crashAt,
  browserBlockAt,
  requests = [],
} = {}) {
  let remoteSessionIndex = 0;
  return (message, child) => {
    requests.push(message);
    if (message.method === "initialize") {
      if (crashAt === "initialize") {
        child.exit(1);
        return;
      }
      child.reply(message.id, { protocolVersion: 1, agentCapabilities: {}, ...initialize });
      child.send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {} });
      child.send({ jsonrpc: "2.0", id: "unknown", method: "session/not-supported", params: {} });
      return;
    }
    if (message.method === "session/new") {
      if (browserBlockAt === "session/new") {
        child.stderr.write("credential-free marker test");
        child.stderr.write("AGY_INTERACTIVE_LOGIN_BLOCKED");
        return;
      }
      if (authError) {
        child.reply(message.id, undefined, {
          code: -32000,
          message: typeof authError === "string" ? authError : "Authentication required",
        });
        return;
      }
      if (crashAt === "session/new") {
        child.exit(1);
        return;
      }
      remoteSessionIndex += 1;
      const remoteSessionId = `${remoteIdPrefix}${remoteSessionIndex}`;
      child.reply(message.id, {
        sessionId: remoteSessionId,
        configOptions: session.configOptions ?? [{
          id: "model",
          category: "model",
          currentValue: "default",
          options: modelValues.map((value) => ({ value, name: value })),
        }],
        ...session,
      });
      if (updateAtSessionNew) {
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: remoteSessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: [modelConfigOption("model", "model-a", modelValues)],
            },
          },
        });
      }
      return;
    }
    if (message.method === "session/set_config_option") {
      if (setError) {
        child.reply(message.id, undefined, { code: -32001, message: "Configuration rejected" });
        return;
      }
      if (useNotification) {
        const configOptions = malformedNotification ? undefined : notificationConfigOptions ?? [
          modelConfigOption(message.params.configId, notificationModelValue ?? message.params.value, modelValues),
        ];
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: notificationSessionId ?? message.params.sessionId,
            update: {
              sessionUpdate: "config_option_update",
              ...(configOptions === undefined ? {} : { configOptions }),
            },
          },
        });
        if (child.ended) return;
        child.reply(message.id, configResponse ?? {});
      } else {
        child.reply(message.id, configResponse ?? {
          configOptions: [{ id: message.params.configId, currentValue: message.params.value }],
        });
      }
    }
  };
}

function createSdk(root, { behavior, onChildren, model = "model-a", tools, sdkOptions = {}, wrapDriver } = {}) {
  const children = onChildren ?? [];
  const requests = [];
  const behaviorForChild = typeof behavior === "function" ? behavior : () => createAgentBehavior({ ...behavior, requests });
  const processFactory = (_executable, _args, spawnOptions) => {
    const child = new FakeAcpChild(spawnOptions, { onRequest: behaviorForChild(childIndex++, requests) });
    children.push(child);
    return child;
  };
  let childIndex = 0;
  const baseFactory = createFakeAcpSessionDriverFactory({
    executable: "/fake/agy-acp",
    args: ["--stdio"],
    processFactory,
    modelConfirmationTimeoutMs: 30,
  });
  const drivers = [];
  const factory = async (context) => {
    const driver = await baseFactory(context);
    drivers.push(driver);
    return wrapDriver ? wrapDriver(driver, context) : driver;
  };
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/fake/agy-acp",
    environment: { PATH: "/safe/bin", GOOGLE_API_KEY: "ignored", HOME: "/ignored" },
    sessionDriverFactory: factory,
    ...sdkOptions,
  });
  return { sdk, children, requests, model, tools, drivers };
}

function createPromptSdk(root, {
  onPrompt = (_message, child) => {
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "remote-prompt-0-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pump answer" } },
      },
    });
    child.reply(_message.id, { stopReason: "end_turn" });
  },
  onSessionNew,
  onCancel = () => {},
  enforceMaxTokens = () => true,
  permissions,
  holdWrite,
  wrapDriver,
  onChildren,
  authProcessFactory,
} = {}) {
  const children = onChildren ?? [];
  const requests = [];
  const promptRequests = [];
  const admissionRequests = [];
  let childIndex = 0;
  const baseFactory = createFakeEnforcingAcpSessionDriverFactory({
    executable: "/fake/agy-acp",
    args: ["--stdio"],
    modelConfirmationTimeoutMs: 100,
    enforceMaxTokens: async (request) => {
      admissionRequests.push(request);
      return enforceMaxTokens(request);
    },
    ...(permissions === undefined ? {} : { permissions }),
    processFactory: (_executable, _args, spawnOptions) => {
      const index = childIndex++;
      const startup = createAgentBehavior({ remoteIdPrefix: `remote-prompt-${index}-`, requests });
      const child = new FakeAcpChild(spawnOptions, {
        holdWrite,
        onRequest(message, current) {
          if (message.method === "session/prompt") {
            requests.push(message);
            promptRequests.push(message);
            onPrompt(message, current, index);
            return;
          }
          if (message.method === "session/new" && onSessionNew) {
            onSessionNew(message, current, index, startup);
            return;
          }
          if (message.method === "session/cancel") {
            requests.push(message);
            onCancel(message, current, index);
            return;
          }
          startup(message, current);
        },
      });
      children.push(child);
      return child;
    },
  });
  const drivers = [];
  const factory = async (context) => {
    const driver = await baseFactory(context);
    drivers.push(driver);
    return wrapDriver ? wrapDriver(driver, context) : driver;
  };
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/fake/agy-acp",
    environment: { PATH: "/safe/bin", GOOGLE_API_KEY: "ignored", HOME: "/ignored" },
    sessionDriverFactory: factory,
    ...(authProcessFactory === undefined ? {} : { processFactory: authProcessFactory }),
  });
  return { sdk, children, requests, promptRequests, admissionRequests, drivers };
}

function sendPromptText(child, sessionId, text, metadata = {}) {
  const {
    paramsMeta,
    updateMeta,
    contentMeta,
    annotations,
    messageId,
  } = metadata;
  child.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      ...(paramsMeta === undefined ? {} : { _meta: paramsMeta }),
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(messageId === undefined ? {} : { messageId }),
        ...(updateMeta === undefined ? {} : { _meta: updateMeta }),
        content: {
          type: "text",
          text,
          ...(annotations === undefined ? {} : { annotations }),
          ...(contentMeta === undefined ? {} : { _meta: contentMeta }),
        },
      },
    },
  });
}

function sendSessionUpdate(child, sessionId, update) {
  if (child.ended) return;
  child.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function availableCommandsUpdate(secret = "discard-me") {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [{
      name: "safe-command-name",
      description: secret,
      input: { hint: `${secret}-hint`, _meta: { private: secret } },
      _meta: { private: secret },
    }],
    _meta: { private: secret },
  };
}

function usageUpdate(secret = "discard-me") {
  return {
    sessionUpdate: "usage_update",
    used: 1_536,
    size: 8_192,
    cost: { amount: 0.25, currency: "USD", _meta: { private: secret } },
    _meta: { private: secret },
  };
}

function pinnedConfigOptionUpdate(model = "model-a") {
  const selector = modelConfigOption("model", model);
  return {
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        ...selector,
        description: null,
        _meta: null,
        options: selector.options.map((option) => ({ ...option, description: null, _meta: null })),
      },
      {
        id: "reasoning",
        type: "select",
        currentValue: "deep",
        options: [{
          group: "quality",
          name: "Quality",
          options: [{ value: "deep", name: "Deep", description: null, _meta: null }],
          _meta: null,
        }],
        name: "Reasoning",
        description: null,
        category: "thought_level",
        _meta: null,
      },
      {
        id: "enabled",
        type: "boolean",
        currentValue: false,
        name: "Enabled",
        description: null,
        category: null,
        _meta: null,
      },
    ],
    _meta: null,
  };
}

function nonOutputSessionUpdates() {
  return [
    availableCommandsUpdate("observational-command"),
    usageUpdate("observational-usage"),
    { sessionUpdate: "available_commands_update", availableCommands: [{
      name: "nullable-command-input", description: "bounded command metadata", input: null, _meta: null,
    }], _meta: null },
    { sessionUpdate: "usage_update", used: 0, size: 1, cost: null, _meta: null },
    { sessionUpdate: "usage_update", used: 0, size: 1 },
    { sessionUpdate: "plan", entries: [{
      content: "progress only", priority: "medium", status: "in_progress", _meta: null,
    }], _meta: null },
    { sessionUpdate: "plan_update", plan: {
      type: "items", planId: "plan-1", entries: [], _meta: null,
    }, _meta: null },
    { sessionUpdate: "plan_update", plan: {
      type: "file", planId: "plan-1", uri: "file:///workspace/plan.md", _meta: null,
    } },
    { sessionUpdate: "plan_update", plan: {
      type: "markdown", planId: "plan-1", content: "progress only", _meta: null,
    } },
    { sessionUpdate: "plan_removed", planId: "plan-1", _meta: null },
    { sessionUpdate: "current_mode_update", currentModeId: "safe-mode", _meta: null },
    { sessionUpdate: "session_info_update", title: null, updatedAt: null, _meta: null },
    { sessionUpdate: "session_info_update" },
    pinnedConfigOptionUpdate(),
  ];
}

const callerTools = [{
  name: "lookup",
  input_schema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
}];

function mcpServerFromChild(child) {
  const request = child.writes.find(({ method }) => method === "session/new");
  const server = request?.params?.mcpServers?.[0];
  assert.ok(server, "ACP session/new must contain the session-bound MCP server");
  return server;
}

async function initializeFakeMcp(server) {
  const headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
  const send = async (body, extraHeaders = {}, signal) => fetch(server.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const initialized = await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-acp", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  const mcpSessionId = initialized.headers.get("mcp-session-id");
  assert.ok(mcpSessionId);
  const sessionHeaders = { "mcp-session-id": mcpSessionId, "mcp-protocol-version": "2025-06-18" };
  const ready = await send({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
  assert.equal(ready.status, 202);
  return {
    async call(key, id, signal) {
      const response = await send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "lookup", arguments: { key } },
      }, sessionHeaders, signal);
      const text = await response.text();
      return { status: response.status, body: text.length ? JSON.parse(text) : undefined };
    },
  };
}

const permissionOptions = () => [
  { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "offered-allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
];

function permissionParams(sessionId, {
  server = "antigravity-sdk-session-tools",
  tool = "lookup",
  title = "MCP call",
  kind = "other",
  options = permissionOptions(),
  metadata = true,
} = {}) {
  return {
    sessionId,
    toolCall: {
      toolCallId: "acp-tool-call-1",
      title,
      kind,
      ...(metadata ? { _meta: { mcp: { server, tool } } } : {}),
    },
    options,
  };
}

function sendPermissionRequest(child, id, params) {
  child.send({ jsonrpc: "2.0", id, method: "session/request_permission", params });
}

async function waitForAcpResponse(child, id) {
  await waitFor(() => child.writes.some((message) => message.id === id &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))), `ACP request ${String(id)} was not answered`);
  return child.writes.find((message) => message.id === id &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")));
}

function toolResult(toolUse, value, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: value,
    ...(isError ? { is_error: true } : {}),
  };
}

function assistantContentFromStream(events) {
  const blocks = [];
  const byIndex = new Map();
  for (const event of events) {
    if (event.type === "content_block_start") {
      const block = event.content_block.type === "text"
        ? { type: "text", text: event.content_block.text }
        : { type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: {}, json: "" };
      byIndex.set(event.index, block);
      blocks[event.index] = block;
    } else if (event.type === "content_block_delta") {
      const block = byIndex.get(event.index);
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      else if (event.delta.type === "input_json_delta") block.json += event.delta.partial_json;
    }
  }
  return blocks.map((block) => {
    if (block.type !== "tool_use") return block;
    const { json, ...toolUse } = block;
    return { ...toolUse, input: JSON.parse(json || "{}") };
  });
}

test("default SDK session factory rejects an unreviewed ACP pair before spawning", async () => {
  await withTempDirectory(async (root) => {
    let spawns = 0;
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      processFactory() { spawns += 1; throw new Error("not expected"); },
    });
    const account = await sdk.accounts.create();
    await assert.rejects(
      account.sessions.create({ model: "model-a", cwd: "/workspace" }),
      (error) => error instanceof UnsupportedFeatureError && /reviewed Antigravity/u.test(error.message),
    );
    await assert.rejects(
      account.sessions.create({ model: "model-a", cwd: "/workspace", tools: [{ name: "lookup", input_schema: { type: "object" } }] }),
      UnsupportedFeatureError,
    );
    assert.equal(spawns, 0);
    await sdk.close();
  });
});

test("explicit caller approval selects the exact offered one-shot option without relying on metadata", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const contexts = [];
    const extraOptions = [
      { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "offered-second-allow-once", name: "Allow this one operation", kind: "allow_once" },
      { optionId: "offered-allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
    ];
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          contexts.push(context);
          const oneShotAllows = context.offeredOptions.filter(({ kind }) => kind === "allow_once");
          return { action: "select", optionId: oneShotAllows.at(-1).optionId };
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "before permission");
          sendPermissionRequest(child, "permission-owned", permissionParams(message.params.sessionId, {
            title: "Not an authority signal",
            metadata: false,
            options: extraOptions,
          }));
          state.ownedPermission = (await waitForAcpResponse(child, "permission-owned")).result.outcome;

          const callerWaiter = mcp.call("caller-owned", 941);
          sendPromptText(child, message.params.sessionId, "after permission");
          state.callerResult = await callerWaiter;
          sendPromptText(child, message.params.sessionId, "after caller result");
          child.reply(message.id, { stopReason: "end_turn" });

          // A terminal response closes the live-turn window, even if the
          // process sends another permission request immediately afterward.
          sendPermissionRequest(child, "permission-after-turn", permissionParams(message.params.sessionId));
          state.afterTurnPermission = await waitForAcpResponse(child, "permission-after-turn");
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const user = { role: "user", content: "run the owned caller tool" };
      const initial = await session.messages.create({ max_tokens: 29, messages: [user] });
      const toolUse = initial.content.find((block) => block.type === "tool_use");
      assert.ok(toolUse);
      assert.deepEqual(state.ownedPermission, { outcome: "selected", optionId: "offered-second-allow-once" });
      assert.equal(contexts[0].accountId, session.accountId);
      assert.equal(contexts[0].sessionId, session.sessionId);
      assert.match(contexts[0].operationId, /^op_[0-9a-f-]{36}$/u);
      assert.equal(contexts[0].remoteSessionId, "remote-prompt-0-1");
      assert.equal(contexts[0].requestId, "permission-owned");
      assert.equal(contexts[0].toolCallId, "acp-tool-call-1");
      assert.equal(contexts[0].origin, "unverified");
      assert.equal(contexts[0].details.title, "Not an authority signal");
      assert.equal(contexts[0].details.redacted, false);
      assert.equal(Object.isFrozen(contexts[0]), true);
      assert.equal(Object.isFrozen(contexts[0].details), true);
      assert.equal(Object.isFrozen(contexts[0].offeredOptions), true);
      assert.equal(Object.isFrozen(contexts[0].offeredOptions[0]), true);
      assert.equal(contexts[0].offeredOptions.some(({ optionId }) => optionId === "offered-allow-always"), true);

      // A current ACP request can still be explicitly approved while the
      // same prompt is parked awaiting the caller's full result batch.
      sendPermissionRequest(fixture.children[0], "permission-parked", permissionParams("remote-prompt-0-1"));
      const parkedPermission = await waitForAcpResponse(fixture.children[0], "permission-parked");
      assert.deepEqual(parkedPermission.result.outcome, {
        outcome: "selected",
        optionId: "offered-allow-once",
      });

      const completed = await session.messages.create({
        max_tokens: 31,
        messages: [user, { role: "assistant", content: initial.content }, {
          role: "user", content: [toolResult(toolUse, "only the owning session")],
        }],
      });
      assert.deepEqual(completed.content, [{ type: "text", text: "after caller result" }]);
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(state.callerResult.body.result.content, [{ type: "text", text: "only the owning session" }]);
      assert.deepEqual(state.afterTurnPermission.result.outcome, {
        outcome: "selected",
        optionId: "offered-reject-once",
      });
      assert.equal(contexts.length, 2, "startup and post-terminal requests never invoke the callback");

      const startupPermission = await waitForAcpResponse(fixture.children[0], "permission");
      assert.deepEqual(startupPermission.result.outcome, { outcome: "cancelled" });
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 0);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("the default automatic policy repeatedly prefers allow_always and falls back only to offered one-shot allows", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const onlyAlways = [
      { optionId: "auto-once-first", name: "Allow once", kind: "allow_once" },
      { optionId: "auto-always-first", name: "Always allow", kind: "allow_always" },
      { optionId: "auto-always-second", name: "Also always allow", kind: "allow_always" },
      { optionId: "auto-reject", name: "Reject once", kind: "reject_once" },
    ];
    const fallbackOnce = [
      { optionId: "fallback-once-first", name: "Allow once", kind: "allow_once" },
      { optionId: "fallback-once-second", name: "Allow once", kind: "allow_once" },
      { optionId: "fallback-reject", name: "Reject once", kind: "reject_once" },
    ];
    const noAllow = [
      { optionId: "no-allow-reject", name: "Reject once", kind: "reject_once" },
      { optionId: "never-reject-always", name: "Always reject", kind: "reject_always" },
    ];
    const rejectAlwaysOnly = [
      { optionId: "reject-always-only", name: "Always reject", kind: "reject_always" },
    ];
    const duplicateOptions = [
      { optionId: "duplicate-option", name: "Allow always", kind: "allow_always" },
      { optionId: "duplicate-option", name: "Reject once", kind: "reject_once" },
    ];
    const cases = [
      ["auto-always-one", onlyAlways, "auto-always-first"],
      ["auto-always-repeat", onlyAlways, "auto-always-first"],
      ["auto-once-fallback", fallbackOnce, "fallback-once-first"],
      ["auto-without-mcp-marker", onlyAlways, "auto-always-first", false],
      ["auto-no-allow", noAllow, "no-allow-reject"],
      ["auto-reject-always-only", rejectAlwaysOnly, undefined],
      ["auto-malformed-duplicate", duplicateOptions, undefined],
    ];
    const fixture = createPromptSdk(root, {
      // Omitting permissions exercises the public SDK's built-in auto default.
      onPrompt(message, child) {
        state.agentTask = (async () => {
          sendPermissionRequest(child, "auto-foreign-session", permissionParams("foreign-remote-session"));
          state.responses = {
            "auto-foreign-session": await waitForAcpResponse(child, "auto-foreign-session"),
          };
          for (const [id, options, _expectedOptionId, metadata = true] of cases) {
            sendPermissionRequest(child, id, permissionParams(message.params.sessionId, { options, metadata }));
            state.responses ??= {};
            state.responses[id] = await waitForAcpResponse(child, id);
          }
          sendPromptText(child, message.params.sessionId, "automatic decision complete");
          child.reply(message.id, { stopReason: "end_turn" });
          sendPermissionRequest(child, "auto-after-terminal", permissionParams(message.params.sessionId));
          state.responses["auto-after-terminal"] = await waitForAcpResponse(child, "auto-after-terminal");
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/automatic-permissions" });
    try {
      const response = await session.messages.create({
        max_tokens: 10,
        messages: [{ role: "user", content: "exercise automatic permission policy" }],
      });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      for (const [id, _options, expectedOptionId] of cases) {
        assert.deepEqual(state.responses[id].result.outcome, expectedOptionId
          ? { outcome: "selected", optionId: expectedOptionId }
          : { outcome: "cancelled" }, id);
      }
      assert.deepEqual(state.responses["auto-foreign-session"].result.outcome, {
        outcome: "selected", optionId: "offered-reject-once",
      });
      assert.deepEqual(state.responses["auto-after-terminal"].result.outcome, {
        outcome: "selected", optionId: "offered-reject-once",
      });
      assert.deepEqual(response.content, [{ type: "text", text: "automatic decision complete" }]);
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("MCP permission metadata is bounded opaque syntax and never creates caller-tool authority", async (t) => {
  const cases = [
    ["official full shape at the identifier byte limit", { server: "s".repeat(512), tool: "t".repeat(512) }, true],
    ["previous server-only shape remains accepted", { server: "legacy-server-only" }, true],
    ["forged opaque identifiers and spoofed title remain non-authoritative", {
      server: "not-the-bound-server", tool: "not-the-caller-tool",
    }, true, "Run trusted MCP lookup"],
    ["oversized server identifier", { server: "s".repeat(513), tool: "lookup" }, false],
    ["oversized tool identifier", { server: "server", tool: "t".repeat(513) }, false],
    ["empty MCP identifier", { server: "server", tool: "" }, false],
    ["missing server identifier", { tool: "lookup" }, false],
    ["unexpected MCP metadata field", { server: "server", tool: "lookup", verified: true }, false],
    ["non-string MCP tool identifier", { server: "server", tool: 7 }, false],
  ];
  await withTempDirectory(async (root) => {
    const state = {};
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        state.agentTask = (async () => {
          state.responses = {};
          for (const [name, mcp, _accepted, title] of cases) {
            const params = permissionParams(message.params.sessionId, {
              title: title ?? "MCP call",
              options: [
                { optionId: "opaque-allow-always", name: "Always allow", kind: "allow_always" },
                { optionId: "opaque-allow-once", name: "Allow once", kind: "allow_once" },
              ],
            });
            params.toolCall._meta = { mcp };
            sendPermissionRequest(child, name, params);
            state.responses[name] = await waitForAcpResponse(child, name);
          }
          sendPromptText(child, message.params.sessionId, "metadata did not call a tool");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a", cwd: "/workspace/opaque-permission-metadata", tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const response = await session.messages.create({
        max_tokens: 10,
        messages: [{ role: "user", content: "inspect opaque permission metadata" }],
      });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(response.content, [{ type: "text", text: "metadata did not call a tool" }]);
      for (const [name, _mcp, accepted] of cases) {
        assert.deepEqual(state.responses[name].result.outcome, accepted
          ? { outcome: "selected", optionId: "opaque-allow-always" }
          : { outcome: "cancelled" }, name);
      }
      assert.deepEqual(await session.diagnostics.toolHandoffs(), [],
        "permission metadata, including a forged server/tool/title claim, cannot mint an SDK caller-tool receipt");
      assert.equal(fixture.children[0].writes.some(({ method }) => method === "session/prompt"), true);
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("explicit deny policy rejects an offered one-shot option without invoking a caller callback", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: { mode: "deny" },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          sendPermissionRequest(child, "explicit-deny", permissionParams(message.params.sessionId));
          state.permission = await waitForAcpResponse(child, "explicit-deny");
          sendPromptText(child, message.params.sessionId, "explicit denial complete");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/explicit-permission-denial" });
    try {
      const response = await session.messages.create({
        max_tokens: 10,
        messages: [{ role: "user", content: "deny permission explicitly" }],
      });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(state.permission.result.outcome, {
        outcome: "selected",
        optionId: "offered-reject-once",
      });
      assert.deepEqual(response.content, [{ type: "text", text: "explicit denial complete" }]);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("explicit deny policy rejects foreign, malformed, spoofed-title, filesystem, terminal, and unknown requests", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: { mode: "deny" },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const cases = [
            ["permission-wrong-session", permissionParams("foreign-remote-session")],
            ["permission-foreign-server", permissionParams(message.params.sessionId, { server: "other-mcp" })],
            ["permission-title-spoof", permissionParams(message.params.sessionId, {
              title: "Run call_mcp_tool?", metadata: false,
            })],
            ["permission-marked-title-spoof", permissionParams(message.params.sessionId, {
              title: "Run call_mcp_tool?", kind: "other",
            })],
            ["permission-marked-read", permissionParams(message.params.sessionId, { kind: "read" })],
            ["permission-marked-execute", permissionParams(message.params.sessionId, { kind: "execute" })],
            ["permission-filesystem", permissionParams(message.params.sessionId, {
              title: "Read a local file", kind: "read", metadata: false,
            })],
            ["permission-terminal", permissionParams(message.params.sessionId, {
              title: "Run a terminal command", kind: "execute", metadata: false,
            })],
            ["permission-malformed-option", permissionParams(message.params.sessionId, {
              options: [{ optionId: 42, name: "Allow once", kind: "allow_once" }],
            })],
          ];
          state.denials = {};
          for (const [id, params] of cases) {
            sendPermissionRequest(child, id, params);
            state.denials[id] = await waitForAcpResponse(child, id);
          }
          for (const [id, method, params] of [
            ["unknown-rpc", "session/not-supported", {}],
            ["filesystem-rpc", "fs/read_text_file", { sessionId: message.params.sessionId, path: "/etc/passwd" }],
            ["terminal-rpc", "terminal/create", { sessionId: message.params.sessionId, command: "id" }],
          ]) {
            child.send({ jsonrpc: "2.0", id, method, params });
            state.denials[id] = await waitForAcpResponse(child, id);
          }
          sendPromptText(child, message.params.sessionId, "safe response");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-denial", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const response = await session.messages.create({ max_tokens: 37, messages: [{ role: "user", content: "deny unsafe permissions" }] });
      assert.deepEqual(response.content, [{ type: "text", text: "safe response" }]);
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      for (const id of [
        "permission-wrong-session", "permission-foreign-server", "permission-title-spoof",
        "permission-marked-title-spoof", "permission-marked-read", "permission-marked-execute",
        "permission-filesystem", "permission-terminal",
      ]) {
        assert.deepEqual(state.denials[id].result.outcome, {
          outcome: "selected",
          optionId: "offered-reject-once",
        }, id);
      }
      assert.deepEqual(state.denials["permission-malformed-option"].result.outcome, { outcome: "cancelled" });
      for (const id of ["unknown-rpc", "filesystem-rpc", "terminal-rpc"]) {
        assert.equal(state.denials[id].error.code, -32601, id);
      }
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 0);
      assert.deepEqual(await session.diagnostics.toolHandoffs(), [],
        "spoofed tool titles/metadata and permission outcomes cannot create a caller handoff without MCP tools/call");
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("permission decisions are exact, one-shot only, and malformed or duplicate offers fail closed", async () => {
  await withTempDirectory(async (root) => {
    const decisions = new Map([
      ["choose-always", { action: "select", optionId: "offered-always" }],
      ["choose-reject-once", { action: "select", optionId: "offered-reject-once" }],
      ["choose-reject-always", { action: "select", optionId: "offered-reject-always" }],
      ["choose-unknown", { action: "select", optionId: "not-offered" }],
      ["choose-deny", { action: "deny" }],
      ["choose-no-reject", { action: "deny" }],
    ]);
    const callbackIds = [];
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackIds.push(context.requestId);
          return decisions.get(context.requestId);
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const requests = [
            ["choose-always", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-always", name: "Always", kind: "allow_always" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
            ]],
            ["choose-reject-once", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
            ]],
            ["choose-reject-always", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
              { optionId: "offered-reject-always", name: "Always reject", kind: "reject_always" },
            ]],
            ["choose-unknown", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
            ]],
            ["choose-deny", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
            ]],
            ["choose-no-reject", [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
            ]],
            ["duplicate-options", [
              { optionId: "duplicate", name: "Allow once", kind: "allow_once" },
              { optionId: "duplicate", name: "Reject once", kind: "reject_once" },
            ]],
            ["x".repeat(513), [
              { optionId: "offered-allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "offered-reject-once", name: "Reject once", kind: "reject_once" },
            ]],
          ];
          state.responses = {};
          for (const [id, options] of requests) {
            sendPermissionRequest(child, id, permissionParams(message.params.sessionId, { options }));
            state.responses[id] = await waitForAcpResponse(child, id);
          }
          sendPromptText(child, message.params.sessionId, "safe");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-decisions" });
    try {
      const response = await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "decide" }] });
      assert.deepEqual(response.content, [{ type: "text", text: "safe" }]);
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      for (const id of ["choose-always", "choose-reject-once", "choose-reject-always", "choose-unknown", "choose-deny"]) {
        assert.deepEqual(state.responses[id].result.outcome, {
          outcome: "selected",
          optionId: "offered-reject-once",
        }, id);
      }
      assert.deepEqual(state.responses["choose-no-reject"].result.outcome, { outcome: "cancelled" });
      assert.deepEqual(state.responses["duplicate-options"].result.outcome, { outcome: "cancelled" });
      assert.deepEqual(state.responses["x".repeat(513)].result.outcome, { outcome: "cancelled" });
      assert.deepEqual(callbackIds, [
        "choose-always", "choose-reject-once", "choose-reject-always", "choose-unknown", "choose-deny", "choose-no-reject",
      ]);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("permission callback receives bounded redacted immutable context and no raw ACP payload", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          state.contexts ??= [];
          state.contexts.push(context);
          state.mutableDetails = Reflect.set(context.details, "name", "changed");
          state.mutableOption = Reflect.set(context.offeredOptions[0], "optionId", "changed");
          state.mutableRoot = Reflect.set(context, "origin", "trusted");
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const params = permissionParams(message.params.sessionId, {
            metadata: true,
            title: "Open https://private.example/path?access_token=do-not-disclose",
          });
          params.toolCall.name = "n".repeat(500);
          params.toolCall.status = "pending";
          params.toolCall.rawInput = { api_key: "secret raw input" };
          params.toolCall.rawOutput = { bearer: "secret raw output" };
          sendPermissionRequest(child, "permission-sanitize", params);
          state.permission = await waitForAcpResponse(child, "permission-sanitize");
          sendPermissionRequest(child, "permission-token-redaction", permissionParams(message.params.sessionId, {
            title: `Opaque SDK value ${"A".repeat(43)}`,
            metadata: false,
          }));
          state.tokenPermission = await waitForAcpResponse(child, "permission-token-redaction");
          sendPromptText(child, message.params.sessionId, "safe");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-details" });
    try {
      await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "inspect safely" }] });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(state.permission.result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      assert.deepEqual(state.tokenPermission.result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      const context = state.contexts[0];
      assert.equal(context.details.title, "[redacted]");
      assert.equal(context.details.handling, "redacted");
      assert.equal(context.details.redacted, true);
      assert.equal(context.details.truncated, true);
      assert.equal(Buffer.byteLength(context.details.name, "utf8"), 256);
      assert.equal(context.details.status, "pending");
      assert.equal(context.details.kind, "other");
      assert.equal(Object.hasOwn(context, "rawInput"), false);
      assert.equal(Object.hasOwn(context, "rawOutput"), false);
      assert.equal(Object.hasOwn(context, "_meta"), false);
      assert.equal(JSON.stringify(context).includes("opaque-unverified-marker"), false);
      assert.equal(JSON.stringify(context).includes('"tool":"lookup"'), false,
        "neither MCP metadata identifier is projected to the caller callback");
      assert.equal(JSON.stringify(context).includes("private.example"), false);
      assert.equal(JSON.stringify(context).includes("do-not-disclose"), false);
      assert.equal(state.contexts[1].details.title, "[redacted]");
      assert.equal(state.contexts[1].details.redacted, true);
      assert.equal(state.mutableDetails, false);
      assert.equal(state.mutableOption, false);
      assert.equal(state.mutableRoot, false);
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.offeredOptions), true);
      assert.equal(Object.isFrozen(context.offeredOptions[0]), true);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("known bound MCP endpoint secrets are redacted exactly before the detail bound", async () => {
  await withTempDirectory(async (root) => {
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          state.context = context;
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const server = mcpServerFromChild(child);
          const authorization = server.headers.find(({ name }) => name === "authorization").value;
          const token = authorization.slice("Bearer ".length);
          const params = permissionParams(message.params.sessionId, { metadata: false });
          params.toolCall.title = `${"x".repeat(240)}${token} suffix beyond the bounded detail`;
          params.toolCall.name = `Use the MCP endpoint Authorization: ${authorization} only for this operation`;
          sendPermissionRequest(child, "bound-endpoint-secret", params);
          state.permission = await waitForAcpResponse(child, "bound-endpoint-secret");
          sendPromptText(child, message.params.sessionId, "redacted safely");
          child.reply(message.id, { stopReason: "end_turn" });
          state.token = token;
          state.authorization = authorization;
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/permission-bound-secret",
      tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const response = await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "inspect endpoint use" }] });
      await state.agentTask;
      assert.deepEqual(response.content, [{ type: "text", text: "redacted safely" }]);
      assert.equal(state.agentError, undefined);
      assert.deepEqual(state.permission.result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      assert.equal(state.context.details.title, `${"x".repeat(240)}[redacted] suffi`);
      assert.equal(state.context.details.name, "Use the MCP endpoint Authorization: [redacted] only for this operation");
      assert.equal(state.context.details.redacted, true);
      assert.equal(state.context.details.truncated, true);
      const serialized = JSON.stringify(state.context);
      assert.equal(serialized.includes(state.token), false);
      assert.equal(serialized.includes(state.authorization), false);
      assert.equal(serialized.includes(`Bearer ${state.token}`), false);
      assert.equal(state.context.details.name.includes("MCP endpoint"), true, "non-secret detail remains useful");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("foreign, startup, and post-terminal permission requests never invoke the caller callback", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          contexts.push(context);
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          sendPermissionRequest(child, "foreign-request", permissionParams("another-remote-session"));
          state.foreign = await waitForAcpResponse(child, "foreign-request");
          sendPermissionRequest(child, "current-request", permissionParams(message.params.sessionId, { metadata: false }));
          state.current = await waitForAcpResponse(child, "current-request");
          sendPromptText(child, message.params.sessionId, "done");
          child.reply(message.id, { stopReason: "end_turn" });
          sendPermissionRequest(child, "post-terminal", permissionParams(message.params.sessionId));
          state.postTerminal = await waitForAcpResponse(child, "post-terminal");
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
      onSessionNew(message, child, index, startup) {
        startup(message, child, index);
        sendPermissionRequest(child, "well-formed-startup", permissionParams(`remote-prompt-${index}-1`));
        state.startupValid = waitForAcpResponse(child, "well-formed-startup");
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-owner" });
    try {
      const response = await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "owner" }] });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(state.foreign.result.outcome, { outcome: "selected", optionId: "offered-reject-once" });
      assert.deepEqual(state.current.result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      assert.deepEqual(state.postTerminal.result.outcome, { outcome: "selected", optionId: "offered-reject-once" });
      assert.deepEqual((await state.startupValid).result.outcome, {
        outcome: "selected",
        optionId: "offered-reject-once",
      });
      assert.equal(contexts.length, 1);
      assert.equal(contexts[0].requestId, "current-request");
      assert.equal(contexts[0].sessionId, session.sessionId);
      assert.equal(contexts[0].remoteSessionId, "remote-prompt-0-1");
      assert.deepEqual(response.content, [{ type: "text", text: "done" }]);
      const startup = await waitForAcpResponse(fixture.children[0], "permission");
      assert.deepEqual(startup.result.outcome, { outcome: "cancelled" });
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("callback throw, rejection, invalid response, and timeout deny or cancel without unhandled rejection", async () => {
  await withTempDirectory(async (root) => {
    const timeoutWork = deferred();
    const contexts = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 20,
        onRequest(context) {
          contexts.push(context);
          if (context.requestId === "callback-throws") throw new Error("secret exception");
          if (context.requestId === "callback-rejects") return Promise.reject(new Error("secret rejection"));
          if (context.requestId === "callback-timeout") return timeoutWork.promise;
          return { action: "select", optionId: "not-offered" };
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          for (const id of ["callback-throws", "callback-rejects", "callback-invalid", "callback-timeout"]) {
            sendPermissionRequest(child, id, permissionParams(message.params.sessionId));
            state[id] = await waitForAcpResponse(child, id);
          }
          sendPromptText(child, message.params.sessionId, "handled");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-errors" });
    process.on("unhandledRejection", onUnhandled);
    try {
      await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "handle failures" }] });
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      for (const id of ["callback-throws", "callback-rejects", "callback-invalid"]) {
        assert.deepEqual(state[id].result.outcome, { outcome: "selected", optionId: "offered-reject-once" });
      }
      assert.deepEqual(state["callback-timeout"].result.outcome, { outcome: "cancelled" });
      assert.equal(contexts.find(({ requestId }) => requestId === "callback-timeout").signal.aborted, true);
      timeoutWork.resolve({ action: "select", optionId: "offered-allow-once" });
      await sleep(10);
      assert.deepEqual(unhandled, []);
    } finally {
      timeoutWork.resolve({ action: "deny" });
      await session.close();
      await fixture.sdk.close();
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

test("monotonic permission deadlines catch synchronous callback and decision-validation stalls", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const state = {};
    const blockFor = (milliseconds) => {
      const deadline = performance.now() + milliseconds;
      while (performance.now() < deadline) { /* deliberately exercise a non-preemptible synchronous handler */ }
    };
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 100,
        onRequest(context) {
          contexts.push(context);
          if (context.requestId === "fast-approval") {
            return { action: "select", optionId: "offered-allow-once" };
          }
          if (context.requestId === "sync-deadline") {
            const started = performance.now();
            blockFor(130);
            state.syncDuration = performance.now() - started;
            return { action: "select", optionId: "offered-allow-once" };
          }
          return new Proxy({ action: "select", optionId: "offered-allow-once" }, {
            ownKeys(target) {
              blockFor(130);
              return Reflect.ownKeys(target);
            },
          });
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          for (const id of ["fast-approval", "sync-deadline", "decision-validation-deadline"]) {
            sendPermissionRequest(child, id, permissionParams(message.params.sessionId));
            state[id] = await waitForAcpResponse(child, id);
          }
          sendPromptText(child, message.params.sessionId, "deadline enforced");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-deadline" });
    try {
      const response = await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "respect deadline" }] });
      await state.agentTask;
      assert.deepEqual(response.content, [{ type: "text", text: "deadline enforced" }]);
      assert.equal(state.agentError, undefined);
      assert.ok(state.syncDuration > 5, "the synchronous handler runs beyond a timer-sized deadline");
      assert.deepEqual(state["fast-approval"].result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      assert.deepEqual(state["sync-deadline"].result.outcome, { outcome: "cancelled" });
      assert.deepEqual(state["decision-validation-deadline"].result.outcome, { outcome: "cancelled" });
      assert.equal(contexts.length, 3);
      assert.equal(contexts.find(({ requestId }) => requestId === "fast-approval").signal.aborted, false);
      assert.ok(contexts.filter(({ requestId }) => requestId !== "fast-approval").every(({ signal }) => signal.aborted));
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("queued permission approvals are revalidated immediately before the ACP stdin write", async (t) => {
  const runCase = async (root, kind) => {
    let callbackContext;
    const state = {};
    const controller = new AbortController();
    const timeoutMs = kind === "timeout" ? 25 : 2_000;
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs,
        onRequest(context) {
          callbackContext = context;
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.prompt = message;
        sendPermissionRequest(child, `queued-${kind}`, permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: `/workspace/queued-${kind}` });
    try {
      const operation = session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: `queue approval ${kind}` }],
      }, { signal: controller.signal });
      const rejected = kind === "cancel" ? assert.rejects(operation, RequestAbortedError) : undefined;
      await waitFor(() => callbackContext && state.prompt);
      // Let the fulfilled callback flow through requestPermission and into the
      // transport FIFO while the prompt write remains backpressured.
      await new Promise((resolve) => setImmediate(resolve));
      const child = fixture.children[0];
      assert.equal(child.blockedWrites.some(({ message }) => message.method === "session/prompt"), true);
      assert.equal(child.writes.some((message) => message.id === `queued-${kind}` && message.result), false);

      if (kind === "cancel") {
        controller.abort();
      } else if (kind === "timeout") {
        await sleep(timeoutMs + 10);
      } else {
        sendPromptText(child, state.prompt.params.sessionId, "terminal before permission write");
        child.reply(state.prompt.id, { stopReason: "end_turn" });
        await operation;
      }

      child.releaseWrite("session/prompt");
      const response = await waitForAcpResponse(child, `queued-${kind}`);
      assert.deepEqual(response.result.outcome, { outcome: "cancelled" }, `${kind} must not commit the selected allow`);
      assert.equal(child.writes.filter((message) => message.id === `queued-${kind}`).length, 1,
        "one inbound permission request receives at most one response");
      if (kind === "cancel") await rejected;
      if (kind === "timeout") {
        assert.equal(callbackContext.signal.aborted, true, "the monotonic write-time deadline aborts the callback signal");
        sendPromptText(child, state.prompt.params.sessionId, "permission deadline handled");
        child.reply(state.prompt.id, { stopReason: "end_turn" });
        await operation;
      }
    } finally {
      controller.abort();
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  };

  await t.test("operation cancellation while queued", async () => {
    await withTempDirectory((root) => runCase(root, "cancel"));
  });
  await t.test("elapsed callback deadline while queued", async () => {
    await withTempDirectory((root) => runCase(root, "timeout"));
  });
  await t.test("terminal response while queued", async () => {
    await withTempDirectory((root) => runCase(root, "terminal"));
  });
});

test("automatic allow_always responses are guarded through queued cancellation, deadline, terminal, and close transitions", async (t) => {
  const runCase = async (root, kind) => {
    const controller = new AbortController();
    const timeoutMs = kind === "deadline" ? 25 : 2_000;
    const state = {};
    const id = `auto-queued-${kind}`;
    const fixture = createPromptSdk(root, {
      permissions: { mode: "auto", timeoutMs },
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.prompt = message;
        sendPermissionRequest(child, id, permissionParams(message.params.sessionId));
        state.agentTask = waitForAcpResponse(child, id).then((response) => {
          state.permission = response;
          if (kind === "deadline") {
            sendPromptText(child, message.params.sessionId, `auto ${kind} handled`);
            child.reply(message.id, { stopReason: "end_turn" });
          }
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: `/workspace/${id}` });
    try {
      const operation = session.messages.create({
        max_tokens: 10,
        messages: [{ role: "user", content: `queue automatic permission ${kind}` }],
      }, { signal: controller.signal });
      void operation.catch(() => undefined);
      await waitFor(() => state.prompt);
      await new Promise((resolve) => setImmediate(resolve));
      const child = fixture.children[0];
      assert.equal(child.blockedWrites.some(({ message }) => message.method === "session/prompt"), true);
      assert.equal(child.writes.some((message) => message.id === id && message.result), false,
        "the positive auto result must remain queued behind the blocked prompt write");

      if (kind === "cancel") {
        controller.abort();
        child.releaseWrite("session/prompt");
        await assert.rejects(operation, RequestAbortedError);
      } else if (kind === "deadline") {
        await sleep(timeoutMs + 15);
        child.releaseWrite("session/prompt");
        await waitFor(() => state.permission);
        assert.deepEqual(state.permission.result.outcome, { outcome: "cancelled" });
        await operation;
      } else if (kind === "terminal") {
        sendPromptText(child, state.prompt.params.sessionId, "terminal before automatic permission write");
        child.reply(state.prompt.id, { stopReason: "end_turn" });
        await operation;
        child.releaseWrite("session/prompt");
      } else {
        const closing = session.close();
        await waitFor(() => session.state === "closed");
        if (child.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
          child.releaseWrite("session/prompt");
        }
        await closing;
        await assert.rejects(operation, RequestAbortedError);
      }

      if (kind !== "close") {
        await waitFor(() => state.permission);
        assert.deepEqual(state.permission.result.outcome, { outcome: "cancelled" }, kind);
      }
      assert.equal(child.writes.some((message) => message.id === id &&
        message.result?.outcome?.outcome === "selected" &&
        message.result?.outcome?.optionId === "offered-allow-always"), false,
      `${kind} must never write the stale automatic allow`);
      assert.equal(child.writes.filter((message) => message.id === id).length <= 1, true,
        "an inbound permission request receives at most one response");
    } finally {
      controller.abort();
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  };

  for (const kind of ["cancel", "deadline", "terminal", "close"]) {
    await t.test(kind, async () => withTempDirectory((root) => runCase(root, kind)));
  }
});

test("queued permission responses retain independent IDs and FIFO ordering with strict unknown-method errors", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const controller = new AbortController();
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          contexts.push(context);
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.prompt = message;
        sendPermissionRequest(child, "independent-a", permissionParams(message.params.sessionId));
        sendPermissionRequest(child, 872, permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-fifo" });
    try {
      const operation = session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: "preserve correlated permission writes" }],
      }, { signal: controller.signal });
      void operation.catch(() => undefined);
      await waitFor(() => contexts.length === 2 && state.prompt);
      await new Promise((resolve) => setImmediate(resolve));
      fixture.children[0].send({
        jsonrpc: "2.0", id: "unknown-after-permissions", method: "session/not-supported", params: {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      const child = fixture.children[0];
      child.releaseWrite("session/prompt");
      const permissionA = await waitForAcpResponse(child, "independent-a");
      const permissionB = await waitForAcpResponse(child, 872);
      const unknown = await waitForAcpResponse(child, "unknown-after-permissions");
      assert.deepEqual(permissionA.result.outcome, { outcome: "cancelled" });
      assert.deepEqual(permissionB.result.outcome, { outcome: "cancelled" });
      assert.equal(unknown.error.code, -32601);
      const writtenResponses = child.writes.filter((message) => [
        "independent-a", 872, "unknown-after-permissions",
      ].some((id) => id === message.id));
      assert.deepEqual(writtenResponses.map(({ id }) => id), [
        "independent-a", 872, "unknown-after-permissions",
      ]);
      for (const id of ["independent-a", 872, "unknown-after-permissions"]) {
        assert.equal(child.writes.filter((message) => message.id === id).length, 1);
      }
      await assert.rejects(operation, RequestAbortedError);
    } finally {
      controller.abort();
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("a caller-tool continuation transition revokes an already-approved queued permission", async () => {
  await withTempDirectory(async (root) => {
    const callerResultsReady = deferred();
    const continueAgent = deferred();
    const state = {};
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPermissionRequest(child, "continuation-queued", permissionParams(message.params.sessionId, { metadata: false }));
          const callerWaiter = mcp.call("continuation-owned", 873);
          state.callerResult = await callerWaiter;
          callerResultsReady.resolve();
          await continueAgent.promise;
          sendPromptText(child, message.params.sessionId, "continued after permission cancellation");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a", cwd: "/workspace/permission-continuation", tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const user = { role: "user", content: "park a caller tool" };
      const initial = await session.messages.create({ max_tokens: 29, messages: [user] });
      const toolUse = initial.content.find((block) => block.type === "tool_use");
      assert.ok(toolUse);
      await waitFor(() => callbackContext);
      await new Promise((resolve) => setImmediate(resolve));

      const continuation = session.messages.create({
        max_tokens: 31,
        messages: [user, { role: "assistant", content: initial.content }, {
          role: "user", content: [toolResult(toolUse, "continued result")],
        }],
      });
      await callerResultsReady.promise;
      const child = fixture.children[0];
      child.releaseWrite("session/prompt");
      const permission = await waitForAcpResponse(child, "continuation-queued");
      assert.deepEqual(permission.result.outcome, { outcome: "cancelled" });
      assert.equal(child.writes.filter((message) => message.id === "continuation-queued").length, 1);
      continueAgent.resolve();
      const result = await continuation;
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(result.content, [{ type: "text", text: "continued after permission cancellation" }]);
      assert.deepEqual(state.callerResult.body.result.content, [{ type: "text", text: "continued result" }]);
    } finally {
      continueAgent.resolve();
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("automatic allow_always queued for one tool operation is cancelled when continuation takes ownership", async () => {
  await withTempDirectory(async (root) => {
    const callerResultsReady = deferred();
    const continueAgent = deferred();
    const state = {};
    const fixture = createPromptSdk(root, {
      // Omission deliberately exercises auto as the built-in default.
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPermissionRequest(child, "automatic-continuation-queued", permissionParams(message.params.sessionId));
          const callerWaiter = mcp.call("automatic-continuation-owned", 874);
          state.callerResult = await callerWaiter;
          callerResultsReady.resolve();
          await continueAgent.promise;
          sendPromptText(child, message.params.sessionId, "continued after automatic permission cancellation");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a", cwd: "/workspace/automatic-permission-continuation", tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const user = { role: "user", content: "park a caller tool and queue an automatic approval" };
      const initial = await session.messages.create({ max_tokens: 29, messages: [user] });
      const toolUse = initial.content.find((block) => block.type === "tool_use");
      assert.ok(toolUse);
      const child = fixture.children[0];
      await waitFor(() => child.blockedWrites.some(({ message }) => message.method === "session/prompt"));
      assert.equal(child.writes.some((message) => message.id === "automatic-continuation-queued" && message.result), false);

      const continuation = session.messages.create({
        max_tokens: 31,
        messages: [user, { role: "assistant", content: initial.content }, {
          role: "user", content: [toolResult(toolUse, "continued result")],
        }],
      });
      await callerResultsReady.promise;
      await new Promise((resolve) => setImmediate(resolve));
      child.releaseWrite("session/prompt");
      const permission = await waitForAcpResponse(child, "automatic-continuation-queued");
      assert.deepEqual(permission.result.outcome, { outcome: "cancelled" });
      continueAgent.resolve();
      const result = await continuation;
      await state.agentTask;
      assert.equal(state.agentError, undefined);
      assert.deepEqual(result.content, [{ type: "text", text: "continued after automatic permission cancellation" }]);
      assert.deepEqual(state.callerResult.body.result.content, [{ type: "text", text: "continued result" }]);
      assert.equal(child.writes.some((message) => message.id === "automatic-continuation-queued" &&
        message.result?.outcome?.outcome === "selected" &&
        message.result?.outcome?.optionId === "offered-allow-always"), false);
    } finally {
      continueAgent.resolve();
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("session close, account logout, and SDK shutdown revoke queued permission approvals within bounds", async (t) => {
  const runCase = async (root, action) => {
    let callbackContext;
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 2_000,
        onRequest(context) {
          callbackContext = context;
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      holdWrite: (message) => message.method === "session/prompt",
      onPrompt(message, child) {
        state.prompt = message;
        sendPermissionRequest(child, `shutdown-${action}`, permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: `/workspace/shutdown-${action}` });
    try {
      const operation = session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: `shutdown ${action} with a permission queued` }],
      });
      void operation.catch(() => undefined);
      await waitFor(() => callbackContext && state.prompt);
      await new Promise((resolve) => setImmediate(resolve));
      const child = fixture.children[0];
      assert.equal(child.blockedWrites.some(({ message }) => message.method === "session/prompt"), true);

      const started = performance.now();
      const closing = action === "session-close"
        ? session.close()
        : action === "logout"
          ? account.auth.logout()
          : fixture.sdk.close();
      await waitFor(() => session.state === "closed", `${action} did not revoke the session owner`);
      if (child.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        child.releaseWrite("session/prompt");
      }
      await closing;
      await assert.rejects(operation, RequestAbortedError);
      assert.ok(performance.now() - started < 1_000, `${action} cleanup must remain bounded`);
      const responses = child.writes.filter((message) => message.id === `shutdown-${action}`);
      assert.equal(responses.length, 1, "the writable transport should send one correlated fail-closed response");
      assert.equal(responses.some((message) =>
        message.result?.outcome?.outcome === "selected" && message.result?.outcome?.optionId === "offered-allow-once"), false,
      `${action} must never write the stale allow`);
      if (responses.length === 1) {
        assert.deepEqual(responses[0].result.outcome, { outcome: "cancelled" });
      }
    } finally {
      if (fixture.children[0]?.blockedWrites.some(({ message }) => message.method === "session/prompt")) {
        fixture.children[0].releaseWrite("session/prompt");
      }
      await session.close();
      await fixture.sdk.close();
    }
  };

  await t.test("session close", async () => withTempDirectory((root) => runCase(root, "session-close")));
  await t.test("account logout", async () => withTempDirectory((root) => runCase(root, "logout")));
  await t.test("SDK close", async () => withTempDirectory((root) => runCase(root, "sdk-close")));
});

test("late permission rejection after cancellation is observed without an unhandled rejection", async () => {
  await withTempDirectory(async (root) => {
    const controller = new AbortController();
    const lateDecision = deferred();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 2_000,
        onRequest(context) {
          callbackContext = context;
          return lateDecision.promise;
        },
      },
      onPrompt(message, child) {
        sendPermissionRequest(child, "late-rejection", permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-late-rejection" });
    process.on("unhandledRejection", onUnhandled);
    try {
      const operation = session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: "cancel before callback settles" }],
      }, { signal: controller.signal });
      const rejected = assert.rejects(operation, RequestAbortedError);
      await waitFor(() => callbackContext);
      controller.abort();
      const response = await waitForAcpResponse(fixture.children[0], "late-rejection");
      assert.deepEqual(response.result.outcome, { outcome: "cancelled" });
      lateDecision.reject(new Error("private callback rejection detail"));
      await rejected;
      await sleep(10);
      assert.deepEqual(unhandled, []);
      assert.equal(JSON.stringify(fixture.children[0].writes).includes("private callback rejection detail"), false);
    } finally {
      lateDecision.reject(new Error("cleanup rejection"));
      controller.abort();
      await session.close();
      await fixture.sdk.close();
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

test("cancellation after the stdin write boundary cannot retract an already-written permission result", async () => {
  await withTempDirectory(async (root) => {
    const controller = new AbortController();
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      onPrompt(message, child) {
        sendPermissionRequest(child, "already-written", permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-after-write" });
    try {
      const operation = session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: "commit one permission result" }],
      }, { signal: controller.signal });
      const rejected = assert.rejects(operation, RequestAbortedError);
      const child = fixture.children[0];
      await waitFor(() => callbackContext);
      const response = await waitForAcpResponse(child, "already-written");
      assert.deepEqual(response.result.outcome, { outcome: "selected", optionId: "offered-allow-once" });

      // Once stdin.write has accepted the frame, the transport cannot promise
      // that cancellation retracts it. It must not send a conflicting second
      // response or misreport the already-committed bytes as cancelled.
      controller.abort();
      await rejected;
      await sleep(5);
      const responses = child.writes.filter((message) => message.id === "already-written");
      assert.equal(responses.length, 1);
      assert.deepEqual(responses[0].result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
    } finally {
      controller.abort();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("callback concurrency is bounded per SDK and overflow defaults to denial", async () => {
  await withTempDirectory(async (root) => {
    const decisions = Array.from({ length: 8 }, () => deferred());
    const contexts = [];
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 2_000,
        onRequest(context) {
          const index = contexts.push(context) - 1;
          return decisions[index].promise;
        },
      },
      onPrompt(message, child, childIndex) {
        state.agentTasks ??= [];
        state.agentTasks.push((async () => {
          const ids = Array.from({ length: 5 }, (_unused, index) => `session-${childIndex}-permission-${index}`);
          for (const id of ids) sendPermissionRequest(child, id, permissionParams(message.params.sessionId));
          await waitFor(() => contexts.length === 8);
          if (!state.decisionsResolved) {
            state.decisionsResolved = true;
            decisions.forEach((decision) => decision.resolve({ action: "select", optionId: "offered-allow-once" }));
          }
          state.responses ??= {};
          state.responses[childIndex] = await Promise.all(ids.map((id) => waitForAcpResponse(child, id)));
          sendPromptText(child, message.params.sessionId, `bounded-${childIndex}`);
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        }));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const sessions = [
      await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-concurrency-a" }),
      await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-concurrency-b" }),
    ];
    try {
      const responses = await Promise.all(sessions.map((session) => session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: "bound callback work" }],
      })));
      await Promise.all(state.agentTasks);
      assert.deepEqual(responses.map(({ content }) => content[0].text), ["bounded-0", "bounded-1"]);
      assert.equal(state.agentError, undefined);
      assert.equal(contexts.length, 8);
      const outcomes = Object.values(state.responses).flat().map(({ result }) => result.outcome);
      assert.equal(outcomes.filter(({ optionId }) => optionId === "offered-allow-once").length, 8);
      assert.equal(outcomes.filter(({ optionId }) => optionId === "offered-reject-once").length, 2);
      assert.deepEqual(new Set(contexts.map(({ sessionId }) => sessionId)).size, 2);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await fixture.sdk.close();
    }
  });
});

test("terminal completion aborts an unresolved permission callback and returns cancelled", async () => {
  await withTempDirectory(async (root) => {
    let callbackContext;
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return new Promise(() => undefined);
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          sendPermissionRequest(child, "terminal-pending", permissionParams(message.params.sessionId));
          await waitFor(() => callbackContext);
          sendPromptText(child, message.params.sessionId, "terminal answer");
          child.reply(message.id, { stopReason: "end_turn" });
          state.permission = await waitForAcpResponse(child, "terminal-pending");
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-terminal" });
    try {
      const response = await session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "finish" }] });
      await state.agentTask;
      assert.deepEqual(response.content, [{ type: "text", text: "terminal answer" }]);
      assert.equal(state.agentError, undefined);
      assert.equal(callbackContext.signal.aborted, true);
      assert.deepEqual(state.permission.result.outcome, { outcome: "cancelled" });
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("session close aborts an unresolved permission callback", async () => {
  await withTempDirectory(async (root) => {
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return new Promise(() => undefined);
        },
      },
      onPrompt(message, child) {
        sendPermissionRequest(child, "close-pending", permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-close" });
    try {
      const active = session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "close" }] });
      void active.catch(() => undefined);
      await waitFor(() => callbackContext);
      await session.close();
      await assert.rejects(active, RequestAbortedError);
      assert.equal(callbackContext.signal.aborted, true);
      assert.equal(session.state, "closed");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("account logout aborts an unresolved permission callback through worker ownership cleanup", async () => {
  await withTempDirectory(async (root) => {
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return new Promise(() => undefined);
        },
      },
      onPrompt(message, child) {
        sendPermissionRequest(child, "logout-pending", permissionParams(message.params.sessionId));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-logout" });
    try {
      const active = session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "logout" }] });
      void active.catch(() => undefined);
      await waitFor(() => callbackContext);
      await account.auth.logout();
      await assert.rejects(active, RequestAbortedError);
      assert.equal(callbackContext.signal.aborted, true);
      assert.equal(session.state, "closed");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("starting a caller-tool continuation aborts a parked permission callback and ignores its late approval", async () => {
  await withTempDirectory(async (root) => {
    const lateDecision = deferred();
    const state = {};
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        timeoutMs: 2_000,
        onRequest(context) {
          callbackContext = context;
          return lateDecision.promise;
        },
      },
      onPrompt(message, child) {
        state.agentTask = (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPermissionRequest(child, "parked-operation", permissionParams(message.params.sessionId, { metadata: false }));
          const callerWaiter = mcp.call("caller-owned", 941);
          state.callerResult = await callerWaiter;
          sendPromptText(child, message.params.sessionId, "continued");
          child.reply(message.id, { stopReason: "end_turn" });
          state.permission = await waitForAcpResponse(child, "parked-operation");
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-operation", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const user = { role: "user", content: "call tool" };
      const initial = await session.messages.create({ max_tokens: 29, messages: [user] });
      const toolUse = initial.content.find((block) => block.type === "tool_use");
      assert.ok(toolUse);
      assert.ok(callbackContext);
      const next = await session.messages.create({
        max_tokens: 31,
        messages: [user, { role: "assistant", content: initial.content }, {
          role: "user", content: [toolResult(toolUse, "returned")],
        }],
      });
      await state.agentTask;
      assert.deepEqual(next.content, [{ type: "text", text: "continued" }]);
      assert.equal(state.agentError, undefined);
      assert.equal(callbackContext.signal.aborted, true);
      assert.deepEqual(state.permission.result.outcome, { outcome: "cancelled" });
      assert.deepEqual(state.callerResult.body.result.content, [{ type: "text", text: "returned" }]);
      lateDecision.resolve({ action: "select", optionId: "offered-allow-once" });
      await sleep(10);
      assert.deepEqual(state.permission.result.outcome, { outcome: "cancelled" });
    } finally {
      lateDecision.resolve({ action: "deny" });
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("permission contexts remain isolated across accounts and sessions", async () => {
  await withTempDirectory(async (root) => {
    const contexts = [];
    const state = {};
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          contexts.push(context);
          return { action: "select", optionId: "offered-allow-once" };
        },
      },
      onPrompt(message, child, childIndex) {
        state.tasks ??= [];
        state.tasks.push((async () => {
          if (childIndex === 0) {
            sendPermissionRequest(child, "foreign-account-session", permissionParams("foreign-remote-session"));
            state.foreign = await waitForAcpResponse(child, "foreign-account-session");
          }
          sendPermissionRequest(child, `owned-${childIndex}`, permissionParams(message.params.sessionId, { metadata: false }));
          state[`owned-${childIndex}`] = await waitForAcpResponse(child, `owned-${childIndex}`);
          sendPromptText(child, message.params.sessionId, `answer-${childIndex}`);
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch((error) => {
          state.agentError = error;
          child.exit(1);
        }));
      },
    });
    const accountA = await fixture.sdk.accounts.create();
    const accountB = await fixture.sdk.accounts.create();
    const sessions = [];
    sessions.push(await accountA.sessions.create({ model: "model-a", cwd: "/workspace/a-one" }));
    sessions.push(await accountA.sessions.create({ model: "model-a", cwd: "/workspace/a-two" }));
    sessions.push(await accountB.sessions.create({ model: "model-a", cwd: "/workspace/b-one" }));
    sessions.push(await accountB.sessions.create({ model: "model-a", cwd: "/workspace/b-two" }));
    try {
      const responses = await Promise.all(sessions.map((session, index) => session.messages.create({
        max_tokens: 32,
        messages: [{ role: "user", content: `prompt-${index}` }],
      })));
      await Promise.all(state.tasks);
      assert.equal(state.agentError, undefined);
      assert.deepEqual(responses.map(({ content }) => content[0].text), ["answer-0", "answer-1", "answer-2", "answer-3"]);
      assert.deepEqual(state.foreign.result.outcome, { outcome: "selected", optionId: "offered-reject-once" });
      assert.equal(contexts.length, 4);
      const bySession = new Map(contexts.map((context) => [context.sessionId, context]));
      for (const [index, session] of sessions.entries()) {
        const context = bySession.get(session.sessionId);
        assert.ok(context);
        assert.equal(context.accountId, session.accountId);
        assert.equal(context.remoteSessionId, `remote-prompt-${index}-1`);
        assert.equal(context.requestId, `owned-${index}`);
        assert.deepEqual(state[`owned-${index}`].result.outcome, { outcome: "selected", optionId: "offered-allow-once" });
      }
      assert.notEqual(sessions[0].accountId, sessions[2].accountId);
      assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
      assert.equal(fixture.children.length, 4);
      assert.equal(fixture.children.every((child) => !child.ended), true);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await fixture.sdk.close();
    }
  });
});

test("cancelling while an ACP permission decision is in flight returns cancelled and bounds worker shutdown", async () => {
  await withTempDirectory(async (root) => {
    const controller = new AbortController();
    const lateDecision = deferred();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    let permissionId;
    let callbackContext;
    const fixture = createPromptSdk(root, {
      permissions: {
        onRequest(context) {
          callbackContext = context;
          return lateDecision.promise;
        },
      },
      onPrompt(message, child) {
        permissionId = "permission-cancel-pending";
        sendPermissionRequest(child, permissionId, permissionParams(message.params.sessionId));
        void waitFor(() => callbackContext).then(() => controller.abort());
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/permission-cancel", tools: callerTools });
    process.on("unhandledRejection", onUnhandled);
    try {
      await session.tools.createMcpServer();
      const started = Date.now();
      await assert.rejects(session.messages.create({
        max_tokens: 41,
        messages: [{ role: "user", content: "cancel pending permission" }],
      }, { signal: controller.signal }), RequestAbortedError);
      assert.ok(Date.now() - started < 1_000);
      const child = fixture.children[0];
      const permission = await waitForAcpResponse(child, permissionId);
      assert.deepEqual(permission.result.outcome, { outcome: "cancelled" });
      assert.equal(callbackContext.signal.aborted, true);
      lateDecision.resolve({ action: "select", optionId: "offered-allow-once" });
      await sleep(10);
      assert.deepEqual(permission.result.outcome, { outcome: "cancelled" }, "a late allow cannot replace the cancellation");
      assert.deepEqual(unhandled, []);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 1);
      assert.equal(child.ended, true, "unresponsive ACP is forcibly terminated after the bounded cancel wait");
      assert.equal(fixture.promptRequests.length, 1, "a cancelled request is never replayed");
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, []);
    } finally {
      await session.close();
      await fixture.sdk.close();
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

test("session startup binds MCP before session/new, isolates account env, and verifies the pinned model", async () => {
  await withTempDirectory(async (root) => {
    const children = [];
    const requests = [];
    const drivers = [];
    const baseFactory = createFakeAcpSessionDriverFactory({
      executable: "/fake/agy-acp",
      args: ["--stdio"],
      processFactory: (_executable, _args, spawnOptions) => {
        const child = new FakeAcpChild(spawnOptions, {
          onRequest: createAgentBehavior({ useNotification: true, requests }),
        });
        children.push(child);
        return child;
      },
      modelConfirmationTimeoutMs: 100,
    });
    const factory = async (context) => {
      const driver = await baseFactory(context);
      drivers.push(driver);
      return driver;
    };
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/safe/bin", GOOGLE_API_KEY: "must-not-cross", GEMINI_HOME: "/ambient" },
      sessionDriverFactory: factory,
    });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-b",
      cwd: "/workspace/selected",
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    });
    const child = children[0];
    assert.ok(child);
    assert.deepEqual(child.writes.filter(({ method }) => method).map(({ method }) => method), ["initialize"]);
    assert.equal(session.capabilities.maxTokens, undefined);

    const mcpServer = await session.tools.createMcpServer();
    assert.deepEqual(child.writes.filter(({ method }) => method).map(({ method }) => method), [
      "initialize", "session/new", "session/set_config_option",
    ]);
    const initialize = child.writes[0];
    assert.deepEqual(initialize.params, { protocolVersion: 1, clientCapabilities: {} });
    const created = child.writes.find(({ method }) => method === "session/new");
    assert.equal(created.params.cwd, "/workspace/selected");
    assert.deepEqual(created.params._meta, { agy: { enabledTools: [] } });
    assert.equal(created.params.mcpServers.length, 1);
    assert.equal(created.params.mcpServers[0].type, "http");
    assert.equal(created.params.mcpServers[0].url, mcpServer.url);
    assert.ok(created.params.mcpServers[0].headers.some(({ name, value }) =>
      name === "authorization" && value === mcpServer.headers.authorization));
    assert.deepEqual(child.writes.find(({ method }) => method === "session/set_config_option").params, {
      sessionId: "remote-session-1",
      configId: "model",
      value: "model-b",
    });
    const notification = await drivers[0].notifications()[Symbol.asyncIterator]().next();
    assert.equal(notification.value.method, "session/update");
    assert.equal(notification.value.params.sessionId, "remote-session-1");
    assert.notEqual(session.sessionId, "remote-session-1");
    assert.equal(child.spawnOptions.cwd, "/workspace/selected");
    assert.equal(child.spawnOptions.env.PATH, "/safe/bin");
    assert.equal(child.spawnOptions.env.GEMINI_HOME, join(child.spawnOptions.env.HOME, "..", "gemini"));
    assert.equal(child.spawnOptions.env.HOME.includes(account.id), true);
    assert.match(child.spawnOptions.env.BROWSER, /AGY_INTERACTIVE_LOGIN_BLOCKED/u);
    assert.equal(Object.hasOwn(child.spawnOptions.env, "GOOGLE_API_KEY"), false);
    assert.equal(Object.hasOwn(child.spawnOptions.env, "GEMINI_HOME") && child.spawnOptions.env.GEMINI_HOME === "/ambient", false);
    const inboundReplies = child.writes.filter(({ id, result, error }) =>
      (id === "permission" || id === "unknown") && (result !== undefined || error !== undefined));
    assert.equal(inboundReplies.length, 2);
    assert.deepEqual(inboundReplies.find(({ id }) => id === "permission").result,
      { outcome: { outcome: "cancelled" } });
    assert.deepEqual(inboundReplies.find(({ id }) => id === "unknown").error,
      { code: -32601, message: "Method not found" });
    assert.equal(requests.some(({ method }) => method === "authenticate"), false);
    await session.close();
    assert.equal(child.ended, true);
    await sdk.close();
  });
});

test("a tool-enabled prompt cannot create an unbound ACP session; binding first registers its MCP endpoint", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root);
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/lazy-mcp", tools: callerTools });
    try {
      await assert.rejects(
        session.messages.create({ max_tokens: 17, messages: [{ role: "user", content: "before binding" }] }),
        InvalidRequestError,
      );
      assert.equal(session.state, "idle", "missing tool binding is rejected during admission and remains retryable");
      assert.equal(fixture.requests.filter(({ method }) => method === "session/new").length, 0);
      assert.equal(fixture.promptRequests.length, 0);

      const server = await session.tools.createMcpServer();
      const newRequest = fixture.requests.find(({ method }) => method === "session/new");
      assert.ok(newRequest);
      assert.equal(newRequest.params.mcpServers.length, 1);
      assert.equal(newRequest.params.mcpServers[0].url, server.url);
      assert.deepEqual(Object.fromEntries(newRequest.params.mcpServers[0].headers.map(({ name, value }) => [name, value])), server.headers);
      await assert.rejects(fixture.drivers[0].bindCallerTools({
        ...server,
        url: "http://127.0.0.1:1/mcp",
      }, {
        accountId: session.accountId,
        sessionId: session.sessionId,
        catalogId: session.tools.catalogId,
        async sealBatch() { return []; },
        async failTurn() {},
      }), InvalidRequestError, "a started ACP session cannot silently accept a different MCP endpoint");

      const answer = await session.messages.create({ max_tokens: 19, messages: [{ role: "user", content: "after binding" }] });
      assert.deepEqual(answer.content, [{ type: "text", text: "pump answer" }]);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/new").length, 1);
      assert.equal(fixture.promptRequests.length, 1);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("a prompt racing MCP binding shares the correctly registered session/new startup", async () => {
  await withTempDirectory(async (root) => {
    const sessionNewStarted = deferred();
    const releaseSessionNew = deferred();
    const fixture = createPromptSdk(root, {
      onSessionNew(message, child, _index, startup) {
        sessionNewStarted.resolve({ message, child, startup });
        void releaseSessionNew.promise.then(() => startup(message, child));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/mcp-race", tools: callerTools });
    try {
      const serverPromise = session.tools.createMcpServer();
      const { message: newRequest } = await sessionNewStarted.promise;
      assert.equal(newRequest.params.mcpServers.length, 1);
      const promptPromise = session.messages.create({ max_tokens: 23, messages: [{ role: "user", content: "race binding" }] });
      releaseSessionNew.resolve();
      const [server, answer] = await Promise.all([serverPromise, promptPromise]);
      assert.equal(newRequest.params.mcpServers[0].url, server.url);
      assert.deepEqual(answer.content, [{ type: "text", text: "pump answer" }]);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/new").length, 1);
      assert.equal(fixture.promptRequests.length, 1);
    } finally {
      releaseSessionNew.resolve();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("account A/B sessions use distinct profiles and remote ACP IDs, and SDK close owns children", async () => {
  await withTempDirectory(async (root) => {
    const children = [];
    let childIndex = 0;
    const factory = createFakeAcpSessionDriverFactory({
      executable: "/fake/agy-acp",
      args: ["--stdio"],
      processFactory: (_executable, _args, spawnOptions) => {
        const index = childIndex++;
        const child = new FakeAcpChild(spawnOptions, {
          onRequest: createAgentBehavior({ remoteIdPrefix: `remote-${index}-` }),
        });
        children.push(child);
        return child;
      },
      modelConfirmationTimeoutMs: 100,
    });
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      sessionDriverFactory: factory,
    });
    const first = await sdk.accounts.create();
    const second = await sdk.accounts.create();
    const a = await first.sessions.create({ model: "model-a", cwd: "/a" });
    const b = await second.sessions.create({ model: "model-b", cwd: "/b" });
    assert.notEqual(children[0].spawnOptions.env.HOME, children[1].spawnOptions.env.HOME);
    assert.equal(children[0].spawnOptions.cwd, "/a");
    assert.equal(children[1].spawnOptions.cwd, "/b");
    assert.notEqual(a.sessionId, b.sessionId);
    const remoteA = children[0].responses.find(({ result }) => result?.sessionId)?.result.sessionId;
    const remoteB = children[1].responses.find(({ result }) => result?.sessionId)?.result.sessionId;
    assert.notEqual(remoteA, remoteB);
    assert.notEqual(a.sessionId, remoteA);
    assert.notEqual(b.sessionId, remoteB);
    await sdk.close();
    assert.equal(children.every((child) => child.ended), true);
  });
});

test("model startup fails closed for an unadvertised value, missing selector, rejected config, and unverifiable response", async (t) => {
  const cases = [
    ["model is not advertised", { modelValues: ["model-a"] }, "model-b", UnsupportedFeatureError],
    ["model selector is absent", { session: { configOptions: [{ id: "mode", options: [{ value: "default" }] }] } }, "model-a", UnsupportedFeatureError],
    ["model config is rejected", { setError: true }, "model-a", (error) => error?.code === "provider_error"],
    ["selection is not verified", { configResponse: {}, useNotification: false }, "model-a", RequestTimeoutError],
  ];
  for (const [name, behavior, model, expected] of cases) {
    await t.test(name, async () => withTempDirectory(async (root) => {
      const children = [];
      const { sdk } = createSdk(root, { behavior, model, onChildren: children });
      const account = await sdk.accounts.create();
      await assert.rejects(
        account.sessions.create({ model, cwd: "/workspace" }),
        (error) => typeof expected === "function" && expected.prototype
          ? error instanceof expected
          : expected(error),
      );
      assert.equal(children[0]?.ended ?? true, true);
      await sdk.close();
    }));
  }
});

test("configOptions notifications verify eager and MCP-lazy startup without accepting false confirmation", async (t) => {
  const cases = [
    { name: "eager success", lazy: false, behavior: { useNotification: true } },
    { name: "lazy success", lazy: true, behavior: { useNotification: true } },
    {
      name: "eager wrong model", lazy: false,
      behavior: { useNotification: true, notificationModelValue: "model-a" },
      expected: ProtocolFailureError,
    },
    {
      name: "lazy wrong model", lazy: true,
      behavior: { useNotification: true, notificationModelValue: "model-a" },
      expected: ProtocolFailureError,
    },
    {
      name: "eager malformed configOptions update", lazy: false,
      behavior: { useNotification: true, malformedNotification: true },
      expected: ProtocolFailureError,
    },
    {
      name: "lazy ambiguous model selector update", lazy: true,
      behavior: {
        useNotification: true,
        notificationConfigOptions: [
          modelConfigOption("model", "model-b"),
          modelConfigOption("model-alias", "model-b"),
        ],
      },
      expected: ProtocolFailureError,
    },
    {
      name: "lazy foreign session update", lazy: true,
      behavior: { useNotification: true, notificationSessionId: "another-session" },
      expected: ProtocolFailureError,
    },
    {
      name: "eager update received before set_config_option cannot confirm selection", lazy: false,
      behavior: { configResponse: {}, updateAtSessionNew: true },
      expected: RequestTimeoutError,
    },
    {
      name: "eager rejected configuration", lazy: false,
      behavior: { setError: true },
      expected: (error) => error?.code === "provider_error",
    },
    {
      name: "lazy rejected configuration", lazy: true,
      behavior: { setError: true },
      expected: (error) => error?.code === "provider_error",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => withTempDirectory(async (root) => {
      const children = [];
      const factory = createFakeAcpSessionDriverFactory({
        executable: "/fake/agy-acp",
        args: ["--stdio"],
        processFactory: (_executable, _args, spawnOptions) => {
          const child = new FakeAcpChild(spawnOptions, {
            onRequest: createAgentBehavior(scenario.behavior),
          });
          children.push(child);
          return child;
        },
        modelConfirmationTimeoutMs: 100,
      });
      const sdk = new AntigravitySDK({
        storageDir: join(root, "profiles"),
        executable: "/fake/agy-acp",
        sessionDriverFactory: factory,
      });
      const account = await sdk.accounts.create();
      const options = {
        model: "model-b",
        cwd: "/workspace",
        ...(scenario.lazy ? { tools: [{ name: "lookup", input_schema: { type: "object" } }] } : {}),
      };
      let session;
      if (scenario.expected) {
        if (scenario.lazy) {
          session = await account.sessions.create(options);
          await assert.rejects(session.tools.createMcpServer(), (error) =>
            typeof scenario.expected === "function" && scenario.expected.prototype
              ? error instanceof scenario.expected
              : scenario.expected(error));
          await session.close();
        } else {
          await assert.rejects(account.sessions.create(options), (error) =>
            typeof scenario.expected === "function" && scenario.expected.prototype
              ? error instanceof scenario.expected
              : scenario.expected(error));
        }
        assert.equal(children[0].ended, true);
      } else {
        session = await account.sessions.create(options);
        if (scenario.lazy) await session.tools.createMcpServer();
        assert.equal(children[0].writes.some(({ method }) => method === "session/set_config_option"), true);
        await session.close();
        assert.equal(children[0].ended, true);
      }
      await sdk.close();
    }));
  }
});

test("malformed/unknown capabilities and runtime process crashes do not leave startup children", async (t) => {
  await t.test("malformed advertised capabilities", async () => withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { behavior: { initialize: { agentCapabilities: "unknown" } }, onChildren: children });
    const account = await sdk.accounts.create();
    await assert.rejects(account.sessions.create({ model: "model-a", cwd: "/workspace" }), ProtocolFailureError);
    assert.equal(children[0].ended, true);
    await sdk.close();
  }));
  await t.test("child exits during initialization", async () => withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { behavior: { crashAt: "initialize" }, onChildren: children });
    const account = await sdk.accounts.create();
    await assert.rejects(account.sessions.create({ model: "model-a", cwd: "/workspace" }), ProcessFailureError);
    assert.equal(children[0].ended, true);
    await sdk.close();
  }));
  await t.test("child exits during session/new", async () => withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { behavior: { crashAt: "session/new" }, onChildren: children });
    const account = await sdk.accounts.create();
    await assert.rejects(account.sessions.create({ model: "model-a", cwd: "/workspace" }), ProcessFailureError);
    assert.equal(children[0].ended, true);
    await sdk.close();
  }));
  await t.test("an established worker reports a runtime crash through its notification seam", async () => withTempDirectory(async (root) => {
    const children = [];
    const drivers = [];
    const baseFactory = createFakeAcpSessionDriverFactory({
      executable: "/fake/agy-acp",
      args: ["--stdio"],
      processFactory: (_executable, _args, spawnOptions) => {
        const child = new FakeAcpChild(spawnOptions, { onRequest: createAgentBehavior() });
        children.push(child);
        return child;
      },
      modelConfirmationTimeoutMs: 100,
    });
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      sessionDriverFactory: async (context) => {
        const driver = await baseFactory(context);
        drivers.push(driver);
        return driver;
      },
    });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    const notifications = drivers[0].notifications()[Symbol.asyncIterator]();
    children[0].exit(1);
    await assert.rejects(notifications.next(), ProcessFailureError);
    await sdk.close();
    assert.equal(session.state, "closed");
  }));
  await t.test("unknown future agent flags are not promoted to driver capabilities", async () => withTempDirectory(async (root) => {
    const { sdk } = createSdk(root, {
      behavior: { initialize: { agentCapabilities: { futureFeature: true, loadSession: true } } },
    });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    assert.deepEqual(session.capabilities, {});
    await session.close();
    await sdk.close();
  }));
});

test("auth-required ACP failures and the browser-block marker stay noninteractive and clean up", async (t) => {
  await t.test("remote auth-required error", async () => withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { behavior: { authError: "AUTH_REQUIRED: secret refresh credential" }, onChildren: children });
    const account = await sdk.accounts.create();
    await assert.rejects(
      account.sessions.create({ model: "model-a", cwd: "/workspace" }),
      (error) => error instanceof AuthenticationError && !error.message.includes("secret refresh credential"),
    );
    assert.equal(children[0].ended, true);
    assert.equal(children[0].writes.some(({ method }) => method === "authenticate"), false);
    await sdk.close();
  }));
  await t.test("blocked browser launch", async () => withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { behavior: { browserBlockAt: "session/new" }, onChildren: children });
    const account = await sdk.accounts.create();
    await assert.rejects(account.sessions.create({ model: "model-a", cwd: "/workspace" }), AuthenticationError);
    assert.equal(children[0].ended, true);
    assert.equal(children[0].writes.some(({ method }) => method === "authenticate"), false);
    await sdk.close();
  }));
});

test("dispatch and stream are explicitly unsupported and never claim max token enforcement", async () => {
  await withTempDirectory(async (root) => {
    const children = [];
    const drivers = [];
    const baseFactory = createFakeAcpSessionDriverFactory({
      executable: "/fake/agy-acp",
      args: ["--stdio"],
      processFactory: (_executable, _args, spawnOptions) => {
        const child = new FakeAcpChild(spawnOptions, { onRequest: createAgentBehavior() });
        children.push(child);
        return child;
      },
      modelConfirmationTimeoutMs: 100,
    });
    const sdk = new AntigravitySDK({
      storageDir: join(root, "profiles"),
      executable: "/fake/agy-acp",
      sessionDriverFactory: async (context) => {
        const driver = await baseFactory(context);
        drivers.push(driver);
        return driver;
      },
    });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    assert.deepEqual(session.capabilities, {});
    await assert.rejects(drivers[0].dispatch({}), UnsupportedFeatureError);
    await assert.rejects(drivers[0].stream({})[Symbol.asyncIterator]().next(), UnsupportedFeatureError);
    await assert.rejects(drivers[0].admitResponse({
      kind: "prompt",
      operationId: "op_direct-test",
      accountId: session.accountId,
      sessionId: session.sessionId,
      maxTokens: 32,
      signal: new AbortController().signal,
    }), UnsupportedFeatureError);
    await assert.rejects(drivers[0].admitResponse({
      kind: "tool_continuation",
      operationId: "op_direct-continuation-test",
      accountId: session.accountId,
      sessionId: session.sessionId,
      maxTokens: 32,
      signal: new AbortController().signal,
    }), UnsupportedFeatureError);
    await assert.rejects(drivers[0].continueTools({}), UnsupportedFeatureError);
    await assert.rejects(drivers[0].streamTools({})[Symbol.asyncIterator]().next(), UnsupportedFeatureError);
    await assert.rejects(session.messages.create({ max_tokens: 32, messages: [{ role: "user", content: "no inference" }] }),
      UnsupportedFeatureError);
    assert.equal(children[0].writes.some(({ method }) => method === "session/prompt"), false);
    await session.close();
    await sdk.close();
  });
});

test("fake-enforced ACP v1 prompt pump preserves text, terminal response, system-first mapping, and suffix follow-up parity", async () => {
  await withTempDirectory(async (root) => {
    const deltas = ["héllo ", "", "🌍"];
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        for (const text of deltas) sendPromptText(child, message.params.sessionId, text);
        child.reply(message.id, {
          stopReason: "end_turn",
          usage: { inputTokens: 19, outputTokens: 4 },
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/pump",
      system: [{ type: "text", text: "Be exact." }, { type: "text", text: " Keep Unicode." }],
    });
    try {
      const firstInput = [{ role: "user", content: "first" }];
      const nonstream = await session.messages.create({ max_tokens: 17, messages: firstInput });
      assert.deepEqual(nonstream.content, [{ type: "text", text: "héllo 🌍" }]);
      assert.equal(nonstream.stop_reason, "end_turn");
      assert.equal(nonstream.usage.input_tokens, 19);
      assert.equal(nonstream.usage.output_tokens, 4);
      assert.deepEqual(fixture.promptRequests[0].params, {
        sessionId: "remote-prompt-0-1",
        prompt: [
          { type: "text", text: "<instruction>\nBe exact. Keep Unicode.\n</instruction>" },
          { type: "text", text: "[user]\nfirst" },
        ],
      });

      const followup = [
        { role: "user", content: "first" },
        { role: "assistant", content: nonstream.content },
        { role: "user", content: "follow-up" },
      ];
      const rawStream = await session.messages.create({ max_tokens: 23, messages: followup, stream: true });
      const events = [];
      for await (const event of rawStream) events.push(event);
      const streamedDeltas = events
        .filter((event) => event.type === "content_block_delta" && event.delta.type === "text_delta")
        .map((event) => event.delta.text);
      assert.deepEqual(streamedDeltas, ["héllo ", "🌍"]);
      assert.equal(streamedDeltas.join(""), nonstream.content[0].text);
      assert.equal(events.at(-1).type, "message_stop");
      assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "end_turn");
      assert.deepEqual(fixture.promptRequests[1].params, {
        sessionId: "remote-prompt-0-1",
        prompt: [{ type: "text", text: "[user]\nfollow-up" }],
      }, "the second full-history call sends only its new suffix and omits the already-sent system text");
      assert.deepEqual(fixture.admissionRequests.map(({ maxTokens }) => maxTokens), [17, 23]);
      assert.ok(fixture.admissionRequests.every((request) => request.accountId === session.accountId &&
        request.sessionId === session.sessionId));
      assert.equal(fixture.requests.filter(({ method }) => method === "session/prompt").length, 2);
      assert.ok(fixture.promptRequests.every(({ params }) => !Object.hasOwn(params, "maxTokens") &&
        !Object.hasOwn(params, "max_tokens")), "the fake admission is not misrepresented as an ACP token-limit parameter");
      assert.deepEqual(fixture.children[0].writes.filter(({ method }) => method).map(({ method }) => method), [
        "initialize", "session/new", "session/set_config_option", "session/prompt", "session/prompt",
      ]);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("built-in ACP pump admits explicit unenforced limits without truncation and records exact per-response intent", async () => {
  await withTempDirectory(async (root) => {
    const answers = [
      "This answer deliberately contains many words and is much longer than the requested one-token output bound.",
      "The follow-up is also complete and remains longer than its separately requested two-token output bound.",
    ];
    const fixture = createSdk(root, {
      sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
      behavior: (index, requests) => {
        const startup = createAgentBehavior({ remoteIdPrefix: `compat-session-${index}-`, requests });
        let promptIndex = 0;
        return (message, child) => {
          if (message.method === "session/prompt") {
            requests.push(message);
            sendPromptText(child, message.params.sessionId, answers[promptIndex++] ?? "unexpected extra prompt");
            child.reply(message.id, { stopReason: "end_turn" });
            return;
          }
          startup(message, child);
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/compatibility",
      system: "Preserve the complete response.",
    });
    try {
      assert.equal(session.capabilities.maxTokens, "not-enforced");
      assert.equal(session.capabilities.streaming, "incremental");
      assert.equal(Object.isFrozen(session.capabilities), true);

      const first = await session.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "first" }] });
      assert.deepEqual(first.content, [{ type: "text", text: answers[0] }]);
      assert.equal(first.stop_reason, "end_turn");
      const firstDiagnostic = messageMaxTokensEnforcement(first);
      assert.deepEqual(firstDiagnostic, {
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId: (await session.diagnostics.snapshot()).maxTokensEnforcement.operationId,
        kind: "prompt",
        requestedMaxTokens: 1,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(Object.isFrozen(firstDiagnostic), true);

      const second = await session.messages.create({
        max_tokens: 2,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: first.content },
          { role: "user", content: "second" },
        ],
      });
      assert.deepEqual(second.content, [{ type: "text", text: answers[1] }]);
      const secondSnapshot = await session.diagnostics.snapshot();
      assert.deepEqual(secondSnapshot.maxTokensEnforcement, {
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId: messageMaxTokensEnforcement(second).operationId,
        kind: "prompt",
        requestedMaxTokens: 2,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.notEqual(firstDiagnostic.operationId, secondSnapshot.maxTokensEnforcement.operationId);

      const prompts = fixture.requests.filter(({ method }) => method === "session/prompt");
      assert.equal(prompts.length, 2);
      assert.deepEqual(prompts.map(({ params }) => Object.keys(params).sort()), [
        ["prompt", "sessionId"],
        ["prompt", "sessionId"],
      ], "ACP receives no invented max_tokens or output-cap parameter");
      assert.deepEqual(prompts[0].params.prompt.map(({ text }) => text), [
        "<instruction>\nPreserve the complete response.\n</instruction>",
        "[user]\nfirst",
      ]);
      assert.deepEqual(prompts[1].params.prompt.map(({ text }) => text), ["[user]\nsecond"]);
      assert.equal(prompts.some(({ params }) => JSON.stringify(params).includes("max_tokens")), false);
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("strict default rejects a built-in non-enforcing ACP driver before prompt dispatch", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createSdk(root, {
      behavior: (_index, requests) => {
        const startup = createAgentBehavior({ requests });
        return (message, child) => {
          if (message.method === "session/prompt") requests.push(message);
          startup(message, child);
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/strict",
      tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      assert.equal(session.capabilities.maxTokens, undefined);
      await assert.rejects(
        session.messages.create({ max_tokens: 8, messages: [{ role: "user", content: "must not run" }] }),
        UnsupportedFeatureError,
      );
      assert.equal(session.state, "idle");
      assert.equal(fixture.requests.some(({ method }) => method === "session/prompt"), false);
      assert.equal((await session.diagnostics.snapshot()).maxTokensEnforcement, undefined);
      assert.deepEqual(await session.diagnostics.toolHandoffs(), [],
        "strict rejection creates no parked tool receipt and releases no result");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("an unenforced ACP max_tokens terminal is never mislabeled as reaching the requested limit", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createSdk(root, {
      sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
      behavior: (index, requests) => {
        const startup = createAgentBehavior({ remoteIdPrefix: `unbounded-stop-${index}-`, requests });
        return (message, child) => {
          if (message.method === "session/prompt") {
            requests.push(message);
            sendPromptText(child, message.params.sessionId, "ACP says max tokens");
            child.reply(message.id, { stopReason: "max_tokens" });
            return;
          }
          startup(message, child);
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/unbounded-stop" });
    try {
      await assert.rejects(
        session.messages.create({ max_tokens: 1, messages: [{ role: "user", content: "do not claim this cap" }] }),
        UnsupportedFeatureError,
      );
      assert.deepEqual(session.snapshot().transcript, []);
      assert.equal(session.state, "interrupted");
      assert.equal((await session.diagnostics.snapshot()).maxTokensEnforcement.outcome, "not-enforced");
      assert.equal(fixture.requests.filter(({ method }) => method === "session/prompt").length, 1);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("unenforced tool continuations admit exact changed bounds before result release across stream boundaries", async (t) => {
  for (const { initialStreaming, continuationStreaming } of [
    { initialStreaming: true, continuationStreaming: false },
    { initialStreaming: false, continuationStreaming: true },
  ]) {
    await t.test(`${initialStreaming ? "stream" : "nonstream"} initial / ${continuationStreaming ? "stream" : "nonstream"} continuation`, async () =>
      withTempDirectory(async (root) => {
        const agentDone = deferred();
        const timeline = [];
        let agentResult;
        let agentError;
        let declineFirstContinuation = true;
        const fixture = createSdk(root, {
          sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
          wrapDriver(driver) {
            return {
              ...driver,
              async admitResponse(request) {
                timeline.push({ type: "admission", kind: request.kind, maxTokens: request.maxTokens, policy: request.policy });
                if (request.kind === "tool_continuation" && declineFirstContinuation) {
                  declineFirstContinuation = false;
                  throw new UnsupportedFeatureError("the compatibility limit was not admitted on the first attempt");
                }
                return driver.admitResponse(request);
              },
            };
          },
          behavior: (index, requests) => {
            const startup = createAgentBehavior({ remoteIdPrefix: `compat-tools-${index}-`, requests });
            return (message, child) => {
              if (message.method === "session/prompt") {
                requests.push(message);
                void (async () => {
                  const mcp = await initializeFakeMcp(mcpServerFromChild(child));
                  sendPromptText(child, message.params.sessionId, "waiting for caller tool");
                  agentResult = await mcp.call("compatible-continuation", 851);
                  timeline.push({ type: "result-released", text: agentResult.body.result.content[0].text });
                  sendPromptText(child, message.params.sessionId, "continuation completed without an output cap");
                  child.reply(message.id, { stopReason: "end_turn" });
                  agentDone.resolve();
                })().catch((error) => {
                  agentError = error;
                  agentDone.reject(error);
                  child.exit(1);
                });
                return;
              }
              startup(message, child);
            };
          },
        });
        const account = await fixture.sdk.accounts.create();
        const session = await account.sessions.create({
          model: "model-a",
          cwd: "/workspace/compat-tools",
          tools: callerTools,
        });
        try {
          await session.tools.createMcpServer();
          const initialTranscript = [{ role: "user", content: "lookup" }];
          let firstContent;
          let firstResponse;
          if (initialStreaming) {
            const stream = await session.messages.create({ max_tokens: 17, messages: initialTranscript, stream: true });
            const events = [];
            for await (const event of stream) events.push(event);
            firstContent = assistantContentFromStream(events);
            firstResponse = events.find(({ type }) => type === "message_start").message;
          } else {
            firstResponse = await session.messages.create({ max_tokens: 17, messages: initialTranscript });
            firstContent = firstResponse.content;
          }
          const firstTool = firstContent.find(({ type }) => type === "tool_use");
          assert.ok(firstTool);
          const firstDiagnostic = messageMaxTokensEnforcement(firstResponse);
          assert.deepEqual(firstDiagnostic, {
            accountId: session.accountId,
            sessionId: session.sessionId,
            operationId: (await session.diagnostics.snapshot()).maxTokensEnforcement.operationId,
            kind: "prompt",
            requestedMaxTokens: 17,
            policy: "allow-unenforced-max-tokens",
            outcome: "not-enforced",
            reason: "backend-does-not-enforce-requested-bound",
          });

          const continuationTranscript = [
            ...initialTranscript,
            { role: "assistant", content: firstContent },
            { role: "user", content: [toolResult(firstTool, "caller result is longer than requested output cap")] },
          ];
          if (continuationStreaming) {
            const rejected = await session.messages.create({
              max_tokens: 29,
              messages: continuationTranscript,
              stream: true,
            });
            await assert.rejects(async () => {
              for await (const _event of rejected) { /* failed admission must precede output */ }
            }, UnsupportedFeatureError);
          } else {
            await assert.rejects(
              session.messages.create({ max_tokens: 29, messages: continuationTranscript }),
              UnsupportedFeatureError,
            );
          }
          assert.equal(session.state, "awaiting_tools");
          assert.equal(agentResult, undefined, "failed compatibility admission releases no caller result");
          assert.equal((await session.diagnostics.toolHandoffs())[0].resultState, "none");

          if (continuationStreaming) {
            const stream = await session.messages.create({
              max_tokens: 29,
              messages: continuationTranscript,
              stream: true,
            });
            const events = [];
            for await (const event of stream) events.push(event);
            assert.ok(assistantContentFromStream(events).some((block) => block.type === "text" &&
              block.text === "continuation completed without an output cap"));
            const responseMessage = events.find(({ type }) => type === "message_start").message;
            assert.deepEqual(messageMaxTokensEnforcement(responseMessage), {
              accountId: session.accountId,
              sessionId: session.sessionId,
              operationId: (await session.diagnostics.snapshot()).maxTokensEnforcement.operationId,
              kind: "tool_continuation",
              requestedMaxTokens: 29,
              policy: "allow-unenforced-max-tokens",
              outcome: "not-enforced",
              reason: "backend-does-not-enforce-requested-bound",
            });
          } else {
            const response = await session.messages.create({ max_tokens: 29, messages: continuationTranscript });
            assert.deepEqual(response.content, [{ type: "text", text: "continuation completed without an output cap" }]);
            assert.deepEqual(messageMaxTokensEnforcement(response), {
              accountId: session.accountId,
              sessionId: session.sessionId,
              operationId: (await session.diagnostics.snapshot()).maxTokensEnforcement.operationId,
              kind: "tool_continuation",
              requestedMaxTokens: 29,
              policy: "allow-unenforced-max-tokens",
              outcome: "not-enforced",
              reason: "backend-does-not-enforce-requested-bound",
            });
          }
          await agentDone.promise;
          assert.equal(agentError, undefined);
          assert.equal(agentResult.body.result.content[0].text, "caller result is longer than requested output cap");
          const continuationAdmission = timeline.find(({ type, kind }) => type === "admission" && kind === "tool_continuation");
          const release = timeline.findIndex(({ type }) => type === "result-released");
          assert.deepEqual(continuationAdmission, {
            type: "admission",
            kind: "tool_continuation",
            maxTokens: 29,
            policy: "allow-unenforced-max-tokens",
          });
          assert.ok(timeline.findIndex(({ type, kind }) => type === "admission" && kind === "tool_continuation") < release,
            "exact compatibility admission precedes saving/releasing the tool result");
          assert.equal(fixture.requests.filter(({ method }) => method === "session/prompt").length, 1,
            "continuation consumes the parked ACP turn without a second prompt");
          assert.equal(session.state, "idle");
        } finally {
          await session.close();
          await fixture.sdk.close();
        }
      }));
  }
});

test("built-in unenforced grants bind policy, identity, operation, kind, and limit and are single-use", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createSdk(root, {
      sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
      behavior: (index, requests) => {
        const startup = createAgentBehavior({ remoteIdPrefix: `direct-grant-${index}-`, requests });
        return (message, child) => {
          if (message.method === "session/prompt") {
            requests.push(message);
            sendPromptText(child, message.params.sessionId, "direct grant response");
            child.reply(message.id, { stopReason: "end_turn" });
            return;
          }
          startup(message, child);
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/grants" });
    const driver = fixture.drivers[0];
    try {
      const controller = new AbortController();
      const request = {
        kind: "prompt",
        operationId: "direct-compatible-operation",
        accountId: session.accountId,
        sessionId: session.sessionId,
        maxTokens: 11,
        policy: "allow-unenforced-max-tokens",
        signal: controller.signal,
      };
      const grant = await driver.admitResponse(request);
      assert.deepEqual(grant, {
        kind: "prompt",
        operationId: request.operationId,
        accountId: session.accountId,
        sessionId: session.sessionId,
        maxTokens: 11,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(Object.isFrozen(grant), true);
      await assert.rejects(driver.admitResponse(request), SessionBusyError,
        "duplicate pending admission for the same operation cannot overwrite the original grant");
      await assert.rejects(driver.admitResponse({ ...request, policy: "strict" }), InvalidRequestError);
      await assert.rejects(driver.admitResponse({ ...request, accountId: "acct_foreign" }), InvalidRequestError);
      await assert.rejects(driver.admitResponse({ ...request, sessionId: "sess_foreign" }), InvalidRequestError);

      const operation = {
        operationId: request.operationId,
        accountId: session.accountId,
        sessionId: session.sessionId,
        configuration: session.configuration,
        messages: [{ role: "user", content: "direct" }],
        acpPrompt: [{ type: "text", text: "[user]\ndirect" }],
        maxTokens: request.maxTokens,
        admission: grant,
        signal: controller.signal,
      };
      const expectRejectedOperation = async (candidate) => {
        await assert.rejects(async () => {
          for await (const _event of driver.stream(candidate)) { /* test only admission */ }
        });
      };
      await expectRejectedOperation({ ...operation, maxTokens: 12 });
      await expectRejectedOperation({ ...operation, operationId: "another-operation" });
      await expectRejectedOperation({ ...operation, accountId: "acct_foreign" });
      await expectRejectedOperation({ ...operation, sessionId: "sess_foreign" });
      await expectRejectedOperation({ ...operation, admission: { ...grant, kind: "tool_continuation" } });
      await expectRejectedOperation({ ...operation, admission: { ...grant, policy: "strict" } });

      const events = [];
      for await (const event of driver.stream(operation)) events.push(event);
      assert.deepEqual(events.map(({ type }) => type), ["text", "complete"]);
      assert.equal(events[0].text, "direct grant response");
      await expectRejectedOperation(operation);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/prompt").length, 1,
        "forged identity, kind, policy, or limit and replay do not dispatch a prompt");

      const continuationGrant = await driver.admitResponse({
        ...request,
        kind: "tool_continuation",
        operationId: "direct-continuation-grant",
      });
      await expectRejectedOperation({
        ...operation,
        operationId: "direct-continuation-grant",
        admission: continuationGrant,
      });
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("unenforced admission failure, cancellation, and same-session waiter races remain pre-dispatch", async () => {
  await withTempDirectory(async (root) => {
    const entered = deferred();
    const release = deferred();
    const calls = [];
    let blockNext = false;
    let failFirst = true;
    const fixture = createSdk(root, {
      sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
      wrapDriver(driver) {
        return {
          ...driver,
          async admitResponse(request) {
            calls.push({ kind: request.kind, maxTokens: request.maxTokens, policy: request.policy });
            if (failFirst) {
              failFirst = false;
              throw new UnsupportedFeatureError("compat admission failed before the ACP prompt");
            }
            if (blockNext) {
              blockNext = false;
              entered.resolve();
              await release.promise;
            }
            return driver.admitResponse(request);
          },
        };
      },
      behavior: (index, requests) => {
        const startup = createAgentBehavior({ remoteIdPrefix: `compat-race-${index}-`, requests });
        return (message, child) => {
          if (message.method === "session/prompt") {
            requests.push(message);
            sendPromptText(child, message.params.sessionId, "admitted after retry");
            child.reply(message.id, { stopReason: "end_turn" });
            return;
          }
          startup(message, child);
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/compat-race" });
    try {
      const transcript = [{ role: "user", content: "same request" }];
      await assert.rejects(session.messages.create({ max_tokens: 31, messages: transcript }), UnsupportedFeatureError);
      assert.equal(session.state, "idle");
      assert.equal(fixture.requests.some(({ method }) => method === "session/prompt"), false);

      blockNext = true;
      const controller = new AbortController();
      const pending = session.messages.create({ max_tokens: 37, messages: transcript }, { signal: controller.signal });
      await entered.promise;
      await assert.rejects(session.messages.create({ max_tokens: 41, messages: transcript }), SessionBusyError);
      assert.equal(fixture.requests.some(({ method }) => method === "session/prompt"), false);
      controller.abort();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal(session.state, "idle");
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.requests.some(({ method }) => method === "session/prompt"), false);

      const response = await session.messages.create({ max_tokens: 37, messages: transcript });
      assert.deepEqual(response.content, [{ type: "text", text: "admitted after retry" }]);
      assert.deepEqual(calls, [
        { kind: "prompt", maxTokens: 31, policy: "allow-unenforced-max-tokens" },
        { kind: "prompt", maxTokens: 37, policy: "allow-unenforced-max-tokens" },
        { kind: "prompt", maxTokens: 37, policy: "allow-unenforced-max-tokens" },
      ]);
      assert.deepEqual((await session.diagnostics.snapshot()).maxTokensEnforcement, {
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId: messageMaxTokensEnforcement(response).operationId,
        kind: "prompt",
        requestedMaxTokens: 37,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(fixture.requests.filter(({ method }) => method === "session/prompt").length, 1);
    } finally {
      release.resolve();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("compatibility admission and output stay isolated across two accounts and two sessions each", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createSdk(root, {
      sdkOptions: { maxTokensPolicy: "allow-unenforced-max-tokens" },
      behavior: (index, requests) => {
        const startup = createAgentBehavior({ remoteIdPrefix: `isolated-compat-${index}-`, requests });
        return (message, child) => {
          if (message.method === "session/prompt") {
            requests.push(message);
            sendPromptText(child, message.params.sessionId, `response-from-child-${index}`);
            child.reply(message.id, { stopReason: "end_turn" });
            return;
          }
          startup(message, child);
        };
      },
    });
    const accounts = [await fixture.sdk.accounts.create(), await fixture.sdk.accounts.create()];
    const sessions = [];
    for (const account of accounts) {
      sessions.push(await account.sessions.create({ model: "model-a", cwd: `/workspace/${account.id}/one` }));
      sessions.push(await account.sessions.create({ model: "model-a", cwd: `/workspace/${account.id}/two` }));
    }
    try {
      const results = await Promise.all(sessions.map((session, index) => session.messages.create({
        max_tokens: index + 1,
        messages: [{ role: "user", content: `question-${index}` }],
      })));
      const accountSessionPairs = new Set();
      const operationIds = new Set();
      for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index];
        const response = results[index];
        assert.deepEqual(response.content, [{ type: "text", text: `response-from-child-${index}` }]);
        const diagnostic = (await session.diagnostics.snapshot()).maxTokensEnforcement;
        assert.deepEqual(diagnostic, {
          accountId: session.accountId,
          sessionId: session.sessionId,
          operationId: messageMaxTokensEnforcement(response).operationId,
          kind: "prompt",
          requestedMaxTokens: index + 1,
          policy: "allow-unenforced-max-tokens",
          outcome: "not-enforced",
          reason: "backend-does-not-enforce-requested-bound",
        });
        accountSessionPairs.add(`${diagnostic.accountId}/${diagnostic.sessionId}`);
        operationIds.add(diagnostic.operationId);
      }
      assert.equal(accountSessionPairs.size, 4);
      assert.equal(operationIds.size, 4);
      const prompts = fixture.requests.filter(({ method }) => method === "session/prompt");
      assert.equal(prompts.length, 4);
      for (let index = 0; index < prompts.length; index += 1) {
        assert.ok(prompts[index].params.prompt.some(({ text }) => text === `[user]\nquestion-${index}`));
      }
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await fixture.sdk.close();
    }
  });
});

test("authoritative MCP calls park one ACP prompt, preserve identical call IDs, and release inverse results atomically", async () => {
  await withTempDirectory(async (root) => {
    const started = deferred();
    const agentState = { results: undefined, error: undefined };
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "before tools ");
          const calls = [
            mcp.call("same", 501),
            mcp.call("same", 502),
          ];
          started.resolve();
          agentState.results = await Promise.all(calls);
          sendPromptText(child, message.params.sessionId, "after results");
          child.reply(message.id, {
            stopReason: "end_turn",
            usage: { inputTokens: 12, outputTokens: 5 },
          });
        })().catch((error) => {
          agentState.error = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/authoritative",
      tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const userMessage = { role: "user", content: "use lookup twice" };
      const first = await session.messages.create({ max_tokens: 41, messages: [userMessage] });
      await started.promise;
      assert.equal(session.state, "awaiting_tools");
      assert.deepEqual(first.content[0], { type: "text", text: "before tools " });
      const firstBatch = first.content.filter(({ type }) => type === "tool_use");
      assert.equal(firstBatch.length, 2);
      assert.ok(firstBatch.every(({ id }) => /^toolu_[0-9a-f]{32}$/u.test(id)));
      assert.notEqual(firstBatch[0].id, firstBatch[1].id);
      assert.deepEqual(firstBatch.map(({ input }) => input), [{ key: "same" }, { key: "same" }]);
      assert.equal(agentState.results, undefined, "the same ACP prompt remains parked until the complete caller batch is returned");
      assert.equal(fixture.promptRequests.length, 1);

      const assistant = { role: "assistant", content: first.content };
      await assert.rejects(
        session.messages.create({
          max_tokens: 43,
          messages: [userMessage, assistant, { role: "user", content: [toolResult(firstBatch[0], "partial")] }],
        }),
        InvalidRequestError,
      );
      assert.equal(session.state, "awaiting_tools", "a partial batch cannot release either MCP waiter");
      assert.equal(agentState.results, undefined);

      const final = await session.messages.create({
        max_tokens: 47,
        messages: [userMessage, assistant, {
          role: "user",
          content: [toolResult(firstBatch[1], "second-result"), toolResult(firstBatch[0], "first-result")],
        }],
      });
      assert.deepEqual(final.content, [{ type: "text", text: "after results" }]);
      assert.equal(final.stop_reason, "end_turn");
      assert.deepEqual(agentState.results.map(({ status, body }) => ({ status, content: body.result?.content })), [
        { status: 200, content: [{ type: "text", text: "first-result" }] },
        { status: 200, content: [{ type: "text", text: "second-result" }] },
      ]);
      assert.equal(agentState.error, undefined);
      assert.equal(fixture.promptRequests.length, 1, "continuation must not send a second ACP session/prompt");
      assert.equal(fixture.requests.filter(({ method }) => method === "session/new").length, 1);
      assert.deepEqual(fixture.admissionRequests.map(({ kind, maxTokens }) => ({ kind, maxTokens })), [
        { kind: "prompt", maxTokens: 41 },
        { kind: "tool_continuation", maxTokens: 47 },
      ]);
      assert.ok((await session.diagnostics.toolHandoffs()).every((receipt) => receipt.resultState === "acknowledged"));
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("stream and nonstream MCP batches continue the same ACP prompt; post-boundary arrivals use the next operation", async () => {
  await withTempDirectory(async (root) => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const agentState = { firstResults: undefined, lateResult: undefined, error: undefined };
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "streamed start");
          const firstCalls = [mcp.call("parallel", 601), mcp.call("parallel", 602)];
          firstStarted.resolve();
          agentState.firstResults = await Promise.all(firstCalls);
          sendPromptText(child, message.params.sessionId, "between batches");
          secondStarted.resolve();
          agentState.lateResult = await mcp.call("late", 603);
          sendPromptText(child, message.params.sessionId, "final answer");
          child.reply(message.id, { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 8 } });
        })().catch((error) => {
          agentState.error = error;
          child.exit(1);
        });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({
      model: "model-a",
      cwd: "/workspace/continuations",
      tools: callerTools,
    });
    try {
      await session.tools.createMcpServer();
      const userMessage = { role: "user", content: "start a multi-step lookup" };
      const firstStream = await session.messages.create({ max_tokens: 53, messages: [userMessage], stream: true });
      const firstEvents = [];
      for await (const event of firstStream) firstEvents.push(event);
      await firstStarted.promise;
      const firstContent = assistantContentFromStream(firstEvents);
      assert.deepEqual(firstContent, [
        { type: "text", text: "streamed start" },
        { type: "tool_use", id: firstContent[1].id, name: "lookup", input: { key: "parallel" } },
        { type: "tool_use", id: firstContent[2].id, name: "lookup", input: { key: "parallel" } },
      ]);
      const firstBatch = firstContent.filter(({ type }) => type === "tool_use");
      assert.notEqual(firstBatch[0].id, firstBatch[1].id);

      const second = await session.messages.create({
        max_tokens: 59,
        messages: [userMessage, { role: "assistant", content: firstContent }, {
          role: "user",
          content: [toolResult(firstBatch[1], "second-parallel"), toolResult(firstBatch[0], "first-parallel")],
        }],
      });
      await secondStarted.promise;
      const lateTool = second.content.find(({ type }) => type === "tool_use");
      assert.ok(lateTool);
      assert.equal(lateTool.input.key, "late");
      assert.ok(second.content.some((block) => block.type === "text" && block.text === "between batches"));
      assert.equal(agentState.lateResult, undefined, "the late call waits for a distinct continuation batch");

      const finalStream = await session.messages.create({
        max_tokens: 61,
        stream: true,
        messages: [userMessage, { role: "assistant", content: firstContent }, {
          role: "user",
          content: [toolResult(firstBatch[1], "second-parallel"), toolResult(firstBatch[0], "first-parallel")],
        }, { role: "assistant", content: second.content }, {
          role: "user",
          content: [toolResult(lateTool, "late-result")],
        }],
      });
      const finalEvents = [];
      for await (const event of finalStream) finalEvents.push(event);
      assert.ok(finalEvents.some((event) => event.type === "content_block_delta" &&
        event.delta.type === "text_delta" && event.delta.text === "final answer"));
      assert.equal(finalEvents.at(-1).type, "message_stop");
      assert.deepEqual(agentState.firstResults.map(({ body }) => body.result.content), [
        [{ type: "text", text: "first-parallel" }],
        [{ type: "text", text: "second-parallel" }],
      ]);
      assert.deepEqual(agentState.lateResult.body.result.content, [{ type: "text", text: "late-result" }]);
      assert.equal(agentState.error, undefined);
      assert.equal(fixture.promptRequests.length, 1);
      assert.deepEqual(fixture.admissionRequests.map(({ kind, maxTokens }) => ({ kind, maxTokens })), [
        { kind: "prompt", maxTokens: 53 },
        { kind: "tool_continuation", maxTokens: 59 },
        { kind: "tool_continuation", maxTokens: 61 },
      ]);
      const receipts = await session.diagnostics.toolHandoffs();
      assert.equal(receipts.length, 3);
      assert.equal(receipts[0].operationId, receipts[1].operationId);
      assert.notEqual(receipts[2].operationId, receipts[0].operationId);
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("continuation max_tokens admission precedes MCP result release and a declined limit is retryable", async () => {
  await withTempDirectory(async (root) => {
    let allowContinuation = false;
    let agentResult;
    const fixture = createPromptSdk(root, {
      enforceMaxTokens: (request) => request.kind !== "tool_continuation" || allowContinuation,
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "waiting");
          agentResult = await mcp.call("admission", 701);
          sendPromptText(child, message.params.sessionId, "admitted");
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch(() => child.exit(1));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/admission", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const userMessage = { role: "user", content: "lookup" };
      const first = await session.messages.create({ max_tokens: 67, messages: [userMessage] });
      const toolUse = first.content.find(({ type }) => type === "tool_use");
      assert.ok(toolUse);
      const continuationTranscript = [
        userMessage,
        { role: "assistant", content: first.content },
        { role: "user", content: [toolResult(toolUse, "not-yet-released")] },
      ];
      await assert.rejects(
        session.messages.create({ max_tokens: 71, messages: continuationTranscript }),
        UnsupportedFeatureError,
      );
      assert.equal(agentResult, undefined, "a declined continuation must not release caller results to MCP");
      assert.equal(session.state, "awaiting_tools");
      allowContinuation = true;
      const final = await session.messages.create({ max_tokens: 73, messages: continuationTranscript });
      assert.deepEqual(final.content, [{ type: "text", text: "admitted" }]);
      assert.equal(agentResult.body.result.content[0].text, "not-yet-released");
      assert.deepEqual(fixture.admissionRequests.map(({ kind, maxTokens }) => ({ kind, maxTokens })), [
        { kind: "prompt", maxTokens: 67 },
        { kind: "tool_continuation", maxTokens: 71 },
        { kind: "tool_continuation", maxTokens: 73 },
      ]);
      assert.equal(fixture.promptRequests.length, 1);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("driver preparation accepts and buffers ACP output before nonstream/stream continuation consumption", async (t) => {
  for (const streaming of [false, true]) {
    await t.test(streaming ? "streamTools" : "continueTools", async () => withTempDirectory(async (root) => {
      const outputSent = deferred();
      const ordering = [];
      const fixture = createPromptSdk(root, {
        wrapDriver(driver) {
          return {
            ...driver,
            async prepareToolContinuation(continuation) {
              await driver.prepareToolContinuation(continuation);
              ordering.push("prepared");
            },
            async continueTools(continuation) {
              await outputSent.promise;
              ordering.push("consumer");
              return driver.continueTools(continuation);
            },
            async *streamTools(continuation) {
              await outputSent.promise;
              ordering.push("consumer");
              yield* driver.streamTools(continuation);
            },
          };
        },
        onPrompt(message, child) {
          void (async () => {
            const mcp = await initializeFakeMcp(mcpServerFromChild(child));
            sendPromptText(child, message.params.sessionId, "before handoff");
            const toolResult = await mcp.call("prepare-order", 681);
            ordering.push("MCP response returned");
            sendPromptText(child, message.params.sessionId, "output before driver read");
            child.reply(message.id, { stopReason: "end_turn" });
            ordering.push("ACP terminal sent");
            outputSent.resolve();
            assert.equal(toolResult.body.result.content[0].text, "accepted");
          })().catch((error) => {
            ordering.push(`agent-error:${error?.message ?? "unknown"}`);
            child.exit(1);
          });
        },
      });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: `/workspace/prepare-${streaming}`, tools: callerTools });
      try {
        await session.tools.createMcpServer();
        const userMessage = { role: "user", content: "prepare before results" };
        const first = await session.messages.create({ max_tokens: 31, messages: [userMessage] });
        const toolUse = first.content.find(({ type }) => type === "tool_use");
        assert.ok(toolUse);
        const continuationRequest = {
          max_tokens: 37,
          messages: [userMessage, { role: "assistant", content: first.content }, {
            role: "user", content: [toolResult(toolUse, "accepted")],
          }],
          ...(streaming ? { stream: true } : {}),
        };
        const response = await session.messages.create(continuationRequest);
        if (streaming) {
          const events = [];
          for await (const event of response) events.push(event);
          assert.ok(events.some((event) => event.type === "content_block_delta" &&
            event.delta.type === "text_delta" && event.delta.text === "output before driver read"));
          assert.equal(events.at(-1).type, "message_stop");
        } else {
          assert.deepEqual(response.content, [{ type: "text", text: "output before driver read" }]);
        }
        assert.deepEqual(ordering, ["prepared", "MCP response returned", "ACP terminal sent", "consumer"]);
        assert.equal(fixture.promptRequests.length, 1, "continuation reuses the sole outstanding ACP prompt");
        assert.equal(session.state, "idle");
        assert.equal((await session.diagnostics.toolHandoffs())[0].resultState, "acknowledged");
      } finally {
        outputSent.resolve();
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("abort after prepared continuation fails closed with uncertain receipts and no false completion", async () => {
  await withTempDirectory(async (root) => {
    const outputSent = deferred();
    const releaseConsumer = deferred();
    const fixture = createPromptSdk(root, {
      wrapDriver(driver) {
        return {
          ...driver,
          async continueTools(continuation) {
            await outputSent.promise;
            await releaseConsumer.promise;
            return driver.continueTools(continuation);
          },
        };
      },
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "before cancellation");
          await mcp.call("cancel-after-release", 691);
          sendPromptText(child, message.params.sessionId, "buffered before cancellation");
          child.reply(message.id, { stopReason: "end_turn" });
          outputSent.resolve();
        })().catch(() => child.exit(1));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/cancel-prepared", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const userMessage = { role: "user", content: "cancel after result release" };
      const first = await session.messages.create({ max_tokens: 109, messages: [userMessage] });
      const toolUse = first.content.find(({ type }) => type === "tool_use");
      assert.ok(toolUse);
      const controller = new AbortController();
      const continuation = session.messages.create({
        max_tokens: 113,
        messages: [userMessage, { role: "assistant", content: first.content }, {
          role: "user", content: [toolResult(toolUse, "accepted-before-abort")],
        }],
      }, { signal: controller.signal });
      await outputSent.promise;
      controller.abort();
      releaseConsumer.resolve();
      await assert.rejects(continuation, RequestAbortedError);
      assert.equal(session.state, "interrupted");
      assert.equal(fixture.promptRequests.length, 1);
      const receipt = (await session.diagnostics.toolHandoffs())[0];
      assert.equal(receipt.resultState, "uncertain");
      assert.equal(receipt.result.content[0].text, "accepted-before-abort");
    } finally {
      releaseConsumer.resolve();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("failed MCP response delivery after preparation never invokes the ACP continuation", async () => {
  await withTempDirectory(async (root) => {
    const marker = "hold-built-in-mcp-response";
    const originalEnd = ServerResponse.prototype.end;
    let heldResponse;
    let reportHeld;
    const held = new Promise((resolve) => { reportHeld = resolve; });
    let prepared;
    let continuationCalls = 0;
    ServerResponse.prototype.end = function (...args) {
      if (!heldResponse && typeof args[0] === "string" && args[0].includes(marker)) {
        heldResponse = this;
        reportHeld();
        return this;
      }
      return originalEnd.apply(this, args);
    };
    const fixture = createPromptSdk(root, {
      wrapDriver(driver) {
        return {
          ...driver,
          async prepareToolContinuation(continuation) {
            await driver.prepareToolContinuation(continuation);
            prepared = true;
          },
          async continueTools(continuation) {
            continuationCalls += 1;
            return driver.continueTools(continuation);
          },
        };
      },
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "waiting on caller result");
          await mcp.call("held-response", 699);
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch(() => undefined);
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/failed-delivery", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const userMessage = { role: "user", content: "response delivery failure" };
      const first = await session.messages.create({ max_tokens: 127, messages: [userMessage] });
      const toolUse = first.content.find(({ type }) => type === "tool_use");
      assert.ok(toolUse);
      const controller = new AbortController();
      const continuation = session.messages.create({
        max_tokens: 131,
        messages: [userMessage, { role: "assistant", content: first.content }, {
          role: "user", content: [toolResult(toolUse, marker)],
        }],
      }, { signal: controller.signal });
      await held;
      assert.equal(prepared, true, "the ACP turn was prepared before results were written to MCP");
      const abortStarted = Date.now();
      controller.abort();
      await assert.rejects(continuation, (error) => error instanceof RequestAbortedError || error instanceof ProtocolFailureError);
      assert.ok(Date.now() - abortStarted < 1_000);
      assert.equal(heldResponse.destroyed, true);
      assert.equal(continuationCalls, 0);
      assert.equal(session.state, "interrupted");
      const receipt = (await session.diagnostics.toolHandoffs())[0];
      assert.equal(receipt.resultState, "uncertain");
      assert.equal(receipt.result.content[0].text, marker);
      assert.equal(fixture.promptRequests.length, 1);
    } finally {
      ServerResponse.prototype.end = originalEnd;
      heldResponse?.destroy();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("lost MCP waiters, ACP crashes, and session close interrupt or clean up the parked prompt", async (t) => {
  await t.test("MCP client disconnect sends one bounded ACP cancel", async () => withTempDirectory(async (root) => {
    const started = deferred();
    const controller = new AbortController();
    const agent = { prompt: undefined, callError: undefined };
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        agent.prompt = message;
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "waiting for caller");
          started.resolve();
          await mcp.call("disconnect", 801, controller.signal).catch((error) => { agent.callError = error; });
        })().catch(() => undefined);
      },
      onCancel(_message, child) {
        if (agent.prompt) child.reply(agent.prompt.id, { stopReason: "cancelled" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/disconnect", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const first = await session.messages.create({ max_tokens: 79, messages: [{ role: "user", content: "disconnect" }] });
      assert.ok(first.content.some(({ type }) => type === "tool_use"));
      await started.promise;
      controller.abort();
      await waitFor(() => session.state === "interrupted", "lost MCP waiter did not interrupt the session");
      assert.ok(agent.callError);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 1);
      assert.equal(fixture.promptRequests.length, 1);
    } finally {
      controller.abort();
      await session.close();
      await fixture.sdk.close();
    }
  }));

  await t.test("ACP process crash while the prompt is parked rejects the MCP waiter", async () => withTempDirectory(async (root) => {
    const started = deferred();
    const agent = { callPromise: undefined, callResult: undefined };
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "parked before crash");
          agent.callPromise = mcp.call("crash", 811).then((result) => { agent.callResult = result; });
          void agent.callPromise.catch(() => undefined);
          started.resolve();
        })().catch(() => child.exit(1));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/crash", tools: callerTools });
    try {
      await session.tools.createMcpServer();
      const first = await session.messages.create({ max_tokens: 83, messages: [{ role: "user", content: "crash" }] });
      assert.ok(first.content.some(({ type }) => type === "tool_use"));
      await started.promise;
      fixture.children[0].exit(1);
      await waitFor(() => session.state === "interrupted", "ACP child failure left the parked session live");
      await agent.callPromise;
      assert.equal(agent.callResult?.body?.error?.code, -32800);
      assert.equal(session.state, "interrupted");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  }));

  await t.test("closing a session cancels its parked prompt and MCP request within the cleanup bound", async () => withTempDirectory(async (root) => {
    const started = deferred();
    const agent = { prompt: undefined, callPromise: undefined };
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        agent.prompt = message;
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, "waiting before close");
          agent.callPromise = mcp.call("close", 821).catch((error) => error);
          started.resolve();
        })().catch(() => child.exit(1));
      },
      onCancel(_message, child) {
        if (agent.prompt) child.reply(agent.prompt.id, { stopReason: "cancelled" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/close", tools: callerTools });
    await session.tools.createMcpServer();
    try {
      await session.messages.create({ max_tokens: 89, messages: [{ role: "user", content: "close" }] });
      await started.promise;
      const before = Date.now();
      await session.close();
      assert.ok(Date.now() - before < 1_000);
      assert.equal(session.state, "closed");
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 1);
      await agent.callPromise;
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  }));
});

test("authoritative MCP call feeds stay bound to their owning account, session, and catalog", async () => {
  await withTempDirectory(async (root) => {
    const agentResults = [];
    const fixture = createPromptSdk(root, {
      onPrompt(message, child, index) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, `account-${index} waiting`);
          const result = await mcp.call(`account-${index}`, 901 + index);
          agentResults[index] = result;
          sendPromptText(child, message.params.sessionId, `account-${index} done`);
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch(() => child.exit(1));
      },
    });
    const firstAccount = await fixture.sdk.accounts.create();
    const secondAccount = await fixture.sdk.accounts.create();
    const first = await firstAccount.sessions.create({ model: "model-a", cwd: "/workspace/account-a", tools: callerTools });
    const second = await secondAccount.sessions.create({ model: "model-a", cwd: "/workspace/account-b", tools: callerTools });
    try {
      await Promise.all([first.tools.createMcpServer(), second.tools.createMcpServer()]);
      const firstUser = { role: "user", content: "A" };
      const secondUser = { role: "user", content: "B" };
      const firstMessages = await Promise.all([
        first.messages.create({ max_tokens: 97, messages: [firstUser] }),
        second.messages.create({ max_tokens: 101, messages: [secondUser] }),
      ]);
      const firstCall = firstMessages[0].content.find(({ type }) => type === "tool_use");
      const secondCall = firstMessages[1].content.find(({ type }) => type === "tool_use");
      assert.ok(firstCall && secondCall);
      assert.notEqual(firstCall.id, secondCall.id);
      const final = await Promise.all([
        first.messages.create({ max_tokens: 103, messages: [firstUser, { role: "assistant", content: firstMessages[0].content }, {
          role: "user", content: [toolResult(firstCall, "only-A")],
        }] }),
        second.messages.create({ max_tokens: 107, messages: [secondUser, { role: "assistant", content: firstMessages[1].content }, {
          role: "user", content: [toolResult(secondCall, "only-B")],
        }] }),
      ]);
      assert.deepEqual(final.map((message) => message.content), [
        [{ type: "text", text: "account-0 done" }],
        [{ type: "text", text: "account-1 done" }],
      ]);
      assert.equal(agentResults[0].body.result.content[0].text, "only-A");
      assert.equal(agentResults[1].body.result.content[0].text, "only-B");
      assert.equal(fixture.promptRequests.length, 2);
      assert.notEqual(fixture.promptRequests[0].params.sessionId, fixture.promptRequests[1].params.sessionId);
      for (const [index, session] of [first, second].entries()) {
        const receipts = await session.diagnostics.toolHandoffs();
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].accountId, session.accountId);
        assert.equal(receipts[0].sessionId, session.sessionId);
        assert.equal(receipts[0].result.content[0].text, index === 0 ? "only-A" : "only-B");
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
      await fixture.sdk.close();
    }
  });
});

test("documented ACP v1 optional metadata is accepted and ignored in streaming and nonstreaming", async (t) => {
  for (const streaming of [false, true]) {
    await t.test(streaming ? "streaming" : "nonstreaming", async () => withTempDirectory(async (root) => {
      const fixture = createPromptSdk(root, {
        onPrompt(message, child) {
          sendPromptText(child, message.params.sessionId, "metadata-safe", {
            paramsMeta: { requestTrace: { id: "trace-1", attempt: 1 } },
            updateMeta: { provider: { generation: "v1" } },
            contentMeta: { display: { emphasis: false } },
            annotations: {
              audience: ["assistant", "user"],
              priority: 1.1,
              lastModified: "2026-10-31T12:00:00Z",
              _meta: {},
            },
            messageId: "agent-message-1",
          });
          child.reply(message.id, {
            stopReason: "end_turn",
            _meta: { terminalTrace: "trace-1" },
            usage: null,
          });
        },
      });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
      try {
        const request = {
          max_tokens: 10,
          messages: [{ role: "user", content: "metadata" }],
          ...(streaming ? { stream: true } : {}),
        };
        const result = await session.messages.create(request);
        if (streaming) {
          const events = [];
          for await (const event of result) events.push(event);
          assert.ok(events.some((event) => event.type === "content_block_delta" &&
            event.delta.type === "text_delta" && event.delta.text === "metadata-safe"));
          const terminal = events.find((event) => event.type === "message_delta");
          assert.equal(terminal.usage.input_tokens, 0);
          assert.equal(terminal.usage.output_tokens, 0);
          assert.equal(events.at(-1).type, "message_stop");
          assert.equal((await session.diagnostics.snapshot()).usage.kind, "unknown");
        } else {
          assert.deepEqual(result.content, [{ type: "text", text: "metadata-safe" }]);
          assert.equal(result.stop_reason, "end_turn");
          assert.equal(result.usage.input_tokens, 0, "null ACP usage is normalized to the documented unknown placeholder");
          assert.equal(result.usage.output_tokens, 0);
          assert.equal((await session.diagnostics.snapshot()).usage.kind, "unknown");
        }
        assert.equal(session.state, "idle");
      } finally {
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("ACP v1 nullable optional metadata is accepted in streaming and nonstreaming", async (t) => {
  for (const streaming of [false, true]) {
    await t.test(streaming ? "streaming" : "nonstreaming", async () => withTempDirectory(async (root) => {
      const fixture = createPromptSdk(root, {
        onPrompt(message, child) {
          sendPromptText(child, message.params.sessionId, "nullable ", {
            paramsMeta: null,
            updateMeta: null,
            contentMeta: null,
            annotations: null,
            messageId: null,
          });
          sendPromptText(child, message.params.sessionId, "annotations ", {
            annotations: {
              audience: null,
              priority: null,
              lastModified: null,
              _meta: null,
            },
          });
          sendPromptText(child, message.params.sessionId, "meta", {
            annotations: {
              _meta: {},
            },
          });
          child.reply(message.id, { stopReason: "end_turn", _meta: null, usage: null });
        },
      });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
      try {
        const request = {
          max_tokens: 10,
          messages: [{ role: "user", content: "nullable metadata" }],
          ...(streaming ? { stream: true } : {}),
        };
        const result = await session.messages.create(request);
        if (streaming) {
          const events = [];
          for await (const event of result) events.push(event);
          assert.equal(events
            .filter((event) => event.type === "content_block_delta" && event.delta.type === "text_delta")
            .map((event) => event.delta.text).join(""), "nullable annotations meta");
          assert.equal(events.at(-1).type, "message_stop");
          assert.equal(events.find((event) => event.type === "message_delta").usage.output_tokens, 0);
        } else {
          assert.deepEqual(result.content, [{ type: "text", text: "nullable annotations meta" }]);
          assert.equal(result.usage.output_tokens, 0);
        }
        assert.equal((await session.diagnostics.snapshot()).usage.kind, "unknown");
      } finally {
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("malformed optional ACP metadata is rejected in both stream and dispatch paths", async (t) => {
  const malformed = [
    ["notification params _meta", (message, child) => sendPromptText(child, message.params.sessionId, "x", { paramsMeta: [] })],
    ["agent chunk _meta", (message, child) => sendPromptText(child, message.params.sessionId, "x", { updateMeta: "not-an-object" })],
    ["text content _meta", (message, child) => sendPromptText(child, message.params.sessionId, "x", { contentMeta: "not-an-object" })],
    ["text annotations audience", (message, child) => sendPromptText(child, message.params.sessionId, "x", { annotations: { audience: ["system"] } })],
    ["text annotations priority", (message, child) => sendPromptText(child, message.params.sessionId, "x", { annotations: { priority: "high" } })],
    ["text annotations lastModified", (message, child) => sendPromptText(child, message.params.sessionId, "x", { annotations: { lastModified: 123 } })],
    ["text annotations _meta", (message, child) => sendPromptText(child, message.params.sessionId, "x", { annotations: { _meta: [] } })],
    ["text annotations object", (message, child) => sendPromptText(child, message.params.sessionId, "x", { annotations: "not-an-object" })],
    ["agent chunk messageId", (message, child) => sendPromptText(child, message.params.sessionId, "x", { messageId: 9 })],
    ["terminal response _meta", (message, child) => {
      sendPromptText(child, message.params.sessionId, "x");
      child.reply(message.id, { stopReason: "end_turn", _meta: [] });
    }],
    ["terminal response usage", (message, child) => {
      sendPromptText(child, message.params.sessionId, "x");
      child.reply(message.id, { stopReason: "end_turn", usage: "not-an-object" });
    }],
  ];
  for (const [name, onPrompt] of malformed) {
    for (const streaming of [false, true]) {
      await t.test(`${name} (${streaming ? "stream" : "nonstream"})`, async () => withTempDirectory(async (root) => {
        const fixture = createPromptSdk(root, { onPrompt });
        const account = await fixture.sdk.accounts.create();
        const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
        try {
          const request = {
            max_tokens: 10,
            messages: [{ role: "user", content: name }],
            ...(streaming ? { stream: true } : {}),
          };
          if (streaming) {
            const stream = await session.messages.create(request);
            await assert.rejects(async () => {
              for await (const _event of stream) { /* consume until the protocol error */ }
            }, ProtocolFailureError);
          } else {
            await assert.rejects(session.messages.create(request), ProtocolFailureError);
          }
          assert.equal(session.state, "interrupted");
          assert.deepEqual(session.snapshot().transcript, []);
        } finally {
          await session.close();
          await fixture.sdk.close();
        }
      }));
    }
  }
});

test("the prompt pump rechecks terminal-session failures after yielding completion", async () => {
  await withTempDirectory(async (root) => {
    let emitLateUpdate;
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "before terminal");
        emitLateUpdate = () => sendPromptText(child, message.params.sessionId, "after terminal");
        child.reply(message.id, { stopReason: "end_turn" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      const signal = new AbortController().signal;
      const admission = await fixture.drivers[0].admitResponse({
        kind: "prompt",
        operationId: "pump-late-update",
        accountId: session.accountId,
        sessionId: session.sessionId,
        maxTokens: 9,
        policy: "strict",
        signal,
      });
      const operation = {
        operationId: "pump-late-update",
        accountId: session.accountId,
        sessionId: session.sessionId,
        configuration: session.configuration,
        messages: [{ role: "user", content: "direct pump" }],
        acpPrompt: [{ type: "text", text: "[user]\ndirect pump" }],
        maxTokens: 9,
        admission,
        signal,
      };
      const iterator = fixture.drivers[0].stream(operation)[Symbol.asyncIterator]();
      assert.deepEqual(await iterator.next(), { done: false, value: { type: "text", text: "before terminal" } });
      const terminal = await iterator.next();
      assert.equal(terminal.value.type, "complete");
      emitLateUpdate(); // the pump is suspended at its complete yield
      await assert.rejects(iterator.next(), ProtocolFailureError);
      assert.equal(session.snapshot().transcript.length, 0);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("abort while the pump is suspended at completion rejects instead of reporting EOF", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "complete then abort");
        child.reply(message.id, { stopReason: "end_turn" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      const controller = new AbortController();
      const admission = await fixture.drivers[0].admitResponse({
        kind: "prompt",
        operationId: "pump-late-abort",
        accountId: session.accountId,
        sessionId: session.sessionId,
        maxTokens: 9,
        policy: "strict",
        signal: controller.signal,
      });
      const iterator = fixture.drivers[0].stream({
        operationId: "pump-late-abort",
        accountId: session.accountId,
        sessionId: session.sessionId,
        configuration: session.configuration,
        messages: [{ role: "user", content: "direct pump" }],
        acpPrompt: [{ type: "text", text: "[user]\ndirect pump" }],
        maxTokens: 9,
        admission,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type, "text");
      assert.equal((await iterator.next()).value.type, "complete");
      controller.abort();
      await assert.rejects(iterator.next(), RequestAbortedError);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("a post-completion ACP update prevents Session Messages stream commit", async () => {
  await withTempDirectory(async (root) => {
    let emitLateUpdate;
    const releaseComplete = deferred();
    const completeYielded = deferred();
    const lateUpdateObserved = deferred();
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "before terminal");
        emitLateUpdate = () => sendPromptText(child, message.params.sessionId, "after terminal");
        child.reply(message.id, { stopReason: "end_turn" });
      },
      wrapDriver(driver) {
        return {
          ...driver,
          stream(operation) {
            const source = driver.stream(operation);
            return {
              async *[Symbol.asyncIterator]() {
                for await (const event of source) {
                  if (event.type === "complete") {
                    completeYielded.resolve();
                    emitLateUpdate();
                    lateUpdateObserved.resolve();
                    await releaseComplete.promise;
                  }
                  yield event;
                }
              },
            };
          },
        };
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      const stream = await session.messages.create({
        max_tokens: 12,
        messages: [{ role: "user", content: "late update" }],
        stream: true,
      });
      const events = [];
      const consuming = (async () => {
        for await (const event of stream) events.push(event);
      })();
      await completeYielded.promise;
      await lateUpdateObserved.promise;
      releaseComplete.resolve();
      await assert.rejects(consuming, ProtocolFailureError);
      assert.equal(events.some((event) => event.type === "message_stop"), false);
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, [], "the late protocol failure cannot commit the acknowledged text");
    } finally {
      releaseComplete.resolve();
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP v1 available commands and context usage are validated then discarded across owned lifecycle phases", async () => {
  await withTempDirectory(async (root) => {
    let promptIndex = 0;
    const fixture = createPromptSdk(root, {
      onSessionNew(message, child, index, startup) {
        const remoteSessionId = `remote-prompt-${index}-1`;
        // Both notifications precede session/new's response and must be
        // reconciled against its returned ID rather than buffered as output.
        sendSessionUpdate(child, remoteSessionId, availableCommandsUpdate("startup-command-secret"));
        sendSessionUpdate(child, remoteSessionId, usageUpdate("startup-usage-secret"));
        startup(message, child);
        // These follow the response on the wire and can be handled as startup
        // housekeeping or idle updates depending on promise scheduling.
        sendSessionUpdate(child, remoteSessionId, availableCommandsUpdate("post-new-command-secret"));
        sendSessionUpdate(child, remoteSessionId, usageUpdate("post-new-usage-secret"));
      },
      onPrompt(message, child) {
        const sessionId = message.params.sessionId;
        const index = promptIndex++;
        sendSessionUpdate(child, sessionId, availableCommandsUpdate(`prompt-command-secret-${index}`));
        sendSessionUpdate(child, sessionId, usageUpdate(`prompt-usage-secret-${index}`));
        sendPromptText(child, sessionId, `answer-${index}`);
        child.reply(message.id, { stopReason: "end_turn" });
        // Allowed terminal housekeeping; a late text chunk remains forbidden.
        sendSessionUpdate(child, sessionId, usageUpdate(`terminal-usage-secret-${index}`));
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/discarded-updates" });
    try {
      assert.equal(session.capabilities.maxTokens, "enforced");
      const nextNotification = fixture.drivers[0].notifications()[Symbol.asyncIterator]().next();
      assert.equal(await Promise.race([nextNotification.then(() => true), sleep(20).then(() => false)]), false,
        "discarded command and context-usage updates never enter the session notification feed");
      const child = fixture.children[0];
      sendSessionUpdate(child, "remote-prompt-0-1", availableCommandsUpdate("idle-command-secret"));
      sendSessionUpdate(child, "remote-prompt-0-1", usageUpdate("idle-usage-secret"));
      await new Promise((resolve) => setImmediate(resolve));

      const first = await session.messages.create({ max_tokens: 11, messages: [{ role: "user", content: "first" }] });
      assert.deepEqual(first.content, [{ type: "text", text: "answer-0" }]);
      assert.equal(first.usage.input_tokens, 0);
      assert.equal(first.usage.output_tokens, 0);
      assert.equal(messageMaxTokensEnforcement(first).outcome, "enforced");

      const stream = await session.messages.create({
        max_tokens: 12,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: first.content },
          { role: "user", content: "second" },
        ],
        stream: true,
      });
      const events = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.filter((event) => event.type === "content_block_delta" &&
        event.delta.type === "text_delta").map((event) => event.delta.text).join(""), "answer-1");
      const terminal = events.find((event) => event.type === "message_delta");
      assert.equal(terminal.usage.input_tokens, 0);
      assert.equal(terminal.usage.output_tokens, 0);
      assert.equal(events.at(-1).type, "message_stop");
      assert.equal(messageMaxTokensEnforcement(events.find((event) => event.type === "message_start").message).outcome,
        "enforced");
      const snapshot = await session.diagnostics.snapshot();
      assert.equal(snapshot.usage.kind, "unknown");
      assert.equal(snapshot.maxTokensEnforcement.policy, "strict");
      assert.equal(JSON.stringify({ first, events, snapshot }).includes("secret"), false);
      assert.equal(session.state, "idle");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("pre-session ACP command/usage updates reconcile exact ownership and reject malformed or oversized data", async (t) => {
  const scenarios = [
    ["foreign startup session ID", (child, sessionId) =>
      sendSessionUpdate(child, `${sessionId}-foreign`, availableCommandsUpdate("foreign"))],
    ["oversized command description", (child, sessionId) => sendSessionUpdate(child, sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "too-large", description: "x".repeat(16 * 1024 + 1) }],
    })],
    ["malformed usage update", (child, sessionId) =>
      sendSessionUpdate(child, sessionId, { sessionUpdate: "usage_update", used: 1 })],
    ["unknown update field", (child, sessionId) => sendSessionUpdate(child, sessionId, {
      ...usageUpdate(), unexpected: "must-fail-closed",
    })],
    ["bounded startup notification count", (child, sessionId) => {
      for (let index = 0; index < 257 && !child.ended; index += 1) {
        sendSessionUpdate(child, sessionId, { sessionUpdate: "usage_update", used: index, size: 8_192 });
      }
    }],
    ["bounded startup notification bytes", (child, sessionId) => {
      const opaque = "x".repeat(250 * 1024);
      for (let index = 0; index < 17 && !child.ended; index += 1) {
        sendSessionUpdate(child, sessionId, {
          sessionUpdate: "usage_update",
          used: index,
          size: 8_192,
          _meta: { opaque },
        });
      }
    }],
  ];
  for (const [name, emit] of scenarios) {
    await t.test(name, async () => withTempDirectory(async (root) => {
      const fixture = createPromptSdk(root, {
        onSessionNew(message, child, index, startup) {
          const sessionId = `remote-prompt-${index}-1`;
          emit(child, sessionId);
          if (!child.ended) startup(message, child);
        },
      });
      const account = await fixture.sdk.accounts.create();
      await assert.rejects(
        account.sessions.create({ model: "model-a", cwd: `/workspace/${name.replaceAll(" ", "-")}` }),
        ProtocolFailureError,
      );
      assert.equal(fixture.children[0].ended, true);
      await fixture.sdk.close();
    }));
  }
});

test("idle ACP command/usage updates have a cumulative byte bound", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root);
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/idle-bound" });
    try {
      const largeMeta = "x".repeat(255 * 1024);
      for (let index = 0; index < 33; index += 1) {
        sendSessionUpdate(fixture.children[0], "remote-prompt-0-1", {
          sessionUpdate: "usage_update",
          used: index,
          size: 8_192,
          _meta: { opaque: largeMeta },
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        session.messages.create({ max_tokens: 10, messages: [{ role: "user", content: "after idle flood" }] }),
        ProtocolFailureError,
      );
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, []);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP v1 progress, mode, session-info, and config updates are bounded non-output observations across phases", async () => {
  await withTempDirectory(async (root) => {
    const updates = nonOutputSessionUpdates();
    let promptIndex = 0;
    const fixture = createPromptSdk(root, {
      onSessionNew(message, child, index, startup) {
        const sessionId = `remote-prompt-${index}-1`;
        for (const update of updates) sendSessionUpdate(child, sessionId, update);
        startup(message, child);
        for (const update of updates) sendSessionUpdate(child, sessionId, update);
      },
      onPrompt(message, child) {
        const sessionId = message.params.sessionId;
        const index = promptIndex++;
        for (const update of updates) sendSessionUpdate(child, sessionId, update);
        sendPromptText(child, sessionId, `answer-${index}`);
        child.reply(message.id, { stopReason: "end_turn" });
        // Non-output session housekeeping can follow the terminal reply; text cannot.
        sendSessionUpdate(child, sessionId, {
          sessionUpdate: "session_info_update", title: null, updatedAt: null,
        });
        sendSessionUpdate(child, sessionId, { sessionUpdate: "plan_removed", planId: "plan-1" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/non-output" });
    try {
      for (const update of updates) sendSessionUpdate(fixture.children[0], "remote-prompt-0-1", update);
      await new Promise((resolve) => setImmediate(resolve));

      const first = await session.messages.create({ max_tokens: 10, messages: [{ role: "user", content: "first" }] });
      assert.deepEqual(first.content, [{ type: "text", text: "answer-0" }]);
      const streamed = await session.messages.create({
        max_tokens: 10,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: first.content },
          { role: "user", content: "second" },
        ],
        stream: true,
      });
      const events = [];
      for await (const event of streamed) events.push(event);
      assert.equal(events.filter((event) => event.type === "content_block_delta" &&
        event.delta.type === "text_delta").map((event) => event.delta.text).join(""), "answer-1");
      assert.equal(JSON.stringify({ first, events }).includes("observational-"), false);
      assert.equal(session.state, "idle");
      assert.equal((await session.diagnostics.snapshot()).usage.kind, "unknown",
        "usage_update context occupancy is not per-response token accounting");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP session-update schema gaps fail closed for wrong sessions, invalid shapes, limits, and unsupported user echoes", async (t) => {
  const oversizedPlanEntries = Array.from({ length: 257 }, () => ({
    content: "bounded plan entry", priority: "low", status: "pending",
  }));
  const scenarios = [
    {
      name: "unknown plan field during startup",
      phase: "startup",
      update: { sessionUpdate: "plan", entries: [], unrecognized: true },
    },
    {
      name: "invalid plan entry enum during startup",
      phase: "startup",
      update: { sessionUpdate: "plan", entries: [{ content: "x", priority: "urgent", status: "pending" }] },
    },
    {
      name: "oversized plan entry count while idle",
      phase: "idle",
      update: { sessionUpdate: "plan", entries: oversizedPlanEntries },
    },
    {
      name: "oversized markdown plan while prompting",
      phase: "prompt",
      update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", content: "x".repeat(16 * 1024 + 1) } },
    },
    {
      name: "foreign session mode notification while idle",
      phase: "idle",
      foreign: true,
      update: { sessionUpdate: "current_mode_update", currentModeId: "safe-mode" },
    },
    {
      name: "malformed session info during prompting",
      phase: "prompt",
      update: { sessionUpdate: "session_info_update", title: 7 },
    },
    {
      name: "missing required config option name while idle",
      phase: "idle",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", type: "select", currentValue: "model-a", options: [], category: "model" }],
      },
    },
    {
      name: "omitted pinned model selector while idle",
      phase: "idle",
      update: { sessionUpdate: "config_option_update", configOptions: [] },
    },
    {
      name: "changed pinned model during prompt",
      phase: "prompt",
      update: pinnedConfigOptionUpdate("model-b"),
    },
    {
      name: "valid user-message chunk is not silently discarded",
      phase: "prompt",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "agent asserted a changed user message" },
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => withTempDirectory(async (root) => {
      const emit = (child, sessionId) => sendSessionUpdate(
        child,
        scenario.foreign ? `${sessionId}-foreign` : sessionId,
        scenario.update,
      );
      const fixture = createPromptSdk(root, {
        ...(scenario.phase === "startup" ? {
          onSessionNew(message, child, index, startup) {
            emit(child, `remote-prompt-${index}-1`);
            if (!child.ended) startup(message, child);
          },
        } : {}),
        ...(scenario.phase === "prompt" ? {
          onPrompt(message, child) {
            emit(child, message.params.sessionId);
            if (!child.ended) {
              sendPromptText(child, message.params.sessionId, "must not commit");
              child.reply(message.id, { stopReason: "end_turn" });
            }
          },
        } : {}),
      });
      const account = await fixture.sdk.accounts.create();
      if (scenario.phase === "startup") {
        await assert.rejects(
          account.sessions.create({ model: "model-a", cwd: "/workspace/startup-update-error" }),
          ProtocolFailureError,
        );
        assert.equal(fixture.children[0].ended, true);
      } else {
        const session = await account.sessions.create({ model: "model-a", cwd: "/workspace/update-error" });
        try {
          if (scenario.phase === "idle") {
            emit(fixture.children[0], "remote-prompt-0-1");
            await new Promise((resolve) => setImmediate(resolve));
          }
          await assert.rejects(
            session.messages.create({ max_tokens: 10, messages: [{ role: "user", content: scenario.name }] }),
            ProtocolFailureError,
          );
          assert.equal(session.state, "interrupted");
          assert.deepEqual(session.snapshot().transcript, []);
        } finally {
          await session.close();
        }
      }
      await fixture.sdk.close();
    }));
  }
});

test("an empty ACP text delta remains a real empty Messages text block in both modes", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "");
        child.reply(message.id, { stopReason: "end_turn" });
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      const firstInput = [{ role: "user", content: "empty" }];
      const nonstream = await session.messages.create({ max_tokens: 5, messages: firstInput });
      assert.deepEqual(nonstream.content, [{ type: "text", text: "" }]);
      const stream = await session.messages.create({
        max_tokens: 5,
        messages: [
          ...firstInput,
          { role: "assistant", content: nonstream.content },
          { role: "user", content: "empty again" },
        ],
        stream: true,
      });
      const events = [];
      for await (const event of stream) events.push(event);
      assert.ok(events.some((event) => event.type === "content_block_start" && event.content_block.type === "text"));
      assert.equal(events.some((event) => event.type === "content_block_delta"), false);
      assert.equal(events.at(-1).type, "message_stop");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("test-enforcer veto leaves the request retryable and does not send session/prompt", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, { enforceMaxTokens: () => false });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      await assert.rejects(
        session.messages.create({ max_tokens: 8, messages: [{ role: "user", content: "not admitted" }] }),
        UnsupportedFeatureError,
      );
      assert.equal(session.state, "idle");
      assert.equal(fixture.promptRequests.length, 0);
      assert.equal(fixture.requests.some(({ method }) => method === "session/prompt"), false);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/new").length, 1);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP documented terminal reasons map only when Messages semantics match", async (t) => {
  for (const stopReason of ["max_tokens", "refusal"]) {
    await t.test(stopReason, async () => withTempDirectory(async (root) => {
      const fixture = createPromptSdk(root, {
        onPrompt(message, child) {
          sendPromptText(child, message.params.sessionId, "terminal mapping");
          child.reply(message.id, { stopReason });
        },
      });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
      try {
        const response = await session.messages.create({
          max_tokens: 10,
          messages: [{ role: "user", content: stopReason }],
        });
        assert.equal(response.stop_reason, stopReason);
      } finally {
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("ACP prompt pump rejects foreign, malformed, and unsupported updates and unrepresentable terminal reasons", async (t) => {
  const scenarios = [
    ["foreign remote session update", (message, child) => {
      sendPromptText(child, "foreign-session", "not owned");
    }, ProtocolFailureError],
    ["malformed text update", (message, child) => {
      child.send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk" } },
      });
    }, ProtocolFailureError],
    ["unknown ACP activity update", (message, child) => {
      child.send({
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_thought_delta", text: "unknown" },
        },
      });
    }, ProtocolFailureError],
    ["malformed ACP thought activity", (message, child) => {
      child.send({
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text" } },
        },
      });
    }, ProtocolFailureError],
    ["agent text update after terminal response", (message, child) => {
      sendPromptText(child, message.params.sessionId, "complete text");
      child.reply(message.id, { stopReason: "end_turn" });
      sendPromptText(child, message.params.sessionId, "late text");
    }, ProtocolFailureError],
    ["ACP activity update after terminal response", (message, child) => {
      sendPromptText(child, message.params.sessionId, "complete text");
      child.reply(message.id, { stopReason: "end_turn" });
      child.send({
        jsonrpc: "2.0", method: "session/update",
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "late thought" } },
        },
      });
    }, ProtocolFailureError],
    ["unknown terminal stop reason", (message, child) => {
      sendPromptText(child, message.params.sessionId, "partial");
      child.reply(message.id, { stopReason: "mystery" });
    }, ProtocolFailureError],
    ["known but unrepresentable stop reason", (message, child) => {
      sendPromptText(child, message.params.sessionId, "partial");
      child.reply(message.id, { stopReason: "max_turn_requests" });
    }, UnsupportedFeatureError],
    ["terminal response cannot invent absent text", (message, child) => {
      child.reply(message.id, { stopReason: "end_turn" });
    }, ProtocolFailureError],
    ["malformed terminal response", (message, child) => {
      sendPromptText(child, message.params.sessionId, "partial");
      child.reply(message.id, { stopReason: 42 });
    }, ProtocolFailureError],
  ];
  for (const [name, onPrompt, ExpectedError] of scenarios) {
    await t.test(name, async () => withTempDirectory(async (root) => {
      const fixture = createPromptSdk(root, { onPrompt });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
      try {
        await assert.rejects(
          session.messages.create({ max_tokens: 20, messages: [{ role: "user", content: name }] }),
          ExpectedError,
        );
        assert.equal(session.state, "interrupted");
        assert.deepEqual(session.snapshot().transcript, [], "invalid protocol turns are not committed");
      } finally {
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("ACP process crash during prompt text is an interrupted failure, never a partial success", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "partial only");
        child.exit(1);
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      await assert.rejects(
        session.messages.create({ max_tokens: 20, messages: [{ role: "user", content: "crash" }] }),
        ProcessFailureError,
      );
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, []);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP prompt queue stays bounded when a streaming consumer is slow", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        for (let index = 0; index < 300 && !child.ended; index += 1) {
          sendPromptText(child, message.params.sessionId, "x");
        }
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      const stream = await session.messages.create({
        max_tokens: 20,
        messages: [{ role: "user", content: "slow consumer" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.value.type, "message_start");
      let failure;
      for (let index = 0; index < 1_000; index += 1) {
        try {
          const next = await iterator.next();
          if (next.done) break;
        } catch (error) {
          failure = error;
          break;
        }
      }
      assert.ok(failure instanceof ProtocolFailureError, "queue overflow fails closed instead of buffering without limit");
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, []);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP prompt queue enforces its byte bound independently of the total response limit", async () => {
  await withTempDirectory(async (root) => {
    const largeDelta = "x".repeat(900_000);
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        for (let index = 0; index < 8 && !child.ended; index += 1) {
          sendPromptText(child, message.params.sessionId, largeDelta);
        }
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    try {
      await assert.rejects(
        session.messages.create({ max_tokens: 20, messages: [{ role: "user", content: "large output" }] }),
        ProtocolFailureError,
      );
      assert.equal(session.state, "interrupted");
      assert.deepEqual(session.snapshot().transcript, []);
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("ACP stream consumer cancellation sends one session/cancel and performs bounded cleanup", async (t) => {
  for (const mode of ["return", "signal"]) {
    await t.test(mode, async () => withTempDirectory(async (root) => {
      let promptId;
      const fixture = createPromptSdk(root, {
        onPrompt(message, child) {
          promptId = message.id;
          sendPromptText(child, message.params.sessionId, "partial");
        },
        onCancel(_message, child) {
          if (promptId !== undefined) child.reply(promptId, { stopReason: "cancelled" });
        },
      });
      const account = await fixture.sdk.accounts.create();
      const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
      const controller = new AbortController();
      try {
        const stream = await session.messages.create({
          max_tokens: 20,
          messages: [{ role: "user", content: "cancel" }],
          stream: true,
        }, mode === "signal" ? { signal: controller.signal } : undefined);
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(first.value.type, "message_start");
        if (mode === "return") {
          await iterator.return();
        } else {
          controller.abort();
          let abortError;
          for (let index = 0; index < 10; index += 1) {
            try {
              const next = await iterator.next();
              if (next.done) break;
            } catch (error) {
              abortError = error;
              break;
            }
          }
          assert.ok(abortError instanceof RequestAbortedError);
        }
        assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 1);
        assert.equal(session.state, "interrupted");
        assert.deepEqual(session.snapshot().transcript, []);
      } finally {
        await session.close();
        await fixture.sdk.close();
      }
    }));
  }
});

test("ACP cancellation closes a worker whose prompt ignores session/cancel within the cleanup bound", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child) {
        sendPromptText(child, message.params.sessionId, "partial");
      },
    });
    const account = await fixture.sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    const controller = new AbortController();
    try {
      const stream = await session.messages.create({
        max_tokens: 20,
        messages: [{ role: "user", content: "abort unresponsive prompt" }],
        stream: true,
      }, { signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      const started = Date.now();
      let aborted = false;
      for (let index = 0; index < 10; index += 1) {
        try {
          const next = await iterator.next();
          if (next.done) break;
        } catch (error) {
          aborted = error instanceof RequestAbortedError;
          break;
        }
      }
      assert.equal(aborted, true);
      assert.ok(Date.now() - started < 1_000);
      assert.equal(fixture.requests.filter(({ method }) => method === "session/cancel").length, 1);
      assert.equal(fixture.children[0].ended, true, "an unacknowledged remote cancel terminates the child");
      assert.equal(session.state, "interrupted");
    } finally {
      await session.close();
      await fixture.sdk.close();
    }
  });
});

test("two account-bound ACP prompt pumps do not exchange session IDs, text, or admission ownership", async () => {
  await withTempDirectory(async (root) => {
    const fixture = createPromptSdk(root, {
      onPrompt(message, child, index) {
        sendPromptText(child, message.params.sessionId, `account-${index}`);
        child.reply(message.id, { stopReason: "end_turn" });
      },
    });
    const first = await fixture.sdk.accounts.create();
    const second = await fixture.sdk.accounts.create();
    const a = await first.sessions.create({ model: "model-a", cwd: "/workspace/a" });
    const b = await second.sessions.create({ model: "model-a", cwd: "/workspace/b" });
    try {
      const [answerA, answerB] = await Promise.all([
        a.messages.create({ max_tokens: 11, messages: [{ role: "user", content: "A" }] }),
        b.messages.create({ max_tokens: 13, messages: [{ role: "user", content: "B" }] }),
      ]);
      assert.deepEqual(answerA.content, [{ type: "text", text: "account-0" }]);
      assert.deepEqual(answerB.content, [{ type: "text", text: "account-1" }]);
      assert.notEqual(fixture.promptRequests[0].params.sessionId, fixture.promptRequests[1].params.sessionId);
      assert.deepEqual(fixture.admissionRequests.map(({ accountId, sessionId }) => ({ accountId, sessionId })).sort((x, y) => x.accountId.localeCompare(y.accountId)), [
        { accountId: a.accountId, sessionId: a.sessionId },
        { accountId: b.accountId, sessionId: b.sessionId },
      ].sort((x, y) => x.accountId.localeCompare(y.accountId)));
      assert.notEqual(fixture.children[0].spawnOptions.env.HOME, fixture.children[1].spawnOptions.env.HOME);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await fixture.sdk.close();
    }
  });
});

test("composed fake ACP/MCP integration isolates two accounts and two sessions through auth, tool handoff, logout, and close", async () => {
  await withTempDirectory(async (root) => {
    const authChildren = [];
    const agentResults = [];
    const fixture = createPromptSdk(root, {
      authProcessFactory: (_executable, _args, spawnOptions) => {
        const child = new FakeAcpChild(spawnOptions, {
          onRequest(message, current) {
            if (message.method === "initialize") {
              current.reply(message.id, {
                protocolVersion: 1,
                authMethods: [{ id: "oauth-personal", name: "Offline mock auth" }],
              });
            } else if (message.method === "authenticate") {
              current.reply(message.id, {});
            }
          },
        });
        authChildren.push(child);
        return child;
      },
      onPrompt(message, child, index) {
        void (async () => {
          const mcp = await initializeFakeMcp(mcpServerFromChild(child));
          sendPromptText(child, message.params.sessionId, `waiting-${index}`);
          agentResults[index] = await mcp.call(`private-key-${index}`, 920 + index);
          sendPromptText(child, message.params.sessionId, `complete-${index}`);
          child.reply(message.id, { stopReason: "end_turn" });
        })().catch(() => child.exit(1));
      },
    });
    const first = await fixture.sdk.accounts.create();
    const second = await fixture.sdk.accounts.create();
    assert.notEqual(first.id, second.id);

    await first.auth.login();
    assert.equal((await first.auth.status()).state, "authenticated");
    assert.equal((await second.auth.status()).state, "unknown", "auth status is profile-handle local");
    await second.auth.login();
    assert.equal((await second.auth.status()).state, "authenticated");
    assert.equal(authChildren.length, 2);
    assert.notEqual(authChildren[0].spawnOptions.env.HOME, authChildren[1].spawnOptions.env.HOME);

    const accounts = [first, second];
    const sessions = [];
    const mcpServers = [];
    for (const account of accounts) {
      for (let index = 0; index < 2; index += 1) {
        const session = await account.sessions.create({
          model: "model-a",
          cwd: `/workspace/${account.id}/${index}`,
          tools: callerTools,
        });
        sessions.push(session);
        mcpServers.push(await session.tools.createMcpServer());
      }
    }

    try {
      assert.equal(fixture.children.length, 4);
      assert.notEqual(fixture.children[0].spawnOptions.env.HOME, fixture.children[2].spawnOptions.env.HOME);
      assert.equal(fixture.children[0].spawnOptions.env.HOME, fixture.children[1].spawnOptions.env.HOME);
      assert.equal(fixture.children[2].spawnOptions.env.HOME, fixture.children[3].spawnOptions.env.HOME);

      const userMessages = sessions.map((_session, index) => ({ role: "user", content: `prompt-${index}` }));
      const firstResponses = await Promise.all(sessions.map((session, index) => session.messages.create({
        max_tokens: 31 + index,
        messages: [userMessages[index]],
      })));
      const toolCalls = firstResponses.map((response, index) => {
        const call = response.content.find((block) => block.type === "tool_use");
        assert.ok(call, `session ${index} receives its own ACP caller-tool request`);
        assert.deepEqual(call.input, { key: `private-key-${index}` });
        return call;
      });
      assert.equal(new Set(toolCalls.map(({ id }) => id)).size, 4);

      const finals = await Promise.all(sessions.map((session, index) => session.messages.create({
        max_tokens: 41 + index,
        messages: [
          userMessages[index],
          { role: "assistant", content: firstResponses[index].content },
          { role: "user", content: [toolResult(toolCalls[index], `caller-result-${index}`)] },
        ],
      })));
      assert.deepEqual(finals.map((response) => response.content), [
        [{ type: "text", text: "complete-0" }],
        [{ type: "text", text: "complete-1" }],
        [{ type: "text", text: "complete-2" }],
        [{ type: "text", text: "complete-3" }],
      ]);
      assert.deepEqual(agentResults.map(({ status, body }) => ({
        status,
        text: body.result?.content?.[0]?.text,
      })), [0, 1, 2, 3].map((index) => ({ status: 200, text: `caller-result-${index}` })));
      assert.deepEqual(
        fixture.admissionRequests.map(({ accountId, sessionId }) => ({ accountId, sessionId })).sort((a, b) =>
          `${a.accountId}/${a.sessionId}`.localeCompare(`${b.accountId}/${b.sessionId}`)),
        sessions.flatMap((session) => [session, session]).map(({ accountId, sessionId }) => ({ accountId, sessionId })).sort((a, b) =>
          `${a.accountId}/${a.sessionId}`.localeCompare(`${b.accountId}/${b.sessionId}`)),
      );
      for (const [index, session] of sessions.entries()) {
        const receipts = await session.diagnostics.toolHandoffs();
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].accountId, session.accountId);
        assert.equal(receipts[0].sessionId, session.sessionId);
        assert.equal(receipts[0].result.content[0].text, `caller-result-${index}`);
      }

      await first.auth.logout();
      assert.equal(sessions[0].state, "closed");
      assert.equal(sessions[1].state, "closed");
      assert.notEqual(sessions[2].state, "closed", "logging out account A leaves account B sessions owned");
      assert.notEqual(sessions[3].state, "closed", "logging out account A leaves account B sessions owned");
      await assert.rejects(() => fetch(mcpServers[0].url));
      await assert.rejects(() => fetch(mcpServers[1].url));

      await fixture.sdk.close();
      assert.equal(sessions[2].state, "closed");
      assert.equal(sessions[3].state, "closed");
      await assert.rejects(() => fetch(mcpServers[2].url));
      await assert.rejects(() => fetch(mcpServers[3].url));
      assert.equal(fixture.children.every((child) => child.ended), true, "all fake ACP children exited on logout/close");
      assert.equal(authChildren.every((child) => child.ended), true, "all fake auth children exited");
    } finally {
      await fixture.sdk.close();
    }
  });
});

test("logout closes the selected account's ACP worker and account-bound session", async () => {
  await withTempDirectory(async (root) => {
    const children = [];
    const { sdk } = createSdk(root, { onChildren: children });
    const account = await sdk.accounts.create();
    const session = await account.sessions.create({ model: "model-a", cwd: "/workspace" });
    await account.auth.logout();
    assert.equal(children[0].ended, true);
    assert.equal(session.state, "closed");
    await sdk.close();
  });
});

test("constructor and import remain process-lazy", async () => {
  await withTempDirectory(async (root) => {
    const sdk = new AntigravitySDK({ storageDir: join(root, "not-created"), executable: "/fake/agy-acp" });
    await sdk.close();
    assert.equal((await import("../dist/index.js")).AntigravitySDK, AntigravitySDK);
  });
});
