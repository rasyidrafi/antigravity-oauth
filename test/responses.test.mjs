import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { APIError } from "@anthropic-ai/sdk";
import { ResponsesToMessagesConverter } from "@zenmux/rosetta-ai";
import {
  InvalidRequestError,
  ProcessFailureError,
  RequestAbortedError,
  UnsupportedFeatureError,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";
import { createResponsesAdapter } from "../dist/responses.js";

const text = (value) => ({ type: "text", text: value });
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const schema = {
  type: "object",
  properties: { key: { type: "string" } },
  required: ["key"],
  additionalProperties: false,
};
const pinnedTool = { name: "lookup", description: "Look up a key.", input_schema: schema };
const responseTool = { type: "function", name: "lookup", description: "Look up a key.", parameters: schema };
const modelFor = (label) => `model-${label}`;

async function withTempDirectory(fn) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-s10-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, message = "condition did not become true") {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeFixture(root, {
  accountLabel = "default",
  maxTokensPolicy = "strict",
  system,
  tools,
  capabilities,
  createAdapter = true,
  onDispatch = async () => ({
    stage: "completed",
    output: [assistant("answer")],
    result: { stopReason: "end_turn", usage: { inputTokens: 12, cachedReadTokens: 3, cachedWriteTokens: 1, outputTokens: 4 } },
  }),
  onStream,
  onStreamTools,
  onContinueTools,
} = {}) {
  const registry = await createProfileRegistry({
    storageDir: join(root, `profiles-${accountLabel}`),
    environment: { PATH: "/safe/bin" },
  });
  const account = await registry.accounts.create();
  const workerManager = createProfileRuntimeManager();
  const effectiveCapabilities = capabilities ?? {
    maxTokens: "enforced",
    ...(onStream === undefined ? {} : { streaming: "incremental" }),
  };
  const operations = [];
  const streams = [];
  const continuations = [];
  const holder = { session: undefined, mcp: undefined };
  const engine = createProfileSessionEngine(registry.accounts, account.id, {
    workerManager,
    maxTokensPolicy,
    driverFactory() {
      return {
        capabilities: effectiveCapabilities,
        async admitResponse(request) {
          return {
            kind: request.kind,
            operationId: request.operationId,
            accountId: request.accountId,
            sessionId: request.sessionId,
            maxTokens: request.maxTokens,
            policy: request.policy,
            outcome: effectiveCapabilities.maxTokens === "not-enforced" ? "not-enforced" : "enforced",
            reason: effectiveCapabilities.maxTokens === "not-enforced"
              ? "backend-does-not-enforce-requested-bound"
              : "driver-admitted-requested-bound",
          };
        },
        async dispatch(operation) {
          operations.push(operation);
          return onDispatch(operation, holder);
        },
        ...(onStream === undefined ? {} : {
          stream(operation) {
            streams.push(operation);
            return onStream(operation, holder);
          },
        }),
        ...(onStreamTools === undefined ? {} : {
          streamTools(continuation) {
            continuations.push(continuation);
            return onStreamTools(continuation, holder);
          },
        }),
        ...(onContinueTools === undefined ? {} : {
          async continueTools(continuation) {
            continuations.push(continuation);
            return onContinueTools(continuation, holder);
          },
        }),
        async bindCallerTools(server) { holder.mcp = server; },
        async close() {},
      };
    },
  });
  const session = await engine.create({
    model: modelFor(accountLabel),
    cwd: root,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
  });
  holder.session = session;
  return {
    account,
    engine,
    session,
    holder,
    operations,
    streams,
    continuations,
    responses: createAdapter ? createResponsesAdapter(session) : undefined,
    async close() {
      if (holder.mcp) await holder.mcp.close();
      await session.close();
      await engine.close();
    },
  };
}

async function initializeMcp(server) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "s10-test", version: "1" },
      },
    }),
  });
  assert.equal(response.status, 200);
  const mcpSessionId = response.headers.get("mcp-session-id");
  assert.ok(mcpSessionId);
  const headers = {
    ...server.headers,
    "content-type": "application/json",
    "mcp-session-id": mcpSessionId,
    "mcp-protocol-version": "2025-06-18",
  };
  const initialized = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initialized.status, 202);
  return headers;
}

function sendMcpCall(server, headers, id, key) {
  const pending = fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "lookup", arguments: { key } },
    }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  void pending.catch(() => undefined);
  return pending;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function nativeTextEvents({ id = "stream-id", model = "fixture-model", textValue = "hi", stopReason = "end_turn" } = {}) {
  return [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: textValue } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
    },
    { type: "message_stop" },
  ];
}

