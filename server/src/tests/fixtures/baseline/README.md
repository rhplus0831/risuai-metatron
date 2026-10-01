# Phase 5 baseline fixtures

The golden values the Phase 5 server path is compared against, captured once from the **browser
path as it was before slice 3** (commit `efad2b76`, the Stop A state: slices 1 and 2 only added
server files the client does not load). They were captured by
`util/playwright/capturePhase5Baseline.mjs` from the client's own functions on the Vite dev stack
(`util/playwright/stack.mjs`: a fresh server working directory, so an empty `save/`) in a headless
system Chrome, and never derived from server code. `provenance.json` records the commit, the Chrome,
Playwright, and wasmoon versions, the page errors, and every request the capture blocked or served
locally.

The expectations in these files come from the client; a server test that disagrees with one has
found a difference to attribute, not a fixture to overwrite. Approved deltas (defect fixes, Safety
Contract changes) are separate reviewed expected-delta files, as the implementation plan says.

## Files

| File                | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Consumer (plan)                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `scenario.json`     | The seed the capture applied, verbatim: the environment, the base settings, the personas, the two extra presets (`normalizePreset` input), every character with its chats and messages (explicit `chaId`, chat `id`, message `chatId`), the per-fixture settings, the markdown hooks, the token configurations, the lore regex scenarios, and the `igp` send. A server test rebuilds the same state from it.                                                                                                                                                                    | every golden test                                                      |
| `prompts.json`      | Per prompt fixture: `formated`, the `OpenAIChat[]` the DevTool preview shows (`sendChat(-1, { preview: true })` then `previewFormated`), and `selectedPresetName`. `jinja` also has `instruct` (the `applyChatTemplate` renders: `jinja` through the database template, then `chatml`, `mistral`, `alpaca`) and `previewBody` (`sendChat(-1, { previewPrompt: true })`: the Ooba request body with the Jinja-rendered prompt).                                                                                                                                                  | `assemble.test.ts` (slice 9), `lore.test.ts` (slice 4)                 |
| `markdown.json`     | `ParseMarkdown` HTML and the `editprocess` text of the greeting and every message of the `Mark` chat, `withoutHooks` and `withHooks` (plugin hooks registered on `pluginHooks`). Per message: `direct` (`ParseMarkdown(data, char, "normal", index, cbsConditions)`), `prePass` (the `Chat.svelte` pre-pass `risuChatParser(data, { chara: name, chatID, rmVar: true, visualize: true, cbsConditions })`: its `text`, then its `html` through `ParseMarkdown`), `back` (mode `"back"`), and `editprocess` (`processScript(char, data, "editprocess", cbsConditions, chatRef)`). | the `script-transform` golden test (slice 13), `cbs.test.ts` (slice 3) |
| `token-counts.json` | `routing`: `encode(text)` per model configuration (ids for `ascii` and `mixed`, ids or the thrown error for `special`, count and FNV-1a hash for `long`), with the `LLMTokenizer` name `getModelInfo` resolved. `prompts`: per prompt fixture and tokenizer family, the token count of every `formated` message's `content` and their total.                                                                                                                                                                                                                                    | `tokens.test.ts` (slice 4)                                             |
| `lore-regex.json`   | `loadLoreBookV3Prompt(ref)` on regex-keyed lore: per scenario the messages, the lore keys, the `actives` (source, prompt, position, depth, role), and the `matchLog`.                                                                                                                                                                                                                                                                                                                                                                                                           | `lore.test.ts` (slice 4): the lore regex defect                        |
| `igp.json`          | A real send with `igpPrompt` set, through a mock plugin provider: the provider calls (`mode`, `max_tokens`, `prompt_chat`) and the chat's messages afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                  | slice 11: the `igp` defect                                             |
| `provenance.json`   | The commit, versions, page errors, blocked and locally served requests, and the preset ids of the run (the only file that differs between two captures).                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                                        |

## Expected deltas (`deltas/`)

The capture files above stay as captured. An approved behavior change (a defect fix, a Safety
Contract change) gets a reviewed expected-delta file here, which names the scenarios it changes,
the value after the change, and why the change produces it; a test takes the delta where it has an
entry and the capture everywhere else. The re-capture (`node util/playwright/capturePhase5Baseline.mjs`)
does not write this folder.

