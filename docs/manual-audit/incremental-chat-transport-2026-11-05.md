# Incremental Chat Transport code audit — 2026-11-05

## Scope and result

Audited `dev` at **`65e97f91f22418df49452e76e46af7a145b144f1`**, which matched the local `origin/dev` ref. The checkout was clean when the audit started. The retired plan was recovered with:

```sh
git show ab9baf867e0793452db0db3684b2b3755457fb45^:docs/plan/incremental-chat-transport.md
```

The review covered D1–D8: the message position index, feed row diffs, streamed owner rows, protocol flags, change-log replay, row manifests and reads, budgets, and compatibility. Two exploration agents mapped the implementation; four audit agents independently reviewed replay, server feed/read behavior, client application/indexing, and generation hydration. The parent reviewer checked source evidence, reran the checkpoint probe, and independently checked the SQLite query plans. Product code was not changed.

**The ordinary transport paths work, but several operations still cost the size of the history or complete message.** Seven actionable transport findings are below. No message-loss or message-corruption defect was confirmed in the reviewed transport paths. The interrupted-replay defect causes avoidable traffic; its digest fallback preserves correctness. Separate findings outside the plan are retained below.

P2 means a material, reproducible correctness, traffic, or performance issue worth addressing. P3 means a narrower optimization or design edge. These priorities are not claims that every item was introduced by this plan. Line references describe the pinned revision above.

| ID     | Priority | Finding                                                     | Relationship to plan                                     |
| ------ | -------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| ICT-01 | P2       | Row reads scan the chat despite requesting one ID           | D6 reuses an existing query; also affects D2             |
| ICT-02 | P2       | Earlier completed replies travel whole in later checkpoints | Remaining D3 traffic cost in an existing patch contract  |
| ICT-03 | P2       | Interrupted replay loses the usable cursor baseline         | D5 reconnect defect                                      |
| ICT-04 | P2       | Every logged commit scans the retention window              | D5 write-path overhead                                   |
| ICT-05 | P2       | Tiny diffs and stream references deep-copy complete rows    | D2/D3 client processing cost                             |
| ICT-06 | P3       | Repeated missing IDs rebuild the complete position index    | D1 follows its chosen fallback; optimization opportunity |
| ICT-07 | P3       | Owner checkpoints copy and compare full-history baselines   | Existing server structure used by D3                     |

## Findings within the transport scope

### ICT-01 — A one-row read still scans the chat inside SQLite

**Evidence:** [server/src/data/chatStore.ts](../../server/src/data/chatStore.ts), `selectPatchMessages` at lines 1413–1416, `touchedRows` at 1673–1676, and `readRows` at 2718–2729.

The query filters requested IDs but orders by `m.position`. On Node v24.21.0's SQLite, the production schema and query produce:

```text
SEARCH m USING INDEX messages_position (chatSeq=?)
```

SQLite walks the chat's position index and filters IDs, rather than looking up the requested `(chatSeq, id)` keys. This is a scan within one chat, not a whole-database scan. It need not return or deserialize all messages into JavaScript to perform that work. Both checkpoint feed construction and the new `chatRows` endpoint use this helper, so one changed tail row still incurs work proportional to history length on the synchronous server connection.

**Reproduction:** Create a chat using `CHAT_TABLES_SQL`, seed 10,000 messages, and run `EXPLAIN QUERY PLAN` on `selectPatchMessages` with only the final ID requested. Changing only the comparison query's final clause to `ORDER BY +m.position` produces:

```text
SEARCH m USING INDEX sqlite_autoindex_messages_1 (chatSeq=? AND id=?)
USE TEMP B-TREE FOR ORDER BY
```

The two queries returned identical rows and predecessor anchors at 100, 10,000, and 100,000 messages. The alternative sorts only the requested results. This comparison demonstrates the query-planner problem; the unary-plus spelling is not a prescribed production fix.

**Correction:** Make the query explicitly driven by requested IDs, then order that small result. Preserve predecessor lookup and insertion ordering. Add a query-work regression check: the current feed test around `chatFeedPatches.test.ts:1009–1039` counts rows yielded to JavaScript and therefore misses internal scans.

