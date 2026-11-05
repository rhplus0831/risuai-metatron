# Plugin Storage and Data API Plan

Status: drafted 2026-11-05; landed: 0 (c140f2db7), 1 (d5c824f99). Decisions D1–D12 are recommendations for the owner; the **Open
questions** Q1–Q5 were answered by the owner on 2026-11-05 (the recommended option each time). Code anchors checked at `7f0024197` on `dev`; verify them again before editing
(STRUCTURE.md protocol step 5).

Sources: the [RisuNest ideas](../research/risunest-ideas.md) items 11 (plugin storage isolation, device spaces, data
manager), 19b (plugin read scalability), 19c (permission reset) and 19d (plugin iframe browser spec), and its open
question 5 (whether a plugin in use reads another plugin's keys on purpose); the
[HaejeokRisuai survey](../research/haejeok-feature-survey.md) C4 (plugin storage explorer and per-key sync patches)
and C5 (batched `getDatabase` transfer); the [PocketRisu/RisuBard picks](../research/pocketrisu-risubard-picks.md)
"adopt as policy" rows on `pluginCustomStorage` defaults and key-merging `setDatabase` (a Module Manager round trip
there wiped 255 keys to 0) and on per-plugin permission resets; the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md) ST01 (large nested values are
the unit of transfer: toggling one plugin's `enabled` sends about 1.02 MB of all plugins, a counter next to a 2 MiB
plugin history about 2.05 MB, measured with its `probes/sync-traffic-measure.mjs` fixture of 300 characters, 3,000
chats and 10 plugins) and ST07 (the default `getDatabase()` loads the library one character at a time); a
2026-11-05 review of the `getDatabase` path in this session and a second agent's review of the same path (its cost
layers, the reuse of `readChatsDetached`, the second load in `setDatabase`, the hook flush rule), both re-checked
against the code below; the [plugin sandbox guide](../structure/plugin-sandbox.md) (State, Database setters,
Invariants, Gotchas), the [resource sync guide](../structure/resource-sync.md) (Record patches, Record merge,
flushResources), the [chat store guide](../structure/chat-store.md) (Pins and eviction, Summaries and refresh,
Whole-chat writers) and the [plugin author guide](../../plugins.md) (Data Storage, Database Access, Permissions).

