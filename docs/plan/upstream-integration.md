# Upstream Integration Plan

Status: drafted 2026-10-23 at `79ae26cc4` as an intake process with a seeded backlog (A–N),
imported at `832caccf0`, and rewritten into slices on 2026-10-23 at `d5e4b07a5`. All 23 slices landed on `metatron` through the Combined Run index (`docs/plan/combined-run.md`, plan-runner) between 2026-10-23 and 2026-10-24, one cherry-picked commit each: UP1 (`ffc4d03aa`), UP2 (`3c80346dc`), UP3 (`43bb3c63d`), UP4 (`128e6949c`), UP5 (`052b6cad9`), UP6 (`717a371f5`), UP7 (`e555f2f0c`), UP8 (`15ea7614f`), UP9 (`4b9d23ada`), UP10 (`5909b8dfc`), UP11 (`9bd9501b6`), UP12 (`e4ea7c5a3`), UP13 (`385cc8da0`), UP14 (`39f94aaff`), UP15 (`3a9404635`), UP16 (`2285021da`), UP17 (`9d85d9b8f`), UP18 (`1bb7c82a3`), UP19 (`0d0927d7c`), UP20 (`eb44b166c`), UP21 (`695a13dc0`), UP22 (`15503de1f`), UP23 (`513808713`). The run's final checks on `b60d8fff5` passed. Every claim was checked at `d5e4b07a5` against the upstream checkout
`/home/codex/Risuai` at `f50b5942` by two Luna fan-outs (8 + 3 workers), which also assigned all
79 upstream non-merge commits to a disposition (Inventory, below). The session re-read the
block-save refusal, the lore flag declarations and their test pin, the three Gemini
`role: "function"` sites, the CBS prefill callback, the Wasmoon engine options, the lite
plugin setter and its test, the `SafeElement` registrations, and the keep-alive audio. Line
numbers are approximate; the identifiers are the anchors. Re-verify each cited location before
editing. Upstream paths are relative to `/home/codex/Risuai`.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

Upstream rules for every slice:

- Port behavior, not code. Metatron's generation, lore, memory, Lua, and plugin storage run on
  the server, and its records are resources with ids, so a clean patch apply proves nothing.
  Read the final upstream state, not only the first commit of a series: a later commit may
  correct or remove it.
- Commit with a conventional title and one `Upstream-Commit: <full sha>` trailer per upstream
  commit ported. `git cherry-pick -x` only for a small change that applies to the same
  architecture; never a range or a merge.
- Never copy upstream `package.json`, lockfiles, version numbers, or the old `server/node/`
  directory. Persisted enums and discriminators keep Metatron's values; a new model flag takes
  the next free number in `shared/llm.ts` (upstream's number may collide).
- A new regression test fails without the change. Mock I/O and process boundaries, not the
  code under test. Never use private saves or live provider keys.

## Problem

Upstream RisuAI moved on since the fork. At `f50b5942` there are 133 upstream-only commits from
the common ancestor `25001174` (79 non-merge, 54 merges, 41 first-parent entries, 86 files
changed). Metatron has 647 own commits in the same range. No upstream commit is
patch-equivalent to a Metatron one, but many are semantically present or touch code Metatron
removed. Nothing records which is which, so every survey starts over.

What matters for Metatron, by effect:

- Current upstream backups cannot be imported. Upstream `dae3f650` writes full and partial
  backups with `encodeRisuSave` (`src/ts/drive/backuplocal.ts` ~163–176, ~383–388): a
  `RISUSAVE\0` block save (`src/ts/storage/risuSave.ts` ~34–37, ~114–405, ~737–746) whose
  result is `{ database, kv }`. Metatron's `decodeUpstreamDatabase`
  (`server/src/data/upstream/risuSave.ts` ~145–151) refuses it with "RisuAI block save
  (RISUSAVE), which only live saves use"; that assumption is stale.
- Plugin storage in current backups is lost. Upstream `68b5d032` keeps only
  `pluginCustomStorage._coldpluginIndex`, which points at an index cold record
  (`src/ts/process/pluginStorageStore.ts` ~4–18, ~62–71); large values are separate
  `coldstorage_<uuid>.json` records. Metatron's archive classifier (`readColdRecord`,
  `server/src/data/upstream/archive.ts` ~161–180) accepts only character or message payloads,
  so those records become `invalidPayload`, and `convertPluginStorage`
  (`importCollections.ts` ~236–333) knows inline values and `_coldplugin` only.
- Three plugin boundary gaps (plugins run third-party code):
  - The guest bridge (`src/ts/plugins/apiV3/factory.ts` `GUEST_BRIDGE_SCRIPT` ~283–300) reads
    any `message` without checking `event.source` (upstream `49d08fda`). The host side checks
    its iframe (~918–920).
  - `setDatabaseLite` (`v3.svelte.ts` ~1247–1251) passes `plugins` through `applyPluginKey`
    (~1177–1184) to `setPlugins`, replacing the installed list without a prompt (upstream
    `de29b064`, `8effde3a`, `9d95cb20`). `hostApiRouting.test.ts` ~348–354 pins that.
  - `SafeElement` registers every listener on `document` (`v3.svelte.ts` ~333–411, delayed
    keyboard ~413–435, removal ~441–448, reload teardown ~2369–2372), so an element's listener
    hears its siblings' events (upstream `f76fb63a`, `c22c3d73`, `9d21f229`).
