# Static Audit Fixes Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at
`832caccf0`, after the Per-Chat Send plan was archived. No slice landed. Per-Chat Send slice 7
(`c9e6cde40`) landed after drafting and changed `server/src/jobs/channel.ts`,
`src/ts/network/jobChannel.ts`, and `src/ts/process/request/request.ts`, so line numbers cited
there are stale. Source:
[`docs/audit/static-audit-2026-10-23.md`](../audit/static-audit-2026-10-23.md) (audited at
`79ae26cc4`; IDs D1–F4 below are that report's). A Luna fan-out (8 workers) re-verified every
finding against `28e7fda88` and mapped the fix points, and the session re-read the toggle
preset readers. Line numbers are approximate; the identifiers are the anchors. Re-verify each
cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Where a slice fixes a Known Hazard, it removes or rewrites that hazard
line. Code comments and test titles describe behavior, not this plan or the audit
(`STRUCTURE.md` T5).

## Problem

Every finding still holds at `28e7fda88`. F4 is the exception: Per-Chat Send already made
queued deadlines start at dispatch. Most of the findings are recorded Known Hazards; the
audit validated them and set priorities.

- D1 (P1). Refused data stays visible but is not protected at close.
  - The data path:
    - `resourceSync.svelte.ts` `hasUnsavedWork` (~970-977) leaves out quarantined records and
      calls `hasUnsavedChatWork` (`chatStore.svelte.ts` ~3074-3083), which leaves out
      quarantined chats and orders. `beforeunload` (~3797-3804) warns only on that predicate.
    - A quarantined record leaves quarantine when its projection changes (~894-911) or a
      remote copy is applied (~1942-1955).
    - A quarantined chat never leaves it during the session. The set is module-local
      (`chatStore.svelte.ts` ~233-236), `takeChatWork` skips it (~3514-3519), and only an
      acknowledged character delete clears it (~3433-3440). Later edits queue work that is
      never sent; a flush then rejects (`resourceSyncChats.test.ts` ~1402-1421).
  - What the user sees:
    - Only the first alert (`en.ts` ~1505-1510, which says to export before reload). No
      badge or banner: `src/lib/SideBars/chatStatus.ts` (~3-19) has no refused state.
    - Known Hazards: `persistence.md` ~279-292, ~306.
- D2. A character create whose answer was lost is adopted but never learns its chat order.
  - On the retry's conflict, the `sameJson` branch (`resourceSync.svelte.ts` ~2641-2650)
    marks the character persisted and continues without hydrating it. The conflict read
    (~2617-2620) asks for the named chats only.
  - `isCharacterKnown` (`chatStore.svelte.ts` ~3481-3484) is then false: no `orderRevisions`
    entry, and the retry is no longer a create. `takeChatWork` (~3520-3572) parks the chat's
    resend and every later edit, and `flushResources` throws after ten cycles (~3682-3728).
  - A chat-order feed notice can rescue it (~3062-3127), but nothing guarantees one.
  - Also recorded as the open-bug-fixes A3 leftover in the archive.
- D3. Toggle preset additions are lost on a two-tab conflict.
  - `saveTogglePresetFromChat` (`src/ts/toggles/togglePresets.svelte.ts` ~21-28) pushes the
    preset and separately links the chat.
  - `togglePresets` is not in `ITEM_LIST_MERGE_KINDS` (`resourceSync.svelte.ts` ~2366-2373).
    A conflict therefore falls to `acceptRemote` (~1935-1955): the preset is dropped while
    its chat link lands, and the sidebar shows "deleted" (`Toggles.svelte` ~47-64).
  - Known Hazard: `persistence.md` ~282.
  - Separately, `jobScopeKinds` (`server/src/jobs/jobScope.ts` ~116-126) puts every
    collection into the job scope and the render cache key (`server/src/prompt/transform.ts`
    ~352-368, ~421-446). Saving a preset therefore invalidates cached renders, although no
    server prompt or job code reads `togglePresets`. Its only server readers are
    normalization, kinds, and the upstream export.
- N1. The live feed loops at about 1 s when reconciliation keeps failing.
  - `eventFeed.ts` resets `attempt` on hello (~93), before `reconcile` (~59-75) succeeds.
  - Backoff is 1, 2, 4, 8, 16, 30 s with no jitter (~47-56).
- N2. ComfyUI polls the whole history.
  - `stableDiff.ts` (~562-577) fetches `/history` with `fetchNative`, parses all of it, picks
    `[id]`, and sleeps 1 s.
  - The timeout is checked only after a response, and no signal is passed.
- N3. Cancelled image and TTS work keeps running.
  - `generateAIImage` (`stableDiff.ts` ~87-92) takes no signal, and none of its providers
    get one (~93-905). `stableDiff` calls `requestChatData` without its abort argument
    (~43-75).
  - The job channel's `Outstanding` (`jobChannel.ts` ~108-128) has a `cancelled` flag and no
    controller. The Lua image callback checks before and after the call (~658-681);
    `imggen` checks only before (~756-771).
  - `stopTTS` (`tts.ts` ~496-510) aborts no fetch. The Hugging Face branch's 503
    `estimated_time` retry (~323-347) sleeps and posts again after Stop.
- F1. Media object URLs live for the whole page.
  - Owned by the Direct Asset URLs plan (`direct-asset-urls.md`),
    which retires them on the main path. Its fallback leftovers are listed there. Not
    sliced here.
- F2. The upstream export does all of its database work on the serving thread.
  - `backupsUpstreamExport.ts` (~218-225) runs `readSnapshot` (`resourceStore.ts`
    ~1579-1666), `buildUpstreamDatabase`, and `encodeUpstreamDatabase` (`risuSave.ts`
    ~180-193, `compressSync`) with no await. Only then does it check the size.
  - Known Hazard: `self-host-server.md` ~575, ~589-591.
  - The import side already runs in a heap-capped `worker_threads` worker (`importRunner.ts`,
    `importWorker.ts`).
- F3. The local model queue has no admission limit.
  - `server/src/prompt/transformers.ts` keeps an unbounded `Pending[]` (~169-178). `run`
    (~314-339) pushes whole payloads; a caption task holds the full base64 data URL (a
    50 MiB image is ~67 MiB of text).
  - The task timeout starts at dispatch (~265-304), and the child has no resource limit
    (~69-73).
  - Callers: embeddings (HypaV2/V3, Hanurai, Supa), summarization, image captioning, and
    WebLLM generation. Each surfaces a failure as a job error.
- F4. A tab's lane holds queued roots with no time bound.
  - `server/src/jobs/channel.ts` queued roots wait with `deadline: Infinity` (~416-424).
    Per-Chat Send D2 kept that on purpose: job life, the caller's signal, and the 256 cap
    bound it.
  - The case the audit adds is a lane with no owner. The first root dispatches, waits its own
    60/120 s, and expires `disconnected` (~314-361). Then the next queued root dispatches and
    waits again, so queued roots fail one after another until their jobs end.
- Lower priority:
  - The restore watcher (`resourceSync.svelte.ts` ~1879-1925) races `getResource`
    (`resourceClient.ts` ~223-231, no signal) against 5 s and never aborts the loser.
  - Asset, snapshot, push, and diagnostics writes rename without `fsync`:
    - `storage.ts` ~181-202, ~403-485
    - `contentAsset.ts` ~44-73
    - `snapshots.ts` ~114-130
    - `pushService.ts` `writeJsonAtomic` ~166-171
    - `journal.ts` `writeAtomic` ~492-531
  - Auth files are written with plain `writeFileSync` (`routes/auth.ts` ~149-152,
    ~174-180). A truncated `known_public_key_hashes.json` stops the server at start
    (`main.ts` ~121-123). An empty `password` reopens `/api/set_password`, which the first
    unauthenticated caller may use (~169-181).
  - Known Hazards: `self-host-server.md` ~594-599.

## Approach

Fix each finding at its source with a deterministic test of the failure the audit describes.
No new subsystem. The client persistence fixes share `resourceSync.svelte.ts` and
`chatStore.svelte.ts`, so they run one after another. The others are independent file
clusters. Two decisions change a documented contract and need the owner's word: Q1 (unload
warning while data is refused) and Q6 (initial password seed and damaged auth files). The
owner decided both on 2026-10-23: (a) for each.

