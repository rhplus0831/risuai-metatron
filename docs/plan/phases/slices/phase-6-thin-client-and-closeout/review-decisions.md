# Review decisions: Phase 6 slices

GPT-6-Astra reviewed 11 points and Claude Opus 15; each line names the point, its short title,
the decision (adopt, adopt with changes, or reject), and what changed and why.

Every point was checked against `577c43ae` and the refined Phase 4 slices before deciding:
direct reads of the cited lines (`server/src/main.ts:40-50`; `rg -n '\.transaction\(' server/src`
outside tests is empty; `chatStore.svelte.ts:1286-1332` and `2196-2216`;
`resourceSync.svelte.ts:815-850` and `1084-1105`; `src/ts/setting/utils.ts:30-66` and the eight
`getValue`/`setValue` items in `displaySettingsData.svelte.ts:417-454`; `permissionStore.ts:37-60`;
`parser.svelte.ts:1680-1706`; `lastDate` has no reader; `checkPersonaBinded` at `util.ts:69`;
`characters.ts:600-720`), the Phase 4 slice folder, report, and decision record in full, and
the per-file matching-line counts re-run for every file the slices cite. The refined slices are
the ten files beside this one (spike, live updates, settings ownership, character ownership,
three reader slices, chats, aggregate removal, closeout); the drift, baseline, and boundaries
are in [`planning-notes.md`](planning-notes.md).

## Astra

- Astra P1, deferred events can be lost, and hydration can overwrite edits: adopt — verified (`acceptRemote` bumps `discardSequence`, records `discarded`, and
  deletes the dirty key; `finishIdleChatRefresh` rechecks after its await; `acceptRemoteCollection`
  clears pending order work). The live-apply function awaits `tick()`, rechecks dirty, in-flight,
  deferred, and quarantined state at application time, applies only a newer revision, and never
  records a discard; a skipped record or order goes into a pending set and is re-fetched when its
  local work settles, even without a further write; orders never go through
  `acceptRemoteCollection`; resync uses the same rules; the validation lists an event before the
  acknowledgement, an edit during the refetch, and a remote reorder during a local reorder.
- Astra P2, `afterSeq` does not yet provide Phase 5's callback guarantee: adopt — the `afterSeq` barrier is dropped; Phase 5's job-socket `resource` events
  stay authoritative for callbacks; the feed deduplicates through the newer-revision rule, which
  `applyHydration` adopts too (a proposed Phase 5 edit in the report); open question 3 deleted.
- Astra P3, restart detection cannot rely on the proposed cursor: adopt with changes — the restart hazard is real (the epoch survives a restart), but
  the fix is not a `{ epoch, feedId, seq }` cursor: the ring buffer, `since`, and `seq` are gone
  (Opus P3), the client reconciles through the revisions route on every `hello`, and a cursor
  with a process identity is therefore unnecessary; the persisted global commit sequence is not
  taken either. The manual check makes more than one change during the restart so replay cannot
  pass it.
