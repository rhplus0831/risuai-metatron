# Server Tokenizer Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at
`832caccf0`, after the Per-Chat Send plan was archived. No slice landed. Locations were read by
the session against `28e7fda88`. Line numbers are approximate; the identifiers are the anchors.
Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

## Problem

The tab carries a second copy of every tokenizer. `src/ts/tokenizer.ts` (439 lines) loads
tiktoken (`@dqbd/tiktoken`, wasm), `@mlc-ai/web-tokenizers` (wasm), Transformers.js
`GemmaTokenizer`, and the bundled `src/etc/o200k_base.json` (2.3 MB). It also fetches
vocabularies from `public/token/` (75 MB in total, one family per use, `fetch("/token/...")`
~235–314).

The server already has the same families and routing:

- `server/src/prompt/tokenizers/` `createTokenizers` (every `TokenizerFamily`, loaded on
  first use);
- `server/src/prompt/tokens.ts` `createTokenCounter` (`encode`/`count` over a
  `TokenCountScope`, its LRU, Google `countTokens` with the stored key);
- `shared/tokenizerChoice.ts` `selectTokenizer` and `shared/prompt/chatTokens.ts`
  `ChatTokenCounter`, which both runtimes share.

Requests and jobs already count on the server: `/api/llm/request` gets the tab's scope in
`context.tokenizer` (built in `transport.ts` ~188–225, validated in `routes/llm.ts` ~132–145,
turned into a `TokenCountScope` in `llm/requests.ts` ~1375–1388). Jobs use `tokenScopeFor`
(`llm/settings.ts` ~292). The tab's tokenizer only serves on-screen counts. The two copies are
kept equal by fixtures (`server/src/tests/fixtures/tokens/browser-ids.json`, `tokenParity.test.ts`).

Client callers (non-test):

- **Plain counts:**
  - `AlertComp.svelte` ~575 (`{#await tokenize(...)}` of a request log body);
  - `PopupEditor.svelte` ~31–42 (effect while previewing);
  - `PlaygroundTranslation.svelte` ~104;
  - `MemorySettings.svelte` ~114–116 (`tokenizePreset`, `getCharToken`);
  - `PromptPresetSettings.svelte` ~48–51 (`loadTokenize`, see Open Questions);
  - `PromptSettings.svelte` ~38–48 (`tokenizePreset` twice per template change);
  - `CharConfig.svelte` ~102–116 and ~201–209 (`tokenizeAccurate` on every `desc`/`firstMsg`/note
    change, so on every keystroke);
  - `ChatNoteEditor.svelte` ~20–57 (already idle/300 ms delayed with a run counter);
  - `LoreBookData.svelte` ~56–60 and ~302 (`{#await getTokens(value.content)}` in the template).
- **Aggregates:** `DevTool.svelte` ~179–198 (`getCharToken`, `getChatToken`, `tokenizePreset`)
  and the lorebook preview `loadLoreBookV3Prompt` (`lorebook.svelte.ts` ~117–175, used by
  `DevTool.svelte` ~324/~338 and `command.ts` ~255).
  - The lore engine counts each activated entry with a sequential
    `await host.tokenize(...)` (`shared/lore/activation.ts` ~595), but reads `act.tokens` only
    after the loop (~639).
  - `getChatToken` (`tokenizer.ts` ~421) counts each message in turn through `ChatTokenizer`.
- **Ids:** `PlaygroundTokenizer.svelte` (`encodeWithTokenizer`, `tokenizerList`) is the only
  caller that needs token ids.
- **Names only:** `ModelProfileEditor.svelte` (`tokenizerList`).
- **Types only:** `hypav3.ts` (`ChatTokenizer`).

Moved as they are, these callers would make one request per keystroke (`CharConfig`), one
per lore entry, and one per chat message.

## Approach

The server answers token counts for the tab through a new batch route. `src/ts/tokenizer.ts`
keeps its exported names and signatures (`tokenize`, `tokenizeAccurate`, `getCharToken`,
`getChatToken`, `ChatTokenizer`, `tokenizerList`) so the callers and the 26 test files that
mock it stay as they are. Its body becomes a client of the route.

- **Scope.** The tab sends the same scope fields as `context.tokenizer` of `/api/llm/request`.
  One builder, `tabTokenScope(presetScope?)` in `tokenizer.ts`, replaces the inline object in
  `transport.ts`. The server adds the stored Google key, as `llm/requests.ts` does for a tab
  request. `tokenizerIdentityKey` moves from `server/src/prompt/tokens.ts` to
  `shared/tokenizerChoice.ts` so the tab's cache keys by the same identity.
- **Plugin `custom` tokenizer.** A legacy plugin provider model (`custom` with
  `tokenizer: "custom"`) counts with `cl100k_base` on screen too, as the server already does
  (D1). Its `tokenizerFunc` is no longer called anywhere.
