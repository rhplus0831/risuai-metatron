# Settings Item Spacing Plan audit, 2026-11-20

- Plan: `docs/plan/settings-item-spacing.md`
- Commit audited: `e5cda6e05`. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Fable 5.2)

| Severity   | Count |
| ---------- | ----- |
| P1         | 2     |
| P2         | 3     |
| P3         | 4     |
| unverified | 1     |

A1 to A9 are `fixed in plan`; A10 is settled outside the code. The first turn filed A1 to A10 against the draft. The
second read the corrected sentences, confirmed A3 and A5 to A8, and disputed A2, A4, and A9 with a fix for each; the
third confirmed A2 and A9 and asked for one more wording change in A4 (which sides the spec asserts), applied as it
gave it.

Two of the corrections are not the auditor's to close. D1 was a proposal the owner had not accepted, and A2's
correction makes it complete by adding readings the original sentence did not state: field after field is 1rem, a
first field takes the 0.5rem, a field that ends a run keeps 1rem below it, and a row or field beside a block or a
handwritten element adds its own side to the neighbour's margin. The auditor confirmed the corrected D1 is consistent
and that D2 produces it; whether it is the rhythm the product should have is the owner's acceptance of D1, asked
before the run schedules a slice.

Sol changed no file. Its first turn reported `read_only_violation: true` with no changed path: branches of another
plan-runner run were created in the shared repository during the turn (`refs/heads/plan-response-checks-1` and that
run's worktree branches, all at 14:53), and this checkout's `HEAD`, index, and tree were unchanged. The later turns
reported `false`. Sol ran no suite and no browser spec; it compiled selector probes in memory with the pinned Svelte
and Tailwind compilers. The three turns took about 14 minutes and 3.4 M tokens.

Re-check list: the plan touches settings layout only, so the jobs, feed, and resource-store entries do not apply.

## P1

### A1. A scoped renderer selector cannot reach wrapper children

- Plan, Decisions, D2: "`SettingRenderer` marks each anchor with the item's kind (`row`, `field`, `block`) and carries
  the rule as adjacent-sibling CSS over the anchors (`display: contents` keeps them siblings), set on each item's first
  element."
- Code: the renderer owns the anchors and mounts a dynamic `<Component {item} {ctx} />` inside each
  (`src/lib/Setting/SettingRenderer.svelte:38`, `src/ts/setting/settingRegistry.ts:16`); the label or row belongs to
  the child component. With the pinned Svelte 5.57.1 (`package.json:123`) a scoped rule ending in `> :first-child` is
  reported as `css_unused_selector` and commented out; the same rule ending in `> :global(:first-child)` compiles and
  keeps its scoping on both anchors.
- Fixed in plan (D2). New: "carries the rule in its own `<style>`: the selectors are scoped on the anchors […] and
  name the child inside `:global(...)`, because an item's elements belong to the wrapper component and a scoped
  selector does not reach them". Confirmed: the same form works for `:last-child` and for adjacent anchor pairs.

### A2. Adjacent-anchor rules cannot supply the section and trailing edges

- Plan, Decisions, D1 and D2: "A labelled control (number, slider, text, select, segmented, textarea) has 1rem above
  its label and 1rem below its control. The first item under a section's heading or description is 0.5rem below it."
  and "The wrappers stop adding outer margins: no default top margin, `marginBottom={false}`, `margin={false}`."
- Code: a first item follows a heading wrapper, a description, or the start of an Accordion body, and a last field can
  precede the end of that body or a handwritten sibling; neither edge has the two anchors `+` needs
  (`src/lib/Setting/SettingsSections.svelte:40`, `src/lib/UI/Accordion.svelte:35`). The Accordion body adds `p-2` and
  a border. A field's first child is its label and its control a separate boxed sibling
  (`src/lib/Setting/Wrappers/SettingNumber.svelte:23`); a custom item can have several boxed children
  (`src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte:73`,
  `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:16`). The shell and the section bodies are flex
  columns, where vertical margins add (`src/lib/Setting/Settings.svelte:350`); Storage's header sits in a block
  container (`src/lib/Setting/Pages/StorageSettings.svelte:20`). Inside one run `+` works across the boxless anchors,
  a false condition removes the whole anchor, and an element sibling such as Voice's handwritten select ends the run
  (`src/lib/Setting/Pages/VoiceSettings.svelte:40`).
- Fixed in plan (D1, D2), pending the owner's acceptance of D1. D1 now names the kinds and states every ordered pair
  and every run start; D2 states the declarations: `margin-top` on a row's or field's first element child (0.5rem by
  default, 1rem on a field after a row, 0 on a row or field after a field) and `margin-bottom: 1rem` on a field's
  last element child. Checked against the code:
  - Every field wrapper has exactly two element children under its anchor, the label `span` and the control's root,
    and the control's own bottom margin sits on that root (`NumberInput.svelte:77`, `SliderInput.svelte:162`,
    `TextInput.svelte:67` and `:98`, `SegmentedControl.svelte:75`, `TextAreaInput.svelte:375`, all under
    `src/lib/UI/GUI/`; `SelectInput.svelte:21` has none), so the bottom rule cannot double with an inner margin. Check
    and Color have one element child.
  - The compiled last-child selector has specificity (0,3,0) and is unlayered: it wins over the Tailwind utilities
    and over `SegmentedControl`'s scoped `.segmented-margin` (0,2,0). A `!` utility wins over it.
  - The resulting distances between boxes in a flex column:

    | Previous | Next row                    | Next field                  | Next block                 |
    | -------- | --------------------------- | --------------------------- | -------------------------- |
    | Row      | 0.5rem                      | 1rem                        | the block's own top margin |
    | Field    | 1rem                        | 1rem                        | 1rem + the block's own top |
    | Block    | the block's bottom + 0.5rem | the block's bottom + 0.5rem | both blocks' own margins   |

  - Run starts: 0.5rem from the bottom of the heading wrapper or the description, or from the Accordion body's content
    edge. After a handwritten element its bottom margin adds: Voice's field follows a select with `mb-4`, 1.5rem
    between boxes (`src/lib/Setting/Pages/VoiceSettings.svelte:40`, `src/lib/UI/GUI/SelectInput.svelte:18`). Device
    link's `<hr>` is a sibling of the next section container, not of an anchor.
  - The parents of every renderer run on the five slice 1 pages are flex columns
    (`src/lib/Setting/Settings.svelte:350`, `src/lib/Setting/SettingsSections.svelte:40`,
    `src/lib/UI/Accordion.svelte:57`).

