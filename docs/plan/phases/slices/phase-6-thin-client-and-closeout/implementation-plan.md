# Phase 6 implementation plan (Opus, final)

Written 2026-10-03 at `ee57e2e9` (Phase 5 closed at its Stop E). The steps that produced it:

1. A Luna re-baseline of every slice: twelve read-only workers at `xhigh`, one per slice, one for
   [`planning-notes.md`](planning-notes.md) (the counts and drift items), one for the Phase 5
   boundary.
2. A plan review of the draft by GPT-6-Astra (R1 to R16, an owner-question table, a validation
   table, and a file-by-file ownership ledger).
3. An evaluation of the draft and that review by the reviewer (its additions F-a to F-m).

Both reviews are kept verbatim in [`plan-review.md`](plan-review.md). The slice files in this
folder stay canonical for content; this file records how they are executed and the amendments to
them. Where this file and a slice disagree, this file wins until the slice is updated in the same
change as its implementation.

## Goal

Implement [`phase-6-thin-client-and-closeout.md`](../../phase-6-thin-client-and-closeout.md):

- the client holds per-screen records of server resources instead of the `DBState.db` aggregate;
- every write is an explicit mutation; the save loop's watchers and `saveDb` go;
- two clients of one server converge through a server change feed;
- the selected chat is loaded in full, other chats as summaries, and every reader of a
  non-selected chat loads it first;
- the guides and `STRUCTURE.md` describe the final architecture, and the plan leaves the tree.

## Baseline

The slices were drafted at `577c43ae`, before Phases 3 to 5. The re-baseline found the design
valid in outline: records under a forwarding facade, file-grouped reader moves, a refs-only feed
on the one upgrade dispatcher, summaries plus an LRU, snapshot builders, the archive. No slice is
executable unchanged. Each slice re-derives its Identifiers paragraph when it is implemented.

### Counts

Matching lines, tests excluded (`-g '!*.test.ts' -g '!**/tests/**'`), the `planning-notes.md`
commands:

| Row                                                     | Draft (`577c43ae`)  | Now (`ee57e2e9`)    |
| ------------------------------------------------------- | ------------------- | ------------------- |
| `DBState.db` lines / files (occurrences)                | 1,917 / 118 (2,161) | 1,745 / 123 (1,939) |
| `bind:` onto `DBState.db` in `src/lib`                  | 394 / 25            | 369 / 25            |
| Direct assignments, `src/lib` / `src/ts`                | 249 (31) / 53 (16)  | 227 (29) / 40 (12)  |
| `getDatabase(` lines / files                            | 224 / 55            | 150 / 43            |
| `selectedCharID` lines / files                          | 565 / 49            | 544 / 47            |
| Indexed selected-character sites                        | 417 / 21            | 417 / 21            |
| `.chatPage`                                             | 110 / 35            | 110 / 35            |
| `src/lib/Setting` + `src/ts/setting` `DBState.db` lines | 841 / 35            | 777 / 35            |

Top consumers now: `CharConfig.svelte` 265, `OtherBotSettings.svelte` 247, `BotSettings.svelte`
191, `DefaultChatScreen.svelte` 90, `OobaSettings.svelte` 56, `Chat.svelte` 50,
`PromptSettings.svelte` 50, `WelcomeRisu.svelte` 44, `collectionStore.svelte.ts` 34. The cutover
took `process/index.svelte.ts` from 87 to 0. The counts are textual (comments and API names
included).

### Substantive drift

- **Phase 5 left client readers the drafts call removed:**
  - the request layer, for the Plugin and WebLLM providers and the tab's own LLM requests:
    `request/request.ts`, `request/transport.ts`, `request/shared.ts`;
  - `serverGeneration.ts`, with the pre-send `lastInteraction` and `statics` writes;
  - `serverCommands.ts`;
  - `network/jobChannel.ts`, whose callbacks resolve characters and chats from the mirror;
  - `parser/transformClient.ts` and `plugins/apiV3/pluginContext.ts`;
  - the parser's CBS hosts: `parser.svelte.ts:1084`, `:1160`, `:1182`. `src/ts/cbs.ts` is a
    three-line re-export, and `shared/cbs/evaluator.ts:701` falls back to the host's
    `getDatabase`;
  - the translator and the tokenizer;
  - the browser memory helpers kept for the HypaV3 modal and the playground: `hypav3.ts`,
    `hypamemory*.ts`, `contextualEmbedding.ts`;
  - `alert.ts`, `regexFiles.ts`, `stringlize.ts`, `templates/jsonSchema.ts`,
    `templates/chatTemplate.ts`, `files/inlays.ts` (`supportsInlayImage`), and
    `mcp/risuaccess/host.ts`.

  [`plan-review.md`](plan-review.md) Appendix A assigns all 150 files to slices. F-h adds three
  more: `SavePopupIcon.svelte`, `gui/branches.ts`, and `files/multisend.ts`.

