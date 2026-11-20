# Upstream Intake 3 Plan

Status: drafted 2026-11-21 at `6e70b1e51` and committed at `bfdec4e5e`, then audited against the code at that commit
([report](../reports/audits/plan-runner/upstream-intake-3-2026-11-21.md)) and corrected in the same commit as the
report. Landed: 1 (`2d37f0f61`), 2 (`2b678465d`), 3 (`4f563fa1e`), 4 (`5fb726c20`). The audit's two P1 findings removed the edit hook skip (the former slice 5): `66ab5e5f5` is now
`deferred` (D1), which the owner confirmed on 2026-11-21 after reading the audit. The owner accepted the defaults of D2
and D3 the same day; D4 is this plan's own and open to the owner's change. This is the third upstream intake, run by the
[ledger](../backlog/upstream-ledger.md)'s procedure over `4d87a70ff..b5bbc5647`: 10 non-merge commits and 17 merges,
with no upstream release in the range.

Six read-only Luna workers compared the commits with Metatron by group, and the drafting session re-read in source the
claims the slices rest on. The audit then corrected several of them; the slice texts below are the corrected ones.
Line numbers are from those checks; the identifiers are the anchors. Re-verify each cited location before editing
(`STRUCTURE.md` protocol step 5).

Of the ten commits, five are gaps and become the four port slices below (slice 4 takes two commits), one is fully
covered, three touch browser storage Metatron removed, and one is deferred. Slice 5 closes the intake.

One slice is one session, one commit, one file cluster. Each slice names its guide from `STRUCTURE.md` Choose By Task;
that guide's `Invariants` apply. Workflow per slice: `opus-lite` for a slice marked _small_; routine slices name no
Codex challenger. Each slice ends with its tests (under "Test"), `pnpm check`, `pnpm --silent test:agent` for the files
it touches and then once whole, the owning guide's focused checks, `pnpm format:check`, and `pnpm check:docs` for any
guide edit, and updates the owning guide where it changes a documented contract. A guide edit respects the 40,000-byte
ceiling. Code comments and test titles describe behavior, not this plan (`STRUCTURE.md` T5).

Upstream rules for every slice, unchanged from the earlier intakes:

- Port behavior, not code. Read the final upstream state of a series (`git show kwaroran/main:<path>`), not only its
  first commit.
- Commit with a conventional title and one `Upstream-Commit: <full sha>` trailer per upstream commit ported.
- Never copy upstream `package.json`, lockfiles, or version numbers.
- A new regression test fails without the change (V6). Mock I/O and process boundaries, not the code under test.

## Baseline

| Reference              | Value                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Upstream head          | `b5bbc5647974a883ae098410388ca4201df01fa3`, committed 2026-11-20, observed 2026-11-21 as `kwaroran/main` |
| Inventoried through    | `4d87a70ffb325db84dd35cb1b76b31d7074da156` before this plan; the new head after slice 5                  |
| Metatron head checked  | `6e70b1e5193017342517061a6575ed6ccd996c01`, `dev`; audited at `bfdec4e5e`                                |
| Compatibility version  | `2026.10.295`, unchanged: the range holds no upstream version bump (R1)                                  |
| Harness current target | `f50b5942`, kept: no commit in the range changes the save format                                         |

The range was read from this repository's `kwaroran` remote (`git fetch --no-tags kwaroran main`). `4d87a70ff` is an
ancestor of the new head, so no history was rewritten. The upstream checkout the ledger names now sits at `4d87a70ff`
with a clean tree, not at `f50b5942` as the ledger's Baseline text says; slice 5 corrects that sentence. Upstream paths
below are paths in upstream's tree; read one with `git show kwaroran/main:<path>` and a commit with `git show <sha>`.

Merges: 16 of the 17 match Git's automatic merge (`git show --remerge-diff` prints nothing). `72baef272` resolves two
conflicts and adds no behavior: it keeps both test groups in upstream's `src/ts/process/scriptings.test.ts` and joins
two import lines in `src/ts/process/scriptings.ts`. No merge needs a row.

Save format: the range changes upstream's `src/ts/storage/` only in `autoStorage.ts` (the account sync check) and its
test, so the harness targets stay.

## Order

- Lua, serial: 1 → 2 → 3. Slices 1 and 2 share the prelude in `server/src/lua/runtime.ts`; all three share
  `server/src/lua/bindings.ts` and `server/src/tests/luaBindings.test.ts`.
- Client: 4 shares no file with the Lua chain and can run beside it.
- Close-out: 5 after every other slice landed or was dropped by a decision.

