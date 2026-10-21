# Timing-Dependent Tests Plan

Status: planned 2026-10-21. Landed 2026-10-21: slice 0 (`pnpm test:overload`), then 1, 2, 3, 4a
and 8 in parallel worktrees (merged into `metatron` at `d3a053ca0`). Next: 4b, 5a, 6a. Source: the
refreshed inventory `docs/audit/timing-dependent-tests-2026-10-19.md` (refreshed at `11d6e86f1`:
463 rows in 216 files, 220 actionable rows in 116 files, 131 of them server and 89 client). Line
numbers there and here are approximate; the quoted test titles are the anchors. Re-verify each row
against the code before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task (most are `build-test-platforms.md`, whose `Tests` section owns the
slow-test table and the test rules); that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_ (the user's choice
over `delegate-implementation`). This is a
test-management plan: the implementer edits tests, and the production seams named in a slice are
test-only options with production defaults unchanged.

## Problem

`STRUCTURE.md` V3 says a gated test (`pnpm test`, no `slow` tag) must not depend on real wall-clock
time, CPU time or the scheduler. The inventory found 220 spots that still do: cold module graphs
inside the default 5 s timeout, a server poll helper with a real 2 s cap, worker budgets charged in
real time, fresh Node processes in the gate, short production timers raced by test work, wall-time
assertions, fake timers that leave `Date` real, and (new at the refresh) real `MessagePort`
delivery under a bounded poll, the client CBS 2 s wall limit, and SQLite fsync cost on a
disk-backed `/tmp`. Under the reference overload (one CPU, eight busy-loop burners,
`--maxWorkers=3`, about 1/9 of a CPU with 1-3 s deschedules) these tests fail without any defect in
the code under test. Nothing has been fixed since the inventory was written; the 2026-10-18 fixes
(`3e1bb3985`, `2cc6c51f1`) are the only landed precedent.

## Approach

Work by cause, not by row: the inventory's twelve cross-cutting causes each have one fix that
covers many rows. Slices are cut so that two slices that run at the same time never touch the
same file. After the cause slices, two sweep slices take every actionable row left in their area,
and the close-out reruns the whole gate under the overload.

Every edited or rewritten test passes both gates (`STRUCTURE.md` V3):

1. **Determinism gate (mechanical).** The test no longer depends on real time: a controlled clock
   (fake timers with `"Date"` where `Date.now` is read, an injected `now`), a deferred or latch, a
   test-only limit option, a warm-up outside the timed region, or the `slow` tag.
2. **Contract gate.** A plausible wrong implementation still fails it. A rewrite must not weaken
   what the test proves; the slice brief names, per rewritten test, the wrong implementation it must
   still catch, and the reviewer checks it (a quick mutation where feasible). A row whose test
   proves nothing extra (a duration bound behind a terminal check, a sleep after a synchronous
   state change) is deleted rather than rewritten.

Not allowed as a fix: a global or per-file timeout increase alone (the inventory's
`rewrite:raise-timeout` rows still need the warm-up or fixture change their reason names), moving a
deterministic contract to slow along with its slow neighbour (split the case instead), or a new
test for code no slice changed.

## Verification

Each slice ends with:

- `pnpm check`, `pnpm check:tests` (it fails when a `slow` tag and the slow-test table in
  `build-test-platforms.md` disagree), `pnpm format:check`.
- The touched test files with `pnpm test:agent --force <files>`, and the owning guide's focused
  checks when a production seam changed.
- The touched files under the overload, three runs, default timeouts (no `--testTimeout`: a raised
  outer timeout hides the cold-boot and fixture-size causes this plan fixes):
  `pnpm --silent test:overload <files>` (slice 0).
- In the inventory, each resolved row gets the suffix `fixed in <slice> (<commit>)`; a row the slice
  judged differently gets the new disposition and a reason. The close-out recomputes the summary.

## Order

