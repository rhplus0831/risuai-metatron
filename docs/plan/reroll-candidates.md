# Reroll Candidates Plan

Status: drafted 2026-11-03, no slice landed. Decisions D1–D12 are recommendations for the owner; the
**Open questions** Q1–Q4 wait for the owner. Code anchors were checked at `8f0db0fb7`; verify them again
before editing (STRUCTURE.md protocol step 5).

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
[backup and sync hub guide](../structure/backup-sync-hub.md) (Upstream database export) at `8f0db0fb7`.

Owning guides when sliced: [persistence](../structure/persistence.md) (the message fields and their
normalization), [server generation](../structure/server-generation.md) (the reroll job's in-place
generation, the snapshots, the write-back), [chat pipeline](../structure/chat-pipeline.md) (the candidate
controls, what the per-chat bundle history still covers), [scripts and triggers](../structure/scripts-triggers.md)
(what a reroll does to variables), [chat store](../structure/chat-store.md) (the switch as by-id ops),
[structured memory writer](../structure/structured-memory-writer.md) and [memory](../structure/memory.md)
(the commit boundary), [backup and sync hub](../structure/backup-sync-hub.md) (the export mapping and the
import conversion), [test harness](../structure/test-harness.md) (the e2e spec).

Relation to other work: Chat Checkpoints (named per-chat save slots, done) snapshot the whole chat including
`scriptstate` in their meta (`server/src/data/checkpointStore.ts` `save`, `CHECKPOINT_CHAT_FIELDS` marks
`scriptstate` as `capture`); they are a different feature, user-named and whole-chat, and this plan reuses
none of their storage (a message's checkpoint is a field of the message, captured and restored by the job).
The Deep Audit Fixes (done) made a trigger's result merge `scriptstate` by key (`applyTriggerChat`,
`CHAT_META_MERGE_KEYS`), which is what the per-key restore of D5 relies on. The Asset Lifecycle plan, written
in parallel, must count inlay references inside non-selected candidates (see **Decisions** D4).

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

The baseline is `8f0db0fb7` on `dev` (2026-11-03). This plan does not re-propose it.

- **Reroll is a client-side removal followed by a plain send.** `reroll` in
  `src/lib/ChatScreens/DefaultChatScreen.svelte` (around line 582) first tries the in-memory swipe
  candidates (`Prereroll(genId)`), then the per-chat bundle history (`rerollHistory.canForward`), then pops
  every message after the last user message (with the group `saying` rule), records the removed tail
  (`rerollHistory.begin`), writes the shortened list with `editChatSync`, and sends with `kind: "reroll"`
  and no input. A send that brought no reply puts the tail back (`restoreRerolledReplies`), with the
  "unsafe" cases the guide lists. `unReroll` tries `PreUnreroll`, then `rerollHistory.back`.
- **Candidates are tab memory.** `src/ts/process/prereroll.ts` keeps `Map<generationId, { values, index,
ref, messageId }>` of a reply's alternatives (the extra samples of one request: `terminal.alternatives`,
  installed by `installReplyAlternatives` in `src/ts/process/serverGeneration.ts`); a swap is a
  `setMessageText`. `src/ts/process/rerollHistory.ts` `createRerollHistory` keeps per-screen bundles of
  removed replies, 16 chats by last use. Neither touches `scriptstate`; both are lost on reload, remount,
  and in every other tab (chat pipeline Known Hazards).
- **The server treats a reroll as a send with empty input.** `job.kind === "reroll"` appears in
  `server/src/jobs/generationJobs.ts` only to fire the auto checkpoint (`onChatJobDone`, line 1182);
  `INPUT_KINDS` in `server/src/prompt/runner.ts` and `server/src/routes/generations.ts` admit a
  `userMessageId` for it. `runPromptJob` loads the job scope, runs the input stage when there is input,
  then `runSpeaker` per speaker and round: setup, `assemblePrompt` (the `start` trigger inside), the
  request, the tail (`editoutput`, the `output` trigger, inlays, `chatOutput` listeners), the reply
  written as a new message with `generationInfo` (`writeReplyGenerationInfo`), and `done` with the last
  reply's id and that round's `alternatives` (streaming: `Object.values(stream.lastChunk)`; non-streaming:
  `mrerolls`). A continue instead locks an existing message (`op: "begin"` on `continueMessageId`) and
  streams into it: the in-place path this plan reuses.
