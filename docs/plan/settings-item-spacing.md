# Settings Item Spacing Plan

Status: drafted 2026-11-19 at `86035adb4` from the owner's request (three uneven settings layouts were fixed item by
item that day, and the owner asked for a plan for what was too wide to fix in passing). Audited 2026-11-20 at `e5cda6e05`
([report](../reports/audits/plan-runner/settings-item-spacing-2026-11-20.md)): D1 to D4, V6, and the slices were made
precise from its findings. The owner accepted D1 to D4 as written here on 2026-11-20, the compact rhythm of D1 over the
1rem alternative. Landed: 1 (`37fa27e0f`), 2 (`01eb2bd2e`), 3 (`2feb0719c`); every slice landed.

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
- Item counts by type in the catalog (205 items): 93 check, 23 slider, 15 number, 13 select, 12 text, 12 header,
  9 segmented, 4 button, 3 textarea, 21 custom (20 components).
- Fourteen page components mount `SettingRenderer` or `SettingsSections`. Interaction, Advanced, Translation, and
  Language are a renderer and nothing else; Accessibility adds one link. Model, Prompt preset, Memory, Storage, Voice,
  and `ModelProfileEditor.svelte` place renderer output among handwritten controls; Display and Device link put
  page-owned structure around it (a heading and tab navigation; section dividers); `ChatFormatSettings.svelte` is a
  renderer alone, mounted inside two mixed hosts.
- The fixes of 2026-11-19 (`86035adb4` and the commit after it) set `mt-4` and `mt-0` per item on Interaction,
  Advanced, and Model, and the guide's Gotchas describe the wrapper defaults. This plan replaces both.
- No existing spec measures settings-item gaps. Vitest runs in happy-dom, which computes no boxes.
  `e2e/settingsPages.spec.ts` traverses 22 listed menus (Connections, menu 18, is not among them) and checks
  representative writes; `e2e/pluginSandbox.spec.ts` measures browser geometry with `getBoundingClientRect()`.
- `src/styles.css` imports Tailwind 4, whose utilities sit in a cascade layer. A component's own `<style>` rule is
  unlayered and wins over a utility such as `mt-4` whatever its specificity; a `!`-prefixed utility still wins.

## Decisions

Accepted by the owner on 2026-11-20.

- **D1. The rhythm.** Distances are measured between two items' boxes; a labelled control's box runs from its label's
  top to its control's bottom.
  - Kinds: a _row_ is a check or a color; a _field_ is a labelled control (number, slider, text, select, segmented,
    textarea); a _block_ is a header, a button, an accordion, or a custom component.
  - Row after row: 0.5rem.
  - A field has 1rem above its label and 1rem below its control, and the two do not add up between neighbours: field
    after row, row after field, and field after field are each 1rem. A field that ends a run keeps the 1rem below it.
  - The first item of a run, when it is a row or a field, has 0.5rem above it, measured from the bottom of the heading
    wrapper or description before it, or from the container's content edge when nothing precedes it (the top of a
    page's run, or of a collapsible section's body inside its padding). After a handwritten element or a block, that
    element's own bottom margin is added to the 0.5rem: the other side keeps its margin.
  - A header and a button keep their present margins, those in their `classes` included, and the rule sets nothing on
    any block, a block that starts a run included. So a row or field after a block is 0.5rem below the block's own
    bottom margin, and a block after a field is the block's own top margin below the field's 1rem. A custom
    component's own root margin is corrected in the component only where the capture shows it doubling or missing
    beside a row or a field; the slice lists each one it changes, with the distance before and after.

  The alternative is 1rem between rows everywhere (Advanced's rhythm today). The compact one is proposed because 93
  of the 205 items are checks and the check-heavy pages already use it; Advanced and Translation become denser.

- **D2. The renderer owns the space.** `SettingRenderer` marks each anchor with the item's kind (`data-spacing-kind`:
  `row`, `field`, `block`) and carries the rule in its own `<style>`: the selectors are scoped on the anchors
  (`display: contents` keeps them siblings, so `+` pairs two items of one run) and name the child inside
  `:global(...)`, because an item's elements belong to the wrapper component and a scoped selector does not reach them
  (the compiler drops `[data-spacing-kind] > :first-child` as unused and keeps `> :global(:first-child)`). The rule
  sets `margin-top` on a row's or field's first element child (0.5rem by default; 1rem on a field after a row; 0 on a
  row or a field after a field) and `margin-bottom: 1rem` on a field's last element child. It is unlayered, so on
  those elements it wins over a wrapper's or a `classes` utility, except a `!` one. It assumes a flex column parent,
  where margins add and do not collapse; a renderer run inside a block container is checked by capture (slice 2).
  The row and field wrappers stop adding outer margins: `SettingCheck`, `SettingColor`, and `SettingSelect` lose their
  default top margin, `SettingNumber`, `SettingSlider`, and `SettingText` pass `marginBottom={false}`, and
  `SettingSegmented` passes `margin={false}`. `SettingButton` and `SettingHeader` keep their defaults (D1). A
  container `gap` was considered and not chosen: the distance depends on the pair, and handwritten pages share the
  container.
- **D3. `classes` stops carrying margins on rows and fields.** Every margin utility leaves the row and field items of
  the data files; from a string that also carries something else, only the margin tokens are removed, and such an item
  keeps `classes` only for what is not spacing. An exception that must stay is written with `!` and a comment that
  says why. A header or a button keeps its `classes` as they are, margins included (D1). A custom component is kind
  `block`; the rule does not reach inside it.
