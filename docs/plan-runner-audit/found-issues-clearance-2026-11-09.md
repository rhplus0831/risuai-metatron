# Found Issues Clearance Plan audit, 2026-11-09

- Plan: `docs/plan/found-issues-clearance.md`
- Commit audited: `355e82e58` (`dev`)
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 8     |
| P2         | 14    |
| P3         | 8     |
| unverified | 2     |

Tests, drivers, and browser behavior were not run. The Index matches all 86 headings of
`found-issues.md`, and every _Removes_ name exists. Mechanisms found consistent: A1, B1 to B4, B6, C2,
C3, C6, D1, E1, E3, F2, F4 to F6, G1, and G3, subject to the overlaps in AUD-29 and AUD-30. AUD-23,
AUD-24, and AUD-25 were applied to the plan in the commit that adds this report. The rest were applied in the
follow-up commit the same day with the owner's decisions: C4 adds the `saveSignatures` control and replays raw
JSON (AUD-3, AUD-12); F3 keeps only the preset-hash fix and its retention entry is Recorded by H1 (AUD-5); F10
checks the flag after `subscribe` (AUD-6); E4 completes on a measured, explained miss (AUD-17); AUD-31 takes a
latch per case; AUD-32 states the concurrency as the plan's choice.

## P1

### AUD-1 — A3: consuming vector queues breaks cached duplicates

Plan, A3: "build one `Map` from content to a queue of vectors and take the next vector per chunk".

Code: `addText` skips text that is already loaded and admits a cached vector once
(`server/src/prompt/embeddings.ts:632`), so two equal chunks can have one vector. The current scan
(`server/src/prompt/memory/hypav3.ts:2687`) reuses the first match; a consuming queue would run out.

Suggested correction: map each text to its first vector and reuse it. Cover warm duplicates and content
admitted by an earlier call.

### AUD-2 — A4: the estimate is computed after assembly finishes

Plan, A4: `AssemblyHost` gains `toolSchemaTokens`, and `server/src/llm/requests.ts` "supplies the
estimate from the descriptors it will send".

Code: the runner awaits assembly (`server/src/prompt/runner.ts:1621`) before it invokes the request
(`runner.ts:1785`); the descriptors are obtained inside that later request
(`server/src/lua/bindings.ts:943`). The cited `requests.ts` region tokenizes bias strings, not
descriptors.

Suggested correction: obtain the tool set before assembly, estimate its resolved provider form, and reuse
that exact set for the request. Include the runner and bindings wiring and an end-to-end assembly test.

### AUD-3 — C4: fixing saved content still leaves replay decoding broken

Plan, C4: signatures store the token in `signatures[].content`, "which replay (~113–120) already reads".

Code: the binding returns signature JSON as raw text (`server/src/lua/bindings.ts:846`), assembly passes
it unchanged into `multimodals[].base64` (`server/src/prompt/assemble.ts:1794`), and replay base64-decodes
it before `JSON.parse` (`server/src/llm/google.ts:114`).

Suggested correction: make the payload encoding and the replay decoding agree. Test saving a signature,
loading it through assembly, and replaying it on a second request.

### AUD-4 — F1: changing the loader cannot repair cached `/sw/img` results

Plan, F1: the controller check in `loadFileSrc`; _Done_: "a cached `/sw/img` entry on a page without a
controller yields a `blob:` URL".

Code: `getFileSrc` returns an existing source promise without calling the loader
(`src/ts/globalApi.svelte.ts:316`); the parser returns its own cached strings
(`src/ts/parser/parser.svelte.ts:484`). A controller change clears neither cache (`src/ts/bootstrap.ts:374`).

Suggested correction: specify invalidation or revalidation at both layers. Test controller loss after the
URL was cached.

### AUD-5 — F3: the proposed retention bound conflicts with replay

Plan, F3: "decode each asset once into bytes under `saveAssets`'s byte cap", with retention of "one asset
plus the queue's cap".

