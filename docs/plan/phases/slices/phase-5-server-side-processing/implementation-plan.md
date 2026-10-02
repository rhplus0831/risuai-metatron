# Phase 5 implementation plan (Opus, final)

Written 2026-10-01 at `ce43f2b9` (Phase 4 closed). The steps that produced it:

1. A Luna re-baseline of every slice: sixteen read-only workers at `xhigh`, one per slice plus
   one for the planning notes.
2. A plan review by GPT-6-Astra (P1 to P17).
3. An evaluation of the draft and that review by Claude Fable (its additions F-a to F-e).

Both reviews are kept verbatim in [`plan-review.md`](plan-review.md). The slice files in this
folder stay canonical for content; this file records how they are executed and the amendments to
them. Where this file and a slice disagree, this file wins until the slice is updated in the same
change as its implementation.

## Goal

Implement [`phase-5-server-side-processing.md`](../../phase-5-server-side-processing.md):

- generation runs on the server as a job that streams events and persists the reply;
- every Lua entry point, the trigger runtime, and the script transform run on the server;
- browser plugins and UI effects are reached through a job-to-client channel;
- LLM provider credentials leave the client.

The browser assembly path stays selectable behind a client-local flag until the server job passes
the same scenarios, then the cutover removes it. From slice 7a on, the browser path holds no LLM
key either: its provider calls go through the server.

## Baseline

The slices were drafted at `577c43ae`, before Phases 3 and 4 were built. The re-baseline found the
slice designs still valid in outline. No server job, worker, request-layer, or transform code
exists yet; `llmSecrets` is still `clientReadable`. Line numbers drifted everywhere, and each
slice re-derives its Identifiers paragraph when it is implemented. The substantive drift:

- **Credential locations differ from the drafts** (`shared/sections.ts`, the normalizers):
  - `supaMemoryKey` is in `llmSecrets`. The memory modules read it on the client and send it
    directly: `/v1/completions` in `supaMemory.ts:213` and `hypav2.ts:41`, `/v1/embeddings` in
    `hypamemory.ts:124` and `hypamemoryv2.ts:440`.
  - Three browser consumers of the same processors stay after cutover: `PlaygroundEmbedding.svelte`,
    `files/multisend.ts`, and `embedding/addinfo.ts`.
  - `voyageApiKey` and `hypaCustomSettings` are in `secrets`. `hypaMemoryKey` was dropped.
  - `vertexRegion` is in `providers`, not `llmSecrets`.
  - `customModels[].key` is still inside the `customModels` collection.
  - `authRefreshes` is its own client-readable collection that holds `refreshToken` and
    `clientSecret`.
  - The client owners of the plaintext values are `llmSecrets.svelte.ts` (the preset secret map),
    the synchronous `db.proxyKey` accessor in `forwarding.svelte.ts`, the boot assembly, and the
    `resourceSync` projection. Other direct writers: `WelcomeRisu.svelte`,
    `PlaygroundEmbedding.svelte`, `BotSettings.svelte`, and the Vertex token refresh in
    `request/google.ts`.
- **Backups.** `/api/backups/export` copies the whole `resources.sqlite` with `store.backupTo`
  (`backups.ts:110-154`), so `llmSecrets` leaves the server in a downloaded archive whatever the
  read projection does.
- **The proxy.** `/proxy2` takes a caller-controlled URL and headers and follows redirects
  (`proxy.ts:141-173`). Its auth also accepts the stored password itself (`auth.ts:100-109`).
- **No flush before a provider call.** Nothing in `src/ts/process/` calls `flushResources`. The
  browser request layer reads the live mirror at call time (`request.ts:464-510`).
- **Phase 4 names, as shipped:**
  - `currentContext(owner)`, not `currentContext(pluginName)`;
  - `replaceCharacterFields(char)`, not `(chaId, fields)`;
  - no `readSetting` (reads go through the mirror and forwarding);
  - `PluginCallContext.personaId` is carried, but nothing reads it.
  - `v2SetPersonaDesc` still writes `selectedPersonaForWrite(DBState.db)`, and
    `triggers.test.ts` pins that.
  - The parser in `parseRisuChat` gets `chatRef` but no preset or persona
    (`v3.svelte.ts:1412-1420`). `stableDiff.ts:32-43` and `hypav3.ts:1480-1488` call
    `requestChatData` without a context.
- **The display trigger inside `processScriptFull`** uses `getCurrentCharacter()` and
  `getCurrentChat()` instead of the caller's `chatRef`, and it skips groups.
- **`v2Command`** falls back to the selected chat when no `chatTarget` is present.
- **The upgrade handling.** `proxyStreamJobs.ts` exposes no `handleUpgrade`. `attachWebSocket`
  installs its own `upgrade` listener, and that listener destroys every socket whose path is not
  its own, so a second listener cannot sit beside it.
- **The maintenance drain.** `snapshots.track` only makes `stop` wait. `withMaintenance` drains
  the storage gate's admitted operations only (`snapshots.ts:205-235`). A tracked job in a long
  provider call delays exit past the eight-second grace (`main.ts:49-66`) and is not cancelled by
  a restore.
- **Revision tokens** are `<epoch>:<seq>:<revision>` and ordered (`resourceStore.ts:161`), but the
  client treats them as opaque.
- **The job write path has no token or epoch.** `PreparedOp` carries only the generation id,
  `seq`, and `final`. `applyChanges` takes neither an epoch nor a job token, and `assertEpoch`
  is a separate call. Record writes carry a `baseRevision`.
