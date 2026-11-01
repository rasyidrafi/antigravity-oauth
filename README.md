# antigravity-oauth-sdk

An early TypeScript/ESM SDK implementation for Anthropic Messages over
Antigravity ACP. It exports the `AntigravitySDK` composition root, opt-in ACP
v1 stdio transport, explicit profile-bound authentication, an account-bound
session ledger, and an S6 text-only native Messages facade. The built-in driver
starts a reviewed ACP session and verifies the requested model. Strict mode
still refuses inference without a verified output-token bound; the explicit
compatibility mode can use the prompt/event pump but does not enforce
`max_tokens`. Optional Rosetta adapters disclose the exact normalized limit
and its enforcement outcome out of band; the compatibility path can exceed
the requested bound. This path is fake-child qualified only; do not claim live
inference or real enforcement. There is no executable download, public server,
public inference HTTP API, or CLI-auth import. A local profile is only isolated
SDK-owned storage and child-process configuration; it is not proof of OAuth or
keychain isolation.

## Runtime requirements and development

- Node.js 22 or newer; npm; TypeScript is used for the build.
- `npm install` installs the lockfile dependencies.
- `npm run build` emits ESM and declarations under `dist/`.
- `npm run typecheck` checks compile-time API assertions.
- `npm test` builds, typechecks, and runs the Node unit tests.

The Anthropic SDK is a regular dependency because the public declaration files
refer to its Messages request, response, and stream-event types. This package
core uses those types only; it does not import or instantiate the Anthropic SDK
at runtime. Optional Rosetta adapter subpaths load their translator peer (and
its own Anthropic SDK dependency) only when that subpath is imported.

The optional Chat Completions adapter is a separate `./chat` package subpath.
Its only runtime translator dependency is the exact optional peer
`@zenmux/rosetta-ai@1.0.38`; it is not imported by the SDK root or native
Messages implementation. Install that package explicitly only if using the
adapter:

```sh
npm install antigravity-oauth-sdk
npm install --save-exact @zenmux/rosetta-ai@1.0.38
```

The optional Responses adapter is a separate `./responses` subpath using that
same optional Rosetta peer. Importing the SDK root/native Messages does not
load either adapter.

## Composed API and output-token policy

The root constructor is synchronous and lazy. Account handles are selected
explicitly; `accounts.get()` is synchronous, while profile existence is checked
when an account operation runs. Login is never automatic:

```ts
import { AntigravitySDK, messageMaxTokensEnforcement } from "antigravity-oauth-sdk";

// maxTokensPolicy is strict when omitted. The built-in ACP driver rejects a
// Messages prompt unless a hard output-token bound has been established.
const strictSdk = new AntigravitySDK({ storageDir, executable });
await strictSdk.close();

const sdk = new AntigravitySDK({
  storageDir,
  executable,
  maxTokensPolicy: "allow-unenforced-max-tokens",
});
const account = sdk.accounts.get(accountId);
await account.auth.login();
const session = await account.sessions.create({
  model,
  cwd,
  system: "Follow the project instructions.",
  tools: [{
    name: "lookup",
    description: "Look up a record by key.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  }],
});
await session.tools.createMcpServer();
// This explicit compatibility option does not make ACP enforce max_tokens;
// the response may exceed the requested bound, spend, and quota.
const message = await session.messages.create({
  max_tokens: 512,
  messages: [{ role: "user", content: "Hello" }],
});
// This immutable receipt belongs to this exact response (unlike the latest
// operation in the session diagnostics snapshot).
const admission = messageMaxTokensEnforcement(message);
if (admission?.outcome === "not-enforced") {
  console.warn(
    `ACP did not enforce max_tokens=${admission.requestedMaxTokens}; output, spend, and quota may exceed expectations.`,
  );
}
await session.close();
await sdk.close();
```

`accounts.create()` and `accounts.list()` are also available. The root lazily
initializes one profile registry and shares one runtime manager across each
account's auth/session handles. `processFactory` is an explicit authentication
test seam only; the built-in session driver always uses Node's spawn after its
binary check. `sessionDriverFactory` replaces the built-in driver for a custom
integration. The built-in
session factory starts the configured executable without downloading it, uses
only the selected account profile's environment plus a child-only browser
blocker, issues ACP v1 `initialize`, then creates a session and selects the
requested model. By default, the SDK does not read or copy ambient environment
variables; callers may explicitly provide the allow-listed safe environment
source.

The built-in driver accepts only the reviewed Antigravity ACP 1.3.0
executable/companion hash pairs for Linux x64, Windows x64, and macOS ARM64.
Unknown binaries, missing companions, model selectors without advertised exact
values, rejected model changes, and unverified model selections fail closed.
An ACP session with no caller tools starts during
`account.sessions.create()`. If caller tools are configured, startup initializes
ACP but delays `session/new` until `session.tools.createMcpServer()` binds that
session's loopback MCP endpoint; the endpoint and its credentials are included
in `session/new`. A tool-enabled Messages request made before binding is
rejected during response admission and leaves the SDK session retryable; it
does not create a tool-less remote ACP session. The SDK sends
`_meta.agy.enabledTools: []` only after
verifying the binary pair. This compatibility check is not a sandbox claim;
other executables are not allowed to rely on the metadata.

Inference startup never calls login or opens a browser. The SDK preflights a
child-only browser blocker (POSIX `/bin/sh`, Windows Script Host on Windows),
maps its private marker and recognized ACP auth-required errors to
`AuthenticationError`, and tells the caller to use the selected account's
explicit `auth.login()`. If the blocker cannot be established, startup fails
before ACP is launched. The reviewed official binary uses the profile's
`BROWSER` command for browser launches; no claim is made that this mechanism
constrains arbitrary executables, which the compatibility gate rejects. On
Windows, callers must explicitly provide the allow-listed `SYSTEMROOT` or
`WINDIR` environment value; otherwise the blocker cannot be preflighted and
startup fails closed.

The built-in driver now owns one ACP `session/prompt` pump and can park that
same prompt while authenticated session MCP calls wait for caller-managed
results. Under strict policy (the default) the official driver still refuses
admission before prompt dispatch or tool-result release because ACP does not
establish a per-response output-token bound. The explicit compatibility policy
below uses the same ACP prompt/event pump without claiming that `max_tokens` is
enforced.

With no `permissions.onRequest` callback (the default), the ACP driver denies
permission requests even when the active session ID or opaque metadata looks
familiar. Well-formed requests select an offered `reject_once` option;
malformed requests or requests without a valid one-shot option return ACP's
`cancelled` outcome. An explicitly configured caller callback can approve only
one structurally valid request belonging to the current live ACP session turn
(including its parked caller-tool handoff). Its exact selected option must be
an offered `allow_once`; `allow_always` and `reject_always` are never selected.
Invalid decisions, exceptions, rejection, and overload deny; timeout or a
cancelled/changed operation cancels the response. Callback work is capped at
eight in-flight invocations per SDK, shared across its account sessions.
When an approved response reaches the outbound ACP FIFO head, the transport
rechecks the callback deadline and its owning operation/terminal/close state,
then serializes the selected result immediately before `stdin.write()`. A stale
approval is replaced by the same request's correlated `cancelled` response (or
dropped if the transport is no longer writable). Calling `stdin.write()` is the
byte-commit boundary: once it accepts a frame into Node's writable buffer,
later cancellation cannot retract those bytes or promise a retroactive denial.
Internal filesystem, terminal, and unknown client RPC methods remain
unsupported and are rejected.

This is a powerful opt-in: approving an ACP permission can authorize agent-side
effects for that one request. It does **not** authorize SDK-side caller-tool
execution, bypass MCP schema/receipt checks, or establish provenance. A
callback must make its own approval decision for every request and must not
rely on ACP session IDs, titles, tool kinds, or `_meta` claims as proof of
origin. Callback detail fields are bounded; the exact bound MCP authorization
value and bearer token are removed before truncation, while unknown token/URL
detection is heuristic. Arbitrary model-supplied text cannot be guaranteed
fully scrubbed. Handlers must not block the JavaScript thread; an elapsed
monotonic deadline rejects a late decision, but cannot preempt synchronous user
code while it is running.

