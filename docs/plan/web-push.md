# Web Push Plan

Status: planned. When a reply finishes, the server sends a Web Push
notification to every browser that subscribed. The notification arrives even
when no tab is open. Today the only notification is the tab's own
`new Notification(...)` (`src/ts/network/jobChannel.ts`, `case "notification"`),
which needs an open, attached tab.

Reference: `/home/codex/risuai-fastify` shipped the same feature:

- `e58fb5057`: the service, the routes, and the service worker.
- `48057db3d`: a per-character message and a length cap.
- `7eb6af8f9`: stale notifications closed on focus.
- `8820b3e8c`: hardened boundaries.

This plan takes its service shape. It does not take its startup permission
request: Fastify calls `Notification.requestPermission()` at boot, without a
click, and Firefox and Safari ignore or refuse that. It also does not take its
toggle reconciliation (`75e939bba`, `01cce4235`, `5f7713c89`).

## Product decisions

1. **One global switch, plus one question per browser.**
   - `settings.ui.notification`, the existing synced setting, decides whether
     the server sends anything.
   - Each browser receives push only when it holds a subscription.
   - When the switch is on and a browser has never been asked
     (`Notification.permission === "default"`), the app shows a small
     in-app prompt with two buttons: "Receive notifications on this browser"
     and "Later".
   - The permission request runs inside that button's click handler, because
     browsers require a click for it.
   - "Later" is remembered in this browser's `localStorage` and the prompt does
     not come back. The Notification settings item can still turn this browser
     on later.
2. **The body is the character's custom message when set, else a default
   sentence.**
   - Custom message: a new optional character field,
     `customNotificationMessage`.
   - Default sentence: Korean `{name}의 메시지 처리가 완료되었습니다`, English
     `{name}'s message has been processed.`, chosen by the `language` setting.
     Other languages fall back to English.
   - `{name}` is the chat owner's `name`: the group's name in a group chat.
   - The title stays `Risuai`, as today.
3. **Truncation.**
   - `{name}` is cut to 20 graphemes plus `…`, using `Intl.Segmenter` so an
     emoji or a Hangul syllable is never split.
   - The whole body is capped at 1 KiB UTF-8, so the push payload stays well
     under the 4 KiB limit of push services.
4. **The custom message is plain text and local.** No CBS. It is not written
   to exported cards and not read from imported ones (D5).
5. **The tab notification uses the same text.** It no longer shows the reply,
   so reply text does not appear on lock screens. The tab notification and the
   push notification share one `tag` (`risuai-chat-completion`), and a browser
   subscribed to push does not show the tab notification at all, so the two do
   not stack.
6. **The icon is the app logo for now.**
   - The payload still carries `icon` and `badge`.
   - The service worker falls back to the logo when `showNotification` fails.
   - A character avatar icon comes later, after the thumbnail work, as a
     signed URL route. Nothing in this plan builds it.
7. **The server sends on every completion while the switch is on.** It does
   not check whether a tab is attached. The service worker shows every push,
   also while a window of the app is in front: Safari revokes the permission
   of a site whose pushes show nothing, Chrome shows its own generic notice
   instead, and Firefox counts them against a quota. (Changed during
   implementation from "drop it while a window is visible".) The page closes
   the tagged notifications whenever it is shown.
8. **Subscriptions are not resources.** They are per browser, so they are not
   synced to other clients, not in backups, and not in snapshots. They live
   under `save/server/`, next to the password, where the storage routes cannot
   reach them.
9. **Stale notifications close when the app comes to the foreground.** When a
   page starts visible, or becomes visible again, it closes this browser's
   tagged notifications.
10. **No push in an insecure context.**
    - Push needs HTTPS or `localhost`. iOS needs a Home Screen web app, on iOS
      16.4 or later.
    - Where push is unavailable, the settings item says why, and the tab
      notification keeps working as before.

## Data model

- `character` and `groupChat` (`shared/database.ts`) gain
  `customNotificationMessage?: string`.
  - It is optional, like `nickname`, so no normalizer default is needed.
    Readers treat a missing or blank value as unset.
  - Check `CHARACTER_FIXED_FIELDS` (`shared/mutationValidation.ts`) and the
    card export and import paths (`src/ts/characterCards.ts`). The field must
    stay out of exported cards.
- The `notification` notice (`shared/jobs.ts`) changes from
  `{ chaId, body }` to `{ chaId, chatId, title, body }`. The server builds
  `title` and `body`. The tab shows them as given.
- The new `shared/notifications.ts` holds:
  - `completionNotificationText({ name, customMessage, language })`
  - the Korean/English sentence table
  - the grapheme and byte truncation helpers

  Both sides use it.