```text
0 ─┬─ 1 ─── 5a ── 5b ─┐
   ├─ 2               ├─ 7a ── 9a ─┐
   ├─ 3 ─── 6a ───────┘            ├─ 10
   ├─ 4a ── 4b ── 6b ── 7b ── 9b ──┘
   └─ 8
```

- Slice 0 first: every later slice verifies with it.
- 1, 2, 3, 4a and 8 touch disjoint files and can run in parallel, each in its own worktree.
- 5a after 1 (both edit `scriptWorker.test.ts` and `hypaV3Limits.test.ts`); 6a after 3 (both edit
  `translate`, `importRealm`, `proxy`, `promptRunner`); 6b after 4b (`storedTranslation`); 7a after
  5b and 6a; 7b after 6b; each sweep after its area's cause slices.

## Slice 0. Overload runner (_small_, `build-test-platforms.md`)

Landed 2026-10-21. Beyond the text below: each run is a supervisor in its own session holding the
burners and the run (one scheduler autogroup), killed as a group afterwards; a burner that dies
during a run aborts with exit 2 (no result counts); `--cpu` picks the CPU; `--maxWorkers` is
refused. Details in `build-test-platforms.md` (`util/overloadTest.mjs`).

`util/overloadTest.mjs` (plain Node, no dependencies): pick one CPU the process may use (for example the
last one `taskset -pc <pid>` reports), start eight `node -e "while(true){}"` burners pinned to it,
run `pnpm --silent test:agent --force <files> --maxWorkers=3` pinned to the same CPU `--runs` times
(default 3), forward `--testTimeout` only when given, and kill the burners on exit, error, SIGINT
and SIGTERM. Exit non-zero when any run fails and print which run failed. Linux only (refuse
elsewhere with a clear message). Replace the prose recipe in `build-test-platforms.md` `Tests` with
the command, and add a `package.json` script `test:overload`. No test for the script beyond running
it once on `server/src/tests/cbsLimitsHost.test.ts` and on a deliberately sleeping scratch test
(not committed) to see it fail.

## Slice 1. Fresh processes and production-scale cases to slow (_small_, `build-test-platforms.md`)

Landed 2026-10-21 (`40ab0dce4`). Also split `projectionBindings` "bulk: the lorebook drag rebuild
and the preset reorder..." (same cause, failed an overload run); the gated suite starts no child
Node process (the remaining hits run `mkfifo` or only serve slow cases).

Every `move-slow` row (cause 4 and the slow parts of 6 and 8), each with its slow-test table row:

- `shutdown.test.ts` whole file (`/** @module-tag slow */`).
- `sharedImports.test.ts` "imports every shared/\*\*/\*.ts with plain node".
- `hypaV3Limits.test.ts` "the %s loop ends with an error instead of spinning".
- `cbsLimits.test.ts` "a non-advancing range answers [] under the server's limits..." (default:
  tag it; the in-process registry range test stays the gated coverage).
- `scriptWorker.test.ts` "lets a plain Node process that never disposes the pool exit on its own"
  and "terminates a ReDoS regex at its deadline while HTTP stays responsive, and recovers".
- `llmCharsetRetries.test.ts` the `spawnSync` retry-budget cases.
- `luaRuntime.test.ts` "keeps the wasm function table flat across runs with awaits...".
- `transformers.test.ts` the real-fork test; also await the adapter's exit promise instead of the
  600 ms sleep before reading `signalCode`.
- `projectionBindings.test.ts` the 1,000-write benchmark: keep its deterministic assertions (no
  serialization during writes, one per flush, final server text) in a gated case and move only the
  timing and ratio part.
- `upstreamImportCharacters.test.ts` the 150,000-message repair case: keep a small malformed-message
  case gated.

Done when `pnpm check:tests` passes and the gated run no longer starts a child Node process (check
with `rg -n 'spawn|fork|execFile|execSync' --glob '*.test.ts'` against the remaining untagged hits).

## Slice 2. Clock control in client tests (_small_, `build-test-platforms.md`)

