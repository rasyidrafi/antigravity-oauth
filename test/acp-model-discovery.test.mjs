import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolFailureError, UnsupportedFeatureError } from "../dist/index.js";
import {
  createAcpModelDiscoveryWorker,
  extractAcpAdvertisedModels,
} from "../dist/acp-models.js";

const advertisedConfiguration = [
  { id: "mode", category: "mode", options: [{ value: "code" }] },
  {
    id: "model",
    category: "model",
    options: [
      {
        name: "Fast models",
        options: [
          { name: "Fast One", value: "fast-one" },
          { name: "Fast Two", value: "fast-two" },
        ],
      },
      { name: "Balanced", value: "balanced" },
    ],
  },
];

test("advertised models preserve exact nested ACP selector values and bounded labels", () => {
  const models = extractAcpAdvertisedModels(advertisedConfiguration);
  assert.deepEqual(models, [
    { id: "fast-one", name: "Fast One", group: "Fast models" },
    { id: "fast-two", name: "Fast Two", group: "Fast models" },
    { id: "balanced", name: "Balanced" },
  ]);
  assert.ok(Object.isFrozen(models));
  assert.ok(models.every(Object.isFrozen));
});

test("unsupported, ambiguous, empty, duplicate, and malformed model offers fail closed", () => {
  assert.throws(() => extractAcpAdvertisedModels([]), UnsupportedFeatureError);
  assert.throws(() => extractAcpAdvertisedModels([
    ...advertisedConfiguration,
    { id: "another-model", category: "model", options: [{ value: "other" }] },
  ]), UnsupportedFeatureError);
  assert.throws(() => extractAcpAdvertisedModels([
    { id: "model", options: [] },
  ]), UnsupportedFeatureError);
  assert.throws(() => extractAcpAdvertisedModels([
    { id: "model", options: [{ value: "duplicate" }, { value: "duplicate" }] },
  ]), ProtocolFailureError);
  assert.throws(() => extractAcpAdvertisedModels([
    { id: "model", options: [{ options: "not-an-array" }] },
  ]), ProtocolFailureError);
  assert.throws(() => extractAcpAdvertisedModels([
    { id: "model", options: [{ value: "invalid\nmodel" }] },
  ]), ProtocolFailureError);
});

test("discovery creates only an ACP session/new request with built-ins disabled", async () => {
  const calls = [];
  let closed = false;
  const worker = createAcpModelDiscoveryWorker({
    async request(method, params, options) {
      calls.push({ method, params, options });
      return { sessionId: "discovery-session", configOptions: advertisedConfiguration };
    },
    async close() { closed = true; },
  });
  const controller = new AbortController();
  const models = await worker.list("/workspace", controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "session/new");
  assert.deepEqual(calls[0].params, {
    cwd: "/workspace",
    mcpServers: [],
    _meta: { agy: { enabledTools: [] } },
  });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.timeoutMs, 30_000);
  assert.deepEqual(models.map(({ id }) => id), ["fast-one", "fast-two", "balanced"]);
  assert.equal(calls.some(({ method }) => method.includes("prompt") || method.includes("generate")), false);
  assert.equal(await worker.close(), undefined);
  assert.equal(closed, true);
});

test("model discovery rejects invalid session responses and caller directories before protocol writes", async () => {
  let requests = 0;
  const malformed = createAcpModelDiscoveryWorker({
    async request() {
      requests += 1;
      return { sessionId: "valid", configOptions: [{ id: "other", options: [{ value: "hidden" }] }] };
    },
    async close() {},
  });
  await assert.rejects(malformed.list("/workspace"), UnsupportedFeatureError);
  await assert.rejects(malformed.list(""), (error) => error?.name === "InvalidRequestError");
  assert.equal(requests, 1);

  const badSession = createAcpModelDiscoveryWorker({
    async request() { return { sessionId: "bad\0session", configOptions: advertisedConfiguration }; },
    async close() {},
  });
  await assert.rejects(badSession.list("/workspace"), ProtocolFailureError);
});
