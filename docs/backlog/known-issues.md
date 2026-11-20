# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

The eleven entries left after the first two rounds were reviewed with the owner on 2026-11-10: the JWT expiry gap, the
plugin RPC lookup, key events from secret fields, and the plugin listener registry were fixed (and the hub proxy's
answers got sandbox headers, a finding of the review itself); the rest moved to their guides' Limitations with the
owner's decision, except the persistence entry below.

Seventeen entries of the fork data-loss cross-check (`cross-check F<n>`) moved here from [found issues](found-issues.md)
on 2026-11-17, after each was reproduced at `5f8b0b191` by a probe test that drives the product code through the
entry's trigger. The owner decided the seven that needed a design choice the same day. Sixteen were then fixed in one
round and their bullets deleted: implementers by group in separate worktrees, the probes turned into regression tests
by a second agent, and each new test run against its fix reverted before the commits landed. The seventeenth, F3 (a
plugin's in-memory value overwrites a newer value from another tab or device), is a
[Limitation of the plugin guide](../structure/plugin-sandbox.md#limitations) by the owner's decision. What the round
read and did not fix is in [found issues](found-issues.md); what a person has to look at is in
[manual checks](manual-checks.md#a-real-desktop-browser-by-hand).

Seven findings of the [structure audit of 2026-11-18](../reports/audits/guides/structure-audit-2026-11-18.md) moved here on 2026-11-20 from `docs/research/found-issues.md`, a file that
audit had kept apart from the backlog: each was exercised in an isolated run at `744d17cad`. The five findings the
audit only read are in [found issues](found-issues.md). None was run again at the move; the files they name had no
commit between the audit and the move.

## Contents

- [build-test-platforms](#build-test-platforms) (1)
- [chat-pipeline](#chat-pipeline) (4)
- [media-aux](#media-aux) (1)
- [memory](#memory) (1)
- [persistence](#persistence) (1)
- [structured-memory](#structured-memory) (2)

## build-test-platforms

Guide: [Build, Service Worker, Release](../structure/build-test-platforms.md#known-hazards).

- The type-check cache can replay a pass for a failing ignored file. The initial cache key includes ignored files under
  source roots; the final unchanged-tree check omits them. In an isolated Git project (structure audit, 2026-11-18)
  the cache keyed an ignored file that held a type error; the file was corrected before the compiler read it, so the
  run passed, and after the error was restored the cache replayed success while a forced compiler run failed. Not
  fixed. A fix compares the program's complete input key again before saving the result.
  [Input hashing](../../util/typeCheckCache.mjs#L62) · [End-of-run check](../../util/changedChecks.mjs#L259) ·
  [Cache write](../../util/typeCheckCache.mjs#L154)

## chat-pipeline

Guide: [Chat Pipeline: Send → Prompt → Request → Reply](../structure/chat-pipeline.md#known-hazards).

- A removal reroll (`rerollByRemoval` in `src/lib/ChatScreens/DefaultChatScreen.svelte`) can lose the replies it
  removes when the tab closes before the server admits the replacement job. It keeps the removed tail only in this
  tab's memory (`rerollHistory.begin`), removes it from the chat, and `sendChatMain`'s preflight flushes that removal
  to the server before the job is created; the restoration after a refused or failed send runs in the same tab, so a
  close, reload, or crash in between leaves the chat without the tail. Reproduced in a browser at `1513f9288` by the
  [durable data loss audit](../reports/audits/codebase/durable-data-loss-2026-11-18.md#6-closing-a-tab-during-a-group-reroll-can-discard-the-previous-replies):
  a bound group chat with a question and two members' replies, the generation request held before the server, and the
  page closed left only the question in SQLite.
  - Scope: not only group chats. `reroll` takes this path whenever it does not reroll in place: when the turn after the
    last user message is not a single character reply (`rerollCarrier` / `isRerollCarrier`, for example two members'
    replies, or a reply a trigger or Lua script appended), and when the tab's live-update connection has no current
    `hello` (`serverRerollsInPlace()` is false before the first `hello` and after the feed retires). A single reply
    rerolled in place keeps its original rows on the server until the replacement commits, and is not affected. The
    removed tail is the one `rerollTurnStart` picks: back to the last user message, or only to the last speaker's
    previous reply when that speaker answered twice. Whether a send succeeds while the feed is down was not checked.
  - Not fixed. Recorded on 2026-11-18 at the owner's request with this scope. A fix keeps the rows until the server can
    commit the replacement (the removal inside the job's admission, with the removed tail held server-side for
    restoration) or keeps a durable copy of the pending reroll that survives a client exit.

- A refused multisend can clear the chat's history. `runMultisend` clears the history in clear mode and appends the
  next user message before `prepareServerJob` checks the chat binding. An isolated run with a refused send (structure
  audit, 2026-11-18) left only the newly appended message. A retained slash draft can reach this path through Enter,
  and a binding can become invalid between parts. The PO translator and the DevTool autopilot also append before this
  check. Not fixed. A fix checks the binding before each part's first mutation, with a test of a refusal over an
  existing transcript.
  [Slash command](../../src/ts/process/command.ts#L40) ·
  [Composer dispatch](../../src/lib/ChatScreens/DefaultChatScreen.svelte#L703) ·
  [Job admission](../../src/ts/process/serverCommands.ts#L1162)
- Two tabs can replace each other's OOC answer. A retry checks that an exchange is unanswered before it asks for the
  preview; while the tab waits for the answer another tab can answer the same question, and the final write checks only
  that the exchange still exists before it replaces the answer. An isolated run (structure audit, 2026-11-18) inserted
  an answer during that wait and saw it overwritten. Not fixed. A fix decides the write rule for competing completions
  of one exchange and makes it hold across tabs.
  [OOC admission and answer write](../../src/ts/ooc/oocSession.svelte.ts#L183)
- PO translation can download an incomplete file. `sendPofile` finishes an entry only on an exactly empty line. In
  isolated runs (structure audit, 2026-11-18) CRLF input lost an entry, and the last entry of a file without a
  trailing newline was never translated; an ordinary comment past line index 100 can also break the loop and reach
  the download with only a prefix. Not fixed. A fix covers line endings, the end of the file, and comments in a long
  catalog. [PO reader and download](../../src/ts/process/files/multisend.ts#L32)

## media-aux

Guide: [Media and Auxiliary Features: TTS, Image Generation, Media, Playground](../structure/media-aux.md#known-hazards).

- Hugging Face TTS can silently discard a service error. An isolated run of `sayTTS` (structure audit, 2026-11-18)
  with a JSON HTTP 503 error and no retry estimate made one request and returned without playback, retry, or alert;
  with the same body and HTTP 502 the error alert appeared. Not fixed. A fix surfaces the provider's error when the
  503 answer supplies no usable estimate. [TTS response handling](../../src/ts/process/tts.ts#L439)

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- HypaV2 can mark messages summarized by a blank answer. A whitespace-only answer from the `subModel` or the
  `distilbart` branch returned success in the existing cold-overflow fixture (structure audit, 2026-11-18): HypaV2
  marked 11 messages as covered and produced no retrievable chunk. The fixed-completion branch already rejects an
  answer that is empty after trimming; the server's HypaV3 summarizer rejects blank answers, and Hanurai uses
  embeddings. Not fixed. A fix applies the same check before coverage advances in the two branches.
  [HypaV2 summarization](../../server/src/prompt/memory/hypav2.ts#L19) ·
  [Chunk and coverage update](../../server/src/prompt/memory/hypav2.ts#L448) ·
  [Fixture](../../server/src/tests/fixtures/memory/scenarios.ts)

## persistence

Guide: [Persistence: Database, Records, Mutation Stores](../structure/persistence.md#known-hazards).

- The remote repair's character read and order write are not atomic: a character another client trashes or deletes
  between them, with no order change, can still be appended at the root. Reproduced on 2026-11-10: once the trash or
  deletion arrives the stale id renders nothing (the sidebar and pins skip absent and trashed characters) and stays
  through selection and idle refresh; the next local add, remove, restore, or reorder (`checkCharOrder`) or the next
  boot repair removes it. Not fixed: hidden order metadata only; the owner has not yet decided to keep it.

## structured-memory

Guide: [Structured Memory Records](../structure/structured-memory/records.md#known-hazards).

- A memory row loaded from a database snapshot, a checkpoint chunk, or a memory restore is held to less than a row the
  server wrote, and two things follow. Both were reproduced on 2026-11-12 through `tx.restoreMemory`, which checks rows
  with `checkMemoryRow` as a snapshot load does.
  - The read rounds (`/package`, `/coverage`, `/story`, `/find`, `/runs`, `/threads`) charge a row's stored bytes and
    answer the re-serialized record. Three event rows of 782 stored bytes each (arrays of `1e20`) serialized to 2,482
    bytes, and with a 1,564-byte budget `/story` answered two of them in 4,619 bytes. The overrun stays near the
    expansion of a number (about three to five times), needs a restored crafted backup, and a round's first record is
    served whatever its size. Measuring each record's serialized size inside the round cost 1.6 to 1.8 ms on a 10 to
    12 ms `/package` round of 500 ordinary events (about 18%), so it was not added.
  - `checkMemoryRow` checks a row's columns, not its record's shape, so an event without `storyTime`, `keyLines`, or
    `participants` loads, where the chat-file restore (`restore.ts`) refuses it. The server's readers take those three
    as empty by the owner's decision of 2026-11-12 (`eventBody` in `card.ts`, `eventVectorTexts` and the timeline's
    full lines in `retrieve.ts`, `remappedEvent` in `pages.ts`), and the tab's readers supply them. Still open: an
    event's other parts (`summary`, `stateChanges`, `knowledge`, `relationshipShifts`, `openThreads`, `sources`) and a
    part of the wrong type are read as written, and the tab's package export (`renderMemoryTimeline`) iterates
    `keyLines` unguarded. The server has never written such an event. A run on 2026-11-14 in a running server (wide
    review, cut X2, and a second run) restored 37 crafted events through `tx.restoreMemory`: all were admitted, all
    259 read rounds answered 200, the panel rendered, and sends in the chat failed during assembly for a missing,
    null, or wrongly typed `summary`, `knowledge`, or `sources` and for `keyLines` or `participants` of the wrong type
    (16 of 36 cases). Fixed for sends the same day (`254ed796f`): prompt selection, coverage, retrieval, vector
    warming, and the recording loop skip an event with such a field (`memoryEventHasReadableFields` in
    `shared/structuredMemory.ts`) and leave the row as stored. The restore validator still admits such a row: refusing
    it there made one row fail the memory export of every chat. The package export has no caller in the product.

  Not fixed: the byte charge, since measuring costs every round; the owner has not said whether it is a Limitation.

- Record now can skip the confirmation for a second model call
  ([rebuild guide](../structure/structured-memory/rebuild.md)). With a marked greeting-only event and one confirmed
  ordinary turn, the cost query reported one call (structure audit, 2026-11-18); the real planner produced two windows,
  one to repair the greeting and one for the turn. The panel asks for confirmation at two estimated calls. Not fixed.
  A fix counts greeting-only work in the record estimate, with a test of the confirmation on the same chat.
  [Cost query](../../server/src/prompt/memory/structured/rebuild.ts#L758) ·
  [Window planner](../../server/src/prompt/memory/structured/window.ts#L403) ·
  [Panel confirmation](../../src/lib/Others/StructuredMemory/memoryRecordPress.ts#L44)