Code: loaders must reproduce their bytes and stay retained through completion
(`src/ts/storage/assetQueue.ts:71`); completion repair calls them again (`assetQueue.ts:480`), and the
card hand-off keeps and calls them again (`src/ts/characterCards.ts:110`). Capturing decoded bytes
retains every asset instead of every base64 string. The queue cap also excludes in-flight loads and
writes and admits an oversized item (`assetQueue.ts:238`).

Suggested correction: specify a re-readable backing source or redesign the replay and hand-off
retention, and state the memory criterion over every retained load, write, and replay.

### AUD-6 — F10: the proposed re-read does not close the race

Plan, F10: re-read the opt-out flag immediately before `ensureSubscribed`; a disable "between tab A's
re-read and subscribe leaves no subscription".

Code: the re-read is already inside `serial` (`src/ts/network/pushNotifications.ts:468`). With Web Locks,
a disable is already serialized behind the reconcile. Without them `serial` is module-local
(`pushNotifications.ts:206`), and `ensureSubscribed` awaits several times before subscribing
(`pushNotifications.ts:353`), so tab B can disable during those awaits.

Suggested correction: specify post-await checks and cleanup around the subscription, or record a
Limitation for the fallback without Web Locks.

### AUD-7 — G2: the literal include pattern finds no inputs

Plan, G2: add `e2e/tsconfig.json` "with `e2e/**/*.ts`".

Code: TypeScript resolves `include` relative to the declaring config's directory
(`node_modules/typescript/lib/typescript.js:43808`); parsing that config finds zero inputs
(`e2e/e2e/**/*.ts`).

Suggested correction: `include: ["**/*.ts"]` in that config. The `paths` mapping works with the
inherited root `baseUrl`.

### AUD-8 — G2: the proposed narrowing guard already exists and is not enough

Plan, G2: fix the narrowing at `e2e/multiClient.spec.ts` "with the `kind === "chatOrder"` guard".

Code: that guard exists at `e2e/multiClient.spec.ts:396`; it cannot exclude `ResourceConflict`, whose
`kind` is `string` (`shared/resources.ts:133`).

Suggested correction: use the existing `isChatOrderConflict` predicate (`shared/resources.ts:182`).

## P2

### AUD-9 — A2: the command host has no access to the history view

Plan, A2: "Resolve the three commands through the same history-view helper".

Code: `CommandHost` (`server/src/prompt/commands.ts:7`) carries no `JobScope` and no history accessor; it
is built in `server/src/jobs/runSetup.ts:422`, outside the slice's named files.

Suggested correction: add a host callback wired to `scopeHistoryMessages(scope, chat)` and list
`runSetup.ts` in the slice. The write fences stay.

### AUD-10 — B5: keepalive does not cover the asynchronous authentication before dispatch

Plan, B5: a `pagehide` listener "sends the cancel with `keepalive`"; closing the tab frees the slot
before the TTL.

Code: `cancelRealmImport` (`src/ts/storage/realmImportClient.ts:50`) calls `authFetch`, which awaits
authentication and signing before `fetch` (`src/ts/storage/serverAuth.ts:196`). The existing unload
transport prepares authentication ahead because `pagehide` cannot wait for signing
(`src/ts/storage/resourceClient.ts:461`).

Suggested correction: use the prepared-token, direct-keepalive pattern and keep the TTL as the fallback.
The retry premise holds: busy and maintenance refusals come before the token is consumed
(`server/src/http/fileImport.ts:227`).

### AUD-11 — C1: the loop guard does not produce the promised failure

Plan, C1: guarding `formated.length` makes an empty or all-system prompt "return a normal failure".

Code: after the scan, `reformater` restores the collected system prompt (`server/src/llm/request.ts:351`)
and the request is dispatched normally (`request.ts:575`); the tab copy does the same
(`src/ts/process/request/request.ts:642`).

Suggested correction: specify an explicit refusal, or change _Done_ to normal adapter handling without a
formatter `TypeError`.

### AUD-12 — C4 and Q7: the accepted answer claims a UI setting that does not exist

Plan, Q7: "the setting exists in the UI".

