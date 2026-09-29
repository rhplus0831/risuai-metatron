# Slice: Trigger Runtime

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 5](../../phase-5-server-side-processing.md), the trigger-runtime part of step 7
(the trigger runtime with its UI effects through the channel, `v2Command` on the server) and the
manual-trigger part of step 6; PLAN.md Decision 5. Moved ahead of step 4.

Depends on: `lua-bindings-and-buttons`.

## Scope

Allowed files: `server/src/prompt/triggers.ts` (new: the trigger runtime port),
`server/src/prompt/commands.ts` (new: the data-changing subset of `processMultiCommand`),
`server/src/routes/generations.ts` (the `command` kind, `manual` variant), `src/ts/process/triggers.ts`
(unchanged behavior), `src/ts/process/command.ts` and `src/lib/ChatScreens/Chat.svelte` (the
manual-trigger callers behind the flag), `shared/triggers.ts` for exported types. Tests belong
to the review step.

Identifiers (verified 2026-09-30): `runTrigger(char, mode, arg)` (`triggers.ts:108-128`),
`triggerMode` (31), `displayAllowList`/`requestAllowList` (77-86), the effect switch (343), UI
cases `v2Command` (690, `processMultiCommand`), `v2ImgGen` (706, image generation plus
`new Image()` 723), `v2ShowAlert` (781), `v2GetAlertInput` (1365), `v2GetAlertSelect` (1377),
`v2UpdateGUI` (1436), `v2UpdateChatAt` (1440), `v2RunLLM` (748), `v2CheckSimilarity` (730),
`v2Tokenize` (1559), `v2RunTrigger` (606), `v2SendAIprompt` (699), the `ReloadGUIPointer` bump
after a variable change (2073-2075), `CurrentTriggerIdStore` (174, 179, 2078), `triggerlua`
(349-358). Manual callers: `Chat.svelte:449` (`runTrigger(..., 'manual', { manualName, triggerId })`),
`command.ts:253` (`/trigger`). `processMultiCommand` (`command.ts:26-56`) and the command list
(90-321).

Strict-mode cost: about 22 errors in `triggers.ts` (review count).

Stopping condition: an effect whose semantics need the client's live chat object rather than the
job's working copy in a way the Phase 2 diff cannot express; recorded and that effect refuses on
the server.

## Assumptions

- Phase 4 `trigger-effect-writers` routed the character effects (`v2SetCharacterDesc`,
  `v2SetReplaceGlobalNote`, the six lorebook writers) through `updateCharacter(char.chaId, { field })`
  (one field per effect) and `v2SetPersonaDesc` through `updatePersona(selection.personaId, { personaPrompt })`;
  `v2SetVar` and `v2SetAuthorNote` stay chat `meta` writes, and every caller persists the
  returned chat with `applyChatResult` (the diff; `replaceChat` only for a reorder). On the
  server those are `applyChanges` ops under the job token.
- The setters address the executing character (the clone's `chaId`: the speaking member in a
  group send, not the group and not the selection), Phase 4's executing-character rule, shared
  with `lua-bindings-and-buttons`; `v2SetPersonaDesc` is re-targeted here to the frozen effective
  persona of the execution context (a bound persona wins), the handoff Phase 4 records for this
  phase (Phase 4 writes the selected persona).

## Proposed decisions

- The trigger runtime is ported with the same effect switch; display and request runs keep
  `displayMode: true` semantics (temp variables, no writes). UI effects: `v2ShowAlert`,
  `v2GetAlertInput`, `v2GetAlertSelect` become notices and questions (a question not `answered`
  stops the trigger with an error); `v2UpdateGUI` and `v2UpdateChatAt` become notices; the
  `ReloadGUIPointer` bump after a variable change becomes one `updateGUI` notice per run;
  `v2ImgGen` uses the `generateImage` callback and drops the `new Image()` size probe (the
  callback answers with the inlay's dimensions); `v2RunLLM` uses the server request layer;
  `v2CheckSimilarity` the embeddings service (the failure value until `memory-on-server`);
  `v2Tokenize` the counter.
- `v2Command` calls the server command executor for data-changing commands (`send`, `sendas`,
  `comment`, `cut`, `del`, `setvar` and friends, `trigger`) and emits notices for UI commands
  (alerts, `tts`, help); a `/send`-class command inside a job enqueues a follow-up generation on
  the same job's bounded loop (`post-generation-and-plugin-callbacks`) instead of recursing;
  `/multisend` inside a trigger is refused on the server (recorded; owner question).
- Manual triggers (proposed): `POST /api/generations` with `kind: "command"` and
  `{ context, command: { type: "manual", name, triggerId } }`; `Chat.svelte:449` and
  `command.ts:253` call it behind the flag. The result (a changed chat) is applied on the server
  by the diff rule and reaches the client as `chunk`/`resource` hydration and `done`.
- `CurrentTriggerIdStore` is replaced on the server by the context's `triggerId`.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step adds
`server/src/tests/triggers.test.ts` (the effect switch on fixtures, the allowlists, `v2Command`
routing, a question outcome stopping the trigger) and a Lua module fixture whose manual triggers
and alerts behave the same as on the client (the phase's exit criterion). Manual: with the flag
on, a manual trigger from the chat menu runs through the endpoint.

## Residual risk

Trigger lines are not atomic on the server either (Phase 2's known limit).
