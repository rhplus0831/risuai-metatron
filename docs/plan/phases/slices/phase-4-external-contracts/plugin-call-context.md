# Slice: Plugin Call Context

Status: planned (drafted 2026-09-30, refined after review, not started).

Phase: [Phase 4](../../phase-4-external-contracts.md), the captured-context boundary Phase 5
asked Phase 4 for (`job-channel` and `post-generation-and-plugin-callbacks`: "scoping
selection-dependent plugin APIs to a captured context is a Phase 4 boundary"); `PLAN.md`
Decision 5 (a generation carries an execution context of character and chat ids, the selected
preset id, and the effective persona id, frozen for the job and reaching every callback; the
callback's own mutations settle before the job resumes) and Invariant 2.

Depends on: `plugin-host-setters` (the host functions already write through the module and
`updateSettings` exists), `character-and-collection-mutations` (`beginMutationScope`,
`flushResources({ scope })`). Sequential after the plugin host slice (same file); parallel with
the MCP, Lua, trigger, and import slices.

## Scope

Allowed files: `src/ts/plugins/apiV3/pluginContext.ts` (new), `src/ts/plugins/apiV3/v3.svelte.ts`
(the hook registration wrappers and the seven context-resolving host functions),
`src/ts/plugins/apiV3/factory.ts` (only if the implementer chooses to carry the handoff on the
callback wrapper instead of the registration wrapper), `src/ts/plugins/pluginHooks.ts` (types
only), the client hook runners `src/ts/process/index.svelte.ts` (`runChatOutputListeners`),
`src/ts/process/scripts.ts` (the `pluginHooks[mode]` loop), `src/ts/process/request/request.ts`
(the two replacer loops and `requestPlugin`), `src/ts/storage/collectionStore.svelte.ts`
(`updateSettings`'s `presetId` option, `readSetting`), the test mocks in
`src/ts/plugins/apiV3/hostApi.test.ts` where they stub the storage layer. No `docs/structure/`
file (the closeout edits the guides). Tests belong to the review step.

Identifiers (verified 2026-09-30 at `577c43ae`): one `SandboxHost` and one API object per plugin
(`v3.svelte.ts:1799`, `new SandboxHost(makeRisuaiAPIV3(iframe, plugin))`); callback wrappers and
pending callbacks are per host (`factory.ts:435`, `540-593`, `797-807`); the RPC carries a
`reqId` per request (255-263) but nothing that links a child host call to the hook it runs in.
Hook registration inside `makeRisuaiAPIV3`: `addRisuScriptHandler`/`removeRisuScriptHandler`
(817-833, `pluginHooks["edit" + name]`), `addRisuReplacer`/`removeRisuReplacer` (835-851),
`addRisuChatListener`/`removeRisuChatListener` (853-867, `pluginHooks.chatOutput`), `addProvider`
(the `providers` map, 981-1012). The selection-dependent host functions: `getChar` (694-696),
`setChar` (698-700), `parseRisuChat` (1210-1255: the parser at 1240 and `processScriptFull` at
1252 without `chatRef`), `getCurrentCharacterIndex` (1274-1276), `getCurrentChatIndex`
(1277-1281), `getCurrentLorebookEntries` (1282-1292: `getModuleLorebooks()` without a ref at
1291), `sendChat` (1670-1710: `appendMessage` on the selected chat, then `processSendChat(-1, {})`
at 1698, which sends the selected chat unless `arg.target` is given, `index.svelte.ts:358-372`),
and `runLLMModel` (1646-1668: `requestChatDataMain` without `chatRef`; `requestDataArgument.chatRef`
exists at `request.ts:45-47`). The runners and what they hold: `runChatOutputListeners`
(`index.svelte.ts:79-100`) with the send's `chatTarget` in `listenerIndices` (208-213); the
`pluginHooks[mode]` loop (`scripts.ts:163-170`) with `processScriptFull`'s `chatRef` (133); the
replacers (`request.ts:254-257`, `306-309`) and `requestPlugin` (892-936) with `arg.chatRef`.
Hooks with no chat in scope: `bodyIntercepterStore` (`globalApi.svelte.ts:357-379`, `1059-1097`),
`providerOptions.tokenizerFunc` (`tokenizer.ts:199-203`), the TTS hooks (`ttsHooks.ts`,
`characterId` only). Phase 3: `selection.presetId`/`selection.personaId`
(`selection.svelte.ts`), `PRESET_ROOT_ALIASES` (`shared/presets.ts`).

Stopping condition: a host function whose captured-context resolution would change a
documented behavior other than "which character and chat a hook means" (stop and report), or a
runner where the ref cannot be captured synchronously before the hook call (none: every runner
holds it in a closure).

## Assumptions

- `plugin-host-setters` landed: the host functions write through the module; `updateSettings`
  exists; the plugin `getDatabase` reads forwarded keys through `readSetting`.
- The registration helpers are called from the API object, which closes over `plugin`, so a
  per-plugin wrapper can be installed at registration; removal compares the original function,
  so the wrapper is cached per original function (a `WeakMap`).
- The client runners call the registered functions directly and synchronously start the call
  (no await between capturing the ref and invoking the hook), so a synchronous handoff at
  invocation is exact.
- Phase 5's `job-channel` serializes callbacks per client and wraps each in the job's context
  through the same handoff (a proposed edit to that slice, whose text still says the APIs "act on
  the tab's selection, as today").

## Proposed decisions

- Context shape (proposed): `PluginCallContext = { chatRef: ChatRef; presetId: string; personaId: string }`,
  captured by the runner before its first await (the send captures at its start; `processScriptFull`
  and the request layer at entry) from the ref in scope, `selection.presetId`, and
  `selection.personaId` (the chat's bound persona wins when set, as `getUserName` resolves it).
  Decision 5's mode and raw input are not carried (a client hook has no job).
- Attribution (proposed): the context is keyed by the plugin that owns the hook. Each registered
  hook function is wrapped at registration by a per-plugin wrapper; a runner hands the context
  over synchronously (`invokeHook(fn, context)` sets a module-level handoff slot and calls `fn`;
  the wrapper takes the slot at its first line, clears it, pushes the entry onto that plugin's
  stack in `pluginContext.ts`, and pops that same entry by identity when the hook's promise
  settles, success or failure). The host functions created by `makeRisuaiAPIV3(iframe, plugin)`
  read `currentContext(plugin.name)`: the innermost entry of that plugin's stack, or none. A host
  call from another plugin during a hook's await is therefore never attributed to the hook.
  Recorded limit: one plugin with two hooks in flight for different chats (for example a
  `chatOutput` listener awaiting while its own `editdisplay` handler runs) resolves to the
  innermost; the sandbox RPC carries no correlation id and one is not added (a private transport
  change is possible but is a protocol of its own; Phase 5 serializes callbacks per client, which
  removes the overlap for job callbacks). Alternatives rejected: one global stack (misattributes
  every plugin's calls during any hook); optional id parameters on the API (the declared surface
  does not change).
- Resolution (proposed): with a context, `getChar`, `setChar`, `getCurrentCharacterIndex`,
  `getCurrentChatIndex`, and `getCurrentLorebookEntries` resolve the character and chat from
  `context.chatRef` (by `chaId` and chat id); `parseRisuChat` passes the ref to `risuChatParser`
  and `processScriptFull`; `getCurrentLorebookEntries` passes it to `getModuleLorebooks`;
  `sendChat` appends to the context chat and calls `processSendChat(-1, { target: context.chatRef })`;
  `runLLMModel` passes `chatRef: context.chatRef` to `requestChatDataMain`; `setDatabase`,
  `setDatabaseLite`, and the theme setters call `updateSettings(patch, { presetId: context.presetId })`,
  which writes a forwarded key into that preset record through `PRESET_ROOT_ALIASES` instead of
  the accessor, so a settings write inside a callback lands in the preset the hook ran under
  even after a switch during a consent prompt. Without a context every function keeps today's
  tab-selection behavior. A context whose chat or character is gone throws a defined
  `PluginTargetGoneError` from the host function (the plugin sees an error); it never redirects
  to the tab's selection.
- Runners (proposed): `runChatOutputListeners` hands the send's context to each listener;
  `processScriptFull` hands its `chatRef` context to each `pluginHooks[mode]` handler (a display
  render without a ref hands none, so nothing changes there); the replacer loops and
  `requestPlugin` hand `arg.chatRef`'s context. `bodyIntercepter`, `tokenizerFunc`, and the TTS
  hooks have no chat in scope and hand none.
- Callback persistence contract (proposed; Astra P1): a runner that must know its hook's writes
  persisted (Phase 5's dispatcher; on the client only the review test) calls
  `beginMutationScope()` before invoking the hook and `flushResources({ scope })` after it; a
  non-empty `discarded` list means the hook's writes did not all persist, and the caller fails
  the callback with those keys. The client runners of this slice do not flush (the send's own
  flow saves as today); the contract is a Phase 5 boundary.
- Recorded behavior change: inside a hook, `getCharacter`, `setCharacter`, `sendChat`,
  `getCurrentCharacterIndex`, `getCurrentChatIndex`, `getCurrentLorebookEntries`, `parseRisuChat`,
  `runLLMModel`'s request trigger, and a settings write through `setDatabase` refer to the hook's
  chat and preset, not the tab's selection, when the two differ (today a `chatOutput` listener
  that calls `setCharacter` after the user switched characters mid-send writes the wrong
  character, and its `sendChat` sends the selected chat).

## Validation

`pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`. Review-step tests over
`storeBackedServer.ts` with two fake plugins registered through the real API object (the
`hostApi.test.ts` harness): a `chatOutput` listener for a chat that is not selected calls
`getChar`, `setChar`, `getCurrentChatIndex`, and `sendChat`, and each acts on the listener's chat
while the tab's selection is unchanged; a host call from the second plugin during the first
plugin's hook resolves to the tab's selection; two hooks of one plugin in flight resolve to the
innermost (the recorded limit, asserted so a change is noticed); out-of-order completion pops the
right entry; a hook that throws pops its entry; a call after the hook settled resolves to the
selection; `setDatabase({ temperature })` inside a hook after a preset switch lands in the hook's
preset; a deleted target throws `PluginTargetGoneError`; a `beginMutationScope` +
`flushResources({ scope })` pair reports a discard caused by a conflict during the hook. Manual,
recorded here: a test plugin whose `chatOutput` listener calls `setCharacter` and `sendChat`
while the user switches to another character during the send; after a reload the change and the
follow-up message are on the sending character.

## Residual risk

Same-plugin overlap resolves to the innermost context (recorded; exact under Phase 5's
serialization). A plugin that calls a context-dependent function from a timer started inside a
hook, after the hook settled, gets the tab's selection (as today). `bodyIntercepter`, tokenizer,
and TTS hooks have no context (they have no chat today either).