With two slots, the Lua chain takes one and slice 4 the other. The `chatId` name (slice 3) is the change scripts
written for upstream need most, and it is reached only through 1 and 2.

## Slice 1. Lua `alertInput` takes a default value (_small_, `scripts-triggers.md`)

Upstream `d897bec3a`.

- `server/src/lua/runtime.ts` `LUA_PRELUDE`: `alertInput(id, value)` (~291) forwards two arguments. Add an optional
  third, `defaultValue`. After the `__safeKey` check, forward it to `alertInputMain` only when
  `type(defaultValue) == "string"`; otherwise make today's two-argument call. The test must be in Lua: a table or a
  function passed to a host function fails the worker's primitive-argument check (`checkHostArgs`, ~458) before the
  binding could ignore it.
- `server/src/lua/bindings.ts` `alertInputMain` (~1754) asks with `payload: { message }` only. Add `defaultValue` when
  the third argument is a string; keep the binding's own check, since it is the trust boundary. The question type
  already carries the field (`GenerationQuestion` in `shared/jobs.ts` ~531), the server passes a question's payload on
  whole, and the tab already hands it to the dialog (`ask` in `src/ts/network/jobChannel.ts` ~499), so none of those
  changes.
- Keep the key guard (`__safeKey`, `isSafe`) and the answer conversion as they are.
- Test, `server/src/tests/luaBindings.test.ts` beside the `alertInput` cases (~1235): a script that passes a string as
  the third argument produces a question whose payload holds that `defaultValue`; the two-argument form's payload has
  no such field; a table as the third argument is ignored and the question is asked without a default.

## Slice 2. Lua `generateImage` names its inlay (_small_, `media-aux.md`)

Depends: 1 (same files). Upstream `bd02ca878`.

- `server/src/lua/runtime.ts` `LUA_PRELUDE`: `generateImage` (~271) encodes `{ orientation = options.orientation }`
  only. Put `name` into that table only when `type(options.name) == "string"`: any other value would fail in the Lua
  JSON encoder or mean nothing.
- `server/src/lua/bindings.ts` `generateImageMain` (~1803): keep the low-level guard first and the `orientation` check
  second, as today. Then read `name`: a non-empty string of at most 200 characters is forwarded (D4); an empty or
  non-string `name` means no name, as upstream; a longer one is answered with an error string without asking the tab,
  as an invalid `orientation` is. A name so long that the call exceeds the host-argument cap (`MAX_HOST_ARG_CHARS`,
  `server/src/lua/runtime.ts`) fails as any oversized argument does today; D4 covers the names that reach the binding.
- `generateImageInlay` (declared ~232, defined ~962) builds the callback payload field by field, so add `name` to its
  options type in both places and put it on the payload there. Its other callers (`server/src/prompt/runner.ts` ~2232,
  `server/src/prompt/triggers.ts` ~995) pass no name and do not change.
- `shared/jobs.ts`: the `generateImage` callback payload (~796) gains `name?: string`.
- `src/ts/network/jobChannel.ts` `generateImage` case (~938–968) ends with
  `writeInlayImage(image, { check: stillWanted })`. The tab reads the payload as unknown data: pass `name` only when
  it is a non-empty string within the same limit. `writeInlayImage` (`src/ts/process/files/inlays.ts` ~399) already
  stores `arg.name ?? imgid` as the inlay's name, and the Inlay Explorer renders that name as text.
- The name labels the inlay; it does not choose its id or its file name, and no lookup by name exists. Do not add one.
  One known effect, accepted: asset cleanup reads every string in an inlay's record (`walkJson`,
  `server/src/data/assetLifecycle.ts`), so a name that spells an asset or inlay reference keeps that asset from being
  collected, another character's in the same store included, and delays its reclamation. It cannot select anything
  for deletion, and names of imported files already have the same property.
- `media-aux.md`, Inlay images: the Lua binding and the tab forward `orientation` and `name`.
- Test:
  - `server/src/tests/luaBindings.test.ts` beside the `generateImage` cases: a name reaches the callback payload; an
    empty name, a table as the name and a missing name leave the payload without one; a 201-character name returns
    the error string and the callback is not asked; an invalid `orientation` is still reported before the name.
  - `src/ts/network/jobChannel.test.ts` beside the `generateImage` callback case (~1735): a payload name reaches
    `writeInlayImage`; a payload without one, or with an invalid one, writes with no name.

## Slice 3. Lua chat getters also give `chatId`, and `setFullChat` accepts it (_small_, `scripts-triggers.md`)

Depends: 2 (same files). Upstream `9067f47a6`.