## Order

Three chains run side by side. Slices in one chain share a source file or their owning
guide; slices in different chains share neither. Wave A is 1, 7 and 9.

- Client persistence (`persistence.md`, `resourceSync.svelte.ts`, and for 1–3
  `chatStore.svelte.ts`): 1 → 2 → 3 → 6 → 5. Slice 4 (`ui-theming.md`) follows 3, in
  parallel with 6.
- Media (`media-aux.md`): 7 → 8. Slice 11 (`plugins-mcp.md`) follows 7.
- Server (`self-host-server.md`): 9 → 10 → 12 → 13 → 14. Slice 13 uses the helper 12 adds.
- Per-Chat Send: landed and archived (`832caccf0`). Its slice 7 (`c9e6cde40`) edited
  `jobChannel.ts` and `server/src/jobs/channel.ts`; slices 11 and 14 re-read both first.

## Slice 1. Toggle preset additions merge across tabs (_small_, `persistence.md`)

- Add `COLLECTION_KIND.togglePresets` to `ITEM_LIST_MERGE_KINDS`
  (`resourceSync.svelte.ts` ~2366).
- Merge conditions hold: presets have unique, normalized string `id`s (`shared/togglePresets.ts`
  ~13-38, ~112-143), which `itemIds` (`shared/recordPatch.ts` ~18-40) and `mergeItemAdds`
  (~2384-2418) require.
