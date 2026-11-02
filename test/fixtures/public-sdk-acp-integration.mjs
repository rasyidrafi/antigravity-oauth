import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const delay = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay();
  }
}

class FakeAcpChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  writes = [];
  ended = false;
  promptCount = 0;
  constructor(options, index, onRequest) {
    super();
    this.spawnOptions = options;
    this.index = index;
    this.onRequest = onRequest;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        let message;
        try {
          message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
          this.writes.push(message);
          this.onRequest(message, this);
        } catch (error) {
          callback(error);
          return;
        }
        queueMicrotask(() => callback());
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => this.exit(0));
      },
    });
  }

  send(value) {
    if (this.ended || this.stdout.destroyed || this.stdout.writableEnded) return;
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  reply(id, result, error) {
    this.send(error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result });
  }

  async waitForResponse(id) {
    await waitFor(() => this.writes.some((message) => message.id === id &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))),
    `ACP request ${String(id)} did not receive a response`);
    return this.writes.find((message) => message.id === id &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")));
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

function sendText(child, sessionId, text, metadata = {}) {
  const {
    paramsMeta,
    updateMeta,
    messageId,
    annotations,
    contentMeta,
  } = metadata;
  child.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      ...(Object.hasOwn(metadata, "paramsMeta") ? { _meta: paramsMeta } : {}),
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(Object.hasOwn(metadata, "messageId") ? { messageId } : {}),
        ...(Object.hasOwn(metadata, "updateMeta") ? { _meta: updateMeta } : {}),
        content: {
          type: "text",
          text,
          ...(Object.hasOwn(metadata, "annotations") ? { annotations } : {}),
          ...(Object.hasOwn(metadata, "contentMeta") ? { _meta: contentMeta } : {}),
        },
      },
    },
  });
}

function sendActivity(child, sessionId, update, updateSessionId = sessionId) {
  child.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: updateSessionId, update },
  });
}

function sendDiscardedSessionUpdates(child, sessionId, label, { commands = true, usage = true } = {}) {
  if (commands) {
    sendActivity(child, sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{
        name: `/private-${label}`,
        description: `command-description-secret-${label}`,
        input: { hint: `command-hint-secret-${label}`, _meta: { private: label } },
        _meta: { private: `command-meta-secret-${label}` },
      }],
      _meta: { private: `command-update-secret-${label}` },
    });
  }
  if (usage) {
    sendActivity(child, sessionId, {
      sessionUpdate: "usage_update",
      used: 1536,
      size: 8192,
      cost: { amount: 0.25, currency: "USD", _meta: { private: label } },
      _meta: { private: `context-usage-secret-${label}` },
    });
  }
}

function thoughtUpdates(prefix) {
  return [
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: `${prefix}-private-thought`, annotations: null, _meta: null },
      messageId: null,
      _meta: null,
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "image", data: "eA==", mimeType: "image/png", uri: null },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "audio", data: "eA==", mimeType: "audio/wav" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "resource_link", name: "private name", uri: "file:///private/path", size: null },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "resource",
        resource: { text: `${prefix}-private-resource`, uri: "file:///private/resource", mimeType: null, _meta: null },
      },
    },
  ];
}

function toolCallActivity(prefix) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: `activity-tool-${prefix}`,
    title: `${prefix}-private-title`,
    name: "internal-agent-tool",
    kind: "execute",
    status: "in_progress",
    content: [
      { type: "content", content: { type: "text", text: `${prefix}-private-output` }, _meta: null },
      { type: "diff", path: "/private/secret-file", oldText: null, newText: `${prefix}-private-diff`, _meta: null },
      { type: "terminal", terminalId: "internal-terminal-id", _meta: null },
    ],
    locations: [{ path: "/private/secret-file", line: null, _meta: null }],
    rawInput: [`${prefix}-private-input`],
    rawOutput: { secret: `${prefix}-private-output` },
    _meta: null,
  };
}

function toolCallUpdateActivity(prefix) {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: `activity-tool-${prefix}`,
    kind: null,
    status: "completed",
    title: null,
    name: null,
    content: null,
    locations: null,
    rawInput: null,
    rawOutput: `${prefix}-private-final-output`,
    _meta: null,
  };
}

const permissionOptions = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
];

function permissionParams(sessionId, title, options = permissionOptions) {
  return {
    sessionId,
    toolCall: {
      toolCallId: "permission-tool-call",
      title,
      name: "lookup",
      kind: "execute",
      rawInput: { private: "must-not-reach-the-callback" },
      // Exact bounded shape observed on the pinned official ACP 1.3.0
      // MCP permission request. Both identifiers remain untrusted metadata.
      _meta: { mcp: { server: "opaque-unverified-marker", tool: "lookup" } },
    },
    options,
  };
}

