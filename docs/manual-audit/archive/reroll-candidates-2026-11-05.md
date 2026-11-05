# Reroll Candidates implementation audit — 2026-11-05

## Scope and result

Audited `dev` at `65e97f91f22418df49452e76e46af7a145b144f1`. The retired plan was recovered with:

```sh
git show cc1fc4008218b94beb7ed857f37af0fabbe071c4^:docs/plan/reroll-candidates.md
```

The implementation commits are `30bec41a4`, `4976a15f0`, `080ea1184`, and `807b980de`; the
[archive](../../archived-plan/README.md) records their integration. This audit covers the current implementation,
including its interactions with incremental chat transport, rather than re-reporting defects in the earlier
[plan design](../plan-design-audit-2026-11-04/reroll-candidates.md).

Two Luna exploration agents and four focused audit agents checked generation/script views, storage and
transactions, client synchronization and controls, and interchange/memory. Findings were consolidated against
current source and the plan's explicit decisions. No product code was changed. Temporary probes used production
stores/bindings or the existing test harness and were removed from the checkout.

**The highest-priority defect is inconsistent Lua indexing during reroll assembly: a script can read one message
and edit or remove a different one.** Other confirmed defects concern the writing tab missing checkpoint cleanup
and abandoned generation fences preventing later cleanup. The largest improvement opportunities are avoiding
history-wide SQL/JSON scans and repeated history copies. Existing incremental transport works in the covered
reroll scenarios; the traffic finding below concerns an additional unnecessary full-chat refresh.

P1 means a reproducible wrong-target/data-loss risk; P2 means a functional defect or a material scaling problem;
P3 means a narrower defect or smaller optimization. Performance measurements below use synthetic fixtures and are
illustrative, not production latency estimates or test thresholds.

| ID  | Priority | Kind                  | Finding                                                                      |
| --- | -------- | --------------------- | ---------------------------------------------------------------------------- |
| RC1 | P1       | Bug                   | Lua reads and writes use different message indexes during rerolls            |
| RC2 | P2       | Bug                   | An acknowledged append leaves the writing tab's candidate state stale        |
| RC3 | P2       | Bug                   | Abandoned generation fences prevent subsequent checkpoint cleanup            |
| RC4 | P3       | Bug                   | Import warnings miss unavailable inlays in alternate candidates              |
| RC5 | P2       | Performance           | Carrier validation and checkpoint cleanup scan historical candidate payloads |
| RC6 | P2       | Performance           | Repeated Lua history reads become quadratic during reroll assembly           |
| RC7 | P2       | Performance           | Importing a long swipe history repeatedly shifts almost the entire array     |
| RC8 | P3       | Traffic               | Unchanged candidate fields on a whole-row edit force a full-chat refresh     |
| RC9 | P3       | Performance           | Variable provenance work runs even without an active reroll                  |
| U1  | P2       | Unrelated bug         | Saving prompt text invokes mutable `editRequest` handlers twice              |
| U2  | P2       | Unrelated bug         | Updating only `isComment` leaves an already-mounted row stale                |
| U3  | P2       | Unrelated performance | A trigger stage with no triggers still deep-copies the entire chat twice     |

## Bugs in the plan's implementation

### RC1 — Lua reads and writes address different messages during a reroll

**Evidence:** [jobScope.ts](../../../server/src/jobs/jobScope.ts), lines 455–459;
[bindings.ts](../../../server/src/lua/bindings.ts), lines 375–379, 418–430, 1285–1307, 1330–1356;
[scripts.ts](../../../server/src/prompt/scripts.ts), lines 86–100;
[runner.ts](../../../server/src/prompt/runner.ts), lines 1744–1756.

During assembly, `scopeHistoryChat` hides the carrier. Lua getters use this view through `engineChat`, but setters
outside a trigger working copy resolve indexes through `writeChat` against the unfiltered stored chat. The
`editRequest` Lua hook runs in exactly this configuration: no working copy, with the history view still active.
Its safe host access permits chat setters; the view is cleared only after assembly returns.

Reproduction using production Lua bindings, a real in-memory resource store, and the carrier's live lock:

1. Store `[u, r, c1, c2]`, with `r` the reply being rerolled and `c1`/`c2` trailing comments.
2. During `editRequest`, `getChatData(2)` returns `c2` because the visible history is `[u, c1, c2]`.
3. `setChat(2, "EDITED INDEX 2")` changes stored `c1`; `c2` remains unchanged.
4. The same address mismatch exists in `removeChat`, `setChatRole`, `cutChat`, and insertion-position handling.
   Targeting the hidden carrier itself instead encounters the lock and silently skips the intended write.

