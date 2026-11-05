# Global API, Utilities, Alerts

## Scope

- Owns `src/ts/globalApi.svelte.ts`, the client I/O facade, apart from its asset and network functions: save entry
  points (the adapter is owned by resource-sync), writers, chat-fold state, and the exports plugins see.
- Also owns `src/ts/util.ts` helpers (the DOM file pickers and the DPoP keypair store among them), the alert protocol
  (`src/ts/alert.ts`, `src/ts/alertQueue.ts`, and `src/lib/Others/AlertComp.svelte`), the terminal and reload notices,
  `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`, `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`,
  `src/ts/util/koreanSearch.ts`, and the Iris assistant (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Not here:
  - Asset sources, the asset client and queues, and the batch codec → [assets](assets.md).
  - `globalFetch`/`fetchNative` routing, the request log, `auxFetch`, the job client and channel, and Web Push →
    [network-jobs](network-jobs.md).
  - The save format and backends → `persistence.md` (this guide only covers save entry points).

## Files

### Other `globalApi` exports

- `src/ts/globalApi.svelte.ts`, the rest of the facade (each export's comment states its rule): save (`saving`,
  `loadInternalBackup`), writers (`LocalWriter` with the backup record framing `writeBackup`, `VirtualWriter`,
  `BlankWriter`, `AppendableBuffer`), chat and UI (`changeChatTo`, `openPinnedChat`, `createChatCopyName`,
  `toggleFullscreen`, `openURL`), `downloadFile`, and `checkCharOrder`, kept here because plugins see this export.
- The network exports (`globalFetch` with `GlobalFetchArgs`, `fetchNative`, `addFetchLog`, `appendFetchLog`,
  `getFetchLogs`): their routing and the log are [network-jobs](network-jobs.md)'s.
- `src/ts/chatFold.svelte.ts`: `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`, re-exported by the
  facade; see `State`.

### `util.ts`

- `src/ts/util.ts`, the small client helpers. Look up the DOM pickers `selectSingleFile`, `selectMultipleFile`,
  `selectFileByDom`, and the unread-`File` ones `selectSingleFileHandle` (the `.risum` and `.charx` uploads, the VITS
  zip) and `selectMultipleFileHandles` (`savePickedFiles`); the DPoP keypair store `openKeypairStoreDB`,
  `saveKeypairStore`, `getKeypairStore` (see `Invariants`).

### Alert queue

- `src/ts/alertQueue.ts`: `createAlertQueue` (the store `src/ts/stores.svelte.ts` `alertStore` is one instance),
  `AlertQueue`, `AlertDialog`, `NEXT_DIALOG_GAP_MS`, and `createDialogKeyGate` (built in `src/ts/hotkey.ts`
  `initHotkey`). The comments state the status slot, the queue, the gap, the folding, and the stroke rule.
- Dialog keys belong to `src/ts/hotkey.ts` `initHotkey`; `AlertComp.svelte` has no key handler. Its component contract
  covers Escape, Enter, focused buttons and other text fields; a new accepting type extends the Enter branch.

### Alert helpers and `AlertComp`

- `src/ts/alert.ts`, the helpers over the alert slot (module header): `alertData` (field comments name the dialog that
  reads each), `openAlertDialog`, `alertError`, `alertJobError`, `alertConfirm`, `alertConfirmWithCheckbox`,
  `alertSelect`, `alertInput`, `alertCardExport`, `alertRealmTerms`, `alertRequestLogs`, `showHypaV2Alert`, `alertWait`,
  `alertToast` (`onInstall`), `alertClear`, `waitAlert`, `doingAlert`, and `alertStore`, a `set` wrapper over the real
  store.
- `src/lib/Others/AlertComp.svelte` (component contract): renders the head of `alertStore` and answers with
  `alertStore.answer(msg)` or `alertStore.answerConfirm(confirmed, shown)` (`ask`/`pluginconfirm` buttons, Enter for
  `ask`). The latter answers JSON `{ confirmed, checked }` when `confirmCheckbox` is present (`src/ts/alertQueue.ts`).
  It holds the HypaV2 editor and `src/ts/sourcemap.ts` `translateStackTrace`'s stale-trace rule.
- The error alert's "Open in request history" closes the error before opening the history. The request history popup
  (`src/lib/Others/RequestLogs/RequestLogsPopup.svelte`) passes its own close to
  `src/lib/Others/RequestLogs/ServerRequestHistory.svelte`, which closes it before its delete confirmation (and opens it
  again unless the delete failed) and before a share error.

### Terminal and reload notices

Both notices live outside `alertStore`, and both components are mounted unconditionally in `App.svelte`, `ReloadNotice`
before `TerminalNotice`. The comments in `alert.ts` and the components state the rest.

- `alertTerminal(msg)`, `terminalNotice`, `acknowledgeTerminalNotice`: the notice the page ends on (the restore notice),
  shown by `src/lib/Others/TerminalNotice.svelte`, a native modal `<dialog>` in the top layer. No key event leaves it
  for a panel's own `window` listener (a capture listener still sees one), `hotkey.ts` runs no shortcut while it is
  shown, and `terminalNoticeShown()` keeps every key from plugin listeners (`src/ts/plugins/apiV3/v3.svelte.ts`) from
  its opening until reload.
- `alertReloadNotice(msg)`, `reloadNotice`, `dismissReloadNotice`: the save adapter's reload notice (`resourceReloaded`:
  a conflict replaced a local change), shown by `src/lib/Others/ReloadNotice.svelte`, a fixed, non-modal panel above the
  alert overlay (`z-[60]`); the terminal notice covers it.
