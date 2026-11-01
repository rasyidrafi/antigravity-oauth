# Slice ledger

The authoritative plan and acceptance criteria are in `PLAN.md`.

| Slice | Dependencies | Implementation session | Review session | Status and evidence |
| --- | --- | --- | --- | --- |
| S0 | — | `ses_e7062793effep4Qvo7y2RoMJOM` | `ses_e705dd967ffeDvbsSXlsaEFtg1` | passed; reviewer verified fixes. Node 26: `npm test` and pack dry run passed; Node 22 unverified. |
| S1 | S0 | `ses_e704f3d8fffez6qhbLdmWQPWCa` | `ses_e7035f482ffeUGrXZ2qH0TSa7C` | passed; reviewer verified atomic profile publication fix. Implementer reported 19 tests and pack dry run passing on Node 26. Node 22 and live keychain unverified. |
| S2 | S0–S1 | `ses_e702ad469ffe9ELjObc8kXvA7L` | `ses_e700fc8b3ffeib2yPy9q6s4EZ4` | passed; reviewer verified content-free stderr and startup failure fixes. Implementer reported 49 tests and pack dry run passing on Node 26. Node 22 and live ACP unverified. |
| S3 | S1–S2 | `ses_e700a17f3ffeiCUor5dPXimoOH` | `ses_e6ff30f95ffewKl3OVmAvTyttZ` | passed mock scope; implementer reported 72 tests and pack passing on Node 26. Live ACP/OAuth, Node 22, credential layout and cross-process session shutdown unverified. |
| S4 | S2–S3 | `ses_e6ff1dab2ffe5VhG4suMvaVwnd` | `ses_e6fe234afffeJB29pC4DCGYJgq` | passed; reviewer independently reproduced cleanup fixes. Implementer reported 82 tests passing on Node 26. Live ACP and cross-process shutdown unverified. |
| S5 | S4 | `ses_e6fdcc9ceffenQGIfxD11v1yi3` | `ses_e6fc73a33ffeyspaOXprPrkwP9` | passed; reviewer verified worker capability failure cleanup. Implementer reported 97 tests passing on Node 26. Real ACP inference driver remains required for integration. |
| S6 | S5 | `ses_e6fc159ceffeW05kvRiPi2uJVU` | `ses_e6fa3edd5ffet6UE1jXnFhXAFJ` | passed; reviewer verified bounded cancellation and closed-state race fixes. Implementer reported 113 tests passing on Node 26; real ACP and Node 22 unverified. |
| S7 | S2, S5 | `ses_e6f93c3f2ffeaBUhwKQQm7bBeV` | `ses_e6f788d46ffeqVoJ3LPbkzNqMr` | passed; reviewer independently verified schema, ID correlation, bounded response and deadline fixes. Implementer reported 125 tests on Node 26; Node 22 and live ACP unverified. |
| S8 | S4, S6–S7 | `ses_e6f6319b7ffetVVgrx96X4vyyf` | `ses_e6f2c9f96ffeETGTfcASHwYth0` | passed mock scope; reviewer independently verified cancellation, receipts, late-call and stream fixes. Implementer reported 144 tests on Node 26; real ACP driver unimplemented. |
| S9 | S5–S8 | `ses_e6efb6ac5ffe7VaFHM9k5BTypl` | `ses_e6ed81487ffeo6MYs4nqbypLYs` | passed; reviewer verified empty-text continuation and pending-iterator cancellation fixes. Implementer reported 159 tests and optional-peer pack checks on Node 26. |
| S10 | S9 | `ses_e6ec72c6cffeU1zj9XujW31rV3` | `ses_e6e9e881dffegquMf0hN6prvx8` | passed mock scope; reviewer verified namespace transformation is rejected before dispatch. Implementer reported 174 tests passing on Node 26. |
| S11 | S0–S10 | — | `ses_e6e989352ffeFLNfcEnJmznLPC` | passed mock integration under the user-approved adjustment below. Strict inference remains fail-closed; explicit opt-in allows unenforced `max_tokens` and explicit one-shot permission decisions. No real inference or live product qualification claimed. Follow-up research `ses_e6dc1ecd1ffe50rl8zS4q4Zgeh` found no standardized ACP v1 output cap or permission origin. |
| S11.1 | S0–S10 | `ses_e6e95484dffeAN6D8FImOgMtlJ` | `ses_e6e882899ffeQck3Zrz7NDjira` | passed mock scope; reviewer verified retryable auth cleanup and lock ownership. Implementer reported 185 tests on Node 26. |
| S11.2 | S11.1 | `ses_e6e79eef3ffeKXxWrBgkcOfbSM` | `ses_e6e5eeb1fffeM66VrFL02Bj6y1` | passed mock scope; reviewer verified ACP configOptions notifications and eager/lazy selection. Implementer reported 216 tests on Node 26; real ACP unverified. |
| S11.3 | S11.2 | `ses_e6e5773acffeJxqRCZ4WnN5p7E` | `ses_e6e438849ffejPyTharEI6N5Gd` | passed mock admission scope; reviewer verified cancellation race and pre-release ordering. Implementer reported 221 tests on Node 26. Official output-limit enforcement remains unproven; built-in rejects inference. |
| S11.4 | S11.2–S11.3 | `ses_e6e3c12b0ffeSZCo9VRmo0U3a8` | `ses_e6e24747fffeSMsqlNaTIYJoNy` | passed mock scope; reviewer verified nullable ACP metadata and post-terminal failure handling. Implementer reported 276 tests on Node 26. Official driver still rejects inference without proven max_tokens enforcement. |
| S11.5 | S11.4, S7–S8 | `ses_e6e1193e5ffeJ4UylCCZtfJc4b` | `ses_e6dfb7ca7ffeY2OoOm6L93wDrL` | passed mock scope; reviewer verified pre-release driver transition, buffering and correct MCP binding. Implementer reported 291 tests on Node 26. Production inference still fails closed. |
| S11.6 | S11.2–S11.5 | `ses_e6dea9411ffejpt72mFZegajtU` | `ses_e6dde927fffesJmppUhyNNUavU` | passed mock scope; reviewer verified production permission default-deny. Official MCP attribution and max_tokens enforcement remain unresolved; implementer reported 294 tests on Node 26. |
| S11.7 | S11.1–S11.6 | `ses_e6dd5c4b4ffeYLQnH7ANoj5c0l` | `ses_e6dc9aeb8ffefDM3MgwlXhaDiE` | passed credential-free package/mock gate: `npm test` 295 tests; packed clean consumers passed on Node 22.23.4 and 26.13.0. Each run invokes the resolved npm CLI via the selected `process.execPath`, asserts the npm child runtime version, and checks npm lifecycle PATH resolves the same Node. Core peer-absent import and pinned-peer adapter imports/typechecks passed; composed fake ACP/MCP covered two accounts × two sessions, mock auth/profile separation, tool results, logout, SDK close, and endpoint/child cleanup. Production inference, live OAuth, official max-token enforcement, and permission provenance remain blocked/unverified. |
| S12 | S11 | — | — | blocked: reviewed official ACP executable not found in PATH or checked local locations; live qualification requires the executable, explicit browser login, and two user-controlled accounts. No ambient credentials were read. |

