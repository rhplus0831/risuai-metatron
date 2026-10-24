# Chat Lore Overrides Plan

Status: slices 1 (8363beb57), 2 (47e83fa24), 3 (0a9c9c721), 4 (740a05d1d) landed; all slices landed.

Planned on 2026-10-24. Sources: the code at `170b90879` (anchors below are from
that commit; re-verify before editing) and the design discussion with the user
recorded under **Agreed decisions**. Owning guides:
[chat-pipeline](../structure/chat-pipeline.md) (activation, send refusal),
[characters-modules](../structure/characters-modules.md) (lore editor),
[persistence](../structure/persistence.md) (the new chat field, checkpoints),
[cbs-rendering](../structure/cbs-rendering.md) (`{{lorebook}}`),
[scripts-triggers](../structure/scripts-triggers.md) (Lua lore bindings),
[backup-sync-hub](../structure/backup-sync-hub.md) (upstream export).

## Goal

A chat can change the character lorebook for itself only. Today the chat
lorebook (`Chat.localLore`) can only add entries: `activateLore` concatenates
`[...characterLore, ...chatLore, ...moduleLorebook]`
(`shared/lore/activation.ts:84-90`), so turning a character entry off or
changing its text in one chat means editing the character, which changes every
chat.

After this plan, a chat holds **overrides**: frozen copies of character lore
entries that replace the original in that chat. An override can change any
field, or turn the entry off in that chat. The character record and other chats
are unaffected.

