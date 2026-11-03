# Request History and Diagnostics

## Scope

Owns durable LLM request history, checked job failures, content-free server/browser diagnostics, combined reports, and
user-selected support copies.

Paths: `shared/{requestHistory,diagnostics,diagnosticsReport}.ts`, `server/src/data/requestHistory.ts`,
`server/src/diagnostics/`, `server/src/routes/{requestHistory,diagnostics}.ts`, `src/ts/diagnostics/`,
`src/ts/network/requestHistory.ts`, `src/lib/Others/RequestLogs/`,
`src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`.

The tab's `fetchLog` belongs to [network-jobs](network-jobs.md); capture/credential redaction to
[llm-requests](llm-requests.md); startup/auth/disposal to [self-host-server](self-host-server.md).

## Files

### History and checked failures

- `server/src/data/requestHistory.ts` `createRequestHistory`: SQLite/WAL store. `begin`, `setPrompt`, `describe`,
  `firstByte`, `exchange`, `finish`, `list`, `get`, `deleteAll`, `setShared`, `prune`, `stats`, `available`, `close`.
  - First-byte and completion writes are first-wins; exchanges after completion can still land. `list` returns
    newest-first summaries with an opaque `seq` cursor.
  - A newer schema leaves the file untouched and inert; startup changes pending rows to `interrupted`. A failed
    operation becomes a skipped write or empty read with one warning; a transaction whose rollback fails closes the
    store.
- `server/src/diagnostics/log.ts` `logEvent`, `formatLogEvent`: checked failure fields and a known error
  name/application frame, never its message. `generationJobs.ts` `markFailure`/`failureOf`/`errorTerminal` preserve the
  nearest `stage`, `requestId`, `providerCode`, `code` through replacement errors. Writes mark `persist`, scripts mark
  `script`, requests mark `request`; the runner supplies its current stage when none was marked. A recorder also
  receives caught runtime faults.
- `server/src/routes/requestHistory.ts` `registerRequestHistoryRoutes`:
  - `GET /api/request-history?cursor&limit&chaId&chatId&jobId&status` → `{ items, next }`; malformed cursor/size/status
    → 400. `GET /:id` returns content or 404.
  - `DELETE /api/request-history` removes support copies before rows (204; 500 if a copy remains or deletion fails). A
    partial file-removal failure leaves all history rows but may already have removed some files; a later database
    failure leaves the rows after all support files were removed.
  - `PUT /share` takes exactly `{ jobId | requestId, shared }` (JSON, 4 KiB); `GET /shares` lists copies including those
    whose rows expired. Share failures include 404, 413 over 32 MiB, and 500.

### Journal, reports, and support copies

