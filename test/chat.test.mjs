import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatCompletionToMessagesConverter } from "@zenmux/rosetta-ai";
import {
  InvalidRequestError,
  ProcessFailureError,
  ProviderError,
  ProtocolFailureError,
  RequestAbortedError,
  UnsupportedFeatureError,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
} from "../dist/index.js";
import { createChatAdapter } from "../dist/chat.js";

const model = "chat-fixture-model";
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
const openAITool = { type: "function", function: { name: "lookup", description: "Look up a key.", parameters: schema } };

async function withTempDirectory(fn) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-s9-"));
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
  accountLabel = "A",
  maxTokensPolicy = "strict",
  system,
  tools,
  capabilities,
  onDispatch = async () => ({
    stage: "completed",
    output: [assistant("answer")],
    result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } },
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
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
            policy: request.policy,
            outcome: request.maxTokens === undefined
              ? "unbounded"
              : effectiveCapabilities.maxTokens === "not-enforced" ? "ignored" : "enforced",
            reason: request.maxTokens === undefined
              ? "no-output-token-bound-requested"
              : effectiveCapabilities.maxTokens === "not-enforced"
                ? "backend-does-not-enforce-requested-bound"
                : "driver-admitted-requested-bound",
          };
        },
        async dispatch(operation) {
          operations.push(operation);
          return onDispatch(operation, holder, operations.length);
        },
        ...(onStream === undefined ? {} : {
          stream(operation) {
            streams.push(operation);
            return onStream(operation, holder, streams.length);
          },
        }),
        ...(onStreamTools === undefined ? {} : {
          streamTools(continuation) {
            continuations.push(continuation);
            return onStreamTools(continuation, holder, continuations.length);
          },
        }),
        ...(onContinueTools === undefined ? {} : {
          async continueTools(continuation) {
            continuations.push(continuation);
            return onContinueTools(continuation, holder, continuations.length);
          },
        }),
        async bindCallerTools(server) { holder.mcp = server; },
        async close() {},
      };
    },
  });
  const session = await engine.create({
    model: `model-${accountLabel}`,
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
    chat: createChatAdapter(session),
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
        clientInfo: { name: "s9-test", version: "1" },
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

test("the pinned Rosetta 1.0.38 request/response fixture maps text, unicode, system, model, tools and tokens", async () => {
  const converter = new ChatCompletionToMessagesConverter();
  const request = {
    model: "fixture-model",
    max_completion_tokens: 73,
    messages: [
      { role: "system", content: "system 🧭" },
      { role: "user", content: "héllo 🌍" },
    ],
    tools: [openAITool],
  };
  const translated = converter.convertRequest(request);
  assert.deepEqual(translated, {
    model: "fixture-model",
    max_tokens: 73,
    messages: [{ role: "user", content: [text("héllo 🌍")] }],
    system: [text("system 🧭")],
    tools: [{ type: "custom", name: "lookup", description: "Look up a key.", input_schema: schema }],
  });

  const converted = converter.convertResponse({
    id: "msg-tool-fixture",
    type: "message",
    role: "assistant",
    model: "fixture-model",
    content: [
      { type: "text", text: "done " },
      { type: "tool_use", id: "toolu_fixture", name: "lookup", input: { key: "café" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    },
  });
  assert.equal(converted.choices[0].finish_reason, "tool_calls");
  assert.equal(converted.choices[0].message.content, "done ");
  assert.deepEqual(converted.choices[0].message.tool_calls, [{
    id: "toolu_fixture",
    type: "function",
    function: { name: "lookup", arguments: '{"key":"café"}' },
  }]);
  assert.equal(converted.usage.prompt_tokens, 9, "the locked converter reports uncached input only; the adapter normalizes it with diagnostics");

  const toolHistory = new ChatCompletionToMessagesConverter().convertRequest({
    model: "fixture-model",
    messages: [
      {
        role: "assistant",
        content: "working",
        tool_calls: [
          { id: "call-one", type: "function", function: { name: "lookup", arguments: '{"key":"one"}' } },
          { id: "call-two", type: "function", function: { name: "lookup", arguments: '{"key":"two"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call-two", content: "result two" },
      { role: "tool", tool_call_id: "call-one", content: [{ type: "text", text: "result one" }] },
    ],
    tools: [openAITool],
  });
  assert.deepEqual(toolHistory.messages, [
    {
      role: "assistant",
      content: [
        text("working"),
        { type: "tool_use", id: "call-one", name: "lookup", input: { key: "one" } },
        { type: "tool_use", id: "call-two", name: "lookup", input: { key: "two" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-two", content: [text("result two")] },
        { type: "tool_result", tool_use_id: "call-one", content: [text("result one")] },
      ],
    },
  ]);

  const serial = new ChatCompletionToMessagesConverter();
  const rawEvents = [
    { type: "message_start", message: { id: "stream-fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu-one", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"key":"one"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-two", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"key":"two"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 3, output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const streamChunks = rawEvents.map((event) => serial.convertStreamEvent(event)).filter(Boolean);
  const starts = streamChunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []))
    .filter((call) => call.id !== undefined);
  assert.deepEqual(starts.map(({ index, id }) => [index, id]), [[0, "toolu-one"], [1, "toolu-two"]]);
  const argDeltas = streamChunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []))
    .filter((call) => call.function.arguments !== undefined && call.function.arguments !== "");
  assert.deepEqual(argDeltas.map(({ index, function: fn }) => [index, fn.arguments]), [
    [0, '{"key":"one"}'],
    [1, '{"key":"two"}'],
  ]);
});

test("non-streaming adapter preserves full transcript, enforces the pinned config and restores cache-inclusive usage", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "text",
      system: "Pinned system 🧭",
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant("héllo  🌍")],
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 20, cachedReadTokens: 5, cachedWriteTokens: 2, outputTokens: 4 },
        },
      }),
    });
    try {
      const request = {
        model: "model-text",
        messages: [
          { role: "system", content: "Pinned system 🧭" },
          { role: "user", content: "question 🌍" },
        ],
        max_completion_tokens: 83,
        n: 1,
      };
      const rosetta = new ChatCompletionToMessagesConverter();
      const golden = rosetta.convertRequest(request);
      const completion = await fixture.chat.completions.create(request);
      assert.equal(completion.object, "chat.completion");
      assert.equal(completion.model, "model-text");
      assert.equal(completion.choices[0].message.content, "héllo  🌍");
      assert.equal(completion.choices[0].finish_reason, "stop");
      assert.deepEqual(completion.usage, {
        prompt_tokens: 20,
        completion_tokens: 4,
        total_tokens: 24,
        prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
      });
      assert.deepEqual(completion.usage_provenance, {
        kind: "reported",
        source: "ACP prompt response usage",
        inputTokens: 13,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        outputTokens: 4,
      });
      assert.deepEqual(fixture.operations[0].messages, golden.messages);
      assert.equal(fixture.operations[0].maxTokens, 83);
      assert.deepEqual(fixture.operations[0].configuration.tools, undefined);
      assert.equal(fixture.operations[0].accountId, fixture.account.id);
      assert.equal(fixture.operations[0].sessionId, fixture.session.sessionId);
    } finally {
      await fixture.close();
    }
  });
});