## P2

### A3. Button and header preservation conflicts with blanket margin removal

- Plan, Decisions, D1 to D3: "A button and a header keep their present margins." against "The wrappers stop adding
  outer margins […]" and "Every margin utility leaves the data files; an item keeps `classes` only for what is not
  spacing."
- Code: `SettingButton` defaults to `mt-4` and two Translation buttons set `mt-2`
  (`src/lib/Setting/Wrappers/SettingButton.svelte:14`, `src/ts/setting/translationSettingsData.ts:310`, `:359`);
  `SettingHeader` has margins by level, with `!` overrides in Advanced, Storage, and Device link, some in a string
  that also carries typography or borders (`src/lib/Setting/Wrappers/SettingHeader.svelte:13`,
  `src/ts/setting/advancedSettingsData.ts:9`, `src/ts/setting/storageSettingsData.ts:11`,
  `src/ts/setting/deviceLinkSettingsData.ts:19`). `NumberInput`, `SliderInput`, and `TextInput` take a boolean
  `marginBottom`, `SegmentedControl` a boolean `margin`; `SelectInput`, `ColorInput`, and `Button` have no such
  switch, and `CheckInput`'s `margin` is horizontal. Handwritten controls use the same primitives, so the change
  belongs at the wrapper call sites.
- Fixed in plan (D2, D3, slice 3). D2 names the wrapper changes one by one and keeps `SettingButton` and
  `SettingHeader`; D3 is limited to row and field items, removes only the margin tokens of a mixed string, and leaves
  a header's or a button's `classes` as they are; slice 3 deletes the row and field wrappers' defaults only. Of the 84
  `classes:` entries, 74 are on rows or fields (47 and 27) and 10 on headers or buttons (7 and 3); no row or field
  carries a `!` margin today.

### A4. The browser check needs explicit item bounds and fixtures

- Plan, Decisions, D4, and slice 2: "for each adjacent pair of `[data-setting-id]` anchors compares the distance
  between the two items' boxes with the rhythm for their kinds" and "The spec's page list grows to every page that
  mounts the renderer."
