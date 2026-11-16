# Sidebar-Only Chat Binding Plan audit, 2026-11-17

- Plan: `docs/plan/sidebar-only-binding.md`
- Commit audited: `93d8dc37c` (`dev`), the commit that added the plan; its code is that of `c788b2fc3`. The corrected
  plan is committed with this report
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the session that drafted the plan (Claude Fable 5.2),
  before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 0     |
| P2         | 3     |
| P3         | 1     |
| unverified | 1     |

All five findings are closed: A1, A3, and A4 are `fixed in plan` as the auditor suggested, A2 is `fixed in plan` by
narrowing the plan (D10), and A5 is settled without a plan change. The first turn filed A1 to A5. The second turn read
the drafted corrections, confirmed A1, A3, A4, and A5, and disputed A2 in part: the narrowing removes the mixed-scope
problem, but an invalidation gap that exists today stays, and D10's reason was too narrow. Both points are in the plan.

Sol changed no file in the repository and ran no test or type check: the audit is a reading of the code. During the
first turn the read-only check reported a changed git state with no changed path; it was a merge of
`claude/api-idle-status-code-2f2e19` into `dev` made by mistake and taken out again before this report was committed; it touched none of the files this plan names. The two
turns took about 17 minutes and 8.9 M tokens.

The re-check list does not apply: the plan changes client views and pickers, not jobs, the feed, or the resource store.

Found consistent: `pickBinding`'s three targets and the one-field patch (`src/ts/storage/chatBindingPick.ts:19`,
`src/ts/storage/chatBinding.svelte.ts:122`); the active views reading an existing bound record first and the tab's
selection after it (`src/ts/storage/settingsViews.svelte.ts:176`, `:233`, `:261`), the first-record repair of a stale
selection (`:181`, `:238`, `:266`), and the write resolvers without it (`:284`, `:291`, `:299`); the registry context
and root bindings (`src/ts/setting/utils.ts:62`, `:82`, `:105`) and the search index's profile
(`src/ts/setting/searchIndex.ts:380`); the picker props, the stores, and the two mounts of the binding panel
(`src/lib/Setting/botpreset.svelte:60`, `src/lib/Setting/listedPersona.svelte:16`, `src/ts/stores.svelte.ts:65`,
`src/App.svelte:335`, `src/lib/SideBars/OpenChatPanel.svelte:52`, `src/lib/Others/ChatBindingDialog.svelte:57`);
Ctrl+1..9, its numbering, its three guards, and its toast (`src/ts/hotkey.ts:342`, `:602`); the seventeen test files
that replace the views module; every product caller of `pickBinding` and `changeUserPersona` (six sites, all covered
by slice 2), with no hidden open-chat default in drag and drop, the share receivers, `addPreset`, first boot, or the
playground (`src/ts/characterCards.ts:204`, `:864`, `src/ts/storage/collectionStore.svelte.ts:476`,
`src/ts/bootstrap.ts:298`, `src/lib/Playground/PlaygroundMenu.svelte:25`); a chat staying bindable after slice 2
through the setup dialog the composer opens (`src/lib/ChatScreens/DefaultChatScreen.svelte:739`, `:1743`); no path by
which the tab's selection replaces a complete binding in a request, a transport, a translation, an AI Access call, or
a plugin hook (`src/ts/process/request/request.ts:235`, `:675`, `src/ts/process/request/transport.ts:159`,
`src/ts/translator/translator.ts:954`, `src/ts/process/mcp/aiaccess.ts:40`,
`src/ts/plugins/apiV3/pluginContext.ts:67`); no send, job, parser, or plugin caller of the actions and components
slice 1 moves (`downloadPreset`, `selectUserImg`, `exportUserPersona`, `applyPresetTemplate`, `settingContext`,
`PromptDataItem.svelte`); `getModelInfoForMode` agreeing with and without a scope for the same records, an empty model
preset list included (`src/ts/storage/settingsViews.svelte.ts:225`, `src/ts/model/modellist.ts:213`); the header
note's inputs and `pickBinding(field, id, null)` selecting for the tab for each field
(`src/lib/Setting/BindingScopeNote.svelte:13`, `chatBindingPick.ts:31`); D8's three pages; and the file lists.

