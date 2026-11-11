# Deferred Work

Work that finished plans named and left: features put off, a plan's Later list, defects and gaps a slice saw and did not fix, code paths without a test, and stale wording. Each entry came from a plan's close-out notes in the [plan archive](../archived-plan/README.md), which held them until 2026-11-11. Device and browser checks are in [manual checks](manual-checks.md). What the slices decided or accepted is in the guides: that queue was emptied on 2026-11-11.

- A heading is the plan; its text is `git show <commit>:<path>` from the archive's table. Plans are in the order they were archived.
- Every entry was read against the code, the tests, and the guides on 2026-11-11. What was done, what named code that is gone, and what a guide or [known issues](known-issues.md) already states was removed; what is left was still true and recorded nowhere else. Nothing was run, so confirm an entry in the code before acting on it.
- Delete an entry when it is done or the owner drops it. A confirmed defect moves to [known issues](known-issues.md).

## Model Profiles

- Global provider toggles moving to profiles (O7: `reverseProxyOobaMode`, `vertexRegion`).

## Translation

- The optional phase 4: greeting translation.

## Per-Chat Toggles and Toggle Presets

- Drop the read-only legacy `globalChatVariables` collection with a one-time seed of each chat's map after a release has passed.
- Decide an explicit default in the toggle grammar (a cross-user `.risup` format change).
- Similarity sorting and partial apply; `.risutoggle` export and import; plugin, MCP, and chat-command exposure of presets; writing toggle values from CBS, Lua, or triggers.

## Large Asset Import and Export

- Eager icon lists left: the `selectChar` alert in `AlertComp.svelte` and `CharConfig.svelte`'s group member list.
- Deferred out of the plan: the Safari/WebKit streamSaver fallback that keeps whole exports, "Export All Chats" building a whole history, and unbounded persona and preset decoders.

## Sidebar Chat Status

- `SideChatList.svelte` rows have no badge.

## Settings UI Reorganization

- The fetched WaveSpeed model list resets when Image Generation is left.
- The subtitle tool's Whisper mode uses the OpenAI key with no status or link there.

## Open Bug Fixes

- C5: a `#share_module` whose save a conflict discarded still has its pending share cleared.
- C2, P1, and I1 added strings to `en.ts` (and `ko.ts` where translated); the other locales show them in English.

## Boot Resource Cache

- A browser's first boot still downloads the whole compressed read (6 s at 10 Mbps on the measured data); the client's work after the read is unchanged.

## Heap Memory Reduction

- Found by M0, not sliced: the settings prepare the description and first message for token counts on the main thread; the original tokenization measurement was 17–22 s for a 1.7 MB description.
- D3 candidate: a Svelte `Batch` kept alive by an `{#await}` block holds the previous `parserAssetInputs`, so a server-deleted module's assets stay reachable (+17.2 MB in the driver's `boot-module-delete` step).
- B1/B2: a same-record unproxied list or tuple assigned to a module's `assets` is frozen in place (later edits through its source wrapper throw); a same-id `replaceCharacterRecordAt` with the character's own frozen list re-stamps that field; in DEV `module.assets = module.assets` nests Svelte's inspectable proxies.
- C2: layers declared inside an imported file are not detected.
- D1: a throwing mutator's shrink, a local field replacement's cached node, other by-id lists, nested containers' Svelte targets, `defineProperty` length sets and deleted ids' per-character metas are not pruned (all bounded by installed data or small).
- Drivers: readiness and cleanup in `measureHeap.mjs` and `measureFileSources.mjs` check `exitCode` only (a signal-killed server child is missed); no server-side egress accounting.

## Search

- 2a: the matcher's case fold is `toLowerCase` plus a final-sigma fold, not full Unicode case folding (ſ/S, ϐ/Β).
- 2b: a row renamed under the filter hides once its name no longer matches.
- 3a: the navigation page and Model tab labels are repeated in `searchIndex.ts` (`PAGES`, `MODEL_TABS`) because `Settings.svelte`'s `navGroups` cannot be imported.
- 4b: the previous error line stays visible during the next debounce.
- Not in the plan: the persona list itself has no name filter.

## RisuNest Small Wins

- T1: `build-test-platforms.md` `Files` does not list the three root `vitest.testNetwork*` files.
- P1: a hash failure that recovers reports the plugin once more.
- E1: `util/` stays outside `pnpm check`, so `testInventory.mjs` and its test are not type-checked.
- A1, found outside the slice: `alertClear` clears another job's status; `makeGroupImage` leaves its wait.
- S1: `bootstrap.safeBoot.test.ts` duplicates the service-worker test's mock preamble.

