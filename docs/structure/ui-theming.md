# UI Components and Theming

## Scope
- Owns:
  - the Svelte component tree below `App.svelte` (chat screen, message rendering components, sidebar, mobile shell),
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
- `ChatScreen.svelte`: layout theme switch (`waifu`, `waifuMobile`, classic). Mounts `BackgroundDom`, `TransitionImage`, `ResizeBox`, `ChatList`, and the module menu.
- `DefaultChatScreen.svelte`: input box, send/reroll (see `chat-pipeline.md`), and menus. Chooses home, playground, or chat.
- `Chats.svelte`: mounts `Chat` instances imperatively, keyed by message hash.
  - `updateChatBody` diffs mount, update, and remove, keeping reverse-chronological DOM order.
  - Streaming instances are updated through `Chat.updateStreamingDisplay`.
- `Chat.svelte`: one message. Controls, bookmarks (`toggleBookmark`), TTS button, `displaya`, partial edit, and `renderGuiHtmlPart` for custom GUI HTML. Message theme branches are `mobilechat`, `cardboard`, `customHTML`, and classic.
- `ChatBody.svelte`: `markParsing`, which handles translation and parsing, then `{@html}`.
- `Suggestion.svelte`: reply suggestions through `requestChatData`.
- Also: `TransitionImage.svelte`, `EmotionBox.svelte`, `ResizeBox.svelte`, `BackgroundDom.svelte`, `CreatorQuote.svelte`. `Message.svelte` is dead (TODO rewrite).

Sidebar:
- `Sidebar.svelte`: character rail and folders (`characterOrder`, drag/drop with the `RISU_*` MIME types, `checkCharOrder`) plus the settings pane (`SideChatList` | `CharConfig` | `DevTool` | `QuickSettingsGUI`).
- `SideChatList.svelte`: chat list with SortableJS, folders, new/duplicate/delete/import/export, persona binding, and `Toggles`.
- `DevTool.svelte`: prompt preview via `sendChat(-1, {preview})`, token counts, and variables.
- `Toggles.svelte`: global, module, and character toggles (`getModuleToggles`, `parseToggleSyntax`).
- `CustomSidebar.svelte`: renders `db.customSidebarItems`.
- Also: `SidebarAvatar.svelte`, `SidebarIndicator.svelte`, `BarIcon.svelte` (legacy), `DropList.svelte`.

Others:
- `BookmarkList.svelte`, `ChatList.svelte`, `CustomSidebarConfig.svelte`, `GithubStars.svelte`, `Help.svelte`, `Legal.svelte`, `SavePopupIcon.svelte`.
- `PopupEditor.svelte`: Monaco popup.
- `WelcomeRisu.svelte`: first-run wizard.
- `ProTools/EasyPanel.svelte`, `QuickSettingsGUI.svelte`, `AllSeperateParameters.svelte`: see `settings-i18n.md`.

GUI primitives (`src/lib/UI/GUI/*`):
- `Button`, `IconButton`, `CheckInput`, `ColorInput`, `NumberInput`, `TextInput`, `TextAreaInput` (contenteditable plus CBS highlight and autocomplete), `TextAreaResizable`, `SelectInput`/`OptionInput`, `SegmentedControl`, `SliderInput` (`-1000` means disabled), `OptionalInput` (nullable), `MultiLangInput`/`MultiLangDisplay`.
- `Portal`/`PortalConsumer`/`LazyPortal`.
- `SideBarArrow`.
- `SyntaxHighlightedTextarea` is empty.

Other UI:
- `UI/PopupButton.svelte` writes `popupStore`. `UI/PopupList.svelte` is the fixed-position host mounted by `App`.
- `UI/Accordion.svelte`, `UI/BaseRoundedButton.svelte`, `UI/NewGUI/Button.svelte` (no secondary variant).

Mobile:
- `Mobile/MobileHeader.svelte`, `MobileBody.svelte`, `MobileFooter.svelte`, `MobileCharacters.svelte`: driven by `MobileGUIStack` and `MobileSideBar`.

Theme and GUI helpers:
- `src/styles.css`:
  - The Tailwind v4 `@theme` tokens map `--color-<name>` to `var(--risu-theme-<name>)`.
  - Root palette variables.
  - Chat typography.
  - Shared classes `x-risu-button-default` and `x-risu-risu-comment`.
  - CBS `::highlight(...)` colors.
- `src/ts/gui/colorscheme.ts`:
  - `ColorScheme` has nine colors plus `type`.
  - `colorShemes` presets: default, dark, light, cherry, galaxy, nature, ocean, aurora, twilight, realblack, Monokai, lite, ...
  - `changeColorScheme`, `updateColorScheme`, `updateTextThemeAndCSS` (text theme, fonts, custom CSS unless `SafeModeStore`), and import/export.
