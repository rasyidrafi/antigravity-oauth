import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  AccountNotFoundError,
  InternalError,
  InvalidRequestError,
  RequestAbortedError,
  SessionBusyError,
  createProfileRegistry,
} from "../dist/index.js";

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-s1-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function startPausedProfilePublisher(storageRoot) {
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `
    import fsPromises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const realOpen = fsPromises.open.bind(fsPromises);
    fsPromises.open = async (path, flags, ...args) => {
      const handle = await realOpen(path, flags, ...args);
      if (String(path).includes(".profile.json.") && flags === "wx") {
        process.stdout.write("publication-pending\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { createProfileRegistry } = await import(${JSON.stringify(moduleUrl)});
    const registry = await createProfileRegistry({ storageDir: ${JSON.stringify(storageRoot)} });
    try {
      const profile = await registry.accounts.create();
      console.log("publication-finished:" + profile.id);
    } catch (error) {
      console.log("publication-failed:" + error.name);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH ?? "", HOME: storageRoot, TMPDIR: tmpdir() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  const nextLine = () => new Promise((resolveLine, rejectLine) => {
    const cleanup = () => {
      lines.removeListener("line", onLine);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onLine = (line) => {
      cleanup();
      resolveLine(line);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectLine(new Error(`Profile publisher exited before the next line (${code}, ${signal}): ${stderr}`));
    };
    const onError = (error) => {
      cleanup();
      rejectLine(error);
    };
    lines.once("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });

  assert.equal(await nextLine(), "publication-pending", stderr);
  return { child, lines, nextLine, getStderr: () => stderr };
}

async function unusedLinuxProcessId() {
  const pidMax = Number((await readFile("/proc/sys/kernel/pid_max", "utf8")).trim());
  for (let pid = pidMax - 1; pid > 1; pid -= 1) {
    try {
      await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return pid;
    }
  }
  throw new Error("Could not find an unused Linux PID for the stale-lock fixture.");
}

function assertPrivateDirectoryMode(path) {
  if (platform() === "win32") return;
  return stat(path).then((details) => {
    assert.equal(details.mode & 0o777, 0o700, `${path} should be private`);
  });
}

test("registry creates independent profiles and persists create/get/list metadata", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const first = await registry.accounts.create();
    const second = await registry.accounts.create();

    assert.match(first.id, /^acct_[0-9a-f-]{36}$/);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.context.storageRoot, second.context.storageRoot);
    assert.notEqual(first.context.childEnvironment.GEMINI_HOME, second.context.childEnvironment.GEMINI_HOME);
    assert.equal(first.context.accountId, first.id);
    assert.equal(first.context.childEnvironment.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.equal(first.context.childEnvironment.GEMINI_HOME, join(first.context.storageRoot, "gemini"));
    assert.deepEqual(
      (await registry.accounts.list()).map((account) => account.id),
      [first.id, second.id].sort(),
    );

    const reloadedRegistry = await createProfileRegistry({ storageDir: registry.storageRoot });
    const reloaded = await reloadedRegistry.accounts.get(first.id);
    assert.equal(reloaded.id, first.id);
    assert.equal(reloaded.context.storageRoot, first.context.storageRoot);
    assert.equal((await reloadedRegistry.accounts.list()).length, 2);

    await assert.rejects(
      registry.accounts.get("../../outside"),
      (error) => error instanceof InvalidRequestError,
    );
    await assert.rejects(
      registry.accounts.get("acct_00000000-0000-4000-8000-000000000000"),
      (error) => error instanceof AccountNotFoundError,
    );
  });
});

test("list keeps prior profiles visible while another profile record is pending publication", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const existing = await registry.accounts.create();
    const pendingId = "acct_00000000-0000-4000-8000-000000000002";
    const pendingRoot = join(registry.storageRoot, "accounts", pendingId);
    await mkdir(pendingRoot, { mode: 0o700 });
    await writeFile(
      join(pendingRoot, `.profile.json.${randomUUID()}.tmp`),
      '{"version":1,"id":',
      { mode: 0o600 },
    );

    assert.deepEqual((await registry.accounts.list()).map((account) => account.id), [existing.id]);
  });
});

test("list tolerates an interrupted record publication but rejects malformed published records", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const existing = await registry.accounts.create();
    const interruptedId = "acct_00000000-0000-4000-8000-000000000003";
    const interruptedRoot = join(registry.storageRoot, "accounts", interruptedId);
    await mkdir(interruptedRoot, { mode: 0o700 });
    await writeFile(
      join(interruptedRoot, `.profile.json.${randomUUID()}.tmp`),
      `${JSON.stringify({ version: 1, id: interruptedId, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );

    assert.deepEqual((await registry.accounts.list()).map((account) => account.id), [existing.id]);
    await assert.rejects(
      registry.accounts.get(interruptedId),
      (error) => error instanceof AccountNotFoundError,
    );

    const malformedId = "acct_00000000-0000-4000-8000-000000000004";
    const malformedRoot = join(registry.storageRoot, "accounts", malformedId);
    await mkdir(malformedRoot, { mode: 0o700 });
    await writeFile(join(malformedRoot, "profile.json"), "{published-but-corrupt", { mode: 0o600 });
    await assert.rejects(registry.accounts.list(), (error) => error instanceof InternalError);
  });
});

