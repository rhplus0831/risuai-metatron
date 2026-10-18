# Settings UI Reorganization Plan

Status: no slice landed. Written 2026-10-19 at `63228a7cf` after comparing the settings
screen with the sibling fork `/home/codex/risuai-fastify` (its `ff9868006` "reorganize
settings UX", `eb9ac3ea8` "split interaction and accessibility settings", and the rules in
its `src/docs/ui-ux-guideline.md` and `src/docs/svelte-settings-ui.md`). One slice is one
session, one commit. Owning guide: [settings-i18n](../structure/settings-i18n.md), plus
[app-shell](../structure/app-shell.md) for the new routes and [media-aux](../structure/media-aux.md)
for the image, TTS and translation pages it owns.

The goal is placement, not new behavior: every setting ends on the page of the feature it
configures, catch-all lists (Advanced, Accessibility, Display's Others tab, Other Bots)
are taken apart, and the sidebar is grouped. No persisted field, default, migration or
`shared/sections.ts` ownership changes; a setting that moves keeps its `SettingItem.id`.

## Decisions

Made with the user on 2026-10-19:

1. **Other Bots is split** into three pages: Memory, Image Generation, Voice & Emotion.
2. **A credential has one editing place.** A key stays visible next to the feature that
   uses it, but only its owning page edits it; the other places show its status (set,
   last four characters, not set) and a link to the owning page.
3. **Settings with no reader leave the UI only.** Their stored fields, defaults and
   normalizers stay (no `DROPPED_FIELDS` entry).
4. **The Model page rework is out of scope** (fastify's `3776f84ea`). The Model page only
   receives the moved request settings in one collapsible section (slice 4).
5. **The quick settings panel is removed.** Model and prompt presets are bound per chat
   and edited from `ChatBindingPanel` (the open chat's sidebar), modules from the
   hamburger menu's module entry, memory from the HypaV3 modal and its settings link.
   Ctrl+Q stays caught: the `quickSettings` hotkey action shows a notice that the panel
   was removed and where its parts went, instead of letting the browser act on the key.
6. **Language and translation are split** into two pages: Language (the UI language
   only) and Translation (the translator and every translation option).
7. **No settings search UI.** `getFullSettingsData` stays as it is (tests only).
8. **Memory's slug becomes `memory`**, with `/settings/bot` kept as an alias.
9. **Memory's OpenAI key gets one input.** `supaMemoryKey` is shown once, labelled as
   shared by summarization and embeddings, whenever either one uses OpenAI.

Rules every slice follows (from fastify's work, adapted):

- **Stable ids.** A moved item keeps its id (`adv.lbDepth` on the Memory page keeps
  `adv.`); only a new item gets the new page's prefix. Search, tests and any future
  sidebar customization address items by id.
- **Leaf arrays stay the catalog.** A page's sections are built by looking items up by id
  in the leaf arrays (a lookup helper that throws on an unknown id), never by copying an
  item, so `getFullSettingsData` lists each item once.
- **Visible sections, collapsible only for the rarely used.** An ordinary section is a
  named, always-visible region; an accordion is used only for advanced, experimental,
  developer and legacy groups. No accordion inside an accordion (a custom component that
  brings its own accordion gets a `noAccordion` prop when placed in a collapsible section).
- **Dependent controls stay together.** A conditional item sits right under the item its
  condition reads (`adv.dynAssetsEdit` under `adv.dynAssets`, `acc.alwaysScrollToNewMessage`
  under `acc.autoScrollToNewMessage`, the custom quote fields under `display.customQuotes`).
- **A global setting on a preset page says so.** The Prompt and Model pages edit the
  selected (or chat-bound) preset; a moved `providers`/`ui` field there sits in a section
  whose description says it applies to every preset.
- **Strings** go to `src/lang/en.ts` first, Korean overrides in `ko.ts`; section titles
  and descriptions are new keys, labels of moved items are unchanged.

Out of scope: settings search UI, the Model page rework, deleting persisted fields, new
settings, the Module editor, plugin pages, and theme/visual restyling beyond what a
section needs.

## Target navigation

| Group            | Entries (index → slug)                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat setup       | Model (1/18/17 → `model`, `connections`, `api-keys`), Prompt (16/13 → `prompt`, `prompt-template`), Persona (12 → `persona`)                                                           |
| Features         | Memory (2 → `memory`), Image Generation (19 → `image-generation`), Voice & Emotion (20 → `voice`), Translation (21 → `translation`), Modules (14 → `modules`), Plugins (4 → `plugins`) |
| Interface        | Display & Audio (3 → `display`), Interaction (22 → `interaction`), Accessibility (11 → `accessibility`), Language (10 → `language`), Hotkeys (15 → `hotkeys`)                          |
| Data             | Backups (0 → `user`; label "Files" becomes "Backups")                                                                                                                                  |
| Advanced & about | Advanced (6 → `advanced`), Supporters (77 → `thanks`), plugin-added menus                                                                                                              |

The new indexes 19–22 get named constants in `src/ts/settingsMenu.ts`; the removed
indexes 7, 8 and 9 are not reused. The router has no slug aliases today
(`src/ts/router/routes.ts` `SETTINGS_PAGES`, `parseRoute` returns `null` for an unknown
slug). Memory's slug becomes `memory` (decided 2026-10-19); slice 3 adds a one-entry
alias so an old `/settings/bot` URL still opens index 2 and is replaced with
`/settings/memory`.

## Move table

Ids are `SettingItem.id`s from `src/ts/setting/*Data*.ts`; entries without an id are
handwritten controls. "Stays" means same page, now inside the named section.

### Advanced (`advancedSettingsData.ts`, 65 items) → many pages

| Item                                                                                                                                                                                                                                                             | Destination                              | Section                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `adv.header`, `adv.warn`                                                                                                                                                                                                                                         | Advanced                                 | page heading                                                                                                         |
| `adv.showUnrec`, `adv.useExp`                                                                                                                                                                                                                                    | Advanced                                 | Feature access (first)                                                                                               |
| `display.hideApiKey` (from Display)                                                                                                                                                                                                                              | Advanced                                 | Feature access                                                                                                       |
| `adv.chatLoadInitial`, `adv.chatLoadAdditional`, `adv.assetAlloc`, `adv.imgComp`, `adv.legacyMedia`, `adv.allowExt`, `adv.dynAssets`, `adv.dynAssetsEdit`, `adv.tokCache`                                                                                        | Advanced                                 | Performance & media                                                                                                  |
| `adv.toolUsage`, `adv.simpleTool`, `adv.requestHistoryContent`, `adv.requestHistoryLimit`                                                                                                                                                                        | Advanced                                 | Requests & tools                                                                                                     |
| `adv.devTools`, `adv.promptInfo`, `adv.promptTextInfo`, `adv.cssErr`, `acc.requestInfoInsideChat`, `acc.inlayErrorResponse` (from Accessibility), `adv.export`, `adv.diagnostics`, `adv.diagnosticsPanel`                                                        | Advanced                                 | Developer & diagnostics (collapsible)                                                                                |
| `adv.streamingDisplayOpt`, `adv.exp.googleToken`, `adv.exp.cachePoint`, `adv.exp.claudeRet`                                                                                                                                                                      | Advanced                                 | Experimental (collapsible, keeps the `useExperimental` conditions)                                                   |
| `adv.plainFetch`, `display.useLegacyGUI` (from Display)                                                                                                                                                                                                          | Advanced                                 | Legacy (collapsible)                                                                                                 |
| `adv.retries`, `adv.genTime`, `adv.visionQual`, `adv.autoFill`, `adv.remIncomp`, `adv.autoCont`, `adv.autoContinueMin`, `adv.newOai`, `adv.dynamicModelRegistry`, `adv.antiOverload`, `adv.openAIFlex`, `adv.claudeCache`, `adv.claudeBatch`, `adv.customModels` | Model (Preset tab)                       | Advanced model behavior (collapsible, "applies to every preset")                                                     |
| `acc.applyAdditionalParamsToAll` (from Accessibility)                                                                                                                                                                                                            | Model (Preset tab)                       | under the Additional Params accordion                                                                                |
| `adv.localNetworkMode`, `adv.localNetworkTimeout`                                                                                                                                                                                                                | removed from Advanced                    | the Connections editor's Local Network Mode accordion already edits the same profile field                           |
| `adv.addPrompt`, `adv.descPrefix`, `adv.sayNothing`, `adv.presetChain`, `adv.banChar`, `adv.cot`                                                                                                                                                                 | Prompt (Others tab)                      | Advanced prompt behavior (collapsible, "applies to every preset"; `adv.cot` keeps its `showUnrecommended` condition) |
| `display.showPromptComparison` (from Display)                                                                                                                                                                                                                    | Prompt (Others tab)                      | Advanced prompt behavior                                                                                             |
| `adv.lbDepth`, `adv.lbToken`, `adv.remPunc`                                                                                                                                                                                                                      | Memory                                   | Lorebook (`lbDepth`, `lbToken`), memory section (`remPunc`, next to the HypaV2/V3 options it affects)                |
| `adv.emoPrompt`                                                                                                                                                                                                                                                  | Voice & Emotion                          | Emotion                                                                                                              |
| `adv.newImgBeta`                                                                                                                                                                                                                                                 | Image Generation                         | Image handling                                                                                                       |
| `adv.noWaitTrans`, `adv.exp.googleTrans`                                                                                                                                                                                                                         | Translation                              | Behavior / Experimental                                                                                              |
| `adv.keepSessionAlive`, `adv.heightMode`                                                                                                                                                                                                                         | Display                                  | Sound & notifications / Layout & sizing                                                                              |
| `adv.scrollToActive`, `adv.bookmark`                                                                                                                                                                                                                             | Interaction                              | Chat & navigation                                                                                                    |
| `adv.personaNote`                                                                                                                                                                                                                                                | Persona                                  | above the note field it reveals                                                                                      |
| `adv.forceProxy`, `adv.devMode`                                                                                                                                                                                                                                  | removed from the UI (no reader; slice 1) | —                                                                                                                    |

### Accessibility (`accessibilitySettingsData.ts`, 27 items) → Interaction, Accessibility, others

| Item                                                                                                                                                                                    | Destination                              | Section                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `acc.sendWithEnter`                                                                                                                                                                     | Interaction                              | Input                                                      |
| `acc.clickToEdit`, `acc.enableBlockPartialEdit`, `acc.enableDragPartialEdit`, `acc.longPressToPopupEditor`, `acc.askRemoval`, `acc.instantRemove`, `acc.swipe`                          | Interaction                              | Message editing                                            |
| `acc.botSettingAtStart`, `acc.showMenuChatList`, `acc.showMenuHypaMemoryModal`, `acc.sideMenuRerollButton`, `acc.goCharacterOnImport`, `acc.createFolderOnBranch`, `acc.newChatBinding` | Interaction                              | Chat & navigation                                          |
| `acc.header`, `acc.autoScrollToNewMessage`, `acc.alwaysScrollToNewMessage`, `acc.newMessageButtonStyle`                                                                                 | Accessibility                            | Scrolling                                                  |
| `acc.fixedChatTextarea`, `acc.hamburgerButtonBottom`                                                                                                                                    | Accessibility                            | Reachability; the page ends with a link to Display's sizes |
| `acc.localActivationInGlobalLorebook`, `acc.bulkEnabling`                                                                                                                               | Memory                                   | Lorebook                                                   |
| `acc.showTranslationLoading`                                                                                                                                                            | Translation                              | Behavior                                                   |
| `acc.requestInfoInsideChat`, `acc.inlayErrorResponse`                                                                                                                                   | Advanced                                 | Developer & diagnostics                                    |
| `acc.applyAdditionalParamsToAll`                                                                                                                                                        | Model                                    | see above                                                  |
| `acc.moveInsteadOfCopyOnCMPConvert`                                                                                                                                                     | removed from the UI (no reader; slice 1) | —                                                          |

### Display (`displaySettingsData.svelte.ts`) → four tabs

Tabs become Theme, Layout & sizing, Chat appearance, Sound & notifications; the Others
tab goes away.

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tab                                                           | Section                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------ |
| `display.theme`, `display.guiHTML`, `display.waifuWidth`, `display.waifuWidth2`                                                                                                                                                                                                                                                                                                                                                                                                      | Theme                                                         | Interface style          |
| `display.colorScheme`, `display.customColorScheme`, `display.textTheme`, `display.customTextTheme`, `display.font`, `display.customFont`, `display.customBackground`                                                                                                                                                                                                                                                                                                                 | Theme                                                         | Colors & typography      |
| `display.customCSS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Theme                                                         | Custom CSS (collapsible) |
| `display.customGui`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | removed (unreachable: no theme option is `"custom"`; slice 1) | —                        |
| `display.zoomsize`, `display.lineHeight`, `display.chatScreenWidth`, `display.iconsize`, `display.textAreaSize`, `display.textAreaTextSize`, `display.sideBarSize`, `display.animationSpeed`, `display.settingsCloseButtonSize`                                                                                                                                                                                                                                                      | Layout & sizing                                               | Element sizes            |
| `adv.heightMode`, `display.menuSideBar`, `display.showFolderName`, `display.hideRealm`, `display.showSavingIcon`                                                                                                                                                                                                                                                                                                                                                                     | Layout & sizing                                               | Window & sidebar         |
| `display.showMemoryLimit`, `display.memoryLimitThickness`, `display.showFirstMessagePages`, `display.roundIcons`, `display.textScreenColor`, `display.textBorder`, `display.textScreenRounded`, `display.textScreenBorder`, `display.useChatCopy`, `display.unformatQuotes`, `display.blockquoteStyling`, `display.customQuotes`, `display.leadingDoubleQuote`, `display.trailingDoubleQuote`, `display.leadingSingleQuote`, `display.trailingSingleQuote`, `display.useChatSticker` | Chat appearance                                               | Messages                 |
| `display.hideAllImages`, `display.assetWidth`, `display.useAdditionalAssetsPreview`                                                                                                                                                                                                                                                                                                                                                                                                  | Chat appearance                                               | Media                    |
| `display.playMessage`, `display.playMessageOnTranslateEnd`, `adv.keepSessionAlive`                                                                                                                                                                                                                                                                                                                                                                                                   | Sound & notifications                                         | Sound                    |
| `display.notification`                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sound & notifications                                         | Notifications            |
| `display.useLegacyGUI`, `display.hideApiKey`                                                                                                                                                                                                                                                                                                                                                                                                                                         | Advanced                                                      | Legacy / Feature access  |
| `display.showPromptComparison`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Prompt                                                        | Advanced prompt behavior |

### Language (`languageSettingsData.svelte.ts`) → Language and Translation

| Item                                                                                                                                                                                                                              | Destination                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `lang.header`, `lang.uiLanguage`, `lang.restartWarn`                                                                                                                                                                              | Language                                                   |
| `lang.translatorLang`, `lang.translatorType`, `lang.deeplKey`, `lang.deeplFree`, `lang.deeplXUrl`, `lang.deeplXToken`, `lang.llmPresets`, `lang.llmTranslationTarget`, `lang.translatorHistoryMaxTokens`, `lang.googleSourceLang` | Translation: Translator                                    |
| `lang.combineTranslation`, `lang.legacyTranslation`, `lang.translateBeforeHTML`, `lang.autoTranslateCachedOnly`, `adv.noWaitTrans`, `acc.showTranslationLoading`                                                                  | Translation: Behavior                                      |
| `adv.exp.googleTrans`                                                                                                                                                                                                             | Translation: Experimental (collapsible, `useExperimental`) |
| `lang.exportCache`, `lang.importCache`, `lang.clearCache`                                                                                                                                                                         | Translation: Cache                                         |

`langState` and the UI-language flow stay with Language. The Translation items keep
their `lang.` ids.

### Other Bots (`OtherBotSettings.svelte`, 1713 lines, handwritten) → three pages

| Part                                                                                             | Destination                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Long Term Memory tab (type select, Hanurai, HypaV2, HypaV3 presets, SupaMemory, embedding model) | Memory (index 2)                               |
| Image Generation tab (`mtm.sdProvider` and every provider block)                                 | Image Generation (19)                          |
| TTS tab, Emotion Images tab (`mtm.emotionProcesser`)                                             | Voice & Emotion (20), sections TTS and Emotion |

The tab-shaped `Accordion disabled` wrappers go away (one page per former tab). The
`useLegacyGUI` stacking of these tabs goes away with them.

### Credentials (decision 2) → one editing place each

| Credential                                                                                                               | Edited on                                                                                                                                                                                                                                                                                                    | Status + link on                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `llmSecrets` flat `openAIKey`                                                                                            | Model › API Keys                                                                                                                                                                                                                                                                                             | Voice & Emotion (TTS), Image Generation (DALL-E) |
| `llmSecrets` nested `google`                                                                                             | Model › API Keys                                                                                                                                                                                                                                                                                             | Image Generation (Imagen)                        |
| `secrets.NAIApiKey`                                                                                                      | Image Generation (NovelAI)                                                                                                                                                                                                                                                                                   | Voice & Emotion (TTS)                            |
| `llmSecrets` flat `supaMemoryKey`                                                                                        | Memory: one input (decision 9), shown when `supaModelType === "instruct35"` (HypaV2 or SupaMemory) or `hypaModel` is `openai3small`/`openai3large`/`ada`; it replaces today's three `SecretInput`s, two of which can show at once under different labels. The dead `davinci`/`curie` conditions go with them | —                                                |
| other `secrets.*` keys (ElevenLabs, HuggingFace, fish-speech, Stability, fal, openai-compatible, WaveSpeed, Hypa custom) | stay where they are (one place each today)                                                                                                                                                                                                                                                                   | —                                                |

## Slices

Workflow per slice: a _small_ slice is edited directly, with no adversarial review (its
mistakes are a dropped or doubled item, which the section test catches, or a broken
layout, which the browser pass catches); slice 2 shows its API to the user before slices
3–7 build on it. A _medium_ slice uses `opus-lite`. Each slice ends with `pnpm check`,
`pnpm --silent test:agent`, the section test from slice 2 (from slice 2 on), a Playwright
pass over the pages it touched at desktop and 390 px (the `run` skill; one dev stack at a
time), and the guide updates it implies (`settings-i18n.md` Files/Pages, `app-shell.md`
for a route).

- **1. Cleanup** (_small_). Remove `QuickSettingsGUI.svelte`, the `QuickSettings` store and
  its `Sidebar.svelte` branch, and `quick` in `ModelSettings`/`ModelMenuTabs`. The
  `quickSettings` hotkey stays in `shared/hotkeys.ts`'s defaults (the normalizer appends
  it, so new and existing users keep Ctrl+Q caught); `hotkey.ts`'s `quickSettings` case
  keeps `preventDefault` and calls `alertNormal` with a new `quickSettingsRemoved` string
  (names the chat binding panel and the module menu); `activeHotkeys` hides the action
  from the hotkey table while the dispatch (`enabledHotkeys`) and stored lists keep it.
  Remove from the UI: `adv.forceProxy`, `adv.devMode`, `acc.moveInsteadOfCopyOnCMPConvert`,
  `display.customGui` (and `CustomGUISettingMenu` if nothing else opens it), the dead
  menu indexes 7, 8, 9 in `Settings.svelte` with `openLoreList`/`Lorepreset` if unused
  elsewhere. Update the settings-i18n hazard about `pluginDevelopMode`/`forceProxyAsOpenAI`.
  _Done_: Ctrl+Q shows the notice and nothing else; the hotkey table has no quick settings
  row; the removed items are absent and their fields still load and save.
- **2. Sections** (_small_). `SettingSection` (`id`, `labelKey`, `descriptionKey?`,
  `badgeKey?`, `collapsible?`, `items`) in `types.ts`; `SettingsSections.svelte` (visible
  region with `h3`, or the shared `Accordion` when collapsible) over `SettingRenderer`; an
  id lookup helper; `noAccordion` for `BanCharacterSetSettings` and `CustomModelsSettings`.
  Advanced is converted in place to its sections (no item leaves the page yet).
  _Test_: a pure-data `src/ts/setting/settingsPageSections.test.ts`: leaf ids unique,
  section ids unique, every catalog item placed exactly once across all pages' sections
  (headers excepted), the dependent pairs share a section. Later slices extend its page
  list.
- **3. Split Other Bots** (_medium_). Memory (2), Image Generation (19), Voice & Emotion
  (20) as three components, mostly a mechanical cut of `OtherBotSettings.svelte`; routes,
  named constants, nav entries, the `memory` slug with its `bot` alias; the HypaV3 modal header link
  stays on index 2; `OtherBotSettings.hypaV3Export.test.ts` follows the memory component.
- **4. Take Advanced apart** (_medium_). Every Advanced row of the move table; the Model
  and Prompt sections; Persona's note toggle. Runs after 2 and 3.
- **5. Interaction and Accessibility** (_medium_). New Interaction page (22) with its data
  file, route and nav entry; the Accessibility rows of the move table.
- **6. Language and Translation** (_small_). New Translation page (21); the language data
  file exports the two item lists; `TranslatorPresetSettings` moves with it.
- **7. Display tabs** (_small_). The four tabs and their sections; Others removed.
- **8. One editing place per credential** (_medium_). A small status-and-link component
  over `SecretInput`'s status for the non-owning places; the table above.
- **9. Sidebar groups** (_small_). Group headings in `Settings.svelte`, the order of the
  target navigation, "Files" renamed "Backups". Runs last.

Order: 1 and 2 first (any order); 3 before 4; 4–7 touch different data files and can run in
parallel sessions after 3, but 4, 5 and 6 all add to the section test's page list and to
`Settings.svelte`: run them one at a time or merge with care; 8 after 3; 9 last.

## Hazards to check while moving

- **First-visit writes** (settings-i18n Known Hazards): some pages save control defaults on
  their first mount. A page that gains items must be checked with
  `e2e/settingsPages.spec.ts` (a second visit writes nothing).
- **Preset context.** Items moved onto the Model or Prompt page bind `providers`/`ui`
  roots; a condition on a model field reads `ctx.modelPreset`, and moved items must not
  pick up the chat-bound preset by accident.
- **`SettingSegmented` hidden-option write** (settings-i18n Known Hazards) applies to
  `acc.newChatBinding` wherever it lands.
- **Remounts.** `Settings.svelte` remounts a page on every index change; a split page that
  keeps local state (HypaV3 preset selection, image-gen fetches) must not depend on
  staying mounted across the former tabs.
- **e2e and router tests** that address the old slugs or the Other Bots tabs
  (`e2e/settingsPages.spec.ts`, `src/ts/router/*.test.ts`) are updated in the slice that
  moves the page.

## Continue Remaining Work

Next: slice 1 or 2. Record each landed slice in the Status line with its commit, and the
decisions a slice makes where the plan leaves a choice. When every slice has landed, move this file to the archive as
`docs/archived-plan/README.md` describes.
