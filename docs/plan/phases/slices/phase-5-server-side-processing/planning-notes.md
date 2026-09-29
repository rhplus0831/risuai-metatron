# Planning notes: Phase 5 (Server-Side Processing)

## Provenance

Drafted 2026-09-30 on `metatron` at `577c43ae`, before the phase started, as a validation of
[`phase-5-server-side-processing.md`](../../phase-5-server-side-processing.md) against the tree
after Phases 0 to 2; reviewed by GPT-6-Astra (18 points) and Claude Opus (14 points); refined the
same day. The decision on every review point is in [`review-decisions.md`](review-decisions.md);
the slices and their order are in [`README.md`](README.md). Every identifier and line number below
was verified on that commit; at phase start each slice's Assumptions are re-verified.

## Drift between the phase file and the tree

Each item names what the phase file says, what the tree shows, and the proposed phase-file edit.

1. **`cbs.ts:201`.** The direct `CurrentTriggerIdStore` read is at `src/ts/cbs.ts:222` (import at
   6); the viewport reads are `window.innerWidth` (1520) and `innerHeight` (1530); a third direct
   host read the phase file does not name is `navigator.language` at 2096 (`metadata`). Edit:
   name all three and "move all three behind callbacks".
2. **"50 of the current 51 host functions in `scriptings.ts`".** The tree has 56 `declareAPI`
   registrations and 54 unique names (`getCharacterLastMessage` and `getUserLastMessage` twice,
   1123/1162 and 1144/1183). The previous runtime
   (`/home/codex/risuai-fastify/server/fastify/src/prompt/luaRuntime.ts`, present) declares all
   54 current names (multi-line `declare(` calls) and rejects multimodal `LLM`,
   `getCharacterImage`, and `getPersonaImage` as unsupported. Edit: "That runtime declares all 54
   current host functions; it rejects multimodal `LLM`, `getCharacterImage`, and
   `getPersonaImage`, which this phase supports."
3. **The wasmoon timeout mechanism, and the worker.** The phase file says "the per-chunk budget
   is the runtime's own instruction hook over `lua_sethook`"; wasmoon's built-in count hook is
   exposed through `createEngine({ functionTimeout })` and `thread.run(0, { timeout })`, the
   previous runtime uses both and adds no hook (its design note 80-99; `runStringWithTimeout`
   2349-2382). That deadline is wall-clock and counts time spent awaiting a host promise
   (`node_modules/wasmoon/dist/index.js:144-180`), and a C-level operation is not interrupted
   until control returns to Lua. The port source's note also says "No `worker_threads` fallback
   is needed" (93-94), against Decision 5's bounded, terminable worker; wasmoon 1.16.0 offers
   `traceAllocations` plus `setMemoryMax` (`global.d.ts:15-17`) that neither uses. Edit to step 6:
   "wasmoon bounds JS-to-Lua calls with `functionTimeout` and a loaded chunk with
   `thread.run(0, { timeout })`; the worker pool (one wasm module per worker, `resourceLimits`,
   `traceAllocations` with `setMemoryMax`, `terminate()` on timeout) is the primary design, the
   previous runtime's process-wide run serialization is not ported, budgets charge CPU time, and
   host waits have their own caps."
4. **"Reusing the job map, GC, and upgrade handling in `proxyStreamJobs.ts`".** Those are private
   closure state hard-wired to `/proxy-stream-jobs`, with a replay buffer and immediate cleanup
   that are not generation policies, and an auth rule (`isAuthorizedProxyToken`) that accepts the
   stored password itself (`server/src/routes/auth.ts:108-110`). The slices leave the file
   unchanged and add one upgrade dispatcher by path prefix in `app.ts`; the generation socket
   uses the JWT only. Edit: "sharing the WebSocket upgrade with `proxyStreamJobs.ts` through one
   dispatcher; the proxy jobs' replay and cleanup rules do not apply".
