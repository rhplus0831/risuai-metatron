# Per-Chat Toggles and Toggle Presets Plan

Status: slices 1–2 landed; slices 3–4 remain planned. Slice 1 keeps kind-aware empty strings (`""` stays set for text/textarea). Slice 2 adds `GLGlobalVariables` to `CHAT_META_MERGE_KEYS` for per-key writes (unchanged stored values skip; unloaded targets return false), removes Local Toggles, and inherits only a loaded source chat's map; an unloaded source starts without a map because chat summaries do not carry it. These decisions supersede the whole-map write and loading behavior described below.

Planned on 2026-10-17. Sources: the code at
`bfdcfd508` (anchors below are from that commit; re-verify before editing) and
the sibling fork `/home/codex/risuai-fastify`, whose "Saved Toggles" feature
(`src/ts/chatGenerationTogglePresets.ts`, `…Planning.ts`, `…Records.ts`,
`src/lib/SideBars/ChatGenerationTogglePresetDialog.svelte`) is the model for the
preset half. Owning guides: [cbs-rendering](../structure/cbs-rendering.md)
(variables), [ui-theming](../structure/ui-theming.md) (`Toggles.svelte`),
[persistence](../structure/persistence.md) (the new collection and chat field),
[self-host-server](../structure/self-host-server.md) (the job CBS host and
prompt info).

## Goal

Three user-facing changes, delivered together:

1. **Remove "Local Toggles".** The per-chat checkbox, the 📌 pin per toggle, and
   the `useLocallySetGlobalVariables` flag go away.
2. **Toggle state is always per chat.** Every prompt toggle (preset, module, and
   character `customModuleToggle` definitions) reads and writes the open chat's
   own map. Nothing writes the settings-wide `globalChatVariables` any more.
3. **Toggle presets.** The user saves the chat's current toggle values under a
   name, applies a saved preset to any chat, and renames, overwrites, or deletes
   presets. A chat remembers which preset it last used.

And one defect fixed on the way:

4. **Unset toggles have no default.** Today an unset toggle reads as the string
   `"null"` in prompts (`{{getglobalvar::toggle_x}}` renders `null`,
   `#when::toggle::x` is false), a select shows blank, and nothing ever writes a
   first value. After this plan an unset defined toggle reads as its kind's
   default everywhere (`"0"` for checkbox and select, `""` for text and textarea),
   client and server alike.

## Original code (historical baseline for this plan)

Toggle definitions: a prompt preset's `customPromptTemplateToggle`
(`shared/presets.ts:168`, edited in `PromptSettings.svelte:310`), every enabled
module's `customModuleToggle` (`getModuleToggles`, `src/ts/process/modules.ts:584`),
and the character's `customModuleToggle` (`CharConfig.svelte:1431`). The sidebar
joins the three texts and parses them with `parseToggleSyntax`
(`src/ts/util.ts:1035`; a duplicate copy at `server/src/prompt/assemble.ts:171`).
Grammar per line: `key=label[=type[=options]]`, types `select` (value is the
option index as a string), `text`, `textarea`, `group`/`groupEnd`, `divider`,
`caption`; anything else is a checkbox. There is no default-value field.

Toggle state: the key `toggle_<key>` in two places.

- `settings.globalChatVariables`, the collection `globalChatVariables`
  (`shared/sections.ts:302`, normalizer `server/src/data/normalize/collections.ts:69`).
- `Chat.GLGlobalVariables` (`shared/database.ts:1219`), the per-chat override map
  that "Local Toggles" (`Chat.useLocallySetGlobalVariables`, `:1218`) writes.

Readers all prefer the chat map, whatever the flag says: client
`getGlobalChatVar`/`getGlobalChatVarOf` (`src/ts/parser/chatVar.svelte.ts:103-117`),
the CBS evaluator's `toggle`/`tis`/`tisnot` (`shared/cbs/evaluator.ts:387-433`),
`getglobalvar` (`shared/cbs/registry.ts:904`), the server job host
(`server/src/jobs/cbsHost.ts:146-152`), Lua `getGlobalVar`
(`server/src/lua/bindings.ts:1144`). The only writer is `Toggles.svelte` through
`setGlobalChatVar` (`chatVar.svelte.ts:119-131`), which picks the store by the
flag. The transform cache key covers both chat fields
(`server/src/prompt/transform.ts:378-390`). Prompt info
(`server/src/prompt/assemble.ts:327-346`) reads only the global map, leaves the
character's toggles out, and indexes `options` for text toggles (wrong: text has
no options).