- While recovery drafts exist and the recovery dialog is closed, `ReloadNotice` also shows the drafts message with its
  own Dismiss and a Review button that opens the [recovery dialog](draft-recovery.md#recovery-drafts)
  (`RecoveryDrafts.svelte`, rendered here outside the notice so Settings can open it after a dismissal;
  [ui-theming](ui-theming.md)).

### Other modules

- `src/ts/util/koreanSearch.ts` (module header): the shared text matcher of list filters and settings search,
  `prepareQuery`, `matchText` (0 or a `MATCH_SCORE` tier), `matchesAny`.
- `src/ts/dragTypes.ts` (module header): the `RISU_*_DRAG_TYPE` custom MIME types that keep in-app drags from being
  treated as file imports.
- `src/ts/iris.ts` `getIrisSystemPrompt` and `src/lib/Others/IrisModal.svelte` (component contract): the Iris assistant,
  its `otherAx` requests, and the `irisDialogue` field.
- `src/ts/sourcemap.ts`, `src/ts/licenses.ts` `CCLicenseData`, `src/ts/util/inlayTokens.ts` `inlayTokenRegex`.

## Flows

Alerts:

1. The caller runs, e.g., `await alertConfirm(msg)`, which queues its dialog in `alertStore` (`open`).
2. `AlertComp` renders it once the dialogs before it closed (`NEXT_DIALOG_GAP_MS` after the previous one).
3. A button, the Enter shortcut (`ask`, `normal`, `error`: `"yes"`), or Escape (`""`) answers the shown dialog
   (`alertStore.answer`).
4. The dialog's `closed` settles with that answer and the helper returns its result from it; the next dialog follows
   after the gap.

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
  `pnpm --silent test:agent src/ts/alert{Queue,Terminal,CardExport}.test.ts src/ts/{sourcemap,util}.test.ts src/ts/util/koreanSearch.test.ts`.
- Typed shared doubles: `src/ts/tests/alertMock.ts` and `src/ts/tests/globalApiMock.ts`.
- Browser specs:
  `pnpm --silent test:agent --e2e e2e/terminalNotice.spec.ts e2e/welcomeAndChatSettings.spec.ts e2e/personaBinding.spec.ts`
  ([test-harness](test-harness.md)). `slow`: none.
- Not tested: the full alert protocol, and most `util.ts` helpers.

## Known Hazards

None recorded.
