# Upstream Integration Plan

Status: prepared 2026-10-23 (Asia/Seoul) at `79ae26cc4` and imported into `docs/plan/` at `832caccf0`. No item landed. This plan predates the slice format the other plans use: it is an intake process plus a seeded backlog (A–N), and each accepted item becomes its own commit.

## Objective and approach

Track changes in `/home/codex/Risuai`, identify which behaviors benefit Metatron, and incorporate them in small, independently reviewable changes. Use selective ports as the default: Metatron's server-owned generation, resource persistence, and credentials differ substantially from upstream's browser application. A clean patch application alone does not establish compatibility.

The first priorities are current-upstream backup compatibility and plugin boundary fixes. Follow those with lore, memory, and provider correctness, then selected user-facing features. Record fixes Metatron already implements so they are not repeatedly rediscovered or reapplied.

This document does not implement ports, refresh remote repositories, schedule monitoring, or claim runtime verification. Both source working trees were clean at inspection. The reference is the supplied local upstream checkout, not a claim about the latest GitHub state.

## 1. Establish the baseline

| Reference                           | Inspected value                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Metatron repository / branch        | `/home/codex/risuai-metatron`, `metatron`                                            |
| Metatron HEAD                       | `79ae26cc4837090eb75a8b9cd90c6398b79611e8`                                           |
| Upstream repository / branch        | `/home/codex/Risuai`, `main`                                                         |
| Upstream HEAD                       | `f50b5942ec6aa59aa3c56049ac687ca09667fec7`                                           |
| Common ancestor                     | `25001174e0452e3b9d16aee459ce9d2444c197d7`                                           |
| Divergence from common ancestor     | 639 Metatron-only commits; 133 upstream-only commits                                 |
| Upstream intake size                | 79 non-merge commits and 54 merges; 41 first-parent entries; net changes in 86 files |
| Existing upstream compatibility pin | `669b12ceabe1c5066d3dadbe0973f2188d10cc97`                                           |

The 133 commits are an inventory, not 133 missing features. Several old branches merged recently; commit dates precede the common ancestor's date. Enumerate by Git ancestry rather than `--since`. Review merge results as well as constituent commits: some apparent PR-title “duplicates” are merge commits, and resolutions may contain additional behavior.

Patch comparison (`--left-right --cherry-mark --no-merges`) found no patch-equivalent entries at these heads. Semantic overlap still exists: Metatron already preserves installed plugins on full database updates and has its own storage, memory, and transport implementations.

## 2. Keep a lightweight intake ledger

Create a rolling `upstream-ledger.md` beside this plan during the first implementation session. Keep dated intake reports beside it when a scan adds decisions. These are proposed follow-up artifacts.

The ledger header should record:

- **Observed upstream SHA:** the most recent source head inspected.
- **Inventoried through SHA:** advance only after every commit in the intervening ancestry range is assigned to an item, including merges and release-only changes.
- **Triaged through SHA:** advance only after every inventoried item has a disposition, priority, and reason. Deferred work remains visible.
- **Metatron review SHA:** the fork head against which classifications were checked.
- **Compatibility targets:** separate upstream revisions for legacy and current save-format checks. These are not feature-integration markers.

Each item needs a stable ID, all full upstream SHAs, merge/PR grouping, behavior summary, priority, upstream and Metatron source anchors, dependencies, acceptance criteria, status, decision reason, verification evidence, and resulting Metatron commit(s). Deferred items also need a revisit trigger. Keep attribution for partial ports, with the remaining behavior explicitly listed.

Use statuses `candidate`, `ready`, `implementing`, `integrated`, `equivalent`, `deferred`, and `excluded`. Only mark `integrated` after the required checks pass. Mark `equivalent` with source and test evidence; similar naming is insufficient. Record unsupported platforms and superseded commits as `excluded` with reasons rather than omitting them. There is no single “all upstream changes applied through” SHA for this selective workflow.

### Recurring intake procedure

Proposed cadence: review local upstream changes weekly, before a Metatron release, and immediately when a relevant security, data-loss, or import regression is reported. Monitoring should report newly actionable findings or changed blockers. Scheduling is a separate future action.