Metatron fixed the defect itself in `b3e0022a6`: `fullChatMessages` keeps the stored message an item names and lays
role and text over it, and a table a getter returned keeps its `id`, so a get, edit, set round trip already works.
What is left is the field's name. Metatron's getters give the message id as `id`; upstream's now give it as `chatId`
and match on it. A script written for upstream that reads `chatId` gets nil here, and one that builds its items anew,
carrying `chatId` only, loses the match: with a changed text the positional fallback does not apply, and the message
is replaced by a new one without its translation, candidates and generation info.

- `server/src/lua/bindings.ts` `project` (~732): give `chatId` beside `id`, both the message's `chatId`. `getChat`,
  `getRecentChats` and `getFullChat` all use it.
- `fullChatMessages` (~734): for each item, try an unused stored message by `id`, then by `chatId`, then today's
  positional rule. A usable `id` wins when the two disagree. The rest of the rule (one stored message per item, a new
  message with a fresh id otherwise, removal of what the list leaves out) is unchanged, in the live chat and in a
  trigger's working copy. No migration runs. The getters expose both names, which every script can see. On later
  writes each item tries an unused `id`, an unused `chatId`, then position, and because a stored message serves one
  item only, an earlier item's `chatId` match can take the message a later item names.
- Do not copy upstream's in-place mutation: Metatron's message objects may be shared with the stored copy
  (`replaceCopyMessage`'s comment), and the spread in `fullChatMessages` is deliberate.
- `scripts-triggers.md` Invariants, the "Lua's chat getters" line: both names and the matching order.
- Test, `server/src/tests/luaBindings.test.ts`: the two exact getter expectations (~1269, ~1275) gain `chatId`; in
  "Lua full-chat updates" (~1595), an item built anew with only `chatId` and a changed text keeps the stored message's
  translation, candidates and generation info, in the live path and the working-copy path; an item whose `id` and
  `chatId` name different messages follows `id`; an item with neither still follows the positional rule.

## Slice 4. Image settings: the ComfyUI workflow field and the NovelAI model list (_small_, `settings-i18n.md`)

Upstream `fc3dcfeab`, `918d63543`.

- `src/lib/Setting/Pages/ImageGenerationSettings.svelte`, the `sdProvider === "comfyui"` block (~798–808): the
  workflow is a single-line `TextInput` under a literal `Workflow` label. Make it a `TextAreaInput`
  (`src/lib/UI/GUI/TextAreaInput.svelte`; it takes a bindable `value`, `size="sm"`, `fullwidth`, `height="32"`,
  `margin="bottom"` and `ariaLabel`) labelled `language.comfyWorkflow`, with the existing
  `<Help key="comfyWorkflow" />`, and add an upload button under it with an accessible name. The handler:
  `selectSingleFile(["json"])` (already imported by the page) returns `null` on cancel, so return then without an
  alert or a write; otherwise decode `file.data` as UTF-8, validate with `JSON.parse`, and on a parse failure show
  `alertError(language.comfyWorkflowInvalidJson)` and change nothing; on success store the decoded text as it is in
  `comfyConfig.workflow`. The field saves through the page's existing section view, as its other fields do.
- The legacy `sdProvider === "comfy"` block (~820–835) is not in upstream's change either and stays.
- `src/lang/en.ts`: top-level `comfyWorkflow: "Workflow (API)"` and
  `comfyWorkflowInvalidJson: "Invalid workflow file. It must be a valid JSON."`. `src/lang/ko.ts`: `"워크플로 (API)"`
  and upstream's Korean sentence. The nested `help.comfyWorkflow` entries stay: the English one already matches
  upstream, and the Korean one keeps this fork's own wording instead of upstream's reworded help.
- The NovelAI model select (~342–352): add `nai-diffusion-5-full-medium` after `nai-diffusion-5-full` and remove the
  `nai-diffusion-2` option (D3). Nothing else moves: `NAIImgModel` is a plain string with no allow-list
  (`shared/database.ts`, `server/src/data/normalize/memoryTranslateMedia.ts`), a stored value that matches no option
  is left alone when the page opens, `src/ts/process/stableDiff.ts` sends the stored name as it is and has no version
  5 branch, and its two `nai-diffusion-2` conditions (~265, ~278) and the page's SMEA and Decrisp conditions (~658,
  ~670) stay for a stored value, as in upstream.
- Test, `src/lib/Setting/Pages/ImageGenerationSettings.test.ts`: the model select offers the medium model and not
  version 2; a stored `nai-diffusion-2` is not rewritten by opening the page; uploading a valid JSON file fills the
  workflow field with the file's text; an invalid file raises the alert and leaves the field; a cancelled picker
  raises no alert and leaves the field.
