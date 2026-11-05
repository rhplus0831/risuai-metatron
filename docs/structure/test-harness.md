# Test Harness

## Scope

- Owns the `test:agent` wrapper, its reporter, the human gate, the overload runner, the Vitest config and setup, the
  test inventory (`check:tests`), the Playwright config, the `e2e/` harness, the `util/playwright/` scripts, and the
  rules every test follows: test rules, mock factories, the network guard, timeouts, the slow-test table.
- Paths:
  - `vitest.config.ts`, `vitest.setup.ts`, `vitest.lucideImports.ts`, `vitest.testNetwork.ts`, their `*.test.ts` files,
    `playwright.config.ts`
  - `util/agentTest.mjs`, `util/agentTestReporter.ts`, `util/agentTestResults.mjs` (the `test:agent` wrapper, its
    reporter, and their shared summary line and rerun of failed files), `util/agentE2e.mjs` (which specs
    `test:agent --e2e` selects), `util/requireHuman.mjs` (the human gate), `util/overloadTest.mjs` (`test:overload`)
  - `util/testInventory.mjs` (`check:tests`)
  - `util/playwright/` (browser automation helpers and capture scripts), `e2e/` (Playwright specs)
- Not here:
  - Build scripts, Vite, TypeScript, CI, the `dev:agent` runner, and the service worker's harness →
    [build-test-platforms](build-test-platforms.md).
  - A domain's focused tests and browser gaps → the guide for the code under test.

## Files

Read the module headers and the comments on the identifiers below: they have each script's usage, behavior, and exit
codes; the entries name the role and the identifiers to look up.

### Test wrapper and reporter

- `util/agentTest.mjs`: the `test:agent` wrapper (`pnpm test` for agents, `--e2e` for the specs); the cache, the held
  stderr, the rerun, and the locks (`GATE_LOCK_PORT`, `E2E_LOCK_PORT`, `MAX_RERUN_FILES`, `FLAKY_LOG`).
- `util/agentTestReporter.ts` `AgentTestReporter`: the Vitest reporter the wrapper installs: failures only, one summary
  line, the `SLOW` warning (`MAX_SLOW_TESTS`), the caps (`MAX_FRAMES`, `MAX_LOG_LINES`, ...).
- `util/agentTestResults.mjs`: what the reporter and the wrapper share: `summaryLine`
  (`OK <n> passed, <n> skipped (<files>, <s>s)` or `FAIL <n> failed, <n> passed, ... (<k> of <files> failed, <s>s)`),
  `RESULTS_FILE_ENV`, `planRerun`, `mergeRerun`, `withoutFilters`.
- `util/agentE2e.mjs`: which specs a change reaches (`selectSpecs`, `EVERY_SPEC_FILES`, `reachesBrowser`).
- `util/overloadTest.mjs`: `test:overload`, the gated tests under the reference overload (one CPU, eight burners).

### Human gate

- `util/requireHuman.mjs` `requireHuman(command)`: the gate of `pnpm test`, `test:slow`, `test:all`, `test:e2e`, and a
  direct `vitest` run, open when `CI`, `HUMAN`, or `AGENT_TEST` is set. `vitest.config.ts` calls it at load, so an
  editor's Vitest extension needs `HUMAN` in its environment.
- Agents use the wrapper and do not set `HUMAN` or `AGENT_TEST` themselves to bypass this convention.

### Vitest config and setup

- `vitest.config.ts`: the gate's config (`happy-dom` with `enableIframePageLoading`, the Svelte plugin with
  `configFile: false`, the setup file, excludes, timeouts, the `slow` tag); its comments give the reasons.
