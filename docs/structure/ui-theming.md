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

### Chat screen

- `ChatScreen.svelte`: layout theme switch (`waifu`, classic); a custom background that finishes loading after a newer
  one was chosen is dropped.
- The `metatron` theme adds `metatron-chat-theme` to the chat scroller; `src/styles.css` styles each message
  (`.risu-chat`) as a card under it. Any other non-`waifu` theme keeps the classic layout.
- `DefaultChatScreen.svelte`: input box, send/reroll (see `chat-pipeline.md`), and menus. It chooses home, playground,
  the closed chat (`ClosedChatScreen.svelte`, while `selection.chatOpen` is false), or chat.
- `DefaultChatScreen` owns the loaded row window and accepts guarded trims from `Chats`. Unfolding adds
  `messages.length - foldedIndex` to preserve the folded window's oldest row.
- `DefaultChatScreen` binds `Chats.revealing` to hide the separate greeting with `visibility: hidden` until the opening
  batch finishes revealing, and `Chats.holding` to skip the scroll-driven load-more while rows are held (held rows add
  no height, so the top would stay in reach and every scroll event would load another page).
- Screenshot capture waits for all rows and their current markdown (`whenRendered`) with `loadPages = Infinity`,
  releases any reveal batch, suspends trimming/containment, and restores the previous window and scroll offset for the
  same chat in `finally`.
- Message jumps go to a message id: a bookmark's index (`ScrollToMessageStore`) names it once, when the jump starts, and
  a search hit carries it. Search claims a request once. Both run through `runMessageJump` (`messageJump.ts`) under one
  screen-owned jump, and both suspend trimming.
- A newer bookmark or search jump, a chat switch, a replaced transcript, or destroy stops the older jump. Each await is
  followed by a check of the selected and shown chat and a fresh lookup of the message by `Message.chatId`; a folded
  target unfolds the window before scrolling and ringing it.
- The chat scroller publishes `settings.ui.chatScreenWidth` (Display, default 900) as `--chat-screen-width`. The
  transcript (`Chats`), the first greeting (`.default-chat-screen > .risu-chat`), the composer, and the rows around them
  carry `chat-screen-content-width` (`src/styles.css`): one centered column of `min(--chat-screen-width, 100%)`. A new
  row in the chat scroller gets the class too, and a popup tied to the composer (the composer menu) is positioned inside
  the composer row so it follows the column instead of the viewport or scroller edge.

### Composer

- Both composers are `<textarea>`s in `src/lib/ChatScreens/DefaultChatScreen.svelte`, not components: the main composer
  (`composer.input`) in the composer row, and the translation composer (`composer.translate`, `#messageInputTranslate`)
  under it while `useAutoTranslateInput` is on outside the playground.
- Their text and files come from `createComposer` (`src/ts/process/composerDrafts.svelte.ts`), their keys from
  `src/ts/process/inputTranslation.svelte.ts`. A new composer button goes in the composer row beside the `openMenu`
  button; a popup from it follows [Dialogs, popovers, and portals](#dialogs-popovers-and-portals).
- The Stop button's rotating circle takes `chat-process-stage-1`–`4` (blue preparing, pink memory, green generating,
  purple finishing) from the selected chat's newest staged job (`chatStageOf($jobStages, currentChatRef())`,
  `src/ts/process/jobStages.ts`), else `chat-process-stage-0`; another chat's job never colors it. In auto mode
  `.autoload` (green, declared after the stage rules) wins over every stage. The class names and hex colors are kept as
  they are, since `display.customCSS` can target them.
- The main composer's placeholder comes from `src/lib/ChatScreens/composerPlaceholder.ts`. `white-space: pre` on it
  keeps one line, so the composer's height does not depend on the names, and keeps the leading space of ` → character`
  for a persona without a name.
- While the binding is incomplete both composers are `readonly`, not `disabled`, so they keep their text, focus, and the
  focus hotkey, and Enter still opens the setup; pasting an image is ignored, and typing a `/` command waits for the
  setup. Text that other controls add (a suggestion, an additional asset) still lands in the draft, which a send keeps
  until the setup is done.

### Transcript rows and the mount hold

- `Chats.svelte` imperatively mounts rows keyed by chat and `Message.chatId`. The structural diff tracks row
  identity/order, streaming entry, window and reload inputs, not message text; each row's disposable effect handles its
  own text and display updates. Streaming reaches only that chat's active row.
