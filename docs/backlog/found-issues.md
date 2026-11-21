# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on
something else. Each one was outside the scope of the change that found it, so it was recorded instead of fixed.
Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree
shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes).
Findings of a review or an audit are filed here the same way.

These are notes, not verified reports: this file is the inbox, and [known issues](known-issues.md) and the focused
guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph
saying what and where (`file:line`) and how far it was checked (read, reproduced, run in the app), then a
**Why it matters:** line and a **Suggested handling:** line; the Contents list counts each area's entries. Line
numbers and identifiers were right when each entry was written; some entries may already be fixed by later work.
Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that
fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to
that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner
accepts it; STRUCTURE.md Doc Maintenance) and leaves this file.

This file holds open entries only, written in the present tense: what the code does now and what is wrong with it. Do
not add history here. Which batch moved in when, who fixed what and how, and why an entry was closed belong in the
commit message of the commit that moves, fixes, or closes it (`git log -- docs/backlog/found-issues.md`), and a
review's method and counts belong in its report. When a fix closes part of an entry, rewrite the entry to what is
left; do not narrate the fixed part.

Words the entries use:

- "Latent": no current caller reaches the bad path. "Accepted": the owner chose to keep the behavior.
- "Kept as recorded by the owner's rule for the fix round": the owner's rule for the fixes of the post-verification of
  2026-11-18 was that a fix whose cost is out of proportion to how often its trigger happens is recorded and not made.
  The entry stays open, and its **Suggested handling:** says what to do if it is taken up.
- A **Decision:** line is the owner's and stands until the owner changes it.

Sources the entries name (drop a line when no entry names it any more):

- Wide review of 2026-11-14: [report](../reports/audits/codebase/wide-review-2026-11-14.md).
- Remote Host post-audit of 2026-11-16: [report](../reports/audits/finished-plans/remote-host-2026-11-16.md).
- Fix round of 2026-11-17: the fixes of the [fork data-loss cross-check](../reports/surveys/fork-data-loss-crosscheck.md);
  these entries are what its implementers read next to their fixes.
- Post-verification of 2026-11-18: [report](../reports/audits/finished-plans/plan-post-verification-2026-11-18.md);
  the ids (`IH-1`, `MF-2`) are its findings'.
- Structure audit of 2026-11-18: [report](../reports/audits/guides/structure-audit-2026-11-18.md).
- Generation lock survey of 2026-11-21: no report; a read-only survey that came with the chat lorebook fix
  (`4c43d31bd`).

## Contents

