# Request History and Diagnostics Plan

Status: Phase 1 in progress (slices 1–4 done). Two phases.

- **Phase 1** (slices 1–6): the server keeps every LLM request in a durable
  history, and a failed job says where it failed.
- **Phase 2** (slices 7–10): the server writes content-free diagnostics to a
  folder that the developer pulls over sftp. The browser hands over its side as
  a report the user copies or saves to that folder.

## Why now

Before real use, nothing records why a reply came out the way it did:

- A job's requests (the reply, memory, emotion, IGP, triggers, Lua `LLM`/`axLLM`,
  `internal:aiaccess`) reach the tab as a `requestLog` notice. The tab drops
  it: `src/ts/network/jobChannel.ts`, `case "requestLog"`, only calls
  `console.debug`.
- The translation runner logs nothing (`server/src/translation/runner.ts`,
  `log: () => {}`).
- The server transport logs a streamed response as the text
  `"Streamed Fetch"` (`server/src/llm/transport.ts` `fetchStream`).
- What survives is the tab's own requests (`POST /api/llm/request` `log`
  events → `appendFetchLog`): 20 entries in this tab's memory, no duration, no
  model, no chat.
- A failed job reaches the tab as `{ type: "error", message, status, reason }`
  (`shared/jobs.ts`), with `reason: "failed"` for every runner failure. The
  server logs `console.error("[Generation]", error)` without a job id.

## Reference

`/home/codex/risuai-fastify` shipped both features:

- `935e49a24` durable request history, `19d16c6f0` API metadata, `44fdb5091`
  duration, then the fixes `e8c038044` (byte bounds), `fb28c03a9` (timing),
  `1d0e25890` (secret redaction). `server/fastify/src/requestHistory.ts` and
  `src/lib/Setting/Pages/RequestHistorySettings.svelte`.
- The diagnostics channel (`docs/structure/diagnostics.md` there),
  `src/ts/server/clientDiagnostics.ts` `buildDiagnosticsReport` (the
  "RisuAI diagnostic report" text).

This plan takes the history's shape and byte bounds, and the report's content
policy. It does not take Fastify's remote support channel: no support
credential, no support route, no remote CLI, no browser upload, no SQLite
journal. The sftp folder replaces all of them.

## Product decisions

1. **Full content is captured by default.**
   - The user can turn content capture off in settings.
   - With capture off, the server still writes a summary row: time, source,
     model and profile, status, HTTP status, duration, sizes, and the bounded
     error message. Prompt, request body, headers, and response are not
     stored.
2. **History is cleared only by its caps or by the user.**
   - The caps are a record count (setting) and a total byte size (env). The
     oldest records go first.
   - Restore, import, maintenance, and an epoch change do not touch it.
   - "Delete all" in the viewer, after a confirmation, is the only manual
     clear.
   - History is not in backups, snapshots, or exports.
3. **An agent sees request content only when the user shares it.**
   - The diagnostics folder is content-free, except for what the user shares.
   - Sharing is the only way content leaves the server other than the app's
     own UI.
   - The enforcement is the sftp account: it is chrooted to the diagnostics
     folder. The history database stays in `save/data/`, outside that folder.
     An account that can read `save/` defeats this; the setup notes say so.
4. **The share unit is a job.**
   - "Share for support" on any request of a job shares all of that job's
     requests.
   - A tab request without a job (`POST /api/llm/request` with no
     `channelCall`) is shared alone.
   - A share can be withdrawn; withdrawing deletes the file.
5. **Plugins keep their current scope.** `getFetchLogs` (permission
   `fetchLogs`) still returns this tab's in-memory list only. The durable
   history spans every chat, which is a wider grant than the consent covers.
6. **The browser side is a report, not an upload.** The Diagnostics panel
   builds a content-free report. The user copies it, downloads it, or presses
   "Save to server", which writes it to the diagnostics folder. Nothing is
   sent automatically.