- Edits, removals, and reorders of a saved preset still go the conflict and reload way, as
  for the other kinds.
- `persistence.md`: remove the ~282 hazard, or narrow it to concurrent edits of one preset.
- Test:
  - `resourceSyncMerge.test.ts` (next to the item-list suite, ~985-1137): two tabs add
    different presets against one revision, and both survive.
  - `resourceSyncSections.test.ts` or `chatToggles.test.ts`: two tabs each save a preset
    from a chat and link it, and both links resolve, with no "deleted" state.

## Slice 2. An adopted character create learns its chat order (_hard_, `persistence.md`)

Depends: 1.

- In the conflict recovery's `sameJson` branch (`resourceSync.svelte.ts` ~2641-2650), when
  the adopted record is a character whose create was in doubt:
  - Read its chat list with `readRefs([], { chatSummaryCollections: [id] })` (the
    `readSummaryList` call in `chatStore.svelte.ts` ~5002-5009, served by
    `POST /api/resources/read`).
  - Apply the result with `applyRemoteCollection`, which keeps pending by-id work
    (~4592-4678, ~4746-4758). Do not use `acceptRemoteCollection` (~4778-4813), which
    replaces the list.
- Once `orderRevisions` holds the character, the parked resend and later edits go out in the
  same flush.
- `persistence.md`: rewrite the hazard if one names this.
- Remove the archive's A3 leftover line when the plan is archived.
- Test, in `resourceSyncChats.test.ts` (near ~198-223 and the lost-create cases
  ~1193-1214, ~1515-1582):
  - A batch creating a character and its first chat commits, but its answer is lost.
  - The retry's 409 is recognized by JSON. No feed notice arrives.
  - The chat is then edited and flushed. The flush resolves, and the server holds the edit
    with no reload.
  - It fails on today's code: the flush throws "Could not save every change".

## Slice 3. Refused data stays protected and can be released (_hard_, `persistence.md`)

