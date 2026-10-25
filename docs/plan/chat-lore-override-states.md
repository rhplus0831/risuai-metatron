# Chat Lore Override States Plan

Status: slices landed: 1 (e497efaa8), 2 (37902a9d5). Revised 2026-10-25 after a read-only GPT-6-Astra
review of the first draft and a follow-up discussion with the user; the confirmed
findings and the user's answers are folded in below.

Planned on 2026-10-25. Sources: the code at `d7c387b36` (anchors below are from
that commit; re-verify before editing) and the design discussion with the user
recorded under **Agreed decisions**. Owning guides:
[characters-modules](../structure/characters-modules.md) (the lorebook editor),
[chat-pipeline](../structure/chat-pipeline.md) (`shared/lore/overrides.ts`, activation),
[persistence](../structure/persistence.md) (chat metadata normalization),
[ui-theming](../structure/ui-theming.md) (`SegmentedControl`),
[settings-i18n](../structure/settings-i18n.md) (strings).

## Goal

Polish the chat lore override section that landed with the Chat Lore Overrides plan
(archived; `740a05d1d` for the editor):

1. The row header's "Override in this chat" checkbox label is long enough to hide
   most of the entry name in the sidebar.
2. "Off in this chat" exists only per entry, inside the expanded body of an entry
   that is already overridden. A folder cannot be turned off for a chat.

## Original code (baseline)

- **Data.** `ChatLoreOverride = { entry: loreBook; off: boolean }`
  (`shared/database.ts:628`), stored in `Chat.loreOverrides` (`:1197`). `entry` is a
  frozen full copy linked to the owner entry by `entry.id`. The server checks the shape
  (`assertLoreOverrides`, `server/src/data/chats.ts:82-99`, called from
  `normalizeChatMeta` at `:51-53`) but keeps duplicate ids in array order
  (`server/src/tests/chats.test.ts:33-40`). `normalizeChatMeta` runs on chat create,
  metadata patches, checkpoint restore, and import
  (`server/src/data/chatStore.ts:232`, `:1185`, `:1985`;
  `server/src/data/checkpointStore.ts:752`; `server/src/data/upstream/importCharacters.ts`).
- **Merge.** `mergeOwnerLore(ownerLore, overrides)` (`shared/lore/overrides.ts:10-43`)
  maps the first override per id to the first owner entry with that id, replaces the
  entry with the copy, or drops it when `off`; later overrides with a matched id are
  ignored; unmatched or id-less overrides are orphans. It returns references, never
  clones. Readers: activation (`shared/lore/activation.ts:93`), CBS `{{lorebook}}`
  (`shared/cbs/registry.ts:321`, which gives a group no owner lore at all), Lua
  `getLoreBooksMain` (`server/src/lua/bindings.ts:1495`), plugin
  `getCurrentLorebookEntries` (`src/ts/plugins/apiV3/v3.svelte.ts:1819`), and the
  section's orphan opener (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:37`).
  Orphan refusal (`server/src/jobs/loreOverrides.ts:27`,
  `src/ts/process/loreOverrides.ts:17`) goes through `orphanedOverrideEntries`.
- **Off ids.** `offOverrideIds(overrides)` (`overrides.ts:49-63`) returns the ids of
  first-per-id overrides with `off: true`, orphans included. Activation skips any
  `child` link whose id is in it (`activation.ts:94`, `:282-284`).
  `LoreBookData.svelte:64` uses it for the link notices at `:237-239` (chat `child`
  row) and `:282-284` (character tab "Always active in this chat").
  `LoreOverrideList.svelte` uses it for the override row notice (`hasOffLink`).
- **Folders.** A folder is an owner entry with `mode: "folder"` and a generated key
  `"folder:<uuid>"` (`src/ts/process/lorebook.svelte.ts:83-110`); members carry
  `folder: <key>`. Imported version-2 entries keep their fields unchecked
  (`shared/modules.ts:55`), so a folder may lack a key. Folders have no prompt content
  and activation has no folder logic: they only group entries in the editor.
- **Editor.** `LoreOverrideList.svelte` builds the owner tree by folder key with
  repeated and cyclic keys guarded (`tree`); `descendants()` (`:89-104`) returns only
  non-folder descendants. `LoreOverrideRow.svelte` shows chevron, folder icon, name
  (an expand button with `flex-1 min-w-0`, `:33-45`), the sun/link icon, and a
  `CheckInput` named `language.chatLoreOverrides.pin`. For a folder it is tri-state
  over `descendants()` and pins or releases them all; batch pinning keeps an already
  off member off (`LoreOverrideList.test.ts:308-330`). Expanding an overridden entry
  shows a second `CheckInput` (`chatLoreOverrides.off`) above the editable
  `LoreEntryFields`; an unpinned entry shows read-only fields. Pin pushes onto the
  `useLoreOverridesDraft` draft after the send fence and skips an entry that already
  has an override (`:120-130`). Release (`:131-155`) captures ids, confirms first,
  then `ensureChatLoaded`, rechecks owner token and fence, and removes only the first
  override per captured id with `setChatMeta`.
