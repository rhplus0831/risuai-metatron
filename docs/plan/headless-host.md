# Headless Host Plan

Status: drafted 2026-11-16 at `c3cf22d45` from the owner's questions of the same day (a package script that starts a
headless Chrome and keeps it connected as a remote host), then audited against the code at that commit
([report](../reports/audits/plan-runner/headless-host-2026-11-16.md)) and corrected in the same commit as the report.
D1 and D2 are the owner's choices of 2026-11-16; D3 on are this plan's own and open to the owner's change. The blur
before each Escape stroke and its reload backstop, the marker on the terminal notice's dialog, and the password
prompt's identification by the app's own auth check took their present form from the audit. Landed: 1 (`9e60efa0d`).

Sources: `hostMode`, `hostCommandLog`, `noteHostCommand`, and `receiveHostCommand` (its `pluginsOff` refusal) in
`src/ts/network/remoteHost.ts`; `preference` and `clientName` in `src/ts/network/handoff.ts`; `registerClient` and
`feedConnected` in `src/ts/network/eventFeed.ts`; `MAX_FEED_CLIENT_NAME` in `shared/events.ts`; the `locked` state of
`src/App.svelte`; `src/lib/Others/RemoteHostScreen.svelte` and its test; `answerDialogKey` in `src/ts/hotkey.ts`;
`createDialogKeyGate` and `hasDialogs` in `src/ts/alertQueue.ts`; `alertTerminal`, `acknowledgeTerminalNotice`, and
`alertReloadNotice` in `src/ts/alert.ts`; `src/lib/Others/TerminalNotice.svelte` and
`src/lib/Others/ReloadNotice.svelte`; the `data-alert-dialog` elements and `#alert-input` of
`src/lib/Others/AlertComp.svelte`; `getKeyPair`, `runAuthCheck`, and `login` in `src/ts/storage/serverAuth.ts`; the
`/api/test_auth` route and the login limiter in `server/src/routes/auth.ts`; `readListenConfig` in
`server/src/listenConfig.ts`; `getHttpsOptions` in `server/src/main.ts`; `SAFE_BOOT_THRESHOLD`, `SAFE_BOOT_SETTLE_MS`,
and `safeBootOff` in `src/ts/safeBoot.ts`; `getPluginPermission` and `decidePluginPermission` in
`src/ts/plugins/apiV3/v3.svelte.ts`; `drainUi`, `ask`, and `MODAL_NOTICES` in `src/ts/network/jobChannel.ts`;
`QUESTION_TIMEOUT_MS` in `server/src/jobs/channel.ts`; `util/agentDev.mjs` (`waitForListener`, the `readListenConfig`
call) and `util/agentDevHost.mjs`; `chromePath`, `startStack`, `openApp`, and `pluginFixtureOp` in
`util/playwright/stack.mjs`; `util/playwright/checkJobHandoff.mjs`; the Remote Host plan
(`git show baba43d2e:docs/plan/remote-host.md`), whose "Not In This Plan" names a headless host and default dialog
answers. The identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

`pnpm host:headless` starts the system Chrome without a window, opens the app of the server running on this machine,
turns Remote Host Mode on under a fixed name, and keeps that page up until the script is stopped. Other devices then
send through it as through any host tab.

- **Local only (D1).** The script reaches the app over a loopback address. It takes no URL.
- **Unattended dialogs (D2).** No person sits at the host, so the script gives every dialog the answer of an absent
  user: it dismisses it and logs its text. It never allows anything.
- **One profile.** The browser's key pair stays in a profile folder, so the password is needed for the first start
  only.
- **The log is the screen.** The script's standard output says when the host is ready, when the feed connects and
  drops, which commands ran, which dialogs it dismissed, and why it restarted the page.

Not goals: a host on another machine than the server; a host the server process starts; Docker; answering a host's
dialog from the sending device; changing the relay, the host's send, or authentication.

## Current State

- **Host mode is one device-local value.** `hostMode` is `localStorage` `risu-remote-host`; while it is on and the
  database has loaded, `src/App.svelte` shows `RemoteHostScreen.svelte` over the app and the feed registration carries
  `host`. The name other devices choose a host by is `clientName` (`risu-handoff-name`), whose default is the first
  `MAX_FEED_CLIENT_NAME` code units of the User-Agent string, no name a person would pick a host by.
