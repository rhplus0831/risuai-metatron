# HypaV3 Token Budget Plan

Status: planned, no slice started.

- 2026-10-27: first draft, written after a design discussion with the user. The
  user's answers are recorded under **Agreed decisions**.

Sources: the code at `a412bc2d8` (anchors below are from that commit; re-verify
before editing) and the discussion with the user.

Owning guides:

- [memory](../structure/memory.md): `shared/{memory,hypaV3Presets}.ts`,
  `server/src/prompt/memory/hypav3.ts`, the memory step in
  `server/src/prompt/assemble.ts` (`hypaV3Step`).
- [settings-i18n](../structure/settings-i18n.md): `MemorySettings.svelte`, strings,
  help texts.
- [ui-theming](../structure/ui-theming.md): `ContextMeter.svelte`.
- [persistence](../structure/persistence.md): the `hypaV3Presets` record and its
  normalization.
- [backup-sync-hub](../structure/backup-sync-hub.md): the upstream export.

## Goal

HypaV3's three size settings are shares of the maximum context `C`. The user finds
these hard to reason about: "memory tokens ratio" says nothing about how much space
the summaries get, and the same preset behaves differently whenever `C` changes.
This plan adds a token mode where the three settings are plain token amounts with
plain labels:

| Setting                     | Ratio mode (today)             | Token mode                                |
| --------------------------- | ------------------------------ | ----------------------------------------- |
| Memory budget               | `floor(C × memoryTokensRatio)` | "Total space for HypaV3 memory" (tokens)  |
| Background summary headroom | trigger at `C × (1 − h)`       | "Token headroom to start summaries early" |
| Extra summarization         | target `C × (1 − e)`           | "Extra tokens to free when summarizing"   |

`C` is the "max context size" setting (`db.maxContext`,
`server/src/prompt/assemble.ts:882`): the prompt preset's override, else the main
profile's value. It is a user setting, not the model's limit. With the memory task
service (production), the step counts `maxResponse` inside the prompt
(`responseCorrection: false`, `assemble.ts:503`), so its prompt budget is
`P = C − maxResponse`.

This is a budget mode on the HypaV3 preset, not a separate memory algorithm. The
window scan, deferral, selection, summary data, modal, and progress UI stay the same.

## Agreed decisions

1. **All three values become tokens** in token mode: memory budget, background
   summary headroom, extra summarization. `recentMemoryRatio` and
   `similarMemoryRatio` stay ratios, because they split the memory budget, not `C`.
2. **Not a separate "V3.1" mode.** One preset field selects the budget mode. Both
   modes share `hypaV3Data`, so switching never loses summaries.
3. **Existing and imported presets keep ratio mode.** A preset is stored apart from
   `C` and can be used with several models, so ratios cannot be converted exactly.
   The settings page offers a button that converts the preset with the current `C`.
   New presets start in token mode.
4. **Values that do not fit are reduced, never refused.** A send after a model
   switch must not fail. The reduction order is headroom, then extra summarization,
   then memory (see **Reduction rule**).
5. **Two warnings show a reduction:**
   - in the context meter chip (`N turns · memory on · N%`), next to the lorebook
     warning, with the configured and applied values in the popover;
   - on the settings page under the token inputs, as soon as a value is typed,
     against the current `C` and `maxResponse`.

## Original code (baseline)

- **Settings.** `HypaV3Settings` (`shared/memory.ts:98-123`): `memoryTokensRatio`,
  `extraSummarizationRatio`, `lookaheadHeadroomRatio` (in [0, 1)), plus
  `gapConfirmTokens`, which is already a token amount.
  `createHypaV3Preset` (`shared/hypaV3Presets.ts:11`) fills defaults (0.2, 0, 0.15)
  and keeps an own known key only when its `typeof` matches the default. Numbers
  must be finite, and some keys have range checks. Unknown keys are dropped.
- **Normalization.** `normalizeHypaV3Presets`
  (`server/src/data/normalize/collections.ts:193`) runs every stored preset through
  `createHypaV3Preset`, and seeds `createHypaV3Preset("Default")` (`:201`) when the
  list is missing.
