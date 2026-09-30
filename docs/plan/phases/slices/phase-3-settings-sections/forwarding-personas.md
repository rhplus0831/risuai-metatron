# Slice: Forwarding Layer For Personas, And Root Removal

Status: planned (drafted 2026-09-30, refined after review, not started).

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
