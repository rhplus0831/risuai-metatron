# Reroll Candidates Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the [design
audit](../audit/plan-design-audit-2026-11-04.md); no slice landed. Decisions D1–D14 are recommendations for
the owner; the **Open questions** Q1–Q4 were answered by the owner on 2026-11-03 (the recommended option each
time). The revision corrects D2–D5 and D7–D10 (D10 now takes the server op its draft rejected) and adds D13
and D14. Code anchors re-checked at `215cbce1d`; verify them again before editing (STRUCTURE.md protocol step
5).

Sources: the owner's 2026-11-03 choice of this plan as the next one after the asset lifecycle plan;
[PocketRisu/RisuBard picks](../research/pocketrisu-risubard-picks.md) §1.1 item 1 (per-reroll scriptstate
checkpoints, implemented on the server since rerolls are server jobs, kept on the latest message only) and
§2.1 "Rerolls do not become memory (commit boundary)"; [RisuNest ideas](../research/risunest-ideas.md) §1
item 9 (persisted reroll candidates and interrupted-reroll recovery) and the
[research README](../research/README.md)'s RisuNest open item 2 (whether the persisted field should match
PocketRisu's shape for interchange, decided in D2); the [PocketRisu survey](../research/pocketrisu-survey.md)
("Persistent swipe history and swipe UI": `swipes[]` and `swipeId` on the message, the `01e732dc` data-loss
fix) and the [RisuBard survey](../research/risubard-survey.md) §2.3.2 (`scriptstateCheckpoint{before,after}`
plus one checkpoint per swipe, latest message only, the tens-of-MB growth fixed in 0.9.69) and its concept 7
(a reply becomes memory only when the user continues past it); the reference implementation in the sibling
checkout `/home/codex/RisuBard/src/ts/chatScriptstateCheckpoint.ts` (`attachScriptstateCheckpoint` dropping
older messages' copies, `restoreScriptstateBeforeReroll`, `restoreSelectedSwipeScriptstate`,
`scriptstateSwipeCheckpoints` with `null` for a swipe without one) and its callers in
`/home/codex/RisuBard/src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`, `unReroll`, `nextSwipe`,
`deleteSwipe`; the failure path puts the original scriptstate back), read only; the
[chat pipeline guide](../structure/chat-pipeline.md) (Reroll modules, Reroll, Request id retention), the
[server generation guide](../structure/server-generation.md) (Generation admission, Prompt job execution,
Own chat changes, Job chat and barriers), the [scripts and triggers guide](../structure/scripts-triggers.md)
(Flows, State: variables are `chat.scriptstate['$'+key]`; Limitations: the shared pending metadata write),
the [persistence guide](../structure/persistence.md) (Shared shapes, Chat fields, Messages, the compatibility
rule), the [chat store guide](../structure/chat-store.md) (By-id ops, Map merges, Job hydration), the
[structured memory writer guide](../structure/structured-memory-writer.md) (The writer's windows), the
[memory guide](../structure/memory.md) (Selection, Memory writes), and the
[backup and sync hub guide](../structure/backup-sync-hub.md) (Upstream database export) at `8f0db0fb7`; the
2026-11-04 [design audit](../audit/plan-design-audit-2026-11-04.md) (its Reroll Candidates section RC1–RC7 and
the cross-plan items X1, X5, X6, X7), its [per-plan
report](../audit/plan-design-audit-2026-11-04/reroll-candidates.md) (24 findings with file and line evidence),
and an independent cross-check of that audit (the failed attempt's own variable writes and the stale switch's
variable decision, both answered by D10 and D13).

Owning guides when sliced: [persistence](../structure/persistence.md) (the message fields and their
normalization), [server generation](../structure/server-generation.md) (the reroll job's in-place
generation, the snapshots, the write-back), [chat pipeline](../structure/chat-pipeline.md) (the candidate
controls, what the per-chat bundle history still covers), [scripts and
triggers](../structure/scripts-triggers.md)
(what a reroll does to variables), [chat store](../structure/chat-store.md) (the `selectCandidate` op),
[structured memory writer](../structure/structured-memory-writer.md) and [memory](../structure/memory.md)
(the commit boundary), [backup and sync hub](../structure/backup-sync-hub.md) (the export mapping and the
import conversion), [test harness](../structure/test-harness.md) (the e2e spec).

Relation to other work: Chat Checkpoints (named per-chat save slots, done) snapshot the whole chat including
`scriptstate` in their meta (`server/src/data/checkpointStore.ts` `save`, `CHECKPOINT_CHAT_FIELDS` marks
`scriptstate` as `capture`); they are a different feature, user-named and whole-chat, and this plan reuses
none of their storage (a message's checkpoint is a field of the message, captured and restored by the job).
The Deep Audit Fixes (done) made a trigger's result merge `scriptstate` by key (`applyTriggerChat`,
`CHAT_META_MERGE_KEYS`), which is what the per-key restore of D5 relies on. The [Asset Lifecycle
plan](asset-lifecycle.md), written in parallel, scans the strings of a message's JSON at any depth, so the
inlay references inside non-selected candidates (`candidates[].data`) are covered by construction; that plan
adds a test for it, and this plan names the field (D4). The [Incremental Chat Transport
plan](incremental-chat-transport.md) carries the rows this plan makes larger: its D2's delta forms keep a
text-only checkpoint small, and its Slice 4 (the over-cap row manifest and the by-id row read) is a hard
dependency of this plan's Slice 2 (D4). The [Job Handoff plan](job-handoff.md) keys nothing this plan needs by
owner (the reroll lock is the job's, so a takeover does not touch it), but its notices reach the job's owner
only (D12); the slices that share files are listed under **Slices**.

## Goal

Two persistent fields on an assistant message, designed together because they share the message schema,
the normalizer, the reroll job and the export rules:

- **Persisted reroll candidates.** The alternatives the user generated for one assistant turn live on the
  message, so they survive a reload, show in another tab and on the phone, and an interrupted reroll leaves
  the previous reply one swipe away instead of lost.
- **Per-reroll scriptstate checkpoints.** The chat's variables (`chat.scriptstate`, written by triggers, Lua
  and CBS during a response) are snapshotted before and after each response. A reroll puts the `before`
  state back before its triggers run, so variable side effects of the discarded response do not pile up;
  switching between candidates switches to that candidate's `after` state. Only the latest assistant message
  keeps checkpoints.
- The memory commit boundary: a discarded candidate is never memory input; only the candidate selected when
  the user sends the next message is.

Not goals: candidates for a tail of several replies (a group chat's turn, a trigger's resend round), a
candidate per message that is not the newest reply, deleting single candidates from the UI, PocketRisu or
RisuNest export shapes beyond what D11 states, and a change to named chat checkpoints.

## Current state

The baseline is `215cbce1d` on `dev` (2026-11-04; no source changed since the draft's `8f0db0fb7`). This plan
does not re-propose it.

- **Reroll is a client-side removal followed by a plain send.** `reroll` in
  `src/lib/ChatScreens/DefaultChatScreen.svelte` (around line 582) first tries the in-memory swipe candidates
  (`Prereroll(genId)`), then the per-chat bundle history (`rerollHistory.canForward`), then pops every message
  after the last user message (with the group `saying` rule), records the removed tail
  (`rerollHistory.begin`), writes the shortened list with `editChatSync`, and calls `sendChatMain(false, ref)`
  (around line 645) with no input. That send is a `send` job, or a `group` job for a group owner:
  `src/ts/process/serverGeneration.ts` (around lines 93–101) picks `preview`, `previewPrompt`, `group`,
  `continue` or `send`, never `reroll`, so no tab creates a `reroll` job today. A send that brought no reply
  puts the tail back (`restoreRerolledReplies`), with the "unsafe" cases the guide lists; a stopped send that
  left a partial reply is not one of those, since the partial reply holds the anchor. `unReroll` tries
  `PreUnreroll`, then `rerollHistory.back`.
- **Candidates are tab memory.** `src/ts/process/prereroll.ts` keeps
  `Map<generationId, { values, index, ref, messageId }>` of a reply's alternatives (the extra samples of one
  request: `terminal.alternatives`, installed by `installReplyAlternatives` in
  `src/ts/process/serverGeneration.ts` around lines 156–157, and a sequence event's `alternatives` in
  `src/ts/process/serverCommands.ts` `followOnce` around lines 622–623, both through `addRerolls`); a swap is
  a `setMessageText`. `src/ts/process/rerollHistory.ts` `createRerollHistory` keeps per-screen bundles of
  removed replies, 16 chats by last use. Neither touches `scriptstate`; both are lost on reload, remount, and
  in every other tab (chat pipeline Known Hazards).
- **The server treats a reroll as a send with empty input.** `job.kind === "reroll"` appears in
  `server/src/jobs/generationJobs.ts` only to fire the auto checkpoint (`onChatJobDone`, line 1182);
  `INPUT_KINDS` in `server/src/prompt/runner.ts` and `server/src/routes/generations.ts` admit a
  `userMessageId` for it (the kind-restricted field, around lines 176–179; `continueMessageId` is accepted for
  every kind, around lines 171–175). The route copies only the context fields it knows into the job (around
  lines 202–218), so an unknown field is dropped. `runPromptJob` loads the job scope, runs the input stage
  when there is input, then `runSpeaker` per speaker and round: setup, `assemblePrompt` (the `start` trigger
  inside), the request, the tail (`editoutput`, the `output` trigger, inlays, `chatOutput` listeners), the
  reply written as a new message with `generationInfo` and `promptInfo` (`runner.ts` around lines 1683–1696;
  `writeReplyGenerationInfo` later), and `done` with the last reply's id and that round's `alternatives`
  (streaming: `Object.values(stream.lastChunk)`; non-streaming: `mrerolls`). A group owner's speakers come
  from the group order unless the context names `speakerChaId` (around lines 487–507). A continue instead
  locks an existing message (`op: "begin"` on `continueMessageId`, around lines 1210–1221) and streams into
  it: the in-place path this plan reuses.
- **The generation's writes.** A write without a generation closes an open generation fence of its message:
  `patchMessage` says so (`shared/chats.ts` around lines 75–78), and the store calls `closeFence` for it
  (`server/src/data/chatStore.ts` around lines 1936–1943); every later write of that generation is `ignored`,
  and `finalize` throws 409 on an ignored final write (`runner.ts` around lines 1175–1204). A `setTranslation`
  leaves the fence as it is. The final write releases the message lock (`generationJobs.ts` around lines
  1324–1330); `runSpeaker` makes it itself on an abort or a read failure, carrying the text so far
  (`runner.ts` around lines 1730–1736), and in its `finally` for a generation still open (around lines
  2083–2089); an aborted job has `JOB_ABORT_GRACE_MS` (5 s) to write. The streaming final write of a continue
  is a `setMessage` built from the stored row (around lines 1189–1193); the non-streaming continue writes a
  fresh whole row `{ role, data, saying, time, generationInfo, promptInfo, chatId }` (around lines 1814–1832).
  `setMessage` never changes a stored translation (`chatStore.ts` around lines 1951–1960). An output trigger
  that drops the reply from its chat becomes a `remove` op (`server/src/jobs/chatResult.ts` around lines 85–87
  and 139–141) and the turn ends `removed` (`runner.ts` around lines 1766–1771). With `inlayErrorResponse`,
  `throwError` appends the error to the owned last reply and the send ends `done.stopped` (around lines
  1016–1041). Error terminals carry a reason from the closed set `GENERATION_ERROR_REASONS` (`shared/jobs.ts`
  around line 175: `failed`, `aborted`, `shutdown`, `maintenance`, `timeout`); `shutdown` and `maintenance`
  abort a running job as a stop does.
- **What reads the chat in a speaker run.** Prompt assembly's `chat` (`runner.ts` around line 1373), the
  memory step's `readSource` (around lines 1322–1339), `runCurrentChatFunction` (around lines 1244–1270), and
  the triggers' `runOnCopy` (`server/src/jobs/runSetup.ts` around lines 352–358), which runs a trigger on a
  whole-chat copy and diffs the result against that copy as its baseline (`applyTriggerChat`); a message the
  diff finds new is appended after its predecessor in the result (`chatResult.ts` around lines 167–178). Lua's
  `liveChat` (`server/src/lua/bindings.ts` around line 354) reads the scope's chat. All of them read the whole
  chat.
- **How variables are written in a job.** Triggers write `chat.scriptstate` on the job's copy
  (`server/src/prompt/triggers.ts` around line 566) and `applyTriggerChat` merges changed entries by key
  against the baseline; Lua's `setChatVar` queues one entry through the job's pending metadata write
  (`server/src/jobs/jobScope.ts` `createChatMetadata`, the flush around lines 488–518: a `meta` op with
  `merge: { scriptstate }`); `/setvar` commands set the whole map (`server/src/prompt/commands.ts` line 286).
  The tab's `setChatVar` (`src/ts/parser/chatVar.svelte.ts`) merges one entry with `mergeChatMeta`.
  `CHAT_META_MERGE_KEYS` (`shared/chats.ts`) lists `scriptstate`, so `merge`/`mergeUnset` act per entry on the
  stored map, with no expected value. The display transform keys its cache by a metadata digest that includes
  `scriptstate` (`server/src/prompt/transform.ts`), so a restore re-renders.
- **Message schema and storage.** `Message` (`shared/database.ts` line 1311): `role`, `data`, `saying`,
  `chatId`, `time`, `generationInfo` (`MessageGenerationInfo`, whose `context` is the request's
  `ContextReport` and `memory` the structured writer's receipt), `promptInfo` (`MessagePresetInfo`, whose
  `promptText` holds the whole prompt when `promptTextInfoInsideChat` is on), `name`, `disabled`, `isComment`,
  `translation`. A message is one `messages` row whose `data` column is its JSON, beside the generation
  columns (`generationId`, `generationSeq`, `generationFinal`, `generationHistory`, the last keeping 8 earlier
  generation ids: `MAX_GENERATION_HISTORY`, `server/src/data/chatStore.ts`). `normalizeMessage`
  (`server/src/data/chats.ts` line 142) checks role, `data`, `chatId`, and drops an invalid `translation`
  without refusing the message; the chat's other fields are refused with a `ResourceValidationError` in the
  same file; there is no field whitelist, so an unknown field is stored as sent (persistence D2: default at
  the readers). `patchMessage` and `setMessage` both run `normalizeMessage`. The `patchMessage` op sets or
  unsets named fields of the stored row, also on a stale revision (`shared/chats.ts` line 82; the client's
  `patchMessage`, `src/ts/storage/chatStore.svelte.ts` line 3317). Rows travel whole: the job's `chatPatch`
  carries every generated row on each checkpoint (`diffChat`, `generationJobs.ts` around lines 579–608), and
  the live-update feed's `chatFeedChange` (`chatStore.ts` around lines 1487–1537) measures the whole stored
  row and, over `MAX_FEED_PATCH_BYTES` (64 KiB), carries nothing, so every loaded observer reads the chat.
- **Memory input.** The structured writer's windows stop before the last eligible user message
  (`writerCeiling`, `server/src/prompt/memory/structured/window.ts`): "the newest reply and one being
  generated or continued stay out; swipe candidates are not stored messages at all". `handOffMemory`
  (`runner.ts` line 643) runs for every `INPUT_KINDS` job, a reroll included. HypaV3 and SupaMemory summarize
  the oldest eligible messages inside the next send's assembly. A press on a message ("record now") confirms
  it `inclusive`, newest reply included.
- **Export and import.** `buildUpstreamDatabase` (`server/src/data/upstream/exportDatabase.ts`) strips
  `METATRON_CHAT_FIELDS` and each message's `translation` (reported as `message-translations`), and refuses
  nothing; `convertMessages` in `importCharacters.ts` runs `normalizeMessage`. Upstream RisuAI has no swipe
  field at all (`/home/codex/Risuai/src/ts/storage/database.svelte.ts` has only the `swipe` UI flag).
  PocketRisu and RisuBard store `swipes?: string[]` and `swipeId?: number` on the message
  (`/home/codex/PocketRisu/src/ts/storage/database.svelte.ts` line 2398), RisuBard adding
  `scriptstateCheckpoint` and `scriptstateSwipeCheckpoints`. RisuNest's
  `responseVariants { groupId, selectedId, candidates: [{ id, messages[] }] }` is its own shape, and it
  converts PocketRisu's `swipes` into it on import
  (`/home/codex/RisuNest/src/ts/drive/pocketRisuFeatures.ts`). So the research README's "match PocketRisu's
  `responseVariants`" names a field PocketRisu does not have.
- **Capability signals.** `GET /api/generations/current` answers 404 when the chat runs no job
  (`readChatGeneration`, `src/ts/network/generationJobs.ts` around lines 657–686); the create's answer
  (`GenerationCreated`, `shared/jobs.ts` around line 146) arrives after the job is admitted. The live-update
  socket's `hello` frame (`shared/events.ts` around lines 42–48, sent by `server/src/routes/events.ts` around
  line 136) goes out on every connection.