5. **Client LLM callers and credential readers outside `sendChat` are not covered.** With
   `llmSecrets` write-only these still need a route: `requestChatData` callers
   (`translator.ts:553`, `Suggestion.svelte:114`, `IrisModal.svelte:238`, `stableDiff.ts:32`,
   `PlaygroundSubtitle.svelte:74, 295`, `PlaygroundImageTrans.svelte:177`, `mcp/aiaccess.ts:65`,
   plugin `runLLMModel` through `requestChatDataMain`), authenticated discovery and account calls
   (`modellist.ts:641-749`, `openrouter.ts:37, 58`, `nanogpt.ts:165`,
   `BotSettings.svelte:354-480`), the remote Google count (`tokenizer.ts:349`), and the auxiliary
   readers of `openAIKey` and `google.accessToken` (`tts.ts:200`, `stableDiff.ts:419, 695`,
   `PlaygroundSubtitle.svelte:288`). Slice 7 adds the unconditional `POST /api/llm/request`
   transport and the discovery, account, and count endpoints, and leaves the auxiliary readers as
   an owner question with a proposed default. Edit to step 2: name these consumers and the `aux`
   transport.
6. **The write-only flip and the rollback seam.** Flipping `llmSecrets` while the browser
   pipeline stays selectable breaks that pipeline's provider calls. The slices make the server
   provider transport unconditional for both pipelines before the flip (slice 7), so the browser
   assembly path stays the rollback seam with no client-held key. Edit to the Objective: "the
   browser assembly path stays behind a flag; provider calls go through the server from the
   request-layer step on".
7. **Step order.** Step 4 (assembly) "starting with the `input` trigger and `editinput`" needs
   the trigger runtime (step 7) and the Lua hooks (step 6) on the server; the slices run 6 and the
   runtime part of 7 (8a, 8b) before 4 (9). Edit: reorder the steps to 1, 2, 3, 6, 7 (runtime),
   4, 5, 7 (callbacks and MCP), 9, 8, or note the dependency in step 4.
8. **Image generation.** Steps 6 and 9 put `generateImage` and `runInlayScreen`'s image
   generation on the server; Decision 5 puts inlay generation in the job and Decision 6 keeps
   image generation and its keys on the client; together they allow only a client callback, which
   the slices use (settled by the plan, not an open question). Edit: "inlay images are generated
   by the client through a `generateImage` channel callback and written through the inlay path;
   the job resumes with the inlay id; Lua `generateImage` and `v2ImgGen` use the same callback".
9. **Local models.** `hypav3.ts` uses WebLLM (`@mlc-ai/web-llm`, `webllm.ts`) for local
   summarization (95, 1524); `HypaProcesser` (`hypamemory.ts:40-42`) and `HypaProcessorV2`
   (`hypamemoryv2.ts:35-37`) both hold a `hypaVector` LocalForage instance; `runEmbedding`,
   `runImageEmbedding` (captioning for models without image input, `index.svelte.ts:1142-1163`),
   `runSummarizer`, and `runTransformers` (`requestWebLLM` in `request.ts:1514-1547` is
   Transformers.js, not WebLLM) use the Cache API and a `webgpu`/`wasm` device. Slice 10 measures
   the Node backend before porting. Edit to step 5: name both processors and the Transformers.js
   check; record WebLLM summarization as unsupported on the server.
10. **Tokenizer loading under Node.** `@mlc-ai/web-tokenizers` fails under an ESM import (its
    `lib/index.js` is a UMD in a `type: module` package) and loads through `vm.compileFunction`
    with `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` (a plain callback
    needs `--experimental-vm-modules`); `src/etc/o200k_base.json` is bundled by Vite and absent
    from the image, while `@dqbd/tiktoken/encoders/o200k_base.json` is present and identical; the
    image has the payloads only under `dist/token/`; `gemmaTokenize` reads `llama/llama3.json`.
    Edit to step 1: "load the payloads from `dist/token/` or `public/token/` on disk and
    `o200k_base` from the `@dqbd/tiktoken` package".
11. **The server does not yet reject edits to a job's message.** `chatStore.ts` closes an open
    fence on an ordinary write and applies it (679-705), `remove` ignores fences (707-722), a
    `begin` with a new id takes over an open fence at the current revision (724-740), and
    character deletion cascades from `resourceStore.delete` and `applyChanges` (462, 561).
    `ChatConflict` has no `reason` field (`shared/chats.ts:80`), and the client's
    `chatGenerating` alerts are UI pre-checks (`Chat.svelte:177-196`,
    `DefaultChatScreen.svelte:265-268`, `346-349`). Slice 5 adds the lock over every path, the
    `reason`, and the client handling. Edit to step 2: "a 409 with `reason: "generating"`, over
    every destructive path including `begin` takeover and character deletion; only in-process
    writes with the job's token pass".