- Server files under `save/server/`:
  - `web_push_vapid.json`: a VAPID key pair generated on first start. It can
    be overridden by `RISU_WEB_PUSH_VAPID_PUBLIC_KEY` and
    `RISU_WEB_PUSH_VAPID_PRIVATE_KEY`. Both must be set, or the service stays
    disabled.
  - `push_subscriptions.json`: subscriptions keyed by endpoint, each with
    `failureCount` and `lastError`. Writes go to a temp file, then a rename.
- The VAPID contact comes from `RISU_WEB_PUSH_CONTACT`. The default is
  `mailto:risuai@example.invalid`.
- Browser `localStorage` holds `risu-push-prompt-dismissed`. Every access is
  wrapped in `try/catch`.

## Slices

### 1. Shared text and the character field

- Add `shared/notifications.ts` and its tests:
  - the custom message winning over the default
  - blank and whitespace-only custom messages treated as unset
  - name truncation at 20 graphemes (emoji, a Hangul name, exactly 20)
  - the 1 KiB body cap
  - the language fallback
- Add `customNotificationMessage` to `character` and `groupChat`.
- Add the field to `CharConfig.svelte`, under the first message, with a
  `Help` key. Add the English and Korean strings.
- Confirm that card export leaves the field out. Add a test if the export
  builds the card from an allowlist.

### 2. Server push service and routes

- Add `web-push` and `@types/web-push`.
- Add `server/src/push/pushService.ts` with
  `createPushService({ savePath, env, transport? })`, which returns:
  - `publicKey(): string | null`
  - `upsert(subscription)`
  - `remove(endpoint)`
  - `send(payload): Promise<void>`

  Rules:
  - Without keys, the service is disabled: `publicKey()` is `null` and
    `send` does nothing.
  - Validate a subscription before storing it, and again when the file is read:
    - the endpoint is an `https:` URL of at most 4096 characters, on the
      default port, without credentials or a fragment, whose host is a known
      push service (`fcm.googleapis.com`, `android.googleapis.com`,
      `updates.push.services.mozilla.com`, `web.push.apple.com`,
      `*.push.apple.com`, `*.notify.windows.com`, plus
      `RISU_WEB_PUSH_ALLOWED_HOSTS`);
    - `keys.p256dh` is a 65-byte uncompressed P-256 point and `keys.auth` 16
      bytes, both base64url;
    - at most 50 subscriptions; the oldest by `updatedAt` is dropped.
      The server POSTs to whatever endpoint it stores, so the endpoint is never
      taken unchecked.
  - `send` uses TTL 1 h, urgency `normal`, and topic `chat-completion`.
    - A 404 or 410 deletes the subscription.
    - Any other failure increments `failureCount`.
    - Nothing throws to the caller.
    - Logs never contain the endpoint or the keys.

- Add `server/src/routes/push.ts` with `registerPushRoutes(app, { push, auth,
limiter })`. The routes use the same JWT check and limiter as
  `registerLlmSecretRoutes`. They are not resources, so they have no epoch and
  no maintenance gate.
  - `GET /api/push/key`: `{ publicKey }`, or `{ publicKey: null }` when
    disabled.
  - `PUT /api/push/subscription`: body `{ subscription }`. Answers 204, or 400
    for an invalid subscription.
  - `DELETE /api/push/subscription`: body `{ endpoint }`. Answers 204.
- Wire it in `server/src/app.ts` (`createServerContext`): create the service
  once and pass it to the routes and to the generation runner deps
  (`GenerationRunnerDeps`, `server/src/jobs/runSetup.ts`).

### 3. Sending on completion

- In `server/src/prompt/runner.ts`, where `db.notification` sends the notice,
  build the text with `completionNotificationText`:
  - `owner`'s `name` and `customNotificationMessage`
  - `db.language`; confirm that the field is on the job's settings
    projection, as `notification` is
- Send the notice with the new payload shape, and call the push service with
  `{ title, body, icon: "/logo_192.png", badge: "/logo_192.png", url, tag }`.
  - `url` is the chat route: `/chat/<chaId>/<chatId>`, encoded as
    `src/ts/router/routes.ts` does.
  - The push call is fire-and-forget. Its failure never changes the job's
    outcome.
- A group job may notify once per speaker. The shared `tag` collapses these
  into one notification.
- Server tests use an injected transport:
  - one push per notification
  - none when `notification` is off
  - the custom message, the default sentence, and the URL
  - a failing transport that leaves the job's `done` unchanged
  - the route checks: JWT required, invalid subscriptions refused, 404/410
    pruning

### 4. Client: subscribe, prompt, and show

