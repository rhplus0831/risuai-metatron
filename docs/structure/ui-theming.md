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

- `src/lib/ChatScreens/ChatScreen.svelte`: the layout around the chat (`waifu` or classic) and the custom background.
  Its `isolate` keeps local content below app popups (see [portals](#dialogs-popovers-and-portals)).
- `src/lib/ChatScreens/DefaultChatScreen.svelte`: the composers, send/reroll ([chat pipeline](chat-pipeline.md)), and
  menus; chooses home, playground, `src/lib/ChatScreens/ClosedChatScreen.svelte` (`selection.chatOpen` false), or the
  chat. It owns the row window (`loadPages`, `onTrim`) and binds `Chats.revealing`/`Chats.holding` (`revealing`,
  `rowsHeld`). Screenshot: `screenShot` over `src/lib/ChatScreens/screenshotExport.ts`. Message jumps: `pendingBookmark`
  (`ScrollToMessageStore`), the search claim, `scrollToMessageId`.
- `src/lib/ChatScreens/messageJump.ts`: the jump's decisions (`runMessageJump`, `messageJumpWindow`), testable without
  the screen.
- The chat column: the scroller publishes `settings.ui.chatScreenWidth` (Display, default 900) as `--chat-screen-width`;
  the transcript (`Chats`), the first greeting (`.default-chat-screen > .risu-chat`), the composer, and the rows around
  them carry `chat-screen-content-width` (`src/styles.css`). New scroller rows get the class too; the composer menu sits
  in the composer row to follow the column.
- The `metatron` theme adds `metatron-chat-theme` to the scroller; `src/styles.css` styles each `.risu-chat` as a card
  under it; other non-`waifu` themes keep the classic layout.

### Composer

- Both composers are `<textarea>`s in `src/lib/ChatScreens/DefaultChatScreen.svelte`, not components: the main composer
  (`composer.input`) in the composer row, and the translation composer (`composer.translate`, `#messageInputTranslate`)
  under it while `useAutoTranslateInput` is on outside the playground.
- Their text and files come from `createComposer` (`src/ts/process/composerDrafts.svelte.ts`), their keys from
  `src/ts/process/inputTranslation.svelte.ts`. A new composer button goes in the composer row beside the `openMenu`
  button; a popup from it follows [Dialogs, popovers, and portals](#dialogs-popovers-and-portals).
- In `DefaultChatScreen.svelte`: the incomplete binding's read-only composers (`bindingIncomplete`) and the Stop
  button's stage ring (`processStage`, `chat-process-stage-0`–`4`, from `chatStageOf` in `src/ts/process/jobStages.ts`,
  with `.autoload` in auto mode).
- `src/lib/ChatScreens/composerPlaceholder.ts`: the main composer's placeholder (`composerPlaceholder`).

### Transcript rows and the mount hold

- `src/lib/ChatScreens/Chats.svelte`: the transcript, rows mounted by hand and keyed by chat and `Message.chatId`
  (header). Staging and reveal: `armDeferredRows`, `startReveal`, `waitForViewImages`. The mount hold, which every new
  path that adds rows above the shown ones goes through: `holdRow`, `heldRows` (`chat-row-held`), `scrollGate`,
  `scheduleRelease`, `readerScrolling`. Containment: `observer`. Trimming: `trimWindow` with `CHAT_ROW_CAP`
  (`shared/chatLoadPages.ts`). `whenRendered` settles every row for jumps and screenshots.

### Transcript scrolling

- A jump caused by rows mounting above the view is the hold in
  [Transcript rows and the mount hold](#transcript-rows-and-the-mount-hold), not this section.
- `src/lib/ChatScreens/Chats.svelte`: the scroll anchor (`ScrollAnchor`, `start`, `end`, or none) and what releases it;
  reply anchoring by `autoScrollToNewMessage`, `isMessageStreamed`, `scrollToReplyStartAfterStreaming`, `followsLatest`,
  `latestAnchor`, `tailStreamed`; `scrollToLatestMessage`.
- `DefaultChatScreen` anchors a followed swiped reroll (`followsSwap`). `openRoute` (a notification) sets
  `ShowLatestMessageStore`, and the screen then shows the newest start even for a chat that was already open.

### Message row

- `src/lib/ChatScreens/Chat.svelte`: one message (header: theme branches, `renderGuiHtmlPart`, the row's own `chatRef`,
  branching with `createFolderOnBranch`). Props `messageId`, `streamingOverride`, `pendingReveal`, `isLastMemory`;
  `isEditing` (the trim guard), `whenRendered`, `chatBodyRevision`, `updateRow`, the memory limit line
  (`memoryBoundary`).
- `src/lib/ChatScreens/ChatBody.svelte`: the body (`markParsing`, `{@html}`, `lastParsed`, `parseRun`, `whenRendered`);
  its contract holds the run's abort (`parseController`), the failure retries, and the pending body
  (`prepareShownBody`).
- `src/lib/ChatScreens/TransitionImage.svelte`: an image that drops an older `src` resolving late.

### Message editors

- `src/lib/ChatScreens/Chat.svelte`: the original and translation editors (`draft`, `openAutoPopupMessageEditor`,
  `openAutoPopupTranslationEditor`, `settings.ui.disableAutoPopupMessageEditor`, `edit()`, `saveTranslationEdit()`) and
  `clickToEdit` (`isInteractiveBodyTarget`).
- `src/lib/ChatScreens/messageEditPopup.ts`: the pure eligibility and stable-height rules.

### Context meter

- `src/lib/ChatScreens/ContextMeter.svelte`: the composer's context line and popover (header), over
  `generationInfo.context` (`shared/contextReport.ts`, [chat pipeline](chat-pipeline.md)); `estimateBasis`,
  `displacement`, `position`, `loreBudgetWarnOff`. Task wording follows `MemoryTaskStatus.kind`; [memory](memory.md)
  owns outcomes and forecasts.

### Sidebar

- `src/lib/SideBars/Sidebar.svelte`: the character rail and folders (`characterOrder`, `RISU_*` MIME types,
  `checkCharOrder`) and the settings pane (`SideChatList` | `OpenChatPanel` | `CharConfig` | `DevTool`); the
  `--sidebar-gutter` rule for self-scrolling children. Status badges: `statusSets`, `characterStatuses`,
  `pinnedStatuses`, `memoryCountOf`. The `memory` badge and its count come from memory tasks (`summarizingChats`,
  `src/ts/process/memoryTasks.svelte.ts`); the `health` badge from Structured Memory (`memoryHealthStates()`,
  [the health badge](structured-memory/read.md#the-health-badge)).
- `src/lib/SideBars/chatStatus.ts`: badge priority (`CHAT_STATUS_PRIORITY`), `refusedChatKeys`, `folderStatus`,
  `groupHealthState`, `groupMemoryCount`.
- `src/lib/SideBars/SideChatList.svelte`: the chat list, folders, and chat actions (`chatEntry`, `changeChatTo`,
  `importChat`, `chatFolderOf`, `completeOrder`, the Korean-aware filter with `matchesAny`).
- `src/lib/SideBars/PinnedChatsRail.svelte`, `src/lib/SideBars/pinnedChats.ts`: the pinned-chat projection shared with
  the home cards (`collectPinnedChats`, `openPinnedChat`).
- `src/lib/SideBars/OpenChatPanel.svelte`: the open chat's tab. New-chat defaults and translation behavior are
  documented in [persistence](persistence.md) and [translation](translation.md).
- `src/lib/SideBars/DevTool.svelte`: prompt and lorebook previews (`previewChat`) and the autopilot.
- `src/lib/SideBars/Toggles.svelte`: per-chat prompt toggles (`resolveGlobalChatVar`, `setChatToggle`).

### Dialogs, popovers, and portals

- There is no shared popup/dismissal helper. Follow the nearest pattern: anchored popover (`ContextMeter`), click menu
  (`PopupButton`/`PopupList`), composer menu, or an `App`-mounted panel (`MessageSearch`).
- `src/lib/UI/GUI/Portal.svelte` mounts to `document.body` or a target while keeping caller contexts. `ChatScreen`'s
  `isolate` keeps local content below app popups and alerts; use a portal or `App` mount when the popup must escape that
  stack.
- Layering uses z-index and DOM order: context meter/search/bookmarks/composer menu at 30, binding/checkpoint dialogs at
  40, recovery drafts at 45, alerts/editors/popup lists at 50, reload notice at 60. `topBindingLayer` follows `App`'s
  dialog/picker order. See [app shell](app-shell.md#escape-order) for the full Escape order.
- Capture-phase Escape handlers ignore IME composition (`isComposing` and key code 229), yield to alerts, terminal
  notice, and `topBindingLayer()`, then stop propagation before the global hotkey listener. The context meter also
  closes on outside press or focus leaving its trigger/panel; Escape and its Close button return focus to the trigger.
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

- `CharConfig`, `ChatNoteEditor`, `LoreEntryFields`, `PromptSettings`, `PromptPresetSettings` (the legacy prompt
  fields), `PopupEditor`, and `PlaygroundTokenizer` count with `createTokenCountField` (`src/ts/tokenCountField.ts`,
  header: scope, debounce, abort, failure), as does the `ContextMeter` estimate; see [LLM](llm-requests.md).
- Each consumer's `same` (`tokenCountInput` or `tokenScopeKey`) decides what is unchanged: expanded fields compare the
  expanded text and scope, `ChatNoteEditor` the raw text and scope, `PopupEditor` reuses its expanded preview, and the
  playground names its tokenizer. The meter clears its estimate on failure instead of keeping the last value.

### Other UI

- `src/lib/UI/RefusedDataBanner.svelte`, `src/lib/UI/refusedData.ts`: the save adapter's refusal inventory as a chat
  banner and an app-level pill (`refusedItemsFor`), and Record Export (`refusedRecordExportText`). `App` mounts the
  `app` form beside reload and terminal notices, below alerts.
- `src/lib/Mobile/MobileCharacters.svelte`: the list view of the character grid (`src/lib/Others/GridCatalog.svelte`).
  There is no separate mobile shell; small screens use the desktop layout.

### Theme

- `src/styles.css`: the Tailwind v4 `@theme` tokens map `--color-<name>` to `var(--risu-theme-<name>)`; its comments
  hold the `risu-select`, `.chat-message-container.far`, and `:root` `color-scheme` rules.
- `src/ts/gui/colorscheme.ts`: `updateColorScheme` applies the stored scheme ([Flows](#flows)).

## Flows

- Desktop: `App` → `Sidebar` + `ChatScreen` → `DefaultChatScreen` → `Chats` → `Chat` → `ChatBody`.
- First greeting: rendered as a separate `Chat` with `idx: -1`. The chat screen, prompt assembly, the CBS registry,
  triggers (`v2GetFirstMessage`) and regex `repeatBack` read the greeting through `shared/greetings.ts`
  (`greetingIndex`, `greetingText`, `nextGreetingIndex`, `previousGreetingIndex`). Not converted yet:
  `src/ts/characters.ts`, `src/ts/gui/branches.ts` and `src/lib/Others/HypaV3Modal/utils.ts` index `alternateGreetings`
  directly.
- Theme: boot (`bootstrap.ts`), the display settings, plugins (`apiV3`), and a remote `ui` record (`watchRemoteRecords`)
  call `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, and `updateGuisize`.

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
- `Chat.updateRow` changes only supplied position/streaming fields or display-only `name?: string` and
  `img?: string | Promise<string>` props; name/image updates never reset the `ChatBody` key.
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

- Rows bound by index carry only their owner's id as `popupEditorContext` (`PromptDataItem` in the prompt template,
  `RegexData` in a regex list, a plugin's textarea argument, which uses the plugin's name): when another client reorders
  the owner's rows while a popup is open and both rows hold the same text, the row stays mounted and its popup writes
  into the row now at that index.
- Plugin rows with duplicate names (kept by `setPlugins` and the upstream backup import) share a `popupEditorContext`
  the same way. The rows have no ids, and the row object's identity would change on every refreshed record list, which
  would discard unchanged drafts.

### Limitations

- Growth inside rows shown above the view during a scroll animation moves the reader by the grown height (Chrome,
  reversed scroller): images swapped in late by `checkImg` (`.root-loaded-image` reserves no height), lazy images, a row
  re-rendering (CBS, translation, a reload pointer), and a far row whose `contain-intrinsic-block-size` estimate differs
  from its rendered height. A fix would restore a reader anchor (the visible row nearest the view's top and its offset)
  at `scrollend`, not mid-animation, once the hold releases. Decision: deferred by the owner (2026-10-27), commit
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

### Gotchas

- `src/lib/ChatScreens/Message.svelte` is an unused TODO rewrite; `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` is
  empty. Confirm intent before extending either.
- `LazyPortal` has no active callers found.
- Reproduce a transcript scroll-animation jump with real X wheel ticks (headed Chrome on WSLg through XTest); CDP
  `Input.dispatchMouseEvent` wheels do not animate.
