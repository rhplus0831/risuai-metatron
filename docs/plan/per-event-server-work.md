# Per-Event Server Work Plan

Status: drafted 2026-10-29, revised 2026-10-30 after an Astra review (see **Review record**);
landed: 0 (5c626d329), 1 (78caa182b).

Sources: findings SD01, TJ04, ST04 and SD03 of the
[server migration audit](../research/deep-audit-with-fable/server-migration-audit.md) (at
`ff7cb9d20`), which the archived Deep Audit Fixes plan deferred here as one group
(`git show b176020b2^:docs/plan/deep-audit-fixes.md`, **Deferred**: "One idea: reuse the store's
change information instead of rereading and re-diffing"). Code anchors were checked at `634bc14c7`;
verify them again before editing (STRUCTURE.md protocol step 5).

Owning guides: [self-host server](../structure/self-host-server.md) (the change feed, the job
socket, the callback barrier, chat summaries), [persistence](../structure/persistence.md) (the feed
client, chat patches, callback hydration memory, summary lists), [chat-pipeline](../structure/chat-pipeline.md)
(streaming display, the post-callback reread). Each slice updates the guide whose contract it
changes; Slice 7 only closes.

## Goal

A message-sized event costs message-sized work:

- A streaming checkpoint (one `setText` every 3 s) rereads nothing it already knows. Today it reads
  the whole chat twice and serializes every message once, a median of 80 ms of the serving thread
  per checkpoint on a 5,000-message chat (SD01).
- A script callback's barrier sends the owner what changed since its last copy, or nothing. Today
  every callback sends the chat whole: 500 whole-chat frames and 524 MB for a 500-message history
  with a no-op hook (TJ04).
- A feed event for a chat the tab holds only as a summary, or a one-field metadata change, does
  not turn into a read of every sibling summary or of the whole transcript (ST04).
- One committed write's optional payloads (patches, and the summaries and deltas this plan adds)
  are bounded per publication, and a socket is closed before the frame that would overfill it is
  queued, not after (SD03).

Not goals: per-socket subscriptions (sending a tab only the chats it has open), a bound on the
`hello` frame or on a frame's refs and lock lists, a chat-level write lock, a by-id HTTP read for
over-cap changes (see **Later**), or resuming anything across a restart. TJ03's shared transform
scope and TJ02's dependency contract stay with the Display Evaluation plan's record.

## Current state

- **The store already computes the change.** `applyGroup` (`server/src/data/chatStore.ts:1041`)
  tracks `touched`, `removedIds`, `metaChanged` and `applied` for every chat group, and
  `chatFeedPatch` (`:905`) turns them into a `ChatPatchBody` by reading only the touched rows
  (`selectPatchMessages`, each with the id of the row before it by position), the row's `meta`,
  and `COUNT(*)`. The body's `baseRevision` is the stored revision right before the group
  (`patchBase`, `:1103`), even for a stale by-id group; the revision advances by the applied op
  count (`:1407`). The patch is `undefined` for `create`, `replace`, `delete`, a remove-and-reappend
  group, or when its JSON exceeds `MAX_FEED_PATCH_BYTES` (64 KiB, `shared/resources.ts:366`; the
  build stops at the first byte over, before parsing an over-cap `meta` or the remaining rows).
  `applyChanges` keeps these patches in a feed-only map ("kept outside the HTTP batch's
  ChatGroupResult entries", `:1662`) and records them for the feed (`resourceStore.ts:1216`);
  `AppliedChanges` (`resourceStore.ts:240`) carries only revisions and group results, and the HTTP
  route spreads it into the response body (`routes/resources.ts:281`).
- **Every live path that changes a chat row or its `meta` advances its revision token through
  `applyChanges`** (checked by the review): translation writes (`setTranslation`,
  `server/src/translation/runner.ts:370`), memory tasks (a `meta` group, `memoryTasks.ts:641`),
  checkpoint loads (`replace`, `checkpointService.ts:267`); a restore or import changes the epoch,
  a delete and recreate the incarnation (the token's `seq`). `sourceGeneration` is a separate
  whole-source fence that moves only for `replace`, `delete` and character deletion
  (`resourceStore.ts:627`), never for a by-id edit.
- **A text checkpoint today** (`writeOwn`, `server/src/prompt/runner.ts:382`): `flushChatMetadata`
  (a separate meta write when variables or the note are pending), `refreshChat` (one `SELECT` of
  the revision when the scope is current; a whole read otherwise, `jobScope.ts:559`), `job.write`
  (one message row updated), `refreshChatAfterWrite` (`jobScope.ts:586`: adopts only an all-`meta`
  group without rereading messages; every text write falls through to a whole `readChatSource`),
  and `job.emitRecords`, which, when an owner socket is open, reads the whole chat again, builds a
  `ChatBaseline` that serializes every message (`generationJobs.ts:456`), and diffs it against
  `job.sentChat` (`diffChat`, `:473`). Measured on 5,000 messages of 2 KiB with a 32 KiB reply
  (seven runs, `server-data-probe.results.json` `checkpointPhases7Runs`): phase medians write
  7.0 ms, scope refresh 28.8 ms, owner read 19.8 ms, baseline plus diff 17.6 ms; the median of the
  per-run totals 80.2 ms, the first run 148.9 ms. The owner's `chatPatch` was 32,867 bytes, the
  feed patch 33,204 bytes.
- **The owner's patch base.** `job.sentChat` is the baseline of the last copy a socket **took**
  (`deliverJobChat`, `generationJobs.ts:826`; "It is not what the owner holds", `:368`): `send`
  succeeding advances it, with no acknowledgement from the tab. Admission seeds it from the
  admitted chat; an attach while the job runs sends a patch from it (`:1803`,
  `job.ended ? "whole" : "patch"`) and whole after the end; a `resync` sends the chat whole
  (`:1868`); the end clears it (`:1029`); a checkpoint with no open socket leaves it alone so the
  next attach's patch carries the checkpoint (`server/src/tests/generations.test.ts:1140`).
  `job.metaWrite` (`:1130`) remembers one all-`meta` own write so `jobChatEvent(…, metadataOnly)`
  (`:749`) can patch the metadata without parsing the messages; a text write clears it. A job
  patch always carries the job's generated rows (`job.generated`), because the owner's copy of a
  streaming message holds chunk text, not the stored text. The tab applies a `chatPatch` only at
  exactly the base or the patch's own revision, to a loaded, idle chat; `busy` marks the chat
  stale and starts local-work recovery, `mismatch` sends `resync`
  (`src/ts/network/generationJobs.ts:1150`, `chatStore.svelte.ts:2326`). A whole hydration is
  remembered even when it did not apply (`:1138`); a patch is not (`:1151`).
- **The callback barrier.** `channel.ts:671` puts `transport.hydrate()` on every `callback` event
  as `revisions`; `hydrateAll` (`generationJobs.ts:908`) sends the job chat **whole**
  (`deliverJobChat(job, "whole")`) and every other tracked record fresh, whatever changed. The
  tab's barrier (`src/ts/network/jobChannel.ts:566`) flushes local work, re-applies the remembered
  whole copy of each receipt it does not hold, and, for the job's chat, allows one fenced HTTP
  read only when a remembered copy at least as new as the receipt exists and the acknowledged
  floor alone refuses it (`:584`; `prepareChatHydrationRefresh`, `chatStore.svelte.ts:2121`,
  requires `belowAckedRevision`). Prompt assembly runs `editprocess` per eligible history message
  (`assemble.ts:1471`), so the barrier traffic is callbacks × chat bytes
  (`job-channel-probe.output.txt`: 500 callbacks, 500 whole-chat frames, 523,601,000 bytes,
  3.5 s with immediate answers and no provider). The owner socket already advertises a capability
  by query (`liveness=1`, `src/ts/network/generationJobs.ts:890`).
- **The feed.** A publication is one `change` frame per committed outermost write
  (`routes/events.ts:63`, `shared/events.ts:42`): the final accumulator's refs in the order
  resources, chats, chat orders (`resourceStore.ts:790`), a patch per entry when one fits, and
  `streaming` (the lock lists of the chats a job write touched; a job end may publish locks with
  no refs, `:1849`). Nested publishing scopes merge into the outer one (`mergeChanges`, `:689`): a
  record or chat recorded twice keeps its position and loses its patch; committed nested writes
  are still published when the outer operation fails (`:771`). Nothing bounds the sum of a frame's
  patches: 100 chat updates of about 60 KiB made a 6,024,591-byte frame
  (`server-data-feed-probe.results.json`). `send` (`events.ts:46`) compares `ws.bufferedAmount` of
  what is already queued with `MAX_BUFFERED_BYTES` (4 MiB), without the new frame's size; a refused
  socket is terminated and its client reconnects, where a matching `hello` digest avoids the
  revision listing. The same `send` carries the `hello` (`:142`). Ordering is preserved by the
  feed's reentrancy queue (`changeFeed.ts:38`) and `events.ts`'s nested-frame queue; the client
  applies a frame's refs first, then its `streaming` lists, each chat's list a full replacement
  whose lock revision comes from the same frame's chat ref, or `null` for a refs-free release
  (`chatStore.svelte.ts:1862`, `:1880`). Feed listeners run synchronously inside the publishing
  write, before `applyChanges` returns (`resourceStore.ts:755`, `changeFeed.ts:45`).
- **What a tab does with a chat entry.** A loaded, idle chat holding exactly the patch's base applies
  it (`applyChatPatch`, `chatStore.svelte.ts:2326`; `installChatPatch` replaces every non-`message`
  field when `meta` is present). A loaded chat without an applicable patch becomes `noticed` and
  reads the **whole chat** when idle. A chat the tab holds only as a summary answers `collection`
  (`noteRemoteChat`, `:5784`) and the sync loop reads the character's whole summary collection and
  order (`chatSummaryCollections`): 4,180 bytes measured for ten chats
  (`sync-traffic-measure.output.txt`), about 1.2 MB extrapolated for 3,000, every 3 s while a job
  streams into an unopened chat. The reconnect reconcile feeds the revision listing through the
  same path (`resourceSync.svelte.ts:4610`), as entries with identity and revision only. A
  metadata change carries the whole `row.meta` in the patch (`chatFeedPatch`, `:916`): a toggle
  beside 100 KiB of memory data is a 100 KiB patch, or, over the cap, a whole-chat read (4,244,437
  bytes measured for the long chat).
- **The summary projection** (`chatSummary`, `chatStore.ts:760`) is `name`, `fmIndex`, `folderId`,
  `bindedPersona`, `promptPresetId`, `modelPresetId`, `bindingReview`, `pinned`, the six
  translation fields, `lastMessageAt` (the **last row by position**'s finite `time`, `:744`, not
  the maximum), and the chat's `revision`. A text-only checkpoint changes none of it except the
  revision. `name` has no length bound (`server/src/data/chats.ts:45`).
- **Compatibility.** The feed has no format negotiation: a `hello` carries the epoch, the two
  snapshots and the digest. The server serves the client, so a tab is never newer than its server;
  an already-open or cached (PWA) tab can be older than the server for as long as it stays open.
  Additive fields are safe for it; a changed meaning of an existing event is not.

## Decisions

- **D1. The store hands an own write's change to the writer that asks for it.** `applyChanges`
  gains an option `changes: true`; with it, the `committed` hook receives
  `written: { chats: (ChatWriteChange | undefined)[] }` aligned with the batch's chat groups:

  ```ts
  type ChatWriteChange = {
    baseRevision: string; // the stored revision before the group (`patchBase`)
    revision: string; // after it
    count: number;
    removed: string[]; // in stored order of the base
    rows: { id: string; after: string | null; data: string }[]; // touched rows as stored, final order
    meta?: string; // the stored `meta` JSON when the group changed it
  };
  ```

  Rows and `meta` stay JSON **strings**: the baseline (D3) is advanced without parsing, the scope
  (D2) parses only the rows it installs, and the feed patch, when it fits, is derived from the same
  change. `undefined` where no by-id patch exists today (`create`, `replace`, `delete`, reappend, a
  duplicate group, nothing applied). The HTTP route passes no option and its response body does
  not change (V4: `rg` the field across `server` and `shared`; a route test compares the keys).
  - **The cap stays cheap where nothing asks.** A write without `changes: true` keeps today's
    early stop at the first byte over the cap, before parsing an over-cap `meta` or further rows.
    A write with it builds the uncapped change once (an append's `messages` array bounds the rows,
    the group's `meta` bounds the string) and the feed takes the capped patch from that change
    (same decision as today: within `MAX_FEED_PATCH_BYTES` or nothing).

- **D2. The runner's scope adopts its own change instead of rereading.** `refreshChatAfterWrite`
  takes the `ChatWriteChange` and adopts it only when all of these hold: the group result has a
  revision and is not `stale`; the change exists; `scope.chatRevision === change.baseRevision`
  (the scope's copy is exactly the base the change was computed on); `result.revision ===
change.revision`; and `store.chatRevision(...)` now equals `change.revision`. The last check is
  not a formality: feed listeners run synchronously inside the publishing write and may write
  again before `applyChanges` returns, and a later asynchronous write path would hide behind the
  same gap. Adoption:
  1. Validate: every removed id is present once; every row id is unique; every `after` names a
     surviving or earlier-placed row (or is `null`); the result's length equals `change.count`.
     Any failure is a whole `refreshChat`.
  2. Build the new `message` array in final order: start from the surviving rows in the old
     order, then place each new or changed row after its anchor (a changed row whose anchor is a
     new row of the same change is placed after that row). Unchanged rows keep their objects;
     changed and new rows are parsed from `data`; the array and the chat object are new (Lua
     bindings and scripts may hold the previous ones).
  3. Replace the non-`message` fields from `meta` when present, then `overlayChatMeta` lays the
     pending metadata over it as today, then `addSpeakers` for rows whose `saying` the projection
     lacks.
  4. `scope.chatRevision = change.revision`; `scope.chatSourceGeneration` is unchanged (a by-id
     change never moves it; a fallback `refreshChat` updates it as today).

  Every other case keeps today's whole `refreshChat`: a stale group, a whole write, a reappend, a
  missing change, a scope that was not at the base, a revision that moved. The all-`meta` branch
  is subsumed (a meta change is a change with `meta` and no rows). The pre-write `refreshChat`
  stays: it is one `SELECT` when the scope is current.

- **D3. The owner's patch comes from a working baseline, not from composed patches.** `Job`
  gains `workingChat: ChatBaseline | null`, the baseline the job's own writes have advanced from
  `sentChat`. In the `committed` hook, each own write of the job chat with a change is applied to
  it when contiguous (`change.baseRevision === workingChat.revision`): removed ids dropped, rows
  placed by anchor in final order (the same placement rules as D2), `texts` set from `data`
  (unchanged rows keep their strings, so a `Map` copy shares them), `meta` replaced when present,
  `revision = change.revision`. A non-contiguous change (a foreign write landed between), a
  missing change (a whole write), or a failed placement sets `workingChat = null`.
  `jobChatEvent` in `patch` mode then:
  1. Reads the chat's current revision with one `SELECT`. With `sentChat` set and
     `workingChat.revision` equal to it, the patch is `diffChat(sentChat, workingChat, …)` run on
     baselines: removals in `sentChat`'s order, the survivor-order check, rows whose text differs
     or whose id is in `job.generated`, anchors from `workingChat.ids`, `count = workingChat.ids
.length`, `meta` only when the strings differ, `streaming` from the current watermarks. Only the
     emitted rows are parsed (`diffChat` gains a row supplier so it takes either a `Chat` or a
     baseline). Because the working baseline is the final state, insert-then-remove-the-anchor,
     insert-then-insert-before, text A→B→A and meta A→B→A all come out as the diff does; a
     cross-group remove-and-reappend that reorders survivors fails the survivor check and goes
     whole, as today.
  2. Otherwise today's path: read the chat, `chatBaseline`, `diffChat` (or whole), and
     `workingChat` is reseeded from that read's baseline.

  When a socket takes the event, `sentChat = workingChat` (the delivered state), as today's
  baseline hand-off. Lifecycle: an attach while running reseeds `workingChat` from the attach's
  read; a `resync` and the end set it from the whole copy or to `null`; a job with no open socket
  keeps advancing it (its next attach then composes one patch over every checkpoint since
  `sentChat`). `job.metaWrite` and the `metadataOnly` parameter go away: the working baseline
  covers them. Memory: one more `ChatBaseline` per job whose unchanged strings are shared with
  `sentChat`; no patch chain is retained, so no chain cap is needed.

- **D4. The barrier sends the difference, or nothing, to a tab that can recover.** The owner
  socket advertises `hydration=patch` in its URL query beside `liveness=1`; `hydrateAll` keeps
  today's whole copy for a socket without it (an already-open older tab).
  - **Server, for an advertising socket.** One `SELECT` of the job chat's revision. Equal to
    `sentChat.revision`: no chat event, and the receipt names that revision. Otherwise
    `deliverJobChat(job, "patch")` (D3's patch, or whole) and its receipt. Other tracked records
    go on as today (`freshRecords`). `sentChat` is what a socket took, not what the tab holds; the
    omission is correct only together with the recovery below.
  - **Client recovery, one decision per job-chat receipt.** After the flush and after re-applying
    any remembered whole copy at least as new as the receipt, if the receipt of the job's own chat
    is still not held, the barrier makes **one** fenced read of that chat (`readRefs`, under
    `BARRIER_READ_DEADLINE_MS`) in each of these cases: no remembered copy, a remembered copy
    older than the receipt (a patch arrived as `busy` or `mismatch`, a replacement socket, a
    refused whole copy on attach or `resync`), or the existing floor-only refusal of an adequate
    copy. `prepareChatHydrationRefresh` keeps its ref-and-revision signature and its owner,
    incarnation, epoch, local-work, cancellation and job-metadata fences, and drops the
    requirement that the revision be below the acknowledged floor. The read's result is installed
    through `applyHydration` with the job's streaming metadata the tab currently holds for that
    job (its last `chatPatch`/`resource` `streaming` list, or the live chunk state), never an
    empty list, since `settleJobHydration` retires generations absent from the list
    (`chatStore.svelte.ts:2193`). After the read the receipt must be held, else the callback fails
    as `barrier`, as today. An intervening `resync` answer that satisfies the receipt while the
    read is in flight is accepted, as today.
  - The audit's quadratic traffic becomes: no chat frames while the chat is unchanged, one patch
    per change, and one HTTP read in the rare case the tab fell behind the socket.
- **D5. A publication has an optional-payload budget; a frame is admitted with its own size.**
  - `MAX_FEED_PUBLICATION_PATCH_BYTES` (256 KiB, `shared/resources.ts`) bounds the **optional
    payloads** of one `change` frame: record patches, chat patches, and the `delta` and `summary`
    fields D6 and D7 add. It is applied at the final accumulator-to-publication step
    (`resourceStore.ts:777`), after nested scopes merged and coalescing dropped its patches, before
    the JSON is built, walking the final arrays in wire order (resources, chats, chat orders): an
    entry keeps its payload only if the running sum including it stays within the budget; an
    entry whose payload does not fit loses it (a later smaller one may still fit). Refs, chat-order
    entries and `streaming` lists are never dropped or split; a refs-free lock release is
    published as today.
  - `send` is admitted as `ws.bufferedAmount + bytes > MAX_BUFFERED_BYTES` → terminate, with
    `bytes` the UTF-8 length measured once per publication and passed with the text. The `hello`
    keeps today's check on the queued bytes alone (bounding it is out of scope, and a `hello` that
    never admits would reconnect forever).
  - **What this bounds and what it does not.** Optional payload bytes are bounded; a frame's refs
    and lock lists are not (ids may be 512 characters; a character delete records every chat's
    deletion; in-process writes have no op cap). A frame whose refs alone cannot be admitted
    still terminates the socket, and the reconnect's listing reconciles it, as today. No frame
    split: one committed write stays one frame (the client takes a chat's lock revision from the
    same frame's chat ref, and a refs-free release means `null`).
- **D6. A feed chat entry says what it knows about the summary.** `ChangeSet.chats[]` gains two
  optional fields: `summary: ChatSummary` (the projection at the entry's revision, when the write
  changed it) or `summaryBase: string` (the projection is the same as at that revision, the
  write's `patchBase`). Neither: unknown (a plain ref, a coalesced entry, a budget-dropped
  payload, a revision-listing entry), which keeps today's collection read.
  - **Deciding on the server.** The projection compared **excludes `revision`**, and both parts
    are compared for every group: the metadata fields (parsed only when `metaChanged`; equal
    strings are equal projections) and `lastMessageAt` before and after (two cheap queries; a
    note edit plus a removal of the last row changes the time while changing no field, and a
    removal can make it absent).
  - **Coalescing** (`mergeChanges`, `recordChat`): the merged entry keeps `summary` when the later
    entry has one, or the earlier `summary` when the later entry says `summaryBase` equal to the
    earlier revision (unchanged since); it keeps `summaryBase` only when both say unchanged and
    the later base is the earlier revision (then the earlier base); otherwise neither.
  - **The client.** For a chat it holds as a summary and has not loaded: with `summary`, install
    it and hold the entry's revision; with `summaryBase` equal to the held summary's revision,
    advance the held revision to the entry's; in both cases settle the notice without a collection
    read. A held revision that does not match the base, no field, a chat not in its held ids, a
    deletion, or pending local work for that chat: today's `collection`. The order record keeps its
    own ref.
  - `summary` counts against D5's budget; a dropped one leaves the entry unknown. An older tab
    ignores both fields.
- **D7. A metadata change travels by field.** `ChangeSet.chats[]` gains `delta?: ChatPatchBody`
  beside `patch`, where `delta` carries `metaFields?: { set: Record<string, unknown>; remove:
string[]; merge?: Record<string, Record<string, unknown>>; mergeUnset?: Record<string, string[]> }`
  instead of `meta`: top-level fields set or removed, and for the four keys of
  `CHAT_META_MERGE_KEYS` (`shared/chats.ts:18`) the entries added, replaced or removed inside that
  map, computed from the old and new `meta` JSON the write already holds. A key whose value
  changes between a map and a non-map, or appears or disappears whole, goes through `set` or
  `remove`, not `merge`. The server emits `patch` when the whole-meta form fits the cap (an older
  tab applies it; the meta is small anyway), and otherwise `delta` when the field form fits; a new
  tab prefers `delta`, an older tab sees a plain ref for it (today's behavior). The client applies
  `metaFields` through a remote-side merge in `installChatPatch` (set, remove, per-key map merge
  and unset), never through `mergeChatMeta`, which ends in `enqueueLocalEdit`
  (`chatStore.svelte.ts:3440`). Both forms count against D5's budget. The job socket's `chatPatch`
  keeps whole `meta`: its one consumer is the owner, and a working-baseline `meta` change is rare.
  - **Why a second field, not a format bump.** The feed has no negotiation; a second field is
    additive, costs nothing when no large meta is involved, and keeps one frame for every socket.
    Retiring `patch` needs a demonstrated compatibility boundary (a client version the server can
    refuse); it is in **Later** without a date.
- **D8. Measurements are part of done, from a pinned baseline.** Slice 0 adds the probe script
  for the checkpoint phases (the audit measured them inline) and extends the barrier probe, runs
  both at `634bc14c7`, and records the baseline in the probe result files with the commit, the
  fixture and the counters. Each later slice reruns the probe it changes and the audit document
  gets an "after" line per finding with the same phase boundaries, totals, payload bytes and read
  counts.

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slices
1–4 edit `server/src/data/chatStore.ts` and `server/src/jobs/generationJobs.ts` in turn: run them
one at a time, in order. Slice 5 edits `resourceStore.ts` too and goes after Slice 1; Slice 6's
payloads join Slice 5's budget, so 5 → 6.

### Slice 0: probes and the pinned baseline (D8; needs nothing)

Files: new `docs/research/deep-audit-with-fable/probes/checkpoint-probe.mjs` (seeds 5,000
messages of 2 KiB, runs seven checkpoints through the runner's write path, reports per phase and
total medians, the owner patch bytes, the feed patch bytes, and the whole-transcript read count at
the SQL boundary), `job-channel-probe.mjs` (adds total frame bytes, patch bytes and callback
bytes beside the whole-chat count), their result files, the audit's SD01 and TJ04 sections (a
"Baseline at `634bc14c7`" line each).

- No product code. The SQL counter is the `DatabaseSync.prototype.prepare` wrapper
  `server/src/tests/jobMetadataScope.test.ts:25` uses, counting `.all()` of
  `SELECT data FROM messages WHERE chatSeq = ? ORDER BY position`.

### Slice 1: the own-write change (D1; needs nothing)

Files: `server/src/data/chatStore.ts` (`chatFeedPatch` split into an uncapped `chatWriteChange`
and the capped feed derivation; `applyGroup`'s return; the chat outcome map), `server/src/data/resourceStore.ts`
(the `changes` option, the `committed` hook's `written` argument; the feed recording keeps the
capped patch), a server-local `ChatWriteChange` type, tests in
`server/src/tests/chatFeedPatches.test.ts` and `chatStore.test.ts`.

- Tests: a `setText` group's change carries that one stored row with its anchor, the stored base
  and `count`; a group whose applied op count is more than one advances the revision by that
  count and the change says so; a group over 64 KiB yields a change and no feed patch; a write
  without the option never reads past the cap (the SQL counter sees no row read after the first
  over-cap byte for an over-cap `meta`); `create`, `replace`, `delete`, reappend, a duplicate
  replay, a no-op group and a missing target yield no change; a rolled-back batch calls no hook;
  a batch of several groups aligns `written.chats` with the groups; the HTTP batch response body's
  keys are unchanged; a stale by-id group's change has the stored base, not the requested one.

### Slice 2: scope adoption (D2; needs 1)

Files: `server/src/jobs/jobScope.ts` (`refreshChatAfterWrite`, the metadata flush at `:445`),
`server/src/prompt/runner.ts` (`writeOwn`; the post-callback `refreshChat` calls at `:453`,
`:570`, `:707` stay, since a callback may have written), `server/src/jobs/chatResult.ts`,
`server/src/lua/bindings.ts` (`:447`), `server/src/jobs/generationJobs.ts` (`writeAsJob` returns
the changes beside `AppliedChanges` to its callers), tests in
`server/src/tests/jobMetadataScope.test.ts`, `chatMetadataCoalescing.test.ts`, and a new
`jobScopeAdoption.test.ts`.

- Tests (the SQL counter from Slice 0): a text checkpoint after a current scope performs no whole
  transcript read; the adopted copy equals a fresh read (rows, order, meta with the pending
  overlay, `chatSourceGeneration`); an insertion at an anchor, several inserted rows, a changed
  row anchored on a new row, a removed anchor within the same group, and a repeated touch of one
  id land where a fresh read has them; a new row's speaker is added; a stale group, a `replace`,
  a reappend, a scope not at the base, and a feed listener that writes the chat inside the
  publishing write each fall back to the whole read and the fallback updates
  `chatSourceGeneration`; the previous chat object and `message` array are not mutated; unchanged
  row objects are the same objects.

### Slice 3: the working baseline (D3, D8; needs 1)

Files: `server/src/jobs/generationJobs.ts` (`Job.workingChat`, the `committed` hook, `jobChatEvent`,
`deliverJobChat`, attach, `resync`, the end, the removal of `metaWrite` and `metadataOnly`;
`diffChat` over baselines with a row supplier), `shared/jobs.ts` doc comments, tests in
`server/src/tests/generations.test.ts` (the baseline cases at `:1100–1200`) and
`generationJobs.test.ts`, the checkpoint probe rerun.

- Tests (the SQL counter; every composed patch compared with the patch today's read-and-diff
  produces for the same stored states, structurally, and applied on a client mirror at the base
  and at the final revision): one checkpoint; a metadata flush then a checkpoint; insert `x after
a` then remove `a` (final `x.after === null`); insert `x after a` then `y after a` (final order
  `[a, y, x, b]`, `x` after `y`); append then remove (no row, no removal); text A→B→A and meta
  A→B→A (nothing emitted but generated rows); a generated row untouched by the current writes is
  still carried; a cross-group remove-and-reappend goes whole; a foreign by-id write between own
  writes falls back to the read-and-diff and yields the same patch; no socket keeps advancing and
  the next attach's patch carries every checkpoint since; an attach while running reseeds; a
  `resync` and the end reset; synchronization through a socket-close await and a runner latch,
  not `sleep`.
- Probe: `checkpoint-probe.mjs` after Slices 2 and 3. Target: adoption and owner patch together
  under 5 ms at 5,000 messages, as an empirical report, not a gate assertion.

### Slice 4: the delta barrier (D4; needs 3)

Files: `server/src/jobs/generationJobs.ts` (`hydrateAll` by socket capability; the socket URL
query parsed beside `liveness`), `src/ts/network/generationJobs.ts` (`hydration=patch` in the URL,
the job's held streaming metadata exposed to the barrier), `src/ts/network/jobChannel.ts`
(`barrier`'s one-read decision), `src/ts/storage/chatStore.svelte.ts` (`prepareChatHydrationRefresh`
without the floor-only requirement), tests in `server/src/tests/generations.test.ts` (callback
barrier cases), `src/ts/network/jobChannelBarrier.test.ts` (fake timers and the deferred read
seam at `:160`), the barrier probe rerun.

- Tests, server: three callbacks over an unchanged chat send no chat frame and carry the same
  receipt; a checkpoint between two callbacks sends one `chatPatch` and the receipt moves; a
  socket without `hydration=patch` still gets whole copies; an own write queued but not yet
  delivered is never skipped.
- Tests, client: the receipt held after the patch passes with no read; a busy patch with no
  remembered copy, a remembered copy older than the receipt, a replacement socket, and a refused
  whole copy on attach each flush, read once under the deadline, and pass; the floor-only case
  still reads once; a newer own revision passes without a read; the deadline (fake clock),
  cancellation and an incarnation change during the read fail as `barrier`; an intervening
  `resync` satisfying the receipt skips the install; the installed copy keeps the streamed text
  and watermarks of the live generation (no empty streaming list).
- Probe: `job-channel-probe.mjs` after: 0 whole-chat frames and the total bytes for the no-op hook.

### Slice 5: the publication budget and admission (D5; needs 1)

Files: `shared/resources.ts` (`MAX_FEED_PUBLICATION_PATCH_BYTES`), `server/src/data/resourceStore.ts`
(the final publication step), `server/src/routes/events.ts` (`send` with the measured size; the
`hello` exempt), tests in `server/src/tests/changeFeed.test.ts` and `events.test.ts` (the `send`
spy at `:539`), the self-host-server guide (feed section and Known Hazards).

- Tests (five near-cap patches, not 100): the first entries keep their patches and the one that
  does not fit loses it while a later smaller one keeps it, in wire order across a mixed
  resource-and-chat publication; a repeated key and a nested scope spend no budget on a dropped
  patch; a nested write committed under a failed outer operation is still published within the
  budget; the `streaming` list stays whole and in the same frame as its chat ref; a refs-free lock
  release is published; a socket whose `bufferedAmount` plus the frame's UTF-8 bytes (a
  multi-byte fixture) would pass 4 MiB is terminated before the frame is queued, the other sockets
  still receive it, and a frame exactly at the bound is sent; a refs-only frame over the bound
  terminates the socket and the reconnect reconciles; a `hello` is admitted as before.

### Slice 6: summary on the entry, metadata by field (D6, D7; needs 1 and 5)

Files: `shared/resources.ts` (`summary`, `summaryBase`, `delta`, `metaFields`),
`server/src/data/chatStore.ts` (the summary decision, the field diff), `server/src/data/resourceStore.ts`
(recording, coalescing, the budget), `src/ts/storage/chatStore.svelte.ts` (`noteRemoteChat` for a
held summary, `installChatPatch` with `metaFields`), `src/ts/storage/resourceSync.svelte.ts`
(preferring `delta`), tests in `server/src/tests/chatFeedPatches.test.ts`, `chatSummaries.test.ts`,
`changeFeed.test.ts`, `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`,
`resourceSyncLazyChats.test.ts`, the persistence guide (live updates, summary lists).

- Tests, server: a text checkpoint carries `summaryBase`; an append with a newer `time`, a rename,
  a folder move, a pin, a note edit plus removal of the last row (time changes, no field does),
  a removal that leaves no finite time, and an earlier time each carry `summary`; a rename then a
  text write coalesced in one scope carry the rename's `summary` at the final revision; two
  unchanged writes coalesce to the first base; a budget-dropped `summary` leaves neither field; a
  toggle beside 100 KiB of memory data emits a `delta` under 1 KiB with `metaFields.set` of that
  one field and no `patch`; one `scriptstate` key change emits `merge` of that key only; a removed
  key emits `mergeUnset`; a map that becomes a string or disappears goes through `set`/`remove`;
  a small meta still emits `patch` with whole `meta`.
- Tests, client: a held-only chat with `summary` updates its entry and performs no collection
  read; with `summaryBase` equal to its held revision it advances and performs none; with a base
  that does not match (a missed rename, a revision-listing entry after a reconnect) it reads the
  collection; a chat not in the held ids and a deletion still read the collection; a loaded chat
  applies `delta`'s `metaFields` (set, remove, merge, unset, map↔string) and ends equal to a whole
  read with no outgoing write queued; a `delta` whose base does not match falls back as a plain
  ref; an entry with neither `patch` nor `delta` follows today's path.

### Slice 7: docs close and the audit's after lines (needs all)

Files: the three guides' affected paragraphs (persistence `:131`, `:143`, `:148`, `:420–421`;
self-host-server `:184`, `:260`, `:369`; chat-pipeline `:229`), the audit document's SD01, TJ04,
ST04 and SD03 sections (an "After" line each with commit, fixture, counters and values), the
Known Hazards entries that describe the whole-chat barrier and the unapplied-patch whole read
(persistence `:344`), the remaining limitations (refs and lock lists unbounded; an older owner tab
keeps whole barriers; the over-cap change of a loaded chat still reads whole), `docs/plan/README.md`,
the archive entry at retirement.

## Recommended order

0 → 1 → 2 → 3 → 4, with 5 after 1 (in parallel with 2–4: no shared product files once 1 is in),
then 6 after 5, then 7. Slices 2, 3, 4 and 6 share `chatStore.ts` or `generationJobs.ts` with
each other and land serially. Only this plan is active; the recent commits that touched these files
(`634bc14c7` job scope and channel fixes, `179505dc6` chat collection boot cache, `c10aed8a1`
last-message timestamps, `0b5e401e7` chat recovery, `a07028e56` reconnect digest) are in `dev`, and
their tests stay green under every slice.

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the affected `slow` and `e2e` sets), V6
  (each new regression test shown failing once with its guard broken), V4 (`rg` each changed
  export and wire field across `src`, `server`, `shared`, `util`, `e2e`, `docs`), V7 (typed mock
  factories; no new inline module mocks), V3 (no real time; the barrier deadline and the feed tests
  use injected clocks), prettier on changed files.
- Seams, all existing: the `DatabaseSync.prototype.prepare` wrapper
  (`server/src/tests/jobMetadataScope.test.ts:25`) counts whole-transcript reads at the SQL
  boundary, initialized before the store is created, reset after fixture setup and admission,
  asserted before the fresh-read oracle; the callback suite `src/ts/network/jobChannelBarrier.test.ts`
  (fake timers, deferred read); the `send` spy at the socket boundary
  (`server/src/tests/events.test.ts:539`) with a controlled `bufferedAmount`. No production
  counter is added for tests.
- Fixtures stay structural: three callbacks, five patches, a few rows. The 5,000-message and
  6 MB cases are probes (Slice 0) or `slow` tests.
- Each test must catch one of these wrong implementations:

  | Wrong implementation                                                            | Caught by                                    |
  | ------------------------------------------------------------------------------- | -------------------------------------------- |
  | Change built from the scope's copy instead of the stored rows                   | Slice 1 stale by-id base; Slice 2 equality   |
  | Uncapped build for writes that did not ask                                      | Slice 1 over-cap `meta` read count           |
  | Adoption without the base or current-revision checks                            | Slice 2 scope-not-at-base; listener write    |
  | Rows placed sequentially, ignoring new rows that precede them                   | Slice 2 changed row anchored on a new row    |
  | Scope copy mutated in place; `chatSourceGeneration` lost on fallback            | Slice 2 previous-object and fallback tests   |
  | Patches composed by "last row wins" instead of a final-state diff               | Slice 3 anchor and reversion examples        |
  | Working baseline advanced across a foreign write                                | Slice 3 foreign by-id write                  |
  | Generated rows dropped from a composed patch                                    | Slice 3 untouched generated row              |
  | Working baseline not reseeded on attach, `resync`, end                          | Slice 3 lifecycle cases                      |
  | Barrier skipping the chat while an own write is unsent                          | Slice 4 checkpoint between callbacks         |
  | Barrier omitting the copy to a socket without the capability                    | Slice 4 older-socket test                    |
  | Client passing on a receipt it does not hold; no read without a remembered copy | Slice 4 busy-patch and failing-receipt tests |
  | Installed read with an empty streaming list                                     | Slice 4 streamed-text test                   |
  | Budget applied per group or before coalescing, or reset per nested scope        | Slice 5 repeated-key and nested tests        |
  | `streaming` separated from its chat ref; refs-free release dropped              | Slice 5 lock-list tests                      |
  | Admission counting the queued bytes only, or `text.length` not UTF-8 bytes      | Slice 5 termination tests                    |
  | Absent summary treated as unchanged                                             | Slice 6 missed-rename and listing tests      |
  | `summaryBase` accepted at another held revision                                 | Slice 6 base-mismatch test                   |
  | Summary equality including `revision`, or ignoring `lastMessageAt`              | Slice 6 text checkpoint; note-plus-removal   |
  | Coalescing losing a constituent's `summary`                                     | Slice 6 rename-then-text test                |
  | `metaFields` applied through the local merge (queues a write)                   | Slice 6 no-outgoing-write assertion          |
  | Map↔non-map transition sent as `merge`                                          | Slice 6 map-becomes-string test              |

## Out of scope

- Per-socket subscriptions and per-tab filtering of the feed (the audit's "sent to every tab").
- A bound on the `hello` frame's snapshots, or on a frame's refs and lock lists.
- A text delta for the streaming row (the owner already has the chunks; the patch still carries
  the stored row).
- TJ03 and TJ05 (the Display Evaluation record), SD04 and SD06 (server byte budgets).

## Later

- **A by-id read for an over-cap change of a loaded chat** (the audit's remaining ST04 case: a
  reply over 64 KiB streaming into a chat another tab has open). Deferred: D7 removes the measured
  large-meta case, and no measurement shows how often loaded observers hit the rest. A design
  needs the entry's base, `count`, a meta selector in the request, read fences, and budget
  accounting for the id lists; measure the residual whole-read traffic after Slice 6 first.
- Retiring `patch` in favor of `delta`, once the server can refuse a client older than a known
  version.
- Whole barriers for owner sockets without `hydration=patch`: drop the branch at the same
  boundary.
- A streaming-row text delta on the job socket.
- Sending a chat's summary on the job socket for the owner's own list (today the owner's list
  updates through the feed like any tab).

## Review record

The Astra review of the first draft (2026-10-29, `gpt-6-astra`, read-only; report under
`/home/codex/review-reports/per-event-server-work-plan-2026-10-29/astra.md`) raised 11 findings
(3 P1, 7 P2, 1 P3). Verdict: redesign D3, D4 and D6; correct D5; defer D8. All are taken except the
trims below.

- **P1 taken.**
  - F1 (D3): composing patches by "last row of an id wins" breaks final anchors, transient rows
    and reversions. Replaced by a working baseline advanced per own write and diffed against
    `sentChat` with the existing `diffChat` rules, so every composition case is the diff by
    construction. The attach claim in Current state corrected (`patch` while running, whole after
    the end).
  - F2 (D4): `sentChat` is what a socket took, not what the tab holds, and the existing one-read
    path admits only a floor-refused remembered copy. Replaced by one recovery decision per
    receipt covering no copy, an older copy, a replacement socket, a refused whole copy and the
    floor case, with the guard's floor requirement dropped and the installed read carrying the
    job's held streaming metadata.
  - F4 (D6): an absent summary is unknown, not unchanged (coalescing drops fields; the reconnect
    listing uses the same path; a missed earlier change is invisible). Replaced by three states
    (`summary`, `summaryBase`, neither), a coalescing rule, a projection equality that excludes
    `revision` and always compares `lastMessageAt`.
- **P2 taken.** F3: the owner socket advertises `hydration=patch`; older sockets keep whole
  barriers; no dated retirement of `patch`. F5: the budget applies at the final publication step
  after coalescing, over the final arrays, with nested and failed-outer cases. F6: the budget
  bounds optional payloads only, refs and lock lists are unbounded and documented, admission
  measures UTF-8 bytes once per publication, the `hello` is exempt. F7: the adoption fence
  (`scope.chatRevision === change.baseRevision`, the current store token, the synchronous listener
  write), final-order placement with validation, `chatSourceGeneration` preserved and updated on
  fallback. F8: the uncapped build only for writers that ask (`changes: true`); rows and `meta`
  as strings; no patch chain to cap. F9: the by-id read moved to **Later**. F10: the existing
  seams named, small fixtures, no `sleep`, the wrong-implementations table extended.
- **P3 taken.** F11: Slice 0 pins the baseline at `634bc14c7` with the probe files; the 1.2 MB
  figure labeled an extrapolation; the 5 ms target an empirical report.
- **Trimmed.**
  - F10's "test both old and new feed consumers" for Slice 6: no old client build enters the test
    matrix. Compatibility is by construction (additive fields, `patch` unchanged), and the new
    client's "neither field" path is tested; an older tab's behavior is today's code.
  - F6's remaining unbounded-refs case: no frame split is adopted (the review did not ask for
    one); the terminate-and-reconcile path stays and is a documented limitation.
