# Reroll Candidates Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the [design
audit](../audit/plan-design-audit-2026-11-04.md) and again after its adversarial challenge. Landed: 1 (`30bec41a4`).
Decisions D1–D14 are recommendations for the owner; the **Open questions** Q1–Q4 were answered by the owner on
2026-11-03 (the recommended option each time). The first revision corrected D2–D5 and D7–D10 (D10 took the
server op its draft rejected) and added D13 and D14; the second corrects D2–D8, D10 and D13 (a trigger's
append during a reroll, the attempt ledger, candidate ids and the list revision, the kept baseline, the
transport's metadata rows, the error's target), narrows D9 and D14, and completes the slice inventories. On
2026-11-05 the dependency on Incremental Chat Transport Slice 4 was restated as a merge-time one (D4), with the
merge's integration checks under **Verification**. The same day the owner settled the gaps Slice 1's challenge found (D3's read paths, D4's
toast codes, D6 at the store's append boundary, CBS in D7's view, D8's rounds, D13's transaction), and Slice 1's
Files grew to match. Code anchors re-checked at `1550ebdd3`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 choice of this plan as the next one after the asset lifecycle plan;
[PocketRisu/RisuBard picks](../research/pocketrisu-risubard-picks.md) §1.1 item 1 (per-reroll scriptstate
checkpoints, implemented on the server since rerolls are server jobs, kept on the latest message only) and
§2.1 "Rerolls do not become memory (commit boundary)"; [RisuNest ideas](../research/risunest-ideas.md) §1 item
9 (persisted reroll candidates and interrupted-reroll recovery) and the [research
README](../research/README.md)'s RisuNest open item 2 (whether the persisted field should match PocketRisu's
shape for interchange, decided in D2); the [PocketRisu survey](../research/pocketrisu-survey.md) ("Persistent
swipe history and swipe UI": `swipes[]` and `swipeId` on the message, the `01e732dc` data-loss fix) and the
[RisuBard survey](../research/risubard-survey.md) §2.3.2 (`scriptstateCheckpoint{before,after}` plus one
checkpoint per swipe, latest message only, the tens-of-MB growth fixed in 0.9.69) and its concept 7 (a reply
becomes memory only when the user continues past it); the reference implementation in the sibling checkout
`/home/codex/RisuBard/src/ts/chatScriptstateCheckpoint.ts` (`attachScriptstateCheckpoint` dropping older
messages' copies, `restoreScriptstateBeforeReroll`, `restoreSelectedSwipeScriptstate`,
`scriptstateSwipeCheckpoints` with `null` for a swipe without one) and its callers in
`/home/codex/RisuBard/src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`, `unReroll`, `nextSwipe`,
`deleteSwipe`; the failure path puts the original scriptstate back), read only; the [chat pipeline
guide](../structure/chat-pipeline.md) (Reroll modules, Reroll, Request id retention), the [server generation
guide](../structure/server-generation.md) (Generation admission, Prompt job execution, Own chat changes, Job
chat and barriers), the [scripts and triggers guide](../structure/scripts-triggers.md) (Flows, State:
variables are `chat.scriptstate['$'+key]`; Limitations: the shared pending metadata write), the [persistence
guide](../structure/persistence.md) (Shared shapes, Chat fields, Messages, the compatibility rule), the [chat
store guide](../structure/chat-store.md) (By-id ops, Map merges, Job hydration), the [structured memory writer
guide](../structure/structured-memory/writer.md) (The writer's windows), the [memory
guide](../structure/memory.md) (Selection, Memory writes), and the [backup and sync hub
guide](../structure/backup-sync-hub.md) (Upstream database export) at `8f0db0fb7`; the 2026-11-04 [design
audit](../audit/plan-design-audit-2026-11-04.md) (its Reroll Candidates section RC1–RC7 and the cross-plan
items X1, X5, X6, X7), its [per-plan report](../audit/plan-design-audit-2026-11-04/reroll-candidates.md) (24
findings with file and line evidence), and an independent cross-check of that audit (the failed attempt's own
variable writes and the stale switch's variable decision, both answered by D10 and D13); and the adversarial
challenge of that revision (2026-11-04: failures F1–F7 with file and line evidence, its additional contract
checks and its "noted, not recommended" bucket; the report is kept outside the repository).

Owning guides when sliced: [persistence](../structure/persistence.md) (the message fields and their
normalization), [server generation](../structure/server-generation.md) (the reroll job's in-place
generation, the snapshots, the write-back), [chat pipeline](../structure/chat-pipeline.md) (the candidate
controls, what the per-chat bundle history still covers), [scripts and
triggers](../structure/scripts-triggers.md)
(what a reroll does to variables), [chat store](../structure/chat-store.md) (the `selectCandidate` op),
[structured memory writer](../structure/structured-memory/writer.md) and [memory](../structure/memory.md)
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
text-only checkpoint small, and its Slice 4 (the over-cap row manifest and the by-id row read, with that
plan's D6 amended so the read also carries the chat's changed metadata fields) is a merge-time dependency of
this plan's Slice 2 (D4): no code here calls what it adds, so the two may be built on separate branches, but
Slice 2 reaches `dev` only in the same merge or after it; its Slice 2 is no dependency at all. The [Job Handoff plan](job-handoff.md) keys nothing this plan needs
by owner (the reroll lock is the job's, so a takeover does not touch it), but its notices reach the job's
owner only (D12); the slices that share files are listed under **Slices**.

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

The baseline is `1550ebdd3` on `dev` (2026-11-04; no source changed since the draft's `8f0db0fb7`). This plan
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
  `throwError` appends the error to the last stored message when it is a reply (with the generation when the
  job owns it, else as a manual write when it is unlocked), else appends a new error reply at the end, and the
  send ends `done.stopped` (around lines 1016–1058); it picks the last stored message (around line 1024), not
  the generation's. Error terminals carry a reason from the closed set `GENERATION_ERROR_REASONS`
  (`shared/jobs.ts` around line 175: `failed`, `aborted`, `shutdown`, `maintenance`, `timeout`); `shutdown`
  and `maintenance` abort a running job as a stop does.
- **What reads the chat in a speaker run.** Prompt assembly's `chat` (`runner.ts` around line 1373), which
  assembly reads again after the `start` trigger and builds the prompt from (`host.chat()`,
  `server/src/prompt/assemble.ts` around line 1691), the memory step's `readSource` (around lines 1322–1339),
  `runCurrentChatFunction` (around lines 1244–1270), and the triggers' `runOnCopy`
  (`server/src/jobs/runSetup.ts` around lines 352–358), which runs a trigger on a whole-chat copy and diffs
  the result against that copy as its baseline (`applyTriggerChat`); a message the diff finds new is appended
  after its predecessor in the result (`chatResult.ts` around lines 167–178). Lua's `liveChat`
  (`server/src/lua/bindings.ts` around line 354) reads the scope's chat. All of them read the whole chat.
- **How variables are written in a job.** Triggers write `chat.scriptstate` on the job's copy
  (`server/src/prompt/triggers.ts` around line 566) and `applyTriggerChat` merges changed entries by key
  against the baseline; Lua's `setChatVar` queues one entry through the job's pending metadata write
  (`server/src/jobs/jobScope.ts` `createChatMetadata`, the flush around lines 488–518: a `meta` op with
  `merge: { scriptstate }`); `/setvar` and `/addvar` set the whole map (`server/src/prompt/commands.ts` around
  lines 282–295). Each of these job writes reaches the store with the job's token (`writeAsJob`,
  `server/src/jobs/generationJobs.ts` around line 1274); the store applies a `meta` op's `set`, `unset`,
  `merge` and `mergeUnset`, and a `replace`'s metadata, in `applyGroup` (`server/src/data/chatStore.ts` around
  lines 1815–1884). The tab's `setChatVar` (`src/ts/parser/chatVar.svelte.ts`) merges one entry with
  `mergeChatMeta`. `CHAT_META_MERGE_KEYS` (`shared/chats.ts`) lists `scriptstate`, so `merge`/`mergeUnset` act
  per entry on the stored map, with no expected value. The display transform keys its cache by a metadata
  digest that includes `scriptstate` (`server/src/prompt/transform.ts`), so a restore re-renders.
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
  the readers). `patchMessage` and `setMessage` both run `normalizeMessage`; the store's chat reads parse each
  stored row's JSON directly (`readChat` and `readCollection`, `chatStore.ts` around lines 2616–2638). The
  `patchMessage` op sets or unsets named fields of the stored row, also on a stale revision (`shared/chats.ts`
  line 82; the client's `patchMessage`, `src/ts/storage/chatStore.svelte.ts` line 3317). Rows travel whole:
  the job's `chatPatch` carries every generated row on each checkpoint (`diffChat`, `generationJobs.ts` around
  lines 579–608), and the live-update feed's `chatFeedChange` (`chatStore.ts` around lines 1487–1537) measures
  the whole stored row and, over `MAX_FEED_PATCH_BYTES` (64 KiB), carries nothing, so every loaded observer
  reads the chat.
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
  candidatesRevision?: number; // set by the store, bumped by every change of the list; absent means 0
  scriptstateCheckpoint?: { before: ScriptstateSnapshot; after?: ScriptstateSnapshot }; // latest reply only
  type MessageCandidate = {
      id: string; // short random string set when the candidate is created, unique in the list
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
  and older tabs read the selected reply without knowing about candidates; `scriptstateCheckpoint.before` is
  the turn's baseline, kept whichever candidate is selected (only D6 removes it); and
  `scriptstateCheckpoint.after` is the selected candidate's `scriptstateAfter`, absent when the selected
  candidate has none, so the next reroll's restore (D5) compares against the reply on screen.
  `candidates[selected]` is a copy of those fields, refreshed by the reroll's begin group and when the user
  switches away (an edit made meanwhile is what switching back brings, as `prereroll.ts` does today). A
  candidate's `id` never changes and is what a switch names (D10). `candidatesRevision` is the store's, not
  the writer's: every applied write that changes a message's stored `candidates` or `selected` (the begin
  group, the final write, the write-back, a switch, D6's cleanup, an older tab's whole-row write) stores the
  previous value plus one, whatever the op carries, and an unset of `candidates` keeps the counter, so a list
  rebuilt later never repeats a revision. Rejected: PocketRisu's `swipes: string[]` plus `swipeId` (text only:
  no `generationInfo`, no translation, no variable state, and the research README's interchange question is
  answered by D11 instead); RisuNest's `responseVariants` (whole message snapshots, see D1); a candidate
  without `promptInfo` (the draft: every candidate showed the first reply's prompt, and a switch kept a stale
  one: the audit); the first revision's checkpoint with both halves required and unset when a text-only
  candidate is selected (no field then held `before`, so after A → text-only B → reload → A a reroll took the
  current state, A's effect included, as its baseline: the challenge); addressing a candidate by position (see
  D10). Field names and the checkpoint shape follow RisuBard's `scriptstateCheckpoint { before, after }` so a
  RisuBard backup's checkpoint converts one to one (D11).