- **Strings.** `chatLoreOverrides` in `src/lang/en.ts:1674` and `src/lang/ko.ts:1138`:
  `pin` ("이 채팅에서 덮어쓰기"), `off` ("이 채팅에서 끄기"), notices, and `fixes`,
  which quotes the off label by name. `src/ts/process/serverCommands.test.ts:117`
  mocks `chatLoreOverrides`.
- **`SegmentedControl`** (`src/lib/UI/GUI/SegmentedControl.svelte`): a bindable
  `value` over `{ value, label }` options with a sliding indicator; a value that
  matches no option shows no indicator. It has no accessible group name, no
  `aria-pressed`, and a scoped `margin-bottom: 1rem`. Used by
  `SettingSegmented.svelte` and `ModelProfileEditor.svelte`; rendered in
  `src/lib/UI/GUI/guiRendering.test.ts:261-285`.
- **Tests.** `server/src/tests/lore.test.ts:100-130` (merge, orphans, `offOverrideIds`)
  and the activation cases after it; `src/lib/SideBars/LoreBook/LoreOverrideList.test.ts`
  finds the controls by `input.alt === language.chatLoreOverrides.pin|off`
  (`:119`, `:209`, `:431`); `e2e/chatLoreOverrides.spec.ts:121-123` clicks the label
  with `labels.pin`. `e2e/perChatSends.spec.ts:32-102` runs a local mock provider that
  records each provider request.

## Agreed decisions

1. **Entry rows get one three-state control** instead of the checkboxes: Original /
   Override / Off ("원본 / 덮어씀 / 꺼짐"), a compact segmented control in the header.
   "Off" moves to the header, so an entry can be turned off without pinning and
   expanding it first. The in-body off checkbox goes away.
2. **Folder rows get two buttons, On / Off ("켜짐 / 꺼짐"), plus a status indicator
   that is not a button.** The buttons change only the folder's own state; they never
   touch member overrides. The indicator shows how many overrides sit inside the
   folder, and that they do not apply while the folder (or an enclosing folder) is off.
3. **Folder off is stored on the folder**: one override for the folder entry with
   `off: true`. Merge drops every member, including entries added to the folder later.
   Turning the folder back on removes only that override, so every member returns to
   the state it had before.
4. **Bulk release lives inside the expanded folder**: a "Release all overrides in this
   folder" button with a confirmation dialog. It replaces the folder checkbox's bulk
   pin/release; bulk pinning is dropped.
5. **Duplicate overrides are removed.** A chat keeps at most one override per entry id:
   the first, which is the one merge already applies.
6. **Duplicate ids among the owner's own entries stay out of scope.** Reassigning them
   can move other chats' `child` links and overrides
   ([characters-modules](../structure/characters-modules.md) Known Hazards); pinning
   keeps today's fresh-id rule.

## Design decisions (made by this plan)

- **No schema change.** A folder off override is an ordinary `ChatLoreOverride` whose
  `entry` is a copy of the folder entry. Export/import, checkpoints, upstream
  stripping, and orphan refusal treat it like any other override. An orphaned folder
  override (folder deleted) is refused at send like any orphan and offers only delete,
  as off orphans do today.
- **Dedupe on the server.** `normalizeChatMeta` keeps the first override per
  `entry.id` after `assertLoreOverrides`, so every create, patch, checkpoint restore,
  and import stores at most one. Dropping later duplicates changes no behavior: merge,
  `offOverrideIds`, and orphan matching already ignore a later override with a matched
  id. The client never creates duplicates; data loaded before this change may still
  hold them until its next metadata write, so client code that removes an override
  removes every override with the id.
- **Membership follows the owner's current folder keys.** `mergeOwnerLore` finds the
  off folders (owner `mode: "folder"` entries matched by a first-per-id override with
  `off: true`) and takes their **owner** keys; the frozen copy's key is never used.
  Only a non-empty string key counts, and only an entry whose `folder` is a non-empty
  string equal to such a key is a member, so a keyless folder never collects ungrouped
  entries. A dropped nested folder adds its key until nothing changes (a `Set` ends
  cycles). Two folders sharing a key share members, as in `descendants()` and the
  character tab's delete cascade.
