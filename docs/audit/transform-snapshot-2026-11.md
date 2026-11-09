# Transform snapshot charges on a large chat

Measured 2026-11-09 at `89168b697` with this run's driver change, Node v24.21.0, by the Found Issues Clearance plan's
slice D2 (Q9). It replaces the Display Evaluation Slice 3 figure (2026-10-28: about 6.7 MiB per scope on a
2,000-message chat of about 6 MiB, so only 30–38 targets of a 64-target chunk fit), taken before Slice 4 excluded the
shared display entries from the per-snapshot charge. The conclusion is in
[CBS rendering](../structure/cbs-rendering.md#display-transform).

## Command and fixture

```bash
node util/playwright/measureTransformLua.mjs --snapshot --messages 2000 --message-bytes 3100
```

The server runs in process. One character (no lore, no scripts, no default variables) owns a 2,000-message chat of
3,100-byte prose messages (6,200,000 source bytes, 5.91 MiB) with a module whose Lua `editDisplay` appends a marker. Each
64-target chunk (the newest 64, then the oldest 64) is sent with `handlers` and `noCache`, so every target takes the
two-call path; a simulated tab handler appends a second marker and the driver sends the continuation. The driver's
header says how each figure is derived from `stats()`; the charges are the service's accounting, not heap.

## Result

| Chunk  | Scope charge (after the shared-entry exclusion) | Per-target charge | Pending of 64 | Refused | Chunk's own snapshot charge |
| ------ | ----------------------------------------------- | ----------------- | ------------- | ------- | --------------------------- |
| Newest | 39,082 B                                        | 55,366 B          | 64            | 0       | 3,582,506 B (3.42 MiB)      |
| Oldest | 39,082 B                                        | 55,366 B          | 64            | 0       | 3,582,506 B (3.42 MiB)      |

Shared entries, charged once against `MAX_RETAINED_BYTES` (64 MiB) and not per snapshot: the transcript 6,636,704 B,
the configuration 52,560 B. The transcript is the former 6.7 MiB per-scope charge.

A target's charge is `SNAPSHOT_TARGET_BYTES` (48 KiB), its source, its text after Lua, and one character entry. Under
`MAX_SNAPSHOT_BYTES` (8 MiB) this scope admits 150 such targets, so a 64-target chunk fits with 4,806,102 B to spare.
A chunk stops fitting whole only when the request-owned scope (the character and its per-request wrappers) passes about
4.6 MiB, or each message passes about 40 KB (`48 KiB + 2 × text` per target); a character's `defaultVariables` add
12 times their bytes to every target. A scope alone passes the limit only near 8 MiB of character data.

## Decision

By the slice's rule, `MAX_SNAPSHOT_BYTES` stays at 8 MiB: a realistic scope alone is about 0.5% of it.

A control run with 200 messages of 60,000 bytes (`--message-bytes 60000`) charged 169,166 B per target: 49 of 64
pending and 15 plain (non-permanent) refusals per chunk, which the tab's recovery retries with the failed rows only.
