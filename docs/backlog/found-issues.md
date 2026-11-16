# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, the twenty-third (the Lore Budget Send Stop run) the same day, the Generation Progress Window run's two findings the same day, and the OOC Session run's two findings the same day, the Remote Host run's finding on 2026-11-16, and the Completion Notification After Plugin Work run's finding the same day; single entries move as they come up.

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
subsystem, then a second reader that tried to refute each P2 finding. Seventeen entries below, each marked
`cross-check F<n>`. They come from static reading only: none was reproduced by a test, so reproduce an entry before
fixing it. Each entry says who read its code. The method, the verdict counts, and the findings that were not filed
(four that are documented design, five P3 ones nobody challenged) are in
[its report](../reports/surveys/fork-data-loss-crosscheck.md).

## Contents

- [Backup and sync](#backup-and-sync): 4
- [Characters](#characters): 1
- [Chat pipeline](#chat-pipeline): 3
- [Memory](#memory): 1
- [Network jobs](#network-jobs): 1
- [Plugins](#plugins): 3
- [Remote commands](#remote-commands): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 4
- [Structured Memory](#structured-memory): 2
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

### The RisuAI-compatible export leaves out Structured Memory pages and threads without saying so

The compatible export's collector keeps only a chat's Structured Memory `events`
(`server/src/data/resourceStore.ts:745`, `server/src/data/upstream/exportDatabase.ts:968`). Pages and threads, a
manual note included, are not in the file, and the export report the user accepts does not mention them. The native
backup keeps everything. Found 2026-11-17 by the fork data-loss cross-check (cross-check F14); a second reader
confirmed it.

**Why it matters:** a user who keeps only compatible backups has no copy of their pages and threads, and nothing told
them.

**Suggested handling:** count the omitted pages and threads in the export report and point to the native backup.

### The RisuAI-compatible export leaves out assets that only a plugin's custom data references

`server/src/data/upstream/assetReferences.ts:21` does not walk the plugin custom values the export retains. A plugin
that saves an image with `saveAsset` and stores the key only in its custom database value gets the value in the
compatible export but not the file, and the file is not in the report's missing list. Asset cleanup and the native
backup do cover plugin-held references. Found 2026-11-17 by the fork data-loss cross-check (cross-check F15); a second
reader confirmed it.

**Why it matters:** the exported value points at a file the archive does not hold, and the report says nothing is
missing.

**Suggested handling:** walk the retained custom values for asset keys and feed them into the export's holds, its
selection, and its missing list.

### "Take snapshot" does not flush this tab's pending saves

`take` in `src/lib/Setting/Pages/Storage/storageController.svelte.ts:204` calls `takeSnapshot` directly. An edit that
is waiting in retry backoff after a short connection failure is not in the snapshot, and the action reports success
without a notice. The file backups flush first and name refused work (`flushResources` and `backupRefusedNote` in
`src/ts/drive/backuplocal.ts`). The pending work itself is not deleted. Composer and recovery drafts live in the
browser and are in no server backup; neither the snapshot nor the backup screen says that. Found 2026-11-17 by the fork
data-loss cross-check (cross-check F17); a second reader confirmed it, and the session read `take`.

**Why it matters:** a snapshot taken as a safety point before a risky action can hold an older state than the screen
shows.

**Suggested handling:** flush and report discarded and refused work before `takeSnapshot`, as the file backup does.

## Characters

### Module export re-encodes images with the image compression setting

`exportModuleLegacy` passes every asset through `compressImage` (`src/ts/process/modules.ts:188`), and `exportModule`
reaches the same call through `exportCharacterCard` (`src/ts/characterCards.ts:2046`). With `db.imageCompression`
on, which is the default, a JPEG, PNG, GIF or BMP asset is re-encoded as WebP at quality 0.75 with its longer side
capped at 3000 px (`src/ts/media/compressImage/lossyCompression.ts`); an animated GIF becomes a still image. The
setting's help text names character exports only. The stored original is untouched. Found 2026-11-17 by the fork
data-loss cross-check (cross-check F16); a second reader confirmed it, and the session read both files.

**Why it matters:** a module shared as a file carries lower-quality images than its author has, and the author is not
told.

**Suggested handling:** say so at module export and offer the original bytes, or name modules in the setting's help
text.

## Chat pipeline

### An open message or translation editor loses its text when its row is mounted again

The editor's draft is component state of the row (`draft` in `src/lib/ChatScreens/Chat.svelte:167`). The row's mount
key holds the stored message text (`MountKey` in `src/lib/ChatScreens/Chats.svelte:682`), so a change of that text
from another tab or device unmounts the row and mounts a new one (`:728`), and the typed text is gone. Opening
Settings and returning does the same to every row, because `src/App.svelte:259` replaces the chat screen. `isEditing`
protects an open editor only from the row trim and from containment. Found 2026-11-17 by the fork data-loss
cross-check (cross-check F5); a second reader confirmed it, and the session read the mount key. The `chat-store`
guide's Limitations said the draft survives, on the owner's decision of 2026-11-08; that decision accepted a behavior
the code did not have, so it needs to be made again.

**Why it matters:** a long manual edit of a message is lost by a visit to Settings or by an edit on another device,
with no recovery draft.

**Suggested handling:** keep editor drafts outside the row, keyed by character, chat and message, or leave the text
out of the mount key while `isEditing` is true.

### A reroll of a multi-reply turn keeps the discarded replies' variable changes

Only a single-reply turn is a reroll carrier (`shared/rerollCandidates.ts:304`), and `rerollByRemoval` changes
messages only (`src/lib/ChatScreens/DefaultChatScreen.svelte:1035`). When a group turn with two speakers whose
triggers change a chat variable is rerolled, the old messages are removed, `scriptstate` keeps their effects, and the
new replies add theirs on top. Found 2026-11-17 by the fork data-loss cross-check (cross-check F7); a second reader
confirmed it.

**Why it matters:** counters and flags of a card drift with every reroll of a group turn.

**Suggested handling:** extend the before and after variable checkpoints to multi-reply bundles.

### A slash-command send clears a newer composer draft and can append twice

`src/lib/ChatScreens/DefaultChatScreen.svelte:719` awaits the command pipeline and then clears the input, without a
send reservation and without comparing the text. Submitting `/speak Hello` with a network TTS mode and typing a new
draft while it waits clears that draft when the command ends. Submitting `/speak Hello | /send Next` and pressing Send
again while it waits appends `Next` twice. Found 2026-11-17 by the fork data-loss cross-check (cross-check F8); a
second reader confirmed it.

**Why it matters:** typed text is lost, or a message is sent twice, on a command that waits for the network.

**Suggested handling:** reserve the chat before the first await and clear the input only when it still holds the
submitted text.

## Memory

### An empty model answer replaces a stored SupaMemory summary or a stored translation

SupaMemory's submodel summarizer can return an empty success while consolidating, and the accumulated summary becomes
empty (`server/src/prompt/memory/supaMemory.ts:294`, `:380`). A translation step that returns only reasoning tags
stores an empty translation that counts as fresh (`shared/translation/pipeline.ts:333`,
`server/src/translation/runner.ts:364`). HypaV3 already validates its answer. Found 2026-11-17 by the fork data-loss
cross-check (cross-check F11); a second reader confirmed it.

**Why it matters:** one bad provider answer erases a summary built over a long chat, or a translation the user may
have edited.

**Suggested handling:** refuse a blank summary, and a blank translation of non-blank input, before it is published.

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

### Updating or re-importing a plugin resets its arguments and enables it

`importPlugin` builds default `realArg` values (`0` or `""`) and `enabled: true` for the record it stores
(`src/ts/plugins/plugins.svelte.ts:263-268`, `:363-376`), and `upsertPlugin` carries over only `completionWait` and
`completionQuietSeconds` from the record it replaces (`src/ts/storage/collectionStore.svelte.ts:407-426`). Pressing
Update, or importing the same plugin again, therefore returns every saved argument to its default and enables a plugin
the user had disabled. Inherited from upstream RisuAI. Found 2026-11-17 by the fork data-loss cross-check (cross-check
F2, rated P1); the session read both functions.

**Why it matters:** arguments often hold API keys and long presets, an update is an ordinary action, and only a
snapshot brings the values back.

**Suggested handling:** at replacement, keep the enabled state and every argument value whose declaration is still
compatible (same name and type).

### A plugin's in-memory value overwrites a newer value from another tab or device

Plugin storage reads and writes carry no record of what the plugin read (`src/ts/plugins/apiV3/v3.svelte.ts:3666`,
`src/ts/storage/pluginStorageStore.svelte.ts:246`). A plugin keeps its state in memory in tab A; tab B saves a newer
value for the same key, and A's store receives it through the live feed. When the plugin in A writes its older object,
the write carries the new revision, so no conflict is raised and B's change is gone. Found 2026-11-17 by the fork
data-loss cross-check (cross-check F3). Only the reviewer read this path; it rated it P1, and the session rated it P2
because it is a property of the storage API and not a broken guard.

**Why it matters:** a plugin that caches its state loses changes made on a second device, silently.

**Suggested handling:** an observation per key that a remote update invalidates, or a change notification that
plugins can subscribe to.

### Character and plugin imports report success before the save is confirmed

A character import (`src/ts/characterCards.ts:1496`) and a plugin import (`src/ts/plugins/plugins.svelte.ts:420`)
announce success once the record is in the tab's store. If the connection drops or the page closes before the save is
dispatched, a character is usually replayed from the journal at the next boot, but the `plugins` kind is excluded from
the journal, so a plugin install or update is lost. The module import already waits
(`src/ts/process/modules.ts:548`). Found 2026-11-17 by the fork data-loss cross-check (cross-check F10); a second
reader confirmed it.

**Why it matters:** the user saw a success notice for something that is not on the server.

**Suggested handling:** use the module importer's scoped flush before announcing success or starting the plugin.

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

### Lua `setFullChat` rebuilds every message from role and text

`setFullChatMain` (`server/src/lua/bindings.ts:1535-1556`) maps the script's list to `{ role, data }` objects with a
fresh `chatId` each and writes a whole-chat `replace`; the working-copy branch does the same without IDs. A card's Lua
button that calls `getFullChat`, changes some text, and calls `setFullChat` leaves every message with a new ID and
without its time, generation and prompt information, stored translation, and reroll candidates. Inherited from upstream RisuAI. Found 2026-11-17 by the
fork data-loss cross-check (cross-check F1, rated P1); the session read the function.

**Why it matters:** one press of a card's button strips a whole chat's message data, and only a chat checkpoint or a
snapshot from before the call brings it back.

**Suggested handling:** carry message IDs through the getter and the setter, overlay role and text on the matched
existing message, and give a fresh ID only to a new entry.

### A buffered reply is not stored when an output hook fails

With streaming off, the runner runs the `editoutput` hooks (`server/src/prompt/runner.ts:2221`) before the first write
of the reply (`:2247`). If a plugin's `editoutput` hook throws or a Lua output hook times out, the provider's answer
was received and is never written to the chat. The streaming branch stores the raw text first (`:2174`). The raw
response is usually still in Request History while capture is on. Found 2026-11-17 by the fork data-loss cross-check
(cross-check F6); a second reader confirmed it and narrowed it by the Request History copy.

**Why it matters:** a paid answer disappears because of a fault in a script that only post-processes it.

**Suggested handling:** store the buffered answer under the generation before output processing, as the streaming
branch does.

### A trigger's final reconciliation writes an earlier setter over a newer value

A V2 trigger sets `x` to `first` in its working copy (`server/src/prompt/triggers.ts:592`) and then runs
`/setvar key=x second`, which writes the live chat (`server/src/prompt/commands.ts:299`). When the trigger ends,
`server/src/jobs/chatResult.ts:230` applies the working copy again, and `x` is `first`. The author's note follows the
same path. Found 2026-11-17 by the fork data-loss cross-check (cross-check F9); a second reader confirmed it.

**Why it matters:** a card that mixes trigger setters and slash commands ends with the older value, with no error.

**Suggested handling:** do not replay setters that were already persisted, and refresh the working variables after a
nested command.

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

## Structured Memory

### A scene rewrite sees a truncated field and clips its answer

An unlocked scene section can be edited to 4,000 characters. The next scene update shows the model the first 2,000
characters of each field (`server/src/prompt/memory/structured/prompts.ts:320`) and clips each returned field to 800
(`server/src/prompt/memory/structured/analysis.ts:342`, `server/src/prompt/memory/structured/pages.ts:660`), so a long
hand-written section is replaced by a short rewrite of its first half. The former text stays in the page's history.
Found 2026-11-17 by the fork data-loss cross-check (cross-check F12); a second reader confirmed it and narrowed it by
the page history.

**Why it matters:** text the user wrote into a scene page is cut without a notice; getting it back means finding the
right history entry.

**Suggested handling:** show whole fields when replacement is allowed, and refuse an oversized answer instead of
clipping it.

### A candidate whose alias is an existing page's title creates a duplicate page

`find` in `server/src/prompt/memory/structured/pages.ts:358` matches a candidate by its title only. A candidate whose
alias equals an existing page's title therefore becomes a second page for the same subject. No text is lost, and the
two pages can be merged by hand. Found 2026-11-17 by the fork data-loss cross-check (cross-check F13, rated P3); a
second reader confirmed it.

**Why it matters:** facts about one subject are split over two pages, and each read sees only part of them.

**Suggested handling:** refuse or report a candidate whose alias collides with an existing title.

## Translation

### A translation result or edit overwrites a newer translation of the same message

`setTranslation` is fenced only by the hash of the original text (`server/src/data/chatStore.ts:2756-2790`) and does
not require the current chat revision, and the editor's captured `base` is not compared at save
(`src/ts/translator/storedTranslation.svelte.ts:365`). Tab A starts Retranslate, tab B edits and saves that message's
translation, and A's result then replaces B's edit. Two open translation editors do the same to each other. Found
2026-11-17 by the fork data-loss cross-check (cross-check F4). The reviewer rated it P1; the session read
`setTranslation` and rated it P2, because it needs two tabs working on the same message's translation.

**Why it matters:** a hand-corrected translation is replaced by a machine result, with no conflict and no notice.

**Suggested handling:** an expected translation version, "none" included, checked in `setTranslation`.
