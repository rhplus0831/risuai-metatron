# Slice: Spike, Preset And Persona Forwarding Layer (With Step 0 Fixtures)

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Remove the working copies" (the spike
sentence and its fallback) and the Safety Contract (the pre-phase snapshot); `PLAN.md` Decision 3
(the accessor paragraph and its spike). Step 0 runs before every other slice; the spike runs
first among the forwarding-layer work and slices 5 and 6 read its verdict.

Depends on: Phase 1 (the save adapter in `src/ts/storage/resourceSync.svelte.ts`, the test
harnesses `src/ts/storage/tests/storeBackedServer.ts` and `fakeResourceServer.ts`). Independent
of Phase 2 and of slice 2 (which waits for step 0).

## Scope

Allowed files: `src/ts/storage/tests/fixtures/phase3/` (new: `boot-snapshot.json`,
`default.risup`, `custom.risup`, and a `README.md` naming the commit and the commands they were
captured with), `src/ts/storage/tests/forwardingSpike.test.ts` (new; deleted or kept as the seed
of the review-step tests when slice 5 lands), `src/ts/storage/tests/forwardingHarness.svelte.ts`
(new; the prototype layer, test-only). No production file: `database.svelte.ts`,
`resourceSync.svelte.ts`, the settings pages, and the wrappers are not touched (Opus P11: no
dev-flagged prototype in production code; Astra P10: the harness carries its own stable ids and
switching). Tests that outlive the spike belong to the review step of slice 5.

Step 0, fixtures (Astra P10, Opus P11: the capture gates slice 2, whose defaults come from it):
on the tree before any Phase 3 change, in headless Chrome against a fresh server as the Phase 1
and 2 manual checks were run, capture `getDatabase({ snapshot: true })` after `loadData` on an
empty save (the "pre-phase boot snapshot": its root values are the effective defaults, including
what `checkNewFormat` changes after `setDatabase`, such as `loreBookToken` 8000); export the
default preset with `downloadPreset(0, "risupreset")` (`default.risup`); build a second preset
that sets `NAISettings`, `reasonEffort`, `regex`, nested `ooba` and `reverseProxyOobaArgs`, a
`promptTemplate`, `seperateParameters`, and a non-ASCII name, and export it (`custom.risup`,
Opus P6). Commit the three with their README before slice 2 starts.

Identifiers (verified against `577c43ae`): `DBState` (`src/ts/stores.svelte.ts`), the Svelte
5.57.1 proxy (`node_modules/svelte/src/internal/client/proxy.js`) and `snapshot`
(`node_modules/svelte/src/internal/shared/clone.js`); `getSettingValue`, `setSettingValue`
(`src/ts/setting/utils.ts`); the wrappers `src/lib/Setting/Wrappers/Setting{Check,Number,Text,Textarea,Select,Slider,Color}.svelte`
(a `localValue` `$state` plus a DB-to-local `$effect` and a guarded local-to-DB `$effect`;
`SettingSegmented.svelte` binds `DBState.db[item.bindKey]` directly); plugin `setPluginDatabase`,
`setPluginDatabaseLite`, host `getDatabase` (`src/ts/plugins/apiV3/v3.svelte.ts`, over
`allowedDbKeys` from `src/ts/plugins/plugins.svelte.ts`); `applyToMirror` (`resourceSync.svelte.ts`,
replaces a collection array on a conflict reload); `downloadPreset` (`database.svelte.ts`).

Stopping condition: a proof fails for a reason the accessor design cannot fix (not a bug in the
harness). Then the spike stops, records which proof failed and why, and slices 5 and 6 run in
their fallback form. A harness bug is fixed inside the spike.

## Assumptions

- The Svelte proxy behaves as read in the installed 5.57.1 source: `defineProperty` through the
  proxy throws `state_descriptors_fixed` for any descriptor without `value`; `get` creates no
  signal for a target property whose descriptor has no `writable` (an accessor) and falls through
  to `Reflect.get(target, prop, receiver)`, so the getter runs with the proxy as `this`; `set`
  creates no signal for an accessor and calls `descriptor.set.call(receiver, value)`;
  `getOwnPropertyDescriptor` and `ownKeys` report the target's enumerable accessors, so
  `for ... in`, `Object.keys`, `JSON.stringify`, and `$state.snapshot` (which iterates
  `Object.keys` and reads `value[key]`) see forwarded values; `deleteProperty` shadows the
  property with an `UNINITIALIZED` signal instead of deleting it from the target, after which
  reads return the signal (`undefined`) while a later write still invokes the setter (corrected
  after review: writes are not swallowed, reads are), so a `delete db[forwardedKey]` breaks reads
  of that key for good. After slice 4 no production path enumerates or deletes root keys
  generically, so the hazard is a rule for the layer, not a code path.
