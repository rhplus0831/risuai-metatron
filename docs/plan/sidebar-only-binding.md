# Sidebar-Only Chat Binding Plan

Status: drafted 2026-11-17 at `c788b2fc3` from the owner's report of the same day (a prompt preset picked in the
settings while a chat was open changed that chat's prompt preset, which the owner did not expect). Committed at `93d8dc37c`, then audited against the code at that commit
([report](../reports/audits/plan-runner/sidebar-only-binding-2026-11-17.md)) and corrected in the same commit as the
report. D1 and D2 are the owner's choices of 2026-11-17; D3 on are this plan's own and open to the owner's change. The
route table's resolvers (slice 2) and the counts and previews that stay the running chat's (D10) took their present
form from the audit. Landed: 1 (`babe551cc`).

Sources: `pickBinding` in `src/ts/storage/chatBindingPick.ts`; `chatDisplayIds`, `chatBindingPatch`, and `pickedId` in
`src/ts/storage/chatBinding.svelte.ts`; `resolvePreset`, `resolveTabPreset`, `resolveModelPreset`, `resolvePersona`,
`presetRecordForWrite`, `buildPresetView`, `profileForSlot`, `buildActivePersona`, `buildRootRoutes`,
`readSettingsRoot`, `writeSettingsRoot`, `scopedPresetRoot`, `resolveModelSlot`, `tabSelectionIds`, and
`setOpenChatBindingSource` in `src/ts/storage/settingsViews.svelte.ts`; `selectPreset`, `selectModelPreset`, and
`selectPersona` in `src/ts/storage/selection.svelte.ts`; `settingContext`, `getSettingValue`, and `setSettingValue` in
`src/ts/setting/utils.ts`; `src/ts/setting/searchIndex.ts`; `getModelInfo` and `getModelInfoForMode` in
`src/ts/model/modellist.ts`; `tokenCountInput`, `tokenScopeKey`, and `countTokens` in `src/ts/tokenizer.ts`;
`tokenizePreset` in `src/ts/process/prompt.ts`; `src/lib/Others/PopupEditor.svelte`; `changeToPreset` and the `presets`, `persona`, and `modelSelect` hotkeys in
`src/ts/hotkey.ts`; `changeUserPersona`, `selectUserImg`, and `exportUserPersona` in `src/ts/persona.ts`;
`downloadPreset` in `src/ts/storage/presets.svelte.ts`; `src/lib/Setting/botpreset.svelte`,
`src/lib/Setting/listedPersona.svelte`, `src/lib/Setting/BindingScopeNote.svelte`, and the pages under
`src/lib/Setting/Pages/`; `src/lib/SideBars/ChatBindingPanel.svelte`; `PickerListState` in `src/ts/stores.svelte.ts`;
`language.chatBinding` in `src/lang/en.ts`. The identifiers are the anchors. Re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

## Goal

A chat's model preset, prompt preset, and persona change in one place: the binding panel of that chat. The settings
screen stops being a second way to change them.

- **Only the binding panel binds (D1).** The panel is the three rows of `ChatBindingPanel.svelte`, mounted in the
  sidebar's open-chat tab and in the Chat Settings dialog. A row opens its picker for that chat, and that pick is the
  only pick that changes a chat's binding.
- **The settings screen edits the tab's selection (D2).** With or without a chat open, the Prompt, Model, and Persona
  pages show and edit the record the tab selects. A pick made from the settings, from a list a hotkey opened, or with
  Ctrl+1..9 changes the tab's selection and nothing of any chat.
- **The chat keeps running with its binding.** A send, a render, the sidebar's toggles, and every plugin hook read the
  open chat's bound records as today.
- **The settings say when they show something else.** While a chat is open, each page's header says whether the shown
  record is the one the chat uses, and offers to show the chat's.

Not goals: changing what a chat is sent with, the display rule for an unset field, how a new, copied, or imported chat
gets its binding, or the selection's storage.

## Current State

- **A pick binds the open chat.** `pickBinding(field, id, target?)` binds `target` when it is a `ChatRef`, selects for
  the tab when it is `null`, and for `undefined` binds `currentChatRef()` when a chat is open, else selects for the tab.
  A chat's pick writes that field only (`chatBindingPatch`).
