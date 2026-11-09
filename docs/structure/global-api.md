# Global API, Utilities, Alerts

## Scope

- Owns `src/ts/globalApi.svelte.ts`, the application-wide client I/O facade, apart from its asset and network functions:
  the `saving` indicator (the adapter is owned by [resource-sync](resource-sync.md)), writers, and chat-fold state. The
  plugin host adapts a subset of these helpers; the plugin API itself is owned by [plugin-sandbox](plugin-sandbox.md).
- Also owns `src/ts/util.ts` helpers (the DOM file pickers and the DPoP keypair store among them), the alert protocol
  (`src/ts/alert.ts`, `src/ts/alertQueue.ts`, and `src/lib/Others/AlertComp.svelte`), the terminal and reload notices,
  `src/ts/sourcemap.ts`, `src/ts/dragTypes.ts`, `src/ts/licenses.ts`, `src/ts/util/inlayTokens.ts`,
  `src/ts/util/koreanSearch.ts`, and the Iris assistant (`src/ts/iris.ts`, `src/lib/Others/IrisModal.svelte`).
- Not here:
  - Asset sources, the asset client and queues, and the batch codec → [assets](assets.md).
  - `globalFetch`/`fetchNative` routing, the request log, `auxFetch`, the job client and channel, and Web Push →
    [network-jobs](network-jobs.md).
  - Save entry points and synchronization → [resource-sync](resource-sync.md); persisted formats →
    [persistence](persistence.md).

## Files

### Other `globalApi` exports

- `src/ts/globalApi.svelte.ts`: the application-wide facade. Read export comments for the save activity indicator
  (`saving`), writers (`LocalWriter`, `VirtualWriter`, `BlankWriter`, `AppendableBuffer`), chat navigation
  (`changeChatTo`, `openPinnedChat`, `createChatCopyName`), `downloadFile`, `openURL`, and `toggleFullscreen`.
- Other visible helpers include `getLanguageCodes` (translation and subtitle pickers), `getVersionString` (the
  compatibility version shown in the UI), and `aiLawApplies` (whether the chat screens show the AI disclosure: it
  returns `aiDisclosureEnabled` from `src/ts/platform.ts`, the page flag the server sets from `RISU_AI_DISCLOSURE`).
  `checkCharOrder` is re-exported from this facade; its implementation belongs to `src/ts/storage/characterOrder.ts`.
- The network exports (`globalFetch` with `GlobalFetchArgs`, `fetchNative`, `addFetchLog`, `appendFetchLog`,
  `getFetchLogs`): their routing and the log are [network-jobs](network-jobs.md)'s.
- `src/ts/chatFold.svelte.ts`: `chatFoldedState`, `chatFoldedStateMessageIndex`, `foldChatToMessage`, re-exported by the
  facade; see `State`.

### `util.ts`

- `src/ts/util.ts`: DOM file pickers (`selectSingleFile`, `selectMultipleFile`, `selectFileByDom`,
  `selectSingleFileHandle`, `selectMultipleFileHandles`) and the DPoP keypair store (`openKeypairStoreDB`,
  `saveKeypairStore`, `getKeypairStore`; see `Invariants`).

### Alert queue

- `src/ts/alertQueue.ts`: `createAlertQueue`, `AlertQueue`, `AlertDialog`, `NEXT_DIALOG_GAP_MS`, and
  `createDialogKeyGate`. `src/ts/hotkey.ts` `initHotkey` feeds the key gate; the queue and component comments own
  timing, cancellation, and keyboard behavior.

### Alert helpers and `AlertComp`

- `src/ts/alert.ts`, the helpers over the alert slot (module header): `alertData` (field comments name the dialog that
  reads each), `openAlertDialog`, `alertError`, `alertJobError`, `alertConfirm`, `alertConfirmWithCheckbox`,
  `alertSelect`, `alertInput`, `alertCardExport`, `alertRealmTerms`, `alertRequestLogs`, `showHypaV2Alert`, `alertWait`,
  `alertToast` (`onInstall`), `alertClear`, `waitAlert`, `doingAlert`, and `alertStore`, a `set` wrapper over the real
  store.
- `src/lib/Others/AlertComp.svelte` renders and answers the queued alert; its component contract covers keyboard
  handling and `src/ts/sourcemap.ts` `translateStackTrace`'s stale-trace rule. Every branch paints at `z-1100`, above a
  plugin's full-screen container (`showContainer`, `z-index: 1000`); `ReloadNotice.svelte` sits above that layer.
  Checkbox answers and the HypaV2 editor are documented on `src/ts/alert.ts` `alertConfirmWithCheckbox` and
  `showHypaV2Alert`.