- **Off folders win over member overrides.** A dropped member's own override is not
  applied and is not an orphan, because its owner entry still exists.
- **`offOverrideIds` takes the owner lore.** New signature
  `offOverrideIds(ownerLore, overrides)`: today's ids plus the non-empty owner ids of
  every entry an off folder drops. Activation, `LoreBookData`, and `LoreOverrideList`
  pass the owner lore they already read. One internal folder walk serves both
  functions. A duplicate owner id outside the folder also loses its `child` link, the
  same ambiguity entry overrides already have.
- **Entry state and transitions.** State comes from the entry's override: none →
  `original`, `off: false` → `overridden`, `off: true` → `off`. Every write keeps
  today's guards (mounted chat key, draft key, send fence, `holdsOriginal`).
  - original → overridden: today's `pin`.
  - original → off: `pin` with `off: true`, one draft push.
  - overridden ↔ off: flip `off` on the override through the guarded `liveOverride`
    binding; the copy and its edits stay.
  - overridden/off → original: release (below).
- **Folder state and transitions.** `on` unless the folder has an override with
  `off: true`.
  - on → off: if the folder already has an override (an `off: false` one can arrive
    through data), set its `off` to `true`; otherwise pin the folder entry with
    `off: true`, assigning a fresh id when missing or duplicated, as `pin` does.
  - off → on: remove the folder's override entirely, without confirmation (a folder
    copy holds no edits). Members are untouched.
  - Nested folders have their own On / Off and are never changed by a parent's buttons.
- **Folder indicator.** Counts the overrides inside the folder: overridden or off
  entries among all descendants, plus nested folders that are off. Hidden at zero.
  Shows "{n} changed" ("수정 {n}"); while the folder or an enclosing folder is off it
  also shows "not applied" ("적용 안 됨"). It is text, not a control, and the row's
  state group references it through `aria-describedby`. Members of an off folder also
  get `folderOffNotice` under their header, and their names stay dimmed.