- **Outside the panel, a pick targets the open chat.** `botpreset.svelte` calls `pickBinding(field, id, chatRef)` with
  its optional `chatRef` prop, and `listedPersona.svelte` calls `changeUserPersona(persona.id, chatRef)`. `App.svelte`
  passes the prop only when the store holds `{ chatRef }`, which only `ChatBindingPanel.svelte` `openPicker` sets. The
  lists the settings open (`PromptPresetSettings.svelte` and `ModelSettings.svelte` set the store to `true`) and the
  lists the `presets`, `persona`, and `modelSelect` hotkeys and `quickMenu` open get no prop. `PersonaSettings.svelte`
  calls `changeUserPersona(persona.id)` on a grid click and `changeUserPersona(id, currentChatRef())` for a persona it
  creates. `changeToPreset` in `hotkey.ts` (Ctrl+1..9) calls `pickBinding("promptPresetId", id)`.
- **The settings follow the open chat.** `activePreset`, `activeModelPreset`, `activeMainProfile`, `activeSubProfile`,
  and `activePersona` resolve, per field, the open chat's bound record when it exists, else the tab's selected record
  (`resolvePreset`, `resolveModelPreset`, `resolvePersona` over `openChatBinding()`). Writes go to the same record
  without the first-record fallback (`presetRecordForWrite`, `modelPresetRecordForWrite`, `personaRecordForWrite`). The
  root router (`readSettingsRoot`, `writeSettingsRoot`) serves preset, model, and persona roots through these views.
- **One family serves both the settings and the chat.** The settings read it in `src/ts/setting/utils.ts` (the registry
  context and every `bindKey` and `bindPath`), `src/ts/setting/searchIndex.ts`, and the pages. The chat side reads it
  where no pair was captured: `request.ts`, `transport.ts`, `translator.ts`, `stringlize.ts`, `chatVar.svelte.ts`,
  `modules.ts`, `hypav3.ts`, `inlays.ts`, `tokenizer.ts`, `chatTemplate.ts`, `modellist.ts`, `util.ts`,
  `stores.svelte.ts`, `aiaccess.ts`, the plugin API (`v3.svelte.ts`, `snapshots.svelte.ts`,
  `collectionStore.svelte.ts` `settingsWriteScope`), and the components `DefaultChatScreen.svelte`,
  `Suggestion.svelte`, `Toggles.svelte`, `DevTool.svelte`, `IrisModal.svelte`, and `PlaygroundSubtitle.svelte`.
- **So changing the pick alone breaks the settings.** If a settings pick only selected for the tab while the views
  still followed the open chat, a pick made with a bound chat open would change nothing on the page.
- **The header note has two states.** `BindingScopeNote.svelte` shows "This chat" when the open chat binds the field to
  a record that exists, else "Not set for this chat", and nothing at home.
- **The tab's selection is never written from a binding.** `resolveTabPreset` and its siblings fall back to the first
  record and select it when the selected id names none. `chatDisplayIds` uses the tab's selection for a chat's field
  that is unset or gone. A deletion moves only the tab's selection.
- **Model info takes a captured pair.** `getModelInfoForMode(mode, scope?)` and `resolveModelSlot(mode, scope?)` read
  the pair of `scope` when given, else the active family.
- **Counts and previews read the active family.** The Prompt pages count through `tokenCountInput`, `tokenScopeKey`,
  `countTokens`, and `tokenizePreset`, whose CBS expansion and tokenizer identity are the active family's. The popup
  editor (`PopupEditor.svelte`) previews, shows the chat's toggles, and counts the same way; a text area's
  `popupEditorContext` only guards the draft's write-back against a changed record.
- **Many tests mock the views module.** Seventeen test files replace `settingsViews.svelte` with a factory
  (`rg -l 'vi.mock\([^)]*settingsViews' src`), so a module that imports a new export fails under a factory without it.

## Rules For Every Slice

