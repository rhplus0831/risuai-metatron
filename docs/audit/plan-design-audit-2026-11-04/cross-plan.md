# Cross-plan audit of the five active plans (dev @ d31fa9a48)

Abbreviations: JH = job-handoff.md, AL = asset-lifecycle.md, RC = reroll-candidates.md, RW = render-work-budget.md,
TR = incremental-chat-transport.md. "JH1" = Job Handoff Slice 1, and so on. Line numbers are the plan files' line
numbers at d31fa9a48.

## Part A: shared-file matrix

### Cross-plan overlaps (product files named in a slice's Files paragraph)

| File                                           | (plan, slice) pairs                                                | What the plans say                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/jobs/generationJobs.ts`            | JH1, RC1, TR2                                                      | RC:321-323 "Slice 1 edits `shared/jobs.ts`, `runner.ts`, and `jobScope.ts`: not in parallel with … Job Handoff … (its Slice 1)". TR:291 "Slice 2 edits `shared/jobs.ts` (not in parallel with Job Handoff Slice 1 or Reroll Candidates Slice 1)". JH:200-202 names only "the server plugin runtime plan's Slices 1, 4, or 5" (retired 2026-11-03). | JH1/RC1: acknowledged by RC only. JH1/TR2 and RC1/TR2: acknowledged by TR only. **JH acknowledges neither (its only parallelism sentence names a retired plan). RC does not know about TR2.** JH1 and TR2 both edit `handleUpgrade`'s query parsing (`role`, `takeover` against `rows=streamed`, `proto`): same function. |
| `shared/jobs.ts`                               | JH1, RC1, TR2                                                      | Same sentences.                                                                                                                                                                                                                                                                                                                                    | Same as above.                                                                                                                                                                                                                                                                                                            |
| `server/src/routes/generations.ts`             | JH1, RC1                                                           | RC:321-323 covers the pair through `shared/jobs.ts`; the file is not named.                                                                                                                                                                                                                                                                        | Acknowledged (pair), file unnamed. RC:322's file list (`runner.ts`, `jobScope.ts`) names two files JH1 does not touch and omits the three it does share.                                                                                                                                                                  |
| `server/src/routes/events.ts`                  | JH1, JH3, TR2, TR3                                                 | TR:36-37 "its Slices 2 and 3 are not run in parallel with Job Handoff Slices 1 and 3 or Reroll Candidates Slice 1". TR:291-292 attaches JH1/JH3 to TR3 only, and only JH1/RC1 to TR2.                                                                                                                                                              | TR2/JH3: acknowledged at TR:36-37, **missing at TR:291**. JH: unacknowledged.                                                                                                                                                                                                                                             |
| `shared/events.ts`                             | JH1, JH3, TR3                                                      | TR:36-37 (pair).                                                                                                                                                                                                                                                                                                                                   | Acknowledged by TR only.                                                                                                                                                                                                                                                                                                  |
| `src/ts/network/eventFeed.ts`                  | JH2, JH3, TR2, TR3                                                 | TR:36-37 and TR:291-292 name JH Slices 1 and 3 only.                                                                                                                                                                                                                                                                                               | **TR2/JH2 and TR3/JH2 unacknowledged** (JH2 edits `receive` for the `handoff` frame, line 230-231).                                                                                                                                                                                                                       |
| `src/ts/network/generationJobs.ts`             | JH2, TR2                                                           | None.                                                                                                                                                                                                                                                                                                                                              | **Unacknowledged by both.** Same lines: JH2 adds `role`/`takeover` and TR2 adds `rows=streamed`/`proto` to the one socket URL in `followGenerationJob` (`src/ts/network/generationJobs.ts:914-917`).                                                                                                                      |
| `src/ts/process/serverCommands.ts`             | JH2, RC2                                                           | None.                                                                                                                                                                                                                                                                                                                                              | **Unacknowledged by both.** Same callback: RC2 removes `installReplyAlternatives` from the `followGenerationJob` callback in `followJobToEnd` (`serverCommands.ts:615-624`); JH2 adds the takeover option and the `handoff` role switch to the same follow.                                                               |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | JH3, RC2, RW4                                                      | RW:43-46 "Reroll Candidates plan Slice 2 edits `reroll` … different functions, so a rebase … The Asset Lifecycle and Job Handoff plans share no file with this one." RC and JH silent.                                                                                                                                                             | RC2/RW4: acknowledged (RW only). **JH3/RW4: wrongly stated** (JH3, line 259, edits it for "Hand off to…" beside Stop). **JH3/RC2: unacknowledged.**                                                                                                                                                                       |
| `src/lib/ChatScreens/Chats.svelte`             | RC2, TR0                                                           | None (TR:38-39 cites RC only for D12).                                                                                                                                                                                                                                                                                                             | **Unacknowledged by both** (RC2: two props per row; TR0: `activeStreamingIndex`).                                                                                                                                                                                                                                         |
| `src/ts/storage/chatStore.svelte.ts`           | RW0, TR0, TR1, TR2, TR4                                            | RW:282-284 and TR:32-34, TR:300-301 (supersession of the memo, "whichever lands first"). TR:408 "Slices 0, 2 and 3 touch disjoint files".                                                                                                                                                                                                          | RW0/TR0: acknowledged as a supersession. RW0/TR1, RW0/TR2, RW0/TR4: unacknowledged (different functions). **TR0/TR2: wrongly stated at TR:408.**                                                                                                                                                                          |
| `shared/resources.ts`                          | AL3, TR1, TR3, TR4                                                 | TR:290 (TR1/TR3 only).                                                                                                                                                                                                                                                                                                                             | **AL3/TR1, AL3/TR3, AL3/TR4 unacknowledged** (AL3: `BackupSnapshotInfo`).                                                                                                                                                                                                                                                 |
| `src/ts/storage/resourceClient.ts`             | AL3, TR3, TR4                                                      | None.                                                                                                                                                                                                                                                                                                                                              | **Unacknowledged** (AL3: snapshot calls; TR3: `listChanges`).                                                                                                                                                                                                                                                             |
| `server/src/app.ts`                            | JH1, AL1, TR3                                                      | JH1/TR3 covered by TR:36-37.                                                                                                                                                                                                                                                                                                                       | AL1/JH1, AL1/TR3 unacknowledged (wiring only; low risk).                                                                                                                                                                                                                                                                  |
| `src/lang/en.ts`, `src/lang/ko.ts`             | JH2, JH3, RC1, RC2, AL4, RW4 (only "if the progress text changes") | None.                                                                                                                                                                                                                                                                                                                                              | Unacknowledged everywhere; append-only keys, low risk.                                                                                                                                                                                                                                                                    |
| `docs/plan/render-work-budget.md`              | TR0                                                                | TR:300-301 edits RW's D8 and Later.                                                                                                                                                                                                                                                                                                                | Acknowledged.                                                                                                                                                                                                                                                                                                             |

No product-file overlap: AL with RC (RC3 edits `server/src/data/upstream/exportDatabase.ts` and `importCharacters.ts`;
AL edits `server/src/routes/backupsUpstreamExport.ts` and `backupsUpstream.ts`), AL with RW, RW with JH except
`DefaultChatScreen.svelte` and the lang files.

Test files shared (not product files, for the worktree planner): `server/src/tests/generationJobs.test.ts` (JH1,
RC1); `server/src/tests/chatStore.test.ts` (RC1, TR1); `server/src/tests/events.test.ts` (JH1, JH3, TR3);
`src/ts/network/eventFeed.test.ts` (JH2, JH3, TR3); `src/ts/network/generationJobs.test.ts` (JH2, TR2);
`src/ts/storage/tests/chatStore.test.ts` (RW0, TR0, TR1).

### Intra-plan parallelism claims that are wrong

| Claim                                                                            | Actual overlap                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR:408 "Slices 0, 2 and 3 touch disjoint files and may run in parallel sessions" | TR0 and TR2 share `src/ts/storage/chatStore.svelte.ts` (TR2 `applyChatPatch`, line 339-340). TR2 and TR3 share `server/src/routes/events.ts` and `src/ts/network/eventFeed.ts` (lines 338-339 against 359-361). Only TR0 with TR3 is disjoint.                                                     |
| TR:290 "Slices 1 and 3 share `shared/resources.ts` and `resourceSync.svelte.ts`" | TR3's Files (357-364) do not name `resourceSync.svelte.ts`; TR1 and TR3 share `shared/resources.ts` and `server/src/data/resourceStore.ts` (the latter not named).                                                                                                                                 |
| TR:291 (Slice 2 not in parallel with JH1 or RC1)                                 | Omits JH2 (`eventFeed.ts`, `src/ts/network/generationJobs.ts`) and JH3 (`events.ts`, `eventFeed.ts`); TR:36-37 includes JH3, so the two sentences of one plan disagree.                                                                                                                            |
| JH:200-202                                                                       | Names a retired plan and no active one; should name RC1 and TR2 (`shared/jobs.ts`, `server/src/jobs/generationJobs.ts`), TR2/TR3 (`events.ts`, `eventFeed.ts`), TR2 (`src/ts/network/generationJobs.ts`), RC2 (`serverCommands.ts`, `DefaultChatScreen.svelte`), RW4 (`DefaultChatScreen.svelte`). |
| RW:329-331, AL:260-261                                                           | Correct as stated.                                                                                                                                                                                                                                                                                 |

## Part B: cross-plan findings, most severe first

### 1. A reroll carrier past 64 KiB defeats both the feed cap and the job socket, and TR's forms do not rescue it

- Severity: P1 design flaw.
- Plans: RC D3 (line 187-188 "the fields are small and bounded by D4"), D4 (189-203, the rationale at 200-202: no cap
  "would also push rows past `MAX_FEED_PATCH_BYTES`, turning every job patch into a whole read"), D6 (220-224), D7
  (228-240), D12 (292-293); TR D2 (165-181), D3 (187-191), TR:38-39 ("the forms added here apply to them unchanged").
- Evidence:
  - `server/src/data/chatStore.ts:1531-1532`: `chatFeedChange` measures each touched row by
    `Buffer.byteLength(row.data)`, where `data` is the whole stored message JSON (`messages.data`,
    `chatStore.ts:71`; `message: JSON.parse(data)` at :1551). `candidates`, `scriptstateCheckpoint` and every
    candidate's `scriptstateAfter` count against 64 KiB. Over it: `return {}` (neither patch nor delta), and a
    loaded observer reads the chat whole (resource-sync guide line 514-515: "costs up to one read per checkpoint").
  - `server/src/jobs/generationJobs.ts:1293-1296`: a `begin` op adds the message to `job.generated`;
    `diffChat` (:607-612) carries every `generated` row whole at every checkpoint, changed or not. RC D7's
    in-place reroll locks the carrier with `begin`, so today's code sends the carrier with all its candidates to
    the owner every 3 s.
  - The "4 MiB socket admission" (TR D7, line 244-245) is `MAX_BUFFERED_BYTES` of the live-update socket only
    (`server/src/routes/events.ts:22`, :65); `rg bufferedAmount server/src/jobs` finds nothing, so the job socket
    has no bound at all.
  - `server/src/prompt/runner.ts:1657-1669`: a reply's final write is a `setMessage` with a new `generationInfo`,
    not a data-only change.
- One reroll, step by step, for a carrier whose JSON is past 64 KiB (16 x 256 KiB allows about 4 MiB plus up to
  2 x 64 KiB of checkpoint and 16 x 64 KiB of `scriptstateAfter`; with 4-6 KiB replies and a few KiB of variables
  the row passes 64 KiB at roughly 8-12 candidates, sooner for long replies):
  1. Begin group (`begin`, the `patchMessage` that pushes the old reply into `candidates` and moves `selected`,
     D5's `meta` restore): `candidates` changed, so TR's `rowDelta` does not apply. Feed: over cap, a notice and
     one whole-chat read per loaded observer. Job socket: whole row (also for `rows=streamed`, since fields
     differ from the base copy).
  2. Checkpoints (`setText`, `data` only): TR1 `rowDelta` fits; TR2 `streamed` applies from the second patch on.
     Without TR (RC1 may land first; no order across plans is set): a notice and a whole read per checkpoint for
     every observer, and the whole carrier (up to MiBs) to the owner every 3 s.
  3. Final write (`generationInfo`, `scriptstateCheckpoint`, `candidates[selected]`): whole row on both paths;
     over cap on the feed.
  - Later writes stay over the cap for good: every candidate switch (D10 changes `candidates`), any edit or
    translation of the carrier, and D6's unset of the old carrier's checkpoint, which runs in the same group as
    the next send's user-message append, so the next send's publication becomes a notice too.
- Correction:
  - TR carries the main fix: widen D2's `rowDelta` from "changed only in `data`" to a per-row top-level field
    diff (set and unset of the changed fields, `data` as `keep`/`text`). That covers the final `generationInfo`
    write, D6's unset, and the `scriptstateCheckpoint` write. Unchanged `candidates` would then never travel.
    Rewrite TR:38-39.
  - RC carries the rest: correct D3's "fields are small" and D4's rationale; add a per-message total cap on
    `candidates` plus snapshots (for example 1 MiB, dropping the oldest non-selected candidate), which bounds the
    job socket and whole reads (a per-chat cap was the only one rejected); and state that the begin group and a
    switch still go whole once the carrier is past 64 KiB.
  - Stripping `candidates` from feed rows is not the right correction. A feed row replaces the held row whole, so
    a stripped row would erase an observer's candidates. RC D12 and RC4's spec ("a second browser context sees
    the same count without a reload") need them to arrive.
- Confidence: verified for the code paths; the sizes at which a carrier crosses the cap are estimates.

### 2. Job Handoff viewers in "whole mode" would get the whole chat at every checkpoint

- Severity: P1 design flaw.
- Plans: JH D2 (line 117-122 "Viewer sockets receive the job's chat events (whole mode only)"); TR D3 (187-201),
  TR:35-36 ("this plan adds no frame those need").
- Evidence:
  - `server/src/jobs/generationJobs.ts:414` `sentChat` is one field per job.
  - `send`/`sendText` (:742-761) write one serialized event to every socket in `job.sockets`.
  - `emitRecords` (:1466-1477) calls `deliverJobChat(job, "patch")` at each checkpoint, and `jobChatEvent` (:860-891)
    in `"whole"` mode reads the chat whole (`readChat` → `store.readRefs`, :763-774).
  - Read literally, a viewer needs its own whole-chat read, serialization and send at every 3 s checkpoint. For a
    long chat that is MBs to the phone: the device the handoff exists to relieve. It also multiplies TR D3's
    saving away.
  - TR D3's `streamed` form is per socket (a WeakSet flag), but the event is built once per job. Today that is
    safe only because one owner socket exists at a time. JH makes several sockets per job, and a `streamed` row
    that reached a viewer could not be recovered: JH D2 ignores a viewer's `resync`.
- Correction: JH D2 should say that a viewer gets the job chat whole at attach and at the terminal hydration only,
  and no per-checkpoint `chatPatch`. Its stream comes from the chunk and reply events. Its feed patches are held
  while it streams (`canRefreshChat` refuses `isChatStreamedHere`, `src/ts/storage/chatStore.svelte.ts:5973-5982`),
  and the terminal settles it. TR D3 should say that `rows=streamed` and `sentChat` concern the owner socket only
  and that a viewer never receives a `streamed` row. The alternative is a per-socket `sentChat` (a map by socket),
  but it changes the barrier's `hydrateAll` and receipt rule and is more invasive.
- Confidence: verified (code); the cadence JH intends is unstated, so the per-checkpoint reading is the literal one.

### 3. TR's claim that long replies never cause a whole read is false for the final write of every reply

- Severity: P2 contradiction. It is internal to TR, but RC relies on it (TR:38-39).
- Plans: TR:49-50 "never makes a loaded observer read the chat whole (D2)"; TR:180-181 "the ST04 leftover … no
  longer occurs for replies"; D2 eligibility at 167-168 ("changed only in `data`").
- Evidence: `server/src/prompt/runner.ts:1657-1669` (`writeReplyGenerationInfo`: `setMessage` with a new
  `generationInfo`) and `chatStore.ts:1531-1539` (the row measured whole). A reply past 64 KiB still costs every
  loaded observer one whole read at its final write. TR1's tests (320-324) cover only the `setText` checkpoint.
- Correction: the field-level `rowDelta` of finding 1 (TR), or reword TR:49-50 and 180-181 to "one read per reply
  instead of one per checkpoint", with a TR1 test on the final write.
- Confidence: verified.

### 4. Render Slice 0's F1 memo and Transport Slice 0's index both exist to be thrown away

- Severity: P2 contradiction (wasted slice).
- Plans: RW D8 (269-284), RW Slice 0 Files (337) and its first test (345-347), the Slice 0 focused command
  (469-470), the owning-guides line (35-36), the "chat store guide (Job hydration: the validated memo)" in Slice 0
  Files (340); TR D1 (146-164, rejecting "the Render Work Budget memo alone" at 163-164), TR Slice 0 Files
  (300-301 "if its Slice 0 landed first, this slice removes the memo").
- Evidence: both edit `applyServerGeneration` and `showStreamText` in `src/ts/storage/chatStore.svelte.ts`. RW's
  recommended order runs Slice 0 second (RW:452); TR's runs Slice 0 first (TR:405). Both plans are unstarted.
- Correction:
  - Carried by RW: remove F1 from RW D8 and Slice 0 now. Drop `src/ts/storage/chatStore.svelte.ts` and the chat store
    guide from Slice 0 Files, the "200 updates … the memo" test, and `src/ts/storage/tests/chatStore.test.ts` from
    the Slice 0 focused command. Change line 35-36's "chat store … for the three small items" to two items, and say
    "F1 is TR Slice 0" in D8.
  - Carried by TR: drop the conditional removal clause at 300-301, and change "whichever lands first" at TR:34 and
    RW:283-284.
- Confidence: verified (plan text).

### 5. TR D8 delegates a compatibility proof to a test the Job Handoff plan has not written

- Severity: P3 wording.
- Plans: TR:252-253 "keeps ignoring unknown frame types (verified by the Job Handoff plan's tests)"; JH:177-178
  ("verify in Slice 2 that `receive` … drop an unknown `type`"), JH:231 (Files: "unknown types verified ignored").
  The JH Slice 2 Tests bullet (244-252) lists no such case.
- Evidence:
  - Unknown frame types are ignored today. `src/ts/network/eventFeed.ts:140-142` `isFrame` checks only that `type`
    is a string, and the `receive` switch (:262-299) has no `default`.
  - The job event dispatcher also has no `default` (`src/ts/network/generationJobs.ts:1136-1245`), and the job
    socket hands any object on (:934-955).
  - The only related test passes malformed frames (`eventFeed.test.ts:110-125`: `{}`, `{ type: 3 }`), not an
    unknown string type.
  - TR adds no new frame type (only fields), so TR does not actually depend on it.
- Correction: TR D8 should cite the code (`eventFeed.ts:262`, no default branch) and drop the dependency. Whichever
  of JH2 or TR3 lands first should add the unknown-type case to `eventFeed.test.ts`, and JH2's Tests bullet should
  name it.
- Confidence: verified.

### 6. RC's toasts never reach the user who rerolled once the job is handed off

- Severity: P3 unacknowledged interaction.
- Plans: RC D4 (189-196: `rerollCandidateDropped`, `rerollCandidateTooLarge`, `scriptstateCheckpointSkipped`, RC Q3
  312-314 relies on the drop toast); JH D2 (119) and Q3 (194-196: notices on the owner only). With `preferHandoff`
  on a phone (JH Q1), every reroll's toasts go to the PC worker.
- Correction: JH Q3's record should name these toasts as a known cost. An alternative is to tag them
  creator-visible, an exception to Q3 that JH would carry. Otherwise RC D4 should say that the toasts show on the
  job's owner.
- Confidence: verified (plan text).

### 7. RC has no newer-tab/older-server rule, and an older server would duplicate the reply

- Severity: P3 contradiction with the other plans' compatibility stance (JH D8:179-180 and TR D8:251 both cover
  "an older server").
- Evidence: `server/src/routes/generations.ts:202-218` copies only known context fields, so an unknown
  `rerollMessageId` is dropped silently. RC D1/D7 (145) has the client remove nothing, so an older server would run
  the plain reroll path and append a second reply after the carrier.
- Correction: RC D7 should add one sentence. Either the tab sends `rerollMessageId` only to a server that
  advertises it (a capability in `/current` or the create's 202), or the rollback case is recorded as accepted
  because tab and server ship together.
- Confidence: verified (code); the scenario needs a server rollback under a cached newer bundle.

### 8. AL covers candidates by accident; RC's inlay reasoning is partly wrong

- Severity: P3 wording.
- Plans: RC:47-48 and D4 (196-200) say AL's mark "must scan `candidates[].data` beside `data`". AL D1 (119-122),
  D2 (129-136), D3 (139-140) and D9 (207-209) never name candidates.
- Evidence:
  - The mark is still correct. `messages.data` is the whole message JSON (`server/src/data/chatStore.ts:71`), so
    the `instr(text,'assets/')` prefilter and D2's any-depth string scan see `{{inlayed::assets/…}}` inside a
    candidate.
  - `{{inlay::id}}` never carries `assets/`. The asset stays alive through its `inlays` record (an AL D3 root), and
    records are removed only from the Playground explorer (`removeInlayAsset` callers:
    `src/lib/Playground/PlaygroundInlayExplorer.svelte:57,76`). So dropping a 17th candidate cannot make an inlay
    unreferenced, and RC's "reachable from a non-selected candidate" matters only for the Lua key form.
  - A real AL-internal gap: D9 attributes inlays by "the chat whose message holds" them, but D1's prefilter skips
    message rows holding only `{{inlay::id}}`, so attribution needs its own pass, and that pass must read
    `candidates[].data`.
- Correction:
  - AL D2 should add one sentence ("candidate texts are strings of the message row; scanned like `data`"), and AL1's
    Tests (279-289) should add a case: a key named only by `{{inlayed::assets/…}}` inside `candidates[1].data` is
    referenced.
  - AL D9 should say how inlay attribution finds `{{inlay::id}}` (the prefilter does not).
  - RC D4 should reword the inlay sentence to the Lua key form.
- Confidence: verified (code and plan text).

### 9. RC D8's write-back list mixes terminal kinds and omits two reasons; takeover itself is compatible

- Severity: P3 wording.
- Evidence:
  - A request-side `disconnected` (JH's absent-owner path) throws `LuaJobFatalError` (`server/src/prompt/scripts.ts:305-310`),
    so the job ends `error`, which D8 covers.
  - A disconnected `chatOutput` keeps the reply (`runner.ts:1600-1605`), so no write-back runs and the late replay
    may edit the carrier after `candidates[selected]` was copied. D2's refresh-on-switch rule absorbs that.
  - Takeover does not touch the carrier lock, which is keyed by the job token (`generationJobs.ts:930`
    `owner?.token === job.token`). JH D2's whole hydration hands the worker the carrier with `candidates` and
    `selected` as stored. No contradiction.
  - D8 (244-246) lists "`error`, `stopped`, `aborted`, `timeout`". `stopped` is a `done` flag (`shared/jobs.ts:318`),
    not a reason, and `shutdown` and `maintenance` (`shared/jobs.ts:174`) are not named.
- Correction: RC D8 should list the terminals by `GENERATION_ERROR_REASONS` and decide `shutdown` and
  `maintenance`: whether the write-back runs before the store closes or a restore replaces the data. JH needs no
  change.
- Confidence: verified for takeover and `disconnected`; the maintenance write path was not verified.

### 10. TR's change log rides in every AL snapshot

- Severity: P3 unacknowledged interaction.
- Evidence:
  - Snapshots are whole-database copies (`server/src/data/resourceStore.ts:2833` `backup(db, file)`,
    `snapshots.ts:133`).
  - TR D5 (209-217) puts `changes` (up to about 4 MB, TR Q1 270-271) in `resources.sqlite`, and AL Q3 (253-255)
    allows 40 copies.
  - Restore goes through `store.replaceAll` (`server/src/routes/backups.ts:537`), which TR truncates, so
    correctness holds.
- Correction: TR D5 should state that the log is in snapshots (up to about 160 MB across AL's 40 copies) or should
  be cleared in the snapshot copy. AL's report shows it inside `usage.snapshots`.
- Confidence: likely (sizes from the plans' own bounds).

### 11. `shared/jobs.ts` and the socket query strings: compatible, with one same-line conflict

- Severity: P3.
- JH's additions (`role`, `takeover`, `handedOff`, `handoff` body and event), TR's (`streamed` row form,
  `rows=streamed`, `proto`) and RC's (`rerollMessageId`; `alternatives` removed from `done` and the sequence event,
  read only at `serverCommands.ts:622-623` and kept at `generationJobs.ts:469-473`) do not contradict one another.
- No plan reads a field another removes: JH's viewer terminal `skipped: []` and TR's receipts are untouched by RC.
- On the live-update socket, JH D6's per-socket registration and TR D4's per-socket `proto` both replace
  `events.ts`'s identity-less `Set<WebSocket>`, which is compatible.
- The one textual conflict is the same URL line in `src/ts/network/generationJobs.ts:914-917` (Part A).
- Confidence: verified.

## Part C: README summaries against the plans

- Reroll Candidates: "puts the chat variables back to the state before the discarded reply" and "switching
  candidates switches to that candidate's variable state". The plan restores per key, only keys unchanged since the
  reply (D5), and switches variables only on the newest reply when both candidates have snapshots (D10). The README
  also omits D9 (extra samples become candidates and `alternatives` retires), which changes what an older tab sees.
- Render Work Budget: the summary omits Slice 0 (F1 memo, F5, F8) and its supersession by Transport Slice 0.
- Asset Lifecycle: the summary omits the disk preflight (D12, the 507 answers) and the daily read-only scan (D4).
- Incremental Chat Transport: the summary omits `proto=1` on both sockets (D4, Q3).
- Job Handoff: consistent.
