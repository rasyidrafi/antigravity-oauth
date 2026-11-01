# Decision

The plan is ready to begin. No user input blocks bootstrap or mock-based implementation.

Latest read-only inspection: the target is empty and is not yet a Git repository; the local runtime is Node v26.13.0 and npm 11.20.0. Node 22 support must still be tested, not inferred from the local runtime.

Implementation follows the slices below. Each slice: new implementation agent → new independent reviewer. Fixes and re-review use the same pair of sessions. The parent maintains the ledger and advances to the next slice only after acceptance is met. I did not delegate or change files.

# Locked contract

```ts
const sdk = new AntigravitySDK({ storageDir, executable });
const account = sdk.accounts.get(accountId);

await account.auth.login({ signal }); // explicit interactive operation
const session = await account.sessions.create({ model, cwd });

const message = await session.messages.create(request);
const events = await session.messages.create(
  { ...request, stream: true },
  { signal },
);

await session.close();
await sdk.close();
```

## Safe defaults

- Node ≥22, strict TypeScript, npm, ESM; core and the Rosetta adapter are separate.
- Requests and outputs use a documented subset of Anthropic Messages, not a claim of compatibility with the entire API.
- A session is bound to an account; there is no implicit default account, rotation, or CLI/IDE credential discovery.
- Full-transcript requests; the ledger validates the prefix, and only the new suffix is forwarded to a live ACP session.
- One active operation per session; concurrent follow-ups produce `SessionBusy`. Different sessions may run in parallel.
- Model, system, and tool catalog are frozen throughout an MVP session. Changes require a new session.
- Function tools are caller-managed. The caller must send the entire batch of exposed results; there is no automatic execution or replay.
- Streams contain event objects. Errors are thrown through the iterable; premature EOF is an error. There are no SSE bytes, pings, or HTTP error payloads in the event iterable.
- Internal ACP tool activity goes to diagnostics, not caller-facing tool requests.
- Unknown usage receives a documented placeholder and provenance via diagnostics; context occupancy is not treated as per-operation token usage.
- A crash puts the session into an interrupted state; there is no transparent recovery or replay.
- No public inference server, custom fetch, or HTTP compatibility endpoints in the MVP.

# Ordered slice plan

## S0 — Bootstrap and public contracts

**Dependencies:** none.

**Scope:** initialize the repository, core/adapter workspace, build/test scripts, public types, errors, and capability matrix; do not run ACP yet.

**Interface:**

- `AntigravitySDK`, account/session handles.
- `messages.create()` nonstream/stream overloads.
- Typed errors: validation, unsupported capability, auth required, busy, aborted, process/protocol failure, interrupted session.
- Diagnostics separate from the Anthropic payload.

**Acceptance:**

- Build and unit tests run without Bun.
- Type fixtures distinguish `Message` and `AsyncIterable`.
- Documentation specifies supported/rejected fields, history rules, lifecycle, and unknown usage.
- Core does not depend on Rosetta.
- No listener or subprocess on import/constructor.

## S1 — Profile registry and storage boundaries

**Dependencies:** S0.

**Scope:** local account registry, safe paths, profile environment builder, auth locks; no real OAuth yet.

**Interface:**

- `accounts.create/get/list`.
- Opaque profile context: storage root, child environment, account identity.
- Exclusive per-profile auth-operation lock, including across SDK processes.

**Acceptance:**

- A profile-specific `GEMINI_HOME` and `AGY_ACP_FORCE_FILE_STORAGE=1` are prepared for the child.
- Explicit environment allowlist; credential-related ambient overrides cannot defeat isolation.
- Do not read/import CLI/IDE login.
- Path traversal, symlink boundaries, permissions, and stale locks are tested.
- Two profiles do not share state or environment.
- Do not claim keychain isolation from environment settings alone.

## S2 — ACP stdio transport

**Dependencies:** S0–S1.

**Scope:** subprocess and JSON-RPC transport, initialization/capability negotiation, deadlines, cancellation, exit handling.

**Interface:**

- Injectable `ProcessFactory`.
- `AcpConnection.request/notify/close`.
- Typed ACP notifications and transport errors.

**Acceptance:**

- Fake child tests partial frames, invalid frames, unknown IDs, EOF, exit, timeout, and abort.
- Pending requests are rejected when the process dies.
- Bounded frame/queue sizes, stderr redaction, idempotent cleanup.
- No automatic prompt or auth retry.
- stdout is treated only as protocol transport.

## S3 — Explicit authentication lifecycle

