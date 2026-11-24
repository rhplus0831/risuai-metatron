# Lore Popup Through a Fence Plan

Status: reshaped 2026-11-24 from the Conditional Chat Writes plan, not yet audited. That draft (at `5fced8637`)
proposed field conditions on chat ops so the server would refuse stale writes for three known issues; its full audit
([report](../reports/audits/plan-runner/conditional-chat-writes-2026-11-24.md)) found 11 P1 and 10 P2. A Claude Fable
review then judged each item and finding by how an ordinary user reaches it and what a fix costs, and the owner's rule
allowed a cheaper shape only where the outcome for an ordinary user stays the same. The conditional-write protocol is
dropped: the lore popup gets a local fix, and the other two items are decided as Limitations (D5, D6). The audit's
findings against the protocol (CW-01 to CW-09, CW-12 to CW-17, CW-22, CW-24) no longer apply; CW-11 (its unmount
half), CW-20, CW-23 and CW-25 are handled here, and CW-18, CW-19 and CW-21 are Limitations.

Sources: the [known issues](../backlog/known-issues.md) entries under characters-modules (the lore popup) and
chat-pipeline (the PO translator and DevTool autopilot), read at `5fced8637`, and the draft-recovery guide's Limitation
on a recovery Apply's late answer; `src/lib/SideBars/LoreBook/LoreEntryFields.svelte`,
`src/lib/UI/GUI/TextAreaInput.svelte`, `src/lib/UI/GUI/PopupEditor.svelte`, `src/ts/popupEditorSession.svelte.ts`,
`src/ts/storage/chatFieldDraft.svelte.ts`. The withdrawn handback attempt and its reviews are kept with the review
reports on this machine (`/home/codex/review-reports/known-issues-fix-2026-11-22/`). Identifiers are the anchors;
re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Text typed in the expanded popup of a chat lorebook or lore override prompt is not lost when the write fence rises.
It stays in the popup, is saved by the ordinary writer when the popup closes after the fence, and is shown for copying
on every path that cannot save it.

The other two known issues are decided as Limitations, not fixed: the message the PO translator or DevTool autopilot
appended before a refused admission stays in the transcript, and a recovery Apply repeated after a late answer and a
reload still replaces newer edits after its confirmation.

Not goals: any change to the chat write protocol or the server; conditions on message or metadata ops; an automatic
handback of held text; keeping popup text through a reload.

## Current State

- **Lore prompt field.** `LoreEntryFields.svelte` swaps `TextAreaInput` for a plain read-only textarea while
  `disabled` (~94 to 106). The unmount runs the field's teardown, which closes its popup session without writing back
  (`TextAreaInput.svelte` ~265). `TextAreaInput` already has a `readonly` prop, renders a read-only textarea for it
  (~388), and opens its popup with `() => readonly` (~111); `PopupEditor.svelte` follows that getter (~25).
- **Popup close.** The opener polls, then writes the popup text to the binding; a changed value or context closes the
  session and drops the text (~121 to 142). `LoreEntryFields`'s setter refuses writes while `disabled` (~25).
- **Lore writer.** `createChatFieldDraft` writes the whole list on each change and refuses, with a rollback, while
  fenced (`chatFieldDraft.svelte.ts` ~68 to 83). The server accepts a whole-list write from a stale base.
- **Not changed.** The PO translator and DevTool autopilot append before admission (`multisend.ts` ~76,
  `DevTool.svelte` ~293). A chat recovery Apply asks `recoveryDrafts.applyConfirm` before fresh writes
  (`RecoveryDrafts.svelte` ~91).

## Decisions

- **D1. The prompt field stays mounted through the fence.** `LoreEntryFields` renders one `TextAreaInput` with
  `readonly={disabled}` in place of the swap. An open popup turns read-only with its text in place and is editable
  again when the fence falls. A field that is fenced before the popup opens gets a read-only popup.
- **D2. A close after the fence saves as today.** The opener's existing write-back runs; the ordinary lore writer saves
  the list. Nothing is written by a timer or an effect: the only write is the user's close.
- **D3. Text that cannot be written back is handed to the caller, once.** `TextAreaInput` takes an optional
  `onPopupUnsaved(text)`. It is called when the session this field opened ends with text that differs from the value
  the popup opened on and one of these holds: the popup closed while the field is read-only; the value or
  `popupEditorContext` changed under it; the field unmounted. One session calls it at most once (the unmount and the
  poll that follows it must not both fire). A field without the callback behaves exactly as today.
