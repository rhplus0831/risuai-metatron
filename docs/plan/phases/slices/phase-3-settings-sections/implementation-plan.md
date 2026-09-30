# Phase 3 implementation plan (Opus, final)

Written 2026-09-30 at `5f0aa378`, after a plan review by GPT-6-Astra and an evaluation of the
draft and that review by Claude Fable. The slice files in this folder stay canonical for
content; this file records how they are executed and the amendments to them. Where this file and
a slice disagree, this file wins until the slice is updated in the same change as its
implementation.

## Goal

Implement [`phase-3-settings-sections.md`](../../phase-3-settings-sections.md): five typed sections
(`providers`, `secrets`, `llmSecrets`, `ui`, `memoryTranslateMedia`) and the small collection
resources, each with a server normalizer; ids that are required on presets, personas, translator
presets, and HypaV3 presets; a forwarding layer over per-client selection ids in place of the
preset and persona working copies in root; `proxyKey` in `llmSecrets`, keyed by preset id; the
`root` kind removed (resource DB schema version 3); a boot-snapshot comparison, a decoded
`.risup` round trip, and docs.

The baseline was verified: `git diff 577c43ae HEAD` touches only `docs/`, so the slices match the
current source.

## Order

```
step 0 fixtures ─┐
slice 1 spike ───┴─→ [stop A] → 2 → 3 → 4 → [stop B] → 5 → 6 → 7 → [stop C]
                      (2 is reviewed before stop A)
```

- Step 0 and the spike run in parallel first. Neither touches production code, and the spike's
  verdict decides which form slice 5 takes.
- **Stop A** comes after step 0, the spike verdict, and slice 2. You see the taxonomy,
  `DROPPED_FIELDS`, and the canonical preset defaults before anything builds on them.
- **Stop B** comes after slice 4, the first shape the server and other clients see.
- **Stop C** is closeout. Between stops I report and continue. A problem found by a review, or a
  slice stopping condition, is always a stop.
- Slices 2, 4, and 5 are large (about 20 to 30 files each), so each gets internal `pnpm check`
  checkpoints. Slice 2 splits into 2a (the shared modules, the taxonomy, `normalizePreset`) and
  2b (ids at the creation sites).

## Amendments to the slices

Each amendment names the finding it comes from. Astra's findings are A1 to A18; Fable's
additions are F-a to F-g.

- **Slice 2**
  - The `RESOURCE_KIND` runtime entries move to slice 3, together with server registration.
    Slice 2 adds only the payload types and the taxonomy constants. The reason: `loadData`
    requests `Object.values(RESOURCE_KIND)`, and the server returns 400 for an unregistered kind
    (A1).
  - Delete the two `setPreset` reads of `newPres.autoSuggestPrefix` and
    `newPres.autoSuggestClean`. Recorded nuance: a hand-written preset could restore them before
    this change (A6).
  - `saveCurrentPreset`'s rebuilt literal is limited to the canonical keys: no `openAIKey`,
    `forceReplaceUrl2`, or `autoSuggest*`. This makes the client's presets text a fixed point of
    the new normalizer (A12).
  - `RESIDUAL_ROOT_KEYS` is 70 preset working-copy keys (including `proxyKey`), 4 persona keys,
    and 3 selection keys. The keep-on-switch fields belong only to `providers`, and the
    auto-suggest fields only to `ui`. `FORWARDED_PRESET_KEYS` is 69 ordinary accessors plus the
    `proxyKey` map accessor. Every count is derived from the lists and asserted by the partition
    test, never kept by hand (A2, A3).
  - Moved identifiers get their guide anchors updated in the same slice (A18).
