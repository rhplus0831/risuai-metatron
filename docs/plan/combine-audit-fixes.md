# Combine Audit Fixes Plan

Status: drafted 2026-10-24 at `26d806d9e` from the Combined Run audit report set
(`/home/codex/metatron-stage/combine-audit/`, reviewing `d66b050dd..531759887`). The audit
ran the full gates at its endpoint (`pnpm check`, 6,801 unit tests, 55 slow tests, the build,
35 browser tests) and found nine defects, none P0/P1. This plan takes the six whose trigger is
an ordinary user action; the three that need several unlikely conditions at once are listed
under Not In This Plan with the reason. Every location below was re-read at `26d806d9e`
(only docs and a Playwright measurement commit sit between the audit endpoint and it). Line
numbers are approximate; the identifiers are the anchors. Re-verify each cited location before
editing. Landed: 3 (`27cf4d231`), 5 (`df4d8017e`), 1 (`f1d753045`).

Each audited defect has a reproduction under
`/home/codex/metatron-stage/combine-audit/evidence/`, written as a test of the desired
behavior that fails on the current code. A slice that has one starts by bringing that test in
(renamed and retitled for behavior, `STRUCTURE.md` T5), watching it fail, then fixing until
it passes. The evidence directory is outside the repository; copy, do not link.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--tags-filter=slow` where it touches a slow test, `--e2e` where
it touches a screen an `e2e/` spec covers) and the owning guide's focused checks, and
updates the owning guide where it changes a documented contract. Code comments and test
titles describe behavior, not this plan or the audit (`STRUCTURE.md` T5).

## Problem

Six defects, each reproduced by the audit, each reachable from a normal action:

- A user with the `clickToEdit` setting cannot fill a Lua form. The row's body `onclick`
  (`src/lib/ChatScreens/Chat.svelte` ~1038) calls `startOriginalEdit()` for any click inside
  the body, so a click into a `risu-form` input remounts the row as the message editor and
  the form is gone before it can be submitted. The existing form tests dispatch
  `SubmitEvent` directly (`Chat.test.ts` ~311-340) and never click a control.
- An open lore entry's token count does not follow a model change. `createTokenCountField`
  (`src/ts/tokenCountField.ts` ~51) runs `count` inside `untrack`, and its `same` check treats
  unchanged text as the same input, so `LoreBookData.svelte` (~74) keeps the old model's
  number until the text changes or the entry is reopened. `PromptSettings.svelte` (~40-56)
  has the same shape: a JSON-equal template never recounts after a tokenizer or CBS change.
  The audit reproduced the lorebook case with the real `tokenizeAccurate` path and a mocked
  `authFetch` (11 tokens stays after the model answering 29 is selected).
- A chat screenshot can embed a 512 px WebP where the page shows the original.
  `DefaultChatScreen.svelte` (~804) calls `html-to-image`'s `toCanvas` without
  `includeQueryParams`, and that library keys its module-level data-URL cache by the URL
  without its query string. After a row's `?w=512` avatar is captured, a later row's
  `{{source::char}}` image or message image at `/api/asset/<hex>` (no query) gets the cached
  thumbnail bytes. The audit reproduced it with the installed library: a 1024 px original
  decoded at 512 px, byte-identical to the thumbnail, the original never fetched.
- Every thumbnail miss scans the whole cache. `assetThumbnails.ts` `publish` (~231) lists
  `save/cache/thumbnails` and tests every name for the key's hash prefix to drop stale
  entries; `removeKey` (~331) does the same for one key, and a batch removal calls it per
  key. Filling N portraits visits N(N+1)/2 directory entries (the audit measured 80,200 for
  400), and the scan runs inside the generation slot, so it also delays the bounded encoder
  queue.
- A cancelled token count keeps the server counting. `routes/tokens.ts` (~96-110) loops over
  `texts` and never reads `c.req.raw.signal`; `countWithGoogle` (`prompt/tokens.ts` ~75-100)
  has only its 30 s timer. The client aborts its request on the next edit or on dispose
  (`tokenCountField.ts`, `countTokens` with a signal), but the server finishes the batch,
  including Google calls that cost money. The audit reproduced it over a real loopback
  listener: after the client disconnects, the first provider fetch stays un-aborted and the
  second one starts.
- The upstream export reads checkpoint history it does not export. `exportStage.ts` (~35)
  calls `readSnapshotFile`, which now also runs `readCheckpointSnapshotRows`
  (`resourceStore.ts` ~420, `checkpointStore.ts` ~569) and keeps every page text in memory.
  `buildUpstreamDatabase` uses only resource rows and live chats. Export heap therefore grows
  with retained checkpoints: the audit's 40 one-MiB checkpoints of one tiny live chat fail
  under a 32 MiB worker cap where the same live data without history exports at 6.8 KB. The
  default cap is 2048 MiB, so this is wasted memory and an earlier 413, not a failure at
  that size.

## Approach

Fix each defect in place with the smallest change and the audit's reproduction as the
regression test, grouped by file cluster so slices can run in parallel. No new
architecture. Where a fix has a real choice, a decision below gives the default.

## Order

All six slices are independent in code. Wave A in parallel: 1, 2, 3, 4, 5, 6.

- Slices 2 and 5 both edit `llm-requests.md`; 4 and 6 both edit `self-host-server.md`. The
  second to land re-reads the guide before editing it.
- Slice 3 touches `global-api.md` only; slice 1 touches `scripts-triggers.md` and
  `ui-theming.md`.

## Slice 1. Form controls stay usable with click-to-edit (_small_, `scripts-triggers.md`)

- `Chat.svelte` ~1038: before `startOriginalEdit()`, ignore a click whose target is inside
  an interactive element: `form`, `input`, `textarea`, `select`, `button`, `label`, `a`, or
  an element with `contenteditable` (D1). Use `closest` from the event target up to
  `bodyRoot`. A click on plain text inside the form's own layout but outside those controls
  still edits (D1).
- `ui-theming.md`'s `Chat.svelte` entry (click-to-edit is not documented there today: add one
  sentence that a body click opens the editor except inside a form or interactive control)
  and `scripts-triggers.md`'s Lua forms paragraph (~68): a click into a form control never
  enters edit mode.
- Test (`src/lib/ChatScreens/Chat.test.ts`, next to the form tests; the audit's
  `form-click-repro.snippet` is the starting point): with `settings.ui.clickToEdit = true`,
  click the real `answer` input, flush, the form is still in the body and no editor is open;
  type a value, change a checkbox or select, click the real submit button, and
  `runServerJob` receives one command with those values; after a refused submit the typed
  values remain. Repeat the click case with `clickToEdit` off. A click on the row's plain
  text with `clickToEdit` on still opens the editor (the existing behavior).

## Slice 2. Delayed token counts follow the tokenizer and CBS context (_hard_, `llm-requests.md`)

- `tokenCountField.ts`: the helper keeps `untrack` around `count` (a count that reads a
  store must not subscribe the effect to every setting). The caller supplies what the count
  depends on as part of the input instead (D2).
- `LoreBookData.svelte` ~74: the effect's input becomes `{ text: value.content, expanded:
risuChatParser(value.content, { tokenizeAccurate: true }), scope:
tokenizerIdentityKey(current main scope) }`, read synchronously in the effect so Svelte
  tracks the model, tokenizer, and CBS reads; `same` compares `expanded` and `scope`;
  `count` calls `countTokens(expanded, undefined, signal)` (the CBS parse is what
  `tokenizeAccurate` does first, now outside the untracked count). Export a small
  `tokenCountInput(text)` from `src/ts/tokenizer.ts` (or a sibling) that returns that object,
  so the two callers do not duplicate the scope key.
- `PromptSettings.svelte` ~40-56: the two fields take `{ items, scope }` with the same key;
  `tokenizePreset`'s per-item CBS expansion happens inside `count` today and stays there,
  but the scope key in the input makes a tokenizer change recount (D2). CBS values a prompt
  template references are not tracked here; `templateItems()` already re-snapshots on edits.
- `llm-requests.md`, where it documents `countTokens`/`tokenizeAccurate` (~80-81) and the
  delayed count fields: the input carries the tokenizer identity, so a model change recounts
  without a text change.
- Test:
  - `src/ts/tokenCountField.test.ts`: a `same` that compares a composite input recounts when
    only its scope part changes.
  - A mounted `LoreBookData` test with the real tokenizer path and only `authFetch` mocked
    (the audit's `auditTokenScope.test.ts`, placed next to `LoreBookList.test.ts`): open an
    entry, see the first count, change the main model without touching the text, advance
    the debounce, see the new count; then change a CBS value the content references and see
    a recount. Keep `LoreBookList.test.ts` ~179's debounce and late-answer cases; drop its
    exact-argument assertions that the new test subsumes.
  - A mounted `PromptSettings` case: a tokenizer change with an unchanged template changes
    the displayed totals.

## Slice 3. Screenshots keep thumbnail and original apart (_small_, `global-api.md`)

- `DefaultChatScreen.svelte` ~804: `toCanvas(chat, { includeQueryParams: true })`. Nothing
  else changes; `withFileSrcFetch` already signs both URLs.
- `global-api.md` ~33, the `withFileSrcFetch` sentence about html-to-image's cache: the
  cache is keyed by the full URL, so `?w=256`, `?w=512`, and the original are three entries
  per asset.
- Test (`src/ts/globalApiRetention.test.ts` or a new sibling, using the installed
  `html-to-image/lib/dataurl.js` as the audit's `screenshot-variant-cache-repro.mjs` does):
  with the capture options the screen passes, fetch `/api/asset/<hex>?w=512` then
  `/api/asset/<hex>`; the second returns the original's bytes and the original URL was
  fetched. The test reads the options from a small exported constant the screen uses, so it
  fails if the option is removed, not merely if a literal is missing. A browser case is not
  required (D3).

## Slice 4. Thumbnail cleanup touches one key's entries (_hard_, `self-host-server.md`)

- `assetThumbnails.ts`: entries move under `save/cache/thumbnails/<sha256(key)>/` with the
  same entry name (D4). `publish` lists that key's directory only; `removeKey` removes the
  key's directory; `sweep` walks the key directories and applies the same rules, and removes
  a directory left empty. The per-key lock, single flights, staged-rename publication, and
  the stale-identity rule are unchanged. `THUMBNAIL_VERSION` bumps so an old flat cache is
  swept as unknown names (its files are derived data; the sweep already drops unknown names).
- `self-host-server.md` ~373 (`cache/thumbnails/` layout) and ~60 (`createThumbnailService`),
  `global-api.md` only if it names the layout.
- Test (`server/src/tests/assetThumbnails.test.ts`): keep every existing case. Add one that
  publishes entries for many unrelated keys, then publishes, replaces, and removes one more
  key, counting `readdir` calls (wrap `fs.readdir` as the audit's `thumbnail-scan-repro.mjs`
  does) and asserting the count does not grow with the unrelated library; assert stale-entry
  cleanup and the other keys' survival as today. A sweep over the old flat layout removes
  the flat files. Measure with the audit script by hand once (`node
