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
  - Package scripts, Vite, TypeScript, CI, the `dev:agent` runner, and the service worker's harness →
    `build-test-platforms.md`.
  - A domain's focused tests and browser gaps → the guide for the code under test.

## Files

### Reporter

- `util/agentTestReporter.ts` (its header has the output): stack frames leave out `node_modules`, Node internals, and
  anonymous frames, and the cause chain is printed. Logs are buffered per task and printed only under a failure, so
  `--silent=passed-only` is not needed. Module and suite errors (import failures, `beforeAll` throws) and unhandled
  errors are listed like failures. Diffs, values, logs, and frames are capped.
- With `test:agent --slow-tests` it prints a `SLOW` warning with the ten slowest passed tests and a count of the rest.
- `util/agentTestResults.mjs` `summaryLine`, which the wrapper also uses after a rerun:
  `OK <n> passed, <n> skipped (<files>, <s>s)` or `FAIL <n> failed, <n> passed, ... (<k> of <files> failed, <s>s)`.

### Human gate

- `util/requireHuman.mjs` (its header names the commands and the three variables): `requireHuman(command)` prints a
  notice (what to run as an agent, how to set `HUMAN` as a person) and exits with 1 unless `CI`, `HUMAN`, or
  `AGENT_TEST` is set.
- `vitest.config.ts` calls it at load; the Vitest VS Code extension loads that config too, so that editor needs `HUMAN`
  in its environment.
- Agents must use the wrapper and must not set `HUMAN` or `AGENT_TEST` themselves to bypass this convention.

### Vitest config and setup

- `vitest.config.ts` (its comments give the reasons): `requireHuman("vitest")` at load, the Svelte plugin with
  `configFile: false`, the test-only `lucideImports` plugin, the `src` alias, browser resolve conditions, `happy-dom`
  with `enableIframePageLoading`, setup file `vitest.setup.ts`, the default include pattern, and `e2e/**` and
  `.claude/**` excluded.
- `vitest.lucideImports.ts` `lucideImports` (its doc comment has the rewrite and the reasons): one
  `@lucide/svelte/icons/<file>` default import per icon, for tests only.
