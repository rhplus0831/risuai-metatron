# Asset scan cost on a seeded store

Observed 2026-11-05 on `plan-asset-lifecycle-1` (base `9bf28c429` plus the asset mark), Node v24.21.0, WSL2 on a
24-core host, the save directory on tmpfs. The machine was busy with other sessions' test runs (load average 15 to 19
during the runs below), so each figure is the spread over four attempts on the final code, not one number. What the
mark reads is `server/src/data/assetLifecycle.ts`'s header; the guide entry is
[self-host server, Asset mark](../structure/self-host-server.md#asset-mark).

## Seed

Built through the real store API (`createResourceStore`, `store.applyChanges`, `store.memory.write`,
`store.checkpoints.save`, `createSnapshotManager`) by a throwaway script that is not in the repository:

- 50 characters, each with a profile image; 500 chats of 200 messages each (100,000 messages, about 1,960 bytes of text
  each); every 40th message names an `assets/` key and every 67th an `{{inlay::}}` id.
- 3,000 `inlays` records, 1,500 of them named by no message.
- 4,000 live structured memory rows and 200 staged rows (a rebuild per character), each naming an `assets/` key.
- 50 manual checkpoints with memory manifests and chunks.
- 5,000 asset files of 4 to 19 KiB.
- 3 snapshots of the whole store.

Each attempt ran two scans in one process: the first indexes the three snapshots, the second reuses their stored index.
Both were complete, with 3,100 referenced and 1,900 unreferenced files and 1,500 orphan inlay records.

## Rows

Rows read are the rowid windows inspected; selected rows are the ones the SQL prefilter passed to the JSON parse. The
counts were the same in every attempt.

| Table (live store)                   | Read    | Selected |
| ------------------------------------ | ------- | -------- |
| `messages`                           | 100,000 | 3,500    |
| `resources`                          | 3,072   | 3,050    |
| `chats` (structural pass, then meta) | 1,000   | 500      |
| `memory_*` and `memory_staged_*`     | 4,200   | 4,200    |
| `chatCheckpoints` (two passes)       | 100     | 50       |
| `checkpointPageRefs`                 | 1,500   | 1,500    |
| `checkpointPages` (by hash)          | 1,353   | 950      |

The memory and inlay rows are all selected because the seed names a key in every memory row and the inlay records are
read unfiltered; message text, the bulk of a real store, passes the filter at its key rate. Each snapshot adds the same
counts again on its first scan only.

## Time and memory

| Measure                                     | First scan     | Second scan    |
| ------------------------------------------- | -------------- | -------------- |
| Live store read                             | 0.74 to 1.11 s | 0.73 to 1.07 s |
| Snapshot indexing (3 snapshots)             | 2.43 to 3.14 s | under 0.1 ms   |
| Whole run                                   | 3.86 to 4.77 s | 1.29 to 1.87 s |
| Longest synchronous turn                    | 41 to 71 ms    | 42 to 75 ms    |
| Ledger (`asset-lifecycle.sqlite`, WAL, SHM) | 2.6 MB         | 2.6 MB         |
| Peak RSS of the process (seeding included)  | 192 to 427 MB  | 199 to 427 MB  |

The longest synchronous turn is the largest of: one 200-row chunk of a table, one snapshot's index transaction, and the
final turn that reads the export holds, classifies every file, and commits the ledger. The metric does not say which one
it was; a request that arrives during the scan waits at most that long. The peak RSS includes the seeding, which holds
the whole fixture; the high end came from the one attempt that ran while the machine was busiest.

## The sweep's synchronous turn

Observed the same day on `plan-asset-lifecycle-2` (the sweep added), same machine, the same seed rebuilt by another
throwaway script (not downscaled; checkpoint-page deduplication differs slightly with different seed text). Each trial
scans, writes one resource record (the `ui` background) naming the last key of the third batch, then sweeps 150 past-grace candidates: three
batches of 50, 149 deleted, the named key kept as `referenced`. The write moves `store.writeCount()`, so the first batch
re-marks the live store inside its synchronous turn (`sweep` in `server/src/data/assetLifecycle.ts`).

| Re-mark (one-minute load)                                | One re-mark    | Longest turn   | Three-batch sweep |
| -------------------------------------------------------- | -------------- | -------------- | ----------------- |
| Full, the default; its result kept for later batches (6) | 1.68 to 1.73 s | 1.68 to 1.74 s | not recorded      |
| Full, the default (27 to 34)                             | 2.82 to 3.14 s | 2.82 to 3.14 s | 2.89 to 3.21 s    |
| Narrowed in JavaScript, every batch re-marks (28 to 32)  | 1.75 to 3.12 s | 1.95 to 3.13 s | 5.58 to 8.87 s    |
| Narrowed by per-key SQL needles, discarded (6 to 33)     | 5.11 to 8.81 s | 5.76 to 8.81 s | 16.1 to 25.3 s    |

Both kept forms select rows with the mark's generic needles in SQL; the narrowed one then skips, before parsing, rows
whose text holds none of the batch's needles. Per-key needles in SQL (about 150 `instr` terms over every row's text)
were slower than either and were dropped. Full is the default because one full re-mark certifies every later batch,
while a narrowed one must repeat for each batch that follows a write. Every request waits for the turn: about 1.7 s on
this seed when the machine is quiet, about 3 s under load. A sweep with no write since its scan does no re-mark, and its
turns are the 50 `statSync` and `unlinkSync` calls of a batch.

## Not measured

- A spinning disk or an SD card: the reads here came from tmpfs and the page cache.
- A store far larger than this one, or a snapshot count near the retention limit of 20 (each new snapshot costs about
  0.8 to 1.05 s on its first scan here).
- The sweep's turn on a store larger than this seed: it reads every row's text once, so it grows with the store.
