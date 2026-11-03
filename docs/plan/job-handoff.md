# Job Handoff Plan

Status: drafted 2026-11-03, no slice landed. Decisions D1–D8 are recommendations for the owner; the
**Open questions** Q1–Q3 were answered by the owner on 2026-11-03 (the recommended option each time). Code
anchors were checked at `186b9da71`; verify them again before editing (STRUCTURE.md protocol step 5).

Sources: the owner's 2026-11-03 question (let a stable client, a PC, process the generation of a job a phone
started, since plugin hooks need a tab and the phone's screen turns off) and its assessment: the shape is the
"virtual client" of 2026-11-01 with a real tab in place of a headless browser, built on the owner-socket contract
the job channel already has; the [server generation guide](../structure/server-generation.md) (Generation
channels, Job chat and barriers), the [global API guide](../structure/global-api.md) (Generation job client, Job
channel), the [chat pipeline guide](../structure/chat-pipeline.md) (Stop for a job this tab does not follow,
Replays and uncertain creates), the [resource sync guide](../structure/resource-sync.md) (Live updates), and the
[plugins and MCP guide](../structure/plugins-mcp.md) (Job owner presence) at `186b9da71`.

Owning guides when sliced: [server generation](../structure/server-generation.md) (the owner and viewer
sockets, takeover, the handoff offers), [global API](../structure/global-api.md) (the tab's follow roles, the
worker policy, the offers store), [chat pipeline](../structure/chat-pipeline.md) (what the creator's tab shows
after a handoff), [resource sync](../structure/resource-sync.md) (the new live-update frames and the client
register message), [settings and i18n](../structure/settings-i18n.md) (the device toggles and name),
[plugins and MCP](../structure/plugins-mcp.md) (Job owner presence: what a hook may assume about the tab it
runs in), [test harness](../structure/test-harness.md) (the browser check).

Relation to the server plugin runtime plan (retired unbuilt on 2026-11-03, see
[the archive](../archived-plan/README.md)): that plan would have run the hook half of a plugin on the server
for authors who opted in; this one moves the whole tab role to another tab for every plugin, including
DOM-bound plugins, `bodyIntercepter`, and plugin providers, as long as a worker tab is alive. A server-spawned
headless browser, ranked last on 2026-11-01, would be one more worker client of this protocol if it is ever
wanted (see **Later**).

## Goal

A generation job keeps running its tab-side work when the tab that created it is gone, by handing that work to
another tab of the same user:

- Another tab (a "worker": a PC browser the user marked as one) takes over the owner role of a running job and
  answers its callbacks and questions: plugin hooks, replacers, interceptors, plugin providers, image callbacks,
  MCP tool calls, `alertConfirm` questions.
- The takeover needs no user action on the worker and no chat open there: the worker loads the job's chat into
  its chat store, as a reattaching tab does today, and runs the hooks under the job's targets.
- The tab that created the job keeps watching it (streaming text, the terminal, Stop) and keeps every right it
  has today except answering callbacks.
- Three triggers: the owner went silent (automatic), the creating tab asked at creation to be relieved as soon as a
  worker is there ("prefer a worker"), and the user picked a named worker by hand.
- No new trust: every socket and route keeps the server's JWT; a job's status, abort, and attach stay limited to
  the tabs that take part in it; the server runs no plugin code.

Not goals: hooks without any tab (the server runtime plan), a job's callbacks split across two tabs at once,
reclaiming a job back to the phone automatically, multi-user servers.

## Current state

The baseline is `186b9da71` on `dev` (2026-11-03). This plan does not re-propose it.

- **One owner per job, fixed at creation.** `POST /api/generations` records the creating tab's `clientId`
  (`generationClientId`, one per tab in `sessionStorage`, `src/ts/network/generationJobs.ts`). `ownJob` in
  `server/src/jobs/generationJobs.ts` answers status, abort, `drained`, `memory-stop`, and the socket upgrade of
  `/api/generations/:id/ws` only for that `clientId`; any other client gets a 404 (`handleUpgrade`). The job's
  channel transport carries the same `clientId` (`ChannelTransport`, `server/src/jobs/channel.ts`), which keys
  the per-client request lanes and the absence cascade of queued roots.
