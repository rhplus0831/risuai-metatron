# Completion Notification After Plugin Work Plan

Status: drafted 2026-11-16 at `721e6ead1` from the owner's questions of the same day (a phone should get the completion
notification of a remote-host send only after the host's plugins have finished what the reply started). D1 and D2 are
the owner's choices of 2026-11-16; D3 on are this plan's own and open to the owner's change. Not yet audited against the
code ([plan-runner audits](../reports/audits/plan-runner/README.md)). No slice has landed.

Sources: `notifyCompletion`, `runChatOutputListeners`, and `tailCallback` in `server/src/prompt/runner.ts`;
`GenerationRunnerDeps` in `server/src/jobs/runSetup.ts`; `finishCommand` in `server/src/jobs/commandRunner.ts`;
`parseCreateBody` and the `/api/generations/cancel` route in `server/src/routes/generations.ts`; `RunningJob`,
`requestFingerprint`, `lookupRequest`, and `RequestIdentity` in `server/src/jobs/generationJobs.ts`;
`GenerationContext` in `shared/jobs.ts`; `PushService` (`send`, `close`, `drain`) in `server/src/push/pushService.ts`;
`beginShutdown` in `server/src/app.ts`; `CALLBACK_TIMEOUT_MS` in `server/src/jobs/channel.ts`; the send run of
`receiveHostCommand`, `queueReport`, `loadTransport`, and `relayRequest` in `src/ts/network/remoteHost.ts`;
`ServerSendArg` and `sendChatOnServer` in `src/ts/process/serverGeneration.ts`; `cancelGenerationRequest` in
`src/ts/network/generationJobs.ts`; the `notification` notice in `src/ts/network/jobChannel.ts`; `RisuPlugin` in
`shared/plugins.ts`; `importPlugin`, `updatePlugin`, and `loadSignature` in `src/ts/plugins/plugins.svelte.ts`;
`upsertPlugin` in `src/ts/storage/collectionStore.svelte.ts`; `trackHostHook`, `pluginWorkIdle`, `onPluginWorkChange`,
`executePluginV3`, and `getV3PluginInstance` in `src/ts/plugins/apiV3/v3.svelte.ts`; `SandboxHost.isIdle` and
`onActivityChanged` in `src/ts/plugins/apiV3/factory.ts`; `SECTION_FIELDS` in `shared/sections.ts`;
`CONTEXT_METER_FIXED_WARN` in `shared/database.ts` and its clamp in `server/src/data/normalize/ui.ts`;
`src/lib/Setting/Pages/PluginSettings.svelte`; `src/ts/setting/displaySettingsData.svelte.ts`. The identifiers are the
anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A phone sends through a remote host, the notification arrives, and the reply the phone then opens is complete: the
plugins the owner named have finished the work the reply started on the host (an image generated and written into the
message, for example).

- **Only the notification waits (D1).** The sender's send ends when the reply ends, as today. The Web Push is held
  until the host says its plugins are quiet, or until a time limit.
- **Per plugin (D2).** Each plugin has its own switch (wait for this plugin, off by default) and its own quiet time
  (how long it must have nothing in flight). A plugin that is not switched on never delays a notification.
- **One time limit.** A synced setting bounds the whole wait. Past it the notification is sent whatever the plugins
  are doing.
- **Nothing changes without a switched-on plugin.** No hold is asked for, and the server sends at the reply's tail as
  today.

Not goals: a wait on any tab that is not a remote host; an API by which a plugin declares its own work; a change to the
relay contract or to when the sender's send ends; holding the tab's own `notification` notice.

## Current State

