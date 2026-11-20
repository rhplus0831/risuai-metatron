# Upstream Intake 3 Plan

Status: drafted 2026-11-21 at `6e70b1e51`; not audited yet; nothing landed. The owner accepted the defaults of D1 to D3
on 2026-11-21; D4 and D5 are this plan's own and open to the owner's change. This is the third upstream intake, run by
the [ledger](../backlog/upstream-ledger.md)'s procedure over `4d87a70ff..b5bbc5647`: 10 non-merge commits and 17
merges, with no upstream release in the range.

Six read-only Luna workers compared the commits with Metatron by group. The session then re-read in source every claim
a slice below rests on: the Lua prelude's `alertInput`, `generateImage`, `listenEdit` and `callListenMain`, the bindings
`alertInputMain`, `generateImageMain`, `project` and `fullChatMessages`, the `generateImage` callback and its payload
type, `runLuaEdit` and the display transform's `head`, the access key's creation after the user code loads, `SseLines`,
and the ComfyUI and NovelAI fields of the image settings page. Line numbers are from that check; the identifiers are
the anchors. Re-verify each cited location before editing (`STRUCTURE.md` protocol step 5).

Half of the range does not apply: three commits touch browser storage Metatron removed, and two are already covered.
The remaining five commits become the five port slices below (slice 3 also closes a naming difference the range
opened), and slice 6 closes the intake.

One slice is one session, one commit, one file cluster. Each slice names its guide from `STRUCTURE.md` Choose By Task;
that guide's `Invariants` apply. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow` for one
marked _hard_; routine slices name no Codex challenger. Each slice ends with its tests (under "Test"), `pnpm check`,
`pnpm --silent test:agent` for the files it touches and then once whole, the owning guide's focused checks,
`pnpm format:check`, and `pnpm check:docs` for any guide edit, and updates the owning guide where it changes a
documented contract. A guide edit respects the 40,000-byte ceiling. Code comments and test titles describe behavior,
not this plan (`STRUCTURE.md` T5).

Upstream rules for every slice, unchanged from the earlier intakes:

- Port behavior, not code. Read the final upstream state of a series (`git show kwaroran/main:<path>`), not only its
  first commit.
- Commit with a conventional title and one `Upstream-Commit: <full sha>` trailer per upstream commit ported.
- Never copy upstream `package.json`, lockfiles, or version numbers.
- A new regression test fails without the change (V6). Mock I/O and process boundaries, not the code under test.

## Baseline

| Reference              | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Upstream head          | `b5bbc5647974a883ae098410388ca4201df01fa3`, the `kwaroran/main` ref, 2026-11-21         |
| Inventoried through    | `4d87a70ffb325db84dd35cb1b76b31d7074da156` before this plan; the new head after slice 6 |
| Metatron head checked  | `6e70b1e5193017342517061a6575ed6ccd996c01`, `dev`                                       |
| Compatibility version  | `2026.10.295`, unchanged: the range holds no upstream version bump (R1)                 |
| Harness current target | `f50b5942`, kept: no commit in the range changes the save format                        |

The range was read from this repository's `kwaroran` remote (`git fetch --no-tags kwaroran main`). `4d87a70ff` is an
ancestor of the new head, so no history was rewritten. The upstream checkout the ledger names now sits at `4d87a70ff`
with a clean tree, not at `f50b5942` as the ledger's Baseline text says; slice 6 corrects that sentence. Upstream paths
below are paths in upstream's tree; read one with `git show kwaroran/main:<path>` and a commit with `git show <sha>`.

Merges: 16 of the 17 match Git's automatic merge (`git show --remerge-diff` prints nothing). `72baef272` resolves two
conflicts and adds no behavior: it keeps both test groups in upstream's `src/ts/process/scriptings.test.ts` and joins
two import lines in `src/ts/process/scriptings.ts`. No merge needs a row.

