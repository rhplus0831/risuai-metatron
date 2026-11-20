# Upstream Intake 3 Plan audit, 2026-11-21

- Plan: `docs/plan/upstream-intake-3.md`
- Commit audited: `bfdec4e5e` (`dev`)
- Mode: `full`, run by the drafting session before any plan-runner run
- Model: GPT-6.2-Astra (`xhigh`), read-only, three turns (the audit and two fix confirmations); report written by the
  drafting session (Claude Fable 5.2)

| Severity   | Count |
| ---------- | ----- |
| P1         | 2     |
| P2         | 16    |
| P3         | 10    |
| unverified | 3     |

The first turn filed A1 to A24 against the draft. The second turn read the corrected plan, confirmed twelve fixes,
disputed one (A11) and filed B1 to B6 against the new text. The third turn confirmed the fixes for B1 to B5 and filed
C1. Every P1, P2 and P3 is `fixed in plan` in the commit that adds this report. Tests and browser behavior were not
run; the auditor read source and Git objects only.

The two P1 findings are fixed by removing the work they concern, which changes the plan's scope: the edit hook skip
(the draft's slice 5, upstream `66ab5e5f5`) is no longer ported and its Inventory row is `deferred`. The owner had
chosen "measure, then port only if it pays" for it and had not confirmed the deferral when this report was written.
No remaining slice touches the edit hooks.

Added later on 2026-11-21: the owner confirmed the deferral, and the plan's Status line, Decisions and Open Questions
were updated in the commit that adds this note. No slice text changed after the audit's last confirmation turn.

Found consistent: the range (`4d87a70ff` is an ancestor of `b5bbc5647`; 27 commits, 10 non-merge, 17 merges, 9
first-parent entries; 16 merges match the automatic merge and `72baef272` only reconciles a test file and an import
line); the three excluded storage commits and the unchanged save format (only `src/ts/bootstrap.ts:500` still reads
`accountst` and `dosync`); the equivalent stream decoding (`server/src/llm/sseLines.ts:13`,
`server/src/tests/llmStreamParsing.test.ts:251`); slice 1's wire path (the question payload is passed on whole,
`server/src/jobs/channel.ts:716`, and reaches the dialog, `src/ts/network/jobChannel.ts:502`); slice 2's transport
(`shared/jobs.ts:796`, the explicit payload construction at `server/src/lua/bindings.ts:969`, the two other callers at
`server/src/prompt/runner.ts:2232` and `server/src/prompt/triggers.ts:995`) and the name's uses (never an id, a file
name or markup; `src/lib/Playground/PlaygroundInlayExplorer.svelte:240`); slice 3's storage and reroll paths
(`server/src/lua/bindings.ts:740`, `server/src/jobs/chatResult.ts:169`); slice 4's settings (the `TextAreaInput`
props, the section view's save path, no allow-list or pinned model list, and a stored value that matches no option
left alone on mount: `src/lib/UI/GUI/SelectInput.svelte:35`); and the ledger sections, R1, T5 and V6 the close-out
names.

Re-check list: `patchMessage` closes an open fence (`server/src/data/chatStore.ts:2596`), not touched; feed rows are
measured whole (`chatStore.ts:2014`, `:2029`), not touched; `STORE_TABLES_SQL` runs on version-zero initialization or
an exclusively created staging database (`server/src/data/resourceStore.ts:3898`, `:782`), not touched. `sendText` is
relevant to slices 1 and 2, which ask the owner tab: it counts an eligible successful send as a possible delivery,
subject to audience and buffer admission (`server/src/jobs/generationJobs.ts:1047`, `:1064`), not any open socket, and
neither slice needs that rule to change. The list's fourth entry is still worded more broadly than the code.

## P1

### A1 — Slice 5 and D5: a remembered "no listener" is wrong for the next run — fixed in plan (slice removed)

Plan, slice 5: "a code known to register no listener for `mode` is skipped" and "the user code's top level runs
before the access key exists … so it cannot call a keyed API or read chat state through one."

Code: the host functions are installed before the user chunk runs (`server/src/lua/runtime.ts:607`, `:639`), and many
need no key: `getChatVar` (`server/src/lua/bindings.ts:1395`), `getGlobalVar`, the chat getters (`:1429`, `:1554`),
`getName`, the persona and lore readers (`:1593`, `:1635`, `:1745`), `cbs`, and the image getters, which can ask the
tab to draw and store an inlay (`:1821`). The same code can register a listener in one chat and none in another, or
change within one job.

Fix: the slice and D5 are removed; `66ab5e5f5` is `deferred`, and D1 lists what a later design must meet.

