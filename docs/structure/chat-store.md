# Chat Store: Chat Module, Write Protocol, Checkpoints

## Scope

- Owns the chat module and write protocol, its view of server jobs (locks, stream buffer, and hydration), chat field
  drafts, checkpoints, and the client side of the restore floor.
- Not here: save loop, conflicts → [resource sync](resource-sync.md); live updates → [live updates](live-updates.md);
  chat journal, recovery drafts → [draft recovery](draft-recovery.md); database model, records →
  [persistence](persistence.md); server chat store, checkpoint service → [server resources](server-resources.md); the
  send → [chat pipeline](chat-pipeline.md); the checkpoint dialog → [UI and theming](ui-theming.md).
- `Decision:` plan names resolve through [the archive](../archived-plan/README.md).

## Files

Module headers and export comments hold the contracts; these lists give lookup identifiers.

- `src/ts/storage/chatStore.svelte.ts`: chat membership, loaded chats and summaries; boot reads summaries only. Readers:
  `chatList`, `chatEntry`, `selectedChat`, `currentChatRef`, `selectedChatLoad`, `findChat`, `chatCount`,
  `countChatEntries`, `chatSummaryList` (read-only plugin summaries).
- Loads and pins: `ensureChatLoaded`, `loadChat`, `loadChats`, `pinChat`, `pinChats`, `trimLoadedChats`,
  `MAX_LOADED_CHATS`, `CHAT_READ_DEADLINE_MS`. Boundaries: `withChatsCopy`, `withCompatChats`, `seedChats`,
  `assembleChats`, `initializeChats`, `startChatDriftCheck` (dev only).
- Writers: `createChat`, `ensureChat`, `deleteChat`, `reorderChats`, `selectChat`, `appendMessage`, `replaceMessage`,
  `patchMessage`, `setMessageText`, `setMessageTranslation`, `selectCandidate`, `removeMessages`,
  `removeMessagesUnasked`, `restoreUnsentRemoval`, `setChatMeta`, `mergeChatMeta`, `replaceChat`, `captureChatBaseline`,
  `applyChatResult`, `reconcileCharacterChats`, `installChatProjection`. Versions: `chatSaveVersion`,
  `chatInstallVersion`, `chatHasUnackedWork`.
- Save-loop side: `takeChatWork`, `ackChatWork` (the acknowledged floor: `ackedRevisions`, `belowAckedRevision`),
  `requeueChatWork`, `recoverChatConflicts` (`reanchorGoneAppends`, `dropLockedEdits`), `acceptRemoteChat`,
  `acceptRemoteCollection`, `quarantineChat`, `unloadPendingChatWork`, `hasUnsavedChatWork`, `hasRefusedChatWork`,
  `refusedChatItems`, `retryRefusedChat`, `discardRefusedChat`, `finishIdleChatRefresh`, `noteIdleChatRead`,
  `idleChatRefreshes`, `idleSummaryRefreshes`, `settleSummaryRefresh`.
- Live updates and jobs: `noteRemoteChat`, `applyRemoteSummary`, `applyRemoteCollection`, `canApplyRemoteCollection`,
  `noteRemoteStreaming`, `replaceFeedLocks`, `markChatStale`, `applyServerGeneration`, `applyServerGenerationChunk`,
  `heldStreamText`, `endServerJob`, `hydrateChat`, `hydrateChatPatch`, `chatHydrationHold`,
  `prepareChatHydrationRefresh`, `deferredReloads`, `finishDeferredReload`.
- `src/ts/storage/chatEdits.ts`: `editChat` (may await), `editChatSync`, `editCurrentChat`, `setCurrentChatMeta`, over a
  whole chat copy; `readChatsDetached` serves `src/ts/storage/exportAsDataset.ts` and `src/ts/characters.ts`;
  `readChatRefsDetached` serves plugin `getDatabase` and `getChats` via `withDetachedDatabaseChats` in
  `src/ts/plugins/apiV3/v3.svelte.ts`.
- `src/ts/storage/chatFieldDraft.svelte.ts` (`createChatFieldDraft`, `loreWriteFenced`),
  `src/ts/storage/{localLoreDraft.svelte,loreOverridesDraft.svelte}.ts`: the editing copies of a selected chat's array
  fields and their send fence.
- `src/ts/checkpoints/chatCheckpoints.svelte.ts`: checkpoint client (module header). `chatCheckpointsDialog` opens from
  `SideChatList.svelte`; while `checkpointLoadBusy`, the dialog disables its controls and `hotkey.ts` swallows shortcuts
  behind it and keeps Escape from closing it.