- **Where the ratios are used** (server, `server/src/prompt/memory/hypav3.ts`):
  - `prepareHypaV3` `:493`: `memoryTokens = floor(C × memoryTokensRatio)`, the
    ledger's full budget (`HypaV3Ledger.memoryTokens`, the reservation, and
    `availableMemoryTokens`).
  - The ordinary plan `:687-691`: the same budget, and
    `targetTokens = C × (1 − extraSummarizationRatio)`.
  - `forecastHypaV3` `:767-801`: `lookaheadIn` uses `C × (1 − h)` and
    `max(0, C × (1 − h − e))`.
  - `planHypaV3Summaries` `:884-909`: the trigger (`C × (1 − h)` with lookahead,
    else `C`) and the target.
  - Selection (`:1528` on) reads `ledger.availableMemoryTokens` only.
- **Meter budget.** `assemble.ts:1754` recomputes
  `floor(maxContextTokens × memoryTokensRatio)` for `ContextReport.memory.budget`
  (`shared/contextReport.ts:97`, validated at `:271`).
- **The tab's copy.** `src/ts/process/memory/hypav3.ts:171`, `:182` has the same
  ratio formulas. It is the reference `memoryOracle.test.ts` compares the server with,
  and it runs in no product path.
- **Settings page.** `MemorySettings.svelte`:
  - `:405-437`: three sliders. Extra summarization is capped at
    `1 − memoryTokensRatio`, headroom at 0.99.
  - `getMaxMemoryRatio` (`:113-133`) shows an estimated maximum memory ratio. It takes
    `C` from `maxContextOverrideOf(activePreset) ?? activeMainProfile.maxContext`, the
    same source the server uses, and estimates the prompt size as template +
    character + lore + `maxResponse × 3`.
  - New presets: `createHypaV3Preset()` at `:245`, imported presets at `:353`, export
    at `:331`.
- **Meter warnings.** `ContextMeter.svelte`:
  - `loreWarn` (`:126`) adds a danger-colored mark to the chip (`:611`) and a clause to
    the summary text (`:374`).
  - The memory label (`:360`) is `summarized`, `gap`, or `memory on`.
- **Upstream export.** `server/src/data/upstream/exportDatabase.ts` writes the root
  `maxContext` (`:511`) and the presets. Upstream ignores keys it does not know.

## Design decisions (made by this plan)

- **Fields** (`HypaV3Settings`, all persisted in the preset):
  - `budgetMode: "ratio" | "tokens"`. A missing or invalid value normalizes to
    `"ratio"`, so stored, imported, and upstream presets keep today's behavior.
  - `memoryBudgetTokens`, `lookaheadHeadroomTokens`, `extraSummarizationTokens`:
    integers ≥ 0, with defaults 6000, 4000, 0. These are close to today's ratio
    defaults at a 32k context, and extra summarization keeps today's default of none.
  - The ratio fields stay and keep their values in token mode, so switching back
    restores the old behavior.
- **New presets are token mode.** The settings page's new preset (`:245`) and the
  server's seeded default (`collections.ts:201`) pass `budgetMode: "tokens"`.
  `createHypaV3Preset`'s own default stays `"ratio"`, because normalization of stored
  presets goes through it.
- **One resolver.** `resolveHypaV3Budget(settings, maxContext, maxResponse)` goes in
  `shared/hypaV3Presets.ts`. It returns the thresholds the sites compare with, in the
  step's own count (the same space as `C`), plus `reduced`:
  - `memoryTokens`, the full budget;
  - `targetTokens`, the ordinary target;
  - `lookaheadTrigger`, the background summary trigger;
  - `lookaheadTarget`, the background summary target.

  The two modes fill them as follows:
  - Ratio mode: today's expressions as written: `floor(C × r)`, `C × (1 − e)`,
    `C × (1 − h)`, and `max(0, C × (1 − h − e))`. `reduced` is empty. Return the
    thresholds, not `C × h` and `C × e` for the sites to subtract: `C − C × h` can
    differ from `C × (1 − h)` in floating point and move a boundary such as
    `floor(C × (1 − h)) + 1` (`:798`).
  - Token mode: the amounts after the reduction rule below: `memory`, `C − extra`,
    `C − headroom`, and `max(0, C − headroom − extra)`.
  - Every ratio site above, and `assemble.ts:1754`, read the resolver. The ledger's
    `memoryTokens` comment and `ContextReport.memory.budget`'s comment are updated
    to match.