Code: `saveSignatures` is persisted with a `false` default (`shared/sections.ts:89`,
`server/src/data/normalize/providers.ts:49`), but no UI control, settings registry entry, or language
string binds it; the nearby controls are in `src/lib/Setting/Pages/ModelSettings.svelte:63`.

Suggested correction: justify honoring the persisted value, or add a UI control to the slice.

### AUD-13 — C5: a missing follow-up header does not return the body

Plan, C5: default both `Content-Type` reads so "the unsupported-response path returns the body".

Code: the initial response returns its body (`server/src/llm/openAI/requests.ts:681`); the tool
follow-up retries, alerts generically, and closes the stream (`requests.ts:1321`).

Suggested correction: scope the body-text criterion to the initial response, or specify the follow-up's
failure and body propagation.

### AUD-14 — D2: the named driver does not exercise snapshot accounting

Plan, D2: run `util/playwright/measureTransformLua.mjs` on a 2,000-message chat and record the snapshot
charge and capacity.

Code: the driver fixes its fixture at 200 messages (`util/playwright/measureTransformLua.mjs:31`),
measures timing, and sends no `handlers` (`measureTransformLua.mjs:177`); snapshots are charged only when
`handlers` is present (`server/src/prompt/transform.ts:824`).

Suggested correction: extend the fixture, exercise the continuation path, and expose the scope and target
charges before the constant rule applies.

### AUD-15 — D3: the client transport would discard the new code

Plan, D3: the older-copies refusal carries a stable `code`, mapped in `ServerRequestHistory`.

Code: the refusal starts in `server/src/diagnostics/share.ts:125`, the route forwards it
(`server/src/routes/requestHistory.ts:171`), and the client parses only the error text and status
(`src/ts/network/requestHistory.ts:41`).

Suggested correction: include the share outcome type and the client transport; keep the code in
`RequestHistoryError` before the component maps it.

### AUD-16 — E4: the requested profiling needs instrumentation the driver lacks

Plan, E4: "a heap snapshot and the renderer's `VmHWM` after each page".

Code: `util/playwright/measureRenderWork.mjs:577` samples around the whole export and reads the heap
afterwards; it takes no heap snapshot and no per-page sample.

Suggested correction: add that instrumentation to the slice, or name a separate profiling procedure.

### AUD-17 — E4: the rule and _Done_ disagree

Plan, E4: the rule allows the audit to say "by how much it misses and why"; _Done_ requires the bound.

Code: page and row canvases are already released explicitly (`src/lib/ChatScreens/screenshotExport.ts:7`).

Suggested correction: decide whether a measured, explained miss completes the slice and say it the same
way in both sentences.

### AUD-18 — F1: parser read failures do not enter the five-second recovery loop

Plan, F1: a rejecting read is retried by `displayTransformRecovery` "after 5 s".

Code: parser exceptions get local retries after 250 ms and 1 s (`src/lib/ChatScreens/ChatBody.svelte:454`);
the five-second rounds belong to reported `editdisplay` failures
(`src/ts/parser/displayTransformRecovery.svelte.ts:5`).

Suggested correction: use the local retry contract, or connect exhausted asset-read failures to the
longer loop explicitly.

### AUD-19 — F7: paging changes invalid-index behavior

Plan, F7: resolve the index through `chatMemberPage(chaId, i, i + 1)`.

Code: `chatMemberPage` (`src/ts/storage/chatStore.svelte.ts:1448`) uses `slice`, which truncates `1.5` to
1; today `1.5` resolves no chat (`src/ts/plugins/apiV3/v3.svelte.ts:2605`, setter at `v3.svelte.ts:2718`).

Suggested correction: require a nonnegative integer before paging.

### AUD-20 — F7: a caller pre-check leaves the quadratic record scan

Plan, F7: `requireNewId` "gains a batch form or the caller pre-checks".

Code: every `insertCharacterRecord` (`src/ts/storage/records.svelte.ts:3212`) still runs `requireNewId`'s
`.some` (`records.svelte.ts:3120`); a caller's `Set` does not bypass it.

Suggested correction: require a batch insertion path that carries the checked uniqueness through that
boundary, plus one order repair; count the scans in the test.

