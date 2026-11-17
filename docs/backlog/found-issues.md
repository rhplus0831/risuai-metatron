# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, the twenty-third (the Lore Budget Send Stop run) the same day, the Generation Progress Window run's two findings the same day, and the OOC Session run's two findings the same day, the Remote Host run's finding on 2026-11-16, the Completion Notification After Plugin Work run's finding the same day, and the Sidebar-Only Chat Binding run's finding on 2026-11-17; single entries move as they come up.

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
see whether a test fails; the tests it found missing were written the same day. The review's method, counts, and cost are in [its report](../reports/audits/wide-review-2026-11-14.md).

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
the ratings are in [its report](../reports/audits/remote-host-post-audit-2026-11-16.md).

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

## Contents

- [Backup and sync](#backup-and-sync): 3
- [Chat screen](#chat-screen): 2
- [Memory](#memory): 2
- [Network jobs](#network-jobs): 1
- [Plugins](#plugins): 2
- [Remote commands](#remote-commands): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 1
- [Translation](#translation): 1

## Backup and sync

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

### No backup screen says that drafts live in the browser

Fix round of 2026-11-17, read and not run (it was the last remark of the fixed "Take snapshot" entry). Composer drafts
and recovery drafts are in this browser's journal and in no snapshot, file backup, or compatible export; neither the
Storage page nor the backup dialogs say so.

**Why it matters:** a user who takes a snapshot before a risky action may expect an unsent draft to be in it.

**Suggested handling:** one line on the Storage page, or accept it as a Limitation of
[draft recovery](../structure/draft-recovery.md).

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

### The other memory algorithms were not checked for a blank summarizer answer

Fix round of 2026-11-17, read and not run. SupaMemory now treats a blank summarizer answer as a failed summarization
(`server/src/prompt/memory/supaMemory.ts`). HypaV2, HypaV3, and Hanurai were outside that fix and were not read for
the same case.

**Why it matters:** a blank answer may replace or append an empty summary there.

**Suggested handling:** one probe per algorithm with an empty successful answer.

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

## Plugins

### A plugin's chat write can change the chat's binding

`setChatToIndex` hands the plugin's chat to `applyChatResult` (`src/ts/plugins/apiV3/v3.svelte.ts:3264`), which
writes every metadata key that differs from the baseline with `setChatMeta`
(`src/ts/storage/chatStore.svelte.ts:4787`). `nonMetaKeys` (`:4660`) does not list `promptPresetId`,
`modelPresetId`, `bindedPersona`, or `bindingReview`, so a permitted plugin can rebind a chat, or clear its pending
review, without `pickBinding` or `chatBindingPatch`. Pre-existing. Found 2026-11-17 by slice 2 of the Sidebar-Only
Chat Binding plan (its challenger's report, spot-checked in code); re-checked at the run's end, unverified at runtime.

**Why it matters:** that plan's rule is that a chat's binding changes only from its binding panel, the review
confirmation, and chat creation; plugins are a second writer nobody documents.

**Suggested handling:** an owner decision: exclude the binding keys from plugin chat writes, or document plugins as a
binding writer in [persistence](../structure/persistence.md) Chat binding.

### The plugin guide is over its size target

`docs/structure/plugin-sandbox.md` is 36,553 bytes against the 36,000-byte target (limit 40,000): `pnpm check:docs`
reports it `near` since the Limitation on last-writer-wins plugin storage was added on 2026-11-17. It was 35,983
bytes before.

**Why it matters:** the next facts added to the guide move it toward the limit, where a split has to land first.

**Suggested handling:** a trim or split pass of its own (Size limits in `docs/structure/README.md`); Flows (about
9,800 bytes) and Known Hazards (about 8,300) are the largest parts.

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

## Translation

### A tab translation that is only an unknown style placeholder can be stored blank

Fix round of 2026-11-17, read and not run. The shared pipeline now refuses a translation that is blank after cleaning
(`shared/translation/pipeline.ts`). The tab restores style placeholders after the pipeline returns
(`src/ts/translator/translator.ts`, `translateLLM`, before `writeLLMCacheEntry`): an answer that holds only a
placeholder with an unknown index can become blank there and be cached.

**Why it matters:** a rendered translation can show as empty and be served from the cache again.

**Suggested handling:** reproduce; then apply the same blank check after the restoration.
