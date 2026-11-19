# Settings Item Spacing Plan

Status: drafted 2026-11-19 at `86035adb4` from the owner's request (three uneven settings layouts were fixed item by
item that day, and the owner asked for a plan for what was too wide to fix in passing). D1 to D4 are proposals and
are not accepted yet. Not audited. Landed: none.

Sources: the owner's report of 2026-11-19 (the Interaction and Advanced pages' margins); the wrappers under
`src/lib/Setting/Wrappers/`, `SettingRenderer.svelte` and `SettingsSections.svelte` under `src/lib/Setting/`, and the
data files under `src/ts/setting/`, read at `86035adb4`; captures of all 22 settings pages in the Korean UI taken that
day through a temporary Playwright spec (not kept); the
[settings guide](../structure/settings-i18n.md). Identifiers are the anchors; re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

## Goal

The space between two declarative settings items follows from what the two items are, on every page, without a
`classes` string per item.

- **One rhythm.** A reader sees the same distance between two checks, and the same distance around a labelled
  control, on every settings page.
- **No per-item margin.** Adding, moving, or hiding an item does not need a margin edit on it or on its neighbour.
- **Checked by measurement.** A browser spec measures the distances, so a new item or wrapper cannot bring an uneven
  gap back unnoticed.

Not goals: the handwritten controls of a page (a page's own buttons, lists, and editors keep their layout), the
distance between sections, the look of any control, and the chat screen or sidebar.

## Current State

- `SettingRenderer.svelte` renders each visible item through `settingRegistry[item.type]` inside
  `<div class="contents" data-setting-id={item.id}>`. The anchor has no box, so an item's elements are laid out as
  children of the caller's container.
- `SettingsSections.svelte` puts a section's items in `<section class="mt-6 flex flex-col">` after an `h3` and an
  optional description, or, for a collapsible section, in the styled `Accordion`'s `flex flex-col` body.
- Each wrapper sets its own margin, and the defaults differ:
  - `SettingCheck` and `SettingColor`: `item.classes ?? "mt-2"` on the row, no bottom margin.
  - `SettingSelect`: `item.classes ?? "mt-4"` on the label, no bottom margin.
  - `SettingNumber`, `SettingSlider`, `SettingText`: `item.classes ?? ""` on the label, and the input with
    `marginBottom={true}` (`mb-4`).
  - `SettingSegmented`: `item.classes ?? ""` on the label; `SegmentedControl`'s `margin` defaults to true (1rem below).
  - `SettingTextarea`: `item.classes ?? ""` on the label, no bottom margin.
  - `SettingButton`: `item.classes ?? "mt-4"`. `SettingHeader`: fixed margins by level, with `classes` appended.
  - `SettingCustom` passes nothing: each custom component sets its own (21 `type: "custom"` items).
- So a default check after a default number field is 1.5rem away, a default segmented label after a check touches
  it, and a select after a number field is 2rem away. Pages correct this per item: 84 `classes:` entries in ten data
  files (`advanced` 28, `translation` 19, `model` 12, `display` 8, `interaction` 4, `prompt` 4, `deviceLink` 3,
  `language` 2, `memory` 2, `storage` 2). Some of them are not spacing (`bg-red-500 text-sm`,
  `!text-textcolor2`, borders).
- Two rhythms exist. Checks are 0.5rem apart on Interaction, Accessibility, and the top of the Model page; they are
  1rem apart (`classes: "mt-4"`) on Advanced, Translation, and the Model page's advanced section.
- Item counts by type: 98 check, 24 slider, 16 number, 13 select, 12 text, 12 header, 9 segmented, 4 button,
  3 textarea, 21 custom.
- Fourteen page components mount `SettingRenderer` or `SettingsSections`. Interaction, Advanced, Translation, and
  Language are a renderer and nothing else; Accessibility adds one link. Model, Prompt preset, Memory, Display,
  Device link, Storage, Voice, Chat format, and `ModelProfileEditor.svelte` place renderer output among handwritten
  controls.
- The fixes of 2026-11-19 (`86035adb4` and the commit after it) set `mt-4` and `mt-0` per item on Interaction,
  Advanced, and Model, and the guide's Gotchas describe the wrapper defaults. This plan replaces both.
- No test measures layout. Vitest runs in happy-dom, which computes no boxes. `e2e/settingsPages.spec.ts` mounts
  every page and checks writes; `e2e/pluginSandbox.spec.ts` is the one spec that reads a `boundingBox`.
- `src/styles.css` imports Tailwind 4, whose utilities sit in a cascade layer. A component's own `<style>` rule is
  unlayered and wins over a utility such as `mt-4` whatever its specificity; a `!`-prefixed utility still wins.

## Decisions

Proposals; the owner accepts, changes, or rejects each before a slice starts.

- **D1. The rhythm.** Two consecutive rows (check, color) are 0.5rem apart. A labelled control (number, slider, text,
  select, segmented, textarea) has 1rem above its label and 1rem below its control. The first item under a section's
  heading or description is 0.5rem below it. A button and a header keep their present margins.
  The alternative is 1rem between rows everywhere (Advanced's rhythm today). The compact one is proposed because 98
  of the items are checks and the check-only pages already use it; Advanced and Translation become denser.
- **D2. The renderer owns the space.** `SettingRenderer` marks each anchor with the item's kind (`row`, `field`,
  `block`) and carries the rule as adjacent-sibling CSS over the anchors (`display: contents` keeps them siblings), set
  on each item's first element. The wrappers stop adding outer margins: no default top margin, `marginBottom={false}`,
  `margin={false}`. A container `gap` was considered and not chosen: the distance depends on the pair, and
  handwritten pages share the container.
- **D3. `classes` stops carrying margins.** Every margin utility leaves the data files; an item keeps `classes` only
  for what is not spacing. An exception that must stay is written with `!` and a comment that says why.
  A custom component keeps its own margins and is kind `block`; the rule does not reach inside it.
- **D4. Measured in the browser.** A new spec, `e2e/settingsSpacing.spec.ts`, opens each page the rule covers, opens
  its collapsible sections with `showUnrecommended` and `useExperimental` on, and for each adjacent pair of
  `[data-setting-id]` anchors compares the distance between the two items' boxes with the rhythm for their kinds.
  It names the pair and the page when it fails.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** `pnpm check`, the focused command
  `pnpm --silent test:agent src/ts/setting src/lib/Setting src/ts/storage/tests/settingWrappers.test.ts`, then
  `pnpm --silent test:agent` once whole after the last source edit, `pnpm --silent test:agent --e2e
e2e/settingsSpacing.spec.ts e2e/settingsPages.spec.ts`, `pnpm format:check`, and `pnpm check:docs` for a guide edit.
  `pnpm check:tests` after adding the spec.
- **Captures.** Before and after captures of every page the slice touches, in the Korean UI with the collapsible
  sections open, read by the session; the slice's report lists each page whose layout changed and why. Captures are
  not committed.
- **V6.** The spec is shown to fail with one wrapper's margin restored.
- **Ids.** No item id, section id, or `data-setting-id` changes; the search jump (`settingJump.svelte.ts`) highlights
  an anchor's first boxed child and must still find it.

## Slices

### 1. The rule, opt-in, on the renderer-only pages (_hard_)

- `SettingRenderer` takes the kind from the item's type and renders the rule behind an opt-in (a prop that
  `SettingsSections` forwards, read by the wrappers through the same route, so a page that has not opted in is
  unchanged).
