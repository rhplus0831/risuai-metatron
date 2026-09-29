# Slice: Lua Bindings And Buttons

Status: planned (drafted 2026-09-30, refined after review, not started).

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
