# Cross-plan review — 2026-10-29

## Scope and result

Reviewed the integrated result of the commit range `3c0d10e1..8ea35c16e` on `dev` (181 commits,
about 40,000 added lines, produced by agent-run plans with little human review) at
`8ea35c16eb2d32525530a267295dc4ad3348777c` (`8ea35c16e`), from clean detached worktrees.
The range holds the Display Evaluation, Durable Drafts, Job Protocol, and Boot Bytes plans, each of
which already has a per-plan audit under `docs/manual-audit/` whose findings were fixed; the Deep Audit Fixes
and HypaV3 Token Budget plans and about forty standalone commits, which had no audit; the thirteen
commits that fixed the four audits' findings; and eight merge commits between the plan runs.

This review therefore cut the range by seam rather than by plan: the files that two or three plans
changed and the merges resolved by hand, the audit-fix commits as a set, and the work no audit had
covered. Eight independent read-only reviewers each took one seam (Method below). Prior audit
findings, recorded decisions, and `docs/research/found-issues.md` entries were excluded from their
reports; the session re-ran every reproducing probe at HEAD and read the code behind each finding.

**Seven product defects were reproduced (one P1, two P2, four P3), plus one test that cannot fail
and three stale guide statements.** Two reviewer priorities were lowered and one reviewer finding
was rejected (Reclassified and rejected below). No product fix is included. The three stale guide
statements (R1) are corrected in this change; every other finding is recorded in its owning guide's
Known Hazards `Issues` and remains open. P1 means a recovery path loses user content; P2 a
correctness or availability defect on a realistic path; P3 a narrower defect, a wrong notice, a test
gap, or a documentation defect.

**Resolution (2026-10-29).** JR1, JR2, and JR3 are fixed in `f5e2502a9`, each with a
regression test. JR2: a send's hand-off has its own journal row (`composer\0<chatKey>\0send`)
beside the editable draft, so typing or clearing during the send touches only the draft; `restore`
reads the draft first and the hand-off only when there is none, and a placed or restored hand-off
is deleted in the transaction that writes the draft. JR1: a landed send drops its ids from a draft
retyped with the same text instead of deleting it. A reload before the page's own settlement still
deletes that draft, because it cannot be told from the send's text placed back after a failure;
the draft recovery guide's Known Hazards records it. JR3: the split-commit test runs an ordinary save
cycle while the journal commit is held and fails with the collector's guard removed. An
adversarial GPT-6.1-Sol review of the first version found that a file queued during a send kept
an already placed hand-off alive (it came back after the composer was cleared) and that the row
swaps budgeted both rows near the 64 MiB cap; both were fixed before landing.

UI-01 was fixed on 2026-10-29 in `d0e9cc5f1`. Every popup field bound to a record the selection
resolves passes that record's id as `popupEditorContext`: the prompt preset pages, CharConfig's
character and chat fields, the regex, Lua trigger, and textarea toggle editors, the HypaV3 prompts,
plugin arguments, and the Jinja template setting. `TextAreaInput` advances the context revision
only when the value changes. `presetPages.test.ts` and `CharConfig.popupEditor.test.ts` fail with
the guards removed. A GPT-6.1-Sol review of the first version found the sweep's misses (regex, Lua,
toggles, HypaV3, plugins) and a false discard when the preset list was refreshed with the same id;
all were fixed before landing. A second round found that rows bound by index still redirect a draft
when another client reorders them under an open popup, and that duplicate plugin names share a
context. Both need equal text and remote edits, so the ui-theming guide's Known Hazards records
them.

DT1 was fixed on 2026-10-29 in `94856bdc2`. A display failure carries its kind: the tab's size
refusal, a 400 or 413 answer to a chunk whose first request held one target, and a target the
server marks `permanent` (a text or loaded scope over a limit on its own) are not retried, and like
a success they retire the message's older-generation retry. Transient failures keep the 5–60 s
rounds. `Chat.interactions.svelte.test.ts` fails with each classification removed. A GPT-6-Astra
review of the first version found that a 400 or 413 of a multi-target chunk can be refused only for
the targets' sum, and that a newer permanent failure left an older retry pending; both were fixed
before landing. It also found that a transient sibling target in the same row (a legacy rendered
translation) still re-requests the permanent target each round and that a script whose output size
varies can fail the limit once and fit later. Both are rare combinations whose fix needs per-target
terminal memory, so the rendering guide's Known Hazards records them.

