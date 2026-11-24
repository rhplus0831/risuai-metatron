# Bounded Client Waits Plan

Status: second draft, 2026-11-24 at `5fced8637`; held. Its full audit
([report](../reports/audits/plan-runner/bounded-client-waits-2026-11-24.md), which also holds the first draft's) found
3 P1: an import that streams keepalives can no longer answer a late refusal as an HTTP error (B01), a delayed Web Push
PUT can undo a newer DELETE on the server (B02), and the asset write and preview have silent server work longer than
their allowance (B03); and 9 P2. The owner decides the scope before a revision. The first draft (at `719b2d877`) failed
its audit with 5 P1; the owner then moved the Timeline, plugin permission refresh, MCP OAuth, shutdown order, and the
server capacity checks to a batch round (`/home/codex/review-reports/waits-batch-2026-11-24/`), which landed, and this
plan keeps the six waits that need a new server read, a progress signal, or a per-feature design.

Sources: the [known issues](../backlog/known-issues.md) entries under chat-store (checkpoints), memory (memory tasks),
characters-modules and backup-sync-hub (imports), assets, translation (rendered), and network-jobs (Web Push), read at
`5fced8637`; the reproduction round of 2026-11-24 (`/home/codex/review-reports/found-issues-repro-2026-11-24/`:
`reports/client.md`, `probes/` by repository path); the first draft's audit. Identifiers are the anchors; re-verify
each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A tab-side action whose network answer never comes ends within a bound, frees what it held, and leaves the tab able to
retry without replaying work that may already have landed.

- Each of the six waits below gets a bound, or a cancel the user can reach, that a healthy slow operation does not
  meet.
- A write that may have committed before its answer was lost is reconciled by a read, or by an idempotent repeat,
  before the same action is offered again.
- The user's own time (a password prompt, a file picker, a confirmation) stays outside every timer.

Not goals: the batch round's items; the waits on a stalled local file step (Limitations, `719b2d877`); the save loop
(Bounded Resource Writes, archived); resumable uploads; changing a concurrency limit (ten translation permits, four
previews, ten asset writes).

## Current State

Evidence labels: **reproduced** (a held answer and ten minutes of fake time, at `4c84cd229`), **traced** (source
reading only, by the reproduction round or the audit).

- **Checkpoints** (reproduced). `loadCheckpoint` holds the tab-wide `checkpointLoadBusy` through preparation, the
  request, and the chat read; `chatRequest` awaits `authFetch` and the JSON body with no deadline (preparation has its
  own bound, `chatRequest.ts` ~94). Restore and Save As check that one flag in every chat; the dialog's local `pending`
  protects only the mounted instance, and Escape (`hotkey.ts` ~595) reads the tab-wide flag. A success or a recognized
  lost answer triggers the chat read, which has its own 60 s bound (`chatStore.svelte.ts` ~703) and catches failure.
  Chat trash (`chatTrash.ts` ~53) uses the same request helper (traced).
- **Memory tasks** (reproduced). Start (POST) and Cancel (DELETE) share one request slot per character and chat, held
  until fetch and body settle. No route reads a chat's task state: the tab learns it from the feed, whose hello
  snapshot carries effective statuses but not a manual start waiting for the next send (`pendingManual`), and
  `noteMemoryTaskListing` consumes chat revisions. The request's `current()` check tests only the tab lifetime
  (traced, audit A3).
- **Import transport** (reproduced for the client wait; the phases traced by the audit, A2). `serverImportClient`
  waits for headers and the NDJSON body to its end. Silent phases a healthy import has:
  - module and file-backed CharX: upload spooled and validated before headers; module's final claim pass and a
    CharX entry's read, inflate, and write emit no line;
  - Realm prepare: the tab sends `{ id }`, the server downloads and validates the card before its single result
    line (the server's own upstream idle timer is 60 s);
  - Realm commit: PNG chunk copies and the final image publication emit no line;
  - upstream backup prepare: archive planning precedes headers; a long decode or asset step has no heartbeat.
    The tab adds a module or character only from a usable result; Realm and backup prepare leave staged data that
    expires; a backup is replaced only by a separate commit (traced, A6).
- **Asset writes and previews** (reproduced for the queues). `/api/write` answers one JSON acknowledgement after
  durable publication, silent before headers; `assetClient.ts` retries a write up to eight times (~29, ~138), and the
  ten-slot queue frees an item in `finally` (`assetQueue.ts` ~209). Storage-report previews (four slots,
  `assetLifecycleClient.ts` ~65) await one `response.blob()` after the server prepares the thumbnail before headers
  and then streams it with `Content-Length` (traced, A16).
- **Rendered translation** (reproduced for the permit path). Ten permits for new non-LLM work; a producer keeps its
  permit until its work settles, can warm the pair cache after subscribers leave, and a render can join work the
  composer started without a permit. Rendered LLM translation (`translateRenderedLLM`) takes no permit and has its own
  shared requests and cache-generation checks; a Google error makes the row retry twice before showing source text
  (`ChatBody.svelte` ~455) (traced, A10).
- **Web Push** (reproduced). Reconciliation and Enable or Disable share one queue; with Web Locks a unit holds the
  origin's `risu-push` lock across tabs. The server has a key GET and a subscription PUT (register) and DELETE (by
  endpoint), each answering 204; no read of a subscription. Reconciliation can skip PUT for 24 h by a local stamp,
  retries a recorded pending DELETE, falls back to a cached key, and catches a removal failure (traced, A4).

Bounds to reuse: `readWithDeadline` (aborts a signal and rejects at its bound); `waitForResourceFlush` (30 s); the
Bounded Resource Writes first-attempt allowance (45 s plus the request body at 32 KiB/s, `resourceClient.ts` ~479);
the batch round's rule that a bound starts after `ensureAuth()`.

## Decisions

### One rule for a bounded wait

- **D1. A small JSON request gets 30 s** (Q1), covering the fetch and its body read. The clock starts after
  `await ensureAuth()`: sign-in keeps its own 20 s machine-step bounds, and the password prompt is the user's time
  (audit A1). A request that never left (`authFetch`'s `beforeDispatch` not reached) is reported as unsent, not as a
  lost answer.
- **D2. A transfer gets an allowance before headers and an idle bound after them** (Q1). Before headers: 45 s plus
  the request body at 32 KiB/s. After headers: 60 s with no new chunk ends it; every chunk resets it, a partial NDJSON
  line included (`serverImportClient.ts` ~156 already sees chunk boundaries). The existing end-of-stream and
  trailing-line checks stay.
- **D3. A healthy silent phase is made observable, not timed out.** Where the server works before or between lines,
  it sends headers at once and a keepalive line at least every 15 s (D8). No bound in this plan is shorter than a
  phase the tab cannot observe.
- **D4. At the bound the caller frees what it holds** (a flag, a queue unit, a permit, a slot, a Web Lock), and a late
  answer of the abandoned request installs nothing: each request carries a token, and an answer whose token is not
  the live one, or that is older than a newer feed observation of the same state, is dropped.
- **D5. A write that may have landed is reconciled before it is offered again**: by a read where one exists or is
  added (D6, D7), or by an idempotent repeat (D11).

### Per feature

- **D6. Checkpoints: two guards.** The tab-wide `checkpointLoadBusy` covers only the live request (Close and Escape);
  a per-chat reconciliation guard, kept in the module (not the dialog, so it survives a remount), covers Restore and
  Save As of that chat. At the D1 bound the tab-wide guard is released and other chats are free at once; the chat
  stays guarded while the existing chat read (Restore) or the checkpoint list read (Save As) runs. Three outcomes are
  told apart in the dialog: unsent (plain failure, retry allowed), confirmed with the refresh pending, and unknown. If
  the reconciling read fails, the chat stays guarded and the dialog offers **Check again**, which reruns only the read;
  Restore is never replayed by it. The bound is an option of the request helper, off for chat trash.
- **D7. Memory tasks: a per-chat state read.** A new authenticated GET returns, for one character and chat, the
  service's `status(ref)` and `pendingManual(ref)`, checked against the resource epoch. Start and Cancel take D1; at
  the bound the slot frees for other chats, and the same chat's controls wait for this read (D1 too). Its answer
  installs only under D4's rules. If the read times out as well, the controls show an unknown state with a Retry that
  reruns only the read.
- **D8. Import keepalives.** A tab that sends `risu-import-keepalive: 1` gets headers at once and a
  `{"type":"keepalive"}` line at least every 15 s from module, CharX, Realm prepare and commit (PNG included), and
  upstream backup prepare, until its result line; a request without the header gets today's stream (older tabs).
  The tab ignores keepalive lines apart from resetting D2's idle bound.
- **D9. Import failure text by route** (audit A6): a module, CharX, or Realm import ended before its result says that
  nothing was added and the import can be retried; a Realm or backup prepare ended early says the prepared data
  expires by itself; only an uncertain backup **commit** says to reload and check whether the backup was restored.
  Existing interruption messages are reused where they already say this.
- **D10. Asset writes and previews.** A write takes D2's pre-header allowance per attempt; an attempt that expires
  aborts the retry loop for that item (no retry behind a newly admitted item), and the queue's existing failure path
  runs. A preview reads its body through a reader with D2's bounds; a timed-out preview frees its slot, and the
  explicit release and late object-URL guard stay.
- **D11. Web Push: idempotent repeat, not a new read** (Q3). PUT and DELETE by endpoint are idempotent on the server
  (the slice confirms it first and stops if not). Each Enable or Disable records its intent with a generation number
  before its request; at the D1 bound the unit settles, leaves the queue, and releases the Web Lock at once, keeping
  the intent as pending; the next reconciliation repeats the pending PUT or DELETE. A late answer stamps success or
  clears pending evidence only if its generation is still the newest. The key read takes D1, and the cached-key
  fallback stays.
- **D12. Rendered translation, permit path.** Each non-LLM provider request of a rendered translation takes a 60 s
  bound (Q2); at the bound the producer settles as failed and frees its permit; a render that joined the producer gets
  the same failure; a late result does not publish into the pair cache once a newer cache generation exists. The row
  keeps today's retries and its source-text fallback. The LLM path is checked first: if its request is already bounded
  (by the server's job deadline or its own), it is left as it is; otherwise it takes the same 60 s bound and the same
  late-cache rule.

### Limitations

- A request abandoned at its bound may still land; D5's read or repeat reconciles it, and a write the server applies
  after that read is seen at the next read.
- An idle bound does not end a transfer that keeps sending bytes slower than a user would wait for.
- A tab from before D8 gets no keepalives and keeps today's unbounded import wait.

### Questions for the owner

- **Q1. Numbers.** 30 s for a JSON request; 45 s plus 32 KiB/s before headers, 60 s idle after them, keepalive every
  15 s. Proposed as written.
- **Q2. Rendered translation's provider bound.** Proposed 60 s per request (a long message can take tens of seconds on
  a slow provider). Alternative: 30 s.
- **Q3. Web Push recovery.** Proposed: the idempotent repeat (D11), no server change. Alternative: an authenticated
  read of one subscription, which shows the true state at once but adds a route.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guide of each file the slice touches (`pnpm docs:owner <path>`), with
  `pnpm docs:read`.
- The reproduction probes are the starting point for the regression tests: a slice copies the probe describes it
  closes into its worktree and moves the cases into the destination test file its section names (V6: they fail before
  the change). Probe assertions that describe old behavior are replaced, not kept. Probe files are not committed.
- Tests use fake timers and held promises; none waits in real time. Each slice adds a healthy-slow case beside its
  silent case: a phase that is slow but observable is not cut.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`.
- User-visible strings go in `src/lang/en.ts` and `src/lang/ko.ts`, next to the feature's keys (U2).

## Slices

Order: 1 to 5 side by side in separate worktrees (disjoint files, except `src/lang/en.ts` and `ko.ts`, where each adds
keys next to its feature); then 6 on the integrated tree.

### 1. Checkpoints (_medium_)

- `src/ts/checkpoints/chatCheckpoints.svelte.ts`, `src/ts/checkpoints/chatRequest.ts` (an opt-in bound),
  `src/lib/Others/ChatCheckpointsDialog.svelte`, `src/ts/hotkey.ts` (Escape's guard): D1, D4, D5, D6.
- Tests: `src/ts/checkpoints/chatCheckpoints.test.ts`, `src/lib/Others/ChatCheckpointsDialog.test.ts`, from the
  probe `src/lib/Others/checkpointMemoryControls.probe.test.ts` (describe `checkpoint dialog`): another chat's Save As
  after a held restore; the same chat stays guarded across a dialog remount until its read settles; Check again does
  not resend Restore; a late restore answer installs nothing; chat trash keeps its behavior.

### 2. Memory tasks (_medium_)

- `server/src/routes/memoryTasks.ts` (the GET), `src/ts/process/memoryTasks.svelte.ts`, the memory task controls'
  component: D1, D4, D5, D7.
- Tests: `server/src/tests/memoryTasks.test.ts` (the read, its epoch check, `pendingManual`),
  `src/ts/process/memoryTasks.test.ts` from the probe's `manual memory tasks` describe: Cancel after a held Start;
  Start after a held Cancel; a late Start answer older than a feed observation installs nothing; the read timing out
  leaves Retry.

### 3. Import transport and asset writes (_medium_)

- Server: `server/src/http/fileImport.ts`, `server/src/routes/importModule.ts`, `importCharx.ts`, `importRealm.ts`,
  `importPng.ts`, `backupsUpstream.ts` (keepalives behind the header). Tab: `src/ts/storage/serverImportClient.ts`,
  `src/ts/storage/realmImportClient.ts`, `src/ts/drive/upstreamBackupClient.ts`, `src/ts/process/modules.ts` and
  `src/ts/characterCards.ts` (failure text only), `src/ts/storage/assetClient.ts`: D2, D3, D4, D8, D9, D10 (writes).
- Tests: `server/src/tests/importModule.test.ts`, `importCharx.test.ts`, `importRealm.test.ts` (keepalives with and
  without the header); `src/ts/characterCardsRealmImport.test.ts`, `src/ts/storage/tests/assetClient.test.ts`, and
  the client import test the guide names, from the probe `src/ts/storage/tests/pluginImportAssets.probe.test.ts`
  (imports, archive writes, backup prepare): a silent server ends at the bound; a slow import with keepalives is not
  cut; an expired write does not retry.

### 4. Previews and rendered translation (_small_)

- `src/ts/storage/assetLifecycleClient.ts`, `src/ts/translator/translator.ts`: D2, D4, D10 (previews), D12.
- Tests: `src/ts/storage/tests/assetLifecycleClient.test.ts`; a translator test beside `translatorLLM.test.ts`, from
  the probes' preview and `rendered translation` describes: the fifth preview starts after a held body's bound; a late
  preview does not create an object URL; a timed-out producer frees its permit and its joined render fails with it; a
  late result does not publish over a newer cache generation.

### 5. Web Push (_small_)

- `src/ts/network/pushNotifications.ts` (`server/src/routes/push.ts` read only): D1, D4, D5, D11.
- Tests: `src/ts/network/pushNotifications.test.ts`, from the probe's `Web Push` describe: a timed-out unit releases
  the lock for the other tab; the next reconciliation repeats the pending request; a late PUT after a newer Disable
  stamps nothing.

### 6. Close-out (_small_)

Depends on 1 to 5.

- Integrate 1 to 5 and run the whole suite once on the integrated tree (V1), with the type check and format check.
- The guides each slice changed: their Flows and Tests sections, and the Limitations above.
- [known issues](../backlog/known-issues.md): delete each closed bullet.

## Outside this plan

- The batch round's items (Timeline, plugin permission refresh, MCP OAuth, shutdown order, server capacity checks).
- The waits on a stalled local file step (Limitations in self-host-server and server-resources, `719b2d877`).
- Stale whole-field chat writes (the lore popup handback, the PO translator's remove, recovery Apply): the Conditional
  Chat Writes plan.

## Manual Checks

- On a phone with a throttled or interrupted connection: a checkpoint restore, a memory task start, and a module
  import each end with their failure message and leave their controls usable.
- A Realm import of a large card over a slow link completes (keepalives keep it open past 60 s).
- Web Push enabled in two tabs with the server stopped: both tabs' toggles become usable within 30 s, and the
  subscription is registered after the server returns.
