# Slice: Forwarding Layer For Personas, And Root Removal

Status: implemented 2026-09-30 (record below).

Phase: [Phase 3](../../phase-3-settings-sections.md), "Remove the working copies" (personas),
"Ids" (`selectUserImg` keeps the id; persona ids required), "Selection state"
(`selectedPersona`), and the exit criteria "No `root` resource remains" and "A chat bound to a
persona keeps its binding after the persona's icon changes"; `PLAN.md` Decision 3.

Depends on: slice 5 (the layer, the selection store, the residual `root` reduced to the persona
fields and `selectedPersona`).

## Scope

Allowed files: `src/ts/storage/forwarding.svelte.ts` (the four persona accessors and
`selectedPersona`), `src/ts/storage/selection.svelte.ts` (`personaId`, `selectPersona`),
`src/ts/persona.ts` (`saveUserPersona` deleted, `changeUserPersona(id: string)`, `selectUserImg`
captures the id before its `await` and keeps it, `importUserPersona` keeps its slice-2 id),
`src/ts/storage/resourceSync.svelte.ts` (the residual root projection and watcher removed;
`COLLECTIONS` loses `root`), `src/ts/bootstrap.ts` (`assembleDatabase` without `root`;
`checkNewFormat` loses the persona id guard), `src/ts/storage/database.svelte.ts` (the last
residual defaults), `src/lib/Setting/Pages/PersonaSettings.svelte`, `src/lib/Setting/listedPersona.svelte`,
`src/lib/SideBars/SideChatList.svelte` and `src/lib/SideBars/CustomSidebar.svelte` (the
`personas[selectedPersona].id ??= v4()` guards go), `src/lib/ChatScreens/DefaultChatScreen.svelte`
(selected persona display), `src/ts/process/triggers.ts` (`v2GetPersonaDesc`,
`v2SetPersonaDesc`), `shared/resources.ts` and `server/src/data/kinds.ts` (the `root` kind and
`ROOT_EXCLUDED_KEYS` removed), `server/src/data/resourceStore.ts` (`SCHEMA_VERSION` 3), the
server fixtures that write `root` records (`server/src/tests/{resourceStore,resources,resourcesBatch,backups}.test.ts`:
they move to a section kind), `docs/structure/self-host-server.md` (`State`: version 3). Tests
belong to the review step.

Identifiers (verified): the four persona fields `username`, `userIcon`, `personaPrompt`,
`userNote` and their persona keys `name`, `icon`, `personaPrompt`, `note`
(`PERSONA_ROOT_ALIASES` in `shared/presets.ts`, slice 2: Opus P9); persona callers
`PersonaSettings.svelte` (`saveUserPersona` at the reorder start and the delete,
`changeUserPersona` at reorder end, tile click, add, delete; `selectUserImg`,
`importUserPersona`), `listedPersona.svelte` (`changeUserPersona(i)`); persona resolution
`src/ts/util.ts` (`getUserName`, `getPersonaPrompt`, `getUserIcon`, by `chat.bindedPersona` id,
falling back to the root fields); `DefaultChatScreen.svelte` and `SideChatList.svelte` reading
`personas[selectedPersona]`; `v2SetPersonaDesc` (writes both the selected persona and the root
copy); `allowedDbKeys` (`selectedPersona`, `personas`); `SCHEMA_VERSION` (2), `initialize`'s
version-1 refusal message ("disposable alpha data: move it away or delete it and restart"),
`readSnapshot`'s `user_version` check, `backupTo`.

Stopping condition: a reader of `selectedPersona` that needs the index persisted and shared
(none found), or a `root` reference outside tests and docs after removal (`rg "RESOURCE_KIND.root"`
and `rg 'kind: "root"'`; a plain `"root"` grep false-positives in `CustomGUISettingMenu.svelte`:
Opus P14).

## Assumptions

- Slice 5 landed: the layer, `selection.svelte.ts`, `RESIDUAL_ROOT_KEYS` = the four persona
  fields and `selectedPersona`.
- Every persona has an id (slice 2 assigns at every creation site including the "create from
  scratch" push, `importUserPersona`, the persona conversions in `interchangeability.ts`, and an
  `ensureIds` pass in the plugin setters for `personas`; slice 3 backstops), and chats bind by id
  (`Chat.bindedPersona`, resolved in `util.ts`).