One related defect is fixed on the way: a `child` link ("Always active in this
chat") inserts at its own insert order (100) instead of its linked entry's.

## Original code (baseline)

- **Character lore** is `character.globalLore` (also `groupChat.globalLore`,
  `shared/database.ts:638`, `:809`). Entries are `loreBook`
  (`shared/database.ts:600-620`); `id` is optional and most entries have none
  (new entries `src/ts/process/lorebook.svelte.ts:54-78`, card conversion
  `src/ts/characterCards.ts:1231-1331`). Ids can repeat inside one character
  after lore-file import or module apply (`src/ts/storage/records.svelte.ts:2200-2203`).
- **Folders** are entries with `mode: "folder"`; children carry
  `folder === folder.key`. The header sun/link button fans `alwaysActive` out to
  children through `onFolderActive` (`LoreBookData.svelte:182-198`,
  `LoreBookList.svelte:502-507`).
- **The `child` link** ("Always active in this chat", `alwaysActiveInChat`):
  shown only inside an expanded, not-always-active character entry when
  `settings.ui.localActivationInGlobalLorebook` is on
  (`LoreBookData.svelte:337-347`). Checking it gives the original a `v4()` id if
  it has none and pushes `{ mode: "child", id, insertorder: 100, alwaysActive: true, … }`
  into the chat lore draft (`:88-108`). At activation
  (`activation.ts:284-313`) the child reads `order`/`priority` from itself, then
  scans earlier entries for the same id; if that entry did not activate, the
  child copies its `comment` and `content` and activates. The original stays
  live-linked: edits to it reach the chat. Deleting a character entry removes
  its child links from the one captured chat only (`LoreBookData.svelte:199-237`).
- **Chat lore editing** goes through `useLocalLoreDraft()`
  (`src/ts/storage/localLoreDraft.svelte.ts:10-73`), which writes
  `setChatMeta(ref, { localLore })` and is fenced during sends.
- **Readers of character + chat lore** that concatenate raw arrays: activation
  (client `src/ts/process/lorebook.svelte.ts:147-155`, server through
  `server/src/prompt/runner.ts:1249-1261` → `assemble.ts:936`, Lua
  `server/src/lua/bindings.ts:1160-1190`, command `test_lorebook`
  `server/src/prompt/commands.ts:309-317`), CBS `{{lorebook}}`
  (`shared/cbs/registry.ts:312-330`), Lua `getLoreBooksMain`
  (`bindings.ts:1487-1508`), plugin `getCurrentLorebookEntries`
  (`src/ts/plugins/apiV3/v3.svelte.ts:1790-1824`).
- **Send refusal precedent**: chat binding. A pure shared resolver
  (`shared/chatBinding.ts:36-89`) feeds the server admission gate
  (`server/src/jobs/generationJobs.ts:1181-1186`, 409 body), the client error
  class `ChatBindingRefusedError` (`src/ts/network/generationJobs.ts:142-154`,
  `:222-240`), the alert in `serverCommands.ts:333-338`, `:415-423`, and the
  pre-send check in `DefaultChatScreen.svelte` `sendMain` (`:438-442`), which
  refuses before the composer is consumed.

## Agreed decisions

These were settled with the user on 2026-10-24.

1. **Any field can be overridden**, not only activation and content.
2. **Frozen copy.** Character entries in the override view are shown dimmed and
   read-only. Checking "Override in this chat" copies the entry at that moment;
   from then on the copy is independent of the original. Later edits to the
   original are not followed, and a large change to the original is not detected.
3. **Link by id, assigned at pin time.** If the original has no id, pinning
   gives it a `v4()` id (as the `child` link does today). This is one write to
   the character record.
4. **A deleted original blocks sending.** The override stays in the chat, and
   every generation for that chat is refused until the user deletes the override
   or converts it to a chat lorebook entry.
5. **Only the character lorebook** (the chat owner's `globalLore`) can be
   overridden; module lorebooks cannot.
6. **Folders.** The folder checkbox overrides or releases all of the folder's
   entries at once; the user can then release single entries (for example to
   keep one entry of a large folder). The folder state is derived from its
   children: all, some, or none.
7. **UI placement.** A section below the chat lorebook in the chat lorebook tab,
   collapsed by default. The override checkbox sits in the entry header next to
   the sun/link icon, so it works while collapsed and for folders, which have no
   body.
8. **The existing `child` link stays** as a separate feature (live link, force
   on only). It is not replaced or migrated.
9. **`child` follows its linked entry's insert order** (the override's if the
   entry is overridden, else the original's).
10. **When a `child` link and an "off in this chat" override meet on one entry
    in one chat, off wins and a notice explains it.** No automatic cleanup and no
    blocking of either control.

## Design decisions (made by this plan)

These follow from the agreed decisions or are defaults this plan picks. The
ones marked _confirmed_ were proposed by the plan and accepted by the user on
2026-10-24.

- **Storage: a new chat field, not `localLore`.**
  `Chat.loreOverrides?: ChatLoreOverride[]` with
  `type ChatLoreOverride = { entry: loreBook; off: boolean }`. `entry` is the
  frozen full copy; `entry.id` equals the original's id and is required.
  Reason: every reader of `localLore` treats its entries as additions; putting
  overrides there would insert both the original and the copy wherever a reader
  is not taught to skip them (including upstream RisuAI, which would read them
  as plain chat lore). A separate field fails safe: a reader that does not know
  it ignores it. The `off` flag is needed because `loreBook` has no "disabled"
  field.
- **One shared merge.** `shared/lore/overrides.ts` exports
  `mergeOwnerLore(ownerLore, overrides)` returning
  `{ lore, orphans }`: each owner entry whose id matches a non-off override is
  replaced in place by `entry` (a reference, not a clone: the client passes
  `$state` proxies, which `structuredClone` rejects; callers that mutate copy
  first); an entry matched by an off
  override is removed; overrides whose id matches no owner entry are returned as
  `orphans` and are not inserted. If ids repeat in the owner lore, an override
  replaces the first match only. Removing off entries (instead of keeping them
  flagged) is what makes "off wins" over a `child` link: the child then finds no
  earlier entry with its id and stays inactive. Keep this property under test.
- **Merged view vs raw view.** Chat-scoped readers use the merged view:
  activation, CBS `{{lorebook}}`, Lua `getLoreBooksMain` (and `loadLoreBooks`
  through activation), plugin `getCurrentLorebookEntries` when it has a chat.
  Raw character lore stays raw for editors, character MCP tools
  (`shared/mcp/risuaccess/characters.ts`), trigger v2 lore effects
  (`server/src/prompt/triggers.ts:1070-1135`, `:1639-1786`), token estimates,
  and import/export.
- **Group chats** _(confirmed)_: overrides apply to the chat owner's
  `globalLore`, which for a group chat is the group's own lorebook (what
  activation already reads). No extra code; CBS and Lua keep excluding group
  lore as they do today.
- **Duplicate ids at pin time**: if the original's id also appears on another
  entry of the same owner, pinning gives the original a fresh `v4()` id first.
  This can detach an existing `child` link on that entry in other chats; the
  link was already ambiguous.
- **Orphans in activation**: activation drops orphans silently. The admission
  gate (below) is the authority; this only covers the window between admission
  and activation.
- **Upstream export** _(confirmed)_: `loreOverrides` is stripped like the other
  metatron-only chat fields (`METATRON_CHAT_FIELDS`,
  `server/src/data/upstream/exportDatabase.ts:169-184`). Converting overrides to
  plain chat lore would bring back the append behavior and double insertions.
- **Chat JSON export/import** carries the field as is. A chat imported into a
  different character will usually have only orphans and is refused at send
  with the fix-it message; that is acceptable.
- **Checkpoints** capture the field (`"capture"` beside `localLore`).
- **Out of scope**: a marker in the character lorebook tab showing that the open
  chat overrides an entry (offered, not requested); overriding module lore;
  following edits of the original.

## Slices

One slice is one session, one commit, one file cluster. Slice 1 comes first.
Slices 2 and 3 can then run in parallel (disjoint files). Slice 4 needs 1 and
shares `src/lang/*.ts` with slice 3, so it runs after 3.

### 1. Data model, merge, activation, persistence (_medium_)

Guides: chat-pipeline, persistence, backup-sync-hub.

- `shared/database.ts`: add `ChatLoreOverride` and `Chat.loreOverrides?`.
- `shared/lore/overrides.ts` (new): `mergeOwnerLore`, plus
  `findOrphanedOverrides(ownerLore, overrides)` for slice 3 (same matching
  rule). No DOM types or runes (T2).
- `shared/lore/activation.ts`: build `fullLore` from
  `mergeOwnerLore(char.globalLore ?? [], chat.loreOverrides ?? []).lore` instead
  of the raw character lore. `LoreActivationInput.chat` gains `loreOverrides`.
  Child insert order: when a child resolves to entry `j`, use
  `fullLore[j].insertorder` for `order` and `priority` (today read from the child
  at `:286-287` before resolution).
- Callers that build `LoreActivationInput`: pass the field through
  (`src/ts/process/lorebook.svelte.ts:147-155`, `server/src/lua/bindings.ts:1160-1190`
  and whatever `services.activateLore` builds for the runner and commands).
- Persistence (D2): default and validate in `server/src/data/chats.ts`
  (missing → `[]`, non-array → `ResourceValidationError`, like `localLore`
  at `:44-49`); client `SERVER_META_DEFAULTS` (`chatStore.svelte.ts:2620`),
  canonical create comparison (`:3967-3977`), and the empty-chat literals
  (`SideChatList.svelte:287-308`, `ChatList.svelte:127-141`,
  `src/ts/characters.ts:55-86`, `chatStore.svelte.ts:2061-2099`, `:3365-3383`,
  `:3554-3569`); `CHECKPOINT_CHAT_FIELDS.loreOverrides = "capture"`
  (`shared/chatCheckpoints.ts`, the `Record<keyof ChatMeta>` type enforces it)
  and the checkpoint store's validation/preview (`server/src/data/checkpointStore.ts:268-327`,
  `:700-753`) and client validator (`src/ts/checkpoints/chatCheckpoints.svelte.ts:130-155`);
  transform cache key (`server/src/prompt/transform.ts:376-389`); upstream strip
  list. Branch and copy spread the whole chat and need no change; verify.