- **The server already waits for awaited hooks.** A reply's tail runs `editoutput`, the output trigger, inlays, and the
  `chatOutput` listeners (a callback the owner tab answers when every listener's promise has settled) before
  `notifyCompletion`, which sends the tab's `notification` notice and the Web Push (`deps.push?.send`, not awaited)
  when `db.notification` is on. A callback has `CALLBACK_TIMEOUT_MS` (60 s); past it the job ends with an error.
- **Work a plugin starts and does not await is invisible.** Asset Maid 0.9.90.1 (`//@api 3.0`, read from the owner's
  copy) registers a `chatOutput` listener that awaits its preparation and then starts the automatic illustration
  generation without awaiting it (`Jt(...).catch(...)` in a comma expression that returns `true`). The callback is
  answered at once, the push goes out, and the plugin then runs its analysis request, the image request, the asset
  save, and `setChatToIndex`, which rewrites the message. Between its automatic retries it waits on a timer inside the
  guest (100 ms, or up to 30 s and more after a 429/503 of the flex tier).
- **The host ends its part when `sendChat` returns.** The send run reports `done` (or `uncertain`) to the relay, which
  closes the command and ends the sender's wait. In host mode the tab skips the `notification` notice, so other devices
  learn of the completion from the Web Push alone.
- **`notifyCompletion` can run more than once per job**: once per speaker of a group send, and once per part of a
  command sequence (`finishCommand` runs `runPromptSend` per part with the job's id). Auto-continue and resend rounds
  notify on the last round only. A preview never notifies.
- **The runner sees no request id.** `RunningJob` carries `id`, `kind`, `context`, and `epoch`. The registry maps a
  request id to its job (`lookupRequest`: the live jobs, ended ones in their grace, kept outcomes, receipts). The host
  knows the command's request id and never learns the job id (`ServerSendResult` has neither).
- **Plugin activity is counted per sandbox, reported without a name.** `SandboxHost.isIdle` is false while a
  guest-to-host call's promise is pending (`runLLMModel`, `nativeFetch`, `saveAsset`), while a host-to-guest callback
  awaits its answer, and while a bridged stream is open. A synchronous host call (`setChatToIndex`) counts only while
  it runs. The host tells its one activity listener on settlements, not when work begins; `executePluginV3` wires
  every host to `notifyPluginWork`, which names no plugin. `runningHostHooks` is one counter for all plugins; both
  places that raise it have the plugin's name in scope.
- **A plugin entry keeps unknown fields, except across an update.** The `plugins` record is validated as an array of
  plain objects on the server and by name on the client, so an extra JSON field survives saves, boot, backups, and the
  upstream round trip. `importPlugin` builds a fresh entry and `upsertPlugin` replaces the same-name entry whole, so an
  update, a re-import, or a hot reload drops every field `importPlugin` does not set. `loadSignature` is
  `[name, script, allowedIPC]`: a change to another field reloads nothing. A conflicting save of `plugins` is settled
  for the whole record.
- **Push delivery ends at shutdown.** `beginShutdown` calls `push.close()`; a queued send checks that flag and is
  dropped. The push queue holds four pending sends.

## Rules For Every Slice

- A job whose create body has no `completionHoldMs` behaves exactly as today, byte for byte in what it sends and when.
- The server never holds a notification without a deadline, and a held notification is sent at most once.
- The relay contract (`shared/remoteCommands.ts`), `src/ts/network/remoteSend.ts`, and the moment the host reports
  `done` do not change. The sender never passes `completionHoldMs`; only a host adds it to its own send.
- The wait after a send holds no chat pin, no plugin-work hold, and no local-send reservation: the host takes its next
  command as today.
- A plugin's two new fields are read through one shared helper that defaults and clamps them. No reader trusts the
  stored value.
- V1 to V9 apply. Each slice updates the guides it names and the path ownership of its new files
  (`pnpm docs:owner <path>`, `pnpm check:docs`). Full checks: `pnpm check`, `pnpm check:docs`, `pnpm format:check`,
  `pnpm --silent test:agent`, and the specs `pnpm --silent test:agent --e2e` selects for the diff.
- Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_ slice.

## Order

1, 2, 3, 4 in that order. 3 uses the route of 1 and the helpers of 2; 4 edits the fields 2 declares. 1 and 2 share no
file and may run in either order. Shared guides: `network-jobs.md` (1, 3) and `plugin-sandbox.md` (2, 4).

## Slice 1. The server holds a completion (_hard_, `server-generation.md`, `self-host-server.md`, `network-jobs.md`)

New files: `server/src/push/completionHolds.ts` with `server/src/tests/completionHolds.test.ts`. Existing:
`shared/jobs.ts`, `server/src/routes/generations.ts`, `server/src/jobs/generationJobs.ts`,
`server/src/jobs/runSetup.ts`, `server/src/prompt/runner.ts`, `server/src/app.ts`.

- **The field.** `GenerationContext.completionHoldMs?: number` and `MAX_COMPLETION_HOLD_MS` (630 000: the largest time
  limit of slice 2 plus the margin of slice 3) in `shared/jobs.ts`. `parseCreateBody` refuses a present value that is
  not a finite number above zero (400) and keeps `Math.min(Math.floor(value), MAX_COMPLETION_HOLD_MS)`. It is kept for
  any kind, as `stopOverLoreBudget` is, and is not in `requestFingerprint`: a retry under the same request id replays
  the first attempt with its first value. A command sequence's part keeps it (the part view drops named fields only).
- **The holds** (`createCompletionHolds({ push, timers })`, process memory):
  - `hold(jobId, notification, holdMs)` keeps the job's notification and starts its deadline. A second hold for the
    job replaces the notification and restarts the deadline (a group's later speaker, a sequence's later part).
  - `release(jobId)` sends the held notification with `{ jobId }` and answers whether one was held.
  - The deadline sends it the same way.
  - Past `MAX_COMPLETION_HOLDS` (64) held jobs, the oldest is sent at once.
  - `close()` clears every timer and drops what is held. `beginShutdown` calls it before `push.close()`.
- **The runner.** `GenerationRunnerDeps.completionHolds?: Pick<CompletionHolds, "hold">`. In `notifyCompletion` the
  notice is unchanged; the push goes to `hold` when the job's context has `completionHoldMs` and the holds exist, else
  to `push.send` as today.
- **The release.** `POST /api/generations/completion-release`, body `{ requestId }`, with the JWT, the limiter, and
  the resource epoch header of `/api/generations/cancel`. The registry gains a narrow `requestJobId(requestId)` over
  `lookupRequest` (null for an unknown request or a cancellation mark). The route answers `{ released: boolean }`:
  false when no job is known or nothing is held. Any authenticated client may call it (D9). A release before the job
  ended is allowed; a notification held after it waits for a later release or its deadline.
- Tests: the body table of `generations.test.ts` (a string, zero, a negative, and a non-finite value are refused; a
  value above the maximum is clamped) and the new route (JWT, epoch, unknown request, nothing held);
  `completionHolds.test.ts` under fake timers (release sends once and stops the deadline; the deadline sends once; a
  second hold replaces and restarts; the bound; `close` sends nothing); `promptTail.test.ts` with the fake
  `PushTransport` (with the field nothing is delivered at the tail, the release delivers it, and the notice is still
  sent at the tail; without the field the existing assertions hold); a group send holds the last speaker's
  notification only.

## Slice 2. Stored settings and the per-plugin quiet wait (`plugin-sandbox.md`, `persistence.md`)

New files: `src/ts/plugins/pluginQuiet.ts` with `src/ts/plugins/pluginQuiet.test.ts`. Existing: `shared/plugins.ts`,
`shared/database.ts`, `shared/sections.ts`, `server/src/data/normalize/ui.ts`, `src/ts/plugins/plugins.svelte.ts`,
`src/ts/plugins/apiV3/v3.svelte.ts`, the boot snapshot fixture.

- **Per-plugin fields.** `RisuPlugin.completionWait?: boolean` and `completionQuietSeconds?: number`, with
  `PLUGIN_COMPLETION_QUIET_SECONDS = { min: 1, max: 60, default: 3 }` and `pluginCompletionQuietMs(plugin)` in
  `shared/plugins.ts`: null unless `completionWait === true`, else the seconds defaulted, floored, and clamped, in
  milliseconds. No server normalization is added (the record keeps the fields as they are).
- **An update keeps them.** `importPlugin` copies the two fields from the same-name entry it replaces into the new
  entry. Nothing else of the old entry is carried over (its present behavior for `enabled` and `realArg` stays).
- **The time limit.** `Database.completionWaitMaxSeconds: number` with
  `COMPLETION_WAIT_MAX_SECONDS = { min: 10, max: 600, default: 180 }` in `shared/database.ts`, owned by
  `SECTION_FIELDS.ui`, with a `["number", default]` spec and a clamp in `normalizeUi` as `contextMeterFixedWarn` has,
  and the default in the boot snapshot fixture.
- **Activity by plugin** (`v3.svelte.ts`): the host-hook counter is kept per plugin name beside the total
  (`pluginWorkIdle` reads the total as today); `pluginBusy(name)` is true while the named instance's sandbox is not
  idle or its host-hook count is above zero, and false for a plugin with no instance; `onPluginActivity(listener)`
  calls the listener with the plugin's name on each of its sandbox's activity reports, on each settled host hook of
  that plugin, and on its unload. `notifyPluginWork` still runs on all of them.
- **The wait** (`waitForPluginsQuiet(targets, { capMs, signal, busy, onActivity, timers, now })` in `pluginQuiet.ts`,
  its plugin functions injected): each target `{ name, quietMs }` gets a clock that starts when the wait starts and
  restarts on each activity report of its plugin. The wait resolves `"quiet"` at the first moment every target is not
  busy and its clock has run `quietMs`; `"cap"` when `capMs` passes first; `"aborted"` on the signal. A busy plugin is
  looked at again on its next activity report (a settlement is always reported), so no polling timer runs while work is
  in flight. An empty target list resolves `"quiet"` at once.
- Tests: `pluginCompletionQuietMs` (off, missing seconds, out-of-range, non-number); `plugins.test.ts` (an update
  keeps the two fields and still resets the others); `normalizeSections.test.ts` (default, both clamps, idempotence);
  `pluginDeferredReload.test.ts` (a change to either field reloads nothing); `pluginWorkIdle.test.ts` (`pluginBusy`
  follows one plugin's host hook and sandbox, not another's; `onPluginActivity` names the plugin; the total still
  drives `pluginWorkIdle`); `pluginQuiet.test.ts` under fake timers (quiet after the quiet time; an activity report
  restarts one plugin's clock only; busy at the clock's end waits for the next report; the cap; the signal; two targets
  with different quiet times).

## Slice 3. The host asks for the hold and releases it (_hard_, `network-jobs.md`)

Existing: `src/ts/process/serverGeneration.ts`, `src/ts/network/generationJobs.ts`, `src/ts/network/remoteHost.ts`
with its test.

- **The send option.** `ServerSendArg.completionHoldMs?: number`; `sendChatOnServer` copies a value above zero into
  the job context. `remoteSend.ts` does not carry it.
- **The transport.** `releaseCompletionHold(requestId)` in `generationJobs.ts`, beside `cancelGenerationRequest`: one
  POST with the epoch header and the module's own deadline, retried twice on a transport failure, never throwing. A
  release that never arrives is covered by the server's deadline.
- **Before the send** (the host's send run, after the plugins' startup): the targets are the enabled `3.0` entries of
  `settings.plugins` whose `pluginCompletionQuietMs` is not null and that have a running instance. With at least one
  target and `settings.ui.notification` on, the run passes `completionHoldMs` (the clamped
  `completionWaitMaxSeconds` in milliseconds plus `COMPLETION_HOLD_MARGIN_MS`, 30 000) to `sendChat`. Otherwise it
  passes nothing and the rest of this slice does not run.
- **After the send.** The run reports `done` or `uncertain` and releases its holds exactly as today. Then, detached
  from the run:
  - the send returned true: `waitForPluginsQuiet(targets, { capMs })`, then the release, whether the wait ended quiet
    or at the cap;
  - the send returned false and settled: the release at once (a notification the job did send is not delayed);
  - the send did not settle: no release (the job may still be running; the server's deadline sends).
- An epoch halt abandons the wait without a release. Turning host mode off, a later command, and a plugin reload do not
  stop it: an unloaded plugin reads as not busy. The module keeps the pending waits in a set its tests can await.
- Tests (`remoteHost.test.ts`): no target, or notifications off, passes no hold and calls no release; a target passes
  the hold with the margin; the `done` report is queued before the wait resolves and the run's `finally` does not wait
  for it; true then quiet releases; true then cap releases; false and settled releases without waiting; unsettled
  releases nothing; an epoch halt releases nothing. `serverGeneration` coverage: the option reaches the create context.

## Slice 4. Settings (`plugin-sandbox.md`, `settings-i18n.md`)

Existing: `src/lib/Setting/Pages/PluginSettings.svelte` and its tests, `src/ts/setting/displaySettingsData.svelte.ts`,
`src/lang/en.ts`, `src/lang/ko.ts`.

- **Each `3.0` plugin's row** gets a `CheckInput` (wait for this plugin before the completion notification of a
  remote-host send) and, while it is on, a `NumberInput` for the quiet time in seconds with the bounds of
  `PLUGIN_COMPLETION_QUIET_SECONDS`. Both write `settings.plugins[i]` directly, as the enable button does. A help line
  says the wait applies on a device in Remote Host Mode and names the time limit.
- **The time limit** is a declarative numeric item bound to `completionWaitMaxSeconds` in Display → Sound &
  notifications → Notifications, after the notification switch, with the bounds of `COMPLETION_WAIT_MAX_SECONDS`.
- Strings in English and Korean under the existing plugin and notification groups.
- Tests: the row's controls write the two fields and hide the seconds while off (`PluginSettings` tests);
  `settingsPageSections.test.ts` (the item's binding, bounds, strings, and placement); `searchIndex.test.ts` finds it.

## Decisions

- **D1. Only the notification waits.** (Owner, 2026-11-16.) The flow is "get the notification, then open the finished
  output on the phone". The sender's send ends at the reply's end, so its composer is free while the plugin works.
- **D2. Per plugin: whether to wait, and for how long.** (Owner, 2026-11-16.) Off by default.
- **D3. One synced time limit for the whole wait**, 180 s by default, 10 to 600. Per-plugin limits would let one
  plugin's limit hide behind another's; one number is what the owner reasons about ("at worst this late").
- **D4. A hold on the job, not a relay state.** The host asks with a create-body field and releases by request id.
  Rejected: a "settled" state after `done` in the relay (a contract version, a sender that must ignore it, and an
  older host or sender on the other side). The relay's `done` already ends the sender's send, which D1 keeps.
- **D5. The server's deadline is the backstop**, counted from the last held notification: the time limit plus 30 s.
  A host that reloads, loses its epoch, or dies mid-wait still yields a notification. The job's tail after the
  notification (emotion mode, an image view, the final write) can eat into the margin, so a slow tail may send a few
  seconds before the host's own cap.
- **D6. Host mode only.** A host is the tab meant to stay up. Another tab's own send keeps today's timing.
- **D7. The quiet clocks start when the send ends.** Every held notification is therefore late by at least the longest
  quiet time of the switched-on plugins, even when they did nothing. Rejected: always-on activity clocks (bookkeeping
  on every plugin call for every tab).
- **D8. A held notification does not survive the process.** Shutdown drops it, as it drops a queued push today.
- **D9. The release has no creator check**, as `/api/generations/cancel` and `/stop` have none: the server has one
  user, and the worst a stray release does is send a notification early.
- **D10. An update keeps the two fields.** The plugin in question updates from a URL; a switch that turned itself off
  at each update would read as a broken feature.
- **D11. The time limit is shown with the notification switch**, not on Device Link: it is a synced setting about when
  the notification is sent, and Device Link holds this device's own preferences.

## Not In This Plan

- **An exact signal from the plugin** (a `waitUntil`-style API, or a `chatOutput` listener allowed to run past 60 s).
  The quiet time is an estimate: a plugin waiting on its own timer with nothing in flight reads as quiet. Asset Maid's
  flex-tier retry wait (up to 30 s and more) outlasts any sensible quiet time, and the notification then precedes the
  retry.
- **Activity that is not the reply's.** A switched-on plugin busy with another chat's send delays this notification
  until it is quiet or the time limit passes.
- **A wait for a tab that is not a host**, and holding the tab's own `notification` notice.
- **Diagnostics of a hold** (a push event phase for held, released, or sent at the deadline) and a line on the lock
  screen while a wait runs.
- **Sending held notifications at shutdown.**
- **A plugin header that sets the defaults** of the two fields at install.
- **A browser check.** The Playwright stack has no push transport to observe; the server and host tests carry the
  order, and the real delivery is a manual check.

## Manual Checks

For the owner, on real devices, after slice 4:

1. Host with Asset Maid switched on (quiet time 3 s): send from the phone with automatic illustration on. The
   notification arrives after the image is in the message, and opening it shows the image.
2. The same send with the plugin's switch off: the notification arrives at the reply's end, as before.
3. Time limit at 10 s with a generation that takes longer: the notification arrives about 10 s after the reply ends.
4. Stop the headless host right after the reply ends: the notification still arrives, at the server's deadline.
5. Update Asset Maid from its update URL: the switch and the quiet time are unchanged.
6. Change the switch on the phone: the host follows on its next send without a plugin reload.
