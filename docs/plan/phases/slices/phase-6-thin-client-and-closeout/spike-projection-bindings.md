# Slice: Spike, Projection Binding Pattern

Status: run on 2026-10-04 (results and the proposed verdict below; the owner confirms the verdict at Stop A).

Phase: [Phase 6](../../phase-6-thin-client-and-closeout.md), "Projections" (the binding pattern
every projection uses) and the Safety Contract ("no projection recreates an aggregate database
under another name"); `PLAN.md` End State ("the client keeps per-screen projections of server
data ... and writes only through explicit mutation calls"), invariant 2 (every write ends in an
explicit mutation; the adapter is deleted per collection), invariant 3 (the shape of
`DBState.db` shrinks last).

Depends on: Phase 3 slice 1 (`spike-forwarding-layer`: the accessor proofs over the installed
Svelte proxy, `src/ts/storage/tests/forwardingHarness.svelte.ts`) and slice 5 (the synchronous
function-binding wrappers). Phase 4 (the allowlist of core-app writers its closeout records: the
write shapes the pattern must cover). No Phase 5 dependency. First slice of the phase, in
parallel with `live-updates`.

## Scope

Allowed files: `src/ts/storage/tests/projectionSpike.test.ts` (new), `src/ts/storage/tests/projectionHarness.svelte.ts`
(new; the prototype write-through record, test-only), and the verdict appended to this file. No
production file. The production owner of the chosen implementation is `settings-ownership`,
which creates `src/ts/storage/records.svelte.ts` from the harness (Astra P7, Opus P13).

Identifiers (verified 2026-09-30; every count is matching lines, tests excluded): the binding
inventory the pattern must serve: 394 `bind:` sites onto `DBState.db` in 25 files under
`src/lib` (`rg -n 'bind:[A-Za-z]+=\{?DBState\.db' src/lib`); by family: character-owned 80
(`CharConfig.svelte` 71, `LoreBookSetting.svelte` 5, `LoreBookList.svelte` 2, `Sidebar.svelte`
2), preset-owned 147 (`BotSettings.svelte` 59, `OobaSettings.svelte` 43 of which 42 are nested
`reverseProxyOobaArgs.*`, `PromptSettings.svelte` 22, `EasyPanel.svelte` 11,
`AuxModelSelectors.svelte` 5, `OpenrouterSettings.svelte` 4, `SeparateParametersSection.svelte`
2, `CustomSidebar.svelte` 1), personas 4, plugins 4, other root settings 159
(`OtherBotSettings.svelte` 96 of which 20 are nested `NAIImgConfig.*`, 9 `sdConfig.*`, 8
`comfyConfig.*`, 5 `openaiCompatImage.*`); plus 5 getter/setter chat bindings
(`CharConfig.svelte:468-471, 1753-1758, 1786-1791`, `DevTool.svelte:133-139, 143-149`) the
single-line regex does not match. The direct-assignment shapes of Phase 4's allowlist (its
closeout slice): handler assignments (`DBState.db.x = v`), `push`/`splice` onto a collection
(`characters`, `modules`, `personas`, `botPresets`, `customModels`, `translatorPresets`,
`hypaV3Presets`, `loreBook`, `hotkeys`), whole-array replacement (`DBState.db.characterOrder = [...]`),
and the cast form `(db.characters[i] as character).x = v`; 249 matching lines in 31 files under
`src/lib` and 53 in 16 under `src/ts` today with the regex
`DBState\.db(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]\n]+\]|[[:space:]]+as[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*\)?)*[[:space:]]*(?:\?\?=|\|\|=|\+=|-=|=(?![=>])|\+\+|--)`
(`rg -P`). The declarative registry: 155 `bindKey` items across
`src/ts/setting/{accessibility,advanced,botSettingsParams,chatFormat,display,language}SettingsData*.ts`,
read and written through `getSettingValue`/`setSettingValue` (`src/ts/setting/utils.ts:30-64`:
`item.getValue(DBState.db, ctx)` and `item.setValue(DBState.db, value, ctx)` first, then
`bindPath`, then `bindKey`; 8 `getValue`/`setValue` item pairs in
`displaySettingsData.svelte.ts:417-454`) and `SettingSegmented.svelte:53`
(`bind:value={(DBState.db as any)[item.bindKey]}`); `SettingRenderer.svelte:20-28` passes the
live `DBState.db` as `ctx.db`. The Phase 3 harness (`forwardingHarness.svelte.ts`) and its proofs
1 to 6. The Svelte 5.57.1 proxy facts the Phase 3 spike records (accessor descriptors survive
`$state`; `deleteProperty` shadows reads). Phase 4's `characterStore.svelte.ts` (`updateCharacter`,
`replaceCharacterFields`, `addCharacter`, `removeCharacter`), `collectionStore.svelte.ts`
(`updateSettings`, `setPersonas`, `setModules`, ...), `pluginStorageStore.svelte.ts`: the
functions a write-through record's `onWrite` must reach.

