# Audit: docs/plan/incremental-chat-transport.md (at d31fa9a48)

Ranked, most severe first. Plan line numbers are from `grep -n` on the plan file.

## 1. The change-log insert point covers one of four commit paths

- Severity: P1 (design flaw)
- Plan: D5 lines 213-215 ("inserted ... right before `commitTransaction()` (from `results`, `chatOutcome.results` and `chatOutcome.orders` ...)"); Current state lines 79-81; Slice 3 line 357.
- Evidence:
  - `resourceStore.ts:2403-2438`: `put` records inside `atomically`, before its commit (`recordOrder` :2417, `recordResource` :2434).
  - `resourceStore.ts:2449-2466`: `delete` does the same (`recordCharacterCascade` :2461, `recordResource` :2464).
  - `resourceStore.ts:2823`: `transaction(fn)` commits in `transactionInScope` (:1849). `atomically` commits at :1334.
  - Inside `applyChangesInScope` itself, a character delete's cascade (`recordCharacterCascade(id, chatTables.deleteCharacter(id))` :1750) and a new character's chat order (`recordOrder(id, order)` :1768) are recorded from inside the `results` map. They are not in `results`, `chatOutcome.results` or `chatOutcome.orders`.
  - The Current-state claim "`recordResource` and `recordChat` run after `commitTransaction()`" holds only for `applyChangesInScope` (:1797-1810).
- Effect: as written, record puts, record deletes, `transaction()` writes, cascaded chat and order deletions and new orders never reach the log. Every replay after one of them fails the digest and falls back to the listing (safe, but it defeats D5).
- Correction:
  - Keep a transaction-scoped list of log refs, like `transactionInvalidations`, fed by `recordResource`, `recordChat` and `recordOrder`, and write it in `commitTransaction()` just before `COMMIT`.
  - Move `applyChangesInScope`'s post-commit `record*` calls before its commit (a failed scope already discards uncommitted refs in `publishing`).
- Confidence: verified.

## 2. A `changes` table in `STORE_TABLES_SQL` never exists on an existing database

- Severity: P1 (design flaw)
- Plan: D5 lines 209-211 ("`changes (...)` in `STORE_TABLES_SQL` (`resourceStore.ts:106-124`)"); Slice 3 line 357.
- Evidence:
  - `initialize` runs `STORE_TABLES_SQL` only when `user_version === 0` (`resourceStore.ts:3329-3345`). A version-3 file opens with no schema change.
  - The tables that were added later use `CREATE TABLE IF NOT EXISTS` in `openChatSchema` (`chatStore.ts:114`, `:136`, `:163` ...; called at `resourceStore.ts:976`).
  - The server resources guide's Store tables section (lines 345-349) documents that pattern for `chatGroups` and `memory_*`: outside the layout check, a snapshot's copy is not restored, a restore leaves it empty.
- Effect: every write on every existing install would throw "no such table". Tests on fresh `:memory:` stores would pass.
- Correction:
  - Create `changes` with `IF NOT EXISTS` at open (the open schema), with no version bump.
  - Keep it out of `snapshotTableColumns` (`:3189-3195`).
  - Do not copy it in `replaceAll`. Truncate it there, as D5 says.
- Confidence: verified.

## 3. The post-replay digest check compares a moving map with the `hello`-time digest

- Severity: P1 (design flaw: correct but self-defeating)
- Plan: D5 lines 223-228; Slice 3 client tests lines 371-375.
- Evidence:
  - While a reconcile is pending, `receive` applies every `change` frame straight into `advertised.rows` (`eventFeed.ts:278-281`), not only into the overlay.
  - The plan's replay is "the rows after `since`", answered at request time, so it includes writes after `hello`.
  - `hello.digest` is the state at `hello` (`events.ts:136-146`).
- Effect:
  - Any write between `hello` and the processing of the replay (a 3 s checkpoint of a reply streaming on another device is enough) makes `revisionDigest(advertisedListing()) !== hello.digest`, so the tab reads the whole listing.
  - That is the resume-while-something-streams case this plan targets.
  - It is never unsafe: every wrong map is caught.