Landed 2026-10-21 (`7a1a083ba`). The `resourceSyncMerge` / `resourceSyncRecreation` `toFake` bullet
moved to 4a (same files); a `performance.now` stub was enough, so no CBS clock seam was added.

Causes 7 and 11:

- Add `"Date"` to the fake-timer `toFake` lists of `resourceSyncMerge.test.ts` and
  `resourceSyncRecreation.test.ts` (as `resourceSyncNotices` does).
- `bootstrap.safeBoot.test.ts` "loadData with safe boot": fake `Date` with the timers, or pass
  `deps.now`.
- `backuplocal.test.ts`: freeze `Date` before the save and assert the literal file name.
- `limits.test.ts`: `stopClock()` in "the budget starts over for the next top-level parse", the
  non-advancing-range test and "twenty-five sibling calls answer...".
- `ChatBody.styles.svelte.test.ts` and `trimMarkdownSharingStyles.test.ts`: stop `performance.now`
  (or inject a non-advancing CBS clock) for the style-decoding assertions. If a test seam for
  `CLIENT_CBS_LIMITS`' `now` is cleaner than a spy, add it in `parser.svelte.ts` with the real clock
  as default.

## Slice 3. Server poll helpers (_hard_, `build-test-platforms.md`)

Landed 2026-10-21 (`88953f6d0`). `waitFor` has no deadline unless given one (only the slow
`shutdown` passes one); `follow()` closes on the terminal frame behind a ping/pong fence.
`memoryJobs`, `assets` and the restore spy keep uncapped polls (a latch would catch nothing more).
New row for 7a: `importCharx` 50 MiB entry. Still failing under overload, owned elsewhere: `assets`
2001 records (7a), `chatMetadataCoalescingEvents` manual batches (6a).

Cause 2. `server/src/tests/testSupport.ts` `waitFor`: drop the wall deadline and let the Vitest
timeout catch a hang, keeping the condition check on every turn (or, if a cap must stay, yield with
`setImmediate` and re-check once before throwing; decide at the slice from what the callers need).
Then:

- `follow()` in `generations.test.ts` and `generationDeltaChunks.test.ts`: close on the terminal
  frame, not after 4 s of real time.
- `translate.test.ts` `jobEnded` and `promptRunner.test.ts` `chatUntil`: the same treatment.
- `memoryJobs.test.ts` `expect.poll` over the feed socket: await the matching frame.
- Rows whose disposition is `rewrite:deferred` or `rewrite:call-through-spy` because they wait on a
  socket/fs completion (`backups` "lets an asset removal admitted before a restore finish...",
  `assets`, `snapshots`): await the spy or event.
- Not here: `shutdown` (slow after slice 1), the Echo and staging races (slice 6a).

Wrong implementations to keep catching: a job that never sends `done`, a lost frame, a staging
copy never cleaned up.

## Slice 4a. Storage graph warm-up (_hard_ by volume, `build-test-platforms.md`)

Landed 2026-10-21 (`7d52aa936`): `warmMutationGraph` in `mutationStoresHarness.ts`, 36 files, plus
the two `toFake` additions from slice 2. No first case fails under overload any more; the raised
per-case timeouts stay. New rows for 7b/9b: CPU-bound cases in `characterStore`,
`collectionStore`, `pluginStorageStore`, `resourceSyncPatches`, and a frame race in
`resourceSyncHydration` "installs the job's generated row under the streamed text...".

Cause 1 for `src/ts/storage/tests/`. Add one warm-up export next to `bootMutations` in
`mutationStoresHarness.ts` (the dynamic imports `bootMutations` performs, run once) and call it in a
`beforeAll` with a 60 s hook timeout in the 36 files the inventory lists as still cold. Keep every
per-test `resetModules`; the warm-up only takes the cold transform out of the timed region.
`resourceSyncFieldCache` drops its reliance on earlier cases warming the graph;
`resourceSyncModuleCache`'s seven 20 s cases and `moduleCache`'s first case are covered.
`browserLocalImport` boots in `beforeEach`: warm before it.

