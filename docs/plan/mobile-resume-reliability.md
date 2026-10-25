# Mobile Resume Reliability Plan

Status: in progress. Landed: 1 (7b01303e3), 2 (d7b3a7a34).

- 2026-10-26: first draft.
- Same day: a read-only GPT-6-Astra review. Its confirmed findings are folded in
  below.
- After discussing the review, the user set aside the edge cases that are also hard
  to fix (see **Set aside**). The user rarely uses features that need the browser to
  answer during a reply.
- Then, on the user's suggestion to detect a missing reply by comparing messages,
  slice 2 was changed to keep job outcomes on the server (see slice 2 for why a
  message comparison is not used).

Sources: the code at `ab57e53f2` (anchors below are from that commit; re-verify
before editing) and the user's report from daily use of the app as an installed PWA
on Android.

Owning guides:

- [global-api](../structure/global-api.md): Web Push, `pushNotifications.ts`, the
  job channel, new network helpers.
- [persistence](../structure/persistence.md): `eventFeed.ts`, idle chat refresh.
- [chat-pipeline](../structure/chat-pipeline.md): the `serverCommands.ts` job follow.
- [build-test-platforms](../structure/build-test-platforms.md): `public/sw.js`.
- [self-host-server](../structure/self-host-server.md): `server/src/push/`, job
  retention.
- [diagnostics](../structure/diagnostics.md): events, collector, report.

## Goal

The user runs the app as an Android PWA and reports three problems:

1. After sending a message and leaving the screen, the completion push sometimes
   never shows. On return the reply is already there.
2. On return, an alert appears (described as "the chat data is old" or similar;
   most likely `serverJob.lost`, possibly `resourceReloaded`). After dismissing it
   the chat sometimes updates. When it does not, the chat updates only after opening
   another chat and coming back.
3. On a phone there is no practical way to see why.

This plan fixes the defects the code shows without device evidence, makes a lost
job follow recover by itself, and adds the diagnostics needed to confirm the causes
on the device.

## Original code (baseline)

### Push delivery and display

- `server/src/prompt/runner.ts:766` `notifyCompletion` sends the tab's notice and
  `deps.push?.send(notification)`.
  - It is called at `:1880`, with `db.notification` on, on the reply path, past the resend
    branch (which returns early with `finalize()`).
  - It runs before the awaited emotion and image work and before the final
    generation-info write (`:1899`, `:1949`). A later failure can therefore end the
    job with an error after the push was sent.
  - A failure before that point, and a resend (`willResend`), send no push.
- `server/src/push/pushService.ts:375` `deliver` sends to every subscription with:
  - `TTL: 3600`;
  - `urgency: "normal"` (`:396`);
  - `topic: "chat-completion"`, the same for every chat, while the payload tag is
    per chat (`shared/notifications.ts:117` `completionNotificationTag`).
- A failure is `console.warn` plus `failureCount`/`lastError` in
  `save/server/push_subscriptions.json`; a 404/410 removes the subscription. Failed
  deliveries are not retried.
- `send` (`:467`) drops silently when closed, without keys, or at
  `MAX_PENDING_SENDS`. A send enqueued before shutdown can also be discarded.
- A successful `sendNotification` means the push service accepted the message, not
  that the phone showed it. Nothing reaches the diagnostics journal.
- `public/sw.js:324`: `push` → `showPush` → `showPushNow`.
  - `windowInFront()` (`:422`) is `client.focused` on any same-origin window client.
  - When it is true, the notification is shown `silent` and then closed if the
    window is still "in front" (`:407`).
- The page skips its own notice when this browser is subscribed
  (`src/ts/network/pushNotifications.ts:460`), so a subscribed phone relies on the
  push alone.
- The page closes every completion notification whenever it becomes visible
  (`:433`, `:530`).

### Server job lifetime

- A dropped job socket does not abort the job: the socket's close handler only
  removes the socket.
- An ended job stays readable (status and reattach) for `JOB_DONE_GRACE_MS = 60_000`
  (`server/src/jobs/generationJobs.ts:51`), collected every 30 s. In practice it
  disappears 60–90 s after it ends.
