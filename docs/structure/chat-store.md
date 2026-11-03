# Chat Store: Chat Module, Write Protocol, Checkpoints

## Scope

- Owns the chat module and write protocol, its view of server jobs (locks, stream buffer, and hydration), chat field
  drafts, checkpoints, and the client side of the restore floor.
- Not here: save loop, conflicts, live updates → [resource sync](resource-sync.md); chat journal, recovery drafts →
  [draft recovery](draft-recovery.md); database model, records → [persistence](persistence.md); server chat store,
  checkpoint service, floor checks → [server resources](server-resources.md); the send →
  [chat pipeline](chat-pipeline.md); the checkpoint dialog → [UI and theming](ui-theming.md).
- `Decision:` plan names resolve through [the archive](../archived-plan/README.md).

## Files

- `src/ts/storage/chatStore.svelte.ts`: the chat module. Per character it holds the chat ids in order (the membership)
  and each chat loaded or as its summary, reactively. The initial resource snapshot carries summaries only; plugins or a
  resumed job may load their targets during startup. Writers not named below: `createChat`, `ensureChat`, `deleteChat`,
  `reorderChats`, `selectChat`, `loadSelectionPreference`, `setMessageText`, `removeMessages`, `removeMessagesUnasked`,
  `captureChatBaseline`, `forgetCharacterChats`.