- **Coalescing.**
  - Calls without a signal made in the same macrotask are coalesced per scope identity into one
    request (a `setTimeout(0)` flush). The batch is split at 256 texts or 1 MiB of text.
  - A call with an `AbortSignal` goes alone, so an editor can cancel it cleanly.
  - Each text has its own result. A text the tokenizer refuses (`<|endoftext|>` for
    `cl100k_base`/`o200k_base`, `llm-requests.md` ~148) rejects only its own promise, as the
    local `encode` throws today.
- **Cache.** The client LRU (1,500 entries, on `useTokenizerCaching` as today) maps
  `text + identity key` to a count, not ids.
- **Aggregates in one round trip.**
  - The lore engine starts every activated entry's count in the loop, then awaits them all
    before the budget pass. `parseCBS` still runs in loop order, so variables are read as
    today.
  - `tokenizePreset` parses every item first, then counts them in one batch.
  - `getChatToken` counts every message text (and name) in one batch before
    `ChatTokenCounter`'s arithmetic. `ChatTokenHost.encode` becomes `count`, returning a number
    (the server host returns `encode(...).length`).
- **Editors** count after 400 ms without a change, keep only the latest answer (run counter),
  abort the superseded request, count only while mounted, and keep the last count on a failure
  (no alert). The first count on open runs at once (`ChatNoteEditor` keeps its idle-callback
  first run).
- **Payloads.** `public/token/` moves to `server/assets/token/`. The Dockerfile already copies
  `server/`, so the image still has them, and Vite stops copying 75 MB into `dist/`. The client
  loaders, `src/etc/o200k_base.json`, and the Vite `needsInterop` entry go. The npm packages stay
  in `dependencies`: the server imports them, and `@huggingface/transformers` still serves
  `transformers.ts` and `PlaygroundSubtitle.svelte`.

## Order

1 → 2 → (3, 4).

- Slice 1 is the server route.
- Slice 2 switches `tokenizer.ts` to the route and makes the aggregates one round trip.
- Slices 3 and 4 share no file: 3 is the editor debounce, 4 is the payload move, the removal
  of what remains, and the docs. They run in parallel.

Between slices 2 and 3, `CharConfig` sends a request per keystroke. Push nothing between them.

## Slice 1. Token count route (_hard_, `self-host-server.md`)

