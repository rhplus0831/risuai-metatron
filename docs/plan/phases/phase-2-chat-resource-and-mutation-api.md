# Phase 2: Chat Resource And Mutation API

Status: implemented on 2026-09-29 in three review rounds; see Implementation Record.

Depends on: Phase 1. Implements the Phase 2 parts of Decisions 3 and 4 in `PLAN.md`.

## Objective

Make chats their own server resource and route every chat write through an explicit client
mutation module, so the server knows messages, a chat change no longer rewrites its whole character,
and chats can be loaded lazily.

## Required Work

- **Schema.** `character.chaId`, `Chat.id`, and `Message.chatId` become required. The character
  and chat id assignment in `assignIds` (`src/ts/bootstrap.ts`) and the message-id assignment that
  today happens in the send pipeline both move into the server normalizer, which also
  de-duplicates message ids within a chat. `character.chats` becomes an ordered id list
  (implemented as a separate chat order record per character with its own revision). Each
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
  budget and otherwise nothing (amended: no suffix form, see `PLAN.md` Decision 4); it is best
  effort.
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
  list every assignment, `push`, and `splice`. Two-way `bind:` sites do not surface as errors
  (svelte-check does not check the bound target as an assignment), so they are found with a binding
  and alias inventory (`rg` over `bind:` plus the aliases that hold a chat, its messages, or its
  memory data), and a dev-only drift detector logs any change of the selected character's chats
  that did not come through the module.
- **Retire the chat watcher.** Chats leave the save adapter's selected-character watcher (the Phase 1
  successor of the `changeTracker.chat` handling in `saveDb`); the watcher stays for the character's
  own fields until Phase 6.
- **Eager loading stays.** The client still loads every chat's messages. Lazy loading waits for
  Phase 6, because dataset export, chat export, the plugin chat getters, and the MCP read tools walk
  every chat through the mirror.
- **Docs.** `docs/structure/chat-pipeline.md` `State` (the pipeline no longer mutates in place and
  relies on autosave), `docs/structure/persistence.md`, and the D4 invariant.

## Safety Contract

Message content and order are never lost: every write path either goes through the mutation module,
fails the type check, or is listed in the binding inventory and routed; the dev drift detector
reports anything missed. Reroll history in `src/ts/process/prereroll.ts` stays in memory as today.
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

## Implementation Record

Implemented on 2026-09-29 from a plan reviewed by GPT-6-Astra (34 points, 11 open decisions) and
evaluated by Claude Fable (22 adopted, 12 adopted with changes, none rejected), in three rounds, each
challenged by Astra and reviewed by Fable (Fable fixed the edge cases the challenges found and wrote
the tests). Slices:
[`slices/phase-2-chat-resource-and-mutation-api/`](slices/phase-2-chat-resource-and-mutation-api/).

- **Server chat store.** `shared/chats.ts` is the wire contract (chat ops `create`, `delete`,
  `replace`, `meta`, `append` at the start, the end, or after a message, `setMessage`, `setText`,
  `remove`, `begin`; groups, results, conflict entries). `server/src/data/chatStore.ts` keeps the
  `chats`, `messages` (one row per message, integer positions), and `chatOrders` tables in the
  resource database (schema version 2; version 1 is refused with a message naming the file). One
  batch applies resources, chat groups, and reorders in one transaction and lists every conflict.
  Whole-chat and destructive ops are compare-and-set on the chat revision; ops that address one
  message by id (and per-field meta) apply to an older revision while that message exists and report
  `stale`. A generation fence (`begin`, checkpoints with an increasing sequence, a final write)
  answers `applied`, `duplicate`, or `ignored` and remembers eight finished generations per chat.
  Validation errors raised while applying name `chats[i].ops[j]`. Snapshots, restore, and archives
  carry chats.
- **Client chat module.** `src/ts/storage/chatStore.svelte.ts` is the only writer of
  `character.chats` and `chatPage` (read-only on the shared type through `DeepReadonly`). Writes are
  addressed by `ChatRef {chaId, chatId}` and message id and queued per chat (coalesced; sent work is
  immutable until acknowledged; a lost create is resent whole). `captureChatBaseline` +
  `applyChatResult` turn a changed copy of a chat into by-id ops (three-way merge). A reply is locked
  from its append (a continue from its start), checkpointed every 3 s, and stays locked until its
  final write is acknowledged; the lock is reactive for the chat screen. Chat selection is per tab
  (`chatPage` derived). `resourceSync.svelte.ts` sends the module's work in the resource batch,
  splits 409s by kind, quarantines a chat whose group the server refuses with a 400, and defers a
  generating chat's reload until the generation ends. On `pagehide` a keepalive request sends the
  generating messages' whole texts within 60 KiB, through the loop's bookkeeping.
- **Pipeline and writers.** A send captures its chat (`chatTarget`) before any await and passes it to
  everything it calls (CBS, regex scripts and their cache key, Lua, triggers, lore, modules, persona,
  request triggers, commands, output listeners); a chat deleted mid-request cancels the send before
  its output hooks. Every UI editor, trigger, Lua function, command, plugin setter, and importer writes
  through the module or `chatEdits.ts`; display and request triggers run on a copy. New characters'
  chats have ids at creation.

Recorded behavior changes:

- A reply is locked from its append until its final write is acknowledged (a moment after the send
  returns); its edit, partial edit, delete, disable, and regenerate controls are disabled meanwhile.
  Reroll and chat deletion alert `chatGenerating`; other refused writes show the error alert.
- A chat being generated in cannot be deleted or replaced, and a generating character cannot be
  permanently deleted; the last chat of a character cannot be deleted.
