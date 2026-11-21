# Known Issues

Confirmed defects and advertised but unwired behavior, kept as one queue across the focused guides. The guides keep
their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that
is confirmed moves here, and so does a [found issues](found-issues.md) entry once it is reproduced. Each entry is one
bullet under its owning guide, with its links pointed back at the guide, and says how it was reproduced; the Contents
list counts each guide's entries. Line numbers and identifiers drift: re-check the code before acting on an entry
(STRUCTURE.md protocol step 5), and delete it in the same commit that fixes it or shows it is gone. A defect the owner
decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into
the guide.

This file holds open entries only, written in the present tense. Do not add history here: which entries moved in
when, who fixed what and how, and what the owner decided about an entry that has left belong in the commit message of
the commit that moves, fixes, or closes it (`git log -- docs/backlog/known-issues.md`), and in the guide's Limitation
when the owner keeps the behavior. When a fix closes part of an entry, rewrite the entry to what is left.

Sources the entries name (drop a line when no entry names it any more):

- Structure audit of 2026-11-18: [report](../reports/audits/guides/structure-audit-2026-11-18.md); each entry was
  exercised in an isolated run at `744d17cad`.
- Wide review of 2026-11-14: [report](../reports/audits/codebase/wide-review-2026-11-14.md).
- Remote Host post-audit of 2026-11-16: [report](../reports/audits/finished-plans/remote-host-2026-11-16.md).
- Reproduction round of 2026-11-21: no report; each entry was run in a probe at `ddb0c225b` (Vitest, and headless
  Chrome for the transcript scroll entry), and the probes are kept with the review material outside the repository.

## Contents

