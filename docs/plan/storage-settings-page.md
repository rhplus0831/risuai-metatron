# Storage Settings Page Plan

Status: drafted 2026-11-07; landed: A (9f7094ec6), E (28a0d02bf). Source: the same day's design discussion with
the owner over `src/lib/Setting/Pages/Advanced/StoragePanel.svelte`, the [settings-i18n](../structure/settings-i18n.md),
[app-shell](../structure/app-shell.md), [assets](../structure/assets.md) and
[self-host-server](../structure/self-host-server.md) guides. Every design decision below is the owner's answer from that
discussion; no slice waits on a question. Line numbers are from `e89a8582a`; identifiers are the anchors. Re-verify each
cited location before editing (STRUCTURE.md protocol step 5).

## Problem

Settings → Advanced → Storage (`advanced.storage` in `src/ts/setting/advancedSettingsData.ts` ~330, one custom item
`adv.storagePanel` rendering `StoragePanel.svelte`, 502 lines) is one long column inside a page about unrelated toggles:

1. Eighteen totals of equal weight in one grid (`totals`, `StoragePanel.svelte` ~56–79). Disk free and total, usage by
   kind, dedupe statistics and cleanup counts are mixed; neither "is my disk fine" nor "how much can I free" reads at a
   glance. `usage.unmanaged` ("관리 외 기타 파일") reads as "every other file on the disk", but it is only files in
   `save/assets/` whose names do not decode as asset keys (`listAssetFiles`, `server/src/routes/backups.ts` ~747).
   Nothing shows the space the disk uses outside the measured folders.
2. Cleanup candidates are hash keys only, all selected by default (`applyReport` ~103), with no select-none, filter or
   sort. The user cannot see what they are deleting.
3. Each snapshot is a five-field `dl` plus four buttons; pinning is text.
4. Settings → Backups → "Load internal backup" (`loadInternalBackup`, `src/ts/globalApi.svelte.ts` ~1279) lists the same
   server snapshots (`listBackups` / `restoreBackup`) through an `alertSelect` of dates, with hardcoded `"Cancel"` and
   `"Loaded backup"`.
5. A preview cannot use the asset route: every `GET /api/asset/*`, thumbnails included, calls `bumpAssetLease`
   (`server/src/routes/storage.ts` ~656), and the sweep skips a leased file (`reason = "leased"`,
   `server/src/data/assetLifecycle.ts` ~1283) for `ASSET_LEASE_MS` (one hour). Previewing a candidate would keep it
   from being deleted.

## Design decisions

- **D1 Placement.** Storage becomes its own settings page: `STORAGE_SETTINGS_MENU = 23` in `src/ts/settingsMenu.ts`,
  slug `storage` in `SETTINGS_PAGES` (`src/ts/router/routes.ts` ~27), an entry in the `data` nav group of
  `src/lib/Setting/Settings.svelte` (~141) after Backups with lucide `HardDriveIcon`, and its page in the menu branch
  (~333). The `advanced.storage` section and the `adv.storagePanel` item leave the Advanced page. The page is
  sectioned (`SettingsSections`), so search hits and section jumps work as on Advanced.
- **D2 Sections.** In order: `storage.overview` (always open), `storage.cleanup` (open), `storage.snapshots` (open),
  `storage.owners` (collapsible, closed), `storage.details` (collapsible, closed). Each holds one custom item. The
  sections share one controller (report, snapshots, busy, polling, actions), created by the page and reached through
  Svelte context, so polling starts and stops with the page, not with a section.
- **D3 Overview.** The heading row holds the last scan time and the Scan button (and the scanning and error states).
  Below it, one stacked bar over `disk.total`: assets, resources DB, snapshots, thumbnails, staging and unrecognized
  asset-folder files as separate segments (no "other" bucket), then **used outside RisuAI** =
  `disk.total − disk.free − Σ measured usage`, computed in the client and drawn hatched gray (not drawn when ≤ 0, for
  example snapshots on another mount), then free. Its help text names what it holds: other programs, files in `save/`
  outside the measured folders, and filesystem-reserved blocks (`bavail` excludes them,
  `server/src/http/diskSpace.ts` ~18). With `disk === null` the bar shows the measured segments only and says the disk
  size is unknown. Three cards: reclaimable (`unreferenced.pastGrace.bytes`), snapshots (count and
  `usage.snapshots`), saved by dedupe (`referenced.savings`).
- **D4 Labels.** `storage.unmanaged` becomes "Unrecognized files in assets" / "에셋 폴더의 인식되지 않은 파일".
- **D5 Details and owners.** The eighteen totals move unchanged into `storage.details`. `storage.owners` shows the
  top ten owners by bytes with a proportional bar and a "show all" toggle, replacing the table.
