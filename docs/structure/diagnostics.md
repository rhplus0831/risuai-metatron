# Request History and Diagnostics

## Scope

Owns durable LLM request history, checked job failures, content-free server/browser
diagnostics, combined reports, and user-selected support copies. Documentation audit:
2026-10-17. The completed design is in the [plan archive](../archived-plan/README.md).

Paths: `shared/{requestHistory,diagnostics,diagnosticsReport}.ts`,
`server/src/data/requestHistory.ts`, `server/src/diagnostics/`,
`server/src/routes/{requestHistory,diagnostics}.ts`, `src/ts/diagnostics/`,
`src/ts/network/requestHistory.ts`, `src/lib/Others/RequestLogs/`,
`src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`.

The tab's `fetchLog` belongs to [global-api](global-api.md); capture/credential
redaction to [llm-requests](llm-requests.md); startup/auth/disposal to
[self-host-server](self-host-server.md).

## Files

### History and checked failures

- `server/src/data/requestHistory.ts` `createRequestHistory`: SQLite/WAL store.
  `begin`, `setPrompt`, `describe`, `firstByte`, `exchange`, `finish`, `list`, `get`,
  `deleteAll`, `setShared`, `prune`, `stats`, `available`, `close`. First-byte and
  completion writes are first-wins; exchanges after completion can still land.
  `list` returns newest-first summaries with an opaque `seq` cursor. A newer schema
  leaves the file untouched and inert; startup changes pending rows to `interrupted`.
  A failed operation becomes a skipped write or empty read with one warning; a
  transaction whose rollback fails closes the store.
- `server/src/diagnostics/log.ts` `logEvent`, `formatLogEvent`: checked failure
  fields and a known error name/application frame, never its message.
  `generationJobs.ts` `markFailure`/`failureOf`/`errorTerminal` preserve the nearest
  `stage`, `requestId`, `providerCode` through replacement errors. Writes mark
  `persist`, scripts mark `script`, requests mark `request`; the runner supplies its
  current stage when none was marked. A recorder also receives caught runtime faults.
- `server/src/routes/requestHistory.ts` `registerRequestHistoryRoutes`:
  `GET /api/request-history?cursor&limit&chaId&chatId&jobId&status` → `{ items, next }`;
  malformed cursor/size/status → 400. `GET /:id` returns content or 404.
  `DELETE /api/request-history` removes support copies before rows (204; 500 if a
  copy remains or deletion fails). A partial file-removal failure leaves all history
  rows but may already have removed some files; a later database failure leaves
  the rows after all support files were removed. `PUT /share` takes exactly
  `{ jobId | requestId, shared }` (JSON, 4 KiB); `GET /shares` lists copies including
  those whose rows expired. Share failures include 404, 413 over 32 MiB, and 500.

### Journal, reports, and support copies

- `shared/diagnostics.ts`: event/state contracts and exact-key projections.
  `server/src/diagnostics/journal.ts` `createDiagnosticsJournal`: `record`, `recent`,
  `state`, `start`, `writeState`, `close`, `saveReport`, `saveShare`, `commitShare`, `discardShare`,
  `removeShares`, `removeAllShares`, `listShares`, `eventsFor`.
  Events are `http`, `job`, `request`, `runtime`, and `lifecycle`; HTTP events record
  only failures or responses over 5 s, with a registered route template.
  Daily JSONL appends and bounded share/report work are synchronous. Failed appends
  truncate back; a partial final line is separated before the next append.
  Failed writes increment a counter and log the first error code without throwing.
- `server/src/diagnostics/share.ts` `createRequestShares`: `history.readShare` takes
  one transaction snapshot, oldest rows first; content-off rows contribute summaries.
  A share includes matching journal events and the last job error's checked fields.
  `loadStoredSecrets` must succeed before sharing; every string is redacted again,
  headers masked by name, and trailing credential prefixes trimmed from cut fields.
  Replacement order is new file → mark every row → remove older files. A failed mark
  removes the new copy; failed removal keeps the new copy/marks and answers 500.
  Withdrawal removes files before clearing marks; a partial filesystem failure can
  remove some files while leaving marks.
- `server/src/routes/diagnostics.ts` `registerDiagnosticsRoutes`:
  `GET /api/diagnostics` returns `{ events, state }` from memory without a write,
  including during maintenance or a folder-write failure. `POST /api/diagnostics/report`
  accepts text up to 1 MiB only when `canonicalDiagnosticReport` rebuilds it byte for
  byte; invalid text → 400 and is never logged. It checks shutdown again before saving.

### Browser