thumbnail-scan-repro.mjs` against the new code should visit a constant number of entries
  per key) and record the numbers in the commit message.

## Slice 5. A disconnected token count stops the server's work (_small_, `llm-requests.md`)

- `prompt/tokens.ts`: `TokenCounter.count(text, scope, signal?)` and `encode` take an
  optional caller signal; `countWithGoogle` combines it with its timer
  (`AbortSignal.any([signal, timer])`) and the local tokenizer path checks `signal.aborted`
  before starting. Other callers (`bindings.ts`, `runner.ts`, `memoryTaskHost.ts`,
  `translation/runner.ts`) pass nothing and keep their behavior (D5).
- `routes/tokens.ts` ~96: pass `c.req.raw.signal` to `counter.count`, and before each text
  check `signal.aborted` and stop the loop (the answer no longer matters). The encode route
  passes the signal too.
- `llm-requests.md` ~80, the `POST /api/tokens/count` description; `self-host-server.md`'s
  route table row if it describes cancellation.
- Test (`server/src/tests/tokenRoutes.test.ts`, from the audit's
  `auditTokenCancellation.test.ts`): over a real `@hono/node-server` listener with a
  deferred provider fetch, start a two-text Google count, abort the HTTP client after the
  first provider call begins, and assert the provider's signal aborts and no second provider
  call starts. A unit case on `createTokenCounter`: a caller signal aborted mid-fetch
  rejects with the abort reason and the 30 s timer still fires alone.

## Slice 6. The upstream export skips checkpoint history (_small_, `self-host-server.md`)

- `resourceStore.ts` `readSnapshotFile(file, kinds, options?)`: an option
  `{ checkpoints: false }` skips `readCheckpointSnapshotRows` and returns no `checkpoints`
  (D6). The default stays the full validation, so `readSnapshot`/`replaceAll` (native
  restore) are unchanged.
- `exportStage.ts` ~35: pass `{ checkpoints: false }`.
- `self-host-server.md` ~46 (`stageUpstreamExport`), ~274 (the export flow), and ~665 (the
  worker's memory note): checkpoint tables are neither read nor validated by the upstream
  export.
- Test:
  - `server/src/tests/upstreamExportWorker.test.ts` (slow, real worker): after saving many
    checkpoints whose contents exceed a small `RISU_UPSTREAM_EXPORT_HEAP_MB`, exporting the
    tiny live library succeeds and decodes to the same chats and messages as the copy
    without history (the audit's `export-checkpoint-heap.mjs` scenario).
  - A `readSnapshotFile` unit case: with the option, a file whose checkpoint tables are
    malformed still reads its resource rows; without it, the same file is refused as today.

## Decisions

The runner takes each default unless the user overrides it.

- D1. Which clicks skip click-to-edit (slice 1). Options: (a) any click inside a `form`
  element or an interactive control; (b) only controls, so a form's plain text still edits.
  Default (a) for `risu-form` forms and controls everywhere else: a form is one unit the
  user is filling, and editing from inside it is never what a click there means.
- D2. How a count learns its dependencies (slice 2). Options: (a) the caller puts the
  tokenizer identity and the expanded text in the input, the helper stays generic; (b) the
  helper drops `untrack` so the effect subscribes to whatever `count` reads. Default (a):
  (b) subscribes the effect to every store the count path touches, including the count cache
  and batch state, and reruns on unrelated changes.
- D3. Screenshot test depth (slice 3). Options: (a) a library-level test with the screen's
  options; (b) also a browser screenshot comparing decoded sizes. Default (a); the
  browser case goes to the manual checks below.
- D4. Per-key cache layout (slice 4). Options: (a) one subdirectory per key hash; (b) a flat
  directory plus an in-memory index of names per key rebuilt at start. Default (a): the
  filesystem is the index, survives restarts, and the sweep already walks directories.
- D5. Signal reach (slice 5). Options: (a) the HTTP routes only; (b) also thread the job's
  signal through `bindings.ts`, `runner.ts`, `memoryTaskHost.ts`, and the translation
  runner. Default (a); (b) is the earlier Small Fixes D2(b) and still suits its own slice.
- D6. How the export skips history (slice 6). Options: (a) an option on `readSnapshotFile`;
  (b) a separate upstream-only reader. Default (a): one validator, one flag.

## Not In This Plan

- Lost-create recovery rebasing queued edits past a checkpoint restore (audit F01, both
  mechanisms). It needs a lost HTTP acknowledgement, a queued edit and a conflicting
  reorder in one tab, and a checkpoint load in another, or a summary-booted tab queuing
  `fmIndex` across a remote load. The persistence guide already lists it as a known hazard;
  the fix is a replacement/floor marker that lets the client discard pre-restore work, which
  is its own design. Keep the audit's two evidence tests
  (`chatCheckpoints*.audit.test.ts`) for that plan.
- A refused deletion becoming a whole-chat replace after Retry (audit F02). It needs a
  permanent 400/413 on a deletion batch, another client's list change that reinserts the
  row, and the user opening that row before Retry. The audit warns that dropping the
  membership check alone would break explicit same-id recreation. Evidence:
  `evidence/persistence/resourceSyncRefusedDelete.audit.test.ts`.
- Completed `once` plugin listeners retaining detached DOM (audit F09, P3, static only).
  Small fix (retire a fired `once` registration from `pluginEventListeners` and the
  instance registry), no measurement; take it with the next `plugins-mcp.md` slice.
- The checkpoint policy test harness's fake `Map` backend (`checkpointServer.ts` ~106) and a
  summary-boot mode for `chatCheckpoints.test.ts`: test-only, already in the project
  memory; they belong with the F01 plan, which needs both.
- `checkpointService.ts` ~107 parsing the whole transcript to count roles after every done
  job: observed statically, not benchmarked; raise it if a profile shows it.
- SA14's queued-root retention: documented and intentionally tested, not a defect.
- Workflow tests the audit asked for without a defect behind them (real streaming state
  reaching translation, the Realm block/manage/unblock flow, native Enter on alert buttons,
  a checkpoint browser spec): coverage work for whichever slice next touches those screens.
- Two representation couplings in tests (`jobStages.test.ts` ~18's NUL-delimited key,
  `ChatBody.svelte.test.ts` ~174's `[style*="animation: spin"]` selector): fix in passing
  when those files change.

## Manual Checks After Landing

- Slice 1: in the app with click-to-edit on, fill and submit a card's Lua form.
- Slice 2: open a lore entry, switch the main model in Settings, watch the count change.
- Slice 3: take a screenshot of a chat whose later row shows `{{source::char}}` at full
  size, and compare the embedded image with the thumbnail by eye or by decoded width.
- Slice 4: browse a library of a few hundred portraits after the upgrade; the first pass
  should not slow as the cache fills.
- Slice 5: with the Google count option on, type in a lore entry and watch the server log
  or provider dashboard for abandoned counts.
- Slice 6: export an upstream backup from a library with checkpoints and confirm it restores
  in upstream RisuAI.

## Open Questions

- Should slice 4 also batch `removeKey` for the storage route's multi-key removal under one
  lock pass? Not planned; the per-key directory already makes each removal constant.
