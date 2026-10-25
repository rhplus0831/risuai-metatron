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

Chat:

- `ChatScreen.svelte`: layout theme switch (`waifu`, classic). Mounts `BackgroundDom`, `TransitionImage`, `ResizeBox`, `ChatList`, and the module menu.
- `DefaultChatScreen.svelte`: input box, send/reroll (see `chat-pipeline.md`), and menus. The Stop button's rotating circle takes `chat-process-stage-1`–`4` (blue preparing, pink memory, green generating, purple finishing) from the selected chat's newest staged job (`chatStageOf($jobStages, currentChatRef())`, `src/ts/process/jobStages.ts`), else `chat-process-stage-0`; another chat's job never colors it. In auto mode `.autoload` (green, declared after the stage rules) wins over every stage. The class names and hex colors are kept as they are, since `display.customCSS` can target them. The hamburger menu pins with `setChatMeta(ref, { pinned: true })` and unpins by unsetting `pinned`. Chooses home, playground, the closed chat (`ClosedChatScreen.svelte`, while `selection.chatOpen` is false), or chat.
  - The `metatron` theme adds `metatron-chat-theme` to the chat scroller; `src/styles.css` styles each message (`.risu-chat`) as a card under it. Any other non-`waifu` theme keeps the classic layout.
  - Owns the loaded row window and accepts guarded trims from `Chats`. Unfolding adds `messages.length - foldedIndex` to preserve the folded window's oldest row. Binds `Chats.revealing` to hide the separate greeting with `visibility: hidden` until the opening batch finishes revealing. Screenshot capture waits for all rows and their current markdown (`whenRendered`) with `loadPages = Infinity`, releases any reveal batch, suspends trimming/containment, and restores the previous window and scroll offset for the same chat in `finally`. `src/lib/ChatScreens/screenshotCapture.ts` sets `includeQueryParams: true` so html-to-image keeps original and thumbnail URLs in separate cache entries.
  - Message jumps use the bookmark index or search-hit id. Search claims a request once, verifies the selected and shown chat after each await, and re-resolves the message by `Message.chatId`; a folded target unfolds the window before scrolling and ringing it. Both jump types suspend trimming.
  - The chat scroller publishes `settings.ui.chatScreenWidth` (Display, default 900) as `--chat-screen-width`. The transcript (`Chats`), the first greeting (`.default-chat-screen > .risu-chat`), the composer, and the rows around them carry `chat-screen-content-width` (`src/styles.css`): one centered column of `min(--chat-screen-width, 100%)`. A new row in the chat scroller gets the class too, and a popup tied to the composer (the composer menu) is positioned inside the composer row so it follows the column instead of the viewport or scroller edge.