## Slice 4b. Client graph warm-up (_small_, `build-test-platforms.md`)

Cause 1 for the 16 other client files (`characters`, `generationJobsDelta`, `jobChannel`,
`jobChannelBarrier`, `pluginContextSaved`, `v3SavedWrites`, `chatStatus`, `inlays`, the two
`risuaccess` writer tests, `mcpWriters`, `serverCommands`, `stores.importOrder`, `chatToggles`,
`chatTranslation`, `storedTranslation`), plus `pluginSafeBoot` (settings views, fixture and plugins
graph) and `bootstrap.safeBoot` (also warm `StoreBackedServer.create`). Use the slice 4a helper
where the graph matches. In `stores.importOrder` the warm-up must happen before `resetModules` so
both import-order assertions stay meaningful.

## Slice 5a. Worker pool timing options and scriptWorker (_hard_, `self-host-server.md`)

Cause 3, production seam plus its main test file. `server/src/scripts/workerPool.ts`: make the
watchdog grace (now `WATCHDOG_GRACE_MS` 1000) and the abort grace (`ABORT_GRACE_MS` 500) pool
options with the current values as defaults, and let `createScriptWorkerPool` / `createTestServer`
pass them. Then rewrite `scriptWorker.test.ts` per the inventory's "scriptWorker residuals" and
"lets queued runs sharing a budget spend it once" (section 3): relative invariants instead of
small absolute slack, large graces where the subject is the hook, host-entry and completion
deferreds instead of sleeps, warm pools before timed regions, the six duration bounds dropped
(the concurrency test gets an entry latch), and a generous deadline for the successful regex-cap
case.

## Slice 5b. Other worker consumers (_hard_, `self-host-server.md`)

Cause 3 outside `scriptWorker`: `hypaV3Limits` (warm the pool, drop the `< 5000` / `< 1000`
bounds), `lore` (warm in `beforeAll`; a large deadline for the sane match; the real-limit case to
slow or behind a fake host), `regexScriptsTask` (its changed large fixture), `manualTriggers` "six
regex sites", `luaBindings`, `promptRunner` editinput, `memoryJobs` HypaV3 splitting (large test
budgets through the runner where the budget is not the subject).

## Slice 6a. Server production timers (_hard_, `self-host-server.md`)

Cause 5 on the server, each with a test-only seam:

- `translate.test.ts`: hold the Echo provider on a latch instead of its real 300 ms sleep (six
  tests).
- `importRealm.test.ts`: an injected expiry for `createRealmStaging` (`routes/importRealm.ts`), so
  the TTL tests advance it instead of racing 50-200 ms.
- `proxy.test.ts`: observe the upstream request first, then drive the timeout.
- The trigger effect loop's 50 ms yield window: pass `host.now` through the job runner
  (`runSetup.ts`, `triggers.ts`) so `chatMetadataCoalescingEvents` "persists %s batches..." and
  `manualTriggerMetadata` "keeps %s transcript reads and writes bounded..." run on a controlled
  clock. This fixes the known off-by-one transaction-count flake. Decide at the slice whether
  `lastEffectYieldAt` should also reset after an alert-input answer (a behavior question, not only a
  test one).
- `app.test.ts` "limits /api/login to 10 attempts per window...": fake the limiter clock.
- `promptRunner`: the real 5000 ms job abort grace and the 150 ms delay before a stream break.

## Slice 6b. Client production timers (_small_, `build-test-platforms.md`)

Cause 5 in the client: `bootCache.test.ts` (fake `setTimeout`/`clearTimeout` for the stalled-open
case and drop its elapsed bound; pass a large `timeoutMs` to the 18 constructions where the timeout
is not the subject), `storedTranslation.test.ts` and `Chat.test.ts` "the toggle requests a
translation when none is fresh..." (drive the 100 ms sync poll and 15 s deadline with fake timers
including `Date`).

## Slice 7a. Server duration and size guards (_hard_, `self-host-server.md`)

