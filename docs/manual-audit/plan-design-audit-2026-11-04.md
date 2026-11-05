# Active plan design audit — 2026-11-04

## Scope and result

Audited the five active plans listed in [docs/plan/README.md](../plan/README.md) at `d31fa9a48` on `dev`
(all drafted 2026-11-03, no slice landed): [Job Handoff](../plan/job-handoff.md),
[Asset Lifecycle](../archived-plan/README.md) (archived), [Reroll Candidates](../plan/reroll-candidates.md),
[Render Work Budget](../archived-plan/README.md) (archived) and
[Incremental Chat Transport](../archived-plan/README.md) (archived). The question was whether each plan's
decisions work against the code as it is, whether the plans contradict themselves, and whether they
contradict each other.

Six independent read-only Opus reviewers each took one seam: one per plan, checking every load-bearing
claim of its Current state and Decisions against the current tree, and one across the five plans (the
shared-file matrix, the mechanisms two plans touch, the README summaries). The session then re-read the
code behind the highest-ranked finding of each report. Their full reports, with file and line evidence
for every item, are in [plan-design-audit-2026-11-04/](plan-design-audit-2026-11-04/). No repository
code or plan text was changed by this audit.

**Every plan needs design corrections before its first slice.** P1 means a decision that cannot work as
written against the code or loses data; P2 a contradiction inside the plan, a wrong claim that changes a
decision, or a narrower flaw; P3 a stale anchor, wording, or an unacknowledged file overlap.

| Plan                       | P1  | P2  | P3  | Report                                                                                      |
| -------------------------- | --- | --- | --- | ------------------------------------------------------------------------------------------- |
| Job Handoff                | 4   | 10  | 4   | [job-handoff.md](plan-design-audit-2026-11-04/job-handoff.md)                               |
| Asset Lifecycle            | 5   | 8   | 1   | [asset-lifecycle.md](plan-design-audit-2026-11-04/asset-lifecycle.md)                       |
| Reroll Candidates          | 7   | 11  | 6   | [reroll-candidates.md](plan-design-audit-2026-11-04/reroll-candidates.md)                   |
| Render Work Budget         | 5   | 7   | 2   | [render-work-budget.md](plan-design-audit-2026-11-04/render-work-budget.md)                 |
| Incremental Chat Transport | 5   | 6   | 5   | [incremental-chat-transport.md](plan-design-audit-2026-11-04/incremental-chat-transport.md) |
| Cross-plan                 | 2   | 2   | 7   | [cross-plan.md](plan-design-audit-2026-11-04/cross-plan.md)                                 |

The counts overlap where two reviewers reached the same defect from different sides (the reroll row size
and the handoff viewer mode are each counted in a per-plan report and in the cross-plan report).

## The corrections that change a design

Ordered by how much of the plan they move. The per-plan reports carry the evidence; the line references
below are the plan files' at `d31fa9a48`.

### Job Handoff

- **JH1. A takeover re-sends outstanding callbacks as replays, and the worker refuses every replay** (D2
  lines 109–110, D7). `sendText` counts any open socket as having received a callback
  (`server/src/jobs/generationJobs.ts` around line 747), a sleeping phone keeps an open socket for 45 s,
  and the tab refuses a `replay: true` it has no state for with `failed`/`protocol`
  (`src/ts/network/jobChannel.ts` around line 111), which ends the job for `editoutput`,
  `bodyIntercepter` and the other request-side kinds. The core scenario (phone sleeps mid-callback, PC
  takes over) ends the job. Nothing cancels the hook still running on the old owner, so side effects can
  run twice. Correction: at takeover, `cancel` the old owner's outstanding requests, then deliver them
  to the new owner as first deliveries (or settle them `disconnected`); add that case to Slice 1 and the
  Slice 4 driver.
- **JH2. Request lanes keyed by the creator break the tab's one-root-callback rule** (D1 lines 96–98). A
  worker running its own job and a handed-off job can receive two roots at once and refuses the second;
  a handed-off job also queues behind the sleeping creator's other jobs. Correction: key lanes by the
  current owner and move queued requests at takeover.
- **JH3. The attach stamp compares wall clocks of different devices** (D2, D4). One stamp per job; a
  phone ahead of the PC makes the PC's takeover a 409 (`generationJobs.ts` around line 2100, the stamp from
  `performance.timeOrigin` in `src/ts/network/generationJobs.ts` around line 847). Correction: one stamp per
  client, compared only within that client.
