# UI Components and Theming

## Scope

- Owns:
  - the Svelte component tree below `App.svelte` (chat screen, message rendering components, sidebar),
  - the reusable GUI primitives,
  - popups and portals,
  - theme colors and CSS tokens,
  - GUI sizing, tooltip, and longpress actions,
  - chat branches.
- Paths:
  - `src/lib/ChatScreens/*`
  - `src/lib/SideBars/*`, except `Scripts/`, `LoreBook/`, `CharConfig.svelte`
  - `src/lib/Others/*`, except the files owned by other guides
  - `src/lib/UI/*`, except `Realm/`, the model pickers, `PromptDataItem.svelte`, `MainMenu.svelte`, `Title.svelte`
  - `src/lib/UI/GUI/*`, `src/lib/UI/NewGUI/*`
  - `src/lib/Mobile/*`
  - `src/lib/Playground/PlaygroundMenu.svelte`
  - `src/styles.css`
  - `src/ts/gui/*`, except `highlight.ts` and `codearea/`
- Not here:
  - Screen selection in `App.svelte` → `app-shell.md`.
  - Settings pages → `settings-i18n.md`.
  - Markdown/HTML rendering internals → `cbs-rendering.md`.
  - The send path → `chat-pipeline.md`.

## Files

Each component's contract is the JSDoc block at the top of its `<script>`; a `.ts` module's is its header or the
comments on its exports. An entry names the path, its role, and the identifiers to look up there.

### Chat screen