Depends: 2. Q1 decided: (a).

- Separate "will not be sent" from "not saved":
  - `hasUnsavedWork` (~970-977) counts quarantined records whose local text still differs
    from `persisted`.
  - `hasUnsavedChatWork` (~3074-3083) counts quarantined chats and orders with local
    content.
  - `beforeunload` (~3797-3804) then warns while refused data exists (Q1).
- A chat leaves quarantine on its next local edit, as a record does when its projection
  changes:
  - The edit clears the key from `quarantined` and queues a whole-chat resend.
  - A second refusal quarantines it again without a second alert (the per-key alert guard
    covers the session).
  - No automatic retry loop: only a user edit or an explicit Retry releases it.
- Export a small API for the UI slice:
  - `refusedItems()`, a readable list of `{ kind: "record" | "chat" | "order", key, reason }`.
  - `retryRefused(key)`: resend once.
  - `discardRefused(key)`: apply the server copy. For a record, through `acceptRemote` with
    its discard recorded. For a chat, through a chat read that replaces the local copy and
    clears the key.
- Keep the backup contract:
  - A chat quarantine still reports through `chatDiscardsSince` as discarded
    (`backuplocal.ts` ~107-141, ~187-204, ~348-381).
  - A record quarantine still makes `flushResources` throw (~3671-3681).
- `persistence.md`: rewrite the quarantine hazards (~279-292, ~306).
- Test:
  - `resourceSyncChats.test.ts`: a refused chat keeps `hasUnsavedWork()` true until it is
    discarded. An edit after the refusal resends the whole chat, and its acceptance clears
    the quarantine. A second refusal alerts once in total.
  - `resourceSync.test.ts` (~708-739): a quarantined record keeps the unload warning until
    edited or discarded.
  - `discardRefused` restores the server copy.
  - `backuplocal.test.ts`: still lists the chat as discarded.
  - Update `chatStore.test.ts` ~446 and `resourceSyncChats.test.ts` ~1297-1421, where they
    pin "nothing more is sent this session".

## Slice 4. Refused data is shown with export, retry, and discard (_hard_, `ui-theming.md`)

Depends: 3.

- Add a `refused` status to `src/lib/SideBars/chatStatus.ts` (~3-19) for quarantined chats.
  The pinned rail, sidebar rows, and home cards show it, with a higher priority than
  `unseen`.
- Show a persistent banner while `refusedItems()` is non-empty:
  - It sits in the chat screen for the open chat, and in a compact app-level form for
    records.
  - Actions:
    - Export: `exportChat` (`src/ts/characters.ts` ~240-307, the local copy) for a chat,
      or a JSON download of the refused text for a record.
    - Retry: `retryRefused`.
    - Discard: `discardRefused`, behind a confirm.
- Add en and ko strings.
- `ui-theming.md`: the status and the banner.
- Test:
  - `chatStatus` and `PinnedChatsRail` tests show `refused`.
  - A banner component test: the actions call the API, and Discard asks first.
  - An e2e case where the mock server refuses a chat with 400: the banner appears, and
    Export downloads the local messages.

## Slice 5. The live feed backs off until reconciliation succeeds (_small_, `persistence.md`)

Depends: 6 (same guide).

- `eventFeed.ts`:
  - Remove the reset at hello (~93), and reset `attempt` only after this socket's
    `reconcileRemote` succeeds (~59-75).
  - Add full jitter to `scheduleReconnect` (~47-56): random within [delay/2, delay].
- Test, in `eventFeed.test.ts` (fake socket and timers, ~52-95):
  - Two hellos with a failing `listRevisions` wait 1 s, then 2 s.
  - A successful reconcile makes the next close wait about 1 s again.
  - Jitter stays within its bounds (stub `Math.random`).

## Slice 6. The restore watcher aborts its timed-out read (_small_, `persistence.md`)

Depends: 3 (same file).