- `src/ts/storage/chatEdits.ts`: `editChat` (may await), `editChatSync`, `editCurrentChat`, `setCurrentChatMeta`, over a
  whole chat copy. The [field drafts](#whole-chat-writers):
  `src/ts/storage/{chatFieldDraft.svelte.ts,localLoreDraft.svelte.ts,loreOverridesDraft.svelte.ts}`.
- `src/ts/checkpoints/chatCheckpoints.svelte.ts`: the checkpoint client. `chatCheckpointsDialog` is a writable
  `ChatRef | null` here, outside `stores.svelte.ts`, opened from `SideChatList.svelte`. The read-only
  `checkpointLoadBusy` holds a load from before its flush until its refresh ends: the dialog disables its controls, and
  `hotkey.ts` swallows shortcuts behind it and keeps Escape from closing it.
- `src/ts/network/jobChannel.ts`: remembers job record and streaming hydration for callback barriers; chat installation
  remains in `chatStore.svelte.ts`.

### Readers

- `chatList(chaId)`, `chatEntry(ref)`: `ChatListEntry` rows, loaded or not, reactive over the list fields and the
  membership only, never a `Chat`.
- `selectedChat()` is null at home and while the chat loads; `currentChatRef()` also names a loading chat;
  `selectedChatLoad()`/`retrySelectedChatLoad()` are the screen's loading and error state.
- `pinned`, a user pin, is stored as sent and summarized only when `true`. First-party UI keeps it only while pinned and
  clears it on copy, branch, and import; creation, plugin reconciliation, and remote acceptance preserve it.

### Last chatted

- `characterLastChattedAt(chaId, fallback)` returns the newest finite time among each loaded chat's final message by
  position and each unloaded chat's summary `lastMessageAt`; an empty chat or undated final message contributes nothing,
  so deleting dated messages can move a character back. A finite stored `lastInteraction` is only the fallback when no
  chat supplies a value (else 0): that frozen field is never in the maximum, written, or migrated.
- `lastMessageAt` is not writable, survives summary ingestion, whole-chat copies, and eviction, and is never overlaid
  from a pending summary onto a loaded chat.
- `withChatsCopy` fills a positive derived `lastInteraction`. `applyPluginCharacter` preserves the stored field, absence
  included, for same-character setters; imports and new characters keep their input.

### On-demand reads

- `ensureChatLoaded(ref)`: a chat not in the list resolves to `undefined` without a read. `loadChat(ref)`: a loaded chat
  is re-read under the idle refresh's safeguards; one not in the list reads and applies the summary list first.
  `loadChats(chaId)`: every member, `LOAD_CHUNK` per request; rejects when the list stays incomplete.
- A load never completes with a copy older than the held revision: it reads again up to `MAX_LOAD_READS` times, then
  rejects. A reset of the character's chats (`chatOwnerToken`) ends it with nothing. Concurrent loads of a chat share
  one read.
- Local work on an unloaded chat keeps its summary over the read and its held base revision, so a read cannot move
  pre-restore metadata past the [restore floor](#restore-floor); the chat stays marked for an idle refresh.
- Each read request (`deadlineChatRead`) aborts after `CHAT_READ_DEADLINE_MS` (60 s) and rejects with
  `chatLoadTimedOut`; the shared load drops, so the next request reads again.

### Pins and eviction

- `pinChat(ref)`, `pinChats(chaId)` return a release, counted per owner lifetime. Pin before awaiting a load.
- `trimLoadedChats()`, scheduled after a load, a pin release, every save cycle, and every selection change, keeps
  `MAX_LOADED_CHATS` idle loaded chats, evicting the least recently used to summaries (revision and version kept). Never
  evicted: selected, pinned (or of a pinned character), pending or in flight, deferred, quarantined, retry-blocked,
  generating, streaming, stale or noticed, or not saved yet.

### Boundaries

- `withChatsCopy`: a detached legacy character with its chats, for plugin snapshots and hook arguments; throws unless
  every chat is loaded.
- `withCompatChats` and the records' `setCharacterChatView`: the legacy shape for the shared CBS evaluator, the loaded
  chats and the selected chat's index among them, -1 when it is not loaded.
- Boot: `seedChats`, `assembleChats`, `initializeChats`, `startChatDriftCheck` (dev only).

### Locks and streaming

- `isMessageLocked`, `isChatGenerating`, `isCharacterGenerating`, `lockedChatKeys()` count this tab's job locks and the
  [feed's](resource-sync.md#feed-locks). A character's permanent deletion and different-id replacement refuse locally on
  `isCharacterGenerating`.
- `isCharacterStreamedHere` counts this tab's job locks only: the list read recovery of `hydrate` waits on it
  (`refreshCharacter`) without blocking an observing tab, and a flush depending on that read rejects with
  `GenerationBlockedError`. A conflict's acceptance of the character is [immediate](resource-sync.md#conflicts).
- `isMessageStreamed`: a locked message whose generation streamed (a chunk of this tab's job, or a feed announcement
  with `seq` above 0), not a whole reply's lock or a continue's `accepted`. It tells streamed replies from whole ones.

### Render versions

- `chatSaveVersion(ref)` moves when the client first holds a revision for a chat (a first save landed or a landed create
  was recognized; not the boot seed or a restore): `Chat.svelte` renders its rows again, since a row rendered before had
  no server transform context.
- `chatInstallVersion(ref)` moves when `ackChatWork` empties the work (not a stale acknowledgement that only marks a
  refresh) and on every installed copy (a patch or job hydration only of another revision); never on local edits or
  stream chunks.
- `chatHasUnackedWork(ref)` counts pending, in-flight, quarantined, deferred, and job-blocked work. `transformClient.ts`
  and `settledRender.svelte.ts` read both ([CBS rendering](cbs-rendering.md)).

### Character lifecycle

- `adoptCharacter` gives a character added or swapped in its chat and message ids and queues its chats' creates at once,
  so they are addressable and journaled before the save loop collects it; they wait in `takeChatWork` until the
  character is known on the server or created in the same batch.
- `installCharacterChats`: for a character removed and added again before the server acknowledged its deletion (unsent,
  in flight, failed, or refused for a generating message), held revisions stay and it queues the reconciliation by chat
  id (deletes, `replace` for a reused id, creates, a reorder) for the batch that updates the character. A reused id
  whose old delete is in flight is created after it settles.
- `settleCharacterDelete` (this tab's deletion collected) settles the chats' work, keeps held revisions, and parks per
  character (`parkedResends`) every resend whose group may have landed. A same-id re-add restores them in front of its
  reconciliation, group ids and payloads intact, so a landed create is recognized.
- `ackCharacterDelete` forgets the chat state; for a character added again, every chat becomes a create that goes with
  the character's own, and queued deletes and the reorder settle.
- `forgetCharacter`: `discard` (another writer's deletion) reports unsent and in-flight work and a queued reorder as
  discarded, but a queued delete it fulfils settles. It and `ackCharacterDelete` retire the character's in-flight groups
  (`retireCharacterGroups`): their obligation settles, and a late answer changes nothing and never holds a deleted
  chat's revision.

### Chat lists

- `applyRemoteCollection` (a live list update; `canApplyRemoteCollection`: no order work pending or in flight) ignores
  an order older than the held one, keeps busy and never-saved chats, removes idle chats the server no longer has, and
  queues nothing. A list lacking a held chat whose revision changed during the read, busy or not, is read again; a list
  the update would empty is left as it is; an empty list on both sides holds its order, so this client's chat is saved.
- `keepPendingOrder` (the refresh after an acknowledgement) keeps a pending reorder: this client's order first, chats
  new to it after, the new order revision held. If a kept chat with a held revision is missing from the list, the
  reorder is discarded with the notice and reported as `chats/<chaId>`.
- Both list paths (`acceptRemoteCollection` too) mark a kept chat with a held revision the list lacks, and a held chat
  whose delete is unacknowledged, as gone from the server's order (`absentChats`): reorders, create indices, and order
  acknowledgements leave them out until a list places the chat, an acknowledged create's answer lists it, or its
  revision drops.
- `acceptRemoteCollection` and `forgetCharacter` return whether they discarded anything; `recoverChatConflicts` returns
  `{ reloaded, refresh, refreshOrders, blocked }`, `reloaded` deciding the reload notice. A reorder's discard is keyed
  by the character id alone, as its obligation is.

### Save adapter side

- `hasUnsavedChatWork`: unsent or in-flight work a save can settle. `hasRefusedChatWork`: refusals that protect page
  close. `refusedChatItems`: the reactive chat/order inventory. `retryRefusedChat`, `discardRefusedChat`: the adapter's
  refusal API.
- `finishIdleChatRefresh` takes `chatNoticeSeq` from before the read: a notice that arrived during it keeps its mark.

## Flows

### Chat writes

- Every chat write updates the mirror, bumps the chat's local version, and queues an op. Ops of one chat coalesce (text
  writes, meta patches, end appends) under one pending batch id until dispatch; text and message folds need both ops
  without a generation, so a generation-bearing op never coalesces and every generation fence holds.
- An op's local `before` holds what it overwrites ([Chat journal](draft-recovery.md#chat-journal)).
- An unloaded chat takes only `setChatMeta` of `SUMMARY_FIELD_TYPES` fields (summary changed, same `meta` op queued);
  every other write needs it loaded. A never-sent chat's create group is the current mirror payload alone.
- Client character types have no `chats` or `chatPage` and readers' chats are `DeepReadonly`, so a direct write fails
  `pnpm check`. `bind:` on a chat field does not: bind through getter/setter pairs or a synced editing copy.
- `restoreUnsentRemoval`, the reroll's rollback ([chat pipeline](chat-pipeline.md)), withdraws the last pending `remove`
  of exactly those messages only if no op follows it, puts them back after the anchor, and marks the chat stale: a
  removal committed before a lost response disappears again on read-back.

### By-id ops

- Ops address messages by `Message.chatId`, never by index. `append`, `setMessage`, `patchMessage`, `setText`,
  `setTranslation`, single `remove`, and `meta` apply to a stale revision while their message exists, with a base at or
  above the [restore floor](#restore-floor). `replace`, `delete`, bulk `remove`, reorders, and a `begin` of an unknown
  generation need the current revision.
- `remove` may carry `retract`, [a person's yes](structured-memory/lifecycle.md#retraction-and-edits): under Structured
  Memory `removeMessages` asks first and may remove later.
- `setMessage` sends the whole row, so on a stale revision it reverts fields another writer changed: it needs the
  current revision for fields it does not own (not enforced).
- `patchMessage` (`set`/`unset` onto the stored row, never the translation) is the op for some fields: it sends every
  given field and queues nothing when no field is left. `coalesce` folds it with a later patch or `setText` and into an
  earlier `setMessage`.
- A result applied on an older revision says `stale: true`. `ackChatWork` and `settleUnloadWork` keep the older base,
  request an idle re-base, and record the result's revision as the acknowledged floor (`ackedRevisions`): until the held
  revision reaches it, no read, job copy, list, or patch below it is installed (`belowAckedRevision`), since it lacks
  this tab's edit. `installRead` reads again, `hydrateChat` takes it as busy, and the list paths keep the stale mark.
- An edit (`setText`, `setMessage`, `patchMessage`, `setTranslation`) whose message another writer removed answers
  `missing` (`ChatGroupResult.targets`) while the rest of its group commits. `ackChatWork` settles it as a no-op (no
  discard report or notice), keeps those ops as a recovery draft through the conflict listener, and marks the chat
  stale, so the idle read removes the message. Newer queued edits of it are sent and answer `missing` again.
- An `append` whose `after` anchor is gone still conflicts: `reanchorGoneAppends` rewrites each gone one, in the refused
  group and newer unsent work, to `{ end: true }`. The group retries alone on its base as the chat's resend, with a new
  id and no discard or notice, also while this tab's job streams; the chat is marked stale, so the idle read restores
  the server's order. Newer work follows in its own group, and only what conflicts there is discarded.
- Only by-id work on the same chat incarnation whose conflict is not `reason: "expired"` re-anchors. A group with
  `create`, `delete`, `replace`, multi-id `remove`, or `begin`, a recreation queued behind it, or no gone anchor takes
  the ordinary [recovery](resource-sync.md#chat-and-order-conflicts).
- The idle re-base rechecks `canRefreshChat` after its read and refuses an older copy, then applies the server copy and
  revision with no discard or notice; otherwise the mark stays. A send still building its prompt without a lock can be
  refreshed: its baseline protects changes made meanwhile.

### Map merges

- A `meta` op's `merge` adds entries to a map field (`CHAT_META_MERGE_KEYS`) on the server's stored value: writers
  adding different entries keep each other's, and a named entry is last writer wins. `mergeUnset` removes entry ids as
  stored before the entries are added; removals alone leave a non-map field as it is.
- `mergeChatMeta(ref, key, entries, removals)` queues it, sending a removal also when the mirror lacks the entry.
  Single-variable writers (`setChatVar`/`setChatVarOf`) queue one `scriptstate` entry this way.
- A whole-field set or unset replaces. `coalesce` may fold a merge into an earlier set of the field, but folds no op
  carrying `mergeUnset`, nor entries into a field an earlier op sets to a non-map.
- `chat.toolCalls` entries are validated wherever a chat is written. The map has no eviction, and every merge normalizes
  and stores the whole map again.

### Stored translations

- `Message.translation` ([translation](media-aux.md)) shows only while its `sourceHash` equals
  `translationSourceHash(data)` (`storedTranslation`), so an edit makes it stale without clearing it.
- On an existing message only `setMessageTranslation` changes it: op `setTranslation`, never coalesced. The input is
  checked as its JSON copy, and a hash that does not match the current text is not taken and returns false. Tab edits go
  through `saveStoredTranslationEdit`; the server runner writes the translations it makes.
- `createChat`, `appendMessage`, and `replaceChat` take in what their messages carry; `replaceMessage` keeps the held
  translation, as the server's `setMessage` does. `prepareMessages` drops a `translation` that is not a
  `MessageTranslation`, as `normalizeMessage` does, and `canonicalChat` compares without one.

### Selection

- Per tab and per character: the selection falls back to the first chat only when a membership change removes it (a
  reorder keeps it; a read never writes it), and is remembered in `localStorage` for the next boot, not synchronized
  between tabs.
- A selection is immediate, loaded or not, and starts the selected chat's load; the chat screen shows loading, then the
  error and a retry after a failed load. A load never selects anything.

### Summaries and refresh

- `noteRemoteChat`: a held chat at an older revision is read again once idle (`canRefreshChat`: no pending or in-flight
  work, generation of this tab, deferral, quarantine, or unexpired retry block). A notice at or below the held revision
  drops, then and once this client holds it another way. A chat the mirror lacks of a held character asks for the list.
- A loaded chat takes the entry's [fitting patch or delta](resource-sync.md#chat-live-updates). An unloaded member
  settles without a list read (`applyRemoteSummary`) when the entry is newer than the held revision and not below the
  acknowledged floor and the chat is idle and not stale: a `summary` naming that chat and revision replaces the held
  one, a `summaryBase` equal to the held revision keeps it. Only the summary and revision change, and the notice
  settles. A load in flight is not refused: `installRead` reads again when older.
- Every other entry takes the list (`noteRemoteChat` answers `"collection"`): neither field, another `summaryBase`, a
  deletion, an id not held, a reconnect's listing.
- The refresh queue reads summary lists (`chatSummaryCollections`) for live list updates, for characters a recovery
  inserted or refreshed (`hydrate`: what the server's list has no room for is discarded with the notice), for characters
  an acknowledgement showed another writer's chats of (`listRefresh`: keeps a queued reorder), and for idle stale or
  noticed unloaded chats (`idleSummaryRefreshes`, `settleSummaryRefresh`).
- Whole-chat reads are for loaded chats only. A server copy never loads a chat: an unloaded member takes the summary and
  revision, a job's chat event included; a loaded chat a list shows newer keeps its copy and held revision and is marked
  stale.

### Whole-chat writers

- Plugin setters, `editChat`/`editChatSync`, and the reroll paths capture a baseline and call `applyChatResult`: the
  copy is diffed three ways against the baseline and the chat as it is now and applied as by-id ops, so others' changes
  stay.
- A changed message becomes a `patchMessage`. A `CHAT_META_MERGE_KEYS` map goes entry by entry through `mergeChatMeta`:
  a map the baseline lacked counts as empty, and a map the copy dropped as emptied, its baseline entries removed one by
  one, never the whole field.
- `replaceChat` applies only what a diff cannot express (reordered survivors, on an unchanged chat with no generation;
  else the order change drops with a warning). Message patches are checked before the mirror changes: an invalid one (an
  unset `data`, a role neither `user` nor `char`) refuses the whole result. `reconcileCharacterChats` takes a plugin's
  whole list ([plugins](plugins-mcp.md)).
- A structured chat's `hypaV3Data` is a read's projection, which the mirror holds and no send carries (`sendChat`,
  `keepsHeldHypaV3Data`). A plugin read's refresh replaces it with no write (`installChatProjection`):
  [the rules](structured-memory/projection.md#the-hypav3-projection).
- `createChatFieldDraft`: an independent, lazily started `{ value, key }` editing copy of a selected-chat array field.
  Synchronization reads without writing; nested edits save through the supplied `setChatMeta` writer.
- `loreWriteFenced(ref)` (over `localSends` and `generatingChatKeys`, also checked before structural override actions):
  while fenced, edits alert `chatGenerating` and revert, never replayed when the fence drops.
- `localLoreDraft` uses the factory for `localLore`, keeping its deep editor bindings and send fence: the job's Lua
  lorebook upsert writes from the stored chat. `loreOverridesDraft` uses it for `loreOverrides`: syncing never adds the
  optional field, and override orphan moves update both fields atomically through `setChatMeta`.

### Deferral

- A conflict on a chat this tab's job streams into (`isChatStreamedHere`: job locks, not feed locks) is deferred: the
  chat leaves batches and reloads (`deferredReloads`, `finishDeferredReload`) once the job's locks are released, since
  an earlier replacement would drop the streamed text. That reload discards its local work, as any conflict does;
  `reloadDeferredChats` shows the notice only when a chat was replaced or removed.
- A group refused for a generating message is not deferred
  ([Generating refusals](resource-sync.md#generating-refusals)): only work surviving the drop is blocked until
  `JOB_RETRY_MS` (`chatJobRetryAt`), and an all-dropped group is not.

### Job chunks

- `applyServerGeneration` locks the message for the job and writes the text into the mirror: nothing queued, the
  revision unmoved, an older `seq` dropped.
- `GenerationChunkEvent`: keep the first `keep` UTF-16 units of the raw stream text at `base` and append `text`.
  `applyServerGenerationChunk` reconstructs from `serverGenerations`, never the displayed message, which may lag a frame
  or show a processed checkpoint.
- A chunk without its lock, on a placeholder, of another generation or sequence, or with an unusable `keep` asks
  `{ type: "resyncReply" }` once per follow until an `accepted` arrives or the follow ends; the job answers only its
  current full-text `accepted` while live with a message id, even during a lock handoff. Retired generations and
  messages the mirror lacks drop silently. This recovery never marks stale or asks for the whole chat.
- The mirror takes one stream update per frame (`heldStreamText`): a generation's first, and one with no flush pending,
  write at once; a later one stays in the buffer and the flush writes the newest by the same lock, retirement, and
  watermark rules. `hydrateChat` first flushes its chat's held updates and `endServerJob` its job's, so later events
  apply in order. A timer beside the frame request shows the text in a hidden tab.
- The streaming state (`streamingEntry`, `isStreamingMessage`, `setStreamingState`) follows the lock, one entry per
  chat: a generation's first `accepted`/`chunk`, not a placeholder lock, sets it to its message with
  `settings.ui.streamingDisplayOptimizationMode ?? "off"`, and every release of that generation's lock clears that entry
  only. A later generation in the chat takes it over; a job in another chat leaves it alone.

### Server generation jobs

- A reply's lock can precede its `accepted`: the job's chat hydration listing it as `streaming` (a reply appended with
  `begin`) locks it with a sequence below every protocol sequence and the mirror's text as buffer, so the first
  `accepted` records the raw text whatever its claim, and a chunk asks for the reply.
- While locked no client generation id passes, and edit, delete, and regenerate are off. The lock lasts until its chat's
  hydration stops listing it or the job's terminal event. A replaced or ended generation is retired: its late chunks
  drop.
- `endServerJob(jobId)` releases the job's locks, marks a chat still holding streamed text for an idle refresh, and
  wakes the loop even when it released no lock. `markChatStale(ref)` marks a held chat whether or not a job locks it
  (after a lost or gone follow, [chat pipeline](chat-pipeline.md)); false for a chat it does not hold.
- `runServerJob` saves and reads a chat it knows is behind (`refreshStaleChat`, true once `isChatBehind` is false)
  before creating a job, trying once more when a change or notice arrived meanwhile. A chat still behind goes as it is,
  and the server refuses its old revision.

### Job hydration

- `hydrateChat` (a chat `resource` event) replaces the mirror's chat when its revision is at least the held one, the
  chat has no pending, in-flight, deferred, quarantined, or blocked work, and the copy is not below the acknowledged
  floor; otherwise the chat is marked for an idle refresh. It writes the mirror directly: no `ensureChat`, discard,
  settle, or queued op. A chat the mirror lacks or this client has not seen on the server is not hydrated.
- `hydrateChatPatch` (a job's `chatPatch`, through `applyPatchHydration`) also needs a loaded, non-stale chat holding
  exactly the patch's `baseRevision` or `revision`, in one epoch and incarnation: a patch is a diff of two stored
  states, so any other held revision may lack a change it does not carry. `patchedTail` checks the whole result first
  and reads only the list's end.
- Otherwise a patch marks the chat stale and wakes the save loop: `busy` for local work, `mismatch` for the rest. On
  `mismatch` `applyGenerationEvent` sends the follow's one `resync`, cleared by the job chat's next whole `resource`
  event.
- On `busy`, or a whole job chat refused for local work, it waits for `flushResources`, then sends it if the chat is
  still stale and `chatHydrationHold` is `none`. A failed save or new local work retries with a growing wait (up to 15
  s) while the follow lasts, one recovery per follow. Work no save settles (deferred, quarantined, job-blocked) asks
  nothing, nor does a follow whose job ended or that closed.
- An event's `streaming` entries give each still-generating message's generation and the newest chunk `seq` the copy
  holds (a watermark): streamed text above it is put back, text at or below is older than the copy (a processed
  checkpoint stays). Every other lock of that job in the chat is released, as is another owner of a listed message;
  another job's locks stay.
- A copy older than the held revision, or job metadata older than the newest taken for the chat (even from a copy that
  could not be applied), changes nothing. A copy that could not be applied releases locks but sets no watermark.
- An idle read that takes while a later one of the chat is out (`readIdleChats`, `noteIdleChatRead`) leaves the stale
  mark, so the later copy (a job's end) takes too instead of failing the stale-or-noticed gate.

### Callback hydration

- `rememberHydration(jobId, record)` (`jobChannel.ts`) keeps the newest copy per record, and `rememberJobStreaming` the
  job's newest `streaming` list for its chat, socket-ordered. `barrier` retries the remembered copies after flushing
  local work; job patches are not remembered. `endJobChannel(jobId)` deletes both on every terminal or lost follow,
  after its socket-ordered remembers.
- Under the job socket's `hydration=patch` a receipt may name a revision this tab received as a patch or never received.
- If the job chat's receipt (`targets.chatRef`) is not held after the retry, `prepareChatHydrationRefresh` permits one
  whole read of that chat, also one streamed by this tab, fenced at the newer of the receipt's revision and the reused
  `streaming` list's.
- After the read a held receipt needs no adoption. Otherwise the callback must be live, the epoch, chat owner, and
  incarnation unchanged, and the remembered copy, held `streaming` list, and accepted job metadata unsuperseded. The
  copy goes through `applyHydration` with that list, never an empty one made up (with none, nothing is read), rechecking
  local work and the floor and queuing nothing.
- Every receipt must be held at least as new as listed; an acknowledgement alone is never held state. A failed read or
  admission fails the barrier.

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

- Requests use `authFetch`; mutations send `RESOURCE_EPOCH_HEADER` and check `assertSaveAdmission` in `beforeDispatch`,
  so none is dispatched after a halt. A failure before dispatch returns `not-sent`/`admission`.
- A 412 `EpochMismatch`, or an answer naming another epoch, throws `epochMismatch(epoch)`, running the restore halt: a
  checkpoint answer's throw reaches the caller; inside the flush or refresh it is caught there after the halt.
- Save and load share preparation: refuse `generating` while `isChatGenerating(ref)`, or `refused` while
  `refusedItems()` names this chat or its character's order; `await flushResources()`; stop with `discarded` if it
  reports `chats/<chaId>/<chatId>` or `chats/<chaId>`; recheck both refusals. A `GenerationBlockedError` becomes
  `generating`, with `noticeShown` when `generatingNoticeCount()` moved so the caller does not show `chatGenerating`
  twice; another flush failure becomes `saveFailed`.
- `saveCheckpoint` checks `busy` only at entry. `loadCheckpoint` refuses `busy` while `checkpointLoadBusy`, holds that
  guard through preparation and refresh, takes `heldChatRevision(ref)` after preparation (`null`: `unsaved`), and sends
  one `POST /api/chat-checkpoints/load` with it as `chatBaseRevision`.
- On 200 it re-reads through `loadChat(ref)`. `loaded` requires that the refresh did not throw, the answer's
  `chatRevision` is well-formed, and the held revision compares equal or newer. Every other 200 is `refresh-pending`.
- A 409 `generating` returns without a refresh. A 409 with a string `error` and a null or string `revision` re-reads and
  returns `conflict`, so the caller may retry. 400/404/413 return `invalid`/`missing`/`tooLarge`. A malformed 409, a
  network failure after dispatch, a 5xx, or any other answer re-reads and returns `unknown`; a failed refresh leaves the
  outcome intact.
- Never resend a lost load answer: another load could apply the replacement twice.
- Rename, delete, and `writeCheckpointPolicy` skip the flush preparation. Rename and delete send the row's `revision` as
  `baseRevision` (409 for a stale row). `readCheckpointPolicy` returns `unavailable`, never an off policy, for an absent
  route, a non-JSON answer, or an invalid policy.
- The HypaV3 modal and local lore draft follow the loaded chat's external replacement without writing it back.

### Restore floor

- A load's `replace` sets the chat's restore floor to its replacement revision; a group with a non-null base below it
  conflicts without a `reason` (the check: [server](server-resources.md#chat-writes-and-checkpoints)). The client
  handles it as any chat conflict: `recoverChatConflicts` reads back, `acceptRemoteChat` replaces the mirror and
  discards queued edits with the notice, `flushResources` reports `chats/<chaId>/<chatId>`, and a chat this tab's job
  streams into [defers](#deferral).
- Old work is refused only while its base is below the floor, so nothing moves that base past it: `installRead` holds no
  revision for a busy chat, and `acceptRemoteCollection` keeps a create's replay and the old base of later edits.
- One by-id case takes two rounds: an `append` whose `after` anchor the load removed keeps epoch and incarnation
  (`replace` keeps `seq`), so `reanchorGoneAppends` rewrites it and resends alone with a new `groupId` on its old base.
  The floor refuses it again; recovery finds no gone anchor and discards it with the notice. A group id the server
  remembers still receives its recorded answer.

## State

- Per chat: revision, `absentChats`, unsent and in-flight ops, local version, job locks, deferrals, refused intent (with
  object identity fencing an asynchronous discard). Per character: selection, chat order revision, refused order.
- Refusal reads use the module's own counter and local projections without changing state. Forgetting a character
  removes its refusal entries; session alert guards survive release and recreation.

## Coupling

- The chain is in [resource sync](resource-sync.md#coupling). `characterStore.svelte.ts` installs and adopts a
  character's chats, `network/generationJobs.ts` delivers job events, `process/serverCommands.ts` starts jobs and
  recovers lost follows.

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
  plus a summary list read. Decision: U1, [durable drafts audit](../audit/durable-drafts-2026-10-29.md).
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
