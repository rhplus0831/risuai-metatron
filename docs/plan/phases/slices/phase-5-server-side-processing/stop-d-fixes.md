# Slice: Stop D Fixes

Status: implemented (2026-10-03): 13c and 13d.

Phase: [Phase 5](../../phase-5-server-side-processing.md). Owner decisions at Stop D
(`implementation-plan.md`, "Stop D decisions"): five defects found at Stop D are fixed before the
cutover (slice 14), because the cutover makes the server path the only one. Two slices, one commit
each: 13c (two tabs) and 13d (graph memory and the MCP clients).

## 13c: two tabs

### C1. A `lastInteraction`-only remote change no longer discards a local edit

Symptom (Stop D matrix): tab B opens character C, which stamps `lastInteraction`
(`src/ts/characters.ts:715-720`) and writes the character record with revision R → R+1. Tab A
still holds R. A's next send stamps `lastInteraction` too (`serverGeneration.ts:52` with the flag
on, `index.svelte.ts:419` off), and its whole-record write with base R gets a 409
(`server/src/data/resourceStore.ts:647-667`). `recoverFromConflict`
(`src/ts/storage/resourceSync.svelte.ts:1223`) reads the record back and `acceptRemote` replaces
the mirror and counts the edit as discarded: the "Another tab or device changed this data" notice.
With the flag on, `runServerJob` (`src/ts/process/serverCommands.ts:218-222`) then refuses the send
("A conflict discarded local changes"), so nothing is sent. With it off the user message survives
(it is chat work), but any other local edit of the character is still discarded.

Fix (client, `resourceSync.svelte.ts` `recoverFromConflict`): for a conflicting character record
whose server copy equals this client's persisted base except for `lastInteraction` (both parsed,
`lastInteraction` removed, compared structurally), the remote change was only a recency stamp.
Rebase instead of discarding: record the server's revision and text as the persisted base, set the
mirror character's `lastInteraction` to the larger of the two values, and leave the key dirty (not
settled, not discarded, no notice). The next cycle writes the local record on the new base;
`flushResources` already runs up to ten cycles, so a send's pre-flush succeeds.

Why the client and not the server: the server keeps no base text, so it can only accept a stale
write that differs from the current record in nothing but `lastInteraction`. That fixes A's case
but not the reverse (B's real edit after A's stamp is still discarded). The client has its base.

Not changed: any other remote change still discards as today; chats are not part of the character
record (`projectCharacter` strips them); a group character's record is handled the same way.

### C2. A second tab's send during another tab's job shows `chatGenerating`

Symptom: while tab A runs a server job in chat X, tab B's send fails with "Local changes could not
be saved: A character is still being generated; try again when it finishes" instead of
`language.chatGenerating`. The pre-send flush throws that text (`resourceSync.svelte.ts:1646-1648`)
and `runServerJob` wraps it (`serverCommands.ts:224-226`).

Fix: `flushResources` throws an exported `GenerationBlockedError` (same message, so existing
callers and tests that match the text keep working). `runServerJob` catches it and shows
`language.chatGenerating` once per refusal episode (through the existing `generatingNoticeShown`
guard, exported as a small function), then returns `refused`; `DefaultChatScreen` keeps restoring
the input as it does for every refusal.

### C3. A second tab sees a running server job's reply without a reload

Symptom: tab B, with chat X loaded, does not show tab A's server job reply until B reloads. Job
events go only to the owner tab's socket (`generationClientId` is per tab, `sessionStorage`), and
the server pushes nothing to other tabs; resource-change events for every client are Phase 6
("Live updates").

Fix (same browser only, read-only): a `BroadcastChannel` notice from the owner tab.