1. Record both heads and working-tree status. Read committed upstream source; do not reset or pull over local work.
2. Import the local upstream branch into a dedicated tracking ref in the fork. The following commands are for future intake; they were not executed for this plan:

   ```bash
   fork_dir=/home/codex/risuai-metatron
   upstream_dir=/home/codex/Risuai
   git -C "$fork_dir" fetch --no-tags "$upstream_dir" \
     refs/heads/main:refs/remotes/upstream-local/main
   upstream_sha=$(git -C "$fork_dir" rev-parse refs/remotes/upstream-local/main)
   scan_from=25001174e0452e3b9d16aee459ce9d2444c197d7
   git -C "$fork_dir" merge-base --is-ancestor "$scan_from" "$upstream_sha"
   git -C "$fork_dir" rev-list --reverse --topo-order "$scan_from..$upstream_sha"
   git -C "$fork_dir" log --first-parent --format='%H %cI %s' "$scan_from..$upstream_sha"
   git -C "$fork_dir" diff --name-status "$scan_from" "$upstream_sha"
   ```

   After the first scan, set `scan_from` to the ledger's inventoried SHA. Check the ancestry command's exit status before running the range commands. If history has been rewritten, stop marker advancement, retain the old inventory, and reconcile from the new common ancestor. Updating `/home/codex/Risuai` from GitHub, if desired later, is a separate step whose fetched SHA must be recorded.

3. Read the actual behavioral diffs, including each merge's first-parent delta and subsequent corrections. Group commits by behavior and dependency. Inspect the final upstream implementation to avoid porting a change that a later commit removes.
4. Route each group through [STRUCTURE.md](../../STRUCTURE.md), then its focused guide. Compare the current Metatron implementation and tests before assigning a disposition.
5. Produce a short intake report: new urgent items, newly ready ports, equivalent/excluded decisions, deferred items whose triggers fired, and verification gaps. Advance the appropriate markers only after the inventory is accounted for.

## 3. Preserve Metatron's contracts when porting

Follow [AGENTS.md](../../AGENTS.md) and the repository-wide invariants in [STRUCTURE.md](../../STRUCTURE.md). In particular:

| Upstream area                                                 | Metatron integration boundary                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-database reads and mutations                            | Resource records, validated mutation APIs, revisions/epochs, and chat/message IDs. Add persisted ownership and server normalization where required. See [persistence](../../docs/structure/persistence.md). |
| Browser request adapters and provider credentials             | Port request behavior into `server/src/llm/` and shared contracts. Preserve write-only credentials, model profiles/slots, and server jobs. See [LLM requests](../../docs/structure/llm-requests.md).        |
| Browser lore, memory, and scripts                             | Use `shared/lore/`, server prompt/memory implementations, and the server Lua runtime. Preserve job snapshots, permissions, cancellation, and work limits.                                                   |
| Plugin database and storage APIs                              | Preserve permission checks, approved installation paths, resource-store mutations, per-plugin storage, and reload coordination. See [plugins/MCP](../../docs/structure/plugins-mcp.md).                     |
| Backups, cards, modules, presets                              | Treat interchange formats as compatibility contracts. Preserve old readers and report unsupported fields explicitly. See [backup/import/export](../../docs/structure/backup-sync-hub.md).                   |
| UI changes                                                    | Keep theme tokens, English source strings with partial locale overrides, existing screen stores/router, and ID-based asynchronous targeting.                                                                |
| Tauri, Capacitor, standalone browser storage, old Node server | Exclude platform-specific implementations. Assess any shared correctness requirement separately against Metatron's Hono/PWA platform.                                                                       |

Never wholesale-copy upstream `package.json`, lockfiles, version numbers, persisted enums, or old server directories. Review dependencies separately using Metatron's Node >=24 and pnpm 10.34.1 toolchain. Retain persisted spellings and discriminator values.

## 4. Seed backlog and priority

This is a prioritized starting set, not a completed classification of every upstream SHA. **Confirmed** means the relevant source difference was inspected; it does not mean a runtime reproduction was run. **Partial** or **candidate** requires the stated comparison before implementation. P0 means the next intake should address a data-integrity or permission boundary; it is not an assertion of a demonstrated exploit.

