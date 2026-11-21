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

- [characters-modules](#characters-modules) (1)
- [chat-pipeline](#chat-pipeline) (3)
- [memory](#memory) (1)
- [network-jobs](#network-jobs) (1)
- [persistence](#persistence) (1)
- [structured-memory](#structured-memory) (1)
- [ui-theming](#ui-theming) (1)

## characters-modules

Guide: [Characters, Cards, Modules, Personas](../structure/characters-modules.md#known-hazards).

- A chat lorebook or lore override prompt whose expanded popup is open loses the text typed in it when the write fence
  rises. `src/lib/SideBars/LoreBook/LoreEntryFields.svelte` replaces the editable field with another text area while
  the chat is fenced (`loreWriteFenced`), and the destroyed field's popup drops its pending hand-back
  (`src/lib/UI/GUI/TextAreaInput.svelte`). Reproduced on 2026-11-22 in scratch component tests at `924542c39` (the
  fence rising from this tab's own send and from a message lock) and at `5121ee5a4` (from a job the live feed lists):
  the popup closed, the stored entry kept its old prompt, and reopening showed the old prompt. Since `2e0402cbd` the
  fence also rises for a job or preview another device runs, so the loss has one more trigger. Not fixed. The message
  editor keeps such text through a lock (read-only popup, text handed back); these fields have no draft to hand to.
  [Field switch](../../src/lib/SideBars/LoreBook/LoreEntryFields.svelte#L94) ·
  [Popup teardown](../../src/lib/UI/GUI/TextAreaInput.svelte#L265)

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

- A multisend part can still change the transcript before the server refuses its job. Each part of `runMultisend`,
  the PO translator, and the DevTool autopilot checks the chat binding as the tab sees it (`checkServerJobBinding`)
  before it clears or appends, so a binding the tab knows to be incomplete refuses the part with the transcript
  unchanged. A refusal that only the server's admission finds (a binding mismatch the tab cannot see yet) still comes
  after that part's clear or append, so a clear-mode part can leave the chat with only its new message. Read in the
  fix round of 2026-11-22, not run. A fix moves the clear and append into the job's admission, or restores them when
  the job is refused. [Slash command](../../src/ts/process/command.ts#L52) ·
  [Binding check](../../src/ts/process/serverCommands.ts#L1181)
- Two tabs can replace each other's OOC answer. A retry checks that an exchange is unanswered before it asks for the
  preview; while the tab waits for the answer another tab can answer the same question, and the final write checks only
  that the exchange still exists before it replaces the answer. An isolated run (structure audit, 2026-11-18) inserted
  an answer during that wait and saw it overwritten. Not fixed. A fix decides the write rule for competing completions
  of one exchange and makes it hold across tabs.
  [OOC admission and answer write](../../src/ts/ooc/oocSession.svelte.ts#L183)

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- A tab that has not heard of another device's running job can still write a whole HypaV2 or SupaMemory field from
  its copy. The HypaV2 chunk editor and the SupaMemory text areas are read-only while the tab knows of a generation
  in the chat (its own send, a followed job, a message lock, a job the live feed lists) or of a chat update it has not
  read yet (`memoryEditorWriteFence`). Before the first announcement, or while the tab is disconnected, an edit is
  accepted, and the server takes a `meta.set` with an older revision and assigns the whole field.
  - What is lost then: an edit from a stale copy drops the job's new chunks or summary, and a SupaMemory summary
    computed from an older value replaces an edit that landed first (HypaV2 merges by identity and keeps such an
    edit). Both orders were reproduced on 2026-11-21 at `ddb0c225b`, before the fence, against a real send through
    the in-process server.
  - Not fixed. Closing the window needs the server to refuse a whole-field memory write whose base is older than the
    job's write; the tab cannot know of a job it has not heard of.
  - [Fence](../../src/ts/storage/chatFieldDraft.svelte.ts#L24) ·
    [Chunk setter](../../src/lib/Others/AlertComp.svelte#L297) ·
    [Job's write](../../server/src/prompt/assemble.ts#L2152)

## network-jobs

Guide:
[Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push](../structure/network-jobs.md#known-hazards).

- Callers other than a send wait for a resource write's answer without a bound. A send's preflight ends on Stop or
  after 30 seconds (`waitForSendFlush` in `src/ts/process/serverCommands.ts`); about twenty other call sites await
  `flushResources()` with no deadline and no signal: backup and snapshot, checkpoint save and load, character, module
  and plugin import, recovery draft Apply, the reroll candidate switch, the stored translation request, plugin API
  chat reads, the job channel's callback saves, and the command jobs of `prepareServerJob` (script buttons, manual
  triggers). The resource client gives the batch request no deadline, so one unanswered request holds each of them
  and every later batch until it settles or the page reloads, and keeps the before-unload warning on.
  - How far it was checked: reproduced on 2026-11-21 at `ddb0c225b` through the send, before its bound (the batch
    committed on the server, its answer withheld for two simulated hours); the other callers were read, not run. A
    real browser or proxy may fail the request sooner; no browser timeout was measured.
  - Not fixed. A caller with a Stop or Cancel of its own can race its wait the way the send does; it must not abort
    the shared write or count it as saved.
  - [Send's bounded wait](../../src/ts/process/serverCommands.ts#L1164) ·
    [Batch cycle](../../src/ts/storage/resourceSync.svelte.ts#L2996) ·
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
    as stored. The server has never written such an event.

  Not fixed: the byte charge, since measuring costs every round; the owner has not said whether it is a Limitation.

## ui-theming

Guide: [UI Components and Theming](../structure/ui-theming.md#known-hazards).

- The message editor's draft is kept by chat, message id and editor kind only, so it can reopen on another reroll
  candidate of the same message. Seen on 2026-11-22 in a scratch variation of the editor component test: a draft typed
  on one candidate reopened after a switch to another candidate, with the "changed elsewhere" notice showing. The
  rendered-translation and partial-edit drafts carry the reply's candidate and generation ids and are not affected. Not
  fixed: the notice warns before a Save, so nothing is overwritten silently.
  [Draft store](../../src/ts/storage/messageEditorDrafts.svelte.ts#L13)