- `src/ts/gui/guisize.ts`: `updateGuisize`. `--sidebar-size = 24 + 4*sideBarSize` rem.
- `src/ts/gui/animation.ts` `updateAnimationSpeed`.
- `src/ts/gui/tooltip.ts`: `tooltip`, `tooltipRight` (Tippy).
- `src/ts/gui/longtouch.ts` `longpress`.
- `src/ts/gui/branches.ts` `getChatBranches`: branch graph used by `AlertComp`.

## Flows
- Desktop: `App` → `Sidebar` + `ChatScreen` → `DefaultChatScreen` → `Chats` → `Chat` → `ChatBody`.
- Mobile: `App` → `MobileHeader`/`MobileBody`/`MobileFooter`. `MobileBody` picks `SideChatList`, `CharConfig`, `DevTool`, `ChatScreen`, Realm, or settings.
- First greeting: rendered as a separate `Chat` with `idx: -1`. `fmIndex: -1` means `firstMessage`. `fmIndex >= 0` selects `alternateGreetings[fmIndex]`.
- Popups: `PopupButton` → `popupStore` → `App` renders `PopupList`, which closes on the next document click.
- Theme: at boot `bootstrap.ts` calls `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, and `updateGuisize`. The display settings call the same functions. Plugins can call them via `apiV3`.

## State
- Components mutate `DBState.db` directly and rely on autosave. See `persistence.md` D4 for the selected-character-only save tracking.
- Invalidation signals:
  - `ReloadGUIPointer`: structural changes.
  - `ReloadChatPointer`: message re-render.
  - Reassigning an array after an in-place mutation, e.g. `chat.bookmarks = [...]`.
- Theme DB fields: `theme`, `colorScheme`, `colorSchemeName`, `customColorScheme`, `textTheme`, `customCSS`, `textAreaSize`, `sideBarSize`, `textAreaTextSize`, `customSidebarItems`.

## Coupling
- The chat tree depends on `process/index.svelte.ts` (`sendChat`, `doingChat`), the parser, `scripts`, the translator, `globalApi` (`changeChatTo`, assets, folding), `characters.ts`, and `database.svelte.ts`.
- The sidebar depends on `characters.ts`, `dragTypes.ts`, SortableJS, and the GUI primitives.
- The GUI primitives are imported by the settings, playground, sidebar, and prompt editors.

## Invariants
- Use theme tokens (see STRUCTURE.md U1). To add a color: a root variable, an `@theme` token, a `ColorScheme` field, `updateColorScheme`, and presets.
- Message identity: `Chats` hashes data, `chatId`, index, portrait, disabled, and the reload pointer. The text of an actively streaming message is excluded from the hash.
- Chat structure operations must preserve `chatPage` and folder IDs, and must call `changeChatTo` the way the existing code does.
- HTML boundaries:
  - `ChatBody`, `BackgroundDom`, suggestions, and plugin panels use `{@html}` only on sanitized parser output.
  - `renderGuiHtmlPart` whitelists tags and allows only `https` links.
  - Custom CSS is injected via `CustomCSSStore` and must stay disabled in `SafeModeStore`.
- Runes and legacy stores are mixed: `$state`/`$derived`/`$props`/`$bindable`/snippets alongside `writable` stores, `.subscribe`, `createEventDispatcher`, and `on:save`. Match the local component.
- Primitive prop convention: an `interface Props`, destructured with `$props()`, `$bindable()` for mutable values, callback props (`onclick`, `onchange`), and `children: Snippet`.
- Platform branches to keep: the mobile shell is separate.

## Recipes
- Change message rendering: `DefaultChatScreen` props → `Chats.updateChatBody` (hash and props) → `Chat`/`ChatBody`. Verify streaming, reroll, the first greeting, and custom HTML manually.
- Add a sidebar chat operation: `SideChatList.svelte`, plus `Chat` in `database.svelte.ts` if the shape changes. Use `changeChatTo` and bump `ReloadGUIPointer`.
- Add a form primitive: follow the prop convention in `src/lib/UI/GUI/` and add cases to `guiRendering.test.ts`.
- Add a popup or portal: a store in `stores.svelte.ts`, then the trigger and host (`PopupButton`/`PopupList` or `Portal`). Clean up mounts and listeners.
- Add mobile navigation: update `MobileBody`, `MobileHeader`, and `MobileFooter` together with the `Mobile*` stores.

## Tests
- `src/lib/UI/GUI/guiRendering.test.ts` (happy-dom, Svelte `mount`): the primitives only.
- Not tested: chat screens, sidebar, mobile, colorscheme, sizing.

## Known Hazards
- `waifuMobile` is handled by `ChatScreen` but not offered in the display settings. Its origin is unclear, so do not remove it as dead code.
- The `display.customGui` condition checks `theme === 'custom'`, while the options use `customHTML`.
- `LazyPortal` and the generic `tooltip` action have no active callers found.