test("the pinned Rosetta Responses converter golden maps text, instructions, function schemas, IDs, and usage", () => {
  const converter = new ResponsesToMessagesConverter();
  const request = {
    model: "fixture-model",
    instructions: "Pinned 🧭",
    input: "héllo 🌍",
    max_output_tokens: 73,
    tools: [responseTool],
  };
  assert.deepEqual(converter.convertRequest(request), {
    model: "fixture-model",
    max_tokens: 73,
    messages: [{ role: "user", content: [text("héllo 🌍")] }],
    system: "Pinned 🧭",
    tools: [{ name: "lookup", description: "Look up a key.", input_schema: schema }],
  });

  const message = {
    id: "msg-responses-golden",
    type: "message",
    role: "assistant",
    model: "fixture-model",
    content: [
      { type: "text", text: "done " },
      { type: "tool_use", id: "toolu-golden", name: "lookup", input: { key: "café" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    },
  };
  const converted = converter.convertResponse(message);
  assert.equal(converted.status, "completed");
  assert.deepEqual(converted.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(converted.output[0].content[0].text, "done ");
  assert.equal(converted.output[1].call_id, "toolu-golden");
  assert.equal(converted.output[1].arguments, '{"key":"café"}');
  assert.deepEqual(converted.usage, {
    input_tokens: 15,
    output_tokens: 3,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 0 },
  });

  const history = new ResponsesToMessagesConverter().convertRequest({
    model: "fixture-model",
    input: [
      { type: "message", role: "user", content: "start" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
      { type: "function_call", call_id: "call-one", name: "lookup", arguments: '{"key":"one"}' },
      { type: "function_call_output", call_id: "call-one", output: "result-one" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  });
  assert.deepEqual(history.messages, [
    { role: "user", content: [text("start")] },
    { role: "assistant", content: [text("working"), { type: "tool_use", id: "call-one", name: "lookup", input: { key: "one" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-one", content: [text("result-one")] }] },
    { role: "user", content: [text("continue")] },
  ]);
});

test("Rosetta namespace splitting rejects unsafe function names without rewriting boundary-safe names", async () => {
  const flattened = { type: "function", name: "team___lookup", parameters: schema };
  const unsafeHistory = [{
    type: "function_call",
    call_id: "call-unsafe",
    name: "team___lookup",
    arguments: '{"key":"x"}',
  }];

  for (const name of ["___lookup", "lookup___"]) {
    const safeConverter = new ResponsesToMessagesConverter();
    const convertedRequest = safeConverter.convertRequest({
      model: "fixture-model",
      input: "question",
      tools: [{ type: "function", name, parameters: schema }],
    });
    assert.equal(convertedRequest.tools[0].name, name);
    const convertedResponse = safeConverter.convertResponse({
      id: `msg-${name}`,
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [{ type: "tool_use", id: `call-${name}`, name, input: { key: "x" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const functionCall = convertedResponse.output.find((item) => item.type === "function_call");
    assert.equal(functionCall.name, name);
    assert.equal(functionCall.namespace, undefined);
  }

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { accountLabel: "unsafe-source", tools: [pinnedTool], onStream: async function* () {} });
    try {
      const base = { model: "model-unsafe-source", input: "question", tools: [responseTool] };
      await assert.rejects(fixture.responses.responses.create({ ...base, tools: [flattened] }), UnsupportedFeatureError);
      await assert.rejects(fixture.responses.responses.create({ ...base, input: unsafeHistory }), UnsupportedFeatureError);
      await assert.rejects(fixture.responses.responses.create({ ...base, tools: [flattened], stream: true }), UnsupportedFeatureError);
      await assert.rejects(fixture.responses.responses.create({ ...base, input: unsafeHistory, stream: true }), UnsupportedFeatureError);
      assert.equal(fixture.operations.length, 0);
      assert.equal(fixture.streams.length, 0);
    } finally {
      await fixture.close();
    }

    const unsafePinnedTool = { ...pinnedTool, name: "team___lookup" };
    const pinned = await makeFixture(root, {
      accountLabel: "unsafe-pinned",
      tools: [unsafePinnedTool],
      createAdapter: false,
    });
    try {
      assert.throws(() => createResponsesAdapter(pinned.session), UnsupportedFeatureError);
      assert.equal(pinned.operations.length, 0);
      assert.equal(pinned.streams.length, 0);
    } finally {
      await pinned.close();
    }
  });
});

test("the actual converter fans a raw event out in order and preserves terminal status and sequence numbers", async () => {
  const converter = new ResponsesToMessagesConverter();
  const events = [];
  for await (const event of converter.convertStream((async function* () {
    for (const item of nativeTextEvents({ textValue: "hello" })) yield item;
  })())) events.push(event);

  assert.deepEqual(events.slice(0, 2).map(({ type }) => type), ["response.created", "response.in_progress"]);
  assert.deepEqual(events.map(({ sequence_number }) => sequence_number), events.map((_event, index) => index));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.status, "completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "hello");

  const refusal = [];
  for await (const event of new ResponsesToMessagesConverter().convertStream((async function* () {
    for (const item of nativeTextEvents({ textValue: "I cannot help with that.", stopReason: "refusal" })) yield item;
  })())) refusal.push(event);
  assert.deepEqual(refusal.slice(-2).map(({ type }) => type), ["response.failed", "error"]);
  assert.equal(refusal.at(-2).response.status, "failed");
  assert.equal(refusal.at(-2).response.error.code, "content_filter");

  const incomplete = [];
  const incompleteConverter = new ResponsesToMessagesConverter();
  for await (const event of incompleteConverter.convertStream((async function* () {
    for (const item of nativeTextEvents({ stopReason: "max_tokens" })) yield item;
  })())) incomplete.push(event);
  assert.equal(incomplete.at(-1).type, "response.incomplete");
  assert.equal(incomplete.at(-1).response.status, "incomplete");
});

test("actual Rosetta stream conversion keeps generic errors thrown and translates Anthropic APIError", async () => {
  const rosettaRequire = createRequire(fileURLToPath(import.meta.resolve("@zenmux/rosetta-ai")));
  const rosettaAnthropic = rosettaRequire("@anthropic-ai/sdk");
  const rosettaApiError = new rosettaAnthropic.APIError(429, { type: "rate_limit_error" }, "too many", new Headers());
  const converted = [];
  for await (const event of new ResponsesToMessagesConverter().convertStream((async function* () {
    yield nativeTextEvents()[0];
    throw rosettaApiError;
  })())) converted.push(event);
  assert.deepEqual(converted.slice(-2).map(({ type }) => type), ["response.failed", "error"]);
  assert.equal(converted.at(-2).response.status, "failed");
  assert.equal(converted.at(-1).code, "rate_limit_exceeded");

  const earlyFailure = [];
  for await (const event of new ResponsesToMessagesConverter().convertStream((async function* () {
    throw rosettaApiError;
  })())) earlyFailure.push(event);
  assert.deepEqual(earlyFailure.map(({ type }) => type), ["response.failed", "error"]);
  assert.equal(earlyFailure.some(({ type }) => type === "response.completed"), false);

  const original = new Error("generic converter failure");
  await assert.rejects(async () => {
    for await (const _event of new ResponsesToMessagesConverter().convertStream((async function* () {
      yield nativeTextEvents()[0];
      throw original;
    })())) { /* consume */ }
  }, (error) => error === original);
});

test("non-streaming adapter pins model/system/tools and reports cache-inclusive usage honestly", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "pins",
      system: "Pinned 🧭",
      tools: [pinnedTool],
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant("héllo  🌍")],
        result: { stopReason: "end_turn", usage: { inputTokens: 20, cachedReadTokens: 5, cachedWriteTokens: 2, thoughtTokens: 1, outputTokens: 4 } },
      }),
    });
    try {
      const request = {
        model: "model-pins",
        instructions: "Pinned 🧭",
        input: "question 🌍",
        max_output_tokens: 83,
        tools: [responseTool],
      };
      const golden = new ResponsesToMessagesConverter().convertRequest(request);
      const response = await fixture.responses.responses.create(request);
      assert.equal(response.object, "response");
      assert.equal(response.status, "completed");
      assert.equal(response.model, "model-pins");
      assert.equal(response.output[0].content[0].text, "héllo  🌍");
      assert.deepEqual(response.usage, {
        input_tokens: 20,
        output_tokens: 4,
        total_tokens: 24,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      });
      assert.deepEqual(response.usage_provenance, {
        kind: "reported",
        source: "ACP prompt response usage",
        inputTokens: 13,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        thinkingTokens: 1,
        outputTokens: 4,
      });
      assert.deepEqual(fixture.operations[0].messages, golden.messages);
      assert.equal(fixture.operations[0].maxTokens, 83);
      assert.equal(fixture.operations[0].accountId, fixture.account.id);
      assert.equal(fixture.operations[0].sessionId, fixture.session.sessionId);
    } finally {
      await fixture.close();
    }
  });
});

test("opt-in Responses metadata tracks Rosetta's normalized bound without enforcing or truncating it", async () => {
  await withTempDirectory(async (root) => {
    let turn = 0;
    const answer = "This long Responses answer intentionally overshoots a one-token requested output bound.";
    const fixture = await makeFixture(root, {
      accountLabel: "compat-responses",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced" },
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant(answer)],
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 3, cachedReadTokens: 1, cachedWriteTokens: 0, outputTokens: 90 + turn++ },
        },
      }),
    });
    try {
      const first = await fixture.responses.responses.create({
        model: "model-compat-responses",
        input: "default limit",
      });
      assert.equal(fixture.operations[0].maxTokens, 4096, "Rosetta's omitted/null default is admitted as 4096");
      assert.equal(first.output[0].content[0].text, answer);
      const firstDisclosure = first.max_tokens_enforcement;
      assert.deepEqual(firstDisclosure, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 4096,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(Object.isFrozen(firstDisclosure), true);

      const second = await fixture.responses.responses.create({
        model: "model-compat-responses",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "default limit" }] },
          ...first.output,
          { type: "message", role: "user", content: [{ type: "input_text", text: "small explicit bound" }] },
        ],
        max_output_tokens: 1,
      });
      assert.equal(fixture.operations[1].maxTokens, 1);
      assert.equal(second.output[0].content[0].text, answer, "the compatibility path does not impose a local output cap");
      assert.equal(second.usage.output_tokens, 91);
      assert.equal(second.max_tokens_enforcement.requestedMaxTokens, 1);
      assert.equal(second.max_tokens_enforcement.outcome, "not-enforced");
      assert.equal(Object.isFrozen(second.max_tokens_enforcement), true);
      assert.deepEqual(first.max_tokens_enforcement, firstDisclosure,
        "a later Responses operation cannot replace the earlier response-scoped receipt");
    } finally {
      await fixture.close();
    }

    const strict = await makeFixture(root, {
      accountLabel: "strict-not-enforced-responses",
      maxTokensPolicy: "strict",
      capabilities: { maxTokens: "not-enforced" },
    });
    try {
      await assert.rejects(strict.responses.responses.create({
        model: "model-strict-not-enforced-responses",
        input: "must fail closed",
      }), UnsupportedFeatureError);
      assert.equal(strict.operations.length, 0);
    } finally {
      await strict.close();
    }
  });
});

