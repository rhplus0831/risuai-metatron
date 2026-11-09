# Found Issues Decisions Plan audit, 2026-11-08

- Plan: `docs/plan/found-issues-decisions.md`, retired; its last version is `git show 2beca50d5:docs/plan/found-issues-decisions.md`
- Commit audited: `3f1fab1ef` (`dev`)
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 5     |
| P2         | 6     |
| P3         | 3     |
| unverified | 0     |

Tests, browser behavior, and timings were not run. Upstream comparisons used the local `kwaroran/main` ref.
The anchor and wording parts of F13 and F14 and the overlap list of F12 were applied to the plan in the
commit that adds this report; the rest stands as found.

## P1

### F1 — A1: buffering a tools request needs both streaming controls and the batching path

Plan, A1: "when `arg.tools` is non-empty, take the buffered path for that request."

Code: `requestClaude` captures `arg.useStreaming` before building `body.stream`
(`server/src/llm/anthropic.ts:656`), while `requestClaudeHTTP` branches on `arg.useStreaming` on its own
(`anthropic.ts:393`, `:1004`); changing one leaves the wire body and the parser out of step. `claudeBatching`
(`anthropic.ts:884`) bypasses `requestClaudeHTTP` and its result parser ignores tool blocks, so clearing
streaming does not make that path run the tool loop. The Bedrock branch returns before tool schemas are
attached (`anthropic.ts:589`, `:617`).

Suggested correction: require a consistent buffered body and adapter argument, recursive tool follow-ups
included; route tool-bearing Messages requests around batching; state the Bedrock scope.

### F2 — A2: plugin providers return a stream whatever `useStreaming` says

Plan, A2: "a request with `escape` and `forceStreaming` both set is buffered and escaped in both runtimes."

Code: the server plugin-provider adapter returns `d.stream` directly (`server/src/llm/request.ts:684`) and
the tab wraps any successful `ReadableStream` (`src/ts/process/request/request.ts:784`); both outer escape
steps apply only to `type === "success"` (`server/src/llm/outer.ts:114`, tab `request.ts:448`). Clearing the
two flags leaves escaped plugin-provider output streamed and unescaped.

Suggested correction: buffer a returned plugin stream when streaming is off (keeping cancellation and
failure handling), and test the returned-stream case in both runtimes.

### F3 — A3: another tab of the creator is not the owner

Plan, A3: "the creator's other tabs take the job through the `absent` offer."

Code: generation identity and saved jobs live in a tab's `sessionStorage`; a copied tab gets a new identity
and drops copied job ids (`src/ts/network/generationJobs.ts:208`, `:224`). The server computes `owned` by
exact creator-client-id equality (`server/src/jobs/generationJobs.ts:2394`). Another tab fails
`own && reason === "absent"` (`src/ts/network/handoff.ts:286`) and needs `acceptHandoffs`; `handoff.test.ts:110`
pins that a foreign absent offer needs acceptance.

Suggested correction: with the client rules unchanged (the owner's decision), describe the rescue as the
originating creator tab under its recovered identity; another tab needs handoff acceptance on. Revise
_Done_ to match.

### F5 — B2: the existing deferred check skips a reload a reset needs

Plan, B2: "queue a deferred reload there (`queueDeferredCheck` or the reload guard `plugins.svelte.ts`
exposes)."

Code: `queueDeferredCheck` is private (`src/ts/plugins/plugins.svelte.ts:560`), needs `deferredWanted` and
the work-change subscription for idle retries (`:447`, `:540`), and skips when the plugin signature matches
(`:583`). A permission reset changes none of the signature's name, script, or IPC fields, so queueing the
existing check still skips the reload.

Suggested correction: add `plugins.svelte.ts` to B2's files and specify a forced deferred-reload reason that
bypasses signature equality while keeping the idle checks and local-load supersession; the existing
permission-removal listener (`src/ts/plugins/apiV3/permissionStore.ts:31`) can carry the reset notice.

### F6 — C1: `If-Modified-Since` still answers 304 after a flag change

Plan, C1: "a 304 only when the flag is unchanged."

