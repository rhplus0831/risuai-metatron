# Planning notes: Phase 6 (Thin Client And Closeout)

## Provenance

Drafted 2026-09-30 on `metatron` at `577c43ae`, before Phases 3 to 5 started, against their
planned slices (Phase 4's became available for the refinement, so every Phase 4 assumption is
verified against its slices). Reviewed by GPT-6-Astra (11 points) and Claude Opus (15 points),
then refined; the decision on every point is in [`review-decisions.md`](review-decisions.md).
This phase is the one Phases 3 to 5 change the tree under most, so it is expected to be
re-planned at phase start: every slice's Assumptions section is the diff base for that
re-verification, and a false assumption re-plans that slice. Nothing outside this folder was
changed by the drafting.

## Opening baseline re-measured (2026-09-30, `577c43ae`)

One metric throughout: matching lines (`rg -c` / `rg -n`), tests excluded with
`-g '!*.test.ts' -g '!**/tests/**'`; occurrences (`rg -o`) are given once for comparison.

| Coupling (PLAN.md row)                                                                                 | Baseline at `1f262b61`           | Today, matching lines (files)                       | Today, occurrences   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------- | -------------------- |
| References to `DBState.db` (`rg -c 'DBState\.db' src shared`)                                          | 2,355 across 120 files           | 1,917 (118)                                         | 2,161                |
| Two-way `bind:` onto `DBState.db` in `src/lib` (`rg -n 'bind:[A-Za-z]+=\{?DBState\.db'`)               | 396 across 26 files              | 394 (25)                                            | 394                  |
| Direct assignments into `DBState.db` (the regex in the spike slice, `rg -P`)                           | 208 in `src/lib`, 75 in `src/ts` | 249 in `src/lib` (31), 53 in `src/ts` (16)          | not measured         |
| Callers of `getDatabase(` (`rg -c 'getDatabase\(' src shared`; includes the definition and re-exports) | 232 across 56 files              | 224 (55); 3 with `snapshot: true`                   | 224                  |
| `selectedCharID` (not a baseline row)                                                                  |                                  | 565 (49); indexed sites `characters[$selectedCharID | selIdState` 417 (21) | 617 / 471 |
| `.chatPage` (not a baseline row)                                                                       |                                  | 110 (35)                                            | 113                  |

The assignment regex is now recorded in the spike slice, so that row is reproducible; the
baseline's own method for it is unknown, so the two are not comparable. The top consumers by
matching lines: `CharConfig.svelte` 265, `OtherBotSettings.svelte` 261, `BotSettings.svelte`
225, `DefaultChatScreen.svelte` 90, `process/index.svelte.ts` 87 (Phase 5 moves its body),
`OobaSettings.svelte` 56, `Chat.svelte` 50, `PromptSettings.svelte` 50, `WelcomeRisu.svelte` 49;
`src/lib/Setting` plus `src/ts/setting` total 841 lines in 35 files. Binding families: character
80, preset 147, persona 4, plugin 4, other settings 159, plus 5 getter/setter chat bindings.

## Drift between the phase file and the tree

Every identifier in the phase file was re-verified. Mismatches, with evidence and a proposed
edit (the phase file is not edited):

1. **`setCurrentChat` does not exist.** `rg -n 'setCurrentChat' src shared` finds only test mock
   properties and `setCurrentChatMeta` (`chatEdits.ts:55`). Phase 2 removed the chat setter. The
   accessors that exist: `getDatabase` (753), `setDatabase` (38), `setDatabaseLite` (745),
   `getCurrentCharacter` (760), `setCurrentCharacter` (774), `getCharacterByIndex` (787),
   `setCharacterByIndex` (797), `getCurrentChat` (822), all in `database.svelte.ts`; after Phase
   4 `setCurrentCharacter` and `setCharacterByIndex` are wrappers over `characterStore`. Edit:
   replace `setCurrentChat` with the wrappers.
2. **The counts** (section 2): 25 files with two-way bindings today, not 26; 1,917 matching
   lines. Edit: "re-measured at phase start with matching lines".
