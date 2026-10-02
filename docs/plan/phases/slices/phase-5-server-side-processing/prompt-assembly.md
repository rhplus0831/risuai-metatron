# Slice: Prompt Assembly

Status: implemented (2026-10-02); see the implementation record at the end.

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

## Implementation record (2026-10-02)

Files: `shared/jobs.ts` (`GenerationContext.userMessageId`); `server/src/routes/generations.ts`
(`userMessageId` an id, only for `send`, `continue`, `reroll`, `group`); `server/src/scripts/worker.ts`
and `workerPool.ts` (`runScripts`: the regex script engine on a worker, with CBS, `@@repeat_back`, and
the effects as synchronous host functions); `server/src/jobs/runSetup.ts` (new: the run setup command
jobs and sends share), `commandRunner.ts` (on it), `chatResult.ts` (the owned generation's checkpoint),
`generationJobs.ts` (`setCallbackPreset`); `server/src/lua/bindings.ts` (`setRequestTrigger`,
`readInlay`); `server/src/llm/outer.ts` (`isFatal`); `server/src/prompt/assemble.ts`, `runner.ts`,
`scripts.ts` (new); `server/src/prompt/triggers.ts` (`parseChatML` exported); `server/src/app.ts`
(`generationRandom`); client `src/ts/process/serverGeneration.ts` (new), `serverCommands.ts`
(`runServerJob`, the preflight command jobs and sends share), `index.svelte.ts` (the flag branch),
`src/ts/network/generationJobs.ts` (the `preset` event), `DefaultChatScreen.svelte`, `DevTool.svelte`
and `src/lang/en.ts` (the toggle); `util/playwright/checkServerSend.mjs`; the structure docs.

Deviations from the scope above, all recorded:

- `server/src/prompt/scope.ts` is not created: `JobScope` (slice 8a) is the frozen identity and
  configuration plus the live chat and characters. The working state is not isolated from unrelated
  concurrent edits: the job reads its chat again after its own writes and its callbacks, as the
  browser's live `chatNow()` does (Astra plan-review point 6, rejected; a Stop C owner item).
- The flag branch is in `sendChat` (the amendment) and the input stage is in the job (the slice's
  decision), joined by `userMessageId`. The input stage runs on the admitted preset, before
  `presetChain`, as the tab ran it before `sendChat`.
- The regex scripts run in a worker (`runScripts`), CBS and the effects on the main thread.
- The native `request` trigger was not wired in slice 8b (`requestChatDataOuter` had the seam); it now
  runs for every server request of a job.
- `statics.messages` is raised once per send (the tab's recursive group send raised it per speaker).
- A continue's reroll alternatives are not registered (the tab registers them under a generation id
  its reroll never looks up). A group continue is a group send (the tab's group recursion does not
  forward the continue).
- `presetChain`'s `preset` event is applied once per job and page; after a reload an attach applies it
  again (Known Hazards).
- Not on the server path until slice 10: the memory algorithms (the no-memory trim applies),
  `additionalInformations`, image captions, dynamic assets. The tail is slice 11's: the stored reply
  is the raw text.

Astra plan review (`p5s9-plan-review.md`, sixteen points): fifteen adopted (three with changes), one
rejected.

1. Input before the preset pick: adopted. 2. Continue with input: adopted (an input stage, the default
   target resolved after it). 3. The reroll bundle: adopted (it starts after the user message). 4. Retry
   semantics: adopted with a narrower claim (an existing user message with the id skips the stage; another
   role is a 409; a busy job of this tab is followed). 5. The preset pick: adopted with changes (the keep
   rules over the admitted snapshot, none for the selected preset; callbacks retargeted; the tab applies
   the event once per job and page, the reload residual recorded). 6. Isolation: rejected (above). 7. The
   continue fence: adopted (checkpoint writes for the owned message from `runCurrentChatFunction`, the
   start trigger, and `throwError`; `accepted` when it is locked; the prefix read after the hooks). 8.
   `@@inject`: adopted (any owner). 9. The request trigger: adopted. 10. The worker contract: adopted
   (effects applied once, at their points; a host failure latched and the run aborted). 11. The script
   cache: adopted (per job). 12. Checkpoints: adopted (separate write and chunk counters, the abort write
   as the job, one terminal). 13. Non-streaming replies: adopted (the role kept, a continue's metadata
   replaced, the alternatives as the tab passes them). 14. Group services: adopted with changes (per
   speaker bindings and request projection; a group continue is a group send). 15. `incrementStatic` and
   the admission abort: adopted. 16. The stage table: adopted (the prompt-info snapshot, the second
   `editRequest`, the inlay reader, asset and icon reads).

Checks: `pnpm check`, `pnpm test` (139 files, 1746 passed), `pnpm format:check`; the scratch golden
`s9/golden.ts` (all five fixtures of `prompts.json` from a server seeded with `scenario.json`, the lore
fixture against `deltas/lore-regex-fix-prompts.json`: equal); the scratch smoke `s9/smoke.ts` (28/28: the
input stage with the input trigger and `editinput`, a retried `userMessageId`, streaming with chunks and
the stored reply, continue, a checkpoint during a slow stream, an abort keeping the text, a group send,
non-streaming, a failing provider with and without `inlayErrorResponse`, `previewPrompt`, `preview`,
`presetChain` with its event, the route); `node util/playwright/checkServerSend.mjs` (21/21);
`checkServerTrigger.mjs` (16/16) and the slice 8b smoke (23/23) after the setup refactor.

Astra challenge (`p5s9-challenge.md`, twelve points, ten blocking): all held and were fixed. R1: a Lua or
command write to a message any generation owns (the job's own continue included) is refused, as the
tab's `liveWrite` is, and an ignored final write ends the job. R2: the effect limit is its own error
(`TriggerEffectLimitError`), latched in the request trigger, so no provider call follows. R3: the
checkpoint is a timer, so a stalled provider does not hold stored text back. R4: group speakers keep
the job's request projection (only `speakerName` changes), and the `presetChain` pick is read at the
job's start. R5: `done.stopped` (shared `GenerationTerminalEvent`), so `sendChat` returns false where
the tab's does. R6: a create request without an answer is `unknown`; the input goes back and keeps its
`userMessageId` for the same text. R7: a followed busy job is not this send (the input goes back). R8:
the signal aborts a followed job too. R9: only an `unregistered` refusal keeps an edit hook's text.
R10: `pluginContext` gives the job its preset and effective persona. R11: the scripts task bounds its
host arguments and result. R12: the script cache is the job's (`JobRunState.scriptCache`). Astra's
probes (`/tmp/astra-p5-segC/probe-s9*.ts`) rerun on the fixed tree: no provider call after the effect
limit, the continue's text stored with the Lua edit refused, a checkpoint during a stall, one model for
both speakers, `stopped` on a trigger stop, the abort and read-failure texts kept, the oversized result
refused. Checks after the fixes: `pnpm check`, `pnpm test` (139 files, 1746 passed), the golden, the
smokes (28/28, 23/23), `checkServerSend.mjs` (21/21), `checkServerTrigger.mjs` (16/16).

Fable review (2026-10-02): no defect found; the checks above rerun (the golden, the smoke, `checkServerSend.mjs`
21/21). Tests written (the review step's, as the Validation section asks, with one deviation: the end-to-end
cases live in a new `server/src/tests/promptRunner.test.ts` rather than in `generations.test.ts`, whose harness
is a fake step runner): `server/src/tests/assemble.test.ts` (the golden against the baseline capture for the
five fixtures, the lore delta, the `presetChain` pick, the `jinja` `previewPrompt` body), `promptRunner.test.ts`
(the input stage, the streamed reply, the retry, continue with the Lua write refused, the checkpoint timer and
the abort, group under the frozen configuration, non-streaming, the failing provider with and without
`inlayErrorResponse`, the trigger stop, the request trigger's effect limit, the previews, `presetChain`, the
plugin edit hook, the route), `regexScriptsTask.test.ts` (the worker task's hosts, abort, and bounds),
`src/ts/process/serverGeneration.test.ts`, the `runServerJob` cases of `serverCommands.test.ts`, and the `preset`
event in `src/ts/network/generationJobs.test.ts`; `testSupport.ts` gained `generationRandom`. Not written: a
component test of `sendMain`'s per-chat pending `userMessageId` map (no Svelte component test infrastructure in
the repository; the browser check covers the happy paths and Astra's source-snippet diagnostics the retries).

Round 2 (`p5s9-challenge-r2.md`): ten points resolved; three findings, all fixed. C1: an ambiguous
send's `userMessageId` is kept per chat across later refusals until the chat holds the message (a
refusal after it does puts nothing back); round 3 found a single pending entry shared by two chats, and
round 4 confirmed the per-chat map. C2: after a size failure no further host call of the scripts task
is dispatched. C3: the worker and the pool count results and host arguments as JSON. Checks after round
4: `pnpm check`, `pnpm format:check`, `pnpm test` (139 files, 1746 passed), `pnpm build`, `pnpm test:e2e`
(6 passed), the golden, the smokes, `checkServerSend.mjs` (21/21), `checkServerTrigger.mjs` (16/16).

Stop C Docker smoke (2026-10-02, image `risuai-metatron:p5-stopc` on `416145ac`, fresh volume, port 6197,
`risu.serverGeneration` on, a mock streaming provider on the host through `host.docker.internal`, a proxy
key written through `/api/llm-secrets`): 13/13. A send from the chat input posted one `send` job with the
input and its `userMessageId`; the server made the streamed provider request with the stored key and the
browser none; a reload 4.5 s into a slow stream found the checkpoint stored (`Slow one. Slow two.`) and then
showed the whole reply; after a final reload the store held both user messages and both replies once each;
no request, response, or socket frame carried the key; no page errors. Observed, not a defect: with no
trigger scripts the server logs `Error: Invalid return` from the request trigger on every provider attempt
(the trigger runtime returns `null`); the browser path logs a `TypeError` at the same point, and in both
the prompt goes out unchanged.