- `src/lib/ChatScreens/ChatScreen.svelte`: the chat layout, custom background, and `isolate` that keeps local content
  below app popups ([portals](#dialogs-popovers-and-portals)).
- `src/lib/ChatScreens/DefaultChatScreen.svelte`: home/playground/closed-chat selection, composers and menus, the row
  window, screenshots (`src/lib/ChatScreens/screenshotExport.ts`), and message jumps. The closed-chat branch is
  `src/lib/ChatScreens/ClosedChatScreen.svelte`; sending and rerolling belong to [chat pipeline](chat-pipeline.md).
- The Stop-other button (`foreignStoppable`) shows while the screen's own Stop does not and the chat has a foreign mark
  ([chat pipeline](chat-pipeline.md#state)) or a running feed job of another client (`foreignGeneration`,
  [live updates](live-updates.md#feed-connection)). Its ring takes `chat-process-stage-<n>` from that job's stage, the
  colors of the screen's own ring; a mark alone leaves it uncolored.
- `src/lib/ChatScreens/messageJump.ts` owns `runMessageJump` and `messageJumpWindow`. The screen supplies DOM lookups;
  stored targets resolve their message id again after mounting, and a greeting target reveals the full history and finds
  the row at `-1`. Structured Memory citations, bookmarks, and message search use the same screen jump. The chat column
  width and `metatron` card theme are in `src/styles.css`.
- Screenshot capture uses `src/lib/ChatScreens/screenshotCapture.ts` `prepareScreenshotCapture`; preserve its source
  contract. Follow [asset sources](assets.md#asset-sources) for `withFileSrcFetch` and `SCREENSHOT_CAPTURE_OPTIONS`.

### Composer

- Both composers are textareas in `DefaultChatScreen.svelte`; `createComposer` in
  `src/ts/process/composerDrafts.svelte.ts` owns text/files and `inputTranslation.svelte.ts` owns key routing. A new
  button goes in the composer row; popup behavior follows
  [Dialogs, popovers, and portals](#dialogs-popovers-and-portals).
- `src/lib/ChatScreens/composerPlaceholder.ts` owns the main placeholder. `DefaultChatScreen.svelte` also handles
  incomplete chat bindings, the Stop button's `processStage` ring (the chat's foreign job's stage when it has no own
  staged job, as during a remote send), and the loading label beside Stop while a discovered job's chat loads.
- `src/lib/ChatScreens/RemoteSendMarker.svelte` shows the sender's selected host above the composer and opens the Device
  Link controls ([remote send](network-jobs.md#remote-send)).
- Draft and BTW hooks are available outside the playground. The Draft textarea binds `composer.draft` and stays visible
  while the selected id resolves to a Draft hook or draft text remains. The BTW menu opens
  `src/lib/ChatScreens/InputHookPicker.svelte` when a choice is needed and shows plain-text results in the originating
  chat. Keep busy, Stop, and retry behavior aligned with [input hooks](chat-pipeline.md#input-hooks).
- `src/lib/ChatScreens/HandoffControls.svelte` renders handoff and take-back beside Stop from the screen's followed job
  ids; presence, target selection, and requests belong to [network jobs](network-jobs.md#generation-job-client).

### Transcript rows and the mount hold

- `src/lib/ChatScreens/Chats.svelte`: hand-mounted keyed rows, the mount hold for rows added above the view, reveal,
  containment, trimming, and `whenRendered`. Its header owns the structural-effect and hold rules.

### Transcript scrolling

- A jump caused by rows mounting above the view is the hold in
  [Transcript rows and the mount hold](#transcript-rows-and-the-mount-hold), not this section.
- `Chats.svelte` owns scroll anchors and reply-stream following. `DefaultChatScreen` follows a swiped reroll, while
  `openRoute` asks the screen to reveal the newest message even when its chat was already open
  ([app shell](app-shell.md)).
- Scroll input releases the anchor (`release`), except while an opening still hides its newest row; a sideways wheel is
  not input. An anchor whose row left the DOM falls to `latestAnchor()`.
- A row whose `Chat` is mounted again keeps its height until the new instance has rendered, then its top is put back
  (`keepRowHeight`, `settleRowHeight`). The height comes from a per-row `ResizeObserver` and the offset from scroll
  events: a layout read at the remount sees a row already collapsed and sets off the browser's scroll anchoring. The
  browser's anchoring stays on (no `overflow-anchor` rule) and holds a reader through other growth. Measurements and the
  cases left: [fork chat scroll](../reports/surveys/fork-chat-scroll.md).

### Message row

- `src/lib/ChatScreens/Chat.svelte`: one message row, its theme branches, controls, and display/streaming props.
- `src/lib/ChatScreens/ChatBody.svelte`: sanitized body rendering and parse lifecycle; its component contract owns
  abort, retry, and pending-body behavior. Permanent HTTP asset refusals skip its retries.
- `src/lib/ChatScreens/TransitionImage.svelte`: an image that drops an older `src` resolving late.

### Message editors

- `src/lib/ChatScreens/Chat.svelte` owns original and translation editing, auto-popup eligibility, and `clickToEdit`.
  `src/ts/storage/messageEditorDrafts.svelte.ts` retains original-message and stored-translation drafts across screen or
  row unmounts. It keys text by chat ref, message id, and editor kind, and drops it on owner replacement or deletion.
- `src/lib/ChatScreens/messageEditPopup.ts`: the pure eligibility and stable-height rules.

### Context meter

- `src/lib/ChatScreens/ContextMeter.svelte`: the composer's context line and popover (header), over
  `generationInfo.context` (`shared/contextReport.ts`, [chat pipeline](chat-pipeline.md)); `estimateBasis`,
  `displacement`, `position`, `loreBudgetWarnOff`. Task wording follows `MemoryTaskStatus.kind`; [memory](memory.md)
  owns outcomes and forecasts. The popover's `loreBudgetWarnOff` toggle also turns the chat's lore budget send stop off
  and on ([chat pipeline](chat-pipeline.md#send)).
- The occupied count and percentage are `input` plus the report's `toolSchemas` and `interceptions`, each also a row of
  its own (`contextUsage.toolSchemas`, and `contextUsage.interceptions`, "Inserted prompts (estimated)") sorted among
  the sections. A rule edited since the last reply shows in the meter only after the next one (`estimateBasis` does not
  track the rules).
- The bar, legend, and row dots color by group: fixed (neutral), memory, history. `SPLIT_GROUPS` names the fixed
  sections that grow with the bot: the lorebook, and the character group (description, examples, persona). A group at or
  above `SPLIT_FROM` percent of the prompt budget is drawn apart from the rest of the fixed group in its own color
  (`--color-meter-lore`, `--color-meter-character` in `src/styles.css`, fixed for every theme); a smaller one stays
  neutral. A fixed share over its warning colors the tick and the line under the bar, never a segment.
- The memory segment uses `--color-meter-memory`, defined the same way as the two group colors, so it stays apart from
  history under simulated color blindness.
- The line's memory word is the chat's memory now (`memoryNow`: `chatMemoryAlgorithm` and `chatMemoryEnabled`, as the
  next send resolves them), so a chat with memory set up has a line before its first reply; the last reply's coverage is
  the word only while that memory is still on (`reportedNow`). It warns on a gap, and on memory off with history left
  out unless `memoryTrimAck` holds. The popover's memory block holds the switch (`setChatMemoryEnabled`) and opens the
  memory panel and settings.

### Sidebar

- `src/lib/SideBars/Sidebar.svelte`: the character rail and folders (`RISU_*`, `checkCharOrder`), settings pane, and
  chat status badges. The `memory` badge comes from memory tasks; `health` comes from
  [Structured Memory](structured-memory/read.md#the-health-badge).
- `src/lib/SideBars/chatStatus.ts` owns badge priority and group states; `src/lib/SideBars/SideChatList.svelte` owns the
  chat list, folders, filtering, and actions such as `completeOrder`. A row's own buttons stop their click, so only the
  row itself opens its chat; the options' copy and settings-only copy ([fields](persistence.md#chat-fields)) select the
  new chat without opening it.
- `src/lib/SideBars/PinnedChatsRail.svelte` and `src/lib/SideBars/pinnedChats.ts` share the pinned-chat projection with
  home cards (`openPinnedChat`).
- The sidebar's chat tab switches from `SideChatList` to `src/lib/SideBars/OpenChatPanel.svelte` when
  `selection.chatOpen`. The playground keeps the list. Binding, memory (`src/lib/SideBars/ChatMemoryPanel.svelte`), and
  translation panels work from the open chat's list entry before its messages load. The binding panel's picker receives
  the chat ref ([binding](persistence.md#chat-binding)). The Chat settings dialog reuses the binding and memory panels.
- The author note and `src/lib/SideBars/ChatDraftHookPanel.svelte` wait for the loaded chat. The hook panel writes
  `draftHookId` with `setChatMeta` and keeps a missing choice visible. New-chat defaults, memory choices, and
  translation behavior belong to [persistence](persistence.md), [memory](memory.md), and [translation](translation.md).
- `src/lib/SideBars/DevTool.svelte` owns prompt/lore previews and autopilot; `src/lib/SideBars/Toggles.svelte` owns
  per-chat prompt toggles.

### Dialogs, popovers, and portals

- There is no shared popup/dismissal helper. Follow the nearest pattern: anchored popover (`ContextMeter`), click menu
  (`PopupButton`/`PopupList`), composer menu, or an `App`-mounted panel (`MessageSearch`).
- `src/lib/UI/GUI/Portal.svelte` mounts to `document.body` or a target while keeping caller contexts. `ChatScreen`'s
  `isolate` keeps local content below app popups and alerts; use a portal or `App` mount when the popup must escape that
  stack.
- `src/lib/Others/LoreBudgetStopDialog.svelte` is mounted after the picker lists, one instance per shown request
  (`loreBudgetStopDialog`); its own buttons, Escape, its teardown, and its chat leaving the list answer the request. Its
  navigation buttons reach the sidebar's local views through one-shot stores (`sidebarLeaveDevTool`,
  `loreBookSubmenuRequest`) that the panels take and clear.
- `src/ts/gui/dialogLayers.ts` `topBindingLayer` follows the pickers and dialogs' mount order in `App`; see
  [app shell](app-shell.md#escape-order) for the full Escape order. Components own their z-index classes and local
  dismissal behavior.
- Capture-phase Escape handlers yield to alerts, the terminal notice, and `topBindingLayer()` before the global hotkey
  listener. `ContextMeter` also closes on outside press or focus leaving its trigger/panel, and restores focus when it
  closes.
- `src/lib/UI/PopupButton.svelte` writes `popupStore`; `src/lib/UI/PopupList.svelte` is the fixed-position host mounted
  by `App`.
- `src/lib/Others/RecoveryDrafts.svelte` ([draft recovery](draft-recovery.md#recovery-drafts)),
  `src/lib/Others/ChatCheckpointsDialog.svelte` ([chat store](chat-store.md#chat-checkpoints)),
  `src/lib/Others/MessageSearch.svelte` (search state belongs to [chat pipeline](chat-pipeline.md)).
- `src/lib/Others/OocPanel.svelte`: the selected chat's OOC session, `App`-mounted before `MessageSearch` with its
  lifecycle (open flag in `src/ts/ooc/oocPanel.svelte.ts`). Wide (`lg:`): a right-edge column without a backdrop, the
  chat usable beside it; narrow: the full viewport. Rows render through `ChatBody` with `idx={-1}`, not `Chat.svelte`; a
  streaming answer is parsed as a stored one. Escape closes it only from inside it or the page body. Actions:
  [chat pipeline](chat-pipeline.md#ooc-session).
- `OocPanel`'s header gear opens an anchored settings popover: "use this chat's own OOC toggles" and, while on,
  `OocToggleEditor` over the chat's `oocToggles`. Outside press or Escape inside the popover closes the popover, not the
  panel. Below the header buttons the panel may show the one-time offer to force an OOC toggle on in the preset.
- `src/lib/Others/PopupEditor.svelte`, `src/ts/popupEditorSession.svelte.ts` (`openPopupEditorSession`,
  `closePopupEditorSession`, `popUpEditorStore`), `src/ts/gui/popupEditorMode.ts` (per-device Monaco/textarea).
- HypaV3 modal/progress UI is chat-specific; its data and task fences belong to [memory](memory.md).

### GUI primitives

- `src/lib/UI/GUI/SelectInput.svelte` (`risu-select`), `src/lib/UI/GUI/SliderInput.svelte`,
  `src/lib/UI/GUI/OptionalInput.svelte`, `src/lib/UI/GUI/SegmentedControl.svelte`,
  `src/lib/UI/GUI/TextAreaResizable.svelte`: each one's rules are its header.
- `src/lib/UI/GUI/Alert.svelte`: inline status box (`info`, `warning`, `error`, `success`, `neutral`) with an icon, an
  optional title, body, and an `actions` snippet; its header has the color and `role` rules. Dialogs stay with
  `src/ts/alert.ts`.
- `src/lib/UI/GUI/NumberInput.svelte`: while focused it shows the typed entry, so a binding setter may refuse an empty
  or out-of-range entry without the box snapping back; `change`, blur, or a bound value changed from outside (`seen`)
  shows the bound value again. Adopting an outside value retires the refused draft and advances its comparison baseline,
  so returning to an earlier number cannot revive that draft.
- `src/lib/UI/GUI/CheckInput.svelte` reads an absent value as false without writing through its setter on mount; user
  changes still write and notify once per change.
- `src/lib/UI/GUI/TextAreaInput.svelte`: textarea or CBS-highlighted contenteditable that opens the popup editor
  (`popupEditor`, `popupEditorContext`). A field tied to a selected record passes its id as `popupEditorContext`;
  wrappers that forward it include `RegexList`, `TriggerList`, `PromptDataItem`, `MultiLangInput`, and
  `SettingTextarea`. A row of an index-bound list (`PromptDataItem`, `RegexData`) adds `recordValueIdentity` of its row,
  in an object replaced only when owner or row changes: a remote list replacement then drops the draft.
- `src/lib/UI/GUI/LazyFileSrc.svelte` (object-URL ownership is in [assets](assets.md)) and
  `src/lib/UI/GUI/LazyCharImage.svelte` (256/512 server thumbnails, `thumb`) defer reads until near the viewport.

### Editor token counts

- `CharConfig`, `ChatNoteEditor`, `LoreEntryFields`, prompt settings, `PopupEditor`, `PlaygroundTokenizer`, and
  `ContextMeter` use `createTokenCountField` (`src/ts/tokenCountField.ts`); its header owns scope, debounce, abort, and
  failure behavior. See [LLM](llm-requests.md).

### Other UI

- `src/lib/UI/RefusedDataBanner.svelte`, `src/lib/UI/refusedData.ts`: the save adapter's refusal inventory as a chat
  banner and an app-level pill (`refusedItemsFor`), and Record Export (`refusedRecordExportText`). `App` mounts the
  `app` form beside reload and terminal notices, below alerts.
- `src/lib/Others/RemoteHostScreen.svelte` renders the host lock between plugin containers and app alerts. Leave host
  mode stays reachable above an alert or status overlay. Follow [app shell](app-shell.md#entry-and-screens) for screen
  and drop behavior.
- `util/headlessHost.mjs` reads the lock's `data-remote-host-screen` presence marker, `data-feed-connected`,
  `data-dialogs`, `data-plugins-off`, and each command's `data-command-id`, `data-command-type`, `data-command-state`
  and optional `data-command-code`. Change producer and reader together, including the
  [terminal and reload notices](global-api.md#terminal-and-reload-notices). See
  [headless host](build-test-platforms.md#headless-host).
- `src/lib/Others/GenerationProgressWindow.svelte` reads non-preview jobs from the
  [live feed](live-updates.md#feed-connection) when `ui.generationProgressWindow` is enabled. A row opens its chat
  through `openPinnedChat`. `App` passes `memoryProgressShown` to keep the window below the memory progress overlay.
- `src/lib/Mobile/MobileCharacters.svelte`: the list view of the character grid (`src/lib/Others/GridCatalog.svelte`).
  There is no separate mobile shell; small screens use the desktop layout.

### Theme

- `src/styles.css`: the Tailwind v4 `@theme` tokens map `--color-<name>` to `var(--risu-theme-<name>)`; its comments
  hold the `risu-select`, `.chat-message-container.far`, and `:root` `color-scheme` rules.
- `src/ts/gui/colorscheme.ts`: `updateColorScheme`, `updateTextThemeAndCSS` apply the saved palette and custom text/CSS.
  `src/ts/gui/animation.ts` `updateAnimationSpeed` and `src/ts/gui/guisize.ts` `updateGuisize` apply the other display
  values. Boot calls these together ([app shell](app-shell.md#boot)); `src/ts/gui/displayApply.ts`
  `applyDisplaySettings` runs all four for the writers named under Flows.

## Flows

- Desktop: `App` → `Sidebar` + `ChatScreen` → `DefaultChatScreen` → `Chats` → `Chat` → `ChatBody`.
- First greeting: rendered as a separate `Chat` with `idx: -1`. The chat screen, prompt assembly, the CBS registry,
  triggers (`v2GetFirstMessage`) and regex `repeatBack` read the greeting through `shared/greetings.ts`
  (`greetingIndex`, `greetingText`, `nextGreetingIndex`, `previousGreetingIndex`). Not converted yet:
  `src/ts/characters.ts`, `src/ts/gui/branches.ts` and `src/lib/Others/HypaV3Modal/utils.ts` index `alternateGreetings`
  directly.
- Theme: a remote `ui` record (`watchRemoteRecords`), an applied `ui` recovery draft (`applyRecoveryDraft`), and a
  plugin database write of a `ui` field (`applyPluginKey`) call `applyDisplaySettings`; the display settings and the
  plugin theme APIs call the applier they change. Every color-scheme writer also calls `updateTextThemeAndCSS`, whose
  font colors follow the scheme's `type`.

## State

- Components write settings and character/chat data through their record views; writes queue persistence
  ([persistence](persistence.md)). Chat fields use the chat module or a synced editing copy, never a direct binding.
- `ReloadGUIPointer` signals structural UI changes; `ReloadChatPointer` remounts a row by `reloadChatKey` (message id or
  greeting index), so adding/removing earlier messages does not reset that row's counter. Reassign arrays after in-place
  mutations so Svelte observes them.
- `src/ts/gui/itemFolderFold.svelte.ts` shares per-device module fold state (`isFolderFolded`, `setFolderFolded`)
  between the module catalog and the chat's module menu. Folder membership is server-backed. The persona grid navigates
  into one folder in component state ([characters and modules](characters-modules.md#personas-and-conversion)).
- Theme settings are `theme`, `colorScheme`, `colorSchemeName`, `customColorScheme`, `textTheme`, `customCSS`,
  `textAreaSize`, `sideBarSize`, and `textAreaTextSize`.

## Coupling

- The chat tree depends on `process/index.svelte.ts` (`sendChat`), the local send registry (`localSends.ts`), the chat
  status (`chatStatus.svelte.ts` `isChatBusy`), the parser, `scripts`, the translator, `globalApi` (`changeChatTo`,
  assets, folding), `characters.ts`, and `database.svelte.ts`.
- The sidebar depends on `characters.ts`, `dragTypes.ts`, SortableJS, and the GUI primitives.

## Invariants

- Use theme tokens (see STRUCTURE.md U1). To add a color: a root variable, an `@theme` token, a `ColorScheme` field,
  `updateColorScheme`, and presets. The shade ramps (`primary`, `secondary`, `danger`, `success`, `warning`, `neutral`)
  are fixed for every theme: only a root variable and an `@theme` token per shade.
- A title never differs from the text under it by weight alone: `--risu-font-family` can be the user's `customFont`,
  which may render no visible bold. Pair `font-semibold` with a size step or a muted color on the secondary text, as the
  Read view of `TimelineTab.svelte` does.
- Message identity: `Chats` keys a row by the chat and `chatId` (a message without one by its index); see
  `updateChatBody` and the per-row effect for remount conditions. Never read every row's text in the structural effect;
  per-chunk transcript JavaScript work must not grow with mounted row count.
- `Chat.updateRow` changes only supplied position/streaming fields, `isComment`, `messageGenerationInfo`,
  `candidateCount`, `candidateIndex`, `candidateCarrier`, `rerollIcon`, or display-only `name` and `img` props;
  name/image updates never reset the `ChatBody` key.
- Chat structure operations go through the [chat module](chat-store.md#chat-writes) (`createChat`, `deleteChat`,
  `reorderChats`, `setChatMeta` for `folderId`) and [select](chat-store.md#selection) with `changeChatTo`/`selectChat`;
  `chatPage` is derived from the per-tab selected chat id and is never assigned.
- Components never `bind:` a chat field directly: bind a getter/setter pair that calls the module, or a synced editing
  copy.
- A locked message (`isMessageLocked`: generating, or its final write not yet acknowledged) has its edit, delete, and
  regenerate controls disabled; reroll and chat deletion alert `chatGenerating` while the chat holds a lock.
- `Chat.svelte` `isInteractiveBodyTarget` excludes an entire `form[risu-form]` from click-to-edit, but plain form text
  still opens message editing when `clickToEdit` is enabled; preserve that distinction when changing the selector.
- HTML boundaries:
  - `ChatBody` sanitizes body HTML through `shownBody` and renders the fixed `LOADING_HTML` literal while translation
    loads; `BackgroundDom` and suggestions render sanitized parser output. Plugin panels render HTML sanitized with
    DOMPurify by `setChatPanel` in `src/ts/plugins/apiV3/v3.svelte.ts`; a `style` element in it needs the plugin's
    `globalStyle` grant ([permission list](plugin-sandbox.md#permission-list)).
  - Custom GUI rendering uses `risuChatParser` with `renderMode: "gui"` to escape character/nickname, `bot`, and persona
    name substitutions before parsing the owner's template; ordinary prompt CBS keeps raw names. `renderGuiHtmlPart`
    whitelists tags and allows only `https` links.
  - Custom CSS is injected via `CustomCSSStore` and must stay disabled in `SafeModeStore`; so must the `customHTML`
    theme's GUI HTML (`Chat.svelte` renders the classic row instead).
- For new lists that can change while an input has focus, key rows by entry and bind through guarded getter/setters;
  never bind `list[i]` in an unkeyed `#each`. Chrome fires `change` on a focused, edited control while removing it, and
  an index binding then resolves the new row at that index. Existing `CharConfig` and `ModuleMenu` index-addressed name
  rows release focus on owner or outside row replacement; `LoreBookList` guards keyed rows by live-list membership. See
  [characters and modules](characters-modules.md#lorebook-rows-and-writers).
- Runes and legacy stores are mixed: `$state`/`$derived`/`$props`/`$bindable`/snippets alongside `writable` stores,
  `.subscribe`, `createEventDispatcher`, and `on:save`. Match the local component.
- Primitive prop convention: an `interface Props`, destructured with `$props()`, `$bindable()` for mutable values,
  callback props (`onclick`, `onchange`), and `children: Snippet`.

## Recipes

- Change message rendering: `DefaultChatScreen` props → `Chats.updateChatBody` (row key, mount key, and `Chat.updateRow`
  fields) → `Chat`/`ChatBody`. Verify streaming, reroll, the first greeting, and custom HTML manually.
- Add a sidebar chat operation: `SideChatList.svelte`, plus `Chat` in `shared/database.ts` if the shape changes. Write
  through the chat module, open a chat with `changeChatTo` (or only select it with `selectChat`), and bump
  `ReloadGUIPointer` where the operation needs a structural refresh. Cross-character pins use `openPinnedChat`,
  selecting the chat before the character.
- Add a form primitive: follow the prop convention in `src/lib/UI/GUI/` and add cases to `guiRendering.test.ts`.
- Add a popup or portal: a store in `stores.svelte.ts`, then the trigger and host, by
  [the rules](#dialogs-popovers-and-portals). Clean up mounts and listeners.

## Tests

- Focused:
  `pnpm --silent test:agent src/lib/ChatScreens src/lib/SideBars src/lib/UI src/lib/Others src/lib/Mobile src/ts/gui`,
  plus `src/ts/{tokenCountField,messageSearch,chatLoadPages,screenshotCaptureCache,stores.popupEditorSession}.test.ts`
  for the logic outside those folders.
- `slow`: none in this guide's paths.
- `e2e` for the chat screen: `e2e/serverTransform.spec.ts` (row render lifecycle: final render once, existing rows
  untouched, an open details stays open), `e2e/chatBinding.spec.ts` (incomplete-binding mark, composer placeholder and
  readonly state, setup dialog), `e2e/openChat.spec.ts` (closed chat), `e2e/perChatSends.spec.ts` (per-chat Stop, auto
  mode), `e2e/refusedData.spec.ts` (refused chat badge and banner export).
- `e2e` for the sidebar and settings: `e2e/personaBinding.spec.ts` (binding panel and Chat Settings dialog),
  `e2e/readersCharacters.spec.ts` (sidebar folder menu stays addressed while the order changes),
  `e2e/welcomeAndChatSettings.spec.ts` (catalog and home icons, chat screen settings).
- `installFlatDatabase.ts` ([persistence](persistence.md#tests)) gives most component tests their records.
- `Chats.rows.svelte.test.ts` stands in for `IntersectionObserver` with its own `Observer` class and fakes
  `requestAnimationFrame`; its anchor cases stand in for `ResizeObserver` and report the rows' sizes (`sizes`), and end
  an opening's reveal (`endReveal`) before the reader's input.
- `ContextMeter.svelte.test.ts` stubs the chip's rectangle (happy-dom has no layout) and the count route: each count is
  one request the test answers when it chooses, so fake timers and deferred answers drive the debounce and the races.
- `OocPanel.test.ts` mocks the OOC module and stands in for `ChatBody` with `tests/OocChatBodyStub.svelte`; the panel's
  wide and narrow layout and a real streamed answer's display scripts need a browser check.
- `ChatBody.svelte.test.ts` mocks `ParseMarkdown` as deferred parses (`hoisted.parses`) the test settles by text.
- `DefaultChatScreen.drafts.test.ts` mounts the screen with its children mocked; `tests/ChatsStub.svelte` stands in for
  `Chats` (`followsLatest`, `scrollToLatestMessage`, bindable `holding`, the props it got) for the notification reveal,
  swiped-reroll alignment, and the held load-more skip. `DefaultChatScreen.foreignProgress.test.ts` mounts it the same
  way for the Stop-other ring of a feed job.
- `GenerationProgressWindow.test.ts` drives the window from the real progress store with fake `Date` and intervals, and
  mocks `openPinnedChat` at the module boundary.
- `screenshotExport.test.ts` fakes canvases (happy-dom has no 2D context), counting sizes, draws, and releases.
- `src/lib/UI/tests/`: `reactiveProps.svelte.ts` changes a mounted component's props from a `.test.ts` file;
  `LazyCharImageFixture.svelte` awaits the image as real consumers do. `ChatStyleProviderFixture.svelte`
  (`src/lib/ChatScreens/tests/`) provides the `ChatStyleRegistry` the chat screen would.
- Browser scripts: `util/playwright/measureChats.mjs` checks production row counts, memory, and streaming cost;
  `util/playwright/checkSidebarChatStatus.mjs` covers the status badges;
  `docs/reports/surveys/fork-chat-scroll/probeChatScroll.mjs` prints the reader's position through openings, chat writes
  and streams (no assertions; happy-dom has no layout, so this is the check for a scroll change).
- Not tested: the search-to-transcript claim and scroll wiring, sidebar composition, mobile interactions, and a failed
  screenshot's restore need a browser check. The mounted `DefaultChatScreen.svelte` bookmark path through
  `scrollToMessageId` is also untested; `messageJump.test.ts` drives only the pure helper.
- Not tested automatically: lost-follow recovery. Switch away from a running chat, stop the server until reattach
  attempts fail, confirm its recovery badges, then restart the server and reopen the chat.
- `Chat.draft.test.ts` and `Chat.test.ts` cover an open editor's text across a row remount and an outside change of the
  stored value. Not tested: the round trip through `App.svelte`'s Settings branch, which destroys the chat screen.

## Known Hazards

### Limitations

- Growth inside rows shown above the view during a scroll animation moves the reader by the grown height (reversed
  scroller): images swapped in late by `checkImg` (`.root-loaded-image` reserves no height), lazy images, a row
  re-rendering (CBS, translation, a reload pointer), and a far row whose `contain-intrinsic-block-size` estimate differs
  from its rendered height. A fix would restore a reader anchor (the visible row nearest the view's top and its offset)
  at `scrollend`, not mid-animation, once the hold releases. Decision: owner deferred anchor restoration in commit
  `0aad24ce5`.
- A reader's place can still move in these cases: a chat write that returns every message without its id is taken for an
  opening (the reader goes to the newest message's start); a row that changes size in the same window as another row's
  remount gets a partial correction; a scroll written by other code in the task of a remount skips its correction.
  Decision: left by the scroll fixes of 2026-11-18, [report](../reports/surveys/fork-chat-scroll.md#10-fixes).
- A far row's fixed-position or overflowing custom content is contained while it is far. Near rows are deliberately
  uncontained; do not apply `content-visibility` to every row or to the transcript ancestor. Decision: `src/styles.css`,
  `.chat-message-container.far`.
- `src/lib/Others/PopupEditor.svelte` keeps only the text across its Monaco toggle: the textarea or the Monaco model is
  recreated, so selection and undo history are lost. One model across the switch is a larger editor-lifetime change.
  Observed by the
  [cross-plan review](../reports/audits/finished-plans/cross-plan-2026-10-29.md#noted-not-recommended-to-fix). Decision:
  text-only toggle contract kept, commit `634bc14c7`.
- Pixel anchoring across far and near row toggles was checked only by a manual Chrome script, with no kept test, and the
  chat list was never driven in Firefox or Safari (far-row containment, anchoring, the newest-first reveal). A client
  JSON chat import remounts the list once, and the `checkIfAtBottom` layout read (`Chats.svelte`) remains. Decision:
  chat rendering perf series and slice 3f (2026-10-14, 2026-10-16), Audit Findings and Performance Leftovers,
  [archive](../archived-plan/README.md); Found Issues Clearance (owner, 2026-11-09).
- Older rows do not rerender merely because the chat length changes. Length-dependent CBS updates when that row next
  renders (edit, reload, remount, etc.). Decision: `docs/reports/surveys/risunest-ideas.md`.
- Screenshot export's renderer peak grows with row count despite bounded pages: html-to-image creates per-row clone,
  SVG, and decoded-image garbage that the browser reclaims lazily. Per-page releases do not bound this peak; reducing
  copied custom properties needs pixel comparisons. Decision: measured miss recorded 2026-11-09
  ([audit](../reports/measurements/client/screenshot-memory-2026-11-09.md)).

### Gotchas

- The avatar variant of `ChatStatusBadge.svelte` uses `pointer-events-none`, so a badge-level `title` cannot supply
  hover text; `Sidebar.svelte` adds status to the avatar name and `PinnedChatsRail.svelte` puts it in the row's `title`.
- `ContextMeter.svelte`'s `estimate` counts displaced old history; for an ordinary next send with nonempty user and
  reply messages, the next report's kept message count is the previous kept count + 2 minus that displacement, because
  `DefaultChatScreen.svelte` sends a new user message and the previous reply joins history.
- `src/lib/ChatScreens/Message.svelte` is an unused TODO rewrite; `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` is
  empty. Confirm intent before extending either.
- `LazyPortal` has no active callers found.
- A transcript scroll-animation jump reproduces with real wheel input; CDP-dispatched wheel events do not animate.