### AUD-21 — F10: the JWT rejection is 400, not 401

Plan, F10: "a 429, 401 and 413 from `/api/push/*` carry `Cache-Control: no-store`".

Code: ordinary JWT failures answer 400 (`server/src/routes/auth.ts:21`), as the push test asserts
(`server/src/tests/push.test.ts:1265`).

Suggested correction: 429, 400, and 413.

### AUD-22 — H1: `ChannelChunk` is no longer only cumulative

Plan, H1: "`ChannelChunk` stays cumulative".

Code: `shared/jobs.ts:873` defines sequenced appends, `server/src/jobs/channel.ts:760` negotiates them,
and `src/ts/network/jobChannel.ts:1087` sends suffixes with recovery snapshots.

Suggested correction: close the cumulative-transport bullet as settled, or record only the remaining
snapshot and legacy behavior.

## P3

### AUD-23 — A5: which row is 4 MiB (applied)

Plan, A5: "a 4 MiB changed row that takes the whole-row patch hashes nothing".

Code: whole rows count toward the cap (`server/src/data/chatStore.ts:1969`), which is 64 KiB
(`shared/resources.ts:540`); a 4 MiB final row cannot take that form.

Correction applied: a 4 MiB old row shrunk to a small final row.

### AUD-24 — E2: the mount inventory is incomplete (applied)

Plan, E2: `DefaultChatScreen.drafts.test.ts` is "the only mount".

Code: `src/ts/process/rerollCandidates.test.ts:154` also mounts it, and the no-reference criterion reaches
`src/lib/ChatScreens/Chat.settledRender.svelte.test.ts:629`.

Correction applied: the drafts test is the chosen harness, and the prop-removal test files are named.

### AUD-25 — E4: the cited cache source does not exist (applied)

Plan, E4: "the per-row captures in `src/ts/screenshotCaptureCache.ts`".

Code: no such source file; `src/ts/screenshotCaptureCache.test.ts:10` tests html-to-image URL caching,
and capture and composition live under `src/lib/ChatScreens/`.

Correction applied: the inventory names the capture code under `src/lib/ChatScreens/`.

### AUD-26 — F8: startup wording and guide deletion targets are stale

Plan, F8: register the instance after `host.run` "resolves"; "Delete the `plugin-sandbox.md` hazard
sentences these replace".

Code: `host.run` is synchronous (`src/ts/plugins/apiV3/factory.ts:946`). The guide's unload-window issue
(`docs/structure/plugin-sandbox.md:289`) and deferred-reload limitation (`plugin-sandbox.md:297`) stay
true, and the guide has no failed-start or unsignalled-fetch sentence.

Suggested correction: "returns"; terminate a partly started host when `run` throws; update the abort
invariant without deleting the unrelated hazards.

### AUD-27 — F9: the error reference and the import test name different boundaries

Plan, F9: refuse with "the same error class the server's `patchMessage` check uses"; test the import in
`src/ts/characterCardsImport.test.ts`.

Code: the cited client check throws a plain `Error` (`src/ts/storage/chatStore.svelte.ts:3789`); the
server uses `ResourceValidationError` (`server/src/data/chatStore.ts:899`). JSON chat import runs through
`src/ts/characters.ts:530`, covered by `src/ts/charactersImportChat.test.ts:11`.

Suggested correction: state the client error contract and test in the chat-import suite.

### AUD-28 — H1: closing the duplicate-plugin entry leaves a dangling guide link

Plan, H1: close "Duplicate plugin names can share a popup editor target" because the guide carries it.

Code: `docs/structure/plugin-sandbox.md:271` links to the research heading H1 deletes.

Suggested correction: keep the conditions in the guide and remove or replace the link.

### AUD-29 — Order: unlisted source and test overlaps

Plan, Order: "Every slice is independent of the others' code unless listed here."

