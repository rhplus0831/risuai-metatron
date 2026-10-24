# Issues Found During Work

Bugs, latent defects, stale docs and comments, and test flakes that agent sessions noticed while working on something else, between 2026-10-14 and 2026-10-24. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. They lived in the agents' project memory until 2026-10-24 and were moved here unchanged apart from link wording.

These are notes, not verified reports. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24. Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (4)
- [Generation jobs, channels, and providers](#generation-jobs-channels-and-providers) (2)
- [Lorebooks and modules](#lorebooks-and-modules) (1)
- [Chat screen](#chat-screen) (1)
- [Alerts, dialogs, keys, and settings controls](#alerts-dialogs-keys-and-settings-controls) (4)
- [Notifications](#notifications) (2)
- [Assets, MIME types, and the service worker](#assets-mime-types-and-the-service-worker) (1)
- [Backup import](#backup-import) (1)
- [Tests and tooling](#tests-and-tooling) (1)

## Chat store, sync, and change feeds

### Feed lock windows

Slice 2b's feed locks (`feedLocks`, `noteRemoteStreaming`, `replaceFeedLocks`, `dropFeedLocksOf` in `src/ts/storage/chatStore.svelte.ts`) are advisory. A tab shows a generating reply unlocked (2a's `dropLockedEdits` then catches an edit) before the job's first write frame (the job owns no message before its `begin`, so the `hello` snapshot cannot list it either), and after an adopted whole read at a newer revision than the lock's frame or snapshot (another writer changed the chat), until the job's next write re-announces the lock: every 3 s while streaming (`CHECKPOINT_INTERVAL_MS`), but a job waiting on its provider or a callback can write nothing for its whole remaining life. Since 2026-10-24 every `hello` carries the server's lock snapshot with each chat's sampled revision, so a reconnect no longer drops live locks; the server still sends no lock snapshot with a chat read. Since 2026-10-24 `isCharacterGenerating` also counts feed locks, so the same windows decide when an observer tab refuses a permanent character delete or a different-id replace locally (the server's 409 `generating` stays the fallback).

**Why it matters:** these are the remaining paths for A4 (edit over the generating reply) and D7-style surprises.
**Suggested handling:** a lock snapshot with chat reads (owner decision 2026-10-24: only if needed), or let authoritative lock lists alone end feed locks instead of a newer whole read (changes the release policy; audit the collection-removal paths, which drop revisions without clearing feed locks).

### Barrier floor refusal ends job

`src/ts/network/jobChannel.ts` `barrier` (~427-450): after `flushResources`, a remembered `hydrateAll` copy below the chat's acknowledged floor (`ackedRevisions` in `chatStore.svelte.ts`, slice 6d) is refused by `applyChatHydration` ("busy"), `holds(receipt)` stays false, and `CallbackFailed("barrier", ...)` ends the job (`server/src/prompt/scripts.ts` ~306 makes it fatal). Window: local work on the job's chat pending when the server built the barrier copy and flushed by the barrier itself, stale-acknowledged.

**Why it matters:** safe (the edit is kept, the hook never runs on a copy without it) but a user editing while an output-listener plugin's callback starts can lose the rest of the job.

**Suggested handling:** better continuity: when the floor refuses the copy, read the chat whole (even under the job's lock) and hydrate it with the remembered record's `job.streaming` metadata, rechecking local work/lifetime/epoch/floor after the await; needs a jobChannel.ts or resourceSync export change.

Rechecked 2026-10-21 against the code: still present.

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

## Generation jobs, channels, and providers

### Stage spinner first preparing missed

Observed 2026-10-23 in the GS4 hand check (`util/playwright/checkServerJobMatrix.mjs` memory case, SupaMemory, commit 7b5682412): the Stop circle went stage-0 → 2 (pink) → 1 → 3 → 4 → 0; the job-start `preparing` (blue) never reached the tab. `server/src/jobs/generationJobs.ts` attach snapshot replays only `job.stage`, and the runner reports `preparing` right after `accepted`, before the tab's follow attaches.

Also: `.loadmove` (`src/styles.css` ~429) has `transition: border-color 0.5s`, so stages shorter than that (mock runs: 20–60 ms) only tint the circle.

**Why it matters:** the plan's "blue, pink, blue, green, purple" sequence is not what a user sees when memory starts quickly; harmless, but relevant if the stage colors are tuned later.

**Suggested handling:** if the first blue matters, the tab could show `preparing` from job creation until the first stage event (client side), rather than changing the registry.

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
