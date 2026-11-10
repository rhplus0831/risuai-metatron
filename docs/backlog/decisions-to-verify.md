# Decisions To Verify

What finished plans decided or accepted while they ran: choices the slices made, defaults taken, plan changes the owner approved mid-run, and limits kept on purpose. A plan's numbered decisions (D1, Q2, …) are in its own file; the entries here are the ones its close-out notes in the [plan archive](../archived-plan/README.md) added, which the archive held until 2026-11-11.

This is a queue to empty, not a reference. For each entry, find where the current docs record it:

- A rule the code keeps belongs in the owning guide's `Invariants`, and a limit kept on purpose in its `Known Hazards` → `Limitations` with the decision ([Doc Maintenance](../structure/README.md)).
- A choice about how a plan ran, with no effect on the code today, needs no home: delete it.
- Delete the entry once its home is confirmed or written. If the code no longer behaves that way, record what it does instead.

A heading is the plan; its text is `git show <commit>:<path>` from the archive's table. Nothing here was re-read against the current code when it moved.

## Large Asset Import and Export

- Known limits kept: no upload progress on the file imports (`fetch`); the Vite dev proxy keeps Node's 300 s `requestTimeout`; a CharX entry the card references but the server excluded still throws `asset … not found`; the in-tab `CharXImporter` (test-only) keeps fflate's signature hazard and per-item writes; `PngChunk.readGenerator` never cancels its reader when a pass stops early; export memory is bounded by two read batches, not by bytes; PNG import progress moves per 500-asset batch and picker saves show no progress; ONNX members inflate synchronously on the main thread; hub-mode card assets are fetched without retry.
- The backup export's abort hang and the emotion table's `bind:value` throw after a delete were recorded as Known Hazards in their guides.

## Sidebar Chat Status

- Unseen and recovery marks are per tab and dropped by a reload (decision 4).
- A chat generating in another tab and not loaded here shows nothing (decision 5).
- The badge's `title` tooltip does not show because it takes no pointer events; the status is in the row's name instead.
- The generating badge also shows on the open chat's own pin and folder (while collapsed).

## Data-Loss Under Concurrency

- The choices the slices made are in the archived Status line's "Decisions made by landed slices" paragraph: 1a's `setMessage` rule, 1c's summary merge rule, 5a's `onStorageDiscarded` event, 6b's 100-id bound and `chatGroups` table, 7b's add-only order repair, 6d's fail-closed barrier.

## Boot Resource Cache

- No server hash cache; the compression settings and `presets` as an item kind were kept (the archived Slice 4 section).

## Heap Memory Reduction

- C1, the font investigation: no app-side holder.
- D2b accepted: without a working service worker every distinct file shown keeps a Blob of its bytes for the page's life. Direct Asset URLs removed this retention where a worker reports the direct-asset capability and controls the page. Still accepted: pages without a worker, and sources created before a switch to direct mode (`fileSrcCache`, `mediaObjectUrls`), keep theirs for the page.

## Search