- Interaction, Accessibility, Advanced, Translation, and Language opt in. Their data files lose their margin
  `classes`, including the `mt-4` and `mt-0` pairs and the spacing comments added on 2026-11-19.
- `e2e/settingsSpacing.spec.ts` covers these five pages (D4).
- Test: the spec; V6 as above. `settingsPageSections.test.ts` stays green without edits.
- Done when the five pages match D1 by the spec and by the captures.

### 2. The pages that mix handwritten controls (_hard_)

Depends on 1.

- Model, Prompt preset, Memory, Display, Device link, Storage, Voice, Chat format, and `ModelProfileEditor.svelte`
  opt in, one page at a time, each with its data file's margin `classes` removed.
- Where renderer output meets a handwritten control, the handwritten side keeps its margin and the capture decides
  whether the boundary needs one line of spacing on the page; the slice lists each boundary it changed.
- Each of the 21 custom components is read once: one whose root margin now doubles or is missing against D1 is
  corrected in the component.
- The spec's page list grows to every page that mounts the renderer.
- Done when no data file holds a margin utility in `classes` except the commented `!` exceptions (D3), checked with
  `rg -n 'classes: "[^"]*\bm[tby]?-' src/ts/setting`.

### 3. The rule becomes the only behaviour (_small_)

Depends on 2.

- The opt-in is removed: the rule always applies, and the wrappers' margin defaults and the opt-in branches are
  deleted.
- The settings guide's Renderers section states the rhythm and where it lives, its Recipes say that a new item takes
  no margin, and the Gotcha about wrapper defaults that do not compose is removed.
- Done when `rg -n "marginBottom|margin=" src/lib/Setting/Wrappers` shows only `false` values or nothing, and the
  spec passes on every page.

## Manual Checks

For the owner, after slice 3; a check that is not run moves to the manual checks backlog when the plan is retired.

- Phone width: the Interaction, Advanced, and Model pages read evenly, and no label wraps onto its control.
- The legacy GUI (`useLegacyGUI`): the same three pages, with their accordions open.
- A settings search jump to an item in a collapsible section still highlights the item.