test("full transcript history preserves assistant text, empty text, tool IDs, and function results", async () => {
  await withTempDirectory(async (root) => {
    let turn = 0;
    const fixture = await makeFixture(root, {
      accountLabel: "history",
      tools: [pinnedTool],
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant(turn++ === 0 ? [text("")] : "follow-up")],
        result: { stopReason: "end_turn", usage: { inputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 } },
      }),
    });
    try {
      const firstRequest = { model: "model-history", input: "first", tools: [responseTool] };
      const first = await fixture.responses.responses.create(firstRequest);
      assert.equal(first.output[0].content[0].text, "");
      const second = await fixture.responses.responses.create({
        model: "model-history",
        tools: [responseTool],
        input: [
          { type: "message", role: "user", content: "first" },
          ...first.output,
          { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
        ],
      });
      assert.equal(second.output[0].content[0].text, "follow-up");
      assert.deepEqual(fixture.operations[1].messages, [user([text("second")])]);
      assert.deepEqual(fixture.session.snapshot().transcript.slice(0, 2), [user([text("first")]), assistant([text("")])]);
    } finally {
      await fixture.close();
    }
  });
});

test("full Responses transcript continues an actual receipt-backed caller-tool handoff", async () => {
  await withTempDirectory(async (root) => {
    let pending;
    let expectedCallId;
    const fixture = await makeFixture(root, {
      accountLabel: "continuation",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced" },
      system: "Pinned tools",
      tools: [pinnedTool],
      async onDispatch(_operation, holder) {
        const headers = await initializeMcp(holder.mcp);
        pending = sendMcpCall(holder.mcp, headers, 201, "alpha");
        await waitFor(async () => (await holder.session.diagnostics.toolHandoffs()).length === 1);
        return {
          stage: "awaiting_tools",
          output: [assistant([
            text("lookup"),
            { type: "tool_use", id: "worker-call-alpha", name: "lookup", input: { key: "alpha" } },
          ])],
          result: { stopReason: "tool_use", usage: { inputTokens: 9, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 3 } },
        };
      },
      async onContinueTools(continuation) {
        const delivered = await pending;
        assert.equal(delivered.status, 200);
        assert.equal(delivered.body.result.content[0].text, "tool-result-alpha");
        assert.equal(continuation.results[0].result.content[0].text, "tool-result-alpha");
        assert.equal(continuation.results[0].callId, expectedCallId);
        return {
          stage: "completed",
          output: [assistant("tool finished")],
          result: { stopReason: "end_turn", usage: { inputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 2 } },
        };
      },
    });
    try {
      await fixture.session.tools.createMcpServer();
      const params = {
        model: "model-continuation",
        instructions: "Pinned tools",
        tools: [responseTool],
      };
      const first = await fixture.responses.responses.create({ ...params, input: "look up alpha", max_output_tokens: 21 });
      assert.equal(first.status, "completed");
      assert.equal(first.max_tokens_enforcement.kind, "prompt");
      assert.equal(first.max_tokens_enforcement.requestedMaxTokens, 21);
      assert.equal(first.max_tokens_enforcement.outcome, "not-enforced");
      const call = first.output.find((item) => item.type === "function_call");
      assert.ok(call);
      expectedCallId = call.call_id;
      assert.deepEqual(JSON.parse(call.arguments), { key: "alpha" });

      const final = await fixture.responses.responses.create({
        ...params,
        input: [
          { type: "message", role: "user", content: "look up alpha" },
          ...first.output,
          { type: "function_call_output", call_id: call.call_id, output: "tool-result-alpha" },
        ],
        max_output_tokens: 7,
      });
      assert.equal(final.output[0].content[0].text, "tool finished");
      assert.deepEqual(final.max_tokens_enforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.continuations[0].operationId,
        kind: "tool_continuation",
        requestedMaxTokens: 7,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.continuations.length, 1);
      const continuationText = fixture.continuations[0].messages;
      assert.deepEqual(continuationText.at(-1).content, [{ type: "tool_result", tool_use_id: call.call_id, content: [{ type: "text", text: "tool-result-alpha" }] }]);
    } finally {
      await fixture.close();
    }
  });
});

