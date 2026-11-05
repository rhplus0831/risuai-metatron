# Render Work Budget Measurements (2026-11-05)

The numbers behind the [Render Work Budget plan](../plan/render-work-budget.md) (D9): how much render work the chat
screen does for a styled, auto-translated chat, how much of it still runs after the chat is left, how many times one
stylesheet is prepared, the mount profile at 30, 150 and 600 rows, and the screenshot export's peak memory. This
document holds the **baseline**, measured before Slices 1–4 changed any code. The comparison run after those slices
adds its table and the acceptance verdicts below, with the same driver and command.

## Setup

- Driver: `util/playwright/measureRenderWork.mjs`, unchanged between the baseline and the comparison. Its header
  describes the fixture, the scenarios, the settling rule and every environment variable; the
  [test harness guide](../structure/test-harness.md#check-and-measurement-scripts) has the coverage and peak-memory
  recipes it uses.
- Command, on a Linux host with no other dev stack of the checkout running:
  `RENDER_OUT=<file> RENDER_TRACE_DIR=<dir> util/playwright/offline.sh node util/playwright/measureRenderWork.mjs`
  (defaults: `ROWS=30,150,600`, all five scenarios, `SWITCH_DELAY_MS=100`).
- Baseline run: commit `d8df968ba` (no Render Work Budget slice landed), 2026-11-05, 525 s wall time, no driver error,
  no page error, no unexpected egress. Node 24.21.0, headless Chrome 156.0.8078.47, AMD Ryzen 9 3900X (24 logical
  CPUs), viewport 1280 × 800, no CPU throttling.
- Fixture: per scenario a fresh browser context and a freshly seeded chat of N messages plus the greeting, alternating
  short user rows and assistant rows; every assistant row carries the same 500-rule `<style>` (25,280 bytes) and 12
  short code fences. A per-scenario nonce in every row's prose makes every cache miss (server transform, tab transform
  results, LLM translation). The character has one `editdisplay` regex script, so every row posts `/api/transform`
  targets. The chat auto-translates with the LLM translator (`autoTranslateCachedOnly` off, the default formatting
  flags: `markParsing` takes `ParseMarkdown("pretranslate")`, `translateHTML`, `postTranslationParse`) against a local
  mock provider that answers after 75 ms. `ui.chatLoadInitialPages` is N, so the open mounts N rows.
- Counts are invocations from CDP precise coverage with `detailed: true` (async resumptions excluded), over the
  scenario's measured phase only. Timings and the trace come from the separate `profile` scenario, which runs without
  coverage.
- Kept out of git (13.5 MB of traces, a 51 MB JSON): the traces `profile-30.json.gz` (723,534 bytes, SHA-256
  `8b8c9057…`), `profile-150.json.gz` (2,619,597 bytes, `388df0d7…`), `profile-600.json.gz` (10,186,497 bytes,
  `f1bbd3cc…`) and the run's JSON (`1d1f1e24…`) are in the main checkout's git directory under
  plan-runner/render-work-budget/5a-baseline/. Rerun the command for fresh copies.

## Scenarios

- `open`: open the chat and wait until every row shows its translated body and no transform, translation or provider
  request has been active for 1.5 s. Counts over the whole open.
- `profile`: the same open without coverage, under a `Tracing` capture: first-visible (the first row's body on
  screen), settled, long tasks (renderer main-thread tasks of 50 ms or more), frame gaps (intervals between `DrawFrame`
  events, idle time included).
- `switch`: open the chat and select the home screen 100 ms after the open click (no chat row stays mounted). "Before"
  counts run until the switch, "after" counts from the switch until quiet: everything after is obsolete work.
- `switch-mounted`: the same, but 100 ms after all N message rows are mounted, so the deferred rows' pipelines are in
  flight at the switch.
- `screenshot`: open, settle, collect garbage, reset the renderer's and GPU process's `VmHWM`, run the chat menu's
  screenshot, read every downloaded file.

