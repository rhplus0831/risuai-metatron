# Review decisions: Phase 4 slices

Reviews of the drafted slices by GPT-6-Astra (11 points) and Claude Opus (13 points) on
2026-09-30. Every point was checked against `577c43ae` before deciding: direct reads of the cited
lines and one Luna fan-out (the residual grep hits per contract file, the host functions that
write through callees outside the plugin folder, the `src/lib` collection writers). The refined
slices are the eight in this folder.

## Astra

- Astra P1, a resolved flush does not guarantee persistence: adopt — verified (`acked` counts
  a key discarded by a conflict as settled, `resourceSync.svelte.ts:129-132`; `flushResources`
  takes its discard watermark after its own `tick()`, 1088-1102, so a discard before the call
  is not reported). Slice 1 adds a mutation scope: `beginMutationScope()` records the discard
  sequences before a callback runs and `flushResources({ scope })` returns every key discarded
  since the scope began; the callback contract for Phase 5 becomes "persisted without discard,
  else the callback fails with the discarded keys" (a `job-channel` boundary and a proposed
  Phase 5 edit). The alternative (accept conflict-discard as success) is rejected because Phase
  5 answers the job from that flush.
- Astra P2, the ambient context stack cannot identify asynchronous callers: adopt with
  changes — verified (each plugin has its own `SandboxHost` and API object, `v3.svelte.ts:1799`;
  callback wrappers and pending callbacks are per host, `factory.ts:435-546`; no correlation
  between a hook invocation and a child host call). The global stack is replaced by a context
  keyed by the plugin that owns the hook: the API registers each hook through a per-plugin
  wrapper that takes the runner's handoff synchronously at invocation and pushes onto that
  plugin's own stack, popped by identity when the hook settles; the host functions of that
  plugin read only that stack. Changed from Astra's recommendation: no private RPC metadata or
  propagation protocol across awaits is designed; same-plugin overlap (one plugin with two hooks
  in flight for different chats) stays ambiguous and is recorded as residual risk. Out-of-order
  completion, unrelated-plugin calls, and late calls after a timeout are review-step tests.
- Astra P3, the context contract is incomplete for Phase 5 and Phase 3's fallback: adopt with
  changes — verified (`parseRisuChat` calls the parser and `processScriptFull` without
  `chatRef`, 1240-1252; `getCurrentLorebookEntries` calls `getModuleLorebooks()` without one,
  1291; `sendChat` calls `processSendChat(-1, {})`, 1698; `runLLMModel` passes no ref,
  1646-1668; under Phase 3's fallback the forwarded keys leave `DBState.db`, so the plugin
  `getDatabase` snapshot would read `undefined`). The context carries `{ chatRef, presetId,
personaId }` captured before the first await; the seven host functions and `runLLMModel` pass
  the captured ref into the parser, `processScriptFull`, `getModuleLorebooks`,
  `processSendChat({ target })`, and `requestChatDataMain({ chatRef })`; `updateSettings(patch,
{ presetId })` writes a forwarded key into that preset record by id, so a settings write
  inside a callback never follows the tab's selection; a missing captured target throws a
  defined `PluginTargetGoneError` and never redirects; the plugin `getDatabase` reads forwarded
  keys through `readSetting(key)`, which the Phase 3 fallback maps to the projection. Changed:
  the mode and raw input of Decision 5's context are not carried (Phase 5's job holds them; a
  client hook has no job).
- Astra P4, watcher removal precedes caller conversion: adopt — verified
  (`browserLocalImport.ts:146-149` writes through the helper with no mark; the v3 storage
  functions and `SafeLocalPluginStorage.clear` write directly). Slice 1 keeps the watcher and
  only adds `pluginStorageStore` and `markPluginStorageDirty`; the plugin host slice routes
  every storage writer, delegates the browser-import helper, and deletes the watcher as its
  last step, with `resourceSync.svelte.ts` and `pluginSafeClass.ts` in its allowed files; the
  "sent without the watcher" test moves there.
- Astra P5, character-list mutations cannot reproduce list ordering: adopt with changes —
  verified (`applyPluginCharacters` builds `next` in the incoming order and assigns it,
  750-792; mirror order is not persisted, `assembleDatabase` loads in creation order). Changed:
  Opus's cheaper option is taken instead of a reconciliation mutation: the routing applies
  matched, new, and omitted ids by id, new characters are appended, and
  "`setDatabase({ characters })` no longer reorders the mirror" is a recorded behavior change;
  `selectedPersona` is applied after `personas`; `hostApi.test.ts:130` and `:236-249` are named
  as tests that change. Reason: the order is transient (lost on reload) and a reorder operation
  would preserve something the server discards.
- Astra P6, removing normalisation lacks the promised replacement validation: adopt — verified
  (`cycle` records the submitted text as persisted; batch results carry revisions only). Every
  mutation function validates each value before the mirror changes (JSON-serializable, finite
  numbers, the JS type of the current mirror value for a settings key, a string `id` for a
  collection element) and a refusal throws and leaves the mutation unchanged; no normalized
  values are returned or hydrated (the alternative is transport work outside the allowed files).
  Malformed values through the real adapter are a review-step test.
