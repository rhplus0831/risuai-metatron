# Job Handoff Plan

Status: drafted 2026-11-03, revised 2026-11-04 after the design audit
([plan design audit](../audit/plan-design-audit-2026-11-04.md), items JH1–JH5, X2, X4, X5) and again after its
adversarial challenge. Landed: 1 (d60741baf), 2 (5ea1222a4), 3 (c9344075d), 4 (0a9c56d20). Decisions D1–D8 are recommendations for the owner; the **Open
questions** Q1–Q3 were answered by the owner on 2026-11-03 (the recommended option each time; Q3's answer is
superseded by D2's notice groups) and Q4 on 2026-11-04. Code anchors re-checked at `1550ebdd3`; verify them
again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 question (let a stable client, a PC, process the generation of a job a phone
started, since plugin hooks need a tab and the phone's screen turns off) and its assessment: the shape is the
"virtual client" of 2026-11-01 with a real tab in place of a headless browser, built on the owner-socket contract
the job channel already has; the [server generation guide](../structure/server-generation.md) (Generation
channels, Job chat and barriers), the [network and jobs guide](../structure/network-jobs.md) (Generation job client, Job
channel), the [chat pipeline guide](../structure/chat-pipeline.md) (Stop for a job this tab does not follow,
Replays and uncertain creates), the [live updates guide](../structure/live-updates.md) (Live updates), and the
[plugins guide](../structure/plugin-sandbox.md) (Job owner presence) at `186b9da71`. The 2026-11-04
revision applies the owner's decisions on the audit's
[per-plan report](../audit/plan-design-audit-2026-11-04/job-handoff.md) and on an independent second review of
its corrections. The second 2026-11-04 revision applies the owner's decisions on an adversarial challenge of
the first (its failures F1–F6): a socket transfer cannot give arbitrary plugin hooks exactly-once semantics, so
the owner switch waits for a safe boundary and a callback already running on a sleeping device is a stated
limitation (Goal, D2, Q4), with D3's deadline budget, D4's acceptance alternatives, D2's exhaustive notice
mapping, and the Reroll Candidates Slice 1 overlaps (**Slices**) corrected.

Owning guides when sliced: [server generation](../structure/server-generation.md) (the owner and viewer
sockets, takeover, the handoff offers), [network and jobs](../structure/network-jobs.md) (the tab's follow roles, the
worker policy, the offers store), [chat pipeline](../structure/chat-pipeline.md) (what the creator's tab shows
after a handoff), [live updates](../structure/live-updates.md) (the new live-update frames and the client
register message), [settings and i18n](../structure/settings-i18n.md) (the device toggles and name),
[plugins](../structure/plugin-sandbox.md) (Job owner presence: what a hook may assume about the tab it
runs in), [test harness](../structure/test-harness.md) (the browser check).

Relation to the server plugin runtime plan (retired unbuilt on 2026-11-03, see
[the archive](../archived-plan/README.md)): that plan would have run the hook half of a plugin on the server
for authors who opted in; this one moves the whole tab role to another tab for every plugin, including
DOM-bound plugins, `bodyIntercepter`, and plugin providers, as long as a worker tab is alive. A server-spawned
headless browser, ranked last on 2026-11-01, would be one more worker client of this protocol if it is ever
wanted (see **Later**).

Relation to the other active plans, which share files with this one (the slices' scheduling is under
**Slices**):

- [Incremental Chat Transport](incremental-chat-transport.md) Slices 2 and 3 edit `server/src/routes/events.ts`,
  `src/ts/network/eventFeed.ts`, `shared/jobs.ts`, `server/src/jobs/generationJobs.ts`, and
  `src/ts/network/generationJobs.ts`. Since D2 here keeps one hydration baseline (`sentChat`) for every socket
  of a job, its D3 renders `streamed` entries for the owner socket only and sends those rows whole to a viewer. Its D8 relies on unknown frame
  types being ignored, which the code does today (D8 here) and which the first of its Slice 3 or this Slice 2 to
  land pins with a test.
- [Reroll Candidates](reroll-candidates.md) Slice 1 edits `shared/jobs.ts`, `server/src/jobs/generationJobs.ts`,
  `server/src/routes/generations.ts`, `server/src/prompt/runner.ts`, `shared/events.ts` and
  `server/src/routes/events.ts` (`rerollInPlace` on `hello`), and the `followOnce` callback that
  `followJobToEnd` runs in `src/ts/process/serverCommands.ts` (the sequence event without `alternatives`: the
  same callback this plan's Slice 2 changes); its Slice 2 edits `src/ts/network/eventFeed.ts` and
  `src/lib/ChatScreens/DefaultChatScreen.svelte`. Its three job toasts (`rerollCandidateDropped`,
  `rerollCandidateTooLarge`, `scriptstateCheckpointSkipped`) are `alertToast` notices, so under D2 they reach
  the job's owner only: a phone with `preferHandoff` on never sees them. Recorded here; neither plan changes it.
- [Render Work Budget](render-work-budget.md) Slice 4 edits `src/lib/ChatScreens/DefaultChatScreen.svelte`, which
  this plan's Slice 3 also edits.
- `src/lang/en.ts` and `ko.ts` are shared by several slices of every plan; their keys are append-only.

## Goal

A generation job keeps running its tab-side work when the tab that created it is gone, by handing that work to
another tab of the same user:

- Another tab (a "worker": a PC browser the user marked as one) takes over the owner role of a running job and
  answers its callbacks and questions from then on: plugin hooks, replacers, interceptors, plugin providers,
  image callbacks, MCP tool calls, `alertConfirm` questions.
- The job's tab-side work moves to a worker (i) at admission, when the creating tab asked to be relieved as soon
  as a worker is there ("prefer a worker"), (ii) by hand, when the user picks a named worker or takes the job
  back, or (iii) when the owner goes absent (automatic).
- The owner switch takes effect only at a safe boundary: no request delivered to the old owner is outstanding.
  A request delivered to the old owner and unanswered is never re-delivered to another tab; it runs out on the
  old owner under its own deadline (answered, cancelled by the job, or expired by today's policy), and the
  worker takes every request after it (D2's pending takeover).
- The takeover needs no user action on the worker and no chat open there: the worker loads the job's chat into
  its chat store, as a reattaching tab does today, and runs the hooks under the job's targets.
- The tab that created the job keeps watching it (streaming text, the display effects, the terminal, Stop) and
  keeps every right it has today except answering callbacks and showing the job's dialogs.
- No new trust: every socket and route keeps the server's JWT; a job's status, abort, and attach stay limited to
  the tabs that take part in it; the server runs no plugin code.

Limitation, visible to the user: a callback already in flight on a device that then sleeps cannot be handed
over. The server counts a sleeping device's socket as open until 45 s of silence remove it, so a callback sent
in that time is in flight there too. It settles by the owner-absent policy: a request-side kind
(`bodyIntercepter`, the input hooks, a plugin provider) ends the job `disconnected`; a completed reply's
`editoutput` and `replacerafterRequest` keep the text; an undelivered `chatOutput` is recorded as skipped and
runs late, and a delivered one is recorded as missed. The creator's terminal says so: the job's error for a
request-side kind, `serverJob.hooksSkipped` for a skipped hook, and a new `serverJob.handoff.missedCallback`
toast for a missed one (D5). "Prefer a worker" at creation is the way to make it rare on a device that sleeps:
the worker usually takes the job before its first callback, but nothing guarantees it, since the creator attaches
as owner at admission and a callback dispatched before the worker's ticket attach is delivered to the creator
(decided by the owner on 2026-11-05: no first-dispatch gate; the takeover then waits as a pending takeover).

Not goals: hooks without any tab (the server plugin runtime plan, retired unbuilt), a job's callbacks split
across two tabs at once, running a delivered callback again on another tab, for any kind (Q4), reclaiming a job
back to the phone automatically, multi-user servers.

## Current state

The baseline is `1550ebdd3` on `dev` (2026-11-04); no server, shared, or tab code changed since the draft's
`186b9da71`. This plan does not re-propose it.

- **One owner per job, fixed at creation.** `POST /api/generations` records the creating tab's `clientId`
  (`generationClientId`, one per tab in `sessionStorage`, `src/ts/network/generationJobs.ts`). `ownJob` in
  `server/src/jobs/generationJobs.ts` answers status, abort, `drained`, `memory-stop`, and the socket upgrade of
  `/api/generations/:id/ws` only for that `clientId`; any other client gets a 404 (`handleUpgrade`; a disposed
  registry answers 404 too). `parentCallback`, which admits an aux request made inside a running callback
  (`POST /api/llm/request` with `channelCall`, `server/src/routes/llm.ts`), checks the same `ownJob`. The job's
  channel transport carries the same `clientId` (`ChannelTransport`, `server/src/jobs/channel.ts`), which keys
  the per-client request lanes and the absence cascade of queued roots.
- **The attach stamp.** The upgrade keeps one `attachStamp` per job: a lower `attach` stamp is a 409, and an
  accepted one replaces the job's. The tab takes its stamp from `performance.timeOrigin + performance.now()`
  (`attachStamp` in `src/ts/network/generationJobs.ts`), that device's wall clock, so the order holds across a
  reload of one tab and nowhere else.
- **The owner socket set.** `attach` makes the new socket the job's one owner socket (`job.sockets`), closing the
  previous ones with 4001 "Superseded by a newer connection", clears `ownerAbsentSince`, sends the job chat (a
  patch from `sentChat` while running, whole once ended), the fresh records, the preset, the stage, the current
  reply, then replays every open request (`channelLink.handleAttach`). `sendText` sends events to every socket
  in the set; `frame` accepts pongs and answers only from a socket still in the set ("Only the job's current
  socket speaks for the owner"). `removeOwner` sets `ownerAbsentSince` when the set empties, on any close, a
  routine reattach included (the tab closes its socket on `resumeReconnect` or a stale socket before it attaches
  again), and `expireSilentOwners` removes a negotiated socket silent for `OWNER_SILENT_MS` (45 s). The
  heartbeat (`JOB_HEARTBEAT_MS`, 15 s) pings only sockets in `job.sockets`; the tab abandons a socket with no
  frame for `STALE_AFTER_MS` (45 s, `src/ts/network/socketLiveness.ts`) and attaches again.
- **One chat baseline per job.** `sentChat` is the job's, not a socket's: whichever socket takes a copy
  (`deliverJobChat`) makes it the base of the next `chatPatch`. Each checkpoint write (`CHECKPOINT_INTERVAL_MS`,
  3 s, `server/src/prompt/runner.ts`) sends a patch from it to every socket; the barrier (`hydrateJobChat`)
  sends the chat whole unless every owner socket advertised `hydration=patch`. A `resync` (a patch refused for
  local work) and a `resyncReply` are answered to every socket. A chunk cannot create a row: the tab drops a
  stream update or chunk for a message its held chat lacks (`applyServerGenerationChunk`,
  `src/ts/storage/chatStore.svelte.ts`).
- **Outstanding requests and lanes.** `handleAttach` re-sends every dispatched open request, built with
  `replay: true` once a socket took it; `sendText` counts a send as taken whenever a socket is open, so a
  sleeping phone's socket takes callbacks until its 45 s silence ends. The tab refuses a `replay` it holds no
  state for (`failed`/`protocol`, `src/ts/network/jobChannel.ts`), runs one root callback at a time and refuses
  a root that arrives while one is outstanding; a `cancel` only asks a running hook to stop
  (`cancelOutstanding`: a flag and an aborted signal). The hub keeps one lane per `transport.clientId`
  (`laneOf`): a lane dispatches one root at a time, settlement finds the lane through the request's channel
  transport, and a cancelled callback a tab took holds its lane until the tab reports it drained or
  `CANCELLED_CALLBACK_DRAIN_MS` (60 s) passes (`holdDraining`).
- **What absence does.** A callback's allowance is `CALLBACK_TIMEOUT_MS` (60 s from dispatch,
  `server/src/jobs/channel.ts`; a few kinds pass a longer `timeoutMs`), and its effective deadline is the least
  of that, `ownerAbsentSince + OWNER_ABSENT_MS` (120 s, counted from the socket's removal; silence removes it at
  `lastFrameAt + OWNER_SILENT_MS`), and any parent's (`effectiveDeadline`); `ownerChanged()` re-arms the timers
  and extends nothing. On expiry (`disconnected`), request-side hooks end the job; a completed reply's
  `editoutput` and `replacerafterRequest` keep the text, and a `chatOutput` no tab took runs nothing and is
  recorded in order as `done.skipped` (one a tab took may have run there and is not recorded); the returning
  creator runs the skipped listeners once (`replaySkippedListeners`) and toasts `serverJob.hooksSkipped`.
  `status()` returns the stored terminal as is, kept outcomes and receipts answer the creator only, and the
  create replay (`replayStatus`) strips only `result` for another client.
- **A hook the tab lacks.** A hook the tab has not registered makes `runHook` throw (`failed`/`protocol`), which
  ends the job for the script hooks (`server/src/prompt/scripts.ts`) and the other request-side kinds. Only the
  server's own `unregistered` refusal, decided from the hook list the create admitted, keeps the text.
- **The tab's follow.** `followJobToEnd` (`src/ts/process/serverCommands.ts`) pins and loads the job's chat
  (`ensureChatLoaded`, not the screen's selection), attaches with `liveness=1&hydration=patch` and an increasing
  `attach` stamp (`followGenerationJob`), applies every event, and reattaches a bounded number of times
  (`MAX_ATTACHES`). It keeps one follow per job id (`following`): a second call returns the running one. The
  boot resume (`resumeServerJobs`) follows the jobs saved per chat in `sessionStorage`, learning each through
  `discover`, which reads `GET /api/generations/:id` (`GenerationStatus`), not `/current`. A browser cannot read
  the HTTP status of a refused WebSocket upgrade: the follow sees a close (1006), reads the status, and a null
  status runs its gone path. Callbacks run under the job's targets (`runHook`); the host API resolves the chat
  from the call context before the tab's selection (`chatsOfRead`, `src/ts/plugins/apiV3/v3.svelte.ts`); the
  callback barrier hydrates the job chat by its ref. A tab therefore processes a job whose chat it does not
  show, which is how a per-chat send keeps working after the user moves to another chat.
- **Notices.** `showNotice` puts the alert kinds and the questions in one UI queue; `applyEffect`
  (`jobChannel.ts`) applies the rest: `emotion`, `progress`, `memoryProgress`, `translating`, and `reloadChat`
  change what the chat shows (memory progress is also the way to a run's `memory-stop`), `tts` and
  `notification` act on the device, and `openURL` opens an MCP login page.
- **Stop.** The Stop for a followed job is `abortGenerationJob` (`DELETE /api/generations/:id`). Only
  `POST /api/generations/stop` from another client sets `stoppedByOther`, which gives the terminal
  `abortedBy: "other"` and makes the tab toast `serverJob.stoppedElsewhere`.
- **What other tabs see.** `GET /api/generations/current` answers `owned: false` for another client's job; the
  tab marks it `foreignJobs` (`src/ts/process/chatStatus.svelte.ts`), shows the extra Stop, and never attaches
  ("Follow owned jobs; never attach to a foreign job", chat pipeline). Results reach it through the chat's
  checkpoint writes on the live-update feed. A tab that starts following a job leaves `foreignJobs` for it
  (`followJobToEnd` calls `clearForeignJob`, and the `followedJobs` subscription prunes foreign marks).
- **The live-update socket is one-way.** `server/src/routes/events.ts` keeps a `Set<WebSocket>` with no
  identity, ignores incoming messages, and sends `hello` (epoch, `streaming` locks, `memoryTasks`, digest),
  `change`, `memoryTask`, `epoch`, `ping` (`EventFeedFrame`, `shared/events.ts`). `hello`'s snapshots come
  from registry callbacks wired in `server/src/app.ts` (`streamingSnapshot`); the other frames come from the
  change feed (`ChangeFeedEvent`, `server/src/data/changeFeed.ts`). The tab's `receive` (`eventFeed.ts`) and
  the job event dispatcher (`applyGenerationEvent`) have no default branch: an unknown `type` is ignored, and no
  test pins it.
- **Device-local preferences** live in `localStorage` with a small module each (`pushNotifications.ts`'s
  `REGISTERED_KEY` is the pattern); the Display page's `NotificationToggle.svelte` is a device toggle's UI.
- **The browser driver.** `util/playwright/checkJobProtocol.mjs` installs its test plugin inline and exports
  nothing; `util/playwright/stack.mjs` holds the shared stack helpers.

## Decisions

- **D1. Creator and owner are two fields; lanes follow the owner.** `job.clientId` stays the creator and keeps
  everything attributed to it today: the receipt row, `GenerationCurrent.owned`, cancel ownership, the `/stop`
  attribution, and the device notices of D2. New `job.ownerClientId`, the creator at admission, is the client
  whose socket answers callbacks. `ownJob` becomes `participantJob(jobId, clientId)`: the creator or the current
  owner may read status, attach, abort, report `drained`, and `memory-stop`; everyone else stays a 404.
  `parentCallback` checks the current owner (not every participant, and not the creator), since only the
  owner's tab runs callbacks and the aux requests made inside them. `GenerationCurrent` and `GenerationStatus`
  gain `handedOff: boolean` (the owner is not the creator).
  - Request lanes are keyed by the job's current owner: a new request joins the owner's lane, so a worker runs
    the roots of its own jobs and of the jobs it took over one at a time, and a handed-off job never waits
    behind the creator's other jobs. At takeover the job's queued requests move, in order, to the new owner's
    lane, and the transport names the new owner from then on.
  - A request a socket actually took keeps the lane it was dispatched from as its own recorded identity, which
    settlement, the drain hold, and `drained` use. Settlement today finds the lane through the request's
    transport (`laneOf(request.channel.transport.clientId)`), so reading the owner there after a takeover would
    look for the request in the new lane while the old lane still holds it.
  - A request dispatched while no owner socket was open (never delivered to any socket) is not "dispatched"
    for that rule: at the owner switch it leaves the old lane's slot and is re-queued, in order and ahead of
    the job's other queued requests, into the new owner's lane as a queued request. It goes out under the
    one-root-at-a-time rule like any other, so it never collides with a root already running on the worker,
    and its allowance starts again at that dispatch, as a queued request's does today ("time spent behind
    other requests in the queue is not counted", `dispatch` in `server/src/jobs/channel.ts`).
  - The old owner's drain holds stay in its lane, and `drained` accepts the client a held request was
    dispatched to: a former owner that is no longer a participant still reports `drained` for a request it
    ran. The absence cascade already checks each entry's own `ownerAttached`.

  Rejected: making the owner the only identity (the phone's saved job, its receipts, and its Stop would break
  the moment a worker takes over); keeping the lanes keyed by the creator (audit JH2: a worker running its own
  job and a handed-off job receives two roots and refuses the second, which fails that job, and a handed-off
  job waits behind the sleeping creator's other jobs); the transport's `clientId` as a getter over
  `ownerClientId` (settlement would look a dispatched request up in the wrong lane); `parentCallback` through
  `ownJob` (a worker hook's aux request is refused); keeping an undelivered request in its recorded lane (it
  would reach the worker at the switch while the worker's own root may be running, and the worker's tab
  refuses a second root, `src/ts/network/jobChannel.ts` around lines 114–118, which fails that job).

- **D2. Owner and viewer sockets; takeover is an attach with a ticket.** The socket upgrade takes
  `role=owner|viewer` (absent: `owner`, today's tabs) and `ticket=` (D3's takeover ticket).
  - Attach order: one attach stamp per client, compared only within that client. A lower stamp from the same
    client is a 409 as today; a viewer attach or a takeover never moves another client's stamp.
  - A participant attaching as `owner` while it is the owner: today's `attach`.
  - An attach carrying a valid ticket on a running job is the takeover, and its switch happens at a safe
    boundary (the outstanding-request rule below): `ownerClientId` becomes the ticket's client, its socket
    becomes the one owner socket, and the previous owner's open sockets move to the new `job.viewers` set
    instead of being closed; `ownerAbsentSince` clears; `channelLink.ownerChanged()` re-arms deadlines; the lanes
    change as D1 says. A takeover of an ended job is a 409, and so is one while the server shuts down (a new
    rule: a disposed registry answers 404 today).
  - A creator attaching without a ticket while the job is handed off is attached as a **viewer**, whatever
    `role` it asked: a phone waking up must not yank the hooks back mid-call. A ticket from the creator is a
    takeover like any other and overrides that rule. A tab that already follows the job (the creator's viewer
    follow) takes it by a role switch inside that follow, a new socket attach with the ticket that supersedes
    its viewer socket (`currentFollows`), because `followJobToEnd` keeps one follow per job id and a second call
    never reaches an attach (D4).
  - Every attach starts with that socket's role,
    `{ type: "handoff", owner: "self" | "other", clientName?, pending?: true }` (the owner's name when the
    server knows one, D6; `pending` on a pending takeover's socket only), before the chat; each role change,
    the switch of a pending takeover included, sends it again to every socket of the job. A booting creator
    and a reattaching tab learn their role from it, and `GenerationStatus.handedOff` (D1) tells the boot
    resume, which reads the status through `discover`, before it attaches.
  - Outstanding requests at takeover: the switch happens only when no request delivered to the old owner is
    outstanding, and a delivered request never goes to another tab, whatever its kind.
    - A ticketed attach that arrives while none is outstanding switches at once. A request dispatched but not
      yet delivered to any socket (no owner socket was open) is re-queued into the new owner's lane (D1) and
      reaches it as a first delivery (`replay` false) when that lane dispatches it.
    - A ticketed attach that arrives while a request delivered to the old owner is outstanding is accepted as a
      **pending takeover**: the ticket's socket attaches as a viewer and gets the role event with
      `pending: true`, and the old owner keeps answering (an old owner that reattaches meanwhile is today's
      owner attach and gets the request replayed; `parentCallback` admits its aux requests, since it is still
      the owner). The switch happens when the last such request settles (answered, cancelled by the job, or
      expired); undelivered queued requests and every request dispatched afterwards go to the new owner.
      Precisely: at the switch the job's requests no socket took, those dispatched while no owner socket was
      open first and then those still queued, in order, become queued requests of the new owner's lane and go
      out under its one-root-at-a-time rule; later requests join that lane. The lane rules of D1 hold: only a
      request a socket took keeps its recorded lane, and a cancelled callback's drain hold stays in the old
      lane.
    - A pending takeover's ticket does not expire while it waits (`HANDOFF_TICKET_MS` bounds only the time to
      the attach). If the job ends before the switch, the pending takeover ends with it: the ticket's socket
      gets the terminal as a viewer. If the ticket's socket closes before the switch, the pending takeover is
      dropped and the offer opens again as for an expired ticket (D3).
    - Why: a hook delivered to a tab may already have done more than compute its answer (a plugin-storage
      write, a tool call, a listener's change), and a `cancel` only asks it to stop, so running it on a second
      tab could do it twice; waiting for the boundary keeps every callback on one tab. A delivered callback the
      old owner never answers settles by today's owner-absent policy (the Goal's limitation): `disconnected`
      ends the job for a request-side kind, keeps the text for a completed reply's hook, and a delivered
      `chatOutput` is recorded in the terminal's new `missed` list (D5), not as skipped.
  - The job chat: all sockets of a job share one hydration baseline (`sentChat`, one per job today). A takeover
    sends the whole chat to every socket of the job, the new owner and every viewer, and that copy becomes the
    baseline. From then on every checkpoint gives every socket the same `chatPatch` (a socket that advertised
    `hydration=patch`) or the whole copy (a socket without the flag, an older tab), so a viewer keeps seeing the
    rows a later speaker appends, which chunks cannot create. The barrier's whole-or-patch rule
    (`hydrateJobChat`) counts viewer sockets with the owner's. A viewer's `resync` is answered as today, with a
    whole copy to every socket that resets the baseline: rare (a patch refused for local work), and its cost
    lands once on every socket of that job. A viewer's `resyncReply` is answered as today.
  - What a viewer receives: its role event, the job chat as above, fresh records, preset, stage, reply and
    chunk events, the notices below that reach it, pings, and the terminal (D5 decides its `skipped`); no
    channel request, since the switch waits until nothing delivered to the old owner is outstanding, so no
    `cancel` is owed there. Pings go to every socket (today only owner sockets, and the tab abandons a
    socket with no frame for 45 s); only a viewer's silence changes nothing, since a viewer is not negotiated.
    Answers and pongs from a viewer socket are ignored: `frame` and the `message` handler accept only `resync`
    and `resyncReply` from it, as they ignore a superseded socket today.
  - Notices go by group, as an exhaustive mapping over `GenerationNotice["kind"]` (`shared/jobs.ts`; a
    `Record` over the kinds, so an unmapped kind is a type error). Dialogs and toasts (`alertNormal`,
    `alertError`, `alertToast`, `alertMd`, `alertWait`, `alertClear`, and every question: `showNotice`'s UI
    queue) go to the owner only. Display effects (`emotion`, `progress`, `memoryProgress`, `translating`,
    `reloadChat`, `reloadDisplay`, `updateGUI`: the chat-display kinds `applyEffect` handles, the last two
    bumping `ReloadGUIPointer`) go to every socket, so the creator keeps its emotion images, translation state,
    display reloads, and memory progress with its `memory-stop`. Device effects (`tts`, `notification`) go to
    the creator's sockets, so an unattended PC neither speaks nor notifies. `openURL` (the MCP login page) goes
    to the owner, whose tab runs the MCP.
  - The create's `GenerationHooks` stay the job's hook list after a takeover. A hook missing on the worker fails
    that callback as it would today in a tab that lost the plugin: `runHook` throws, the answer is
    `failed`/`protocol`, and a request-side kind ends the job; only the server's own refusal of a hook outside
    the admitted list keeps the text. Plugins are a server resource, so the lists match in practice (recorded
    limitation; a refresh is in **Later**). A hook only the worker registered is not called.

  Rejected: closing the previous owner's sockets at takeover (the creator would lose its stream); replaying
  outstanding requests to the new owner unchanged (audit JH1: the worker refuses every `replay` with
  `failed`/`protocol`, which ends the job, and nothing stops the hook still running on the old owner);
  cancelling and re-delivering every kind as a first delivery (a cancel is only a request to stop, so an
  effectful kind could run twice); the first revision's split by kind, a `cancel` to the old owner then the text
  transforms (the script hooks and replacers) and the reads (`mcpList`, `selectedChat`) re-delivered
  at-least-once and the effectful kinds settled `disconnected` at the takeover (the challenge's F1 and F2: an
  edit or replacer hook runs in a writable job context, `runHook` in `src/ts/network/jobChannel.ts` around line
  758, and `runCallback` flushes its resource changes even after a cancel, around line 1197, so its
  plugin-storage writes, `_setPluginStorage` in `src/ts/plugins/apiV3/v3.svelte.ts` around line 2367, commit
  twice; `mcpList` can open a directory picker or a credential prompt through `readyTabClient`; and settling a
  delivered callback at the takeover ended the job, or left a listener batch unfinished, while its old owner
  could still answer); one attach stamp per job (audit JH3: the stamps are two devices' clocks, so a phone ahead
  of the PC makes the takeover a 409); `takeover=1` on the upgrade (a browser cannot see the refusal, D3); a
  creator always a viewer "whatever it asked" (it could never take its job back); a role event only on a role
  change (an attach turned viewer is no change, so a booting creator never learns its role); viewers in whole
  mode at every checkpoint (audit JH5/X2: a whole read and send per viewer every 3 s to the phone the plan
  relieves); viewers getting the chat only at attach and at the end (a viewer cannot create the row a later
  speaker appends, so the stream is missing until the terminal); viewer sockets left unpinged (they drop every
  45 s of quiet); no notice to viewers (Q3, superseded); "a hook the worker has not registered returns the text
  unchanged" (wrong: that holds only for the server's `unregistered` refusal).

- **D3. Handoff offers on the live-update feed; one takeover per offer.** The registry publishes a change-feed
  event `{ type: "handoff", epoch, jobId, characterId, chatId, state: "open" | "closed", reason: "absent" |
"preferred" | "requested", target?: clientId }` and the events route forwards it as a frame; `hello` gains
  `handoffs`, the open offers (a registry callback beside `streamingSnapshot`), so a worker that connects later
  still sees them.
  - An offer opens as `absent` once the owner set of a running job has stayed empty for
    `HANDOFF_OFFER_DELAY_MS` (10 s), so a routine reconnect, which closes the owner socket and attaches again,
    never publishes one; this also covers a worker that took over and went silent, so the next worker, or the
    creator's own live tab, takes the job (D4). It opens as `preferred` at admission when the create body says
    `handoff: "prefer"` (the creator still attaches as owner and is the fallback), and as `requested` on
    `POST /api/generations/:id/handoff` by a participant (with `target` when the user picked a client).
  - An offer closes on takeover, when an owner attach clears the absence (an `absent` offer), and at the job's
    end; a closed frame names the same job.
  - Takeover goes through `POST /api/generations/:id/takeover` `{ clientId }`, allowed only against an open
    offer (a targeted offer only for its `target`). The first one closes the offer atomically and answers 200
    with a one-use ticket bound to the job and that client, valid for `HANDOFF_TICKET_MS` (10 s) until its
    attach; the socket attach carries it, and D2's switch happens at that attach or, for a pending takeover,
    when the last request delivered to the old owner settles, so the old owner keeps answering until then. A
    second one, or one with no open offer, of an ended job, or while the server shuts down, is a 409; an older
    server without the route answers 404 (so does a job this server does not know). While its ticket is valid,
    and through a pending takeover (whose ticket does not expire while it waits), the client may read the job's
    status; a ticket that expires unused, or a pending takeover whose socket closes before the switch, opens
    the offer again if the job still runs and the offer's reason still holds.
  - The deadline budget. A callback's allowance is `CALLBACK_TIMEOUT_MS` (60 s from dispatch), and the offer
    opens `HANDOFF_OFFER_DELAY_MS` after silence removes the owner socket at `OWNER_SILENT_MS` (45 s after its
    last frame), so no callback in flight on a device that sleeps can be rescued even in principle (the Goal's
    limitation, which D2 does not attempt). An owner that goes silent **between** callbacks still leaves the
    worker time: the `absent` offer opens 45 s + 10 s after the last frame; from the removal on, a request
    dispatched finds no owner socket, is undelivered, and waits in the owner's lane under the least of its own
    60 s allowance and the absence cap `OWNER_ABSENT_MS` (120 s from the removal). The first such request is
    dispatched at the removal at the earliest, so the worker has at least 50 s after the offer opens (the 60 s
    allowance less the 10 s delay), and up to 110 s for a later one, for the ticket, the attach, the chat load,
    and the barrier before the first undelivered request expires. A request dispatched in the 45 s before the
    removal counts as delivered to the silent socket (`sendText`) and is the Goal's missed case. Slice 1 tests
    this with the real 60 s default on the fake clock, not the 300 s fixtures of
    `server/src/tests/jobChannel.test.ts`. The 50 s bound holds for a job's own first undelivered request; a
    queued root that the absence cascade settles `disconnected` behind another job's expired root of the same
    lane can end sooner after the offer opens (a recorded limitation, owner decision of 2026-11-05; the
    cascade policy is unchanged, and the server-generation guide states it in Slice 4's guide pass).
  - The route exists because a browser cannot read the HTTP status of a refused WebSocket upgrade: the tab sees
    close 1006, reads the status as a non-participant, and runs the follow's gone path. The hooks refresh of
    **Later** can reuse it.

  Rejected: an `absent` offer at the moment the owner set empties, closed only by takeover or the end (a
  healthy owner that reloads is taken over); every takeover of a running job succeeding (a second worker steals
  the job, and every PC tab with `acceptHandoffs` races for each offer); the refusal as an upgrade status
  (invisible to the tab); counting on the 120 s absence cap to rescue a callback outstanding at silence (the
  challenge's F3: the 60 s allowance from dispatch, `CALLBACK_TIMEOUT_MS` in `server/src/jobs/channel.ts` around
  line 28, binds first, so the offer could open after the callback had already ended the job).

- **D4. The worker policy lives in the tab, device-local.** A new module `src/ts/network/handoff.ts` keeps
  three `localStorage` preferences: `acceptHandoffs` (default off: this tab takes open offers), `preferHandoff`
  (default off: this tab's creates carry `handoff: "prefer"`), and `clientName` (default from the user agent,
  editable). It holds the offers store fed by `eventFeed.ts` and takes an open offer, by the takeover request
  (D3), when `pluginsStarted()` has resolved and one of these alternatives holds (any other offer, this tab's
  own `preferred` one included, is left alone):
  - (i) the offer's `target` is this client, a self-targeted `requested` offer from "Take back" (D6) included;
  - (ii) the offer is for this tab's own job with reason `absent`, whatever `acceptHandoffs` says (the creator
    takes its own job back from a worker that went away);
  - (iii) the offer is for another client's job, untargeted, and `acceptHandoffs` is on.
  - On a ticket the tab attaches with it: through `followJobToEnd(jobId, ref, undefined, { ticket })` when it
    does not follow the job yet, or by a role switch inside its running follow when it does (the creator's
    viewer follow; D2). A 409 or 404 drops the offer and starts no follow.
  - Until the follow's role event says `owner: "self"`, a refused ticket attach (an expired ticket) or a pending
    takeover's socket that closes is a lost takeover, without the gone path (no chat recovery, no
    `endedAway`). A follow started for the takeover ends and releases its pin. A creator's running viewer
    follow, whose role switch superseded its viewer socket, resumes viewing: it attaches again without a ticket
    as the viewer it was, and its lifecycle goes on.
  - The follow's role is whatever the latest `handoff` event says: a tab told `owner: "other"` keeps following
    as a viewer and expects no callback; a tab told `owner: "self"` is the owner. The worker's chat is pinned and
    loaded by the follow as today, and `followedJobs` lists it, so its Stop and busy state work; a small status
    line names the job's character, `serverJob.handoff.pending` ("waiting for the other device to finish a
    plugin step") while the role event says `pending: true`, then `serverJob.handoff.working` while the
    takeover runs. A job that ends before a pending takeover's switch ends that follow at its terminal as a
    viewer's.

  Rejected: `followJobToEnd(jobId, ref, undefined, { takeover: true })` for a job the tab already follows (the
  call returns the running follow, so the creator could never take its job back); a lost takeover through the
  gone path (it would read the chat again and report the job ended away); the first revision's predicate, "not
  this tab's own job unless `absent`" and then "`acceptHandoffs` on or `target` is this client" (the
  challenge's F4: it refused the creator's self-targeted `requested` "Take back", and its own `absent` offer
  with the toggle off and no target).

- **D5. The creator after a handoff; who replays skipped listeners.** Its follow keeps running as a viewer: the
  stream, the display notices, and the terminal arrive, Stop works (abort is a participant right), and the
  saved job resumes at boot as a viewer (D2's role event and `GenerationStatus.handedOff`). The `handoff` event
  with `owner: "other"` shows a toast naming the worker (`serverJob.handoff.takenBy`, with `clientName` when the
  server knows one, Slice 3) and clears nothing: the job is still this tab's.
  - The late-replay recipient of `done.skipped` is the owner when an owner socket is attached at the job's end,
    else the creator. The creator attaching to an ended job with no owner attached at its end is not a viewer
    (there is no owner): its terminal, status, and kept outcome carry the skipped list, as the creator's do
    today, and it replays them through today's path.
  - `skipped` is stripped per role in every view, not only on the socket: `status()`, kept outcomes, and the
    create and cancel replays carry it only for the recipient and give `skipped: []` to every other client and
    to every viewer of a running job. Kept outcomes answer the owner at the end as well as the creator, so a
    worker reading after collection still gets its outcome. A creator-viewer whose socket dropped near the end
    and reads the status therefore does not replay listeners the owner replays.
  - The stripping applies to projected copies, never to the canonical terminal: the job keeps one terminal
    with the full list, the worker's kept result keeps its list, and each view is projected from it for its
    reader. The creator-only receipt (`receipts.end` with `keptStatus`) stores the creator-projected result,
    with no change to its ownership or schema.
  - The missed callbacks: a delivered `chatOutput` that settles `disconnected` (the Goal's limitation) is
    recorded in order in a new optional `done.missed` (`{ name, payload }` as a skipped one, never replayed,
    since its listeners may have run), and `missed` goes unstripped to every view. The creator's tab toasts
    `serverJob.handoff.missedCallback` once per terminal (its follow or the boot resume's status), beside
    today's `hooksSkipped` for the skipped ones; a request-side kind's `disconnected` already ends the job with
    an error terminal the creator shows today.
  - The list is not cleared when a participant attaches: a send on a socket is no acknowledgement that the tab
    ran the listeners (the tab may still have to recover the chat first, waits for its plugins, and may find no
    listener), so the recipient's views keep it as the creator's keep it today.

  Rejected: `skipped: []` on viewer terminals as the only guard (audit item 5: `status()`, the kept outcome,
  and the replays still carried the list, so both tabs ran it; audit JH4: with the creator always a viewer, a
  dead worker's list was never run); the first participant to attach after the end taking and clearing the
  list (an attach is no execution acknowledgement, so the listener could be lost before any tab ran it).

- **D6. Presence and the manual trigger.** The live-update socket accepts one client message,
  `{ type: "register", clientId, name, worker: boolean }`, sent after every `hello` and on a preference change
  (a socket that never registers is an older tab: listed by nobody, sent everything as today). The route keeps
  the registration per socket and publishes `{ type: "clients", clients: [{ clientId, name, worker }] }` to
  every socket on join, leave, and change, and includes it in `hello`. The tab keeps `connectedClients`; the
  chat's job controls (`DefaultChatScreen.svelte`, beside the Stop this tab shows for its own job) offer "Hand
  off to…" listing the other clients with `worker` on, which calls `POST /api/generations/:id/handoff`
  `{ clientId, target }`; the target's tab takes the offer by D4 (a targeted offer ignores `acceptHandoffs`
  since the user chose it), and the requester toasts if the offer is still open after 10 s. While this tab
  follows the job as a viewer, the controls also offer "Take back", the same request with this tab as
  `target`, which its own follow then takes (D4). Two tabs of one browser share a name; the list shows each
  once with its tab count.
- **D7. Security and limits.** Every new query, route, and message runs under the existing JWT and epoch
  checks. Taking an open offer is open to any authenticated client of this single-user server (a targeted
  offer only to its target), as reading `/current` and stopping another client's job already are; the
  participant check narrows status and abort to the creator and the owner. A ticket is one use, bound to one
  job and one client, and short-lived. The worker never receives the creator's secrets: the job sends the same
  records it sends today, and the worker's own device-local keys apply to the work it does (image generation,
  plugin `safeLocalStorage`), which the guide states. A takeover during an outstanding delivered callback
  follows D2: it waits as a pending takeover until that callback settles on the old owner, no callback runs on
  two tabs, an answer from a socket that is no longer the owner's is refused (today's superseded-socket rule),
  and at most one owner socket ever speaks. Stop for a followed job is `DELETE
/api/generations/:id`, a participant right: the job records the participant that stopped it, and the other
  participant's terminal carries `abortedBy: "other"`, so its tab says "stopped elsewhere"
  (`serverJob.stoppedElsewhere`). `register` names are capped at 64 characters and the `clients` list at 64
  entries. Offers carry no chat text.
- **D8. Compatibility.** An older tab sends no `role`, no ticket, and no `register`: it is the creator-owner of
  its own jobs exactly as today and never a worker; it is attached as a viewer if a newer tab took its job, and
  it ignores the unknown `handoff` and `clients` frames and the role event: `receive` and the job event
  dispatcher have no default branch today, and Slice 2 adds the test that pins it. An older server has no
  takeover route: the `POST` answers 404, which the worker treats as "no handoff on this server" and drops the
  offer (rare, since the server serves the tab). `GenerationCurrent.handedOff`, `GenerationStatus.handedOff`,
  the create's `handoff`, the role event's `pending`, and `done.missed` are optional (an older tab ignores
  `missed` and shows no toast for it). Receipts and their reads are unchanged (creator).

## Open questions

Q1–Q3 were answered on 2026-11-03 with the recommended option and Q4 on 2026-11-04; they are kept here as the
record of why. Q3's answer was superseded on 2026-11-04 after the design audit (see its text).

- **Q1. Which tabs are workers by default.** Answered: none; the user turns `acceptHandoffs` on per device
  (a PC) and `preferHandoff` on per device (a phone). The alternative, every desktop tab a worker by default,
  surprises a user who sees a chat lock up on their PC.
- **Q2. A background tab as a worker.** Answered: eligible. A hidden PC tab still receives socket messages
  and answers pings, but Chrome's intensive throttling slows timers after five minutes hidden, which can delay
  a hook that waits on a timer; the Slice 4 driver measures a hidden worker and the guide states the limit.
  The alternative (visible tabs only) leaves the common "PC on, browser minimized" case uncovered.
- **Q3. Notices to viewers.** Answered: none; the owner alone shows toasts and dialogs, and a question
  answered twice is a protocol error. The alternative, toasts to viewers too, would show the creator the
  job's warnings but duplicate them when both tabs are on one desk. Superseded on 2026-11-04: notices are not
  only toasts and dialogs (`applyEffect` also applies emotion images, memory progress, translation state, chat
  reloads, text-to-speech, the completion notification, and `openURL`), so "none" stripped the phone's display
  state and made the PC speak. D2's three groups replace it: dialogs and toasts stay with the owner for the
  duplicate-dialog reason above, display effects go to every socket, device effects to the creator, `openURL`
  to the owner.
- **Q4. Re-delivering a delivered callback.** Answered on 2026-11-04, after the adversarial challenge of the
  first revision: option (a). The options were (a) never re-deliver a callback delivered to the old owner, for
  any kind: the owner switch waits for a safe boundary (D2's pending takeover), and a callback in flight on a
  device that sleeps settles by today's owner-absent policy, stated to the user as a limitation (Goal); (b) the
  first revision's split, re-delivering the text transforms and the reads after a `cancel`; (c) make transfer
  mid-callback safe. The reason: a socket transfer cannot give arbitrary plugin hooks exactly-once semantics.
  An edit or replacer hook runs in a writable context whose changes, plugin-storage writes included, are
  flushed even after a cancel, `mcpList` can prompt, and a delivered `chatOutput`'s listeners may have run, so
  (b) could do a hook's work twice; (c) needs a per-effect deduplication and a callback execution identity the
  plugin API does not have (**Later**). "Prefer a worker" at creation makes the limitation rare on a device that
  sleeps, without guaranteeing it (see the Goal).

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Scheduling against
the other active plans (their files are listed under the relations above):

- Slice 1 edits `shared/jobs.ts`, `shared/events.ts`, `server/src/jobs/generationJobs.ts`,
  `server/src/jobs/runSetup.ts`, `server/src/jobs/commandRunner.ts`, `server/src/prompt/runner.ts`,
  `server/src/routes/generations.ts`, and
  `server/src/routes/events.ts`: not in parallel with Incremental Chat Transport Slices 2 and 3 or Reroll
  Candidates Slice 1.
- Slice 2 edits `src/ts/process/serverCommands.ts` (the `followOnce` callback `followJobToEnd` runs),
  `src/ts/network/generationJobs.ts`, and `src/ts/network/eventFeed.ts`: not in parallel with Reroll Candidates
  Slice 1 (the same `followOnce` callback) or Slice 2 (`eventFeed.ts`), or Incremental Chat Transport Slices 2
  and 3.
- Slice 3 edits `server/src/routes/events.ts`, `shared/events.ts`, `src/ts/network/eventFeed.ts`, and
  `src/lib/ChatScreens/DefaultChatScreen.svelte`: not in parallel with Incremental Chat Transport Slices 2 and 3,
  Reroll Candidates Slice 1 (`routes/events.ts`, `shared/events.ts`) or Slice 2 (`eventFeed.ts`,
  `DefaultChatScreen.svelte`), or Render Work Budget Slice 4.

### Slice 1: creator and owner on the server, takeover, offers (D1, D2, D3, D5's server half, D7; needs nothing)

Files: `server/src/jobs/generationJobs.ts` (`ownerClientId`, `viewers`, `participantJob`, `parentCallback` on
the owner, the per-client attach stamps, the `role` and `ticket` queries of `handleUpgrade`, the tickets, the
takeover with its outstanding-request rule and the pending takeover, whole hydration to every socket on
takeover, viewer event routing and pings, the notice mapping over every kind, the role event on every attach
with `pending`, the late-replay recipient and `skipped` per role in projected copies of the terminal,
`status()`, kept outcomes, the receipt, and the replays, the stopping participant, offers with their delay and
feed events, `handoffSnapshot`), `server/src/jobs/channel.ts` (lanes keyed by the owner, each dispatched
request's recorded lane, the queued move at the switch, the safe-boundary signal: whether a request delivered
to the old owner is still outstanding and when the last one settles, `drained` from the client a held request
was dispatched to), `server/src/prompt/runner.ts`, `server/src/jobs/runSetup.ts`, and
`server/src/jobs/commandRunner.ts` (a delivered `chatOutput` settled `disconnected` recorded in `done.missed`
beside `skippedHooks`, a command job's parts included), `server/src/data/changeFeed.ts`
(`handoff` event), `server/src/routes/events.ts` (the `handoff` frame, `hello.handoffs`),
`server/src/routes/generations.ts` (`POST /:id/handoff`, `POST /:id/takeover`, the participant check on the
routes), `server/src/routes/llm.ts` (only if the `channelCall` refusal text names the creator),
`server/src/app.ts` (wiring), `shared/jobs.ts` (`GenerationCurrent.handedOff`, `GenerationStatus.handedOff`,
`GenerationCreateBody.handoff`, the `handoff` job event with `pending`, `done.missed`,
`GenerationHandoffBody`, the takeover body and answer), `shared/events.ts` (the `handoff` frame,
`hello.handoffs`), the server-generation guide (Generation channels, Flows, State, Invariants, Limitations: a
callback in flight on an owner that sleeps is not handed over).

- Tests (`server/src/tests/generationJobs.test.ts`, `generations.test.ts`, `jobChannel.test.ts`,
  `events.test.ts`, `promptTail.test.ts`, `llmRoutes.test.ts`, with the real channel hub and the registry's
  fake clock):
  - Takeover: a second client's upgrade without a ticket is a 404; `POST /:id/takeover` with no open offer is a
    409, and with one answers a ticket whose attach makes that client the owner, sends it `owner: "self"` and
    the chat whole; a second takeover of the same offer is a 409; a reused or expired ticket is refused, and an
    expired unused one reopens the offer; a takeover of an ended job, or while the registry shuts down, is a
    409; a targeted offer refuses another client's takeover.
  - Outstanding requests: with nothing delivered outstanding, the ticket attach switches at once and an
    undelivered callback reaches the new owner as a first delivery (`replay` false).
  - Pending takeover: a ticket attach while a delivered `editoutput` is outstanding gets `owner: "other"` with
    `pending: true` and no callback; the old owner's answer completes the hook with its text, and the switch
    follows that settlement: the new owner gets `owner: "self"`, the queued `chatOutput` reaches it as a first
    delivery, and the old owner's socket turns into a viewer; with the old owner silent instead, the hook runs
    out on its own deadline (`disconnected`, the text kept, `editoutput` in `skipped`), then the switch; the
    delivered request is never sent to the new owner; the old owner's aux request inside it is admitted while
    the takeover is pending; the pending ticket outlives `HANDOFF_TICKET_MS`; the pending socket closing before
    the switch reopens the offer; a delivered `bodyIntercepter` that settles `disconnected` under a pending
    takeover ends the job with it, the pending socket gets the terminal as a viewer, and the new owner never
    ran the callback.
  - Deadlines, with the real `CALLBACK_TIMEOUT_MS` (60 s) on the fake clock, not the 300 s fixtures of
    `jobChannel.test.ts`: an owner silent since t = 0 is removed at 45 s; a callback dispatched at 45 s is
    undelivered; the `absent` offer opens at 55 s; a takeover attached at 100 s gets the callback as a first
    delivery and its answer completes it, while with no takeover it settles `disconnected` at 105 s; in a second
    run, a callback delivered at 10 s to that socket settles `disconnected` at 70 s on the old owner under a
    pending takeover made at 56 s, which then switches.
  - Missed: a delivered `chatOutput` that settles `disconnected` is listed in `done.missed` and not in
    `skipped`, in every view, a command job's parts included; an undelivered one is in `skipped` and not in
    `missed`.
  - Lanes: a worker with its own job's root outstanding gets the taken-over job's root only after its own
    settles, never both at once; a taken-over job's queued request is not held behind the creator's other job;
    a request a socket took before the takeover settles out of the old lane and leaves no entry in either; a
    request dispatched during the owner's absence (no socket took it) is delivered to the worker only after the
    worker's own running root settles, with a fresh allowance from that dispatch; the former owner's `drained`
    clears its hold and a third client's does not.
  - Aux: `parentCallback` (an `/api/llm/request` with `channelCall`) admits the owner's callback after a
    takeover and refuses the creator's.
  - Stamps: a takeover by a client whose stamps are lower than the creator's succeeds; the creator's viewer
    reattach with a higher stamp does not refuse the owner's next attach; a lower stamp from one client is
    still a 409 for that client.
  - Viewers: the old owner's socket turns into a viewer, gets `owner: "other"`, chunk, display-notice
    (`reloadDisplay` and `updateGUI` included), ping, and terminal events, and no callback, question, dialog, or
    toast; device notices reach only the creator's sockets and `openURL` only the owner's; a viewer's answer and
    pong are ignored; a viewer silent past 45 s keeps the job; every attach's first event is its role; the
    creator attaching without a ticket while handed off is a viewer and with one the owner; the creator's
    status, abort, and `current` (`owned: true, handedOff: true`) still answer and a third client's do not;
    receipts keep the creator.
  - Job chat: after a takeover every socket gets the whole chat once and then the same `chatPatch` per
    checkpoint, including the row a second speaker appends in a group job; a viewer's `resync` sends a whole
    copy to every socket; a viewer without `hydration=patch` (an older creator tab) makes the callback barrier
    send the chat whole to every socket, and the owner's callback follows that copy.
  - Offers: an owner set empty for `HANDOFF_OFFER_DELAY_MS` publishes an open `absent` offer and `hello` lists
    it; a socket closed and reattached within the delay publishes nothing; an owner attach closes an open
    `absent` offer; a `handoff: "prefer"` create publishes `preferred` at admission; takeover and the job's end
    publish `closed`; `POST /:id/handoff` by a non-participant is a 404 and by the creator publishes a
    `requested` offer with the target.
  - Late listeners: the owner-absent tail fixture completes with no `skipped` when a takeover arrives before the
    undelivered `chatOutput` callback expires, and a request-side hook dispatched after the owner's removal is
    answered by the new owner before its 60 s allowance ends; with the worker gone at the end, the creator's
    attach to the ended job, its status, and its kept outcome carry `skipped`; with the owner attached at the
    end, the creator's status and create replay carry `skipped: []` while the owner's terminal lists them; the
    owner at the end reads the kept outcome with its list after collection, while the creator's receipt stores
    `skipped: []`.
  - Stop: a worker's `DELETE` gives the creator's terminal `abortedBy: "other"` and the worker's none, and the
    reverse.

### Slice 2: the tab's roles, the worker policy, the creator's view (D2's tab half, D4, D5, D8; needs 1)

Files: new `src/ts/network/handoff.ts` (preferences, the offers store, acceptance), `src/ts/network/eventFeed.ts`
(the `handoff` frame to the store), `src/ts/network/generationJobs.ts` (the takeover request, the
`followGenerationJob` role and ticket options, the create's `handoff`, `readChatGeneration`'s and
`readGenerationJob`'s `handedOff`), `src/ts/process/serverCommands.ts` (`followJobToEnd`'s ticket option, the
role switch inside a running follow, the role event with `pending`, the lost takeover without the gone path
and the creator's viewer follow resuming after one, the boot resume as viewer, the status lines, the
`missedCallback` toast beside `hooksSkipped`), `src/ts/process/chatStatus.svelte.ts` (no change expected:
following a job already clears its foreign mark; the test pins it), `src/ts/network/jobChannel.ts` (a callback
that reaches a viewer follow anyway is answered `failed`/`protocol` and logged; the server ignores it; a viewer
applies the display notices as the owner does), the Display page beside
`NotificationToggle.svelte` (the two toggles and the name field; `src/lib/Setting/Pages/Display/`),
`src/lang/en.ts` and `ko.ts` (`serverJob.handoff.*`), the network-jobs guide (Generation job client, Job channel,
State), the chat-pipeline guide (Stop for a job this tab does not follow, Replays and uncertain creates: the
one case a tab attaches to a job it did not create), the settings-i18n guide, the plugins guide (Job owner
presence: a hook may run in a tab that does not show the chat; `getRootDocument` finds no message DOM there; a
callback never runs on two tabs, and one in flight on a device that sleeps is not handed over).

- Tests (`src/ts/network/handoff.test.ts`, `eventFeed.test.ts`, `generationJobs.test.ts`,
  `src/ts/network/jobChannel.test.ts`, `src/ts/process/serverCommands.test.ts`, `chatStatus.test.ts`): an open
  offer for another client's job with `acceptHandoffs` on posts the takeover after `pluginsStarted` and attaches
  with the ticket, and with it off does nothing unless targeted; no alternative posts before `pluginsStarted`
  resolves; the creator's own `preferred` offer is left alone; a 409 or 404 from the takeover drops the offer
  and starts no follow; a ticket attach refused before `owner: "self"` ends a takeover follow with no chat
  recovery and no `endedAway`, and in the creator's running viewer follow resumes viewing (one lifecycle, a
  viewer attach without the ticket); with `acceptHandoffs` off, the creator's own `absent` offer and its
  self-targeted `requested` offer ("Take back") are both taken by a role switch inside its running viewer follow
  (one follow, a new socket with the ticket); a role event with `pending: true` shows the
  `serverJob.handoff.pending` line and expects no callback until `owner: "self"`, and a job that ends while
  pending ends the follow as a viewer's; a `done` with `missed` toasts `serverJob.handoff.missedCallback` once,
  from the follow and from the boot resume's status; a viewer follow's `reloadDisplay` and `updateGUI` notices
  bump `ReloadGUIPointer` (`jobChannel.test.ts`); a `handoff` event with `owner: "other"` keeps the follow and
  shows the toast once; `owner: "self"` on a worker runs a `chatOutput` callback under the job's targets with
  another chat selected; a `preferHandoff` create carries `handoff: "prefer"`; the boot resume of a handed-off
  job reads `handedOff`, follows as a viewer, and takes its role from the first event; an ended status with the
  skipped list (no owner at the end) runs the late listeners once and one with `skipped: []` runs none; a
  callback on a viewer follow is answered `failed`/`protocol` and runs no hook (`jobChannel.test.ts`); an
  unknown live-update frame type and an unknown job event type are ignored; a taken-over job moves from
  `foreignJobs` to `followedJobs` and leaves both at its end; a terminal with `abortedBy: "other"` toasts
  `stoppedElsewhere`; the preferences survive a reload and default off.

### Slice 3: presence and the manual handoff (D6; needs 2)

Files: `server/src/routes/events.ts` (the `register` message, the registrations, the `clients` frame and
`hello.clients`, the caps), `shared/events.ts`, `src/ts/network/eventFeed.ts` (send `register` after `hello`
and on change; `connectedClients`), `src/ts/network/handoff.ts` (the name, the request call, the 10 s toast),
`src/lib/ChatScreens/DefaultChatScreen.svelte` (the "Hand off to…" and "Take back" controls beside Stop),
`src/lang/en.ts` and `ko.ts`, the resource-sync guide (Live updates: the one client message), the network-jobs
guide, the chat-pipeline guide.

- Tests (`server/src/tests/events.test.ts`, `src/ts/network/eventFeed.test.ts`, `handoff.test.ts`, a
  `DefaultChatScreen` test if one exists for the Stop control): a registered socket appears in every other
  socket's `clients` frame and leaves on close; an unregistered socket is listed by nobody and still receives
  every frame; a name over the cap is cut; the target tab takes a targeted offer with `acceptHandoffs` off; the
  requester toasts when the offer is still open after 10 s; "Take back" on a viewer follow requests an offer
  targeting this tab, which its own follow takes; two tabs with one name list once with a count.

### Slice 4: the browser check and the final guide pass (needs 3)

Files: new `util/playwright/checkJobHandoff.mjs` (registered in the test-harness guide's driver list beside
`checkJobProtocol.mjs`), `util/playwright/stack.mjs` and `util/playwright/checkJobProtocol.mjs` (the plugin
install, inline in `checkJobProtocol.mjs` today, which exports nothing, extracted to `stack.mjs` first and used
by both drivers), the plugins guide's Tests, a final pass over every guide this plan touched (the
server-generation guide's Limitations gains D3's cascade case).

- Driver cases, one dev stack, two browser contexts (two `clientId`s) and a test plugin with a `chatOutput`
  listener that writes a marker into the message: page A sends and is closed right after `accepted`, page B
  has `acceptHandoffs` on and another chat open; the reply completes, the marker is in the chat, and A
  reopened shows no `hooksSkipped` toast; the same with A kept open shows A the stream, the display notices,
  and the `takenBy` toast; a `preferHandoff` send from A hands off, and B runs every callback dispatched after
  its takeover (the first one may still run on A, the Goal's no-guarantee note); a manual handoff
  from A to B by name; B hidden for the whole job (Q2) still completes it, with the measured hook delay
  recorded in the guide; B closed mid-job reopens an `absent` offer that A, still open, takes back.
- A delivered, unanswered callback at takeover (the pending takeover): A's test plugin holds an `editoutput`
  hook on a latch, and A hands the job to B while it waits; B shows the pending line and runs nothing, A's
  latch is released, the reply carries A's hook text, and B then runs the `chatOutput` listener (the marker).
  In a second run A is closed while the latch holds a `bodyIntercepter`: B takes the `absent` offer as a
  pending takeover, the job ends `disconnected` with B never running the hook, and A reopened shows the error.
  In a third run A is closed while the latch holds the `chatOutput` listener: the job completes, the marker is
  missing, and A reopened shows the `missedCallback` toast.
- Late listeners with no owner at the end: B takes over and is closed and A is closed before `chatOutput`; A
  reopened after the end runs the skipped listener once.
- Device checks (a phone with its screen off and a PC browser minimized on the owner's server) go to the
  user as a checklist and are reported as not run (V5).

## Recommended order

1 → 2 → 3 → 4. Slice 2 is the first user-visible change: after Slice 1 nothing a tab sees differs (every attach
starts with a role event, which today's tab ignores), since no tab requests a takeover or a handoff yet. Slices
1 and 2 give the automatic path the owner asked for (phone sends, PC processes); Slice 3 adds the names and the
explicit request.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every renamed export (`ownJob` →
  `participantJob`).
- Focused: `pnpm --silent test:agent server/src/tests/generationJobs.test.ts server/src/tests/generations.test.ts
server/src/tests/jobChannel.test.ts server/src/tests/events.test.ts server/src/tests/promptTail.test.ts
server/src/tests/llmRoutes.test.ts` for the server; `pnpm --silent test:agent src/ts/network/handoff.test.ts
src/ts/network/eventFeed.test.ts src/ts/network/generationJobs.test.ts src/ts/network/jobChannel.test.ts
src/ts/process/serverCommands.test.ts
src/ts/process/chatStatus.test.ts` for the tab (file names as the slices create them).
- `e2e`: `e2e/perChatSends.spec.ts` after Slice 2 (the follow's role switch touches the per-chat send path).
  Browser: `util/playwright/checkJobProtocol.mjs` after its helper moves (Slice 4) and
  `util/playwright/checkJobHandoff.mjs` after Slice 4, one dev stack at a time.
- Not covered by any gate: the phone-asleep and minimized-PC cases, which are the owner's device checks, and
  the Q2 throttling figure beyond the one measurement the driver records.

## Out of scope

- Hooks with no tab at all (the server plugin runtime plan, retired unbuilt).
- Splitting one job's callbacks across tabs, or two owner sockets at once.
- Refreshing the job's hook list at takeover (the worker's registrations differ from the creator's only when a
  plugin failed to start in one of them).
- Running a delivered callback again on another tab, for any kind (Q4): it would need an idempotency contract
  per effect, which no hook has.
- Presence beyond a name and the worker flag: no per-client status, no remote settings, no remote send (a tab
  accepting "send this input" from another tab was considered and rejected: it must be decided before the send,
  needs the chat selected on the worker, and adds a remote command path the handoff does not need).
- Multi-user servers: takeover is open to every authenticated client because the server holds one user's data.

## Later

- A hooks refresh on takeover (the takeover request of D3 carrying the worker's `registeredHooks()`), if a real
  plugin set ever differs between a user's tabs.
- A headless worker: a server-spawned browser page with `acceptHandoffs` on and no UI, the "virtual client" of
  2026-11-01, built on this protocol unchanged; it needs the browser-per-server decision that ranked it last.
- Reclaim on return: the phone taking its job back when its screen turns on, if the viewer's lack of dialogs
  makes that wanted; today it is the manual "Take back" (D6).
- Per-effect deduplication and a callback execution identity, which would allow transfer mid-callback (Q4's
  option (c)): an id every host-API write and external effect of a callback carries, which the server
  deduplicates, and listener progress a second tab can resume from; it needs a plugin API contract and is
  worth it only if the missed-callback limitation proves common on real devices.
