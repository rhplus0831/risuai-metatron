# Slice: Chat Projection And Lazy Loading

Status: 9a implemented (2026-10-05; records and readers, eager boot); 9b implemented (2026-10-07; summaries at boot, pins, LRU).

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

## Implementation notes, 9b (2026-10-07)

Split per `implementation-plan.md` "Slice 9b". Boot reads summaries, chats load on demand, and idle
loaded chats are evicted.

- **The store.** Per character the module holds the ids in order (the membership), the loaded chats,
  and the summaries of the chats that are not loaded (`ChatEntryMeta`: the list fields). Every member
  is in exactly one of the two. `chatRevisions` keeps a revision for every server chat, loaded or
  not, so the save loop's membership rules (order readiness, reorder permutations, acknowledgement
  of orders, the reconcile listing) are unchanged.
- **Boot.** `readKinds(kinds, { chatSummaries: true })`; `seedChats` and `assembleChats` take the
  summaries (a whole `ChatRecord` is still held loaded, as tests and the eager path give them). Boot
  ends at home, so no chat is loaded by the snapshot itself.
- **Readers.** `chatList` and the new `chatEntry(ref)` read the loaded chat or the summary.
  `withChatsCopy` throws unless every chat of the character is loaded; the facade view and
  `withCompatChats` give the loaded chats and the selected chat's index among them (-1 when it is not
  loaded), so the shared CBS readers find a chat by id or the selected one, or nothing.
- **Writes on unloaded chats.** `setChatMeta` on a chat that is not loaded accepts the list fields
  only (`name`, `folderId`, `bindedPersona`, `fmIndex`, typed as the summary holds them, checked
  before anything changes): the summary changes and the same `meta` op is queued. The chat lists
  rename, refile, and bind personas without loading the chat. Everything else needs the chat loaded.
- **Loading.** `loadChat`, `ensureChatLoaded`, and `loadChats` (500 per request) read unloaded
  members and install them (`installRead`). A read older than the held revision is read again (three
  times at most, then the load rejects). A chat with local work keeps its list fields: the summary
  is laid over the read. A gone chat is removed under the issued-revision fence and the character's
  summary list is read so its replacement is found. Every step is fenced on the owner's lifetime,
  and a fenced load resolves to `undefined`. Concurrent loads of one chat share one read.
- **Server copies never load a chat.** `applyRemoteChat` and a job's chat event (`hydrateChat`) give
  an unloaded member its summary and revision. `applyRemoteCollection` (live) and
  `acceptRemoteCollection` (recovery) iterate the members, take whole chats or summaries, keep
  their separate rules, and mark a loaded chat that a summary list shows newer as stale instead of
  replacing it. The save loop reads summary lists (`chatSummaryCollections`) for live collections,
  recovered characters, and new characters. `noteRemoteChat` records a notice for an unloaded
  member and answers `"collection"`; idle stale or noticed unloaded chats are refreshed through their
  character's summary list (`idleSummaryRefreshes`, `settleSummaryRefresh`), loaded ones whole.
- **Pins and eviction.** `pinChat(ref)` joins `pinChats(chaId)`. `trimLoadedChats` keeps at most
  eight idle loaded chats (least recently used first: stamped at a load, a selection, and a cached
  `ensureChatLoaded`). It is scheduled after a load, a pin release, every save cycle, and every
  selection change, never synchronously, so a caller reading right after its release still finds its
  chat. The loaded chats are tracked in a set, so a trim with eight or fewer costs nothing.
- **Selection.** Selecting a character or a chat is immediate; the selected chat is loaded when it
  is not (`selectedChatLoad`, `retrySelectedChatLoad`). The chat screen renders nothing
  chat-dependent until it is here; the sidebars, the alert's generation info and HypaV2 editor, the
  module menu, DevTool, the lorebook settings, and the HypaV3 modal (mounted only with a loaded chat)
  tolerate a null selected chat. `setGlobalChatVar` and `loadLoreBookV3Prompt` refuse while the
  selected chat loads.
- **Jobs.** `runServerJob` pins its target from the start and loads it before the job is created (a
  failed load alerts and runs nothing). `followJobToEnd` pins the job's chat once it is known and
  loads it (retried like `discover`, then the job is lost), through every reconnect and the
  terminal's hydration; a command job's `/multisend` follow-ups take their own pin before their first
  await. `sendChatOnServer` checks the membership (`chatEntry`), not a loaded chat, and pins until it
  has read the reply's alternatives.
- **Other readers.** `processMultiCommand` pins its chat for the whole line. `requestServer` pins
  the request's chat and its parse chat from its start until its event stream ends. `editChat` pins
  through its callback. The group output listeners' speaker is loaded before each listener.
  `checkPersonaBinded` and `capturePluginContext` read the bound persona from the list entry. The
  bookmark rename and the message actions load their captured chat again after their awaits.
  `withChatsLoaded` (plugins) checks every target again right before its synchronous pass.