**ACP permission origin is unverified.** ACP v1 defines
`RequestPermissionRequest.sessionId` and a `ToolCallUpdate`, but it does not
standardize an MCP-server association on that update; `_meta` is opaque
extensibility data. The SDK validates any such marker but does not treat it as
authority and never falls back to a title or kind. An explicitly configured
callback receives `origin: "unverified"` rather than any claim that a marker
proves origin. The official executable has not been live-qualified for positive
permission handling; do not describe live permission handling as verified.

`createProfileRegistry()` and `createProfileSessionEngine()` remain available
as lower-level APIs. There is deliberately no default no-op/fake inference
client or success-returning placeholder.
The error taxonomy includes distinct busy, aborted, timeout, process-failure,
protocol-failure, and interrupted-session codes/classes, among others; S0 does
not implement runtime operations. S1 uses account-not-found, invalid-request,
busy, aborted, and internal errors for registry and lock operations. S4 adds
runtime ledger admission and lifecycle errors.

`Session.messages.create` has separate streaming and non-streaming overloads.
Streaming resolves to an incremental `AsyncIterable<RawMessageStreamEvent>`;
non-streaming resolves to an Anthropic `Message`. Both accept an optional
`AbortSignal` in the second `options` argument. A session pins its model and
system/tool catalog; those settings cannot be overridden per request. The
S7 MCP registry is transport only; S8 wires the default parked MCP handler
into receipt-backed Messages tool handoff. Custom callback execution remains an
explicit separate opt-in.

`Session.diagnostics.snapshot()` is separate from the Anthropic `Message`
payload. S5 distinguishes complete reported per-operation token counts from
unknown usage; ACP context occupancy is a separate diagnostic and is never
presented as per-operation usage.

### A1–A5 policy and permission contracts

`AntigravitySDK` accepts `maxTokensPolicy: "strict" | "allow-unenforced-max-tokens"`;
omitting it pins `"strict"` for each account/session. Strict mode requires an
explicit `maxTokens: "enforced"` capability and matching per-response
admission. The official ACP driver does not provide that guarantee, so strict
mode rejects before prompt dispatch and before any tool-result release.

`allow-unenforced-max-tokens` is an explicit opt-in exception: native Messages
requests may proceed through the official ACP event pump, but ACP receives no
invented output-cap parameter, the SDK does not truncate its answer, and the
answer may exceed the requested `max_tokens`, resulting in additional output,
spend, and quota use. A response is **not** labeled with
`stop_reason: "max_tokens"` when the requested bound was not enforced; an ACP
`max_tokens` terminal in this mode is rejected rather than attributed to the
request. Resource-safety limits on event count and bytes remain independent
and are not token enforcement.

The exact account/session/operation, response kind, requested limit, pinned
policy, honest `enforced`/`not-enforced` outcome, and reason are available as
`session.diagnostics.snapshot().maxTokensEnforcement`; usage remains separate.
This snapshot is session-scoped diagnostics, not an extension on the Anthropic
`Message` payload; it identifies the latest admitted Messages operation for
that session. The native Messages facade also associates a frozen receipt with
the exact returned `Message` or streaming `message_start.message` out of band.
It is attached before that first stream event is exposed and remains available
if the consumer later aborts. The native Anthropic payload and event schemas
are not extended. Optional adapters verify the receipt's account/session,
normalized requested bound, pinned policy, outcome, and reason against the
actual operation before exposing their own `max_tokens_enforcement` metadata.

Native Messages callers can query that exact-object association through the
package-root accessor. It returns a frozen `MaxTokensEnforcementDiagnostic`
for a native response or stream-start message, and `undefined` for objects not
issued as Messages responses by this SDK (including accounts, sessions, and
unrelated response objects). It does not consult the latest session snapshot,
so retaining response A and querying it after response B still returns A's
receipt:

```ts
import { messageMaxTokensEnforcement } from "antigravity-oauth-sdk";

const message = await session.messages.create({
  max_tokens: 512,
  messages: [{ role: "user", content: "Hello" }],
});
const receipt = messageMaxTokensEnforcement(message);
// MaxTokensEnforcementDiagnostic | undefined; the result is immutable.

const stream = await session.messages.create({
  max_tokens: 512,
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: message.content },
    { role: "user", content: "Continue" },
  ],
  stream: true,
});
for await (const event of stream) {
  if (event.type === "message_start") {
    const streamReceipt = messageMaxTokensEnforcement(event.message);
    console.log(streamReceipt);
    // break intentionally cancels after start; consume the rest to complete.
    break;
  }
}
```

The accessor uses object identity: a copied/spread/serialized `Message` is an
unrelated object and returns `undefined`. Keep the original native object (or
the original `message_start.message`) to query its receipt. This limitation is
intentional to avoid guessing operation association from a mutable latest
snapshot.

`permissions` accepts `{ onRequest, timeoutMs? }`. The timeout defaults to
10,000 ms and is bounded to 1–60,000 ms. Its callback receives a fresh,
deep-frozen context with account/session/operation/request/tool-call IDs,
offered ACP option IDs and kinds, bounded sanitized or omitted descriptive
details with redaction/truncation flags, `origin: "unverified"`, and an
`AbortSignal` (string IDs are limited to 512 UTF-8 bytes and at most 64 offered
options are exposed). The callback may deny or select an exact offered
`allow_once` option; the SDK never selects `allow_always` or `reject_always`.
Opaque metadata and session identifiers are correlation data, not proof of
origin. While callback work is pending, its signal is aborted on operation
cancellation/change, terminal completion, timeout, session close, or profile
logout. A monotonic deadline is checked even if synchronous callback code
prevented its timer callback from running on time, and is checked again at the
queued transport write. A timed-out callback that ignores its signal continues
to occupy one of the eight SDK-wide callback slots until it settles.
Synchronous callback code cannot be preempted, so handlers must be nonblocking.
Callback exceptions and payloads are not logged.
Supplying `permissions` together with a custom `sessionDriverFactory` is
rejected at construction rather than silently bypassing the callback.

An explicit callback can display bounded details to a human and return only an
exact offered one-shot allow ID after that decision:

```ts
const sdk = new AntigravitySDK({
  storageDir,
  executable,
  permissions: {
    timeoutMs: 10_000,
    async onRequest(context) {
      // The context always says "unverified". Do not treat the title, kind,
      // session ID, or opaque metadata as proof of permission origin.
      const approved = await approvalUI.confirm({
        origin: context.origin,
        handling: context.details.handling,
        redacted: context.details.redacted,
        truncated: context.details.truncated,
        title: context.details.title,
        name: context.details.name,
        kind: context.details.kind,
      });
      const oneShot = context.offeredOptions.find(({ kind }) => kind === "allow_once");
      return approved && oneShot
        ? { action: "select", optionId: oneShot.optionId }
        : { action: "deny" };
    },
  },
});
```

Descriptions are untrusted and may be sensitive. Raw input/output, locations,
option names, and opaque metadata are omitted; only bounded sanitized or
redacted display fields are supplied. Heuristic secret detection is not a
guarantee that arbitrary model-supplied text is safe to display. The timeout
defaults to 10 seconds and can be set from 1 to 60 seconds. The transport
revalidates the operation and deadline immediately before the permission frame
is written. `stdin.write()` accepting the bytes is the commit boundary:
cancellation afterward cannot retract the already-buffered response.

No PLAN.md acceptance criteria were changed.

## Local profile registry (S1)

Create an explicit private storage root, then create or retrieve opaque
per-profile contexts:

```ts
import { createProfileAuth, createProfileRegistry } from "antigravity-oauth-sdk";

const registry = await createProfileRegistry({ storageDir: "/private/app-data" });
const first = await registry.accounts.create();
const sameProfile = await registry.accounts.get(first.id);
const profiles = await registry.accounts.list();

// connectAcp() accepts this profile context and uses its isolated environment.
// No child is spawned until connectAcp() is explicitly called.
const childEnv = first.context.childEnvironment;
const auth = createProfileAuth(registry.accounts, first.id, {
  executable: "/path/to/the/official-acp-executable",
  args: ["--stdio"],
});
await auth.login({ signal }); // S3; auth manages the profile lock itself.
```

`storageDir` is required and must be absolute. The SDK creates the directory
with owner-only permissions where POSIX modes are available, and rejects an
existing permissive storage root instead of silently changing its permissions.
The registry generates `acct_<UUIDv4>` identifiers; callers do not provide
filesystem-derived IDs. `get` rejects malformed IDs and reports a missing
well-formed ID with `AccountNotFoundError`. Account records contain only a
schema version, the opaque ID, and creation time, not credentials. Profile
directories are SDK-owned and are not automatically deleted. An interrupted
create may leave a private profile directory and temporary record; `list()`
ignores it until the complete final record is atomically published.

Each profile has a distinct `GEMINI_HOME`, `HOME` (and XDG paths), and the
forced `AGY_ACP_FORCE_FILE_STORAGE=1`. Only the following non-credential keys
may be copied from the environment snapshot: `PATH`, `TMPDIR`, `TMP`, `TEMP`,
`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, and
`PATHEXT`. Ambient credential variables, `GEMINI_HOME`, `HOME`, proxy settings,
`NODE_OPTIONS`, and XDG overrides are not inherited. The builder does not
mutate `process.env`. The allowlist and profile homes do **not** establish
isolation from OS keychains, global credential stores, or platform-level
authentication mechanisms.

Profile paths are checked for symlinks and private POSIX mode bits whenever
they are opened through the registry. This rejects ordinary path traversal and
symlink substitution. Node's filesystem APIs do not provide a portable
directory-handle-relative API for every operation, so same-user hostile
filesystem races cannot be eliminated completely. `connectAcp()` currently
consumes the supplied context and environment snapshot; `ProfileContext` has no
post-creation revalidation method, so it does not automatically re-check a
profile directory replaced after context creation. Re-fetch the account from
the registry immediately before connecting to repeat S1's checks, while
recognizing that this does not eliminate the same-user race.

Auth-operation locks are exclusive across processes. Acquisition accepts an
optional `AbortSignal` and `timeoutMs` (default 30 seconds); timeout raises
`SessionBusyError`, and abort raises `RequestAbortedError`. Lock release checks
both the random ownership token and filesystem identity before unlinking, and
will refuse to remove a replacement lock. On Linux, stale owners are reclaimed
only after comparing host, boot ID, PID, and `/proc` process start time. On
platforms without a stable process-identity check, stale locks fail closed and
are not taken over using a PID-only guess. A crash during stale-lock cleanup
may leave a reaper guard; after verifying no reaper is active, manual removal
of that SDK-owned guard may be needed. Account records and locks are atomically
published as fully-written files using same-directory hard links, so the
selected storage filesystem must support hard links; unsupported filesystems
fail closed.
Lock metadata contains an ownership token and process identity, not credentials.

## ACP stdio transport (S2)

The transport starts no process until `connectAcp()` is called. It invokes the
explicit executable/arguments with piped stdio and a copy of the profile's
allowlisted child environment; it does not merge ambient `process.env`, read
credentials, auto-download a binary, or retry. `stdout` is exclusively
newline-delimited JSON-RPC protocol data. Diagnostics are never parsed from
stdout. Stderr content is never retained or passed to callers. If an `onStderr`
callback is supplied, it receives only a content-free byte-count summary on
process close; this avoids relying on pattern matching that can fail on split,
unterminated, or truncated secrets. Transport errors do not include raw stderr
or remote JSON-RPC error data.

```ts
import { connectAcp } from "antigravity-oauth-sdk";

const connection = await connectAcp({
  executable: "/path/to/the/official-acp-executable",
  args: ["--stdio"],
  profile: accountProfile.context,
  cwd: "/work/project",
  signal,
  onRequest: async ({ method, params }) => {
    // A later slice supplies explicit domain handlers; absent methods get
    // JSON-RPC method-not-found, never an assumed successful response.
    return handleAgentRequest(method, params);
  },
  onNotification: ({ method, params }) => handleAgentNotification(method, params),
});

const negotiated = connection.initializeResult;
const result = await connection.request("some/acp-method", {}, {
  signal,
  timeoutMs: 15_000,
  // Optional absolute Unix epoch time in milliseconds; earliest deadline wins.
  deadline: Date.now() + 15_000,
});
await connection.notify("some/acp-notification", {});
await connection.close();
```

`connectAcp()` performs only ACP `initialize` with `protocolVersion: 1` and
`clientCapabilities: {}`; it verifies that the agent returns version 1 and
exposes the response/capabilities. It does **not** issue `session/new`, load or
authenticate an account, send prompts, or provide Anthropic inference. The
`ProcessFactory` option is an injectable seam for tests. Server requests and
notifications are dispatched bidirectionally; an unset request handler
returns `-32601`, while handler exceptions return a generic `-32603` without
leaking exception details. A valid remote JSON-RPC error rejects the client
request with `ProviderError`; malformed frames, malformed UTF-8/JSON, unknown
response IDs, EOF, or process errors fail the transport rather than becoming
success values.

Frames are limited to 1 MiB by default (configurable up to 16 MiB); the
outbound write queue is limited to 4 MiB (up to 64 MiB). Outstanding requests
and concurrent inbound handler work are separately bounded (256 messages and
4 MiB of queued inbound frames by default).
Writes are serialized and respect the child stdin `drain` backpressure signal.
Requests default to a 30-second timeout. A timeout rejects with
`RequestTimeoutError`; abort rejects with `RequestAbortedError`. If bytes may
already have been written, the ID is retained to safely recognize a late
response. If the agent never responds, that ID continues to count
toward the outstanding-request bound. There are no automatic retries or
transport-level cancellation semantics. A notification aborted after its
write begins may still be delivered. `close()` is idempotent, ends stdin,
waits briefly, then escalates process termination and cleans up listeners.

## Explicit profile auth lifecycle (S3)

Create an auth handle from the registry and an opaque account ID. The handle
reloads the profile before taking its cross-process auth lock and revalidates
it again before starting ACP, rather than trusting a stale `ProfileContext`.
Only the exact advertised `oauth-personal` ACP method is supported; missing or
unknown methods fail clearly and never fall back to another advertised flow.
No API key, CLI/IDE credentials, browser cookie, or ambient credential is read.

```ts
import { createProfileAuth } from "antigravity-oauth-sdk";

const auth = createProfileAuth(registry.accounts, account.id, {
  executable: "/path/to/the/official-acp-executable",
  args: ["--stdio"],
  // Optional ProcessFactory and ProfileRuntimeManager seams are injectable.
});