3. **Paging is a render window, not a fetch.** `chatLoadInitialPages` and `chatLoadAdditionalPages`
   are `Database` fields (`shared/database.ts:484-485`) read by `DefaultChatScreen.svelte:83-99`
   into a local `loadPages`; `Chats.svelte:77-182` renders over the fully loaded array. Edit: "the
   render window stays; lazy loading adds the fetch of the selected chat before it".
4. **The readers of non-selected chats are misnamed or narrower.** Dataset export walks every
   character's chats (`exportAsDataset.ts:6-24`); `exportChat`/`exportAllChats`
   (`characters.ts:226-426, 574-596`) read the selected character only; the plugin getters are
   `getChar`/`getCharacter`, `getCharacterFromIndex`, `getChatFromIndex` (with `getDatabase`'s
   default `"all"` including `characters` with chats); the MCP tool is `risu-get-chat-history`;
   unlisted readers: `getChatBranches` (`branches.ts:68-91`), the `AlertComp` branch hover,
   `MobileCharacters.svelte:62` (`chats.length`). Also the plugin _writers_ under lazy loading
   (`setChar`, `setCharacterToIndex`, `setDatabase({ characters })` through
   `reconcileCharacterChats`, `chatStore.svelte.ts:1287-1330`, which looks chats up in the
   mirror). Edit: name them.
5. **`NodeStorage` is already assets-only plus auth** (Phase 1): `authFetch` (235) and
   `getNodeServerProxyAuth` (230) are used by `resourceClient.ts:91, 224`, `inlays.ts:485`, and
   `globalApi.svelte.ts:506, 873, 1135`. Edit: "split the auth helpers from the asset client;
   delete `AutoStorage`".
6. **No after-commit hook exists in the store, and sockets are outside maintenance.** Commits:
   `applyChanges` (485-589), `put` (413-445), `delete` (451-466), `replaceAll` (757-780);
   `transaction` (600-637) has no production caller. The upgrade is `proxyStreamJobs.attachWebSocket`
   (437-476, `isAuthorizedProxyToken` also accepts the raw password); `main.ts:46` attaches it;
   `snapshots.track` admits HTTP handlers only. Edit: "the feed is emitted by the store after
   commit and rides the Phase 5 dispatcher with JWT auth".
7. **The selection is an index store the phase file does not mention.** `selectedCharID`
   (`stores.svelte.ts:26`) and `selIdState` (59-61); writers in `characters.ts`, `hotkey.ts`,
   `Sidebar.svelte`, `PlaygroundMenu.svelte`, `bootstrap.ts`, `resourceSync.svelte.ts:1059-1061`.
   Edit: add "the selected character becomes a per-client `chaId`; `selectedCharID` is a derived
   index shim, not an exit gate; U4 is updated".
8. **"Remove `setDatabase`" needs the remaining client normalization moved first, and its
   sources are `checkNewFormat` and `characterFormatUpdate`, not `setDatabase`** (Astra's drift
   note): after Phase 3 `setDatabase` keeps mainly the collection guards; the character
   defaults and transformations live in `bootstrap.ts:checkNewFormat` (with the trash pruning at
   403-410) and `characters.ts:characterFormatUpdate` (611-716: creates a chat for a chatless
   character, moves `postHistoryInstructions` into a chat note, stamps `lastInteraction`, fills
   `fmIndex`, and applies pure defaults). Edit: "the pure defaults move to creation
   (`addCharacter`, `addModule`) with server normalizers as a backstop and Phase 3's startup
   pass; the non-pure steps become import handling and explicit mutations".
9. **The plugin `getDatabase` is a subset, not a whole `Database`** (23 `allowedDbKeys`,
   `v3.svelte.ts:1059-1073`; `DatabaseSubset` lacks `selectedPersona` and `characterOrder`,
   pre-existing). The whole-shape consumers are the settings report, `exportAsDataset`,
   `backuplocal.ts`, `getEmotion(db)`, `formatChars(db)`, `templateCheck(db)` (reads
   `promptTemplate` only), `matcherArg.db` in `cbs.ts`, `risuChatParser(db?)`. Edit: "keep
   snapshot and selector helpers" becomes "snapshot builders for the plugin subset, the settings
   report, and the backup inventory".