- `Chats.svelte`: imperatively mounts rows keyed by chat and `Message.chatId`. The structural diff tracks row identity/order, streaming entry, window and reload inputs, not message text; each row's disposable effect handles its own text and display updates. Streaming reaches only that chat's active row. Opening windows mount and reveal newest rows first, then arm older rows after render or interaction, or at a diff that changes the shown rows (a diff that shows the same rows, such as the reload a module change makes right after a switch, keeps the staging); a row reveals once rendered and its unfinished images in the transcript's view have loaded (lazy images outside the view, which do not load while hidden, never hold it), or at a 1200 ms deadline. Screenshot mode bypasses staging and containment. At the bottom, appends trim only old rows while keeping at least `CHAT_ROW_CAP` (150) plus visible rows and one load page; folds, screenshots, jumps, and open editors block trimming. Scrolling follows a scroll anchor: `start` keeps a row's top at the scroller's top, `end` keeps the bottom, none leaves the position to the reader. Opening a chat (not folded, captured, or jumping) anchors the newest row's start, or the bottom while it streams. With `autoScrollToNewMessage`, a reply that arrives whole (locked or not) anchors its start, and a streamed one (`isMessageStreamed`: chunks only, so this tab's or another's stream, and never a continue that has not streamed) the bottom until its lock ends, then its start unless `scrollToReplyStartAfterStreaming` is off; both apply only while the reader follows (`followsLatest`: an anchor or the bottom, or `alwaysScrollToNewMessage`), otherwise a reply sets the new-message indicator. A generation that never streamed ends at the newest start only while the anchor holds, so a reader who scrolled is left alone. The reader's own send moves an anchored transcript to the bottom. Swiped rerolls (`DefaultChatScreen`) anchor the newest start through `scrollToLatestMessage` when the reader followed before the swap, as the new-message button does; `openRoute` (a notification) sets `ShowLatestMessageStore`, and the screen then shows the newest start even for a chat that was already open. A `ResizeObserver` on the transcript and scroller re-applies the anchor before paint; wheel, touchmove, a press on the scroller itself (its scrollbar), and scroll keys outside inputs release it, and so does a jump or screenshot (`suspendTrim`), during which new replies only set the indicator. The anchor scrolls by measured offset, not `scrollIntoView`, which can move ancestor scrollports too. An `IntersectionObserver` contains only distant rows, with measured intrinsic size.
- `Chat.svelte`: one message. Branching clears `pinned` on the new chat; with `createFolderOnBranch`, a source chat that `chatFolderOf` lists under no folder (none, or a dangling `folderId`) and its branch go into a new "Branches of" folder. Controls, bookmarks (`toggleBookmark`), TTS button, `displaya`, partial edit, and `renderGuiHtmlPart` for custom GUI HTML. Message theme branches are `mobilechat`, `cardboard`, `customHTML`, and classic. Both original-message editors bind a separate `draft`, initialized on opening and cleared on save; a long-press cancel keeps the draft for reopening but never changes `message`, the display, partial-edit source, or storage. With `clickToEdit`, a click on the message body opens the original-message editor, except a click inside a `risu-form` form, a `risu-btn` or `risu-trigger` element (any tag), or an interactive control (`input`, `textarea`, `select`, `button`, `label`, `a`, contenteditable). Each row gets its owning `ChatRef` from `Chats.svelte` (`chatRef`; other mounts default to the selection at mount): message actions, Lua buttons, manual triggers, and forms address that chat, not the selection at the event. A Lua button reloads its row only when its job started, so a refused button keeps typed values beside it. A bookmark preview passes no `messageId` and tells the row it streams through `streamingOverride`. `isEditing` exposes open original/translation editors to the trim guard. `ChatBody` is keyed only by the reload pointer; `whenRendered` loops until the bound body stays the same across its render wait and DOM flush, including replacements from `ReloadGUIPointer`. Body-less rows settle immediately. Optional `pendingReveal` hides the greeting's whole row without changing its layout.
- `ChatBody.svelte`: `markParsing`, which handles translation and parsing, then `{@html}`. `whenRendered` waits for the current parse and its DOM update for ordered reveal and screenshot capture (forwarded by `Chat` and `Chats`), rechecking replacement parses after each flush. The rendered auto-translate path's initial empty result is not settled: the wait includes its delayed `translated` update and the resulting real parse. Raw streaming settles immediately and remains visible as raw text.
  - While a render is pending it shows `lastParsed`; only the newest render (`parseRun`, kept by its retries) writes it, so an older render that settles later does not show again (`ChatBody.svelte.test.ts`).