- **How variables are written in a job.** Triggers write `chat.scriptstate` on the job's copy
  (`server/src/prompt/triggers.ts` around line 566) and `applyTriggerChat` (`server/src/jobs/chatResult.ts`)
  merges changed entries by key against the baseline; Lua's `setChatVar` queues one entry through the job's
  pending metadata write (`server/src/jobs/jobScope.ts` `createChatMetadata`: a `meta` op with
  `merge: { scriptstate }`); `/setvar` commands set the whole map (`server/src/prompt/commands.ts` line
  286). The tab's `setChatVar` (`src/ts/parser/chatVar.svelte.ts`) merges one entry with `mergeChatMeta`.
  `CHAT_META_MERGE_KEYS` (`shared/chats.ts`) lists `scriptstate`, so `merge`/`mergeUnset` act per entry on
  the stored map. The display transform keys its cache by a metadata digest that includes `scriptstate`
  (`server/src/prompt/transform.ts`), so a restore re-renders.
- **Message schema and storage.** `Message` (`shared/database.ts` line 1311): `role`, `data`, `saying`,
  `chatId`, `time`, `generationInfo`, `promptInfo`, `name`, `disabled`, `isComment`, `translation`. A
  message is one `messages` row whose `data` column is its JSON, beside the generation columns
  (`generationId`, `generationSeq`, `generationFinal`, `generationHistory`, the last keeping 8 earlier
  generation ids: `MAX_GENERATION_HISTORY`, `server/src/data/chatStore.ts`). `normalizeMessage`
  (`server/src/data/chats.ts` line 142) checks role, `data`, `chatId`, and drops an invalid `translation`
  without refusing the message; there is no field whitelist, so an unknown field is stored as sent
  (persistence D2: default at the readers). The `patchMessage` op sets or unsets named fields of the stored
  row (`shared/chats.ts` line 82; the client's `patchMessage`, `src/ts/storage/chatStore.svelte.ts` line
  3317). Rows travel whole on the job's `chatPatch` and on the live-update feed (`MAX_FEED_PATCH_BYTES` 64
  KiB, else a delta or a whole read).
- **Memory input.** The structured writer's windows stop before the last eligible user message
  (`writerCeiling`, `server/src/prompt/memory/structured/window.ts`): "the newest reply and one being
  generated or continued stay out; swipe candidates are not stored messages at all". `handOffMemory`
  (`runner.ts` line 643) runs for every `INPUT_KINDS` job, a reroll included. HypaV3 and SupaMemory
  summarize the oldest eligible messages inside the next send's assembly. A press on a message ("record
  now") confirms it `inclusive`, newest reply included.
- **Export and import.** `buildUpstreamDatabase` (`server/src/data/upstream/exportDatabase.ts`) strips
  `METATRON_CHAT_FIELDS` and each message's `translation` (reported as `message-translations`), and refuses
  nothing; `convertMessages` in `importCharacters.ts` runs `normalizeMessage`. Upstream RisuAI has no swipe
  field at all (`/home/codex/Risuai/src/ts/storage/database.svelte.ts` has only the `swipe` UI flag).
  PocketRisu and RisuBard store `swipes?: string[]` and `swipeId?: number` on the message
  (`/home/codex/PocketRisu/src/ts/storage/database.svelte.ts` line 2398), RisuBard adding
  `scriptstateCheckpoint` and `scriptstateSwipeCheckpoints`. RisuNest's `responseVariants { groupId,
