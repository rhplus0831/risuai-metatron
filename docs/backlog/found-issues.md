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

## Contents

- [Docs](#docs): 1
- [Rendering](#rendering): 1
- [Server generation](#server-generation): 1

## Docs

### The server resources guide is near its size limit

Measured on 2026-11-23 at `667444a93`: `docs/structure/server-resources.md` is 38,481 bytes (target 36,000, limit
40,000), and `pnpm check:docs` reports it `near`. The Chat Trash sections (`### Chat Trash`, `### Chat Trash
retention`, the column bullet under `### Store tables`, the snapshot layout paragraph under `### Install`, and a
Limitation) took it there from 35,539.

**Why it matters:** with 1,519 bytes left, the next server-side change that adds to this guide has to split it first.

**Suggested handling:** trim or split it in its own commit. Candidates: the long `### Limitations` (about 5.3 KB) and the
route lists under `## Files`.

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