- `vitest.setup.ts`: mocks KaTeX, sets `globalThis.safeStructuredClone` to a JSON clone, patches happy-dom's
  `Node.prototype.nodeName` getter so it dispatches by node type, and installs the [network guard](#network-guard).
  - DOMPurify >= 3.4.6 reads tag names through that prototype getter, which happy-dom leaves returning `""`
    (capricorn86/happy-dom#2182); without the patch the sanitizer strips every element under happy-dom.
  - The patch is guarded, runs only under the happy-dom environment, and its contract is pinned by
    `vitest.setup.test.ts`. Remove both once happy-dom fixes the getter.

### Test inventory

- `pnpm check:tests` (`util/testInventory.mjs`, plain Node: no test run, so no human gate): its header lists what fails
  and how it applies each runner's patterns. Run it after adding, moving, or tagging a test.
- Slow rows: a row names its file, then "(the whole file)" for a `@module-tag slow` or each tagged test's title in
  double quotes, `...` standing for any text.
- A `.svelte` file's imports are read through Svelte's parser, template expressions included.
- A config shape it cannot read is an error; teach the script before using one.

### Browser stack

- Browser checks use Playwright against this stack: plain `playwright-core` scripts in `util/playwright/` for captures
  and one-off observations, `@playwright/test` specs in `e2e/` for repeatable checks (`pnpm test:e2e`).
  `playwright.config.ts`, `e2e/`, and `util/playwright/` are outside `tsconfig.json`'s include, so `pnpm check` does not
  type-check them.
- `playwright.config.ts`: specs in `e2e/**/*.spec.ts`, one worker, the system Chrome (`/usr/bin/google-chrome`, override
  with `RISU_CHROME`; no browser download), `baseURL` `http://localhost:5201`. `globalSetup` is
  `util/playwright/globalSetup.mjs`, which starts one isolated stack per run.
- `e2e/fixtures.ts`: the specs' `test`, `expect`, and `settle` (and the Playwright types they use).
  - `settle(page)` waits until the page's resource sync is idle (`resourceSyncIdle` in
    `src/ts/storage/resourceSync.svelte.ts`: nothing dirty, queued, scheduled, or in flight), seen on two polls 100 ms
    apart, within 30 s.
  - Its `context` fixture clears safe boot's counter of unsettled boots before every page load, so a spec that opens the
    app several times, or runs right after another check's loads in the same stack, is not met by the Safe boot notice
    intercepting its clicks.
  - The fixture wraps only Playwright's injected `context`, so a context a spec makes itself (`browser.newContext()`)
    calls `clearSafeBootAttempts` before its first page load.
- `util/playwright/stack.mjs` `startStack({ serverPort, vitePort, serverEnv })`: runs `server/src/main.ts` in a fresh
  temporary working directory and the Vite dev server with `RISU_DEV_SERVER` pointing at it; `stop()` ends both and
  deletes the directory.
  - `RISU_SAVE_DIR` is pinned to the directory's `save/` and the shell's `RISU_HOST` and `RISU_AGENT_DEV_AUTH_BYPASS`
    are dropped, so the store starts empty, the repository `save/` is never touched, and auth is real.
  - `serverEnv` adds to the server's environment only, e.g. `NODE_OPTIONS` with a check's `--import` preload; without
    one the server gets a `fetch` egress tripwire, `deniedEgress()`.
  - `isolateContext(context)` keeps a browser context's HTTP requests on local hosts and `unexpectedEgress` filters the
    expected blocks.
  - `openApp(page, baseURL)` answers the node-password prompts and waits for `loadedStore`.
  - `restartServer({ signal })` stops the server (SIGTERM, a graceful shutdown, unless `signal` says otherwise:
    `SIGKILL` checks crash recovery) and starts it again over the same `save/`, leaving Vite running.
  - `clearSafeBootAttempts(contextOrPage)` is for a check that loads the app three times within safe boot's 10 s settle
    window; a reload followed by `openApp` loads it twice.
- `util/playwright/offline.sh <command>` runs a check in a user and network namespace with loopback only
  (`unshare -rn`): the boundary that keeps the stack, the browser, and the mocks off public services, whatever the
  transport.
- Page code reaches app modules with `await import("/src/...")`, which is the same module instance the app uses; a
  two-client check opens a second browser context (tabs of one context share `localStorage`).

### Check scripts

Each script in `util/playwright/` has its usage and what it checks in its header. None is in the gate.

- Against the dev stack: `checkLiveUpdates.mjs`, `checkCredentialTraffic.mjs` and `checkLlmTransport.mjs` (no provider
  key in the browser's traffic), `checkStreamingModes.mjs`, `checkServerTransform.mjs`, `checkMcpFixes.mjs`,
  `checkDurableDrafts.mjs`, `checkSidebarChatStatus.mjs` (also supports `--base`).
- `checkJobProtocol.mjs`: generation jobs with a real v3 plugin provider installed in the persisted plugin list and
  selected by the model profile, its replies and stream chunks held and released from the sandbox frame. Run it under
  `offline.sh`.
- `checkBootCache.mjs`: ports 6141/5241, `PORT`/`VITE_PORT`. Besides the header's comparison it fails if loading times
  out and checks that the chat edit re-sends only that character's collection.
- Against a running production server, normally the Docker image on a fresh volume (`--base`, `--password`; a mock
  provider named by `--provider-host`): `checkRecordsSmoke.mjs`, `checkLazyChatsSmoke.mjs`, `checkTwoClientSmoke.mjs`,
  `checkServerSend.mjs`, `checkServerButton.mjs`, `checkServerTrigger.mjs`, `checkServerJobMatrix.mjs`. The last four
  start their own dev stack when no `--base` is given.

### Measurement scripts

Each script's header has its fixture, environment, and output. All but `measureTransformLua.mjs` and
`probeDirectAssets.mjs` measure a production build in headless Chrome.

- `measureRecords.mjs`, `measureCharacters.mjs`, `measureChats.mjs`, `measureHeap.mjs`, and `measureTransformLua.mjs`
  need no notes beyond their headers.
- `measureBoot.mjs` exports the synthetic fixture builder `buildBootFixture`/`seedBootFixture`. A relative `RISU_DIST`
  is resolved against the working directory. It blocks the page's four known public hosts through CDP instead of
  `isolateContext`, because Playwright's request routing turns the HTTP cache off, and fails on a page request to any
  other host. The server's egress is not guarded. Startup requires the child's listening URL on stdout.
- `measureFileSources.mjs`: its `thumb` step checks that `sw` decoded every catalog avatar at short side 256 from
  `?w=256`. In `sw` the request counts are the worker's own requests, not the page requests it answered.
  `isolateContext` routing turns the HTTP cache off, so these are cold transfers, and the request counts can exceed the
  distinct images.
- `probeDirectAssets.mjs` is a standalone browser probe of the direct asset mechanics, not the app, and is not in the
  gate: a non-extractable IndexedDB key, an immutable fetch from the HTTP cache, a ranged `<video>`, a sandboxed SVG,
  and an opaque srcdoc iframe. It exits non-zero on any failed check, including Playwright Firefox losing worker control
  after an unanswered navigation.

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

`util/agentTest.mjs`
(`pnpm --silent test:agent [--force] [--verbose] [--all] [--slow-tests[=<ms>]] [--no-rerun] [--no-lock] [vitest args]`)
is `pnpm test` for agents, and the only entry point that runs tests without `CI` or `HUMAN`. Its header has the run, the
cache key, the held stderr, the rerun, and the lock.

- `--tags-filter=slow` is `pnpm test:slow`; other arguments, such as a file filter, pass through.
- A cache hit prints a `[agent-test] cached result ...` line first. Outside git it runs without the cache. An
  interrupted run caches nothing.
- `pnpm --silent test:agent` also drops pnpm's own banner lines.
- `--slow-tests` is consumed by the wrapper (Vitest never sees it). It is part of the cache key like any argument, so a
  cached replay shows the stored run's durations, and `--force` measures again. `test:overload` passes it through.

### Failed-file rerun

The wrapper reruns with the same arguments minus the file filters (`parseCLI` from `vitest/node` finds them), and the
reporter's output is held until then. The reporter hands the wrapper its per-file results in a temporary JSON file named
by `RISU_REPORT_RESULTS_FILE`.

- A file that fails again shows the failures of its run alone after a `RERUN <file> failed again when run alone` line,
  instead of its full-run failures.
- The summary line then counts the merged result and ends with `<n> failed files rerun alone in <s>s`, and the exit code
  is 0 only when every rerun passed.
- Nothing is rerun when more than 5 files failed (`MAX_RERUN_FILES`; a `[agent-test] not rerun: ...` line says so), when
  the run had unhandled errors (they belong to no file), or when the run was interrupted or wrote no results.
- Whether the rerun is on is part of the cache key.

### Whole-suite lock

A whole-suite run takes the machine-wide lock, so whole-suite runs from every checkout and worktree queue instead of
sharing the CPUs. The suite is compute-bound, so queued runs finish one after another in the single run's time
([timings](../audit/test-suite-lock-2026-10-30.md)). A run is whole-suite when `parseCLI` finds no file filter among the
Vitest arguments. It prints a `[agent-test] whole-suite: ...` line while it waits, waits up to 15 min, then runs anyway.
A cache hit replays before the lock.

### Browser specs

`pnpm --silent test:agent --e2e [<spec>...] [--all] [--e2e-since=<rev>] [--force] [--verbose] [playwright args]`: the
Playwright specs in `e2e/` for agents (`pnpm test:e2e` is for people), through
`node_modules/@playwright/test/cli.js test --reporter=dot` with the same held stderr and the same cache (keyed by the
Playwright version and the selected specs). Run the specs the change reaches, not the whole set. The headers of
`util/agentTest.mjs` and `util/agentE2e.mjs` have the selection rules.

- "Changed" means staged, unstaged, deleted, both names of a rename, and untracked files.
- Files every spec runs on: `EVERY_SPEC_FILES` in `util/agentE2e.mjs`. `docs/`, `handover/`, `*.md`, and `*.test.*`
  never select a spec.
- The wrapper prints each selected spec with the changed files that selected it. When nothing is selected it lists the
  specs with their first comment sentence and exits with 2, so the agent names the specs that cover the behavior it
  changed.
- Selection is by name, not coverage: a component no spec names (a chat screen file, say) selects nothing even when a
  spec drives it.
- One e2e run at a time per machine: a run listens on the e2e lock port (waiting up to 30 min while another run holds
  it), then waits up to 2 min for the stack's ports (a stack an interrupted run left behind) and exits 1 naming the busy
  port.
- `--slow-tests` and `--no-rerun` are refused. Other arguments (`-g <grep>`, `--repeat-each=<n>`) pass through.
- It still shares Vite's `node_modules/.vite` with any other dev stack of the checkout (`pnpm dev:human`, a
  `util/playwright/` check), so do not run it beside one.

### Overload runner

`util/overloadTest.mjs` (`pnpm --silent test:overload [--runs N] [--cpu N] [--testTimeout MS] [files or vitest args]`)
runs the gated tests under the reference overload. Its header has the setup, the exit codes, and the supervisor.

- The gate's own timeout is the one to check against, so `--testTimeout` is forwarded only when given. Investigate each
  failure.
- `--maxWorkers` is fixed and refused; a bare `--` is dropped.
- A burner that broke means that run's result does not count, and a supervisor that ends without a result counts as a
  broken overload. On SIGINT or SIGTERM the runner sends the group SIGTERM, then SIGKILL once the supervisor ends or
  after 3 s at the latest.
- `taskset` comes from util-linux; elsewhere it exits 2 with a message.

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
  `OWNER_ABSENT_MS` by its text ([self-host-server](self-host-server.md)).
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

Agents run `pnpm --silent test:agent` for the default fast suite. Use `pnpm --silent test:agent --tags-filter=slow` for
affected slow coverage or `pnpm --silent test:agent --all` for both. Passing output is a current run result, not a
permanent property of this guide. A `FLAKY` block in a passing run names tests that failed in the full run and passed
when their file ran alone: a warning, not a failure, and not something to fix in an unrelated change. A test that keeps
showing up in `flaky.jsonl` is a candidate for its own V3 fix, checked with `pnpm --silent test:overload <file>`.

Focused tests belong to the guide for the code under test: use
[STRUCTURE's task router](../../STRUCTURE.md#choose-by-task) instead of copying those inventories here. Domain guides
retain their specific assertions and browser gaps. Discover current files with:

```sh
rg --files src server/src shared | rg '\.test\.ts$'
rg --files e2e | rg '\.spec\.ts$'
rg --files util/playwright
```

- The harness's own tests: `vitest.setup.test.ts`, `vitest.lucideImports.test.ts`, `vitest.testNetwork.test.ts`
  (happy-dom) and `vitest.testNetwork.node.test.ts` (node), `util/agentE2e.test.ts`, `util/agentTestResults.test.ts`,
  `util/testInventory.test.ts`.
- Not tested: `util/agentTest.mjs` and `util/overloadTest.mjs` have no test file of their own.

### Test rules

Two gates decide whether a test belongs in the default suite. Both are checked from the test's code, not from a guess
about how likely the code is to regress.

- Determinism (mechanical). A gated test must not depend on real wall-clock time, CPU time, or the scheduler.
  - That rules out elapsed-time and throughput assertions (`toBeLessThan` on a duration, "N items in under M ms"), a
    sleep used to let other work finish before an assertion, a poll with a real-time cap over real socket or file I/O, a
    real production deadline that test work must beat (a staging TTL, an echo delay, a regex or Lua budget, a worker's
    boot cap), and a cold worker, child process, tokenizer, or module graph booted under such a deadline. The gate's
    Vitest timeout is not such a deadline ([Timeouts](#timeouts)).
  - Fix by controlling the clock: `vi.useFakeTimers` (add `"Date"` to `toFake` when the code reads `Date.now`), an
    injected `now`, a deferred or latch that holds the provider or the slot, a call-through `setTimeout` spy, or a
    test-only limit option.
  - Boot the module graph once in a `beforeAll` (as `characterCardsPngImport.test.ts` does) so each case does not pay
    for it, and warm worker pools before a region a real deadline covers.
  - A test whose subject is the real limit itself goes to the `slow` tier instead ([Recipes](#recipes)).
- Contract over implementation (judgment). A test earns its place when a plausible wrong implementation would fail it. A
  test that only pins call order, private state, a mock's return value, or fixed data the task did not touch protects
  nothing and breaks on refactors; do not add it, and prune it when it starts costing time. Add tests only for code the
  task changes.

Past those gates, a test is judged by what its failure would tell a reader, not by how many assertions it holds. The
suite's size says nothing about what it protects: the defects it has missed were two layers each correct and wrong
together (a stored metadata object whose key order changed so a value-identical edit diffed as a change, an
acknowledgement that never installs the server's copy so duplicates survive, a write that moves a chat revision that
keys a cache), and a test over a mocked store cannot see any of them. The questions to ask of a test are "does it go red
when this line is wrong" and "does it stay green when behavior is preserved":

- Shown to fail. Every new test, not only a regression test, runs once with the line it guards broken (STRUCTURE V6); a
  bug fix's test reproduces the bug before the fix. A test that stays green against the broken line is the one that
  costs time without protecting anything.
- Outcome, not mechanism. Assert what another layer or the user sees: the stored string or record, the server's
  response, the op or event emitted, the rendered text, the returned value, against explicit expected data.
  `server/src/tests/chats.test.ts` "keeps its key order when normalized again" asserts the stored string, because the
  string is what the diff compares. Never assert the call list or order of the repository's own functions, an internal
  state shape, or a mock's return value.
- Real modules inside, typed fakes at the edge. The repository's own modules stay real; fakes stand only at process and
  I/O boundaries (STRUCTURE V7).
  - A hub module that a client test must stub because loading it pulls in the DOM, runes, or the server
    (`globalApi.svelte`, `chatStore.svelte`, `parser.svelte`, `process/modules`, `serverAuth`) is stubbed through a
    shared typed factory, never an inline partial object.
  - A partial object hides every export it leaves out until a consumer imports one, and then dozens of unrelated tests
    fail at run time and read as a regression, while a factory whose defaults `satisfies` the export type fails
    `pnpm check` once.
- A seam change gets a seam test. A change to a persisted shape, a normalizer, a sync or acknowledgement rule, or a key
  that another layer derives (a revision, a cache key) gets one round trip rather than one unit test per side: a client
  write through the server's normalizer and back into the store, a server test over the real app (`app.request`, as most
  of `server/src/tests/` does), or an `e2e/` spec against the real stack. Two unit tests with the other side mocked each
  pass while the pair is wrong.
- Delete rather than repair. When a behavior-preserving change breaks a test, the test was coupled to the
  implementation: delete it, or rewrite it against the outcome; do not patch its expectations to the new mechanism. An
  intended behavior change updates the expectation and says so in the commit message.
- Only for code the task changes. This is the budget, not a quality mark: a test the task did not need is time every
  later run and every later refactor pays.

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
test, follow [Recipes](#recipes); [Test inventory](#test-inventory) has the row format.

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