test("an explicit empty assistant text block survives response conversion and full-transcript continuation", async () => {
  await withTempDirectory(async (root) => {
    let turn = 0;
    const fixture = await makeFixture(root, {
      accountLabel: "empty-text",
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant(turn++ === 0 ? [text("")] : "follow-up answer")],
        result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 } },
      }),
    });
    try {
      const first = await fixture.chat.completions.create({
        model: "model-empty-text",
        messages: [user("first")],
      });
      assert.equal(first.choices[0].message.content, "");

      const followup = await fixture.chat.completions.create({
        model: "model-empty-text",
        messages: [
          user("first"),
          { role: "assistant", content: first.choices[0].message.content },
          user("second"),
        ],
      });
      assert.equal(followup.choices[0].message.content, "follow-up answer");
      assert.deepEqual(fixture.operations[1].messages, [user([text("second")])]);
      assert.deepEqual(fixture.session.snapshot().transcript.slice(0, 2), [
        user([text("first")]),
        assistant([text("")]),
      ]);
    } finally {
      await fixture.close();
    }
  });
});

test("Rosetta's 4096 default is not caller intent; omitted bounds remain unbounded", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "default",
      onDispatch: async () => ({ stage: "completed", output: [assistant("unknown counts")], result: { stopReason: "end_turn" } }),
    });
    try {
      const completion = await fixture.chat.completions.create({
        model: "model-default",
        messages: [{ role: "user", content: "question" }],
      });
      assert.equal(Object.hasOwn(fixture.operations[0], "maxTokens"), false);
      assert.equal(completion.max_tokens_enforcement.outcome, "unbounded");
      assert.equal(Object.hasOwn(completion.max_tokens_enforcement, "requestedMaxTokens"), false);
      assert.equal(completion.usage, null);
      assert.deepEqual(completion.usage_provenance, {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
    } finally {
      await fixture.close();
    }

    const unbounded = await makeFixture(root, { accountLabel: "unbounded", capabilities: {} });
    try {
      const completion = await unbounded.chat.completions.create({
        model: "model-unbounded",
        messages: [{ role: "user", content: "no bound" }],
      });
      assert.equal(completion.max_tokens_enforcement.outcome, "unbounded");
      assert.equal(unbounded.operations.length, 1);
    } finally {
      await unbounded.close();
    }
  });
});