The built-in sidebar toggles use other stores and are **out of scope**:
jailbreak is `settings.ui.jailbreakToggle` (global), memory is
`character.supaMemory` (per character). They stay where they are and are not
part of a toggle preset, as in the fastify fork.

## Design decisions

- **The per-chat store is the existing `Chat.GLGlobalVariables` map**, keys
  `toggle_<key>`, values strings as today. Reason: every reader (client, CBS
  evaluator, server host, transform cache key) already consults it first, chats
  that used Local Toggles keep their values, and no chat migration is needed
  (chat fields are stored as sent, D2). The name is a persisted spelling: keep it
  (D3). `useLocallySetGlobalVariables` is simply ignored and no longer written;
  stored copies in old chats are harmless.
- **`settings.globalChatVariables` becomes a read-only legacy fallback.** The
  read order for a toggle is: the chat's value, else the legacy global value,
  else the kind default. Nothing writes the collection any more. This keeps
  every existing chat showing the values the user last set globally instead of
  resetting them; the first per-chat edit of a key pins that key only. Dropping
  the collection (a `DROPPED_FIELDS` entry, a one-time seed of open chats) is a
  deferred follow-up, not part of this plan. Keys that are not a defined toggle
  (nothing writes them today) keep the old `"null"` answer, so `getglobalvar` of
  an arbitrary name is unchanged.
- **Defaults are read-time, not only write-time.** One shared helper answers
  `resolveToggleValue(kind, stored)`; the client getters and the server host use
  it, so an unset toggle never reaches a prompt as `"null"`. A stored `""` or
  `"null"` counts as unset (this also repairs selects left blank by the current
  bug). The only writes of defaults are at chat creation (inheritance, below);
  opening an old chat writes nothing (the idle-reload invariant,
  `e2e/0-idleReload.spec.ts`).
- **New chats follow `settings.ui.newChatBinding`** like bindings and
  translation settings (`initialChatBinding`, `chatBinding.svelte.ts:175`;
  `initialChatTranslation`, `chatTranslation.svelte.ts:79`): with `inherit` a new
  chat copies the character's selected chat's toggle map (and `togglePresetId`);
  with `empty` it starts with no map (so every toggle reads as its default, or
  the legacy global value while that fallback exists). Branch and copy already
  spread the whole chat (`Chat.svelte:1560`, `SideChatList.svelte:93`).
- **Presets are one global list**, the collection `togglePresets`, with no
  `selectedId` (the selection is per chat: `Chat.togglePresetId`). A preset
  stores bare keys (`values: Record<key, string>`) plus the kind of each key at
  save time (`kinds`) so a mismatch can be reported, as the fastify records do.
  Jailbreak and memory are not stored.
