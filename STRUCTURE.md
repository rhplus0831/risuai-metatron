# STRUCTURE

Agent-oriented map of this repository (RisuAI fork "metatron"): a Svelte 5 + TypeScript AI
roleplay chat client served only by its Hono (Node) self-host server, installable as a PWA. There is
no standalone browser build (the client without the server shows only a notice), and no desktop
(Tauri) or mobile (Capacitor) build. Anchors are `path` + identifier. Line numbers are deliberately omitted because
they drift. Grep the identifier instead.

Last full audited: 2026-09-27.
Last scoped updated: 2026-10-03 (Phase 5 cutover: generation, scripts, and provider calls on the server).

## Agent Read Protocol

1. Read this file's **Repository-Wide Invariants** fully. They apply to every change.
2. Pick the one guide that owns your task from **Choose By Task**. If you were handed a file path
   instead of a task, use **Path Ownership** below.
3. In that guide, read `Scope`, then `Invariants`, then only the `Files`, `Flows`, or `Recipes`
   entries you need. Do not load every guide.
4. Open a second guide only if the first guide's `Coupling` section names it for your change.
5. Treat every claim as a pointer to verify. Confirm an identifier with `rg -n "<identifier>"`
   before you edit around it.
6. Before finishing, run the verification commands from Invariant V1, plus the tests listed in
   the guide's `Tests` section.
7. If you move or rename a file or identifier that a guide names, update that guide in the same
   change. Guides live in `docs/structure/`.

## Repository-Wide Invariants

Tooling

- T1. Use `pnpm` (`packageManager: pnpm@10.34.1`, Node `>=24.0.0`; the self-host server runs its
  TypeScript directly through Node type stripping).
- T2. Import alias `src/...` resolves to `/src` in both Vite and Vitest (`vite.config.ts` and
  `vitest.config.ts` `resolve.alias`). Both alias imports and relative imports are used; match the
  surrounding file. The root `shared/` folder has no alias: import it by a relative path with the
  `.ts` extension (`tsconfig.json` sets `allowImportingTsExtensions`). It holds the shapes and the
  runtime modules both sides compile (`shared/cbs/`, `shared/scripts/`, `shared/lore/`,
  `shared/prompt/`, `shared/llm/`, `shared/mcp/`, `shared/triggers.ts`); the server runs them for
  generation, the tab for its editors, previews, and rendering pre-pass.
- T3. Svelte 5 runes (`$state`, `$derived`, `$effect`) may appear only in `*.svelte` and
  `*.svelte.ts` files. Legacy `writable` stores coexist with runes, so follow the local file's
  pattern and do not convert store boundaries casually.
- T4. Prettier is the formatter (`.prettierrc.json`, `.prettierignore`, with
  `prettier-plugin-svelte`). Run `pnpm format` on the files you change; `pnpm format:check` must
  pass. Vendor payloads from `.ignore` and `src/ts/plugins/apiV3/risuai.d.ts` are excluded.

Verification

- V1. `pnpm check` (svelte-check, about 20 s) and `pnpm test` (`vitest run`, happy-dom, about 5 s)
  are the standard gates. `pnpm build` bundles. The service worker and the Vite dev proxy have no
  automated tests and need manual verification; server routes are covered by `server/src/tests/*.test.ts`.
- V2. Tests are `*.test.ts`, colocated next to the code or in a sibling `tests/` folder.
  `vitest.setup.ts` mocks KaTeX, replaces `safeStructuredClone` with a JSON clone, and patches
  happy-dom's `Node.prototype.nodeName` getter for DOMPurify (see `build-test-platforms.md`).

Data and persistence (details: `docs/structure/persistence.md`)