- **D6 Cleanup list.** Default selection is **none** (the owner's choice: a previewable list is chosen, not
  accepted). Kind chips with counts (image, audio, video, other, from `assetExtension` / `assetMimeType` in
  `shared/assetMime.ts`), sort by size (default) or age, a summary row with "select all" (the filtered rows),
  "clear", the selected count and bytes, and the danger-styled delete. Each row: a preview (images only, D8) or a
  kind icon, extension and size, "unused for N days" from `since`, and the short hash in mono. Orphan inlays follow in
  the same row shape, previewing their `asset` when it is an image. The "showing N of M" notes, confirmations, and
  deleted/skipped results stay as they are.
- **D7 Snapshots.** One-line rows: pin icon (toggles), label or "no label", created time, size, held bytes, and a
  `⋯` menu with edit label (inline in the row), restore, delete. The take-snapshot input and button sit in the
  section heading row. Confirmations, restore reload and epoch-conflict notice stay as they are.
- **D8 Preview route.** `GET /api/assets/preview/<hex>` (constant `ASSET_PREVIEW_PATH` in
  `shared/assetLifecycle.ts`) serves an image preview of a key the latest report lists for deletion, **without**
  touching the lease. Rules:
  - Admission: auth as the other lifecycle routes, the storage rate-limit bucket, `no-store`. The key must be in the
    lifecycle's current past-grace candidate set (the `candidates` map, not the capped report list) or be the `asset`
    of a current orphan-inlay candidate; anything else answers 404. A running scan or sweep does not change the
    answer for keys still in the set.
  - Images only: `assetMimeType` must start with `image/` and the extension must not be active
    (`isActiveAssetExtension`); otherwise 404. Audio and video get no preview (owner's choice).
  - Bytes: the 256 thumbnail through the existing `ThumbnailService.get`; when it answers `original`, the original
    bytes with the image MIME type, `inline`, under the same CSP and `nosniff` headers as `/api/asset/*`
    (`assetHeaders`). Never a redirect to `/api/asset/*` (that would lease it). Thumbnail `unavailable`, `busy` or
    error answer 404 so the client falls back to the icon.
  - Never calls `bumpAssetLease`, never claims, never verifies (`assetVerification.request`).
  - Open and thumbnail generation run under `withAssetLocks([fullPath])`, so a preview racing a sweep either finishes
    before the unlink (the sweep's `removeKey` then drops the cache entry) or finds the file gone: no thumbnail
    cache entry outlives its asset.
- **D9 Client preview loading.** Not through `getFileSrc` / `holdFileSrc` (they target `/api/asset/*`). A preview
  helper in `src/ts/storage/assetLifecycleClient.ts` fetches `ASSET_PREVIEW_PATH` with `authFetch`, returns a blob URL
  and a release; rows load it when visible (IntersectionObserver), at most four at once, and revoke on unmount or
  when the row leaves the list. A failed preview shows the kind icon, with no error banner.
- **D10 Backups link.** The "Load internal backup" button on Settings → Backups (`UserSettings.svelte` ~61) becomes a
  link that opens the Storage page at `storage.snapshots` through the same jump the search uses (`openSetting` in
  `src/ts/setting/settingJump.svelte.ts` with a section hit). `loadInternalBackup` and its `globalApiMock.ts` entry are
  removed; its guide mentions move to the Storage page.
- **D11 Strings.** New strings live in a new top-level `language.storagePage` object in `src/lang/en.ts` with one
  sub-object per section (`overview`, `cleanup`, `snapshots`, `owners`, `details`). Slice A creates the object with
  the section titles and the nav label; B, C and D add keys only inside their own sub-objects, so parallel slices do
  not edit the same lines. Korean overrides go in `src/lang/ko.ts` the same way. Existing `language.storage.*` keys stay
  where they are; D4 edits one value.

## Rules for every slice

- One slice is one session and one commit. Workflow by size: `opus-lite` for _small_, `opus-workflow` for _hard_. No
  Codex challenger for a routine slice; a slice that thinks it needs one stops with `QUESTION`.
- Full checks after the last source edit: `pnpm check`, `pnpm --silent test:agent` (the full gate), `pnpm check:docs`,
  `pnpm format:check`, and `pnpm check:tests` when a test file is added or moved. Then the slice's own browser check if
  it names one. While iterating, run only the focused tests the slice names.
- `util/playwright/checkAssetLifecycle.mjs` drives the Storage UI (`openStorage` ~104 sets `SettingsMenuIndex` 6 and
  waits for `[data-settings-section="advanced.storage"]`; its cases click "Scan", "Delete selected assets" and the inlay
  delete by role and name). A slice that changes those selectors, labels or default selection updates the script in
  the same commit and runs it against the dev stack. One dev stack at a time per machine, and no Vitest beside it.
- UI uses the theme tokens (STRUCTURE.md U1), strings through `language` (U2), confirmations through
  `src/ts/alert.ts` (U3). Rows must fit a phone width without horizontal scroll.
- Guides: the docs tree is at 762,494 of 762,500 bytes (`check:docs`, 2026-11-07). Every guide edit is net zero or
  smaller in the same guide: trim as many bytes nearby as the edit adds. Guides never link this plan.
- Do not edit this plan or `docs/plan/README.md`; the runner marks slices landed.

## Order

- A and E first, in parallel: A is client-only, E is server plus `shared/assetLifecycle.ts`; their files are disjoint.
- B, C and D after A; C also after E. B, C and D may run in parallel: each owns its own section component and its
  own `language.storagePage` sub-object. Shared files among them: `src/lang/en.ts` / `ko.ts` (separate sub-objects),
  `docs/structure/settings-i18n.md` (rebase), and `checkAssetLifecycle.mjs` (only C changes it after A).
- Sizes: A _hard_, B _small_, C _hard_, D _small_, E _hard_.

## Slices

- **A. The Storage page and its controller** (_hard_; `settings-i18n.md` owns the page, nav, search and data file,
  `app-shell.md` the slug; D1, D2, D11).
  _Files_: `src/ts/settingsMenu.ts`, `src/ts/router/routes.ts` (+ `router.test.ts` if it enumerates slugs),
  `src/lib/Setting/Settings.svelte`, new `src/ts/setting/storageSettingsData.ts` (header and the five sections, each
  one custom item), `src/ts/setting/customComponents.ts`, `src/ts/setting/searchIndex.ts` (`placeItems` /
  `placeSections` with `menu: 23`, a `PAGES` entry labelled `storagePage.title`),
  `src/ts/setting/advancedSettingsData.ts` (drop `advanced.storage` and `adv.storagePanel`; keep its keywords on the new
  page's items), new `src/lib/Setting/Pages/StorageSettings.svelte`, new `src/lib/Setting/Pages/Storage/`:
  `storageController.svelte.ts` (the state and actions of `StoragePanel.svelte` ~33–270 moved verbatim into a class:
  `load`, `poll`, `runAction`, `scan`, `deleteAssets`, `deleteInlays`, `take`, `pin`, `saveLabel`, `removeSnapshot`,
  `restore`, `unreadable`, `dispose`), a context getter, and five section components
  (`StorageOverview`, `StorageCleanup`, `StorageSnapshots`, `StorageOwners`, `StorageDetails`) holding today's markup
  for their part, unchanged in look. `StoragePanel.svelte` is deleted; `StoragePanel.test.ts` moves to
  `src/lib/Setting/Pages/Storage/` as controller tests plus one page mount test, keeping every case.
  `src/ts/setting/settingsPageSections.test.ts` `PAGES` gains the storage page. `e2e/settingsPages.spec.ts` (~42) adds
  `[23, "storage"]`. `util/playwright/checkAssetLifecycle.mjs` `openStorage` opens menu 23 and waits for the cleanup
  section; the panel locator spans the page. `src/lang/en.ts` / `ko.ts`: `storagePage` with `title`, a nav label,
  and each sub-object's `title` (and `description` where today's section had one: reuse
  `settingsSectionStorageDesc`'s text on the page header, then remove `settingsSectionStorage*`).
  _Done_: Storage opens from the nav, from `/settings/storage`, and from a search for "storage", "snapshot" or
  "스냅샷", landing on the right section; Advanced no longer shows it; leaving the page stops polling (a controller test
  with fake timers); the controller tests cover every former `StoragePanel.test.ts` case.
  _Guides_: `settings-i18n.md` Pages and Settings navigation name the new page, folder and menu; `app-shell.md` the
  slug if it lists slugs; `assets.md` line 44 says "Storage page".
  _Test_: `pnpm --silent test:agent src/lib/Setting src/ts/setting src/ts/router`, then
  `pnpm --silent test:agent --e2e e2e/settingsPages.spec.ts` and `node util/playwright/checkAssetLifecycle.mjs`.

- **B. Overview, details and owners** (_small_; `settings-i18n.md`; D3, D4, D5).
  _Files_: `StorageOverview.svelte`, `StorageDetails.svelte`, `StorageOwners.svelte` under
  `src/lib/Setting/Pages/Storage/`, a pure `storageUsage.ts` there (segments, the outside-RisuAI gap clamped at zero,
  the three card values, top-N owners), its test, the page header row (`StorageSettings.svelte`) for the scan time
  and button, `language.storagePage.overview` / `.owners` / `.details`, and D4's `storage.unmanaged` values.
  _Done_: the bar's segments and gap match `storageUsage.ts` for a report with and without `disk`, with a negative gap,
  and with zero usage; details shows the same eighteen values as before; owners shows ten then all.
  _Test_: `pnpm --silent test:agent src/lib/Setting/Pages/Storage`.

- **C. The cleanup list with previews** (_hard_; `settings-i18n.md` the section, `assets.md` the preview helper;
  D6, D9; needs A and E).
  _Files_: `StorageCleanup.svelte` (and row components beside it), `src/ts/storage/assetLifecycleClient.ts`
  (`loadAssetPreview(key) → { src, release }` over `ASSET_PREVIEW_PATH`, `authFetch`, at most four in flight), its test
  in `src/ts/storage/tests/assetLifecycleClient.test.ts`, the controller's selection (`applyReport` selects nothing;
  selection survives a report refresh only for keys still listed), `language.storagePage.cleanup`, and
  `util/playwright/checkAssetLifecycle.mjs` (select before deleting, since nothing is preselected).
  _Done_: default selection empty; select all selects only the filtered rows; delete sends exactly the selected keys
  and inlays; an image row shows its preview and a sweep right after previewing deletes it (no `leased` skip; assert in
  the browser check's deletion case); a failed preview shows the icon; previews revoke on unmount.
  _Test_: `pnpm --silent test:agent src/lib/Setting/Pages/Storage src/ts/storage/tests/assetLifecycleClient.test.ts`,
  then `node util/playwright/checkAssetLifecycle.mjs`.

- **D. Snapshot rows and the Backups link** (_small_; `settings-i18n.md`, `backup-sync-hub.md`,
  `resource-sync.md`, `global-api.md` name `loadInternalBackup`; D7, D10).
  _Files_: `StorageSnapshots.svelte`, `language.storagePage.snapshots`, `src/lib/Setting/Pages/UserSettings.svelte`,
  `src/ts/globalApi.svelte.ts` (remove `loadInternalBackup` after `rg` shows no other caller, plugin API included),
  `src/ts/tests/globalApiMock.ts`, and the `language.loadInternalBackup` label (reworded as the link's text).
  _Done_: every snapshot action works from the row menu as before (controller tests unchanged); the Backups link opens
  Storage with `storage.snapshots` highlighted; `rg loadInternalBackup src server shared docs/structure` is empty.
  _Guides_: the three guides that name `loadInternalBackup` point to the Storage page's snapshots section instead.
  _Test_: `pnpm --silent test:agent src/lib/Setting src/ts/setting`.

- **E. The lease-free preview route** (_hard_; `self-host-server.md` owns the routes and the asset mark; D8).
  _Files_: `shared/assetLifecycle.ts` (`ASSET_PREVIEW_PATH`), `server/src/routes/assetLifecycle.ts` (the route; its
  header comment states the rules), `server/src/data/assetLifecycle.ts` (a read-only `previewable(key): boolean`
  over `candidates` and the orphan-inlay candidates' assets), `server/src/app.ts` (~1010, pass `thumbnails`,
  `savePath` and the shared `assetHeaders` if the route needs them; export `assetHeaders` from `storage.ts` rather
  than copy it), and tests in `server/src/tests/assetLifecycle.test.ts` or a new
  `server/src/tests/assetPreview.test.ts`.
  _Done_ (each a test): 401 without auth; 404 for a referenced key, a young unreferenced key, a non-image candidate, an
  active extension, and an unknown key; 200 WebP for a past-grace image candidate and for an orphan inlay's image;
  `assetLeased` stays false after a preview, and a sweep right after a preview deletes the key; a preview and a sweep
  of the same key leave no thumbnail cache entry for it in either order; `Cache-Control: no-store` and the
  `/api/asset/*` CSP on every answer.
  _Guides_: `self-host-server.md` Storage routes line ~136 adds `GET /api/assets/preview/*` and one clause that it
  never leases; Asset mark unchanged.
  _Test_: `pnpm --silent test:agent server/src/tests/assetLifecycle.test.ts server/src/tests/assetThumbnails.test.ts`
  plus the new file.