test("source validation rejects unsupported state, output constraints, tools, and parallel limits before dispatch", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { accountLabel: "validate", tools: [pinnedTool] });
    try {
      const base = { model: "model-validate", input: "question", tools: [responseTool] };
      const rejected = [
        [{ ...base, previous_response_id: "resp_previous" }, UnsupportedFeatureError],
        [{ ...base, store: false }, UnsupportedFeatureError],
        [{ ...base, background: false }, UnsupportedFeatureError],
        [{ ...base, conversation: "conversation_1" }, UnsupportedFeatureError],
        [{ ...base, tool_choice: "required" }, UnsupportedFeatureError],
        [{ ...base, parallel_tool_calls: false }, UnsupportedFeatureError],
        [{ ...base, text: { format: { type: "json_object" } } }, UnsupportedFeatureError],
        [{ ...base, text: { format: { type: "json_schema", name: "shape", schema } } }, UnsupportedFeatureError],
        [{ ...base, tools: [{ type: "web_search", search_context_size: "low" }] }, UnsupportedFeatureError],
        [{ ...base, tools: [{ type: "function", name: "lookup", parameters: schema, strict: true }] }, UnsupportedFeatureError],
        [{ ...base, tools: undefined }, InvalidRequestError],
        [{ ...base, input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/a.png" }] }] }, UnsupportedFeatureError],
        [{ ...base, input: [{ type: "function_call", call_id: "call-bad", name: "lookup", arguments: "{" }] }, InvalidRequestError],
        [{ ...base, input: [{ type: "function_call", call_id: "call-a", name: "lookup", arguments: "{}" }, { type: "function_call_output", call_id: "foreign", output: "x" }] }, InvalidRequestError],
      ];
      await assert.rejects(fixture.responses.responses.create(null), InvalidRequestError);
      for (const [request, ErrorType] of rejected) await assert.rejects(fixture.responses.responses.create(request), ErrorType);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(fixture.responses.responses.create(base, { signal: controller.signal }), RequestAbortedError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await fixture.close();
    }
  });
});