- The active family (`active*`, `current*Record`, `*RecordForWrite`, `readSettingsRoot`, `writeSettingsRoot`, the
  unscoped helpers) keeps its resolution and its callers outside the settings screen. No send, render, job, parser, or
  plugin path reads the edited family.
- A chat's binding is written by `chatBindingPatch` from a pick that names the chat, by the review confirmation, and by
  the paths that create a chat. No pick resolves "the open chat" by itself.
- The tab's selection is never written from a chat's binding without a user action on the settings screen.
- `chatDisplayIds`, `chatBinding`, `settingsWriteScope`, the plugin API's indexes (`selectedPresetIndex`,
  `selectedPersonaIndex`), and the upstream export's `tabSelectionIds` do not change.
- V1 to V9 apply. Each slice updates the guides it names (`pnpm docs:owner <path>`, `pnpm check:docs`). Full checks:
  `pnpm check`, `pnpm check:docs`, `pnpm format:check`, `pnpm --silent test:agent`, and the specs
  `pnpm --silent test:agent --e2e` selects for the diff.
- Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_ slice.

## Order

1, then 2. Slice 2 gives the names slice 1 introduces their own resolution, so it cannot start before slice 1 lands.
Both edit `src/ts/storage/settingsViews.svelte.ts`, `src/ts/persona.ts`, `src/lib/Setting/botpreset.svelte`,
`src/lib/Setting/listedPersona.svelte`, `src/lib/Setting/Pages/PersonaSettings.svelte`, and
`docs/structure/settings-i18n.md`.

## Slice 1. The settings read their own names (`settings-i18n.md`)

No behavior changes in this slice: every new name resolves exactly as the active name it stands beside.

Existing: `src/ts/storage/settingsViews.svelte.ts`, `src/ts/setting/utils.ts`, `src/ts/setting/searchIndex.ts`,
`src/ts/persona.ts`, `src/ts/storage/presets.svelte.ts`,
`src/lib/Setting/Settings.svelte`, `SettingsSections.svelte`, `SettingRenderer.svelte`, `botpreset.svelte`,
`listedPersona.svelte`, `src/lib/UI/PromptDataItem.svelte`, and under `src/lib/Setting/Pages/`:
`PromptPresetSettings.svelte`, `PromptSettings.svelte`, `OobaSettings.svelte`, `ModelSettings.svelte`,
`Model/AuxModelSelectors.svelte`, `Model/ProviderDefaultKeys.svelte`, `PersonaSettings.svelte`,
`OpenrouterSettings.svelte`, `ChatFormatSettings.svelte`, `Display/NullableTextColorToggle.svelte`; the mock factories
of the test files that mount these modules.

- **The edited family** (`settingsViews.svelte.ts`): `editedPreset`, `editedModelPreset`, `editedMainProfile`,
  `editedSubProfile`, `editedPersona`; `editedPresetRecord()`, `editedModelPresetRecord()`, `editedPersonaRecord()`;
  `readEditedRoot(key)` and `writeEditedRoot(key, value)`; and `editedScope(): PresetScope`, the ids of the shown
  prompt preset and model preset (`""` when a list is empty). In this slice each one is the active counterpart: the
  views are the same objects under a second export, the functions return what `currentPresetRecord`,
  `currentModelPresetRecord`, `currentPersonaRecord`, `readSettingsRoot`, and `writeSettingsRoot` return, and
  `editedScope()` names the records `activePreset.id` and `activeModelPreset.id` name. Their comments say what they
  are for (the settings screen's record) and what they resolve to now.
- **The registry**: `settingContext` builds its `preset`, `modelPreset`, `modelProfile` default, and `persona` from the
  edited family; `getSettingValue` and `setSettingValue` read and write through `readEditedRoot` and `writeEditedRoot`;
  `searchIndex.ts` reads `editedMainProfile`. `Settings.svelte`, `SettingsSections.svelte`, and `SettingRenderer.svelte`
  derive their model info with `getModelInfoForMode(mode, editedScope())`.
- **The pages and lists** named above read and write the edited family wherever they show or edit a preset, a model
  preset, a profile, or a persona: every `active*` and `current*Record` use, `ProfileSlotSelect`'s `presetId`, the
  default `profile` prop of `OpenrouterSettings` and `ChatFormatSettings`, the popup editor context ids, and the rows
  `botpreset.svelte` and `listedPersona.svelte` mark. `PromptPresetSettings`, `ModelSettings`, and `ProviderDefaultKeys`
  pass `editedScope()` to every `getModelInfoForMode` call.
- **Counts and previews stay the running chat's (D10).** The token counts of the Prompt pages (`tokenCountInput`,
  `tokenScopeKey`, `countTokens`, and `tokenizePreset`, all unscoped) and the popup editor's preview, toggles, and
  counter keep reading the active family: they count and preview the edited text with the open chat's tokenizer and
  variables. Only the text they are given comes from the edited family. `tokenizePreset` gains no parameter, and
  `src/ts/process/prompt.ts`, `src/ts/tokenizer.ts`, and `PopupEditor.svelte` are not edited.
