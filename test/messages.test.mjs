import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InvalidRequestError,
  MessageAccumulator,
  messageMaxTokensEnforcement,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
  SessionInterruptedError,
  UnsupportedFeatureError,
  createProfileRegistry,
  createProfileRuntimeManager,
  createProfileSessionEngine,
  mapMessagesToAcpPrompt,
  normalizeAcpUsage,
} from "../dist/index.js";
import { messageUsageProvenance } from "../dist/messages.js";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const textBlock = (text) => ({ type: "text", text });
const messageRequest = (messages, max_tokens = 64) => ({ max_tokens, messages });

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s5-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function makeFixture(root, {
  model = "model-s5",
  system,
  tools,
  capabilities = { maxTokens: "enforced" },
  includeAdmission = true,
  streamCleanupTimeoutMs,
  onDispatch = async () => ({
    stage: "completed",
    output: [assistant("answer")],
    result: { stopReason: "end_turn" },
  }),
  onAdmission,
  onStream,
  onClose = async () => {},
  onCreate,
} = {}) {
  const registry = await createProfileRegistry({
    storageDir: join(root, "profiles"),
    environment: { PATH: "/safe/bin" },
  });
  const profile = await registry.accounts.create();
  const runtimeManager = createProfileRuntimeManager();
  const operations = [];
  const streams = [];
  const admissions = [];
  const contexts = [];
  const engine = createProfileSessionEngine(registry.accounts, profile.id, {
    workerManager: runtimeManager,
    ...(streamCleanupTimeoutMs === undefined ? {} : { streamCleanupTimeoutMs }),
    driverFactory(context) {
      contexts.push(context);
      onCreate?.(context);
      return {
        capabilities,
        ...(includeAdmission ? {
          async admitResponse(request) {
            admissions.push(request);
            const result = await onAdmission?.(request, admissions.length);
            const outcome = request.maxTokens === undefined
              ? "unbounded"
              : capabilities.maxTokens === "enforced" ? "enforced" : "ignored";
            return result ?? {
              kind: request.kind,
              operationId: request.operationId,
              accountId: request.accountId,
              sessionId: request.sessionId,
              ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
              policy: request.policy,
              outcome,
              reason: outcome === "enforced"
                ? "driver-admitted-requested-bound"
                : outcome === "ignored"
                  ? "backend-does-not-enforce-requested-bound"
                  : "no-output-token-bound-requested",
            };
          },
        } : {}),
        async dispatch(operation) {
          operations.push(operation);
          return onDispatch(operation, operations.length);
        },
        ...(onStream === undefined ? {} : {
          stream(operation) {
            streams.push(operation);
            return onStream(operation, streams.length);
          },
        }),
        async close() { await onClose(context); },
      };
    },
  });
  const createOptions = { model, cwd: "/workspace", ...(system === undefined ? {} : { system }), ...(tools === undefined ? {} : { tools }) };
  const session = await engine.create(createOptions);
  return { registry, profile, runtimeManager, engine, session, operations, streams, admissions, contexts };
}

async function closeFixture(fixture) {
  await fixture.session.close();
  await fixture.engine.close();
}

