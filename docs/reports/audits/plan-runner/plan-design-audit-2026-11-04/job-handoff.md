# Audit: docs/plan/job-handoff.md (dev @ d31fa9a48)

Anchor drift: `git log 186b9da71..HEAD -- server shared src` is empty, so the plan's code anchors still hold. Every
file:line below is at d31fa9a48. Client-side `generationJobs.ts` is `src/ts/network/generationJobs.ts`; server-side is
`server/src/jobs/generationJobs.ts`.

## Findings, most severe first

### 1. A takeover replays delivered callbacks, and the worker refuses every replay (the core rescue fails)

- Severity: P1 design flaw
- Plan: D2 lines 109-110 ("open requests replay to the new socket (`handleAttach`, unchanged)"); D7 lines 171-173; Slice 1 tests lines 218-220 and 225-226.
- Evidence:
  - channel.ts:786-794: on attach every outstanding request is re-sent as `build(request.delivered)`, so a request an owner socket already took is sent with `replay: true`.
  - server generationJobs.ts:747-757: `sendText` counts a send as taken whenever the socket is OPEN. A phone whose screen turned off keeps an OPEN socket until `expireSilentOwners` drops it after 45 s, so every callback dispatched in that window is `delivered`.
  - jobChannel.ts:111-113 ("a `replay` this page has no state for is refused (`failed`/`protocol`)") and :1281-1283 (`if (event.replay) { refuse(...) }`).
  - scripts.ts:319-327: `failed` on `editinput`/`editprocess`/`editoutput` raises `LuaJobFatalError`; requests.ts:313-322 ends `bodyIntercepter` jobs on a non-hook failure.
  - Nothing sends the old owner a `cancel`: D2 lines 118-119 give viewers "no channel request". The old tab keeps running the hook (MCP tool, provider request, open `alertConfirm` dialog), so side effects happen twice while only its answer is dropped.
- Result: the plan's main scenario (the phone sleeps in the middle of a callback, then a PC takes over) ends the job with a protocol failure. It does not hand the callback over. The Slice 1 server tests pass only because a fake socket answers the replay. The Slice 4 driver closes page A before any callback goes out, so it never sends a delivered request.
- Correction: decide replay semantics explicitly. At takeover, send `cancel` to the previous owner's sockets for each outstanding request. Then either re-deliver to the new owner as a first delivery (`replay` false; accepts at-least-once for side-effecting kinds) or settle those requests `disconnected` so today's skip/fail policy applies. Add a Slice 1 test and a Slice 4 case with a delivered, unanswered callback at takeover.
- Confidence: verified (code paths); not reproduced.

### 2. Lanes keyed by the creator break the tab's one-root-callback rule

- Severity: P1 design flaw
- Plan: D1 lines 96-98 ("the request lanes stay keyed by the creator").
- Evidence:
  - channel.ts:264-281: the hub keeps one lane per client because "the tab runs one root callback at a time"; :292-298 `laneOf(clientId)`; :506-518 `pump`.
  - jobChannel.ts:114-118 ("One root callback runs at a time in this tab (the server's lane per client)").
  - jobChannel.ts:1285-1297: a root that arrives while `outstanding.length > 0` is refused as `failed`/`protocol`.