- **`ChatConflict` and the client `ResourceConflictError` carry no `reason`.**
- **No chat hydration.** `applyToMirror` has no chat branch. The only whole-chat reload is
  `recoverFromConflict`, which records a discard and shows a notice.
- **The hook list cannot travel as functions.** The POST body carries names and frozen provider
  descriptors. Plugin MCP tools are `registeredCustomPluginMCPs` instances, not a `pluginHooks`
  set.
- **The browser request path needs callbacks.**
  - `requestChatData` collects browser tool clients (`request.ts:232`).
  - The adapters call `callTool` and `encodeToolCall` inline (for example
    `openAI/requests.ts:808-817`).
  - `LLMFormat.Plugin` dispatches to the browser `requestPlugin` (`request.ts:533-534`).
- **Nested callbacks.** `runLLMModel({ allowPlugins: true })` from inside a callback can need a
  `provider` callback while its parent is outstanding (`v3.svelte.ts:1822-1851`).
- **CBS is not ready for `shared/`:**
  - `calcString` still imports `chatVar.svelte` (planning-notes drift 24 is wrong);
  - the parser's group path calls `findCharacterbyId` from the DOM-heavy `util.ts`;
  - `templateCheck.ts` and `chatTemplate.ts` import client types through the `src` alias.
- **User regexes run synchronously on user data** in lore activation (`lorebook.svelte.ts:171-193`)
  and in five native trigger sites (`triggers.ts:803-817`, `1047-1053`, `1565`, `1785`,
  `2019-2020`). Native trigger loops only yield (`591-595`) and have no bound.
- **Tokenizers:**
  - plain Node rejects the `tikJS` JSON imports without an import attribute;
  - `o200k_base` from `@dqbd/tiktoken` matches semantically, not byte for byte;
  - the client keeps one mutable tokenizer, not one per family;
  - the Google count sends `?key=`, not a bearer header;
  - a custom Llama3 model counts with `cl100k_base`;
  - there are no checked-in browser golden counts.
- **The post-generation order differs per path.**
  - Streaming (`index.svelte.ts:2105-2140`): checkpoint, rerolls, output trigger, inlays,
    listeners, TTS.
  - Non-streaming (`2178-2247`): inlays, append, TTS, output trigger, listeners.
  - Auto-continue returns early (`2251-2276`), and `igp` runs after it (`2279-2298`).
- **Tool calls.** `Chat` has no `toolCalls` field, and adding it means a shared type, the
  normalizer, and tests. `internal:risuai` is call-only.
- **Doc drift:** `self-host-server.md:28` still lists a `root` kind.
- **The strict-mode counts are historical.** Each port slice re-counts at its start.
- **Pre-existing defects confirmed in source:**
  - `igp` appends the response object to the reply as text (`index.svelte.ts:2283-2298`);
  - `decodeToolCall` slices with `slice(len, 0)`, so remembered tool calls never decode
    (`mcp.ts:279`);
  - the MCP OAuth refresh reads the token only when the status is not 200
    (`mcplib.ts:621-637`);
  - lore regex matching overwrites `arg.keys[0]`, and it skips a key with empty flags, so `/abc/`
    never matches (`lorebook.svelte.ts:171-193`).
- **Reported but not confirmed:**
  - the `HypaProcesser.similaritySearch` comparator;
  - the keep/don't-activate decorator flags leaking between lore entries;
  - `testText` keyed without the model;
  - the `@@repeat_back` null dereference.

## Order and stops

```
step 0 ─→ 1 → 2 [A] → baseline capture → 3 → 4 → 5 → 6 → 7a ─(parity gate)→ 7b [B]
        → 8a → 8b → 9 [C] → 10 → 11 → 12 → 13 [D] → 14 [E]
```

- **Step 0** applies the phase-file edits with your answers to the owner questions. Docs only,
  committed with this plan.
- **Stop A** follows the two spikes. Both spikes also run inside the built Docker image. Their
  results decide whether the runtime and tokenizer designs hold, and both have stopping
  conditions that are your decision.
- **The baseline capture** comes right after Stop A, before slice 3 changes any browser code. In
  it, Fable records golden fixtures from the current browser path:
  - DevTool preview prompts for fixture characters (plain, lore at every position, a Jinja
    template, `presetChain`, a group);
  - `ParseMarkdown` HTML for fixture messages with deterministic CBS;
  - token counts for fixed strings (Unicode, special tokens, one long input) and the fixture
    prompts;
  - the current behavior of the four confirmed defects.

  They go under `server/src/tests/fixtures/` with the commit id and settings. Approved deltas
  (defect fixes, Safety Contract changes) are separate reviewed expected-delta files.

- **The parity gate** between 7a and 7b is not a user stop. The flag-off matrix must be green
  with recorded provider bodies, and it is reported in 7a's slice report. A failure is a review
  problem and stops anyway.
- **Stop B** follows the `llmSecrets` flip. Provider calls go through the server, and the
  credential fields are masked in the settings UI. Items carried to it for owner decisions:
  - the baseline capture's suspected defects (`server/src/tests/fixtures/baseline/README.md`):
    client Lua fetching `glue.wasm` from `unpkg.com` at run time, group chats wrapping the user's
    messages as "Unknown Character's Message" and a group's `useCharacterLore` leaving out
    member lore, `DefaultChatScreen.svelte` throwing when a group is selected, and unpadded
    `{{date}}`/`{{time}}`;
  - lore regex keys containing a comma (`/a{1,2}/`): keys still split on every comma before the
    `/pattern/flags` parse, and a malformed key ends its query (`lore-templates-and-tokens.md`).
  - inherited lore behaviors the slice 4 review pinned (`lore-templates-and-tokens.md`, "Tests"):
    the keep and don't-activate "seen" flags are function-wide, so after one keep entry every
    later active also writes `__internal_ka_`; a bound persona's embedded module resolves only if
    a module with its id is in `db.modules`.
