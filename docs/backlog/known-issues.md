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

- Wide review of 2026-11-14: [report](../reports/audits/codebase/wide-review-2026-11-14.md).
- Second fix round of 2026-11-22: no report; the implementers' and reviewers' reports and probes are kept with the review
  material outside the repository.

## Contents

- [characters-modules](#characters-modules) (1)
- [chat-pipeline](#chat-pipeline) (1)
- [structured-memory](#structured-memory) (1)

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
  - A fix attempt of 2026-11-22 (held text handed back when the fence falls) was withdrawn after two reviews found
    reproduced losses on its own paths: a handback must wait while the chat is behind, and after a feed retirement
    until the job and chat are reconciled; held text must survive a chat switch or a reload (unsaved-work
    registration, or a recoverable draft or copy path); an older handback must not close a newer popup.
  - The server accepts a whole lore-list write from a stale base, which can erase a job's lore change, so a reliable
    fix starts with a server refusal like the one for the HypaV2 and SupaMemory fields (`chatMemoryWrites`). The
    attempt's reproduction and the reviewers' probes are kept with the review material outside the repository.
    [Field switch](../../src/lib/SideBars/LoreBook/LoreEntryFields.svelte#L94) ·
    [Popup teardown](../../src/lib/UI/GUI/TextAreaInput.svelte#L265)

## chat-pipeline

Guide: [Chat Pipeline: Send → Prompt → Request → Reply](../structure/chat-pipeline.md#known-hazards).

- The PO translator and DevTool autopilot check the tab's chat binding with `checkServerJobBinding` before appending
  a user message. A refusal only the server's admission finds, such as a binding mismatch, can leave the appended
  message in the transcript. The append leaves existing messages in place. Source read in the second fix round
  of 2026-11-22.
  A fix moves the append into admission or removes the appended message on refusal.
  [PO translator](../../src/ts/process/files/multisend.ts#L70) · [DevTool autopilot](../../src/lib/SideBars/DevTool.svelte#L290) ·
  [Binding check](../../src/ts/process/serverCommands.ts#L1143)

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
