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
- Fix round of 2026-11-22: no report; the fixes of eight known issues, and what their implementers read beside them.
- Second fix round of 2026-11-22: no report; eleven known-issue fixes and their reviews (reports and probes kept with
  the review material outside the repository).

## Contents

- [Build and CI](#build-and-ci): 3
- [Chat screen](#chat-screen): 1
- [Docs](#docs): 1
- [Draft recovery](#draft-recovery): 2
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 3

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

### The test wrapper's result cache omits ignored inputs

Second fix round of 2026-11-22, read and not run. `util/agentTest.mjs` (near 395) keys a stored test result on
`workingTreeId`, which omits git-ignored files under source roots, and has no end-of-run check. The type-check cache
had the same gap and now compares its complete input key before saving.

**Why it matters:** low. A test that reads an ignored file (a local fixture, a generated file) can replay a stale pass.

**Suggested handling:** reproduce with an ignored fixture a test reads; if it replays, key the result the way
`util/typeCheckCache.mjs` keys a program.

### The persona binding e2e spec's "Chat Settings" button name matches two buttons

Run on 2026-11-23 at `a3cb3d014` and again at `667444a93`: `e2e/personaBinding.spec.ts:200` fails in Playwright strict
mode. After it opens a chat row's options, `page.getByRole("button", { name: "Chat Settings" })` matches the "Chat
Settings" option and the "Copy Settings Only" option, whose description `createSettingsCopyDesc` (`src/lang/en.ts`)
ends in "and chat settings." The option came in at `4a44b704a`.

**Why it matters:** the spec fails for a reason unrelated to what it tests, so it no longer guards the binding dialog's
Chat Settings path, and every e2e run that selects it reports a failure.

**Suggested handling:** pass `exact: true` to that `getByRole`, then run the spec again.

## Chat screen

### The sidebar's whole-chat Copy can capture a reply that is still streaming

Fix round of 2026-11-22, read and not run. The chat list's Copy action (`src/lib/SideBars/SideChatList.svelte`, near 147) snapshots every loaded message of the chat with no check for a running generation. A message's Branch item is
disabled while that message generates, because a branch made then kept the text streamed so far; this action copies
the same tab-side messages.

**Why it matters:** the copied chat could hold a cut-off reply that the user takes for the finished one.

**Suggested handling:** reproduce by copying a chat while its reply streams; if the copy is partial, disable Copy
while the chat is busy.

## Docs

### The server resources guide is near its size limit

Measured on 2026-11-23 at `667444a93`: `docs/structure/server-resources.md` is 38,481 bytes (target 36,000, limit
40,000), and `pnpm check:docs` reports it `near`. The Chat Trash sections (`### Chat Trash`, `### Chat Trash
retention`, the column bullet under `### Store tables`, the snapshot layout paragraph under `### Install`, and a
Limitation) took it there from 35,539.

**Why it matters:** with 1,519 bytes left, the next server-side change that adds to this guide has to split it first.

**Suggested handling:** trim or split it in its own commit. Candidates: the long `### Limitations` (about 5.3 KB) and the
route lists under `## Files`.

## Draft recovery

### A second recovery Apply replays the ops the first one saved

Second fix round of 2026-11-22, reproduced by a reviewer's probe (Vitest). When the server refuses part of a recovery
draft (a memory field edit after a job's write, an OOC answer another tab already stored), Apply keeps the whole draft
(`applyRecoveryDraft` in `src/ts/storage/journalRecovery.ts`). A later Apply rebuilds every op of the draft, so a note
the first Apply saved and another tab edited since is set back to the draft's text. The same happens when the first Apply's wait for the save ends
at its 30-second bound and the save commits later: the draft stays, and a second Apply after a newer edit replays it.

**Why it matters:** an edit saved after the first Apply can be overwritten by the second, without a notice.

**Suggested handling:** record which ops the acknowledgement refused and retry only those; the group result needs a
field or exchange identity for that.

### A refused replay of an earlier build's journaled delete leaves the tab's chat order unlike the server's

Read on 2026-11-23 at `667444a93`. Boot recovery can still replay a `{ op: "delete" }` that a build before the chat trash
journaled. When the tab then creates a chat with the same id, the server refuses the delete with `useTrash` and keeps
the old chat. The tab lists the two chats in one order (`j, k`) while the server holds the other (`k, j`), with no
pending work, until the next list read: the `useTrash` path of `recoverChatConflicts`
(`src/ts/storage/chatStore.svelte.ts`) does not request the character's list. The recreation case in
`src/ts/storage/tests/resourceSyncRecreation.test.ts` ("sends an earlier build's journaled delete…") compares the
member set sorted, which hides the order.

**Why it matters:** low and legacy-only. It needs a journal written before the upgrade plus a same-id create, and the
order is only cosmetic.

**Suggested handling:** have the `useTrash` refusal path call `requestChatListRefresh`, then drop the `.sort()` in that
test.

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

### A reply rerolled in place can be lost on restart when its candidates pass the size limit

Read on 2026-11-22 at `bcf9d8e8e` by the Removal Reroll plan's audit and its design review; not reproduced. The
in-place reroll's begin group clears the carrier's text and keeps the old reply only as a stored candidate
(`server/src/prompt/runner.ts:1508`), but `trimCandidates` (`shared/rerollCandidates.ts:229`, `:263`) treats
`previousId` as a preference: past `MAX_CANDIDATES_BYTES_PER_MESSAGE` (192 KiB, `shared/rerollCandidates.ts:7`) it
drops an unselected slot, and with only the previous reply and the empty replacement that is the previous reply, and
then clears `candidates`. The rollback copy (`previousCandidate`) is a local variable of the runner, so a crash between
the begin and the final write leaves the reply empty. The 193 KiB runner case (`server/src/tests/promptRunner.test.ts:4197`)
covers the notice and a normal completion, not a crash after the begin.

**Why it matters:** a long reply rerolled in place, the path that avoids the
[removal reroll's loss](../structure/chat-pipeline.md#limitations), can lose its text when the server dies mid-reroll.

**Suggested handling:** keep the previous reply when trimming for a reroll (drop it last, or refuse the in-place reroll
and take the tail path), or keep the rollback copy durable, as the retired Removal Reroll plan
([archive](../archived-plan/README.md)) proposed for a removed tail.

### The create route's validation errors still list `group` jobs

Read on 2026-11-23 at `de3b7b080`. `parseCreateBody` refuses `kind: "group"` with 400 before its context checks, yet
two of those checks still answer "context.inputOriginal is only for send, continue, reroll, and group jobs" and
"context.userMessageId is only for send, continue, reroll, and group jobs" (`server/src/routes/generations.ts:209`,
`:220`), because `INPUT_KINDS` (`:145`) still lists `group`. The route test at
`server/src/tests/promptRunner.test.ts:2370` repeats that wording in its title and in its regex (`:2375`).

**Why it matters:** low. The error text names a kind the route no longer accepts, and the test describes the old
behavior.

**Suggested handling:** drop `group` from `INPUT_KINDS` and from both messages, and update the test's title and regex
in the same commit.

### A token count queued behind a long encode holds shutdown before the tokenizer worker is ended

Reproduced on 2026-11-22 at the Tokenizer Worker plan's slice 2 by holding an encode in the worker; the order was read
again at `07fb41a0d`. An admitted Structured Memory request with `sceneBudget` awaits its token counts
(`server/src/routes/structuredMemory.ts:251`, through `jobChatTokenCounter`, with no signal), and the app tracks that
handler (`snapshots.track`, `server/src/app.ts:826`). Shutdown's `snapshots.stop()` (`server/src/app.ts:1286`) waits
for every tracked handler before the chain reaches `tokenizers.dispose()` (`server/src/app.ts:1292`), which is what
would end the worker. So a count queued behind a long encode in the ordinary worker holds shutdown until that encode
ends.

**Why it matters:** the plan's manual check "the container stops within its grace period while a count is running"
can fail on a text near the 2 MiB count body for `novellist` or `gemma`. It is not a regression: before the worker,
the same encode held the thread.

**Suggested handling:** end or abort the tokenizer calls earlier in shutdown (before `snapshots.stop()`), or pass the
request's signal to the scene-budget count; otherwise qualify the manual check.