### P0: current backup formats and plugin boundaries

**A. Current-upstream `.bin` imports — confirmed incompatibility.** Upstream `dae3f650` changes full and partial backups to `encodeRisuSave`, which emits self-contained RisuSave blocks and carries SaveKV namespaces. Metatron's [upstream codec](../../server/src/data/upstream/risuSave.ts), `decodeUpstreamDatabase`, accepts legacy raw/gzip/stream-gzip formats and explicitly rejects block saves. Its “live saves only” assumption is now stale.

Plan a bounded block decoder in the server import worker, retain legacy readers, and map the new `{ database, kv }` result explicitly. Inspect actual archive contents using synthetic upstream fixtures. Define storage ownership and export behavior for supported KV namespaces before enabling their import; unsupported data must produce a specific blocking report rather than be discarded. Keep block lengths, decompression, total bytes, nesting/allocation, and worker limits. Self-contained exports must not resolve arbitrary live-save remote references.

**B. New plugin-storage backup layout — confirmed gap, dependent on A.** Upstream `855d9d45`, `68b5d032`, and `f7102947` change storage and migrate it before plugin loading. Current upstream uses `_coldpluginIndex`, an index with inline JSON values and large-value references, while Metatron's [collection converter](../../server/src/data/upstream/importCollections.ts), `convertPluginStorage`, understands inline storage and `_coldplugin`. Decode the index and referenced archive records into Metatron's existing plugin storage; do not transplant upstream's browser storage engine. Import must finish before plugins can execute against the restored state.

Acceptance for A/B: legacy and current synthetic backups import without losing characters, messages, IDs, assets, or plugin values; large values and empty values survive; missing, malformed, duplicate, oversized, or unsupported records produce actionable reports without partially replacing live data. Verify the output through both legacy and current upstream readers. Ship current-format support only once its plugin/KV disposition is safe.

**C. Plugin message source, mutation, and event scope — confirmed gaps.** Upstream `49d08fda` / merge `70d6413f` validates the guest's message source; Metatron's [iframe factory](../../src/ts/plugins/apiV3/factory.ts), `GUEST_BRIDGE_SCRIPT`, lacks the corresponding guest-side check even though the host already validates its iframe. Upstream `de29b064`, `8effde3a`, `9d95cb20` / merge `549f3126` protects `setDatabaseLite` from plugin-list changes; Metatron's lite path still replaces that list. Upstream `f76fb63a`, `c22c3d73`, `9d21f229` / merge `b367f53e` scopes `SafeElement` listeners to their intended target; Metatron still registers them on `document`.

Port as separate, focused commits in the plugin bridge/host APIs and update types/docs alongside behavior. Acceptance: unrelated frames cannot drive the guest RPC listener; lite database updates cannot install/remove/replace plugins while permitted fields still update; full approved installation remains functional; an element's listener does not receive sibling events, and removal/document-listener behavior remains correct. Preserve terminal-notice protection and unload cleanup. Replace the current test expectation that permits lite plugin-list replacement, and add negative regression cases. Metatron loads API 3.0 plugins, so upstream's specific V2 execution-escalation rationale should not be assumed to apply unchanged.

### P1: correctness in active chat paths

**E. Lorebook flags — confirmed gap; related regex fix already represented.** Upstream `9badb4c1` / merge `b19b693d` makes activation flags entry-local. In Metatron's [shared lore activation](../../shared/lore/activation.ts), keep/don't-activate flags are still outside the entry loop. Port there, then test successive entries, decorator combinations, and prompt ordering. Separately, upstream regex-key correction `4fa72fb5` is already represented by Metatron's parser and [regex baseline test](../../src/ts/process/lorebookRegexBaseline.test.ts); retain its evidence as an equivalent item.