Stopping condition: neither candidate pattern below passes all proofs for a reason the design
cannot fix (not a harness bug). The spike stops, records which proof failed, and the projection
slices run in the fallback form (explicit function bindings at every site, calling the Phase 4
mutation functions).

## Assumptions

- Phase 3 shipped the accessor forwarding layer (its spike passed) and the synchronous
  function-binding wrappers (`bind:value={() => get(), (v) => set(v)}`); if Phase 3 ran in its
  fallback form (`SelectedPreset`/`SelectedPersona` projections written by id), that projection
  is already a write-through record and this spike only extends it to nested containers.
- The Svelte proxy behaves as the Phase 3 spike recorded (5.57.1 source): an accessor on the raw
  object is honored by `bind:`, `$state.snapshot`, `JSON.stringify`, and `Object.keys`.
- Phase 4 (`character-and-collection-mutations`, `closeout`, verified against its slices): the
  contract writers (plugins, MCP, Lua, triggers, importers) go through `characterStore`,
  `collectionStore`, and `pluginStorageStore`; the core-app writers (the `bind:` sites, the
  handler assignments and collection pushes under `src/lib`, `characters.ts`,
  `lorebook.svelte.ts`, `modules.ts`, `bootstrap.ts`, `index.svelte.ts`, `group.ts`,
  `persona.ts`, `colorscheme.ts`, the settings wrappers, `stores.svelte.ts:174`) are left direct
  for Phase 6 in an allowlist. The pattern therefore has to serve every shape in that allowlist,
  not only `bind:` (Opus P13).

## Proposed decisions

- Owner verdict line (Opus P13): the plan owner accepts the write-through record below as the
  mutation boundary for projections (a property `set` that synchronously calls the record's
  Phase 4 mutation function with the id and revision captured at the write is the explicit
  mutation of invariant 2; it is not `$effect` diffing), or the fallback applies: explicit
  function bindings at every site. The verdict is recorded here before the first projection
  slice starts.