await auth.login({ signal }); // the only operation that may start OAuth
const status = await auth.status();
await auth.logout({ signal });
```

`login()` holds the profile auth lock for the operation, stops existing workers
tracked by its `ProfileRuntimeManager`, starts one ACP worker, verifies the
advertised method, and sends only `{ methodId: "oauth-personal" }` to ACP's
`authenticate` request. It never implements OAuth or token refresh. An ACP
authentication rejection is surfaced as `AuthenticationError`; process,
protocol, timeout, and cancellation errors remain distinct. The login worker
is always torn down before the lock is released. There is no interactive login
fallback from status or regular Messages work.

To support a remote/headless caller, pass an interaction explicitly:

```ts
await auth.login({
  signal,
  interaction: {
    showAuthorizationUrl(url, instructions) {
      terminal.write(`${instructions}\n${url}\n`); // application-controlled UI
    },
    promptForCallback: (signal) => promptForFullCallbackUrl(signal),
  },
});
```

The headless path captures the ACP-launched browser URL through a private,
temporary helper; it does not invoke a browser itself. The URL must use the
observed Google OAuth HTTPS origin/path, and its redirect must be a numeric
loopback address. The returned callback must match the exact loopback origin,
port, path, and per-login state before it is forwarded to that local listener.
URL, state, callback, child stderr, and credential data are not logged. This
capture integration is currently supported only on non-Windows hosts and is
mock-qualified; no live official ACP/browser qualification has been done.

`status()` starts no worker, sends no ACP request, opens no browser, and reports
only the most recent result observed by that particular auth handle. A new
handle (including one after process restart) reports `unknown`; ACP v1
initialize does not provide a portable auth-status query. A prior successful
`authenticate` result is not a guarantee that credentials remain valid or that
refresh will succeed. If logout finds no recognized auth files, status remains
`unknown` rather than claiming that an unrecognized storage layout is empty.

`logout()` closes and awaits all workers registered with the profile runtime
manager before touching local auth state. It performs local deletion only; it
does not send a remote revoke/logout request or affect global/CLI/IDE state. It
removes the currently evidenced file-backed ACP auth token at
`GEMINI_HOME/antigravity-acp/acp_token.json` and removes only the `auth` member
from that directory's `settings.json`, preserving other settings and files.
Symlinks, unsafe modes, malformed settings, and replaced files fail closed;
the containing profile and all unrelated data are retained. This path layout
is based on the available ACP integration reference, not a live official
runtime contract. If a runtime stores credentials elsewhere, this local
logout cannot be claimed to clear them; no server-side logout is claimed.
`ProfileRuntimeManager` is the injectable worker lifecycle seam for later
session workers. A session engine requires an explicit manager; pass the same
manager to both `createProfileAuth()` and `createProfileSessionEngine()` so
logout covers those workers. `createProfileRuntimeManager()` creates an
isolated instance to share. Session state is not stored in a global singleton.
Cross-process session-worker shutdown has not been proven.

## Session ledger and worker seam (S4)

`createProfileSessionEngine(accounts, accountId, { driverFactory, workerManager })`
creates a registry-bound session collection. `create()` copies and freezes the
session's model, cwd, system prompt, and tool catalog, then starts exactly one
injected worker through the profile runtime manager. The built-in package does
not supply a worker, call ACP `session/new`, or issue prompts.

```ts
import { createProfileSessionEngine, createProfileRuntimeManager } from "antigravity-oauth-sdk";

const workerManager = createProfileRuntimeManager();
const sessions = createProfileSessionEngine(registry.accounts, account.id, {
  workerManager,
  driverFactory: async ({ accountId, sessionId, profile, configuration }) => {
    // Application/S5 integration constructs one stateful ACP session worker.
    return makeSessionDriver({ accountId, sessionId, profile, configuration });
  },
});

const ledger = await sessions.create({ model: "model-id", cwd: "/workspace" });
const receipt = await ledger.execute({
  transcript: [{ role: "user", content: "Hello" }],
});
await ledger.close();
await sessions.close();
```

The first execute supplies the initial transcript; later executes provide the
entire transcript. Admission accepts only `user`/`assistant` message roles
whose content is a JSON string or array. JSON values must be finite, acyclic,
dense arrays and plain records (no accessors, symbols, or non-JSON values).
S4 treats content blocks as inert transcript data; it does not validate the
full Anthropic content-block subset. Historical `tool_use`/`tool_result`
blocks do not become tool authority. A live worker receives only the new
suffix, along with immutable account/session IDs and pinned configuration.
Each successful operation must return an explicit `completed` or
`awaiting_tools` acknowledgement plus one or more assistant output messages.
Only then does the ledger atomically append the input suffix and output once.

The lifecycle is `idle → running → idle | awaiting_tools | interrupted`, with
`closed` terminal. Prefix/configuration divergence and same-session concurrency
are rejected before dispatch; independent sessions/accounts can dispatch in
parallel. Abort, worker failure, malformed acknowledgement, or uncertain
completion leaves an interrupted ledger with no new messages committed. It
cannot be replayed or replaced. An explicit `awaiting_tools` acknowledgement
commits the assistant turn but tool-result continuation is rejected until a
later slice adds handoff/routing. `close()` is idempotent and shares lifecycle
with auth logout when both use the same explicitly supplied profile runtime
manager. Snapshots, configuration, dispatch input, and receipts are
copied/frozen.

This is a process-local ledger, not durable crash recovery. Session creation
state, transcript, operation IDs, and receipts are not persisted. Runtime
manager coordination is process-local; S3's cross-process auth lock does not
prove that an SDK session worker in another process can be shut down. S4 also
does not implement streaming, usage accounting, tool execution, or ACP
cancellation beyond the injected worker's `AbortSignal` and `close()` contract.
S5 adds non-stream Messages and S6 adds native streaming through an explicitly
capable injected worker.

## Native Messages normalization and non-stream (S5)

The S5 facade is available on the account-bound ledger returned by
`createProfileSessionEngine(...).create(...)`:

```ts
const sessions = createProfileSessionEngine(registry.accounts, account.id, {
  workerManager,
  driverFactory: ({ accountId, sessionId, profile, configuration }) =>
    makeStatefulAcpDriver({ accountId, sessionId, profile, configuration }),
});
const session = await sessions.create({
  model: "model-id",
  cwd: "/workspace",
  system: "Follow the workspace instructions.",
});