- **UI.** `Chat.svelte`'s `rerolls` snippet (line 1783) shows ← and → when `settings.ui.swipe` is on (else one
  regenerate icon), disabled while the message is `locked`; `Chats.svelte` mounts every row with
  `rerollIcon: "dynamic"` and the screen's `onReroll`/`unReroll`; the greeting row has a page counter
  (`showFirstMessagePages`). No e2e spec covers the reroll controls; `e2e/perChatSends.spec.ts` has the local
  mock provider pattern.

## Decisions

- **D1. The carrier message keeps its id; a reroll regenerates it in place.** The newest reply (the last
  message of the chat after trailing comments, role `char`, the only reply after the last user message) is the
  carrier of its candidates. A reroll of it is a `reroll` job whose context carries `rerollMessageId` and
  names the carrier's `saying` as `speakerChaId`; the job locks the carrier with `op: "begin"` as a continue
  does, and streams the new text into it. The client removes nothing and `restoreRerolledReplies` is not
  involved. Rejected: today's removal plus a new message per reroll (each reroll changes the reply's id, so
  bookmarks, memory receipts, stored translations, the generation history, and by-id ops of other tabs all
  point at a gone message, and the interrupted-reroll problem is exactly the removal); RisuNest's
  candidate-as-message-list (`responseVariants`), which replaces message rows on every switch for the same
  reason. A tail of several replies (a group chat's turn of several speakers, a resend round) keeps today's
  path: removal, bundle history, no candidates (**Later**).
- **D2. The persisted shape is metatron's own.** On the carrier:

  ```ts
  candidates?: MessageCandidate[]; // 2 or more entries, else absent (D3)
  selected?: number; // index into candidates; absent means 0
  scriptstateCheckpoint?: { before: ScriptstateSnapshot; after: ScriptstateSnapshot }; // latest reply only
  type MessageCandidate = {
      data: string;
      generationInfo?: MessageGenerationInfo; // without `context` (D4)
      promptInfo?: MessagePresetInfo; // without `promptText` (D4)
      translation?: MessageTranslation;
      scriptstateAfter?: ScriptstateSnapshot; // latest reply only; absent: switching changes no variable
  };
  type ScriptstateSnapshot = Chat["scriptstate"] | null; // null: the chat had no map
  ```

  The invariant every reader relies on: the carrier's own `data`, `generationInfo`, `promptInfo` and
  `translation` are always the selected candidate's, so prompt assembly, memory, search, translation, export,
  and older tabs read the selected reply without knowing about candidates; and `scriptstateCheckpoint.after`
  is the selected candidate's `scriptstateAfter` (no checkpoint when the selected candidate has none), so the
  next reroll's restore (D5) compares against the reply on screen. `candidates[selected]` is a copy of those
  fields, refreshed by the reroll's begin group and when the user switches away (an edit made meanwhile is
  what switching back brings, as `prereroll.ts` does today). Rejected: PocketRisu's `swipes: string[]` plus
  `swipeId` (text only: no `generationInfo`, no translation, no variable state, and the research README's
  interchange question is answered by D11 instead); RisuNest's `responseVariants` (whole message snapshots,
  see D1); a candidate without `promptInfo` (the draft: every candidate showed the first reply's prompt, and a
  switch kept a stale one: the audit). Field names and the checkpoint shape follow RisuBard's
  `scriptstateCheckpoint { before, after }` so a RisuBard backup's checkpoint converts one to one (D11).