- Result: a worker that runs its own job (its own lane) and a handed-off job (the creator's lane) can get two roots at once. It refuses the second, which fails that job. The reverse also happens: a handed-off job's callbacks wait behind the creator's other job in the creator's lane (for example a job the sleeping phone still owns, up to 120 s). Drain holds (channel.ts:344-364) for a callback the old owner still runs also block the creator's lane. A former worker cannot clear its hold through `/drained`, because it is no longer a participant, so the hold stands until `CANCELLED_CALLBACK_DRAIN_MS` (60 s, shared/jobs.ts:776).
- Correction: key lanes by the current owner. Make `transport.clientId` a getter over `ownerClientId`. On takeover, move the job's queued requests to the new owner's lane and keep only the old owner's drain holds on the old lane. Keep the creator for receipts, `owned`, and attribution only.
- Confidence: verified.

### 3. `attachStamp` compares wall-clock stamps from different devices

- Severity: P1 design flaw (not mentioned in the plan)
- Plan: D2 lines 104-113 and D4 line 145 never mention the stamp.
- Evidence:
  - server generationJobs.ts:396-397: one `attachStamp` per job. :2100-2108 answers 409 when `stamp < job.attachStamp`; :2113 closes the socket on the same test.
  - src/ts/network/generationJobs.ts:847-852: the stamp is `performance.timeOrigin + performance.now()`, the device's wall clock.
- Result: if the phone's clock runs ahead of the PC's, the PC's takeover right after the phone's attach (`preferred` opens at admission) is a 409. Later, a viewer reattach from the phone raises the job's stamp and makes the worker's own reattaches 409 until its clock passes it. The follow allows only `MAX_ATTACHES` 5 with waits of 1+2+4+8+8 s (serverCommands.ts:100-101), so a skew of about 23 s or more loses the job.
- Correction: keep the newest stamp per client (`Map<clientId, number>`) and compare only within one client. Neither a viewer attach nor a takeover may move another client's stamp.
- Confidence: verified (code); likely in practice.

### 4. Skipped `chatOutput` listeners are lost when the owner at the job's end is a dead worker

- Severity: P1 design flaw (lost plugin effects compared with today)
- Plan: D2 lines 114-116 and 119-120; D5 lines 151-155.
- Evidence:
  - Today the returning creator gets the ended job's terminal on attach (server generationJobs.ts:1987-1991) and runs `replaySkippedListeners` (serverCommands.ts:293-310).
  - Under D2, the creator attaches as a viewer "whatever it asked", and viewers get `skipped: []`.
  - The kept outcome and the receipt stay keyed by the creator (server generationJobs.ts:2206-2212). A worker that comes back after collection cannot read the kept outcome at all.
- Result: scenario: the phone hands off, the worker tab closes, and no tab takes the `absent` offer before `chatOutput` expires (the phone is asleep, which is the plan's own case). The job ends with `skipped` addressed to a gone owner, nobody ever replays it, and today's late replay is lost.
- Correction: if no owner socket is attached at the end, the skipped list belongs to the first participant to attach after the end, the creator included, and is then cleared. Let `status`/kept reads by the owner at the end work as well.
- Confidence: verified (code and plan text).

### 5. The status, kept, and replay paths still hand viewers the unstripped `skipped` list

- Severity: P2 (D5's mechanism is incomplete)
- Plan: D5 lines 151-152 ("the terminal path never replays skipped listeners (the terminal says `skipped: []`)"); Slice 1 line 207 ("the terminal's `skipped` per role").
- Evidence:
  - server generationJobs.ts:1929-1940: `status(job)` returns `job.terminal` as is.
  - serverCommands.ts:642-666: `followOnce` reads the status after every close and uses `status.terminal`.
  - serverCommands.ts:238-245 and :297: an ended status from discovery or a replay feeds `lateListeners` the same way.
  - The create replay `replayStatus(status, owned)` (server generationJobs.ts:361-365) only removes `result` for non-owners.
- Result: a creator-viewer whose socket dropped near the end replays the listeners from the status read, and so does the owner: they run twice.
- Correction: strip `skipped` per role in `status()`, in kept outcomes, and in the create/cancel replays as well as on the socket. Or key the tab-side skip on the role the tab knows (Slice 2 line 234) and say that this, not the server's `skipped: []`, is the guard.
- Confidence: verified.

### 6. Takeovers are first-come only in prose: a second takeover steals the job, and the tab cannot see 409 or 404

- Severity: P2 internal contradiction plus wrong mechanism
- Plan: D2 lines 107-113 (any `takeover=1` on a running job succeeds; 409 only for an ended job or shutdown) contradicts D4 line 145 ("The server picks the first attach; a 409 or 404 drops the offer here"). D6 line 163 has the same assumption.
- Evidence:
  - Nothing in D2 refuses a second takeover. `acceptHandoffs` lives in `localStorage` (D4 lines 139-141), so every tab of the PC browser is a worker and they all race for each offer.
  - The browser cannot read the HTTP status of a refused WebSocket handshake: src/ts/network/generationJobs.ts:958-968 sees only a close (1006).
  - The follow then reads the status: serverCommands.ts:651-656, where a non-participant gets null and the result is `"gone"`, then :226-231 `releaseGenerationJob`. A lost race therefore runs the gone path (chat read again, `endedAway`). It does not drop silently.
- Correction: allow a takeover only against an open offer (or a `target` match), and close the offer atomically at the first takeover so the next one is refused. Make the refusal observable: `POST /:id/takeover` answering 200/409/404 before the attach, or accept the upgrade and close it with a dedicated 4xxx code. Do not go through `followJobToEnd`'s gone path for a refused takeover.
- Confidence: verified.

### 7. An `absent` offer never closes when the owner reattaches, and it opens on every close

- Severity: P2 design flaw
- Plan: D3 lines 133-138 ("It closes on takeover and on the job's end").
- Evidence:
  - server generationJobs.ts:698-706: `removeOwner` empties the set on any close.
  - :1949-1957: `attach` clears `ownerAbsentSince` but closes no offer in the plan.
  - src/ts/network/generationJobs.ts:888-900 and serverCommands.ts:612-640: a routine reattach (`resumeReconnect`, `stale`) closes the old socket before the new attach.
- Result: every reconnect of a healthy owner opens an offer that stays open after the owner is back. A worker with `acceptHandoffs` then takes the job from a present owner, including a PC owner that only reloaded.
- Correction: close the `absent` offer when an attach clears `ownerAbsentSince`. Open it only after a grace period (for example at the silence deadline, or N seconds after the set empties). This also matches the Goal's "the owner went silent" (line 43).
- Confidence: verified.

### 8. The creator cannot take its own job back through `followJobToEnd` while its viewer follow runs; D2's viewer rule is ambiguous

- Severity: P2 contradiction
- Plan: D4 lines 142-145 (the creator takes its own `absent` job back with `followJobToEnd(jobId, ref, undefined, { takeover: true })`); D2 line 114 ("attached as a viewer, whatever it asked") against D2 line 107 ("Any authenticated client attaching with `takeover=1`"); Slice 4 line 283 ("an `absent` offer that A, still open, takes back").
- Evidence: serverCommands.ts:126 and :221-223: `followJobToEnd` is deduplicated per job id (`following.get(jobId)`). While the creator's viewer follow runs, the call returns the existing promise, and the takeover option never reaches an attach.
- Correction: state that `takeover=1` overrides the creator-as-viewer rule. Switch roles inside the running follow (a new `followGenerationJob` with `takeover`, which supersedes the current socket through `currentFollows`) instead of calling `followJobToEnd` again.
- Confidence: verified.

### 9. Notices are not only toasts and dialogs: withholding them all from viewers moves device effects to the worker

- Severity: P2 design flaw
- Plan: D2 lines 118-119 ("no notice (toasts and dialogs show on the owner only, Q3)"); Q3 lines 194-196; Goal lines 41-42 (the creator "keeps every right it has today").
- Evidence: jobChannel.ts:363-452 `applyEffect` handles `emotion`, `progress`, `memoryProgress`, `reloadChat`, `translating`, `tts`, `notification`, and `openURL`. Only :279-280 are UI-queue notices.
- Result:
  - The creator's phone loses emotion images, the HypaV3/structured-memory progress, and with it the only way to reach D1's `memory-stop` participant right. It also loses translation-loading state and the completion notification.
  - The unattended PC speaks the TTS, shows the completion notification, and opens MCP OAuth pages.
- Correction: split notices into three groups:
  - modal/UI (`alert*`, questions): owner only;
  - presentation effects (`emotion`, `progress`, `memoryProgress`, `translating`, `reloadChat`): every socket;
  - device effects (`tts`, `notification`): the creator's sockets, while `openURL` stays with the owner that runs the MCP.
- Confidence: verified (code); the split is a recommendation.

### 10. Viewer sockets get no pings, so the client drops them every 45 s of quiet

- Severity: P2 design flaw
- Plan: D2 lines 108-109 (sockets "move to the new `job.viewers` set") and 121-122 ("A viewer socket is not negotiated: its silence changes nothing").
- Evidence:
  - server generationJobs.ts:2002-2007: the heartbeat pings only `if (job.sockets.has(ws))`.
  - socketLiveness.ts:15 (`STALE_AFTER_MS = 45_000`) and src/ts/network/generationJobs.ts:888-898: the follow abandons a socket with no frame for 45 s.
- Result: during a long hook or a non-streaming provider call, the creator-viewer reattaches every 45 s. A former worker that was moved to viewers gets 404 on reattach and runs the gone path.
- Correction: ping every socket of the job and ignore only the viewers' silence.
- Confidence: verified.

### 11. A tab is told its role only on a change; the boot resume reads a status that has no owner field

- Severity: P2 (D5 cannot work as written)
- Plan: D2 lines 122-124 ("Each role change is one job event"); D1 line 101 (`GenerationCurrent.handedOff`); D5 lines 150-152 ("the saved job resumes at boot as a viewer"); Slice 2 line 232 (`readChatGeneration`'s `handedOff`).
- Evidence:
  - The boot resume is serverCommands.ts:711-718 → `followJobToEnd(jobId)` → `discover` (:551-566) → `readGenerationJob` (`GET /api/generations/:id`, src/ts/network/generationJobs.ts:744). It never reads `/current`.
  - `GenerationStatus` (shared/jobs.ts:827-839) has no owner or handed-off field.
  - An attach that the server turns into a viewer is not a role change, so it carries no `handoff` event.
- Correction: start every attach's snapshot with that socket's role (`{ type: "handoff", owner }`). Optionally add `handedOff` to `GenerationStatus` too. `GenerationCurrent.handedOff` alone reaches only the Stop lookup.
- Confidence: verified.

### 12. "Whole mode only" for viewers sends the whole chat to the phone every 3 s while streaming

- Severity: P2 (an unnecessary cost)
- Plan: D2 lines 110-112 and 117.
- Evidence:
  - `sentChat` is one baseline per job, shared by every socket of the stream (server generationJobs.ts:414, :934-941).
  - Checkpoints run every `CHECKPOINT_INTERVAL_MS` = 3000 (runner.ts:91, :1715-1727). Each one goes through `writeOwn` → `emitRecords` (runner.ts:408) → `deliverJobChat(job, "patch")` (server generationJobs.ts:1468-1477).
  - In whole mode each of those becomes a whole read and send to every viewer. A viewer whose whole copy is refused for local work asks to resync (src/ts/network/generationJobs.ts:1181-1186), and D2 ignores that request, so the viewer stays stale.
  - incremental-chat-transport.md D3 cuts the owner patch to a few hundred bytes. Viewers would get none of that saving.
- Correction: send the takeover's whole copy to the viewers too, so every socket holds `sentChat` and one patch stream serves them all. Answer a viewer's `resync` with a whole copy to that socket alone. Or state the cost and limit whole sends to viewers to the terminal and the barrier.
- Confidence: verified (cost); the design choice is the owner's.

### 13. Aux requests from inside a worker's hook are refused

- Severity: P2 design gap
- Plan: D1 lines 99-100 list the participant routes but not the aux parent lookup; Slice 1's files (lines 206-214) omit it.
- Evidence:
  - server generationJobs.ts:2172-2178: `parentCallback` uses `ownJob(jobId, clientId)`.
  - The route is `POST /api/llm/request` with `channelCall` (routes/llm.ts:166-173, :231 "409 for a `channelCall` that is not running").
  - The worker's hook sends its own `clientId`, so the lookup fails.
- Correction: check `parentCallback` against `ownerClientId` (owner only, not every participant) and list it in D1 and Slice 1.
- Confidence: verified.

### 14. Wrong claim: a hook the worker has not registered does not "return the text unchanged"

- Severity: P2 (a wrong claim about current behavior that changes the accepted risk)
- Plan: D2 lines 125-128; Out of scope lines 312-313. A related error is Slice 2 lines 236-237 (a callback on a viewer "is answered `unregistered`").
- Evidence:
  - jobChannel.ts:767 (`unavailable`) and the throws at :773, :784, :799, :813, :845: `runHook` throws `unavailable()`, which becomes `failed`/`protocol`, and scripts.ts:319-327 then ends the job.
  - Text is kept only for the server-side `refused`/`unregistered` result, which comes from `hasHook` (channel.ts:650-656) and is handled at scripts.ts:311-315.
  - The tab cannot send `refused`: `readAnswer` (channel.ts:232-260) returns null for it, so such an answer is ignored and the callback waits until its deadline.
- Correction: state that a hook missing on the worker fails the job (request hooks) or the callback. Either make `runHook` answer `answered` with the unchanged input for a missing edit/replacer hook, or refresh the hook list at takeover. For a callback that reaches a viewer, use an existing answer (`failed`/`protocol`), or none at all, since viewer answers are ignored anyway.
- Confidence: verified.

### 15. Stop attribution: neither device learns who stopped

- Severity: P3
- Plan: D1 lines 95-97 (`stoppedByOther` stays the creator's); D5 line 151 ("Stop works").
- Evidence:
  - The Stop for a followed job is `abortGenerationJob` (`DELETE /:id`; DefaultChatScreen.svelte:786-798, src/ts/network/generationJobs.ts:785-797).
  - That path never sets `stoppedByOther`. Only `/stop` sets it (server generationJobs.ts:1814).
- Result: when the worker's user stops the job, the phone shows a plain abort, and the reverse.
- Correction: on a participant abort, record which client stopped, and give the terminal `abortedBy: "other"` on the other participant's sockets.
- Confidence: verified.

### 16. The plan still sequences against the retired server plugin runtime plan

- Severity: P3 stale claim
- Plan: lines 200-202 ("not in parallel with the server plugin runtime plan's Slices 1, 4, or 5"); lines 48 and 310 cite it as the route for "hooks without any tab". Lines 24-25 say that plan was retired unbuilt.
- Evidence: docs/archived-plan/README.md:113 ("Server Plugin Runtime (retired unbuilt)").
- Correction: remove that sequencing rule. If one is needed, name the live conflicts instead: incremental-chat-transport.md lines 35-38 already forbids running its Slices 2-3 in parallel with this plan's Slices 1 and 3.
- Confidence: verified.

### 17. The handoff route lands in Slice 1, but its tests are in Slice 3

- Severity: P3 dependency inconsistency
- Plan: Slice 1 files line 211 (`POST /:id/handoff`), but its tests (lines 216-226) do not exercise the route. Slice 3 tests it (lines 266-267).
- Correction: move the route's 404/`requested` tests into Slice 1, or move the route into Slice 3.
- Confidence: verified (plan text).

### 18. Smaller anchor and claim issues

- Severity: P3
- Slice 2 line 235 (chatStatus.svelte.ts change): moving a taken-over job from `foreignJobs` to `followedJobs` already happens. `followJobToEnd` calls `clearForeignJob` (serverCommands.ts:232), and the `followedJobs` subscription prunes foreign marks (chatStatus.svelte.ts:381-401). Slice 2's test (line 251, "and back on its end") reads as if the job returns to `foreignJobs` after it ends. It should leave both.
- Slice 4 line 274 ("whose plugin-install and settle helpers it reuses"): `util/playwright/checkJobProtocol.mjs` exports nothing; its plugin install is inline (about :202-276). The helpers have to be extracted into `stack.mjs` or a shared module first.
- D2 lines 112-113 (a takeover "while the server shuts down, is a 409"): today a disposed registry answers 404 (server generationJobs.ts:2096-2098). This is fine as a new rule, but it should be stated as one.
- D8 lines 179-180 (an older server answering 404): the server serves the client, so this pairing is near-impossible. In any case the browser cannot see the 404 (see finding 6).

## Checked and found sound

- `ownJob` is the single gate for status, abort, `drained`, `memory-stop`, and the socket upgrade; any other client gets 404 (server generationJobs.ts:1775-1778, :2075-2098, :2198-2246).
- `attach` (server generationJobs.ts:1949-2068):
  - closes superseded sockets with 4001 and clears `ownerAbsentSince`;
  - sends the job chat as a patch from `sentChat` while running, whole once ended;
  - then sends fresh records, the preset, the stage, the current reply, and the terminal;
  - then calls `handleAttach`.
- Answers, pongs, and resyncs: `frame()` accepts them only from a socket in `job.sockets`.
- Absence and silence:
  - `removeOwner` sets `ownerAbsentSince` when the set empties;
  - `expireSilentOwners` drops a socket silent for `OWNER_SILENT_MS` = 45 s;
  - the absence cap is `ownerAbsentSince + OWNER_ABSENT_MS` (120 s; channel.ts `absenceDeadline`/`effectiveDeadline`);
  - `ownerChanged()` exists (channel.ts:691-698);
  - the absence cascade checks each entry's own `ownerAttached` (channel.ts:436-442).
- Skipped hooks: `done.skipped` and `replaySkippedListeners` with the `hooksSkipped` toast behave as the Current state describes (serverCommands.ts:36-49, :293-310, :702-707; jobChannel.ts:1142).
- The tab's follow:
  - `followJobToEnd` pins the chat and loads it through `ensureChatLoaded` (serverCommands.ts:532-544);
  - it attaches with `liveness=1&hydration=patch&attach=<stamp>` (src/ts/network/generationJobs.ts:913-917);
  - `resumeServerJobs` follows the saved jobs;
  - `chatsOfRead` exists (v3.svelte.ts:920).
- The live-update socket ignores incoming messages (events.ts:132-133), keeps an identity-less `Set<WebSocket>`, and builds `hello` synchronously. D6's `register` message is therefore new.
- D8's open item is already true today: `eventFeed.ts` `receive` (:260-302, guarded by `isFrame` :140-142) and `applyGenerationEvent` (src/ts/network/generationJobs.ts:1130-1240) have no default branch, so unknown `type`s are ignored, not thrown.
- D7's precedent holds: `/current` and `/stop` already serve any authenticated client (server generationJobs.ts:1787-1816; routes/generations.ts:311-349).
- `pluginsStarted()` exists (plugins.svelte.ts:582).
- The named tests exist: server/src/tests/{generationJobs,jobChannel,events,promptTail}.test.ts; src/ts/network/{eventFeed,generationJobs}.test.ts; src/ts/process/{serverCommands,chatStatus}.test.ts; util/playwright/checkJobProtocol.mjs; e2e/perChatSends.spec.ts.
- The UI and preference anchors hold:
  - `NotificationToggle.svelte` is under src/lib/Setting/Pages/Display/;
  - `REGISTERED_KEY` is a `localStorage` key (pushNotifications.ts:60);
  - the Stop for a followed job uses `DELETE`, which a participant check would cover for the worker.
- Every guide section the plan names exists: server-generation (Generation channels, Job chat and barriers), global-api (Generation job client, Job channel), chat-pipeline (Stop for a job this tab does not follow, Replays and uncertain creates), resource-sync (Live updates), plugins-mcp (Job owner presence).