- **D4. Measured in the browser.** A new spec, `e2e/settingsSpacing.spec.ts`, opens each page the rule covers with
  `showUnrecommended` and `useExperimental` on, opens its collapsible sections, sets up the state its conditional
  items need (named per slice), and asserts that the anchors it expects are present. An anchor has no box: an item's
  box is the union of the `getBoundingClientRect()` boxes of the anchor's element children that have one
  (`getClientRects().length > 0`). For each pair of anchors that are adjacent element siblings, neither of them a
  block, it compares the distance between the two boxes with D1. For a row or field that starts a run under a heading
  wrapper, a description, or the top of its container, it compares the distance to the bottom of the element before
  it, or to the container's content edge when nothing precedes it. Where the neighbour before a row or field is a
  block or a handwritten element, whose own margin adds, it asserts the item's leading side instead: the computed
  `margin-top` of its first element child (0.5rem). Where a field ends a run, or a block or a handwritten element
  follows it, it asserts the field's trailing side: the computed `margin-bottom` of its last element child (1rem). So
  every side the rule governs is asserted one way or the other, a page with a single item included; the trailing side
  of a row with no row or field after it carries no rule and is not asserted. It names the pair and the page when it
  fails.

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
- **V6.** The spec is shown to fail with the rule broken: once with the field-after-row rule removed from
  `SettingRenderer`'s style, on a page with such a pair, and once with a `!mt-4` added to the `classes` of a covered
  row whose expected margin is 0.5rem. (Restoring a wrapper's default margin does not fail it: the rule overrides it.)
- **Ids.** No item id, section id, or `data-setting-id` changes; the search jump (`settingJump.svelte.ts`) highlights
  an anchor's first boxed child and must still find it.

## Slices

### 1. The rule, opt-in, on the renderer-only pages (_hard_)

- `SettingRenderer` takes the kind from the item's type and renders the rule behind an opt-in (a prop that
  `SettingsSections` forwards on both of its branches and `SettingAccordion` forwards to its nested renderer, read by
  the wrappers through the same route). Without the opt-in the anchor carries no `data-spacing-kind` and the wrappers
  keep today's margins, so a page that has not opted in is unchanged.
- Interaction, Accessibility, Advanced, Translation, and Language opt in. Their data files lose the margin tokens of
  their row and field items' `classes` where present (D3), including the `mt-4` and `mt-0` pairs and the spacing
  comments added on 2026-11-19.
- The three custom components these pages render (through Advanced and Translation) are read against D1 here, as
  slice 2 does for the rest.
- `e2e/settingsSpacing.spec.ts` covers these five pages (D4), Translation with its LLM controls shown (a translation
  language selected and `translatorType === "llm"`).
- Test: the spec; V6 as above. `settingsPageSections.test.ts` stays green without edits.
- Done when the five pages match D1 by the spec and by the captures.

### 2. The pages that mix handwritten controls (_hard_)

Depends on 1.

- Model, Prompt preset, Memory, Display, Device link, Storage, Voice, Chat format, and `ModelProfileEditor.svelte`
  opt in, one page at a time, each with the margin tokens of its data file's row and field items removed where
  present. `ChatFormatSettings.svelte` is mounted by two hosts (`OobaSettings.svelte` under Prompt preset,
  `ModelProfileEditor.svelte` under Connections): it takes the opt-in from its host, or both hosts opt in together.
- Where renderer output meets a handwritten control, the handwritten side keeps its margin and the capture decides
  whether the boundary needs one line of spacing on the page; the slice lists each boundary it changed.
- Each of the other 17 custom components (20 components behind the 21 `type: "custom"` items; slice 1 read three) is
  read once, when its host opts in: one whose root margin now doubles or is missing against D1 is corrected in the
  component (D1).
- The spec's page list grows to every page that mounts the renderer, Connections (menu 18,
  `ModelProfileEditor.svelte`) included, with the state the conditional items need: the Ooba model for Prompt preset's
  Chat format, and Jinja selected on the profile each Chat format host edits (Connections passes an explicit profile;
  Ooba uses the edited main profile).
- Done when no row or field item in a data file holds a margin utility in `classes` except the commented `!`
  exceptions (D3). `rg -n 'classes: "[^"]*\bm[tby]?-' src/ts/setting` is the inventory to review, not the proof: it
  misses `mx-`, `ml-`, `mr-`, backtick strings, and conditional expressions, and each margin token that remains must
  be on a header, on a button, or a commented exception.

### 3. The rule becomes the only behaviour (_small_)

Depends on 2.

- The opt-in is removed: the rule always applies, and the row and field wrappers' margin defaults and the opt-in
  branches are deleted (`SettingButton` and `SettingHeader` keep theirs, D1).
- The settings guide's "Renderers and credential links" section states the rhythm and where it lives, its Recipes say
  that a new item takes no margin, and the Gotcha about wrapper defaults that do not compose is removed.
- Done when no row or field wrapper sets an outer margin (`SettingCheck`, `SettingColor`, and `SettingSelect` have no
  default margin class; `rg -n "marginBottom|margin=" src/lib/Setting/Wrappers` shows only `false` values,
  `SettingSegmented`'s explicit `margin={false}` among them) and the spec passes on every page.

## Manual Checks

For the owner, after slice 3; a check that is not run moves to the manual checks backlog when the plan is retired.

- Phone width: the Interaction, Advanced, and Model pages read evenly, and no label wraps onto its control.
- The legacy GUI (`useLegacyGUI`): the same three pages, with their accordions open.
- A settings search jump to an item in a collapsible section still highlights the item.
