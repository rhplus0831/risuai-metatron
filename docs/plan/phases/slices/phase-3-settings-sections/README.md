# Phase 3 Slices: Settings Sections

Drafted 2026-09-30 before the phase started, as a validation of
[`phase-3-settings-sections.md`](../../phase-3-settings-sections.md) against the tree after
Phases 0 to 2 (commit `577c43ae`), then refined after reviews by GPT-6-Astra (12 points) and
Claude Opus (14 points); the decision on every point is in
[`review-decisions.md`](review-decisions.md), and the drift found against the tree, the proposed
phase-file records, the open questions, and the boundaries later phases depend on are in
[`planning-notes.md`](planning-notes.md). At phase start each slice's Assumptions are re-verified; a
false one re-plans that slice.

The execution plan, with the amendments from the pre-implementation plan review (GPT-6-Astra,
then Claude Fable), is [`implementation-plan.md`](implementation-plan.md); where it and a slice
disagree, it wins until the slice is updated with its implementation.

Execution order (arrows are dependencies; slices on one line may run in parallel):

0. **Step 0, fixtures** (part of slice 1, done first, before any other slice starts): the
   pre-phase empty-save boot snapshot and two `.risup` fixtures, committed under
   `src/ts/storage/tests/fixtures/phase3/`. Slice 2 derives defaults from the snapshot, slice 7
   compares against it.
1. [`spike-forwarding-layer.md`](spike-forwarding-layer.md): a vitest-only harness that proves
   the accessor layer over the installed Svelte proxy (binding, snapshot, plugin setters, a
   deferred wrapper write, collection replacement, edit-then-switch). No production code.
   Parallel with slice 2 after step 0.
2. [`shared-schema-and-ids.md`](shared-schema-and-ids.md): `shared/sections.ts` (the
   taxonomy), `shared/presets.ts` (the canonical preset list with defaults taken from the
   pre-phase boot, the two alias maps), required ids on presets, personas, translator and HypaV3
   presets, assigned by the client at every creation site (the Phase 2 message-id precedent).
   Parallel with slice 1.
3. [`server-section-normalizers.md`](server-section-normalizers.md) (needs 2): the five section
   kinds (`providers`, `secrets`, `llmSecrets`, `ui`, `memoryTranslateMedia`) and the twelve
   collection kinds with pure normalizers and node tests, a startup pass that persists
   normalized records, materialization of missing singletons. `root` stays registered.
4. [`client-section-mirrors.md`](client-section-mirrors.md) (needs 3): the client loads and
   saves the sections and collections; `root` shrinks to a residual record holding only the
   preset working copy, the persona working copy, and the three selection indexes;
   per-section watchers replace the root watcher; `setDatabase` shrinks. Not blocked on the
   spike.
5. [`forwarding-presets-and-selection.md`](forwarding-presets-and-selection.md) (needs 1 and
   4): the accessor layer for the preset fields and `proxyKey`, the per-client selection store
   (`presetId`, `loreBookPage`), synchronous settings wrappers, `changeToPreset` by id, the
   keep-on-switch copies. The residual `root` keeps only the persona fields and
   `selectedPersona`.
6. [`forwarding-personas.md`](forwarding-personas.md) (needs 5): the persona accessors,
   `personaId`, `changeUserPersona` and `selectUserImg` by id, the `root` kind removed, the
   resource database schema version bumped to 3 (version 2 refused, as version 1 is today).
7. [`credentials-and-closeout.md`](credentials-and-closeout.md) (needs 6): `proxyKey` per
   preset id in `llmSecrets` through copy, delete, and import; the boot-snapshot comparison
   with its rule; the decoded `.risup` round trip; the phase-file records; docs and invariants.

```
0 fixtures ─┬─→ 1 spike ──────────────────────────────┐
            └─→ 2 schema + ids ─→ 3 server ─→ 4 mirrors ─┴─→ 5 presets ─→ 6 personas ─→ 7 closeout
```

The order puts the sections before the forwarding layer (Opus P12): the accessors are never
installed on an object that a `for ... in` root projection enumerates, so the delete hazard and
the throwaway exclusion code of the first draft do not exist, and slices 3 and 4 do not wait for
the spike. If the spike fails, slices 5 and 6 run in their fallback form (each slice states it).