- `Suggestion.svelte`: reply suggestions through `requestChatData`.
- `ContextMeter.svelte`: the composer's context chip, mounted after the textarea and keyed by the open chat (a switch starts closed); not shown in a group chat or while `settings.ui.contextMeter` is off. It reads the newest message whose `generationInfo.context` passes `parseContextReport` (`shared/contextReport.ts`, [chat-pipeline](chat-pipeline.md)), scanning only the message list and each message's `generationInfo`, so streaming text does not rerun it; with no valid report anywhere it falls back to the newest `inputTokens / maxContext`, and with neither it renders nothing. Chip: the share of the prompt budget (`maxContext − maxResponse`) while every eligible message was kept, else the kept count by `contextMeterTurnUnit` ("18 turns" / "18 messages"); with memory, the kept count plus "summarized", "gap", or "memory on" by `coverage` (the note is hidden below `sm`); danger tone when `fixedShare` exceeds `contextMeterFixedWarn`. The popover (`Portal` to the body, fixed above the chip when space allows, below it otherwise, or within the viewport when neither side has room; below dialogs and alerts, repositioned on resize, scroll, and composer growth) lists the sections largest first with the signed `adjustment` as an "Other" row outside the bar, the omitted history, the lorebook activation budget (warning tone when entries were rejected), the HypaV3 budget or the memory line, the fixed share, and a basis line whose link opens the `interaction.contextMeter` section through `openSetting`. It closes on Escape (unless an alert, terminal notice, or binding dialog is above it; focus returns to the chip), a pointer down outside, focus leaving both it and the chip, its close button, when its source disappears, or when the chip leaves view or the viewport is too short to show it.
- Also: `TransitionImage.svelte`, `EmotionBox.svelte`, `ResizeBox.svelte`, `BackgroundDom.svelte`, `CreatorQuote.svelte`. `Message.svelte` is dead (TODO rewrite).

Sidebar:

- `Sidebar.svelte`: character rail and folders (`characterOrder`, drag/drop with the `RISU_*` MIME types, `checkCharOrder`) plus the settings pane (`SideChatList` | `OpenChatPanel` | `CharConfig` | `DevTool`). A pinned-chat rail follows the menu buttons in `menuSideBar` and sits immediately above the shared character-avatar area in either hamburger placement. The chat tab shows `SideChatList` while the chat is closed and `OpenChatPanel` while it is open; the playground chat always shows the list. The pane publishes its side padding as `--sidebar-gutter` (`1rem`, `0.5rem` under DynamicGUI); a child that scrolls itself (the `SideChatList` list, the `OpenChatPanel` root) stretches over it with `-mr-(--sidebar-gutter) pr-(--sidebar-gutter)` so its scrollbar sits at the pane's edge, like the pane's own scrollbar in the character tab.
  - `statusSets` reads `refusedChatKeys(refusedItems())` from the save adapter’s reactive refusal inventory, `recoveryChatKeys`, `generatingChatKeys()`, and `unseenChatKeys` from `src/ts/process/chatStatus.svelte.ts` and `summarizingChats()` from `src/ts/process/memoryTasks.svelte.ts` reactively. `characterStatuses` aggregates once per change; top-level characters and members of open folders read their character's status. Collapsed folders use `folderStatus` over their members; an open folder has no badge on its own row. `pinnedStatuses` resolves each pinned chat separately and is passed to both rail placements with the summarizing chats' counts (`memoryCounts`). A row whose winning status is `memory` shows the count of its only summarizing chat (`collectMemoryProgress`, `groupMemoryCount`: over the character, or over a collapsed folder's members); with several summarizing chats, or a queued task, it shows the status without a count.
- `SideChatList.svelte`: chat list, folders, and chat actions. It captures a `ChatRef` before dialogs and re-resolves it with `chatEntry` afterward; new chats and JSONL imports open through `changeChatTo`, while JSON/HTML imports only add entries. Structure changes go through the chat module. A dangling `folderId` displays at the root and remains stored; drag/drop writes a complete chat order. Its Korean-aware filter keeps hidden rows mounted for SortableJS, temporarily disables sorting, and opens matching folders without changing `folded`; the character catalog uses the same `matchesAny` helper.
- `PinnedChatsRail.svelte` / `pinnedChats.ts`: collect pinned chats from summaries in character order (folders expanded, remaining characters appended), omit trashed characters, and open through `globalApi.openPinnedChat` (select chat before character). The same projection supplies home cards. Optional status and memory-count maps are keyed by `chaId\u0000chatId`; badge priority and labeling live in `chatStatus.ts`.
- `src/lib/SideBars/chatStatus.ts`: pure status resolution and aggregation for characters, folders, and pinned chats. Priority is recovery → refused → generating → memory task → unseen; only chat refusals produce a refused chat badge.
- `src/lib/SideBars/ChatStatusBadge.svelte`: accessible, non-interactive 20px status badge. Running memory tasks may show `k/n`; other statuses use icons and theme tokens. Character, folder, pin, and home-card labels include the status.
- `OpenChatPanel.svelte`: open-chat header, binding, translation, author note, and prompt toggles. Chat-bound editors capture a `ChatRef` and are recreated for another chat; binding pickers and dialogs use that ref. New-chat defaults and translation behavior are documented in [persistence](persistence.md) and [media-aux](media-aux.md).
- `DevTool.svelte`: prompt preview via `sendChat(-1, {preview})`, token counts, and variables. The instruct preview takes the character and user names of the chat it was started for, before the await (`DevTool.test.ts`).
- `Toggles.svelte`: per-chat prompt toggles resolve current chat values, legacy globals, and kind defaults; `setChatToggle` writes one key. Optional presets apply/link, unlink, save, rename, and delete. Async actions capture and re-check the `ChatRef`; `PopupEditor` sets `presets={false}`. See `src/lib/SideBars/Toggles.test.ts`.
- Also: `SidebarAvatar.svelte`, `SidebarIndicator.svelte`, `BarIcon.svelte` (legacy), `DropList.svelte`.

Others:

- `BookmarkList.svelte`, `ChatList.svelte`, `GithubStars.svelte`, `Help.svelte`, `SavePopupIcon.svelte`.
- `Others/ChatCheckpointsDialog.svelte`: per-chat checkpoints UI, mounted by `App` beneath alerts and above binding dialogs. The checkpoint module owns its store and server operations. Actions capture the chat and row revision before prompts; a load holds the modal and blocks hotkeys through save, request, and refresh. See `ChatCheckpointsDialog.test.ts` and [persistence](persistence.md), Chat checkpoints.
- `MessageSearch.svelte`: search panel mounted by `App`, opened for one character from the chat list or all characters from the catalog. It supports this chat, this character, and all-character scopes; debounces queries, cancels stale requests, displays snippets as text, and opens a hit through `openPinnedChat` before requesting the guarded message jump. Search state and shared request types belong to [chat-pipeline](chat-pipeline.md); the route is in [self-host-server](self-host-server.md).
- `PopupEditor.svelte`: Monaco popup.
- `HypaV3Progress.svelte`: selected-chat memory progress overlay. It shows the newest run belonging to the selected chat and restores it after switching back; otherwise it shows the legacy progress notice. The stop action captures the job and run ids. Progress notices and task lifecycle are covered by [memory](memory.md).
- HypaV3 background task UI: `memoryTasks.svelte.ts` supplies status and edit-fence state to the sidebar badges and `HypaV3Modal`. The modal shows queued/running/terminal status, pending-manual state, and Summarize/Cancel actions; memory task protocol, revision fences, and outcomes are owned by [memory](memory.md).
- `HypaV3Modal.svelte`: edits the selected chat's memory copy. It refuses memory edits while the chat is sending or its task fence is active, rolls the local edit back, and shows task status and controls supplied by `memoryTasks.svelte.ts` ([memory](memory.md)). Lore writes are not fenced by background tasks.

GUI primitives (`src/lib/UI/GUI/*`):

- `Button`, `IconButton`, `CheckInput` (`disabled` prevents toggling and dims with theme tokens; `indeterminate` displays the native mixed state and a dash), `ColorInput`, `NumberInput`, `TextInput`, `TextAreaInput` (contenteditable plus CBS highlight and autocomplete), `TextAreaResizable`, `SelectInput`/`OptionInput` (`SelectInput` forwards native select attributes, including accessible labels and data attributes, and carries `risu-select`), `SegmentedControl` (buttons carry `aria-pressed`; optional `label` makes the container a named `role="group"`, `describedBy` sets its `aria-describedby`, and `margin={false}` drops the bottom margin settings pages use; a bound value that matches no option shows no indicator), `SliderInput` (`-1000` means disabled; a touch or pen drags only after it moves sideways past a slop, a vertical move is left to page scrolling, and a tap sets the value through its click), `OptionalInput` (nullable), `MultiLangInput`/`MultiLangDisplay`.
- `Portal`/`PortalConsumer`/`LazyPortal`.
- `LazyFileSrc`: holds a stored file's URL through `holdFileSrc` only once its wrapper nears the viewport (an `IntersectionObserver`, 200px margin) and renders its snippet with it. The loading effect releases its hold on a path change or unmount; a reused row waits to be seen again. Unpinned fallback object URLs are revoked after the last hold and a short grace period (`global-api.md`). Asset lists preview through it; filtering, paging, live-row indices, and name-cache rules belong to [characters-modules](characters-modules.md).
- `LazyCharImage`: defers `getCharImage` until its wrapper nears the viewport and restarts the read on a path change; it loads immediately without `IntersectionObserver`. Its optional 256/512 `thumb` class requests server thumbnails through `getCharImage`; catalog, sidebar, pins, and persona lists use 256, while chat avatars and active persona/character editors use 512. `cardboard` chat keeps the original; editors and asset previews do too. See `LazyCharImage.test.ts` for the observer contract.
- `SideBarArrow`.
- `SyntaxHighlightedTextarea` is empty.

Editor token counts in `CharConfig`, `ChatNoteEditor`, `LoreBookData`, `PromptSettings`, `PromptPresetSettings` (the legacy prompt fields), `PopupEditor`, and `PlaygroundTokenizer` use `createTokenCountField`; see [llm-requests](llm-requests.md). Each input carries the tokenizer scope (`tokenCountInput` or `tokenScopeKey`), so switching the main model recounts unchanged text: expanded fields compare the expanded text and scope, `ChatNoteEditor` compares raw text and scope (its CBS parse stays behind the idle-first scheduling), `PopupEditor` reuses its expanded preview, and the playground names its tokenizer. The first count runs on open, later edits debounce 400 ms, newer work aborts stale requests, failures preserve the last value, and closing or unmounting sends nothing.

Other UI:

- `UI/RefusedDataBanner.svelte` / `UI/refusedData.ts`: partition the save adapter's refusal inventory into a chat banner and an app-level pill. The mounted chat registers its `ChatRef`; the app list omits it until unmount. Chat actions are Export, Retry, and confirmed Discard; the app list can also open a refused chat. Record export includes only fields owned by that resource and excludes managed credentials and client-only chat fields. Stable `data-risu-refused-*` attributes support browser checks.
  - `App` mounts the `app` form beside reload and terminal notices as a fixed, accessible pill with a bounded list. It stays below alerts. Settings, home, or a loading chat unmounts the chat form, returning that refusal to the app list.
  - Membership resolves through `chatEntry`, including unloaded summaries. The app list offers Open for a refused chat; deletion, order, and records without local data have no Export. Discard requires confirmation; failed actions use `alertError`.
  - Record Export downloads `{ kind, id, data }` using only that kind’s `SECTION_FIELDS`. Managed credentials, the pending secret queue, and client-only character fields are excluded. Labels and reasons use `language.refusedData`; the chat badge uses `language.chatStatus.refused`.

- `UI/PopupButton.svelte` writes `popupStore`. `UI/PopupList.svelte` is the fixed-position host mounted by `App`.
- `UI/Accordion.svelte` (its button carries `aria-expanded`; the `styled` one takes an optional `badge` pill beside the name; `startOpen`, read at mount, opens it; optional bindable `open` lets a caller control subsequent transitions while keeping user toggles), `UI/BaseRoundedButton.svelte`, `UI/NewGUI/Button.svelte` (no secondary variant).

Mobile:

- `Mobile/MobileCharacters.svelte`: the list view of the character grid (`Others/GridCatalog.svelte`). The separate beta mobile shell was removed; small screens use the desktop layout.

Theme and GUI helpers:

- `src/styles.css`:
  - The Tailwind v4 `@theme` tokens map `--color-<name>` to `var(--risu-theme-<name>)`.
  - Root palette variables.
  - Chat typography.
  - Shared classes `x-risu-button-default` and `x-risu-risu-comment`.
  - `risu-select`, on `SelectInput` and the popup editor's language select: WebKit draws a native `<select>` as a fixed-height menulist that ignores vertical padding and clips the selected text, so the class drops the native appearance, draws its own chevron in `currentColor` (the select's theme text color), and reserves `2.25rem` of right padding for it. It is unlayered, so that padding overrides Tailwind `px-*`/`pr-*`. Under `forced-colors: active` it restores the native appearance, since forced colors remove background images.
  - The `metatron-chat-theme` message-card rules.
  - `.chat-message-container.far` alone uses `content-visibility: auto` and `contain-intrinsic-block-size: auto 240px` (the observer supplies a measured fallback). Width remains controlled by the flex column.
  - CBS `::highlight(...)` colors.
