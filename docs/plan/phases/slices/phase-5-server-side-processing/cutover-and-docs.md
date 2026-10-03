# Slice: Cutover And Docs

Status: implemented 2026-10-03 (see "As implemented").

Phase: [Phase 5](../../phase-5-server-side-processing.md), the exit criteria (the browser
generation path removed, no wasmoon in the bundle, no LLM credential in client traffic), the
Safety Contract record, and the docs; PLAN.md Decisions 5 and 6, invariant 7.

Depends on: every other slice of this phase.

## Scope

Allowed files: `src/ts/process/index.svelte.ts` (the browser assembly body removed; `sendChat`
keeps its signature as the job client), `src/ts/process/request/**` (the client transport to
`/api/llm/request` stays; the provider modules and their tests were moved in
`request-layer-and-llm-secrets`), `src/ts/process/{scriptings,triggers,scripts}.ts` (the
runtimes deleted; editor-facing types and constants stay in `shared/triggers.ts` and
`shared/scripts/regex.ts`), `src/ts/tokenizer.ts` (the remote Google count and the plugin
`tokenizerFunc` branch removed from the generation path; the browser loaders stay for the
playground and the editor counters), `src/ts/globalApi.svelte.ts` (`fetchViaProxyJobWs` and the
LLM `fetchNative` branches that no caller uses), `src/ts/network/proxyJobWs.ts` and its test,
`src/ts/storage/chatStore.svelte.ts` (the client generation lock path kept only for
`applyServerGeneration`), `src/ts/storage/clientFlags.ts` (the flag removed) and every
flag-reading site, `src/ts/process/mcp/mcp.ts` (the LocalForage tool-call store removed),
`vite.config.ts`, `docs/structure/{chat-pipeline,llm-requests,scripts-triggers,cbs-rendering,plugins-mcp,memory,self-host-server,global-api,persistence,media-aux,settings-i18n}.md`,
`STRUCTURE.md` (T2, P2, S2, D1 to D4, `Choose By Task`, `Path Ownership` rows for
`server/src/{jobs,llm,lua,scripts,prompt,mcp}` and `shared/{cbs,scripts,lore,prompt,llm}`),
`docs/plan/PLAN.md` (status line, Decision 2 note), the phase file (Implementation Record,
Safety Contract), the slice files. `wasmoon` stays in `package.json` (the server imports it).
Tests belong to the review step.

Identifiers (verified 2026-09-30): `wasmoon` is imported only by `src/ts/process/scriptings.ts:4`;
`fetchViaProxyJobWs` (`globalApi.svelte.ts:861-1041`) is used only by `fetchNative`'s
local-network OpenAI streaming branch (1132-1147); `/proxy2` remains for the auxiliary callers
(`tts.ts`, `stableDiff.ts`, `translator.ts` DeepL, `googlesearchclient.ts`) and the hub proxy;
`proxyStreamJobs` stays on the server (no client caller after cutover: proposed to keep the route
one phase, then remove in Phase 6). Browser Transformers.js and `HypaProcesser` users that remain:
`PlaygroundEmbedding.svelte`, `CharConfig.svelte` `registerOnnxModel`, `tts.ts` `runVITS`; so
`hypaVector` and `tfCache` are not unused. Exit-criteria commands: `rg -l wasmoon dist/assets`
empty after `pnpm build`; the network capture of a send, a translation, a suggestion, a model-list
refresh, and a DALL-E image in headless Chrome shows only same-origin requests.

Stopping condition: a client caller of the browser assembly path, the client Lua or trigger
runtime, or a credential that no earlier slice routed (the type check and `rg` list them); it is
recorded and routed here only if it is a one-line change, otherwise reported.

## Assumptions

- Every scenario in the phase's exit criteria (send, continue, reroll, group, memory, image
  generation) passed on the server path with the flag on, with the golden prompt and transform
  tests green, before this slice starts (the Safety Contract gate).
