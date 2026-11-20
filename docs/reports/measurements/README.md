# Measurements

Reports of a run of this code: timings, bytes, token and row counts, and what a run showed where no figure applies. The folder is which side was run, so pick it by scope:

| Folder                   | Run                                                                                                        | Typical source                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [client/](#client)       | The client: the built app driven in a browser, or a client module under a benchmark                        | `util/playwright/measure*.mjs`, a browser used by hand                      |
| [server/](#server)       | The server: the process, a store, or a server-side module run by a script, with a scripted or a real model | `util/memoryEval.mjs`, a probe, a throwaway script against the real store   |
| [toolchain/](#toolchain) | The repository's own tools and the sessions using them: test suite, type check, build, checks, guide reads | `pnpm --silent test:agent`, `pnpm check`, `pnpm build`, session transcripts |

A report that ran both sides is filed under the side its main figure comes from, and its row says what else it holds. [plan-close-out-figures-2026-11-11.md](plan-close-out-figures-2026-11-11.md) stays at this level because it spans all three: the figures that finished plans measured, moved out of the [plan archive](../../archived-plan/README.md) on that date and headed by plan.

A figure belongs to the commit, machine and fixture its report names. The guides keep the conclusion and link here for the numbers.

## client

| File                                                                                              | Measured                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [projection-bindings-2026-10-04.md](client/projection-bindings-2026-10-04.md)                     | What the write-through record wrappers cost: a unit benchmark against direct writes, list re-renders in a production build, and save batches per keystroke in a settings field    |
| [preset-reorder-2026-10-05.md](client/preset-reorder-2026-10-05.md)                               | Latency of mounting the image settings, one keystroke, and reordering 50 presets, across commits against a baseline                                                               |
| [direct-assets-browser-control-2026-10-24.md](client/direct-assets-browser-control-2026-10-24.md) | Which browsers keep service worker control after a navigation the worker does not answer. A pass or fail per browser, no timings                                                  |
| [boot-measurements-2026-10-29.md](client/boot-measurements-2026-10-29.md)                         | Boot bytes and time to the main screen per scenario, before and after the boot cache. Also holds the server's summary read and reconnect digest timings                           |
| [durable-drafts-observations-2026-10-29.md](client/durable-drafts-observations-2026-10-29.md)     | Two browser behaviors seen in the Durable Drafts run (a bfcache restore with the owner lock held, IndexedDB writes begun in `pagehide` discarded) and the limit that was accepted |
| [render-work-budget-2026-11-05.md](client/render-work-budget-2026-11-05.md)                       | Render work of a styled, auto-translated chat at 30, 150 and 600 rows, before and after the Render Work Budget plan, with the plan's acceptance verdicts                          |
| [screenshot-memory-2026-11-09.md](client/screenshot-memory-2026-11-09.md)                         | Renderer and GPU memory and export time when exporting 30, 150 and 600 rows as a screenshot, with the reductions that were tried                                                  |

## server

| File                                                                                              | Measured                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [chat-scan-observations-2026-10-24.md](server/chat-scan-observations-2026-10-24.md)               | Two hazards when scanning chats: the newest-first walk of the server's `chats` table, which holds the one figure, and the client wrapper's `chats` view rebuilding an array per read        |
| [server-measurements-2026-11-01.md](server/server-measurements-2026-11-01.md)                     | Four figures carried over from the server guide: whole-chat barrier frames, restore install and re-hash time, a row over a worker's heap limit, job receipt writes                          |
| [structured-memory-2026-11-03.md](server/structured-memory-2026-11-03.md)                         | What Structured Memory costs and selects on fixture chats: send time, checkpoint save, cost preview, health read, rate limit, token ledger against HypaV3. Scripted writer, no model recall |
| [structured-memory-health-read-2026-11-03.md](server/structured-memory-health-read-2026-11-03.md) | Server time of the structured memory health read at its 64-chat limit, in its first form, in one pass, and with the byte budget                                                             |
| [asset-scan-2026-11-05.md](server/asset-scan-2026-11-05.md)                                       | Time, rows read and memory of the asset scan and the sweep's re-mark turn on a seeded store of 100,000 messages                                                                             |
| [relationship-shifts-2026-11-08.md](server/relationship-shifts-2026-11-08.md)                     | Real-model replays of four chats: relationship shifts per event and per pair, and why projecting them onto the memory card adds nothing                                                     |
| [tool-schema-tokens-2026-11-09.md](server/tool-schema-tokens-2026-11-09.md)                       | How many tokens the MCP tool descriptors add to a request, per provider form, for three sets of tools                                                                                       |
| [transform-snapshot-2026-11-09.md](server/transform-snapshot-2026-11-09.md)                       | Snapshot bytes charged per target and per chunk for display transforms on a 2,000-message chat, and why the cap stays                                                                       |
| [structured-memory-timeline-2026-11-11.md](server/structured-memory-timeline-2026-11-11.md)       | What the recent timeline puts in the memory card and what selection costs, before and after, on the 2026-11-03 fixtures at three budgets                                                    |

## toolchain

| File                                                                                           | Measured                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [build-compression-2026-10-29.md](toolchain/build-compression-2026-10-29.md)                   | What the precompression step adds to `pnpm build` and the Docker build in time and size                                                                         |
| [test-suite-lock-2026-10-30.md](toolchain/test-suite-lock-2026-10-30.md)                       | Gated suite time with one, two and three runs sharing the machine, and a full e2e run before and after `settle`                                                 |
| [test-time-knobs-2026-10-30.md](toolchain/test-time-knobs-2026-10-30.md)                       | The Vitest settings tried for a shorter gate and ruled out, and how often sessions ran the gate                                                                 |
| [guide-reads-2026-11-04.md](toolchain/guide-reads-2026-11-04.md)                               | Whole-file against ranged guide reads in agent session transcripts, per guide and per heading (`util/guideReads.mjs`): the first count                          |
| [guide-reads-2026-11-05.md](toolchain/guide-reads-2026-11-05.md)                               | The second count, before the second wave of guide rewrites, compared with the first                                                                             |
| [guide-reads-2026-11-05-wave3.md](toolchain/guide-reads-2026-11-05-wave3.md)                   | The final count of the Guides To Source plan, after `pnpm docs:read` landed, with the table of all three counts and the options for the guide size ceiling      |
| [stability-2026-11-08.md](toolchain/stability-2026-11-08.md)                                   | How often a browser spec fails without a code change, over three full e2e runs and the run history, and how many fix commits repaired a change made days before |
| [browser-check-observations-2026-11-11.md](toolchain/browser-check-observations-2026-11-11.md) | Dated lessons from writing `util/playwright/` checks and reading heap snapshots, collected from session notes. Not a run                                        |
| [test-gate-cpu-profile-2026-11-12.md](toolchain/test-gate-cpu-profile-2026-11-12.md)           | Where the gated suite's CPU time goes, what a module reset costs, and what four changes saved                                                                   |
| [type-check-time-2026-11-12.md](toolchain/type-check-time-2026-11-12.md)                       | `pnpm check` in sequence, side by side and from the result cache, and the cache's hit rate replayed over a week of session logs                                 |

`pnpm check:docs` does not measure this folder; `pnpm format:check` does.