- Code: an anchor has no box, and the jump helper's first boxed child is a field's label only
  (`src/ts/setting/settingJump.svelte.ts:80`). A pair-only measurement asserts nothing on Voice's single item
  (`src/ts/setting/voiceSettingsData.ts:5`) or on Chat format until its Jinja textarea shows
  (`src/ts/setting/chatFormatSettingsData.ts:33`). The mount spec's menu list omits Connections, menu 18
  (`e2e/settingsPages.spec.ts:24`, `src/ts/settingsMenu.ts:12`); Chat format mounts inside a Connections Accordion
  and inside Prompt preset's Ooba Accordion when the model is `ooba`
  (`src/lib/Setting/Pages/Model/ModelProfileEditor.svelte:361`, `src/lib/Setting/Pages/OobaSettings.svelte:20`).
  Neither named flag shows Translation's LLM controls, which need a translation language and
  `translatorType === "llm"` (`src/ts/setting/translationSettingsData.ts:125`).
- Fixed in plan (D4, V6, slices 1 and 2). D4 defines an item's box as the union of the anchor's boxed element
  children, asserts run starts against the element before them or the container's content edge, and asserts the
  item's own computed margin where the neighbour's margin adds or a field ends a run; the trailing side of a row with
  nothing after it carries no rule and is exempt (the last Accessibility check,
  `src/ts/setting/accessibilitySettingsData.ts:64`). The slices name the fixtures. V6 changed with D2: the rule
  overrides a wrapper's restored default, so the spec is shown to fail with a pair rule removed and with a `!mt-4` on
  a covered row.

### A5. The done-check commands can pass with spacing defaults still present

- Plan, slices 2 and 3: "checked with `rg -n 'classes: "[^"]*\bm[tby]?-' src/ts/setting`" and "Done when
  `rg -n "marginBottom|margin=" src/lib/Setting/Wrappers` shows only `false` values or nothing".
- Code: the slice 2 expression finds today's 83 margin-bearing values, `!mt-4` and `-mt-4` included, and misses
  `mx-`, `ml-`, `mr-`, backtick strings, and conditional expressions. The slice 3 expression finds the three
  `marginBottom={true}` calls and misses `SegmentedControl`'s implicit `true` (`src/lib/UI/GUI/SegmentedControl.svelte:29`)
  and the top-margin defaults of `SettingCheck`, `SettingColor`, and `SettingSelect` (`:15`, `:14`, `:48` of each
  wrapper).
- Fixed in plan (slices 2 and 3). Both searches are inventories to review; the done conditions name the wrapper
  defaults and the explicit `margin={false}`.

## P3

### A6. The item census includes seven test matches

- Plan, Current State and D1: "Item counts by type: 98 check, 24 slider, 16 number […]" and "because 98 of the items
  are checks and the check-only pages already use it".
- Code: the catalog holds 205 items (`src/ts/setting/utils.ts:158`): 93 check, 23 slider, 15 number; the other counts
  match. Five check matches, one slider, and one number are in `src/ts/setting/settingsPageSections.test.ts`.
  Interaction and Accessibility also hold labelled controls.
- Fixed in plan (Current State, D1): the current counts, and "check-heavy pages". No decision changes.

### A7. The page list is complete, but three descriptions are imprecise

- Plan, Current State: "Model, Prompt preset, Memory, Display, Device link, Storage, Voice, Chat format, and
  `ModelProfileEditor.svelte` place renderer output among handwritten controls."
- Code: `ChatFormatSettings.svelte` renders only the renderer (`src/lib/Setting/Pages/ChatFormatSettings.svelte:11`);
  Device link interleaves section dividers (`src/lib/Setting/Pages/DeviceLinkSettings.svelte:9`); Display adds a
  heading and tab navigation (`src/lib/Setting/Pages/DisplaySettings.svelte:22`). The fourteen components are all of
  the direct callers; the other production callers are `SettingsSections.svelte:51` and `:67` and
  `Wrappers/SettingAccordion.svelte:17`.
- Fixed in plan (Current State).

### A8. The test baseline overstates page coverage and names the wrong box API

- Plan, Current State: "No test measures layout." and "`e2e/settingsPages.spec.ts` mounts every page and checks
  writes; `e2e/pluginSandbox.spec.ts` is the one spec that reads a `boundingBox`."
- Code: the settings spec visits 22 listed menus and omits Connections (`e2e/settingsPages.spec.ts:24`); the plugin
  sandbox spec measures with `getBoundingClientRect()` (`e2e/pluginSandbox.spec.ts:231`, `:323`).
- Fixed in plan (Current State).

### A9. The rollout did not account for shared callers and the custom inventory

- Plan, slices 1 and 2: "a prop that `SettingsSections` forwards, read by the wrappers through the same route", "opt
  in, one page at a time, each with its data file's margin `classes` removed", and "Each of the 21 custom components
  is read once".
- Code: the registry and wrappers receive `{ item, ctx }` (`src/ts/setting/settingRegistry.ts:16`); the registered
  `SettingAccordion` mounts the renderer again (`src/lib/Setting/Wrappers/SettingAccordion.svelte:7`; the catalog has
  no `accordion` item today). The 21 custom items are 20 components (`src/ts/setting/customComponents.ts:18`;
  Display uses `NullableTextColorToggle` twice, `src/ts/setting/displaySettingsData.svelte.ts:327`), and three of
  them render on slice 1's pages (`src/ts/setting/advancedSettingsData.ts:274`,
  `src/ts/setting/translationSettingsData.ts:125`). No margin-bearing item array renders in both slices. Prompt
  preset and Connections both mount Chat format with the same items, so an unconditional opt-in in
  `ChatFormatSettings` would switch both hosts at once. Several data files the slices name have no row or field
  `classes` to remove.