test("converted model/system/catalog pins and Rosetta schema weakening are rejected", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { accountLabel: "pinned-check", system: "Pinned", tools: [pinnedTool] });
    try {
      await assert.rejects(fixture.responses.responses.create({
        model: "another-model", instructions: "Pinned", input: "question", tools: [responseTool],
      }), UnsupportedFeatureError);
      await assert.rejects(fixture.responses.responses.create({
        model: "model-pinned-check", instructions: "changed", input: "question", tools: [responseTool],
      }), UnsupportedFeatureError);
      await assert.rejects(fixture.responses.responses.create({
        model: "model-pinned-check", instructions: "Pinned", input: "question",
      }), UnsupportedFeatureError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await fixture.close();
    }

    const weakened = {
      type: "object",
      oneOf: [
        { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
        { type: "object", properties: { right: { type: "string" } }, required: ["right"] },
      ],
      additionalProperties: false,
    };
    const weakenedTool = { name: "union", input_schema: weakened };
    const weak = await makeFixture(root, { accountLabel: "weak-schema", tools: [weakenedTool] });
    try {
      const request = {
        model: "model-weak-schema",
        input: "question",
        tools: [{ type: "function", name: "union", parameters: weakened }],
      };
      const direct = new ResponsesToMessagesConverter().convertRequest(request);
      assert.notDeepEqual(direct.tools[0].input_schema, weakened);
      await assert.rejects(weak.responses.responses.create(request), UnsupportedFeatureError);
      assert.equal(weak.operations.length, 0);
    } finally {
      await weak.close();
    }
  });
});

