# Slice: Script Transform

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 8 (the read-only batch transform
endpoint, the cache, the client integration, "Re-render"); PLAN.md Decision 5 (the display
transform on the server, the isolated context, the two-call plugin protocol, the cache rule, raw
text while streaming).

Depends on: `cbs-and-regex-services`, `trigger-runtime` (Lua `editDisplay` and the `display`
trigger on the server), `script-worker-spike` (the batch and size limits). `job-channel` is not
needed: the transform is a plain request.

## Scope

Allowed files: `server/src/routes/transform.ts` (new), `server/src/prompt/transform.ts` (new:
the per-target isolated run), `server/src/prompt/transformCache.ts` (new), `shared/transform.ts`
(the request and result types), `server/src/app.ts` (registration), `src/ts/parser/parser.svelte.ts`
(`ParseMarkdown` calls the endpoint behind the flag), `src/ts/parser/transformClient.ts` (new:
batching per chat, the client LRU, the streaming bypass), `src/lib/ChatScreens/{Chat,ChatBody,BackgroundDom}.svelte`,
`src/ts/translator/translator.ts` (390), `src/lib/Others/HypaV3Modal/utils.ts` (96),
`src/ts/plugins/apiV3/v3.svelte.ts` (`parseRisuChat` with `processRegex`, 1250-1254),
`src/lang/en.ts`. The client `editdisplay` path stays selectable behind the same client-local
flag until `cutover-and-docs` removes it (the parity gate). Tests belong to the review step.

Identifiers (verified 2026-09-30): `ParseMarkdown(data, charArg = null, mode: "normal" | "back" | "pretranslate" | "notrim", chatID = -1, cbsConditions)`
(`parser.svelte.ts:774-815`; `parseAdditionalAssets` before and after, `processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)`
at 793, inlays, thoughts, style, markdown, `trimMarkdown`). The CBS pre-pass runs before
`ParseMarkdown`: `Chat.svelte:364-371` `msgDisplay = risuChatParser(message, { chara: name, chatID: idx, rmVar: true, visualize: true, cbsConditions })`,
passed to `ChatBody` (690-705) and into `markParsing` (`ChatBody.svelte:269`), so Lua
`editDisplay`, the display trigger, and plugin display handlers receive the expanded text.
Callers: `ChatBody.svelte:102, 105, 141, 146, 156, 171` (messages and translated text;
`getCbsCondition` includes `firstmsg`), `Chat.svelte:333, 335, 782` (417 is a second pre-pass,
767 the raw streaming text), `BackgroundDom.svelte:15`, `Suggestion.svelte:241`,
`AlertComp.svelte:215`, `MultiLangDisplay.svelte:74`, `PlaygroundParser.svelte:8` (no character).
`editprocess` callers: `HypaV3Modal/utils.ts:96`, `v3.svelte.ts:1254` (`parseRisuChat`),
`index.svelte.ts:1063, 1101` (server-side in `prompt-assembly`). `translator.ts:390` calls
`processScriptFull(..., 'editdisplay', chatID)` directly. The display order today: Lua
`editDisplay` (may write chat variables), `runTrigger('display', { displayMode: true, tempVars })`,
`pluginHooks[mode]` (for every mode, `editprocess` included, `scripts.ts:163-170`), CBS, regex;
`@@inject` writes message text (258), `@@emo` sets `CharEmotion` (230-251). `processScriptCache`
(1,000 entries, reset on `ReloadGUIPointer`) caches only the regex step, keyed after CBS
(`scripts.ts:172-183`); Lua, the trigger, and CBS rerun on every render. The previous attempt's
design: `/home/codex/risuai-fastify/docs/structure/intermediate-display.md` (per-target isolated
script state, cache keyed by SHA-256 over canonical dependencies plus the transform version, 512
entries and 16 MiB with a 512 KiB entry cap, a client LRU of 512, streaming rows bypass, JSON
first). Phase 3's drafts keep presets in one `presets` singleton and `presetRegex` as the
forwarded alias of the selected preset's `regex`.

Stopping condition: a display step that needs the DOM on the server; recorded if found.

## Assumptions

- The CBS evaluator takes the viewport and browser language from the request and `trigger_id`
  from the target; the Lua and trigger display modes run on the server inside the worker with a
  discardable variable engine.
