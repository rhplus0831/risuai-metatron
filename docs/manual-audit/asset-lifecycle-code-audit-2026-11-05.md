# Asset Lifecycle code audit — 2026-11-05

## Scope and result

Audited `dev` at `65e97f91f22418df49452e76e46af7a145b144f1`, starting from a clean checkout. The retired plan was recovered with:

```sh
git show 6da6d5c59830f3bad1a3b17dfd1952b51f510d87^:docs/plan/asset-lifecycle.md
```

All five implementation commits are present: `b7095d591` (mark/report), `dd35ebc52` (sweep, claims, preflight),
`0c3e7d2d0` (snapshot controls), `967cc5be1` (Storage settings), and `7d6ff9970` (browser check/documentation).
The audit followed their current implementations, including reference discovery, leases, orphan inlays, snapshot and
export roots, backup disk estimates, import queues, and the Storage UI. The [archive](../archived-plan/README.md)
records the plan's retirement.

**Eight findings concern this plan: three correctness bugs, four CPU/memory improvements, and one traffic improvement.**
The most consequential gap is that orphan cleanup can remove newly reused inlay metadata even while its media has a
fresh asset lease. Two additional, pre-existing performance issues are documented separately. No product fixes were
made.

P2 means a reproducible correctness defect or material performance problem under the stated trigger. P3 means a lower
priority optimization. Measurements below are local observations on Node `v24.21.0`, not production latency promises.

| ID  | Priority | Category    | Finding                                                            |
| --- | -------- | ----------- | ------------------------------------------------------------------ |
| AL1 | P2       | Correctness | Cleanup can delete freshly reused inlay metadata                   |
| AL2 | P2       | Correctness | A rejected snapshot restore displays a success notice              |
| AL3 | P2       | Correctness | Import preflight charges for assets that will not be copied        |
| AL4 | P2       | Memory      | Streamed PNG imports retain every asset payload until completion   |
| AL5 | P2       | CPU         | Unterminated inlay markers cause quadratic reference scanning      |
| AL6 | P2       | CPU/memory  | Candidate-list rebuilding makes cleanup quadratic                  |
| AL7 | P2       | CPU         | Each cleanup batch reloads all unchanged snapshot references       |
| AL8 | P3       | Traffic     | Scan polling repeatedly transfers the previous complete report     |
| U1  | P2       | Memory      | Fallback media URLs retain blobs beyond the cache's byte limit     |
| U2  | P2       | CPU         | Version-2 backup export vacuums its database on the serving thread |

## Findings related to Asset Lifecycle

### AL1 — Reusing an orphan inlay does not revoke its deletion eligibility

**Evidence:** [assetLifecycle.ts](../../server/src/data/assetLifecycle.ts), lines 806–817 and 1235–1256;
[Lua bindings](../../server/src/lua/bindings.ts), lines 771–782 and 1675–1696;
[inlays.ts](../../src/ts/process/files/inlays.ts), lines 340–353 and 400–405. Plan decisions D7 and D14.

The orphan candidate map records the ID, age, and byte count, but no scanned record revision. During deletion, the
sweep checks whether text now names the ID, reads the **current** inlay record, and deletes that current revision.
Rewriting the metadata after the scan therefore does not disqualify it. A lease on the associated asset protects the
file, not its inlay metadata.

This has supported callers. `getCharacterImageMain` and `getPersonaImageMain` use the image key as a stable inlay ID.
Their existing-image shortcut returns an inlay marker after a metadata/file-presence check, without claiming the ID.
Their redraw path passes that same ID through the `drawInlay` callback to `writeInlayImage`. A script can obtain the
marker, await more work, and then write it into chat. Cleanup in that interval can remove the metadata the successful
reuse just returned. This concerns an active supported operation, rather than a user pasting an arbitrary old ID.

**Reproduction:** Using the real resource store and lifecycle, create `assets/avatar.png` as an orphan inlay ID, scan,
advance the injected wall clock seven days, and scan again. Upload fresh media through `writeStorageFile`, update the
same inlay ID, and sweep that selected ID before publishing the message that references it. The observed result was:

```text
old metadata revision suffix: :1
new metadata revision suffix: :2
fresh media leased: true
sweep.removedInlays: ["assets/avatar.png"]
metadata after sweep: null
fresh media file still exists: true
```