Owning guides when sliced: [plugin sandbox](../structure/plugin-sandbox.md) (the storage namespaces and their owner,
the reserved dictionaries on `setDatabase`, permission revocation, the `getDatabase` read paths and their reuse, the
scoped read options, the plugin data page, the browser spec's place in `Tests`) and the
[plugin author guide](../../plugins.md) (every contract change a plugin can observe);
[resource sync](../structure/resource-sync.md) (the nested record patch of `pluginStorage` and the by-name item
patch of `plugins`); [chat store](../structure/chat-store.md) (the detached chat read the plugin path shares with
exports); [server resources](../structure/server-resources.md) (the server half of the nested patch, the
`pluginStorage` normalization of the new reserved dictionary, the `pluginPermissions` revoke);
[backup sync hub](../structure/backup-sync-hub.md) (the upstream export leaving the new dictionary out, as it does
`_pluginStorage`); [test harness](../structure/test-harness.md) (the measurement driver, the sandbox browser spec).

Relation to other work: no active plan edits `src/ts/plugins/`, `src/ts/storage/pluginStorageStore.svelte.ts` or
`src/lib/Setting/Pages/PluginSettings.svelte`. The [Incremental Chat Transport plan](incremental-chat-transport.md)
Slice 0 owns the per-chat position index in `chatStore.svelte.ts`; this plan reads the chat store through its
exports (`heldChatRefs`, `chatsLoaded`, the summaries) and adds at most one read-only export there, so a rebase, not
a conflict. The [Asset Lifecycle plan](asset-lifecycle.md) marks assets from every text column of the live store, the
`pluginStorage` record included; the new reserved dictionary (D6) is a field of that record and needs nothing from
it. The [Guides To Source plan](../archived-plan/README.md) rewrote `plugin-sandbox` and `resource-sync` in its wave 3
(landed 2026-11-05): a slice here that edits either guide checks that rewrite's ledger (`pnpm docs:ledger`). The [Job Handoff plan](job-handoff.md) moves the owner role of a running
job; the hook rule of D7 keys on "inside a hook", which a handed-off owner keeps.

## Goal

Plugins stop sharing one undivided storage space, stop resending all of it on every write, and stop paying for the
whole library on every database read, without breaking the plugins people already run:

- **The user can see and remove plugin data and consent.** A plugin data page lists what every storage namespace
  holds, by size, with search and delete; a plugin's permission grants can be reset, and removing a plugin can take
  its data and grants with it.
- **A storage write sends what changed.** A `pluginStorage` write of one key sends that key, not the dictionary; a
  plugin toggle sends that plugin, not the list.
- **A plugin's `pluginStorage` is its own.** Two plugins using the same key no longer overwrite each other, and one
  plugin's `clear()` no longer empties every plugin's values. The documented shared channels (`safeLocalStorage`,
  `getLocalPluginStorage()`) stay shared.
- **`getDatabase()` with characters is bounded by what changed.** Unloaded chats are read in a few batched requests
  as plain copies that are never installed, pinned or evicted; a later call re-reads only chats whose revision moved;
  the result is unchanged for the plugin.
- **New plugins have a cheap path.** A read option returns characters with chat summaries instead of chats, and a
  paged chat read covers what needs messages.
- **The sandbox's isolation is checked in a real browser.**

Not goals: a server-side plugin runtime (retired, see [the archive](../archived-plan/README.md)), a streamed transfer
of results into the iframe, device-local large storage spaces, per-plugin server records, changing the default of
`getDatabase()` without arguments, and reviewing what consented capabilities reach (the guide's Issues entry on
`mainDom` and `nativeFetch`).

## Current state

The baseline is `7f0024197` on `dev` (2026-11-05).

### Storage namespaces

- `pluginStorage` is one settings record (`RESOURCE_KIND.pluginStorage`, normalized by `requireObject` in
  `server/src/data/kinds.ts`), exposed to plugins as `pluginCustomStorage`. It holds three namespaces
  (`src/ts/storage/pluginStorageStore.svelte.ts`, the module comment):
  - the top level: custom keys a plugin's `setDatabase`/`setDatabaseLite` stores (`setPluginCustomValue`, any key
    outside `allowedDbKeys`);
  - `_pluginStorage` (`PLUGIN_STORAGE_KEY`): the v3 `risuai.pluginStorage` values;
  - `_safeLocalPluginStorage` (`SAFE_LOCAL_PLUGIN_STORAGE_KEY`): the `getLocalPluginStorage()` values.
- `safeLocalStorage` (`SafeLocalStorage` in `src/ts/plugins/pluginSafeClass.ts`) is raw browser `localStorage` under
  `safe_plugin_<key>`; its `clear()` removes every `safe_plugin_` key.
- No key carries an owner. The host functions `_getPluginStorage`, `_setPluginStorage`, `_clearPluginStorage` and the
  others in `makeRisuaiAPIV3` (`src/ts/plugins/apiV3/v3.svelte.ts`) pass the plugin's key straight through, although
  the instance's `identity` (`{ name, script }`) is in scope. `clearPluginStorage` sets `_pluginStorage` to `{}`: one
  plugin's `clear()` removes every plugin's values.
- The author guide documents `safeLocalStorage` and `getLocalPluginStorage()` as "shared between plugins" (their
  "Use when" lists say "Sharing data between plugins" and "The data is shared between plugins"). For `pluginStorage`
  it documents only that "All plugins share one storage record" for the merge and that `onStorageDiscarded` keys
  "may be another plugin's"; `clear()` is "Remove all items".
- `setDatabase({ pluginCustomStorage })` replaces the whole record (`replacePluginCustomStorage` via `applyPluginKey`),
  the two reserved dictionaries included; `getDatabase` returns a `plainClone` of it (`buildDatabaseSubset` in
  `src/ts/storage/snapshots.svelte.ts`). A plugin that builds a fresh object instead of editing the one it read
  removes every other plugin's custom keys and every `pluginStorage` and `getLocalPluginStorage()` value.
- Removing a plugin (the trash button in `PluginSettings.svelte`) splices it out of `settings.plugins` and reloads
  plugins; its storage values and grants stay. Nothing in the app lists plugin data.

