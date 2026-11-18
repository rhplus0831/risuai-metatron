# STRUCTURE

RisuAI metatron is a Svelte 5 and TypeScript client. Both the browser app and the PWA use the Hono/Node self-host
server.

## Agent Read Protocol

1. For an edit, read **Repository-Wide Invariants**.
2. Pick one guide from **Choose By Task** or look up a file with `pnpm docs:owner <path>`. A folder guide opens its
   topic index.
3. Use `pnpm docs:read <guide>` for the outline and `pnpm docs:read <guide> <heading>...` for the sections you need.
   Start with `Scope`. Quote multiword headings when requesting several sections. For edits, read the relevant
   `Invariants`, `Recipes`, and `Tests`.
4. Follow `Files` to the source contract and `Coupling` to other affected guides.
5. Confirm identifiers in the current source with `rg -n "<identifier>" <path>`.
6. After source edits, run V1 and the area's focused checks.
7. Update the guide if a named file moves or a contract changes. For guide and ownership edits, run targeted Prettier
   and `pnpm check:docs`. A slow-test table edit also needs `pnpm check:tests`. See
   [Doc Maintenance](docs/structure/README.md).

## Repository-Wide Invariants

### Tooling

- T1. Use the pnpm `packageManager` pin and Node `engines` range in `package.json`. The server uses Node type stripping.
- T2. Vite and Vitest resolve `src/...` to `/src`. Both the client and strict server compile `shared/`. Use relative
  `.ts` imports, `import type` and erasable TypeScript there. Keep DOM types and runes in the client.
- T3. Use runes in `*.svelte` and `*.svelte.ts`. Preserve boundaries with legacy stores.
- T4. Format with `pnpm format:changed --write` or `pnpm exec prettier --write <files>`. Run `pnpm format:check` before
  every commit. All three honor `.prettierignore`.
- T5. Comments, test titles, identifiers, and file names describe current behavior and its reason. Keep plan, phase,
  slice, stop, and audit labels in commits or the [plan archive](docs/archived-plan/README.md).

### Verification