- A running job is aborted after 30 min.
- The reply itself is persisted in the chat and outlives the job. The terminal event
  (`done`/`error`) does not.
- `GET /api/generations/:id` (`server/src/routes/generations.ts:259`) answers
  `status(job)` (`generationJobs.ts:1267`): `state`, the chat, `messageId`, and, for
  an ended job, its `terminal`. It answers only the job's own client (`ownJob`,
  matched by `clientId`). Once the job is collected, the answer is a 404, so the
  outcome is gone even though the server knew it.
- The `done` terminal carries `revision` (the chat revision the job left) and
  `messageId`. The `error` terminal carries `message`, `status`, `reason`, and the
  checked `stage`/`requestId`/`providerCode`. A preview's `done` can carry a large
  `result`, and a command job's `done` can carry `followUps` (up to 64 parts of
  100,000 characters).
- Reattaching to a running job sends a chat patch (`jobChatEvent(job, "patch")`,
  `:1281`). Only an ended job sends the chat whole. The client's mismatch → resync
  path (`src/ts/network/generationJobs.ts:699`) covers a patch that does not fit.
- Duplicate attaches are ordered by the attach stamp: the server supersedes older
  sockets and refuses older handshakes (`:1408`).

### Job follow after the socket drops

- `src/ts/process/serverCommands.ts:47-48`: `MAX_ATTACHES = 5`,
  `REATTACH_DELAY_MS = 1000`.
- `followOnce` (`:215`):
  - reattaches when the socket closes without a terminal event, with four 1 s
    sleeps between attaches; socket and HTTP waits come on top of those;
  - a failed status read continues to the next attach;
  - a status of `null` (404: the job is gone, for example expired) ends the loop at
    once with `"lost"`.
- `discover` and `loadJobChat` each have their own loop with the same budget.
- On `"lost"`, `followJobToEnd` records `jobLink lost`, calls `releaseGenerationJob`
  (→ `endServerJob`), alerts `serverJob.lost` (`reportEnd`, `:249`), and sets the
  chat's `recovery` mark (`noteJobLost`).
- Discovery at boot (`:104`) can record `lost` without the alert.
- Nothing follows the job again automatically. A later explicit send can find a
  still-running job through the busy-job path (`:438`).
- `endServerJob` (`src/ts/storage/chatStore.svelte.ts:1259`) marks a chat stale for
  the idle refresh only when the job still held message locks in it. A job lost
  before it locked anything, or after its locks were released, leaves no stale
  mark, so nothing reads the chat again.
- `refreshStaleChat(ref)` (`src/ts/storage/resourceSync.svelte.ts:2947`) reads one
  stale or noticed idle chat whole on demand.
- `recovery` (`src/ts/process/chatStatus.svelte.ts:44`, `:80`) is only a sidebar
  marker. Viewing the chat clears it without reading anything.

### Chat state after a lost follow

These are three independent states:

