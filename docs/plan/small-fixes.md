# Small Fixes Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at
`832caccf0`, after the Per-Chat Send plan was archived. No slice landed. Per-Chat Send slice 7
(`c9e6cde40`) landed after drafting and changed `server/src/jobs/channel.ts`,
`src/ts/network/jobChannel.ts`, and `src/ts/process/request/request.ts`, so line numbers cited
there are stale. Every location was checked against `28e7fda88` by a Luna fan-out (8 workers),
with the TLS, sandbox log, WebLLM, and body-limit claims re-read by the session. Line numbers
are approximate; the identifiers are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

## Problem

Finished plans, the project memory, and the fork research left a set of small defects. They
are independent and each fits in one short session, but no plan owns them, so they keep
coming back in every survey. Grouped by effect:

- Secrets can leave the machine. `.gitignore:49` ignores `/server/node/ssl/certificate`.
  The certificate generator (`server/ssl/Generate Certificate.sh`) and `server/src/main.ts:19`
  use `server/ssl/certificate/`, and that directory holds `ca.key` and `server.key`. Nothing
  ignores the real path, so a generated key can be committed. The Dockerfile's `COPY . .`
  (`:23`) and `COPY --from=builder /app/server` (`:35`) also put it in the image, because
  `.dockerignore` does not list it either. The plugin sandbox host logs every RPC
  unconditionally (`src/ts/plugins/apiV3/factory.ts:1023-1024`,
  `Original request:` / `Original response:`). A `nativeFetch` call's arguments carry the
  plugin's request headers and body (`factory.ts:264-276`, `:384-390`), so API keys reach
  the console.
- Server answers that are wrong or can hang:
  - Only the message search route turns a request stream that fails during the body-limit
    read into a 400 (`server/src/routes/messageSearch.ts:204-228`). Every other route with
    its own `bodyLimit` passes the raw limiter, so the app's `onError` answers 500:
    `translate.ts:56/68`, `transform.ts:224/284/287`, `resources.ts:181` (boot),
    `push.ts:31/48/70`, `diagnostics.ts:43/52`, `requestHistory.ts:107` and
    `memoryTasks.ts:53/65`.
  - `server/src/prompt/tokens.ts` `countWithGoogle` (~62) fetches with no signal or timeout,
    so a stalled count holds a job or a memory task until its deadline.
  - Static files are served by `serveStatic` (`server/src/app.ts:644-664`) with
    `Last-Modified` only: no `Cache-Control`, no `ETag`, no 304. Once Chrome's heuristic
    freshness lapses, a boot downloads the app's ~3.8 MB of scripts again. The service
    worker (`public/sw.js`) does not cache app files.
  - `requestWebLLM` derives the model with `aiModel.split(":::")[1]`
    (`server/src/llm/request.ts:681`). For a reverse proxy whose `customAPIFormat` is
    WebLLM, `aiModel` is `reverse_proxy`, so `localGeneration` gets `undefined`. The
    resolved name is already in `modelInfo.internalID` (`:410-417`). The client copy
    (`src/ts/process/request/request.ts` ~771-809) has the same split.
- Client UI bugs (details per slice): unnamed modules throw in the module list sort. The
  pinned rail shows trashed characters. `makeGroupImage` leaves its "Loading.." wait. The
  light schemes get inverted prose. A new sidebar folder may refuse drags. CharConfig
  raises an error alert when the chat is not loaded. Five lorebook editor bugs, one of them
  a write to the wrong chat. Enter/Escape never reach an alert over the composer. A
  rejected Escape still closes Settings. HypaV3 bulk resummary Cancel is undone and its
  selection jumps rows. Streamed auto-translation re-translates per chunk.
- Text and docs:
  - The English settings label reads "Chat Formating".
  - de/es/vi help text claims a 0.125 s Balanced throttle that no longer exists.
  - `ko.ts` lacks 59 English keys, `characterGenerating` among them.
  - The memory task wording still says "not enabled yet".
  - Some docs still say safe mode is CSS-only.
  - `chat-pipeline.md:192` still says production has no memory task service.
  - The test-platform guide has a stale timing note and an incomplete config list.