| Slices               | Shared file                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1, A4               | `server/src/prompt/assemble.ts:1904`; `server/src/tests/assemble.test.ts:396`                                   |
| A1, A2               | `server/src/tests/triggerRuntime.test.ts:310`                                                                   |
| A2, E1               | `server/src/prompt/commands.ts:218`; `commandExecutor.test.ts` if A2 takes that alternative                     |
| A3, G4               | `server/src/tests/hypaV3Parts.test.ts:1366`                                                                     |
| A4, A5               | `shared/contextReport.ts:31`                                                                                    |
| A4, C4               | `server/src/tests/llmRequests.test.ts:1221`                                                                     |
| A4, F4               | the meter label in `src/lang/en.ts:1870` (and `ko.ts`)                                                          |
| B2, B3               | `server/src/tests/upstreamImportCharacters.test.ts:729`                                                         |
| B6, F7               | `src/ts/storage/records.svelte.ts:1494`, for F7's batch insertion                                               |
| C1, C4               | `server/src/llm/request.ts:271`                                                                                 |
| C3, C5               | `server/src/llm/openAI/requests.ts:241`                                                                         |
| C1 to C6, every pair | `server/src/tests/llmProviderAdapters.test.ts:539`                                                              |
| C4, C5               | `server/src/tests/llmStreamParsing.test.ts:255`                                                                 |
| A1, G4               | `server/src/tests/transform.test.ts:225`                                                                        |
| D2, G4               | `server/src/tests/transformService.test.ts:566`, and `server/src/prompt/transform.ts:51` if D2 raises the limit |
| F3, F9               | `src/ts/characterCardsImport.test.ts:6`, gone with AUD-27's correction                                          |

Suggested correction: declare these groups and serialize them. Test files a slice only runs do not count.

### AUD-30 — Order: unlisted guide overlaps

Plan, Order, Guides: its editor lists omit these pairs implied by the slices' owning guides.

| Guide                     | Pairs              |
| ------------------------- | ------------------ |
| `memory.md`               | A1, A3             |
| `chat-pipeline.md`        | A2, E1             |
| `server-generation.md`    | D2 with A1, A2, A4 |
| `llm-requests.md`         | A4 with C1 to C6   |
| `global-api.md`           | A5, F1, F5         |
| `self-host-server.md`     | B1, F10            |
| `persistence.md`          | B4, B6, F7         |
| `plugin-sandbox.md`       | B6 with F7, F8     |
| `cbs-rendering.md`        | D2, F4, F9         |
| `settings-i18n.md`        | F4, F6             |
| `build-test-platforms.md` | G1, G2             |
| `test-harness.md`         | G2, G3, G4         |

Suggested correction: add these to Order, and drop E1 from the `ui-theming.md` list (its slice names
`chat-pipeline.md`).

## unverified

### AUD-31 — G4: a microtask drain as the replacement boundary

Plan, G4: replace the `realSetTimeout(0)` flush "with an awaited microtask drain".

Code: `src/ts/process/serverCommands.test.ts:223` gives a full event-loop turn after advancing fake
timers; whether every caller needs only microtasks was not settled.

Suggested correction: name the awaited condition and use a latch, or check the drain against every
affected case.

### AUD-32 — Order: the runner's default concurrency

Plan, Order, Sessions: "Three sessions at a time is the runner's default."

Evidence: nothing in the repository defines the runner's default.

Suggested correction: state concurrency three as this plan's own choice.

## Re-check list

- `patchMessage` closes an open generation fence: confirmed, `server/src/data/chatStore.ts:2532`
  (closure at `chatStore.ts:1789`). No slice contradicts it.
- Feed rows are measured whole against `MAX_FEED_PATCH_BYTES`: confirmed, `chatStore.ts:1969` (whole
  manifest at `chatStore.ts:1910`). A5 keeps it with AUD-23's wording.
- `STORE_TABLES_SQL` runs only on a fresh database: confirmed, `server/src/data/resourceStore.ts:3825`
  (`user_version === 0`); the staging use creates a new exclusive file (`resourceStore.ts:792`).
- `sendText` counts any open socket as a delivery: confirmed with a qualification: it ORs the results of
  eligible sockets (`server/src/jobs/generationJobs.ts:1017`); a closed, over-cap, or throwing send
  returns false (`generationJobs.ts:1032`). It does not prove remote receipt.