There is a second residual history-length cost nearby: `countMessages` at line 1411 runs `COUNT(*) WHERE chatSeq = ?` during by-ID writes, including text-only checkpoints. Fixing the row lookup alone does not make the entire write constant-cost. A transactionally maintained or correctly invalidated count would remove this additional traversal.

### ICT-02 — Completed replies are resent during later replies in the same job

**Evidence:** [server/src/jobs/generationJobs.ts](../../server/src/jobs/generationJobs.ts), `job.generated.add` at 1691–1695, forced inclusion in `diffChat` at 715–718, and the active-generation requirement in `chatPatchEvent` at 1263–1284. The multi-speaker loop is in [server/src/prompt/runner.ts](../../server/src/prompt/runner.ts), around line 582.

Every row on which the job began a generation stays in `job.generated`. `diffChat` includes those rows even when their stored JSON has not changed. The streamed encoding requires an active generation lock; after a reply finishes, its row therefore travels whole in every subsequent checkpoint of another reply within that job.

**Reproduction:** A real in-memory resource store, generation registry, and owner WebSocket used `hydration=patch&rows=streamed&proto=1`, with no viewer. Finish a 128-KiB reply, begin a second reply, and emit its raw checkpoint:

- The first reply's final patch was 131,384 bytes.
- The second reply's checkpoint was **131,519 bytes**. It contained the unchanged first reply's 131,072 characters plus a correct `streamed` reference for the current reply.

Further checkpoints repeat the completed text. The plan's single-reply probe does not exercise this case. Group sends and command sequences can consequently pay for all earlier replies generated in the same job on every later checkpoint.

**Correction:** Stop forcing a completed row into patches once its final stored state has been delivered. Preserve real field changes, active streamed rows, and reconnect/base-mismatch recovery. Add a two-reply registry test asserting that later checkpoints omit an unchanged, already-delivered completed reply.

### ICT-03 — Interrupted replay advances the cursor beyond the map's coverage

**Evidence:** [src/ts/network/eventFeed.ts](../../src/ts/network/eventFeed.ts), `reconcile` at 304–345, `retire` at 234–238, and live-frame handling at 413–417.

While replay is pending, a live frame immediately advances `heldCursor` and changes the advertised map. If that connection retires before replay installation, the frozen snapshot is abandoned but the advanced cursor survives. That cursor no longer denotes a map complete through that point.

**Reproduction:** Execute the current module with socket/HTTP boundaries controlled:

1. Seed a complete advertised map and cursor 10.
2. Make away-time change A; reconnect to a hello at cursor 14 and hold the `10..14` replay response.
3. Deliver an independent live change B at cursor 15.
4. Replace the connection before its replay completes.
5. Deliver the next hello at cursor 15.

The current code requests `15..15`, omitting A, then needs a full revision listing to satisfy the digest. The VM probe produced:

```json
{
  "replayCalls": [
    { "since": 10, "until": 14 },
    { "since": 15, "until": 15 }
  ],
  "listingCalls": 2
}
```

The two listings are initial seeding and the avoidable fallback. The log still covers the missing change. This reduces D5's benefit when mobile connections reconnect repeatedly while another client is streaming. **The digest detects the incomplete map, so this reproduction does not lose data.**

**Correction:** Keep a cursor for verified map coverage separate from the highest live-frame cursor during reconciliation, and commit them together after successful replay; alternatively restore the frozen map/cursor when retiring that attempt. Extend the concurrent-overlay test with retirement before the replay resolves.

### ICT-04 — Pruning scans 20,000 log rows for a one-row commit

**Evidence:** [server/src/data/resourceStore.ts](../../server/src/data/resourceStore.ts), `pruneChanges` at 1071–1073 and its unconditional call for logged commits at 1162–1165.

```sql
DELETE FROM changes WHERE cursor <= (
    SELECT cursor FROM changes ORDER BY cursor DESC LIMIT 1 OFFSET ?
)
```

