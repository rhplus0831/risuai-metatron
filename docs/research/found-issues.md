# Issues Found During Work

Bugs, latent defects, stale docs and comments, and test flakes that agent sessions noticed while working on something else, between 2026-10-14 and 2026-10-24. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. They lived in the agents' project memory until 2026-10-24 and were moved here unchanged apart from link wording.

These are notes, not verified reports. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24. Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (13)
- [Generation jobs, channels, and providers](#generation-jobs-channels-and-providers) (10)
- [Lorebooks and modules](#lorebooks-and-modules) (1)
- [Chat screen](#chat-screen) (1)
- [Alerts, dialogs, keys, and settings controls](#alerts-dialogs-keys-and-settings-controls) (4)
- [Notifications](#notifications) (2)
- [Assets, MIME types, and the service worker](#assets-mime-types-and-the-service-worker) (1)
- [Backup import](#backup-import) (1)
- [Tests and tooling](#tests-and-tooling) (1)

## Chat store, sync, and change feeds

### coalesce lacks generation guards

Found 2026-10-18 during slice 1a of docs/plan/data-loss-concurrency.md (Sol plan review).
`src/ts/storage/chatStore.svelte.ts` `coalesce` (:833, :837, :841 on 2026-10-21): the existing folds
setText+setText, setMessage+setText, setMessage+setMessage keep `last.generation` and take `next`'s
content without checking either op's `generation`. Folding a manual write into a generation write
makes it fence-checked (it can be `ignored`) instead of closing the fence; the reverse drops the
checkpoint identity. Slice 1a's new `patchMessage` folds do check generations.

**Why it matters:** latent: since the server-job cutover the tab never queues generation-carrying ops, so no
pair mixes today.
**Suggested handling:** if the tab ever queues generation writes again (or when touching `coalesce` in
1b), add `!last.generation && !next.generation` guards to those three folds.

Rechecked 2026-10-21 against the code: still present.

### ChangeFeed reentrant publish

`server/src/data/changeFeed.ts` `publish` loops listeners synchronously. A listener that writes to the store (supported: `server/src/tests/changeFeed.test.ts` "publishes a put's create and update ... a listener reads and writes") publishes its own event recursively, so listeners after it receive the inner (newer) event before the outer one. Clients then see revisions out of order on the feed; for slice 2b's lock frames, an inner release could precede the outer lock frame. Today no production listener writes (only `routes/events.ts`). Raised by Sol in the slice 2b plan review (2026-10-19), not fixed.

**Why it matters:** feed order is assumed FIFO per socket by the client (2b's feed locks rely on it).
**Suggested handling:** queue publications made during a dispatch and drain them after the outer loop, if a writing listener is ever added..

Rechecked 2026-10-21 against the code: still present.

### Feed lock character predicate

Slice 2b (data-loss concurrency plan, 2026-10-19) keeps `isCharacterGenerating` in `src/ts/storage/chatStore.svelte.ts` counting only this tab's job locks (`serverGenerations`), not the change feed's `feedLocks`, because `src/ts/storage/resourceSync.svelte.ts:2349` `hydrateCharacters` uses it to skip generating characters and a feed lock there kept `flushResources` failing ("Could not save every change") for the whole generation. So an observer tab can still trash/delete/replace a character (characters.ts:806, characterStore.svelte.ts:314/349/364, plugin v3.svelte.ts:890/969) whose chat another device generates; the server refuses with 409 `generating` (today's behaviour).

**Why it matters:** the local guard would avoid the refused membership change and its retry.
**Suggested handling:** add an owner-only character predicate for `hydrateCharacters` (resourceSync.svelte.ts, sequence B file) and let `isCharacterGenerating` count feed locks; do it when resourceSync is free.

Rechecked 2026-10-21 against the code: still present.

### Feed lock windows

Slice 2b's feed locks (`feedLocks`, `noteRemoteStreaming`, `replaceFeedLocks`, `dropFeedLocksOf` in `src/ts/storage/chatStore.svelte.ts`) are advisory. A tab shows a generating reply unlocked (2a's `dropLockedEdits` then catches an edit) before the job's first write frame (the job owns no message before its `begin`, so the `hello` snapshot cannot list it either), and after an adopted whole read at a newer revision than the lock's frame or snapshot (another writer changed the chat), until the job's next write re-announces the lock: every 3 s while streaming (`CHECKPOINT_INTERVAL_MS`), but a job waiting on its provider or a callback can write nothing for its whole remaining life. Since 2026-10-24 every `hello` carries the server's lock snapshot with each chat's sampled revision, so a reconnect no longer drops live locks; the server still sends no lock snapshot with a chat read.

**Why it matters:** these are the remaining paths for A4 (edit over the generating reply) and D7-style surprises.
**Suggested handling:** a lock snapshot with chat reads (owner decision 2026-10-24: only if needed), or let authoritative lock lists alone end feed locks instead of a newer whole read (changes the release policy; audit the collection-removal paths, which drop revisions without clearing feed locks). Related: [Feed lock character predicate](#feed-lock-character-predicate).

### Duplicate group feed ref

`server/src/data/resourceStore.ts` `applyChanges` calls `recordChat` for every `chatOutcome.results` entry (:855 on 2026-10-21), including a group `chatStore.ts` `applyGroup` answered from `chatGroups` (`rememberedResult`, `applied: 0`, revision as of that group). The feed then carries an old revision ref: tabs at or past it drop it, a tab holding an older revision schedules a read. Harmless, documented in `self-host-server.md` (Group ids), but suppressing it needs a flag from `chatTables.apply` to resourceStore (outside slice 6b's files, 2026-10-19).

**Why it matters:** extra feed traffic and idle reads after every lost-answer resend.
**Suggested handling:** when touching resourceStore's chat publish path, skip `recordChat` for duplicate results.

Rechecked 2026-10-21 against the code: still present.

### Barrier floor refusal ends job

`src/ts/network/jobChannel.ts` `barrier` (~427-450): after `flushResources`, a remembered `hydrateAll` copy below the chat's acknowledged floor (`ackedRevisions` in `chatStore.svelte.ts`, slice 6d) is refused by `applyChatHydration` ("busy"), `holds(receipt)` stays false, and `CallbackFailed("barrier", ...)` ends the job (`server/src/prompt/scripts.ts` ~306 makes it fatal). Window: local work on the job's chat pending when the server built the barrier copy and flushed by the barrier itself, stale-acknowledged.

**Why it matters:** safe (the edit is kept, the hook never runs on a copy without it) but a user editing while an output-listener plugin's callback starts can lose the rest of the job.

**Suggested handling:** better continuity: when the floor refuses the copy, read the chat whole (even under the job's lock) and hydrate it with the remembered record's `job.streaming` metadata, rechecking local work/lifetime/epoch/floor after the await; needs a jobChannel.ts or resourceSync export change.

Rechecked 2026-10-21 against the code: still present.

### Same-id chat recreate drops delete

`src/ts/storage/chatStore.svelte.ts` `takeChatWork` (create branch, ~3477 `pending.delete(key)` after
`sentGroup(... [{ op: "create", ... }])`): when one pending entry holds both a delete of the old
incarnation and `create = true` (a `deleteChat` followed by `createChat` with the same id from a
plugin/import, since `createChat` keeps an input id once the chat left the mirror), the create goes
out alone and the queued delete op is dropped. `acceptRemoteCollection` (~4733, "keep the recreation
behind its delete") expects the delete to go first. Raised as a side note by the Fable reviewer of
open-bug-fixes slice A2 on 2026-10-19; not traced end to end (what the server answers to a create of
an id it still holds, whether a 409/400 follows).

**Why it matters:** a same-id recreation could be refused or conflict instead of replacing the old chat.

**Suggested handling:** verify with a storeBackedServer test (deleteChat + createChat same id, one flush)
before fixing; related to A3's character-delete lifecycle in the Open Bug Fixes plan.

Rechecked 2026-10-21: the cited code is unchanged; still unverified in a browser or test.

### Reorder beside in-doubt create replay

`src/ts/storage/chatStore.svelte.ts` `takeChatWork` (orders loop, ~3600: `orderRevisions.get(chaId)` as `baseRevision`) puts a queued reorder in the same batch as a character's in-doubt create resend. The lost create already moved the server's order revision, which this client learns only from the replay's answer, so the reorder conflicts; `recoverChatConflicts` settles a conflicted reorder without a discard report and the list read shows the reload notice. Probe by the A3 Fable reviewer on 2026-10-19 (no A3 flow needed): lost create `x`, `reorderChats("c", ["x","k","j"])`, flush → `{discarded: []}`, notice `reloaded`, server order stays `["k","j","x"]`. Pinned with a comment in resourceSyncChats.test.ts (A3 describe, reused-id case: one reload notice).

**Why it matters:** the user's reorder is lost with only a generic reload notice and no discard report.

**Suggested handling:** hold a character's reorder (like `holdOrders`) while the same batch carries an in-doubt create resend of that character, and send it on the revision the replay's answer reports.

Rechecked 2026-10-21 against the code: still present.

### Order conflict discard unreported

`src/ts/storage/chatStore.svelte.ts` ~4253 (conflict recovery, the `conflictedOrders` loop): a reorder the server refused is settled with `settleOrder` and the list re-read, but `markOrderDiscarded` is not called. So `flushResources().discarded` (and `MutationScope` reports) never name `chats/<chaId>` for a reorder lost to a conflict, though the reload notice is shown. Other paths (~3541, ~4909, ~4978) do mark it. Found 2026-10-23 by the CC5 test writer: the checkpoint module's "discarded names the character's order" check (`src/ts/checkpoints/chatCheckpoints.svelte.ts` `prepare`) cannot fire for this case; the test for it was dropped since a fix needs a storage edit and a reorder does not change a checkpoint's content.

**Why it matters:** callers that stop on a discarded order (checkpoints, `readChatsDetached` in chatEdits.ts) miss this one.
**Status (2026-10-23):** documented, not fixed, in `docs/structure/persistence.md` Known Hazards by CC6 (the loop is now ~4247). The gap remains open. Note the no-report rule also serves a reorder whose answer was lost; a fix must keep that case quiet (tests at `resourceSyncChats.test.ts` ~818 and ~1631).

**Suggested handling:** call `markOrderDiscarded(order.characterId, order.seq)` there (check `settleOrder` semantics), then a checkpoint test can assert the order case.

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop the parked entry in the sweep when the character's record was never persisted (resourceSync knows `persisted`).

### Publishing throw drops nested feed refs

`server/src/data/resourceStore.ts` `publishing` (~line 600): a write nested in an outer write's input evaluation (a batch getter, as `chatFeedPatches.test.ts` ~155 does) records its refs into the outer scope's accumulator. If the outer write then throws, the accumulator is dropped, so the nested write, which committed, never reaches the change feed; tabs only learn of it at their next reconnect reconciliation. The chat source-generation notices (2026-10-22, slice 5a of the HypaV3 background memory plan) are delivered on that throw path, but the feed refs still are not. Latent: no production writer evaluates store writes inside batch input.

**Why it matters:** a lost live update leaves other tabs on a stale revision until reconnect.
**Suggested handling:** if a production path ever writes from inside batch input evaluation, give each SQL transaction its own feed refs (like `transactionInvalidations`) or publish nested commits immediately.

### Unloaded chat fmIndex passes floor

Found by the CC3 challenger (2026-10-23). `src/ts/storage/chatStore.svelte.ts` ~2526 lets a tab queue `fmIndex` edits for a chat it has not loaded; when the chat later loads, `installRead` (~5299) keeps those local fields but adopts the server's newer revision, and pending work then goes out on that revision (~3732). Sequence: queue an fmIndex edit → another tab loads a checkpoint (restore floor set) → this tab hydrates the chat → the old edit is sent on the post-load base, passes the floor, and overwrites the restored `fmIndex`.

**Why it matters:** the server's floor rule (a group below the floor conflicts) holds, but the plan's promise that every queued pre-load edit is discarded does not for this client path.

**Status (2026-10-23):** documented, not fixed, in `docs/structure/persistence.md` Known Hazards by CC6 (plus a second untested path found then: `acceptRemoteCollection`'s lost-create recognition ~5008 keeps the create's remaining and newer ops on the list's post-load revision). The gap remains open; the client checkpoint tests boot whole chats, so nothing covers it.

**Suggested handling:** a fix (client, `src/ts/storage/chatStore.svelte.ts`) should discard queued unloaded-chat meta edits, or keep their old base, when a read's revision jumps past a load; then drop the hazard from `persistence.md`.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

## Generation jobs, channels, and providers

### getModelList ungrouped alias

`src/ts/model/modellist.ts` `getModelList` (:198 `let models = LLMModels`, :234-236 push; unchanged 2026-10-21): with `groupedByProvider` false, `models` aliases `LLMModels` and the plugin entries are pushed into it, so each ungrouped call grows the global catalogue with duplicate plugin models that a plugin reload cannot remove. Only production caller (`ModelList.svelte` ~32) asks for grouped results, so latent. Found by the G1 challenger 2026-10-19.

**Why it matters:** a future ungrouped caller would see duplicates and removed plugins' models forever.
**Suggested handling:** copy before appending (`[...models, ...customV3ProviderMetaStore]`).

Rechecked 2026-10-21 against the code: still present.

### aiaccess nested request uses selection

`src/ts/process/mcp/aiaccess.ts:19-23` `AIAccessClient.callTool` runs `requestChatData({ formated, bias: {} }, mode)` with no `chatRef`/`pluginContext`. In a tab request's tool loop the nested request falls back to the chat selected when transport captures it (after its tool listing, `request.ts:354`), not the outer request's chat: wrong preset/model bindings and module MCPs if the user switched chats mid-loop. Server jobs are unaffected (job-scoped in `server/src/mcp/internal.ts`).

**Why it matters:** same bug class as slice G3 (internal MCP tools on the selection), deliberately left out of G3 (2026-10-19); recorded as a Known Hazard in `docs/structure/plugins-mcp.md`.

**Suggested handling:** fix by giving `AIAccessClient` a `callToolForChat(chatRef, name, args, scope)` (the G3 capability in `mcp.ts` `callMCPTool`) and passing `chatRef` (and a captured context) to `requestChatData`; remove the Known Hazard.

Rechecked 2026-10-21 against the code: still present.

### Job status survives job end

`src/ts/network/jobChannel.ts` `endJobChannel` (~1048) drops the ended job's queued questions and cancels its shown one, but keeps its queued notices. A job's `alertWait` still in `uiQueue` (behind a question or a modal notice) shows after the job ended and nothing clears it; a status the job set behind a local dialog resurfaces when that dialog closes. Pre-existing; A1 (alert queue, 2026-10-20) kept the routing so behaviour is unchanged. Found by Sol's A1 plan review (point 5).

**Why it matters:** a stale "Loading…" overlay with no owner after a job ends; only a later status or `alertClear` removes it.

**Suggested handling:** if fixed, track the job that installed each status and clear only its own on end; keep modal errors/results of finished jobs.

Rechecked 2026-10-21 against the code: still present.

### Attach promoted request overtakes notices

`server/src/jobs/channel.ts` `handleAttach` (~590–615): on the first attach it checks each outstanding request with `expireIfDue` before draining the ordered `sends` batch (early notices + replays). An expiry there runs `settle → pump`, which dispatches the next queued root at once, so that request reaches the tab before notices buffered earlier (e.g. a modal notice shows behind a question). Contradicts the "in their order among the requests made meanwhile" promise in `docs/structure/self-host-server.md` (~66). Predates the dispatch-time-deadline change (2026-10-23, per-chat send plan slice 2) but that change lets more queued requests survive to hit it.

**Why it matters:** ordering of UI effects on reconnect; low frequency (needs no owner, a dispatched request past its deadline before its timer, a queued root, and buffered notices).

**Suggested handling:** fix by collecting deliveries of requests promoted during attach into the same `order`-sorted batch (do not simply postpone every promotion past all notices: a later notice would then precede an earlier request). Related: [Feed lock windows](#feed-lock-windows).

### Cancelled child blocks next child

`src/ts/network/jobChannel.ts` `handleCallback` (~990, the nesting check `!top || top.id !== event.parentId || outstanding.length >= 2`) refuses a child callback (`failed`/`protocol`) while a cancelled child of the same parent is still running on the tab (its hook has not settled). The server (`server/src/jobs/channel.ts` `enqueue`, child branch) removes a cancelled child from its stack at once and dispatches the parent's next child immediately; the per-chat send drain hold (2026-10-23) blocks only root dispatch, not children. So an aux request whose child callback was cancelled (its caller's signal) and then a second aux request from the same parent callback gets a protocol failure, which may end the job ("A child callback's barrier failure, timeout, or disconnect ends the job").

**Why it matters:** pre-existing, not made reachable by per-chat sends; found in the per-chat send slice 7 plan review (Sol point 4) and left out of that slice.

**Suggested handling:** fix by holding/queuing a replacement child behind a draining child (capped by the parent's deadline) or refusing it server-side with `nesting`. Related: [Interceptor callback signal not forwarded](#interceptor-callback-signal-not-forwarded), the never-settling hook entry in `plugins-mcp.md` Known Hazards.

### Interceptor callback signal not forwarded

`server/src/llm/requests.ts` (~285-300, the body interceptor of a tab `/api/llm/request`) checks `p.signal.aborted` before calling `p.channel.callback("bodyIntercepter", …, { parentId })` but does not pass `signal: p.signal` into the callback options. When the aux request is withdrawn while its interceptor child callback runs, the child keeps the tab's lane until it answers or its parent callback settles, instead of being cancelled with the request.

**Why it matters:** found in the per-chat send slice 7 plan review (2026-10-23), out of that slice's scope.

**Suggested handling:** pass `signal: p.signal` with `parentId` (the hub already settles a signalled callback `aborted` and tells the tab). Related: [Cancelled child blocks next child](#cancelled-child-blocks-next-child).

### resumeSavedGenerations stage leak

Found 2026-10-23 during GS4 (spinner stage colors). `src/ts/network/generationJobs.ts` ~747 `resumeSavedGenerations` follows saved jobs and calls `applyGenerationEvent`, which sets `jobStages` (`src/ts/process/jobStages.ts`). Only `followJobToEnd` (`serverCommands.ts` ~145) calls `dropJobStage`; `releaseGenerationJob` (~732) does not. So a job followed through `resumeSavedGenerations` keeps its stage after it ends, and the selected chat's spinner would stay colored.

**Why it matters:** latent today — the only caller is `generationJobs.test.ts` ~980; boot resumes through `resumeServerJobs` → `followJobToEnd`, which drops correctly.

**Suggested handling:** if `resumeSavedGenerations` gains a product caller, drop the stage in `releaseGenerationJob` (or route it through `followJobToEnd`).

### Stage spinner first preparing missed

Observed 2026-10-23 in the GS4 hand check (`util/playwright/checkServerJobMatrix.mjs` memory case, SupaMemory, commit 7b5682412): the Stop circle went stage-0 → 2 (pink) → 1 → 3 → 4 → 0; the job-start `preparing` (blue) never reached the tab. `server/src/jobs/generationJobs.ts` attach snapshot replays only `job.stage`, and the runner reports `preparing` right after `accepted`, before the tab's follow attaches.

Also: `.loadmove` (`src/styles.css` ~429) has `transition: border-color 0.5s`, so stages shorter than that (mock runs: 20–60 ms) only tint the circle.

**Why it matters:** the plan's "blue, pink, blue, green, purple" sequence is not what a user sees when memory starts quickly; harmless, but relevant if the stage colors are tuned later.

**Suggested handling:** if the first blue matters, the tab could show `preparing` from job creation until the first stage event (client side), rather than changing the registry.

### Tab reverse proxy WebLLM refused

Client `src/ts/process/request/request.ts` `requestChatDataMain` (~612) resolves `reverse_proxy` with the catalogue descriptor (OpenAI-compatible; the client applies no `customAPIFormat` override), so it calls `requestServer`. The server then applies the override (`server/src/llm/request.ts` ~417-420) and refuses at ~473-476 ("Custom API runs in the browser, not on the server.") because a tab's HTTP request context has no `localGeneration`/`pluginProvider` (`server/src/llm/requests.ts` ~675, job requests only). So a reverse proxy whose format is WebLLM (or Plugin) never works for tab-run requests (e.g. translation, `src/ts/translator/translator.ts` ~738); only server jobs run it.

**Why it matters:** found by the SF5 challenger (2026-10-23); SF5 fixed only the model name inside `requestWebLLM` (the job path).
**Suggested handling:** if a user reports a reverse proxy + WebLLM/Plugin format failing in the tab, the fix is client-side dispatch (apply `customAPIFormat` before the Plugin/WebLLM check), not the adapter.

### Gemini 3.6/3.5 Flash stale params

`shared/llm/providers/google.ts` ~45–101 (`gemini-3.6-flash`, `gemini-3.5-flash`,
`gemini-3.5-flash-lite`) list `parameters: ["reasoning_effort", "temperature", "top_k", "top_p"]`.
Google's "What's new in Gemini 3.6" page (checked 2026-10-23) says temperature/top_p/top_k are
deprecated and ignored for 3.6 Flash and 3.5 Flash-Lite, and future generations will 400 on them.
`server/src/llm/google.ts` ~329 sends whatever the entry lists, so the UI shows dead controls and
the body carries ignored fields. The same page lists only medium/high thinking levels for 3.6
Flash, so `gemini-3.6-flash` may also need `geminiThinkingNoMinimal` (adapter clamps minimal→low
only with that flag, google.ts ~393); 3.5 Flash-Lite does support minimal.

**Why it matters:** found while porting upstream b32610c6 (Combined Run UP12); outside that slice's scope.
**Suggested handling:** fix in a small llm catalog slice; re-check the Gemini docs first.

## Lorebooks and modules

### Lorebook folder delete child links

`src/lib/SideBars/LoreBook/LoreBookData.svelte` delete handler (~186-212, after SF7 `0e8fc0120`) deactivates only the deleted row's own `id` in the captured chat. A folder delete removes the folder and every member from `globalLore` (`LoreBookList.svelte` `removeEntry`), but the members' `mode: "child"` links (same id, created by `activateLocally`) stay in the chat's `localLore`, where they no longer resolve to anything. Pre-existing before SF7 (the old draft-based deactivation did the same).

**Why it matters:** orphan child entries pile up in chats; they activate nothing but show as "Unnamed" rows in the chat lorebook tab.

**Suggested handling:** a fix would collect the member ids before the confirm and filter all of them in the one `setChatMeta`; chats other than the captured one keep their links either way.

## Chat screen

### Translate buttons while streaming

In "off" streaming display mode the translate/retranslate buttons stay visible while a reply streams (`src/lib/ChatScreens/Chat.svelte` ~1388 checks `isOptimizedStreamingMessage`, false in off); a click flips `translated` but shows nothing until the stream ends, and the end-of-stream row remount (`Chats.svelte` mount key text null → data) drops it. Pre-existing reset, see shared composer across chats style row-state issues. (The bookmark preview's per-chunk translation, noted with this, was fixed on 2026-10-24.)

## Alerts, dialogs, keys, and settings controls

### Terminal notice ack keyup

Slice G2 (open-bug-fixes plan, on metatron 2026-10-19) gates plugin keydown/keyup/keypress listeners in `src/ts/plugins/apiV3/v3.svelte.ts` (`SafeElement.addEventListener`, the delayed-listener wrapper) on `terminalNoticeShown()` from `src/ts/alert.ts`. The flag clears synchronously in `acknowledgeTerminalNotice`, so the keyup (and for Space, the release that clicks) of the key that acknowledged OK in `TerminalNotice.svelte` is delivered to plugins. Minor: the page reloads right after, and only that one key's release leaks. Mouse listeners are not gated at all (the slice scoped keys only).

**Why it matters:** the slice's goal was that no key typed into the restore notice reaches a plugin; one trailing keyup is a gap.
**Suggested handling:** if it matters, keep the flag set until the next keyup after the acknowledgement (or until the reload).

Rechecked 2026-10-21 against the code: still present.

### Status clear ownership

After A1 (alert queue, 2026-10-20) `alertClear()` clears only the status slot and can no longer close a dialog, but it still clears any status: `src/lib/Setting/Pages/Module/ModuleSettings.svelte` `clearStaleExportWait` (~38) clears any `wait`/`progress`, and `src/lib/ChatScreens/Chat.svelte` (~1337) clears the shared status after many awaits in the rich-copy fallback; either can erase another operation's newer loading/progress status. Found by Sol's A1 plan review (point 11; ownership tokens rejected as pre-existing).

**Why it matters:** a long import's progress overlay can vanish while it still runs.

**Suggested handling:** clear by identity (`alertStore.clearStatus(expected)` exists since A1) with the status the caller installed.

Rechecked 2026-10-21 against the code: still present.

### Modifier hotkeys behind alerts

`src/ts/hotkey.ts` `initHotkey` dispatches the stored hotkeys (~loop after the text-entry guard) before the alert Enter/Escape branches and returns once one ran. Since SF8 (2026-10-23) plain-key hotkeys are skipped while a dialog is shown or queued, but a modifier hotkey bound to Enter/Escape (e.g. the default Ctrl+Alt+Enter `send`) still runs behind a dialog. Also pre-existing: Shift+Enter in the composer while an `ask` dialog is visible skips the text-entry guard and answers "yes" (less reachable now that a dialog takes focus).

**Why it matters:** a modifier hotkey can send or act behind a visible dialog.

**Suggested handling:** while `alertStore.hasDialogs()`, skip hotkey actions that act on the chat, or handle the dialog keys first.

### Raw selects without risu-select

`risu-select` (src/styles.css, Safari select clipping fix, upstream 9499b870) landed only on `SelectInput.svelte` and `PopupEditor.svelte` (UP17, 2026-10-23). Three raw `<select>`s that upstream also changed still lack it: `src/lib/Setting/Pages/MemorySettings.svelte:227` (HypaV3 preset, upstream OtherBotSettings), `src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte:65`, `src/lib/Others/HypaV3Modal/bulk-edit-actions.svelte:93` (which also uses literal zinc/blue colors, against U1).

**Why it matters:** on macOS Safari/iOS their selected text is still clipped; ui-theming.md lists them as not carrying it yet.
**Suggested handling:** add `risu-select` to each (and theme tokens in bulk-edit-actions) in a small UI slice; drop the "do not carry it yet" sentence from ui-theming.md then.

## Notifications

### Push cross-tab disable/enable race

`src/ts/network/pushNotifications.ts` `serial()` orders enable/disable/sync only within one tab. `disablePushOnThisBrowser` in tab A (its `unsubscribe()` in flight) racing `enablePushOnThisBrowser` in tab B (which re-registers the same subscription) can leave the browser with no subscription while B reports `subscribed: true`, until B's next `reconcilePush` (visibilitychange/boot) subscribes again. Notifications are missed in between if the app is closed.

Slice P1 (2026-10-19, on metatron as 34555e412) closed the same race for the automatic retry (`risu-push-pending-unsubscribe`: flags re-read around the retried unsubscribe, re-subscribe in the same sync), but not for the explicit disable. Sol accepted it as pre-existing.

**Why it matters:** low impact (self-heals on the next sync), but a cross-tab Web Lock (`navigator.locks`) around `serial` tasks would close every variant.
**Suggested handling:** if push gets touched again, consider wrapping `serial` tasks in `navigator.locks.request("risu-push", …)` where available (the permission request must still happen before any await).

Rechecked 2026-10-21 against the code: still present.

### Page Notification fallback not dismissed

`src/ts/network/pushNotifications.ts` `showCompletionNotification` (~451–470) falls back to the page's `new Notification(...)` when no service worker registration is ready. `dismissCompletionNotifications` (~427) closes only the registration's notifications (`registration.getNotifications()`), so a fallback notice stays after the page comes to the front, unlike the worker-shown ones. Pre-existing; seen 2026-10-23 while adding per-chat completion tags (commit 19087b600, per-chat send slice 6).

**Why it matters:** with per-chat tags a tab can now show several such page notices at once (one per chat), all left open.
**Suggested handling:** if notifications get touched again, keep the fallback `Notification` objects (or close them on `visibilitychange`);

## Assets, MIME types, and the service worker

### Module asset row miss

Seen 2026-10-23 in the DA7 browser-check driver (dev stack, headless Chromium): a module (seeded as the `modules` main record, enabled through `enabledModules` and `chat.modules`) with one asset `["modimg", key, "png"]` and a reply `Module: {{img::modimg}}` rendered as `Module:` with no image in five runs, in direct mode and with `setDirectAssets(false)` alike, also after reopening the chat. `ParseMarkdown` called from the page afterwards (with and without a transform capture) returned the `<img>`; `getModuleAssets()` listed the asset. Once the module also had a `backgroundEmbedding` and a second asset, the row showed the image in every run. Suspect: a row parsed before the module assets reached `parserModuleAssets` (`src/ts/parser/parser.svelte.ts` ~533-580, `syncAssetsCache`/`resetAssetsCache`) keeps its empty output (ChatBody `lastParsed`).

**Why it matters:** if real, module image assets can be missing from chat rows until something re-renders them; not direct-URL related.
**Suggested handling:** reproduce with a module that has only one image asset and no background embedding before changing code; not confirmed.

## Backup import

### Upstream kv report code

Since UP1 (cb7d7a399, 2026-10-23, not pushed), `server/src/data/upstream/importStage.ts` `stageUpstreamImport` reports each SaveKV namespace of an upstream block save as `addUpstreamReportEntry(report.excluded, "unknown-setting", "kv:<ns>")`, ahead of the converter's entries.

**Why it matters:** a dedicated code needed `shared/upstreamBackup.ts` `UPSTREAM_EXCLUDED_CODES` plus `src/lang/en.ts`/`ko.ts` (`language.upstreamImport`), which were outside the slice. The UI labels it "Settings this app does not know", which is misleading, and the 5-example cap (`UPSTREAM_REPORT_EXAMPLE_LIMIT`) can hide namespaces past the fifth, so plan D1's "list each namespace" is only partly met. Upstream at f50b5942 writes no namespace, so nothing is lost today.

**Suggested handling:** when upstream starts writing SaveKV namespaces, or the report codes are touched next, add a `savekv-namespace` excluded code with en/ko strings and move the loop to it.

## Tests and tooling

### CharX asset admission load flake

2026-10-23, HypaV3 plan final check on metatron (f98be8d41), load average ~7.5: `src/ts/characterCardsRoundTrip.test.ts` > "CharXImporter asset admission > holds about ten decoded unsaved assets while uploads of forty 96 KiB entries are stalled" failed with `TypeError: Cannot read properties of null (reading 'length')` at `src/ts/globalApi.svelte.ts:847` `AppendableBuffer.append`, called from `src/ts/process/processzip.ts:376` `#handleFileData` (via the test's `file.ondata` at :216). It passed 3/3 alone and in a full `--force` rerun. The HypaV3 plan touched none of these files.

**Why it matters:** a null buffer reaching `append` may be a real ordering bug in CharXImporter (data delivered after the entry's buffer was released), not only test timing.

**Suggested handling:** if it recurs, check whether `#handleFileData` can run after the entry's buffer is nulled (stall/resume path).
