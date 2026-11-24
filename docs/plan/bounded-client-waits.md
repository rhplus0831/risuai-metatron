# Bounded Client Waits Plan

Status: third draft, 2026-11-24, reshaped after the second draft's full audit
([report](../reports/audits/plan-runner/bounded-client-waits-2026-11-24.md), which also holds the first draft's): 3 P1
and 9 P2. A Claude Fable review then judged each wait and finding by how an ordinary user reaches it and what a fix
costs, and the owner's rule allowed a cheaper shape only where the outcome for an ordinary user stays the same: every
timeout now falls into the failure path a dropped connection already takes, imports get a Cancel instead of timers,
and nothing changes on the server or the wire. That removes B01 to B03 by design; the rare remainders are Limitations.
Not yet audited in this shape. The first draft (at `719b2d877`) failed its audit with 5 P1; the owner then moved the
Timeline, plugin permission refresh, MCP OAuth, shutdown order, and the server capacity checks to a batch round
(`/home/codex/review-reports/waits-batch-2026-11-24/`), which landed.

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
(Bounded Resource Writes, archived); resumable uploads; the in-tab CharX save queue (a Limitation);
changing a concurrency limit (ten translation permits, four previews, ten asset writes).

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
- **Asset writes and previews** (reproduced for the queues). The ten-slot asset save queue (`assetQueue.ts`) is built
  only by `CharXImporter` (`processzip.ts` ~234), which `characterCards.ts` (~317) creates only for a CharX given as
  bytes or a stream; every product caller passes a `File` or `Blob`, which goes to the server import. `assetClient.ts`
  makes up to eight attempts, including the first (~29, ~138). Storage-report previews (four slots,
  `assetLifecycleClient.ts` ~65) await one `response.blob()` after the server prepares the thumbnail before headers;
  releasing a row already frees its slot (~125) (traced, A16).
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

- **D1. A small JSON request gets 30 s**, covering the fetch and its body read, through `readWithDeadline`. The clock
  starts after `await ensureAuth()`: sign-in keeps its own bounds, and the password prompt is the user's time. This is
  the batch round's rule (`cfb711900`, `1aa3cac25`, `f3097ebd5`).
- **D2. A timeout is the feature's existing transport failure.** At the bound the request is aborted and its await
  rejects, so the code after the await runs the path a dropped connection already takes, and a late answer has nothing
  left to install. No request token, no new outcome, no new read.
- **D3. No timer on work the tab cannot observe.** An import has healthy silent phases; it gets a cancel the user can
  reach (D6), not a bound. The server and the wire format do not change in this plan.

### Per feature

- **D4. Checkpoints.** `chatRequest.ts`'s helper takes an opt-in bound (D1), on for every checkpoint request (list,
  policy, save, rename, delete, load) and off for chat trash. At the bound it answers `failed` with the dispatch flag it
  has; if a 200's headers arrived and only the body is late, it answers that response with a null body, as it does for
  an unreadable body today. `loadCheckpoint` is unchanged: a timed-out load is its `unknown` outcome, the chat read runs
  under its own 60 s bound, and `checkpointLoadBusy` is released in `finally`. Restore may be pressed again: the server
  refuses a load whose `chatBaseRevision` is not current (`server/src/data/checkpointService.ts` ~303).
- **D5. Memory tasks.** Start and Cancel take D1. A timeout is the existing `failed` result: Start leaves its
  `uncertain` fence, the chat's request slot is freed (other chats never shared it), and the same action can be
  repeated, since both are idempotent on the server (`start` answers `running` for a live job, `cancel` of nothing is
  a no-op). No state read is added.
- **D6. Imports: Cancel.** The wait status of a module upload, a CharX upload, a Realm prepare, a Realm commit and an
  upstream backup prepare carries a Cancel button, also on each progress update. Cancel aborts the request through a
  signal the import transport now accepts; the caller's existing failure handling runs (Realm's staging cancellation
  included), and the message says the import was cancelled and nothing was added. A backup commit gets no Cancel.
- **D7. Storage previews.** A preview takes a 60 s bound from after sign-in over its fetch and body. At the bound it
  runs the same path as an explicit release (abort, reject, free the slot, no object URL from a late body), and the row
  shows its existing failure state.
- **D8. Rendered translation.** Each non-LLM provider request (DeepL, DeepLX, both Google requests) takes a 60 s bound
  at the fetch, composed with the caller's signal; DeepLX's slot wait stays outside it. A timeout throws a transient
  error, so the producer notifies its subscribers, skips the cache write and frees its permit as for any provider
  failure, and the row keeps its two retries and its source-text fallback. A flight the composer started takes the same
  bound. The LLM translator is not changed.
- **D9. Web Push.** The key read, the registration PUT and the removal DELETE each take D1. A timed-out PUT clears the
  stamp, so the next reconciliation registers again; a timed-out DELETE is recorded as a pending removal, which the next
  reconciliation retries; a timed-out key read falls back to the cached key. The unit ends, and the Web Lock is
  released, when its last step settles: within the sum of its requests' bounds.

### Limitations

- A request abandoned at its bound may still land. Restore is refused or repeated harmlessly by its base revision;
  Start, Cancel, PUT and DELETE are idempotent repeats; a Save As may appear in the list after its failure message.
- A manual memory start that landed as waiting for the next send, with its answer lost, is not shown as waiting until
  Start is pressed again; an `uncertain` fence stays until the feed reports the chat, as after any failed Start.
- An import ends only by its answer, a network failure, or Cancel; an unattended tab keeps waiting.
- The in-tab CharX reader's save queue (ten slots) still waits on an unanswered write. It is built only for a CharX
  given as bytes or a stream, which no product path passes.
