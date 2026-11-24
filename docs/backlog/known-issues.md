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

- Second fix round of 2026-11-22: no report; the implementers' and reviewers' reports and probes are kept with the review
  material outside the repository.

## Contents

- [characters-modules](#characters-modules) (1)
- [chat-pipeline](#chat-pipeline) (1)

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
  a user message, and the append is saved before the job is created. A refusal only the server's admission finds, such
  as a binding mismatch, leaves the appended message in the transcript. Reproduced on 2026-11-24 in a scratch test
  (a 409 binding mismatch after the append was saved). Removing it by id is not safe: another tab can edit the saved
  row first, and the server's single-id remove neither checks the base revision nor the stored text, so a fix needs a
  conditional remove (the row still holds the appended text) in the chat write protocol, or the append moved into
  admission. [PO translator](../../src/ts/process/files/multisend.ts#L76) ·
  [DevTool autopilot](../../src/lib/SideBars/DevTool.svelte#L293) ·
  [Server remove](../../server/src/data/chatStore.ts#L2781)
