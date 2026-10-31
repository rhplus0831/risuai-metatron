# Boot Measurements, 2026-10-29

Moved verbatim from `docs/structure/persistence.md` (`Known Hazards`) at commit `87e20a26d`; the guides keep the conclusions.

Boot bytes per scenario, measured 2026-10-29 with `util/playwright/measureBoot.mjs` on production builds (headless
Chrome 156, CDP-throttled to 10 Mbps and 40 ms; `reported` medians of 3 runs, `audit` 1 run; the server's SQLite store
on tmpfs): "before" at `4a95f84bf`, "after" at `cf52c760b`, once app scripts were precompressed, "last chatted" came
from the chats, the reconnect skipped a listing its `hello` digest matched, and chat collections and inlays joined the
boot cache. `reported` is 14 asset-heavy modules (~130k asset tuples), 18 ~250 KB characters with one chat each and 50
presets (42 records). `audit` is 300 characters with 10 chats each (~13.7 KB of memory metadata per chat), 20 modules,
50 presets, 10 disabled ~100 KiB plugins, ~2 MiB of plugin storage and 300 inlays (625 records, 3,000 chats). Bytes
are the boot answer's body (zstd level 1 from 32 KiB up, else identity; the browser's wire count adds about 300
bytes). "Main screen" is the time until the loading screen is gone. The synthetic texts repeat, so they compress
better than real ones. `module` and `character` (a route edit of one module or character) were not in the before run.

| Scenario                                                      | `reported` body / decoded, before → after         | `reported` main screen | `audit` body / decoded, before → after            | `audit` main screen |
| ------------------------------------------------------------- | ------------------------------------------------- | ---------------------- | ------------------------------------------------- | ------------------- |
| `plain` (boot route blocked, identity)                        | 21,670,239 / 21,670,239 → 21,670,239 / 21,670,239 | 20.9 → 18.3 s          | 57,296,953 / 57,296,953 → 57,386,953 / 57,386,953 | 47.9 → 47.7 s       |
| `cold` (boot cache deleted)                                   | 6,997,601 / 21,672,876 → 6,991,211 / 21,672,925   | 6.7 → 6.6 s            | 2,370,926 / 57,299,836 → 2,372,325 / 57,389,885   | 3.6 → 3.4 s         |
| `warm` (nothing changed)                                      | 25,509 / 25,509 → 16,991 / 16,991 (identity)      | 0.67 → 0.62 s          | 176,254 / 4,421,144 → 19,907 / 3,182,319          | 1.38 → 1.10 s       |
| `module` (one module's assets edited)                         | 441,238 / 1,155,223                               | 1.05 s                 | 47,092 / 3,600,134                                | 1.15 s              |
| `character` (one character edited through the route)          | 53,106 / 266,669                                  | 0.61 s                 | 27,980 / 3,325,911                                | 1.08 s              |
| `send` (one send in the tab, reload)                          | 53,468 / 275,220 → 17,495 / 17,495 (identity)     | 0.76 → 0.63 s          | 183,459 / 4,564,759 → 20,451 / 3,186,578          | 1.38 → 1.10 s       |
| `otherDevice` (send while the tab is shut)                    | 53,472 / 275,222 → 17,495 / 17,495 (identity)     | 0.98 → 0.86 s          | 183,471 / 4,564,759 → 20,452 / 3,186,578          | 1.63 → 1.33 s       |
| `selfEdit` (description saved in the tab)                     | 52,307 / 275,242 → 51,881 / 266,689               | 0.69 → 0.63 s          | 183,597 / 4,564,779 → 27,978 / 3,325,921          | 1.41 → 1.15 s       |
| `resume` (31 s hidden): listing wire / decoded, `hello` bytes | 9,541 / 9,241, 95 → 0 / 0, 139                    | -                      | 88,583 / 574,640, 95 → 0 / 0, 139                 | -                   |
| `scripts` (HTTP cache cleared): static files wire / decoded   | 4,235,728 / 4,231,564 → 986,174 / 4,241,727       | 4.26 → 1.56 s          | 4,234,804 / 4,230,940 → 986,174 / 4,241,727       | 5.05 → 2.14 s       |

- **A send no longer misses a character.** Before, `send`, `otherDevice` and `selfEdit` each re-sent one whole
  character (about 250 KB decoded on `reported`, 144 KB on `audit`), because the server stamped `lastInteraction` on
  every send. Now only `selfEdit`, a real edit, does; a send re-sends that character's chat collection (on `audit`
  3,793 summary and 509 order bytes decoded). The summaries' `lastMessageAt` added 90,000 decoded bytes on `audit`
  (3,000 chats) and 172 bytes to their compressed omission delta when it landed (75,547 → 75,719).
- **What `warm` carries.** Before, on `audit` (decoded / compressed omission delta): chat summaries 1,052,194 /
  75,417, chat orders 152,893 / 69,173, inlays 80,291 / 18,743, plugins 1,024,849 / 25, plugin storage 2,051,111 /
  154, claimed characters 34,726 / 1,638. After, the summaries and orders shrink to `cachedChatCollections` (11,701
  / 773) and the inlays to their `cached` stubs (34,801 / 5,073); what is left is mostly `plugins` and `pluginStorage`
  (about 3 MB decoded, a negative delta), which stay out of the cache. The settings kinds are each under 3 KB decoded.
  Omission deltas do not add up and can be negative.
- **The server's summary read.** `readSummaries` (`readKinds([], { chatSummaries: true })` on the run's reopened
  store, last-message memo filled on first use) took 120 ms first and 73 ms median for 3,000 chats (80 ms before the
  memo) and under 1 ms for 18 while it parsed each chat's whole metadata; since it reads the stored projection
  (`chatSummaries`, [self-host server](../structure/self-host-server.md) State), a one-off run on a busy machine with 18 KiB of
  metadata per chat took about 28 ms first and 9 ms median against 86–123 ms and 67 ms before. The HTTP incremental
  cost of `chatSummaries=1` is 86 ms and 0.2 ms (92 and 2 ms before). A warm boot skips it for every claimed
  collection: the unthrottled server TTFB of `audit` `warm` was 114 ms just before chat collections were cached and is
  41 ms now.
- **Reconnect.** An unchanged `resume` reads no listing; the `hello` grows from 95 to 139 payload bytes (its digest).
  The server's digest step (`revisionDigest(listRevisions())` over the `audit` fixture's 625 records, 3,000 chats and
  300 chat orders, in process on its reopened store) took 11.0 ms median and 21 ms p95 (`listRevisions` 6.4 ms, the
  digest 4.1 ms). A change made while the tab was away still costs one full listing (about 88.6 KB on the wire on
  `audit`); no scenario measures it.
- **Scripts.** Static files go out as their precompressed siblings: 23% of their decoded bytes on the wire. A cold
  boot's own answer was already compressed, so `cold` and `plain` are unchanged within noise.