- [build-test-platforms](#build-test-platforms) (1)
- [chat-pipeline](#chat-pipeline) (4)
- [media-aux](#media-aux) (1)
- [memory](#memory) (2)
- [network-jobs](#network-jobs) (1)
- [persistence](#persistence) (1)
- [structured-memory](#structured-memory) (2)
- [translation](#translation) (1)
- [ui-theming](#ui-theming) (3)

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
- The HypaV2 chunk editor and the SupaMemory text areas write the whole memory field from the tab's copy while a
  send's memory step writes the same field on the server, and one side's change can be dropped without a notice. The
  server takes a `meta.set` with an older revision (`stale: true`) and assigns the whole named field. Reproduced on
  2026-11-21 at `ddb0c225b` (the mounted character sidebar's editors against a real send through the in-process
  server, with the model answers held to order the two writes):
  - HypaV2 (`setHypaV2ChunkText` in `src/lib/Others/AlertComp.svelte`): an edit written from a copy older than the
    job's write removes the job's new chunks. The other order is safe: the job merges with the stored chunks by
    identity, so an edit that lands first survives.
  - SupaMemory (the `supaMemoryData` text areas of `src/lib/SideBars/CharConfig.svelte`, character and group): both
    orders lose. A stale edit restores the older summary; an edit that lands while the summary request is out is
    replaced by the string the job computed from its earlier copy.
  - Reach: both modes can be selected (Settings → Memory, with the chat on Legacy and memory on). Neither editor
    checks for a running generation or turns read-only during one. An open editor adopts the job's write once the
    change feed delivers it, so the stale window ends at that delivery. A dropped summary's model answer may still be
    in Request History; a dropped manual edit has no copy.
  - Not fixed. The fence of `createChatFieldDraft` does not cover it as it is: its predicate was false in the probe
    while another device's job ran (it fences local sends, followed jobs, and known message locks).
  - [Chunk setter](../../src/lib/Others/AlertComp.svelte#L295) ·
    [SupaMemory text areas](../../src/lib/SideBars/CharConfig.svelte#L1856) ·
    [Job's write](../../server/src/prompt/assemble.ts#L2152) ·
    [Fence predicate](../../src/ts/storage/chatFieldDraft.svelte.ts#L14)

## network-jobs

Guide:
[Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push](../structure/network-jobs.md#known-hazards).

- The send preflight waits for a resource write's answer without a bound. `prepareServerJob`
  (`src/ts/process/serverCommands.ts`) awaits `flushResources()` and tests the send's abort signal only after it, and
  the resource client gives the batch request no deadline and no signal. A write whose answer never arrives holds the
  send, the chat's send reservation, its pin, and Stop until the request settles or the page reloads. Reproduced on
  2026-11-21 at `ddb0c225b` on both paths into the wait (`runServerJob`, and `remoteSend` on the sending device): with
  the batch committed on the server and its answer withheld, Stop did not end the send in two simulated hours
  (`ended: 0, reserved: true`) and nothing was dispatched; releasing the answer ended it. First seen on 2026-11-16 by
  the Remote Host post-audit (L-1).
  - Reach: a phone that changes networks between a save's request and its answer. A local send makes pending work
    itself (the message statistic), so no earlier edit is needed. A second send in that chat is refused while the
    reservation is held. A reload frees it, and the composer text comes back only if its journal hand-off committed. A
    real browser or proxy may fail the request sooner; nothing in the tab guarantees it, and no browser timeout was
    measured.
  - The send is not the only waiter: about twenty call sites await `flushResources()` without a bound (backup and
    snapshot, checkpoint save and load, character, module and plugin import, recovery draft Apply, the reroll
    candidate switch, the stored translation request, plugin API chat reads, the job channel's callback saves). One
    unanswered request holds every later batch behind it and keeps the before-unload warning on.
  - Not fixed. A fix races the wait against the send's signal and a deadline, answers a refusal that keeps the
    request's uncertainty, and never goes on to a create after the timeout. It must not abort the shared write or
    count it as saved: the write may be committed, and other callers wait on the same answer.
  - [Preflight](../../src/ts/process/serverCommands.ts#L1202) · [Remote send](../../src/ts/network/remoteSend.ts#L370)
    · [Batch cycle](../../src/ts/storage/resourceSync.svelte.ts#L2996) ·
    [Batch request](../../src/ts/storage/resourceClient.ts#L450)

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
    full lines in `retrieve.ts`, `remappedEvent` in `pages.ts`), and the tab's readers supply them. An
    event's other parts (`summary`, `stateChanges`, `knowledge`, `relationshipShifts`, `openThreads`, `sources`) and a
    part of the wrong type are admitted as written: the restore validator admits such a row on purpose, since refusing
    it there made one row fail the memory export of every chat. The read rounds answer such a row and the panel
    renders it (wide review of 2026-11-14, cut X2, in a running server: 37 crafted events restored through
    `tx.restoreMemory`, all admitted, all 259 read rounds answered 200). A send does not fail on one: prompt
    selection, coverage, retrieval, vector warming, and the recording loop skip an event with a missing, null, or
    wrongly typed field (`memoryEventHasReadableFields` in `shared/structuredMemory.ts`, `254ed796f`) and leave the row
    as stored. Still open: the tab's package export (`renderMemoryTimeline`) iterates `keyLines` unguarded; it has no
    caller in the product. The server has never written such an event.

  Not fixed: the byte charge, since measuring costs every round; the owner has not said whether it is a Limitation.

- Record now can skip the confirmation for a second model call
  ([rebuild guide](../structure/structured-memory/rebuild.md)). With a marked greeting-only event and one confirmed
  ordinary turn, the cost query reported one call (structure audit, 2026-11-18); the real planner produced two windows,
  one to repair the greeting and one for the turn. The panel asks for confirmation at two estimated calls. Not fixed.
  A fix counts greeting-only work in the record estimate, with a test of the confirmation on the same chat.
  [Cost query](../../server/src/prompt/memory/structured/rebuild.ts#L758) ·
  [Window planner](../../server/src/prompt/memory/structured/window.ts#L403) ·
  [Panel confirmation](../../src/lib/Others/StructuredMemory/memoryRecordPress.ts#L44)

## translation

Guide:
[Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display](../structure/translation.md#known-hazards).

- The tab's LLM translator can cache a blank translation. The shared pipeline refuses an answer that is blank after
  cleaning, but `translateLLM` restores style placeholders after the pipeline returns and drops a placeholder whose
  index the source did not have, so an answer that is only such a placeholder becomes an empty string, is cached, and
  is served again without a provider call. Reproduced on 2026-11-21 at `ddb0c225b`: `translateHTML` with a provider
  answer of `<style-data style-index="7"></style-data>` returned and cached `""`, and the repeated call did not reach
  the provider.
  - Reach: the rendered LLM path with Send Text As-Is off. The row shows a blank body (cached-only display counts `""`
    as a hit). Retranslate overwrites the entry when a new result arrives; Clear Translation Cache removes it. The
    Playground's Bulk plain-text output takes the same path. The server's stored translation does no style restoration
    and is not affected (an unknown placeholder stays literal there).
  - Not fixed. A fix applies the blank check again after the restoration.
  - [Restoration](../../src/ts/translator/translator.ts#L1188) · [Blank check](../../shared/translation/pipeline.ts#L341)

## ui-theming

Guide: [UI Components and Theming](../structure/ui-theming.md#known-hazards).

- Three small editors of a chat row lose unsaved text when their owner is destroyed or locked. The message editor and
  the stored-translation editor keep their text in tab memory (`src/ts/storage/messageEditorDrafts.svelte.ts`), their
  expanded popup included; these three do not. Reproduced on 2026-11-21 at `ddb0c225b` in component probes:
  - The editor of a rendered (cached) translation, inline or in the expanded popup: its text is a row-local string. A
    stream that starts and ends on the same row (a Continue) mounts the row again and the editor reopens with the
    cached value. Opening Settings and returning, or switching chats, destroys it too (read in the code). A lock alone
    keeps the text, and the field stays writable during it.
  - The partial-edit popover (`src/lib/ChatScreens/PartialEditController.svelte`): a lock on its row removes the
    controller, with no remount needed, and an outside edit to another paragraph of the same message replaces the row.
    Either way the typed paragraph is gone when the popover is opened again.
  - The expanded original editor in a bookmark preview (`src/lib/Others/BookmarkList.svelte`): Escape closes Bookmarks
    and the text is gone. The preview passes no message id, so no tab draft receives the popup's hand-back.
  - Not fixed. The popup hands its text back on destruction; what these three lack is a draft that outlives the owner.
  - [Editors](../../src/lib/ChatScreens/Chat.svelte#L1445) · [Draft store](../../src/ts/storage/messageEditorDrafts.svelte.ts#L13)
- Opening a long message's inline editor moves the transcript, and cancelling does not restore the reader's place.
  The rendered body is replaced by a text area of a fixed 256 px (the stable-height rule for multiline or
  over-600-character text), the row shrinks, and the browser's scroll anchoring answers the collapse. Reproduced on
  2026-11-21 at `ddb0c225b` in headless Chrome 156 (1280 × 800, automatic popup editing off): 300 px up inside the
  newest message, the click moved `scrollTop` from −300 to +1 (the row went from 1313 to 439 px) and brought the
  previous message to the view's top; cancel left the reader five paragraphs later. In an older message the offset
  moved by the 874 px the row lost, and cancel left the reader fifteen paragraphs later.
  - Not affected: the reader at the bottom, a short message (it uses the autoresizing editor), and the same click with
    `overflow-anchor: none` on the scroller; in all three the offset stayed and cancel restored the place.
  - Reach: inline editing needs automatic popup editing off, and it is on by default. No text is lost.
  - Not fixed. `keepRowHeight` in `src/lib/ChatScreens/Chats.svelte` holds a row's height only when its `Chat` is
    mounted again, and opening the editor does not remount it.
  - [Stable-height rule](../../src/lib/ChatScreens/messageEditPopup.ts#L34) ·
    [Text area sizing](../../src/lib/UI/GUI/TextAreaResizable.svelte#L55)
- Branch on a reply that is still streaming copies the text streamed so far, and the new chat keeps that prefix. The
  Branch handler of `src/lib/ChatScreens/Chat.svelte` checks only that the target exists; it copies from the tab's
  chat, and the final text is installed in the source chat only. Reproduced on 2026-11-21 at `ddb0c225b` on the mounted
  row menu: the branch held `The door` after the source finished with `The door opened.`. Branch on an earlier,
  finished message while another reply streams copies up to that message and is harmless. The row's other controls
  (Edit, Remove, Disable, the reroll arrows) are locked while it generates. Not fixed. A fix disables Branch on the
  locked row. [Branch handler](../../src/lib/ChatScreens/Chat.svelte#L2058)