The write reproduction confirmed the wrong comment was modified. The removal consequence follows the identical
raw-index lookup in `removeChat`. This violates D7's shared history-view contract and can lose unrelated messages.

**Correction:** resolve script indexes against the same view used by getters, then write by stable message ID.
Define insertion/range behavior around the hidden carrier consistently with the existing trigger-diff anchoring.
Add an integration case with two trailing comments and an `editRequest` read followed by write/removal.

### RC2 — Append acknowledgements omit implicit checkpoint cleanup from the writing tab

**Evidence:** [server chatStore.ts](../../../server/src/data/chatStore.ts), lines 2257–2273;
[client chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts), lines 3556–3559, 5691–5704,
5764–5771, 5791–5803, and 6866–6867.

The server now removes older checkpoints and candidate snapshots when a non-comment message is appended, bumping
affected `candidatesRevision` values. The client's optimistic append only inserts the new row. Its acknowledgement
advances the held chat revision without installing those other row changes or marking the chat stale:
`writesCandidateFields` checks only the appended messages. If the feed echo follows that acknowledgement, its equal
revision is ignored.

A probe using the real SQLite-backed save adapter reproduced this ordering:

1. Start with a reply having two candidates, a checkpoint, and candidate revision 1.
2. Append a user message, flush, then deliver the feed notice for the acknowledged revision.
3. Server: no old snapshots, candidate revision 2. Client: old snapshots, revision 1, `isChatBehind === false`.
4. Delete the newly appended user message and switch to the earlier candidate. The first switch is refused for its
   stale expectation and refreshes back to the unchanged selection; the second identical switch succeeds.
5. Separately, writing the retained old reply back as a whole row resurrects the checkpoint the server had removed.

The initial mirror-equality assertion failed; subsequent probes confirmed both the failed first switch and snapshot
resurrection. This is an own-write synchronization defect, independent of the intentional refusal of two genuinely
competing switches.

**Correction:** carry/apply implicit affected-row changes in acknowledgements, or schedule precise reads for the
cleaned rows. Optimistic pruning alone must account for live-lock exemptions and server-owned revision increments.
Cover acknowledgement-before-feed ordering, not just remote observer updates.

### RC3 — An abandoned generation's snapshots survive later appends

**Evidence:** [chatStore.ts](../../../server/src/data/chatStore.ts), lines 1407–1410 and 2257–2273.

`selectCheckpointRows` excludes rows with a persisted open generation fence, before the later live-lock check can
inspect them. A process loss or abort-grace expiry can leave `generationFinal = 0` after the job's live lock has
ended. Every later append continues excluding that row, so its checkpoint and per-candidate snapshots remain on an
older message indefinitely unless another operation closes its fence.

The native-store probe began a generation on a checkpointed candidate reply, ended its guard ownership without a
final write, and appended a user message. It returned:

```json
{
  "liveOwner": null,
  "checkpoint": { "before": { "$x": "0" }, "after": { "$x": "2" } },
  "candidateSnapshots": [{ "$x": "1" }, { "$x": "2" }]
}
```

As a control, a same-text manual write closed the fence; the following append removed all those snapshots.

This is distinct from the explicitly deferred boot-time rollback. Even accepting partial text after process loss,
D6 requires an ordinary subsequent append to retire older variable checkpoints. Stale copies also enlarge chats,
backups, and reads.

**Correction:** skip genuinely active carriers using live ownership, including the existing guard check, rather
than treating every persisted open fence as an active job. Preserve the protection for a begin occurring later in
the same transaction. Test cleanup after ownership ends without finalization.

### RC4 — The import report misses unavailable inlays in retained candidates

**Evidence:** [importCharacters.ts](../../../server/src/data/upstream/importCharacters.ts), lines 523–525 and 684–698.

The new swipe converter preserves alternate text, but the missing-inlay report still scans only `message.data`.
Passing this assistant message through `convertUpstreamDatabase` preserves both candidates while producing no
`inlays-not-in-backup` entry:

```json
{
  "role": "char",
  "data": "Selected text",
  "swipes": ["Selected text", "{{inlay::missing-picture}}"],
  "swipeId": 0
}
```

Switching later exposes an unavailable image that the import report did not disclose. The conversion and absent
warning were reproduced with the production importer. This does not imply that upstream backups contain the image
bytes; their absence is precisely what the existing warning reports.