- Opening windows mount and reveal newest rows first, then arm older rows after render or interaction, or at a diff that
  changes the shown rows (a diff that shows the same rows, such as the reload a module change makes right after a
  switch, keeps the staging).
- A row reveals once rendered and its unfinished images in the transcript's view have loaded (lazy images outside the
  view, which do not load while hidden, never hold it), or at a 1200 ms deadline.
- Rows that come in above every shown row (an opening's deferred rows, a loaded or unfolded page) are held by
  `Chats.svelte` out of the layout (`chat-row-held`, `display: none`) until their current instance has rendered and the
  reader is not scrolling; appended or newer rows never wait. A new path that adds rows above the shown ones goes
  through this hold: Chrome finishes a running scroll animation in this reversed scroller at its distance from the top,
  so content growing above the view mid-animation moves the reader up by the grown height.
- Showing held rows registers a no-op non-passive `wheel`/`touchstart` listener (the scroll gate) so a new scroll waits
  for the main thread, shows the rendered rows together an animation frame later (after the gate's commit, and after
  that frame's input and scroll events, which can still cancel), and lifts the gate a frame after their growth commits.
  Without the gate, a scroll starting during the shown rows' layout still raced their commit.
- The reader is scrolling from a wheel, scroll, or touch event until `scrollend`, or 400 ms without one where
  `scrollend` is missing, and while a finger is down.
- The containment observer skips held rows and observes them again when shown. Screenshot capture, `suspendTrim`, and
  `whenRendered` show held rows at once. Screenshot mode bypasses staging and containment. An `IntersectionObserver`
  contains only distant rows, with measured intrinsic size.
- At the bottom, appends trim only old rows while keeping at least `CHAT_ROW_CAP` (150) plus visible rows and one load
  page; folds, screenshots, jumps, and open editors block trimming.

### Transcript scrolling

- A jump caused by rows mounting above the view is the hold in
  [Transcript rows and the mount hold](#transcript-rows-and-the-mount-hold), not this section.
- Scrolling follows a scroll anchor: `start` keeps a row's top at the scroller's top, `end` keeps the bottom, none
  leaves the position to the reader. The anchor scrolls by measured offset, not `scrollIntoView`, which can move
  ancestor scrollports too. A `ResizeObserver` on the transcript and scroller re-applies the anchor before paint.
- Wheel, touchmove, a press on the scroller itself (its scrollbar), and scroll keys outside inputs release the anchor,
  and so does a jump or screenshot (`suspendTrim`), during which new replies only set the indicator.
- Opening a chat (not folded, captured, or jumping) anchors the newest row's start, or the bottom while it streams.
- With `autoScrollToNewMessage`, a reply that arrives whole (locked or not) anchors its start, and a streamed one
  (`isMessageStreamed`: chunks only, so this tab's or another's stream, and never a continue that has not streamed) the
  bottom until its lock ends, then its start unless `scrollToReplyStartAfterStreaming` is off.
- Both reply anchors apply only while the reader follows (`followsLatest`: an anchor or the bottom, or
  `alwaysScrollToNewMessage`); otherwise a reply sets the new-message indicator.
- A generation that never streamed ends at the newest start only while the anchor holds, so a reader who scrolled is
  left alone. The reader's own send moves an anchored transcript to the bottom.
- Swiped rerolls (`DefaultChatScreen`) anchor the newest start through `scrollToLatestMessage` when the reader followed
  before the swap, as the new-message button does. `openRoute` (a notification) sets `ShowLatestMessageStore`, and the
  screen then shows the newest start even for a chat that was already open.

### Message row

- `Chat.svelte`: one message, with `renderGuiHtmlPart` for custom GUI HTML. Message theme branches are `mobilechat`,
  `cardboard`, `customHTML`, and classic.
- Branching clears `pinned` on the new chat; with `createFolderOnBranch`, a source chat that `chatFolderOf` lists under
  no folder (none, or a dangling `folderId`) and its branch go into a new "Branches of" folder.
- Each row gets its owning `ChatRef` from `Chats.svelte` (`chatRef`; other mounts default to the selection at mount):
  message actions, Lua buttons, manual triggers, and forms address that chat, not the selection at the event. A Lua
  button reloads its row only when its job started, so a refused button keeps typed values beside it.
- A bookmark preview passes no `messageId` and tells the row it streams through `streamingOverride`. Optional
  `pendingReveal` hides the greeting's whole row without changing its layout.
- `isEditing` exposes open original/translation editors to the trim guard. `ChatBody` is keyed only by the reload
  pointer; `whenRendered` loops until the bound body stays the same across its render wait and DOM flush, including
  replacements from `ReloadGUIPointer`.
- A row renders again in place (`chatBodyRevision`) when its chat's first save lands, when its lock ends, and when a
  retry round of failed display transforms includes its message (`cbs-rendering.md`).
- The memory limit line: with `showMemoryLimit`, the row whose message id is its chat's `lastMemory` (the first history
  entry the server's last prompt kept, set before the final token recheck, so it can be off by the entries that recheck
  removed) gets a `memoryLimitThickness` top border; an explicit `isLastMemory={false}` (bookmark previews, the
  greeting) never draws it.
- `ChatBody.svelte`: `markParsing`, which handles translation and parsing, then `{@html}`. `whenRendered` waits for the
  current parse and its DOM update for ordered reveal and screenshot capture, rechecking replacement parses after each
  flush. The rendered auto-translate path's initial empty result is not settled: the wait includes its delayed
  `translated` update and the resulting real parse. Raw streaming settles immediately and remains visible as raw text.
- While a render is pending `ChatBody` shows `lastParsed`; only the newest render (`parseRun`, kept by its retries)
  writes it.
- `TransitionImage.svelte` drops an older `src` that resolves after a newer one.

### Message editors

- Both original-message editors bind a separate `draft`, initialized on opening and cleared on save; a long-press cancel
  keeps the draft for reopening but never changes `message`, the display, partial-edit source, or storage.
- Original and translation edits for stored message rows (`idx >= 0`) automatically open a popup once per edit-mode
  entry unless `settings.ui.disableAutoPopupMessageEditor` is true (Interaction settings, default false). Closing that
  popup writes its text to the draft and saves through `edit()` or `saveTranslationEdit()`; a refused write keeps the
  inline editor open with the draft, without reopening the popup. Translation popup saves suppress another auto popup
  until translation edit mode is left.
- A changed message target (chat ref or message id), changed draft or translation target, ended edit mode, superseded
  session, or destroyed row discards the popup text and closes only its owned session.
- `messageEditPopup.ts` owns the pure eligibility rules and the stable-height rule. Both inline areas retain an expand
  button and popup hotkey regardless of the auto-popup setting.
- With `clickToEdit`, a click on the message body opens the original-message editor, except a click inside a `risu-form`
  form, a `risu-btn` or `risu-trigger` element (any tag), or an interactive control (`input`, `textarea`, `select`,
  `button`, `label`, `a`, contenteditable).

### Context meter

- `src/lib/ChatScreens/ContextMeter.svelte` is the composer's context line, mounted above the composer row (which
  anchors the composer menu) and keyed by the open chat, so a switch starts closed. It is not shown in a group chat or
  while `settings.ui.contextMeter` is off.
- Its source is the newest message whose `generationInfo.context` passes `parseContextReport`
  (`shared/contextReport.ts`, [chat-pipeline](chat-pipeline.md)), scanning only the message list and each message's
  `generationInfo`, so streaming text does not rerun it. With no valid report anywhere it falls back to the newest
  `inputTokens / maxContext`, and with neither it renders nothing.
- The line and the popover share one scale, the prompt budget (`maxContext − maxResponse`). The line's text truncates at
  the end, so the "memory reduced" mark (`memory.budgetReduced`, no per-chat off switch) and the task mark sit outside
  it.
- A lore icon replaces the gauge when the lore budget rejected entries, unless the chat's `loreBudgetWarnOff` is set;
  the popover's lore block sets or unsets it through `setChatMeta`.
- While the chat's background HypaV3 summary task (`memoryTaskStatus`, `src/ts/process/memoryTasks.svelte.ts`) is queued
  or runs, a mark with a spinner shows it. The mark needs a chip to sit beside, which holds since a task is handed off
  only after a send wrote its reply's report.
- The popover's task block says how the task ended: the failure with the redacted error and a memory settings link, or,
  after a task this mount saw run ends `done` with `lastCommittedRevision`, that the new summaries are stored for later
  sends (HypaV3 may defer them while the history fits). The done notice lasts until the meter's source changes, which
  ends it for good.
- The popover (`Portal` to the body) follows the line on resize, scroll, and composer growth, and also closes when its
  source disappears, or when the line leaves view or the viewport is too short to show it.
- While the composer has text (`draft`, passed with `generating` by `DefaultChatScreen`), the line adds a displacement
  estimate ("if sent ≈ −2", "≈ −8+" past the saved trim queue) and the popover an estimate block: `displacement` over
  the report's `trim` ledger with the draft and the last reply counted in `jobTokenScope()` as assembly counts them
  (each without its `<Thoughts>` block, plus `trim.perMessage`; a continue's `replyPrefix` subtracted).
- `estimateBasis` lists when the ledger still describes the next send; configured memory hides the estimate since it may
  run instead of the trim loop. A continue whose overflow reaches the queue's last entry shows none. The reply count is
  kept per basis, so typing recounts only the draft; a new basis or an emptied draft resets the count, and a failed
  count hides the estimate.

### Sidebar

- `Sidebar.svelte`: character rail and folders (`characterOrder`, drag/drop with the `RISU_*` MIME types,
  `checkCharOrder`) plus the settings pane (`SideChatList` | `OpenChatPanel` | `CharConfig` | `DevTool`). The chat tab
  shows `SideChatList` while the chat is closed and `OpenChatPanel` while it is open; the playground chat always shows
  the list.
- The pane publishes its side padding as `--sidebar-gutter`; a child that scrolls itself (the `SideChatList` list, the
  `OpenChatPanel` root) stretches over it with `-mr-(--sidebar-gutter) pr-(--sidebar-gutter)` so its scrollbar sits at
  the pane's edge.
- `statusSets` reads `refusedChatKeys(refusedItems())` from the save adapter's reactive refusal inventory, the chat keys
  of `src/ts/process/chatStatus.svelte.ts`, and `summarizingChats()` from `src/ts/process/memoryTasks.svelte.ts`
  reactively. `characterStatuses` aggregates once per change.
- Top-level characters and members of open folders read their character's status. Collapsed folders use `folderStatus`
  over their members; an open folder has no badge on its own row. `pinnedStatuses` resolves each pinned chat separately.
- A row whose winning status is `memory` shows the count of its only summarizing chat; with several summarizing chats,
  or a queued task, it shows the status without a count.
- `SideChatList.svelte`: chat list, folders, and chat actions. It captures a `ChatRef` before dialogs and re-resolves it
  with `chatEntry` afterward; new chats and JSONL imports open through `changeChatTo`, while JSON/HTML imports only add
  entries. Structure changes go through the chat module. A dangling `folderId` displays at the root and remains stored;
  drag/drop writes a complete chat order.
- `SideChatList`'s Korean-aware filter keeps hidden rows mounted for SortableJS, temporarily disables sorting, and opens
  matching folders without changing `folded`; the character catalog uses the same `matchesAny` helper.
- `PinnedChatsRail.svelte` / `pinnedChats.ts`: collect pinned chats from summaries in character order (folders expanded,
  remaining characters appended), omit trashed characters, and open through `globalApi.openPinnedChat` (select chat
  before character). The same projection supplies home cards.
- `src/lib/SideBars/chatStatus.ts`: priority is recovery → refused → generating → memory task → unseen; only chat
  refusals produce a refused chat badge.
- `OpenChatPanel.svelte`: chat-bound editors capture a `ChatRef` and are recreated for another chat; binding pickers and
  dialogs use that ref. New-chat defaults and translation behavior are documented in [persistence](persistence.md) and
  [media-aux](media-aux.md).
- `DevTool.svelte`: prompt preview via `sendChat(-1, {preview})`. The instruct preview takes the character and user
  names of the chat it was started for, before the await.
- `Toggles.svelte`: per-chat prompt toggles resolve current chat values, legacy globals, and kind defaults;
  `setChatToggle` writes one key. Async actions capture and re-check the `ChatRef`.

### Dialogs, popovers, and portals

- No shared popup component or dismissal helper exists: a new popup copies the nearest pattern, the
  `ContextMeter.svelte` popover (anchored to a trigger), `PopupButton`/`PopupList` (a click menu), `openMenu` (inside
  the composer row), or `MessageSearch.svelte` (a panel `App` mounts).
- `Portal` (`src/lib/UI/GUI/Portal.svelte`) mounts its children on `document.body`, or `target`, keeping the caller's
  contexts. The `isolate` in `ChatScreen.svelte` keeps anything mounted in the chat screen under the app's popups and
  alerts, so a popup that must clear it uses `Portal` or an `App` mount.
- Stacking is plain `z-*` classes: `z-30` the context meter popover, `MessageSearch`, `BookmarkList`, and the composer
  menu; `z-40` `ChatBindingDialog` and `ChatCheckpointsDialog`; `z-[45]` `RecoveryDrafts`; `z-50` alerts, `PopupEditor`,
  and `PopupList`; `z-[60]` `ReloadNotice`. Equal z-indices follow DOM order within one stacking context; body portals
  follow `App`. `topBindingLayer` (`src/ts/gui/dialogLayers.ts`) follows `App`'s dialog/picker order.
- Escape, as in `ContextMeter`, `MessageSearch`, and `BookmarkList`: `<svelte:document onkeydowncapture>`, so it runs
  before the global hotkey listener. It ignores IME composition and returns while `doingAlert()`, `terminalNotice`, or
  `topBindingLayer()` is above, then calls `stopPropagation()` and `preventDefault()` and closes.
- Outside press and focus, in the `ContextMeter` popover: `onpointerdowncapture` outside, or focus leaving both it and
  its trigger, closes it without moving focus; Escape and the Close button return focus to the trigger. `PopupList`
  closes on the next document click.
- `Others/RecoveryDrafts.svelte`: the recovery dialog over [`recoveryDrafts`](draft-recovery.md#recovery-drafts),
  rendered by `ReloadNotice.svelte` while `recoveryDrafts.isOpen`. It stays under alerts so its `alertConfirm`
  confirmations show above it, and keeps key events from reaching app shortcuts. One action runs at a time; Apply
  reports skipped ops.
- `Others/ChatCheckpointsDialog.svelte`: per-chat checkpoints UI. The checkpoint module owns its store and server
  operations. Actions capture the chat and row revision before prompts; a load holds the modal and blocks hotkeys
  through save, request, and refresh. See [checkpoints](chat-store.md#chat-checkpoints).
- `MessageSearch.svelte`: search panel mounted by `App`. It displays snippets as text and opens a hit through
  `openPinnedChat` before requesting the guarded message jump. Search state and shared request types belong to
  [chat-pipeline](chat-pipeline.md); the route is in [server](server-resources.md).
- `PopupEditor.svelte`: popup backed by `popUpEditorStore`, editing in Monaco or a plain textarea.
  `src/ts/gui/popupEditorMode.ts` keeps the choice in this browser's `localStorage` (per device, not synced).
- `openPopupEditorSession` assigns a fresh session id; `App.svelte` keys the mount by that id, resetting the editor,
  preview, and language mode on every session. The popup captures its id once with `untrack`; its backdrop and close
  button call `closePopupEditorSession` with that id.
- The popup's opener owns polling and write-back and closes its own session when invalidated or destroyed; a stale
  opener or popup cannot close a newer session. `open` remains the flag hotkeys use to block preset switching.
- `HypaV3Progress.svelte`: selected-chat memory progress overlay. It shows the newest run belonging to the selected chat
  and restores it after switching back; otherwise it shows the legacy progress notice.
- `HypaV3Modal.svelte`: edits the selected chat's memory copy. It refuses memory edits while the chat is sending or its
  task fence is active and rolls the local edit back. Lore writes are not fenced by background tasks. Fence state, task
  status, and Summarize/Cancel come from `memoryTasks.svelte.ts`, which also feeds the sidebar badges; the protocol,
  revision fences, and outcomes are owned by [memory](memory.md).

### GUI primitives

- `src/lib/UI/GUI/*`: `SelectInput` carries `risu-select`; `SliderInput` takes `-1000` as disabled; `OptionalInput` is
  nullable.
- `SegmentedControl`: buttons carry `aria-pressed`; optional `label` makes the container a named `role="group"`;
  `describedBy` sets `aria-describedby`.
- `TextAreaInput`: textarea or contenteditable with CBS highlight and autocomplete. Both branches support the
  popup-editor hotkey and contextmenu/long-press opening with `settings.ui.longPressToPopupEditor` at every field height
  unless `popupEditor={false}`.
- `TextAreaInput`'s `popupEditor` defaults to `"auto"`: the expand button and its right padding show for heights `"32"`,
  `"36"`, or `"full"`, or `"default"` with `$textAreaSize >= -2`; `true` always shows them, and `false` disables all
  popup access.
- A normal popup close updates the `TextAreaInput` binding, calls `onInput()` and `onchange({ currentTarget })` after
  the DOM binding flush, and refreshes contenteditable highlighting.
- A changed bound value, `popupEditorContext`, or open run discards write-back and closes only the owned session; a
  newer session or component destruction also prevents write-back. The context counts as changed only when its value
  differs (a rerun with the same value, such as a refreshed record list, keeps the popup; away and back still discards).
- A field bound to a record the selection resolves (`activePreset`, `activePersona`, the selected character or chat, the
  HypaV3 preset, a plugin row) passes that record's id as `popupEditorContext`, because the value check alone cannot
  tell two records with the same text apart, and hotkeys and synced lists change the selection under an open popup.
- Wrappers that hold such fields forward `popupEditorContext`: `RegexList`/`RegexData`, `TriggerList`'s Lua editor,
  `PromptDataItem`, `MultiLangInput`, and `SettingTextarea` through `SettingItem.popupEditorContext`.
- `TextAreaResizable`: auto-growing textarea with opt-in `popupEditor` (default false). Popup write-back requires an
  unchanged value and current run/session; destruction closes its owned session. `stableHeight` (default false) skips
  auto-resize and uses a fixed scrollable height.
- `LazyFileSrc`: holds a stored file's URL through `holdFileSrc` only once its wrapper nears the viewport and renders
  its snippet with it. The loading effect releases its hold on a path change or unmount; a reused row waits to be seen
  again. Unpinned fallback object URLs are revoked after the last hold and a short grace period (`global-api.md`). Asset
  list rules belong to [characters](characters-modules.md).
- `LazyCharImage`: defers `getCharImage` until its wrapper nears the viewport and restarts the read on a path change.
  Its optional 256/512 `thumb` class requests server thumbnails through `getCharImage`; catalog, sidebar, pins, and
  persona lists use 256, while chat avatars and active persona/character editors use 512. `cardboard` chat keeps the
  original; editors and asset previews do too.

### Editor token counts

- `CharConfig`, `ChatNoteEditor`, `LoreBookData`, `PromptSettings`, `PromptPresetSettings` (the legacy prompt fields),
  `PopupEditor`, and `PlaygroundTokenizer` count with `createTokenCountField`, as does the `ContextMeter` estimate; see
  [LLM](llm-requests.md).
- Each input carries the tokenizer scope (`tokenCountInput` or `tokenScopeKey`), so switching the main model recounts
  unchanged text: expanded fields compare the expanded text and scope, `ChatNoteEditor` compares raw text and scope (its
  CBS parse stays behind the idle-first scheduling), `PopupEditor` reuses its expanded preview, and the playground names
  its tokenizer.
- The first count runs on open, later edits debounce 400 ms, newer work aborts stale requests, failures preserve the
  last value (the meter instead clears its estimate on failure and counts at once on its first eligible non-empty draft
  or a new basis), and closing or unmounting sends nothing.

### Other UI

- `UI/RefusedDataBanner.svelte` / `UI/refusedData.ts`: partition the save adapter's refusal inventory into a chat banner
  and an app-level pill. The mounted chat registers its `ChatRef`; the app list omits it until unmount, so settings,
  home, or a loading chat unmounts the chat form and returns that refusal to the app list.
- `App` mounts the `app` form beside reload and terminal notices, below alerts. Membership resolves through `chatEntry`,
  including unloaded summaries.
- Record Export downloads `{ kind, id, data }` using only that kind's `SECTION_FIELDS`. Managed credentials, the pending
  secret queue, and client-only character fields are excluded.
- `UI/PopupButton.svelte` writes `popupStore`. `UI/PopupList.svelte` is the fixed-position host mounted by `App`.
- `Mobile/MobileCharacters.svelte`: the list view of the character grid (`Others/GridCatalog.svelte`). There is no
  separate mobile shell; small screens use the desktop layout.

### Theme

- `src/styles.css`: the Tailwind v4 `@theme` tokens map `--color-<name>` to `var(--risu-theme-<name>)`.
- `risu-select` (`src/styles.css`) is unlayered, so its right padding for the chevron overrides Tailwind `px-*`/`pr-*`.
- `.chat-message-container.far` alone uses `content-visibility: auto` and `contain-intrinsic-block-size: auto 240px`.
- `updateColorScheme` also sets the root's inline `color-scheme` from the scheme's `type` (`light`, otherwise `dark`),
  so native controls follow the app scheme instead of the OS; `src/styles.css` `:root` declares `color-scheme: dark` for
  the page before boot. Every scheme change goes through it.

## Flows

- Desktop: `App` → `Sidebar` + `ChatScreen` → `DefaultChatScreen` → `Chats` → `Chat` → `ChatBody`.
- First greeting: rendered as a separate `Chat` with `idx: -1`. `fmIndex: -1` means `firstMessage`. `fmIndex >= 0`
  selects `alternateGreetings[fmIndex]`.
- The chat screen, prompt assembly, the CBS registry, triggers (`v2GetFirstMessage`) and regex `repeatBack` read the
  greeting through `shared/greetings.ts` (`greetingIndex`, `greetingText`, `nextGreetingIndex`,
  `previousGreetingIndex`): a missing, non-integer or out-of-range index reads as -1. Not converted yet:
  `src/ts/characters.ts`, `src/ts/gui/branches.ts` and `src/lib/Others/HypaV3Modal/utils.ts` index `alternateGreetings`
  directly.
- Theme: at boot `bootstrap.ts` calls `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, and
  `updateGuisize`. The display settings call the same functions. Plugins can call them via `apiV3`.

## State

- Components mutate the settings through the record views (`settings.ui.*`, `settingsViews.svelte.ts`) and the
  characters through the character module's records (`selectedCharacter()`, `characterList()`), and rely on the records'
  write-through saves: each write queues the record it changed (`persistence.md`).
- Invalidation signals:
  - `ReloadGUIPointer`: structural changes.
  - `ReloadChatPointer`: message re-render, by `reloadChatKey` (`m:` and the message id; the greeting `i:` and its
    index), so a row keeps its counter when messages before it are added or removed. Mounted row effects subscribe
    through the store; a changed entry remounts only its row.
  - Reassigning an array after an in-place mutation, e.g. `chat.bookmarks = [...]`.
- Theme DB fields: `theme`, `colorScheme`, `colorSchemeName`, `customColorScheme`, `textTheme`, `customCSS`,
  `textAreaSize`, `sideBarSize`, `textAreaTextSize`.

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
- A list of inputs over a list that can change while one of them has focus keys its rows by entry and binds each input
  to the entry captured at mount (getter/setter functions that drop a write once the list no longer holds it), never
  `bind:value={list[i]}` in an unkeyed `#each`: Chrome fires `change` on a focused, edited control while removing it,
  and an index binding resolves `list[i]` at that moment. The lorebook and character asset editors follow this
  ([characters](characters-modules.md) Invariants).
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
  `requestAnimationFrame` where a case needs the frames.
- `ContextMeter.svelte.test.ts` stubs the chip's rectangle (happy-dom has no layout) and the count route: each count is
  one request the test answers when it chooses, so fake timers and deferred answers drive the debounce and the races.
- `src/lib/UI/tests/`: `reactiveProps.svelte.ts` changes a mounted component's props from a `.test.ts` file;
  `LazyCharImageFixture.svelte` awaits the image as real consumers do. `ChatStyleProviderFixture.svelte`
  (`src/lib/ChatScreens/tests/`) provides the `ChatStyleRegistry` the chat screen would.
- Browser scripts: `util/playwright/measureChats.mjs` checks production row counts, memory, and streaming cost;
  `util/playwright/checkSidebarChatStatus.mjs` covers the status badges.
- Not tested: the search-to-transcript claim and scroll wiring, sidebar composition, and mobile interactions need a
  browser check.
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
  recreated, so the selection moves to the end and the undo history is gone. Keeping one model across the switch is a
  larger editor-lifetime change. Observed by the
  [cross-plan review](../audit/cross-plan-2026-10-29.md#noted-not-recommended-to-fix). Decision: text-only toggle
  contract kept, commit `634bc14c7`.
- Older rows do not rerender merely because the chat length changes. Length-dependent CBS updates when that row next
  renders (edit, reload, remount, etc.). Decision: `docs/research/risunest-ideas.md`.

### Gotchas

- `src/lib/ChatScreens/Message.svelte` is an unused TODO rewrite; `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` is
  empty. Confirm intent before extending either.
- `LazyPortal` has no active callers found.
- Reproduce a transcript scroll-animation jump with real X wheel ticks (headed Chrome on WSLg through XTest); CDP
  `Input.dispatchMouseEvent` wheels do not animate.