- Chat correctness:
  - Lore keep/don't-activate "seen" flags are function-wide (`shared/lore/activation.ts`
    ~265–266, latched ~340–360, written ~602–613): after one keep entry every later active
    entry also writes `__internal_ka_`. Upstream `9badb4c1` makes them per entry.
  - HypaV3 contextual (Voyage context) vectors: repeated text at one position collides in the
    cache, keys have no version, and a partial cache hit embeds a group reordered but saves it
    under the original order's keys (`server/src/prompt/embeddings.ts` ~725–825). Upstream
    `b63119ad`, `2787e06c`, `7df07966`.
  - Gemini tool responses still send `role: "function"` (`server/src/llm/google.ts` ~236,
    ~840, ~1173), which upstream `d900d6bd` removed.
  - CBS `prefillsupported` answers from the model name (`shared/cbs/registry.ts` ~1467,
    `db.aiModel.startsWith("claude")`), so adaptive-only Claude models without `hasPrefill`
    answer yes (upstream `4a95bf2b`).
  - Missing catalog and thinking changes: Claude 5 Opus and its thinking-on-by-default flag
    (`c8a37b75`), budget thinking treated as adaptive on adaptive-only models (`37d96e34`),
    three Gemini entries (`b32610c6`).
- Lua features cards written for upstream use: axLLM mode (`baac5410`), form submission
  (`7ac7a204`, `be431696`, `536a2514`), NovelAI orientation (`1dbdede5`), and Wasmoon
  `enableProxy: false` (`63399cbd`).
- Smaller UI and collection gaps: Safari select clipping, card export with a missing portrait,
  a module created twice, Realm creator blocking, a parse error's stack, keep-alive audio Chrome
  ignores.

## Approach

Each gap above becomes one slice. Commits that Metatron already covers or that touch removed
code are recorded in the Inventory with their evidence, so they are not reopened. The last
slice turns the Inventory into a lasting ledger with the intake procedure for the next upstream
scan, then this plan is archived.

Baseline:

| Reference             | Value                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| Upstream checkout     | `/home/codex/Risuai`, `main`, `f50b5942ec6aa59aa3c56049ac687ca09667fec7`         |
| Common ancestor       | `25001174e0452e3b9d16aee459ce9d2444c197d7`                                       |
| Metatron head checked | `d5e4b07a5`                                                                      |
| Save harness pin      | `669b12ceabe1c5066d3dadbe0973f2188d10cc97` (`util/upstream/upstreamHarness.mjs`) |

The reference is the local upstream checkout, not the latest GitHub state. Updating it is part
of the next intake (slice 23), not of these slices.

Coordination with other active plans (same files; whichever lands second rebases):

- Slice 4 and [Small Fixes](small-fixes.md) slice 1 both edit `factory.ts`.
- Slice 7 and [Server Tokenizer](server-tokenizer.md) both edit `shared/lore/activation.ts`
  (its count step ~584–600 is next to the flag writes ~602–613).
- Slice 8 and [Static Audit Fixes](static-audit-fixes.md) slice 10 both edit
  `server/src/prompt/embeddings.ts`.
- Slice 3 checks the upstream export; Static Audit Fixes slice 9 moves that export into a
  worker without changing its bytes. Either order works.
- Slice 15 and Static Audit Fixes slices 7 and 11 edit `src/ts/process/stableDiff.ts`
  (`generateAIImage`, ~87–92) and the Lua image callback in `src/ts/network/jobChannel.ts`
  (~658–696).
- Slices 15 and 16 and [Generation Stage Spinner](generation-stage-spinner.md) slice 1 edit
  `shared/jobs.ts` (different unions).
- Slice 16 edits `src/lib/ChatScreens/Chat.svelte`, which Small Fixes slices 6, 10 and 11,
  [Direct Asset URLs](direct-asset-urls.md) slice 4, and [Server Thumbnails](server-thumbnails.md)
  slice 4 also edit, and the sanitizer in `src/ts/parser/parser.svelte.ts`, which Direct Asset
  URLs slice 5 edits.
- Slice 17 and Server Tokenizer slice 3 edit `src/lib/Others/PopupEditor.svelte`.
- Slice 19 and Small Fixes slice 6 edit `ModuleSettings.svelte`.
- Slice 21, Small Fixes slice 10, and Direct Asset URLs slice 4 edit `ChatBody.svelte`.
- Slice 22 and [Chat Checkpoints](chat-checkpoints.md) slice 5 edit `src/App.svelte`.

A slice that lands second keeps to its own lines of the shared file and rebases onto the
first. In a combined run, two such slices never run in one wave.

## Order

Five chains. Chains run in parallel; within a chain, arrows are file or result dependencies.

- Backups: 1 → 2. Slice 3 is independent.
- Plugins: 4; 5 → 6 (both edit `v3.svelte.ts`).
- Chat correctness: 7, 8, 9, 10, 11, 12 are independent of each other.
- Lua: 13; 14 → 15 → 16, and 16 after 13 (`runtime.ts`).
- UI and collections: 17, 19, 21, 22 independent; 18 → 20 (both edit `characterCards.ts`),
  and 20 after 1 (both edit `importDatabase.ts`).
- Close-out: 23 after every other slice landed or was dropped by a decision.

Priority when slots are short: 1, 2, 4, 5, 6 first (data and permission boundaries), then
7–12, then the rest.

## Slice 1. Current upstream block saves import (_hard_, `backup-sync-hub.md`)

- `server/src/data/upstream/risuSave.ts`:
  - Detect `RISUSAVE\0` (9 bytes, no leading zero) as its own format and decode it in
    `decodeUpstreamDatabase` (~142–177) instead of refusing it (~147–151). Keep the raw, gzip,
    and stream-gzip readers (~64–80, ~109–163) unchanged.
  - Block layout (upstream `risuSave.ts` ~373–405, decoder ~455–657): 1-byte type, 1-byte
    compression flag, 1-byte name length, name, 4-byte length (native endian, written from a
    `Uint32Array`: little endian on every upstream platform), data. Flag 1 is an independent
    gzip per block. Types 0–12 (~79–96); `REMOTE` = 6, `PLUGIN_STORAGE` = 11, `KV` = 12.
  - Bounds: every length checked against the remaining bytes before reading; each gunzip
    through the existing `maxOutputLength` path; the decoded total under `maxDecodedBytes`;
    the existing worker heap cap (`importRunner.ts` ~14–24) unchanged.
  - A `REMOTE` block refuses the import with a named error: `encodeRisuSave` writes none
    (~734–746), so one means a live save, whose remote files are not in the archive. Never
    resolve a remote path.
  - Return `{ database, kv }`. Legacy formats return `kv: {}`, as upstream does (~671–683).