**Correction:** scan retained `candidates[].data` as well as the carrier text, preserving the once-per-chat report
count. Export may continue scanning only selected text because its candidate fields are deliberately stripped.

## Performance and traffic improvements in the plan's implementation

### RC5 — Tail checks and append cleanup parse retained history on every operation

**Evidence:** [chatStore.ts](../../../server/src/data/chatStore.ts), lines 1348–1351, 1407–1410, 2259, and 2410–2415.

The carrier predicate needs the last two non-comment messages, but `selectCarrierMessages.all` extracts role and
comment fields from every message JSON. Append cleanup similarly scans the chat and traverses each historical
candidate array with correlated `json_tree`, even after all older snapshots have already been removed. Q1 retains
those candidate texts, so the JSON payload being inspected grows throughout a chat's lifetime.

A native SQLite fixture with 1,000 messages, including 500 historical candidate lists of 180 KiB each, measured:

| Operation                                          | Rows returned | Local mean, five runs |
| -------------------------------------------------- | ------------- | --------------------- |
| Current carrier query                              | 1,000         | 43.9 ms               |
| Descending last-two-non-comment query              | 2             | 0.075 ms              |
| Current checkpoint cleanup query, nothing to clean | 0             | 75.3 ms               |

`EXPLAIN QUERY PLAN` showed the chat-wide position-index scan and the cleanup query's correlated JSON traversal.
These synchronous operations occupy the server thread; returning few rows does not bound JSON parsing work.

**Improvement:** query backward and stop after two eligible rows for carrier validation. Maintain/index a small
checkpoint-presence projection for cleanup, with transactionally correct updates on message writes, import, and
restore. Do not solve this by silently pruning the candidate history Q1 explicitly preserves. The shared in-memory
predicates at [rerollCandidates.ts](../../../shared/rerollCandidates.ts), lines 288–300, can likewise use a reverse
early-exit scan instead of allocating filtered copies of the entire history.

### RC6 — Repeated Lua getters rebuild the reroll history, making a linear loop quadratic

**Evidence:** [jobScope.ts](../../../server/src/jobs/jobScope.ts), lines 455–459;
[bindings.ts](../../../server/src/lua/bindings.ts), lines 375–379, 640, 1285–1287, and 1404–1405.

Every call to `scopeHistoryChat` filters and allocates the entire message array while a carrier is hidden. Lua
`getChatLength`, `getChatData`, `getChatRole`, and `getChatMain` reach it independently outside a working copy.
An ordinary `editRequest` loop over N messages therefore does O(N²) row visits and creates N transient arrays.

Instrumentation around the production bindings with 1,000 visible messages and one hidden carrier counted 1,001
filters and **1,002,001 visited rows** for one length read followed by 1,000 data reads. This is a deterministic work
count, not an elapsed-time assertion. Normal non-reroll reads return the existing array and avoid this new cost.

**Improvement:** cache the history view for a message-list version and hidden-carrier ID, invalidating on relevant
writes/adoption; alternatively expose indexed access that skips the hidden position without rebuilding the list.
Keep the view current after a start-trigger append, as D7 requires. Address RC1's write mapping at the same boundary.

### RC7 — Importing many foreign swipes repeatedly shifts almost the entire array

**Evidence:** [importCharacters.ts](../../../server/src/data/upstream/importCharacters.ts), lines 642–645 and 684–698;
[rerollCandidates.ts](../../../shared/rerollCandidates.ts), lines 245–255.

The importer builds a candidate and UUID for every foreign swipe, then passes the unbounded array to a trimmer
designed around the small live ring. Each removal of an oldest unselected candidate uses `splice`, shifting all
remaining elements. The live path starts with at most about 17 entries; imported histories have no such bound.

Production-importer instrumentation counted:

| Input swipes | Removals | Shifted array positions | Retained candidates |
| ------------ | -------- | ----------------------- | ------------------- |
| 1,000        | 984      | 498,396                 | 16                  |
| 10,000       | 9,984    | 49,984,896              | 16                  |

This quadratic work is unnecessary even when the source file is otherwise reasonably small.

**Improvement:** filter invalid/oversized entries and retain the selected entry plus a bounded newest-eligible
window before allocating candidate objects/UUIDs, or compact the survivors in one pass. Preserve selected-index
remapping, per-swipe checkpoint correspondence, byte limits, and import reporting.

### RC8 — Unchanged candidate fields on a whole-row edit force a full-chat read