- **D4. The lore fields show the text for copying.** `LoreEntryFields` passes `onPopupUnsaved` and shows a notice with
  the text (`lorePopupUnsaved` in `src/lang/en.ts` and `ko.ts`, beside the lore keys): the prompt could not be saved,
  copy the text below.
- **D5. The appended message stays (E2).** Decided as a Limitation: the trigger needs the PO translator or the
  autopilot and a refusal only admission finds; the message is visible and deletable and the refusal is shown. Passing
  the text as the job's `input` was rejected: the input stage runs the `input` trigger and `editinput` on it, which the
  raw append does not. A conditional remove was rejected too: `sendChat` answers only a boolean, also false for an
  admitted job that stopped, and the server's remove has no refusal outcome.
- **D6. A repeated recovery Apply stays a confirmed replace (D2 remainder).** Decided as a Limitation: the
  confirmation names the overwrite, and the chain needs a timed-out Apply that landed, a reload, a newer edit of the
  same field, and Apply again.

### Limitations

- Closing the popup while the fence is up does not save: the text is shown for copying and must be pasted after the
  reply.
- Popup text lives only in the popup: a reload or a closed tab loses it, fenced or not.
- A job that rewrites the lore list while the popup is open replaces the editing copy; the popup closes and the text is
  shown for copying.
- The ordinary lore writer sends the whole list. A close (or an inline edit) made after the fence falls but before the
  tab has installed a job's lore change, or after a feed retirement hid that job, drops the job's entries. The server
  has no refusal for it.
- The PO translator and DevTool autopilot leave their appended user message when admission refuses the job (D5).
- A recovery Apply answered after its wait, then a reload, a newer edit and Apply again, sets the field back after the
  confirmation (D6); the draft-recovery guide keeps the entry.

### Questions for the owner

- **Q1. A notice inside the read-only popup.** Proposed: none, as in the message editor's locked popup. Alternative:
  show `chatGenerating` in the popup header while it is read-only.
- **Q2. The copy notice for character and module lore.** Proposed: `LoreEntryFields` passes the callback for all its
  uses; it stays inert unless text was typed and could not be saved. Alternative: chat lore and overrides only, with a
  prop from the two parents.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guide of each file the slice touches (`pnpm docs:owner <path>`), with
  `pnpm docs:read`.
- The reproductions are the starting point: the known issue's scratch tests and the withdrawn attempt's reviewer probes
  (`/home/codex/review-reports/known-issues-fix-2026-11-22/scratch/`); each closed trigger gets a defect case (V6:
  fails before) and a control case.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`.
- User-visible strings go in `src/lang/en.ts` and `src/lang/ko.ts`, next to the feature's keys (U2).

## Slices

Order: 1, then 2.

### 1. Lore popup through a fence (_small_)

- `src/lib/SideBars/LoreBook/LoreEntryFields.svelte` (D1, D4), `src/lib/UI/GUI/TextAreaInput.svelte` (D3),
  `src/lang/en.ts`, `src/lang/ko.ts`. No change to `chatFieldDraft.svelte.ts`, the lore draft wrappers,
  `TextAreaResizable.svelte`, or the server.
- Tests: `src/lib/UI/GUI/TextAreaInput.svelte.test.ts`: the callback fires once for a read-only close, a changed value,
  a changed context and an unmount; never for unchanged text; a field without the callback is unchanged.
  `src/lib/SideBars/LoreBook/LoreBookSetting.generationLock.test.ts` and `LoreOverrideList.test.ts`: for each trigger
  (own send, message lock, a feed-listed job) the popup stays open with its text; a close after the fence saves
  through one write; a close during the fence writes nothing and shows the text; a list replaced under the popup shows
  the text; a quick close and reopen during the fence does not show or save the text twice.

### 2. Close-out (_small_)

Depends on 1.

- Run the whole suite once on the tree (V1), with the type check and format check, plus any slow or browser coverage
  of the lore sidebar and popup that the change touches; `pnpm check:tests` if tests were added (V8).
- The characters-modules guide: the lore fields' fence behavior, and the Limitations above that concern lore (the
  stale whole-list write moves there from the known-issues sub-bullet).
- [known issues](../backlog/known-issues.md): delete the lore popup bullet; move the PO translator and autopilot bullet
  to the chat-pipeline guide's Limitations with the D5 decision.

## Outside this plan

- The bounded waits (Bounded Client Waits plan).

## Manual Checks

- Two tabs on one chat: type in a lore entry's popup in one while the other sends. The popup turns read-only with the
  text in place; after the reply, close it and the text is saved.
- The same, but close the popup while the reply is still generating: the text is shown for copying and the stored
  prompt is unchanged.