- Correction (either of):
  - Bound the replay with `until=<hello.cursor>` (coalesce rows with `since < cursor <= until`). Apply it to a copy of the map taken when `hello` arrived, before any later frame. Compare that copy with `hello.digest`, then lay the frames received since `hello` on top.
  - Have the answer carry a digest sampled in the same synchronous step as its cursor.
  - Either way, the memory fences then take a `hello`-time listing, as the existing digest-match path does.
- Confidence: verified in code; the effect is likely.

## 4. D2's selection order cannot deliver the Goal, the stated effect and D8 together

- Severity: P1 (design contradiction)
- Plan: Goal lines 48-50; D2 lines 172-181 ("`patch` when it fits; else `rowDelta` ...; else `delta` as today (so a tab that applies a `delta` never regresses)"); D8 lines 249-251; D9 lines 255-256.
- Evidence:
  - With `patch` first, a checkpoint of any reply whose row fits 64 KiB still publishes the whole row. That includes SD01's 32 KiB fixture, so "each checkpoint's payload is the text added since the previous one" (D2) and "chunk-sized frames" (Goal) hold only past about 64 KiB.
  - With `rowDelta` tried before `delta`, an entry where both fit (row data changed, plus a metadata change too large whole, the ST04 large-metadata case) now carries `rowDelta` instead of the `delta` an older client applies today (`resourceSync.svelte.ts:4579`). That older client then reads the chat whole.
  - So "never regresses" is false. Because the feed is a broadcast (per-socket forms are a non-goal, line 58), there is no way to have all three properties.
- Correction (choose one and rewrite the Goal and the D2 effect to match):
  - (a) Order `patch` → `delta` → `rowDelta` → none: truly additive, and the saving is only past 64 KiB (the ST04/SD01 over-cap case).
  - (b) Prefer `rowDelta` whenever it is smaller, accept whole reads for older clients, and record that as the D4 proto-floor trade.
- Confidence: verified.

## 5. D3's watermark rule is wrong when the owner's stream buffer is below the watermark

- Severity: P1 (design flaw: the owner reconstructs the row wrongly)
- Plan: D3 lines 187-197 ("one at or below it means the stored text is what the client already displays or an older text it need not restore").
- Evidence:
  - The current rule `entry.seq <= mark.seq → continue` (`chatStore.svelte.ts:2301-2310`) keeps the copy's row text. That is correct today only because the copy carries the stored row: `shared/jobs.ts:273-276` says generated rows are always carried because "the client's copy of those can hold streamed text".
  - On attach, the job chat goes as a `chatPatch` from `sentChat` before the `accepted` with the current text (`generationJobs.ts:1976-1995`).
  - A tab that reconnects mid-stream holds buffer seq B below the stored watermark W. Under D3 it keeps a row with text at or below B and sets the watermark to W.
  - The following `accepted` at S == W (no chunk since the last checkpoint) is `older` and is not shown (`chatStore.svelte.ts:1795`, `:1816-1818`). The mirror shows stale text at a revision that claims the stored text, until the next chunk or the final hydration.
  - Also, `diffChat` is a pure function without the seq (`generationJobs.ts:579-617`). The stored `generationSeq` is a checkpoint counter (`runner.ts:1716-1724`: `generation!.seq += 1`), not the chunk seq.
- Correction:
  - Apply a `streamed` row only when the tab holds that generation with buffer seq ≥ W. At equality, write the buffer text into the row explicitly.
  - Otherwise send `resync`, or never raise the watermark above the held buffer seq.
  - The server should take `seq` from `streamingIn` (`job.watermarks`) and use the form only for rows in that list that are present in `sentChat`.
- Confidence: verified in code; the reconnect timing is likely.

## 6. "Slices 0, 2 and 3 touch disjoint files" is false