test("Chat distinguishes omitted limits from explicitly ignored caller limits", async () => {
  await withTempDirectory(async (root) => {
    let dispatch = 0;
    const answer = "This deliberately long answer exceeds a requested one-token output bound.";
    const fixture = await makeFixture(root, {
      accountLabel: "compat-adapter",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced" },
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant(answer)],
        result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 80 + dispatch++ } },
      }),
    });
    try {
      const first = await fixture.chat.completions.create({
        model: "model-compat-adapter",
        messages: [user("default limit")],
      });
      assert.equal(Object.hasOwn(fixture.operations[0], "maxTokens"), false,
        "Rosetta's converted 4096 default is not forwarded as caller intent");
      assert.equal(first.choices[0].message.content, answer);
      const firstDisclosure = first.max_tokens_enforcement;
      assert.deepEqual(firstDisclosure, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[0].operationId,
        kind: "prompt",
        policy: "allow-unenforced-max-tokens",
        outcome: "unbounded",
        reason: "no-output-token-bound-requested",
      });
      assert.equal(Object.isFrozen(firstDisclosure), true);

      const second = await fixture.chat.completions.create({
        model: "model-compat-adapter",
        messages: [user("default limit"), first.choices[0].message, user("explicit small limit")],
        max_completion_tokens: 1,
      });
      assert.equal(fixture.operations[1].maxTokens, 1);
      assert.equal(second.choices[0].message.content, answer, "the compatibility mode does not truncate an overshoot");
      assert.equal(second.usage.completion_tokens, 81);
      assert.equal(second.max_tokens_enforcement.requestedMaxTokens, 1);
      assert.equal(second.max_tokens_enforcement.outcome, "ignored");
      assert.equal(Object.isFrozen(second.max_tokens_enforcement), true);
      assert.deepEqual(first.max_tokens_enforcement, firstDisclosure, "a later operation cannot change response A's disclosure");
    } finally {
      await fixture.close();
    }

    const strict = await makeFixture(root, {
      accountLabel: "strict-not-enforced-adapter",
      maxTokensPolicy: "strict",
      capabilities: { maxTokens: "not-enforced" },
    });
    try {
      const response = await strict.chat.completions.create({
        model: "model-strict-not-enforced-adapter",
        messages: [user("legacy strict does not block ACP")],
      });
      assert.equal(response.max_tokens_enforcement.outcome, "unbounded");
      assert.equal(strict.operations.length, 1);
    } finally {
      await strict.close();
    }
  });
});

test("opt-in Chat stream exposes immutable disclosure on its initial chunk and preserves it on abort", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "compat-stream",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced", streaming: "incremental" },
      async *onStream() {
        yield { type: "text", text: "answer longer than its one-token requested limit" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant("answer longer than its one-token requested limit")],
            result: { stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 45 } },
          },
        };
      },
    });
    try {
      const stream = await fixture.chat.completions.create({
        model: "model-compat-stream",
        messages: [user("stream")],
        max_tokens: 1,
        stream: true,
        stream_options: { include_usage: true },
      });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.equal(first.value.choices[0].delta.role, "assistant");
      assert.deepEqual(first.value.max_tokens_enforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.streams[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 1,
        policy: "allow-unenforced-max-tokens",
        outcome: "ignored",
        reason: "backend-does-not-enforce-requested-bound",
      });
      assert.equal(Object.isFrozen(first.value.max_tokens_enforcement), true);
      const remaining = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        remaining.push(next.value);
        assert.deepEqual(next.value.max_tokens_enforcement, first.value.max_tokens_enforcement);
      }
      assert.equal(remaining.at(-1).usage_provenance.kind, "reported");
      assert.equal(remaining.at(-1).choices.length, 0);
      assert.equal(remaining.at(-1).usage.completion_tokens, 45);
    } finally {
      await fixture.close();
    }

    const aborted = await makeFixture(root, {
      accountLabel: "compat-stream-abort",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced", streaming: "incremental" },
      async *onStream() {
        yield { type: "text", text: "partial" };
        yield { type: "text", text: "never requested after return" };
      },
    });
    try {
      const stream = await aborted.chat.completions.create({
        model: "model-compat-stream-abort",
        messages: [user("abort")],
        max_tokens: 7,
        stream: true,
        stream_options: { include_usage: true },
      });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      const disclosure = first.value.max_tokens_enforcement;
      assert.equal(disclosure.requestedMaxTokens, 7);
      await iterator.return();
      assert.equal(Object.isFrozen(disclosure), true);
      assert.equal(aborted.session.snapshot().transcript.length, 0);
    } finally {
      await aborted.close();
    }
  });
});