- `src/ts/network/jobChannel.ts`: `rememberHydration`, `rememberJobStreaming`, `endJobChannel`, and the callback barrier
  (its module header); chat installation stays in `chatStore.svelte.ts`.

### Last chatted

- `characterLastChattedAt`'s JSDoc holds derived activity rules. `applyPluginCharacter` preserves frozen
  `lastInteraction` for same-character setters; imports and new characters keep their input.
  `ChatEntryMeta.lastMessageAt` is derived, never written.

### Pins and eviction

- `pinChat` and `pinChats` return a release, counted per owner lifetime; pin before awaiting a load. `trimLoadedChats`
  runs after a load, a pin release, every save cycle, and every selection change (`scheduleTrim`).

### Locks and streaming

- The lock readers count this tab's job locks and the [feed's](live-updates.md#feed-locks); `isCharacterStreamedHere`
  counts this tab's only, so the list read recovery of `hydrate` (`refreshCharacter` in `resourceSync.svelte.ts`) waits
  on it without blocking an observing tab, and a flush depending on that read rejects with `GenerationBlockedError`. A
  conflict's acceptance of the character is [immediate](resource-sync.md#conflicts). A character's permanent deletion
  and different-id replacement refuse locally on `isCharacterGenerating` (`characterStore.svelte.ts`).

### Character lifecycle

- `adoptCharacter`, `installCharacterChats`, `settleCharacterDelete`, `ackCharacterDelete`, `forgetCharacter`,
  `forgetCharacterChats`: each comment states what it queues, settles, keeps, or retires (`parkedResends`,
  `retireCharacterGroups`). `characterStore.svelte.ts` calls them around its add, replace, and delete.

## Flows

Only sequences crossing a module, process, or tab are here; one inside `chatStore.svelte.ts` is its entrypoint's
comment.

### Chat writes

- Every write updates the mirror, bumps the chat's local version, and queues an op; the save loop
  ([resource sync](resource-sync.md)) sends a chat's unsent ops as one group (`takeChatWork`, `coalesce`: a
  generation-bearing op never coalesces, so every generation fence holds). An op's `before` is the
  [chat journal's](draft-recovery.md#chat-journal). A direct write of a chat fails `pnpm check` (STRUCTURE D1).

### By-id ops

- By-id reads and writes share `positionOf`'s index with translation and the transcript (`heldMessageById`,
  `messagePositionOf`); its comment owns stale lookups, `dropMessagePositions` invalidates it.