## Upstream `.bin` Compatibility

- S2's 11 tests were written after Sol's review and not reviewed by Sol.

## Audit Findings and Performance Leftovers

- 3a: `loadRequestDb` re-reads every settings record per job and per `presetChain` pick; the Lua character setters (`patchCharacter`) parse the record about five times per call.
- 3g: still whole: patches no smaller than the record and server `enabledModules` writes; imports and other whole-write callers publish plain refs.
- 4e: VOICEVOX stays on raw `fetch`.
- 4f: no server fallback for a share POST without a worker; shares and other deep links before first setup; `window.innerWidth` read at mount only.

## Timing-Dependent Tests

- The slowest gated test, `importRealm` "refuses a card or asset chunk over MAX_PNG_TEXT_CHUNK_BYTES...", takes 2-4 s alone and about 27 s under the overload.
- Gated explicit 60 s timeouts now repeat the default and could go.
- Test copies of production constants: `SAVE_DEBOUNCE_MS` in `mutationStoresHarness.ts` copies the unexported production `DEBOUNCE_MS`.
- Coverage gaps: `mcpSse`'s scan bound has no slack; other partial `vi.mock(importOriginal)` mocks were not audited for Vitest 4 keeping the first registry across `resetModules`.
- Production: `chatStore.svelte.ts` `isMember` scans a character's chat list through a proxy, so per-character work grows quadratically with the chat count.

## Generation Stage Spinner

- An attach replays only the current stage, so a quick memory step can hide the first `preparing`.

## Upstream Integration

- UP3: the `current` harness target's migration step fails on a backup with a `_coldpluginIndex` pointer, because memory cold storage starts empty (documented).

## Combine Audit Fixes

- The audit's evidence stays outside the repository in `/home/codex/metatron-stage/combine-audit/evidence/`.

## Context Usage Meter

- The deferred Recalculate: it needs a preview job that writes nothing.
- The memory-mode "may run memory" hint was not built.

## Deep Audit Fixes

- The plan's **Deferred** table groups the remaining audit findings into the follow-up plans it names: dictionary ids, boot bytes, rendering.

## Chat Lore Override States

- Out of scope by the plan: a marker in the character tab for overridden entries; an off control for chat-local lore; refreshing an off copy from its original when it is turned back on.

## Mobile Resume Reliability

- Set aside by the plan, each needing its own design if the diagnostics ever show it: keeping the browser's diagnostics across an Android process kill; the completion push sent before the post-reply emotion/image work and final write; push on job errors (a product decision); the earlier Web Push locale and iOS/desktop leftovers.

## HypaV3 Token Budget

- Out of scope by the plan: a trigger independent of `C`; token mode for HypaV2 or SupaMemory.

## Boot Bytes

- Not planned: characters as a sidebar projection (Q3).

## Per-Event Server Work

- Not planned: retiring `patch` for `delta` once an older client can be refused (both sockets now send `proto=1` as that boundary, with no floor: Incremental Chat Transport D4); the chat's summary on the job socket for the owner's own list.

## Server Byte Budgets