- **D3. The shared type, the shape rules, the ownership.** `shared/database.ts` gains the types above;
  `shared/rerollCandidates.ts` (pure, T2 rules) holds the helpers both runtimes use: `candidateOf` (the copy
  D4 trims), `withCandidate` (the refresh of `candidates[selected]`), `scriptstateRestorePatch` (D5), the
  candidate selection of D10, and the caps. `normalizeMessage` checks each field on its own shape:
  `candidates` an array of at least two plain objects with a non-empty string `id` (at most 32 characters,
  unique in the list) and string `data` and an optional valid `generationInfo`, `promptInfo`, `translation`
  and snapshot, within D4's caps; `selected` an integer in range, only beside `candidates`;
  `candidatesRevision` a non-negative integer; `scriptstateCheckpoint` a plain object with a required `before`
  snapshot and an optional `after` snapshot, validated independently of `candidates`, so a single reply keeps
  its checkpoint. `candidates` is absent when fewer than two remain: a write that leaves one entry (D8's
  removal of the new slot) unsets `candidates` and `selected`. On op writes (`patchMessage`, `setMessage`,
  `selectCandidate`, and the other ops that carry a message) a malformed or over-cap field is refused with a
  `ResourceValidationError`, as the chat field validators of `server/src/data/chats.ts` refuse theirs; the
  silent drop (the field gone from the copy, the message kept, as an invalid translation is dropped) applies
  only to an imported chat (`convertMessages`) and to a stored row read back, so an imported or old chat keeps
  its messages. The store's ordinary reads parse stored rows without the normalizer (`readChat` and
  `readCollection`, `server/src/data/chatStore.ts` around lines 2616–2638), so the tolerant validation is
  wired into those read paths (and every other one that hands out stored rows), not only into
  `normalizeMessage`: the 2026-11-05 Slice 1 challenge listed them, among them the feed and own-write row
  changes, the job scope's incremental adoption, the owner socket's baseline, and the named checkpoint's composed
  rows (`server/src/data/checkpointStore.ts`), which a load replaces strictly, so an old page with a malformed
  field would otherwise refuse to load. The caps are enforced by the job's writes (which trim before writing, D4) and by the
  validator alike. Messages are chat data, not a section, so `shared/sections.ts` is unchanged (persistence
  D2: stored as sent, defaults at the readers), and chats with no field need no migration: absent means one
  candidate, no checkpoint. `CHECKPOINT_CHAT_FIELDS` is unchanged too: named checkpoints capture message rows
  whole, so candidates travel with them. Rejected: a separate `messageCandidates` table (every reader of a
  message would need a join; D4 bounds the fields, though not below the feed's cap); dropping a malformed
  field on every write, as the draft did (`patchMessage` and `setMessage` run the normalizer, so a tab's bug
  in a switch would silently delete every candidate and the checkpoint: the audit); dropping the checkpoint
  with an invalid or absent `candidates` (the draft's wording: it took the checkpoint of every single reply);
  a tolerant branch in `normalizeMessage` alone (the store's reads never call it: the challenge).
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
  per-message total binds before the per-candidate cap. The three toasts are `alertToast` notices that carry
  an optional typed `code` beside their English `message` (`GenerationNotice`, `shared/jobs.ts`); the tab
  (`src/ts/network/jobChannel.ts`) shows the `en.ts`/`ko.ts` string for a code it knows and the message
  otherwise, so an older tab still shows the English text (U2; the owner's choice on 2026-11-05 after the Slice 1
  challenge found that a notice carries only its text). A candidate's copy of `generationInfo` leaves out
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
  owner's job socket resends the carrier whole on each checkpoint (`diffChat`, `generationJobs.ts` around
  lines 579–608). This plan relies on the Incremental Chat Transport plan for the delta forms (its D2, being
  widened to a per-row top-level field diff with `data` as a text delta, so a text-only checkpoint stays small
  whatever the candidates weigh) and on its Slice 4 (the over-cap row manifest and the by-id row read) with
  that plan's D6 amended so that a manifest with `meta: true` is answered with the rows plus the chat's
  changed metadata fields at that revision (`metaFields`) instead of falling to a whole-chat read. The
  amendment is what makes the fallback one row read for this plan: the begin group, the write-back and a
  switch change `scriptstate` in the same transaction as `candidates` (D5, D10, D13), and Slice 4 as first
  written reads the chat whole for every such entry. With it, a loaded observer at the base revision applies a
  reroll's begin group (the candidates and the `scriptstate` merge) without a whole read. This plan makes that
  Slice 4 a merge-time dependency of its Slice 2 rather than a gated one. The dependency is traffic, not code:
  Slice 2 calls nothing Slice 4 adds (a switch is an ordinary by-id write, and the feed decides how a write
  travels), and without Slice 4 an over-cap carrier write falls to today's whole-chat read, which is correct
  but costs every loaded observer a read of the chat on each begin, write-back and switch. So the two may be
  built on separate branches; Slice 2 reaches `dev` only in the same merge as Transport Slice 4 or after it,
  and that merge runs the integration checks under **Verification**, which neither branch's own tests prove
  (Slice 4's tests use a carrier fixture, not this plan's ops). Transport Slice 2 (the owner's job socket
  sending row changes instead of whole rows) is not a dependency: until it lands the owner tab receives the
  carrier whole on each checkpoint, a cost to that one tab, accepted. Even then a write that changes
  `candidates` is not small: the field travels whole.

  Rejected: no cap (RisuBard grew chats by tens of MB with two full snapshots per message); a cap on total
  bytes per chat (it would make the newest reroll fail for an old chat's sake); a per-message total small
  enough to keep every row under 64 KiB (about 48 KiB: the carrier's own text, metadata and envelope are
  unbounded, so no candidate budget guarantees a fit, and 48 KiB holds few long replies); stripping
  `candidates` from feed rows (a feed row replaces the row the observer holds, so the observer would lose
  them); the draft's rationale that the per-candidate caps keep rows under `MAX_FEED_PATCH_BYTES` (they allow
  about 4.5 MiB per row: the audit); the first revision's reliance on Transport Slice 4 as written (its row
  read requires `meta: false`, and every reroll write that restores a variable is `meta: true`, so the
  observer read the chat whole: the challenge); splitting the begin group so the `candidates` write carries no
  metadata (an observer would see the carrier changed without its variable restore, the consistency the single
  group exists for).

- **D5. Where `before` is taken, and the per-key restore.** `before` is the chat's `scriptstate` as stored
  when the response's generation starts: for a send, after the input stage (the user message appended, the
  `input` trigger and `editinput` run), before `runSpeaker`'s setup and `start` trigger; for a reroll, the
  carrier's stored `scriptstateCheckpoint.before` stands (the user turn's effects stay, the discarded reply's
  go; the reroll job runs no input stage), and a carrier without a checkpoint (every reply written before
  Slice 1, one whose snapshot D4 skipped, one D6 cleared) takes `before` as the `scriptstate` stored at the
  reroll's start, before the begin group, and has nothing to restore; a carrier whose checkpoint has no
  `after` (its selected candidate is text-only, D10) keeps its `before` and has nothing to restore either, as
  with a skipped snapshot; for a continue, the continued message's `before` stands (RisuBard's
  `selectResponseScriptstateBefore`). `after` is the `scriptstate` as stored when the job's last round for
  that reply has flushed its metadata (`flushChatMetadata`), written in `finalize`'s final write (a
  `setMessage` built from the stored row, for a send and a reroll alike) rather than with
  `writeReplyGenerationInfo`, which skips a reply without `generationInfo` (`runner.ts` around lines
  1657–1659) and which the emotion view mode never reaches (around lines 2044–2046). The restore at a reroll's
  start is **per key**, when the checkpoint has an `after`: for every key of `before ∪ after`, when the stored
  value equals `after`'s (the response set it and nothing changed it since) it becomes `before`'s (a
  `mergeUnset` when `before` lacks it); a key whose stored value differs from `after`'s was edited after the
  response (the tab's `setChatVar`, a Lua button, a `/setvar`) and is kept. `after` is the selected
  candidate's (D2), so the comparison holds after a switch. One `meta` op with `merge` and `mergeUnset` before
  the `start` trigger, in D7's begin group; it is the attempt's first variable write for D13. Rejected:
  RisuBard's wholesale `chat.scriptstate = before` (it erases every variable written between the reply and the
  reroll, which on a server with Lua buttons and a second tab is an ordinary race, not a corner case); taking
  `before` at admission before the input stage (a reroll would then undo the input trigger's writes, which the
  reroll never re-runs).
