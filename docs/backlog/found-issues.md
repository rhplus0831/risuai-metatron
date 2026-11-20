# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, the twenty-third (the Lore Budget Send Stop run) the same day, the Generation Progress Window run's two findings the same day, and the OOC Session run's two findings the same day, the Remote Host run's finding on 2026-11-16, the Completion Notification After Plugin Work run's finding the same day, and the Sidebar-Only Chat Binding run's finding on 2026-11-17, the Request Interception run's two findings on 2026-11-18, and the Structured Memory Story Dates run's two findings the same day, and the Timeline Reading View run's finding on 2026-11-19, and the Timeline Chapter Synopses run's four findings the same day, and the Response Checks run's finding on 2026-11-20; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

The nineteenth batch and the eight entries of the 2026-11-10 full guide audit (twelve in all) were cleared on 2026-11-10 by Sol implementers and test writers in three worktrees with session verification: eight fixed with regression tests (three in the plugin sandbox, style scoping, the popup editor's row, the chat export's candidate receipts, memory task job ids in shares and reports, the e2e program in `pnpm check:changed`), the dead boot fixture capture driver deleted, the wasmoon upgrade note moved to its module, the checkpoint benchmark given its place in the audit report, and the full-screen alert e2e failure closed as the dev stack's reload on file edits (8 of 8 quiet runs passed; a run under Markdown touches failed the same way).