async function initializeMcp(server) {
  const baseHeaders = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
  const post = (body, headers = {}, signal) => fetch(server.url, {
    method: "POST",
    headers: { ...baseHeaders, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-acp", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  const mcpSessionId = initialized.headers.get("mcp-session-id");
  assert.ok(mcpSessionId);
  const sessionHeaders = {
    "mcp-session-id": mcpSessionId,
    "mcp-protocol-version": "2025-06-18",
  };
  const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
  assert.equal(ready.status, 202);
  return {
    async call(key, id) {
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "lookup", arguments: { key } },
      }, sessionHeaders);
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

function mcpServerFromChild(child) {
  const created = child.writes.find(({ method }) => method === "session/new");
  const server = created?.params?.mcpServers?.[0];
  assert.ok(server, "tool-enabled ACP session carries its own session MCP endpoint");
  return server;
}

function driverBehavior(agentErrors, activityScenarios, permissionScenarios) {
  return (message, child) => {
    const index = child.index;
    if (message.method === "initialize") {
      child.reply(message.id, { protocolVersion: 1, agentCapabilities: {} });
      // No live session/turn owns this request: the caller callback must not run.
      child.send({
        jsonrpc: "2.0",
        id: `startup-${index}`,
        method: "session/request_permission",
        params: permissionParams(`no-session-${index}`, "startup request"),
      });
      return;
    }
    if (message.method === "session/new") {
      const remoteSessionId = `remote-session-${index}`;
      const result = {
        sessionId: remoteSessionId,
        configOptions: [{
          id: "model",
          category: "model",
          currentValue: "default",
          options: ["model-0", "model-1", "model-2", "model-3", "strict-model"]
            .map((value) => ({ value, name: value })),
        }],
      };
      // Exercise both wire orders around session/new: the first worker sends
      // before the response, while the others send immediately after it.
      if (index === 0) sendDiscardedSessionUpdates(child, remoteSessionId, `startup-${index}`);
      child.reply(message.id, result);
      if (index !== 0) sendDiscardedSessionUpdates(child, remoteSessionId, `startup-${index}`);
      return;
    }
    if (message.method === "session/set_config_option") {
      child.reply(message.id, {
        configOptions: [{ id: message.params.configId, currentValue: message.params.value }],
      });
      return;
    }
    if (message.method === "session/prompt") {
      const sessionId = message.params.sessionId;
      const promptCount = child.promptCount++;
      const run = async () => {
        const activityScenario = activityScenarios.get(index);
        if (activityScenario) {
          if (activityScenario === "foreign") {
            sendActivity(child, sessionId, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "foreign" },
            }, `${sessionId}-foreign`);
          } else if (activityScenario === "malformed") {
            sendActivity(child, sessionId, {
              sessionUpdate: "tool_call",
              toolCallId: "missing-required-title",
            });
          } else if (activityScenario === "unknown") {
            sendActivity(child, sessionId, { sessionUpdate: "agent_thought_delta", text: "unknown" });
          } else if (activityScenario === "event-cap") {
            for (let count = 0; count < 129; count += 1) {
              sendActivity(child, sessionId, {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: `thought-${count}` },
              });
            }
          } else if (activityScenario === "byte-cap") {
            const largeThought = "x".repeat(64 * 1024);
            for (let count = 0; count < 17; count += 1) {
              sendActivity(child, sessionId, {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: largeThought },
              });
            }
          } else if (activityScenario === "foreign-command") {
            sendActivity(child, sessionId, {
              sessionUpdate: "available_commands_update",
              availableCommands: [],
            }, `${sessionId}-foreign`);
          } else if (activityScenario === "malformed-command") {
            sendActivity(child, sessionId, {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "missing-description" }],
            });
          } else if (activityScenario === "oversized-command") {
            sendActivity(child, sessionId, {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "too-long", description: "x".repeat(16 * 1024 + 1) }],
            });
          } else if (activityScenario === "malformed-usage") {
            sendActivity(child, sessionId, { sessionUpdate: "usage_update", used: 1 });
          }
          return;
        }
        sendDiscardedSessionUpdates(child, sessionId, `prompt-${index}-${promptCount}`);
        const permissionScenario = permissionScenarios.get(index);
        const permissionRequests = permissionScenario?.requests ?? [{
          id: `prompt-permission-${index}-${promptCount}`,
          options: permissionOptions,
        }];
        child.permissionResponses ??= [];
        for (const [requestIndex, request] of permissionRequests.entries()) {
          child.send({
            jsonrpc: "2.0",
            id: request.id,
            method: "session/request_permission",
            params: permissionParams(
              sessionId,
              `Safe display ${index} turn ${promptCount} request ${requestIndex}`,
              request.options,
            ),
          });
          const permission = await child.waitForResponse(request.id);
          child.permissionResponses.push(permission);
          child.permissionOutcome = permission.result?.outcome;
        }

        if (permissionScenario?.callerTool) {
          const mcp = await initializeMcp(mcpServerFromChild(child));
          sendText(child, sessionId, "before automatic caller tool");
          child.callerResult = await mcp.call("automatic-caller-key", 904);
          sendText(child, sessionId, permissionScenario.responseText);
          child.reply(message.id, { stopReason: "end_turn" });
          return;
        }

        if (permissionScenario) {
          // Agent-side tool activity is observational only. It cannot mint a
          // caller tool_use or create an SDK-owned MCP call/receipt.
          sendActivity(child, sessionId, toolCallActivity(`permission-${index}`));
          sendText(child, sessionId, permissionScenario.responseText);
          child.reply(message.id, { stopReason: "end_turn" });
          return;
        }

        if (index === 0) {
          for (const thought of thoughtUpdates("zero")) sendActivity(child, sessionId, thought);
          // ACP v1 permits the update event independently of whether this SDK
          // has observed its corresponding non-authoritative activity call.
          sendActivity(child, sessionId, toolCallUpdateActivity("zero"));
          sendActivity(child, sessionId, toolCallActivity("zero"));
          sendText(child, sessionId, "before caller tool");
          const mcp = await initializeMcp(mcpServerFromChild(child));
          const callerResult = await mcp.call("session-zero-key", 901);
          child.callerResult = callerResult;
          sendActivity(child, sessionId, toolCallUpdateActivity("orphan-zero"));
          sendText(child, sessionId, "after caller tool");
          child.reply(message.id, { stopReason: "end_turn" });
          return;
        }
        if (index === 1) {
          sendActivity(child, sessionId, thoughtUpdates("one")[0]);
          const chatFirst = process.env.ANTIGRAVITY_TEST_ADAPTERS === "1";
          const text = chatFirst
            ? (promptCount === 0 ? "Chat adapter output from session one" : "streamed output from session one")
            : "streamed output from session one";
          const split = Math.max(1, Math.floor(text.length / 2));
          sendText(child, sessionId, text.slice(0, split), {
            paramsMeta: null,
            updateMeta: null,
            messageId: null,
            annotations: null,
            contentMeta: null,
          });
          sendActivity(child, sessionId, toolCallUpdateActivity(`orphan-one-${promptCount}`));
          sendText(child, sessionId, text.slice(split));
          child.reply(message.id, { stopReason: "end_turn" });
          return;
        }
        if (index === 2) {
          const responsesFirst = process.env.ANTIGRAVITY_TEST_ADAPTERS === "1";
          sendText(child, sessionId, responsesFirst
            ? (promptCount === 0 ? "Responses adapter output from session two" : "nonstream output from session two")
            : "nonstream output from session two");
          child.reply(message.id, { stopReason: "end_turn" });
          // A context update may race with the response frame. It is
          // session-owned housekeeping, not a late prompt text/tool event.
          sendDiscardedSessionUpdates(child, sessionId, `terminal-${index}-${promptCount}`);
          return;
        }
        sendActivity(child, sessionId, thoughtUpdates("three")[0]);
        sendText(child, sessionId, "partial output from session three");
        // The caller aborts this active stream; an absent prompt response tests
        // cancellation and bounded process cleanup in the built-in driver.
      };
      void run().catch((error) => {
        agentErrors.push(error);
        child.exit(1);
      });
      return;
    }
    if (message.method === "session/cancel") return;
  };
}