test("source validation fails closed before conversion or dispatch for unsupported fields and malformed arguments", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { accountLabel: "validation" });
    try {
      const base = { model: "model-validation", messages: [{ role: "user", content: "question" }] };
      const rejected = [
        [{ ...base, n: 2 }, UnsupportedFeatureError],
        [{ ...base, tool_choice: "required" }, UnsupportedFeatureError],
        [{ ...base, parallel_tool_calls: false }, UnsupportedFeatureError],
        [{ ...base, response_format: { type: "json_object" } }, UnsupportedFeatureError],
        [{ ...base, temperature: 0 }, UnsupportedFeatureError],
        [{ ...base, stop: "x" }, UnsupportedFeatureError],
        [{ ...base, web_search_options: {} }, UnsupportedFeatureError],
        [{ ...base, tools: [{ type: "custom", custom: { name: "format", format: { type: "grammar", grammar: { syntax: "lark", definition: "x" } } } }] }, UnsupportedFeatureError],
        [{
          ...base,
          messages: [{ role: "assistant", tool_calls: [{ id: "call-bad", type: "function", function: { name: "lookup", arguments: "{" } }] }],
        }, InvalidRequestError],
        [{
          ...base,
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }],
        }, UnsupportedFeatureError],
      ];
      await assert.rejects(fixture.chat.completions.create(null), InvalidRequestError);
      for (const [request, ErrorType] of rejected) {
        await assert.rejects(fixture.chat.completions.create(request), ErrorType);
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(fixture.chat.completions.create(base, { signal: controller.signal }), RequestAbortedError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await fixture.close();
    }
  });
});

test("converted model/system/tools must equal the account session pins", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "pinned",
      system: "Pinned",
      tools: [pinnedTool],
    });
    try {
      await assert.rejects(fixture.chat.completions.create({
        model: "another-model",
        messages: [{ role: "system", content: "Pinned" }, { role: "user", content: "question" }],
        tools: [openAITool],
      }), UnsupportedFeatureError);
      await assert.rejects(fixture.chat.completions.create({
        model: "model-pinned",
        messages: [{ role: "system", content: "changed" }, { role: "user", content: "question" }],
        tools: [openAITool],
      }), UnsupportedFeatureError);
      await assert.rejects(fixture.chat.completions.create({
        model: "model-pinned",
        messages: [{ role: "system", content: "Pinned" }, { role: "user", content: "question" }],
      }), UnsupportedFeatureError);
      await assert.rejects(fixture.chat.completions.create({
        model: "model-pinned",
        messages: [{ role: "system", content: "Pinned" }, { role: "user", content: "question" }],
        tools: [{ ...openAITool, function: { ...openAITool.function, strict: true } }],
      }), UnsupportedFeatureError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await fixture.close();
    }
  });
});