### A2 — Slice 5: registration does not show that dispatch is a no-op — fixed in plan (slice removed)

Plan, slice 5: "The runtime reports what a load registered" and "`data` passes on unchanged."

Code: the prelude assigns `callListenMain` to a writable global (`server/src/lua/runtime.ts:417`) and dispatch looks
it up after the script loaded (`:777`). A script can edit through its own dispatcher without calling `listenEdit`;
its first target would be edited and its second left unchanged.

Fix: as A1.

## P2

A3 to A8 concern the removed slice and are closed with it; each is recorded because a later design needs it.

- A3 — `LuaRunOutput` survives the worker boundary whole (`server/src/scripts/worker.ts:167`,
  `server/src/scripts/workerPool.ts:796`), but `createRunSetup` rebuilds a `LuaOutcome` field by field
  (`server/src/jobs/runSetup.ts:362`) and `RunSetup` exposes neither the pool nor a cache; the pool is created per
  server context (`server/src/app.ts:553`).
- A4 — For `editRequest` an untouched list is a different result: the JSON round trip returns new objects, and
  assembly compares entry identity for `attributionExact` (`server/src/prompt/assemble.ts:2552`,
  `server/src/tests/assemble.test.ts:2581`, `:2602`).
- A5 — An ordinary load error returns the original input of the whole chain and ends it
  (`server/src/prompt/scripts.ts:93`); a skip before the pool would also bypass the abort, budget and input checks
  (`server/src/scripts/workerPool.ts:536`, `:840`) and `flushChatMetadata` (`server/src/jobs/runSetup.ts:357`).
- A6 — `runLuaEdit` is the adapter for the four ordinary edit hooks, but a manual command, `/trigger` or
  `v2RunTrigger` can pass an edit mode's name through the native trigger path (`server/src/jobs/commandRunner.ts:175`,
  `server/src/prompt/triggers.ts:652`, `:904`); `server/src/tests/transformBudget.test.ts:62` expects both targets to
  run.
- A7 — Upstream keeps the current engine per mode and replaces it when that mode's source changes
  (`b5bbc5647:src/ts/process/scriptings.ts:79`, `:85`, `:1275`); a process-wide cache by code would be another
  lifetime.
- A8 — The 20 to 110 ms range extrapolated pool throughput: the route awaits targets one after another inside a
  request (`server/src/prompt/transform.ts:805`), the baseline chat has no module, and a skipped task leaves module
  lookup and the display trigger (`server/src/prompt/triggers.ts:385`).

The rest are `fixed in plan` with the sentences below.

### A9 — Slice 1: a non-primitive third argument fails before the binding — fixed in plan

Plan: "Add an optional third, `defaultValue`, and pass it to `alertInputMain`" and "anything else asks as today."
Code: a table or function fails `checkHostArgs` (`server/src/lua/runtime.ts:458`, `:800`) before `alertInputMain`.
New: "After the `__safeKey` check, forward it to `alertInputMain` only when `type(defaultValue) == "string"`;
otherwise make today's two-argument call." The test uses a table as the ignored argument.

### A10 — Slice 2 and D4: the name must be filtered in Lua, and the limit has an upper edge — fixed in plan

Plan: "Encode `name` beside it" and "a longer one is answered with an error string."
Code: the Lua JSON encoder fails on a function or a cyclic table (`public/lua/json.lua:64`, `:130`); a very large
string hits `MAX_HOST_ARG_CHARS` (`server/src/lua/runtime.ts:467`) before the binding; the binding checks the grant,
then `orientation` (`server/src/lua/bindings.ts:1803`).
New: `name` enters the options table only when it is a string; the binding keeps the guard first and the orientation
check second; a name that exceeds the host-argument cap fails as any oversized argument does, and D4 covers the names
that reach the binding; `generateImageInlay`'s options type and payload gain `name`.

### A11 — Slice 3: the failure described does not happen for an edited getter table — fixed in plan

Plan: "when it edits a message's text and passes the list to `setFullChat`, the item carries no `id`."
Code: a getter's table keeps its `id` (`server/src/lua/bindings.ts:732`), and the round trip is tested
(`server/src/tests/luaBindings.test.ts:1640`, `:1660`). The failure is for an item built anew with only `chatId`.
New: the slice says so, and the order is "an unused stored message by `id`, then by `chatId`, then today's positional
rule. A usable `id` wins when the two disagree." The auditor disputed the first correction's "the only new behavior";
B1 closes that.

### A12 — Slice 4: a cancelled picker — fixed in plan