- **D6. Checkpoints only on the latest reply.** The store owns the rule: its append branch
  (`server/src/data/chatStore.ts`), applying any group that appends a new reply or a new user message (the input
  stage, a speaker's reply, an error reply, a trigger's insert, `/send` and `/sendas`, Lua, a command sequence,
  a client op), unsets `scriptstateCheckpoint` and every `candidates[].scriptstateAfter` of every other message
  of the chat that has them, in the same transaction. Candidate texts stay (Q1). The cleanup skips a message
  whose generation is open: a write without a generation closes the fence whatever job token its group carries
  (`refusedByLock` compares tokens only, `server/src/data/chatStore.ts` around line 1451; the fence closes
  around lines 1936–1943), after which the generation's checkpoints and final write are `ignored`. So the
  cleanup leaves an in-place reroll's carrier to its own writes, and the carrier's checkpoint is rewritten or
  left out by its final write (D7 step 6) or its write-back (D8), both built from the stored row: when a
  trigger appended a message during the reroll that leaves the carrier no longer the newest reply at the end
  (a reply or a user message after it, not a comment), that write writes no `scriptstateCheckpoint` and no
  `candidates[].scriptstateAfter` for it (the candidate texts stay); otherwise it writes the checkpoint as D7
  and D8 say. The client never restores a checkpoint of a message that is not the carrier, and the normalizer
  drops nothing for position (a stale copy on an older message is harmless data until the next job write
  removes it). Rejected: the client dropping older copies as RisuBard's `attachScriptstateCheckpoint` does
  (two tabs would race, and the server is where the append happens); the first revision's cleanup
  `patchMessage` on the carrier too (a `start` or `output` trigger's append during a reroll closed the
  carrier's open generation, so the stream, the final write and the write-back were `ignored` and the carrier
  stayed empty or partial while the lock was held: the challenge); a generation-tagged `setMessage` that
  cleans the carrier at the append (the challenge's alternative; it works, but the final write rewrites the
  carrier from the stored row anyway, and one carrier write per end is simpler to keep consistent with the
  rollback state); one cleanup `patchMessage` per append producer in the job (the revision before 2026-11-05:
  it named three producers, and the Slice 1 challenge found error replies, `/send`, `/sendas`, Lua, command
  sequences and client ops appending without it; the owner chose the store boundary).
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
     `candidates[selected]`, D2's rule), adds the new last slot under D4's caps and sets `selected` to it
     (each new entry with a fresh `id`, D2), sets `data` to "" (`role` and `data` can be set, not unset), and
     sets the checkpoint's `before` when the carrier had no checkpoint (D5); a `setTranslation` that clears
     the carrier's translation (the store ignores `translation` on `patchMessage` and `setMessage`); D5's
     restore `meta` op; then `begin` on the carrier. The `begin` comes last because a `patchMessage` closes an
     open generation fence (`shared/chats.ts` around lines 75–78; `chatStore.ts` around lines 1936–1943),
     after which every generation write is `ignored` and `finalize` throws. A `begin` on an existing message
     needs the current revision, which `writeOwn` reads first; the lock checks of `writeAsJob` run for the
     whole group before it applies.
  3. Setup, the memory step, the `start` trigger and assembly run on the history view (below), with
     `continueSend` false.
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
     beside the final `generationInfo`, `before` kept, or leaves out the checkpoint and every
     `candidates[].scriptstateAfter` when a trigger appended a message after the carrier (D6); a translation
     change goes through `setTranslation` in the same group.

  The history view is a chat view the job scope hands four readers: prompt assembly (around line 1373,
  including its read after the `start` trigger), the memory source (around lines 1322–1339),
  `runCurrentChatFunction` (around lines 1244–1270), and the `start` trigger's chat copy and its diff baseline
  (`runOnCopy`, diffed in `server/src/jobs/chatResult.ts`), with Lua's `liveChat` inside that trigger reading
  the same view; and CBS, whose chat comes from the job's CBS host database (`getDatabase`,
  `server/src/jobs/cbsHost.ts`), not from assembly's chat. Besides the view, in every job that host hands
  CBS message objects without `candidates`, `selected`, `candidatesRevision` and `scriptstateCheckpoint`:
  `{{history}}` and `{{charhistory}}` serialize whole message objects (`shared/cbs/registry.ts`), so an older
  reply's discarded candidates would otherwise reach an ordinary send's prompt (found by the Slice 1
  challenge, 2026-11-05). It is the stored messages minus the carrier, derived at each read from the chat the job scope
  holds after its refreshes, so a message a `start` trigger appends is in it: assembly re-reads the chat after
  the `start` trigger (`host.chat()`, `server/src/prompt/assemble.ts` around line 1691) and builds the prompt
  from that read, so the appended message is in the prompt. The trigger diff uses the same view as its
  baseline, so the carrier's absence from both sides emits no `remove`. A message a trigger appends during a
  reroll is placed after the carrier in the stored chat: the diff's anchor after the message the carrier
  follows becomes an anchor after the carrier (an anchor after a later message, such as a trailing comment,
  stays); D6 says what the carrier's last write does then. The view ends at request dispatch: the request, the
  stream, the generation's own reads and writes (`storedReply`, `throwError` addressed by the owned generation
  id as D8 says, the checkpoints, `finalize`, the write-back of D8) and the tail (`editoutput`,
  `runCurrentChatFunction` after the reply, the `output` trigger, inlays, `chatOutput` listeners) read the
  stored chat, carrier included, as a send's tail reads its new reply. The job's `done` keeps `messageId`;
  `alternatives` (D9) is no longer sent. A `reroll` job without the field runs as a send with empty input, as
  the code does today; a tab sends the field only as D14 allows. Rejected: a new job kind (`reroll` already
  exists and already means this); the client pushing the old content into `candidates` before the create (a
  create that gets no answer would leave the chat changed, which is the uncertain-create class the chat
  pipeline guide spends a section on); the draft's order `begin` then `patchMessage`, and a `patchMessage`
  refreshing `candidates[selected]` after the stream (each closes the generation it needs: the audit);
  filtering each reader on its own (the trigger diff would still see the carrier missing from its copy and
  remove it); the first revision's view ending before the carrier (a message the `start` trigger appended was
  missing from the prompt, since assembly re-reads the chat after the trigger: the challenge).