test("nonstream Messages map initial text history and system instructions into ACP v1 text blocks", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      system: [{ type: "text", text: "Be precise." }, { type: "text", text: " Keep names." }],
      onDispatch: async (operation) => ({
        stage: "completed",
        output: [assistant("héllo  ")],
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 21, outputTokens: 4 },
          contextOccupancy: { tokens: 8192, source: "ACP session occupancy" },
        },
      }),
    });
    try {
      const initial = [
        user("first question"),
        assistant([textBlock("prior "), textBlock("answer")]),
        user("current question"),
      ];
      const response = await fixture.session.messages.create({ ...messageRequest(initial, 73), stream: false });
      assert.equal(response.type, "message");
      assert.equal(response.role, "assistant");
      assert.equal(response.model, "model-s5");
      assert.match(response.id, /^msg_[0-9a-f-]+$/u);
      assert.deepEqual(response.content, [textBlock("héllo  ")]);
      assert.equal(response.stop_reason, "end_turn");
      assert.equal(response.stop_sequence, null);
      assert.equal(response.stop_details, null);
      assert.deepEqual(response.usage, {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        input_tokens: 21,
        output_tokens: 4,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      });
      assert.equal(Object.hasOwn(response, "thinking"), false);
      assert.equal(Object.hasOwn(response, "signature"), false);

      assert.deepEqual(fixture.operations[0].messages, initial, "the first ACP driver operation receives the full initial suffix");
      assert.equal(fixture.operations[0].accountId, fixture.profile.id);
      assert.equal(fixture.operations[0].sessionId, fixture.session.sessionId);
      assert.equal(fixture.operations[0].maxTokens, 73);
      assert.equal(fixture.operations[0].admission.maxTokens, 73);
      assert.equal(fixture.admissions[0].maxTokens, 73);
      assert.deepEqual(fixture.operations[0].acpPrompt, [
        { type: "text", text: "<instruction>\nBe precise. Keep names.\n</instruction>" },
        { type: "text", text: "[user]\nfirst question" },
        { type: "text", text: "[assistant]\nprior answer" },
        { type: "text", text: "[user]\ncurrent question" },
      ]);
      assert.deepEqual(fixture.session.snapshot().transcript, [
        ...initial,
        assistant([textBlock("héllo  ")]),
      ], "the caller-visible normalized assistant Message is what the ledger commits");
      const diagnostics = await fixture.session.diagnostics.snapshot();
      assert.deepEqual(diagnostics.maxTokensEnforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 73,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      });
      assert.deepEqual({ usage: diagnostics.usage, contextOccupancy: diagnostics.contextOccupancy }, {
        usage: {
          kind: "reported",
          source: "ACP prompt response usage",
          inputTokens: 21,
          outputTokens: 4,
        },
        contextOccupancy: { tokens: 8192, source: "ACP session occupancy" },
      });

      const divergent = [
        user("tampered history"),
        ...initial.slice(1),
        assistant([textBlock("héllo  ")]),
        user("must not dispatch"),
      ];
      await assert.rejects(fixture.session.messages.create(messageRequest(divergent)), InvalidRequestError);
      assert.equal(fixture.operations.length, 1, "prefix divergence is rejected before ACP dispatch");

      const followup = [
        ...initial,
        assistant([textBlock("héllo  ")]),
        user("next question"),
      ];
      await fixture.session.messages.create(messageRequest(followup));
      assert.deepEqual(fixture.operations[1].messages, [user("next question")], "only the full-transcript suffix is dispatched");
      assert.deepEqual(fixture.operations[1].acpPrompt, [{ type: "text", text: "[user]\nnext question" }]);
      assert.equal(fixture.operations[1].acpPrompt.some((block) => block.text.includes("<instruction>")), false);
      assert.equal(fixture.session.snapshot().revision, 2);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("Anthropic stop reasons map only from explicit supported ACP terminal results", async () => {
  await withTempDirectory(async (root) => {
    const reasons = ["end_turn", "max_tokens", "refusal", "model_context_window_exceeded"];
    let index = 0;
    const fixture = await makeFixture(root, {
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant(`answer-${index}`)],
        result: { stopReason: reasons[index++] },
      }),
    });
    try {
      let transcript = [];
      for (const [turn, reason] of reasons.entries()) {
        const requestMessages = [...transcript, user(`question-${turn}`)];
        const message = await fixture.session.messages.create(messageRequest(requestMessages));
        assert.equal(message.stop_reason, reason);
        transcript = [...requestMessages, assistant(message.content)];
      }
      assert.equal(fixture.operations.length, reasons.length);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("missing and unenforced max_tokens are admitted without synthesizing an output bound", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { capabilities: {} });
    try {
      const unbounded = await fixture.session.messages.create({ messages: [user("no bound supplied")] });
      assert.equal(unbounded.content[0].text, "answer");
      assert.equal(Object.hasOwn(fixture.operations[0], "maxTokens"), false);
      assert.equal(Object.hasOwn(fixture.admissions[0], "maxTokens"), false);
      assert.deepEqual((await fixture.session.diagnostics.snapshot()).maxTokensEnforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[0].operationId,
        kind: "prompt",
        policy: "strict",
        outcome: "unbounded",
        reason: "no-output-token-bound-requested",
      });

      const supplied = await fixture.session.messages.create({
        max_tokens: 17,
        messages: [...fixture.session.snapshot().transcript, user("bound is ignored")],
      });
      assert.equal(supplied.content[0].text, "answer");
      assert.equal(fixture.operations[1].maxTokens, 17);
      assert.equal((await fixture.session.diagnostics.snapshot()).maxTokensEnforcement.outcome, "ignored");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("an explicit maxTokens capability forwards the exact required hard bound to the driver", async () => {
  await withTempDirectory(async (root) => {
    let observedBound;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced" },
      onDispatch: async (operation) => {
        observedBound = operation.maxTokens;
        assert.equal(operation.maxTokens, 17);
        return { stage: "completed", output: [assistant("bounded")], result: { stopReason: "max_tokens" } };
      },
    });
    try {
      const response = await fixture.session.messages.create(messageRequest([user("bound me")], 17));
      assert.equal(observedBound, 17);
      assert.equal(fixture.admissions[0].maxTokens, 17);
      assert.equal(response.stop_reason, "max_tokens");
      assert.deepEqual(fixture.session.snapshot().transcript.at(-1), assistant([textBlock("bounded")]));
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("maxTokens capability alone cannot admit a response, and admission failures are retryable before dispatch", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced" },
      includeAdmission: false,
    });
    try {
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("capability is not admission")], 29)),
        UnsupportedFeatureError,
      );
      assert.equal(fixture.operations.length, 0);
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    let admissionCount = 0;
    const fixture = await makeFixture(root, {
      onAdmission: async (request) => {
        admissionCount += 1;
        if (admissionCount === 1) throw new UnsupportedFeatureError("fixture cannot admit this first limit");
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
    });
    try {
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("retry me")], 23)),
        UnsupportedFeatureError,
      );
      assert.equal(fixture.operations.length, 0, "admission rejection precedes dispatch");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      assert.equal(fixture.session.state, "idle", "a response not admitted is retryable");

      const response = await fixture.session.messages.create(messageRequest([user("retry me")], 37));
      assert.equal(response.content[0].text, "answer");
      assert.deepEqual(fixture.admissions.map(({ maxTokens, kind }) => ({ maxTokens, kind })), [
        { maxTokens: 23, kind: "prompt" },
        { maxTokens: 37, kind: "prompt" },
      ]);
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.operations[0].maxTokens, 37);
      assert.equal(fixture.operations[0].admission.maxTokens, 37);
      assert.equal(fixture.admissions[1].accountId, fixture.session.accountId);
      assert.equal(fixture.admissions[1].sessionId, fixture.session.sessionId);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("strict legacy policy admits ignored bounds but rejects forged admission outcomes", async () => {
  await withTempDirectory(async (root) => {
    let admissionCalls = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "not-enforced" },
      onAdmission: async (request) => {
        admissionCalls += 1;
        return {
          kind: request.kind,
          operationId: request.operationId,
          accountId: request.accountId,
          sessionId: request.sessionId,
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          policy: request.policy,
          outcome: "ignored",
          reason: "backend-does-not-enforce-requested-bound",
        };
      },
    });
    try {
      assert.equal(fixture.contexts[0].maxTokensPolicy, "strict");
      assert.equal(fixture.session.capabilities.maxTokens, "not-enforced");
      const response = await fixture.session.messages.create(messageRequest([user("unbounded is allowed")], 13));
      assert.equal(response.content[0].text, "answer");
      assert.equal(messageMaxTokensEnforcement(response).outcome, "ignored");
      assert.equal(admissionCalls, 1);
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced" },
      onAdmission: async (request) => ({
        kind: request.kind,
        operationId: request.operationId,
        accountId: request.accountId,
        sessionId: request.sessionId,
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        policy: request.policy,
        outcome: "ignored",
        reason: "backend-does-not-enforce-requested-bound",
      }),
    });
    try {
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("forged outcome")], 17)),
        ProtocolFailureError,
      );
      assert.equal(fixture.operations.length, 0, "a forged outcome cannot reach the driver dispatch");
      assert.equal(fixture.session.state, "idle", "invalid admission remains retryable before dispatch");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("initial streaming admission is before stream dispatch; abort and same-session races remain retryable", async () => {
  await withTempDirectory(async (root) => {
    let admissionCount = 0;
    const acknowledgement = {
      stage: "completed",
      output: [assistant("streamed")],
      result: { stopReason: "end_turn" },
    };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onAdmission: async (request) => {
        admissionCount += 1;
        if (admissionCount === 1) throw new UnsupportedFeatureError("fixture admission failed");
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
      onStream: () => (async function* () {
        yield { type: "text", text: "streamed" };
        yield { type: "complete", acknowledgement };
      })(),
    });
    try {
      const rejectedStream = await fixture.session.messages.create({
        ...messageRequest([user("stream retry")], 31),
        stream: true,
      });
      await assert.rejects(async () => {
        for await (const _event of rejectedStream) { /* the admission must fail first */ }
      }, UnsupportedFeatureError);
      assert.equal(fixture.streams.length, 0);
      assert.equal(fixture.session.state, "idle");
      assert.deepEqual(fixture.session.snapshot().transcript, []);

      const admittedStream = await fixture.session.messages.create({
        ...messageRequest([user("stream retry")], 47),
        stream: true,
      });
      const events = [];
      for await (const event of admittedStream) events.push(event);
      assert.equal(fixture.streams.length, 1);
      assert.equal(fixture.streams[0].maxTokens, 47);
      assert.equal(fixture.streams[0].admission.maxTokens, 47);
      assert.deepEqual(fixture.admissions.map(({ maxTokens }) => maxTokens), [31, 47]);
      assert.equal(fixture.session.state, "idle");
      assert.equal(events.at(-1).type, "message_stop");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    let enterAdmission;
    const admissionEntered = new Promise((resolve) => { enterAdmission = resolve; });
    let releaseAdmission;
    const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
    let attempts = 0;
    const fixture = await makeFixture(root, {
      onAdmission: async (request) => {
        attempts += 1;
        if (attempts === 1) {
          enterAdmission();
          await admissionGate;
        }
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
    });
    try {
      const controller = new AbortController();
      const first = fixture.session.messages.create(messageRequest([user("cancel admission")], 41), { signal: controller.signal });
      await admissionEntered;
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("racing prompt")], 43)),
        SessionBusyError,
      );
      controller.abort();
      await assert.rejects(first, RequestAbortedError);
      assert.equal(fixture.session.state, "idle");
      assert.equal(fixture.operations.length, 0);
      releaseAdmission();
      await new Promise((resolve) => setImmediate(resolve));
      await fixture.session.messages.create(messageRequest([user("cancel admission")], 53));
      assert.equal(fixture.operations.length, 1);
      assert.deepEqual(fixture.operations.map(({ maxTokens }) => maxTokens), [53]);
    } finally {
      releaseAdmission();
      await closeFixture(fixture);
    }
  });
});