- [Backup and sync](#backup-and-sync): 4
- [Build and CI](#build-and-ci): 1
- [Chat screen](#chat-screen): 6
- [Docs](#docs): 3
- [Headless host](#headless-host): 1
- [LLM requests](#llm-requests): 2
- [Memory](#memory): 6
- [Modules and personas](#modules-and-personas): 1
- [Network jobs](#network-jobs): 2
- [Plugins](#plugins): 1
- [Remote commands](#remote-commands): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 1
- [Settings](#settings): 2
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

**Decision:** owner, 2026-11-20: `dev` stays out of the triggers on purpose
([build guide](../structure/build-test-platforms.md#ci)); do not file its absence.

## Chat screen

### Back and forward between multi-reply bundles swaps the messages only

Fix round of 2026-11-17, read and not run. `move` in `src/ts/process/rerollHistory.ts`, which steps back and forward
between the stored bundles of a multi-reply turn, swaps the message bundles and leaves the chat's variables as the
shown bundle did not set them. A removal reroll, by contrast, restores the variables its removed replies changed.

**Why it matters:** after stepping back to an earlier bundle, counters and flags are those of the bundle that was
shown last.

**Suggested handling:** reproduce with a two-speaker turn whose replies change a counter; then keep each bundle's
variable values with it, as the removal reroll's recovery path does.

### The expanded editor popup and two small editors still lose their text on a remount

Fix round of 2026-11-17, read and not run. The message editor and the stored-translation editor keep their text in
tab memory (`src/ts/storage/messageEditorDrafts.svelte.ts`). Three other surfaces keep theirs in component state: the
manually expanded popup of `src/lib/UI/GUI/TextAreaResizable.svelte` (it discards unreturned text when destroyed), the
partial-edit popover, and the editor of a rendered (cached) translation in `src/lib/ChatScreens/Chat.svelte`.

**Why it matters:** text typed in one of the three is lost when its component is destroyed and mounted again; they
are less used than the message editor.

**Suggested handling:** reproduce each; the popup can hand its text back to its owner on destruction.

### Sending newer text overwrites a failed send that was waiting to be placed back

Post-verification of 2026-11-18 (IH-1), reproduced by two readers. A chat has one send hand-off row and one in-memory entry (`putComposerSend` in `src/ts/storage/draftJournal.ts`, `sendDraft.ts`). When a send fails before its user message lands while the composer holds newer text, the failed text is not placed back and stays only there. The next send of the newer text overwrites both, and its success removes the row. The first text is then in neither the composer, the journal, nor the chat. A failed draft send is also kept out by a newer draft, translation, or attachment alone, and its row holds both boxes.

**Why it matters:** the user loses a message they wrote (and, for a draft send, the reviewed draft) without a notice. It needs a send that fails while the user has already typed the next message.

**Suggested handling:** kept as recorded by the owner's rule for the fix round (the trigger is uncommon and the fix adds a second kept snapshot to the journal and its budget). If it is taken up: keep the displaced snapshot under its message id and offer it through the composer's recovery.

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

### Chat controls stay enabled during a generation and refuse only after the click

Generation lock survey of 2026-11-21 (Luna workers), read and not run; the chat lorebook had the same pattern and was
fixed in `4c43d31bd`. These controls stay enabled while a reply generates in the chat and refuse with `chatGenerating`
only once used: Continue and Reroll in the side menu and Ctrl+M (`src/lib/ChatScreens/DefaultChatScreen.svelte`, the
`isScreenBusy` checks near 945 and 1020); Enter in the draft box, while its Send Draft button is disabled (near 811);
the unreroll arrows of a row other than the generating one, which `locked` in `src/lib/ChatScreens/Chat.svelte`
covers only per message; and checkpoint Save and Load in `src/lib/Others/ChatCheckpointsDialog.svelte` (161, 172),
which refuse only after the name prompt or the confirmation. The message editor's textarea stays editable when the
generation starts after it opened, and its save refuses; the stored translation editor and retranslation refuse the
same way.

**Why it matters:** the user writes a name, confirms, or types an edit, and learns only afterwards that it cannot be
saved; the message bubble's own buttons, by contrast, are disabled.

**Suggested handling:** disable each control from the same predicate its handler checks (`isLocalSend` with
`generatingChatKeys`, or `isScreenBusy`), and keep the handler checks for a generation that starts during a dialog,
as the lorebook fix does.

### A message's Branch button has no generation lock

Generation lock survey of 2026-11-21 (Luna workers), read and not run. The Branch button of a message
(`src/lib/ChatScreens/Chat.svelte`, the handler that calls `createInheritingChat` near 2106) has neither
`disabled={locked}` nor a busy check. Branching on the message that is still generating may copy the reply as streamed
so far into the new chat; the copy was not checked.

**Why it matters:** the new chat could start from a cut-off reply that the user takes for the finished one.

**Suggested handling:** reproduce by branching on a streaming reply; if the copy is partial, disable Branch while the
message is locked.

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
(Memory tables) says `memory_chapters` "sits outside the memory table group and all lifecycle walks". But
the rebuild swap deletes a chat's chapters for every mode but backfill (`server/src/data/memoryStore.ts`, `swap`) and
the `/inherit` route copies them (`store.memory.chapters.copy`); the record walks of a restore, the package, chat
files, and checkpoints still skip the table.

**Why it matters:** a reader of the records guide would conclude that no lifecycle path touches chapters and miss the
swap's delete and the copy.

**Suggested handling:** reword the sentence to name the record walks that skip the table and point at
[lifecycle](../structure/structured-memory/lifecycle.md) and [rebuild](../structure/structured-memory/rebuild.md),
which describe the two paths that do touch it.

### The fork ledger's ComfyUI row still lists import as missing

Upstream Intake 3 run, 2026-11-21, from slice 4; read. `docs/backlog/fork-feature-ledger.md:59` (row A10, "ComfyUI
saved workflows") lists "Named workflows, import, conversion and the viewer" as missing. Slice 4 (`5fb726c20`) added
an upload button under the `comfyui` workflow textarea in `src/lib/Setting/Pages/ImageGenerationSettings.svelte`
(`importComfyWorkflow`) that loads one JSON file into the single workflow string.

**Why it matters:** the row now overstates the gap; a later reader may plan a file import that already exists, while
named workflows, conversion and the viewer are still missing.

**Suggested handling:** narrow "import" in the row to an import into named workflows, or name the single-file import
in its Metatron column.

## Headless host

### An uncaught page error from a script URL with a query loses its position in the headless host's log

Post-verification of 2026-11-18 (HH-5), read by one reader. The `pageerror` handler in `util/headlessHost.mjs` logs `error.stack` through the whole-line redaction, which removes everything after a `?` in each frame's URL. A console message keeps its line and column: its URL is redacted by itself and the position is appended.

**Why it matters:** on a dev stack, whose modules carry a version query, an uncaught error's stack names files without positions.

**Suggested handling:** redact each frame's URL by itself, as the console line does.

## LLM requests

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

### The HypaV3 editor undoes an edit made during a generation instead of disabling it

Generation lock survey of 2026-11-21 (Luna workers), read and not run. The HypaV3 modal's summary text, importance,
category, tag and bulk edits stay enabled while a reply generates; the copy-save effect in
`src/lib/Others/HypaV3Modal.svelte` (141-163) then alerts `chatGenerating` and restores the saved copy. The Structured
Memory panel instead derives `readOnly` from the same fence and disables its controls, except the section draft
textarea in `PagesTab.svelte`, whose Save is disabled while the text stays editable. A memory receipt's Revert under an
older message (`MemoryReceiptLine.svelte`) stays enabled during another message's generation and is refused by the
server.

**Why it matters:** typed text is thrown away with a notice, the pattern the chat lorebook fix (`4c43d31bd`) removed.

**Suggested handling:** derive a read-only state from `memoryWriteFence` as the Structured Memory panel does, and
disable the Pages draft textarea with its Save.

### The HypaV2 chunk and SupaMemory editors write the whole field during a generation

Generation lock survey of 2026-11-21 (Luna workers), read and not run. `setHypaV2ChunkText` in
`src/lib/Others/AlertComp.svelte` (295-304) copies the chat's whole `hypaV2Data` and writes it back with `setChatMeta`;
the SupaMemory text areas in `src/lib/SideBars/CharConfig.svelte` (near 1856 and 1887) write `supaMemoryData` whole.
Neither checks for a running generation, and the memory jobs of a send write these fields on the server. Whether the
chat revision check refuses or reloads such a write was not checked.

**Why it matters:** this is the whole-field case the chat lorebook draft is fenced for: an edit written from the
tab's copy after a job's write could drop that write, or the job's write could replace the edit.

**Suggested handling:** reproduce by editing a chunk while a HypaV2 summary job writes; if a write is lost, fence
these editors like `createChatFieldDraft`.

## Modules and personas

### The character's module toggle removes one entry of a repeated id

Post-verification of 2026-11-18 (MF-4), read by one reader. The character-level toggle (the row's right-click action) splices one occurrence of the id, so a module whose id is stored twice stays on after one click. The catalog row's button and the folder's switch remove every occurrence.

**Why it matters:** the same list reads differently depending on the control; it needs a stored list that repeats an id (an upstream import).

**Suggested handling:** use the same one-id rule there.

## Network jobs

### The send preflight waits for a resource write's answer without a bound

`prepareServerJob` (`src/ts/process/serverCommands.ts`) awaits `flushResources()` and looks at the send's abort signal
only after it. The flush awaits the resource batch's HTTP exchange (`runCycle` in
`src/ts/storage/resourceSync.svelte.ts`), and the resource client gives that request no deadline and no signal
(`src/ts/storage/resourceClient.ts`). A write whose answer never arrives therefore holds the send, its local send
reservation, the chat pin, and Stop until the request settles or the page reloads. The draft keeps the text. Both
paths into it wait this way: `runServerJob` and the remote host's send (`src/ts/network/remoteSend.ts`). Found 2026-11-16
by the Remote Host post-audit (L-1): two probes
held the answer for two simulated hours, one through `runSend` and one through `flushResources` against the fake
resource server. A real browser can end the request sooner (a network error, a proxy timeout); nothing in the tab
guarantees it.

**Why it matters:** a phone that loses its network between a save's request and its answer can be left with a Send
that neither ends nor stops.

**Suggested handling:** in `prepareServerJob`, race the wait for the shared flush against the send's signal and a
deadline, answer a refusal that keeps the request's uncertainty, and never go on to a create after the timeout. Do not
abort the shared write or count it as saved: it may be committed, and other callers wait on the same answer.

### The job request's context type does not name two reroll fields

Post-verification of 2026-11-18 (CN-4), read by one reader. `ServerJobRequest.context` in `src/ts/process/serverCommands.ts` leaves out `rerollMessageId` and `speakerChaId`, which reach the job at runtime through spreads that type-check.

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
post-audit's fixes (R-6). No caller that ships posts one id with such a change, and the relay errs on the strict side:
the sender keeps a `commandChanged` send uncertain.

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

**Decision:** owner, 2026-11-15: left as it is; the owner will deal with it separately. Do not fix it in passing.

## Server generation

### A long text stalls every request while a tokenizer other than tiktoken counts it

The server encodes synchronously on the thread that serves every request (`server/src/prompt/tokenizers/index.ts`),
and the count route passes the caller's text with a 2 MiB body cap and no limit per string
(`server/src/routes/tokens.ts`). The two tiktoken families are bounded for ordinary text: `tokenizers/tiktoken.ts`
splits a pre-tokenizer piece over 512 UTF-8 bytes, and 200 KB of any slow class counts in under 0.1 s. What is not
bounded, measured on 2026-11-15 on one shared machine:

- The other local families at 2 MiB: `novellist` 38.9 s on repeated emoji, `gemma` 16.2 s on letters (0.8 s at
  200 KB), `claude` 6.0 s on letters, the rest 1 to 4 s. At 200 KB every one of them stayed under a second.
- A tiktoken text that keeps the package path on purpose: one with a code point whose Unicode category differs between
  Node and the package, or non-ASCII text on a Node whose Unicode version was not measured (16 and 17 were). The
  package's encoders take quadratic time on one long piece: without the split, a 200 KB run of letters held an
  unrelated boot read for 17.6 s, and a send over a chat that stores such a message took 78.7 s (wide review of
  2026-11-14, cut X3).

The `llm-requests` guide's Limitations record the split; the `server-generation` guide's record tokenizer calls on the
main thread as accepted on 2026-11-10 (worker isolation is a separate design).

**Why it matters:** a text near the route's 2 MiB cap, from a signed-in client, an imported card, or a model reply,
can still leave an instance answering nobody for seconds to tens of seconds on those families.

**Suggested handling:** the owner's note of 2026-11-14: "Token counting isn't always fast, so I'm considering moving
it to a worker thread." That design covers every family. Short of it, look at `novellist` on emoji and `gemma` on
letters first, since their times grow faster than the text.

## Settings

### On Prompt preset's Parameters tab the last check row touches the handwritten label after it

Seen on 2026-11-20 in the captures of slice 2 of the Settings Item Spacing plan (not kept), and read against the code
after the plan landed. With `maxContextOverride` off, the last declarative item of `allBasicParameterItems` is the
`params.maxContextOverride` check row, which has no bottom margin. With the main model `mancer`, `textgen_webui`,
`local_*`, or `hf:::` the handwritten "Repetition Penalty" label follows it
(`src/lib/Setting/Pages/PromptPresetSettings.svelte:146`), and with a NovelList-format model the "Top P" label (`:337`);
neither has a top margin, so the row and the label touch. The spacing rule in `SettingRenderer.svelte` sets nothing
on a handwritten element.

**Why it matters:** a check that touches the next label reads as one control; everywhere else on the page a field
stands 1rem from a row.

**Suggested handling:** an unconditional `mt-*` on the label would widen the other case (override on: the size field
before it already ends with 1rem). Either make the label's margin depend on what precedes it, or move the handwritten
parameters into the declarative data so the rule spaces them.

### An emptied plugin wait time limit box stays blank while the server stores the default

Post-verification of 2026-11-18, seen by one verifier beside the fix that makes the box show its clamped value; not
run again. The "Plugin wait time limit (seconds)" field (`display.completionWaitMaxSeconds` in
`src/ts/setting/displaySettingsData.svelte.ts`, a number item with `clampOnCommit`) stays blank when the user empties
it, while `normalizeUi` (`server/src/data/normalize/ui.ts`) stores the default.

**Why it matters:** low. The page shows no value where the stored one is the default.

**Suggested handling:** reproduce; then show the default the server stored when an emptied box is committed.

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

Fix round of 2026-11-17, read and not run. The shared pipeline refuses a translation that is blank after cleaning
(`shared/translation/pipeline.ts`). The tab restores style placeholders after the pipeline returns
(`src/ts/translator/translator.ts`, `translateLLM`, before `writeLLMCacheEntry`): an answer that holds only a
placeholder with an unknown index can become blank there and be cached.

**Why it matters:** a rendered translation can show as empty and be served from the cache again.

**Suggested handling:** reproduce; then apply the same blank check after the restoration.
