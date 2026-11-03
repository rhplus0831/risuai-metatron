# Global API, Utilities, Alerts

## Scope

- Owns `src/ts/globalApi.svelte.ts`, the client I/O facade, apart from its asset and network functions: save entry
  points (the adapter is owned by resource-sync), writers, chat-fold state, and the exports plugins see.
- Also owns `src/ts/util.ts` helpers, the alert protocol (`src/ts/alert.ts`, `src/ts/alertQueue.ts`, and
  `src/lib/Others/AlertComp.svelte`), the terminal and reload notices, `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`,
  `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`, `src/ts/util/koreanSearch.ts`, and the Iris assistant
  (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Not here:
  - Asset sources, the asset client and queues, and the batch codec → [assets](assets.md).
  - `globalFetch`/`fetchNative` routing, the request log, `auxFetch`, the job client and channel, and Web Push →
    [network-jobs](network-jobs.md).
  - The save format and backends → `persistence.md` (this guide only covers save entry points).

## Files

### Other `globalApi` exports

- Save: `saving` (indicator state, re-exported from the adapter); `loadInternalBackup`.
- Network: `globalFetch(url, GlobalFetchArgs)` is buffered and returns `{ok,data,headers,status}`;
  `fetchNative(url, args)` returns a `Response` or stream; `addFetchLog`, `appendFetchLog`, `getFetchLogs`; `openURL`.
  Their routing and the log: [network-jobs](network-jobs.md).
- Writers: `LocalWriter` (the backup record framing `writeBackup`, streamed through `streamsaver`), `VirtualWriter`,
  `BlankWriter`, `AppendableBuffer`.
- Chat and UI: `changeChatTo` and `openPinnedChat` (shared home/rail navigation by `{ chaId, chatId }`) select per tab;
  `createChatCopyName`, `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`, `toggleFullscreen`.
- `checkCharOrder`: re-exported from `storage/characterOrder.ts` (the character module calls it without importing this
  file) because plugins see this export.

### `util.ts`

`src/ts/util.ts` is the inventory of small helpers: messages and characters, persona accessors, crypto, text, tag lists,
and the rest. What a caller must know:

- `selectSingleFile`, `selectMultipleFile`, and `selectFileByDom` use the DOM picker. `selectSingleFileHandle` gives the
  picked `File` unread, or `null`: the module dialog's `.risum` and `.charx` imports upload it as it is, and the VITS
  model import reads its zip by slices. `selectMultipleFileHandles` gives the `File`s unread, `[]` when none: the asset
  pickers save them with `savePickedFiles`.
- `openKeypairStoreDB`/`saveKeypairStore`/`getKeypairStore`: IndexedDB `DPoPDB` store `dpop`.

### Alert queue

`src/ts/alertQueue.ts`: `createAlertQueue` (the store `stores.svelte.ts:alertStore` is one instance) and
`createDialogKeyGate` (built in `src/ts/hotkey.ts` `initHotkey`). The `AlertQueue` interface comments state each method.

- The alert slot holds one status (`wait`, `progress`, `toast`: the newest replaces it) and a first-in, first-out queue
  of dialogs (every other type), shown one at a time. A dialog supersedes the status set before it, not one set after
  it, which shows once the dialogs close.
- After a dialog closes, the next one shows `NEXT_DIALOG_GAP_MS` (150 ms) later, also one opened after the close;
  meanwhile the store reads `none` with `dialogPending`.
- An identical `normal`, `error`, `markdown` or `wait2` right behind the last queued dialog folds into it (same handle;
  never an error with `jobFailure`).
- The key gate lets a dialog take Enter or Escape only from a stroke that began after it appeared: never a repeat, the
  stroke held when it appeared, or a composing key.
- `hotkey.ts` owns dialog keys; `AlertComp.svelte` has no key handler. Escape answers every dialog with `""`. Enter
  answers `ask`, `normal`, `error`, and an `input` dialog's value; a new accepting type extends that branch.

### Alert helpers and `AlertComp`

`src/ts/alert.ts`:

- `alertData` (discriminated `type`), with optional `chaId` for Branches and `chatRef` for HypaV2. Each target is
  captured when requested, before the dialog waits in the queue.
- Each dialog helper queues its dialog; an awaited one resolves with its own dialog's answer.
- `alertRealmTerms`: true only for Accept. Enter does not accept it; Escape declines.
- `alertCardExport`, character export only: an empty answer (including Escape) returns `{ type: "cancel", type2: "" }`,
  matching the close button's cancel shape; callers ignore the format on cancellation.
- `alertRequestLogs` is the request logs popup.
- `showHypaV2Alert` captures `currentChatRef`; its editor reads `findChat(ref)` and writes `setChatMeta(ref, ...)`,
  showing no editor and writing nothing while that chat is unloaded or has no HypaV2 data.
- `alertWait` and `alertToast` accept an optional `onInstall` callback that captures the exact status object for
  identity-checked cleanup. `alertStore` (here) is a `set` wrapper over the real store `stores.svelte.ts:alertStore`.

`src/lib/Others/AlertComp.svelte` renders the head of `alertStore` (the shown dialog, else the status) and answers a
dialog with `alertStore.answer(msg)`.

- The error alert's "Open in request history" closes the error before opening the history. The request history popup
  passes its own close to `ServerRequestHistory.svelte`, which closes it before its delete confirmation (then opens it
  again) and before a share error.
- `sourcemap.ts:translateStackTrace` translates stack traces; a translation (or its failure) that ends after the shown
  alert changed is dropped, so it never lands in a later error.

### Terminal and reload notices

Both notices live outside `alertStore`, and both components are mounted unconditionally in `App.svelte`, `ReloadNotice`
before `TerminalNotice`. The comments in `alert.ts` and the components state the rest.

- `alertTerminal(msg)`, `terminalNotice`, `acknowledgeTerminalNotice`: the notice the page ends on (the restore notice).
  It resolves only when the user acknowledges it, so no other alert (a toast, an error, `alertClear`, a `wait`) can
  replace or dismiss it. `terminalNoticeShown()` blocks plugin key listeners from opening until reload.
- `src/lib/Others/TerminalNotice.svelte`: a native modal `<dialog>` (the top layer, above every z-index; the page
  inert). Only its OK acknowledges it.
- No key event leaves the terminal dialog: a panel's own `window` listener behind it never sees one, while a capture
  listener still does. `hotkey.ts` runs no shortcut while it is shown.
- `alertReloadNotice(msg)`, `reloadNotice`, `dismissReloadNotice`: the save adapter's reload notice (`resourceReloaded`:
  a conflict replaced a local change). Latched until dismissed: one notice per episode on screen.
