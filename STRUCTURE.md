# STRUCTURE

Agent map for the RisuAI metatron fork: a Svelte 5 + TypeScript client served by
its Hono/Node self-host server, installable as a PWA. The client requires that
server; standalone static hosting, Tauri, and Capacitor are not supported.

Documentation audit: 2026-10-17. Paths and identifiers are lookup anchors; verify
current code before changing it. Test results belong to the current run, not this map.

## Agent Read Protocol

1. Read **Repository-Wide Invariants** below.
2. Choose one owner in **Choose By Task**, or use **Path Ownership** for a supplied path.
3. Read that guide's `Scope` and `Invariants`, then the relevant `Files`, `Flows`, or `Recipes`.
4. Follow its `Coupling` links only when the change crosses a boundary. Do not load every guide.
5. Confirm the named identifier with a bounded `rg -n "<identifier>" <path>` before editing.
6. Run V1's gates and the affected guide's focused checks.
7. Update the owning guide when moving a named file or changing a documented contract.

## Repository-Wide Invariants

Tooling:

- T1. Use `pnpm` (`packageManager: pnpm@10.34.1`) and Node `>=24.0.0`.
  The server runs TypeScript through Node type stripping.
- T2. `src/...` resolves to `/src` in Vite and Vitest; match surrounding import style.
  `shared/` has no alias. Imports between shared modules use relative `.ts` paths and `import type` for
  types. Shared code runs in both client and strict server projects: no DOM types,
  runes, enums, namespaces, or parameter properties. See [persistence](docs/structure/persistence.md).
- T3. Svelte runes belong only in `*.svelte` and `*.svelte.ts`. Legacy stores coexist
  with runes; preserve established store boundaries.
- T4. Format changed files with `pnpm exec prettier --write <files>` and honor
  `.prettierignore`; `pnpm format:check` is the repository formatting check.

Verification:

- V1. Run `pnpm check` and `pnpm --silent test:agent`. Run affected slow tests with
  `pnpm --silent test:agent --tags-filter=slow`, or `--all` when both sets are needed.
  The agent wrapper caches by working tree and arguments; `--force` reruns.
  Plain `test`, `test:slow`, `test:all`, direct Vitest, and `test:e2e` are human/CI
  commands; agents do not set `HUMAN` to bypass their gate. Build changes also need
  `pnpm build`. Commands, harness details, slow-test selection, and browser tooling:
  [build-test-platforms](docs/structure/build-test-platforms.md).
- V2. Unit tests are `*.test.ts`, colocated or in sibling `tests/` directories.
  Vitest defaults to happy-dom; server tests select Node. The setup mocks KaTeX,
  replaces `safeStructuredClone` with a JSON clone, and patches happy-dom for DOMPurify.
  Domain guides own focused test paths and coverage gaps.

Data and persistence:

- D1. The client holds resource records, not a whole `Database`: settings views,
  character records, and the chat module are its live state. Legacy snapshots are
  detached copies. All chat writes go through `chatStore.svelte.ts`, addressed by
  chat id and message id (`Message.chatId`), never an index after an await. Bind chat
  fields through getter/setter functions or a synced editing copy.
- D2. A persisted field needs its shared type, ownership in `shared/sections.ts`,
  and server defaults/migration in `server/src/data/normalize/`. Boot installs the
  server's records without client normalization. Chat/message fields are stored
  largely as sent; default missing values at their readers. Settings views follow
  the open chat's bound records when available, then tab selection; a send requires
  all three chat bindings and never uses that fallback. Model ids are derived from
  slots/profiles and are written synchronously. Details: [persistence](docs/structure/persistence.md)
  and [LLM requests](docs/structure/llm-requests.md).
- D3. Preserve persisted spellings, including `seperateModels`, `seperateParameters`,
  `moduleIntergration`, and `PresensePenalty`.
- D4. Resource writes carry revision and epoch. Stale whole-record writes reload;
  by-id message operations and per-field chat metadata can apply to an older chat
  revision while their targets exist. Preserve optimistic message ids and append
  collision refusal. Add/remove/replace characters through `characterStore`; a
  structural write through the character-list wrapper throws. External contracts
  use the validated mutation modules. Save/conflict rules: [persistence](docs/structure/persistence.md).