- **JH4. Skipped `chatOutput` listeners are lost when the owner at the end is a dead worker** (D2, D5).
  The creator always attaches as a viewer, viewers get `skipped: []`, and kept outcomes stay keyed by the
  creator, so nobody replays. Correction: hand the skipped list to the first participant that attaches
  after the end, then clear it.
- **JH5 (shared with Transport).** Viewer sockets in "whole mode only" (D2 lines 117–122) cost a whole chat
  read and send per viewer every 3 s checkpoint, to the phone the plan exists to relieve; `sentChat` is
  one per job. Correction: viewers get the chat whole at attach and at the end and no per-checkpoint
  `chatPatch`; the stream comes from chunk events. Transport D3 should say the streamed form and
  `sentChat` concern the owner socket only.
- Also P2: "first takeover wins" has no server rule and a browser cannot see a refused upgrade's status
  (D2 versus D4 line 145); an `absent` offer never closes on a plain reconnect, so a healthy owner that
  reloads is taken over; the creator cannot take its job back while its viewer follow runs
  (`followJobToEnd` deduplicates by job id) and D2's "a viewer, whatever it asked" conflicts with "any
  client with `takeover=1`"; notices are not only toasts and dialogs (emotion, memory progress, TTS,
  notification, `openURL` go through `applyEffect`), so Q3's owner-only rule strips the phone's display
  state and makes the PC speak; viewer sockets get no pings and drop every 45 s; the boot resume has no
  field to learn its role; the `parentCallback` lookup for a worker hook's `channelCall` still uses
  `ownJob`; a hook the worker lacks fails the job rather than "returns the text unchanged" (D2 lines
  125–128 is a wrong claim).

### Asset Lifecycle

- **AL1. Server-side imports bypass the lease, the lock and the young-file rule** (D3, D7). CharX, PNG and
  module imports skip the write when the file already holds the bytes (`server/src/http/contentAsset.ts`
  around lines 35 and 67; `server/src/routes/importModule.ts` around line 125): the file keeps its old
  mtime, takes no lease, holds no lock, and the import does not run under `snapshots.exclusive`. A
  re-import during a sweep can lose the image the new record names. Correction: one helper in
  `storage.ts` that every "already present" skip and every rename into `save/assets/` goes through,
  taking the key lock and bumping the lease.
- **AL2. A restart reopens the lease window** (D7). The user can `POST /api/assets/scan` right after a
  restart and sweep; Slice 5 (line 364) uses exactly that. `writeCount` restarts per process, so the re-mark
  cannot compare against a run from the previous process. Correction: a sweep accepts only a complete run
  of this process, and is refused until the process has been up for `ASSET_LEASE_MS`.
- **AL3. D2's key pattern has no end** (D2 lines 129–138). `encodeFileName` accepts any non-empty name, so
  "a character run the codec accepts" never terminates; a greedy match swallows the following text and
  marks a key that does not exist, leaving the real one unmarked. Correction: match the keys on disk by
  prefix against the text after each `assets/`.
- **AL4. D1 scans neither `chats.meta` nor most memory tables** (D1 lines 119–128). `chats.meta` holds the
  chat's local lore, `scriptstate`, note and `hypaV3Data`; `memory_events`, `memory_threads`,
  `memory_runs` and the staged memory tables are not in the list. D2's own claim that lorebook text is
  caught depends on them.
- **AL5. "One read transaction" does not fit the single synchronous `node:sqlite` connection** (D1).
  Holding a transaction across awaits blocks every write's `BEGIN IMMEDIATE`; running it synchronously
  blocks the event loop. Correction: a second read-only connection (the database is in WAL mode).
- Also P2: `inlays` records are never deleted by a character delete (only the Playground explorer calls
  `removeInlayAsset`), so inlay media is never reclaimable and Slice 5's "two keys unreferenced" cannot
  pass; the D1 prefilter `instr(text, 'assets/')` skips rows holding only `/api/asset/<hex>` URLs and
  `{{inlay::id}}` references that D9's attribution needs; snapshot `list()`/`resolve()` race the rotation
  tick (false incomplete runs) and the re-mark does not index snapshots taken after the mark; Q1's
  one-day minimum is below the draft journal's 48 h row TTL and Slice 5 runs with `RISU_ASSET_GRACE_DAYS=0`,
  which Q1 forbids; a one-hour lease can expire during a long batch import (missing check up front,
  records written at the end); Slice 3's header "after 2" contradicts the Recommended order; D12's disk
  estimates are wrong (a restore writes a staged copy plus a safety snapshot plus the install; the
  backup import saves the whole archive before it can estimate).

### Reroll Candidates