- Severity: P2 (internal contradiction)
- Plan: Recommended order line 408; Slices lines 289-292; Relation lines 35-38; file lists at lines 296-301, 336-341, 357-364.
- Evidence:
  - Slices 0 and 2 both edit `src/ts/storage/chatStore.svelte.ts` and the chat store guide.
  - Slices 2 and 3 both edit `server/src/routes/events.ts`, `src/ts/network/eventFeed.ts` and the server generation guide.
  - Slice 2's edits to `events.ts` and `eventFeed.ts` also collide with Job Handoff Slice 3, which line 291 omits.
  - Line 290 says Slices 1 and 3 share `resourceSync.svelte.ts`, but Slice 3's file list does not name it (its client test is `resourceSyncLive.test.ts`).
- Correction: state that 0, 1 and 2 serialize on `chatStore.svelte.ts`, and that 2 and 3 serialize on `events.ts` and `eventFeed.ts`. Add `resourceSync.svelte.ts` to Slice 3 or drop it from line 290.
- Confidence: verified.

## 7. Client preference versus the Slice 1 test

- Severity: P2 (contradiction)
- Plan: D2 line 175 (`patch ?? rowDelta ?? delta`) versus Slice 1 lines 328-329 ("an entry with `patch` and `rowDelta` both is not a body this client knows").
- Evidence: today's code is `chat.delta ?? chat.patch` (`resourceSync.svelte.ts:4578-4579`, "At most one of the two"). The `meta` + `metaFields` refusal (`chatStore.svelte.ts:2604-2609`) is inside one body, not across fields.
- Correction: keep the server's one-of-three rule and treat an entry with more than one body as no body. Drop the preference sentence.
- Confidence: verified.

## 8. D7 puts `streamed` entries under the publication budget

- Severity: P2 (wrong claim)
- Plan: D7 lines 245-247.
- Evidence: `budgetedEntries` runs only in the feed's `publishing` (`resourceStore.ts:1161-1186`, `:1273`). A job `chatPatch` goes out through `deliverJobChat` → `send` (`generationJobs.ts:934-943`, `:742-760`), with no budget.
- Correction: name only `rowDelta` and `rows` as budgeted. Say that `streamed` rows only shrink the job frame.
- Confidence: verified.

## 9. The D9 and Q2 measurements cannot produce the numbers named

- Severity: P2 (contradiction with the probes)
- Plan: D9 lines 254-259; Q2 lines 274-276; Slice 1 lines 330-332; Slice 0 lines 307-308; Slice 3 lines 376-377.
- Evidence:
  - `checkpoint-probe.mjs:10-11`: each checkpoint sets "a different 32 KiB text", so there is no common prefix, and under 64 KiB `patch` wins anyway. `:353` throws `if (!feedChat.patch)`. Its "whole-transcript reads" are server-side SQL `.all()` counts (`:27-29`), not reads by a loaded observer.
  - `sync-traffic-measure.mjs` has no feed subscription and no mixed write fixture: it measures boot, listing and op sizes only (`:115-185`). There is nothing to count over-cap entries in, so the Q2 gate has no input.
  - `measureChats.mjs:239` hard-codes 2,000 messages (no 10,000). F1's figures come from a store-level evaluate (`rendering-performance-investigation.md:347-388`), so a `measureChats` line is not an F1 after line.
  - `measureBoot.mjs` resumeAway checks "exactly one revision listing" by pathname (`:1368-1372`). `?since=` has the same pathname, and the driver records no reconnect time.
- Correction:
  - Add an appending long-reply run to the checkpoint probe, and an observer-read count.
  - Add a feed-entry workload, or name the probe that will hold one.
  - Rerun the F1 evaluate body for Slice 0.
  - Make resumeAway tell `?since=` apart from the listing and add a timing.
- Confidence: verified.

## 10. D6 reuses `unanswered` for "the chat moved on"

