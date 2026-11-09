# STRUCTURE

RisuAI metatron is a Svelte 5 and TypeScript client that requires its Hono/Node self-host server. The PWA uses the same
server. Start with the task or source path you have.

## Agent Read Protocol

1. For an add/change task, read **Repository-Wide Invariants**.
2. Pick one guide from **Choose By Task**, or run `pnpm docs:owner <path>` for a source file. A folder guide opens its
   README and routes you to a topic.
3. Run `pnpm docs:read <guide>` for the outline, then `pnpm docs:read <guide> <heading>` for `Scope` and the section you
   need. For edits also consult `Invariants`, the relevant `Recipes`, and `Tests`.
4. Read the source contract at the `Files` entry. Follow `Coupling` when the change crosses into another guide.
5. Confirm named identifiers in the current source with `rg -n "<identifier>" <path>`.
6. Run V1 and the focused checks for the affected area.
7. Update the guide when a named file moves or a documented contract changes. For guide or ownership edits, follow
   [Doc Maintenance](docs/structure/README.md). Run targeted Prettier and `pnpm check:docs` (budgets, links, repository
   path spans, ownership rules). Also run `pnpm check:tests` when the slow-test table changes.

## Repository-Wide Invariants

### Tooling

- T1. Use the pnpm version pinned by `packageManager` and the Node version range in `engines` in `package.json`. The
  server runs TypeScript with Node type stripping.
- T2. Vite and Vitest resolve `src/...` to `/src`. Within `shared/`, use relative `.ts` imports and `import type`. Both
  client and strict server projects compile shared code. Keep it free of DOM types, runes and TypeScript syntax that
  requires emitted JavaScript (enums, namespaces, parameter properties).
- T3. Use runes in `*.svelte` and `*.svelte.ts`. Preserve existing boundaries between runes and legacy stores.
- T4. Format changed files with `pnpm format:changed --write` or `pnpm exec prettier --write <files>`.
  `pnpm format:check` checks the repository. All honor `.prettierignore`.
- T5. Comments, test titles, identifiers, and file names describe current behavior and its reason. Keep plan, phase,
  slice, stop, and audit labels in commits or the [plan archive](docs/archived-plan/README.md).

### Verification

