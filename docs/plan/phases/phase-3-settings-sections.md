# Phase 3: Settings Sections

Status: not started.

Depends on: Phase 1. Independent of Phase 2. Confirm the selection-state Open Decision first.

## Objective

Split the `root` resource into typed sections with server-side defaults, move the remaining
collections out of root into their own resources, and separate per-client selection state from
data.

## Required Work

- **Sections.** Use the field taxonomy from the opening baseline: `generation` (the 75 preset-owned
  fields, matching `botPreset`), `providers` (45 provider settings), `secrets` (29 credential
  fields), `ui` (120 preferences), and `memoryTranslateMedia` (66 fields). The 22 transient or
  legacy fields are dropped or become server-only state; record each in this file.
- **Collections still in root.** `loreBook`, `globalscript`, `presetRegex`, `hotkeys`,
  `customSidebarItems`, `characterOrder`, `authRefreshes`, `globalChatVariables`, `personas`,
  `translatorPresets`, `hypaV3Presets`, `customModels`, and `enabledModules` become small resources
  of their own.
- **Server normalizers.** Port the defaults and migrations in `setDatabase` section by section to
  pure functions under `server/src/data/normalize/` with node-environment tests, including the
  preset consistency rules between `botPreset`, `presetTemplate`, `saveCurrentPreset`, `setPreset`,
  and `importPreset` (the field sets differ today; the normalizer makes one list canonical). The
  client `setDatabase` shrinks by the same sections.
- **Client mirror.** `DBState.db` keeps the same field names (invariant D3), but each section is a
  mirror with its own debounced write. The root watcher in `saveDb` is replaced by per-section
  watchers, each deleted when its section gets explicit mutation functions.
- **Selection state.** `chatPage`, `botPresetsId`, `selectedPersona`, and `loreBookPage` move to a
  client-local store if the Open Decision confirms it; `localStorage` is acceptable for per-client
  conveniences.
- **Secrets.** The `secrets` section stays readable by the client until Phase 5 makes it write-only,
  because the client still calls providers through the proxy. Mark the section so Phase 5 can flip it
  without a schema change.
- **Preset formats.** `downloadPreset` and `importPreset` keep the `.risup` and `.risupreset`
  formats byte-compatible (invariant D5).
- **Docs.** `docs/structure/persistence.md` (`State`, `Recipes`), `docs/structure/settings-i18n.md`,
  and the D2 invariant, which now points at the server normalizers.

## Safety Contract

A fresh server produces the same normalized database as `setDatabase` did: compare a snapshot of
`getDatabase()` after boot on an empty save before and after the phase, ignoring the fields this
file records as dropped. Settings pages keep binding to `DBState.db`.

## Exit Criteria

- No `root` resource remains.
- Every section and collection has a normalizer with tests, and the client `setDatabase` contains no
  defaults for migrated sections.
- The empty-save boot snapshot matches, apart from the recorded drops.
- Preset export and import round-trip against a `.risup` file produced before the phase.

## Validation

Normalizer tests, a boot-snapshot comparison recorded in the phase file, a preset round-trip check,
and `pnpm check`, `pnpm test`, `pnpm format:check`.