- `kv`: upstream code at `f50b5942` writes no namespace (`src/ts/storage/saveKV.ts` ~81–116;
  no `set` caller), and Metatron has no owner for it. A non-empty `kv` follows D1.
- `PLUGIN_STORAGE` blocks: carry their payload to the converter as `pluginCustomStorage`
  (upstream decoder ~585–590 shows where it lands); slice 2 resolves its index.
- The import worker (`importWorker.ts` ~29–48) and the converter call
  (`importDatabase.ts`) take the new result shape. The route's classification and report
  wording stay.
- `backup-sync-hub.md` and `persistence.md` (the upstream compatibility stance): block saves
  are imported; live saves with remote blocks are refused.
- Test, in `server/src/tests/upstreamRisuSave.test.ts`:
  - A synthetic block save built by a test encoder that follows upstream's layout (database,
    a character block, an uncompressed and a gzip block) decodes to the same database as its
    legacy encoding.
  - Replace the block refusal case (~96–103) with refusals for: a truncated block, a length
    past the end, a gzip block over the decoded cap, a `REMOTE` block, an unknown type.
  - `upstreamImportRoute.test.ts` (~193–298): prepare and commit of a block-save archive keep
    characters, messages, ids, and assets; a refused one leaves the live data untouched.
  - `upstreamImportWorker.test.ts` (~85–166): the worker decodes a block save under the heap
    cap.

## Slice 2. Upstream plugin storage index imports (_hard_, `backup-sync-hub.md`)

Depends: 1.

- Upstream layout (`src/ts/process/pluginStorageStore.ts`): `_coldpluginIndex` holds the id
  of one cold record of shape
  `{ type: "risu-plugin-storage-index", version: 1, entries: [{ k, s?, l? }], trash: [...] }`
  (~62–71). `s` is inline JSON text; `l` is the id of a cold record holding a large value
  (thresholds ~52–60). Large records are written before `database.risudat`
  (`backuplocal.ts` ~156–176) as `coldstorage_<uuid>.json` (`coldstorageData.ts` ~6–13).
  Note: `cad8595a` (before the ancestor) added `_coldplugin`; `855d9d45` fixed its map;
  `f7102947` only moved upstream's migration before plugin loading.
- `server/src/data/upstream/archive.ts`: classify plugin storage records (the index object and
  large values of any JSON type) as their own kind instead of `invalidPayload` (~161–180).
  Keep the per-record cap (~21–22).
- `server/src/data/upstream/importCollections.ts` `convertPluginStorage` (~236–333): resolve
  `_coldpluginIndex` through the index record into Metatron's `pluginStorage` resource
  (`server/src/data/kinds.ts` ~149–154): `s` parsed, `l` read from its record, `trash`
  dropped. Inline values and `_coldplugin` keep working. Do not port upstream's browser
  storage engine.
- Missing, malformed, duplicate, or oversized index entries are listed in the import report by
  key and the rest imports; a missing index record reports every key as lost. The commit is
  still all-or-nothing, so plugins never run against a half-restored store.
- `backup-sync-hub.md`: the plugin storage forms an upstream import reads.
- Test, in `server/src/tests/upstreamImportCharacters.test.ts` (inline/`_coldplugin` cases
  ~488–500, ~678–700, ~830–864) and `upstreamArchive.test.ts` (~60–181):
  - An index with an inline value, an empty value, and a large value restores all three.
  - A missing large record, a malformed index, and a duplicate key each appear in the report.
  - A legacy inline and a `_coldplugin` backup still restore as before.
  - Route level: a block-save archive with an index restores plugin values after commit.

## Slice 3. The save harness gains the current upstream target (_small_, `build-test-platforms.md`)

- `util/upstream/upstreamHarness.mjs` and `checkBinCompat.mjs` pin `669b12ce` and need its
  `msgpackr` 1.10.1 and `fflate` 0.8.2. Make the target a parameter: a legacy target
  (`669b12ce`, as today) and a current target (`f50b5942`), each with its sha, package
  versions, decoder return shape (`{ database, kv }` for current), and its own approved stubs.
- The current target also runs upstream's plugin storage migration on the decoded database
  (`src/ts/process/pluginStorageStore.ts` ~224–317, wired before plugin load at
  `src/ts/bootstrap.ts` ~200–213), so a Metatron export's inline plugin values are checked to
  survive it.
- New stubs for the current target are listed one by one; never approve a whole module to make
  a run pass.
- Metatron's export stays the legacy format, which current upstream still reads (block-save
  export is Not In This Plan).