- **D3. The shared type, the shape rules, the ownership.** `shared/database.ts` gains the types above;
  `shared/rerollCandidates.ts` (pure, T2 rules) holds the helpers both runtimes use: `candidateOf` (the copy
  D4 trims), `withCandidate` (the refresh of `candidates[selected]`), `scriptstateRestorePatch` (D5), the
  candidate selection of D10, and the caps. `normalizeMessage` checks each field on its own shape:
  `candidates` an array of at least two plain objects with string `data` and an optional valid
  `generationInfo`, `promptInfo`, `translation` and snapshot, within D4's caps; `selected` an integer in
  range, only beside `candidates`; `scriptstateCheckpoint` a `{ before, after }` of two snapshots, validated
  independently of `candidates`, so a single reply keeps its checkpoint. `candidates` is absent when fewer
  than two remain: a write that leaves one entry (D8's removal of the new slot) unsets `candidates` and
  `selected`. On op writes (`patchMessage`, `setMessage`, `selectCandidate`, and the other ops that carry a
  message) a malformed or over-cap field is refused with a `ResourceValidationError`, as the chat field
  validators of `server/src/data/chats.ts` refuse theirs; the silent drop (the field gone from the copy, the
  message kept, as an invalid translation is dropped) applies only to an imported chat (`convertMessages`) and
  to a stored row read back, so an imported or old chat keeps its messages. The caps are enforced by the job's
  writes (which trim before writing, D4) and by the validator alike. Messages are chat data, not a section, so
  `shared/sections.ts` is unchanged (persistence D2: stored as sent, defaults at the readers), and chats with
  no field need no migration: absent means one candidate, no checkpoint. `CHECKPOINT_CHAT_FIELDS` is unchanged
  too: named checkpoints capture message rows whole, so candidates travel with them. Rejected: a separate
  `messageCandidates` table (every reader of a message would need a join; D4 bounds the fields, though not
  below the feed's cap); dropping a malformed field on every write, as the draft did (`patchMessage` and
  `setMessage` run the normalizer, so a tab's bug in a switch would silently delete every candidate and the
  checkpoint: the audit); dropping the checkpoint with an invalid or absent `candidates` (the draft's wording:
  it took the checkpoint of every single reply).
- **D4. Size bounds.** `MAX_MESSAGE_CANDIDATES = 16`: when a reroll would add a seventeenth, the oldest
  candidate that is not selected is dropped, and the job sends one `alertToast` (`rerollCandidateDropped`) the
  first time in a job. `MAX_CANDIDATE_BYTES = 256 KiB` of a candidate's JSON: a previous reply over it is not
  kept as a candidate (toast `rerollCandidateTooLarge`), the reroll runs.
  `MAX_SCRIPTSTATE_SNAPSHOT_BYTES = 64 KiB` per snapshot: over it, no checkpoint is written and the job's
  restore does nothing (toast `scriptstateCheckpointSkipped`), so a chat whose variables hold large text loses
  the restore, not the reroll. `MAX_CANDIDATES_BYTES_PER_MESSAGE = 192 KiB` of one message's `candidates` and
  `scriptstateCheckpoint` JSON together: a write that would pass it drops the oldest non-selected candidate
  first, then the next, with the same `rerollCandidateDropped` toast; a previous reply that cannot fit even
  alone counts as over `MAX_CANDIDATE_BYTES` (not kept, `rerollCandidateTooLarge`), so for one long reply the
  per-message total binds before the per-candidate cap. A candidate's copy of `generationInfo` leaves out
  `context` (the `ContextReport`, `shared/database.ts` around line 1351), the only large field of
  `MessageGenerationInfo`, and its copy of `promptInfo` leaves out `promptText` (the whole prompt, around line
  1368); the memory receipt (`generationInfo.memory`) stays with its candidate. A switch therefore brings back
  a reply without its context report and prompt text (the context meter and the prompt view show none for it
  until the next reply). The validator applies the same caps (D3). Inlays: a candidate's text keeps its
  `{{inlay::id}}`, `{{inlayed::id}}` and `{{inlayeddata::id}}` references, so an inlay is reachable from a
  non-selected candidate; the Asset Lifecycle plan's mark phase scans every string of the message JSON,
  `candidates[].data` included, and the upstream export's "inlays are not exported" check (`INLAY_REFERENCE`
  in `exportDatabase.ts`, around line 227) counts only the selected text, since candidates are stripped (D11).

  What the caps do not do: keep the carrier under the transport's limits. A carrier with candidates can exceed
  `MAX_FEED_PATCH_BYTES` (64 KiB; two 40 KiB candidates already do), and `chatFeedChange` measures the whole
  stored row (`server/src/data/chatStore.ts` around lines 1529–1537), so a write that changes the `candidates`
  field (the begin group, the final write, a switch) can be over the cap and cost every loaded observer a read
  of the chat; until the transport's delta forms land, so is every text checkpoint of such a carrier, and the
  owner's job socket resends the carrier whole on each checkpoint (`diffChat`). This plan relies on the
  Incremental Chat Transport plan for the delta forms (its D2, being widened to a per-row top-level field diff
  with `data` as a text delta, so a text-only checkpoint stays small whatever the candidates weigh) and on its
  Slice 4 (the over-cap row manifest and the by-id row read, so an over-cap write costs one row read, not a
  whole-chat read), which this plan makes a hard dependency of its Slice 2 rather than a gated one. Even then
  a write that changes `candidates` is not small: the field travels whole.

  Rejected: no cap (RisuBard grew chats by tens of MB with two full snapshots per message); a cap on total
  bytes per chat (it would make the newest reroll fail for an old chat's sake); a per-message total small
  enough to keep every row under 64 KiB (about 48 KiB: the carrier's own text, metadata and envelope are
  unbounded, so no candidate budget guarantees a fit, and 48 KiB holds few long replies); stripping
  `candidates` from feed rows (a feed row replaces the row the observer holds, so the observer would lose
  them); the draft's rationale that the per-candidate caps keep rows under `MAX_FEED_PATCH_BYTES` (they allow
  about 4.5 MiB per row: the audit).

