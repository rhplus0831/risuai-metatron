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

- [App startup](#app-startup): 1
- [Backup sync](#backup-sync): 1
- [Chat screen](#chat-screen): 1
- [Docs](#docs): 1
- [Rendering](#rendering): 1

## App startup

### The window error handler throws on an error event without an error

Seen on 2026-11-22 in a headed-Chrome probe and read again at `7cb004284`. `updateErrorHandling`
(`src/ts/bootstrap.ts:445`) reads `event.error.target`. Chrome dispatches the "ResizeObserver loop completed with
undelivered notifications" error with `error` set to null, and a cross-origin script error has no error object either,
so the handler throws its own `TypeError` for each such event. The probe that showed it (21 secondary errors in one
batch) ran a prototype that caused ResizeObserver loops; no current code path was shown to cause one.

**Why it matters:** low. Each such event adds a second page error to the console, and the alert the handler meant to
decide on never runs.

**Suggested handling:** read `event.error?.target`, and decide whether an error event without an error should alert
at all.

## Backup sync

### An upstream backup commit whose 200 body is unreadable is treated as failed

Read only (2026-11-24, from the Bounded Client Waits audit's B08, not reproduced). `commitUpstreamImport`
(`src/ts/drive/upstreamBackupClient.ts:128`) reads the commit answer with `res.json()` inside a `catch {}`, so a 200
whose body is cut off becomes an empty answer, which the caller turns into a `ServerImportAnswerError`.
`commitAnswerLost` (`:183`) treats only a `TypeError` and a gateway status as a lost answer, so that error takes the
failure path, which unregisters the restore-selection hook (`:247`) although the server answers 200 only after it has
replaced the database.

**Why it matters:** after a restore that did land, the tab may not keep the restored prompt preset, model preset and
persona selection, and the user is told the restore failed.

**Suggested handling:** reproduce with a held or cut 200 body; then treat a 200 whose body cannot be read as a lost
answer (keep the hook and ask the user to reload), as the gateway case does.

## Chat screen

### Saving through the automatic popup editor can move the view by the row's height change

Measured on 2026-11-22 at `efba3bf17` in headed Chrome (2 of 2 runs), read again at `7cb004284`. With the automatic
popup editor on (the default), `startOriginalEdit` (`src/lib/ChatScreens/Chat.svelte:835`) calls
`onOpenInlineEditor` only when the popup is off, so `Chats.svelte` records no `editorPlace` for the row
(`openInlineEditor`, `src/lib/ChatScreens/Chats.svelte:813`) and `closeInlineEditor` (`:833`) has nothing to restore.
While the popup is open the row takes its shorter editor layout; when the view's top is inside the row, the browser's
scroll anchoring picks a node of an earlier row, and on save the reader stays at that node. In the run, a 1,457 px row
became 439 px and the reader ended 1,018 px higher. With the view's top near the row's start the save returns to the
pre-edit place.

**Why it matters:** after editing a long message in the popup, the reader lands on an earlier message and has to
scroll back.

**Suggested handling:** record the editor place on the popup path too (without the inline reveal), so the close
restores it.

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