test("Rosetta sanitizer schema weakening is detected and nested unchanged schemas remain supported", async () => {
  await withTempDirectory(async (root) => {
    const weakened = {
      type: "object",
      oneOf: [
        { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
        { type: "object", properties: { right: { type: "string" } }, required: ["right"] },
      ],
      additionalProperties: false,
    };
    const badTool = { name: "union", input_schema: weakened };
    const fixture = await makeFixture(root, { accountLabel: "weak-schema", tools: [badTool] });
    try {
      const request = {
        model: "model-weak-schema",
        messages: [{ role: "user", content: "question" }],
        tools: [{ type: "function", function: { name: "union", parameters: weakened } }],
      };
      const direct = new ChatCompletionToMessagesConverter().convertRequest(request);
      assert.notDeepEqual(direct.tools[0].input_schema, weakened, "the pinned converter actually relaxes this schema");
      await assert.rejects(fixture.chat.completions.create(request), UnsupportedFeatureError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await fixture.close();
    }

    const nested = {
      type: "object",
      properties: {
        key: { type: "string", anyOf: [{ minLength: 1 }, { const: "" }] },
      },
      required: ["key"],
      additionalProperties: false,
    };
    const good = await makeFixture(root, {
      accountLabel: "nested-schema",
      tools: [{ name: "lookup", description: "Look up a key.", input_schema: nested }],
    });
    try {
      const completion = await good.chat.completions.create({
        model: "model-nested-schema",
        messages: [{ role: "user", content: "question" }],
        tools: [{ type: "function", function: { name: "lookup", description: "Look up a key.", parameters: nested } }],
      });
      assert.equal(completion.choices[0].message.content, "answer");
      assert.equal(good.operations.length, 1);
    } finally {
      await good.close();
    }
  });
});

test("multi-call function IDs/results round-trip through the receipt-backed session continuation", async () => {
  await withTempDirectory(async (root) => {
    const callResponses = [];
    const fixture = await makeFixture(root, {
      accountLabel: "tools",
      maxTokensPolicy: "allow-unenforced-max-tokens",
      capabilities: { maxTokens: "not-enforced" },
      system: "Pinned tools",
      tools: [pinnedTool],
      async onDispatch(_operation, holder) {
        const headers = await initializeMcp(holder.mcp);
        const pending = [
          sendMcpCall(holder.mcp, headers, 101, "alpha"),
          sendMcpCall(holder.mcp, headers, 102, "beta"),
        ];
        callResponses.push(...pending);
        await waitFor(async () => (await holder.session.diagnostics.toolHandoffs()).length === 2);
        return {
          stage: "awaiting_tools",
          output: [assistant([
            { type: "tool_use", id: "worker-call-alpha", name: "lookup", input: { key: "alpha" } },
            { type: "tool_use", id: "worker-call-beta", name: "lookup", input: { key: "beta" } },
          ])],
          result: { stopReason: "tool_use", usage: { inputTokens: 9, outputTokens: 3 } },
        };
      },
      async onContinueTools(continuation) {
        const delivered = await Promise.all(callResponses);
        assert.deepEqual(delivered.map(({ status }) => status), [200, 200]);
        assert.deepEqual(delivered.map(({ body }) => body.result.content[0].text), ["result-alpha", "result-beta"]);
        assert.equal(continuation.messages.length, 1);
        const results = continuation.messages[0].content;
        assert.deepEqual(new Set(results.map(({ tool_use_id }) => tool_use_id)),
          new Set(continuation.results.map(({ callId }) => callId)));
        assert.deepEqual(continuation.results.map(({ result }) => result.content[0].text).sort(), ["result-alpha", "result-beta"]);
        return {
          stage: "completed",
          output: [assistant("tools complete")],
          result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } },
        };
      },
    });
    try {
      await fixture.session.tools.createMcpServer();
      const initial = {
        model: "model-tools",
        messages: [{ role: "system", content: "Pinned tools" }, { role: "user", content: "look up both" }],
        tools: [openAITool],
        max_tokens: 60,
      };
      const first = await fixture.chat.completions.create(initial);
      assert.equal(first.max_tokens_enforcement.requestedMaxTokens, 60);
      assert.equal(first.max_tokens_enforcement.kind, "prompt");
      assert.equal(first.max_tokens_enforcement.outcome, "ignored");
      const assistantMessage = first.choices[0].message;
      assert.equal(assistantMessage.content, null, "tool-only output must not become an explicit empty text block");
      assert.deepEqual(assistantMessage.tool_calls.map(({ function: fn }) => fn.name), ["lookup", "lookup"]);
      assert.equal(new Set(assistantMessage.tool_calls.map(({ id }) => id)).size, 2);
      const results = assistantMessage.tool_calls.map(({ id }, index) => ({
        role: "tool",
        tool_call_id: id,
        content: index === 0 ? "result-alpha" : "result-beta",
      })).reverse();
      const final = await fixture.chat.completions.create({
        model: "model-tools",
        messages: [
          { role: "system", content: "Pinned tools" },
          { role: "user", content: "look up both" },
          assistantMessage,
          ...results,
        ],
        tools: [openAITool],
      });
      assert.equal(final.choices[0].message.content, "tools complete");
      assert.deepEqual(final.max_tokens_enforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.continuations[0].operationId,
        kind: "tool_continuation",
        policy: "allow-unenforced-max-tokens",
        outcome: "unbounded",
        reason: "no-output-token-bound-requested",
      });
      assert.equal(Object.hasOwn(fixture.continuations[0], "maxTokens"), false);
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.continuations.length, 1);
      assert.deepEqual(new Set(fixture.session.snapshot().transcript.at(-2).content.map(({ tool_use_id }) => tool_use_id)),
        new Set(assistantMessage.tool_calls.map(({ id }) => id)));
    } finally {
      await fixture.close();
    }
  });
});