- Astra P4, the chat event contract cannot support its consumers: adopt with changes — verified (`applyGroup` filters ignored checkpoints and replays
  and re-normalizes meta, so prepared ops are not applied effects; the draft summary lacked the
  parser's `saying`). Chat entries carry refs and revisions only; an observer fetches the chat; an
  unloaded chat refreshes its metadata summary. Not taken: publishing canonical applied deltas
  with predecessor and successor revisions (recorded as a later-phase alternative that needs
  `applyGroup` to report effects) and bounding a replay buffer (no buffer exists any more).
- Astra P5, server normalization needs a canonical acknowledgement path: adopt with changes — verified (`cycle` records the submitted text; `characterFormatUpdate`
  creates a chat, moves `postHistoryInstructions` into a note, stamps `lastInteraction`, fills
  `fmIndex`). Phase 3's approach is taken instead of returning canonical data: the pure defaults
  are applied by the client mutation functions at creation (`addCharacter`, `addModule`, the
  importers), the server normalizers are a backstop, Phase 3's startup pass persists their
  result; the four non-pure steps become import handling (`postHistoryInstructions`), the chat
  module's own creation defaults (`ensureChat`, `fmIndex`), and the pre-send `lastInteraction`
  write; obsolete save-layout migrations are dropped. Rejected part: batch results returning
  normalized data (transport work Phase 3 and 4 both declined) and a post-acknowledgement
  refetch.
- Astra P6, masked LLM secrets must not enter the generic write queue: adopt — the masked `llmSecrets` status is read-only and excluded from
  `queueRecordWrite` and whole-record serialization; credentials change through `setLlmSecret`,
  `clearLlmSecret`, and the Phase 5 preset routes; sibling fields through `updateLlmSecretSiblings(patch)`,
  which omits every masked path (the server keeping an omitted path is a proposed Phase 5 edit);
  the review test edits a sibling while credentials are set and asserts no masked payload enters
  a batch.
- Astra P7, intermediate projections lack an implementable compatibility boundary: adopt — Opus option (a): each ownership slice installs enumerable accessors on the
  raw root forwarding the migrated fields to the records (Phase 3's technique), keeps
  `forwarding.svelte.ts` (extended, deleted whole in `aggregate-removal`), and the reader
  migrations are separate file-grouped slices; the spike's implementation has a production owner
  (`records.svelte.ts`, created by `settings-ownership`); the order is spike and live updates,
  settings ownership, character ownership, readers, chats, aggregate removal; every zero-count
  gate is scoped to the slice's file group; the character record keeps `chats`/`chatPage` until
  the chat slice removes them (the contradiction is resolved).
- Astra P8, Phase 4 assumptions must adopt its actual modules and remaining writers: adopt — verified against Phase 4's slices: the modules `characterStore`,
  `collectionStore`, `pluginStorageStore` are extended under their names and only their
  transport is swapped; the `pluginStorage` watcher is already gone; Phase 4's allowlist of
  core-app writers (`src/ts` and `src/lib`) is assigned entry by entry to the reader slices; the
  `supaMemory` selection write and Phase 5's pre-send stamps have owners; `pluginContext.ts`
  decides which character a plugin getter or setter loads.
- Astra P9, lazy loading must preserve complete snapshots beyond the LRU: adopt — `readChatsDetached(chaIds)` is a bulk read independent of the screen cache
  for exports and plugin snapshots; the LRU bounds evictable entries only and pins selected,
  dirty, in-flight, deferred, quarantined, generating, and explicitly pinned chats; the plugin
  snapshots and the facade build the legacy `chats` array and a derived `chatPage` at the
  boundary; a synchronous reader is preloaded by its caller or stays a stopping condition and
  never receives incomplete data; the validation covers more than eight chats across several
  characters.
- Astra P10, not every resource has an event application owner: adopt — verified (`permissionStore` keeps its own `current`; `applyToMirror` has no
  `pluginPermissions` branch; `invalidateInlayCaches` is the inlay owner). The live-updates slice
  has a resource-kind dispatch inventory (records, characters including new members,
  chats, chat orders, inlays, permission grants, masked secrets) and treats collection membership
  as subscribed state; the validation adds a permission grant and a new character becoming
  visible in another idle tab.
- Astra P11, closeout checks conflict with preserved behavior: adopt — the greps exclude `risuai.d.ts` and the plugin docs, allow the snapshot
  builders and tests, and search `RisuSaveEncoder|RisuSaveDecoder` specifically; the manual check
  asserts that preset, persona, and chat selections do not propagate while preset edits, the
  five keep-on-switch fields, and the translator and HypaV3 `selectedId` values do.
- Astra drift check, the drift corrections: adopt — the normalization sources are `checkNewFormat` and
  `characterFormatUpdate` (drift 8 rewritten); `selectedCharID` is a derived adapter and not an
  exit gate, with U4 in the closeout's STRUCTURE edits; the character deferral removal rests on
  Phase 5's frozen execution scope, not on the lock protecting ordinary field updates; the
  baseline uses one metric (matching lines) with occurrences given once, and the assignment
  regex is recorded in the spike slice; the Phase 4 assumption table is applied (see P8).

## Opus

- Opus P1, `DBState.db` has no defined transitional state: adopt — option (a); same design as Astra P7.
- Opus P2, chat events carry the ops the server received, not what it applied: adopt — chat entries carry refs and revisions only; an observer that holds the chat
  fetches it (one read per checkpoint per observing tab); the effect-level alternative is
  recorded for a later phase.
- Opus P3, resume by `since` loses changes across a restart, and the `origin` skip breaks duplicated tabs: adopt — the ring buffer, `since`, `seq` in the read results, `origin`, and
  `x-risu-client` are dropped; the client reconciles through `GET /api/resources/revisions` on
  every `hello`, with the socket opened before the reconcile; the restart case is validated with
  more than one change made during the restart.
- Opus P4, live application has races: adopt — the dedicated live-apply function (`tick()`, recheck at application, apply
  only when the token's `seq` differs or the revision is higher, no discard); `applyHydration`
  adopting the rule is a proposed Phase 5 edit in the report.
- Opus P5, the `afterSeq` barrier is over-built: adopt — `afterSeq` deleted; Phase 5's `resource` events stay; open question 3 deleted.
- Opus P6, Phase 4 assumptions checked against the Phase 4 folder: adopt — every Phase 4 assumption rewritten against the Phase 4 slices: the modules
  under their names, the wrappers, the allowlist with owners, the async bridge, `pluginContext.ts`
  for the getters and setters; the dead "create the module if Phase 4 routed through
  `setCurrentCharacter`" branch removed.
- Opus P7, plugin setters that pass whole characters drop changes under lazy loading: adopt — verified (`reconcileCharacterChats` looks chats up with `mirrorChat`, creates
  the rest, and deletes only loaded chats). The plugin character setters await `loadChats(chaId)`
  and pin during reconcile, membership comes from the chat order record, and "`setChar` after
  eviction" is a review test.
- Opus P8, the manual check expects a preset switch to propagate: adopt — the manual check asserts the opposite: selections stay per tab, the
  keep-on-switch fields and the translator and HypaV3 `selectedId` values propagate.
- Opus P9, slices 3 and 4 cannot run in parallel and are each too large: adopt — settings ownership and character ownership run one after the other; each is
  an ownership flip plus separate file-grouped reader slices (settings pages, settings
  consumers, characters) that run in parallel; `ModuleSettings.svelte:87-90` is the character
  reader slice's.
- Opus P10, the chat summary is over-built and lacks the field one reader needs: adopt — verified (`lastDate` has no reader; `MobileCharacters.svelte:62` reads the
  chat count; the parser reads the last message's `saying`). The summary is the stored `meta`
  projected to `{ name, folderId, bindedPersona, fmIndex }` with the revision, no aggregate query
  and no memory data; the chat count comes from the order record; `risuChatParser` and
  `checkPersonaBinded` read loaded chats only (recorded as the rule).
- Opus P11, plugin `getDatabase()` loads every chat through the LRU: adopt — plugin `getDatabase()` with `characters` does a one-off server read
  (`readChatsDetached`) bypassing the loaded-chat map; folded in as settled by the phase file.
- Opus P12, validation greps cannot pass as written: adopt — `RisuSaveEncoder|RisuSaveDecoder` for the codec check; `risuai.d.ts` and the
  plugin docs excluded from the other greps; the plugin host function names are allowed.
- Opus P13, the write-through proxy is an implicit write path: adopt — the spike carries the owner verdict line (the write-through record is the
  mutation boundary, or the fallback applies) and its proofs include the allowlist's
  direct-assignment shapes (handler assignments, `push`/`splice`/`sort`/`unshift`, whole-array
  replacement, the cast form).
- Opus P14, minor contract slips: adopt — `snapshots.svelte.ts` (or a JSON clone in a plain `.ts`); U4 in the closeout;
  the `supaMemory` write becomes `updateCharacter` in `character-ownership`; the registry's
  item-level `getValue`/`setValue` functions are retargeted with the condition functions; the
  `resourceSync` rename is dropped.
- Opus P15, several open questions are already settled: adopt — Q4, Q5, Q7, Q8, Q9, Q10 folded into the slices (whole-record writes are Phase
  3's choice; `selectedCharID` is not a gate; the LRU and prefetch are stated in the chat slice;
  `getDatabase("all")` reads the server once; the archive convention is the existing one: the
  plan leaves the tree, `docs/plan/README.md` says None, the behavior changes go to
  `persistence.md`'s Known Hazards; `Database` stays a type alias); Q1 stated as decided (refs
  only), Q2 (observer granularity) and Q6 (trash pruning) stay open.
- Opus drift check and missed items, the drift corrections and missed items: adopt — `main.ts:46` (verified); `transaction` has no
  production caller (verified; the live commit points are the other four); drift 11 rewritten to
  the existing archive convention; drift 15 rewritten (the `resource` events stay); the Phase 4
  renames and removals applied; `reconcileCharacterChats` (P7); the `supaMemory` write; the
  registry item functions; U4.

## Counts

Astra (11 points): adopt 8 (P1, P2, P6, P7, P8, P9, P10, P11), adopt with changes 3 (P3, P4, P5),
reject 0; the drift-check section is adopted as written. The rejected parts are named inside P3
(no `feedId` cursor and no persisted commit sequence: nothing is replayed), P4 (no canonical
applied deltas and no replay-buffer bound in this phase), and P5 (no normalized data in batch
results and no post-acknowledgement refetch).

Opus (15 points): adopt 15 (P1 to P15), adopt with changes 0, reject 0; the drift check and the
missed items are adopted as written.

No point was rejected outright: none of the two reviews' points rests on production data,
multi-user deployments, or an unreachable scenario; every scenario cited (two tabs of one user,
a duplicated tab, a server restart, a plugin setter after an eviction) is reachable in this
project.
