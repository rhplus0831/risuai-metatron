# Phase 3 fixtures

`boot-snapshot.json` is the hand-maintained record of fresh-boot defaults. When a default changes
deliberately, edit its normalizer spec (or `PRESET_DEFAULTS` for a preset field) and this JSON in the
same commit; the tests confirm that they agree. Do not re-run the capture script for a deliberate
default change, because a new capture would also replace the fixture's random ids.

## Provenance

The three fixtures were initially captured on 2026-09-30 from commit `4914ccc7`, before any Phase 3
source change (the tree differs from that commit only by the Playwright tooling:
`util/playwright/`, `playwright.config.ts`, the `test:e2e` script, and the Vitest `e2e/**` exclude,
none of which the app loads), with:

```bash
node util/playwright/capturePhase3Fixtures.mjs
```

The script (`util/playwright/capturePhase3Fixtures.mjs`) starts the self-host server in a fresh
temporary working directory (empty `save/`) and the Vite dev server in front of it, opens a fresh
headless Chrome context, answers the password prompt, and waits for `loadedStore`. Then:

- `boot-snapshot.json`: initially `getDatabase({ snapshot: true })`, taken first, before anything
  else ran. It held the effective defaults of a fresh boot, including what `checkNewFormat` changed
  after `setDatabase` (for example `loreBookToken` 8000). The root working copy (`maxResponse` 500,
  `textgenWebUIStreamURL` `wss://localhost/api/`) differs from the stored `botPresets[0]`, which is a
  clone of `presetTemplate` (`maxResponse` 300, empty textgen URLs). Ids (`personas[0].id`) were
  random in the capture.
- `default.risup`: `downloadPreset(0, "return")`. `downloadPreset` runs `saveCurrentPreset`
  first, so the exported preset carries the effective root values (`maxResponse` 500), not the
  dormant `botPresets[0]` payload.
- `custom.risup`: `copyPreset(0)`, `changeToPreset` to the copy, then non-default values for
  `temperature`, `maxResponse`, `mainPrompt`, `NAIsettings` (exported as `NAISettings`),
  `reasoningEffort` (`reasonEffort`), `presetRegex` (`regex`), nested `ooba` and
  `reverseProxyOobaArgs`, `promptTemplate`, `seperateParameters` (with an `overrides` entry), and
  the non-ASCII name `커스텀 プリセット ✓`, exported with `downloadPreset(id, "return")`.

After that capture, the `theme` default `"metatron"` and the nine preset defaults
`moduleIntergration`, `JinjaTemplate`, `jsonSchemaEnabled`, `jsonSchema`, `extractJson`,
`groupTemplate`, `thinkingTokens`, `outputImageModal`, and `dynamicOutput` were added to
`boot-snapshot.json` by hand as deliberate fresh-boot defaults, and so was the `ui` default `chatScreenWidth` 900.

The preset split (`docs/plan/split-preset.md`, 2026-10-08) changed the fresh boot by hand too: the
`providers` toggle `doNotChangeSeperateModels` is gone, the model fields `seperateModels` and
`seperateModelsForAxModels` read their `PRESET_DEFAULTS` through the selected model preset (they were unset `providers` fields), and the new `modelPresets` collection
holds the one materialized default model preset (its `id` was never captured; the tests compare it
without ids). The stored `botPresets[0]` still carries the pre-split template payload, model fields
included, because `default.risup`/`custom.risup` pin the `.risup` reader contract; `normalizePresets`
drops those fields when a test installs it. The removal of the fallback models (2026-10-09) took
`fallbackModels` and `fallbackWhenBlankResponse` out of the root and the default model preset by hand.
The model profiles (`docs/plan/model-profiles.md`, 2026-10-09) changed it by hand again: the default
model preset holds only its slots and toggle (`mainSlot`/`subSlot` naming profile `default`,
`auxSlots: {}`), the new `modelProfiles` collection holds the one default profile with the values
the root copy captured for the moved fields, and `providers.modelCredentials` is gone. The captured
root keeps `apiType` and `proxyKey`, now dropped fields, as it keeps `hypaMemoryKey`.
The Model menu regroup (2026-10-09) renamed the default profile by hand: `MODEL_PROFILE_DEFAULT_NAME`
is "New Connection" (was "New Model Profile"), as profiles are shown as connections.

Re-running the script overwrites all three files. Across captures, the snapshot's ids and the
`.risup` bytes differ while the decoded presets are equal, so compare decoded presets, never bytes.