- **Owner generation locks** (this tab's job): they block the idle refresh;
  `endServerJob` releases them.
- **Feed locks** (`noteRemoteStreaming`): they come from the live-update feed and
  keep the reply locked (edit, delete, regenerate, Send) but do not block the idle
  refresh. A newer whole read drops them, and a feed `hello` replaces the whole set.
- **`recovery`**: presentation only.

`ensureChatLoaded()` and chat selection return an already loaded chat without
reading it (`chatStore.svelte.ts:2277`, `:5551`). Why opening another chat and
coming back makes the chat current is therefore **not explained by the code yet**
(see slice 2).

### Socket liveness

- The server pings both sockets every 15 s: the feed
  (`server/src/routes/events.ts:12`) and a job socket
  (`server/src/jobs/generationJobs.ts:55`, `:1321`).
- Both clients discard pings (`src/ts/network/eventFeed.ts:116`,
  `src/ts/network/generationJobs.ts:479`) and have no liveness timer or connect
  timeout.
- `eventFeed.ts` reconnects only on `close`.
  - Backoff: each wait is random between half and all of a base that doubles from
    1 s to 30 s, so 0.5–1 s at first and 15–30 s at the cap.
  - The backoff resets only after a reconciled `hello`.
  - There is no `visibilitychange`, `online`, or Page Lifecycle `resume` handling.
- `connect()` awaits authentication before it assigns `socket`, with no in-progress
  guard (`:121`). Several triggers can therefore build competing sockets.
- After a mobile freeze, a socket can stay half-open (`OPEN`, no frames) until TCP
  gives up, possibly minutes later. Until then there is no `hello`, no reconcile, and
  no fresh feed locks.
- A job socket can also stall in `CONNECTING`, and `readGenerationJob` has no
  deadline.

### Conflict notice

- `resourceSync.svelte.ts:3934` flushes saves when the page is hidden.
- A 409 may merge or keep work. `resourceReloaded` is shown only when work was
  discarded (`:2633`), and other discard paths show it too.
- It is a latched, nonmodal panel; dismissing it only clears the panel.

### Diagnostics today

- Browser kinds (`shared/diagnostics.ts:20`):
  - `page`: boot, visible, hidden, online, offline;
  - `feed`: connected, disconnected, connectFailed;
  - `jobLink`: attach, detach, attachFailed, reattach, lost, resume.
- The browser and server allowlists filter kinds separately (`:464`, `:527`).
- The report parser (`shared/diagnosticsReport.ts:239`, `:288`, `:370`) accepts
  fixed lines and only `server|browser` event origins, and must round-trip byte for
  byte. Each input list is cut before the chronological merge (`:244`).
- The collector keeps 300 events and mirrors them to `sessionStorage`. The service
  worker records nothing.
- No event says which alert the user actually saw.

## Causes addressed

| Id  | Symptom | Cause                                                                                                                                                                                                                                          | Status                                    | Slice |
| --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----- |
| H1  | 1       | The worker counts a focused but hidden window as in front: silent notification, then closed.                                                                                                                                                   | Code weakness; not yet seen on the device | 1     |
| H2  | 1       | `urgency: "normal"` lets Android defer delivery in Doze.                                                                                                                                                                                       | Hypothesis                                | 1     |
| H3  | 1       | One shared `topic`: a push service replaces chat A's undelivered completion with chat B's.                                                                                                                                                     | Code defect                               | 1     |
| H7  | 2       | Back after 60–90 s or more, the job has been collected: status 404 → `"lost"` and the error alert although the reply was saved, and the outcome (done or error) is gone with it. Nothing reads the chat again unless the job still held locks. | Code defect; likely the main cause        | 2     |
| H4  | 2       | The reattach budget is spent while the network is still waking up.                                                                                                                                                                             | Code weakness                             | 2     |
| H5  | 2       | Half-open feed and job sockets after a freeze are never detected; a job socket can stall in `CONNECTING`.                                                                                                                                      | Code defect                               | 3     |
| H6  | 2       | A feed retry backed off to 15–30 s still waits out its delay after the page comes back.                                                                                                                                                        | Code weakness                             | 3     |

## Design decisions

### Slice 1: push

- `windowInFront()` counts a window only when `client.focused` **and**
  `client.visibilityState === "visible"` are true on the same client. Both checks
  (before showing, and again before closing) use it.
- `urgency: "high"`. This is a hypothesis fix for delivery priority, not a delivery
  guarantee.
- `topic` per chat: the hash suffix of `completionNotificationTag` (no `:`), which
  must fit RFC 8030 (at most 32 URL-safe base64 characters). `web-push` rejects an
  invalid topic rather than fixing it, so a test pins the format.
- Every push still shows a notification (Safari's rule), and the serialized
  show/close order stays as it is.

### Slice 2: keep job outcomes, and recover from a lost follow

The draft's `whenActive()` gate (wait while hidden or offline) is dropped. Waiting
longer cannot beat job expiry, and it needed a cancellation contract across pins,
`following`, and send state.

The user suggested telling a finished reply from a missing one by comparing the
messages before and after the refresh. Counting messages misreports common cases:

- a reply that had already started streaming before the page went away;
- a reroll;
- a continue;
- a command job that adds no message.

All of these are successes with no new message. The server already knows the
outcome, so the plan keeps it instead of guessing:

- **Kept outcomes (server).** When the GC collects an ended job, it keeps a small
  outcome record in memory: id, `clientId`, `kind`, chat ids, `epoch`, `messageId`,
  and the terminal.
  - The terminal is trimmed before it is kept: a preview's `result` is dropped; an
    error `message` is cut to 4 KiB; `followUps` are kept only when their JSON is at
    most 64 KiB, otherwise dropped with a `followUpsDropped` flag.
  - Records are kept for 24 h, at most 500 (oldest first out), and cleared when the
    epoch changes.
  - `status()` answers a kept record as `state: "ended"` with its terminal, under the
    same `clientId` rule, so another client still gets a 404.
  - A socket attach to a kept record is refused as today. The client reads the
    status instead (below).
  - A server restart loses the records. That case falls back to "gone" below.
- **The outcome on the client.** `followOnce` reads the status after any close
  without a terminal, and before spending another attach. An `ended` status with a
  terminal is returned as that terminal, so `followJobToEnd` handles it exactly as a
  live end:
  - `done`: `noteJobDone` (the sidebar's new-reply marker, which needs the
    `messageId`). When the terminal's `revision` is newer than the chat revision this
    tab holds, the chat is marked stale and refreshed. Comparing revisions is the
    precise form of "did the chat change". No notice.
  - `error`: `alertJobError`, the same alert with debug info as when watching live.
  - `followUps` run as today. A dropped list is reported as the existing failure
    for an unsent `/multisend`.
- **Gone versus unreachable.** `followOnce` and `discover` tell apart a job the
  server does not know (404: no kept record, after a restart or 24 h) and a server
  that could not be reached.
  - A gone job: the chat is refreshed (below). After the refresh succeeded, a short
    toast (`alertToast`, nonmodal) shows `serverJob.endedAway`. Its text must not
    claim success, since the outcome is unknown: "The response job ended while this
    page was away; the chat was reloaded" ("페이지가 꺼져 있는 동안 응답 작업이 끝나
    채팅을 다시 불러왔습니다"). There is no `serverJob.lost` alert.
  - An unreachable server keeps `"lost"` and its alert.
- **Backoff.** Attaches wait 1, 2, 4, 8 s (5 attaches, about 15 s of sleeps) instead
  of 1 s each. `readGenerationJob` and each attach get a 10 s deadline (an aborted
  `fetch` and a socket that is not `OPEN` in time), so no single step stalls the
  loop.
- **Chat refresh on every lost or gone follow.** `followJobToEnd` marks the job's
  chat stale explicitly, whether or not the job still held locks. This is a new
  `chatStore` export beside `endServerJob`. It then awaits `refreshStaleChat(ref)`.
  - If the refresh does not take (offline, the chat has local work, or the page is
    hidden), it is retried once at the next `visibilitychange` to visible or
    `online`.
  - One listener pair per lost chat at most, removed after it fires or when the chat
    is read by any other path.
- The refresh goes through the existing idle-read rules: no local work, epoch fence,
  revision fence. It never discards local changes.
- **Acceptance** for a lost or gone follow: the reply text is shown, and its
  controls (edit, delete, regenerate, Send) are unlocked once the job has ended,
  without opening another chat.
- **The chat-switch workaround.** The code does not show why it works (see
  baseline). The slice first reproduces "lost follow → chat stays stale" in a unit
  test. If the explicit stale mark and refresh do not cover that case, the real
  cause goes to `docs/research/found-issues.md` and is reported to the user before
  the slice is called done.

### Slice 3: socket liveness and resume reconnect

- **One connection generation in `eventFeed.ts`.** A generation number covers
  authentication, socket construction, reconciliation, retry, and stop. Starting a
  new connection:
  - invalidates the old generation **before** closing its socket;
  - clears its retry timer;
  - makes every late result of the old generation (authentication, `hello`,
    reconcile, `close`) do nothing.
  - Only the current generation's reconciled `hello` resets `attempt` and sets
    `connectedSocket`.
- **Resume reconnect.** The feed abandons its socket, if any, and connects at once:
  - on `visibilitychange` to visible after the page was hidden for at least 30 s
    (two heartbeats);
  - on the Page Lifecycle `resume` event (`document`);
  - on `online` (`window`).

  Triggers that fire together are folded into one reconnect. The reconnect costs a
  `hello` plus one `listRevisions`. This replaces the draft's 3 s "wait for a frame"
  grace, which had no reliable basis.

- **Watchdog while visible.** Any frame (pings included) stamps the socket. A 15 s
  interval abandons a socket that has had no frame for 45 s. Stamps use a clock the
  tests control.
- **Connect timeout.** A socket that is not `OPEN` within 10 s is abandoned.
- **Abandoning** means: invalidate, `ws.close()`, record the event, reconnect. It
  never waits for `close`.
- **Job sockets** (`followGenerationJob`) get the same watchdog, connect timeout,
  and resume abandon. Abandoning follows the existing cancellation contract:
  - stop events and sends;
  - settle `closed` without a terminal;
  - remove only its own `currentFollows` entry;
  - run `endFollowRecovery`.

  It does **not** release the job or end its channel. `followOnce` then reattaches
  as usual, and the attach stamp keeps the server's ordering.

### Slice 4: diagnostics

All new events are content-free and go through the exact-key projection. Both the
browser and server allowlists, and the report builder and parser, are updated
together and checked with byte-for-byte round trips.

- **`push` kind (server).** Phases:
  - `accepted` (the push service took it);
  - `failed` (with `status` when there is one);
  - `removed` (404/410);
  - `dropped`, with a `reason` from closed | noKeys | queueFull | noSubscriptions |
    unreadable.

  Fields: `service` (fcm | apple | mozilla | windows | other, from the endpoint host,
  never the URL) and `jobId`. The job id is passed beside the notification, never in
  the payload. Recording goes through the existing safe-recorder convention, so a
  diagnostics failure never changes delivery.

- **`push` kind (worker).** Phases `received`, `shown`, `shownSilent`,
  `closedInFront`, `showFailed`, `clicked`. Fields:
  - `inFront`: the predicate's actual result;
  - `focusedHidden`: some window was focused but not visible, which is H1's exact
    condition.

  Storage rules:
  - The worker builds each record from fixed phases and booleans only. It never
    stores the payload, title, body, route, endpoint, or exception text.
  - The last 100 records live in IndexedDB `risu-sw-diagnostics`, with append and
    prune in one transaction.
  - A failed or blocked open, or a failed write, is skipped and never delays or
    blocks `showNotification`. The write is attached to the event's `waitUntil`
    after the notification is shown.

- **`push` kind (page).**
  - `browserState`, recorded at boot and on each visible: `permission`
    (granted | denied | default | unsupported, with unknown kept apart from false),
    `subscribed`, and `standalone` (`display-mode: standalone`). Recording these as
    events avoids new fixed report lines.
  - `dismissedByPage`, with the count closed, when the page closes completion
    notifications on becoming visible.
- **`notice` kind.** An event when one of these is actually shown: `serverJobLost`,
  `serverJobEndedAway`, `resourceReloaded`. This finally tells which alert the user
  saw.
- **New phases:**
  - `page`: `freeze`, `resume`;
  - `feed`: `stale`, `connectTimeout`, `resumeReconnect`;
  - `jobLink`: `stale`, `connectTimeout`, `kept` (the end came from a kept
    outcome), `gone`, `recovered` (the chat refresh after a lost or gone follow
    succeeded).

  Slices 2 and 3 add the phases their own behavior emits; slice 4 adds the `push` and
  `notice` kinds and the `page` phases.

- **Report.** `report.ts` reads the worker's records with a 1 s bound, projects them,
  and merges them into the browser list **before** that list is cut. A failed read
  is counted as omitted.

## Set aside

These are edge cases for this user's usage and also hard to fix. They stay out of
this plan; each needs its own design if it ever shows up in the diagnostics.

1. **Browser-dependent callbacks expire while the page is away.**
   - What happens: a job waiting on the browser (a Lua question, 120 s; a plugin,
     provider, or tab MCP callback, 60 s; `server/src/jobs/channel.ts:22`) times out
     with `timedOut`/`disconnected` while the phone is asleep.
   - Why set aside: the user rarely uses these features. A fix means pausing server
     deadlines without an owner, or pushing questions to the phone, both of which
     collide with callback deduplication and the no-rerun rule.
   - The existing `job` error events already distinguish it.
2. **Keeping the browser's diagnostics across an Android process kill.**
   - What happens: the `sessionStorage` mirror does not reliably survive Android
     killing the PWA process.
   - Why set aside: the reported symptoms happen in a page that survived (an alert
     appears on return). Keeping a copy would need a new report origin
     ("last saved snapshot") in the canonical format, deduplication with the session
     mirror, a page-instance id, and merge-before-cut rules.
   - The worker's own IndexedDB records (slice 4) survive a kill anyway.
3. **A feed whose `listRevisions` hangs while pings keep arriving**, and settling a
   job follow's terminal before its `close` handshake.
   - Why set aside: the server is alive in both cases, and they are not tied to
     resume. Fixing them means deadlines and late-result rejection on more paths.
   - Slice 3's resume reconnect replaces a stuck feed connection on the next resume
     anyway.
4. **The completion push sent before the post-reply emotion/image work and final
   write.** Moving the call reorders the runner's tail, and the effect is rare (that
   work failing after a reply).
5. **Push on job errors.** This is a product decision, not a defect. Raise it
   separately if wanted.
6. Earlier Web Push leftovers (VAPID key cached in an open tab,
   `pushsubscriptionchange`, worker upgrade races, de/es/vi/cn/zh-Hant strings), and
   iOS or desktop behavior beyond keeping it as it is.

## Slices

Each slice is one commit with its tests and guide updates. Slice 1 is independent.
Slices 2 and 3 both touch the follow path: one after the other, not in parallel.

### 1. Push delivery and display (_small_)

- `public/sw.js` `windowInFront`; `server/src/push/pushService.ts` `urgency` and
  per-chat `topic`. The topic comes from the notification's tag hash.
- Tests:
  - `src/ts/sw.share.test.ts` (`push` cases): focused but hidden → not silent, not
    closed; focused and visible → today's behavior.
  - `server/src/tests/push.test.ts`: transport options (urgency, per-chat topic
    within the RFC 8030 format, a different topic per chat).
- Docs: build-test-platforms (`sw.js`), global-api (Web Push), self-host-server
  (push service).

### 2. Keep job outcomes, and recover from a lost follow (_medium_)

- `server/src/jobs/generationJobs.ts`: the kept outcome records (GC, trim, bounds,
  epoch clear) and `status()` answering them.
- `src/ts/process/serverCommands.ts`:
  - an `ended` status's terminal used as the end;
  - the revision check after a kept `done`;
  - gone versus unreachable;
  - backoff;
  - deadlines on attach and status read;
  - explicit stale mark plus `refreshStaleChat`, with one retry at the next
    visible/`online`;
  - the `endedAway` notice and its strings (`src/lang/en.ts`, `ko.ts`).
- `src/ts/network/generationJobs.ts`: deadline support in `readGenerationJob`.
- `src/ts/storage/chatStore.svelte.ts`: the stale-mark export.
- New `jobLink` phases `kept`, `gone`, and `recovered`.
- Tests:
  - `server/src/tests/generationJobs.test.ts` (controlled clock): a collected job's
    status still answers `ended` with its trimmed terminal for its own client and
    404 for another; records expire after 24 h, keep at most 500, and are cleared
    on an epoch change; a large `result`/`followUps` is trimmed as specified.
  - `src/ts/process/serverCommands.test.ts`:
    - assert the requested sleep durations (the suite already makes `sleep`
      immediate);
    - a kept `done` → `noteJobDone`, a refresh only when the revision is newer, no
      notice;
    - a kept `error` → `alertJobError`;
    - a gone job → refresh, then the `endedAway` toast, no `lost` alert;
    - an unreachable server → `lost` alert plus a refresh retry on `online`.
  - A chatStore/resourceSync-level test that a lost follow with no remaining
    locks still gets the chat read and its controls unlocked. This is the
    acceptance case, and it reproduces the chat-switch question first.
- Docs: chat-pipeline (job follow), persistence (idle refresh entry point),
  diagnostics (phases).

### 3. Socket liveness and resume reconnect (_medium_)

- New `src/ts/network/socketLiveness.ts`: the frame stamp, the watchdog, the
  connect timeout, and resume-trigger folding, with an injectable clock.
- `src/ts/network/eventFeed.ts`: the connection generation and resume reconnect.
- `src/ts/network/generationJobs.ts`: the job socket watchdog, connect timeout, and
  resume abandon.
- New `feed` and `jobLink` phases.
- Tests (fake timers for intervals and timeouts, controlled `Date.now`; V3):
  - `socketLiveness` itself;
  - `src/ts/network/eventFeed.test.ts`: a 45 s silence abandons and reconnects
    without `close`; overlapping resume triggers build one socket; delayed
    authentication of an abandoned generation does nothing; a late `close` or
    reconcile of an old generation does not reset `attempt`; a resume during a
    pending retry connects now;
  - `src/ts/network/generationJobs.test.ts`: a stale or never-opened job socket
    settles `closed` without a terminal and does not release the job.
- Docs: persistence (`eventFeed.ts` paragraph), global-api (new helper).

### 4. Diagnostics (_medium_)

- `shared/diagnostics.ts`: the `push` and `notice` kinds, `page` phases,
  projections, and both allowlists.
- `shared/diagnosticsReport.ts`: builder and parser for the new kinds.
- `server/src/push/pushService.ts` and `server/src/app.ts`: the recorder.
- `server/src/prompt/runner.ts`: the job id.
- `public/sw.js`: the record ring.
- `src/ts/diagnostics/{collector,report}.ts`: lifecycle phases, `browserState`, and
  the worker merge.
- `src/ts/network/pushNotifications.ts`: `dismissedByPage`.
- Notice events at the `serverJob.lost`, `endedAway`, and `resourceReloaded` show
  sites.
- Tests:
  - `shared/tests/diagnostics.test.ts`: projections keep only the listed fields,
    and no URL or endpoint survives;
  - `shared/tests/diagnosticsReport.test.ts`: round trips with the new kinds;
  - `server/src/tests/push.test.ts`: one event per outcome, and a recorder that
    throws does not change delivery;
  - `src/ts/sw.share.test.ts` with `fake-indexeddb`, as in `sw.asset.test.ts`:
    records, pruning, and a failed open that still shows the notification;
  - `src/ts/diagnostics/{collector,report}.test.ts`.
- Docs: diagnostics (kinds, State, Browser), build-test-platforms (`sw.js`).

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`), and V6 for each new
  regression test. Comments and test titles describe behavior (T5). New strings
  start in `src/lang/en.ts` (U2).
- The worker's logic is covered by the VM suites. Android lifecycle and real push
  delivery need the device. After all four slices, the user runs the Android PWA
  through four scenarios:
  1. Send, lock the screen at once, unlock after the reply (1–3 min).
  2. Send, switch to another app for 5+ min (job expiry and a likely freeze), come
     back.
  3. Send, turn on airplane mode during the reply, turn it off, come back.
  4. Send, force-stop the PWA, reopen it (cold start: boot reads fresh; the worker
     records survive).

  After each scenario, or whenever a symptom shows: Settings → Advanced → Developer
  & diagnostics → Refresh → Save to server. What each event can show:

  - `push accepted` without worker `received`: the push service or the phone did
    not deliver.
  - `received` → `closedInFront` with `focusedHidden`: H1.
  - `jobLink kept`: the outcome came from a kept record (H7 handled); `gone` →
    `recovered`: no record, and the chat was read again.
  - `feed stale` or `resumeReconnect`: H5/H6.
  - `notice`: which alert the user saw.

  A delivery delay (H2) shows only as the time gap between `accepted` and
  `received`.

- `chrome://inspect` over USB can show the worker's console when a report is not
  enough.

## Open questions

None. The `endedAway` question was settled with the user: a kept outcome shows no
notice (`done`) or the usual error alert (`error`), and only a job the server no
longer knows gets the neutral toast.