Finding the cutoff with `OFFSET 20000` walks the retained window for every logged commit, including ordinary checkpoints and settings saves. The work runs before `COMMIT` on the synchronous writer connection. It also scans the available rows while the log is still filling.

**Verification:** Node's SQLite 3.53.4 reports `SCAN changes` in the cutoff subquery and a `Last → IfPos → Prev` opcode loop. An isolated SQLite progress-handler probe of the same SQL counted 241, 2,041, 20,041, and **40,041 VM instructions** to delete one row with retention limits of 100, 1,000, 10,000, and 20,000 respectively. The opcode counts come from the separate progress-handler probe; they are not Node timing measurements.

**Correction:** Maintain the retention boundary incrementally, or use a cursor-range cutoff after establishing the necessary cursor-allocation invariant. Preserve transactional pruning, restore behavior, and replay expiration semantics. Verify query work at a full retention window rather than only the final row count.

This is distinct from the already-recorded [change-log byte-size limitation](../research/found-issues.md#the-change-logs-bound-is-a-row-count-not-4-mb): 20,000 rows is not a 4-MB byte cap, and snapshots contain the log.

### ICT-05 — Small incremental payloads still clone complete messages

**Evidence:** [src/ts/storage/chatStore.svelte.ts](../../src/ts/storage/chatStore.svelte.ts), JSON-based `clone` at 970–972, `stagedRowDiffs` at 2827, `resolveJobChatPatch` at 2689, and the additional clone in `patchedMessages` around 3067.

A feed diff clones the whole held message before changing its few fields. Even a metadata-only `generationInfo` update serializes and parses unchanged text and retained candidates. Owner stream references similarly clone the old row before replacing `data`, and patch installation clones the reconstructed row again.

**Verification:** A probe executing the extracted production functions applied a **100-byte** field diff to a row with 100 KiB of reply text and 190 KiB of candidate data. It serialized **297,076 bytes across two JSON clones**: the changed field value and the complete held row. This is CPU/allocation amplification, not extra network traffic. The normal retained-candidate cap is 192 KiB per message; the example does not assume unbounded candidate arrays.

**Correction:** Validate the whole operation first, then shallow-copy the row and clone only incoming changed field values, or install validated field updates through the owning store. Preserve atomic rejection, ownership of incoming objects, reactive tracking, and handling of own JSON keys. Avoid duplicating the resolved owner row during the subsequent patch stage. Verify that unchanged candidate data is not serialized for a text-only checkpoint.

### ICT-06 — Known-absent IDs repeatedly rebuild the full index

**Evidence:** [src/ts/storage/chatStore.svelte.ts](../../src/ts/storage/chatStore.svelte.ts), `positionOf` at 1054–1070 and `applyChatResult` collision checks at 4369–4373.

The index validates hits, but every miss rebuilds it even when a previous lookup just proved the same ID absent and the array has not changed. With 10,000 messages, executing the production lookup 200 times produces **one build for the existing tail ID and 200 builds for the same missing ID**.

The most direct batch case is a plugin/hook result adding K fresh messages: the collision loop checks every new ID before inserting any of them. That costs K builds of the N-row history, with Map allocation as well as scanning. `restoreUnsentRemoval` has similar intentionally-absent lookups. Chunks arriving before their generated row is hydrated can also miss repeatedly, although the frequency of that case was not measured in a browser.

This follows D1's specified correctness fallback; normal updates to an existing streaming row retain the intended fast path.

**Correction:** Reuse one current membership set within batch operations. For general negative caching, key misses to a reliable structural generation and retain the validated-hit fallback; blindly caching absence indefinitely could hide a later insertion. Add missing-ID and bulk-add counter cases beside the existing successful-lookup tests.

### ICT-07 — Owner checkpoints still rebuild full-history baselines

**Evidence:** [server/src/jobs/generationJobs.ts](../../server/src/jobs/generationJobs.ts), `advanceChatBaseline` at 651–665, `diffChat` at 699–718, and checkpoint callers at 1225 and 1685–1689.

For one changed row, baseline advancement rebuilds message order and copies the complete text Map. `diffChat` then builds sets and several arrays and compares every ID before producing a small patch. Streamed encoding reduces the resulting payload but happens after this work.

**Verification:** Instrumented calls to the exported production functions gave:

| History rows | Changed rows | Baseline ID reads | Map entries copied | Diff ID reads | Diff Map gets / has |
| -----------: | -----------: | ----------------: | -----------------: | ------------: | ------------------: |
|          100 |            1 |               200 |                100 |           501 |           199 / 100 |
|       10,000 |            1 |            20,000 |             10,000 |        50,001 |     19,999 / 10,000 |

Both calls returned one changed row. This is existing server architecture, not a transport regression. It adds synchronous allocation and GC pressure when several long chats generate concurrently.

**Correction:** Accumulate touched-row changes between the sent and working baselines and use an indexed path when membership/order are unchanged. Retain the general diff for structural or intervening external changes. A baseline shared with `sentChat` must remain immutable; changing the Map in place without changing its ownership would break patch correctness.

## Findings outside the plan

### OTHER-01 — Large-transcript deletion can throw before queuing the edit (P2)

**Evidence:** [src/ts/storage/chatStore.svelte.ts](../../src/ts/storage/chatStore.svelte.ts), `applyRemoval` at 3873–3882.

```ts
chat.message.splice(0, chat.message.length, ...kept);
```

Removing even one tail message passes every surviving message as a function argument. With 200,000 minimal messages, about 9.09 MB of JSON, the exact operation on Node v24/V8 throws `RangeError: Maximum call stack size exceeded`; the array remains at 200,000 rows. `enqueueLocalEdit` is after the failing call. A smaller but still large transcript also pays for filtering and replacing every position when deleting only its tail.

The operation predates the transport index change (`f033d69ce^`). No message-count cap was found in the inspected server normalization. The runtime reproduction used a plain array in Node; browser argument limits and Svelte-proxy behavior were not measured, so 200,000 is a reproduction size, not a universal browser threshold.

**Correction:** Use indexed compaction/truncation or bounded contiguous splices without spreading the entire surviving transcript. Verify a large tail deletion and a discontiguous removal, including the queued server operation.

### OTHER-02 — Reroll bookkeeping parses history on ordinary appends and swipes (P2)

**Evidence:** [server/src/data/chatStore.ts](../../server/src/data/chatStore.ts), `selectCheckpointRows` at 1407–1410 and its non-comment append caller at 2257–2259; `selectCarrierMessages` at 1348–1350 and candidate selection at 2410–2419. [shared/rerollCandidates.ts](../../shared/rerollCandidates.ts), `isRerollCarrier` at 288–296.

Every non-comment append checks JSON candidate/checkpoint fields throughout eligible history, including chats which have never retained a candidate. Candidate selection separately reads every row's role/comment projection into JavaScript, although carrier eligibility depends on the final two non-comment messages.

**Verification:** On 10,000 messages with 4-KiB texts and no candidate/checkpoint fields, cleanup returned zero rows. An equivalent counting `json_type` function on this field-absent fixture recorded **9,999 inspections**. Carrier lookup returned **10,000 rows**. The production query plans also show the chat-range scan and correlated `json_tree` work.

This comes from Reroll Candidates rather than Incremental Chat Transport. It can offset the transport savings with synchronous work on ordinary sends and candidate switches.

**Correction:** Maintain an indexed set/flag of rows requiring checkpoint cleanup, and read only the final two non-comment rows for carrier validation. Test both the result and inspected-row count on a long candidate-free chat.

### OTHER-03 — Earlier insertion discards a still-selectable carrier's variable snapshots (existing limitation)

Using the public resource-store API, a latest reply had candidate A with `$score=1` and candidate B with `$score=2`. Inserting a user message at `anchor: { start: true }` left that reply eligible as the reroll carrier, but append cleanup at `chatStore.ts:2257–2273` removed its checkpoint and both candidates' `scriptstateAfter`. Selecting B then succeeded and displayed B's text while `$score` remained 1.

This follows the separate Reroll Candidates plan's literal D6 rule, which clears other messages' snapshots on any non-comment append, including insertion/client operations. **It is recorded as an observed design limitation, not counted as a new implementation defect.** If insertion before the existing carrier should preserve candidate-variable restoration, the commit-boundary rule needs to consider position. Otherwise this text-only selection behavior should be explicit when evaluating that feature.

## Accepted behavior and checks that did not become findings

- `rowDelta` application stages validation before mutation and requires the exact base revision. Missing rows, invalid text prefixes, and mismatched manifests fall back safely.
- Feed patches cannot overwrite an owner's ahead-of-checkpoint buffer: `canRefreshChat` rejects a locally streamed chat, including placeholder generation entries.
- Stream references require matching raw checkpoint text and unchanged non-text fields. Missing, behind, or wrong-job buffers reject before revision/watermark advancement. Processed output and final field changes correctly send whole rows.
- Viewer presence disables streamed rows for the shared job event, and older clients fall back to whole reads for unknown `rowDelta` bodies above the small-patch threshold. These are recorded compatibility/design choices.
- `proto=1` is recorded/logged rather than enforced. A protocol floor, subscriptions, and persistent boot-cache cursors were explicitly deferred.
- The log's row-count-versus-byte-size problem was already tracked; this audit does not present it as a new discovery.

## Verification and limits

All measurements here are observations or operation counts, not wall-clock test assertions. Timing runs can be affected by concurrent work; the findings rely on query plans, counts, payload contents, and controlled state transitions.

- **Focused tests passed:** 627 tests in 20 files, covering server chat patches/store/read budgets/feed/events, client replay, job delta/barrier handling, chat-store locking, feed patches/lazy chats/live reconciliation, resource reads, and stored translation.
- **Type checks passed:** `pnpm check`; Svelte reported zero errors and warnings, and the server TypeScript check exited successfully.
- **Checkpoint probe passed:** `node --expose-gc docs/research/deep-audit-with-fable/probes/checkpoint-probe.mjs`. On its 5,000-message history, 45 checkpoints appended 1,536 characters each, reaching 69,120 characters. Owner checkpoint frames were **502 bytes** each. The first five feed bodies were small `patch` bodies; the next 40 were **1,699–1,700-byte `rowDelta` bodies**. The final `generationInfo` feed body was 218 bytes. The model observer performed **zero whole-chat reads** after its initial seed. The probe models the observer; it is not a real-browser run.
- **Additional probes:** current-source VM/extracted-function checks for interrupted replay, missing-ID lookup counts, row-clone volume, and baseline traversal; real store/registry/WebSocket checks for repeated completed replies; production-schema SQL query plans; public-store candidate-insertion behavior; and the exact large-array deletion operation.
- **Broad suite passed with concurrent scratch tests excluded:** 9,191 passed and 66 skipped across 577 files. The initial unrestricted run picked up three temporary, untracked audit test files created by concurrent work after this audit began. It reported 9,331 passed, 66 skipped, and three failing files: `server/src/tests/structuredWriterAudit.test.ts`, `src/ts/process/chatStatus.race-probe.test.ts`, and `src/ts/storage/tests/handoffRetirement.audit-probe.test.ts`. These files are absent from the audited commit; their failures are not attributed to its transport implementation. Concurrent files were left untouched. The successful rerun was:

  ```sh
  pnpm --silent test:agent \
    --exclude server/src/tests/structuredWriterAudit.test.ts \
    --exclude src/ts/process/chatStatus.race-probe.test.ts \
    --exclude src/ts/storage/tests/handoffRetirement.audit-probe.test.ts
  ```

- Browser/e2e drivers, Firefox, Safari, mobile devices, and real two-device reconnection were not rerun. The report does not claim those gaps in the archived plan have been closed.

The most useful next regression cases are a reconnect retired during replay, a second reply checkpoint after a finalized first reply, an internally indexed one-row SQL read, and long-history missing-ID/bulk-add checks. They exercise the cases the successful single-reply and ordinary-reconnect tests do not cover.