- **Choosing a preset in the sidebar applies it and links it** (one step, unlike
  the fastify dialog's separate link and apply). Apply writes, for every toggle
  the chat currently defines, the preset's value or the kind default; preset
  keys the chat does not define are ignored. "Save" overwrites the linked preset
  (confirm) or asks for a name when none is linked. A deleted preset leaves
  `togglePresetId` dangling; the select shows "none" and the caption says the
  preset is gone. The caption marks the chat "edited" when its values differ
  from the linked preset's and "mismatch" when the key or kind sets differ.
- **`Toggles.svelte` takes a `chatRef` prop** like the newer panels
  (`ChatTranslationPanel.svelte`), instead of reading `selectedChat()`. Without a
  loaded chat the inputs are disabled and show defaults; writes go through
  `setChatMeta(ref, { GLGlobalVariables: next })` (whole-map replace, as
  `scriptstate` is written). `OpenChatPanel` passes the open chat,
  `CharConfig` the character's selected chat, `PopupEditor` `currentChatRef()`.

## Slices

One slice is one session, one commit, one file cluster. Slices 1 and 2 share
files and run in order; slice 3 touches persistence plumbing only and can run
in parallel with them; slice 4 needs 2 and 3.

### 1. Shared toggle helpers and read-time defaults (_small_)

Guides: cbs-rendering, self-host-server, global-api.

- Add `shared/prompt/toggles.ts`: move `parseToggleSyntax` and the
  `sidebarToggle` union there (no DOM types, no runes; `src/ts/util.ts` and
  `server/src/prompt/assemble.ts` import it, the server copy is deleted). Add
  `ToggleKind` (`"checkbox" | "select" | "text" | "textarea"`),
  `toggleKindOf(definition)`, `toggleStorageKey(key)` (`toggle_` prefix),
  `toggleDefault(kind)`, `isToggleValueSet(value)` (a non-empty string other
  than `"null"`), `resolveToggleValue(kind, stored)`, and
  `toggleDefinitionsText(presetText, moduleText, characterText)` (the join the
  sidebar does at `Toggles.svelte:93`), plus `valueToggles(definitions)` (the
  entries that hold a value: no group, divider, caption).
- Client: `getGlobalChatVar`/`getGlobalChatVarOf` (`chatVar.svelte.ts`) resolve
  through the helper when the key names a defined toggle. The definitions for a
  ref come from `readPresetFieldOf(chatDisplayIds(ref), "customPromptTemplateToggle")`
  (`settingsViews.svelte.ts:580`, `chatBinding.svelte.ts:58`), `getModuleToggles()`,
  and the chat owner's `customModuleToggle`; memoize per definitions text (a
  `$derived` in a small `src/ts/toggles/chatToggles.svelte.ts` module that
  exports `chatToggleDefinitions(ref)`, `getChatToggle(ref, key)`,
  `setChatToggle(ref, key, value)`). `Toggles.svelte` keeps its current markup in
  this slice and only switches to these accessors.
