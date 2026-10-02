# Slice: Lua Bindings And Buttons

Status: implemented (2026-10-02); see the implementation record at the end.

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 6 (the host bindings; buttons
through a server command endpoint); PLAN.md Decision 5. Moved ahead of step 4 (prompt assembly),
whose first stages are Lua hooks.

Depends on: `script-worker-spike`, `cbs-and-regex-services`, `lore-templates-and-tokens`,
`job-channel`, `request-layer-and-llm-secrets`; Phase 4 `lua-character-setters` (the Lua
setters are `updateCharacter(chaId, patch)` mutations addressed to the executing character).

## Scope

Allowed files: `server/src/lua/bindings.ts` (new), `server/src/lua/prelude.lua` (from
`luaCodeWrapper`), `server/src/scripts/worker.ts` (the host-call proxy for the bindings),
`server/src/routes/generations.ts` (the `command` kind, `button` variant), `src/ts/process/scriptings.ts`
(unchanged behavior; `runLuaButtonTrigger` gains the flagged path), `src/lib/ChatScreens/Chat.svelte`
(the button caller behind the flag), `shared/triggers.ts` only for a type the server needs
exported. Tests belong to the review step.

Identifiers (verified 2026-09-30): `scriptings.ts` declares 56 host functions with `declareAPI`
(119-121), 54 unique names (`getCharacterLastMessage` and `getUserLastMessage` are registered
twice, 1123/1162 and 1144/1183; the later wins). The previous runtime declares the same 54 names
(multi-line `declare(` calls; the drafting report's earlier count was wrong) and rejects
multimodal `LLM`, `getCharacterImage`, and `getPersonaImage` as unsupported; this slice supports
them. Guards: `ScriptingSafeIds`, `ScriptingEditDisplayIds`, `ScriptingLowLevelIds` (44-47; keys
at 1204-1211). UI functions: `alertError`/`alertNormal`/`alertInput`/`alertSelect`/`alertConfirm`
(163-191), `reloadDisplay` (399), `reloadChat` (406), `stopChat` (157). Services: `similarity`
(417, `HypaProcesser`), `request` (426-486), `generateImage` (489, `generateAIImage` then an
inlay write), `getCharacterImageMain`/`getPersonaImageMain` (503-558), `hash` (569),
`LLMMain`/`simpleLLM`/`axLLMMain` (607-741, 1007-1086; `requestChatData` with `model` and
`otherAx`), `cbs` (364), `getTokens` (329), `loadLoreBooksMain` (961), `sleep` (353),
`upsertLocalLoreBook` (909-958). Entry points: `runScripted` (74-88; modes 1216-1263),
`runLuaEditTrigger` (1511-1555), `runLuaButtonTrigger` (1566-1596); the wrapper `luaCodeWrapper`
(1349-1508). The button caller: `Chat.svelte:456` (`runLuaButtonTrigger(currentChar, btnEvent, ref)`
from `risu-btn`).

Strict-mode cost: about 25 errors in `scriptings.ts` (review count) apply to the parts that move.

Stopping condition: a host function whose semantics need the client's live chat object rather
than the job's working copy in a way the Phase 2 diff cannot express; recorded and that function
refuses on the server.

## Assumptions

- Phase 4 routed the Lua setters (`setName`, `setDescription`, `setCharacterFirstMessage`,
  `setBackgroundEmbedding`) through `updateCharacter(chaId, { name | desc | firstMessage | backgroundHTML })`
  in `src/ts/storage/characterStore.svelte.ts`, and `upsertLocalLoreBook` stays a chat `meta`
  write; on the server they are `applyChanges` ops on the job's character and chat records,
  reported to the client as `resource` events.
- The setters address the executing character (`arg.char.chaId`: the speaking member in a group
  send, the chat screen's character for buttons and edit hooks), not the chat's owner and not the
  selection (Phase 4's executing-character rule; `engineCharacterId()`); a run without a
  resolvable character makes the boolean setters return `false` and the others return without
  writing. The job's runner passes the speaking member as the run's character.
- The spike settled the worker runtime; the channel and the server request layer exist.
- `lowLevelAccess` (STRUCTURE S2) reaches the server unchanged in the job's frozen scope; edit
  hooks run without it, as today.

## Proposed decisions

- Bindings: all 54 names, declared in the worker on the spike's abort-checkpoint wrapper, with
  per-call access-key closures instead of module-level sets. Mapping: chat functions to the job's
  working copy (a trigger's clone) or the job's live chat view (edit hooks, buttons), written by
  id through `applyChanges` with the job token; `cbs` to the shared evaluator; `getTokens` and
  `loadLoreBooks` to the counter and lore activation; `hash` to `crypto.subtle` (same digest);
  `LLM`/`simpleLLM`/`axLLM` to the server request layer as `aux` requests (multimodal input
  supported); `similarity` to the embeddings service (the failure value until `memory-on-server`;
  recorded); `request` to the egress validator; alerts and reloads to channel notices and
  questions (a question not `answered` raises in the script); `stopChat` to the job's
  `stopSending` flag; `getCharacterImage`/`getPersonaImage` read the asset from `save/assets`;
  `generateImage` is a `generateImage` channel callback (the client generates, writes the inlay,
  answers with the id): Decision 5 puts inlay generation in the job and Decision 6 keeps image
  generation and its keys on the client, so the callback is the only design both allow; the
  phase file's "through server services" wording is a proposed phase-file edit. A callback that
  is not `answered` (owner disconnected) returns the failure string to the script and the reply
  persists without the image (recorded).
- Lua globals no longer survive between turns (Safety Contract) takes effect here. Recorded in
  the phase file by this slice.
- Button endpoint (proposed): `POST /api/generations` with `kind: "command"` and body
  `{ context, command: { type: "button", data } }`, a short job with the channel; whether it
  takes the chat's job slot is the owner question recorded in `generation-jobs`. `Chat.svelte:456`
  calls it behind the client-local flag introduced by `prompt-assembly`; until then the client
  path stays.

## Validation

`pnpm check`, `pnpm test` (`scriptings.test.ts` stays for the client path until cutover),
`pnpm build`, `pnpm format:check`; the review step adds `server/src/tests/luaBindings.test.ts`
(every host function with a stub host: guards, the chat functions by id, `cbs`, the failure values,
a question outcome raising) and a Lua module fixture whose buttons and alerts behave the same as
on the client. Manual: with the flag on, a button in a fixture card runs through the endpoint and
its alert appears.

## Residual risk

Command lines are not atomic on the server either (Phase 2's known limit).

## Implementation record (2026-10-02)

Plan, Astra's plan review (15 points), and Opus's decisions are in the session scratchpad
(`p5s8a-plan.md`, `/tmp/astra-p5-segC/p5s8a-plan-review.md`, `p5s8a-decisions.md`): every point was
adopted except point 4 (below); point 12 was adopted with a change.

What landed:

- Wire: `GenerationCreateBody.command` (`{ type: "button", data }`, required for `command` jobs and
  refused for others, 64 KiB of UTF-8), `GenerationContext.selectedPersonaId` and `.client`
  (viewport, browser language), validated by the route and carried to the runner
  (`RunningJob.command`). Callback payloads for `generateImage` and the new `inlayImage`.
- `server/src/jobs/jobScope.ts` (the frozen projection plus the live chat and characters),
  `server/src/jobs/cbsHost.ts` (the server CBS host; `shared/hashRand.ts` takes `pickHashRand` and
  `sfc32` from `src/ts/util.ts`, which re-exports them), `server/src/lua/bindings.ts` (the 50 host
  functions; Astra's per-function table is the contract), `server/src/jobs/commandRunner.ts` (the
  default runner: `command` jobs run, other kinds 501), the runtime's JSON wrappers and
  `failedAt`, `server/src/llm/requests.ts` `runInJob` with the shared `buildContext` and
  `channelIntercept`, `server/src/llm/outer.ts` (the client's outer `requestChatData`),
  `tokenScopeFor`/`mainModelTakesImages` (`settings.ts`), `readStorageFile`/`writeStorageFile`
  (`routes/storage.ts`).
- Client: `src/ts/storage/clientFlags.ts` (`risu.serverGeneration`, `risu.serverTransform`; no UI
  toggle until slice 9), `src/ts/process/serverCommands.ts` (`runServerButton`, `followJobToEnd`),
  the `Chat.svelte` branch, the `generateImage` and `inlayImage` callbacks in `jobChannel.ts`, and
  the saved-job resume at boot (`bootstrap.ts`).
- `Dockerfile` copies `version.json` (the server's `appVer`).

Deviations from the plan and the slice doc:

- Point 4 (Astra: untrusted CBS on the main thread has no execution bound, e.g.
  `{{range::[0,1,0]}}`) was rejected for this slice and is carried to Stop C as an owner item: it is
  phase-wide (slices 9 and 13 evaluate card CBS on the server by the phase design), and every server
  CBS evaluation goes through `cbsHost.ts`, where a bound would plug in. Recommendation for the
  owner: host-injected evaluator work/output limits on the server only.
- Point 12: the character and persona images are not decoded on the server. The inlay id is the
  asset key, as on the client; an existing inlay is returned at once, else the tab draws it with its
  canvas through an `inlayImage` callback (the client's PNG normalization and 1024² cap). A model's
  image output takes the same callback.
- The job channel keeps notices sent before the owner's first attach (1 MiB) and sends them on it in
  their order among the requests made meanwhile, or before the terminal of a job that ended first
  (a defect found by the browser check: a button's first `alertNormal` was lost, since the job
  starts before its owner attaches).
- A Lua run that fails outside its handler (a pool failure: no worker, a crash) ends the job, like
  a load failure; only a handler error is logged and skipped.
- `util/playwright/stack.mjs` links `public/` and copies `version.json` into its temporary root
  (the script workers read `public/lua/json.lua` there).

Recorded behavior:

- Through the job channel, notices and questions are shown one at a time; in the tab,
  `alertNormal` does not wait and a following question replaces it at once.
- `stopChat` keeps setting the run's `stopSending`; a button ignores it, as the client does.
- The built-in `request` returns nil at once on a refused key (the client returns a promise of
  nil); `logMain` logs raw text (the client parses its JSON).
- `similarity` raises "similarity is not available on the server yet" until slice 10.
- Lua `LLM`/`axLLM`/`simpleLLM` send no tools (MCP is slice 12) and no `request` trigger (slice 8b).
- A tab follows each job once (`followJobToEnd`, shared by the button, a busy job of its own, and the
  boot resume), with bounded reattaches; the end is reported once, and a lost job is released.
- A plugin model or a tab's dynamic model is refused in a job's request (it runs in the browser).
- The chat functions' reads use the job's view of the chat as read after its writes and callbacks;
  writes read the chat first.
- The command job's settings are frozen at its start; its chat and characters are read again after
  its own writes and callbacks; another chat is out of its scope (CBS `setvar` on another chat is
  not written).

Checks: `pnpm check` (only the invalidated test file's error), `pnpm format:check`, `pnpm build`,
`pnpm test:e2e` 6 passed, `pnpm test` (only the invalidated tests listed for the adapter), the
server tsconfig is strict (no new error); scratch smoke `p5s8a-smoke.ts` 24/24 (a real server, a
mock provider, the owner socket answering the questions); `util/playwright/checkServerButton.mjs`
14/14 (flag on: the job posted, the alert and the question in the UI, the edits shown, stored, and
kept after a reload; flag off: the browser path, no job).

Astra challenge (2026-10-02): round 1 found 9 blocking and 4 non-blocking points
(`/tmp/astra-p5-segC/p5s8a-challenge.md`): a fatal failure did not stop the handler's later
effects, a job interceptor's protocol failure was not fatal, writes were built from an older view,
async lore and inlay writes were not fenced after an abort, the tab's inlay writer ignored a
cancellation, early notices were lost for an ended job and reordered, the early buffer was not
bounded in bytes, plugin and dynamic model ids went to OpenAI, the reattach lifecycle lost final
records, plus error masking, an unread stream's registration, inlay answer checks, and the wire
union. All were fixed; round 2 (`p5s8a-challenge-2.md`) found three remaining blocking points (the
inlay metadata retry after a cancellation, concurrent follows of one job, a lost follow's channel
requests) and five smaller ones (boot resume retries, an aborted stream ending as success, image
media existence, UTF-8 counting, docs), all fixed. Round 3 (`p5s8a-challenge-3.md`) found two
blocking points (the boot resume's discovery outside the shared per-job lifecycle; a callback
started after an abort during the image file check), both fixed: the lifecycle is reserved before
discovery, and every callback starts behind the call's fence.

Fable's review found one problem the challenge rounds missed: the worker pool answered a host
function's `undefined` as JS `null`, which wasmoon pushes as its truthy `null` userdata, so a refused
guard, a void setter, or an unchanged `setChatVarChanged` was not `nil` in the script (and broke
`json.encode`). The pool now answers no value (`undefined` or `null`) as `nil` (`hostValue`). Astra's
round 5 (`p5s8a-challenge-5.md`) found no remaining defect. Fable then added
`server/src/tests/luaBindings.test.ts`, `luaBindingsFences.test.ts`, `serverCommands.test.ts`, and
cases in `scriptWorker.test.ts` (the nil boundary; the queue-cap test now waits for its blocker
instead of a fixed sleep), `jobChannel.test.ts`, `llmRequests.test.ts`, and `inlays.test.ts`. The
unbounded server CBS evaluation (Astra point 4) is recorded in `self-host-server.md` Known Hazards
and goes to Stop C.
