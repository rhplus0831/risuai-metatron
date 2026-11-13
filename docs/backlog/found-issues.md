# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, the seventeenth (the Found Issues Decisions run) on 2026-11-09, the nineteenth (the Upstream Intake 2 run) on 2026-11-10, the twentieth (the Memory Panel Readability run) on 2026-11-11, the twenty-first (the Structured Memory Recent Timeline run) the same day, the twenty-second (the Per-Chat Memory run) on 2026-11-13, and the twenty-third (the Lore Budget Send Stop run) the same day; single entries move as they come up.

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

## Contents

- [Assets](#assets): 1
- [Characters](#characters): 2
- [Memory](#memory): 1
- [Plugins](#plugins): 3
- [Selection](#selection): 1
- [Server generation](#server-generation): 1
- [Settings](#settings): 3

## Assets

### The preview and sweep test passes without the preview key lock

`server/src/tests/assetPreview.test.ts:182` finishes a preview before it starts a sweep, and the sweep before the next
preview; the two never overlap. With the lock keys of the preview route emptied (`[fullPath]` to `[]` in
`server/src/routes/assetLifecycle.ts:80`), all five preview tests still pass. The product holds the lock; only the
test cannot tell. Found 2026-11-14 by the wide review (cut R6).

**Why it matters:** the Storage Settings Page plan's D8 (a preview and thumbnail generation share the sweep's asset
lock) has no test that fails when the lock is removed.

**Suggested handling:** hold thumbnail generation at a controlled point, start the sweep, assert it waits, release,
and check the file and cache; cover the reverse order too.

## Characters

### The legacy JSON card import drops a persona and greeting given as `char_persona` and `char_greeting`

The import accepts a JSON card that names its fields `char_name`, `char_persona`, and `char_greeting`
(`src/ts/characterCards.ts:278`), but `convertOffSpecCards` reads the persona and the greeting only from `description`
and `first_mes` (`characterCards.ts:988`, `:989`); `1dc0f53a3` repaired the name alone. Found 2026-11-14 by the wide
review (cut F3) and confirmed by a second reader: such a card imports as a success with an empty description and the
greeting `unknown first message`.

**Why it matters:** an accepted card is saved without its persona and greeting, and nothing says so. The source file
can be imported again after a fix.

**Suggested handling:** fall back to the alias when the canonical field is null or undefined, canonical first, as the
name does.

### Autosave stores a cleared VOICEVOX scale as null

The four VOICEVOX scale inputs bind straight to the character record and repair a non-finite value only in `onChange`
(`src/lib/SideBars/CharConfig.svelte:1208`, and `:1216`, `:1224`, `:1232`). A cleared field that still has focus holds
`null`, and autosave writes it before the change event runs. Found 2026-11-14 by the wide review (cut F6) and
confirmed by a second reader through the real resource sync: the server record held `null` while the field had focus.
`src/ts/process/tts.ts:303` passes the scales to VOICEVOX without a fallback.

**Why it matters:** an ordinary edit stores an invalid scale that other clients and a reload read.

**Suggested handling:** a function binding whose setter refuses a blank or non-finite value, so the draft stays in the
box and never enters the record.

## Memory

### A send's HypaV3 checkpoint counts a summary the projection guard dropped

`checkpoint` in `server/src/prompt/assemble.ts:816` returns `"committed"` as soon as `write.merge` produces a value
inside `host.writeMemory`; it never checks that the stored `hypaV3Data` kept it. When the projection owns the field,
the server's write guard (`refusesHypaV3Data` in `server/src/data/chatStore.ts`) drops the summary, but the send's
HypaV3 execution counts it as saved. The detached task's `checkpointOf` in `memoryTasks.ts` confirms the write since
the Per-Chat Memory plan's slice 2 (`15996bb5b`); the in-job path was outside that slice. Found 2026-11-12 during that
slice. Reproduced 2026-11-14 in a running server (wide review, cut X2, and a second run): with the mode changed while
the summary was in flight, the send's provider request carried the new summary, the stored metadata had no
`hypaV3Data`, and the next HypaV3 send summarized the same messages again; with the mode unchanged the summary was
kept and not requested twice.

**Why it matters:** a send treats a gap as summarized while nothing was stored, and the next send pays for the same
summary again; per-chat modes make the mode changes that lead there casual.

**Suggested handling:** make the in-job checkpoint (`assemble.ts:857`) confirm the stored value as `checkpointOf`
does and return `skipped` so the existing recovery runs, with a regression test that moves a chat to Structured
Memory while a send's HypaV3 summary is in flight.

## Plugins

### A whole-database plugin write saves a stale message over an edit made during its consent dialog

`setDatabase` and `setDatabaseLite` capture the scope, the target characters, and their owner tokens, then wait for
the dbWrite consent (`src/ts/plugins/apiV3/v3.svelte.ts:2653`, `:2663`). Whether an incoming chat is an unchanged
round trip is decided only after the wait (`pluginChatsMatch` at `:2265`), and `applyPluginCharacter` is called
without a read baseline (`:1997`), so the baseline is captured late (`src/ts/storage/chatStore.svelte.ts:4853`). A
chat that matched when the setter was called stops matching when another client's edit arrives while the dialog is
open, and the plugin's old copy of the text is then written as a new edit. Found 2026-11-14 by the wide review (cut
R5): a plugin that changed only a character's name reverted a message another client had edited and saved during the
dialog, for both setters. The dedicated character and chat setters capture before the wait.

**Why it matters:** an acknowledged message edit is lost from the stored chat without the plugin having touched a
message. It needs a plugin that passes whole chats back through a database setter, an open consent dialog (first
grant, reset, or the three-day reconfirmation), and a second client editing one of those chats meanwhile.

**Suggested handling:** decide the unchanged chats synchronously at both setters' entry and carry that through the
consent wait into the shared reconciliation, keeping the validation and owner checks. A local change in
`v3.svelte.ts`; a general whole-database merge is not needed for this.

### A text-node mutation makes the plugin mutation observer throw and lose the batch

The observer wraps every record's target in `SafeElement` (`src/ts/plugins/apiV3/v3.svelte.ts:657`), whose constructor
calls `getAttribute` (`:244`). A `characterData` record's target is a text node, so the mapping throws before the
plugin's callback and the other records of the batch are lost with it. `8657b12f2` repaired added and removed nodes
only. Found 2026-11-14 by the wide review (cut F5) and confirmed by a second reader: observing a container with
`subtree` and `characterData` and changing a text node delivered nothing and threw `element.getAttribute is not a
function`.

**Why it matters:** a plugin that watches streamed text through the declared API receives no notification at all.

**Suggested handling:** deliver the batch, giving a non-element target as its parent element under the same wrapper or
omitting that record.

### A cleared plain integer plugin argument is stored as null

The integer argument's number field without radio or checkbox metadata binds straight to `realArg`
(`src/lib/Setting/Pages/PluginSettings.svelte:309`); the radio branch got a finite setter, this one did not. Found
2026-11-14 by the wide review (cut F6) and confirmed by a second reader: clearing and committing the field stored
`null`, which the server's plugin normalizer keeps and `getArgument` (`v3.svelte.ts:2877`) returns unchanged.

**Why it matters:** a plugin that declared an integer receives `null` after an ordinary edit, against
`shared/plugins.ts:8`.

**Suggested handling:** the finite setter of the radio branch: a blank draft stays in the box and the stored number is
kept.

## Selection

### `onCharacterSelected` has no product listener left

`onCharacterSelected` (`src/ts/storage/selection.svelte.ts:155`) lost its only product registration when the Per-Chat
Memory plan's slice 1 (`ea39acfcb`) removed the `alwaysToggleOn` hook in `characterStore.svelte.ts`. Only tests
register listeners now (`src/ts/storage/tests/characterRecords.test.ts`, the selection probe in
`resourceSyncLive.test.ts`). No guide names it. Found 2026-11-12 during that slice.

**Why it matters:** a dead extension point keeps its ordering contract (listeners run after the selection changes) and
its tests with no caller to need them.

**Suggested handling:** drop the function and the tests that only exercise it, or keep it with a module comment
saying it is a deliberate hook.

## Server generation

### A long unbroken run of letters stalls every request while its tokens are counted

The `o200k_base` and `cl100k_base` encoders take quadratic time on one unbroken run of letters, and the server
encodes synchronously on the thread that serves every request (`server/src/prompt/tokenizers/index.ts:131`). The count
route passes the caller's text with a 2 MiB body cap and no limit per string (`server/src/routes/tokens.ts:110`).
Found 2026-11-12 while speeding up `promptRunner.test.ts`. Reproduced 2026-11-14 in a running server (wide review,
cut X3, and a second run): a 200 KB run counted with `o200k_base` held an unrelated boot read for 17.6 s (15.2 s on
the rerun) and `cl100k_base` for 16.6 s; the other 13 local families stayed under 0.5 s, and the same bytes with
spaces took 84 ms. A mock model reply of 200 KB stalled the server 17.7 s; a send over a chat that already stores
such a message took 78.7 s, a preview 32.3 s, and a memory test 39.1 s. The `server-generation` guide's Limitations
record tokenizer calls on the main thread as accepted on 2026-11-10 (worker isolation is a separate design); that
decision carries no numbers.

**Why it matters:** one signed-in client, an imported card, or a model reply can leave an instance answering nobody
for the length of the count.

**Suggested handling:** the owner's note of 2026-11-14: "Token counting isn't always fast, so I'm considering moving
it to a worker thread." A size refusal before encoding at the shared gateway (`tokenizers/index.ts:19`) is the cheap
bound; it was offered and not taken, since it also refuses legitimate large text. An exact count of a large text
needs the encode off the serving thread, which is the worker design.

## Settings

### The lorebook token limit inputs cap at 4096 under a default of 8000

Both inputs of the lorebook token limit carry `max` 4096: the global one (`adv.lbToken` in
`src/ts/setting/memorySettingsData.ts:21`) and the lorebook's own (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:157`).
The default is 8000 (`server/src/data/normalize/providers.ts:7`). `NumberInput` passes `max` to the element as an
attribute only, so a typed value above it is stored, but the stepper stops at 4096. Found 2026-11-13 by the Lore
Budget Send Stop plan's audit. Checked 2026-11-14 in Chromium (wide review, cut X1, and a second run), on both
inputs: ArrowUp does nothing at 8000, one ArrowDown from 8000 stores 4096, and a typed 9000 is stored and used. The
mouse spinners are hidden, so only keyboard stepping reaches it. With the lore budget stop on (the default), a send
that no longer fits at 4096 stops with the dialog and calls no provider; with the stop off, the entry is left out.

**Why it matters:** that plan's dialog sends a person to these inputs to raise the limit, where the box suggests 4096
is the most, and one arrow key lowers a stored 8000 to 4096.

**Suggested handling:** drop the `max` or raise it to a value above the default, on both inputs.

### The vibe strength selector stores a non-finite imported strength

The Information Extracted selector of a vibe image writes the chosen encoding's strength without the finite check its
upload and model-change handlers have (`src/lib/Setting/Pages/ImageGenerationSettings.svelte:562`). Found 2026-11-14
by the wide review (cut F6) and confirmed by a second reader: a `.naiv4vibe` with one encoding at `1e400` uploads with
the finite one selected, and choosing the other stores `Infinity`, which the server record keeps as `null`;
`stableDiff.ts:391` then finds no encoding for it and leaves the reference image out.

**Why it matters:** an imported vibe file can leave a stored strength that drops the reference image from later
requests.

**Suggested handling:** route the selector through the finite setter and leave a non-finite option out of the list.

### `NumberInput` shows a refused blank draft again when an outside value returns to the earlier number

When a focused `NumberInput` adopts a value from outside, it keeps the draft it had refused and its comparison
baseline (`src/lib/UI/GUI/NumberInput.svelte:74`). Found 2026-11-14 by the wide review (cut F6, P3): with 3 stored and
the field cleared, an outside change to 7 shows 7, and an outside change back to 3 shows the blank again.

**Why it matters:** the box disagrees with the stored number until it loses focus. Nothing wrong is stored.

**Suggested handling:** retire the draft when an outside value is adopted.