- No FTS index: the `LIKE` scan stayed under the 1 s threshold of Decision 7.
- 4a: an unauthenticated request answers 400 `No auth header` (the server's rule), not the plan's 401; `shared/diagnostics.ts` `ROUTE_TEMPLATES` gained the path.

## RisuNest Small Wins

- D1: GitLab CI with a Runner for `metatron` and `main` only (the plan's Forgejo/Gitea options did not apply).
- D2, D4 (never interrupt), D5 (once per page load), D6 (two boots, 10 s), and D7 (exact origins) at their defaults; D3 moot, since the heap branch had merged.

## Upstream `.bin` Compatibility

- The owner's U1 (upstream formats get a one-way migration; formats from metatron's implementation phases do not), U2 (import and export), U3 (full replace with a safety snapshot), U4 (Risu Account backups refused).
- The defaults D1–D13 were taken: worker decode with caps, groups imported, cold pointers kept and reported, selection applied, chats bound to the selection, one model preset per upstream preset, keys asked at export, inlays counted not exported, `\x07`/`\x08`/`\x09` accepted, the tab's model preset for every exported preset, en and ko strings, metatron-only chat fields stripped, the changed-since-review 409 re-ask.
- S6 accepted minors: without keys `authRefreshes` is written as `[]` even when the store had none; a chosen slot whose credential no longer exists does not keep its field, so a later slot's key can take it.
- S3 accepted minors: a repaired model-preset reference is reported by its generated id; `loreBook: null` is reported where upstream fills the default silently; `autoTranslate` and `htmlTranslation` are reported as removed although metatron keeps them per chat.

## Audit Findings and Performance Leftovers

- 3d: resolved for direct mode by Direct Asset URLs. The fallback (no worker or capability off) still makes typed object URLs that stay for the page.
- Phase 5: `/api/asset/*` sends the extension's MIME, single ranges (206/416), and validators, and the worker passes `Range` through. The capability-off fallback's `/sw/img/` entries still use `image/png` without Range.
- Phase 5 (the browser checklist) was not run as one session; the owner retired the plan on 2026-10-21 after verifying it through everyday use.

## Timing-Dependent Tests

- D5 (the owner): the gate's timeout is a 60 s hang guard, and `test:agent --slow-tests` lists slow tests on request.
- The inventory in [reports/audits](../reports/audits/timing-dependent-tests-2026-10-19.md) is complete and historical: a new real-time dependency is a V3 violation, not a new row.
- Kept by decision: `prepareCpuMs` is an inert test-only pool option.
- Kept by decision: Slice 5a's exception stands; the boot-subject `scriptWorker` tests keep real cold worker boots under an explicit 60 s.
- Kept by decision: the `scriptWorker` cases "summed across them" and "right after a resumption" stay gated, although under load they can pass without exercising their distinction. Summation also has a deterministic `luaRuntimeCharge` test.

## HypaV3 Background Memory

- Accepted from the slices: the planner tokenizes every window before the first request (1a); a task's abort callback may emit a duplicate `queued` event for the same task id (5c).
- Blocking stays for a Plugin-format `memory` slot and applicable request triggers (7).

## Per-Chat Send

- D1: the per-tab callback lane stays.
- D6: same-character field last-writer-wins, `CharEmotion` sharing, global `stopTTS`, and the single `alertWait`/`progress` slot are accepted and documented.
- D8 added slice 7 mid-run: a cancelled callback keeps the tab's channel lane until the tab reports it drained (`POST /api/generations/:id/drained`) or `CANCELLED_CALLBACK_DRAIN_MS` passes, and an aux request names a callback as its parent only from that hook's `PluginCallContext.channelCall`.
- Accepted from the slices: plugin `sendChat` is refused while any channel callback runs in the tab (4); a cancelled hook that never settles keeps refusing the tab's later roots until a reload (7); body interceptors, provider streams, and `internal:aiaccess` requests are no longer callback children (7); with no owner attached, queued requests expire one after another (2, D2 (a)).

## Static Audit Fixes

- Accepted: a Retry or edit on a stale revision is a normal 409 recovery that drops the draft with a reload notice (SA3).
- Accepted: manual trigger commands still answer 500 and WebLLM translation 502 for a local-model refusal (SA10).
- Accepted: SA14 settles ownerless queued roots `disconnected` together only for jobs opened at or before the expired root's dispatch (the orchestrator accepted the narrowing on code grounds; `server-generation.md` Generation channels).

## Direct Asset URLs

- The worker passes requests outside its destination allow list to the server unsigned (owner, 2026-10-23).
- An immutable `/api/asset` copy in the HTTP cache can answer an unsigned same-origin fetch such as a plugin's `nativeFetch` (accepted hazard, `self-host-server.md`).
- After a worker update, a row whose fallback `/sw/img` URL is fetched by `fetchFileSrc` is refused, so copy-to-HTML and screenshots omit that image until the row re-renders (DA7, a Known Hazard in `assets.md`).

## Server Thumbnails

- Thumbnails are `GET /api/asset/<hex>?w=256|512` (short side, `fit: "outside"`, WebP quality 80, `sharp` 0.34.5 loaded lazily).
- A small, animated, non-raster, or over-cap source and a busy, unavailable, or failed encoder answer a 307 to the query-free original (D10 (a), confirmed by the owner 2026-10-23).
- No user setting (D6); one request per image (D7); the variant inherits the immutable-cache hazard and nothing more.
- Accepted: a forged strong variant tag on a small PNG gets a 304 instead of the 307 (ST1); SVG and every non-raster source are never decoded on the server (ST1).

## Server Tokenizer

- The capture scripts can no longer re-capture token ids in the browser, so the frozen `browser-ids.json` is the reference (TK2, TK4).

## Upstream Integration

- D2 reversed the Stop B lore flag choice (UP7).
- The `--bin` harness gained the `current` target and the migration pass (UP3).

## Combine Audit Fixes

- D1: only `risu-form` forms skip click-to-edit as a whole; a plain form's text still edits.
- An aborted token count answers 400 (5).
- `THUMBNAIL_VERSION` 2 makes every thumbnail regenerate once after the upgrade (4).
- Accepted from the slices: the lore entry's CBS expansion now runs on every edit, and the plugin tokenizer map and a prompt template's CBS values are not tracked (2).

## Chat Lore Overrides

- Decisions made by the slices: `loreOverrides` has no default and readers use `?? []` (1); `mergeOwnerLore` returns references, not clones, because the client passes `$state` proxies (1); "off wins" is also enforced in activation through `offOverrideIds` (1); Reroll refuses before removing the reply, beside Send and Continue (3); a folder checkbox pins or releases its entries, not the folder (4); "Move to chat lorebook" drops the `folder` key (4).
- The plan limited the refusal to generation jobs; on 2026-10-25 the owner decided that auxiliary LLM requests (suggestions, memory summaries, translation, MCP AIAccess, plugin and WebLLM requests) do not refuse a chat with orphaned overrides ([chat pipeline](../structure/chat-pipeline.md) `Invariants`).

## Context Usage Meter

- Slice 2, not 1, typed the three `Database` fields, because the partition check needs them in `shared/sections.ts` (1).
- Section rows have no `name`; `"beyondQueue"` means the known 8-entry queue ran out; memory coverage is `"covered"` only on HypaV3 evidence (1).
- The memory-mode chip leaves the memory kind to its label and the popover (3).
- The estimate is also hidden with any memory configured, a preset chain, an incomplete binding, or a disabled last message; the next report's kept count is kept + 2 − n messages, not a plain drop (4).

## Deep Audit Fixes

- A refused chat order no longer holds every flush (6).
- A trigger that drops a whole map removes only its baseline keys (1).
- A translation result arriving while the destination composes is dropped, not deferred (2).
- A LoRA draft counts as saved only after a later save cycle sees the `secrets` revision move (3).
- The vector cache skips an insert that cannot fit within the 256-row budget (5).
- A browser whose subscription the server dropped (the 50-entry cap) while its endpoint and keys stay the same re-registers within 24 h, not at once, since the client cannot see the server's list (5, accepted by the orchestrator).
- Failed transforms also retry on a 5–60 s backoff while visible (7).

## Chat Lore Override States

- Recorded at retirement (the owner, 2026-10-26): orphan delete and move act on the selected override object only, while every other removal drops every override with the id; a legacy duplicate orphan stays as its own row until it is handled or the next metadata write collapses it.

## Mobile Resume Reliability

- The user's message-count comparison was not used, because a reroll, a continue, a reply already streaming, or a command job is a success without a new message.
- A kept outcome shows no notice (`done`) or the usual error alert (`error`), and only a job the server no longer knows gets the toast.

## HypaV3 Token Budget

- The plan's "ordinary plan" site was `deferredStepCount` (the deferred replay), which reads the resolver too (1).
- The equivalence test uses binary-exact ratios, because integer products alone still differ in floating point (1).
- The export clamps to the sliders' ranges and keeps the stored ratios without a positive finite `maxContext` (1).
- Token inputs store a floored integer ≥ 0, and `getMaxMemoryRatio` became `estimateMaxMemory`, which now recomputes when the max context changes (2).

## Display Evaluation

- A scope over the snapshot budget fails every uncached target (3).
- Four kinds beyond the plan's candidates were dropped from the key, since no display path reads them (5).
- A refilled key may hold other random, clock or plugin text while `same` confirms the tab's older text (7).
- A GUI reset advances the tab cache's generation without clearing it, and a synchronous source hash with an exact source check replaces `sha256(source)` (8).
- The plan's **Later** read-class key was judged not needed after the measurements.

## Durable Drafts

- Approved by the owner during the run: D7 sends whole keepalive batches only and lets the front part of a split batch wait for its journal commit (`610f8d143`); Slice 7 took the hand-over APIs and ran after Slice 8 (`4845688fb`). Q4's budgets were raised to 16 MiB per entry and 64 MiB in total after Slice 3 measured them.
- Chrome discards IndexedDB writes begun in `pagehide` on unload: documented as a Limitation, with no `localStorage` fallback.
- Recovery drafts conservatively when a record's or chat's state is unclear (4, 7); an applied draft is removed only after its save commits (5); an expired chat group becomes refused work and a draft at the next boot (7).
- `llmSecrets` merges its readable sibling body as one unit; both sides reordering a collection conflicts; a merged empty required collection conflicts (11).
- Q3 did not hold as planned: headless Chrome 156 restored the page from the back/forward cache while it held its journal owner lock (a draft recovery Gotcha).

## Job Protocol

- Where the code settled differently from the text: the running request-id index moved from Slice 1 to Slice 2; after an unanswered create, a 412, 429, auth or 5xx answer stays `unknown` because it comes before the request-id lookup; recovered composer rows store `requestEpoch`, because a reloaded page posts with the current epoch and D4's 412 does not refuse it; error and abort terminals also carry `sequence { total, sent }`, and a done sequence takes one automatic checkpoint because the slot is held between parts; the channel hub gained `expireOverdue` and `ownerChanged`, and MCP owner checks read the same presence; the lookup takes an optional `clientId` for `owned`.

## Server Byte Budgets

- Limitations recorded in the server guide: a row far over the restore worker's heap limit aborts the whole process (reproduced at a 16 MiB limit with a 32 MiB row; not reached under the default 2048 MiB by what the 100 MiB request cap admits); the version-2 import finishes through a shutdown instead of stopping; `eventsFor`, reports and shares still write synchronously.

## Guides To Source

- Owner decision: the 40,000-byte ceiling, 36,000 target, 8,000 leaf, and 600-character item budgets stay (option A of the guide-reads audit); revisit when a guide passes 36,000.
- Path Ownership became `ownership.json`, validated by `pnpm check:docs` and queried by `check:changed`.

## Structured Memory

- Owner decisions made during the run, dated in the archived plan's slice text: a stopped rebuild keeps generation locked; a patch may replace a corrected section; custom prompts must quote their required slots; import goes only into an empty chat; screening reaches the writer only.
- `MEMORY_CALL_OVERHEAD_TOKENS` went to 3,000 without the real-model A/B (owner, 2026-11-08).
- Rollback cost: an older build refuses a snapshot with the `memory_state` column, reads a trashed page as live, and refuses a chat file holding `merge` or `split` history entries.

## Job Handoff

- Recorded in the server-generation guide's Limitations: `handoff: "prefer"` does not guarantee that the first callback runs on the worker (no first-dispatch gate), and a queued root cascaded `disconnected` behind another job's expired root can end before the `absent` offer's 50 s budget.

## Render Work Budget

- Two acceptance items were not met and moved to found issues by owner decision: more than one transform chunk in flight at a switch, and the screenshot peak growing with rows.
- Traces stay out of git, in the main checkout's git directory.

## Asset Lifecycle

- Owner-visible behavior: a card import ends with an error when a key its record names is gone and its bytes are not in hand.
- Owner-visible behavior: the sweep's synchronous turn re-marks the whole live store, during which every request waits ([asset scan](../reports/measurements/asset-scan-2026-11-05.md)).
- Each slice's deviations from its text are listed under it in the archived file.

## Incremental Chat Transport

- D6 was amended during the run (`b234d14ff`): the manifest names the changed metadata fields, since the server cannot rebuild a metadata diff at read time.
- Owner-visible behavior: a tab older than the deploy takes a notice and one whole read for every entry past 8 KiB until it reloads (D8); while a Job Handoff viewer is attached, the owner gets its streamed rows whole.

## Plugin Storage and Data API

- Q1–Q5 were answered as recommended: owned `pluginStorage` with legacy read-through and claim-on-write; reserved dictionaries kept; a 64 MiB reuse cache; one confirm with "also delete its stored data" on removal; `getDatabase()`'s default unchanged.

## Found Issues Sweep

- The eleven open questions were answered as recommended; G1 took option A (an owner taking its own open offer reattaches).

## Implementation Audit Fixes

- The owner decided Q1–Q3 as recommended on 2026-11-05: range-backed PNG replay for a File or Blob, with streams keeping their retention (an assets Limitation); an owner and a viewer projection of a handoff baseline; an old window's repair protecting the later scene state.
- Owner-visible behavior: with prompt text stored in the chat, the stored prompt copy no longer shows `editRequest` hook edits, since the hooks run once per request (C5, `7f50a554a`).

## Chat Store and Structured Memory Sweep

- The owner accepted every recommendation of Q1–Q16 on 2026-11-06.
- B10 (memoizing token counts per selection) is kept as an attempt and its revert (`de9e9ed21`, `2a0f07213`): only 9 of about 2,190 counts per send were repeats, so `selectMemory` time did not drop.

## Multi-Client Data Safety Checks

- No case found a defect, so none is `fixme`.
- Observed and recorded, not asserted: S5's later-accepted text wins (chat-store Q3 Limitation); S7's record edit reached the server through an ordinary cycle in most runs and otherwise stayed in the closed tab's journal (Durable Drafts D7, the resource-sync keepalive Limitation); during a hold the owner tab shows another message's edit only after completion (live-updates feed locks).

## Module Headers

- D8 ran differently: the two slices of a pair did not rebase onto each other; each landed by cherry-pick, and `pnpm check:docs` ran again on `dev` after every landing (owner decision 2026-11-08, recorded only in these notes).

## Found Issues Decisions

- Revised before the run: D2 prunes against the settled outcome (`871b8e29f`, finding G1 of the [second audit](../reports/audits/plan-runner/found-issues-decisions-2026-11-08-2.md)).
- D2 prunes inside the store's write transaction; its challenger found two bugs in pruning on append.

## Found Issues Clearance

- Revised during the run: G3 detects harness reloads instead of a warm-up (`307dd273c`); C4 saves signatures in the `model` mode only and hides their markers in chat (owner decision, `21cbf1e2b`); D1 narrows the escape fix to the provider input and H1 records the Markdown pass (owner decision).
- E4 missed its memory target and recorded the miss in [screenshot memory](../reports/measurements/screenshot-memory-2026-11.md).

## Upstream Intake 2

- Revised before the run: the plan-runner audit's ten fixed findings (`54c2d0b27`, [report](../reports/audits/plan-runner/upstream-intake-2-2026-11-10.md)).
- During the run, slice 11 also raised `ReloadNotice.svelte` above the alert layer, and slice 4 refuses an unknown permission name before a stored grant.