- **The login lives in the browser.** `serverAuth.ts` keeps a non-extractable ECDSA key pair in IndexedDB and registers
  its public key with the password digest once. A fresh profile is asked for the password in an `input` dialog
  (`#alert-input`); on a server with no password the same dialog sets one. The app's first request, `/api/test_auth`,
  answers `unset` for such a server, `incorrect` for a token it does not accept (an unknown key among them), and
  `success` otherwise; the prompt follows the first two. The login routes sit behind a rate limiter.
- **A secure context is required.** `crypto.subtle` exists on HTTPS and on loopback only, which is why the dev runner
  binds to `127.0.0.1`. The server listens with HTTPS when both files of `server/ssl/certificate/` exist, usually with
  a self-signed certificate.
- **The browser tooling exists.** `playwright-core` is a development dependency and the browser stack launches the
  system Chrome (`RISU_CHROME`, default `/usr/bin/google-chrome`). The Docker runtime image installs production
  dependencies only and has no Chrome.
- **Dialogs a host tab can get**, and what happens when nobody answers:
  - A plugin's permission prompt (`decidePluginPermission`, an `alertConfirm`): waits without a time limit, and the
    plugin call behind it waits too. Grants are in the server-owned `pluginPermissions` resource, so a grant given on
    another device counts on the host. A standing grant (Settings → Plugins → the permission list) is not asked
    again by a default or a `"periodically"` check of the unchanged script (an uncached `reconfirm: true` check would
    still ask; no caller passes it today); any other grant of a `"periodically"` permission is asked again after three
    days, on the first use after a page load. A denial is cached for the page. Saving a permission list raises the
    plugin's reset count; a tab drops its cached answers as soon as it learns the new count, host mode or not, and
    replaces the running plugin once its plugin work is idle.
  - A dialog a plugin opens itself (`alert`, `alertConfirm`, `alertError` of the plugin API): waits without a time
    limit.
  - A server job's modal notice (`MODAL_NOTICES`): `drainUi` awaits its close with no time limit, so the tab's later
    queued alert notices and questions wait behind it (progress and other effect notices do not queue).
  - A server job's question (`ask`): the server cancels it after `QUESTION_TIMEOUT_MS` (120 s) and the tab removes the
    dialog.
  - The safe-boot notice and a boot error, at boot.
  - A send's admission and terminal errors are not dialogs on a host: they return to the sending device as reports.
    One path still opens a dialog there: a job ended by maintenance whose restore watch sees no new epoch
    (`alertJobError` in `serverCommands.ts`).
- **Escape is the dismissal.** In host mode `answerDialogKey` is the only key path: Escape answers the shown dialog
  with `""`, the caller's dismissal (a confirm reads it as no, a permission prompt as denied, a selection as no
  choice). The key gate accepts a stroke only when it began after the dialog appeared and is not a repeat. The
  document handler returns before that path while a text entry has the focus, unless it is the input dialog's own field
  or an `ask` dialog's checkbox. Under the lock screen the app's own text entries are `inert` and cannot hold the
  focus, but a dialog's field can, so a script moves the focus off before the stroke.
- **Two notices are outside the alert queue.** The terminal notice (a restore replaced the server data) ignores Escape;
  only its OK acknowledges it, and the save adapter then reloads the page. The reload notice stays until dismissed and
  blocks nothing.
- **Safe boot counts unsettled boots.** A boot that reached user content and did not stay up for `SAFE_BOOT_SETTLE_MS`
  (10 s) counts; after `SAFE_BOOT_THRESHOLD` (2) of them the next boot loads no plugin, and a host then refuses every
  send with `pluginsOff`. The record is in `localStorage`, so it survives a restart of the script.
- **The lock screen is readable by a person only.** Its connection state, its waiting-dialogs line, and its command
  rows are translated text with no attribute a script can read.

## Rules For Every Slice

- The script runs no app logic. It sets two `localStorage` values before the app starts, blurs the focused element,
  presses keys, clicks the terminal notice's OK, reloads the page, and reads attributes and the app's own
  `/api/test_auth` answer. Everything a command does stays in the tab.
- The script never gives an answer that allows, confirms, or chooses. Its only answers are Escape, the terminal
  notice's OK, and the password it was given.
- The script never sets a server's password and never tries a refused password again.
- The server, the relay contract (`shared/remoteCommands.ts`), `remoteHost.ts`, and `serverAuth.ts` do not change.
- Nothing the script logs is a credential: the password and the `risu-auth` header never reach the log, and a dialog's
  text is cut to a fixed length.