- Continue keeps the message id and locks the message when it starts.
- Chat selection is per tab; the stored preference is read at boot only.
- A stale destructive chat op (chat delete, bulk removal) after another tab's edit conflicts and
  reloads that chat with the notice; by-id edits of other messages still land.
- A chat whose ops the server refuses as invalid is quarantined with one alert; everything else keeps
  saving.
- Streaming flags are no longer stored; the pagehide flush sends whole texts within 60 KiB or
  nothing, so the last acknowledged 3 s checkpoint is the durable promise.
- Plugin setters reconcile chats by id; `setChatToIndex` diffs against the current chat; a change to
  the generating message skips that chat with a warning; a generating character is kept when omitted
  and not replaced by another `chaId`; a list with duplicate `chaId` values is refused; a character
  without `chaId` gets one at once; plugin output listeners get indices resolved per listener.
- Display and request triggers run on a copy of the chat. Auxiliary LLM calls from triggers and Lua
  run request triggers on the caller's chat. Lua `editDisplay` may still write chat variables
  (upstream behavior kept).
- `/cut N` removes that message (upstream replaced the list with the removed element); `/multisend`
  refuses to start during a send, clears the busy flag after each segment, and stops at a failure; a
  command line whose chat is deleted meanwhile writes nothing.
- A group preview stops after the first speaker; a strong-mode abort skips the deferred `editoutput`
  post-processing.
- Imported, copied, and branched chats get new chat ids and keep message ids.
- Server API: `GET /api/resources?...&chats=1` returns `{refs, chats, chatCollections}`; the batch
  body is `{ops, chats, chatOrders}`; a 409 body lists resource, chat, and chat order conflicts; a
  character record carrying `chats` is refused.

Known limits: triggers and command lines are not atomic (effects before a refused write stay
applied, as upstream's did); a folder move spans the character, the chat meta, and the order, so a
conflict on one can leave them inconsistent until reload; plugin character setters still accept
malformed entries; after a back-forward-cache restore with an unload answer outstanding,
`flushResources` can reject if the answer is slower than its cycles.

Review, round 1 (server chat store): Astra challenged three times (7, 2, then no finding). Six bugs
were fixed by Opus (a `begin` replay reopening a finished generation, a conflict plus a dependent
reorder becoming a permanent 400, the conflict body shape, an order conflict returning a rolled-back
token, `replace` erasing replay protection, an evicted-history replay reopening a generation). Fable
fixed three edge cases with tests (restored message positions, the revision counter bound, order
sequence validation); verdict no problem.

Review, round 2 (client module and save loop): Astra challenged six times (16, 6, 3, 2, 1, then no
finding). Opus fixed 26 bugs in the queue, create retries, conflict and order recovery, deferral,
quarantine, and flush accounting. Fable fixed two edge cases with tests (more than 5,000 queued ops
in one chat, a split batch's reorder base) and reported one problem (a refused `meta` op without the
`chats[i]` prefix blocked every save), which Opus fixed in round 3.

Review, round 3 (pipeline and writers): Astra challenged ten times (13, 6, 4, 6, 3, 0 before Fable's
review; 3, 3, 2, 0 after it). Opus fixed the send-context propagation across recursion, hooks,
triggers, Lua, lore, modules, persona, commands, and plugins; the continue lock at start; the
strong-mode abort; plugin character guards; and replaced a selection hold with full context
propagation. Rejected: making Lua `editDisplay` stop writing chat variables (an upstream behavior card
scripts may rely on), a copy-of-the-chat view for CBS and lore inside triggers (a parser redesign),
and two "silent refusal" findings (the global rejection handler already shows them; executed in the
app). Fable fixed two edge cases with tests (the pagehide write's bookkeeping after a
back-forward-cache restore, the lock identity of a branched chat) and reported three problems (reroll
not gated by the lock that outlives the send, new characters' chats without ids until the next save,
deleting a generating chat without an alert), fixed by Opus with the residuals Fable listed; Fable's
follow-up review of those fix passes found no problem.

Tests: server `chats.test.ts`, `chatStore.test.ts`, `resourcesChats.test.ts`, and additions to the
backup and snapshot tests; client `chatStore.test.ts`, `chatLock.svelte.test.ts`,
`resourceSyncChats.test.ts` (over `storeBackedServer.ts`, the real store behind a fetch stand-in),
`command.test.ts` (`/cut`, `/del`, and the other commands), and plugin host API guard tests.

Validation on 2026-09-29, final tree: `pnpm check` 0 errors, 0 warnings (server `tsc` included);
`pnpm test` 57 files, 584 passed, 3 skipped; `pnpm build` passes; `pnpm format:check` passes. Manual
checks with the client in headless Chrome (DevTools protocol) against a test server and a slow mock
provider, run by Opus and re-run by Fable: sends in each streaming display mode save the reply and
hold the lock while other messages and chat meta are edited; deleting an earlier message during a
stream does not redirect the reply; abort, continue, back-to-back continues, reroll, a non-streaming
send, `/del`, `/cut`, and `/multisend` work; a reload shows the replies and an idle reload writes
nothing; killing the tab mid-stream keeps the text up to the last checkpoint with no streaming flag;
two tabs, a group send, chat branch, rename, reorder, and delete, and a backup export and import
survive a reload; Lua output triggers merge with concurrent edits and display hooks write nothing; a
send, its CBS, and its Lua hooks follow their chat when the selection moves mid-send; a branched
chat's copy of the generating message stays editable; a reply's controls stay disabled until its
final write is acknowledged. Docker (fresh volume): a streaming send saved, chats reloaded after
`docker restart`, and a backup round trip.
