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

- `server/src/data/requestHistory.ts` `createRequestHistory`, `RequestHistory`: the SQLite/WAL store. Its module header
  holds the row lifecycle, bounds, caps, pruning, and failure behavior; the members hold first-wins writes, late
  exchanges, the `seq` cursor, and `readShare`'s snapshot. Wire shapes: `shared/requestHistory.ts`.
- `server/src/llm/historyObserver.ts` `createHistoryObserver`: the per-attempt writer the request layer calls
  ([llm-requests](llm-requests.md)).
- `server/src/diagnostics/log.ts` `logEvent`, `formatLogEvent`, `recordSafely`, `errorFields`: checked failure fields
  and a known error name/application frame, never the message. The fields come from `server/src/jobs/generationJobs.ts`
  `markFailure`/`failureOf`/`errorTerminal`, which keep the nearest site's `stage`, `requestId`, `providerCode`, `code`
  through replacement errors: writes mark `persist`, scripts `script`, requests `request`, and the runner
  (`server/src/prompt/runner.ts`) supplies its current stage when none was marked.
- `server/src/routes/requestHistory.ts` `registerRequestHistoryRoutes`: list, read, "Delete all", share, and shares
  list; its comment holds the query, the status codes, and the delete order. Client: `src/ts/network/requestHistory.ts`
  (`listRequestHistory`, `readRequestHistory`, `deleteRequestHistory`, `shareRequestHistory`,
  `listRequestHistoryShares`, `RequestHistoryError`).

### Journal, reports, and support copies

- `shared/diagnostics.ts`: the event kinds (`DIAGNOSTIC_EVENT_KINDS`), every phase, reason, and field allowlist with its
  meaning and emitter on its constant, `projectDiagnosticEvent`, `projectBrowserEvent`, `projectServerEvent`,
  `isJobFailureEvent`, `isDiagnosticErrorEvent`, `sanitizeStack`, `ROUTE_TEMPLATES`, and `DiagnosticsState`. Change an
  allowlist with the projection, the emitting source, and focused tests.
- `server/src/diagnostics/journal.ts` `createDiagnosticsJournal`, `DiagnosticsJournal`: the folder, the queued appends
  and state publications on the context's ordered writer ([self-host server](self-host-server.md)), the terminal fence
  of `recordFatal` and `finish`, durability, and the trust rules, in its comment and the members'.