- **D5. Where `before` is taken, and the per-key restore.** `before` is the chat's `scriptstate` as stored
  when the response's generation starts: for a send, after the input stage (the user message appended, the
  `input` trigger and `editinput` run), before `runSpeaker`'s setup and `start` trigger; for a reroll, the
  carrier's stored `scriptstateCheckpoint.before` stands (the user turn's effects stay, the discarded reply's
  go; the reroll job runs no input stage), and a carrier without a checkpoint (every reply written before
  Slice 1, one whose snapshot D4 skipped, one whose selected candidate had none) takes `before` as the
  `scriptstate` stored at the reroll's start, before the begin group, and has nothing to restore; for a
  continue, the continued message's `before` stands (RisuBard's `selectResponseScriptstateBefore`). `after` is
  the `scriptstate` as stored when the job's last round for that reply has flushed its metadata
  (`flushChatMetadata`), written in `finalize`'s final write (a `setMessage` built from the stored row, for a
  send and a reroll alike) rather than with `writeReplyGenerationInfo`, which skips a reply without
  `generationInfo` (`runner.ts` around lines 1657–1659) and which the emotion view mode never reaches (around
  lines 2044–2046). The restore at a reroll's start is **per key**: for every key of `before ∪ after`, when
  the stored value equals `after`'s (the response set it and nothing changed it since) it becomes `before`'s
  (a `mergeUnset` when `before` lacks it); a key whose stored value differs from `after`'s was edited after
  the response (the tab's `setChatVar`, a Lua button, a `/setvar`) and is kept. `after` is the selected
  candidate's (D2), so the comparison holds after a switch. One `meta` op with `merge` and `mergeUnset` before
  the `start` trigger, in D7's begin group; it is the attempt's first variable write for D13. Rejected:
  RisuBard's wholesale `chat.scriptstate = before` (it erases every variable written between the reply and the
  reroll, which on a server with Lua buttons and a second tab is an ordinary race, not a corner case); taking
  `before` at admission before the input stage (a reroll would then undo the input trigger's writes, which the
  reroll never re-runs).
- **D6. Checkpoints only on the latest reply.** The server owns the rule: the write that appends a new
  reply or a new user message (the input stage's append, a speaker's reply append, a trigger's insert
  through `applyTriggerChat`) unsets `scriptstateCheckpoint` and every `candidates[].scriptstateAfter` of
  every other message in the same group (one `patchMessage` per message that has them, found in the job's
  chat copy). Candidate texts stay (Q1). The client never restores a checkpoint of a message that is not
  the carrier, and the normalizer drops nothing for position (a stale copy on an older message is harmless
  data until the next job write removes it). Rejected: the client dropping older copies as RisuBard's
  `attachScriptstateCheckpoint` does (two tabs would race, and the server is where the append happens).