### Transfer

- A held record's update goes as a patch of top-level fields (`updateOperation`, resource sync "Record patches"):
  `_pluginStorage` and `_safeLocalPluginStorage` are single top-level fields, so a write of one key sends the whole
  dictionary. The server applies `{ set, remove }` by field (`withFields` in `server/src/data/resourceStore.ts`).
- The conflict merge is already finer: `mergePluginStorage` merges one level down in both reserved dictionaries and
  other top-level keys whole (resource sync "Record merge").
- `plugins` items have no id (`shared/plugins.ts`), so the array goes whole; ST01's 1.02 MB toggle. A plugin's `name`
  is its identity (plugin sandbox Invariants) and `upsertPlugin` keys by it.
- The save deadline is 500 ms and later marks do not postpone it, so a plugin writing after every message uploads its
  dictionary about twice a second while it is active (ST01).

### Permissions

- Grants live in the server-owned `pluginPermissions` resource (`src/ts/plugins/apiV3/permissionStore.ts`):
  `grants` keyed `<sha256 of the script>_<permission>`, `lastGrantTime` keyed `<name>_<permission>_lastGrantTime`.
  `getPluginPermission` in `v3.svelte.ts` builds both keys; `permissionAnswers` caches answers per plugin and
  permission for the page load.
- Grants are append-only: `recordPermissionGrants` reads, merges and writes with up to five attempts; nothing removes
  a key. Every script update makes a new hash, so grants of old scripts accumulate. Keying by script hash already
  avoids the name-only keying PocketRisu fixed.

### `getDatabase` with characters

The default call (`includeOnly = "all"`) and any call naming `characters` run `withChatsLoaded` over every character
(`v3.svelte.ts`, `getDatabase` in `makeRisuaiAPIV3`), then `buildDatabaseSubset`:

1. **Requests, one character at a time.** `withChatsLoaded` pins every character (`pinChats`), then
   `for (const chaId of missing) await loadChats(chaId)`, up to three rounds. Each `loadChats`
   (`src/ts/storage/chatStore.svelte.ts`) reads that character's unloaded chats by ref, `LOAD_CHUNK` (500) per
   request: 300 characters with unloaded chats are 300 sequential round trips.
2. **The whole library in the reactive store.** Every loaded chat is installed as Svelte state and stays pinned until
   the read returns: the peak is the library as reactive proxies. The release schedules `trimLoadedChats`, which
   evicts down to `MAX_LOADED_CHATS` (8) idle chats, so the next call loads everything again.
3. **Copies.** `withChatsCopy` takes `clone($state.snapshot(chatsOf(chaId)))` per character (two deep copies), and
   the answer crosses into the iframe by structured clone (a third), all on the main thread.
4. **Structured memory.** With that algorithm selected, `refreshChatProjections` asks the server for the returned
   chats' memory revisions and reads up to eight moved projections, one after another, under a 5 s deadline.
5. **The write side pays again.** `setPluginDatabase` runs `withChatsLoaded` over `charactersReconciled(newDb)`
   before `applyPluginCharacters`: a read-modify-write of the library loads it twice.

What already exists to do better:

- `readChatsDetached` (`src/ts/storage/chatEdits.ts`, for exports) settles queued saves (`flushResources`), refuses
  when a discard or a refusal concerns its characters, then reads whole collections with
  `readRefs([], { chatCollections })`, 500 characters per request under a 60 s deadline, as plain copies that are
  never installed. The read route serves at most `MAX_READ_RESPONSE_BYTES` (16 MiB, soft) per answer with `continue`
  (`shared/resources.ts`); `readRefs` also takes `chats: [{ characterId, id }]` by ref.
- The tab holds a revision for every member chat, loaded or not (`chatRevisions`, exported as `heldChatRefs`): the
  boot seed sets them, `applyRemoteSummary` and the loaded-chat installs advance them, and a live update the tab could
  not settle at once is held in `noticedChats` (or `staleChats`) until a read settles it. A held revision with no
  notice pending is the server's as far as the live feed has told this tab.
- `flushResources` rejects when a character that must be saved is still generating (`GenerationBlockedError`) and
  when a resource is quarantined (`quarantineReason`); inside a generation hook the hook's character is generating.
