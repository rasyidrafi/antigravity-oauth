import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  AntigravitySDK,
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  createProfileRegistry,
} from "../dist/index.js";
import { createAntigravitySDKWithModelDiscoveryFactoryForTests } from "../dist/sdk.js";

const wait = (milliseconds = 10) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function withAccount(fn) {
  const root = await mkdtemp(join(tmpdir(), "antigravity-account-info-"));
  const registry = await createProfileRegistry({ storageDir: join(root, "profiles"), environment: { PATH: "/usr/bin:/bin" } });
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/unused/agy_acp_server.par",
    profileRegistryFactory: async () => registry,
  });
  try {
    const account = await sdk.accounts.create();
    const profile = await registry.accounts.get(account.id);
    await writeCredentials(profile, `refresh-${account.id}`, `project-${account.id}`);
    await fn({ sdk, account, profile, root });
  } finally {
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeCredentials(account, refreshToken, projectId, overrides = {}) {
  const authDirectory = join(account.context.storageRoot, "gemini", "antigravity-acp");
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(authDirectory, 0o700);
  const path = join(authDirectory, "acp_token.json");
  const value = {
    client_id: "client-id-test",
    client_secret: "client-secret-test-never-return",
    refresh_token: refreshToken,
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: ["scope-test"],
    project_id: projectId,
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  if (platform() !== "win32") await chmod(path, 0o600);
  return { path, value };
}

function registryWithReleaseFaults(registry, failureCount) {
  let releaseAttempts = 0;
  let heldLocks = 0;
  const wrap = (profile) => Object.freeze({
    ...profile,
    context: Object.freeze({
      ...profile.context,
      async acquireAuthLock(options) {
        const lock = await profile.context.acquireAuthLock(options);
        heldLocks += 1;
        return Object.freeze({
          async release() {
            releaseAttempts += 1;
            if (releaseAttempts <= failureCount) throw new Error("injected auth-lock release failure");
            await lock.release();
            heldLocks -= 1;
          },
        });
      },
    }),
  });
  return {
    registry: Object.freeze({
      storageRoot: registry.storageRoot,
      accounts: Object.freeze({
        create: async () => wrap(await registry.accounts.create()),
        get: async (id) => wrap(await registry.accounts.get(id)),
        list: async () => Object.freeze((await registry.accounts.list()).map(wrap)),
      }),
    }),
    stats: () => ({ releaseAttempts, heldLocks }),
  };
}

function withFetch(replacement, run) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  return Promise.resolve().then(run).finally(() => {
    globalThis.fetch = original;
  });
}

function tokenFor(url, init) {
  assert.equal(url, "https://oauth2.googleapis.com/token");
  assert.equal(init.redirect, "manual");
  assert.equal(init.method, "POST");
  const form = new URLSearchParams(init.body);
  assert.equal(form.get("client_id"), "client-id-test");
  assert.equal(form.get("client_secret"), "client-secret-test-never-return");
  assert.equal(form.get("grant_type"), "refresh_token");
  return form.get("refresh_token");
}

class FakeLoginChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin;
  ended = false;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(Buffer.from(chunk).toString("utf8").trim());
        if (message.method === "initialize") {
          this.reply(message.id, { protocolVersion: 1, authMethods: [{ id: "oauth-personal", name: "OAuth" }] });
        } else if (message.method === "authenticate") {
          this.reply(message.id, {});
        }
        queueMicrotask(() => callback());
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => this.exit(0));
      },
    });
  }

  reply(id, result) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
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

test("identity returns only the verified provider ID and email from the profile-bound token", async () => {
  await withAccount(async ({ account }) => {
    const seen = [];
    await withFetch(async (url, init) => {
      seen.push(String(url));
      if (String(url) === "https://oauth2.googleapis.com/token") {
        assert.equal(tokenFor(String(url), init), `refresh-${account.id}`);
        return Response.json({ access_token: "access-token-test", token_type: "Bearer", expires_in: 3600 });
      }
      assert.equal(String(url), "https://www.googleapis.com/oauth2/v2/userinfo");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.authorization, "Bearer access-token-test");
      return Response.json({ id: "stable-provider-id", email: "verified@example.test", verified_email: true, name: "omit" });
    }, async () => {
      const identity = await account.identity.get();
      assert.deepEqual(identity, {
        accountId: account.id,
        providerId: "stable-provider-id",
        email: "verified@example.test",
        emailVerified: true,
      });
      assert.deepEqual(seen, [
        "https://oauth2.googleapis.com/token",
        "https://www.googleapis.com/oauth2/v2/userinfo",
      ]);
      assert.equal(JSON.stringify(identity).includes("access-token-test"), false);
      assert.equal(JSON.stringify(identity).includes("client-secret-test-never-return"), false);
    });
  });
});