**Dependencies:** S1–S2.

**Scope:** `auth.login/status/logout`, authentication negotiation, worker lifecycle when authentication changes.

**Interface:**

- Explicit login selects a supported authentication method; unknown flows fail clearly.
- `status()` does not open a browser.
- Logout closes profile workers and removes SDK-owned profile state according to the contract.

**Mock-based acceptance:**

- Login/startup/headless/auth-required/refresh-failure/logout.
- No interactive login as a fallback for Messages operations.
- Auth operations are serialized per profile; other profiles are unaffected.
- Logout does not touch CLI/IDE or global credentials.
- Refresh remains owned by ACP; the SDK does not implement OAuth refresh itself.

**Limit:** mock success is not proof of real OAuth or server-side logout.

## S4 — Session engine and transcript ledger

**Dependencies:** S2–S3.

**Scope:** session creation, state transitions, request admission, transcript reconciliation.

**Interface:**

- State: `idle → running → idle | awaiting_tools | interrupted`; `closed` is terminal.
- Operation ID and immutable account/session binding.
- Full-transcript prefix validator and suffix builder.

**Acceptance:**

- A new session can accept supported initial history without treating it as pending tool authority.
- Follow-ups do not duplicate history in a live ACP session.
- Divergent history, model/system/tools changes, and concurrent operations are rejected before prompting.
- Each successful output enters the ledger exactly once.
- Aborted/partially observed operations are not silently treated as committed success.
- A crash does not trigger session replacement or automatic replay.

## S5 — Native Messages normalization and nonstream

**Dependencies:** S4.

**Scope:** Messages request validation, ACP prompt mapping, internal semantic events, Message accumulator. Tools are not executed yet.

**Interface:**

- Shared internal event model for response and stream.
- ACP usage normalizer and diagnostics provenance.
- Capability validator before ACP dispatch.

**Acceptance:**

- Text/history/system mappings and stop reasons are tested.
- Unsupported fields/content are rejected, not omitted or changed into placeholders.
- Sampling, token limits, structured output, and thinking controls are not claimed as supported without proven enforcement.
- Unknown usage is not disguised as a measurement.
- ACP activity does not become fabricated signed Anthropic thinking.
- Protocol errors do not become successful empty answers.

## S6 — Native Messages streaming and cancellation

**Dependencies:** S5.

**Scope:** event emitter, backpressure, stream completion, iterator cleanup.

**Interface:** `AsyncIterable<Anthropic.RawMessageStreamEvent>` with `AbortSignal`.

**Acceptance:**

- `message_start → blocks → message_delta → message_stop` is valid.
- Stream aggregation is equivalent to nonstream for the same fixture.
- Unique block indices, Unicode/whitespace/empty output are correct.
- Errors before or during output are thrown; no successful terminal event is emitted.
- EOF without a terminal event fails.
- Abort and consumer `break/return()` close the operation deterministically.
- A successful `tool_use` boundary can later preserve a parked ACP operation; it is not cancellation.

## S7 — Internal MCP transport and tool registry

**Dependencies:** S2, S5.

**Scope:** loopback MCP bridge, function-tool catalog, schema validation, capability-bound routing.

**Interface:**

- Session-scoped tool registry.
- Internal `PendingToolCall`; caller continuation is not complete yet.
- Authenticated ephemeral loopback endpoint.

**Acceptance:**

- Bind only to loopback; tokens do not leak to logs.
- Wrong token/session/catalog is rejected.
- Unknown tools and invalid arguments are rejected.
- The original schema is the source of validation; no silent schema weakening.
- Request size/time limits, cancellation, and listener cleanup are tested.
- Internal ACP tools and caller custom tools are not mixed.

## S8 — Tool handoff, continuation, and crash receipts

**Dependencies:** S4, S6–S7.

**Scope:** Message `tool_use`, parked MCP waiters, batched `tool_result`, minimal durable receipts.

**Interface:**

- Call ledger: account/session/operation/call ID, arguments digest, exposure state, result, delivery state.
- States distinguish saved result, delivery attempted, acknowledged/uncertain.
- Read-only recovery diagnostics; no automatic resume.

**Acceptance:**

- Multiple calls and different result ordering work correctly.
- Streamed tool blocks are emitted completely in sequence, even when calls run in parallel.
- The entire exposed batch is validated before any waiter is released.
- Unknown/foreign IDs, conflicting duplicate results, and partial batches are rejected.
- Late-arriving calls form the next batch and are not lost.
- Crashes at every exposure/save/delivery boundary preserve available results.
- No exactly-once claim; no replay of tool side effects.
- Cancellation closes waiters and preserves receipt uncertainty.