- V1 to V9 apply. Each slice updates the guides it names and the path ownership of its new files
  (`pnpm docs:owner <path>`, `pnpm check:docs`). Full checks: `pnpm check`, `pnpm check:docs`, `pnpm format:check`,
  `pnpm --silent test:agent`, and the specs `pnpm --silent test:agent --e2e` selects for the diff.
- Workflows: `opus-lite` for a slice without a size, `opus-workflow` for a _hard_ slice.

## Order

1, 2, 3 in that order. 2 reads the attributes 1 adds; 3 drives the script 2 adds. No file is shared between slices
except the guides: `network-jobs.md` (1, 2) and `test-harness.md` (2, 3).

## Slice 1. Lock screen state a script can read (`ui-theming.md`, `global-api.md`, `network-jobs.md`)

Existing: `src/lib/Others/RemoteHostScreen.svelte` with its test, `src/lib/Others/TerminalNotice.svelte`,
`src/lib/Others/ReloadNotice.svelte`.

- **The lock screen's root** carries `data-remote-host-screen`, `data-feed-connected` (`true`/`false`, from
  `feedConnected`), `data-dialogs` (`true`/`false`, from `alertStore.hasDialogs()` read under `$alertStore`, as the
  waiting-dialogs line does, since the method alone is not reactive), and `data-plugins-off` (`true`/`false`, from
  `safeBootOff("plugins")`, fixed for a page load).
- **Each command row** carries `data-command-id`, `data-command-type`, `data-command-state`, and, when the entry has
  one, `data-command-code`.
- **The terminal notice's `<dialog>`** carries `data-terminal-notice` (the shared `Button` forwards no attribute, so
  the marker is on the dialog, whose only button is OK); **the reload notice's panel** carries `data-reload-notice`.
- No text, layout, or behavior changes. The attributes are a contract of the lock screen: its guide entry names them
  and says the headless host script reads them.
- Tests (`RemoteHostScreen.test.ts`): each root attribute follows its store; a command row carries its entry's
  fields, and no `data-command-code` without a code.

## Slice 2. The host script (_hard_, `build-test-platforms.md`, `network-jobs.md`, `test-harness.md`)

New files: `util/headlessHost.mjs` (the process), `util/headlessHostConfig.mjs` (pure functions) with
`util/headlessHostConfig.test.ts`. Existing: `package.json` (`"host:headless": "node util/headlessHost.mjs"`),
`.gitignore`, `.dockerignore`, and `.prettierignore` (`/host-profile/`).

- **Settings**, read once by `headlessHostConfig.mjs`:

  | Variable                      | Meaning                                                         | Default                  |
  | ----------------------------- | --------------------------------------------------------------- | ------------------------ |
  | `RISU_HEADLESS_HOST_NAME`     | The host's name, at most `MAX_FEED_CLIENT_NAME` code units      | `Headless host`          |
  | `RISU_HEADLESS_HOST_PROFILE`  | The Chrome profile folder, relative to the repository root      | `host-profile`           |
  | `RISU_HEADLESS_HOST_PASSWORD` | The server password, read only when the app asks for it         | none                     |
  | `RISU_HEADLESS_HOST_PORT`     | The port the app is served on                                   | `PORT`, else 6001        |
  | `RISU_HOST`                   | The server's own variable: decides the loopback address (below) | unset                    |
  | `RISU_CHROME`                 | The Chrome binary, as in the browser stack                      | `/usr/bin/google-chrome` |

- **The address (D1, D3).** `RISU_HOST` unset or a wildcard (`0.0.0.0`, `::`) gives `127.0.0.1`; a loopback literal is
  used as it is; any other value stops the start with a message that names the variable (the server would not answer on
  loopback, and its own address is no secure context over HTTP). The script waits for a listener on the port, then
  learns the scheme by trying a TLS handshake on it, without certificate verification and with a time limit: HTTPS
  when it completes, HTTP otherwise. The port is the one the browser opens, so a dev stack's Vite port reads as HTTP
  whatever its server uses. The browser context ignores certificate errors, which is safe only because the address is
  loopback.
- **The browser.** `playwright-core`'s `chromium.launchPersistentContext` on the profile folder (created with mode
  `0700`) with the system Chrome, headless, one page. A missing `playwright-core` (an install without development
  dependencies) or a profile another Chrome holds stops the start with a message that says so.
- **Before the app starts**, an init script on every document with an origin writes `risu-remote-host` (`true`) and
  `risu-handoff-name` (the name), in the JSON form `preference` reads. A remote "Reload page" therefore comes back as
  a host under the same name.