test("quota returns a bounded projection of the internal summary and never fetches models", async () => {
  await withAccount(async ({ account }) => {
    const seen = [];
    const quotaFixture = JSON.parse(await readFile(new URL("./fixtures/quota-summary.json", import.meta.url), "utf8"));
    quotaFixture.groups[0].unrelatedInternalField = "must-not-escape";
    quotaFixture.groups[0].buckets[0].quotaId = "must-not-escape";
    quotaFixture.groups[0].buckets[1].window = {
      duration: "24h",
      unit: "day",
      internalToken: "must-not-escape",
    };
    await withFetch(async (url, init) => {
      const target = String(url);
      seen.push(target);
      if (target === "https://oauth2.googleapis.com/token") {
        tokenFor(target, init);
        return Response.json({ access_token: "quota-access-token", expires_in: 3600 });
      }
      assert.equal(target, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.authorization, "Bearer quota-access-token");
      assert.equal(init.headers["user-agent"], "antigravity/2.24.0 linux/amd64");
      assert.deepEqual(JSON.parse(init.body), { project: `project-${account.id}` });
      return Response.json(quotaFixture);
    }, async () => {
      const summary = await account.quota.summary();
      assert.equal(summary.accountId, account.id);
      assert.ok(Number.isFinite(Date.parse(summary.observedAt)));
      assert.deepEqual(summary.groups, [
        {
          displayName: "Daily quota",
          buckets: [
            {
              modelId: "model-fast",
              remainingFraction: 0.625,
              resetTime: "2026-11-02T00:00:00Z",
              window: "daily",
            },
            {
              modelId: "model-balanced",
              remainingFraction: 0.8,
              resetTime: "2026-11-02T00:00:00Z",
              window: { duration: "24h", unit: "day" },
            },
          ],
        },
        {
          displayName: "Weekly quota",
          buckets: [{
            remainingFraction: 0.9,
            resetTime: "2026-11-08T00:00:00Z",
            window: "weekly",
          }],
        },
      ]);
      assert.equal(JSON.stringify(summary).includes("must-not-escape"), false);
      assert.equal(seen.includes("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"), false);
    });
  });
});

test("credential token URI is fixed, redirects are rejected, and errors do not echo secrets", async () => {
  await withAccount(async ({ account, profile }) => {
    const badToken = await writeCredentials(profile, "refresh-safe-test", "project-test", {
      token_uri: "https://attacker.invalid/token",
    });
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      return Response.json({ access_token: "unused" });
    }, async () => {
      await assert.rejects(account.identity.get(), (error) => error instanceof InternalError);
      assert.equal(calls, 0);
    });
    assert.ok((await readFile(badToken.path, "utf8")).includes("attacker.invalid"));

    await writeCredentials(profile, "refresh-safe-test", "project-test");
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenFor(String(url), init);
        return new Response("client-secret-test-never-return", { status: 302, headers: { location: "https://evil.invalid" } });
      }
      assert.fail("userinfo must not be requested after a token redirect");
    }, async () => {
      await assert.rejects(account.identity.get(), (error) => {
        assert.ok(error instanceof ProtocolFailureError);
        assert.equal(error.message.includes("client-secret-test-never-return"), false);
        return true;
      });
    });
  });
});

test("a rotated refresh token fails closed without writing either token to the profile", async () => {
  await withAccount(async ({ account, profile }) => {
    const { path, value: original } = await writeCredentials(profile, "old-refresh-token", "rotation-project");
    let identityCalls = 0;
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        assert.equal(tokenFor(String(url), init), "old-refresh-token");
        return Response.json({
          access_token: "ephemeral-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        });
      }
      identityCalls += 1;
      return Response.json({ id: "provider-id", email: "rotation@example.test", verified_email: true });
    }, async () => {
      await assert.rejects(account.identity.get(), AuthenticationError);
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.refresh_token, original.refresh_token);
    assert.equal(saved.access_token, undefined);
    assert.equal(JSON.stringify(saved).includes("new-refresh-token"), false);
    assert.equal(identityCalls, 0, "provider identity must not be returned after an unpersistable rotation");
    if (platform() !== "win32") {
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(path)).mode & 0o077, 0);
    }
  });
});