- `backupTo` copies the whole SQLite file and `readSnapshot` refuses rows of an unregistered
  kind, so a database that keeps a `root` row after the kind is gone makes every later snapshot
  and archive unrestorable (Astra P11, Opus P2). The precedent for the fix is the version-1
  refusal in `initialize`.

## Proposed decisions

- Persona forwarding (decided by the plan): four accessors over the selected persona through
  `PERSONA_ROOT_ALIASES`, resolved on every access from `selection.personaId` and the current
  `personas` collection; `selectedPersona` becomes the derived index accessor (getter: index of
  the selected id or 0; setter: selects the id at that index, so plugin
  `setDatabase({ selectedPersona })` selects on this client only, recorded); the accessors and
  the shim stay until Phase 6's `aggregate-removal` deletes `forwarding.svelte.ts` whole (the
  accessors, the shims, and the Phase 6 facade). `changeUserPersona(id)`
  is `selectPersona(id)`; `saveUserPersona` is deleted (accessors write through);
  `selectUserImg` captures `selection.personaId` before `selectSingleFile`, writes
  `icon` into that record, and keeps the id (the phase-file fix; exit criterion);
  `PersonaSettings.svelte` keeps its four bindings and loses the reorder id dance; the guards in
  `SideChatList.svelte` and `CustomSidebar.svelte` go; `v2SetPersonaDesc` writes
  `DBState.db.personaPrompt` only (the selected persona) and `v2GetPersonaDesc` reads it.
- Root removal and schema version (Opus P2, Astra P11): with the last residual keys forwarded,
  `root` is removed from `RESOURCE_KIND`, `DEFAULT_RESOURCE_KINDS`, `COLLECTIONS`, and
  `ROOT_EXCLUDED_KEYS` goes. `SCHEMA_VERSION` becomes 3; `initialize` refuses a version-2 file
  with the same "disposable alpha data" message naming the file, and `readSnapshot` refuses
  version-2 snapshots and archives as it refuses version 1 today. A fresh store starts at 3.
  Alternative (purging unregistered rows in `initialize`) rejected: it deletes data silently and
  would keep accepting pre-phase databases whose records lack ids and sections.
- Fallback form (if slice 1 failed): `SelectedPersona` in `selected.svelte.ts` with the three
  `PersonaSettings.svelte` bindings, `WelcomeRisu.svelte`'s `username` write, and the readers in
  `util.ts`, `index.svelte.ts:731`, `lorebook.svelte.ts`, `stringlize.ts`, `triggers.ts`,
  `DefaultChatScreen.svelte`, `CustomSidebar.svelte` moved to it.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Manual, recorded here: switch
persona, edit the prompt, bind the persona to a chat, change its icon, reload: the binding holds
and the icon shows; two tabs with different personas: an edit in one does not change the other's
selected persona; a Phase 2 database is refused at startup with the message; a fresh server
starts at version 3, a snapshot and an archive made afterwards restore; plugin
`setDatabase({ selectedPersona: 1 })` selects on this tab only. Review-step tests: the persona
accessors over the real module graph, `selectUserImg` keeping the id across the `await`,
`reconcileSelection` after `personas` replacement and removal, the version-2 refusal and the
version-3 snapshot round trip in `server/src/tests/`.

## Residual risk

Every database created before this slice is refused (no migration owed; the phase file records
it). Selection is per tab. `getModules` still does not resolve a bound persona's `$embedded`
module (pre-existing: `getModuleByIds` filters `db.modules` only); not touched here.

## Requirement from slice 3 (Astra challenge)

The server `personas` normalizer (`server/src/data/normalize/personas.ts`) accepts `[]` (the
plugin setters can write it) and entries with only an id. Once the root persona defaults go,
"fall back to the first persona" cannot resolve either. Before the forwarding layer depends on
it, decide the contract: recommended, a nonempty collection whose entries carry `name`,
`personaPrompt`, `icon`, and `note` strings (extra data such as `embeddedModule` kept), applied
alike by the client and the server so the fixed point holds; or an explicit empty-persona state
that every forwarding reader and writer handles.

## Implementation record

Implemented on 2026-09-30 by Opus on `e6f343f6` (slice 5).