selectedId, candidates: [{ id, messages[] }] }` is its own shape, and it converts PocketRisu's `swipes`
  into it on import (`/home/codex/RisuNest/src/ts/drive/pocketRisuFeatures.ts`). So the research README's
  "match PocketRisu's `responseVariants`" names a field PocketRisu does not have.
- **UI.** `Chat.svelte`'s `rerolls` snippet (line 1783) shows ← and → when `settings.ui.swipe` is on
  (else one regenerate icon), disabled while the message is `locked`; `Chats.svelte` mounts every row with
  `rerollIcon: "dynamic"` and the screen's `onReroll`/`unReroll`; the greeting row has a page counter
  (`showFirstMessagePages`). No e2e spec covers the reroll controls; `e2e/perChatSends.spec.ts` has the
  local mock provider pattern.

## Decisions

- **D1. The carrier message keeps its id; a reroll regenerates it in place.** The newest reply (the last
  message of the chat after trailing comments, role `char`, the only reply after the last user message)
  is the carrier of its candidates. A reroll of it is a `reroll` job whose context carries
  `rerollMessageId`; the job locks the carrier with `op: "begin"` as a continue does, and streams the new
  text into it. The client removes nothing and `restoreRerolledReplies` is not involved. Rejected: today's
  removal plus a new message per reroll (each reroll changes the reply's id, so bookmarks, memory receipts,
  stored translations, the generation history, and by-id ops of other tabs all point at a gone message, and
  the interrupted-reroll problem is exactly the removal); RisuNest's candidate-as-message-list
  (`responseVariants`), which replaces message rows on every switch for the same reason. A tail of several
  replies (a group chat's turn, a resend round) keeps today's path: removal, bundle history, no candidates
  (**Later**).
- **D2. The persisted shape is metatron's own.** On the carrier:

  ```ts
  candidates?: MessageCandidate[]; // 2 or more entries, else absent
  selected?: number; // index into candidates; absent means 0
  scriptstateCheckpoint?: { before: ScriptstateSnapshot; after: ScriptstateSnapshot }; // latest reply only
  type MessageCandidate = {
      data: string;
      generationInfo?: MessageGenerationInfo;
      translation?: MessageTranslation;
      scriptstateAfter?: ScriptstateSnapshot; // latest reply only; absent: switching changes no variable
  };
  type ScriptstateSnapshot = Chat["scriptstate"] | null; // null: the chat had no map
  ```

  The invariant every reader relies on: the carrier's own `data`, `generationInfo` and `translation` are
  always the selected candidate's, so prompt assembly, memory, search, translation, export, and older tabs
  read the selected reply without knowing about candidates. `candidates[selected]` is a copy of those
  fields, refreshed when the user switches away (an edit made meanwhile is what switching back brings, as
  `prereroll.ts` does today). Rejected: PocketRisu's `swipes: string[]` plus `swipeId` (text only: no
  `generationInfo`, no translation, no variable state, and the research README's interchange question is
  answered by D11 instead); RisuNest's `responseVariants` (whole message snapshots, see D1). Field names
  and the checkpoint shape follow RisuBard's `scriptstateCheckpoint { before, after }` so a RisuBard
  backup's checkpoint converts one to one (D11).

- **D3. The shared type, the normalizer, the ownership.** `shared/database.ts` gains the types above;
  `shared/rerollCandidates.ts` (pure, T2 rules) holds the helpers both runtimes use: `candidateOf`,
  `withCandidate` (the refresh of `candidates[selected]`), `scriptstateRestorePatch` (D5), and the caps.
  `normalizeMessage` keeps a well-formed `candidates` (an array of at least two plain objects with string
  `data`, optional valid `generationInfo`, `translation`, and snapshot) with `selected` in range, and
  otherwise drops `candidates`, `selected`, and `scriptstateCheckpoint` from its copy, as it drops an
  invalid translation: never a refusal, so an imported or old chat keeps its messages. Messages are chat
  data, not a section, so `shared/sections.ts` is unchanged (persistence D2: stored as sent, defaults at the
  readers), and chats with no field need no migration: absent means one candidate, no checkpoint.
  `CHECKPOINT_CHAT_FIELDS` is unchanged too: named checkpoints capture message rows whole, so candidates
  travel with them. Rejected: a separate `messageCandidates` table (every reader of a message would need a
  join; the fields are small and bounded by D4).
- **D4. Size bounds.** `MAX_MESSAGE_CANDIDATES = 16`: when a reroll would add a seventeenth, the oldest
  candidate that is not selected is dropped, and the job sends one `alertToast`
  (`rerollCandidateDropped`) the first time in a job. `MAX_CANDIDATE_BYTES = 256 KiB` of a candidate's JSON:
  a previous reply over it is not kept as a candidate (toast `rerollCandidateTooLarge`), the reroll runs.
  `MAX_SCRIPTSTATE_SNAPSHOT_BYTES = 64 KiB` per snapshot: over it, no checkpoint is written and the job's
  restore does nothing (toast `scriptstateCheckpointSkipped`), so a chat whose variables hold large text
  loses the restore, not the reroll. The normalizer applies the same caps to a stored row (a row over them
  loses the offending field, never the message). Inlays: a candidate's text keeps its `{{inlay::id}}` and
  `{{inlayed::id}}` references, so an inlay is reachable from a non-selected candidate; the Asset Lifecycle
  plan's mark phase must scan `candidates[].data` beside `data`, and the upstream export's "inlays are not
  exported" check (`INLAY_REFERENCE` in `exportDatabase.ts`) counts only the selected text, since
  candidates are stripped (D11). Rejected: no cap (RisuBard grew chats by tens of MB with two full
  snapshots per message; metatron would also push rows past `MAX_FEED_PATCH_BYTES`, turning every job
  patch into a whole read); a cap on total bytes per chat (it would make the newest reroll fail for an old
  chat's sake).
- **D5. Where `before` is taken, and the per-key restore.** `before` is the chat's `scriptstate` as stored
  when the response's generation starts: for a send, after the input stage (the user message appended, the
  `input` trigger and `editinput` run), before `runSpeaker`'s setup and `start` trigger; for a reroll, the
  carrier's stored `scriptstateCheckpoint.before` stands (the user turn's effects stay, the discarded
  reply's go; the reroll job runs no input stage); for a continue, the continued message's `before` stands
  (RisuBard's `selectResponseScriptstateBefore`). `after` is the `scriptstate` as stored when the job's
  last round for that reply has flushed its metadata (`flushChatMetadata`), written together with the
  reply's final `generationInfo`. The restore at a reroll's start is **per key**: for every key of
  `before ∪ after`, when the stored value equals `after`'s (the response set it and nothing changed it
  since) it becomes `before`'s (a `mergeUnset` when `before` lacks it); a key whose stored value differs
  from `after`'s was edited after the response (the tab's `setChatVar`, a Lua button, a `/setvar`) and is
  kept. One `meta` op with `merge` and `mergeUnset` before the `start` trigger, in the same group as the
  `begin` op of D7. Rejected: RisuBard's wholesale `chat.scriptstate = before` (it erases every variable
  written between the reply and the reroll, which on a server with Lua buttons and a second tab is an
  ordinary race, not a corner case); taking `before` at admission before the input stage (a reroll would
  then undo the input trigger's writes, which the reroll never re-runs).
- **D6. Checkpoints only on the latest reply.** The server owns the rule: the write that appends a new
  reply or a new user message (the input stage's append, a speaker's reply append, a trigger's insert
  through `applyTriggerChat`) unsets `scriptstateCheckpoint` and every `candidates[].scriptstateAfter` of
  every other message in the same group (one `patchMessage` per message that has them, found in the job's
  chat copy). Candidate texts stay (Q1). The client never restores a checkpoint of a message that is not
  the carrier, and the normalizer drops nothing for position (a stale copy on an older message is harmless
  data until the next job write removes it). Rejected: the client dropping older copies as RisuBard's
  `attachScriptstateCheckpoint` does (two tabs would race, and the server is where the append happens).
- **D7. The reroll job, step by step.** At admission the route validates `context.rerollMessageId` as it
  validates `continueMessageId`, only for `kind: "reroll"`; `requestFingerprint` includes it. The runner,
  for a reroll with the field: (1) refreshes the chat and checks the carrier is the newest reply as D1
  defines it, else ends with an `error` terminal whose reason is `rerollTargetMoved`; (2) in one group:
  `begin` on the carrier, `patchMessage` pushing the carrier's current `{ data, generationInfo, translation,
scriptstateAfter: checkpoint.after }` into `candidates` (refreshing `candidates[selected]` when it already
  has candidates, D2's rule; applying D4's cap) and setting `selected` to the new last slot whose `data`
  starts empty, and D5's restore `meta` op; (3) `runSpeaker` with the history **ending before the carrier**
  (the prompt, the lore matching, the memory step and the `start` trigger see the chat as if the reply were
  not there; `continueSend` false) and the generation streaming into the carrier as a continue does from
  an empty text; (4) the tail as today, then `after` captured and written with the final `generationInfo`,
  and `candidates[selected]` set to the new content. A reroll without `rerollMessageId` (an older tab, a
  multi-reply tail) runs today's path unchanged. The job's `done` keeps `messageId`; `alternatives` (D9)
  is no longer sent. Rejected: a new job kind (`reroll` already exists and already means this); the client
  pushing the old content into `candidates` before the create (a create that gets no answer would leave
  the chat changed, which is the uncertain-create class the chat pipeline guide spends a section on).
- **D8. Interrupted reroll.** A reroll job that ends without a completed reply (`error`, `stopped`,
  `aborted`, `timeout`, a tail failure before the final write) writes back, under the lock it still holds,
  the previous candidate: `candidates[previous]`'s `data`, `generationInfo`, `translation` onto the carrier,
  `selected = previous`, the new slot removed, and `scriptstate` restored per key from `before` to that
  candidate's `scriptstateAfter` (D5's rule in the other direction, RisuBard's failure path). The job ends
  with the same terminal; the tab's `restoreRerolledReplies` has nothing to do. A server process death
  mid-reroll leaves the carrier with the partial streamed text selected and the previous candidate one
  swipe away (the lock is memory-only and clears at restart); no boot sweep (**Later**). Rejected: keeping
  the partial text as a candidate of its own (a failed reroll's fragment is not something the user asked
  to keep; Stop today discards it too).
- **D9. The extra samples of one request become candidates.** When a request returns several texts (the
  streaming `lastChunk` map, the non-streaming `mrerolls`: upstream's "cached reroll"), the job writes them
  as `candidates` of the reply at its final write, the reply first and selected, the others text-only
  (no `generationInfo`, no `scriptstateAfter`: their triggers never ran, so switching to one changes no
  variable). `terminal.alternatives`, `installReplyAlternatives`, `addRerolls`, and `prereroll.ts` retire
  (V4 for every consumer, the chat pipeline guide's Sequence events bullet included). Rejected: keeping
  `alternatives` on the terminal beside the field (two sources for one list; an older tab between a deploy
  and its reload lacks only the swipe to an extra sample until it reloads).
- **D10. A candidate switch is an edit, made of by-id ops.** In the tab, `switchCandidate(ref, id, index)`
  in a new `src/ts/process/rerollCandidates.ts` refuses while the chat is busy or the carrier locked
  (`assertUnlocked`), refreshes `candidates[selected]` from the carrier's current fields, then queues in one
  coalesced group a `patchMessage` (`data`, `generationInfo`, `candidates`, `selected`; `unset` for an
  absent `generationInfo`), `setMessageTranslation` with the target's stored translation (taken only when
  its `sourceHash` still matches, as that function already checks; else cleared), and when the carrier is
  the newest reply and both candidates have a snapshot, `mergeChatMeta` of D5's per-key patch from the
  current candidate's `scriptstateAfter` to the target's (a candidate without one leaves variables as they
  are; a switch on an older message never touches variables). It runs no trigger, hook, or CBS, as a text
  edit does not; the display transform re-renders from the new revision. Structured memory sees it as an
  edit of a message: one no event cites, unless the user pressed "record now" on it, in which case the
  edit marks the event `rerecord` as any edit does (correct: the cited text changed). HypaV3 and SupaMemory
  read the carrier's `data` at the next send, which is the commit boundary: the candidate selected when
  the user sends the next message is the one memory ever reads; a discarded candidate is never memory
  input, since a reroll job's memory step reads the history without the carrier (D7) and the writer's
  ceiling keeps the newest reply out. Rejected: a server route or chat op `selectCandidate` (the chat
  module's ops already give atomicity within a group and apply on a stale revision while the message
  exists; a route would need its own lock check and feed entry).
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
- **D12. Multi-tab.** Candidates are chat data: a reroll's writes reach other tabs through the chat patch
  feed and the job's `chatPatch` as any message write does, and a switch reaches them as an edit. While a
  reroll runs, every tab sees the carrier locked (`streaming` entries) with the new text streaming in, its
  arrows disabled (`locked` in `Chat.svelte`, `assertUnlocked` in the module), and the previous reply
  already in `candidates`; a second tab that switches candidates while the first tab's switch is unsent
  loses by the usual `patchMessage` rule (last write wins per field, `stale: true` re-base). Rejected: a
  per-tab selected index (the selection is what memory and the prompt read, so it must be the chat's).

## Open questions

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

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slice 1 edits
`shared/jobs.ts`, `server/src/prompt/runner.ts`, and `server/src/jobs/jobScope.ts`: not in parallel with a
slice of the Job Handoff plan that touches `shared/jobs.ts` (its Slice 1).

### Slice 1: the schema, the normalizer, and the reroll job (D1–D9; needs nothing)

Files: `shared/database.ts` (the types), new `shared/rerollCandidates.ts` (helpers and caps),
`server/src/data/chats.ts` (`normalizeMessage`), `shared/jobs.ts` (`GenerationContext.rerollMessageId`,
`alternatives` removed from the done event and the sequence event), `server/src/routes/generations.ts`
(validation), `server/src/jobs/generationJobs.ts` (`requestFingerprint`, `keptTerminal` without
`alternatives`), `server/src/prompt/runner.ts` (the carrier check, the begin-and-push group, the history
without the carrier, the `before` and `after` snapshots, the final write with `candidates`, the write-back
on an end without a reply, the samples as candidates, the toasts), `server/src/jobs/jobScope.ts` (the
snapshot read beside `flushChatMetadata`), `server/src/jobs/chatResult.ts` (D6's unset in the group of an
insert), `src/lang/en.ts` and `ko.ts` (the three toasts: tab strings for server notices live there), the
server generation guide (Generation admission, Prompt job execution, a new "Reroll in place" flow,
Invariants), the persistence guide (Messages), the scripts and triggers guide (State: what a reroll does to
variables).

- Tests (`server/src/tests/promptRunner.test.ts`, `generationJobs.test.ts`, `chatStore.test.ts` for the
  normalizer, `chatResult.test.ts`, `memoryJobs.test.ts`, with the mock provider those files use): a reroll
  with `rerollMessageId` keeps the carrier's id, pushes the previous `data`, `generationInfo`, translation
  and `after` into `candidates`, streams into the carrier, and ends with `candidates[selected]` equal to the
  new reply; the prompt and the memory step of that job hold no carrier text; a variable the reply set is
  back to `before` when the `start` trigger reads it, and a variable set after the reply by a `meta`
  merge is kept (D5); a reroll whose carrier is no longer the newest reply ends `rerollTargetMoved`; a
  stopped reroll leaves the previous candidate selected with its text, `generationInfo`, and variables
  (D8); a send's reply append unsets the older reply's checkpoint and its candidates' `scriptstateAfter`
  and keeps their texts (D6); a request with three samples writes three candidates with the reply selected
  and no `alternatives` on `done` (D9); the seventeenth candidate drops the oldest non-selected one with
  one toast, an oversized previous reply is not kept, and an oversized snapshot writes no checkpoint (D4);
  `normalizeMessage` drops a malformed `candidates`, an out-of-range `selected`, or a non-map snapshot and
  keeps the message; the fingerprint differs by `rerollMessageId`; a reroll without the field runs as
  today.

### Slice 2: the tab's candidate controls (D10, D12; needs 1)

Files: new `src/ts/process/rerollCandidates.ts` (`switchCandidate`, the carrier check, the busy and lock
refusals), `src/lib/ChatScreens/DefaultChatScreen.svelte` (`reroll`: a next candidate, else a reroll job
with `rerollMessageId` when the tail is one reply, else today's removal path; `unReroll`: the previous
candidate, else the bundle history), `src/lib/ChatScreens/Chat.svelte` (the counter of Q4 in the `rerolls`
snippet, `candidateCount` and `candidateIndex` props), `src/lib/ChatScreens/Chats.svelte` (the two props
per row), `src/ts/process/serverGeneration.ts` (`rerollMessageId` through `ServerSendArg`; no
`installReplyAlternatives`), `src/ts/process/serverCommands.ts` (the sequence event without
`alternatives`), `src/ts/process/prereroll.ts` deleted (V4), `src/lang/en.ts` and `ko.ts`, the chat
pipeline guide (Reroll modules, Reroll, Sequence events, Known Hazards: the in-memory-only hazard narrows to
multi-reply tails), the chat store guide (a switch as by-id ops).

- Tests (`src/ts/process/rerollCandidates.test.ts`, `src/ts/process/serverGeneration.test.ts`,
  `src/lib/ChatScreens/Chat.controls.test.ts`, `src/ts/process/rerollHistory.test.ts` unchanged): a switch
  queues one group with the `patchMessage`, the translation set or cleared, and the per-key `scriptstate`
  merge, and refreshes the candidate it leaves from an edited text; a switch on a locked carrier or a busy
  chat throws and queues nothing; a switch on a message that is not the newest reply changes no variable;
  a candidate without a snapshot leaves variables as they are; `reroll` with `selected` at the last
  candidate creates a job with `rerollMessageId` for a one-reply tail and runs the removal path for a
  two-reply tail; the counter shows `2/3` and hides for one candidate; a mirror with `candidates` from a
  read (another tab's reroll) shows the arrows active.

### Slice 3: the memory commit boundary and the export mapping (D10, D11; needs 1)

Files: `server/src/prompt/memory/structured/window.ts` (the comment: candidates are stored but never
messages of their own; no behavior change expected, the test proves it), `server/src/data/upstream/exportDatabase.ts`
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

- Spec cases, one dev stack: a send, two rerolls, a reload shows `3/3` and ← twice shows the first reply;
  a second browser context sees the same count without a reload; a reroll stopped mid-stream leaves the
  previous reply selected; a trigger that sets a variable on each reply shows the first reply's value after
  swiping back (read through `{{getvar}}` in a comment message); the removal path still runs for a group
  chat's turn.
- Device checks (the phone's swipe on the owner's server) go to the user as a checklist and are reported
  as not run (V5).

## Recommended order

1 → 2 → 3 → 4. After Slice 1 nothing a tab sees differs except that the swipe to an extra sample is gone
until Slice 2 (no tab sends `rerollMessageId` yet, so every reroll runs today's path); 1 and 2 together give
the persisted candidates and the variable restore the owner asked for; 3 settles the export and the memory
proofs; 4 is the browser proof.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every removed export (`addRerolls`,
  `Prereroll`, `PreUnreroll`, `installReplyAlternatives`, `terminal.alternatives`) and the deleted
  `prereroll.ts`.
- Focused: `pnpm --silent test:agent server/src/tests/promptRunner.test.ts server/src/tests/generationJobs.test.ts
server/src/tests/chatStore.test.ts server/src/tests/chatResult.test.ts server/src/tests/memoryJobs.test.ts`
  for the server; `pnpm --silent test:agent src/ts/process/rerollCandidates.test.ts