- **D8. Interrupted reroll.** The write-back is the generation's final write, made where `runSpeaker` makes it
  today: the abort and read-failure branch (`runner.ts` around lines 1730–1736) and the `finally` for a
  generation still open (around lines 2083–2089). It therefore lands while the lock is still held; the final
  write is what releases it (`generationJobs.ts` around lines 1324–1330). One group: `finalize`'s
  `setMessage`, built from the stored row, with `candidates[previous]`'s `data`, `generationInfo` and
  `promptInfo` on the carrier, `selected = previous`, the new slot removed (`candidates` and `selected` unset
  when one entry is left, D3), `scriptstateCheckpoint.before` kept and its `after` set to that candidate's
  `scriptstateAfter`, or unset when it has none (both halves and every `candidates[].scriptstateAfter` left
  out when a trigger appended a message after the carrier, D6); a `setTranslation` with that candidate's
  translation; and D13's variable rollback, which the store computes from its attempt ledger when it applies
  this group, after the pending metadata flush (`server/src/jobs/jobScope.ts` around lines 488–518). The job
  ends with the terminal it had; the tab's `restoreRerolledReplies` has nothing to do.

  Rounds (the owner's choice on 2026-11-05, after the Slice 1 challenge found that `runSpeaker` finalizes before
  it returns a next round and `runSend` re-enters it with the same context): only the job's first round is the
  reroll. `rerollMessageId` is handled on the first `runSpeaker` entry only, and the attempt (the lock, the
  ledger, the write-back) ends with that round's final write. A later round of the same job (an auto-continue, a
  resend) runs as it does after a send: a continue round locks the carrier again, keeps `before`, and its final
  write refreshes `candidates[selected]` and the checkpoint's `after`; a resend's reply is an append (D6); a
  later round's failure writes nothing back. Rejected: holding the lock and the ledger across rounds so any
  round's failure restores the previous candidate (it changes the round structure of `runSpeaker`).

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
  1016–1058): the user sees the error where a send shows it, the previous reply one swipe away. During an
  in-place reroll `throwError` addresses the carrier by the owned generation's `messageId`, not the last
  stored message (around line 1024), and writes the suffix with the active generation (`owned.next()`), so the
  error lands on the carrier even when trailing comments follow it; a job with no owned carrier keeps today's
  last-message behavior. A reroll aborted mid-stream discards the partial text and writes back, a deliberate
  change from today, where the abort path persists the partial text (around lines 1730–1734) and the bundle
  history cannot put the old tail back while the partial reply holds the anchor; a tail failure after the
  completed text was stored writes back too (today it keeps the text). A server process death mid-reroll, or
  an abort past the grace, leaves the carrier with the partial streamed text selected, the previous candidate
  one swipe away and the variables as the attempt left them (the lock is memory-only and clears at restart);
  no boot sweep (**Later**). Rejected: keeping the partial text as a candidate of its own (a fragment the user
  stopped is not something they asked to keep); a write-back after `runSpeaker` returns (the draft: the final
  write has released the lock by then, so another tab's edit can land first and the write-back overwrites it:
  the audit); re-appending the carrier after a trigger removed it (a period without the carrier that other
  tabs and memory observe as a deletion); the draft's "Stop today discards it too" (the abort path persists
  the partial text); keeping `throwError`'s last-stored-message target in a reroll (a trailing assistant
  comment took the suffix as an unlocked manual write, a trailing user comment got a new error reply, and the
  carrier was written back without the error: the challenge).