- `shared/diagnostics.ts`: event/state contracts and exact-key projections.
- `server/src/diagnostics/journal.ts` `createDiagnosticsJournal`: `record`, `recordFatal`, `settled`, `recent`, `state`,
  `start`, `writeState`, `writeStateSync`, `close`, `finish`, `saveReport`, `saveShare`, `commitShare`, `discardShare`,
  `removeShares`, `removeAllShares`, `listShares`, `eventsFor`.
  - A `job` error end from an explicit chat stop by another client includes the content-free `stoppedBy: "otherClient"`,
    retained by the journal and report projection. Its reason stays `aborted`: `isJobFailureEvent` excludes all user
    aborts, including these, from `recentJobFailures`; support-share failure summaries are unchanged.
  - Events are `http`, `job`, `request`, `runtime`, `lifecycle`, and `push`; HTTP events record only failures or
    responses over 5 s, with a registered route template.
  - Server `push` events (`server/src/push/pushService.ts`, through `recordSafely`, so a throwing recorder never changes
    delivery) are one per subscription a completion was sent to: `accepted` (the push service took it, not that the
    phone showed it), `failed` (`status` when it answered), `removed` (404/410); or one `dropped` with `reason` `closed`
    | `noKeys` | `queueFull` | `noSubscriptions` | `unreadable`.
  - Server `push` fields: `service` (`fcm` | `apple` | `mozilla` | `windows` | `other`, from the endpoint host, never
    the URL) and `jobId` (passed beside the notification by the runner's `notifyCompletion`, never in the payload).
  - Appends and `state.json` publications run off the serving thread over `fs.promises`, as operations on the context's
    ordered writer ([self-host server](self-host-server.md)), one key each. `record` is synchronous for the ring and the
    job failures, then queues the line; an append and the prune after it are one operation, so an append never races the
    deletion of its file.
  - Past `MAX_QUEUED_WRITE_BYTES` (8 MiB of queued lines) a line is not queued: the event stays in the ring and
    `dropped` counts it (in the state and in reports).
  - `writeState` queues a publication; one not yet started is shared by later calls and builds its state when it starts,
    so the latest state wins and a started one completes. Boot uses `writeStateSync` (nothing is served yet).
  - `recordFatal` (both `main.ts` fatal paths) raises the terminal fence and takes over on the calling stack: the queued
    lines in order, the fault's event, then the state, synchronously. `finish` (dispose) closes the timers, waits for
    the two keys for at most 1 s, then does the same takeover without an event, so the final state is published last.
  - Past the fence a queued operation does nothing, one in flight stops at its next check and touches no count, and
    `record` and `writeState` work synchronously. A partial append's truncation, a prune's unlink, and the publishing
    rename run on the JS thread behind that check, never as a submitted call, which could land after the takeover.
  - The synchronous path never prunes (a prune could delete the fault's event when its day file alone passes the cap);
    the next creation's scan does. A line whose first write was already submitted at the fence may land after the
    fault's.
  - Reports and shares stay synchronous with their unique-file publication, so a share stays one step from its first
    read to its last write.
  - Failed daily JSONL appends truncate back; a partial final line is separated before the next append. Whole-file
    state, report, and share writes flush the temporary file before rename and sync the folder afterwards; a folder-sync
    failure is counted even though the renamed file is treated as landed. Daily event appends are not flushed to disk.
    Failed writes increment a counter and log the first error code without throwing.
- `server/src/diagnostics/share.ts` `createRequestShares`: `history.readShare` takes one transaction snapshot, oldest
  rows first; content-off rows contribute summaries. A share includes matching journal events and the last job error's
  checked fields.
  - The route awaits `settled` (every event accepted before the request is on disk) before its shutdown recheck, then
    `share` runs without an await, so no withdrawal or "Delete all" can interleave; a line dropped in the interval marks
    `eventsPartial`.
  - `loadStoredSecrets` must succeed before sharing; every string is redacted again, headers masked by name, and
    trailing credential prefixes trimmed from cut fields.
  - Replacement order is new file → mark every row → remove older files. A failed mark removes the new copy; failed
    removal keeps the new copy/marks and answers 500. Withdrawal removes files before clearing marks; a partial
    filesystem failure can remove some files while leaving marks.
- `server/src/routes/diagnostics.ts` `registerDiagnosticsRoutes`: `GET /api/diagnostics` returns `{ events, state }`
  from memory without a write, including during maintenance or a folder-write failure. `POST /api/diagnostics/report`
  accepts text up to 1 MiB only when `canonicalDiagnosticReport` rebuilds it byte for byte; invalid text → 400 and is
  never logged. It checks shutdown again before saving.

### Browser

- `src/ts/diagnostics/collector.ts` `startDiagnosticsCollector`: starts in `boot.ts` before app modules. Keeps this
  window's last 300 checked events; identical recent events fold into `repeat`/`lastAt` (last 16 entries, 10-minute
  window; never boot).
  - The session mirror flushes within 1 s, on hide/pagehide, and before app reload; restore re-projects entries and
    accepts at most 512K characters.
  - Its fetch wrapper dispatches the original first, once, preserving response/rejection and unhandled rejection
    behavior; only same-origin API/worker/proxy failures become checked route-template events. Runtime frames are
    origin/path checked. Plugin iframes are another realm and are not covered.
- `bootCache` from `storage/bootCache.ts` reports `fallback`, `writeFailed`, and `cleared`, with checked reasons. The
  cache owner is [resource-sync](resource-sync.md).
- Hooks in `generationJobs.ts`, `serverCommands.ts`, `eventFeed.ts`, `resourceSync.svelte.ts`, and `bootstrap.ts` report
  job attachment/retry/loss, feed state, sync conflicts/reloads, and service-worker setup. They contain no content.
  Phase and field allowlists live in `shared/diagnostics.ts`; change them with the projection and focused tests.
  - `jobLink` phases: `attach`, `detach`, `attachFailed`, `reattach`, `resume`; `lost` (the server stayed unreachable),
    `gone` (the server no longer knows the job), `kept` (the end came from the server's kept outcome of a collected
    job), and `recovered` (the chat read after a lost or gone follow took); `stale` (no frame for 45 s while visible),
    `connectTimeout` (not open within 10 s), `resumeReconnect` (an attach replaced because the page came back), and
    `closedAway` (a close while the page was hidden or the browser offline, not counted against the attach budget).
  - `feed` phases: `connected` (a `hello` of the loaded epoch), `disconnected`, `connectFailed`, and the same `stale`,
    `connectTimeout`, and `resumeReconnect`.
  - `page` phases: `boot`, `visible`, `hidden`, `online`, `offline`, and the Page Lifecycle's `freeze` (which also
    flushes the mirror) and `resume`.