- Server events: `job` from `server/src/jobs/generationJobs.ts` (with `stoppedBy` for another client's stop), `request`
  from `server/src/llm/historyObserver.ts`, `http` from `server/src/app.ts` (error or slow answers), `lifecycle` from
  `server/src/app.ts` and the backup import (`server/src/routes/backupsUpstream.ts`), `runtime` from `log.ts`'s caught
  faults and the two fatal paths of `server/src/main.ts` (`recordFatal`), and `push` from
  `server/src/push/pushService.ts` through `recordSafely`, so a throwing recorder never changes delivery.
- `server/src/diagnostics/share.ts` `createRequestShares`: support copies; its comment holds the copy's content, the
  second redaction, the write/mark/remove order, and why a share is one synchronous step.
- `server/src/routes/diagnostics.ts` `registerDiagnosticsRoutes`: `GET /api/diagnostics` from memory and
  `POST /api/diagnostics/report` through `canonicalDiagnosticReport`.

### Browser

- `src/ts/diagnostics/collector.ts` `startDiagnosticsCollector` (first in `src/boot.ts`), `recordClientEvent`,
  `flushClientDiagnostics`, `clientDiagnosticEvents`: this tab's ring, its `sessionStorage` mirror, the fetch wrapper,
  and the `page`, `runtime`, and `push` `browserState` events. Plugin iframes are another realm and are not covered.
- Browser emitters, which contain no content and record through `recordClientEvent` (`bootCache` through its injected
  `report`; phase meanings on the `shared/diagnostics.ts` constants):
  - `jobLink`: `src/ts/network/generationJobs.ts` and `src/ts/process/serverCommands.ts`; `feed`:
    `src/ts/network/eventFeed.ts`; the stale and connect deadlines are in `src/ts/network/socketLiveness.ts`.
  - `sync`: `src/ts/storage/resourceSync.svelte.ts` (conflict, restore reload, `saveWait`), `src/ts/bootstrap.ts`
    (service-worker reload), `src/ts/storage/draftJournal.ts`, and `src/ts/storage/journalRecovery.ts`.
  - `serviceWorker`: `src/ts/bootstrap.ts`; `bootCache`: `src/ts/storage/bootCache.ts`, whose owner is
    [resource-sync](resource-sync.md).
  - `notice`: beside its alert in `serverCommands.ts` `reportEnd` and `recoverJobChat` and `resourceSync.svelte.ts`
    `showReloadedNotice`; per failed call in `src/ts/parser/transformClient.ts` `serverProcessScript`, beside a batch's
    one toast.
  - `push`: `src/ts/network/pushNotifications.ts` (`dismissedByPage`), `serverCommands.ts` `refreshChatAfterPush`
    (`chatRefresh`), and the service worker's records of its display decision (`public/sw.js` `showPushNow`), which only
    the report reads.
- `src/ts/diagnostics/report.ts` `createDiagnosticReport`, `readServerDiagnostics`, `saveDiagnosticReport`;
  `src/ts/diagnostics/workerRecords.ts` `readWorkerRecords`; `shared/diagnosticsReport.ts` `buildDiagnosticReport`,
  `canonicalDiagnosticReport`, `projectDiagnosticsState` (the v1 format in its header);
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`: Settings → Advanced → Developer & diagnostics.
- `src/ts/diagnostics/jobDebugInfo.ts` `jobDebugInfo`: the "Copy debug info" text of a failure alert.
- `src/lib/Others/RequestLogs/RequestLogsPopup.svelte` (`alertRequestLogs`): Server history and This tab tabs and the
  retained job filter. `src/lib/Others/RequestLogs/ServerRequestHistory.svelte`: the durable viewer and sharing.
  `src/lib/Others/RequestLogs/TabRequestLogs.svelte`, `src/lib/Others/RequestLogs/LogField.svelte`,
  `src/lib/Others/RequestLogs/requestLogView.ts`: this tab's `getFetchLogs` view.

## Flows

- Each admitted `start`/`runInJob` attempt starts a history row through `createHistoryObserver`; retries have separate
  request ids under the same job. Exchanges and the outcome complete it. Tab requests also retain their separate `log`
  events; plugins' `getFetchLogs` still sees only that tab's in-memory list.
- A checked failure reaches `alertJobError` (`src/ts/alert.ts`): Copy debug info (`jobDebugInfo`, from
  `src/lib/Others/AlertComp.svelte`) holds checked ids, time, version, build id, status, reason, stage, and provider
  code, never the message; Open in request history filters the viewer to its job ([chat-pipeline](chat-pipeline.md)).
- Server events enter the journal; browser events stay local until the user saves a combined report. Copy and Download
  remain local. Save writes the shown report.
- A Web Push completion crosses three records: the server's `push` event per subscription in the journal, the service
  worker's records in IndexedDB, and the page's `dismissedByPage` or `chatRefresh`; only a combined report puts them
  side by side.
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
  epoch/maintenance gate. Unavailable history returns 503 to row reads and writes after authentication (the shares list
  reads only the folder); writes recheck shutdown immediately before committing.
- Preserve checked filenames, regular-file checks, and child-path symlink refusal. The configured diagnostics root
  itself may be a symlink or mount. Created directories/files use 0750/0640. Symlinked/non-directory `events`,
  `reports`, or `shared` are refused; event handles use `O_NOFOLLOW | O_NONBLOCK` plus `fstat`, on the queued and the
  synchronous append alike. State uses temp+rename; state, report, and share temp creation is exclusive and no-follow.
- Nothing may undo or replace bytes after the final state: every step that can runs on the JS thread behind the terminal
  fence, and a fatal fault's event and state are written synchronously. Only a line whose first write was already
  submitted at the fence can still land after them.
- A diagnostics-only sftp account is the support-access boundary: restrict it to this folder and prevent access to
  `save/data/` or the wider `save/`. The app creates no sftp account/chroot. Support copies require explicit user action
  and retain `createRequestShares`' redaction/write/mark/remove ordering.

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