test("failed metadata lock release is retried before the next account request", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-metadata-lock-retry-"));
  const backingRegistry = await createProfileRegistry({ storageDir: join(root, "profiles") });
  const injected = registryWithReleaseFaults(backingRegistry, 1);
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/unused/agy_acp_server.par",
    profileRegistryFactory: async () => injected.registry,
  });
  try {
    const account = await sdk.accounts.create();
    const profile = await backingRegistry.accounts.get(account.id);
    await writeCredentials(profile, "lock-retry-token", "lock-retry-project");
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenFor(String(url), init);
        return Response.json({ access_token: "lock-retry-access", expires_in: 3600 });
      }
      if (String(url) === "https://www.googleapis.com/oauth2/v2/userinfo") {
        return Response.json({ id: "lock-retry-id", email: "lock-retry@example.test", verified_email: true });
      }
      return Response.json(JSON.parse(await readFile(new URL("./fixtures/quota-summary.json", import.meta.url), "utf8")));
    }, async () => {
      await assert.rejects(account.identity.get(), ProcessFailureError);
      assert.deepEqual(injected.stats(), { releaseAttempts: 1, heldLocks: 1 });
      const summary = await account.quota.summary();
      assert.equal(summary.groups.length, 2);
      assert.deepEqual(injected.stats(), { releaseAttempts: 3, heldLocks: 0 });
    });
    await sdk.close();
    assert.deepEqual(injected.stats(), { releaseAttempts: 3, heldLocks: 0 });
  } finally {
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK shutdown reports and retries an unreleased metadata auth lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-metadata-lock-shutdown-"));
  const backingRegistry = await createProfileRegistry({ storageDir: join(root, "profiles") });
  const injected = registryWithReleaseFaults(backingRegistry, 2);
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/unused/agy_acp_server.par",
    profileRegistryFactory: async () => injected.registry,
  });
  try {
    const account = await sdk.accounts.create();
    const profile = await backingRegistry.accounts.get(account.id);
    await writeCredentials(profile, "shutdown-lock-token", "shutdown-lock-project");
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenFor(String(url), init);
        return Response.json({ access_token: "shutdown-lock-access", expires_in: 3600 });
      }
      return Response.json({ id: "shutdown-lock-id", email: "shutdown-lock@example.test", verified_email: true });
    }, async () => {
      await assert.rejects(account.identity.get(), ProcessFailureError);
      assert.deepEqual(injected.stats(), { releaseAttempts: 1, heldLocks: 1 });
      await assert.rejects(sdk.close(), ProcessFailureError);
      assert.deepEqual(injected.stats(), { releaseAttempts: 2, heldLocks: 1 });
      await sdk.close();
      assert.deepEqual(injected.stats(), { releaseAttempts: 3, heldLocks: 0 });
    });
  } finally {
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("per-account tokens remain isolated across concurrent identity requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-account-isolation-"));
  const registry = await createProfileRegistry({ storageDir: join(root, "profiles") });
  const sdk = new AntigravitySDK({
    storageDir: join(root, "profiles"),
    executable: "/unused/agy_acp_server.par",
    profileRegistryFactory: async () => registry,
  });
  try {
    const [first, second] = await Promise.all([sdk.accounts.create(), sdk.accounts.create()]);
    const firstProfile = await registry.accounts.get(first.id);
    const secondProfile = await registry.accounts.get(second.id);
    await writeCredentials(firstProfile, "first-refresh", "first-project");
    await writeCredentials(secondProfile, "second-refresh", "second-project");
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        const refresh = new URLSearchParams(init.body).get("refresh_token");
        return Response.json({ access_token: `${refresh}-access`, expires_in: 3600 });
      }
      const token = init.headers.authorization.slice("Bearer ".length);
      return Response.json({ id: `id-${token}`, email: `${token}@example.test`, verified_email: true });
    }, async () => {
      const [firstIdentity, secondIdentity] = await Promise.all([first.identity.get(), second.identity.get()]);
      assert.equal(firstIdentity.email, "first-refresh-access@example.test");
      assert.equal(secondIdentity.email, "second-refresh-access@example.test");
      assert.equal(firstIdentity.accountId, first.id);
      assert.equal(secondIdentity.accountId, second.id);
    });
  } finally {
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("logout waits for an in-flight credential refresh and then removes only that account token", async () => {
  await withAccount(async ({ account, profile }) => {
    const { path } = await writeCredentials(profile, "logout-race-refresh", "logout-race-project");
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let releaseToken;
    const tokenGate = new Promise((resolve) => { releaseToken = resolve; });
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenFor(String(url), init);
        signalStarted();
        await tokenGate;
        return Response.json({ access_token: "race-access-token", expires_in: 3600 });
      }
      return Response.json({ id: "race-id", email: "race@example.test", verified_email: true });
    }, async () => {
      const lookup = account.identity.get();
      await started;
      let logoutFinished = false;
      const logout = account.auth.logout().then(() => { logoutFinished = true; });
      await wait(30);
      assert.equal(logoutFinished, false, "logout must wait on the profile credential lock");
      releaseToken();
      await lookup;
      await logout;
      await assert.rejects(readFile(path), (error) => error?.code === "ENOENT");
    });
  });
});

