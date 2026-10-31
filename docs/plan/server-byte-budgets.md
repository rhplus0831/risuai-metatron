# Server Byte Budgets Plan

Status: drafted 2026-10-31, revised the same day after an Astra review (see **Review record**);
landed: 0 (`261f6fb26`), 1 (`d8aac27d0`), 3 (`052df1066`), 2 (`be53ea533`),
6 (`af42c1fc4`). The user answered Q1–Q3 on 2026-10-31 (see **Answered questions**).

Sources: findings F06, F07 and F17 of the
[server/client stabilization audit](../research/deep-audit/server-client-stabilization.md) (at
`c1a1d5d6c`) and SD04, SD05 and SD06 of the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md) (at
`ff7cb9d20`), which the archived Deep Audit Fixes plan deferred here as one group
(`git show ca5b656fa:docs/plan/deep-audit-fixes.md`, **Deferred**: "Worker database or paged reads;
keep transaction and epoch guarantees"). Code anchors were checked at `ac823f673`; verify them
again before editing (STRUCTURE.md protocol step 5).

Owning guides: [self-host server](../structure/self-host-server.md) (body caps, the resource
routes, restore and import, chat checkpoints, the normalization pass, durable writes),
[diagnostics](../structure/diagnostics.md) (the journal and `state.json`),
[persistence](../structure/persistence.md) (the read client, summary lists),
[backup-sync-hub](../structure/backup-sync-hub.md) (the restore flow as the user sees it). Each
slice updates the guide whose contract it changes; Slice 8 only closes.

## Goal

A request costs the serving thread what it names, and nothing before it is admitted:

- An unauthenticated request buffers no body. Today Hono's limiter reads a chunked body up to
  100 MiB before the route's `checkAuth` runs: 3,145,728 bytes pulled before a `No auth header`
  400 on `POST /api/resources/read` (F17).
- A read answers at most a soft budget of stored bytes, deduplicated, and a client that can
  continue gets the rest in later calls. Today five references to one 10 MB chat are 52 MB of JSON
  and 114 MiB of heap (F07), and a summary list parses every chat's whole metadata to keep
  fourteen fields.
- A restore or import validates its database off the serving thread and installs it by copying
  rows inside SQLite, not by parsing them in JavaScript. Today both run on the serving thread, 197 ms
  and 130 ms for one 10 MB chat, and the upstream commit validates a file its own worker already
  validated (F06).
- A checkpoint costs what changed: no whole-chat parse to learn whether one is due, no per-row
  `JSON.parse` to save, no table-wide sweep to prune (SD04).
- A restart whose normalizing code and kinds did not change skips the normalization pass (760 ms
  measured for 300 characters and 3,000 chats, writing nothing) (SD05).
- Journal, state, push and auth files are written off the serving thread, in order, and the two
  that owe a durable acknowledgment (push subscriptions, auth files) still wait for it (SD06).

Not goals: a message window for ordinary chat reads (the client holds whole chats; see **Later**),
a database worker for ordinary queries, a bound on response memory in flight (D3 is deferred to
**Later** with the reason), streamed progress for restore and import, a change to the resource
store's durability by default (Q1), the thumbnail cache's byte cap (its own Known Hazards issue),
and the 16 GiB import cap.

## Current state

- **The body limiter buffers before auth.** `server/src/app.ts:666–696` runs
  `limitedBody(MAX_BODY_BYTES)` (100 MiB, `routes/limitedBody.ts`) as an `app.use` for every route
  not in its skip list; `hono/body-limit` 4.13.14 trusts a `Content-Length` without reading, but a
  body without one (or with `transfer-encoding`) is read into a chunk array up to the cap before
  `next()` (`node_modules/hono/dist/middleware/body-limit/index.js:36–65`), then handed on as a
  rebuilt stream. Hono's `compose` (`node_modules/hono/dist/compose.js:35–44`) assigns a
  middleware's return value to the context only while the context is not finalized, so a value
  returned after `await next()` is dropped once a handler answered; a middleware that wants to
  replace the answer sets `c.res`. The routes with their own caps already follow `limiter,
authenticated, limitedBody(cap), handler` (checkpoints 16 KiB, tokens 2 MiB, search 4 KiB,
  transform 8 MiB, …) and are skipped by the global limiter; `POST /api/resources/read`,
  `POST /api/resources/batch`, `POST /api/write` and `POST /api/assets/write` authenticate inside
  their handlers (`routes/resources.ts:139`, `:233`; `routes/storage.ts:700`, `:742`) after the
  global limiter ran. Not every handler catches a failed body read: `storage.ts:715` awaits
  `arrayBuffer()` directly, the asset batch rethrows a reader failure (`:848–851`), the proxies
  rethrow or answer 502 (`routes/proxy.ts:346`, `:203–211`). The asset batch publishes each
  completed record by rename while the upload is still being read (`storage.ts:797`; earlier
  publications survive a later failure by design, `:732–741`). The snapshot restore never reads its
  request body (`routes/backups.ts:89`). `login`, `crypto` and `set_password` read their bodies
  before any authentication by design (`routes/auth.ts:187`, `:208`, `:220`) and sit under the
  global cap. `checkAuth` (`routes/auth.ts:99–150`) parses a JWT, hashes its public key, checks the
  known hashes and verifies ES256; it touches no database. Tests of the current behavior:
  `limitedBody.test.ts`, `app.test.ts` "answers 400 for a failed upload without Content-Length",
  `assets.test.ts:297` (a large declared length with a one-byte body: 413 and no staging; it has no
  heap assertion), and the per-route "authenticates before reading the body" cases listed under
  **Verification**.
- **A read is bounded by count, not bytes.** `routes/resources.ts:138–196` accepts 1 to
  `MAX_BATCH_OPERATIONS` (5,000) entries across `refs`, `chats`, `chatCollections` and
  `chatSummaryCollections`, with no deduplication and no response budget; an id may be 512 UTF-16
  units of any text (`resourceStore.ts:362`) and a chat entry names two, so the largest valid
  request body is over 15 MiB. `readRefs` (`data/resourceStore.ts:1548`) reads every entry
  synchronously in one pass, a collection expanding to its order and every chat whole; `readChat`
  (`data/chatStore.ts:2189`) parses every message row. `compressedJson` (`http/compressedJson.ts:64`)
  stringifies the whole body synchronously, then compresses the Buffer on the zlib pool; nothing
  bounds how many such bodies are in flight. Measured by the audit (one 5,000-message chat of 2 KiB
  rows): one reference 33.5 ms read, 36.2 ms stringify, 10,454,174 bytes; five references 289.8 ms,
  167.3 ms, 52,270,510 bytes, 113.7 MiB of heap. A chat has no lifetime size ceiling: the 100 MiB
  cap is per request, and append groups keep growing the same chat (`chatStore.ts:1497`).
- **Summaries parse the whole metadata.** `readSummaries` (`chatStore.ts:2147`) and
  `readCollectionSummaries` select `meta` whole and `chatSummary` (`:967`) parses it to keep the
  projection (`summaryFields`, `:328`: `name`, `fmIndex`, `folderId`, `bindedPersona`, the preset
  ids, `bindingReview`, `pinned`, six translation fields) plus `lastMessageAt` from a memo
  (`:951`, one `LIMIT 1` row read on a miss; never read or filled inside a transaction; message ops
  invalidate it at `:1392–1396`; restore clears it at `:2222`). The feed's `summary`/`summaryBase`
  decision compares the projection before and after a write together with the last row's time
  (`:1752–1773`), excluding `revision`. Product SQL that writes a chat's `meta` is confined to
  `chatStore.ts`: create (`:1400`), replace (`:1439`), metadata groups (`:1491`), restored inserts
  (`:2229`); the checkpoint load uses the replacement path and the upstream staged writes use
  `applyChanges`. Measured for 3,000 chats: 120 ms first, 73 ms median (persistence guide, Gotchas);
  a warm boot avoids it through the cached collections, a cold boot and every
  `chatSummaryCollections` read pay it.
- **The client reads in fixed chunks under one deadline per call and treats an absent collection
  as deleted.** The one transport is `readRefs` in `src/ts/storage/resourceClient.ts:207`, with
  no deadline of its own; its callers wrap the whole call in one timer: `deadlineRead`
  (`resourceSync.svelte.ts:1465`, 20 s), `deadlineChatRead` (`chatStore.svelte.ts:6495`, 60 s),
  `readWithDeadline` (`chatEdits.ts:112`, `characterOrder.ts:224`; `readDeadline.ts:15`). Callers:
  the refresh queue (up to 1,000 records, 1,000 chats, 1,000 collections per idle refresh; it asks
  for a character record **together with** its collection and combines them, `:4956`, `:5016`; new
  characters are adopted with their collection, `:4892`; recovery couples a record and its summary
  order, `:4173`), `loadChats` (500 chats per request, three rounds), `chatEdits.readChatsDetached`
  (collections in chunks of 500, a missing collection filled with `[]`), the character-order repair
  (1,000 refs a read). The boot fallback is `readKinds`, not `readRefs` (`bootstrap.ts:75`). A chat
  entry missing from an answer is retried or left pending; a collection present but short is
  applied as the server's truth (`applyRemoteCollection` treats ids absent from it as absent from
  the server). No answer field says an entry was left out, so the server cannot truncate today. The
  transport's epoch check goes through `epochMismatch` (`resourceClient.ts:87`), which also invokes
  the halt-and-reload listener; its error type is `ResourceRequestError` (`:43`). Test servers:
  `src/ts/storage/tests/fakeResourceServer.ts:218` serves plain refs only; `storeBackedServer.ts:538`
  serves the read route from a real store (its `ServerStore` subset is declared at `:64`).