- D5. Cards (`.png` `chara`/`ccv3`, `.json`, `.charx`), modules (`.risum`), presets
  (`.risup`/`.risupreset`), translator presets (`.risutl`), and plugin scripts are
  cross-user formats. Preserve old readers. The server's `.risum` reader
  (`shared/moduleImport.ts`, `POST /api/import/module`) is a second reader of that
  format: keep it byte-compatible with `exportModuleLegacy` and `readModule`. The
  server's CharX reader (`shared/charxImport.ts`, `POST /api/import/charx`) is a
  second reader of `.charx`/`charxJpeg`: it delimits entries by the central directory
  where the in-tab `CharXImporter` scans for signatures (the intended difference); both
  apply the same entry rules. The server's PNG card reader
  (`server/src/routes/importPng.ts`, the Realm import) is a second reader of `.png`
  cards: keep its chunk rules, asset bytes and keys (base64 decoded by the tab's `buffer`
  package), and trimmed image byte-identical to `PngChunk.readGenerator` and
  `importCharacterProcess`; it refuses more than the tab does (no PNG signature, a
  truncated chunk, no card chunk, size and count caps: the intended difference). Never
  renumber `LLMFlags`, `LLMFormat`, `LLMProvider`, `LLMTokenizer`, or rename persisted
  discriminator values.

Platform and network:

- P1. Only `src/main.ts` gates on `isNodeServer` (`globalThis.__NODE__`, injected by
  Hono or Vite). It imports `boot.ts` only with the server present; otherwise it
  mounts `NodeServerRequired`. Code past that gate assumes the server exists.
  Do not add browser-only storage/network branches. `isMobile` is user-agent based.
- P2. Generation and provider requests run on the server; plugin providers and
  browser WebLLM are explicit exceptions. The tab never reads LLM credential
  values (`llmSecrets` is write-only). Credentialed auxiliary operations use
  `auxFetch`; other remote calls use `globalFetch`/`fetchNative`, preserving proxy,
  local-network policy, and logs. See [global-api](docs/structure/global-api.md).

Security:

- S1. Untrusted user/model/card/module/plugin HTML passes through `ParseMarkdown`
  and `trimMarkdown` (DOMPurify) before `{@html}`. Keep CSS scoped to `.chattext`
  and `x-risu-`; safe mode suppresses custom CSS.
- S2. Server Lua network/LLM calls and low-level trigger effects require the
  relevant character/module/trigger `lowLevelAccess` gates. Do not widen them.

UI:

- U1. Use theme tokens from `src/styles.css` (`bg-bgcolor`, `bg-darkbg`,
  `bg-darkbutton`, `bg-selected`, `text-textcolor`, `text-textcolor2`,
  `border-borderc`, `border-darkborderc`, `text-draculared`, and the
  `primary|secondary|danger|neutral|success-50..900` families). Opacity modifiers
  are supported; avoid raw gray/black colors.
- U2. User-visible strings belong in `src/lang/en.ts`, the source and type.
  Other locales are `DeepPartial` overrides merged by `changeLanguage`.
  Components import `{ language } from 'src/lang'`.
- U3. Use `src/ts/alert.ts` helpers for errors and confirmations.
- U4. Stores choose the screen; the URL router applies URLs to them and mirrors
  settled changes into history. Screen actions change stores. Resolve characters
  by `selection.characterId`/`selectedCharacter()` and use `selectCharacter(chaId)`;
  `null` is home. Never retain a list index as an asynchronous address.
  See [app-shell](docs/structure/app-shell.md).

Release:

- R1. Update both `version.json` and `appVer` (`APP_VERSION_POINT`) in
  `src/ts/storage/database.svelte.ts`. `package.json`'s version is unused.

## Choose By Task

Guide links below are the current ownership map, including behavior once described
by completed plans. [Active plans](docs/plan/README.md) describe unfinished work;
[migration history](docs/archived-plan/README.md) records completed plans and retrieval commands.

