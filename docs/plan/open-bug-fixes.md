# Open Bug Fixes Plan

Status: planned (nothing landed). Source: the project memory's recorded bugs, rechecked
against the working tree at `5c3665fdb` on 2026-10-19 (half by direct reading, half by
three read-only sub-agents whose evidence was spot-checked). Only defects that are
reachable today are here: latent ones with no producer (`coalesce` generation guards,
Lua `touchesGenerating`/`mergeUnset`, ChangeFeed re-entrant publish), accepted trade-offs
and performance leftovers are left out. Line numbers are approximate; the identifiers
are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide
from `STRUCTURE.md` Choose By Task; that guide's `Invariants` apply (D1 above all:
address chat data by id, never by an index or an index-following `#each` item after an
await). Every slice updates the owning guide's `Flows`, `Invariants` or `Known Hazards`
where it changes a documented contract, and removes the matching Known Hazard entry when
it fixes one.

Workflow per slice: `opus-lite` for a slice marked _small_, `delegate-implementation`
for one marked _hard_. Each slice ends with its regression test (under "Test"),
`pnpm check`, `pnpm --silent test:agent` (`--tags-filter=slow` for the storage suites it
touches) and the guide's focused checks.

## Order

- **Sequence A, the client chat store** (`src/ts/storage/chatStore.svelte.ts`, one at a
  time): A1 → A2 → A3.
- **Sequence B, the save adapter** (`src/ts/storage/resourceSync.svelte.ts`): B1, after A3
  if A3 changes `settleCharacterDelete`'s call site there.
- **Sequence C, the plugin API** (`src/ts/plugins/apiV3/v3.svelte.ts`): G1 → G2.
- **Independent** (any time, own worktree): C1–C8, S1, S2, P1, G3, M1, I1.
- Several slices add `language.*` keys to `src/lang/en.ts` (and the other locales where
  a key is translated). Add them next to their feature's existing keys so parallel
  slices rebase cleanly.

## Index

| Bug                                                                              | Slice |
| -------------------------------------------------------------------------------- | ----- |
| `recoverChatConflicts` replays a landed group's rest                             | A1    |
| `setChatMeta` snapshot comparison drops `__proto__`                              | A1    |
| Quarantined absent chat keeps reorders failing with 400                          | A2    |
| `dropCharacterWork` settles a lost create's Resend                               | A3    |
| Late unload answer after an acknowledged character delete                        | A3    |
| `hydrateCharacters` applies a stale null character read                          | B1    |
| Local `localLore` writers send a whole stale array during a job                  | C1    |
| `exportLoreBook("sglobal")` always throws; `"local"` throws while the chat loads | C1    |
| HypaV3 bulk resummary applies captured indices                                   | C2    |
| Folder color written to the `#each` item after awaits                            | C3    |
| Branch folder skipped for a dangling `folderId`                                  | C3    |
| Emptied reply unreachable through prereroll                                      | C4    |
| Other module import entry points alert success before the save                   | C5    |
| Local `checkCharOrder` strips ids of characters not read yet                     | C6    |
| Sidebar shows trashed ids that reach the order                                   | C6    |
| Lore prompt focus at a character switch (TypeError, possible silent overwrite)   | C7    |
| Emotion row delete while typing throws in the binding                            | C7    |
| `SettingSegmented` writes its fallback into a newly selected preset              | C8    |
| Connections tab forgets the selected connection on tab return                    | C8    |
| `openCredentialOwner` scrolls but leaves focus behind                            | C8    |
| ThanksPage has no `{:catch}`                                                     | C8    |
| "Balanced" streaming help text describes a throttle that does not exist          | C8    |
| Event feed `ws.send` throw skips later sockets                                   | S1    |
| Unreadable push subscriptions file silences deliveries                           | S1    |
| Backup export abort after the stream started leaks its staging copy              | S2    |
| Push disable reports success after a failed browser unsubscribe                  | P1    |
| Push banner drops enable failures; English detail strings                        | P1    |
| Notification click: failed `navigate` has no `openWindow` fallback               | P1    |
| Plugin provider registries not reset on reload; duplicates on re-add             | G1    |
| Plugin fetch abort after response headers never reaches the host                 | G1    |
| Plugin capture-phase key listeners see keys behind the terminal notice           | G2    |
| Plugin `setCharacter` turning on `supaMemory` does not bump `supaMemoryOnCount`  | G2    |
| `internal:graphmem`/`internal:risuai` act on the selected chat (tab path)        | G3    |
| `runVITS` playback cannot be stopped; leaks an `AudioContext`                    | M1    |
| `runPinnedServerJob` refusal alerts are hard-coded English                       | I1    |