| File                               | What it holds                                                                                                                                                                                                                                                                                                                                                                   | Consumer                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lore-regex-fix.json`              | The lore regex key fix of slice 4 (owner answer 10): the three `lore-regex.json` scenarios whose `actives` and `matchLog` change (`i-flag-plain-text`, `empty-flags-plain-text`, `i-flag-two-messages-match-second`), each with the reason the fixed parse (split at the last `/`, empty flags allowed, no rewrite in place) produces it, and why the other four do not change. | `src/ts/process/lorebookRegexBaseline.test.ts` (the client), `lore.test.ts` (the server)                                                          |
| `lore-regex-fix-prompts.json`      | The same fix in `prompts.json`: the `lore` fixture's `formated` after the fix (`Loremaster`'s two regex entries, `/dragon/` and `/dragon/i`, as system messages at indexes 12 and 13), with the reason they activate and why they land there; the other four prompts are unchanged.                                                                                             | `lore.test.ts` (the activation that produces the two entries, and the delta's consistency with the capture); slice 9's prompt golden test         |
| `lore-regex-fix-token-counts.json` | The same fix in `token-counts.json`: per family, the `lore` prompt's `perMessage` with the two entries' counts at indexes 12 and 13 and the grown `total`; `routing` and the other prompts are unchanged.                                                                                                                                                                       | `tokens.test.ts` (recounts the two messages per family with the server's tokenizers against `inserted`, and checks the delta against the capture) |

## The fixture characters (`scenario.json`)

- **`plain`** (`Aria`, `chat-aria-1`): the legacy `formatingOrder` path (no prompt template), model
  `reverse_proxy` (consecutive system prompts merge), a card system prompt with `{{original}}`, a
  `replaceGlobalNote`, personality, scenario, example messages (`<START>`, `{{char}}:`, `<bot>:`),
  a `depth_prompt`, an author's note, and the chat bound to the persona `Mina` (`{{user}}` is
  `Mina`, the persona prompt is hers).
- **`group`** (`Council`: `Bram`, `Cora`, `orderByOrder`): the preview is the first speaker's
  prompt (`Bram`). The group's own `globalLore` is used; `Bram`'s member lore (`bram-lore`, key
  `council`, present in the chat) is not, although `useCharacterLore` is `true`.
- **`presetChain`** (`Aria` again, `presetChain: "Alpha, Beta, Missing"`): with the seeded
  `Math.random` the chain picks `Alpha` (`selectedPresetName`), whose other fields are
  `normalizePreset` defaults (the default jailbreak text, no template).
- **`jinja`** (`Jin`, model `ooba`, `instructChatTemplate: "jinja"`, a custom `JinjaTemplate`
  using `risu_char` and `risu_user`).
- **`lore`** (`Loremaster`, model `gemini-3-flash-preview`, so prompts do not merge, with the
  prompt template `LORE_PROMPT_TEMPLATE`: main with `{{position::custom}}`, description, persona,
  authornote with `innerFormat`, lorebook, chat, jailbreak, chatML, cot, globalNote, cache,
  postEverything): one entry per insertion position (`before_desc`, `after_desc`, `personality`,
  `scenario`, `@@end`, `@@depth 0` as assistant, `@@depth 2` as user, `@@reverse_depth 1`,
  `pt_custom`, `@@inject_at main`, `@@inject_at description` + `@@inject_prepend`,
  `@@inject_lore normal`, always active, `@@priority`, `@@match_full_word`, `@@role user`, a
  recursive entry, a selective entry, a chat-local entry, an unmatched entry) and two regex entries
  (`/dragon/i`, `/dragon/`) that the chat's `dragon` does **not** activate (the defect below).

## How nondeterminism was controlled

- **Random.** `Math.random` is replaced by a seeded mulberry32 PRNG (`context.addInitScript`),
  re-seeded with `randomSeed` before every capture unit (`{{random}}`, `{{dice}}`, `{{randint}}`,
  the `presetChain` pick, `@@probability`).
- **Time.** `page.clock.setFixedTime(fixedTime)` after boot: `Date.now()` and `new Date()` are
  constant (`{{date}}`, `{{time}}`, `{{unixtime}}`, message `time`, `lastInteraction`); timers keep
  running. Message times are explicit anyway.
- **Viewport, timezone, locale.** The browser context has `viewport` 1280×720, `timezoneId` UTC,
  and `locale` en-US (`{{screenwidth}}`, `{{screenheight}}`, `{{metadata::browserlanguage}}`).
- **Settings.** `baseSettings` is written before every unit (preset fields through the forwarding
  accessors of the selected preset, `Default`), then the unit's own settings; everything not listed
  is the fresh-boot default at the commit. `useTokenizerCaching` is off; `dynamicAssets` is off.
- **Ids.** Characters, chats, messages, and personas carry explicit ids (checked after seeding);
  preset ids are generated and recorded in `provenance.json` (no fixture contains them).
- **Network.** Every request to a host other than `localhost` is answered 500 (the KaTeX stylesheet
  and a Google Fonts stylesheet were the only ones). The client's Lua runtime fetches
  `https://unpkg.com/wasmoon@1.16.0/dist/glue.wasm` at run time (`scriptings.ts`
  `makeLuaFactory`, a bare `new LuaFactory()`); the capture answers it with the installed package's
  `node_modules/wasmoon/dist/glue.wasm` of the same version. No provider is called: the previews
  return before the request layer, `previewBody` returns the body instead of sending it, and the
  `igp` send uses a plugin provider registered on `pluginHooks.providers`.
