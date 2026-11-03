# Audit: docs/plan/reroll-candidates.md (at d31fa9a48)

No source under src/, server/, or shared/ changed between 8f0db0fb7 and d31fa9a48 (only docs/plan). The cited anchors still hold; the problems below are in the design.

## P1: design flaws

### 1. D7 step (2) opens the generation and then closes it in the same group

- Severity: P1. Plan: D7 lines 231-239 (step 2 "begin ... patchMessage pushing ...", step 4 "candidates[selected] set to the new content").
- Evidence: shared/chats.ts:76-77, `patchMessage` is "A manual write ... it closes an open generation fence". server/src/data/chatStore.ts:1940-1943: a non-generation op calls `closeFence`. chatStore.ts:1399-1408 (`admitGeneration`): once the fence is final, later generation writes come back `ignored`. runner.ts:1175-1204 (`finalize`): an ignored final write throws 409 "The reply was closed by another write before it was finished". A `begin` followed by a `patchMessage` on the carrier therefore kills every later checkpoint, and the reroll fails at its final write. The same happens to step 4 if `candidates[selected]` is written with a `patchMessage` before `finalize`.
- Correction: put the `patchMessage` (and the D5 `meta` op) before the `begin` in the group. A `begin` on an existing message needs the current revision, and `writeOwn` refreshes first, so this works. Every later write to the carrier must be a generation write; step 4's `candidates` and `after` belong in the final `setMessage` that `finalize` builds from the stored row (runner.ts:1189-1193). The group must also live inside `runSpeaker`, because `generationId` is created per call there (runner.ts:935) and the continue `begin` is there too (1210-1221).
- Confidence: verified.

### 2. D8's write-back "under the lock it still holds" happens after the lock is released

- Severity: P1. Plan: D8 lines 244-249.
- Evidence: generationJobs.ts:1314-1330 releases the message lock on any applied write with `generation.final` (`lock.release(ref, job.token, op.generation.id)`). runSpeaker writes that final write itself on abort or read failure (runner.ts:1730-1736 `finalize(stream.text, stream.seq)`) and in its `finally` for any generation still open, which covers thrown errors (runner.ts:2083-2089). By the time runSend learns the reroll ended without a reply, the carrier is unlocked. Another tab's edit or switch can land first, and a later write-back overwrites it. After an abort, writes are also bounded by `JOB_ABORT_GRACE_MS` 5000 (generationJobs.ts:66, 1226).
- Correction: for a reroll, the write-back must be the final generation write: in the abort branch and in the `finally`, `finalize` with a `setMessage` of the restored previous candidate, plus the per-key `meta` restore in the same group. State that past the abort grace the outcome equals the process-death case.
- Confidence: verified.

### 3. An output trigger that removes the carrier deletes every candidate

- Severity: P1 (replies lost). Plan: D8 lines 244-253, which does not list this outcome.
- Evidence: chatResult.ts:85-87 and 139-141 turn a trigger's removal into a `remove` op. runner.ts:1766-1771 then ends the turn `removed`. With D7, the removed message is the carrier, so all persisted candidates go with it. Today the old tail lives in `rerollHistory` and comes back when the chat ends at the anchor (rerollHistory.ts:197-254).
- Correction: add `removed` to D8. For a reroll, treat removal of the carrier as "no reply": re-append the carrier under its id with the previous candidate selected, or refuse the trigger's removal of the carrier. Add a Slice 1 test.
- Confidence: verified.

### 4. The non-streaming in-place write replaces the carrier row and erases the candidates

- Severity: P1. Plan: D7 step (3), lines 235-238 ("as a continue does").
- Evidence: runner.ts:1814-1832. When `generation` is set (`i === 0 && generation`), the reply is written as `setMessage` with a fresh object `{ role, data, saying, time, generationInfo, promptInfo, chatId }`. A `setMessage` replaces the whole row (shared/chats.ts:49-51; chatStore.ts:1947-1963). On a reroll this drops the `candidates`, `selected` and `scriptstateCheckpoint` that step (2) just wrote, and `name`, `disabled`, `isComment` too. Only the streaming path spreads the stored row (runner.ts:1192).
- Correction: D7 must name the non-streaming branch. It spreads the stored row and sets `data`, `generationInfo`, `promptInfo` and `time`, as `finalize` does.
- Confidence: verified.

