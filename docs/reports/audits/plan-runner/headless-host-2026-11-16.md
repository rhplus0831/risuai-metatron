# Headless Host Plan audit, 2026-11-16

- Plan: `docs/plan/headless-host.md`
- Commit audited: `c3cf22d45` (`claude/headless-chrome-remote-package-9c6fe8`), with the plan as an uncommitted draft
  in the working tree; the corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the session that drafted the plan (Claude Fable 5.2),
  before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 1     |
| P3         | 5     |
| unverified | 1     |

All seven graded findings are `fixed in plan`; A8 stays `unverified` with its claims scoped. No P1 is open. A1 to A8
came from the first turn. In the second turn Sol confirmed the corrections for A1 and A2, disputed the one for A3, and
proposed another mechanism for it; the drafting session wrote that mechanism into the plan. In the third turn Sol read
the corrected sentences on disk, confirmed A3, found no new P1 or P2 in the corrections, and gave every finding its
final status.

Sol changed no file in the repository and ran no test, type check, build, server, or browser: the audit is a reading
of the code. The three turns took about 28 minutes and 9.5 M tokens.

Found consistent: the constants and keys (`SAFE_BOOT_THRESHOLD` 2, `SAFE_BOOT_SETTLE_MS` 10 s, `QUESTION_TIMEOUT_MS`
120 s, `MAX_FEED_CLIENT_NAME` 64, the three-day reconfirmation, port 6001, `risu-remote-host`, `risu-handoff-name`,
`risu.safeBoot.attempts`); the dialog keys live before authentication ends and before `loadedStore`
(`src/startApp.ts:12`, `src/ts/hotkey.ts:169`); `/api/test_auth` answering `unset` before any token check, behind the
2000-per-minute auth bucket and not the login bucket (`server/src/routes/auth.ts:224`, `server/src/app.ts:652`,
`:658`); `preference`'s JSON form and the 64-code-unit cut of the name at registration and on the server
(`src/ts/network/handoff.ts:26`, `:120`, `server/src/routes/events.ts:198`); safe boot's record, its removal after a
settled plugins-off boot, and the host's `pluginsOff` refusal (`src/ts/safeBoot.ts:187`, `:224`,
`src/ts/network/remoteHost.ts:428`); the cached permission answers dropped as soon as a tab learns a reset, in host
mode too, with the plugin's replacement deferred until its work is idle (`src/ts/plugins/apiV3/v3.svelte.ts:897`,
`src/ts/plugins/plugins.svelte.ts:606`); `drainUi`'s unbounded wait on a modal notice and the removal of a cancelled
question's dialog (`src/ts/network/jobChannel.ts:539`, `:598`, `:1576`); the lock screen mounted only under
`$hostMode && $loadedStore` with the stores the attributes need (`src/App.svelte:92`, `:298`); the listener's host,
port, and HTTPS rule, and Vite staying HTTP in front of an HTTPS server (`server/src/listenConfig.ts:30`,
`server/src/main.ts:36`, `:73`, `vite.config.ts:77`); the stack helpers slice 3 names (`util/playwright/stack.mjs:16`,
`:148`, `:246`); the file lists, the guide ownership of every touched and new path, and the Order section's claim
that the slices share only two guides.

Re-check list: the plan touches none of the four mechanisms. `patchMessage` still reaches `closeFence`
(`server/src/data/chatStore.ts:2553`); feed rows are measured whole (`server/src/data/chatStore.ts:1927`);
`STORE_TABLES_SQL` runs for schema version zero and a new validated store (`server/src/data/resourceStore.ts:3855`,
`:792`); `sendText` counts the sockets whose frame admission succeeds (`server/src/jobs/generationJobs.ts:1047`,
`:1062`).

## P1

### A1 — Slice 2, D4: Escape does not reach a dialog while a text entry has the focus — fixed in plan