- New `src/ts/storage/chatChangeNotices.ts`: `announceChatChange(ref, final)` posts
  `{ chaId, chatId }` on the channel `risu-chat-changes`, at most once per 3 s per chat (leading
  and trailing; the server's checkpoint interval), immediately when `final`; `startChatChangeNotices()`
  listens and calls a new `markChatStale(ref)` in `chatStore.svelte.ts`.
- `markChatStale(ref)`: for a chat the mirror holds (a held revision), adds it to `staleChats` and
  notifies the save cycle; the existing idle refresh (`refreshIdleChats`, `canRefreshChat`) reads it
  when the tab has no work on it, and `applyRemoteChat` replaces the copy.
- `applyGenerationEvent` (`src/ts/network/generationJobs.ts:327`) announces on `accepted` and
  `chunk`, and finally on `done` and `error`. Started from `startResourceSync`.
- B therefore shows the job's checkpoints (every 3 s on the server) and the final reply. It never
  owns the job: no abort, continue, or channel answers; its edits to the locked messages are
  refused by the server as today (C2's notice).

Residuals: another device or browser still needs a reload (Phase 6); if the owner tab closes
mid-job, B shows the last notice's checkpoint until it reads the chat again.

### Checks for 13c

The gates; `util/playwright/checkStopDMatrix.mjs` two-tab section extended (flag on and off): A's
send after B opened the character succeeds with no notice and both edits survive; B's send during
A's job shows `chatGenerating` once and keeps its input; B shows A's reply (a checkpoint, then the
final text) with no reload.

### 13c as implemented (after the plan review)

- C1 became a narrow merge of benign remote changes (`mergeConcurrentChange` and `benignChanges`
  in `resourceSync.svelte.ts`). The Stop D matrix showed that a tab's open changes more than the
  stamp: the character screen's checkbox binding fills `supaMemory: false` in. A send also counts
  `statics.messages`, so the second tab's flush conflicted on `statics` too.
  - For a character or `statics`, each top-level field the server changed against the saved base
    must be one of these:
    - equal to the local value;
    - absent in both the base and the local copy (taken from the server; while a generation runs
      on the character, only the screen default `supaMemory: false`, from the second challenge);
    - a character's `lastInteraction` (the later of two finite stamps);
    - a `statics` count (best effort: the server's count plus the local increments).
  - Anything else conflicts as before. The first challenge rejected a general three-way field
    merge, for two reasons:
    - a group's parallel member arrays would combine;
    - a running generation's character would take substantive remote edits without the deferral.
  - Implementation rules from the challenge:
    - own-property dictionaries with a null prototype;
    - a taken field the mirror object only inherits (`toString`, `constructor`, ...) refuses the
      merge before anything changes (the first review: a Svelte proxy drops such an assignment, and
      the next write would remove the field from the server);
    - values prepared before the mirror changes;
    - listeners notified for taken fields;
    - no settle, discard, or notice; the key stays dirty;
    - the base is the server's text, or the local projection when the two are structurally equal.
- C2: `runServerJob` alerts `chatGenerating` on a `GenerationBlockedError` unless the adapter's
  conflict recovery showed it during this flush (`generatingNoticeCount`). This deviates from the
  review's "through the episode guard only": a user's explicit send always gets one notice. With
  C1, the second tab's flush now succeeds, and its job create gets the busy answer and the same
  alert.
- C3, per the review:
  - Notices come from the job's chat `resource` events (committed copies) and its
    `done`/`error`; a chunk does not announce.
  - The throttle is 1 s per chat (leading and trailing; final at once; an entry is dropped after a
    quiet interval). A second `startChatChangeNotices` keeps the first receiver.
  - Notices carry the epoch.
  - The mark is a per-chat sequence (`markChatNoticed`, `chatNoticeSeq`, taken before the read): a
    notice during a read survives that read.
  - The idle refresh also waits for an unexpired job retry block.
  - The channel is opened lazily and feature-detected.
- Check: `checkStopDMatrix.mjs`. It covers A's send after B opened the character (stored, no
  notice, A's edit kept, the stamp not older than B's); B's view of A's checkpoint while the job
  runs and of the final reply, both without a reload; B's send refused with one `chatGenerating`
  and its input kept. Flags on 26/26, flags off 18/18 (the server-job checks are skipped).

## 13d: graph memory and the MCP clients

### D1. Graph memory on a fresh chat

- `writeMemory` fails on a chat that never held `graphmem_graph`: the variable reads as the string
  `"null"`, `JSON.parse` gives `null`, and `graph.push` throws. Fix (`shared/mcp/graphmem.ts`): use
  the parsed value only when it is an array, else `[]`.
- `readMemory` finds nothing: both host adapters (the browser's `src/ts/process/mcp/graphmem.ts:13`, the
  server's `internal:graphmem` at `server/src/mcp/internal.ts:369`) call
  `processer.embedDocuments(names)`, which returns vectors without storing them, and then
  `similaritySearch` ranks the empty `vectors`. Fix: `addText(names)` in both adapters.
- Tests that pin the old behavior go to the test adapter: `server/src/tests/mcpInternal.test.ts`
  (the fresh-chat write expected to fail, the read expected to return no entries).

### D2. The MCP clients

In both the server client (`server/src/mcp/client.ts`) and the browser client
(`src/ts/process/mcp/mcplib.ts`):

- Event framing: events are split only on `\n\n` and lines on `\n`, and fields need the space
  (`data: `). Fix: one shared pure framer, `shared/mcp/sse.ts`: bytes in, complete events out,
  with CRLF, LF, and CR line ends (a CR at a chunk end held until the next byte), the field colon
  with an optional single space, and an optional byte bound (the server's
  `MAX_MCP_MESSAGE_BYTES`). Both clients use it; dispatch stays in each client.
- Session id: an `Mcp-Session-Id` header on an event-stream `initialize` answer is ignored (taken
  only from JSON answers). Fix: read the header before branching on the content type.
- Refresh rotation: a refresh answer's new `refresh_token` is not stored. Fix: when a 200 refresh
  answer carries a non-empty `refresh_token`, store it with the existing client metadata (server:
  `io.writeRefresh`, the `authRefreshes` collection; browser: `registerRefreshToken`); otherwise
  keep the stored one.

### Checks for 13d

The gates; a scratchpad Playwright check with a mock MCP server answering with CRLF events, an
event-stream `initialize` with a session id, and a rotating refresh token (server job and tab
paths); graph memory write then read on a fresh chat with a mock embedding model.

### 13d as implemented (after the challenge)

- D1 as planned. The host contract comment in `shared/mcp/graphmem.ts` names `addText(names)`.
- D2 framing: `shared/mcp/sse.ts` `SseFramer` delivers each event through a callback as it
  completes, so an event before an oversized one in the same chunk is still handled. A CR ends its
  line at once, and an LF first in the next non-empty chunk completes that CRLF. An empty chunk
  changes nothing (first challenge round: an empty chunk used to break a split CRLF). The browser
  drains a chunk's events by index, not with `shift()` (first round: quadratic for many small
  events).
- D2 session id and refresh rotation as planned. The server fences (`fenceIo`) before
  `writeRefresh`.
- Browser client lifecycle (rounds 1–4). `destroy()` now retires the client: a `closed` flag and
  `assertOpen()` at each request, handshake, and login entry and after each await. From then on
  the client starts nothing, and its late answers are refused: a session, server info, a list, a
  tool result, or a token or rotated refresh token. The 404/401 session reset is a private
  `reset()` that keeps the client usable and does not drop a valid pending refresh. Not covered
  (recorded in `plugins-mcp.md`):
  - a request already sent is not aborted;
  - a stream reader already running still dispatches;
  - the unused custom transport;
  - the inherited browser stream cleanup.
- Recorded hazard: a rotated refresh token is a whole-collection `authRefreshes` edit, which a
  concurrent writer can make conflict and be discarded.
- Check: `util/playwright/checkMcpFixes.mjs`, 16/16 with flags on (the server job) and 16/16
  with `FLAGS=off` (the tab). It fails with a non-zero exit when a check fails, and covers:
  - CRLF events, `data:` without the space, and an event split inside the CRLF;
  - the session id carried by later requests;
  - r1 → r2 → r3 rotation stored with the client id, secret, and token URL;
  - a graph write then read on a fresh chat, with the names and the query embedded;
  - a later read that embeds only its query (the cache).

  It observes, without failing on, the recorded first-401 hazard.
