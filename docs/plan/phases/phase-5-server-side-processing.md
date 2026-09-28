# Phase 5: Server-Side Processing

Status: not started.

Depends on: Phase 4. Implements Decisions 5 and 6 and the Phase 5 parts of Decisions 3 and 4 in
`PLAN.md`.

## Objective

Run generation on the server as a job that streams events and persists the reply, move every Lua
entry point, trigger, and the script transform to the server, reach browser plugins and UI effects
through a job-to-client channel, and remove LLM provider credentials from the client. The browser
path stays behind a flag until the server job passes the same send scenarios.

## Required Work

Ordered; each step is a slice or several.

1. **Pure services on the server.** A server CBS evaluator built from `src/ts/cbs.ts`. Its host
   access is mostly injected callbacks, but it still imports `CurrentTriggerIdStore` and reads it
   directly (`cbs.ts:201`) and reads viewport dimensions directly; move both behind callbacks. The
   DOM-dependent rendering in `src/ts/parser/parser.svelte.ts` stays in the client. Lorebook
   activation (`loadLoreBookV3Prompt`), regex scripts (`processScriptFull` without the plugin
   hooks), Jinja templates (`templates/chatTemplate.ts`), template validation, and token counting
   with the tokenizer engines loaded from disk rather than through `tokenizeAccurate`; start with a
   spike that loads each tokenizer family (`@dqbd/tiktoken`, `@mlc-ai/web-tokenizers`, the
   `public/token/` payloads) under Node. Plugin tokenizers (`providerOptions` `tokenizerFunc` in
   `src/ts/tokenizer.ts`) are replaced by the built-in tokenizer on the server.
2. **Request layer behind a job.** `requestChatData` and the LLM provider modules under
   `src/ts/process/request/` move to the server behind a `POST /api/generations` route that creates
   a job with `accepted`, `chunk`, `done`, and `error` events over the WebSocket, reusing the job map,
   GC, and upgrade handling in `server/src/routes/proxyStreamJobs.ts`; abort is a `DELETE`. The
   request carries the execution context of Decision 5 (character and chat ids, selected preset id,
   effective persona id, mode, raw input); the client settles its pending writes before it sends,
   and the job freezes the context. The job resolves `presetChain` and reports the chosen preset id
   in an event the client applies to its selection. A chat has at most one active job, and a second
   send gets 409. The server rejects edits to the message a job owns until the job's last
   persistence step. A job keeps running and persists after its client disconnects; a reconnecting
   client receives the current message instead of a replay of chunks. LLM provider calls stop using
   `fetchNative` and `/proxy2`, and `llmSecrets` becomes write-only (set, replace, clear, masked
   status). Auxiliary providers (TTS, image generation, DeepL, Google search) keep their client
   calls and the proxy (Decision 6).
3. **Job-to-client channel.** The same socket carries server-to-client notices (events) and
   questions (requests with a timeout). When the client creates a job it lists its registered
   plugin hooks, and the server calls back only for those. Each callback envelope names the job,
   callback, targets, and revisions; the client that created the job answers and other subscribers
   only observe. Server-side changes reach the client before a callback runs, the callback's own
   mutations settle before the job resumes, and callbacks are serialized per client at first. A
   question that times out or finds no connected client fails explicitly; a plugin callback failure
   ends the job with an error.
4. **Prompt assembly.** The body of `sendChat` (history build, lore placement, memory, the final
   template pass, trimming) runs on the server against the resources from Phases 2 to 4, starting
   with the `input` trigger and `editinput` that `DefaultChatScreen.svelte` runs today and the
   `start` trigger.
5. **Memory.** `supaMemory`, `hypav2`, `hypav3`, and `hanuraiMemory` already return data that the
   pipeline persists, so they move with it. Embeddings (`HypaProcesser`, LocalForage `hypaVector`)
   move to a server vector store fed by provider embeddings or transformers in Node.
