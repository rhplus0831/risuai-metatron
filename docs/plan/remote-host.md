# Remote Host Plan

Status: drafted 2026-11-15 at `952c4baec` from the owner's idea of the same day (a tab in "Remote Host Mode" that other
devices ask to send a message or reload its plugins), then audited against the code at that commit
([report](../reports/audits/plan-runner/remote-host-2026-11-15.md)) and corrected in the same commit as the report. D1
to D3 are the owner's answers of 2026-11-15; D4 on are this plan's own and open to the owner's change. The relay's
states, the place of the remote branch, Stop, the reload's completion, and D1, D3, D9, and D10 took their present form
from the audit. M1 to M3 were read again in two further turns the same day, which reshaped Stop and the returned
reports (R1 to R5, then S1 to S5); the corrections for S1 to S5, all P2, were applied without a further reading. Landed: 1 (`70069d83d`), 2 (`34c397120`), 3 (`388db8c4e`), 4 (`67eff665d`), 5 (`e48176226`), 6 (`36286b681`), 7 (`31afc0e85`).

Sources: `FeedClient`, `EventFeedClientMessage`, `EventFeedFrame`, and `HandoffOffer` in `shared/events.ts`;
`createEventSockets`, its `registrations` map, `send`, and `broadcast` in `server/src/routes/events.ts`; the handoff and
takeover routes in `server/src/routes/generations.ts`; `limitedBody` in `server/src/routes/limitedBody.ts`; the route
assembly and the own-limit dispatch in `server/src/app.ts`; `create`, `requestFingerprint`, `armOffer`, `openOffer`, and
`keptOutcomes` in `server/src/jobs/generationJobs.ts`; `QUESTION_TIMEOUT_MS` and `CALLBACK_TIMEOUT_MS` in
`server/src/jobs/channel.ts`; `registerClient` and `receive` in `src/ts/network/eventFeed.ts`; the preferences,
`replaceConnectedClients`, `registration`, and `handoffTargets` in `src/ts/network/handoff.ts`; `generationClientId`,
`savedGenerationJobs`, and `generationPluginWorkActive` in `src/ts/network/generationJobs.ts`; `applyEffect`,
`registeredHooks`, and `replaySkippedListeners` in `src/ts/network/jobChannel.ts`; `sendChat` and `runSend` in
`src/ts/process/index.svelte.ts`; `beginLocalSend` in `src/ts/process/localSends.ts`; `ServerSendArg`,
`ServerSendResult`, and `sendChatOnServer` in `src/ts/process/serverGeneration.ts`; `runServerJob`, `recoverJobChat`,
and `resumeServerJobs` in `src/ts/process/serverCommands.ts`; `foreignGeneration` in
`src/ts/process/generationProgress.svelte.ts`; `cancelGenerationRequest` in `src/ts/network/generationJobs.ts`;
`reportEnd` and `readRecoveringChat` in `src/ts/process/serverCommands.ts`; `alertJobError` in `src/ts/alert.ts`;
`sendMain`, `sendConsumed`, `sendChatMain`, and `abortChat` in
`src/lib/ChatScreens/DefaultChatScreen.svelte`; `createSendDrafts` in `src/ts/process/sendDraft.ts`;
`rerollHistory.ts`; `loadPlugins`, `loadSignature`, `applyPluginLoad`, `deferredForced`, `requestDeferredReload`,
`queueDeferredCheck`, and `pluginsStarted` in `src/ts/plugins/plugins.svelte.ts`; `pluginWorkIdle` in
`src/ts/plugins/apiV3/v3.svelte.ts`; `safeBootOff` in `src/ts/safeBoot.ts`; `selectChat` in
`src/ts/storage/chatStore.svelte.ts`; `selectCharacter` and `setChatOpen` in `src/ts/storage/selection.svelte.ts`;
`src/lib/Setting/Pages/Display/HandoffToggles.svelte`; `src/ts/setting/displaySettingsData.svelte.ts` and
`src/ts/setting/customComponents.ts`; the overlays of `src/App.svelte`; `src/ts/hotkey.ts`; `createPushService` in
`server/src/push/pushService.ts`; the Job Handoff plan (`git show c34f69365:docs/plan/job-handoff.md`). The identifiers
are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A tab the user leaves open on a PC serves as the place where sends run, so a phone can send and close.

- **Remote Host Mode.** A device-local switch. While it is on, the tab shows a lock screen over the app, the user does
  not operate it, and it serves commands from the user's other tabs and devices. The screen has one control that leaves
  the mode.
- **Remote send.** Another device chooses a host. Its Send then hands the text and the chat to the host, and the host
  sends it through its own send path, as if the user had typed it there. The host creates the job and is its owner from
  admission, so it normally answers the job's plugin callbacks from the first one (D1 names the exception).
- **Remote plugin reload.** Another device asks the host to reload its plugins, or to reload its page, so that a plugin
  that reads its configuration only at startup picks up a change.
- **Fallback, as an option.** When the host certainly did not take a send, the sending device sends it itself, as
  today.
- **The sending device watches as an observer.** It sees the user message, the reply (at the checkpoint cadence, which
  the owner accepted: a few seconds), the progress entry, and Stop.

Not goals: the server running plugin code (the Server Plugin Runtime plan, retired unbuilt); repairing or replacing Job
Handoff, which stays as it is; a host that answers dialogs for an absent user; remote previews, slash commands, and
settings; multi-user servers.