- **RC1. D7 step (2) opens the generation fence and closes it in the same group** (lines 231–239).
  `patchMessage` "closes an open generation fence" (`shared/chats.ts` line 76), after which every
  generation write is `ignored` and `finalize` throws 409. The `begin` → `patchMessage` order breaks every
  reroll. Correction: `patchMessage` and the D5 `meta` op before `begin`; every later carrier write carries
  the generation; step (4)'s `candidates[selected]` refresh goes into `finalize`'s final `setMessage`.
- **RC2. D8's write-back runs after the lock is gone** (lines 244–249). The lock is released on any final
  write, which `runSpeaker` makes itself on abort and in its `finally`. Correction: the write-back must be
  that final write, one group with the variable restore.
- **RC3. The non-streaming reply write replaces the whole row** (`runner.ts` around line 1814 writes a fresh
  `setMessage`), dropping `candidates`, `selected` and `scriptstateCheckpoint`. Correction: build it from
  the stored row as `finalize` does.
- **RC4. An output trigger that removes the carrier deletes every candidate** (not covered by D8).
- **RC5. A tab with a stale copy erases a newer reroll when it switches** (D10, D12). `patchMessage` sets
  whole fields on a stale revision, so a resumed phone's switch writes its old `candidates` over another
  tab's newer list. Correction: a conditional write (`expect` the current candidates revision), which is
  the server op D10 rejected.
- **RC6 (shared with Transport). D4's caps allow rows far over 64 KiB** (lines 189–203). `chatFeedChange`
  measures the whole stored message JSON including `candidates`; over `MAX_FEED_PATCH_BYTES` the feed
  carries nothing and every loaded observer reads the chat whole on every write of that message, and the
  job socket resends the carrier whole every checkpoint (`diffChat` sends every `generated` row). A
  per-message total cap (the plan rejected only a per-chat cap) and, in Transport D2, a per-field row diff
  are the corrections; stripping `candidates` from feed rows is not (a feed row replaces the held row).
- **RC7. After a switch the next reroll restores variables wrongly** (D10, D5, D7): the switch does not
  update `scriptstateCheckpoint.after`, so the per-key comparison treats the response's own writes as
  user edits. Correction: the switch sets `after` to the selected candidate's.
- Also P2: no tab creates a `reroll` job today (`serverGeneration.ts` picks `send`; Current state lines
  78–79 are wrong) and a group chat picks several speakers, so D7 needs one speaker; "Stop today discards
  it too" is wrong (the partial text is written on abort); D8 erases an `inlayErrorResponse` error; D3's
  "2 or more, else absent" contradicts D8 removing the new slot and, read literally, drops every single
  reply's checkpoint; "history ending before the carrier" names no mechanism (assembly, the memory
  source, `runCurrentChatFunction` and the trigger copy all read the whole chat); the carrier keeps a stale
  `promptInfo` and a switch brings back stale memory receipts inside `generationInfo`; D10 contradicts Q1
  and Out of scope on switching older messages; Slice 1 cannot pass `pnpm check` alone (the tab still reads
  `alternatives`); a not-yet-reloaded tab's reroll removes the carrier, so "nothing a tab sees differs" is
  false; `patchMessage` runs the normalizer, so D3's silent drop turns a client bug into data loss;
  `rerollTargetMoved` is outside the closed error-reason set.

### Render Work Budget

- **RW1. Aborting a run during the cached-only probe loses auto-translation** (D1). `lastCharArg`,
  `lastChatId` and `lastAutoTranslate` are set before the probe's first await, so a superseding run skips
  the probe, and under D1 the aborted run never flips `translated`; the probe's inner `catch` also swallows
  the `AbortError`. Correction: set the three fields after the probe completes or reset them on abort;
  rethrow the abort from the inner `try`.
- **RW2. Cancelling a dispatched chunk goes through the transform failure path** (D3, D7). An aborted
  `post` lands in `sendChunk`'s `catch`, which answers every open target `ok: false`: the failure toast,
  `replaceTransformResult` evicting the good cache entry, a `transformFailed` client event and a
  retry round. Correction: a `cancelled` settlement (a WeakSet like `epochRefusals`) that skips all four.
- **RW3. The in-flight join key omits the plugin context**, which the batch key includes on purpose, and
  a cancelled operation stays joinable. Correction: key by batch key plus `inputs`; remove on cancel.
- **RW4. The LLM translation in-flight map ignores `regenerate`**: a Retranslate joins a plain call and gets
  the old text. Correction: a regenerate call never joins.
- **RW5. D2's transient retry would almost never fire**: the highlight loader's import failure is
  swallowed inside `ParseMarkdown`; DeepL and DeepLX non-2xx answers return `ERR::` strings that
  `runTranslator` alerts itself; `translateLLM` catches everything but an abort; the reads that can
  reject into `markParsing` (`getInlayMedia`, `getFileSrc`) are not listed.