- **Stop B decisions** (owner, 2026-10-02):
  - provider URLs stay fetched from the server; under Docker a host provider is configured as
    `host.docker.internal` or the host's address (README Docker note). No keyless client
    exception for local URLs;
  - the `strongBan` cache, OobaLegacy's string chunks, and English server error strings are not
    worked on in this plan (systems rarely used now); the behavior stays as recorded;
  - group chats will be removed later: their suspected defects (the "Unknown Character's
    Message" wrapper, member lore, `DefaultChatScreen.svelte` throwing) are not fixed here;
  - `{{date}}` and `{{time}}` keep the original unpadded output for compatibility;
  - client Lua loads `glue.wasm` from the app's own origin instead of `unpkg.com` (done as a
    follow-up before slice 8a);
  - the lore regex keys with a comma and the inherited lore behaviors are noted for later and
    stay as they are.
- **Stop C** follows prompt assembly: the first server send behind the flag.
- **Stop D** is the parity gate before the cutover. Every slice is in, the flag-on matrix
  passes, and both golden tests are green.
- **Stop E** is the cutover and closeout.
- Between stops I report and continue. A review problem or a slice stopping condition is always a
  stop.

Slice 7 is split:

- **7a** ports the request layer and makes the server transport unconditional, with the browser
  bridges.
- **7b** makes `llmSecrets` write-only and routes the remaining consumers.

The README's dependency graph gains three edges:

- 2 → 4: lore regexes run behind the worker;
- the bridges → 7a;
- 10 → 13: complete transform parity needs dynamic assets.

## Workflow per slice

Approved by the owner on 2026-10-01 (question 1): the Phase 3 and 4 exception, for the same
reason: slices 3, 4, 5, 7a, 7b, 8b, 9, and 14 invalidate tests on purpose.

- **Tests.** When a slice invalidates tests on purpose, a Fable test-adapter adapts exactly the
  tests I list, each with a reason. Assertion changes and harness changes are listed separately.
  Then the Fable reviewer reviews the diff and the adaptations and writes the new tests. I edit no
  tests.
  - The golden fixtures define expected values, so Fable captures and owns them (the baseline
    capture above).
  - The capture scripts are Playwright tools and may be mine. Fable reviews how they control
    randomness, time, the viewport, the mock provider, and settings before accepting a fixture.
- **Reviews.** Every slice gets an Astra challenge and a Fable review.
  - Astra runs one session per segment between stops; segment B gets two (3 to 4, then 5 to
    7b). Phase 4's single session reached 13M tokens over eight slices.
  - Each handoff lists the commits, accepted deviations, Fable's results, open risks, and fixture
    provenance.
  - Astra's testing advice (`plan-review.md`, P16) goes verbatim to each slice's Fable reviewer,
    with Fable's sort of it into necessary and not necessary. The reviewer judges again.
- **Commits.** One commit per slice, after its challenge and review.
- **Checks.** Per slice: `pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`, and
  `pnpm test:e2e`. Manual checks run through Playwright scripts in the scratchpad against a fresh
  server in a temp directory.
- **Docker.** The phase changes the server and what it reads from the image (`dist/token/`,
  `dist/lua/json.lua`, the worker entry, wasmoon on the server).
  - Stop A builds the image and runs the spikes' `loadAll` and the worker smoke inside it.
  - Slice 10 runs its local-model backend check in the image.
  - From Stop B on, each stop runs the smoke (open, send, reload) on a fresh volume.
  - The cutover runs the full matrix in Docker.
- **Strict mode.** Each port slice re-counts with a reproducible command: a scratch tsconfig over
  the moved files. The criterion is zero errors introduced in `server/` and `shared/`. A type fix
  that would change behavior is a stopping condition; an approved defect fix is not.

## Step 0: phase-file edits and owner questions

The phase file gets the drift edits of [`planning-notes.md`](planning-notes.md) items 1 to 23 and
25, updated to `ce43f2b9`, with these corrections from the re-baseline:

- **Item 2:** the image host functions are `getCharacterImageMain`/`getPersonaImageMain`, and the
  multimodal entries are `LLMMain` and `axLLMMain`.
- **Item 5:** the consumer list adds the memory, trigger, scripting, plugin, and local-model
  callers, the five NanoGPT account calls, and the memory processors' direct OpenAI calls.
- **Item 8:** both phase-file places change to the client callback: step 6's "through server
  services" and step 9's "`runInlayScreen` on the server".
- **Item 20:** `chat.toolCalls` is a new chat field this phase adds. It does not exist today.
- **Item 24 is reversed:** `calcString` takes its accessors as parameters in
  `cbs-and-regex-services`.
- **The credential locations** as listed in the Baseline, in steps 2 and 5.
- **Step 9:** the per-path stage tables (slice 11 below).
- **The Safety Contract additions** from the planning notes, plus:
  - the server display trigger runs on the target's character and chat, groups included (today
    it uses the selection and skips groups);
  - `v2SetPersonaDesc` writes the frozen effective persona;
  - rendering: the server stages are read-only, and plugin display handlers keep today's
    capabilities;
  - callbacks nest at most two deep; deeper is refused with an error;
  - a native trigger run stops after 100,000 effects;
  - `header::` values in `additionalParams` and custom-model `params` stay readable user
    configuration, outside the credential criterion (if question 3 is answered so);
  - a downloaded archive carries no LLM credentials (if question 12 is answered so);
  - the pre-existing defects this phase fixes (question 10).