Save format: the range changes upstream's `src/ts/storage/` only in `autoStorage.ts` (the account sync check) and its
test, so the harness targets stay.

## Order

- Lua, serial (slices 1, 2, 3 and 5 share `server/src/lua/runtime.ts`, `server/src/lua/bindings.ts`, or
  `server/src/tests/luaBindings.test.ts`): 1 → 2 → 3 → 5.
- Client: 4 is independent of the Lua chain.
- Close-out: 6 after every other slice landed or was dropped by a decision.

Priority when slots are short: 3 and 1 first (script compatibility with upstream), then 2 and 4, then 5.

## Slice 1. Lua `alertInput` takes a default value (_small_, `scripts-triggers.md`)

Upstream `d897bec3a`.

- `server/src/lua/runtime.ts` `LUA_PRELUDE`: `alertInput(id, value)` (~291) forwards two arguments. Add an optional
  third, `defaultValue`, and pass it to `alertInputMain`.
- `server/src/lua/bindings.ts` `alertInputMain` (~1754) asks with `payload: { message }` only. Add `defaultValue` when
  the script gave a string; anything else asks as today. The question type already carries the field
  (`GenerationQuestion` in `shared/jobs.ts` ~531) and the tab already passes it to the dialog (`ask` in
  `src/ts/network/jobChannel.ts` ~499), so neither changes.
- Keep the key guard (`__safeKey`, `isSafe`) and the answer conversion as they are.
- Test, `server/src/tests/luaBindings.test.ts` beside the `alertInput` cases (~1235): a script that passes a third
  argument produces a question whose payload holds that `defaultValue`; the two-argument form's payload has no such
  field; a non-string third argument is ignored.

## Slice 2. Lua `generateImage` names its inlay (_small_, `media-aux.md`)

Depends: 1 (same files). Upstream `bd02ca878`.

- `server/src/lua/runtime.ts` `LUA_PRELUDE`: `generateImage` (~271) encodes `{ orientation = options.orientation }`
  only. Encode `name` beside it.
- `server/src/lua/bindings.ts` `generateImageMain` (~1803) reads `orientation` from the options and calls
  `generateImageInlay(..., { orientation })` (declared ~232, defined ~962). Read `name` too: a non-empty string of at
  most 200 characters is forwarded (D4); an empty or non-string `name` means no name, as upstream; a longer one is
  answered with an error string without asking the tab, as an invalid `orientation` is. The other callers of
  `generateImageInlay` (`server/src/prompt/runner.ts` ~2232, `server/src/prompt/triggers.ts` ~995) pass no name and do
  not change.
- `shared/jobs.ts`: the `generateImage` callback payload (~796) gains `name?: string`.
- `src/ts/network/jobChannel.ts` `generateImage` case (~938–968) ends with
  `writeInlayImage(image, { check: stillWanted })`. Pass the payload's `name` when it is a non-empty string within the
  same limit; the tab checks it again and does not trust the server's copy. `writeInlayImage`
  (`src/ts/process/files/inlays.ts` ~399) already stores `arg.name ?? imgid` as the inlay's name, and the Inlay
  Explorer renders that name as text.
- The name labels the inlay; it does not choose its id, and no lookup by name exists. Do not add one.
- `media-aux.md`, Inlay images: the Lua binding and the tab forward `orientation` and `name`.
- Test:
  - `server/src/tests/luaBindings.test.ts` beside the `generateImage` cases: a name reaches the callback payload; an
    empty name, a non-string name and a missing name leave the payload without one; an over-long name returns the
    error string and the callback is not asked.
  - `src/ts/network/jobChannel.test.ts` beside the `generateImage` callback case (~1735): a payload name reaches
    `writeInlayImage`; a payload without one, or with an invalid one, writes with no name.

## Slice 3. Lua chat getters also give `chatId`, and `setFullChat` accepts it (_small_, `scripts-triggers.md`)