- Not planned (the plan's Later list): page-hash reuse across checkpoint saves; restore and import progress as NDJSON with a prepare/commit split for the version-2 import; a streaming validator that keeps no id sets.

## Guide Budgets

- The slices ran no test suite and no `pnpm check`, at the owner's request; only `util/docsBudget.test.ts` ran. `util/testInventory.test.ts` had its fixture keys changed and was not run.
- Not planned (the plan's Later list): a per-plan docs budget compared through `--report`; a second reader pass over the smallest guides for the prose rules.

## Guides To Source

- Not planned (the plan's Later list): a `Files` generator from the owned modules' exports.

## Render Work Budget

- Not planned (the plan's Later list): F3 and F6 (the mount profile did not settle between single runs); reversing Q4 (let dispatched transform requests finish) or Q2 (selected-range export); the `measureChats.mjs` settling delay.

## Plugin Storage and Data API

- Not planned (the plan's Later list): a streamed `getDatabase` transfer into the iframe; device-local large storage spaces; changing `getDatabase()`'s default once the developer access recorder has run on the owner's plugins (Q5).

## Reroll Candidates

- Not planned (the plan's Later list): a single-candidate delete control; a boot sweep writing back the previous candidate after a process death; pruning older messages' candidates at the commit boundary.

## Implementation Audit Fixes

- Not planned: the 12 findings excluded as edge cases and the deferred media URL lifetimes (AL U1); the seven audit reports are in [reports/audits](../reports/audits/).

## Chat Store and Structured Memory Sweep

- Deferred group, in the archived plan's Deferred section: trim costs.

## Multi-Client Data Safety Checks

- Deferred (the archived plan's Deferred section): two server processes on one data directory; the `pnpm test:e2e` runtime budget.

## Module Headers

- Slice 6 (server-generation) did not run (Q1); its path list is in the archived file.
- The plan's D7 sweep session is for the owner to start; it was not run.
- Not planned (the plan's Later list): a `missing-header` rule in `pnpm check:docs`; the identifier check and `Files` generator Guides To Source left; the same measure over the remaining guides.

## Found Issues Decisions

- A crafted restore whose keys are unicode-escaped can slip past D2's SQL prefilter and keep its bytes; retries are unaffected.

## Structured Memory Section Growth

- Relationship projection, put off by the owner on 2026-11-05 as scope B of the section growth work (scope A landed in `72e509ce3` and `596ab8cb2`): `retrieve.ts` projects `event.relationshipShifts` into the newest record per directed (from, to) pair over the covering events, for the pages on stage, named, or linked in the send (as `pageKnowledge` does); `card.ts` renders the relation clause on the page line; `relationships` either leaves `RELATED_SLOTS` or stays as the fallback for a pair with no shift. About 350 to 450 lines in two slices, with tests, `read.md` and `records.md`.
- Not justified by the [2026-11-08 replays](../reports/measurements/relationship-shifts-2026-11-08.md): the projection would have repeated the `relationships` sections line for line. The case that would justify it is a long chat (30 or more windows) whose side characters relate to each other and whose `relationships` sections reach the slot budget; replay such a chat the same way first. A shift's `direction` is free text, so a projected clause needs a clamp or a fixed vocabulary before anything else.

## Memory Panel Readability

- Not planned (the plan's Not In This Plan list): deleting a section by hand, changing a page's type, and editing `links`; editing an event's key lines, state changes, knowledge, or participants; help text for 기록기, 억제, and 채택; a Korean rename of the shared memory surfaces (the settings page, the preset, the toggle, the meter); Markdown rendering of record text and a natural-language command terminal; an `e2e` spec for the panel.

## Structured Memory Recent Timeline

- Not planned (the plan's Not In This Plan list): a raw window measured in tokens, or one that keeps history until the context is full; chapter or arc summaries of what is older than the timeline; opening the events lane more often, or any change to its thresholds; shares as a setting, or a share per chat; a change to `eventSummaryChars`, `keyLinesPerEvent`, or anything the writer stores; card text that stays byte-stable for a provider's prompt cache.

## Dependency Upgrades

Not a plan: the upgrade rounds of 2026-10-30 left these behind on purpose. Versions were read from `package.json` on 2026-11-11.

- `ipaddr.js` 2 (now `^1.9.1`): it classes `64:ff9b:1::/48` (local-use NAT64) as `rfc6052`, so `isBlockedAddress` in `server/src/lua/egress.ts` follows the embedded IPv4 address instead of blocking the prefix; `luaRuntime.test.ts` fails on the bump. It needs a match on that prefix before the embedded-IPv4 branch, which is a change to a security filter.
- `pdfjs-dist` 6 (now `^4.10.38`): `RenderParameters` requires `canvas`, and the worker computes every document's fingerprint with `Uint8Array.prototype.toHex`, which `core-js/actual` covers on the main thread only, so PDF import would need Chrome 140, Firefox 133, or Safari 18.2. A Node smoke test of 6 imports `pdfjs-dist/legacy/build/pdf.mjs`.
- `three` (now `^0.154.0`): r172 removed `examples/jsm/loaders/MMDLoader` and `MMDAnimationHelper`, which `src/lib/UI/3DLoader.svelte` and `src/ts/3d/threeload.ts` use, so 0.171 is the last version a plain bump reaches.
- `typescript` 7 (now `^5.9.3`): `svelte-check` 4.7 refused it and asked for `typescript@~6` plus `@typescript/native@npm:typescript@7` and `--tsgo`; the server's `tsc` alone passed on 7.
- `@types/node` stays on the major that `engines`, the Dockerfile, and CI run.
- Not looked at: `@smithy/*` 3 to 5; `deepmerge` (through `vite-plugin-svelte`), which had no fixed release; `@types/libsodium-wrappers-sumo`, a deprecated stub nothing imports.