- `server/src/tests/importPngCaps.test.ts:52` expects `{ total }` from `planPngFile`, which
  returns `{ total, card }` (`server/src/routes/importPng.ts:146`), so it fails on a clean
  tree.

## Approach

Fix each defect in place with the smallest change and a regression test, grouped by file
cluster so slices can run in parallel. No new architecture. Where a fix has a real choice,
a decision below gives the default.

## Order

Wave A in parallel: 1, 3, 6, 7, 9, 12. Wave B: 2 after 1, 5 after 3, 8 and 10 after 6.
Wave C: 4 after 2. Slice 11 runs last.

- 1, 2 and 4 all edit `self-host-server.md`. 3 and 5 both edit `llm-requests.md`. 8 and 10
  touch files 6 also edits (`AlertComp.svelte`, `Chat.svelte`). 11 edits the locale files
  7 adds a key to, and the guides other slices touch.
- Per-Chat Send: landed and archived (`832caccf0`). Its slice 7 (`c9e6cde40`) edited
  `plugins-mcp.md`, `self-host-server.md`, and `src/ts/process/request/request.ts`; slices 1,
  2, 4 and 5 re-read them first.

## Slice 1. Keep TLS keys and plugin request logs private (_small_, `self-host-server.md`)

- `.gitignore:49`: replace `/server/node/ssl/certificate` with `/server/ssl/certificate/`.
- `.dockerignore`: add `server/ssl/certificate`. The generator scripts and `*.conf` stay in
  the image.
- `factory.ts:1023-1024`: remove both `console.log` calls (D1).
- `self-host-server.md`, where it describes HTTPS and the Docker context; `plugins-mcp.md`
  if it mentions the host's logging.
- Test:
  - A `SandboxHost` test (next to `src/ts/plugins/apiV3/guestBridge.test.ts`): a
    `nativeFetch` RPC with an `Authorization` header logs nothing that contains the header
    value or the body.
  - Check by hand: `git check-ignore server/ssl/certificate/server.key` matches, and a
    `docker build` context listing (`docker build --no-cache --progress=plain` with a probe
    `RUN ls server/ssl`, or the BuildKit context size) has no `certificate/`. Record the
    result in the commit message.

## Slice 2. A failed request stream answers 400 on every route (_small_, `self-host-server.md`)

Depends: 1.

- Move the wrapper in `messageSearch.ts` (~204-228) into a shared route helper (for
  example `server/src/routes/limitedBody.ts`). It tracks whether the handler ran, maps a
  pre-read stream failure to 400, and keeps the handler's own body read guarded. Use the
  helper in `messageSearch.ts` and in the routes listed under Problem.
- The global limiter's comment in `server/src/app.ts` (~618-621) names these routes and
  stays accurate. Do not change it.
- `self-host-server.md`: one rule for route-level body limits.
- Test: for each route, an erroring request stream answers 400 (not 500) and an oversized
  body still answers 413. Copy the pattern of `messageSearch.test.ts:741-757`.

## Slice 3. Google token counts have a timeout (_small_, `llm-requests.md`)

- `tokens.ts` `countWithGoogle` (~62, called ~105): pass
  `signal: AbortSignal.timeout(GOOGLE_COUNT_TIMEOUT_MS)` (D2). Map an abort to the same
  error path a failed count takes today, and check what the callers do with that error.
- Test, in `server/src/tests/tokens.test.ts`:
  - A `fetchImpl` that never answers rejects after the timeout, using fake timers.
  - The fetch receives a signal.
  - The memory task host test's note that a Google count stays pending after a cancel
    (`server/src/tests/memoryTaskHost.test.ts`) is updated if D2 (b) is taken.

## Slice 4. Static files get cache headers and 304 (_small_, `self-host-server.md`)

Depends: 2 (same guide).