- `build-test-platforms.md` (the harness section): two targets, how to run each, what neither
  covers (upstream's backup reader, asset writes, plugin loading, UI).
- Test: run both targets on a synthetic Metatron export with a plugin value; record the result
  in the commit message. The script stays outside `pnpm test`.

## Slice 4. The guest bridge accepts only its parent's messages (_small_, `plugins-mcp.md`)

- `src/ts/plugins/apiV3/factory.ts` `GUEST_BRIDGE_SCRIPT` (~283–300): return early when
  `event.source !== window.parent`, before reading `event.data` (upstream `49d08fda`).
- Coordinate with Small Fixes slice 1 (same file).
- `plugins-mcp.md`: both sides of the bridge check the message source.
- Test, in `src/ts/plugins/apiV3/guestBridge.test.ts` (harness ~63–89 sends no source):
  - The harness sends `source: window.parent` for the bridge's own messages.
  - A message from another source is ignored: no RPC reply, no port adopted.

## Slice 5. The lite setter cannot change the plugin list (_small_, `plugins-mcp.md`)

- `src/ts/plugins/apiV3/v3.svelte.ts` `setPluginDatabaseLite` (~1247–1251): drop `plugins`
  before `applyPluginDatabase` (upstream `de29b064`, `9d95cb20`; `8effde3a` only avoids a
  production comparison). The full setter's approval path (~1253–1271) is unchanged.
- `src/ts/plugins/apiV3/risuai.d.ts`: `setDatabaseLite` takes `Omit<DatabaseSubset, "plugins">`
  (~1541–1549).
- Same-name approved updates (upstream `72d2bacd`, `ae54b830`) are already in place
  (`plugins.svelte.ts` ~642–663, `collectionStore.svelte.ts` `upsertPlugin` ~379–394) but have
  no direct test; add it here.
- `plugins-mcp.md`: the lite setter ignores `plugins`.
- Test, in `src/ts/plugins/apiV3/hostApiRouting.test.ts`:
  - Replace the case that expects lite replacement (~348–354): the installed list is unchanged,
    no prompt, and the other fields of the same call still apply.
  - Beside ~743–782: an approved same-name update replaces the entry in place (same index, new
    script); a denied one keeps the old entry.

## Slice 6. SafeElement listeners attach to their element (_hard_, `plugins-mcp.md`)

Depends: 5 (same file).

- `src/ts/plugins/apiV3/v3.svelte.ts`:
  - Each registration (`documentEventListeners`, ~145–146) records its `EventTarget`.
  - `addEventListener` (~333–411) and the delayed keyboard path (~413–435) register on the
    wrapped element; removal (~441–448) and reload teardown (~2369–2372) use the recorded
    target, type, and options.
  - A `SafeElement` wrapping the document keeps registering on `document`.
  - Keep the terminal-notice gate and the unload cleanup as they are.
- Port upstream `c22c3d73`'s behavior and `f76fb63a`'s target field; `9d21f229` is docs only.
- `plugins-mcp.md` and the API 3.0 docs in `risuai.d.ts`: listeners are element-scoped.
- Test, in `src/ts/plugins/apiV3/hostApi.test.ts` (today only a document case, ~692–737):
  - A listener on one element does not receive a sibling's event; a non-bubbling event reaches
    its own element.
  - Removal and reload teardown leave no listener behind (count the target's listeners).
  - The existing document key listener and terminal-notice cases still pass.

## Slice 7. Lore keep and don't-activate flags are per entry (_small_, `chat-pipeline.md`)

- `shared/lore/activation.ts`: move `keepActivateAfterMatch` and `dontActivateAfterMatch`
  (~265–266) into the entry loop, so the decorator latches (~340–360) and the writes (~602–613)
  see only their own entry (upstream `9badb4c1`; the writes are unchanged). This follows D2.
- Coordinate with Server Tokenizer (same file, ~584–600).
- `chat-pipeline.md` (lore): the flags are per entry.
- Test, in `server/src/tests/lore.test.ts`:
  - Rewrite the inherited pin (~414–431): the `dont` entry no longer gets the keep entry's
    `__internal_ka_` write; the kept entry still activates on the second run.
  - Three entries (keep, plain, dont) in prompt order: only each entry's own flag is written.
  - The regex activation order case (~812–849) still passes.

## Slice 8. HypaV3 contextual vectors keep their identity (_hard_, `memory.md`)

- `server/src/prompt/embeddings.ts` (`HypaProcessorV2`):
  - Contextual keys add the chunk's position in its group and a key version (D3), so the same
    text at two positions or in two groups never shares a vector (upstream `2787e06c`,
    `contextualEmbeddingCache.ts` ~10–25). Today's key: `content|model[suffix]|ctx:<hash>`
    (~331–334, ~953–974).
  - A partial cache hit embeds each affected group in its original order (~741–825), not
    misses first with the cached members appended.
  - After each group call, check that the result count equals the group length (~810–816);
    a mismatch fails the memory step with a named error instead of saving shifted vectors
    (upstream `b63119ad`). The provider-level checks (~191–209, ~291–300) stay.
  - Map results to chunks by identity, not by text (upstream `hypav3.ts` ~1973–2042).
- The cache (`save/data/vectors.sqlite`, `vectorCache.ts`) is a cache: old keys simply miss.
- The browser copies (`src/ts/process/memory/hypamemoryv2.ts`, `hypav3.ts`) are not changed:
  their embedding path does not run in production (the HypaV3 modal uses only `summarize`).
- Coordinate with Static Audit Fixes slice 10 (same file).
- `memory.md` (~19, ~118, ~160): the contextual key names position and version; the
  count check.
- Test:
  - `server/src/tests/embeddings.test.ts` (contextual cases ~514–564): the same text twice in
    one group gets two keys; warm `[A, B]`, evict B, warm again: one call with `[A, B]` in
    order and both keys hold the vectors of that order; a provider returning one vector too few
    fails without saving.
  - `server/src/tests/memoryAlgorithms.test.ts`: the cases that encode the repeated-position
    collision (~258–273, ~330–340) now expect distinct vectors.
  - `hypaV3Parts.test.ts` (~1590–1641) still passes with the new keys.

## Slice 9. Gemini tool responses carry no role (_small_, `llm-requests.md`)

- `server/src/llm/google.ts`: remove `role: "function"` from the remembered-call
  reconstruction (~236), the buffered follow-up (~840), and the streaming follow-up (~1173);
  `GeminiChat.role` becomes optional `"user" | "model"` (~39–40) (upstream `d900d6bd`). Gemini
  and Vertex share this file.
- Keep function names, call/response pairing, streaming, and the post-tool retry.
- Check the current Gemini API docs for the function-response shape at implementation time
  and cite them in the commit.
- Test:
  - `server/src/tests/llmProviderAdapters.test.ts` (~1359–1422): the follow-up body has no
    role on the function response (~1406–1407 today expect one).
  - `llmStreamParsing.test.ts` (~369–417): assert the streaming continuation's function
    response has no role.

## Slice 10. CBS prefillsupported reads the model's flag (_small_, `cbs-rendering.md`)

- `shared/cbs/registry.ts` (~1463–1471): for a model whose descriptor is Anthropic-format,
  answer from `hasPrefill`; for others keep the name-prefix answer (upstream `4a95bf2b`,
  `src/ts/cbs.ts` ~1358–1366). Resolve the descriptor through the shared catalog the server
  and tab already share (`shared/llm/models.ts`).
- `cbs-rendering.md`: the `prefillsupported` source.
- Test: a CBS case per answer: a Claude model with `hasPrefill` → 1, an adaptive-only Claude
  model without it (Claude 4.8) → 0, a non-Claude model → name prefix answer.

## Slice 11. Claude 5 Opus and adaptive-only thinking (_hard_, `llm-requests.md`)

- Catalog (`shared/llm/providers/anthropic.ts`): add Claude 5 Opus (upstream `c8a37b75`,
  `src/ts/model/providers/anthropic.ts` ~5–21). Check id, limits, and thinking behavior in the
  current Anthropic docs, not only upstream.
- Flag: `claudeThinkingOnByDefault` takes the next free number in `shared/llm.ts` (today 26 is
  the last, `geminiThinkingNoMinimal`). When thinking is off and the flag is set, the request
  sends `thinking: { type: "disabled" }` (`server/src/llm/anthropic.ts` ~382–401) instead of
  omitting it.
- Adaptive-only models (`claudeAdaptiveThinking` without `claudeThinking`): a stored `budget`
  thinking type is treated as adaptive (upstream `37d96e34`, `resolveClaudeThinkingType`,
  `src/ts/model/types.ts` ~105–116). One shared resolver serves the server adapter
  (~382–401) and the settings visibility (`src/ts/setting/botSettingsParamsData.ts`
  ~181–201). The stored preset value is not rewritten (D6).
- `llm-requests.md`: the flag and the resolver.
- Test:
  - Serialized Anthropic bodies (`llmProviderAdapters.test.ts`, beside ~1101–1157): thinking
    off on a flagged model sends `disabled`; `budget` on an adaptive-only model sends the
    adaptive shape; a budget-capable model is unchanged.
  - `src/ts/storage/tests/settingWrappers.test.ts` (~469–501): the visibility follows the
    resolved type while the stored value stays `budget`.

## Slice 12. Gemini catalog entries and a unique id check (_small_, `llm-requests.md`)

- `shared/llm/providers/google.ts` (~3–24): add the entries `b32610c6` adds
  (`gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-4-argon`) and its recommendation
  change, after checking each id in the current Gemini model list. Upstream's file lists
  `gemini-3.8-flash` twice (~44, ~56); keep one (D7 for the alias entries).
- `shared/llm/tests/models.test.ts`: every static catalog id is unique (no such check exists).
- Test: the uniqueness check; each new entry resolves by id with its flags.

## Slice 13. Wasmoon stops proxying JS objects (_small_, `scripts-triggers.md`)

- `server/src/lua/runtime.ts` `createPrepared` (~540): pass `enableProxy: false` with the
  existing `injectObjects` and `traceAllocations` (upstream `63399cbd`). This is Wasmoon's
  JS-object bridging, not HTTP proxies.
- No binding relies on a live proxy: values cross through `installValueGuard` (~136–166),
  `checkHostArgs` (~444–457), and JSON-wrapped tables (~237–320). A Luna probe with the option
  kept copied promise tables, the table refusals, and `editDisplay`.
- `scripts-triggers.md` (Lua runtime): the engine options.
- Test: `server/src/tests/luaRuntime.test.ts` asserts the engine options (beside the
  instrumented creation ~401–413); `luaBindings.test.ts` passes unchanged.

## Slice 14. Lua axLLM picks its model slot (_small_, `scripts-triggers.md`)

- `server/src/lua/bindings.ts` (~1051–1052, ~1106–1118, ~1620): read `options.mode` from the
  JSON options (`runtime.ts` ~260–263 already carries them) and validate it against
  `emotion | memory | otherAx | submodel | translate`; default `otherAx` (upstream
  `baac5410`). Route through the existing slots (`shared/llm/modelSlots.ts` ~65–76).
- An unknown mode is refused like other bad host arguments.
- `scripts-triggers.md` (Lua host API): the `mode` option.
- Test, in `server/src/tests/luaBindings.test.ts`: each mode reaches its slot; no option uses
  `otherAx`; an unknown mode is refused.

## Slice 15. Lua image generation takes a NovelAI orientation (_small_, `media-aux.md`)

Depends: 14 (same file). Same files as Static Audit Fixes slices 7 and 11 (`stableDiff.ts`,
the `jobChannel.ts` image callback) and Generation Stage Spinner slice 1 (`shared/jobs.ts`); see
Approach.

- `server/src/lua/bindings.ts` (~1583–1593): accept an optional JSON options argument with
  `orientation: "portrait" | "landscape" | "square"` and validate it.
- `shared/jobs.ts` image callback payload (~501–555): optional `orientation`.
- `src/ts/network/jobChannel.ts` (~673–696) passes it to `generateAIImage`;
  `src/ts/process/stableDiff.ts` (~87–155) swaps the configured NovelAI width and height so the
  longer side matches (upstream `1dbdede5`, `stableDiff.ts` ~123–148). Other providers ignore
  it.
- `media-aux.md` and `scripts-triggers.md`: the option.
- Test: bindings case for validation and payload; a `stableDiff` case for each orientation
  with portrait and landscape configured sizes; an old callback without the field is
  unchanged.

## Slice 16. Lua form submission (_hard_, `scripts-triggers.md`)

Depends: 13, 15. Included by D4. Same files as Small Fixes slices 6, 10, 11, Direct Asset URLs
slices 4 and 5, Server Thumbnails slice 4, and Generation Stage Spinner slice 1 (`Chat.svelte`,
`parser.svelte.ts`, `shared/jobs.ts`); see Approach.

- Upstream (`7ac7a204`, `be431696`, `536a2514`): a sanitizer-allowed `risu-form` attribute
  (`src/ts/parser/parser.svelte.ts` ~779–782); the chat captures `submit`, prevents navigation,
  collects `FormData`, and calls the Lua `onFormSubmit` with the trigger key and the values
  (`src/lib/ChatScreens/Chat.svelte` ~348–385, `src/ts/process/scriptings.ts` ~1121–1125,
  ~1489–1513).
- Metatron path:
  - Sanitizer: allow `risu-form` beside `risu-btn`.
  - `src/lib/ChatScreens/Chat.svelte` (~706–762, ~1820–1825): a submit handler that sends a
    form command for the message's chat by id (never the selected chat), with string values
    only and a size cap.
  - `shared/jobs.ts` command union (~80–83), validation in `server/src/routes/generations.ts`
    (~70–87), `server/src/jobs/commandRunner.ts` (~102–167), and Lua dispatch
    (`server/src/lua/runtime.ts` ~739–757) as a sibling of the button trigger.
  - Same permission gates as button triggers; no form command while that chat is sending
    unless buttons allow it today.
- `scripts-triggers.md`, `cbs-rendering.md` (the attribute).
- Test: route validation (bad shape, oversize); command runner reaches `onFormSubmit` with the
  values; a chat switch between submit and dispatch writes to the form's chat; an e2e case if
  an `e2e/` spec covers buttons.

## Slice 17. Select text does not clip in Safari (_small_, `ui-theming.md`)

Same file as Server Tokenizer slice 3 (`PopupEditor.svelte`); see Approach.

- Port `9499b870`'s select styling (upstream `src/styles.css` ~549–575: own chevron, padding,
  forced-colors fallback) as a class on `src/lib/UI/GUI/SelectInput.svelte` (~19–33) and the
  popup editor's select (`src/lib/Others/PopupEditor.svelte` ~65–68). Colors from theme
  tokens (`STRUCTURE.md` U1), not upstream's values.
- Test: visual check in a WebKit Playwright run (or by hand in Safari); record which.

## Slice 18. Card export survives a missing portrait (_small_, `characters-modules.md`)

- `src/ts/characterCards.ts` `exportCharacterCard` (~1406–1441) reads `char.image` directly
  and throws when it is missing; the UI wrapper (~802–815) handles only an empty image. Add one
  reader: the portrait if readable, else `none.webp`, with a warning (upstream `0ff42a75`,
  `98fd4314`, `readCardExportImage` ~715–735).
- Test: the missing-portrait test (today it expects export failure) expects a card with the
  fallback image; a readable portrait is unchanged.

## Slice 19. Creating a module adds it once (_small_, `characters-modules.md`)

Same file as Small Fixes slice 6 (`ModuleSettings.svelte`); see Approach.

- `src/lib/Setting/Pages/Module/ModuleSettings.svelte`: create mode pushes the module on entry
  (~204) and again on save (~241). Push only on save, and label the final button Close when
  nothing changed (upstream `3a19c2a5`).
- Test: a component or store test: create, save → one module; create, cancel → none.

## Slice 20. Realm creator blocking (_hard_, `persistence.md`)

Depends: 18 (same file), 1 (`importDatabase.ts`). Included by D4.

- Persisted field: a blocked creator list in settings (upstream `656cd3cf`,
  `src/ts/realmBlocking.ts` ~1–34). Add it to `shared/database.ts`, its section owner, server
  normalization (default empty), and the settings report; upstream import maps it
  (`importDatabase.ts`).
- UI (upstream `11166050`): block and unblock from the card popup, a list to manage them
  (`src/lib/UI/Realm/`), and filtering of listings (`RealmMain.svelte` ~191–208).
- Direct downloads by URL or id (`src/ts/characterCards.ts` `downloadRisuHub` ~1928–1962)
  check the list too, so a blocked creator's card is refused with a notice, not only hidden.
- `persistence.md` (the field), `backup-sync-hub.md` (Realm).
- Test: normalization default; listing filter; a direct download of a blocked creator's card is
  refused; unblock restores it.

## Slice 21. A chat parse error shows its stack (_small_, `ui-theming.md`)

Same file as Small Fixes slice 10 and Direct Asset URLs slice 4 (`ChatBody.svelte`); see
Approach.

- `src/lib/ChatScreens/ChatBody.svelte` (~301) concatenates `error.stack` into the alert text.
  Pass an `Error` carrying the message so `alertError` (`src/ts/alert.ts` ~107) shows the stack
  in its details view (upstream `1f8180c1`).
- Test: the ChatBody or alert test sees the details, and the message text no longer contains
  the stack.

## Slice 22. Keep-alive audio counts as audible (_small_, `app-shell.md`)

Included by D8. Same file as Chat Checkpoints slice 5 (`src/App.svelte`); see Approach.

- `src/App.svelte` (~134–140): the `sound` mode loops `send.mp3` at volume `0.000001`, which
  Chrome treats as silent. Port `67e7b8cb` (`src/ts/keepAliveAudio.ts` ~1–48): a generated
  10-second 20 Hz waveform at full volume, media session metadata, and resume after a pause.
  Put it in its own module.
- Test: a unit test of the module with a stubbed `Audio`/media session (starts, loops, resumes,
  stops); check by hand that Chrome shows the tab as playing audio.

## Slice 23. Upstream ledger (_small_, `build-test-platforms.md`)

Depends: 1–22 (each landed, or dropped by a decision).

- Write the ledger at the place D5 names. Header: observed upstream sha, inventoried-through
  sha, triaged-through sha, Metatron sha checked, and the two harness targets. One row per
  upstream commit from the Inventory with its disposition (`integrated`, `equivalent`,
  `excluded`, `deferred`), evidence, and the Metatron commit(s). Deferred rows carry a revisit
  trigger.
- Check each merge's first-parent delta for behavior its constituent commits do not carry
  (`b544d744` and `1db1199e` were checked: none). Note any finding as a new row.
- The intake procedure for the next scan, in the ledger:
  1. Record both heads and their working tree status; never reset or pull over local work.
  2. `git fetch --no-tags /home/codex/Risuai refs/heads/main:refs/remotes/upstream-local/main`,
     check `git merge-base --is-ancestor <inventoried sha> <new head>`, then list
     `git rev-list --reverse --topo-order <inventoried sha>..<new head>` and the first-parent
     log. If history was rewritten, stop and reconcile from the new merge base.
  3. Read the diffs, group by behavior, route each group through `STRUCTURE.md`, compare with
     Metatron and its tests before assigning a disposition.
  4. Advance the inventoried sha only when every commit in the range has a row, and the triaged
     sha only when every row has a disposition.
  5. Turn new gaps into a plan with slices.
- Link the ledger from `backup-sync-hub.md` or the research README.
- Do not archive this plan or edit `docs/plan/README.md` here: retiring the plan (the archive
  entry, the index link) is the orchestrator's step after every slice landed, with the user's
  yes.

## Inventory

All 79 non-merge commits in `25001174..f50b5942`. "Slice" means a slice of this plan; the
evidence for "equivalent" and "inapplicable" is the Metatron code named.

| Upstream                                                                                                                                          | Disposition  | Evidence or slice                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dae3f650` SaveKV and block backups                                                                                                               | gap          | slice 1                                                                                                                                                                                                                                     |
| `eeb8ef5f` cancelAccountSync option                                                                                                               | inapplicable | Risu Account sync was removed; only legacy flags are cleaned                                                                                                                                                                                |
| `68b5d032`, `855d9d45`, `f7102947` plugin storage index                                                                                           | gap          | slice 2 (and slice 3 for the migration)                                                                                                                                                                                                     |
| `49d08fda` guest message source                                                                                                                   | gap          | slice 4                                                                                                                                                                                                                                     |
| `de29b064`, `8effde3a`, `9d95cb20` lite setter plugins                                                                                            | gap          | slice 5                                                                                                                                                                                                                                     |
| `f76fb63a`, `c22c3d73`, `9d21f229` SafeElement targets                                                                                            | gap          | slice 6                                                                                                                                                                                                                                     |
| `69a56088`, `016d423b`, `27ea429f`, `e774d673`, `a19bbb8f` scoped permissions                                                                     | equivalent   | `v3.svelte.ts` ~715–779 (script-hash grants), ~1286–1289 (captured identity), ~1404–1425 (provider denial), ~1508–1513 (inlay); `permissions.test.ts` ~97–314. Session answers are keyed by name and cleared on unload rather than by hash. |
| `72d2bacd`, `ae54b830` full setDatabase plugins                                                                                                   | equivalent   | `v3.svelte.ts` ~1253–1271, `plugins.svelte.ts` ~642–663, `upsertPlugin`; test added in slice 5                                                                                                                                              |
| `9badb4c1` per-entry lore flags                                                                                                                   | gap          | slice 7                                                                                                                                                                                                                                     |
| `4fa72fb5` regex key parse                                                                                                                        | equivalent   | `activation.ts` ~117–192 (first/last slash, empty flags, no key mutation); `lorebookRegexBaseline.test.ts` ~6–16, ~141–184                                                                                                                  |
| `b63119ad`, `2787e06c`, `7df07966` contextual vectors                                                                                             | gap          | slice 8                                                                                                                                                                                                                                     |
| `d900d6bd` Gemini function role                                                                                                                   | gap          | slice 9                                                                                                                                                                                                                                     |
| `4a95bf2b` prefillsupported flag                                                                                                                  | gap          | slice 10                                                                                                                                                                                                                                    |
| `c8a37b75` Claude 5 Opus, `37d96e34` adaptive budget                                                                                              | gap          | slice 11                                                                                                                                                                                                                                    |
| `b32610c6` Gemini models                                                                                                                          | gap          | slice 12                                                                                                                                                                                                                                    |
| `f0b236a5` dynamic internalID                                                                                                                     | equivalent   | `shared/llm/models.ts` `dynamicModelOf` ~649–671; `shared/llm/tests/models.test.ts` ~5–65                                                                                                                                                   |
| `63399cbd` Lua enableProxy                                                                                                                        | gap          | slice 13                                                                                                                                                                                                                                    |
| `baac5410` axLLM mode                                                                                                                             | gap          | slice 14                                                                                                                                                                                                                                    |
| `1dbdede5` NovelAI orientation                                                                                                                    | gap          | slice 15                                                                                                                                                                                                                                    |
| `7ac7a204`, `be431696`, `536a2514` Lua forms                                                                                                      | gap          | slice 16                                                                                                                                                                                                                                    |
| `3eb42cb8` editDisplay without JSON                                                                                                               | deferred     | behavior present (`server/src/prompt/scripts.ts` ~70–105); perf only. Trigger: editDisplay in a profile                                                                                                                                     |
| `9499b870` Safari select                                                                                                                          | gap          | slice 17                                                                                                                                                                                                                                    |
| `0ff42a75`, `98fd4314` card export image                                                                                                          | gap          | slice 18                                                                                                                                                                                                                                    |
| `3a19c2a5` duplicate module                                                                                                                       | gap          | slice 19                                                                                                                                                                                                                                    |
| `656cd3cf`, `11166050` creator blocking                                                                                                           | gap          | slice 20                                                                                                                                                                                                                                    |
| `1f8180c1` parse error stack                                                                                                                      | gap          | slice 21                                                                                                                                                                                                                                    |
| `67e7b8cb` audible keep-alive                                                                                                                     | gap          | slice 22                                                                                                                                                                                                                                    |
| `20c46e11`, `6ee8c3e7` `asset:` media src                                                                                                         | inapplicable | `asset:` is Tauri's `convertFileSrc`; Metatron produces `/sw/img/…` and `blob:` (`globalApi.svelte.ts` ~208–247)                                                                                                                            |
| `6a36a3f4` popup editor space                                                                                                                     | equivalent   | `hotkey.ts` `isTextEntry` ~421–459, used by the keydown gate ~58–59                                                                                                                                                                         |
| `7e58e0b1` touch-end guard                                                                                                                        | inapplicable | no pointer-map swipe handler (`hotkey.ts` ~330–351)                                                                                                                                                                                         |
| `71526fbc` partial edit settings order                                                                                                            | equivalent   | `interactionSettingsData.ts` ~28–53, ~155–165                                                                                                                                                                                               |
| `b3ac6d1e`, `46ae531b`, `c1318660`, `c03162e0`, `f1655a61`, `2ae6a997`, `2b7fc936`, `c5c9a6ba`, `19cf3fd0`, `8443e593`, `0bed0846` welcome screen | inapplicable | Metatron has no first-run wizard (`app-shell.md` ~18–22)                                                                                                                                                                                    |
| `450a598a` character onboarding                                                                                                                   | deferred     | Not In This Plan                                                                                                                                                                                                                            |
| `48ee4de3`, `30b41e62` persona note                                                                                                               | equivalent   | `30b41e62` supersedes `48ee4de3`; `PersonaSettings.svelte` ~200–210 always shows the note                                                                                                                                                   |
| `11c278c6` loadout apply options                                                                                                                  | inapplicable | loadouts removed; import reports them (`importDatabase.ts` ~438–454)                                                                                                                                                                        |
| `bde6c246` legal check                                                                                                                            | inapplicable | old Express server; no legal/ToS path in Metatron                                                                                                                                                                                           |
| `d90a00fb`, `6a7df319` storage write errors                                                                                                       | deferred     | Not In This Plan                                                                                                                                                                                                                            |
| `3cc8bfeb` storage write paths                                                                                                                    | equivalent   | hex logical keys resolved under `save/assets` for single, batch, and import writes                                                                                                                                                          |
| `fff2c706` newest loadable backup                                                                                                                 | equivalent   | snapshots listed newest first and restored as selected                                                                                                                                                                                      |
| `d36fccc6`, `0e56b763`, `8f587dfe` snapshot cost                                                                                                  | equivalent   | V3 reads one storage key; the server supplies alternatives; `characterSnapshot(chaId)`                                                                                                                                                      |
| `ca1345fc` zh-Hant conflict markers                                                                                                               | equivalent   | Metatron's `zh-Hant.ts` has the clean strings                                                                                                                                                                                               |
| `4e7733a0` Monaco workers and Lua completion                                                                                                      | deferred     | Not In This Plan                                                                                                                                                                                                                            |
| `63d85f9b`, `02a83695`, `f50b5942` versions                                                                                                       | excluded     | upstream version bumps                                                                                                                                                                                                                      |
| `4160e3e1` PR template                                                                                                                            | excluded     | upstream repository process                                                                                                                                                                                                                 |

## Decisions

The runner takes each default unless the user overrides it.

- D1. A block save with a non-empty `kv`. Options: (a) list each namespace in the import report
  as not imported and continue; (b) refuse the import. Default (a): upstream writes no namespace
  at `f50b5942`, the import report already lists what it leaves behind (loadouts), and refusing
  would block a whole backup over data no upstream feature reads.
- D2. Lore flags. Options: (a) per entry, as upstream now does; (b) keep them function-wide and
  record `9badb4c1` as excluded. Default (a). At Phase 5 Stop B (2026-10-02) the owner kept the
  function-wide behavior for parity with the browser path; upstream itself has since changed,
  so parity now points the other way. Cards with a keep entry before a don't-activate entry
  behave differently after the change.
- D3. Contextual key change. Options: (a) a new key with position and version (old cached
  vectors miss once and are embedded again); (b) keep today's key and add the position only
  for repeated text. Default (a): the cache is rebuildable, and (b) leaves no way to change the
  key again.
- D4. Optional features. Options: (a) include slice 16 (Lua forms) and slice 20 (creator
  blocking); (b) drop either and record it as deferred. Default (a): cards written for upstream
  use forms, and blocking covers downloads, not only listings.
- D5. Ledger place. Options: (a) `docs/research/upstream-ledger.md`, listed in the research
  README; (b) `docs/upstream-ledger.md`. Default (a): it outlives this plan, and research
  surveys of other forks live there.
- D6. A stored `budget` on an adaptive-only model. Options: (a) resolve it at request and
  display time, leave the stored value; (b) rewrite it to `adaptive` in the settings UI, as
  upstream does. Default (a): the same preset may later run a budget-capable model.
- D7. Gemini `-latest` aliases. Options: (a) add them as upstream does; (b) add only fixed ids.
  Default (a), if the current Gemini docs still list them; their capabilities follow the
  alias's current target.
- D8. Keep-alive audio. Options: (a) port it (slice 22); (b) leave the near-silent loop.
  Default (a): the `sound` mode is opt-in, and today it does not do what it says in Chrome.

## Not In This Plan

- Character onboarding (`450a598a`): character fields, card import/export, an editor, a modal,
  and chat-variable writes by chat id. It needs its own plan.
- Lua `editDisplay` without JSON round trips (`3eb42cb8`): no measured cost.
- Monaco `?worker` constructors and a Lua completion provider (`4e7733a0`).
- Storage write error details (`d90a00fb`, `6a7df319`): Metatron answers a failed asset write
  with a generic 500 and the client says `setItem Error`; details would need path scrubbing.
- Lore regex keys containing a comma (`/a{1,2}/` is split before parsing,
  `activation.ts` ~541, pinned by `lore.test.ts` ~231–266). Upstream splits the same way.
- The contextual embedding path's bypass of the rate limiter (`embeddings.ts` ~796–808, noted
  in `server/src/prompt/memory/hypav3.ts` ~1891–1896).
- The browser HypaV2/V3 embedding cache code (not run in production).
- Exporting block saves, scheduling recurring intake, and updating `/home/codex/Risuai` from
  GitHub.

## Open Questions

- Slice 1 assumes upstream's block length field is little endian, because every upstream
  platform is. Should the decoder also accept a big-endian file, or refuse it as malformed?
  The plan refuses it.