**F. HypaV3 contextual vectors — partially present.** Review `b63119ad`, `2787e06c`, `7df07966` / merge `1db1199e`. Metatron already uses context-specific chunk keys, but repeated chunks within a group, key versioning, and vector-count validation need comparison and porting where absent. Integrate in the server memory/embedding path, using [the memory guide](../../docs/structure/memory.md). Acceptance: identical text at distinct contextual positions cannot silently acquire the wrong vector; mismatched cached vector counts rebuild or fail explicitly; existing stored memory remains readable.

**G. Gemini tool-response roles — confirmed request-shape difference.** Upstream `d900d6bd` removes `role: 'function'` in three request paths. Metatron retains those roles in [the server Google adapter](../../server/src/llm/google.ts). Port the intended wire shape to all corresponding server paths, preserving function names, call/response pairing, streaming, and retry behavior. Verify with captured synthetic request bodies and the provider contract applicable at implementation time.

**H. Model capabilities and catalog — mixed confirmed differences and candidates.** Review `f0b236a5`, `b32610c6`, `4a95bf2b`, `c8a37b75`, `37d96e34` / merge `b544d744`. Metatron's [CBS registry](../../shared/cbs/registry.ts) still derives prefill support from the model name prefix; compare and port upstream's descriptor-flag behavior. Audit dynamic `internalID` and adaptive-thinking behavior before adding catalog entries. Upstream's Google changes contain a duplicate model ID, so do not copy the catalog wholesale. Check current official provider documentation when implementing; preserve persisted numeric enums and profile references, and test catalog uniqueness, CBS capability answers, and serialized requests.

### Verify equivalence before adding work

**D. Scoped plugin permissions — substantially equivalent protections.** Upstream `69a56088`, `016d423b`, `27ea429f`, `e774d673`, `a19bbb8f` / merge `5537816a` covers script identity, permission-cache scope, provider denial, and inlay access. Metatron already has captured script identity, scoped permission answers, server grants, provider denial, inlay permission, and unload invalidation. Close the matching behaviors with test evidence; review cached script hashing separately if profiling justifies it. Acceptance: unrelated identities cannot reuse grants; denied providers do not execute; approved provider/inlay calls still work. This review supports C without assuming the entire upstream permission series needs implementation.

**I. Full plugin database round trips — substantially equivalent.** Upstream `72d2bacd`, `ae54b830` / merge `74d96626` preserves installed plugins and replaces approved same-name updates in place. Metatron's [plugin API](../../src/ts/plugins/apiV3/v3.svelte.ts), `setPluginDatabase` / `applyPluginKey`, already uses installation approval and [collection upserts](../../src/ts/storage/collectionStore.svelte.ts), `upsertPlugin`, that retain the existing slot. Record existing regression coverage and check unchanged lists, approve/deny, and same-name updates before closing as equivalent. Keep this distinct from the unsafe lite path in C.

**J. Lua proxy hardening — partial/equivalence review.** Upstream `63399cbd` sets Wasmoon's `enableProxy: false`; this concerns JavaScript-object bridging, not HTTP proxy routing. Metatron has its own value guards and worker boundary in [the server Lua runtime](../../server/src/lua/runtime.ts). Evaluate the option against that design and the Lua runtime tests. Do not mechanically alter network/proxy policy or remove character/module/trigger permission gates.

### P2: useful features and smaller fixes

**K. Lua interaction features.** Assess auxiliary-model selection (`baac5410` / `851e8ca5`), form submission (`7ac7a204`, `be431696`, `536a2514` / `61d0eb79`), NovelAI image orientation (`1dbdede5` / `3f28e978`), and editDisplay serialization (`3eb42cb8` / `3d128115`). Route them through server Lua host commands and shared types. Test approved/denied calls, form values, intended chat targeting, and cancellation under concurrent sends. These are separate features, not one large port.

**L. Rendering and UI fixes.** Triage `20c46e11` (sanitized `asset:` media), `9499b870` (Safari select clipping), `6a36a3f4` (Chromium popup-editor space), `7e58e0b1` (touch-end guard), and `71526fbc` (partial-edit control grouping). Metatron already handles `editContext` in hotkeys and no longer uses upstream's pointer-map swipe implementation, so verify those as equivalent or inapplicable first. Preserve sanitization allowlists and add browser coverage where the behavior needs a real browser. Treat the welcome-screen redesign (`46ae531b` and its corrections, merged as `ccb986b8`) as a separate optional UX proposal adapted to server credentials and chat bindings.

