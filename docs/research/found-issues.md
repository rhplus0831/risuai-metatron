# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, and the nineteenth (the Upstream Intake 2 run) on 2026-11-10; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's section of [known issues](known-issues.md) (or to the guide's Known Hazards `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

The eighteenth batch was cleared the same day by a Sol implementer with session verification (seven entries fixed with regression tests; the rendered-translation quote entry was closed as not reproduced: a scratch replay of the rendered path with identity Google and LLM translators kept quoted font names, `url("…")` and `content:"…"` intact in every one of twelve cases).

## Contents

- [Plugin sandbox](#plugin-sandbox): 3

## Plugin sandbox

### The guest bridge never drops a registered callback, so proxies it captures are never released

`GUEST_BRIDGE_SCRIPT` in `src/ts/plugins/apiV3/factory.ts:69` keeps every function a plugin passed to the host in
`callbackRegistry` (set at `:94`) until the sandbox ends; nothing removes an entry when the host drops its listener. A
callback that captures a guest proxy (a `SafeElement`) keeps that proxy reachable, so the `FinalizationRegistry`
release added by Upstream Intake 2 slice 2 never fires for it, and the host `instanceRegistry` entry stays too. Found by
the slice 2 challenger; not reproduced.

**Why it matters:** a long-running plugin that adds and removes listeners still grows both registries until reload.

**Suggested handling:** a host-side callback release message (like `RELEASE_INSTANCE`) when the host drops its
callback wrapper, deleting the guest's `callbackRegistry` entry.

### A host callback whose post fails leaves the refs it serialized in `instanceRegistry`

`SandboxHost.deserializeArgs`'s callback wrapper (`src/ts/plugins/apiV3/factory.ts:690–733`) serializes the callback's
arguments, allocating `instanceRegistry` refs for remote-required values, before the `INVOKE_CALLBACK` post. When
`postMessage` throws (an uncloneable argument after a remote-required one), the catch at `:729` removes only the
pending callback; no guest proxy exists, so nothing releases those refs until `terminate()`. The slice 2 challenger's
probe reproduced it: one remote argument plus a function argument left one registry entry and no pending callback.

**Why it matters:** a small leak per failed callback delivery.

**Suggested handling:** record the refs `serialize` allocates for that post and delete them in the catch.

### A plugin setter's chat baseline is taken after the `dbWrite` prompt, so a read during the prompt can replace it

`setChatToIndex` in `src/ts/plugins/apiV3/v3.svelte.ts` captures its target before the consent prompt (`:2949`) but
takes the instance's retained read baseline only afterwards (`takeChatRead`, `:2960`); the character setters reconcile
against `rememberChatRead`/`pluginChatBaselines` after consent too. If the same plugin instance reads the chat again
while the first `dbWrite` prompt is open and another tab or client changed the chat meanwhile (the modal blocks local
edits), the setter diffs against the newer baseline, and `applyChatResult` (`src/ts/storage/chatStore.svelte.ts`) can
treat the plugin's stale message as a change and overwrite the other edit. Raised by the slice 4 challenger and left
as an edge case for that slice (the prompt shows once per page load or three days); unverified.

**Why it matters:** a remote edit can be lost in a narrow window around the first `dbWrite` grant.

**Suggested handling:** verify with a test first; for `setChatToIndex`, peek (not take) the baseline before consent;
the character setters need a reservation policy.