- **The owner socket set.** `attach` makes the new socket the job's one owner socket (`job.sockets`), closing the
  previous ones with 4001 "Superseded by a newer connection", clears `ownerAbsentSince`, sends the job chat (a
  patch from `sentChat` while running, whole once ended), the fresh records, the preset, the stage, the current
  reply, then replays every open request (`channelLink.handleAttach`). `sendText` sends events to every socket
  in the set; `frame` accepts pongs and answers only from a socket still in the set ("Only the job's current
  socket speaks for the owner"). `removeOwner` sets `ownerAbsentSince` when the set empties, and
  `expireSilentOwners` removes a negotiated socket silent for `OWNER_SILENT_MS` (45 s).
- **What absence does.** A callback's deadline is capped at `ownerAbsentSince + OWNER_ABSENT_MS` (120 s). On
  expiry, request-side hooks end the job `disconnected`; a completed reply's `editoutput` and
  `replacerafterRequest` keep the text and `chatOutput` runs nothing, recorded in order as `done.skipped`; the
  returning creator runs the skipped listeners once (`replaySkippedListeners`) and toasts
  `serverJob.hooksSkipped`.
- **The tab's follow.** `followJobToEnd` (`src/ts/process/serverCommands.ts`) pins and loads the job's chat
  (`ensureChatLoaded`, not the screen's selection), attaches with `liveness=1&hydration=patch` and an increasing
  `attach` stamp (`followGenerationJob`), applies every event, and reattaches a bounded number of times. The
  boot resume (`resumeServerJobs`) follows the jobs saved per chat in `sessionStorage`. Callbacks run under the
  job's targets (`runHook`, `src/ts/network/jobChannel.ts`); the host API resolves the chat from the call context
  before the tab's selection (`chatsOfRead`, `src/ts/plugins/apiV3/v3.svelte.ts`); the callback barrier
  hydrates the job chat by its ref. A tab therefore processes a job whose chat it does not show, which is how a
  per-chat send keeps working after the user moves to another chat.
- **What other tabs see.** `GET /api/generations/current` answers `owned: false` for another client's job; the
  tab marks it `foreignJobs` (`src/ts/process/chatStatus.svelte.ts`), shows the extra Stop, and never attaches
  ("Follow owned jobs; never attach to a foreign job", chat pipeline). Results reach it through the chat's
  checkpoint writes on the live-update feed.
- **The live-update socket is one-way.** `server/src/routes/events.ts` keeps a `Set<WebSocket>` with no
  identity, ignores incoming messages, and sends `hello` (epoch, `streaming` locks, `memoryTasks`, digest),
  `change`, `memoryTask`, `epoch`, `ping` (`EventFeedFrame`, `shared/events.ts`). `hello`'s snapshots come
  from registry callbacks wired in `server/src/app.ts` (`streamingSnapshot`); the other frames come from the
  change feed (`ChangeFeedEvent`, `server/src/data/changeFeed.ts`).
- **Device-local preferences** live in `localStorage` with a small module each (`pushNotifications.ts`'s
  `REGISTERED_KEY` is the pattern); the Display page's `NotificationToggle.svelte` is a device toggle's UI.

## Decisions

- **D1. Creator and owner are two fields.** `job.clientId` stays the creator and keeps everything attributed
  to it today: the receipt row, `GenerationCurrent.owned`, cancel ownership, `stoppedByOther`, the channel
  transport's `clientId` (the request lanes stay keyed by the creator; the absence cascade already checks each
  entry's own `ownerAttached`). New `job.ownerClientId`, the creator at admission, is the client whose socket
  answers callbacks. `ownJob` becomes `participantJob(jobId, clientId)`: the creator or the current owner may
  read status, attach, abort, report `drained`, and `memory-stop`; everyone else stays a 404.
  `GenerationCurrent` gains `handedOff: boolean` (the owner is not the creator). Rejected: making the owner
  the only identity (the phone's saved job, its receipts, and its Stop would break the moment a worker takes
  over).
- **D2. Owner and viewer sockets; takeover is an attach.** The socket upgrade takes `role=owner|viewer`
  (absent: `owner`, today's tabs) and `takeover=1`.
  - A participant attaching as `owner` while it is the owner: today's `attach`.
  - Any authenticated client attaching with `takeover=1` on a running job: `ownerClientId` becomes that
    client, its socket becomes the one owner socket, and the previous owner's open sockets move to the new
    `job.viewers` set instead of being closed; `ownerAbsentSince` clears; `channelLink.ownerChanged()` re-arms
    deadlines; open requests replay to the new socket (`handleAttach`, unchanged). The attach sends the job
    chat **whole** (not a patch from `sentChat`, which the new client never held) and makes it the new
    `sentChat`, so patch hydration works from there. A takeover of an ended job, or while the server shuts
    down, is a 409.
  - A creator attaching while the job is handed off is attached as a **viewer**, whatever it asked: a phone
    waking up must not yank the hooks back mid-call. Reclaiming is a takeover like any other (the manual
    trigger, D4), never implicit.
  - Viewer sockets receive the job's chat events (whole mode only), fresh records, preset, stage, reply and
    chunk events, and the terminal, so the creator keeps showing the stream; they receive no channel request
    (callback or question) and no notice (toasts and dialogs show on the owner only, Q3), and the terminal
    they get carries `skipped: []` so only the owner replays late listeners. Answers, pongs, and resync
    requests from a viewer socket are ignored (`frame` and the `message` handler check `job.sockets`, as they
    check today for a superseded socket). A viewer socket is not negotiated: its silence changes nothing. Each
    role change is one job event, `{ type: "handoff", owner: "self" | "other", clientName? }`, sent to every
    socket of the job.
  - The create's `GenerationHooks` stay the job's hook list after a takeover: plugins are a server resource,
    so the worker's registrations match the creator's in practice; a hook the worker has not registered
    returns the text unchanged as `runHook` does today, and a hook only the worker registered is not called
    (recorded limitation; a refresh is in **Later**).
- **D3. Handoff offers on the live-update feed.** The registry publishes a change-feed event
  `{ type: "handoff", epoch, jobId, characterId, chatId, state: "open" | "closed", reason: "absent" | "preferred"
| "requested", target?: clientId }` and the events route forwards it as a frame; `hello` gains `handoffs`,
  the open offers (a registry callback beside `streamingSnapshot`), so a worker that connects later still sees
  them. An offer opens when `removeOwner` empties the owner set of a running job (`absent`), at admission when
  the create body says `handoff: "prefer"` (`preferred`; the creator still attaches as owner and is the
  fallback), and on `POST /api/generations/:id/handoff` by a participant (`requested`, with `target` when the
  user picked a client). It closes on takeover and on the job's end; a closed frame names the same job. An
  `absent` offer also opens when a worker that took over goes silent, so the next worker, or the creator's own
  live tab, takes the job (D4).
- **D4. The worker policy lives in the tab, device-local.** A new module `src/ts/network/handoff.ts` keeps
  three `localStorage` preferences: `acceptHandoffs` (default off: this tab takes open offers), `preferHandoff`
  (default off: this tab's creates carry `handoff: "prefer"`), and `clientName` (default from the user agent,
  editable). It holds the offers store fed by `eventFeed.ts` and decides per open offer: not this tab's own
  job (unless the reason is `absent` and this tab is the creator, which then takes its own job back),
  `acceptHandoffs` on or `target` is this client, `pluginsStarted()` resolved, then
  `followJobToEnd(jobId, ref, undefined, { takeover: true })`. The server picks the first attach; a 409 or 404
  drops the offer here. The follow's role is whatever the `handoff` event says: a tab told `owner: "other"`
  keeps following as a viewer and expects no callback; a tab told `owner: "self"` is the owner. The worker's
  chat is pinned and loaded by the follow as today, and `followedJobs` lists it, so its Stop and busy state
  work; a small status line (`serverJob.handoff.working`) names the job's character while a takeover runs.
- **D5. The creator after a handoff.** Its follow keeps running as a viewer: the stream and the terminal
  arrive, Stop works (abort is a participant right), the saved job resumes at boot as a viewer, and the terminal
  path never replays skipped listeners (the terminal says `skipped: []`). The `handoff` event with `owner:
"other"` shows a toast naming the worker (`serverJob.handoff.takenBy`, with `clientName` when the server knows
  one, Slice 3) and clears nothing: the job is still this tab's. A `done.skipped` can still be non-empty on the
  owner's terminal when no worker existed; that path is unchanged.
- **D6. Presence and the manual trigger.** The live-update socket accepts one client message,
  `{ type: "register", clientId, name, worker: boolean }`, sent after every `hello` and on a preference change
  (a socket that never registers is an older tab: listed by nobody, sent everything as today). The route keeps
  the registration per socket and publishes `{ type: "clients", clients: [{ clientId, name, worker }] }` to
  every socket on join, leave, and change, and includes it in `hello`. The tab keeps `connectedClients`; the
  chat's job controls (`DefaultChatScreen.svelte`, beside the Stop this tab shows for its own job) offer "Hand
  off to…" listing the other clients with `worker` on, which calls `POST /api/generations/:id/handoff`
  `{ clientId, target }`; the target's tab takes the offer by D4 (a targeted offer ignores `acceptHandoffs`
  since the user chose it), and the requester toasts if the offer is still open after 10 s. Two tabs of one
  browser share a name; the list shows each once with its tab count.
- **D7. Security and limits.** Every new query, route, and message runs under the existing JWT and epoch
  checks. Takeover is open to any authenticated client of this single-user server (as reading
  `/current` and stopping another client's job already are); the participant check narrows status and abort
  to the creator and the owner. The worker never receives the creator's secrets: the job sends the same
  records it sends today, and the worker's own device-local keys apply to the work it does (image
  generation, plugin `safeLocalStorage`), which the guide states. A takeover during an outstanding callback
  replays it to the new owner and refuses the old owner's late answer (today's superseded-socket rule); at
  most one owner socket ever speaks. `register` names are capped at 64 characters and the `clients` list at
  64 entries. Offers carry no chat text.
- **D8. Compatibility.** An older tab sends no `role` and no `register`: it is the creator-owner of its own
  jobs exactly as today and never a worker; it is attached as a viewer if a newer tab took its job, and it
  handles the unknown `handoff` and `clients` frames as its switch handles unknown types (ignored; verify in
  Slice 2 that `receive` and the job event dispatcher drop an unknown `type` instead of throwing). An older
  server answers a `takeover=1` upgrade of a non-creator with 404, which the worker treats as "no handoff on
  this server" and drops silently. `GenerationCurrent.handedOff` and the create's `handoff` are optional.
  Receipts and their reads are unchanged (creator).

## Open questions

All three were answered on 2026-11-03 with the recommended option; they are kept here as the record of why.

- **Q1. Which tabs are workers by default.** Answered: none; the user turns `acceptHandoffs` on per device
  (a PC) and `preferHandoff` on per device (a phone). The alternative, every desktop tab a worker by default,
  surprises a user who sees a chat lock up on their PC.
- **Q2. A background tab as a worker.** Answered: eligible. A hidden PC tab still receives socket messages
  and answers pings, but Chrome's intensive throttling slows timers after five minutes hidden, which can delay
  a hook that waits on a timer; the Slice 4 driver measures a hidden worker and the guide states the limit.
  The alternative (visible tabs only) leaves the common "PC on, browser minimized" case uncovered.
- **Q3. Notices to viewers.** Answered: none; the owner alone shows toasts and dialogs, and a question
  answered twice is a protocol error. The alternative, toasts to viewers too, would show the creator the
  job's warnings but duplicate them when both tabs are on one desk (**Later** keeps the reversal).

## Slices

Each slice lands alone with the gates in **Verification** and updates the guides it changes. Slice 1 edits
`shared/jobs.ts` and `server/src/jobs/channel.ts`: not in parallel with the server plugin runtime plan's
Slices 1, 4, or 5.

### Slice 1: creator and owner on the server, takeover, offers (D1, D2, D3, D7; needs nothing)

Files: `server/src/jobs/generationJobs.ts` (`ownerClientId`, `viewers`, `participantJob`, the `role` and
`takeover` queries of `handleUpgrade`, whole hydration on takeover, viewer event routing, the terminal's
`skipped` per role, the `handoff` job event, offers and their feed events, `handoffSnapshot`), `server/src/jobs/channel.ts`
(the transport comment: `clientId` is the creator; no behavior change), `server/src/data/changeFeed.ts`
(`handoff` event), `server/src/routes/events.ts` (the `handoff` frame, `hello.handoffs`),
`server/src/routes/generations.ts` (`POST /:id/handoff`, the participant check on the routes),
`server/src/app.ts` (wiring), `shared/jobs.ts` (`GenerationCurrent.handedOff`, `GenerationCreateBody.handoff`,
the `handoff` job event, `GenerationHandoffBody`), `shared/events.ts` (the `handoff` frame, `hello.handoffs`),
the server-generation guide (Generation channels, Flows, State, Invariants, Limitations).

- Tests (`server/src/tests/generationJobs.test.ts`, `jobChannel.test.ts`, `events.test.ts`, `promptTail.test.ts`,
  with the real channel hub and the registry's fake clock): a second client's upgrade without `takeover` is a
  404 and with it becomes the owner, receives the chat whole, and gets the open callback replayed; the old
  owner's socket turns into a viewer, receives chunk and terminal events, and its late answer to that callback
  is ignored; a viewer's terminal has `skipped: []` while the owner's lists the skipped hooks; the creator's
  status, abort, and `current` (`owned: true, handedOff: true`) still answer, and a third client's do not; an
  owner set that empties publishes an open `absent` offer and `hello` lists it; a `handoff: "prefer"` create
  publishes `preferred` at admission; takeover and the job's end publish `closed`; a takeover of an ended job
  is a 409; the owner-absent tail fixture completes with no `skipped` when a takeover arrives before the
  `chatOutput` callback expires, and a request-side hook outstanding at silence is answered by the new owner
  within the 120 s window; the creator attaching after a takeover is a viewer; receipts keep the creator.

### Slice 2: the tab's roles, the worker policy, the creator's view (D4, D5, D8; needs 1)

Files: new `src/ts/network/handoff.ts` (preferences, the offers store, acceptance), `src/ts/network/eventFeed.ts`
(the `handoff` frame to the store; unknown types verified ignored), `src/ts/network/generationJobs.ts`
(`followGenerationJob` role and takeover options, the create's `handoff`, `readChatGeneration`'s `handedOff`),
`src/ts/process/serverCommands.ts` (`followJobToEnd` takeover option, the `handoff` event's role switch,
viewer follows skip `replaySkippedListeners`, the boot resume as viewer, the status line),
`src/ts/process/chatStatus.svelte.ts` (a taken-over job leaves `foreignJobs` for `followedJobs`),
`src/ts/network/jobChannel.ts` (no callback expected on a viewer follow: a callback that arrives anyway is
answered `unregistered` and logged), the Display page beside `NotificationToggle.svelte` (the two toggles
and the name field; `src/lib/Setting/Pages/Display/`), `src/lang/en.ts` and `ko.ts`
(`serverJob.handoff.*`), the global-api guide (Generation job client, Job channel, State), the chat-pipeline
guide (Stop for a job this tab does not follow, Replays and uncertain creates: the one case a tab attaches to
a job it did not create), the settings-i18n guide, the plugins guide (Job owner presence: a hook may run in a
tab that does not show the chat; `getRootDocument` finds no message DOM there).

- Tests (`src/ts/network/handoff.test.ts`, `eventFeed.test.ts`, `generationJobs.test.ts`,
  `src/ts/process/serverCommands.test.ts`, `chatStatus.test.ts`): an open offer with `acceptHandoffs` on
  follows the job with `takeover=1` after `pluginsStarted`, and with it off does nothing unless targeted; the
  creator's own `absent` offer is taken back regardless of the toggle; a 409 drops the offer; a `handoff`
  event with `owner: "other"` keeps the follow, shows the toast once, and makes the terminal path skip the
  late replay; `owner: "self"` on a worker runs a `chatOutput` callback under the job's targets with another
  chat selected; a `preferHandoff` create carries `handoff: "prefer"`; the boot resume of a handed-off job
  follows as a viewer; a taken-over job moves from `foreignJobs` to `followedJobs` and back on its end; the
  preferences survive a reload and default off.

### Slice 3: presence and the manual handoff (D6; needs 2)

Files: `server/src/routes/events.ts` (the `register` message, the registrations, the `clients` frame and
`hello.clients`, the caps), `shared/events.ts`, `src/ts/network/eventFeed.ts` (send `register` after `hello`
and on change; `connectedClients`), `src/ts/network/handoff.ts` (the name, the request call, the 10 s toast),
`src/lib/ChatScreens/DefaultChatScreen.svelte` (the "Hand off to…" control beside Stop), `src/lang/en.ts`
and `ko.ts`, the resource-sync guide (Live updates: the one client message), the global-api guide, the
chat-pipeline guide.

- Tests (`server/src/tests/events.test.ts`, `src/ts/network/eventFeed.test.ts`, `handoff.test.ts`, a
  `DefaultChatScreen` test if one exists for the Stop control): a registered socket appears in every other
  socket's `clients` frame and leaves on close; an unregistered socket is listed by nobody and still receives
  every frame; a name over the cap is cut; `POST /:id/handoff` by a non-participant is a 404 and by the
  creator publishes a `requested` offer with the target; the target tab takes a targeted offer with
  `acceptHandoffs` off; the requester toasts when the offer is still open after 10 s; two tabs with one name
  list once with a count.

### Slice 4: the browser check and the final guide pass (needs 3)

Files: new `util/playwright/checkJobHandoff.mjs` (registered in the test-harness guide's driver list beside
`checkJobProtocol.mjs`, whose plugin-install and settle helpers it reuses), the plugins guide's Tests, a final
pass over every guide this plan touched.

- Driver cases, one dev stack, two browser contexts (two `clientId`s) and a test plugin with a `chatOutput`
  listener that writes a marker into the message: page A sends and is closed right after `accepted`, page B
  has `acceptHandoffs` on and another chat open; the reply completes, the marker is in the chat, and A
  reopened shows no `hooksSkipped` toast; the same with A kept open shows A the stream and the `takenBy`
  toast; a `preferHandoff` send from A hands off before the first callback; a manual handoff from A to B by
  name; B hidden for the whole job (Q2) still completes it, with the measured hook delay recorded in the
  guide; B closed mid-job reopens an `absent` offer that A, still open, takes back.
- Device checks (a phone with its screen off and a PC browser minimized on the owner's server) go to the
  user as a checklist and are reported as not run (V5).

## Recommended order

1 → 2 → 3 → 4. Slice 2 is the first user-visible change: after Slice 1 nothing a tab sees differs, since no
tab sends `takeover` or `handoff` yet. Slices 1 and 2 give the automatic path the owner asked for (phone
sends, PC processes); Slice 3 adds the names and the explicit request.

## Verification

- Every slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the slice's focused files while iterating),
  `pnpm format:check`, `pnpm check:docs` for guide edits, V4 for every renamed export (`ownJob` →
  `participantJob`).
- Focused: `pnpm --silent test:agent server/src/tests/generationJobs.test.ts server/src/tests/jobChannel.test.ts
server/src/tests/events.test.ts server/src/tests/promptTail.test.ts` for the server;
  `pnpm --silent test:agent src/ts/network/handoff.test.ts src/ts/network/eventFeed.test.ts
src/ts/network/generationJobs.test.ts src/ts/process/serverCommands.test.ts src/ts/process/chatStatus.test.ts`
  for the tab (file names as the slices create them).
- `e2e`: `e2e/perChatSends.spec.ts` after Slice 2 (the follow's role switch touches the per-chat send path).
  Browser: `util/playwright/checkJobHandoff.mjs` after Slice 4, one dev stack at a time.
- Not covered by any gate: the phone-asleep and minimized-PC cases, which are the owner's device checks, and
  the Q2 throttling figure beyond the one measurement the driver records.

## Out of scope

- Hooks with no tab at all: the server plugin runtime plan.
- Splitting one job's callbacks across tabs, or two owner sockets at once.
- Refreshing the job's hook list at takeover (the worker's registrations differ from the creator's only when a
  plugin failed to start in one of them).
- Presence beyond a name and the worker flag: no per-client status, no remote settings, no remote send (a tab
  accepting "send this input" from another tab was considered and rejected: it must be decided before the send,
  needs the chat selected on the worker, and adds a remote command path the handoff does not need).
- Multi-user servers: takeover is open to every authenticated client because the server holds one user's data.

## Later

- A hooks refresh on takeover (`takeover` attach carrying the worker's `registeredHooks()` through a short
  `POST /:id/takeover` ticket), if a real plugin set ever differs between a user's tabs.
- Notices to viewers (Q3 reversed) if the creator's missing warnings turn out to matter.
- A headless worker: a server-spawned browser page with `acceptHandoffs` on and no UI, the "virtual client" of
  2026-11-01, built on this protocol unchanged; it needs the browser-per-server decision that ranked it last.
- Reclaim on return: the phone taking its job back when its screen turns on, if viewers' lack of notices makes
  that wanted; today it is the manual trigger.
