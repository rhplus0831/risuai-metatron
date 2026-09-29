# Slice: Job Channel

Status: planned (drafted 2026-09-30, refined after review, not started).

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