- **Bulk release.** In the expanded folder body, above the members, a button
  "Release all overrides in this folder" ("이 폴더의 덮어쓰기 모두 해제"), shown when
  the indicator count is above zero. It releases every override the indicator counts
  (entries and nested folders, not the folder's own state), always confirming with
  the count, through the release flow below.
- **Release flow** (entry → original and bulk release share it):
  1. Capture the chat ref, owner token (`chatOwnerToken`), and the target ids; return
     on a fenced chat.
  2. `ensureChatLoaded`, then read the captured chat and its owner lore by the captured
     `chaId` (not the current selection); recheck the owner token and fence.
  3. Collect every override with a target id. An entry release confirms only when one
     of them differs from its owner entry (`JSON.stringify` of the
     `$state.snapshot`); a folder's own override never counts as an edit. Bulk release
     always confirms.
  4. After any confirmation, read the chat again, recheck owner token and fence, and
     write only if the collected overrides are unchanged (same JSON); otherwise write
     nothing, so the user decides again on the new state.
  5. One `setChatMeta` removing all collected overrides.
- **A declined change** (fence refusal, cancelled confirm, changed data) leaves the old
  segment selected: the control's getter rederives from the draft or chat.
- **Body.** Overridden and off entries keep the editable `LoreEntryFields`; the off
  checkbox above it is removed. Folders expand to the bulk release button and members.
- **Header layout.** Two parts that wrap: `[chevron][folder icon][name]` and
  `[sun/link][state control][indicator]`. The name part gets a minimum width (about
  8rem, `basis` plus `grow`) so the control wraps to its own line before the name
  shrinks below it; check in both English and Korean at the narrowest sidebar.
- **`SegmentedControl` changes**, backward compatible: optional `label` (group
  `aria-label`, `role="group"`), optional `describedBy`, `aria-pressed` on each button,
  and a `margin` prop (default `true`) that gates the scoped bottom margin. Function
  bindings (`bind:value={get, set}`) carry the guarded writes.
- **Accessible names.** The group label includes the row name:
  `stateFor(name)` ("{name}: state in this chat" / "{name}: 이 채팅에서의 상태").
- **Strings** (en / ko), under `chatLoreOverrides`:
  - entry segments `original` "Original" / "원본", `overridden` "Override" / "덮어씀",
    `off` "Off" / "꺼짐" (replaces the old `off`); folder segments `on` "On" / "켜짐"
    and `off`.
  - `stateFor(name)`, `changed(n)`, `notApplied`, `folderOffNotice` ("This folder is off
    in this chat" / "이 채팅에서 폴더가 꺼져 있습니다"), `releaseAll`,
    `releaseAllConfirm(n)`, and a one-line section `hint` explaining that states apply
    only to this chat and an off folder also covers entries added later.
  - Remove `pin`; update `offNotice`, `linkOffNotice`, and `fixes` to name the "Off"
    state; update the `serverCommands.test.ts` mock if it lists removed keys.
- **Out of scope:** module lore, a marker in the character tab for overridden entries,
  an off control for chat-local lore, refreshing an off copy from its original when it
  is turned back on, and duplicate owner ids (decision 6).

## Slices

Run in order; slice 2 builds on slice 1's signature.

### 1. Folder off in the merge, off ids, and dedupe (_small_)

- `shared/lore/overrides.ts`: the internal off-folder walk; `mergeOwnerLore` drops
  off-folder members; `offOverrideIds(ownerLore, overrides)` adds their ids. Keep the
  no-mutation, reference-returning contract and update the JSDoc.
- Callers: `activation.ts:94`, `LoreBookData.svelte:64`, `LoreOverrideList.svelte`
  (`offIds`), each passing the owner lore it already reads.
- `server/src/data/chats.ts`: `normalizeChatMeta` keeps the first override per id.
- Tests:
  - `server/src/tests/lore.test.ts`: direct and nested members dropped; two folders
    sharing a key; a key cycle ends; a keyless folder and the empty-string folder drop
    no ungrouped entry; the owner's current key wins over the frozen copy's key, and a
    member moved into or out of the folder after the folder was turned off follows the
    owner; a member override inside an off folder is neither applied nor orphaned;
    only the first owner folder per id counts; an `off: false` folder override leaves
    members; an orphaned folder override is reported and drops nothing;
    `offOverrideIds` includes member ids; activation keeps a `child` link to an
    off-folder member inactive, including one with `@@activate`. One reader check with
    a single-character chat (not a group: CBS gives a group no owner lore).
  - `server/src/tests/chats.test.ts:33-40`: duplicates now collapse to the first per id
    on write; plus one import or checkpoint restore case if it does not share the path.
- Docs: chat-pipeline `overrides.ts` and child-link bullets; persistence (the dedupe);
  cbs-rendering, scripts-triggers, and plugins-mcp only if their wording now misleads.

### 2. State controls in the override editor (_medium_)

- `SegmentedControl.svelte`: `label`, `describedBy`, `aria-pressed`, `margin`.
- `LoreOverrideRow.svelte`: entry and folder controls, indicator, `folderOffNotice`,
  bulk release button, header layout; remove both `CheckInput`s. Props replace
  `toggle`/`all`/`some` with a state, a setter, and the indicator count.
- `LoreOverrideList.svelte`: state derivation, transitions, the folder walk for the
  indicator (including nested folder overrides, unlike `descendants()`), the release
  flow, the section `hint`.
- Strings in `en.ts` and `ko.ts`; rg for `chatLoreOverrides.pin` and `.off` users.
- Tests (`LoreOverrideList.test.ts`), with segment helpers replacing the checkbox ones:
  - entry: original → off in one write; overridden ↔ off keeps edits; original
    removes every override with the id (seed a duplicate); release confirms only when
    edited, decided after the chat loads; an edit landing during the dialog aborts the
    write.
  - folder: off adds one folder override and leaves member overrides; on removes only
    it and every member returns to its previous state; an existing `off: false`
    folder override flips to off; a nested off folder is untouched by the parent's
    buttons and counted by its indicator; an empty folder can turn off; member notice
    and "not applied" while off.
  - bulk release: confirms with the count and releases entries and nested folder
    overrides but not the folder's own state.
  - fence refusal and cancel leave the old segment selected; the existing chat-switch
    test seeds an edited override so its deferred dialog still appears.
  - `guiRendering.test.ts`: `aria-pressed` and the margin flag.
- e2e (`e2e/chatLoreOverrides.spec.ts`): pin through the segment. Add one folder case
  with the local mock provider pattern of `e2e/perChatSends.spec.ts`: turn a folder
  off, send, and check the provider request lacks the member's content while an
  always-active entry outside the folder is present; turn it on, send again, and see
  the member return.
- Docs: characters-modules (editor, notices, tests, the folder checkbox description),
  ui-theming `SegmentedControl` entry.

## Verification

- V1 gates: `pnpm check`, `pnpm --silent test:agent`, `pnpm check:tests` after test
  changes, and `pnpm --silent test:agent --e2e` with `chatLoreOverrides`.
- Manual: in the narrowest sidebar, a long entry name stays readable beside the
  control in English and Korean; turn a folder off, add an entry to it in the
  character tab, send, and confirm the new entry is absent from the prompt; turn the
  folder back on and confirm an edited member's override applies again and an off
  member stays off.