The writer can subsequently publish a marker that no longer resolves. The existing no-write reuse shortcut has the
same exposure without a revision change. The isolated reproduction verifies metadata deletion; the Lua/callback
caller chain was traced in source, not exercised in a full browser race.

**Direction:** Retain the scanned revision and reset orphan maturity on replacement. Add a recent-use claim for
inlay IDs, including successful reuse without a write, with ordering against metadata deletion. A revision check alone
does not protect the Lua shortcut. Regression coverage should hold the referencing message write pending while a
sweep attempts to remove both a rewritten ID and an existing ID that has just been claimed.

### AL2 — An epoch-conflicted restore is reported as successful

**Evidence:** [StoragePanel.svelte](../../src/lib/Setting/Pages/Advanced/StoragePanel.svelte), lines 223–239;
[resourceClient.ts](../../src/ts/storage/resourceClient.ts), lines 154–155 and 555–561;
[backups.ts](../../server/src/routes/backups.ts), lines 198–202. Plan D8/D9, UI slice.

The panel catches `ResourceEpochMismatchError`, suppresses it, displays `language.storage.restored`, and reloads.
The transport raises this error when the server returns HTTP 412 `EpochMismatch`: the requested restore was refused.
The server can reject the epoch before it even begins restoring. For example, another tab restores a snapshot while
this tab still holds the previous epoch or has a restore queued.

**Reproduction:** Execute the current `restoreBackup` transport and the exact component `restore` function with the
network boundary returning HTTP 412. The function issued one request, displayed `["Snapshot restored"]`, and reloaded
once. This was an isolated client-function probe, not a browser mount. The current
[panel test](../../src/lib/Setting/Pages/Advanced/StoragePanel.test.ts), lines 441–444, expects the reload on this path
but does not reject the incorrect success notice.

**Direction:** Keep reloading when necessary to recover from stale state, but show a conflict/refusal notice. Display
restore success only after a successful restore response. Test the notice as well as the reload.

### AL3 — Backup import demands space for already-present verified assets

**Evidence:** [backups.ts](../../server/src/routes/backups.ts), lines 538–545 and 624–636. Plan D12.

After spooling the archive, the second preflight adds the length of **every** asset record to its remaining-allocation
estimate. Later, `restoreValidated` verifies existing content-named files and skips them without invoking
`asset.stage()`. Those files require no additional copy. Charging their size can refuse a predominantly deduplicated
backup even when there is enough free space for every allocation that will actually occur.

The comment about damaged assets needing repair is valid, but it does not justify charging verified intact assets.
The saved archive already occupies disk and is not another future allocation at this checkpoint.

**Reproduction:** A real server context with injected `statfs`, an existing verified SHA-256-named 8 MiB asset, and a
version-2 archive containing the same asset produced:

| Quantity                                  | Bytes      |
| ----------------------------------------- | ---------- |
| Archive database                          | 225,280    |
| Live database and WAL                     | 325,488    |
| Existing asset                            | 8,388,608  |
| Injected remaining free space             | 72,304,496 |
| Reported required space, including margin | 76,498,800 |

The complete archive received **507**. Importing the identical database with that already-present asset omitted
received **200**, wrote zero assets, and preserved the existing file. This tests the estimate with an injected free
space value; it does not simulate an actual full filesystem.

**Direction:** Budget absent or damaged assets, keeping the existing database/safety-copy estimates and margin.
Revalidate required allocations under maintenance or immediately before staging a newly required asset so a presence
check outside the lock does not introduce a deletion race.

### AL4 — Retained replay callbacks undo bounded-memory PNG import

**Evidence:** [assetQueue.ts](../../src/ts/storage/assetQueue.ts), lines 283, 375–387, and 469–488;
[characterCards.ts](../../src/ts/characterCards.ts), lines 316–377. Plan D7.

The final claim pass retains each canonical asset's `AssetSaveItem` in `replay` until all uploads finish. Keeping a
loader is cheap only when the loader does not own the payload. The PNG import generator yields
`load: () => Buffer.from(value, "base64")`, closing over the entire chunk string. Consequently, every previously
uploaded asset's encoded payload remains reachable until the final check. This affects ordinary File/Blob PNG imports
as well as one-shot streams.