**M. Realm and collection behavior.** Assess creator blocking (`656cd3cf`, `11166050`), missing card images (`0ff42a75` / `e773240b`), duplicate module creation (`3a19c2a5`), and persona-note changes (`48ee4de3`, `30b41e62`). Use current Realm, persona, and collection owners. For new persisted fields, include shared types, section ownership, normalization, and interchange behavior. Creator blocking must cover direct downloads and server-mediated imports as well as listings. Review the final note-field behavior rather than applying both superseding changes independently. Upstream saved-loadout options (`11c278c6` / `5f9e3cbe`) concern loadouts excluded by Metatron's import contract; do not restore that feature incidentally as a preset fix.

**N. Character onboarding — separate optional feature.** Upstream `450a598a` adds character-specific forms/HTML that initialize chat variables and record completion. This is distinct from the welcome-screen redesign. Scope shared character/chat fields, server normalization, card import/export, and ID-based writes before implementation. Test required and repeated fields, sanitized HTML/CSS, safe mode, preview without writes, persistence of completion, and a selection change or deletion during asynchronous parsing. Preserve cross-user card compatibility and avoid upstream's selected-chat mutation assumptions.

Remaining commits—including old Node storage changes, browser backup selection, snapshot performance changes, translations, Monaco work, version bumps, and PR templates—must still receive ledger dispositions. Exclude obsolete implementations only after checking whether the underlying defect can occur in their Metatron replacements.

## 5. Implementation order and change isolation

1. **Inventory and reproduction:** account for all 133 SHAs, establish the ledger, and capture small synthetic fixtures for A/B and the plugin boundary failures. Resolve which existing tests establish equivalence. Keep unsupported current backups explicitly unsupported until the complete path is ready.
2. **First corrective batches:** A/B as a coordinated compatibility series; C as separate plugin changes, supported by D's permission-equivalence review. Establish codec support before converter integration, and validate permission groups before elective plugin API additions. These batches are independently reviewable; there is no requirement to merge them together.
3. **Chat correctness:** E, F, and G in separate commits, with H's protocol corrections only after catalog/provider review.
4. **Equivalence closure and optional features:** close D/I/J with evidence, then select individual K–N items by user value and maintenance cost. Leave deferred items visible with a revisit trigger.

For each accepted item, create a `codex/upstream-<topic>` branch in an isolated worktree based on the current `metatron` head. Read the owning guide, establish the failing behavior, and implement the smallest complete change. A small, architecture-compatible non-merge commit may use `git cherry-pick -x`; semantic ports should use a conventional title and `Upstream-Commit: <full SHA>` trailers. Do not batch cherry-pick the full range or cherry-pick a merge without understanding its parentage.

The per-chat send plan has landed all seven slices and is archived ([archive](../archived-plan/README.md), `832caccf0`); its slice 7 changed the job channel. The [chat checkpoint plan](chat-checkpoints.md) is still planned. Recheck both before touching jobs, callback channels, plugin reloads, Lua effects, chat records, or restore logic. Preserve concurrent-send behavior and coordinate overlapping changes; unrelated UI or import work need not wait for both plans to finish.

## 6. Verification and compatibility coverage

Follow [the build/test guide](../../docs/structure/build-test-platforms.md) and each affected domain's focused checks. Every implementation batch needs:

- A regression check that demonstrates the bug or compatibility failure, with new regression tests shown to fail when the guarded behavior is broken. Mock I/O/process boundaries rather than the implementation under test.
- `pnpm check`, `pnpm --silent test:agent`, targeted formatting, and `pnpm format:check`. Run `pnpm check:tests` after adding, moving, or retagging tests.
- Affected slow tests through `pnpm --silent test:agent --tags-filter=slow <files>`; use `--all` when both sets are needed. Keep real-clock and production-limit tests out of the deterministic suite.
- Browser checks through `pnpm --silent test:agent --e2e`, explicitly naming covering specs if automatic selection misses. For committed changes, use `--e2e-since=<batch-base>` so selection sees the whole batch. Serialize browser runs because they share fixed ports.
- `pnpm build` for build changes; also include it for the first integrated compatibility/plugin release to verify production bundling. Never report an unrun or failed-to-start check as passed.

