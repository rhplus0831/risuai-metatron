# Phase 4 Slices: External Contracts

Drafted 2026-09-30 before the phase started, as a validation of
[`phase-4-external-contracts.md`](../../phase-4-external-contracts.md) against the tree after
Phases 0 to 2 (commit `577c43ae`) and against the planned slices of Phase 3 (which Phase 4
depends on) and Phase 5 (which depends on Phase 4), then refined after reviews by GPT-6-Astra
(11 points) and Claude Opus (13 points); the decision on every point is in
[`review-decisions.md`](review-decisions.md) and summarized in each slice, and the drafting
report (drift, contingent boundaries, open questions, proposed edits to other phases, the
boundaries Phases 5 and 6 depend on) is [`planning-notes.md`](planning-notes.md). Every slice is
`planned`; at phase start each slice's Assumptions are re-verified and a false one re-plans that
slice.

The phase adds no server route, kind, or table. Its one design decision, made in the first
slice and confirmed by both reviews: a mutation is a client function that validates and detaches
its input, writes the mirror by id, and marks the record dirty where the adapter's watchers
would miss it; the save adapter of Phases 1 and 3 stays the transport for characters, sections,
and collections until Phase 6, and one collection (`pluginStorage`) switches to explicit
mutations, its watcher deleted by the slice that routes its last writer (Invariant 2). Phase 5
consumes the function signatures (its Lua, trigger, and plugin ports map them to
`applyChanges`), the mutation scope plus `flushResources({ scope })` as the persistence
contract of a callback, and the per-plugin call context.

Execution order (arrows are dependencies; slices on one line may run in parallel):

1. [`character-and-collection-mutations.md`](character-and-collection-mutations.md): the
   character module, the collection and settings module (with per-value validation), the
   plugin storage module (watcher kept for now), `checkCharOrder` moved into the storage layer,
   the mutation scope for `flushResources`, the dev drift check keyed to the dirty marks. No
   caller yet.
2. [`plugin-host-setters.md`](plugin-host-setters.md) (needs 1): `setDatabase` and
   `setDatabaseLite` as a per-key routing table over `allowedDbKeys` (new characters appended,
   confirmed plugins upserted), the character setters on the module, every plugin storage
   writer explicit and the `pluginCustomStorage` watcher deleted last, arguments, the color and
   text theme paths through `updateSettings`, the plugin `getDatabase` reading forwarded keys
   through the module.
3. [`plugin-call-context.md`](plugin-call-context.md) (needs 2): the per-plugin call context
   (`chatRef`, `presetId`, `personaId`) handed over by the client hook runners, the seven
   selection-dependent host functions and `runLLMModel` resolving through it, and the
   mutation-scope contract for Phase 5's callbacks.
4. [`mcp-risuaccess-writers.md`](mcp-risuaccess-writers.md) (needs 1): the RisuAccess set and
   delete tools by id with re-resolution after consent, `getCharacter` read-only with the two
   `@ts-ignore` lines gone, the module tools, `importMCPModule`, the OAuth refresh entries, the
   Google search credentials.
5. [`lua-character-setters.md`](lua-character-setters.md) (needs 1): the four Lua character
   setters and getters on the executing character (the speaking member in a group) through
   `updateCharacter`; a type-check defect fixed.
6. [`trigger-effect-writers.md`](trigger-effect-writers.md) (needs 1): the eight character
   effects and `v2SetPersonaDesc` as one-field patches on the trigger's character and the
   selected persona; the two-target write removed.
7. [`imports-through-the-module.md`](imports-through-the-module.md) (needs 1): card, module,
   persona, lore, and chat-folder imports through the module; `exportAsDataset` on a snapshot.
8. [`closeout.md`](closeout.md) (needs 1 to 7): the function-level exit audit with the Phase 6
   allowlist (including `src/lib`), the backup round trip on a version-3 store, every guide and
   invariant edit, the phase-file records.

```
1 mutations ─┬─→ 2 plugin setters ─→ 3 call context ─┐
             ├─→ 4 MCP ──────────────────────────────┤
             ├─→ 5 Lua setters ──────────────────────┼─→ 8 closeout
             ├─→ 6 triggers ─────────────────────────┤
             └─→ 7 imports ──────────────────────────┘
```

Slices 2 to 7 touch disjoint source files once 1 has landed (3 follows 2 in the plugin host
file); every `docs/structure/` edit belongs to the closeout, so the parallel slices never touch
one guide twice. Eight slices against the brief's four to seven: both reviewers asked for the
call context and the imports to be their own slices. The CBS item of the phase file ("keep the
injected host callbacks and feed them read models") has no slice here: Phase 5's
`cbs-and-regex-services` folds it in so that the same seam has one owner; the closeout requires
that phase-file amendment to be applied before the phase is declared complete. Boundaries that
move if Phase 3's spike fails: the target of `updateSettings` and `readSetting` for forwarded
keys and the persona id source in slice 6 (each slice states it); the function signatures do not
change.
