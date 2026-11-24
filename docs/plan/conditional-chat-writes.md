# Conditional Chat Writes Plan

Status: first draft, 2026-11-24 at `5fced8637`; held. Its full audit
([report](../reports/audits/plan-runner/conditional-chat-writes-2026-11-24.md)) found 11 P1 and 10 P2: a condition needs
the value each write was made over, captured at the original edit and carried through the journal's layers and the
client queue's folds, every field a recovered op writes needs a guard, condition-bearing work must not reach a server
without support (boot resend included), and the lore field drafts named in D8 survive neither a chat switch nor a
reload. The owner decides the scope before a revision. The recovery-retry fix this plan extends landed as `2917eeb42`;
its client-only late-answer checkpoint was tried and reverted (`913806ba3`, `405b52a15`).

Sources: the [known issues](../backlog/known-issues.md) entries under characters-modules (the lore popup), chat-pipeline
(the PO translator and DevTool autopilot), read at `5fced8637`, and the draft-recovery guide's Limitation on a recovery
Apply's late answer;
`server/src/data/chatStore.ts` (op preparation ~980 to ~1140, the group apply ~2400 to ~2900); `shared/chats.ts`;
`src/ts/process/files/multisend.ts`, `src/lib/SideBars/DevTool.svelte`; `src/ts/storage/journalRecovery.ts`,
`draftJournal.ts`; `src/lib/SideBars/LoreBook/`, `src/ts/storage/localLoreDraft.svelte.ts`,
`loreOverridesDraft.svelte.ts`, `src/lib/UI/GUI/TextAreaInput.svelte`. The withdrawn attempts' reviews are kept with
the review reports on this machine (`/home/codex/review-reports/known-issues-fix-2026-11-22/`,
`/home/codex/review-reports/known-issues-fix-2026-11-24/reports/review-data.md`). Identifiers are the anchors;
re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A chat write made from an old view of a field can say what it expects to find there, and the server refuses it,
field by field, when the stored value has moved on. The three known issues then close without the tab having to
know about every other writer.

- A message the tab appended and must take back is removed only while it still holds the appended text.
- A recovery draft applied again after a newer edit does not set the edited fields back.
- Text held through a lore write fence is handed back only onto the value it was typed over.

Not goals: character, module, and other record writes (whole-record Apply stays a confirmed replace); the order
resources; changing what an unconditional write does.

## Current State

- **Message ops** (`setMessage`, `setText`, `patchMessage`, `remove`) apply to the stored row whatever its content.
  `setMessage` replaces the whole row even on a stale revision (comment at ~2706); a single-id `remove` of a missing
  id is a no-op, and of a present id deletes it with no check (~2781). `selectCandidate` already carries an
  expectation (`expect.candidatesRevision`), refused when it differs.
- **Meta op** (`meta`: `set`, `unset`, `merge`, `mergeUnset`) applies onto the stored metadata. Two narrow conditions
  exist: `ifOocUnanswered` (an OOC exchange must still be unanswered, ~2502) and the memory-field rule that refuses
  `hypaV2Data` / `supaMemoryData` written from a base older than a job's write (`newerMemoryWrite`, ~2527).
- **Refusal detail.** After `kf-data` lands, the group result names refused ops (`refusedMeta`: op index, and the
  refused fields of a memory op), replayed exactly for a remembered group.
- **The three callers.** The PO translator and DevTool autopilot save an appended user message before job admission
  and cannot take it back safely. A recovery Apply sends whole values captured when the draft was written. The lore
  fields' popup loses held text when the fence rises; the withdrawn handback wrote the held list whole.

## Decisions

- **D1. Conditions are digests of the stored value.** A condition names a field (a metadata key, or a message's
  `data`) and the digest of the value the writer last saw there, or `null` for absent. The digest is SHA-256 over the
  canonical JSON serialization in `shared/` (one function used by the tab and the server; the tab computes it with
  Web Crypto). Sending digests, not values, keeps a lore list or a long message out of the request twice (Q1).
- **D2. Message ops take `ifData`.** `setText`, `setMessage`, `patchMessage` (when it sets `data`), and `remove` may
  carry `ifData: <digest>`. The server refuses the op when the stored row's `data` digests differently, and also when
  the row is missing (a `remove` of a missing id stays a no-op).
- **D3. The meta op takes `ifFields`.** `meta` may carry `ifFields: { <key>: <digest | null> }` for keys it sets,
  unsets, or merges. A key whose stored value digests differently is refused alone; the op's other keys apply. The
  existing `ifOocUnanswered` and memory-field rules are unchanged and run first.
- **D4. A write that already holds its target is accepted.** If the stored value already equals what the op would
  write, the op is acknowledged as applied, whatever its condition. A retry after a lost answer, or a second Apply of
  writes the first one saved, then succeeds without a false conflict.
