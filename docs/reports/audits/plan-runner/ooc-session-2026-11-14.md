# OOC Session Plan audit, 2026-11-14

- Plan: `docs/plan/ooc-session.md`
- Commit audited: `05b4378da` (`claude/ooc-session-brainstorm-0f9309`, on `dev` at `d2d1a76a7`); the corrected plan is
  committed with this report
- Mode: `full`
- Model: GPT-6-Astra at `xhigh`, read-only, in place of the usual Sol session at the owner's request (the plan mixes
  server and tab work); report written by the session that drafted the plan (Claude Fable 5.2), before any
  plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 2     |
| P2         | 9     |
| P3         | 6     |
| unverified | 0     |

Every finding is `fixed in plan`. The audit ran as three turns of one session. The first read the draft and found F1
to F12 (one P1, five P2, six P3). The drafting session read F1, F2, F3, F4, F7, and F8 against the code before
editing and took the rest from the auditor's line references. The second turn read the corrected plan: it confirmed
nine fixes, disputed three (F1, F2, F4), and found N1 to N3 in the corrections (one P1, two P2). The third turn read
the second round: it confirmed N1 to N3 and found M1 and M2 (both P2). M1, M2, and the third turn's note on the tab's
error hook were applied afterwards and were not read again.

The draft's mechanism for the server half did not survive. It laid a view over the readers of the job's chat, as a
reroll does, and guarded two writers. The audit showed more writers than that (F1), then that a copy guarded write by
write has no defined lifetime (N2). The corrected slice 2 does one thing instead: the runner detaches the job's scope
and sets the cut history, the tail rows, and the forced toggles on the scope's own copy of the chat, so the readers
do not change and no write of the job is stored.

Two corrections are product choices the owner has not read yet, and the plan's Status line says so:

- **D24** (from F4 and N3). The anchor cuts the message list, not the memory. With SupaMemory or legacy Hypa, a
  question whose cut history holds no usable memory cursor ends with `oocMemoryAhead` and the panel asks for a
  refresh. The alternative, rebuilding a summary for the cut history on every question, was not taken.
- **The plugin limit in D14** (from M1). A tab plugin's hook called during assembly reads and writes the stored chat,
  as in any preview. The alternative, skipping plugin hooks in an OOC preview, would drop their effect on the prompt.

One suggestion of the auditor was not adopted, and the auditor agreed in the second turn: a server capability check
before the preview job is created (part of F1). A server from before slice 2 drops the request field and runs a plain
preview with the writes any preview makes today, on the uncut chat; the tab's check of the result's echo then stops
the answer request.

The slice 1 half (the stored fields, the preset field, copy, branch, import, checkpoints) held as drafted apart from
the prune rule (F6).

The auditor changed no file in the repository (`git status` was clean after the first turn and showed only the plan,
edited by the drafting session, after the others; the plan's hash was the same before and after each re-check turn)
and ran no test: the worktree has no `node_modules`.
The three turns took about 29, 16, and 5 minutes and 17.6 M tokens.

Found consistent: the preview's fixed parser, fingerprint, slot admission, and scope load
(`server/src/routes/generations.ts:213`, `server/src/jobs/generationJobs.ts:381`, `:2267`,
`server/src/jobs/jobScope.ts:215`); a preview returning before the reply request and before later speakers
(`server/src/prompt/runner.ts:1794`, `:630`); both toggle read sites reaching `resolveGlobalChatVar`
(`server/src/jobs/cbsHost.ts:244`, `server/src/prompt/assemble.ts:1176`, `shared/prompt/toggles.ts:149`) and the job
roots coming from the chosen prompt preset, a chain pick included (`jobScope.ts:295`, `shared/sections.ts:463`);
disabling the start trigger keeping `runOnCopy` from applying its chat (`server/src/jobs/runSetup.ts:413`);
metadata normalization running after a merge, so the new validators can refuse atomically
(`server/src/data/chatStore.ts:2452`); independent map entries merging (`:2423`); the preset schema driving
normalization, forwarding, copy, export, and import (`shared/presets.ts:310`, `:564`, `shared/sections.ts:369`,
`src/ts/storage/presets.svelte.ts:43`, `:134`, `:205`); copy and branch keeping message ids
(`src/lib/SideBars/SideChatList.svelte:139`, `src/lib/ChatScreens/Chat.svelte:1995`); the local import keeping valid
message ids when the chat id is rewritten (`src/ts/characters.ts:637`, `src/ts/storage/chatStore.svelte.ts:1678`);
checkpoint `keep` copying current metadata (`server/src/data/checkpointStore.ts:515`); the upstream strip list
(`server/src/data/upstream/exportDatabase.ts:1115`); synthetic tail ids being safe for `eligibleHistory`, lore, the
context report, and Structured Memory when they are unique valid `Message.chatId` values
(`shared/eligibleHistory.ts:18`, `shared/lore/activation.ts:342`, `assemble.ts:1921`,
`server/src/prompt/memory/structured/step.ts:195`); the serial order 1 to 5; and every guide and section the plan
names. D8's counts hold as orders of magnitude (34 production files under Structured Memory's server and panel
folders).