test("accounts.list remains usable while the real writer is paused before atomic publication", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const existing = await registry.accounts.create();
    const publisher = await startPausedProfilePublisher(registry.storageRoot);
    try {
      assert.deepEqual((await registry.accounts.list()).map((account) => account.id), [existing.id]);
      const exited = once(publisher.child, "exit");
      publisher.child.stdin.end("continue\n");
      const completed = await publisher.nextLine();
      assert.match(completed, /^publication-finished:acct_[0-9a-f-]{36}$/);
      const [exitCode] = await exited;
      assert.equal(exitCode, 0, publisher.getStderr());
      assert.equal((await registry.accounts.list()).length, 2);
    } finally {
      publisher.lines.close();
      if (publisher.child.exitCode === null && publisher.child.signalCode === null) {
        publisher.child.kill("SIGKILL");
        await once(publisher.child, "exit");
      }
    }
  });
});

test("an interrupted real writer leaves only a temp file and does not break prior accounts", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const existing = await registry.accounts.create();
    const publisher = await startPausedProfilePublisher(registry.storageRoot);
    try {
      const accountDirectories = await readdir(join(registry.storageRoot, "accounts"));
      const interruptedId = accountDirectories.find((id) => id !== existing.id);
      assert.match(interruptedId, /^acct_[0-9a-f-]{36}$/);
      const exited = once(publisher.child, "exit");
      publisher.child.kill("SIGKILL");
      await exited;

      assert.ok((await readdir(join(registry.storageRoot, "accounts", interruptedId)))
        .some((name) => name.startsWith(".profile.json.") && name.endsWith(".tmp")));
      assert.deepEqual((await registry.accounts.list()).map((account) => account.id), [existing.id]);
      await assert.rejects(
        registry.accounts.get(interruptedId),
        (error) => error instanceof AccountNotFoundError,
      );
    } finally {
      publisher.lines.close();
      if (publisher.child.exitCode === null && publisher.child.signalCode === null) {
        publisher.child.kill("SIGKILL");
        await once(publisher.child, "exit");
      }
    }
  });
});

test("profile publication does not overwrite a foreign record created before commit", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    await registry.accounts.create();
    const publisher = await startPausedProfilePublisher(registry.storageRoot);
    try {
      const accountDirectories = await readdir(join(registry.storageRoot, "accounts"));
      const pendingRoot = (await Promise.all(accountDirectories.map(async (id) => ({
        id,
        entries: await readdir(join(registry.storageRoot, "accounts", id)),
      })))).find(({ entries }) => entries.some((name) => name.startsWith(".profile.json.") && name.endsWith(".tmp")));
      assert.ok(pendingRoot);
      assert.match(pendingRoot.id, /^acct_[0-9a-f-]{36}$/);
      const foreignContents = "foreign profile record";
      const finalRecord = join(registry.storageRoot, "accounts", pendingRoot.id, "profile.json");
      await writeFile(finalRecord, foreignContents, { mode: 0o600 });

      const exited = once(publisher.child, "exit");
      publisher.child.stdin.end("continue\n");
      assert.equal(await publisher.nextLine(), "publication-failed:InternalError");
      const [exitCode] = await exited;
      assert.equal(exitCode, 0, publisher.getStderr());
      assert.equal(await readFile(finalRecord, "utf8"), foreignContents);
      assert.equal((await readdir(join(registry.storageRoot, "accounts", pendingRoot.id)))
        .some((name) => name.startsWith(".profile.json.") && name.endsWith(".tmp")), false);
    } finally {
      publisher.lines.close();
      if (publisher.child.exitCode === null && publisher.child.signalCode === null) {
        publisher.child.kill("SIGKILL");
        await once(publisher.child, "exit");
      }
    }
  });
});

