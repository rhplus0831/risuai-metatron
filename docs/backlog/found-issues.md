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

## Contents

- [Build and CI](#build-and-ci): 1
- [Chat screen](#chat-screen): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 1

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

### The sidebar's whole-chat Copy can capture a reply that is still streaming

Fix round of 2026-11-22, read and not run. The chat list's Copy action (`src/lib/SideBars/SideChatList.svelte`, near 147) snapshots every loaded message of the chat with no check for a running generation. A message's Branch item is
disabled while that message generates, because a branch made then kept the text streamed so far; this action copies
the same tab-side messages.

**Why it matters:** the copied chat could hold a cut-off reply that the user takes for the finished one.

**Suggested handling:** reproduce by copying a chat while its reply streams; if the copy is partial, disable Copy
while the chat is busy.

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

### A long text holds every other token count while a tokenizer other than tiktoken counts it

The server counts every local text in one tokenizer worker thread, one call at a time in arrival order
(`server/src/prompt/tokenizers/workerHost.ts`), and the count route passes the caller's text with a 2 MiB body cap and
no limit per string (`server/src/routes/tokens.ts`). The server's own thread stays free, but a count waits behind
every count before it. The two tiktoken families are bounded for ordinary text: `tokenizers/tiktoken.ts` splits a
pre-tokenizer piece over 512 UTF-8 bytes, and 200 KB of any slow class counts in under 0.1 s. What is not bounded,
measured in thread on 2026-11-15 on one shared machine:

- The other local families at 2 MiB: `novellist` 38.9 s on repeated emoji, `gemma` 16.2 s on letters (0.8 s at
  200 KB), `claude` 6.0 s on letters, the rest 1 to 4 s. At 200 KB every one of them stayed under a second.
- A tiktoken text that keeps the package path on purpose: one with a code point whose Unicode category differs between
  Node and the package, or non-ASCII text on a Node whose Unicode version was not measured (16 and 17 were). The
  package's encoders take quadratic time on one long piece: without the split, a 200 KB run of letters took 17.6 s
  (wide review of 2026-11-14, cut X3).

Nothing ends a count early: a caller that leaves (a closed request, a stopped job) still leaves its count running, and
the counts queued behind it wait for it. The `tokenizers` guide's Limitations record the split.

**Why it matters:** a text near the route's 2 MiB cap, from a signed-in client, an imported card, or a model reply,
can hold every other token count of the instance (a send's prompt count in another chat, an editor's count) for
seconds to tens of seconds on those families.

**Suggested handling:** slice 3 of the [Tokenizer Worker plan](../plan/tokenizer-worker.md): a second worker for texts
over 131,072 UTF-16 units, and an aborted caller ends its long count.

**Decision:** owner, 2026-11-21: not fixed in a found-issues round; the worker thread design gets its own plan.