For the detached scope the third turn traced every place that could put the stored chat back into a job's scope
(`jobScope.ts:238`, `:315`, `:676`, `:728`, `:852`, `runner.ts:454`, `:538`, `server/src/lua/bindings.ts:468`) and
every `job.write` site a preview can reach (`bindings.ts:519`, `:648`, `:888`, `jobScope.ts:585`); the corrected
slice 2 covers each or cannot reach it.

Re-check list: `patchMessage` still closes an open fence (`server/src/data/chatStore.ts:2567`); feed bodies are still
capped whole at 64 KiB (`shared/resources.ts:534`, `chatStore.ts:1895`); `STORE_TABLES_SQL` still runs only on a fresh
database (`server/src/data/resourceStore.ts:3855`); `sendText` still counts an open socket
(`generationJobs.ts:1024`). The plan depends on the second only through F11, and on none of the others.

## P1

### F1. Synthetic tail ids and two disabled hooks did not make the preview read-only

- Plan (Rules; D15; slice 2): "The chat's messages are never written by an OOC question." "Tail rows carry synthetic
  ids that name no stored message … and every other write by id skip them." Slice 2 disabled `runStartTrigger` and
  `writeMemory`.
- Code: `runCurrentChatFunction` parses every viewed message with `runVar` and writes the changed text when the id is
  in the stored chat (`runner.ts:1502`, `:1516`); the rows before the anchor keep their real ids. `@@inject` rewrites
  a stored row (`server/src/prompt/scripts.ts:352`, `:375`). A CBS `setvar` queues a `scriptstate` write the metadata
  flush stores (`shared/cbs/registry.ts:896`, `bindings.ts:574`, `jobScope.ts:585`). The trim without a memory
  algorithm stores `lastMemory` past `writeMemory` (`assemble.ts:2184`, `runner.ts:1688`). A summary request made
  inside the job lists tools and can store a tool-call record (`runner.ts:830`, `bindings.ts:1020`, `:1110`). An
  OOC-dependent CBS expression in a stored message would have changed the transcript for good.
- `fixed in plan`: see N1 and N2 for the final form. The first correction made the bindings' `writeChat` and the
  metadata queue the two boundaries; Current State lists the writers; the memory step's requests get no tool set.

### N1. Keeping `editRequest` left character writes outside the isolation

- Plan (first correction, Rules and slice 2): "The only writes of an OOC question are the tab's `oocLog` and
  `oocSegment`." "`editRequest` runs as in any preview, on the detached chat."
- Code: the handler runs with safe access (`scripts.ts:87`, `server/src/lua/runtime.ts:652`); `setName`,
  `setDescription`, `setCharacterFirstMessage`, and `setBackgroundEmbedding` call `patchCharacter`, whose `job.write`
  stores the character (`bindings.ts:1570`, `:1593`, `:1612`, `:1635`, `:648`). Image getters and provider replies can
  also store media outside `job.write` (`bindings.ts:1794`, `:888`, `src/ts/network/jobChannel.ts:988`).
- `fixed in plan`: `patchCharacter` answers false for a detached scope, which the setters treat as a missing character
  without throwing (`bindings.ts:1577`, `:1619`). The Rules bullet names what stays as in any preview: stored media.

## P2

### F2. `editRequest` already runs inside the preview

- Plan (D16): "It has no tools, no `request` trigger, no `editRequest` or output scripts."
- Code: `assemblePrompt` calls `host.runEditRequest` before the preview returns (`assemble.ts:2525`, `runner.ts:1666`,
  `:1794`).