test("adapter streams preserve fan-out ordering, terminal state, usage provenance, and max-token status", async () => {
  await withTempDirectory(async (root) => {
    const makeSemantic = (stopReason = "end_turn") => (async function* () {
      yield { type: "text", text: "hello" };
      yield {
        type: "complete",
        acknowledgement: {
          stage: "completed",
          output: [assistant("hello")],
          result: {
            stopReason,
            usage: { inputTokens: 2, cachedReadTokens: 1, cachedWriteTokens: 0, outputTokens: 2 },
          },
        },
      };
    })();
    const fixture = await makeFixture(root, {
      accountLabel: "stream",
      onStream: () => makeSemantic("end_turn"),
    });
    try {
      const stream = await fixture.responses.responses.create({
        model: "model-stream", input: "question", stream: true,
      });
      const events = await collect(stream);
      assert.deepEqual(events.slice(0, 2).map(({ type }) => type), ["response.created", "response.in_progress"]);
      assert.deepEqual(events.map(({ sequence_number }) => sequence_number), events.map((_event, index) => index));
      assert.equal(events.at(-1).type, "response.completed");
      assert.equal(events.at(-1).response.status, "completed");
      assert.equal(events.at(-1).response.usage.input_tokens, 2);
      assert.deepEqual(events.at(-1).response.usage_provenance, {
        kind: "reported",
        source: "ACP prompt response usage",
        inputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        outputTokens: 2,
      });

      const noUsage = await makeFixture(root, {
        accountLabel: "stream-unknown-usage",
        onStream: () => (async function* () {
          yield { type: "text", text: "unknown" };
          yield {
            type: "complete",
            acknowledgement: {
              stage: "completed",
              output: [assistant("unknown")],
              result: { stopReason: "end_turn" },
            },
          };
        })(),
      });
      try {
        const unknownEvents = await collect(await noUsage.responses.responses.create({
          model: "model-stream-unknown-usage", input: "question", stream: true,
        }));
        assert.equal(unknownEvents.at(-1).response.usage, null);
        assert.equal(unknownEvents.at(-1).response.usage_provenance.kind, "unknown");
      } finally {
        await noUsage.close();
      }

      assert.equal(fixture.streams[0].maxTokens, 4096);
    } finally {
      await fixture.close();
    }

    const incompleteFixture = await makeFixture(root, {
      accountLabel: "stream-incomplete",
      onStream: () => makeSemantic("max_tokens"),
    });
    try {
      const incomplete = await collect(await incompleteFixture.responses.responses.create({
        model: "model-stream-incomplete", input: "question", stream: true,
      }));
      assert.equal(incomplete.at(-1).type, "response.incomplete");
      assert.equal(incomplete.at(-1).response.status, "incomplete");
    } finally {
      await incompleteFixture.close();
    }
  });
});