- The owner reported a successful NovelAI request with the medium model on 2026-11-21, outside this plan, with some
  of the request's options left out for that model. Which options was not recorded. Filling them in is later work
  (Not In This Plan); the slice changes the selector only, as upstream did.

## Slice 5. Close the intake (_small_, `build-test-platforms.md`)

Depends: 1–4 (each landed, or dropped by a decision).

- [The ledger](../backlog/upstream-ledger.md): one row per non-merge commit from the Inventory, in
  `git rev-list --reverse --topo-order 4d87a70ff..b5bbc5647` order, with `integrated` and the Metatron commit for each
  ported row. `9067f47a6` is `integrated` by slice 3's commit, and its evidence names `b3e0022a6` for the defect
  itself. `66ab5e5f5` is `deferred` with the reason and the revisit trigger from the Inventory. Partial ports entries
  only for what landed: slice 2 (D4's 200-character limit and its error before generation, where upstream accepts any
  non-empty name), slice 3 (Metatron's own matching rule, with `chatId` as a second name) and slice 4 (the Korean
  help keeps the fork's wording). The Merges paragraph for this range.
- Baseline table: observed head, inventoried-through and triaged-through move to `b5bbc5647`; "Metatron checked" is
  the verified `HEAD` right before this slice's own commit, after every accepted port landed (a commit cannot name
  itself); the harness targets stay, with the reason (Baseline above). Correct the Baseline text's sentence about the
  upstream checkout after checking where it sits (`git -C /home/codex/Risuai rev-parse HEAD`). Add the range's counts:
  27 commits, 10 non-merge and 17 merges, 9 first-parent entries, read from the `kwaroran` remote.
- The Commit ledger's opening sentence and the ledger's first paragraph name this third range and this plan.
- Compatibility version (R1): no change. `version.json` and `appVer` stay at `2026.10.295`; say in the ledger that the
  range holds no release.
- Slice 4 leaves no manual check. The options the medium-model request lacks, and the deferred edit hook skip, stay
  in this plan until it is retired, when they go to [deferred work](../backlog/deferred-work.md).
- Do not archive this plan or edit `docs/plan/README.md` here: retiring the plan is the orchestrator's step after
  every slice landed, with the user's yes.

## Inventory

All 10 non-merge commits in `4d87a70ff..b5bbc5647`. "Slice" is a slice of this plan.

| Upstream                                                         | Disposition | Evidence or slice                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `66ab5e5f5` cache Lua edit callback presence                     | deferred    | D1. Upstream skips the call into a live engine whose script registered no listener. Metatron loads the script in a one-use engine for every hook, so the saving would come from skipping the load, and one load does not show that another may be skipped. Revisit on a report of slow chat rendering with Lua modules, with a design that meets the conditions in D1 |
| `a97723687` defer the account sync database snapshot             | excluded    | Metatron has no `src/ts/storage/autoStorage.ts`, `AutoStorage`, `AccountStorage` or `checkAccountSync`; the only `accountst` and `dosync` use left is the boot cleanup of flags the removed Risu Account sync wrote                                                                                                                                                   |
| `46311cc28` no full key scan when pruning database backups       | excluded    | Metatron has no live `dbbackup-` key pruning and no `getDbBackups`; it only decodes block backups on import. The server's own snapshots (`server/src/data/snapshots.ts`) list one directory and keep, by default, the newest 20 unpinned files plus the protected ones                                                                                                |
| `43e084756` skip the IndexedDB backup scan for OPFS storage      | excluded    | Narrows the fast path of `46311cc28`, which has no target; Metatron has no `OpfsStorage`                                                                                                                                                                                                                                                                              |
| `603469c44` multi-byte characters across Anthropic stream chunks | equivalent  | `SseLines` (`server/src/llm/sseLines.ts`) decodes with one `TextDecoder` and `{ stream: true }` and flushes at the end; the Anthropic, OpenAI and Google readers share it. `server/src/tests/llmStreamParsing.test.ts` splits a character at every byte                                                                                                               |
| `9067f47a6` keep message metadata in Lua `setFullChat`           | gap         | slice 3 for the `chatId` name. The defect itself is fixed: `fullChatMessages` (Metatron `b3e0022a6`), covered by "Lua full-chat updates" in `server/src/tests/luaBindings.test.ts`                                                                                                                                                                                    |
| `d897bec3a` optional default value in Lua `alertInput`           | gap         | slice 1                                                                                                                                                                                                                                                                                                                                                               |
| `fc3dcfeab` textarea and JSON upload for the ComfyUI workflow    | gap         | slice 4                                                                                                                                                                                                                                                                                                                                                               |
| `bd02ca878` inlay name in Lua `generateImage`                    | gap         | slice 2                                                                                                                                                                                                                                                                                                                                                               |
| `918d63543` NAI 5 medium effort model                            | gap         | slice 4; D3                                                                                                                                                                                                                                                                                                                                                           |