- **Restore validates and installs in JavaScript, on the serving thread.** `readSnapshotFile`
  (`resourceStore.ts:374–480`) opens the file read-only, runs `integrity_check`, the layout check
  (`assertSnapshotLayout`, `:2326`: the required tables `resources`, `meta` and the chat tables of
  `CHAT_TABLE_COLUMNS` must have exactly their columns; other tables are ignored), `.all()`s every
  resource row, parses and normalizes each (`serialize(normalizeInput(...))`), then
  `readChatSnapshotRows` (`chatStore.ts:2336`: compacts message positions to `0..n-1`, keeps id and
  position sets) and the checkpoint rows (`checkpointStore.ts:621`: every page's text retained in
  memory, refs validated against expectations), returning the whole database as
  `ValidatedSnapshot` text. `replaceAll` (`:2013–2052`) runs `BEGIN IMMEDIATE`, deletes and
  re-inserts every resource row with its stored numeric revision in source order
  (`insertRestored`), lets `chatTables.replaceAll` insert chats with fresh `seq`s (`chatStore.ts:2221`)
  and clear the chat group receipts (`:94`: incarnation-local), lets the checkpoint tables install
  pages byte-for-byte (`checkpointStore.ts:565`; `snapshots.test.ts:277` supplies a whitespace-bearing
  page), leaves the restore floors alone as epoch-local (`checkpointStore.ts:73`: "outside the
  snapshot's four-table checkpoint group"), runs `normalizeStoredRecords()` again (to materialize
  singletons the snapshot predates), sets the epoch, commits, clears the memos and publishes
  `epoch`. `backupTo` (`:1987`) copies the whole database file, so a snapshot carries every table,
  the auxiliary ones included. `ATTACH` is accepted inside a transaction by `node:sqlite` (probed
  in memory during the review). Three callers: the snapshot restore resolves its file by pathname
  under the snapshot queue (`snapshots.ts:105`; retention unlinks older files at `:129–130`) and
  validates inside maintenance (`routes/backups.ts:102–109`), the version-2 import validates before
  it (`:352–355`) and installs inside through `restoreValidated` (`:401–468`: safety snapshot, asset
  links, a last epoch check, `replaceAll`), and the upstream commit checks the accepted write count
  before maintenance (`routes/backupsUpstream.ts:394`) and validates inside it (`:411–414`) a staged
  file its prepare worker already wrote and validated (`data/upstream/importStage.ts:139–177`:
  `createResourceStore` on `build.sqlite`, `put` and `applyChanges` (which allocate revisions and
  seqs), `backupTo`, `readSnapshot`). The worker pattern exists twice: `importRunner.ts:53–129` and
  `exportRunner.ts:39–117` spawn one `Worker` per call with paths in `workerData`, `resourceLimits`
  from `RISU_UPSTREAM_IMPORT_HEAP_MB` / `RISU_UPSTREAM_EXPORT_HEAP_MB` (a V8 heap cap that excludes
  Buffers and SQLite memory, `importRunner.ts:6`), `held`/`progress`/`done`/`error` messages, and
  `terminate()` on abort; the route tests inject an in-process runner (`upstreamImportRoute.test.ts:45`)
  and the real-worker tests are `slow` (`upstreamImportWorker.test.ts:13`). `createServerContext`
  accepts a custom `resourceKinds` registry with arbitrary normalizer functions (`app.ts:156`,
  `kinds.ts:50`). Maintenance (`data/snapshots.ts:240–265`) keeps reads open and drains admitted
  mutations; `backups.test.ts:307–418` asserts that.
- **A checkpoint rereads the chat.** `autoSave` (`data/checkpointService.ts:99–117`) reads the
  chat whole (`readChatSource`) and counts `role === "user"` before it knows whether a checkpoint is
  due; `save` (`data/checkpointStore.ts:278–345`) parses the chat's metadata once (`:268`), iterates
  every row, `JSON.parse`s each for the role count and the two-message preview, hashes each page
  (SHA-256 of the row texts, a page ending at an id anchor, 64 rows or 1 MiB) and inserts a
  reference per hash; `prune` (`:359–371`) and `delete` (`:398–406`) delete then `sweep()`
  (`:178–181`, `:238`): `DELETE FROM checkpointPages WHERE NOT EXISTS (ref)` over the whole table.
  Measured: 87.2 ms to save the 5,000-message chat, 71.5 ms to save it again unchanged. The capture
  runs synchronously in `finalize` (`jobs/generationJobs.ts:1048–1165`, a throw only logged).
  `checkpointService` holds a `ResourceStore`, not a connection (`:61`). The store already has
  `COUNT(*)` per chat (`chatStore.ts:905`) and `ChatWriteChange` (`:1180–1207`); nothing counts user
  turns without parsing. Stored messages are JSON objects with a `user`/`char` role and string data
  (`chats.ts:142`; snapshot validation refuses others).
- **Every open normalizes every record.** `normalizeStoredRecords` (`resourceStore.ts:565–608`)
  runs at `createResourceStore` inside `BEGIN IMMEDIATE` (`:609–619`), before the chat tables are
  created (`:909`) and before the server listens: for every kind, every row is parsed, normalized
  and serialized, and rewritten only when the text or the schema version differs; a missing
  `materialize` singleton is inserted when the kind has no rows (`:597`). There is no record of
  which code last normalized the store; the kinds' `schemaVersion`s are all 1 and the database
  `user_version` is 3 (`:64–68`; 1 and 2 refused). The normalizers live in `server/src/data/normalize/`
  and in `shared/` (`characters.ts`, `modules.ts`, `presets.ts`, `togglePresets.ts`, …), with
  defaults and owned-field filtering (`normalize/shared.ts:47`). `normalizeInput` (`:2352`)
  serializes the **input** before the normalizer (so a non-finite number is refused before a JSON
  clone turns it into `null`, `:2346`) and the callers serialize the normalizer's **output**
  (`:1135`, `:1588`): two different texts, both needed. `readServerBuildInfo` (`server/src/buildInfo.ts:53`)
  reads `dist/build-info.json` on every call, the build of the **served client**; a checkout runs
  the server from TypeScript without a build (server guide `:23`), so that file can name a commit
  whose server code is not the code running; `resolveBuildInfo` (`:23`) resolves the checkout's
  own `HEAD` and `dirty` (a boolean field of `BuildInfo`, `shared/buildInfo.ts:7`). The resource
  store opens with `journal_mode = WAL; synchronous = FULL` (`:2445`); receipts, request history and
  the vector cache use `NORMAL`.