- **D7. The reroll job, step by step.** At admission the route validates `context.rerollMessageId` as an id
  and accepts it only for `kind: "reroll"` (the kind-restricted model is `userMessageId`; `continueMessageId`
  is accepted for every kind); `requestFingerprint` includes it. The in-place path needs exactly one speaker:
  the tab sends `speakerChaId = carrier.saying`, which the runner already honors for a group owner instead of
  picking several speakers from the group order (`runner.ts` around lines 487–507); a group chat's turn of
  several replies and any multi-reply tail keep today's removal path. The runner, for a reroll with the field,
  inside `runSpeaker` where the generation id exists (around line 935), before setup runs a trigger:

  1. It refreshes the chat and checks that the carrier is the newest reply as D1 defines it and not locked,
     else ends with an `error` terminal of reason `failed` whose message says the reply is no longer the
     newest (the reasons are a closed set).
  2. It writes the begin group, in this order: the `patchMessage` that pushes the carrier's current fields
     `{ data, generationInfo, promptInfo, translation, scriptstateAfter: checkpoint.after }` into `candidates`
     as D4 trims them (a new first entry, or, when the carrier already has candidates, the refresh of
     `candidates[selected]`, D2's rule), adds the new last slot under D4's caps and sets `selected` to it,
     sets `data` to "" (`role` and
     `data` can be set, not unset), and sets the checkpoint's `before` when the carrier had none (D5); a
     `setTranslation` that clears the carrier's translation (the store ignores `translation` on `patchMessage`
     and `setMessage`); D5's restore `meta` op; then `begin` on the carrier. The `begin` comes last because a
     `patchMessage` closes an open generation fence (`shared/chats.ts` around lines 75–78; `chatStore.ts`
     around lines 1936–1943), after which every generation write is `ignored` and `finalize` throws. A `begin`
     on an existing message needs the current revision, which `writeOwn` reads first; the lock checks of
     `writeAsJob` run for the whole group before it applies.
  3. Setup, the memory step, the `start` trigger and assembly run on the history without the carrier (below),
     with `continueSend` false.
  4. Right after assembly, a generation write (a `setMessage` built from the stored row) sets the new
     `generationInfo` and `promptInfo` as the new-message append writes them (`runner.ts` around lines
     1683–1696), so `writeReplyGenerationInfo`'s guard finds them. They cannot ride in the begin group:
     `promptInfo` is assembly's result (around line 1486), and the begin group must precede the `start`
     trigger.
  5. The request streams into the carrier from its empty text as a continue streams into its message; the tail
     runs as today. Every later write to the carrier carries the generation. The non-streaming in-place write
     (around lines 1814–1832, which today constructs a fresh whole row) is rebuilt from the stored row, so it
     keeps `candidates`, `selected`, `scriptstateCheckpoint`, `name`, `disabled` and `isComment`.
  6. `finalize`'s final write, a `setMessage` built from the stored row (around lines 1189–1193), also
     refreshes `candidates[selected]` from the carrier's fields and sets `scriptstateCheckpoint.after` (D5)
     beside the final `generationInfo`; a translation change goes through `setTranslation` in the same group.

  The history without the carrier is a chat view the job scope hands four readers: prompt assembly (around
  line 1373), the memory source (around lines 1322–1339), `runCurrentChatFunction` (around lines 1244–1270),
  and the `start` trigger's chat copy and its diff baseline (`runOnCopy`, diffed in
  `server/src/jobs/chatResult.ts`), with Lua's `liveChat` inside that trigger reading the same view. Its
  message list ends before the carrier. The trigger diff is computed against that same view, so the carrier's
  absence from both sides emits no `remove`. A message a trigger appends during a reroll is appended after the
  carrier in the stored chat: the diff's anchor after the view's last message becomes an anchor after the
  carrier. The generation's own reads and writes (`storedReply`, `throwError`, the checkpoints, `finalize`,
  the write-back of D8) and the tail (`editoutput`, `runCurrentChatFunction` after the reply, the `output`
  trigger, inlays, `chatOutput` listeners) read the stored chat, carrier included, as a send's tail reads its
  new reply. The job's `done` keeps `messageId`; `alternatives` (D9) is no longer sent. A `reroll` job without
  the field runs as a send with empty input, as the code does today; a tab sends the field only as D14 allows.
  Rejected: a new job kind (`reroll` already exists and already means this); the client pushing the old
  content into `candidates` before the create (a create that gets no answer would leave the chat changed,
  which is the uncertain-create class the chat pipeline guide spends a section on); the draft's order `begin`
  then `patchMessage`, and a `patchMessage` refreshing `candidates[selected]` after the stream (each closes
  the generation it needs: the audit); filtering each reader on its own (the trigger diff would still see the
  carrier missing from its copy and remove it).