**Evidence:** [chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts), lines 5698–5700 and 5791–5803;
[resourceSync.svelte.ts](../../../src/ts/storage/resourceSync.svelte.ts), `readIdleChats` starting at line 4578.

`writesCandidateFields` treats every `setMessage` containing candidates as requiring a refresh, even when only an
unrelated field changes and the server does not change the candidate counter. A real-store probe changed only
`name` on a candidate-bearing row, flushed, and refreshed: it recorded `/api/resources/read` with a whole-chat
`chats` request. There was no remote edit or selection refusal.

The cost scales with all retained messages and candidate payloads instead of the one edited row. This finding does
not claim that an ordinary successful `selectCandidate` always performs a whole-chat read, or that over-cap feed
manifests are missing; those are separate paths.

**Improvement:** compare actual candidate-field changes, and use returned candidate counters/affected rows or a
precise row refresh when server normalization requires reconciliation. Preserve full recovery where a genuinely
stale base means other changes are unknown.

### RC9 — Provenance bookkeeping traverses variables even when there is no attempt

**Evidence:** [chatStore.ts](../../../server/src/data/chatStore.ts), lines 1308–1315 and 2180–2186.

`recordVariable` immediately returns without an active attempt, but its caller `recordMap` first builds the union
of every variable key and serializes both values. All metadata operations invoke it, including an unrelated note
edit that does not change `scriptstate` at all.

Instrumentation of an ordinary note edit with no active reroll and 100 variables of 1 KiB each counted **200
`sortedJson` calls covering 204,800 input characters** in this unnecessary comparison alone. Variable maps can
exceed the snapshot cap: that cap disables checkpoint capture, not the chat's variables.

**Improvement:** return immediately when there is no attempt, and skip map comparison when the before/after map is
the same object. Keep explicit merge/unset provenance behavior, including same-value foreign writes. A further
source-level opportunity is lazy per-attempt transaction staging instead of cloning all active ledgers on every
resource transaction at lines 2691–2693; that additional cost was not benchmarked.

## Unrelated findings encountered during the audit

### U1 — Enabling stored prompt text runs mutable editRequest handlers twice

**Evidence:** [assemble.ts](../../../server/src/prompt/assemble.ts), lines 2451 and 2481–2484;
[scripts.ts](../../../server/src/prompt/scripts.ts), lines 86–100;
[runtime.ts](../../../server/src/lua/runtime.ts), lines 649–655.

Assembly calls `runEditRequest` for the real request and calls it again for the stored prompt-text copy when
`promptTextInfoInsideChat` is enabled. These Lua hooks have safe mutable host access and no frozen/working-only
scope, so variable updates and message insertions can persist twice for a single request.

A deterministic probe through the real `assemblePrompt` with an `AssemblyHost` callback incrementing a variable
returned `editRequestCalls: 1, sideEffectValue: "1"` with capture off and
`editRequestCalls: 2, sideEffectValue: "2"` with capture on. The probe proves duplicate host execution; the persistent
Lua setter path was traced in production bindings. Both call sites predate this plan (`416145ac15`, 2026-10-02).

**Correction:** capture the already-transformed request or make the diagnostic projection side-effect-free. A
setting that records a prompt must not change how many times a script's persistent effects run.

### U2 — Changing only isComment does not update a mounted chat row

**Evidence:** [Chats.svelte](../../../src/lib/ChatScreens/Chats.svelte), lines 681–689, 693–724, and 740;
[Chat.svelte](../../../src/lib/ChatScreens/Chat.svelte), lines 1356 and 1450–1457.

The row's remount key omits `isComment`; the incremental `RowUpdate` also omits it. The prop is supplied only at
initial mount. Consequently, a script/plugin/feed write that changes just this flag leaves the mounted row using
its original ordinary-message/comment presentation and delete controls until some other change remounts it.

This is source-confirmed, with no browser reproduction in this audit. The relevant mount/update structure dates to
`2ed26dfee3`, before the reroll plan. Candidate controls correctly gained incremental fields, which made this older
omission visible during their review.

**Correction:** include `isComment` in incremental row updates, or explicitly remount when it changes. Verify both
directions with unchanged text and role on an already-mounted row.

### U3 — A trigger stage with no triggers deep-copies the entire chat twice

**Evidence:** [runSetup.ts](../../../server/src/jobs/runSetup.ts), lines 374–384;
[triggers.ts](../../../server/src/prompt/triggers.ts), lines 430–447.

