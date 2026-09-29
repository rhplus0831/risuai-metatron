# Slice: MCP On The Server

Status: planned (drafted 2026-09-30, refined after review, not started).

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