10. **The docs list is short.** Ten more guides name identifiers this phase removes (the table
    in the closeout slice). Edit: "and every guide that names a removed identifier".
11. **The archive convention exists and differs from "archive this plan".** `docs/plan/` has no
    archive folder; the `risuai-fastify` precedent (its commits "docs: archive completed UI UX
    improvement plan", "docs: archive unified workspace plan") removes the finished plan from the
    tree and keeps `docs/plan/README.md` at "None". Edit: "remove the plan from the tree; add
    `docs/plan/README.md`; the recorded behavior changes live in `persistence.md`'s Known
    Hazards".
12. **Three Phase 5 leftovers are missing from Required Work**: the `proxyStreamJobs` server
    kind, the `hypaVector` and `tfCache` caches (still used by `PlaygroundEmbedding.svelte`,
    `registerOnnxModel`, `runVITS`), and the transform's per-request Lua cost. Edit: add them.
13. **"The remaining `$effect` watchers" are more than the save loop's**, and one of them
    writes: `stores.svelte.ts:168-177` sets `characters[...].supaMemory = true` on selection;
    `stores.svelte.ts:178-188` (`moduleUpdate`), `globalApi.svelte.ts:1567-1599` (chat fold),
    `App.svelte:50`, and eleven components derive from `DBState.db`. Edit: "the save loop's
    watchers are deleted; the UI effects read records; the `supaMemory` write becomes a
    mutation".
14. **Chat bindings are getter/setter pairs.** Five sites are not in the 394 (recorded for the
    measurement).
15. **Phase 5's job-socket `resource` events are not replaced by live updates.** They carry the
    callback barrier and the Lua setter and button-command results to the owner; the feed is a
    second push path deduplicated by the newer-revision rule. Edit: none to the phase file; a
    proposed Phase 5 edit below.
16. **`reconcileCharacterChats` depends on the mirror** (`chatStore.svelte.ts:1287-1330`): under
    lazy loading a plugin's change to an unloaded chat would become a conflicting create and a
    removal of an unloaded chat would be missed. Edit: covered by drift 4's plugin writers.
17. **The settings registry has item-level functions** (`getValue`/`setValue`, 8 pairs in
    `displaySettingsData.svelte.ts:417-454`, called with `DBState.db` at `utils.ts:31, 50`)
    besides `bindKey`; they need the same retargeting. Recorded for the reader slice.

No conflict with the STRUCTURE.md or PLAN.md invariants was found in the phase file itself.
Two places where a naive reading would violate an invariant are handled in the slices: a deep
`$state` projection with an `$effect` diff would recreate the adapter invariant 2 deletes (the
spike decides a write-through pattern instead, and the owner verdict line records that it is
accepted as the explicit mutation boundary), and a reactive object holding every section would
recreate the aggregate the Safety Contract forbids (the records are a namespace of per-kind
records, and the snapshot builders are non-reactive).

## Contingent boundaries

- **Phase 4 (verified against its slices; slices 3, 4, 7, 8, 9).** The modules exist under
  `characterStore.svelte.ts`, `collectionStore.svelte.ts`, `pluginStorageStore.svelte.ts`;
  `pluginStorage` has no watcher; `setCurrentCharacter`/`setCharacterByIndex` are wrappers;
  `v3.svelte.ts:903`, `plugins.svelte.ts:370`, and the eight `triggers.ts` `setCurrentCharacter`
  calls are gone; the core-app writers are the allowlist in Phase 4's closeout (both `src/ts`
  and `src/lib`), each entry owned by slice 5, 6, or 7; `pluginContext.ts` names the hook's
  character, which slice 8's plugin getters and setters load; the v3 bridge is asynchronous. If
  Phase 4 lands with different function names the slices retarget, not redesign.
