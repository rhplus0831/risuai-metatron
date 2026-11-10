# Figures From Plan Close-Outs

Numbers that finished plans measured and that the [plan archive](../../archived-plan/README.md) carried in its close-out notes until 2026-11-11. Each is a snapshot from the named slice on the machine and fixture that slice used; none was re-measured when it moved here. Where a plan has its own report in this folder, the figures are there instead and are not repeated.

A heading is the plan; its text, with the full tables, is `git show <commit>:<path>` from the archive's table.

## Boot Resource Cache

- On a synthetic server of the reported shape at 10 Mbps, the main screen came after 18.3 s with the uncompressed plain read, 6.5 s on a first (cold) boot, and 0.51 s on a warm boot (Slice 4, `util/playwright/measureBoot.mjs`).

## Heap Memory Reduction

- The driver's JS self size at boot went from 191.3 MB to 61.6 MB, and asset tuple proxies from 132,600 to 0.
- D3 candidate: a server-deleted module's assets stayed reachable, +17.2 MB in the driver's `boot-module-delete` step.
- D2b, `measureFileSources.mjs` on 2026-10-23 (production build, 21 avatars, 24 inlay images, 4 chat assets, 2 audio inlays): 0 live object URLs, 0 Blobs, and 0 `/api/read` at every step in `sw` (direct) mode, against 51 Blobs (40.5 MB) and 51 object URLs (49 `image/png`, 2 `audio/mpeg`) in `no-sw` mode.

## Search

- The `LIKE` message scan took 516–674 ms over 145 MiB of seeded messages.

## Chat Checkpoints

- CC4, a 2000-message chat of about 10 MB: an auto checkpoint takes about 110–170 ms synchronously when it saves and about 30 ms when nothing needs saving.

## Direct Asset URLs

- DA7, `util/playwright/measureFileSources.mjs`: direct mode keeps 0 object URLs, 0 Blobs, and 0 `/api/read` reads at every step; without the worker the gallery keeps 51 object URLs (40.5 MB), unchanged from Heap Memory Reduction D2b.

## Server Thumbnails

- ST5, 121 catalog images, production build: decoded pixel bytes 612.8 MiB → 42.8 MiB; server transfer 47.1 MiB of originals → 1.0 MiB of variants; 0 redirects. The no-worker fallback stays at 612.8 MiB.

## Combine Audit Fixes

- Slice 4, the audit's scan reproduction: filling 400 portraits visits 400 cache entries instead of 80,200.

## Display Evaluation

- After all slices: a 500-target cold render parses 1,116 times instead of 4,849; a stamp-only save keeps all 500 hits; 10 non-matching regex scripts take 274–314 ms instead of 1,033–1,193 ms.
- The first remount after a send refetches 28 of 30 rows once, about 35 ms of server time and 90 KB.

## Boot Bytes and Per-Event Server Work, closed by Incremental Chat Transport

- A reconnect after a change made while hidden reads a 536-byte replay instead of the 88,727-byte listing (measureBoot resume-away, 425 → 358 ms).
- The by-id read for an over-cap change of a loaded chat: the mixed fixture's 4 over-cap entries read 394,652 bytes of rows instead of 967,029 of whole chats.
- Row diffs for a reply past 64 KiB: about 1,700 bytes per checkpoint, 0 observer whole reads instead of 4.
- The owner's `chatPatch` naming its streamed row: 33,265 → 498 bytes per checkpoint.
- Slice 0, the validated message position index: 200 updates at 10,000 messages took 1,290.9 → 0.5 ms.

## Server Byte Budgets

- Measured on one machine (ext4, Node 24.21) at `228b23f6d` against the `ac823f673` baseline. Three cases ended worse, and the audits record them as such: the summary read (14.1 → 14.9 ms, a fixture with little chat metadata); the 5,000-message install interval (107.7 → 164.8 ms; the interval now holds the SQL copy and index maintenance, and the serving thread's synchronous work fell from 177.7 to 164.8 ms); the first checkpoint `save` (91.5 → 100.7 ms, cause not isolated).

## Guide Budgets

- Guides went from 17 files and 1,156,344 bytes to 23 files and 864,053 bytes, and the largest leaf from 116,767 to 6,950 bytes.

## Guides To Source

- The guides tree went from 1,055,065 to 824,152 bytes (21.9% cut, about 104,000 bytes short of the plan's 720,000 expectation), and STRUCTURE.md from 33,151 to 19,083 bytes.
- Whole-file guide reads fell from 30.6% of section-capable reads before `docs:read` to 5.7% in waves 2 and 3 ([guide reads, wave 3](guide-reads-2026-11-05-wave3.md)).

## Asset Lifecycle

- The sweep's synchronous turn re-marks the whole live store in about 1.7 s idle and 2.8–3.1 s under load on the audit seed ([asset scan](asset-scan-2026-11-05.md)).

## Plugin Storage and Data API

- `util/playwright/measurePluginData.mjs`, 300 characters and 3,000 chats: a `pluginStorage.setItem` save 2,051,203 → 244 bytes; a plugin toggle 1,026,620 → 229 bytes.
- `getDatabase(["characters"])`: 300 sequential reads (about 30 s) → 7 cold and 1 on a repeat call.
- An unchanged `getDatabase` → `setDatabase` round trip: 27.4 s and 300 reads → 6.8 s and 39 reads (the characters whose chats the cache evicted).

## Chat Store and Structured Memory Sweep

- B10: only 9 of about 2,190 token counts per send were repeats, so memoizing them did not lower `selectMemory` time.

## Module Headers

- Coverage over each guide's named `Files` source paths, before (at `0c137ab45`) and after, as paths without a module header and exports documented:

  | Guide            | Paths without a header | Exports documented      |
  | ---------------- | ---------------------- | ----------------------- |
  | self-host-server | 22 of 26 → 0           | 99 of 145 → 145 of 145  |
  | chat-pipeline    | 30 of 36 → 0           | 188 of 228 → 228 of 228 |
  | global-api       | 9 of 21 → 0            | 158 of 198 → 196 of 198 |
  | llm-requests     | 34 of 58 → 0           | 185 of 320 → 320 of 320 |
  | persistence      | 12 of 29 → 0           | 439 of 553 → 540 of 553 |

- The exports left are in files other guides own (`src/ts/storage/resourceSync.svelte.ts`, `shared/translatorPresets.ts`, `src/ts/storage/pluginStorageStore.svelte.ts`).

## Found Issues Decisions

- D2: a 2,000-run checkpoint save went from 751.54 ms to 19.55 ms, and the run data from 79 MB to 236 KB.
