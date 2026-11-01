import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integrationFixture = join(projectRoot, "test", "fixtures", "public-sdk-acp-integration.mjs");

test("public SDK compatibility and permission options compose with the built-in non-enforcing ACP driver", () => {
  const packageEntry = join(projectRoot, "dist", "index.js");
  const environment = { ...process.env, ANTIGRAVITY_TEST_PACKAGE_ENTRY: packageEntry };
  // Node's test runner exports this marker to child processes. Clear it so the
  // isolated module-mock harness can launch its own test runner rather than
  // inheriting the parent's nested-test suppression.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--experimental-test-module-mocks",
    "--test",
    integrationFixture,
  ], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
});