- **Slice 3**
  - `ResourceKind` gains an opt-in `materialize?: true`, and the eligible kinds are listed.
  - The startup normalization pass is owned by the store (`createResourceStore`, and inside
    `replaceAll`'s single transaction together with the epoch change). There is no second pass in
    `app.ts`.
  - The `llmSecrets` `clientReadable: true` marker is added here (A13).
  - `statics` becomes its own collection kind (13 collections). It is incremented on every send
    (`process/index.svelte.ts` `statics.messages += 1`), so keeping it in `ui` would dirty `ui`
    on every message (F-f).
  - Recorded: from this slice, stored presets get normalizer defaults and lose `openAIKey`, so
    the "missing field inherits" behavior ends here, not in slice 5 (F-d).
- **Slice 4**
  - Assembly filters the stored root by `RESIDUAL_ROOT_KEYS`, and sections win for their own
    fields (A2).
  - `setDatabase` keeps defaults for every residual key, including the persona fields and the
    selection indexes, until slices 5 and 6 remove those keys (A4).
  - `shared/database.ts` is added to the allowed files: `translatorPresetId` and `hypaV3PresetId`
    become strings (A5).
  - `assembleDatabase` is exported for the slice 7 comparison test (F-a).
  - Convergence rule, which replaces "only backstop ids change": for every kind,
    `normalize(project(assemble(normalized)))` must equal `normalized` as text. A write that the
    server normalizes further stays diverged only until the next reload. Returning normalized
    data in batch results stays the recorded future mechanism and is not added now (A12).
- **Slice 5**
  - `shared/sections.ts` is added to the allowed files (A5).
  - The `proxyKey` lifecycle moves here, with the accessor: `copyPresetSecret` on copy,
    `deletePresetSecret` on delete, import into the map. Otherwise a copied or imported key is
    invisible to requests during slices 5 and 6 (A11).
  - Reconciliation is lazy, inside accessor resolution: a fallback to the first record is
    persisted to the selection. A write whose captured record was deleted is dropped, never
    redirected to another record. This covers local splices and plugin replacements without
    listing their callers (A15).
  - The wrapper rewrite keeps `SettingSelect`'s hidden-option fallback. `onChange` fires once per
    user edit, and never on a switch re-render (A16).
  - If the spike fails, the fallback includes the plugin key mapping in Phase 3 itself, not in
    Phase 4 (A14).
- **Slice 6**
  - `shared/sections.ts` is added to the allowed files (A5).
  - The reset boundary is stated: every database older than version 3 is refused.
- **Slice 7**
  - The comparison rule changes: forwarded root values are compared directly, and the new
    selected preset is compared against the old effective root through `PRESET_ROOT_ALIASES`.
    The old dormant `botPresets[0]` payload (template `maxResponse` 300) is not the oracle.
    Recorded as a consolidation (A10).
  - The slice keeps the `proxyKey` stripping, the normalizer change, the round trips, the
    records, and the docs.
- **Formatting**: `pnpm exec prettier --write <files>`, because `pnpm format` always runs on `.`
  (A18).

## Browser automation (Playwright)

`playwright-core` and `@playwright/test` (1.63.0) are dev dependencies, added on 2026-09-30 at
the user's request. Both drive the system Chrome (`executablePath: "/usr/bin/google-chrome"`,
Chrome 153); no browser download is needed. The cached `chromium-1243` in `~/.cache/ms-playwright`
matches 1.63 and is the fallback.

Two kinds of Playwright code, with different owners:

- **Capture and check scripts** (`playwright-core`, plain Node scripts under
  `util/playwright/`): tools, not tests, so I write them. These are the step 0 capture, and the
  drivers for manual checks that record observations rather than assert.
- **End-to-end specs** (`@playwright/test`, `e2e/*.spec.ts`): tests, so Fable writes them under
  the test workflow below. These are the repeatable manual checks from the slices' Validation
  lists that are worth keeping: two-client selection independence, idle reload without writes,
  edit-then-switch persistence, and the persona binding after an icon change.

Setup, which I do in step 0 (infrastructure, not tests):

- `playwright.config.ts`: Chrome `executablePath`, headless, and `webServer` entries that start
  the Hono server with `PORT` set and its working directory in a fresh temporary folder. The
  server takes `save/` from `process.cwd()` (`server/src/main.ts` `rootDir`), so each run gets an
  empty store, and the repository `save/` is never moved. The Vite dev server is started with
  `RISU_DEV_SERVER` pointing at that port.
- `vitest.config.ts` excludes `e2e/**`. Vitest's default include matches `*.spec.ts`, so without
  the exclude it would collect the Playwright specs.
- A `test:e2e` script (`playwright test`). It stays out of `pnpm test`, so the V1 gate keeps its
  5-second suite.
- `e2e/` and `util/playwright/` are type-checked through their own small `tsconfig`, or through
  the config's include if that is simpler. I decide when I set it up and record it in
  `docs/structure/build-test-platforms.md` (scripts, test inventory).

Every client check uses a fresh browser context, so `localStorage` and the per-client selection
never leak between runs. Two-client checks use two contexts in one browser
(`browser.newContext()` twice), which gives two independent clients. Two tabs of one profile
would share `localStorage` and are not independent.

## Step 0 recipe (A9, F-b)

A `playwright-core` script, `util/playwright/capturePhase3Fixtures.mjs`, run on the untouched tree:

1. Start the server in a fresh temporary working directory with its own `PORT`, and the Vite dev
   server against it (the dev server injects `__NODE__` and proxies `/api`).
2. Open a fresh browser context, set the password, and wait until the app has loaded
   (`loadedStore`).
3. Capture the snapshot first, before anything else runs: `page.evaluate` runs
   `await import('/src/ts/storage/database.svelte.ts')`, which is the same module instance the
   app uses, then `getDatabase({ snapshot: true })`. The result is written as
   `boot-snapshot.json`.
4. `downloadPreset(0, "return")` produces `default.risup`. The bytes come back base64-encoded
   from `page.evaluate`. The README notes that this call runs `saveCurrentPreset`, so the export
   carries the effective root values.
5. Build the custom preset through the same module, then export it as `custom.risup`.
6. Stop both servers and delete the temporary directory.

The fixtures, a README with the commit and the command, and the script are kept together. The
script stays in the tree, so the capture can be rerun against any commit.

## Tests and workflow (exception approved by the user on 2026-09-30)