- Also P2: D1 and D4 contradict each other on whether in-flight translation jobs are aborted (the
  signal reaches the provider `fetch`, so "a job already requested still writes the cache" is false and
  the "at most ten open" test breaks); an abort can leave `translating` stuck at true (no `finally`); the
  `shownBody` memo key misses `modelShortName` and the CBS variables; `AbortSignal.any` goes against
  the client's existing Safari < 17.4 rule in `assetClient.ts`; a row taller than 16,384 px fits no page
  under "no row split" (`html-to-image` scales it down) and D6 drops the existing reversed row order;
  "disjoint files except `parser.svelte.ts`" ignores the guides Slices 1, 3 and 4 share.

### Incremental Chat Transport

- **TR1. The change-log insert covers one of four write paths** (D5 lines 213–215). Only
  `applyChangesInScope` records refs after `commitTransaction()`; `put`, `delete` and `transaction()`
  record inside the transaction, and a character delete's chat and order deletions are recorded outside
  `results`. Correction: a per-transaction list fed by the `record*` functions, written in
  `commitTransaction()` before `COMMIT`.
- **TR2. The `changes` table would never exist on an existing database** (D5 lines 209–211).
  `STORE_TABLES_SQL` runs only when `user_version === 0` (`resourceStore.ts` around line 3330); every
  write on an existing install would fail while fresh test stores pass. Correction: `CREATE TABLE IF NOT
EXISTS` at open, as `chatGroups` and `memory_*` do, outside the snapshot table list.
- **TR3. The digest check after a replay misses whenever anything else is writing** (D5 lines 223–228).
  `receive` applies `change` frames to the advertised map while a reconcile is pending and the replay is
  answered at request time, so a 3 s checkpoint on another device forces the full listing, which is the
  case the plan targets. Correction: bound the replay with `until=<hello.cursor>` and check the digest on
  the map as of `hello`, or let the replay carry its own digest.