- D1. The live database is the single rune `DBState.db` (`src/ts/stores.svelte.ts`), the client's
  mirror of the server resources (`shared/resources.ts`; loaded in `bootstrap.ts:loadData`). Its
  shapes (`Database`, `character`, `groupChat`, `Chat`, `Message`, `botPreset`) live in
  `shared/database.ts` and are re-exported by `src/ts/storage/database.svelte.ts`. `shared/` is
  compiled by both the client and the strict server project: no DOM types, runes, or enums, and
  only relative `.ts` imports between `shared/` files (`persistence.md`). `character.chats` and
  `chatPage` are read-only mirror fields (`DeepReadonly`): only the chat module
  (`src/ts/storage/chatStore.svelte.ts`) writes them, and every chat change goes through its
  functions (`appendMessage`, `setMessageText`, `setChatMeta`, `applyChatResult`, ...), addressed by
  chat id and message id (`Message.chatId`), never by index after an await. Svelte `bind:` on a
  chat field bypasses the type check: bind a getter/setter pair or a synced editing copy. Beside
  it, the mutation modules own the other records for the external contracts (plugins, MCP,
  imports; since the Phase 5 cutover Lua and triggers run on the server and write through their job): `characterStore.svelte.ts` (characters by `chaId`), `collectionStore.svelte.ts`
  (settings sections, collections, presets, modules, plugins), and `pluginStorageStore.svelte.ts`.
  A contract never assigns into `DBState.db`; the core-app UI still does until Phase 6.
- D2. A new persisted field needs a type entry and a place in `shared/sections.ts`. A section or
  collection field gets its default and migration in its server normalizer
  (`server/src/data/normalize/`), never in `setDatabase`: the client's projection must equal the
  server's normalized text. The flat preset and persona fields of `DBState.db` and the selection
  indexes (`FORWARDED_ROOT_KEYS`) are accessors that read and write the selected preset or persona,
  or this client's selection (`src/ts/storage/forwarding.svelte.ts`): never `delete` one, and write
  them synchronously (a value copied back from an `$effect` can land after a switch). The section,
  collection, `botPresets`, `modules`, `plugins`, and `pluginCustomStorage` fields are accessors onto
  the settings records (`records.svelte.ts`). `setDatabaseLite` moves a fresh object's record fields
  into the records, installs the accessors, and does not normalize. Chat and message fields
  are the exception: they are stored as the client sends them (the server normalizer in
  `server/src/data/chats.ts` fills only `name`, `note`, `localLore`, and `fmIndex`), so readers default a
  missing chat field where they read it.
- D3. Never rename persisted keys, including misspelled ones: `seperateModels`,
  `seperateParameters`, `moduleIntergration`, `PresensePenalty`. Saved databases and shared files
  depend on them.
- D4. The database lives in server resources (the Phase 3 sections and collections, `presets`,
  `modules`, `plugins`, `pluginStorage`, one `characters` record per `chaId` without its chats) and in chat records (one
  per chat, messages as rows, one chat order per character); the save adapter
  (`src/ts/storage/resourceSync.svelte.ts`, started by `saveDb`) saves the settings records
  (`src/ts/storage/records.svelte.ts`: the sections, the collections, `presets`, `modules`,
  `plugins`, `pluginStorage`) and the character records (one per `chaId`, without its chats), which
  mark themselves on every local write through `DBState.db`'s accessors, and sends the chat module's
  queued ops. Add, replace, or remove a character only through `characterStore.svelte.ts`: a
  structural write through `DBState.db.characters` throws. Every write names the revision and epoch
  it was based on; a stale one reloads that record, except chat ops that address one message by id
  (and per-field chat metadata), which still apply to an older chat revision while that message
  exists. Message ids are assigned optimistically by the client; the server keeps them, renames a
  colliding id only inside a whole-chat payload, and refuses an `append` that reuses an id with
  other content (409).
- D5. Shared artifacts are cross-user formats: character cards (`.png` `chara`/`ccv3`, `.json`,
  `.charx`), modules (`.risum`), presets (`.risup`/`.risupreset`), translator presets (`.risutl`),
  and plugin scripts. Keep old readers working. Never renumber `LLMFlags`, `LLMFormat`,
  `LLMProvider`, or `LLMTokenizer`, and never rename discriminators such as `customscript.type`,
  trigger effect `type`, or `PromptItem.type`.

Platform and network (details: `docs/structure/global-api.md`)