`CLAUDE.local.md` has only Fable write tests, and the Fable reviewer may not fix a failing check.
But the spike is test code written before any implementation, and slices 2, 3, 4, and 6
deliberately invalidate existing tests. The narrow exception for Phase 3 (Fable's option 2,
recommended by both reviewers, approved by the user):

- **Fable test-adapter** (a separate Fable agent, not the reviewer), per slice. It adapts exactly
  the tests I list as invalidated, each with its reason. It writes the spike in slice 1. It edits
  no source.
- **Fable reviewer**, per slice, as `CLAUDE.local.md` defines it. It reviews the diff together
  with the adapted tests, treats any remaining failure as a problem, confirms that each
  adaptation is an expected invalidation and not a masked regression, and writes the review-step
  tests.
- I edit no tests. That includes `e2e/*.spec.ts`: Fable writes those. I write only the Playwright
  config and the `util/playwright/` scripts.

Expected invalidations, which I re-check at each slice:

| Slice | Tests                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2     | `translator/presets.test.ts`                                                                                                                                                                                       |
| 3     | `kinds.test.ts`, `resourcesBatch.test.ts` (creating `presets/main`), `snapshots.test.ts`, `backups.test.ts` (row-id lists), and possibly `resourceStore.test.ts`                                                   |
| 4     | `resourceSync.test.ts` (the no-echo test is re-targeted, not deleted), `resourceSyncChats.test.ts`, `resourceSyncUnload.test.ts`, `browserLocalImport.test.ts`, `characters.test.ts`, `translator/presets.test.ts` |
| 5     | none                                                                                                                                                                                                               |
| 6     | `backups.test.ts`, `resourcesBatch.test.ts`, `kinds.test.ts`, `resourceSync*.test.ts`, `characters.test.ts`                                                                                                        |
| 7     | none                                                                                                                                                                                                               |

`resourceClient.test.ts` is not on the list: it uses "root" only as a label.

The rejected alternative was to follow the protocol literally: Fable reports the red tests and I
stop for the user, in about five of the seven slices.

## Reviews and checks

- Astra challenge on slices 2 to 7. The Astra session from this review stays open for them.
- Fable review on every slice.
- Every slice runs `pnpm check`, `pnpm test` (green after the adapter), and
  `pnpm format:check`. Slices 4 to 7 also run `pnpm build`.
- The manual checks in each slice's Validation run through Playwright and are recorded in the
  slice file. Checks that Fable turned into `e2e/` specs run with `pnpm test:e2e` from the slice
  that adds them onward. A one-off observation uses a `util/playwright/` script. The Docker smoke
  in slice 7 stays a manual run against the container, which the script drives with `baseURL`
  pointing at it.

Astra's testing advice, all judged necessary by Fable and by me, goes to Fable at these slices:

| Slice | Checks                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2     | Partition test                                                                                                                                                                             |
| 3     | Idempotence and stable ids across restarts, rollback when the pass fails inside `replaceAll`                                                                                               |
| 4     | Fixed-point and no-echo boot per kind, idle reload                                                                                                                                         |
| 5     | The real wrappers (sync write, hidden-option fallback, `onChange`), deletion and plugin replacement and invalid selection, the `proxyKey` lifecycle, two clients (two Playwright contexts) |
| 6     | Persona deletion during async image select (drop, never redirect), version-2 refusal, version-3 restore, two clients (two Playwright contexts)                                             |
| 7     | Effective settings against the step-0 baseline, both export formats read by the pre-phase reader, Docker restart and restore                                                               |

## Open questions: my decisions

| #   | Question                                                      | Decision                                                                           |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | One debounce or one per section                               | One debounce loop with a dirty key per section.                                    |
| 2   | Shape of `translatorPresets` and `hypaV3Presets`              | `{ items, selectedId }` records.                                                   |
| 3   | `translatorPrompt`, `translatorMaxResponse`, `hypaV3Settings` | Drop them: they have no reader outside their own sync code.                        |
| 4   | Cross-section defaults                                        | Become constants equal to the fresh-boot values. This holds for fresh stores only. |
| 5   | Dead toggles                                                  | Stay in `ui`.                                                                      |
| 6   | Keep-on-switch toggles and `presetChain`                      | Go to `providers`.                                                                 |
| 7   | `customModels[].key`                                          | Stays in the collection. This is a Phase 3 boundary, not server-only credentials.  |
| 8   | `irisDialogue` and `statics`                                  | `irisDialogue` goes to `ui`; `statics` gets its own collection (amended).          |
| 9   | `mainPrompt` and `formatversion` migrations                   | Dropped. `loreBookToken` 8000 becomes the default.                                 |
| 10  | `getModules` `$embedded` gap                                  | Out of scope.                                                                      |

## Commits

Approved by the user on 2026-09-30: one commit per slice after its reviews (Astra challenge and
Fable review), with a conventional prefix and the model attribution of the
`delegate-implementation` skill (Opus as the orchestrator, then Fable, then the Codex models that
ran). Step 0 and the spike are committed together as the first commit. The reviewers get a
slice-sized diff (`git diff HEAD`), and the slice 6 commit is the reset point after which older
databases are refused.