- `src/ts/gui/colorscheme.ts`:
  - `ColorScheme` (declared in `shared/settings.ts`) has nine colors plus `type`.
  - `colorShemes` presets: default, dark, light, cherry, galaxy, nature, ocean, aurora, twilight, realblack, Monokai, lite, ...
  - `changeColorScheme`, `updateColorScheme`, `updateTextThemeAndCSS` (text theme, fonts, custom CSS unless `SafeModeStore`), and import/export.
  - `updateColorScheme` also sets the root's inline `color-scheme` from the scheme's `type` (`light`, otherwise `dark`), so native controls (select popups, scrollbars, date inputs) follow the app scheme instead of the OS; `src/styles.css` `:root` declares `color-scheme: dark` for the page before boot. Every scheme change goes through it.
- `src/ts/gui/guisize.ts`: `updateGuisize`. `--sidebar-size = 24 + 4*sideBarSize` rem.
- `src/ts/gui/animation.ts` `updateAnimationSpeed`.
- `src/ts/gui/tooltip.ts`: `tooltip`, `tooltipRight` (Tippy).
- `src/ts/gui/longtouch.ts` `longpress`.
- `src/ts/gui/branches.ts` `getChatBranches`: branch graph used by `AlertComp`.

## Flows

- Desktop: `App` → `Sidebar` + `ChatScreen` → `DefaultChatScreen` → `Chats` → `Chat` → `ChatBody`.
- First greeting: rendered as a separate `Chat` with `idx: -1`. `fmIndex: -1` means `firstMessage`. `fmIndex >= 0` selects `alternateGreetings[fmIndex]`. The chat screen, the CBS registry, triggers (`v2GetFirstMessage`) and regex `repeatBack` read it through `shared/greetings.ts` (`greetingIndex`, `greetingText`, `nextGreetingIndex`, `previousGreetingIndex`): a missing, non-integer or out-of-range index reads as -1. Not converted yet: `server/src/prompt/assemble.ts` (prompt assembly) and `src/ts/characters.ts`, `src/ts/gui/branches.ts` and `src/lib/Others/HypaV3Modal/utils.ts` index `alternateGreetings` directly.
- Popups: `PopupButton` → `popupStore` → `App` renders `PopupList`, which closes on the next document click.
- Theme: at boot `bootstrap.ts` calls `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, and `updateGuisize`. The display settings call the same functions. Plugins can call them via `apiV3`.

## State

- Components mutate the settings through the record views (`settings.ui.*`, `settingsViews.svelte.ts`) and the characters through the character module's records (`selectedCharacter()`, `characterList()`), and rely on the records' write-through saves: each write queues the record it changed (`persistence.md`).
- Invalidation signals:
  - `ReloadGUIPointer`: structural changes.
  - `ReloadChatPointer`: message re-render, by `reloadChatKey` (`m:` and the message id; the greeting `i:` and its index), so a row keeps its counter when messages before it are added or removed. Mounted row effects subscribe through the store; a changed entry remounts only its row.
  - Reassigning an array after an in-place mutation, e.g. `chat.bookmarks = [...]`.
- Theme DB fields: `theme`, `colorScheme`, `colorSchemeName`, `customColorScheme`, `textTheme`, `customCSS`, `textAreaSize`, `sideBarSize`, `textAreaTextSize`.

## Coupling

- The chat tree depends on `process/index.svelte.ts` (`sendChat`), the local send registry (`localSends.ts`), the chat status (`chatStatus.svelte.ts` `isChatBusy`), the parser, `scripts`, the translator, `globalApi` (`changeChatTo`, assets, folding), `characters.ts`, and `database.svelte.ts`.
- The sidebar depends on `characters.ts`, `dragTypes.ts`, SortableJS, and the GUI primitives.
- The GUI primitives are imported by the settings, playground, sidebar, and prompt editors.

## Invariants

- Use theme tokens (see STRUCTURE.md U1). To add a color: a root variable, an `@theme` token, a `ColorScheme` field, `updateColorScheme`, and presets.
- Message identity: `Chats` keys a row by the chat and `chatId` (a message without one by its index); see `updateChatBody` and the per-row effect above for remount conditions. `Chat.updateRow` changes only supplied position/streaming fields or display-only `name?: string` and `img?: string | Promise<string>` props; name/image updates never reset the `ChatBody` key. Never read every row's text in the structural effect; per-chunk transcript JavaScript work must not grow with mounted row count.
- Chat structure operations go through the chat module (`createChat`, `deleteChat`, `reorderChats`, `setChatMeta` for `folderId`; `persistence.md`) and select with `changeChatTo`/`selectChat`; `chatPage` is derived from the per-tab selected chat id and is never assigned. Components never `bind:` a chat field directly: bind a getter/setter pair that calls the module, or a synced editing copy. A locked message (`isMessageLocked`: generating, or its final write not yet acknowledged) has its edit, delete, and regenerate controls disabled; reroll and chat deletion alert `chatGenerating` while the chat holds a lock.
- HTML boundaries:
  - `ChatBody`, `BackgroundDom`, suggestions, and plugin panels use `{@html}` only on sanitized parser output.
  - `renderGuiHtmlPart` whitelists tags and allows only `https` links.
  - Custom CSS is injected via `CustomCSSStore` and must stay disabled in `SafeModeStore`; so must the `customHTML` theme's GUI HTML (`Chat.svelte` renders the classic row instead).
- A list of inputs over a list that can change while one of them has focus keys its rows by entry and binds each input to the entry captured at mount (getter/setter functions that drop a write once the list no longer holds it), never `bind:value={list[i]}` in an unkeyed `#each`: Chrome fires `change` on a focused, edited control while removing it, and an index binding resolves `list[i]` at that moment. The lorebook and character asset editors follow this ([characters-modules](characters-modules.md) Invariants).
- Runes and legacy stores are mixed: `$state`/`$derived`/`$props`/`$bindable`/snippets alongside `writable` stores, `.subscribe`, `createEventDispatcher`, and `on:save`. Match the local component.
- Primitive prop convention: an `interface Props`, destructured with `$props()`, `$bindable()` for mutable values, callback props (`onclick`, `onchange`), and `children: Snippet`.