- **D8. Interrupted reroll.** The write-back is the generation's final write, made where `runSpeaker` makes it
  today: the abort and read-failure branch (`runner.ts` around lines 1730–1736) and the `finally` for a
  generation still open (around lines 2083–2089). It therefore lands while the lock is still held; the final
  write is what releases it (`generationJobs.ts` around lines 1324–1330). One group: `finalize`'s
  `setMessage`, built from the stored row, with `candidates[previous]`'s `data`, `generationInfo` and
  `promptInfo` on the carrier, `selected = previous`, the new slot removed (`candidates` and `selected` unset
  when one entry is left, D3), and `scriptstateCheckpoint.after` set to that candidate's `scriptstateAfter`; a
  `setTranslation` with that candidate's translation; and D13's variable restore as a `meta` op, computed
  after the pending metadata flush (`server/src/jobs/jobScope.ts` around lines 488–518). The job ends with the
  terminal it had; the tab's `restoreRerolledReplies` has nothing to do.

  The ends that write back: an `error` terminal of any reason (`failed`: a request error, a tail failure after
  the reply text was stored, a write conflict; `aborted`; `timeout`); `shutdown` and `maintenance`, which
  abort the job as a stop does, so the write-back runs within the abort grace while the lock is still held,
  and an end after the lock was gone is left as a process death leaves it (the boot sweep of **Later**); a
  `done` that leaves the carrier's text empty (a trigger's stop before the request); and a trigger removing
  the carrier: in a reroll, `applyTriggerChat` converts the diff's removal of the carrier into the no-reply
  outcome before any `remove` op is emitted (the result's other removals still apply), so the candidates
  survive. No write-back is attempted after the abort grace (`JOB_ABORT_GRACE_MS`): the job's writes are
  refused by then.

  Produced text: a reroll that ends `done` with text on the carrier keeps that text as the selected candidate,
  including `inlayErrorResponse`'s appended error, which ends `done.stopped` (`runner.ts` around lines
  1016–1041): the user sees the error where a send shows it, the previous reply one swipe away. A reroll
  aborted mid-stream discards the partial text and writes back, a deliberate change from today, where the
  abort path persists the partial text (around lines 1730–1734) and the bundle history cannot put the old tail
  back while the partial reply holds the anchor; a tail failure after the completed text was stored writes
  back too (today it keeps the text). A server process death mid-reroll, or an abort past the grace, leaves
  the carrier with the partial streamed text selected, the previous candidate one swipe away and the variables
  as the attempt left them (the lock is memory-only and clears at restart); no boot sweep (**Later**).
  Rejected: keeping the partial text as a candidate of its own (a fragment the user stopped is not something
  they asked to keep); a write-back after `runSpeaker` returns (the draft: the final write has released the
  lock by then, so another tab's edit can land first and the write-back overwrites it: the audit);
  re-appending the carrier after a trigger removed it (a period without the carrier that other tabs and memory
  observe as a deletion); the draft's "Stop today discards it too" (the abort path persists the partial text).

- **D9. The extra samples of one request become candidates.** When a request returns several texts (the
  streaming `lastChunk` map, the non-streaming `mrerolls`: upstream's "cached reroll"), the job writes them as
  `candidates` of the reply at its final write, the reply first and selected, the others text-only (no
  `generationInfo`, no `promptInfo`, no `scriptstateAfter`: their triggers never ran, so switching to one
  changes no variable and unsets the checkpoint, D10). `terminal.alternatives`, `installReplyAlternatives`,
  `addRerolls`, and `prereroll.ts` retire (V4 for every consumer, the chat pipeline guide's Sequence events
  bullet included). Slice 1 moves the two tab consumers of the removed field (`serverGeneration.ts` around
  lines 156–157, `serverCommands.ts` around lines 622–623) and `addRerolls` into itself, so `pnpm check`
  passes with the field removed; `Prereroll`, `PreUnreroll` and the file go in Slice 2 with their screen.
  Rejected: keeping `alternatives` on the terminal beside the field (two sources for one list; an older tab
  between a deploy and its reload lacks only the swipe to an extra sample until it reloads).
- **D10. A candidate switch is a server-applied chat op.**
  `selectCandidate { id, index, expect: { selected, count } }` (`shared/chats.ts`) is applied by the store
  from the stored row, never from the tab's copy. It refuses when the stored `selected` or candidate count
  differ from `expect` (it applies nothing; the tab re-reads the chat and retries), and it applies only while
  the carrier is the newest reply (D1, Q1) and not locked. Otherwise, in one transaction, it refreshes the
  slot it leaves from the carrier's current fields (an edit made meanwhile is what switching back brings);
  swaps `data`, `generationInfo`, `promptInfo` and the translation from the stored target candidate (the
  translation only while its `sourceHash` matches the target's `data`, else cleared); sets `selected`; sets
  `scriptstateCheckpoint.after` to the target's `scriptstateAfter`, or unsets the checkpoint when the target
  has none (a D9 sample, a converted swipe); and computes D5's per-key variable patch from the stored `after`
  (the leaving candidate's, D2) to the target's against the stored `scriptstate`, so a variable another tab
  edited between the tab's read and the op is never overwritten. A target without a snapshot, or a carrier
  without a checkpoint, leaves variables as they are. The computation is the pure helper of D3, so the tab's
  mirror shows the same result optimistically. In the tab, `switchCandidate(ref, id, index)` in a new
  `src/ts/process/rerollCandidates.ts` refuses while the chat is busy or the carrier locked (`assertUnlocked`)
  and queues this one op. It runs no trigger, hook, or CBS, as a text edit does not; the display transform
  re-renders from the new revision. Structured memory and HypaV3 see it as an edit, as before: the store
  counts the `data` change as a rewrite of the message, as it does a `patchMessage` of `data`; for structured
  memory it is an edit of a message no event cites, unless the user pressed "record now" on it, in which case
  the edit marks the event `rerecord` as any edit does (correct: the cited text changed). HypaV3 and
  SupaMemory read the carrier's `data` at the next send, which is the commit boundary: the candidate selected
  when the user sends the next message is the one memory ever reads; a discarded candidate is never memory
  input, since a reroll job's memory step reads the history without the carrier (D7) and the writer's ceiling
  keeps the newest reply out. Rejected: the draft's switch as by-id ops from the tab (a `patchMessage` of
  `data`, `generationInfo`, `candidates` and `selected`, `setMessageTranslation`, and `mergeChatMeta` of a
  per-key patch computed in the tab): a `patchMessage` sets whole fields also on a stale revision, so a tab
  that had not seen another tab's finished reroll wrote its old `candidates` over the newer list, and its
  variable decision, made from its copy, overwrote a variable another tab set meanwhile (the audit and its
  cross-check); the draft's reasons for refusing the op (the module's ops already give atomicity and apply on
  a stale revision; a route would need its own lock check and feed entry) do not hold, since applying on a
  stale revision is the failure and an op inside the chat write path gets the lock check and the feed entry
  from it; a precondition on the candidates alone (it misses a variable-only change); a whole-chat revision
  precondition on the tab's group (any write to the chat, a memory task's included, would refuse the switch);
  a switch on an older message (the draft's D10 sentence allowing one; Q1 and **Out of scope** exclude it).
- **D11. Export and import.** The upstream export strips `candidates`, `selected`, and
  `scriptstateCheckpoint` from every message and reports one excluded entry `message-candidates` with the
  count of messages that had candidates (the convention of `message-translations`: upstream's `Message`
  lacks the fields, and the selected text is already `data`). The upstream import converts PocketRisu's
  and RisuBard's `swipes`/`swipeId` into `candidates` (text only, `selected` from `swipeId`, holes and
  non-strings skipped, a `data` that matches no swipe appended as RisuNest's converter does) and RisuBard's
  `scriptstateCheckpoint` and `scriptstateSwipeCheckpoints` into the checkpoint and the candidates'
  `scriptstateAfter` of the chat's newest reply only (older messages' copies dropped: D6), reported as
  `converted` `message-swipes`. RisuNest's `responseVariants` is not converted (**Later**). The one-way
  compatibility rule of the persistence guide covers both directions. Rejected: emitting `swipes`/`swipeId`
  in the `.bin` for PocketRisu-family readers (upstream would carry dead fields, against the export's rule
  of stripping what upstream's types lack; Q2 keeps it as an option).
- **D12. Multi-tab.** Candidates are chat data: a reroll's writes reach other tabs through the chat patch feed
  and the job's `chatPatch` as any message write does (at the cost D4 states), and a switch reaches them as
  the op's write. While a reroll runs, every tab sees the carrier locked (`streaming` entries) with the new
  text streaming in, its arrows disabled (`locked` in `Chat.svelte`, `assertUnlocked` in the module), and the
  previous reply already in `candidates`. Two tabs that switch at once: the second op's `expect` no longer
  matches the stored row, it is refused, and that tab re-reads and retries against the first switch's result.
  Under the Job Handoff plan the three toasts of D4 reach the job's owner only, so a phone that handed its
  reroll to a worker never sees `rerollCandidateDropped`; accepted, since the dropped candidate is the oldest
  unselected one. Rejected: a per-tab selected index (the selection is what memory and the prompt read, so it
  must be the chat's); the draft's last-write-wins per field for two switches (see D10).
- **D13. Variable rollback by attempt provenance.** During a reroll the job records, per variable key it
  writes, the stored value before the attempt's first write of that key (absence included) and the attempt's
  last write (a removal included). The recorded writes: D5's restore `meta` op in the begin group, a trigger's
  merges through `applyTriggerChat`, Lua's `setChatVar` through the pending metadata flush
  (`server/src/jobs/jobScope.ts` around lines 488–518), and `/setvar` (`server/src/prompt/commands.ts` line
  286, each key its whole-map write changes). On an end without a reply (D8) the restore is computed against
  the stored `scriptstate` in the write-back group, after the pending flush: a key whose stored value still
  equals the attempt's last write gets its pre-attempt value back (a `mergeUnset` when it had none); a key
  another writer changed meanwhile is kept, as is a write that reached the chat from the tab (a plugin
  callback's `setChatVar`). Since the restore op is the attempt's first write, the pre-attempt values are the
  ones stored before the reroll began, which equal the previous candidate's `after` wherever nothing else
  wrote. The candidate's `scriptstateAfter` is not consulted. Rejected: D5's rule in the other direction, from
  `before` to the previous candidate's `scriptstateAfter` (the draft: with `before` x=0 and the old reply's
  x=1, an attempt that sets x=2 and fails compares 2 with 0, keeps 2 as if another writer set it, and a key
  the attempt introduced lies outside `before ∪ after` and stays: the cross-check); the whole map back to the
  previous `after` (it erases another tab's edits, as D5's rejection of RisuBard's wholesale restore says); a
  snapshot of all variables at the failure (it cannot tell the attempt's writes from another writer's).
- **D14. Mixed tab and server versions.** An older server drops `rerollMessageId`:
  `server/src/routes/generations.ts` (around lines 202–218) copies only the context fields it knows, so a
  newer tab's reroll would run as a send with empty input and append a second reply after the carrier. The tab
  therefore sends `rerollMessageId` only when the server advertises the capability, and otherwise runs today's
  removal path. The signal is a field on the live-update socket's `hello` frame (`rerollInPlace: true`,
  `shared/events.ts` around lines 42–48), the cheapest existing one that works: `GET /api/generations/current`
  answers 404 when no job runs, so it has no field to read before the first reroll, and the create's answer
  arrives after an older server has admitted the job without the field. A tab connects the feed at boot and
  again after every server restart, so a downgraded server's `hello` turns the path off. A tab not yet
  reloaded after the deploy still runs today's path: its reroll removes the carrier and with it the carrier's
  candidates (D9's samples from Slice 1, every reroll's from Slice 2), which then live only in that tab's
  bundle history until it reloads; accepted, since the window ends at the reload. Rejected: refusing on the
  server a removal of a carrier with candidates (an older tab's reroll would fail with nothing the user can do
  short of a reload); the draft's claim that nothing a tab sees differs after Slice 1.

## Open questions

All four were answered on 2026-11-03 with the recommended option; they are kept here as the record of why.

- **Q1. Older messages' candidates.** Recommended: keep them as data, switchable only while the message is
  the newest reply (bounded by D4's 16 per message), so a user can look back at what else was offered.
  Alternative: at the commit boundary (D6's write) prune every older message to its selected candidate,
  which bounds chat growth tighter and matches "rerolls do not become memory" in spirit, at the cost of
  history the user may want.
- **Q2. A PocketRisu-compatible export.** Recommended: no (D11 strips and reports). Alternative: an export
  option that writes `swipes`/`swipeId` from the candidates for PocketRisu, RisuBard, and RisuNest readers;
  upstream RisuAI would carry the fields unused.
- **Q3. The full ring.** Recommended: D4 drops the oldest non-selected candidate with one toast per job.
  Alternative: refuse the reroll with an error until the user deletes a candidate, which needs the
  single-candidate delete control this plan leaves for **Later**.
- **Q4. The counter.** Recommended: show `selected + 1 / count` between the arrows whenever a reply has two
  or more candidates, under no setting. Alternative: gate it like the greeting counter
  (`showFirstMessagePages`), one more Display toggle.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Files shared with
the other active plans: Slice 1 edits `shared/jobs.ts`, `server/src/routes/generations.ts`,
`server/src/routes/events.ts` and `shared/events.ts`, and the `followOnce` callback that `followJobToEnd` runs
in `src/ts/process/serverCommands.ts` (D9's consumer moved into it), so it does not run in parallel with Job
Handoff Slice 1 (`shared/jobs.ts`, `routes/generations.ts`) or Slice 2 (`followJobToEnd`), nor with
Incremental Chat Transport Slice 2 (`shared/jobs.ts`) or Slice 3 (`routes/events.ts`; that plan says so too).
Slice 2 edits `src/ts/storage/chatStore.svelte.ts`, `src/ts/network/eventFeed.ts`, `DefaultChatScreen.svelte`
and `Chats.svelte`, which Transport Slices 0–4, Job Handoff Slices 2 and 3 and Render Work Budget Slice 4 also
edit; it runs after Transport Slice 4 (its dependency, D4) and not in parallel with the others.

### Slice 1: the schema, the normalizer, and the reroll job (D1–D9, D13, D14 server side; needs nothing)

Files: `shared/database.ts` (the types), new `shared/rerollCandidates.ts` (helpers and caps),
`server/src/data/chats.ts` (`normalizeMessage`'s shape rules: refuse on op writes, drop on import and
read-back), `server/src/data/chatStore.ts` (the refusal on op writes), `shared/jobs.ts`
(`GenerationContext.rerollMessageId`, `alternatives` removed from the done event and the sequence event),
`server/src/routes/generations.ts` (validation, the kind restriction, the context copy),
`server/src/jobs/generationJobs.ts` (`requestFingerprint`, `keptTerminal` without `alternatives`),
`server/src/prompt/runner.ts` (the carrier check, the begin group inside `runSpeaker`, the post-assembly
`generationInfo`/`promptInfo` write, the stored-row non-streaming write, the `before` and `after` snapshots in
`finalize`, the final write with `candidates`, the write-back as the final write, the samples as candidates,
the toasts), `server/src/jobs/jobScope.ts` (the chat view without the carrier, the attempt's variable record,
the snapshot read beside `flushChatMetadata`), `server/src/jobs/runSetup.ts` (`runOnCopy` on the view),
`server/src/lua/bindings.ts` (`liveChat` on the view), `server/src/jobs/chatResult.ts` (D6's unset in the
group of an insert, the anchor after the carrier, the carrier removal turned into the no-reply outcome, the
variable record), `server/src/prompt/commands.ts` (`/setvar` into the record), `shared/events.ts` and
`server/src/routes/events.ts` (`rerollInPlace` on `hello`), `src/ts/process/serverGeneration.ts`
(`installReplyAlternatives` removed), `src/ts/process/serverCommands.ts` (the sequence event without
`alternatives`), `src/ts/process/prereroll.ts` (`addRerolls` removed), `src/lang/en.ts` and `ko.ts` (the three
toasts: tab strings for server notices live there), the server generation guide (Generation admission, Prompt
job execution, a new "Reroll in place" flow, Invariants), the persistence guide (Messages), the scripts and
triggers guide (State: what a reroll does to variables).

- Tests (`server/src/tests/promptRunner.test.ts`, `generationJobs.test.ts`, `chats.test.ts` for the
  normalizer, `chatStore.test.ts` for the op-write refusal, `chatResult.test.ts`, `memoryJobs.test.ts`,
  `events.test.ts`, with the mock provider those files use):
  - the in-place reroll: a reroll with `rerollMessageId` keeps the carrier's id, pushes the previous `data`,
    `generationInfo` without `context`, `promptInfo` without `promptText`, translation and `after` into
    `candidates`, streams into the carrier, and ends with `candidates[selected]` equal to the new reply and
    the new `generationInfo` and `promptInfo` on the carrier; every checkpoint and the final write of that
    reroll are `applied`, none `ignored` (the fence the begin group must not close); a non-streaming reroll
    keeps `candidates`, `selected`, `scriptstateCheckpoint`, `name`, `disabled` and `isComment` (the whole-row
    rewrite); a reroll of a group owner's carrier runs only the carrier's speaker;
  - the view: the prompt and the memory step of that job hold no carrier text; a `start` trigger that appends
    a message during a reroll removes nothing and its message lands after the carrier;
  - variables: a variable the reply set is back to `before` when the `start` trigger reads it, and a variable
    set after the reply by a `meta` merge is kept (D5); a carrier without a checkpoint takes `before` at the
    reroll's start; `after` is written for a reply without `generationInfo`;
  - the write-back: a reroll aborted mid-stream leaves the previous candidate selected with its text,
    `generationInfo`, `promptInfo`, translation and variables, the partial text gone, and `candidates` unset
    when one entry is left; the write-back is the generation's final write: an edit of the carrier by another
    client while the job unwinds is refused as generating, and the carrier ends with the previous candidate
    (the lock released before the write-back); a request error, a timeout and a `maintenance` abort write back
    the same way; an `output` trigger that removes the carrier leaves it with every candidate and the previous
    one selected (the trigger removal); with `inlayErrorResponse` the error text stays the selected candidate
    and the previous reply is kept; a failed attempt whose `start` trigger set x from the restored 0 to 2
    leaves x at the previous reply's 1, a key the attempt introduced is removed, and a key another writer
    changed during the attempt is kept (the failed attempt's own variable write);
  - the rest: a reroll whose carrier is no longer the newest reply ends with an `error` of reason `failed`; a
    send's reply append unsets the older reply's checkpoint and its candidates' `scriptstateAfter` and keeps
    their texts (D6); a request with three samples writes three candidates with the reply selected and no
    `alternatives` on `done` (D9); the seventeenth candidate drops the oldest non-selected one with one toast,
    a write over the per-message total drops the oldest non-selected ones, an oversized previous reply is not
    kept, and an oversized snapshot writes no checkpoint (D4); `normalizeMessage` on an imported chat drops a
    malformed `candidates`, an out-of-range `selected`, a one-entry `candidates` or a non-map snapshot and
    keeps the message, and keeps a single reply's checkpoint; a `patchMessage` or `setMessage` with a
    malformed or over-cap `candidates` is refused with a validation error and stores nothing; the route
    refuses `rerollMessageId` on a kind other than `reroll`; the fingerprint differs by `rerollMessageId`; a
    `reroll` job without the field runs as a send with empty input; the `hello` frame carries `rerollInPlace`.

### Slice 2: the switch op and the tab's candidate controls (D10, D12, D14; needs 1 and Transport Slice 4)

Files: `shared/chats.ts` (the `selectCandidate` op), `server/src/data/chatStore.ts` (applying it from the
stored row, the `expect` refusal, the newest-reply and lock checks, the variable patch against the stored
`scriptstate`, the rewrite count for memory), `shared/rerollCandidates.ts` (the selection helper),
`src/ts/storage/chatStore.svelte.ts` (queueing the op, the optimistic apply, `assertUnlocked`),
`src/ts/network/eventFeed.ts` (the `rerollInPlace` capability from `hello`), new
`src/ts/process/rerollCandidates.ts` (`switchCandidate`, the carrier check, the busy and lock refusals, the
re-read and retry on a refusal), `src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`: a next candidate,
else a `reroll` job with `rerollMessageId` and `speakerChaId` when the tail is one reply and the server
advertises the capability, else today's removal path; `unReroll`: the previous candidate, else the bundle
history), `src/lib/ChatScreens/Chat.svelte` (the counter of Q4 in the `rerolls` snippet, `candidateCount` and
`candidateIndex` props), `src/lib/ChatScreens/Chats.svelte` (the two props per row),
`src/ts/process/serverGeneration.ts` (the `reroll` kind in the kind pick, `rerollMessageId` and `speakerChaId`
through `ServerSendArg`), `src/ts/process/prereroll.ts` deleted with `Prereroll` and `PreUnreroll` (V4),
`src/lang/en.ts` and `ko.ts`, the chat pipeline guide (Reroll modules, Reroll, Sequence events, Known Hazards:
the in-memory-only hazard narrows to multi-reply tails), the chat store guide (the `selectCandidate` op).

- Tests (`server/src/tests/chatStore.test.ts`, `server/src/tests/promptRunner.test.ts`,
  `src/ts/process/rerollCandidates.test.ts`, `src/ts/process/serverGeneration.test.ts`,
  `src/ts/network/eventFeed.test.ts`, `src/lib/ChatScreens/Chat.controls.test.ts`,
  `src/ts/process/rerollHistory.test.ts` unchanged):
  - the op: `selectCandidate` swaps `data`, `generationInfo`, `promptInfo` and a fresh translation from the
    stored candidates, clears a stale one, and refreshes the slot it leaves from an edited text; it sets
    `scriptstateCheckpoint.after` to the target's `scriptstateAfter` and unsets the checkpoint for a text-only
    target, and a reroll after a switch to an earlier candidate restores `before` for a key that candidate set
    (the switch not updating `after`); an op whose `expect` names two candidates while the stored row has
    three (another tab's reroll) is refused and the stored row is unchanged (the stale switch); a variable
    another tab set after the switching tab's read keeps its value while the other keys move to the target's
    (the switch after a newer variable edit); the op is refused on a message that is not the newest reply and
    on a locked carrier;
  - the tab: a switch queues exactly one `selectCandidate` with `expect` from the mirror; a switch on a locked
    carrier or a busy chat throws and queues nothing; a refused switch re-reads and retries once against the
    new state; `reroll` with `selected` at the last candidate creates a `reroll` job with `rerollMessageId`
    and `speakerChaId` for a one-reply tail when `hello` advertised `rerollInPlace`, and runs the removal path
    for a two-reply tail or without the capability; the counter shows `2/3` and hides for one candidate; a
    mirror with `candidates` from a read (another tab's reroll) shows the arrows active.

### Slice 3: the memory commit boundary and the export mapping (D10, D11; needs 1)

Files: `server/src/prompt/memory/structured/window.ts` (the comment: candidates are stored but never
messages of their own; no behavior change expected, the test proves it),
`server/src/data/upstream/exportDatabase.ts`
(the strip and the `message-candidates` entry), `server/src/data/upstream/importCharacters.ts` (the
`swipes`/`swipeId` and RisuBard checkpoint conversion, newest reply only), `shared/upstreamExportReport.ts`
and the import report's codes, the backup and sync hub guide (Upstream database export, Upstream library
import), the structured memory writer guide (The writer's windows: a reroll's candidates and the ceiling),
the memory guide (Memory writes: the commit boundary).

- Tests (`server/src/tests/memoryJobs.test.ts`, the structured writer tests beside `orderedWriter.test.ts`,
  `upstreamExport.test.ts`, `upstreamImportCharacters.test.ts`, `upstreamImportReport.test.ts`): a reroll
  job's writer windows and HypaV3 input hold no candidate text and no carrier text; after the next send,
  the window holds the selected candidate's text and none of the others; a "record now" press on a reply
  with candidates records the selected text, and a later switch marks the event `rerecord`; the export of
  a chat with candidates writes the selected text as `data`, no candidate field, and the report entry
  with the count; the import of a PocketRisu `.bin` with `swipes` and `swipeId` gives `candidates` with
  the right `selected`, of a RisuBard `.bin` gives the newest reply's checkpoint and per-candidate `after`
  and drops older copies, and of a swipe list with holes skips them; a round trip export → import keeps
  the selected text and loses the candidates with the report saying so.

### Slice 4: the browser check and the final guide pass (needs 2 and 3)

Files: new `e2e/rerollCandidates.spec.ts` (the mock provider pattern of `perChatSends.spec.ts`, listed in
`util/agentE2e.mjs`'s selection rules as that file documents), the test harness guide (the spec in its
list), a final pass over every guide this plan touched (the chat pipeline guide's Files list without
`prereroll.ts`).

- Spec cases, one dev stack: a send, two rerolls, a reload shows `3/3` and ← twice shows the first reply; a
  second browser context sees the same count without a reload, and its switch after the first context's switch
  lands on the stored state; a reroll stopped mid-stream leaves the previous reply selected and no partial
  text; a trigger that sets a variable on each reply shows the first reply's value after swiping back (read
  through `{{getvar}}` in a comment message); the removal path still runs for a group chat's turn of two
  replies.
- Device checks (the phone's swipe on the owner's server) go to the user as a checklist and are reported
  as not run (V5).

## Recommended order

1 → 2 → 3 → 4, with Slice 2 after Incremental Chat Transport Slice 4 (D4). After Slice 1 no tab sends
`rerollMessageId` yet, so every reroll runs today's removal path, and the swipe to an extra sample is gone
until Slice 2 (the samples are stored as `candidates`, which no tab shows yet); a tab that removes a carrier
with samples loses them as it loses them today. After Slice 2's deploy a tab not yet reloaded still removes
the carrier on its reroll, and the carrier's candidates with it (D14). 1 and 2 together give the persisted
candidates and the variable restore the owner asked for; 3 settles the export and the memory proofs; 4 is the
browser proof.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every removed export (`addRerolls`,
  `Prereroll`, `PreUnreroll`, `installReplyAlternatives`, `terminal.alternatives`) and the deleted
  `prereroll.ts`.
- Focused: `pnpm --silent test:agent` with `server/src/tests/promptRunner.test.ts`, `generationJobs.test.ts`,
  `chats.test.ts`, `chatStore.test.ts`, `chatResult.test.ts`, `memoryJobs.test.ts` and `events.test.ts` (all
  under `server/src/tests/`) for the server; with `src/ts/process/rerollCandidates.test.ts`,
  `src/ts/process/serverGeneration.test.ts`, `src/ts/process/serverCommands.test.ts`,
  `src/ts/network/eventFeed.test.ts` and `src/lib/ChatScreens/Chat.controls.test.ts` for the tab; with
  `server/src/tests/upstreamExport.test.ts` and `server/src/tests/upstreamImportCharacters.test.ts` for the
  export (file names as the slices create them).
- `e2e`: `e2e/perChatSends.spec.ts` after Slice 2 (the send path's argument changes) and
  `e2e/rerollCandidates.spec.ts` after Slice 4, one e2e run at a time.
- Not covered by any gate: the phone swipe on the owner's server, and a server process death mid-reroll or an
  abort past the grace (D8's partial text), which only a manual kill shows.

## Out of scope

- Candidates for a tail of several replies: group turns of several speakers and resend rounds keep the removal
  path and the in-memory bundle history.
- Switching candidates on a message that is not the newest reply (the texts are kept, Q1; `selectCandidate`
  refuses it).
- Deleting one candidate from the UI (PocketRisu's `deleteSwipe`), and the confirmation settings around it.
- Converting RisuNest's `responseVariants` on import.
- A per-message checkpoint on every message (the shape RisuBard fixed in 0.9.69).
- The asset mark phase for candidates' inlays: the Asset Lifecycle plan owns the scanner, which covers
  `candidates[].data` by construction and adds a test for it; this plan names the field.

## Later

- A single-candidate delete control and the "refuse when full" alternative of Q3 (Q3 reversed).
- A boot sweep that writes back the previous candidate of a carrier whose generation never ended (D8's
  process-death case, an abort past the grace, a `shutdown` or `maintenance` end after the lock was gone), and
  puts back the attempt's variables if the record of D13 is persisted for it, if it shows up in practice.
- Bundle candidates for multi-reply tails, if group chats need swipes: the carrier would be the turn's
  last reply and a candidate a list of messages, which is RisuNest's shape and its id problem.
- PocketRisu-compatible `swipes` in the `.bin` export (Q2 reversed).
- Pruning older messages' candidates at the commit boundary (Q1 reversed).
