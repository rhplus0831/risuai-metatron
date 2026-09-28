# Phase 5: Server-Side Processing

Status: not started.

Depends on: Phase 4. Confirm the pipeline-hooks and streaming-persistence Open Decisions first.

## Objective

Run generation on the server as a job that streams events and persists the reply, move Lua and the
data-only hooks to the server, and remove provider credentials from the client. The browser path
stays behind a flag until the server job passes the same send scenarios.

## Required Work

Ordered; each step is a slice or several.

1. **Pure services on the server.** A server CBS evaluator built from `src/ts/cbs.ts`, which already
   receives its host access as callbacks; the DOM-dependent rendering in
   `src/ts/parser/parser.svelte.ts` stays in the client. Lorebook activation
   (`loadLoreBookV3Prompt`), regex scripts (`processScriptFull` without the plugin replacers), Jinja
   templates (`templates/chatTemplate.ts`), template validation, and token counting with the
   tokenizer engines loaded from disk rather than through `tokenizeAccurate`.
2. **Request layer behind a job.** `requestChatData` and the provider modules under
   `src/ts/process/request/` move to the server behind a `POST /api/generations` route that creates
   a job with `accepted`, `chunk`, `done`, and `error` events over the WebSocket, reusing the job map,
   GC, and upgrade handling in `server/src/routes/proxyStreamJobs.ts`; abort is a `DELETE`. The
   client stops calling `fetchNative` and `/proxy2` for providers, and the `secrets` section becomes
   write-only.
3. **Prompt assembly.** The body of `sendChat` (history build, lore placement, memory, the final
   template pass, trimming) runs on the server against the resources from Phases 2 to 4. The client
   sends the character id, chat id, mode, and input.
4. **Memory.** `supaMemory`, `hypav2`, `hypav3`, and `hanuraiMemory` already return data that the
   pipeline persists, so they move with it. Embeddings (`HypaProcesser`, LocalForage `hypaVector`)
   move to a server vector store fed by provider embeddings or transformers in Node.
5. **Lua on the server.** Port the design of the previous attempt's runtime
   (`server/fastify/src/prompt/luaRuntime.ts` in the `risuai-fastify` checkout), not its bindings:
   wasmoon with `functionTimeout` and per-chunk timeouts (the installed wasmoon 1.16.0 exposes
   both), a pool of pre-warmed one-use engines, an aggregate budget per request, an abort checkpoint
   in every host call, an egress validator for `request` (HTTPS only, public DNS-pinned targets,
   rate-limited, size-capped), and `simpleLLM`, `hash`, `similarity`, and `generateImage` through
   server services. The five `alert*` functions fail explicitly, `reloadDisplay` and `reloadChat`
   are no-ops, the image functions return asset ids, and `cbs` uses the server evaluator. That
   runtime covered 50 of the current 51 host functions in `scriptings.ts`.
6. **Hooks.** Per the Open Decision: a server allowlist for trigger effects modeled on
   `displayAllowList` and `requestAllowList` in `triggers.ts`; `editinput`, `editprocess`,
   `editoutput`, and `editRequest` regex and Lua on the server; `input`, `start`, `output`,
   `display`, and button triggers plus plugin chat-output listeners on the client around the job;
   plugin replacers and body interceptors dropped from the server path; provider plugins
   (`pluginmodel:::` models handled by `requestPlugin`) served by a hybrid mode where the job
   returns the assembled prompt and the client runs the provider, or dropped.
7. **Post-generation effects.** `runInlayScreen` image generation on the server; TTS (`sayTTS`)
   and notifications stay on the client; `sendAIprompt` recursion and auto-continue become a bounded
   loop inside the job.

## Safety Contract

The browser pipeline remains selectable until every scenario below passes on the server. The plugin
API does not change. Every effect, Lua function, or hook that behaves differently on the server is
listed here before the browser path is removed:

- `alert*` Lua functions and the `v2ShowAlert`, `v2GetAlertInput`, and `v2GetAlertSelect` effects
  are unavailable in server-side hooks.
- `v2UpdateGUI`, `v2Command`, and other client-only effects are unavailable in server-side hooks.
- `editoutput` applies to completed text, not per chunk.
- Plugin replacers and body interceptors do not run for server-side generation.

## Exit Criteria

- Send, continue, reroll, group, memory, and image-generation scenarios pass through the job with
  the same assembled prompt as the browser path for fixture characters.
- No provider credential appears in client network traffic.
- Lua scripts from shared modules behave the same on the server apart from the recorded exclusions.
- The browser generation path and its proxy usage for providers are removed.

## Validation

Server tests for the job lifecycle (following `server/src/tests/proxyStreamJobs.test.ts`), Lua
runtime tests (port the cases from the previous attempt's `luaRuntime.test.ts`), golden tests
comparing the assembled prompt between the two paths, and `pnpm check`, `pnpm test`,
`pnpm format:check`.
