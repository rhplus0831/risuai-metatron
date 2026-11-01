# STRUCTURE

Agent map for the RisuAI metatron fork: a Svelte 5 + TypeScript client served by its Hono/Node self-host server,
installable as a PWA. The client requires that server; standalone static hosting, Tauri, and Capacitor are not
supported.

Use this index to find the owning guide. Guides retain entrypoints, contracts, coupling, and hazards; current source and
configuration remain authoritative. Paths and identifiers are lookup anchors, and test results belong to the current
run.

## Agent Read Protocol

1. Read **Repository-Wide Invariants** below.
2. Choose one owner in **Choose By Task**, or use **Path Ownership** for a supplied path.
3. List that guide's headings (`rg -n '^##' <guide>`), read `Scope` and `Invariants`, then the relevant subsection. For
   an add/change task, check `Recipes` for the edit path and `Tests` for focused verification.
4. Follow its `Coupling` links only when the change crosses a boundary. Do not load every guide.
5. Confirm the named identifier with a bounded `rg -n "<identifier>" <path>` before editing.
6. Run V1's gates and the affected guide's focused checks.
7. Update the owning guide when moving a named file or changing a documented contract. For guide edits, run targeted
   Prettier and `pnpm check:docs`; if the slow-test table changes, also run `pnpm check:tests`. The documentation check
   validates Markdown links, not source paths or identifiers.

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
- T4. Format changed files with `pnpm exec prettier --write <files>` and honor `.prettierignore`; `pnpm format:check` is
  the repository formatting check.
- T5. Code comments, test titles, identifiers, and file names describe current behavior, not the work item that added
  it: no plan, phase, slice, stop, or audit labels such as `(Phase 6 slice 5)`, `data-loss slice 6b`, or
  `docs/plan/<plan>.md S2`. Plans move to the archive when done, so these labels go stale. State the reason itself
  ("since chats became their own records", not "since slice 9"); history belongs in commits and
  [the archive](docs/archived-plan/README.md).

### Verification

- V1. Run `pnpm check` and `pnpm --silent test:agent` once per change, after the last source edit; while iterating, run
  only the test files the edit reaches (`pnpm --silent test:agent <files or directories>`). A change also runs the slow
  tests and `e2e/` specs it affects, and a build change `pnpm build`. Agents use the wrapper, never `HUMAN` to bypass
  the human/CI command gate. The wrapper's flags, lock, and warnings belong to
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
  and logs. See [global-api](docs/structure/global-api.md).
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

