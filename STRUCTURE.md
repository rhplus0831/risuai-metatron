# STRUCTURE

Agent map for the RisuAI metatron fork: a Svelte 5 + TypeScript client served by its Hono/Node self-host server,
installable as a PWA. The client requires that server; standalone static hosting, Tauri, and Capacitor are not
supported.

Use this index to find the owning guide. Guides retain entrypoints, contracts, coupling, and hazards; current source and
configuration remain authoritative. Paths and identifiers are lookup anchors, and test results belong to the current
run.

## Agent Read Protocol

1. Read **Repository-Wide Invariants** below for add/change tasks.
2. Choose one owner in **Choose By Task**; for a supplied path run `pnpm docs:owner <path>`. A folder row's `README.md`
   routes on to one of its guides.
3. List that guide's headings with their sizes (`pnpm docs:read <guide>`), read `Scope`, then the relevant subsection
   (`pnpm docs:read <guide> <heading>`), not the whole file. For an add/change task, also read `Invariants`, `Recipes`
   for the edit path, and `Tests` for focused verification. A `Files` entry points at the module's contract comment:
   read that comment with the code.
4. Follow its `Coupling` links only when the change crosses a boundary. Do not load every guide.
5. Confirm the named identifier with a bounded `rg -n "<identifier>" <path>` before editing.
6. Run V1's gates and the affected guide's focused checks.
7. Update the owning guide when moving a named file or changing a documented contract, and
   `docs/structure/ownership.json` when a moved or new file has no rule. For guide edits, follow
   [Doc Maintenance](docs/structure/README.md), run targeted Prettier and `pnpm check:docs`; if the slow-test table
   changes, also run `pnpm check:tests`. The documentation check validates Markdown links, not source paths or
   identifiers.

## Repository-Wide Invariants

### Tooling

- T1. Use `pnpm` (`packageManager: pnpm@10.34.1`) and Node `>=24.0.0`. The server runs TypeScript through Node type
  stripping.
- T2. `src/...` resolves to `/src` in Vite and Vitest; match surrounding import style. `shared/` has no alias. Imports
  between shared modules use relative `.ts` paths and `import type` for types. Shared code runs in both client and
  strict server projects: no DOM types, runes, enums, namespaces, or parameter properties. See
  [persistence](docs/structure/persistence.md).
- T3. Svelte runes belong only in `*.svelte` and `*.svelte.ts`. Legacy stores coexist with runes; preserve established
  store boundaries.
- T4. Format changed files with `pnpm format:changed --write` or `pnpm exec prettier --write <files>`; both honor
  `.prettierignore`. `pnpm format:check` is the repository formatting check; its cache makes a warm run take seconds.
- T5. Code comments, test titles, identifiers, and file names describe current behavior, not the work item that added
  it: no plan, phase, slice, stop, or audit labels such as `(Phase 6 slice 5)`, `data-loss slice 6b`, or
  `docs/plan/<plan>.md S2`. Plans move to the archive when done, so these labels go stale. State the reason itself
  ("since chats became their own records", not "since slice 9"); history belongs in commits and
  [the archive](docs/archived-plan/README.md).

### Verification

- V1. Run `pnpm check` (or `pnpm check:changed`) and `pnpm --silent test:agent` once per change, after the last source
  edit; while iterating, run only the test files the edit reaches (`pnpm --silent test:agent <files or directories>`). A
  change also runs the slow tests and `e2e/` specs it affects, and a build change `pnpm build`. Agents use the wrapper,
  never `HUMAN` to bypass the human/CI command gate. The wrapper's flags, lock, and warnings belong to
  [test-harness](docs/structure/test-harness.md).
- V2. Unit tests are `*.test.ts`, colocated or in sibling `tests/` directories. Vitest defaults to happy-dom; server
  tests select Node. Setup mocks, clone/DOM differences, and the deny-by-default network guard are documented in
  [test-harness](docs/structure/test-harness.md). Domain guides own focused test paths and coverage gaps.
- V3. A test in the gate (`pnpm test`, no `slow` tag) must not depend on real wall-clock time, CPU time, or the
  scheduler: no elapsed-time or throughput assertion, no sleep as synchronization, no real production deadline raced by
  test work. Control the clock (fake timers, an injected `now`, a deferred or latch, a test-only limit option) or tag
  the test `slow`. A gate timeout is a hang guard, not a performance budget.
  - Add tests only for code the task changes, and keep a test only when a plausible wrong implementation would fail it.
  - Timing policy and overload checks: [test-harness](docs/structure/test-harness.md) `Tests`.