- `src/ts/diagnostics/collector.ts` `startDiagnosticsCollector`: starts in `boot.ts`
  before app modules. Keeps this window's last 300 checked events; identical recent
  events fold into `repeat`/`lastAt` (last 16 entries, 10-minute window; never boot).
  The session mirror flushes within 1 s, on hide/pagehide, and before app reload;
  restore re-projects entries and accepts at most 512K characters. Its fetch wrapper
  dispatches the original first, once, preserving response/rejection and unhandled
  rejection behavior; only same-origin API/worker/proxy failures become checked
  route-template events. Runtime frames are origin/path checked. Plugin iframes are
  another realm and are not covered.
- Hooks in `generationJobs.ts`, `serverCommands.ts`, `eventFeed.ts`,
  `resourceSync.svelte.ts`, and `bootstrap.ts` report job attachment/retry/loss,
  feed state, sync conflicts/reloads, and service-worker setup. They contain no content.
- `src/ts/diagnostics/report.ts`, `shared/diagnosticsReport.ts`, and
  `DiagnosticsPanel.svelte`: Settings → Advanced → Diagnostics. Read the server for
  at most 10 s; failure still gives the browser report. Merge checked events by time
  (newest 300 per source, oldest omitted beyond 1 MiB); include app version,
  browser/OS family rather than user agent, online/viewport/export time, checked
  server state, and omission counts. Copy/Download/Save act on the report shown.
  Save's 30 s bound covers authentication and dispatch; it never retries.
- `src/lib/Others/RequestLogs/RequestLogsPopup.svelte`: Server history and This tab
  tabs. `ServerRequestHistory.svelte` filters/paginates durable rows, reads details,
  confirms deletion, and shares/updates/withdraws a job or standalone request.
  The popup retains a job filter across tabs; `TabRequestLogs.svelte` reads the bounded in-memory view through
  `getFetchLogs`, `LogField.svelte`, and `requestLogView.ts`. History network access is in `src/ts/network/requestHistory.ts`.

## Flows

- Each admitted `start`/`runInJob` attempt starts a history row through
  `createHistoryObserver`; retries have separate request ids under the same job.
  Exchanges and the outcome complete it. Tab requests also retain their separate
  `log` events; plugins' `getFetchLogs` still sees only that tab's in-memory list.
- A checked failure reaches `alertJobError`: Copy debug info includes checked ids,
  time, version, status, reason, stage, and provider code, never the message; Open in
  request history filters the viewer to its job ([chat-pipeline](chat-pipeline.md)).
- Server events enter the journal; browser events stay local until the user saves
  a combined report. Copy and Download remain local. Save writes the shown report.
- Share for support on any request of a job copies every request in that job; a
  request without a job is copied alone. Update refreshes the snapshot; Withdraw
  removes it. Support deployment must restrict the sftp operator to the diagnostics folder.

## State

- `save/data/request-history.sqlite` is separate from `resources.sqlite` and excluded
  from snapshots/archives. Restore/import/maintenance/epoch changes leave it intact.
  Content capture defaults on; `providers.requestHistoryContent: false` applies only
  to new rows (a failed settings read defaults off). Count limit
  `providers.requestHistoryLimit` is 10–10,000, default 1,000; byte cap
  `RISU_REQUEST_HISTORY_MAX_BYTES` defaults to 512 MiB. Every write prunes oldest
  rows, pending ones included. A failed limit read skips that prune.
- History bounds: prompt/body 2 MiB, response 4 MiB, URL/header/error 64 KiB,
  display fields 1 KiB; ids over 2 KiB are omitted, never cut. First 32 exchanges
  are kept; later ones counted. Truncation is recorded; invalid numbers become null.
- Diagnostics root: `RISU_DIAGNOSTICS_DIR`, resolved lexically with `path.resolve(rootDir, value)`
  (an absolute path or `..` may place it outside that root), default
  `save/diagnostics/`. `events/<UTC day>.jsonl` is capped by
  `RISU_DIAGNOSTICS_MAX_BYTES` (default 64 MiB), pruning oldest days, current day
  included when it alone exceeds the cap. The in-memory ring keeps 300 events.
- `state.json` is replaced atomically: checked version/runtime, uptime, history
  settings/stats, journal bytes/failures, worker counters, live jobs, and last 20
  non-owner-abort failures. Writes occur at creation, every 10 minutes, within 5 s
  of an error, on fatal fault, and after admitted work drains at disposal.
- `reports/<UTC stamp>-<8 hex>.txt`: newest 50 matching regular files retained;
  the new save survives a prune failure. `shared/<UTC stamp>-job-<id>.json` or
  `-request-<id>.json`: explicit request-content snapshots, bounded at 32 MiB of
  stored bytes; leftover share temp files are removed at creation. `shared.files`
  is null when unreadable. Browser mirror key: `sessionStorage` `risu-diagnostics`.

## Coupling

- [LLM requests](llm-requests.md): observer lifecycle, stream capture, source labels,
  provider codes, and redaction before history writes.