- **Auxiliary writes are synchronous, and their state transitions are too.** `writeFileDurableSync`
  (`data/durableWrite.ts:89–112`: exclusive temp, `writeFileSync`, `fsyncSync`, `renameSync`,
  directory sync with `EINVAL`/`EPERM` tolerated) is called by `routes/auth.ts:86`, `:201` (a login
  computes the next key list from the current one, writes it, then installs it), `:236`
  (`set_password` checks `password.state`, writes, marks it set, with no await between) and by
  `push/pushService.ts:178` (`writeJsonAtomic`, mode 0600: VAPID keys at `:245`, every subscription
  commit at `:404`; `register` derives `next` from the current list at `:536–538` and `commit`
  installs it only after the write succeeded; delivery bookkeeping and removals share that list;
  the route's success is 204, `routes/push.ts:57`). The diagnostics journal appends each accepted
  event synchronously with its own hardened open (`journal.ts:280`, `:331–399`: a child-directory
  check, `O_RDWR | O_APPEND | O_CREAT | NOFOLLOW | NONBLOCK`, `fstat`, mode 0640, a newline repair,
  complete writes, truncation back on a partial write; the diagnostics guide lists these as
  invariants, `:222`), prunes day files past the cap (`:407`), and publishes `state.json`, reports
  and shares with a synchronous flushed temp file and rename (`writeAtomic`, `:500–540`) at boot,
  every ten minutes, five seconds after the first error, on fatal faults
  (`main.ts:47`: `record` then `writeState` inside `uncaughtExceptionMonitor`; `diagnosticsCrash.test.ts:88`
  requires the fault event in the day file), and at dispose (`app.ts:999–1031`, an awaited chain).
  `eventsFor` (`:828`) reads disk plus the last 300 ring entries for a share. The shared state and
  report types carry `eventBytes` and `writeFailures` only (`shared/diagnostics.ts:760`,
  `diagnosticsReport.ts:216`). The request history is SQLite (`NORMAL`), not in this inventory. No
  ordered file writer exists; `snapshots.ts` queues snapshot and maintenance operations only. The
  audit's estimate: a 100 ms fsync on a slow volume costs about 200 ms of event-loop time per
  state write; the receipt-store measurement in the server guide's Gotchas shows the same shape
  (115 ms p95 event-loop delay on a 9p mount).
- **Compatibility.** The server serves the client, so a tab is never newer than its server, but an
  open or cached (PWA) tab can be older for as long as it stays open. Additive request and answer
  fields are safe; a server that answers less than it was asked is safe only to a client that said
  it can continue, and a smaller request cap is safe only to a client that chunks to it.

## Decisions

- **D1. The limiter counts; it does not buffer.** `limitedBody` keeps its signature and answers and
  stops delegating to `hono/body-limit`: a declared `Content-Length` over the cap is still an
  immediate 413 (nothing read); otherwise the middleware replaces `c.req.raw` with a request whose
  body is a demand-driven counting stream over the original (a pull-based `ReadableStream` that
  reads the source only when the consumer reads, never a `pipeThrough` with its own prefetch) and
  calls `next()` at once. The wrapper records two facts for the middleware: `overflowed` (the
  first byte over the cap, at which it errors the consumer's stream and cancels the source) and
  `sourceFailed` (the source errored under the cap). After `await next()`, the middleware sets
  `c.res` explicitly (a value returned here is dropped by Hono's `compose` once the handler
  finalized): 413 `{ error: "Request body too large" }` when `overflowed`, the configured 400 when
  `sourceFailed`, whatever the handler answered or threw meanwhile (a handler that rethrows a
  failed read, such as `/api/write` or the proxies, is covered by the same rule; the catch keeps
  the earlier `downstream` distinction for errors unrelated to the body). A handler failure with
  neither flag set keeps its own answer. Precedence: `overflowed` wins over `sourceFailed`. The
  route-level caps go through the same helper, so the "actual bytes under a wrong declared length"
  cases (`diagnostics.test.ts:1588`, `messageSearch.test.ts:688`) keep their answers.
  - **Behavior changes, accepted and documented.** An over-cap chunked asset batch may have
    published its earlier records before the 413, exactly as a batch whose upload fails midway
    does today (earlier publications survive by design); the route keeps its drain-on-failure
    behavior with the wrapper (the wrapper's cancel of the source is deferred for a route that
    drains, which the route requests through the existing failure path). A route that never reads
    its body (the snapshot restore) no longer refuses an over-cap one: the body is discarded by
    the adapter and the operation runs; these routes are authenticated. An overflow discovered
    after a route exposed a streamed response (SSE, proxies) cannot become a 413; every such route
    reads its request body before answering today (`llm.ts:249`; the proxies and imports finish
    reading input first), and the slice keeps that ordering explicit in each route's test.
  - **Routes that read before authentication.** `login`, `crypto` and `set_password` are
    unauthenticated by design and keep reading their bodies first; they leave the global list and
    get a 16 KiB cap in the `limiter, limitedBody, handler` pattern. The other routes authenticate
    before their first body read (**Current state**), so with a demand-driven body nothing is read
    before `checkAuth`.
  - **The read route's own cap.** `POST /api/resources/read` gets a 32 MiB cap after
    authentication and leaves the global list. The cap is computed from the largest valid request
    (5,000 entries × two ids × 512 units × 3 UTF-8 bytes, about 15.4 million bytes or 14.7 MiB, plus
    framing), not from
    typical ids, so no valid older-tab request is refused. `batch` and `/api/write` keep 100 MiB.
- **D2. A read is deduplicated, budgeted by character group, and complete or explicitly unfinished.**
  - **Deduplication.** The route deduplicates `refs` by kind and id, `chats` by character and id,
    and the two collection lists by character before `readRefs`; the answer lists each entry once.
    No caller depends on positional pairing (each answer entry carries its identity).
  - **Groups.** The unit the budget may leave out is a **group**. A **character group** is a
    character record ref together with its `chatCollections` and `chatSummaryCollections`
    entries; every `chats` entry is a group of one, as is every other ref (presets, modules,
    settings, …). The refresh queue asks for a character together with its collection and
    installs them together; keeping the two in one round keeps that pairing coherent without a
    transaction across rounds (Astra F4). A chat needs no such pairing: the chat loader asks for
    500 chats of one character in one call and already retries or leaves pending a chat missing
    from an answer, so the budget may split a load into rounds (Slice 0 measured 7 rounds at
    16 MiB for a 500-chat load of 200 KiB chats, against one round of 106 MB if the chats were in
    the character group). A deletion and recreation of a character between two rounds still
    cannot split a group.
  - **Budget.** `MAX_READ_RESPONSE_BYTES` (Q2: 16 MiB, `shared/resources.ts`) bounds the
    **charged stored bytes** of one answer. Groups are served in request order (refs, chats,
    collections, summary collections, each group placed at its first mention); the first group
    that would pass the budget, and every group after it, is left out and named in a new answer
    field `unanswered: { refs, chats, chatCollections, chatSummaryCollections }` (the request's
    shapes). The first group of an answer is always served, however large (a chat or a
    collection must stay readable; neither has a size ceiling, since append groups grow a chat
    without bound). This is a soft budget: an oversized group is served whole, and the plan says
    so in the guide.
  - **The charge, per entry, from SQL before anything is parsed.** A resource: `octet_length(data)`.
    A chat: `octet_length(meta)` plus `SUM(octet_length(data))` of its messages, two queries
    (never a join that multiplies the metadata per message). A collection: the order text plus the
    sum of its chats' charges, from one aggregate over `chats` and one over `messages` grouped by
    character. A summary collection: the order text plus `SUM(octet_length(text))` of the
    character's rows in D4's `chatSummaries` table (the stored projection; a cold `lastMessageAt`
    memo's one row read is not charged). The charge is stored bytes, not wire bytes; the guide
    says which. D2 therefore needs D4 (Slice 3) first.
  - **Only for a client that can continue.** The request gains `continue: true`. Without it the
    server answers everything, as today, so an older open tab never sees `unanswered` and its
    "absent means deleted" rule stays sound. With it the server applies the budget.
  - **The client transport loops, under the caller's deadline.** `resourceClient.readRefs` sends
    `continue: true`, merges each answer into one result in request order and re-sends the
    `unanswered` entries until none are left; every round carries the caller's `signal`. The
    caller's existing timer bounds the **whole** call, continuation rounds included (today's
    "each request, not the whole load" line in the persistence guide changes to say so).
    Continuation is a normal path, not a rare one: the chat loader asks for 500 whole chats per
    call (`LOAD_CHUNK`, `chatStore.svelte.ts:566`), so at 16 MiB a call continues once its chats
    average about 33 KiB (sixteen rows of 2 KiB), and the detached export asks for the whole
    collections of up to 500 characters per call (`DETACHED_READ_CHUNK`, `chatEdits.ts:78`;
    `exportAsDataset.ts` passes every selected character), so an export continues often. Only the
    refresh queue's entries are mostly small. The bytes one deadline covers stay about today's;
    what changes is the number of HTTP rounds inside it, which Slice 0 measures (D9) and Slice 2
    tests under one deadline. A round that makes
    no progress (every entry it asked for comes back `unanswered`) throws a `ResourceRequestError`;
    a 412 or a differing `epoch` between rounds goes through `epochMismatch` (halt and reload) and
    discards every accumulated round; an aborted signal stops the loop before the next request. A
    failure never returns a merged partial result. Every caller keeps its contract: a complete
    answer or a thrown error.
  - **What the budget does not do.** It does not split a chat or a collection, bound
    `GET /api/resources` (the whole-kind read behind a boot-cache miss; see **Later**), or bound the
    request's own 5,000-entry count, which stays as the parse-work bound.
- **D3. Deferred: a bytes-in-flight gate.** The first draft reserved the answer's bytes before
  `JSON.stringify`, after `readRefs` had already materialized every row; an answer over the gate's
  cap could never be admitted, and a chat has no ceiling (Astra F6). A sound gate needs admission
  **before** materialization from D2's SQL charges, an oversized lane, and a fail-fast answer that
  does not spend the caller's 20 s deadline waiting; none of that is designed here. Moved to
  **Later**; D2's budget already caps ordinary answers, and `readRefs` plus `stringify` serialize
  on the one serving thread.
- **D4. The summary projection is stored beside the chat, versioned and fenced by revision.**
  - **Table.** `chatSummaries (chatSeq INTEGER PRIMARY KEY REFERENCES chats(seq) ON DELETE CASCADE,
revision INTEGER NOT NULL, text TEXT NOT NULL)`: `text` is `summaryFields(meta)` without
    `lastMessageAt` (the memo stays, with its in-transaction bypass) and without `revision`;
    `revision` is the chat's revision at the last write by a server that maintains the table.
  - **Writes.** One transactional projection writer in `chatStore.ts` is the only code that
    writes `meta`: create, replace, metadata groups, restored inserts route through it and it
    writes both the row and the projection; every other chat write (a message op that leaves
    `meta` alone) updates only the row's `revision` to the chat's new one, one indexed statement.
    `readSummaries`, `readCollectionSummaries` and the feed's summary decision read `text` and
    compare it to the pre-write `text` (the feed's "before" projection; the last-row time stays as
    today), never parsing `meta` for a summary; the field-form delta of a metadata change still
    parses `meta`, as today.
  - **Freshness.** A row is fresh when its `revision` equals the chat's. An older server that
    opens the file ignores the table and bumps chat revisions as it writes, so its edits leave
    rows behind; a reader that finds a stale or missing row rebuilds it from `meta` (one parse)
    and rewrites it outside the read's statement. `meta` also records
    `summaryProjectionVersion`; a mismatch (a changed projection) rebuilds every row at open.
  - **Open.** Table creation and the rebuild of missing, stale and out-of-version rows run in
    their own transaction right after the chat tables are created, before any prepared reader is
    handed out (`createChatTables` runs after the normalization transaction today; the slice
    separates schema setup from the readers so the rebuild can roll back and close the store on
    failure). The rebuild is the only pass that parses metadata for summaries.
  - **Snapshots and restore.** The table is outside the validated layout (`CHAT_TABLE_COLUMNS`
    unchanged; `assertSnapshotLayout` ignores other tables), but `backupTo` copies the file, so
    snapshots **do** carry it; validation ignores it and the restore never trusts the source's
    rows: D5's worker writes fresh projections into its normalized output and the install copies
    them, so no metadata is parsed on the serving thread for summaries after a restore. An older
    server opening a newer file ignores the table.
- **D5. Validation runs in a worker that writes a trusted normalized staging store; the install
  copies rows in SQL.**
  - **The staging function and the worker.** `data/restore/stageValidatedSnapshot.ts` is an
    in-process function `(source, output, kinds, onProgress, signal)` that does today's checks
    (`integrity_check`, `user_version`, the layout, every resource row's normalizer, chats,
    messages, orders, checkpoints) and writes checked rows through a **raw validated-row writer**
    into a fresh store at `output` with the live schema: numeric revisions preserved as stored,
    rows in source order, message positions compacted to `0..n-1`, generation fences as stored,
    checkpoint page text byte-for-byte with refs rebuilt from the validated manifests, D4's
    projections computed per chat, `chatGroups` and `chatRestoreFloors` left empty (receipts are
    incarnation-local, floors are epoch-local, as today's restore leaves them), no singleton
    materialized (the install does that once), and no `put`/`applyChanges` (they allocate
    revisions and seqs). Uniqueness and relationships are enforced by the staging schema's
    constraints as rows are written; checkpoint pages are inserted as they are read and never
    retained, and the id sets kept for cross-row checks hold ids only. The remaining memory is
    the largest single row or page plus those id sets, and SQLite's own; the heap knob
    `RISU_RESTORE_HEAP_MB` (default 2048) bounds the V8 heap as the import knob does, not Buffers
    or SQLite. `validateRunner.ts` and `validateWorker.ts` follow the import and export runners
    (one `Worker` per call, paths in `workerData`, `held`/`progress`/`done`/`error`, `terminate()`
    on abort, OOM and early exit mapped as the import runner maps them) and run the staging
    function on `DEFAULT_RESOURCE_KINDS`; a context created with a custom `resourceKinds`
    registry (tests) runs the staging function in process through the injectable runner, the
    same seam `upstreamImportRoute.test.ts` uses. After closing the output the worker reports its
    size, mtime, inode and SHA-256 (hashed in the worker).
  - **Trust.** The output is an exclusive file this process created under its staging directory,
    closed before it is reported, and owned by the route until the install. Before `ATTACH` the
    serving thread re-stats it (regular file, same size, mtime and inode) and re-hashes it in
    bounded chunks that yield between them (1 MiB per step; `createHash` runs on the JS thread,
    so this is bounded work, not "off the thread"), compares, then checks the header inside it
    (`user_version`, the layout). No second `integrity_check`: the file is this build's own
    output. A mismatch is a 400 and the staging is removed.
  - **The install.** `replaceAll(stagedFile, report)` replaces today's `ValidatedSnapshot`
    parameter: `ATTACH` (before `BEGIN` by choice, not necessity), `BEGIN IMMEDIATE`, with
    `foreign_keys = ON`: delete `resources`, `chatOrders` and `chats` (the chat cascade clears
    messages, groups, floors, summaries and checkpoints), then `INSERT … SELECT` from the staged
    tables in dependency order: resources, chats (fresh live `seq`s through a staging-to-live
    mapping table, so the live `AUTOINCREMENT` high-water mark keeps moving and a later delete and
    recreate cannot reuse an incarnation within the new epoch; `sqlite_sequence` is never copied),
    messages, orders, checkpoint pages, checkpoints, refs, policies, summaries; `chatGroups` and
    `chatRestoreFloors` stay empty; materialize missing singletons (D6's separable step); set the
    epoch and D6's stamp; `COMMIT`. `DETACH` runs after the commit outside the transaction, and a
    `DETACH` failure is logged, never allowed to leave the in-memory epoch old or suppress the
    `epoch` event. Every guarantee the current tests assert holds: one transaction, a rollback
    leaves rows, epoch, write count, caches and the feed as they were, old tokens are stale, one
    `epoch` event after the commit.
  - **The three callers.** The snapshot restore, under the snapshot queue and before mutation
    maintenance, pins its source: a hard link (or copy) of the selected snapshot file into a
    private staging path, so retention cannot unlink it; validation then runs outside maintenance
    with request order preserved and **one restore worker at a time** (a slot like the import's;
    a second restore waits in the queue as today's does); under maintenance the epoch is checked
    again, the safety snapshot taken, and the install runs. The version-2 import validates where
    it does now, outside maintenance, through the runner. The upstream commit stops validating
    rows: its prepare worker's `writeStagedStore` is replaced by the same raw writer and reports
    the hash; the commit takes the token (so it cannot expire), verifies the file, then rechecks
    the epoch **and** the accepted write count immediately before maintenance admission (the hash
    pass is a new window; a changed count answers the existing 409 and hands the token back). All
    three still take the safety snapshot under maintenance before touching anything, and a
    worker's lifetime is tracked through shutdown (terminate, then clean the staging).
  - **What stays on the serving thread.** The SQL row copy (a C loop; D9 measures it), the safety
    snapshot's `backupTo`, the asset links, the bounded re-hash. Reads stay open through
    maintenance as today; the remaining stall is the copy, recorded in Known Hazards with its
    measurement.
- **D6. The open skips the pass when the code that last ran it is this code.** The `meta` table
  gains `normalizationStamp`, written in the same transaction as the pass or the install (a
  rollback leaves the old one). The stamp is the join of: a **normalization identity** (the
  checkout's own `resolveBuildInfo`: `HEAD` and a clean tree, never `readServerBuildInfo`, which
  names the served client's build and can differ from the server code running; without git, the
  `dist/build-info.json` commit, which in a built image is the server's commit too), a hand-bumped
  `NORMALIZATION_VERSION` constant for a change outside git's view, and every registered kind's
  name and `schemaVersion`. At open, an equal stamp skips the record pass; the retired-kind
  deletion, the singleton materialization (an existence query per kind, separable from the scan
  today: `kind.materialize && rows.length === 0`) and D4's rebuild of missing rows still run. The
  skip is disabled when the identity is unknown or dirty, and for a store created with an
  injected kind registry (tests), unless the test passes an explicit `normalizationIdentity`
  option; a development checkout with uncommitted changes therefore always runs the pass, and a
  changed normalizer in `shared/` or `server/src/data/normalize/` ships as a new commit and runs it
  once. Assumption, documented: normalizers depend on code and the registry only, not on
  configuration or the environment. The first draft's "serialize once" item is withdrawn:
  `normalizeInput` serializes the input for validation and the callers serialize the normalizer's
  output; both texts are needed (Astra F13).
- **D7. Ordered writers for auxiliary files; state transitions serialized as operations;
  durability awaited where it is owed.**
  - **The writer.** `data/orderedWriter.ts` runs **operations** (closures) in FIFO order per
    key, different keys concurrently up to four, with `fs.promises`. It schedules work; it is not
    a filesystem primitive. Each consumer keeps its own hardened file code (the journal's
    `NOFOLLOW` opens, modes, newline repair, complete writes and truncation on a partial write; the
    push and auth files' exclusive temp, 0600/0640 modes, fsync, rename and directory sync with the
    `EINVAL`/`EPERM` tolerance), rewritten over `fs.promises` where it is awaited.
  - **The journal.** Event appends and the day-file pruning share one key, so an append never
    races the unlink of its file; a queue past `MAX_QUEUED_WRITE_BYTES` (8 MiB) drops the append
    and counts it (`dropped`, added to the shared state and report types beside `eventBytes` and
    `writeFailures`, with the report canonicalization updated). The periodic, error-delayed and
    share-triggered `state.json` publications share a second key, and a queued publication not
    yet started is replaced by a newer one (latest state wins; only this best-effort snapshot is
    coalesced). Reports and shares keep their unique-file publication and write → mark → remove
    order, awaited by their routes as today. `eventsFor` awaits a barrier on the append key before
    reading disk and the ring, so a share holds every event accepted before it was asked, and marks
    the result partial when events were dropped in the asked interval. The five-second
    error-state promise now means enqueue plus completion, measured in the slice.
  - **Fatal takeover and dispose.** The fatal monitor must leave the fault event and the state on
    disk before Node exits, so `record` keeps a synchronous append path for the fatal origin and
    `writeState` a synchronous publication; a terminal fence set by the fatal path makes every
    queued or in-flight operation's **rename** step a no-op (data writes and fsyncs are
    asynchronous; the rename that publishes a file runs on the JS thread behind the fence check, so
    an earlier state can never land after the final one). Graceful dispose stops producers, drains
    the queues (bounded by the existing dispose deadline), publishes the final state last, and
    only then closes the state sources; the newly asynchronous auth and push mutations are tracked
    through shutdown like resource handlers.
  - **Push and auth: operations, not file tasks.** Serializing writes does not serialize state:
    two registrations that both derive `next` from the same list and then write in turn lose one
    (Astra F15). Each state object (the subscription list, the known-key list, the password) gets
    an operation queue: one operation reads the current state, derives the next, writes it
    durably, and installs it in memory only after the write succeeded; a route awaits its
    operation and answers 204 (push), 200 (auth) or 500 on a failed write, with the existing
    `diskUncertain` and damaged-password handling kept. `set_password` is a single-winner
    operation (the state check runs inside the operation). Delivery bookkeeping and 404/410
    removals are operations on the same queue, coalesced to one durable write per settled
    delivery batch, awaited by no one. Thumbnail cache writes stay as they are (already
    asynchronous).
- **D8. Checkpoints cost what changed.**
  - **The user-turn count is indexed.** `messages` gets an expression index
    `messages_role ON messages (chatSeq, json_extract(data, '$.role'))` (an index, not a column: the
    validated layout is unchanged, `backupTo` copies it, SQLite maintains it on every row write,
    the install's copies included), created at open when missing, and the chat store exposes
    `countUserTurns(characterId, chatId)` (the checkpoint service holds a `ResourceStore`, not a
    connection) using the exact indexed expression. `autoSave` decides from that count and reads
    no message row on a turn that is not due; `save` takes `userTurns` and `messageCount` from the
    two counts.
  - **A save parses two message rows.** The page walk keeps the row texts and the SHA-256 per
    page and stops parsing message rows: the preview comes from the last two rows by position
    (one `ORDER BY position DESC LIMIT 2`, reversed to oldest first), the role count from the
    index; the chat's metadata is still parsed once for the field pages, as today. The per-row
    cost is the SELECT, `Buffer.byteLength` and the hash.
  - **A prune sweeps what it freed.** `prune` and `delete` collect the hashes referenced by the
    checkpoints they are about to delete (message pages and field pages alike), delete (refs
    cascade), then `DELETE FROM checkpointPages WHERE hash IN (…) AND NOT EXISTS (ref)`, all inside
    the caller's transaction. The table-wide sweep stays for the open and for restore, where it is
    a one-time repair; an unrelated orphan page may now wait for the next open, which the existing
    deletion test already permits.
  - Page-hash reuse across saves is in **Later**: it needs a per-chat dirty set maintained by every
    write path, and D8's remaining per-row cost is a SELECT and a hash, to be measured first (D9).
- **D9. Measurements are part of done, from a pinned baseline.** Slice 0 adds
  `docs/research/deep-audit-with-fable/probes/byte-budgets-probe.mjs` with one case per finding,
  runs it at `ac823f673` and records the baseline in its result file with the commit, fixture and
  counters: pre-auth bytes pulled by an unauthenticated chunked `POST /api/resources/read` (the
  audit's in-process probe, with a counting source stream); bytes, time and heap for one reference
  to the 5,000-message chat, for five **distinct** 10 MB chats (five references to one chat
  deduplicate to one after D2), and for a 3,000-chat summary read; validation and install time for
  a restore of that store, each section timed directly, with an event-loop delay histogram beside
  it (the histogram measures scheduling delay, not the longest synchronous interval); `autoSave`
  and `save` time for the 5,000-message chat; the open time of the 300-character, 3,000-chat store
  with nothing changed; and, for D7, the serving thread's blocked time around a `state.json`
  publication with an injected `fs` whose `fsync` resolves after 100 ms (an asynchronous delay,
  never a blocking stand-in). Each later slice reruns its case and the audit documents get an
  "After" line per finding.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes.
Shared product files decide the order: `chatStore.ts` is edited by 3, 2, 7 and 5 (in that order);
`resourceStore.ts` by 4, 2 and 5; `app.ts` by 1, 5, 6 and 8; `routes/resources.ts` by 1 and 2.
Dependencies: 2 needs 3 (the stored projection is what a summary collection is charged by); 5 needs
3 and 4 (the staging store carries projections and the install uses the separable
materialization and the stamp); 7 needs 3 (serial on `chatStore.ts`).

### Slice 0: probe and the pinned baseline (D9; needs nothing)

Files: new `docs/research/deep-audit-with-fable/probes/byte-budgets-probe.mjs` and its result
file; a "Baseline at `ac823f673`" line in the audit sections F06, F07, F17, SD04, SD05, SD06.

- No product code. Fixtures: the audit's 5,000-message chat of 2,048-character rows, five
  distinct 10 MB chats, the sync-traffic fixture's 300 characters and 3,000 chats
  (`sync-traffic-measure.mjs` has the seeding), an in-process `createServerContext` for the request
  probe. The continuation case models the client's loop against the read route (the probe
  re-sends `unanswered` itself, since the client transport changes only in Slice 2): the rounds,
  bytes per round and total time of a 500-chat load of the fixture's largest character and of a
  detached export of 500 characters, at 16 MiB and at 32 MiB, beside the one-call figures of
  today.

### Slice 1: the counting limiter and the route caps (D1; needs nothing) — _hard_

Files: `server/src/routes/limitedBody.ts`, `server/src/app.ts` (the skip list gains the read route
and the three auth routes), `server/src/routes/resources.ts` (the read route in the `limiter,
authenticated, limitedBody(32 MiB)` pattern), `server/src/routes/auth.ts` (the 16 KiB caps),
`server/src/routes/storage.ts` (the asset batch's drain with the wrapper), `server/src/http/body.ts`,
tests in `server/src/tests/limitedBody.test.ts`, `app.test.ts`, `resources.test.ts`,
`assets.test.ts`, `proxy.test.ts`; the server guide (registration order, body handling, the asset
batch's partial publication).

- Tests, through a real Hono stack with the Node adapter where draining matters: an
  unauthenticated chunked `POST /api/resources/read` of 48 chunks is answered 400 after at most one
  chunk is pulled from a counting source; the same with a valid JWT reads the body and answers; a
  declared length over the cap is 413 with nothing read; a chunked body over the cap is 413 after
  at most the cap plus one chunk on the read route (32 MiB cap, a small injected cap in the test),
  on `batch`, on `/api/write` (whose handler rethrows the failed read) and on the arbitrary proxy
  (whose handler rethrows), and the handler's own answer never wins; a source failure under the cap
  is the configured 400 on those same routes; a handler error with an intact body keeps its answer;
  `POST /api/assets/write` streams through the counting body, an over-cap batch keeps its earlier
  published records and drains; `login` with a 16 KiB + 1 body is 413 before any password check; a
  request of 5,000 chat entries with two 512-character CJK ids each is accepted by the read route;
  every route-specific cap case in the suites listed under **Verification** keeps its answer (run
  them, no new tests there).

### Slice 2: deduplicated, budgeted reads with continuation (D2; needs 3) — _hard_

Files: `shared/resources.ts` (`continue`, `unanswered`, `MAX_READ_RESPONSE_BYTES`),
`server/src/routes/resources.ts`, `server/src/data/resourceStore.ts` (`readRefs` grouping and
charging), `server/src/data/chatStore.ts` (the charge queries), `src/ts/storage/resourceClient.ts`
(the loop; `epochMismatch` between rounds), `src/ts/storage/tests/storeBackedServer.ts` (serve
`unanswered` under a small injected budget; extend its `ServerStore` subset) and
`fakeResourceServer.ts` (plain-ref continuation), tests in `server/src/tests/resources.test.ts`,
`resourcesChats.test.ts`, `src/ts/storage/tests/resourceClient.test.ts`,
`resourceSyncLazyChats.test.ts`, `chatLazyLoading.test.ts`; the persistence guide (reads, the
deadline line) and the server guide (the route table).

- Tests, server (a small injected budget): duplicate refs, chats and collections are answered
  once; without `continue` a request over the budget is answered whole; with it, groups are served
  in request order until the first that does not fit, that group and the rest are in `unanswered`
  with their request shapes, and the first group is served even when it alone passes the budget;
  a character ref and its collection are never split across rounds; a collection over the budget
  is left out without a message row being read (the SQL seam scoped to the message-row statement);
  the charge is stored bytes (a 3-byte UTF-8 row counts 3) and metadata is charged once per chat;
  a summary collection is charged by its stored projections.
- Tests, client: the transport merges two rounds into one result in request order and returns
  once; an `unanswered` list is re-sent with `continue` and the caller's signal; no progress
  throws a `ResourceRequestError`; a 412 and a changed `epoch` between rounds call `epochMismatch`
  and discard the first round; an aborted signal stops the loop; the lazy chat loader, the
  detached export and the refresh queue see complete answers (their suites pass with the
  store-backed server configured to truncate); a 500-chat load that needs several rounds under
  one `deadlineChatRead` completes and installs every chat once, and one whose rounds cannot
  finish before the deadline (fake clock) fails with the existing timeout error and installs
  nothing; a detached export of several characters whose collections span rounds returns every
  collection whole and in order.

### Slice 3: the stored summary projection (D4; needs nothing) — _hard_

Files: `server/src/data/chatStore.ts` (schema setup separated from the readers; the table and the
rebuild; the one projection writer; `readSummaries`, `readCollectionSummaries`, the feed's summary
decision), `server/src/data/resourceStore.ts` (the open order; `summaryProjectionVersion` in
`meta`), tests in `server/src/tests/chatSummaries.test.ts`, `chatStore.test.ts`,
`chatFeedPatches.test.ts`, `backups.test.ts`; the server guide (persistence layout, the
Limitations entry on summary cost) and the persistence guide.

- Tests: after each write kind (create, a `meta` group, `replace`, a checkpoint load, a message
  op, an upstream-style staged write) the stored projection equals `summaryFields` of a fresh
  parse and its `revision` equals the chat's; a summary read of a store with 100 KiB metadata per
  chat selects no `meta` (the SQL seam on the statement) and parses nothing; a row left behind by
  a simulated older writer (revision bumped, text stale) is rebuilt on read and rewritten; a
  store opened without the table gets it rebuilt once, a second open rebuilds nothing, and a
  bumped `summaryProjectionVersion` rebuilds every row; a failed rebuild closes the store; a
  snapshot taken from a store with the table validates on today's layout check; a chat delete
  cascades its row; the feed's `summary`/`summaryBase` decisions are unchanged on the existing
  cases.

### Slice 4: the normalization stamp (D6; needs nothing) — _small_

Files: `server/src/data/resourceStore.ts` (`initialize`, the open sequence, the separable
materialization, the stamp, the `normalizationIdentity` option), `server/src/buildInfo.ts` (the
checkout identity), `server/src/app.ts` (passes the identity), tests in
`server/src/tests/normalizationPass.test.ts`, `resourceStore.test.ts`; the server guide (the
Gotchas entry on startup cost).

- Tests (an explicit identity passed to the store under test): a second open with the same stamp
  runs no record normalizer (an injected registry whose normalizers count calls) and still deletes
  a retired kind and materializes a missing singleton; a different identity, a changed kind
  `schemaVersion`, a changed `NORMALIZATION_VERSION`, an unknown identity, a dirty identity and an
  injected registry without an explicit identity each run the pass; a pass that rewrites writes
  the stamp in its transaction and a failed pass leaves the old stamp; `replaceAll` writes the
  stamp; the identity comes from the checkout, not from `dist/build-info.json`, when both exist
  and differ.

### Slice 5: the validation worker and the SQL install (D5; needs 3 and 4) — _hard_

Files: new `server/src/data/restore/stageValidatedSnapshot.ts`, `validateRunner.ts`,
`validateWorker.ts`, `server/src/data/resourceStore.ts` (`replaceAll(stagedFile, report)`; the
raw validated-row writer; `readSnapshotFile` retired or reduced to the staging function's checks),
`server/src/data/chatStore.ts` and `checkpointStore.ts` (the attached copies, the staging writers),
`server/src/routes/backups.ts` (the pinned source, the restore slot), `backupsUpstream.ts` (token
take, verify, recheck), `server/src/data/upstream/importStage.ts` (the raw writer and the hash in
the prepare report), `server/src/data/snapshots.ts` (the pin under the queue), `server/src/app.ts`
(`RISU_RESTORE_HEAP_MB`, the runner seam, worker lifetimes at shutdown), tests in
`server/src/tests/backups.test.ts`, `resourceStore.test.ts`, `snapshots.test.ts`,
`upstreamImportRoute.test.ts`, `changeFeed.test.ts`, a new `restoreStage.test.ts` (in process) and
`restoreWorker.test.ts` (a real worker, `slow`, as `upstreamImportWorker.test.ts`); the server
guide (restore flow, Invariants, the Limitations entry on serving-thread validation) and the
backup-sync-hub guide.

- Tests: every current restore, import and commit assertion (epoch, safety snapshot, maintenance,
  412 ordering, reads open during maintenance, checkpoint bytes and policies, asset links) passes
  with the in-process runner; an install from a staged file equals the source (rows with their
  numeric revisions and order, chats, messages with compacted positions and fences, orders,
  checkpoints byte-for-byte, policies, projections), with `chatGroups` and `chatRestoreFloors`
  empty; a later delete and recreate after an install does not reuse an incarnation; a staged
  file whose size, mtime, inode or hash differs from the report is refused 400 and nothing
  changes; an injected failure during a later copy statement rolls back rows, epoch, write count,
  caches and the feed (replacing the duplicate-row rollback fixture, which a constrained staging
  store cannot produce); the one `epoch` event follows the commit, and a `DETACH` failure does not
  suppress it; the snapshot restore keeps its pinned source when retention prunes the original
  during validation; a second restore waits for the slot and the stale one still answers 412
  without a safety snapshot; the upstream commit answers 409 and keeps its token when a write
  lands during the hash pass; a worker OOM, an abort and shutdown each leave the store and epoch
  untouched and the staging removed (`restoreWorker.test.ts`); no row normalizer runs on the
  serving thread during a commit (the injected registry's counters); a restore of the
  5,000-message store records its install interval (a `slow` empirical report, not a gate
  assertion).

### Slice 6: the ordered writers and state operations (D7; needs nothing) — _hard_

Files: new `server/src/data/orderedWriter.ts`, `server/src/data/durableWrite.ts` (an async
`writeFileDurable` beside the sync one), `server/src/diagnostics/journal.ts`,
`server/src/push/pushService.ts`, `server/src/routes/push.ts`, `server/src/routes/auth.ts`,
`server/src/main.ts` (the fatal path), `server/src/app.ts` (dispose drains; shutdown tracking of
the new operations), `shared/diagnostics.ts` and `shared/diagnosticsReport.ts` (`dropped`), tests
in a new `server/src/tests/orderedWriter.test.ts`, `diagnostics.test.ts`, `diagnosticsCrash.test.ts`,
`push.test.ts`, `app.test.ts`, `durableWrite.test.ts`, `requestShare.test.ts`; the diagnostics
guide and the server guide (Limitations on directory sync).

- Tests (an injected `fs` seam with controllable latency, fake timers): appends to one day file
  land in order and never race that file's pruning; a queue over 8 MiB drops appends and the
  count reaches `state.json` and a report; two queued state publications collapse to the latest
  while a started one completes; a share taken while appends are queued contains them (the
  barrier) and is marked partial after a drop; two concurrent push registrations both survive
  (operation serialization), a `PUT` answers 204 only after its durable write and 500 when it
  failed, delivery bookkeeping coalesces; two concurrent logins register both keys; two concurrent
  `set_password` calls have one winner and the other answers `already set`; the fatal path leaves
  the fault event and the final state on disk with the writer stalled, and a state rename in
  flight before the fence never lands after it; dispose drains and publishes last; a
  directory-sync `EINVAL` is tolerated as today; the journal's `NOFOLLOW`, mode and partial-write
  truncation cases keep passing.

### Slice 7: checkpoints (D8; needs 3) — _small_

Files: `server/src/data/chatStore.ts` (the expression index at open; `countUserTurns`),
`server/src/data/checkpointStore.ts`, `server/src/data/checkpointService.ts`, tests in
`server/src/tests/chatCheckpoints.test.ts`, `chatCheckpointAuto.test.ts`; the server guide.

- Tests: `autoSave` on a chat with a policy reads no message row when the turn is not due (the
  SQL seam scoped to the message statements) and decides as before at turns 1 and 3 with
  `autoEvery` 2, a due turn then saves; `save` parses at most two message rows (the seam on the
  parse of message rows, metadata excluded) and stores the same `userTurns`, `messageCount`,
  preview (oldest first) and page hashes as before for the existing page fixtures; a prune of one
  chat removes its unshared message and field pages and leaves another chat's orphan page for the
  open-time sweep; a delete behaves the same; a store opened without the index gets it and uses it
  (`EXPLAIN QUERY PLAN` names `messages_role`).

### Slice 8: the durability knob, docs close and the audit's after lines (needs all)

Files: `server/src/data/resourceStore.ts` and `server/src/app.ts` (`RISU_SQLITE_SYNCHRONOUS`,
Q1, validated and applied to the resource store only), the affected guide paragraphs, the audit
sections' "After" lines (commit, fixture, values from the Slice 0 probe), the Known Hazards entries
this plan closes or narrows (serving-thread validation, startup cost, summary parse cost,
synchronous writes) and the ones it leaves (the install copy interval, the unbounded
`GET /api/resources`, the soft budget's oversized groups, an over-cap body to a route that ignores
it), `docs/plan/README.md`, the archive entry at retirement.

## Recommended order

0 → 1 (the route line); 3 → 2 (reads need the projection); 4 → 5 after 3 (the store line:
3 → 4 → 5, or 4 in parallel with 3 since they share only `resourceStore.ts`'s open sequence, then
rebase); 7 after 3 and before or after 5 (serial on `chatStore.ts`); 6 alone, any time; 8 last.
Only this plan is active.

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the affected `slow` and `e2e` sets;
  Slice 2 also `e2e/serverTransform.spec.ts` and the lazy-chat specs), V6 (each new regression test
  shown failing once with its guard broken), V4 (`rg` each changed export, wire field and env knob
  across `src`, `server`, `shared`, `util`, `e2e`, `docs`), V7 (typed mock factories; no new inline
  module mocks), V3 (no real time: the writer's latency and the journal timers use injected clocks
  and an injected `fs`), prettier on changed files.
- Seams: the `DatabaseSync.prototype.prepare` wrapper (`server/src/tests/jobMetadataScope.test.ts:25`)
  wraps `.all()` of one statement text; the slices that count row reads extend it per test to the
  statements they watch (`.all()`, `.get()` and `.iterate()` of the message and `meta` selects)
  and never count aggregate-only statements as row reads. Spies: an injected kind registry whose
  normalizers count calls (module-internal functions such as `normalizeInput` cannot be spied).
  The in-process runner seam of `upstreamImportRoute.test.ts:45` for Slice 5; a real worker only
  in the `slow` file. The store-backed server under `src/ts/storage/tests/` for Slice 2's client
  tests. No production counter is added for tests.
- Route suites that must keep their answers after Slice 1 (run, not rewritten):
  `resourcesBoot.test.ts`, `tokenRoutes.test.ts`, `messageSearch.test.ts`, `assetRoute.test.ts`,
  `diagnostics.test.ts`, `requestShare.test.ts`, `push.test.ts`, `transform.test.ts`,
  `translate.test.ts`, `memoryTasks.test.ts`, `backups.test.ts`, `importModule.test.ts`,
  `importCharx.test.ts`, `importRealm.test.ts`, `requestHistoryRoutes.test.ts`.
- Fixtures stay structural: a few rows, three entries, two chunks, injected caps and budgets of a
  few KiB. The 5,000-message and 3,000-chat cases are probes (Slice 0) or `slow` tests.
- Each test must catch one of these wrong implementations:

  | Wrong implementation                                                          | Caught by                                       |
  | ----------------------------------------------------------------------------- | ----------------------------------------------- |
  | Limiter still buffering a chunked body before `next()`, or prefetching        | Slice 1 one-chunk test                          |
  | 413 returned instead of set on `c.res`; handler's 400/500/502 wins            | Slice 1 over-cap tests on rethrowing routes     |
  | A source failure under the cap answered 413, or a handler error remapped      | Slice 1 failed-stream and intact-body tests     |
  | A valid maximum-shape read request refused by the new cap                     | Slice 1 CJK-id test                             |
  | Budget applied to a client that did not say `continue`                        | Slice 2 whole-answer test                       |
  | A character and its collection split across rounds; a collection truncated    | Slice 2 group and collection tests              |
  | First group refused because it alone passes the budget                        | Slice 2 first-group test                        |
  | Charge in UTF-16 units, after parsing, or metadata multiplied per message     | Slice 2 byte, seam and once-per-chat tests      |
  | Transport returning a partial merge, looping without progress, or not halting | Slice 2 merge, no-progress and epoch tests      |
  | A meta write path that leaves the stored summary stale or its revision behind | Slice 3 per-write-kind equality                 |
  | Stale rows from an older writer trusted                                       | Slice 3 older-writer test                       |
  | Summary read parsing `meta` anyway                                            | Slice 3 seam test                               |
  | Rebuild outside its own transaction (a failure leaves a half-built table)     | Slice 3 failed-rebuild test                     |
  | Stamp from the served client's build; dirty or injected registry skipping     | Slice 4 identity tests                          |
  | Stamp written outside the pass's transaction                                  | Slice 4 failed-pass test                        |
  | Staging through `put`/`applyChanges` (revisions, seqs, positions changed)     | Slice 5 equality test                           |
  | Floors or receipts copied; incarnation reused after an install                | Slice 5 empty-table and recreate tests          |
  | Install trusting an unreported or changed staged file                         | Slice 5 size/mtime/inode/hash test              |
  | Install outside one transaction, or epoch moved on failure                    | Slice 5 injected-failure rollback test          |
  | Source unpinned (pruned under the worker); commit skipping the count recheck  | Slice 5 retention and 409 tests                 |
  | Commit still normalizing rows on the serving thread                           | Slice 5 registry-counter test                   |
  | File tasks serialized but state transitions not (lost registration or key)    | Slice 6 concurrent-registration and login tests |
  | Two `set_password` winners                                                    | Slice 6 single-winner test                      |
  | Fatal event queued and lost; an earlier state landing after the final one     | Slice 6 fatal and fence tests                   |
  | Journal hardening replaced by a generic write; append racing its own prune    | Slice 6 `NOFOLLOW`/partial-write/prune tests    |
  | A share missing queued events without saying so                               | Slice 6 barrier and partial tests               |
  | `autoSave` still reading rows when not due; preview from the wrong rows       | Slice 7 seam and preview tests                  |
  | Prune sweeping the whole table, or leaving its own orphans                    | Slice 7 prune tests                             |

## Out of scope

- A message window for chat reads and a by-id continuation inside one chat or one collection
  (the client's chat module, the reveal and the composer hold whole chats).
- A database worker for ordinary queries, and resuming anything across a restart.
- Streamed progress for the snapshot restore and the version-2 import (their answers stay one
  JSON; the upstream prepare already streams).
- Bounding `GET /api/resources?kinds=…` (the boot-cache miss path) and the `hello` frame.
- The thumbnail cache byte cap and asset or backup retention (the retention group).

## Later

- **A bytes-in-flight gate for reads** (the first draft's D3): admission before materialization
  from D2's SQL charges, an oversized lane so a single large group is always admissible, a
  fail-fast refusal rather than a FIFO wait inside the caller's deadline, and a compression-input
  semaphore labeled as such (it bounds buffers under compression, not response memory held by slow
  clients). Measure concurrent large reads after Slice 2 first.
- **Page-hash reuse across checkpoint saves**: a per-chat set of touched ids since the last
  checkpoint, fed from `ChatWriteChange` in the committed hook, lets a save copy a page's hash when
  its rows are untouched and its id range unchanged; needs a design for whole writes and restarts
  (both mean "all dirty"). Measure D8's remaining per-row cost first.
- **Per-round deadlines for continued reads**: today's callers wrap the whole call; moving
  `deadlineRead`, `deadlineChatRead` and `readWithDeadline` to a per-round policy touches five
  client files. Continuation is common for the chat loader and the detached export (D2), but the
  bytes under one deadline stay about today's; adopt this when Slice 0's multi-round measurement
  shows a load or an export approaching its deadline on a slow link.
- **A paged `GET /api/resources`** for the boot-cache miss, with the same `unanswered` contract.
- **Restore and import progress** as NDJSON, with a prepare/commit split for the version-2 import
  so its validation can be shown before maintenance.
- **A streaming validator** that keeps no id sets at all (cross-row checks through SQL scratch
  tables), if a store large enough to pass the worker's heap appears.

## Answered questions

The user took the recommendation on each question on 2026-10-31.

- **Q1. Durability of the resource store on slow volumes.** The store opens with `synchronous =
FULL` (every commit fsyncs the WAL on the serving thread); receipts, history and the vector cache
  use `NORMAL` (an fsync per checkpoint; after a power or OS failure the last commits may be
  missing, the database stays consistent; the loss window is not a fixed duration).
  Answer: keep `FULL` as the default and add `RISU_SQLITE_SYNCHRONOUS=normal`
  for operators on SD cards or other slow local volumes, validated, applied to the resource store
  only, and documented as "acknowledged commits may be lost after a power failure", not as support
  for network filesystems (unsupported, server guide Invariants). The client's draft journal
  treats a server acknowledgment as saved, which `FULL` keeps literally true. Rejected: `NORMAL`
  by default.
- **Q2. The read budget.** Answer: 16 MiB of charged stored bytes per answer (the
  audit measured live heap well above the JSON size). Rejected: 32 MiB. What the number
  implies, unmeasured so far: a 500-chat `loadChats` call continues when its chats average over
  about 33 KiB, so loading a character with a long history is several rounds under its one 60 s
  deadline, and a dataset export of many characters is several rounds per 500-character chunk
  under its 60 s deadline; 32 MiB would halve the rounds at twice the heap per round. The constant
  is one line; Slice 0 measures five distinct 10 MB chats, and the round count and total time of a
  500-chat load and of a detached export on the 3,000-chat fixture, at 16 MiB and at 32 MiB, so
  the answer can be revisited on numbers.
- **Q3. The first group of an over-budget answer.** Answer: always served,
  whatever its size, so a chat or a collection that grew past the budget stays readable; the
  budget is soft and the guide says so. Rejected: refusing it with a 413 and a size, which makes
  such a chat unreadable in the app. A membership or snapshot pagination
  for collections would be the real bound; it is out of scope.

## Review record

The Astra review of the first draft (2026-10-31, `gpt-6-astra`, read-only; report under
`/home/codex/review-reports/server-byte-budgets-plan-2026-10-31/astra.md`) raised 19 findings
(7 P1, 12 P2). Verdict: redesign D1's response handling, D3, D5's install contract, D6's
serialization shortcut and D7's ordering; give D2 a consistency and deadline contract; version D4;
correct the slice graph and several test premises. All are taken except the trims below.

- **P1 taken.** F1: the limiter sets `c.res` after `next()`, tracks overflow and source failure
  itself, and is demand-driven; rethrowing handlers covered. F6: D3 deferred to **Later** with
  the preflight design it needs; the false 100 MiB per-chat ceiling corrected. F9: a raw
  validated-row writer and an explicit install algorithm (fresh seqs through a mapping table,
  `chatGroups` and floors empty, pages byte-exact, `DETACH` after commit, the `ATTACH` claim
  corrected). F13: "serialize once" withdrawn. F15: push and auth become serialized state
  operations with install-after-durable-write and a single-winner `set_password`; 204 corrected.
  F16: a synchronous fatal path for both the event and the state, a terminal fence on renames,
  dispose drains and publishes last, `main.ts` in the slice. F17: the writer schedules the
  consumers' own hardened operations; appends and pruning share an ordering key.
- **P2 taken.** F2: route-specific admission (auth routes capped at 16 KiB, the asset batch's
  partial publication and the ignored-body routes documented, streamed responses keep reading
  first). F3: the read cap is 32 MiB, computed from the largest valid request. F4: character
  groups are atomic across rounds, `epochMismatch` on a 412 between rounds, no partial merge.
  F5: the caller's deadline bounds the whole call, said in the guide; per-round deadlines in
  **Later**. F7: summary collections charged by D4's stored projections, so Slice 2 needs
  Slice 3; the charge defined per entry type. F8: the table carries a revision fence and a
  projection version, snapshots carry it and restore never trusts it, the rebuild runs in its own
  transaction before the readers exist, the worker writes fresh projections. F10: the staging
  writer keeps no page text and enforces uniqueness in SQL; the remaining memory stated. F11: a
  pinned source under the snapshot queue, one restore worker, the commit rechecks epoch and write
  count after the hash pass. F12: an in-process staging function with an injectable runner,
  custom registries stay in process, the rollback test replaced by an injected copy failure, the
  trust contract spelled out, "off the thread" corrected to bounded chunks. F14: the identity
  comes from the checkout, not the served build; `NORMALIZATION_VERSION`; injected registries
  need an explicit identity. F18: `eventsFor` awaits a barrier and marks drops; the shared types
  in the slice. F19: the dependency and file lists rewritten; the test premises corrected (no
  heap assertion in `assets.test.ts`, the SQL seam's scope, `ResourceRequestError`, the due-turn
  path, the dedupe effect on Q2's example, the histogram's meaning).
- **Trimmed.**
  - F2's suggestion to stage the asset batch to disk so an over-cap batch publishes nothing: the
    route already treats a mid-upload failure as "earlier records stay", and content-named
    records are harmless alone; the behavior is documented instead.
  - F5's per-round deadline API: not adopted now (five client files for a rare case); the overall
    deadline is documented and the item is in **Later**.
  - F10's fully streaming validator (no id sets): the writer drops page retention and uses SQL
    constraints; id sets of ids only stay, with the remaining bound stated. The scratch-table
    design is in **Later**.
  - F6's redesign of D3: deferred rather than redesigned here.

A follow-up note (2026-10-31, another agent, checked against the code) corrected D2's claim that
continuation would be rare: the chat loader reads 500 whole chats per call and the detached export
whole collections of 500 characters per call, so both continue routinely at 16 MiB. D2, Q2's
rationale, Slice 0 (round count and total time) and Slice 2's tests (many rounds under one
deadline) were changed accordingly.

Slice 0 (2026-10-31) found that the first wording of D2's **Groups** item, which put a character's
`chats` entries in its group, contradicted that note: a 500-chat `loadChats` call names one
character, so the whole load would have been one always-served first group. The user chose to make
every `chats` entry a group of one (the probe's `chatUnits` reading); the character group keeps
the record and its two collection entries.