- `app.ts` static serving (~644-664) and `serveIndex`:
  - `/assets/*` (Vite's content-hashed output) gets `Cache-Control: public,
max-age=31536000, immutable`.
  - `index.html`, `sw.js`, `manifest.json`, and the other `public/` files get `no-cache`
    with an `ETag` or `Last-Modified` validator, and a matching `If-None-Match` /
    `If-Modified-Since` answers 304 (D3).
  - `sw.js` and `manifest.json` stay revalidated so service worker and PWA updates still
    arrive.
- Compression stays out (archived audit 3c).
- `self-host-server.md`: the caching rule.
- Test, in `server/src/tests/app.test.ts` (~38-91):
  - The headers for a hashed asset, `index.html`, and `sw.js`.
  - A conditional GET with the validator answers 304 with no body.
  - A client route fallback still serves `index.html` with `no-cache`.

## Slice 5. A reverse proxy's WebLLM format runs the configured model (_small_, `llm-requests.md`)

Depends: 3 (same guide). Per-Chat Send slice 7 (`c9e6cde40`) changed the client `request.ts`:
re-read it first.

- `server/src/llm/request.ts` `requestWebLLM` (~681): use `arg.modelInfo.internalID`, and
  fall back to the split only when it is missing. Make the same change in the client copy
  (`src/ts/process/request/request.ts` ~771-809).
- Test:
  - `server/src/tests/jobRequestModelPreflight.test.ts` (~347-348) asserts the local model
    name for the reverse proxy WebLLM case, not only `{ kind: "local" }`.
  - The `hf:::tiny` case (~376-388) still passes.

## Slice 6. Sidebar, list, and theme fixes (_small_, `ui-theming.md`)

- `ModuleSettings.svelte:51` and `ModuleChatMenu.svelte:34`: sort with
  `(a.name ?? "").toLowerCase()`, because `shared/modules.ts` (~81-92) admits a module
  without a name.
- `src/lib/SideBars/pinnedChats.ts` (~29-47): skip characters with `trashTime`.
- `src/ts/characters.ts` `makeGroupImage` (~710-716): clear the wait before the early
  return, or set it after the check.
- `MobileCharacters.svelte` (~53-57): apply `border-t` to the first visible row, not
  sorted index 0.
- `prose-invert` follows `$ColorSchemeTypeStore === "dark"` in `AlertComp.svelte:244`,
  `MultiLangDisplay.svelte:72` and `:81`, and `Chat.svelte:969`. Before this fix the
  store's `"light"` value is truthy, so the class was always on.
- `SideChatList.svelte`: recreate the Sortable instances after folder creation (~767-781),
  once the new `.risu-chat` container is in the DOM (`tick()`, then `createStb`, ~162-168).
- `CharConfig.svelte` (~201-210): `currentChat?.note ?? ""` before `loadTokenize`, so an
  unloaded chat does not reach `tokenizeAccurate`'s `data.replace` (`tokenizer.ts`
  ~354-360).
- Test:
  - `pinnedChats.test.ts`: a pinned chat of a trashed character is left out.
  - A ModuleSettings test: a module without a name sorts without throwing.
  - `SideChatList.test.ts` (next to ~662-676): a chat dragged into a newly created folder
    lands there.
  - `MobileCharacters.test.ts`: border on the first visible row under a query.
  - A mount test for `prose-invert` on `light` and `dark`.
  - A CharConfig test: a character whose chat is not loaded shows no error alert.

## Slice 7. Lorebook editor fixes (_hard_, `characters-modules.md`)

- `LoreBookData.svelte` delete (~83-88, ~182-217):
  - Capture `currentChatRef()` before the first confirm. Deactivate in that chat by ref
    (`findChat` / `setChatMeta`, as the import path does in
    `src/ts/process/lorebook.svelte.ts` ~181-220), not in the chat selected after the
    awaits.
  - Remove the delete-time `onClose()` calls (~193-195, ~214-216).
    `LoreBookList.svelte` `removeEntry` (~515-520) owns the close bookkeeping.
- `LoreBookList.svelte`:
  - On an owner change (~106-118), clear `openedDetails` and `openedRefs`, and recreate
    Sortable once the new rows render (the gate is ~251-265).
  - Pass `externalLoreBooks` one way (~634), not `bind:`.
  - Show a "no matching entries" line when a filter is active and `visibleItems` is empty
    (~617-619, ~647-648, ~678-679), with a new key in `en.ts` and `ko.ts`.
- Out of this slice: the unreachable global lorebook page and `addLorebook(-1)` targeting
  the chat (see Not In This Plan).
- Test, in `LoreBookList.test.ts`:
  - A delete whose confirm resolves after a chat switch deactivates in the original chat
    only.
  - Deleting a closed row leaves drag enabled.
  - An owner switch with an open detail re-enables drag.
  - A zero-match query shows the line.
  - The external list mounted unbound produces no ownership warning.

## Slice 8. Alert keys over the composer and a rejected Escape (_hard_, `app-shell.md`)

Depends: 6 (`AlertComp.svelte`).

- `AlertComp.svelte`:
  - `btn` (~72, focused ~120-122) is never bound. Bind it to the dialog's primary action
    (~347-407), so a shown alert takes focus from the composer.
  - Check that the `hotkey.ts` text-field early return (~45-60) then no longer blocks the
    alert's Enter/Escape.
  - Keep the gate (`alertQueue.ts` `accepts` ~245-252): a key held when the dialog appears
    must not answer it.
- `hotkey.ts` (~283-327): close Settings on Escape only when no alert dialog remains, so a
  gate-rejected Escape leaves both open.
- Test:
  - `hotkey.test.ts`: a gate-rejected Escape with Settings open keeps Settings.
  - An alert shown while a textarea has focus answers Enter and Escape.
  - Rerun `e2e/terminalNotice.spec.ts` (not rerun since RisuNest A1).

## Slice 9. HypaV3 bulk resummary Cancel and selection (_small_, `memory.md`)

- `HypaV3Modal.svelte`:
  - Bulk resummary (~453-512) and retry (~543-590) assign `bulkResummaryState` after
    `await summarize` unconditionally. Add a generation token that `cancelBulkResummary`
    bumps, and drop a result whose token is stale.
  - When the sync effect (~99-105) replaces `hypaV3Data`, clear
    `bulkEditState.selectedSummaries` (D4), so an index `Set` (`types.ts` ~84-90) cannot
    check other rows.
- Test, in `HypaV3Modal.fence.test.ts`:
  - Cancel before a deferred summarize resolves leaves no result shown.
  - A copy replacement during a selection leaves no stale checkmarks.

## Slice 10. Streamed auto-translation translates once (_small_, `media-aux.md`)

Depends: 6 (`Chat.svelte`).

- `ChatBody.svelte`: the rendered translation branch (~241-285) runs, and sets its loading
  HTML, on every chunk update while a message streams in Off/Balanced modes (`Chat.svelte`
  ~662 enables raw streaming only for Strong).
- While the message is the streaming one, render the original. Translate once when
  streaming ends (D5).
- Test: a `ChatBody.svelte.test.ts` case with auto-translation on and three chunk updates
  makes one translation call, after the last.

## Slice 11. Locale text and stale docs (_small_, `settings-i18n.md`)

Runs last.

- `en.ts` ~1568: `chatFormating: "Chat Formatting"`. Keep the key, because
  `chatFormatSettingsData.ts:13` reads it.
- `de.ts` ~121-122, `es.ts` ~115-116, `vi.ts` ~113-114: replace the 0.125 s claim to match
  `en.ts` ~144-149. Off redraws per frame; Balanced matches Off but hides the edit and
  translation buttons; Strong renders raw until completion.
- `ko.ts`: translate the keys `en.ts` has and `ko.ts` lacks (D6). The list at `28e7fda88`
  has 59 keys, `characterGenerating` (~1512) among them. Regenerate it, since slice 7
  adds one.
- Memory task wording:
  - `shared/events.ts` ~41-44: drop the "not enabled yet" claim.
  - `memoryTasks.notEnabled` in `en.ts` (~1934) and `ko.ts` (~1813) becomes "Background
    summarization is unavailable on this server", with no "yet" or "아직". The 503 path
    remains for a server without the service (`server/src/routes/memoryTasks.ts` ~82-85).
- `docs/structure/chat-pipeline.md:192`: remove the Known Hazard. `:90` already describes
  the production service.
- Safe mode suppresses custom CSS and custom GUI HTML (`colorscheme.ts` ~373-377,
  `Chat.svelte` ~1888-1890). Say so in `STRUCTURE.md` ~147 and `ui-theming.md` ~145.
- `docs/research/pocketrisu-fix-crosscheck.md:41`: mark the preview hotkey row fixed. The
  hotkey shows only a returned body (`hotkey.ts` ~162-176).
- Test: none beyond `pnpm check`. Run the settings search test that covers the Chat
  Formatting page (`searchIndex.ts` ~295-305), if one exists.

## Slice 12. Stale slow test and test platform notes (_small_, `build-test-platforms.md`)

- `importPngCaps.test.ts:52`: expect `{ total: MAX_CHARX_ENTRIES, card: "x" }`, or
  whatever `planPngFile` returns for that fixture.
- `build-test-platforms.md`:
  - ~109: drop the tmpfs and "Vitest 5 s timeout" note. The production-size
    `resourcePatchParts` case is slow-tier only with an explicit 60 s timeout.
  - ~14: list `vitest.testNetwork.ts`, `vitest.testNetwork.test.ts` and
    `vitest.testNetwork.node.test.ts`.
- Test: `pnpm --silent test:agent --tags-filter=slow` passes `importPngCaps` on a clean
  tree.

## Decisions

The runner takes each default unless the user overrides it.

- D1. Sandbox RPC log (slice 1). Options: (a) remove both lines; (b) keep a redacted line
  (method name only) behind a dev flag. Default (a).
- D2. Google count abort (slice 3). Options: (a) a fixed timeout only (30 s); (b) also pass
  the caller's signal: add an optional `signal` to `TokenCounter.encode/count` and thread
  `p.controller.signal`, the translation's, the prompt context's, the memory host's, and
  Lua's into it with `AbortSignal.any`. Default (a). (b) touches every caller and suits its
  own slice.
- D3. Validator for non-hashed files (slice 4). Options: (a) `If-Modified-Since` from the
  existing `Last-Modified`; (b) a weak `ETag` from size and mtime, plus (a). Default (b).
- D4. HypaV3 selection on copy replacement (slice 9). Options: (a) clear it; (b) remap it by
  summary identity, dropping gone ones. Default (a): a sync during a selection is rare,
  and clearing it never checks the wrong row.
- D5. Streamed auto-translation (slice 10). Options: (a) the original while streaming, one
  translation at the end; (b) keep translating while streaming, debounced. Default (a).
- D6. Korean keys (slice 11). Options: (a) `characterGenerating` only; (b) every key
  missing from `ko.ts`. Default (b).

## Not In This Plan

- Toggle preset additions lost on a two-tab conflict: the 2026-10-23 static audit D3
  owns it, with a merge design: Static Audit Fixes slice 1 (`static-audit-fixes.md`).
- Stop in one chat ending another chat's job, and UI requests parented to another job's
  callback: fixed by Per-Chat Send slice 7 (`c9e6cde40`).
- Job status left after a job ends, `alertClear` clearing another job's status, and dialogs
  reading the selection late: these live in `jobChannel.ts` and the alert queue, next to
  Per-Chat Send slice 7. That slice has landed; they are still unplanned.
- `clearBootCache` on sign-out: there is no sign-out action or route
  (`src/ts/storage/serverAuth.ts`, `server/src/routes/auth.ts`). It belongs to whichever
  plan adds one.
- The unreachable global lorebook page and `addLorebook(-1)` appending to the chat's
  `localLore`: this needs a product decision on whether a global lorebook editor exists.
- Type-checking `util/` (`package.json:13` `check` covers `src`, `shared`, `server/src`
  only): the `.mjs` scripts would need `checkJs` and a cleanup pass.
- Already fixed, no work needed:
  - The Gemini post-tool retry backoff (`toolRetryDelay`, `google.ts` ~49-50).
  - CBS on `@@move_top` output (`regex.ts` ~192-193).
  - The `tikJS` parser lifetime (`tokenizer.ts` ~243-269).
  - The HypaV3 lines in `memory.md`.
- Chat list auto-scroll undoing a jump (`Chats.svelte` 700 ms scroll ignoring
  `suspendTrim`): not re-verified for this plan, and `Chats.svelte` changed in Per-Chat
  Send slice 3.

## Open Questions

- Should slice 1 also warn at server start when `server/ssl/certificate/` is inside a git
  work tree but not ignored? Not planned; raise it if the ignore fix is not enough.