- Candidates (proposed; the spike measures both on the same proofs):
  1. **Accessor-backed record** (Phase 3's technique generalized): `projectRecord(read, write)`
     builds a plain object with one enumerable accessor per top-level field of the record; the
     getter reads the underlying `$state` record; the setter calls the record's mutation
     synchronously (`updateCharacter(chaId, { [field]: value })`, `updateSettings({ [field]: value })`,
     or the collection setter), which validates, writes the mirror, and queues the record write.
     Nested containers are returned as the underlying `$state` sub-objects, so a nested `bind:`
     writes into the store without passing the setter; the write is then recorded by candidate 2
     for that container or by a field-level call the nested editors make (the Phase 2
     `useLocalLoreDraft` precedent: an editing copy saved through one mutation on every change).
  2. **Deep write-through record**: `trackedRecord(record, onWrite)` wraps the `$state` record in
     a JS `Proxy` whose `get` returns nested wrappers carrying their path and whose `set` (and
     `deleteProperty`) forwards to the Svelte proxy and calls `onWrite(topLevelField)` in the same
     task. Every write, top-level or nested, `push`/`splice` included (they set indices and
     `length`), becomes one queued patch for the record with the revision captured at the write.
     Wrappers are cached per target in a `WeakMap`.
- Proofs, each a vitest case over the harness with two section records, one preset record, and
  one character record with a 300-entry `loreBook`, run against `storeBackedServer.ts` where a
  write is involved:
  1. `bind:value` on a top-level field, on a nested field (`reverseProxyOobaArgs.temperature`),
     and on an array element (`loreBook[3].content`) writes into the record and queues exactly one
     patch for that record with the revision the client holds; a second write within the debounce
     coalesces into the same patch.
  2. `$state.snapshot`, `JSON.stringify`, `Object.keys`, and a JSON clone of a projection yield
     plain data equal to the record (no wrapper leaks into a snapshot).
  3. Every allowlist shape: a handler assignment, `push`, `splice`, `sort`, and `unshift` on a
     nested array (the lorebook reorder in `LoreBookList.svelte`), a whole-array replacement
     (`characterOrder = [...]`), the cast form, and a `delete` of a key are each captured as one
     patch.
  4. The registry path: `getSettingValue`/`setSettingValue` over a projection with `bindKey`,
     `bindPath`, and the item-level `getValue`/`setValue` functions resolve and write the same way
     as over `DBState.db` today.
  5. Cost: 1,000 sequential nested writes into the 300-entry character record and a re-render of
     a component bound to 60 fields; the write path must not serialize the whole record per
     keystroke (serialization happens once per debounce cycle, as today's `projectCharacter`).
  6. Edit-then-switch: an edit on the selected preset projection followed in the same task by a
     selection switch lands in the original record (Phase 3's proof 6 over the new pattern).
  7. Live replacement: replacing the underlying record (a conflict reload or a live-update event)
     while a component is bound re-renders from the new record and a later write targets the new
     record with its revision.
- Verdict rule (proposed): candidate 2 is adopted as the general pattern if proofs 1 to 7 pass
  and proof 5 stays within 2x of today's binding cost; candidate 1 is adopted for the section
  records (flat, where nested containers are few) with candidate 2 for characters and presets if
  candidate 2 fails only proof 5. If both fail a correctness proof, the fallback is explicit
  function bindings at every site calling the Phase 4 functions, and the projection slices'
  allowed files stay the same.
- The transport the pattern feeds (owned by `settings-ownership`): `queueRecordWrite(kind, id)`
  marks a record for the next cycle (the record is serialized at flush time from the store, as
  `projectCollection` and `projectCharacter` do today), so the wire contract (`{ kind, id, baseRevision, data }`
  whole-record ops) does not change in this phase. Phase 3 chose whole-record sections and Phase
  4 rejected a second op protocol for records; per-field section ops are not in this phase.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`. The seven proofs in vitest, the timing of proof 5
recorded here with the machine, and the verdict recorded here. No production behavior changes.

## Residual risk

The harness covers three record shapes; a settings page may bind a shape the spike did not
exercise (a `null` container such as `promptTemplate` or `reverseProxyOobaArgs`). The projection
slices report such a site as a stopping condition rather than inventing a third pattern.

## Results

Run on 2026-10-04 by the test adapter on `8118bcee`, in three rounds: the second answered the
Astra challenge, the third the reviewer's finding (duplicate ids). Svelte 5.57.1 (dev build under vitest), vitest 4.1.11, happy-dom, Node v24.21.0, on an
AMD Ryzen 9 3900X under WSL2 (Linux 6.18.40.1-microsoft-standard-WSL2). The proofs are the slice's
seven plus seven from the plan review (R2, R11, R15, Phase 3's recorded hazards), as listed in
[`implementation-plan.md`](implementation-plan.md) "Slice 1", five more from the challenge
(R2-1 to R2-7 below), and the reviewer's identity cases (R3 below).

Files (all test-only, under `src/ts/storage/tests/`):

- `projectionHarness.svelte.ts`, the prototype:
  - a record store with one `$state` slot per `(kind, id)`, booted from the real server store. It
    holds the `ui`, `providers`, and `secrets` sections; the `llmSecrets` record in its mirror form
    (the masked status in the real `llmSecretState`); `presets/main` with presets `a` (a
    `seperateParameters.overrides` map) and `b` (`openrouterProvider: null`); and
    `characters/cha-spike` with a 300-entry `globalLore`;
  - `applyRaw`, the raw application path, which never queues;
  - both candidates, a root facade installed on `DBState.db`, and `findLiveWrappers`, which walks
    the live records and fails on any wrapper at any depth;
  - `queueRecordWrite` and a reduced transport prototype that mirrors the save loop's rules
    (identity captured at the write; text and `baseRevision` taken at flush; the `settle` rule on
    acknowledgement; a 409 reloads and reports; `applyRemote` as the hydration prototype with the
    application fence). It does not model quarantine, generation blocks, restore handling, the
    credential acknowledgement, or batching limits: those stay slice 4's integration work.
- `projectionSpike.test.ts`: 162 cases. Each proof runs for candidate 1 and for candidate 2 with and
  without a resolve cache. Of the 43 candidate-1 cases, 27 assert one of its failures, so the pass
  count is not a count of successful proofs.
- `SpikeRecordInput.svelte`, `SpikeRecordSync.svelte`, `SpikeRecordMany.svelte`,
  `SpikeRecordList.svelte`, `SpikeRecordRow.svelte`: a plain `bind:value`, the function binding over
  the real `getSettingValue`/`setSettingValue`, 60 bound fields, and a keyed list whose rows bind
  into a child component and the real `CheckInput.svelte`.

Candidate 2's rules, as the harness implements them:

- **Identity.**
  - The root wrapper resolves its record by `(kind, id)` on every trap, so a cached wrapper reaches
    the current record after a replacement.
  - There is one wrapper per logical item. An array element is found by its id only in a field
    whose normalizer makes ids unique (`BY_ID_FIELDS`: the presets list, `normalizePresets` in
    `shared/presets.ts`; the selectable collections would qualify through `selectableList` in
    `server/src/data/normalize/collections.ts` but are not modeled). An object child is found by
    its field. Every other array element, with or without an id (lorebook entries, whose ids can
    repeat after a re-import), is found by its object, and across a raw replacement by its path.
  - A retained and a freshly fetched wrapper are the same object, so `includes` and `indexOf` work,
    including for an element that gains an id through its wrapper. Exception: an id-less wrapper
    whose element moved locally and then went through a raw replacement follows the path.
  - In a `BY_ID_FIELDS` field, a write through an id that now matches more than one element is
    refused (`DuplicateIdError`) before any state changes, because uniqueness can break between a
    local write and the next normalization.
  - A write through a wrapper whose item is gone throws (`DetachedWrapperError`) before any state
    changes.
- **Assignment.**
  - Assigning a wrapper stores its item's current object, never a stale one.
  - Array mutators run in a mutator scope, so the elements they displace are written back as they
    were read.
  - Same-task re-insertion: an element that a write overwrote or removed in the current task can
    be assigned back (the indexed swap of `CustomModelsSettings.svelte:65` needs this). The
    window closes at the next microtask, so a swap split by an `await` throws halfway and leaves a
    duplicated element.
  - A value from another record, or a `$state` editing copy, is stored as a detached copy, so a
    record never holds a wrapper or shares another object's state.
- **Credentials.** Through the `llmSecrets` wrapper, every credential path goes to the real
  `setSecret`/`clearSecret` or is refused before any state changes:
  - flat fields and nested leaves are routed; a whole container's siblings go to the record and its
    leaf is routed (a blank or absent leaf changes nothing);
  - `OaiCompAPIKeys` entries are routed; a write of an entry map and every `delete` are refused;
  - the root `proxyKey` accessor reads `""` and writes the selected preset's entry, as
    `forwarding.svelte.ts` does;
  - the facade reads `""` for every credential;
  - `customModels.<id>.key` is slice 4's and not modeled.
- **`__proto__`.** An own `__proto__` key is rebuilt through the real `writeEntries`.

| Proof                                        | Candidate 1 (accessor)                           | Candidate 2 (deep) |
| -------------------------------------------- | ------------------------------------------------ | ------------------ |
| 1 binding                                    | top-level fields only                            | pass               |
| 2 snapshots carry no wrapper                 | pass                                             | pass               |
| 3 every write shape, live records inspected  | top-level fields only                            | pass               |
| 4 registry                                   | top-level fields only                            | pass               |
| 5 cost                                       | ×1.1–1.2 (writes not queued)                     | ×6.0 (fails 2×)    |
| 6 edit, then same-task switch                | fail (lands in `a`, not queued)                  | pass               |
| 7 live replacement                           | top-level fields only                            | pass               |
| 8 own `__proto__` key                        | partial (a plain write is dropped)               | pass               |
| 9 `llmSecrets` siblings and credential paths | fail (plaintext kept in the record, writes lost) | pass               |
| 10 retained references                       | fail (writes lost silently)                      | pass               |
| 11 retained preset never redirects           | fail (lands in `a`, not queued)                  | pass               |
| 12 hydration queues nothing                  | pass                                             | pass               |
| 13 edit → remote notice → flush              | pass                                             | pass               |
| 14 edit during its own acknowledgement       | pass                                             | pass               |
| R2-1 assigning a retained wrapper            | not applicable                                   | pass               |
| R2-2 no wrapper in a live record             | not applicable                                   | pass               |
| R2-4 in-flight fence                         | pass                                             | pass               |
| R2-5 keyed rows, child bindings, identity    | lands, not queued; identity not stable           | pass               |
| R2-6 clone and array boundaries              | clone passes; nested writes not queued           | pass               |
| R2-7 bulk paths                              | not applicable                                   | ×4.3–4.5, ×3.3–3.8 |
| R3 duplicate ids, id acquisition, refusal    | not applicable                                   | pass               |

- **Candidate 1's failures are inherent.** Accessors exist only at a record's top level, so every
  write inside a container (including `delete`, and writes through retained objects after a
  replacement) skips the queue.
- **The transport proofs** (13, 14, R2-4) use the real server store, so the revisions and the 409s
  are real.
  - The flush sends the held `baseRevision`, never a remote one; the 409 reloads and reports.
  - A dirty mark with unchanged text lets the remote record apply.
  - An edit during its own acknowledgement stays queued and is sent on the acknowledged revision.
  - A record in flight is not hydrated even when its text equals the saved text; the deferred
    record is checked again after the batch settles.
- **The boundaries** (R2-6):
  - `structuredClone(wrapper)` throws, and the real `safeStructuredClone` fallback (`rfdc`) returns
    detached data without writing anything;
  - `Object.assign`, `reverse`, `fill`, and an overlapping `copyWithin` through a wrapper give the
    same result as on a plain copy and are queued.
- **The tests catch the challenge's defects.** Each check was run against a harness with its fix
  removed and then restored:
  - round 1's assignment rule (a retained wrapper restoring stale data) fails 10 cases;
  - storing editing copies as they are fails 2;
  - removing both the mutator scope and re-insertion fails 8;
  - round 2's identity rule (by id for any element with a string `id` or `chaId`) fails the 6
    duplicate-id and id-acquisition cases;
  - removing the duplicate-id refusal fails 2.
- **The duplicate-id defect** (round 3). Under round 2's rule, two lorebook entries with the same
  id shared one wrapper, and an edit in the row bound to entry 5 landed in entry 9. Now two rows
  bound to `globalLore[5]` and `[9]` with `id: "dup"` each write their own entry, and the flush
  sends exactly that.

**Cost.** These are dev-mode microbenchmarks under happy-dom, medians of 9 rounds, with ranges across
three runs after round 3:

| Measurement                                           | Direct `$state` | Candidate 2             | With the resolve cache  |
| ----------------------------------------------------- | --------------- | ----------------------- | ----------------------- |
| 1,000 nested leaf writes, 300-entry character         | 2.1–2.2 ms      | 12.3–12.7 ms (×5.7–6.1) | 7.9–8.3 ms (×3.7–4.0)   |
| Lorebook drag: 300 new items, then the field replaced | 6.2–6.4 ms      | 26.8–28.6 ms (×4.3–4.5) | 12.7–14.3 ms (×2.1–2.2) |
| Preset reorder, 50 presets                            | 0.18–0.19 ms    | 0.63–0.66 ms (×3.3–3.8) | 0.46–0.50 ms (×2.5–2.8) |

- No serialization happens during the writes; the flush serializes once.
- The flat 60-field component's mount and re-render times were comparable across the candidates.
- Round 1 measured ×5.6 for the leaf writes; the round 2 rules (canonical identity, displacement
  tracking, unwrapping) raised it to about ×6.0; round 3's duplicate-id check is within run-to-run
  noise.
- An exploratory profile in round 1 (about 3.4 µs per nested read through a wrapper against 1.4 µs)
  was not kept and is not reproduced by the suite.
- A production build was not measured.

Svelte and proxy facts slice 4 must build on (5.57.1):

- **`__proto__` on a `$state` proxy:**
  - an assignment of `__proto__` is dropped silently;
  - a `defineProperty` of it reads back but is never enumerated (`internal/client/proxy.js:343-352`),
    so JSON drops it;
  - `$state.snapshot` drops it (`internal/shared/clone.js:93`), and `rfdc` (the `safeStructuredClone`
    fallback) turns it into the clone's prototype;
  - only a container assigned whole with an own key keeps it, which is the `writeEntries` route.
- **Wrappers inside state.**
  - A wrapper passes Svelte's own-proxy check (`proxy.js:45`), so a wrapper written raw is stored as
    is: every value written through a wrapper is unwrapped first.
  - Unwrapping uses the object the wrapper stood for when it was read, because `sort` writes
    elements back while the array is half rewritten.
  - `STATE_SYMBOL` is not exported (the harness captures it with a probe).
- **Reads go through `get`.** Svelte's `getOwnPropertyDescriptor` trap (`proxy.js:206`) can return a
  raw value, so a write through it would bypass the signals.
- **Dev equality resolves wrappers.**
  - In dev builds `===` and `!==` in `.svelte.ts` compile to `strict_equals`
    (`internal/client/dev/equality.js:77`). Its `get_proxied_value` (`proxy.js:381`) runs a wrapper's
    `has` trap, which resolves it.
  - This side effect masked the stale-assignment defect in round 1 and does not exist in a
    production build, so the record module must not rely on it. It also warns when a wrapper is
    compared with its own `$state` object; the harness uses `Object.is`.
- **Indexed swaps.** `temp = list[i]; list[i] = list[i - 1]; list[i - 1] = temp` needs same-task
  re-insertion (or a move to `splice` or a mutation function); under a strict current-identity
  rule it throws halfway and leaves a duplicated element. The harness's window closes at the next
  microtask.
- **By-id identity is sound only where ids are unique.** Keep it as a named allowlist of fields
  whose normalizer makes ids unique, refuse a write through a duplicated id there, and use object
  or path identity everywhere else (lorebook entries included).
- **Object-identity comparisons in production** that the canonical wrapper keeps working:
  - `LoreBookData.svelte:299` (`globalLore.includes(value)`);
  - `LoreBookList.svelte:256-272` (a `Set` over a copied array's items);
  - the swaps in `CustomModelsSettings.svelte:65` and `:80`.

Not covered:

- `characterOrder` (the slice marks it optional);
- the `bindPath` registry item is a literal copy of `lang.deeplXUrl`, because importing it pulls in
  the translator;
- routed credential writes are checked in the `setSecret` queue but not sent by the prototype
  transport;
- unassisted candidate 1 aside, the hybrids (candidate 1 plus explicit nested setters) were not
  measured.

## Verdict (proposed; the owner confirms at Stop A)

**Candidate 2, the deep write-through record without the resolve cache, for every record.** It
passes every implemented correctness case, including the challenge's (Astra's Phase 6 slice 1
challenge, 2026-10-04) and the reviewer's duplicate-id cases. That departs from the verdict rule above in two ways, so the owner confirms
it at Stop A.

- **The cost rule is missed.** Candidate 2 is about ×6 of direct writes for nested leaf writes, ×4.3–4.5
  for a lorebook drag, and ×3.3–3.8 for a preset reorder, not within 2×.
  - In absolute terms that is about 13 µs per nested write against 2 µs, and about 28 ms for a
    300-item drag drop against 6 ms. A keystroke stays far below a frame.
  - The 2× bound stood in for "binding stays as cheap as today"; the dev-mode numbers above answer
    that only partly: the absolute dev-mode costs stay far below a frame on the measured paths,
    but parity with today is not shown.
- **The rule's split does not apply.** On a cost-only failure, the rule puts candidate 1 on the
  section records, assumed flat. They are not: 51 `bind:` sites under `src/lib` write into nested
  section containers (`NAIImgConfig` 20, `sdConfig` 9, `comfyConfig` 8, `hypaCustomSettings` 6,
  `openaiCompatImage` 5, `wavespeedImage` 3), which candidate 1 loses silently (proofs 1, 3, 10).
- **No resolve cache.** It halves the cost, but its invalidation rule is not proven (it holds only
  while every write goes through a wrapper or `applyRaw`).

Obligations the verdict hands to slice 4 (`settings-ownership`):

- measure the drag, the reorder, and nested component rendering in a production browser build
  before the reader slices start; a path past a frame budget gets a mutation function that queues
  once;
- carry the harness rules listed above (identity with the `BY_ID_FIELDS` allowlist and the
  duplicate refusal, assignment, same-task re-insertion, detached copies, the credential routing), and integrate the transport rules the reduced prototype leaves
  out;
- keep bulk writers (imports, plugin bulk writes) on mutation functions that queue once, not on
  per-field wrapper writes.

If the owner rejects the verdict, the fallback is explicit function bindings at every site, and
slices 4 and 5 gain those `src/lib` files (owner decision 1).