## Recipes

- Change message rendering: `DefaultChatScreen` props → `Chats.updateChatBody` (row key, mount key, and `Chat.updateRow` fields) → `Chat`/`ChatBody`. Verify streaming, reroll, the first greeting, and custom HTML manually.
- Add a sidebar chat operation: `SideChatList.svelte`, plus `Chat` in `shared/database.ts` if the shape changes. Write through the chat module, open a chat with `changeChatTo` (or only select it with `selectChat`), and bump `ReloadGUIPointer`. Cross-character pins use `openPinnedChat`, selecting the chat before the character.
- Add a form primitive: follow the prop convention in `src/lib/UI/GUI/` and add cases to `guiRendering.test.ts`.
- Add a popup or portal: a store in `stores.svelte.ts`, then the trigger and host (`PopupButton`/`PopupList` or `Portal`). Clean up mounts and listeners.

## Tests

- Theme and primitives: `src/lib/UI/GUI/guiRendering.test.ts`, `src/ts/gui/guiRecords.test.ts`, `src/lib/UI/GUI/SecretInput.test.ts`, `src/lib/UI/GUI/LazyFileSrc.test.ts`, `src/lib/UI/GUI/LazyFileSrcHold.test.ts`, and `src/lib/UI/GUI/LazyCharImage.test.ts`. Catalog and home icon coverage is in `src/lib/Others/GridCatalog.test.ts`, `src/lib/Mobile/MobileCharacters.test.ts`, `src/lib/UI/MainMenu.status.test.ts`, and `e2e/welcomeAndChatSettings.spec.ts`.
- Chat row/render behavior: `src/lib/ChatScreens/Chat.test.ts`, `src/lib/ChatScreens/Chat.draft.test.ts`, `src/lib/ChatScreens/Chat.interactions.svelte.test.ts` (row-owned chat, Lua button refusal, click-to-edit, jump scrolling, bookmark Escape and streaming previews), `src/lib/ChatScreens/ChatBody.svelte.test.ts`, `src/lib/ChatScreens/ChatBody.assets.svelte.test.ts`, `src/lib/ChatScreens/Chats.svelte.test.ts`, `src/lib/ChatScreens/Chats.rows.svelte.test.ts`, `src/lib/ChatScreens/ChatScreen.test.ts`, `src/lib/ChatScreens/PartialEditController.test.ts`, `src/lib/ChatScreens/Suggestion.svelte.test.ts`, `src/lib/ChatScreens/ContextMeter.svelte.test.ts` (chip states and units, the warning boundary, report precedence and the legacy fallback, popover rows, placement, dismissal, the settings jump), and `src/ts/chatLoadPages.test.ts`. `util/playwright/measureChats.mjs` checks production row counts, memory, and streaming cost.
- Screenshot thumbnail caching: `src/ts/screenshotCaptureCache.test.ts` verifies the original and each thumbnail size stay separate after capture.
- Sidebar and status behavior: `src/lib/SideBars/SideChatList.test.ts`, `src/lib/SideBars/Sidebar.test.ts`, `src/lib/SideBars/OpenChatHeader.test.ts`, `src/lib/SideBars/ChatBindingPanel.test.ts`, `src/lib/SideBars/ChatTranslationPanel.test.ts`, `src/lib/SideBars/Toggles.test.ts`, `src/lib/SideBars/chatStatus.test.ts`, and `src/lib/SideBars/PinnedChatsRail.status.test.ts`. Refusal UI has `src/lib/UI/RefusedDataBanner.test.ts` and `e2e/refusedData.spec.ts`; status badges also have `util/playwright/checkSidebarChatStatus.mjs`.
- Overlays: `src/lib/Others/ChatCheckpointsDialog.test.ts`, `src/lib/Others/MessageSearch.test.ts`, `src/ts/messageSearch.test.ts`, and `src/lib/ChatScreens/messageJump.test.ts`. The search-to-transcript claim and scroll wiring still need a browser check.
- Memory progress UI: `src/lib/Others/HypaV3Progress.test.ts` and `src/ts/network/jobChannel.test.ts`; background task lifecycle and fencing are covered in [memory](memory.md). The manual recovery check is to switch away from a running chat, stop the server until reattach attempts fail, confirm its recovery badges, then restart the server and reopen the chat.
- Token count consumers: `src/ts/tokenCountField.test.ts`, `src/lib/SideBars/CharConfig.emotions.test.ts`, `src/lib/SideBars/LoreBook/LoreBookList.test.ts`, `src/lib/SideBars/ChatNoteEditor.test.ts`, and `src/lib/Setting/Pages/PromptPresetSettings.tokenCount.test.ts`; implementation ownership is in [llm-requests](llm-requests.md).
- Sidebar composition and mobile interactions still need browser checks.

## Known Hazards

- `src/lib/ChatScreens/Message.svelte` is an unused TODO rewrite; `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` is empty. Confirm intent before extending either.

- A far row's fixed-position or overflowing custom content is contained while it is far. Near rows are deliberately uncontained; do not apply `content-visibility` to every row or to the transcript ancestor.
- Older rows do not rerender merely because the chat length changes. Length-dependent CBS updates when that row next renders (edit, reload, remount, etc.); restoring the old last-five key would add unnecessary renders on every append.

- `LazyPortal` and the generic `tooltip` action have no active callers found.
