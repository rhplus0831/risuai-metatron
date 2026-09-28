# Phase 2: Chat Resource And Mutation API

Status: not started.

Depends on: Phase 1. Confirm the streaming persistence Open Decision first.

## Objective

Make chats their own server resource and route every chat write through an explicit client
mutation module, so the server knows messages, a chat change no longer rewrites its whole character,
and chats can be loaded lazily.

## Required Work

- **Schema.** `character.chaId`, `Chat.id`, and `Message.chatId` become required; the id assignment
  in `assignIds` (`src/ts/bootstrap.ts`) becomes part of the server normalizer. `character.chats`
  becomes an ordered id list, and each chat is a `characters/<chaId>/chats/<chatId>` resource.
  `chatPage` follows the selection-state Open Decision.
- **Client mutation module.** A new module beside `database.svelte.ts` exposing `createChat`,
  `deleteChat`, `reorderChats`, `appendMessage`, `replaceMessage`, `setMessageText` (streaming),
  `removeMessages`, `setChatMeta` (note, localLore, scriptstate, modules, bindedPersona, fmIndex,
  memory data, bookmarks, folder), and `replaceChat` for trigger and Lua results that return a whole
  clone. Each call updates the `DBState.db` mirror and enqueues a resource write with the revision;
  writes coalesce per chat; streamed text is persisted on completion plus checkpoints.
- **Write sites to route.** From the write-path map: in `src/ts/process/index.svelte.ts`,
  `runCurrentChatFunction`, `throwError`, the message-id normalization, the response push and the
  streaming `message.data` writes, the `isStreaming` flags, the memory data persistence
  (`hypaV2Data`, `hypaV3Data`, `supaMemoryData`, `lastMemory`), the output trigger and inlay
  writes, and the `generationInfo` writes; `src/ts/process/command.ts` (`send`, `sendas`, `comment`,
  `cut`, `del`, `multisend`, `setvar`, the manual trigger); the `@@inject` write in
  `src/ts/process/scripts.ts`; `v2SetVar`, `v2SetAuthorNote`, and the final scriptstate copy in
  `src/ts/process/triggers.ts`; the live edit-hook chat in `src/ts/process/scriptings.ts`;
  `src/ts/parser/chatVar.svelte.ts`; local lore creation and import in
  `src/ts/process/lorebook.svelte.ts`; `src/ts/process/files/multisend.ts`; `src/ts/process/group.ts`;
  the plugin `setChar`, `setCharacterToIndex`, `setChatToIndex`, and `sendChat` host functions; the
  UI files `Chat.svelte`, `DefaultChatScreen.svelte`, `ChatList.svelte`, `SideChatList.svelte`,
  `CharConfig.svelte`, `CustomSidebar.svelte`, `Toggles.svelte`, `DevTool.svelte`,
  `ModuleChatMenu.svelte`, `BookmarkList.svelte`, `Suggestion.svelte`, the `LoreBook/` editors,
  `HypaV3Modal.svelte` and its children, and `AlertComp.svelte`; and the importers `importChat`,
  `characterFormatUpdate`, and `createBlankChar` in `src/ts/characters.ts` and the card converters in
  `src/ts/characterCards.ts`.
- **Find writers mechanically.** Type the mirror's chats as deeply readonly and let `pnpm check`
  list every assignment. Confirm on one component that two-way `bind:` sites surface as errors before
  relying on this for the UI files.
- **Retire the chat watcher.** Remove the `changeTracker.chat` handling from `saveDb`; the character
  watcher stays for the character's own fields until Phase 6.
- **Lazy loading.** The client loads chat summaries per character and the full message list for the
  selected chat. The `chatLoadInitialPages` and `chatLoadAdditionalPages` paging stays a UI concern.
- **Docs.** `docs/structure/chat-pipeline.md` `State` (the pipeline no longer mutates in place and
  relies on autosave), `docs/structure/persistence.md`, and the D4 invariant.

## Safety Contract

Message content and order are never lost: every write path either goes through the mutation module
or fails the type check. Reroll history in `src/ts/process/prereroll.ts` stays in memory as today.
Group chats keep working, since group members reference characters by `chaId`. The `/cut` defect
flagged during planning (the single-index branch assigns the result of `splice` back to the message
array) is fixed as part of routing `command.ts`, with a test.

## Exit Criteria

- No direct assignment into `chats[...]` or a `Message` remains outside the mutation module.
- A streaming send persists the final message; a reload after a send shows the reply; reroll,
  continue, and group sends work.
- Deleting a chat, branching, and reordering survive a reload.
- Chat load for a character with many chats fetches only summaries plus the selected chat.

## Validation

Unit tests for the mutation module, server tests for the chat resource, a `command.ts` test for
`/cut` and `/del`, a manual send, reroll, and reload check recorded in the phase file, and
`pnpm check`, `pnpm test`, `pnpm format:check`.