src/ts/process/serverGeneration.test.ts src/lib/ChatScreens/Chat.controls.test.ts` for the tab;
  `pnpm --silent test:agent server/src/tests/upstreamExport.test.ts server/src/tests/upstreamImportCharacters.test.ts`
  for the export (file names as the slices create them).
- `e2e`: `e2e/perChatSends.spec.ts` after Slice 2 (the send path's argument changes) and
  `e2e/rerollCandidates.spec.ts` after Slice 4, one e2e run at a time.
- Not covered by any gate: the phone swipe on the owner's server, and a server process death mid-reroll
  (D8's partial text), which only a manual kill shows.

## Out of scope

- Candidates for a tail of several replies: group turns and resend rounds keep the removal path and the
  in-memory bundle history.
- Switching candidates on a message that is not the newest reply (the texts are kept, Q1).
- Deleting one candidate from the UI (PocketRisu's `deleteSwipe`), and the confirmation settings around it.
- Converting RisuNest's `responseVariants` on import.
- A per-message checkpoint on every message (the shape RisuBard fixed in 0.9.69).
- The asset mark phase for candidates' inlays: the Asset Lifecycle plan owns the scanner; this plan names
  the field it must read.

## Later

- A single-candidate delete control and the "refuse when full" answer of Q3 if the owner wants it.
- A boot sweep that writes back the previous candidate of a carrier whose generation never ended (D8's
  process-death case), if it shows up in practice.
- Bundle candidates for multi-reply tails, if group chats need swipes: the carrier would be the turn's
  last reply and a candidate a list of messages, which is RisuNest's shape and its id problem.
- PocketRisu-compatible `swipes` in the `.bin` export (Q2 reversed).
- Pruning older messages' candidates at the commit boundary (Q1 reversed).