test("child environments use a narrow allowlist and force profile-specific paths", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const ambientBefore = process.env.GEMINI_HOME;
    const registry = await createProfileRegistry({
      storageDir: join(temporaryRoot, "sdk"),
      environment: {
        PATH: "/safe/bin",
        TMPDIR: "/safe/tmp",
        HOME: "/ambient/home",
        GEMINI_HOME: "/ambient/gemini",
        AGY_ACP_FORCE_FILE_STORAGE: "0",
        XDG_CONFIG_HOME: "/ambient/config",
        GOOGLE_APPLICATION_CREDENTIALS: "/credential/file.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/credential/override.json",
        GOOGLE_API_KEY: "not-a-real-key",
        ANTHROPIC_API_KEY: "not-a-real-key",
        NODE_OPTIONS: "--require=/untrusted/module.js",
        HTTPS_PROXY: "http://untrusted.invalid",
      },
    });
    const profile = await registry.accounts.create();
    const environment = profile.context.childEnvironment;

    assert.equal(environment.PATH, "/safe/bin");
    assert.equal(environment.TMPDIR, "/safe/tmp");
    assert.equal(environment.HOME, join(profile.context.storageRoot, "home"));
    assert.equal(environment.GEMINI_HOME, join(profile.context.storageRoot, "gemini"));
    assert.equal(environment.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.equal(environment.XDG_CONFIG_HOME, join(profile.context.storageRoot, "xdg", "config"));
    for (const denied of [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "GOOGLE_API_KEY",
      "ANTHROPIC_API_KEY",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
    ]) {
      assert.equal(Object.hasOwn(environment, denied), false, `${denied} must not be inherited`);
    }
    assert.equal(process.env.GEMINI_HOME, ambientBefore, "registry must not mutate process.env");
    assert.equal(Object.isFrozen(environment), true);
  });
});