const message = await session.messages.create({
  max_tokens: 512,
  messages: [{ role: "user", content: "Hello" }],
});
```

The built-in driver implements account/session-bound ACP startup, a shared
`session/prompt` event pump, and same-prompt MCP park/continuation. Under
`strict`, Messages admission rejects before dispatch because the official ACP
backend's hard output-token enforcement is unverified. Under
`allow-unenforced-max-tokens`, this pump may run with an explicit
`not-enforced` admission and the exact requested limit retained in diagnostics;
there is no ACP token-cap parameter or output truncation. An injected inference
driver must keep its ACP session and return an explicit completed
assistant-text acknowledgement plus an ACP terminal `stopReason`. The
`SessionDriverOperation` receives only the uncommitted transcript suffix,
immutable account/session/configuration, an `acpPrompt` text-block mapping, and
the exact required `maxTokens` value. The initial suffix contains supported
caller-supplied history. Follow-ups include only new turns; the ACP session is
responsible for retaining its previously accepted context. S5 does not execute
or expose tool calls.

ACP v1's prompt representation has text blocks rather than native
user/assistant/system channels. The S5 mapper therefore sends one text block
per turn tagged `[user]` or `[assistant]`; each turn's text blocks are joined
without inserted characters. On the initial operation only, a fixed system
prompt is a leading `<instruction>\n...\n</instruction>` text block. This is
an explicit textual encoding, not a claim that ACP gives it native Anthropic
role semantics. The driver must dispatch the supplied representation as-is.

The S5 runtime request allowlist is exactly `max_tokens`, `messages`, and
optional `stream: false`. `max_tokens` must be a positive safe integer and is
required by Anthropic's request type. Strict mode rejects before dispatch
unless the driver declares `capabilities: { maxTokens: "enforced" }` and
implements `admitResponse(request)`. The explicit compatibility exception may
instead use a `not-enforced` capability, but only when the SDK policy is
`allow-unenforced-max-tokens`. In either mode, admission binds the exact
account/session/operation/kind/requested limit/policy and must finish before
prompt dispatch, or before any validated tool-result batch is persisted or
released to ACP. The grant's outcome and reason are carried to the driver;
compatibility grants explicitly say the backend does not enforce the bound.
A capability declaration alone is insufficient, and injected/mock drivers do
not prove their real backend enforces a hard limit.

Messages accepts non-empty full transcripts of `user`/`assistant` turns with
plain string/text blocks and, when a matching SDK-owned handoff is active,
caller `tool_use`/`tool_result` blocks. Historical tool blocks can be supplied
as inert text-encoded context; they never create pending authority. Request-level
model, system, and tools are rejected because configuration is pinned at
session creation. System prompts must be plain text or text blocks. Image,
document, audio, unsupported roles/block metadata, sampling (`temperature`,
`top_p`, `top_k`), stop sequences, thinking, structured output, tool choice,
and all other unlisted request fields are rejected before dispatch. S6 adds
`stream: true` only when the worker has separately declared bounded incremental
streaming support. Malformed values raise `InvalidRequestError`; unsupported
valid semantics raise `UnsupportedFeatureError`.

Explicit ACP results map `end_turn`, `max_tokens`, `refusal`, and
`model_context_window_exceeded` to the corresponding Anthropic stop reasons
only when the admission outcome is `enforced`. An ACP `max_tokens` stop under
the compatibility policy is rejected rather than misreported as reaching the
caller's requested bound.
`tool_use` is accepted only with a current `awaiting_tools` acknowledgement and
one-to-one matched MCP waiters from the pinned caller catalog. Cancellation
remains an error; stop-sequence, paused-turn, and unknown ACP stop reasons fail
closed. ACP activity or thought notifications are never returned as Anthropic
tool requests, thinking, or fabricated signatures. The built-in driver
validates ACP v1 `agent_thought_chunk`, `tool_call`, and `tool_call_update`
notifications during the owning prompt turn, then records only per-session
type counts in `session.diagnostics.snapshot().acpActivity`. Raw thought text,
tool titles/names, inputs/outputs, locations, and metadata are discarded; these
notifications never invoke caller tools, affect MCP receipts, or enter Messages
output. Per prompt, activity is limited to 128 events and 1 MiB; total prompt
event/byte limits still apply. The diagnostic counters saturate at 65,536 and
report `capped: true` if later events are omitted. Malformed, foreign, terminal-
late, or unknown notifications fail closed. Malformed/missing results,
unsupported output blocks, worker crashes, and aborts commit no transcript and
interrupt the session.

The Anthropic `Message.usage` fields are required. When ACP reports both
non-negative integer per-operation input/output totals, S5 returns them and
diagnostics identify the source. Reported cached input totals are subtracted
from inclusive ACP input totals and returned in Anthropic's cache fields;
reported thinking-token counts may appear in usage details, but never create
thinking content or signatures. If totals are absent or incomplete, S5 returns
the documented wire placeholders `input_tokens: 0` and `output_tokens: 0`, while
`diagnostics.snapshot().usage` is `{ kind: "unknown", ... }`; these zeros are
not measurements. Context occupancy remains a separate diagnostic and is
never substituted for either token count; a successful operation with no new
occupancy observation omits that field rather than presenting a stale value as
current. The original S5 text-only path does not fabricate thinking blocks or
signatures; S8 adds only receipt-matched caller `tool_use` content.

S5/S6/S8 and S11.4/S11.5/A2 are deterministic fake-child qualified only. The
built-in driver implements ACP `session/prompt`, text pumping, authoritative
MCP call correlation, and same-prompt continuation. Strict admission still
rejects before inference; compatibility admission is tested with a fake ACP
process and explicitly does not establish real backend output-token
enforcement. No live ACP call or official inference behavior is verified.

## Native Messages streaming and cancellation (S6)

`stream: true` returns a pull-based `AsyncIterable<RawMessageStreamEvent>` only
when the driver declares `streaming: "incremental"`, implements
`admitResponse(request)`, and implements `stream(operation)`. The same strict
or explicit compatibility output-token policy applies to initial streams and
tool continuations, with admission before prompt dispatch or result release.
The built-in driver advertises incremental streaming and only advertises
`not-enforced` admission when compatibility was explicitly selected. The
Chat/Responses adapters remain strict until A3 response-scoped disclosure. A
custom/injected worker declaration is an application contract and is not proof
that an ACP implementation enforces limits or streams incrementally.

The streaming worker yields `{ type: "text", text }` events containing actual
assistant text chunks, then one `{ type: "complete", acknowledgement }` with
the same complete assistant text and terminal result that a non-stream
acknowledgement carries, and then reaches EOF. The SDK validates that the
concatenated chunks exactly match the acknowledged output and rejects missing,
extra, or post-terminal events. Caller-facing events are
`message_start`, one indexed text `content_block_start`, the actual
`content_block_delta` events, `content_block_stop`, `message_delta`, then
`message_stop`. Text, whitespace, Unicode, and an explicit empty text block
are preserved; no thinking/signature or internal ACP tool events are
fabricated. The same `MessageAccumulator` and usage/stop normalization power
streaming and non-stream responses.

The SDK does not read ahead: each worker iterator `next()` is requested only
when the caller advances far enough to need the next semantic event. Per
operation limits are 65,536 worker events and 8 MiB of UTF-8 assistant text;
the stream fails closed rather than truncating if either limit is exceeded.
These limits bound SDK aggregation; the driver must also bound its own queues.
No server-sent-event bytes, heartbeat events, or HTTP response wrapper are
provided.

An abort signal or consumer `return()`/early `break` aborts the operation,
closes the worker iterator, interrupts the session, and does not commit a
partial transcript. The worker must honor the operation signal and iterator
cleanup contract for prompt cancellation. Iterator cleanup and worker close
are bounded by `streamCleanupTimeoutMs` on `createProfileSessionEngine()`
(default 1,000 ms; positive integer milliseconds). A timeout surfaces a typed
process failure with the timeout as its cause, leaves the session non-replayable,
and keeps the worker lease owned for a later close retry. The SDK does not
claim that an unresponsive or unkillable injected worker has stopped; engine
shutdown fails within the configured cleanup budget instead of silently
discarding ownership. A terminal worker acknowledgement
without iterator EOF, an error before or after output, or premature EOF is an
error and never produces `message_stop`. The ledger commits once, immediately
before the final `message_stop` can be yielded; returning before that final
event leaves the session interrupted and transcript unchanged. For S8 tool
handoff, a complete streamed `tool_use` batch terminates with
`stop_reason: "tool_use"`, commits the assistant blocks, and parks the same
session for the caller's complete tool-result batch.

Streaming usage is updated in `message_delta` and in session diagnostics only
after successful completion. If ACP omits complete per-operation totals, the
required Anthropic numeric usage fields use the documented zero placeholders
and diagnostics retain `{ kind: "unknown", ... }`; context occupancy remains
separate. `message_start` usage is a placeholder because final stream usage is
not known yet.

## Session caller-tool MCP transport (S7)

Each `SessionLedger` exposes `session.tools`, a fixed caller-tool registry
bound to that ledger's account ID, session ID, and SHA-256 catalog fingerprint.
`session.tools.createMcpServer({ onToolCall?, limits? })` starts at most one
ephemeral HTTP server for the session. When `onToolCall` is omitted, calls are
parked for the S8 Messages handoff. Supplying a handler remains an explicit
opt-in MCP execution path and does not feed Messages tool results. The server
binds only to `127.0.0.1` on an OS
assigned port and exposes MCP Streamable HTTP JSON-RPC at `/mcp`; this is an
internal tool handoff transport, not an inference endpoint or a public API
proxy. `initialize`, `notifications/initialized`,
`notifications/cancelled`, `tools/list`, and `tools/call` are implemented.
The server advertises MCP protocol `2025-06-18` and negotiates the supported
`2024-11-05` and `2025-03-26` versions as well. It is stateful and returns an
`Mcp-Session-Id` that must accompany requests after initialization.

The returned `SessionMcpServer` has `url`, bound account/session/catalog
metadata, and a secret-bearing `headers` object. Its Bearer token is a
per-server 256-bit random capability; the additional account, session, and
catalog headers must match the bound values. The capability is never included
in SDK-generated logs or error messages. Treat `headers` as secret: do not log,
persist, or expose them to an untrusted process. Requests with an `Origin`
header, a non-loopback peer, a mismatched `Host`, or foreign binding headers
are rejected. Origin-bearing browser requests are intentionally unsupported.
`server.close()` is idempotent; `session.close()` and profile runtime-manager
shutdown also close the endpoint, abort outstanding calls, and wait up to the
configured shutdown bound.

Only the pinned caller `SessionTool` catalog is published. ACP methods,
notifications, activity, and thought events are not catalog entries and are
never translated into caller tools. Tool definitions may contain only `name`,
optional `description`, `input_schema`, and optional `type: "custom"` (or
`null`); built-in ACP/Anthropic tools and tool metadata with different
execution semantics are rejected. Catalogs are copied/frozen before use.
Names must be unique; at most 128 tools and 512 KiB of catalog JSON are
accepted.

Input schemas use **JSON Schema Draft 2020-12** (an omitted `$schema` means
that dialect), as implemented by Ajv strict mode. The top level must have
`type: "object"`. Validation does not coerce values, insert defaults, or remove
additional properties. Local JSON Pointer `$ref` references (including
`$defs`) and standard Draft 2020-12 constraints are supported. Unknown keywords,
unresolved/remote refs, dynamic/resource refs, same-instance recursive refs,
`pattern`, `patternProperties`, and `format` are rejected before the MCP server
starts. Regex patterns are excluded to bound validation time; `format` is
excluded because Draft 2020-12's default format vocabulary is annotation-only
and treating it as an assertion would vary by validator. Any schema object
containing an own `__proto__` key is rejected because Ajv omits that key from
property-oriented schema maps. Ajv validates only own input properties. Schema input is
bounded to 10,000 JSON nodes, depth 64, and 512 KiB. This is an explicit
fail-closed subset, not a silent schema sanitizer.

`tools/call` validates the complete JSON arguments object against the original
schema before invoking a supplied `onToolCall(call, { signal })` handler or the
session's internal handoff waiter. The immutable `PendingToolCall` carries an
SDK call ID, JSON-RPC request ID, account/session/catalog identity, name, and
validated arguments. The built-in driver correlates the call by the
authoritative SDK-generated `toolu_…` ID supplied after schema validation and
receipt readiness; it does not infer authority from ACP display telemetry or
only from matching names and arguments. Injected drivers without this internal
feed retain the unique name/argument matching contract. No caller-provided
function is invoked by the default Messages handoff. Handler results are
bounded MCP text results;
handler errors fail closed with a generic JSON-RPC error.

## Caller-managed Messages tool handoff (S8)

Sessions with a pinned custom-tool catalog may call `session.messages.create()`
or stream the same request. When the injected worker returns a current
`awaiting_tools` acknowledgement, every assistant `tool_use` must match exactly
one parked MCP call, account, session, catalog, tool name, and validated
arguments digest. The built-in driver's internal feed carries the SDK-issued
MCP call ID only after schema validation and durable receipt readiness; the
session engine verifies that exact ID, catalog, name, and arguments digest.
Injected workers without that feed use the conservative unique name/argument
match. The SDK returns an Anthropic `stop_reason: "tool_use"` boundary.
Streaming emits each
tool block serially as `content_block_start`, a full `input_json_delta`, and
`content_block_stop`, then the ordinary `message_delta`/`message_stop` sequence.

The caller then supplies the **full** transcript, including the committed
assistant tool-use blocks and the entire `user` tool-result batch, to the same
session/account. This continuation suffix contains only tool results; send new
user text as a later turn after the worker has completed. IDs must exactly match the currently exposed batch; partial,
duplicate, unknown, foreign, or conflicting results fail before any waiter is
released. Result content supports a string or text blocks, and `is_error` is
preserved as MCP `isError`; image and other non-text result content is rejected.
After the entire batch is durably saved, delivery is attempted once to the
parked MCP waiters. The SDK prechecks the exact JSON-RPC result envelope against
each request's configured MCP response limit, then requires the MCP response to
finish before consuming the worker continuation. After exact `max_tokens`
admission and before saving/releasing any result, the built-in driver prepares
the parked turn so ACP text and terminal output can be buffered while loopback
MCP response delivery finishes; this transition does not itself release
results or authorize an unadmitted continuation.
Disconnects, fallback error envelopes, timeouts, or missing transport/worker
acknowledgement leave the receipt uncertain and interrupt the session. A later
batch can be returned and continued on the same session. MCP calls arriving
after the current batch is sealed—including during receipt persistence or
while the session is awaiting results—are assigned to a reserved next operation;
the worker cannot complete successfully with those waiters unassigned. The
built-in pump gives already-readable concurrent loopback requests one Node
event-loop turn to coalesce; the session engine's synchronous `sealBatch` mode
transition is the exact cutoff. Requests not admitted by that cutoff belong to
the next batch rather than being matched heuristically by tool name/arguments.

The injected `SessionDriver` must implement `continueTools()` for non-streaming
continuation and `streamTools()` for streaming continuation. The SDK releases
the matching MCP HTTP waiters and passes the same validated batch as
continuation metadata; drivers must not execute, re-deliver, or replay caller
tools/results. A driver must not acknowledge completion unless its underlying
worker confirms continuation of the same parked turn after consuming the MCP
result; the SDK cannot infer that from HTTP transport completion alone.
When a worker needs the SDK endpoint configured after session startup, it may
implement `bindCallerTools(server)`; the SDK passes the ephemeral URL and
secret-bearing headers directly to that callback. Drivers must treat those
headers as secrets and must not log or persist them. A driver without this
callback must arrange equivalent worker-side MCP configuration itself.
S11.5 implements these binding and continuation callbacks in the built-in ACP
driver. The integration is only exercised through a fake child and loopback
MCP endpoint; the explicit compatibility path does not establish official
backend `max_tokens` enforcement or live ACP behavior.

SDK-owned receipts are stored under the account's private profile directory in
`.sdk-tool-receipts/`, using private files, an exclusive lock, atomic rename,
and directory sync. Receipts retain account/session/operation/call IDs,
catalog, tool name, argument digest (not raw arguments), exposure state, result
state, and saved text results. `session.diagnostics.toolHandoffs()` and
`engine.recoveryDiagnostics()` are read-only; results may contain caller data.
The recovery API does not reopen sessions, resume a worker, acknowledge an
uncertain delivery, or replay a result. `not_exposed`, `exposure_attempted`,
`exposed_or_uncertain`, `saved`, `delivery_attempted`, `acknowledged`, and
`uncertain` states are conservative crash diagnostics, not an exactly-once
claim. Interrupted sessions cannot be retried; create a fresh session and treat
any uncertain external side effect as application-owned.

Defaults are 1 MiB request/response bodies, a 30-second wall-clock request and
tool-handoff deadline, 64 concurrent HTTP requests (plus eight reserved
cancellation slots), 16 concurrent injected calls, and a 1-second shutdown
wait. Configurable ceilings are 16 MiB bodies, 120-second requests, 256 HTTP
requests, 64 concurrent calls, and 10 seconds for shutdown. JSON is limited to
25,000 nodes and depth 64; validated call arguments have a 1 MiB bound. The
request deadline is checked after synchronous JSON/schema validation as well
as during asynchronous reads/handoffs; Node cannot preempt a single synchronous
JavaScript validation call. Oversize requests,
overload, duplicate in-flight JSON-RPC IDs, malformed envelopes, unknown tools,
and schema-invalid arguments are rejected. Serialized JSON-RPC IDs above 256
bytes are rejected with a null ID. Oversized-response fallbacks preserve the
admitted bounded request ID for correlation and use null for invalid or
unadmitted IDs; every fallback is checked against the response bound. Request state and its
deadline remain active until the HTTP response finishes or closes; a response
stalled by a non-reading client has its socket destroyed at the deadline and
is not replaced with a second response. Cancellation aborts the handler
signal; injected handlers must honor it. Node cannot forcibly stop an
application handler that ignores its signal, so such handlers remain counted
against the call concurrency bound even after the HTTP request is closed.
HTTP rejects use 401 for an invalid capability, 403 for origin/peer policy,
404 for foreign account/session/catalog/MCP-session bindings, 413 for oversized
bodies, and 503 for HTTP concurrency overload. JSON-RPC errors use the standard
parse/request/method/parameter codes (`-32700`, `-32600`, `-32601`, `-32602`),
`-32800` for cancellation, `-32001` for request timeout, `-32004` for injected
call concurrency overload, and `-32603` for generic handler/result failure.
Error text is generic and does not include capabilities, tool arguments, or
handler exception details.

## Optional Rosetta Chat Completions adapter (S9)

The adapter is imported separately so applications using only the SDK root or
native Messages do not load Rosetta:

```ts
import { createChatAdapter } from "antigravity-oauth-sdk/chat";