Plan: "`selectSingleFile(["json"])` … decode as UTF-8, `JSON.parse` to validate."
Code: the helper returns `null` on cancel (`src/ts/util.ts:83`).
New: "returns `null` on cancel, so return then without an alert or a write", with a test.

### A13 — Header and Inventory: the counts — fixed in plan

Plan: "The remaining five commits become the five port slices" and "Totals: 5 gap."
The table had six `gap` rows. New, with the skip deferred: 5 gap commits in four port slices, 1 equivalent,
3 excluded, 1 deferred.

### A14 — Order: the priority line contradicted the chain — fixed in plan

Plan: "Priority when slots are short: 3 and 1 first … then 2." Slice 3 depends on 2, which depends on 1.
New: "With two slots, the Lua chain takes one and slice 4 the other."

### A15 — One commit per slice against "a commit and its revert"; Partial ports for a dropped slice — fixed in plan

The commit-and-revert branch went with the removed slice. New, close-out: "Partial ports entries only for what
landed."

### A16 — Close-out: "Metatron checked" cannot be the close-out commit — fixed in plan

Plan: "`Metatron checked` to the commit of this slice." The previous intake recorded the parent of its ledger commit
(`docs/backlog/upstream-ledger.md:20`).
New: "the verified `HEAD` right before this slice's own commit, after every accepted port landed."

### B1 — Slice 3 and D2: "the only new behavior" overstated — fixed in plan

Plan (first correction): "Nothing stored changes and nothing migrates; the only new behavior is for an item that
carries `chatId` without a usable `id`."
Code: `used` is shared across the list (`server/src/lua/bindings.ts:736`, `:749`), so an earlier item's `chatId`
match can take the message a later item names by `id`; the getters' new field is visible to every script.
New: "No migration runs. The getters expose both names, which every script can see. On later writes each item tries
an unused `id`, an unused `chatId`, then position, and because a stored message serves one item only, an earlier
item's `chatId` match can take the message a later item names."

### B2 — Close-out: D4's limit is a difference from upstream — fixed in plan

Plan (first correction): "Partial ports entries only for what landed: slice 3 … and slice 4."
Code: upstream generates first and accepts any non-empty name (`b5bbc5647:src/ts/process/scriptings.ts:422`, `:430`).
New: the list names slice 2 too, "D4's 200-character limit and its error before generation."

## P3

Each is `fixed in plan`; the corrected text is in the plan.

- A17 — Order: the file list did not explain the chain's edges. Now each pair's shared files are named.
- A18 — Baseline: `b5bbc5647` was committed 2026-11-20 and observed 2026-11-21.
- A19 — Slice 4: the English help entry matches upstream; only the Korean one is this fork's wording.
- A20 — Inventory, `46311cc28`: Metatron decodes block backups on import (`server/src/data/upstream/risuSave.ts:17`)
  and has no live pruning; snapshots keep by default the newest 20 unpinned files plus protected ones
  (`server/src/data/snapshots.ts:11`, `:327`).
- A21 — Removed slice: production edit bindings have no log sink (`server/src/lua/bindings.ts:1975`), so a skip
  would have suppressed nothing there.
- B3 — Not In This Plan: upstream reuses the current engine per mode, not one engine per script.
- B4 — D1: the timings are stated as reported, the pool figures apart from the route delta, with "Neither measurement
  isolates the saving from skipping a load."
- B5 — D1: `attributionExact` is confidence in source attribution; returning the original entries can change it even
  when the text is identical (`server/src/prompt/assemble.ts:2556`).
- B6 — Header: "corrected in the same commit as the report" was written before that commit existed. It is true as of
  the commit that adds this file.
- C1 — Inventory: "the three conditions in D1" after D1 gained a fourth. Now "the conditions in D1."

One accepted effect the audit added to slice 2: asset cleanup reads every string in an inlay's record
(`server/src/data/assetLifecycle.ts:178`, `:569`), so a name that spells an asset or inlay reference keeps that
asset, another character's in the same store included, from being collected (`:1316`, `:1340`). It cannot select
anything for deletion, and names of imported files already have the same property
(`src/ts/process/files/inlays.ts:368`).

## unverified

- A22 — The timings in D1 are the drafting session's own, from a pool probe and one run of
  `util/playwright/measureTransformLua.mjs` on 2026-11-21. Nothing checked in records them. The plan now labels them
  so and draws no saving from them.
- A23 — The owner's NovelAI request with the medium model, and the options it left out, are the owner's report. The
  source shows only that the stored model name is sent as it is (`src/ts/process/stableDiff.ts:256`).
- A24 — That six Luna workers compared the commits and that the owner accepted the defaults is the drafting session's
  account.
