# Server measurements carried over from the guide

These four observations were held in `docs/structure/self-host-server.md` until 2026-11-01, when the server guides were
split under the rule that a measurement lives in `docs/audit/`. They are carried over as they stood, each with its own
observation date and commit. Nothing was rerun for this file. The guides keep the conclusion that changes how to edit
the code and link here.

## An older tab's whole-chat barriers

Observed at `ad0f8ef2b`, Node v24.21.0, written into the guide on 2026-10-30 by `d4f6b36b0`. The conclusion is in
[server generation](../structure/server-generation.md#limitations).

With `PROBE_HYDRATION=whole` in `job-channel-probe.mjs`, a no-op `editprocess` hook over 500 messages of about 2 KiB
(`messageDataChars` 2052) answered 500 callbacks with 500 whole-chat frames of 523,601,000 bytes.

Raw data: [job-channel-probe.output.txt](../research/deep-audit-with-fable/probes/job-channel-probe.output.txt), the
last line. Report: TJ04 in the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md).

## A restore's install and re-hash

Observed at `228b23f6d`, ext4, Node v24.21.0, written into the guide on 2026-11-01 by `f19f25924`. The conclusion is in
[server resources](../structure/server-resources.md#limitations).

Measured with `byte-budgets-probe.mjs`, case `restore`:

| Store                      | File bytes | Install median | Re-hash median |
| -------------------------- | ---------- | -------------- | -------------- |
| 3,000 chats                | 61,235,200 | 357.3 ms       | 45.7 ms        |
| One chat of 5,000 messages | 21,045,248 | 164.8 ms       | 16.1 ms        |

The guide rounded these to 357 ms and 165 ms for the install, 46 ms and 16 ms for the re-hash in all, and 61 MB and 21
MB for the files, in decimal megabytes.

The probe calls `stageValidatedSnapshot`, `verifyStagedFile`, and `replaceAll` directly, so the maintenance gate and the
safety snapshot are not in these numbers, and validation runs in process there and in a worker in production. They are
not a bound on a production restore.

Raw data: [byte-budgets-probe.results.json](../research/deep-audit-with-fable/probes/byte-budgets-probe.results.json),
under `after.cases.restore`. Report:
[server-client stabilization](../research/deep-audit/server-client-stabilization.md).

## A row far over a worker's heap limit

Observed on Node 24.21, written into the guide on 2026-11-01 by `c4a6775ef`. The conclusion is in
[server resources](../structure/server-resources.md#limitations).

A 32 MiB row under a 16 MiB limit aborted the whole process with exit 134 instead of ending the worker. The store and
the epoch stayed as they were, and the next start emptied the staging.

No raw report was found for the exit code and the Node version. The
[archive's Server Byte Budgets closeout](../archived-plan/README.md) records the same reproduction at a 16 MiB limit
with a 32 MiB row, not reached under the default 2048 MiB by what the 100 MiB request cap admits.

## Job receipt write costs

Observed on 2026-10-28, WSL2, written into the guide the same day by `d0b6c096c`. The conclusion is in
[server generation](../structure/server-generation.md#gotchas).

Measured with `generationReceipts.test.ts` "measures receipt admission, terminal writes, and event-loop delay" (a `slow`
test, `RISU_RECEIPTS_MEASURE_DIR` selecting the directory): 300 jobs with 4–24 KiB kept payloads.

| Volume                              | Admission p95 | Terminal p95 | Write max    | Event-loop delay                   |
| ----------------------------------- | ------------- | ------------ | ------------ | ---------------------------------- |
| Local ext4                          | 0.05–0.07 ms  | 0.15–0.16 ms | about 15 ms  | mean about 2 ms, max about 20 ms   |
| 9p `/mnt/c`, a slow-volume stand-in | about 4.6 ms  | about 8.6 ms | about 215 ms | p95 about 115 ms, max about 315 ms |

The 9p mount is a filesystem the store does not support. A controlled throttle (a cgroup I/O limit) was not available,
so a throttled local disk is unmeasured.

The test logs its samples and stores no result, so this table is the only record of that run.
