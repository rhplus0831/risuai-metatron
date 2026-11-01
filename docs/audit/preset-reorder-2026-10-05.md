# Preset Reorder, 2026-10-05

Moved from `docs/structure/settings-i18n.md` (`Known Hazards`) at commit `0a24a71eb`, with the table and the reasoning of
the archived settings-pages plan, `git show 39a8677db^:docs/plan/phases/slices/phase-6-thin-client-and-closeout/readers-settings-pages.md`.
The guide keeps the conclusion.

## Setup

`util/playwright/measureRecords.mjs`, production builds, headless Chrome, with the baseline `35678fd4` measured alongside
on the same machine. Task-latency medians of 10, two runs each.

## Results

| Workload                              | Baseline `35678fd4` | `3ea20656`, as recorded | `5b47b2b3`, 2026-10-05 |
| ------------------------------------- | ------------------- | ----------------------- | ---------------------- |
| NovelAI image settings mount          | 4.7–5.1 ms          | 4.6–4.7 ms              | 4.7–4.8 ms             |
| A keystroke into `NAIImgConfig.width` | 9.2–10.4 ms         | 9.8–10 ms               | 9.2–9.5 ms             |
| Preset reorder, 50 presets            | 15.9–16.0 ms        | 22.2–24.4 ms            | 17.9 ms                |

The reorder went from about +45% to about +12%: the rows compare each preset's id with the selected id derived once,
instead of reading the selected index, a search of the list, for every row. The target was within 10% of the baseline,
17.5–17.6 ms, so 17.9 ms misses it by about 2%.

Keyed rows (`(preset.id)`) were tried at `5b47b2b3` and were slower, 18.4–20.1 ms. They were not re-measured.

The remaining cost is the rows reading each preset through its record wrapper after the reorder. A plain-row projection
(each row's `id`, `name`, and `image` read once) could reduce the repeated wrapper reads but not remove them; it was not
tried or measured. Removing them needs a tracked raw read of the record for display, which departs from the wrapper
reads the records were designed around.

## Later runs

On 2026-10-07 the same reorder measured 17.9–18.2 ms at `2f658598`, against 17.5–17.8 ms at `6fa405d1`. The
[projection bindings audit](projection-bindings-2026-10-04.md) holds these numbers beside the lorebook drag's.