test("rotated refresh fails closed while owned session/discovery workers serialize login", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-refresh-worker-race-"));
  const registry = await createProfileRegistry({ storageDir: join(root, "profiles") });
  const discoveryStarted = deferred();
  const releaseDiscovery = deferred();
  const tokenStarted = deferred();
  const releaseToken = deferred();
  let discoveryClosed = 0;
  let sessionClosed = 0;
  let loginSpawns = 0;
  const sdk = createAntigravitySDKWithModelDiscoveryFactoryForTests({
    storageDir: join(root, "profiles"),
    executable: "/unused/agy_acp_server.par",
    profileRegistryFactory: async () => registry,
    processFactory: () => {
      loginSpawns += 1;
      return new FakeLoginChild();
    },
    sessionDriverFactory: (context) => ({
      capabilities: {},
      async dispatch() {
        return { stage: "completed", output: [{ role: "assistant", content: "unused" }] };
      },
      async close() { sessionClosed += 1; },
    }),
  }, async () => ({
    async list() {
      discoveryStarted.resolve();
      await releaseDiscovery.promise;
      throw new Error("discovery worker closed by login transition");
    },
    async close() {
      discoveryClosed += 1;
      releaseDiscovery.resolve();
    },
  }));
  try {
    const account = await sdk.accounts.create();
    const profile = await registry.accounts.get(account.id);
    const { path, value: original } = await writeCredentials(profile, "lifecycle-refresh", "lifecycle-project");
    const session = await account.sessions.create({ model: "fake-model", cwd: "/workspace" });
    const discovery = account.models.list({ cwd: "/workspace" });
    await discoveryStarted.promise;

    await withFetch(async (url, init) => {
      if (String(url) !== "https://oauth2.googleapis.com/token") {
        assert.fail("userinfo must not run when OAuth returns an unpersistable refresh-token rotation");
      }
      tokenFor(String(url), init);
      tokenStarted.resolve();
      await releaseToken.promise;
      return Response.json({
        access_token: "lifecycle-access-token",
        refresh_token: "rotated-lifecycle-refresh",
        expires_in: 3600,
      });
    }, async () => {
      const identity = account.identity.get();
      await tokenStarted.promise;
      const login = account.auth.login();
      await wait(30);
      assert.equal(loginSpawns, 0, "login waits for account metadata's profile auth lock");

      releaseToken.resolve();
      await assert.rejects(identity, AuthenticationError);
      await login;
      await assert.rejects(discovery, /discovery worker closed by login transition/);
      assert.equal(discoveryClosed, 1, "login transition closes the SDK-owned discovery worker");
      assert.equal(sessionClosed, 1, "login transition closes the SDK-owned session worker");
      assert.equal(loginSpawns, 1, "login starts only after the metadata credential critical section");
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.refresh_token, original.refresh_token);
      assert.equal(JSON.stringify(saved).includes("rotated-lifecycle-refresh"), false);
      await session.close();
    });
  } finally {
    releaseToken.resolve();
    releaseDiscovery.resolve();
    await sdk.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid request options and pre-aborted account requests do not reach the provider", async () => {
  await withAccount(async ({ account }) => {
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      return Response.json({ access_token: "unused" });
    }, async () => {
      await assert.rejects(account.identity.get({ unknown: true }), InvalidRequestError);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(account.quota.summary({ signal: controller.signal }), RequestAbortedError);
      assert.equal(calls, 0);
    });
  });
});

test("credential reads reject symlinked profile token files before any network request", async () => {
  await withAccount(async ({ account, profile, root }) => {
    const authDirectory = join(profile.context.storageRoot, "gemini", "antigravity-acp");
    const tokenPath = join(authDirectory, "acp_token.json");
    const outsidePath = join(root, "outside-token.json");
    await writeFile(outsidePath, await readFile(tokenPath, "utf8"), { mode: 0o600 });
    await unlink(tokenPath);
    await symlink(outsidePath, tokenPath);
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      return Response.json({ access_token: "unused" });
    }, async () => {
      await assert.rejects(account.identity.get(), InternalError);
      assert.equal(calls, 0);
    });
  });
});

test("unverified identity and malformed quota summaries fail closed", async () => {
  await withAccount(async ({ account }) => {
    let identityEndpoint = true;
    await withFetch(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        tokenFor(String(url), init);
        return Response.json({ access_token: "provider-access", expires_in: 3600 });
      }
      if (identityEndpoint) {
        identityEndpoint = false;
        return Response.json({ id: "stable-id", email: "unverified@example.test", verified_email: false });
      }
      return Response.json({ models: { stale: true } });
    }, async () => {
      await assert.rejects(account.identity.get(), AuthenticationError);
      await assert.rejects(account.quota.summary(), ProtocolFailureError);
    });
  });
});