### Plan review, 9b

Astra's plan review (2026-10-07) raised fifteen points: eleven were adopted as raised, three with
changes (points 2, 13, and 15: Stop C's Docker smoke and allowlist run at the stop after this
slice, as Stop B's did), and one was deferred:

- **Point 14, deferred.** The job channel keeps every job's hydration records (`jobChannel.ts`
  `hydrations`) for the tab's lifetime. This predates 9b; it limits the memory the LRU saves after
  many jobs. Recorded as a follow-up.
- **Point 2, with changes.** No op replay: an unloaded chat's summary is the local truth of its list
  fields (a busy member's summary is never replaced remotely), laid over a read installed while the
  chat is busy.

### After the challenge, 9b

Astra's challenge (2026-10-07) raised eleven points; all were fixed:

1. A load installed while the chat has local work lays the summary over the read and marks the chat
   stale (read whole once idle); its notice is not settled.
2. A save acknowledgement never moves a held revision back (a load may have installed a later read
   while the group was in flight).
3. `settleSummaryRefresh(collection, notices)` ends only the marks the applied list answers: a member
   it shows at or below the held revision, or one it no longer lists; nothing for a list older than
   the held order; a notice only when it predates the read and is covered.
4. `chatOwnerToken(chaId)`: `editChat` and the plugin `withChatsLoaded` refuse to continue into a
   character whose chats were replaced (even under the same ids) while they loaded.
5. `requestChatData` pins and loads its chat before tool discovery and the plugin hooks, through the
   provider and the after-request hooks. The plugin host's pre-load checks (`contextMember`) treat an
   unloaded member as present.
6. `getCurrentLorebookEntries` is async and loads its chat first (its local and chat-module lore).
7. `loadLoreBookV3Prompt` pins its chat for the whole activation; `importLoreBook` loads its captured
   chat again after the file dialog.
8. The branch action writes the folder and the copy name in the chat's own character and selects the
   branch there by id (no `changeChatTo(0)` on whatever is selected).
9. `requestServer` refuses before the POST when a captured chat is gone after the flush.
10. The selected-chat load has a request token and the owner lifetime: only the latest request
    reports, and a load that ended without the chat shows "not available" with a retry.
11. The held revisions are grouped per character in one pass (`heldChatRevisionsByCharacter`).

The first re-check found six more holes, all fixed:

- A chat baseline records its owner, and `applyChatResult` drops a result whose owner changed,
  centrally for `editChat` and every other baseline consumer.
- The owner token is carried through:
  - the plugin lore getter, `parseRisuChat`, and `sendChat`;
  - the local lore import and the lore activation (its variable and CBS callbacks refuse a changed
    owner, and the result is dropped);
  - the branch action;
  - the request path: `withRequestChat` in `request.ts`, and the transport's checks before the POST.
- Tool discovery and tool calls follow the request's chat (`getTools(chatRef)`,
  `callTool(..., chatRef)`, down to `getModuleMcps(chatRef)`), not the selection. A request that
  names only a plugin context uses that context's chat. `runLLMModel` runs inside `withRequestChat`.
- The branch selects its result only while its character's selection did not change
  (`chatSelectionVersion`).
- Retrying the selected chat's load joins a load still running instead of orphaning its report.
- A `cbs` callback that names another chat loads it, pinned, for the parse.

The second re-check found two more, both fixed:

- **A request keeps its chat's identity to the end.** `requestChatData` records the chat's owner
  (`arg.chatOwner`) when it begins. The tool discovery, every before- and after-request hook, the
  reply, the transport (before the POST), and every event callback and tool record check it, and
  refuse a chat replaced meanwhile. A plugin hook's context carries its chat's owner too
  (`PluginCallContext.owner`), and the host functions refuse a replaced chat.
- **MCP tool listing and calls work on their own clients.** `syncMCPs` answers the clients of the
  call's chat and leases them while they are used. An initialization for another chat no longer
  destroys a client in use (it is destroyed when its last consumer ends), and no call reads another
  chat's client set from the shared registry.

The third re-check found two last gaps in the request path, both fixed. The fourth closed the
challenge.

- **Callbacks.** An MCP or CBS callback's answer is refused once the request's chat is gone or
  replaced, also after the work (a tool that ran is not undone; its answer is not accepted).
- **Results.** `withRequestChat` accepts a result only while its chat is the one the request began
  with; it covers the direct `runLLMModel` route and plugin providers. An accepted stream is wrapped
  (`guardStream`): it checks the identity on every chunk and at its end, and keeps the chat pinned
  until it ends, fails, or is cancelled.