- Severity: P2 (design flaw, gated slice)
- Plan: D6 lines 238-240.
- Evidence: `readRefs` re-sends `unanswered` entries and throws `502 "The server's read made no progress"` when a round does not shrink (`resourceClient.ts:298-305`). A single moved-on `chatRows` entry would fail the whole read.
- Correction: answer a distinct outcome (for example `{ revision, rows: null }`) that the client turns into a whole read.
- Confidence: verified.

## 11. The `since` request has no epoch, yet a server test expects an epoch mismatch

- Severity: P3
- Plan: D5 lines 221-223; Slice 3 server tests lines 368-369 ("another epoch is the mismatch").
- Evidence: the epoch is checked only client-side (`checkedEpoch`, `resourceClient.ts:320-323`). `replaceAll`'s `DELETE` keeps `AUTOINCREMENT` counting, so an old-epoch `since` looks valid against the new log.
- Correction: send `epoch` with `since` and answer `expired` on another epoch, or move that test to the client.
- Confidence: verified.

## 12. "The cursor lives with the connection"

- Severity: P3 (contradiction)
- Plan: Out of scope lines 435-436.
- Evidence: the replay needs the cursor to outlive the connection that ends. `retire()` (`eventFeed.ts:148-155`) resets per-connection state.
- Correction: say it lives with the module's advertised map (cleared with `clearAdvertised`), not across reloads.
- Confidence: verified.

## 13. Writes at store open bypass the log

- Severity: P3
- Plan: D5.
- Evidence: the normalization pass, retired-kind deletes and singleton materialization at open advance revisions with no `record*` (`resourceStore.ts:967-975`).
- Effect: after an upgrade restart, every resumed tab's replay fails the digest and reads the listing. Safe.
- Correction: state it, or log those rows in the open transaction.
- Confidence: verified.

## 14. The D8 compatibility claim cites tests that do not exist yet

- Severity: P3
- Plan: D8 line 253 ("verified by the Job Handoff plan's tests").
- Evidence: `job-handoff.md` line 3 says "no slice landed". Its line 177 still says "verify in".
- Correction: say the behaviour is the current `switch` with no default, and add the test in Slice 3.
- Confidence: verified.

## 15. The before-text capture in D2 is underspecified

- Severity: P3
- Plan: D2 lines 170-172.
- Evidence:
  - `applyGroup` reads the row once per op (`chatStore.ts:1926`), and a group can have several ops on one row. The "before" text must be the group's first read of each id.
  - Testing "changed only in `data`" parses both stored JSONs of each touched row. Today `chatFeedChange` parses no row until the form fits (`chatStore.ts:1475-1486`).
- Correction: specify first-touch capture and accept, or bound, the parse cost.
- Confidence: verified.

## 16. Stale or wrong anchors and claims (P3)

- Line 83: "epoch is a UUID in `meta` (`:718`)". Line 718 is `writeValidatedStore` (the staged file). The live store creates the epoch at `:3338` and reads it at `:3361`.
- Line 211: `STORE_TABLES_SQL` is at `:113-124` (106-111 is `SCHEMA_VERSION`).
- Line 130: "`hydrateChat` (`:2335-2377`)". 2335 is `applyChatHydration`; `hydrateChat` is at `:2107`.
- Lines 90-91: "The rows come from the group's `ChatWriteChange.rows`". Only when `changes` is requested; otherwise they come from the lazy `touchedRows` (`chatStore.ts:2121-2152`).
- Lines 80-81: see finding 1.