- **TR4. D2's selection order cannot meet the Goal and D8 at once** (lines 48–50, 172–181). `patch` first
  keeps whole rows for every reply under 64 KiB (SD01's case); `rowDelta` before `delta` costs an older
  client a `delta` it applies today. Choose, and rewrite the Goal's "chunk-sized frames" claim; the final
  reply write (`generationInfo` changes) always goes whole, so "a long reply never forces a whole read" is
  false either way (one read per reply, not per checkpoint).
- **TR5. D3 keeps stale text when the owner's stream buffer is behind the watermark** (lines 187–197). The
  current watermark rule is safe only because the patch carries the row; `diffChat` has no chunk seq to
  emit (`generationSeq` counts checkpoints). Correction: apply a `streamed` row only when the buffer seq
  is at or above the watermark, else `resync`; the server takes the seq from `job.watermarks`.
- Also P2: "Slices 0, 2 and 3 touch disjoint files" (line 408) is false (0 and 2 share
  `chatStore.svelte.ts`; 2 and 3 share `events.ts` and `eventFeed.ts`); D2's `patch ?? rowDelta ?? delta`
  contradicts Slice 1's test that an entry with both "is not a body this client knows" (today's code is
  `delta ?? patch`); D7 puts `streamed` entries under `budgetedEntries`, which the job `chatPatch` never
  passes through; the probes D9 names do not measure what the slices need (`checkpoint-probe.mjs` writes
  a different text per checkpoint so there is no shared prefix, `sync-traffic-measure.mjs` has no feed, so
  Q2's gate has no input); D6 reuses `unanswered`, which `readRefs` resends and then fails with "no
  progress".

## Cross-plan

### Shared files the plans do not acknowledge

From every slice's Files paragraph (the cross-plan report has the full table):

| File                                                         | Slices                                 | Plans' own statement                                           |
| ------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------- |
| `server/src/jobs/generationJobs.ts`, `shared/jobs.ts`        | JH1, RC1, TR2                          | JH names only the retired plugin runtime plan; RC omits TR2    |
| `server/src/routes/events.ts`, `src/ts/network/eventFeed.ts` | JH1, JH3, TR2, TR3; JH2, JH3, TR2, TR3 | TR line 291 omits TR2 against JH3 and JH2                      |
| `src/ts/network/generationJobs.ts`                           | JH2, TR2 (same URL line)               | none                                                           |
| `src/ts/process/serverCommands.ts`                           | JH2, RC2 (same callback)               | none                                                           |
| `src/lib/ChatScreens/DefaultChatScreen.svelte`               | JH3, RC2, RW4                          | RW lines 43–46 say Job Handoff shares no file with it: wrong   |
| `src/lib/ChatScreens/Chats.svelte`                           | RC2, TR0                               | none                                                           |
| `src/ts/storage/chatStore.svelte.ts`                         | RW0, TR0, TR1, TR2, TR4                | RW0/TR0 acknowledged; TR line 408 "0, 2 and 3 disjoint": wrong |
| `shared/resources.ts`, `src/ts/storage/resourceClient.ts`    | AL3, TR1, TR3, TR4                     | TR covers TR1/TR3 only                                         |
| `server/src/app.ts`                                          | JH1, AL1, TR3                          | JH1/TR3 only                                                   |
| `src/lang/en.ts`, `ko.ts`                                    | JH2, JH3, RC1, RC2, AL4, RW4           | none (append-only keys)                                        |

Job Handoff lines 200–202 still schedule against the server plugin runtime plan, retired unbuilt on
2026-11-03, and against no active plan.

### Mechanisms two plans touch

- **X1 (P1). Reroll rows versus the transport's deltas and caps**: RC6 above. The transport's `rowDelta`
  (changed only in `data`) and `streamed` form (other fields equal the base) both exclude the reroll's
  begin group, final write and every later switch, and the carrier stays over the cap for good.
  Correction in Transport D2: a per-row top-level field diff with `data` as a text delta; in Reroll D4: a
  per-message total cap and a corrected "fields are small" rationale.
- **X2 (P1). Handoff viewers versus the transport's job socket savings**: JH5 above.
- **X3 (P2). Render Slice 0's F1 memo and Transport Slice 0's index duplicate each other**; both plans are
  unstarted and both orders put Slice 0 early, so "whichever lands first" is a real race. Correction:
  remove F1 from Render D8 and its Slice 0 now; drop the conditional removal at Transport lines 300–301.
- **X4 (P3). Transport D8 cites Job Handoff tests that do not exist**: unknown frame types are ignored
  today (`eventFeed.ts` `receive` has no default branch; the job event switch neither), but no test covers
  it. Cite the code; the first of JH2 or TR3 to land adds the test.
- **X5 (P3). The reroll's three toasts reach only the job's owner** under Handoff Q3, so a phone with
  "prefer a worker" never sees `rerollCandidateDropped`. Record in one plan.
- **X6 (P3). Reroll has no older-server rule**: `routes/generations.ts` copies only the context fields it
  knows, so an older server drops `rerollMessageId` and, since the new tab removes nothing, appends a
  second reply.
- **X7 (P3). Asset Lifecycle covers `candidates[].data` by construction** (the any-depth scan over the
  message JSON) but names neither the field nor a test; add one sentence and one Slice 1 case. Dropping a
  17th candidate cannot orphan an inlay, because inlay media lives through its `inlays` record (see the
  Asset P2 on records never deleted).
- **X8 (P3). The transport's change log (about 4 MB at the 20,000-row bound) is copied into every
  snapshot**, and the asset plan allows 40 of them; Transport D5 should say so.
- Compatible: the three plans' edits to `shared/jobs.ts` and the socket query strings; the reroll lock is
  keyed by the job, so a takeover does not touch it (Reroll D8 should still decide `shutdown` and
  `maintenance`, which its list omits).

### README summaries

The [plan README](../plan/README.md) line for Reroll Candidates says a reroll "puts the chat variables
back" and a switch "switches to that candidate's variable state" without D5's per-key rule and D10's
newest-reply-only condition, and omits D9; Render Work Budget's line omits Slice 0; Asset Lifecycle's
omits the daily scan and the disk preflight; Incremental Chat Transport's omits `proto=1`. Job Handoff's
line matches its plan.

## Method and limits

- Each per-plan reviewer read STRUCTURE.md, the plan, the named sections of its owning guides and the
  code behind every Current state and Decisions claim, with `rg` for each anchor; findings were ranked
  and labelled verified, likely or unverified in the reports.
- The session re-read five claims in code before accepting them: the fence close in `patchMessage`
  (RC1), the schema install only on `user_version === 0` (TR2), `sendText` counting any open socket as a
  delivery (JH1), the cancelled chunk landing in the failure `catch` (RW2), and the import skip that never
  touches the file (AL1). All five hold.
- Nothing was run: these are findings from reading, not reproductions. Two cross-plan sizes (the carrier
  crossing 64 KiB, the snapshot growth from the change log) are arithmetic, not measurements.
- Not covered: the archived plans, the research notes the plans cite, and the guides beyond the sections
  the plans name.