- V4. Before committing, `rg` each changed product export and file name across `src`, `server`, `shared`, `public`,
  `util`, `e2e`, and `docs`, and update the consumers it finds (scripts that read source as text and guides that name it
  included).
- V5. A check that could not start, or was not run, is reported as unverified, never as passed.
- V6. A new test is shown to fail once with the line it guards broken; a bug fix's test reproduces the bug before the
  fix.
- V7. Mock only process and I/O boundaries (network, file system, clock, workers, the server, dialogs). A module mocked
  in more than one file gets one shared, typed factory in a `tests/` directory whose defaults `satisfies` the module's
  export type, so a new export breaks `pnpm check` instead of a run under load. `src/ts/alert.ts` has `createAlertMock`
  (`src/ts/tests/alertMock.ts`).
- V8. Product code never imports test code (`tests/` directories, `*.test.*`, test-only helpers); test-only helpers live
  in a `tests/` directory so the rule is checkable. `pnpm check:tests` checks it, and that every test file belongs to
  exactly one runner and the slow-test table matches the `slow` tags; run it after adding, moving, or tagging a test.
- V9. A test reads product source through `node:fs`, never a Vite `?raw` import (which pulls the file into the module
  graph and coverage as text).

### Data and persistence

- D1. The client holds resource records, not a whole `Database`: settings views, character records, and the chat module
  are its live state. Legacy snapshots are detached copies. All chat writes go through `chatStore.svelte.ts`, addressed
  by chat id and message id (`Message.chatId`), never an index after an await. Bind chat fields through getter/setter
  functions or a synced editing copy.
- D2. A persisted field needs its shared type, ownership in `shared/sections.ts`, and server defaults/migration in
  `server/src/data/normalize/`. Boot installs the server's records without client normalization. Details:
  [persistence](docs/structure/persistence.md) and [LLM requests](docs/structure/llm-requests.md).
  - Chat/message fields are stored largely as sent; default missing values at their readers.
  - Settings views follow the open chat's bound records when available, then tab selection; a send requires all three
    chat bindings and never uses that fallback.
  - Model ids are derived from slots/profiles and are written synchronously.
- D3. Preserve persisted spellings, including `seperateModels`, `seperateParameters`, `moduleIntergration`, and
  `PresensePenalty`.
- D4. Resource writes carry revision and epoch. Stale writes merge independent units; same-unit conflicts reload,
  keeping eligible local work as a recovery draft; by-id message operations and per-field chat metadata can apply to an
  older chat revision while their targets exist. Preserve optimistic message ids and append collision refusal.
  Add/remove/replace characters through `characterStore`; a structural write through the character-list wrapper throws.
  External contracts use the validated mutation modules. Save/conflict rules:
  [resource-sync](docs/structure/resource-sync.md).
- D5. Cards (`.png` `chara`/`ccv3`, `.json`, `.charx`), modules (`.risum`), presets (`.risup`/`.risupreset`), translator
  presets (`.risutl`), and plugin scripts are cross-user formats. Preserve old readers and paired client/server import
  compatibility; format-specific parity rules and intentional refusal differences belong to
  [characters/modules](docs/structure/characters-modules.md) `Invariants`. Never renumber `LLMFlags`, `LLMFormat`,
  `LLMProvider`, `LLMTokenizer`, or rename persisted discriminator values.

### Platform and network

- P1. Only `src/main.ts` gates on `isNodeServer` (`globalThis.__NODE__`, injected by Hono or Vite). It imports `boot.ts`
  only with the server present; otherwise it mounts `NodeServerRequired`. Code past that gate assumes the server exists.
  Do not add browser-only storage/network branches. `isMobile` is user-agent based.
- P2. LLM generation and provider requests run on the server; plugin providers and browser WebLLM are explicit
  exceptions. The tab never reads LLM credential values (`llmSecrets` is write-only). Credentialed LLM auxiliary
  operations use `auxFetch`; other remote calls use `globalFetch`/`fetchNative`, preserving proxy, local-network policy,
  and logs. See [network-jobs](docs/structure/network-jobs.md).
  - TTS and image providers have separate client/server routing and credential paths; see
    [media-aux](docs/structure/media-aux.md). P2's LLM rule does not describe every media request.