const chat = createChatAdapter(session); // session comes from an explicit account profile
// `session` is pinned to this exact system prompt and has no caller tools.
const system = { role: "system" as const, content: "Use the pinned instructions." };
const firstUser = { role: "user" as const, content: "Hello" };
const completion = await chat.completions.create({
  model: session.configuration.model,
  messages: [system, firstUser],
});
const assistantMessage = completion.choices[0]?.message;
if (!assistantMessage || typeof assistantMessage.content !== "string") {
  throw new Error("The example expects a text-only Chat response.");
}
const assistantTurn = { role: "assistant" as const, content: assistantMessage.content };

// A follow-up resubmits the committed transcript prefix and the pinned system
// prompt; a tools-enabled turn must also include its complete tool-result batch.
const stream = await chat.completions.create({
  model: session.configuration.model,
  messages: [system, firstUser, assistantTurn, { role: "user" as const, content: "Continue" }],
  stream: true,
  stream_options: { include_usage: true },
});
for await (const chunk of stream) console.log(chunk);
```

The adapter creates a fresh Rosetta 1.0.38 converter per operation and uses the
same instance for request and response/stream conversion. It is bound to one
SDK-created account/session handle. Model, converted system prompt, and function
catalog must match that session's immutable configuration. Provide the pinned
system prompt in the Chat transcript when it is non-empty; system/developer
text blocks are concatenated before comparison. Function definitions must be
present and match the session's complete pinned catalog. The adapter passes
the full converted Chat transcript to the existing Messages ledger, leaving
committed-prefix validation and caller-tool result receipts in the native
session implementation.

Supported Chat request subset:

| Field/content | Supported behavior |
| --- | --- |
| `model` | Required and must exactly equal the session's pinned model. |
| Messages | `system`/`developer` only at the beginning; `user`, `assistant`, and `tool` messages. Text strings and text-only parts only. |
| Assistant history | An explicit `content: ""` means an empty text block; `null` or an omitted `content` means no text block. Tool-only adapter responses use `content: null`. This distinction is retained when resubmitting the full transcript. |
| Function tools | Function definitions only; explicit object JSON Schema; schema must exactly survive Rosetta conversion and equal the pinned catalog. Function-call arguments must be valid JSON objects. Every outstanding call needs one matching tool result before another message. IDs are preserved. |
| `max_completion_tokens` / `max_tokens` | At most one positive safe integer. If omitted, Rosetta's explicit default is **4096**. The session must admit the exact converted bound. Strict sessions require `maxTokens: "enforced"`; a session explicitly configured with `allow-unenforced-max-tokens` may use a `not-enforced` admission and reports that fact. |
| `n` | Omitted or exactly `1`. |
| `stream` | Omitted/false for non-streaming or `true` for streaming. |
| `stream_options` | On streams only, `{ include_usage?: boolean }`. A terminal usage chunk is emitted only when `include_usage: true`; unknown usage is `usage: null` with `usage_provenance`, not fabricated zero counts. |

All other Chat fields fail closed, including sampling/stop controls, `tool_choice`,
`parallel_tool_calls`, response formats/JSON mode, strict schemas, custom grammar
tools, provider-hosted/web-search tools, multimodal content, reasoning controls,
and other OpenAI extensions. `n > 1`, malformed JSON arguments, partial or
foreign tool-result batches, and schemas changed by Rosetta's sanitizer are
rejected before inference. A non-stream response includes a
`usage_provenance` and `max_tokens_enforcement` extensions; when diagnostics
say usage is unknown, standard `usage` is `null`. The enforcement extension is
an immutable receipt with account/session/operation IDs, `kind`, normalized
`requestedMaxTokens`, `policy`, `outcome`, and `reason`. Stream chunks carry it
from the initial role chunk through any terminal usage chunk, so clients can
observe an unenforced bound before consuming output. ACP usage is session
diagnostics, not an independent tokenizer measurement.

Under `allow-unenforced-max-tokens`, the response is not capped locally. For
example, requesting `max_tokens: 1` may still return a substantially longer
answer; the adapter keeps the returned text and usage and reports
`outcome: "not-enforced"`. It does not fabricate a `max_tokens` finish reason
or truncate the output.

```ts
import { createChatAdapter } from "antigravity-oauth-sdk/chat";

