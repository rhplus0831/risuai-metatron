# RisuNest Small Wins Plan

Status: planned 2026-10-20 at `c7628a0bb`; landed T1 (`86411442f`), P1 (`a293fc574`), K1
(`90882b0cd`), E1 (`9e72646ac`), P2 (`ed9d207c5`), K2 (`f6ac36f7a`), A1 (`96a296e34`).
Source: the RisuNest survey
[docs/research/risunest-ideas.md](../research/risunest-ideas.md) §1 items 1 (alert queue),
2 (safe boot), 3 (plugin quick wins), 4 (unit-test network guard), 5 (CI and image
hygiene) and 17 (engineering rules). RisuNest is read at `/home/codex/RisuNest` (HEAD
`a527b3956`); **RN** paths below are RisuNest's, the others metatron's. Line numbers are
approximate (the survey's own line numbers have drifted already, for example
`bootstrap.ts:119-122` is now `:125-128`); the identifiers are the anchors. Re-verify
each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm --silent test:agent`
(`--tags-filter=slow` where it says so) and the guide's focused checks, updates the owning
guide where it changes a documented contract, and removes the Known Hazard it closes.

## Goal

Six small, independent improvements found in RisuNest, each closing a gap metatron has
documented or recorded:

- Alerts stop overwriting each other: a dialog waits its turn and answers only its own
  caller (closes the `global-api.md` Known Hazard on `waitAlert` pollers).
- A bad plugin or custom CSS can no longer brick every boot: a `?safe=` flag and an
  automatic safe boot after repeated failed boots.
- Plugins: an unread `nativeFetch` body stops holding a `/proxy` upstream; a plugin
  disabled or updated on another device stops running here; a stored non-3.0 plugin is
  reported instead of silently skipped.
- A unit test that reaches the network fails, even when its code caught the error.
- The checks run on every push, not only on agent machines, and the Docker build stops
  carrying test trees and local data.
- The engineering rules that would have caught the recorded stale-mock incidents
  (the storage tests' alert mocks without `alertTerminal`) are written down and checked.

## Invariants

- The `src/ts/alert.ts` helper signatures and return values do not change: every awaited
  helper still resolves with what it resolves with today (`alertConfirm` a boolean,
  `alertSelect` the picked string, `alertChatOptions` a number, `alertCardExport` the parsed
  object). `alertTerminal` and `alertReloadNotice` keep their contracts and stay outside
  `alertStore` (U3, `global-api.md`).
- Safe boot changes nothing on the server and writes no persisted field (D2): it is a
  per-page-load state plus one `localStorage` counter. Nothing it turns off is turned off
  for another tab or device.
- Plugin reloads keep `loadPlugins`'s serialization (`pluginReload` chain) and the
  `clearPluginHooks` reset contract in `plugins-mcp.md`. A reload never interrupts a
  running plugin callback unless decision D4 says so.
- The test network guard changes no product code. `vitest.setup.ts` still imports no
  application code (the happy-dom `nodeName` shim must run before DOMPurify loads).
- V1/V3 hold: the CI runs `pnpm test` (no `slow` tag) with `CI=1`, which
  `util/requireHuman.mjs` already accepts; agents keep using `pnpm --silent test:agent`.
- Slices that touch `src/ts/storage/*`, `src/ts/stores.svelte.ts`, or the boot path
  (`src/ts/bootstrap.ts`, `src/startApp.ts`) wait for branch `heap-memory-reduction` to
  merge into `metatron` (it changes `stores.svelte.ts`, `records.svelte.ts`,
  `resourceSync.svelte.ts`, `characterCards.ts`, `process/modules.ts` and several storage
  tests). Re-read every cited location after that merge.

## Order

(T1, K1, E1, P1 in parallel) → (P2, K2 in parallel) → `heap-memory-reduction` merged
into `metatron` → A1 → E2 → S1.

- **Phase 1, independent of the storage/boot layer**, each in its own worktree. P2 after
  P1 (both edit `plugins.svelte.ts` and `factory.ts`). K2 after T1 and E1, so the first CI
  run already includes the guard and the inventory check, and after decision D1.
- **Phase 2, after `heap-memory-reduction` merges into `metatron`**: A1 → E2 → S1.
  A1 changes the `alertStore` declaration in `stores.svelte.ts` and comes after P2 (both
  edit `jobChannel.ts`); E2 rewrites the alert mocks of `src/ts/storage/tests/*` after
  A1's exports settle; S1 changes `bootstrap.ts` and goes last (it uses A1's queue for its
  notice and P2's reload guard).
- Each slice's `Depends:` line is the authoritative dependency list.
- Several slices add `language.*` keys to `src/lang/en.ts`. Add them next to their
  feature's existing keys so parallel slices rebase cleanly. T1, E1, E2 and K2 all edit
  `docs/structure/build-test-platforms.md`; keep each slice's text in its own paragraph.

## Index

| Source item                                            | Slice  |
| ------------------------------------------------------ | ------ |
| 4. Unit-test network guard                             | T1     |
| 5. `.dockerignore` (test trees, local data)            | K1     |
| 17. Engineering rules, test inventory, alert mock type | E1, E2 |
| 3. Unread `nativeFetch` body expiry, abort on unload   | P1     |
| 3. Stored non-3.0 plugin report                        | P1     |
| 3. Reload after a remote plugin change, once idle      | P2     |
| 5. One CI pipeline                                     | K2     |
| 1. Alert queue                                         | A1     |
| 2. Safe boot                                           | S1     |

## Phase 1

### T1. Unit-test network guard (_small_, `build-test-platforms.md`)

Depends: nothing.

Today `vitest.setup.ts` (83 lines) has no network guard; egress tripwires exist only in the
Playwright stack (`util/playwright/stack.mjs`). A test that reaches a provider, Realm, a
tokenizer CDN or the open internet passes or fails with the network.

- New `vitest.testNetwork.ts` at the root, next to `vitest.lucideImports.ts`, ported from
  RN `tests/support/testNetwork.ts`: a policy that allows `data:` and `blob:` URLs and the
  loopback origins a test registered (`allowTestLoopbackOrigin(origin)`, exact
  `http(s)://127.0.0.1|[::1]|localhost:<port>` origin, returns an unregister function;
  `ws:`/`wss:` checked as their HTTP origin), and refuses everything else, relative URLs
  included. A refusal throws and is also recorded.
- `vitest.setup.ts` (after the `nodeName` shim, which must stay first): assign a guarded
  `globalThis.fetch` and a guarded `WebSocket` subclass directly (not `vi.stubGlobal`, so
  `vi.unstubAllGlobals()` restores the guard, not the raw `fetch`), and, when
  `globalThis.happyDOM?.settings?.fetch` exists, install happy-dom's fetch interceptor
  (`beforeAsyncRequest`/`beforeSyncRequest`), which also covers XHR and iframe/script
  loads. Check the interceptor API against the installed happy-dom (`^20.14.5`) first.
  `afterEach(() => testNetwork.finish())`: a test whose code caught a refused request
  still fails, with the refused URLs in the message. `finish` clears only the recorded
  refusals, not the registered origins (unlike RN): suites start a shared upstream once
  in `beforeAll` and reuse it across tests (`server/src/tests/proxy.test.ts` ~10,
  `auxOps.test.ts` ~197), so a registration lives until its unregister call, which the
  helper makes when the listener closes. A file-level `afterAll` check reports origins
  left registered.
- Server tests (`@vitest-environment node`) that start a real server on loopback register
  its origin: `server/src/tests/testSupport.ts` `startUpstream` (and any helper that
  `listen`s) registers and unregisters it; the files that call `.listen(` themselves
  register theirs (counted at planning time: 17 files under `server/src/tests` call
  `.listen(`, 16 of them test files). Hono `app.request()` tests need nothing. How the server tests import
  the policy is the slice's call: a relative import of the root file may fall outside
  `server/tsconfig.json`; exposing it on `globalThis` from the setup file avoids that.
- Not covered (say so in the guide): `node:http`/`https`/`net`/`tls` sockets opened
  directly (the Lua egress transport, `ws` clients). A `net.Socket.prototype.connect`
  hook is a possible follow-up, not this slice.
- Expect a first run to surface offenders. Fix each by stubbing `fetch` (or the module
  that fetches) or by registering a loopback origin. If more than about ten files fail,
  land the guard with an explicit, commented per-file allow list of the remaining
  offenders and record them under Leftovers; never widen the policy itself.
- Root `vitest.*.ts` files are not type-checked by `pnpm check` (`tsconfig.json` includes
  only `src/`, `shared/`, `public/sw.js`; `tsconfig.node.json` only `vite.config.ts`).
- Test: `vitest.testNetwork.test.ts` (next to `vitest.setup.test.ts`) over the policy:
  `data:`/`blob:` pass; an unregistered loopback port, a relative URL and a public host
  throw; a registered origin passes until unregistered, across `finish` calls; `ws://`
  follows its HTTP origin; `finish` throws after a caught refusal and is clean after a
  clean test. In happy-dom:
  a guarded `fetch` and a `WebSocket` to a public host throw; `vi.unstubAllGlobals()`
  leaves the guard in place.
- Docs: `build-test-platforms.md` `Tests` (the guard, the allow call, the uncovered
  socket types), and `STRUCTURE.md` V2's setup sentence.

### K1. Docker build context and image hygiene (_small_, `self-host-server.md`)

Depends: nothing.

`.dockerignore` holds only `node_modules`, and the builder stage runs `COPY . .`. So the
build context carries the local `save/` (1.7 GB of user data on the main checkout),
`.claude/` (1.9 GB of agent worktrees, whose nested `node_modules` the root-only pattern
does not exclude), `.git`, `dist/`, `test-results/` and `handover/`. The runtime stage then
copies all of `server/` and `shared/`, so `server/src/tests/` (3.8 MB) and `shared/tests/`
(252 KB) plus `shared/*.test.ts` and `shared/**/tests/` ship in the image.

- `.dockerignore`: `**/node_modules`, `.git`, `.claude`, `.idea`, `.vscode`, `save`,
  `dist`, `test-results`, `handover`, `e2e`, `docs`, `server/src/tests`, `**/tests/`
  under `shared/`, `**/*.test.ts`. Before adding a pattern, confirm nothing the build
  (`vite build`, Tailwind's source scan) or the server runtime reads lives under it: no
  product file imports from a `tests/` directory or a `*.test.ts` file (checked once at
  planning time with `rg`; re-check), and `src/**/tests/` must stay out of any product
  import.
- No Dockerfile change unless a pattern above cannot be used; then exclude in the runtime
  `COPY` instead.
- Test: no unit test. `docker build` (Docker smoke recipe in the project memory), then
  in the image: `server/src/tests` and `shared/tests` absent, no `*.test.ts` under
  `/app/server` or `/app/shared`, the server starts and answers `/`; compare the
  build-context size line before and after.
- Docs: `self-host-server.md` `Files` (the `Dockerfile` bullet: what the context
  excludes).

### E1. Engineering rules and the test inventory check (_small_, `build-test-platforms.md` with `STRUCTURE.md`)

Depends: nothing.

From RN `AGENTS.md:23-53` and `tests/suiteOwnership.mjs`/`testInventory.mjs`. metatron's V3
already has determinism and "a plausible wrong implementation would fail it"; it has no
consumer check, no unverified-check rule, no shared mock rule, and the slow-test table in
`build-test-platforms.md` is kept by hand (it already misses the `slow`-tagged
`server/src/tests/importPngCaps.test.ts`).

- `STRUCTURE.md` Verification: add rules (numbering V4+):
  - Before committing, `rg` each changed product export and file name across `src`,
    `server`, `shared`, `util`, `e2e` and `docs`, and update the consumers it finds.
  - A check that could not start, or was not run, is reported as unverified, never as
    passed.
  - A new regression test is shown to fail once with the guarded line broken.
  - Mock only process and I/O boundaries. A module mocked in more than one file gets one
    shared, typed factory (`satisfies` the module's export type) so a new export breaks
    `pnpm check` instead of a run under load.
  - Product code never imports test code (`tests/`, `*.test.ts`, test-only helpers).
    Test-only helpers live in a `tests/` directory so the rule is checkable.
  - A test reads product source through `node:fs`, not a Vite `?raw` import (RN
    `AGENTS.md:40`: a `?raw` import pulls the file into the module graph and coverage
    as text). No metatron test uses `?raw` today; the rule keeps it so.
- New `util/testInventory.mjs` (`pnpm check:tests`, plain Node, no Vitest run, so the
  `requireHuman` gate does not apply): every `*.test.ts` under `src`, `server`, `shared`,
  `util` and the root is matched by `vitest.config.ts`'s include/exclude, every
  `e2e/**/*.spec.ts` by `playwright.config.ts`, and none by both; every `slow` tag
  (`/** @module-tag slow */` or `tags: ["slow"]`) in `server/src/tests` appears in the
  `build-test-platforms.md` slow table and every table row names a tagged test; no
  non-test file under `src`, `server/src`, `shared` imports a `tests/` path or a
  `*.test` module (a file is a test file when it is a `*.test.ts` or lives under a
  `tests/` directory). Exit 1 with the mismatches. Fix the `importPngCaps` table row (or
  record the exception) in the same slice.
- New `src/ts/tests/alertMock.ts` (a `tests/` directory, so the inventory's product
  import check covers it; importable from client and storage tests):
  `createAlertMock()` returns a typed `vi.fn()` for every callable export of
  `src/ts/alert.ts` and correctly shaped values for the others (`alertStore` is an
  object with `set`, `alertGenerationInfoStore` a writable, `terminalNotice` and
  `reloadNotice` readable stores), and the whole result `satisfies typeof