## Baseline

### Open

| Metric                                            |      30 |       150 |       600 |
| ------------------------------------------------- | ------: | --------: | --------: |
| Rows mounted (with the greeting)                  |      31 |       151 |       601 |
| `markParsing` runs                                |      62 |       302 |     1,202 |
| `ParseMarkdown`                                   |      31 |       151 |       601 |
| `serverProcessScript`                             |      31 |       151 |       601 |
| `translateHTML`                                   |      31 |       151 |       601 |
| `translateLLM`                                    |      31 |       151 |       601 |
| `decodeStyleContent` (= `css.parse` of css-tools) |      15 |        75 |       300 |
| CSS preparations of the one distinct sheet        |      15 |        75 |       300 |
| Sheets in the chat's `ChatStyleRegistry`          |       1 |         1 |         1 |
| `/api/transform` requests / targets               |  4 / 31 |   7 / 151 |  19 / 601 |
| Provider translation requests / distinct texts    | 31 / 31 | 151 / 151 | 601 / 601 |
| Most provider requests for one text               |       1 |         1 |         1 |

`getLLMCache` ran 0 times (the cached-only probe is off). `scopeCss` is absent from today's code; the comparison counts
it.

### Mount profile

| Metric                       |           30 |          150 |               600 |
| ---------------------------- | -----------: | -----------: | ----------------: |
| First visible (ms)           |        550.6 |        945.9 |           2,377.0 |
| Settled (ms)                 |        3,239 |        6,758 |            26,748 |
| Long tasks ≥ 50 ms           |            0 |            0 |                16 |
| Long tasks, total / max (ms) |            — |            — | 3,081.7 / 1,960.9 |
| Frame gap median / p95 (ms)  | 42.4 / 181.7 | 47.0 / 161.0 |      62.0 / 131.0 |
| Frame gap max (ms)           |        418.4 |      2,231.7 |           8,039.9 |
| Frame gaps over 50 ms        |            8 |           18 |               172 |

### Switch away 100 ms after the open

| Metric                                              |    30 |   150 |   600 |
| --------------------------------------------------- | ----: | ----: | ----: |
| Switch after the open click (ms)                    |   139 |   129 |   157 |
| Message rows mounted / translated at the switch     | 3 / 0 | 3 / 0 | 3 / 0 |
| After: `ParseMarkdown`, `markParsing`               |  0, 0 |  0, 0 |  0, 0 |
| After: `translateHTML`, `translateLLM`              |  4, 4 |  4, 4 |  4, 4 |
| After: `decodeStyleContent`                         |     2 |     2 |     2 |
| After: transform targets sent / crossing the switch | 0 / 4 | 0 / 4 | 4 / 0 |
| After: provider translation requests                |     4 |     4 |     4 |

### Switch away 100 ms after all rows mounted

| Metric                                              |      30 |      150 |      600 |
| --------------------------------------------------- | ------: | -------: | -------: |
| All message rows mounted, from the open (ms)        |     636 |    1,650 |    4,074 |
| Switch after that (ms)                              |     150 |      455 |    2,537 |
| Message rows mounted / translated at the switch     |  30 / 3 |  150 / 3 |  600 / 3 |
| After: `ParseMarkdown`, `markParsing`               |    0, 0 |     0, 0 |     0, 0 |
| After: `translateHTML`, `translateLLM`              |  27, 27 | 147, 147 | 547, 547 |
| After: `decodeStyleContent`                         |      13 |       73 |      273 |
| After: transform requests / targets sent            |   0 / 0 |  5 / 129 | 10 / 382 |
| Transform targets crossing the switch               |      27 |       18 |      129 |
| After: tab translation requests / provider requests | 27 / 27 |    0 / 0 |    0 / 0 |

### Screenshot