- **The actions the pages call**: `selectUserImg` and `exportUserPersona` read `editedPersona`; `downloadPreset` reads
  `editedMainProfile.maxContext`; `applyPresetTemplate` (called by tests only) reads `editedPresetRecord()`.
- **What stays on the active family (D8)**: `MemorySettings.svelte` (the open chat's memory budget and connection),
  `Module/ModuleSettings.svelte` (the mark of a module the running preset integrates), and `PluginSettings.svelte`
  (the provider it clears on a removal). Each keeps a one-line comment saying it shows what the open chat runs with.
  The settings report of `Advanced/SettingsExportButtons.svelte` (`buildSettingsReport`) is a diagnostic of the running
  settings and is not edited.
- **Parity of the scoped calls.** `getModelInfoForMode(mode, editedScope())` agrees with the unscoped call for the same
  records, an empty model preset list included (`resolveModelSlot` throws `PresetTargetGoneError` for both).
  `editedScope()` reads both ids, so a call that read only the model preset also tracks the prompt selection and can
  repair a stale one; that is accepted. Confirm both with the code before editing, and say in the slice report where a
  call differs.
- Tests: none added (nothing can be told apart yet). The existing suite passes with no assertion changed. A test file
  whose `settingsViews.svelte` factory lacks a name a mounted module now imports gains it from a shared typed factory
  (V7), checked with `satisfies` against the module's exports.
- Guide: `settings-i18n.md` State names the edited family beside the active one and says the two resolve alike.

## Slice 2. The binding panel is the only way to bind (_hard_, `persistence.md`, `settings-i18n.md`, `app-shell.md`, `characters-modules.md`)

New file: `src/lib/Setting/BindingScopeNote.test.ts`. Existing: `src/ts/storage/settingsViews.svelte.ts`,
`src/ts/storage/chatBindingPick.ts`, `src/ts/storage/chatBinding.svelte.ts`, `src/ts/persona.ts`, `src/ts/hotkey.ts`,
`src/ts/stores.svelte.ts` (the `PickerListState` comment), `src/lib/Setting/botpreset.svelte`,
`src/lib/Setting/listedPersona.svelte`, `src/lib/Setting/BindingScopeNote.svelte`,
`src/lib/Setting/Pages/PersonaSettings.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`, and the tests and specs below.

- **The edited family resolves the tab's selection** (`settingsViews.svelte.ts`). `editedPreset` is built by
  `buildPresetView` over `resolveTabPreset` for reads and the record `selection.presetId` names for writes (no
  first-record fallback, so a write with no target is dropped as today); `editedModelPreset` likewise over
  `resolveTabModelPreset`; `editedMainProfile` and `editedSubProfile` are `profileForSlot` over that model preset's
  slots; `editedPersona` is the persona view over `resolveTabPersona`. `editedScope()` is the tab's resolved pair.
  The module header's rules list says which family reads the binding first and which never does.
- **The edited route table** (`settingsViews.svelte.ts`). `readEditedRoot` and `writeEditedRoot` use a second route
  table. `buildRootRoutes` takes the family it serves: the preset view and the persona view its preset and persona
  routes target, and, for the model roots, a read resolver and a no-fallback write resolver of the model preset, which
  `readModelRoot`, `writeModelRoot`, and `seperateModelsView` take in place of their active default and call on every
  access (an id captured when the table is built would keep the first selection, and the repairing read resolver in a
  write would redirect a write that must be dropped). The write resolver is forwarded through `writeModelRoot`'s
  whole-`seperateModels` call and the auxiliary setters. `routeOf` takes the table. `buildActivePersona` takes its read
  and write resolvers the same way, and the edited profile views pass `profileForSlot` a write getter over the record
  `selection.modelPresetId` names. The callers that pass a captured scope (`readPresetFieldOf`, `writePresetField`,
  `scopedPresetRoot`) and `writeModelRoot`'s validation, equality checks, warnings, and cloning keep their behavior. The
  section, collection, and selection routes are the same targets in both tables.
- **`pickBinding` takes a required target.** `ChatRef` binds that chat (as today); `null` selects for the tab. The
  `undefined` case and its `currentChatRef()` read are removed. `changeUserPersona(id, target: ChatRef | null)`
  follows.
- **The pickers.** `botpreset.svelte` and `listedPersona.svelte` pick for `chatRef ?? null`. The row they mark is
  `pickedId(field, chatRef ?? null, <the edited view's id>)`, and the "For this chat" line shows only with the prop. A
  list opened for a chat still closes when that chat is gone.
- **The Persona page.** A grid click and a created persona select for the tab (`null`); the ring marks
  `editedPersona.id`. The page no longer reads `currentChatRef()` for a pick.
- **Hotkeys (D5).** `changeToPreset` selects the prompt preset for the tab (`null`) with or without a chat open, and
  keeps its three guards and its toast. The lists the hotkeys and `quickMenu` open are the settings' lists.
- **The header note (D6)**, per field, while a chat is open: "This chat" when the chat's bound record exists and is the
  shown one; "Not this chat's" with a "Show this chat's" button when it exists and is another; "Not set for this chat"
  when it is unset or gone. Nothing at home. The component derives the shown id from the edited view of its field. The button calls
  `pickBinding(field, <the chat's bound id>, null)`.
  Strings `chatBinding.notThisChat` and `chatBinding.showThisChat` in `en.ts`, with `ko.ts` overrides.
- Tests:
  - `settingsViews.test.ts`, `presetViews.test.ts`, `personaViews.test.ts`: with a chat open that binds X while the tab
    selects Y, each active view reads X and each edited view reads and writes Y; the edited first-record fallback
    repairs the selection and a write with no target is dropped; `readEditedRoot` and `writeEditedRoot` for a prompt
    root, a model root, an auxiliary model root, and a persona alias; `editedScope()`; the edited profile views.
  - `chatBindingPick.test.ts`: the `undefined` cases become "`null` selects for the tab while a chat is open" and the
    type no longer accepts an omitted target.
  - `botpreset.test.ts`, `listedPersona.test.ts`, `PersonaSettings.test.ts`, `presetPages.test.ts`,
    `settingWrappers.test.ts`: a pick with a chat open and no `chatRef` leaves the chat's binding and moves the tab's
    selection; the page then shows and writes the picked record while the chat's bound record is untouched; a list
    opened for a chat binds it and leaves the tab's selection.
  - `hotkey.test.ts`: Ctrl+N with a chat open selects for the tab and leaves the binding.
  - `BindingScopeNote.test.ts`: the three states per field, nothing at home, and the button's selection.
  - Specs: `e2e/chatBinding.spec.ts` gains a settings pick with a bound chat open (the binding and the provider's next
    request keep the chat's preset; the Prompt page shows the picked one; the note and its button); the binding
    panel's rows bind as before. In `e2e/personaBinding.spec.ts` the `changeUserPersona` helper passes an explicit
    target and the icon case expects the persona the tab selects. `e2e/presetSelection.spec.ts` runs at home and is
    not changed.
  - V6: each new assertion is shown to fail with the old `undefined` branch or the old resolver restored.
- Guides: `persistence.md` (Chat binding: `pickBinding`'s two targets; the settings views' two families),
  `settings-i18n.md` (Preset lists, Flows, State, and the `e2e` line of Tests), `app-shell.md` (`changeToPreset`),
  `characters-modules.md` (`changeUserPersona`).

## Decisions

- **D1. Only the binding panel changes a chat's binding.** (Owner, 2026-11-17: "what the chat sidebar sets is changed
  in the sidebar only".) The Chat Settings dialog counts: it mounts the same panel for a chat of the list.
- **D2. The settings screen shows the tab's selection also while a chat is open.** (Owner, 2026-11-17, over keeping the
  chat's record on the page and refusing picks there.) Looking at a preset that was just imported, with a chat open,
  is the case that decided it.
- **D3. A second family for the settings, not a changed `active*`.** A reader the move misses then keeps today's
  behavior: a settings control that still shows the chat's record is visible and harmless, while a request that reads
  the tab's record instead of the chat's sends with the wrong prompt and says nothing. Rejected: a flag that turns the
  binding off while the settings are open (chat-side reads run behind the settings screen and would see it).
- **D4. Names first, behavior second.** Slice 1 is wide and changes nothing, so the whole suite checks it as it is.
  Slice 2 is narrow and carries every behavior change, so the pick rule and the settings' record flip in one commit:
  either one alone leaves a pick that changes nothing on the page.
- **D5. Ctrl+1..9 and the lists a hotkey opens select for the tab.** They are settings actions under D1. Open to the
  owner's change: the alternative is that they do nothing while a chat is open.
- **D6. The note compares, and its button only selects.** It never binds, so D1 holds on the settings screen without
  an exception.
- **D7. The selection never follows a chat.** Opening a chat or changing its binding does not move the tab's selection,
  which keeps `chatDisplayIds`' fallback ("never another chat's binding") true. The cost is one click on the note's
  button to edit the record the open chat uses.
- **D8. Three pages keep showing what the open chat runs with.** The memory budget, the mark of a module the preset
  integrates, and the plugin provider that a removal clears describe the running chat, not a record being edited.
- **D9. `pickBinding` keeps one function with a required target.** A caller states the chat or `null`, so a new picker
  cannot bind the open chat by leaving an argument out.
- **D10. Token counts and popup previews on the settings screen count as the open chat would.** They differ from a
  count with the edited records only when the tokenizer choice or the CBS expansion depends on a prompt preset, model
  preset, or persona that differs between the two. Threading the edited records through the CBS expansion, the
  tokenizer identity, and the popup session would change the parser and the tokenizer for that number. Open to the
  owner's change.

## Not In This Plan

- **A way to bind from the settings** (a "use in this chat" button on a page or a list row). D1 rules it out.
- **Following the open chat when the settings open** (selecting the chat's records for the tab at that moment).
- **The memory page's split** into what the chat runs with and what the tab selects.
- **Clearing a removed plugin's provider in every profile** instead of one.
- **A check that no chat-side module imports the edited family.** The guides and the views' comments carry the rule.
- **Counting and previewing with the edited records** (D10).
- **Recounting the template when the running chat's variables change.** `PromptSettings` builds its count input from
  the template items and the tokenizer identity, and expands CBS later, untracked; an unchanged template is not
  recounted when a variable default it reads changes. That is today's behavior.
- **Other locales' strings.** They fall back to English.

## Manual Checks

For the owner, after slice 2:

1. Open a chat bound to prompt preset X. In the settings, import a preset and pick it in the list: the Prompt page
   shows the imported one, the header says it is not this chat's, and the chat's binding panel still shows X.
2. Send in that chat: the request uses X.
3. Press the header's "Show this chat's" button: the page shows X and the header says "This chat".
4. Change the chat's prompt preset from the binding panel: the chat's row changes, and the settings page keeps the
   preset it showed.
5. Press Ctrl+2 with the chat open: the toast names the preset, the settings show it, and the chat's binding is
   unchanged.
6. On the Persona page with a chat open, click another persona and create one: the chat's persona row is unchanged.
7. Repeat 1 for the Model page.