- `setDatabase` skips the chat reconcile of an entry whose `chats` is not an array (`applyPluginCharacter`), while a
  `chats` array is reconciled whole: a chat left out is deleted (never the last one; chat store "Whole-chat writers").
  An omitted `chats` field is therefore safe to hand back; an empty or partial array is not.
- Scoped reads already exist: `getCharacter`, `getCharacterFromIndex`, `getChatFromIndex`
  (`src/ts/plugins/apiV3/risuai.d.ts`); each loads the whole character's chats first. The author guide already warns
  that `getDatabase` with `characters` "can take a while and use a lot of memory".

### Tests and upstream

- Unit tests cover the guest bridge over a fake window (`guestBridge.test.ts`) and a real `SandboxHost` with a
  simulated guest (`sandboxActivity.test.ts`); no spec checks the sandbox attributes, the opaque origin or the message
  source rules in a browser (plugin sandbox `Tests`).
- Upstream RisuAI's `pluginStorage` is shared too (a cold-storage index under `_coldpluginIndex`). The upstream import
  maps it into `_pluginStorage` (`server/src/data/upstream/importCollections.ts`); the upstream export leaves
  `_pluginStorage` and `_safeLocalPluginStorage` out and counts them as excluded (`DEVICE_PLUGIN_STORAGE_KEYS` and
  `upstreamPluginStorage` in `server/src/data/upstream/exportDatabase.ts`).

## Decisions

### D1. Measure before and after

A measurement driver over `util/playwright/stack.mjs` seeds the ST01 fixture shape (300 characters, 3,000 chats,
10 plugins, one 2 MiB plugin value) and a test plugin, and records:

- for `getDatabase()` and `getDatabase(["characters"])`: wall time, `POST /api/resources/read` count and bytes, and
  peak JS heap (CDP `Runtime.getHeapUsage` sampled during the call), cold and on an immediate second call;
- for one `pluginStorage.setItem` of a small key next to the 2 MiB value and for one plugin `enabled` toggle: bytes
  of the save request.

Its first run is the baseline the later slices compare against; numbers go in the slice's commit message, not in a
guide. Developer mode (`developMode.ts`) also gets a guest-side access recorder: a dev-only wrapper over the
`getDatabase` result that logs, once per call, which top-level keys and whether any `characters[i].chats` the plugin
touched. It informs Q5 on the owner's own plugins; it never runs outside developer mode.

### D2. A plugin data page

Settings > Plugins gains a "Plugin data" view (`PluginSettings.svelte` or a child component): the three server
namespaces and the device's `safe_plugin_` keys, each key with its size in UTF-8 bytes of its JSON, a search box, a
JSON view, and delete per key and per namespace (with `alertConfirm`). Before D6 the page shows no owner and offers
no "delete with plugin"; after D6 it filters by owner and lists unowned (legacy) keys apart. Deletes go through the
existing mutations (`removePluginStorageItem`, `removeSafeLocalPluginValue`, `setPluginCustomValue(key, undefined)`,
`SafeLocalStorage.removeItem`).

### D3. Revocable permissions

- `permissionStore.ts` gains `revokePermissionGrants(keys, timeKeys)`: the same read-merge-write loop as
  `recordPermissionGrants`, removing keys. The server kind needs no change (the record stays two maps of `true` and
  numbers).
- The plugin row gets "Reset permissions": it revokes every grant whose key starts with the current script's hash and
  that plugin's `lastGrantTime` entries, and clears that plugin's `permissionAnswers`.
- Removing a plugin revokes the grants of its script hash always (a reinstall asks again), and the data page offers
  "remove grants of scripts no installed plugin has" for the accumulated old hashes.
- The legacy browser-permission import (`browserLocalImport.ts`) runs once per browser; a revoke after it is final.
  The slice confirms that and adds a test that a later boot does not bring a revoked grant back.

### D4. Write what changed

