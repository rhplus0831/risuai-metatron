# Phase 2: Chat Resource And Mutation API

Status: not started.

Depends on: Phase 1. Implements the Phase 2 parts of Decisions 3 and 4 in `PLAN.md`.

## Objective

Make chats their own server resource and route every chat write through an explicit client
mutation module, so the server knows messages, a chat change no longer rewrites its whole character,
and chats can be loaded lazily.

## Required Work

- **Schema.** `character.chaId`, `Chat.id`, and `Message.chatId` become required. The character
  and chat id assignment in `assignIds` (`src/ts/bootstrap.ts`) and the message-id assignment that
  today happens in the send pipeline both move into the server normalizer, which also
  de-duplicates message ids within a chat. `character.chats` becomes an ordered id list. Each
  chat's metadata is a `characters/<chaId>/chats/<chatId>` resource with one revision, and its
  messages are rows keyed by (chat id, message id) with an order key and data, in the same
  database. `isStreaming` and `activeStreamingDisplayOptimizationMode` leave the persisted schema
  (`setDatabase` already resets them on load), and a client-local streaming store replaces them for
  `Chats.svelte`.
- **Selected chat.** The selection becomes a per-client chat id instead of the persisted
  `chatPage` index, so a reorder or deletion on another client cannot move it. Until Phase 6 the
  mirror derives `chatPage` from that id, so its readers keep working.
- **Client mutation module.** A new module beside `database.svelte.ts` exposing `createChat`,
  `deleteChat`, `reorderChats`, `appendMessage`, `replaceMessage`, `setMessageText` (streaming),
  `removeMessages`, `setChatMeta` (note, localLore, scriptstate, modules, bindedPersona, fmIndex,
  memory data, bookmarks, folder), and `replaceChat` for trigger and Lua results that return a whole
  clone. Each call updates the `DBState.db` mirror and enqueues an operation with the revision;
  writes coalesce per chat. Operations that address one unlocked message by `Message.chatId`
  apply against a stale revision as long as the message exists, and `setChatMeta` is a per-field
  merge that does the same; `replaceChat`, reordering, and bulk removal require the current
  revision. Whole-chat results from triggers and Lua are diffed against the chat they started from
  and applied as by-id operations, with `replaceChat` only for changes a diff cannot express. No
  operation addresses a message by index. This phase switches chats to explicit mutations
  (invariant 2).
- **Generation lock.** The message being generated is locked against editing from the first chunk
  until its last persistence step, including the asynchronous inlay. In this phase the lock is a
  client rule: the edit, delete, and regenerate controls for that message are disabled. Checkpoints
  carry the generation id.
- **Streaming persistence.** The client still generates in this phase. `setMessageText` checkpoints
  the whole text so far every three seconds, at stream end, and on abort, independent of the 125 ms
  display flush; the durability promise is the last acknowledged checkpoint. On `pagehide` the
  client tries a `fetch` `keepalive` flush, with the whole text only under the 64 KiB keepalive
  budget and otherwise the suffix since the last acknowledged checkpoint; it is best effort.
  Checkpoints hold what the mirror holds today: the `editoutput` result, or the pre-`editoutput`
  text in the strong streaming display mode. The reply persists at stream end, after the output
  trigger, and after inlays, keeping today's two orders (the streaming path runs the output trigger
  before inlays, the non-streaming path runs inlays first). The streaming loop stops holding
  `msgIndex` and addresses the reply by id. Abort and a crash keep the last committed text.
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
- **Eager loading stays.** The client still loads every chat's messages. Lazy loading waits for
  Phase 6, because dataset export, chat export, the plugin chat getters, and the MCP read tools walk
  every chat through the mirror.
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
- Edits to other messages and to chat metadata during a streaming send do not conflict with the
  checkpoints, the generating message cannot be edited, and deleting an earlier message during the
  stream does not redirect the reply.
- Killing the tab mid-stream leaves the reply text up to the last checkpoint, with no persisted
  streaming flag.

## Validation

Unit tests for the mutation module, server tests for the chat resource and the message-operation
revision rule, a `command.ts` test for
`/cut` and `/del`, a manual send, reroll, and reload check recorded in the phase file, and
`pnpm check`, `pnpm test`, `pnpm format:check`.