- `src/lib/Others/ReloadNotice.svelte`: a fixed, non-modal panel (`role="status"`) above the alert overlay (`z-[60]`).
  The page behind it stays live. The terminal notice covers it.
- While recovery drafts exist and the recovery dialog is closed, `ReloadNotice` also shows the drafts message with its
  own Dismiss and a Review button that opens the [recovery dialog](draft-recovery.md#recovery-drafts)
  (`RecoveryDrafts.svelte`, rendered here outside the notice so Settings can open it after a dismissal;
  [ui-theming](ui-theming.md)).

### Other modules

- `src/ts/util/koreanSearch.ts` (client only, over `es-hangul`): the shared text matcher of list filters and settings
  search, with `prepareQuery`, `matchText` (0 or a `MATCH_SCORE` tier), and `matchesAny` as the lists' boolean. An
  all-choseong query takes no later tier, and romanized queries are not matched. Derived forms of a text are computed
  per call, never cached by text.
- `src/ts/dragTypes.ts`: `RISU_*_DRAG_TYPE` custom MIME types. They keep in-app drags from being treated as file
  imports.
- `src/ts/iris.ts` `getIrisSystemPrompt`, and `IrisModal.svelte`: a visual-novel-style assistant. It calls
  `requestChatData(..., 'otherAx')` and persists the dialogue in `irisDialogue`, a `ui` field saved on the server; older
  browser copies are imported at boot.

## Flows

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which queues its dialog in `alertStore` (`open`).
2. `AlertComp` renders it once the dialogs before it closed (`NEXT_DIALOG_GAP_MS` after the previous one).
3. A button, Enter (`ask`, `normal`, `error`: `"yes"`), or Escape (`""`) answers the shown dialog (`alertStore.answer`).
4. The dialog's `closed` resolves the helper with that answer; the next dialog follows after the gap.

## State

- `chatFoldedState.data` is `{targetCharacterId, targetChatId, targetMessageId}` (`src/ts/chatFold.svelte.ts`,
  re-exported here). `chatFoldedStateMessageIndex.index` is derived synchronously: the target message's index while the
  fold targets the selected chat, else -1, so a reader that runs before the switch effect clears `data` never sees
  another chat's fold.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/resourceSync.svelte.ts`, `storage/resourceClient.ts`,
  `stores.svelte.ts`, alerts, `characterCards.ts` (`characterURLImport`), and the network helpers.

## Invariants

- Each dialog close path must answer it (`alertStore.answer`; `set({ type: 'none' })` closes the shown dialog too), or
  the awaiting caller hangs forever. A status writer ends its status with `alertClear()`, never a `none` write, which
  would answer a dialog that appeared meanwhile.
  - An alert opened from inside a shown dialog (a popup's own confirmation) queues behind it: close the owning dialog
    first.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Keep the keypair stored by `util.ts:saveKeypairStore` non-extractable. `storage/serverAuth.ts` keeps its JWT signing
  key in IndexedDB `DPoPDB`, store `node`, record `dpop`; keep that format.

## Recipes

- Add an alert:
  1. Extend `alertData` and add a helper in `alert.ts`.
  2. Add a render and resolve branch in `AlertComp.svelte`; an outer branch must also be excluded from its first guard.
  3. For a new Enter answer, extend the branch in `src/ts/hotkey.ts`. Escape needs no edit.
- Change save behavior: [`storage/resourceSync.svelte.ts`](resource-sync.md#save-cycle) and the records
  (`storage/records.svelte.ts`). See `persistence.md`.

## Tests

- Vitest:
  `pnpm --silent test:agent src/ts/alert{Queue,Terminal,CardExport}.test.ts src/ts/sourcemap.test.ts src/ts/util/koreanSearch.test.ts`.
- Typed shared doubles: `src/ts/tests/alertMock.ts` and `src/ts/tests/globalApiMock.ts`.
- Browser specs:
  `pnpm --silent test:agent --e2e e2e/terminalNotice.spec.ts e2e/welcomeAndChatSettings.spec.ts e2e/personaBinding.spec.ts`
  ([test-harness](test-harness.md)). `slow`: none.
- Not tested: the full alert protocol, and `util.ts`.

## Known Hazards

None recorded: the asset and job hazards moved with [assets](assets.md) and [network-jobs](network-jobs.md).