- **The transport** refuses result and stream events for a replaced chat.
- **Retries.** Every attempt starts with the identity check, a retry after its wait included.

### Deviations, 9b

- **Point 13: chat selection is immediate, not load-then-select.** A load never selects. The latest
  selection is the selection, and no input reaches the chat selected before. The chat screen shows
  the loading state instead of the previous chat.

### Measurements, 9b

These are production builds in headless Chrome, against the 9a build (`9cf80cdb`), two runs each,
on the final tree (after the challenge fixes).

`util/playwright/measureChats.mjs` (it gained the cold switch: each of 28 other 20-message chats
once, until its chat screen shows):

| Workload                                   | Baseline (`9cf80cdb`) | This slice     |
| ------------------------------------------ | --------------------- | -------------- |
| Boot until the sidebar shows (median of 3) | 513 / 520 ms          | 513 / 517 ms   |
| JS heap after a collection                 | 13.1 / 13.2 MB        | 12.3 / 12.3 MB |
| Switch to the 2,000-message chat (loaded)  | 37.3 / 38.7 ms        | 39.8 / 38.9 ms |
| Switch to a 20-message chat (loaded)       | 31.1 / 30.6 ms        | 32.5 / 31.2 ms |
| Cold switch until the chat shows           | 26.2 / 26.0 ms        | 40.2 / 40.4 ms |
| Frame interval while streaming (p95)       | 16.7 / 16.7 ms        | 16.7 / 16.8 ms |
| Long tasks while streaming                 | 0 / 0                 | 0 / 0          |
| Select the 30-chat character               | 26.2 / 27.5 ms        | 27.8 / 26.7 ms |

The cold switch now includes the chat's read (a local round trip); the screen shows the loading
state meanwhile.

`util/playwright/measureCharacters.mjs`:

| Workload                         | Baseline (`9cf80cdb`) | This slice       |
| -------------------------------- | --------------------- | ---------------- |
| Select the big character         | 35.3 / 34.4 ms        | 33.6 / 36.5 ms   |
| Select a small character         | 7.1 / 8.2 ms          | 9.0 / 7.8 ms     |
| A keystroke into the description | 10.0 / 10.5 ms        | 10.0 / 10.8 ms   |
| Lorebook drag, 300 entries       | 118.9 / 103.9 ms      | 103.1 / 104.8 ms |

A first version scanned every held character on each selection's trim and made character
selection 12 ms slower; the loaded-chat set removed it.

### Review, 9b

The review found no problem and judged the immediate selection (deviation, point 13) right. The
adapter's harness boots still read whole chats, so the new store tests boot from summaries. The
review added:

- `src/ts/storage/tests/chatLazyLoading.test.ts`: the summary boot, immediate selection and its
  retry, list-field writes on summaries, loading and its fences (an older read, the busy overlay,
  owner replacement), and eviction with every exclusion.
- `src/ts/storage/tests/resourceSyncLazyChats.test.ts`: the save loop and change feed over
  summaries (refresh through the summary list, convergence of a busy unloaded chat, the own-save
  echo's cost, detached reads and the dataset export beyond the cap, `editChat`).
- `src/ts/process/request/tests/requestChat.test.ts`: `withRequestChat` and the guarded stream.
- `src/ts/process/mcp/tests/mcpLeases.test.ts`: the per-call MCP client leases.
- `e2e/lazyChats.spec.ts`: the summary boot, cold switches, the eight-chat cap, a rename and a send
  beside unloaded chats, two clients converging, the MCP history host, the dataset export, and the
  HypaV3 modal across a cold switch.
- Cases in `hostApiChats.test.ts` (unloaded getters, `setChar` after an eviction, owner replacement
  during a load), `transport.test.ts` (an unloaded `cbs` target, replacement during the flush, a
  late MCP answer, a stream after a replacement), and `serverCommands.test.ts` (the job pins and
  loads).

The reviewer drove a production build in the browser: no chat read at home; the heap at 12.3 MB at
home, 18.5 MB with the 2,000-message chat shown, and 18.0 MB after ten cold switches had evicted it;
the loading state under injected latency; the error with a working retry; the branch view reading
its 21 unloaded chats in one request and releasing them; bookmarks; a send beside an unloaded chat
reading no other chat; and two tabs converging on renames through summary reads. All passed with no
page error.

Recorded, not fixed:

- `exportLoreBook("local")` still dereferences the selected chat while it loads; the `try`/`catch`
  turns it into an error alert.
- This tab's own save of an unloaded chat's list field costs one summary-list read of its character.
- A loaded idle chat with a notice is read whole before it can be evicted.
- The job channel's `hydrations` retention (plan review point 14) stays deferred.
