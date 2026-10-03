# Slice: Script Transform

Status: landed (13a, the server, and 13b, the client, 2026-10-03).

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

## 13a: what landed

As `docs/structure/self-host-server.md` describes it (`server/src/routes/transform.ts`,
`server/src/prompt/transform.ts`, `server/src/prompt/transformCache.ts`, `shared/transform.ts`).
The plan's decisions, with the changes the 2026-10-03 plan review made:

- The isolated run is a job's setup (`createRunSetup`) on a job that cannot write, ask, or call the
  tab, with frozen bindings (`LuaBindingDeps.frozen`: no store re-read, a chat-variable write changes
  the snapshot's copy only, any other chat write a fatal failure of the target). Each target has its
  own chat object (`scriptstate` copied), owner object, and regex and dynamic-asset caches; the
  messages are shared and never written. The targets of a request share one Lua budget and CBS
  time.
- The run character (the source: Lua `editDisplay`, regex `customscript`, emotions) and the engine
  character (the chat owner: the chat, modules, the display trigger) are separate; the display
  trigger runs on the target's chat owner and chat, groups included (the recorded change).
- The two-call protocol keeps the script-state delta on the server in the snapshot (the slice
  text sent it to the tab and back): the second call sends only the texts after the plugin
  handlers, or a handler's failure per target; it must name every pending target once and claims the
  snapshot before it runs.
- Cache key amendments: no `triggerId` (no display caller has one; the target type has no field);
  `GLGlobalVariables`, `useLocallySetGlobalVariables`, the author's note, the local lore, and the
  chat's name with `scriptstate` (what a render reads of the chat besides its messages); every section and
  collection revision (a broad initial policy: a settings change re-renders); the handler set is the
  tab's per-document value (13b), so entries with handlers are not shared between tabs (hooks are
  anonymous functions; the plugin digest of the amendment cannot be computed).
- Emotions: every `@@emo` of a target in order, kept with a cached result; the tab applies a key's
  once (13b).