| Task                                                                                     | Guide                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Boot, screen selection, URL/history, stores, flags, hotkeys                              | [app-shell](docs/structure/app-shell.md)                               |
| Network/proxy, tab job client/channel, assets/thumbnails, notifications, alerts, utils   | [global-api](docs/structure/global-api.md)                             |
| Request history, checked failures, diagnostics, reports, support shares                  | [diagnostics](docs/structure/diagnostics.md)                           |
| Persisted fields, records, settings views, normalization, chat bindings                  | [persistence](docs/structure/persistence.md)                           |
| Boot load and cache, save loop, conflicts, credential writes, live updates               | [resource-sync](docs/structure/resource-sync.md)                       |
| Chat module, chat writes, job hydration, chat checkpoints, restore floor                 | [chat-store](docs/structure/chat-store.md)                             |
| Draft journal, composer rows, boot recovery, recovery drafts                             | [draft-recovery](docs/structure/draft-recovery.md)                     |
| Send/job client, stages, prompts, lore, commands, inlays, groups, reroll, message search | [chat-pipeline](docs/structure/chat-pipeline.md)                       |
| SupaMemory, HypaV2/V3, Hanurai, embeddings                                               | [memory](docs/structure/memory.md)                                     |
| Structured memory: events, pages, threads, store, routes, package, the HypaV3 projection | [structured-memory](docs/structure/structured-memory.md)               |
| Structured memory writer: windows, tasks, runs, admission, pages, record now             | [structured-memory-writer](docs/structure/structured-memory-writer.md) |
| Structured memory read path: lanes, card, report, receipts, the memory panel             | [structured-memory-read](docs/structure/structured-memory-read.md)     |
| Model catalogues/profiles/slots, credentials, adapters, streaming, token counts          | [llm-requests](docs/structure/llm-requests.md)                         |
| CBS, markdown/sanitization, chat variables, partial edit, highlighting                   | [cbs-rendering](docs/structure/cbs-rendering.md)                       |
| Regex, triggers v2, Lua editors/shared engines                                           | [scripts-triggers](docs/structure/scripts-triggers.md)                 |
| Plugin v3 sandbox/providers/hooks, MCP                                                   | [plugins-mcp](docs/structure/plugins-mcp.md)                           |
| Cards/characters/groups, modules, personas, lore editor                                  | [characters-modules](docs/structure/characters-modules.md)             |
| Chat/sidebar UI, GUI primitives, portals, theme                                          | [ui-theming](docs/structure/ui-theming.md)                             |
| Settings registry/pages, preset editing/pickers, prompt editor, i18n                     | [settings-i18n](docs/structure/settings-i18n.md)                       |
| TTS, images, translation, media, playground tools                                        | [media-aux](docs/structure/media-aux.md)                               |
| Backups/upstream compatibility, Realm hub/creator blocking, settings report              | [backup-sync-hub](docs/structure/backup-sync-hub.md)                   |
| Hono process, routes/auth, static serving, asset storage, proxies, push, Docker          | [self-host-server](docs/structure/self-host-server.md)                 |
| Server resource store, chat tables, checkpoints, snapshots, backups, file imports        | [server-resources](docs/structure/server-resources.md)                 |
| Generation jobs, live-update feed, job channel, transforms, LLM and token routes         | [server-generation](docs/structure/server-generation.md)               |
| Scripts/config, build, dev runner, worker/PWA, upstream check, releases                  | [build-test-platforms](docs/structure/build-test-platforms.md)         |
| Test wrapper, test rules, slow tests, network guard, Playwright stack, browser checks    | [test-harness](docs/structure/test-harness.md)                         |

## Path Ownership

Apply the specific ownership before the fallback directories. Guide names refer to **Choose By Task**; each guide's
`Files` section has identifiers. For behavior sharing a UI or transport file, use **Choose By Task** and the owner's
coupling links.

### Chat, memory, and requests

- **memory**: `src/ts/process/memory/`, `server/src/prompt/memory/`,
  `server/src/prompt/{embeddings,transformers,transformersWorker}.ts`, `server/src/data/vectorCache.ts`,
  `shared/taskRateLimiter.ts`, `shared/{memory,hypaV3Presets}.ts`,
  `src/ts/process/{transformers,memoryTasks.svelte}.ts`, `src/lib/Others/HypaV3*`,
  `src/lib/Playground/PlaygroundEmbedding.svelte`.
- **structured-memory**: `shared/structuredMemory.ts`, `server/src/{data/memoryStore.ts,routes/structuredMemory.ts}`,
  the rest of `server/src/prompt/memory/structured/`, `src/ts/process/chatMemoryInherit.svelte.ts`,
  `src/ts/process/structuredMemory.svelte.ts` (the receipt and panel parts: **structured-memory-read**).
- **structured-memory-writer**:
  `server/src/prompt/memory/structured/{window,writer,prompts,analysis,pages,patches,compact,recordJob}.ts`.
- **structured-memory-read**: `server/src/prompt/memory/structured/{lanes,retrieve,card,step}.ts`,
  `src/lib/Others/StructuredMemory/`, `src/lib/ChatScreens/MemoryReceiptLine.svelte`, and in
  `src/ts/process/structuredMemory.svelte.ts` the receipt and panel functions (`memoryReceiptView`,
  `joinMemoryCoverage`, `memoryItemsUsed`).