- V1. After the last source edit, run `pnpm check` or `pnpm check:changed` and the full `pnpm --silent test:agent` gate.
  A test file edited after that run gets `pnpm check` again (Vitest does not type-check) and its own run, not another
  gate. While iterating, pass affected files or directories to the wrapper. Also run affected slow tests and browser
  specs, and `pnpm build` for build changes. Agents use the wrapper and leave `HUMAN` unset, except for a command the
  wrapper cannot run (listing tests, a flag it lacks). See the [test commands](docs/structure/test-harness.md#recipes).
- V2. Unit tests are `*.test.ts`, colocated or in a sibling `tests/` directory. Vitest defaults to happy-dom. Server
  tests select Node. Domain guides name focused tests and gaps. The [test harness](docs/structure/test-harness.md) owns
  setup, mocks, and the network guard.
- V3. Gate tests run independently of wall time, CPU speed, and scheduling. Control clocks and synchronization. Tag
  tests of real deadlines or performance `slow`. The gate timeout guards against hangs. Add tests only for changed code
  and a plausible wrong implementation they would catch. See [test rules](docs/structure/test-harness.md#test-rules).
- V4. Before committing, `rg` each changed product export and file name across `src`, `server`, `shared`, `public`,
  `util`, `e2e`, and `docs`. Update consumers, including scripts that read source text and guides that name it.
- V5. Report checks that could not start or were skipped as unverified.
- V6. Show a new test fails with the guarded line broken. Reproduce a bug with its regression test before fixing it.
- V7. Mock process and I/O boundaries. When several files mock the same module, share a typed factory in a `tests/`
  directory. Check its defaults against the module's export type with `satisfies`. See
  [mock factories](docs/structure/test-harness.md#mock-factories).
- V8. Keep imports of test code out of product modules. Put test-only helpers in `tests/`. After adding, moving, or
  tagging a test, run `pnpm check:tests` for import boundaries, runner membership, and the slow-test table.
- V9. Tests reading product source as text use `node:fs`. A Vite `?raw` import pulls the text into coverage.

### Data and persistence

- D1. The tab holds settings views, character records, and chat-store state. A legacy `Database` snapshot is a detached
  copy. Route chat writes through `chatStore.svelte.ts`. Carry `Chat.id` and the message's `Message.chatId` across
  awaits. Bind chat fields through getters/setters or a synchronized editing copy.
- D2. Give each persisted field a shared type and an owning record. Settings fields also need ownership in
  `shared/sections.ts` and server defaults or migration in `server/src/data/normalize/`. Boot installs normalized server
  records. Chat and message readers supply defaults for missing fields. Settings views can fall back to tab selection,
  but a send needs all three chat bindings. Keep derived model IDs in sync with slot/profile writes. See
  [persistence](docs/structure/persistence.md) and [LLM requests](docs/structure/llm-requests.md).
- D3. Preserve persisted spellings, including `seperateModels`, `seperateParameters`, `moduleIntergration`, and
  `PresensePenalty`.
- D4. Resource writes carry revision and epoch. Merge independent units and reload on same-unit conflicts, retaining
  eligible work as recovery drafts. Eligible by-ID edits and chat metadata changes can apply on older revisions. See
  `ChatOp` in `shared/chats.ts` for target and revision requirements. Preserve optimistic message IDs and append
  collision refusal. Use `characterStore` for structural character writes and validated mutations at external
  boundaries. See [resource sync](docs/structure/resource-sync.md) and [chat store](docs/structure/chat-store.md).
- D5. Preserve cross-user formats and client/server import parity for cards, modules, presets, translator presets, and
  plugins. Keep persisted discriminators stable and append to `LLMFlags`, `LLMFormat`, `LLMProvider`, and `LLMTokenizer`
  without changing existing values. See [format-specific rules](docs/structure/characters-modules.md#invariants).

### Platform and network

- P1. `src/main.ts` checks `isNodeServer` using `globalThis.__NODE__` injected by Hono or Vite. It imports `boot.ts` on
  the server-backed path and mounts `NodeServerRequired` otherwise. Code beyond this gate assumes server storage and
  networking. See [app shell](docs/structure/app-shell.md).
- P2. The server runs generation and LLM provider requests, except plugin providers and browser WebLLM. The tab receives
  masked credential status and writes `llmSecrets`. In the tab, use `auxFetch` for credentialed LLM auxiliary calls and
  `globalFetch`/`fetchNative` for other remote requests to preserve network policy and logs. See
  [network jobs](docs/structure/network-jobs.md) and [media provider routing](docs/structure/media-aux.md).

### Security

- S1. Sanitize untrusted HTML before `{@html}`. For chat Markdown, follow `ParseMarkdown` with `trimMarkdown` or
  `trimMarkdownSharingStyles` (DOMPurify). Keep custom CSS scoped to `.chattext` and `x-risu-` class names. Safe boot's
  `css` category disables custom CSS and GUI HTML. See [rendering](docs/structure/cbs-rendering.md) and the
  [known Realm sink](docs/research/known-issues.md#backup-sync-hub).
- S2. Preserve the character, module, and trigger `lowLevelAccess` checks on server Lua network/LLM calls and low-level
  trigger effects. See [scripts and triggers](docs/structure/scripts-triggers.md).

### UI

- U1. Use the theme tokens and color families in `src/styles.css` for backgrounds, text, and borders. They support
  opacity modifiers. See [UI and theming](docs/structure/ui-theming.md).
- U2. Add user-visible strings to `src/lang/en.ts`, the source and type. `changeLanguage` merges other locales'
  `DeepPartial` overrides. Components import `{ language } from 'src/lang'`.
- U3. Use `src/ts/alert.ts` helpers for errors and confirmations.
- U4. Screen actions change stores. The router applies URLs to stores and mirrors settled state into history. Resolve
  characters by `selection.characterId`/`selectedCharacter()` and switch with `selectCharacter(chaId)`. `null` is home.
  Carry stable IDs across awaits. See [app shell](docs/structure/app-shell.md).

### Release

- R1. Update `version.json` and `appVer` (`APP_VERSION_POINT` in `src/ts/storage/database.svelte.ts`) together when the
  upstream compatibility release advances in the [ledger](docs/research/upstream-ledger.md). The displayed build ID
  comes from `shared/buildInfo.ts`. See [build and release](docs/structure/build-test-platforms.md).

## Choose By Task

### Chat, models and memory

| Task                                                                                        | Guide                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Send, prompts, lore, slash commands, groups, rerolls, message search and inlays             | [chat-pipeline](docs/structure/chat-pipeline.md)                |
| LLM model catalogues, profiles, slots, credentials, providers, streaming and token counts   | [llm-requests](docs/structure/llm-requests.md)                  |
| SupaMemory, HypaV2/V3, Hanurai, embeddings and memory jobs                                  | [memory](docs/structure/memory.md)                              |
| Structured memory records, projection, writer, selection, lifecycle, rebuild and page tools | [structured-memory](docs/structure/structured-memory/README.md) |
| CBS, Markdown, sanitizing, variables, partial edit, highlighting and display transforms     | [cbs-rendering](docs/structure/cbs-rendering.md)                |
| Translation providers, translator presets, stored translations and bilingual display        | [translation](docs/structure/translation.md)                    |
| TTS, image generation, media compression, auxiliary model selector and playgrounds          | [media-aux](docs/structure/media-aux.md)                        |

### Client, content and extensions

| Task                                                                                         | Guide                                                      |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Boot, safe boot, navigation, URL/history, screen stores, flags and hotkeys                   | [app-shell](docs/structure/app-shell.md)                   |
| Chat/sidebar UI, GUI primitives, portals and theme                                           | [ui-theming](docs/structure/ui-theming.md)                 |
| Settings pages, preset pickers, prompt editor and i18n                                       | [settings-i18n](docs/structure/settings-i18n.md)           |
| Character cards, groups, modules, personas and lore editor                                   | [characters-modules](docs/structure/characters-modules.md) |
| Asset URLs, thumbnails, asset client, queues and batch codec                                 | [assets](docs/structure/assets.md)                         |
| globalApi facade, save entry points, writers, chat fold, utilities, alerts, notices and Iris | [global-api](docs/structure/global-api.md)                 |
| Regex, trigger v2, Lua editors and shared script engines                                     | [scripts-triggers](docs/structure/scripts-triggers.md)     |
| Plugin v3 sandbox, host API, hooks, providers, storage, permissions and reload               | [plugin-sandbox](docs/structure/plugin-sandbox.md)         |
| MCP client registry, internal and remote clients, RisuAccess and tool dispatch               | [mcp](docs/structure/mcp.md)                               |
| Backups, upstream import/export, Realm hub, creator blocking and settings reports            | [backup-sync-hub](docs/structure/backup-sync-hub.md)       |

### Records, synchronization and jobs

| Task                                                                               | Guide                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| Persisted fields, records, settings views, normalization and chat bindings         | [persistence](docs/structure/persistence.md)       |
| Boot cache, save loop, batches, conflicts, merges, credential writes and transport | [resource-sync](docs/structure/resource-sync.md)   |
| Tab feed connection, incoming record/chat changes, feed locks and restore halt     | [live-updates](docs/structure/live-updates.md)     |
| Chat writes, job hydration, chat checkpoints and restore floor                     | [chat-store](docs/structure/chat-store.md)         |
| Draft journal, composer rows, boot recovery and recovery drafts                    | [draft-recovery](docs/structure/draft-recovery.md) |
| Network/proxy, aux fetch, request log, tab job channel, handoff and Web Push       | [network-jobs](docs/structure/network-jobs.md)     |
| Request history, checked failures, push diagnostics, reports and support shares    | [diagnostics](docs/structure/diagnostics.md)       |

### Server, build and repository tools

| Task                                                                                   | Guide                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Hono routes, auth, static serving, assets, thumbnails, proxy, push and Docker          | [self-host-server](docs/structure/self-host-server.md)         |
| Server resource store, chat tables, checkpoints, snapshots, backups and file imports   | [server-resources](docs/structure/server-resources.md)         |
| Server generation jobs, job channel, transforms, LLM and token routes                  | [server-generation](docs/structure/server-generation.md)       |
| Server live-update socket, hello, frame admission, chat entries and publication budget | [live-update-feed](docs/structure/live-update-feed.md)         |
| Build, dev runner, worker/PWA, upstream checks, CI and releases                        | [build-test-platforms](docs/structure/build-test-platforms.md) |
| Test wrapper, slow tests, network guard, Playwright stack and two-client checks        | [test-harness](docs/structure/test-harness.md)                 |
| Guide edits, path ownership, fact ledgers, budgets and issue placement                 | [Doc Maintenance](docs/structure/README.md)                    |

For unfinished work, see [active plans](docs/plan/README.md). Completed plans and retrieval commands are in the
[archive](docs/archived-plan/README.md).

## Path Ownership

`pnpm docs:owner <path>...` uses the first matching rule in `docs/structure/ownership.json` and lists each part of a
shared file. It accepts planned paths. Test rules route to the code or guide they exercise. Browser harnesses route to
test-harness. `pnpm check:changed` reports the owners of changed paths.

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

## Doc Maintenance

For the guide outline, size limits, fact-ledger checks, and issue inbox, see
[Doc Maintenance](docs/structure/README.md).