7. **No new auth surface.** The UI routes use the app JWT and the shared
   limiter. The developer pulls the folder over sftp.
8. **The `requestLog` notice is removed.** The server writes the history
   directly. The tab's own requests keep their `log` events for this tab's
   list.
9. **Content-free means**: no message or prompt text, bodies, headers,
   credentials, URLs with a query, free-form error messages, Lua or plugin
   values, or names.
   - It may carry opaque ids (`jobId`, `requestId`, `chaId`, `chatId`,
     `messageId`), enumerations, numbers, booleans, and a provider error code
     matching `^[A-Za-z0-9_.-]{1,64}$` (OpenAI `error.code`, Anthropic
     `error.type`, Google `error.status`).
   - A stack keeps only application file, line, and column.

## Data model

### Request history

The history lives in `save/data/request-history.sqlite`, its own file, like
`save/data/vectors.sqlite` (`server/src/data/vectorCache.ts`). Snapshots copy
only `resources.sqlite` (`server/src/data/snapshots.ts`), so it stays out of
them. Backups read the store and `save/assets/`, so it stays out of those too.

One row per request. A request is one `runInJob` or `start` call, so each
retry of `requestChatDataOuter` (`server/src/llm/outer.ts`), which calls
`runInJob` once per attempt, is its own row with its own id. A job's attempts
share its `jobId`.

- **Identity:** `id` (the request id), `jobId`, `source`, `mode` (the model
  slot), `chaId`, `chatId`, `messageId` where the job knows it.
- **Model:** model id, profile id and name, provider (`LLMFormat` name).
- **Timing and outcome:** `startedAt`, `firstByteAt` (the first byte of the
  response that ended the request, see slice 3), `completedAt`, `status`
  (`pending | success | error | aborted | interrupted`), HTTP status of the
  last exchange, the provider error code, and the error message (redacted,
  64 KiB).
- **Sizes:** request bytes and response bytes.
- **Content** (null when capture is off): `prompt` (the `formated` the request
  layer received, 2 MiB) and `exchanges`. `exchanges` is every transport log
  entry of the request in completion order (tool rounds, a batch's submit, its
  final status poll, and results calls; the Vertex token call is not one: the
  token cache fetches outside the transport and is shared between requests),
  each with URL, header, body, and response. Bounds: 32 exchanges, a body 2 MiB,
  a response 4 MiB, a header 64 KiB.
- **Truncation:** which fields were cut, with original and stored bytes.
- **Sharing:** `sharedAt`.

Caps:

- **Count:** the `requestHistoryLimit` setting (default 1,000, clamped to
  10–10,000).
- **Bytes:** `RISU_REQUEST_HISTORY_MAX_BYTES` (default 512 MiB).
- **Boot:** rows still `pending` become `interrupted`.

`source` is one of `send`, `memory`, `emotion`, `igp`, `trigger`, `lua`, `mcp`,
`translation`, or `tab`.

### Settings fields

Both go in the `providers` section (`shared/sections.ts`), with their
defaults in the server normalizer (D2):

- `requestHistoryContent: boolean`, default `true`.
- `requestHistoryLimit: number`, default `1000`.