- `fixed in plan`: D16 says `editRequest` has run in the preview. It is kept (the prompt is the one a send would get)
  rather than made an identity function, as the auditor first suggested; N1 closes its write path.

### F3. The tab request as specified listed tools and assumed a stream

- Plan (D16; slice 3 steps 5 and 6): "Calls `requestChatData` with the result's `messages`, the `chatRef`,
  `useStreaming: true`, and its own abort signal"; "On the end of the stream it merges the answer".
- Code: without `tools` the request lists the chat's tools, runs the model's calls, and stores their records
  (`src/ts/process/request/request.ts:378`, `src/ts/process/request/transport.ts:224`, `:470`, `:566`). `bias` is
  required (`request.ts:57`). Streaming depends on the provider's setting, and the result can be buffered,
  `multiline`, or a failure; a stream can fail midway (`request.ts:127`, `transport.ts:605`, `:620`).
- `fixed in plan`: the call passes `bias: {}`, `tools: []`, and `noMultiGen: true`; step 5 reads every result type;
  step 6 stores only a complete answer.

### F4. A cut history can break legacy memory although its writes are dropped

- Plan (Goal; slice 2): "the chat's history cut at the segment's anchor message"; "the host's `writeMemory` drops the
  write".
- Code: SupaMemory and legacy Hypa search the given history for their stored cursor and return "chat ID not found"
  (`server/src/prompt/memory/supaMemory.ts:115`, `:128`). After the main chat's summary moved past an anchor, a
  follow-up in that segment would fail with a plain memory error. HypaV2 filters by source (`hypav2.ts:241`), HypaV3
  unless `preserveOrphanedMemory` (`hypav3.ts:482`), and Structured Memory reads current pages and threads
  (`structured/step.ts:256`).
- `fixed in plan`: D24 (new), with N3's wording. The two returns are marked and an OOC job ends with the coded alert
  `oocMemoryAhead` (`assemble.ts:325`, `runner.ts:1778`); the panel asks for a refresh.

### F5. Ask, retry, and completion did not share the rules the Decisions set

- Plan (slice 3 step 2; D10; D7): "one whose anchor names no message, gets a new segment at the newest message
  first" against "the segment cannot be asked in and the panel asks for a refresh"; "`retryOoc`: steps 4 to 6".
- Code: the busy guard is the caller's (`src/ts/process/chatStatus.svelte.ts:89`); a merge adds a removed entry back
  (`server/src/data/chatStore.ts:2440`, `:2445`), so a late answer would recreate a deleted exchange.
- `fixed in plan`: one set of guards for ask and retry; a first segment is made only when the chat has none; a gone
  anchor refuses; retry is for the current segment; completion checks that the exchange still exists; deleting the
  exchange in flight stops it.

### F6. The prune could remove the attachment being sent

- Plan (Goal; slices 1 and 3): "They stay part of the segment's context for its later questions"; `oocPrune` "oldest
  first, never from the current segment".
- Code: a removal deletes the map entry and nothing keeps a copy (`chatStore.ts:2440`,
  `src/ts/storage/chatStore.svelte.ts:4581`).
- `fixed in plan`: `oocPrune` takes the ids to keep and never names an exchange the current segment attached or the
  next question picks; with nothing removable the question is refused. D18 says the user's own delete still can.

### N2. The detached copy had no defined read, refresh, and teardown lifetime

- Plan (first correction, slice 2): "`writeChat` applies its ops to the job's own copy of the chat and stores
  nothing"; "The view is removed when the send ends, as the reroll view is."
- Code: `refreshChat` replaces the scope's chat after any stored revision change (`jobScope.ts:676`, `:689`); the view
  would have been removed in the speaker's `finally` before the preview's metadata flush (`runner.ts:2414`, `:631`,
  `generationJobs.ts:1970`). There is no pure reducer of chat ops (`jobScope.ts:756`,
  `src/ts/storage/journalRecovery.ts:848`), and dropping writes is not the same: assembly reads back after
  `runCurrentChatFunction`, and HypaV3's checkpoint compares what it wrote (`assemble.ts:1202`, `:867`).
- `fixed in plan`: the detached scope described above. The chat is materialized once, `refreshChat` leaves it, the
  queue registers no flush, a new pure reducer applies `writeChat`'s ops and replaces the chat object so the caches
  drop, and the scope stays detached until the job ends. The readers of slice 2's first draft no longer change.