test("default process environment handling ignores ambient credential and profile overrides", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const profileRoot = join(temporaryRoot, "sdk");
    const script = `
      import { createProfileRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = await createProfileRegistry({ storageDir: ${JSON.stringify(profileRoot)} });
      const profile = await registry.accounts.create();
      console.log(JSON.stringify(profile.context.childEnvironment));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/ambient/home",
        GEMINI_HOME: "/ambient/gemini",
        AGY_ACP_FORCE_FILE_STORAGE: "0",
        XDG_CONFIG_HOME: "/ambient/config",
        GOOGLE_APPLICATION_CREDENTIALS: "/fake/credential.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/fake/cloud.json",
        GEMINI_CLI_HOME: "/ambient/cli",
        ANTHROPIC_API_KEY: "not-a-real-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const stdoutEnded = once(child.stdout, "end");
    const [code] = await once(child, "exit");
    await stdoutEnded;
    assert.equal(code, 0, stderr);
    const environment = JSON.parse(stdout);
    const perAccountRoot = dirname(environment.GEMINI_HOME);
    assert.match(basename(perAccountRoot), /^acct_[0-9a-f-]{36}$/);
    assert.equal(perAccountRoot, join(profileRoot, "accounts", basename(perAccountRoot)));
    assert.equal(environment.HOME, join(perAccountRoot, "home"));
    assert.equal(environment.AGY_ACP_FORCE_FILE_STORAGE, "1");
    for (const denied of [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "GEMINI_CLI_HOME",
      "ANTHROPIC_API_KEY",
    ]) {
      assert.equal(Object.hasOwn(environment, denied), false);
    }
  });
});

test("profile paths and files are private on POSIX", async (t) => {
  if (platform() === "win32") return t.skip("POSIX mode bits are not enforced on Windows");
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const root = profile.context.storageRoot;
    const directories = [
      registry.storageRoot,
      join(registry.storageRoot, "accounts"),
      root,
      join(root, "gemini"),
      join(root, "home"),
      join(root, "xdg"),
      join(root, "xdg", "config"),
      join(root, "xdg", "data"),
      join(root, "xdg", "cache"),
      join(root, "xdg", "state"),
    ];
    for (const directory of directories) await assertPrivateDirectoryMode(directory);
    const record = await stat(join(root, "profile.json"));
    assert.equal(record.mode & 0o777, 0o600);

    const lock = await profile.context.acquireAuthLock({ timeoutMs: 100 });
    const lockStat = await stat(join(root, ".auth-operation.lock"));
    assert.equal(lockStat.mode & 0o777, 0o600);
    await lock.release();
  });
});

test("storage roots and profile descendants reject symlink boundaries", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const physical = join(temporaryRoot, "physical");
    const link = join(temporaryRoot, "linked");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, link);
    await assert.rejects(
      createProfileRegistry({ storageDir: join(link, "sdk") }),
      (error) => error instanceof InternalError,
    );

    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "registry") });
    const profile = await registry.accounts.create();
    const external = join(temporaryRoot, "outside");
    await mkdir(external, { mode: 0o700 });
    const symlinkAccountId = "acct_00000000-0000-4000-8000-000000000001";
    const accountSymlink = join(registry.storageRoot, "accounts", symlinkAccountId);
    await symlink(external, accountSymlink);
    await assert.rejects(
      registry.accounts.get(symlinkAccountId),
      (error) => error instanceof InternalError,
    );
    await assert.rejects(registry.accounts.list(), (error) => error instanceof InternalError);
    await rm(accountSymlink);

    await rm(profile.context.childEnvironment.GEMINI_HOME, { recursive: true });
    await symlink(external, profile.context.childEnvironment.GEMINI_HOME);
    await assert.rejects(
      registry.accounts.get(profile.id),
      (error) => error instanceof InternalError,
    );
    await assert.rejects(registry.accounts.list(), (error) => error instanceof InternalError);
  });
});

test("registry refuses to loosen or silently accept a pre-existing public root", async () => {
  if (platform() === "win32") return;
  await withTempDirectory(async (temporaryRoot) => {
    const publicRoot = join(temporaryRoot, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    await assert.rejects(
      createProfileRegistry({ storageDir: publicRoot }),
      (error) => error instanceof InternalError,
    );
    assert.equal((await stat(publicRoot)).mode & 0o777, 0o755);
  });
});

test("auth lock is exclusive, bounded, cancellable, and idempotently released", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const first = await profile.context.acquireAuthLock({ timeoutMs: 100 });
    assert.deepEqual(Object.keys(first), ["release"]);
    assert.equal(Object.isFrozen(first), true);

    await assert.rejects(
      profile.context.acquireAuthLock({ timeoutMs: 35 }),
      (error) => error instanceof SessionBusyError,
    );
    const controller = new AbortController();
    const canceled = profile.context.acquireAuthLock({ timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20).unref();
    await assert.rejects(canceled, (error) => error instanceof RequestAbortedError);

    await Promise.all([first.release(), first.release()]);
    await first.release();
    const next = await profile.context.acquireAuthLock({ timeoutMs: 100 });
    await next.release();
  });
});

test("auth locks on different profiles do not block each other", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const first = await registry.accounts.create();
    const second = await registry.accounts.create();
    const firstLock = await first.context.acquireAuthLock({ timeoutMs: 100 });
    const secondLock = await second.context.acquireAuthLock({ timeoutMs: 100 });
    await secondLock.release();
    await firstLock.release();
  });
});

test("release refuses to remove a replacement lock owned by someone else", async () => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const lockPath = join(profile.context.storageRoot, ".auth-operation.lock");
    const displacedPath = join(profile.context.storageRoot, ".displaced-lock");
    const lock = await profile.context.acquireAuthLock({ timeoutMs: 100 });
    await rename(lockPath, displacedPath);
    await writeFile(lockPath, "replacement", { mode: 0o600 });

    await assert.rejects(lock.release(), (error) => error instanceof InternalError);
    assert.equal(await readFile(lockPath, "utf8"), "replacement");

    const replacementPath = join(profile.context.storageRoot, ".replacement-lock");
    await rename(lockPath, replacementPath);
    await rename(displacedPath, lockPath);
    await lock.release();
    await lock.release();
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
    assert.equal(await readFile(replacementPath, "utf8"), "replacement");
  });
});

test("auth lock excludes another Node process and safely takes over its dead owner's lock", async (t) => {
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const script = `
      import { createProfileRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = await createProfileRegistry({ storageDir: ${JSON.stringify(registry.storageRoot)} });
      const profile = await registry.accounts.get(${JSON.stringify(profile.id)});
      await profile.context.acquireAuthLock({ timeoutMs: 1000 });
      console.log("lock-held");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HOME: temporaryRoot, TMPDIR: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const ready = new Promise((resolveReady, rejectReady) => {
      lines.once("line", (line) => line === "lock-held" ? resolveReady() : rejectReady(new Error(`Unexpected child output: ${line}`)));
      child.once("error", rejectReady);
      child.once("exit", (code) => rejectReady(new Error(`Child exited before lock: ${code}: ${stderr}`)));
    });

    try {
      await ready;
      await assert.rejects(
        profile.context.acquireAuthLock({ timeoutMs: 60 }),
        (error) => error instanceof SessionBusyError,
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      if (platform() !== "linux") {
        t.diagnostic("Stale owner reclamation is only supported where stable /proc identity is available.");
        return;
      }
      const recovered = await profile.context.acquireAuthLock({ timeoutMs: 1_000 });
      await recovered.release();
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }
  });
});