Depends: 2 (same files). Upstream `9067f47a6`.

Metatron fixed the defect itself in `b3e0022a6`: `fullChatMessages` keeps the stored message an item names and lays
role and text over it. What is left is the field's name. Metatron's getters give the message id as `id`; upstream's
now give it as `chatId`. A script written for upstream reads `chatId` (nil here), and when it edits a message's text
and passes the list to `setFullChat`, the item carries no `id`, the positional fallback does not match the changed
text, and the message is replaced by a new one without its translation, candidates and generation info.

- `server/src/lua/bindings.ts` `project` (~732): give `chatId` beside `id`, both the message's `chatId`. `getChat`,
  `getRecentChats` and `getFullChat` all use it.
- `fullChatMessages` (~734): when an item has no usable `id`, use its `chatId` the same way. `id` wins when both are
  present and differ. The rest of the rule (one stored message per item, the positional fallback, a new message with a
  fresh id otherwise, removal of what the list leaves out) is unchanged, in the live chat and in a trigger's working
  copy.
- Do not copy upstream's in-place mutation: Metatron's message objects may be shared with the stored copy
  (`replaceCopyMessage`'s comment), and the spread in `fullChatMessages` is deliberate.
- `scripts-triggers.md` Invariants, the "Lua's chat getters" line: both names.
- Test, `server/src/tests/luaBindings.test.ts`: the getter expectations (~1268) gain `chatId`; in "Lua full-chat
  updates" (~1595), an item that carries only `chatId` and a changed text keeps the stored message's translation,
  candidates and generation info, in the live path and the working-copy path; an item whose `id` and `chatId` differ
  follows `id`.

## Slice 4. Image settings: the ComfyUI workflow field and the NovelAI model list (_small_, `settings-i18n.md`)

Upstream `fc3dcfeab`, `918d63543`.

- `src/lib/Setting/Pages/ImageGenerationSettings.svelte`, the `sdProvider === "comfyui"` block (~798–808): the
  workflow is a single-line `TextInput` under a literal `Workflow` label. Make it a `TextAreaInput`
  (`src/lib/UI/GUI/TextAreaInput.svelte`, as `PersonaSettings.svelte` uses it) labelled `language.comfyWorkflow`, with
  the existing `<Help key="comfyWorkflow" />`, and add an upload button under it: `selectSingleFile(["json"])` (already
  imported by the page), decode as UTF-8, `JSON.parse` to validate, `alertError(language.comfyWorkflowInvalidJson)` and
  no change on a parse failure, else store the file's text in `comfyConfig.workflow`. Give the button an accessible
  name. The page edits `settings.memoryTranslateMedia`; follow how its other fields save.
- The legacy `sdProvider === "comfy"` block (~820–835) is not in upstream's change and stays.
- `src/lang/en.ts`: top-level `comfyWorkflow: "Workflow (API)"` and
  `comfyWorkflowInvalidJson: "Invalid workflow file. It must be a valid JSON."`. `src/lang/ko.ts`: `"워크플로 (API)"`
  and upstream's Korean sentence. The nested `help.comfyWorkflow` entries exist in both files and were already
  reworded in this fork; leave them.
- The NovelAI model select (~342–352): add `nai-diffusion-5-full-medium` after `nai-diffusion-5-full` and remove the
  `nai-diffusion-2` option (D3). Nothing else moves: `NAIImgModel` is a plain string with no allow-list
  (`shared/database.ts`, `server/src/data/normalize/memoryTranslateMedia.ts`), `src/ts/process/stableDiff.ts` sends
  the stored name as it is and has no version 5 branch, and its two `nai-diffusion-2` conditions (~265, ~278) and the
  page's SMEA and Decrisp conditions (~658, ~670) stay for a stored value, as in upstream.
- Test, `src/lib/Setting/Pages/ImageGenerationSettings.test.ts`: the model select offers the medium model and not
  version 2; a stored `nai-diffusion-2` is not rewritten by opening the page; uploading a valid JSON file fills the
  workflow field with the file's text; an invalid file raises the alert and leaves the field.
- The owner ran a real NovelAI request with the medium model on 2026-11-21, outside this plan: NovelAI accepts it and
  an image comes back, with some of the request's options left out for that model. Filling them in is later work (Not
  In This Plan); the slice adds the option only, as upstream did.