- `resourceClient.ts` `getResource` (~223-231) takes an optional `{ signal }` and forwards it
  through `sendJson` (~158-160).
- The watcher (`resourceSync.svelte.ts` ~1879-1925) makes one controller per read and aborts
  it when the 5 s race is lost.
- Test: the hanging-read case in `resourceSync.test.ts` (~816-849) checks that each timed-out
  read's signal is aborted, and that epoch detection is unchanged.

## Slice 7. Image generation takes a signal; ComfyUI polls its prompt only (_hard_, `media-aux.md`)

- `generateAIImage` (`stableDiff.ts` ~87-92) takes `options.signal`. Pass it to every remote
  call:
  - `globalFetch` as `abortSignal`; `fetchNative` and `auxFetch` as `signal`.
  - Stability's direct `fetch`.
  - Make the polling sleeps abortable: ComfyUI's 1 s and Wavespeed's 3 s.
  - Check the signal before the common delivery (~78-85), so a late result does not write
    `CharEmotion`.
  - `auxFetchJson` (`auxFetch.ts` ~142-159) must surface an abort as an abort, not as an
    ordinary failure.
- `stableDiff` passes its caller's signal to `requestChatData` (third argument) and to
  `generateAIImage`.
- ComfyUI:
  - Poll `/history/{prompt_id}` (Q2).
  - Check the deadline before each request.
  - Use the same signal for `/prompt` and `/view`.
- `media-aux.md`: remove "an in-flight image request is not cancelled" (the `stableDiff.ts`
  ~14 comment too).
- Test, in `imageDelivery.test.ts` (~114-270):
  - Each provider's request receives the signal.
  - An abort during ComfyUI polling stops it without a further fetch, and no image is
    delivered.
  - ComfyUI requests only the scoped history path. Update the `/history` mock (~245-252).

## Slice 8. Stop aborts TTS requests and retries (_small_, `media-aux.md`)

Depends: 7 (same guide).

- `tts.ts`:
  - Each `sayTTS` run (~130-165) registers an `AbortController`, and `stopTTS` (~496-510)
    aborts every registered one after bumping `stopGeneration`.
  - Pass the signal to direct `fetch`, to `auxFetch`, and to `globalFetch` (`abortSignal`).
  - The Hugging Face 503 retry (~323-347) waits with an abortable sleep and checks the
    generation before each POST.
  - Abort errors are silent in the outer catch.
  - VITS, translation, and asset loading keep their current generation checks.
- Test, in `ttsPlayback.test.ts` (~116-290):
  - Stop during a pending provider fetch aborts its signal.
  - Stop during a Hugging Face `estimated_time` wait makes no second POST.

## Slice 9. The upstream export prepares in a worker (_hard_, `self-host-server.md`)

- Move `readSnapshot`, `buildUpstreamDatabase`, and `encodeUpstreamDatabase` for the export
  into a `worker_threads` worker. Follow the import runner's pattern (`importRunner.ts`
  ~67-129: `workerData` paths, `resourceLimits`, progress/done/error messages, terminate on
  abort).
- The worker:
  - Opens the snapshot copy itself with a read-only `DatabaseSync`. Factor the reader out of
    `resourceStore.ts` `readSnapshot` (~1579-1666); do not build a live store.
  - Projects with the request's `includeSecrets` boolean and selection, encodes, and writes
    `database.risudat` to the staging folder.
  - Posts its size and the report.
- Secret values never cross the thread boundary: the worker reads the copied `llmSecrets` row
  itself, as `exportDatabase.ts` ~244-251 does now. The consent question stays in the tab.
- Keep the route's lifecycle: the four-export limit, the TTL, disconnect and shutdown
  cleanup (`backupsUpstreamExport.ts` ~52-123, ~251-289, ~347-382). Add an abort that
  terminates the worker. The size check moves into the worker before the write.