- **Nested patch for `pluginStorage`.** `updateOperation` sends the `pluginStorage` record as top-level `set`/`remove`
  plus, for `_pluginStorage`, `_safeLocalPluginStorage` and D6's `_ownedPluginStorage`, entry-level
  `set`/`remove` one level down, mirroring `mergePluginStorage`. A reserved name held as no dictionary, a changed
  `__proto__` entry, or a patch no smaller than the whole goes whole, as today. The server applies the nested ops in
  `withFields`' place for that kind only, refuses a nested op on a reserved name that is no dictionary, and
  normalizes as before. The nested op is a new form both sides learn in one commit; the server serves the client
  bundle, so a newer client never meets an older server, and an older cached client keeps sending top-level patches,
  which the server still accepts.
- **By-name item patch for `plugins`.** The `plugins` record uses `itemIds` keyed by `name`, so a toggle sends one
  item. A list with a duplicate or empty name goes whole (the existing rule for lists without unique nonempty ids).
- Rejected: per-owner server records (one resource id per plugin). They would remove the resend too, but they change
  the boot read, snapshots, backups, the upstream export and the merge, for a result the nested patch gives within one
  record. Rejected: upstream's cold-storage split of large values; the server already stores the record as one text
  column, and the cost here is transfer, not storage.

### D5. Reserved dictionaries survive a `pluginCustomStorage` write

`setDatabase({ pluginCustomStorage: value })` keeps replacing the top level (a plugin removing its own custom key by
leaving it out is a legitimate use, and upstream behaves the same), but a reserved dictionary (`_pluginStorage`,
`_safeLocalPluginStorage`, `_ownedPluginStorage`) absent from `value` keeps its stored value. A reserved name present
in `value` is applied as today (the plugin read it and handed it back). This closes the wipe-by-fresh-object case
without changing what a careful round trip does. Q2 chose this over the stronger merge.

### D6. `pluginStorage` gets an owner; the shared channels stay shared

- **Owner.** The owner is the plugin's `name`, the identity every other plugin key already uses; a renamed plugin is a
  new owner (the existing invariant says updates must not change it).
- **Layout.** Owned values live in a new reserved dictionary `_ownedPluginStorage` of the same record, keyed
  `<owner>\u0000<key>`, so the nested patch (D4) and the key-by-key merge apply unchanged. `_pluginStorage` stays as
  the legacy, unowned area.
- **Reads** of `getItem`, `keys`, `length` and `key` see the owner's keys, then the legacy keys not shadowed by them,
  until the owner calls `clear()`. **Writes** (`setItem`, `removeItem`) go to the owned dictionary; a write of a key the
  legacy area holds moves it (claim-on-write): the legacy entry is removed in the same `batchRecordWrites`.
  `removeItem` of an unclaimed legacy key removes it from the legacy area, as today.
- **`clear()`** removes the owner's keys and sets a per-owner marker `<owner>\u0000` (an empty-key entry holding
  `{ "legacyHidden": true }`) after which reads no longer fall through to the legacy area for that owner; legacy keys
  are not deleted (other plugins may still read them).
- **The data page** (D2) shows legacy keys apart and lets the user assign one to an installed plugin (a move into its
  owned keys) or delete it. Removing a plugin offers to delete its owned keys, checked by default (Q4).
- **`onStorageDiscarded`** reports the listening plugin's own keys without the owner prefix, and legacy keys as
  today.
- **Unchanged:** `safeLocalStorage` and `getLocalPluginStorage()` stay shared, as the author guide documents them as
  the channel for sharing data between plugins; the data page covers their leftovers. The top-level custom keys of
  `setDatabase` stay shared (they are part of the legacy database shape).
- **Compatibility.** A plugin that reads another plugin's `pluginStorage` key keeps reading it while that key is
  unclaimed legacy, and stops seeing later writes once the other plugin writes it (Q1). The upstream export adds
  `_ownedPluginStorage` to `DEVICE_PLUGIN_STORAGE_KEYS` (left out and counted, like `_pluginStorage`); the upstream
  import keeps writing the legacy area, which read-through serves.

### D7. `getDatabase` reads unloaded chats detached

When the result includes `characters` and the call is not inside a hook (no `currentContext`):

- **Settle first.** `flushResources()` settles this tab's queued changes; a rejection (a generating character, a
  quarantine) falls back to the current path for the whole call.
