# Slice: Prompt Assembly

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 4 (the body of `sendChat` on the
server) and the execution-context, `presetChain`, and raw-checkpoint parts of steps 2 and 9;
PLAN.md Decision 3 (the job resolves `presetChain`), Decision 4 (raw-text checkpoints), Decision 5
(the frozen execution context; the client settles its pending writes first).

Depends on: `lore-templates-and-tokens`, `request-layer-and-llm-secrets`, `trigger-runtime`;
Phase 3 (per-client preset and persona ids) and Phase 4 (`characterStore.svelte.ts`
`updateCharacter`, `collectionStore.svelte.ts` `updateSettings`; `flushResources` settles them
all).

## Scope

Allowed files: `server/src/prompt/assemble.ts` (new: history, lore placement, first template
pass, final template pass, trimming), `server/src/prompt/runner.ts` (new: the `GenerationRunner`
for `send`, `continue`, `reroll`, `group`, `preview`, `previewPrompt`), `server/src/prompt/scope.ts`
(new: the frozen read model), `server/src/routes/generations.ts`, `src/ts/process/index.svelte.ts`
(the flag branch that creates the job and applies events; the browser path stays),
`src/lib/ChatScreens/DefaultChatScreen.svelte` (`sendMain` behind the flag), `src/lib/SideBars/DevTool.svelte`
and `src/ts/hotkey.ts` (the two previews behind the flag), `src/ts/network/generationJobs.ts`,
`src/ts/storage/clientFlags.ts` (new: the client-local flag), `src/lang/en.ts`. Memory is a stub
in this slice (drops the oldest messages, as the no-memory path does). Tests belong to the review
step.

Identifiers (verified 2026-09-30): `sendChat(chatProcessIndex, arg: SendChatArg)` (`index.svelte.ts:146-153`;
`SendChatArg` 114-130), `sendChatInner`; the `presetChain` branch (341-355: `changeToPreset(findId, true)`,
`alertToast` when missing); `statics.messages` (357) and `lastInteraction` (368, a character
field); `chatTarget` (372-380); `generationId = v4()` (378); the group recursion; `runCurrentChatFunction`;
the lore placement (`positionParser`, `resolvePosition`); the greeting through `editprocess`
(1063, 1101); the multimodal branch (1142-1163: with `LLMFlags.hasImageInput` an image
multimodal, otherwise `runImageEmbedding` captions the inlay; `readImage` 1216-1246 loads asset
bytes); the memory branch; `runLuaEditTrigger('editRequest')` (1771-1780);
`requestChatData(..., 'model', abortSignal)`; the previews (`preview` sets `previewFormated` and
returns, `previewPrompt` passes `previewBody` to the request and stores the provider body:
111-130, 1830-1865; consumed by `DevTool.svelte:19-60` and `hotkey.ts:142-159`); the reply append
(1892-1900), `startGeneration` (265-274), the streaming loop (1993-2035), `checkpointGeneration`
at stream end (2082). Client-side input stage: `DefaultChatScreen.svelte:180-251`
(`processMultiCommand`, inlay tags, `runTrigger('input')` 228, `processScript('editinput')` 236,
`appendMessage` 240, `sendChatMain` 245-250). Settle: `flushResources()`
(`resourceSync.svelte.ts:1087-1145`) saves every dirty record and queued chat op and rejects only
for a character deferred behind a client-side generation, quarantine, a halted server, or a
persistent error. Chat module: `applyServerGeneration` (from `generation-jobs`), `CHECKPOINT_INTERVAL_MS = 3000`
(54).

Strict-mode cost: about 43 errors in `index.svelte.ts` (review count) apply to the moved body.

Stopping condition: an assembly stage that reads something outside the frozen scope and the
context, or a golden fixture whose server prompt differs from the client prompt for a reason the
slice cannot attribute; stop and report the diff.

## Assumptions

- Phase 3 made the selected preset and persona per-client ids the client sends; `presetChain` is
  readable by the job and the client applies the reported id to its selection (Decision 3).
- `trigger-runtime` provides `runTrigger` and the Lua edit hooks on the server;
  `cbs-and-regex-services` the regex engine; `request-layer-and-llm-secrets` the request layer.

## Proposed decisions

- Frozen scope (proposed): at job start the runner reads, in one store call, the character (and
  group members), the chat with its messages, the selected preset, the effective persona, the
  enabled modules, the settings sections it needs, and the credentials it needs, into
  `PromptScope`; every callback and auxiliary call gets this object. Settings changed during the
  job do not affect it (recorded).
- Client flow behind the flag (proposed): the flag is client-local (`localStorage`
  `risu.serverGeneration`, read through `clientFlags.ts`, shown as a toggle in the developer
  tools; not a persisted `Database` field, so no Phase 3 section is needed), introduced here, and
  removed at cutover. `sendMain` runs commands and inlay tags as today, writes `lastInteraction`
  and `statics.messages` itself (so the job writes neither), calls `flushResources()` (every
  pending write, including the settings and preset edits the scope reads; a rejection is an
  `alertError` and no send; discarded keys are reported), then `POST /api/generations` with the
  kind, the context, the chat revision, the epoch, and the hook list. The user message is
  appended by the job after the input trigger and `editinput` (today at `DefaultChatScreen.svelte:240`);
  `accepted` carries both message ids and the client mirrors them through `applyServerGeneration`.
- Checkpoints (proposed): the runner writes `begin`, then a generation `setText` with the raw text
  every 3 s and on abort, then the final write after the tail (`post-generation-and-plugin-callbacks`);
  `chunk` carries the whole text so far. The display modes become client-only choices: raw text
  while streaming (recorded in `script-transform`).
- `presetChain` (proposed): the job picks the random preset, uses it for the whole job, and emits
  `preset { presetId }` before `accepted`; the client applies it to its per-client selection.
- Group sends run each speaker in sequence inside one job, emitting `accepted` per reply.
- Previews (proposed): `preview` returns the assembled `OpenAIChat[]` in `done` (the golden-test
  seam); `previewPrompt` runs the request layer with `previewBody` and returns the provider body
  through the secret-free projection. Both stay available to `DevTool.svelte` and the hotkey.
- Multimodal inlays are read from `save/assets` on the server; captioning (`runImageEmbedding`)
  is a stage of `memory-on-server` (the Transformers.js check), and until then a model without
  image input gets no caption on the server path (recorded, flag off by default).

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step adds
`server/src/tests/assemble.test.ts`: the golden test comparing the assembled prompt of fixture
characters (plain, lore at every position, a Jinja template, `presetChain`, a group) between the
client path (captured once through the DevTool preview into fixtures) and the `preview` job;
`generations.test.ts` gains send, continue, reroll, abort mid-stream keeping the text, and a
`previewPrompt` body with a real fake provider (`startUpstream` SSE). Manual (headless Chrome
against a slow mock provider): with the flag on, send, continue, reroll, a group send, abort, a
reload mid-stream showing the checkpointed text, a settings edit immediately followed by a send
landing in the prompt, and a second tab seeing the reply after reload.

## Residual risk

Until `post-generation-and-plugin-callbacks`, a flagged send persists raw text without
`editoutput`, the output trigger, inlays, or listeners; the flag stays off by default. The client
path and the server path coexist and must both keep passing until cutover.
