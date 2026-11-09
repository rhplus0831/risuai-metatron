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
  and member comments own row lifecycle, limits, pruning, and failure behavior. Wire shapes: `shared/requestHistory.ts`
  (`RequestHistoryRecord`, `RequestHistorySummary`, `RequestHistoryShareResult`).
- `server/src/llm/historyObserver.ts` `createHistoryObserver`: the per-attempt writer the request layer calls
  ([llm-requests](llm-requests.md)).
- `server/src/diagnostics/log.ts` `logEvent`, `formatLogEvent`, `recordSafely`, `errorFields`: checked failure fields;
  `server/src/jobs/generationJobs.ts` marks the nearest error site, and `server/src/prompt/runner.ts` supplies a stage
  when none was marked.
- `server/src/routes/requestHistory.ts` `registerRequestHistoryRoutes`: list, read, delete, share, and shares list. Its
  comment owns query shapes, status codes, and write order. Client entrypoints in `src/ts/network/requestHistory.ts`:
  `listRequestHistory`, `readRequestHistory`, `deleteRequestHistory`, `shareRequestHistory`, `listRequestHistoryShares`,
  `RequestHistoryError`. The older-copies 500 carries `code` (`REQUEST_HISTORY_SHARE_OLDER_COPIES_REMAIN`); the viewer
  maps by it.

### Journal, reports, and support copies

- `shared/diagnostics.ts`: event kinds, field allowlists, meanings and emitters, projections, stack checks,
  `DIAGNOSTIC_EVENT_KINDS`, `projectDiagnosticEvent`, `projectBrowserEvent`, `projectServerEvent`, `isJobFailureEvent`,
  `isDiagnosticErrorEvent`, `sanitizeStack`, `ROUTE_TEMPLATES`, and `DiagnosticsState`.
- `server/src/diagnostics/journal.ts` `createDiagnosticsJournal`, `DiagnosticsJournal`: the folder, queued writes, state
  publications, terminal fence, durability, and trust rules; its contract also covers the server's event ring.
- Server emitters: jobs in `server/src/jobs/generationJobs.ts`, requests in `server/src/llm/historyObserver.ts`,
  HTTP/lifecycle in `server/src/app.ts` and `server/src/routes/backupsUpstream.ts`, runtime in
  `server/src/diagnostics/log.ts` and `server/src/main.ts`, and push in `server/src/push/pushService.ts`.
- `server/src/diagnostics/share.ts` `createRequestShares`: support-copy content, redaction, ordering, and synchronous
  lifetime.
- `server/src/routes/diagnostics.ts` `registerDiagnosticsRoutes`: `GET /api/diagnostics` reads memory;
  `POST /api/diagnostics/report` accepts `canonicalDiagnosticReport`.

### Browser

- `src/ts/diagnostics/collector.ts` `startDiagnosticsCollector` (first in `src/boot.ts`), `recordClientEvent`,
  `flushClientDiagnostics`, `clientDiagnosticEvents`: this tab's ring, session mirror, fetch wrapper, and window
  listeners. Plugin iframes are another realm and are not covered.
- Browser emitters record through `recordClientEvent` (`bootCache` uses its injected `report`; event meanings are on
  `shared/diagnostics.ts` constants):
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
  `canonicalDiagnosticReport`, `projectDiagnosticsState` own the report format and projections;
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte` is Settings → Advanced → Developer & diagnostics.
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

- `save/data/request-history.sqlite` is separate from resources and survives restore/import/maintenance. Content capture
  is on by default; a missing `providers.requestHistoryContent` field reads as on, while `false` applies to new rows.
  The row/count/byte bounds and pruning behavior are documented by `server/src/data/requestHistory.ts`;
  `server/src/app.ts` wires `RISU_REQUEST_HISTORY_MAX_BYTES` and the provider settings.
- The diagnostics root defaults to `save/diagnostics/`; `RISU_DIAGNOSTICS_DIR` is resolved against `rootDir`, so an
  absolute path or `..` can place it elsewhere. `RISU_DIAGNOSTICS_MAX_BYTES` caps `events/` at 64 MiB by default; ring
  size, state schedule, and the `state.json`, `reports/`, and `shared/` file rules are in
  `server/src/diagnostics/journal.ts`; share schema and ordering are in `server/src/diagnostics/share.ts`.
- Browser storage contracts are in `src/ts/diagnostics/collector.ts` and `src/ts/diagnostics/workerRecords.ts`;
  `public/sw.js` writes the push records that reports read.

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
- Diagnostics routes use app JWT, the shared limiter, `no-store`, and shutdown admission; they are not resources and
  have no epoch/maintenance gate. History availability checks and write rechecks are in
  `server/src/routes/requestHistory.ts`.
- Preserve the journal's checked filenames, regular-file and symlink rules, modes, and no-follow opens. The configured
  diagnostics root may itself be a symlink or mount; the child folders are guarded by `createDiagnosticsJournal`.
- The final state is behind a terminal fence: `recordFatal` and `finish` order queued writes before publication, with
  fatal recording synchronous. See the journal contract before changing shutdown or write ordering.
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
  Request history uses real SQLite; journal tests use temporary directories and injected filesystem/writer behavior to
  control I/O failures and ordering.
- Browser Vitest:
  `pnpm --silent test:agent src/ts/diagnostics src/ts/network/{pushNotifications,generationJobs}.test.ts src/ts/process/serverCommands.test.ts src/ts/storage/tests/resourceSyncDiagnostics.test.ts`.
  Worker reads use fake IndexedDB; `src/ts/diagnostics/tests/collectorMock.ts` is the typed collector double.
  `src/ts/sw.share.test.ts` exercises service-worker push records with fake IndexedDB
  ([build-test](build-test-platforms.md)).
- UI Vitest:
  `pnpm --silent test:agent src/lib/Setting/Pages/Advanced/DiagnosticsPanel.test.ts src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`.
  The panels mount with mocked report/history clients.
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
- Auxiliary `/proxy2` operations are outside durable LLM history; failures can appear as checked HTTP diagnostics.
  Decision: Out of scope of the Request History and Diagnostics plan (`ab11ea9d0`,
  [archive](../archived-plan/README.md)).
- A plugin iframe's runtime faults are outside the window collector. Decision: Out of scope of the Request History and
  Diagnostics plan (`ab11ea9d0`, [archive](../archived-plan/README.md)).
- Reports, shares, and `eventsFor`'s day-file reads are synchronous: a 32 MiB share's writes and fsync run on the
  serving thread. Folder write failures leave in-memory diagnostics available. A client timeout after report dispatch
  can leave a successfully saved file. Decision: a share stays one synchronous step, since an await inside it lets a
  withdrawal be undone; asynchronous copies would need a queue across a whole share
  (`server/src/diagnostics/journal.ts`).

### Gotchas

- The configured diagnostics root may be outside the server root; point the support account at the resolved folder, not
  an assumed `save/diagnostics/` path.
- A process that ends during an atomic state publication can leave a `.state-*.tmp`; creation does not remove it.
