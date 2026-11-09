# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, and the seventeenth (the Found Issues Decisions run) on 2026-11-09; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (3)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (3)
- [Server routes and resource store](#server-routes-and-resource-store) (5)
- [LLM requests and providers](#llm-requests-and-providers) (9)
- [Request history and diagnostics](#request-history-and-diagnostics) (2)
- [Display transform](#display-transform) (3)
- [Chat screen and input](#chat-screen-and-input) (4)
- [Client and plugins](#client-and-plugins) (17)
- [Build, drivers, and e2e](#build-drivers-and-e2e) (8)

## Chat store, sync, and change feeds

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

### Feed row text diffs hash the whole base per candidate

`server/src/data/chatStore.ts` `chatRowDiff` (~751–780) calls `textHash(before.data)` for every row whose text changed while `chatFeedChange` (~1912–1925) builds body candidates, so a candidate the size choice later rejects (a whole-row `patch` under 8 KiB, the 64 KiB cap) still pays the hash; the tab hashes its held text once per applied diff (`stagedRowDiffs` in `src/ts/storage/chatStore.svelte.ts`). Measured by the A5 challenger of the Chat Store and Structured Memory Sweep (2026-11-06): about 2.3 ms per MiB on warm Node.

**Why it matters:** only multi-MiB messages make it visible.
**Suggested handling:** if feed cost on huge rows is reported, add `base` only after the row delta fits (its encoded size is fixed, about 45 bytes), or skip it when the whole-row patch wins.

### Two more cyrb53 copies beside `shared/textHash.ts`

`shared/notifications.ts` (~117, the notification tag) and `shared/contextReport.ts` (~517) each carry a private base-36 cyrb53. The sweep's A5 added the shared hex helper in `shared/textHash.ts`. Their outputs must not change (tags, report keys), so a merge needs a radix option on the shared core. Found 2026-11-06.

**Why it matters:** three copies of one hash invite drift; cleanup only.
**Suggested handling:** fold them into `shared/textHash.ts` when one of those files is touched anyway.

## Server jobs and prompt assembly

### Asset-scale transport and job leftovers

Left open by the 2026-10-14 to 2026-10-20 chat-render leak, 100k-asset traffic, chatPatch and heap-growth work (the archived Audit Findings plan, `git show e1aa33150:docs/plan/audit-findings-perf.md`, and the Heap Memory plan, `git show 639ba5b2e:docs/plan/heap-memory.md`; their main findings were fixed). Kept in memory until 2026-11-08 and re-checked by identifier that day, not re-measured. The client half is "Asset-scale client leftovers" under Client and plugins.

- Transport: `plugins`, `loreBook` and `globalscript` (no item ids) and creates travel whole; meta goes whole when any field changes; there is no HTTP or WebSocket compression (measured and deferred in slice 3c); the provider `ChannelChunk` (`shared/jobs.ts`) stays cumulative; job owners get whole `resource` events from `emitRecords` (`server/src/jobs/chatResult.ts`); a never-settling `flushResources` (`src/ts/storage/resourceSync.svelte.ts`) keeps one recovery closure per follow. The whole-chat hydration was narrowed by the Incremental Chat Transport run (2026-11-05): a socket that advertised `hydration=patch` gets no chat from `hydrateAll` (`server/src/jobs/generationJobs.ts` ~526); other sockets still get the chat whole.
- Jobs: every job parses the whole modules record and every section and preset; a deleted speaker id is looked up again per `refreshChat`; Lua `setChatVar` (`server/src/lua/runtime.ts` ~376) reparses the character twice.
- The chatPatch transport was never checked in a real browser.

**Why it matters:** traffic and parse work grow with the collection size on every job, not with the change.
**Suggested handling:** measure before changing (slice 3c's numbers are the baseline); the rejected designs are in the plans' Landed notes.

### HypaV3 deferred summary leftovers

Accepted when `deferStored` and `lookaheadHeadroomRatio` landed (2026-10-27, `server/src/prompt/memory/hypav3.ts`); the owner chose "document, don't change" for the first two. Kept in memory until 2026-11-08; identifiers re-checked that day. The guide (memory.md, Deferred stored summaries) says only that the replay is approximate.

- A lookahead window cut at the protected tail (or an edited or merged summary) differs from the ordinary plan's window; the replay takes the stored window whole, up to one window early.
- A stored summary reaching into a grown `queryChatCount` tail is taken when the planner would otherwise re-summarize (legacy and original Hypa always use every stored summary).
- The replay uses the current rest-of-prompt size for past lengths, so a lore swing can move summaries.

**Why it matters:** prepared summaries can replace messages earlier than vanilla Hypa would (the user saw about 15% early before the fix round).
**Suggested handling:** accepted; check these before adding replay rules, and record any change as an owner decision in memory.md Known Hazards.

### Deferred lore behaviors

Kept as-is at Phase 5 Stop B (2026-10-02) for parity with the browser path during the server move; the owner wants them raised when lore activation is next reworked. Kept in memory until 2026-11-08; identifiers re-checked that day. Tests still pin both.

- Lore regex keys that contain a comma (`/a{1,2}/`) are split on every comma before the `/pattern/flags` parse (`shared/lore/activation.ts` ~630 `key.split(",")`, `secondkey` ~636), so a malformed key ends its query.
- A bound persona's embedded module resolves only if a module with its id is in `db.modules` (pinned in `src/ts/process/lorebook.svelte.test.ts` ~230).

**Why it matters:** a regex key with a quantifier count never matches, and a persona's module lore stays silent unless the module is installed separately.
**Suggested handling:** accepted for now; a fix changes activation parity, so plan it with the next lore rework and update the pinning tests in the same change.

## Server routes and resource store

### The change log's bound is a row count, not 4 MB

The `changes` table in `resources.sqlite` (Incremental Chat Transport D5, `server/src/data/resourceStore.ts`, pruned by `pruneChanges` ~1020) keeps the newest 20,000 rows. The plan's Q1 and D5 text ("a row is under 200 bytes: 4 MB at most", "40 snapshots hold up to about 160 MB of logs", cross-plan X8) understates the worst case: ids may be 512 UTF-16 units (the id validator in `resourceStore.ts`, chat ids in `server/src/data/chatStore.ts`), a 20,000-row probe with such ids made an 82 MB database (2026-11-05, Slice 3), and DELETE-based pruning never shrinks the file. Whole-file snapshots (`backupTo`) and version-2 downloadable backups (`server/src/routes/backups.ts`, which strips `llmSecrets` and vacuums) carry it. Found by Slice 3's challenge.

**Why it matters:** with typical UUID ids the log is a few MB, but the Asset Lifecycle snapshot budget counts 40 copies of it at a byte size the code does not bound.

**Suggested handling:** size snapshot storage as rows × id length; add a VACUUM or a byte bound if a real store comes near it.

### Lua image shortcuts reuse an asset key without a claim

`isImageInlay` in `server/src/lua/bindings.ts` (~774, used by `usableImage` for `getCharacterImageMain` / `getPersonaImageMain`) checks the inlay's media with `storageFileExists` (an unlocked `lstat`), and the existing-image shortcut then hands out the marker. The Invariants of `docs/structure/self-host-server.md` say every server reuse of an asset key goes through `claimAssetKey`. Low risk today: an existing inlay record keeps its asset in the sweep's re-mark, and A1 (inlay-id claims) protects the record itself, so the file cannot be a deletion candidate while the record exists. Found in the Implementation Audit Fixes run (2026-11-05, slice A1).

**Why it matters:** a guide invariant with one known exception; a later sweep change could make it a real race.
**Suggested handling:** if `isImageInlay` is touched again, use `claimAssetKey(savePath, meta.asset, { verify })` and keep the post-await fence.

### The inlay recognizer is quadratic on unterminated openings

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a string with thousands of `{{inlay::` openings and no terminator, and ordinary text has one or a few. `recognize` in `server/src/data/assetLifecycle.ts` (~124) searches for a closing `}}` separately from each opening, so `"{{inlay::".repeat(n)` costs about n² (the audit measured 0.9 s at 144,000 bytes). The SQL prefilter admits such a value, and both the chunked scan and the deletion recheck run it in one synchronous turn. Source: [AL5](../manual-audit/archive/asset-lifecycle-code-audit-2026-11-05.md#al5--malformed-inlay-text-makes-the-server-scanner-quadratic).

**Why it matters:** one stored string of incomplete markers can block the server's event loop during a scan or a sweep.
**Suggested handling:** a linear recognizer is a small change if `recognize` is touched: match the three prefixes and their terminators in one pass, and stop when the remaining suffix has no terminator, without truncating real references.

### A custom-key asset can change during a version-2 export

Excluded by the Implementation Audit Fixes plan (2026-11-05) as an unverified lead; the audit asked for a coordinated export-and-replace reproduction first. A version-2 export (`server/src/routes/backups.ts`) records asset paths and opens them later while streaming; the export hold protects them from lifecycle deletion but not from a custom-key write in `server/src/routes/storage.ts` (the staged `rename`, ~265) replacing the file, so the archive could pair its database copy with later bytes. Verified content-hash keys cannot change this way. Source: [the additional lead](../manual-audit/archive/asset-lifecycle-code-audit-2026-11-05.md#additional-lead--mutable-custom-keys-can-change-during-export).

**Why it matters:** an export taken while a plugin or script rewrites a custom-key asset may not be a consistent snapshot.
**Suggested handling:** pause an export before it opens such an asset, replace the asset through the normal write path, and inspect the archive; then decide what consistency custom keys promise.

### Upstream `.bin` import converts MessagePack-only values without a report

`server/src/data/upstream/risuSave.ts` decodes a legacy (`\x07`–`\x09`) save with msgpackr, so a value can be a `Uint8Array`, a `Date` (timestamp extension), or `undefined`. The converter stores it through `serialize`/`storedValue` (`importRecords.ts`), whose `JSON.stringify` succeeds: binary becomes an index object (`{"0":..}`), a date an ISO string, an `undefined` property disappears and an array hole becomes `null`, with `copied: false` and no report entry. A non-finite top-level number in a settings section is repaired by `plainClone` to `null` and then defaulted (a nested one stays `null`), and the section loop (`importDatabase.ts` ~214–228) ignores `copied`, so that loss is not reported either (characters, chats, and plugin values report `invalid-data`). The realistic holder is `pluginCustomStorage`; upstream's own `Database` fields are JSON-like, and block saves are JSON already. Found 2026-11-07 while comparing with the Fastify fork's MessagePack `undefined` marker fix (its `de5b8214e`); this fork's msgpackr decodes that marker as `undefined`, so it does not arise here.

**Why it matters:** a plugin's binary or dated value comes back changed after an upstream import, with nothing in the report to say so.
**Suggested handling:** have `storedValue`/`storedForm` report a value whose JSON form differs in kind (typed array, `Date`, `Map`/`Set`), and report `copied` in the settings loop.

## LLM requests and providers

### OpenRouter free-model discovery ignores the bound key

With the `risu/free` model, `server/src/llm/openAI/requests.ts` (~251) calls `getFreeOpenRouterModels(arg.ctx)` without the resolved `arg.key`; `server/src/llm/openrouter.ts` (~24) sends `ctx.db.openrouterKey`, while the generation request uses `getOpenAIRequestKey` (~611). A profile bound to a named key discovers models with the flat default key, or with none. This contradicts the llm-requests invariant "Adapters use the resolved key". Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a user with only a named OpenRouter key gets no free model, or one chosen with another key.

**Suggested handling:** pass the resolved key into the discovery call.

### An empty OpenRouter free list throws a TypeError

`getFreeOpenRouterModels` in `server/src/llm/openrouter.ts` (~42–43) reads `[0].id` before `?? ""` applies. Its `catch` turns a network failure, an abort, or a malformed response into an empty list, so any of those, or no free model at all, throws a TypeError that hides the real cause; the function's comment notes the client throws the same way. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** the user sees a TypeError instead of "no free model" or the network error.

**Suggested handling:** optional-chain the index and report an empty result as a failure.

### The OpenAI tool stream wrapper keeps only choice 0

`wrapToolStream` in `server/src/llm/openAI/requests.ts` (~1175, snapshots ~1359) rebuilds every snapshot with key `"0"` only, although `requestOpenAI` sends `body.n` for multi-generation (~636) and `getTranStream` accumulates per-choice keys (~1105). Every streamed response goes through the wrapper (~698), so streamed multi-generation loses the nonzero choices even without tools. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** multi-generation with streaming on yields one candidate.

**Suggested handling:** carry every choice key through the wrapper.

### OpenAI in-band stream errors are ignored

`getTranStream` in `server/src/llm/openAI/requests.ts` (~1101) reads only `event.choices`, so a JSON event carrying an upstream `error` and no `choices` contributes nothing and does not fail the stream; a provider failure can end as an empty or partial success. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a mid-stream provider error looks like a short reply.

**Suggested handling:** surface an `error` payload as a stream failure.

### A missing Content-Type header throws in OpenAI streaming

`requestOpenAI` (~681) and `wrapToolStream` (~1323) in `server/src/llm/openAI/requests.ts` call `.includes` on `headers.get("Content-Type")!`, so a 200 answer without the header throws instead of taking the unsupported-response path that returns the body as a failure. The module header now states this behavior. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a misbehaving proxy produces a TypeError instead of its response text.

**Suggested handling:** default the header to `""`.

### Google thought signatures are never saved on the typed path

`server/src/llm/request.ts` builds the adapter argument (`targ`, ~508) without setting `saveSignatures` from `db.saveSignatures`, while `server/src/llm/google.ts` saves signatures only when `arg.saveSignatures` is set (~635, ~684); replay (~113) reads `db.saveSignatures`. The stored setting therefore has no effect on saving. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** the signature saving setting silently does nothing for Gemini thinking models.

**Suggested handling:** assign it where the adapter argument is built, after checking the tab's former behavior; see the next entry before turning saving on.

### Saved Google signatures replay the wrong content

`server/src/llm/google.ts` (~118) replays a saved signature inlay's `signatures[0].content` as `thoughtSignature`, but the save paths (~692, ~991) store the response part's text or a function description, not the provider's signature token, so replay may fail provider validation once saving works (previous entry). Live streaming tool follow-ups keep the raw token separately. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** fixing the saving entry alone may turn the setting into rejected requests.

**Suggested handling:** store the provider's signature token in the inlay and replay that; fix together with the saving entry.

### A signature-only Google part marks the wrong text

`processDataItem` in `server/src/llm/google.ts` (~696): a buffered part carrying only a signature prepends its inlay marker to the last `rDatas` text without checking that one exists, so it throws when none does and otherwise marks an unrelated earlier part. Only reachable with signature saving on. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** latent until signature saving works (see the two entries above).

**Suggested handling:** keep the marker with a text part of its own, or skip it when no text part exists.

### setObjectValue follows `__proto__` segments

`setObjectValue` in `server/src/llm/shared.ts` (~37, recursion ~45) applies additional-parameter dotted paths and walks inherited properties, so a key `__proto__.x` writes to `Object.prototype` on the server. The input is trusted configuration, so the exposure depends on who can set additional parameters or custom model parameters. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** server-wide prototype pollution if a less trusted user can set those parameters.

**Suggested handling:** reject `__proto__`, `constructor`, and `prototype` segments.

## Request history and diagnostics

### Request history accepted trade-offs

From slices 2–10 of the Request History and Diagnostics plan (2026-10-13..15, archived); all accepted trade-offs or minors, not defects. Kept in memory until 2026-11-03. The decided Limitations (unsynced appends, synchronous shares, redaction reach) are in `diagnostics.md` Known Hazards and are not repeated.

- Capture: a stream capture flushed by an abort, a cancel or a read error is not trimmed for a trailing credential prefix (`Redactor.trimPartial` runs only when the 4 MiB bound cut it, `server/src/llm/requests.ts` ~627) and can end in U+FFFD; an adapter's `addLog` (the Anthropic batch) counts logged text, not wire bytes; exchanges are stored in completion order, not start order.
- Store: an invalid `firstByte`/`completedAt` falls back to `now()`; `setShared` returns the matched count, not the changed count; a failed ROLLBACK closing the store is untested; a missing JWT is a 400, not a 401 (server-wide).
- Viewer (`src/lib/Others/RequestLogs/`): re-expanding a row loads a fresh detail while the list row keeps its old summary until the list reloads; `LogField`'s copy feedback depends on `copyText`'s boolean and its fallback failure was not browser-checked. The viewer, the failure alert's two buttons, the popup's job filter and the Diagnostics panel were never opened in a browser, and no report was pulled over sftp.
- Structured failures: a memory request's failure is `assembly` with no `requestId`; OpenAI Responses turns a streamed error event into answer text, so it gets no code; `APP_PATH` in `server/src/diagnostics/log.ts` (:59) would accept a `node_modules/*/shared/*.ts` frame.
- Journal: `script` events are deferred (swallowed Lua/trigger failures produce no event); symlink checks guard stray entries, not a writer racing in the folder; a failure that `startServer`'s own catch takes is not recorded; there is no global-middleware early-return or >5 s slow-answer `http` test; one failed state write can count two failures.
- Browser collector: no build-membership check on browser frames (an app script rewriting `error.stack` could name an app-shaped file); V8 `at async <url>` frames are dropped (`FRAME` in `shared/diagnostics.ts` ~300); WebKit `[native code]` lines give no frames; folding collapses alternating `hidden`/`visible` within 16 events / 10 min and keeps the first `at`; the SW hooks in `bootstrap.ts` `registerSw` are untested.
- Report and sharing: the server's report check is of shape, not provenance; a report naming a model that later left `BASE_LLM_MODELS` is refused (documented v1 exception); a prune failure after a save is counted but not shown; no boot-time reconciliation of `sharedAt` marks against `shared/` files (files are authoritative, withdrawal idempotent); if `deleteAll` fails after the copies were removed, the marks stay; the older-copy 500 is mapped in the viewer by comparing the server's English message (`requestHistoryShareOlderCopiesRemain`), not a status field; `eventsFor` does not detect pruned day files; the second redaction cannot catch a retired key or an expired Vertex token and leaves out the auxiliary `secrets` section. Never run: the Docker plus chrooted-sftp permission check (only `shared/` readable, not `save/data/`).

Identifiers re-checked 2026-11-03 (`trimPartial`, `APP_PATH`, `FRAME`, `copyText`, `sharedAt`, the English-message mapping); the behaviors were not re-run.

**Why it matters:** a security review of the history folder or the diagnostics report should know which gaps were chosen.
**Suggested handling:** read before such a review; delete items as they settle, and move confirmed ones to `diagnostics.md` or `llm-requests.md` Known Hazards.

### Socket protocol numbers are not in Diagnostics

Both sockets send `proto=1` (Incremental Chat Transport D4, Slice 2). The server records it per socket (`protocols` in `server/src/routes/events.ts` ~72, `socketFlags` in `server/src/jobs/generationJobs.ts` ~811) and logs one `console.info` line per socket (`[Live-update socket] proto=…`, `[Generation socket] proto=…`). D4 says a later plan sets a floor and measures "which clients are below it from the diagnostics", but the Diagnostics schema (`shared/diagnostics.ts`) and `logEvent`'s fields (`server/src/diagnostics/log.ts`) carry no protocol number and neither socket has a recorder. Found by Slice 2 (2026-11-05).

**Why it matters:** a floor decision would have to scrape server console logs; an exported diagnostics report shows nothing.

**Suggested handling:** before any `proto` floor work, add a diagnostics event field and a recorder on both sockets.

## Display transform

### A single combined paragraph is written back as HTML

`src/ts/translator/translator.ts` `translateHTML`, the combineTranslation branch (~617, `node.innerHTML = sentences[0]`): the single-sentence case assigns `getNodetextToSentence`'s decoded text as HTML, while the multi-sentence case uses `textContent`. So `<p>&lt;b&gt;x&lt;/b&gt;</p>` becomes a real `<b>` before translation. Seen while doing the Found Issues Sweep's E3 (2026-11-05), not run in the app; whether a later sanitizer catches injected markup (`<img onerror>`) was not checked. Owner: translation.

**Why it matters:** escaped text can become live markup on the rendered translation path.
**Suggested handling:** confirm the sanitizer order in `ChatBody`, then use `textContent` like the other branch.

### An aborted first transform call can leave its snapshot counted

`src/ts/parser/transformClient.ts` `postOnce` (~521) and `releaseChunkSnapshot` (~682), the per-tab two-call admission: when whole-chunk cancellation aborts the first `/api/transform` fetch before its response headers arrive, `snapshotGone` keeps its initial `true`, so the chunk releases its permit at once. If the server had already stored the snapshot and was sending the answer (its abort link is cut once `transform` returns, `server/src/prompt/transform.ts` ~900), that snapshot stays until its 30 s TTL and still counts toward `MAX_TRANSFORM_SNAPSHOTS_PER_CLIENT` (4), so the next admitted chunk can evict a live one (`SnapshotExpired`, a raw row, one retry round). Accepted as an edge by the Implementation Audit Fixes run's R4 (2026-11-06) to avoid holding a permit 30 s on every ordinary scroll-away abort; server memory-pressure eviction and the global snapshot cap across tabs are not covered either (noted in the module header).

**Why it matters:** heavy scrolling with plugin handlers can show raw rows and a retry round.
**Suggested handling:** if `SnapshotExpired` shows up under heavy scrolling, drop an unclaimed snapshot on the server when its request signal aborted after return, or release by a client-chosen snapshot id.

### A withdrawn forced refresh can leave its replacement on the old cache

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a Re-render whose target is withdrawn while a sibling keeps the chunk alive, and a same-input replacement created before the result lands. In `src/ts/parser/transformClient.ts` the bypass (`noCacheNext`, ~178) is consumed when the operation is created and restored only on withdrawal before dispatch or a whole-chunk cancel (~325); a dispatched target withdrawn from a surviving chunk loses it, so the replacement sends `noCache: false`, cannot join the forced operation, and can read the server's old cache entry (`server/src/prompt/transform.ts` invalidates when processing reaches the forced target, not at admission). Source: [RW3](../manual-audit/archive/render-work-budget-2026-11-05.md#rw3--a-departed-forced-refresh-can-leave-its-replacement-using-the-old-server-cache).

**Why it matters:** a requested Re-render can show the previous cached result after paying for a fresh one.
**Suggested handling:** keep the forced intent until a live consumer receives its result, or let a same-generation replacement join the forced operation, without reviving the bypass for a superseded generation.

## Chat screen and input

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### The screenshot peak grows with the row count

After the paged export (`src/lib/ChatScreens/screenshotExport.ts`), the Render Work Budget comparison run ([audit](../audit/render-work-budget-2026-11-05.md#acceptance-after-slices-14), 2026-11-05) writes 2 / 7 / 25 valid PNG pages for 30 / 150 / 600 rows, but the renderer's `VmHWM` still rises by 607 / 1,478 / 3,987 MiB while one page's RGBA (816 × 16,308) is 50.8 MiB, so the acceptance "peak under one page plus the largest row" is not met. Most of the peak is not the page canvas; what holds it (the per-row captures, `src/ts/screenshotCaptureCache.ts`, or the DOM-to-canvas renderer's clones) was not investigated.

A single row is outside the page budget too: the planner (`src/lib/ChatScreens/screenshotExport.ts` ~79–87) puts a row over `MAX_EXPORT_PIXELS` (64 M pixels) on its own page without reducing its area, as the module header allows, so a row about 2,400 CSS pixels wide and 8,192 tall at DPR 2 allocates a 300 MiB source and a 300 MiB page. The Implementation Audit Fixes plan (2026-11-05) excluded that as an edge case, to be taken with this investigation. Source: [RW4](../manual-audit/archive/render-work-budget-2026-11-05.md#rw4--a-single-oversized-screenshot-row-bypasses-the-page-memory-budget).

**Why it matters:** a 600-row export still costs about 4 GiB of renderer memory, enough to crash a tab on phones.
**Suggested handling:** take a heap snapshot and `VmHWM` per page during a 150-row export to find what scales with rows, then release it per page; for the single row, enforce area before capture with the same scale in planning and capture, or tile it.

### Chat rendering leftovers

Left by the chat rendering perf series (7003e80e9, daf658ba1, 224bc6aae, 2026-10-14) and slice 3f (2ed26dfee, 2026-10-16: per-row effect roots, `far` rows contained, a guarded trim to 150 rows; a windowed list was rejected; details in `git show e1aa33150:docs/plan/audit-findings-perf.md`). Kept in memory until 2026-11-08; the `far` containment observer is at `src/lib/ChatScreens/Chats.svelte` ~553 that day.

- Firefox and Safari were never driven.
- A far row's `position: fixed` or overflowing card content is contained while the row is far.
- Pixel anchoring across far/near toggles was checked only by a manual Chrome script, not a kept test.
- An old row's length-dependent CBS waits for the row's next render (the dormant upstream last-5 rerender was removed; recorded in the guide).

**Why it matters:** the containment changes what a far card can show, and the anchoring has no regression test.
**Suggested handling:** start from this list when picking up chat rendering work; the later chat-open work (newest-first reveal, staged mounting, held rows) is contracted in ui-theming.md.

### ChatBody's modelShortName no longer changes the body

`src/lib/ChatScreens/ChatBody.svelte` `prepareShownBody` (~581) still reads `modelShortName` into its pending memo, and `src/lib/ChatScreens/Chat.svelte` (~1422) still computes it per row from `getModelInfo(...).shortName`. Its only effect on the HTML was `addMetadataToElement` (the watermark), which Found Issues Decisions C1 deleted (2026-11-09), so the prop is now a dead render input. Also cited as dormant in `docs/manual-audit/plan-design-audit-2026-11-04/render-work-budget.md` (~94). Found by the C1 slice session.

**Why it matters:** a model change only misses the pending memo (one extra re-render), and every row pays a `getModelInfo` call for nothing.
**Suggested handling:** drop the prop, its memo key, the `Chat.svelte` computation, and the `modelShortName: ""` lines in the ChatBody and Chat tests (the `ChatBody.svelte.test.ts` model-change case ~720 goes with it).

## Client and plugins

### Stop B leftovers

Left after the Stop B fix commit (30bee445, 2026-10-05) and kept in memory until 2026-11-03; re-checked by identifier that day.

- Capture-phase key listeners still see keys behind the restore notice (`src/lib/Others/TerminalNotice.svelte` calls only `stopPropagation`, :34); a plugin's `document` listener with `capture` is the example.
- `getFileSrc` object URLs: `holdFileSrc` releases only the asset lists' `LazyFileSrc` previews; every plain `getFileSrc` read (parser HTML, chat rows, icons) pins its URL for the page, and every file gets `image/png` (`src/ts/globalApi.svelte.ts` :348); video and audio rely on the `<source type>` the parser writes. The same pinning is the open D2b item of the asset-scale work (parser `fileSrcCache`, inlays `mediaObjectUrls`).
- Load flakes seen only under parallel full suites (load average 28–32 on 2026-10-18/19), each passing alone, that the Found Issues Clearance slice G4 did not reach (it moved the `cbsLimitsHost.test.ts` cases onto scripted clocks; `lore.test.ts`'s worker-timeout case was already `slow`): `src/ts/storage/tests/resourceSyncFieldCache.test.ts`, and the cold `boot()` of the first cases of `chatStore.test.ts` and `resourceSyncChats.test.ts` hitting the 5,000 ms default (a warm-up import in `beforeAll` would remove it). Not re-run since; the whole-suite lock of 2026-10-30 reduces the parallel case.
- `addCharacter` stamps `creation_date` on a re-add (accepted at slice 5b). The first-visit default writes of some settings pages are already in `settings-i18n.md` Known Hazards.

**Why it matters:** the capture gap lets a plugin act behind a blocking notice; the pinned URLs grow with assets rendered; the flakes return whenever suites run in parallel.
**Suggested handling:** mention when working nearby and check the code first; treat the flakes as known unless one fails alone.

### A stray }} ends CBS highlighting

`src/ts/gui/highlight.ts` `simpleCBSHighlightParser` (~358–478): the `}}` branch does `depth--` without a floor. Text such as `}} {{char}}` (a JSON snippet in a prompt or lorebook editor) leaves `depth` at -1; the next `{{` raises it to 0, which `checkHighlight` skips, so `{{char}}` and every later call stay unhighlighted. Writes at index -1 are dropped silently. Found by the Found Issues Sweep's C1 (2026-11-05). Owner: cbs-rendering.

**Why it matters:** editor highlighting disappears for the rest of the text after one stray close pair.
**Suggested handling:** clamp the depth at 0 (ignore an unmatched `}}`).

### Inlay explorer hard-codes two strings

`src/lib/Playground/PlaygroundInlayExplorer.svelte` renders the card `Delete` button label (~250) and the load-more `Loading...` (~258) as literal English, while the rest of the component reads `language.playground.*`. Found by the Found Issues Sweep's J1 (2026-11-05).

**Why it matters:** STRUCTURE.md U2; non-English users see English there.
**Suggested handling:** move both to `language.playground` keys; `PlaygroundInlayExplorer.test.ts` finds the button by the text "Delete", so update that lookup.

### JSON and V3 card imports keep base64 text until the save ends

`saveAssets` (`src/ts/storage/assetQueue.ts` ~268) keeps every canonical item's `load` until its final presence pass. The Implementation Audit Fixes run's A4 (de86f0225, 2026-11-06) made PNG cards from a Blob replay byte ranges, but two import paths in `src/ts/characterCards.ts` still capture the encoded string in that closure: `saveEmbeddedAssets` (~1106, `Buffer.from(value, "base64")`, JSON cards with embedded assets) and V3 `data:` URI assets (~1271, `Buffer.from(b64, "base64")`). Found while landing A4. Owner: assets.

**Why it matters:** a large JSON card keeps all of its assets' base64 text (about 4/3 of the decoded bytes) alive until the whole save finishes.
**Suggested handling:** raise on a JSON or V3 card import memory complaint; the text is a JSON string in hand with no byte range to reread, so a fix drops references from the card object or decodes up front under the queue's byte cap. The PNG stream path keeps the same retention by owner decision (`assets.md` Known Hazards).

### The sandbox bridge drops an own `__proto__` key

Excluded as an edge case by the Implementation Audit Fixes plan (2026-11-05): it needs a plugin to store an object with a key spelled `__proto__`. The bridge copy helpers in `src/ts/plugins/apiV3/factory.ts` (`replaceStreamsWithPorts` and the guest and reconstruction helpers, ~232, ~281, ~825, ~907) rebuild plain objects with `const out = {}` and `out[k] = …`, so an own `__proto__` key sets the copy's prototype and is lost in the structured clone. The storage layer keeps such keys, so direct API tests do not see it. Source: [U1](../manual-audit/archive/plugin-storage-data-api-2026-11-05.md#u1--the-sandbox-drops-an-own-__proto__-field-from-returned-json).

**Why it matters:** a `pluginStorage.getItem` value can come back without a field it was stored with; not prototype pollution.
**Suggested handling:** define own properties (`Object.defineProperty` or a null-prototype object) in every bridge copy helper, and test a round trip through the guest bridge.

### Duplicate plugin names can share a popup editor target

Unconfirmed in the browser. `setPlugins` in `src/ts/storage/collectionStore.svelte.ts` accepts duplicate names. In `src/lib/Setting/Pages/PluginSettings.svelte`, an unkeyed row binds the textarea to `settings.plugins[i].realArg[arg]`, while `popupEditorContext` uses the plugin name and argument key. `TextAreaInput.svelte` checks the initial value, context and context revision before applying the draft.

If another client swaps two same-name plugins with the same key and text while the popup is open, those checks can still match the row now at that index. To verify, apply the draft and inspect which plugin's stored argument changed. Traced on 2026-11-07 while moving the earlier UI guide note to [plugin settings](../structure/plugin-sandbox.md#issues).

### Nested numeric settings can be stored as null

Three writers can leave a nested number field `NaN` or `null`, which the record normalizers do not repair (they check top-level kinds only): `src/lib/Setting/Pages/PluginSettings.svelte` (~291) stores `parseInt` of a radio option's suffix, `NaN` for a non-numeric suffix in plugin metadata; `ImageGenerationSettings.svelte` (~466) stores `Number(params.information_extracted)` from a vibe file without checking it; and `CharConfig.svelte`'s VOICEVOX scale inputs (~1194–1203) bind a `NumberInput` that writes `null` when emptied, which `tts.ts` (~290) sends as is. JSON turns `NaN` into `null`, so all three reload as `null`. Current upstream has the same writers and stores these records as JSON too. Found 2026-11-07.

**Why it matters:** a malformed plugin or vibe file, or an emptied VOICEVOX field, leaves a `null` that the readers pass on (stableDiff.ts falls back with `|| 1`; VOICEVOX gets `null` scales).
**Suggested handling:** validate with `Number.isFinite` at the two parse sites and fall back to the field default for an emptied VOICEVOX input.

### StorageController.owners has no reader

`src/lib/Setting/Pages/Storage/storageController.svelte.ts` (~57) `owners = $derived(...)` sorts every owner on each report, but since the Storage Settings Page run (slice B, 2026-11-07) `StorageOwners.svelte` sorts and caps owners through `Storage/storageUsage.ts` `getTopOwners`. Slice B could not edit the controller (slice C owned it), so the derived stayed. Owner: settings-i18n.

**Why it matters:** a dead sort on every report refresh, and it misleads readers about where the owner list is computed.

**Suggested handling:** remove it after `rg "controller\.owners"` confirms no reader.

### searchTagList never matches the OC tag by name

`searchTagList` in `src/ts/util.ts` (~1045) lowercases the last query segment, then compares it with `tag.value.startsWith(...)` (~1051) and the aliases unchanged. `TagList` has `value: "OC"` (~828), so typing "OC" or "oc" never suggests it; only its alias `original-character` does. The function's comment now states the case behavior. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a tag suggestion silently missing on realistic input; small.

**Suggested handling:** compare against lowercased tag values and aliases.

### replacePlaceholders ignores its name parameter

`replacePlaceholders(msg, name)` in `src/ts/util.ts` (~120) never reads `name`: it replaces the char markers with `selectedCharacter().name`, which throws when nothing is selected. Its two callers in `src/lib/ChatScreens/Suggestion.svelte` (~119, ~133) pass the selected character's name after checking one exists, so the gap is latent. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a future caller rendering another character would get the selected character's name.

**Suggested handling:** use `name` (falling back to the selection), or drop the parameter.

### getCharToken rejects with no selected character

`getCharToken(char?)` in `src/ts/tokenizer.ts` (~317) falls back to `selectedCharacter()`, which returns `undefined` with no selection (`src/ts/storage/characterStore.svelte.ts` ~381); reading `char.type` (~322) then rejects instead of returning zero counts. Its doc comment now states this. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** a caller that runs before a character is selected gets a rejection.

**Suggested handling:** return zero counts when there is no character.

### The source map fetch timeout ends before the body

`translateStackTrace` in `src/ts/sourcemap.ts` (~78) clears its timer as soon as `fetch` resolves with the headers, then awaits `mapRes.json()` (~82) with no timer. A source map whose body stalls keeps the translation pending, and `src/lib/Others/AlertComp.svelte` then never shows the translated trace (it ignores late results, so the output is missing, not wrong). Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** low impact (a debug aid), but the intended 10 s bound does not hold.

**Suggested handling:** clear the timer after the body read.

### selectLoreBookPage stores any number

`selectLoreBookPage` in `src/ts/storage/selection.svelte.ts` (~135) stores and persists any number, while `loadSelection` in the same file (~101) accepts only nonnegative integers, so a bad value lives until a reload resets it to 0. Found in the Module Headers run (2026-11-08) from source reading, unreproduced.

**Why it matters:** low impact (callers pass UI page indexes), but the two paths disagree on what a valid page is.

**Suggested handling:** apply the load check in the setter; low priority.

### Asset-scale client leftovers

The client half of "Asset-scale transport and job leftovers" under Server jobs and prompt assembly. The `getFileSrc` URL pinning is in "Stop B leftovers" and the inlay `mediaObjectUrls` in "Fallback media object URLs outlive the blob cache", so they are not repeated; the plan archive holds the options for the pinning (an avatar hold-release, or a parser placeholder with `fileSrcCache` removed). Kept in memory until 2026-11-08; identifiers re-checked that day, not re-measured.

- `src/ts/parser/parser.svelte.ts` ~482 `fileSrcCache` is an unbounded path-to-src Map (cbs-rendering.md lists it among the parser caches).
- Heap D3: `Batch.previous` held by an `{#await}` closure, about 17 MB after a server modules copy; not fixed.
- The experimental Google translator still translates per stream frame (upstream behavior; `src/ts/translator/translator.ts` ~500).
- A client JSON chat import can carry non-string message `data` (not validated in `prepareMessages`, `src/ts/storage/chatStore.svelte.ts` ~1597) and remount once; the `checkIfAtBottom` layout read remains (`src/lib/ChatScreens/Chats.svelte` ~961).
- Asset UIs: the first filter query after an edit of the field copies the live state once (about 0.3 to 0.6 s at 100k assets).
- The parser's fuzzy asset lookup is untested for owner teardown and very large lists at the parser level.

**Why it matters:** the caches grow with the assets rendered, and the heap item was measured in the tens of megabytes.
**Suggested handling:** confirm the heap items with a snapshot after delete/re-import and module toggles (`util/playwright/measureHeap.mjs`, `measureFileSources.mjs`); re-verify a line before acting.

### Web Push leftovers

Open after the Web Push implementation (e148f7276, 2026-10-13; the archived `docs/plan/web-push.md`) and the Open Bug Fixes slices S1 (3601b04c2) and P1 (34555e412); the VAPID key re-read landed 2026-10-28. Kept in memory until 2026-11-08 and re-checked that day. The real-browser checks (permission, subscription, click routing, Android PWA) went to the user's own checklist on 2026-10-28 and are not listed here; the `MAX_PENDING_SENDS` comment has its own entry ("The push send cap comment says four waiting").

- Cross-tab opt-out race: an explicit disable racing another tab's enable within one reconcile (`src/ts/network/pushNotifications.ts`).
- The enable button may lose user activation before `subscribe()` when it is queued behind a reconcile.
- `public/sw.js` click handling: the `/` route only focuses.
- `navigator.serviceWorker.ready` may be the old worker during an upgrade.
- `no-store` is missing on middleware rejections of `/api/push/*`: the limiter, JWT and body cap in `server/src/routes/push.ts` (~26, ~49) answer before the handler sets it, push is not in `server/src/app.ts`'s no-store families (~810), and the `registerPushRoutes` header comment still promises `no-store` on every answer.
- The P1 detail strings (`language.pushNotifications.*`) exist in en and ko and are English in de, es, vi, cn and zh-Hant.
- Registration dedupe (Deep Audit Fixes slice 5, 2026-10-26): a subscription the server dropped while the browser keeps the same endpoint and keys comes back only at the first sync after 24 h or by off/on; `subscribed` stays true meanwhile and suppresses the tab fallback notice. Accepted.

**Why it matters:** the races can leave a tab's toggle and the server's subscription list disagreeing, and a cached rejection could be replayed by an intermediary.
**Suggested handling:** offer these as the next Web Push round; verify each against the current code first.

### Plugin reload deferral leftovers

Left on purpose by slice P2 of the RisuNest Small Wins plan (ed9d207c5, 2026-10-20; `git show f4c26f27d:docs/plan/risunest-small-wins.md`), which defers a remote plugin reload until the tab is idle, and by its P1 (a293fc574). The D4 decision (a never-settling guest defers remote reloads until a page reload or a local `loadPlugins`) is in plugin-sandbox.md Known Hazards and not repeated. Kept in memory until 2026-11-08; identifiers re-checked that day.

- Work admitted while `loadV3Plugins` unloads the old sandboxes is not fenced: `unloadV3Plugin` (`src/ts/plugins/apiV3/v3.svelte.ts`) splices the instance before awaiting the unload callbacks (up to 1 s), so a job created then lists the hooks registered at that moment; every local `loadPlugins` has the same window. RisuNest fences with `beginUnload`/`invokeUnloadCallback`. A Sol plan review raised it; rejected as pre-existing.
- `executePluginV3` (`v3.svelte.ts` ~3395) pushes the instance before `host.run`; a `run` that throws leaves the instance registered.
- `SandboxHost.terminate` (`src/ts/plugins/apiV3/factory.ts` ~1156) aborts only controllers built from a guest-supplied signal (`ABORT_SIGNAL_REF`, ~720); a `nativeFetch(url)` without one keeps running until it resolves, and only its late body is cancelled. A fix needs a host-side controller per call in the CALL handler.

**Why it matters:** a reload can run a job against a half-unloaded hook list, a failed plugin start stays listed as loaded, and a terminated plugin's fetch keeps the network busy.
**Suggested handling:** pick these up when a change touches plugin reload timing (S1 safe boot uses P2's reload guard) or a bug report does. Related: "A multi-tab plugin removal can bring its deleted data back".

### The plugin remove button's comment predates the owned-write refusal

`src/lib/Setting/Pages/PluginSettings.svelte` remove button (~206): the comment "onUnload can still write; delete only after the local sandbox is gone" predates Found Issues Decisions B1 (2026-11-09), which makes `setOwnedPluginStorageItem` throw for an owner not in `settings.plugins`. The plugin is spliced out of the list before `loadPlugins()`, so its `onUnload` owned writes are now refused; only legacy and custom (`setDatabase`) writes can still land. B1 could not edit the file (B2 owned it in that run). Found by the B1 slice session.

**Why it matters:** a reader may think the order still protects owned keys, or reorder the handler wrongly.
**Suggested handling:** reword the comment when the handler is next touched; the delete-after-unload order still matters for custom keys.

## Build, drivers, and e2e

### checkJobProtocol's first run after a source change fails its SIGKILL case

`util/playwright/checkJobProtocol.mjs`: the first run after a source change failed `sigkill-before-checkpoint` with "waiting for navigation to finish" (the page rebooted about 6 s after the SIGKILL restart); the next two runs passed every case. Likely Vite's dependency-optimization reload of the dev stack. Found 2026-10-29 by the Job Protocol audit's verification; not reproduced.

**Why it matters:** a first run on a fresh tree can report a protocol failure that is the dev server's reload.
**Suggested handling:** if it recurs, have the driver wait for Vite's optimization to settle before the case (`openApp` already answers the prompt again after a reload), or run the dev stack once before the cases.

### check:docs does not measure blockquoted items

`util/docsBudget.mjs` `parseGuide`: `LIST_MARKER` (:54) does not see a list item behind `> `, so `> - <601 characters>` becomes a paragraph, and the length rule skips paragraphs. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: no guide uses a blockquoted list today, but one could hold an over-long item with a passing check. The leaf and file budgets still bound it.
**Suggested handling:** strip a leading `> ` before the marker test if blockquotes appear in the guides.

### check:docs collapses spaces inside a row's code spans

`util/docsBudget.mjs:168` runs `line.replace(/\s+/g, " ")` over a whole table row to drop column padding, which also collapses spaces inside code spans, though Doc Maintenance counts code spans toward the item budget. A row with 601 spaces in a code span measures 9 characters and survives Prettier. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: it needs an unrealistic code span.
**Suggested handling:** collapse padding outside code spans only (`replaceCodeSpans` is in the same file) if a row ever hits it.

### checkServerSend once hit an alert after its mid-stream reload

On 2026-11-05 (Incremental Chat Transport Slice 5, code at `f906c864e`) the first `node util/playwright/checkServerSend.mjs` passed 11 checks, then `openCharacterChat` after the "reload in the middle of a slow stream" step (~340) timed out because a `[data-alert-dialog]` overlay covered the sidebar. The run overlapped a `docker build`; four reruns passed 19/19, two of them logging no alert after the reload, and the base `9bf28c429` passed 19/19. The alert text was not captured. Candidates: the automatic safe-boot notice (the driver does not clear safe-boot attempts) or an error alert from the owner's resync after the reload.

**Why it matters:** if it recurs it may be a real owner-reload problem, not harness noise.

**Suggested handling:** if it shows again, print the dialog text before `openCharacterChat` to tell the two apart; consider clearing safe-boot attempts in the driver.

### docs:contracts crashes on EPIPE under head

`pnpm --silent docs:contracts <file> | head -3` prints the first lines, then Node's `Error: write EPIPE` / "Unhandled 'error' event" stack from `util/docsContracts.mjs`'s command-line block, which writes to `process.stdout` with no `error` handler. Other `util/docs*.mjs` tools may share it. Seen 2026-11-05.

**Why it matters:** agents pipe these tools into `head`; the stack looks like a tool failure and costs a second call.
**Suggested handling:** ignore `EPIPE` on `process.stdout` in the command-line blocks.

### pnpm check does not type-check e2e specs

`pnpm check` (svelte-check over `tsconfig.json`, then the server's `tsc`) never sees `e2e/`: `tsconfig.json` `include` covers `src/`, `shared/` and `public/sw.js` only, there is no e2e tsconfig, and Playwright transpiles without type checks. An ad-hoc `tsc` over `e2e/` (a temporary tsconfig extending the root one) reported a real TS2339 at `e2e/multiClient.spec.ts` ~396 (`characterId` on `ResourceConflict | ChatOrderConflict`, which needs the `kind === "chatOrder"` narrowing to apply); the other errors were missing node types and absolute `/src/...` dynamic imports. Found 2026-11-06 by Multi-Client Data Safety Checks slice B.

**Why it matters:** type errors in specs and harnesses ship silently, and briefs that count `pnpm check` as type verification for an e2e-only change are wrong.
**Suggested handling:** add an e2e tsconfig (node and Playwright types, a `/src/*` path mapping) and wire it into `pnpm check`; fix the `multiClient.spec.ts` narrowing in the same change.

### Automatic browser spec selection misses extensionless imports

Both multi-client specs import `./multiClient` and `./fixtures`. In `util/agentE2e.mjs`, `staticImports` records those literal paths, while Git reports `e2e/multiClient.ts` and `e2e/fixtures.ts`. Reproduced on 2026-11-07 by passing each changed path separately to `selectSpecs` with `loadSpecs(".")` and `repositoryFiles(".")`. Each result had an empty `selected` list and put the helper in `unnamed`.

A helper-only change can therefore miss its browser tests during automatic selection. Name the affected specs explicitly until the selector resolves extensionless imports to their on-disk paths. All current specs import `./fixtures`, while only the two multi-client specs import `./multiClient`. The [test harness guide](../structure/test-harness.md#browser-specs) gives both commands.

### An ignored path can hide a broken sibling in a guide

In `util/docsBudget.mjs`, `pathProblem` returns success for the whole span as soon as a missing brace alternative matches a Git ignore rule. Reproduced on 2026-11-07 with `measureDocs` and `checkDocs` in a temporary Git repository containing an empty `src/` and a `*.local` ignore rule. The span `src/{draft.local,missing.ts}` produced no finding. Reversing the alternatives reported the missing `src/missing.ts`.

A guide can pass the path check while pointing an agent at a missing source file. Check the remaining alternatives after accepting an ignored path.