- `safeStructuredClone` (`src/ts/polyfill.ts`) falls back to `rfdc` when native `structuredClone`
  throws on a proxy (`DataCloneError`, confirmed by Astra's probe), and `rfdc` reads enumerable own
  properties, so forwarded values clone as plain values. Native `structuredClone` on the proxy
  throws; shared code must never receive a proxy (slice 5 snapshots at the client boundary).
- Svelte components mount under vitest (`src/lib/UI/GUI/guiRendering.test.ts`) and the real
  `resourceSync` module graph runs there (`resourceSync.test.ts`), so every proof below runs in
  vitest.

## Proposed decisions

- Layer shape (decided by the plan; the spike proves it): `installForwarding(raw)` defines, on the
  raw object before it is proxied, one enumerable and configurable accessor per forwarded key.
  The getter resolves the selected record from the selection id and the current collection on
  every access (no cached object: Astra P3) and returns `record[aliasOf(rootKey)]`; the setter
  captures the selected id synchronously, resolves the record, and writes into it through the
  proxy. `installForwarding` is idempotent: it skips a key whose own descriptor already has a
  getter, which is also how it recognizes a proxy over an installed object (defining through the
  proxy would throw).
- Proofs, each a vitest case over the harness with two presets `a` and `b` and two personas, a
  selection store, and a `switchTo(id)` that only changes the selection (no root copy; Astra
  P10). Results are recorded here:
  1. Binding: a component with `bind:value` on a forwarded top-level key and on a nested key
     (`promptSettings.postEndInnerFormat`) writes into the selected record and re-renders from it.
  2. Snapshot: `$state.snapshot(db)` and `JSON.stringify(db)` contain the forwarded values as plain
     properties; `Object.keys(db)` lists them.
  3. Plugin setters: the harness copy of `setPluginDatabaseLite({ temperature })` (per-key
     assignment on the proxy, then `DBState.db = db`) and of `setPluginDatabase` (the same plus a
     `checkNullish` pass reading through the getters) land in the selected record.
  4. Deferred wrapper write (Astra P2's probe): the current wrapper pattern (`localValue` plus two
     effects) with `localValue = 91; switchTo("b")` in one flush must be shown to lose or
     misroute the edit, and the replacement pattern (a function binding
     `bind:value={() => get(), (v) => set(v)}` that writes synchronously through
     `setSettingValue`) must be shown to land 91 in `a` and leave `b` unchanged. This decides the
     wrapper rewrite in slice 5.
  5. Collection replacement (Astra P3): replace `db.botPresets` with a new array holding records
     with the same ids (what `applyToMirror` does on a conflict), then write through the accessor:
     the write lands in the new array's record; remove the selected record: the getter falls back
     to the first record without throwing.
  6. Edit then switch then reload: edit `temperature`, `switchTo("b")` at once, serialize the
     collection, rebuild the mirror from it: the edit is in `a` and `b` is unchanged. Holds by
     construction (the setter writes synchronously); kept as the regression case for slice 5.
- Verdict rule: all six pass, so slices 5 and 6 run as written. A failure inherent to the design
  means the fallback: an explicit `SelectedPreset` and `SelectedPersona` projection (a `$state`
  object rebuilt on selection change, written back by id synchronously from its setters, not from
  effects) and the call sites moved to it (slice 5 lists them). The fallback also states how the
  plugin setters stay effective: `setPluginDatabase` maps the forwarded keys of `allowedDbKeys` to
  the projection before assigning the rest (Astra P10).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`. The six proofs above in vitest, plus the accessor
behavior of the installed proxy (get, set, snapshot, ownKeys, deleteProperty). The fixtures'
README records the commit hash and the capture commands. Results and the verdict are recorded in
this file.

## Residual risk

The harness forwards a handful of keys; slice 5 forwards the full list and may find a field
whose nested shape behaves differently (a preset field that is `null` in some presets, such as
`promptTemplate` or `reverseProxyOobaArgs`). The persona fields are proven with the same
mechanism over `personas` in proof 1. The fixtures are captured by hand in headless Chrome; a
mistake there is found by slice 7's comparison, not earlier.

## Results

Run on 2026-09-30 by the Fable test-adapter on `4914ccc7` (with the orchestrator's uncommitted
step 0 work in `util/playwright/`, `playwright.config.ts`, `vitest.config.ts`, and
`src/ts/storage/tests/fixtures/` alongside), Svelte 5.57.1, vitest 4.1.11, happy-dom. Step 0 was
not part of this run.

Files (all test-only, under `src/ts/storage/tests/`): `forwardingHarness.svelte.ts` (the
prototype layer, four preset keys including the renamed `reasoningEffort` <-> `reasonEffort` and
three persona keys with `username` <-> `name` and `userIcon` <-> `icon`; presets `a` and `b`,
personas `p1` and `p2`; `switchTo` / `switchPersona` change only the selection id; harness copies
of both plugin setters; a `createProbe` that observes a read from an `$effect` and a `$derived`),
`forwardingSpike.test.ts` (18 cases), and the function-binding components `SpikeNumberSync.svelte`,
`SpikeTextSync.svelte`, `SpikeSelectSync.svelte`. The layer is installed on the real `DBState.db`,
so the real `getSettingValue` / `setSettingValue` and the real `SettingNumber.svelte` run against
it unchanged.

**Verdict: all six proofs pass. Slices 5 and 6 run as written.** No failure was inherent to the
design; the two red runs on the way were test mistakes (a wrong descriptor assertion, and
happy-dom's `:checked`, below).

Proof results:

1. Binding: pass. `bind:value` through `SpikeNumberSync` on `temperature` writes 91 into `a`
   only, and a switch to `b` re-renders the input as 50; a `bindPath`
   `promptSettings.postEndInnerFormat` edit lands in `a.promptSettings`, and on `b` (where
   `promptSettings` is `null`) `setSettingValue`'s `??= {}` puts the container into record `b`
   through the setter and then the leaf; the persona field `username` writes `personas[p1].name`
   and follows `switchPersona`; `reasoningEffort` reads and writes `reasonEffort` and the record
   never gains a `reasoningEffort` key.
2. Snapshot: pass. `$state.snapshot(db)`, `JSON.stringify(db)`, `Object.keys(db)`, `for ... in`,
   and `rfdc` all carry the seven forwarded keys as plain values (value descriptors in the
   snapshot), next to the collections; after a switch the same calls show the other record.
   Native `structuredClone(db)` throws on the proxy, as assumed.
3. Plugin setters: pass. The `setPluginDatabaseLite` copy lands `temperature` in the selected
   record and leaves `DBState.db` the same proxy with its accessors; the `setPluginDatabase` copy
   with a `checkNullish` pass reads every forwarded key through the getter and writes defaults
   through the setter into the selected record only, including a `null` `promptSettings` and a
   key the plugin set to `null`.
4. Deferred wrapper write: pass, and the wrapper rewrite is decided. With the real
   `SettingNumber.svelte`, `input 91` then `switchTo("b")` in one flush **loses** the edit under
   5.57.1: the DB-to-local effect runs first and overwrites `localValue` with `b`'s value, so the
   guarded write-back finds nothing to write (`a` stays 80, `b` stays 50, `onChange` never
   fires). With the function binding `bind:value={() => get(), (v) => set(v)}` over the unchanged
   `NumberInput`, the same sequence lands 91 in `a`, leaves `b` at 50, re-renders the input as 50,
   and `onChange` fires exactly once (with 91); further flushes and switches do not call it; a
   second edit calls it a second time. The select variant keeps the hidden-option fallback (A16):
   a user `change` fires `onChange` once and writes the record, a persona switch re-renders
   without calling it, and a mount whose value is not among the visible options writes the last
   visible option once through the setter.
5. Collection replacement and removal (A15): pass. After `db.botPresets = <new array, same ids>`
   the getter reads the new record, an `$effect` over the accessor re-runs, and a write lands in
   the new record while the old object is untouched. After the selected record is removed (by
   array replacement or by `splice`), the first read, even from inside a `$derived`, returns the
   first record without throwing and persists `botPresetId = "b"`; a write made between the
   removal and that first read is dropped (not redirected), the write after it lands; an empty
   collection reads `undefined` and drops writes.
6. Edit, switch, serialize, rebuild: pass. Edit 91 through the binding, `switchTo("b")`,
   `JSON.stringify($state.snapshot(db.botPresets))`, rebuild the mirror with `installForwarding`
   on the parsed collection: `a` is 91, `b` is 50, the selection is `b`, and the new proxy's
   accessors work.

Proxy behavior (the assumptions, checked against the installed 5.57.1):

- `get`, `set`: hold as written. The getter runs with the proxy as `this`, reads through it are
  tracked by selection, collection, and record, and neither a read nor a write creates a value
  source for the accessor (the descriptor stays an accessor through the proxy).
- `defineProperty`: holds. An accessor descriptor through the proxy throws
  `state_descriptors_fixed`; `installForwarding` is idempotent on the raw object and on the proxy
  (the descriptor check sees the target's getters).
- `deleteProperty`, refined: after `delete db.temperature`, reads return `undefined`, `in` is
  false, and `Object.keys` omits the key, while `db.temperature = 66` still reaches the record.
  But that write fills the shadow source, so from then on reads return 66 whatever the selection,
  the proxy reports a value descriptor, and the key is enumerated again. The rule stands, stronger
  than stated: never delete a forwarded key through the proxy; it is not recoverable by writing.

Findings for slice 5 to adopt:

- The A15 fallback persist must run under `untrack`. Svelte's `set` guard
  (`reactivity/sources.js`, `state_unsafe_mutation`) rejects a tracked write from a `$derived` or
  a block effect, and the first read after a removal can come from either. A test in the spike
  shows the throw for a tracked write from a `$derived`. `$effect` and template expressions are
  not guarded, so the hazard only shows in some render paths.
- The setter's drop rule is silent. Because the setter captures the id at call time, "captured
  earlier" and "the selection is missing" are the same case in the layer: any write between a
  removal of the selected record and the next read is lost. Every production path renders (reads)
  before it writes, and a plugin that removes the selected preset and sets a value in the same
  tick is the only known loser. Slice 5 should keep the rule and say so in the layer's comment,
  or reconcile in the setter too; the spike does not decide this.
- `setPluginDatabase` normalizes into the selected record: with forwarded keys, the
  `checkNullish` defaults that `setDatabase` applies to root fields land in the selected preset
  and persona (a `null` `promptSettings` on the selected preset becomes the default object). This
  is what the current root copy already did to the effective values; it is now visible in the
  record. Slice 5's residual-risk note about `null` nested fields is confirmed for this path.
- The deferred pattern fails by losing, not misrouting, on 5.57.1 (effect order). A different
  effect order would misroute instead; either way the rewrite is required.
- `setSettingValue`'s `obj[part] ??= {}` returns the raw right-hand object, not the proxied one
  that the setter stored in the record. It works because nothing has read the new container yet
  (the proxy creates the leaf source lazily from the target). Pre-existing, identical on the
  non-forwarded root today; not a layer issue.
- Function bindings on component `$bindable` props (`NumberInput`, `TextInput`, `SelectInput`)
  work unchanged; the GUI primitives need no edit.
- Testing note: happy-dom never matches `<option>` with `:checked`, and Svelte's select `change`
  handler resolves the chosen option with that query (falling back to the first enabled option).
  `chooseOption` in the spike answers `:checked` from `selectedIndex` during the dispatch. The
  review-step tests of slice 5 need the same shim for any `<select>` edit.
- Mounting the real wrapper under vitest needs the `alertMd` mock (`Help.svelte`) on top of the
  `resourceSync.test.ts` mock set; `src/lang` loads unmocked.

Commands and output:

```
pnpm vitest run src/ts/storage/tests/forwardingSpike.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)
pnpm test
 Test Files  61 passed (61)
      Tests  613 passed | 3 skipped (616)
pnpm check
 svelte-check: 5073 FILES 0 ERRORS 0 WARNINGS; tsc -p server/tsconfig.json: clean
pnpm exec prettier --write src/ts/storage/tests/{forwardingHarness.svelte.ts,forwardingSpike.test.ts,SpikeNumberSync.svelte,SpikeTextSync.svelte,SpikeSelectSync.svelte}
```