- Lifecycle: a request is registered at admission (before it waits for one of 4 slots; 32 may
  wait); a maintenance aborts every request, queued or running, and every snapshot and empties the
  cache, and a request admitted before it never runs after it; one deadline (30 s from the first
  call's admission, the queue included) covers both calls; shutdown waits for the runs before the
  workers go.
- Bounds: a text before the plugin handlers is at most 512 KiB (the second call's limit); a
  snapshot keeps at most 4 MiB of pending texts and 8 MiB of texts plus the variables its targets'
  Lua wrote; 4 snapshots per client and 16 in all. The final text is not bounded beyond the
  cache's 512 KiB entry cap (a larger one is answered, not kept).
- Recorded difference: a Lua image getter of an image that is not an inlay answers `""` in a render
  (no tab is asked).

Deviation (decided at the plan review, for 13b): the CBS pre-pass stays in the browser
(`Chat.svelte`), before the first additional-asset pass, as today. Moving it would need a second
round trip per render or would reorder the asset pass after Lua and regex (their input changes).
The cache is keyed on the text the server receives, so a pre-pass that expands `{{random}}` again
renders afresh, as today; the Safety Contract's "stays as first rendered" applies to the CBS the
server evaluates.

Tests (the review step, 2026-10-03): `server/src/tests/transform.test.ts` (15, the endpoint in
process with the real workers) and `server/src/tests/transformService.test.ts` (12, the lifecycle
over held workers and the cache alone), as `docs/structure/self-host-server.md` lists them. Not
tested separately: `GLGlobalVariables` (hashed with the variables), the preset and persona ids, and
the greeting and background kinds (literal key parts); a handler reload and a hanging plugin are
13b's (they happen in the tab).

## 13b: what landed

As `docs/structure/cbs-rendering.md` and `scripts-triggers.md` describe it
(`src/ts/parser/transformClient.ts`):

- Callers: `ParseMarkdown`'s `editdisplay` (kind `background` for `mode:'back'`, else `message`),
  the translator's `editdisplay` (`translateHTML`, kind `translation`), the HypaV3 modal's and
  the plugin `parseRisuChat`'s `editprocess` (kind `message`; `parseRisuChat` inside a hook
  renders for the hook's chat, preset, and persona). Each captures its context before its first await; a message's render in `ChatBody.svelte` (`markParsing`) captures once at its start and passes the capture to every `ParseMarkdown` and `translateHTML` stage and to its own retries, so a chat, preset, or persona switch during the translation or asset awaits cannot give a later stage another context (challenge 1). Without a context (the flag off, no chat, a chat the server has not stored yet, no preset or persona) the caller keeps `processScriptFull`. The capture is untracked (`untrack`, as `capturePluginContext`): read inside a row's `$derived`, a tracked read of the lock version or the selection re-rendered every mounted row on any message's lock begin or end (found at the review).
- Batching: calls are batched per context, mode, and handler set on the next animation frame, or after 16 ms when frames are withheld (a hidden tab; challenge 4); identical targets share one entry; a batch is split at the server's 64 targets and 4 MiB, and a text over 512 KiB fails alone. Each target is answered as soon as its result is known (a cached result does not wait for another target's plugin handlers). A failed target or request leaves its text as it came in; a batch, its chunks included, shows one toast on its first failure, target errors included (challenge 6); there is no browser fallback on the server path.
- Plugin handlers: each pending text's handlers run in order with the captured plugin context, the texts side by side (as the tab renders messages). A chunk has 28 s for both calls and the handlers, within the server's 30 s, each call bounded as a whole (authentication included). The handlers end 5 s before that deadline: a handler still running then fails its own target, and the finished texts go out in the second call with its error (the handler is not stopped, plugin code cannot be cancelled, but no later handler of that text is started and its late result is ignored) (challenge 2, round 2).
- Streaming: a message locked by a generation skips the transform (the browser steps run on the raw
  text), and `Chat.svelte` renders it again when the lock ends.
- "Re-render": an item of the message menu, shown with the flag on; the message's next render skips
  the server cache (`noCache`) and bumps `ReloadChatPointer[idx]`. The bypass is taken by the first transform actually sent at the new generation (not by a render that captured and then returned early, or a locked one), so an older render still in flight cannot take it (challenge 3, round 2); an answer of an older render applies no emotions.
- Emotions: applied once per tab and result key (forgotten on `resetScriptCache`, and when 4,096 keys were applied: a bounded ledger), never for a
  `simple` character argument (as `applyScriptEffect`), never from an answer older than a
  Re-render.
- Handler set: a per-document nonce, the mode, and a version that changes when the mode's ordered hook list changes (bounded, within the server's 256 characters; challenge 5); results with handlers are not shared between tabs or reloads.
- The client flag `risu.serverTransform` gets a toggle in `DevTool.svelte` next to the generation
  one (not in the plan; the flag had no switch but the console).
- No client cache beyond the server's: a rendered message stays rendered in its row, and a new
  render asks the server, which answers from its cache.

Browser check: `node util/playwright/checkServerTransform.mjs` (a chat with `editdisplay` regex
scripts, a Lua `editDisplay` listener that sets a chat variable, and a display trigger; a mock
provider): with the flag on the greeting and a message are transformed through `/api/transform`,
the Lua variable is not stored, Re-render changes a server-evaluated `{{random}}`, a plugin
`editdisplay` handler makes the second call and its text is rendered, the HypaV3 `editprocess`
runs on the server, a streaming reply shows raw text and the completed one is transformed, and no
page error; with the flag off no transform request is made and the variable is stored as today;
the greeting and the message render the same on both paths. 21/21 on 2026-10-03.

Tests (written at the review): `src/ts/parser/tests/transformClient.test.ts`, `e2e/serverTransform.spec.ts`, and the script-transform golden `e2e/transformGolden.spec.ts` (the whole of `markdown.json` on the flag-off and the server path, the server-evaluated random and clock messages by format; a v2 `display` trigger and both asset passes, flag on against flag off; inlays and dynamic assets not covered, they need stored inlays and an embedding model).