- V1. After the last source edit, run `pnpm check` or `pnpm check:changed` and the full `pnpm --silent test:agent` gate.
  A later test-only edit needs `pnpm check` and a run of that file. While iterating, pass affected paths to the wrapper.
  Run affected slow tests and browser specs, and `pnpm build` for build changes. Use the wrapper with `HUMAN` unset
  unless the command needs an unsupported operation such as listing tests. See
  [test commands](docs/structure/test-harness.md#recipes).
- V2. Colocate `*.test.ts` files or put them in a sibling `tests/` directory. Vitest uses happy-dom by default. Select
  Node with `@vitest-environment node`. See the [harness](docs/structure/test-harness.md) for setup, mocks and the
  network guard.
- V3. Control clocks and synchronization so gate tests are independent of elapsed time, CPU speed and scheduling. Tag
  real deadline and performance tests `slow`. Add a test when it catches a plausible regression in changed code. See
  [test rules](docs/structure/test-harness.md#test-rules).
- V4. Before committing, `rg` each changed product export and file name across `src`, `server`, `shared`, `public`,
  `util`, `e2e`, and `docs`. Update consumers, including scripts that read source text and guides that name it.
- V5. Report checks that could not start or were skipped as unverified.
- V6. Show a new test fails with the guarded line broken. Reproduce a bug with its regression test before fixing it.
- V7. Mock process and I/O boundaries. Share repeated module mocks through typed factories in `tests/`. Check defaults
  against the module's exports with `satisfies`. See [mock factories](docs/structure/test-harness.md#mock-factories).
- V8. Keep imports of test code out of product modules. Put test-only helpers in `tests/`. After adding, moving, or
  tagging a test, run `pnpm check:tests` for import boundaries, runner membership, and the slow-test table.
- V9. Tests reading product source as text use `node:fs`. A Vite `?raw` import pulls the text into coverage.

### Data and persistence

- D1. Edit the tab's settings views, character records and chat store. Legacy `Database` snapshots are detached. Route
  chat writes through `chatStore.svelte.ts`. Bind fields through getters/setters or a synchronized editing copy. Pin the
  chat before loading and hold the pin, `Chat.id` and `Message.chatId` across awaits. See
  [chat pins](docs/structure/chat-store.md#pins-and-eviction).
- D2. Give each persisted field a shared type and an owning record. Map settings fields in `shared/sections.ts` and
  default or migrate them in `server/src/data/normalize/`. Boot installs normalized records. Chat and message readers
  default missing fields. Prompt, model and persona settings edit the tab selection. Chat views prefer bound records. A
  send needs all three bound records and any import review complete. Keep derived model IDs in sync with slot/profile
  writes. See [chat binding](docs/structure/persistence.md#chat-binding) and
  [LLM requests](docs/structure/llm-requests.md).
- D3. Preserve persisted spellings, including `seperateModels`, `seperateParameters`, `moduleIntergration`, and
  `PresensePenalty`.
- D4. Resource writes carry revision and epoch. Merge independent units. On same-unit conflicts, reload and retain
  eligible work as recovery drafts. `ChatOp` in `shared/chats.ts` defines which by-ID and metadata edits can apply on
  older revisions. Preserve optimistic message IDs and refuse append collisions. Route structural character writes
  through `characterStore` and validate mutations at external boundaries. See
  [resource sync](docs/structure/resource-sync.md) and [chat store](docs/structure/chat-store.md).
- D5. Preserve client/server import parity and shared file formats for cards, modules, presets, translator presets and
  plugins. Persisted discriminators are stable. `LLMFlags`, `LLMFormat`, `LLMProvider` and `LLMTokenizer` are
  append-only. See [format contracts](docs/structure/characters-modules.md#invariants).

### Platform and network

- P1. Hono or Vite injects `globalThis.__NODE__`. In `src/main.ts`, `isNodeServer` gates the `boot.ts` import and the
  server storage and networking it needs. Other loads mount `NodeServerRequired`. See
  [app shell](docs/structure/app-shell.md).
- P2. The server runs generation jobs, including WebLLM. A job calls a Plugin provider in its owner tab. Standalone tab
  requests run Plugin and WebLLM locally and send other formats to the server. The tab reads masked credential status
  and writes `llmSecrets`. Use `auxFetch` for auxiliary calls with stored LLM credentials and
  `globalFetch`/`fetchNative` for other remote calls. See [LLM requests](docs/structure/llm-requests.md) and
  [network jobs](docs/structure/network-jobs.md).

### Security

- S1. Sanitize untrusted HTML before `{@html}`. `ParseMarkdown` sanitizes normal output. After `notrim` or later HTML
  transforms, apply `trimMarkdown` or `trimMarkdownSharingStyles` to the final chat HTML. Scope message CSS selectors to
  `.chattext` and prefix custom classes with `x-risu-`. Respect safe boot's `css` switch for custom CSS and GUI HTML.
  Realm sanitizes additional hub HTML with `trimMarkdown`. See [rendering](docs/structure/cbs-rendering.md).
- S2. Preserve the character, module, and trigger `lowLevelAccess` checks on server Lua network/LLM calls and low-level
  trigger effects. See [scripts and triggers](docs/structure/scripts-triggers.md).

### UI

- U1. Use the theme tokens in `src/styles.css` for backgrounds, text and borders. They support opacity modifiers. See
  [UI and theming](docs/structure/ui-theming.md).
- U2. Add user-visible strings to `src/lang/en.ts`, the source and type. `changeLanguage` merges other locales'
  `DeepPartial` overrides. Components import `{ language } from 'src/lang'`.
- U3. Use `src/ts/alert.ts` helpers for errors and confirmations.
- U4. Screen actions change stores. The router applies URLs to stores and mirrors settled state into history. Resolve
  characters by `selection.characterId`/`selectedCharacter()` and switch with `selectCharacter(chaId)`. `null` is home.
  Carry stable IDs across awaits. See [app shell](docs/structure/app-shell.md).

### Release

- R1. Update `version.json` and `appVer` (`APP_VERSION_POINT` in `src/ts/storage/database.svelte.ts`) together when the
  upstream compatibility release advances in the [ledger](docs/backlog/upstream-ledger.md). The displayed build ID comes
  from `shared/buildInfo.ts`. See [build and release](docs/structure/build-test-platforms.md).

## Choose By Task

### Chat, models and memory

| Task                                                                                                                   | Guide                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Send, prompt previews, lore activation/stops, OOC, Draft/BTW hooks, slash commands, groups, rerolls, search and inlays | [chat-pipeline](docs/structure/chat-pipeline.md)                |
| Models, profiles, slots, credentials, providers, request interception, streaming and token counts                      | [llm-requests](docs/structure/llm-requests.md)                  |
| Per-chat memory, trim confirmation, SupaMemory, HypaV2/V3, Hanurai, embeddings and background jobs                     | [memory](docs/structure/memory.md)                              |
| Structured Memory records, projection, writer, story dates, prompt lanes, lifecycle, rebuild and page tools            | [structured-memory](docs/structure/structured-memory/README.md) |
| CBS, Markdown, sanitizing, variables, partial edit, highlighting and display transforms                                | [cbs-rendering](docs/structure/cbs-rendering.md)                |
| Translation providers, translator presets, stored translations and bilingual display                                   | [translation](docs/structure/translation.md)                    |
| TTS, image generation, media compression, auxiliary model selector and playgrounds                                     | [media-aux](docs/structure/media-aux.md)                        |

### Client, content and extensions

| Task                                                                                          | Guide                                                      |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Boot, safe boot, navigation, URL/history, screen stores, flags and hotkeys                    | [app-shell](docs/structure/app-shell.md)                   |
| Chat/sidebar UI, message editors, progress window, GUI primitives, portals and theme          | [ui-theming](docs/structure/ui-theming.md)                 |
| Settings navigation, preset pickers, prompt editor, input hook and interception editors, i18n | [settings-i18n](docs/structure/settings-i18n.md)           |
| Character cards and groups, module and persona catalogs, folders and lore editor              | [characters-modules](docs/structure/characters-modules.md) |
| Asset URLs, thumbnails, asset client, queues and batch codec                                  | [assets](docs/structure/assets.md)                         |
| globalApi facade, file writers, chat fold, utilities, alerts, toasts and Iris                 | [global-api](docs/structure/global-api.md)                 |
| Regex, trigger v2, Lua editors, script engines and server command effects                     | [scripts-triggers](docs/structure/scripts-triggers.md)     |
| Plugin v3 sandbox, host API, hooks, providers, storage, permissions and reload                | [plugin-sandbox](docs/structure/plugin-sandbox.md)         |
| MCP client registry, internal and remote clients, RisuAccess and tool dispatch                | [mcp](docs/structure/mcp.md)                               |
| Backups, upstream import/export, Realm hub, creator blocking and settings reports             | [backup-sync-hub](docs/structure/backup-sync-hub.md)       |

### Records, synchronization and jobs

| Task                                                                                                   | Guide                                              |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Persisted fields, records, settings views, field ownership and chat bindings                           | [persistence](docs/structure/persistence.md)       |
| Boot cache, save entry points and loop, batches, conflicts, merges, credential writes and transport    | [resource-sync](docs/structure/resource-sync.md)   |
| Tab feed connection, incoming records and chats, generation progress, feed locks and restore halt      | [live-updates](docs/structure/live-updates.md)     |
| Chat writes, editor drafts across remounts, job hydration, chat checkpoints and restore floor          | [chat-store](docs/structure/chat-store.md)         |
| Draft journal, composer rows, boot recovery and recovery drafts                                        | [draft-recovery](docs/structure/draft-recovery.md) |
| Tab fetch and proxy, request log, job channel, device handoff, remote send and host commands, Web Push | [network-jobs](docs/structure/network-jobs.md)     |
| Request history, checked failures, push and remote reload diagnostics, reports and support shares      | [diagnostics](docs/structure/diagnostics.md)       |

### Server, build and repository tools

| Task                                                                                                        | Guide                                                          |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Hono routes, auth, static serving, assets, thumbnails, proxy, remote command relay, push and Docker         | [self-host-server](docs/structure/self-host-server.md)         |
| Server resource store, normalization, chat tables, checkpoints, snapshots, backups and file imports         | [server-resources](docs/structure/server-resources.md)         |
| Generation jobs, prompt assembly, plugin callbacks, completion push holds, transforms, LLM and token routes | [server-generation](docs/structure/server-generation.md)       |
| Server live-update socket, hello, frame admission, chat entries and publication budget                      | [live-update-feed](docs/structure/live-update-feed.md)         |
| Build and dev runners, headless host CLI, docs tools, worker/PWA, upstream checks, CI and releases          | [build-test-platforms](docs/structure/build-test-platforms.md) |
| Test wrapper, slow tests, network guard, Playwright stack and two-client checks                             | [test-harness](docs/structure/test-harness.md)                 |
| Guide edits, path ownership, fact ledgers, budgets and issue placement                                      | [Doc Maintenance](docs/structure/README.md)                    |

For unfinished work, see [active plans](docs/plan/README.md). Completed plans and retrieval commands are in the
[archive](docs/archived-plan/README.md).

## Path Ownership

`pnpm docs:owner <path>...` prints the first matching guide in `docs/structure/ownership.json`. For shared files it also
names the other guides and their parts. It accepts planned paths. Tests route to the area they exercise, and browser
harnesses to test-harness. `pnpm check:changed` reports the owners of changed paths.

Search-excluded payloads in `.ignore` are `server/assets/token/`, `public/plugin_start.7z`, `src/etc/docs/`, and
`src/ts/rpack/`. For intentional searches of these paths, follow [AGENTS.md](AGENTS.md).

## Glossary

- **CBS** evaluates expressions such as `{{fn::arg}}` through `risuChatParser`. A **lorebook** supplies
  keyword-activated context with `@@` decorators.
- A **prompt preset** (`botPreset`, `.risup`) holds prompts, parameters, and ordered `PromptItem[]`. A **model preset**
  selects profiles through slots. A **model profile / Connection** holds the model ID, key binding, endpoint, and
  compatibility options. Unset **aux model** slots fall back to the sub slot.
- A **named API key** has metadata in `credentials` and its value in write-only `llmSecrets.credentials`.
- A **module** (`RisuModule`, `.risum`) can supply lore, scripts, assets, and MCP servers. A **persona** holds the
  user's name, icon and prompt, and can embed a module.
- An **inlay** combines `inlays` metadata with an asset, referenced by `{{inlay::id}}`. An **asset** is a logical key
  such as `assets/<hash>.<ext>` read and written through asset helpers.
- **Realm / Hub** is the card service reached through the GET-only `/hub-proxy`. **Iris** is the built-in assistant
  using RisuAccess MCP tools.
- A **resource epoch** identifies the active database. A restore or import that replaces the database invalidates older
  mutation tokens. A **revision** identifies one record's stored version. See
  [epoch rules](docs/structure/server-resources.md#epoch-and-response-rules).

## Doc Maintenance

For the guide outline, size limits, fact-ledger checks, and issue inbox, see
[Doc Maintenance](docs/structure/README.md).

Last full audit on 2026-11-18 covered this index, Doc Maintenance and all 37 guides at `744d17cad`.
[Audit report](docs/reports/audits/structure-audit-2026-11-18.md).