The twentieth and twenty-first batches, a build entry, and one finding still in memory (eight in all) were worked on 2026-11-12 by Sol implementers and test writers in three worktrees with session verification: five fixed (the pdf.js character map URL, the Korean export line, the history jump's scroll and the refresh scan with regression tests, the eval's capture beyond titles); the on-demand timeline count tried and reverted as not worth its cost (`b29a883a5`, `bb2ede7d6`; the read guide's Limitation has the numbers); the read round's byte charge reproduced and moved to [known issues](known-issues.md#structured-memory); and the timeline heading reworded the same day by the owner's decision (`the last ones may already be in the messages below`).

The twenty-second batch is the first wave of the wide review of 2026-11-14 at `05df12543` (eleven read-only reviewers
by area, then a second reader of another model for each report with a finding): five new entries, each reproduced by
both readers with a probe test kept with the review material outside the repository, and runtime results added to the
preview, HypaV3 checkpoint, and lore limit entries below and to the restored-row entry in
[known issues](known-issues.md#structured-memory). The tokenizer entry was in memory since 2026-11-12.

The twenty-third batch is the second wave of the same review (2026-11-14, twelve reviewers: six over the server's
routes, five re-reading the fixes made since 2026-11-05, one running the guides' unconfirmed claims; a second reader
for each of the eleven reports with a finding): seventeen new entries below, each reproduced by both readers except
the one marked P3, and three confirmed claims moved from the guides' Issues to [known issues](known-issues.md).

The twenty-second and twenty-third batches were worked on 2026-11-14 by implementers and test writers in seven
worktrees with session verification (each new test was run against its fix reverted, then the whole suite on the
merged branch): every entry of the two batches was fixed with a regression test except the three below. The message
search keeps one cost: a hit in a single message of 16 MiB still takes about two seconds to build its snippet. Two
siblings the implementers found were fixed with them (the tab's MCP client and the tab's lore preview), and the three
confirmed claims left [known issues](known-issues.md) fixed.

The twenty-fourth batch is the third and fourth waves of the same review (2026-11-14). Wave 3 swept eight
repository-wide invariants and ran the manual checks an agent can run: 25 findings, every one confirmed by a second
reader. Twenty-two were fixed the same day with regression tests, without passing through this file (script
permissions on the server, destinations captured before a wait in the tab and its components, card and module format
round trips, credentials in the settings report and the request log, names and translated text in HTML exports); the
three that need a decision or real providers are entries below. Wave 4 broke the rules of six areas one at a time to
see whether a test fails; the tests it found missing were written the same day. The review's method, counts, and cost are in [its report](../reports/audits/codebase/wide-review-2026-11-14.md).

The entry on thirteen remote calls of the tab that bypassed the request wrappers was fixed later the same day: the
buffered calls go through `globalFetch`, and Stability's multipart form, the Chub download, and `#import=` card links
through `fetchNative`, which keeps their bytes and streams; a GET through `globalFetch` no longer gets a default JSON
content type, which would make a cross-origin plain fetch need a CORS preflight. The calls that need a provider key
are in [manual checks](manual-checks.md#real-providers-and-external-services).

The entry on a chat panel's `style` element was closed the same day by the owner's decision: a panel that carries one
asks for the plugin's new `globalStyle` permission and is shown without it when declined
([permission list](../structure/plugin-sandbox.md#permission-list)). The inline styles and class names it left open
are the Plugins entry below.

The twelve entries left on 2026-11-15 were worked the same day by Sol implementers and test writers in five worktrees
with session verification (each new test was run against its fix reverted, then the whole suite on the merged branch).
Nine were fixed with regression tests or, for the two test-tooling entries, by a run of the repaired test or driver: a
tool call the request did not offer, the special token at the auto-continue count, the `OobaLegacy` string stream (Half
Streaming stays off for the format, in [deferred work](deferred-work.md#generation-progress-window)), the greeting
rebuild, the full OOC log race, the plugin chat panel (the owner's decision: paint containment, no new permission), the
dead `onCharacterSelected` hook, the working-tree listing test, and the job handoff driver's consent
(`measurePluginData.mjs` had the same gap and was fixed with it). The OOC race was not fixed as the entry suggested: a
log of 201 exchanges can consist of entries `oocPrune` protects, so the stored limit got a slack of 16 over the ask
limit and nothing is dropped. The whole-chat replacement entry was closed: no caller in `src/` or `shared/` builds the
next chat from a partial field list (`editChat` and `editChatSync` clone the baseline; copy, branch, and import spread
the whole chat; the two plugin setters forward the whole chat the plugin read), and the persistence guide does not
carry the plan's absolute claim. The tokenizer entry was narrowed to what is left below, and the `@import` entry stays
by the owner's decision.

The twenty-fifth batch is the Remote Host post-audit of 2026-11-16 at `56c612168` (four read-only verifiers, one per
contract boundary, then a second reader that tried to refute each P1 and P2): eight entries below, the six P1 and P2
ones each reproduced by a probe test kept with the review material outside the repository. The method, the cost, and
the ratings are in [its report](../reports/audits/finished-plans/remote-host-2026-11-16.md).

Seven of the eight were fixed the same day by the session that ran the audit, each with a regression test that was
run against its fix reverted, together with the Remote commands entry the plan's run had left (a host's `uncertain`
report now marks the command attempted): a marked send keeps its request id through a `stale` or
`chatBindingMismatch` refusal, the relay ignores a late `running` of an attempt already reported `uncertain`, the
relay has a total bound on entries and retained bytes, the speaker left the relay's identity, a shortened report text
no longer ends inside a surrogate pair, a leave control sits above the alert layer while an overlay covers the host
lock screen, and the help text names Continue and the reroll of a single reply. The send preflight's unbounded wait
predates the plan and is the Network jobs entry below. The two verifiers whose cuts the fixes touch read them again:
the relay's reader found that a reload recovery's result-less `uncertain` still erased a stored result and that a
result could grow past the body cap when parsed (both fixed with tests), and that the relay's identity still differs
from the generation's for field combinations no caller sends, which is the Remote commands entry below.

The twenty-sixth batch is the fork data-loss cross-check of 2026-11-17 at `003f367fc`: 233 failure scenarios taken
from the data-loss fixes of four other RisuAI forks, each checked against this app by a read-only reviewer per
subsystem, then a second reader that tried to refute each P2 finding. Seventeen entries, each marked
`cross-check F<n>`. They came from static reading only: none had been reproduced by a test when it was filed. Each
entry said who read its code. The method, the verdict counts, and the findings that were not filed
(four that are documented design, five P3 ones nobody challenged) are in
[its report](../reports/surveys/fork-data-loss-crosscheck.md).

All seventeen were reproduced the same day at `5f8b0b191` and moved to [known issues](known-issues.md), each under its
owning guide: one probe test per entry, written by five agents in separate worktrees, with a defect case that failed
and a control case that passed, and each probe run a second time by the session. Fifteen reproduced as filed; the
import entry (F10) and the module export entry (F16) reproduced narrower, and several descriptions were corrected
against the code. The module export entry's encoder was then run in headless Chrome and did what the entry said.
Sixteen of the seventeen were fixed the same day and the last is a Limitation of the plugin guide
([known issues](known-issues.md) has the account). The six entries marked "fix round of 2026-11-17" below are what
that round's implementers read next to their fixes and left: none was run.

The twenty-seventh batch is the post-verification of seven retired plans of 2026-11-18 at `504a7af45` (one read-only
verifier per plan, then a second reader that tried to refute each P1 and P2): twenty-four entries below, each marked
"post-verification of 2026-11-18" with the finding's id. The seventeen P1 and P2 findings that stood were each
reproduced by a probe kept with the review material outside the repository and traced by both readers; the P3 ones
were filed by one reader and not re-read, and are grouped where they are alike. Two filed findings have no entry: a
plugin's refused edit of a locked reply is in the plugin guide, and a hook's screen-local busy state is the plan's
own decision. The method, the cost, and the ratings are in
[its report](../reports/audits/finished-plans/plan-post-verification-2026-11-18.md).

Sixteen of the findings were fixed the same day, each with a regression test that was run against its fix reverted,
and the ten guide sentences were written: the headless host trusts only the local listener's own key, keeps its
restart wait through the time a page is down, reads Windows environment keys in any case, and keeps a console
message's position; Send Draft follows the local send state; a template drag stays on its preset; the catalog's trash
button removes the row its dialog named and the module's own button clears a repeated id; the picker shows a folder's
enabled count; a literal prompt's popup (a request interception rule, a hook prompt, a translator step) opens as
plain text; the compaction rules carry the rule against day-relative words; the Timeline row keeps a sparse event's
date and ordinal; the time limit box shows the clamped value; the request context type names the hold; the group
notification test tells its two speakers apart. Each verifier then read the fixes of its own findings: all closed
their triggers, and what the verifiers found beside them is in the six narrowed entries below (one thing is not: a
time limit box that is emptied stays blank while the server stores the default). Seven entries are
kept as recorded by the owner's rule for that round (a fix whose cost is out of proportion to how often the trigger
happens is not made); each says so.

The twelve findings of the [structure audit of 2026-11-18](../reports/audits/guides/structure-audit-2026-11-18.md) sat in `docs/research/found-issues.md`, outside this file's counts,
until 2026-11-20. The seven it had exercised in an isolated run moved to [known issues](known-issues.md), the HypaV2
entry among them; the four it had only read and its stale test header are entries below, each marked "structure audit
of 2026-11-18"; its settings drag finding joined the Settings entry on a row drag. None was run again at the move.
The audit also retired the plugin guide size warning and verified that the JSON, Markdown, snapshot and checkpoint
validators reject unknown event statuses.

## Contents

- [Backup and sync](#backup-and-sync): 5
- [Build and CI](#build-and-ci): 1
- [Chat screen](#chat-screen): 6
- [Docs](#docs): 2
- [Headless host](#headless-host): 2
- [LLM requests](#llm-requests): 3
- [Memory](#memory): 6
- [Modules and personas](#modules-and-personas): 4
- [Network jobs](#network-jobs): 2
- [Plugins](#plugins): 1
- [Remote commands](#remote-commands): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 2
- [Settings](#settings): 4
- [Tests](#tests): 2
- [Translation](#translation): 1

## Backup and sync

### HTML chat exports can fail to import or change the original message text

Two export/import round trips reproduced this on 2026-11-18. A chat with the default empty note exported successfully,
but importing the HTML reported “No Data” and added no chat. With a nonempty note, a message containing literal
`&lt;tag&gt; &amp; &#65;` was imported and saved as `<tag> & A`. The embedded JSON escapes angle brackets but leaves
ampersands untouched. The importer reads the HTML parser's decoded text and requires a truthy note.
[Exporter](../../src/ts/characters.ts#L432), [importer](../../src/ts/characters.ts#L686).

**Why it matters.** Someone transferring a transcript can see a successful import with different message text.
The original chat survived when the test imported back into the same character. JSON export/import is a workaround.

**Suggested handling.** Encode the embedded JSON so its text round-trips, and accept an empty string for a valid
note. Cover both cases by feeding the actual HTML download back to the importer.

### The upstream export's list of metatron-only settings misses newer fields

`METATRON_ONLY_SETTINGS` in `server/src/data/upstream/exportDatabase.ts` says it lists the settings upstream's
`Database` lacks, but the newer metatron-only `ui` fields never joined it: `contextMeter`, `contextMeterTurnUnit`,
`contextMeterFixedWarn`, `contextMeterLookahead` (added in `630ba6396`), and `completionWaitMaxSeconds` (the Completion
Notification After Plugin Work plan). None of them is in upstream's `Database` at `669b12ce`. They reach the upstream
`.bin` export through `projectSections` (`server/src/data/databaseProjection.ts`) and are neither stripped nor
reported under the export report's `metatron-settings` exclusion. Found 2026-11-16 by slice 2 of that plan.

**Why it matters:** low impact (upstream ignores unknown root fields), but the export report undercounts what is
metatron-only, and the list's promise is false.

**Suggested handling:** add the five fields to the list, and add a test that compares `SECTION_FIELDS` with
upstream's `Database` keys (or a kept snapshot of them) so a new metatron-only field cannot drift past it again.

### A partial native backup leaves out an asset only a plugin's data references

Fix round of 2026-11-17, read and not run. The compatible export now follows asset keys inside retained plugin values
(`collectUpstreamAssetReferences`, `server/src/data/upstream/assetReferences.ts`). The partial native backup selects
its files from its own, deliberately limited inventory (`selectPartialBackupAssets`, `shared/backups.ts`, and
`src/ts/drive/backuplocal.ts`), which does not read plugin data. The full native backup takes every asset on disk.

**Why it matters:** a restored partial backup can hold a plugin value that names a file the archive does not hold.

**Suggested handling:** reproduce first; then feed the same walker into the partial selection, or say in the partial
backup's notes that plugin-referenced files need the full backup.

### The boot cache keeps its own copy of the resource id rule

Timeline Chapter Synopses run, 2026-11-19, from slice 1; read, not run. `isValidResourceId` moved from
`server/src/data/resourceStore.ts` to `shared/resources.ts` (the store re-exports it), so the tab can import it.
`src/ts/storage/bootCache.ts:38-55` still holds a hand-copied duplicate (`MAX_RECORD_ID_LENGTH` and the function),
with the comment "Match isValidResourceId in server/src/data/resourceStore.ts".

**Why it matters:** the copy can drift from the server's check, and its comment names the rule's old home.

**Suggested handling:** import `isValidResourceId` from `shared/resources.ts` in `bootCache.ts` and drop the copy.

### Journal recovery can replay an edit after a newer chat revision

Structure audit of 2026-11-18, read and not run. `recoverJournal` reads the boot summary revision before it awaits the
full chat, and for pending by-id edits it classifies the returned body with that earlier revision. A pending append
whose id is still absent can replay after another writer changed the chat, although the recovery classifier would
file a draft with the newer revision.
[Recovery decision](../../src/ts/storage/journalRecovery.ts#L1335) ·
[Classifier](../../src/ts/storage/journalRecovery.ts#L567) ·
[Server acceptance](../../server/src/data/chatStore.ts#L2237)

**Why it matters:** a recovered edit can land on a chat that another tab or device changed in between.

**Suggested handling:** reproduce with a write that arrives during the boot read; then pair the full body with its
installed revision.

## Build and CI

### The CI workflow still names `metatron` and pins its actions by tag

Read on 2026-11-20 at `bcc698905`, in the file only. `.github/workflows/ci.yml` runs for pushes to `metatron` and
`main` and for pull requests that target them. `metatron` was renamed `main`, so that trigger names a branch that no
longer exists. The workflow's three actions are pinned by tag (`actions/checkout@v5`, `actions/setup-node@v5`,
`actions/cache@v4`), not by commit hash. Not checked: whether the forge runs this workflow at all.

**Why it matters:** low. A stale trigger does nothing; a tag can be moved to other code by the action's publisher.

**Suggested handling:** drop `metatron` from the triggers and from
[the build guide's sentence](../structure/build-test-platforms.md#ci); pin the actions by hash if the workflow is in
use.

**Decision:** owner, 2026-11-20: `dev` stays out of the triggers on purpose, and the guide's CI section now says so.
That part of the entry is closed; do not file it again.

## Chat screen

### Back and forward between multi-reply bundles swaps the messages only

Fix round of 2026-11-17, read and not run. A removal reroll now restores the variables its removed replies changed.
`move` in `src/ts/process/rerollHistory.ts`, which steps back and forward between the stored bundles of a multi-reply
turn, still swaps the message bundles and leaves the chat's variables as the shown bundle did not set them.

**Why it matters:** after stepping back to an earlier bundle, counters and flags are those of the bundle that was
shown last, the same drift the reroll fix removed.

**Suggested handling:** reproduce with a two-speaker turn whose replies change a counter; then keep each bundle's
variable values with it, as the recovery path now does.

### The expanded editor popup and two small editors still lose their text on a remount

Fix round of 2026-11-17, read and not run. The message editor and the stored-translation editor now keep their text in
tab memory (`src/ts/storage/messageEditorDrafts.svelte.ts`). Three other surfaces keep theirs in component state: the
manually expanded popup of `src/lib/UI/GUI/TextAreaResizable.svelte` (it discards unreturned text when destroyed), the
partial-edit popover, and the editor of a rendered (cached) translation in `src/lib/ChatScreens/Chat.svelte`.

**Why it matters:** the same loss as the fixed entry, on less used surfaces.

**Suggested handling:** reproduce each; the popup can hand its text back to its owner on destruction.

### Sending newer text overwrites a failed send that was waiting to be placed back

Post-verification of 2026-11-18 (IH-1), reproduced by two readers; older than the Input Hooks plan, which widened it. A chat has one send hand-off row and one in-memory entry (`putComposerSend` in `src/ts/storage/draftJournal.ts`, `sendDraft.ts`). When a send fails before its user message lands while the composer holds newer text, the failed text is not placed back and stays only there. The next send of the newer text overwrites both, and its success removes the row. The first text is then in neither the composer, the journal, nor the chat. Since the plan, a failed draft send is also kept out by a newer draft, translation, or attachment alone, and its row holds both boxes.

**Why it matters:** the user loses a message they wrote (and, for a draft send, the reviewed draft) without a notice. It needs a send that fails while the user has already typed the next message.

**Suggested handling:** kept as recorded by the owner's rule for the fix round (the trigger is uncommon and the fix adds a second kept snapshot to the journal and its budget). If it is taken up: keep the displaced snapshot under its message id and offer it through the composer's recovery.

### A send that fails after a Settings round trip is not placed back until the chat is shown again

Post-verification of 2026-11-18 (IH-3), reproduced by two readers; older than the Input Hooks plan, which extended it to a draft send's whole snapshot. Opening and closing Settings remounts the chat screen. A send that was pending across the remount settles into the destroyed composer (`placeSend` in `src/ts/process/composerDrafts.svelte.ts` returns on `destroyed`), and the new screen is not told.

**Why it matters:** the composer stays empty after the refusal. The text is in the hand-off row and returns on a chat switch, another remount, or a reload.

**Suggested handling:** kept as recorded by the owner's rule for the fix round. If it is taken up: have `settleSend` notify the mounted composer of that chat to run its guarded restore.

### Opening a message's inline editor moves the transcript before any save

Seen on 2026-11-18 in headless Chrome by both reviewers of the chat scroll fixes (`ec7b2a8eb`), and listed under
[Left open](../reports/surveys/fork-chat-scroll.md#left-open) in that report; their runs are kept with the review
material outside the repository. With the reader scrolled 300 px up inside the newest message, the click that opens
that message's editor moved `scrollTop` to about 0, before any save. The cause was not looked for. It may be the row's
body being replaced by the editor: a collapse the browser's scroll anchoring answers, like cause M1 of the report. The
fix for M1 keeps a row's height only when its `Chat` is mounted again (`keepRowHeight` in
`src/lib/ChatScreens/Chats.svelte`), and opening the editor does not remount it. `Chats.svelte` has not changed since
that commit; the case was not run again when this entry was filed on 2026-11-20.

**Why it matters:** a reader who starts to edit the passage they were reading loses their place.

**Suggested handling:** reproduce it first, with `docs/reports/surveys/fork-chat-scroll/probeChatScroll.mjs` as a
base, and find which element changes height when the editor opens.

### The context meter's memory and history segments are nearly the same color under deuteranopia

Computed on 2026-11-20 while the lorebook and character group colors were picked, not looked at on a device. In
`src/lib/ChatScreens/ContextMeter.svelte` the memory segment is `bg-secondary-500` (`memoryColor`, `#8b5cf6`) and the
history segment `bg-primary-500` (`#3b82f6`), and the two sit next to each other in the bar. A palette validator gave
the pair an OKLab ΔE of 1.3 under simulated deuteranopia, against a target of 8, and 12.0 under normal vision, against
a floor of 15. The two group colors (`--color-meter-lore`, `--color-meter-character` in `src/styles.css`) were checked
against both and pass; these two were left because only the group colors had been asked for.

**Why it matters:** the legend's labels and numbers still tell memory from history, but the bar's segments alone do
not for a reader with red-green color blindness.

**Suggested handling:** the owner decides whether to change one of them. Both are theme colors used across the app,
so the meter would take a color of its own, as the two groups did, and not change the theme's.

**Decision:** owner, 2026-11-20: change it. The meter takes a color of its own for one of the two segments; the
theme's colors stay as they are.

## Docs

### Two entries of the plan audit re-check list no longer match the code

The "Re-check list" of `docs/reports/audits/plan-runner/README.md` says to drop or reword an entry once the code no
longer has the mechanism. Two entries may be stale, as read at `ace54e7da` by the read-only auditor of the Request
Interception plan (2026-11-18) and not run:

- "Feed rows are measured whole against `MAX_FEED_PATCH_BYTES`": chat rows can also travel as field-level `rowDelta`
  payloads (`server/src/data/chatStore.ts:1977`, `:2017`). A second audit the same day (the Structured Memory story
  dates plan, at `aafebc9c0`) did not question this entry and cited `chatStore.ts:1942` as measuring the whole
  manifest JSON, so this one may still hold.
- "`sendText` counts any open socket as a delivery": `sendText` now accumulates `sendSocket` success, and an
  overloaded open socket is terminated and returns false (`server/src/jobs/generationJobs.ts:1059`, `:1074`). The
  second audit read it the same way.

**Why it matters:** every full plan audit re-checks this list, so a stale entry sends auditors after a mechanism that
is gone or no longer universal.

**Suggested handling:** re-read both mechanisms, then reword or drop the entries in the README.

### The records guide says chapters sit outside every lifecycle walk

Timeline Chapter Synopses run, 2026-11-19, from slice 5; read. `docs/structure/structured-memory/records.md:240`
(Memory tables) says `memory_chapters` "sits outside the memory table group and all lifecycle walks". Since that run
the rebuild swap deletes a chat's chapters for every mode but backfill (`server/src/data/memoryStore.ts`, `swap`) and
the `/inherit` route copies them (`store.memory.chapters.copy`); the record walks of a restore, the package, chat
files, and checkpoints still skip the table.

**Why it matters:** a reader of the records guide would conclude that no lifecycle path touches chapters and miss the
swap's delete and the copy.

**Suggested handling:** reword the sentence to name the record walks that skip the table and point at
[lifecycle](../structure/structured-memory/lifecycle.md) and [rebuild](../structure/structured-memory/rebuild.md),
which describe the two paths that do touch it.

## Headless host

### A restart of the headless host's page loses a pending command's receipt

Post-verification of 2026-11-18 (HH-2), reproduced by two readers. A remote command's attempt is kept in the tab's `sessionStorage` (`src/ts/network/remoteHost.ts`). The script's own restarts (a crashed or closed page, a failed load, a dialog it cannot dismiss, the plugins-off reload) close the tab and open a new one (`openPage` in `util/headlessHost.mjs`), which has no record and a new client id. A remote "Reload page" keeps the tab and is not affected.

**Why it matters:** the requesting device waits two minutes and shows "no answer", and the relay keeps the entry until it drops it. No chat data is lost.

**Suggested handling:** kept as recorded by the owner's rule for the fix round (rare, and the fix changes where attempts are stored). If it is taken up: reuse the tab on a restart where the page is still alive, or keep attempts where a new tab of the same profile reads them.

### An uncaught page error from a script URL with a query loses its position in the headless host's log

Post-verification of 2026-11-18 (HH-5, what is left), read by one reader after the fix. A console message now keeps its line and column: its URL is redacted by itself and the position is appended. The `pageerror` handler in `util/headlessHost.mjs` still logs `error.stack` through the whole-line redaction, which removes everything after a `?` in each frame's URL.

**Why it matters:** on a dev stack, whose modules carry a version query, an uncaught error's stack names files without positions.

**Suggested handling:** redact each frame's URL by itself, as the console line does.

## LLM requests

### A command job's later parts use request interception rules edited after it started

Post-verification of 2026-11-18 (RI-2), reproduced by two readers. The parts loop of `server/src/jobs/commandRunner.ts` calls `runPromptSend`, which loads the job scope again (`loadJobScope` in `server/src/prompt/runner.ts`), so a rule saved while a `/multisend` command runs reaches its later parts. The plan says a job's later requests use the list the job started with; a group send keeps one list.

**Why it matters:** work already under way changes instructions between its parts. It needs a multi-part command and a rule edit during it.

**Suggested handling:** kept as recorded by the owner's rule for the fix round. If it is taken up: capture the list at command setup and hand it to each part; otherwise reword the guide to say a command's parts each read the list.

### A buffered answer the response checks reject fails without its request id

Found 2026-11-20 during slice 2 of the Response Checks plan (raised by its challenger, confirmed by reading; not run in the app). Both outer loops turn a rejected buffered `success` into `da = { type: "fail", result: rejection }` (`server/src/llm/outer.ts:212`, `src/ts/process/request/request.ts:497`), which drops the attempt's `request` (and `model`, `special`). Once `requestRetrys` runs out, `runSpeaker`'s `throwError` gets no `req.request`, so the send's failure carries no `requestId` or `providerCode`, unlike any other request failure and unlike a rejected stream, which keeps its id.

**Why it matters:** the failure of a too-short or banned-script buffered reply cannot be traced to its request history row.

**Suggested handling:** keep the attempt's fields on the rejection's `fail` (spread the success without its `result`), in both loops, with a test that the final failure names the last request's id.

### Tab-side MCP tool discovery can keep fetching pages

Structure audit of 2026-11-18, read and not run. The tab's `MCPClient.getToolList` appends successive pages while a
remote server supplies a cursor, with no check for a repeated cursor and no limit on pages, tools, or bytes. The
server's client already enforces those bounds.
[Tab discovery](../../src/ts/process/mcp/mcplib.ts#L1047) · [Server discovery](../../server/src/mcp/client.ts#L874)

**Why it matters:** a malfunctioning service keeps discovery pending and growing until it is cancelled.

**Suggested handling:** give the tab's discovery the server client's bounds.

## Memory

### A long scene may make the send refuse its required memory block

Fix round of 2026-11-17, read and not run. A scene field may now stay as long as the user wrote it, up to 4,000
characters, and the send prompt shows every scene field whole in its required lane (`retrieve.ts` and `card.ts` under
`server/src/prompt/memory/structured/`). `card.ts` refuses a required block that is past its token target or the
memory maximum (`requiredOverLimit`) instead of cutting it. Three fields of 4,000 characters were possible before
the round too (the editor allowed them); what the round changed is that the writer no longer shortens them to 800.

**Why it matters:** not known until it is run: what the send does on that refusal, and at what scene size it happens
with the default budgets.

**Suggested handling:** run a send with three 4,000-character scene fields; then the owner decides whether the
editor's badge should also warn about it, or the block should be cut.

### The memory writer's field limit lets three scene fields pass the required-page limit

Derived on 2026-11-20 from the long-scene reproduction, not run. A send is refused once the scene's required page
passes the required-page limit (1,500 tokens by default), which the reproduction measured at about 1,982 Korean
characters in total, 661 per field. The memory writer's default limit for a new or short scene field is 800 characters
(`shared/structuredMemory.ts`), so three Korean fields the writer filled near its limit come to about 2,400 characters
and pass the limit without the user having edited anything. Whether the writer fills all three fields that far in
practice was not looked at.

**Why it matters:** every send in that chat fails until the user shortens the scene or raises the limit, and the
editor's badge counts characters per field, not tokens.

**Suggested handling:** the owner's separate decision (2026-11-20, kept out of the long-scene fix): give the writer a
token-aware limit for the scene, or lower its character limit for scene fields.

### The story-date anchor line can be dropped while dated lines stay

Structured Memory Story Dates run, 2026-11-18, from slice 2's challenger; read, not run. The anchor line ("Story date
at the newest record: ...") is part of the card's stable header (`renderParts` in
`server/src/prompt/memory/structured/card.ts`). With `volatileBeforeLastUser` the stable part goes through history and
the volatile part is placed after formatting (`step.ts`, `server/src/prompt/assemble.ts`), so a chat range that keeps
only the last message can drop the stable entry, anchor included, while volatile `(2 days ago)` lines stay; item
verification checks item tags, not the header. Preview also skips an entry with no item tag
(`src/lib/Others/StructuredMemory/PreviewTab.svelte:21`, "a tagless rule header is not a block"), so a card whose items
are all volatile shows no anchor in Preview although the model receives it. The plain `RULE_HEADER` has the same
exposure today.

**Why it matters:** the anchor is how the model sees the lag between the newest record and the chat (the plan's D6);
without it the labels read as counted from the present, and the plan's manual check 3 expects to see it in Preview.

**Suggested handling:** a Preview on a dated chat with only volatile items, and a send under a one-message chat range;
then decide whether the header belongs with the volatile part or Preview should show a tagless header.

### A Timeline reveal settles on held coverage, so a reread that retracts the event leaves Read without its row

Timeline Reading View run, 2026-11-19, from slice 4's challenger; reproduced in a scratch panel test, not in the app.
The pending-reveal effect of `src/lib/Others/StructuredMemory/TimelineTab.svelte` (`reveal`, the `$effect` on
`pending`, at the `manageRows.findIndex` line) picks Read or Manage from the coverage the tab holds: when the target
id is there as an active event, the reveal finishes at once in Read. If a coverage reread is out and its answer marks
the event retracted, the tab stays in Read and the opened row leaves the groups instead of the view switching to
Manage. The rule waits for coverage only when the id is absent.

**Why it matters:** a search hit, a `focus` from Pages, or "Open in Manage" pressed right after a refresh can land on
nothing visible. The race is narrow: the event must be retracted between the held read and the one in flight.

**Suggested handling:** reproduce in the app (retract an event in another tab, then follow a Pages link to it before
the panel's refresh settles); then either keep the target pending while a coverage read is out, or have an open event
that turns retracted switch the view to Manage.

### A malformed chapter row still claims its events, so every press pays for a failed chapter

Timeline Chapter Synopses run, 2026-11-19, from slice 2's challenger; reproduced in a scratch SQLite database, not in
the app. The chapter list (`createChapterTables` `list`, `server/src/data/memoryStore.ts:755`) leaves out a row that
fails `isMemoryChapter`, but `save` (`:728`, through `ownedEventIds` at `:709`) still counts every event id in such a
row's `events` array as owned. `chapterUnits` (`server/src/prompt/memory/structured/chapters.ts:83`) takes ownership
from the list, so an event claimed only by a malformed row looks loose: `/chapters/cost` counts its unit, the model is
called, and `add` refuses with "already belongs to another chapter", counted as failed, on every press.

**Why it matters:** each press pays one model request for nothing. Only a malformed row reaches it (another build's
shape, a manual edit, corruption); every row this build writes passes `isMemoryChapter`.

**Suggested handling:** give `chapterUnits` a store read of claimed event ids that shares `save`'s extraction rule, or
have the maker's first step remove malformed rows.

### The Korean group-size help calls a chapter 챕터

Timeline Chapter Synopses run, 2026-11-19, from slice 4; read. `eventsPerGroupHelp` in `src/lang/ko.ts:3400` reads
"챕터가 생기면 같은 수를 챕터의 목표 크기로 씁니다", while the chapters plan's string rule fixes 장 for a chapter and
줄거리 for its text, and the new `chapterAuto` help beside it and the Read view's strings use 장.

**Why it matters:** the Korean Memory settings page shows two words for one thing.

**Suggested handling:** reword the line with 장 in `ko.ts`.

## Modules and personas

### With two modules of one id, edit, export, conversion, and Apply module act on the first

Post-verification of 2026-11-18 (MF-1, what is left), read by one reader after the fix. The catalog's trash button now removes the row its dialog named, and the guide says two modules with one id are filed together. The catalog's other row actions and the Apply module picker still find the module by id and so act on the first of the pair. An upstream database import and a plugin's whole-list write can store such a pair.

**Why it matters:** the user opens, exports, or applies another module than the row they chose; nothing is deleted.

**Suggested handling:** kept as recorded by the owner's rule for the fix round (a library with a duplicated id is rare). If it is taken up: pass the row's record, as the trash button does, or give imported duplicates new ids where nothing links to them.

### Equal folder membership in another order counts as a conflict

Post-verification of 2026-11-18 (MF-2), reproduced by two readers. `mergeUnit` in `src/ts/storage/recordMerge.ts` compares a folder's `data` by position, and `withItemInFolder` appends in click order. Two tabs that file the same items into one folder in another order therefore conflict, although the plan says the order means nothing and equal changes converge. The losing tab takes the server's folder list, and an unrelated folder rename it held is dropped.

**Why it matters:** it needs one tab holding unsaved folder changes (an outage) while another device files the same items the other way round; the cost is one rename.

**Suggested handling:** kept as recorded by the owner's rule for the fix round. If it is taken up: compare member ids as sets in the three-way merge of the two folder kinds.

### An item whose id is only whitespace cannot be filed

Post-verification of 2026-11-18 (MF-3), reproduced by two readers. An upstream database import can store a persona or module whose id is one space (`shared/ids.ts` accepts any nonempty string). The folder helpers and `normalizeItemFolders` keep nonblank ids only: the persona page's Folder select returns silently, and the module move throws inside the store without an alert.

**Why it matters:** that one item stays at the root; everything else about it works.

**Suggested handling:** kept as recorded by the owner's rule for the fix round. If it is taken up: use the item records' nonempty-string rule in the folder helpers and both filing guards.

### The character's module toggle removes one entry of a repeated id

Post-verification of 2026-11-18 (MF-4, what is left), read by one reader after the fix. The catalog row's button now removes every occurrence of the id, as the folder's switch does. The character-level toggle (the row's right-click action) still splices one occurrence, so a module whose id is stored twice stays on after one click.

**Why it matters:** the same list reads differently depending on the control; it needs a stored list that repeats an id (an upstream import).

**Suggested handling:** use the same one-id rule there.

## Network jobs

### The send preflight waits for a resource write's answer without a bound

`prepareServerJob` (`src/ts/process/serverCommands.ts`) awaits `flushResources()` and looks at the send's abort signal
only after it. The flush awaits the resource batch's HTTP exchange (`runCycle` in
`src/ts/storage/resourceSync.svelte.ts`), and the resource client gives that request no deadline and no signal
(`src/ts/storage/resourceClient.ts`). A write whose answer never arrives therefore holds the send, its local send
reservation, the chat pin, and Stop until the request settles or the page reloads. The draft keeps the text. The same
wait was in `runServerJob` before the Remote Host plan (`git show 952c4baec:src/ts/process/serverCommands.ts`); the
plan added the remote adapter as a second caller. Found 2026-11-16 by the Remote Host post-audit (L-1): two probes
held the answer for two simulated hours, one through `runSend` and one through `flushResources` against the fake
resource server. A real browser can end the request sooner (a network error, a proxy timeout); nothing in the tab
guarantees it.

**Why it matters:** a phone that loses its network between a save's request and its answer can be left with a Send
that neither ends nor stops.

**Suggested handling:** in `prepareServerJob`, race the wait for the shared flush against the send's signal and a
deadline, answer a refusal that keeps the request's uncertainty, and never go on to a create after the timeout. Do not
abort the shared write or count it as saved: it may be committed, and other callers wait on the same answer.

### The job request's context type does not name two reroll fields

Post-verification of 2026-11-18 (CN-4, what is left), read by one reader after the fix. `ServerJobRequest.context` in `src/ts/process/serverCommands.ts` now names `completionHoldMs`. It still leaves out `rerollMessageId` and `speakerChaId`, which reach the job at runtime through spreads that type-check.

**Why it matters:** the type does not describe two fields the code sends.

**Suggested handling:** add them to the `Pick`.

## Plugins

### A TypeScript compilation error can replace a working plugin

Structure audit of 2026-11-18, read and not run. `importPlugin` reports a transpilation error and goes on with the
original TypeScript as the guest script (the `catch` after `pluginCodeTranspiler` shows the error and does not
return). A supported plugin that passes the remaining import checks can therefore overwrite its installed version.
[Compiler error path](../../src/ts/plugins/plugins.svelte.ts#L355) ·
[Install write](../../src/ts/plugins/plugins.svelte.ts#L441)

**Why it matters:** an update whose source does not compile replaces a plugin that worked.

**Suggested handling:** return on a compilation failure, with a test that replacing a working plugin leaves its saved
script intact.

## Remote commands

### The relay's identity differs from the generation's for fields a send does not use

`remoteCommandAction` (`shared/remoteCommands.ts`) hashes `input`, `userMessageId`, `continue`, and
`continueMessageId` as posted, and the route accepts combinations in which one of them has no effect. `sendChatOnServer`
(`src/ts/process/serverGeneration.ts`) drops or normalizes those, so the generation's `requestFingerprint` is the same
where the relay sees a changed command: `continueMessageId` on a plain send, `userMessageId` on a Continue without
input, `input` or `userMessageId` on a reroll, and `continue` absent or true in a group chat. The relay answers 409
`commandChanged` to a re-post that the generation would replay. Found 2026-11-16 by the re-reading of the Remote Host
post-audit's fixes (R-6); the speaker, the one field of this kind the audit first named, was taken out of the identity
the same day. No caller that ships posts one id with such a change, and the relay errs on the strict side: the sender
keeps a `commandChanged` send uncertain.

**Why it matters:** two definitions of "the same request"; a future caller that retries with a normalized field would
be refused.

**Suggested handling:** refuse the field combinations that have no effect in the route's validation, or normalize the
command before `remoteCommandAction`, and state the group Continue rule.

## Rendering

### An `@import` in card or message CSS is installed without scoping

`scopeCss` rewrites the rules of its own tree and blanks an `import` rule only when its target starts with `data:`
(`src/ts/parser/parser.svelte.ts`, the `rule.type === "import"` branch). The CSS parser keeps the quotes or the
`url(...)` wrapper, so `@import "data:text/css,…"` and `@import url(https://…)` pass the check, and `restoreStyles`
installs them through both trim functions; the imported sheet is never parsed or scoped. Found 2026-11-14 by the wide
review (cut I6, P1) and confirmed by a second reader: a greeting with `<style>@import
"data:text/css,.outside%7Bcolor%3Ared%7D";</style>` kept the import in the returned stylesheet, where every other rule
is rewritten under `.chattext`.

**Why it matters:** a card, a model reply, a module's display content, or a hub page's extra HTML can style the whole
app, not only its own message, and an `https:` import makes a request to a host of the author's choice when the chat
opens. No plugin and no low-level grant is needed.

**Suggested handling:** the owner's decision, since it costs compatibility: dropping every import closes it and also
stops cards that load web fonts this way; allowing only known font hosts (whose sheets hold `@font-face` rules) keeps
most of those; loading and scoping the imported sheet is a larger change.

**Decision:** owner, 2026-11-15: left as it is; the owner will deal with it separately, outside the batch that cleared
the rest of this file. Do not fix it in passing.

## Server generation

### A long text stalls every request while a tokenizer other than tiktoken counts it

The server encodes synchronously on the thread that serves every request (`server/src/prompt/tokenizers/index.ts`),
and the count route passes the caller's text with a 2 MiB body cap and no limit per string
(`server/src/routes/tokens.ts`). The first form of this entry was about the two tiktoken families, whose encoders take
quadratic time on one long pre-tokenizer piece: a 200 KB run of letters held an unrelated boot read for 17.6 s, a send
over a chat that stores such a message took 78.7 s (wide review of 2026-11-14, cut X3). Those two were bounded on
2026-11-15 (`tokenizers/tiktoken.ts` splits a piece over 512 UTF-8 bytes; 200 KB of any slow class now counts in under
0.1 s). What is left, measured the same day on one shared machine:

- The other local families at 2 MiB: `novellist` 38.9 s on repeated emoji, `gemma` 16.2 s on letters (0.8 s at
  200 KB), `claude` 6.0 s on letters, the rest 1 to 4 s. At 200 KB every one of them stayed under a second.
- A tiktoken text that keeps the package path on purpose: one with a code point whose Unicode category differs between
  Node and the package, or non-ASCII text on a Node whose Unicode version was not measured (16 and 17 were). A long
  run in such a text is as slow as before.

The `llm-requests` guide's Limitations record the split; the `server-generation` guide's record tokenizer calls on the
main thread as accepted on 2026-11-10 (worker isolation is a separate design).

**Why it matters:** a text near the route's 2 MiB cap, from a signed-in client, an imported card, or a model reply,
can still leave an instance answering nobody for seconds to tens of seconds on those families.

**Suggested handling:** the owner's note of 2026-11-14: "Token counting isn't always fast, so I'm considering moving
it to a worker thread." That design covers every family. Short of it, look at `novellist` on emoji and `gemma` on
letters first, since their times grow faster than the text.

### The final token recheck can clear every history entry and send an empty chat

In assembly's final recheck (`server/src/prompt/assemble.ts`, the `promptBudget` loop near `:2607`), each `removable`
entry is cleared until the prompt fits, and the token refusal fires only when the pointer runs past the end with
protected content still over the budget. With a prompt template, every history entry is marked removable (`:2240`;
only the template-less path keeps the last chat apart, `:2235`), the last user message included. When the
reservations (`maxResponse`, the tool schemas, and since the Request Interception plan its inserted messages) leave
little room, the loop can clear all of them and assembly succeeds with no chat in the prompt. Seen 2026-11-18 by
slice 3 of that plan while reserving the inserted messages; read, not run.

**Why it matters:** a large reservation can send a request without the user's message instead of telling the user
the context is too small.

**Suggested handling:** reproduce with a template-only prompt and a reservation larger than the history, then decide
whether the recheck should keep the last user message or refuse when nothing of the chat is left.

## Settings

### A row drag in progress when another tab removes an earlier row moves the wrong row

Post-verification of 2026-11-18 (SB-1, what is left), read by one reader after the fix. A template drag now remembers its preset and drops nothing once the page shows another one. Within one list, the drag still remembers the row's index (`PromptDataItem.svelte`): when another tab removes an earlier row of the same preset, or an earlier request interception rule, during the drag, the drop moves the row that slid into that index.

**Why it matters:** one row lands in the wrong place; it is visible and one move undoes it. It needs another tab's removal inside one drag gesture.

**Suggested handling:** kept as recorded by the owner's rule for the fix round. If it is taken up: remember the row's identity (the rule id, the record identity) and not its index.

The structure audit of 2026-11-18 read the same for a reorder that arrives from another tab during the drag, in both the prompt template editor and the request rule editor; its half about a drop on another preset was fixed the same day (`10b7cfa58`).

### A live settings update discards the text typed in a rule's popup editor

Post-verification of 2026-11-18 (RI-1), reproduced by two readers. A live update of the `providers` section installs new rule objects, so the row identity (`recordValueIdentity` in `PromptDataItem.svelte`) of an unchanged rule changes, `TextAreaInput.svelte` closes the popup session as stale, and the popup's text is not written back. Any provider setting saved by another tab or device while the popup is open does it; removing an earlier rule also collapses the row.

**Why it matters:** the text typed in the popup since it was opened is lost. Saved text and inline edits are not.

**Suggested handling:** kept as recorded by the owner's rule for the fix round (it needs the user's own second device, and the fix changes the shared popup guard). If it is taken up: key the interception page's popup by rule id and write back while the rule's stored text is still what the popup started from.

### A browser's default device name is its whole user agent string

Seen on 2026-11-19 in a fresh browser profile, not checked on a device. `clientName` in `src/ts/network/handoff.ts:59` defaults to `navigator.userAgent` cut to `MAX_FEED_CLIENT_NAME`, so the Device link page's name field (`DeviceNameInput.svelte`) opens with `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like`, cut off by the field, and the host list and the "taken by" toast show the same text for a device nobody named.

**Why it matters:** two browsers of one kind get the same default name, and the page says hosts are remembered by name; the text itself reads as noise.

**Suggested handling:** a short default from `src/ts/platform.ts` (browser and OS). Decide first what happens to a browser that never changed the name: whether its default is stored, and whether a host remembered under the old text must still match.

**Decision:** owner, 2026-11-20: the default becomes a short "browser · OS" label, and a stored name that starts with `Mozilla/5.0 ` is replaced by it once. The default is already stored (`preference` in `src/ts/network/handoff.ts` writes its value when it is created), so changing the fallback alone would reach new profiles only. A sending device that remembered a host under the old text does not have to match it: its "Not connected" row stays and the host is chosen again once.

### On Prompt preset's Parameters tab the last check row touches the handwritten label after it

Seen on 2026-11-20 in the captures of slice 2 of the Settings Item Spacing plan (not kept), and read against the code
after the plan landed. With `maxContextOverride` off, the last declarative item of `allBasicParameterItems` is the
`params.maxContextOverride` check row, which has no bottom margin. With the main model `mancer`, `textgen_webui`,
`local_*`, or `hf:::` the handwritten "Repetition Penalty" label follows it
(`src/lib/Setting/Pages/PromptPresetSettings.svelte:146`), and with a NovelList-format model the "Top P" label (`:337`);
neither has a top margin, so the row and the label touch. The gap was 0 before the plan too: the spacing rule in
`SettingRenderer.svelte` sets nothing on a handwritten element.

**Why it matters:** a check that touches the next label reads as one control; everywhere else on the page a field
stands 1rem from a row.

**Suggested handling:** an unconditional `mt-*` on the label would widen the other case (override on: the size field
before it already ends with 1rem). Either make the label's margin depend on what precedes it, or move the handwritten
parameters into the declarative data so the rule spaces them.

## Tests

### The output clamp test passes with the interception tokens left out

Post-verification of 2026-11-18 (RI-4), shown by one reader's break-test and not re-read. `server/src/tests/assemble.test.ts`: all cases pass when the `outputTokens` clamp in `server/src/prompt/assemble.ts` leaves the interception tokens out. The recheck before it already enforces the inequality, so the branch may be unreachable (the plan's pre-run audit said so too).

**Why it matters:** the plan named this test as the guard of that line.

**Suggested handling:** either remove the redundant branch or say in the test which invariant it proves.

### The toggle test's header describes a removed memory control

Structure audit of 2026-11-18, read. The header of `src/lib/SideBars/Toggles.test.ts` says its checkbox writes the
character's memory switch; the tests now assert the switch is absent there, and the per-chat control lives in
`src/lib/SideBars/ChatMemoryPanel.svelte`.

**Why it matters:** a search for the old field leads to a comment that describes a control that is gone.

**Suggested handling:** rewrite the header to the current contract.

## Translation

### A tab translation that is only an unknown style placeholder can be stored blank

Fix round of 2026-11-17, read and not run. The shared pipeline now refuses a translation that is blank after cleaning
(`shared/translation/pipeline.ts`). The tab restores style placeholders after the pipeline returns
(`src/ts/translator/translator.ts`, `translateLLM`, before `writeLLMCacheEntry`): an answer that holds only a
placeholder with an unknown index can become blank there and be cached.

**Why it matters:** a rendered translation can show as empty and be served from the cache again.

**Suggested handling:** reproduce; then apply the same blank check after the restoration.