- The revisions the cache key needs are readable: the character record, the `modules` singleton,
  the `presets` singleton (or the selected preset's record if Phase 3 ends per-record).

## Proposed decisions

- Endpoint (proposed): `POST /api/transform` with
  `{ mode: "editdisplay" | "editprocess", context: { characterId, chatId?, presetId, personaId }, viewport, language, targets: [{ id, kind: "message" | "greeting" | "background" | "translation" | "text", messageId?, source, prePass?: { rmVar, visualize }, cbsConditions, triggerId? }], pluginHandlers: boolean, noCache?: boolean, phase?: 1 | 2, stateDelta? }`
  answering `{ results: [{ id, text, effects: { emotion? }, cached }] }` as JSON; SSE waits for a
  measured need. Steps per target, mode `editdisplay`: the CBS pre-pass at its current position
  (when `prePass` is given, before the hooks, with the same options `Chat.svelte` uses), Lua
  `editDisplay`, the display trigger, plugin handlers (client), CBS, regex; mode `editprocess`:
  Lua (no-op, as today), plugin handlers (client), CBS, regex. Two-call protocol when
  `pluginHandlers` is true, mode-aware: `phase: 1` runs the stages before the plugin handlers of
  that mode and returns the script-state delta with the intermediate text; the client runs
  `pluginHooks[mode]`; `phase: 2` applies the delta and runs the rest; both calls are bound to the
  same target snapshot (a `snapshotId` the server keeps for 30 s) with persistent setters disabled
  throughout.
- Isolation (proposed): every target runs on a clone of the chat's script state and variables;
  Lua `editDisplay` chat-variable writes and the trigger's temp variables are discarded after the
  target; `@@inject` returns no write; `@@emo` returns `effects.emotion` which `ChatBody` applies
  to `CharEmotion`. This is the Safety Contract item "Rendering is read-only", a change from
  Phase 2's kept upstream behavior.
- Cache identity (proposed): key = chat id, target kind, message id (or the target id for
  non-message kinds), SHA-256 of the source, the `prePass` options, `cbsConditions`, the
  selected preset id, the transform version (which includes the client's registered display
  handler set, so a client with different plugins gets a different version string), the character
  revision, the `modules` revision, the presets revision, a hash of the chat's variables
  (`scriptstate` and the global chat variables it reads), the language, the mode. The viewport is
  a CBS input but not a key: viewport-dependent output stays as first rendered (Decision 5), and a
  resize does not re-render. LRU 512 entries and 16 MiB with a 512 KiB entry cap; `noCache: true`
  bypasses and replaces the entry; `ReloadGUIPointer` bumps clear the client LRU only. This is the
  Safety Contract item "Displayed CBS ... stays as first rendered" and the "Re-render"
  message-menu item (`Chat.svelte`, label in `en.ts`). Chat variables are in the key because
  status panels driven by `{{getvar}}` rerun on every render today; Decision 5's staleness list
  does not include them.
- Client (proposed): `transformClient.ts` batches the mounted rows of one chat per animation
  frame under the worker's batch cap, keeps a 512-entry LRU, and shows the raw text through the
  browser-side steps while `isMessageLocked` reports the row streaming (Safety Contract: "A
  streaming message shows raw text until it completes"); `Chat.svelte`'s pre-pass options travel
  as `prePass` so the server runs it at the same position; `translator.ts:390` and `ChatBody`'s
  `pretranslate` use the `translation` kind; `HypaV3Modal/utils.ts:96` and `parseRisuChat` use
  `editprocess`; `ParseMarkdown` without a character keeps the browser-only steps. A failed
  request renders the unprocessed text and shows one `alertToast` per batch (no browser fallback
  on the server path; the flag-off path is the client's own `processScriptFull`).

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step adds
`server/src/tests/transform.test.ts` (isolation; `@@inject` writes nothing; `@@emo` returned; the
key parts: the same message id in two chats, two presets at one revision, a variable change, a
resize not re-rendering; `noCache`; the two-call delta for both modes bound to one snapshot; the
batch cap; auth) and the second golden test: completed fixture messages with deterministic CBS
render the same HTML through `ParseMarkdown` on both paths, including a hook that distinguishes
literal CBS from expanded text and an `editprocess` plugin handler. Manual: a chat with regex,
Lua `editDisplay`, and a display trigger renders the same; a streaming reply shows raw text then
the transform; "Re-render" changes a `{{random}}` message; a `{{getvar}}` panel updates after a
variable change.

## Residual risk

Time-, random-, viewport-, history-, and persona-dependent CBS stays as first rendered until a
keyed revision changes or the user re-renders (recorded). A background HTML target keyed by the
character revision re-renders on every character edit. Every message re-renders after any chat
variable changes (the variable hash covers the whole chat, not the variables a target reads).