## Slice 5. A Lua trigger with no listener for an edit hook is not run for it (_hard_, `server-generation.md`)

Depends: 3 (same files). Upstream `66ab5e5f5`.

Upstream keeps one engine per script, records which edit types `listenEdit` registered, and skips the call into Lua
for a type with no listener. Metatron's engines are one-use: `runLuaEdit` (`server/src/prompt/scripts.ts` ~70) sends
every Lua trigger to a worker for every edit hook, the runtime loads the code (`runChunk`, `server/src/lua/runtime.ts`
~641) and then calls `callListenMain` (~773–782), which returns the value unchanged when the type's list is empty. For
display that is one task per uncached message per Lua trigger (`head` in `server/src/prompt/transform.ts` ~669). The
port here is therefore to skip the task, not the call.

Rough figures, 2026-11-21, this machine, six workers, 64 `editDisplay` tasks at once through the pool, median of seven
runs: a 25-byte script without a listener 0.35 ms per task, a 50 KiB one 0.71 ms, a 200 KiB one 1.77 ms; a listener
adds nothing measurable (0.32 ms and 1.72 ms). The cost is loading the script. Through the transform route
(`node util/playwright/measureTransformLua.mjs`, 200 targets) a one-line `editDisplay` module adds 0.52 ms per target
over the no-Lua chat. So a chat that renders 64 uncached messages pays about 20 to 110 ms per Lua trigger that has no
`editDisplay` listener, more on a smaller server.

1. Measure first (D1). Give `util/playwright/measureTransformLua.mjs` a fixture whose module's Lua registers no
   `editDisplay` listener, with an option for the script's size, and report its warm amortized time per target against
   the no-Lua chat. If a 50 KiB script adds less than 0.3 ms per target there, stop and report `BLOCKED` with the
   table: the owner then chooses between dropping the slice (the ledger row becomes `deferred` with the figures) and
   keeping the attempt as a commit and its revert.
2. The runtime reports what a load registered: `listenEdit` in `LUA_PRELUDE` (~343) notes the type on the run's state
   (`RunState`, ~98), and `LuaRunOutput` (~61) carries the registered edit types of a run whose code loaded. A load
   failure (`failedAt: "load"`) reports none and is never remembered.
3. One process-wide memory of that answer, keyed by a hash of the code and bounded (D5), beside the worker pool every
   job shares (`server/src/scripts/workerPool.ts`). `runLuaEdit` asks it before `setup.runLua`: a code known to
   register no listener for `mode` is skipped and `data` passes on unchanged; an unknown code runs as today and its
   answer is remembered. All four modes (`editRequest`, `editDisplay`, `editInput`, `editOutput`) follow it, as in
   upstream's final state.
4. Why the answer may be reused: the user code's top level runs before the access key exists (`accessKey`, ~652), so
   it cannot call a keyed API or read chat state through one. Confirm that in source for every prelude function that
   takes no key (`log`, `print`, `json`, and whatever else the audit finds), and list in the slice notes anything a top
   level can read that differs between runs. A script whose registration depends on the clock or on `math.random`
   behaves as the first remembered load did; upstream has the same property per engine. Say so in the guide.