## P2

### A1 — Slice 1: the Prompt page's model-dependent controls were left on the unscoped call — fixed in plan

- Plan (Slice 1, "The pages and lists"): "`ModelSettings` and `ProviderDefaultKeys` pass `editedScope()` to
  `getModelInfoForMode`."
- Code: `PromptPresetSettings.svelte` derives the main and sub model info with unscoped calls
  (`src/lib/Setting/Pages/PromptPresetSettings.svelte:71`), passes them to the registry renderer (`:146`), and picks
  its provider-specific controls by them (`:147`, `:233`). The renderer's own default cannot correct a page that
  supplies the model info. With the chat bound to model preset X and the tab selecting Y, the page would have shown
  X's controls.
- Correction, confirmed: "`PromptPresetSettings`, `ModelSettings`, and `ProviderDefaultKeys` pass `editedScope()` to
  every `getModelInfoForMode` call."

### A2 — Slice 1: a scope on the last count call does not move the count pipeline — fixed in plan (narrowed)

- Plan (Slice 1): "**Token counts on the Prompt pages** use the edited pair: `PromptPresetSettings` passes
  `editedScope()` to `countTokens`, and `tokenizePreset` gains an optional `scope?: PresetScope` that `PromptSettings`
  passes and its other callers leave out."
- Code: the count input is prepared by `tokenCountInput`, which expands CBS and reads the tokenizer identity unscoped
  (`src/ts/tokenizer.ts:281`); `PromptSettings` builds its own invalidation key from the unscoped `tokenScopeKey()`
  (`src/lib/Setting/Pages/PromptSettings.svelte:68`); `tokenizePreset` counts through `tokenizeAccurate`, which takes
  no scope (`src/ts/process/prompt.ts:49`, `tokenizer.ts:290`); the count runs untracked and an unchanged input is not
  recounted (`src/ts/tokenCountField.ts:64`, `:51`). A scope read inside the delayed count is no reactive dependency,
  so a change of the tab's model preset with unchanged text would have left the old count. The popup editor's preview
  and counter read the active family too, and `popupEditorContext` only guards the write-back
  (`src/lib/UI/GUI/TextAreaInput.svelte:107`, `src/lib/Others/PopupEditor.svelte:30`, `:47`, `:60`).
- Correction: the plan no longer moves the counts. Slice 1's bullet "Counts and previews stay the running chat's" and
  D10 keep the expansion, the invalidation key, the count, and the popup editor on the active family; only the text
  comes from the edited family. `src/ts/process/prompt.ts` left slice 1's file list.
- Second turn, disputed in part: the mixed-scope problem is gone and `PromptPresetSettings` is sound, but
  `PromptSettings` keeps a gap it has today (its input holds the template items and the tokenizer identity; an
  unchanged template is not recounted when a variable default it reads changes, `src/ts/parser/chatVar.svelte.ts:24`),
  and D10's reason left out the persona (`shared/cbs/registry.ts:173`, `:307`). The gap is under Not In This Plan as
  today's behavior, and D10 names the three records. The write-back guard holds once its context ids are the edited
  records' (`TextAreaInput.svelte:110`, `:328`).
- For the owner: this is a narrowing of the draft, not the auditor's suggested correction (thread the edited records
  through the expansion, the key, and the count). D10 is open to the owner's change.

### A3 — Slice 2: the route table cannot be rebuilt by handing the builder other views — fixed in plan

- Plan (Slice 2): "`readEditedRoot` and `writeEditedRoot` use a second route table built by the same builder with the
  edited views."