Useful existing regression anchors, to extend according to the behavior changed:

| Area                            | Existing tests                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup codecs and imports       | [upstreamRisuSave.test.ts](../../server/src/tests/upstreamRisuSave.test.ts), [upstreamImportRoute.test.ts](../../server/src/tests/upstreamImportRoute.test.ts), [upstreamImportWorker.test.ts](../../server/src/tests/upstreamImportWorker.test.ts)                                                      |
| Export compatibility            | [upstreamExport.test.ts](../../server/src/tests/upstreamExport.test.ts), [upstreamExportRoute.test.ts](../../server/src/tests/upstreamExportRoute.test.ts)                                                                                                                                               |
| Plugin boundaries and mutations | [guestBridge.test.ts](../../src/ts/plugins/apiV3/guestBridge.test.ts), [hostApiRouting.test.ts](../../src/ts/plugins/apiV3/hostApiRouting.test.ts), [v3SetDatabase.test.ts](../../src/ts/plugins/apiV3/v3SetDatabase.test.ts), [v3SavedWrites.test.ts](../../src/ts/plugins/apiV3/v3SavedWrites.test.ts) |
| Lore behavior                   | [lore.test.ts](../../server/src/tests/lore.test.ts)                                                                                                                                                                                                                                                      |
| Lua and callback integration    | [luaRuntime.test.ts](../../server/src/tests/luaRuntime.test.ts), [luaBindings.test.ts](../../server/src/tests/luaBindings.test.ts), [jobChannel.test.ts](../../server/src/tests/jobChannel.test.ts), [generationJobs.test.ts](../../server/src/tests/generationJobs.test.ts)                             |

### Extend the existing save harness, preserving its baseline

[checkBinCompat.mjs](../../util/upstream/checkBinCompat.mjs) and [upstreamHarness.mjs](../../util/upstream/upstreamHarness.mjs) already exercise upstream decoding and a bounded boot sequence against Metatron exports. They are outside the ordinary test suite, pin upstream `669b12ce...`, and require that pin's exact `msgpackr` 1.10.1 and `fflate` 0.8.2 packages. Merely updating the upstream checkout does not update this check.

Extend the harness to maintain explicit **legacy and current targets**, with each target's source SHA, package versions, decoder return shape, and approved stub boundaries. Retain the old target while adding `f50b5942...` as the initial current target; update current targets through reviewed compatibility changes, not automatically on every fetch. Do not mask a changed upstream dependency by broadly approving new stubs.

The current harness excludes upstream's actual backup reader/asset writes, cold-storage runtime, plugin loading, and UI. Its existing success cannot establish new-format import or plugin-storage compatibility. Add synthetic current-upstream exports and cover both directions: upstream backup → Metatron import, and Metatron export → upstream decoder/boot, plus focused restored-plugin behavior. Track each limit separately in results. Never require private saves or live provider credentials for these checks.

## 7. Completion, release, and rollback

An intake cycle is complete when every new SHA is accounted for, actionable items have priorities/dependencies, and no deferred work disappears behind an advanced marker. A port is complete when acceptance criteria pass, upstream attribution and Metatron commit IDs are recorded, owning documentation is updated where contracts change, and remaining differences are explicit.

Before a compatibility release, exercise import/export and restore on an isolated synthetic or copied data directory. Keep the pre-change data snapshot and note any persistent schema change. Reverting a code commit is sufficient only when its data changes are backward compatible; otherwise use the documented restore/migration path. Keep each behavioral port separately revertible and avoid mixing it with unrelated refactors or upstream version bumps.

The release note should identify the adopted behavior, compatibility versions tested, deferred limitations, and rollback implications. Update Metatron's own `version.json` and `appVer` together when making a release.

For this planning task, verification is limited to local Git history, source/guide inspection, and validation of this document. No application tests or compatibility runs are claimed.