The server reads `requestHistoryContent` from the store when a request begins.
`requestHistoryLimit` is read at every prune (the store's `limit` getter), so
lowering it applies to the whole history at the next write.

### Failure fields on the job error event

`{ type: "error" }` in `shared/jobs.ts` gains three optional fields:

- `stage`: `setup | input | assembly | request | script | persist | tail`.
- `requestId`: the request that failed, when it was one.
- `providerCode`: the provider error code (decision 9).

`GenerationRunnerError` carries them, and `errorTerminal`
(`server/src/jobs/generationJobs.ts`) copies them.

### Diagnostics folder

The folder is `RISU_DIAGNOSTICS_DIR`, default `save/diagnostics/`. The server
creates it at boot and never follows a symlink inside it. Directories are
`0750` and files `0640`, so a group can give the sftp user read access.

```
<dir>/
  state.json                    atomic (temp + rename)
  events/YYYY-MM-DD.jsonl       content-free events, appended
  shared/<stamp>-<id>.json      what the user shared (decision 4)
  reports/<stamp>-<rand>.txt    browser reports saved from the panel
```

- **`events/`:** `RISU_DIAGNOSTICS_MAX_BYTES` (default 64 MiB) caps
  `events/`. The oldest day file is deleted first.
- **`reports/`:** the last 50 are kept.
- **Write failures:** a failed write never fails the app. It is counted in
  `state.json` and logged once.

Event kinds are a closed list in `shared/diagnostics.ts`, with an exact-key
projection:

- `http`: method, route template, status, duration. Only for a status of 400
  or more, or a duration over 5 s.
- `job`: accepted, done, error (`stage`, `reason`, `status`), duration.
- `request`: `requestId`, `jobId`, `source`, provider, model id, HTTP status,
  `providerCode`, duration, bytes.
- `script`: a Lua, regex, or trigger failure: kind, stage, error class.
- `runtime`: an uncaught exception or unhandled rejection: name and sanitized
  stack.
- `lifecycle`: boot, shutdown, maintenance start and end, restore and import
  done.

`state.json` is written at boot, every 10 minutes, and after an error event
(debounced to 5 s). It holds:

- `version.json` and the Node version
- platform, uptime, and start time
- the two settings fields
- history count and bytes, and the journal's bytes and write-failure count
- worker pool stats (`stats()`) and the live job count
- the last 20 `job` error events

## Slices

### Phase 1: request history and structured failures

#### 1. Request identity, source, and timing

- `services.request(arg, mode, ctx)` (`server/src/lua/bindings.ts`) takes a
  `source`. Each caller passes its own:
  - `server/src/prompt/runner.ts`: the reply, memory, IGP, and emotion requests
  - `server/src/prompt/triggers.ts`: trigger `runLLM`
  - the Lua host functions
  - `server/src/mcp/internal.ts`: `internal:aiaccess`
- `JobRequestSpec` (`server/src/llm/requests.ts`) gains `source` and the chat
  ref. `runInJob` already makes a request `id`: it becomes the `requestId`.
- The translation runner passes `source: "translation"`, and a tab request
  (`start`) is `source: "tab"`.
- The request layer records `startedAt`, `firstByteAt` (the first byte of a
  streamed body or a buffered answer), and `completedAt`.
- Tests: each caller's source reaches the spec.

#### 2. The history store

- Add `server/src/data/requestHistory.ts`:
  `createRequestHistory({ file, maxBytes, now, limit })`. `limit` is a getter
  for the count cap, read at every prune.
  - `begin(summary)`: inserts a `pending` row (no return; later calls key by
    request id).
  - `describe(id, model)`: fills the model of a pending row (a tab's request
    resolves it after it began).
  - `firstByte(id, at)`: the first one wins.
  - `exchange(id, entry, cuts?)`: appends a transport log entry. `cuts` carries
    the original bytes of fields the caller already cut (the stream tee). The
    first 32 exchanges are kept; later ones are only counted.
  - `finish(id, outcome)`: the first one wins.
  - `list({ cursor, limit, chaId, chatId, jobId, status })`: summaries only (no
    content, no error text).
  - `get(id)`
  - `deleteAll()`
  - `setShared(ids, at | null)`
  - `prune(limit)`, `stats()`, `close()`
- Writes are synchronous `node:sqlite` statements, as in `vectorCache.ts`.
  Field bounds and truncation records follow the data model; display fields
  (model, provider, provider code) are bounded at 1 KiB, and an id is never
  cut (over 2 KiB it is not stored). Every write prunes: the oldest rows by
  begin order go first, a pending one included (later writes to it are
  skipped). The store never throws to its caller.
- Wire it in `createServerContext` (`server/src/app.ts`). Dispose it at
  shutdown.
- Tests: the field bounds and truncation records, the count and byte pruning
  (oldest first), the boot sweep to `interrupted`, the summary-only row when
  content is off, `list` paging and filters, reopening, and the 33rd exchange.

#### 3. Capture

- `buildContext`'s `log` sink in `createLlmRequests` writes `exchange` for both
  `start` and `runInJob`. The row begins when the request is admitted and
  finishes with its outcome (answer, fail, abort, or fatal).
- Every content field goes through the request's redactor before the write:
  - `redactLogEntry` for body, header, response, and URL, plus
    `redactHeaderText`
  - the redactor as it is at write time, so a Vertex token acquired
    mid-request is covered
  - the URL query (`?key=`)
- `fetchStream` tees the raw body into the exchange, bounded at 4 MiB, honoring
  `logFetch: false`.
- The first byte is the first byte of the response that ended the request.
  Slice 1 already does this for Horde: its submit acknowledgement and pending
  polls do not count. Anthropic batching (`claudeBatching`,
  `server/src/llm/anthropic.ts`) does not yet: its submit and status calls go
  through the observed transport, so `firstByteAt` is the acknowledgement.
  - `StreamFetchArgs` gains a per-call `firstByte?: boolean` (default `true`).
    `false` leaves that call's response unobserved.
  - The batch's submit, status, and cancel calls pass `false`. The results
    call keeps the default.
  - A refused submit (not 200) or a failed status poll ends the request, so it
    marks its first byte, as Horde's refused submit does.
- Horde: check `typeof json.id === "string"` inside the submit's `try`, so a
  malformed id ends the request through the existing `catch` and keeps its
  first byte (today it throws outside the `try` while building the poll URL).
- The translation runner's requests are `runInJob` requests, so the layer
  captures them; it needs no `log` of its own (removed with `JobRequestSpec.log`).
- The prompt is redacted like every other content field (serialized, then the
  request's redactor), once the redactor exists, through the store's
  `setPrompt`.
- The provider error code stays null until slice 6.
- Horde, local Ollama, OobaLegacy's WebSocket stream, WebLLM, and plugin
  providers fetch outside the transport: their rows carry the prompt and
  summary, no exchanges.
- Remove the `requestLog` notice: the kind in `shared/jobs.ts`, the send in
  `bindings.ts`, and the client case.
- Tests (server, injected fetch):
  - A secret never reaches the database, in body, header, URL, response, or
    error. Cases: OpenAI bearer, Anthropic `x-api-key`, Gemini `?key=`, a
    Vertex token acquired mid-request, a named API key, and AWS SigV4 headers.
  - A streamed response is stored, and cut at the bound.
  - A tool round produces two exchanges in one row.
  - A retry produces two rows with the same `jobId`, each with its own
    exchanges.
  - An Anthropic batch's `firstByteAt` is its results response, not the
    submit acknowledgement or a pending status poll.
  - An aborted job's request ends `aborted`.

#### 4. Routes and settings

- Add `server/src/routes/requestHistory.ts`. It uses the same JWT check and
  limiter as `registerLlmSecretRoutes`, and answers with
  `Cache-Control: no-store`. It is not a resource: no epoch, no maintenance
  gate.
  - `GET /api/request-history?cursor&limit&chaId&chatId&jobId&status`:
    summaries. An empty parameter is absent; a malformed cursor, page size,
    or status is a 400.
  - `GET /api/request-history/:id`: one row with its content.
  - `DELETE /api/request-history`: deletes all rows. Answers 204, or 500 when
    the delete failed (`deleteAll` answers null).
  - Each answers 503 while the store is unavailable (`available()`), checked
    after the JWT. The admission middleware refuses them during shutdown and
    sets `no-store` on every answer, a 429 or 413 included.
- Add `requestHistoryContent` and `requestHistoryLimit` with their normalizer
  defaults and `shared/sections.ts` entries. The server reads them where they
  apply: content when a request begins (a read that throws counts as off), the
  cap at every prune (a read that throws skips that prune). A record without
  them reads as the defaults.
- Tests: JWT required, paging, filters, a missing id (404), delete all, the
  two settings, and the fresh-boot fixture.

#### 5. The viewer

- The `requestlogs` popup (`src/lib/Others/AlertComp.svelte`) becomes the
  server history.
  - The list shows time, source, model, status, duration, and the chat's
    name.
  - A filter shows "this chat" only.
  - A retried request's attempts are separate rows; the job filter
    (`jobId`) shows them together.
  - A row expands to load its detail. Prompt, body, and response each get a
    copy button, and truncation is marked.
  - A second tab, "This tab", shows the tab's browser-only requests (plugin
    provider, WebLLM) from `fetchLog`.
  - "Delete all" asks `alertConfirm` first.
- Entry points stay the same: the hotkey (`src/ts/hotkey.ts`), the Settings
  export button (`SettingsExportButtons.svelte`, which today renders
  `getRequestLog()`), and the DevTool.
- Settings → Advanced gets two items: "Store request content" (with a `Help`
  key that says what is stored and where) and "Request history size".
- Add the English and Korean strings.
- `getFetchLogs` for plugins is unchanged (decision 5).

#### 6. Structured failures

- Add the `stage`, `requestId`, and `providerCode` fields from the data model.
  - The runner sets `stage` where it already knows it.
  - The request layer parses `providerCode` from the provider's error body.
- Add `server/src/diagnostics/log.ts` `logEvent(kind, fields)`. In phase 1 it
  writes one console line, `[Generation] job=<id> request=<id> stage=<stage> …`.
  In phase 2 it also writes the journal. It replaces the bare
  `console.error("[Generation]", error)` sites in `generationJobs.ts` and
  `runner.ts`.
- The tab's job error alert gets two actions:
  - "Copy debug info": a content-free block with version, time, `jobId`,
    `requestId`, `stage`, `status`, `reason`, and `providerCode`.
  - "Open in request history": the viewer, filtered to the job.
- Tests: each stage reaches the error event, and the copied block holds no
  message text.

### Phase 2: diagnostics folder and report

#### 7. The journal and `state.json`

- Add `shared/diagnostics.ts`: the event kinds, the exact-key projection, the
  stack sanitizer, and the provider-code pattern.
- Add `server/src/diagnostics/journal.ts`
  `createDiagnosticsJournal({ dir, maxBytes, now })`:
  - `record(event)`: projects the event, appends it to the day file, and keeps
    a 300-event in-memory ring.
  - `state(update)`
  - `recent()`
  - day rotation, byte pruning, the write-failure counter, and the
    `state.json` writer
- `logEvent` records to it. Add hooks for the `http` events (a Hono
  middleware), `process` `uncaughtException` and `unhandledRejection`, and the
  lifecycle points in `app.ts`.
- Tests: projection drops unknown keys and free text, rotation and pruning,
  `state.json` atomicity, a read-only folder does not break a job.

#### 8. Server read route and browser collector

- Add `GET /api/diagnostics` (JWT, limiter, `no-store`): the ring and a
  `state` summary.
- Add `src/ts/diagnostics/collector.ts`:
  - A 300-entry ring, mirrored to `sessionStorage` best effort; every access
    is wrapped in `try/catch`.
  - Same-origin API fetch failures, with route template, status, and
    duration. Bodies are never read.
  - Global errors and rejections: name and sanitized stack.
  - Job attach, detach, and reattach.
  - Resource sync conflicts and reloads.
  - Live feed reconnects.
  - Service worker state.
  - Visibility and online changes.
- The collector starts in `src/boot.ts`, before bootstrap.
- Tests: the same projection rules on the client, the ring bound, and a
  `sessionStorage` throw.

#### 9. The Diagnostics panel and report

- Add Settings → Advanced → Diagnostics.
- The report text:
  - Header: `Metatron diagnostic report v1`.
  - Version, browser and OS family, online state, viewport, export time.
  - The content policy line.
  - The server state summary, then the browser and server events merged by
    time and marked by source.
- Buttons: Copy, Download, and "Save to server".
  - "Save to server" sends `POST /api/diagnostics/report` (JWT, limiter, 1 MiB
    body).
  - The server accepts only text that starts with the report header, and
    writes `reports/<stamp>-<rand>.txt`.
- Add the English and Korean strings.
- Tests: the report holds no free text from any event, and the route refuses
  a body over the bound or without the header.

#### 10. Sharing to the folder

- Add `PUT /api/request-history/share`, body `{ jobId | requestId, shared }`.
  - **Sharing** writes `shared/<stamp>-<jobId|requestId>.json` with temp and
    rename. The file holds:
    - the job's rows with their content, redacted again at write
    - the job's journal events and its failure fields
  - **Withdrawing** deletes the file.
  - Both set or clear `sharedAt`.
- With content capture off, the file holds the summaries only.
- The viewer gets a "Share for support" switch per job group. A shared row is
  marked.
- `state.json` counts the shared files.
- Tests: the job grouping, withdrawal deletes the file, a second redaction
  pass, and no write outside `shared/`.

## Tests

- `server/src/tests/requestHistory.test.ts`: slices 2–4 and 10.
- Redaction cases in `server/src/tests/llmRequests.test.ts`: slice 3.
- Failure fields in the job tests (`server/src/tests/` next to the existing
  `generationJobs` and runner coverage): slice 6.
- `server/src/tests/diagnostics.test.ts`: slices 7–9.
- `shared/diagnostics.test.ts`: the projection and sanitizer.
- `src/ts/diagnostics/collector.test.ts`: slice 8.
- The viewer and panel are checked by hand (below).

## Manual verification

- A reply, a reroll, a Lua `LLM` call, a trigger `runLLM`, an aiaccess call,
  and a server translation each show one row with the right source, chat,
  duration, and full streamed response.
- Turn content capture off: new rows are summaries only, and old rows keep
  their content.
- Fail a request (bad key, unreachable URL, provider 429): the alert's debug
  info names the stage and request, and the row shows the error and
  `providerCode`.
- Restore a backup: the history is unchanged.
- Docker on the production layout, with an sftp user chrooted to the
  diagnostics folder:
  - The user can read `state.json`, `events/`, `reports/`, and `shared/`, and
    nothing in `save/data/`.
  - Share a job and pull its file. Withdraw the share, and the file is gone.
  - Save a report from a phone browser and pull it.

## Out of scope

- The auxiliary `/proxy2` operations (TTS, image generation, Whisper,
  embeddings, model lists) in the history. Their failures appear only as
  `http` events.
- Automatic browser upload, a remote support route or credential, and a
  persistent browser journal.
- Replaying a stored request, and text search over the history.
- Plugin access to the durable history.
- Exporting history other than by sharing.

## Docs to update with the change

- `docs/structure/self-host-server.md`: the history and diagnostics routes,
  `save/data/request-history.sqlite`, the diagnostics folder, the env vars,
  `logEvent`, and the sftp setup notes (chroot, group read, the warning in
  decision 3).
- `docs/structure/llm-requests.md`: capture, `source`, the stream tee,
  redaction at write, and `providerCode`.
- `docs/structure/chat-pipeline.md`: the error event's new fields and the
  alert's actions.
- `docs/structure/global-api.md`: the `requestLog` notice is removed, and
  `fetchLog` is this tab's list only.
- `docs/structure/plugins-mcp.md`: the scope of `getFetchLogs`.
- `docs/structure/persistence.md` and `settings-i18n.md`: the two settings
  fields and their items.
- `docs/structure/build-test-platforms.md`: the new tests.