Qualification: mock integration and packed-consumer checks passed on Node 22.23.4 and 26.13.0. Live auth, live multi-account isolation, refresh, official ACP inference and live permission behavior remain unverified. The user approved explicit operation without a hard token cap and explicit one-shot permission decisions; neither establishes official enforcement or permission provenance.

## Approved contract adjustment

The user explicitly approved an opt-in compatibility mode that accepts Anthropic `max_tokens` while clearly reporting that the ACP backend does not enforce it. Strict fail-closed behavior remains the default. The user also approved an explicit caller approval callback for ambiguous ACP permission requests, with default denial and no claim that opaque metadata proves origin. This is a deliberate exception to the original strict contract in `PLAN.md`, which remains the faithful translation requested by the user. The A1–A4 rows below are recorded as passed. The approved callback does not authorize late grants: A5 revalidates operation ownership, terminal/cancellation/close state, and the monotonic callback deadline at the actual outbound permission-write boundary; after `stdin.write()` accepts bytes, the transport makes no retroactive retraction claim. Implement, review, and test these changes before claiming mock integration; live OAuth, actual ACP behavior, account isolation, and refresh require separate qualification.

Reviewer-informed adjustment plan: `ses_e6e989352ffeFLNfcEnJmznLPC`.

| Slice | Dependencies | Implementation session | Reviewer session | Status |
| --- | --- | --- | --- | --- |
| A1 | S11.7 | `ses_e6d8a2dfcffeJT1BwcOOgUPHVX` | `ses_e6d7daf03ffeaY9Z4cZKHuh4Iq` | passed contract scope; reviewer verified immutable strict-default options and no early authorization. Implementer reported 298 tests and packed smoke on Node 26. |
| A2 | A1 | `ses_e6d7c3d32ffekq9NNh7PnuVHU3` | `ses_e6d5f2eb3ffeEP9Nhw8Xf8B3w0` | passed mock scope; reviewer verified strict default, single-use admission, and explicit opt-in without pretending ACP enforces the limit. Implementer reported 308 tests on Node 26. |
| A3 | A2 | `ses_e6d5c6af9ffevChlmapthDc7Fb` | `ses_e6d4b7959ffeoPyY0g7MnJ38iA` | passed mock scope; reviewer verified public response-specific immutable disclosure including before stream output and after abort. Implementer reported 313 tests and pack smoke on Node 26. |
| A4 | A1–A2 | `ses_e6d4473f0ffer8oCcpfMnRLlyH` | `ses_e6d2c6150ffeUwkDcTTVEHEljX` | passed bounded scope; reviewer verified exact known-token redaction and elapsed-deadline rejection. Implementer reported 325 tests on Node 26; the transport write race was queued as A5. |
| A5 | A4 | `ses_e6d1e597bffeatt2vizqDT1mr5` | `ses_e6d0bc483ffec156DTxOwylTQ5` | passed mock scope; reviewer independently verified guarded FIFO write boundary, cancellation/timeout and response correlation. Implementer reported 337 tests and packed smoke on Node 24 and 26. |
| A6 | A2–A5 | `ses_e6d09adccffe7ofOtl7TAbAEn3` | `ses_e6cf27060ffeuK7mJSfQCEqgSj` | passed complete mock integration; reviewer independently verified activity ordering, non-authoritative diagnostics and compilable adapter examples. Implementer reported 340 tests and packed smoke on Node 22.23.4 and 26.13.0. No live ACP/OAuth qualification claimed. |