- Code: `buildRootRoutes` takes no parameters (`src/ts/storage/settingsViews.svelte.ts:909`); its preset and persona
  routes close over `activePreset` and `activePersona` (`:920`, `:939`); its model routes use `seperateModelsView()`,
  `readModelRoot`, and `writeModelRoot` (`:925`), which default to the active resolvers (`:385`, `:409`, `:510`);
  `routeOf` reads the one table (`:976`); `buildActivePersona` hard-codes its resolvers (`:814`); `profileForSlot`'s
  write getter defaults to its read getter (`:765`). Replacing the view objects alone would have left the model and
  auxiliary roots on the chat's model preset.
- Correction, confirmed: slice 2's bullet "The edited route table": the builder takes the family it serves, the model
  root helpers take a read resolver and a no-fallback write resolver called on every access, the write resolver is
  forwarded through the whole-`seperateModels` call and the auxiliary setters (`:422`, `:513`), `routeOf` takes the
  table, the persona view builder takes its resolvers, and the edited profile views pass a write getter. The callers
  with a captured scope keep their behavior (`:594`, `:608`, `:1001`). `scopedPresetRecord`, `forwardedPresetField`,
  and the `selectedId` routes need nothing (`:538`, `:377`, `:941`).

## P3

### A4 — Order: the shared files were understated — fixed in plan

- Plan (Order): "Both edit `src/ts/storage/settingsViews.svelte.ts` and `docs/structure/settings-i18n.md`."
- Code: the two file lists also share `src/ts/persona.ts`, `src/lib/Setting/botpreset.svelte`,
  `src/lib/Setting/listedPersona.svelte`, and `src/lib/Setting/Pages/PersonaSettings.svelte`. The slices are
  sequential, so nothing runs in parallel on them.
- Correction, confirmed: the sentence lists all six paths.

## Unverified

### A5 — Rules: the workflow names are not defined in the repository — settled, no plan change

- Plan (Rules For Every Slice): "Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_
  slice."
- The names are workflows of the plan-runner skill, outside the repository, as in the plans under
  `docs/archived-plan/`. The auditor confirmed the reading in the second turn.

## Wording corrected with the findings

- Current State: "Every picker outside the panel passes `undefined`" became "Outside the panel, a pick targets the open
  chat"; the persona the Persona page creates passes `currentChatRef()` explicitly
  (`src/lib/Setting/Pages/PersonaSettings.svelte:155`, `:166`).
- Slice 1, parity: narrowed to `getModelInfoForMode`, with the note that `editedScope()` reads both ids, so a call that
  read only the model preset also tracks the prompt selection and can repair a stale one
  (`src/ts/storage/settingsViews.svelte.ts:190`).
- Slice 1, what stays: the settings report (`src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:43`,
  `src/ts/storage/snapshots.svelte.ts:149`) is a diagnostic of the running settings.
- Slice 2, tests: only `hotkey.test.ts` pins the old hotkey rule (`src/ts/hotkey.test.ts:461`);
  `e2e/personaBinding.spec.ts` has a helper that omits the target (`:49`) and an icon case that expects the chat's
  persona (`:132`); `e2e/presetSelection.spec.ts` runs at home and needs no change.
- Slice 2, header note: the component derives the shown id from the edited view of its field.

## Noted, not changed

- `ModelList.svelte` and `credentialsAccepted` read the active custom flags through an unscoped `getModelInfo`
  (`src/lib/UI/ModelList.svelte:188`, `src/ts/model/credentials.ts:79`); the name and the credential slot they show do
  not depend on those flags (`src/ts/model/modellist.ts:195`, `shared/llm/credentialSlots.ts:58`).
- "A chat is open" for the header note and the views means `currentChatRef()`, which also names the selected chat of a
  character on its closed-chat screen (`src/ts/storage/chatStore.svelte.ts:1410`); existing tests keep that
  (`src/ts/storage/tests/chatBindingViews.test.ts:389`).
- An unbound or partly bound chat that a settings pick would have completed stays incomplete until its binding panel is
  used. That is D1.