| Task                                                                             | Guide                                                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Boot, screen selection, URL/history, stores, flags, hotkeys                      | [app-shell](docs/structure/app-shell.md)                       |
| Network/proxy transport, assets, alerts, utility helpers                         | [global-api](docs/structure/global-api.md)                     |
| Request history, checked failures, diagnostics, reports, support shares          | [diagnostics](docs/structure/diagnostics.md)                   |
| Persisted fields, resource records, normalization, save/live sync, chat bindings | [persistence](docs/structure/persistence.md)                   |
| Send/job client, prompt cards, lore, commands, inlays, groups, reroll            | [chat-pipeline](docs/structure/chat-pipeline.md)               |
| SupaMemory, HypaV2/V3, Hanurai, embeddings                                       | [memory](docs/structure/memory.md)                             |
| Model catalogues/profiles/slots, credentials, adapters, streaming, tokens        | [llm-requests](docs/structure/llm-requests.md)                 |
| CBS, markdown/sanitization, chat variables, partial edit, highlighting           | [cbs-rendering](docs/structure/cbs-rendering.md)               |
| Regex, triggers v2, Lua editors/shared engines                                   | [scripts-triggers](docs/structure/scripts-triggers.md)         |
| Plugin v3 sandbox/providers/hooks, MCP                                           | [plugins-mcp](docs/structure/plugins-mcp.md)                   |
| Cards/characters/groups, modules, personas, lore editor                          | [characters-modules](docs/structure/characters-modules.md)     |
| Chat/sidebar UI, GUI primitives, portals, theme                                  | [ui-theming](docs/structure/ui-theming.md)                     |
| Settings registry/pages, preset editing/pickers, prompt editor, i18n             | [settings-i18n](docs/structure/settings-i18n.md)               |
| TTS, images, translation, media, playground tools                                | [media-aux](docs/structure/media-aux.md)                       |
| Backups, Realm hub, settings report                                              | [backup-sync-hub](docs/structure/backup-sync-hub.md)           |
| Hono routes/auth/storage, generation/runtime services, Docker                    | [self-host-server](docs/structure/self-host-server.md)         |
| Scripts/config, test harness, browser tooling, worker/PWA, releases              | [build-test-platforms](docs/structure/build-test-platforms.md) |

## Path Ownership

Apply the specific ownership below before the fallback directories. Guide names
refer to **Choose By Task**; each guide's `Files` section has identifiers.