- **llm-requests**: `src/ts/process/request/`, `src/ts/process/webllm.ts`, `src/ts/model/`,
  `shared/{llm,llmSecrets}.ts`, `shared/llm/`, `server/src/llm/`, `server/src/routes/llm.ts`,
  `server/src/prompt/tokens.ts`, `server/src/prompt/tokenizers/`, `server/assets/token/`, `src/ts/horde/`,
  `src/ts/{tokenizer,tokenCountField}.ts`, `shared/tokenizerChoice.ts`, `shared/prompt/{chatTokens,imageTokens}.ts`,
  `src/lib/UI/{Model*,NanoGPT*,OpenrouterProviderList}.svelte`,
  `src/lib/Setting/Pages/{Advanced/CustomModelsSettings,ApiKeysSettings}.svelte`,
  `src/lib/UI/GUI/CredentialSelect.svelte`.
- **chat-store**:
  `src/ts/storage/{chatStore.svelte,chatEdits,chatFieldDraft.svelte,localLoreDraft.svelte,loreOverridesDraft.svelte}.ts`,
  `src/ts/checkpoints/`, the hydration memory in `src/ts/network/jobChannel.ts`.
- **resource-sync**: `src/ts/storage/{resourceSync.svelte,resourceClient,bootCache,recordMerge,readDeadline}.ts`,
  `src/ts/network/{eventFeed,socketLiveness}.ts`, `loadData` in `src/ts/bootstrap.ts`.
- **draft-recovery**: `src/ts/storage/{draftJournal,journalEligibility,journalRecovery,recoveryDrafts.svelte}.ts`,
  `chatJournal` in `chatStore.svelte.ts`, the journal part of `resourceSync.svelte.ts`.
- **persistence**: remaining `src/ts/storage/`, `src/ts/toggles/`, `src/ts/chatLoadPages.ts`,
  `shared/{chatCheckpoints,togglePresets}.ts`, `shared/` persisted shapes. `shared/` runtime semantics stay with their
  domain guide.
- **chat-pipeline**: `src/ts/messageSearch.svelte.ts`, `shared/{messageSearch,contextReport,eligibleHistory}.ts`,
  `shared/lore/`, remaining `shared/prompt/` and `src/ts/process/`.
- **cbs-rendering**: `shared/cbs/`, `shared/prompt/toggles.ts`, `src/ts/cbs.ts`, `src/ts/parser/`,
  `src/ts/gui/highlight.ts`, `src/ts/gui/codearea/`, `src/lib/ChatScreens/PartialEditController.svelte`,
  `src/lib/Others/MonacoEditor.svelte`, `src/etc/airisu.cbs`, `src/etc/docs/`.
- **scripts-triggers**: `shared/scripts/`, `shared/triggers.ts`, `server/src/{scripts,lua}/`,
  `src/ts/process/{regexFiles,serverCommands}.ts`, `src/lib/SideBars/Scripts/`,
  `src/lib/Playground/Playground{Regex,Syntax,Parser}.svelte`, `public/lua/`, `src/etc/docs/regex.cbs`.

### Features, shell, and UI