- **Split by chat, not by character.** A loaded chat comes from the held store in the final synchronous pass, as
  today (local unsaved work included). An unloaded member chat is read by ref (`readRefs([], { chats })`), all
  characters together, chunked, with `continue`, under one read deadline, as plain copies that are never installed,
  pinned or evicted. The chat list and order are the tab's (`memberIds`, through a read-only export): a chat the read
  finds gone is left out of
  the copy (the store's own refresh removes it), and a chat the server has that the tab's list does not is not added.
- **Fall back where the detached copy could be wrong.** A character with a refused or discarded change in the flush
  result, or with a chat noticed or stale, goes through the current load path (pinned, loaded, copied), so no read
  answers an older server copy of a change held only here and the call fails in no case it succeeds in today.
- **Same answer.** A detached chat carries what the loaded path would carry: the same `hypaV3Data` projection rule
  (`refreshChatProjections` and `installChatProjection` semantics applied to the copy, or the copy routed through the
  same helper) and the same legacy shape (`withChatsCopy`'s `chatPage` and `lastInteraction`). The slice's main test
  is an equality test: for one fixture state (a partially loaded character, an unsaved change in a loaded chat, a
  structured-memory chat, a chat gone on the server), the new path's result deep-equals the old path's.
- **Fewer copies.** The held-store copy takes one deep copy, not `$state.snapshot` followed by `clone` (the slice
  confirms what the second copy guards, an own `__proto__` key or a prototype, and keeps an equivalent where needed).
  Detached copies are plain already and are not copied again before the structured clone into the iframe.
- **Inside a hook** the call keeps the current path: the hook's character is generating, so the flush would reject,
  and a hook rarely needs the library.
- **Never truncate.** No client byte budget cuts the snapshot; a plugin that cannot afford the library uses D10.
- **The contract changes in one sentence,** written in the author guide: the result is "the chats this tab has loaded
  as it holds them, and the others as the server holds them after this tab's queued changes were saved". The guide's
  current comment ("one state of the tab") is rewritten to match.

### D8. Reuse unchanged chats between calls

After D7, the tab keeps the last detached copy of each unloaded chat with its revision, in a module-level cache owned
by the plugin read path:

- A later call reuses a cached copy when its revision equals the tab's held revision (`heldChatRefs`), the chat is
  neither noticed nor stale, and the live feed is connected with no reconnect reconcile pending; otherwise the chat is
  read again. No `listRevisions` request is needed: the feed already advances the held revisions.
- Cached copies are handed to the structured clone directly; the iframe gets its own copy and the cache is never
  exposed by reference.
- The cache is capped at 64 MiB of JSON bytes, oldest first (Q3), and is dropped when no `getDatabase` with
  characters ran for five minutes, on
  `pagehide`, on an epoch change and on a restore halt.

### D9. `setDatabase({ characters })` loads only what changed

A separate slice after D8: before `withChatsLoaded`, an incoming character whose `chats` array matches, chat by chat
in order and by JSON text, the copies the tab holds or cached at the held revisions is applied without loading its
chats (its non-chat fields still apply). Any difference, a missing chat or a new one sends that character through
the current path (pin, load, `reconcileCharacterChats`), because the reconcile deletes chats left out and must see
the whole list. Correctness of the reconcile is unchanged; only the load is skipped where nothing can change.

### D10. Scoped reads for new plugins

- `getDatabase(keys, { chats: "summaries" })` returns each character without `chats` and with `chatSummaries`
  (`id`, `name`, `lastMessageAt`, the message count when the summary has it), from the held summaries, with no chat
  read. The omitted `chats` keeps a round trip through `setDatabase` safe.
- `getChats(chaId, { offset, limit })` returns a page of one character's chats in order (detached for unloaded chats,
  as D7), with the total count.
- The author guide's Database Access section recommends these and `getCharacter` over the default call; developer
  mode logs a one-time hint when a plugin's default call returns more than 200 chats.
- The default of `getDatabase()` is unchanged (Q5).

### D11. A browser spec for the sandbox

A Playwright spec (`e2e/`, over the existing stack) installs a test plugin and checks in Chromium: the iframe's
`sandbox` tokens are exactly `allow-scripts allow-modals allow-downloads`, the guest's `origin` is `"null"`, a message
posted to the host from a window that is not the plugin's iframe is ignored, a host call round trip works, and a
`getDatabase(["characters"])` with an unloaded chat returns it (D7's browser check).

### D12. Out of this plan

Streaming the result into the iframe (Haejeok C5's receiver), device-local large storage spaces, per-plugin server
records (D4), isolating `safeLocalStorage` and `getLocalPluginStorage()` (D6), and a default change for
`getDatabase()` (Q5) are not planned here; see **Later**.

## Open questions

- **Q1. Isolate `pluginStorage` (D6)?** Answered (a). (a) As D6: owned keys, legacy read-through, claim-on-write, `clear()` scoped
  (recommended). (b) Keep keys shared and scope only `clear()` to the keys this plugin wrote (needs the same owner
  tracking, and leaves the collision). (c) Leave storage shared; ship D2 and D4 only. The deciding fact is whether a
  plugin the owner uses reads another plugin's `pluginStorage` keys on purpose (RisuNest's open question 5).
- **Q2. `setDatabase({ pluginCustomStorage })` (D5)?** Answered (a). (a) Reserved dictionaries kept when absent (recommended).
  (b) Merge every top-level key, PocketRisu's choice: a plugin can then no longer remove a custom key by omission.
  (c) Leave as is.
- **Q3. The reuse cache (D8)?** Answered (a). (a) A 64 MiB cap of JSON bytes, dropped after five idle minutes (recommended).
  (b) A smaller cap. (c) No cache: every call re-reads unloaded chats (D7 alone).
- **Q4. Removing a plugin?** Answered (a). (a) One confirm with a checked "also delete its stored data" box; grants revoked always
  (recommended). (b) Always delete. (c) Keep data, revoke grants only.
- **Q5. The default of `getDatabase()`** without arguments: answered as recommended, decided after D1's recorder
  has run on the owner's plugins; until then unchanged (**Later**).

## Slices

### Slice 0: the measurement driver (D1; needs nothing)

`util/playwright/` driver and its fixture seeding, the developer-mode access recorder in `developMode.ts`, a test
plugin under the driver's directory. Baseline recorded in the commit message. Owner: test harness.

### Slice 1: the plugin data page and permission reset (D2, D3; needs nothing)

`PluginSettings.svelte` (or a new child component), `pluginStorageStore.svelte.ts` (an inventory read: keys, sizes,
namespaces; no new write path), `permissionStore.ts` (`revokePermissionGrants`), the remove button's revoke,
`src/lang/en.ts` and `ko.ts` keys. Tests: inventory sizes, a revoke removes only that plugin's hash and time keys
under a concurrent grant (the five-attempt loop over `FakeResourceServer`), a revoked grant asks again, a reboot does
not restore a revoked grant.

### Slice 2: nested and by-name patches (D4; needs nothing)

`resourceSync.svelte.ts` (`updateOperation` for the `pluginStorage` kind and `itemIds` by name for `plugins`), the
server patch application in `server/src/data/resourceStore.ts` and its validation, `recordPatchText.ts` if it
computes the patch text. Tests: one key changes one nested op, a reserved name held as no dictionary goes whole, the
server applies and refuses as specified, a top-level-only patch is still accepted, a duplicate plugin name goes whole,
the merge result is unchanged. The driver's write bytes are compared with Slice 0's.

### Slice 3: reserved dictionaries on `setDatabase` (D5; needs nothing)

`replacePluginCustomStorage` and its caller. Tests: a fresh object without reserved names keeps them; a returned
object with them applies them; a top-level custom key left out is removed.

### Slice 4: the detached `getDatabase` read (D7; needs 0 for the baseline)

`v3.svelte.ts` (`getDatabase`, `withChatsLoaded`'s caller), a shared detached-by-ref helper beside
`readChatsDetached` in `chatEdits.ts`, the projection rule for detached copies, `withChatsCopy`'s copy count. Tests:
the equality test of D7, the fallbacks (inside a hook, a rejected flush, a refused or noticed chat's character), no
pin and no install for unloaded chats, request count for many characters. Driver comparison.

### Slice 5: reuse between calls (D8; needs 4)

The cache, its invalidation (held revision, notice, stale, feed state, epoch, restore halt, idle, `pagehide`) and its
cap. Tests: an unchanged chat is not read again, a revision move or a notice re-reads it, a disconnected feed
re-reads everything, the cap evicts oldest first.

### Slice 6: owned `pluginStorage` (D6; needs 1 and 2)

`pluginStorageStore.svelte.ts` (owned dictionary, read-through, claim, `clear()` marker), the host functions in
`makeRisuaiAPIV3` passing `identity.name`, `mergePluginStorage` and the server normalization for the new reserved
name, the upstream export's `DEVICE_PLUGIN_STORAGE_KEYS`, `onStorageDiscarded`'s key mapping, the data page's owner
filter, assign and delete-with-plugin (the Q4 confirm). Tests: two plugins with one key stay apart, read-through, claim removes
the legacy entry in the same write, `clear()` hides legacy for that owner only, the discard event's keys, the
upstream export leaves the new dictionary out.

### Slice 7: `setDatabase` loads only changed characters (D9; needs 5)

`setPluginDatabase` before `withChatsLoaded`. Tests: an unchanged round trip loads nothing, a changed chat, a removed
chat and a new chat each take the full path, a removed chat is still deleted.

### Slice 8: scoped reads (D10; needs 4)

`getDatabase`'s option, `getChats`, `risuai.d.ts`, the author guide, the developer-mode hint. Tests: summaries
without a chat read, an omitted `chats` round trip changes no chat, paging bounds and order.

### Slice 9: the sandbox browser spec (D11; needs nothing; its last case needs 4)

`e2e/` spec and its test plugin. Owner: test harness; the plugin sandbox guide's `Tests` names it.

### Slice 10: the guide pass (needs 0–9)

The plugin sandbox guide (State's namespaces and owner, Database setters, Gotchas on `getDatabase` loading, Tests),
resource sync (Record patches), chat store (the detached read's two callers), server resources (the nested patch),
backup sync hub (the export's left-out keys), the author guide sections D5–D10 change, and the archive entry.

## Recommended order

0 → 1 → 2 → 4 → 5 → 3 → 6 → 7 → 8 → 9 → 10. Slices 1, 2 and 9 touch disjoint files and can run in parallel after 0;
4 and 6 both edit `v3.svelte.ts` (different functions) and run one after the other. Each slice that changes what a
plugin observes (3, 4, 6, 8) updates `plugins.md` in the same commit.

## Verification

- Each slice runs V1's gates once after its last source edit and the plugin sandbox guide's focused tests:
  `pnpm --silent test:agent src/ts/plugins src/ts/storage/tests/{pluginStorageStore,collectionStore}.test.ts src/ts/network/generationJobsPluginWork.test.ts`,
  plus the resource sync focused tests for Slice 2 and the chat store's for Slices 4, 5 and 7.
- Every new test is shown to fail once with the line it guards broken (V6); tests control time (V3): the D8 idle drop
  and the read deadline use fake timers or an injected clock.
- Slice 4's equality test is the acceptance check for D7; it runs against the real save adapter over the real server
  store (`storeBackedServer.ts`), not a hand-written read mock.
- Slices 2, 4 and 5 report the driver's numbers against Slice 0's baseline. A slice whose measured cost does not drop
  says so in its commit message rather than claiming the improvement.
- Slice 9's spec runs in the e2e suite; the guide's `Tests` lists it.
- `pnpm format:check` and `pnpm check:docs` before each commit.

## Out of scope

- The server-side plugin runtime (retired unbuilt, the archive), the plugin reload deferral leftovers, and the
  capability review of `mainDom`, `nativeFetch` and the RPC dispatcher (plugin sandbox Issues).
- Plugin update verification (no-store fetch, saved-change success; the PocketRisu picks), which touches install, not
  storage.
- The token-count batching findings (F09, F10, CE07) and the lore and memory field copies (CE05), which belong to the
  LLM requests and characters/modules guides.

## Later

- A streamed `getDatabase` transfer into the iframe (Haejeok C5): with D7 and D8 the remaining cost is the structured
  clone of what the plugin asked for; streaming pays only for libraries that stay large after D10 is adopted.
- Device-local large storage spaces in IndexedDB (RisuNest item 11).
- Owners for `getLocalPluginStorage()` and the top-level custom keys, if D2's page shows collisions
  there in practice.
- Changing the default of `getDatabase()` once D1's recorder has run (Q5), with a deprecation period in the author guide.