5. What changes for a skipped trigger, to keep or state deliberately: its top-level `print` and `log` output no longer
   appears for that hook; it charges no CPU budget; `flushChatMetadata` and `check` inside `runLua` do not run for it
   (the callers' own `setup.check()` stays). A trigger that fails to load is not skipped, so `runLuaEdit` still
   returns the original content for it.
6. Guides: `scripts-triggers.md` (the runtime's report and the reuse rule) and `server-generation.md` (`runLuaEdit`).
7. Record the before and after figures in a new report under `docs/reports/measurements/server/`.

Done: with the listener-less fixture, the warm amortized time per target is within the run-to-run spread of the no-Lua
chat; with the default listener fixture, every target still carries the Lua edit.

- Test:
  - `server/src/tests/scriptWorker.test.ts`: a run reports exactly the edit types its code registered (none, one,
    several); a load failure reports none.
  - `runLuaEdit` through `server/src/tests/transform.test.ts` (display) and `server/src/tests/promptRunner.test.ts`
    (the send hooks), counting pool tasks at the pool boundary: after one run of a listener-less trigger, a second
    target or send starts no task for it and its text is unchanged; a trigger with a listener for another type only
    is skipped for this type and run for its own; a registered listener edits every target; a changed code is asked
    again; a code that failed to load is run again and still resets the text to the original; the memory stays within
    its bound.

## Slice 6. Close the intake (_small_, `build-test-platforms.md`)

Depends: 1–5 (each landed, or dropped by a decision).

- [The ledger](../backlog/upstream-ledger.md): one row per non-merge commit from the Inventory, in
  `git rev-list --reverse --topo-order 4d87a70ff..b5bbc5647` order, with `integrated` and the Metatron commit for each
  ported row. `9067f47a6` is `integrated` by slice 3's commit, and its evidence names `b3e0022a6` for the defect
  itself. A Partial ports entry for slice 5 (the task is skipped, not the call; the answer is remembered per code, not
  per engine) and for slice 4 if the legacy `comfy` block is worth a line. The Merges paragraph for this range. A
  dropped slice 5 becomes a `deferred` row with the figures and the trigger "a report of slow chat rendering with Lua
  modules, or a server with two or fewer cores".
- Baseline table: observed head, inventoried-through and triaged-through move to `b5bbc5647`; "Metatron checked" to the
  commit of this slice; the harness targets stay, with the reason (Baseline above). Correct the Baseline text's
  sentence about the upstream checkout after checking where it sits (`git -C /home/codex/Risuai rev-parse HEAD`). Add
  the range's counts: 27 commits, 10 non-merge and 17 merges, 9 first-parent entries, read from the `kwaroran` remote.
- The Commit ledger's opening sentence and the ledger's first paragraph name this third range and this plan.
- Compatibility version (R1): no change. `version.json` and `appVer` stay at `2026.10.295`; say in the ledger that the
  range holds no release.
- Slice 4 leaves no manual check: the owner ran the medium-model request on 2026-11-21. The options that request
  lacks stay in Not In This Plan until the plan is retired, when they go to
  [deferred work](../backlog/deferred-work.md).
- Do not archive this plan or edit `docs/plan/README.md` here: retiring the plan is the orchestrator's step after
  every slice landed, with the user's yes.

## Inventory

All 10 non-merge commits in `4d87a70ff..b5bbc5647`. "Slice" is a slice of this plan.

| Upstream                                                         | Disposition | Evidence or slice                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `66ab5e5f5` cache Lua edit callback presence                     | gap         | slice 5; D1                                                                                                                                                                                                                                             |
| `a97723687` defer the account sync database snapshot             | excluded    | Metatron has no `src/ts/storage/autoStorage.ts`, `AutoStorage`, `AccountStorage` or `checkAccountSync`; the only `accountst` and `dosync` use left is the boot cleanup of flags the removed Risu Account sync wrote                                     |
| `46311cc28` no full key scan when pruning database backups       | excluded    | No `getDbBackups` and no `dbbackup-` pruning exist: the block save format is unused (`persistence.md`). The server's own snapshots (`server/src/data/snapshots.ts`) list one directory and keep the newest 20                                           |
| `43e084756` skip the IndexedDB backup scan for OPFS storage      | excluded    | Narrows the fast path of `46311cc28`, which has no target; Metatron has no `OpfsStorage`                                                                                                                                                                |
| `603469c44` multi-byte characters across Anthropic stream chunks | equivalent  | `SseLines` (`server/src/llm/sseLines.ts`) decodes with one `TextDecoder` and `{ stream: true }` and flushes at the end; the Anthropic, OpenAI and Google readers share it. `server/src/tests/llmStreamParsing.test.ts` splits a character at every byte |
| `9067f47a6` keep message metadata in Lua `setFullChat`           | gap         | slice 3 for the `chatId` name. The defect itself is fixed: `fullChatMessages` (Metatron `b3e0022a6`), covered by "Lua full-chat updates" in `server/src/tests/luaBindings.test.ts`                                                                      |
| `d897bec3a` optional default value in Lua `alertInput`           | gap         | slice 1                                                                                                                                                                                                                                                 |
| `fc3dcfeab` textarea and JSON upload for the ComfyUI workflow    | gap         | slice 4                                                                                                                                                                                                                                                 |
| `bd02ca878` inlay name in Lua `generateImage`                    | gap         | slice 2                                                                                                                                                                                                                                                 |
| `918d63543` NAI 5 medium effort model                            | gap         | slice 4; D3                                                                                                                                                                                                                                             |

Totals: 5 gap (slices 1–5), 1 equivalent, 3 excluded, and `9067f47a6`, whose defect is covered and whose field name
is slice 3.

## Decisions

The owner accepted the defaults of D1 to D3 on 2026-11-21; the slices are written for them. D4 and D5 are this plan's
own.

- D1. `66ab5e5f5`, the edit hook skip. Options: (a) measure, then port only if it pays; (b) port without measuring;
  (c) defer. Default (a). The rough figures in slice 5 put the saving at 20 to 110 ms per listener-less Lua trigger
  for a 64-message render on the development machine; slice 5's first step repeats the measurement through the
  transform route and stops under its threshold.
- D2. The message id's name in Lua. Options: (a) keep `id` and add `chatId` in the getters and in `setFullChat`;
  (b) keep `id` only; (c) rename to `chatId`. Default (a): scripts written for either side keep working, and no stored
  data changes.
- D3. The `nai-diffusion-2` option. Options: (a) remove it from the list with upstream and keep the request branches
  for a stored value; (b) keep the option. Default (a). Whether NovelAI still serves that model was not checked.
- D4. The length limit of a Lua inlay name. Options: (a) 200 characters, longer is an error string; (b) no limit, as
  upstream; (c) truncate. Default (a): the name is stored in the inlay's record and shown in the Inlay Explorer's
  list, and a script chooses it.
- D5. Where the "registers no listener" answer is remembered. Options: (a) process-wide, by code hash, bounded (256
  entries, least recently used first out); (b) per job only; (c) a text test for `listenEdit` in the code instead of
  a remembered answer. Default (a): it is upstream's lifetime (the engine lives until the code changes), it covers a
  script that listens for one type only, which (c) cannot, and (b) pays the load again on every request.

## Not In This Plan

- Upstream's in-place mutation in `setFullChat`: Metatron's rule is equivalent and its copy is deliberate (slice 3).
- A lookup of inlays by name. Upstream has none either.
- Changes to the legacy `comfy` provider block.
- The request options the NovelAI medium model lacks. The owner's test of 2026-11-21 found the request accepted with
  some options left out, and put the rest off; which options they are is not recorded here and has to be read from a
  request before that work starts.
- A persistent Lua engine per script. Slice 5 skips tasks; it does not change the one-run-per-engine isolation.
- The server snapshot retention (`server/src/data/snapshots.ts`): it never scanned a large key space.
- Updating the upstream checkout the save harness reads, and a new harness target: the range leaves the save format
  alone.

## Open Questions

None open.