- **Docs:** `self-host-server.md:28`'s stale `root` kind is corrected in the same commit.

Owner questions, with my recommendation (Astra and Fable agree on all unless noted). The owner
accepted all thirteen recommendations on 2026-10-01:

1. **Workflow.** The Phase 3 and 4 exception (test-adapter, a commit per slice, the stops
   above), with an Astra session per segment and the baseline capture. Recommended: **accept**.
2. **Auxiliary readers of `openAIKey`, `google.accessToken`, and `supaMemoryKey`** once they are
   write-only. That covers OpenAI TTS, DALL-E, Whisper, Imagen, the memory summaries, and
   embeddings on the browser path.
   - (a) `/proxy2` injects the server-side key for a typed operation. A `risu-aux-op` header
     names one row of a server table (`openai-tts`, `openai-dalle`, `openai-whisper`,
     `openai-embeddings`, `openai-completions`, `google-imagen`). Each row fixes the HTTPS origin,
     the method, the path pattern, the secret, and header or query injection. Injection requires
     the JWT, refuses redirects, and redacts its errors.
   - (b) A second copy of the key in readable `secrets`.
   - (c) Dedicated server endpoints per call.

   Recommended: **(a)**. It keeps Decision 6's "auxiliary calls keep the proxy" with one key, and
   no browser consumer holds a key. The per-character `oaiTTSConfig.apiKey` stays client-side, as
   Decision 6 says.

3. **Custom-model credentials.**
   - (a) Move `customModels[].key` to `llmSecrets.customModels.<id>.key`, deleted with the model.
     Free-form `header::` values in `additionalParams` and custom-model `params` stay readable
     user configuration, recorded as outside the credential criterion like plugin-managed
     credentials.
   - (b) Move both. This needs references namespaced per owning configuration that keep the
     ordered overrides and `{{none}}` (`request/shared.ts:47-130`).

   Recommended: **(a)** (Fable's narrower fix; Astra recommended (b)). The header values are
   free-form text, and a placeholder scheme for them can follow later.

4. **Runtime modules in `shared/`** (Decision 2 extension): the CBS registry and evaluator, the
   regex engine, lore activation, the Jinja templates, and the model catalogue. Recommended:
   **accept**. Parity is proven by the baseline fixtures, not by shared code.
5. **Local models on the server.** WebLLM summarization (HypaV3) cannot run in Node, and
   Transformers.js is measured in slice 10 inside the image. Recommended: **an explicit
   "unsupported on the server" error** for each capability that fails, instead of a client
   callback. The flag-off path keeps them until cutover, and the cutover record lists what is
   lost.
6. **A `command` job** (buttons, manual triggers) takes the chat's one job slot, holds no message
   lock, and emits `accepted` and `done`. Recommended: **yes**.
7. **`/multisend` inside a trigger is refused on the server.** Recommended: **yes**.
8. **The Lua `request` rate.** Today `> 5` lets six through per tab. Recommended: **30 per
   minute per server**, with 10 s and 2 MB caps. The counter is shared across tabs, so this is a
   product choice, not parity.
9. **Chat variables in the transform cache key.** Recommended: **yes**, through the
   `globalChatVariables` revision and the chat's `scriptstate` hash, so `{{getvar}}` panels stay
   live. Every message re-renders after any variable change.
10. **The four confirmed defects** (`igp`, `decodeToolCall`, the OAuth refresh, the lore regex
    key and flags). Recommended: **fix each in the slice that moves its code, on both paths**,
    with the baseline capture as the before evidence. Each is recorded as a behavior change.
    - The unconfirmed ones are ported as is with a fixture. A fixture that proves a defect is
      reported at the next stop for your decision.
11. **`proxyStreamJobs` after cutover.** Recommended: **keep the server route one phase**, with
    an explicit removal line in Phase 6.
12. **Downloaded backups.**
    - (a) A browser-downloaded archive omits the `llmSecrets` record (deleted from the staged
      copy). Snapshots on the server keep it. Restoring an archive means entering the keys
      again.
    - (b) Keep plaintext keys in the archive, as a recorded exception to Decision 6.

    Recommended: **(a)**.

13. **MCP tools on the browser path between 7a and 12.**
    - (a) A callback leg on the `aux` stream: the SSE response may emit
      `callback { id, name: "mcpTool" }`, and the client answers with
      `POST /api/llm/request/:id/answer`. Slice 12 keeps it for the plugin, filesystem, and
      Google search tools.
    - (b) A recorded gap: MCP tools are unavailable on the browser path until slice 12.

    Recommended: **(a)**. Slice 12 needs the leg anyway.

## Amendments to the slices

### Slice 1 (`tokenizer-node-spike`)

- Load the `@dqbd/tiktoken` encoders through `createRequire` (or an import attribute), not a
  bare JSON import.
- Record `o200k_base` as semantically equal (the same `pat_str`, special tokens, and ranks).
- Add `gemma/tokenizer.json` to the inventory as unused. Drop the "1 to 17 MiB" claim.
- The server holds one instance per family. Counts are deterministic, so this matches the
  client's single replaced cache.
- The golden pins both Llama3 paths: the custom model falls to `cl100k_base`
  (`tokenizer.ts:210-239`), while the reverse-proxy `customTokenizer=llama3` uses the llama web
  tokenizer (`130-131`).
- The Google count uses `?key=` (not bearer). It moves server-side in slice 4.
- The per-family encode also runs in the image (Stop A). The test file is `tokens.test.ts`
  throughout.

### Slice 2 (`script-worker-spike`)

- The task protocol carries the execution identity (`characterId`, `chatId`, `presetId`,
  `personaId`) even in the fake host. The bindings in 8a fill it.
- The `request` rate counter lives on the main thread (per server), not per worker.
- A terminated worker cancels its outstanding host calls by request id.
- `json.lua` resolves from `public/lua/` or `dist/lua/` by the slice 1 path rule.
- The pool is created and disposed by `createServerContext` (`app.ts`), which joins the allowed
  files.
- A task spawned by a worker's host call goes back to the same worker, never to the pool queue.
  The worker's event loop is free while its Lua thread awaits. The spike proves this with two
  suspended Lua runs that both invoke lore.
- The regex boundary also takes small single-regex tasks: the op, pattern, flags, and input under
  the 1,000 ms deadline. Lore activation and the five native trigger sites use them.
- `runRegex`'s effects are an ordered list (`emotion`, `inject { messageId, text }`,
  `repeatBack`, the move and order flags), applied in script order as `scripts.ts:233-267` does
  today. Slice 3 implements it.