- **diagnostics**: `shared/{requestHistory,diagnostics,diagnosticsReport}.ts`,
  `server/src/data/requestHistory.ts`, `server/src/diagnostics/`,
  `server/src/routes/{requestHistory,diagnostics}.ts`, `src/ts/diagnostics/`,
  `src/ts/network/requestHistory.ts`, `src/lib/Others/RequestLogs/`,
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`.
- **memory**: `src/ts/process/memory/`, `src/ts/process/transformers.ts`,
  `src/lib/Others/HypaV3*`, `src/lib/Playground/PlaygroundEmbedding.svelte`.
- **llm-requests**: `src/ts/process/request/`, `src/ts/process/webllm.ts`,
  `src/ts/model/`, `shared/llm/`, `server/src/llm/`, `server/src/routes/llm.ts`,
  `src/ts/horde/`, `src/ts/tokenizer.ts`, `shared/tokenizerChoice.ts`,
  `shared/prompt/chatTokens.ts`, `src/lib/UI/{Model*,NanoGPT*,OpenrouterProviderList}.svelte`,
  `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`,
  `src/lib/Setting/Pages/ApiKeysSettings.svelte`, `src/lib/UI/GUI/CredentialSelect.svelte`,
  `public/token/`, `src/etc/o200k_base.json`.
- **plugins-mcp**: `src/ts/process/mcp/`, `server/src/mcp/`, `shared/mcp/`,
  `src/ts/plugins/`, `plugins.md`, `src/lib/Setting/Pages/PluginSettings.svelte`,
  `src/lib/Others/Plugin*.svelte`, `src/lib/Playground/PlaygroundMCP.svelte`,
  `public/plugin_start.7z`.
- **scripts-triggers**: `shared/scripts/`, `shared/triggers.ts`,
  `src/ts/process/{regexFiles,serverCommands}.ts`, `src/lib/SideBars/Scripts/`,
  `src/lib/Playground/Playground{Regex,Syntax,Parser}.svelte`, `public/lua/`.
- **persistence**: `src/ts/storage/`, `src/ts/chatLoadPages.ts`, `shared/` persisted
  shapes. Runtime semantics in `shared/` stay with their domain guide.
- **characters-modules**: `src/ts/process/{processzip,modules}.ts`,
  `src/ts/{characterCards,characters,persona,pngChunk,interchangeability,assetList}.ts`,
  `src/lib/SideBars/CharConfig.svelte`, `src/lib/SideBars/LoreBook/`,
  `src/lib/Setting/Pages/Module/`, `src/lib/Setting/Pages/PersonaSettings.svelte`,
  `src/lib/Setting/listedPersona.svelte`, `src/lib/Others/GridCatalog.svelte`,
  `src/lib/ChatScreens/AssetInput.svelte`, `src/ts/rpack/`.
- **media-aux**: `src/ts/process/tts*.ts`, `src/ts/process/stableDiff.ts`,
  `src/ts/translator/`, `src/ts/media/`, `src/ts/voice.ts`, `src/ts/3d/`,
  `src/lib/UI/3DLoader.svelte`,
  `src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte`,
  `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`, remaining `src/lib/Playground/`
  tools. `src/lib/Playground/PlaygroundMenu.svelte` belongs to **ui-theming**.
- **chat-pipeline**: `shared/lore/`, remaining `shared/prompt/` and `src/ts/process/`.
- **cbs-rendering**: `shared/cbs/`, `src/ts/cbs.ts`, `src/ts/parser/`,
  `src/ts/gui/highlight.ts`, `src/ts/gui/codearea/`,
  `src/lib/ChatScreens/PartialEditController.svelte`, `src/lib/Others/MonacoEditor.svelte`,
  `src/etc/airisu.cbs`, `src/etc/docs/`.
- **backup-sync-hub**: `src/ts/drive/`, `src/lib/UI/Realm/`,
  `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`.
- **global-api**: `src/ts/globalApi.svelte.ts`, `src/ts/util.ts`, `src/ts/util/`,
  `src/ts/alert.ts`, remaining `src/ts/network/`,
  `src/ts/{dragTypes,sourcemap,iris,licenses}.ts`,
  `src/lib/Others/{AlertComp,IrisModal}.svelte`.
- **settings-i18n**: `src/ts/setting/`, remaining `src/lib/Setting/`, `src/lang/`,
  `src/lib/UI/PromptDataItem.svelte`, `src/lib/Others/PromptDiffModal.svelte`.
- **app-shell**: `index.html`, `src/{main,boot,startApp}.ts`, `src/App.svelte`,
  `src/lib/Others/NodeServerRequired.svelte`,
  `src/ts/{bootstrap,stores.svelte,platform,polyfill,hotkey,defaulthotkeys,observer.svelte,mutex}.ts`,
  `src/ts/router/`, `src/lib/UI/{MainMenu,Title}.svelte`, `src/types.d.ts`,
  `src/vite-env.d.ts`, `src/etc/patchNote.ts`.
- **ui-theming**: remaining `src/lib/`, `src/styles.css`, `src/ts/gui/`.
- **self-host-server**: remaining `server/`, `Dockerfile`, `server.sh`, `server.bat`.
- **build-test-platforms**: `package.json`, `vite.config.ts`, `vitest.*`,
  `tsconfig*.json`, `playwright.config.ts`, `e2e/`, `util/`, `public/sw.js`,
  `public/manifest.json`, `version.json`, root dotfiles.
- Tests follow the code they exercise; browser harness ownership stays with build-test-platforms.

Search-excluded payloads (`.ignore`): `public/token/`, `public/plugin_start.7z`,
`src/etc/docs/`, `src/etc/o200k_base.json`, `src/ts/rpack/`. Use a targeted path
for those payloads; follow [AGENTS.md](AGENTS.md) for search flags.

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

- Focused guides use `Scope`, `Files`, `Flows`, `State`, `Coupling`, `Invariants`,
  `Recipes`, `Tests`, `Known Hazards`, in that order. Use subordinate headings for detail.
- Keep only cross-cutting rules in this file. Put subsystem contracts and focused
  test anchors in their owner; link across domains instead of copying inventories.
- `Known Hazards` records observed remaining defects or unwired code, not fixed issues.
- Use paths plus identifiers, without stale line numbers, test counts, or pass guarantees.
- `db.<field>` is a flat persisted `Database` name: client views and server request
  projections can expose it without holding a whole-database object.
- Completed plans and phase chronology belong in [the archive](docs/archived-plan/README.md).
  Link current guidance to current guides; mark historical paths as history.