SJ1 was fixed on 2026-10-29 in `e12741d5a`. Boot discovery hands the status it read to the follow:
a kept outcome is the end without an attach, and an ended job's terminal stands when the attaches
run out or the chat cannot be loaded. DT3 was fixed in `339c2a078`. The bookmark list, message
search, the HypaV3 memory modal, and the popup editor hide the transcript as Settings does, and the
smaller pickers and dialogs still do not. The new `serverCommands.test.ts` boot case and the
`chatStatus.test.ts` obstruction cases fail with each guard removed. A GPT-6.1-Sol review of the
first version found that a failed chat load after discovery still dropped the terminal, and that
the popup editor was missing from the panels; both were fixed before landing.

DT2 was fixed in `f7d403a47`. Each transcript row reports the source it shows to the recovery
module, a failure keeps the source shown when it failed, and a row showing another source drops it;
the same source keeps it, so a sibling target's failure still retries. A GPT-6.1-Sol review of the
first version, which compared sources inside one row instance, found that an edit remounts a
transcript row and so escaped it; the module-level record replaced it. The new `Chat.interactions`
remount case and `displayTransformRecovery.svelte.test.ts` fail with the source comparison removed,
with every show dropping, and with the owner check removed. A request of the old source that fails
after the edited source renders is still retried once; the rendering guide's Known Hazards records
it. Every finding of this review is now resolved.

| ID    | Priority | Seam              | Finding                                                                                 |
| ----- | -------- | ----------------- | --------------------------------------------------------------------------------------- |
| JR2   | P1       | journal-recovery  | Typing a follow-up erases an unanswered send's journal row and its request identity     |
| UI-01 | P2       | client-ui         | A preset field's popup writes back into the preset resolved at close                    |
| DT1   | P2       | display-transform | A permanent display failure retries and toasts every round while the row is mounted     |
| JR1   | P3       | journal-recovery  | A landed send deletes an identical draft's journal row                                  |
| SJ1   | P3       | server-jobs       | Boot discovery drops the ended status it read; a connection failure then reports `lost` |
| DT2   | P3       | display-transform | A failure's retry outlives the edited source's successful render                        |
| DT3   | P3       | display-transform | A reply finished behind the bookmark modal counts as viewed                             |
| JR3   | P3       | journal-recovery  | The split-commit test passes with the collector's `unconfirmed` guard removed           |
| R1    | P3       | audit-fixes       | Three guide statements contradict the audit fixes (corrected here)                      |

Reports, briefs, and the per-seam probe logs are kept outside the repository at
`/home/codex/review-reports/cross-plan-2026-10-29/` (`reports/`, `briefs/`). The probes that
reproduce the findings are under [`cross-plan-2026-10-29/probes/`](cross-plan-2026-10-29/probes/):
they are Vitest files renamed `*.probe.ts` so the gate does not collect them. To run one, copy it
beside the module it imports from (the original path is in its header or in the finding below) with
a `.test.ts` suffix and run `pnpm --silent test:agent <file>`; each asserts the expected behavior and
fails at HEAD.

## Method

- Eight detached worktrees at `8ea35c16e` under `/home/codex/worktrees/review-<seam>`, each with its
  own `node_modules`, removed after the review. One reviewer per worktree, in parallel.
- Reviewers and models: `journal-recovery`, `chatstore-sync`, `server-jobs` (GPT-6 Astra, `xhigh`);
  `audit-fixes`, `display-transform`, `memory-hypav3`, `client-ui`, `server-misc` (GPT-6.1 Sol,
  `xhigh`). Each received a brief: a common contract (read-only rules, the finding rubric, a required
  reproduction for every P1/P2, an improbable-or-costly bucket kept apart from findings, five
  break-tests of the seam's most important tests, a fixed report shape) and a seam section (commits,
  key files, owning guides, plan texts, prior audits, recorded decisions, and a checklist that every
  item of had to get a coverage row). The Sol briefs' checklists were written as enumerated,
  mechanical questions; the Astra briefs' as questions plus "what the list does not name".
