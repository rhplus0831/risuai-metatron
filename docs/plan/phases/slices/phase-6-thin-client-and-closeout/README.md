# Phase 6 Slices: Thin Client And Closeout

Drafted 2026-09-30 before Phases 3 to 5 started, as a validation of
[`phase-6-thin-client-and-closeout.md`](../../phase-6-thin-client-and-closeout.md) against the
tree after Phases 0 to 2 (commit `577c43ae`) and against the planned slices of Phases 3, 4, and
5, then refined after reviews by GPT-6-Astra (11 points) and Claude Opus (15 points); the
decision on every point is in [`review-decisions.md`](review-decisions.md) and the drift,
baseline, boundaries, and open questions are in [`planning-notes.md`](planning-notes.md). This
phase is the one
Phases 3 to 5 change the tree under most, so it is expected to be re-planned at phase start:
every slice's Assumptions section names the Phase 3, 4, or 5 decisions it rests on, and
re-verification is a diff against those lines. Every slice is `planned`.

The value of this draft is the dependency picture: what each projection needs from the earlier
phases, the transitional state of `DBState.db` between slices (a facade of accessors over the
records, so every slice ships on its own), and how live updates fit the Phase 5 socket rather
than adding a second one. The slices extend Phase 4's modules (`characterStore.svelte.ts`,
`collectionStore.svelte.ts`, `pluginStorageStore.svelte.ts`, `pluginContext.ts`) under their
existing names and swap their transport; they do not create a second mutation surface.

Execution order (arrows are dependencies; slices on one line may run in parallel):

1. [`spike-projection-bindings.md`](spike-projection-bindings.md): a vitest-only harness that
   decides the binding pattern every record uses (accessor-backed versus a deep write-through
   record) over the 394 `bind:` sites' shapes and Phase 4's allowlist shapes; the owner verdict
   that the write-through record is the mutation boundary. No production code. Parallel with 2.
2. [`live-updates.md`](live-updates.md): the after-commit change feed in the resource store,
   the `/api/events/ws` socket on the Phase 5 upgrade dispatcher (JWT only), refs-and-revisions
   events, a revisions reconcile on every `hello`, and a live-apply that rechecks at
   application time, applies only newer revisions, never records a discard, and remembers a
   skipped record until its local work settles. Phase 5's job-socket `resource` events stay.
   Parallel with 1.
3. [`settings-ownership.md`](settings-ownership.md) (needs 1): the section and collection kinds
   become write-through records under Phase 4's `collectionStore`, `DBState.db` gets forwarding
   accessors for every migrated field, the section watchers are deleted, the masked
   `llmSecrets` status is read-only with explicit credential methods, the module defaults move
   to creation with a server backstop.
4. [`character-ownership.md`](character-ownership.md) (needs 3): the character records, the
   list summary, the id-based selection with `selectedCharID` as a derived shim, the character
   watchers and `markCharactersDirty` deleted, `characterFormatUpdate` split into creation
   defaults and explicit steps with a server backstop.
5. [`readers-settings-pages.md`](readers-settings-pages.md) (needs 3): every reader and
   allowlist writer under `src/lib/Setting` and the registry moves to the records. Parallel
   with 6 and 7.
6. [`readers-settings-consumers.md`](readers-settings-consumers.md) (needs 3): the settings
   readers outside the settings pages (`Others`, `Playground`, `UI`, the chat screens' settings
   reads, `gui`, `hotkey`, translator, TTS, image generation, models, tokenizer, parser,
   persona, MCP, the plugin host reads). Parallel with 5 and 7.
7. [`readers-characters.md`](readers-characters.md) (needs 4; after 6 in the shared files):
   `CharConfig`, the sidebar and lists, the lorebook editors, the chat screens' character reads,
   the core-app character writers of Phase 4's allowlist, the selection writers.
8. [`chat-projection-and-lazy-loading.md`](chat-projection-and-lazy-loading.md) (needs 2, 4,
   7): metadata-only chat summaries at boot, full chats loaded on selection with pins and an
   LRU over evictable entries, detached bulk reads for exports and plugin snapshots, plugin
   setters loading and pinning before reconcile with membership from the order record,
   `chats`/`chatPage` leaving the character type.
9. [`aggregate-removal.md`](aggregate-removal.md) (needs 5 to 8): `DBState`, the facade with
   the Phase 3 accessors and shims, `getDatabase`, `setDatabase`, `setDatabaseLite`, the
   wrappers, `saveDb` deleted; snapshot builders for the plugin subset, the settings report, and
   the backup inventory; `NodeStorage` split; boot over the modules; the counts measured with
   scoped greps.
10. [`closeout-and-docs.md`](closeout-and-docs.md) (needs all): the `proxyStreamJobs` server
    kind removed, the browser caches recorded, the transform's Lua cost measured, the two-client
    convergence check, the guides, D1 to D4 and U4, the tables, the plan removed from the tree
    per the archive convention.

```
1 spike ─→ 3 settings ownership ─┬─→ 5 readers: settings pages ──────────┐
                                  ├─→ 6 readers: settings consumers ──────┤
                                  └─→ 4 character ownership ─→ 7 readers: characters ─→ 8 chats ─┼─→ 9 aggregate removal ─→ 10 closeout
2 live updates ───────────────────────────────────────────────────────→ 8 ───────────────────────┘
```

The order flips the source of truth first (invariant 3): slices 3 and 4 install the records
under the flat mirror and forward every migrated field to them, so the reader slices are
mechanical file-grouped moves that ship independently, and slice 9 deletes the object when the
scoped greps are clean. Slices 3 and 4 run one after the other (both edit the adapter and the
facade). Live updates come first because they apply to the flat mirror through the functions a
conflict reload uses today, so the records inherit them without a second application path. Ten
slices against the brief's four to seven: both reviewers asked for the ownership flips and the
reader migrations to be separate, and for the reader migrations to be file-grouped.

Phase 5 boundaries this phase owns: the feed is a second push path beside the job socket's
`resource` events, deduplicated by the newer-revision rule (slice 2; `applyHydration` adopting
the rule is a proposed Phase 5 edit); observer sockets are not added (checkpoints reach observers
through the feed); the `proxyStreamJobs` server kind, the `hypaVector` and `tfCache` caches, and
the transform's per-request Lua cost (slice 10). Phase 4 boundaries: the modules are extended
under their names (slices 3, 4, 8), the allowlist entries each have an owning slice (5, 6, 7),
and `pluginContext.ts` (`invokeHook`, `currentContext`) decides which character a plugin
getter or setter loads (8). Phase 3
boundaries: selection reconciliation survives collection replacement (slices 2 and 3),
`localStorage` selections stay boot preferences and never propagate (slices 2, 8, 10), the flat
compatibility projection, the off-database secret state, the section ownership map, and the
remaining adapters have removal boundaries (slices 3, 4, 9), and the translator and HypaV3
`{ items, selectedId }` records are unpacked by the settings records (slice 3).