- `vitest.lucideImports.ts` `lucideImports`: the test-only rewrite of `@lucide/svelte` barrel imports.
- `vitest.setup.ts`: mocks KaTeX, sets `globalThis.safeStructuredClone` to a JSON clone, installs happy-dom's
  `Node.prototype.nodeName` shim (without it DOMPurify mis-sanitizes under happy-dom), and installs the
  [network guard](#network-guard) through `vitest.testNetwork.ts` (`allowTestLoopbackOrigin`, `classifyTestRequest`).

### Test inventory

- `pnpm check:tests` (`util/testInventory.mjs`, plain Node: no test run, so no human gate): runner patterns, the
  [slow-test table](#slow-test-table) against the tags (`readSlowTable`, `checkSlowTable`), and test imports from
  product code. Run it after adding, moving, or tagging a test; teach the script a config shape before using one.

### Browser stack

- Plain `playwright-core` scripts in `util/playwright/` for captures and one-off observations, `@playwright/test` specs
  in `e2e/` for repeatable checks. `playwright.config.ts`, `e2e/`, and `util/playwright/` are outside `tsconfig.json`'s
  include, so `pnpm check` does not type-check them.
- `playwright.config.ts`: one worker, the system Chrome (`RISU_CHROME`), `globalSetup` `util/playwright/globalSetup.mjs`
  (one stack per run on `E2E_SERVER_PORT`/`E2E_VITE_PORT`).
- `e2e/fixtures.ts`: the specs' `test` (clears safe boot's counter per page load), `expect`, and `settle` (waits for
  `resourceSyncIdle`).
- `util/playwright/stack.mjs`: `startStack` (server in a temporary working directory plus Vite, `restartServer` with an
  optional server environment; `deniedEgress` lists what the server's `fetch` tripwire refused, and a
  `serverEnv.NODE_OPTIONS` of the check's own replaces that tripwire), `isolateContext`, `unexpectedEgress`, `openApp`,
  `openCharacterChat`, `clearSafeBootAttempts(contextOrPage)`, `pluginFixtureOp` (a v3 plugin installed by seed).
- `util/playwright/offline.sh` (prefix a check's command): a check with loopback only (`unshare -rn`), the boundary that
  keeps the stack, the browser, and the mocks off public services.
- `util/playwright/modelProfiles.mjs` and `util/playwright/modelProfiles.browser.mjs`: model and chat-binding fixtures
  for a mock provider ([Recipes](#recipes)).
- Page code reaches app modules with `await import("/src/...")`, the module instance the app uses (dev stack only); a
  two-client check opens a second browser context (tabs of one context share `localStorage`).

### Check and measurement scripts

None is in the gate; all are in `util/playwright/`.

- Against the dev stack: `checkLiveUpdates.mjs`, `checkCredentialTraffic.mjs`, `checkLlmTransport.mjs`,
  `checkStreamingModes.mjs`, `checkServerTransform.mjs`, `checkMcpFixes.mjs`, `checkDurableDrafts.mjs`,
  `checkAssetLifecycle.mjs` (the asset sweep, through the development clock offset), `checkSidebarChatStatus.mjs`,
  `checkBootCache.mjs`, and, with real v3 plugins under `offline.sh`, `checkJobProtocol.mjs` (a plugin provider) and
  `checkJobHandoff.mjs` (two tabs hand a job off).
- `measurePluginData.mjs`: dev-stack database reads, storage/toggle write bytes, unchanged `getDatabase` → `setDatabase`
  setter costs, then the developer recorder check.
- Against a running production server, normally the Docker image on a fresh volume (`--base`, `--password`,
  `--provider-host`): `checkRecordsSmoke.mjs`, `checkLazyChatsSmoke.mjs`, `checkTwoClientSmoke.mjs`,
  `checkServerSend.mjs`, `checkServerButton.mjs`, `checkServerTrigger.mjs`, `checkServerJobMatrix.mjs`; the last four
  start a dev stack without `--base`.
- Measurements of a production build in headless Chrome: `measureRecords.mjs`, `measureCharacters.mjs`,
  `measureChats.mjs`, `measureHeap.mjs`, `measureBoot.mjs` (also the fixture builder
  `buildBootFixture`/`seedBootFixture`), and `measureFileSources.mjs`. `measureTransformLua.mjs` runs the server in
  process; `probeDirectAssets.mjs` probes the direct asset mechanics on its own server, not the app.
- `measureRenderWork.mjs` (dev stack, under `offline.sh`, Linux): render work of a styled, auto-translated chat when it
  opens and after a switch away, its mount trace, its screenshot's peak memory
  ([results](../audit/render-work-budget-2026-11-05.md)).
- Call counts by name: CDP `Profiler.startPreciseCoverage({ callCount: true, detailed: true })` before navigation,
  `takePreciseCoverage` (it resets) per phase; a function's first range is its call count (without `detailed`, also each
  `await` resumption). Time an uninstrumented run.
- Peak memory: `VmHWM` in `/proc/<pid>/status`, reset by writing `5` to `clear_refs`; pids from browser CDP
  `SystemInfo.getProcessInfo`.

### Fixtures

- `util/playwright/captureBootFixtures.mjs`: captures the first-boot snapshot and preset fixtures in
  `src/ts/storage/tests/fixtures/boot/` (see its README).
- Frozen browser references: the per-family token ids in `server/src/tests/fixtures/tokens/browser-ids.json` and the
  browser-path fixtures in `server/src/tests/fixtures/baseline/` (preview prompts, `ParseMarkdown` HTML, `encode`
  routing, lore regex, the `igp` send). No capture harness exists: the tab exports no `encode`, and
  `encodeWithTokenizer` gets ids from the server, so neither can capture independent browser expectations. The fixture
  READMEs hold the capture conditions and provenance.

## Flows

### Test wrapper

`pnpm --silent test:agent [--force] [--verbose] [--all] [--slow-tests[=<ms>]] [--no-rerun] [--no-lock] [vitest args]` is
`pnpm test` for agents, and the only entry point that runs tests without `CI` or `HUMAN` (`--tags-filter=slow` is
`pnpm test:slow`). Across processes:

1. The wrapper keys the cache by the working tree's `git write-tree`, versions, and arguments; a hit replays the stored
   output before any lock.
2. A whole-suite run (no file filter) takes the machine-wide lock, so whole-suite runs from every checkout and worktree
   queue instead of sharing the CPUs; queued runs finish one after another in the single run's time
   ([timings](../audit/test-suite-lock-2026-10-30.md)).
3. The Vitest child (`AGENT_TEST=1`) runs with the reporter, which holds its output and writes per-file results to the
   file `RISU_REPORT_RESULTS_FILE` names.
4. When at most `MAX_RERUN_FILES` files failed and no error was unhandled, the wrapper reruns each alone with the file
   filters removed (`parseCLI` from `vitest/node`), then merges the results: a file that passes alone is `FLAKY` and
   logged to `flaky.jsonl`.

### Browser specs

`pnpm --silent test:agent --e2e [<spec>...] [--all] [--e2e-since=<rev>] [--force] [--verbose] [playwright args]`: the
Playwright specs for agents (`pnpm test:e2e` is for people; Playwright arguments such as `-g <grep>` pass through),
through `node_modules/@playwright/test/cli.js test --reporter=dot` with the same held stderr and cache. Run the specs
the change reaches, not the whole set.

- The wrapper asks `util/agentE2e.mjs` which specs the changed files reach; when none, it lists the specs and exits with
  2, so the agent names the specs that cover the behavior it changed.
- Selection is by name, not coverage: a component no spec names (a chat screen file, say) selects nothing even when a
  spec drives it.
- One e2e run at a time per machine: the run holds the e2e lock port, then waits for the stack's ports, and Playwright's
  `globalSetup` starts the stack.
- It still shares Vite's `node_modules/.vite` with any other dev stack of the checkout (`pnpm dev:human`, a
  `util/playwright/` check), so do not run it beside one.

### Overload runner

`pnpm --silent test:overload [--runs N] [--cpu N] [--testTimeout MS] [files or vitest args]` runs each run as a
supervisor in its own process group: it starts the burners and `util/agentTest.mjs --force --no-rerun --no-lock` pinned
to one CPU and reports over IPC, and the runner kills the whole group after each run. The gate's own timeout is the one
to check against, so `--testTimeout` is forwarded only when given; investigate each failure. `taskset` comes from
util-linux.

## State

- `node_modules/.cache/agent-test/<args hash>.json`: the wrapper's stored result.
- `node_modules/.cache/agent-test/flaky.jsonl`: one JSON line per flaky test (time, tree, arguments, name, message).
- Lock ports, held by listening: 6198 for whole-suite runs, 6199 for e2e runs.
- Stack ports: the e2e stack is fixed at server 6101, Vite 5201 (`util/playwright/globalSetup.mjs`). A check's default
  ports are in the script.
- The stack's working directory is temporary, so its `save/` lives as long as the run.

## Coupling

- `util/testInventory.mjs` `SLOW_TABLE_DOC` names this file and `readSlowTable` reads the
  [slow-test table](#slow-test-table).
- `settle` reads `resourceSyncIdle` ([resource-sync](resource-sync.md)). `checkJobProtocol.mjs` rewrites
  `OWNER_ABSENT_MS` in `server/src/jobs/generationJobs.ts` by its text ([server-generation](server-generation.md)).
- Domain guides hold their focused test paths and browser gaps: use
  [STRUCTURE's task router](../../STRUCTURE.md#choose-by-task).

## Invariants

- [STRUCTURE](../../STRUCTURE.md#repository-wide-invariants) V1, V2, V3, V6, V7, V8, and V9 apply to every test; this
  guide holds their detail.
- `e2e/0-idleReload.spec.ts` must run first because it asserts the shared stack's first boot;
  `e2e/welcomeAndChatSettings.spec.ts` runs last because it changes the shared stack's settings.
- The slow-test table stays one contiguous table with its header cell unchanged: `readSlowTable` stops at the first line
  that does not start with `|`.

## Recipes

| Need                                 | Agent command                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Default gate / focused files         | `pnpm --silent test:agent [files or directories]`                                                        |
| Affected slow tests                  | `pnpm --silent test:agent --tags-filter=slow <files>`                                                    |
| Fast and slow tests together         | `pnpm --silent test:agent --all [files]`                                                                 |
| Browser specs                        | `pnpm --silent test:agent --e2e [e2e/<name>.spec.ts]`; selection rules: [Browser specs](#browser-specs). |
| Reproduce under CPU load             | `pnpm --silent test:overload <files>` (Linux).                                                           |
| Runner, slow-table, and import rules | `pnpm check:tests` (static inventory).                                                                   |

People and CI use `pnpm test`, `pnpm test:slow`, `pnpm test:all`, and `pnpm test:e2e`; agents use the wrapper above
([Human gate](#human-gate)). `--force` bypasses the result cache; `--verbose` includes held stderr.

- Add a slow test: first try to make it fast (a test-only option for the limit, as `createScriptWorkerPool`'s
  `syncHostTimeoutMs` and `sleepCaps`). Tag it `slow` only when the cost is the subject: a real wall-clock limit, a real
  production limit, cold loads of every tokenizer, or a fresh Node process.
  - Tag a test with `{ tags: ["slow"] }` (the timeout goes in the same object) and a whole file with a
    `/** @module-tag slow */` comment, then update the [slow-test table](#slow-test-table).
  - The tag is defined in `vitest.config.ts`; an undefined tag fails the run. Run `pnpm check:tests`: it fails while the
    table and the tags disagree.
- Point a check at a mock provider: write a model profile and the model preset's slots
  ([model profiles and slots](llm-requests.md)), never `aiModel`, `forceReplaceUrl`, or `maxContext` on a `presets`
  record, whose normalizer drops them without an error. Use `util/playwright/modelProfiles.mjs` (`modelFixtureOps` for
  the batch, `promptFixture` for the prompt half) or, in the page, `modelProfiles.browser.mjs`
  (`applyModelFixtureSettings`).
- Send from a check: bind its chat ([chat bindings](persistence.md#state): a chat without a complete binding is not
  sent): spread `chatBindingFixture(modelPresets, presets, personas)` (`util/playwright/modelProfiles.mjs`, the first
  record of each list, the model preset `modelFixtureOps` points at the mock) into the seeded chat.

## Tests

Use the [Recipes](#recipes) commands. A `FLAKY` block means a test failed in the full run and passed when its file ran
alone; the wrapper counts it as passed and records it in `flaky.jsonl`. Recurring entries warrant a separate V3 fix,
checked under the overload runner. Report warnings with the current run rather than treating a passing exit as proof of
stability.

Focused tests belong to the guide for the code under test: use
[STRUCTURE's task router](../../STRUCTURE.md#choose-by-task) instead of copying those inventories here. Domain guides
retain their harnesses and browser gaps. Discover current files with:

```sh
rg --files src server/src shared | rg '\.test\.ts$'
rg --files e2e | rg '\.spec\.ts$'
rg --files util/playwright
```

- Setup, icon rewriting, and the network guard: `vitest.setup.test.ts`, `vitest.lucideImports.test.ts`,
  `vitest.testNetwork.test.ts` (happy-dom), and `vitest.testNetwork.node.test.ts` (Node). The guard suites use
  registered loopback listeners and controlled global stubs.
- Wrapper helpers and inventory: `util/{agentE2e,agentTestResults,testInventory}.test.ts` exercise pure result/selection
  logic and temporary repository fixtures; no full app stack.
- Focused command:
  `pnpm --silent test:agent vitest.setup.test.ts vitest.lucideImports.test.ts vitest.testNetwork util/agentE2e.test.ts util/agentTestResults.test.ts util/testInventory.test.ts`.
  These files have no slow tags or e2e membership.
- Not tested directly: the `util/agentTest.mjs` CLI and `util/overloadTest.mjs` supervisor. Their helper tests do not
  replace a manual end-to-end run when those entrypoints change.

### Test rules

The root [verification rules](../../STRUCTURE.md#verification) apply. Keep tests that reject plausible wrong behavior
and survive behavior-preserving refactors; add them only for code the task changes.

- Determinism: no elapsed-time/throughput assertions, sleeps for synchronization, bounded real-time polls over I/O, or
  real production deadlines raced by test work. Cold workers, child processes, tokenizers, and module graphs cannot race
  those deadlines either. The Vitest timeout is only a [hang guard](#timeouts).
- Control time with fake timers (include `"Date"` when code reads `Date.now`), an injected `now`, a deferred/latch, a
  call-through timer spy, or a test-only limit option. Boot shared module graphs in `beforeAll`, as
  `characterCardsPngImport.test.ts` does. Warm worker pools before a timed region; tests of real limits belong in the
  slow tier.
- Prove each new test fails with the guarded line broken; a regression test reproduces the bug before the fix (V6).
- Assert observable outcomes against explicit expected data: stored strings/records, responses, emitted operations,
  rendered text, or return values. Avoid internal call order, private state, and assertions that only repeat a mock's
  return value. For example, `server/src/tests/chats.test.ts` checks serialized key order because the diff consumes that
  string.
- Keep repository modules real and fake process/I/O boundaries. Browser hub modules that must be stubbed because they
  load DOM, runes, or server dependencies use [shared typed factories](#mock-factories), not partial inline objects.
  Factory defaults must satisfy the module's exports so missing exports fail type checking.
- Test cross-layer changes in one round trip: persisted shapes, normalizers, acknowledgement rules, revisions, and cache
  keys need the client/server pair or real `app.request`/e2e stack. Separate unit tests that mock the opposite side can
  both pass while the integration is wrong.
- If a behavior-preserving refactor breaks a test, delete it or rewrite it against the outcome. An intended behavior
  change updates the expectation and explains the change in the commit message.

### Mock factories

A module mocked in more than one test file gets one shared, typed factory in a `tests/` directory (STRUCTURE V7). Most
factories' doc comments say what their defaults answer. Load a factory inside the hoisted `vi.mock` factory and pass the
file's own handles as `overrides`. A partial mock over `importOriginal` needs no factory.

- `src/ts/tests/alertMock.ts` `createAlertMock(overrides)`: every other client test that mocks `alert` uses it.
- `src/ts/tests/storesMock.ts` `createStoresMock(overrides)`: all handwritten stores mocks use it.
- `src/ts/tests/bootMocks.ts` `createBootMock(module, overrides)` supplies typed boot service defaults to both bootstrap
  suites; keep the `vi.mock` registrations in each test file and load the factory inside them so Vitest hoisting remains
  local.
- `src/ts/storage/tests/resourceClientMock.ts` `createResourceClientMock(overrides)`,
  `src/ts/storage/tests/chatStoreMock.ts` `createChatStoreMock(overrides)`, and `src/ts/tests/globalApiMock.ts`
  `createGlobalApiMock(overrides)`: every mock of these three most mocked modules that does not spread the real module
  uses them. The resource client's factory is async because it loads the real module for its error classes.
- Their overrides are `ModuleMockOverrides<Module>` (`src/ts/tests/mockOverrides.ts`); an export only the test drives
  goes beside the factory's result, not into its overrides.
- `src/ts/network/tests/generationJobsMock.ts` `createGenerationJobsMock(overrides)` covers the job transport (with
  `createFollowStub(jobId)` for a controllable follow, and the error classes in the real shape); new tests that mock
  `network/generationJobs` use it.
- `src/ts/diagnostics/tests/collectorMock.ts` `createCollectorMock(overrides)` covers the diagnostics collector.

### Network guard

Unit tests run behind a network guard: `vitest.setup.ts` routes the global `fetch`, `WebSocket`, Node's undici global
dispatcher, and happy-dom's loaders through `vitest.testNetwork.ts`. The comments in both files have the routing.

- The policy allows `data:` and `blob:` URLs and the exact loopback origins a test registered. Everything else is
  refused, relative URLs included: the call throws or rejects as a failed request would (an XHR fires `error`), and the
  setup's `afterEach` fails the test even when its code caught the error.
- `vi.stubGlobal("fetch", ...)` replaces the guard and `vi.unstubAllGlobals()` restores it.
- A test that needs the network stubs `fetch` (or the module that fetches) or starts a loopback server and registers it:
  `allowTestLoopbackOrigin(origin)` returns the unregister function.
- Server tests call `server/src/tests/testSupport.ts` `allowListenerOrigin(server)` once the server listens (a
  `node:http`/`node:net` server or a `ws` `WebSocketServer`), which unregisters on `close()`, and `startUpstream` does
  it itself.
- A registration outlives `afterEach`, so a `beforeAll` upstream serves the whole file; the setup's `afterAll` fails the
  file when an origin is still registered or a refusal came after the last `afterEach`.
- A test that wants a refused connection registers the dead port
  (`onTestFinished(allowTestLoopbackOrigin("http://127.0.0.1:1"))`).
- Not guarded: `node:http`/`https`/`net`/`tls` sockets opened directly (the Lua egress transport
  `server/src/lua/egress.ts`, `ws` package clients), and worker threads and child processes, which have their own
  globals.

### Timeouts

- The gate's Vitest timeout is a hang guard, not a performance budget: a test whose result does not depend on real time
  may take as long as the machine's load makes it take, and only a test that never settles should fail on the timeout.
- So `vitest.config.ts` sets `testTimeout` and `hookTimeout` to 60 s instead of Vitest's 5 s and 10 s, and a gated test
  or hook gets no explicit shorter budget (a `slow` test keeps its own).
- Slow tests are reported on request instead of failing: `pnpm --silent test:agent --slow-tests` lists the ones over 1
  s.
- Real-time dependencies (sleeps, real deadlines, bounded polls, elapsed-time assertions) are still V3 violations at any
  timeout.
- Verify a timing fix under CPU load with `pnpm --silent test:overload <files>` ([Overload runner](#overload-runner));
  the slow tier is not run under it.
- `server/src/tests/testSupport.ts` `waitFor` has no polling deadline by default: the test's Vitest timeout reports a
  condition that never holds as a failure. An explicit `timeoutMs` cap is for slow-tier tests only; prefer awaiting the
  event where one exists.

### Slow tests

Slow tests cover real wall-clock/production limits, cold tokenizers, or fresh Node processes. Select them when touching
the last column of the [slow-test table](#slow-test-table). Discover current tags with
`rg -n 'module-tag slow|tags:.*slow' server/src shared src` rather than relying on a count or timing estimate. To tag a
test, follow [Recipes](#recipes); `readSlowTable` in `util/testInventory.mjs` has the row format.

### Slow-test table

| Test (file in `server/src/tests/`)                                    | Why slow           | Run after changing                                                   |
| --------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| `generationReceipts.test.ts` "measures receipt admission..."          | timed SQLite       | `server/src/data/generationReceipts.ts`                              |
| `tokenPlainNode.test.ts` (the whole file)                             | cold tokenizers    | `server/{src/prompt/tokenizers,assets/token}/`                       |
| `tokenParity.test.ts` "counts the smoke strings..."                   | cold tokenizers    | `server/{src/prompt/tokenizers,assets/token}/`                       |
| `importPngCaps.test.ts` (the whole file)                              | production cap     | `server/src/routes/importPng.ts`, `shared/charxImport.ts`            |
| `restoreWorker.test.ts` (the whole file)                              | real worker boot   | `server/src/{data/restore/,routes/backups.ts}`                       |
| `upstreamImportWorker.test.ts` (the whole file)                       | cold worker boot   | `server/src/{data/upstream/import*,routes/backupsUpstream}.ts`       |
| `upstreamExportWorker.test.ts` (the whole file)                       | cold worker boot   | `server/src/{data/upstream/export*,routes/backupsUpstreamExport}.ts` |
| `diagnosticsCrash.test.ts` (the whole file)                           | fresh Node process | `server/src/{diagnostics/journal,main}.ts`                           |
| `scriptWorker.test.ts` "caps sleep at 2 s..."                         | production caps    | `server/src/{lua/runtime.ts,scripts/}`                               |
| `scriptWorker.test.ts` "charges a C-level...own 10 s give-up"         | real 10 s give-up  | `server/src/scripts/`                                                |
| `scriptWorker.test.ts` "charges a C-level...shortened give-up..."     | real 1 s give-up   | `server/src/scripts/`                                                |
| `luaRuntime.test.ts` "pins the address..."                            | real 10 s deadline | `server/src/lua/egress.ts`                                           |
| `manualTriggers.test.ts` "ends the job with an error past..."         | production limit   | `server/src/{prompt/triggers.ts,jobs/}`                              |
| `triggerRuntime.test.ts` "ends a privileged self-recursion..."        | production limit   | `server/src/prompt/triggers.ts`                                      |
| `triggerRuntime.test.ts` "ends `/trigger` recursion..."               | production limit   | `server/src/prompt/{triggers,commands}.ts`                           |
| `promptRunner.test.ts` "writes the checkpoint 3 s..."                 | real 3 s timer     | `server/src/prompt/runner.ts` (`CHECKPOINT_INTERVAL_MS`)             |
| `cbsLimits.test.ts` "the stuck...", "a non-adv...", "an ordinary..."  | fresh Node process | `shared/cbs/`, `server/src/jobs/cbsHost.ts`                          |
| `shutdown.test.ts` (the whole file)                                   | fresh Node process | `server/src/main.ts`, `server/src/app.ts` (`beginShutdown`)          |
| `sharedImports.test.ts` "imports every shared/..."                    | fresh Node process | `shared/`                                                            |
| `hypaV3Limits.test.ts` "the %s loop..."                               | fresh Node process | `server/src/prompt/memory/hypav3.ts`                                 |
| `hypaV3Limits.test.ts` "ends a catastrophic pattern..."               | real 100 ms limit  | `server/src/{prompt/memory/hypav3.ts,scripts/}`                      |
| `lore.test.ts` "a worker timeout during activation..."                | real 200 ms limit  | `server/src/scripts/`, `shared/lore/`                                |
| `scriptWorker.test.ts` "terminates a ReDoS regex..."                  | real 1 s deadline  | `server/src/scripts/`                                                |
| `scriptWorker.test.ts` "lets a plain Node process..."                 | fresh Node process | `server/src/scripts/workerPool.ts`                                   |
| `scriptWorker.test.ts` "does not charge an asynchronous..."           | real 1 s wait      | `server/src/{lua/runtime.ts,scripts/}`                               |
| `scriptWorker.test.ts` "charges a coroutine..."                       | real 350 ms wait   | `server/src/lua/runtime.ts`                                          |
| `scriptWorker.test.ts` "does not charge a synchronous wait,..."       | real 1.5 s wait    | `server/src/{lua/runtime,scripts/workerPool}.ts`                     |
| `scriptWorker.test.ts` "runs every task the full queue..."            | 1,000 round trips  | `server/src/scripts/workerPool.ts`                                   |
| `llmCharsetRetries.test.ts` "ends with...", "observes a stop..."      | fresh Node process | `server/src/{llm/outer.ts,jobs/}`                                    |
| `luaRuntime.test.ts` "keeps the wasm function table..."               | fresh Node process | `server/src/lua/runtime.ts`                                          |
| `transformers.test.ts` "forks transformersWorker.ts..."               | real fork          | `server/src/prompt/transformers{,Worker}.ts`                         |
| `upstreamImportCharacters.test.ts` "reports every repair..."          | 150,000 messages   | `server/src/data/upstream/import{Characters,Records}.ts`             |
| `src/ts/storage/tests/projectionBindings.test.ts` "1,000...$state..." | timed comparison   | `src/ts/storage/tests/projectionHarness.svelte.ts`                   |
| `src/ts/storage/tests/projectionBindings.test.ts` "bulk...$state"     | timed comparison   | `src/ts/storage/tests/projectionHarness.svelte.ts`                   |
| `assets.test.ts` "rejects record 2001..."                             | production cap     | `server/src/routes/storage.ts`, `shared/assetBatch.ts`               |
| `backups.test.ts` "refuses an archive with more records..."           | production cap     | `server/src/{data/archive,routes/backups}.ts`                        |
| `importCharx.test.ts` "excludes...entries in file..."                 | production cap     | `server/src/routes/importCharx.ts`, `shared/charxImport.ts`          |
| `resourcePatchParts.test.ts` "charges four...text: evicts..."         | production budget  | `server/src/data/resourceStore.ts`                                   |
| `src/ts/storage/tests/resourceSyncHydration.test.ts` "applies the..." | 150,000 messages   | `src/ts/storage/chatStore.svelte.ts`                                 |

`triggerRuntime.test.ts` "ends an endless loop with the limit" still covers the effect limit in the default agent suite.

## Known Hazards

### Gotchas

- Import lucide icons as plain names (`import { X, Check as Ok } from "@lucide/svelte"`). Another form (a type, `icons`,
  a default or namespace import) keeps that statement on the package's main entry, and every test that reaches it
  repeats the package main entry and its icon exports; `vitest.lucideImports.test.ts` fails on it.
- A Vitest file that reaches the settings views or the records needs the client environment (happy-dom): the records use
  Svelte's client `$state`, so `@vitest-environment node` fits only pure schema tests. Install a flat fixture with
  `src/ts/storage/tests/installFlatDatabase.ts`.