- Seams: `journal-recovery` (draft journal, recovery, composer drafts, request identity; Durable
  Drafts × Job Protocol), `chatstore-sync` (chat store, save adapter, conflict merge, feeds, boot
  cache, asset preflight; Durable Drafts × Boot Bytes × Deep Audit Fixes), `server-jobs` (receipts,
  request ids, sequences, liveness, Stop, trigger merge), `audit-fixes` (the thirteen fix commits,
  each verified against its audit finding, its regression test reverted-and-run, and its flow checked
  for a regression), `display-transform` (cache keys, scope loader, skip predicates, provisional
  corrections, `knownKey`/`same`, plugin handlers, recovery), `memory-hypav3` (token budget, deferred
  summaries, response budget, context report and meter, modal, four assembly fixes), `client-ui`
  (popup editor, IME guards, input translation, stale async results, LoRA editor, scroll hold,
  lorebook and persona fixes, Realm terms, build id, push key), `server-misc` (precompressed static
  files, listing compression, vector cache, sqlite durability, push throttle, LLM retries, build info,
  drivers and guide text).
- Every reviewer's worktree ended with no tracked change (`git status --porcelain` showed only its
  probe files). The session re-ran each reproducing probe with `--force`, read the product code it
  exercises, and assigned the priorities below.

## Findings

### JR2 — Typing a follow-up erases an unanswered send's journal row