## Current State

- **Why the owner asked.** The owner reports a plugin (an illustration generator) that registers `editoutput`, the
  `beforeRequest`/`afterRequest` replacers, and a `chatOutput` listener, and that lost its work several times when the
  send came from a phone that then slept: mostly without a visible reason, once with an error. The incidents were not
  reproduced or attributed. The code has paths consistent with both:
  - A request-side callback (`replacerbeforeRequest`) that ends `disconnected` ends the job
    ([Generation channels](../structure/server-generation.md#generation-channels)).
  - A completed reply's `editoutput` is skipped and never runs late: `replaySkippedListeners` replays `chatOutput`
    listeners only, and a `chatOutput` already delivered to a device that then slept is `missed`.
- **Job Handoff cannot prevent it.** The creator is the owner from admission. `create` opens a `preferred` offer and
  starts the job without waiting for a worker, a delivered callback is never run again on another tab, and a sleeping
  device's socket counts as open for `OWNER_SILENT_MS` (45 s). Its phone and hidden-worker checks are still unrun
  ([manual checks](../backlog/manual-checks.md)).
- **Absent offers do not depend on the preference.** `create` calls `armOffer` for every job: an owner absent for
  `HANDOFF_OFFER_DELAY_MS` (10 s) opens an `absent` offer that any accepting worker may take, with or without
  `handoff: "prefer"`.
- **Remote send was set aside once.** The Job Handoff plan's Out of scope lists "a tab accepting 'send this input'
  from another tab": it must be decided before the send, needs the chat selected on the worker, and adds a command
  path. The first is now the wanted behavior. The second no longer holds: `sendChat` takes `target` (a `ChatRef`:
  `chaId`, `chatId`), and the chat needs to be listed, not selected or loaded. The third is this plan's cost.
- **The feed has presence, not addressing.** A tab sends one message, `register` (`clientId`, `name`, `worker`); the
  server keeps it per socket, builds the entry from the known fields only, and publishes the whole list (`clients`).
  Published events go to every socket; `hello` and `ping` are sent per socket, but nothing sends to a client id.
  Incoming messages are capped at 4096 bytes; outgoing frames pass the byte-counted buffer admission of `send`.
- **A send's identity survives a retry by another client.** `requestFingerprint` covers the kind, the chat, the input,
  and the message ids, not the client, and `create` looks the request up before its gates and installs it before the
  runner starts. A second create under the same `requestId` and fields is a replay: no second user message, and no
  success invented for a client that does not own the job (the audit's create matrix). The identity is kept as long as
  the receipts are (72 h, 10,000 rows, the same epoch).
- **What `runSend` does below the screen**, for every send: it takes the chat's entry in the local send registry
  (`beginLocalSend`) before its first await; `runServerJob` then pins the chat, flushes this tab's pending writes and
  refuses the send when one was discarded, refreshes a stale chat, and creates the job. The screen's Stop aborts the
  signal it passed, and while that send runs the screen hides the foreign-job Stop control. A send passes
  `stopOverLoreBudget`, and its end can carry `loreStop` and `blockedChats`.
- **What a job takes from its creating tab:** its plugin hook list (`registeredHooks`), `client.viewport` and
  `browserLanguage`, recent emotions, and `preferHandoff`. The preset, model preset, and persona come from the chat's
  binding.
- **An observer tab** sees a foreign job through the feed: a content-free progress entry (`foreignGeneration`), message
  locks, and the chat's committed writes, which it reads after the frame. A streamed reply is written every 3 s
  (`CHECKPOINT_INTERVAL_MS`); a quiet (Half Streaming) reply only at its end. Its Stop is the chat-slot stop, after a
  confirmation. Nothing orders a chat read against another message that tells the tab the job ended.
- **Plugin reload.** `loadSignature` is each enabled plugin's name, script, and `allowedIPC`. A remote change of a
  plugin's arguments reloads nothing (they are read live), so a plugin that copied them at startup keeps the old
  values. The only forced deferred reload with an unchanged signature is the permission reset (`deferredForced`); it is
  private, returns nothing, and reports no outcome. `pluginsStarted` waits for loads already on the chain, not for a
  deferred one. `loadPlugins` does not wait for plugin work to be idle.
- **Storage a plugin can hold its configuration in:** arguments and `pluginStorage` are server records and reach every
  device; `safeLocalStorage` is this browser's `localStorage` and never leaves it.
- **A page reload keeps the tab's identity.** `generationClientId` and the saved jobs live in `sessionStorage`; boot
  loads plugins and then `resumeServerJobs` follows the saved jobs again. A callback that was in flight is refused when
  it is replayed to the new page, so its job can fail. No shared "safe reload" helper exists.
- **Dialogs.** A job's question and callback have dispatch-relative deadlines (`QUESTION_TIMEOUT_MS` 120 s,
  `CALLBACK_TIMEOUT_MS` 60 s, with the owner-absence bounds). A plugin permission prompt (`alertConfirm`) and an error
  dialog have none: they stay until a person answers. An open error does not block a later send; dialogs queue.
- **Notices.** The `tts` and `notification` notices of a job go to its creator (`applyEffect`). A completion Web Push
  goes to every subscription, whoever created the job.
- **No wake lock** is requested anywhere in the tab.

## Rules For Every Slice

- A remote-command frame carries no command body and no chat text. A command's body travels by HTTP only and stays in
  server memory only. (Resource change frames carry chat data as they do today.)
- The server runs no command itself: it stores, notifies, and reports. Everything a command does happens in the host
  tab, through functions the tab already has.
- A command is `delivered` only by its target's authenticated read of the body, never because a frame was queued.
- A send command is safe to run twice: it carries the sender's `userMessageId` and `requestId`, and the host passes
  them through unchanged. A reload command runs once per command id (the host remembers the ids it ran).
- A missing or forgotten command is uncertain, never proof that no generation ran.
- An older server or tab leaves today's behavior: an old server builds presence without `host`, so no host is listed
  and no remote send starts; an old tab ignores an unknown frame (`receive` has no default branch).
- V1 to V9 apply. New strings go to `src/lang/en.ts` and `src/lang/ko.ts`. Each slice updates the guides it names and
  the path ownership of its new files (`pnpm docs:owner <path>`, `pnpm check:docs`).

## Order

1, 2, 3, 4, 5 in that order; then 6 and 7, one after the other in either order. 6 and 7 are not disjoint: both extend
the command contract (`shared/remoteCommands.ts`), its server validation, `src/ts/network/remoteHost.ts`, and the
language files, so the later one re-reads the earlier one's changes.

Files the slices share: `shared/remoteCommands.ts` (1, 3, 4, 6, 7), `src/ts/network/remoteHost.ts` (2, 3, 6, 7),
`src/ts/network/remoteSend.ts` (4, 5, 7), `src/ts/network/handoff.ts` and `src/ts/network/eventFeed.ts` (2, 3, 4), the
Display settings files and the language files (2, 5, 6).

## Slice 1. The command relay on the server (_hard_, `live-update-feed.md`, `self-host-server.md`)

New files: `shared/remoteCommands.ts` (the command union, the states, the result shapes, the caps; add an ownership rule
that gives it to `self-host-server`), `server/src/remoteCommands.ts` (the registry),
`server/src/routes/remoteCommands.ts`,
`server/src/tests/remoteCommands.test.ts`. Existing: `shared/events.ts`, `server/src/routes/events.ts`,
`server/src/app.ts`, `server/src/tests/events.test.ts`.

- **Presence.** `FeedClient` gains an optional `host: boolean`. The register handler stores it when it is a boolean;
  the `clients` frame carries it.
- **One-client send.** `createEventSockets` returns `sendToClient(clientId, frame)`: the newest registration of that
  id only, through `send` with the frame's UTF-8 byte length. Host eligibility reads the same newest registration: a
  newest `host: false` is not a host, whatever an older socket said.
- **The registry.** Process-local, each command with its epoch, sender, target, body, state, attempt count, and times.
  A command of another epoch is dropped on the next read, and shutdown clears the registry (from `server/src/app.ts`'s
  shutdown). Caps (test-overridable): 16 open commands per target, a body of 1 MiB (`limitedBody`, with the route in
  `app.ts`'s own-limit dispatch), pickup within 30 s, a closed command kept 10 minutes.
- **States.**
  - `queued`: stored, the target notified.
  - `delivered`: the target read the body.
  - `running`: the host started it.
  - `uncertain`: the host's run ended without a known outcome, or the host reported that it lost the run (a reload).
  - Closed: `done` (the host's result), `refused` (the host certifies it never attempted the command, with a code),
    `expired` (not read within the pickup time), `cancelled` (the sender cancelled it before it was read). The body of
    an `expired` or `cancelled` command is deleted and a read answers 410.
  - `attempted` is set once a command reaches `running`. A refusal reported for an attempted command leaves it
    `uncertain`.
  - An open command is dropped 40 minutes after its last state change. This is housekeeping, set above a job's
    30-minute limit (`JOB_MAX_DURATION_MS`); the drop proves nothing about a job, whose limit counts from its own
    admission. The sender is told with a `remoteCommandState` of `forgotten`, which it treats as uncertain.
- **The body stays readable by its target** in `queued`, `delivered`, `running`, and `uncertain`.
- **Identity.** A send command is the same command when its id and its action fields match: the type, `chaId`,
  `chatId`, `input`, and `userMessageId`, the fields `requestFingerprint` compares. The registry keeps the first
  accepted body, and a re-post never changes it: `inputOriginal` and `stopOverLoreBudget` can differ on a retry of the
  same request id (the screen reads both again at each press), and the first ones stand, as the first attempt's do in
  a replayed create. A reload command matches on its type and mode. Retry hints are not in the body: the read's answer
  carries `attempted`, and the host derives `requestUncertain` from it. The post carries `uncertain` beside the command
  (the send's own `requestUncertain`), outside the identity: a command created or re-posted with it has `attempted`
  set, so a relay that forgot a command does not clear what its sender still knows.
- **Cancellation is sticky until the next Send.** `stopRequested` stays on the command, and every read, state
  acknowledgement, and notification of it carries the flag, until the sender posts the command again: the sender
  re-posts only for a new Send (slice 4), so a matching re-post of an open command clears `stopRequested` and notifies
  the target again, and the Send after a Stop that ended uncertain runs as `attempted`. A host's run already aborted
  stays aborted. The registry is synchronous, so a cancel and a read of a `queued` command are
  ordered: the cancel first closes it and no body leaves; the read first delivers it with the stop still to come. A
  cancel of an id the registry does not hold stores nothing and answers 404 `unknownCommand`, which certifies nothing:
  the command may have been forgotten after it ran, or its post may still be on its way.
- **The relay never stops a generation.** A cancel only keeps a command from being delivered or dispatched. Stopping
  a job that may exist, and refusing a create that has not arrived yet (a post that the cancel overtook still reaches
  the host), is the generation cancel by request id, which the sender calls itself at every Stop (slice 4).
- **Routes**, mounted explicitly in `server/src/app.ts`, each with the generation routes' pattern copied (the
  authenticated limiter, `auth.checkAuth`, `no-store`, the `x-resource-epoch` comparison answering 412):
  - `POST /api/remote-commands` `{ clientId, target, commandId, command, uncertain? }`. An existing `commandId` is
    looked up before the target. A matching command clears `stopRequested`, answers its state and, in `delivered`,
    `running`, or `uncertain`, notifies its target again; a command whose action fields differ is a 409. A matching command closed as `expired`,
    `cancelled`, or `refused` is replaced by the post, as a new command: no run started under that entry, and
    the sender is asking again (a Send after a Stop that ended uncertain). The command keeps its first target while
    that target is a registered host; when it is not, a re-post naming another host moves the command there, with
    `attempted` kept. A new command for a target that is not a registered host is a 404 `targetUnavailable`.
  - `GET /api/remote-commands/:id?clientId=`: the body, `attempted`, and `stopRequested`, for the target only.
  - `POST /api/remote-commands/:id/state` `{ clientId, state, ... }`: from the target only; the answer carries
    `stopRequested`.
  - `POST /api/remote-commands/:id/cancel` `{ clientId }`: from the sender only. A `queued` command becomes
    `cancelled`; a later state gets `stopRequested`, and the target is notified; an unknown id is a 404
    `unknownCommand`. The sender does not branch on the answer (slice 4).
  - `GET /api/remote-commands/:id/status?clientId=`: for the sender. An unknown id is a 404 with the code
    `unknownCommand`, which an old server's plain 404 does not have.
- **Frames**, through `sendToClient`: `{ type: "remoteCommand", epoch, commandId, stop? }` to the target, and
  `{ type: "remoteCommandState", epoch, commandId, state, code? }` to the sender on each change.
- **On a host's registration**, the server notifies it again of each open command it is the target of, with the stop
  flag. A frame lost while the host's feed was down is thereby repeated at its reconnect.
- **Diagnostics** record a command's id, type, state, and body size, never its text.
- Tests: `events.test.ts` (the flag in presence; a frame reaches only the newest socket of its target id; a newest
  `host: false` hides an older host; a host's registration repeats its open commands) and `remoteCommands.test.ts`
  (each state and each refused transition; the pickup expiry and the open-command drop on a fake clock; the caps; the
  epoch change; the same id with matching fields and another `inputOriginal`, which keeps the first body; the same id
  with another `input`, which is a 409; a re-post that notifies again; a re-post that moves a command off a host that
  left; a post with `uncertain` leaves the command `attempted`; a refusal after `running` stays `uncertain`; a read or
  a state report by the wrong client; the cancel in each state, of an unknown id (a 404, nothing stored, and a later
  post of that id is accepted), and against a read; the drop of an open command tells its sender `forgotten`).

## Slice 2. Host mode in the tab (`network-jobs.md`, `live-updates.md`, `app-shell.md`, `settings-i18n.md`, `ui-theming.md`)

New files: `src/ts/network/remoteHost.ts` with its test, `src/lib/Others/RemoteHostScreen.svelte`,
`src/lib/Setting/Pages/Display/RemoteHostControls.svelte`. Existing: `handoff.ts`, `eventFeed.ts`, `src/App.svelte`,
`src/ts/hotkey.ts`, `jobChannel.ts`, `src/ts/setting/displaySettingsData.svelte.ts`,
`src/ts/setting/customComponents.ts`, the language files.

- **The preference.** `remoteHost.ts` keeps `hostMode` in `localStorage` (`risu-remote-host`), in the form of
  `handoff.ts`'s `preference` (which also follows a change made in another tab of the browser). `registration` adds
  `host`, `replaceConnectedClients` keeps it, and `registerClient` also re-registers on its change.
- **The lock screen.** `RemoteHostScreen.svelte`, mounted by `src/App.svelte` while `hostMode` is on. It covers the
  sidebar, the chat, and settings, and the chat screen stays mounted under it (D7). `AlertComp` stays above it, so a
  person at the PC can answer a dialog. It shows the client name, the feed's connection state, this tab's running jobs
  (from the job and progress registries: `HandoffStatus.svelte` lists handoff work only), the last commands with their
  results, the dialogs that are waiting, and "Leave host mode". The loading screen already covers the app before the
  database loads.
- **Input behind it.** The covered tree is `inert`; the lock screen's own control and the alert layer are not.
  `src/ts/hotkey.ts` skips the app's shortcuts in host mode and keeps the dialog keys.
- **While a host**, `applyEffect` skips the `tts` and `notification` notices (D8) and nothing else.
- The switch is in Settings → Display, in `RemoteHostControls.svelte` beside `HandoffToggles.svelte`'s controls, with a
  help text that says what the mode is for and that the tab must stay open.
- Tests: the registration carries the flag and is re-sent on a change; presence decoding keeps `host`; the app
  shortcuts are skipped in host mode and a dialog key is not; `applyEffect` skips the two notices only.

## Slice 3. The host runs a send (_hard_, `network-jobs.md`, `chat-pipeline.md`)

Existing: `remoteHost.ts` and its test, `shared/remoteCommands.ts` with the server validation, `eventFeed.ts`,
`src/ts/process/serverGeneration.ts`, `src/ts/process/serverCommands.ts`.

- **The command.** Type `send`, with `chaId`, `chatId`, `input`, `userMessageId`, `requestId`, and the optional
  `inputOriginal` and `stopOverLoreBudget`.
- **A local-only send.** `ServerSendArg` gains a flag that keeps a send on this tab (`runSend` never routes it to a
  host). The host's runs set it, so a browser that has both host mode and remote sending on does not hand a command
  back to the relay.
- **The host's steps** on a `remoteCommand` frame, in `remoteHost.ts`:
  1. Ignore it unless `hostMode` is on. A command id with a run of this page still going applies the frame's stop
     flag to that run, answers with its state, and starts nothing.
  2. Create the command's abort controller, before the first await. Read the body (the state becomes `delivered`).
     From here on, a stop flag (in the read's answer, a later frame, or a state acknowledgement) aborts the controller.
  3. Refuse, certifying no attempt: `stopped` when the controller is already aborted, `pluginsOff` when plugins are
     off for this page load (`safeBootOff`, checked before any wait), `chatMissing` when the character or chat is not
     listed, `busy` when the chat has a send of this tab (`isLocalSend`, not `isChatBusy`, which also counts a resumed
     follow). A command that the read marked `attempted` gets no certificate: the host reports `uncertain` where it
     would have refused as `stopped`, `pluginsOff`, or `chatMissing`, and `busy` is not checked for it. A stopped
     attempted command starts nothing: the host cannot tell whether its earlier attempt created a job, and stopping
     that job is the sender's generation cancel (slice 4), which does not pass through the host.
  4. Hold plugin work and await `pluginsStarted`, as `handoff.ts` does before a takeover. An abort during the wait
     ends the command as step 3 does: `stopped` when it was not attempted, `uncertain` when it was.
  5. Select the chat (D7): pin it, `selectChat`, `selectCharacter`, `setChatOpen(true)`, and close the settings and
     grid layers, so the chat screen under the lock renders it.
  6. Save the command id with its epoch in `sessionStorage`, report `running`, and call `sendChat` with the chat as
     `target`, the command's fields, the controller's `signal`, the local-only flag, the returned-reports option
     below, and `requestUncertain` true when the read said `attempted`. With an attempted command the send can still
     return at `runSend`'s own guards (a chat that is not listed, a send of this tab in the chat) before it reaches a
     create; that end is unsettled and is reported `uncertain`.
- **Reports come back instead of being shown.** A send's reports are shown today where they arise, and its end
  carries none of them. `runServerJob` alerts a refusal before or at admission (a binding problem, a refused or
  discarded write, a failed save or load, a busy chat, a refusal by the server). The job's follow shows the job's error
  (`reportEnd` calls `alertJobError`) and, on a `done`, one toast naming skipped hooks and missed listeners. A send
  gains an option that collects these into its end and shows none of them on this tab: a list of reports, each an
  `error` or a `notice` with the text that would have been shown (`alertJobError`'s formatting is extracted for it).
  `loreStopFollow` and `callerErrorCodes` already hand one report each to the caller in this way. Other callers are
  unchanged. The "stopped elsewhere" toast is collected as a notice (a third device can stop the job). A blocked flush
  is returned as an error even when the save layer has shown its own notice for it (`runServerJob` skips its alert
  then); that notice belongs to the save layer and stays on the host. These also stay on the host: a maintenance end
  with its restore watch and alert, what a follow raises outside its end (a handoff's attribution, a gone job's
  recovery), and any dialog that waits for an answer during the job (D9).
- **The result** is the send's end: `sendChat`'s boolean (`ok`), the refusal (`definite`, `ambiguous`, or none),
  `onEnd`'s `settled`, `outcome`, `requestUncertain`, `reconciled`, `blockedChats`, and `loreStop`, and the reports:
  the collected list, or a mark that the job's error was shown by another follow of this tab (set only when the job
  ended in an error that follow reports, never for a stop or a `done`). A lore stop, a user's stop, and a `done` are
  not errors, as `reportEnd` treats them today; a `done` can carry notices. A settled end is reported as `done`; an
  unsettled one, and a throw, as `uncertain`. Both states carry the result, so the reports of an unsettled end (a
  refusal before the create of an attempted command, a create without an answer, a lost follow) reach the sender too.
  The host shows neither the lore dialog nor the reports: the sender does. A state report that fails is retried while
  the command is kept; the saved id is removed once it is accepted.
- **After a reload**, the host reports `uncertain` for each saved id of the same epoch and removes it. Its saved jobs
  resume as any tab's do. A later re-post of that command runs the steps again with `requestUncertain`. When the earlier
  create was admitted, the new one is an owned replay that joins the resumed follow, with no second job and no second
  user message; when it was not, it is the first create. A joined follow reports as a boot resume does: its dialogs
  and toasts are the host's, and the end carries no `loreStop` and no reports, only the "shown by another follow" mark
  when the job ended in an error. The sender then says only that the send failed on the host. This limit is accepted:
  it needs a host reload during a job, which the `page` reload already asks about.
- **A job of another creator.** The host's create can find the request already admitted by another client: a command
  moved to a second host, or the sender's own earlier local attempt. While that job runs, the send is refused as busy
  and unsettled, with its report. Once it has ended, the replay returns no terminal, so the result has no report and
  the sender relies on its chat read. Accepted: it needs two creators of one request.
- **The host's composer and drafts are not involved**: no journal row, no input box, no slash command parsing, no Draft
  hook. Those ran, or did not, on the sending device.
- Tests: a send command reaches `sendChat` with the same ids, the chat as `target`, the lore flag, and the local-only
  flag; each refusal code; an attempted command is reported `uncertain` where an unattempted one is refused, and is
  not checked for `busy`; a second frame for a running command starts nothing; an attempted command is sent with
  `requestUncertain`; a settled and an unsettled end map to `done` and `uncertain`; a job error, an admission refusal's
  text, and a `done`'s hook notice are each in the result and are not shown; a stop flag aborts the run from a frame,
  from the read's answer, and during the startup wait; a stopped attempted command with no run on this page starts
  nothing and is reported `uncertain`; a saved id is reported `uncertain` at boot.

## Slice 4. The sending device's adapter (_hard_, `chat-pipeline.md`, `draft-recovery.md`, `network-jobs.md`)

New files: `src/ts/network/remoteSend.ts` with its test. Existing: `src/ts/process/index.svelte.ts`,
`src/ts/process/serverCommands.ts`, `handoff.ts`, `eventFeed.ts`.

- **The branch is in `runSend`**, below the screen, so every duty of a send stays where it is: `sendMain`'s checks,
  the Draft hook, the ids from `createSendDrafts`, the journal hand-off, clearing the composer, `sendChatMain`'s abort
  signal, its callbacks, and its `finally`. `runSend` has taken `beginLocalSend` before the branch; the remote send and
  a fallback both run under that one reservation.
- **Eligible** is a send with `input`, `userMessageId`, and `requestId`, in a tab that is not in host mode, without the
  local-only flag, and with none of these set: `continue` (the screen passes it as `false`, so its value is tested),
  `continueMessageId`, `rerollMessageId`, `speakerChaId`, `preview`, `previewPrompt`, `pluginContext`. An eligible send
  takes the remote path whenever remote sending is on, whether or not the chosen host is connected. The screen's Send
  and Send Draft are eligible; the multi-sends, the plugin API's send, auto mode, and an empty send carry no input and
  ids and stay local.
- **Before posting**, the adapter does what `runServerJob` does before a create, through a helper extracted from it:
  pin the chat, flush this tab's pending writes, refuse the send when a write was discarded or refused, and refresh a
  stale chat. The host's flush saves the host's writes, not these.
- **The command id** is the send's `requestId`. A retry of the same action re-posts the same command, to the host it
  first went to while that host is connected. Every post carries `uncertain` when the send is marked
  `requestUncertain`.
- **What the adapter answers**, in the shapes `runSend` already passes to `onServerRefused` and `onEnd`:
  - **Definitely not run:** no connected host of the chosen name, a 404 `targetUnavailable`, `expired`, or `refused`
    (the host's certificate). For a send that `requestUncertain` already marked, an earlier attempt may still run, so
    these keep that uncertainty and the fallback does not run. Otherwise: with the fallback on, `sendChatOnServer`
    runs here with the same ids; with it off, the send is refused as definite and a toast says why, and the existing
    restore returns the text.
  - **`done`:** the host's result. Its notices are shown first, as one toast, whatever `ok` is. With `ok` true the
    result is then passed on. Otherwise the adapter first reads the chat, through the chat read under `recoverJobChat`
    (`readRecoveringChat`, exported for this: it needs the chat, not a job id), with the chat pinned, so the screen's
    landed check sees a user message the host's job appended; a read that fails or is not adopted makes the end
    unsettled and uncertain. Then: a present `loreStop` goes to the screen and nothing else is shown; each returned
    error is shown with `alertError`; the "shown by another follow" mark is shown as a line naming the host; a result
    with no report shows nothing. A failure is never inferred from `ok` being false or from a missing report. The
    result's `refusal`, `settled`, `requestUncertain`, and `blockedChats` are passed on as they are, so the screen
    restores an unlanded draft as it does after a local refusal. A refusal inside `done` never starts the fallback:
    the host reached its own send path, and what refused it there (a binding, a write, the server) is now on the
    sender's screen.
  - **Uncertain:** `uncertain`, `forgotten`, a status of `unknownCommand`, a post or status request without an answer,
    or the host gone from presence for 60 s before a closed state. Unsettled and `requestUncertain`: the draft keeps
    its ids unless its message landed, and the next Send re-posts the command, marked `uncertain`. The reports that
    came with an `uncertain` state are shown as those of a `done` are, each once for the command; showing one does not
    settle the send or start the fallback.
  - **`cancelled`** reaches the adapter only as the echo of its own Stop, which does not read it (below).
  - **Another epoch:** a 412 takes the tab's existing epoch-mismatch halt, as any request's does, and never the
    fallback.
- **Stop.** An abort before the post has left (during the adapter's own flush) sends no post: a send not marked
  uncertain is refused, as `runServerJob`'s preflight refuses one, and a marked send goes on to the resolution below.
  After the post, an abort starts two things at once, and neither waits for the other.
  - It posts the relay cancel, which keeps an unread command from leaving and tells a running host to abort.
  - It resolves the request id as a local send does after a Stop of an uncertain send: the adapter runs
    `sendChatOnServer` with the aborted signal and `requestUncertain` (true even for a first Send: the post made the
    request uncertain). That path creates nothing. It cancels the generation by its request id
    (`cancelGenerationRequest`: the server aborts a running job whoever created it, and for an unknown id leaves a
    tombstone that refuses a create arriving later), and it consumes the answer as `runServerJob` does today. The
    adapter takes the returned `settled` and `requestUncertain` as they are and never reads more into `outcome`. No
    job: a settled, definite refusal, and the next Send gets a new request id. A job that had ended, with the chat
    read adopted: settled. Anything unsettled (a job that acknowledged the abort and may still write, a chat read that
    failed, a cancel without an answer): the adapter goes on waiting for the host's closed state, as it would have
    without the Stop, and ends uncertain by the rules above if none comes. A job this device created itself (an
    earlier local attempt) is followed to its end, as a local Stop follows it.
  - The adapter does not branch on the relay's answer, and a stopped send never falls back. The host's notices are
    not shown for a send whose own signal was aborted, and a host result that arrives after the send has ended is
    ignored.
  - What is left exposed is what a local Stop leaves: when the generation cancel gets no answer and the post arrives
    late, the host may still run the command. The send has ended uncertain, not as a refusal.
  - The foreign-job Stop control appears once the send has ended.
- **Feed reconnect.** After a new `hello`, the adapter reads the status of each command it waits on.
- Tests: each answer above, with the fallback on and off; a marked send never falls back and posts `uncertain`; the
  pending writes are flushed before the post and a discarded write refuses the send; the reservation is held across
  the remote wait and the fallback; a failed `done` reads the chat, then shows each returned error; a `done` with `ok`
  true shows its notices; a definite refusal inside `done` restores the draft and does not fall back; `loreStop`
  reaches the caller; a lore stop and a user's stop show no error; the abort posts the relay cancel and cancels the
  request id whatever the relay answers (`cancelled`, `stopRequested`, a 404, none); a Stop with no job ends definite
  without a fallback; an unsettled Stop result waits for the host's closed state; a Stop during the flush posts
  nothing; a Send after a Stop that ended uncertain re-posts the id and the command runs again as `attempted`; the
  reports of an `uncertain` state are shown once and settle nothing; each ineligible send (host mode, the
  local-only flag, each excluded field, `continue: false` being eligible) calls `sendChatOnServer`; the command id
  equals the request id across a retry.

## Slice 5. The sending device's controls (`settings-i18n.md`, `ui-theming.md`, `chat-pipeline.md`)

Existing: `remoteSend.ts`, `RemoteHostControls.svelte`, `DefaultChatScreen.svelte`, the language files.

- **The preferences**, device-local, in `remoteSend.ts`: `remoteSend` (off by default), the host's name (names are a
  browser preference, can repeat, and the newest registration of a name is used, as `handoffTargets` does), and
  `remoteSendFallback` (D3).
- Settings → Display lists the connected hosts by name with their count, and holds the three controls.
- The composer shows that sends go through the named host, and whether it is connected. A toast says when a send went
  to the fallback, and when a send was refused with the fallback off.
- While a remote send runs, the chat shows the host's job as any foreign job, by the feed.
- Tests: the host list groups by name and ignores this tab; the composer marker follows the preference and presence.

## Slice 6. Remote plugin reload (`plugin-sandbox.md`, `network-jobs.md`, `app-shell.md`)

Existing: `shared/remoteCommands.ts` with the server validation, `remoteHost.ts`, `src/ts/plugins/plugins.svelte.ts`,
`src/ts/bootstrap.ts`, `RemoteHostControls.svelte`, `src/lib/Setting/Pages/PluginSettings.svelte`, the language files.

- **The command.** `{ type: "reload", mode: "plugins" | "page" }`. The host runs a reload command id once and answers a
  repeated frame with the state it has.
- **`plugins` mode.** `plugins.svelte.ts` exports a forced deferred reload that returns a promise. The waiters a load
  satisfies are captured when that load starts and resolved after its `applyPluginLoad`, with `applied` or, before the
  chain swallows the rejection, `failed`; a local load that supersedes the deferred one takes its waiters; a request
  made after a load began waits for the next one. It answers `pluginsOff` at once under safe boot. The idle wait and
  the coalescing stay, and the host holds no plugin work while it waits. The host reports `running` while it waits and
  `done` with that outcome. Completion is never read from `requestDeferredReload` returning or from `pluginsStarted`.
- **`page` mode.** The host saves the command id with its epoch in `sessionStorage`, reports `running`, flushes pending
  writes with a bound, and reloads the page. After the next boot's plugin load it reports `done` with `applied`,
  `failed` when that load failed (boot goes on after a failed load), or `pluginsOff` under safe boot, and removes the
  saved id once the report is accepted; it does not wait for resumed jobs. It does not wait for idle either: this mode
  exists for a hook that never settles. The requester confirms first when the host has a running job, since a callback
  in flight there is lost and its job can fail.
- **The control** is a "Reload plugins" button with the two modes in the row of each connected host (Settings →
  Display), and in Settings → Plugins when a host is connected.
- The help text states the limit: a plugin setting kept in `safeLocalStorage` belongs to each browser and is not
  changed on the host by a change made elsewhere.
- Tests: the exported reload applies an unchanged signature once, waits for idle, and resolves only after the load; a
  superseding local load resolves it; a failed load resolves `failed`; safe boot answers `pluginsOff`; `page` mode
  reports `done` after the next boot and once.

## Slice 7. Continue and reroll through the host (_hard_, `chat-pipeline.md`)

Existing: `shared/remoteCommands.ts` with the server validation, `remoteHost.ts`, `remoteSend.ts`,
`DefaultChatScreen.svelte`, `rerollHistory.ts`.

- The command gains `continue`, `continueMessageId`, `rerollMessageId`, and `speakerChaId`, and slice 4's eligibility
  takes those sends.
- A continue names its target message before the remote wait (the server otherwise continues the last message), and
  the slice decides how a remote continue is retried: the screen keeps no uncertain request id for a continue today.
- A removal reroll removes replies on the sending device first; slice 4's flush sends that removal before the post.
  The reroll history needs the chat's tail at the send's end, so the adapter reads the chat before answering every
  reroll, not only a failed one, and nothing is restored while the end is unsettled.
- If the history cannot be kept this way, the slice records why and leaves reroll local.

## Decisions

- **D1. The host sends; the job is not handed over.** (Owner, 2026-11-15.) The host is the creator and the owner from
  admission, so the path is the one that works when the tab stays open. No handoff is asked for: the host's creates
  carry no `handoff: "prefer"`. The absent-owner offer stays as it is for every job. It counts from admission, before
  the owner's first attach, so when another device accepts handoffs, that device may take the job if the host goes
  away, and also if the host's create answer or first attach takes more than 10 s. How often the second happens on the
  owner's network is a manual check. Rejected: the phone creating the job with the host named as its first owner (it
  keeps the phone's token stream, which the owner does not need, and it runs on the worker follow whose device checks
  are still unrun); a server-enforced "never hand over" flag for host jobs (a second protocol change, and it would
  remove the only recovery when the host dies).
- **D2. The sending device is an observer.** (Owner, 2026-11-15: an update every few seconds is enough.) It attaches no
  job socket to a host's job. A quiet (Half Streaming) reply therefore appears only when it ends. The one job it
  follows is one it created itself in an earlier local attempt of the same request, when a Stop finds it (slice 4).
- **D3. The fallback is an option, and only for a definite failure.** (Owner, 2026-11-15: keep it as an option.)
  Definite means one of: no host of that name is connected; the server never gave the command to the host (`expired`,
  `targetUnavailable`); the host refused and certified that it never attempted the command. A read of the body alone
  decides nothing. A send already marked uncertain never falls back, nor does a send the user stopped, nor one the
  host's own send path refused. The default is on: a send that runs with today's limits is better than one that does
  not run (this plan's choice).
- **D4. The server relays and stores nothing durable.** A restart loses open commands; the sender then reads
  `unknownCommand` and treats the send as uncertain. Rejected: a command body in a feed frame (the feed has no
  addressing, and a body would reach every tab); the server creating the job on the host's behalf (the hook list and
  the callbacks need the host's tab at admission anyway).
- **D5. Any authenticated client may command a host.** The server holds one user's data, and a client that can post a
  command can already create a job. The mode is off by default and device-local, so no tab becomes a host without its
  user.
- **D6. Host mode locks the screen but stays one click from leaving.** A lock that needs a reload to leave would
  strand a user at the PC. Dialogs stay visible above it.
- **D7. The host shows the chat it sends in.** A plugin hook that reads the message DOM finds it only in the shown
  chat ([Job owner presence](../structure/plugin-sandbox.md#job-owner-presence)), and a locked screen has no selection
  to protect. With sends in several chats, the last one is shown; an earlier job then has no message DOM, as a user's
  has after switching chats.
- **D8. A host applies no `tts` and no `notification` notice.** Speech and a sound on an unattended PC serve nobody.
  The completion Web Push is unchanged: it reaches every subscribed browser, the phone and the host's included.
- **D9. No automatic answers.** A job's questions and callbacks keep their deadlines. A plugin permission prompt and an
  error dialog on the host stay until a person answers them, and a job that timed out can leave such a dialog and its
  plugin work behind, which keeps a `plugins` reload waiting. The lock screen lists what is waiting, and the `page`
  reload is the way out.
- **D10. Reload targets are hosts only.** A host's screen is locked, so a reload interrupts nobody's typing. It still
  has pending writes, job follows, and callbacks: the `page` mode flushes with a bound and asks first when a job runs.

## Not In This Plan

- Answering the host's dialogs from the sending device, or default answers per dialog kind.
- A "never hand over" policy for host jobs (D1).
- A wake lock or other measures against a hidden tab's throttling. The lock screen's help text recommends a window of
  its own.
- A headless host started by the server (the Job Handoff plan's Later).
- Remote slash commands, previews, command sequences, and settings changes.
- Reloading automatically when a plugin's arguments change on another device.
- The token stream on the sending device (D2).
- A push policy for the host's own browser.

## Manual Checks

Agents cannot run these; they go to [manual checks](../backlog/manual-checks.md) when the plan is archived.

- A phone sends through a PC host and its screen turns off at once: the reply and the plugin's illustration are there
  on return.
- The same with the PC host's window hidden for more than five minutes.
- The host is closed: the phone's send goes to the fallback, and with the fallback off the text returns.
- Stop from the phone, before and after the host started the send, and a Send again right after each.
- "Reload plugins" and "Reload page" from the phone, after changing a plugin argument on the phone.
- The illustration plugin's own "auto generate" switch: which device's value the host uses.
- With handoffs accepted on a second device, how often that device takes a host's job before the host attaches.