### Baseline capture (after Stop A)

As described under Order and stops. Fable writes it. I may write the capture scripts.

### Slice 3 (`cbs-and-regex-services`)

- `calcString` and `executeRPNCalculation` take the variable accessors as parameters.
- The parser's group path takes a `findCharacter` host callback instead of importing `util.ts`.
- `processScriptFull` keeps its seven-argument signature (`chatRef`, `pluginContext`) and its
  `{ data, emoChanged }` result for client callers. The engine returns the ordered effects, and
  the client wrapper applies them as today.
- `bestMatchCache` (dynamic assets) stays client-side, and the dynamic-asset step stays in the
  client wrapper until slice 10.
- The `@@repeat_back` null dereference is ported as is, with a fixture.

### Slice 4 (`lore-templates-and-tokens`)

- Only `loadLoreBookV3Prompt` and its matching helpers move. `importLoreBook`, the editors, and
  export stay in `lorebook.svelte.ts`.
- The lore regexes run through the worker's single-regex tasks on the server.
- `LoreHost.getModuleLorebooks` keeps the full module resolution: global, chat, character, the
  bound persona's embedded module, and `moduleIntergration`. The server host reads module
  contents, not the client's id-keyed cache.
- `username` comes from the effective persona (the bound persona wins), not `DBState.db.username`.
  This is a behavior change for bound personas, recorded.
- `templateCheck` and `chatTemplate` take shared types (`shared/openai.ts`, a `TemplateInput`)
  instead of the client `Database`.
- The lore regex fix (question 10). The last `/` separates the pattern from the flags, and empty
  flags are allowed, a recorded change (`/abc/` matches).
- The settings read model is per section: `providers.loreBookToken`,
  `memoryTranslateMedia.loreBookDepth`, the selected preset's template fields, and
  `llmSecrets.google` for the count.

### Slice 5 (`generation-jobs`)

- `proxyStreamJobs.ts` joins the allowed files. It exports `handleUpgrade(req, socket, head)`,
  which returns `false` for a path it does not own and does not destroy the socket.
  `attachWebSocket` keeps its name and installs the one dispatcher.
- Job writes go through one `writeAsJob({ epoch, jobToken }, changes)` in `server/src/jobs/`.
  - `applyChanges` accepts the epoch and token and checks both inside the same synchronous
    transaction as the lock.
  - The token never leaves the process.
  - A record write that conflicts on `baseRevision` (a job patch racing a client edit) re-reads
    and reapplies the patch once. A second conflict fails the stage with `error`. 8a, 8b, and 12
    use this rule.
- The lifecycle:
  - `beginShutdown()` and `withMaintenance` abort every live job's signal;
  - the abort path persists the text so far and ends the job with `error`, and cancels its
    questions and worker tasks;
  - `dispose` aborts the jobs, then disposes the pool, then `snapshots.stop()`, then closes.
- Every job event carries the epoch (`chunk`, `done`, notices, and `resource`). The client
  dispatcher drops an event from another epoch.
- `parseRevisionToken` and `compareRevision` go in `shared/resources.ts`. `applyHydration`
  compares `(seq, revision)` within the epoch, so an older incarnation is rejected. The client
  still treats tokens as opaque everywhere else.
- Chat hydration is a `resource { kind: "chats", id, revision, data }` event with the chat as the
  server reads it. It is applied through `recoverFromConflict`'s path without the discard and the
  notice, and keeps the generating message's lock state. It is sent before each callback and with
  `done`.
- `llmSecrets` and `authRefreshes` are never sent as `resource` events.
- Reconnect: the `jobId` is saved beside `clientId` in `sessionStorage`. On load,
  `GET /api/generations/:id` attaches. The `chatBusy` 409 stays as the second way in.
- `ResourceConflictError` carries the 409 body's `reason`.
- The `hooks` field is the descriptor list `job-channel` defines (names and frozen provider
  descriptors). In this slice it is accepted and ignored.
- The lock covers job-owned messages only. On the flag-off path, client generations keep the
  Phase 2 fence, so `chatStore.test.ts:831-900` stays and the lock gets new cases. Only
  `resourcesBatch.test.ts` (the 409 body) is adapted (F-d).
