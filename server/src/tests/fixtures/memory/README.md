# Memory algorithm fixtures

## `scenarios.ts`

Source-defined, deterministic scenario inputs shared by `server/src/tests/memoryAlgorithms.test.ts`
and `src/ts/process/memory/memoryOracle.test.ts`. Edit it like test code.

## `algorithms.json`

A frozen capture, not regenerable on the current checkout. Its `capturedFrom` field records the
provenance: the flag-off client algorithms as committed at `3f5416d5`, recorded by
`memoryOracle.test.ts` on 2026-10-03, before the move to the server deleted the browser SupaMemory,
HypaV2, and Hanurai implementations. The capture mode has since been removed from the test. The
`supa`, `hyper`, `v2`, and `hanurai` cases have no client runner any more; only the HypaV3 cases
(`v3`, `v3exp`) are still verified against the client by `memoryOracle.test.ts`, while
`memoryAlgorithms.test.ts` holds the server ports to the whole file.

The fixture is the client's recorded behavior, never derived from server code. A parity difference is
a defect to attribute, not a reason to recapture. A deliberate change to an algorithm's outcome is a
reviewed, hand-edited change to the affected case, made in the same commit as the code, and the
commit message says which case changed and why.

The `hanurai-plain` and `hanurai-split-paragraphs` cases were hand-edited on 2026-10-17 to record the
corrected results: retained messages are excluded, dropped messages appear once in ranking order,
and returned card text has no stray leading space.