`runOnCopy` deep-clones the chat to form a baseline; the trigger runtime deep-clones that baseline before checking
whether the trigger list is empty. Input/start/output stages can therefore copy all historical candidate payloads
even when there is no trigger to execute. This structure predates the plan, but persistent candidate history
increases its cost substantially.

A production-setup/store probe with zero triggers and ten older rows, each carrying 50,000 characters of selected
text plus two 50,000-character candidates, returned `null` while performing **two whole-chat clones totaling
3,003,076 JSON input bytes for one start stage**. This measures the data passed to cloning, not an exact heap peak.

**Improvement:** check for applicable character/module triggers before making either copy. Where triggers exist,
consider sharing immutable candidate payloads or copying on mutation, while preserving the diff baseline and Lua
working-copy isolation. The no-trigger fast path alone removes demonstrated useless work.

## Additional narrow import edge case

A malformed native `candidates: []` field suppresses conversion of otherwise valid foreign `swipes`.
[importCharacters.ts](../../../server/src/data/upstream/importCharacters.ts), line 626, captures `hadCandidates` before
normalization removes the malformed field; line 640 then refuses swipe conversion, and lines 679–681 delete the
foreign fields. Adding `candidates: []` to RC4's input reproduced loss of all alternate texts, while preserving the
selected text. This mixed-format malformed input is uncommon, so it is lower priority than the ordinary-path
findings. Test the surviving normalized candidate field when deciding whether valid swipes can be recovered.

## Checked behavior and intentional limits

- Covered in-place success and failure paths preserve carrier identity; checkpoint/rollback writes retain their
  generation fence, and the covered Stop/error cases restore the prior reply and eligible variables.
- Stable candidate IDs and server-owned candidate revisions reject stale selections. Selection updates the
  checkpoint's `after`; text-only candidates retain the turn baseline without inventing variable snapshots.
- Reroll prompt/memory input uses the carrier-free history. Ordinary CBS history strips candidate metadata, and
  structured-memory prompt construction uses selected message text. No ordinary-path discarded-candidate leakage
  was found in these readers.
- Covered over-cap feed updates carry row manifests and metadata; owner raw checkpoints use stream references.
  Candidate-changing writes remain larger, as the plan explicitly accepts.
- Upstream export intentionally drops candidate/checkpoint fields and keeps selected text with a report entry.
  This is the chosen interchange contract, not a new loss defect.
- Multi-reply tails retain bundle-history fallback; old tabs can remove carriers; large replies/snapshots can lose
  candidate/checkpoint retention under the caps. These are explicit plan decisions.
- A process death or abort beyond the grace can leave partial text selected and variables from the attempt. A boot
  rollback sweep was explicitly deferred. RC3 concerns cleanup on a later append, not adding that deferred sweep.
  The archive's claim that process death keeps the previous reply selected without partial text is inconsistent
  with D8 and should be corrected when that record is maintained.

## Verification

- Focused current-tree suite: **510 passed, 3 skipped, 15 files**. It included prompt runner, chat store,
  normalization, trigger diffs, feed patches, memory jobs, import/export, candidate switching, server-generation
  client, reroll history, feed capability handling, controls, and resource hydration/feed tests.
- Temporary client probes: the initial mirror-equality regression failed as expected; three probes confirming
  stale cleanup, its downstream effects, and unnecessary full-chat reads passed. The scratch test was removed.
- Standalone probes exercised production resource stores, Lua bindings, prompt assembly, the upstream converter,
  and the relevant SQLite queries. Their observations are recorded with the individual findings above.
- Broad unit-test gate: **9,232 passed, 66 skipped, 578 files**. The command was
  `pnpm --silent test:agent --exclude server/src/tests/structuredWriterAudit.test.ts --exclude src/ts/storage/tests/handoffRetirement.audit-probe.test.ts`;
  the exclusions were unrelated temporary probes from concurrent audits in the shared checkout. The wrapper waited
  for its existing whole-suite lock and completed successfully.
- Browser checks: **6 passed** with
  `pnpm --silent test:agent --e2e e2e/rerollCandidates.spec.ts e2e/perChatSends.spec.ts`.
- `pnpm check:changed` passed; it skipped client/server type checks because the changed paths were documentation.
  `pnpm check:docs` and `git diff --check` passed. The report was formatted with targeted Prettier.
- Phone behavior on the owner's server and an actual process-kill/grace-expiry browser scenario were not run.
  RC3 reproduced the abandoned-fence state through the real store/guard API; it is not claimed as a process-kill test.