Code: `setCacheHeaders` (`server/src/http/staticCache.ts:32–52`) builds the ETag from the stat and, without
`If-None-Match`, answers `If-Modified-Since` from the file mtime. Adding the flag to the ETag covers
`If-None-Match` only; an IMS-only request gets 304 after the operator changes the variable. Existing tests
use the IMS path for the index (`server/src/tests/app.test.ts:354`).

Suggested correction: give the injected index a flag-aware conditional policy (for example ETag-only
revalidation for that representation) and include the IMS-only transition in the test.

## P2

### F4 — A3: untargeted offers have no opening time

Plan, A3: "one offer delay after the later of its opening (targeted requests keep `requestedAt`) and the
absence."

Code: `handoff` sets `requestedAt` to `null` for untargeted requests and `openOffer` clears it for other
offers (`server/src/jobs/generationJobs.ts:1102`, `:2849`); `absentOfferAt` uses absence alone for them
(`:1118`). The source decision (`docs/research/found-issues.md:104`) says one delay after owner absence.

Suggested correction: keep absence-relative timing for non-targeted offers, as the decision says.

### F7 — D2: `testResult` and the Log export read `patchInput`

Plan, D2: "The only reader is `replayedInput`."

Code: `testResult` reads `patchInput` to report `patchCalled`
(`server/src/prompt/memory/structured/testRun.ts:166`, `:238`), and its dry-run commit captures the same
closing `MemoryChanges` the writer builds (`writer.ts:848`); the Log route keeps `patchInput`
(`server/src/routes/structuredMemory.ts:665`) and the JSON Log export serializes it
(`src/ts/process/structuredMemory.svelte.ts:1505`). Only analysis `input` is replayed; patch prompts are
rebuilt.

Suggested correction: prune at durable commit boundaries (live and staged writes) so dry-run reporting
stays; document the Log export losing the field.

### F8 — D2: the retention rule and the test contradict

Plan, D2: "unless it is the newest unrecorded one (the replay target)" against _Test_: "a failed run older
than a later recording loses its input".

Code: `replayedInput` uses `findLast(result !== "recorded")` over the whole history
(`server/src/prompt/memory/structured/writer.ts:331`), so a failure older than a later recording is still
the replay target.

Suggested correction: pick one policy (keep the `findLast` target, or change replay eligibility explicitly)
and apply it to opening, closing, failure, and interrupted writes alike.

### F9 — D2: the audit's probe never runs the writer

Plan, D2: "Re-measure the save with the audit's probe."

Code: the synthetic probe writes its 2,000 prompt-bearing rows straight into the scratch store and times
checkpoint saves (`server/src/tests/fixtures/memory/structured/measure.ts:203`, `util/memoryEval.mjs:722`); a
writer-only change leaves those inputs in place.

Suggested correction: specify an after-measurement that first runs the production recording and pruning
path over the seeded rows, and report the remaining prompt bytes beside the timing.

### F10 — E1: eight Recorded entries, not seven

Plan, E1: "the seven Recorded entries."

Evidence: the Index and E1 list eight whole Recorded entries (parked resends, Phase 6 leftovers, trim
question gaps, crossing transform chunks, inline editor, fallback URLs, JSON conversion, suggestion
re-render), with decisions at `docs/research/found-issues.md:33`, `:49`, `:88`, `:439`, `:509`, `:663`, `:686`,
`:817`; Evaluation findings is a split entry besides.

Suggested correction: say eight Recorded entries plus the remaining Evaluation bullets.

### F11 — B1, E1, Index, Rules: who records and who deletes

Plan: the Index gives B1's residual window to E1 while B1 says its Limitation "goes into the guide in this
slice, not E1"; the Rules forbid a slice to edit the inbox while E1 says "delete the entry"; the Evaluation
Index row names only `read.md` while E1 puts the bucket cost in `projection.md`.

Suggested correction: give the Limitation to B1 in the Index; say whether E1 or its landing commit deletes
the inbox entries; name `projection.md` in the Evaluation row.

## P3

### F12 — Order: unacknowledged guide overlaps