- [Self-host server](self-host-server.md): journal lifetime, fatal-fault recording,
  graceful shutdown, auth, limiter, and stores.
- [App shell](app-shell.md): collector startup; [global-api](global-api.md): tab
  logs and job/feed hooks; [build-test](build-test-platforms.md): crash-process tests.

## Invariants

- Content-free events/reports exclude messages, prompts, bodies, headers, credentials,
  names, query URLs, free-form error messages, Lua values, and plugin values.
  Exact-key projection keeps only checked ids, enums, numbers/booleans, bounded
  provider codes, and application frames. Canonical reports must round-trip.
- History is distinct from that journal: it can contain full content and bounded
  redacted error messages even with capture off. Changing capture does not erase
  earlier rows. Plugin consent for the tab log does not grant durable history.
- All UI routes use app JWT, shared limiter, `no-store`, and shutdown admission.
  They are not resources: no epoch/maintenance gate. Unavailable history returns
  503 after authentication; writes recheck shutdown immediately before committing.
- Preserve checked filenames, regular-file checks, and child-path symlink refusal.
  The configured diagnostics root itself may be a symlink or mount. Created
  directories/files use 0750/0640. Symlinked/non-directory `events`, `reports`, or
  `shared` are refused; event handles use `O_NOFOLLOW | O_NONBLOCK` plus `fstat`.
  State uses temp+rename; report/share temp creation is exclusive and no-follow.
- A diagnostics-only sftp account is the support-access boundary: restrict it to
  this folder and prevent access to `save/data/` or the wider `save/`. The app
  creates no sftp account/chroot. Support copies require explicit user action and
  retain the redaction/write/mark/remove ordering above.

## Recipes

- Investigate a failure through the server history's job filter and checked debug
  metadata. Configure capture and row count in Advanced settings.
- Collect a report through Settings → Advanced → Diagnostics → Refresh, then Copy,
  Download, or Save to server. A timeout after dispatch may have saved it already.
- Use Share for support, Update, and Withdraw in the viewer for request content.
  Sharing a job includes its other requests, including memory and auxiliary LLM calls.
- Configure sftp for only the resolved diagnostics directory, with group read access
  compatible with the file modes. In Docker, map the actual diagnostics directory
  and verify the restriction from that account; no production/sftp check was run
  by this documentation audit.
- Add a diagnostic kind/field in shared projection/validation, the emitting source,
  report canonicalization if applicable, and focused tests. Keep raw provider/error
  content out of event fields.

## Tests

- `server/src/tests/requestHistory.test.ts`: real store lifecycle, limits/pruning,
  truncation, content-off rows, interrupted recovery, cursors, and inert schemas.
- `server/src/tests/requestHistoryRoutes.test.ts`: authenticated filters/details,
  settings projection, deletion, unavailable stores, and shutdown admission.
- `server/src/tests/requestShare.test.ts`: stored-secret reads, redaction/cut tails,
  job/standalone snapshots, replacement/withdraw ordering, partial failures,
  expired-row shares, byte caps, and folder boundary checks.
- `server/src/tests/{providerCode,logEvent,requestCapture}.test.ts`: checked provider
  codes/failure fields, message-free events, capture/stream completion. Runner/job
  suites exercise stage propagation; domain owners list them.
- `shared/tests/{diagnostics,diagnosticsReport}.test.ts` and
  `server/src/tests/diagnostics.test.ts`: projection, journal
  retention/state/report/share files, unsafe paths, canonical reports, and admission.
  `server/src/tests/diagnosticsCrash.test.ts` covers fatal faults in fresh Node
  processes and is slow; select it through [build-test](build-test-platforms.md).
- `src/ts/diagnostics/{collector,report}.test.ts`: ring/mirror/fetch-wrapper behavior,
  checked stacks, server-unavailable reports, bounded reads/saves, ambiguous timeout.
- `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.test.ts` and
  `src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`: mounted report controls,
  displayed-report actions, support share/update/withdraw and retry state.
- `src/ts/network/generationJobs.test.ts`: checked job-link events;
  `src/ts/diagnostics/jobDebugInfo.test.ts`: copied metadata excludes the message.

Manual follow-ups: full viewer/alert flow, production Docker+sftp isolation, pull a
shared job then withdraw it, and save a phone browser report. These remain pending
in the [archive](../archived-plan/README.md); this audit does not claim those results.

## Known Hazards

- Sharing can redact only credentials still stored then; deleted credentials are
  unavailable. Encoding limits belong to [llm-requests](llm-requests.md).
- Auxiliary `/proxy2` operations are outside durable LLM history; failures can appear
  as checked HTTP diagnostics. A plugin iframe's runtime faults are outside the
  window collector.
- Journal/share work is synchronous. Folder write failures leave in-memory diagnostics
  available. A client timeout after report dispatch can leave a successfully saved file.