Files: `shared/personas.ts` (new: `PERSONA_DEFAULTS`, `defaultPersona`, `normalizePersonas`),
`server/src/data/normalize/personas.ts` (calls it), `shared/sections.ts` (`RESIDUAL_ROOT_KEYS`
and slice 5's `CLIENT_SELECTION_KEYS` removed; `FORWARDED_ROOT_KEYS` = the preset keys,
`proxyKey`, the four persona keys, and the three `SELECTION_KEYS`; `PHASE1_FIELDS` spelled out),
`shared/resources.ts` (the `root` kind, `ROOT_EXCLUDED_KEYS`, and `RootResource` removed),
`server/src/data/kinds.ts` (the `root` kind removed), `server/src/data/resourceStore.ts`
(`SCHEMA_VERSION` 3; a version-2 file refused at startup with the "disposable alpha data"
message; `readSnapshot` already refuses any other version), `src/ts/storage/forwarding.svelte.ts`
(the persona accessors, `selectedPersona`, `selectedPersona()`/`selectedPersonaForWrite()`),
`src/ts/storage/selection.svelte.ts` (`personaId`, `selectPersona`),
`src/ts/storage/database.svelte.ts` (the persona defaults replaced by
`normalizePersonas(plainClone(personas))`), `src/ts/storage/resourceSync.svelte.ts` (the root
projection, watcher, collection, and mirror branch removed), `src/ts/bootstrap.ts` (no root in
the assembly), `src/ts/persona.ts`, `PersonaSettings.svelte`, `listedPersona.svelte`,
`SideChatList.svelte` and `CustomSidebar.svelte` (the id guards removed), `src/ts/process/triggers.ts`,
and the docs (`STRUCTURE.md` D2 and D4, `persistence.md`, `self-host-server.md`,
`characters-modules.md`). `DefaultChatScreen.svelte`, `util.ts`, and the plugin setters needed no
change (they read through the accessors). `checkNewFormat` had no persona guard left (slice 4
removed it).

Decisions made while implementing:

- The personas contract (the slice 3 requirement): the recommended option. `normalizePersonas` in
  `shared/personas.ts`, run by the server normalizer (after its object check) and by `setDatabase`:
  never empty (an empty or missing list becomes the default persona), each entry's `name`, `icon`,
  `personaPrompt`, and `note` strings (a missing or wrong-typed one gets its `PERSONA_DEFAULTS`
  value, appended after the entry's own keys), a valid unique id, other keys kept. A plugin's
  `setDatabaseLite({ personas: [] })` still leaves the mirror empty until the next full
  normalization; the accessors then read the defaults and drop writes.
- The persona getters read the selected persona's field, and a non-string reads as its default
  (the four fields are strings by contract). Writes go to the record the selection names now,
  resolved untracked, and are dropped when it names none, as for presets. `selectedPersona` is the
  index accessor (a plugin's `setDatabase({ selectedPersona: 1 })` selects on this client only).
- `changeUserPersona(id)` only selects (an unknown id does nothing); the `save` parameter went with
  `saveUserPersona`. `selectUserImg` captures the selected persona before the file dialog, writes
  only its `icon`, and keeps its id; the icon is dropped if the persona was deleted meanwhile.
- Deleting a persona captures `{ id, name }` before the confirm, re-resolves by id after it,
  rechecks the one-persona minimum, and switches only when the deleted persona was selected (the old
  code always switched to persona 0). The reorder no longer touches the selection.
- `v2GetPersonaDesc` reads `db.personaPrompt` (the selected persona's; the old fallback to the
  stored copy is the same value now) and `v2SetPersonaDesc` writes it.
- `importUserPersona` gives the new persona `newPersonaId()` and a string `note`.
- `SELECTION_KEYS` now serves as the per-client list (all three are forwarded); the slice 5
  `CLIENT_SELECTION_KEYS` was folded into it.

Tests invalidated (the plan's table named `backups`, `resourcesBatch`, `kinds`, `resourceSync*`,
and `characters`; the full list, all from the removed `root` kind, the schema version, the
personas contract, or the selection shape): `server/src/tests/backups.test.ts` (19),
`kinds.test.ts` (3), `normalizationPass.test.ts` (the file fails to load: it looks the `root`
kind up), `normalizeCollections.test.ts` (1: an empty personas list stayed empty),
`resourceStore.test.ts` (2), `resources.test.ts` (2), `resourcesBatch.test.ts` (7),
`resourcesChats.test.ts` (5), `shutdown.test.ts` (2), `shutdownAdmission.test.ts` (1), and the
shared `testSupport.ts` helper (a `root` write); `src/ts/storage/tests/presetSchema.test.ts` (3),
`resourceSync.test.ts` (16), `resourceSyncChats.test.ts` (16), `resourceSyncSections.test.ts` (7),
`resourceSyncUnload.test.ts` (1), `selection.test.ts` (7: the stored shape gains `personaId`);
`e2e/idleReload.spec.ts` (the first boot no longer creates `root`); `src/ts/characters.test.ts`
seeds a root record (passing). Most use `root` as their sample singleton kind or edit.

Checks: `pnpm check` (source clean on both tsconfigs; only the invalidated tests error),
`pnpm format:check`, and `pnpm build` pass; `pnpm test` shows only the invalidated cases;
`pnpm test:e2e` fails only `idleReload.spec.ts` (the two slice 5 specs pass).

Playwright (`checkSlice6.mjs` in the session scratchpad, fresh server, system Chrome):

- A store file with `user_version` 2 makes the server exit with code 1 and the message naming
  the file ("holds resource database version 2 ... disposable alpha data ...").
- A fresh store has `user_version` 3; the first boot writes `modules+` and `plugins+` only; an
  idle reload writes nothing; `GET /api/resources/root/main` answers 400 (unknown kind).
- Personas U1 and U2: select U2, set its prompt, create a character, bind its chat to U2. Start the
  icon picker (the real file chooser), switch to U1 while it is open, choose a PNG: the icon lands
  on U2, U1 stays selected, both ids are unchanged. After a reload the chat is still bound to U2,
  which shows its icon and prompt.
- The plugin steps (`setDatabase` on the live database with `selectedPersona = 1`) select U2 on
  this tab.
- Two contexts, A on U2 and B on U1: A's prompt edit sends one `personas` batch; after reloads A
  still has U2 (with the edit) and B U1.
- An archive export (200) and its import succeed; the safety snapshot the import took is listed
  and restores; the personas and the selection are intact afterwards.
- Settings pages sweep: the same as before (only the old page 13 errors).

## Astra challenge (2026-09-30) and decisions

1. The plugin setters kept an empty or duplicate-id `personas` list (`withPersonaIds` only added
   missing ids), so a direct reader such as `DefaultChatScreen` (`personas[selectedPersona]`)
   threw, and the selection by id could not resolve. **Adopted**: both plugin setters run
   `normalizePersonas` over a plain copy (a non-list is refused and the personas kept; `null` was
   refused already).
2. The plugin setters applied keys in object order, so `{ selectedPersona: 1, personas: [...] }`
   resolved the index against the old list. **Adopted**: `selectedPersona` is applied last in both
   setters; `risuai.d.ts` documents that it is an index that changes only this client's selection.
3. `importUserPersona` read `DBState.db.personas.push` before awaiting the image, so a collection
   replaced meanwhile (now by any full plugin `setDatabase`, which normalizes `personas`) lost the
   import. **Adopted**: the icon is saved first, then the live list gets the push.

Astra's testing advice goes to the Fable reviewer.

## Review

Fable reviewer (2026-09-30): no problem in the code. It confirmed every adaptation as an expected
invalidation and the three challenge fixes, and flagged stale guide lines naming removed identifiers
(`persistence.md`, `build-test-platforms.md`), fixed before the commit. It wrote
`forwardingPersonas.test.ts`, `src/ts/plugins/apiV3/v3SetPersonas.test.ts`, a version-boundary
case in `server/src/tests/backups.test.ts`, a persona fixed-point case in
`resourceSyncSections.test.ts`, and `e2e/personaBinding.spec.ts`. After it: `pnpm test` 77 files,
791 passed, 3 skipped; `pnpm test:e2e` 5 passed. Observation, not a defect: after the selected
persona is removed, an `$effect` reading a persona accessor reruns once more than the preset path
(Svelte's bounded rerun after an untracked write of its own dependency); the value settles.