| Metric                                        |                            30 |         150 |         600 |
| --------------------------------------------- | ----------------------------: | ----------: | ----------: |
| Export duration (ms)                          |                         9,304 |      37,820 |     193,435 |
| Files / valid PNGs                            |                         1 / 1 |       1 / 0 |       1 / 0 |
| PNG size                                      | 816 × 20,322, 1,416,811 bytes |     0 bytes |     0 bytes |
| Renderer `VmHWM` before the export (MiB)      |                           443 |         605 |       1,556 |
| Renderer `VmHWM` rise during the export (MiB) |                           732 |       1,909 |       6,225 |
| Renderer `VmRSS` after (MiB)                  |                         1,028 |       2,348 |       7,034 |
| GPU process `VmHWM` rise (MiB)                |                  none (−11.3) | none (−3.5) | none (−2.8) |
| JS heap after collection (MiB)                |                          62.8 |       101.6 |       239.2 |

The `clear_refs` reset worked for both processes in every scenario, so the rise is the export's own peak. A negative GPU
value means its peak after the reset stayed below the reading taken right after it.

## Observations

- Every styled row prepares its CSS itself: 15, 75 and 300 preparations of one identical sheet, which the registry
  then shares as one sheet (F2). The pending-body re-preparation F2 also describes did not appear in this fixture
  (`decodeStyleContent` equals the styled row count on `open`).
- Each row runs `markParsing` twice on the auto-translate path: the first run only decides to translate and flips
  `translated` after 10 ms, the second parses, translates and restores. Rows unmounted before that flip do no further
  work, which is why a switch 100 ms after the open leaves only four obsolete translations, whatever N is (the staged
  opening has mounted three message rows by then).
- With every row mounted, the switch leaves the translation stage running for every row not yet translated (27, 147,
  547 `translateLLM` calls) and its rows' CSS preparation (13, 73, 273 `decodeStyleContent` calls), and sends
  transform targets nobody will show (129 and 382 at 150 and 600 rows, plus those in flight). `ParseMarkdown` after the
  switch is 0 because every row's pretranslate parse had started before it (F4).
- Translation requests reaching the provider after the switch varied: 27 at 30 rows (the tab's requests ended
  `net::ERR_ABORTED` after the provider had received them), none at 150 and 600 rows in this run, while a development
  run at 150 rows that switched 399 ms after the mount saw 147. The cause was not investigated; the `translateLLM`
  count is the stable measure, and the provider count is reported beside it.
- No text was requested from the provider twice in any scenario: duplicate translation billing was not reproduced
  (D4's in-flight map stays a bound).
- At 600 rows the open has 16 long tasks (the longest 1.96 s) and an 8.0 s frame gap before it settles at 26.7 s;
  at 30 and 150 rows it has none of 50 ms or more (F6).
- The screenshot of 150 and 600 rows downloads an empty file and still shows "Screenshot Saved": the merged canvas
  exceeds what the browser can encode, while the renderer's peak rises by 1.9 GiB and 6.1 GiB. One 30-row page of RGBA
  (816 × 20,322) is 63 MiB, against a 732 MiB rise (F7).

## Acceptance after Slices 1–4

From the plan's Slice 5, judged on the comparison run (the after counts of `switch-mounted` are the obsolete work at
full mount).

| Acceptance                                                                  | Baseline (30 / 150 / 600)                                    | After | Verdict |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- | ------- |
| Zero obsolete parser invocations after a switch                             | `decodeStyleContent` 13 / 73 / 273                           |       |         |
| Zero obsolete translation invocations after a switch                        | `translateLLM` 27 / 147 / 547                                |       |         |
| No transform target sent after the switch; in-flight ones at most one chunk | sent 0 / 129 / 382, crossing 27 / 18 / 129                   |       |         |
| One preparation per distinct sheet                                          | 15 / 75 / 300                                                |       |         |
| Screenshot peak under one page's RGBA plus the largest row                  | +732 MiB / +1,909 MiB / +6,225 MiB, empty PNG at 150 and 600 |       |         |