- A thumbnail the server takes longer than 60 s to prepare shows as failed in the storage report.
- A rendered LLM translation has no tab-side bound. It holds no permit; leaving the chat cancels it.
- A Web Push request delayed in transit past its bound can land after a newer opposite request for the same endpoint.
  A stale registration is removed at the push service's first 404 or 410; a stale removal lasts until the next
  registration (at most 24 h). The browser's own subscribe step has no bound.

### Questions for the owner

- **Q1. Numbers.** 30 s for a JSON request; 60 s for a preview and for a translation provider request. Proposed as
  written.
- **Q2. Cancel placement.** Proposed: Cancel is on the import wait from the start. Alternative: show it after 15 s, so
  a quick import never shows a button.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guide of each file the slice touches (`pnpm docs:owner <path>`), with
  `pnpm docs:read`.
- The reproduction probes are the starting point for the regression tests: a slice copies the probe describes it
  closes into its worktree and moves the cases into the destination test file its section names (V6: they fail before
  the change). Probe assertions that describe old behavior are replaced, not kept. Probe files are not committed.
- Tests use fake timers and held promises; none waits in real time.
- A slice that adds `ensureAuth()` updates the test mocks of `serverAuth` that export only `authFetch`, with the
  existing mock factory (`src/ts/storage/tests/serverAuthMock.ts`); search every test that mocks or spies the module.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`.
- User-visible strings go in `src/lang/en.ts` and `src/lang/ko.ts`, next to the feature's keys (U2).

## Slices

Order: 1 to 4 side by side in separate worktrees (disjoint files, except `src/lang/en.ts` and `ko.ts`); then 5 on the
integrated tree.

### 1. Checkpoints and memory tasks (_small_)

- `src/ts/checkpoints/chatRequest.ts` (the opt-in bound, the kept 200),
  `src/ts/checkpoints/chatCheckpoints.svelte.ts` (opt in), `src/ts/process/memoryTasks.svelte.ts`: D1, D2, D4, D5.
- Tests: `src/ts/checkpoints/chatCheckpoints.test.ts`, `src/ts/process/memoryTasks.test.ts`, from the probe
  `src/lib/Others/checkpointMemoryControls.probe.test.ts`: another chat's Save As after a held restore's bound and
  chat read; a held 200 body answers `refresh-pending`, not `unknown`; a late restore answer installs nothing; chat
  trash is not bounded; Cancel after a held Start's bound, and Start after a held Cancel's; a timed-out Start leaves
  the `uncertain` fence; a password prompt does not count.

### 2. Import Cancel (_medium_)

- `src/ts/alert.ts` and `src/lib/Others/AlertComp.svelte` (a wait status with a cancel callback),
  `src/ts/storage/serverImportClient.ts` (a `signal` option), `moduleImportClient.ts`, `charxImportClient.ts`,
  `realmImportClient.ts`, `src/ts/drive/upstreamBackupClient.ts`, `src/ts/process/modules.ts`,
  `src/ts/characterCards.ts`: D3, D6.
- Tests: `src/lib/Others/AlertComp.test.ts` (the button, absent on a plain wait),
  `src/ts/storage/tests/moduleImportClient.test.ts`, `charxImportClient.test.ts`,
  `src/ts/characterCardsRealmImport.test.ts`, the upstream backup client's test, from the probe
  `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (imports, backup prepare): Cancel during held headers and
  during a held body ends each action with the cancelled message and adds nothing; a Realm cancel attempts the staging
  cancellation; an import left alone still completes after ten minutes of silence.

### 3. Previews and rendered translation (_small_)

- `src/ts/storage/assetLifecycleClient.ts`, `src/ts/translator/translator.ts`: D7, D8.
- Tests: `src/ts/storage/tests/assetLifecycleClient.test.ts` (a held `ReadableStream` body: the fifth preview starts
  at the bound; a late body creates no object URL; MIME type and an empty body are kept),
  `src/ts/translator/translateHtmlWorkers.test.ts`, from the probe
  `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (`rendered translation`): the eleventh request starts
  after a held one's bound; the timed-out producer writes no cache entry and its joined render fails with it; a
  composer-first flight is bounded; a DeepLX slot wait does not count.

### 4. Web Push (_small_)

- `src/ts/network/pushNotifications.ts`: D1, D2, D9.
- Tests: `src/ts/network/pushNotifications.test.ts`, from the probe's `Web Push` describe: a held PUT ends at its
  bound and the other tab's Disable runs; the next reconciliation repeats the registration; a timed-out removal is
  retried as a pending removal; a held key read falls back to the cached key.

### 5. Close-out (_small_)

Depends on 1 to 4.

- Integrate 1 to 4 and run the whole suite once on the integrated tree (V1), with the type check and format check.
- The guides each slice changed: their Flows and Tests sections, and the Limitations above.
- [known issues](../backlog/known-issues.md): delete each closed bullet; the assets bullet's save-queue half moves to
  the assets guide's Limitations.

## Outside this plan

- The batch round's items (Timeline, plugin permission refresh, MCP OAuth, shutdown order, server capacity checks).
- The waits on a stalled local file step (Limitations in self-host-server and server-resources, `719b2d877`).
- The lore popup through a write fence (Lore Popup Through a Fence plan); the PO translator's leftover append and a
  recovery Apply's late answer, which are Limitations.

## Manual Checks

- On a phone with a throttled or interrupted connection: a checkpoint restore and a memory task start each end with
  their failure message within about a minute and leave their controls usable.
- Cancel during a module upload returns the tab, and a second import can start once the server's slot is free.
- Web Push enabled in two tabs with the server stopped: both toggles become usable within about two minutes, and the
  subscription is registered at the next reconciliation (reload or the page shown again) after the server returns.