test("streamed multi-call tools retain Rosetta's serial indices, IDs and complete JSON arguments", async () => {
  await withTempDirectory(async (root) => {
    const pendingCalls = [];
    const fixture = await makeFixture(root, {
      accountLabel: "stream-tools",
      tools: [pinnedTool],
      async *onStreamTools() {
        const delivered = await Promise.all(pendingCalls);
        assert.deepEqual(delivered.map(({ status }) => status), [200, 200]);
        yield { type: "text", text: "continued" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant("continued")],
            result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
          },
        };
      },
      async *onStream(_operation, holder) {
        const headers = await initializeMcp(holder.mcp);
        pendingCalls.push(sendMcpCall(holder.mcp, headers, 201, "first"));
        pendingCalls.push(sendMcpCall(holder.mcp, headers, 202, "second"));
        await waitFor(async () => (await holder.session.diagnostics.toolHandoffs()).length === 2);
        yield { type: "text", text: "" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "awaiting_tools",
            output: [assistant([
              text(""),
              { type: "tool_use", id: "worker-stream-1", name: "lookup", input: { key: "first" } },
              { type: "tool_use", id: "worker-stream-2", name: "lookup", input: { key: "second" } },
            ])],
            result: { stopReason: "tool_use", usage: { inputTokens: 8, outputTokens: 2 } },
          },
        };
      },
    });
    try {
      await fixture.session.tools.createMcpServer();
      const stream = await fixture.chat.completions.create({
        model: "model-stream-tools",
        messages: [{ role: "user", content: "look up both" }],
        tools: [openAITool],
        stream: true,
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const calls = new Map();
      for (const chunk of chunks) {
        for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
          const previous = calls.get(call.index) ?? { arguments: "" };
          calls.set(call.index, {
            id: call.id ?? previous.id,
            name: call.function.name ?? previous.name,
            arguments: `${previous.arguments}${call.function.arguments ?? ""}`,
          });
        }
      }
      assert.deepEqual([...calls.keys()], [0, 1]);
      assert.deepEqual([...calls.values()].map(({ name, arguments: args }) => [name, JSON.parse(args)]), [
        ["lookup", { key: "first" }],
        ["lookup", { key: "second" }],
      ]);
      assert.equal(chunks.filter((chunk) => chunk.choices[0]?.delta.content === "").length, 1,
        "one empty text block is preserved; tool JSON/close fillers are not emitted as text");
      assert.ok([...calls.values()].every(({ id }) => typeof id === "string" && id.startsWith("toolu_")));
      assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
      assert.equal(chunks.some((chunk) => chunk.choices.length === 0), false, "include_usage defaults off");

      const assistantMessage = {
        role: "assistant",
        content: "",
        tool_calls: [...calls.values()].map(({ id, name, arguments: args }) => ({
          id,
          type: "function",
          function: { name, arguments: args },
        })),
      };
      const toolResults = [...calls.values()].map(({ id }, index) => ({
        role: "tool",
        tool_call_id: id,
        content: `result-${index}`,
      })).reverse();
      const continuation = await fixture.chat.completions.create({
        model: "model-stream-tools",
        messages: [user("look up both"), assistantMessage, ...toolResults],
        tools: [openAITool],
        stream: true,
      });
      const finalChunks = [];
      for await (const chunk of continuation) finalChunks.push(chunk);
      assert.equal(finalChunks.at(-1).choices[0].finish_reason, "stop");
      assert.equal(fixture.session.state, "idle");
    } finally {
      await fixture.close();
      await Promise.allSettled(pendingCalls);
    }
  });
});

