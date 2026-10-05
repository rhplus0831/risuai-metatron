# Slice: Chat Projection And Lazy Loading

Status: 9a implemented (2026-10-05; records and readers, eager boot); 9b (summaries at boot, pins, LRU) planned.

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (the selected chat's
loaded pages), "Lazy loading" (chat summaries per character, the full message list only for the
selected chat, every reader of a non-selected chat fetches it first, a summary is never presented
as a complete `Chat`), and "Selection shims" (the derived `chatPage`); `PLAN.md` Decision 4
("Chat data stays eagerly loaded until Phase 6") and Decision 3 (the selected chat is a
per-client chat id).

Depends on: `character-ownership` and `readers-characters` (the character record and its
readers; the files this slice edits again), `live-updates` (chat change events refresh loaded
chats and summaries). Phase 2 (`chatStore.svelte.ts`), Phase 4 (`pluginContext.ts`: the hook's
character is the one whose chats the plugin getters and setters load; `reconcileCharacterChats`
is called by the routed plugin setters), Phase 5 (generation on the server;
`applyServerGeneration` writes into the loaded chat).

## Scope

Allowed files: `server/src/data/chatStore.ts` (`readSummaries`, `readCollectionSummaries`: the
`chats` rows' `meta` projected, no message rows), `server/src/data/resourceStore.ts` (`readKinds`
option `chatSummaries`, `readRefs` option `chatSummaryCollections`), `server/src/routes/resources.ts`
(the options), `shared/chats.ts` (`ChatSummary`), `shared/resources.ts` (the read result fields),
`src/ts/storage/resourceClient.ts` (the options), `src/ts/storage/chatStore.svelte.ts` (the
summary lists, the loaded-chat map with pins and an LRU, `loadChat`, `loadChats`,
`ensureChatLoaded`, `readChatsDetached`, `chatList(chaId)`, `selectedChat`, `pinChats`;
`seedChats`/`assembleChats`/`initializeChats` over summaries; `syncChatPage` and the `chatPage`
derivation removed; `reconcileCharacterChats` over the order record; `acceptRemoteChat`,
`acceptRemoteCollection`, the idle refresh over the map and the summaries), `src/ts/storage/chatEdits.ts`,
`src/ts/storage/localLoreDraft.svelte.ts`, `src/ts/bootstrap.ts` (the boot read with summaries),
`shared/database.ts` (`character.chats` and `chatPage` leave the character type),
`shared/readonly.ts` if unused afterwards, `src/ts/storage/characterStore.svelte.ts` (the record
type without the two fields), `src/ts/storage/forwarding.svelte.ts` (the facade's `chats` and
`chatPage` on a character built by `compatChatsOf(chaId)` from the loaded map until
`aggregate-removal`), `src/ts/storage/database.svelte.ts` (`getCurrentChat` over `selectedChat`),
`src/ts/globalApi.svelte.ts` (`changeChatTo`, `createChatCopyName`, the chat-fold effects),
`src/ts/characters.ts` (`exportChat`, `exportAllChats`, `importChat`, `createBlankChar`),
`src/ts/storage/exportAsDataset.ts`, `src/ts/gui/branches.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`
(`getChar`, `getCharacterFromIndex`, `getChatFromIndex`, `setChar`, `setCharacterToIndex`,
`setChatToIndex`, `parseRisuChat`, `sendChat`, `getDatabase` load first), `src/ts/process/mcp/risuaccess/chats.ts`,
`src/ts/parser/parser.svelte.ts` (its chat lookup by id at 1684-1703), `src/ts/parser/chatVar.svelte.ts`,
`src/ts/util.ts` (`checkPersonaBinded`, 68-82), `src/ts/process/index.svelte.ts` (the job
client's chat reads), `src/ts/process/lorebook.svelte.ts` (the client wrapper), `src/ts/process/inlayScreen.ts`,
`src/ts/process/files/multisend.ts`, `src/ts/process/group.ts`, `src/ts/process/command.ts`, the
UI: `src/lib/ChatScreens/{DefaultChatScreen,Chats,Chat,ChatBody,ChatScreen,Suggestion,PartialEditController}.svelte`,
`src/lib/SideBars/{SideChatList,CharConfig,DevTool,Toggles,CustomSidebar}.svelte`, `src/lib/SideBars/LoreBook/{LoreBookList,LoreBookData}.svelte`,
`src/lib/Others/{ChatList,BookmarkList,AlertComp,HypaV3Modal}.svelte` and `HypaV3Modal/*`,
`src/lib/Setting/Pages/Module/ModuleChatMenu.svelte`, `src/lib/Mobile/MobileCharacters.svelte`,
`src/lang/en.ts`. Tests belong to the review step.

Identifiers (verified 2026-09-30; matching lines, tests excluded): the mirror fields
`character.chats` and `chatPage` (`DeepReadonly`, written only by `chatStore.svelte.ts`;
`.chatPage` in 35 files, 110 lines); the paging: `chatLoadInitialPages` and
`chatLoadAdditionalPages` (`shared/database.ts:484-485`, a `ui` section in Phase 3) read through
`getInitialChatLoadPages`/`getAdditionalChatLoadPages` (`src/ts/chatLoadPages.ts`, defaults 30
and 15) by `DefaultChatScreen.svelte:83-99` into a local `loadPages`, raised at 671-695, 112-122,
939-949; `Chats.svelte:25-45, 77-182` renders `messages.length - 1` down to
`messages.length - loadPages` over the loaded array (a render window, not a fetch). Chat list
readers and their fields: `SideChatList.svelte` (`name`, `id`, `folderId`, `bindedPersona`;
folders from `chatFolders`), `src/lib/Others/ChatList.svelte` (`name`, `id`),
`MobileCharacters.svelte:62` (`chats.length`, the chat count), `BookmarkList.svelte` (selected
chat only), `getChatBranches` (`branches.ts:68-91`: every chat of the selected character with
every `message.data`, `fmIndex`), `AlertComp.svelte` branch hover (`message[data]` of arbitrary
chats of the selected character); `lastDate` (`shared/database.ts:1067`) has no reader. Readers
of non-selected characters' chats: `exportAsDataset.ts:6-24`, plugin `getChar`/`getCharacter`
(`v3.svelte.ts:694-700, 966, 1295`, a snapshot of the context character with its chats),
`getCharacterFromIndex` (1181-1188), `getChatFromIndex` (1198-1208), `parseRisuChat` and
`sendChat` (the context chat), the host `getDatabase` (1059-1073; `includeOnly` defaults to
`"all"`, so the common call includes `characters` with chats), `risu-get-chat-history`
(`risuaccess/chats.ts:43-80`); `exportChat(page)` and `exportAllChats` (`characters.ts:226-426, 574-596`);
the parser's group lookup (`parser.svelte.ts:1684-1703`: the chat by id or `chatPage`, then
`message.length` and the last message's `saying`; synchronous), `checkPersonaBinded(chatRef?)`
(`util.ts:69-82`: the selected or referenced chat's `bindedPersona`). Chat module API:
`findChat` (248), `chatRef` (261), `currentChatRef` (266), `loadSelectionPreference` (870),
`selectChat` (880), `syncChatPage` (896), `seedChats` (1336), `assembleChats` (1352),
`initializeChats` (1392), `reconcileCharacterChats` (1287-1330: looks each incoming chat up
with `mirrorChat(ref)`, creates one it cannot find, deletes loaded chats absent from the list,
reorders), `acceptRemoteChat` (2149), `acceptRemoteCollection` (2218), `finishIdleChatRefresh`
(2202), `isChatDeferred` (2389), `chatEdits.ts` (`editChat(ref)`, `editChatSync(ref)`,
`editCurrentChat`, `setCurrentChatMeta`), `useLocalLoreDraft()` (tracks
`character.chats[character.chatPage]`). Server reads: `readAll()` (`chatStore.ts:870-896`) loads
every message row; `readChat` and `readCollection` (899-928) load all messages of the named
chats; the metadata-only prepared selects exist (`selectChat` 390, `selectCharacterChats` 430);
no route returns metadata without messages. The plugin bridge is asynchronous (`risuai.d.ts:1294, 1312, 1324, 1342`
declare Promises; `factory.ts` awaits host results), so a host getter may await a load.

Stopping condition: a synchronous reader of a non-selected chat that cannot be preloaded by its
caller (recorded; that reader stays a stopping condition and never receives incomplete data).

## Assumptions

- After `character-ownership` and `readers-characters` the character readers use the records;
  this slice removes `chats`/`chatPage` from the record type and `pnpm check` lists every
  remaining chat reader.
- Phase 5: the client sends by creating a job with the chat id; `applyServerGeneration` writes
  into the loaded selected chat.
- Phase 4 (verified): the plugin setters `setChar`, `setCharacterToIndex`, and
  `setDatabase({ characters })` call `replaceCharacterFields` plus `reconcileCharacterChats` (the
  writers under lazy loading, Opus P7); `pluginContext.ts` names the hook's character
  (`currentContext(pluginName)`, set by the runners through `invokeHook(fn, context)`).
- `live-updates` delivers chat refs with revisions; a loaded chat is refreshed through the idle
  refresh, an unloaded one refreshes its summary.

## Proposed decisions

- Summary contract (Opus P10): `ChatSummary = { characterId, id, revision, name, folderId, bindedPersona, fmIndex }`,
  the stored `meta` projected (`shared/chats.ts`); no aggregate query, no `hypaV2Data`,
  `hypaV3Data`, memory or bookmark data. The boot read `readKinds(kinds, { chatSummaries: true })`
  returns every summary and every chat order instead of every chat; `readRefs(refs, { chats })`
  (existing) loads full chats; `chatSummaryCollections` refreshes one character's list. The chat
  count is the order record's id count.
- Client model (Astra P9): per character an ordered `ChatSummary[]` and a `Map<chatId, Chat>` of
  loaded chats; the LRU (8 per tab) bounds evictable entries only: a chat that is selected,
  dirty, in flight, deferred, quarantined, generating, or pinned is never evicted; `pinChats(chaId)`
  returns a release function for a consumer that must see a complete set while it works.
  `chatList(chaId)` returns summaries, `selectedChat` the loaded full chat (or `null` while
  loading; the chat screen shows its loading state), `findChat(ref)` the loaded chat or
  `undefined`, `loadChat(ref)`/`loadChats(chaId)` fetch and adopt the revision,
  `ensureChatLoaded(ref)` the awaitable form. `readChatsDetached(chaIds)` is a bulk server read
  that bypasses the cache and returns plain chats for exports and plugin snapshots (complete
  whatever the LRU holds). A summary is a distinct type; nothing exposes it as `Chat`.
  `selectChat(chaId, chatId)` loads then selects; the `localStorage` preference stays a boot
  preference. Prefetch: on `selectCharacter`, that character's selected chat only.
- Compatibility views (Astra P9): the facade's `DBState.db.characters[i].chats` and `chatPage`
  (until `aggregate-removal`) and the plugin snapshots (`getChar`, `getCharacterFromIndex`,
  `getChatFromIndex`, `getDatabase`) build a legacy `chats` array and a derived `chatPage` at
  the boundary from `readChatsDetached` (plugins) or the loaded map (the facade, which serves
  only readers this slice has not moved yet; each is moved in this slice, so the facade's chat
  view is transitional within it).
- Plugin writers (Opus P7): `setChar`, `setCharacterToIndex`, and `setDatabase({ characters })`
  await `loadChats(chaId)` and pin the chats for the duration of `reconcileCharacterChats`, which
  decides membership from the chat order record (a chat present on the server but not loaded is
  loaded, not recreated; a chat absent from the plugin's list is deleted through the order, not
  through the loaded map). Plugin `getDatabase()` with `characters` (the default `"all"`) does a
  one-off `readKinds` with chats bypassing the cache (Opus P11; the cost is today's boot read,
  documented in `plugins.md`).
- Readers of non-selected chats (decided by the phase file; list from the tree):
  `exportAsDataset` and `exportAllChats` use `readChatsDetached`; `risu-get-chat-history` awaits
  `ensureChatLoaded` of the target character's selected chat; `getChatBranches` and the
  `AlertComp` branch hover call `loadChats` and pin; `risuChatParser` and `checkPersonaBinded`
  read loaded chats only: their chat is the selected chat or the `chatRef` chat, which is loaded
  by the time they run (recorded as the rule; Opus P10). Paging stays the render window in
  `DefaultChatScreen.svelte` and `Chats.svelte` over the loaded selected chat.
- `chatPage` (decided by the phase file): the derived index is removed; readers use
  `selectedChat`, `chatList`, and the selection; `changeChatTo(index)` maps the index over
  `chatList`. `character.chats` and `chatPage` leave `shared/database.ts`.
- `chatEdits.ts` and `useLocalLoreDraft`: unchanged API; `editChat(ref)` awaits
  `ensureChatLoaded` first; the draft tracks `selectedChat`.

## Validation

`pnpm check` (the removed fields list every reader), `pnpm test`, `pnpm format:check`,
`pnpm build`. Review-step tests: `server/src/tests/chatStore.test.ts` gains the summary reads (no
message rows, no memory data in the payload); `chatStore.test.ts` (client) gains the summary
list, `loadChat` adopting the revision, the LRU never evicting a selected, busy, or pinned chat,
`readChatsDetached` complete with more than eight chats across several characters,
`ensureChatLoaded` before a plugin getter, `setChar` after an eviction (the plugin's change to an
evicted chat is applied, not turned into a conflicting create), a plugin list omitting an
unloaded chat (deleted through the order), `selectChat` on an unloaded chat, a live event
refreshing a summary and a loaded chat, `acceptRemoteCollection` over summaries;
`exportAsDataset` over a fixture with unloaded chats. Manual, recorded here: a character with 30
chats and one 2,000-message chat: boot time and memory before and after; switching chats,
branch view, bookmarks, the HypaV3 modal, dataset export, a plugin calling `getChar` and
`setChar`, the MCP chat history tool, a send while another chat of the same character is
unloaded, two tabs converging on a chat rename. Scoped gate:
`rg -n '\.chatPage|\.chats\[' src` outside `chatStore.svelte.ts` and `forwarding.svelte.ts`
returns nothing.

## Residual risk

Plugin getters that used to be instantaneous now await a server read the first time; a plugin
that calls `getChar` in a tight loop is slower (documented). The `localStorage` chat preference
keeps naming chats by id; an id another tab deleted falls back to the first chat as today. The
facade's transitional chat view exists only inside this slice.

## Implementation notes, 9a (2026-10-05)

Split per `implementation-plan.md` "Slice 9a": the chats move out of the character records and every
reader moves; boot stays eager (`readKinds(kinds, { chats: true })`).

- **The chat module's store.**
  - `chatStore.svelte.ts` holds, per character, `{ ids, chats }` in `$state`: the ids in order are
    the membership, `chats` the loaded chats by id (every member is loaded in 9a, every loaded chat
    is a member).
  - The selected chat id per character is a reactive map (`chosen`). The index (`chatPage`) is
    derived and is no longer stored; `syncChatPage` is gone. A membership change that removes the
    chosen chat falls back to the first chat. A reorder keeps it. A read never writes it.
  - Every membership rule (the last-chat guard, the reorder permutation, reconciliation,
    normalization, the work indexes) reads the ids. A load never adds a chat to a list: a chat that
    is not a member is not fetched by `ensureChatLoaded`, and `loadChat` reads its character's whole
    list instead (`applyRemoteCollection`).
- **Readers.** `chatList(chaId)` (`ChatListEntry`: `id`, `name`, `folderId`, `bindedPersona`,
  `fmIndex`; no revision), `chatCount`, `selectedChatId`, `selectedChatIndex`, `selectedChat()`,
  `findChat`, and `currentChatRef()` (through `selection.characterId`).
- **Loading.**
  - `ensureChatLoaded(ref)` returns a listed chat at once in 9a.
  - `loadChat(ref)` adopts a read under `finishIdleChatRefresh`'s safeguards (`adoptChatRead`).
  - `loadChats(chaId)` resolves at once with the current local list (it does not refresh).
  - `pinChats(chaId)` counts consumers; eviction (9b) will read it.
- **Detached reads.** `readChatsDetached(chaIds)` (`chatEdits.ts`):
  - It flushes first, and refuses when the flush fails or a discard names `characters/<id>`,
    `chats/<id>`, or `chats/<id>/…` of the requested characters.
  - It then reads `chatCollections`, chunked by 500, and rebuilds each order with the assembly rule
    (`orderChats`). An empty request reads nothing.
- **Records** (`records.svelte.ts`).
  - The raw character objects hold no `chats`/`chatPage`. They are stripped at
    `initializeRecords`, `storedCharacter` (also the same-owner shortcut, which never has them), and
    `applyRawCharacter`.
  - A character wrapper answers both from the view the chat module registers
    (`setCharacterChatView`). The view is not an own key, so snapshots, spreads, JSON, and the save
    projection are chat-free (the projection keeps its exclusion as a defense).
  - Setting, defining, or deleting either field on a wrapper throws.
  - `reloadKeys` stays a raw local field.
- **Characters** (`characterStore.svelte.ts`).
  - `ClientCharacter`/`ClientGroup`/`AnyClientCharacter` (the shared shape `Omit` `chats` and
    `chatPage`) are the readers' types. `shared/database.ts` is unchanged (R12).
  - `prepareNewCharacter` keeps the chats apart (`PreparedCharacter.chats`). `addPreparedCharacter`
    and `replaceCharacterAt` hand them to `installCharacterChats` after every refusing check and
    before inserting the record, and on a throw drop them with `forgetCharacterChats`.
  - `replaceCharacterFields` filters the input through `INPUT_EXCLUDED` (`chats`, `chatPage`,
    `reloadKeys`).
- **Boot.** `assembleDatabase` assembles chat-free characters and calls `assembleChats`, which
  replaces the module's store and clears its pins.
- **Server.**
  - `ChatSummary` (`shared/chats.ts`): `characterId`, `id`, `revision`, `name` (default `""`),
    `folderId?`, `bindedPersona?`, `fmIndex` (default -1).
  - `readSummaries`/`readCollectionSummaries` pick those fields from the stored metadata, read no
    message rows, and put no memory, bookmarks, or `toolCalls` in the response.
  - `readKinds(..., { chatSummaries })` and `GET ?chatSummaries=1`: a 400 together with `chats=1`.
  - `readRefs(..., { chatSummaryCollections })` and the POST body field: validated like
    `chatCollections`, counted in the cap, and in the result only when asked.
  - Nothing on the client calls them yet (9b's boot).
- **Plugins** (`v3.svelte.ts`).
  - `getChar`/`getCharacter`, `getCharacterFromIndex`, and `getDatabase` with `characters` capture
    their targets by id, pin, await `loadChats`, then build detached legacy copies from the store
    (`withChatsCopy`).
  - `getChatFromIndex`, `setChatToIndex`, `parseRisuChat`, and `sendChat` capture the chat by id,
    refuse a gone hook target at once (`PluginTargetGoneError`), and await `ensureChatLoaded`.
  - The setters capture, pin, load, then apply synchronously inside the existing batch and refusal
    machinery (`withChatsLoaded`), and return Promises.
  - The hook's chat for `getCurrentLorebookEntries`, `contextTarget`, and the index reads come from
    `chatList`.
- **Other readers.**
  - The chat screen, its rows, the chat lists (`SideChatList`, `ChatList`, by id, `data-risu-chat-idx`
    into `chatList`), bookmarks, the HypaV3 modal, the alert's generation info and HypaV2 editor,
    DevTool, CharConfig, the lorebook settings, the module chat menu, `CustomSidebar`, and
    `Suggestion` (its request is now tracked by chat id) read `selectedChat()`/`chatList()`.
  - `changeChatTo` keeps its id-or-index overload. `exportChat` takes a chat id. `exportAllChats` and
    `exportAsDataset` read detached.
  - The branch view pins the character's chats before `loadChats` and renders `getChatBranches(chaId)`
    by chat id; the pin is released on close.
  - `addGroupChar` writes the captured group's selected chat.
  - The MCP host's `currentMessages` loads the character's selected chat. The shared RisuAccess host
    contract reads chat-free characters (`RisuAccessCharacter`).
  - `jobChannel` (the reload notice, the `selectedChat` callback, `chatOutput` with `withChatsCopy`
    for the speaker), `chatVar`, `checkPersonaBinded`, `getModules`, `localLoreDraft`, the module
    effect in `stores.svelte.ts`, the fold effects, and the request's chat ref read the module.
  - The shared CBS evaluator gets the legacy shape through `withCompatChats` (`risuChatParser`,
    `risuChatParserScoped`, `findCharacterById`). Chat-independent parameters are widened to the
    client type.
- **Synchronous readers that need a loaded chat.** `capturePluginContext`, `transformClient`'s
  context, the MCP tool records (`encodeToolCall`/`decodeToolCall`), the commands, the CBS host, and
  `checkPersonaBinded` read a loaded chat synchronously. In 9a boot loads every chat. 9b must pin and
  load the selected or referenced chat before each of them runs.

### After the challenge

Astra's challenge (2026-10-05) raised ten points; all were fixed:

1. The held dictionaries key ids through `slot()` (a `#` prefix). An id named like an
   `Object.prototype` member is an own key. The `$state` objects stay deeply reactive.
2. Outside a hook, `parseRisuChat` and `sendChat` pass the captured chat (`chatRef`, the send's
   `target`, the transform's `chatRef`), so a selection change during the load does not redirect them.
3. A local removal (`removeCharacter`, `removeCharacters`) and a replacement with another id
   (`replaceCharacterAt`) drop the old character's held chats at once (`forgetCharacterChats`). Chat
   writes (`requireChat`) also need the chat's owner in the list.
4. `getChatFromIndex`, `editChat`, `exportChat`, and the chat list's copy find their chat again after
   the load.
5. `setChar` resolves the hook's reported `chatPage` before the load. The database setters capture the
   existing characters they reconcile, and skip, with a warning, an entry whose character was deleted
   during the load (it is never recreated).
6. `getDatabase` loads first, then reads every requested key in one synchronous pass.
7. Loads are fenced on the owner's lifetime (`lifetimeOf`: renewed on install and forget, and by every
   boot assembly).
8. The chat list's options menu is one handler that captures the chat before its dialogs. It copies
   into the captured owner (`createChatCopyName` takes the owner) and selects the copy only when that
   character is still selected.
9. Pins count per lifetime: a release from before a reset never takes a later pin.
10. The branch view loads untracked, so its effect follows the alert only.

### Deviations

- **The facade view stays until `aggregate-removal`.** R14 moved the CBS host to slice 10, so the
  shared registry's `contextChat` and the evaluator's group path still read
  `DBState.db.characters[i].chats`. The spec's "transitional within" 9a no longer holds.
- **Plugin getters build from the store, not `readChatsDetached`.** Single-character getters and
  `getDatabase` keep today's local reads with no global save dependency (Astra's plan review,
  point 5). Whether `getDatabase` reads detached under eviction is 9b's decision; P11's detached
  `readKinds` is not used.
- **`reloadKeys` stays on the client type.** It is a render key the UI reads, so the client view
  type keeps it and is documented as not the persisted record type.
- **`Suggestion`'s stale-request cancel** compares chat ids. The old index check skipped the first
  chat (`> 0`).
- **`exportLoreBook("sglobal")`** keeps throwing as before (it reads no chat).

### Measurements

These are production builds in headless Chrome, against the slice 8 build (`1ab264df`), two runs
each.

`util/playwright/measureChats.mjs` (new): 50 characters, one with 30 chats, one of which has 2,000
messages; a 200-chunk server stream.

| Workload                                   | Baseline (`1ab264df`) | This slice     |
| ------------------------------------------ | --------------------- | -------------- |
| Boot until the sidebar shows (median of 3) | 525 / 524 ms          | 489 / 512 ms   |
| JS heap after a collection                 | 13.1 / 13.1 MB        | 13.1 / 13.1 MB |
| Switch to the 2,000-message chat           | 39.7 / 37.7 ms        | 37.1 / 37.2 ms |
| Switch to a 20-message chat                | 31.8 / 30.8 ms        | 30.8 / 31.4 ms |
| Select the 30-chat character               | 33.3 / 32.9 ms        | 31.7 / 32.5 ms |
| Frame interval while streaming (p95)       | 16.8 / 16.7 ms        | 16.8 / 16.8 ms |
| Long tasks while streaming                 | 0 / 0                 | 0 / 0          |

`util/playwright/measureCharacters.mjs`, the slice 8 workloads:

| Workload                         | Baseline (`1ab264df`) | This slice       |
| -------------------------------- | --------------------- | ---------------- |
| Select the big character         | 34.5 / 36.4 ms        | 35.7 / 33.8 ms   |
| Select a small character         | 7.0 / 7.3 ms          | 7.2 / 7.7 ms     |
| A keystroke into the description | 9.9 / 9.9 ms          | 9.9 / 9.7 ms     |
| Lorebook drag, 300 entries       | 106.7 / 108.4 ms      | 117.9 / 108.7 ms |

Every check passed in all eight runs.

### Review

The review found no problem. It added three test files:

- `server/src/tests/chatSummaries.test.ts`: the summary reads and their route validation.
- `src/ts/storage/tests/chatProjection.test.ts`: the chat-free records, list reactivity,
  selection, loading and its fences, pins, cleanup, prototype-named ids, the remote collection
  paths, `readChatsDetached`, and `exportAsDataset`.
- `src/ts/plugins/apiV3/hostApiChats.test.ts`: the plugin getters and setters over the chat
  module.

The reviewer drove these checks in the browser: switching chats, bookmarks, the branch view and
its pin, the HypaV3 modal, dataset export, the MCP chat history tool, a send while another chat of
the same character is selected, and two tabs converging on chat renames. All passed with no page
error. A plugin calling `getChar` and `setChar` is covered by the tests, not by the browser.
