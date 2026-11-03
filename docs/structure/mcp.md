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

`mcp/mcp.ts` is the client registry and tool dispatch.

- `initializeMCPs`: a `stdio:` entry with `url` is treated as remote; one with `command`/`args` is rejected.
- `readyTabClient(identifier)`: the `internal:fs` or `internal:googlesearch` client, one instance for this registry and
  for a server job's callbacks, handshaken (concurrent first uses share one handshake, so one directory picker). The
  registry's cleanup drops its own reference only.
- `encodeToolCall`/`decodeToolCall`: remembered calls, in `chat.toolCalls` of the request's chat, written with
  `mergeChatMeta` so two devices adding calls keep each other's; the server uses the same field for a job's request. A
  call without a chat, or whose chat is gone when it is remembered, is not remembered (logged once).
- A browser's LocalForage store `mcp-tool-calls` (an older version's, chatless calls included) is never read, so a
  marker remembered there does not resolve (no migration).

### Remote MCP client

`mcp/mcplib.ts` `MCPClient`: remote JSON-RPC over streamable HTTP or SSE, OAuth, sessions, pagination. Events are framed
by `shared/mcp/sse.ts`, as in the server's client. A session id is taken from an `initialize` answer in JSON or as an
event stream.

- Refresh token: a stored one is used when the token endpoint answers 200 with a token, and a new `refresh_token` in
  that answer replaces the stored one (`registerRefreshToken`); anything else goes on to a full login.
- The authorization endpoint a server names must be `http:` or `https:` before it is opened.
- Retirement: `destroy()` (the registry dropped the client) starts no request, handshake, login step, or stream reader
  afterwards, and an answer that completes later (a session id, a list, a tool result, a token) is refused with
  `The MCP client was closed`. The session reset after a 404 or 401 (`reset`) keeps the client usable.
- Not fenced: other requests already sent when retired are not aborted (a refresh may still spend the stored token), and
  the custom transport (`customTransport`, no caller in the app).
- Pending SSE answers (`waitFor`, `pending`): the answer, its stream's EOF or failure, or `reset` settles them and
  removes their document listeners. An unanswered EOF on a request's own response stream returns JSON-RPC error -32000
  (`The MCP stream ended without an answer`), a read failure its message, and a reset or EOF on the current legacy GET
  `The MCP session ended`; `destroy` uses reset and the closed-client guard rejects the settled answer.
- `connectSSE` cancels and releases every reader and removes its `sses` entry in `finally`; an answered streamable
  request aborts its stream even if the server keeps it open. A ping reply's POST does not block the reader from
  observing EOF or failure.
- The legacy GET has an AbortController, its endpoint waiter also settles, and only the current legacy stream may reset
  the session on ending. The handshake refuses an ended session. A legacy waiter also settles while its POST is still
  out, and a failed POST removes its listener.

### Local MCP clients

- `mcp/internalmcp.ts` `MCPClientLike`: the base class. It accepts the optional trailing context, but dispatchers pass
  it only to plugin clients.
- Chat clients (`internal:graphmem`, `internal:risuai`, `internal:aiaccess`) have
  `callToolForChat(chatRef, name, args, scope?)`: `callMCPTool` calls it whenever it was given a chat argument (`null`
  included) and `callTool(name, args)` only when it was not (`undefined`).
- `googlesearchclient.ts`: `initializeCredentials` refuses a missing, cancelled, or blank API key or engine id before
  anything is written, and trims accepted values before `googleSearchCredentials` is saved.