- Add `src/ts/network/pushNotifications.ts`:
  - `pushAvailability()`: one of `"ok" | "insecure" | "unsupported" |
"denied" | "disabled-on-server"`.
  - `enablePushOnThisBrowser()`: must be called from a click handler.
    - `Notification.requestPermission()`
    - `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
    - `PUT /api/push/subscription`
  - `disablePushOnThisBrowser()`: `unsubscribe()`, then
    `DELETE /api/push/subscription`.
  - `syncPushOnBoot()`: runs when the switch is on and permission is
    `granted`. It re-registers the current subscription, or creates a new one
    when none exists, because push services rotate them. It never requests
    permission.
  - `dismissCompletionNotifications()`: closes this browser's notifications
    with the shared tag. It runs at boot when the page is visible, and on each
    `visibilitychange` to visible.
- `src/ts/bootstrap.ts`: call `syncPushOnBoot()` after `registerSw()`, without
  blocking boot. Then decide whether to show the one-time prompt:
  - the switch is on,
  - `pushAvailability()` is `"ok"`,
  - permission is `"default"`, and
  - the browser has not dismissed it.
- Add a one-time prompt component: a small non-modal banner, two buttons, and
  the English and Korean strings. "Receive" calls `enablePushOnThisBrowser()`
  directly in its handler. Do not await an alert first, because Safari may not
  count the click any more.
- `NotificationToggle.svelte`:
  - The checkbox stays the global switch.
  - Under it, a status line for this browser: subscribed, not subscribed,
    insecure, unsupported, or denied.
  - A button that turns this browser on or off.
  - Turning the global switch on from here also asks this browser, since the
    toggle's click is a user gesture.
- `src/ts/network/jobChannel.ts`, `case "notification"`:
  - Use `registration.showNotification(title, { body, tag, icon, badge,
data: { url } })`, falling back to `new Notification` when there is no
    registration.
  - Only show it when permission is already `granted`. Remove the gesture-less
    `requestPermission()` call.
  - A click focuses the window and opens `url` through the client router.

### 5. Service worker

In `public/sw.js`:

- `push`:
  - Read and validate the payload. Unknown or missing fields fall back to the
    logo, `Risuai`, and `/`.
  - Always call `showNotification` (decision 7), and retry with the text alone
    when that throws.
- `notificationclick`:
  - Close the notification.
  - If a window of this origin is open, focus it and `postMessage({ type:
"open-route", url })`. The client listens for that message and navigates
    through its router.
  - Otherwise call `clients.openWindow(url)`. The server serves the client on
    `/chat/...`.
- `pushsubscriptionchange`: nothing beyond logging. The worker has no JWT, so
  it cannot register the new subscription. `syncPushOnBoot()` repairs it on
  the next open.
- Add `install` → `skipWaiting()` and `activate` → `clients.claim()` so
  existing installs pick up the handlers without closing every tab. Check by
  hand that image caching (`/sw/check`, `/sw/register`, `/sw/img`) still works
  across that update.

## Tests

- `shared/notifications.test.ts` (slice 1).
- `server/src/tests/push.test.ts`: service and routes (slice 2).
- Runner notification cases next to the existing `notification` notice
  coverage in `server/src/tests/promptTail.test.ts` (slice 3).
- `src/ts/network/pushNotifications.test.ts`: availability states, the
  prompt's conditions and dismissal flag, boot sync never requesting
  permission, and dismissal on visibility. Stub `PushManager` and
  `Notification`.
- `public/sw.js` has no automated tests (V1). Verify it by hand.

## Manual verification

- Desktop Chrome on `localhost`:
  - Prompt shown once. "Later" keeps it hidden on reload.
  - "Receive" subscribes.
  - A reply with the tab hidden or closed shows the push.
  - A reply with the tab visible still shows the push (decision 7), and the
    tab shows no second notification of its own.
  - Clicking a notification opens the chat.
- Firefox: the same, especially the click-only permission request.
- Android Chrome over HTTPS, as an installed PWA.
- iOS 16.4+ Home Screen web app over HTTPS, if a device is available.
- Plain HTTP on a LAN address: the settings item shows "insecure" and the tab
  notification still works.
- The service worker update path: an existing install picks up the new worker,
  and cached avatars still show.

## Out of scope

- A character avatar icon (after the thumbnail work).
- Thumbnails themselves.
- CBS in the custom message.
- Holding the push until the server's translation of the reply settles
  (Fastify `f649d59f9`).
- A list of subscribed devices with per-device removal.

## Docs to update with the change

- `docs/structure/self-host-server.md`: the push routes, `save/server/`
  files, the env vars, and the runner's push call.
- `docs/structure/global-api.md`: the `notification` notice's new payload and
  how the tab shows it.
- `docs/structure/build-test-platforms.md`: the `public/sw.js` handlers and
  the `skipWaiting`/`clients.claim` lifecycle.
- `docs/structure/characters-modules.md`: `customNotificationMessage` is
  local-only.