- The error alert closes before opening request history. The viewer also closes around its delete confirmation and share
  errors; see `src/lib/Others/RequestLogs/RequestLogsPopup.svelte` and
  `src/lib/Others/RequestLogs/ServerRequestHistory.svelte` for that UI handoff.

### Terminal and reload notices

Both notices live outside `alertStore`; `src/App.svelte` mounts `ReloadNotice` before `TerminalNotice`. Their entrypoint
comments own the notice lifetimes and input behavior.

- `alertTerminal(msg)`, `terminalNotice`, `acknowledgeTerminalNotice`: the restore notice shown by
  `src/lib/Others/TerminalNotice.svelte`; see its component and `src/ts/hotkey.ts` comments for modal input handling.
  `terminalNoticeShown` in `alert.ts` also blocks plugin key listeners until reload.
- `alertReloadNotice(msg)`, `reloadNotice`, `dismissReloadNotice`: the save adapter's reload notice shown by
  `src/lib/Others/ReloadNotice.svelte`; its component comment owns its layering and dismissal behavior.
- `src/ts/storage/resourceSync.svelte.ts` emits the `resourceReloaded` notice; save and conflict behavior is in
  [resource-sync](resource-sync.md).
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
- `shared/textHash.ts` `textHash`: the one cyrb53 copy (not a security boundary), 14 hex digits by default, unpadded
  base 36 for the completion notification tag and `historyDigest`, whose outputs must not change.

## Flows

`alert.ts` helpers enqueue dialogs in `alertStore`; `AlertComp` answers the visible dialog, which settles that caller
before the queue advances. See `alertQueue.ts`, `hotkey.ts`, and `AlertComp.svelte` comments for ordering and key rules.

## State

- `src/ts/chatFold.svelte.ts` owns the fold target and synchronous message index; its module comments explain when the
  target clears and why a read cannot expose another chat's fold.

## Coupling

- `globalApi.svelte.ts` imports `database.svelte.ts`, `storage/assetClient.ts`, `stores.svelte.ts`, alerts,
  `characterCards.ts` (`characterURLImport`), and the network helpers. It re-exports `storage/resourceSync.svelte.ts`,
  `storage/characterOrder.ts`, and `chatFold.svelte.ts`.

## Invariants

- Each dialog close path must answer it (`alertStore.answer`; `set({ type: 'none' })` closes the shown dialog too), or
  the awaiting caller hangs forever. A status writer ends its status with `alertClear()`, never a `none` write, which
  would answer a dialog that appeared meanwhile.
  - An alert opened from inside a shown dialog (a popup's own confirmation) queues behind it: close the owning dialog
    first.
  - `alertSelect` encodes options joined with `||`.
  - `alertConfirm` returns true only for the exact `'yes'`.
- Preserve the non-extractable signing key created by `src/ts/storage/serverAuth.ts` when changing the `src/ts/util.ts`
  keypair store; `public/sw.js` reads the same stored key.

## Recipes

- Add an alert:
  1. Extend `alertData` and add a helper in `alert.ts`.
  2. Add a render and resolve branch in `AlertComp.svelte`; an outer branch must also be excluded from its first guard.
     Its overlay uses `z-1100`; a branch that renders another component wraps it in a positioned `z-1100` box
     (`display: contents` forms no stacking context).
  3. For a new Enter answer, extend the branch in `src/ts/hotkey.ts`. Escape needs no edit.
- Change save behavior: [`storage/resourceSync.svelte.ts`](resource-sync.md#save-cycle) and the records
  (`storage/records.svelte.ts`). See `persistence.md`.

## Tests

- Vitest:
  `pnpm --silent test:agent src/ts/alert{Queue,Terminal,CardExport}.test.ts src/ts/{sourcemap,util,globalApiDisclosure}.test.ts src/ts/util/koreanSearch.test.ts`.
- Typed shared doubles: `src/ts/tests/alertMock.ts` and `src/ts/tests/globalApiMock.ts`.
- Browser specs:
  `pnpm --silent test:agent --e2e e2e/terminalNotice.spec.ts e2e/welcomeAndChatSettings.spec.ts e2e/personaBinding.spec.ts`;
  `e2e/pluginSandbox.spec.ts` checks the alert layer above a plugin's full-screen container
  ([test-harness](test-harness.md)). `slow`: none.
- Not tested: the full alert protocol, and most `util.ts` helpers.

## Known Hazards

### Limitations

- The AI disclosure (`aiLawApplies`: the empty-chat warning, the request-info disclaimer, and the chat row's model
  button regardless of `requestInfoInsideChat`) is off unless the operator sets `RISU_AI_DISCLOSURE`; upstream shows it
  unconditionally. Changing the variable needs a server restart and a page reload. Decision: owner, 2026-11-08.