- **D5. Refusals are reported per field.** `refusedMeta` gains the refused keys of a meta op and a `data` refusal of
  a message op, with the reason `changed`; it is replayed for a remembered group as today. The `hypaV3Data` the server
  strips while Structured Memory owns the field (`refusesHypaV3Data`) is reported the same way: today it is dropped
  silently, and a receipt that omits it let a recovery retry attempt retire the summaries' only copy. An op without a condition
  behaves exactly as today, so older tabs are unaffected; an older server ignores the unknown keys (tab and server ship
  together, and the tab checks the server's capability flag before relying on a refusal, Q2).
- **D6. The PO translator and DevTool autopilot.** When admission refuses the job after the append was saved, the tab
  sends `remove` with `ifData` of the appended text. If it is refused (another tab edited the row), the message stays
  and the refusal is shown as today.
- **D7. Recovery drafts record what they were written over.** A new chat draft stores, per op, the digest of the
  field value the tab held when the draft was written; Apply sends it as the condition. A refused field stays in the
  draft (exportable, discardable) and the panel says it changed elsewhere; the confirmation prompt is kept only for
  drafts written before this change, which carry no digests.
- **D8. The lore fields hold text in their field draft.** While the fence is up, the open popup becomes read-only and
  its text moves to the existing lore field draft (`localLoreDraft`, `loreOverridesDraft`), which survives a chat
  switch and a reload. When the fence falls and the chat has caught up (not behind, and after a feed retirement the job
  and chat are reconciled), the draft is written with `ifFields` of the list the text was typed over. A refusal keeps
  the draft and shows the existing draft-conflict notice; nothing is written whole over a newer list.

### Limitations

- A digest condition compares values, not histories: a field changed and changed back is accepted as unchanged.
- Character and module records stay unconditional; their recovery Apply remains a confirmed whole-record replace.

### Questions for the owner

- **Q1. Digest or value.** Proposed: a SHA-256 digest (D1). Alternative: the expected value itself, which needs no
  shared serializer but doubles the request size for large fields.
- **Q2. Older servers.** Proposed: a capability flag in the server's hello, and the tab keeps today's behavior (with
  the confirmation prompt) when it is absent. Alternative: rely on tab and server shipping together.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guide of each file the slice touches (`pnpm docs:owner <path>`), with
  `pnpm docs:read`.
- The reproductions are the starting point: the known-issues entries' scratch tests and the withdrawn attempts'
  reviewer probes (paths in Sources); each closed trigger gets a defect case (V6: fails before) and a control case.
- A data-layer slice gets a read-only reviewer and a "fixed, re-verify" turn before its tests are written.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`.
- User-visible strings go in `src/lang/en.ts` and `src/lang/ko.ts`, next to the feature's keys (U2).

## Slices

Order: 1; then 2, 3, and 4 side by side in separate worktrees; then 5 on the integrated tree.

### 1. Server conditions (_medium_)

- `shared/chats.ts` (op types, `refusedMeta`), `shared/` (the canonical digest), `server/src/data/chatStore.ts`
  (preparation and apply of `ifData` and `ifFields`, D4, refusal detail), the server hello's capability flag: D1 to
  D5.
- Tests: `server/src/tests/chatStore.test.ts`: each op refused on a changed value and applied on an unchanged one; a
  target already stored is accepted; a meta op with one refused key applies the others; a remembered group replays
  its refusals; ops without conditions are unchanged; the tab and server digests agree for the same value
  (`shared/tests/`).

### 2. Taking back an appended message (_small_)

- `src/ts/process/files/multisend.ts`, `src/lib/SideBars/DevTool.svelte`, the tab's op builder for `remove`: D6.
- Tests: beside the existing multisend and DevTool tests: a refused admission removes the untouched append; an
  append edited in another tab first is kept.

### 3. Recovery drafts (_medium_)

- `src/ts/storage/draftJournal.ts` (digests in new drafts), `src/ts/storage/journalRecovery.ts`,
  `src/ts/storage/chatStore.svelte.ts` (sending conditions, reading per-field refusals), the Recovery Drafts panel:
  D7.
- Tests: `src/lib/Others/RecoveryDrafts.test.ts`, `src/ts/storage/tests/journalRecovery.test.ts`: the known issue's
  two triggers (a partial refusal then another tab's edit; a timed-out Apply, a late answer, a newer edit), each
  followed by Apply again, keep the newer edit; a reload between the two Applies; an old draft without digests still
  asks for confirmation.

### 4. Lore fields through a fence (_medium_)

- `src/lib/SideBars/LoreBook/LoreEntryFields.svelte`, `src/lib/UI/GUI/TextAreaInput.svelte`,
  `src/ts/storage/localLoreDraft.svelte.ts`, `loreOverridesDraft.svelte.ts`: D8.
- Tests: the component tests the guide names, from the withdrawn attempt's reviewer probes: text typed when the fence
  rises (own send, message lock, another device's job) survives; it is written after catch-up; a newer list from
  another tab refuses it and the draft stays; a chat switch and a reload keep it.

### 5. Close-out (_small_)

Depends on 1 to 4.

- Run the whole suite once on the integrated tree (V1), with the type check and format check.
- The chat-store guide's write protocol (the conditions, D4, the refusal detail), draft-recovery, and the lore guide;
  the Limitations above.
- [known issues](../backlog/known-issues.md): delete the two closed bullets, and the draft-recovery Limitation it closes.

## Outside this plan

- The recovery retry's late answer (an Apply whose answer arrives after its wait, then a reload, a newer edit, and
  Apply again), kept as a Limitation in the draft-recovery guide when `kf-data` lands. A client-only checkpoint for it
  was tried and reverted on that branch; D7 closes it, since the second Apply over a newer edit is then refused.
- The bounded waits (Bounded Client Waits plan).

## Manual Checks

- Two tabs on one chat: type in a lore entry's popup in one while the other sends; after the reply, the typed text is
  saved, and an edit made in the other tab meanwhile is not overwritten.