- `graphmem.ts`, `aiaccess.ts`: the tab's hosts of `shared/mcp/`, whose tools and logic the server shares. For a request
  the graph is the chat variable `graphmem_graph` of its chat by id (the preset default from the request's captured
  preset when its context is for that chat, else the chat's display preset), and no chat or one that is not loaded
  answers an `Error:` text.
- `mcp/pluginmcp.ts`: `CustomPluginMCPClient` hands the context directly to its stored callbacks with `invokeHook`;
  `registerMCP` wraps those callbacks per instance with `withContext` and installs unload cleanup guarded by client
  identity. Unregister also drops that client from the tab's `MCPs`/`callOnlyMCPs`; `syncMCPs` resolves each `plugin:`
  client from the current registration on every call.

### RisuAccess

- `mcp/risuaccess/`: the handlers are `shared/mcp/risuaccess/` over a `RisuAccessHost`, so a server job runs the same
  tools on its store (`server/src/mcp/internal.ts`). `tabRisuAccessHost` serves `callTool` (no request: the Playground).
- A request's call (`callToolForChat`) runs `createRisuAccess` over `tabRisuAccessHostFor(chatRef)`, built per call: an
  empty character id names the request chat's character (`null`: none), that character's history is the request's chat,
  and another character's history is its selected chat in this tab, as a server job resolves them. Failures stay the
  tab's: no selected chat reads as an empty history.
- Every write goes through `writeConfirmed`: `promptAccess` confirmation, then the [re-resolve](#invariants) (never by
  name) and a type recheck (a group, an MCP module). A `MutationValidationError` answers an `Error:` text.

## Flows

### Tool dispatch

A server job does not use the tab's registry (`server/src/mcp/`, `server-generation.md`):

- Remote servers and `internal:dice` run on the server.
- `internal:fs`, `internal:googlesearch`, and a `plugin:` MCP registered when the job was created run in the job's tab
  through the `mcpList` and `mcpTool` callbacks (`src/ts/network/jobChannel.ts`).
- `internal:aiaccess`, `internal:risuai`, and `internal:graphmem` run on the server over the job's data (`shared/mcp/`).

The tab's own requests (`/api/llm/request`) run their tool loops on the server too (`server/src/llm/`):

- A tool call becomes an `mcpTool` callback, which the tab answers with `callTool` for the request's chat (its explicit
  chat, else the chat selected when it began). That chat picks the module MCP servers, and `internal:graphmem` and
  `internal:risuai` act on it whatever is selected when the callback arrives.
- A remembered call (`rememberToolUsage`) is stored in the tab by `encodeToolCall` from the request's `toolRecord`
  event; the tab sends the records a prompt's markers name with the request.

### Callbacks in the tab

- A server job's `mcpList` and `mcpTool` callbacks and a tab request's tool calls reach the registry through the job
  channel and `transport.ts`; the plugin host passes the hook context with them
  ([Hook entry points](plugin-sandbox.md#hook-entry-points)), and a plugin client invokes its wrapped callback with it.
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
- The plugin host: `pluginmcp.ts` wraps a plugin's callbacks per instance with `withContext`, and a plugin's unload
  unregisters its clients ([Load and reset](plugin-sandbox.md#load-and-reset)).
- `server/src/mcp/` runs a job's tools on the server; the job's channel and callbacks are
  [server generation](server-generation.md)'s. `shared/mcp/` holds the tools both sides run, and `shared/mcp/sse.ts`
  frames events for both clients.

## Invariants

- Tool names are resolved globally, first match wins. Adapters usually keep only text content.
- An MCP write tool goes through a mutation module, as [a plugin's write](plugin-sandbox.md#invariants) does; a refused
  value answers an `Error:` text and changes nothing.
- An MCP write tool re-resolves its record by the id captured before the consent prompt, and builds its patch
  synchronously after that lookup.
- A request's tool call reaches the chat clients with the request's chat: the graph, the implicit character's history,
  and nested LLM requests use that chat. AI access also passes the request's captured prompt and model preset scope;
  null stays chatless. Only implicit targeting without a chat argument (the Playground) uses the selection; module
  discovery keeps its own fallback.

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
  `pnpm --silent test:agent server/src/tests/mcp{,Internal,Sse}.test.ts` for the server. Provider adapter tool loops:
  [LLM requests](llm-requests.md).
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
  be discarded, and the next refresh then sends a token the server may have spent (a full login follows).
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

- Remote MCP, in both clients (`mcplib.ts` and the server's port): a 404 with a session or a 401 with a token resets the
  session and repeats the request once without them (the call after that handshakes again).
- A server MCP OAuth code question is tied to the MCP client's closing signal, while the caller's abort only rejects
  that caller. It can stay open until the client closes, the job channel ends, or it times out; a queued question has no
  timeout until dispatch.