- Tests: `server/src/tests/lore.test.ts` (merge replaces in place, off removes,
  orphans not inserted, duplicate ids, child + override content, child + off
  stays inactive, child insert order follows the linked entry);
  `server/src/tests/chats.test.ts`; `server/src/tests/chatCheckpoints.test.ts`;
  `server/src/tests/transform.test.ts`; `server/src/tests/upstreamExport.test.ts`.
- Docs: chat-pipeline (activation), persistence (chat field inventory around
  `:172-180`, checkpoints), backup-sync-hub (upstream projection).

Landed notes (slice 1): `loreOverrides` is optional with no default (like
`toolCalls`; validated by `assertLoreOverrides` when present), so the client
defaults and empty-chat literals were left unchanged and every reader uses
`chat.loreOverrides ?? []`. "Off wins" is also enforced inside activation
through `offOverrideIds` (duplicate ids, `@@activate` children). The upstream
character import drops a malformed `loreOverrides` and keeps the chat.

### 2. Chat-scoped lore readers (_small_)

Guides: cbs-rendering, scripts-triggers, plugins-mcp.

- CBS `{{lorebook}}` (`shared/cbs/registry.ts:312-330`): merged owner lore for a
  non-group character (keep the group exclusion).
- Lua `getLoreBooksMain` (`server/src/lua/bindings.ts:1487-1508`): merged owner
  lore. `upsertLocalLoreBookMain` (`:1510-1547`) stays a raw `localLore` writer.
- Plugin `getCurrentLorebookEntries` (`v3.svelte.ts:1790-1824`): merged when it
  has a chat; the no-chat path stays raw.
- Tests: a focused `{{lorebook}}` case in `server/src/tests/cbs.test.ts` (none
  exists today); `server/src/tests/luaBindings.test.ts`;
  `src/ts/plugins/apiV3/pluginContext.test.ts` (covers `getCurrentLorebookEntries`).
- Docs: cbs-rendering, scripts-triggers, plugins-mcp.

### 3. Send refusal for orphaned overrides (_medium_)

Guides: chat-pipeline, self-host-server.