**Code.** `src/ts/process/composerDrafts.svelte.ts`: `beginSend` writes the hand-off
(`state: "sending"`, `userMessageId`, the request id and epoch) under the chat's composer key;
`write` (the debounced composer write) calls `journal.putComposer(key, value)` for a nonempty draft
under the same key, replacing that row; the empty-draft branch's `removeComposer(key,
{ keepSendingIds })` keeps a row only while it still carries the sending id. The plan's D10 chose one
row per chat key ("the later write wins").

**Trigger.** Send a message while the create stays unanswered (a stalled link, the scenario the
journal exists for). Type a follow-up in the composer, which stays enabled; after the 500 ms debounce
it replaces the hand-off row. Clear the follow-up: the empty flush deletes the row. Reload while the
send is still unanswered: neither the original text nor its request id comes back, so the message is
lost and a retry would be a new create.

**Reproduction.** `probes/JR2-DefaultChatScreen.recovery.probe.ts` (original path
`src/lib/ChatScreens/DefaultChatScreen.recovery.probe.test.ts`): a mounted `DefaultChatScreen` with
the real composer, send, store, and journal modules on `fake-indexeddb`, the create held at the
transport seam. At HEAD: `journal while original send is pending: {"input":"A possible
follow-up",...}`, `journal after clearing follow-up: null`, `input after reload: ""`;
`expected '' to be 'Long original message that has not reached the server'`.

**Direction.** Keep an unacknowledged hand-off apart from the editable composer row (its own key or
layer) and settle it by its attempt identity, as the existing `keepSendingIds` intends.

### UI-01 — A preset field's popup writes back into the preset resolved at close

**Code.** `src/lib/UI/GUI/TextAreaInput.svelte` `openPopupEditor` writes the popup's value back when
the field is still current: same run, same value, same `popupEditorContext` and context revision.
`src/lib/Setting/Pages/PromptPresetSettings.svelte` binds `moduleIntergration`, `mainPrompt`,
`jailbreak`, and `globalNote` through `activePreset` (the open chat's bound preset, else the tab's
selected preset; `settingsViews.svelte.ts`) with no `popupEditorContext`. The persona fields pass
`activePersona.id`, the guard added for the persona note.

**Trigger.** Select preset B at home, open a chat bound to preset A; both have an empty Module
Integration field. Open Prompt settings → Module Integration, expand the popup, type. Press the Home
hotkey (Ctrl+H by default; hotkeys still run with the popup open): the chat closes, Settings and the
popup stay mounted, `activePreset` resolves B, and every guard still holds because the field's value
is unchanged. Close the popup: B receives A's draft through the normal settings save.

**Reproduction.** `probes/UI1-PromptPresetSettings.review.probe.ts` (original path
`src/lib/Setting/Pages/PromptPresetSettings.review.probe.test.ts`): the real settings page and popup,
the real hotkey dispatch through `initHotkey`, real preset and chat stores. At HEAD: `SAVED PRESETS
[{"id":"a","moduleIntergration":""},{"id":"b","moduleIntergration":"draft for bound preset A"}]`.

**Priority.** Silent corruption of another record, but the trigger needs a hotkey or a binding change
while a popup is open and an equal starting value; P2. The fix is the recorded rule for
selection-resolved editors (pass the record id as `popupEditorContext`), applied to the preset
fields and to any other selection-resolved editor a sweep finds.

### DT1 — A permanent display failure retries and toasts every round

**Code.** `src/ts/parser/transformClient.ts`: `sendBatch` settles a source over
`MAX_TRANSFORM_TEXT_BYTES` as `{ ok: false }` without a request; `postOnce` turns any non-OK HTTP
answer into a plain `Error`; the completion handler registers every `ok: false` message display with
`markDisplayTransformFailed`, and `settle` shows the `serverTransformFailed` toast once per batch.
`src/ts/parser/displayTransformRecovery.svelte.ts` doubles the delay to 60 s and has no terminal
classification or attempt bound; each round clears the map, the mounted row rerenders, and the same
failure registers again.

**Trigger.** A mounted message whose display text exceeds 512 KiB (an imported transcript or a long
generated message; no malformed record). While it stays on the visible page, the row rerenders and
the toast repeats each round: 5, 10, 20, 40, then every 60 s. A server-side permanent refusal repeats
the request as well, and for an oversized shared transcript the server re-reads it each time.

**Reproduction.** `probes/DT1-3-displayTransform.review.probe.ts` (original path
`src/lib/ChatScreens/displayTransform.review.probe.test.ts`), cases "permanent source-size refusal
keeps retrying while mounted" (`rounds [0..6]`, `failureNotices 7`, `requests 0`) and "an HTTP 400 is
retried indefinitely with new requests" (`counts [1,2,3,4,5,6,7]`).
`probes/DT1-server-displayTransform.review.probe.ts` (original path
`server/src/tests/displayTransform.review.probe.test.ts`) measures three repeated requests for a 65
MiB transcript: `transcriptReads 1, 2, 3`, about 120–175 ms each, no snapshot retained.

**Direction.** Keep the failure's kind through the local refusal and the HTTP status; retry transient
failures only, and wait for a source or context change or an explicit Re-render after a permanent
one. The recorded 5–60 s policy stays right for transient failures.

### JR1 — A landed send deletes an identical draft's journal row

**Code.** `composerDrafts.svelte.ts` `write` asks `retryIdFor(key, text)` and tags the draft with the
in-flight send's `userMessageId` when the texts are equal; `settleSend(landed)` then
`removeComposer(key, { userMessageId })`, which removes that tagged row too.

**Trigger.** Send a short message such as `continue`; type `continue` again while it is in flight
and let the debounce commit; the first send lands. The new draft's row is gone, the input still shows
it, and nothing writes it again until the next edit. A reload before that edit loses it.

**Reproduction.** `probes/JR1-composerRecovery.probe.ts` (original path
`src/ts/process/composerRecovery.probe.test.ts`): `journal after settlement: null`, `composer
restored after remount: ""`.

**Priority.** P3 (the reviewer said P2): the text must be identical and the loss window ends at the
next edit. Same root as JR2 (text equality standing in for attempt identity); fix them together.

### SJ1 — Boot discovery drops the ended status it read

**Code.** `src/ts/process/serverCommands.ts` `discover` returns only `{ chaId, chatId }` from a
successful status read, discarding `terminal`, `state`, and `kept`; `followJobToEnd` then runs
`followOnce` with no known terminal, while owned create replays keep theirs in `replayedStatuses`.

**Trigger.** A saved job ends (or the server restarts and keeps a shutdown receipt) while the tab is
away; the tab boots, reads the ended status, and the connection drops before the follow's attach;
the attaches and status reads fail until the budget is spent. The job ends as `lost` with the
`serverJob.lost` notice instead of its kept outcome (the shutdown reason, the sequence progress, or
`done`), and the saved job is forgotten.

**Reproduction.** `probes/SJ1-serverCommands.review.probe.ts` (original path
`src/ts/process/serverCommands.review.probe.test.ts`): `PROBE
{"statusReads":6,"attaches":5,"errors":[["job lost"]],...}`.

**Priority.** P3 (the reviewer said P2): a wrong notice in a narrow window; the chat is marked stale
and read again either way. The fix is small: carry discovery's status into the follow.

### DT2 — A failure's retry outlives the edited source's successful render

**Code.** `displayTransformRecovery.svelte.ts` `markDisplayTransformSucceeded` deletes a failure
only when its generation is older than the success's. The failure map is keyed by chat and message
and stores one generation; a message edit changes the source and cache identity without calling
`rerenderMessage`, so the edited source's success has the same generation and cannot retire the
older failure. The next round rerenders the row (`Chat.svelte` calls `rerenderMessage` and bumps
`chatBodyRevision`).

**Trigger.** A transient failure (a 503), then an edit of that message within the retry window (or
its saved edit from another tab), then its successful render. The old round rerenders the row:
rendered HTML is replaced, which resets any typed form input and re-rolls random, clock, or plugin
output.

**Reproduction.** `probes/DT1-3-displayTransform.review.probe.ts`, case "successful replacement of
a failed source in the same generation still retries": `before 2, after 3, sameInput false, value
"initial"`.

**Priority.** P3 (the reviewer said P2): three conditions inside a short window, and the visible
effect without an in-message form is one redundant rerender. Not the fixed U2 case (the explicit
Re-render advances the generation), and changing `>=` to `>` would break the tested rule that one
target's success must not retire another target's failure in the same row; a fix tracks the failed
source identity as well.

### DT3 — A reply finished behind the bookmark modal counts as viewed

**Code.** `src/ts/process/chatStatus.svelte.ts` `visibleChatKey` returns null only for a hidden
page, open Settings, or the grid; `noteJobDone` adds no unseen mark while it returns the chat's key,
and the visibility watcher clears recovery marks on the same predicate. `App.svelte` mounts
`BookmarkList` over the chat with a fixed full-page backdrop.

**Trigger.** Open the bookmark list while a reply generates in the same chat and browse until it
finishes: no unseen marker.

**Reproduction.** `probes/DT1-3-displayTransform.review.probe.ts`, case "completion behind the
full-screen bookmark modal is marked viewed": `modalOpen true, visible "owner\u0000own-chat",
unseen []`.

**Priority.** P3 (the reviewer said P2): a missing indicator. The fix adds the transcript-covering
modal state to the predicate; other full-screen modals over the transcript should be checked at the
same time.

## Test and documentation findings

### JR3 — The split-commit test passes with the collector guard removed

`src/ts/storage/tests/resourceSyncJournal.test.ts`, "commits the split before sending its first
5000 operations, then sends the remainder under a new id", starts `flushResources()` with the journal
commit held and checks for no dispatch after advancing zero milliseconds. The ordinary collector's
protection is `chatStore.svelte.ts` `if (resend.unconfirmed) continue;`; with that line replaced by
`if (false) continue;` the whole file still passes, because `flushResources`'s own dependency wait
(`resourceSync.svelte.ts`) masks the collector on the path the test drives. HEAD still has the
guard. `probes/JR3-break_test.py` case 3 performs the mutation, runs the file, and restores it.
Direction: hold the commit across a normal collection cycle and assert no prefix dispatch before
releasing it.

### R1 — Three guide statements contradicted the audit fixes (corrected)

- `docs/structure/persistence.md` listed the reconcile's `listRevisions` among the reads with no
  deadline; `eventFeed.ts` bounds it with `RECONCILE_DEADLINE_MS` since the Boot Bytes audit's U1
  fix.
- The same guide said by-id ops answered `missing` are settled without a draft; `chatStore.svelte.ts`
  `ackChatWork` hands those text ops to the conflict listener since the Durable Drafts conflict
  capture, and `resourceSyncChats.test.ts` checks the draft.
- `docs/structure/self-host-server.md` said imports preserve existing content-addressed asset files;
  `restoreValidated` and the module and card imports replace a damaged one since `91a1493cb`.

All three are corrected in this change.

## Reclassified and rejected

- Lowered: JR1 (P2 → P3), SJ1 (P2 → P3), DT2 (P2 → P3), DT3 (P2 → P3), for the reasons in each
  finding. UI-01 (reviewer P1 → P2): the corruption is real, the trigger needs a hotkey or binding
  change under an open popup plus an equal starting value, and the fix is a known one-line pattern.
- Rejected: the audit-fixes reviewer's R2, "restoring the removed `resumeSavedGenerations` leaves
  `generationJobs.test.ts` green". A dead-code removal needs no regression test; the Job Protocol
  audit's Resolution sentence, which said every finding but JP4 has one, now names U2 as well.

## Coverage by seam

Each report has a coverage row per checklist item; the summary here names what was checked and
found clean, so the next review spends its effort elsewhere.

- `journal-recovery` (3 findings): owner locks across reload and a second tab, orphan adoption,
  eligibility of credentials and free-text secrets, boot replay order (characters before orders,
  sent before newer intent, before-value and revision fences), the restore snapshot under its
  original epoch, recovery dialog Apply/Export/Discard including a failed delete after a recreated
  chat, the 16 MiB / 64 MiB / 48 h bounds, generation preflight against journaled-only chat work, and
  IndexedDB unavailable, quota failures, and deletion under a live tab (three passing probes).
- `chatstore-sync` (none): `recordMerge` units and item identity (edit versus delete, reorder plus
  edit, duplicate ids, required collections), a second 409 converging (`[409, 409, 200]` with every
  edit kept), delayed reads not overwriting newer local edits or a conflict merge, whole-read lock
  snapshots and the read stamp, boot cache invalidation and the store repair, the hello digest skip
  and its deadline, "last chatted" derivation, the asset preflight timeout falling through to upload,
  canonical asset repair keeping healthy files, the `refused` consumers, and the baseline-keys rule.
- `server-jobs` (1): request-id fingerprint and `requestIdReused`, receipts across a real reopen
  with pruning and epoch purge, `/multisend` part failure, Stop, and the single checkpoint, liveness
  and queued-root deadlines, cross-client Stop attribution and timeouts, chat-slot release across
  socket death and restart, the copied-session claim, the trigger map merge, and hub and client map
  bounds.
- `audit-fixes` (R1; R2 rejected): all thirteen commits mapped to their findings, each reproduction
  walked at HEAD, each product diff reverse-applied with the named regression test failing (except
  U2's removal), the new deadlines inspected for healthy-path firing, the message-versus-diff check,
  the Korean strings of the two fixes, five fix pairs checked for interaction (one passing combined
  probe), and 23 in-scope test files passing at HEAD.
- `display-transform` (3): the server key's inputs enumerated against every display read (table in
  the report; no read-but-unkeyed input), the character identity hash, the regex mode filter and CBS
  skip predicates against fenced, escaped, legacy, multi-line, and plugin-introduced CBS, the shared
  scope loader's pins and releases, the provisional hand-off, `knownKey`/`same` after edits of seven
  character fields and six singleton records, the tab result cache's identity and bounds, the plugin
  handler write inventory and the seeded permissions.
- `memory-hypav3` (none): 540 token-mode boundary combinations finite and bounded, the upstream
  export and import round trip (amounts survive to the two-decimal ratio at the exported `maxContext`,
  by the recorded policy), 90 synthetic deferred histories terminating without early summaries, the
  response reservation under a late 700-token system prompt and an image, the forecast against a
  0–400 token growth scan, blank-history exclusion, meter widths within 100 %, modal index remaps at
  the boundaries, the three `greetingText` readers, the overlapping-range copy under all four memory
  types, the refused-draft barriers, and 55 of 56 new keys translated (the one exception is a neutral
  `label: a → b` formatter).
- `client-ui` (1): the popup editor's sessions and the auto popup's persisted field (D2), the IME
  guard inventory (every composer, partial editor, dialog, and hotkey handler, both event orders), the
  input translation token at every call site, the LoRA editor across navigation, four stale-result
  sites, `runMessageJump` across staged rows, the scroll hold's quiet fallback and hidden-tab
  behavior, child-link activation and the plain-text persona note (S1), the Realm gate at every entry
  point, the build id's client imports and seven locales, the push key re-read, and sixteen new keys
  in Korean.
- `server-misc` (none): `Accept-Encoding` negotiation (q-values, `identity`, `*`, `br;q=0`), `Vary`
  on 200 and 304, representation ETags, stale siblings after a rebuild served as identity, Range and
  HEAD, traversal, the compression producer for all six extensions, the listing's old-client and
  truncated-body behavior, vector eviction with real-size vectors, every sqlite handle's journal and
  synchronous mode (resources FULL; receipts, vectors, request history NORMAL by decision), the push
  stamp across restart and the 50-entry cap, retry attempt and backoff bounds with the abort signal
  honored during waits, no duplicated streamed text across a retry, build info without `.git`, the
  development-flow commands, and the typed collector mock.

## Hypotheses not reproduced

Each was tried with a probe or an existing test and did not reproduce at HEAD; they are not
findings.

- Tool definitions consume provider context that the assembler's final recheck does not count
  (`AssemblyHost` has no tool-schema input; the OpenAI adapter adds `body.tools` later). Traced, not
  reproduced with a real tokenizer; recorded in the found-issues inbox as unverified.
- A trigger map merge erasing an independent variable; a sequence socket death leaking the chat
  slot; a cross-client Stop left pending after a timeout.
- A server display input read but not keyed; a regex or CBS skip misclassification; a never-corrected
  mixed render beyond the fixed DE1; a plugin durable write through a display handler or a boot
  permission escalation.
- Two tabs recovering the same journal group; an old restore snapshot overwriting newer server data;
  a missing-chat Apply duplicating its destination; journal failure blocking server saves.
- A delayed chat or record read overwriting a newer local edit; a second 409 looping.
- The popup editor's known teardown issue becoming ordinary edit loss; a LoRA edit lost on navigation;
  a stale input translation reaching another chat.
- A stale compressed sibling after a rebuild; the compressed listing breaking an older client; a
  retried streamed tool follow-up duplicating delivered text; a provider retry loop continuing after
  its job aborted.

## Noted, not recommended to fix

- `PopupEditor.svelte` recreates the textarea or the Monaco model when the mode switches after an
  edit: text survives, selection and undo history do not (probe `probes/N1-PopupEditor.review.probe.ts`:
  selection `[6,10] → [16,16]`, `canUndo true → false`). A shared history across a native textarea
  and Monaco is a larger design than the toggle's text-preservation contract. Recorded in the
  found-issues inbox for a decision (accept as a Limitation, or redesign).
- Hand-edited legacy ratio settings (`memoryTokensRatio: -0.2`, `extraSummarizationRatio: 2`) pass
  the legacy constructor and resolve to negative budgets; no settings-UI path produces them. Inbox
  entry, latent.
- The revision listing is still built, serialized, and compressed whole in memory; bounded pages are
  the deferred byte-budget work.
- `contextUsage.budgetReducedValue` has no Korean override; its output is `label: a → b` with a
  localized label, so nothing English shows.

## Test quality

Forty break-tests (five per seam), thirteen full fix reversals, and five extra assertion mutations
were run, each restored at once. Every selected test failed with its guarded line broken except the
split-commit test (JR3) and the dead-code removal (R2, rejected). Observations against V3 (gate tests
depending on real time or the scheduler), none of which failed in these runs, are recorded in the
found-issues inbox under "Test timing": `draftJournal.test.ts`'s start and adoption cases run the
real 3 s open and 5 s recovery-lock deadlines; HypaV3 parts selection cases run under the real 5 s
separator budget; `transformService.test.ts` polls with a real `setTimeout(2)` and sleeps 5 ms;
`transform.test.ts`'s worker route cases race real worker deadlines; `bootCacheServer.test.ts` runs
the real 3 s cache deadline; `backups.test.ts`, `push.test.ts`, `resourceStore.test.ts`, and
`diagnostics.test.ts` keep real sleeps; `Chat.draft.test.ts`'s auto-popup cases use real
`vi.waitFor`; `generationJobs.test.ts` and `serverCommands.test.ts` use zero-delay real-timer flush
helpers.

## Verification and limits

- The reviewers ran no browser, e2e, dev stack, build, or whole unit suite (the machine was shared
  eight ways): every reproduction is a Vitest probe at the module or mounted-component level, and
  the device and browser behaviors the plans left open (Android PWA kills, bfcache returns, real IME
  traces, physical wheel events) remain open.
- The session re-ran the eight reproducing probes at HEAD after the reviewers finished
  (`--force`); all failed as reported. Focused existing test files run by the reviewers at HEAD all
  passed (300, 357, 365, 344, 277, 199, and 23 files' worth, per report).
- The 8 worktrees were removed after the reports and probes were copied; nothing from them was
  committed.