- Browser `push` events:
  - The page's `browserState`, at the collector's start and on every `visible` (`permission` `granted` | `denied` |
    `default` | `unsupported`; `subscribed`, whether this browser holds a push subscription, false without a worker
    registration or push manager; `standalone`, `display-mode: standalone`; a value that could not be read, or a
    subscription lookup over 2 s, is left out rather than false).
  - The page's `dismissedByPage`, with the `count` of completion notifications `pushNotifications.ts` closed when the
    page became visible (only when it closed any), and `chatRefresh` when a completion push had the page read a chat no
    follow of its own covers (`serverCommands.ts` `refreshChatAfterPush`).
  - The service worker's records (`public/sw.js`): `received` (stamped on arrival, before the display queue), `shown`,
    `shownSilent`, `closedInFront`, `showFailed` with `inFront` (the in-front predicate the display used;
    `closedInFront` carries the second check's) and `focusedHidden` (some window focused but not visible), and
    `clicked`.
  - The projection keeps a side's phases and fields only: a browser `push` has no `service`, `jobId`, `status`, or
    `reason`, a server one none of the browser's fields.
- `sync` phases:
  - `conflict` from the save loop (`resourceSync.svelte.ts`), `reload` with `restore` from its restore halt or
    `serviceWorker` from `bootstrap.ts`, and `saveWait` for a dispatched batch whose work waited over 2 s since its
    first unsettled mark (`reason` `inFlight` | `backoff` | `refresh` | `generating` | `conflict`: the blocker noted
    while it waited; `records`, `chats`, `orders` count the delayed work; `durationMs` from the oldest mark to
    dispatch).
  - From the draft journal (`src/ts/storage/draftJournal.ts`): `journalSkipped` (`reason` `tooLarge` | `budget` for a
    write it did not make, `format` for rows it cannot read and keeps or recovery intent it cannot install, with
    `entries`), `journalFailed` (`unavailable`, `timeout`, `blocked`, `quota`, `write`, `readFailed`, `uncloneable` for
    a value it could not copy), and `journalRecovered` (`orphan`, the `entries` it took over from a closed tab).
  - `journalRecovery.ts` also emits `journalRecovered` with the boot decision count in `entries` and no reason, and
    `journalFailed` with `timeout` or `readFailed` when recovery fails. The adapter also emits journal budget skips and
    write/restore-snapshot failures.
- `notice` events (`notice` `serverJobLost` | `serverJobEndedAway` | `resourceReloaded` | `transformFailed`) are
  recorded where those alerts are shown: `serverCommands.ts` `reportEnd` and `recoverJobChat`, and
  `resourceSync.svelte.ts` `showReloadedNotice` (only when the latched notice was not already on screen);
  `transformFailed` by `parser/transformClient.ts` `serverProcessScript` for each failed `editdisplay` target (the
  collector folds repeats).
- `src/ts/diagnostics/report.ts`, `shared/diagnosticsReport.ts`, and `DiagnosticsPanel.svelte`: Settings → Advanced →
  Developer & diagnostics. Read the server for at most 10 s; failure still gives the browser report.
  - The browser's list is this tab's ring plus the worker's push records (`src/ts/diagnostics/workerRecords.ts`
    `readWorkerRecords`, read for at most 1 s without creating the database, each projected), sorted by time before the
    per-source cut; a failed or slow read counts as one omitted event, no IndexedDB as none.
  - Merge checked events by time (newest 300 per source, oldest omitted beyond 1 MiB); include app version, the tab's
    build id (`Build:`, a line an older tab's report lacks), browser/OS family rather than user agent,
    online/viewport/export time, checked server state, and omission counts.
  - Copy/Download/Save act on the report shown. Save's 30 s bound covers authentication and dispatch; it never retries.
- `src/lib/Others/RequestLogs/RequestLogsPopup.svelte`: Server history and This tab tabs. `ServerRequestHistory.svelte`
  filters/paginates durable rows, reads details, confirms deletion, and shares/updates/withdraws a job or standalone
  request. The popup retains a job filter across tabs; `TabRequestLogs.svelte` reads the bounded in-memory view through
  `getFetchLogs`, `LogField.svelte`, and `requestLogView.ts`. History network access is in
  `src/ts/network/requestHistory.ts`.

## Flows

- Each admitted `start`/`runInJob` attempt starts a history row through `createHistoryObserver`; retries have separate
  request ids under the same job. Exchanges and the outcome complete it. Tab requests also retain their separate `log`
  events; plugins' `getFetchLogs` still sees only that tab's in-memory list.
- A checked failure reaches `alertJobError`: Copy debug info includes checked ids, time, version, build id, status,
  reason, stage, and provider code, never the message; Open in request history filters the viewer to its job
  ([chat-pipeline](chat-pipeline.md)).
- Server events enter the journal; browser events stay local until the user saves a combined report. Copy and Download
  remain local. Save writes the shown report.
- Share for support on any request of a job copies every request in that job; a request without a job is copied alone.
  Update refreshes the snapshot; Withdraw removes it. Support deployment must restrict the sftp operator to the
  diagnostics folder.

## State

- `save/data/request-history.sqlite` is separate from `resources.sqlite` and excluded from snapshots/archives.
  Restore/import/maintenance/epoch changes leave it intact. Content capture defaults on;
  `providers.requestHistoryContent: false` applies only to new rows (a failed settings read defaults off). Count limit
  `providers.requestHistoryLimit` is 10–10,000, default 1,000; byte cap `RISU_REQUEST_HISTORY_MAX_BYTES` defaults to 512
  MiB. Every write prunes oldest rows, pending ones included. A failed limit read skips that prune.
- History bounds: prompt/body 2 MiB, response 4 MiB, URL/header/error 64 KiB, display fields 1 KiB; ids over 2 KiB are
  omitted, never cut. First 32 exchanges are kept; later ones counted. Truncation is recorded; invalid numbers become
  null.
- Diagnostics root: `RISU_DIAGNOSTICS_DIR`, resolved lexically with `path.resolve(rootDir, value)` (an absolute path or
  `..` may place it outside that root), default `save/diagnostics/`. `events/<UTC day>.jsonl` is capped by
  `RISU_DIAGNOSTICS_MAX_BYTES` (default 64 MiB), pruning oldest days, current day included when it alone exceeds the
  cap. The in-memory ring keeps 300 events.
- `state.json` is replaced atomically: checked version and build id (`app.build`, from `server/src/buildInfo.ts`
  `readServerBuildInfo`)/runtime, uptime, history settings/stats, journal bytes/failures/dropped, worker counters, live
  jobs, and last 20 non-abort failures. Writes occur at creation, every 10 minutes, on fatal fault, and last at
  disposal, after admitted work drains and the queues settle. The first error since the last state write schedules
  publication after up to 5 s; later errors do not postpone it. `writeState()` resolves after publication completes.
- `reports/<UTC stamp>-<8 hex>.txt`: newest 50 matching regular files retained; the new save survives a prune failure.
- `shared/<UTC stamp>-job-<id>.json` or `-request-<id>.json`: explicit request-content snapshots, bounded at 32 MiB of
  stored bytes; leftover share temp files are removed at creation. `shared.files` is null when unreadable.
- Browser mirror key: `sessionStorage` `risu-diagnostics`.
- The service worker's push records: IndexedDB `risu-sw-diagnostics`, store `records` (auto-increment keys), the newest
  100, appended and pruned in one transaction once the display attempts settled (a click's once the window work
  settled), outside the display queue. A failed or blocked open, a failed write, or one not done in 2 s is skipped and
  never delays `showNotification`. They survive an Android kill of the app's process, unlike the mirror.

## Coupling

- [LLM requests](llm-requests.md): observer lifecycle, stream capture, source labels, provider codes, and redaction
  before history writes.
- [Self-host server](self-host-server.md): journal lifetime, fatal-fault recording, graceful shutdown, auth, limiter,
  and stores.
- [App shell](app-shell.md): collector startup; [network-jobs](network-jobs.md): tab logs and job/feed hooks;
  [test-harness](test-harness.md): crash-process tests.

## Invariants

- Content-free events/reports exclude messages, prompts, bodies, headers, credentials, names, query URLs, free-form
  error messages, Lua values, and plugin values. Exact-key projection keeps only checked ids, enums, numbers/booleans,
  bounded provider codes, and application frames. Canonical reports must round-trip.
- History is distinct from that journal: it can contain full content and bounded redacted error messages even with
  capture off. Changing capture does not erase earlier rows. Plugin consent for the tab log does not grant durable
  history.
- All UI routes use app JWT, shared limiter, `no-store`, and shutdown admission. They are not resources: no
  epoch/maintenance gate. Unavailable history returns 503 after authentication; writes recheck shutdown immediately
  before committing.
- Preserve checked filenames, regular-file checks, and child-path symlink refusal. The configured diagnostics root
  itself may be a symlink or mount. Created directories/files use 0750/0640. Symlinked/non-directory `events`,
  `reports`, or `shared` are refused; event handles use `O_NOFOLLOW | O_NONBLOCK` plus `fstat`, on the queued and the
  synchronous append alike. State uses temp+rename; state, report, and share temp creation is exclusive and no-follow.
- Nothing may land after the final state: every step that can undo or replace bytes on disk runs on the JS thread behind
  the terminal fence, and a fatal fault's event and state are written synchronously.
- A diagnostics-only sftp account is the support-access boundary: restrict it to this folder and prevent access to
  `save/data/` or the wider `save/`. The app creates no sftp account/chroot. Support copies require explicit user action
  and retain the redaction/write/mark/remove ordering above.

## Recipes

- Investigate a failure through the server history's job filter and checked debug metadata. Configure capture and row
  count in Advanced settings.
- Collect a report through Settings → Advanced → Developer & diagnostics → Refresh, then Copy, Download, or Save to
  server. A timeout after dispatch may have saved it already.
- Use Share for support, Update, and Withdraw in the viewer for request content. Sharing a job includes its other
  requests, including memory and auxiliary LLM calls.
- Configure sftp for only the resolved diagnostics directory, with group read access compatible with the file modes. In
  Docker, map the actual diagnostics directory and verify the restriction from that account; this production check
  remains a manual follow-up in the archive.
- Add a diagnostic kind/field in shared projection/validation, the emitting source, report canonicalization if
  applicable, and focused tests. Keep raw provider/error content out of event fields.

## Tests

- Server Vitest:
  `pnpm --silent test:agent shared/tests/diagnostics{,Report}.test.ts server/src/tests/{requestHistory,requestHistoryRoutes,requestShare,diagnostics,logEvent,orderedWriter,push}.test.ts`.
- Browser Vitest:
  `pnpm --silent test:agent src/ts/diagnostics src/ts/network/{pushNotifications,generationJobs}.test.ts src/ts/process/serverCommands.test.ts src/ts/storage/tests/resourceSyncDiagnostics.test.ts`.
- UI Vitest:
  `pnpm --silent test:agent src/lib/Setting/Pages/Advanced/DiagnosticsPanel.test.ts src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`.
- Server fixtures: request history uses real SQLite; journal tests use temporary directories and injected
  filesystem/writer behavior to control I/O failures and ordering.
- Browser fixtures: worker reads use fake IndexedDB; `src/ts/diagnostics/tests/collectorMock.ts` is the typed collector
  double. UI panels mount with mocked report/history clients. `src/ts/sw.share.test.ts` covers service-worker record
  writes ([build-test](build-test-platforms.md)).
- Slow: `server/src/tests/diagnosticsCrash.test.ts` starts fresh Node processes; select it through
  [test-harness](test-harness.md).
- E2E: none.
- Not tested: the full viewer/alert flow, production Docker+sftp isolation, pulling and withdrawing a shared job, and
  saving a phone browser report. These manual checks are tracked in the [archive](../archived-plan/README.md).

## Known Hazards

### Issues

- Daily event appends are unsynced, so a power loss can lose recent events; whole-file state, report, and share writes
  flush their staged files before rename.

### Limitations

- Sharing can redact only credentials still stored then; deleted credentials are unavailable. Encoding limits belong to
  [llm-requests](llm-requests.md). Decision: the Request History and Diagnostics plan (`ab11ea9d0`,
  [archive](../archived-plan/README.md)).
- Auxiliary `/proxy2` operations are outside durable LLM history; failures can appear as checked HTTP diagnostics. A
  plugin iframe's runtime faults are outside the window collector. Decision: Out of scope of the Request History and
  Diagnostics plan (`ab11ea9d0`, [archive](../archived-plan/README.md)).
- Reports, shares, and `eventsFor`'s day-file reads are synchronous: a 32 MiB share's writes and fsync run on the
  serving thread. Folder write failures leave in-memory diagnostics available. A client timeout after report dispatch
  can leave a successfully saved file. Decision: a share stays one synchronous step, since an await inside it lets a
  withdrawal be undone; asynchronous copies would need a queue across a whole share
  (`server/src/diagnostics/journal.ts`).
- A process that ends during a queued publication leaves its `.state-*.tmp`; creation does not remove it. Accepted: one
  small file per crash.
