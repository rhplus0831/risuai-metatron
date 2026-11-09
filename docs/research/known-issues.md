# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

## Contents

- [assets](#assets) (1)
- [backup-sync-hub](#backup-sync-hub) (1)
- [cbs-rendering](#cbs-rendering) (11)
- [chat-pipeline](#chat-pipeline) (8)
- [diagnostics](#diagnostics) (1)
- [draft-recovery](#draft-recovery) (5)
- [live-updates](#live-updates) (2)
- [llm-requests](#llm-requests) (4)
- [mcp](#mcp) (1)
- [memory](#memory) (6)
- [persistence](#persistence) (2)
- [plugin-sandbox](#plugin-sandbox) (3)
- [resource-sync](#resource-sync) (2)
- [scripts-triggers](#scripts-triggers) (4)
- [self-host-server](#self-host-server) (4)
- [server-generation](#server-generation) (1)
- [server-resources](#server-resources) (1)

## assets

Guide: [Assets: Sources, Client, Queues, Batch Codec](../structure/assets.md#known-hazards).

- Direct URLs already handed out are not re-rendered when the page loses its controller or capability. Without a signing
  worker they load from the browser HTTP cache or fail with 401; only new source calls use the fallback.

## backup-sync-hub

Guide: [Backups, Realm Hub](../structure/backup-sync-hub.md#known-hazards).

- The RisuRealm terms gate is client-side only: `GET /hub-proxy/*` (unauthenticated) and `POST /api/import/realm` do not
  check `ui.realmTermsAccepted`.

## cbs-rendering

Guide: [CBS Template Language and Message Rendering](../structure/cbs-rendering.md#known-hazards).

- A permanent display failure is not remembered: when another target of the same row fails transiently (a legacy
  rendered translation's paragraph beside an oversized original), that row's retry round rerenders it whole, so the
  permanent target is requested and its toast shown again every round. A fix would remember terminal outcomes per
  target.
- A refused request of several targets (a sum over the continuation's text limit, or a JSON body over its cap from
  escaped sources that fit the source-byte chunking) stays transient and is batched the same way each round. A fix would
  split a refused request.
- A request of the old source still in flight when its message is edited can fail after the edited source renders. The
  failure is recorded against the source shown then, so its retry round rerenders the edited row once (typed form input
  included). The capture carries no shown source to fence it.
- The transform's invalidation guarantee does not cover inlay records or file existence read by Lua
  `getCharacterImage`/`getPersonaImage`; those inputs are not keyed.
- The tab's plugin handlers are opaque: their output is cached under the server key and handler-set identity, refreshed
  by a chat change, a viewport change or Re-render, but not by plugin-private state or records outside the key. They can
  still read `lastInteraction` through `getCharacter()`.
- A `{{random}}` or clock row may change when it remounts after its chat changed. After eviction or Re-render elsewhere,
  a random/clock/plugin row can be refilled with different text under the same key, and `same` can still confirm the
  tab's older text: the key names inputs, not output.
- Resize and rotation do not re-render rows; the new viewport takes effect on the next remount.
- A [permanent display failure](../structure/cbs-rendering.md#display-transform-failures) is not retried when only the stored data shrinks: a
  transcript or character trimmed under the limit renders the row on its next mount or a Re-render, not on its own.
- A script whose output size varies (`{{random}}`, a clock) can fail the head limit once and fit on the next run; it is
  still marked permanent.
- The server checks scope limits on the scope loaded for that request, so a target whose request also named a large
  non-member source character fails permanently beside it; a chat's own members are always loaded, so its rows normally
  load the same scope.
- A screenshot taken while a provisional display awaits a replacing answer can capture the cached text:
  `ChatBody.svelte`'s `whenRendered` waits for current parses and auto-translation, not the transform confirmation.

## chat-pipeline

Guide: [Chat Pipeline: Send → Prompt → Request → Reply](../structure/chat-pipeline.md#known-hazards).

- A reroll's restore cannot see another tab's job that holds no lock yet and was not met at this tab's create: the
  restored replies land while that job runs, like any other edit.
- A boot resume that discovers its chat but cannot load it shows Stop during the load retries, until the follow ends as
  lost.
- `disable_ui_prompt` lore decorators fill `disabledUIPrompts`, which nothing consumes.
- `renderChatTemplate` calls Jinja's `Template.render` synchronously with no work or time limit; a costly custom
  template occupies its caller's thread.
- The screen's per-chat reroll history (multi-reply tails) is in memory only.
- Composer recovery depends on the browser journal. Chrome aborts IndexedDB writes begun in `pagehide` on unload, so a
  reload, close, or navigation within 500 ms of the last edit loses it.
- In-page send recovery restores the serialized send text without its translation draft; journal recovery restores the
  pre-consumption composer. Neither restores a send whose job ended `done` (`ok`) after a script removed its user
  message.
- Lore keys keep the inherited grammar: every key is split on commas before the `/pattern/flags` parse, so `/a{1,2}/`
  becomes two malformed keys; the last slash closes a pattern, and a bare or unclosed slash, an invalid flag, or a
  malformed later entry ends that key search instead of being skipped. Kept for parity.

## diagnostics

Guide: [Request History and Diagnostics](../structure/diagnostics.md#known-hazards).

- Daily event appends are unsynced, so a power loss can lose recent events; whole-file state, report, and share writes
  flush their staged files before rename.

## draft-recovery

Guide: [Draft Recovery: Journal, Composer Rows, Recovery Drafts](../structure/draft-recovery.md#known-hazards).

- Apply removes a draft once its save succeeds even when it skipped ops: the skipped content is named only in Apply's
  result, not kept. A draft of edits answered `missing` therefore keeps their text only until Apply; Export keeps it.
- The conservative `sent`/`resend` marks of a cycle can outlive an early exit, leaving a dispatched mark for a later
  batch that never went: harmless for an update, but recovery treats such a create as a draft rather than creating it.
- A stale `pending` row can name ops that landed under a merged or reanchored id. If its before value matches again (or
  an appended id has since been deleted), a later recovery can re-apply those ops. Coalescing and deliberate withdrawal
  also mean a remembered id does not prove that every older form of its intent was applied.
- A metadata before captured from an unloaded summary may differ from raw storage (for example, omitted `pinned:false`),
  so recovery may conservatively draft it.
- A composer draft typed during a send with that send's text carries its message id (`retryIdFor`). The page's own
  settlement keeps it as a plain draft, but a reload before that settlement cannot tell it from the send's text placed
  back after a failure: `composerDrafts.svelte.ts` `restore` finds the message landed and deletes the draft, so the
  retyped text is lost. Keeping it would bring already-sent text back after every uncertain end that landed
  ([JR1](../manual-audit/archive/cross-plan-2026-10-29.md#jr1--a-landed-send-deletes-an-identical-drafts-journal-row),
  remaining case).

## live-updates

Guide: [Live Updates: Feed Connection, Record and Chat Updates, Feed Locks, Restore Halt](../structure/live-updates.md#known-hazards).

- A tab can still edit a generating reply before the job's first write's frame arrives (`hello` cannot list a message
  before `begin`), or, with an older server, after an adopted newer read released the locks, until the next write
  (`CHECKPOINT_INTERVAL_MS` while streaming; longer while a job waits). The edit is
  [dropped](../structure/resource-sync.md#generating-refusals), the mirror shows it until the whole read, and with no retry block a
  later edit can land over the finished reply.
- The same window decides when an observer refuses a permanent character delete or different-id replace
  (`isCharacterGenerating`). A fix would announce the job's chat reservation in the feed and read lock lists, locking
  the chat's tail.

## llm-requests

Guide: [LLM Requests, Model Catalogue, Tokenizers](../structure/llm-requests.md#known-hazards).

- The `/proxy2` media, memory, and count rows and the Google/Anthropic/OpenAI discovery lists keep flat default keys;
  they do not accept a profile. A model-profile follow-up (Remaining Follow-Ups in the
  [archive](../archived-plan/README.md)).
- NanoGPT's `providers.nanogptSubscriptionState` and `nanogptUseSubscriptionEndpoint` remain global: two profiles on
  different accounts share subscription state and endpoint selection. A model-profile follow-up (Remaining Follow-Ups in
  the [archive](../archived-plan/README.md)).
- A profile whose `modelId` names a catalogue id that is later renamed or removed keeps it: unless the id matches a
  dynamic template, the profile resolves as an as-is OpenAI-compatible model until the user picks another model.
- Multimodal counts remain approximate: Claude/Gemini images use the GPT-4o fallback; video/audio/signature entries use
  a flat 85 tokens.

## mcp

Guide: [MCP: Client Registry, Remote and Internal Clients, RisuAccess, Tool Dispatch](../structure/mcp.md#known-hazards).

- A rotated refresh token is a whole-collection `authRefreshes` edit from the tab (and the server job's write to the
  same collection is not hydrated into the tab): another writer of the collection can make the tab's write conflict and
  be discarded, and the next refresh then sends a token the server may have spent (an unsuccessful refresh answer goes
  on to a full login; a rejected refresh fetch rejects the login).

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- The modal and lore-draft fence knows only this tab's sends and the jobs it follows or sees locked: another tab's modal
  (no job ownership on the change feed), the HypaV2 chunk editor (`AlertComp.svelte` `setHypaV2ChunkText`), and a
  plugin's whole-chat result (`applyChatResult`) still write a whole memory value, and one that lands after the job's
  write replaces the job's summaries (`meta set` replaces the field).
- The job's own write keeps a change saved before it. A memory task's writes fence the modal of every connected tab (its
  `memoryTask` frames), but a plugin's whole-chat result that lands after a task's write still replaces its summaries.
- An edit right after a refused final job hydration can still use a stale modal or lore copy: the job fence drops before
  the idle refresh catches up, and a whole-field write can replace the job's data (`chat-store.md`, job hydration and
  idle refresh).
- Experimental's rate limiter is per execution: no provider-wide allowance across runs or chats.
- No API embedding batch (`HypaProcesser.getEmbeds`, `HypaProcessorV2`) counts tokens before sending, so long
  inputs can exceed provider limits; contextual batches likewise count inputs and chunks, not tokens.
- The custom embedding URL is fetched directly by the server with no local-target restriction.

## persistence

Guide: [Persistence: Database, Records, Mutation Stores](../structure/persistence.md#known-hazards).

- The browser-local import has no cross-tab lock: a change another tab lands between `removeIfUnchanged`'s comparison
  and its deletion is lost.
- A character trashed or deleted on the server after the remote repair's read and before its write, with no order change
  between, can be appended. Its id leaves only once this tab holds the trash or deletion and a later `checkCharOrder`
  runs (arrival alone does not run the repair).

## plugin-sandbox

Guide: [Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions](../structure/plugin-sandbox.md#known-hazards).

- Consented capabilities reach further than their names suggest (never reviewed): `mainDom` lets a plugin listen on
  `document` through `getRootDocument` and forwards keys (except from the terminal notice's opening until reload), so a
  plugin could observe typing in the password or credential prompts; `mainDom` also allows document-wide queries and
  mutation; `nativeFetch` lets a plugin choose its headers; the RPC dispatcher in `factory.ts` looks callables up
  without an allowlist.
- A plugin event listener lives until the wrapper that registered it removes it by id or plugins reload: removing
  its element from the page keeps it (and the element).
- A plugin's whole-chat setter (`setChatToIndex`, and a character setter's `chats`) diffs the plugin's copy against the
  chat at call time (`captureChatBaseline` right before `applyChatResult`), not as the plugin read it. So a change
  another writer made after the plugin's read is overwritten: a changed message field or chat field is set back to the
  copy's value (a `CHAT_META_MERGE_KEYS` map only in the entries that differ), and a message added meanwhile is removed.

## resource-sync

Guide: [Resource Sync: Boot, Save Adapter, Conflicts, Transport](../structure/resource-sync.md#known-hazards).

- A page restored from the back-forward cache may still wait for an unload answer; `flushResources` gives up after 20 s.
- A save's echo arriving before its acknowledgement schedules a cycle 50 ms later (`noteRemoteChanges`), so continuous
  typing can save more often than the debounce. [Measurements](../audit/projection-bindings-2026-10-04.md) no longer
  show extra saves; coalescing would bound the 50 ms echo cycle.

## scripts-triggers

Guide: [Regex Scripts, Triggers, Lua Scripting](../structure/scripts-triggers.md#known-hazards).

- Trigger and command runs are not atomic: each trigger effect and each mutating command is its own job write (a command
  pipeline rereads the chat before each command), so a later refused effect leaves the earlier writes committed, and a
  command's wait can expose an intermediate revision; only the final `applyTriggerChat` diff is one write.
- Trigger character effects write one patch per effect; a long run that writes a whole `globalLore` array from its
  starting copy overwrites lore edits made after that copy was taken.
- A regex script with `ableFlag` set whose action metadata leaves the flags empty runs with the legacy `g` flag.
  `server/src/tests/regex.test.ts` pins it as a quirk.
- `v2Calculate` substitutes chat variables and calls the calculator directly, outside the CBS evaluator's cooperative
  work/time budget; expensive expressions can hold the server thread.

## self-host-server

Guide: [Self-Host Server (Hono on Node), Docker](../structure/self-host-server.md#known-hazards).

- `/api/asset/*` verification is in memory and stat-based; it starts empty after restart and cannot detect an outside
  same-size edit that restores the full stat.
- The thumbnail cache has no byte cap.
- JWT validation does not check issuer, audience, `typ`, or `iat`, and a token without `exp` does not expire.
- `/hub-proxy` is unauthenticated (its forwarded request headers are an allowlist since 2026-11-10).

## server-generation

Guide: [Server generation: jobs, channels, transforms, LLM and token routes](../structure/server-generation.md#known-hazards).

- Server CBS evaluation runs on the main thread under cooperative limits, with no hard deadline or heap bound. Other
  prompt work (Jinja rendering, tokenizer calls after model load, non-worker lore matching) also runs there.

## server-resources

Guide: [Server resources](../structure/server-resources.md#known-hazards).

- `normalizeCharacterOrder` validates only a folder's `data` members (non-strings are dropped) and keeps a folder whose
  `id`, `name`, or `color` is missing or malformed, since older saves hold such folders; the boot repair tolerates them.