test("streaming maps serial chunks, cache-inclusive usage and honors include_usage true/false", async () => {
  await withTempDirectory(async (root) => {
    const makeStream = (answer) => async function* () {
      yield { type: "text", text: answer.slice(0, 2) };
      yield { type: "text", text: answer.slice(2) };
      yield {
        type: "complete",
        acknowledgement: {
          stage: "completed",
          output: [assistant(answer)],
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 15, cachedReadTokens: 4, cachedWriteTokens: 1, outputTokens: 3 },
          },
        },
      };
    };
    const fixture = await makeFixture(root, {
      accountLabel: "stream-usage",
      onStream: makeStream("héllo 🌍"),
    });
    try {
      const stream = await fixture.chat.completions.create({
        model: "model-stream-usage",
        messages: [{ role: "user", content: "say hello" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.ok(chunks.some((chunk) => chunk.choices.some((choice) => choice.delta.content === "hé")));
      assert.ok(chunks.some((chunk) => chunk.choices.some((choice) => choice.delta.content === "llo 🌍")));
      assert.equal(chunks.at(-2).choices[0].finish_reason, "stop");
      assert.deepEqual(chunks.at(-1).choices, []);
      assert.deepEqual(chunks.at(-1).usage, {
        prompt_tokens: 15,
        completion_tokens: 3,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 },
      });
      assert.equal(chunks.at(-1).usage_provenance.kind, "reported");
    } finally {
      await fixture.close();
    }

    const withoutUsage = await makeFixture(root, {
      accountLabel: "stream-no-usage",
      onStream: makeStream("ordinary"),
    });
    try {
      const stream = await withoutUsage.chat.completions.create({
        model: "model-stream-no-usage",
        messages: [{ role: "user", content: "say ordinary" }],
        stream: true,
        stream_options: { include_usage: false },
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(chunks.some((chunk) => chunk.choices.length === 0), false);
      assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
    } finally {
      await withoutUsage.close();
    }

    const unknownUsage = await makeFixture(root, {
      accountLabel: "stream-unknown-usage",
      async *onStream() {
        yield { type: "text", text: "unmeasured" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant("unmeasured")],
            result: { stopReason: "end_turn" },
          },
        };
      },
    });
    try {
      const stream = await unknownUsage.chat.completions.create({
        model: "model-stream-unknown-usage",
        messages: [{ role: "user", content: "question" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(chunks.at(-1).usage, null);
      assert.deepEqual(chunks.at(-1).usage_provenance, {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
    } finally {
      await unknownUsage.close();
    }
  });
});

test("streaming rejects missing terminal completion and consumer break cancels the worker iterator", async () => {
  await withTempDirectory(async (root) => {
    const incomplete = await makeFixture(root, {
      accountLabel: "incomplete-stream",
      async *onStream() { yield { type: "text", text: "partial" }; },
    });
    try {
      const stream = await incomplete.chat.completions.create({
        model: "model-incomplete-stream",
        messages: [{ role: "user", content: "question" }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks = [];
      await assert.rejects(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      }, ProtocolFailureError);
      assert.equal(chunks.some((chunk) => chunk.choices[0]?.finish_reason != null), false);
      assert.equal(chunks.some((chunk) => chunk.choices.length === 0), false);
    } finally {
      await incomplete.close();
    }

    const empty = await makeFixture(root, {
      accountLabel: "empty-stream",
      async *onStream() {},
    });
    try {
      const stream = await empty.chat.completions.create({
        model: "model-empty-stream",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      });
      await assert.rejects(async () => {
        for await (const _chunk of stream) {}
      }, ProtocolFailureError);
    } finally {
      await empty.close();
    }

    let workerReturned = false;
    const breaking = await makeFixture(root, {
      accountLabel: "break-stream",
      async *onStream() {
        try {
          yield { type: "text", text: "first" };
          await new Promise(() => {});
        } finally {
          workerReturned = true;
        }
      },
    });
    try {
      const stream = await breaking.chat.completions.create({
        model: "model-break-stream",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      });
      for await (const _chunk of stream) break;
      await waitFor(() => workerReturned, "consumer return did not close the worker stream");
      assert.equal(breaking.session.state, "interrupted");
    } finally {
      await breaking.close();
    }
  });
});

test("pending Chat next is unblocked by return and throw while native cleanup reaches the worker", async () => {
  await withTempDirectory(async (root) => {
    let workerReadPending = false;
    let workerReturned = false;
    let settleWorkerRead;
    const fixture = await makeFixture(root, {
      accountLabel: "pending-next-return",
      onStream() {
        let reads = 0;
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            reads += 1;
            if (reads === 1) return Promise.resolve({ done: false, value: { type: "text", text: "partial" } });
            workerReadPending = true;
            return new Promise((resolve) => { settleWorkerRead = resolve; });
          },
          return() {
            workerReturned = true;
            settleWorkerRead?.({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    });
    try {
      const stream = await fixture.chat.completions.create({
        model: "model-pending-next-return",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      let partialSeen = false;
      while (!partialSeen) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        partialSeen = next.value.choices.some((choice) => choice.delta.content === "partial");
      }
      const pendingNext = iterator.next();
      await waitFor(() => workerReadPending, "native worker read did not become pending");
      const returned = await iterator.return();
      const pendingResult = await pendingNext;
      assert.equal(returned.done, true);
      assert.equal(pendingResult.done, true);
      assert.equal(workerReturned, true);
      assert.equal(fixture.session.state, "interrupted");
    } finally {
      await fixture.close();
    }

    let throwWorkerReadPending = false;
    let throwWorkerReturned = false;
    let settleThrowRead;
    const throwing = await makeFixture(root, {
      accountLabel: "pending-next-throw",
      onStream() {
        let reads = 0;
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            reads += 1;
            if (reads === 1) return Promise.resolve({ done: false, value: { type: "text", text: "partial" } });
            throwWorkerReadPending = true;
            return new Promise((resolve) => { settleThrowRead = resolve; });
          },
          return() {
            throwWorkerReturned = true;
            settleThrowRead?.({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    });
    try {
      const stream = await throwing.chat.completions.create({
        model: "model-pending-next-throw",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      let partialSeen = false;
      while (!partialSeen) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        partialSeen = next.value.choices.some((choice) => choice.delta.content === "partial");
      }
      const pendingNext = iterator.next();
      await waitFor(() => throwWorkerReadPending, "native worker read did not become pending");
      const error = new Error("consumer throw sentinel");
      await assert.rejects(iterator.throw(error), (observed) => observed === error);
      await assert.rejects(pendingNext, (observed) => observed === error);
      assert.equal(throwWorkerReturned, true);
      assert.equal(throwing.session.state, "interrupted");
    } finally {
      await throwing.close();
    }

    let cleanupWorkerReturned = false;
    let settleCleanupRead;
    const cleanupFailure = new Error("controlled worker return failure");
    const cleanupFixture = await makeFixture(root, {
      accountLabel: "pending-next-cleanup-error",
      onStream() {
        let reads = 0;
        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            reads += 1;
            if (reads === 1) return Promise.resolve({ done: false, value: { type: "text", text: "partial" } });
            return new Promise((resolve) => { settleCleanupRead = resolve; });
          },
          return() {
            cleanupWorkerReturned = true;
            settleCleanupRead?.({ done: true, value: undefined });
            return Promise.reject(cleanupFailure);
          },
        };
      },
    });
    try {
      const stream = await cleanupFixture.chat.completions.create({
        model: "model-pending-next-cleanup-error",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      let partialSeen = false;
      while (!partialSeen) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        partialSeen = next.value.choices.some((choice) => choice.delta.content === "partial");
      }
      const pendingNext = iterator.next();
      await waitFor(() => typeof settleCleanupRead === "function");
      await assert.rejects(iterator.return(), ProcessFailureError);
      assert.equal((await pendingNext).done, true);
      assert.equal(cleanupWorkerReturned, true);
    } finally {
      await cleanupFixture.close();
    }
  });
});

test("caller AbortSignal is forwarded to and aborts an active Chat stream", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "abort-stream",
      async *onStream(operation) {
        yield { type: "text", text: "partial" };
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new RequestAbortedError("driver observed abort"));
          operation.signal.addEventListener("abort", onAbort, { once: true });
          if (operation.signal.aborted) onAbort();
        });
      },
    });
    try {
      const controller = new AbortController();
      const stream = await fixture.chat.completions.create({
        model: "model-abort-stream",
        messages: [{ role: "user", content: "question" }],
        stream: true,
      }, { signal: controller.signal });
      const iterator = stream[Symbol.asyncIterator]();
      let partialSeen = false;
      while (!partialSeen) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        partialSeen = next.value.choices.some((choice) => choice.delta.content === "partial");
      }
      const pending = iterator.next();
      controller.abort();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal(fixture.session.state, "interrupted");
    } finally {
      await fixture.close();
    }
  });
});

test("session-bound adapter preserves typed worker errors and rejects unbound handles", async () => {
  await assert.throws(() => createChatAdapter({}), InvalidRequestError);
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      accountLabel: "provider-error",
      onDispatch: async () => { throw new ProviderError("worker provider error"); },
    });
    try {
      await assert.rejects(fixture.chat.completions.create({
        model: "model-provider-error",
        messages: [{ role: "user", content: "question" }],
      }), (error) => error instanceof ProviderError && error.message === "worker provider error");
    } finally {
      await fixture.close();
    }
  });
});

test("separate account sessions and converter instances do not share model, history, or usage state", async () => {
  await withTempDirectory(async (root) => {
    const first = await makeFixture(root, {
      accountLabel: "isolation-A",
      onDispatch: async () => ({ stage: "completed", output: [assistant("answer-A")], result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 1 } } }),
    });
    const second = await makeFixture(root, {
      accountLabel: "isolation-B",
      onDispatch: async () => ({ stage: "completed", output: [assistant("answer-B")], result: { stopReason: "end_turn", usage: { inputTokens: 29, outputTokens: 2 } } }),
    });
    try {
      const [a, b] = await Promise.all([
        first.chat.completions.create({ model: "model-isolation-A", messages: [{ role: "user", content: "A" }] }),
        second.chat.completions.create({ model: "model-isolation-B", messages: [{ role: "user", content: "B" }] }),
      ]);
      assert.equal(a.model, "model-isolation-A");
      assert.equal(b.model, "model-isolation-B");
      assert.equal(a.choices[0].message.content, "answer-A");
      assert.equal(b.choices[0].message.content, "answer-B");
      assert.equal(a.usage.prompt_tokens, 11);
      assert.equal(b.usage.prompt_tokens, 29);
      assert.deepEqual(first.session.snapshot().transcript, [user([text("A")]), assistant([text("answer-A")])]);
      assert.deepEqual(second.session.snapshot().transcript, [user([text("B")]), assistant([text("answer-B")])]);
      assert.notEqual(first.session.accountId, second.session.accountId);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