- **D9. The extra samples of one request become candidates.** When a request returns several texts (the
  streaming `lastChunk` map, the non-streaming `mrerolls`: upstream's "cached reroll"), the job writes them as
  `candidates` of the reply at its final write, the reply first and selected, the others text-only (no
  `generationInfo`, no `promptInfo`, no `scriptstateAfter`: the reply's `output` trigger stage never ran for
  them, though non-streaming samples already pass `editoutput` (`runner.ts` around line 1789), so switching to
  one changes no variable and unsets the checkpoint's `after`, D10). `terminal.alternatives`,
  `installReplyAlternatives`, `addRerolls`, and `prereroll.ts` retire (V4 for every consumer, the chat
  pipeline guide's Sequence events bullet included). Slice 1 moves the server's other producer of the removed
  field (`server/src/jobs/commandRunner.ts` around line 321, which copies `result.alternatives` into the
  sequence event), the two tab consumers (`serverGeneration.ts` around lines 156–157, `serverCommands.ts`
  around lines 622–623), their tests and `addRerolls` into itself, so `pnpm check` passes with the field
  removed; `Prereroll`, `PreUnreroll` and the file go in Slice 2 with their screen. Rejected: keeping
  `alternatives` on the terminal beside the field (two sources for one list; an older tab between a deploy and
  its reload lacks only the swipe to an extra sample until it reloads).
- **D10. A candidate switch is a server-applied chat op.**
  `selectCandidate { messageId, candidateId, expect: { candidatesRevision } }` (`shared/chats.ts`) is applied
  by the store from the stored row, never from the tab's copy. It refuses when the stored `candidatesRevision`
  differs from `expect` or no stored candidate has `candidateId`: it applies nothing, and the refusal is an
  answer the tab's write path sees (unlike a by-id op's missing-target no-op, `shared/chats.ts` around lines
  42–44); the tab re-reads the chat and shows the current list, and never reinterprets its old index against
  it (the user's next press acts on the list shown). It applies only while the carrier is the newest reply
  (D1, Q1) and not locked. Otherwise, in one transaction, it refreshes the slot it leaves from the carrier's
  current fields (an edit made meanwhile is what switching back brings); swaps `data`, `generationInfo`,
  `promptInfo` and the translation from the stored candidate with `candidateId` (the translation only while
  its `sourceHash` matches the target's `data`, else cleared); sets `selected` to the target's index (the
  store bumps `candidatesRevision`, D2); keeps `scriptstateCheckpoint.before` and sets its `after` to the
  target's `scriptstateAfter`, or unsets `after` when the target has none (a D9 sample, a converted swipe), so
  a later switch back to a checkpointed candidate still finds the turn's baseline; and computes D5's per-key
  variable patch from the stored `after` (the leaving candidate's, D2) to the target's against the stored
  `scriptstate`, so a variable another tab edited between the tab's read and the op is never overwritten. A
  target without a snapshot, a checkpoint without `after` (the leaving candidate is text-only), or a carrier
  without a checkpoint leaves variables as they are: switching to or from a text-only candidate changes no
  variable. The computation is the pure helper of D3, so the tab's mirror shows the same result
  optimistically. In the tab, `switchCandidate(ref, messageId, candidateId)` in a new
  `src/ts/process/rerollCandidates.ts` refuses while the chat is busy or the carrier locked (`assertUnlocked`)
  and queues this one op, `expect` taken from its mirror. It runs no trigger, hook, or CBS, as a text edit
  does not; the display transform re-renders from the new revision. Structured memory and HypaV3 see it as an
  edit, as before: the store counts the `data` change as a rewrite of the message, as it does a `patchMessage`
  of `data`; for structured memory it is an edit of a message no event cites, unless the user pressed "record
  now" on it, in which case the edit marks the event `rerecord` as any edit does (correct: the cited text
  changed). HypaV3 and SupaMemory read the carrier's `data` at the next send, which is the commit boundary:
  the candidate selected when the user sends the next message is the one memory ever reads; a discarded
  candidate is never memory input, since a reroll job's memory step reads the history view, which leaves the
  carrier out (D7) and the writer's ceiling keeps the newest reply out. Rejected: the draft's switch as by-id
  ops from the tab (a `patchMessage` of `data`, `generationInfo`, `candidates` and `selected`,
  `setMessageTranslation`, and `mergeChatMeta` of a per-key patch computed in the tab): a `patchMessage` sets
  whole fields also on a stale revision, so a tab that had not seen another tab's finished reroll wrote its
  old `candidates` over the newer list, and its variable decision, made from its copy, overwrote a variable
  another tab set meanwhile (the audit and its cross-check); the draft's reasons for refusing the op (the
  module's ops already give atomicity and apply on a stale revision; a route would need its own lock check and
  feed entry) do not hold, since applying on a stale revision is the failure and an op inside the chat write
  path gets the lock check and the feed entry from it; a precondition on the candidates alone (it misses a
  variable-only change); a whole-chat revision precondition on the tab's group (any write to the chat, a
  memory task's included, would refuse the switch); a switch on an older message (the draft's D10 sentence
  allowing one; Q1 and **Out of scope** exclude it); the first revision's
  `{ id, index, expect: { selected, count } }` (once the ring is full, another tab's reroll drops C0 and adds
  C16 with the count and `selected` unchanged, so a stale switch to index 14 passed and selected C15 instead
  of the intended C14: the challenge); a tab retrying a refused switch by its old index (the same
  reinterpretation); unsetting the whole checkpoint on a switch to a text-only candidate (see D2).
- **D11. Export and import.** The upstream export strips `candidates`, `selected`, `candidatesRevision` and
  `scriptstateCheckpoint` from every message and reports one excluded entry `message-candidates` with the
  count of messages that had candidates (the convention of `message-translations`: upstream's `Message` lacks
  the fields, and the selected text is already `data`). The upstream import converts PocketRisu's and
  RisuBard's `swipes`/`swipeId` into `candidates` (text only, each with a fresh `id`, `selected` from
  `swipeId` remapped after the skipped holes and non-strings, a `data` that matches no swipe appended as
  RisuNest's converter does) and RisuBard's `scriptstateCheckpoint` and `scriptstateSwipeCheckpoints` into the
  checkpoint and the candidates' `scriptstateAfter` of the chat's newest reply only (older messages' copies
  dropped: D6), reported as `converted` `message-swipes`. RisuNest's `responseVariants` is not converted
  (**Later**). The one-way compatibility rule of the persistence guide covers both directions. Rejected:
  emitting `swipes`/`swipeId` in the `.bin` for PocketRisu-family readers (upstream would carry dead fields,
  against the export's rule of stripping what upstream's types lack; Q2 keeps it as an option).
- **D12. Multi-tab.** Candidates are chat data: a reroll's writes reach other tabs through the chat patch feed
  and the job's `chatPatch` as any message write does (at the cost D4 states), and a switch reaches them as
  the op's write. While a reroll runs, every tab sees the carrier locked (`streaming` entries) with the new
  text streaming in, its arrows disabled (`locked` in `Chat.svelte`, `assertUnlocked` in the module), and the
  previous reply already in `candidates`. Two tabs that switch at once: the first switch bumped
  `candidatesRevision`, so the second op's `expect` no longer matches the stored row; it is refused, and that
  tab re-reads and shows the first switch's result. Under the Job Handoff plan the three toasts of D4 reach
  the job's owner only, so a phone that handed its reroll to a worker never sees `rerollCandidateDropped`;
  accepted, since the dropped candidate is the oldest unselected one. Rejected: a per-tab selected index (the
  selection is what memory and the prompt read, so it must be the chat's); the draft's last-write-wins per
  field for two switches (see D10).
- **D13. Variable rollback by attempt provenance.** Provenance is recorded at the store's per-key
  `scriptstate` mutation boundary, not in the runner's setters: while a reroll holds the carrier lock, the
  store keeps an attempt ledger for that chat. The job opens it with its begin group (an `applyChanges` option
  of the job's write path, not a field of the wire op; the group's own restore op is its first entry), and it
  closes when the generation's final write or write-back is applied; it lives in memory, as the lock does.
  The option travels through `ResourceStore.applyChanges` (`server/src/data/resourceStore.ts`, which calls
  `chatTables.apply` with explicit arguments), the ledger's changes are staged with the transaction and
  dropped when it rolls back, and a ledger whose token or lock ends without a final write (grace expiry, an
  epoch replacement) is dropped too.
  Every per-key write the store applies to the chat's `scriptstate` while it is open is recorded with its
  origin and the previous value or a removal tombstone (and the value it left, a tombstone for a removal): a
  `meta` op's `merge` and `mergeUnset`, and a whole-map write (`set` or `unset` of `scriptstate`, a
  `replace`'s metadata) for each key it changes (`applyGroup`, `server/src/data/chatStore.ts` around lines
  1815–1884). The origin is the job's token (the attempt) when the group came through the job's write path,
  which passes it (`writeAsJob`, `server/src/jobs/generationJobs.ts` around line 1274): D5's restore, a
  trigger's merges through `applyTriggerChat`, Lua's `setChatVar` through the pending metadata flush
  (`server/src/jobs/jobScope.ts` around lines 488–518), `/setvar` and `/addvar`
  (`server/src/prompt/commands.ts` around lines 282–295). A write without the token is foreign: another tab, a
  plugin callback's `setChatVar` (`src/ts/parser/chatVar.svelte.ts`, a `meta` merge), any other writer. Per
  key the ledger needs only the value before the attempt's first write, the newest foreign value written after
  that first write, and the origin of the last write. On an end without a reply (D8) the store computes the
  rollback when it applies the write-back group, after the pending flush, so no write lands between the
  computation and its result. Per key: if the last write is foreign, it is left; else the value that preceded
  the attempt's first write is restored, unless a foreign write happened after that first write, in which case
  the newest such foreign write's value is restored (a `mergeUnset` for a tombstone). Example: the previous
  reply left x at 1; D5's restore writes 0, another tab writes 9, a trigger writes 2; the failure restores 9.
  Since D5's restore op is the attempt's first write, the pre-attempt values are the ones stored before the
  reroll began, which equal the previous candidate's `after` wherever nothing else wrote. The candidate's
  `scriptstateAfter` is not consulted. Rejected: the first revision's rule that a key whose stored value still
  equals the attempt's last write gets its pre-attempt value back (with x at 1, the attempt's 0, a foreign 9
  and the attempt's 2, the stored 2 equals the attempt's last write, so x went back to 1 and the foreign 9 was
  lost; a removal in place of the 2 fails the same way: the challenge); recording in the runner's setters
  (they never see a foreign write, and an enumerated list misses a writer such as `/addvar`); D5's rule in the
  other direction, from `before` to the previous candidate's `scriptstateAfter` (the draft: with `before` x=0
  and the old reply's x=1, an attempt that sets x=2 and fails compares 2 with 0, keeps 2 as if another writer
  set it, and a key the attempt introduced lies outside `before ∪ after` and stays: the cross-check); the
  whole map back to the previous `after` (it erases another tab's edits, as D5's rejection of RisuBard's
  wholesale restore says); a snapshot of all variables at the failure (it cannot tell the attempt's writes
  from another writer's).
- **D14. Mixed tab and server versions.** An older server drops `rerollMessageId`:
  `server/src/routes/generations.ts` (around lines 202–218) copies only the context fields it knows, so a
  newer tab's reroll would run as a send with empty input and append a second reply after the carrier. The tab
  therefore sends `rerollMessageId` only when the server advertises the capability, and otherwise runs today's
  removal path. The signal is a field on the live-update socket's `hello` frame (`rerollInPlace: true`,
  `shared/events.ts` around lines 42–48), the cheapest existing one that works: `GET /api/generations/current`
  answers 404 when no job runs, so it has no field to read before the first reroll, and the create's answer
  arrives after an older server has admitted the job without the field. The capability is connection-scoped:
  `src/ts/network/eventFeed.ts` clears it in `retire` (around line 148, which every disconnect, failure and
  new connection runs) and sets it again from each `hello` (around line 263), so a reconnect whose `hello`
  lacks the field turns the path off, and a reroll before a connection's first `hello` (boot starts the feed
  without awaiting it, `src/ts/bootstrap.ts` around line 149) takes the removal path. Not verified: a
  downgrade between a `hello` and the create (the tab still holds the flag when an older server admits the job
  and drops the field); Slice 2 tests the capability's lifetime with a held-back reconnect `hello` and an
  early reroll, before any larger protocol change is considered. A tab not yet reloaded after the deploy still
  runs today's path: its reroll removes the carrier and with it the carrier's candidates (D9's samples from
  Slice 1, every reroll's from Slice 2), which then live only in that tab's bundle history until it reloads;
  accepted, since the window ends at the reload. Rejected: refusing on the server a removal of a carrier with
  candidates (an older tab's reroll would fail with nothing the user can do short of a reload); the draft's
  claim that nothing a tab sees differs after Slice 1; a capability kept for the tab's lifetime once seen (a
  reconnect to a downgraded server would keep it: the challenge).

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
in `src/ts/process/serverCommands.ts` (D9's consumer moved into it), which Job Handoff Slice 1
(`shared/jobs.ts`, `routes/generations.ts`) and Slice 2 (`followJobToEnd`) and Incremental Chat Transport
Slice 2 (`shared/jobs.ts`) and Slice 3 (`routes/events.ts`) also edit. Slice 1 also edits
`server/src/data/chatStore.ts` (the op-write refusal, the tolerant reads, `candidatesRevision`, the attempt
ledger), which Transport Slices 1 and 4 edit, and its `server/src/routes/events.ts` and `shared/events.ts` are
Job Handoff Slice 3's too. The overlaps are files, not dependencies, so since 2026-11-05 (the owner's
decision) Slice 1 may be built on its own branch beside those seven slices; whichever reaches `dev` second
merges `dev` in, resolves the overlaps by hand (`server/src/prompt/runner.ts`,
`server/src/jobs/generationJobs.ts`, `server/src/data/chatStore.ts`, `shared/jobs.ts` and the `hello` frame
above all) and runs the merge checks under **Verification**. Slice 2 edits `src/ts/storage/chatStore.svelte.ts`,
`src/ts/network/eventFeed.ts`, `DefaultChatScreen.svelte` and `Chats.svelte`, which Transport Slices 0–4, Job
Handoff Slices 2 and 3 and Render Work Budget Slice 4 also edit; its `server/src/data/chatStore.ts` (the op)
is Transport Slices 1 and 4's too; it reaches `dev` in the same merge as Transport Slice 4 with that plan's D6
metadata amendment or after it (its merge-time dependency, D4). When it is built on a branch beside those
slices rather than after them, the merge resolves these overlaps by hand (`server/src/data/chatStore.ts` and
`src/ts/storage/chatStore.svelte.ts` above all, and the guides both edit) and runs the integration checks
under **Verification**.

### Slice 1: the schema, the normalizer, and the reroll job (D1–D9, D13, D14 server side; needs nothing)

Files: `shared/database.ts` (the types), new `shared/rerollCandidates.ts` (helpers and caps),
`server/src/data/chats.ts` (`normalizeMessage`'s shape rules: refuse on op writes, drop on import and
read-back), `server/src/data/chatStore.ts` (the refusal on op writes, the tolerant validation on the stored
reads, `candidatesRevision` set on every write that changes `candidates` or `selected`, the attempt ledger and
the rollback computed from it, D6's cleanup in the append branch), `server/src/data/resourceStore.ts` (the
ledger option through `applyChanges`, staged with the transaction, D13), `server/src/data/checkpointStore.ts`
(the tolerant read of composed rows, D3), `shared/jobs.ts` (`GenerationContext.rerollMessageId`, `alternatives`
removed from the done event and the sequence event, the notice `code`, D4), `server/src/routes/generations.ts` (validation, the kind
restriction, the context copy), `server/src/jobs/generationJobs.ts` (`requestFingerprint`, `keptTerminal`
without `alternatives`, the ledger option through `writeAsJob`), `server/src/jobs/commandRunner.ts` (the
sequence event without `result.alternatives`, around line 321), `server/src/prompt/runner.ts` (the carrier
check, the begin group inside `runSpeaker`, the post-assembly `generationInfo`/`promptInfo` write, the
stored-row non-streaming write, the `before` and `after` snapshots in `finalize`, the final write with
`candidates`, the write-back as the final write, the checkpoint left out after a trigger's append,
`throwError` by the owned generation id, the samples as candidates, the toasts), `server/src/jobs/jobScope.ts`
(the history view, the snapshot read beside `flushChatMetadata`), `server/src/jobs/runSetup.ts` (`runOnCopy`
on the view), `server/src/lua/bindings.ts` (`liveChat` on the view), `server/src/jobs/cbsHost.ts` (CBS on
the view, message objects without the candidate fields, D7), `server/src/jobs/chatResult.ts` (the anchor
after the carrier, the carrier removal turned into an explicit no-reply outcome), `shared/events.ts` and
`server/src/routes/events.ts` (`rerollInPlace` on `hello`), `src/ts/process/serverGeneration.ts`
(`installReplyAlternatives` removed), `src/ts/process/serverCommands.ts` (the sequence event without
`alternatives`), `src/ts/process/prereroll.ts` (`addRerolls` removed), `src/ts/network/jobChannel.ts` (the
notice `code` shown from the locale, D4), `src/lang/en.ts` and `ko.ts` (the three toasts), the server
generation guide (Generation admission, Prompt job execution, a new "Reroll in place" flow, Invariants), the
persistence guide (Messages), the scripts and triggers guide (State: what a reroll does to variables), the
chat pipeline guide (the removed sample installation, D9). Existing tests that the removed field and export
make stale: `server/src/tests/generations.test.ts`, `generationReceipts.test.ts`, `promptTail.test.ts`, and
`src/ts/process/rerollHistory.test.ts` (its `addRerolls` cases).

- Tests (`server/src/tests/promptRunner.test.ts`, `generationJobs.test.ts`, `chats.test.ts` for the
  normalizer, `chatStore.test.ts` for the op-write refusal, `chatResult.test.ts`, `memoryJobs.test.ts`,
  `events.test.ts`, with the mock provider those files use; `src/ts/process/serverGeneration.test.ts` and
  `src/ts/process/serverCommands.test.ts`, whose alternatives cases around lines 299 and 2234 change to no
  `alternatives`):
  - the in-place reroll: a reroll with `rerollMessageId` keeps the carrier's id, pushes the previous `data`
    under a fresh candidate `id`, `generationInfo` without `context`, `promptInfo` without `promptText`,
    translation and `after` into `candidates`, streams into the carrier, and ends with `candidates[selected]`
    equal to the new reply and the new `generationInfo` and `promptInfo` on the carrier; every checkpoint and
    the final write of that reroll are `applied`, none `ignored` (the fence the begin group must not close); a
    non-streaming reroll keeps `candidates`, `selected`, `scriptstateCheckpoint`, `name`, `disabled` and
    `isComment` (the whole-row rewrite); a reroll of a group owner's carrier runs only the carrier's speaker;
    each write that changes the list bumps `candidatesRevision`, also an older tab's `setMessage` that carries
    an old value;
  - the view: the prompt and the memory step of that job hold no carrier text; a `start` trigger that appends
    a message during a reroll removes nothing, its message lands after the carrier and is in the prompt, the
    reroll completes with every checkpoint and the final write `applied`, and the carrier ends with its
    candidate texts and no `scriptstateCheckpoint` or `scriptstateAfter` (the append through completion); the
    same append followed by a request error ends with the write-back `applied`, the previous candidate
    selected, the lock released and no checkpoint on the carrier (the append through failure);
  - variables: a variable the reply set is back to `before` when the `start` trigger reads it, and a variable
    set after the reply by a `meta` merge is kept (D5); a carrier without a checkpoint takes `before` at the
    reroll's start; `after` is written for a reply without `generationInfo`; a checkpoint whose selected
    candidate is text-only keeps its `before`, and a reroll from it restores nothing;
  - the write-back: a reroll aborted mid-stream leaves the previous candidate selected with its text,
    `generationInfo`, `promptInfo`, translation and variables, the partial text gone, and `candidates` unset
    when one entry is left; the write-back is the generation's final write: an edit of the carrier by another
    client while the job unwinds is refused as generating, and the carrier ends with the previous candidate
    (the lock released before the write-back); a request error, a timeout and a `maintenance` abort write back
    the same way; an `output` trigger that removes the carrier leaves it with every candidate and the previous
    one selected (the trigger removal); with `inlayErrorResponse` the error text stays the selected candidate
    and the previous reply is kept, also with a trailing assistant comment and with a trailing user comment
    after the carrier: the suffix lands on the carrier with the active generation, the comment is not edited
    and no error reply is appended (the error target); a failed attempt whose `start` trigger set x from the
    restored 0 to 2 leaves x at the previous reply's 1, a key the attempt introduced is removed, and a key
    another writer changed during the attempt is kept (the failed attempt's own variable write); with x at 1,
    D5's restore writing 0, a `meta` merge without the job's token writing 9 and the `start` trigger then
    writing 2, the failure leaves x at 9, also when the trigger removes x instead (the attempt ledger);
  - the rest: a reroll whose carrier is no longer the newest reply ends with an `error` of reason `failed`; a
    send's reply append unsets the older reply's checkpoint and its candidates' `scriptstateAfter` and keeps
    their texts (D6); a request with three samples writes three candidates with the reply selected and no
    `alternatives` on `done` (D9); the seventeenth candidate drops the oldest non-selected one with one toast,
    a write over the per-message total drops the oldest non-selected ones, an oversized previous reply is not
    kept, and an oversized snapshot writes no checkpoint (D4); `normalizeMessage` on an imported chat drops a
    malformed `candidates`, an out-of-range `selected`, a one-entry `candidates` or a non-map snapshot and
    keeps the message, keeps a single reply's checkpoint and one without `after`, and a stored row with a
    malformed field read back through `readChat` comes without that field; a `patchMessage` or `setMessage`
    with a malformed or over-cap `candidates` is refused with a validation error and stores nothing; the route
    refuses `rerollMessageId` on a kind other than `reroll`; the fingerprint differs by `rerollMessageId`; a
    `reroll` job without the field runs as a send with empty input; the `hello` frame carries `rerollInPlace`;
    a sequence event of `commandRunner.ts` carries no `alternatives`.
  - the 2026-11-05 additions: a prompt with `{{history}}` or `{{charhistory}}` holds no candidate text, in a
    reroll and in an ordinary send after an older reply with candidates (CBS); a `/send` or Lua append unsets an
    older reply's checkpoint, and an append during a reroll leaves the open carrier's fence open (the store
    boundary); a reroll that auto-continues runs the reroll once, and a failure of its later round keeps the
    first round's reply selected (rounds); a toast notice carries its `code` and the tab shows the Korean
    string under `ko` (D4); a named checkpoint whose page holds a malformed candidate field loads without it
    (D3); a write group that rolls back leaves the attempt ledger as it was (D13).

### Slice 2: the switch op and the tab's candidate controls (D10, D12, D14; needs 1; merges with or after Transport Slice 4)

Files: `shared/chats.ts` (the `selectCandidate` op), `server/src/data/chatStore.ts` (applying it from the
stored row, the `candidatesRevision` and missing-`candidateId` refusals as an answer the tab sees, the
newest-reply and lock checks, the variable patch against the stored `scriptstate`, the rewrite count for
memory), `shared/rerollCandidates.ts` (the selection helper), `src/ts/storage/chatStore.svelte.ts` (queueing
the op, the optimistic apply, `assertUnlocked`), `src/ts/network/eventFeed.ts` (the connection-scoped
`rerollInPlace` capability: set from each `hello`, cleared in `retire`), new
`src/ts/process/rerollCandidates.ts` (`switchCandidate`, the carrier check, the busy and lock refusals, the
re-read on a refusal), `src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`: a next candidate, else a
`reroll` job with `rerollMessageId` and `speakerChaId` when the tail is one reply and the server advertises
the capability, else today's removal path; `unReroll`: the previous candidate, else the bundle history),
`src/lib/ChatScreens/Chat.svelte` (the arrows addressing the neighbor candidate's `id`, the counter of Q4 in
the `rerolls` snippet, `candidateCount` and `candidateIndex` props), `src/lib/ChatScreens/Chats.svelte` (the
two props per row), `src/ts/process/serverGeneration.ts` (the `reroll` kind in the kind pick,
`rerollMessageId` and `speakerChaId` through `ServerSendArg`), `src/ts/process/prereroll.ts` deleted with
`Prereroll` and `PreUnreroll` (V4), `src/lang/en.ts` and `ko.ts`, the chat pipeline guide (Reroll modules,
Reroll, Sequence events, Known Hazards: the in-memory-only hazard narrows to multi-reply tails), the chat
store guide (the `selectCandidate` op).

- Tests (`server/src/tests/chatStore.test.ts`, `server/src/tests/promptRunner.test.ts`,
  `src/ts/process/rerollCandidates.test.ts`, `src/ts/process/serverGeneration.test.ts`,
  `src/ts/network/eventFeed.test.ts`, `src/lib/ChatScreens/Chat.controls.test.ts`,
  `src/ts/process/rerollHistory.test.ts` unchanged after Slice 1 removed its `addRerolls` cases):
  - the op: `selectCandidate` swaps `data`, `generationInfo`, `promptInfo` and a fresh translation from the
    stored candidate with `candidateId`, clears a stale one, and refreshes the slot it leaves from an edited
    text; it sets `scriptstateCheckpoint.after` to the target's `scriptstateAfter`, keeps `before`, and unsets
    only `after` for a text-only target, and a reroll after a switch to an earlier candidate restores `before`
    for a key that candidate set (the switch not updating `after`); A (checkpointed) → text-only B → reload →
    A → reroll restores A's key to `before` (the kept baseline); an op whose `expect.candidatesRevision`
    predates another tab's reroll is refused and the stored row is unchanged, both when that reroll made two
    candidates three and when it rotated a full ring of 16 (C0 dropped, C16 added, the count and `selected`
    unchanged), and an op naming a dropped candidate's `id` is refused too (the stale switch); a variable
    another tab set after the switching tab's read keeps its value while the other keys move to the target's
    (the switch after a newer variable edit); the op is refused on a message that is not the newest reply and
    on a locked carrier;
  - the tab: a switch queues exactly one `selectCandidate` with the target's `candidateId` and `expect` from
    the mirror; a switch on a locked carrier or a busy chat throws and queues nothing; a refused switch
    re-reads, shows the current list and queues nothing more; `reroll` with `selected` at the last candidate
    creates a `reroll` job with `rerollMessageId` and `speakerChaId` for a one-reply tail when `hello`
    advertised `rerollInPlace`, and runs the removal path for a two-reply tail, without the capability, before
    a connection's first `hello`, and after a reconnect whose `hello` lacks the field; a reconnect whose
    `hello` is held back while a reroll is pressed takes the removal path (the capability's lifetime, D14);
    the counter shows `2/3` and hides for one candidate; a mirror with `candidates` from a read (another tab's
    reroll) shows the arrows active.

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

1 → 2 → 3 → 4. Slice 2 may be built beside Incremental Chat Transport Slice 4 (with that plan's D6 metadata
amendment) on a separate branch, but reaches `dev` only in the same merge or after it (D4); Transport Slice 2
is not needed first. After Slice 1 no tab sends `rerollMessageId` yet, so every reroll
runs today's removal path, and the swipe to an extra sample is gone until Slice 2 (the samples are stored as
`candidates`, which no tab shows yet); a tab that removes a carrier with samples loses them as it loses them
today. After Slice 2's deploy a tab not yet reloaded still removes the carrier on its reroll, and the
carrier's candidates with it (D14). 1 and 2 together give the persisted candidates and the variable restore
the owner asked for; 3 settles the export and the memory proofs; 4 is the browser proof.

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
- The merge with Incremental Chat Transport, when Slice 2 and Transport Slices 0–4 were built on separate
  branches (D4): after the merge, besides V1 and `pnpm check:docs` on the guides both plans edit, add these
  cases to the two plans' focused tests and run them, since each branch's tests cover only its side:
  - a reroll's begin group, its write-back and a `selectCandidate` switch on a carrier over
    `MAX_FEED_PATCH_BYTES` each publish a row manifest with `meta: true` and the carrier's id in `changed`, and
    a second tab holding the chat loaded at the base revision applies the rows and `metaFields` through the
    `chatRows` read without a whole-chat read (`server/src/tests/chatFeedPatches.test.ts`,
    `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`, with this plan's real ops in place of Transport
    Slice 4's fixture);
  - the tab's optimistic switch, the reroll's result and `unReroll` change the message through the chat
    store's position-index path (Transport D1), and the index still validates after each;
  - the owner tab of an in-place reroll receives `streamed` entries for the carrier's raw checkpoints after
    the begin group and the whole row for a write that changes `candidates` (Transport D3), and its display
    matches the stored row at the end;
  - `hello` carries `rerollInPlace` beside the transport's `cursor`, and after a reconnect (`retire`, then a
    new `hello`) the capability is set again from the new `hello`.
- The merge of Slice 1 with a Job Handoff Slice 1–3 or Transport Slice 1–4 built beside it: V1 and
  `pnpm check:docs` after the merge, plus both sides' focused tests (this plan's server files above and the
  other slice's own list), and these cases checked in the merged code: the job's `done` and sequence events
  carry neither `alternatives` nor a field the other slice dropped, with the other slice's new job fields
  intact; `hello` carries `rerollInPlace` beside every field the other slice added; a reroll's begin group,
  final write and write-back still pass through the other slice's job write path with the attempt ledger
  option, and the feed entries it publishes for them (row diffs or manifests) carry `candidates` and
  `candidatesRevision`.
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
  puts back the attempt's variables if D13's attempt ledger is persisted for it, if it shows up in practice.
- Bundle candidates for multi-reply tails, if group chats need swipes: the carrier would be the turn's
  last reply and a candidate a list of messages, which is RisuNest's shape and its id problem.
- PocketRisu-compatible `swipes` in the `.bin` export (Q2 reversed).
- Pruning older messages' candidates at the commit boundary (Q1 reversed).
