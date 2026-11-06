# MCP: Client Registry, Remote and Internal Clients, RisuAccess, Tool Dispatch

## Scope

- Owns the tab's MCP client registry and tool dispatch, the remote JSON-RPC client with its OAuth and sessions, the
  internal clients (`internal:fs`, `internal:googlesearch`, `internal:graphmem`, `internal:aiaccess`,
  `internal:risuai`), the RisuAccess tools over the tab's host, a plugin's MCP client, remembered tool calls, and how a
  server job's and a tab request's tool calls reach them.
- Paths: `src/ts/process/mcp/*` (including `risuaccess/`), `shared/mcp/*`, `server/src/mcp/*`,
  `src/ts/process/dynamicutils/pdf.ts` (PDF rendering used by the filesystem MCP tool), and
  `src/lib/Playground/PlaygroundMCP.svelte`.
- Not here:
  - The plugin sandbox, the host API, hook contexts, and the plugin reload → [plugins](plugin-sandbox.md). A plugin's
    MCP callbacks run under its hook context ([Hook entry points](plugin-sandbox.md#hook-entry-points)).
  - The provider request loop that calls tools, and the adapters' tool formats → [LLM requests](llm-requests.md).
  - A server job's channel, its callbacks, and owner presence →
    [server generation](server-generation.md#generation-channels).

## Files

### MCP registry

- `src/ts/process/mcp/mcp.ts`: the tab's client registry and tool dispatch, and the remembered calls. Look up
  `initializeMCPs` (identifier rules), `getTools`/`callTool` (over `getMCPTools`/`callMCPTool`), `readyTabClient`,
  `importMCPModule`, `encodeToolCall`/`decodeToolCall`, `MCPs`, `callOnlyMCPs`.
- `src/lib/Playground/PlaygroundMCP.svelte`: the MCP Playground page; look up `refresh` and its `callMCPTool` handler.

### Remote MCP client

- `src/ts/process/mcp/mcplib.ts` `MCPClient`: remote JSON-RPC over streamable HTTP or SSE, OAuth, sessions, pagination.
  Look up `oauthLogin` (refresh), `destroy` and `closed` (retirement), `reset`, `waitFor`, `connectSSE`,
  `connectLegacy`, `request`.
- `shared/mcp/sse.ts`: `SseFramer`, `parseSseEvent`, the event framing of both clients.
- `server/src/mcp/client.ts` `McpClient`: the server's port; its header lists what differs from the tab's.

### Local MCP clients

- `src/ts/process/mcp/internalmcp.ts` `MCPClientLike`: the base of internal and plugin clients, and the
  `callToolForChat(chatRef, name, args, scope?)` contract of the chat clients (`internal:graphmem`, `internal:risuai`,
  `internal:aiaccess`).
- `src/ts/process/mcp/graphmem.ts` `GraphMemClient`, `src/ts/process/mcp/aiaccess.ts` `AIAccessClient`: the tab's hosts
  of `shared/mcp/graphmem.ts` and `shared/mcp/aiaccess.ts`, whose tools the server shares.
- `src/ts/process/mcp/filesystemclient.ts` `FileSystemClient` (`internal:fs`; PDFs through
  `src/ts/process/dynamicutils/pdf.ts`), `src/ts/process/mcp/googlesearchclient.ts` `GoogleSearchClient`
  (`internal:googlesearch`, `initializeCredentials`), `src/ts/process/mcp/dice.ts` `DiceClient`.
- `src/ts/process/mcp/pluginmcp.ts`: `CustomPluginMCPClient`, `registerMCPModule`, `unregisterMCPModule`,
  `registeredCustomPluginMCPs`. The plugin API's `registerMCP` (`src/ts/plugins/apiV3/v3.svelte.ts`) wraps the callbacks
  per instance with `withContext` and installs the unload cleanup.

### RisuAccess

- `shared/mcp/risuaccess/`: the tools (`CharacterHandler`, `ChatHandler`, `ModuleHandler`, `createRisuAccess`) over a
  `RisuAccessHost` (`shared/mcp/risuaccess/host.ts`), so a server job runs the same tools on its store. Every write goes
  through `writeConfirmed`: consent (`promptAccess`), then the [re-resolve](#invariants) and a type recheck.
- `src/ts/process/mcp/risuaccess/`: the tab's side. `tabRisuAccessHostFor(chatRef)` (which character and history a
  request's call names), `tabRisuAccessHost` (no request: the Playground), `RisuAccessClient`.

### Server job tools

- `server/src/mcp/jobTools.ts` `createJobTools`: a job's tool set and where each identifier runs; `createJobToolState`.
- `server/src/mcp/internal.ts` `createInternalMcps`: `internal:aiaccess`, `internal:risuai`, `internal:graphmem` over
  the job's data. `server/src/mcp/dice.ts` `callDiceTool`. `server/src/mcp/registry.ts` `McpRegistry`: the process's
  remote clients.
- The services those tools run on (the `createJobTools` call, the job chat's `getChatVar`/`setChatVar`, a request's tool
  calls) are built in `server/src/lua/bindings.ts` ([scripts and triggers](scripts-triggers.md)).

## Flows

### Tool dispatch

A server job does not use the tab's registry (`createJobTools` has the rules; channel in
[server generation](server-generation.md#generation-channels)):

- Remote servers and `internal:dice` run on the server.
- `internal:fs`, `internal:googlesearch`, and a `plugin:` MCP registered when the job was created run in the job's tab
  through the `mcpList` and `mcpTool` callbacks (`src/ts/network/jobChannel.ts`).
- `internal:aiaccess`, `internal:risuai`, and `internal:graphmem` run on the server over the job's data (`shared/mcp/`).

The tab's own requests (`/api/llm/request`) run their tool loops on the server too (`server/src/llm`):

- A tool call becomes an `mcpTool` callback, which the tab answers with `callTool` for the request's chat (its explicit
  chat, else the chat selected when it began; `src/ts/process/request/transport.ts`). That chat picks the module MCP
  servers, and `internal:graphmem` and `internal:risuai` act on it whatever is selected when the callback arrives.
- A remembered call (`rememberToolUsage`) is stored in the tab by `encodeToolCall` from the request's `toolRecord`
  event; the tab sends the records a prompt's markers name with the request (`collectToolRecords`).

### Callbacks in the tab

- A server job's `mcpList` and `mcpTool` callbacks (`src/ts/network/jobChannel.ts`) take `internal:fs` and
  `internal:googlesearch` from `readyTabClient` and a `plugin:` client from its current `registeredCustomPluginMCPs`
  registration, and call them directly; a tab request's tool calls go through `transport.ts` and `callTool`. The plugin
  host passes the hook context with them ([Hook entry points](plugin-sandbox.md#hook-entry-points)), and a plugin client
  invokes its wrapped callback with it.
- The owner-presence contract a tab-side tool answers inside (pings, the silent socket, the absence bound) is
  [generation channels](server-generation.md#generation-channels)'; what a hook may assume about its tab is
  [Job owner presence](plugin-sandbox.md#job-owner-presence).

## State

- The tab's registries `MCPs` and `callOnlyMCPs`, built by `initializeMCPs`; `syncMCPs` resolves each `plugin:` client
  from the current registration on every call.
- Remembered tool calls live in `chat.toolCalls` of the request's chat, written with `mergeChatMeta`
  ([MCP registry](#mcp-registry)).
- Remote servers' refresh tokens are the `authRefreshes` collection, which the tab and a server job both write
  ([Issues](#issues)); the Google search key and engine id are `googleSearchCredentials`.

## Coupling

- MCP consumers: `request.ts` and the provider adapters, `PlaygroundMCP.svelte`, `IrisModal.svelte`/`iris.ts`.
- The plugin host: its `registerMCP` (`src/ts/plugins/apiV3/v3.svelte.ts`) wraps a plugin's callbacks per instance with
  `withContext`, and a plugin's unload unregisters its clients ([Load and reset](plugin-sandbox.md#load-and-reset)).
- `server/src/mcp/` runs a job's tools on the server; the job's channel and callbacks are
  [server generation](server-generation.md)'s. `shared/mcp/` holds the tools both sides run, and `shared/mcp/sse.ts`
  frames events for both clients.

## Invariants

- Tool names are resolved globally, first match wins. Adapters usually keep only text content.
- A RisuAccess write tool goes through a mutation module, as [a plugin's write](plugin-sandbox.md#invariants) does; a
  refused value answers an `Error:` text and changes nothing.
- A RisuAccess write tool re-resolves its record by the id captured before the consent prompt, and builds its patch
  synchronously after that lookup.
- A request's tool call reaches the chat clients with the request's chat: the graph, the implicit character's history,
  and nested LLM requests use that chat. AI access also passes the request's captured prompt and model preset scope;
  null stays chatless. Only implicit targeting without a chat argument (the Playground) uses the current selection, and
  a tab request without a chat sends its tool calls with the chat selected when it began (`requestServer` in
  `src/ts/process/request/transport.ts`); module discovery keeps its own fallback.

## Recipes

- Add an internal MCP server: subclass `MCPClientLike` (`getToolList`, `callTool`), add a switch case in
  `mcp.ts:initializeMCPs`, and optionally add a choice to `importMCPModule`. If its tools act on a chat, add
  `callToolForChat(chatRef, name, args, scope?)` and address that chat by id (it is pinned and loaded only while a
  request's events run); `callTool` stays the no-request path.
- Change the tool loop: `mcp.ts` `getTools`/`callTool` plus every server adapter (`server/src/llm/openAI/requests.ts`,
  `openAI/responses.ts`, `google.ts`, `anthropic.ts`) and the callback leg (`server/src/llm/requests.ts`,
  `src/ts/process/request/transport.ts`).

## Tests

- Focused: `pnpm --silent test:agent src/ts/process/mcp src/ts/process/request/tests/transport.test.ts` for the tab;
  `pnpm --silent test:agent server/src/tests/{mcp,mcpInternal,mcpSse}.test.ts` for the server. Provider adapter tool
  loops: [LLM requests](llm-requests.md).
- `slow`: none. `e2e`: `e2e/lazyChats.spec.ts` (RisuAccess history).
- `mcplib.test.ts`: a fake `fetchNative`. `mcpLeases.test.ts`: a fake `MCPClient` with gated calls.
- `server/src/tests/mcp.test.ts`: injected `fetch`. `mcpInternal.test.ts`: the job tool set over a real store.
- Not tested: filesystem MCP tools and PDF rendering; cancellation while the job channel's dynamic MCP module import is
  pending.

## Known Hazards

### Issues

- `filesystemclient.ts` advertises `fs_watch_directory` but has no dispatch for it.
- A rotated refresh token is a whole-collection `authRefreshes` edit from the tab (and the server job's write to the
  same collection is not hydrated into the tab): another writer of the collection can make the tab's write conflict and
  be discarded, and the next refresh then sends a token the server may have spent (an unsuccessful refresh answer goes
  on to a full login; a rejected refresh fetch rejects the login).
- The server MCP client fences a rotated-token write against the job and client signals. If the remote server rotates
  the old refresh token before the answer arrives, an abort or client close in that window leaves the old token stored
  while the new one is lost; the next refresh may fail and require a full login. `server/src/tests/mcp.test.ts` pins the
  cancellation behavior, not the remote server's token state.
- The tab's `MCPClient` has no request timeout, and `request.ts` `getTools` does not propagate an abort signal to its
  tool listing. A stream that stays open without answering can still keep that caller waiting.

### Limitations

- A server job's remote MCP requests leave from the server host, so a browser-only URL or session is unavailable and the
  module URL reaches addresses visible to that host, including loopback and private networks. See
  [STRUCTURE platform/network invariant](../../STRUCTURE.md#platform-and-network). Decision: STRUCTURE P2.
- `internal:fs` for a server job asks for the directory inside a callback, after the send's click: the browser may
  refuse the picker without a user gesture. Decision: owner-tab work in
  [`jobTools.ts`](../../server/src/mcp/jobTools.ts).
- A remote server's OAuth page opens through an `openURL` notice, which a popup blocker may stop. Decision: owner-tab
  work in [`jobTools.ts`](../../server/src/mcp/jobTools.ts).

### Gotchas

- Streamable HTTP, both remote MCP clients: a 404 with a session or a 401 with a token resets the session and retries
  that request once without the old session or token. If refused, that call gets an error; the next call handshakes. The
  tab may retry again if concurrent work restored a session or token. In `util/playwright/checkMcpFixes.mjs`, the mock
  refuses the unauthenticated retry. The check logs that reply and asserts the next call succeeds after refresh.
- Legacy SSE: a POST answered above 299 settles its pending answer with that status as the RPC error code.
- A server MCP OAuth code question is tied to the MCP client's closing signal, while the caller's abort only rejects
  that caller. It can stay open until the client closes, the job channel ends, or it times out; a queued question has no
  timeout until dispatch.