### 5. D10's switch can erase a newer reroll from a tab with a stale copy

- Severity: P1 (reply lost). Plan: D10 lines 262-266 and 277-279 (the rejected server op); D12 lines 296-297.
- Evidence: `patchMessage` sets whole fields "also on a stale revision" (shared/chats.ts:72-77; STRUCTURE.md D4). The switch sends `candidates` and `data` built from the tab's copy, and refreshes `candidates[selected]` "from the carrier's current fields" as the tab holds them. Example: a tab (a phone resumed, a feed not yet applied) has not seen another tab's finished reroll R3. It switches and stores its old `candidates` (without R3) and old `data`. R3 is then gone from the row entirely. D12 covers only switch against switch.
- Correction: the switch must be conditional on the stored row. Either reopen the rejected server op (`selectCandidate { id, index, expect }`, applied to the stored candidates, refused when the row's generation or candidate count differs from what the tab saw), or require the chat's current revision for any write of `candidates` and reload on stale.
- Confidence: verified mechanism; the race is likely.

### 6. D4's caps allow rows far over `MAX_FEED_PATCH_BYTES`, which contradicts D4's own rejection argument

- Severity: P1. Plan: D4 lines 189-203, especially 200-202 ("metatron would also push rows past MAX_FEED_PATCH_BYTES"); Current state line 115.
- Evidence: chatStore.ts:1478-1530 (`chatFeedChange`). A row over 64 KiB yields neither `patch` nor `delta`, because `delta` only splits the metadata and rows always go whole. resource-sync.md:514 says this "costs up to one read per checkpoint" for every other tab. generationJobs.ts:577-603 (`diffChat`) always carries `generated` rows, so the owner's job `chatPatch` resends the whole carrier on every 3-second checkpoint. D4 allows 16 × 256 KiB of candidates plus snapshots of up to 64 KiB each, so roughly 4.5 MiB per row. Realistically, 16 candidates with `generationInfo.context` and a `scriptstateAfter` of a few KiB each already pass 64 KiB.
- Correction: add a per-message budget (for example, candidates plus checkpoint JSON at or under about 48 KiB). Enforce it by dropping the oldest non-selected candidate, then the non-selected `scriptstateAfter`. Strip `context` and `memory` from candidate `generationInfo` copies. Alternatively, depend explicitly on the Incremental Chat Transport plan's Slice 4 over-cap row manifest.
- Confidence: verified (code plus arithmetic).

### 7. A switch leaves `scriptstateCheckpoint.after` pointing at the wrong candidate, so the next reroll restores variables wrongly

- Severity: P1. Plan: D10 lines 264-269 (the patch omits the checkpoint); D5 lines 211-215; D7 lines 232-233 (`scriptstateAfter: checkpoint.after`).
- Evidence (plan logic, no code yet): before `{x:0}`. R1 sets x=1, R2 sets x=2, so `checkpoint.after` is `{x:2}`. A switch to R1 merges x to 1 but leaves `checkpoint.after` at `{x:2}`. The next reroll's step (2) stamps R1 with `scriptstateAfter {x:2}`. Its restore sees stored 1 ≠ after 2, treats x as "edited after the response", and keeps 1. The new reply's `start` trigger reads x=1 instead of 0.
- Correction: extend D2's invariant: `scriptstateCheckpoint.after` is always the selected candidate's (when that candidate has one). D10's patch sets it. Or drop `after` and read `candidates[selected].scriptstateAfter`.
- Confidence: verified against the plan's own rules.

## P2: contradictions and wrong claims that change the design

### 8. No tab ever creates a `reroll` job, so D7 and Slice 2 rest on a wrong premise, and group owners are not handled

- Severity: P2. Plan: Current state lines 78-79 ("sends with `kind: "reroll"`"), D7 lines 228-241, Slice 2 lines 359-364.
- Evidence: serverGeneration.ts:93-101 picks `preview | previewPrompt | group | continue | send`. DefaultChatScreen.svelte:644 calls `sendChatMain(false, ref)`. `rg '"reroll"'` finds the kind only in shared/jobs.ts:14, the two `INPUT_KINDS` and generationJobs.ts:1182. For a group, `sendPinned` returns `group` first. runSend then derives several speakers from the group order (runner.ts:487-507), so an in-place reroll on a group owner could run more than one speaker.
- Correction: fix Current state (the tab's reroll is a `send` or `group` job with empty input). Slice 2 adds the `reroll` kind to `sendPinned`. D7 says a reroll with `rerollMessageId` runs exactly one speaker, `speakerChaId = carrier.saying`, or else D1 excludes group owners outright.
- Confidence: verified.

### 9. D8 discards text that today is kept, and the plan's justification is wrong

- Severity: P2. Plan: D8 lines 244-245 and 252-253 ("Stop today discards it too").
- Evidence: runner.ts:1730-1736: on abort, "the final write carries the text so far". rerollHistory.ts:203-213: the old tail is restored only while the chat still ends at the anchor; with a partial reply present, the result is `none`. So today a stopped reroll keeps its partial reply. runner.ts:1750: "The completed raw text is stored before any hook runs: a failure in the tail keeps it". D8 would throw away a complete reply after a tail failure.
- Correction: on Stop and on a tail failure, keep the text as the new selected candidate (today's behavior). Write the previous candidate back only when no text was produced (an assembly stop, `rerollTargetMoved`, an error before the first chunk).
- Confidence: verified.

### 10. With `inlayErrorResponse`, D8 would erase the error message the user is meant to see

- Severity: P2. Plan: D8 lines 244-249 (`stopped`).
- Evidence: runner.ts:1018-1041 (`throwError`): the owned last reply gets the error appended (`lastMessage.data + suffix`) and the send returns `stop`, which becomes `done.stopped` (shared/jobs.ts:313-318: "an error written into the chat"). On a reroll that message is the carrier, so D8's write-back on `stopped` erases the error.
- Correction: state what happens. Either write back and send the error as an `alertError` notice, or keep the error text as the selected candidate.
- Confidence: verified.

### 11. D3's "2 or more entries" conflicts with D8's slot removal, and D3's drop rule takes checkpoints with it

- Severity: P2. Plan: line 155; D3 lines 180-182; D8 line 247.
- Evidence: a first reroll creates `[old, new]`. If it fails, D8 removes the new slot and leaves one entry. D3's normalizer then drops `candidates`, `selected` and `scriptstateCheckpoint` together (the normalizer runs on `patchMessage` and `setMessage`: chatStore.ts:1977 and 639). Read literally, D3's "otherwise" also drops the checkpoint of every reply without `candidates`, which is the normal single-reply state that D5 and D6 rely on.
- Correction: D8 unsets `candidates` and `selected` when only one entry remains. D3 validates `scriptstateCheckpoint` on its own shape, independently of `candidates`.
- Confidence: verified (plan text plus normalizer call sites).

### 12. D5's "written together with the reply's final generationInfo" misses some paths

- Severity: P2. Plan: D5 lines 209-211.
- Evidence: `writeReplyGenerationInfo` writes only when the stored reply already has `generationInfo` (runner.ts:1657-1671). The emotion view mode finalizes before it ("these modes end the send before its last generation-info write", runner.ts:2044-2046). In both cases `after` would never be written.
- Correction: write `after` (and `candidates[selected]`) in `finalize`'s final write, which every completed path calls.
- Confidence: verified.

### 13. "History ending before the carrier" has no mechanism in the runner

- Severity: P2. Plan: D7 lines 235-238; D10 lines 275-276.
- Evidence: every reader takes the whole chat. Assembly reads `chatNow()` (runner.ts:1373). The memory `readSource` returns `chat.message` (1322-1339). `runCurrentChatFunction` loops over every message (1244-1270). The `start` trigger runs `runOnCopy` on a whole-chat copy, and `applyTriggerChat` diffs that copy against a baseline: a message missing from the copy but present in the baseline becomes a `remove` (chatResult.ts:85-87). Hiding the carrier needs both baseline and copy filtered, and a decision on where a trigger's appended message lands (before the carrier?). Only the writer part is already sound: `writerCeiling` stops at the last user message (window.ts:88-103).
- Correction: name one choke point (for example, a speaker-run view of the scope's chat without the carrier) and its trigger semantics, and test a `start` trigger that appends.
- Confidence: verified (readers); the mechanism is unspecified.

### 14. The carrier keeps a stale `promptInfo`, and candidates carry and restore stale memory receipts

- Severity: P2. Plan: D2 lines 158-163; D7 steps (2)-(4).
- Evidence: the in-place path writes neither `generationInfo` nor `promptInfo` at the start. The append path sets both (runner.ts:1683-1696); the continue path keeps the stored row (1675-1680). `MessageCandidate` has no `promptInfo`, so every candidate shows the first reply's `promptInfo.promptText`. A carrier without `generationInfo` (an imported reply) gets none, because of the 1659 guard. `generationInfo.memory` is the writer's receipt, written by `patchMessage` (memory/structured/writer.ts:425-432). D10's switch replaces `generationInfo` whole with the candidate's copy, so it carries and restores stale receipts.
- Correction: the final write sets the new assembly's `generationInfo` and `promptInfo` regardless of the stored ones. Decide whether candidates keep `promptInfo` or the field is unset on the push. Strip `memory` from candidate copies and keep the carrier's own receipt across a switch.
- Confidence: verified.

### 15. D10 contradicts Q1 and Out of scope on switching an older message

- Severity: P2. Plan: D10 lines 268-270 ("a switch on an older message never touches variables"); Slice 2 test line 373; Q1 lines 304-305 ("switchable only while the message is the newest reply"); Out of scope line 443.
- Correction: pick one. If older messages are not switchable, D10 refuses a non-newest carrier and the Slice 2 test changes.
- Confidence: verified.

### 16. Slice 1 cannot pass `pnpm check` alone

- Severity: P2. Plan: Slice 1 lines 328-329 (removes `alternatives` from the done and sequence events) versus Slice 2 lines 363-365; Recommended order lines 417-418.
- Evidence: the tab reads `terminal.alternatives` (serverGeneration.ts:156-157) and `event.alternatives` (serverCommands.ts:622-623). Both change only in Slice 2.
- Correction: move the tab consumers (`installReplyAlternatives`, the sequence handler, `addRerolls`) into Slice 1, or keep `alternatives` optional on the type until Slice 2.
- Confidence: verified.

### 17. An older or un-reloaded tab's reroll deletes persisted candidates

- Severity: P2. Plan: D7 lines 239-240 ("runs today's path unchanged"); Recommended order line 417 ("nothing a tab sees differs").
- Evidence: today's path removes the carrier (DefaultChatScreen.svelte:641-643 `editChatSync` filter). After Slice 1, D9 writes `candidates` on multi-sample replies, and after Slice 2 on every reroll. An old tab's reroll deletes them, keeping them only in that tab's in-memory bundle.
- Correction: state the loss and accept it, or have Slice 1's server refuse to append over a carrier with candidates. Do not claim nothing differs.
- Confidence: verified.

### 18. D3's silent drop on live writes turns a client bug into data loss

- Severity: P2. Plan: D3 lines 180-183.
- Evidence: `patchMessage` and `setMessage` both run `normalizeMessage` (chatStore.ts:1966-1977 and 639). A malformed or over-cap `candidates` in a tab's switch would silently delete all candidates and the checkpoint, never refusing.
- Correction: refuse (`ResourceValidationError`) a malformed `candidates` on op writes. Keep the drop-don't-refuse rule for import, whole-chat create or replace, and stored-row reads.
- Confidence: verified (code path); the impact is a judgment call.

## P3: stale or wrong anchors and claims

### 19. D8's terminal list and D7's new error reason do not match the wire contract

- Plan: D7 line 231, D8 lines 244-245.
- Evidence: the reasons are `failed | aborted | shutdown | maintenance | timeout` (shared/jobs.ts:175), and `stopped` is `done.stopped`, not an error. A `rerollTargetMoved` reason is outside the closed set that diagnostics check (shared/diagnostics.ts:551, server/src/diagnostics/log.ts:90, src/ts/diagnostics/jobDebugInfo.ts:47).
- Correction: use `failed` with a message, or extend the set and its diagnostics. List `shutdown` and `maintenance`.
- Confidence: verified.

### 20. There is no kind restriction on `continueMessageId` to copy

- Plan: D7 lines 228-229 ("validates ... as it validates continueMessageId, only for kind reroll").
- Evidence: routes/generations.ts:171-175 accepts `continueMessageId` for every kind. The kind-restricted model is `userMessageId` (176-179).
- Confidence: verified.

### 21. A carrier without a checkpoint is undefined

- Plan: D5 lines 207-208. Every reply written before Slice 1, and every reply whose snapshot D4 skipped, has no stored `before`, yet the reroll ends by writing a checkpoint.
- Correction: say that `before` is taken at the reroll's start (after step 2) when none is stored.
- Confidence: verified against the plan.

### 22. The normalizer tests live elsewhere

- Plan: line 340 ("chatStore.test.ts for the normalizer").
- Evidence: `normalizeMessage` is tested in server/src/tests/chats.test.ts. All the other named test files exist.

### 23. The inlay scan needs a third form

- Plan: D4 lines 196-198. `INLAY_REFERENCE` also matches `{{inlayeddata::` (exportDatabase.ts:227), so the asset scanner must scan that form in `candidates[].data` too.

### 24. Missing cross-plan ordering

- Plan: lines 321-323. docs/plan/incremental-chat-transport.md:35-39 says its Slices 2 and 3 are not run in parallel with Reroll Candidates Slice 1. The reroll plan names only Job Handoff.

## Checked and found sound

- The cited anchors still hold at d31fa9a48: `INPUT_KINDS` (runner.ts:245, routes/generations.ts:134), `job.kind === "reroll"` only at generationJobs.ts:1182, `handOffMemory` at runner.ts:643 runs for input kinds, `normalizeMessage` at chats.ts:142 (checks role, data and chatId, drops a bad translation, no field whitelist), `patchMessage` at shared/chats.ts:82 and chatStore.svelte.ts:3317, `Message` at shared/database.ts:1311, `Chat.svelte` `rerolls` at 1783 with `locked`, `Chats.svelte` `rerollIcon: "dynamic"`, PocketRisu `swipes` at database.svelte.ts:2398, RisuBard's `{before, after}` and `scriptstateSwipeCheckpoints` shape, upstream Risuai has only the `swipe` UI flag.
- A continue locks an existing message with `op: "begin"` and streams into it with prefix = stored text (runner.ts:1210-1221 and 1675-1680), so streaming from an empty text works if step (2) sets `data` to "".
- `applyTriggerChat` merges `scriptstate` per key against a baseline (chatResult.ts:189-224). A `meta` op with `merge` and `mergeUnset` on `scriptstate` is expressible (shared/chats.ts:18 and 56-66). Lua `setChatVar` queues `merge: { scriptstate }` through the pending write (jobScope.ts:473-560; lua/bindings.ts:495). `/setvar` sets the whole map (commands.ts:286-288).
- Every write that can set `candidates` passes `normalizeMessage`: append and `setMessage` via `prepareMessage` (chatStore.ts:639, 852-857), `patchMessage` after the merge (1977), create and replace via `normalizeMessageList`. `setText`, `begin` and `setTranslation` cannot set it.
- The job scope's chat copy is the whole chat (`readChatSource` in loadJobScope and refreshChat), so D6's per-message unsets can find every message.
- The client's `setMessageTranslation` checks `sourceHash` against the mirror's current text (chatStore.svelte.ts:3374), and the server's `setTranslation` does too (chatStore.ts:2046-2052). Unsent ops of one chat coalesce and go in one group.
- The display transform's cache key includes a metadata digest with `scriptstate` and the chat revision (transform.ts:201-213).
- `writerCeiling` (window.ts:88-103) stops before the last eligible user message, so the writer never cites the carrier during a reroll even without filtering.
- Every named test file, the e2e spec, util/agentE2e.mjs and the sibling checkouts exist.