| Slices     | Shared file                          | Status before this audit           |
| ---------- | ------------------------------------ | ---------------------------------- |
| A1, A2     | `docs/structure/llm-requests.md`     | acknowledged                       |
| B1, B2, E1 | `docs/structure/plugin-sandbox.md`   | acknowledged                       |
| B1, B4     | `docs/structure/persistence.md`      | omitted                            |
| B4, C1     | `docs/structure/self-host-server.md` | omitted                            |
| C1, E1     | `docs/structure/cbs-rendering.md`    | omitted                            |
| D1, D2     | `shared/structuredMemory.ts`         | acknowledged                       |
| B2, C1     | `src/ts/tests/bootMocks.ts`          | only if B2 adds a `plugins` export |

Evidence: `persistence.md:67`, `:76`; `self-host-server.md:35`, `:46`; `cbs-rendering.md:53`; `bootMocks.ts:267`
(complete module doubles through `satisfies BootModules`). Applied: the three omitted guide overlaps and
the guide sizes are now in the plan's Order section.

### F13 — C1: more mock consumers of `addMetadataToElement`

Code: the typed parser double in `src/ts/tests/bootMocks.ts:176` and four renderer test mocks
(`src/lib/ChatScreens/ChatBody.svelte.test.ts:29`, `ChatBody.assets.svelte.test.ts:8`, `Chat.test.ts:43`,
`Chat.draft.test.ts:33`) name the export. Order's "four guides" is five guides plus the README. Applied in
the plan.

### F14 — Test anchors in A2, B2, C1, D1

- A2: `server/src/tests/llmServices.test.ts` covers redaction, Vertex tokens, and the warmer; the outer-loop
  harness is `server/src/tests/llmCharsetRetries.test.ts:33`. Applied.
- B2: no settings-page test covers the remove flow (`e2e/settingsPages.spec.ts:85` only visits pages).
  Applied.
- C1: `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts:175` mounts the real screen. Applied.
- D1: the route assertions accept any positive estimate (`server/src/tests/structuredMemoryRoutes.test.ts:2324`)
  and the client test round-trips a mocked `4000` (`src/ts/process/structuredMemory.test.ts:908`), so
  neither guards the constant; it also feeds the record-now and backfill previews
  (`server/src/prompt/memory/structured/rebuild.ts:371`, `:405`). Not applied: D1 needs a numeric assertion
  for 3,000 tokens per call across the preview modes.

## Verified

- Intro and Verification: the 18 decision paragraphs, the base commit, the package scripts, and
  `util/playwright/checkJobHandoff.mjs` exist.
- A1: the Messages SSE parser drops tool events; the buffered path runs tools and follows their results
  (`anthropic.ts:1036`, `:1159`).
- A2: the flag precedence and the two flag producers are as cited (`server/src/llm/request.ts:532`,
  `server/src/lua/bindings.ts:1203`, `server/src/prompt/runner.ts:1798`).
- A3: the early return, the preferred admission offer, the targeted deadline, and the reopen special case
  are as described (`generationJobs.ts:1115`, `:1129`, `:1161`, `:2367`).
- B1: `settings.plugins` is the installed-name source and already reachable from the store; v3 is the only
  product caller; installation adds the plugin before loading it.
- B2: reset counts persist, remote changes reach `installGrants`, cached consent is dropped, reload
  teardown removes listeners.
- B3: keeping older by-origin pairs keeps the Set-based eviction and UTF-16 accounting; identity-checked
  deletion protects the newer translation pointer.
- B4: the push cap is four outstanding in total; `moveRecordListItem` clamps `to`; its one caller checks
  first.
- C1: the two constant helpers, the unused country set, the three readers, and the dead watermark chain
  match; root, `/index.html`, and client routes share `serveIndex`; Vite's injection is serve-only; the
  service worker passes navigations through.
- D1: the constant is 1,500 and reaches only cost estimation; the measured ranges match the audit.
- D2: analysis input is persisted before its call; opening, failure, and recorded writes have commit
  boundaries; checkpoints and snapshots keep run JSON; chat files, memory packages, and inheritance exclude
  runs.
- E1: every Recorded decision matches the code it describes, and the structured-memory numbers match the
  2026-11-03 audit.
- The four mechanisms: `patchMessage` closes a fence (D2's receipt path checks locks first); feed rows are
  measured whole and D2's memory writes publish no chat change; `STORE_TABLES_SQL` runs only at
  `user_version === 0`, and neither A3 nor D2 needs a schema change; `sendText` counts a socket only after a
  buffer-admitted send, which A3 must keep.