- `src/lang/en.ts` leaves the scope (`chatGenerating` exists).

### Slice 6 (`job-channel`)

- Question kinds add `alertSelectChar` and `alertModuleSelect`. Notices add `alertWait` and
  `alertClear`.
- `emotion` and `reloadChat` notices carry ids (`chaId`, `chatId`), not an index.
  `notification` and `tts` carry the target character id (`sayTTS` needs it).
- Nested callbacks:
  - an `aux` request made inside a callback carries the parent callback id, and its callbacks
    run as children of that parent;
  - the client keeps a stack of outstanding callbacks per client, at most two deep;
  - a deeper request is refused with an explicit error, recorded.
- The failure rules:
  - a hook exception follows the hook's policy (slice 11);
  - a barrier failure (discarded keys or a rejected flush) ends the job whatever the hook's
    policy;
  - a timeout or a disconnect ends the job;
  - a tool error returns to the model.

  `flushResources` can also reject for quarantine, a halted server, a transport error, or retry
  exhaustion; each is a barrier failure.

- A plugin write that the client refuses (a locked message) warns and records nothing
  (`v3.svelte.ts:1439-1445`), so the barrier cannot see it. Recorded.
- `mcpTool` callbacks carry the MCP identifier.
- The index-based plugin getters (`getCharacterFromIndex`, `getChatFromIndex`, and the setters)
  keep resolving through the tab inside a callback. Recorded as a residual.

### Slice 7a (`request-layer-and-llm-secrets`, transport)

- The port and the unconditional `POST /api/llm/request`, as the slice says.
- The client transport awaits `flushResources()` before the POST, so an edit just made reaches
  the provider (F-a).
- The request body carries `pluginContext` as plain ids (`chatRef`, `presetId`, `personaId`).
  The server reads the provider settings from the resources by those ids: custom-model params,
  `additionalParams`, and the model selection.
- The browser bridges:
  - a local branch in the client transport: `LLMFormat.Plugin` and `LLMFormat.WebLLM` run their
    client adapters as today. Slice 11's hybrid step replaces the plugin branch for jobs, and
    slice 10 decides WebLLM.
  - the request carries serializable tool descriptors (name, description, input schema);
  - tool execution goes through the callback leg of question 13;
  - `bodyIntercepter` registrations are not applied to calls without a job, recorded (the only
    built-in use is Gemini usage metadata).
- The browser hosts gain their context: `parseRisuChat`'s parser gets the preset and persona,
  and `stableDiff.ts` gets `chatRef` and `pluginContext`. HypaV3's call gets it in slice 10.
- The Vertex token refresh moves server-side, along with its writer (`google.ts`).
- The adapters' `callTool`, `encodeToolCall`, and `decodeToolCall` become injected seams.
- The proxy op table of question 2 lands here for the memory shapes and the other auxiliary
  readers. Browser calls switch to it in 7b.
- Parity gate before 7b: the flag-off matrix with a recording upstream, taken before masking:
  - OpenAI-compatible, Anthropic, and Google (query key) providers;
  - a plugin provider and WebLLM through the local branch;
  - retries and fallback models, and both previews;
  - a no-chat `aux` call (the translator);
  - the memory completion and embedding proxy ops;
  - an edit followed at once by a send;
  - one tool round trip.

### Slice 7b (`request-layer-and-llm-secrets`, write-only)

- The masked projection on every read path: `/api/resources`, `/api/resources/read`, list and
  get. The write guard covers PUT and batch.
- The archive policy of question 12 applies to `/api/backups/export`.
- The client owners change together:
  - `llmSecrets.svelte.ts` holds masked status;
  - `forwarding.svelte.ts`'s `db.proxyKey` becomes a masked read and a write through the secret
    route;
  - the boot assembly and the `resourceSync` projection stop mirroring plaintext.
- Secret writes are save obligations. `db.proxyKey` and the preset copy, delete, and import
  secret calls register their in-flight write in a small pending set that `flushResources`
  awaits.
  - The preset routes stay two operations, resource then secret.
  - A partial failure leaves an orphan entry or a preset without its key, and entering the key
    again fixes it (recorded).
- The credential writers outside `src/lib/Setting/**` join the scope: `WelcomeRisu.svelte`,
  `PlaygroundEmbedding.svelte`, and the onboarding keys.
- `proxy.ts` and the six auxiliary consumers join the scope. Every `llmSecrets` field flips here,
  `supaMemoryKey` included.
- `customModels[].key` moves by question 3. `vertexRegion` stays in `providers`.
- The settings report (`SettingsExportButtons.svelte`) keeps its filters and drops the
  `llmSecrets` paths explicitly.
- The cutover's credential capture excludes the `/api/llm-secrets/*` PUT bodies. Entering a key
  necessarily sends it.
- Affected tests listed for the adapter: `llmSecrets.test.ts`, `resourceSyncSections.test.ts`,
  `kinds.test.ts`, `normalizeCollections.test.ts`, and the request tests that move to the server.

### Slice 8a (`lua-bindings-and-buttons`)

- `src/ts/storage/clientFlags.ts` is introduced here, its first user. There are two flags,
  `risu.serverGeneration` (8a to 12) and `risu.serverTransform` (13), so a defect in one server
  path does not force the browser path for both (F-c).
- Each binding records which character it addresses:
  - `runCharacter`: the executing character, for the setters and getters Phase 4 changed;
  - `engineCharacter`: the chat owner or selection, for lore, CBS, and the last-message
    fallbacks.

  The server keeps that split. The job context supplies both, groups included.