## S9 — Optional Rosetta Chat adapter

**Dependencies:** S5–S8.

**Scope:** pin Rosetta 1.0.38, Chat Completions subset, function tools only.

**Interface:**

```ts
const chat = createChatAdapter(session);
await chat.completions.create(request, { signal });
```

One converter per operation; the same converter handles that operation's request and output.

**Acceptance:**

- Source validation before conversion; Messages capability validation afterwards.
- Reject unsupported `n`, custom grammar tools, web-search semantics, malformed tool arguments, and unsupported output constraints.
- Default token mapping is clear; do not promise enforcement ACP does not have.
- The schema sanitizer must not silently weaken the contract.
- Golden request/response/stream fixtures.
- Multi-call indices/arguments are correct because native emission is serial.
- Cache-inclusive OpenAI prompt usage is normalized; unknown usage remains traceable.
- `stream_options.include_usage` is honored.
- Generic SDK errors remain visible; unknown error events cannot disappear.
- Converter state does not leak across sessions/accounts.

## S10 — Optional Rosetta Responses adapter

**Dependencies:** S9.

**Scope:** separate Responses subset; not a prerequisite for core Messages functionality.

**Interface:** session-bound `responses.create()`.

**Acceptance:**

- One Anthropic event can produce multiple Responses events; ordering is correct.
- Generic errors versus `Anthropic.APIError` are tested.
- `previous_response_id`, background/store retrieval semantics, and features without a backing implementation are rejected.
- `parallel_tool_calls:false` is not lost when `tool_choice` is absent.
- JSON-mode/schema semantics are validated, not trusted to the converter.
- Terminal status, tool results, usage, and cancellation are tested.

## S11 — Packaging and integration without credentials

**Dependencies:** S0–S10.

**Scope:** package exports, clean install, examples, end-to-end fake ACP/MCP.

**Acceptance:**

- Packed install succeeds on Node 22 and the local/current supported runtime.
- Core can be used without importing Rosetta.
- Two accounts × two parallel sessions do not exchange credential environment, history, tools, usage, or events.
- Process crash, logout while active, SDK close, and failed startup leave no child/listener/lock behind.
- No public inference route.
- Documentation describes the supported subset and stateful ACP limitations, not “drop-in full compatibility”.

## S12 — Controlled live qualification

**Dependencies:** S11.

**Requires:** an available official ACP executable, user browser/consent, a valid subscription account; two accounts to prove multi-account isolation.

**Order:**

1. Record executable version, platform, and profile paths without secrets.
2. Explicitly log in to profile A.
3. Restart the process and make a headless request; check that the browser is not required on the expected path.
4. Test text nonstream/stream, a safe deterministic tool, continuation, and cancellation.
5. Log in to B; run A/B in parallel.
6. Log out A; verify B still works and CLI/IDE login is unchanged, without reading official credentials.
7. Verify refresh only if a refresh actually occurs; do not mark it passed merely because restart succeeded.

**If credentials/browser/executable are unavailable:**

- Stop the live step; do not take ambient login or attempt a bypass.
- Report the exact missing prerequisites and unproven tests.
- Final status: **mock-qualified, live-unverified**, not OAuth/multi-account production-qualified.
- Platform/keychain claims are limited to combinations actually tested.

# Parent ledger

```text
Slice | Depends | Impl session | Review session | Status
      | Commit/evidence | Acceptance results | Findings/fixes | Live gaps
```

Statuses used:

```text
queued → implementing → reviewing → fixing → re-reviewing → passed
                                                    ↘ blocked
```

Keep two summaries separate:

```text
Implementation: passed slices / remaining confirmed defects
Qualification: mock / Node22 / packaging / live-auth / multi-account / refresh
```

# Final integration gate

Before declaring completion:

- All relevant non-live acceptance criteria pass with reproducible evidence.
- No confirmed in-scope findings remain.
- Native Messages does not depend on the adapter.
- Session/history/tool authority remains account-bound.
- Cancellation/crash does not trigger silent replay or false success.
- No reading of CLI/IDE credentials or public inference server.
- OAuth, refresh, and isolation claims match available live evidence.

There is no blocking input to start S0. Real credentials and a browser are dependencies for S12; ToS/service-stability risks are recorded separately and are not equated with a design bug or successful technical OAuth.