- Which ops apply on a stale revision and which need the current one is the `ChatOp` contract in `shared/chats.ts`,
  enforced by the server ([chat writes](server-resources.md#chat-writes-and-checkpoints)) and the
  [restore floor](#restore-floor). A `remove` may carry `retract`,
  [a person's yes](structured-memory/lifecycle.md#retraction-and-edits).
- A result on an older revision says `stale: true` and sets the acknowledged floor (`ackedRevisions`); an edit of a
  message another writer removed answers `missing` and is kept as a recovery draft through the conflict listener
  ([resource sync](resource-sync.md#conflicts)); an `append` whose anchor is gone is re-anchored and resent alone
  (`reanchorGoneAppends`), and everything else takes the ordinary [recovery](resource-sync.md#chat-and-order-conflicts).
- A refused `selectCandidate` (stale `candidatesRevision`, gone candidate, not the newest reply) reads `refused` in
  `selections` and marks the chat stale.
- An idle re-base can refresh a send still building its prompt without a lock: its baseline protects changes made
  meanwhile ([chat pipeline](chat-pipeline.md)).

### Map merges

- `mergeChatMeta` and `applyChatResult` send map fields (`CHAT_META_MERGE_KEYS`) entry by entry, as do the
  single-variable writers `setChatVar`/`setChatVarOf` for one `scriptstate` entry; the server applies `merge` and
  `mergeUnset` onto its stored map, validates `chat.toolCalls` entries wherever a chat is written, and stores the whole
  map again with no eviction ([server resources](server-resources.md)).

### Stored translations

- `Message.translation` shows only while its `sourceHash` matches (`storedTranslation`, [translation](translation.md)).
  Tab edits go through `saveStoredTranslationEdit`, the server runner writes the translations it makes, and
  `setMessageTranslation` is the one op that changes it on an existing message.

### Selection

- `selectChat` and `loadSelectionPreference` own selection persistence; `selectedChatLoad` drives loading/error/retry
  ([UI](ui-theming.md)).

### Summaries and refresh

- A live update reaches `noteRemoteChat` ([chat live updates](live-updates.md#chat-live-updates)): a loaded chat takes a
  fitting body, an unloaded member its summary (`applyRemoteSummary`), everything else asks for the character's list.
  Whole-chat reads are for loaded chats only (`idleChatRefreshes`); a server copy never loads a chat.
- The refresh queue in `resourceSync.svelte.ts` reads summary lists for live list updates, for characters a recovery
  inserted or refreshed (`hydrate`: what the server's list has no room for is discarded with the notice), for characters
  an acknowledgement showed another writer's chats of (`listRefresh`, keeping a queued reorder), and for idle stale or
  noticed unloaded chats (`idleSummaryRefreshes`, `settleSummaryRefresh`).

### Whole-chat writers

- Plugin setters, `chatEdits.ts`, and the reroll paths capture a baseline and call `applyChatResult`;
  `reconcileCharacterChats` takes a plugin's whole list ([plugins](plugin-sandbox.md)). A structured chat's `hypaV3Data`
  is a projection the mirror holds and no send carries:
  [the rules](structured-memory/projection.md#the-hypav3-projection).
- A `createChatFieldDraft` copy is fenced by `loreWriteFenced` over `localSends` and `generatingChatKeys`, also before
  structural override actions; the job's Lua lorebook upsert writes from the stored chat
  ([scripts](scripts-triggers.md)).

### Deferral

- A conflict on a chat this tab's job streams into is deferred until the job's locks release (`deferredReloads`,
  `finishDeferredReload`); `reloadDeferredChats` in `resourceSync.svelte.ts` shows the notice only when a chat was
  replaced or removed. A group refused for a generating message is not deferred:
  [generating refusals](resource-sync.md#generating-refusals), `JOB_RETRY_MS`.

### Job chunks

- Generation updates, frame flushes, and job hydration share the [by-id index](#by-id-ops); a stream shares one build.
- A chunk (`GenerationChunkEvent`) that `applyServerGenerationChunk` cannot apply asks `resyncReply` once per follow
  until an `accepted` arrives or the follow ends (`network/generationJobs.ts`); the job answers only its current
  full-text `accepted` while live with a message id, also during a lock handoff
  ([server generation](server-generation.md)). The recovery never marks stale or asks for the whole chat.
- `runServerJob` (`process/serverCommands.ts`) saves and reads a chat it knows is behind (`refreshStaleChat`, true once
  `isChatBehind` is false) before creating a job, once more when a change or notice arrived meanwhile; a chat still
  behind goes as it is and the server refuses its old revision ([chat pipeline](chat-pipeline.md)).

### Job hydration

- A job's `resource` event goes through `hydrateChat` and a `chatPatch` through `hydrateChatPatch`
  (`network/generationJobs.ts`). A `streamed` row gets this job's buffer text if that generation's buffer reached its
  `seq` (`resolveJobChatPatch`), else the patch is a `mismatch` keeping revision and watermark. On `mismatch`,
  `applyGenerationEvent` sends the follow's one `resync`, cleared by the job chat's next whole `resource` event.
- On `busy`, or a whole job chat refused for local work, `generationJobs.ts` waits for `flushResources`, then sends the
  `resync` if the chat is still stale and `chatHydrationHold` is `none`; a failed save or new local work retries with a
  growing wait (up to 15 s) while the follow lasts, one recovery per follow. Work no save settles asks nothing, nor does
  a follow whose job ended or that closed.

### Callback hydration

- The barrier is the module header of `jobChannel.ts`. Under the job socket's `hydration=patch` a receipt may name a
  revision this tab received as a patch or never received; `prepareChatHydrationRefresh` permits the one fenced read,
  and `applyHydration` installs it with the held `streaming` list, never an empty one made up.

### Server memory writes

- A job and the detached memory task ([memory](memory.md): `mergeHypaV3Write`, `mergeHypaV3SelectionWrite`) write
  `hypaV3Data` one summary at a time, each a `meta` set built in one synchronous step from the value stored then, and a
  job's selection last. A refused merge skips that write.
- A task commits only while its input is current, checked at every write: the epoch (`ResourceEpochError` ends it), the
  admitted revision (`context.chatRevision`, sent as `baseRevision`: `meta` applies on a stale revision of the same
  chat, while a chat recreated under the same ids conflicts), and the source generation.
- The source generation (`chatSourceGeneration`, `readChatSource`) changes once inside the commit of a chat delete, a
  whole-chat `replace` by any writer, or a character cascade delete, never for `meta`, `append`, `setText`, `create`, or
  `remove`. `onChatInvalidated` notices follow the commit, never a rollback, and cancel the chat's task. A job reads it
  with the chat's snapshot (`loadJobScope`/`refreshChat`) and hands nothing off when it moved.
- The HypaV3 modal, a whole-field writer, is fenced from a task's start or queueing until the mirror holds its
  `terminalRevision` (`memoryTasks.svelte.ts`), a newer incarnation or a gone chat counting as reached. A read refused
  for pending local work does not advance it; a disconnect, a `hello`, and time keep it; a null `terminalRevision` sets
  no fence.

### Chat checkpoints

- The client protocol (request, preparation, and answer rules) is the module header of `chatCheckpoints.svelte.ts`; the
  server side is [chat writes and checkpoints](server-resources.md#chat-writes-and-checkpoints). The HypaV3 modal and
  the local lore draft follow a loaded chat's external replacement without writing it back.

### Restore floor

- A load's `replace` sets the floor to its replacement revision. `server/src/data/chatStore.ts` `applyGroup` checks:
  remembered `groupId` (replay), possibly expired retry (`reason: "expired"`), generation locks
  (`reason: "generating"`), then for a non-null base: chat existence, token validity/epoch, incarnation `seq`, base
  below the floor, and `needsCurrent` revision equality. Revision/floor conflicts have no `reason`. A null base requires
  an absent chat and existing character.
- `reason: "generating"` makes `recoverChatConflicts` retry work after `JOB_RETRY_MS` without reloading, except named
  locked-message edits, dropped with the reload notice. A floor conflict reads back; `acceptRemoteChat` replaces the
  mirror and discards queued edits with the notice, `flushResources` reports `chats/<chaId>/<chatId>`, and a chat this
  tab's job streams into [defers](#deferral).
- Old work is refused only while its base is below the floor, so nothing moves that base past it (`installRead` holds no
  revision for a busy chat; `acceptRemoteCollection` keeps a create's replay and the old base of later edits).
- One by-id case takes two rounds: an `append` whose `after` anchor the load removed keeps epoch and incarnation
  (`replace` keeps `seq`), so `reanchorGoneAppends` rewrites it and resends alone with a new `groupId` on its old base.
  The floor refuses it again; recovery finds no gone anchor and discards it with the notice.

## State

- Per chat: revision, `absentChats`, unsent and in-flight ops, local version, job locks, deferrals, refused intent (with
  object identity fencing an asynchronous discard). Per character: selection, chat order revision, refused order.
- Refusal reads use the module's own counter and local projections without changing state. Forgetting a character
  removes its refusal entries; session alert guards survive release and recreation.
- `pinned` is stored as sent and summarized only when `true`. First-party UI keeps it only while pinned and clears it on
  copy, branch, and import; creation, plugin reconciliation, and remote acceptance preserve it.

## Coupling

- The chain is in [resource sync](resource-sync.md#coupling). `characterStore.svelte.ts` installs and adopts a
  character's chats, `network/generationJobs.ts` delivers job events, `process/serverCommands.ts` starts jobs and
  recovers lost follows.
- `Chat.svelte` renders a chat's rows again on `chatSaveVersion`; `transformClient.ts` and `settledRender.svelte.ts`
  read `chatInstallVersion` and `chatHasUnackedWork` ([CBS rendering](cbs-rendering.md)).

## Invariants

- Chats are their own records: two tabs editing different chats, or different messages of one chat, save independently.
  A chat change never rewrites its character.
- Only `chatStore.svelte.ts` writes the chats; writing, defining, or deleting `chats`/`chatPage` on a character wrapper
  throws. A changed copy goes through `applyChatResult` or `chatEdits.ts`, a chat field through `setChatMeta`, a map
  entry through `mergeChatMeta`, and some fields of a message through `patchMessage`.
- A writer outside the tab merges a whole memory field onto the value stored at the write
  ([Server memory writes](#server-memory-writes)).
- A message being generated is changed only by its generation; other writers get an error from the module. `Chat.svelte`
  disables its controls from `isMessageLocked` and checks every affected id again at the write, which also covers a
  finished reply whose final write is unacknowledged and a previous group speaker's reply. Reroll and chat deletion
  check `isChatGenerating` and alert `chatGenerating`.

## Recipes

- A new chat writer follows [Invariants](#invariants); other recipes are in [persistence](persistence.md#recipes).

## Tests

- Focused: `pnpm --silent test:agent chatStore resourceSyncChats chatCheckpoints`.
- `src/ts/storage/tests/{chatStore.test.ts,resourceSyncChats.test.ts}` use
  [`StoreBackedServer`](resource-sync.md#tests).
- `src/ts/checkpoints/tests/checkpointServer.ts` wraps that store with the real checkpoint service and controls load
  admission, commit, and lost answers; its policy routes use the real service too.
- `slow`: `src/ts/storage/tests/resourceSyncHydration.test.ts`, patches on a chat longer than a call's argument list.
- `e2e`: `e2e/lazyChats.spec.ts` (`pnpm test:e2e`), lazy loading in the whole stack.
- Not tested: the client's two-round gone-anchor repair after a checkpoint load
  (`src/ts/storage/tests/resourceSyncChats.test.ts` exercises it for another cause); checkpoint preparation after a
  conflicting reorder is reported by `markOrderDiscarded`. `src/lib/Others/ChatCheckpointsDialog.test.ts` mocks the
  client module.

## Known Hazards

### Issues

- Folder moves touch the character (`chatFolders`), the chat (`folderId`), and the chat order, each saved on its own. A
  conflict on one can leave a `folderId` naming no folder of its character. No repair clears it, on boot or later; an
  explicit write still can (a move, a plugin's chat copy without it, a branch with "Create Folder on Branch", deleting a
  folder of that id).

### Limitations

- `CHAT_READ_DEADLINE_MS` bounds one `readRefs` call, not a whole load: a load can make three passes of 500-chat calls
  plus a summary list read. Decision: U1, [durable drafts audit](../manual-audit/durable-drafts-2026-10-29.md).
- A same-id recreation reconciles only the chats this client knows: a chat another tab created survives, and a reused
  id's `replace` on a changed base conflicts through the usual 409 path, with eligible content captured as a recovery
  draft. Explicit recreation releases old chat refusals, so they do not hold the reorder. Decision: reconciliation can
  delete only chats this client knows (`chatStore.svelte.ts` re-add reconciliation).
- A same-id re-add after a failed or generating-refused deletion reconciles like one before the deletion was sent: a
  whole `replace` per reused chat, also for an undo; a replace of a chat the job still locks waits behind its retry
  block (the flush rejects until then). Decision: Durable Drafts Out of scope (no server create tombstone), archive.
- A deletion whose answer was lost and that landed is not known as such: a same-id re-add conflicts or meets a missing
  parent, and the recovery removes it with the notice. Another writer deleting a character between the conflict read
  that adopts its lost create and the summary-list read leaves no order to learn; that refresh ends. Decision: Durable
  Drafts Out of scope (no server create tombstone), archive.
- A stored chat row without `fmIndex` is not backfilled: a summary reads `-1`, a whole read can omit it. Decision:
  formats metatron created during its own phases are owed no migration
  ([compatibility rule](persistence.md#invariants)).
- A callback can fail as `barrier` while the job channel dispatcher loads (`onChannel`): a job's chat event moves
  `jobMetadata` at once and `rememberJobStreaming` waits on the socket-ordered chain, so a callback from that chain can
  find metadata newer than its list, and the read is refused. The send ends with its job error: the hook did not run,
  what the job stored stays, and sending again works. Decision: a barrier that cannot show its `streaming` list is
  current fails instead of installing a read with an older one, which could retire live generations (`jobChannel.ts`
  `recoverJobChat`).

### Gotchas

- `selectedChat()` and `findChat` return the live read-only chat: take `$state.snapshot` before handing it to code that
  mutates. A snapshot or spread of a character has no chats: build the legacy shape with `withChatsCopy`.
- `SideChatList.svelte` renders a chat whose `folderId` names no folder at the root as unfiled (`chatFolderOf`) and
  keeps the id: a drop at the root does not remove it, a move into a folder replaces it. The pinned rail and the modal
  chat list do not group by folder.
- A job's membership changes are not hydrated on its socket; they reach every tab through the live updates.
- An observing tab sees a job's reply at its 3 s checkpoints, then the final text; a disconnected tab catches up at the
  reconnect's reconcile.
- A character wrapper's read-only `chats` view builds a fresh array on every read: read one chat through `findChat`, not
  by scanning `chats` in a loop ([observation](../audit/chat-scan-observations-2026-10-24.md)).
- `installRead` treats an incomparable revision as older, `adoptChatRead` as not older; only fixtures with tokens like
  `r1` reach the difference.