- The persona functions read the frozen effective persona.
- `generateImage` refuses a run without a character target (today it casts).
- Button execution stays refused in group chats, as `Chat.svelte` does today.
- Client tests kept until cutover: `scriptings.test.ts` and `scriptingsSetters.test.ts`.

### Slice 8b (`trigger-runtime`)

- `v2SetPersonaDesc` writes the frozen effective persona. The client path keeps the selected
  persona until cutover, and `triggers.test.ts:666-671` stays as the client contract.
- Display and request runs work on a deep clone of the character's lore, so the in-place lore
  edits stop (Phase 4 residual).
- Native getters after a Lua write read the record as the run left it (Phase 4 residual), pinned
  by a fixture.
- The five native regex sites run through the worker's single-regex tasks.
- A native run checks the job's abort signal per effect and stops after 100,000 effects
  (recorded).
- `v2Command` always targets the run's chat.
- The server `display` trigger runs on the target's character and chat.
- Recursive `v2RunTrigger` propagates `displayMode`, `tempVars`, `triggerId`, and the context.
- The command names are `speak` and `?`, not `tts` and help.
- The deprecated lore effects are ported as is (the separate task card owns their fix).

### Slice 9 (`prompt-assembly`)

- The flag branch sits in `sendChat`, not `sendMain`. Plugin `sendChat`, slash commands, and file
  sends reach `sendChat` without `sendMain`. The branch writes the two per-send fields
  (`incrementStatic` for `statics.messages`), flushes, then POSTs.
- The user message id travels with the request, so a retried POST does not append twice.
- `PromptScope` has two parts:
  - an immutable identity and configuration: the ids, the settings sections, the preset, the
    effective persona, the modules, and the credentials;
  - a mutable working state: the chat and character records as the job's own writes and the
    acknowledged callback writes leave them.

  Unrelated concurrent changes stay invisible. The merge order is the selected preset, then the
  five "keep on preset change" `providers` fields, as today.

- The `presetChain` branch picks the preset by name and string id (`changeToPreset` is id-based).
- The memory stub handles `chat.lastMemory` as the no-memory trim does.
- The multimodal branch covers images, video, audio, signatures, asset prompts, module assets, and
  icon reads, or records which ones the server refuses until slice 10.
- The golden test compares against the baseline capture, not a capture taken now.

### Slice 10 (`memory-on-server`)

- The credential sources as in the Baseline: `supaMemoryKey` from `llmSecrets`, the others from
  `secrets`.
- Server memory calls the providers directly. The proxy ops stay for the browser path and the
  three consumers that stay in the browser.
- HypaV3's summarize call gets its context (P10).
- Each algorithm keeps its own persistence shape (`hypaV2Data`, `hypaV3Data`, Supa's
  metadata). Hanurai persists nothing.
- The branch selector is the effective flags (`hanuraiMemory`, `hypav2`, `hypav3`, then the Supa
  flags), not `memoryAlgorithmType`.
- HypaV3 presets resolve by id with the shared selector (`shared/hypaV3Presets.ts`).
- `files/multisend.ts` stays client-side: it processes attachments before the POST. Recorded.
- The local-model backend check runs in the image. WebLLM and Transformers.js are separate
  decisions (question 5).
- The `testText` raw key: parity or a fix, decided in the slice and pinned.

### Slice 11 (`post-generation-and-plugin-callbacks`)

- Today's observable order is kept, with an explicit stage table per path and per loop
  iteration:
  - listeners and the TTS notice inside each iteration, at their current positions;
  - auto-continue and the resend inside the job's bounded loop;
  - `igp` once after the loop, before the final write;
  - the `imggen` callback last, before `done`;
  - `done` means "reply persisted".
- The `igp` fix (question 10) handles the response type: `success` appends `rq.result`,
  `multiline` appends the first result, and `fail` appends nothing and emits a notice.
- The `decodeToolCall` fix, and `chat.toolCalls` as a shared type with a normalizer rule and
  tests. `shared/database.ts` and `server/src/data/chats.ts` join the allowed files. The flag-off
  path reads `chat.toolCalls` too.
- The provider callback transport is new: `providerChunk`/`providerDone` over cumulative
  `StreamResponseChunk` values. Descriptors are snapshotted at job creation, and an unloaded
  provider fails the callback.
- `chatOutput` listeners get fresh hydration before each listener. Today one snapshot serves all
  listeners, a difference recorded.
- The hook policies:
  - a provider error fails the job;
  - a `chatOutput` error is logged and continues, as today;
  - a body interceptor error continues, as today;
  - a barrier failure overrides all three (slice 6).

### Slice 12 (`mcp-on-server`)

- The OAuth refresh fix. `authRefreshes` is replaced by URL on re-auth (no duplicates).
- `internal:risuai` stays call-only.
- RisuAccess ports Phase 4's semantics: consent, re-resolve by id, a synchronous write.
- `graphmem` writes `scriptstate` through the job's chat `meta` op.
- `authRefreshes` stays client-readable (MCP OAuth is not an LLM credential under Decision 6) and
  is not sent as a `resource` event.
  - Residual: between 12 and 14 a server-side refresh leaves the browser mirror stale until a
    reload, so the browser MCP path can ask for OAuth again (F-e).
- The callback leg of question 13 stays for the plugin, filesystem, and Google search tools.

### Slice 13 (`script-transform`)