- **Phase 3 (slices 2, 3, 4).** The spike verdict: under the fallback, `SelectedPreset`/`SelectedPersona`
  are the records slice 3 wraps. The `{ items, selectedId }` shape (slice 3 unpacks it).
  `applyToMirror` calling `reconcileSelection()` after a collection replacement (slice 2's
  live-apply relies on it). `characterOrder` as `settings.characterOrder` (slice 4). Whole-record
  writes for sections stay the wire contract.
- **Phase 5 (slices 2, 8, 9, 10).** The one upgrade dispatcher (slice 2 adds a prefix);
  `applyHydration` adopting the newer-revision rule (proposed edit below); the job socket's
  `resource` events kept; `llmSecrets` masked with sibling fields writable (slice 3's
  `updateLlmSecretSiblings` needs the server to treat an omitted masked path as "keep",
  proposed edit below); the client processing remainder (slice 6's reader list is re-derived at
  phase start); `proxyStreamJobs` kept or deleted at cutover (slice 10); the transform cache
  keyed by the `presets` revision.
- **Own-phase contingencies.** If the spike's candidate 2 fails only the cost proof, the
  section records use candidate 1 and the character record candidate 2. If neither passes a
  correctness proof, every `bind:` site becomes an explicit function binding calling the Phase 4
  functions (the allowed files do not change). If `selectedCharID`'s references do not reach
  zero by slice 9, the shim stays as a derived store (recorded, not a gate).

## Proposed edits to other phases

The Phase 3, 4, and 5 drafters have been asked to apply these to their slices.

- **Phase 5 `generation-jobs.md`** (`applyHydration`): "replaces the whole record and its saved
  text like a conflict reload does" becomes "applies the record only when its token's `seq`
  differs or its revision is higher than the held one, and never records a discard", because the
  Phase 6 feed pushes the same records and two reads can resolve out of order.
- **Phase 5 `request-layer-and-llm-secrets.md`** (the masked projection): add "a write of the
  `llmSecrets` kind that omits a masked path keeps the stored value for that path", the path
  Phase 6's `updateLlmSecretSiblings(patch)` uses for the readable sibling fields.
- **Phase 5 `cutover-and-docs.md`**: "Phase 6 will add live updates" gains "the job socket's
  `resource` events stay; the feed deduplicates by revision".
- **Phase 4 `closeout.md`**: the allowlist gains its Phase 6 owners (slices 5, 6, 7 by file), a
  note that `ModuleSettings.svelte:87-90` belongs to the character reader slice, and that the
  registry's item-level `getValue`/`setValue` functions are part of the settings-page migration.
- **Phase 3 `forwarding-presets-and-selection.md`** and `forwarding-personas.md`: "until Phase 6
  removes the shims" becomes "until Phase 6's `aggregate-removal` deletes `forwarding.svelte.ts`
  whole (the accessors, the shims, and the Phase 6 facade)".

## Open questions for the plan owner

1. Decided by the refinement, stated for the record: change events carry refs and revisions only
   (no data, no ops), and every `hello` reconciles through the revisions route.
2. Observer granularity: no observer socket; other tabs see a running generation at checkpoint
   granularity (3 s) through the feed and read the chat per checkpoint (proposed), or a per-job
   observer stream with every chunk.
3. Trash pruning and `checkCharOrder`: client mutations at boot (proposed) or a server startup
   sweep?

Folded into the slices as settled (Opus P15): the `afterSeq` barrier (dropped; Phase 5's
`resource` events stay), whole-record section writes (Phase 3's choice, Phase 4 rejected a
second op protocol), `selectedCharID` not an exit gate (the phase file's criteria name only
`DBState.db`), the chat LRU size and prefetch (implementation details, stated in slice 8),
plugin `getDatabase("all")` doing a one-off server read (the phase file: "fetches it from the
server first"), the archive convention (the existing one), `Database` kept as a type alias
(implementation detail, stated in slice 9).