const chat = createChatAdapter(session); // session belongs to an SDK configured with the explicit opt-in policy
const completion = await chat.completions.create({
  model: session.configuration.model,
  messages: [{ role: "user", content: "Answer in detail." }],
  max_tokens: 1,
});
console.log(completion.max_tokens_enforcement);
// `{ requestedMaxTokens: 1, outcome: "not-enforced", ... }` is disclosure,
// not a promise that the returned answer contains at most one generated token.
```

Streaming preserves backpressure and propagates caller cancellation and
consumer `return()`/`throw()`, including when a `next()` is pending. Cleanup is
forwarded to the native iterator and remains subject to the session's bounded
cleanup deadline. Content chunks can be observed before completion, but the
finish-reason chunk and optional usage chunk are withheld until a valid terminal
Messages sequence and EOF are confirmed. Missing/unknown events and malformed
terminal tool JSON fail the stream; generic worker/SDK errors are not hidden.
The caller remains responsible for executing function tools and returning
results. This adapter adds no fetch layer, inference server, credentials, or
implicit environment lookup. Node 22+ is required. Real ACP inference,
live-account behavior, and official hard `max_tokens` enforcement remain
unverified; strict mode fails closed, while the explicit compatibility mode
does not cap output and may result in additional spend and quota use.

## Optional Rosetta Responses adapter (S10)

The adapter is imported from its own package subpath and is bound to one
explicit SDK-created session:

```ts
import { createResponsesAdapter } from "antigravity-oauth-sdk/responses";

const responses = createResponsesAdapter(session);
// `session` is pinned to these instructions and has no caller tools.
const instructions = "Use the pinned instructions.";
const result = await responses.responses.create({
  model: session.configuration.model,
  instructions,
  input: "Hello",
  max_output_tokens: 512,
});
console.log(result.max_tokens_enforcement);

// This no-tools example requires a completed text message; reconstruct that
// completed text-only assistant input instead of spreading `result.output`'s
// union, which may contain output-only item kinds not valid as request input.
const [assistantOutput] = result.output;
if (!assistantOutput || assistantOutput.type !== "message" || assistantOutput.status !== "completed") {
  throw new Error("The example expects one text-message Responses output.");
}
const assistantTextParts = assistantOutput.content.filter(
  (part): part is Extract<(typeof assistantOutput.content)[number], { type: "output_text" }> =>
    part.type === "output_text",
);
if (assistantTextParts.length !== assistantOutput.content.length) {
  throw new Error("The example expects text-only assistant output.");
}
if (assistantTextParts.some((part) => part.annotations.length !== 0 || (part.logprobs?.length ?? 0) !== 0)) {
  throw new Error("The example expects unannotated text output.");
}
const assistantInput = {
  type: "message" as const,
  id: assistantOutput.id,
  role: "assistant" as const,
  status: assistantOutput.status,
  content: assistantTextParts.map(({ text }) => ({
    type: "output_text" as const,
    text,
    annotations: [],
  })),
};