## Live qualification follow-up

Reviewer-informed plan: `ses_e6a9f163fffe97ho1g1zkksqO4`. Official ACP 1.3.0 hashes matched; one isolated SDK account login succeeded. Raw ACP model discovery and a prompt returned `end_turn`; public SDK inference failed on an unhandled notification. On this host the official executable requires `--gid=nogroup`.

| Slice | Dependencies | Implementer | Reviewer | Status |
| --- | --- | --- | --- | --- |
| B1 | A6 | `ses_e6a9d1c15ffelS3o1V97GLx0Gm` | `ses_e6a9298e8ffeRvv29xBVA3YPx3` | passed mock review; 349 tests and packed smoke reported on Node 26. Parent verified one live public-SDK nonstreaming inference with explicit unenforced-limit disclosure. |
| B2 | B1 | `ses_e6a90e66affeJqr2LmAGzE4F3a` | `ses_e6a820d4affeuVqxlQyAtremlB` | passed mock review and upstream schema comparison; implementer reported 361 tests and packed smoke on Node 26. |
| B3 | B2 | `ses_e6a7cb742ffeMLS88Cg1dPXvk0` | `ses_e6a787e33ffeg44rRN5QmFhFZ8` | passed bounded mock review; live default-deny observed, positive permission/tool path requires explicit human authorization. |
| B4 | B3 | `ses_e6a7578e3ffekC0UGzq7CTUkv9` | `ses_e6a6eeebeffeBoPZsVUbq4A6TN` | partial live qualification: login, native nonstream/stream continuation, Chat and Responses nonstream, strict denial, old default permission denial, and after T1 auto permission plus custom MCP tool handoff/result/continuation observed. README evidence updated and independently re-reviewed. |
| B5 | B4 | `ses_e6a0dfa6dffeQEjDpHjC1ifnJi` | `ses_e6a0177f4ffeZ49dYsxGCW8C7n` | scoped documentation review passed: two user-attested distinct Google accounts logged into separate SDK profiles; concurrent live tool handoffs were isolated, foreign result rejected; native tool streaming, both adapter streams and native cancellation succeeded. Identity was not independently verified; refresh/logout untested. Implementer reports 371 tests and packed smoke on Node 22/26. |