test("public SDK uses the built-in compatibility driver with isolated sessions, one-shot permissions, tools, and cleanup", async () => {
  const entryPath = resolve(process.env.ANTIGRAVITY_TEST_PACKAGE_ENTRY ??
    new URL("../../dist/index.js", import.meta.url).pathname);
  const actualChildProcess = await import("node:child_process");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const moduleOptions = (exports) => nodeMajor >= 26 ? { exports } : { namedExports: exports };
  const children = [];
  const agentErrors = [];
  const activityScenarios = new Map();
  const permissionScenarios = new Map();
  const fakeSpawn = (_executable, _args, options) => {
    const index = children.length;
    const child = new FakeAcpChild(options, index, (message, current) =>
      driverBehavior(agentErrors, activityScenarios, permissionScenarios)(message, current));
    children.push(child);
    return child;
  };
  const fakeExecFile = (_executable, _args, _options, callback) => {
    queueMicrotask(() => callback(null, {
      stdout: "",
      stderr: "AGY_INTERACTIVE_LOGIN_BLOCKED",
    }));
    return { kill() {} };
  };
  mock.module("node:child_process", {
    ...moduleOptions({ ...actualChildProcess, spawn: fakeSpawn, execFile: fakeExecFile }),
  });
  const compatibilityModule = new URL("./acp-compatibility.js", pathToFileURL(entryPath)).href;
  mock.module(compatibilityModule, {
    ...moduleOptions({
      // Test-only in-memory fixture: production hash checks are not disabled by
      // any SDK setting, package export, or session-driver option.
      assertReviewedAcpPair: async (executable) => executable,
    }),
  });

  const api = await import(pathToFileURL(entryPath).href);
  const root = await mkdtemp(join(tmpdir(), "antigravity-a6-public-sdk-"));
  const callbackContexts = [];
  const permissionDecisions = new Map();
  let approvedSessionId;
  let allowUsed = false;
  let authProcessFactoryCalls = 0;
  let strictSdk;
  let activitySdk;
  let automaticPermissionsSdk;
  let denyPermissionsSdk;
  const sdk = new api.AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/fake/agy-acp",
    args: ["--stdio"],
    cwd: "/ignored-top-level-cwd",
    environment: {
      PATH: "/safe/test/path",
      HOME: "/ambient/must-not-cross",
      GOOGLE_API_KEY: "must-not-cross",
    },
    processFactory() {
      authProcessFactoryCalls += 1;
      throw new Error("the authentication-only process seam must not start session workers");
    },
    maxTokensPolicy: "allow-unenforced-max-tokens",
    permissions: {
      timeoutMs: 1_000,
      onRequest(context) {
        callbackContexts.push(context);
        const allow = context.sessionId === approvedSessionId && !allowUsed;
        if (allow) allowUsed = true;
        const selected = context.offeredOptions.find(({ kind }) => kind === (allow ? "allow_once" : "reject_once"));
        const decision = allow && selected
          ? { action: "select", optionId: selected.optionId }
          : { action: "deny" };
        permissionDecisions.set(context.operationId, decision.action === "select" ? "allow-once" : "deny");
        return decision;
      },
    },
  });

  try {
    const accounts = [await sdk.accounts.create(), await sdk.accounts.create()];
    assert.notEqual(accounts[0].id, accounts[1].id);
    const sessions = [];
    for (const [accountIndex, account] of accounts.entries()) {
      for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
        const index = accountIndex * 2 + sessionIndex;
        sessions.push(await account.sessions.create({
          model: `model-${index}`,
          cwd: `/workspace/account-${accountIndex}/session-${sessionIndex}`,
          ...(index === 0 ? { tools: [{
            name: "lookup",
            input_schema: {
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
              additionalProperties: false,
            },
          }] } : {}),
        }));
      }
    }
    assert.equal(sessions.length, 4);
    approvedSessionId = sessions[0].sessionId;
    assert.equal(children.length, 4);
    assert.notEqual(children[0].spawnOptions.env.HOME, children[2].spawnOptions.env.HOME);
    assert.equal(children[0].spawnOptions.env.HOME, children[1].spawnOptions.env.HOME);
    assert.equal(children[2].spawnOptions.env.HOME, children[3].spawnOptions.env.HOME);
    assert.equal(children.every((child) => child.spawnOptions.env.PATH === "/safe/test/path"), true);
    assert.equal(children.every((child) => !Object.hasOwn(child.spawnOptions.env, "GOOGLE_API_KEY")), true);
    assert.equal(children.every((child) => child.spawnOptions.env.HOME !== "/ambient/must-not-cross"), true);
    await Promise.all(children.map((child, index) => child.waitForResponse(`startup-${index}`)));
    assert.equal(callbackContexts.length, 0, "permissions without a live session owner fail closed without callback invocation");

    const mcpServers = [await sessions[0].tools.createMcpServer()];
    assert.equal(mcpServers[0].url.startsWith("http://127.0.0.1:"), true);
    for (let index = 0; index < children.length; index += 1) {
      sendDiscardedSessionUpdates(children[index], `remote-session-${index}`, `idle-${index}`);
    }
    await delay();
    const userMessages = sessions.map((_session, index) => ({ role: "user", content: `question-${index}` }));

    const toolMessage = await sessions[0].messages.create({ max_tokens: 17, messages: [userMessages[0]] });
    const toolReceipt = api.messageMaxTokensEnforcement(toolMessage);
    assert.deepEqual(toolMessage.content.map(({ type }) => type), ["text", "tool_use"]);
    assert.equal(toolMessage.content[0].text, "before caller tool");
    assert.equal(toolReceipt?.requestedMaxTokens, 17);
    assert.equal(toolReceipt?.policy, "allow-unenforced-max-tokens");
    assert.equal(toolReceipt?.outcome, "ignored");
    assert.equal(toolReceipt?.reason, "backend-does-not-enforce-requested-bound");
    assert.deepEqual(children[0].permissionOutcome, { outcome: "selected", optionId: "allow-once" });
    const toolUse = toolMessage.content.find(({ type }) => type === "tool_use");
    const completedToolMessage = await sessions[0].messages.create({
      max_tokens: 19,
      messages: [userMessages[0], { role: "assistant", content: toolMessage.content }, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "caller-result-for-session-zero" }],
      }],
    });
    assert.deepEqual(completedToolMessage.content, [{ type: "text", text: "after caller tool" }]);
    const continuationReceipt = api.messageMaxTokensEnforcement(completedToolMessage);
    assert.equal(continuationReceipt?.kind, "tool_continuation");
    assert.equal(continuationReceipt?.requestedMaxTokens, 19);
    assert.equal(continuationReceipt?.outcome, "ignored");
    assert.deepEqual(children[0].callerResult?.result?.content, [
      { type: "text", text: "caller-result-for-session-zero" },
    ]);
    assert.equal((await sessions[0].diagnostics.toolHandoffs()).length, 1);

    let chatDisclosure;
    let responsesDisclosure;
    const adapterResponseIds = [];
    const adaptersEnabled = process.env.ANTIGRAVITY_TEST_ADAPTERS === "1";
    if (adaptersEnabled) {
      const { createChatAdapter } = await import(new URL("./chat.js", pathToFileURL(entryPath)).href);
      const chat = createChatAdapter(sessions[1]);
      const completion = await chat.completions.create({
        model: sessions[1].configuration.model,
        messages: [{ role: "user", content: "chat-specific question" }],
        max_tokens: 37,
      });
      assert.equal(completion.choices[0].message.content, "Chat adapter output from session one");
      chatDisclosure = completion.max_tokens_enforcement;
      assert.equal(chatDisclosure.requestedMaxTokens, 37);
      assert.equal(chatDisclosure.outcome, "ignored");
      adapterResponseIds.push(completion.id);

      const { createResponsesAdapter } = await import(new URL("./responses.js", pathToFileURL(entryPath)).href);
      const responses = createResponsesAdapter(sessions[2]);
      const responseStream = await responses.responses.create({
        model: sessions[2].configuration.model,
        input: "responses-specific question",
        max_output_tokens: 41,
        stream: true,
      });
      const responseEvents = [];
      for await (const event of responseStream) responseEvents.push(event);
      responsesDisclosure = responseEvents.find((event) => event.max_tokens_enforcement)?.max_tokens_enforcement;
      assert.ok(responsesDisclosure);
      assert.equal(responsesDisclosure.requestedMaxTokens, 41);
      assert.equal(responsesDisclosure.outcome, "ignored");
      assert.equal(responseEvents.some((event) => event.type === "response.output_text.delta" &&
        event.delta.includes("Responses adapter output from session two")), true);
      assert.equal(responseEvents.every((event) => !event.max_tokens_enforcement ||
        event.max_tokens_enforcement.outcome === "ignored"), true);
      adapterResponseIds.push(responseEvents.find((event) => event.response)?.response.id);
    }

    const stream = await sessions[1].messages.create({
      max_tokens: 29,
      messages: adaptersEnabled ? [
        { role: "user", content: [{ type: "text", text: "chat-specific question" }] },
        { role: "assistant", content: [{ type: "text", text: "Chat adapter output from session one" }] },
        { role: "user", content: [{ type: "text", text: "native-stream-question-one" }] },
      ] : [userMessages[1]],
      stream: true,
    });
    const streamEvents = [];
    for await (const event of stream) streamEvents.push(event);
    const streamStart = streamEvents.find((event) => event.type === "message_start");
    assert.ok(streamStart);
    const streamReceipt = api.messageMaxTokensEnforcement(streamStart.message);
    assert.equal(streamReceipt?.requestedMaxTokens, 29);
    assert.equal(streamReceipt?.outcome, "ignored");
    assert.equal(streamEvents.at(-1).type, "message_stop");
    assert.equal(streamEvents.filter((event) => event.type === "content_block_delta" &&
      event.delta.type === "text_delta").map((event) => event.delta.text).join(""),
    "streamed output from session one");
    assert.equal(streamEvents.some((event) => event.type === "content_block_start" &&
      event.content_block.type !== "text"), false, "ACP thought/tool activity never becomes caller-facing content");
    assert.equal(streamEvents.some((event) => event.type.includes("thinking") || event.type.includes("signature")), false);

    const textMessage = await sessions[2].messages.create({
      max_tokens: 31,
      messages: adaptersEnabled ? [
        { role: "user", content: [{ type: "text", text: "responses-specific question" }] },
        { role: "assistant", content: [{ type: "text", text: "Responses adapter output from session two" }] },
        { role: "user", content: [{ type: "text", text: "native-nonstream-question-two" }] },
      ] : [userMessages[2]],
    });
    const textReceipt = api.messageMaxTokensEnforcement(textMessage);
    assert.equal(textMessage.content[0].text, "nonstream output from session two");
    assert.equal(textReceipt?.requestedMaxTokens, 31);
    assert.equal(textReceipt?.outcome, "ignored");
    assert.deepEqual(children[2].permissionOutcome, { outcome: "selected", optionId: "reject-once" });

    const controller = new AbortController();
    const cancelledStream = await sessions[3].messages.create({
      max_tokens: 43,
      messages: [userMessages[3]],
      stream: true,
    }, { signal: controller.signal });
    const iterator = cancelledStream[Symbol.asyncIterator]();
    let startEvent;
    let sawPartialText = false;
    while (!sawPartialText) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      if (next.value.type === "message_start") startEvent = next.value;
      if (next.value.type === "content_block_delta" && next.value.delta.type === "text_delta") {
        sawPartialText = true;
      }
    }
    assert.equal(api.messageMaxTokensEnforcement(startEvent.message)?.requestedMaxTokens, 43);
    assert.equal(api.messageMaxTokensEnforcement(startEvent.message)?.outcome, "ignored");
    controller.abort();
    await assert.rejects(iterator.next(), api.RequestAbortedError);
    assert.equal(sessions[3].state, "interrupted");
    assert.equal(children[3].writes.filter(({ method }) => method === "session/cancel").length, 1);

    const activitySnapshots = await Promise.all(sessions.map(({ diagnostics }) => diagnostics.snapshot()));
    assert.deepEqual(activitySnapshots[0].acpActivity, {
      agentThoughtChunks: 5,
      toolCalls: 1,
      toolCallUpdates: 2,
      capped: false,
    });
    const sessionOneTurns = adaptersEnabled ? 2 : 1;
    assert.deepEqual(activitySnapshots[1].acpActivity, {
      agentThoughtChunks: sessionOneTurns,
      toolCalls: 0,
      toolCallUpdates: sessionOneTurns,
      capped: false,
    });
    assert.deepEqual(activitySnapshots[2].acpActivity, {
      agentThoughtChunks: 0,
      toolCalls: 0,
      toolCallUpdates: 0,
      capped: false,
    });
    assert.deepEqual(activitySnapshots[3].acpActivity, {
      agentThoughtChunks: 1,
      toolCalls: 0,
      toolCallUpdates: 0,
      capped: false,
    });
    assert.equal(JSON.stringify(activitySnapshots).includes("private-thought"), false);
    assert.equal(JSON.stringify(activitySnapshots).includes("private-tool"), false);
    assert.equal(JSON.stringify(activitySnapshots).includes("secret-file"), false);
    assert.equal(activitySnapshots.every(({ usage }) => usage.kind === "unknown"), true,
      "session context occupancy never becomes per-operation Messages usage");
    const discardedUpdateSecret = JSON.stringify({ toolMessage, completedToolMessage, streamEvents, textMessage, callbackContexts });
    assert.equal(discardedUpdateSecret.includes("command-description-secret-"), false);
    assert.equal(discardedUpdateSecret.includes("command-hint-secret-"), false);
    assert.equal(discardedUpdateSecret.includes("command-meta-secret-"), false);
    assert.equal(discardedUpdateSecret.includes("context-usage-secret-"), false);
    assert.equal(toolMessage.content.some((block) => block.type === "tool_use" && block.id.startsWith("activity-tool-")), false,
      "ACP tool-call activity cannot create caller tool authority");

    const allResponseIds = [toolMessage.id, completedToolMessage.id, streamStart.message.id, textMessage.id];
    const completeResponseIds = [...allResponseIds, ...adapterResponseIds.filter(Boolean)];
    assert.equal(new Set(completeResponseIds).size, completeResponseIds.length, "native and adapter output IDs remain isolated");
    const responseReceipts = [
      toolReceipt, continuationReceipt, streamReceipt, textReceipt,
      ...(chatDisclosure === undefined ? [] : [chatDisclosure]),
      ...(responsesDisclosure === undefined ? [] : [responsesDisclosure]),
    ];
    assert.equal(new Set(responseReceipts.map(({ operationId }) => operationId)).size, responseReceipts.length);
    assert.deepEqual(responseReceipts.map(({ requestedMaxTokens }) => requestedMaxTokens),
      adaptersEnabled ? [17, 19, 29, 31, 37, 41] : [17, 19, 29, 31]);
    assert.equal(new Set(responseReceipts.map(({ accountId, sessionId }) => `${accountId}/${sessionId}`)).size, 3);
    assert.equal(callbackContexts.length, adaptersEnabled ? 6 : 4,
      "only live prompt turns invoke the permission callback");
    assert.equal(callbackContexts.every((context) => context.origin === "unverified"), true);
    assert.equal(callbackContexts.every((context) => context.details.title?.startsWith("Safe display ")), true);
    assert.equal(callbackContexts.every((context) => !JSON.stringify(context).includes("must-not-reach-the-callback")), true);
    assert.equal(callbackContexts.every((context) => !Object.hasOwn(context.details, "rawInput")), true);
    assert.equal(callbackContexts.every((context) => context.offeredOptions.some(({ kind }) => kind === "allow_always")), true);
    assert.equal(callbackContexts.every(Object.isFrozen), true);
    assert.deepEqual([...permissionDecisions.values()].sort(), adaptersEnabled
      ? ["allow-once", "deny", "deny", "deny", "deny", "deny"]
      : ["allow-once", "deny", "deny", "deny"]);
    const expectedContextOwners = sessions.map(({ accountId, sessionId }) => `${accountId}/${sessionId}`);
    if (adaptersEnabled) {
      expectedContextOwners.push(`${sessions[1].accountId}/${sessions[1].sessionId}`);
      expectedContextOwners.push(`${sessions[2].accountId}/${sessions[2].sessionId}`);
    }
    assert.deepEqual(callbackContexts.map(({ accountId, sessionId }) => `${accountId}/${sessionId}`).sort(),
      expectedContextOwners.sort());

    const promptMessages = children.flatMap((child) => child.writes.filter(({ method }) => method === "session/prompt"));
    assert.equal(promptMessages.length, adaptersEnabled ? 6 : 4);
    for (let index = 0; index < sessions.length; index += 1) {
      const promptsForSession = children[index].writes.filter(({ method }) => method === "session/prompt");
      assert.equal(promptsForSession.length, adaptersEnabled && (index === 1 || index === 2) ? 2 : 1);
      assert.equal(promptsForSession[0].params.sessionId, `remote-session-${index}`);
      if (!adaptersEnabled || index === 0 || index === 3) {
        assert.equal(promptsForSession[0].params.prompt.some(({ text }) => text.includes(`question-${index}`)), true);
      }
      if (adaptersEnabled && index === 1) {
        assert.equal(promptsForSession[0].params.prompt.some(({ text }) => text.includes("chat-specific question")), true);
        assert.equal(promptsForSession[1].params.prompt.some(({ text }) => text.includes("native-stream-question-one")), true);
      }
      if (adaptersEnabled && index === 2) {
        assert.equal(promptsForSession[0].params.prompt.some(({ text }) => text.includes("responses-specific question")), true);
        assert.equal(promptsForSession[1].params.prompt.some(({ text }) => text.includes("native-nonstream-question-two")), true);
      }
    }
    assert.equal(children.every((child) => child.writes.every(({ method }) => method !== "authenticate")), true);
    assert.equal(authProcessFactoryCalls, 0, "the public authentication process seam cannot replace the built-in session spawn");
    assert.equal(agentErrors.length, 0, "fake ACP/MCP agent tasks completed without hidden errors");

    await accounts[0].auth.logout();
    assert.equal(sessions[0].state, "closed");
    assert.equal(sessions[1].state, "closed");
    assert.notEqual(sessions[2].state, "closed", "logout only closes the selected account workers");
    await assert.rejects(fetch(mcpServers[0].url));
    await sdk.close();
    assert.equal(sessions[2].state, "closed");
    assert.equal(sessions[3].state, "closed");
    assert.equal(children.every((child) => child.ended), true, "logout and SDK close leave no fake ACP child alive");

    // The legacy strict default does not block unbounded ACP inference.
    const strictChildIndex = children.length;
    permissionScenarios.set(strictChildIndex, { responseText: "unbounded request completed" });
    strictSdk = new api.AntigravitySDK({
      storageDir: join(root, "strict-profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/safe/test/path" },
    });
    const strictAccount = await strictSdk.accounts.create();
    const strictSession = await strictAccount.sessions.create({ model: "strict-model", cwd: "/workspace/strict" });
    const strictChild = children.at(-1);
    const unboundedMessage = await strictSession.messages.create({
      messages: [{ role: "user", content: "no output bound supplied" }],
    });
    assert.equal(unboundedMessage.content[0].text, "unbounded request completed");
    assert.equal(api.messageMaxTokensEnforcement(unboundedMessage)?.outcome, "unbounded");
    assert.equal(strictSession.configuration.model, "strict-model");
    assert.equal(strictChild.writes.some(({ method }) => method === "session/prompt"), true);
    await strictSdk.close();
    assert.equal(strictChild.ended, true);

    activitySdk = new api.AntigravitySDK({
      storageDir: join(root, "activity-profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/safe/test/path" },
      maxTokensPolicy: "allow-unenforced-max-tokens",
    });
    const activityAccount = await activitySdk.accounts.create();
    for (const [scenario, ExpectedError] of [
      ["foreign", api.ProtocolFailureError],
      ["malformed", api.ProtocolFailureError],
      ["unknown", api.ProtocolFailureError],
      ["event-cap", api.ProtocolFailureError],
      ["byte-cap", api.ProtocolFailureError],
      ["foreign-command", api.ProtocolFailureError],
      ["malformed-command", api.ProtocolFailureError],
      ["oversized-command", api.ProtocolFailureError],
      ["malformed-usage", api.ProtocolFailureError],
    ]) {
      const childIndex = children.length;
      activityScenarios.set(childIndex, scenario);
      const activitySession = await activityAccount.sessions.create({
        model: "model-0",
        cwd: `/workspace/activity-${scenario}`,
      });
      const activityChild = children[childIndex];
      await assert.rejects(
        activitySession.messages.create({
          max_tokens: 13,
          messages: [{ role: "user", content: `activity-${scenario}` }],
        }),
        ExpectedError,
        `${scenario} ACP activity must fail closed`,
      );
      assert.equal(activitySession.state, "interrupted");
      await activitySession.close();
      assert.equal(activityChild.ended, true);
    }
    await activitySdk.close();

    const automaticRequests = [
      {
        id: "public-auto-selects-once-only",
        options: [
          { optionId: "public-auto-once-before-always", name: "Allow once", kind: "allow_once" },
          { optionId: "public-auto-always-first", name: "Always allow", kind: "allow_always" },
          { optionId: "public-auto-always-second", name: "Also always allow", kind: "allow_always" },
        ],
      },
      {
        id: "public-auto-selects-first-once",
        options: [
          { optionId: "public-auto-once-first", name: "Allow once", kind: "allow_once" },
          { optionId: "public-auto-once-second", name: "Also allow once", kind: "allow_once" },
        ],
      },
      {
        id: "public-auto-denies-always-only",
        options: [
          { optionId: "public-auto-repeat-always-first", name: "Always allow", kind: "allow_always" },
          { optionId: "public-auto-repeat-always-second", name: "Also always allow", kind: "allow_always" },
        ],
      },
    ];
    const automaticChildIndex = children.length;
    permissionScenarios.set(automaticChildIndex, {
      requests: automaticRequests,
      responseText: "automatic permission policy completed",
      callerTool: true,
    });
    // Deliberately omit `permissions`: the packed/public SDK default must
    // automatically select exact offered IDs without a caller callback.
    automaticPermissionsSdk = new api.AntigravitySDK({
      storageDir: join(root, "automatic-permission-profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/safe/test/path" },
      maxTokensPolicy: "allow-unenforced-max-tokens",
    });
    const automaticAccount = await automaticPermissionsSdk.accounts.create();
    const automaticSession = await automaticAccount.sessions.create({
      model: "model-0",
      cwd: "/workspace/public-auto-permissions",
      tools: [{
        name: "lookup",
        input_schema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      }],
    });
    await automaticSession.tools.createMcpServer();
    const automaticUser = { role: "user", content: "exercise the public automatic permission default" };
    const automaticToolMessage = await automaticSession.messages.create({
      max_tokens: 23,
      messages: [automaticUser],
    });
    const automaticChild = children[automaticChildIndex];
    assert.deepEqual(automaticToolMessage.content.map(({ type }) => type), ["text", "tool_use"],
      "the fake ACP permission request alone is not a caller tool handoff; only the real MCP tools/call produces tool_use");
    assert.equal(automaticToolMessage.content[0].text, "before automatic caller tool");
    const automaticToolUse = automaticToolMessage.content.find(({ type }) => type === "tool_use");
    assert.equal(automaticToolUse.name, "lookup");
    assert.deepEqual(automaticToolUse.input, { key: "automatic-caller-key" });
    assert.deepEqual(automaticChild.permissionResponses.map(({ id, result }) => ({
      id,
      outcome: result?.outcome,
    })), [
      {
        id: "public-auto-selects-once-only",
        outcome: { outcome: "selected", optionId: "public-auto-once-before-always" },
      },
      {
        id: "public-auto-selects-first-once",
        outcome: { outcome: "selected", optionId: "public-auto-once-first" },
      },
      {
        id: "public-auto-denies-always-only",
        outcome: { outcome: "cancelled" },
      },
    ], "the ACP transport writes one response for each request, using the exact offered selection");
    for (const [requestIndex, request] of automaticRequests.entries()) {
      const response = automaticChild.permissionResponses[requestIndex];
      if (response?.result?.outcome?.outcome === "selected") {
        assert.equal(request.options.some(({ optionId, kind }) =>
          optionId === response.result.outcome.optionId && kind === "allow_once"), true,
        "automatic approval selects only an exact offered allow_once ID");
      } else {
        assert.deepEqual(response?.result?.outcome, { outcome: "cancelled" },
          "requests without allow_once are denied even if allow_always is offered");
      }
      assert.equal(automaticChild.writes.filter(({ id }) => id === request.id).length, 1,
        `permission request ${request.id} has exactly one outbound response`);
    }
    const automaticResponse = await automaticSession.messages.create({
      max_tokens: 24,
      messages: [automaticUser, { role: "assistant", content: automaticToolMessage.content }, {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: automaticToolUse.id, content: "authoritative caller result" }],
      }],
    });
    assert.deepEqual(automaticResponse.content, [{ type: "text", text: "automatic permission policy completed" }]);
    assert.deepEqual(automaticChild.callerResult?.result?.content, [
      { type: "text", text: "authoritative caller result" },
    ], "the ACP receives only the result admitted by the caller's SDK tool continuation");
    const automaticHandoffs = await automaticSession.diagnostics.toolHandoffs();
    assert.equal(automaticHandoffs.length, 1);
    assert.equal(automaticHandoffs[0].name, "lookup");
    assert.equal(automaticHandoffs[0].resultState, "acknowledged");
    await automaticPermissionsSdk.close();
    assert.equal(automaticChild.ended, true);

    const denyRequests = [{
      id: "public-explicit-deny",
      options: [
        { optionId: "public-deny-allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "public-deny-reject-once", name: "Reject once", kind: "reject_once" },
      ],
    }];
    const denyChildIndex = children.length;
    permissionScenarios.set(denyChildIndex, {
      requests: denyRequests,
      responseText: "explicit deny policy completed",
    });
    denyPermissionsSdk = new api.AntigravitySDK({
      storageDir: join(root, "deny-permission-profiles"),
      executable: "/fake/agy-acp",
      environment: { PATH: "/safe/test/path" },
      maxTokensPolicy: "allow-unenforced-max-tokens",
      permissions: { mode: "deny" },
    });
    const denyAccount = await denyPermissionsSdk.accounts.create();
    const denySession = await denyAccount.sessions.create({ model: "model-0", cwd: "/workspace/public-deny-permissions" });
    const denyResponse = await denySession.messages.create({
      max_tokens: 23,
      messages: [{ role: "user", content: "exercise explicit permission denial" }],
    });
    const denyChild = children[denyChildIndex];
    assert.deepEqual(denyResponse.content, [{ type: "text", text: "explicit deny policy completed" }]);
    assert.deepEqual(denyChild.permissionResponses.map(({ id, result }) => ({ id, outcome: result?.outcome })), [{
      id: "public-explicit-deny",
      outcome: { outcome: "selected", optionId: "public-deny-reject-once" },
    }]);
    await denyPermissionsSdk.close();
    assert.equal(denyChild.ended, true);
    assert.equal(agentErrors.length, 0, "automatic and explicit-deny fake ACP requests completed");
  } finally {
    await denyPermissionsSdk?.close();
    await automaticPermissionsSdk?.close();
    await activitySdk?.close();
    await strictSdk?.close();
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
});