12. **Plugin hook names.** The registries are `pluginHooks.replacerbeforeRequest`,
    `replacerafterRequest`, `editinput`/`editprocess`/`editoutput`/`editdisplay`, `chatOutput`,
    `providers`, `providerOptions` (`pluginHooks.ts:29-45`); the interceptors are
    `bodyIntercepterStore` in `stores.svelte.ts:130-135`, whose callback receives `(body, type)`
    only; there is no metadata interceptor (Google's `meta_gemini` types use the same store). The
    plugin parser API is `parseRisuChat` (`v3.svelte.ts:1210-1254`). Edit to steps 7 and 8: name
    the registries; "body interceptors (without headers, as today)".
13. **Trigger effects needing the UI.** Beyond the four named: `v2UpdateChatAt`
    (`ReloadChatPointer`), `v2ImgGen` (DOM `Image` plus image generation), `v2Command` (alerts,
    TTS, `/multisend` recursion), and the `ReloadGUIPointer` bump after any variable change
    (`triggers.ts:2073-2075`). Edit to step 7: add them.
14. **`ParseMarkdown` and `processScriptFull` callers, and the pre-pass.** `Chat.svelte:364-371`
    evaluates CBS (`rmVar`, `visualize`) before `ParseMarkdown`, so the hooks receive expanded
    text; `translator.ts:390` calls `processScriptFull('editdisplay')` directly;
    `Suggestion.svelte:241`, `AlertComp.svelte:215`, `MultiLangDisplay.svelte:74`,
    `PlaygroundParser.svelte:8` call `ParseMarkdown` without scripts; `pluginHooks[mode]` runs for
    `editprocess` too (`scripts.ts:163-170`). Slice 13 keeps the pre-pass at its position and
    makes the plugin handoff mode-aware. Edit to step 8: "the CBS pre-pass of `Chat.svelte` runs
    on the server at its position; the two-call protocol covers `editprocess` handlers too".
15. **Lua `request` limits.** The client check is `> 5`, so six pass per minute
    (`scriptings.ts:436-443`); the previous runtime uses 30 per minute, 10 s, 2 MB. Slice 2
    proposes 30 (owner may keep 5). Edit to step 6: state the limit chosen.
16. **The settle barrier.** `flushResources()` (`resourceSync.svelte.ts:1087-1145`) saves every
    dirty record and queued chat op and refuses only when an unsettled key belongs to a character
    deferred behind a client-side generation (`isBlockedKey` 215-222, `isChatDeferred`
    `chatStore.svelte.ts:2389-2396`), which server jobs never create; it is the pre-send barrier.
    No edit needed; step 2's "settles its pending writes" is `flushResources()`.
17. **No push channel.** The client learns of remote changes only on a 409 or an idle re-base;
    a job's non-chat writes (`lastInteraction` at `index.svelte.ts:368`, `statics.messages` at
    357, script setters) would leave the mirror stale. The client writes the two per-send fields
    itself before sending, and the job reports the rest as `resource` hydration events (slice 5).
    Edit to step 2: add the `resource` event.
18. **`presetChain`** is `Database.presetChain` (`shared/database.ts:361`), resolved by
    `changeToPreset(findId, true)` (`index.svelte.ts:341-355`); slice 9 makes the job pick and
    report the id. No edit.
19. **Persistence sequence of the tail.** Today `igp` appends to the reply after auto-continue
    (`index.svelte.ts:2245-2258`) and before `writeReplyGenerationInfo` and the final write; the
    emotion modes (2305-2500) compute before `CharEmotion` is set; `imggen` (2510-2526) runs
    `stableDiff` client-side. Step 9 names none of them; slice 11 has the sequence and a
    path-to-owner table. Edit to step 9: "`igp` before the final write; emotion computed on the
    server and sent as a notice; `imggen` as a client callback after `done`".
20. **Remembered tool calls.** `encodeToolCall` stores calls in LocalForage `mcp-tool-calls` and
    `decodeToolCall` is used by all four adapters when building later requests
    (`mcp.ts:258-295`, `openAI/requests.ts:40-115`, `responses.ts:38-76`, `google.ts:137-246`,
    `anthropic.ts:281-369`); they are conversation data, persisted as `chat.toolCalls` in slice 11. Edit to step 7: add the sentence.