- `shared/tokenizerChoice.ts`:
  - `tokenizerIdentityKey`, moved from `server/src/prompt/tokens.ts` (re-export it there or
    update its importers, `llm/requests.ts` strong-ban cache included);
  - `TabTokenScope`, the wire shape of `context.tokenizer`;
  - `isTabTokenScope`, the check `routes/llm.ts` ~132–145 does inline (that route switches to
    it);
  - `playgroundFamily(name)`: the `tokenizerList` names to families as `encodeWithTokenizer`
    maps them (`tik` → `cl100k_base`, `llama3` → `llama3`, unlike `byName`'s `llama`), the
    default `cl100k_base`.
- `server/src/routes/tokens.ts` (new) `registerTokenRoutes(app, { counter, tokenizers, store,
auth, limiter })`, after `auth.checkAuth` and `authenticatedRouteLimiter` as
  `registerLlmRoutes` (`app.ts` ~728). Use the route-level `bodyLimit` and `readJsonBody`
  pattern of `translate.ts` ~56–69, including the preread fix for an erroring stream
  (memory note: bodyLimit preread 500).
  - `POST /api/tokens/count`:
    - Body: `{ scope: TabTokenScope, texts: string[] }`, at most 512 texts and 2 MiB.
    - Answer: `{ counts: (number | null)[] }`, where `null` is a text the tokenizer refused.
    - The stored `google.accessToken` is added to the scope (read it the way the tab request's
      `loadRequestDb` path does, or the lighter settings read if one exists).
    - The counter is the app's one `createTokenCounter` instance (`app.ts` ~300), so its LRU is
      shared with requests.
  - `POST /api/tokens/encode`:
    - Body: `{ tokenizer: string, text: string }` (a `tokenizerList` name) and 2 MiB.
    - Answer: `{ ids: number[] }`, through `playgroundFamily`.
  - `400` for a malformed body or scope, `413` over the limits.
  - Check whether `/api/llm/request` refuses during maintenance; if it does, these routes do the
    same.
- `shared/diagnostics.ts` `ROUTE_TEMPLATES` (~258): both templates.
- `self-host-server.md`: route table and the token counter paragraph (~96–97).
- Test: `server/src/tests/tokenRoutes.test.ts`:
  - auth refusal before the counter is called;
  - a malformed scope or text list is `400` and over-limit is `413`;
  - counts equal `counter.count` for `cl100k_base` and one sentencepiece family;
  - a `<|endoftext|>` text is `null` beside a counted one;
  - a plugin `custom` scope counts with `cl100k_base`;
  - the Google branch gets the stored key (fetch stubbed, as `tokens.test.ts` does);
  - `/encode` returns the `browser-ids.json` ids for `tik` and `llama3`.

  Keep the real tokenizer loads to the families the existing gate tests already load, or tag
  the case `slow` (`STRUCTURE.md` V3). Update `llmRoutes.test.ts` for the shared scope check.

## Slice 2. Client tokenizer over the route (_hard_, `llm-requests.md`)

- `src/ts/storage/` or `src/ts/tokenizer.ts`: `requestTokenCounts(scope, texts, signal?)`,
  through the same authenticated fetch helper the other JSON routes of the tab use (find the
  `/api/llm/request` caller's helper in `transport.ts`; re-verify retry policy: a count is
  idempotent, so a retried network failure is safe).
- `src/ts/tokenizer.ts`:
  - `tabTokenScope(presetScope?)`, the fields of `transport.ts` ~214–224, and `transport.ts`
    switches to it.
  - `encode` is replaced by `countTokens(text, scope?, signal?)`, with the coalescer and the
    LRU from the Approach. `tokenize`, `tokenizeAccurate`, `tokenizerChar`, and
    `getCharToken` use it. `tokenizeAccurate` keeps the client-side `risuChatParser` step and
    takes an optional `signal`.
  - `encodeWithTokenizer` calls `/api/tokens/encode`. `tokenizerList` stays (it is names).
  - Delete the loaders (`tikJS`, `tokenizeWebTokenizers`, `gemmaTokenize`,
    `tokenizeGoogleCloud`, the plugin-function branch) and their imports.
  - `ChatTokenizer` and `getChatToken` move to the count host (below).
- `shared/prompt/chatTokens.ts`: `ChatTokenHost.encode` → `count(text): Promise<number>`.
  The server host (`server/src/prompt/` prompt runner and memory task host; find them with
  `rg -n "ChatTokenCounter|ChatTokenHost" server/src`) passes `counter.count`.
- `getChatToken`: collect every message's content and name, count them in one batch, then run
  the arithmetic over the counted map (no request per message).
- `src/ts/process/prompt.ts` `tokenizePreset`: parse every item with `risuChatParser`
  (`tokenizeAccurate`'s step), then count the texts in one batch.
- `shared/lore/activation.ts` ~584–600: push the count's promise with the entry, then
  `Promise.all` before the budget pass (~635). Keep `host.parseCBS(content)` in the loop.
- `llm-requests.md` (~75–80, ~201, ~212–215): the tab no longer tokenizes; counts come from
  the route; the plugin-function branch is gone everywhere.
- Test:
  - `src/ts/tokenizer.test.ts` rewritten over a stubbed fetch:
    - same-tick calls are one request;
    - a cache hit makes no request, and no caching with `useTokenizerCaching` off;
    - a signal-bearing call goes alone and aborts;
    - a `null` rejects only its own call;
    - the scope equals what `transport.ts` sends;
    - `getChatToken` over 50 messages is one request;
    - the `mainModel`/`requestModel` host cases it has today.
  - `shared/lore` activation test: with a deferred `tokenize`, every activated entry's count is
    asked before the first resolves, and the budget result equals today's.
  - `tokenizePreset`: one batch for a whole template.
  - `server/src/tests/tokens.test.ts`/`imageTokens.test.ts`: the `count` host.

## Slice 3. Editor counts on a delay (_small_, `ui-theming.md`)

- A small helper next to `tokenizer.ts`, `createTokenCountField(scope?)` or similar: it takes
  a text, waits 400 ms of quiet, aborts the superseded request, applies only the latest
  answer, keeps the last count on a failure, and stops at teardown. The first count after
  mount is immediate.
- Use it in:
  - `CharConfig.svelte` (`desc`, `firstMsg`, note; per field, ~102–116 and ~201–209);
  - `LoreBookData.svelte` (replace the template `{#await getTokens(...)}` ~302 with a field fed
    by an effect; count only while the entry is open);
  - `PromptSettings.svelte` (~38–48, one field per `consti` mode);
  - `PopupEditor.svelte` (~31–42);
  - `PlaygroundTokenizer.svelte` (`onInput`).
- `ChatNoteEditor.svelte` already delays; switch it to the helper only if that keeps its
  idle-callback first run, else leave it.
- The `ui-theming.md` editor note, if it names token counts.
- Test (fake timers, a stubbed count): a burst of ten edits in `CharConfig` is one request
  400 ms after the last; a failure keeps the previous number; an unmounted editor sends
  nothing; `LoreBookData` closed sends nothing. Update `CharConfig.emotions.test.ts`,
  `ChatNoteEditor.test.ts`, and `LoreBookList.test.ts` mocks where the helper is new.

## Slice 4. Payload move, removal, docs (_small_, `build-test-platforms.md`)

- `git mv public/token server/assets/token`.
- `server/src/prompt/tokenizers/payloads.ts`: `TOKEN_PAYLOAD_DIRS = ["server/assets/token"]`
  and its comment. The `dist/token` fallback goes: the image has `server/`.
- Delete `src/etc/o200k_base.json`. The server uses the package's copy
  (`tokenizers/tiktoken.ts` ~10); update that comment.
- `vite.config.ts` ~73–75: drop `optimizeDeps.needsInterop` for `@mlc-ai/web-tokenizers`.
- `rg -n "token/" public/sw.js src/ts/serviceWorker*`: no precache or route names the
  payloads (none found at `28e7fda88`; re-check).
- Search hygiene and docs:
  - `.ignore` (`public/token/` → `server/assets/token/`, drop `src/etc/o200k_base.json`);
  - `.prettierignore` ~4;
  - `CLAUDE.md` and `AGENTS.md` ~22 (the `--no-ignore-dot` recipe);
  - `STRUCTURE.md` ~213–217 and ~264–265;
  - `self-host-server.md` ~96;
  - `build-test-platforms.md` ~254–255 (the `dist/token` layout row);
  - `llm-requests.md` ~80;
  - `server/src/tests/fixtures/tokens/README.md`: the browser ids are now a frozen reference;
    the capture can no longer be rerun from the tab.
- Tests:
  - `server/src/tests/tokens.test.ts` ~100–170 (payload dir resolution);
  - `tokenPlainNode.test.ts` ~27–31 (the image-layout root is now `server/assets/token`);
  - `memoryTasks.test.ts` ~1745 comment.
- Check:
  - `pnpm build`: `dist/` has no `token/` and no o200k chunk; report `du -sh dist` before and
    after.
  - `docker build`, then one `/api/tokens/count` request in the container for `cl100k_base`
    and `llama3`, as the production-server checks in `build-test-platforms.md` (~82) run.
  - `node server/src/prompt/tokenizers/loadAll.ts` from the repository root.
- Browser check (headless Chrome through `pnpm dev:agent`):
  - `CharConfig` typing shows a count after the pause;
  - DevTool character, chat, preset, and lorebook preview counts match the values before slice 2
    on one seeded character;
  - `PlaygroundTokenizer` ids for `tik`;
  - no request to `/token/` in the network log.

## Decisions

The runner takes each default unless the user overrides it.

- D1. Plugin `custom` tokenizer. Decided by the user: count with `cl100k_base` on screen, as
  the server does. `tokenizerFunc` is never called.
- D2. Route shape. Options: (a) `/api/tokens/count` (batch counts) and `/api/tokens/encode`
  (ids, Playground only); (b) one route with a mode. Default (a).
- D3. Scope source. Options: (a) the tab sends the scope fields, as `/api/llm/request` does;
  (b) the tab sends preset ids and the server resolves the model. Default (a): the plugin
  `tokenizer` option exists only in the tab, and the server already validates this shape.
- D4. Limits. Default: server 512 texts and 2 MiB per request; client batches split at 256
  texts or 1 MiB.
- D5. Editor delay. Default 400 ms after the last change, the first count immediate.
- D6. Failure display. Options: (a) keep the last count silently; (b) show `?`. Default (a).
- D7. Whole-chat count (`getChatToken`). Options: (a) send the texts in batches; (b) the
  server counts the stored chat by `chatRef` (no text upload, but it misses unsaved edits and
  needs a chat-reading route). Default (a): DevTool is its only caller.
- D8. Payload location. Options: (a) `server/assets/token/`; (b) a root `token/` with a new
  Dockerfile `COPY`. Default (a).
- D9. Locales. No user-visible string is expected. If one is added, `en.ts` only.

## Open Questions

- `PromptPresetSettings.svelte` `loadTokenize` (~48–51) has no caller at `28e7fda88`. The
  main prompt, jailbreak, and global note counts (~503–509) may always show 0. Not checked in a
  browser. Raise it with the user: wire it to the slice 3 helper, or remove the counts.
- The client `hypaMemoryV3` (`src/ts/process/memory/hypav3.ts` ~66) has no caller outside its
  file. If it is dead, removing it is a separate cleanup; this plan only keeps its
  `ChatTokenizer` type import compiling.
- The authenticated route limiter (2,000 per minute, `app.ts` ~452) is shared with every other
  route. Coalescing keeps DevTool and the lore preview to a few requests; recheck if a caller
  turns out to count per item.
- When the server is unreachable, counts stop updating (the app needs the server anyway).
- Typing a long text sends the whole text once per pause. Counting changed paragraphs only
  (a paragraph-hash cache with an exact recount on blur) was set aside by the user; revisit it
  only if large cards feel slow after slice 3.
