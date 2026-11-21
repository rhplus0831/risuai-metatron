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
- A **Decision:** line is the owner's and stands until the owner changes it.

Sources the entries name (drop a line when no entry names it any more):

- Wide review of 2026-11-14: [report](../reports/audits/codebase/wide-review-2026-11-14.md).
- Remote Host post-audit of 2026-11-16: [report](../reports/audits/finished-plans/remote-host-2026-11-16.md).
- Fix round of 2026-11-17: the fixes of the [fork data-loss cross-check](../reports/surveys/fork-data-loss-crosscheck.md);
  these entries are what its implementers read next to their fixes.
- Post-verification of 2026-11-18: [report](../reports/audits/finished-plans/plan-post-verification-2026-11-18.md).
- Structure audit of 2026-11-18: [report](../reports/audits/guides/structure-audit-2026-11-18.md).
- Generation lock survey of 2026-11-21: no report; a read-only survey that came with the chat lorebook fix
  (`4c43d31bd`).

## Contents

- [Backup and sync](#backup-and-sync): 1
- [Build and CI](#build-and-ci): 1
- [Chat screen](#chat-screen): 4
- [Memory](#memory): 2
- [Network jobs](#network-jobs): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 1
- [Settings](#settings): 1
- [Translation](#translation): 1

## Backup and sync

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

### The CI workflow pins its actions by tag

Read on 2026-11-20 at `bcc698905`, in the file only. The three actions of `.github/workflows/ci.yml` are pinned by tag
(`actions/checkout@v5`, `actions/setup-node@v5`, `actions/cache@v4`), not by commit hash. Not checked: whether the
forge runs this workflow at all.

**Why it matters:** low. A tag can be moved to other code by the action's publisher.

**Suggested handling:** pin the actions by hash if the workflow is in use.

**Decision:** owner, 2026-11-20: `dev` stays out of the triggers on purpose
([build guide](../structure/build-test-platforms.md#ci)); do not file its absence. Owner, 2026-11-21: pin by hash only
if the workflow is in use.

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

### A message's Branch button has no generation lock

Generation lock survey of 2026-11-21 (Luna workers), read and not run. The Branch button of a message
(`src/lib/ChatScreens/Chat.svelte`, the handler that calls `createInheritingChat` near 2106) has neither
`disabled={locked}` nor a busy check. Branching on the message that is still generating may copy the reply as streamed
so far into the new chat; the copy was not checked.

**Why it matters:** the new chat could start from a cut-off reply that the user takes for the finished one.

**Suggested handling:** reproduce by branching on a streaming reply; if the copy is partial, disable Branch while the
message is locked.

## Memory

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

**Decision:** owner, 2026-11-21: not fixed in a found-issues round; the worker thread design gets its own plan.

## Settings

### An emptied plugin wait time limit box stays blank while the server stores the default

Post-verification of 2026-11-18, seen by one verifier beside the fix that makes the box show its clamped value; not
run again. The "Plugin wait time limit (seconds)" field (`display.completionWaitMaxSeconds` in
`src/ts/setting/displaySettingsData.svelte.ts`, a number item with `clampOnCommit`) stays blank when the user empties
it, while `normalizeUi` (`server/src/data/normalize/ui.ts`) stores the default.

**Why it matters:** low. The page shows no value where the stored one is the default.

**Suggested handling:** reproduce; then show the default the server stored when an emptied box is committed.

## Translation

### A tab translation that is only an unknown style placeholder can be stored blank

Fix round of 2026-11-17, read and not run. The shared pipeline refuses a translation that is blank after cleaning
(`shared/translation/pipeline.ts`). The tab restores style placeholders after the pipeline returns
(`src/ts/translator/translator.ts`, `translateLLM`, before `writeLLMCacheEntry`): an answer that holds only a
placeholder with an unknown index can become blank there and be cached.

**Why it matters:** a rendered translation can show as empty and be served from the cache again.

**Suggested handling:** reproduce; then apply the same blank check after the restoration.
