# Slice: MCP On The Server

Status: 12a implemented (2026-10-03); 12b (`aiaccess`, `risuaccess`, `graphmem` on the server) not started.

Phase: [Phase 5](../../phase-5-server-side-processing.md), the MCP part of step 7 (remote MCP
servers and internal tools through server adapters; plugin and browser-file tools as channel
callbacks); PLAN.md Decision 5.

Depends on: `request-layer-and-llm-secrets` (the `callTool` seam in the adapters),
`post-generation-and-plugin-callbacks` (the persisted tool calls), `job-channel` (the `mcpTool`
callback); `memory-on-server` for `graphmem`.

## Scope

Allowed files: `server/src/mcp/**` (new: the Node `MCPClient` port of
`src/ts/process/mcp/mcplib.ts`, the registry port of `mcp.ts`, the internal `dice`, `aiaccess`,
`risuaccess`, `graphmem` adapters, the callback client for `internal:fs`, `internal:googlesearch`,
and `plugin:` tools), `server/src/llm/**` (wiring `callTool`), `src/ts/network/jobChannel.ts`
(the `mcpTool` callback), `src/ts/process/mcp/mcp.ts` only for the browser assembly path's
continued use. Tests belong to the review step.

Identifiers (verified 2026-09-30): `initializeMCPs` (`mcp.ts:19-142`: `internal:fs`
`FileSystemClient` needs `window.showDirectoryPicker` (`filesystemclient.ts:4-37`);
`internal:risuai` `RisuAccessClient` uses `alertConfirm` (`risuaccess/characters.ts:12`,
`modules.ts:16`) and the client data; `internal:aiaccess` uses `requestChatData`
(`aiaccess.ts:54-74`); `internal:googlesearch` uses `DBState`, `alertInput`, `fetchNative`
(`googlesearchclient.ts:33-84`, `185-239`; its key stays in `secrets`, Decision 6);
`internal:graphmem` uses `HypaProcesser`; `internal:dice` is pure; `plugin:` through
`registeredCustomPluginMCPs` (`pluginmcp.ts:34-56`); remote through `MCPClient` (`mcplib.ts`),
which uses `document` custom events for SSE (193-224, 331-352, 404-424, 542-558) and `openURL`
(`window.open`) plus `alertInput` for OAuth (616-704); `stdio:` with `command` is rejected).
`getTools`/`callTool` (187-195). OAuth refresh state: `authRefreshes` (`mcp.ts:103-110`), a
client-readable collection after Phase 3. Tool-loop call sites: `anthropic.ts:1122`,
`google.ts:859, 1182`, `openAI/requests.ts:809, 1264`, `responses.ts:514`.

Stopping condition: a remote MCP transport feature (`mcplib.ts`) that Node's `fetch` cannot
reproduce; recorded and that server stays a callback.

## Assumptions

- The request layer's adapters take `callTool` by injection; the channel provides `mcpTool`
  callbacks and `alertInput` questions; tool calls persist with the chat.

## Proposed decisions

- Split (proposed): remote servers through a Node `MCPClient` (JSON-RPC and SSE over `fetch`
  streams, no `document` events; OAuth's `alertInput` becomes a channel question and `openURL` a
  notice; `authRefreshes` read and written server-side as a mutation reported by a `resource`
  event), `internal:dice`, `internal:aiaccess` (the server request layer, `aux`), `internal:risuai`
  (server data with `alertConfirm` as a question), `internal:graphmem` (server embeddings) on the
  server; `internal:fs`, `internal:googlesearch`, and `plugin:` tools as `mcpTool` callbacks. A
  job lists the client's plugin tools in its hook list.
- A tool call inside a job counts toward the job's budget; a tool that fails or is not
  `answered` returns an error result to the model, as today's `callTool` errors do.

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step adds
`server/src/tests/mcp.test.ts` for the Node client against `startUpstream` (JSON-RPC, SSE,
pagination, an OAuth prompt through a fake channel) and the tool loop with a fake tool; a
`plugin:` tool round trip through the callback. Manual: with the flag on, a send with a remote
MCP tool and one with a plugin tool.

## Residual risk

