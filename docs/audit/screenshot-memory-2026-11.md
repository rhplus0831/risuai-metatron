# Screenshot export memory

Measured 2026-11-09 at `a48ce0835` (the gate commit, with E3's `@import` webfont fixture) by the Found Issues Clearance
plan's slice E4 (Q10), in headless Google Chrome 156.0.8078.47 at device pixel ratio 1. It follows the Render Work
Budget run ([audit](render-work-budget-2026-11-05.md#acceptance-after-slices-14)), whose 600-row export raised the
renderer's `VmHWM` by 3,987 MiB while one page's RGBA is 50.8 MiB. The rule the slice was given: the export's peak stays
under one page plus the largest row, or this file says by how much it misses and why. It misses; the conclusion is in
[UI and theming](../structure/ui-theming.md#limitations).

## Command and fixture

```bash
ROWS=30,150,600 SCENARIOS=screenshot RENDER_OUT=<file> util/playwright/offline.sh node util/playwright/measureRenderWork.mjs
```

The fixture is the driver's (its header describes it): alternating user and assistant rows, each assistant row with a
500-rule sheet behind a webfont `@import`, KaTeX prose, and code fences. E4 added two driver outputs: each download
event samples the renderer's and the GPU process's `VmHWM` and `VmRSS` (`export.pageSamples`; the samples are
cumulative since the pre-export reset, and a notification can overlap the next page), and `RENDER_HEAP_SNAPSHOT=<file>`
writes a heap snapshot after the export, outside the export's own figures. The tallest page is 816 × 16,308 (50.8 MiB
RGBA); the largest fixture row is under 1,200 px tall (under 3.7 MiB), so the target is about 55 MiB.

## Result

Peak rise is the largest sampled `VmHWM` minus the value right after the pre-export reset. "Before" is the source at the
gate commit; "after" is the committed source (only Q10 changed the capture path, so ordinary rows are captured as
before). Single runs; the 600-row figures differ by 20 % in the direction no code change explains, which is the
run-to-run noise of this measurement.

| Rows | Pages | Peak rise before | Peak rise after | Miss after (vs about 55 MiB) | End RSS before / after | Export s before / after |
| ---: | ----: | ---------------: | --------------: | ---------------------------: | ---------------------: | ----------------------: |
|   30 |     2 |          655 MiB |         627 MiB |                      572 MiB |          990 / 965 MiB |              12.5 / 7.1 |
|  150 |     7 |        1,504 MiB |       1,423 MiB |                    1,368 MiB |      1,869 / 1,824 MiB |             33.8 / 34.6 |
|  600 |    25 |        3,269 MiB |       3,945 MiB |                    3,890 MiB |      3,991 / 4,361 MiB |           244.4 / 142.0 |

Renderer `VmHWM` / `VmRSS` per page at 150 rows, MiB (the GPU process stays at 92–97 MiB throughout):

| Page | Before        | After         |
| ---: | ------------- | ------------- |
|    1 | 1,077 / 980   | 1,051 / 882   |
|    2 | 1,467 / 1,425 | 1,498 / 1,434 |
|    3 | 1,606 / 1,545 | 1,629 / 1,538 |
|    4 | 1,743 / 1,667 | 1,762 / 1,702 |
|    5 | 1,868 / 1,812 | 1,876 / 1,777 |
|    6 | 1,962 / 1,844 | 1,882 / 1,795 |
|    7 | 1,962 / 1,869 | 1,882 / 1,824 |

At 600 rows (pages 1, 5, 10, 15, 20, 25): before 1,480 / 3,013 / 3,528 / 3,948 / 4,119 / 4,146 MiB `VmHWM`, after
1,451 / 3,472 / 3,898 / 4,210 / 4,398 / 4,760 MiB. At 30 rows both pages read 1,015 MiB before and 983–984 MiB after.
The pre-export renderer was 357–459 MiB for 30 and 150 rows and 852–877 MiB for 600.

## What grows with rows

Controls at 150 rows, each installed before its own dev stack (the peak rise of one run each):

| Control                                                                              |       Peak rise |
| ------------------------------------------------------------------------------------ | --------------: |
| Full capture (before)                                                                |       1,504 MiB |
| Blank row canvases of the same sizes, same page canvases, PNG encoding and downloads |          77 MiB |
| Clone with styles, fonts and images only (no serialization, no decode)               |         727 MiB |
| Clone and SVG serialization, no decode                                               |         905 MiB |
| Serialization and decode, no draw into the row canvas                                |       1,497 MiB |
| Full capture, then clear the decoded image's `src` and handlers per row              |       1,457 MiB |
| Full capture, then empty the clone's styles and children per row                     |       1,490 MiB |
| Full capture, wait 11 s after each page (download URLs revoked)                      |       1,266 MiB |
| Full capture, CDP garbage collection after each page / after each row                | 1,020 / 501 MiB |

- The page canvases and the PNG Blobs are not the growth: with blank row captures the same paging stays at 77 MiB, and
  150 rows produce 6.6 MiB of PNG.
- The growth is html-to-image's per-row work: the clone with every computed property inlined on every element (768
  properties in the app, 289 of them custom properties from the document root), its SVG serialization (151 rows made
  252 M characters of data URL, up to 2.75 M for one row), and the decoded SVG image with its own document.
- Nothing holds it. After the export and a collection, the heap snapshot has no row document, canvas or data URL, and
  html-to-image's resource cache is empty for this fixture. The browser reclaims the garbage lazily, so it piles up
  across rows; releasing references per row or per page changes little, and only a forced collection (not available
  to page code) bounds it. After the final collection the renderer still holds 966 MiB at 150 rows, of which about
  180 MiB is the DevTools Network domain the driver keeps enabled (it records every data URL); the rest is native
  memory the snapshot cannot attribute (allocator retention or browser caches).

## The property-list reduction

Copying only the non-custom properties (`includeStyleProperties`) cuts the per-row clone the most:

| Candidate                                                                       | Rows |           Peak rise |       Export s |
| ------------------------------------------------------------------------------- | ---: | ------------------: | -------------: |
| Drop every custom property                                                      |  150 |             762 MiB |           20.4 |
| Drop the custom properties declared only on the document root (stylesheet scan) |  150 |           1,435 MiB |           50.3 |
| Drop the custom properties constant inside each row, restore them once per row  |   30 |             278 MiB |            3.8 |
|                                                                                 |  150 |             720 MiB |           18.9 |
|                                                                                 |  600 | 2,264 and 2,661 MiB | 82.5 and 116.8 |

None shipped, because none kept the capture's pixels for supported styling:

- Dropping every custom property loses the values an `<svg>`'s children read: html-to-image copies no styles onto an
  svg's descendants, which resolve `var()` from the svg element's copied custom properties.
- The stylesheet scan falls back to the full list as soon as one sheet is unreadable; the app's KaTeX sheet comes from
  a CDN without CORS, so every export fell back.
- The per-row candidate compared each descendant's computed custom values with the row's and kept every name declared
  inline or in a `<style>` inside the row. Twelve crafted and fixture rows matched the full-list capture with zero
  differing pixels, but two did not (9,600 pixels each): an inline `--x` masked by an outside rule (fixed by keeping
  inline names), and a `::before` whose own rule overrides `--x` that a style inside the row reads (not handled; the
  per-row pass reads no pseudo-element values).

## Decision

Q10 shipped: a row whose capture at the device ratio exceeds `MAX_EXPORT_PIXELS` or `MAX_EXPORT_SIDE` gets one pixel
ratio, bounded from its CSS size, that planning and capture share (`pixelRatio` with `skipAutoScale`), and its own page.
In a real browser, a 2,400 × 8,192 CSS-pixel row at ratio 2 exports as one 4,330 × 14,780 PNG (63,997,400 pixels); the
counterexamples 3,471 × 8,197 at 1.5 and 10,000 × 20,000 at 2 stay under the budget too.

The peak target is missed by the amounts above. A per-page release cannot meet it: the growth is per-row garbage that no
reference keeps alive. A future attempt would make the clone smaller rather than release it, for example the per-row
property list above with pseudo-element values compared too, or a capture path that copies only the properties that
differ from their inherited or initial value; either needs the same pixel comparison against the full-list capture.