### N3. The two marked returns do not mean "the summary ends after the anchor"

- Plan (first correction, D24): "a summary that ends after the anchor cannot be placed in the cut history".
- Code: Supa's id names the first message the summary does not cover; stored memory is read only over the context
  limit; legacy Hypa can fall back to an older snapshot (`supaMemory.ts:21`, `:46`, `:91`).
- `fixed in plan`: D24 and the slice's test name the real condition: stored memory is needed and the cut history
  holds no usable cursor.

### M1. A tab plugin's hook is outside the detached scope

- Plan (second correction, slice 2): "Every reader then gets the cut history, the tail, and the forced toggles from
  the scope".
- Code: assembly calls a plugin's `editprocess` hook with the text (`assemble.ts:1794`, `scripts.ts:297`); the plugin's
  chat reads and `parseRisuChat` go to the tab's store, and its writes have their own persistence
  (`jobChannel.ts:823`, `:1289`, `src/ts/plugins/apiV3/v3.svelte.ts:2966`, `:3008`).
- `fixed in plan` as an accepted limit, not read again by the auditor: D14 and the Rules say a plugin hook reads and
  writes the stored chat as in any preview. Open for the owner (see above).

### M2. The external-writer test contradicted byte equality

- Plan (second correction, slice 2 test): "The stored chat is byte-equal after each of … a stored write by another
  writer during the job".
- Code: that writer's change is stored (`chatStore.ts:2452`).
- `fixed in plan`: the case now expects the store to hold that write and nothing of the preview.

## P3

Each is `fixed in plan`.

- **F7.** D20 and Current State: "controls that act on the main chat's message at the given index". Without a
  `messageId` the controls write nothing (`Chat.svelte:508`, `:672`, `:698`). D20 now gives the real reason
  (`Chat.svelte` brings transcript controls), and slice 4 passes `idx={-1}` so `ChatBody.svelte` does not take a row
  for the first message (`ChatBody.svelte:118`, `:226`, `src/ts/parser/transformClient.ts:948`). The panel shows the
  selected chat's session, since `ChatBody.svelte` has no chat prop.
- **F8.** Slice 3 named no bridge file. `ServerJobRequest.context` is a fixed `Pick`, and `previewChat` keeps only the
  messages (`src/ts/process/serverCommands.ts:1012`, `src/ts/process/index.svelte.ts:77`). The slice extends the
  `Pick`, calls `runServerJob`, and pins the chat from the first write to the last.
- **F9.** "the prompt transform's digest is covered by slice 2's change": the display transform is a request of its
  own over the stored chat (`server/src/prompt/transform.ts:784`). Current State says so.
- **F10.** "the context meter's lookahead preview": there is none; the meter reads the last report and counts tokens
  (`src/lib/ChatScreens/ContextMeter.svelte:94`, `:377`). The claim is gone.
- **F11.** D9, "one exchange travels per write": true of the submitted op; the feed may send the whole metadata, an
  entry delta, or a refetch manifest (`chatStore.ts:2006`, `:3055`, `shared/resources.ts:534`). D9 says so.
- **F12.** "A result without `ooc: true` is an older server": a kept outcome or a receipt has no result at all
  (`generationJobs.ts:594`, `:615`). Step 3 tells a well-formed result without the echo from a terminal without a
  result; both make no request.

Also applied from the third turn's notes, not as findings: the three OOC codes need a hook of their own on the tab,
because `loreStopCaller` suppresses only a `loreOverBudget` end with its payload and `reportEnd` runs before
`runServerJob` returns (`serverCommands.ts:470`, `:954`, `src/ts/process/jobLoreStop.ts:13`); slice 3 adds one. The
slice 2 test for the tail uses a template that ends with the history, since a template can append after it
(`assemble.ts:2398`).

## Noted, not recommended

- The log's limits multiply to about 50 MiB (200 exchanges of 256 KiB). A large import or refetch would be slow, not
  lossy (`server/src/app.ts:167`).
- An import with invalid or duplicate message ids is repaired without remapping OOC anchors
  (`server/src/data/chats.ts:191`); D10 handles the anchor that results.
- Plugin replacers and the request's own CBS (a JSON schema, stop strings) see the stored chat in the tab request
  (`request.ts:420`, `transport.ts:387`); D16 names both.