Upload concurrency and decoded batch bytes remain bounded, but retained source memory is now proportional to the
total encoded asset payload. Large cards can exhaust a browser's memory despite the streaming/backpressure design.

**Reproduction:** An isolated probe ran the actual `saveAssets` implementation with an asynchronous source using the
same callback shape and stubbed transport. Twenty-four distinct 512 KiB assets produced 16,777,248 base64 characters.
After all 24 uploads, explicit GC still left all 24 loaders alive at the final presence check. After `saveAssets`
returned, none remained alive. This proves retention; it does not claim a measured browser RSS or out-of-memory crash.

**Direction:** Use replay sources backed by file offsets/slices or bounded staging storage. For one-shot streams,
consider an operation-scoped server hold with explicit finalization. Preserve the final presence guarantee without
keeping every chunk string in memory. A regression check should observe source-payload reachability while a large
import is still running, not merely assert that upload batches stay small.

### AL5 — Malformed inlay text makes the server scanner quadratic

**Evidence:** [assetLifecycle.ts](../../server/src/data/assetLifecycle.ts), lines 120–148, particularly line 146;
the same recognizer is used by the chunked scan and synchronous deletion recheck. Plan D1/D2/D13.

The inlay regex searches for a closing `}}` separately from each possible opening marker. A string containing many
`{{inlay::` openings and no closing marker repeatedly searches the remaining suffix, taking quadratic time. The SQL
prefilter admits it because it contains `{{inlay`. Chunking by row count cannot interrupt work inside this string;
both a background scan and a deletion recheck can block the serving event loop on one modest-sized stored value.

**Reproduction:** Call the exported production `recognize` with a no-op sink and
`"{{inlay::".repeat(n)`. One local run observed:

| Input bytes | Recognition time |
| ----------- | ---------------- |
| 18,000      | 14.63 ms         |
| 36,000      | 56.85 ms         |
| 72,000      | 227.73 ms        |
| 144,000     | 891.25 ms        |

Doubling input approximately quadrupled work. No invalid database or malformed JSON is required: this can be an
ordinary stored chat, lore, or plugin string containing incomplete markers. Timings are illustrative; the repeated
suffix search is the underlying defect.

**Direction:** Recognize the three prefixes and their terminators in a linear pass, preserving current ID semantics
and conservative retention. Stop searching for later openings when the remaining suffix has no possible terminator.
Do not solve the CPU problem by truncating legitimate references and making deletion unsafe.

### AL6 — Cleanup repeatedly materializes every remaining candidate

**Evidence:** [assetLifecycle.ts](../../server/src/data/assetLifecycle.ts), lines 1280–1291. Plan D6/D9.

After each successful unlink, cleanup rebuilds the report with
`[...candidates.values()].slice(0, ASSET_LIST_CAP)`. The 2,000-entry display cap applies after the whole map has been
materialized. Deleting all N candidates therefore visits `N × (N − 1) / 2` entries just to maintain the visible prefix.
Deleting only the 2,000 displayed rows still repeatedly copies the much larger underlying inventory.

**Reproduction:** Instrumenting `Map.values()` during real lifecycle sweeps, without changing their decisions, counted
11,325 remaining-candidate visits for 151 deletions and 1,139,295 visits for 1,510 deletions: exactly the quadratic
formula. These counts exclude scanning and filesystem work.

**Direction:** Refresh the report prefix once per batch and consume an iterator only up to the display cap. Preserve
the complete candidate map for selection and safety checks. Grouping ledger cleanup in a transaction may further
reduce overhead, but it is independent of the demonstrated full-map copies.

### AL7 — Snapshot reference reconstruction repeats for every cleanup batch

**Evidence:** [assetLifecycle.ts](../../server/src/data/assetLifecycle.ts), lines 1140–1166 and 1183. Plan D3/D6/D13.

Each batch of at most 50 selected assets or inlays reloads all retained snapshots' `snapshotRefs` and `snapshotInlays`,
rebuilds the merged sets, and sorts the tails. Persistent indexing avoids rescanning the snapshot databases, but it
does not avoid repeatedly decoding and sorting those unchanged indexes. This scales with both the number of cleanup
batches and the full retained reference population.

**Reproduction:** With five unchanged snapshots containing 200 reference tails each:

| Deleted candidates | Batches | Snapshot-tail queries | Returned tail rows |
| ------------------ | ------- | --------------------- | ------------------ |
| 151                | 4       | 20                    | 4,000              |
| 1,510              | 31      | 155                   | 31,000             |

These are instrumented production calls; no snapshots changed during the sweep. The same work is repeated for inlay
IDs. The sweep's `longestSynchronousTurnMs` timer starts after this reconstruction, so it does not include this source
of event-loop blocking.

**Direction:** Reuse a merged snapshot index for the sweep and update it when the listed snapshot IDs change.
Continue listing snapshots and indexing new ones under `exclusive` for each batch. Include reconstruction in the
blocking-time measurement; do not remove the new-snapshot safety check to improve the metric.

### AL8 — Polling transfers unchanged candidate lists while a scan runs

**Evidence:** [StoragePanel.svelte](../../src/lib/Setting/Pages/Advanced/StoragePanel.svelte), lines 108–127;
[assetLifecycle routes](../../server/src/routes/assetLifecycle.ts), lines 19–35;
[assetLifecycle.ts](../../server/src/data/assetLifecycle.ts), lines 1405–1406. Plan D9.

The panel polls approximately once per second after each response. Each poll serializes and downloads the entire
latest report with `no-store`. During a scan, the report remains the previous result with `running: true`; the large
candidate, orphan, owner, and snapshot lists are repeatedly transferred without providing new information. They are
also parsed and assigned again by the client.

**Size check:** Serializing only 2,000 normal hash-key candidate rows and 2,000 UUID orphan rows with hash-key media
paths produced 592,028 bytes. Sixty such responses would carry about 33.9 MiB of JSON before compression, excluding
owners and other report fields. This is an illustrative maximum-list fixture, not a measured minute-long browser
session or a claim about compressed network bytes. The cost matters particularly during long snapshot indexing or
export-key waits.

**Direction:** Poll a small run-status/version response and fetch the full report when its version changes, or provide
an equivalent conditional response. This does not require implementing the live-update progress feature deferred by
the plan. Preserve authentication and the complete report on initial load and completion.

## Unrelated findings retained from the audit

### U1 — Fallback audio/video object URLs bypass the blob cache's memory bound

**Evidence:** [inlays.ts](../../src/ts/process/files/inlays.ts), lines 214–230 and 541–573;
[parser.svelte.ts](../../src/ts/parser/parser.svelte.ts), lines 932–937;
[globalApi.svelte.ts](../../src/ts/globalApi.svelte.ts), lines 190–195. This URL-cache implementation predates the plan
(`b51d48f6f`, 2026-10-15).

Without a capable controlling service worker, audio and video rendering uses `getInlayObjectUrl`. Its
`mediaObjectUrls` map grows for the page's lifetime and never revokes URLs. Each object URL retains its Blob even
after the separate 64 MiB `blobCache` evicts that asset. Visiting many distinct media items therefore retains more
media than the cache budget suggests.

**Reproduction:** The actual inlay module, with asset reads stubbed and native Node Blob URLs, loaded nine 8 MiB audio
items. The blob cache held eight entries/64 MiB; nine object URLs still retained 72 MiB. The first evicted Blob remained
resolvable at 8 MiB. This establishes the independent retention mechanism, not a browser-process RSS measurement.

**Direction:** Track URL ownership by rendered media and cached HTML, then release unowned URLs under a byte budget.
The existing comment correctly explains why blanket revocation on blob-cache eviction would break cached renders;
the improvement needs coordinated lifetimes rather than that shortcut.

### U2 — Version-2 export synchronously vacuums the staged database

**Evidence:** [backups.ts](../../server/src/routes/backups.ts), lines 324–345. This is pre-existing export preparation,
not the new upstream-export preflight or an Asset Lifecycle regression.

The version-2 export opens its staged database using `DatabaseSync`, removes credentials, and calls synchronous
`VACUUM` on the serving thread. Every request and WebSocket callback waits while the database is rewritten. Asset
streaming afterward does not make this preparation asynchronous.

**Reproduction:** A real server context containing one 32 MiB character description returned HTTP 200 for export.
Instrumenting the actual `DatabaseSync.exec("VACUUM")` call measured 263.4 ms synchronously, within 506.3 ms of export
preparation. This is one local observation; larger databases and slower disks were not benchmarked.