- The heap cap: Q3.
- `self-host-server.md`: remove the ~575/~589-591 hazard and describe the worker.
- Test:
  - `upstreamExportRoute.test.ts` (~108-269) still passes.
  - A worker test next to `upstreamImportWorker.test.ts` (~85-165): the event loop answers
    while the export is held; shutdown terminates it; the heap cap refuses with the named
    variable.
  - `upstreamExport.test.ts` keeps the secrets cases (~775-813).

## Slice 10. The local model queue admits by count and bytes (_hard_, `self-host-server.md`)

Depends: 9 (same guide).

- `transformers.ts` `run` (~314-339): admit a task only while queued plus active tasks are
  under `MAX_QUEUED_TASKS`, and queued payload bytes under `MAX_QUEUED_BYTES` (Q4). Count
  string lengths, and the data URL for captions.
  - Release the accounting on dispatch, abort, settle, dispose, and worker failure.
  - Refuse with a `TransformersQueueFullError` carrying `reason: "queueFull"`, the shape the
    memory tasks' 429 uses.
- Add a queue-wait deadline (`QUEUE_WAIT_MS`) separate from the runtime timeout, which still
  starts at dispatch.
- Callers keep their error paths but name the cause:
  - Embeddings, HypaV2/V3, Hanurai, Supa (`embeddings.ts` ~212-217, `runner.ts`
    ~1320-1328).
  - Summarization (~1066-1072) and captioning (~1284-1291).
  - WebLLM (`server/src/llm/request.ts` ~671-719).
  - A full queue reads "Local model queue is full", not a bare 500 with stage `assembly`.
- Child memory limits and the fp32 generation weights stay out (Q4).
- `self-host-server.md`: the admission rule.
- Test, in `transformers.test.ts` (~162-292):
  - Count and byte refusals.
  - Release on abort and dispatch.
  - Queue-wait expiry.
  - The runtime timeout still runs from dispatch.
  - One caller test showing the named error.

## Slice 11. Job callbacks abort image work (_small_, `plugins-mcp.md`)

Depends: 7. Per-Chat Send slice 7 (`c9e6cde40`) changed `jobChannel.ts`: re-read it first.

- `jobChannel.ts`:
  - Each `Outstanding` (~108-128, created ~982-984) gets an `AbortController` that
    `cancelOutstanding` aborts. This keeps the controller the plugin provider callback
    already wires (~782-818) and keeps `stillWanted` for the protocol's refusal semantics.
  - The Lua `generateImage` callback (~658-681) and `imggen` (~756-771) pass `entry.signal`
    to `generateAIImage` / `stableDiff`.
  - `imggen` gains the after-generation `stillWanted()` check.
- Test, in `jobChannel.test.ts` (~1128-1170): a cancel during a pending image request aborts
  that request's signal, and the late result is neither sent nor delivered.

## Slice 12. Durable writes for assets, snapshots, push, and diagnostics (_hard_, `self-host-server.md`)

Depends: 10 (same guide).

- Add a server helper (for example `server/src/data/durableWrite.ts`):
  - Write a unique temp file, `FileHandle.sync()`, close, rename, then sync the directory.
  - Also a `syncDir(dir)` for batch publication.
- Use it in:
  - Assets: `storage.ts` (~181-202, ~403-425; the batch ~428-485 syncs each staged file
    and makes one directory sync per batch, Q5).
  - `contentAsset.ts` ~44-73.
  - Snapshots: `snapshots.ts` ~114-130 (sync the backup file before its rename).
  - `pushService.ts` `writeJsonAtomic` and `journal.ts` `writeAtomic`.
- Backup import hard links (`routes/backups.ts` ~390-425) get one directory sync at the
  end.
- On a filesystem that refuses a directory `fsync` (some network or Windows mounts), the
  helper ignores `EINVAL`/`EPERM` and still renames.
