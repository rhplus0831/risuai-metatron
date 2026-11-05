# Durable Drafts audit — 2026-10-29

## Scope and result

Reviewed the plan retired by `26ca6d42e2eb95a7080cc0a0364802ff6931896f` and its
behavior at `4a95f84bf41b83e0d08164043cbe33810dcc0918`, including the existing
uncommitted journal fixes in the shared checkout. The plan is retrievable with:

```sh
git show bbc747f24:docs/plan/durable-drafts.md
```

The [archive](../../archived-plan/README.md) identifies twelve implementation commits:
`2a8ce1e83`, `62277946b`, `f5023bf8b`, `ca3e30b7b`, `8a1ea95e9`, `cfb27e86c`,
`0814b3634`, `f5ef5033e`, `5d46c6e61`, `40b026930`, `abbe42f87`, and `257a2a60c`.
The review used this explicit set because the chronological range includes other
plans and integration merges. Later Job Protocol changes to composer request
identities were treated as integration context.

Review covered journal eligibility, ownership, transactions and version fences;
record/chat/order capture and boot recovery; recovery actions; composer handoff;
restore snapshots; conflict capture and record merging; and separation of saving
from background reads. Two Luna exploration agents located the implementation and
test harnesses; the primary agent reviewed the code and ran the probes.

**Three plan-related defects and one pre-existing issue were reproduced.** No
product fix or permanent test addition is included. P1 denotes a recovery path
that loses user content and should be fixed promptly; P2 denotes a narrower
correctness or availability defect. All four remain present in the reviewed
working tree.

| ID  | Priority | Relationship                                                          | Finding                                                                          |
| --- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| DD1 | P1       | Recovery Apply, slice 5                                               | Recreating a missing chat discards edits after its stored snapshot               |
| DD2 | P1       | Chat journaling/recovery, slices 6–7; previously noted but unverified | A new character's initial chats are omitted before the first save collection     |
| DD3 | P2       | Recovery Apply, slice 5                                               | Retrying Apply after a lost create acknowledgement duplicates the recovered chat |
| U1  | P2       | Pre-existing chat loading                                             | A stalled on-demand read has no deadline, and subsequent loads join it           |

## Resolution

All four findings were fixed in `0b5e401e7` (`fix(storage): keep journaled chat work
through recovery Apply, new characters, and stalled loads`), each with a regression test
that failed before its fix:

| ID  | Fix                                                                                                     | Regression test                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DD1 | Apply creates the chat from the snapshot, then applies the ops queued after it                          | `bootstrap.journalRecovery.test.ts` "applies a missing chat's snapshot and every newer journaled edit after reload"                                                                                                                                |
| DD2 | `addCharacter`/`replaceCharacterAt` queue the initial chat creates at once (`adoptCharacter`)           | `bootstrap.journalRecovery.test.ts` "journals imported history while another save is outstanding and recovers the original chat after reload"                                                                                                      |
| DD3 | The recovered chat takes the draft's id; Apply checks that destination first                            | `RecoveryDrafts.test.ts` "retries Apply in the dialog after a lost create answer without duplicating the recovered chat"; `bootstrap.journalRecovery.test.ts` "retries a missing-chat Apply after reload without duplicating its committed create" |
| U1  | On-demand chat reads abort after `CHAT_READ_DEADLINE_MS` (60 s per request) and the shared load settles | `bootstrap.journalRecovery.test.ts` "times out a stalled on-demand chat load after 60 seconds and lets a fresh read succeed"                                                                                                                       |