- P1. The client runs only when served by the self-host server. `isNodeServer` in
  `src/ts/platform.ts` reads `globalThis.__NODE__`, which `server/src/app.ts` (`/` and `/index.html`)
  and the Vite dev server (`vite.config.ts` plugin `risu-node-flag`) inject. `src/main.ts` checks it
  once: when false it mounts `NodeServerRequired.svelte` and never imports the app (`src/boot.ts`).
  Do not add browser-only storage or network branches; everything past `main.ts` may assume the
  server is present. `isMobile` is user-agent based.
- P2. LLM provider calls run on the server (Phase 5): a send is a server job, and the tab's own
  requests (`requestChatData`) go to `POST /api/llm/request`, except a plugin provider model and a
  browser WebLLM model, which run in the tab by design; a call that needs a stored credential
  goes through `auxFetch` (`/proxy2` auxiliary operations). The tab never holds an LLM credential
  (`llmSecrets` is write-only). Other outbound HTTP goes through `globalFetch` (buffered) or
  `fetchNative` (streaming/bytes) in `src/ts/globalApi.svelte.ts`. They handle proxying (same-origin
  `/proxy2`), the userscript transport, local-network policy, and request logs. Do not call raw
  `fetch` for provider or remote calls.

Security

- S1. Any HTML that comes from users, models, cards, modules, or plugins renders via
  `ParseMarkdown` and `trimMarkdown` (DOMPurify) in `src/ts/parser/parser.svelte.ts` before
  `{@html}`. CSS stays scoped (`.chattext` and the `x-risu-` class prefix). Custom CSS is
  suppressed in safe mode (`SafeModeStore`).
- S2. Low-level capabilities (Lua network/LLM calls, low-level trigger effects; run by the server's
  Lua and trigger runtime) are gated by `lowLevelAccess` on characters, modules, and triggers. Do not
  widen these gates.

UI conventions (details: `docs/structure/ui-theming.md`, `docs/structure/settings-i18n.md`)

- U1. Style with theme tokens from `src/styles.css` (`bg-bgcolor`, `bg-darkbg`, `bg-darkbutton`,
  `bg-selected`, `text-textcolor`, `text-textcolor2`, `border-borderc`, `border-darkborderc`,
  `text-draculared`, `primary|secondary|danger|neutral|success-50..900`). Opacity modifiers such
  as `text-textcolor/90` are fine. Avoid raw gray/black colors.
- U2. User-visible strings go in `src/lang/en.ts`, which is both the source and the type. Other
  locales are `DeepPartial` and fall back to English through `changeLanguage` in
  `src/lang/index.ts`. Components use `import { language } from 'src/lang'`.
- U3. User-facing errors and confirmations go through `src/ts/alert.ts` (`alertError`,
  `alertConfirm`, `alertSelect`, `alertInput`, ...), not `window.alert`.
- U4. There is no router. The screen is chosen by ordered conditionals in `src/App.svelte` and
  `src/lib/ChatScreens/DefaultChatScreen.svelte`, driven by stores. `selectedCharID === -1`
  means the home screen. `selectedCharID` is an index view of the selected character's id
  (`selection.characterId`, per tab); select by id with `selectCharacter`.

Release

- R1. The app version lives in two places: `version.json` and `appVer` in
  `src/ts/storage/database.svelte.ts` (marked `APP_VERSION_POINT`). `package.json` `version`
  (1.0.0) is unused.

## Choose By Task