- **Reduction rule** (token mode only), with prompt budget `P = max(0, C − maxResponse)`
  and `half = floor(P / 2)`:
  - memory: `min(memoryBudgetTokens, half)`;
  - margins: headroom plus extra may take at most `half`. Headroom is reduced first:
    `headroom = min(headroomTokens, max(0, half − extraTokens))`, then
    `extra = min(extraTokens, half − headroom)`.
  - The result keeps the summary target (`C − headroom − extra`) at or above
    `C − half`, and keeps half of the prompt budget free of the memory card. This
    leaves room for the fixed sections and the raw history.
  - `reduced` lists each value that changed: `{ field: "memory" | "headroom" |
"extra", configured, applied }`.
  - `P` uses `maxResponse` even on the legacy `responseCorrection: true` path (only
    the `memoryTasks: "disabled"` test override). Only the reduction depends on it.
- **Report.** `ContextReport.memory` gains `budgetReduced?:
{ field: "memory" | "headroom" | "extra"; configured: number; applied: number }[]`.
  It is present only when non-empty and validated with the other memory fields
  (`contextReport.ts:271`). The meter reads it from the server's report, so the chip
  and the step cannot disagree.
- **Meter.**
  - The chip gets a short danger mark ("memory reduced" / "메모리 축소") beside the
    lorebook mark, and a clause in the summary text.
  - The popover's Memory section lists each reduced value as `configured → applied`,
    with one line saying it was reduced to fit the current max context.
  - There is no per-chat off switch: the warning goes away when the preset fits.
- **Settings page.**
  - A budget-mode `SegmentedControl` (Ratio / Tokens) above the three values.
  - Token mode shows three integer `NumberInput`s with the new labels and help keys.
    The estimated maximum shows in tokens: `maxContext − requiredToken`, the same
    estimate `getMaxMemoryRatio` makes today.
  - Under the inputs, a danger line for each value `resolveHypaV3Budget` reduces with
    the page's `C` and `activePreset.maxResponse`, using the same source as
    `getMaxMemoryRatio`.
  - Ratio mode keeps today's sliders and adds the button "Convert to tokens at the
    current max context (N)". It sets `memoryBudgetTokens = floor(C × r)`,
    `lookaheadHeadroomTokens = round(C × h)`, `extraSummarizationTokens = round(C × e)`
    and `budgetMode: "tokens"`. The button is hidden when `C` is 0. No confirmation is
    needed, because switching the mode back restores the ratios.
- **Upstream export.** Upstream has no token mode, so a token-mode preset is exported
  as ratios computed from the exported root `maxContext`:
  - `memoryTokensRatio = memoryBudgetTokens / C`, `lookaheadHeadroomRatio` and
    `extraSummarizationRatio` likewise;
  - each clamped to the ranges `createHypaV3Preset` accepts, and rounded to 2
    decimals as the sliders are;
  - the new fields are dropped.

  The fork's own preset export (`:331`) and import keep the fields as they are.

- **The tab's copy stays ratio-only.** It is the oracle for ratio mode. Token mode is
  covered on the server by an equivalence test (see slice 1).
- **Strings** (en / ko), under `hypaV3Settings` and `contextUsage`:
  - budget mode: "Budget mode" / "예산 방식"; "Ratio" / "비율"; "Tokens" / "토큰";
  - "Total space for HypaV3 memory (tokens)" / "HypaV3에 할당할 메모리 총 공간 (토큰)";
  - "Token headroom to start summaries early" / "미리 요약을 시작할 토큰 여유";
  - "Extra tokens to free when summarizing" / "요약할 때 추가로 비울 토큰";
  - "Convert to tokens at the current max context ({n})" /
    "현재 최대 컨텍스트({n}) 기준으로 토큰으로 변환";
  - settings warning: "At the current max context ({c}, {p} without the reply) this is
    reduced to {applied}." / "현재 최대 컨텍스트({c}, 응답 제외 {p})에서는 {applied}으로
    줄어 적용됩니다.";
  - chip: "memory reduced" / "메모리 축소"; the popover line "Reduced to fit the current
    max context" / "현재 최대 컨텍스트에 맞춰 줄였습니다".

  Help texts: what each value means in tokens. The headroom text says it is about how
  many turns ahead summaries start. The extra text says larger values summarize less
  often, but more at once.

