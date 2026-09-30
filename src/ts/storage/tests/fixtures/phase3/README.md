# Phase 3 pre-phase fixtures

Captured on 2026-09-30 from commit `4914ccc7`, before any Phase 3 source change (the tree differs
from that commit only by the Playwright tooling: `util/playwright/`, `playwright.config.ts`, the
`test:e2e` script, and the Vitest `e2e/**` exclude, none of which the app loads), with:

```bash
node util/playwright/capturePhase3Fixtures.mjs
```

The script (`util/playwright/capturePhase3Fixtures.mjs`) starts the self-host server in a fresh
temporary working directory (empty `save/`) and the Vite dev server in front of it, opens a fresh
headless Chrome context, answers the password prompt, and waits for `loadedStore`. Then:

- `boot-snapshot.json`: `getDatabase({ snapshot: true })`, taken first, before anything else runs.
  It holds the effective defaults of a fresh boot, including what `checkNewFormat` changes after
  `setDatabase` (for example `loreBookToken` 8000). The root working copy (`maxResponse` 500,
  `textgenWebUIStreamURL` `wss://localhost/api/`) differs from the stored `botPresets[0]`, which
  is a clone of `presetTemplate` (`maxResponse` 300, empty textgen URLs). Ids (`personas[0].id`)
  are random per capture.
- `default.risup`: `downloadPreset(0, "return")`. `downloadPreset` runs `saveCurrentPreset`
  first, so the exported preset carries the effective root values (`maxResponse` 500), not the
  dormant `botPresets[0]` payload.
- `custom.risup`: `copyPreset(0)`, `changeToPreset` to the copy, then non-default values for
  `temperature`, `maxResponse`, `mainPrompt`, `NAIsettings` (exported as `NAISettings`),
  `reasoningEffort` (`reasonEffort`), `presetRegex` (`regex`), nested `ooba` and
  `reverseProxyOobaArgs`, `promptTemplate`, `seperateParameters` (with an `overrides` entry), and
  the non-ASCII name `커스텀 プリセット ✓`, exported with `downloadPreset(id, "return")`.

Re-running the script overwrites the three files. The snapshot differs only in random ids, and
the `.risup` bytes differ between captures while their decoded presets are equal, so compare
decoded presets, never bytes.