- **Names that do not exist:**
  - `readSetting`: Phase 4 dropped it, so plugin reads go through the mirror and forwarding;
  - `reloadPluginPermissions`: it is `loadPluginPermissions`;
  - `markChatStale`: the nearest is `markChatNoticed`;
  - `bumpReloadKey`;
  - `llmSecretPresets`: it is `llmSecretState` with `setSecret`, `clearSecret`,
    `copyPresetSecret`, `deleteEntrySecret`, and `setMaskedSecrets`;
  - `currentContext(pluginName)`: it is `currentContext(owner)`;
  - `bindTarget` in the settings registry;
  - `attachWebSocket` on `proxyStreamJobs`: the route exports `handleUpgrade`, and the app's
    dispatcher is `attachWebSocket`.
- **Phase 3 facts the drafts get wrong:**
  - there are thirteen collection kinds, not twelve: `statics` is one;
  - `characterOrder` is its own collection resource;
  - the remote collection path writes `items` and `selectedId` without calling
    `reconcileSelection()` (`applySettingsRecord`);
  - the preset and persona selection use `sessionStorage` and `localStorage`; the character
    selection is not stored at all (a reload starts at home, `bootstrap.ts:119`);
  - the plugin allowlist already includes `selectedPersona` and `characterOrder`, while the
    d.ts `DatabaseSubset` does not.
- **Phase 5 facts to build on:**
  - The newer-revision rule already exists (`applyHydration`, `hydrateChat`,
    `applyChatHydration`; `compareRevision` in `shared/resources.ts`). `applyHydration` covers
    chats, characters, and the collections, and leaves out `llmSecrets` and `authRefreshes`
    (`shared/jobs.ts` `HIDDEN_HYDRATION_KINDS`).
  - The dispatcher routes `/proxy-stream-jobs/<id>/ws`, which takes the raw password or a JWT,
    and `/api/generations/<id>/ws`, which takes a JWT only (`isAuthorizedToken`). JWTs live five
    minutes (`nodeStorage.ts:21`).
  - `chatChangeNotices.ts`, a same-browser `BroadcastChannel`, overlaps the feed.
  - `authRefreshes` is client-readable and written by server jobs (`server/src/mcp/jobTools.ts`).
  - `llmSecrets` is write-only: the masked status is `llmSecretState.masked`, and an omitted
    masked path keeps the stored value on write.
  - The server rejects a `characters` record that carries `chats`. The server CBS host and the
    shared registry read `chats` and `chatPage` (`server/src/jobs/cbsHost.ts:105`,
    `shared/cbs/registry.ts:125`).
  - `applyServerGeneration` writes only into a chat already in the mirror.
  - `toolCalls` is a chat field.
  - `jobScope.ts` freezes a job's configuration but re-reads its chat and characters as a live
    overlay.
- **The browser generation remnants.**
  - `checkpointAllGenerations` is still called by `flushResources` and the visibility path, and
    `unloadCheckpoint` by pagehide; `releaseGeneration` reaches `setStreamingState`. Nothing
    calls `beginGeneration`, `endGeneration`, `hasRunningGenerations`, or `setStreamingState`
    for a server stream.
  - The `streamingDisplayOptimizationMode` setting has therefore had no effect since the cutover
    (F-a, owner question 3).
  - Server-generation state is separate and stays: `serverGenerations`, holders, watermarks, and
    retired generations.
- **The send-time character deferral is live but wrong.** `bootstrap.ts` `watchGeneration` takes
  the selected character when `doingChat` starts. A server send may target another character
  (`serverGeneration.ts:46`), and the post-send dirty mark repeats the pre-send stamp (F-f).