- Server: in `generationJobs.ts` `create`, after the binding check (`:1181-1186`),
  read the chat owner's `globalLore` and the chat's `loreOverrides`; if
  `findOrphanedOverrides` returns any, answer 409
  `{ error: "chatLoreOverrideOrphaned", entries: [{ id, name }] }` (name from the
  override's `comment`, else `key`). Every generation kind is admitted here
  (send, continue, group, preview, previewPrompt, command and Lua jobs), so all
  refuse alike, before the input stage can write the chat.
- Client: parse the 409 into a new error class next to `ChatBindingRefusedError`
  (`src/ts/network/generationJobs.ts`) and show a localized alert in
  `serverCommands.ts` naming the entries and the two fixes (delete the override,
  or move it to the chat lorebook). Pre-send check in `DefaultChatScreen.svelte`
  `sendMain` beside the binding check, so the composer is not consumed.
- The DevTool lore preview (`DevTool.svelte:325-365`) and standalone token
  counting do not refuse; activation drops orphans there.
- i18n: English strings in `src/lang/en.ts` and Korean in `src/lang/ko.ts`;
  other locales fall back to English.
- Tests: server admission test beside the binding refusal tests (find with
  `rg chatBindingIncomplete server/src/tests`); client error parsing and alert.
- Docs: chat-pipeline send flow and invariants (`:79-86`, `:124-149`).

### 4. Override editor UI (_large_)

Guides: characters-modules, ui-theming, settings-i18n.

- **Draft**: a `useLoreOverridesDraft()` sibling of `localLoreDraft.svelte.ts`
  with the same ref capture, send fence, and `setChatMeta(ref, { loreOverrides })`
  write. If it duplicates most of the existing file, factor a shared helper.
- **Section**: in `LoreBookSetting.svelte` chat tab (`submenu === 1`), below the
  chat lorebook list, an `<Accordion styled>` (`src/lib/UI/Accordion.svelte`)
  titled "Character lorebook overrides", closed by default and opened when the
  chat has orphans.
- **List**: a new component that renders the owner's `globalLore` with its folder
  nesting, no drag-and-drop, no add or delete. `LoreBookList` has no read-only
  mode and its Sortable and row bindings write the source arrays
  (`LoreBookList.svelte:262-445`), so do not reuse it as is. To avoid a second
  copy of the entry fields, extract the field editor body of `LoreBookData.svelte`
  into a component with a `disabled` prop and use it in both places.
- **Rows**: header shows the name, the effective sun/link state, and an
  "Override in this chat" checkbox next to it. Not overridden: dimmed,
  expandable, read-only (the original's fields). Overridden: the copy's fields
  are editable, plus an "Off in this chat" toggle. Checking pins (assign an id if
  missing or duplicated, then copy); unchecking asks for confirmation and
  removes the override.
- **Folders**: the folder header checkbox is tri-state from its children.
  Checking pins every child that is not pinned; unchecking (with confirmation)
  releases every child.
- **Orphans**: listed at the top of the section with "Original deleted", a
  delete button, and a "Move to chat lorebook" button (the copy goes to
  `localLore` with a fresh `v4()` id and `mode` unchanged; an off override can
  only be deleted).
- **Notices** (agreed decision 10): where a `child` link and an off override
  meet on one entry in this chat, show a short line on the override row
  ("Always active in this chat is set, but Off in this chat takes precedence")
  and on the `alwaysActiveInChat` checkbox and the chat lorebook's child row
  ("Off in this chat's override; not activated").
- i18n: en and ko strings.
- Tests: component tests following `LoreBookList.test.ts` and
  `LoreBookData.*.test.ts` (pin copies and assigns an id, release, folder
  tri-state and partial release, orphan move/delete, notices, read-only rows do
  not write); draft fence test following `localLoreDraft.fence.test.ts`. One
  e2e flow next to `e2e/readersCharacters.spec.ts` (pin, edit, reload, send
  refused after the original is deleted) if the slice's budget allows.
- Docs: characters-modules (lore editor, child links), ui-theming if a new
  shared primitive appears.

## Verification

Per slice (V1): `pnpm check`, `pnpm --silent test:agent`, affected slow tests
with `--tags-filter=slow` (upstream export/import workers in slice 1),
`pnpm check:tests` after adding tests, `pnpm --silent test:agent --e2e` for
slices touching e2e-covered UI (name the specs if selection misses them). Run
`pnpm exec prettier --write` on changed files (T4). A new regression test is
shown to fail once with its guarded line broken (V6).

Manual check after slice 4: in a real browser, pin an entry, change its text,
send and confirm the prompt (DevTool preview) shows the copy; turn it off and
confirm it is gone; delete the original and confirm the send is refused with the
fix-it message; move the orphan to the chat lorebook and confirm sending works.
