# Boot Bytes Plan

Status: drafted 2026-10-29; landed: 1 (5063a1a18), 2 (761d41c52), 3 (2f35afe02), 4 (18d36f062), 6
(db31dc70f), 7 (a07028e56). An Astra review of the first draft (17 points, 2 blockers) is folded in
(see **Review record**). The user answered Q1–Q6 the same day (see **Answered questions**); Q3 and
Q4 are settled by Slice 1's numbers as recorded there.

Sources: findings ST02, ST03 (its change cursor and listing digest) and ST06 of the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md) (at `ff7cb9d20`),
which the archived Deep Audit Fixes plan deferred here (`git show ca5b656fa:docs/plan/deep-audit-fixes.md`,
**Deferred**: "Boot bytes plan: ST02, ST03's change cursor (after the compression line in Slice 5),
permissions seeded from boot", and ST06). It also takes the boot-size leftovers of the archived Boot
Resource Cache plan ([archive](../archived-plan/README.md), "Boot resource cache"). Code anchors were
checked at `7dd37b1c2` (`dev`), Durable Drafts at `34747f6e7` and Job Protocol at `d4586f152`;
verify them again before editing (STRUCTURE.md protocol step 5).

Owning guides: [persistence](../structure/persistence.md) (the boot read, the boot cache, held
revisions, reconcile), [app-shell](../structure/app-shell.md) (the boot order in `bootstrap.ts`),
[self-host server](../structure/self-host-server.md) (the boot route, `hello`, static files, asset
routes, normalization), [plugins and MCP](../structure/plugins-mcp.md) (the permission store),
[global-api](../structure/global-api.md) (asset writes), [characters and modules](../structure/characters-modules.md)
(the upstream import and export of `lastInteraction`). Each slice updates the guide whose contract
it changes; Slice 9 only closes.

## Goal

- A send no longer changes the character record. "Last chatted" is read from the character's
  chats, so a send stops invalidating the character in every browser's boot cache, including
  browsers that were closed when another device sent (D2).
- Boot reads plugin permissions once.
- A reconnect downloads no revision listing when this tab already heard of every change since its
  last listing.
- The first boot after a deploy downloads the app's scripts compressed.
- Uploading content-addressed assets the server already holds, verified, sends no bytes for them.
- Every change is measured per resource kind before and after, so Q3 (characters as a sidebar
  projection) and Q4 (chat summaries in the cache) are decided on numbers.

Not goals: a replayable change log (Q2, under **Later**); per-event server work and dictionary ids
(their own deferred plans); server byte budgets; the boot's client-side work after the read.

## Current state

- **Boot read.** `loadData` (`src/ts/bootstrap.ts:63`) asks `POST /api/resources/boot` for all 28
  `RESOURCE_KIND`s with `chatSummaries: true`.
  - `readBoot` (`server/src/routes/resourceBoot.ts:155`) answers `{ cached: true }` for a held
    revision only in `BOOT_CACHED_KINDS` (characters, modules and presets, `shared/resources.ts:214`),
    and only for kinds without a server `project` (`isCachedKind`, `resourceBoot.ts:41`).
  - Modules and presets are itemized by hash (`BOOT_ITEM_KINDS`). A missed character comes back
    whole.
  - The other 25 kinds, every chat summary and every chat order are sent on every boot.
  - The answer goes through `compressedJson` (zstd or gzip at level 1, from 32 KiB up).
  - Summaries are projected from each chat's whole `meta`. `readSummaries`
    (`server/src/data/chatStore.ts:1758`) parses every chat's JSON, including memory data,
    `scriptstate` and tool calls (`chatSummary`, `chatStore.ts:735`).
- **Boot cache.** `src/ts/storage/bootCache.ts` uses the IndexedDB database `risu-boot-cache` with
  stores `records`, `items` and `meta`, keyed `kind\0id` and `kind\0hash`.
  - It stores the server's record texts and item hashes, never live tab state.
  - Claims are dropped whole past 5,000 claims or 2 MiB.
  - It is written once per boot, as a full manifest: `scheduleBootCacheCommit(commitBootCache)` runs
    on idle after the main screen (`bootstrap.ts:157`).
  - A character whose `oaiTTSConfig.apiKey` is a non-empty string is installed but never cached
    (`bootCache.ts:104`).
  - A format or `appVer` mismatch clears the stores on the next write.
- **What invalidates a cached character.** Any revision move: an edit from any tab or device, a job
  write (memory turn-on at `server/src/prompt/runner.ts:877`; trigger and Lua character setters), and
  `stampInteraction` (`runner.ts:330`).
  - `stampInteraction` patches `lastInteraction` once per send, continue, reroll or group job.
  - The open tab applies that field patch from the feed without a read (`applyRemotePatch`,
    `src/ts/storage/resourceSync.svelte.ts:3301`). The boot cache still holds the old revision.
  - So the next boot of every browser downloads every character chatted with since that browser
    last booted (128,297 bytes for one character in the audit).
- **`lastInteraction` elsewhere.**
  - Conflicts: the stamp moves the revision, so a concurrent edit gets a 409. `benignChanges`
    (`resourceSync.svelte.ts:2137`) keeps the edit, takes the stamp and resends the merged record
    without a notice. Durable Drafts adds more special cases for the field on its branch
    (`34747f6e7:src/ts/storage/resourceSync.svelte.ts:3704`, `:4651`, `:4756`).
  - Readers: `src/lib/UI/mainMenuProjection.ts:62` and `src/lib/Mobile/MobileCharacters.svelte:39`.
  - Server uses: the upstream export adjusts it (`server/src/data/upstream/exportDatabase.ts:952`),
    and the display-cache identity leaves it out (`server/src/prompt/displayScope.ts:235`).
- **Plugin permissions.** The boot answer carries `pluginPermissions`, but nothing copies it into
  the store. After the browser-local import, `await loadPluginPermissions()`
  (`src/ts/plugins/apiV3/permissionStore.ts:50`, called at `bootstrap.ts:128`) reads
  `GET /api/resources/pluginPermissions/main` again. That happens before the live owner is set and
  the feed starts. The legacy browser-permission migration reloads once more after its merge
  (`src/ts/storage/browserLocalImport.ts:188`).
- **Reconnect.**
  - **The sequence.** Every `hello` (`server/src/routes/events.ts:117`: epoch, generation locks,
    memory task statuses) is followed by `listRevisions()` → `GET /api/resources/revisions`
    (`server/src/routes/resources.ts:288`, compressed since `ae2f9569a`) →
    `noteMemoryTaskListing` and `reconcileRemote` (`src/ts/network/eventFeed.ts:119`).
  - **The listing.** One row per resource record, chat and chat order.
  - **Change frames.** A `change` frame's `ChangeSet` (`shared/resources.ts:327`) has the same
    three lists, with `revision: null` for a delete.
  - **What does not exist.** No digest, no event ids, no replay (`server/src/data/changeFeed.ts`).
    No global commit sequence or tombstone either (`server/src/data/resourceStore.ts:1554`,
    `server/src/data/chatStore.ts:1709`).
  - **When it runs.** The socket is replaced on a resume after 30 s hidden, on `resume` and on
    `online` (`src/ts/network/socketLiveness.ts`).
  - **Memory-task fences.** `noteMemoryTaskListing` (`src/ts/process/memoryTasks.svelte.ts:258`)
    settles the reconnect fences from the listing's server revisions. It deliberately does not use
    held revisions, which may lag behind a queued refresh.
- **Static files.**
  - **Fixed since the archive.** `createStaticCache` (`server/src/http/staticCache.ts`) now sends
    `ETag`, `Last-Modified` and 304s, and `/assets/` is `immutable` for a year.
  - **Still open.** Nothing compresses them. The entry chunks are several MB (`lib-*.js` 6.0 MB,
    `editor.api-*.js` 2.7 MB; the archive measured about 3.8 MB for the boot's own set), and a deploy
    changes their hashes. So the first boot after each deploy downloads them uncompressed.
    `public/sw.js` does not cache app scripts.
- **Boot cache database.** A `risu-boot-cache` that another opener created at version 1 without
  stores skips `onupgradeneeded` (`bootCache.ts:426`). Every transaction then fails, and
  `loadBootSnapshot` falls back without repairing it, on every boot. `clearBootCache` has no caller,
  because there is no sign-out.
- **Asset uploads.**
  - **The client.** `saveAsset` (`src/ts/globalApi.svelte.ts:371`) hashes, then always writes
    through the single `writeAsset` (callers include card image import and plugin `saveAsset`).
    `writeAssets` (`src/ts/storage/assetClient.ts:270`) sends every batch. Deduplication is only
    within one call.
  - **The server.** It always overwrites and fsyncs. It hashes canonical uploads and records a
    mismatch, but writes anyway. No exists or missing-hashes route exists.
  - **Verification.** Only `/api/asset/*` verifies a stored file: asynchronously, in memory, keyed
    by stat (`server/src/http/assetVerification.ts`).
  - **Server import skips.** Server-side import helpers skip an existing content-addressed file on
    existence alone (`server/src/http/contentAsset.ts:33`, `server/src/routes/importModule.ts:121`).
- **Character consumers.** Boot installs whole characters. `ClientCharacter` omits only
  `chats`/`chatPage`; no partial character type exists.
  - Each save cycle scans character membership and projects dirty or new characters, reusing
    unchanged field text (`resourceSync.svelte.ts:734`, `:1366`).
  - Several readers need non-selected characters whole: plugin `getDatabase` and
    `getCharacterFromIndex` (`src/ts/plugins/apiV3/v3.svelte.ts:1543`, `:1666`), the MCP host, group
    features (member `firstMessage`, `emotionImages`, `image`, `viewScreen`), the backup inventory,
    and dataset export.
  - Durable Drafts' journal recovery compares against `heldRecordSnapshot`.
  - Chats are the existing lazy model (`chatStore.svelte.ts:34`: summaries, `loadChat`, eviction).

## Decisions

- **D1. Measure first, per kind.** `util/playwright/measureBoot.mjs` gets a synthetic fixture builder
  that both boot drivers share. `captureBootFixtures.mjs` captures historical compatibility fixtures
  and stays as it is. The builder adds the audit's shape: 300 characters, 3,000 chats with realistic
  memory metadata, 322 records, and inlays.
  - **Per-kind numbers.** The driver reports each kind's decoded bytes. It also reports the
    compressed size of the answer with and without each kind (an omission delta), because
    compressed sizes do not add up. It reports the server time of the boot read and of
    `readSummaries`.
  - **New scenarios.**
    - `send`: one send through a deterministic local provider, then a reload.
    - `otherDevice`: a send from a second client while the measured browser is closed, then its
      boot.
    - `selfEdit`: a description edit saved in the tab, then a reload.
    - `resume`: hidden for more than 30 s with nothing changed, then visible. This one measures
      listing bytes.
    - `scripts`: an empty HTTP cache with the boot cache kept, measuring script bytes.
  - **Where the numbers go.** Into the persistence guide's Gotchas. They decide Slice 8's kinds, Q3
    and Q4.
- **D2. "Last chatted" comes from the chats; the server stops stamping the character** (Q1).
  - **The server.** `stampInteraction` (`runner.ts:330`) and its call go away. The character's
    revision no longer moves on a send.
  - **The value.** A chat's `lastMessageAt` is the `time` of its last message by position, read
    through the `messages_position` index. The server chat store keeps it in memory per chat,
    computed on first use from that one row. It is dropped whenever a message op touches the
    chat (append, remove, replace, `setMessage`). A message without a numeric `time` gives no
    value.
  - **No schema change.** Appends do not rewrite chat `meta`, which holds memory data, and a
    column would raise the resource database past version 3 and its backup snapshot checks
    (`resourceStore.ts:358`). The database therefore stays at version 3.
  - **On the wire.** `ChatSummary.lastMessageAt?: number`. Summaries are already refreshed after
    every chat change, so another device's send reaches the list through the existing collection
    refresh.
  - **Client readers.** A character's "last chatted" is the newest value among its chats: a loaded
    chat's own last message, or an unloaded chat's summary. It falls back to the stored
    `lastInteraction`. One helper in `chatStore.svelte.ts` serves `mainMenuProjection.ts` and
    `MobileCharacters.svelte`. Group chats work the same, since their chats live under the group
    record.
  - **The stored field.** It stays in `shared/database.ts` as a frozen legacy value. Nothing
    writes or migrates it any more, and a plugin `setCharacter` that sends an old copy back is
    harmless. Plugin character snapshots fill it with the derived value, so
    `getChar().lastInteraction` keeps meaning "last chatted".
  - **The upstream export.** `exportDatabase.ts:952` already raises the field to the newest chat
    activity. It reads the same rule.
  - **Removed special cases.** `benignChanges`' branch, the remote-listener filters
    (`resourceSync.svelte.ts:2417`, `:3295`, `:3362`) and Durable Drafts' cases have no concurrent
    server writer left, so they go away. `displayScope`'s exclusion stays: removing it would change
    every character's display identity once, for no gain.
  - **Behavior change.** Deleting a chat's last messages moves the character back in the recent
    list; today's stamp stays put. Send, continue, reroll and group jobs must each still move it
    forward, matching today's stamped kinds (Slice 5 checks each).
  - **Cost.** One number per chat summary (about 20 bytes before compression), and one indexed row
    read per chat on the first summary read after a server start.
- **D3. Permissions are seeded from the boot answer.** The boot record's data and revision go
  through `copyGrants` into the store before the browser-local import. If the record is absent, the
  store starts empty at no revision. The boot path no longer calls `loadPluginPermissions`. The
  legacy migration keeps its reload after its merge. A write in the gap before the feed starts is
  caught by the first `hello`'s reconcile, as today.
- **D4. The client keeps the server's advertised revisions; a matching `hello` skips the listing.**
  - **The advertised map.** The client keeps a map of every resource, chat and chat-order row with
    the revision the server last advertised. It is seeded from each listing it reconciles and
    updated by every `change` frame's `ChangeSet` (`null` removes the row). This is the server's
    revision, not the held one.
  - **The digest.** A shared function (`shared/`, used by client and server alike) computes a
    128-bit digest over the epoch plus every row. Each row is a domain-separated hash of its list,
    identity (`kind`+`id`, `characterId`+`id`, or `characterId`) and revision; the digest is their
    sum mod 2^128. The client can therefore keep the sum incrementally.
  - **The server side.** It computes the digest from `listRevisions()` at `hello`, in the same
    synchronous step that reads the hello's other snapshots, before the socket is registered.
    `hello` carries it. A full scan per hello keeps the server free of commit-path bookkeeping; the
    scan's cost is measured in Slice 7.
  - **On reconnect.** The client compares its own digest with the hello's. When they are equal, it
    skips `listRevisions`. It runs `noteMemoryTaskListing` and `reconcileRemote` from the advertised
    map exactly as from a listing (so fences settle from server revisions, never held ones). It
    still processes the hello's epoch, locks and task statuses. On any difference, or a hello
    without a digest (an older server), it reads the listing as today.
  - **Why a missed frame is safe.** The advertised map lacks the missed change, so the digests
    differ and the listing is read.
  - **Generation guards.** Frames and listings from a superseded socket are ignored, as today
    (`eventFeed.ts:190`).
  - **What it does not save.** A change made while the tab was away still costs one full
    (compressed) listing. A replayable change log for that case is Q2.
- **D5. App scripts are served compressed.**
  - **Build.** A post-build step writes `.br` and `.gz` siblings of the compressible files in
    `dist/` (scripts, styles, JSON, SVG and WASM; not source maps or already-compressed images). It
    uses only `node:zlib`, with no new dependency.
  - **Serving.** `createStaticCache` serves the best sibling that `Accept-Encoding` allows. The
    sibling supplies the body, length and an ETag of its own; the original name supplies the MIME
    type. Responses carry `Content-Encoding` and `Vary: Accept-Encoding`.
  - **Fallbacks.** Range and `If-Range` requests get the identity file. A missing sibling falls
    back to the identity file.
  - **Unchanged.** The injected `index.html` path stays as it is. A reverse proxy that compresses
    is unaffected.
- **D6. A boot-cache database without its stores is repaired by an upgrade.** `DB_VERSION` goes up
  by one, and `onupgradeneeded` creates whichever of `records`, `items` and `meta` is missing. That
  repair is atomic. The open keeps its blocked and timeout handling. A second failure falls back as
  today.
- **D7. Uploads ask which content names are missing, and corrupt counts as missing** (Q5 decided:
  repairing beats keeping a corrupt file forever).
  - **The route.** `POST /api/assets/missing` takes up to 512 canonical content names (a body of at
    most 64 KiB) and answers those the server does not hold verified.
  - **Verification.** It is awaited, asynchronous and streaming, with bounded concurrency (4) and
    a 256 MiB read budget per request. It reuses `assetVerification`'s fresh-stat answers. A file
    over the budget counts as missing.
  - **The callers.** The canonical single `saveAsset` and the batch paths (`saveAssetBatch`,
    `writeAssets`, PNG card chunks, CCv3 embedded assets, `savePickedFiles`) ask first and send only
    the missing names.
  - **Which uploads skip the check.** Only an upload whose bytes hash to its canonical name can be
    skipped. A custom id or a raw overwrite is always sent.
  - **Failure.** A failed check sends everything, as today. An abort stays an abort.
  - **Not covered.** The server-side import helpers' existence-only skips are a found issue, not
    this plan (see **Out of scope**).

## Answered questions

The user answered these on 2026-10-29, each with the recommended option:

- **Q1. Where "last chatted" comes from** (D2, Slice 5): derived from each chat's last message
  time, with the server's stamp removed and the stored field kept as a frozen fallback.
  - Not taken: a server-owned `characterActivity` record (`chaId → time`). It needs a new kind, a
    migration, a separate store on the client, and the upstream import and export split.
  - Not taken: keep the stamp and rewrite the boot cache from the tab's acknowledged state (the
    first draft's D2). The review showed that the tab's acknowledged text is not the server's
    stored value when the server normalizes, and item hashes need the server's exact
    serialization. It also needs a cross-tab writer, and it helps only the browser that saw the
    change.
  - Not taken: keep everything as it is (one whole character per chatted character per browser per
    boot).
- **Q2. A replayable change cursor** (D4): the advertised-map digest only, with a change log under
  **Later**.
  - Not taken now: a persisted, transactionally numbered change log over resources, chats and
    orders, with tombstones, retention and a `changes?since=` route. It saves the one full listing
    after an away-time change (about 81 KB zstd on the audit's shape) and costs a new store on the
    server's hottest write path.
- **Q3. Characters as a sidebar projection at boot** (ST02's main recommendation): not in this
  plan.
  - **Who decides.** Slice 1's and Slice 5's numbers decide whether it gets its own plan.
  - **What it would help.** The cold boot (first boot per browser, or after an `appVer` change)
    and any warm miss that Slice 5 leaves, such as edits and job writes from another device.
  - **If pursued.** A background backfill: the projection first, the rest of the full records in
    idle chunks, and full-record readers awaiting `charactersReady`.
  - **Not taken.** A true on-demand model. It touches every synchronous `findCharacterbyId`
    reader, the save projection, the plugin and MCP APIs, group features, exports, and journal
    recovery.
- **Q4. Chat summaries in the boot cache, and a cheaper summary read** (Slice 8): decided on Slice
  1's numbers, its omission delta and its server time for `readSummaries`, in absolute bytes and
  milliseconds.
  - **If both are small.** Nothing is done.
  - **If the bytes matter.** Summaries are cached per character in Slice 8. Each character's claim
    is a hash of its summary revisions plus its order revision, answered `cached` per character,
    inside the shared 5,000-claim and 2 MiB budget. The server then parses `meta` only for stale
    characters.
  - **If only the server time matters.** A summary projection that stops parsing whole `meta`
    (summary fields in their own column) goes under **Later** as its own plan, since it is a
    chat-store schema change.
- **Q5. A present but corrupt asset** (D7): counted as missing and uploaded again.
- **Q6. Plugin data in the boot cache on disk** (Slice 8): `plugins` and `pluginStorage` stay out,
  whatever their size. The journal keeps them off disk too (`src/ts/storage/journalEligibility.ts:10`).

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes.

### Slice 1: per-kind boot measurement (D1; needs nothing)

Files: `util/playwright/measureBoot.mjs` (the shared fixture builder and the scenarios),
`util/playwright/checkBootCache.mjs` (uses the builder), and the persistence guide's Gotchas (the
table).

- Record the table for `cold`, `warm`, `send`, `otherDevice`, `selfEdit`, `resume` and `scripts` on
  both fixtures, at the current `dev`. Later slices rerun it.
- No product change. These are browser scripts, outside the gate.

### Slice 2: compressed app scripts (D5; needs nothing)

Files: a post-build script under `util/` wired into `pnpm build`, `server/src/http/staticCache.ts`,
`server/src/tests/app.test.ts` (extended, not duplicated), and the self-host-server and
build-test-platforms guides.

- Tests:
  - The decompressed body equals the original bytes.
  - br is chosen over gzip, and gzip over identity, by `Accept-Encoding` with q-values.
  - Each encoding has its own ETag, and a validator of one encoding never yields a 304 for another.
  - `Vary` is set on identity responses too.
  - Range and `If-Range` get identity.
  - A missing sibling falls back to identity.
  - The MIME type is the original's.
  - `index.html` keeps `no-cache`, and an immutable path stays immutable in every encoding.
- Docker image size and build time are measured and recorded.

### Slice 3: missing-asset check before uploads (D7; needs nothing)

Files: `server/src/routes/storage.ts` (the route), `server/src/http/assetVerification.ts` (an awaited,
bounded verify), `src/ts/storage/assetClient.ts`, `src/ts/globalApi.svelte.ts` (`saveAsset`,
`saveAssetBatch`), the batch import callers, and the global-api and self-host-server guides.

- Tests:
  - A present, verified file is skipped.
  - Absent, empty, wrong-hash, over-budget and non-canonical files are sent.
  - Bytes that do not hash to their claimed name are sent.
  - A failed check sends everything, and an abort rejects.
  - The name cap splits requests.
  - Auth and the body limit apply.
  - Budgets and concurrency are checked with injected limits and latches.
- Manual benchmark (a driver, not the gate): reimporting 100 present 1 MiB assets, with cold and
  warm verification, bytes and time before and after.

### Slice 4: boot cache database repair (D6; needs nothing)

Files: `src/ts/storage/bootCache.ts`, its tests, and the persistence guide.

- Tests (fake IndexedDB):
  - A version-1 database without stores is upgraded and then holds a write.
  - A database with some stores gets the missing ones.
  - A blocked upgrade falls back within the existing timeout.

### Slice 5: "last chatted" from the chats (D2; needs Durable Drafts in `dev` and Job Protocol Slice 3)

Files:

- shared: `shared/chats.ts` (`ChatSummary.lastMessageAt`), `shared/database.ts` (the legacy field's
  doc), and the `shared/resources.ts:276` comment
- server: `server/src/prompt/runner.ts` (`stampInteraction` removed), `server/src/data/chatStore.ts`
  (the memo and the summary field), and `server/src/data/upstream/exportDatabase.ts` (if its rule
  needs the value)
- client:
  - `src/ts/storage/chatStore.svelte.ts` (the helper)
  - `src/lib/UI/mainMenuProjection.ts` and `src/lib/Mobile/MobileCharacters.svelte`
  - the plugin character snapshots
  - `src/ts/storage/resourceSync.svelte.ts` (the special cases removed)
  - the stale comments in `src/ts/process/serverGeneration.ts:49` and `src/ts/characters.ts:882`
- guides: persistence, self-host-server and characters-modules

Tests:

- Send, continue, reroll and group jobs each leave the character's revision unchanged and move the
  chat's `lastMessageAt`. A preview moves neither.
- The memo is dropped on append, remove, replace and `setMessage`. A fresh store gives the same
  values. A message without `time` gives none.
- Home and mobile lists:
  - A loaded chat's own last message counts before its summary refreshes.
  - An unloaded chat's summary counts.
  - The legacy field is the fallback.
  - Deleting the last messages moves the character back.
  - A group sorts by its own chats.
- A plugin `getChar` sees the derived value.
- The upstream export's output is unchanged on the existing fixture (`upstreamExport.test.ts`).
- A concurrent character edit during a send gets no 409.

Measured: `send` and `otherDevice` before and after.

### Slice 6: permissions seeded from boot (D3; needs Durable Drafts in `dev`)

Files: `src/ts/plugins/apiV3/permissionStore.ts`, `src/ts/bootstrap.ts`, `src/ts/tests/bootMocks.ts`,
and the plugins-mcp and app-shell guides.

- Tests:
  - A boot without the legacy migration makes no `pluginPermissions` read.
  - A grant written right after boot uses the boot revision as its base.
  - A remote change between the boot read and the first `hello` is picked up.
  - The legacy migration still reloads after its merge.
  - An absent record seeds empty.

### Slice 7: the advertised-map digest (D4, Q2; needs Durable Drafts in `dev`)

Files:

- shared: `shared/resources.ts` (the digest function), `shared/events.ts` (`hello.digest`)
- server: `server/src/routes/events.ts`, and `server/src/app.ts` if the store must be passed to
  the socket route
- client: `src/ts/network/eventFeed.ts` (the advertised map and the skip),
  `src/ts/storage/resourceSync.svelte.ts` (`reconcileRemote` from the map),
  `src/ts/process/memoryTasks.svelte.ts` (fences from the map)
- guides: persistence and self-host-server

Tests:

- **Server.** The key test runs a real store and feed through every commit kind: resource insert,
  update and delete; character create and delete with their chats and orders; chat ops, create and
  delete; order writes; a rolled-back write. After each, a map built from the first listing plus
  every published frame must digest equal to the next `hello`.
  - This catches any write path that skips the feed.
  - Startup normalization and `replaceAll` (new epoch) must make the old map mismatch.
- **Client.**
  - A matching `hello` reads no listing.
  - A dropped middle frame mismatches.
  - A listing that resolves after its socket was replaced is ignored.
  - Memory fences settle from the map's server revisions while the held chat is still behind (a
    pending hydration), so the fence stays until the chat holds that revision.
  - A deleted chat in the map settles its fence as absent.
  - A hello without a digest reads the listing.
  - An epoch change behaves as today.
- **Measured.** `resume` bytes before and after, and the server's hello time on the audit fixture.

### Slice 8: more kinds in the boot cache (Q4, Q6; needs 1, 5)

Files: `shared/resources.ts` (`BOOT_CACHED_KINDS`, plus an eligibility table), `server/src/routes/resourceBoot.ts`,
`src/ts/storage/bootCache.ts`, `src/ts/bootstrap.ts`, and the persistence guide.

- **Eligibility comes first.** A kind is never cached if it has a server `project`, holds
  credentials (`secrets`, `authRefreshes`, `credentials`, `llmSecrets`, `providers`), or holds plugin
  values (Q6). Field-level exclusions like the character `apiKey` rule are listed for each added
  kind (for example `customModels[].params` and `providers.additionalParams` header lines).
- **Then size.** Kinds are added from what is eligible where Slice 1's omission deltas show they
  matter. Chat summaries are cached per character if Q4 says so.
- **Tests:**
  - A cached and a stale record of each added kind.
  - An ineligible kind is never claimed.
  - The claim budget still drops claims whole.
  - `expandBootAnswer` equals a plain read.
  - If Q4 says so: a per-character summary claim with one chat changed, added or removed.

### Slice 9: docs close and browser drive (needs all)

- The guides record the final numbers. The archive's Boot resource cache leftovers that this plan
  closed (compression, the version-1 database) come off its pending list. `measureBoot.mjs` and
  `checkBootCache.mjs` run on both fixtures.

## Recommended order

1, 2, 3 and 4 now, in any order → 6 → 7 → 5 → 8 → 9.

**Precondition for Slices 5–8: Durable Drafts merged into `dev`.**

- Its target branch (`claude/plan-runner-durable-drafts-docs-648899`, `34747f6e7`) holds Slices
  1–11 on 2026-10-29. Slice 12 (docs close and browser drive) is left.
- It rewrites `resourceSync.svelte.ts`, `chatStore.svelte.ts`, `resourceClient.ts` and
  `bootstrap.ts` (the awaited `recoverJournal()` stage after `applyFirstBootDefaults`). Slices 5–7
  change the same files, and Slice 7 changes the same refresh paths that its asynchronous refreshes
  use.
- Waiting avoids rebasing against a moving target. It does not replace the integration checks:
  Slice 6 and Slice 7 tests run against its recovery and refresh paths.

**Job Protocol.** Its Slice 3 (`d4586f152`, on `dev` since `a15eaa2c4`) extracts the
per-part send runner in `server/src/prompt/runner.ts`, where `stampInteraction` lives. Slice 5
therefore runs after it. Job Protocol also edits `server/src/app.ts` (receipts), and Slice 7 may need
that file.

**Slices 1–4.** Their product changes touch neither plan's code. They share guide files with both
plans (persistence, self-host-server), so guide edits need the usual merge care.

## Verification

- Per slice:
  - V1: `pnpm check`, `pnpm --silent test:agent`, and the affected `slow` and `e2e` sets. Slice 2
    also needs `pnpm build`.
  - V6: each new regression test is shown failing once with its guard broken.
  - V4: `rg` each changed export, wire field, kind name and file name across `src`, `server`,
    `shared`, `util`, `e2e` and `docs`.
  - V7: extend `bootMocks.ts`, `createCollectorMock` and the resource client mocks. About ten tests
    mock `resourceClient` inline: add new exports to each, or move them to a shared factory.
  - V8 and V9, and prettier on changed files.
- Timing: the gate uses small fixtures, injected clocks, deferreds and latches. It never waits a
  real 30 s, never relies on idle scheduling or production deadlines, and never asserts throughput
  (V3). Sizes and times live in Slice 1's driver and Slice 3's benchmark.
- Each test must catch one of these wrong implementations:

  | Wrong implementation                                         | Caught by                                  |
  | ------------------------------------------------------------ | ------------------------------------------ |
  | A write path that changes the listing without a frame        | Slice 7 map-equals-hello over commit kinds |
  | The client digest built from held instead of advertised      | Slice 7 pending-hydration fence            |
  | A skip after a missed frame                                  | Slice 7 dropped middle frame               |
  | A stale socket's listing adopted                             | Slice 7 replaced-socket listing            |
  | A job kind that still writes the character                   | Slice 5 per-kind job tests                 |
  | A stale `lastMessageAt` after a message op                   | Slice 5 memo tests                         |
  | A loaded chat ranked by its stale summary                    | Slice 5 home and mobile list tests         |
  | The derived time missing from plugin `getChar` or the export | Slice 5 plugin and export tests            |
  | Permissions seeded without their revision                    | Slice 6 grant-after-boot                   |
  | A corrupt or mismatched asset reported present               | Slice 3 wrong-hash and claimed-name cases  |
  | A compressed body under the identity ETag, or the wrong MIME | Slice 2 per-encoding and MIME tests        |
  | A credential-bearing kind cached                             | Slice 8 ineligible kind                    |

## Out of scope

- Characters as a projection at boot (Q3), unless the measurement asks for it.
- The boot's client-side work after the read (parsing, installing, Svelte work).
- Sign-out clearing of the boot cache: there is no sign-out.
- Server-side import helpers that skip an existing content-addressed file on existence alone
  (`contentAsset.ts:33`, `importModule.ts:121`, backup restore `backups.ts:413`): recorded in
  `docs/research/found-issues.md` when this plan closes, for the retention or byte-budget plan.
- Firefox, Safari and mobile runs of the drivers (device checks go to the user).
- Per-event server work (ST04, SD01, TJ04), dictionary ids (ST01, CE05) and server byte budgets:
  their own deferred plans.

## Later

- A persisted change log and a `changes?since=` cursor (Q2).
- A character projection with background backfill (Q3).
- A summary projection that does not parse whole chat `meta` (Q4's server half), if Slice 1 shows it.
- The boot cache following the tab's acknowledged state, if Slice 5's numbers leave own edits as a
  large share. That needs server-canonical texts or hashes in acknowledgements and frames, and a
  cross-tab writer (review points 1–3).

## Review record

The Astra review of the first draft (2026-10-29, `gpt-6-astra`, read-only, against `7dd37b1c2`,
Durable Drafts `34747f6e7`, Job Protocol `d4586f152`) raised 17 points: 2 blockers, 8 major and
7 minor.

- **Blockers.**
  - Point 1: the first D2 cached the tab's acknowledged text, which is not the server's stored
    value when the server normalizes (for example `formatingOrder` gains `personaPrompt`, from
    `shared/presets.ts:580`). That poisons the cache and Durable Drafts' recovery baseline.
  - Point 4: settling memory-task fences from held revisions frees a fence while a refresh is still
    pending.

  The first is answered by dropping the first D2: "last chatted" now comes from the chats and the
  server stops stamping the character (the new D2, Q1).
  Points 2 and 3 (item hashes, a repeated cross-tab writer) go with it. The second is answered by
  D4's advertised map: fences settle from server revisions, never held ones.

- **Major points taken.**
  - Point 5: a copied frame digest cannot detect a missed frame. Answered by the client computing
    its digest from the advertised map.
  - Point 7: the first draft's claims about which costs remain were too narrow; Q1 and Q3 are
    restated, and the `otherDevice` scenario is added.
  - Point 8: cache eligibility comes before size (Q6, Slice 8).
  - Point 9: the server-side summary parse is measured and kept open (Q4).
  - Point 10: verification is asynchronous, with concrete budgets.
  - Point 11: the canonical single `saveAsset` is included, and the server import skips are named
    as out of scope.
- **Minor points taken.**
  - Point 6: there is no commit-path digest, since the hello recomputes it.
  - Point 12: the D5 representation rules.
  - Point 13: D6 repairs by upgrade instead of deletion.
  - Point 14: the fixture builder and the omission-delta criterion.
  - Point 15: current-state corrections and anchors.
  - Point 16: pinned branch commits and the wiring files.
  - Point 17: sharper tests.
- **Trimmed.** None of the points was rejected. The 100 × 1 MiB comparison moved out of the gate
  into a manual benchmark, as the review suggested.