Totals: 5 gap (slices 1–4; `9067f47a6` is the one whose defect is already covered), 1 equivalent, 3 excluded,
1 deferred.

## Decisions

The owner accepted the defaults of D1 to D3 on 2026-11-21. D1's outcome below comes from the audit, and the owner
confirmed it the same day; D4 is this plan's own.

- D1. `66ab5e5f5`, the edit hook skip. Options: (a) measure, then port only if it pays; (b) port without measuring;
  (c) defer. The owner chose (a). The draft planned to remember, per script code, that a load registered no listener
  for a hook, and to skip the worker task from then on. The audit showed that cannot work as written, so the outcome
  is (c):
  - The script's top level runs with the host functions already installed, and many need no access key: `getChatVar`,
    `getGlobalVar`, the chat getters, `getName`, `getPersonaName`, `getLoreBooks`, `cbs` and more
    (`server/src/lua/bindings.ts`). The same code can register a listener in one chat and none in another, or change
    within one job, so a remembered "no listener" is wrong for the next run.
  - `callListenMain` is a writable global that dispatch looks up after the script loaded
    (`server/src/lua/runtime.ts`). A script can edit text through its own dispatcher without calling `listenEdit`.
  - For `editRequest`, returning the list untouched is not the same result: today the list comes back as new objects,
    and returning the original entries instead can change `attributionExact` (`server/src/prompt/assemble.ts`) even
    when the text is identical.

  A later design has to decide from something other than one load's registrations, keep a script's own dispatcher
  working, keep `editRequest`'s result identical between a run and a skip, and account for what a top level can do
  by itself (an image getter can ask the tab to create an inlay). The drafting session's rough timings, recorded
  nowhere else: 64 `editDisplay` tasks at once through the pool on the development machine (six workers, median of
  seven runs) took 0.35 ms per task for a 25-byte script without a listener, 0.71 ms for a 50 KiB one and 1.77 ms for
  a 200 KiB one, and 0.32 ms and 1.72 ms for the 25-byte and 200 KiB scripts with a listener. Separately, through the
  transform route (`node util/playwright/measureTransformLua.mjs`), a chat with a one-line `editDisplay` module took
  0.52 ms per target more than a chat with no module. Neither measurement isolates the saving from skipping a load.

- D2. The message id's name in Lua. Options: (a) keep `id` and add `chatId` in the getters and in `setFullChat`;
  (b) keep `id` only; (c) rename to `chatId`. Default (a): scripts written for either side keep working, and no
  migration runs. Slice 3 states what changes for later writes.
- D3. The `nai-diffusion-2` option. Options: (a) remove it from the list with upstream and keep the request branches
  for a stored value; (b) keep the option. Default (a). Whether NovelAI still serves that model was not checked.
- D4. The length limit of a Lua inlay name. Options: (a) 200 characters, longer is an error string; (b) no limit, as
  upstream; (c) truncate. Default (a): the name is stored in the inlay's record and shown in the Inlay Explorer's
  list, and a script chooses it.

## Not In This Plan

- The edit hook skip of `66ab5e5f5` (D1), and upstream's reuse of the current engine per mode while that mode's
  source stays the same.
- Upstream's in-place mutation in `setFullChat`. Metatron keeps its own rule, which differs in details (a positional
  fallback, a copy instead of a mutation); slice 3 adds only the second name.
- A lookup of inlays by name. Upstream has none either.
- Changes to the legacy `comfy` provider block, and upstream's reworded Korean help for the workflow field.
- The request options the NovelAI medium model lacks. The owner's test of 2026-11-21 found the request accepted with
  some options left out, and put the rest off; which options they are is not recorded here and has to be read from a
  request before that work starts.
- The server snapshot retention (`server/src/data/snapshots.ts`): it never scanned a large key space.
- Updating the upstream checkout the save harness reads, and a new harness target: the range leaves the save format
  alone.

## Open Questions

None open. D1 was open after the audit: the owner had chosen "measure, then port only if it pays", and the audit found
the planned port unsound whatever the measurement says. The owner confirmed the deferral on 2026-11-21.