Checked and correct: `events.ts:134-161`, `app.ts:303-315`, `shared/resources.ts:522-529/389-395/416/422/219`, `routes/resources.ts:323-328`, `eventFeed.ts:75-77/89-109/198-239`, `resourceSync.svelte.ts:4620`, `resourceStore.ts:784/965-977/1161/1241-1286/2847-2927`, `resourceClient.ts:55-75`, `chatStore.ts:67-78/403-419/1487/2616`, `runner.ts:91/1715-1727`, `shared/jobs.ts:227-237/272-288`, `generationJobs.ts:579-617/670-676/742-760/1400-1431/1454-1480/1039-1060/2088-2122`, client `generationJobs.ts:910-918`, and `chatStore.svelte.ts` 112-113, 444, 518, 535, 1355-1364, 1692, 1772/1779, 1732, 1844, 2275-2278, 2283, 2305-2317, 2311, 2524-2533, 2581-2597, 3156-3158, 3196, 3222, 3488-3491, 3537, 3895, 4779-4783, 5426-5437, 7152-7157. Also `storedTranslation.svelte.ts:85`, `Chats.svelte:751-756` (`messages` is `chat.message`, `DefaultChatScreen.svelte:201`) and `rendering-performance-investigation.md:347-388`. Every test, probe, driver and e2e file the plan names exists (`chatStatus.test.ts` exists in two places: `src/lib/SideBars/` and `src/ts/process/`).

## Snapshot restore and the epoch (the requested answer)

- **An in-app restore always starts a new epoch.**
  - `replaceAll` draws `randomUUID()` (`resourceStore.ts:2869`) and writes it with `setEpoch` inside the install transaction (`:2894`). It publishes an `epoch` frame (`:2922`).
  - It copies only the named tables from the staged file (`:2881-2890`), and the staged file comes from `walkSnapshotFile` rows (`:700-736`). So a restored `changes` table can never come back.
  - A connected tab halts on the `epoch` frame or on `hello`'s epoch (`eventFeed.ts:264-268`) before it would send any `since`.
- **Out-of-band file swap (not documented as supported).** Someone copies a `backupTo` file, a whole-file online backup that would include `changes` and the old epoch, over `resources.sqlite` and restarts.
  - A tab whose cursor is ahead of the file's log gets "unknown", which must be answered as `expired`.
  - After new writes reuse cursor numbers at or below the tab's cursor, the replay can be "known" but miss changes.
  - In both cases the full-state `revisionDigest` check differs and the tab reads the listing. A tab that reconnects before any post-swap write also has a map that differs from the file's state, so the digest differs.
  - So the digest closes every case short of a 128-bit hash collision, provided the client never reconciles from a replay without the digest check, as the plan specifies.
  - Optional hardening: a random log id in `meta`, carried with the cursor.

## Checked and found sound

- `hello` builds `epoch`, `streaming`, `memoryTasks` and `digest` in one synchronous step in `attach` (`events.ts:134-161`; `listRevisions` is a single synchronous read), so a cursor can be sampled in the same step.
- Frames reach sockets in commit (cursor) order:
  - `publishing` publishes after commit.
  - `createChangeFeed.publish` queues nested publications (`changeFeed.ts:38-58`).
  - The socket fan-out queues while fanning out (`events.ts:100-121`).
  - A budget-dropped payload never drops refs (`budgetedEntries`), so a frame's cursor stays valid.
- `budgetedEntries` measures each optional payload separately in a list (`resourceStore.ts:1161-1186`), so a `rowDelta` slot fits in.
- `coalescedChat` builds a fresh entry and drops every body (`:437-450`).
- `applyRemoteChatPatch` requires a loaded, idle (`canRefreshChat`), non-stale chat held at exactly `baseRevision` (`chatStore.svelte.ts:2581-2585`).
- D2's reason for a third field is correct: an unknown field on a `delta` is ignored, and `patchedTail` with no rows or removals and the same `count` applies a no-op and advances the revision (`:2642-2647`).
- The checkpoint stores the same text the chunk at that `seq` carried (`runner.ts:2136-2167`).
- The chunk's common-prefix code is at `generationJobs.ts:1409-1421`.
- `sentChat` is per job, and attach keeps a single owner socket (`:1950-1955`), so a per-socket `rows=streamed` flag works today.
- The messages table key is `(chatSeq, id)` with `messages_position` (`chatStore.ts:67-78`), which supports D6's by-id read.
- D1's validated lookup is sound: ids are unique per chat (`prepareMessages`, the server's primary key), a hit is checked against `chatId`, and `activeStreamingIndex` reads `chat.message`, so it stays tracked.