- Plan (Slice 2, While ready): "`data-dialogs="true"`: log the visible `[data-alert-dialog]`'s text, press Escape
  once, and look again on the next tick." And D4: "Escape in host mode is an existing, tested path, so the app needs
  attributes only (slice 1)."
- Code: the document handler returns for a focused input, textarea, contenteditable element, or EditContext host
  before the host-mode branch reaches `answerDialogKey` (`src/ts/hotkey.ts:161`, `:169`). The exceptions are the
  input dialog's own `#alert-input` and an `ask` dialog's checkbox inputs. The stroke is recorded and stopped, no
  answer is given, and `hasDialogs()` stays true, so the next tick repeats the same sequence. The `wait2` dialog
  keeps the previous focus (`src/lib/Others/AlertComp.svelte:182`), and the delegated selection dialogs take none
  (`:1054`). Under the lock screen the app's own text entries are `inert` (`src/App.svelte:163`), which narrows the
  case to a field outside that tree; a fresh stroke that satisfies `createDialogKeyGate`'s `accepts` does not pass
  the earlier return.
- Correction, confirmed: the script blurs the focused element before each Escape stroke. With the focus on the body
  one fresh Escape answers `""` for every dialog kind, the input dialog with its field blurred and `wait2` included
  (`src/ts/hotkey.ts:77`, `src/ts/alertQueue.ts:282`, `:296`); nothing moves the focus back while the dialog is
  pending (`AlertComp.svelte:8`, `:182`). The same dialog still shown after `DISMISS_TRIES` (10) strokes ends in a
  page reload, counted per dialog because `data-dialogs` stays `true` across a queue. Current State, the first rule,
  D2's rejected list, and D4 say so.

## P2

### A2 — Slice 1: the terminal notice's OK cannot carry the attribute — fixed in plan

- Plan (Slice 1): "**The terminal notice's OK** carries `data-terminal-notice-ok`".
- Code: the OK is the shared `Button` (`src/lib/Others/TerminalNotice.svelte:55`), which declares a fixed set of
  props and spreads no other attribute onto its native button (`src/lib/UI/GUI/Button.svelte:2`, `:27`). The
  script's selector would find nothing, Escape cannot acknowledge the notice, and the save adapter would stay
  waiting.
- Correction, confirmed: the `<dialog>` carries `data-terminal-notice` and the script clicks its one button. The
  dialog holds a message and exactly one `Button` (`TerminalNotice.svelte:53`); a pointer click calls
  `acknowledgeTerminalNotice` (`:55`), and the component's handlers cancel Escape and some key events only (`:32`,
  `:42`).

## P3

### A3 — Slice 2: `#alert-input` is every input dialog's field — fixed in plan

- Plan (Slice 2, A page load): "A visible `#alert-input` is the password prompt."
- Code: every `input` dialog has that id (`src/lib/Others/AlertComp.svelte:540`); the auth prompts add
  `secret: true` (`src/ts/storage/serverAuth.ts:130`, `:156`), a marker other prompts share. The draft's
  header-less read of `/api/test_auth` answers `incorrect` on any server with a password
  (`server/src/routes/auth.ts:149`, `:224`), so it says nothing about the dialog on screen. A plugin started at boot
  that holds a `sendChat` grant can open another secret input before the page is ready (the Google search client's
  key prompt, `src/ts/process/mcp/googlesearchclient.ts:55`, `:75`), and the script would have typed the server
  password into it.