- `self-host-server.md`: replace the ~594 hazard with the durability rule and its cost.
- Test:
  - A helper unit test (fake `FileHandle.sync` and directory sync called in order;
    `EINVAL` tolerated).
  - `assets.test.ts` and `snapshots.test.ts` still pass.
  - Measure the 2,000-record slow case (`assets.test.ts` ~258-270) before and after, and
    record the numbers in the commit message.

## Slice 13. Auth files are durable, damage-safe, and rate limited (_small_, `self-host-server.md`)

Depends: 12. Q6 decided: (a), with the rate limits added (2026-10-23).

- `routes/auth.ts`:
  - Login (~149-152) and `set_password` (~174-180) write through the durable helper, into a
    copied key array before the in-memory one changes.
  - At start (~25-42), validate that `known_public_key_hashes.json` is an array of strings.
    A malformed file is renamed to `known_public_key_hashes.json.corrupt-<time>`, the
    server starts with no known keys (every tab logs in again with the password), and a
    warning is logged; it no longer exits 1.
  - An existing but empty `password` file is treated as corrupt (log, keep the server locked
    as "password required"), not as unset. Only a missing file opens `/api/set_password`.
- Q6: an optional `RISU_PASSWORD_SHA256` writes the `password` file at start when none
  exists, for unattended Docker setups.
  - It holds the same client digest the file holds: the SHA-256 hex of the UTF-8 password,
    as `/api/crypto` computes it (`printf '%s' '<password>' | sha256sum`).
  - It never overwrites an existing file. A value that is not 64 hex characters stops the
    start with a clear message.
  - Parse it in `server/src/listenConfig.ts` beside the other variables (~5-31).
- Rate limits (`registerRoutes`, wired at `server/src/app.ts` ~753 with `createRateLimiter`
  ~467-478):
  - `/api/set_password` takes the login limiter (10 per 30 s per IP).
  - `/api/crypto` takes the auth limiter (`requestsPerMinute`, 2000 by default). It only
    hashes, so it is a CPU bound, not a guessing oracle. Every login also calls it, so the
    login limiter would halve the login budget.
  - The client's `set_password` call (`src/ts/storage/serverAuth.ts` ~119-130) checks the
    status and shows the server's message, as `digestPassword` (~172-191) already does,
    instead of going on to a login that fails with "Password not set".
- `self-host-server.md`: rewrite ~595 and ~599 (no auth and no rate limit on the two
  routes), and document the variable.
- Test, in `app.test.ts` (~95-130, ~647-685):
  - A corrupt key file starts and is renamed aside.
  - An empty password file does not open `set_password`.
  - The environment seed writes the file once and never overwrites it; a malformed value
    refuses to start.
  - The 11th `set_password` within 30 s from one IP answers 429; `/api/crypto` answers 429
    past its limit (a small `routeLimits` in the test server).
  - A `serverAuth` test: a refused `set_password` shows its message and does not log in.

## Slice 14. Queued callbacks fail together when nobody is attached (_small_, `self-host-server.md`)

Depends: 13 (same guide). Per-Chat Send slice 7 (`c9e6cde40`) changed
`server/src/jobs/channel.ts`: a cancelled callback now holds the lane until the tab reports it
drained or `CANCELLED_CALLBACK_DRAIN_MS` passes. Re-read it first.

- When a dispatched root expires `disconnected` because no owner is attached (~314-361),
  settle every queued root of that client as `disconnected` at once (Q7). Today they
  dispatch one at a time and each waits its own 60/120 s.
- A later attach starts with an empty queue.
- Attached lanes keep Per-Chat Send D2: no queue-wait bound beyond job life, the caller's
  signal, and the cap.
- `self-host-server.md` (lane description) and the channel comment (~250-259).
- Test, in `server/src/tests/jobChannel.test.ts` (~355-396):
  - With no owner, three queued roots behind a dispatched one all end `disconnected` when
    it expires.
  - With an owner attached, queued roots still wait (the existing assertions).

## Decisions

