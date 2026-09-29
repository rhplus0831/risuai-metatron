# Slice: Live Updates

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Live updates" (resource-change
events with revisions over the WebSocket; the client applies events to its projections and
refetches on a gap) and the exit criterion "Two clients converge after a write in either";
`PLAN.md` End State ("receives changes over a socket"), Closeout Criteria ("Two clients of the
same server converge after a write in either"), invariant 2 (hydration never becomes an outgoing
edit), invariant 4 (every resource carries a revision).

Depends on: Phase 5 `generation-jobs` (the one upgrade dispatcher by path prefix in
`server/src/app.ts`, JWT-only socket auth, `applyHydration` in `resourceSync.svelte.ts`) and
`job-channel` (its `resource` events on the job socket stay authoritative for callbacks; this
slice does not touch them). Phase 2 (`applyToMirror`, `finishIdleChatRefresh`, the idle
re-base). Phase 4 (`pluginStorageStore`: `pluginStorage` has no watcher, so a remote copy of it
reaches the mirror only through this slice's live-apply). Independent of the projection slices:
events land in the flat mirror through the functions a conflict reload uses today, and the
projection slices retarget those functions. In parallel with `spike-projection-bindings`.

## Scope

Allowed files: `server/src/data/changeFeed.ts` (new: the listeners and the publish helper),
`server/src/data/resourceStore.ts` (the after-commit notification in `applyChanges`, `put`,
`delete`, `transaction`, `replaceAll`), `server/src/routes/events.ts` (new: the `/api/events/ws`
upgrade handler and `GET /api/resources/revisions`), `server/src/app.ts` (the dispatcher entry,
`beginShutdown` closing the feed sockets), `shared/resources.ts` (the change-set and
revision-listing wire types), `shared/events.ts` (new: the socket frames), `src/ts/network/eventFeed.ts`
(new: the client socket, reconnect, the reconcile on every `hello`), `src/ts/storage/resourceSync.svelte.ts`
(`applyRemoteRecord`, `reconcileRevisions`, the pending-remote set and its settle hook),
`src/ts/storage/chatStore.svelte.ts` (`markChatStale(ref)` as the public form of the
idle-refresh mark; the pending-remote order set), `src/ts/plugins/apiV3/permissionStore.ts`
(`reloadPluginPermissions`), `src/ts/process/files/inlays.ts` (`refreshInlay(id)`),
`src/ts/bootstrap.ts` (connect after the boot read), `src/lang/en.ts`. `vite.config.ts` needs
no change (`/api` is proxied with `ws: true`, `vite.config.ts:44-49`). Tests belong to the
review step.

Identifiers (verified 2026-09-30): the store commits: `applyChanges` (`resourceStore.ts:485-589`;
`db.exec("COMMIT")` at 581), `put` (413-445), `delete` (451-466), `transaction` (600-637, commit
at 623-628; no production caller today, `rg -n '\.transaction\(' server/src` outside tests is
empty, so the live commit points are the other four), `replaceAll` (757-780, the new epoch
assigned after commit at 777), `epoch()` (316); no listener, hook, or emitter exists in
`server/src/data`. Callers of the write methods outside tests: `routes/resources.ts:166`
(batch), `:240` (PUT), `:266` (DELETE), `routes/backups.ts:98` and `:335` (`replaceAll`); Phase
5 adds the job runner's in-process `applyChanges`. The upgrade today: `proxyStreamJobs.attachWebSocket`
(`proxyStreamJobs.ts:437-476`: `WebSocketServer({ noServer: true })`, `auth.isAuthorizedProxyToken`
over query or header `risu-auth`, heartbeat `{ type: "ping", ts }` 5 to 60 s); `app.ts:193`
exposes `attachWebSocket`, `main.ts:46` calls it; `ws` `^8.22.0` (`package.json:75`). Auth:
`verifyJwt` (`auth.ts:41`, JWT only), `checkAuth` (88), `isAuthorizedProxyToken` (108, also the
raw password). Maintenance: `snapshots.track` admits HTTP handlers only (`app.ts:125-127`); an
upgraded socket is neither tracked nor gated; `beginShutdown` (`app.ts:87-97`). Revision tokens
are `<epoch>:<seq>:<revision>` with `seq` the record's incarnation (`resourceStore.ts:157-206`,
`parseToken`). Client: `acceptRemote` (`resourceSync.svelte.ts:817-847`: `applyToMirror`,
`persisted`, then `discardSequence += 1`, `discarded.set`, `settle`, `dirty.delete`, the
listeners: conflict semantics), `applyToMirror` (1021-1080), `recoverFromConflict` (865-919),
`flushResources` (1087: `await tick()` first, because a watcher-driven edit becomes dirty only
when its `$effect` runs), `haltForRestore` (800-815), `onRemoteRecordApplied` (188), `persisted`
and `dirty` (119-124), `inFlight` (145), `deferredCharacters` (155); `acceptRemoteChat`
(`chatStore.svelte.ts:2149`), `acceptRemoteCollection` (2218: clears pending order work, so it
is not a safe handler for an unsolicited order event), `finishIdleChatRefresh` (2202-2211:
rechecks `canRefreshChat` after the read's await), `idleChatRefreshes`, `staleChats`,
`isChatDeferred` (2389), `setRemoteChatListener`; the boot read `readKinds(Object.values(RESOURCE_KIND), { chats: true })`
(`bootstrap.ts:44`), `seedResources` (`resourceSync.svelte.ts:166`); `setEpochMismatchListener`
(`resourceClient.ts:47-74`). Other resource owners outside the mirror: `permissionStore.ts`
(its own `current` loaded by `loadPluginPermissions`, 45-47; `applyToMirror` has no
`pluginPermissions` branch), `inlays.ts` (`seedInlays` 65, `invalidateInlayCaches` 74). No
`sessionStorage`, `tabId`, or client identity exists in `src/` today.

Stopping condition: a commit path the feed cannot observe from the store (a writer that bypasses
the five methods), or a client application path that would discard a local edit without a 409
(invariant 2 and D4 forbid it); recorded and reported, not patched around.

## Assumptions

- Phase 5 `generation-jobs` installed one `upgrade` listener in `app.ts` routing by path prefix
  and authenticating the job socket with `verifyJwt` only; this slice adds the `/api/events/`
  prefix and reuses that listener.
- Phase 5 `generation-jobs` added `applyHydration({ kind, id, revision, data })` to
  `resourceSync.svelte.ts` and `job-channel` sends the job's changes to the owner as `chunk` and
  `resource` events before a `callback` (its barrier). Both stay; the feed pushes the same records
  to every tab, and both paths apply a record only when its revision is newer (the rule below;
  `applyHydration` adopting it is a proposed Phase 5 edit in the report).
- Phase 3 replaced `root` with the section and collection kinds; `applyToMirror` (or its Phase 3
  successor) accepts each of them and calls `reconcileSelection()` after a collection
  replacement. Unverified against Phase 3's implementation.
- Phase 4 (verified against its slices): the contract writers mark their records dirty through
  the mutation modules, `pluginStorage` has no watcher, and the core-app writers still reach the
  mirror through the section and character watchers; an edit therefore becomes dirty either
  synchronously (a mutation function) or when the watcher's `$effect` runs, which is why the
  live-apply function awaits `tick()` before it checks.

## Proposed decisions

- Emission point (proposed): the store, not the routes, because the Phase 5 job runner and any
  later in-process writer commit through the same methods. `createResourceStore` takes a
  `changeFeed` and, after every successful `COMMIT` in `applyChanges`, `put`, `delete`, and
  `transaction`, calls `feed.publish(changeSet)` outside the transaction scope (a listener cannot
  write inside it). `replaceAll` publishes `{ epoch: nextEpoch }` alone: every client reloads, as
  the 412 path does today. A change set is
  `{ resources: [{ kind, id, revision | null }], chats: [{ characterId, id, revision | null }], chatOrders: [{ characterId, revision }] }`
  (`shared/resources.ts`): refs and revisions only. No ops, no data, no sequence number, no
  origin (Astra P1, P3, P4; Opus P2, P3). The feed keeps listeners only: no ring buffer, so no
  `since`, no `seq` in the read results, and no process identity is needed (Astra P3's `feedId`
  cursor becomes unnecessary once nothing is replayed). Alternative (canonical applied deltas in
  chat events): recorded for a later phase; it needs `applyGroup` to report effects, not the ops
  it received.
- Socket and reconcile (proposed): `GET /api/events/ws?risu-auth=<jwt>` on the Phase 5
  dispatcher, `verifyJwt` only (never the raw password), one socket per tab, frames
  `hello { epoch }`, `change <ChangeSet>`, `epoch { epoch }`, `ping` (the proxy jobs' heartbeat
  constants). On every `hello` (boot, reconnect, server restart) the client calls
  `GET /api/resources/revisions` (`{ epoch, resources: [{ kind, id, revision }], chats: [{ characterId, id, revision }], chatOrders: [{ characterId, revision }] }`,
  no data) and reconciles: every ref whose revision differs from what it holds goes through the
  live-apply below; a resource, chat, or order the server no longer lists is a `revision: null`
  entry. The socket is opened before the reconcile, so nothing committed between the two is
  missed. Reconnect uses the save loop's backoff. `beginShutdown` closes every feed socket with
  code 1001 before `snapshots.stop()`; sockets are not tracked by `snapshots.track` and not gated
  by maintenance (a restore publishes `epoch`, which reloads the clients). The client reconnects
  with the same URL; there is no cursor to carry.
- Live-apply (proposed; Astra P1, Opus P4), `applyRemoteRecord(ref)` in `resourceSync.svelte.ts`:
  1. Refs from a change set or a reconcile are batched (50 ms) into one `readRefs` for the
     records this client holds or subscribes to (the dispatch inventory below).
  2. After the read, `await tick()` (so a watcher-driven edit made meanwhile is dirty), then
     re-check at application time: a key that is dirty, in flight, deferred, or quarantined is
     not applied now; its key goes into `pendingRemote`. When the cycle later settles that key
     (acknowledged, or discarded by a conflict) or the deferral ends, the key is re-fetched and
     re-checked (Astra P1's minimal form: a skipped record is never forgotten, even when no
     further write happens).
  3. The fetched token is compared with `persisted`: apply only when its `seq` differs (the
     record was recreated) or its revision is higher than the held one (Opus P4: two batched
     reads can resolve out of order, and a job's `resource` event may have applied it first);
     otherwise nothing.
  4. Application writes the mirror through `applyToMirror` and sets `persisted` to the server
     revision and the hydrated text, and runs `onRemoteRecordApplied`, `reconcileSelection()`
     (Phase 3), and `noteMirrorReplaced()`; it never records a `discarded` entry, never bumps
     `discardSequence`, and never `settle`s a key: nothing was discarded, so `resourceReloaded` is
     not shown and `flushResources` is not told a discard happened.
- Resource-kind dispatch inventory (Astra P10), by owner: the section and collection kinds,
  `presets`, `modules`, `plugins`, and `pluginStorage` → live-apply into the mirror (Phase 4's
  `pluginStorageStore` has no watcher, so its dirty mark is the module's; the same skip rule);
  `characters` → live-apply, including a member this client does not hold yet (a new character
  is subscribed state: it is fetched and inserted with its chat collection, as
  `recoverFromConflict` does for an inserted character today) and `revision: null` (removed;
  the selection moves home as today); chats → `markChatStale(ref)` and the existing idle-refresh
  read with `finishIdleChatRefresh`'s recheck (a chat with pending, in-flight, deferred, or
  quarantined work, or a running generation, keeps its mark and is refreshed later; after
  `chat-projection-and-lazy-loading`, an unloaded chat refreshes its summary only); chat orders →
  applied only when the character has no pending or in-flight order work, else kept in the
  pending set and applied after it settles (never through `acceptRemoteCollection`, which clears
  pending order work); `inlays` → `refreshInlay(id)` (the cache entry is invalidated and re-read
  on demand); `pluginPermissions` → `reloadPluginPermissions()` (the store's own `current`, with
  its own read-merge-write conflict rule unchanged); `llmSecrets` → the masked status record is
  replaced (read-only on the client, `settings-ownership`).
- Observers of a running generation (proposed): no observer socket. The job's checkpoints (every
  3 s, `generation-jobs`) are commits, so every other tab receives the chat's ref through the feed
  and refreshes the chat (one read per checkpoint per observing tab; the rare case); `done`
  publishes the final write. Alternative (a per-job observer stream with every chunk): recorded;
  add only if the 3 s granularity is judged insufficient (open question 2 in the report).
- Callback barrier: unchanged from Phase 5 (Astra P2, Opus P5). The job socket's `resource`
  events remain the owner's guarantee before a callback; the feed deduplicates through the
  newer-revision rule.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests:
`server/src/tests/changeFeed.test.ts` (a change set per commit path including an in-process
`applyChanges`, no publish on a rolled-back transaction or a 409, `replaceAll` publishing
`epoch`), `server/src/tests/events.test.ts` modeled on `proxyStreamJobs.test.ts` (`listen()`/`collect()`
helpers: auth with a JWT and refusal of the raw password, `hello`, a change delivered to two
sockets, close on shutdown, heartbeat), the revisions route, and
`src/ts/storage/tests/resourceSyncLive.test.ts` over `storeBackedServer.ts` extended with a fake
feed: a change applied to an idle record without a notice and without a discard entry; an
event arriving before this tab's own acknowledgement (the record is not regressed and the
acknowledgement's revision is kept); an edit made during the refetch (the fetched copy is not
applied; the key is pending and re-fetched after the next save); an in-flight record left alone
and re-fetched after its acknowledgement; two reads resolving out of order (the older revision
is not applied); a recreated record (a different `seq`) applied; a chat `setText` from another
tab refreshing an idle chat; a busy chat re-based later; a remote reorder during a local reorder
(applied after the local one settles); a new character inserted with its chats; a deleted
selected character moving the selection home; `reconcileSelection` after a `presets`
replacement; a permission grant reloaded; an inlay refreshed; a reconcile after `hello` fetching
every differing record and dropping a removed one. Manual, recorded in the phase file (the
two-client convergence check): two headless Chrome tabs against one server: a settings edit, a
character edit, a chat rename, a message edit, a chat delete, and a preset edit in one tab appear
in the other without a reload and without a notice; a preset, persona, or chat selection change
in one tab does not change the other's selection (Decision 3; the five keep-on-switch
`providers` fields and the translator and HypaV3 `selectedId` values do change, because they are
shared records; Astra P11, Opus P8); a send in one tab shows its text in the other at checkpoint
granularity and the final text at `done`; a restore reloads both; killing the server, making
more than one change through the routes, and restarting it reconnects both tabs and reconciles
every change (the restart case cannot pass by replay, only by reconcile).

## Residual risk

Two clients editing the same record concurrently still converge through the 409 path: the later
saver's edit of that record is discarded with the notice, as in Phase 1 (whole-record sections;
Phase 3's choice). A reconcile after every `hello` reads every revision on the server (bounded
by the record count, no data). An observing tab reads a whole chat per checkpoint. Until the
projection slices land, events are applied to the flat mirror through `applyToMirror`, which is
what the projections read, so no second application path exists.