- **A page load** is ready when `[data-remote-host-screen]` exists. Until then the script looks once per tick
  (`TICK_MS`, one second):
  - The script opens the bare root URL (no query and no hash) and watches the answer to the app's own
    `/api/test_auth` request of each document. `unset` ends the script (the password is set from a person's browser,
    never here). `incorrect` means the app is about to ask for the password: the next `input` dialog whose
    `#alert-input` carries the secret marker (`data-plugin-secret`) is that prompt, the script types the password into
    the field and presses Enter, and the identification is used up (a later `incorrect` of the same document, after
    a failed login, identifies the next prompt). The password is typed once per run of the script; no password, or
    an identified prompt a second time, ends the script. These three ends have their own exit codes and
    messages. After `success`, and for every `input` dialog not identified this way (`#alert-input` is every input
    dialog's field, and a plugin's send can open a secret one before the page is ready), the dialog is dismissed like
    any other.
  - Any other dialog is logged and dismissed as below.
  - No ready state within `BOOT_DEADLINE_MS` (120 s) is a failed load.
- **While ready**, per tick, in this order:
  - `[data-terminal-notice]` present: click its button, the OK (the app reloads the page itself).
  - `data-dialogs="true"`: log the visible `[data-alert-dialog]`'s text, blur the focused element
    (`document.activeElement.blur()` from the page, whatever it is, the input dialog's own field included), press
    Escape once, and look again on the next tick. One stroke per tick, so each queued dialog gets a stroke that began
    after it appeared. The same dialog still shown after `DISMISS_TRIES` (10) strokes is logged as not dismissable and
    the page is reloaded as a failed load (the restart wait applies); the count starts again when another dialog takes
    its place, since `data-dialogs` stays `true` across a queue of dismissed dialogs.
  - Log each change of `data-feed-connected`, each command row whose state changed, the reload notice once per
    appearance, and `data-plugins-off="true"` once per page load.
- **Restarts (D5).** A crashed page, a closed browser, and a failed load start a new page load after a wait that
  doubles from 5 s to 5 min and returns to 5 s once a load has been ready for a minute. A page with plugins off is
  reloaded after the same wait, never sooner than `SAFE_BOOT_SETTLE_MS` plus a margin after it became ready, so the
  safe boot settles and the next boot is a normal one. The script never clears `risu.safeBoot.attempts`.
- **The end.** SIGINT and SIGTERM close the browser context (so the profile is written) and exit 0. That the
  browser is gone after each of these two ends, and after the script's own fatal exits, is checked in slice 3; a
  killed script (SIGKILL) is not covered.
- **The log.** One line per event on standard output with an ISO timestamp: the address and name at the start,
  ready, feed up and down, command states, dismissed dialogs, restarts with their reason, and page console errors.
- Tests (`headlessHostConfig.test.ts`, node): the address rule for each `RISU_HOST` form; the port precedence and an
  invalid port; the name's length limit and the JSON form of the two `localStorage` values; the restart wait's
  doubling, cap, and reset; the plugins-off reload's earliest time. The process (the launch, the ticks, the signals)
  has no unit test: slice 3 checks it. No TypeScript project includes `util/`, so neither file is type-checked.
- Guides: the script row and its settings in `build-test-platforms.md`; one entry under the generation job client in
  `network-jobs.md` (the script, D2's rule, and what a dismissed dialog means for a plugin's permission); the script's
  place among the Playwright users in `test-harness.md`. `README.md` gets a short "Headless host" section: the two
  commands, the first-start password, the standing grants to give first, and that the profile folder is a login.

## Slice 3. A check of the script against the isolated stack (`test-harness.md`)

New file: `util/playwright/checkHeadlessHost.mjs`, run under `util/playwright/offline.sh`. Not in the gate.

- It starts the stack (`startStack` with `serverEnv: { RISU_PASSWORD_SHA256: "" }`, since an inherited seed would
  set a password) and runs the no-password case first, while the stack's server has none (`restartServer` keeps the
  save directory, so the case cannot come later). Then it sets the password through a first
  browser context (`openApp`), installs a v3 plugin fixture (`pluginFixtureOp`) that calls the plugin API's `alert` and
  one API that needs a permission, and starts `util/headlessHost.mjs` as a child with a temporary profile, the stack's
  Vite port, the password, and an environment without the shell's `RISU_HOST` and `PORT`.