The same commit closed two inbox entries (ops answered `missing` are kept as a draft;
the dev drift check stops with the adapter) and a latent leak the DD2 fix exposed: a
new character's create that loses to another tab's same-id character now keeps its
local chats as recovery drafts instead of leaving their creates pending. Remaining
limits (Apply still removes a draft whose ops it skipped; a deleted Apply destination
is recreated by a retry after reload; the read deadline is per request) are in the
[draft recovery guide's Known Hazards](../../structure/draft-recovery.md#known-hazards) and the
[chat store guide's Limitations](../../structure/chat-store.md#limitations).

## Plan-related findings

### DD1 — Apply recreates an old snapshot and deletes the newer operations

**Code.** [journalRecovery.ts](../../../src/ts/storage/journalRecovery.ts), `draftChat`
and the missing-chat branch of `applyRecoveryDraft`; the branch originates in
`cfb27e86c`. [chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts),
`queuedChatLayer` and `resendLayer`, produce the relevant layered state.

**Trigger and reproduction.** A temporary copy of the real
[bootstrap recovery harness](../../../src/ts/bootstrap.journalRecovery.test.ts)
exercised the following sequence, using the real mutation modules, IndexedDB
implementation double, save adapter, and SQLite-backed server store:

1. Create a chat with one message, `original snapshot`.
2. Fail its first batch request before the server receives it. The journal keeps
   the dispatched create in `resend`.
3. Change the message to `newest edit`, then complete the hide journal flush.
   This edit is in the newer `pending` layer.
4. Reload. The absent target of the dispatched create correctly becomes a draft.
5. Apply that draft.

Observed after Apply:

```text
saved messages: ["original snapshot"]
reported skipped operations: []
remaining recovery drafts: 0
expected saved messages: ["newest edit"]
```

An independent probe through the recovery-dialog harness reproduced the same
result with a stored `resend.create` plus `pending.setText`. Both assertions failed
again when the test wrapper reran each file alone.

**Cause and impact.** `draftChat` returns both the flattened operations and a
snapshot, selecting `pending.createSnapshot` or the last `create`/`replace` snapshot
in the operations. For a missing chat, Apply calls `createChat` with that snapshot
and never applies subsequent operations. Only the existing-chat branch calls
`applyChatOps`. A successful flush then deletes the entire draft. The newer text
is absent from both the saved chat and the journal, with no skipped-work notice.
An append or metadata edit after the snapshot has the same structural exposure.

**Suggested fix.** Materialize the final recoverable transcript from the snapshot
and subsequent operations before creating the new chat. Track which operations
the snapshot already includes: blindly replaying every operation over a current
`pending.createSnapshot` can duplicate work. Preserve any unrepresentable suffix
as a draft instead of acknowledging it as saved. Add a production-path regression
covering a dispatched create followed by text, append, and metadata changes.

### DD2 — A new character can recover with an empty replacement chat

**Code.** [characterStore.svelte.ts](../../../src/ts/storage/characterStore.svelte.ts),
`addCharacter`; [chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts),
`installCharacterChats`, `normalizeNewCharacter`, `adoptCharacter`, and
`queuedChatLayer`; [resourceSync.svelte.ts](../../../src/ts/storage/resourceSync.svelte.ts),
`collectOperations`, `flushJournal`, and `onPageHide`.

**Trigger and reproduction.** Add a new character with an imported chat containing
`Imported history`. Before its first normal save collection, dispatch `pagehide`
and let the journal transaction finish. The journal contains the character and
character-order records, but no chat row:

```text
record: characters\0new-parent
record: characterOrder\0main
chat: new-parent\0original-chat — absent
```

Reloading through the real bootstrap and flushing recovery produces:

```text
character: recovered
chat id: a newly generated UUID, not "original-chat"
saved messages: []
recovery drafts: 0
```

Both the capture-only probe and the full reload probe failed their preservation
assertions again on isolated reruns.

**Cause and impact.** Installing/normalizing a new character's initial chats
deliberately queues no chat work. `adoptCharacter` later creates the pending chat
entries, but it is called by `collectOperations`, not by the journal flush.
The character's journal record excludes chats. A hide can therefore successfully
commit the character while retaining none of its initial history. At boot,
`initializeChats` fills the recovered character's empty membership with a new,
empty chat. The gap also affects selection and composer rows addressed by the
original chat ID, and can cover multiple imported chats.

This is not merely a kill before an IndexedDB transaction commits: the probe
waited for the character journal commit. Collection can also be delayed by an
already-running save, while the separate journal timer persists the character.

**Existing coverage gap.** The test titled “recovers an undispatched character and
its original first chat without a synthetic second chat” manually writes the chat
row after `hideUnsent()`. It verifies recovery given a row but bypasses the missing
production capture. The earlier inbox note was accurate; the observed loss is
broader than orphaning an empty chat's composer.

**Suggested fix.** Make initial chat creates visible to journal projection when
the character enters the local store, while preserving the normal save path's
parent-before-chat ordering. Test a real `addCharacter` with imported history,
hide, and reload without manually inserting journal rows; include an unrelated
outstanding save so capture cannot depend on the next cycle starting promptly.

### DD3 — Retrying a missing-chat Apply creates another copy

**Code.** [journalRecovery.ts](../../../src/ts/storage/journalRecovery.ts),
`applyRecoveryDraft`'s missing-chat branch and post-flush draft removal; introduced
by `cfb27e86c`.

**Trigger and reproduction.** Using the real
[recovery-dialog harness](../../../src/lib/Others/RecoveryDrafts.test.ts):

1. Store a draft for a missing chat with a `pending.createSnapshot`.
2. Apply it, allow the new chat to commit, and drop the batch response.
3. Observe the Apply error and retained draft, then apply the same draft again.

The server ends with **two new chat IDs containing the same snapshot**; the draft
is then deleted. The expected single-copy assertion failed twice, including the
wrapper's isolated rerun. This uses a lost network acknowledgement, not a failed
IndexedDB deletion.

**Cause and impact.** Each Apply checks the original missing ID and passes an empty
ID to `createChat`, which generates a new one. Nothing records the new target
against the draft ID. The normal save adapter correctly retries the first create
under its original group identity, but the second Apply independently queues a
second create. The existing lost-answer test covers an append to an existing chat,
where stable message IDs prevent duplication; it does not cover this branch.

The uncommitted `applied` guard for a draft whose deletion failed does not cover
this case: the first Apply fails in `flushResources` before it reaches that guard.

**Suggested fix.** Persist an Apply attempt's destination chat ID before issuing
its create and reuse it on retry, including after a page reload. Settle or reconcile
the original attempt before creating anything else. Keep that identity separate
from the abandoned original chat ID so recovery does not resurrect an intentional
remote deletion.

## Issues outside the plan

### U1 — An on-demand chat read can remain pending indefinitely

**Code and attribution.**
[chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts), `readUnloaded`,
`loadUnloaded`, and `ensureChatLoaded`;
[resourceClient.ts](../../../src/ts/storage/resourceClient.ts), `readRefs`.
The signal-free read predates Durable Drafts (`git blame` attributes it to
`089adfcb57`, 2026-10-07). The plan's `deadlineRead` protects adapter refreshes and
does not wrap this caller. This was already noted in the findings inbox; the
on-demand chat path is now reproduced.

**Reproduction.** Boot from summaries, hold the transport for one unloaded chat's
`readRefs`, advance the controlled clock by 60 seconds, and request that chat
again. Observed:

```text
chat reads dispatched: 1
abort observed: false
first load settled: false
```

Releasing the transport lets both callers complete. The expected bounded-load
assertion failed again on the isolated rerun. Sixty seconds is the probe's
observation window, not a proposed product timeout.

**Impact.** `loadUnloaded` retains the unresolved promise in `loading` until its
`finally` runs; later requests in the same owner lifetime join it. A stalled
request can therefore leave the chat loading indefinitely. Recovery Apply and
composer restoration also await this API. The adapter's 20-second refresh timeout
does not provide a fallback, although independent saves remain able to proceed.

**Suggested fix.** Give on-demand loads an abortable, payload-appropriate deadline
and settle/remove the shared load entry on expiry so a later attempt can retry.
Cancel obsolete reads when their owner is replaced. Other callers named in the
original note—boot, detached export, feed reconciliation, order repair, and job
callback recovery—were not runtime-probed here and should not be assumed fixed.

## Verification and limits

- `pnpm check`: passed; Svelte reported zero errors and zero warnings, and the
  server TypeScript check completed successfully.
- `pnpm --silent test:agent`: passed, 7,740 tests passed and 60 skipped across
  514 files (187.8 seconds). The wrapper reported no `FLAKY` reruns.
- Prettier checks for the three documentation files, documentation-link target
  checks, and `git diff --check` passed.
- Two temporary probe files used the existing recovery-dialog and real-bootstrap
  harnesses. Seven cases ran: six expected-correctness assertions failed,
  independently covering the four findings, and the repeated-reload control
  passed. Each failing file failed again when the wrapper reran it alone. The
  probes were removed after their output was recorded; no permanent test or
  product source was changed for them.
- The repeated-reload control checked a recovered by-ID edit, a second hide before
  normal saving, and another reload. It preserved the edit. A suspected loss in
  that handoff is therefore not reported as a finding.
- Existing local work addresses same-tick journal close, uncloneable values,
  failed draft deletion, and character eligibility scanning. Those changes were
  preserved and are not reported as new unresolved findings. The reported branches
  also exist at the plan retirement commit; the fixes do not resolve DD1–DD3.
- The checkout was shared and already dirty, with concurrent work continuing
  during the audit. These results describe the exercised working tree, not a
  clean checkout of `26ca6d42`. No changes from that concurrent work were reverted.
- This audit did not rerun the manual Chrome kill/relaunch driver, the browser
  suite, or physical-device checks. The archive's historical passes are not
  current-run evidence. Android PWA kill, iOS Home Screen, Safari/Firefox behavior,
  pending writes across bfcache return, and phone-width dialog inspection remain
  unverified here.
- Accepted limits were not reclassified as defects: the debounce/commit loss
  window, entry/total budgets and large-record throttle, credential exclusions,
  export-only other epochs, and the documented treatment of operations answered
  `missing`. DD1 and DD2 instead lose recoverable content despite a completed
  journal write or successful Apply.
