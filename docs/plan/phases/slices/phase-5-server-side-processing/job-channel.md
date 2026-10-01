# Slice: Job Channel

Status: implemented (2026-10-01).

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 3 (the job-to-client channel);
PLAN.md Decision 5 (notices, questions, plugin callbacks, the registered-hook list, serialization,
timeouts).

Depends on: `generation-jobs` (the socket, the job identity, `applyServerGeneration`,
`applyHydration`); Phase 4 `character-and-collection-mutations` (`beginMutationScope()`,
`flushResources({ scope })`) and `plugin-call-context` (`src/ts/plugins/apiV3/pluginContext.ts`:
`invokeHook(fn, context)`, `currentContext(pluginName)`, `PluginTargetGoneError`).

## Scope

Allowed files: `shared/jobs.ts` (the envelope types), `server/src/jobs/channel.ts` (new),
`server/src/jobs/generationJobs.ts` (the owner socket), `src/ts/network/jobChannel.ts` (new:
the client dispatcher), `src/ts/network/generationJobs.ts` (the hook list at job creation). No
change to `src/ts/alert.ts`, `src/ts/plugins/pluginHooks.ts`, or the plugin API surface. Tests
belong to the review step.

Identifiers (verified 2026-09-30): the alert API in `src/ts/alert.ts`: questions `alertInput`
(238), `alertSelect` (135), `alertConfirm` (202), `alertPluginConfirm` (213), `alertSelectChar`
(191), `alertModuleSelect` (251); notices `alertNormal` (100), `alertError` (49), `alertToast`
(170), `alertMd` (155), `alertWait`/`alertClear` (177, 184); all modal alerts share `alertStore`,
and a question polls that store until the user answers. The processing-layer callers that become
channel traffic: `scriptings.ts` (`alertError` 167, `alertNormal` 173, `alertInput` 179,
`alertSelect` 185, `alertConfirm` 191, `ReloadGUIPointer` 403, `ReloadChatPointer` 410-413),
`triggers.ts` (`alertNormal` 789, `alertInput` 1369, `alertSelect` 1390, `ReloadGUIPointer` 1437
and 2074, `ReloadChatPointer` 1441-1444), `command.ts` (`alertInput` 91, `alertNormal` 96,
`alertSelect` 108, `alertNormal` 245, `alertMd` 265), `scripts.ts` (`CharEmotion.set` 246),
`index.svelte.ts` (`CharEmotion.set` 2323-2500, `Notification` 2291-2300, `sayTTS` 2111/2189),
`hypav3.ts` (`hypaV3ProgressStore` 292-638). Plugin registries: `pluginHooks.replacerbeforeRequest`,
`replacerafterRequest`, `editinput`/`editprocess`/`editoutput`/`editdisplay`, `chatOutput`,
`providers`, `providerOptions` (`pluginHooks.ts:29-45`; registered by `addRisuReplacer`,
`addRisuScriptHandler`, `addRisuChatListener`, `addProvider` in `v3.svelte.ts:817-1014`; a
provider's `LLMModel` descriptor is built at 991-1012); the body interceptors are
`bodyIntercepterStore` (`src/ts/stores.svelte.ts:130-135`, `registerBodyIntercepter`
`v3.svelte.ts:1367-1384`), whose callback receives `(body, type)` only (no headers, no URL:
`globalApi.svelte.ts:374`, `1092`), also used for Google metadata (`google.ts:777-787`,
`1302-1305`); there is no separate metadata interceptor. Plugin MCP tools:
`registeredCustomPluginMCPs` (`pluginmcp.ts:34-56`). The settle barrier: `flushResources()`
(`resourceSync.svelte.ts:1087-1145`) saves every dirty record and queued chat op and resolves when
acknowledged; it rejects only when an unsettled key belongs to a character deferred behind a
client-side generation (`isBlockedKey` 215-222, `isChatDeferred` `chatStore.svelte.ts:2389-2396`),
which server jobs do not create.

Stopping condition: a UI effect that needs a synchronous answer inside a host call the worker
cannot suspend on; recorded, and that function fails explicitly.

## Assumptions

- The job socket carries typed JSON both ways; the owner is the `clientId` from
  `generation-jobs`.
- Phase 4 made every plugin write a mutation (`characterStore.svelte.ts` `updateCharacter(chaId, patch)`
  and `replaceCharacterFields`, `collectionStore.svelte.ts` `updateSettings(patch, { presetId })`
  and `readSetting`, `pluginStorageStore.svelte.ts`), so a callback's writes are ordinary chat ops
  and resource records; `beginMutationScope()` and `flushResources({ scope })` report every key
  discarded by a conflict since the scope began, including one discarded while the callback ran.
- Phase 4's `plugin-call-context` gives each plugin a per-plugin context stack fed by a
  synchronous handoff at hook invocation (`invokeHook(fn, context)` with
  `{ chatRef, presetId, personaId }`); the selection-dependent host functions (`getChar`,
  `setChar`, `sendChat`, `parseRisuChat`, `runLLMModel`, `getCurrentChatIndex`, ...) resolve the
  innermost entry, and a gone target throws `PluginTargetGoneError`.

## Proposed decisions

- Envelopes (proposed, `shared/jobs.ts`): server to client `notice { kind, payload }` with kinds
  `alertNormal`, `alertError`, `alertToast`, `alertMd`, `reloadDisplay`, `reloadChat { index }`,
  `updateGUI`, `emotion { name, image }`, `progress`, `tts { text }`, `notification`,
  `requestLog` (its payload is the secret-free projection from `request-layer-and-llm-secrets`);
  `question { id, kind, payload, timeoutMs }` with kinds `alertInput`, `alertSelect`,
  `alertConfirm`, answered by `answer { id, outcome, value? }`; `callback { id, jobId, name, targets, revisions, payload }`
  with names `replacerbeforeRequest`, `replacerafterRequest`, `bodyIntercepter`, `editinput`,
  `editprocess`, `editoutput`, `editdisplay`, `chatOutput`, `provider`, `mcpTool`, `generateImage`,
  answered by `answer`. The client's registered-hook list at creation:
  `{ replacers, scripts, interceptors, chatOutput, providers: [{ name, model: LLMModel }], mcpTools }`,
  with the provider descriptors frozen at creation (name, `LLMModel` with its flags, parameters,
  and `LLMTokenizer`), computed from the registries above; the server calls back only for listed
  names.
- Question outcomes (proposed): `answered`, `cancelled` (the user dismissed), `timedOut`,
  `disconnected` (no owner socket within the timeout), `aborted` (the job ended). A question that
  is not `answered` fails the invoking stage explicitly: the Lua host call raises an error the
  script sees (the run reports it and the job records a `notice`), a `v2GetAlert*` effect stops
  its trigger with an error, and a plugin callback that is not `answered` ends the job with
  `error`. Timeouts: questions 120 s, callbacks 60 s (`provider` callbacks: the job's timeout).
  Late answers after a timeout or abort are ignored. Modal notices (`alertNormal`, `alertError`,
  `alertMd`) are queued behind an open question on the client and shown after it; toasts and
  progress are not queued.
- Serialization (proposed): one outstanding question or callback per client; the server queues the
  rest. A child LLM request a plugin makes inside a callback (`runLLMModel`) is an `aux` request
  (`request-layer-and-llm-secrets`) and never takes the chat lock, so it cannot deadlock behind
  the callback or get `chatBusy`.
- Barrier (proposed, minimal): before a `callback` the job's changes so far reach the client as
  `chunk` and `resource` events (hydration, `generation-jobs`), and the client applies them before
  running the plugin function; the dispatcher calls `beginMutationScope()` before the callback
  and `flushResources({ scope })` after it, and answers only when the flush resolves (the existing
  save loop is the acknowledgement); a non-empty `discarded` list answers `outcome: "failed"` with
  those keys, and a rejected flush answers the same with its reason; either ends the job with
  `error`. The job resumes from the acknowledged state (it re-reads the chat it wrote through).
  The dispatcher hands the job's context (`chatRef`, `presetId`, `personaId`) to each callback
  through Phase 4's per-plugin handoff (`invokeHook(fn, context)` from `plugin-call-context`), so
  `getChar`, `setChar`, `sendChat`, `parseRisuChat`, `runLLMModel`, and the index getters act on
  the job's chat and preset, not the tab's selection; a `PluginTargetGoneError` inside a callback
  is a `failed` outcome.
- Client dispatcher (proposed): `jobChannel.ts` maps notices to `alert.ts`, the pointers, and
  `CharEmotion`, questions to the alert functions with the cancel outcome, and callbacks to the
  `pluginHooks` sets by name, reusing `runChatOutputListeners`' index resolution
  (`index.svelte.ts:79-100`) for `chatOutput`.
- The `trigger_id` for manual triggers travels in the job context; the client store stays for the
  display path until `script-transform`.

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`; the review step adds `server/src/tests/jobChannel.test.ts`
with a fake `ws` client: each outcome, a question with no owner that fails at the timeout, a late
answer ignored, callback serialization, a callback whose answer is `failed`, reconnect with a
pending question; and `src/ts/network/jobChannel.test.ts` for the dispatcher (a notice arriving
during a question is queued). This is the Safety Contract item "Channel questions and plugin
callbacks fail explicitly on timeout or with no connected client".

## Residual risk

A plugin whose callback mutates the chat concurrently with the job's own writes is ordered by the
job (server writes before the callback, the callback's writes acknowledged before the job
resumes) but a conflict on the chat revision still reloads that chat on the client, as Phase 2
does.

## Implementation record

Implemented 2026-10-01 on `9b41aa28`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 6) and Astra's plan review (14 points:
11 adopted, one adopted with changes, two rejected and recorded below). Nothing on the server calls
the channel yet (slices 8a, 8b, 9, and 11 do); the runner is still the 501 stub.

- **`shared/jobs.ts`**: `GenerationHooks` (`NO_GENERATION_HOOKS`, `SCRIPT_HOOK_MODES`); the
  notices (`alertWait` and `alertClear` added; `emotion`, `reloadChat`, `tts`, and `notification`
  carry ids); the questions (`alertSelectChar` and `alertModuleSelect` added); the callbacks
  (`targets`, `revisions` receipts, `parentId`, `deadline`, `replay`), `cancel`, the client's
  `answer`, and the outcome types (`CallbackFailure`: `hook`, `barrier`, `protocol`).
- **`server/src/jobs/channel.ts`**: `createChannelHub` and `parseGenerationHooks`, as
  `self-host-server.md` describes. **`server/src/jobs/generationJobs.ts`**: the hub, a channel per
  job (`RunningJob.channel`, `ownerAttached`), the validated hook list, receipts from
  `emitRecords`, answers only from the current socket, the outstanding requests re-sent after an
  attach snapshot, and the channel closed on an abort (at once) and at the start of finalization.
  **`server/src/routes/generations.ts`**: a malformed hook list is a 400.
- **`src/ts/network/jobChannel.ts`**: the dispatcher, as `global-api.md` describes.
  **`src/ts/network/generationJobs.ts`**: `applyGenerationEvent(..., transport)` routes channel
  events to the dispatcher (loaded on first use, one ordered chain) and remembers every hydration
  for the barrier; `createGenerationJob` sends `registeredHooks()`.
- **`src/ts/storage/chatStore.svelte.ts`, `resourceSync.svelte.ts`**: `heldChatRevision` and
  `heldRecordRevision` (read only; outside the slice's allowed files, needed by the barrier).

Deviations from the reviewed plan, from Astra's plan review: failures carry their source; the
barrier covers every record the job hydrated (receipts), with an unconditional flush first; the
client keeps per-request state, never runs a duplicate, and refuses a replay it has no state for;
the channel closes on every end and on an abort; the dispatcher does not wait for a callback
before taking the next event (a child runs while its parent waits); one deadline from enqueue;
answers validated and bound to the current socket; interceptors continue per entry; the hook list
is validated (400) and built from the active registries; toasts and alert notices queue behind an
open question.

Rejected (recorded):

- Astra point 6 (hook context for interceptors and MCP tools): the browser path calls them without
  the hook context (`globalApi.svelte.ts:371-378`, `pluginmcp.ts`), so they act on the tab's
  selection; the channel keeps that parity. Wrapping their registrations is a plugin-API change
  (slice 11 may take it).
- Astra point 8 (`cancelled` on dismissal): the alert API returns the same value for a dismissal as
  for an answer, so neither path can tell them apart; the client answers `answered` with the raw
  value, and `cancelled` is reserved.

Recorded behavior and limits:

- toasts and the other alert notices wait while a question is open (the amendment's "toasts are
  not queued" would let a toast replace the question in the shared alert store);
- a hook already running when its callback is cancelled cannot be stopped; its writes still flush;
  until it settles it keeps the client's lane, so a later root callback or question (another
  job's included) is refused `failed`/`protocol` meanwhile (the lane policy of plan-review point 4);
- a plugin that registers a provider with a malformed `model` descriptor (plugins are untyped)
  makes the client's hook list a 400 on every job creation; the browser path tolerates it;
- a cancelled question's alert poller (`waitAlert`) keeps polling until the alert store next shows
  `none`; the queue no longer waits for it and its result is dropped, but cancelling many
  questions while another alert stays open accumulates pollers (Astra challenge R2; a cancellable
  waiter needs an `alert.ts` change outside this slice);
- a callback the page has no state for after a reload is refused rather than run again;
- `chatOutput`'s per-listener hydration, the provider streaming leg (`providerChunk`,
  `providerDone`), the `generateImage` result, and post-terminal effects belong to slices 11 and
  8a; `answer` is not their carrier;
- the index-based plugin getters keep resolving through the tab inside a callback; a plugin write
  the client refuses (a locked message) warns and records nothing (both from the amendments).

## Astra challenge (2026-10-01) and decisions

Three rounds (reports under `/tmp/astra-p5s6/`); every blocking point was adopted and rechecked.

1. Round 1 (6 blocking, 2 not): a callback queued before the first attach was sent later as a
   `replay` and refused (the transport now reports delivery; only a delivered request is a
   replay); the pre-callback flush's discarded keys were ignored (now `failed`/`barrier`); a
   cancel during the barrier still started an MCP tool (cancellation checked on entry and before
   `callTool`); the job's end left its showing question open and a cancel could clear an unrelated
   alert (the showing question owns its alert; one cancellation path); deadlines relied on timer
   execution (`expireIfDue` before an answer, a dispatch, and an attach re-send); an `undefined`
   result or a falsy throw produced a malformed success (whether it threw is tracked apart; results
   must survive JSON, else `failed`/`protocol`). Not blocking, adopted: the cache evicts only
   finished requests; provider descriptors are checked for the `LLMModel` fields the server reads.
2. Round 2 (1 blocking, 2 not): an expired child callback was still hydrated and sent (expiry now
   at the common dispatch boundary, and an overdue parent is settled before a child is admitted);
   cancelled questions were never evicted (retired on cancel and at the job's end). The alert
   poller residual (R2) is recorded above.
3. Round 3: resolved; no new blocker.

Tests the change invalidates on purpose (for the Fable test-adapter):
`src/ts/network/generationJobs.test.ts` "creates a job with the epoch and the client id, remembers
it, and maps the refusals to typed errors": the create body now carries `hooks`
(`registeredHooks()` when the caller passes none), and computing it loads the dispatcher, whose
imports need the full stores module the test mocks.

Evidence: `pnpm check` 0 errors, `pnpm format:check` clean, `pnpm test` 1,407 passed (the one test
above fails as intended). A scratch smoke against a listening server (21 checks after the
challenge, all passing; the added one is a callback queued before the owner connects): a
malformed hook list 400; a notice; a question answered; a callback not in the hook list refused
and never sent; a callback carrying its chat receipt and targets, with that hydration sent right
before it; a callback answered; a barrier failure with discarded keys reported; a question timing
out with an owner (`timedOut`, `cancel` sent) and without one (`disconnected`); a child callback
inside its parent, a bad parent refused, the parent answered after its child; a reconnect
re-sending a pending question as a replay with the same id and deadline; an answer from the
superseded socket ignored; DELETE settling a pending question `aborted` with `cancel` before the
terminal; two questions serialized in order.

## Checks

`pnpm check`, `pnpm format:check`, `pnpm test` (118 files, 1,451 passed, 3 skipped), `pnpm build`,
and `pnpm test:e2e` (5 passed) pass on the final tree; the scratch smoke passes 21/21.

## Tests

Written by the Fable reviewer (verdict: no problem; 42 new tests):

- `server/src/tests/jobChannel.test.ts` (the hub with a recording transport and an injected clock,
  then the registry on a listening server): `parseGenerationHooks` and `isBarrierFailure`; notices;
  questions (FIFO, answer validation, late answers, `timedOut` with an owner and `disconnected`
  without, the clock as authority); queued expiry with zero hydration and lane reuse; the hook-list
  refusals; hydration right before a send with receipts; nesting (deadline capped by the parent,
  wrong parent, third level, sibling, an overdue parent settled on admission); per-client FIFO
  across jobs and the 256 cap; first delivery vs replay; close semantics; and on the real socket a
  callback queued before the owner attaches, reconnect replay, the superseded socket's answer, and
  DELETE or a normal end settling a pending request `aborted` with `cancel` before the terminal.
- `src/ts/network/jobChannel.test.ts` (the real `alert.ts` with fake timers): raw answers per
  question kind, notice queuing behind a question, every effect notice, cancellation of queued and
  showing questions (owned-alert clearing only, stale results never sent, cached answers resent),
  job-end cleanup, the memory bound; callbacks: hook order under `invokeHook`, the scoped flush,
  `currentChannelCall`, pre-barrier failures before any hook, barrier precedence over hook errors,
  falsy throws, wire-unsafe results, unavailable hooks, replacers vs interceptors on a throw (and
  interceptors and MCP tools running without hook context, as recorded), cancellation before a
  tool and between hooks, duplicates never rerun, unknown replays refused, nesting, and
  `registeredHooks()`.
- `src/ts/network/jobChannelBarrier.test.ts` (the real save adapter, chat module, and dispatcher
  over the in-memory server store): the hook sees the hydrated chat in socket order with no
  outgoing write; a busy chat is settled first; the hook's own write reaches the server before the
  answer and a conflict answers `failed`/`barrier` with its keys; a receipt ahead of what the
  client holds, or from another epoch, fails before the hook.
- `src/ts/network/generationJobs.test.ts` (adapted): the create body's `hooks`, the stub of
  `./jobChannel` completed, and the lazy dispatch in socket order with the follow as transport.
- `server/src/tests/backups.test.ts`: the pre-existing flake ("refuses a restore queued behind
  another one with 412") made deterministic; both restores verify a JWT before `withMaintenance`,
  so the second could queue first. The second now starts after the first is tracked.

Fable judged every item of Astra's testing advice necessary and covered it, except the browser
check: nothing on the server emits a channel event before slices 8a, 9, and 11, and nothing in the
app creates a job yet, so the listening-server tests cover the real socket path instead.