test("opt-in Responses stream discloses its bound in initial fan-out events and retains it after abort", async () => {
  await withTempDirectory(async (root) => {
    const answer = "This streamed answer exceeds the requested two-token output bound.";
    const fixture = await makeFixture(root, {
      accountLabel: "compat-responses-stream",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced", streaming: "incremental" },
      async *onStream() {
        yield { type: "text", text: answer };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant(answer)],
            result: {
              stopReason: "end_turn",
              usage: { inputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 28 },
            },
          },
        };
      },
    });
    try {
      const stream = await fixture.responses.responses.create({
        model: "model-compat-responses-stream",
        input: "stream",
        max_output_tokens: 2,
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const created = await iterator.next();
      assert.equal(created.value.type, "response.created");
      const disclosure = created.value.max_tokens_enforcement;
      assert.deepEqual(disclosure, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.streams[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 2,
        policy: "allow-unenforced-max-tokens",
        outcome: "not-enforced",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.deepEqual(created.value.response.max_tokens_enforcement, disclosure,
        "response.created carries the same out-of-band metadata as the event");
      assert.equal(Object.isFrozen(disclosure), true);
      const events = [created.value];
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }
      assert.equal(events[1].type, "response.in_progress");
      assert.deepEqual(events[1].max_tokens_enforcement, disclosure);
      for (const event of events) assert.deepEqual(event.max_tokens_enforcement, disclosure);
      assert.equal(events.at(-1).type, "response.completed", "an overshoot is not mislabeled as a token-limit stop");
      assert.equal(events.at(-1).response.usage.output_tokens, 28);
      assert.equal(Object.isFrozen(events.at(-1).response.max_tokens_enforcement), true);
    } finally {
      await fixture.close();
    }

    const aborted = await makeFixture(root, {
      accountLabel: "compat-responses-stream-abort",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced", streaming: "incremental" },
      async *onStream() {
        yield { type: "text", text: "partial" };
        yield { type: "text", text: "not requested after return" };
      },
    });
    try {
      const stream = await aborted.responses.responses.create({
        model: "model-compat-responses-stream-abort",
        input: "abort",
        max_output_tokens: 6,
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.value.type, "response.created");
      const disclosure = first.value.response.max_tokens_enforcement;
      assert.equal(disclosure.requestedMaxTokens, 6);
      assert.equal(first.value.max_tokens_enforcement.operationId, disclosure.operationId);
      await iterator.return();
      assert.equal(Object.isFrozen(disclosure), true);
      assert.equal(aborted.session.snapshot().transcript.length, 0,
        "consumer cancellation does not commit a partial response");
    } finally {
      await aborted.close();
    }
  });
});

test("unknown or partial usage is not converted into false zero/cache-inclusive counts", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "unknown-usage",
      onDispatch: async () => ({ stage: "completed", output: [assistant("answer")], result: { stopReason: "end_turn" } }),
    });
    try {
      const unknown = await fixture.responses.responses.create({ model: "model-unknown-usage", input: "question" });
      assert.equal(unknown.usage, null);
      assert.deepEqual(unknown.usage_provenance, {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
      assert.equal(fixture.operations[0].maxTokens, 4096);
    } finally {
      await fixture.close();
    }

    const partial = await makeFixture(root, {
      accountLabel: "partial-usage",
      onDispatch: async () => ({
        stage: "completed", output: [assistant("answer")],
        result: { stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 2 } },
      }),
    });
    try {
      const response = await partial.responses.responses.create({ model: "model-partial-usage", input: "question" });
      assert.equal(response.usage, null, "Responses input totals include cache buckets, which were not reported");
      assert.equal(response.usage_provenance.kind, "reported");
      assert.equal(response.usage_provenance.inputTokens, 8);
    } finally {
      await partial.close();
    }
  });
});

test("generic stream errors are thrown and Anthropic APIError is a failed/error terminal, never completion", async () => {
  await withTempDirectory(async (root) => {
    const apiError = new APIError(429, { type: "rate_limit_error" }, "provider rate limited", new Headers());
    const fixture = await makeFixture(root, {
      accountLabel: "api-error",
      onStream: async function* () {
        yield { type: "text", text: "partial" };
        throw apiError;
      },
    });
    try {
      // The native session preserves Anthropic APIError types so the adapter can
      // distinguish them from generic worker failures at its Messages boundary.
      const events = await collect(await fixture.responses.responses.create({
        model: "model-api-error", input: "question", stream: true,
      }));
      assert.deepEqual(events.slice(-2).map(({ type }) => type), ["response.failed", "error"]);
      assert.deepEqual(events.map(({ sequence_number }) => sequence_number), events.map((_event, index) => index));
      assert.equal(events.at(-2).response.status, "failed");
      assert.equal(events.at(-1).code, "rate_limit_exceeded");
      assert.equal(events.some(({ type }) => type === "response.completed"), false);
    } finally {
      await fixture.close();
    }

    const rosettaRequire = createRequire(fileURLToPath(import.meta.resolve("@zenmux/rosetta-ai")));
    const nestedApiError = new (rosettaRequire("@anthropic-ai/sdk").APIError)(
      503,
      { type: "api_error" },
      "nested Anthropic SDK failure",
      new Headers(),
    );
    const nestedFixture = await makeFixture(root, {
      accountLabel: "nested-api-error",
      onStream: async function* () {
        yield { type: "text", text: "partial" };
        throw nestedApiError;
      },
    });
    try {
      const events = await collect(await nestedFixture.responses.responses.create({
        model: "model-nested-api-error", input: "question", stream: true,
      }));
      assert.deepEqual(events.slice(-2).map(({ type }) => type), ["response.failed", "error"]);
      assert.equal(events.at(-1).code, "server_error");
    } finally {
      await nestedFixture.close();
    }

    const generic = new Error("generic driver fault");
    const broken = await makeFixture(root, {
      accountLabel: "generic-error",
      onStream: async function* () {
        yield { type: "text", text: "partial" };
        throw generic;
      },
    });
    try {
      await assert.rejects(async () => collect(await broken.responses.responses.create({
        model: "model-generic-error", input: "question", stream: true,
      })), ProcessFailureError);
    } finally {
      await broken.close();
    }
  });
});