- Server: `createJobCbsHost` parses the job's definitions once lazily
  (`db.customPromptTemplateToggle` of the forwarded preset roots,
  `host.moduleToggles()`, the chat owner's `customModuleToggle`) and resolves
  `getGlobalChatVar` through the same helper. Prompt info
  (`assemble.ts:327-346`) uses the chat-aware read, includes the character's
  toggles, and reports text/textarea raw and select by option label.
- Tests: `shared/prompt/toggles.test.ts` (grammar, kinds, defaults, `""`/`"null"`
  as unset); `src/ts/parser/tests/chatVar.svelte.test.ts` (an unset defined
  checkbox reads `"0"`, select `"0"`, text `""`, an undefined name still `"null"`,
  chat value over legacy global); `server/src/tests/cbsHost.ts` and
  `fixtures/cbs-parity.json` (the same on the server; the parity suite keeps
  client and server equal); a prompt-info case in the assemble tests.

### 2. Remove Local Toggles; per-chat writes; new-chat inheritance (_small_)

Guides: cbs-rendering, ui-theming, persistence. After slice 1.

- `chatVar.svelte.ts`: delete `getGLChatVar`, `setGLChatVar`, `deleteGLChatVar`,
  `isLocallyHandledGlobalChatVar`, `removeLocallyHandledGlobalChatVar`, and the
  `console.log` calls; `setGlobalChatVar` becomes `setChatToggle(ref, key, value)`
  writing `GLGlobalVariables` through `setChatMeta` (throws while the chat loads,
  as today; the component disables inputs then). Nothing writes
  `settings.globalChatVariables`.
- `shared/database.ts`: remove `useLocallySetGlobalVariables` from `Chat`
  (keep `GLGlobalVariables`, documented as the chat's toggle map).
- `Toggles.svelte`: `chatRef` prop; remove the checkbox (`:270-283`), the
  `localToggle` snippet and `PinIcon` (`:17-23`, `:122-136`), the dead
  commented code (`:77-82`) and the unreachable `>4` container branch
  (`:223-247`) if its callers all pass `noContainer`; inputs `disabled` without a
  loaded chat. Callers: `OpenChatPanel.svelte:51`, `CharConfig.svelte:437`,
  `PopupEditor.svelte:112`.
- `src/ts/toggles/chatToggles.svelte.ts`: `initialChatToggles(chaId)` after the
  `initialChatTranslation` pattern (untracked, `newChatBinding`), spread at the
  new-chat sites `SideChatList.svelte:222-244` and `ChatList.svelte:126-131`;
  `ensureChat` (`chatStore.svelte.ts:1690`) stays unbound and empty.
- Server: drop `useLocallySetGlobalVariables` from the transform cache key
  (`transform.ts:378-390`) and the comment at `cbsHost.ts:87`.
- Lang: remove `localToggles` from `en.ts:1916`, `ko.ts:1761`, `zh-Hant.ts:1487`.
- Fixtures: `server/src/tests/fixtures/cbs-parity.json:91,265-270` and
  `server/src/tests/cbsHost.ts:38,70-75` lose the flag (the override case stays:
  a chat value still wins over the legacy global).
- Docs: `cbs-rendering.md:47,94,103`, `self-host-server.md:51,68`,
  `ui-theming.md:58`, `persistence.md:145` (the collection is legacy, read-only).
- Tests: `Toggles.test.ts` gains checkbox/select/text cases over
  `installFlatDatabaseWithChats` (a change writes the chat, not the collection;
  disabled while loading; defaults shown); a `chatToggles` test for
  `initialChatToggles` under `inherit` and `empty`.

### 3. The `togglePresets` collection and `Chat.togglePresetId` (_small_)

Guide: persistence. Independent of slices 1 and 2.

- `shared/togglePresets.ts`: `TogglePreset { id, name, values: Record<string, string>,
kinds: Record<string, ToggleKind>, createdAt, updatedAt }`,
  `createTogglePreset(name, values, kinds, id?)` (id through `newId`/`isRecordId`,
  as `createHypaV3Preset` at `shared/hypaV3Presets.ts:10`), and
  `normalizeTogglePresets(input)` (drops non-objects and duplicate ids, names an
  unnamed preset `Toggle Preset N`, keeps only string values and known kinds,
  repairs timestamps; the fastify `normalizeChatGenerationTogglePresets` rules).
- Thread it as `hypaV3Presets` is, minus the selection field: `Database`
  (`shared/database.ts`), `COLLECTION_KIND`/`COLLECTION_FIELDS`
  (`shared/sections.ts:296-329`), `RESOURCE_KIND` (`shared/resources.ts:46`),
  the server normalizer (`server/src/data/normalize/collections.ts`, default
  `[]`), `settingsKind` registration (`server/src/data/kinds.ts:232`),
  `BY_ID_FIELDS` (`src/ts/storage/records.svelte.ts:1695`). Boot install, the
  settings view (`settings.togglePresets`), save/sync, backup, and the settings
  report are automatic; leave it in the report (not sensitive) and out of the
  plugin `allowedDbKeys`.
- `Chat.togglePresetId?: string` on `shared/database.ts` `Chat`: stored as sent,
  defaulted by readers, no server change (D2); written through `setChatMeta`
  (`null` unsets, as `setChatTranslationSettings` does). Not a summary field.
- Tests to extend: `server/src/tests/kinds.test.ts:15-35`,
  `resourceKinds.test.ts`, `normalizeCollections.test.ts` (the new normalizer),
  `src/ts/storage/tests/resourceSyncSections.test.ts` (the non-default fixture
  and the per-kind edit list), `fixtures/phase3/boot-snapshot.json` (same
  commit), `snapshots.test.ts` if the removed-key list changes. The persistence
  recipe: a fresh default, survival across reload, no write on an idle reload.

### 4. Preset operations and the sidebar UI (_medium_)

Guides: ui-theming, settings-i18n. After slices 2 and 3.

- Pure helpers in `shared/prompt/togglePresets.ts` (tested without the DOM):
  `captureToggleValues(definitions, read)` (every value toggle, through
  `resolveToggleValue`), `toggleValuesForChat(preset, definitions)` (the apply
  projection: preset value or kind default per defined key, bare keys mapped to
  storage keys), `compareTogglePreset(preset, definitions, read)` →
  `{ missing, stale, kindMismatch, differing, hasMismatch, hasDifference }`
  (the fastify `compareChatGenerationTogglePresetToActiveState` contract).
- Operations in `src/ts/toggles/togglePresets.svelte.ts` over
  `settings.togglePresets` and `setChatMeta`: `saveTogglePresetFromChat(ref, name)`,
  `overwriteTogglePreset(ref, id)`, `applyTogglePreset(ref, id)` (writes the map
  and `togglePresetId` in one `setChatMeta`), `renameTogglePreset(id, name)`,
  `deleteTogglePreset(id)`. House rule from `TranslatorPresetSettings.svelte:64-140`:
  capture `{ id, name }` before an `alertInput`/`alertConfirm`, find the record by
  id again after the await, and re-check `chatEntry(ref)` before a chat write.
- UI at the top of `Toggles.svelte` (hidden when the chat defines no value
  toggle): a caption row "Toggle preset" with the state word (none, edited,
  mismatch, deleted), a `SelectInput` ("none" plus every preset by name, value
  `chat.togglePresetId`; choosing one applies and links, after `alertConfirm`
  when the chat is edited), and icon buttons Save (overwrite the linked preset
  after confirm, else name a new one), Save as new, Rename, Delete (confirm).
  Rows whose value differs from the linked preset get a `text-draculared`
  marker (theme tokens only, U1). GUI primitives: `SelectInput`/`OptionInput`,
  `IconButton`, `@lucide/svelte` icons.
- Lang keys in `src/lang/en.ts` (the type) with `ko.ts` overrides: the caption,
  state words, the name prompt, the overwrite/apply/delete confirmations, and
  the "preset no longer exists" note; reuse `removeConfirm`, `close`, `edit`,
  `remove` where they fit.
- Tests: the pure helpers (missing/stale/kind-mismatch/differing, projection
  defaults, bare-to-storage key mapping); `Toggles.test.ts` cases for save (a
  record appears with the chat's values and kinds), apply (the chat map and
  `togglePresetId` change in one write; undefined preset keys ignored), delete
  (the chat keeps a dangling id and shows the note).
- Docs: `ui-theming.md` (`Toggles.svelte` and `OpenChatPanel.svelte` entries),
  `persistence.md` (the collection and the chat field), `cbs-rendering.md`
  `chatVar.svelte.ts` users. Record the browser check in the commit message
  (the sidebar on desktop and mobile layouts; `playwright-check-runs` memory for
  the dev-stack recipe).

## Deferred (not in this plan)

- Dropping the `globalChatVariables` collection (`DROPPED_FIELDS`, kinds tests,
  the boot fixture) with a one-time seed of each chat's map from the legacy
  values. Do this once per-chat toggles have shipped and a release has passed.
- An explicit default in the definition grammar (for example a fifth field,
  which today is dropped silently, or `key=label=select=a,b|1`). The kind
  default fixes the reported bug; a per-toggle default is a grammar change that
  affects `.risup` cross-user files (D5) and needs its own decision.
- Preset sorting by similarity and the "pick one source" partial apply from the
  fastify dialog; a `.risutoggle` export/import; exposing toggle presets to
  plugins, MCP, or chat commands.
- Writing toggle values from CBS, Lua, or triggers (none exists today either).

## Verification

Per slice: `pnpm check`, `pnpm --silent test:agent`, and the owning guide's
tests; `pnpm --silent test:agent --tags-filter=slow` when the parity or
resource-sync suites change; `pnpm exec prettier --write` on changed files.
After slice 4: a browser pass over a chat with checkbox, select, text, and
grouped toggles (defaults shown on a fresh chat, a value survives reload and
stays per chat across two chats of one character, inherit/empty on a new chat,
save/apply/rename/delete, prompt info showing the chat's values), and the idle
reload e2e (`e2e/0-idleReload.spec.ts`) to confirm opening an old chat writes
nothing.