- Phase 6 will add live updates; this slice does not. The job socket's `resource` events stay
  (they are the owner's guarantee before a callback); Phase 6's feed deduplicates by revision
  through the same `applyHydration` comparison.

## Proposed decisions

- The client-local flag is removed with the browser assembly path and the client `editdisplay`
  path; there is no runtime switch after cutover (rollback for this phase means reverting the
  cutover commit while the server path keeps working).
- `proxyJobWs.ts` and `fetchViaProxyJobWs` are deleted with their tests; the server kind stays
  until Phase 6 (proposed), recorded in `self-host-server.md`.
- Safety Contract record: every behavior listed in the phase file is confirmed against the slice
  that introduced it (the README's map), with the additions found while slicing: a button or
  manual trigger during a send is refused if the owner keeps the command-lock default;
  `/multisend` inside a trigger is refused on the server; the resend and auto-continue loop is
  capped (8); local WebLLM summarization (and, if the in-slice check fails, local Transformers.js
  models) are unsupported on the server; dynamic-asset regex replacement runs on the server only
  from `memory-on-server` on; the Lua `request` limit is 30 per minute with a 10 s and 2 MB cap;
  settings changed during a job do not affect it; a server restart clears the generation lock; the
  request log for server calls comes from the `requestLog` notice through the secret-free
  projection; `v2ImgGen`'s image size comes from the callback answer; an image callback with no
  owner leaves the reply without the image; the server display stages (Lua `editDisplay`, the
  display trigger, CBS, regex) run with the viewport and language the client reports, the CBS
  pre-pass and the plugin display handlers stay in the browser (slice 13); every message
  re-renders after any chat variable changes; plugins see masked LLM credentials through `getDatabase`; `bodyIntercepter`
  registrations are not applied to browser-path calls without a job.
- Docs: `chat-pipeline.md` becomes the client-side description of the job client plus a pointer
  to the server runner; `llm-requests.md` moves under the server guide's ownership for
  `server/src/llm/`; `scripts-triggers.md` splits into editor (client) and runtime (server);
  `cbs-rendering.md` records the transform; `plugins-mcp.md` the callbacks and the MCP split;
  `memory.md` the server vector cache; `self-host-server.md` the routes, the worker pool, the
  tests; `global-api.md` the reduced transport; STRUCTURE P2 says provider calls are server-side
  and T2/D1 that `shared/` holds runtime modules.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; `rg -l wasmoon dist/assets` empty;
`rg "fetchViaProxyJobWs|runScripted|runLuaEditTrigger|processScriptFull\(" src` lists only the
transports and wrappers this slice keeps; the headless Chrome network capture for the credential
criterion; the full manual matrix of the phase (send, continue, reroll, group, memory, image
generation, Lua buttons, manual triggers, alerts, two tabs, a reload mid-stream, a restore during
a send, Docker with a fresh volume) recorded in the phase file; the guides name only identifiers
that exist (`rg`).

## Residual risk

Two clients still converge only on reload until Phase 6's live updates. The auxiliary providers
keep the proxy and client-readable keys by Decision 6.

## As implemented (2026-10-03)

- Owner decisions at the stopping condition (two unrouted runtime callers):
  - the transform fallback (`captureTransform` null: no chat, a chat not saved yet, no preset or
    persona) skips the script stage, and a new chat's rows render again after its first save
    (`chatStore.svelte.ts` `chatSaveVersion`, bumped where a chat first gains a held revision;
    `Chat.svelte` bumps `chatBodyRevision` for its chat);
  - the tab's own LLM requests no longer run the `request` trigger (`request.ts`).
- Plan review (Astra) decisions:
  - the translator's `edittrans` is a recorded client exception, not a stop: plain `RegExp` on
    translation text, not the Lua, trigger, or generation path;
  - the browser provider adapters moved to the test-only `src/ts/process/request/tests/oracle/` so
    the parity tests keep their differential cases (removed in Phase 6);
  - the browser-only memory copies (SupaMemory, HypaV2, Hanurai), `exampleMessages.ts`,
    `embedding/addinfo.ts`, `models/modelString.ts`, and `models/nai.ts` were deleted;
    `memoryOracle.test.ts` keeps the HypaV3 cases (the server fixture suite holds the rest);
  - the chat module's browser generation producers stay as dead code (no production producer),
    recorded for Phase 6's closeout with their tests (option (b), a scoped deviation from this
    file's "kept only for `applyServerGeneration`");
  - DevTool's autopilot: one job per line in the chat selected when it started, the busy flag
    cleared after each send, stopping at a send that did not go.
- `/trigger` always runs on the server (`processMultiCommand` lost its `fromInput` option); the
  `allowLists` moved to `shared/triggers.ts`; `exportRegex`/`importRegex` to
  `src/ts/process/regexFiles.ts`.
- Found by the matrix, the Challenge, and the test adapter, and fixed in the slice: a job a restore or
  import ends makes its tab watch for the replacement (`resourceSync.svelte.ts` `watchForRestore`,
  started by `serverCommands.ts` `reportEnd`; each read bounded to 5 s, two minutes in all); a server
  reply is locked from the job's first chat event (`chatStore.svelte.ts` `hydrateChat`, the holder's
  sequence below every protocol sequence), so it is not transformed empty before its stream.
- Tests (test adapter): the browser runtime tests, `proxyJobWs.test.ts`, and `e2e/luaWasmOrigin.spec.ts`
  deleted; the parity tests import the oracle; `memoryOracle.test.ts` runs the HypaV3 scenarios;
  `e2e/transformGolden.spec.ts`'s second test compares with
  `server/src/tests/fixtures/transform/display-trigger-assets.json`, recorded from the browser path at
  `219dfb51`; the command, transform client, plugin context, tool-call store, baseline, and
  serverCommands harnesses adapted.
- Tools: the Playwright checks lost their flag modes; `checkServerSend.mjs` drives continue and
  abort through the chat screen; `checkServerButton.mjs`, `checkServerTrigger.mjs`, and
  `checkStopDMatrix.mjs` gained a production mode (`--base`, no dev modules; the matrix's restore
  imports an exported archive there); `checkCutoverCredentials.mjs` is the credential capture
  (a sentinel per credential leaf, a server preload that routes the fixed provider origins to a
  local responder and refuses other egress, every browser request, response, and WebSocket frame
  searched); `offline.sh` runs a check with loopback only (`unshare -rn`); every runner fails its
  exit status on a failed check; `checkLuaWasmOrigin.mjs` was removed. The validation record is in
  the phase file ("Cutover validation").