- **Plugin hooks.** The markdown hooks and the `igp` provider are plain functions registered on
  `pluginHooks` (the seam `processScriptFull` and `requestPlugin` read), not a plugin loaded through
  the v3 iframe sandbox. Each hook appends a marker saying whether it received literal CBS or
  expanded text, so `direct` shows `[display-hook:literal-cbs]` and `prePass` shows
  `[display-hook:expanded]` on messages whose CBS the pre-pass expands.
- **Order.** The units run seed, markdown, lore regex, `igp`, prompts (`lore` last, because a prompt
  template, once set, cannot be unset through the accessors), tokens.
- **Double capture.** The capture ran twice (two fresh stacks and browser contexts); every file
  except `provenance.json` was identical by parsed content (`JSON.parse`, then `JSON.stringify`).

## Defects pinned here (the "before" evidence, implementation plan question 10)

- **`igp` appends the response object** (`src/ts/process/index.svelte.ts`, the `igp` block after
  auto-continue): `igp.json` shows the reply as `Reply from the mock provider.[object Object]` and
  the second provider call (`mode: "emotion"`) with the parsed `igpPrompt`. Fixed in slice 11.
- **Lore regex keys** (`src/ts/process/lorebook.svelte.ts`, `searchMatch`, the `arg.regex`
  branch): `lore-regex.json` shows that `/dragon/i` does not match `A dragon appears.` and
  `/dragon/` (empty flags) matches nothing, because the key is rewritten to `/dragon` (the leading
  slash stays in the pattern), so `/dragon/i` matches only the literal `/dragon`
  (`i-flag-slash-in-text`); and because the rewrite lands in `arg.keys[0]`, a second message is
  scanned with the rewritten key, whose "flags" are now the pattern text, which throws and ends the
  search (`i-flag-two-messages-match-second` matches nothing although the second message contains
  `/dragon`). `prompts.json` (`lore`) shows the two regex entries absent from the prompt. Fixed in
  slice 4: the expected delta is `deltas/lore-regex-fix.json`, and the client-side pin
  `src/ts/process/lorebookRegexBaseline.test.ts` now asserts the fixed behavior through it.
- **`decodeToolCall`** (`src/ts/process/mcp/mcp.ts`) and **the MCP OAuth refresh**
  (`src/ts/process/mcp/mcplib.ts`, `oauthLogin`) are pure client functions, so they are pinned as
  Vitest tests against the client code instead of browser fixtures:
  `src/ts/process/mcp/tests/phase5BaselineDefects.test.ts`. Fixed in slices 11 and 12.

## Other behavior worth knowing when comparing

- In a group, the user's messages are wrapped as `<Unknown Character's Message>` with the
  `groupOtherBotRole` role (`prompts.json`, `group`): a message without `saying` resolves to the
  "Unknown Character" placeholder, which is not the speaker, so the other-speaker branch applies.
- `{{date}}` and `{{time}}` are unpadded (`2026-10-1`, `12:0:0`); `{{getvar}}` reads
  `scriptstate["$" + key]`; an unknown CBS function stays literal.
- A regex `out` ending in `>` gets a newline appended (`<em>$1</em>` renders `<em>Mark</em><br>`),
  and the `em` script consumes the first asterisk pair of `**bold**`.
- The Lua `editDisplay` hook of `Mark` appends ` [lua:<index>]` (`-1` for the greeting); the
  `Chat.svelte` pre-pass runs before it, so its marker is in both `direct` and `prePass`.
- Two Llama 3 paths: a custom model declaring `LLMTokenizer.Llama3` counts with `cl100k_base`
  (`routing["custom-model-llama3"]` equals `custom-model-cl100k`), while `reverse_proxy` with
  `customTokenizer: "llama3"` counts with the `llama` SentencePiece model
  (`routing["reverse-proxy-llama3"]` equals `ooba-llama`); `encodeWithTokenizer(text, "llama3")`
  (the `llama3` family of `../tokens/browser-ids.json`) is a third result. The tiktoken families
  throw `The text contains a special token that is not allowed: <|endoftext|>` on `special`.
  Per-family token ids for fixed strings are in `../tokens/browser-ids.json` and are not repeated
  here.
- `DefaultChatScreen.svelte` logs `Cannot read properties of undefined (reading 'length')` while a
  group is selected (groups have no `alternateGreetings`; `createNewGroup` makes them that way).
  It does not affect the captures.

## Not captured

- A v2 `display` trigger: `processScriptFull` runs it on the selected character, which the capture
  selects, but the fixture character has none (slice 8b owns the trigger runtime; its display run
  is a recorded behavior change).
- Inlays, additional assets, and dynamic assets: they need stored assets and `HypaProcesser`
  (slice 10).
- The `@@repeat_back` null dereference: slice 3's own fixture.

## Re-capture

`node util/playwright/capturePhase5Baseline.mjs` writes this folder (an `outDir` argument writes
elsewhere, for example to compare two runs). A difference from the checked-in files after a client
change is a behavior change to attribute and record, not a fixture to overwrite silently.