test("dead lock owners are recovered, but incomplete identity fails closed", async (t) => {
  if (platform() !== "linux") return t.skip("stable process identity recovery uses Linux /proc");
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const lockPath = join(profile.context.storageRoot, ".auth-operation.lock");
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const deadPid = await unusedLinuxProcessId();

    await writeFile(lockPath, JSON.stringify({
      version: 1,
      token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pid: deadPid,
      host: hostname(),
      platform: "linux",
      bootId,
      processStart: "1",
      createdAt: Date.now(),
    }), { mode: 0o600 });
    const recovered = await profile.context.acquireAuthLock({ timeoutMs: 500 });
    await recovered.release();

    await writeFile(lockPath, JSON.stringify({
      version: 1,
      token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      pid: deadPid,
      host: hostname(),
      platform: "linux",
      bootId: null,
      processStart: null,
      createdAt: Date.now(),
    }), { mode: 0o600 });
    await assert.rejects(
      profile.context.acquireAuthLock({ timeoutMs: 40 }),
      (error) => error instanceof SessionBusyError,
    );
    assert.equal((await readdir(profile.context.storageRoot)).includes(".auth-operation.lock"), true);
  });
});

test("a stale reaper guard blocks takeover rather than risking competing stale cleanup", async (t) => {
  if (platform() !== "linux") return t.skip("stable process identity recovery uses Linux /proc");
  await withTempDirectory(async (temporaryRoot) => {
    const registry = await createProfileRegistry({ storageDir: join(temporaryRoot, "sdk") });
    const profile = await registry.accounts.create();
    const lockPath = join(profile.context.storageRoot, ".auth-operation.lock");
    const guardPath = join(profile.context.storageRoot, ".auth-operation.reaper");
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const deadPid = await unusedLinuxProcessId();
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      pid: deadPid,
      host: hostname(),
      platform: "linux",
      bootId,
      processStart: "1",
      createdAt: Date.now(),
    }), { mode: 0o600 });
    await mkdir(guardPath, { mode: 0o700 });

    await assert.rejects(
      profile.context.acquireAuthLock({ timeoutMs: 45 }),
      (error) => error instanceof SessionBusyError,
    );
    assert.equal((await stat(lockPath)).isFile(), true);
    assert.equal((await stat(guardPath)).isDirectory(), true);
  });
});
