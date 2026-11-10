# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, and the nineteenth (the Upstream Intake 2 run) on 2026-11-10; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

## Contents

- [Plugin sandbox](#plugin-sandbox): 1
- [Structure audit 2026-11-10](#structure-audit-2026-11-10): 6

## Plugin sandbox

### The full-screen alert e2e test failed once with a closed page

`e2e/pluginSandbox.spec.ts:229` ("plugin permission alerts paint above the full-screen plugin container", added by
Upstream Intake 2 slice 11) failed once in four runs on `dev` at the end of that run: `frame.evaluate: Target page,
context or browser has been closed` at its first line (`requestMainDomInFullscreen`). The other three runs, each with
`--force`, passed all four tests of the spec. During the failing run the session was editing Markdown files in the
checkout; no other test or dev stack was running.

**Why it matters:** a new e2e test with an intermittent failure; the stability measurement of 2026-11-08 had none.

**Suggested handling:** repeat the spec (`--force`, several runs) to measure the rate; if it recurs, check the trace
for a page reload or an iframe re-attach when the container moves to the body.

## Structure audit 2026-11-10

Found by the Sol auditors of the [full guide audit](../audit/structure-audit-2026-11-10.md) while reading each guide
against the source at `e44b4786b`. Each of the first five was traced through the code by its auditor and, separately, by
a Luna checker; none was run. They are code defects, so the audit recorded them here and changed no source.

### A `<style>` with an attribute or in capitals reaches the page with unscoped CSS

`encodeStyle` in `src/ts/parser/parser.svelte.ts:1319` matches only a lowercase, attribute-free `<style>` (`styleRegex`),
and `trimPurifyConfig` (`:1157`) allows ordinary `style` elements. A message holding
`<style media="all">body{display:none}</style>`, or `<STYLE>`, is therefore never turned into `<risu-style>`:
`trimMarkdown` returns the sanitizer's output without scoping (`:1208`), the shared-style path copies the raw CSS
(`:1275`, chosen by `src/lib/ChatScreens/ChatBody.svelte:575`), and `src/ts/parser/chatStyles.ts:82` installs it as a
live stylesheet.

**Why it matters:** index rule S1 and the rendering guide require chat CSS to stay under `.chattext`; a card, a model
reply, or a script can style or hide the whole page.

**Suggested handling:** reproduce in a mounted `ChatBody` with both spellings; then match `<style` case-insensitively
with attributes in `encodeStyle`, or scope every `style` element the sanitizer returns.

### A popup editor's draft can land on another row that holds the same text

`src/lib/UI/GUI/TextAreaInput.svelte:110` accepts a popup's write-back when the original string, the owner context, the
context revision, and the session match; nothing identifies the row. `src/lib/Setting/Pages/PromptSettings.svelte:199`
and `src/lib/SideBars/Scripts/RegexList.svelte:85` render unkeyed lists bound by index and pass only the preset or
character id as the context. With two prompt rows A and B of equal text, a popup opened on A, and another client
replacing the template with `[B, A]`, closing the popup writes the draft into B. The UI guide already lists this as an
`Unconfirmed:` issue ([Known Hazards](../structure/ui-theming.md#known-hazards)).

**Why it matters:** an edit silently changes the wrong prompt or regex row; it needs a second writer and equal text, so
it is rare.

**Suggested handling:** reproduce with a two-client e2e check; then carry a row identity (the prompt item's or script's
id) in `popupEditorContext`. Once reproduced, move the guide's bullet to known issues.

### `pnpm check:changed` passes an e2e type error without running a compiler

`util/changedChecks.mjs:27` lists `e2e/` in `INERT`, so `typeCheckTargets(['e2e/fixtures.ts'])` returns
`{ client: false, server: false }` (`:50`), no program is queued (`:145`), and the command exits 0 (`:171`).
`pnpm check` runs `tsc -p e2e/tsconfig.json --noEmit` (`package.json`), and index rule V1 offers `pnpm check:changed` as
its equivalent.

**Why it matters:** a change that touches only `e2e/` passes the type gate unchecked, and Playwright does not type-check
either.

**Suggested handling:** give `changedChecks.mjs` an e2e target that runs the e2e program when a path under `e2e/`
changed, with a case in its test.

### `util/playwright/captureBootFixtures.mjs` imports exports the app no longer has

The driver imports `getDatabase` from `src/ts/storage/database.svelte.ts` (`:27`), preset exports (`:34`), and `DBState`
(`:42`); that module is now a compatibility entry point whose exports (`:26`–`:38`) hold none of them, so the first
snapshot fails before any fixture is written. `src/ts/storage/tests/fixtures/boot/README.md` already says the fixtures
are maintained by hand. The test-harness guide now says the driver cannot capture; the script is still in the tree.

**Why it matters:** a tool that looks runnable and is not; V4 asks that scripts reading source follow renamed exports.

**Suggested handling:** delete the driver, or rewrite it against the record API if recapturing is wanted.

### The lifecycle guide's checkpoint benchmark has no audit report to point to

`docs/structure/structured-memory/lifecycle.md` (Limitations) states "2,000 old runs went from 79 MB and a 751 ms save
to 237 KB and 20 ms". Doc Maintenance puts a run's measurements in `docs/audit/`, but
`docs/audit/structured-memory-2026-11-03.md#checkpoint-save` holds other timings and no figure after the prune, and the
archive (`docs/archived-plan/README.md`) records 751.54 ms to 19.55 ms and 79 MB to 236 KB, one kilobyte off the guide.
The audit left the bullet as it is because the figures had no destination.

**Why it matters:** a measurement in a guide with no report behind it cannot be re-run or checked.

**Suggested handling:** add the before and after figures to the audit report's checkpoint section from the archive
entry, then shorten the guide bullet to the consequence and the link.

### The wasmoon private-API note sits in the server-generation guide, not at the module

`docs/structure/server-generation.md` (Known Hazards) says `server/src/lua/runtime.ts` uses wasmoon 1.16's private
extension table and C API, "which must be rechecked on a wasmoon upgrade". It is one module's dependency, the module
belongs to scripts-triggers by `pnpm docs:owner`, and the comments at `LuaWasmInternals`, `installValueGuard`, and
`installHook` describe the private API without the upgrade condition. The audit left the bullet because deleting it
would lose that condition.

**Why it matters:** an editor upgrading wasmoon reads the module or the scripts guide, not server generation.

**Suggested handling:** add the recheck-on-upgrade sentence to the `LuaWasmInternals` comment, then delete the guide
bullet (a source edit, so it runs the V1 gate).