- Correction, confirmed (Sol's mechanism): the script watches the answer to the app's own `/api/test_auth` request.
  Both auth prompts follow an `unset` or `incorrect` answer directly (`serverAuth.ts:128`, `:154`) and no other path
  opens one; a failed login throws without asking again, and a later check of the same document identifies the next
  prompt (`serverAuth.ts:90`, `:98`). `incorrect` covers any token the server does not accept.

### A4 — Slice 2: the profile folder is not excluded from formatting — fixed in plan

- Plan (Slice 2): "`.gitignore` and `.dockerignore` (`/host-profile/`)."
- Code: `pnpm format:check` runs `prettier --check --cache .` (`package.json:33`), and `.prettierignore` names no
  such folder.
- Correction: `.prettierignore` joins the list.

### A5 — Current State: "never asked again" leaves out explicit reconfirmation — fixed in plan

- Plan (Current State): "A standing grant (Settings → Plugins → the permission list) is never asked again".
- Code: a standing grant exempts the `"periodically"` form (`src/ts/plugins/apiV3/v3.svelte.ts:1101`);
  `reconfirm === true` always asks (`:1108`). No caller passes `true` today.
- Correction: the sentence names the two forms a standing grant covers, and says the cached answers go as soon as
  the tab learns the reset while the plugin's replacement waits for idle work.

### A6 — Current State: one error path of a host send still opens a dialog — fixed in plan

- Plan (Current State): "A send's own errors are not dialogs on a host: they return to the sending device as
  reports."
- Code: the maintenance branch starts `watchForRestore` and, when it sees no new epoch, calls `alertJobError`
  without the report sink (`src/ts/process/serverCommands.ts:1001`).
- Correction: the sentence is limited to admission and terminal errors and names the exception; the dismissal loop
  covers it.

### A7 — Current State: a modal notice holds the UI queue, not every notice — fixed in plan

- Plan (Current State): "`drainUi` awaits its close, so every later notice and question of the tab queues behind
  it."
- Code: only `QUEUED_NOTICES` and questions enter the queue; the other notice kinds go through `applyEffect` at once
  (`src/ts/network/jobChannel.ts:308`, `:1528`, `:1538`).
- Correction: "later queued alert notices and questions".

## Unverified

### A8 — Chrome's own behavior: the User-Agent, the profile, and the browser's end

- Plan (Current State): "whose default is the start of the User-Agent string, `HeadlessChrome...` in a headless
  browser." And (Slice 2, The end): "The browser process is a child of the script and does not outlive it."
- Code: it shows the 64-code-unit User-Agent fallback (`src/ts/network/handoff.ts:59`), the dependency
  (`package.json:117`), the Chrome path (`util/playwright/stack.mjs:13`), and the key pair's IndexedDB store
  (`src/ts/util.ts:1011`). It cannot show the system Chrome's User-Agent, a persistent profile's reuse, the message
  of a held profile, or what is left after each way the script can end.
- In the plan: the User-Agent sentence no longer names a value, and the end is scoped to SIGINT, SIGTERM, and the
  script's own fatal exits, each checked in slice 3 (a killed script is not covered). The claims stay unverified
  until that check and the manual checks run.

## Noted, not recommended

- No TypeScript project includes `util/`, so `util/headlessHostConfig.test.ts` and the two `.mjs` files are collected
  by Vitest and by `pnpm check:tests` but not type-checked (`tsconfig.json:20`, `:33`, `util/testInventory.mjs:29`).
  The plan says so in slice 2.
- The plugin API's `alert` and `alertError` return without waiting for the dialog; `alertConfirm` waits
  (`src/ts/plugins/apiV3/v3.svelte.ts:3585`). Slice 3 reads the dialog's absence, not the call's return.
- `startStack` passes an inherited `RISU_PASSWORD_SHA256` to its server, which seeds a password
  (`util/playwright/stack.mjs:168`, `server/src/routes/auth.ts:142`); slice 3 starts the stack with an empty seed
  and runs the no-password case first, since `restartServer` keeps the save directory (`stack.mjs:209`).
- The lock screen's `data-dialogs` must read `hasDialogs()` under `$alertStore`, as the waiting-dialogs line does
  (`src/lib/Others/RemoteHostScreen.svelte:73`); the method alone is not reactive. The plan says so in slice 1.
- The scheme probe needs a time limit and no certificate verification; it reads the port the browser opens, so a
  dev stack's Vite port is HTTP whatever its server uses. The plan says so in slice 2.