The runner takes each default unless the user overrides it. Q1 and Q6 change a documented
contract: both were decided by the owner on 2026-10-23.

- Q1. Unload warning for refused data (slice 3). Options:
  - (a) Warn while any refused record or chat holds local content that differs from the
    server.
  - (b) Keep today's rule (no warning) and rely on the banner (slice 4).

  Decided (a) by the owner on 2026-10-23, the audit's recommendation. The warning ends when the
  user exports and discards, or the edit is accepted.

- Q2. ComfyUI history endpoint (slice 7). Options:
  - (a) `/history/{prompt_id}` only.
  - (b) The scoped path, falling back to `/history` once per run on 404/405, for older
    ComfyUI-compatible servers.

  Default (b).

- Q3. Export worker heap (slice 9). Options:
  - (a) Reuse the import's heap variable and default (`RISU_UPSTREAM_IMPORT_HEAP_MB`).
  - (b) A separate `RISU_UPSTREAM_EXPORT_HEAP_MB` with the same default.

  Default (b): the two run at the same time.

- Q4. Local model queue limits (slice 10).
  - Defaults: 64 queued tasks, 256 MiB of queued payload, and a 5 min queue wait, as
    exported constants with environment overrides.
  - Child memory limits (Node's `--max-old-space-size` does not bound ONNX native memory)
    and quantized generation weights stay with the deployment docs, not code.
- Q5. Directory sync granularity for asset batches (slice 12). Options:
  - (a) Sync each file, plus one directory sync per batch.
  - (b) Sync the file and the directory per asset.

  Default (a). An acknowledged batch is durable as a whole, and the cost is one directory
  sync per request.

- Q6. Initial password and damaged auth files (slice 13). Options:
  - (a) Add `RISU_PASSWORD_SHA256`, and keep first-caller `set_password` when it is unset.
  - (b) Also refuse `set_password` from non-loopback addresses unless
    `RISU_ALLOW_REMOTE_SETUP=1`.
  - (c) Docs only.

  Every option also includes slice 13's handling of damaged files:
  - A malformed key file is renamed aside, so every tab logs in again.
  - An empty `password` file locks the server until the operator fixes it, where today it
    reopens `set_password`.

  Decided (a) by the owner on 2026-10-23, with rate limits on `/api/set_password` and
  `/api/crypto` added to slice 13. (b) would break the documented Docker first-run flow on a
  LAN address.

- Q7. Queued roots without an owner (slice 14). Options:
  - (a) Fail them all when one expires `disconnected`.
  - (b) Also add a general queue-wait bound (Per-Chat Send D2 option (b)).

  Default (a): it keeps Per-Chat Send's D2 decision.

## Not In This Plan

- F1 (page-lifetime media object URLs, an unbounded `risuCache`): the Direct Asset URLs
  plan owns it (`direct-asset-urls.md`, slices 4–6). Its fallback leftovers
  (no service worker) are listed there.
- The legacy browser import's check-then-delete race (`browserLocalImport.ts` ~93-100): no
  current code writes those LocalForage stores. Only a tab still running a pre-migration build
  could, and a Web Lock would not coordinate with it. It stays as a documented hazard.
- Excluding `togglePresets` from the job scope and render cache key (`jobScope.ts` ~116-126):
  no server prompt path reads it. Removing it changes what Lua and plugin snapshots of the
  database contain, so it needs its own check of `getFullDatabase` consumers. Raise it with
  the archived toggle-preset follow-ups.
- Provider-side cancellation of billable image or TTS work: aborting the client fetch does
  not stop a remote job. Only providers with a cancel API could, and none is wired.
- SQLite's own `synchronous` setting for `resources.sqlite`: out of scope for the
  file-publication helper.

## Open Questions

- Should slice 4's record banner also appear on the settings page that owns the refused record
  (a module, a preset), or is one app-level banner enough? The default is one banner plus the
  chat status.
