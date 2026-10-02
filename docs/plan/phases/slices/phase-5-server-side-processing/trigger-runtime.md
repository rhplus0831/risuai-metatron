# Slice: Trigger Runtime

Status: implemented (2026-10-02); see the implementation record at the end.

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

## Implementation record (2026-10-02)

Files: `shared/jobs.ts` (`GenerationCommand` gains `{ type: "manual", name }`, `MAX_TRIGGER_NAME_BYTES`);
`server/src/routes/generations.ts` (the manual command; `context.triggerId` a nonempty string of at
most 4096 bytes instead of a resource id, since a `risu-id` is free text); `server/src/prompt/triggers.ts`
(the runtime); `server/src/prompt/commands.ts` (the command executor); `server/src/jobs/chatResult.ts`
(`applyTriggerChat`); `server/src/jobs/commandRunner.ts` (the manual path, shared setup with buttons;
the runner takes the generation lock); `server/src/lua/bindings.ts` (`withWorking`,
`observeCharacterPatches`, `services`, `patchPersonaPrompt`, the request mode widened to
`ModelModeExtended`, lore activation factored); `server/src/app.ts` (the lock to the runner); client
`src/ts/process/serverCommands.ts` (`runServerCommand` shared by `runServerButton` and
`runServerManualTrigger`, with a typed outcome and `onStart`), `src/lib/ChatScreens/Chat.svelte`,
`src/ts/process/command.ts` (`fromInput`), `src/lib/ChatScreens/DefaultChatScreen.svelte` (passes
`fromInput`); `util/playwright/checkServerTrigger.mjs`; the structure docs.

Deviations from the scope above, all recorded:

- Allowed files: `chatResult.ts`, `bindings.ts`, `commandRunner.ts`, `serverCommands.ts`,
  `DefaultChatScreen.svelte`, and `app.ts` were added; `shared/triggers.ts` was not needed.
- `/send` and `/sendas` only append on the client (only `/multisend` sends), so no follow-up
  generation is enqueued; `/multisend` is refused with an `alertError` (owner question at Stop C).
- Six native regex sites, not five: `v2GetLorebookByName` also compiles a user pattern. Its pattern is
  compiled on an empty input first, as the client compiles it before the loop.
- `/trigger` runs on the server only from the chat input (`fromInput`): a browser trigger's
  `v2Command` must not post a job in the middle of a browser send.
- A nested display-mode run cannot occur today (`v2RunTrigger` is outside both allowlists, and
  only display and request runs set `displayMode`), so no separate read-only capability was added;
  the display mode, display data, and temporary variables are passed to the nested run.

Astra plan review (`p5s8b-plan-review.md`, ten points): all adopted, point 5 with a change.

1. The working-copy mapping per host function (lookup reads the copy's local lore; activation,
   CBS, and `getGlobalVar` stay live; `reloadChat` resolves on the live chat). 2. A dedicated final
   applier with the lock check for reorders and an atomic group. 3. The replay of `scriptstate` and
   the note by the final diff is kept and recorded. 4. Fences after every await, fatal errors
   rethrown from every fallback catch, the native regex raced against the run signal. 5. Nested
   runs take the temporary-variable map by reference and hand display data back; each recursion
   level yields; the read-only capability was not added (see above). 6. The lore pattern compiled on
   empty input; the replacer reproduced with its quirks. 7. Results `null | undefined`, the Lua mode
   default `"manual"`. 8. Personas as the singleton list, one entry patched. 9. `triggerId` nonempty;
   `CurrentTriggerIdStore` set only once the job exists (`onStart`). 10. Lua character patches reach
   every running trigger of that character.

Checks: `pnpm check`, `pnpm format:check`, `pnpm test` (135 files, 1617 passed), `pnpm build`,
`pnpm test:e2e` (6 passed); the scratch smoke `p5s8b-smoke.ts` (23/23: variables, if, loops, CBS over
the immediate writes and `{{trigger_id}}`, the alert and the questions, character and lore writes,
commands with a nested `/trigger`, the six regex sites, the effect limit, an invalid regex, an abort
during `v2Wait`, the persona write and the frozen getter, `v2CutChat`, Lua on the working copy with
the native getter after `setDescription`, route validation); `node util/playwright/checkServerTrigger.mjs`
(16/16: flag on, a `risu-trigger` with `risu-id` and `/trigger` from the input run as jobs, the
alert and question in the UI, the edits shown, stored, and after a reload; flag off, no job).

Review: Fable found no problem and wrote the regression suites `server/src/tests/triggerRuntime.test.ts`,
`chatResult.test.ts`, `commandExecutor.test.ts`, and `manualTriggers.test.ts` (a real listening server),
and extended `src/ts/process/command.test.ts` and `serverCommands.test.ts` (129 tests; 139 files, 1746
passed). The `Chat.svelte` trigger-id owner token has no component test. Parity quirks confirmed and kept
(inherited from the tab): a trigger's own new message is anchored after its predecessor in the copy, so it
lands before messages its `v2Command`s appended meanwhile; `/addvar` on a missing variable stores `"NaN"`;
`/cut -1` keeps only the first message; quote characters stay in a piped argument.