test("consumer return and AbortSignal cancel a pending stream next without a terminal success", async () => {
  await withTempDirectory(async (root) => {
    let returnCount = 0;
    let nextCount = 0;
    const pendingStream = () => ({
      [Symbol.asyncIterator]() { return this; },
      next() {
        nextCount += 1;
        return new Promise(() => {});
      },
      async return() {
        returnCount += 1;
        return { done: true, value: undefined };
      },
    });
    const fixture = await makeFixture(root, {
      accountLabel: "return-pending",
      onStream: () => pendingStream(),
    });
    try {
      const iterator = (await fixture.responses.responses.create({
        model: "model-return-pending", input: "question", stream: true,
      }))[Symbol.asyncIterator]();
      const pending = iterator.next();
      await waitFor(() => nextCount > 0);
      const closed = await Promise.race([
        iterator.return(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("consumer return stalled")), 2_000)),
      ]);
      assert.equal(closed.done, true);
      assert.equal((await pending).done, true);
      assert.ok(returnCount >= 1);
    } finally {
      await fixture.close();
    }

    const aborted = await makeFixture(root, {
      accountLabel: "abort-pending",
      onStream: () => pendingStream(),
    });
    try {
      const controller = new AbortController();
      const iterable = await aborted.responses.responses.create({
        model: "model-abort-pending", input: "question", stream: true,
      }, { signal: controller.signal });
      const pending = iterable[Symbol.asyncIterator]().next();
      await waitFor(() => aborted.streams.length > 0, "the worker stream should start after admission");
      controller.abort();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal(aborted.session.snapshot().state, "interrupted");
    } finally {
      await aborted.close();
    }

    const thrown = await makeFixture(root, {
      accountLabel: "throw-pending",
      onStream: () => pendingStream(),
    });
    try {
      const iterator = (await thrown.responses.responses.create({
        model: "model-throw-pending", input: "question", stream: true,
      }))[Symbol.asyncIterator]();
      const previousNextCount = nextCount;
      const pending = iterator.next();
      await waitFor(() => nextCount > previousNextCount);
      const fault = new Error("consumer throw");
      await assert.rejects(iterator.throw(fault), (error) => error === fault);
      await assert.rejects(pending, (error) => error === fault);
    } finally {
      await thrown.close();
    }
  });
});

test("consumer return after final item events but before response terminal leaves the native turn uncommitted", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "terminal-return",
      onStream: () => (async function* () {
        yield { type: "text", text: "complete content" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant("complete content")],
            result: {
              stopReason: "end_turn",
              usage: { inputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 2 },
            },
          },
        };
      })(),
    });
    try {
      const iterator = (await fixture.responses.responses.create({
        model: "model-terminal-return", input: "question", stream: true,
      }))[Symbol.asyncIterator]();
      let sawFinalItem = false;
      while (!sawFinalItem) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        sawFinalItem = next.value.type === "response.output_item.done";
      }
      assert.equal(fixture.session.snapshot().state, "running");
      await iterator.return();
      assert.equal(fixture.session.snapshot().state, "interrupted");
      assert.equal(fixture.session.snapshot().transcript.length, 0);
    } finally {
      await fixture.close();
    }
  });
});

test("two account-bound streams have isolated converter state, IDs, model pins, and sequence counters", async () => {
  await withTempDirectory(async (root) => {
    const stream = () => (async function* () {
      yield { type: "text", text: "isolated" };
      yield {
        type: "complete",
        acknowledgement: {
          stage: "completed",
          output: [assistant("isolated")],
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 1 },
          },
        },
      };
    })();
    const first = await makeFixture(root, { accountLabel: "session-a", onStream: stream });
    const second = await makeFixture(root, { accountLabel: "session-b", onStream: stream });
    try {
      const [firstIterable, secondIterable] = await Promise.all([
        first.responses.responses.create({ model: "model-session-a", input: "a", stream: true }),
        second.responses.responses.create({ model: "model-session-b", input: "b", stream: true }),
      ]);
      const [firstEvents, secondEvents] = await Promise.all([collect(firstIterable), collect(secondIterable)]);
      assert.equal(firstEvents.at(-1).response.model, "model-session-a");
      assert.equal(secondEvents.at(-1).response.model, "model-session-b");
      assert.deepEqual(firstEvents.map(({ sequence_number }) => sequence_number), firstEvents.map((_e, i) => i));
      assert.deepEqual(secondEvents.map(({ sequence_number }) => sequence_number), secondEvents.map((_e, i) => i));
      assert.notEqual(firstEvents[0].response.id, secondEvents[0].response.id);
      assert.notEqual(first.account.id, second.account.id);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