21. **Restore and shutdown.** Generation runners must run under `snapshots.track` and the storage
    gate so `withMaintenance` and `dispose` await them (`snapshots.ts:149-186`, `205-214`,
    `227-236`, `252-265`; `app.ts:197-205`); the phase file does not say so. Edit to step 2: "a
    job is tracked like a resource handler and carries its epoch; a restore during a job ends the
    job".
22. **Strict mode.** The client compiles with `strict: false`; `shared/` and the server are
    strict. The review's read-only count: `cbs.ts` 81, `parser.svelte.ts` 73, `index.svelte.ts`
    43, `scriptings.ts` 25, `triggers.ts` 22, `lorebook.svelte.ts` 19, `scripts.ts` 15, the
    request files about 190. Each port slice carries its budget. Edit to step 1: "the moved
    modules are fixed to strict without semantic change".
23. **Remote MCP is not portable as written** (`mcplib.ts` uses `document` custom events at
    193-224, 331-352, 404-424, 542-558 and `window.open` plus `alertInput` at 616-704); slice 12
    ports the transport. Edit to step 7: "a Node MCP client".
24. **`calcString`** (`infunctions.ts:173`) imports `chatVar.svelte`; the shared evaluator injects
    the accessors. No edit.
25. **The closeout's cache claim.** `PlaygroundEmbedding.svelte`, `CharConfig.svelte`
    (`registerOnnxModel`), and `tts.ts` (`runVITS`) keep `hypaVector` and `tfCache` in use after
    cutover. No edit.

Safety Contract additions found while slicing (edit: append to the phase file's list): a button
or manual trigger during a send is refused if the owner keeps the command-lock default;
`/multisend` inside a trigger is refused on the server; the resend and auto-continue loop is
capped (8); local WebLLM summarization (and local Transformers.js models if the in-slice check
fails) are unsupported on the server; dynamic-asset regex replacement runs on the server only
from slice 10 on; Lua `request` allows 30 per minute with 10 s and 2 MB caps; settings changed
during a job do not affect it; a server restart clears the generation lock; the request-log modal
gets server calls through a `requestLog` notice via the secret-free projection; `v2ImgGen`'s
image size comes from the callback answer; an image callback with no owner leaves the reply
without the image; the CBS pre-pass and every display hook run on the server with the viewport
and language the client reports; every message re-renders after any chat variable changes;
plugins see masked LLM credentials through `getDatabase`; `bodyIntercepter` registrations are
not applied to browser-path calls without a job; inside a callback the selection-dependent
plugin functions mean the job's chat and preset (Phase 4's rule, inherited).

## Proposed edits to the phases README and to the Phase 4 file

- Phases README, Common Entry Gate: add "A phase's slices that depend on nothing in an
  unfinished phase may start early when the phase's slice README says so", so that slices 1 to 5
  here (the two spikes, the pure services, the job routes) can run while Phases 3 and 4 run.
- Phase 4 file, "CBS" item: "Keep the injected host callbacks ... and feed them read models" is
  done by Phase 5's `cbs-and-regex-services` (the shared evaluator move), so the same seam has
  one owner; Phase 4 leaves `cbs.ts` untouched. Phase 4's own drafting confirmed this (its report
  lists the CBS scope amendment among its phase-file edits).
- PLAN.md Decision 2: add "and the pure runtime modules both runtimes run" (the CBS registry and
  evaluator, the regex engine, lore activation, the Jinja templates, the model catalogue live in
  `shared/` with host access through an injected object); `STRUCTURE.md` T2 and D1 say so at
  cutover.

## Edits applied from other phases

Applied on 2026-09-30 from the Phase 4 drafting round (its slices under
`../phase-4-external-contracts/`: `character-and-collection-mutations.md`, `plugin-call-context.md`,
`lua-character-setters.md`, `trigger-effect-writers.md`, `plugin-host-setters.md`), after reading
them:

- `job-channel.md`: the settle rule is `beginMutationScope()` before the callback and
  `flushResources({ scope })` after; a non-empty `discarded` list answers `outcome: "failed"`
  with those keys. The dispatcher hands the job's context (`chatRef`, `presetId`, `personaId`)
  to each callback through Phase 4's per-plugin handoff (`invokeHook(fn, context)` in
  `src/ts/plugins/apiV3/pluginContext.ts`, read by `currentContext(pluginName)`; a gone target
  throws `PluginTargetGoneError`), replacing "plugin APIs that resolve the selected character
  act on the tab's selection". Phase 4 names no `withPluginContext`; the handoff functions above
  are the ones its slice defines.
- `lua-bindings-and-buttons.md` and `trigger-runtime.md`: the Assumptions gain the
  executing-character rule (the setters address `arg.char.chaId`, the speaking member in a group
  send, never the chat's owner or the selection); `trigger-runtime` re-targets `v2SetPersonaDesc`
  to the frozen effective persona of the execution context (Phase 4 writes the selected persona
  through `updatePersona(selection.personaId, { personaPrompt })` and records the handoff).
- `post-generation-and-plugin-callbacks.md`: "Phase 4 made the plugin whole-object setters
  diffs" became "chats are diffed (Phase 2); a plugin `setCharacter` replaces the character's own
  fields whole (`replaceCharacterFields(chaId, fields)` then `reconcileCharacterChats`)".
- Assumptions that name Phase 4 deliverables now use its module and function names:
  `src/ts/storage/characterStore.svelte.ts` (`updateCharacter(chaId, patch)`,
  `replaceCharacterFields`), `collectionStore.svelte.ts` (`updateSettings(patch, { presetId })`,
  `readSetting`, `updatePersona`), `pluginStorageStore.svelte.ts`, `resourceSync.svelte.ts`
  (`beginMutationScope`, `flushResources({ scope })`), in `job-channel.md`,
  `lua-bindings-and-buttons.md`, `trigger-runtime.md`, `prompt-assembly.md`, and
  `post-generation-and-plugin-callbacks.md`.

Applied on 2026-09-30 from the Phase 6 drafting round (its slices under
`../phase-6-thin-client-and-closeout/`: `live-updates.md`, `settings-ownership.md`), after
reading them:

- `generation-jobs.md` (`applyHydration`): "replaces the whole record and its saved text like a
  conflict reload does" became "applies the record only when its token's `seq` differs or its
  revision is higher than the held one, and never records a discard", the comparison
  `live-updates.md` specifies for its feed (two batched reads can resolve out of order, and a
  job's `resource` event may have applied the record first).
- `request-layer-and-llm-secrets.md` (the masked projection): added "a write of the `llmSecrets`
  kind that omits a masked path keeps the stored value for that path", the form
  `settings-ownership.md`'s `updateLlmSecretSiblings(patch)` relies on.
- `cutover-and-docs.md`: "Phase 6 will add live updates" gained "the job socket's `resource`
  events stay; the feed deduplicates by revision".

## Contingent boundaries

- **Slice 7 on Phase 3's `llmSecrets`.** Phase 3's drafts: a singleton kind with the flat
  credential fields under their `Database` names, the containers `google`, `hordeConfig`,
  `novelai` moved whole, `presets: Record<presetId, { proxyKey }>`, `clientReadable` until Phase
  5, client-side copy, delete, and import of the preset entry, `customModels[].key` left in
  `customModels`, `authRefreshes` a client-readable collection. Slice 7 assumes that shape,
  replaces the client-side preset-entry operations with server routes, redacts by path, and moves
  `customModels[].key` under `llmSecrets.customModels.<id>.key`. If Phase 3 ships differently,
  the inventory in slice 7 is the reconciliation list.
- **Slices 8a, 8b, 11 on Phase 4's mutation surface.** The Lua setters are
  `updateCharacter(chaId, patch)` on the executing character, the trigger effects one-field
  `updateCharacter` patches and `updatePersona`, the plugin setters `replaceCharacterFields`
  and the chat diff, the persistence contract `beginMutationScope()` +
  `flushResources({ scope })`, and the plugin context handoff `invokeHook`. If any of those
  ships in another form, the corresponding server op in 8a/8b and the callback barrier in 6 are
  re-planned at phase start.
- **Slice 9 on Phase 3's per-client preset and persona ids** (`selection.presetId`,
  `selection.personaId`; the execution context carries them; `presetChain` reports the chosen
  id).
- **Slice 13 on presets staying one singleton** (the key uses the selected preset id plus the
  `presets` revision; per-record presets would use the record's revision instead) and on
  `presetRegex` being the forwarded alias of the selected preset's `regex`.
- **Slice 10 on Phase 3's credential sections** (`supaMemoryKey`, `hypaMemoryKey`,
  `voyageApiKey`, `hypaCustomSettings.key` in `secrets`, read server-side).
- **The `shared/` runtime convention (slice 3)** rests on the owner accepting the Decision 2
  extension; otherwise slices 3 and 4 become server-only copies and the golden tests compare two
  implementations (weaker).

## Open questions for the plan owner

1. The auxiliary readers of `openAIKey` (OpenAI TTS, DALL-E, Whisper) and of `google.accessToken`
   (Imagen) once the keys are write-only: (a) `/proxy2` injects the server-side key for an
   allow-listed host when the client sends a placeholder header (proposed default; keeps
   Decision 6's "auxiliary calls keep the proxy"), (b) a separate auxiliary key in `secrets`, or
   (c) small server endpoints per call.
2. Credentials typed into `additionalParams` (`header::Authorization`) and custom-model `params`:
   proposed default, authorization headers stored server-side under
   `llmSecrets.additionalHeaders` with a reference in the readable configuration; or leave them
   client-readable as user configuration.
3. Runtime modules in `shared/` (CBS registry and evaluator, regex engine, lore activation, Jinja
   templates, the model catalogue): accepted as an extension of Decision 2?
4. Local models on the server: WebLLM summarization cannot run in Node; Transformers.js is
   measured in slice 10. Accept "unsupported on the server" with an explicit error, or add a
   client callback for local models?
5. Whether a `command` job (buttons, manual triggers) takes the chat's one-job slot (proposed
   default: yes, so a button during a send is refused), or writes by id beside a running job.
6. Refusing `/multisend` inside a trigger on the server.
7. Lua `request` rate: 30 per minute (previous runtime) or the documented 5?
8. Chat variables in the transform cache key (proposed: yes, so `{{getvar}}` panels stay live; the
   alternative is adding "chat variables" to Decision 5's staleness list, a visible regression).
9. `proxyStreamJobs` after cutover: keep the server kind one phase or delete it in slice 14?

## Boundaries Phase 6 depends on

- **Live updates replace hydration.** The job's `resource` and `chunk` events reach only the
  owner client (`generation-jobs`); other clients converge on reload. Phase 6's resource-change
  events over the socket replace both, and observer sockets (deferred here) become its live
  subscriptions.
- **The generation lock is in memory** (`generationLock.ts`); Phase 6's convergence check must
  cover a second client's refused edit (`reason: "generating"`) and the reload after `done`.
- **`applyServerGeneration` and `applyHydration`** are the client entries that write the mirror
  without queuing an edit; Phase 6's projections replace the mirror they write.
- **The transform cache identity** (chat id, kind, message id, source hash, preset id,
  `cbsConditions`, the `prePass` options, the transform version with the display-handler set,
  the character, modules, and presets revisions, the chat-variable hash, language, mode) is the
  contract Phase 6's per-screen projections must keep supplying; the client LRU is cleared on
  `ReloadGUIPointer` only.
- **`proxyStreamJobs`** stays on the server without a client until Phase 6 removes it (owner
  question 9); `hypaVector` and `tfCache` stay in use by the playground, `registerOnnxModel`,
  and `runVITS`.
- **Runtime modules in `shared/`** (`shared/{cbs,scripts,lore,prompt,llm}`) and the server
  folders `server/src/{jobs,llm,lua,scripts,prompt,mcp}` need `STRUCTURE.md` T2/D1 and Path
  Ownership rows (slice 14 adds them); Phase 6's final docs build on them.
- **The client keeps `requestChatData`/`requestChatDataMain` as transports** to
  `POST /api/llm/request` and the browser tokenizer loaders for the editor counters; Phase 6
  decides whether the counters move too.
- **Persisted chat fields added here:** `toolCalls` (a chat `meta` key, stored as sent); the
  `llmSecrets` masked projection and the `additionalHeaders` default if adopted.