### Security

- S1. Pass untrusted user/model/card/module/plugin HTML through `ParseMarkdown` and `trimMarkdown` (DOMPurify) before
  `{@html}`. Keep CSS scoped to `.chattext` and `x-risu-`; safe mode suppresses custom CSS and custom GUI HTML. The
  existing unsanitized Realm sink is tracked in [backup-sync-hub Issues](docs/structure/backup-sync-hub.md#issues).
- S2. Server Lua network/LLM calls and low-level trigger effects require the relevant character/module/trigger
  `lowLevelAccess` gates. Do not widen them.

### UI

- U1. Use theme tokens from `src/styles.css` (`bg-bgcolor`, `bg-darkbg`, `bg-darkbutton`, `bg-selected`,
  `text-textcolor`, `text-textcolor2`, `border-borderc`, `border-darkborderc`, `text-draculared`, and the
  `primary|secondary|danger|neutral|success-50..900` families). Opacity modifiers are supported; avoid raw gray/black
  colors.
- U2. User-visible strings belong in `src/lang/en.ts`, the source and type. Other locales are `DeepPartial` overrides
  merged by `changeLanguage`. Components import `{ language } from 'src/lang'`.
- U3. Use `src/ts/alert.ts` helpers for errors and confirmations.
- U4. Stores choose the screen; the URL router applies URLs to them and mirrors settled changes into history. Screen
  actions change stores. Resolve characters by `selection.characterId`/`selectedCharacter()` and use
  `selectCharacter(chaId)`; `null` is home. Never retain a list index as an asynchronous address. See
  [app-shell](docs/structure/app-shell.md).

### Release

- R1. `version.json` and `appVer` (`APP_VERSION_POINT`) in `src/ts/storage/database.svelte.ts` are the compatibility
  version: the upstream RisuAI release the ledger has triaged through
  ([upstream ledger](docs/research/upstream-ledger.md)). Change both together, and only then. What people see is the
  build id (`shared/buildInfo.ts`), taken from git at build time. `package.json`'s version is unused.

## Choose By Task

Guide links below are the current ownership map, including behavior once described by completed plans.
[Active plans](docs/plan/README.md) describe unfinished work; [migration history](docs/archived-plan/README.md) records
completed plans and retrieval commands.

| Task                                                                                                  | Guide                                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Boot, safe boot, screen selection, URL/history, stores, flags, hotkeys                                | [app-shell](docs/structure/app-shell.md)                         |
| Asset sources and thumbnails, the asset client and queues, the batch codec                            | [assets](docs/structure/assets.md)                               |
| Network/proxy, aux fetch, the request log, tab job client/channel, Web Push                           | [network-jobs](docs/structure/network-jobs.md)                   |
| The globalApi facade, save entry points, writers, chat fold, utils, alerts, notices, Iris             | [global-api](docs/structure/global-api.md)                       |
| Request history, checked failures, push diagnostics, reports, support shares                          | [diagnostics](docs/structure/diagnostics.md)                     |
| Persisted fields, records, settings views, normalization, chat bindings                               | [persistence](docs/structure/persistence.md)                     |
| Boot load and cache, save loop, batches, conflicts and merges, credential writes, transport           | [resource-sync](docs/structure/resource-sync.md)                 |
| Live updates in the tab: feed connection, record and chat updates, feed locks, restore halt           | [live-updates](docs/structure/live-updates.md)                   |
| Chat module, chat writes, job hydration, chat checkpoints, restore floor                              | [chat-store](docs/structure/chat-store.md)                       |
| Draft journal, composer rows, boot recovery, recovery drafts                                          | [draft-recovery](docs/structure/draft-recovery.md)               |
| Send/job client, stages, prompts, lore, commands, inlays, groups, reroll, message search              | [chat-pipeline](docs/structure/chat-pipeline.md)                 |
| SupaMemory, HypaV2/V3, HypaV3 job modes, Hanurai, embeddings                                          | [memory](docs/structure/memory.md)                               |
| Structured memory: records, the HypaV3 projection, writer, read path, lifecycle, rebuild, page tools  | [structured-memory/](docs/structure/structured-memory/README.md) |
| Model catalogues/profiles/slots, credentials, adapters, streaming, token counts                       | [llm-requests](docs/structure/llm-requests.md)                   |
| CBS, markdown/sanitizing, chat vars, partial edit, highlighting, display transform client and retries | [cbs-rendering](docs/structure/cbs-rendering.md)                 |
| Regex, triggers v2, Lua editors/shared engines                                                        | [scripts-triggers](docs/structure/scripts-triggers.md)           |
| Plugin v3 sandbox, host API, hooks, providers, plugin storage, permissions, plugin reload             | [plugin-sandbox](docs/structure/plugin-sandbox.md)               |
| MCP client registry, remote and internal clients, RisuAccess, tool dispatch                           | [mcp](docs/structure/mcp.md)                                     |
| Cards/characters/groups, modules, personas, lore editor                                               | [characters-modules](docs/structure/characters-modules.md)       |
| Chat/sidebar UI, GUI primitives, portals, theme                                                       | [ui-theming](docs/structure/ui-theming.md)                       |
| Settings registry/pages, preset editing/pickers, prompt editor, i18n                                  | [settings-i18n](docs/structure/settings-i18n.md)                 |
| TTS, image generation, media compression, the aux-model selector, playground tools                    | [media-aux](docs/structure/media-aux.md)                         |
| Translation: providers, the LLM translator, presets, server and stored translation, bilingual display | [translation](docs/structure/translation.md)                     |
| Backups/upstream compatibility, Realm hub/creator blocking, settings report                           | [backup-sync-hub](docs/structure/backup-sync-hub.md)             |
| Hono process, routes/auth, static serving, asset store, proxy, push, Docker, thumbnail HTTP responses | [self-host-server](docs/structure/self-host-server.md)           |
| Server resource store, chat tables, checkpoints, snapshots, backups, file imports                     | [server-resources](docs/structure/server-resources.md)           |
| Generation jobs, job channel, transforms, LLM and token routes                                        | [server-generation](docs/structure/server-generation.md)         |
| Live-update feed: socket, hello, frame admission, chat entries, publication budget                    | [live-update-feed](docs/structure/live-update-feed.md)           |
| Scripts/config, build, dev runner, worker/PWA, upstream check, releases                               | [build-test-platforms](docs/structure/build-test-platforms.md)   |
| Test wrapper, test rules, slow tests, network guard, Playwright stack, browser checks                 | [test-harness](docs/structure/test-harness.md)                   |

## Path Ownership

`pnpm docs:owner <path>...` prints each path's owning guide from `docs/structure/ownership.json`, an ordered rule list
where the first match wins; for a file two guides share, it adds the other guides and their parts. The path need not
exist. `pnpm check:changed` prints the owners of the changed paths first.

Tests follow the code they exercise, or the guide whose `Tests` names them: the manifest lists their globs before the
fallbacks, and nothing is inferred from a test's name. Browser harness ownership stays with test-harness.

Search-excluded payloads (`.ignore`): `server/assets/token/`, `public/plugin_start.7z`, `src/etc/docs/`,
`src/ts/rpack/`. Use a targeted path for those payloads; follow [AGENTS.md](AGENTS.md) for search flags.

## Glossary

- **CBS**: `{{fn::arg}}` syntax evaluated by `risuChatParser`.
- **Lorebook**: keyword-activated context with `@@` decorators.
- **Prompt preset**: `botPreset`, prompts/parameters and ordered `PromptItem[]`; `.risup` files.
- **Model preset**: slots referencing model profiles; independent from the prompt preset.
- **Model profile / Connection**: model id, named-key binding, endpoint and compatibility options.
- **Aux model**: memory/translate/emotion/`otherAx` slot; unset slots use the sub slot.
- **Named API key**: `credentials` metadata, value in write-only `llmSecrets.credentials`.
- **Module**: `RisuModule`/`.risum`, lore/scripts/assets/MCP enabled in several scopes.
- **Persona**: user name/icon/prompt, optionally an embedded module.
- **Inlay**: `inlays` metadata plus an asset, referenced as `{{inlay::id}}`.
- **Asset**: logical `assets/<hash>.<ext>` reference, read/written through asset helpers.
- **Realm / Hub**: card service, reached through GET-only `/hub-proxy`.
- **Iris**: built-in assistant using RisuAccess MCP tools.

## Doc Maintenance

The rules for editing guides, from the outline and budgets to fact ledgers and `Known Hazards`, are in
[Doc Maintenance](docs/structure/README.md).