## Sequence A: client chat store

- **A1. Two small chat store corrections** (_small_, `persistence.md`).
  `recoverChatConflicts`, the `group.expected === canonicalChat(server.data)` branch
  (~3889): the comment says the create and the rest of its group landed, yet
  `rest = group.ops.slice(1)` is requeued under a fresh `groupId`, so its by-id ops apply
  a second time. Settle the whole landed group (ack it at the server's revision) instead
  of requeueing `rest`. `setChatMeta` (~2524): compare `JSON.stringify(chat[key])`
  directly instead of `$state.snapshot(...)`, as slice 1b of the data-loss plan did for
  `applyMessagePatch`/`mergeChatMeta`.
  _Done_: a recognized landed create with a `setText` in its group sends nothing more; a
  `setChatMeta` whose value differs from the current one only in a nested own `__proto__`
  key queues a write.
  _Test_: `src/ts/storage/tests/resourceSyncChats.test.ts` (lost-answer create recognized
  by content, rest not resent: count the server's applied groups);
  `src/ts/storage/tests/chatStore.test.ts` (`__proto__` value queues).

- **A2. Kept absent chats leave the order** (_hard_, `persistence.md`).
  `applyRemoteCollection` (~4580) and `acceptRemoteCollection` (~4735) keep a
  server-absent chat that is busy or quarantined, with its `chatRevisions` entry, while
  adopting the server's order revision; `takeChatWork`'s order part (~3512) then puts
  that id in a reorder and the server refuses it ("ids must be a permutation",
  `server/src/data/chatStore.ts` ~1492). The `keepPendingOrder` path only drops the
  queued reorder. Fix: when an authoritative list says a kept chat is absent, keep its
  local draft/quarantine but retire its held revision (or track server membership
  separately from held revisions) so orders exclude it; decide which at the slice: the
  membership set is safer if other readers rely on the held revision.
  _Done_: quarantine a chat, delete it from another tab, reorder: the reorder lands, the
  quarantined draft is still reported.
  _Test_: `resourceSyncChats.test.ts`, a `storeBackedServer.ts` two-tab case.

- **A3. Character delete keeps its chat obligations and fences late answers** (_hard_,
  `persistence.md`). Two holes in the delete lifecycle:
  `dropCharacterWork(chaId, false)` (~3254, from `settleCharacterDelete`) settles every
  pending entry, including a `Resend` of a chat create whose answer was lost, so a
  failed/refused delete followed by a same-id re-add builds `installCharacterChats`'
  `known` without that chat (a landed create survives or a reused id conflicts; with the
  parent create also lost, the replacement's chats are never sent). And
  `settleUnloadWork` (~1805) acks/requeues an unload group with no incarnation fence, so
  an answer arriving after `ackCharacterDelete` (~3327) re-holds a deleted chat's
  revision or makes a resend for a chat the cascade removed. Fix: keep unresolved
  create/resend metadata aside per character until its delete is acknowledged (restore
  it on a re-add, with the group id and payload so 6b's replay recognition still works;
  drop it on the acknowledgement), and at the acknowledgement retire the character's
  in-flight groups (remember their keys, ignore their later ack/requeue, still settle
  their flush obligations).
  _Done_: delete refused after a lost chat create, same-id re-add, flush: the server ends
  with exactly the replacement's chats; unload answer after an acknowledged delete holds
  no revision and queues nothing.
  _Test_: `resourceSyncChats.test.ts` and `resourceSyncUnload.test.ts`
  (`storeBackedServer.ts` with a delayed unload answer).

## Sequence B: save adapter

- **B1. Fence `hydrateCharacters`' null answer** (_small_, `persistence.md`).
  `resourceSync.svelte.ts` ~2655: `if (!collection.order && record && record.revision === null) acceptRemote(record)`
  runs even when a job hydration or a same-id recreation landed while the read was
  pending, deleting the live character with its chats. Capture the held revision and
  `lifetimeOf` before the read (as `applyRemoteUpdates` does with `issuedHeld`) and skip
  the delete when either moved.
  _Done_: a job hydration that lands during the recovery read survives a null answer.
  _Test_: `src/ts/storage/tests/resourceSyncHydration.test.ts`.

## Independent client slices

- **C1. Lorebook writers and export** (_small_, `characters-modules.md`).
  `src/ts/process/lorebook.svelte.ts`: add entries (~34) and import into the chat (~199)
  send `setChatMeta(ref, { localLore: [...snapshot, ...new] })` from the mirror, so a
  job's Lua `upsertLocalLoreBook` written meanwhile is replaced. Apply the slice-1c fence
  of `localLoreDraft.svelte.ts` (refuse with `chatGenerating` while `sendingChatRef`
  matches or `generatingChatKeys()` holds the chat). `exportLoreBook`: `"sglobal"` reads
  `chat.localLore` with `chat` undefined; export
  `settings.loreBook[selectedLoreBookPage()].data` (the list `LoreBookList` shows in
  `globalMode`); `"local"` with no loaded chat refuses with a localized message instead
  of a TypeError.
  _Done_: add/import during a job in that chat refuse; the Global Lore Book page exports
  its page; local export while loading shows the new message.
  _Test_: `src/ts/process/lorebook.svelte.test.ts`, `lorebookImport.test.ts` (fence
  cases mirroring `localLoreDraft.fence.test.ts`).

- **C2. HypaV3 bulk resummary by summary key** (_small_, `memory.md`).
  `src/lib/Others/HypaV3Modal.svelte` `bulkResummary` (~299) captures `sortedIndices`,
  awaits `summarize`, and Apply (~349) writes `summaries[minIndex]` and splices the
  others; the copy is replaced by the `$effect.pre` when the chat's `hypaV3Data`
  changes. Store the selection as `summaryKey`s (`shared/memory.ts`), resolve them at
  Apply, and refuse with a notice when any is gone (or invalidate `bulkResummaryState`
  when the copy is replaced; pick one, the key form keeps the user's work).
  _Done_: a memory write that replaces the copy between summarize and Apply merges the
  selected summaries or refuses; never others.
  _Test_: `src/lib/Others/HypaV3Modal.fence.test.ts`.

- **C3. Chat folder handlers address by id** (_small_, `ui-theming.md` with
  `persistence.md`). `src/lib/SideBars/SideChatList.svelte` folder color (~322-336):
  capture `chara.chaId` and `folder.id` before the first `alertSelect`, re-find both
  after the awaits (as slice 7a did for delete). `src/lib/ChatScreens/Chat.svelte:1524`:
  gate "Create Folder on Branch" on `chatFolderOf(currentChat, owner.chatFolders) == null`
  (`src/lib/SideBars/chatFolders.ts`) instead of `!currentChat.folderId`.
  _Done_: a folder list reorder or character switch during the color dialogs recolors
  the chosen folder or nothing; branching a chat with a dangling folder id creates the
  branch folder.
  _Test_: `src/lib/SideBars/SideChatList.test.ts`; a branch case beside the existing
  `createFolderOnBranch` coverage (find it with `rg -n createFolderOnBranch src`).

- **C4. Prereroll shows emptied candidates** (_small_, `chat-pipeline.md`).
  `src/lib/ChatScreens/DefaultChatScreen.svelte` `reroll()`/`unReroll()` (~317, ~383)
  apply only `if (r)`; `src/ts/process/prereroll.ts` `swapFrom` skips empty values to
  stay in step. Change both checks to `r !== null` and drop the skip in the same change.
  Also drop the unused `applyChatResult`/`captureChatBaseline` imports (~43-44).
  _Done_: a reply saved as "" is reachable by swiping.
  _Test_: the "prereroll candidates (C1)" block in `src/ts/process/rerollHistory.test.ts`;
  remove the Known Hazards entry in `chat-pipeline.md`.

- **C5. Every module import entry point waits for the save** (_small_,
  `characters-modules.md`). Export `addImportedModule` from `src/ts/process/modules.ts`
  (mutation scope + `flushResources({ scope })`, `moduleImportDiscarded` on a discard)
  and route `src/App.svelte` (~101, ~108, the drop's `.risum`) and
  `src/ts/characterCards.ts` (`#share_module`, `#import=`, launch queue; ~602-689)
  through it instead of `addModule` + `alertNormal(language.successImport)`.
  _Done_: each path alerts success only after the acknowledgement and the discard
  message on a discard.
  _Test_: `src/ts/characterCards.share.test.ts`, `src/ts/process/modulesImport.test.ts`;
  update the gap in `characters-modules.md`.

- **C6. Character order keeps unread ids; the sidebar skips trashed ones** (_hard_,
  `characters-modules.md` with `persistence.md`). `src/ts/storage/characterOrder.ts`
  `checkCharOrder` drops every id with no character in `characterList()`, including one
  another tab created that this tab has not read yet (capped reads widen the window);
  its local callers (character add/remove/import, Sidebar folder ops, App drop, plugin
  API) then save the order without it. Make the local repair strip only ids it knows are
  trashed or deleted here and keep unknown ids, as the remote repair does; boot
  `maintainCharacters` drops the truly dangling ones. `src/lib/SideBars/Sidebar.svelte`
  `charImages` (~118-160) resolves order ids through `getCharacterIndexObject()` and
  never checks `trashTime`: skip trashed and unknown ids at render.
  _Done_: a character created in tab 1 and filed in a folder stays in that folder after
  tab 2 adds a character before reading it; an order holding a trashed id does not show
  it.
  _Test_: `src/ts/storage/tests/characterOrderRepair.test.ts`; a Sidebar render case
  (new test file beside `Sidebar.svelte` if none fits).

- **C7. Index bindings that outlive their row** (_hard_, `characters-modules.md` with
  `ui-theming.md`). Both bugs are an unkeyed `{#each}` binding by index into a list that
  changes under a focused input. Lore: `LoreBookList.svelte` (~381/435/490)
  `bind:value={currentCharacter.globalLore[i]}` with no `{#key}` on the character; on a
  keyboard character switch the focused `TextAreaInput`'s unmount `onchange` (~273)
  writes through the stale binding: a TypeError when the new character has no entry `i`,
  or a silent overwrite of the new character's entry `i` (inferred, confirm first).
  Emotions: `CharConfig.svelte` (~641-659) `{#each emotionIndices as index}` with
  `bind:value={currentCharacter.emotionImages[index][0]}`; a delete unmounts the last
  row and its getter throws. Fix: key rows by entry identity and bind through
  getter/setter functions that resolve the entry captured at mount and ignore a write
  whose entry is gone or belongs to another character (D1); check the Additional Assets
  table (~845-884), which uses the same pattern.
  _Done_: Ctrl+] during a lore edit leaves both characters' entries unchanged except the
  edited one; deleting an emotion while another row is focused does not throw.
  _Test_: a LoreBookList component test (keyboard-like switch with the textarea focused);
  `src/lib/SideBars/CharConfig.emotions.test.ts` (remove the workaround comment at
  ~204-206 and type into the row the shrink unmounts). Drive both once in a browser.

- **C8. Settings page corrections** (_small_, `settings-i18n.md`).
  `src/lib/Setting/Wrappers/SettingSegmented.svelte` (~26-43): read and write under
  `untrack` like `SettingSelect.svelte` (~24-33) so a preset switch never writes the
  fallback (example: an adaptive-only Claude model and a preset holding
  `thinkingType: "budget"`). `src/lib/Setting/Pages/ModelProfilesSettings.svelte:20`:
  keep the selected connection across tab switches (module-level state or the page's
  existing UI state, whichever the settings guide prefers).
  `src/ts/setting/credentialLinks.ts` `openCredentialOwner`: focus the revealed field
  after scrolling. `src/lib/Setting/Pages/ThanksPage.svelte:63`: add `{:catch}` with a
  localized message. The "balanced" streaming help text (`src/lang/en.ts` ~147,
  `ko.ts` ~111, `cn.ts`, `zh-Hant.ts`) claims a ~0.125 s throttle metatron does not have:
  reword it to the shipped behavior (verify what "balanced" does now first).
  _Done_: switching to such a preset leaves its value; tab return keeps the connection;
  the credential link leaves focus in the field; the Thanks page offline shows the
  message; the help text matches the code.
  _Test_: `src/ts/storage/tests/settingWrappers.test.ts` (Segmented on a preset switch);
  others by a focused component test where one exists.

## Independent server slices

- **S1. Feed and push delivery robustness** (_small_, `self-host-server.md`).
  `server/src/routes/events.ts` `send` (~31-40): wrap `ws.send(text)` in try/catch and
  terminate the failing socket, as `generationJobs.ts` `sendText` does.
  `server/src/push/pushService.ts`: `deliver()` (~380) reads `list()`, which returns the
  cached `[]` while `unreadable`; retry the read (`known()`) from `deliver` when the file
  was unreadable.
  _Done_: a socket whose `send` throws does not stop the frame reaching the others; a
  subscriptions file that becomes readable after startup gets deliveries without a PUT.
  _Test_: `server/src/tests/events.test.ts`, `server/src/tests/push.test.ts`.

- **S2. Backup export finalizes on a client abort** (_small_, `backup-sync-hub.md` with
  `self-host-server.md`). `server/src/routes/backups.ts` (~258-287): the abort listener
  finalizes only when `!streamStarted`; a generator suspended at a `yield` after the
  client left is never returned, leaking the staging copy and the `snapshots.track`
  lifetime. Follow `server/src/http/fileImport.ts` (~322-342): the request-signal abort
  listener returns the generator so its `finally` runs `finalize()`.
  _Done_: aborting mid-download releases the staging copy and the lifetime.
  _Test_: `server/src/tests/backups.test.ts` (abort after the first chunk); remove the
  Known Hazard at `docs/structure/self-host-server.md` (~493).

## Push client

- **P1. Push client failures are reported** (_small_, `global-api.md` with
  `self-host-server.md`). `src/ts/network/pushNotifications.ts`: disable (~346-351) and
  the stale-key branch (~243) ignore a rejected or `false` `unsubscribe()`; report it
  (keep the opt-out, set `state.error`) and retry the browser unsubscribe on the next
  reconcile like `PENDING_REMOVAL_KEY`. Move the detail strings (~176, ~209, ~238, ~257)
  to `language.pushNotifications.*`. `src/lib/Others/PushPrompt.svelte:46` awaits
  `enablePushOnThisBrowser()` and alerts a failure (as `NotificationToggle.svelte`
  does). `public/sw.js` `openFromNotification` (~215): when `navigate` fails, fall back
  to `openWindow(route)`.
  _Done_: each failure is visible and localized; a failed navigate opens a window.
  _Test_: `src/ts/network/pushNotifications.test.ts`; the worker through the existing
  `node:vm` harness used for `public/sw.js` (find it with `rg -n "sw.js" src --glob '*.test.ts'`).

## Plugins, MCP, media, i18n

- **G1. Plugin registries and fetch aborts** (_hard_, `plugins-mcp.md`).
  `loadPlugins` (`src/ts/plugins/plugins.svelte.ts` ~377) calls only `clearPluginHooks`
  (`pluginHooks.ts` ~47, which says replacers and provider lists are not reset):
  `providerOptions`, `customProviderStore` and `customV3ProviderMetaStore`
  (`v3.svelte.ts` ~664, ~1363) keep a removed plugin's provider, and `addProvider`
  (~1313) appends duplicates on every reload. Reset them on reload and make
  `addProvider` replace by name. Fetch abort: `factory.ts` deletes the request's abort
  controllers in the host call's `finally` (~870), so an abort after `nativeFetch`
  resolved with headers finds no controller; keep the controller until the response's
  `STREAM_PORT` closes or is cancelled.
  _Done_: removing a plugin and reloading removes its provider from the model lists;
  reloading twice lists it once; aborting mid-body cancels the host fetch.
  _Test_: `src/ts/plugins/apiV3/nativeFetch.test.ts`, `pluginLifecycle.test.ts`.

- **G2. Plugin key listeners and the supaMemory count** (_small_, `plugins-mcp.md` with
  `memory.md`). Runs after G1. `v3.svelte.ts` `addEventListener` (~326-420) passes a
  plugin's `capture` option to `document.addEventListener`, so it sees keys while
  `TerminalNotice.svelte` is open (the notice stops only bubbling). Skip plugin key
  listeners while a terminal notice is shown (a flag set by `alertTerminal`'s owner).
  `applyPluginCharacter` (~884, from `setCharacter`): when it turns `supaMemory` from off
  to on, bump `supaMemoryOnCount`, and never let the plugin's copy overwrite the stored
  count. Raw record writes stay uncounted unless the slice moves counting to the server
  (decide there: a server count would double-count `Toggles.svelte` unless that one
  moves too); update `docs/structure/memory.md` ~111 either way.
  _Done_: a plugin capture listener gets no key while the restore notice is up; a plugin
  turning memory on makes the trim question ask again.
  _Test_: `src/ts/plugins/apiV3/v3RecordWrites.test.ts`, `hostApi.test.ts`.

- **G3. Internal MCP tools use the request's chat** (_hard_, `plugins-mcp.md`).
  `src/ts/process/request/transport.ts` (~475) passes the request's chat to
  `callMCPTool` (`src/ts/process/mcp/mcp.ts` ~289-318), which uses it only to pick
  servers and calls `client.callTool(methodName, args)`. `graphmem.ts` (~8) reads and
  writes through `getChatVar`/`setChatVar` (the selected chat) and
  `risuaccess/host.ts` (~32) takes messages from the selected chat. Pass the chat ref
  through to the internal clients and use the by-ref variants (`setChatVarOf` and its
  reader); the server path (`server/src/mcp/jobTools.ts`) is already correct.
  _Done_: a tool loop for chat A while chat B is selected reads and writes
  `graphmem_graph` on A.
  _Test_: `src/ts/process/mcp/tests/graphmemHost.test.ts`, `mcplib.test.ts`.

- **M1. VITS playback stops** (_small_, `media-aux.md`). `src/ts/process/transformers.ts`
  (~156-162) starts a `sourceNode` in a fresh `AudioContext` that nothing registers;
  `stopTTS()` (`tts.ts` ~483) stops only `activeSpeech`. Register the source (or route
  VITS through `playAudio`), honor the `sayTTS` stop generation, and close the context
  when playback ends or stops.
  _Done_: Stop TTS ends VITS playback; no context remains after it.
  _Test_: `src/ts/process/ttsPlayback.test.ts`.

- **I1. Server job refusal alerts localized** (_small_, `settings-i18n.md`).
  `src/ts/process/serverCommands.ts` `runPinnedServerJob` (~240, ~344, ~356, ~363,
  ~374, ~382) alerts English text; move each to a `language.*` entry (U2).
  _Done_: no hard-coded user-visible string remains in the file.
  _Test_: `src/ts/process/serverCommands.test.ts` (assert the `language` entry).

## Owner decisions, not slices

- Lore regex keys containing a comma (`/a{1,2}/`) are split on every comma before the
  regex parse (`shared/lore/activation.ts` ~541, `key.split(",")`). The owner deferred
  this at Phase 5 Stop B and tests pin it; it changes how existing cards activate. Ask
  before planning a slice.

## Not in this plan

- WaveSpeed model list reset and the Whisper key link (settings-ui leftovers, merged into
  `metatron` on 2026-10-19): not rechecked; verify before adding them.
- Latent defects with no producer today and accepted trade-offs listed in the project
  memory.
