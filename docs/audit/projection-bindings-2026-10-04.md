# Projection Bindings, 2026-10-04

Moved verbatim from `docs/structure/persistence.md` (`Known Hazards`) at commit `87e20a26d`; the guides keep the conclusions.

## Record wrapper cost

The records are deep write-through wrappers without a resolve cache (a cache halved the cost, but its invalidation
rule was never proven). The projection benchmark (`projectionBindings.test.ts`, dev mode, 2026-10-04) measured about
6× a direct write for a nested leaf write (13 µs against 2 µs), 4.3–4.5× for a 300-entry lorebook drag (28 ms against
6 ms), and 3.3–3.8× for a preset reorder, against an intended 2×. In the production build the cost shows in list
re-renders reading every row through its wrapper (`measureRecords.mjs`, headless Chrome, medians of 10): the 50-preset
reorder went from 15.3 ms to 22.2–24.4 ms and the 300-entry module lorebook drag from 92–93 ms to 104–107 ms when the
records became the source of truth (commit `3ea20656` against `35678fd4`); at commit `2f658598` they measure 17.9–18.2
ms and 106–107 ms (against 17.5–17.8 ms and 103–105 ms at `6fa405d1`). Both handlers already change their list in one
write (`moveRecordListItem`, `replaceRecordList`).

## Typing into a settings field

The save echo cycle of `noteRemoteChanges`.

Measured with 100 keystrokes 50 ms apart (about 5 s) into a settings field (`measureRecords.mjs`): 35–52 batches at
commit `6fa405d1`, but 9 at `2f658598`, which is the debounce cadence. At `2f658598` the extra saves were not
reproduced; the 50 ms echo cycle remains in the code.