- Fixed in plan (D1, slices 1 and 2). The opt-in is forwarded on both `SettingsSections` branches and by
  `SettingAccordion`, and gates the `data-spacing-kind` marker as well as the wrapper margins; slice 1 reads its three
  custom components; Chat format takes the opt-in from its host; the removals read "where present". D1 states when a
  custom component's root margin is corrected (the capture shows it doubling or missing), which the first correction
  had contradicted. The 1 → 2 → 3 order is sufficient with these.

## Unverified

### A10. Workflow availability

- Plan, Rules For Every Slice: "Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow` for one
  marked _hard_."
- The checkout cannot show that the two workflows exist: they are skills of the plan-runner environment, not files of
  the repository. Settled by the orchestrator: both skills are installed in the running session, and this run assigns
  `delegate-implementation` to every slice at the owner's choice. No plan change.

## Found consistent

- The anchor and section markup, each wrapper's margin default, and the control props are as the plan lists them
  (`src/lib/Setting/SettingRenderer.svelte:38`, `src/lib/Setting/SettingsSections.svelte:40`, the wrappers under
  `src/lib/Setting/Wrappers/`).
- The 84 `classes:` entries and their per-file counts match (Advanced 28, Translation 19, Model 12, Display 8,
  Interaction 4, Prompt 4, Device link 3, Language 2, Memory 2, Storage 2).
- The 2026-11-19 fixes are `86035adb4` and `01dcea889`; their `mt-4` and `mt-0` pairs and comments are in the tree,
  and the guide's Gotchas describe them (`docs/structure/settings-i18n.md:358`).
- Tailwind 4 utilities are emitted in `@layer utilities` (`src/styles.css:1`); an unlayered component rule wins over
  them, and a `!` utility wins over that rule.
- The existing spec opens settings through `page.evaluate` and sets flags through `settings.ui`
  (`e2e/settingsPages.spec.ts:49`, `:68`); `showUnrecommended`, `useExperimental`, and `useLegacyGUI` are UI record
  fields (`shared/sections.ts:209`, `:253`); Accordion buttons expose `aria-expanded` and toggle on click
  (`src/lib/UI/Accordion.svelte:37`).
- The legacy GUI renders the same shell, renderers, and section containers (`src/lib/Setting/Settings.svelte:350`).
- The search jump highlights the first direct element child with client rects
  (`src/ts/setting/settingJump.svelte.ts:80`); a kind attribute and moved margins keep that lookup, while a boxed
  spacer inserted first would become its target.
- `settingsPageSections.test.ts` checks ids and placement and needs no edit for a class-only change;
  `settingWrappers.test.ts` mounts the real renderer and wrappers
  (`src/ts/storage/tests/settingWrappers.test.ts:697`).
- Every check command maps to an existing script and a valid wrapper form (`package.json:13`,
  `util/agentTest.mjs:110`, `util/agentE2e.mjs:415`); the e2e command with `settingsSpacing.spec.ts` runs once slice 1
  adds that file.