const stream = await responses.responses.create({
  model: session.configuration.model,
  instructions,
  input: [
    { type: "message", role: "user", content: "Hello" },
    assistantInput,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ],
  stream: true,
}, { signal });
for await (const event of stream) console.log(event);
```

The adapter creates a fresh Rosetta 1.0.38 `ResponsesToMessagesConverter`
for each operation and uses that same instance for request and response/stream
conversion. The session's native Anthropic Messages ledger remains the source
of truth and works independently of this optional peer. Model, converted
instructions/system prompt, and function catalog must match the session's
immutable pins. Each request supplies the complete input transcript; native
session prefix validation and caller-tool receipts continue to apply.

Supported Responses subset:

| Field/content | Supported behavior |
| --- | --- |
| `model` | Required and must equal the session's pinned model. |
| `input` | Required string or full array transcript of text messages and completed function calls/results. User/system/developer content uses `input_text`; assistant history uses `output_text`. Only text is supported. |
| System instructions | `instructions` and leading `system`/`developer` history must convert to exactly the pinned system prompt. |
| Function tools | Function tools only, with explicit object JSON Schemas that survive conversion unchanged and exactly equal the pinned catalog. Function arguments must be bounded valid JSON objects; call/result IDs are checked and retained. Names whose first `___` has non-empty text on both sides are rejected because Rosetta splits them into namespace/name fields; the adapter never rewrites them. |
| `tool_choice` | Omitted/null or `"auto"` only. Forced, disabled, and hosted-tool choices are rejected. |
| `parallel_tool_calls` | Omitted/null/`true`; `false` is rejected even without `tool_choice`, because the native Messages capability cannot enforce it. |
| `max_output_tokens` | Positive safe integer or null. Rosetta's default when omitted/null is **4096**. The session must admit the exact converted bound. Strict sessions require `maxTokens: "enforced"`; the explicit compatibility policy may admit an unenforced bound and reports that fact. |
| `stream` | Omitted/false/null for non-streaming, or `true` for streaming. The driver must advertise incremental streaming. |

All other request fields are rejected rather than dropped. In particular,
`previous_response_id`, `conversation`, `store`, `background`, `prompt`, JSON
output formats/schemas, multimodal input, reasoning/sampling controls, custom
grammar tools, and web-search/hosted tools have no implementation here. Supply
the complete transcript on every operation; this adapter does not implement
Responses server storage, retrieval, background jobs, or the full OpenAI API.

Non-stream output uses Rosetta's Responses object/status mapping, with
`usage_provenance` and immutable `max_tokens_enforcement` extensions. The
enforcement receipt is checked against the exact `max_output_tokens` after
Rosetta normalization (including its **4096** default). `usage` is `null` if the driver has not reported
token usage or has not reported both cache buckets needed to calculate the
Responses cache-inclusive input total. Otherwise, cache counts are projected
from the operation diagnostic; an unknown reasoning-token detail is represented
as `null`. Context occupancy is not token usage.

Streaming emits Responses event objects (not SSE bytes). One Anthropic event
may fan out to several ordered Responses events. The `max_tokens_enforcement`
extension is present at the top level of streamed events and on response-bearing
events, including the initial `response.created`/`response.in_progress` fanout;
it is therefore observable before terminal usage/completion. A successful or failed
terminal event is withheld until the native stream reaches valid `message_stop`
and clean EOF, so a later error cannot follow an already-yielded false
completion. `response.completed`, `response.incomplete`, and `response.failed`
retain their respective meanings. An `Anthropic.APIError` that reaches the
adapter's Messages iterator is converted to `response.failed`/`error` events
(matching the pinned Rosetta behavior); generic errors remain thrown rather
than becoming success. The core recognizes Anthropic APIError subclasses even
across nested SDK copies; other unrecognized worker errors are normalized to
`ProcessFailureError` before an adapter sees them.
Non-stream errors are thrown as surfaced by Messages. Abort and consumer
`return()`/`throw()` are forwarded even while a `next()` is pending; no
successful terminal event is fabricated on cancellation. This adapter does not
add a custom fetch, HTTP server, credential access, or automatic tool execution.
Node 22+ is required; live ACP inference remains unqualified.

## Scope and lifecycle constraints

The intended implementation is a bounded Messages subset, not a general
Anthropic API proxy. The request aliases use upstream Anthropic types for
ergonomic compatibility only; accepting a value in TypeScript does **not** mean
the runtime will accept or enforce that field. Unsupported fields and semantics
must be rejected rather than silently omitted, approximated, or rewritten. S0
has no runtime request validation. S4 validates its transcript ledger boundary;
S5/S8 validate the documented Messages request/content and caller-tool
continuation subset.

### Implemented S5 acceptance target

For the first native, non-streaming Messages slice (S5), the deliberately
narrow target is:

- Session creation pins `model` and `cwd`, with optional fixed `system` prompt.
- The request transcript contains `user` and `assistant` turns with plain
  text, supported caller tool-use blocks, or supported caller tool-result
  blocks. Historical tool blocks are inert; active authority is receipt-bound.
- `max_tokens` is admitted only with an exact per-response grant. Strict mode
  requires the hard-enforcement contract; the approved explicit compatibility
  policy may admit ACP's unenforced bound and reports that outcome without
  truncating the answer. This repository has no real ACP implementation that
  proves server-side enforcement.
- Streaming is outside S5 and belongs to S6. S7 adds the account/session-bound
  internal MCP registry; S8 adds receipt-backed caller-managed Messages
  handoff and continuation through an injected driver seam.

The implemented Messages target rejects request-level `model`, `system`, or
`tools` because those are session-pinned; image/document/other non-text
content;
sampling controls (`temperature`, `top_p`, `top_k`); `stop_sequences`; thinking
controls; structured-output/JSON-schema controls; tool choice; unsupported
tool-result content; and provider-specific or other unlisted
fields. This is a conservative implemented target, not a claim that an ACP
backend supports any rejected candidate. A field may be added only after its
semantics are validated and enforced end to end. Sampling, structured output,
and thinking are not advertised.

### Implemented ledger rules (S4) used by S5

Each follow-up supplies the full conversation transcript. The S4 ledger
validates the committed prefix and configuration; only the new suffix is sent
to its injected worker. A new session accepts role/JSON-valid initial history,
including inert historical tool blocks, without granting pending tool-call
authority. Changing a committed message, changing a supplied model/system/tool
assertion, or starting a concurrent operation on the same session is rejected
before dispatch. Different sessions may operate in parallel. Configuration
changes require a new session.

Only a fully successful operation is committed. Abort, partial observation,
protocol failure, or process crash must not be treated as a completed turn or
silently replayed. A crash leaves the session interrupted; there is no
transparent recovery. When custom tools are implemented, callers manage
execution and must provide the complete exposed result batch; the SDK does not
automatically execute or replay side effects.

Usage that cannot be measured is represented as unknown in diagnostics, not as
a fabricated measurement. Because Anthropic requires numeric usage fields, S5
documents zeros as wire placeholders only. Context occupancy remains a
separate diagnostic.

The SDK does not implement OAuth exchange or refresh; ACP owns both. The
login/status/logout lifecycle is mock-qualified only, and its local status is
intentionally not a remote validity check. The built-in ACP session/prompt
event pump and park/continuation mechanics exist. Strict inference is denied
until hard per-response `max_tokens` enforcement is established; the explicit
opt-in compatibility path allows requests without enforcement and does not
truncate output. Real ACP inference and account behavior remain unqualified,
and compatibility-mode answers may exceed their requested bounds and increase
spend or quota use.
Automatic session resume remains unimplemented. S8 receipts and S11.5
continuation are mock-tested, not real-worker qualified.
Account IDs are
generated by the S1 registry and missing-account behavior is defined there.
The S5 usage placeholder policy and request/content allowlist are documented
above. S8 receipts and S11.5 continuation are mock-tested only; a real ACP
driver's `max_tokens` enforcement and MCP interoperability remain unverified.
Absent a valid strict or explicitly opted-in compatibility admission, the SDK
rejects the request before dispatch.