## Slices

### 1. Settings, resolver, and server use (_medium_)

- `shared/memory.ts`: the four fields with doc comments.
- `shared/hypaV3Presets.ts`:
  - `createHypaV3Preset` defaults and validation (`budgetMode` only `"ratio"` or
    `"tokens"`; the three token fields integers ≥ 0);
  - `resolveHypaV3Budget`.
- `server/src/prompt/memory/hypav3.ts`: the four sites read the resolver. Pass the
  resolved budget, or `maxResponse`, through `HypaV3Prepared` so the plan, the
  forecast, and the selection do not recompute it differently.
- `server/src/prompt/assemble.ts:1754`: the meter budget from the resolver, and
  `budgetReduced` into the memory run and the report.
- `shared/contextReport.ts`: `budgetReduced` with validation.
- `server/src/data/normalize/collections.ts:201`: the seeded default in token mode.
- `server/src/data/upstream/exportDatabase.ts`: the token-to-ratio export.
- Docs: [memory](../structure/memory.md) (the preset fields, the parts' trigger and
  target text at `:76`, `:96`).
- Tests:
  - Ratio mode unchanged: the existing `memoryOracle`, `memoryAlgorithms`,
    `hypaV3Parts`, and `hypaV3Limits` suites pass without edits.
  - Equivalence: token mode with `memoryBudgetTokens = floor(C × r)`,
    `headroom = C × h`, `extra = C × e` (choose `C` and ratios whose products are
    integers and that the reduction leaves alone). It must give the same plan
    windows, stop reason, ledger, selection, and forecast as ratio mode on the fixture
    scenarios. This is the main check that every site was switched.
  - The reduction: memory over half, headroom reduced before extra, extra alone over
    half, `P ≤ 0`.
  - Preset validation and defaults, including a stored preset without `budgetMode`
    staying ratio.
  - Report validation of `budgetReduced`.
  - Upstream export of a token-mode preset.

### 2. Settings page and meter (_medium_)

- `MemorySettings.svelte`: the mode control, token inputs, estimated maximum in
  tokens, reduction warning, conversion button, and new presets in token mode.
- `ContextMeter.svelte`: the chip mark, the summary clause, and the popover lines.
- `src/lang/en.ts`, `src/lang/ko.ts`: strings and help texts.
- Docs: [settings-i18n](../structure/settings-i18n.md), [ui-theming](../structure/ui-theming.md)
  where they describe these screens.
- Tests:
  - `MemorySettings.hypaV3Warnings.test.ts`: the warning appears with a too-small
    context and goes away when it fits.
  - Conversion: the values from a known `C`, mode switched, ratios kept.
  - A new preset is token mode.
  - `ContextMeter.svelte.test.ts`: the chip mark and the popover lines from a report
    with `budgetReduced`, and none without it.

## Verification

- V1 gates per slice: `pnpm check`, `pnpm --silent test:agent`, and the slow memory
  tests if selected.
- Manual (browser), after slice 2:
  - New preset: token inputs, labels, help texts.
  - Convert a ratio preset, then send: the same summarize timing as before.
  - Lower the max context below the preset's needs: the settings warning appears at
    once, and after a send the chip shows "memory reduced" with the applied values.
  - Switch back to ratio mode: the old sliders and values return.

## Out of scope

- A trigger independent of `C` (for example a cap on the raw history). It would
  change when summaries start, not only how big the budgets are.
- Token mode for HypaV2 or SupaMemory.
- Token mode in the tab's oracle copy.
- Mixing modes per field.