- **`characterFormatUpdate` has seven non-pure steps:**
  - `ensureChat`, the chat for a chatless character;
  - the `postHistoryInstructions` transfer;
  - `creation_date ??= Date.now()`;
  - `updateLorebooks`;
  - `updateInlayScreen`;
  - the TTS migration;
  - the unconditional `lastInteraction` stamp (it ignores `changeChar`'s flag).

  It also sets `fmIndex`. `checkNewFormat` adds more character defaults (`bootstrap.ts:286-308`).

- **Client normalization is still at boot.** `setDatabase` still normalizes presets, personas,
  and modules. Boot still runs `checkNewFormat`, a second `setDatabase`, the trash pruning by
  `splice`, and `assignIds`.
- **Storage.** `forageStorage` → `NodeStorage` → `/api/read|write` is the asset and inlay path;
  `AutoStorage`, `keys`, and `removeItem` have no remaining role (F-b).
- **Closeout:**
  - `vite.config.ts` has no `proxy-stream-jobs` entry;
  - `server/src/tests/generations.test.ts:564` also drives the proxy route;
  - `HypaProcesser` has browser users beyond the three named: `files/multisend.ts`,
    `mcp/graphmem.ts`, and HypaV3;
  - `README.md` listed the proxy route (fixed in the plan commit).
- **Registry:**
  - there are four `getValue`/`setValue` item pairs, not eight;
  - `reasoningEffort` is a root alias of the preset's `reasonEffort`.

## Owner decisions (2026-10-03)

1. **The write-through record** (a property `set` on a record that synchronously calls its
   mutation function, which queues one write) is accepted as the explicit mutation of invariant 2
   if the spike's proofs pass, confirmed at Stop A with the evidence. If it is rejected, the
   fallback is explicit function bindings at every site, and slices 4 and 5 gain those `src/lib`
   files.
2. **Selecting a character no longer stamps `lastInteraction`;** a send still does (previews
   included, as today). The mobile list's recency means "last sent to".
3. **The streaming display optimization is rewired** to server streams in slice 3. The streaming
   state is set on a job's first chunk for its target message with the configured mode, and
   cleared at the job's end and at the final hydration release.
4. **Observers see a running reply at the 3 s checkpoints** through the feed, then the final text.
   There is no per-chunk observer stream.

Planner decisions, reported at the next stop:

- the generation remnants as slice 3 inside Phase 6 (scheduling only; Stop E placed them in this
  phase's closeout);
- `chatChangeNotices` removed once the feed passes the same-browser case;
- the deferral removed in slice 5;
- trash and order maintenance as client mutations at boot;
- the request oracles removed in slice 11, with the uncovered Responses cases retargeted to the
  server port;
- `selection.characterId` not persisted;
- the 9a/9b split, with the structural character writers in slice 5;
- the base revision captured at flush, behind the application fence (R15);
- the CBS host type narrowed (F-d), and an asset client replacing `forageStorage` (F-b).

## Order and stops

```
1  spike (test adapter writes it) ─┐
2  live updates ───────────────────┴─ Stop A (binding verdict; two-tab matrix on the flat mirror)
3  generation remnants (+ streaming state rewired)
4  settings ownership
5  character ownership (+ structural writers, mark callers, deferral, selection id)
   ─ Stop B (no persistence watchers, no mark helpers, no hydration echo; Docker smoke)
6  readers: settings pages
7  readers: settings consumers
8  readers: characters
9a chat records and readers, eager boot
9b summaries at boot, pins, LRU
   ─ Stop C (symbol allowlist re-measured; Docker smoke)
10 aggregate removal
11 closeout ─ Stop D (Docker two-client matrix)
```

- Dependencies:
  - 1 and 2 run in parallel;
  - 4 depends on 1;
  - 3 runs before 4 (both edit `chatStore.svelte.ts` and `resourceSync.svelte.ts`);
  - 6 and 7 depend on 4, and 8 depends on 5 and 7 (shared files);
  - 9a depends on 2 and 8, and 9b on 9a;
  - 10 depends on 9b, and 11 on 10.
  - 6 and 7 run one after the other.
- **Stop A:** the spike's verdict (owner decision 1) and the feed on the flat mirror.
- **Stop B:** settings and characters owned by records under the facade. No persistence `$effect`
  remains in `resourceSync.svelte.ts` or `bootstrap.ts`, and no mark helper remains. The facade
  covers structural writes. Hydration queues nothing.
- **Stop C:** every reader moved, except an explicit, measured allowlist left for slice 10 (the
  parser's CBS hosts, the snapshot consumers). Chats are lazy.
- **Stop D:** the closeout and the plan's removal.
- Between stops I report and continue. A review problem or a slice stopping condition is a stop.

## Workflow per slice

Approved at Phase 5 Stop E (2026-10-03): the Phase 3 to 5 exception carries over.

- **Tests.**
  - When a slice invalidates tests on purpose, a test adapter adapts exactly the tests I list,
    with assertion and harness changes listed separately. Then the reviewer reviews the diff and
    the adaptations and writes the new tests. I edit no tests.
  - Slice 1 is test code: I define the proofs and record the verdict, the test adapter writes the
    harness and the proofs, and the reviewer reviews them (the Phase 3 spike precedent).
- **Reviews.**
  - Every slice gets a reviewer.
  - An Astra challenge runs for 1 (scoped to the proofs and the verdict), 2, 4, 5, 9a, 9b, and 10.
  - It is skipped for 3, 6, 7, 8, and 11, unless the slice adds a mutation function or changes an
    async context, which escalates it to a challenge. For 8, the reviewer audits every index → id
    conversion across an await.
  - One Astra session per segment (A: 1-2; B: 3-5; C: 6-9b; D: 10-11). Astra's testing advice goes
    verbatim to the reviewer with my sort of it, and the reviewer judges again.
- **Commits.** One commit per slice, after its challenge (if any) and review.
- **Checks.**
  - Per slice: `pnpm check`, `pnpm test`, `pnpm format:check`, `pnpm build`, and `pnpm test:e2e`.
    Production-symbol gates exclude `*.test.ts` and `**/tests/**`.
  - Manual checks are Playwright scripts under `util/playwright/`, with `stack.mjs` and
    `offline.sh`, against a fresh server.
  - `e2e/idleReload.spec.ts` runs after every save-path slice (2, 4, 5, 9a, 9b, 10). The reload
    writing nothing (`:43`) never changes. The first-boot expectation (`:36`, the `modules` and
    `plugins` creates) changes deliberately only if a slice moves those defaults to the server.
- **Docker.** A smoke (open, edit, reload, two tabs) on a fresh volume at Stops B and C. The
  closeout runs the two-client matrix in the image. Slice 1 needs no Docker.
- **Docs move with the slices** (invariant 7, F-j). D4's dirty-mark instruction changes at slice
  5, and D1's read-only `character.chats` at 9a. Slice 11 does the full rewrite.

## Phase-file edits (in the plan commit)

The phase file gets:

- the counts above;
- the wrappers that exist, in place of `setCurrentChat`;
- an asset client in place of `NodeStorage`'s generic methods, `AutoStorage`, and `forageStorage`,
  with the auth helpers in their own module;
- the three Phase 5 leftovers, with the generation remnants as slice 3;
- the Phase 5 client readers under "Projections";
- the remaining watchers spelled out: the `supaMemory` write and `moduleUpdate` in
  `stores.svelte.ts`, the chat-fold effects, and `App.svelte`;
- the streaming display optimization;
- the archive convention.

`README.md` drops `/proxy-stream-jobs` from the dev server's forwarded routes.

## Amendments to the slices

### Slice 1 (`spike-projection-bindings`)

- It depends on Phase 5: the masked `llmSecrets` siblings and replacement through
  `applyHydration`.
- The counts come from the table above. The registry has four item pairs.
- The pattern covers client writers. Server job hosts (Lua, triggers, MCP) write through the
  server store and are out of its scope.
- Proofs added (R2, R15, Phase 3's recorded hazards):
  - `delete` of a key;
  - an own `__proto__` key in a user-keyed map (a JSON clone, not `$state.snapshot`);
  - the masked `llmSecrets` siblings, never serialized with a masked or plaintext credential;
  - the registry's item callbacks;
  - indexed replacement of a record and retained references after a replacement;
  - a replacement through `applyHydration` while a wrapper is cached, which queues nothing;
  - edit → remote notice → flush, an edit during its own acknowledgement, and edit → same-task
    selection switch;
  - a retained wrapper of an old preset that never redirects to the newly selected one.
- Character-array membership (`push`, `splice`, whole-array assignment) is not a facade proof: the
  structural writers move in slice 5 (R2).
- The base revision is captured at flush from `persisted`. The record identity is captured at the
  write. A dirty or in-flight record never has its base advanced by unsolicited hydration (R15).

### Slice 2 (`live-updates`)

- **Publisher (R8).**
  - The store accumulates changed refs in the outer write scope of `put`, `delete`,
    `applyChanges`, `transaction`, and `replaceAll`. That includes side effects: a character
    `put` creates its order, and a character `delete` removes its chats and order, so
    `server/src/data/chatStore.ts` joins the scope.
  - It drops them on rollback, collapses repeats to the final revision, and publishes once after
    commit, after `transactionState` is cleared.
  - Order revisions are nullable.
  - A listener failure never fails a committed write. `replaceAll` publishes the new epoch after
    it is installed.
- **Socket.** The socket rides `attachWebSocket`'s dispatcher with `isAuthorizedToken`. Every
  connection and reconnect gets a freshly signed JWT (R9). `beginShutdown` closes the feed
  sockets before `snapshots.stop()`. The dispatcher test (`generations.test.ts:564`) gains the
  events path.
- **Revision listing.** A store method, `GET /api/resources/revisions` (resource auth), the shared
  types, and a `resourceClient` function.
- **Client apply.**
  - `applyRemoteRecord` covers every kind. It compares the change set's revision with the held
    one on receipt and drops one that is not newer (F-e); it applies only on
    `compareRevision > 0`, never on a different `seq` alone (R6).
  - A `null` read applies a deletion only if the held revision is unchanged since the read was
    issued; otherwise it re-reads. There is no per-key serialization, replay log, or tombstone.
  - It rechecks at application time after `tick()`, with eligibility by a real unsent change (the
    text comparison at `resourceSync.svelte.ts:1798`). It adds no discard bookkeeping.
  - The pending set drains on acknowledgement, conflict, no-op cleanup, quarantine release, retry
    expiry, and job end. Entries at or below an acknowledged revision drop without a read.
  - New characters and chats go through a separate membership path, never through
    `acceptRemoteCollection`. A tab's unsent child-chat edits when another tab deletes the parent
    character are accepted behavior (deletion goes through trash; the server refuses the orphaned
    writes), recorded with no extra test.
- **Kinds.**
  - Collections call `reconcileSelection()` after replacement.
  - `authRefreshes` is in the dispatch.
  - `llmSecrets` reuses `adoptSecretRecord`. Its third branch, where a local sibling edit meets a
    remote sibling change, defers to the pending set instead of a notice. Credential caches are
    invalidated on any newer revision (R11). The broadcast never carries credential data.
  - Permissions use `loadPluginPermissions`; inlays get a targeted invalidation. Both carry
    stale-response protection.
- **Chats.**
  - The feed's chat path is `markChatNoticed` plus the idle refresh, which waits while a chat is
    generating.
  - The feed never removes a job socket event: equal-revision job metadata still goes through
    `hydrateChat`. The callback barrier is unchanged (R7).
- **`chatChangeNotices.ts`** is removed with its producer (`network/generationJobs.ts:368`) and
  its start-up (`resourceSync.svelte.ts:1986`) once the feed passes the same-browser case. Its
  tests move to feed-based equivalents.
- **Validation adds:**
  - both event orders at one revision for a job's chat;
  - an `authRefreshes` write by a server job reaching another tab;
  - two distinct credentials with the same hint;
  - a reconnect after more than five minutes;
  - grouped writes with an inner success then a conflict;
  - a cascaded deletion;
  - delayed deletion → recreation.

  The translator and HypaV3 `selectedId` values switch live in another tab (Phase 3 design,
  F-m); recorded so a tester does not report it.

### Slice 3 (`generation-remnants`, new)

- **Scope.**
  - `chatStore.svelte.ts`: `beginGeneration`, `checkpointGeneration`, `checkpointAllGenerations`,
    `endGeneration`, `hasRunningGenerations`, `generations`, `generationFinals`, the browser
    branch of `releaseGeneration`, and the generation branches of the write, conflict, unload,
    and recovery paths, plus `unloadCheckpoint`'s generation part.
  - `resourceSync.svelte.ts`: the checkpoint calls and the pagehide generation checkpoint.
  - The guides.
- **Kept:**
  - `serverGenerations`, holders, watermarks, retired generations, and job metadata revisions;
  - `applyServerGeneration` and the server lock refusal;
  - ordinary pagehide and unload work.
- **Streaming state rewired** (owner decision 3). `streamingState`, `isStreamingMessage`, and
  `setStreamingState` stay, driven by the server stream:
  - set on the first chunk of the job's target message with the configured mode;
  - cleared in `endServerJob` and on the final hydration release;
  - the message-id rewrite at `:2349` kept.

  The browser test checks that the `strong` mode renders raw while streaming and the others do
  not (today's `serverTransform.spec.ts:274` cannot tell them apart).

- **Not here:** the character deferral (slice 5).
- **Tests** (the adapter list, by symbol search, not line ranges):
  - every `chatStore.test.ts` case that calls `beginGeneration`, `endGeneration`, or
    `checkpointGeneration`;
  - `chatLock.svelte.test.ts:118`, `:140`;
  - the mixed cases in `resourceSyncNotices`, `characterStore.test.ts`, `resourceSyncHydration`,
    and `resourceSyncChats`, where the server-lock and ordinary assertions stay;
  - `plugins/apiV3/hostApi.test.ts:360/364` and `hostApiRouting.test.ts:461/471`: the lock goes
    through a server generation (a harness change, F-g).
- **Gate:** `rg -n 'beginGeneration|checkpointGeneration|generationFinals' src` is empty outside
  tests and history comments.

### Slice 4 (`settings-ownership`)

- **Records.**
  - Thirteen collections; `statics` is in the records, serialization, conflict reload, and tests.
  - There is no `readSetting`. Reads keep the facade until the reader slices, and the records sit
    behind the Phase 4 names (`updateSettings`, the collection setters).
- **`llmSecrets`.**
  - The readable siblings are record-backed through a sibling-only write.
  - Credentials stay on `llmSecretState` and `SecretInput`.
  - `customModels.<id>.key` and `presets.*.proxyKey` stay out of record serialization.
  - `vertexRegion` is a `providers` field.
- **Application paths.** Boot and `applySettingsRecord` write the records through a raw path that
  does not call `onWrite`. They keep the secret acknowledgement, the conflict rules, preset and
  persona resolution, and the secret cleanup and copy side effects.
- **Modules.**
  - Module normalization is a pure default helper used by `addModule` and the import paths.
  - The interactive lorebook repair moves to module import; its startup copy goes (alpha).
  - `normalize/modules.ts` replaces the generic `requireArrayOfObjects`.
- **`WelcomeRisu`** keeps today's one-argument `applyPresetTemplate(template)`.
- **Order.** `characterOrder.ts` is in scope for the order record.

### Slice 5 (`character-ownership`)

- **Selection.**
  - `selection.characterId` (`null` is home) lives in `selection.svelte.ts` and is excluded from
    its `save()` (F-c).
  - `selectedCharID` and `selIdState` become derived shims covering every `.set` and index read.
- **Structural writers** move here, because the facade cannot absorb character membership (R2):
  - `PlaygroundMenu.svelte:34`, `:44`;
  - `CharConfig.svelte:657`, `:764`;
  - `ModuleSettings.svelte:88`;
  - `DefaultChatScreen.svelte:1055`;
  - in `characters.ts`: `:37`, `:43`, `:182`, `:192`, `:213`, `:223`, and `removeChar`'s splice
    and array assignment;
  - the Svelte 3 self-assignments among them.

  The allowed files widen to these `src/lib` sites.

- **Dirty-mark callers** move here: `CharConfig.svelte:1005`, and `serverGeneration.ts:52-54`,
  which becomes `updateCharacter(chaId, { lastInteraction })`. `markCharactersDirty` and
  `markCharacterDirtyAt` go with their callers; there is no forwarding shim (R3).
- **The deferral** (`deferredCharacters`, `setGeneratingCharacter`, `watchGeneration`) is removed
  with its tests (F-f). The generation lock's edit refusals stay.
- **Normalization (R13).**
  - The deterministic defaults from `checkNewFormat` and `characterFormatUpdate` go into a shared
    pure helper. `addCharacter` uses it, and `normalize/characters.ts` uses it as the backstop,
    keeping the no-`chats` contract.
  - The time is set once at creation, never on reads.
  - The chat for a chatless character comes from `ensureChat`, and `fmIndex` from `createChat`.
  - The `postHistoryInstructions` transfer and the transforms that accepted card and module files
    need (`updateLorebooks` for lore v1; the TTS `none` mapping if old cards carry it) are import
    steps. They cover cards, module imports, plugin-created characters, and native creation.
  - The save-layout repairs are dropped (alpha): the `checkNewFormat` character block and
    `assignIds` once a settled current-schema fixture and the import cases write nothing.
  - `lastInteraction` is stamped only at send (owner decision 2).
- **`stores.svelte.ts`.** The `supaMemory` write moves into `selectCharacter`; `moduleUpdate`
  stays a render effect. `reloadKeys` stays a local render field.
- **Trash pruning and `checkCharOrder`** become client mutations at boot. The boot that prunes
  writes; a settled boot writes nothing, asserted separately.
- **Optional split (F-l).** If the diff grows past one review, split the normalization into 5b
  before Stop B. That is the planner's call at slice start; there is no new stop.

### Slices 6 and 7 (`readers-settings-pages`, `readers-settings-consumers`)

- Inventories are re-derived at slice start from the ledger (Appendix A plus F-h), with extended
  discovery: `DBState?.db`, imported accessor aliases, `getCurrentCharacter`, `getCurrentChat`,
  `getCharacterByIndex`, and the setters.
- **Pages.**
  - The collection map adds `globalscript`, `hotkeys`, `enabledModules`, and `statics`.
  - The type check accepts `PRESET_ROOT_ALIASES` and `FORWARDED_PRESET_KEYS`.
  - `SettingSegmented`, the conditions, `onChange`, and the item callbacks take the record
    context.
  - `SecretInput` stays the credential boundary.
  - `SettingsExportButtons` stays a snapshot consumer for slice 10.
  - The two page tests under `src/lib/Setting` that reference `DBState.db` are adapted in the
    review step.
- **Consumers** gain the settings reads of the Phase 5 residue:
  - `request/*`, `serverGeneration.ts` (`statics`), `serverCommands.ts`, `transformClient.ts`,
    `pluginContext.ts`, and `jobChannel.ts`;
  - the browser memory helpers;
  - `alert.ts`, `regexFiles.ts`, `stringlize.ts`, `jsonSchema.ts`, `chatTemplate.ts`, and
    `inlays.ts` `supportsInlayImage`;
  - `NanoGPTDashboard.svelte`, `PromptDiffModal.svelte`, and `process/prompt.ts`;
  - `SavePopupIcon.svelte`;
  - the settings reads in `CustomSidebar`, `Toggles`, and `SideChatList`;
  - the `CharConfig.svelte:1773` module push.

  `openrouter.ts` and `nanogpt.ts` need nothing. `claudeCachingExperimental` is dropped (Phase
  3). The translator's `edittrans` stays in the tab.

### Slice 8 (`readers-characters`)

- **Files added:**
  - `Chats.svelte`, `BookmarkList.svelte`, and `SideChatList.svelte` (their character reads);
  - `EmotionBox.svelte`, `ResizeBox.svelte`, and `util.ts` `getEmotion` together;
  - the parser's character reads (`parser.svelte.ts:470`, `:597`);
  - `request.ts:493`, `transport.ts:55`, and `tts.ts:89` (their current-character wrappers);
  - `serverGeneration.ts` and `jobChannel.ts` (character resolution by id);
  - `characterCards.ts`, which returns a `chaId` instead of an index or a length;
  - `util.ts` `findCharacterbyId` and its siblings;
  - `group.ts`, `modules.ts` `applyModule`, `gui/branches.ts`, and `mcp/risuaccess/host.ts`.
- Every selection or index use resolves to its id before an await. Plugin index APIs keep the
  creation-order mapping at their boundary.

### Slice 9a (`chat-projection-and-lazy-loading`, records and readers)

- **Chat records.** Full chats move to the chat module's owned map. Boot stays eager.
  - The client record type is chat-free (an `Omit` of `chats`, `chatPage`, and the render-only
    fields). The shared `character`/`groupChat` shapes keep `chats` and `chatPage` for the server
    CBS host, cards, and plugin snapshots (R12).
  - The new APIs: `loadChat`, `loadChats`, `ensureChatLoaded`, `readChatsDetached`, `pinChats`,
    `chatList`, and `selectedChat`.
  - The server summary read (`ChatSummary`, without messages, memory, bookmarks, or `toolCalls`)
    is added. Full and detached reads keep all of those.
- **Readers.** Every chat reader moves to the new APIs, including:
  - `jobChannel.ts` (the callback context before a selection change) and `mcp/mcp.ts` (tool
    records);
  - `transformClient.ts`, `serverCommands.ts`, `modules.ts`, and `stores.svelte.ts:183`;
  - `tokenizer.ts`, `command.ts`, and `request/transport.ts`;
  - `pluginContext.ts` (the bound persona, loaded first) and `mcp/risuaccess/host.ts`
    (`currentMessages`).
- **Detached reads.** A detached read for an export or a plugin snapshot flushes first and
  refuses on an unresolved or discarded save (the `jobChannel.ts:383` barrier pattern).
- **Unchanged.** The server MCP host (`server/src/mcp/internal.ts`) reads the server store.

### Slice 9b (`chat-projection-and-lazy-loading`, lazy)

- **Boot.** It reads summaries and orders. Selection is asynchronous, with a selection-request id,
  so a slow load of A never selects A after B.
- **Pins.**
  - A job's target chat is ensured and pinned before its job starts and released in `finally`.
    This covers sends, continues, buttons, triggers, and callbacks, including refusals, aborts,
    reconnects, and terminal hydration.
  - `applyServerGeneration` never drops an update for an unloaded target.
- **Eviction.** Eviction (8 per tab) never evicts a selected, dirty, in-flight, quarantined,
  generating, or pinned chat. Stale summaries refresh from the feed.

### Slice 10 (`aggregate-removal`)

- **Allowlist.** It is recomputed at slice start and does not authorize new reader architecture.
- **CBS host (F-d, R14).**
  - `CbsHost.getDatabase` and `CbsParseArg.db` (`shared/cbs/types.ts:21`, `:66`) narrow to a
    `Pick<Database, ...>` of the fields shared CBS reads, plus a character lookup. The fields are
    `aiModel`, `subModel`, `maxContext`, `promptTemplate`, `mainPrompt`, `jailbreak`,
    `jailbreakToggle`, `globalNote`, `language`, and `characters`.
  - The server's job `db` satisfies it unchanged, and the parser's hosts read those fields from
    the records. The shared fallback stays.
- **Boot.** Boot normalization is already gone after slices 4 and 5. `setDatabase` goes with
  `assignIds`.
- **`templateCheck`** lives in `shared/prompt/templateCheck.ts`; the caller passes the selected
  preset's `promptTemplate`.
- **Plugin `getDatabase`** stays asynchronous over `buildDatabaseSubset`, with detached chat
  reads. The d.ts `DatabaseSubset` gains `selectedPersona` and `characterOrder` to match the
  runtime (a declaration fix).
- **Snapshot builders.** The settings report keeps its keys and redaction, including the aliases
  and per-tab selection; the builders clone with JSON for user-keyed maps.
- **Storage (F-b).**
  - An asset client (`readAsset`/`writeAsset` over the same routes) replaces `forageStorage` at
    `globalApi`, `inlays`, `characterCards`, and `modules`.
  - `AutoStorage`, `keys`, and `removeItem` go.
  - `authFetch` and `getNodeServerProxyAuth` move to an auth module, with every importer updated
    (`resourceClient.ts`, `transformClient.ts`, `inlays.ts`, `globalApi.svelte.ts`, `auxFetch.ts`,
    `generationJobs.ts`, `request/transport.ts`, `eventFeed.ts`).
  - The server routes stay.
- **e2e adaptation.** The five e2e specs that touch the aggregate (`idleReload:48`,
  `presetSelection:21`, `personaBinding:30`, `serverTransform:285`, `transformGolden:102`) are
  adapted here; they work through the facade until then.
- **Facade-specific tests.** `database.setDatabase.test.ts` and the facade-specific forwarding
  tests are retired or moved to the records. `autoStorage.test.ts` is retired, and
  `nodeStorage.test.ts` splits into auth and asset tests.
- **Gates** distinguish an injected CBS host method from the deleted accessor.

### Slice 11 (`closeout-and-docs`)

- **`proxyStreamJobs`.** The route, its test, the proxy half of `generations.test.ts:564`, and the
  app registration, GC, dispose, and dispatcher branch go. There is no `vite.config.ts` change,
  and the `/proxy2` local-network policy stays.
- **Request oracles.** The test adapter maps each `requests.responses.test.ts` case to a server
  test and retargets the uncovered ones to the server port in `server/src/llm/`. Then the
  oracles and `serverParity.test.ts`'s differential part are deleted. `memoryOracle.test.ts` is
  out of scope (the HypaV3 browser code stays).
- **Browser caches.** The user list gains `files/multisend.ts`, `mcp/graphmem.ts`, and HypaV3.
- **Measurements.** The transform's Lua cost is measured as the slice specifies. The asset hang
  and the duplicate render stay out (Stop D/E decisions).
- **Docs and archive.**
  - The guide counts and `STRUCTURE.md` anchors are regenerated at slice start.
  - Lasting behavior notes and validation gaps move into the guides' Known Hazards before the plan
    is removed.
  - The final record is in the closeout commit.

## Plan review decisions

The draft's points, Astra's, and the reviewer's verdict on each. I adopted the reviewer's
calibration wherever it offered a smaller fix.

- **R1 (slice 3's boundary):** adopted with changes. The adapter list is built by symbol search,
  F-g's plugin files are added, and the deferral moves to slice 5. Removing the streaming branch
  is replaced by owner decision 3 (rewire).
- **R2 (structural writers):** adopted. The writers move to slice 5. The membership facade proofs
  are dropped; indexed replacement, retained references, and zero-queue hydration are kept.
- **R3 (mark callers):** adopted with the reviewer's smaller fix: the two callers move to slice 5,
  with no forwarding shim.
- **R4 (9a/9b):** adopted, with the selection-request id and pin-before-load.
- **R5 (four stops, exit evidence):** adopted.
- **Ownership ledger:** adopted as the starting inventory, plus F-h's three files and extended
  discovery, regenerated at each reader slice.
- **R6 (revision rule):** adopted as `compareRevision > 0` with the receipt comparison (F-e) and
  one deletion guard.
  - Rejected: per-key serialization with an invalidation generation (the batch and the guard
    cover a two-tab app; a same-id recreation needs a restore, which changes the epoch).
- **R7 (job metadata):** adopted in its smaller form. The existing hydration already keeps job
  metadata, so the plan states that the feed never removes a job event, and tests both orders.
- **R8 (publisher accumulator):** adopted.
- **R9 (fresh JWT):** adopted, with the extra auth importers in slice 10.
- **R10 (pending lifecycle):** adopted, except one part.
  - Rejected: protecting a tab's unsent child-chat edits when another tab deletes the parent
    character. It is user-initiated deletion through trash, and the server refuses the orphans;
    it is recorded as accepted behavior.
- **R11 (`llmSecrets` adoption):** adopted with the deferral of conflicting siblings; the
  same-hint test is kept.
- **R12 (chat-free client type):** adopted.
- **R13 (normalization):** adopted with the alpha calibration. Save-layout repairs are dropped,
  not relocated, and only the transforms accepted files need are kept.
- **R14 (CBS host, snapshots):** adopted, and made compiler-enforced (F-d).
- **R15 (flush-time capture with a fence):** adopted, with its three proofs in the spike.
- **R16 (small corrections):** adopted. In 5, the selection stays unpersisted (F-c), so the
  "another tab's selection" concern does not arise. In 6/7, `CharConfig.svelte:1773` belongs to
  slice 7.
- **Owner-question table:**
  - questions 1 and 5 asked (decisions 4 and 2);
  - questions 2, 3, 4, and 6 became planner decisions;
  - question 7 became a planner decision with the reviewer's mapping rule;
  - the write-through verdict was asked (decision 1).
- **Validation table and corrections:** adopted. There is no Docker for the spike; the idle-reload
  rule and the five e2e adaptations are as above.
- **Review cadence:** adopted as the reviewer's list. A challenge is skipped for 3, 6, 7, 8, and
  11 under the stated conditions.
- **The draft's errors the reviewer found:**
  - the deferral's justification is corrected (F-f);
  - `forageStorage` is kept as the asset path (F-b);
  - the character selection stays unpersisted (F-c);
  - the "five mixed files" list is replaced by a symbol search;
  - the oracle question is reframed (the Responses file has no server half).
- **F-a to F-m:** all adopted; F-a became owner decision 3, F-k is in the plan commit, and F-l is
  the planner's call at slice 5.

### Testing advice

Astra's validation table, its corrections, and the reviewer's verdicts on them
([`plan-review.md`](plan-review.md)): I judge them necessary as a whole. They go verbatim to each
slice's reviewer with this plan's amendments, and the reviewer judges again.

## Checks

- **Per slice:** the five gates, the slice's validation as amended, its Playwright checks against
  a fresh server, and the reviewer's tests.
- **After every save-path slice:** the idle-reload spec.
- **Stop A:** the two-tab matrix on the flat mirror.
- **Stops B and C:** the Docker smoke on a fresh volume.
- **Stops C and D:** the counts re-measured.
- **Stop D:** the closeout criteria walked one by one, and the Docker two-client matrix
  (including restart and snapshot restore).