test("unsupported request fields, roles, blocks, pinned tools, and system formats fail before dispatch", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root);
    try {
      const base = [user("valid")];
      const unsupportedRequests = [
        { ...messageRequest(base), temperature: 0.2 },
        { ...messageRequest(base), top_p: 0.5 },
        { ...messageRequest(base), top_k: 5 },
        { ...messageRequest(base), stop_sequences: ["stop"] },
        { ...messageRequest(base), thinking: { type: "enabled", budget_tokens: 10 } },
        { ...messageRequest(base), output_config: { format: { type: "json_schema" } } },
        { ...messageRequest(base), response_format: { type: "json_object" } },
        { ...messageRequest(base), tool_choice: { type: "auto" } },
        { ...messageRequest(base), model: "other-model" },
        { ...messageRequest(base), system: "changed" },
        { ...messageRequest(base), tools: [] },
        { ...messageRequest(base), metadata: { user_id: "not part of S5" } },
        { ...messageRequest(base), stream: true },
        messageRequest([{ role: "system", content: "system turn" }]),
        messageRequest([{ role: "tool", content: "tool result" }]),
        messageRequest([user([{ type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } }])]),
        messageRequest([user([{ type: "text", text: "cached text", cache_control: { type: "ephemeral" } }])]),
      ];
      for (const request of unsupportedRequests) {
        await assert.rejects(fixture.session.messages.create(request), UnsupportedFeatureError);
      }
      const unbounded = await fixture.session.messages.create({ messages: base });
      assert.equal(messageMaxTokensEnforcement(unbounded).outcome, "unbounded");
      await assert.rejects(fixture.session.messages.create(messageRequest([])), InvalidRequestError);
      await assert.rejects(fixture.session.messages.create(messageRequest([user("x")], 0)), InvalidRequestError);
      await assert.rejects(fixture.session.messages.create({ ...messageRequest(base), stream: 0 }), InvalidRequestError);
      await assert.rejects(fixture.session.messages.create(messageRequest([{ role: 5, content: "bad" }])), InvalidRequestError);
      await assert.rejects(fixture.session.messages.create(messageRequest([user([{ type: "text", text: 1 }])])), InvalidRequestError);
      const accessorRequest = {};
      Object.defineProperty(accessorRequest, "messages", { enumerable: true, get() { throw new Error("getter ran"); } });
      accessorRequest.max_tokens = 64;
      await assert.rejects(fixture.session.messages.create(accessorRequest), InvalidRequestError);
      let streamGetterRan = false;
      const accessorStreamRequest = { max_tokens: 64, messages: base };
      Object.defineProperty(accessorStreamRequest, "stream", {
        enumerable: true,
        get() { streamGetterRan = true; throw new Error("stream getter ran"); },
      });
      await assert.rejects(fixture.session.messages.create(accessorStreamRequest), InvalidRequestError);
      assert.equal(streamGetterRan, false);
      assert.equal(fixture.operations.length, 1, "the valid omitted-bound request is dispatched");
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { tools: [{ name: "lookup", input_schema: { type: "object" } }] });
    try {
      const response = await fixture.session.messages.create(messageRequest([user("use lookup")]));
      assert.equal(response.stop_reason, "end_turn");
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { system: [{ type: "text", text: "instruction", cache_control: { type: "ephemeral" } }] });
    try {
      await assert.rejects(fixture.session.messages.create(messageRequest([user("x")])), UnsupportedFeatureError);
      assert.equal(fixture.operations.length, 0);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("measured and unavailable usage are distinguished from context occupancy", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      onDispatch: async (_operation, count) => ({
        stage: "completed",
        output: [assistant("ok")],
        result: count === 1
          ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 }, contextOccupancy: { tokens: 4096, source: "ACP context state" } }
          : count === 2
            ? { stopReason: "end_turn", usage: { inputTokens: 10 }, contextOccupancy: { tokens: 8192, source: "ACP context state" } }
            : { stopReason: "end_turn" },
      }),
    });
    try {
      const first = await fixture.session.messages.create(messageRequest([user("measure") ]));
      assert.equal(first.usage.input_tokens, 10);
      assert.equal(first.usage.output_tokens, 3);
      const firstDiagnostics = await fixture.session.diagnostics.snapshot();
      assert.deepEqual(firstDiagnostics.maxTokensEnforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 64,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      });
      assert.deepEqual({ usage: firstDiagnostics.usage, contextOccupancy: firstDiagnostics.contextOccupancy }, {
        usage: { kind: "reported", source: "ACP prompt response usage", inputTokens: 10, outputTokens: 3 },
        contextOccupancy: { tokens: 4096, source: "ACP context state" },
      });

      const secondTranscript = [user("measure"), assistant(first.content), user("missing usage")];
      const second = await fixture.session.messages.create(messageRequest(secondTranscript));
      assert.equal(second.usage.input_tokens, 0, "Anthropic-required wire placeholder is documented, not a measured count");
      assert.equal(second.usage.output_tokens, 0);
      const secondDiagnostics = await fixture.session.diagnostics.snapshot();
      assert.deepEqual(secondDiagnostics.maxTokensEnforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[1].operationId,
        kind: "prompt",
        requestedMaxTokens: 64,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      });
      assert.deepEqual({ usage: secondDiagnostics.usage, contextOccupancy: secondDiagnostics.contextOccupancy }, {
        usage: { kind: "unknown", reason: "The ACP driver did not report complete per-operation token usage." },
        contextOccupancy: { tokens: 8192, source: "ACP context state" },
      });
      const thirdTranscript = [...secondTranscript, assistant(second.content), user("no occupancy")];
      await fixture.session.messages.create(messageRequest(thirdTranscript));
      const thirdDiagnostics = await fixture.session.diagnostics.snapshot();
      assert.deepEqual(thirdDiagnostics.maxTokensEnforcement, {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.operations[2].operationId,
        kind: "prompt",
        requestedMaxTokens: 64,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      });
      assert.deepEqual({ usage: thirdDiagnostics.usage }, {
        usage: { kind: "unknown", reason: "The ACP driver did not report complete per-operation token usage." },
      }, "diagnostics do not present an earlier occupancy reading as current");
      assert.deepEqual(normalizeAcpUsage({ inputTokens: 10 }), {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
      assert.deepEqual(normalizeAcpUsage({ inputTokens: -1, outputTokens: 3 }), {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("ACP usage cache totals and reasoning counts are exposed only when explicitly reported", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant("visible text only")],
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 30, outputTokens: 10, cachedReadTokens: 5, cachedWriteTokens: 2, thoughtTokens: 4 },
        },
      }),
    });
    try {
      const response = await fixture.session.messages.create(messageRequest([user("usage details")]));
      assert.deepEqual(response.content, [textBlock("visible text only")]);
      assert.equal(response.content.some((block) => block.type === "thinking"), false);
      assert.deepEqual(response.usage, {
        cache_creation: null,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 5,
        inference_geo: null,
        input_tokens: 23,
        output_tokens: 10,
        output_tokens_details: { thinking_tokens: 4 },
        server_tool_use: null,
        service_tier: null,
        speed: null,
      });
      assert.deepEqual((await fixture.session.diagnostics.snapshot()).usage, {
        kind: "reported",
        source: "ACP prompt response usage",
        inputTokens: 23,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        thinkingTokens: 4,
      });
      assert.deepEqual(normalizeAcpUsage({ inputTokens: 4, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 2 }), {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      }, "impossible inclusive cache totals remain unknown rather than being clamped");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("busy, abort, and worker crash preserve ledger admission and never commit false success", async () => {
  await withTempDirectory(async (root) => {
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    let finish;
    const resultPromise = new Promise((resolve) => { finish = resolve; });
    const fixture = await makeFixture(root, {
      onDispatch: async () => {
        entered();
        return resultPromise;
      },
    });
    try {
      const active = fixture.session.messages.create(messageRequest([user("first") ]));
      await enteredPromise;
      await assert.rejects(fixture.session.messages.create(messageRequest([user("busy") ])), SessionBusyError);
      finish({ stage: "completed", output: [assistant("done")], result: { stopReason: "end_turn" } });
      await active;
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const fixture = await makeFixture(root, {
      onDispatch: async (operation) => new Promise((_resolve, reject) => {
        entered();
        operation.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });
    try {
      const controller = new AbortController();
      const request = messageRequest([user("abort me")]);
      const active = fixture.session.messages.create(request, { signal: controller.signal });
      await enteredPromise;
      controller.abort();
      await assert.rejects(active, RequestAbortedError);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      await assert.rejects(fixture.session.messages.create(request), SessionInterruptedError);
      assert.equal(fixture.operations.length, 1);
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, { onDispatch: async () => { throw new Error("secret child detail"); } });
    try {
      const request = messageRequest([user("crash")]);
      await assert.rejects(fixture.session.messages.create(request), (error) => {
        assert.ok(error instanceof ProcessFailureError);
        assert.equal(error.message.includes("secret child detail"), false);
        return true;
      });
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      await assert.rejects(fixture.session.messages.create(request), SessionInterruptedError);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("malformed or unsupported terminal ACP results are errors before ledger commit", async () => {
  for (const acknowledgement of [
    { stage: "completed", output: [assistant("looks successful but no terminal") ] },
    { stage: "completed", output: [assistant("text")], result: { stopReason: "mystery" } },
    { stage: "completed", output: [assistant([])], result: { stopReason: "end_turn" } },
    { stage: "completed", output: [assistant([{ type: "thinking", thinking: "private", signature: "fake" }])], result: { stopReason: "end_turn" } },
    { stage: "awaiting_tools", output: [assistant("tool boundary")], result: { stopReason: "end_turn" } },
    { stage: "completed", output: [assistant("not handed off")], result: { stopReason: "tool_use" } },
  ]) {
    await withTempDirectory(async (root) => {
      const fixture = await makeFixture(root, { onDispatch: async () => acknowledgement });
      try {
        await assert.rejects(fixture.session.messages.create(messageRequest([user("must not fake success")])), ProtocolFailureError);
        assert.equal(fixture.session.state, "interrupted");
        assert.deepEqual(fixture.session.snapshot().transcript, []);
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("historical tool blocks remain inert transcript and do not grant side-effect authority", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root);
    try {
      const history = [
        assistant([{ type: "tool_use", id: "toolu_old", name: "run", input: {} }]),
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "already ran" }] },
        user("continue"),
      ];
      const response = await fixture.session.messages.create(messageRequest(history));
      assert.equal(response.stop_reason, "end_turn");
      assert.equal(fixture.operations.length, 1);
      assert.equal(fixture.session.state, "idle");
      assert.deepEqual(fixture.session.snapshot().transcript.slice(0, history.length), history);
      assert.deepEqual(await fixture.session.diagnostics.toolHandoffs(), []);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("semantic accumulator requires a terminal reason and emits no thinking blocks", () => {
  const incomplete = new MessageAccumulator("m");
  incomplete.add({ type: "text", text: "visible" });
  assert.throws(() => incomplete.finish(), ProtocolFailureError);

  const complete = new MessageAccumulator("m", "msg_fixed");
  complete.add({ type: "text", text: "visible" });
  complete.add({ type: "usage", usage: { kind: "unknown", reason: "not reported" } });
  complete.add({ type: "stop", stopReason: "end_turn" });
  const message = complete.finish();
  assert.equal(message.id, "msg_fixed");
  assert.deepEqual(message.content, [textBlock("visible")]);
  assert.equal(message.content.some((block) => block.type === "thinking"), false);
  assert.deepEqual([message.usage.input_tokens, message.usage.output_tokens], [0, 0]);
  assert.throws(() => complete.add({ type: "text", text: "late" }), ProtocolFailureError);
});

test("prompt helper preserves roles and system tagging without passing committed history", () => {
  const prompt = mapMessagesToAcpPrompt({ model: "m", cwd: "/w", system: "Policy." }, [
    user("one"),
    assistant([textBlock("two"), textBlock(" three")]),
  ]);
  assert.deepEqual(prompt, [
    { type: "text", text: "<instruction>\nPolicy.\n</instruction>" },
    { type: "text", text: "[user]\none" },
    { type: "text", text: "[assistant]\ntwo three" },
  ]);
});

test("native Messages streams preserve an omitted output bound as unbounded", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      async *onStream() {
        yield { type: "text", text: "unbounded stream" };
        yield {
          type: "complete",
          acknowledgement: {
            stage: "completed",
            output: [assistant("unbounded stream")],
            result: { stopReason: "end_turn" },
          },
        };
      },
    });
    try {
      const stream = await fixture.session.messages.create({
        messages: [user("no output bound")],
        stream: true,
      });
      const events = [];
      for await (const event of stream) events.push(event);
      const start = events.find(({ type }) => type === "message_start");
      assert.ok(start);
      assert.deepEqual(messageMaxTokensEnforcement(start.message), {
        accountId: fixture.session.accountId,
        sessionId: fixture.session.sessionId,
        operationId: fixture.streams[0].operationId,
        kind: "prompt",
        policy: "strict",
        outcome: "unbounded",
        reason: "no-output-token-bound-requested",
      });
      assert.equal(Object.hasOwn(fixture.streams[0], "maxTokens"), false);
      assert.equal(Object.hasOwn(fixture.admissions[0], "maxTokens"), false);
      assert.equal(events.at(-1).type, "message_stop");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("incremental Messages streams preserve text, event order, usage, and nonstream parity", async () => {
  await withTempDirectory(async (root) => {
    const answerText = "  hé🙂llo\n  ";
    const acknowledgement = {
      stage: "completed",
      output: [assistant(answerText)],
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 19, outputTokens: 6, cachedReadTokens: 3 },
        contextOccupancy: { tokens: 2048, source: "fake ACP stream fixture" },
      },
    };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onDispatch: async () => acknowledgement,
      onStream: () => (async function* () {
        yield { type: "text", text: "  h" };
        yield { type: "text", text: "é🙂" };
        yield { type: "text", text: "llo\n  " };
        yield { type: "complete", acknowledgement };
      })(),
    });
    try {
      const request = messageRequest([user("parity")]);
      const nonstream = await fixture.session.messages.create(request);
      assert.deepEqual(nonstream.content, [textBlock(answerText)]);

      const streamRequest = messageRequest([
        user("parity"),
        assistant(nonstream.content),
        user("stream parity"),
      ]);
      const stream = await fixture.session.messages.create({ ...streamRequest, stream: true });
      const events = [];
      for await (const event of stream) events.push(event);

      assert.deepEqual(events.map((event) => event.type), [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      assert.deepEqual(events.slice(1, -1).filter((event) => "index" in event).map((event) => event.index), [0, 0, 0, 0, 0]);
      assert.deepEqual(events.slice(2, 5).map((event) => event.delta.text), ["  h", "é🙂", "llo\n  "], "Unicode, whitespace, and newlines are emitted exactly");
      assert.match(events[0].message.id, /^msg_[0-9a-f-]+$/u);
      assert.equal(events[0].message.model, "model-s5");
      assert.deepEqual(events[0].message.content, []);
      assert.equal(events[0].message.stop_reason, null);
      assert.deepEqual(events[1].content_block, { type: "text", text: "" });
      assert.deepEqual(events[6].delta, {
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        container: null,
      });
      assert.deepEqual(events[6].usage, {
        input_tokens: 16,
        output_tokens: 6,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 3,
        output_tokens_details: null,
        server_tool_use: null,
      });

      const streamText = events
        .filter((event) => event.type === "content_block_delta")
        .map((event) => event.delta.text)
        .join("");
      assert.equal(streamText, nonstream.content[0].text);
      assert.equal(events[6].delta.stop_reason, nonstream.stop_reason);
      assert.deepEqual(events[6].usage, {
        input_tokens: nonstream.usage.input_tokens,
        output_tokens: nonstream.usage.output_tokens,
        cache_creation_input_tokens: nonstream.usage.cache_creation_input_tokens,
        cache_read_input_tokens: nonstream.usage.cache_read_input_tokens,
        output_tokens_details: nonstream.usage.output_tokens_details,
        server_tool_use: nonstream.usage.server_tool_use,
      });
      assert.equal(fixture.session.snapshot().revision, 2);
      assert.deepEqual(fixture.session.snapshot().transcript.at(-1), assistant([textBlock(answerText)]));
      assert.deepEqual((await fixture.session.diagnostics.snapshot()).usage, {
        kind: "reported",
        source: "ACP prompt response usage",
        inputTokens: 16,
        outputTokens: 6,
        cacheReadInputTokens: 3,
      });
      assert.equal(fixture.streams[0].accountId, fixture.profile.id);
      assert.equal(fixture.streams[0].sessionId, fixture.session.sessionId);
      assert.equal(fixture.streams[0].maxTokens, 64);
      assert.deepEqual(fixture.streams[0].messages, [user("stream parity")]);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("response-scoped enforcement receipts stay immutable across responses, sessions, foreign objects, and abort", async () => {
  await withTempDirectory(async (root) => {
    const first = await makeFixture(root, {
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant("first")],
        result: { stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
      }),
    });
    const second = await makeFixture(root, {
      onDispatch: async () => ({
        stage: "completed",
        output: [assistant("second")],
        result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 } },
      }),
    });
    try {
      const responseA = await first.session.messages.create(messageRequest([user("A")], 11));
      const receiptA = messageMaxTokensEnforcement(responseA);
      assert.notEqual(first.session.accountId, second.session.accountId);
      assert.notEqual(first.session.sessionId, second.session.sessionId);
      assert.equal(responseA.max_tokens_enforcement, undefined, "native Anthropic Message fields remain unmodified");
      assert.deepEqual(receiptA, {
        accountId: first.session.accountId,
        sessionId: first.session.sessionId,
        operationId: first.operations[0].operationId,
        kind: "prompt",
        requestedMaxTokens: 11,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      });
      assert.equal(Object.isFrozen(receiptA), true);
      assert.equal(Reflect.set(receiptA, "requestedMaxTokens", 999), false);
      assert.equal(receiptA.requestedMaxTokens, 11, "the public receipt cannot be mutated");

      const responseB = await second.session.messages.create(messageRequest([user("B")], 29));
      const receiptB = messageMaxTokensEnforcement(responseB);
      assert.equal(receiptB.accountId, second.session.accountId);
      assert.equal(receiptB.sessionId, second.session.sessionId);
      assert.equal(receiptB.requestedMaxTokens, 29);
      assert.notEqual(receiptA.operationId, receiptB.operationId);
      assert.deepEqual(messageMaxTokensEnforcement(responseA), receiptA,
        "the second session/operation cannot replace response A's diagnostic");
      assert.equal(messageMaxTokensEnforcement({ type: "message" }), undefined);
      assert.equal(messageMaxTokensEnforcement(Object.freeze({})), undefined);
      assert.equal(messageMaxTokensEnforcement(first.session), undefined);
      assert.equal(messageMaxTokensEnforcement(first.account), undefined);
      assert.equal(messageMaxTokensEnforcement({ ...responseA }), undefined,
        "a copied response is not associated by structural similarity");
      assert.equal(messageUsageProvenance(responseA).kind, "reported");
      assert.equal(messageUsageProvenance(responseB).inputTokens, 3);
      assert.equal(messageUsageProvenance({}), undefined);

      responseA.max_tokens_enforcement = { outcome: "ignored" };
      assert.deepEqual(messageMaxTokensEnforcement(responseA), receiptA,
        "mutating an Anthropic payload cannot mutate its out-of-band receipt");
      assert.equal(Object.isFrozen(messageMaxTokensEnforcement(responseA)), true);
    } finally {
      await closeFixture(first);
      await closeFixture(second);
    }

    let dispatched;
    const streamed = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: async function* (operation) {
        dispatched = operation;
        yield { type: "text", text: "partial" };
        yield { type: "text", text: "unrequested after abort" };
      },
    });
    try {
      const stream = await streamed.session.messages.create({
        max_tokens: 37,
        messages: [user("stream")],
        stream: true,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const firstEvent = await iterator.next();
      assert.equal(firstEvent.value.type, "message_start");
      const message = firstEvent.value.message;
      const receipt = messageMaxTokensEnforcement(message);
      assert.deepEqual(receipt, {
        accountId: streamed.session.accountId,
        sessionId: streamed.session.sessionId,
        operationId: dispatched.operationId,
        kind: "prompt",
        requestedMaxTokens: 37,
        policy: "strict",
        outcome: "enforced",
        reason: "driver-admitted-requested-bound",
      }, "the native message_start carries its out-of-band receipt before the first event is returned");
      assert.equal(Object.hasOwn(message, "max_tokens_enforcement"), false);
      await iterator.return();
      assert.deepEqual(messageMaxTokensEnforcement(message), receipt,
        "aborting after message_start leaves that exact response diagnostic available");
      assert.equal(messageUsageProvenance(message), undefined, "aborted output has no premature completed usage provenance");
      assert.equal(streamed.session.snapshot().transcript.length, 0);
    } finally {
      await closeFixture(streamed);
    }
  });
});

test("streamed empty text is a real text block and unknown usage stays explicitly unknown", async () => {
  await withTempDirectory(async (root) => {
    const acknowledgement = {
      stage: "completed",
      output: [assistant("")],
      result: { stopReason: "end_turn" },
    };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => (async function* () {
        yield { type: "text", text: "" };
        yield { type: "complete", acknowledgement };
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("empty")]), stream: true });
      const events = [];
      for await (const event of stream) events.push(event);
      assert.deepEqual(events.map((event) => event.type), [
        "message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop",
      ]);
      assert.deepEqual(events[1].content_block, { type: "text", text: "" });
      assert.deepEqual(events[3].usage, {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens_details: null,
        server_tool_use: null,
      });
      assert.deepEqual((await fixture.session.diagnostics.snapshot()).usage, {
        kind: "unknown",
        reason: "The ACP driver did not report complete per-operation token usage.",
      });
      assert.deepEqual(fixture.session.snapshot().transcript.at(-1), assistant([textBlock("")]));
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("stream capability and unsupported request fields are rejected before streaming dispatch", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root);
    try {
      await assert.rejects(
        fixture.session.messages.create({ ...messageRequest([user("unsupported")]), stream: true }),
        UnsupportedFeatureError,
      );
      await assert.rejects(
        fixture.session.messages.create({ ...messageRequest([user("unsupported")]), stream: true, temperature: 0 }),
        UnsupportedFeatureError,
      );
      assert.equal(fixture.streams.length, 0);
      assert.equal(fixture.operations.length, 0);
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced" },
      onStream: () => (async function* () {
        yield { type: "text", text: "must not run" };
      })(),
    });
    try {
      await assert.rejects(
        fixture.session.messages.create({ ...messageRequest([user("missing declaration")]), stream: true }),
        UnsupportedFeatureError,
      );
      assert.equal(fixture.streams.length, 0);
      assert.equal(fixture.session.state, "idle");
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("an already-aborted streaming request never dispatches", async () => {
  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => { throw new Error("must not dispatch"); },
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        fixture.session.messages.create(
          { ...messageRequest([user("already aborted")]), stream: true },
          { signal: controller.signal },
        ),
        RequestAbortedError,
      );
      assert.equal(fixture.streams.length, 0);
      assert.equal(fixture.session.state, "idle");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("a lazy stream revalidates the session revision before dispatch", async () => {
  await withTempDirectory(async (root) => {
    let streamCalls = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onDispatch: async () => ({ stage: "completed", output: [assistant("prior")], result: { stopReason: "end_turn" } }),
      onStream: () => {
        streamCalls += 1;
        return (async function* () {
          yield { type: "text", text: "stale" };
        })();
      },
    });
    try {
      const staleStream = await fixture.session.messages.create({
        ...messageRequest([user("stream created first")]),
        stream: true,
      });
      await fixture.session.messages.create(messageRequest([user("nonstream completes first")]));
      await assert.rejects((async () => {
        for await (const _event of staleStream) { /* drain */ }
      })(), InvalidRequestError);
      assert.equal(streamCalls, 0, "a stream created for the old revision is rejected before worker dispatch");
      assert.equal(fixture.session.snapshot().revision, 1);
      assert.deepEqual(fixture.session.snapshot().transcript.at(-1), assistant([textBlock("prior")]));
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("abort during a pending incremental read cancels and cleans up without committing partial output", async () => {
  await withTempDirectory(async (root) => {
    let cleanupCount = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: (operation) => (async function* () {
        try {
          yield { type: "text", text: "partial" };
          await new Promise((_resolve, reject) => {
            operation.signal.addEventListener("abort", () => reject(new Error("driver cancelled")), { once: true });
          });
        } finally {
          cleanupCount += 1;
        }
      })(),
    });
    try {
      const controller = new AbortController();
      const stream = await fixture.session.messages.create(
        { ...messageRequest([user("abort")]), stream: true },
        { signal: controller.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type, "message_start");
      assert.equal((await iterator.next()).value.type, "content_block_start");
      assert.equal((await iterator.next()).value.type, "content_block_delta");
      const pending = iterator.next();
      controller.abort();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal((await iterator.next()).done, true, "a failed async iterator is terminal after its first thrown error");
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      assert.equal(cleanupCount, 1);
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("abort")])),
        SessionInterruptedError,
      );
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("iterator return cancels a pending worker read even without a caller AbortSignal", async () => {
  await withTempDirectory(async (root) => {
    let cleanupCount = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: (operation) => (async function* () {
        try {
          yield { type: "text", text: "partial" };
          await new Promise((_resolve, reject) => {
            operation.signal.addEventListener("abort", () => reject(new Error("iterator returned")), { once: true });
          });
        } finally {
          cleanupCount += 1;
        }
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("return pending")]), stream: true });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      await iterator.next();
      const pending = iterator.next();
      const returned = iterator.return();
      await assert.rejects(pending, RequestAbortedError);
      assert.equal((await returned).done, true);
      assert.equal(cleanupCount, 1);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("hung stream reads and returns fail within the configured cleanup deadline", async () => {
  const assertTimeoutCause = (error) => {
    assert.ok(error instanceof ProcessFailureError);
    let cause = error;
    let foundTimeout = false;
    while (cause && typeof cause === "object") {
      if (cause instanceof RequestTimeoutError) foundTimeout = true;
      cause = cause.cause;
    }
    assert.equal(foundTimeout, true, "the typed cleanup timeout remains available as the cause");
    return true;
  };
  const makeHungStream = () => (async function* () {
    yield { type: "text", text: "partial" };
    // This models an uncooperative async generator: return() is queued behind
    // a next() whose awaited operation never observes the AbortSignal.
    await new Promise(() => {});
    yield { type: "text", text: "unreachable" };
  })();

  for (const cancelKind of ["abort", "return", "close"]) {
    await withTempDirectory(async (root) => {
      const fixture = await makeFixture(root, {
        streamCleanupTimeoutMs: 30,
        capabilities: { maxTokens: "enforced", streaming: "incremental" },
        onStream: makeHungStream,
      });
      try {
        const controller = new AbortController();
        const stream = await fixture.session.messages.create(
          { ...messageRequest([user(`hung ${cancelKind}`)]), stream: true },
          cancelKind === "abort" ? { signal: controller.signal } : undefined,
        );
        const iterator = stream[Symbol.asyncIterator]();
        await iterator.next();
        await iterator.next();
        await iterator.next();
        const started = Date.now();
        const pendingNext = iterator.next();
        let cancellation;
        if (cancelKind === "abort") {
          controller.abort();
        } else if (cancelKind === "return") {
          cancellation = iterator.return();
        } else {
          cancellation = fixture.session.close();
        }
        const cancellationCheck = cancellation
          ? assert.rejects(cancellation, assertTimeoutCause)
          : undefined;
        await assert.rejects(pendingNext, assertTimeoutCause);
        await cancellationCheck;
        assert.ok(Date.now() - started < 700, "pending next/return/close stays within the bounded cleanup budget");
        assert.equal(fixture.session.state, cancelKind === "close" ? "closed" : "interrupted");
        assert.deepEqual(fixture.session.snapshot().transcript, []);

        if (cancelKind !== "close") {
          const sessionCloseStarted = Date.now();
          await assert.rejects(fixture.session.close(), assertTimeoutCause);
          assert.ok(Date.now() - sessionCloseStarted < 700, "session close remains within the configured cleanup deadline");
        }
        const engineCloseStarted = Date.now();
        await assert.rejects(fixture.engine.close(), assertTimeoutCause);
        assert.ok(Date.now() - engineCloseStarted < 700, "engine shutdown remains bounded while iterator cleanup is unresolved");
      } finally {
        // The fake worker is deliberately unkillable; failed close attempts
        // remain owned by the manager and must not turn into false success.
        await fixture.session.close().catch(() => undefined);
        await fixture.engine.close().catch(() => undefined);
      }
    });
  }
});

test("consumer break cancels an unfinished stream, but a complete stream is not treated as cancellation", async () => {
  await withTempDirectory(async (root) => {
    let cleanupCount = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => (async function* () {
        try {
          yield { type: "text", text: "partial" };
          await new Promise(() => {});
        } finally {
          cleanupCount += 1;
        }
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("break")]), stream: true });
      for await (const event of stream) {
        if (event.type === "content_block_delta") break;
      }
      assert.equal(cleanupCount, 1);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    let signalAtEof;
    const acknowledgement = {
      stage: "completed",
      output: [assistant("complete")],
      result: { stopReason: "end_turn" },
    };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: (operation) => (async function* () {
        yield { type: "text", text: "complete" };
        yield { type: "complete", acknowledgement };
        signalAtEof = operation.signal.aborted;
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("complete")]), stream: true });
      const events = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.at(-1).type, "message_stop");
      assert.equal(signalAtEof, false, "successful completion is not cancelled by iterator cleanup");
      assert.equal(fixture.session.state, "idle");
      assert.equal(fixture.session.snapshot().revision, 1);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("stream errors before/after output and EOF without a terminal acknowledgement never report success", async () => {
  const cases = [
    {
      name: "error before output",
      make: () => (async function* () { throw new ProcessFailureError("before output"); })(),
      error: ProcessFailureError,
    },
    {
      name: "error after output",
      make: () => (async function* () {
        yield { type: "text", text: "partial" };
        throw new ProcessFailureError("after output");
      })(),
      error: ProcessFailureError,
    },
    {
      name: "error after terminal acknowledgement but before EOF",
      make: () => (async function* () {
        const acknowledgement = {
          stage: "completed",
          output: [assistant("partial")],
          result: { stopReason: "end_turn" },
        };
        yield { type: "text", text: "partial" };
        yield { type: "complete", acknowledgement };
        throw new ProcessFailureError("after terminal acknowledgement");
      })(),
      error: ProcessFailureError,
    },
    {
      name: "EOF without terminal",
      make: () => (async function* () { yield { type: "text", text: "partial" }; })(),
      error: ProtocolFailureError,
    },
  ];
  for (const scenario of cases) {
    await withTempDirectory(async (root) => {
      const fixture = await makeFixture(root, {
        capabilities: { maxTokens: "enforced", streaming: "incremental" },
        onStream: scenario.make,
      });
      try {
        const stream = await fixture.session.messages.create({ ...messageRequest([user(scenario.name)]), stream: true });
        const events = [];
        await assert.rejects((async () => {
          for await (const event of stream) events.push(event);
        })(), scenario.error);
        assert.equal(events.some((event) => event.type === "message_stop"), false);
        assert.equal(events.some((event) => event.type === "message_delta"), false);
        assert.equal(fixture.session.state, "interrupted");
        assert.deepEqual(fixture.session.snapshot().transcript, []);
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("a worker tool boundary without matched MCP waiters is rejected before exposure", async () => {
  await withTempDirectory(async (root) => {
    let signalAtEof;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: (operation) => (async function* () {
        yield {
          type: "complete",
          acknowledgement: {
            stage: "awaiting_tools",
            output: [assistant([{ type: "tool_use", id: "toolu_pending", name: "lookup", input: {} }])],
          },
        };
        signalAtEof = operation.signal.aborted;
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("tool boundary")]), stream: true });
      const events = [];
      await assert.rejects((async () => {
        for await (const event of stream) events.push(event);
      })(), ProtocolFailureError);
      assert.equal(signalAtEof, undefined, "an unmatched tool boundary fails before an exposed terminal stream");
      assert.equal(events.some((event) => event.type === "message_stop"), false);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      await assert.rejects(
        fixture.session.messages.create(messageRequest([user("tool boundary")])),
        SessionInterruptedError,
      );
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("stream pulls are demand-driven and bounded text output fails closed", async () => {
  await withTempDirectory(async (root) => {
    let pulls = 0;
    const acknowledgement = {
      stage: "completed",
      output: [assistant("xy")],
      result: { stopReason: "end_turn" },
    };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => (async function* () {
        pulls += 1;
        yield { type: "text", text: "x" };
        pulls += 1;
        yield { type: "text", text: "y" };
        pulls += 1;
        yield { type: "complete", acknowledgement };
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("backpressure")]), stream: true });
      const iterator = stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type, "message_start");
      assert.equal(pulls, 1);
      assert.equal((await iterator.next()).value.type, "content_block_start");
      assert.equal(pulls, 1, "the SDK does not read ahead while raw events are buffered for the consumer");
      assert.equal((await iterator.next()).value.type, "content_block_delta");
      assert.equal(pulls, 1);
      assert.equal((await iterator.next()).value.type, "content_block_delta");
      assert.equal(pulls, 2);
      await iterator.return();
      assert.equal(fixture.session.state, "interrupted", "return before message_stop cancels the pending transaction");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => (async function* () {
        yield { type: "text", text: "x".repeat(8 * 1024 * 1024 + 1) };
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("bounded")]), stream: true });
      const events = [];
      await assert.rejects((async () => {
        for await (const event of stream) events.push(event);
      })(), ProtocolFailureError);
      assert.equal(events.length, 0);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    let generated = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => (async function* () {
        for (let index = 0; index < 65_537; index += 1) {
          generated += 1;
          yield { type: "text", text: "" };
        }
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("bounded events")]), stream: true });
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      await assert.rejects(iterator.next(), ProtocolFailureError);
      assert.equal(generated, 65_537);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("stream concurrency is session-local and cleanup failures propagate", async () => {
  await withTempDirectory(async (root) => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstAck = { stage: "completed", output: [assistant("held")], result: { stopReason: "end_turn" } };
    const secondAck = { stage: "completed", output: [assistant("independent")], result: { stopReason: "end_turn" } };
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: (operation) => (async function* () {
        if (operation.messages[0]?.content === "hold") {
          yield { type: "text", text: "held" };
          await firstGate;
          yield { type: "complete", acknowledgement: firstAck };
        } else {
          yield { type: "text", text: "independent" };
          yield { type: "complete", acknowledgement: secondAck };
        }
      })(),
    });
    let secondSession;
    try {
      secondSession = await fixture.engine.create({ model: "model-s5", cwd: "/workspace" });
      const held = await fixture.session.messages.create({ ...messageRequest([user("hold")]), stream: true });
      const heldIterator = held[Symbol.asyncIterator]();
      await heldIterator.next();
      const busy = fixture.session.messages.create(messageRequest([user("same session busy")]));
      await assert.rejects(busy, SessionBusyError);

      const independent = await secondSession.messages.create({ ...messageRequest([user("other session")]), stream: true });
      const independentEvents = [];
      for await (const event of independent) independentEvents.push(event);
      assert.equal(independentEvents.at(-1).type, "message_stop");
      assert.equal(secondSession.state, "idle");
      assert.equal(fixture.session.state, "running");

      releaseFirst();
      const remaining = [];
      for await (const event of { [Symbol.asyncIterator]: () => heldIterator }) remaining.push(event);
      assert.equal(remaining.at(-1).type, "message_stop");
      assert.equal(fixture.session.state, "idle");
    } finally {
      if (secondSession) await secondSession.close();
      await closeFixture(fixture);
    }
  });

  await withTempDirectory(async (root) => {
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onStream: () => ({
        index: 0,
        async next() { return { done: false, value: { type: "text", text: "partial" } }; },
        async return() { throw new Error("cleanup failed"); },
        [Symbol.asyncIterator]() { return this; },
      }),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("cleanup")]), stream: true });
      await assert.rejects((async () => {
        for await (const event of stream) {
          if (event.type === "content_block_delta") break;
        }
      })(), ProcessFailureError);
      assert.equal(fixture.session.state, "interrupted");
      assert.deepEqual(fixture.session.snapshot().transcript, []);
    } finally {
      await closeFixture(fixture);
    }
  });
});

test("parallel streams remain isolated across explicit accounts", async () => {
  await withTempDirectory(async (firstRoot) => {
    await withTempDirectory(async (secondRoot) => {
      const makeAccountFixture = (root, label) => makeFixture(root, {
        capabilities: { maxTokens: "enforced", streaming: "incremental" },
        onStream: () => (async function* () {
          const response = `response-${label}`;
          const acknowledgement = {
            stage: "completed",
            output: [assistant(response)],
            result: { stopReason: "end_turn" },
          };
          yield { type: "text", text: response };
          yield { type: "complete", acknowledgement };
        })(),
      });
      const first = await makeAccountFixture(firstRoot, "A");
      const second = await makeAccountFixture(secondRoot, "B");
      try {
        const collect = async (fixture, prompt, maxTokens) => {
          const iterable = await fixture.session.messages.create({
            ...messageRequest([user(prompt)], maxTokens),
            stream: true,
          });
          const events = [];
          for await (const event of iterable) events.push(event);
          return events;
        };
        const [firstEvents, secondEvents] = await Promise.all([
          collect(first, "account-A", 41),
          collect(second, "account-B", 89),
        ]);
        const deltas = (events) => events.filter((event) => event.type === "content_block_delta").map((event) => event.delta.text).join("");
        assert.equal(deltas(firstEvents), "response-A");
        assert.equal(deltas(secondEvents), "response-B");
        assert.notEqual(first.profile.id, second.profile.id);
        assert.equal(first.streams[0].accountId, first.profile.id);
        assert.equal(second.streams[0].accountId, second.profile.id);
        assert.equal(first.admissions[0].accountId, first.profile.id);
        assert.equal(second.admissions[0].accountId, second.profile.id);
        assert.equal(first.admissions[0].sessionId, first.session.sessionId);
        assert.equal(second.admissions[0].sessionId, second.session.sessionId);
        assert.equal(first.admissions[0].maxTokens, 41);
        assert.equal(second.admissions[0].maxTokens, 89);
        assert.equal(first.streams[0].admission.maxTokens, 41);
        assert.equal(second.streams[0].admission.maxTokens, 89);
        assert.notEqual(first.streams[0].sessionId, second.streams[0].sessionId);
        assert.deepEqual(first.session.snapshot().transcript.at(-1), assistant([textBlock("response-A")]));
        assert.deepEqual(second.session.snapshot().transcript.at(-1), assistant([textBlock("response-B")]));
      } finally {
        await closeFixture(first);
        await closeFixture(second);
      }
    });
  });
});

test("closing a session during a stream is idempotent and leaves no partial commit", async () => {
  await withTempDirectory(async (root) => {
    let driverCloses = 0;
    let streamCleanup = 0;
    const fixture = await makeFixture(root, {
      capabilities: { maxTokens: "enforced", streaming: "incremental" },
      onClose: async () => { driverCloses += 1; },
      onStream: () => (async function* () {
        try {
          yield { type: "text", text: "partial" };
          await new Promise(() => {});
        } finally {
          streamCleanup += 1;
        }
      })(),
    });
    try {
      const stream = await fixture.session.messages.create({ ...messageRequest([user("close")]), stream: true });
      const iterator = stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type, "message_start");
      await fixture.session.close();
      await fixture.session.close();
      assert.equal(fixture.session.state, "closed");
      assert.equal(driverCloses, 1);
      assert.equal(streamCleanup, 1);
      assert.deepEqual(fixture.session.snapshot().transcript, []);
      await iterator.return();
      await fixture.engine.close();
      assert.equal(driverCloses, 1);
    } finally {
      await closeFixture(fixture);
    }
  });
});