- Astra P7, Lua's proposed "run character" is the group in group sends: adopt — verified
  (`sendChat` for a group keeps the group's `chatTarget` and passes `speakerChaId`,
  `index.svelte.ts:439-443`; `currentChar` becomes the member at 458-459; `engineCharacter()`
  resolves from `contextRef.chaId`, the group). The Lua run captures `arg.char.chaId` into the
  per-run engine state on every run; the four character setters and getters resolve through it;
  chat operations keep the group ref; a `simple` character argument without a `chaId` makes the
  setters fail with a defined result. A member's Lua setter and the trigger equivalent during a
  group send are review-step tests.
- Astra P8, indirect plugin writers escape the proposed boundary: adopt — verified
  (`changeColorScheme` host export at 1078 writes `colorScheme` and `colorSchemeName` in
  `colorscheme.ts:226-234`; `checkCharOrder` host export at 1560 writes `characterOrder` in
  `globalApi.svelte.ts:580-638`). `changeColorScheme` and `updateCustomColorScheme` in
  `colorscheme.ts` call `updateSettings` (the shared helper calls the module; `colorscheme.ts`
  is in the plugin slice's allowed files); `checkCharOrder` moves into the storage layer as the
  `characterOrder` mutation (Opus P7) and the host export is unchanged; the plugin slice audits
  every exported host function through its callees (the Luna fan-out: only `runLLMModel` and
  `sendChat` reach further writes, in the request layer and the send pipeline, which are Phase
  5's).
- Astra P9, the exit greps are neither achievable nor sufficient: adopt — verified (the bare
  `.push/.splice` alternative matches local arrays; the zero-`getDatabase()` gates conflict with
  reads the Lua and trigger slices keep; `applyModule` is retained in `modules.ts`;
  `db.field = value` aliases are missed). Every slice uses the rooted pattern, lists its
  expected residual hits by identifier, the closeout restricts its grep to the named import
  functions, aliases are caught at the type level (`findCharacter` and `getCharacter` return
  `DeepReadonly`; the two `@ts-ignore` lines go), and grep is discovery plus targeted tests, not
  proof. The README no longer claims disjoint files (the guide edits move to the closeout, Opus
  P12).
- Astra P10, MCP's snapshot substitute and post-consent rules need tightening: adopt with
  changes — verified (`DeepReadonly` is a type, `shared/readonly.ts`; `@ts-ignore` at
  `characters.ts:592-593` and `modules.ts:463`; `setModuleLorebook` captures the module before
  awaiting consent, 546-551). Changed: the read-only view is kept for both handlers (a snapshot
  copies every chat per tool call); both suppressions are deleted and every consumer audited;
  for characters and modules alike the handler re-resolves by the captured id after consent,
  rechecks existence and type, copies the current list, and patches it. Replacement or removal
  while the prompt is open is a review-step test.
- Astra P11, one save cycle does not guarantee one transaction: adopt — verified (`planBatches`
  splits by bytes and operation count and `isolateBatches` sends units separately, 563-635).
  The residual risk documents per-request atomicity and partial failure accurately; no
  indivisible grouping is added (the alpha scope).
- Astra drift check: adopt — drift 7, the Lua Assumption, and the residual risk say "writes the
  selected character instead of the run's character"; the trigger validation asserts that the
  selected character is unchanged when it differs from the trigger's; the misattributed
  indexed-getter naming and the `checkNullish` sentence are removed; the backup line reads
  "since Phase 3 (the supported schema version)"; the CBS transfer is listed as a phase-file
  scope amendment the closeout must see applied; `PRESET_KEEP_ON_SWITCH_FIELDS` is cited in
  `shared/presets.ts`; `v2GetPersonaDesc` is described as rewritten by Phase 3; the effective
  persona is an explicit Phase 5 handoff (Phase 4 keeps the selected persona; Phase 5 uses the
  frozen effective persona under Decision 5).

## Opus

- Opus P1, the `pluginStorage` watcher is deleted one slice before its writers are routed:
  adopt — same fix as Astra P4; the watcher is deleted in the plugin host slice as its last
  step, not in the closeout, so the switch is proven before the later slices land.
- Opus P2, the per-slice exit greps cannot pass as written and miss the dominant write
  pattern: adopt — same fix as Astra P9, with the residual hits taken from the Luna fan-out
  (`scriptings.ts` `getDatabase()` at 130-131, 505, 870, 966, 1129, 1168 and the setters;
  `triggers.ts` at 161 and 1097, plus the cast form at 1092 and 1132 that the pattern misses;
  `plugins.svelte.ts:381`; the local arrays in `factory.ts` and `v3.svelte.ts` fall outside the
  rooted pattern), the closeout grep restricted to the named import functions, and
  `persona.ts` scanned only at `importUserPersona`.
- Opus P3, the captured plugin context as one global stack misattributes calls when hooks
  overlap: adopt — same design as Astra P2: the context is keyed by the plugin that owns the
  hook, popped by identity, `sendChat` passes `target: ref` to `processSendChat`, `factory.ts`
  is in the allowed files, and the context work is its own slice (`plugin-call-context`, after
  the plugin host slice).
- Opus P4, the plugin `characters` routing silently drops list-order semantics: adopt — the
  behavior change is recorded, `selectedPersona` is applied after `personas`, and
  `hostApi.test.ts:130` and `:236-249` are named as tests that change (verified: 130 asserts the
  normalizer call, 236-249 asserts the order).
- Opus P5, slice 6 is too large and waits on slices it does not need: adopt — slice 6 is split
  into `imports-through-the-module` (needs slice 1, parallel with the others) and `closeout`
  (needs all); the Docker smoke is dropped (no server, image, or route change);
  `createNewCharacter`, `createNewGroup`, and the `CharConfig.svelte` regex handler are dropped
  from the import slice and listed in the Phase 6 allowlist; `importChat`'s folder write stays
  (an import function in `src/ts`).
- Opus P6, the optional character drift check would fire on legitimate core-app writes:
  adopt — verified (`characters.ts:165, 182, 192, 885, 911, 945`, `bootstrap.ts:169`,
  `index.svelte.ts:370` mark themselves). The drift token is bumped inside `markCharactersDirty`
  and `markCharacterDirtyAt`, so only an unmarked non-selected write is reported.
- Opus P7, slice 1 makes the storage layer import `globalApi.svelte.ts`: adopt — verified
  (`globalApi.svelte.ts:1-40` imports plugins, `characterCards`, the parser, `streamsaver`, and
  `resourceSync`). `checkCharOrder` moves to `src/ts/storage/characterOrder.ts`;
  `globalApi.svelte.ts` re-exports it; the plugin-visible export is unchanged.
- Opus P8, drift 7 and the Lua assumption call a wrong-target write a "lost write": adopt —
  same wording fix as Astra's drift check; the design and tests of the Lua slice stay.
- Opus P9, `DeepReadonly` on MCP `getCharacter` is not the safety net the slice claims:
  adopt — same as Astra P10: `DeepReadonly` kept, both `@ts-ignore` lines deleted, and the slice
  says so.
- Opus P10, `setDatabase({ plugins })` uninstalls every existing plugin: adopt — verified
  (`handlePluginInstallViaPlugin` returns only the newly confirmed plugins,
  `plugins.svelte.ts:415-437`; `setPluginDatabase` assigns that list, 890-899). The routing
  calls `upsertPlugin` per confirmed plugin; the confirmation is kept; recorded as a
  pre-existing defect fixed.
- Opus P11, group sends change which record a trigger writes: adopt — verified (same evidence
  as Astra P7). The group case is recorded as a behavior change with a group fixture in the
  review tests; the Assumption says "the speaking member in a group"; the Lua slice resolves the
  executing member too (Astra P7), so the two runtimes agree and Phase 5 inherits one rule.
- Opus P12, guide edits collide between the "disjoint" parallel slices: adopt — every guide
  edit moves to the closeout; the other slices touch no `docs/structure/` file; the README
  sentence now says the source files are disjoint and the docs are edited once.
- Opus P13, five of the nine open questions are already settled: adopt — the `DatabaseSubset`
  gap, the trigger target, the whole-database normalizer, `sglobal`, `setDatabaseLite({ plugins })`,
  and the exit-criterion wording are folded into the slices as settled by the phase file,
  Decision 5, Invariant 5, the safety contract, and the Objective; the `pluginStorage` switch,
  `getCharacter` as a read-only view, and the narrowed context question (client runners now, or
  only Phase 5's callbacks) stay open. `updatePersona` for `v2SetPersonaDesc` is kept, labeled
  as the simpler Phase 5 port rather than a correctness need.
- Opus drift check and missed items: adopt — the misattributed indexed-getter naming and the
  `checkNullish` sentence removed; the trigger slice's line reference corrected to 161-162
  (verified); `checkCharOrder` is listed as a plugin path (covered by P7);
  `PlaygroundMenu.svelte:44` and `ModuleSettings.svelte:88, 203, 240` are verified and the Phase 6
  allowlist now includes `src/lib` (the list from the Luna fan-out); `hostApi.test.ts:130` named.

## Counts

Astra (11 points): adopt 7 (P1, P4, P6, P7, P8, P9, P11), adopt with changes 4 (P2, P3, P5,
P10), reject 0; the drift-check section is adopted as written (not a numbered point). The
rejected parts are named inside P2 (no RPC attribution protocol), P3 (mode and raw input not
carried), P5 (no reconciliation mutation), P6 (no hydration of normalized values), P10 (no
snapshot), and P11 (no indivisible grouping).

Opus (13 points): adopt 13 (P1 to P13), adopt with changes 0, reject 0; the drift check and the
missed items are adopted as written.
