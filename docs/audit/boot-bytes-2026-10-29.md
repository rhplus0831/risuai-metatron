# Boot Bytes audit — 2026-10-29

## Scope and result

Reviewed the completed plan and the implementation at
`f7eb271c32a3cab4f6fd366e6a97be316cf20c4d`, from a clean checkout. Retrieve the final
plan with:

```sh
git show 2a8f7b93a:docs/plan/boot-bytes.md
```

The review follows the nine slice commits rather than treating all intervening
history as Boot Bytes work: `5063a1a18`, `761d41c52`, `2f35afe02`, `18d36f062`,
`c10aed8a1`, `db31dc70f`, `a07028e56`, `179505dc6`, and `b53d68a31`. The intervening
Durable Drafts and Job Protocol changes are integration context. Two Luna agents
located the plan, changed files, and test harnesses; the primary agent reviewed
the implementation and ran the checks and probes.

**One plan-related availability defect was reproduced.** Four pre-existing
findings encountered in the investigation are recorded separately below,
including previously reported issues that were rechecked. No product fix or
permanent test addition is included. P2 means a functional or availability defect;
P3 means a narrower tooling or documentation defect.

| ID  | Priority | Relationship                                                | Finding                                                                        |
| --- | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| BB1 | P2       | New upload preflight, slice 3                               | A stalled optional missing-asset check prevents a healthy upload indefinitely  |
| U1  | P2       | Pre-existing feed reconciliation                            | A pending revision listing is never timed out while socket heartbeats continue |
| U2  | P2       | Pre-existing server imports and restore; expressly deferred | Existing corrupt assets survive reimport and restore                           |
| U3  | P3       | Pre-existing measurement driver                             | Relative `RISU_DIST` values resolve inside the temporary directory             |
| U4  | P3       | Pre-existing build guide                                    | Development and CI instructions are merged into a malformed paragraph          |