- It reports PASS or FAIL per case:
  - Started against the server with no password, the script ends with the exit code for `unset`, and no password is
    set.
  - The host appears in the first context's presence under the script's name with `host` set.
  - The plugin's `alert` on the host is dismissed, and the script's log holds its text. The plugin API's `alert`
    returns without waiting for the dialog, so the case reads the dialog's absence, not the call's return.
  - The permission prompt is dismissed, the plugin's call is denied, and no grant is written.
  - The script, stopped with SIGTERM and started again without the password, becomes ready on the same profile, and
    no browser process of the first run is left.
  - A page reload command from the first context brings the host back under the same name.
- Guides: the script's entry under "Check and measurement scripts" in `test-harness.md`.

## Decisions

- **D1. Local only.** (Owner, 2026-11-16.) The script has no URL setting and reaches the app on loopback. This removes
  the secure-context check, the certificate question, and a profile that is a login for another machine. The server
  itself still listens for the other devices as before. Rejected: `RISU_AGENT_DEV_AUTH_BYPASS` in place of a login (it
  needs a loopback-only server, which no phone reaches).
- **D2. The absent user's answer.** (Owner, 2026-11-16, from this plan's recommendation.) Every dialog is dismissed
  with Escape and logged; the script never allows. A permission is therefore denied on the host until a person gives a
  standing grant on another device, which resets the plugin in every tab and drops the cached denial. Rejected:
  allowing permission prompts automatically (a changed plugin script would get its permissions with no person
  looking); leaving dialogs open (a permission prompt and a plugin's own dialog wait forever, and one modal notice
  holds the tab's queued alert notices and questions); reloading the page after a timeout as the policy (the reload
  is only the backstop for a dialog a stroke does not close).
- **D3. A server bound to a non-loopback address is refused**, not worked around with Chrome's
  insecure-origin flag. Such a setup is rare and the flag would widen what the profile trusts.
- **D4. Dismissal is the script's keystroke, not an app mode.** Escape in host mode is an existing, tested path once
  no text entry has the focus, which the script ensures by blurring the focused element before each Escape stroke; so
  the app needs attributes only (slice 1). A dialog the stroke still does not close ends in a page reload, the
  backstop. Rejected: a second device-local "unattended" preference that makes the
  alert queue answer itself (new behavior in the alert layer for one caller).
- **D5. The script retries a page with plugins off, with the restart wait.** Such a host refuses every send, so
  waiting helps nobody; the wait bounds the loop when a plugin breaks every boot.
- **D6. The first start takes the password from the environment**, by typing it into the app's own prompt. Rejected
  for now: registering the profile's key from `save/server/password` (possible only locally, but the script would have
  to know the key store's IndexedDB layout).
- **D7. The script does not start the server.** It waits for the listener. The server's life stays with whatever
  starts it today, and a dev stack keeps working (`RISU_HEADLESS_HOST_PORT` set to Vite's port).
- **D8. The script is a development-checkout tool.** `playwright-core` stays a development dependency.

## Not In This Plan

- A host on another machine than the server, and Docker (a Chrome beside the server in one network namespace).
- Starting the headless host from the server process.
- Sending a host's question to the sending device, or default answers per dialog kind. A send that needs an answer
  (a trigger's input, the memory trim question) goes on with the dismissal or ends, as with an absent user.
- Showing dismissed dialogs on the sending device or in the lock screen's list; they are in the script's log.
- Reloading the page when the server's build changes. A restart of the script, or "Reload page" from another device,
  loads the new build.
- A watchdog that reloads a page whose feed stays disconnected. The script logs the state; the app owns the
  reconnect.
- Asking for the password on a terminal, and the password-free first start of D6.
- The handoff preference of the headless host (it keeps the default).

## Manual Checks

Agents cannot run these; they go to [manual checks](../backlog/manual-checks.md) when the plan is archived.

- A phone sends through the headless host with the owner's illustration plugin: the reply and the illustration are
  there, with the plugin's permissions given as standing grants first.
- The same after the host has been up for more than a day, and after the machine slept and woke.
- A permission that was allowed with the prompt only (no standing grant), more than three days later after a restart
  of the script: the host's log shows the denied prompt, and a standing grant from the phone makes the next send work
  without restarting the script.
- The server restarted under a running script: the host is listed again without a restart of the script.
- A server with HTTPS files: the script connects, and a second start reuses the profile.
- `PORT`/`RISU_HOST` forms of the owner's own setup (a service unit, a Tailscale-bound server): the script's refusal
  message is clear when the server is not on loopback.