- **diagnostics**: `shared/{requestHistory,diagnostics,diagnosticsReport}.ts`, `server/src/data/requestHistory.ts`,
  `server/src/diagnostics/`, `server/src/routes/{requestHistory,diagnostics}.ts`, `src/ts/diagnostics/`,
  `src/ts/network/requestHistory.ts`, `src/lib/Others/RequestLogs/`,
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`.
- **plugins-mcp**: `src/ts/process/mcp/`, `server/src/mcp/`, `shared/mcp/`, `src/ts/process/dynamicutils/pdf.ts`,
  `shared/plugins.ts`, `src/ts/storage/pluginStorageStore.svelte.ts`, `src/ts/plugins/`, `plugins.md`,
  `src/lib/Setting/Pages/PluginSettings.svelte`, `src/lib/Others/Plugin*.svelte`,
  `src/lib/Playground/PlaygroundMCP.svelte`, `public/plugin_start.7z`.
- **characters-modules**: `src/ts/process/{processzip,modules}.ts`, `shared/{charxImport,moduleImport,rpack}.ts`,
  `src/ts/{characterCards,characters,persona,pngChunk,interchangeability,assetList}.ts`,
  `src/lib/SideBars/CharConfig.svelte`, `src/lib/SideBars/LoreBook/`, `src/lib/Setting/Pages/Module/`,
  `src/lib/Setting/Pages/PersonaSettings.svelte`, `src/lib/Setting/listedPersona.svelte`,
  `src/lib/Others/GridCatalog.svelte`, `src/lib/ChatScreens/AssetInput.svelte`, `src/ts/rpack/`,
  `src/ts/storage/{serverImportClient,moduleImportClient,charxImportClient}.ts`.
- **media-aux**: `src/ts/process/tts*.ts`, `src/ts/process/stableDiff.ts`, `src/ts/translator/`, `shared/translation/`,
  `shared/translatorPresets.ts`, `server/src/translation/`, `src/ts/media/`, `src/ts/voice.ts`, `src/ts/3d/`,
  `src/lib/UI/3DLoader.svelte`, `src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte`,
  `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`, remaining `src/lib/Playground/` tools.
  `src/lib/Playground/PlaygroundMenu.svelte` belongs to **ui-theming**.
- **backup-sync-hub**: `src/ts/drive/`, `src/ts/{realmBlocking,realmTerms}.ts`, `src/ts/storage/realmImportClient.ts`,
  `src/lib/UI/Realm/`, `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`, `server/src/data/upstream/` (its
  workers and staging: **server-resources**), `shared/{upstreamBackup,upstreamExportReport}.ts`; Realm APIs such as
  `getRisuHub` and `downloadRisuHub` in `src/ts/characterCards.ts`.
- **global-api**: `src/ts/globalApi.svelte.ts`, `src/ts/chatFold.svelte.ts`, `src/ts/util.ts`, `src/ts/util/`,
  `src/ts/{alert,alertQueue}.ts`, `shared/{assetBatch,localNetwork,notifications}.ts`,
  `src/ts/storage/{assetClient,assetQueue}.ts`, remaining `src/ts/network/`,
  `src/ts/{dragTypes,sourcemap,iris,licenses}.ts`, `src/lib/Others/{AlertComp,IrisModal}.svelte`.
- **settings-i18n**: `src/ts/setting/`, `src/ts/settingsMenu.ts`, remaining `src/lib/Setting/`, `src/lang/`,
  `src/lib/UI/PromptDataItem.svelte`, `src/lib/Others/PromptDiffModal.svelte`.
- **app-shell**: `index.html`, `src/{main,boot,startApp}.ts`, `src/App.svelte`,
  `src/lib/Others/NodeServerRequired.svelte`,
  `src/ts/{bootstrap,safeBoot,keepAliveAudio,stores.svelte,screenVisibility,pageVisibility.svelte,platform,polyfill,hotkey,ime,defaulthotkeys,observer.svelte,popupEditorSession.svelte,mutex}.ts`,
  `src/ts/router/`, `src/lib/UI/{MainMenu,Title}.svelte`, `src/types.d.ts`, `src/vite-env.d.ts`, `src/etc/patchNote.ts`.
- **ui-theming**: remaining `src/lib/`, `src/styles.css`, `src/ts/gui/`, `shared/greetings.ts`.

### Server, build, and tests

- **server-resources**:
  `server/src/data/{resourceStore,chatStore,chats,kinds,snapshots,archive,checkpointStore,checkpointService}.ts`,
  `server/src/data/{databaseProjection,recordPatchText}.ts`, `server/src/data/{normalize,restore}/`,
  `server/src/http/{spool,fileImport,contentAsset,recordStream}.ts`,
  `server/src/routes/{resources,resourceBoot,llmSecrets,messageSearch,chatCheckpoints}.ts`,
  `server/src/routes/{backups,backupsUpstream,backupsUpstreamExport,importModule,importCharx,importPng,importRealm}.ts`.
- **server-generation**: `server/src/jobs/`, `server/src/data/{changeFeed,generationReceipts}.ts`,
  `server/src/routes/{events,generations,transform,translate,memoryTasks,tokens}.ts`, remaining `server/src/prompt/`.
- **self-host-server**: remaining `server/`, `shared/assetMime.ts`, `Dockerfile`, `server.sh`, `server.bat`.
- **test-harness**: `vitest.*`, `playwright.config.ts`, `e2e/`, `util/playwright/`, `util/agentTest.mjs`,
  `util/agentTestReporter.ts`, `util/agentTestResults.mjs`, `util/agentE2e.mjs`, `util/requireHuman.mjs`,
  `util/overloadTest.mjs`, `util/testInventory.mjs`.
- **build-test-platforms**: `package.json`, `vite.config.ts`, `tsconfig*.json`, remaining `util/`, `public/sw.js`,
  `public/manifest.json`, `version.json`, `src/ts/buildInfo.ts`, `shared/buildInfo.ts`, `server/src/buildInfo.ts`, root
  dotfiles.
- Tests follow the code they exercise; browser harness ownership stays with test-harness.

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

- Focused guides use `Scope`, `Files`, `Flows`, `State`, `Coupling`, `Invariants`, `Recipes`, `Tests`, `Known Hazards`,
  in that order. `###` headings are free within that order: a `##` section over 8,000 bytes is divided by them, each a
  topic an agent would look up, and a topic label is a heading, not a paragraph ending in a colon.