All five remain open. Verified findings are also indexed in the owning guides;
the corresponding inbox entries have been moved or narrowed, following
[STRUCTURE.md](../../STRUCTURE.md#doc-maintenance).

## Plan-related findings

### BB1 — The optional asset preflight can prevent the upload indefinitely

**Code and attribution.** [assetClient.ts](../../src/ts/storage/assetClient.ts),
`missingAssets`, `requestWithRetry`, and `writeAssets`;
[globalApi.svelte.ts](../../src/ts/globalApi.svelte.ts), `saveAsset`. Commit
`2f35afe02` added an awaited `POST /api/assets/missing` before canonical uploads.
Before that commit, `writeAssets` dispatched its upload directly.

**Trigger.** The missing-assets request, or its response body, stops making
progress without resolving or rejecting. The ordinary upload route remains
available. Callers without an external abort signal have no way to advance past
the preflight; an external signal supplies cancellation only if someone actually
aborts it.

**Reproduction.** A temporary copy of the existing asset-client harness held the
missing-assets response behind a deferred promise, allowed upload requests to
succeed, and advanced fake timers by 600,000 ms. It observed:

```text
missing checks dispatched: 1
batch uploads dispatched: 0
writeAssets settled: false
request signal supplied: false
independent writeAsset to the same key: succeeded
```

Releasing the preflight with the key marked missing then completed the batch
upload. The expected-progress assertion failed both in the initial run and in
the wrapper's isolated rerun. Ten minutes is an observation window, not a proposed
timeout.

**Cause and impact.** `requestWithRetry` limits retries after an error or a
retryable response, but imposes no deadline on an individual request or body
read. Both upload entry points await `missingAssets` before dispatching bytes;
their upload-everything fallback is reached only after rejection. A stalled
optimization can therefore leave an asset save or import pending even when the
server could accept its bytes. The server verifier's byte budget and concurrency
limit bound work volume, not elapsed time. Existing tests cover failed, malformed,
and explicitly aborted checks, but none holds the check pending.

**Suggested fix.** Bound the optional check, including authentication/request and
body consumption as appropriate, and fall back to uploading on that internal
deadline. Preserve a caller's explicit abort as an abort rather than falling
through to an upload. Cancel the obsolete check and ensure a late answer cannot
change the upload decision. Add a fake-clock regression with a pending preflight
and a healthy upload route, plus a caller-abort case.

## Issues outside the plan

### U1 — A live socket does not rescue a stalled reconciliation read

**Code and attribution.** [eventFeed.ts](../../src/ts/network/eventFeed.ts),
`reconcile`; [resourceClient.ts](../../src/ts/storage/resourceClient.ts),
`listRevisions`; [socketLiveness.ts](../../src/ts/network/socketLiveness.ts),
`watchSocket`. The unconditional, signal-free listing read already exists at the
pre-plan baseline `4a95f84bf`. The new digest avoids that read only when it matches;
the first connection and a reconnect after a missed change still need it. This
was previously named, but not reproduced for this caller, in the findings inbox.

**Reproduction.** Using a temporary copy of the feed harness:

1. Reconcile the first connection successfully.
2. Reconnect with a digest that includes a change missed during disconnection.
3. Hold the second `listRevisions` promise pending.
4. Deliver a heartbeat every 15 seconds for ten minutes of fake-clock time.

Observed: two total listing calls, only the first reconciliation completed, two
total sockets, the current socket still open, and no options/signal passed to the
pending listing. Releasing the response allowed reconciliation to finish. The
expected-progress assertion failed again in an isolated rerun.

**Impact.** Changes committed during disconnection remain unapplied until the
request finishes or another reconnect/reload occurs. WebSocket liveness does not
help because its heartbeats keep arriving. Memory-task fences waiting for the
listing may also remain held. Later live changes and independent saves can still
proceed; this is not a claim that all synchronization stops.

**Suggested fix.** Give reconciliation an abortable deadline, close/retry the
current socket on timeout, and cancel the listing when its connection is retired.
Retain the existing generation and epoch guards. Test the heartbeat-with-stalled-
HTTP case, not only a silent socket or a rejected listing.

### U2 — Server reimports preserve corrupt content-addressed files

**Code and attribution.**
[contentAsset.ts](../../server/src/http/contentAsset.ts), `writeContentAsset` and
`publishStagedContentAsset`; [importModule.ts](../../server/src/routes/importModule.ts),
the `storageFileExists` branch; [backups.ts](../../server/src/routes/backups.ts),
`restoreValidated`. These paths predate Boot Bytes. The plan explicitly left them
outside D7, and the findings inbox already described the defect.

**Reproduction.** In a disposable save directory, store `corrupt` at the canonical
key of the bytes `healthy original asset`. Call both `writeContentAsset` and
`publishStagedContentAsset` with the healthy bytes or staged file. Both return the
correct canonical key while leaving the target bytes equal to `corrupt`; neither
enters the write gate. The staged healthy file remains unpublished. The new
`AssetVerification.verifyFiles` correctly reports that same target as missing.

The module import's existence-only skip and the restore's successful-`lstat`
skip were confirmed in source; full module and archive imports were not driven
in this probe.

**Impact.** Reimporting a card/module or restoring a backup cannot repair an
existing empty, truncated, or wrong-content asset. The new client upload path can
repair it, but these server paths do not consult that verifier.

**Suggested fix.** Verify an existing canonical target and atomically replace it
when verification fails, while retaining maintenance, fsync, and publication
rules. Preserve the intentional treatment of noncanonical backup paths. Cover a
damaged existing target through each import/restore entry point.

### U3 — Relative build paths break the measurement driver

**Code and attribution.**
[measureBoot.mjs](../../util/playwright/measureBoot.mjs), `measureBoot`'s `dist`
initialization and `symlink(dist, path.join(workDir, "dist"), "dir")`. The logic
already appears before the plan, introduced by `723700902`; slice 1 moved it into
the function. The current header nevertheless advertises `RISU_DIST=dist`.

**Evidence.** The initial existence check resolves `dist/index.html` against the
repository working directory, so it succeeds after a build. The symlink target
resolves relative to the temporary directory instead. A filesystem reproduction
of the exact `dist` link produced:

```text
input: dist
link target: dist
stat(<temporary directory>/dist/index.html): ELOOP
```

Other relative values point to the wrong place rather than necessarily looping.
The normal default and absolute paths work; the current production measurement
used the default successfully. The broken value was not used for a full browser
run.

**Suggested fix.** Resolve the supplied value against the original working
directory before linking it, or reject relative values clearly and remove the
misleading header example.

### U4 — The build guide has lost its separate development instructions

**Code and attribution.**
[build-test-platforms.md](../structure/build-test-platforms.md#flows), the paragraph
beginning ``- Development: `pnpm run server`- CI:`` and ending with the duplicated
``test:agent` (V1).``. `git blame` attributes it to `6336e29549` on 2026-10-25,
before Boot Bytes. This is a source-confirmed documentation defect already noted
in the inbox.

**Impact and suggested fix.** The routed build guide obscures the two-process
development flow and merges it with CI instructions. Restore a separate
development bullet describing `pnpm dev` plus `pnpm run server`, and remove the
duplicated CI tail. This audit records the defect without repairing the paragraph.

## Coverage and checks that did not produce findings

| Area                                     | Review and current-run evidence                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measurement and closeout, slices 1 and 9 | Compared plan, implementation commits, and archive; reran five production scenarios on the `reported` fixture.                                                                                                                                                        |
| Static compression, slice 2              | Reviewed sibling selection, validators, MIME, range/identity fallbacks, and build output; the production build and static-transfer scenario passed.                                                                                                                   |
| Asset deduplication, slice 3             | Reviewed canonical-key attestations, raw overwrites, failure/abort handling, verifier budgets, file identity, and write generations; BB1 concerns an unanswered preflight.                                                                                            |
| IndexedDB repair, slice 4                | Reviewed version upgrade, missing-store creation, blocked/late opens, and existing tests; browser cold/warm boots succeeded.                                                                                                                                          |
| Activity timestamps, slice 5             | Reviewed memo invalidation, transactional reads/rollback, streamed continue finalization, loaded/unloaded readers, plugin getter/setter behavior, and export behavior. Existing per-job tests passed, and the production send scenario retained character-cache hits. |
| Plugin permissions, slice 6              | Traced boot seeding, revision use, missing records, legacy import reload, and remote ownership/reconciliation; existing tests passed.                                                                                                                                 |
| Reconnect digest, slice 7                | Reviewed advertised versus held revisions, listing overlays, stale-connection guards, missed frames, and memory fences. Unchanged production resume fetched no listing. U1 concerns the older fallback read.                                                          |
| Inlays and chat collections, slice 8     | Reviewed eligibility, claim budgets, summary format, epoch/sequence validation, reconstruction order, and cache write fencing. Real-browser installed snapshots matched plain reads through the tested changes and fallback.                                          |

The upstream export intentionally retains its separate cold-storage rule: it
raises an existing numeric `lastInteraction` and leaves an absent field absent.
That behavior is documented in the implementation and current guides; it is not
reported here as a defect merely because the UI uses a different derived rule.
Likewise, whole-list fallback after a digest mismatch, uncached plugin data,
legacy timestamp fallback, and a send changing a character through an actual
trigger/memory-setting edit are not violations of the plan.

## Verification and limits

- `pnpm check`: passed, zero Svelte errors and warnings; server TypeScript passed.
- `pnpm --silent test:agent`: passed, **7,871 passed, 60 skipped across 514 files**,
  with no `FLAKY` reruns reported.
- `pnpm --silent test:agent --tags-filter=slow server/src/tests/promptRunner.test.ts`:
  passed, one slow test; 30 tests excluded/skipped by selection.
- `pnpm build`: passed, including compression of 135 files. The build emitted
  CSS `::highlight` optimizer warnings, a browser-externalized `url` warning,
  ineffective dynamic-import warnings, and large-chunk warnings; it was not a
  warning-free build. Those warnings alone were not classified as defects.
- `util/playwright/offline.sh node util/playwright/checkBootCache.mjs`: **27
  checks passed**, default `check` fixture, including cold/warm boot, module
  edit/reorder, chat edit, character edit/delete/create, and full-read fallback.
- `util/playwright/offline.sh env RUNS=1 FIXTURE=reported
SCENARIOS=cold,warm,send,resume,scripts node util/playwright/measureBoot.mjs`:
  **30 checks passed**, using this run's production build, an isolated temporary
  store, headless Chrome, and loopback-only networking.
- Two temporary copies of existing test harnesses reproduced BB1 and U1 with
  deferred responses and fake clocks. Both expected-progress assertions failed
  twice, including isolated reruns. These deliberate probe failures are separate
  from the passing repository suite; both temporary files were removed.
- Disposable filesystem probes reproduced U2's two content-import helpers and
  U3's symlink failure. Product source and permanent tests were not changed.

The production measurement's single samples below are current-run observations,
not new performance thresholds or a statistical comparison with the historical
baseline. Boot-body bytes exclude transfer headers.

| Scenario         |  Boot body bytes | Main screen | Other evidence                                       |
| ---------------- | ---------------: | ----------: | ---------------------------------------------------- |
| Cold             |  6,991,161, zstd |      6.61 s | 21,672,925 decoded bytes                             |
| Warm             | 16,991, identity |      0.59 s | Cached reconstruction equals plain read              |
| Send then reload | 17,495, identity |      0.61 s | Changed chat collection; character still claimed     |
| Unchanged resume |                — |           — | Zero listing bytes; 139-byte hello                   |
| Empty HTTP cache | 16,991, identity |      1.62 s | Static files: 987,153 wire / 4,245,234 decoded bytes |

The large `audit` fixture, `otherDevice` and `selfEdit` production scenarios, full
e2e suite, full server-job browser matrix, Firefox/Safari, physical mobile/PWA
checks, and Docker image measurements were not rerun. An away-change resume is
still absent from the measurement driver's scenario set; existing unit tests
cover digest mismatches, but this browser measurement covers unchanged resume
only. These limits are not reported as passes. Formatting, relative-link checks,
and `git diff --check` were run on the final documentation changes.
