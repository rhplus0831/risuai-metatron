# Slice: Readers, Settings Consumers Outside The Settings Pages

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" ("components bind
to these instead of `DBState.db`"; the settings reads of `DefaultChatScreen.svelte` and
`Chat.svelte`) and the Safety Contract measurement; `PLAN.md` invariant 3.

Depends on: `settings-ownership`. Parallel with `readers-settings-pages` and
`readers-characters`.

## Scope

Allowed files: the settings readers under `src/lib` outside `src/lib/Setting`: `src/lib/Others/{WelcomeRisu,AlertComp,IrisModal,CustomSidebarConfig,AllSeperateParameters,QuickSettingsGUI,PopupEditor}.svelte`,
`src/lib/Others/ProTools/EasyPanel.svelte`, `src/lib/Others/HypaV3Modal.svelte` and
`HypaV3Modal/*` (their settings reads), `src/lib/SideBars/{Toggles,CustomSidebar,DevTool}.svelte`
(settings reads), `src/lib/SideBars/Scripts/TriggerV2List.svelte`, `src/lib/ChatScreens/*.svelte`
(settings reads only: `newMessageButtonStyle`, `sendWithEnter`, `useAutoTranslateInput`,
`iconsize`, `theme`, `translator*`, ...), `src/lib/Playground/{PlaygroundEmbedding,PlaygroundSubtitle,PlaygroundMenu}.svelte`,
`src/lib/UI/GUI/{TextAreaInput,TextAreaResizable,MultiLangDisplay}.svelte`, `src/lib/UI/{PromptDataItem,Title,ModelList,MainMenu}.svelte`,
`src/lib/UI/Realm/{RealmHubIcon,RealmPopUp}.svelte`, `src/App.svelte` (`didFirstSetup`); the
client process readers that remain after Phase 5: `src/ts/gui/{colorscheme,guisize,animation}.ts`,
`src/ts/hotkey.ts`, `src/ts/translator/translator.ts`, `src/ts/process/{tts,stableDiff}.ts`,
`src/ts/model/{modellist,openrouter,nanogpt}.ts`, `src/ts/tokenizer.ts`, `src/ts/parser/parser.svelte.ts`
(its display-setting reads), `src/ts/parser/chatVar.svelte.ts` (`globalChatVariables`),
`src/ts/persona.ts`, `src/ts/util.ts` (persona resolution), `src/ts/process/mcp/{mcp,googlesearchclient}.ts`,
`src/ts/process/index.svelte.ts` (the job client's settings reads and the `statics.messages`
pre-send write), `src/ts/plugins/apiV3/v3.svelte.ts` and `src/ts/plugins/plugins.svelte.ts`
(their settings reads through `readSetting`; the writers are Phase 4's), `src/ts/media/compressImage/compressImage.ts`,
`src/ts/storage/browserLocalImport.ts`, `src/lang/en.ts`. Tests belong to the review step.

Identifiers (verified 2026-09-30; matching lines, tests excluded): `WelcomeRisu.svelte` 49
(writes `language`, `username`, the three provider keys, `setPreset(DBState.db, prebuiltPresets.OAI2)`
at 76, `textTheme`, `maxContext`, `maxResponse`, `aiModel`, `subModel`, `openrouterRequestModel`,
the translator fields, `didFirstSetup`, `claudeCachingExperimental`; calls `changeLanguage`,
`updateTextThemeAndCSS`), `EasyPanel.svelte` 25, `AlertComp.svelte` 21 (its character reads are
`readers-characters`'), `IrisModal.svelte` 7 (`irisDialogue`, model fields), `Toggles.svelte`
15, `CustomSidebar.svelte` 8, `ChatScreen.svelte` 15, `Suggestion.svelte` 15, `Chat.svelte` 50
(settings fields: `askRemoval`, `clickToEdit`, `iconsize` 12, `theme`, `translator*`, ...),
`DefaultChatScreen.svelte` 90 (settings fields: `newMessageButtonStyle` 7, `useAutoTranslateInput`
5, `fixedChatTextarea` 4, `sendWithEnter` 3, `useAutoSuggestions` 4, `hypav2`, `hypaV3`, ...),
`ChatBody.svelte` 8, `colorscheme.ts` 9 (`colorScheme`, `textTheme`, `customTextTheme.*`,
`font`, `customFont`, `customCSS`, `customColorScheme` at 229-390), `guisize.ts` (8-17),
`animation.ts` (3-5), `hotkey.ts` (34-36, 103-124, 172-174, 307-308, 369-373), `translator.ts`
(9 `getDatabase(`), `tts.ts` (3), `stableDiff.ts` (2), `modellist.ts` 8, `tokenizer.ts` (4),
`parser.svelte.ts` 16 (`hideAllImages`, `customQuotes`, `unformatQuotes`, `blockquoteStyling`,
`assetWidth`, `legacyMediaFindings`, `assetMaxDifference`, `returnCSSError`), `chatVar.svelte.ts`
7, `persona.ts` 18, `util.ts` (11), `index.svelte.ts` 87 (most of the body moves to the server
in Phase 5; the remaining reads are re-derived at phase start), `App.svelte:50`; Phase 4's
allowlist entries in this group: `persona.ts` (`selectUserImg`, `changeUserPersona`: Phase 3's
forms), `colorscheme.ts:272, 307` (`changeColorSchemeType`, `importColorScheme`),
`index.svelte.ts:357` (`statics.messages`), `PlaygroundMenu.svelte:44` (a character push;
`readers-characters`').

Stopping condition: a reader of a dropped field (reported), or a reader in `index.svelte.ts`
that Phase 5 left on the client and this list does not name (re-derived at phase start, then
owned here).

## Assumptions

- `settings-ownership` landed (the records, `applyPresetTemplate`); Phase 5 removed the client
  send pipeline, request layer, Lua, trigger, and `scripts.ts` runtime (the reader list is
  re-derived from `rg -c 'DBState\.db' src/ts` at phase start).
- Phase 4 (verified): the plugin host reads forwarded keys through `readSetting`; `changeColorScheme`
  and `updateCustomColorScheme` call `updateSettings`; `googlesearchclient.ts` and `mcp.ts` write
  through the module; `index.svelte.ts:357` and `:368-370` are the pre-send stamps Phase 5
  keeps client-side.

## Proposed decisions

- Reads become `settings.<section>.<field>` (or `selectedPreset`/`selectedPersona`); the
  allowlist writers here call `updateSettings`, `selectPersona`, or the Phase 3 persona functions;
  `WelcomeRisu.svelte` calls `applyPresetTemplate(selection.presetId, prebuiltPresets.OAI2)` and
  `updateSettings` for the rest; `index.svelte.ts:357` calls `updateSettings({ statics })`;
  `App.svelte`'s `$derived` reads `settings.ui.didFirstSetup`; `CustomCSSStore` is fed from
  `settings.ui.customCSS`.
- `readSetting(key)` (Phase 4) is the plugin host's read path and stays; it resolves through the
  records after `settings-ownership`.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests: the first-run
wizard over `storeBackedServer.ts` (every write lands in its section or the selected preset);
`colorscheme.ts`, `guisize.ts`, `animation.ts`, and `hotkey.ts` over the records. Manual,
recorded here: first run on a fresh server, the chat screen's settings-driven behaviors (send
with Enter, auto translate, icon size, theme), the playground pages, the Iris modal. Scoped
gate: `rg -c 'DBState\.db' src/lib/Others src/lib/Playground src/lib/UI src/App.svelte src/ts/gui src/ts/hotkey.ts src/ts/translator src/ts/process/tts.ts src/ts/process/stableDiff.ts src/ts/model src/ts/tokenizer.ts src/ts/parser src/ts/persona.ts src/ts/util.ts src/ts/process/mcp`
returns nothing, and `src/lib/ChatScreens` and `src/lib/SideBars` list only character and chat
reads (owned by the next slices).

## Residual risk

`index.svelte.ts`'s remainder after Phase 5 is the one file whose reader list this draft cannot
fix. `AlertComp.svelte`, `DevTool.svelte`, `Toggles.svelte`, `CustomSidebar.svelte`, and the
chat screens are edited by two reader slices (different reads, sequential where they overlap:
this slice first, then `readers-characters`).