- The handler-set component of the cache key is a digest of the enabled plugins that registered
  display or process handlers (the `plugins` revision plus their ids), plus a reload counter. A
  per-tab counter alone collides across tabs.
- The key also includes:
  - `personaId`;
  - the revisions of every module source: `modules`, `enabledModules`, the character, the bound
    persona (`personas`), and the chat's `modules` meta value;
  - the dynamic-asset settings;
  - `targets[].triggerId`.
- The epoch prefixes the server cache, and the client LRU drops responses from another epoch or
  from before a "Re-render".
- The phase-2 snapshot is bound to its `snapshotId` and to the client id.
- The read-only claim is narrowed: the server stages are read-only, and browser plugin display
  handlers keep today's capabilities (recorded; the plugin API does not change).
- Display effects besides `emotion` (`v2UpdateGUI`, `v2UpdateChatAt`) are discarded in a
  transform, recorded.
- `MultiLangDisplay.svelte` is under `src/lib/UI/GUI/`.
- Complete parity, dynamic assets included, needs slice 10.

### Slice 14 (`cutover-and-docs`)

- The stopping condition stays: an unrouted caller found here is reported unless it is a one-line
  change. The re-baseline's inventory feeds 7a and 7b, so the cutover should find none.
- The tests that move or go with the client runtimes are listed for the adapter:
  `scriptings.test.ts`, `scriptingsSetters.test.ts`, `triggers.test.ts`, the client request
  tests, `proxyJobWs.test.ts`, and `llmSecrets.test.ts`'s plaintext cases.
- The bundle check is `rg -l wasmoon dist/assets` plus `rg -l scriptings dist/assets`.
- The credential capture covers every consumer that stays: send, translation, suggestion, the
  model list, DALL-E, TTS, Whisper, Imagen, the embedding playground, and a file attachment.
- The cutover commit is rehearsed as a revert with the server transport still active.

## Plan review decisions

Astra's points, with Fable's evaluation of each. I adopted Fable's smaller fix wherever it
offered one.

- **P1 (`supaMemoryKey` exception):** adopted, with Fable's fix. The memory shapes are proxy ops,
  and the key flips in 7b. Draft question 12 is withdrawn.
- **P2 (backups, settings report):** adopted. New question 12; the report keeps its filters.
- **P3 (auxiliary injection policy):** adopted as Fable's bounded op table (question 2). The
  general policy engine is rejected.
- **P4 (secret references, settlement):**
  - the settlement obligation: adopted;
  - the references: question 3 narrowed to `customModels[].key` (Fable's fix), with Astra's
    variant kept as option (b);
  - compound preset-and-secret operations: rejected (alpha; a recorded residual).
- **P5 (7a without bridges):** adopted: the local provider branch, the tool descriptors, the
  callback leg (question 13), and the parity gate.
  - Applying `bodyIntercepter` to calls without a job: rejected. It stays recorded as the
    planning notes say.
- **P6 (nested callbacks, failures):** adopted, with Fable's depth-2 stack and the failure rules.
  The fuller correlated child-callback design is rejected.
- **P7 (worker coverage):** adopted: the single-regex tasks, the same-worker rule, and the native
  effect cap.
- **P8 (restore and shutdown):** adopted, with Fable's smaller fix (abort, then dispose in
  order). A final checkpoint beyond the abort checkpoint and a separate `aux` disposal are
  rejected.
- **P9 (hydration):** adopted: the ordered comparison, the chat hydration event, and reconnect by
  saved job id.
  - Settling dirty targets before a callback: rejected. The pre-send flush covers it, and a
    conflict is the conservative `failed` outcome Phase 4 records.
- **P10 (identity and working state):** adopted. The browser hosts gain their context, and the
  flag branch moves into `sendChat`.
- **P11 (transform cache):**
  - the digest key, the missing components, and the epoch: adopted;
  - the read-only claim: narrowed instead of enforced, since the plugin API must not change;
  - a per-client namespace: rejected.
- **P12 (tail order):** adopted. Today's order is kept with stage tables, so no owner question is
  needed.
- **P13 (fixture timing):** adopted: the baseline capture after Stop A.
- **P14 (dependencies, gates, Docker):** adopted, with two Astra sessions in segment B.
- **P15 (dispositions, details):** the details are adopted: the lore flag parse, the ordered
  effects, a fixture-proven defect going to you, and the narrowed display wording. Its question
  dispositions match the final questions, except question 3 (above).
- **P16 (testing advice):** I judge it necessary as a whole, so it goes to each slice's Fable
  reviewer verbatim, with Fable's sort into necessary and not necessary (`plan-review.md`). The
  reviewer judges again.
- **P17 (Fable evaluation):** done.
- **Fable's F-a to F-e:** all adopted (above).

## Checks

- **Per slice:** the project checks, the slice's own validation list, its manual checks through
  Playwright against a fresh server in a temp directory, and the review-step tests (written by
  the Fable reviewer).
- **At Stop A:** the spikes and the worker smoke inside the built image.
- **At each stop from B on:** the Docker smoke on a fresh volume.
- **Between 7a and 7b:** the flag-off parity gate with recorded provider bodies.
- **At Stop D:** the flag-on matrix and both golden tests against the baseline capture. The
  matrix: send, continue, reroll, group, memory, image generation, Lua buttons, manual triggers,
  alerts, two tabs, a reload mid-stream, and a restore during a send.
- **At the cutover:**
  - the exit-criteria commands (the bundle greps; the network capture with no credential outside
    the key-entry routes);
  - the full matrix in Docker;
  - the revert rehearsal;
  - the docs.