## User-authorized permission-default change

The user explicitly superseded the earlier default-deny and one-shot-only permission contract: the built-in ACP driver should automatically select an offered `allow_always` by default, without asking. This can authorize arbitrary agent-side effects and may create backend-persistent grants beyond the SDK/session. ACP request origin is unverified; cancellation cannot retract already written or persisted grants. Provide an explicit deny mode and preserve guarded write/cancellation. `PLAN.md` remains the historical translation. Reviewer-informed plan: `ses_e6a69a797ffeZNyE0oov0FYR11`.

| Slice | Dependencies | Implementer | Reviewer | Status |
| --- | --- | --- | --- | --- |
| P1 | B4 partial | `ses_e6a67c02dffef7goG5fetC80oz` | `ses_e6a5f938fffeK6IXDl8X6zpN7Q` | passed contract review; 365 tests and packed smoke reported. Auto approval staged until P2. |
| P2 | P1 | `ses_e6a5e6667ffe3jcp5m9SECWhwH` | `ses_e6a516babfferLGnzC4Cas57wu` | passed bounded review; implementer reports 370 tests and packed smoke on Node 26. |
| P3 | P2 | `ses_e6a502f1fffeu783WifCaCBI4i` | `ses_e6a4128ddffezaUNh4IK3rwPuA` | passed integration review; implementer reports 370 tests and packed smoke on Node 22/26. Live permission/tool path and multi-account/refresh remain unqualified. |

Live caller-tool trace (sanitized, parent): official ACP MCP initialization and `tools/list` succeeded. The actual MCP tool permission contained `_meta.mcp` keys `server` and `tool`; SDK validation rejected it and sent `cancelled`. A separate valid permission received `allow_always`. Thus the tool denial is a concrete metadata compatibility mismatch, not proof that the built-in tool filter should be relaxed. Reviewer investigation `ses_e6a3ee269ffeU8oDraYAlwIaS4` established the filter only governs host built-ins and must remain enabled.

| Slice | Dependencies | Implementer | Reviewer | Status |
| --- | --- | --- | --- | --- |
| T1 | P3 | `ses_e6a3bb0b1ffeQVLwPXoFw8Sc0n` | `ses_e6a34896cffeKjcOJ6Iw6H9aMh` | passed bounded review; implementer reports 371 tests and packed smoke on Node 26. Parent verified official ACP MCP tool_use, caller-supplied unique result and model continuation with automatic permission. |

## Distribution usability follow-up

Parent independently observed npm registry returns 404 for `antigravity-oauth-sdk`; the documented npm install command is not yet available. A clean install from `git+https://github.com/rasyidrafi/antigravity-oauth.git` installed successfully but root import failed `ERR_MODULE_NOT_FOUND` because ignored `dist/` is not built on Git installation. Do not publish a package or push without appropriate authorization.

| Slice | Dependencies | Implementer | Reviewer | Status |
| --- | --- | --- | --- | --- |
| D1 | B5, T1 | `ses_e69ff84ebffe4qJ9igZUmqN4tz` | `ses_e69f3962cffeMrgsgrVkgS6uzR` | passed scoped review; implementer reports 371 tests, packed and Git-install smoke on Node 22/26. Git-source smoke uses the public npm registry for build dependencies. |

Final cross-slice working-tree review: `ses_e69f28804ffeLIYVATiHywilm9` passed code and local Git-packaging scope, without independently accessing credentials or rerunning filesystem-writing suites. Live evidence is limited to official ACP 1.3.0 Linux x64 and `gemini-3.8-flash-low`; Google account distinction is user-attested, not independently established. Logout, refresh, hard output-token enforcement, and broad production or cross-process isolation remain unqualified. The npm package is unpublished.