**Direction:** Perform staged credential removal and vacuum in a worker, preserving removal of credentials from both
live rows and freed database pages. As an adjacent improvement, add a disk preflight for the staging copy and vacuum
temporary allocation. The same probe injected zero available bytes but export made zero `statfs` calls and created
staging anyway. That verifies absence of the guard, not behavior on an actual full disk. D12 explicitly required the
guard for upstream export; its absence here is not an unfulfilled plan promise.

### Additional lead — Mutable custom keys can change during export

This is **unverified and excluded from the finding counts**. Version-2 export records asset file paths and opens them
later while streaming ([backups.ts](../../server/src/routes/backups.ts), lines 328–391 and 440–448). The export hold
protects those keys from lifecycle deletion, but does not block a custom-key write from replacing a file by rename
([storage.ts](../../server/src/routes/storage.ts), lines 202–267). Unlike a verified content-hash key, a custom key can
therefore name different bytes between the database copy and asset streaming.

The possible result is an archive pairing its database snapshot with later custom-asset content. No coordinated
export/replacement reproduction was run, and the intended consistency guarantee for mutable custom keys needs
confirmation. A follow-up should pause export before opening such an asset, replace it through the normal write path,
and inspect the archive. This is separate from the plan's deletion holds, which do protect against the sweep.

## Checked behavior and limits

The review used multiple Luna exploration agents and separate audits of sweep/lease ordering, snapshot/import/export
integration, and client behavior. The primary review re-read the finding sites and reran the substantive probes.
Temporary probes used isolated stores under `/tmp` and did not modify product files. Client probes executed current
transpiled functions with I/O dependencies replaced; they were not substitutes for browser integration tests.

The implementation already covers many earlier design-audit risks: decoded JSON/object-key recognition; both direct
asset URL spellings and either-case hex; reroll candidates, chat metadata, memory, and checkpoint references; missing
roots causing incomplete runs; per-key publish claims; restart/epoch/stale-run refusal; full re-mark baselines; and
snapshot/export retention. This audit did not establish another asset-file deletion race in those paths. AL1 concerns
the separate inlay metadata lifetime.

The full synchronous live re-mark remains a known scaling limit. The prior
[seeded measurement](../audit/asset-scan-2026-11-05.md) records roughly 1.7–3.1 seconds of request blocking. That is
existing measured behavior, not a new measurement from this audit. AL5–AL7 identify additional avoidable work; changing
the re-mark itself must preserve the no-write-between-final-check-and-unlink ordering.

### Validation

The focused existing suite passed **365 tests, with 2 skipped, across 14 files**:

```sh
pnpm --silent test:agent \
  server/src/tests/assetLifecycle.test.ts \
  server/src/tests/snapshots.test.ts \
  server/src/tests/backups.test.ts \
  server/src/tests/assets.test.ts \
  server/src/tests/assetRoute.test.ts \
  server/src/tests/importModule.test.ts \
  server/src/tests/upstreamExportRoute.test.ts \
  server/src/tests/upstreamImportRoute.test.ts \
  src/lib/Setting/Pages/Advanced/StoragePanel.test.ts \
  src/ts/storage/tests/assetLifecycleClient.test.ts \
  src/ts/storage/tests/assetClient.test.ts \
  src/ts/storage/tests/assetQueue.test.ts \
  src/ts/process/files/tests/inlays.test.ts \
  src/ts/storage/tests/resourceClient.test.ts
```

The findings' reproductions are supplementary probes, not failing assertions added to that suite. The passing suite
does not cover the reproduced gaps. Source references and reproduction recipes above are retained in this report;
throwaway probe scripts are not repository artifacts.

The full non-slow gate, `pnpm --silent test:agent`, also passed: **9,191 tests, 66 skipped, 577 files** (82.7 seconds).
`pnpm check:changed` completed and skipped both client and server type checks because no changed path reached either
program; this is not a fresh full type check. The report passed targeted Prettier checking and `pnpm check:docs`.

Browser/device checks, actual disk exhaustion, and slow/full-scale load tests were not run for this report. No claim is
made that those checks passed. Existing browser behavior described in the retired plan was reviewed as context only.
