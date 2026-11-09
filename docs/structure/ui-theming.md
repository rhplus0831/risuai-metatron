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
- `src/lib/ChatScreens/messageJump.ts` `runMessageJump` and `messageJumpWindow`: jump decisions, testable without the
  screen. The chat column width and `metatron` card theme are in `src/styles.css`.

### Composer

- Both composers are textareas in `DefaultChatScreen.svelte`; `createComposer` in
  `src/ts/process/composerDrafts.svelte.ts` owns text/files and `inputTranslation.svelte.ts` owns key routing. A new
  button goes in the composer row; popup behavior follows
  [Dialogs, popovers, and portals](#dialogs-popovers-and-portals).
- `src/lib/ChatScreens/composerPlaceholder.ts` owns the main placeholder. `DefaultChatScreen.svelte` also handles
  incomplete chat bindings and the Stop button's `processStage` ring.

### Transcript rows and the mount hold

- `src/lib/ChatScreens/Chats.svelte`: hand-mounted keyed rows, the mount hold for rows added above the view, reveal,
  containment, trimming, and `whenRendered`. Its header owns the structural-effect and hold rules.

### Transcript scrolling

- A jump caused by rows mounting above the view is the hold in
  [Transcript rows and the mount hold](#transcript-rows-and-the-mount-hold), not this section.
- `Chats.svelte` owns scroll anchors and reply-stream following. `DefaultChatScreen` follows a swiped reroll, while
  `openRoute` asks the screen to reveal the newest message even when its chat was already open
  ([app shell](app-shell.md)).

### Message row

- `src/lib/ChatScreens/Chat.svelte`: one message row, its theme branches, controls, and display/streaming props.
- `src/lib/ChatScreens/ChatBody.svelte`: sanitized body rendering and parse lifecycle; its component contract owns
  abort, retry, and pending-body behavior.
- `src/lib/ChatScreens/TransitionImage.svelte`: an image that drops an older `src` resolving late.

### Message editors

- `src/lib/ChatScreens/Chat.svelte`: original/translation editing, auto-popup eligibility, and `clickToEdit`.
- `src/lib/ChatScreens/messageEditPopup.ts`: the pure eligibility and stable-height rules.

### Context meter

- `src/lib/ChatScreens/ContextMeter.svelte`: the composer's context line and popover (header), over
  `generationInfo.context` (`shared/contextReport.ts`, [chat pipeline](chat-pipeline.md)); `estimateBasis`,
  `displacement`, `position`, `loreBudgetWarnOff`. Task wording follows `MemoryTaskStatus.kind`; [memory](memory.md)
  owns outcomes and forecasts.

### Sidebar

- `src/lib/SideBars/Sidebar.svelte`: the character rail and folders (`RISU_*`, `checkCharOrder`), settings pane, and
  chat status badges. The `memory` badge comes from memory tasks; `health` comes from
  [Structured Memory](structured-memory/read.md#the-health-badge).
- `src/lib/SideBars/chatStatus.ts` owns badge priority and group states; `src/lib/SideBars/SideChatList.svelte` owns the
  chat list, folders, filtering, and actions such as `completeOrder`.
- `src/lib/SideBars/PinnedChatsRail.svelte` and `src/lib/SideBars/pinnedChats.ts` share the pinned-chat projection with
  home cards (`openPinnedChat`).
- `src/lib/SideBars/OpenChatPanel.svelte`: the open chat's tab. New-chat defaults and translation behavior are
  documented in [persistence](persistence.md) and [translation](translation.md).
- `src/lib/SideBars/DevTool.svelte` owns prompt/lore previews and autopilot; `src/lib/SideBars/Toggles.svelte` owns
  per-chat prompt toggles.

### Dialogs, popovers, and portals

- There is no shared popup/dismissal helper. Follow the nearest pattern: anchored popover (`ContextMeter`), click menu
  (`PopupButton`/`PopupList`), composer menu, or an `App`-mounted panel (`MessageSearch`).
- `src/lib/UI/GUI/Portal.svelte` mounts to `document.body` or a target while keeping caller contexts. `ChatScreen`'s
  `isolate` keeps local content below app popups and alerts; use a portal or `App` mount when the popup must escape that
  stack.
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
- `src/lib/Others/PopupEditor.svelte`, `src/ts/popupEditorSession.svelte.ts` (`openPopupEditorSession`,
  `closePopupEditorSession`, `popUpEditorStore`), `src/ts/gui/popupEditorMode.ts` (per-device Monaco/textarea).
- HypaV3 modal/progress UI is chat-specific; its data and task fences belong to [memory](memory.md).

### GUI primitives

- `src/lib/UI/GUI/SelectInput.svelte` (`risu-select`), `src/lib/UI/GUI/SliderInput.svelte`,
  `src/lib/UI/GUI/OptionalInput.svelte`, `src/lib/UI/GUI/SegmentedControl.svelte`,
  `src/lib/UI/GUI/TextAreaResizable.svelte`: each one's rules are its header.
- `src/lib/UI/GUI/TextAreaInput.svelte`: textarea or CBS-highlighted contenteditable that opens the popup editor
  (`popupEditor`, `popupEditorContext`). A field tied to a selected record passes its id as `popupEditorContext`;
  wrappers that forward it include `RegexList`, `TriggerList`, `PromptDataItem`, `MultiLangInput`, and
  `SettingTextarea`.
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
- Theme settings are `theme`, `colorScheme`, `colorSchemeName`, `customColorScheme`, `textTheme`, `customCSS`,
  `textAreaSize`, `sideBarSize`, and `textAreaTextSize`.

## Coupling

- The chat tree depends on `process/index.svelte.ts` (`sendChat`), the local send registry (`localSends.ts`), the chat
  status (`chatStatus.svelte.ts` `isChatBusy`), the parser, `scripts`, the translator, `globalApi` (`changeChatTo`,
  assets, folding), `characters.ts`, and `database.svelte.ts`.
- The sidebar depends on `characters.ts`, `dragTypes.ts`, SortableJS, and the GUI primitives.

## Invariants

- Use theme tokens (see STRUCTURE.md U1). To add a color: a root variable, an `@theme` token, a `ColorScheme` field,
  `updateColorScheme`, and presets.
- Message identity: `Chats` keys a row by the chat and `chatId` (a message without one by its index); see
  `updateChatBody` and the per-row effect for remount conditions. Never read every row's text in the structural effect;
  per-chunk transcript JavaScript work must not grow with mounted row count.
- `Chat.updateRow` changes only supplied position/streaming fields, `isComment`, or display-only `name` and `img` props;
  name/image updates never reset the `ChatBody` key.
- Chat structure operations go through the [chat module](chat-store.md#chat-writes) (`createChat`, `deleteChat`,
  `reorderChats`, `setChatMeta` for `folderId`) and [select](chat-store.md#selection) with `changeChatTo`/`selectChat`;
  `chatPage` is derived from the per-tab selected chat id and is never assigned.
- Components never `bind:` a chat field directly: bind a getter/setter pair that calls the module, or a synced editing
  copy.
- A locked message (`isMessageLocked`: generating, or its final write not yet acknowledged) has its edit, delete, and
  regenerate controls disabled; reroll and chat deletion alert `chatGenerating` while the chat holds a lock.
- HTML boundaries:
  - `ChatBody`, `BackgroundDom`, suggestions, and plugin panels use `{@html}` only on sanitized parser output.
  - `renderGuiHtmlPart` whitelists tags and allows only `https` links.
  - Custom CSS is injected via `CustomCSSStore` and must stay disabled in `SafeModeStore`; so must the `customHTML`
    theme's GUI HTML (`Chat.svelte` renders the classic row instead).
- For new lists that can change while an input has focus, key rows by entry and bind through guarded getter/setters;
  never bind `list[i]` in an unkeyed `#each`. Chrome fires `change` on a focused, edited control while removing it, and
  an index binding then resolves the new row at that index. Existing exceptions: `LoreBookList` keys entry wrappers,
  with a remote-replacement limitation, while `CharConfig.svelte` emotion and additional-asset tables remain unkeyed and
  use index-checked rename helpers. See [characters and modules](characters-modules.md#lorebook-rows-and-writers).
- Runes and legacy stores are mixed: `$state`/`$derived`/`$props`/`$bindable`/snippets alongside `writable` stores,
  `.subscribe`, `createEventDispatcher`, and `on:save`. Match the local component.
- Primitive prop convention: an `interface Props`, destructured with `$props()`, `$bindable()` for mutable values,
  callback props (`onclick`, `onchange`), and `children: Snippet`.

## Recipes

- Change message rendering: `DefaultChatScreen` props → `Chats.updateChatBody` (row key, mount key, and `Chat.updateRow`
  fields) → `Chat`/`ChatBody`. Verify streaming, reroll, the first greeting, and custom HTML manually.
- Add a sidebar chat operation: `SideChatList.svelte`, plus `Chat` in `shared/database.ts` if the shape changes. Write
  through the chat module, open a chat with `changeChatTo` (or only select it with `selectChat`), and bump
  `ReloadGUIPointer`. Cross-character pins use `openPinnedChat`, selecting the chat before the character.
- Add a form primitive: follow the prop convention in `src/lib/UI/GUI/` and add cases to `guiRendering.test.ts`.
- Add a popup or portal: a store in `stores.svelte.ts`, then the trigger and host, by
  [the rules](#dialogs-popovers-and-portals). Clean up mounts and listeners.

## Tests

- Focused: `pnpm --silent test:agent src/lib/ChatScreens src/lib/SideBars src/lib/UI src/lib/Others src/ts/gui`, plus
  `src/ts/{tokenCountField,messageSearch,chatLoadPages,screenshotCaptureCache,stores.popupEditorSession}.test.ts` for
  the logic outside those folders.
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
  `requestAnimationFrame`.
- `ContextMeter.svelte.test.ts` stubs the chip's rectangle (happy-dom has no layout) and the count route: each count is
  one request the test answers when it chooses, so fake timers and deferred answers drive the debounce and the races.
- `ChatBody.svelte.test.ts` mocks `ParseMarkdown` as deferred parses (`hoisted.parses`) the test settles by text.
- `screenshotExport.test.ts` fakes canvases (happy-dom has no 2D context), counting sizes, draws, and releases.
- `src/lib/UI/tests/`: `reactiveProps.svelte.ts` changes a mounted component's props from a `.test.ts` file;
  `LazyCharImageFixture.svelte` awaits the image as real consumers do. `ChatStyleProviderFixture.svelte`
  (`src/lib/ChatScreens/tests/`) provides the `ChatStyleRegistry` the chat screen would.
- Browser scripts: `util/playwright/measureChats.mjs` checks production row counts, memory, and streaming cost;
  `util/playwright/checkSidebarChatStatus.mjs` covers the status badges.
- Not tested: the search-to-transcript claim and scroll wiring, sidebar composition, mobile interactions, and a failed
  screenshot's restore need a browser check.
- Not tested automatically: lost-follow recovery. Switch away from a running chat, stop the server until reattach
  attempts fail, confirm its recovery badges, then restart the server and reopen the chat.

## Known Hazards

### Issues

- Unconfirmed: `popupEditorContext` distinguishes an owner, not a repeated row within it. Prompt-template
  (`src/lib/UI/PromptDataItem.svelte`) and regex (`src/lib/SideBars/Scripts/RegexData.svelte`) rows pass the
  preset/character id, so if another client reorders same-text rows while a popup is open, its draft may write to the
  row now at that index. See [settings](settings-i18n.md) and [scripts/triggers](scripts-triggers.md).

### Limitations

- Growth inside rows shown above the view during a scroll animation moves the reader by the grown height (reversed
  scroller): images swapped in late by `checkImg` (`.root-loaded-image` reserves no height), lazy images, a row
  re-rendering (CBS, translation, a reload pointer), and a far row whose `contain-intrinsic-block-size` estimate differs
  from its rendered height. A fix would restore a reader anchor (the visible row nearest the view's top and its offset)
  at `scrollend`, not mid-animation, once the hold releases. Decision: owner deferred anchor restoration in commit
  `0aad24ce5`.
- A far row's fixed-position or overflowing custom content is contained while it is far. Near rows are deliberately
  uncontained; do not apply `content-visibility` to every row or to the transcript ancestor. Decision: `src/styles.css`,
  `.chat-message-container.far`.
- `src/lib/Others/PopupEditor.svelte` keeps only the text across its Monaco toggle: the textarea or the Monaco model is
  recreated, so selection and undo history are lost. One model across the switch is a larger editor-lifetime change.
  Observed by the [cross-plan review](../manual-audit/archive/cross-plan-2026-10-29.md#noted-not-recommended-to-fix).
  Decision: text-only toggle contract kept, commit `634bc14c7`.
- Older rows do not rerender merely because the chat length changes. Length-dependent CBS updates when that row next
  renders (edit, reload, remount, etc.). Decision: `docs/research/risunest-ideas.md`.
- The screenshot export's renderer peak grows with the row count (about 1.4 GiB at 150 fixture rows, 3.3–3.9 GiB at 600)
  although each page stays under `MAX_EXPORT_PIXELS`: html-to-image's per-row clone (every computed property, custom
  ones included, inlined on every element), its SVG data URL, and the decoded image are garbage the browser reclaims
  lazily, and nothing holds them, so no per-page release bounds the peak. Copying fewer custom properties halves it but
  changed pixels in the tried variants. Decision: measured miss recorded 2026-11-09
  ([audit](../audit/screenshot-memory-2026-11.md)).

### Gotchas

- `src/lib/ChatScreens/Message.svelte` is an unused TODO rewrite; `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` is
  empty. Confirm intent before extending either.
- `LazyPortal` has no active callers found.
- A transcript scroll-animation jump reproduces with real wheel input; CDP-dispatched wheel events do not animate.