- `Scope` routes the task; `Files` gives paths and lookup identifiers; `Flows` explains ordering; `State` names the
  authoritative records and caches. Describe a contract once and link to it from other sections or guides. Preserve
  heading anchors when moving a topic, or update all referring links.
- Budgets: at most 40,000 bytes per guide, 8,000 under any leaf heading, 600 characters per list item or table row
  (continuation lines and code spans included), and parentheses at most two deep outside code spans. They are the same
  for every guide and this file: `pnpm check:docs` fails on any of them, and
  [build-test-platforms](docs/structure/build-test-platforms.md) `Files` lists its rules.
- A guide's `Tests` section names the harnesses, fakes, and fixtures (what they stand in for, what they control), the
  focused commands for the area, the `slow` and `e2e` memberships, and the gaps (`Not tested`), one bullet per harness.
  It does not list a test file's cases: the file is the inventory, and V4 finds it after a rename.
- A measurement (anything with a date, a browser or Node version, a median, or a byte or millisecond count tied to a
  run) lives in `docs/audit/<topic>-<date>.md`. The guide keeps one sentence with the conclusion that changes how to
  edit the code, and a link.
- Remove inventories and step-by-step paraphrases the source already makes clear. Keep the entrypoint and the
  non-obvious constraint, ownership boundary, or failure behavior an agent needs before editing.
- Keep only cross-cutting rules in this file. Put subsystem contracts and focused test anchors in their owner; link
  across domains instead of copying inventories.
- `Known Hazards` records what can still catch someone working in the subsystem, under up to three subordinate headings,
  in this order (omit an empty one). One bullet holds one kind: split a bullet that mixes them. Fixed issues are
  deleted.
  - `Issues`: remaining defects and advertised but unwired features, to fix. This is the default when no decision to
    keep the behavior is recorded; mark an unreproduced claim `Unconfirmed:`. Delete an entry in the commit that fixes
    it.
  - `Limitations`: behavior the owner chose to keep, or a direct consequence of a recorded design choice. Each entry
    names where that decision is recorded, in one clause at the end of the bullet
    (`Decision: Durable Drafts D7, archive`), not an indented paragraph; when the decision is reversed, the entry moves
    to `Issues`.
  - `Gotchas`: facts that are not defects but cause mistakes: ordering and test-environment rules, unused files that
    look live, measured costs.
- [Found issues](docs/research/found-issues.md) is the inbox for out-of-scope findings that a session could not verify
  or place. Once an entry is re-checked in code and has an owning guide, move it to that guide's `Issues` (or
  `Limitations`, once the owner accepts it) and delete it from the inbox.
- Use paths plus identifiers, without stale line numbers, test counts, or pass guarantees.
- `db.<field>` is a flat persisted `Database` name: client views and server request projections can expose it without
  holding a whole-database object.
- Completed plans and phase chronology belong in [the archive](docs/archived-plan/README.md). Link current guidance to
  current guides; mark historical paths as history.