6. **Lua on the server, only.** Port the design of the previous attempt's runtime
   (`server/fastify/src/prompt/luaRuntime.ts` in the `risuai-fastify` checkout), not its bindings:
   wasmoon with `functionTimeout` (the installed wasmoon 1.16.0 exposes only that option; the
   per-chunk budget is the runtime's own instruction hook over `lua_sethook`), a pool of pre-warmed
   one-use engines, an aggregate budget per request, an abort checkpoint in every host call, an
   egress validator for `request` (HTTPS only, public DNS-pinned targets, rate-limited,
   size-capped), and `simpleLLM`, `hash`, `similarity`, and `generateImage` through server services.
   `alertNormal` and `alertError` are channel notices; `alertInput`, `alertSelect`, and
   `alertConfirm` are channel questions; `reloadDisplay` and `reloadChat` are notices; the image
   functions return asset ids; `cbs` uses the server evaluator; `stopChat` aborts the job. That
   runtime covered 50 of the current 51 host functions in `scriptings.ts`. Buttons
   (`runLuaButtonTrigger`) and manual triggers (`Chat.svelte`, `/trigger` in `command.ts`) run
   through a server command endpoint that uses the same channel. Regex and Lua run behind a
   bounded, terminable worker with input, output, batch, and engine memory limits, and the per-mode
   `lowLevelAccess` restrictions (STRUCTURE S2) stay. When nothing on the client calls Lua, wasmoon
   leaves the client bundle.
7. **Hooks by capability.** The job runs every generation-path hook at its current position: the
   `input`, `start`, `request`, and `output` triggers with their Lua entry points; `editinput` and
   `editoutput` regex, Lua, and plugin handlers; `editprocess` regex and plugin handlers (Lua skips
   `editprocess`); and Lua `editRequest` (there is no `editRequest` regex). Trigger effects that
   need the UI (`v2ShowAlert`, `v2GetAlertInput`, `v2GetAlertSelect`, `v2UpdateGUI`, and the rest
   of the client-only effects in `triggers.ts`) go through the channel; `v2Command` runs
   data-changing commands on the server under the job context and sends only UI effects to the
   client. Plugin `beforeRequest` and `afterRequest` replacers, body and metadata interceptors
   (without credential headers), and `input`, `process`, and `output` script handlers are channel
   callbacks. `chatOutput` listeners are an acknowledged per-reply callback at their current
   position, before auto-continue or `sendAIprompt` recursion. MCP tools split the same way: remote
   MCP servers and internal tools run through server adapters, and plugin and browser-file tools
   (`filesystemclient.ts` needs a browser directory handle) are channel callbacks. Provider plugins
   (`pluginmodel:::` models handled by `requestPlugin`) use a hybrid step: the job sends the
   assembled prompt, the client runs the provider, and the stream returns to the job, which
   persists and runs the output hooks.
8. **Script transform.** A read-only batch endpoint with a mode parameter: `editdisplay` for
   rendering, where `parser.svelte.ts` calls `processScriptFull`, and `editprocess` for the
   HypaV3 modal (`src/lib/Others/HypaV3Modal/utils.ts`) and the plugin parser API. For display the
   server runs Lua `editDisplay`, the `display` trigger, CBS, and regex; the browser keeps both
   `parseAdditionalAssets` passes, inlays, thoughts, style, Markdown, and sanitization. Targets cover
   messages, first greetings, background HTML (`BackgroundDom.svelte`), and translated text
   (`ChatBody.svelte`), each with an owner id and the supplied source; audit every `ParseMarkdown`
   and `processScriptFull` caller first. Each target runs in a fully isolated context: persistent
   setters are disabled, `@@inject` does not write message text, and `@@emo` comes back as a
   presentation effect. Registered plugin `display` handlers run between two server calls, keeping
   today's order (Lua, trigger, plugin, CBS, regex); the first call returns its script-state delta
   and the second applies it. Results are cached whatever the CBS in them, by target id, source text
   hash, transform version, and the revisions of the character, modules, and preset regex, with a
   client LRU on top. The message menu gains a "Re-render" item that bypasses and replaces the
   cache entry. While a message streams, the client shows its raw text through the browser-side
   steps only, and the transform runs once the message completes. The response is JSON; add SSE or
   priority scheduling only for a measured need. A failure shows the unprocessed text with a
   notice. `risuai-fastify`'s `docs/structure/intermediate-display.md` records the previous design.
9. **Post-generation effects.** Checkpoints hold the raw text every three seconds and on abort;
   `editoutput` runs on the completed text and the final write holds its result. The reply persists
   at stream end, after the output trigger, and after inlays (`runInlayScreen` image generation on
   the server), keeping today's two orders: the streaming path runs the output trigger before
   inlays, the non-streaming path runs inlays first. A crash keeps the last committed text and
   replays no external effect. TTS playback and notifications stay on the client; `sendAIprompt`
   recursion and auto-continue become a bounded loop inside the job.

## Safety Contract

The browser pipeline remains selectable until every scenario below passes on the server. The plugin
API does not change shape. Every effect, Lua function, or hook that behaves differently on the
server is listed here before the browser path is removed:

- Channel questions (`alertInput`, `alertSelect`, `alertConfirm`, `v2GetAlertInput`,
  `v2GetAlertSelect`) and plugin callbacks fail explicitly on timeout or with no connected client.
- `chatOutput` listeners do not run for a reply that completes while its client is disconnected.
- Lua globals no longer survive between turns, because engines are one-use.
- Rendering is read-only: Lua `editDisplay` chat-variable writes, which persist today, are
  discarded, and `@@inject` does not change message text in display mode.
- Displayed CBS that depends on time, randomness, the viewport, other messages, or the persona stays
  as first rendered until a keyed revision changes or the user re-renders the message.
- A streaming message shows raw text until it completes.
- `editoutput` applies to completed text, not per chunk; a crash mid-stream leaves raw text.
- Plugin tokenizers are not used for server-side token counting.
- The generating message cannot be edited until its job finishes.

## Exit Criteria

- Send, continue, reroll, group, memory, and image-generation scenarios pass through the job with
  the same assembled prompt as the browser path for fixture characters.
- No LLM provider credential appears in client network traffic. Auxiliary credentials and
  plugin-managed credentials are outside this criterion (Decision 6).
- Lua scripts from shared modules behave the same on the server apart from the recorded exclusions,
  including their buttons, manual triggers, and alerts.
- The client bundle contains no wasmoon, and completed messages render the same HTML as the browser
  path for fixture messages whose CBS is deterministic.
- The browser generation path and its proxy usage for LLM providers are removed.

## Validation

Server tests for the job lifecycle, the channel, the one-job-per-chat rule, and the generation lock
(following `server/src/tests/proxyStreamJobs.test.ts`), Lua runtime tests (port the cases from the
previous attempt's `luaRuntime.test.ts`), golden tests comparing the assembled prompt and the script
transform between the two paths, and `pnpm check`, `pnpm test`, `pnpm format:check`.