Causes 6, 8 and 12 on the server: `mcp` (deadline tests on full fake timers; the 8 MiB guard
becomes a scan/copy count), `mcpSse` (80k events: count framing work), `luaRuntime` duration
bounds, `triggerRuntime` v2Wait bound, `cbsLimitsJobs` bound, `thoughts` 1 MB fixtures,
`requestHistoryRoutes`, `app` and `importModule` 2000-request runs and `assets` 2001 records
(inject a small limit, keep one boundary check of the production value where it is the contract),
`backups` 200,000-record cap, `resourcePatchParts` (property matrices on in-memory backing with a
stored-text inspection seam plus one small disk-backed case; the cache-budget test with an injected
small budget).

## Slice 7b. Client size guards (_small_, `build-test-platforms.md`)

Cause 8 in the client: `moduleCache` 100k assets and `assetList` 100k names (shrink to a few
thousand; the identity guards do not depend on size), `exportBatches` 64 MiB caps (injected limit),
`characterCardsPngImport` stream fixture, `resourceSyncHydration` 150,000 messages,
`resourceSyncChats` request caps and `resourceSyncLive` 1,001 chats (keep inputs that cross the
protocol boundary; budget the rest).

## Slice 8. MessagePort polls (_small_, `plugins-mcp.md`)

Landed 2026-10-21 (`645e093c2`). `guestBridge` also gained a marker that catches a surplus pull.

Cause 10: `nativeFetchAbort.test.ts` ("aborts the host fetch after headers while the guest is
reading the body", "cancels a body the plugin never pulls from at 60 s..."), `guestBridge.test.ts`
"pulls a nativeFetch body from the host only when the plugin reads it", `sandboxActivity.test.ts`
"SandboxHost activity": install a message or activity-change latch before the action and await it
instead of `vi.waitFor`.

## Slice 9a / 9b. Sweeps (_hard_ server, _small_ client)

Every actionable row left in the area after the cause slices: the remaining `rewrite:deferred`,
`rewrite:fake-timers`, `rewrite:injected-clock` and `rewrite:other` rows, the `rewrite:deferred`
negative windows of cause 9 where a latch makes the check meaningful, the two `delete` rows (delete
the sleep, not the test: `backups` "refuses restore, import, and export with 503 once dispose has
begun..." and `memoryJobs` "an abort during a summary makes no later request..."), and the
`resourceSync`/`resourceSyncChats` debounce polls (advance the debounce explicitly). Before
starting, list the remaining rows from the inventory (rows without a `fixed in` suffix whose
disposition is not `keep-*`) and split further if the list is long.

## Slice 10. Close-out (_small_, `build-test-platforms.md`)

- The whole gated suite under the overload, three runs, default timeouts. Any failure becomes a new
  row and a fix in this slice, or a recorded leftover.
- Recompute the inventory's summary (a "fixed" column), mark it complete, and update
  `build-test-platforms.md` `Tests` and `STRUCTURE.md` V3 (which point at "the inventory of current
  offenders").
- Archive this plan in `docs/archived-plan/README.md`.

## Decisions

Defaults the slices take unless the user decides otherwise:

- D1. Production seams are allowed when they are test-only options with production defaults
  unchanged: pool graces (5a), a realm staging expiry hook (6a), `host.now` through the job runner
  (6a), a client CBS clock seam (2, if needed), an in-memory store inspection seam (7a).
- D2. A duplicate case that a gated in-process test already covers is moved to slow, not deleted
  (`cbsLimits` non-advancing range), so the real-process path keeps some coverage.
- D3. `keep-accepted` rows stay as they are; the plan does not chase rows the inventory accepted
  with a stated margin.
- D4. The slow tier is not run under the overload; slow tests may keep real time by definition.

## Not in this plan

- Making the slow tier itself faster or deterministic.
- The 144 test files the inventory did not read (no candidate pattern, no in-test boot).
- The resourceSync production `Date.now` backoff itself (only the tests' clock control is in scope).