import("src/ts/alert")`, so a missing or reshaped export is a type error. E1 only
  adds it and converts the client test files that mock `alert` outside
  `src/ts/storage/` and outside the files `heap-memory-reduction` changes; E2 converts
  the rest.
- Test: `util/testInventory.test.ts` (node) over a fixture tree: an orphan test file, a
  file matched by both runners, a tagged test missing from the table, a table row with
  no tag, and a product import of a test file each fail; a clean tree passes.
- Docs: `build-test-platforms.md` `Test rules` (the factory, the inventory command),
  `Recipes` "Add a slow test" (run `pnpm check:tests`).

### P1. Unread body expiry, abort on unload, non-3.0 plugin report (_small_, `plugins-mcp.md`)

Depends: nothing.

- Unread body expiry. `SandboxHost.replaceStreamsWithPorts`
  (`src/ts/plugins/apiV3/factory.ts` ~624) bridges every host `ReadableStream` sent to a
  plugin (a `nativeFetch` `Response` body through `serialize`, ~512) with a reader that
  stays open until the plugin pulls or cancels. An unread body keeps the host fetch and
  its server `/proxy` upstream open until the plugin unloads. Port RN `factory.ts:611`,
  `:898-950`: `UNREAD_PLUGIN_STREAM_TIMEOUT_MS = 60_000`; a timer per bridged stream,
  cleared by its first `pull` or by `finish`; on expiry post
  `{ done: true, error: "Unread plugin response expired" }` and run the stream's cleanup
  (`reader.cancel()`). This only works with RN's guest-side change too: the guest's
  `reconstruct` (`GUEST_BRIDGE_SCRIPT`, `factory.ts` ~215) builds its `ReadableStream`
  with the default queuing strategy, which calls `pull()` at once with no consumer, so
  the first pull would clear the timer of every body. Give it `{ highWaterMark: 0 }`
  (RN `factory.ts:345`), so a pull means the plugin reads.
- Abort on unload (the recorded "SandboxHost terminate late stream" defect).
  `terminate` (~951) only `abortControllers.clear()`s: it must `abort()` each host
  controller first, and the `CALL` handler's continuation after its `await` (~848) must
  check a `terminated` flag so a host call resolving after `terminate` builds no stream
  bridge. Keep each stream's cleanup reachable if a later `getReader()` throws in the
  same `replaceStreamsWithPorts` call.
- Non-3.0 report. `loadPlugins` (`src/ts/plugins/plugins.svelte.ts` ~377) filters
  `p.enabled && p.version === "3.0"` and drops the rest silently; `shared/plugins.ts`
  types `version?: "3.0"`, but records from an upstream backup can carry `"2.0"`, `"2.1"`
  or no version. Report each enabled non-3.0 plugin once per page load per identity
  (name, version, script hash; RN `plugins.svelte.ts:495-523`) with one `alertError`
  listing them (console only during a hot reload), and show an "unsupported API" badge on
  its row in `src/lib/Setting/Pages/PluginSettings.svelte` (RN
  `PluginSettings.svelte:66-72,150-158`). Frequency: decision D5.
- Test: in `src/ts/plugins/apiV3/` over `SandboxHost` (as `nativeFetchAbort.test.ts`
  drives it), fake timers: an unpulled `Response` body is cancelled at 60 s and the
  plugin side reads the expiry error; one pull before 60 s keeps it. That test simulates
  the guest, so it cannot catch the guest's automatic pull: add one that runs the real
  `reconstruct` from `GUEST_BRIDGE_SCRIPT` (evaluated over a `MessageChannel`) and checks
  that an unread reconstructed body sends no `pull`. `terminate` aborts
  an in-flight host fetch's signal; a host call resolving after `terminate` creates no
  port. In `plugins.svelte.ts`'s tests: two loads with the same v2.1 plugin report once;
  a changed script reports again; 3.0 plugins are never reported.
- Docs: `plugins.md` (the public plugin guide: the 60 s expiry), `plugins-mcp.md`
  `Flows`/`Known Hazards` (remove the terminate entry if listed there).

### P2. Reload after a remote plugin change, once idle (_hard_, `plugins-mcp.md`)

Depends: P1.

A live update of `plugins` only runs `applyRaw` (`src/ts/storage/resourceSync.svelte.ts`
`applyToMirror` ~2833), so a plugin disabled, removed or updated on another device keeps
running in this tab until a reload. Every tab of every device shares one list here, so
this matters more than on RisuNest.

- No storage file changes. `onRemoteRecordApplied` (`resourceSync.svelte.ts` ~387) already
  calls its listeners for a live whole record, a live patch, and a conflict reload
  (`notifyRemoteListeners`, ~3132, ~3331, ~3425, ~2258). `plugins.svelte.ts` registers one
  listener (once, at the first `loadPlugins`); on `kind === "plugins"` it compares the
  load signature of what is loaded (each enabled 3.0 plugin's name, script, version, and
  whatever else `loadV3Plugins` reads at load time) with the new list, and requests a
  reload only when they differ. This tab's own toggle (`PluginSettings.svelte` already
  calls `loadPlugins`) then finds nothing to do.
- Idle wait, after RN `createDeferredPluginReload` (`plugins.svelte.ts:464-492`,
  `pluginCompatibility.ts:75-110`), adapted. Checking only outstanding callbacks is not
  enough: a job captures its hook inventory when it is created
  (`src/ts/network/generationJobs.ts` `createGenerationJob` ~194) and the server calls
  its output hooks later (`server/src/prompt/runner.ts` ~1366), so a reload between two
  callbacks makes the later one fail as an unregistered hook (`jobChannel.ts` ~494). Idle
  therefore means all of:
  - no live job of this tab. `jobChannel.ts` `transports` is not enough: an entry is
    added only at the job's first channel event (`handleChannelEvent` ~949), after
    `createGenerationJob` captured the hooks and awaited the POST, and non-send jobs
    (`process/serverCommands.ts` ~396) have no `doingChat` guard. So each job holds a
    plugin activity lease: taken in `createGenerationJob` before `registeredHooks` (also
    when the caller passes its own `hooks`), and in `followGenerationJob` for a resumed
    job; released when its channel ends (`endJobChannel`), by `releaseGenerationJob`,
    or when the creation fails or is refused. `doingChat` stays a second condition (it
    spans a send, `process/index.svelte.ts` ~40-57);
  - no outstanding channel callback (`outstanding`);
  - no `SandboxHost` with a pending guest callback (`pendingCallbacks`), a guest-to-host
    call still awaiting (a `nativeFetch` waiting for headers is in neither set today:
    the `CALL` handler awaits it directly, `factory.ts` ~864), an open bridged stream, or
    a guest that has not finished starting.
    Each source publishes a change notification (`jobChannel.ts` when a job channel ends
    or a callback settles; `factory.ts` per host, collected through the instance registry
    in `v3.svelte.ts` ~2268; `doingChat`'s store), and the reload checks idleness again
    inside the serialized `pluginReload` chain before it clears anything. One pending
    reload at a time; a second remote change while waiting just updates the target list.
    Whether to interrupt after a wait limit: decision D4 (default: never; RN's interrupt
    path also refuses while `doingChat` is true).
- A user's local `loadPlugins` while a deferred reload waits supersedes it.
- Test (`src/ts/plugins/`): a remote `plugins` change that disables a loaded plugin
  reloads once with the new list; a change to a disabled plugin or a non-3.0 plugin's
  fields only does nothing; a change while a channel callback is outstanding waits and
  reloads when it settles; a change while a job is live but between callbacks waits
  until its channel ends; a change while a non-send job's creation POST is still
  pending, or before its first channel event, waits for the job; a change while a guest `nativeFetch` awaits headers waits for
  it; two changes while waiting reload once with the newest list;
  a local `loadPlugins` cancels the deferred one.
- Docs: `plugins-mcp.md` `Flows` (the deferred reload, the idle definition).

### K2. One CI pipeline (_small_, `build-test-platforms.md`)

Depends: T1, E1, and decision D1.

There is no CI directory (`.github/`, `.gitea/`, `.forgejo/` are absent); V1's gates run
only on agent machines. The remote is the self-hosted forge named by `git remote -v`;
which forge software runs there, and whether it has Actions runners, is not confirmed.

- One script, two possible triggers. New `util/ci/check.sh` (or `.mjs`): Node 24 and
  `corepack` pnpm 10.34.1, `pnpm install --frozen-lockfile`, `pnpm check`,
  `pnpm format:check`, `pnpm check:tests` (E1), `CI=1 pnpm test`, `pnpm build`. Exit
  non-zero on the first failure; print each step's duration.
- Trigger, decision D1:
  - **Forgejo/Gitea Actions**: one workflow on push and pull request, running the script
    on a `node:24` container. Forgejo reads `.forgejo/workflows/`, Gitea `.gitea/workflows/`
    (both are said to fall back to `.github/workflows/`; not verified). Pin third-party
    actions by commit SHA and check out with `persist-credentials: false` (RN
    `.github/workflows/pr-check.yml`). Needs a registered runner with Docker or a host
    executor.
  - **Server-side hook**: a `post-receive` hook on the forge host that checks the pushed
    `metatron` (and `main`) head out into a scratch worktree under a lock, runs the
    script, and reports through the forge's commit-status API (or a log the user reads).
    Not `pre-receive`: the suite takes minutes (not measured) and would block every push.
    The hook file lives in the repository (`util/ci/post-receive`) with install notes;
    installing it on the host is the user's step.
- `pnpm test:e2e` is not in the gate (it needs Playwright browsers and the shared stack);
  a separate manual or nightly job is decision D2.
- Before enabling: one local run of the script from a clean clone, recorded in the
  slice's commit message with its durations. A red first run (for example
  `format:check`) is fixed or recorded, not silenced.
- No secrets: the script needs no credentials, and the runner must not mount `save/`.
- Test: none (a script); the clean-clone run is the check.
- Docs: `build-test-platforms.md` (what CI runs, where the script is, the trigger chosen).

## Phase 2: after `heap-memory-reduction` merges

### A1. Alert queue (_hard_, `global-api.md`)

Depends: the `heap-memory-reduction` merge into `metatron` (decision D3), P2.

`alertStore` (`src/ts/stores.svelte.ts` ~76) is one plain `writable`. Every helper in
`src/ts/alert.ts` sets it, and the awaited ones (`alertConfirm`, `alertInput`,
`alertSelect`, `alertSelectChar`, `alertCardExport`, `alertAddCharacter`,
`alertChatOptions`, `alertPluginConfirm`, `alertNormalWait`, `alertErrorWait`;
`alertModuleSelect` with its own 20 ms loop) poll it every 10 ms (`waitAlert`) until it
reads `none`, then read the answer from `msg`. Any later `set` replaces a dialog that is
still waiting (a progress `wait`, a toast, another job's notice), and a held Enter can
answer a dialog that just appeared. `global-api.md` Known Hazards records the job-question
case ("cancellations can stack pollers").

- New `src/ts/alertQueue.ts`, ported from RN `src/ts/alertQueue.ts` (126 lines,
  `createAlertQueue`) with its tests: a `Readable<alertData>` showing one alert at a time.
  `wait`, `progress` and `toast` share one status slot (the newest replaces it); every
  other type is a FIFO dialog that resolves only its own caller; `set({ type: "none",
msg })` closes the visible dialog with `msg`; an identical repeated `normal`, `error`,
  `markdown` or `wait2` folds into the one queued (never an `error` with a `jobFailure`:
  RN's `sameNotice` ignores it, and two job failures with the same message carry
  different debug data, `alert.ts` `alertJobError`, `AlertComp.svelte` ~297); the next
  dialog appears 150 ms after the
  previous closes (`NEXT_DIALOG_GAP_MS`, injectable for tests); a dialog clears the status
  set before it (as today, where it replaces it).
- `stores.svelte.ts`: `alertStore` becomes the queue (same name, `subscribe` and `set`),
  so `$alertStore` in `App.svelte`/`AlertComp.svelte` keeps working. The direct
  `alertStore.set(...)` writers (`characterCards.ts`, `characters.ts`, `persona.ts`,
  `process/modules.ts`, `processzip.ts`, `drive/backuplocal.ts`, `RequestLogsPopup.svelte`,
  `SideChatList.svelte` ~701 (`branches`), `hotkey.ts`, and `AlertComp.svelte`'s own
  answer writes) do not all keep working by type routing alone: a status writer that
  ends its status with `set({ type: "none" })` after an await would answer whatever
  dialog appeared meanwhile (`characters.ts` `makeGroupImage` ~694/~760, the Realm import
  in `characterCards.ts` ~1995). Audit every `type: "none"` write: a status completion
  becomes `alertClear()` (status only); a dialog's own close (AlertComp's buttons,
  `RequestLogsPopup`, the branches view) answers the visible dialog through an explicit
  call. The toast's end (`AlertComp.svelte` ~931, `onanimationend`) is a status: it
  clears the status slot only, and only while that same toast is still the status. `set({ type: "none" })` stays only as that dialog close, for
  compatibility.
- `alert.ts`: the awaited helpers open a dialog and await its own answer, with the same
  parsing as today; `waitAlert` waits until no dialog is visible or queued; `doingAlert`
  is "a dialog is visible"; `alertClear` clears the status slot. Add one internal export
  that returns a dialog's answer promise and a `cancel()` that removes it whether visible
  or queued, for `jobChannel.ts`.
- `jobChannel.ts` (`drainUi` ~333, `cancelShowing` ~388): keep its UI queue, one
  module-global queue for every job (`uiQueue` ~133, `enqueueUi` ~400), which orders all
  jobs' notices and questions across jobs and answers through each job's socket; keep that
  cross-job order. Await each
  modal notice's own dialog instead of `waitAlert`, and cancel a question through its
  handle instead of comparing `get(alertState)` and calling `alertClear`. Notices must
  not be queued twice (the channel queue and the alert queue). The "toasts too: a toast
  would replace the question" rationale in the module comment goes.
- `hotkey.ts` (~265-292): Escape today replaces the dialog with an "Alert Closed" toast
  and the waiting helper reads `""` after the toast's animation; Enter sets `none`/`yes`
  for `ask`, `normal` and `error`. Under the queue, Escape closes the visible dialog with
  `""` and then shows the toast; Enter closes it with `"yes"`. Neither may answer a
  dialog during the 150 ms gap. The gap alone does not stop a held Enter: the handler
  answers every keydown (`hotkey.ts` ~283) and auto-repeat outlasts 150 ms. Ignore
  `ev.repeat`; when Enter was already held as a dialog appeared, that dialog takes Enter
  only after the key's release. A dialog shown with no key held takes the first
  non-repeated Enter keydown, as today.
- `alertRequestData` (`alert.ts` ~365) writes the shared `alertGenerationInfoStore`
  before opening its dialog, and `AlertComp.svelte` (~451-600) renders from that store
  while it looks the log up by the dialog's own `msg`. Two queued request-data dialogs
  would show the second's data under the first's id. Carry the generation info (with a
  stable chat id and message id) in the dialog's own `alertData` and render from it;
  remove the side store or keep it only as a derived view of the head.
- Not changed: `alertTerminal`, `alertReloadNotice` (outside `alertStore`).
- Callers that check what is showing: `ModuleSettings.svelte` `clearStaleExportWait`
  (`get(alertStore).type` is `wait`/`progress`) reads the head; check it still clears
  only its own stale wait. `Chat.svelte` ~1337 calls `alertClear` in a clipboard
  fallback; check what it means to clear there.
- Test mocks: about ten test files mock `stores.svelte`'s `alertStore` as a `writable`
  or `{ set: vi.fn() }` while running the real `alert.ts` (`modulesImport.test.ts`,
  `characterCardsRealmImport.test.ts`, `characterCardsPngImport.test.ts`,
  `exportBatches.test.ts`, `charactersImportChat.test.ts`, `alertTerminal.test.ts`,
  `ModuleSettings.share.test.ts`, ...). List them first, then either keep `alert.ts`'s
  use of the store within `set`/`subscribe` plus one queue entry point those mocks can
  get from a shared test helper, or update the mocks to the real queue. Updated tests
  must still assert what they asserted.
- Test: `src/ts/alertQueue.test.ts` (fake timers): two confirms in a row each get their
  own answer in order; a `wait` and then a `progress` replace each other while a dialog
  waits; a toast never hides a waiting dialog; an Enter during the gap answers nothing,
  a repeated Enter after the gap (no keyup) answers nothing either, and a first Enter
  on a dialog shown with no key held answers it; identical
  notices fold, different ones and two `jobFailure` errors do not; `cancel()` of a
  queued dialog removes it without showing it; a status writer's `alertClear()` while a
  confirm is visible leaves the confirm unanswered; two queued `alertRequestData` dialogs
  each show their own generation info. `src/ts/network/jobChannel` tests: a cancelled question whose
  alert sits behind a local dialog resolves nothing and leaves no waiter; a local alert
  shown during a job question does not replace it.
- Browser check (`util/playwright`): two `alertConfirm`s queued from the console, the
  first answered with Enter held; an import's progress then its result alert; an Escape.
- Docs: `global-api.md` (the alert protocol paragraph, the Known Hazard removed),
  `STRUCTURE.md` U3 if the wording changes.

### E2. Alert mocks through the shared factory (_small_, `build-test-platforms.md`)

Depends: E1, A1.

80 test files mock `alert` with `vi.mock(..., () => ({ ... }))` listing a few helpers.
`src/ts/storage/tests/resourceSync*.test.ts` lack `alertTerminal`; under heavy load a
stale module graph reaches it and the run fails with an unhandled error that is not the
test's (recorded in the project memory, "Storage test alert mock gap").

- Convert every remaining `vi.mock` of `alert` (after E1's share and A1's new exports) to
  `createAlertMock()`, taking handles with `vi.mocked(...)`. Mechanical; keep each
  file's assertions.
- Test: `pnpm check` (a missing export is now a type error); the storage suites with
  `--tags-filter=slow` as well.
- Docs: none beyond E1's rule, unless the factory's path changed.

### S1. Safe boot (_hard_, `app-shell.md` with `plugins-mcp.md`)

Depends: the `heap-memory-reduction` merge into `metatron`, A1, P2.

Boot errors only `alertError` (`bootstrap.ts` `loadData` catch, ~156); a failed
`loadPlugins` is swallowed (`try { await loadPlugins(); } catch {}`, ~125-128).
`SafeModeStore` (`stores.svelte.ts` ~74) turns custom CSS off through a hotkey
(`hotkey.ts` ~121, read by `gui/colorscheme.ts` `updateTextThemeAndCSS` ~370) and is not
kept across reloads; it does not gate `settings.ui.guiHTML` (`Chat.svelte` ~1887). A
plugin with main-document access or a broken custom CSS/GUI HTML can make every boot
unusable; today the only way out is editing data on the server.

- New `src/ts/safeBoot.ts` (outside `src/ts/storage/`): reads `?safe=` once at the start
  of `loadData`, before anything navigates (the router writes `pathname` only, so the
  query is gone after the first navigation). Categories: `plugins` and `css` (custom
  CSS and GUI HTML); `?safe` or `?safe=all` means both. Unknown names are ignored.
- Failure counter in `localStorage` (one key, for example `risu.safeBoot.attempts`, a
  count and a timestamp, read and written in `try`): incremented when the boot reaches
  the point where user content first runs (just before `updateTextThemeAndCSS` and
  `loadPlugins`), so a server that is unreachable before that does not count; cleared
  once the boot settled. Settled is not just `loadedStore`: today a rejected
  `loadPlugins()` is swallowed and `loadedStore` is still set (`bootstrap.ts` ~126-133),
  and each guest's start is launched without being awaited (`v3.svelte.ts` ~2305,
  `factory.ts` `run` ~935). So the attempt carries a failure latch: a rejected
  `loadPlugins`, the `loadData` catch, or a guest that fails or does not report ready
  within the settle window marks it failed, and a failed attempt is never cleared by the
  timer. Settled = no latch, `loadedStore` true, every enabled guest started, and the
  page alive for the settle window (decision D6). At the threshold (D6, default 2
  consecutive unsettled boots), the next boot runs with both categories off and says why.
- Effects for this page load only: `plugins` off → `loadPlugins` loads nothing (and P2's
  deferred reload and `PluginSettings.svelte`'s toggle reload respect it: a toggle saves
  but does not load); `css` off → `SafeModeStore` set before `updateTextThemeAndCSS`,
  and GUI HTML not rendered while it is set. The hotkey toggle keeps working.
- Notice: one dialog (through A1's queue) naming what is off and how to leave ("reload
  without `?safe`"); the boot's error alert gains a line with the safe-boot link.
- Not covered: modules, global regex and Lua run on the server per job; turning them off
  needs a flag in the job request (a later plan, see Leftovers).
- Test: `src/ts/safeBoot.test.ts`: the flag parse (`?safe`, `=all`, `=plugins`, a list,
  unknown names); the counter increments only at the content stage, clears when settled,
  and trips at the threshold; a rejected `loadPlugins` or a guest that never reports
  ready keeps the attempt counted even after the settle window; `localStorage` throwing leaves a normal boot. `plugins`
  off: `loadPlugins` loads nothing and a deferred reload does not run.
- Browser check: `?safe=plugins,css` with a plugin and custom CSS set; two boots killed
  after the content stage, then a third that comes up safe with the notice; a normal
  reload afterwards restores both.
- Docs: `app-shell.md` (boot sequence, the flag, the counter), `plugins-mcp.md`
  (plugins off for this page load).

## Verification

- Every slice: its tests, `pnpm check`, `pnpm --silent test:agent`, and the guide's
  focused checks. T1 and E2 also `--all` (the guard and the mocks reach every suite).
- K1 and K2: `pnpm build`; K1 a real `docker build` and the image listing; K2 one
  script run from a clean clone, recorded with durations.
- A1 and S1: the browser checks above (`util/playwright`, one dev stack at a time).
- After the last slice: archive this plan as `docs/archived-plan/README.md` describes,
  with each slice's commit and the decisions taken.

## Decisions for the user

- **D1. CI trigger.** A Forgejo/Gitea Actions workflow or a server-side `post-receive`
  hook (K2). Depends on what software the forge runs and whether a runner can be
  registered. `GET <forge>/api/v1/version` answers on both Gitea and
  Forgejo; `GET /api/forgejo/v1/version` answers only on Forgejo. Default: Actions
  workflow if a runner exists, else the hook.
- **D2. CI scope.** Default: `check`, `format:check`, `check:tests`, `test` (no `slow`),
  `build` on every push; `test:e2e` and the slow tier not in CI. Alternatives: a nightly
  or manual job for `test:slow` and `test:e2e`.
- **D3. A1 before the merge?** A1 edits one declaration in `stores.svelte.ts` (~76),
  about 30 lines above the heap branch's `createSimpleCharacter` hunk, so a textual merge
  would be clean. Default: follow the ordering rule and wait.
- **D4. P2 wait limit.** RN reloads after 60 s even if plugin work is still running,
  unless a send is in progress (its `canInterrupt` refuses while `doingChat` is true,
  RN `pluginCompatibility.ts:100`, `v3.svelte.ts:1771`); the interrupted work rejects
  ("The plugin was unloaded"). Default here: never interrupt; wait for idle. If a limit
  is wanted, keep RN's `doingChat` refusal and add "no live job of this tab".
- **D5. P1 report frequency.** Default: once per page load per plugin identity (RN). An
  alternative: once per browser, with a `localStorage` acknowledgement.
- **D6. S1 thresholds.** Default: two consecutive unsettled boots trip safe boot; a boot
  is settled when no failure was latched, `loadedStore` is true, every enabled guest
  started, and the page has been up 10 s. A user who reloads twice within 10 s of
  loading would also trip it once.
- **D7. T1 loopback rule.** Default: exact registered origins (RN). Alternative: allow
  any loopback port in `node`-environment files, which needs no per-file registration
  but lets a test reach another local service by accident.

## Not in this plan

- The survey's other items (staged backup import, asset garbage collection, snapshot
  management, persisted reroll candidates, device management) and RN's production bundle
  check (`tests/productionBundle.mjs`), which is optional per the survey.
- RN's recovery shell, boot stage trail, and "keep these off" prompt
  (`bootAttempt.ts`, `recoveryMode.svelte.ts`, `recoveryExclusionPrompt.ts`): S1 is the
  client-only part.
- The recorded plugin defects other than the terminate one (guest provider abort mirror,
  terminal notice keyup).

## Leftovers

Known before any slice runs:

- Safe boot cannot turn off modules, global regex or Lua (server-side per job).
- T1 does not guard raw Node sockets.
- `util/playwright/*.mjs` stays outside type checking (survey item 17).

Each slice appends what it left here.