| Task                                                                                                                                 | Guide                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Startup order, top-level screen selection, global stores, platform flags, hotkeys                                                    | `docs/structure/app-shell.md`            |
| `globalFetch`/`fetchNative`, proxy routing, assets (`saveAsset`/`loadAsset`), alerts, `util.ts` helpers                              | `docs/structure/global-api.md`           |
| Add or migrate a DB field, save format, storage backends, autosave                                                                   | `docs/structure/persistence.md`          |
| Sending a message (the tab's job client), prompt template items, lorebook activation, slash commands, inlays, group chat, reroll     | `docs/structure/chat-pipeline.md`        |
| Long-term memory (SupaMemory, HypaV2/V3, Hanurai), embeddings, HypaV3 modal                                                          | `docs/structure/memory.md`               |
| Add a model or provider, request/stream parsing, tool calls, parameters, tokenizers, aux-model routing                               | `docs/structure/llm-requests.md`         |
| CBS `{{...}}` functions, message rendering/markdown/sanitization, chat variables, partial edit, editor highlighting                  | `docs/structure/cbs-rendering.md`        |
| Regex scripts, triggers v2, Lua scripting (the editors and the shared engine; the runtime is the server's)                           | `docs/structure/scripts-triggers.md`     |
| Plugin API (v3 iframe sandbox), plugin providers/hooks, MCP tools                                                                    | `docs/structure/plugins-mcp.md`          |
| Character cards import/export, characters/groups CRUD, modules, personas, lorebook editor UI                                         | `docs/structure/characters-modules.md`   |
| Chat screen components, sidebar, GUI primitives, popups/portals, theme/colors                                                        | `docs/structure/ui-theming.md`           |
| Settings pages, declarative settings registry, bot presets, prompt template editor, i18n                                             | `docs/structure/settings-i18n.md`        |
| TTS, image generation, translation, media compression, playground tools                                                              | `docs/structure/media-aux.md`            |
| Local backups, Realm hub browse, settings report export                                                                              | `docs/structure/backup-sync-hub.md`      |
| Self-host server (Hono on Node) routes/auth/storage/proxies, generation jobs, prompt assembly, the Lua/trigger/regex runtime, Docker | `docs/structure/self-host-server.md`     |
| Scripts, Vite/Vitest config, test inventory, service worker, version bump                                                            | `docs/structure/build-test-platforms.md` |

## Path Ownership

The first matching row wins. Scan from the top.

| Path                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Guide                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `src/ts/process/memory/`, `src/ts/process/transformers.ts`, `src/lib/Others/HypaV3*`, `src/lib/Playground/PlaygroundEmbedding.svelte`                                                                                                                                                                                                                                                                                                                                 | memory                                  |
| `src/ts/process/request/`, `src/ts/process/webllm.ts`, `src/ts/model/`, `shared/llm/`, `server/src/llm/`, `server/src/routes/llm.ts`, `src/ts/horde/`, `src/ts/tokenizer.ts`, `shared/tokenizerChoice.ts`, `shared/prompt/chatTokens.ts`, `src/lib/UI/Model*.svelte`, `src/lib/UI/NanoGPT*`, `src/lib/UI/OpenrouterProviderList.svelte`, `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte`                                                                 | llm-requests                            |
| `src/ts/process/mcp/`, `server/src/mcp/`, `shared/mcp/`, `src/ts/plugins/`, `plugins.md`, `src/lib/Setting/Pages/PluginSettings.svelte`, `src/lib/Others/Plugin*.svelte`, `src/lib/Playground/PlaygroundMCP.svelte`                                                                                                                                                                                                                                                   | plugins-mcp                             |
| `shared/scripts/`, `shared/triggers.ts`, `src/ts/process/regexFiles.ts`, `src/ts/process/serverCommands.ts`, `src/lib/SideBars/Scripts/`, `src/lib/Setting/Pages/GlobalRegex.svelte`, `src/lib/Playground/Playground{Regex,Syntax,Parser}.svelte`, `public/lua/`                                                                                                                                                                                                      | scripts-triggers                        |
| `src/ts/storage/`, `src/ts/chatLoadPages.ts`, `shared/` (shapes; semantics stay with the original module's guide)                                                                                                                                                                                                                                                                                                                                                     | persistence                             |
| `src/ts/process/processzip.ts`, `src/ts/process/modules.ts`, `src/ts/characterCards.ts`, `src/ts/characters.ts`, `src/ts/persona.ts`, `src/ts/pngChunk.ts`, `src/ts/interchangeability.ts`, `src/lib/SideBars/CharConfig.svelte`, `src/lib/SideBars/LoreBook/`, `src/lib/Setting/Pages/Module/`, `src/lib/Setting/Pages/PersonaSettings.svelte`, `src/lib/Setting/listedPersona.svelte`, `src/lib/Others/GridCatalog.svelte`, `src/lib/ChatScreens/AssetInput.svelte` | characters-modules                      |
| `src/lib/Playground/PlaygroundMenu.svelte`                                                                                                                                                                                                                                                                                                                                                                                                                            | ui-theming                              |
| `src/ts/process/tts*.ts`, `src/ts/process/stableDiff.ts`, `src/ts/translator/`, `src/ts/media/`, `src/ts/voice.ts`, `src/ts/3d/`, `src/lib/Playground/` (the remaining tools), `src/lib/UI/3DLoader.svelte`, `src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte`, `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`                                                                                                                                 | media-aux                               |
| `shared/lore/`, `shared/prompt/` (except `chatTokens.ts`), `src/ts/process/` (everything else: `index.svelte.ts`, `prompt.ts`, `lorebook.svelte.ts`, `templates/`, `files/`, `command.ts`, ...)                                                                                                                                                                                                                                                                       | chat-pipeline                           |
| `shared/cbs/`, `src/ts/cbs.ts`, `src/ts/parser/`, `src/ts/gui/highlight.ts`, `src/ts/gui/codearea/`, `src/lib/ChatScreens/PartialEditController.svelte`, `src/lib/Others/MonacoEditor.svelte`                                                                                                                                                                                                                                                                         | cbs-rendering                           |
| `src/ts/drive/`, `src/lib/UI/Realm/`, `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte`                                                                                                                                                                                                                                                                                                                                                                   | backup-sync-hub                         |
| `src/ts/globalApi.svelte.ts`, `src/ts/util.ts`, `src/ts/util/`, `src/ts/alert.ts`, `src/ts/network/`, `src/ts/dragTypes.ts`, `src/ts/sourcemap.ts`, `src/ts/iris.ts`, `src/ts/licenses.ts`, `src/lib/Others/AlertComp.svelte`, `src/lib/Others/IrisModal.svelte`                                                                                                                                                                                                      | global-api                              |
| `src/ts/setting/`, `src/lib/Setting/` (the rest), `src/lang/`, `src/lib/UI/PromptDataItem.svelte`, `src/lib/Others/{PromptDiffModal,AllSeperateParameters,QuickSettingsGUI}.svelte`, `src/lib/Others/ProTools/`                                                                                                                                                                                                                                                       | settings-i18n                           |
| `index.html`, `src/main.ts`, `src/boot.ts`, `src/lib/Others/NodeServerRequired.svelte`, `src/App.svelte`, `src/ts/bootstrap.ts`, `src/ts/stores.svelte.ts`, `src/ts/platform.ts`, `src/ts/polyfill.ts`, `src/ts/hotkey.ts`, `src/ts/defaulthotkeys.ts`, `src/ts/observer.svelte.ts`, `src/ts/mutex.ts`, `src/lib/UI/MainMenu.svelte`, `src/lib/UI/Title.svelte`                                                                                                       | app-shell                               |
| `src/lib/` (everything else), `src/styles.css`, `src/ts/gui/`                                                                                                                                                                                                                                                                                                                                                                                                         | ui-theming                              |
| `server/`, `Dockerfile`, `server.sh`, `server.bat`                                                                                                                                                                                                                                                                                                                                                                                                                    | self-host-server                        |
| `package.json`, `vite.config.ts`, `vitest.*`, `tsconfig*.json`, `public/sw.js`, `public/manifest.json`, `util/`, `version.json`                                                                                                                                                                                                                                                                                                                                       | build-test-platforms                    |
| `src/types.d.ts`, `src/vite-env.d.ts`, `src/etc/patchNote.ts`                                                                                                                                                                                                                                                                                                                                                                                                         | app-shell                               |
| `src/etc/airisu.cbs`, `src/etc/docs/`                                                                                                                                                                                                                                                                                                                                                                                                                                 | cbs-rendering                           |
| `public/token/`, `src/etc/o200k_base.json` (tokenizer data)                                                                                                                                                                                                                                                                                                                                                                                                           | llm-requests                            |
| `public/assets/` (Bergamot translator workers and wasm)                                                                                                                                                                                                                                                                                                                                                                                                               | media-aux                               |
| `public/plugin_start.7z`                                                                                                                                                                                                                                                                                                                                                                                                                                              | plugins-mcp                             |
| `src/ts/rpack/` (vendored RPack codec, used by `.risum`, `.risup`, and `.risutl`)                                                                                                                                                                                                                                                                                                                                                                                     | characters-modules                      |
| `*.test.ts`, `tests/`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the guide that owns the code under test |

Search-excluded payloads (root `.ignore`): `public/assets/`, `public/token/`,
`public/plugin_start.7z`, `src/etc/docs/`, `src/etc/o200k_base.json`, `src/ts/rpack/`. Use a
targeted path to read them.

## Glossary

| Term                                   | Meaning                                                                                                           | Guide              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
| CBS                                    | Curly-brace syntax `{{fn::arg}}` template language evaluated by `risuChatParser`                                  | cbs-rendering      |
| Lorebook / loreBook                    | Keyword-activated context entries (global/character, chat-local, module), with `@@` decorators                    | chat-pipeline      |
| Prompt template                        | `DBState.db.promptTemplate: PromptItem[]`, the ordered prompt cards                                               | chat-pipeline      |
| Regex script (`customscript`)          | Find/replace rules run in `editinput`/`editoutput`/`editprocess`/`editdisplay` (plus `edittrans` for translation) | scripts-triggers   |
| Trigger v2 (`triggerscript`)           | Event-driven effect lists; v2 is a flat array with `indent` blocks and a header sentinel at index 0               | scripts-triggers   |
| Module (`RisuModule`, `.risum`)        | Bundle of lorebook/regex/trigger/assets/MCP, enabled globally, per chat, per character, or via a persona          | characters-modules |
| Persona                                | User identity (name/icon/prompt), optionally with an embedded module                                              | characters-modules |
| Bot preset (`.risup`)                  | Serializable subset of model/prompt settings (`botPreset`)                                                        | settings-i18n      |
| Inlay                                  | Image/media stored on the server (`inlays` resource + asset) and referenced in chat text as `{{inlay::id}}`       | chat-pipeline      |
| Asset                                  | Card media stored as `assets/<hash>.<ext>` through `saveAsset`, referenced by path                                | global-api         |
| SupaMemory / HypaV2 / HypaV3 / Hanurai | Long-term memory and summarization algorithms                                                                     | memory             |
| Aux model / submodel                   | Secondary model for memory/emotion/translate/`otherAx`, selected via `seperateModels`                             | llm-requests       |
| Realm / Hub                            | Card browse and download service (`hubURL`, `realm.risuai.net`); Node proxies it via `/hub-proxy` (GET only)      | backup-sync-hub    |
| Iris                                   | Built-in assistant modal using the RisuAccess MCP tools                                                           | global-api         |
| Playground                             | Tool screens selected by `PlaygroundStore` (tokenizer, Jinja, subtitles, ...)                                     | media-aux          |

## Dead, Placeholder, or Unwired Code

Do not extend these without first confirming intent.

- `src/lib/ChatScreens/Message.svelte`: unfinished rewrite (template is `TODO`), unused.
- `src/lib/UI/GUI/SyntaxHighlightedTextarea.svelte` and `src/lib/Playground/PlaygroundRegex.svelte`:
  0-byte files.
- `src/lib/UI/3DLoader.svelte`, `src/ts/3d/threeload.ts`, `src/ts/voice.ts`,
  `src/etc/patchNote.ts`: no importers.
- `src/ts/gui/codearea/cbsMonaco.ts`: `registerCBSMonaco` is empty. CBS highlighting is
  `src/ts/gui/highlight.ts`.
- `src/lib/Setting/Pages/GlobalRegex.svelte`: edits `DBState.db.globalscript`, which the regex
  runtime never applies. The runtime uses `presetRegex`.
- `memoryAlgorithmType`: written by the settings UI, never read. The memory branch is chosen by
  boolean flags.

## Doc Maintenance

- Guides use fixed sections: `Scope`, `Files`, `Flows`, `State`, `Coupling`, `Invariants`,
  `Recipes`, `Tests`, `Known Hazards`. Keep that order so agents can jump by heading.
- `Known Hazards` lists observed but unfixed defects. When you fix one, remove its entry.
- Name identifiers, not line numbers.