Remote MCP sessions live in the server process; a restart drops them (they are re-established on
the next call, as the client does after a reload).

## 12a: what landed

As `docs/structure/self-host-server.md` (`server/src/mcp/`), `plugins-mcp.md`, `global-api.md`, and
`persistence.md` describe it. The slice is split as slice 11 was: 12a is the transport, the
registry, the job's tool set, `internal:dice`, the tab callbacks, OAuth, and the budget; 12b moves
`internal:aiaccess`, `internal:risuai`, and `internal:graphmem`. Until 12b a module naming one of
the three offers a job no tools (a warning), and `internal:risuai` is not call-only for a job.

Files beyond the drafted list: `server/src/jobs/{channel,runSetup}.ts`, `server/src/lua/bindings.ts`,
`server/src/app.ts`, `shared/jobs.ts`, `src/ts/process/mcp/mcplib.ts` (the refresh fix, the
authorization URL check), `src/ts/storage/collectionStore.svelte.ts` (`addAuthRefresh`).

Decisions that differ from the proposal above:

- The tab's tool descriptors are not in the hook list: the job asks for them when its modules name
  the MCP (`mcpList`), so a plugin MCP no module names is never called, and the two internal tab
  kinds, whose handshake prompts the user, have a place.
- `authRefreshes` is written with the job's `write` and not reported by a `resource` event (the
  amendment). Replacing by URL removes every entry of that URL, on both paths.
- A tool's own failure is a text result at the job's boundary, for every adapter; the fatal
  outcomes end the job (`implementation-plan.md`, "a tool error returns to the model").
- The budget (64) counts every tool call a model asks for, in the adapters, because an unknown
  tool name never reaches `callTool` and the adapters' loops have no bound.
- The Node client settles every pending answer, bounds what it reads, and shares one handshake;
  the registry closes idle clients (15 minutes) and every client on a new database epoch.
- No stopping condition was met: Node's `fetch` reproduces both transports. A server that depends
  on the browser's own session (a userscript, cookies) or on the browser's `localhost` is not
  reachable from the server and is recorded, not routed through a callback.

Challenge (two rounds; nine findings and two left partly fixed after the first round, all fixed): the legacy session stream had no deadline to connect; a
session that ended during its handshake was taken as initialized; a client closed during the OAuth
question left its callers waiting; a remote tool list that failed after the handshake was kept as
an empty list; a callback cancelled while the tab loaded its MCP module still started the picker;
the browser registry's cleanup reset the shared Google client; the tool set's cache key could
collide; stream readers kept their locks; the event bound counted characters, not bytes.

Suspected defects kept as they are in both clients, for Stop D: `\r\n` event separators are not
understood; a session id sent with an event-stream `initialize` answer is not taken; a refresh
answer's new refresh token is not stored.

Live check (a fresh server, a mock provider, a mock MCP server; 20 checks): a streamable-HTTP
server's paginated tools offered and called (a JSON answer, an event-stream answer, an RPC error as
text) with one handshake and the session id, and the next job reusing the session; the legacy SSE
transport; a 401 answered by the stored refresh token; `internal:dice` with its bound, without
streaming, beside an unreachable server; a plugin MCP through `mcpList` and `mcpTool` (a throwing
tool as an error result, an unregistered plugin MCP offering nothing); a remembered call stored in
`chat.toolCalls` and decoded by the next send; the budget ending the job at the 65th call. The full
OAuth login is not driven live (it calls the public account helper); it is left to tests with an
injected `fetch`.

Review: no problem found; the reviewer added `server/src/tests/mcp.test.ts` and cases in
`llmRequests.test.ts`, `collectionStore.test.ts`, and `mcpWriters.test.ts`. Not pinned: the tool
loops of the Responses, Google, and Anthropic adapters (the budget line is the same at each loop
head; the OpenAI-compatible adapter is driven, buffered and streaming), a cancellation during the
tab's module import (no harness for the tab's dispatcher), and a tab that reconnects inside the
attach grace. Residual: the OAuth code question is withdrawn when the client closes, not when its
caller alone is aborted (it then ends with the job's channel or its timeout, as every question).
