# Implementation Audit Fixes Plan

Status: drafted 2026-11-05; landed: T1 (4ddbedc0b), C1 (f7b51a4ef), T5 (ceb668290), C3 (dd5f59b52), M1 (fb5dd3edc), T2 (b5372b93b), P1 (b4e78facc), M3 (a4513d4d0), C4 (87b523b1f), H3 (6d317482d), M2 (696a93c21), T4 (3379b6781), H1 (e8e8173e5), P3 (b14560182), H4 (8367c3986), A1 (7604b836f), C2 (9310bf523), M5 (8243ded32), R1 (b29c272ed), H5 (73e4cb555), A2 (06f4b852b), M4 (549c166a2), H6 (f884f5c25), A5 (8d5453a86), R2 (70850bb16), R3 (9ab1ef7ee), P2 (b71dbe54e), M8 (ce26ed366), H7 (b857a8156), M6 (1934c4711), M9 (4223ee011), P4 (eb7fa8a56), A4 (de86f0225), H2 (c57d197a3). The owner confirmed the recommendation of all three questions on
2026-11-05.

Sources: the seven implementation audits of 2026-11-05 under `docs/manual-audit/`, all made against `dev` at
`65e97f91f`: [Asset Lifecycle](../manual-audit/asset-lifecycle-code-audit-2026-11-05.md) (AL1–AL8, U1–U2),
[Incremental Chat Transport](../manual-audit/incremental-chat-transport-2026-11-05.md) (ICT-01–07,
OTHER-01–03), [Job Handoff](../manual-audit/job-handoff-2026-11-05.md) (JH1–JH7, U1–U2),
[Plugin Storage and Data API](../manual-audit/plugin-storage-data-api-2026-11-05.md) (PS1–PS9, U1–U2),
[Render Work Budget](../manual-audit/render-work-budget-2026-11-05.md) (RW1–RW8, U1–U4),
[Reroll Candidates](../manual-audit/reroll-candidates-2026-11-05.md) (RC1–RC9, U1–U3), and
[Structured Memory](../manual-audit/structured-memory-2026-11-05.md) (C1–C7, E1–E6, U1–U2). `dev` is
`9ec3ca919` today; the two commits since the audited tree are documentation only, so the audits' line numbers
still hold. Identifiers are the anchors; re-verify each cited location before editing (STRUCTURE.md protocol
step 5). Every finding has a disposition in the **Index**: a slice here, **Excluded** as an edge case (the
owner's instruction for this plan), **Deferred**, or **Merged** into another finding's slice.

Selection rules, in the order they were applied:

1. Every P1 (RC1, C1): a slice.
2. A correctness, recovery, resource, or performance finding whose trigger is an ordinary operation (a send, an
   append, a plugin read, a reconnect, an import, a cleanup, a render, an export) and whose fix the audit
   describes: a slice, whatever its priority label. A P3 on an ordinary path is included; a P2 on an edge path is
   not.
3. **Excluded as an edge case**: a finding whose trigger the audit itself qualifies as malformed or adversarial
   input, imported or manual data no screen produces, a size no ordinary chat or message reaches, a race that
   needs a settings change or a withdrawn render during one in-flight request, or an unverified lead; and a
   finding the audit records as a design limitation. Each is listed under **Excluded as edge cases** with its
   reason, so a later plan can take it without rereading the reports.
4. **Deferred**: a fix that needs a lifetime design on a fallback path (AL U1 only).
5. **Merged**: one defect two audits found is one slice (PS5 with E4; OTHER-02 with RC5).

One slice is one session, one commit, one file cluster. Each slice names its owning guide from `STRUCTURE.md`
Choose By Task; that guide's `Invariants` apply, and the slice updates the guide's `Flows`, `Invariants`, or
`Known Hazards` where it changes a documented contract (byte ratchet: a sentence added at the ceiling is paid
with a trim). Workflow per slice: `opus-lite` for _small_, `opus-workflow` for _hard_. Each slice ends with its
regression tests (under _Test_), `pnpm check`, `pnpm --silent test:agent` for the files it touches and then once
whole, the guide's focused checks, and `pnpm format:check`. Code, tests, and comments describe the behavior,
never the finding id (T5). Tests assert operation counts, payload bytes, or controlled orderings, never elapsed
time (V3). A slice does not edit the audit reports or `found-issues.md`: the inbox entries it closes (under
_Removes_) are deleted in the landing commit that marks the slice landed here. When the plan retires, the seven
reports move to `docs/manual-audit/archive/` and the **Excluded** and **Deferred** findings move to
[found-issues](../research/found-issues.md) or the owning guide's Known Hazards, in the retirement commit.

Rules every slice checks, from the recurring blind spots of the
[plan design audit](../manual-audit/archive/plan-design-audit-2026-11-04.md):

- A new SQLite table or index is created at open with `CREATE … IF NOT EXISTS`, beside the `changes` table in
  `server/src/data/resourceStore.ts`; `STORE_TABLES_SQL` and `CHAT_TABLES_SQL` run on a fresh database only.
  Snapshot restore and import open the same way, so the schema step runs there too.
- A feed row is measured whole against `MAX_FEED_PATCH_BYTES`; a patch form that grows a row past the cap falls
  back to a reference, which every other tab reads whole.
- A `patchMessage` inside a job group closes an open generation fence: order the writes.
- `sendSocket` counts any open socket as a delivery; a bound on queued bytes is `bufferedAmount`, never presence.

## Decisions

The owner confirmed each recommendation on 2026-11-05; the gated slices implement the decision.

| Q   | Question                                                                                                                                                                                                                                                                              | Decision                                                                                                                                                                                                                                                | Gates |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Q1  | AL4: a File or Blob PNG import can replay an asset from a byte range, but a one-shot stream has no source to reread. Keep the whole encoded payload for streams (today's behavior, bounded only by the card), or add an operation-scoped server hold with explicit finalization?      | Range-backed replay for File/Blob now; streams keep the current retention and the assets guide records it as a Limitation. The server hold is a protocol addition for the rare one-shot path and is not worth a slice here.                             | A4    |
| Q2  | JH6: with the creator watching, every socket gets one shared wire event, so the worker loses compact `streamed` checkpoints (122× bytes in the audit's fixture). Serialize an owner projection and a viewer projection of one `sentChat` baseline, or accept the documented behavior? | Two projections: the owner keeps stream references, viewers keep full rows. Creator-keeps-watching is the common handoff, and the cost grows with checkpoint count × reply length.                                                                      | H5    |
| Q3  | C1: when a repaired old window's scene differs from the current scene, should the fix protect the later committed state (the historical path: no scene or thread effect from an old window) or replay the later history so an edit can change what followed?                          | Protect later state with the existing historical path. A replay of dependent later history is a writer design of its own; an edit that should change later memory goes through Record now or a rebuild from that point, which the panel already offers. | M1    |

## Index

Every finding, by audit and id, with its disposition. Priorities are the audits'.

| Audit                      | ID          | Finding                                                                  | Disposition                                                             |
| -------------------------- | ----------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Asset Lifecycle            | AL1 P2      | Cleanup can delete freshly reused inlay metadata                         | A1                                                                      |
|                            | AL2 P2      | A rejected snapshot restore shows a success notice                       | A2                                                                      |
|                            | AL3 P2      | Import preflight charges for assets that will not be copied              | A3                                                                      |
|                            | AL4 P2      | Streamed PNG imports retain every asset payload until completion         | A4 (Q1)                                                                 |
|                            | AL5 P2      | Unterminated inlay markers make the scanner quadratic                    | Excluded: malformed input                                               |
|                            | AL6 P2      | Candidate-list rebuilding makes cleanup quadratic                        | A5                                                                      |
|                            | AL7 P2      | Each cleanup batch reloads all unchanged snapshot references             | A5                                                                      |
|                            | AL8 P3      | Scan polling repeatedly transfers the previous complete report           | A2                                                                      |
|                            | U1 P2       | Fallback media URLs retain blobs beyond the cache's byte limit           | Deferred: media URL lifetimes                                           |
|                            | U2 P2       | Version-2 backup export vacuums its database on the serving thread       | A6                                                                      |
|                            | lead        | Mutable custom keys can change during export                             | Excluded: unverified                                                    |
| Incremental Chat Transport | ICT-01 P2   | Row reads scan the chat despite requesting one id                        | T1                                                                      |
|                            | ICT-02 P2   | Earlier completed replies travel whole in later checkpoints              | T2                                                                      |
|                            | ICT-03 P2   | Interrupted replay loses the usable cursor baseline                      | T3                                                                      |
|                            | ICT-04 P2   | Every logged commit scans the retention window                           | T4                                                                      |
|                            | ICT-05 P2   | Tiny diffs and stream references deep-copy complete rows                 | T5                                                                      |
|                            | ICT-06 P3   | Repeated missing ids rebuild the complete position index                 | T5                                                                      |
|                            | ICT-07 P3   | Owner checkpoints copy and compare full-history baselines                | T2                                                                      |
|                            | OTHER-01 P2 | Large-transcript deletion can throw before queuing the edit              | T5 (the spread; the 200,000-row crash itself is a size edge)            |
|                            | OTHER-02 P2 | Reroll bookkeeping parses history on ordinary appends and swipes         | Merged into RC5 (C4)                                                    |
|                            | OTHER-03    | Earlier insertion discards a still-selectable carrier's snapshots        | Excluded: recorded design limitation (D6 rule)                          |
| Job Handoff                | JH1 P2      | A stale targeted offer blocks automatic absent-owner rescue              | H1                                                                      |
|                            | JH2 P2      | One transient HTTP failure suppresses further attempts at an open offer  | H2                                                                      |
|                            | JH3 P2      | Retaking a lost takeover can repeatedly download the whole chat          | H3                                                                      |
|                            | JH4 P2      | A former worker reports a running job as ended after reconnecting        | H3                                                                      |
|                            | JH5 P2      | A slow creator-viewer has no outbound queue bound                        | H4                                                                      |
|                            | JH6 P2      | Keeping the creator as a viewer disables compact checkpoints             | H5 (Q2)                                                                 |
|                            | JH7 P3      | Early-notice audience partitioning is quadratic                          | H6                                                                      |
|                            | U1 P2       | Attaching repeatedly sorts the entire remaining notice queue             | H6                                                                      |
|                            | U2 P2       | Plugin-provider streams upload the full prefix at every update           | H7                                                                      |
| Plugin Storage             | PS1 P2      | An older consent write can restore a remotely revoked permission         | P1                                                                      |
|                            | PS2 P2      | Switching to Structured Memory during a detached read omits projection   | Excluded: settings change during one in-flight read                     |
|                            | PS3 P2      | Small writes still cause whole-record downloads in observing tabs        | P2                                                                      |
|                            | PS4 P2      | A tiny nested storage patch traverses megabytes of unchanged JSON        | P2                                                                      |
|                            | PS5 P2      | Structured Memory chats are retained in a cache that will not reuse them | P3 (with E4)                                                            |
|                            | PS6 P2      | Concurrent cold reads download the same chats independently              | P3                                                                      |
|                            | PS7 P2      | A one-chat page repeatedly constructs the whole character's chat list    | P4                                                                      |
|                            | PS8 P2      | A blocked flush makes a loaded one-chat page fetch every other chat      | P3                                                                      |
|                            | PS9 P2      | Indexed storage enumeration repeatedly scans every plugin's keys         | P4                                                                      |
|                            | U1 P2       | The sandbox drops an own `__proto__` field from a returned JSON value    | Excluded: a stored key named `__proto__`                                |
|                            | U2 P3       | Character reconciliation repeatedly scans the full character list        | P4                                                                      |
| Render Work Budget         | RW1 P2      | Failed translation attempts keep dispatching and overlap their retries   | R2                                                                      |
|                            | RW2 P2      | Completed cache hits wait behind unrelated provider requests             | R1                                                                      |
|                            | RW3 P2      | A replacement render can lose the departed render's cache bypass         | Excluded: withdrawn forced target while a sibling holds the chunk       |
|                            | RW4 P2      | A single row can exceed the screenshot page's pixel budget               | Excluded: a row over 64 M device pixels; see Deferred screenshot memory |
|                            | RW5 P2      | Unmounting highlighted editors rebuilds every survivor's ranges          | R3                                                                      |
|                            | RW6 P2      | Code highlighting continues after an awaited language load               | R3                                                                      |
|                            | RW7 P2      | Identical non-LLM cache misses still send duplicate provider requests    | R1                                                                      |
|                            | RW8 P2      | One surviving target keeps obsolete plugin work and continuation text    | R4                                                                      |
|                            | U1 P2       | Google JSON errors can be cached as successful untranslated text         | R1                                                                      |
|                            | U2 P2       | Concurrent chunks evict their own pending plugin snapshots               | R4                                                                      |
|                            | U3 P2       | A settled row's changed source can bypass the cached-only probe          | R5                                                                      |
|                            | U4 P2       | Screenshot rows repeat font preparation and accumulate font rules        | R6                                                                      |
| Reroll Candidates          | RC1 P1      | Lua reads and writes use different message indexes during rerolls        | C1                                                                      |
|                            | RC2 P2      | An acknowledged append leaves the writing tab's candidate state stale    | C2                                                                      |
|                            | RC3 P2      | Abandoned generation fences prevent subsequent checkpoint cleanup        | C3                                                                      |
|                            | RC4 P3      | Import warnings miss unavailable inlays in alternate candidates          | Excluded: imported swipes that reference inlays the backup lacks        |
|                            | RC5 P2      | Carrier validation and checkpoint cleanup scan historical candidates     | C4                                                                      |
|                            | RC6 P2      | Repeated Lua history reads become quadratic during reroll assembly       | C1                                                                      |
|                            | RC7 P2      | Importing a long swipe history repeatedly shifts almost the whole array  | Excluded: over 1,000 swipes on one message                              |
|                            | RC8 P3      | Unchanged candidate fields on a whole-row edit force a full-chat refresh | C2                                                                      |
|                            | RC9 P3      | Variable provenance work runs even without an active reroll              | C3                                                                      |
|                            | U1 P2       | Saving prompt text invokes mutable `editRequest` handlers twice          | C5                                                                      |
|                            | U2 P2       | Updating only `isComment` leaves an already-mounted row stale            | C6                                                                      |
|                            | U3 P2       | A trigger stage with no triggers deep-copies the entire chat twice       | C7                                                                      |
|                            | note        | A malformed native `candidates: []` suppresses swipe conversion          | Excluded: mixed-format malformed input (the audit's own label)          |
| Structured Memory          | C1 P1       | Re-recording an old event replaces the current scene                     | M1 (Q3)                                                                 |
|                            | C2 P2       | Locked sections consume patch budget and starve editable pages           | M2                                                                      |
|                            | C3 P2       | Retracting evidence leaves the threads it opened or completed unchanged  | M3                                                                      |
|                            | C4 P2       | Correcting a group message's speaker does not invalidate its memory      | M4                                                                      |
|                            | C5 P2       | Evidence fallback ignores uncovered history that the same send trims     | M5                                                                      |
|                            | C6 P3       | Rebuild preserves imported threads but loses their participants          | Excluded: imported or manual thread data                                |
|                            | C7 P3       | An older health response can overwrite a newer post-repair badge         | Excluded: reordered advisory reads; cheap if `readHealth` is touched    |
|                            | E1 P2       | Retrieval caps apply after potentially large foreground embedding work   | M6                                                                      |
|                            | E2 P2       | Rebuild/backfill cost estimation scans the transcript once per window    | M7                                                                      |
|                            | E3 P2       | One source edit reads every nonretracted event body                      | M8                                                                      |
|                            | E4 P2       | Unchanged unloaded structured chats are downloaded again on every read   | Merged into PS5 (P3)                                                    |
|                            | E5 P3       | Each log page enumerates and sorts the complete record lists again       | M9                                                                      |
|                            | E6 P3       | Pages and Threads refresh duplicate the parent's contents request        | M9                                                                      |
|                            | U1 P2       | Custom embedding endpoints collide in the shared vector cache            | M10                                                                     |
|                            | U2 P2       | Warm vector admission performs quadratic duplicate scans                 | M10                                                                     |

## Order

Every slice is independent of the others' code unless a file below is shared; shared files run serially in
the order given (the runner puts them in separate waves).

- `server/src/data/chatStore.ts`: T1 → C3 → C4 → C2 → M4.
- `src/ts/storage/chatStore.svelte.ts`: T5 → H3 → C2 → P4.
- `server/src/jobs/generationJobs.ts`: T2 → H1 → H4 → H5 (H5 builds on T2's completed-row rule).
- `server/src/jobs/channel.ts`: H6 → H7.
- `server/src/data/resourceStore.ts`: T4 → P2.
- `src/ts/plugins/apiV3/v3.svelte.ts`: P1 → P3 → P4.
- `src/ts/translator/translator.ts`: R1 → R2. `src/ts/parser/transformClient.ts` and
  `server/src/prompt/transform.ts`: R4 alone.
- Structured memory: M1 → M2 (`writer.ts`, `patches.ts`); M3 → M8 (`reconcile.ts`); M5 → M6 (`retrieve.ts`,
  `step.ts`); M6 → M10 (`embeddings.ts`); M4 → M8 → M9 (`memoryStore.ts`).
- Guides: A1, A5 and A2's server part edit `self-host-server.md`; A3, A6, T1, C3, C4 edit
  `server-resources.md`; T2, H1, H4, H5, H6, H7 edit `server-generation.md`; T5, H3, C2 edit `chat-store.md`;
  P1–P4 edit `plugin-sandbox.md`; R1, R2 edit `translation.md`; R3, R4 edit `cbs-rendering.md`; M1–M10 edit the
  `structured-memory/` pages. Two slices on one guide land in the order above or rebase.
- Sessions: A2, A3, A5, A6, T1, T3, T4, H2, H4, H6, P4, R3, R5, R6, C3, C5, C6, C7, M3, M4, M7, M9, M10 are
  _small_; A1, A4, T2, T5, H1, H3, H5, H7, P1, P2, P3, R1, R2, R4, C1, C2, C4, M1, M2, M5, M6, M8 are _hard_.
  Three sessions at a time is the runner's default; the chains above make most of the run serial inside an
  area, so run areas in parallel (one asset, one transport or handoff, one plugin or render, one memory slice).

## Slices

### A. Asset lifecycle

- **A1. A reused inlay is not an orphan** (_hard_, `self-host-server.md` with `chat-pipeline.md`).
  `server/src/data/assetLifecycle.ts`: the orphan candidate map (built around the chunked scan, read by the
  sweep's deletion recheck, ~806–817 and ~1235–1256) records id, age, and bytes but not the inlay record's
  revision. Record the scanned revision; at deletion, a current revision that differs is a replacement, so the
  candidate drops out and its maturity restarts. Add a recent-use claim for inlay ids (the per-key publish
  claims that already protect asset files are the model): `writeInlayImage` and the existing-image shortcut of
  `getCharacterImageMain` / `getPersonaImageMain` in `server/src/lua/bindings.ts` (~771–782, ~1675–1696) and
  the client `src/ts/process/files/inlays.ts` (~340–353, ~400–405) claim the id when they hand out a marker,
  ordered against the sweep's metadata deletion (the claim is checked inside the same synchronous recheck-and-
  unlink turn, as the file leases are). A revision check alone does not protect the no-write shortcut.
  _Done_: a sweep that runs between a script's reuse of an orphan inlay id and the message write that
  references it deletes neither the rewritten metadata nor the metadata of an id the shortcut just returned.
  _Test_: `server/src/tests/assetLifecycle.test.ts` (hold the referencing message write pending while a sweep
  attempts a rewritten id and a just-claimed id; both survive), `server/src/tests/luaBindings.test.ts` (the
  shortcut claims), `src/ts/process/files/tests/inlays.test.ts`.
  _Closes_: AL1.

- **A2. Storage panel: a refused restore says so, and polling asks for status** (_small_, `settings-i18n.md`
  with `self-host-server.md`). `src/lib/Setting/Pages/Advanced/StoragePanel.svelte` `restore` (~223–239):
  a caught `ResourceEpochMismatchError` keeps the reload but shows a conflict notice (a new `language.storage.*`
  string, U2) instead of `language.storage.restored`; success shows only after a successful restore response.
  Polling (~108–127): the panel polls a small status response (`running`, a report version or `generatedAt`)
  and fetches the full report only when the version changed or the run ended; `server/src/routes/assetLifecycle.ts`
  (~19–35) gets that status route (or a conditional form of the report route) and `assetLifecycle.ts`'s
  `running` getter (~1399–1406) supplies the version. The initial load and the completion still read the
  complete report, authenticated as today.
  _Done_: an HTTP 412 on restore shows the conflict notice and reloads; a one-minute scan transfers the
  candidate lists once at the end, not once per second.
  _Test_: `src/lib/Setting/Pages/Advanced/StoragePanel.test.ts` (the existing 412 case at ~441–444 also
  rejects the success notice; a scan poll counts full-report reads), `src/ts/storage/tests/assetLifecycleClient.test.ts`,
  `server/src/tests/assetRoute.test.ts` (the status route).
  _Closes_: AL2, AL8.

- **A3. Import preflight charges only the assets it will copy** (_small_, `server-resources.md`).
  `server/src/routes/backups.ts`: the post-spool preflight (~538–545) adds every asset record's length; charge
  only assets whose content-named file is absent or fails verification, as `restoreValidated` (~624–636)
  decides, keeping the database, safety-copy and margin estimates. Re-check the required allocation under the
  same lock the staging runs under (or immediately before staging each newly required asset), so a presence
  check outside the lock cannot race a deletion.
  _Done_: a version-2 archive whose assets are all present and verified imports with free space for the
  database alone; an archive with one absent 8 MiB asset still needs that 8 MiB.
  _Test_: `server/src/tests/backups.test.ts` (injected `statfs`, an existing verified asset: 200 with the
  asset present, 507 with it absent and the space short).
  _Closes_: AL3.

- **A4. PNG import replays assets from byte ranges, not retained strings** (_hard_, `assets.md` with
  `characters-modules.md`; Q1). `src/ts/storage/assetQueue.ts` `saveAssets` (`replay` at ~283, the final
  claim pass at ~375–387 and ~469–488) keeps each canonical asset's `AssetSaveItem` until every upload ends,
  and `src/ts/characterCards.ts`'s PNG generator (~316–377) yields `load: () => Buffer.from(value, "base64")`
  over the whole chunk string. For File/Blob input, yield a loader that re-reads the chunk's byte range from
  the file (`Blob.slice`) and decodes on demand, so a replayed item holds offsets, not text; keep the final
  presence guarantee. Q1 (decided): a one-shot stream keeps today's retention; record it in `assets.md`
  Known Hazards > Limitations.
  _Done_: during a 24-asset PNG import, no uploaded asset's encoded payload is reachable from the queue after
  its upload settled; the final presence check still re-uploads a missing asset.
  _Test_: `src/ts/storage/tests/assetQueue.test.ts` (a loader-ownership probe: replayed items expose no
  payload string after upload; the re-upload case), `src/ts/characterCardsPngImport.test.ts` (range loaders
  decode the same bytes).
  _Closes_: AL4.

- **A5. Cleanup keeps its report prefix and snapshot index** (_small_, `self-host-server.md`).
  `server/src/data/assetLifecycle.ts`: after each unlink the sweep rebuilds the report with
  `[...candidates.values()].slice(0, ASSET_LIST_CAP)` (~1280–1291); refresh the visible prefix once per batch
  from an iterator stopped at the cap, keeping the full map for selection and safety. Each batch (~1140–1166,
  ~1183) reloads every retained snapshot's `snapshotRefs` and `snapshotInlays` and re-sorts; keep one merged
  snapshot index for the sweep, rebuilt only when the listed snapshot ids change, and keep listing snapshots and
  indexing new ones under `exclusive` per batch. Start `longestSynchronousTurnMs` before the reconstruction so
  it counts.
  _Done_: deleting 1,510 of 1,510 candidates visits the map about once per batch, not 1,139,295 entries; five
  unchanged snapshots are queried once per sweep, not once per batch.
  _Test_: `server/src/tests/assetLifecycle.test.ts` (instrumented map visits and snapshot-tail queries per
  sweep; the new-snapshot-during-sweep safety case stays).
  _Closes_: AL6, AL7.

- **A6. Version-2 export vacuums off the serving thread** (_small_, `server-resources.md`).
  `server/src/routes/backups.ts` (~324–345): move the staged database's credential removal and `VACUUM` into a
  worker (the import worker in `server/src/tests/upstreamImportWorker.test.ts`'s subject is the model),
  awaited by the route; credentials are still removed from live rows and freed pages. Add the disk preflight
  for the staging copy plus vacuum temporary space (`statfs`, the import's margin), refusing before staging.
  _Done_: an export with a 32 MiB description blocks the event loop for no synchronous `VACUUM`; zero free
  bytes refuse the export before a staging file exists.
  _Test_: `server/src/tests/backups.test.ts` (a `DatabaseSync.exec` spy sees no `VACUUM` on the main thread;
  injected `statfs` refusal; the archive still verifies).
  _Closes_: AL U2.

### T. Incremental chat transport

- **T1. A one-row read is an id lookup** (_small_, `server-resources.md`). `server/src/data/chatStore.ts`
  `selectPatchMessages` (~1413–1416, used by `touchedRows` ~1673 and `readRows` ~2718): drive the query by the
  requested ids (`sqlite_autoindex_messages_1 (chatSeq=? AND id=?)`) and order the small result afterwards,
  preserving predecessor anchors and insertion order; confirm with `EXPLAIN QUERY PLAN` in the test, not with
  the unary-plus spelling. `countMessages` (~1411, run at ~1847 on by-id writes): keep a per-chat count in the
  chat row or a transactionally maintained cache, invalidated by every append, removal, import and restore.
  _Done_: a one-id read of a 10,000-message chat plans as an index search on `(chatSeq, id)`; a text-only
  checkpoint runs no `COUNT(*)` over the chat.
  _Test_: `server/src/tests/chatFeedPatches.test.ts` (the query plan beside the row-yield count at
  ~1009–1039), `server/src/tests/chatStore.test.ts` (the count survives append, remove, restore).
  _Closes_: ICT-01.

- **T2. Checkpoints stop resending finished replies and stop rebuilding whole baselines** (_hard_,
  `server-generation.md`). `server/src/jobs/generationJobs.ts`: `job.generated` (~1691–1695) keeps every row
  the job began, and `diffChat` (~699–718) forces them into each patch; the streamed encoding needs an active
  lock (`chatPatchEvent` ~1263–1284), so a finished reply travels whole in every later checkpoint of the same
  job (group sends, command sequences). Drop a row from the forced set once its final stored state has been
  delivered to the baseline, keeping real field changes, active streamed rows, and the base-mismatch recovery.
  `advanceChatBaseline` (~651–665) and `diffChat` copy and compare the full history for one changed row:
  accumulate touched rows between the sent and working baselines and take an indexed path when membership and
  order are unchanged, falling back to the general diff otherwise; a baseline shared with `sentChat` stays
  immutable.
  _Done_: with a 128 KiB first reply finished, the second reply's checkpoint frame is a few hundred bytes; a
  one-row change on a 10,000-message history reads a bounded number of ids.
  _Test_: `server/src/tests/generationJobs.test.ts` (two replies in one job: later checkpoints omit the
  unchanged first; instrumented id reads and Map copies per checkpoint; the structural-change fallback).
  _Closes_: ICT-02, ICT-07.

- **T3. A retired replay keeps its coverage cursor** (_small_, `live-updates.md`).
  `src/ts/network/eventFeed.ts`: `reconcile` (~304–345) lets a live frame advance `heldCursor` while a replay
  is pending; `retire` (~234–238) then abandons the frozen map but keeps the advanced cursor. Keep a verified
  coverage cursor apart from the highest live-frame cursor during reconciliation and commit both after the
  replay installs, or restore the frozen map and cursor in `retire`.
  _Done_: the audit's sequence (hello 14, held `10..14` replay, live 15, retire, hello 15) requests `10..15`
  and no revision listing.
  _Test_: `src/ts/network/eventFeed.test.ts` (the concurrent-overlay case extended with retirement before the
  replay resolves; listing calls stay at one).
  _Closes_: ICT-03.

- **T4. Change-log pruning stops scanning the retention window** (_small_, `server-resources.md`).
  `server/src/data/resourceStore.ts` `pruneChanges` (~1071–1073, run on every logged commit at ~1162–1165)
  finds its cutoff with `ORDER BY cursor DESC LIMIT 1 OFFSET ?`. Maintain the boundary incrementally (a retained
  row count or the oldest kept cursor in `meta`, updated in the same transaction) or cut by cursor range once the
  cursor-allocation invariant is stated in the module header; keep transactional pruning, restore behavior and
  replay expiration.
  _Done_: a one-row commit at a full 20,000-row window deletes with bounded SQLite work.
  _Test_: `server/src/tests/resourceStore.test.ts` (a progress-handler or `EXPLAIN QUERY PLAN` check at the
  full window; retention and replay-expiry cases stay).
  _Closes_: ICT-04.

- **T5. Feed diffs and stream references copy what changed** (_hard_, `chat-store.md`).
  `src/ts/storage/chatStore.svelte.ts`: the JSON `clone` (~970–972) is applied to the whole held row by
  `stagedRowDiffs` (~2827), `resolveJobChatPatch` (~2689) and again in `patchedMessages` (~3067). Validate the
  whole operation first, then shallow-copy the row and clone only the incoming changed field values, keeping
  atomic rejection, ownership of incoming objects, reactive tracking and own-key handling; do not duplicate the
  resolved owner row in the patch stage. `positionOf` (~1054–1070) rebuilds the index on every miss: within
  `applyChatResult`'s collision loop (~4369–4373) and `restoreUnsentRemoval`, use one membership set per batch;
  for general misses, key negative results to a structural generation and keep the validated-hit fallback.
  `applyRemoval` (~3873–3882) spreads every surviving message into `splice`: compact in place or splice bounded
  contiguous ranges, then queue the edit.
  _Done_: a 100-byte field diff on a row with 190 KiB of candidates serializes the field, not the row; adding
  K fresh messages builds the index once; removing a tail message from a 200,000-row array queues the edit.
  _Test_: `src/ts/storage/tests/chatStore.test.ts` (serialized bytes per diff; index builds per bulk add and
  per repeated miss; a large tail deletion and a discontiguous removal reach the queued operation),
  `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`, `src/ts/network/generationJobsDelta.test.ts`.
  _Closes_: ICT-05, ICT-06, OTHER-01.

### H. Job handoff

- **H1. An unclaimed targeted offer falls back to an absent offer** (_hard_, `server-generation.md`).
  `server/src/jobs/generationJobs.ts`: `armOffer` (~1023–1029) returns while `job.offer` exists, a requested
  offer never expires, and `reopenOffer` / `expireTicket` (~1004–1019) keep its target, so after the owner
  leaves no other worker can claim (`takeover` ~2709–2716 answers 409). Once the owner has been absent for the
  normal offer delay, expire or replace an unclaimed targeted request with an untargeted `absent` offer;
  handle a reserved ticket and a pending takeover explicitly (they keep their claim until they expire).
  _Done_: creator attached → handoff requested to B → B never claims → creator closes → after the offer delay
  worker C claims successfully.
  _Test_: `server/src/tests/generationJobs.test.ts` (that sequence with the injected clock; a reserved ticket
  during the fallback keeps precedence).
  _Closes_: JH1.

- **H2. A transient failure does not bury an open offer** (_small_, `network-jobs.md`).
  `src/ts/network/handoff.ts` `evaluateOffers` (~208–220) marks an offer evaluated before `takeOffer`
  (~225–259) runs its `readChatGeneration` and `takeoverGenerationJob` calls, and an exception only logs. Tell
  a transient failure (a thrown fetch, HTTP 5xx, a timeout) from evaluated ineligibility and from the terminal
  404/409 drop; retry transient failures with bounded backoff while the same offer, epoch and acceptance
  revision stay current, cancelled on offer closure.
  _Done_: a self-targeted offer whose first `/current` read fails with 503 is claimed on the next attempt with
  no reconnect and no preference toggle; a 409 still drops it.
  _Test_: `src/ts/network/handoff.test.ts` (503 then success with fake timers; 409 drop unchanged; closure
  cancels the retry).
  _Closes_: JH2.

- **H3. Losing participation is a detach, not a lost job** (_hard_, `chat-store.md` with
  `scripts-triggers.md` and `network-jobs.md`). JH3: `releaseGenerationJob` in `src/ts/network/generationJobs.ts`
  (~1371–1377) calls `endServerJob` in `src/ts/storage/chatStore.svelte.ts` (~2068), which adds the job's
  generation ids to `retiredGenerations`, so a retake of the same running job refuses `accepted`, drops chunks,
  and (with no viewer attached) fails every compact `streamed` checkpoint into a whole-chat resync. Add a
  detach that drops the job's held entries without retiring its generation ids, used by the lost-takeover path
  in `src/ts/process/serverCommands.ts` (~418–420); keep retirement for a job that ended. JH4: in the follow
  lifecycle (~188–190, ~442–466, ~605–607, ~863–866) a former worker demoted to viewer that loses participant
  access on a reconnect (status 404/null) is reported as `lost` with a gone diagnostic and `serverJob.endedAway`
  because `everOwner` is true; give a non-creator viewer a plain detach outcome, keep the foreign-job state, and
  consult the chat's `/current` view when the latest role is uncertain.
  _Done_: a tab that lost a pending takeover and retakes the job shows the live stream and accepts compact
  checkpoints; worker B after A takes back sees no "ended" notice and no whole-chat refresh.
  _Test_: `src/ts/storage/tests/chatStore.test.ts` (detach keeps generation ids unretired; a later `accepted`
  and chunks apply), `src/ts/network/generationJobs.test.ts` (three streamed checkpoints after a retake cause
  no resync), `src/ts/process/serverCommands.test.ts` (ticket follow → `owner: "self"` → `owner: "other"` →
  reconnect → null status: a detach, no notice).
  _Removes_: A retaken handoff job drops its live stream.
  _Closes_: JH3, JH4.

- **H4. Generation sockets bound their queued bytes** (_small_, `server-generation.md`).
  `server/src/jobs/generationJobs.ts` `sendSocket` (~926–930): admit a frame only while the socket's
  `bufferedAmount` is under a cap (the 4 MiB the events route uses at `server/src/routes/events.ts` ~87–98 is
  the model) and terminate a socket that stays over it, independent of owner-silence (`expireSilentOwners`
  ~851–859, `switchOwner` ~1089–1093). Reconnect and hydration recover a dropped viewer; callback authority is
  untouched.
  _Done_: a viewer whose transport stops reading is closed once its queue passes the cap while the worker keeps
  receiving and its callbacks still deliver.
  _Test_: `server/src/tests/generationJobs.test.ts` (a socket stub with a growing `bufferedAmount`: the viewer
  is terminated, the worker is not, delivery and authority intact).
  _Closes_: JH5.

- **H5. Owner and viewer projections of one checkpoint** (_hard_, `server-generation.md`; after T2; Q2).
  `server/src/jobs/generationJobs.ts` `chatPatchEvent` (~1254–1261) and `deliverJobChat` (~1323–1329) send one
  wire event to every socket, so any viewer disables stream references for the worker. Keep one semantic
  `sentChat` baseline and serialize two projections: the owner's with stream references when it negotiated
  `rows=streamed` and its buffer is proven, viewers' with full rows. Update the test at ~1990–2020 that pins
  the shared event.
  _Done_: in the audit's fixture (20 growing checkpoints, creator watching) the worker's checkpoint bytes are
  within a small factor of the no-viewer run, and the viewer still receives full rows.
  _Test_: `server/src/tests/generationJobs.test.ts` (deterministic serialized-byte comparison for both sockets;
  an owner without a proven buffer still gets full rows).
  _Closes_: JH6.

- **H6. Notice queue drains in linear time** (_small_, `server-generation.md`). `server/src/jobs/channel.ts`:
  `handleAttach` (~930–932) sorts all remaining sends and `shift`s one per iteration; `takeEarly` (~746–752)
  filters with `includes`. Sort once and consume with a cursor (or an ordered queue) while newly promoted
  requests are inserted in original order; partition `takeEarly` into taken and remaining in one pass with
  accumulated byte counts. The ordering guarantee stays: callbacks promoted during delivery interleave by
  original order.
  _Done_: draining 10,000 short notices on attach performs one sort, not 10,000.
  _Test_: `server/src/tests/jobChannel.test.ts` (sort and comparison counts on a 10,000-notice backlog;
  promotion during a drain keeps order; the existing ordering cases stay).
  _Closes_: JH7, JH U1.

- **H7. Plugin-provider streams send appends** (_hard_, `network-jobs.md` with `server-generation.md`,
  `persistence.md`, `llm-requests.md`; after H6). `src/ts/network/jobChannel.ts` (~1030–1042, ~1058–1094)
  sends the whole accumulated `fullText` every 50 ms; `shared/jobs.ts` (~685–691) is the callback contract;
  `server/src/jobs/channel.ts` (~857–872) forwards each prefix to `onChunk`; `server/src/llm/requests.ts`
  (~835–888) adapts it. Negotiate sequenced append deltas for this direction (the hello already negotiates
  `rows=streamed` for the other), reconstruct the cumulative text on the server before the `onChunk` boundary,
  keep a snapshot and resynchronization form for a lost sequence and the 4 Mi-character cap, and keep the
  snapshot form for an old tab.
  _Done_: a stream of 1,200 64-character updates crosses the socket in about 1,200 × 64 bytes plus framing, not
  44 MiB; a dropped sequence number resynchronizes from a snapshot.
  _Test_: `server/src/tests/jobChannel.test.ts` and `src/ts/network/jobChannel.test.ts` (serialized bytes per
  update, reconstruction, gap recovery, an old tab's snapshot form), `server/src/tests/llmRoutes.test.ts` if the
  adapter's coalescing changes.
  _Closes_: JH U2.

### P. Plugin storage and data API

- **P1. A reset wins over an in-flight consent** (_hard_, `plugin-sandbox.md`).
  `src/ts/plugins/apiV3/permissionStore.ts` `recordPermissionGrants` (~99–132) retries a conflicted grant
  write by reapplying `added.grants` to the newest state, so a reset committed meanwhile is undone;
  `src/ts/plugins/apiV3/v3.svelte.ts`'s removal listener (~786–789) clears cached answers but does not advance
  `permissionResetGenerations`, so an open prompt (consent completion ~903–916) still grants. Give consent
  operations a reset generation checked across tabs and at persistence: a conflict retry tells an independent
  grant from the removal of the grant it renews and drops the latter; a remote reset invalidates pending prompts
  (they answer `false`, as `plugins.md` promises). Unrelated grants still merge.
  _Done_: the audit's two sequences (an accepted-before-reset delayed PUT; a prompt open across a remote reset)
  leave no grant and `getDatabase` refused; two tabs granting different permissions keep both.
  _Test_: `src/ts/plugins/apiV3/permissionStore.test.ts`, `permissionRevocation.test.ts`, `permissions.test.ts`
  (the three sequences with `FakeResourceServer`).
  _Closes_: PS1.

- **P2. Storage writes and their feed patches by entry** (_hard_, `server-resources.md` with
  `persistence.md`, `resource-sync.md`, `plugin-sandbox.md`; after T4). Server:
  `server/src/data/resourceStore.ts` `patchParts` (~3270–3279) treats a one-key reserved-dictionary write as a
  changed top-level part (serialize, parse, `canonicalPart`, `storedParts`), and `feedPatch` (~3418–3434) with
  `shared/recordPatch.ts` `diffFields` (~312–326) and `server/src/data/recordPatchText.ts` (~155–158) publishes
  the whole dictionary (a bare reference over `MAX_FEED_PATCH_BYTES`) and a toggle on id-less plugins as a
  reference. Keep entry-level serialized parts for declared dictionaries, canonicalize changed entries, reuse
  unchanged text, and build the feed patch from those entries; extend the feed `RecordPatch` with the `nested`
  and `itemKey` forms `checkRecordWritePatch` already validates on the write side. Client:
  `src/ts/storage/resourceSync.svelte.ts` `patchedRecord` (`noteRemoteChanges` ~4841–4861, full reads at
  ~5271–5274) applies both forms with base revisions, validation, and the size cap. Both sides change together.
  _Done_: a 173-byte counter write beside a 2 MiB history publishes an entry patch and causes no whole-record
  read in an observing tab; the server runs no 2 MiB stringify or parse for it; a plugin toggle publishes a
  name-keyed item patch.
  _Test_: `shared/tests/recordPatch.test.ts` (the forms), `server/src/tests/resourceStore.test.ts` (published
  patch and instrumented JSON passes), `src/ts/storage/tests/resourceSyncFeedPatches.test.ts` (two clients: no
  whole-resource read), `src/ts/plugins/apiV3/pluginStorage.test.ts` (normalization, ordering, `__proto__`, and
  malformed-dictionary fallbacks stay).
  _Removes_: pluginStorage writes still reach other tabs whole.
  _Closes_: PS3, PS4.

- **P3. Detached reads: cache what can be reused, once** (_hard_, `plugin-sandbox.md` with
  `structured-memory/projection.md`; after P1). `src/ts/plugins/apiV3/detachedChatCache.ts` (admission
  ~106–118, eligibility ~129–137) retains Structured Memory chats it will never reuse: cache the revision-stable
  chat body apart from its memory projection, refreshed by the batched memory revisions the loaded path already
  checks, so an unchanged unloaded structured chat is not re-downloaded; never drop the eligibility guard
  (projections change without a chat revision). `src/ts/plugins/apiV3/v3.svelte.ts`: per-call `reads` and
  `cacheHits` (~1249–1250) let two overlapping cold reads request the same chats; share pending detached reads
  by epoch, chat identity, revision and projection state, each caller keeping its own final owner, membership,
  local-work and freshness checks. The loaded-page path (~1225–1239, `getChats` dispatch ~2259–2262) flushes
  global work first and falls back to `withChatsLoaded(ids)` for the whole character when the flush rejects;
  give an already-loaded page a path that pins the requested chats, checks owner and membership, refreshes their
  projections and copies held state without the flush, and narrow the unloaded fallback where the safety rules
  allow.
  _Done_: two consecutive `getDatabase(["characters"])` reads of an unchanged 1 MiB structured chat request it
  once; two overlapping cold reads of three chats request three refs; a one-chat loaded page under a
  generation-blocked save requests no other chat.
  _Test_: `src/ts/plugins/apiV3/getDatabaseDetached.test.ts` (unchanged, changed-projection and no-memory chats;
  overlap, invalidation while pending, rejection cleanup; the blocked-flush page), `src/ts/plugins/apiV3/hostApiMemory.test.ts`.
  _Closes_: PS5, PS6, PS8, E4.

- **P4. Plugin API accessors in linear time** (_small_, `plugin-sandbox.md` with `chat-store.md`; after P3 and
  C2). `src/ts/storage/chatStore.svelte.ts` `chatList` (~1446–1451) builds every member's entry before the page
  selector in `v3.svelte.ts` (~2240–2246) slices: add a read-only member-page accessor that slices ids before
  building entries, and a count accessor, with a membership version so the eleven checks of one call reuse the
  page while keeping the page-change-during-await protection. `src/ts/storage/pluginStorageStore.svelte.ts`
  `ownedPluginStorageKeys` (~179–186) and the `length` / `key(i)` calls in `v3.svelte.ts` (~2920–2927) enumerate
  the whole shared dictionary per call: keep an ordered per-owner key list and count, invalidated by owned and
  legacy mutations and remote record replacement, preserving owned-before-legacy order, shadowing, claim-on-write,
  clear markers and arbitrary string keys. `applyPluginCharacters` (~1542–1558) uses `existing.includes` and
  `characterList().findIndex` per character: a membership `Set` and an id-to-index map built once per
  reconciliation and maintained as characters append, keeping order, duplicate rejection, vanished-target
  handling and generating-character protection.
  _Done_: `getChats("c", { offset: 500, limit: 1 })` over 1,000 chats builds one entry, not 11,000; enumerating
  one owner's 100 keys among 100 owners visits each key once; a 1,000-character setter does no nested scan.
  _Test_: `src/ts/plugins/apiV3/hostApiChats.test.ts` (entry counts cold and warm), `src/ts/storage/tests/pluginStorageStore.test.ts`
  and `src/ts/plugins/apiV3/pluginStorage.test.ts` (enumeration counts; ordering and shadowing cases stay),
  `src/ts/plugins/apiV3/v3SetDatabase.test.ts` (lookup counts).
  _Closes_: PS7, PS9, PS U2.

### R. Rendering and translation

- **R1. Translation producers: cache first, one request per text, honest HTTP errors** (_hard_,
  `translation.md`). `src/ts/translator/translator.ts`: workers (~675–685) and `translateWithSlot` (~126–159)
  take a global slot before `translate` (~198–205) checks the completed cache, so a cached render waits behind
  ten unrelated requests; check the cache before the queue and recheck after admission, charging the permit to
  the uncached producer. The pair cache stores completed results only, so N identical non-LLM misses start N
  `runTranslator` calls: share a non-LLM producer keyed by configuration, direction and exact text, charged one
  permit, joinable by later workers, still finishing and warming the cache after its row leaves. The direct
  Google adapter (~430–447) parses JSON without `Response.ok` and returns the source text for an error body,
  which `translate` (~208–212) stores as a pair: validate status and shape, report the failure through the
  existing transient marking, and never populate the pair cache from an error response.
  _Done_: a warmed text renders while ten provider requests are held; ten identical paragraphs issue one
  request; an HTTP 429 JSON body renders as a failure and the next render requests again.
  _Test_: `src/ts/translator/translatorMemoryCache.test.ts`, `src/ts/translator/translateHtmlWorkers.test.ts`
  (deferred fetches: counts of requests and permits; the 429 body).
  _Closes_: RW2, RW7, RW U1.

- **R2. A failed translation attempt stops taking jobs** (_hard_, `translation.md` with `ui-theming.md`;
  after R1). `src/ts/translator/translator.ts` (~675–695): `Promise.all` rejects on the first worker failure
  while the sibling workers, which watch only the render's signal, keep acquiring permits and new paragraphs;
  `src/lib/ChatScreens/ChatBody.svelte` (~411–429) retries `markParsing` after 250 ms with the same signal, so
  two attempts run at once. Give each attempt a failure state that stops new acquisitions and removes its
  queued ones on first failure, keeping permits for already dispatched requests until they settle.
  _Done_: after paragraph 0 fails, the failed attempt issues no further request, and the retry's paragraph 2 is
  requested once.
  _Test_: `src/ts/translator/translateHtmlWorkers.test.ts` (worker failure with pending siblings and a retry on
  the same signal), `src/ts/translator/translateHtmlLifetime.test.ts`.
  _Closes_: RW1.

- **R3. Highlight teardown and cancelled code highlighting** (_small_, `cbs-rendering.md` with
  `ui-theming.md`). `src/ts/gui/highlight.ts` `removeHighlight` (~157–160) calls `runHighlight` (~124) per
  removal, so unmounting N highlighted editors (leaving `PromptSettings.svelte`'s keyed template) copies
  N(N−1)/2 ranges: remove the departing editor's ranges from the maintained category sets, or reconcile once per
  microtask after a group of removals, keeping the guarantee that stale categories disappear.
  `src/ts/parser/parser.svelte.ts` `renderHighlightableMarkdown` (~250–448) takes no signal, so an awaited
  language import outlives the row, highlights the block, visits the remaining fences and may import more:
  pass the lifetime signal through it and `postTranslationParse`, check it after each import and between fences,
  and let the cancellation escape the helper's empty catch (callers at ~1108–1110, ~1319–1330, and
  `src/lib/ChatScreens/ChatBody.svelte` ~383–387).
  _Done_: removing 150 highlighted editors in one turn copies 150 ranges, not 11,175; a render aborted during
  the first language load highlights nothing more and starts no second import.
  _Test_: `src/ts/gui/highlight.test.ts` (range-copy counts; the two-editor correctness case stays),
  `src/ts/parser/tests/parseMarkdownLifetime.test.ts` (a held import, abort, release).
  _Closes_: RW5, RW6.

- **R4. Departed transform targets stop costing, and chunks are admitted per tab** (_hard_,
  `cbs-rendering.md` with `server-generation.md`). `src/ts/parser/transformClient.ts`: the plugin and
  continuation loop (~313–327, ~595–603) runs hooks and uploads continuation text for every target of a chunk
  while one subscriber survives; suppress hooks for targets whose subscriber count is zero and add an explicit
  cancelled-target form to the continuation protocol (`server/src/prompt/transform.ts` ~804–835 accepts it and
  skips the second-call work), accounting for a target that gains a subscriber before settlement; never cancel
  the survivor's request. The client dispatches all chunks at once (~513–540) while the server keeps four pending
  plugin snapshots per client (`MAX_SNAPSHOTS_PER_CLIENT` at `transform.ts:51`, eviction ~887–890): cap the
  two-call chunks in flight per tab and hold each permit through the continuation, not only the first HTTP call.
  _Done_: 64 targets with 63 aborted run one hook and upload one continuation; 320 uncached targets with held
  hooks produce no `SnapshotExpired` and no raw rows.
  _Test_: `src/ts/parser/tests/transformClient.test.ts` (hook and continuation counts; the admission cap with a
  four-snapshot policy stub), `server/src/tests/transformService.test.ts` (the cancelled-target form; the
  eviction case at ~401–418 stays).
  _Closes_: RW8, RW U2.

- **R5. The cached-only probe follows the translation key** (_small_, `ui-theming.md` with
  `translation.md`). `src/lib/ChatScreens/ChatBody.svelte` (~301–328, ~365–394): the probe remembers character,
  chat index and the auto-translate flag but not the source's cache key, so a settled row whose display text
  changes in place skips the probe and the normal branch translates uncached text. Key the automatic cached-only
  decision by the effective translation key and re-evaluate when it changes; an explicit user choice stays
  separate, and an automatic cached-only decision never becomes permission for a cache-miss request.
  _Done_: a settled cached row whose `msgDisplay` changes to uncached text probes again and issues no request.
  _Test_: `src/lib/ChatScreens/ChatBody.svelte.test.ts` (the audit's mounted sequence: two probes, one
  translation).
  _Closes_: RW U3.

- **R6. Screenshot font CSS is prepared once per export** (_small_, `ui-theming.md`).
  `src/lib/ChatScreens/DefaultChatScreen.svelte` (~1005–1013) calls `toCanvas` per row with
  `SCREENSHOT_CAPTURE_OPTIONS` (`src/lib/ChatScreens/screenshotCapture.ts`) only, so `html-to-image` rescans
  stylesheets, re-expands a surviving `@import`, refetches fonts and inserts duplicate rules per row. Prepare the
  embedded font CSS once per export (`getFontEmbedCSS`) and pass `fontEmbedCSS` to every capture; move the
  export's capture options into `screenshotCapture.ts` so the helper is testable without the screen.
  _Done_: a 30-row export fetches fonts once and the live stylesheet gains no duplicate font rule.
  _Test_: `src/lib/ChatScreens/screenshotExport.test.ts` or a new `screenshotCapture.test.ts` beside it
  (stubbed `html-to-image`: one font preparation, thirty captures with the prepared CSS).
  _Closes_: RW U4.

### C. Reroll candidates

- **C1. Lua reads and writes share the reroll history view** (_hard_, `scripts-triggers.md` with
  `server-generation.md`). `server/src/jobs/jobScope.ts` `scopeHistoryChat` (~455–459) hides the carrier
  during assembly and filters the whole array on every call; `server/src/lua/bindings.ts` getters read it
  through `engineChat` (~373, `messages` ~640) while setters outside a working copy resolve indexes through
  `writeChat` (~415) against the unfiltered stored chat, so `editRequest` (`server/src/prompt/scripts.ts`
  ~86–100; the view is cleared only after assembly returns, `server/src/prompt/runner.ts` ~1744–1756) can
  read one message and edit, remove or re-role another (`setChat`, `removeChat`, `setChatRole`, `cutChat`,
  insertion positions ~1285–1356). Resolve script indexes against the same view the getters use and write by
  stable message id; define insertion and range behavior around the hidden carrier consistently with the
  trigger-diff anchoring; cache the view per message-list version and hidden-carrier id (invalidated by writes
  and adoption, current after a start-trigger append).
  _Done_: with `[u, r, c1, c2]` and `r` rerolling, `editRequest`'s `setChat(2, …)` edits `c2`; a 1,000-read
  loop builds the view once.
  _Test_: `server/src/tests/luaBindings.test.ts` and `luaBindingsFences.test.ts` (two trailing comments: read,
  write and removal; filter counts per loop), `server/src/tests/promptRunner.test.ts` (the integration case
  through assembly).
  _Closes_: RC1, RC6.

- **C2. The writing tab learns the rows an append cleaned** (_hard_, `chat-store.md` with
  `server-resources.md` and `resource-sync.md`; after T5 and C4). Server `server/src/data/chatStore.ts`
  (~2257–2273) removes older checkpoints and candidate snapshots on a non-comment append and bumps their
  `candidatesRevision`; the client's optimistic append (`src/ts/storage/chatStore.svelte.ts` ~3556–3559,
  ~5691–5704, ~5764–5771, ~5791–5803, ~6866–6867) installs only the new row and its acknowledgement advances the
  revision, so the equal-revision feed echo is ignored and the tab keeps stale snapshots (first candidate switch
  refused, a whole-row write resurrects the removed checkpoint). Carry the affected rows (id, cleared fields,
  new `candidatesRevision`) in the append acknowledgement and apply them, or schedule precise reads for them;
  account for live-lock exemptions and server-owned revision increments. `writesCandidateFields` (~5698–5700)
  treats any `setMessage` carrying candidates as needing a whole-chat refresh: compare actual candidate-field
  changes and use the returned counters or a precise row refresh, keeping the full recovery for a genuinely
  stale base.
  _Done_: after an acknowledged append, the tab's older reply has no snapshots and the server's revision; the
  first switch to an earlier candidate after deleting the appended message succeeds; a `name`-only edit of a
  candidate-bearing row performs no whole-chat read.
  _Test_: `src/ts/storage/tests/chatStore.test.ts` (acknowledgement-before-feed ordering; the resurrection
  case), `src/ts/process/rerollCandidates.test.ts`, `src/ts/storage/tests/resourceSyncRefresh.test.ts` (no
  whole-chat `chats` read on the name edit), `server/src/tests/chatStore.test.ts` (the acknowledgement body).
  _Closes_: RC2, RC8.

- **C3. Fence checks use live ownership; provenance returns early** (_small_, `server-resources.md`; after
  T1). `server/src/data/chatStore.ts` `selectCheckpointRows` (~1407–1410, append cleanup ~2257–2273) excludes
  any row with a persisted open generation fence before the live-lock check, so a row abandoned by process loss
  or abort-grace expiry keeps its checkpoint and snapshots forever: skip only carriers with live ownership (the
  existing guard check), keeping the protection for a begin later in the same transaction. `recordMap`
  (~1308–1315, called from every metadata operation at ~2140 and ~2186) builds the key union and serializes both
  maps before `recordVariable` (~1290) returns for no attempt: return at once without an attempt, and skip the
  comparison when before and after are the same object; keep merge and unset provenance and same-value foreign
  writes.
  _Done_: an append after a generation whose ownership ended without a final write removes the older row's
  snapshots; a note edit with no active reroll and 100 variables runs no `sortedJson`.
  _Test_: `server/src/tests/chatStore.test.ts` (ownership ended, no final write, append; `sortedJson` count on a
  note edit; the same-transaction begin stays protected).
  _Closes_: RC3, RC9.

- **C4. Tail checks and append cleanup read only what they need** (_hard_, `server-resources.md` with
  `persistence.md`; after C3). `server/src/data/chatStore.ts` `selectCarrierMessages` (~1348–1351) extracts
  role and comment from every message to find the last two non-comment ones: query backward and stop after two
  eligible rows. `selectCheckpointRows` (~1407–1410, ~2259) traverses every historical candidate array with
  correlated `json_tree` on every append: maintain a small checkpoint-presence projection (a column or table,
  created at open per the schema rule above) updated transactionally on message writes, import and restore, and
  read it instead; never prune the candidate history Q1 of the reroll plan preserves. The shared predicates in
  `shared/rerollCandidates.ts` (~288–300) take a reverse early-exit scan instead of filtered copies.
  _Done_: on a 1,000-message chat with 500 historical candidate lists, carrier validation returns two rows and
  the no-op cleanup inspects zero candidate arrays.
  _Test_: `server/src/tests/chatStore.test.ts` (rows returned and `json_type` inspections on the long
  candidate-free and candidate-bearing fixtures; projection survives import and restore), a new
  `shared/tests/rerollCandidates.test.ts` (early exit).
  _Closes_: RC5, OTHER-02.

- **C5. The stored prompt copy runs no mutable hook** (_small_, `server-generation.md`).
  `server/src/prompt/assemble.ts` runs `host.runEditRequest` for the request (~2451) and again for the
  `promptTextInfoInsideChat` copy (~2482); the Lua `editRequest` hooks have mutable host access, so variable
  updates and insertions persist twice. Capture the already-transformed request for the stored copy (or make
  the diagnostic projection side-effect-free).
  _Done_: with prompt text capture on, a hook that increments a variable runs once.
  _Test_: `server/src/tests/assemble.test.ts` (the audit's `AssemblyHost` counter: one call, value "1", capture
  on and off).
  _Closes_: RC U1.

- **C6. A comment flag change updates the mounted row** (_small_, `ui-theming.md`).
  `src/lib/ChatScreens/Chats.svelte`: the row key (~681–689) and the incremental `RowUpdate` (~693–724) omit
  `isComment`, supplied only at mount (~740; `Chat.svelte` ~1356, ~1450–1457). Include it in the incremental
  update (or remount on change) so presentation and delete controls follow a script, plugin or feed write that
  changes only the flag.
  _Done_: toggling `isComment` on a mounted row with unchanged text and role switches its presentation both ways.
  _Test_: `src/lib/ChatScreens/Chats.rows.svelte.test.ts`.
  _Closes_: RC U2.

- **C7. No trigger, no copies** (_small_, `server-generation.md`). `server/src/jobs/runSetup.ts` `runOnCopy`
  (~374–384) deep-clones the chat for a baseline and `server/src/prompt/triggers.ts` (~430–447) clones it again
  before checking for an empty trigger list. Check for applicable character and module triggers of the stage
  before either copy; where triggers exist the baseline and the working copy stay as they are.
  _Done_: a start stage with zero triggers on a chat with ten 150 KB rows clones nothing and returns `null`.
  _Test_: `server/src/tests/triggerRuntime.test.ts` (clone bytes or calls per stage with and without triggers),
  `server/src/tests/promptRunner.test.ts`.
  _Closes_: RC U3.

### M. Structured memory

- **M1. Repairing an old window does not move the present** (_hard_, `structured-memory/writer.md` with
  `lifecycle.md`; Q3). `server/src/prompt/memory/memoryTasks.ts` (~1076–1084) and
  `server/src/prompt/memory/structured/recordJob.ts` (~229–237) pass a re-recorded old window to the writer
  without `historical`, so `writer.ts` (~789) keeps scene and thread effects and `commitPages`
  (`patches.ts` ~391–392) rewrites the scene. Identify a repair window that precedes later committed events and
  run it through the historical path (frozen-page handling and thread suppression included), in both the task
  loop and the manual job; a later event's scene, pages and threads are untouched.
  _Done_: "Old farm" then "Castle"; editing the earlier reply and re-recording keeps the scene `Castle`,
  automatically and through Record now.
  _Test_: `server/src/tests/memoryTasks.test.ts` and `server/src/tests/memoryJobs.test.ts` (the real task
  service and writer with a scripted model on SQLite: automatic and manual repair).
  _Closes_: C1.

- **M2. Locked targets do not spend the patch call** (_hard_, `structured-memory/writer.md` with
  `pages.md`; after M1). `server/src/prompt/memory/structured/patches.ts` `showTargets` (~97, budget
  ~119–148) shows full locked bodies against the same 12,000-character budget, and `writer.ts` (~812–815) makes
  the patch call for any nonempty target list while admission (~243–245) refuses every locked change. Drop
  targets with no writable section or free character slot before deciding to call; order editable bodies first
  in the budget and give locked context only in compact form when a writable sibling needs it.
  _Done_: a fully locked character costs one model request (analysis) and no patch call; seven locked 4,000-
  character sections followed by an editable page leave that page within budget.
  _Test_: `server/src/prompt/memory/structured/patches.test.ts` (both fixtures: call count and `overBudget`),
  `server/src/tests/memoryTasks.test.ts`.
  _Closes_: C2.

- **M3. Retraction reconciles the threads it supported** (_small_, `structured-memory/lifecycle.md` with
  `read.md`). `server/src/prompt/memory/structured/reconcile.ts` (~154–172) retracts events and flags page
  sections but leaves threads whose `openedBy` or `closedBy` name the retracted event, and the thread lane
  (`retrieve.ts` ~474–481) checks only state and participants. Reconcile thread creation and transitions
  against surviving evidence: a retracted closing event reopens the thread, a retracted opening event with no
  other support retires it; a deliberate user state override stays.
  _Done_: deleting the completion's source with `retract: true` reopens the promise and it retrieves again;
  retracting the opening event of an unsupported thread removes it from retrieval.
  _Test_: `server/src/prompt/memory/structured/reconcile.test.ts` and `retrieve.test.ts` (deletion and Timeline
  retraction of opening and closing events, asserting stored thread and final retrieval).
  _Closes_: C3.

- **M4. A speaker correction invalidates its evidence** (_small_, `structured-memory/records.md` with
  `server-resources.md`; after C2). `server/src/data/memoryStore.ts` `messageSourceHash` (~1197–1201)
  hashes role and text; `server/src/data/chatStore.ts` source-change detection (~2338–2345) omits `saying`,
  which `writer.ts` (~240–248) uses for group attribution. Add the semantic speaker identity to both under a
  versioned anchor: a stored hash compares under the version it was written with, so existing records need no
  rewrite; receipts and other generation metadata stay excluded.
  _Done_: a plugin `setChatToIndex` that changes only `saying` on a recorded group turn marks the event for
  re-recording and the automatic repair picks it up.
  _Test_: `server/src/tests/memoryStore.test.ts` (hash versions), `server/src/prompt/memory/structured/reconcile.test.ts`
  (speaker-only change notice), `server/src/tests/chatStore.test.ts` (the notice carries the change).
  _Closes_: C4.

- **M5. The evidence fallback sees what the trim will drop** (_hard_, `structured-memory/read.md`).
  `server/src/prompt/memory/structured/retrieve.ts` (~445–448) draws the lexical fallback pool from
  `window.dropped` only (history covered by active events), while `step.ts` (~284) trims uncovered raw history
  afterwards. Make the fallback aware of the final raw-history trim (search older eligible messages and suppress
  excerpts whose full raw message survives), keeping the protected tail and screening semantics and the coverage
  gap report.
  _Done_: an older unrecorded "The bronze key code is 4712" under context pressure reaches the manifest as an
  evidence excerpt when the latest question asks for it.
  _Test_: `server/src/prompt/memory/structured/retrieve.test.ts` and `window.test.ts` (deterministic tokenizer:
  the exact lexical answer in uncovered trimmed history; a surviving raw message yields no duplicate excerpt).
  _Closes_: C5.

- **M6. Retrieval bounds its foreground embedding** (_hard_, `structured-memory/read.md` with `memory.md`;
  after M5). `retrieve.ts` embeds every eligible summary and key line (~332) and every shown section of every
  automatic page (~734–761) before the candidate caps, in sequential 50-text batches
  (`server/src/prompt/embeddings.ts` ~498–509), and `step.ts` (~247–258) computes the overall budget and
  required-page refusal after retrieval. Preflight capacity and required pages before any embedding; bound
  foreground cache misses per send and warm the remaining records in the background task; cache query vectors
  under a namespace distinct from documents. No lexical-only shortlist (it would drop semantic matches).
  _Done_: a cold 1,000-event chat's send submits a bounded number of texts in the foreground and the rest warm
  in the background; a send with no usable memory capacity embeds nothing; a repeated identical selection
  submits no query text.
  _Test_: `server/src/prompt/memory/structured/retrieve.test.ts` and `server/src/tests/memoryTasks.test.ts`
  (scripted provider: calls and texts cold, warm, and over capacity).
  _Closes_: E1.

- **M7. Cost preview is linear** (_small_, `structured-memory/rebuild.md`).
  `server/src/prompt/memory/structured/rebuild.ts` `memoryWorkCost` (~366, ~377–383) maps every planned window
  through `rebuildWindow` (~191, entries built at ~196–200), each call walking the whole transcript. Build the
  eligible entries and an id lookup once and accumulate the byte estimate while planning; no source hashes or
  window objects for a count.
  _Done_: 2,000 assistant turns read each message wrapper about once, not 8,004,000 times.
  _Test_: `server/src/prompt/memory/structured/rebuild.test.ts` (eligibility reads per transcript size; the
  estimate's values unchanged).
  _Closes_: E2.

- **M8. A source edit touches only the events that cite it** (_hard_, `structured-memory/records.md` with
  `lifecycle.md`; after M3 and M4). `reconcile.ts` `reactToMessageChanges` (~148–168, and against staged
  records at ~190–192) reads the contents list and `readRecord` for every nonretracted event to find source
  citations. Maintain a source-to-event relation keyed by chat incarnation and message id beside event writes
  (table created at open per the schema rule; maintained by import, restore, rebuild staging and compaction),
  and read only the cited events.
  _Done_: editing one message among 1,000 distinct events reads one event body (two during a staged rebuild).
  _Test_: `server/src/prompt/memory/structured/reconcile.test.ts` (read counts), `server/src/tests/memoryStore.test.ts`
  (relation maintained across import, restore and rebuild swap).
  _Closes_: E3.

- **M9. Panel reads: one contents request, paged by cursor** (_small_, `structured-memory/pages.md` with
  `records.md`; after M8). `server/src/routes/structuredMemory.ts` (~532–541) calls `readContents` for every
  package, coverage, log and threads round and the log handler reverses the whole run list before its 50-row cap
  (~602–605); `server/src/data/memoryStore.ts` (~493–515) reads all four listings and orders runs by `seq`
  against an index that starts with `(chatSeq, id)` (~224–229). Query only the requested kind with a `seq`
  cursor and byte/row admission on a `(chatSeq, seq)` index (created at open), read the revision separately and
  keep the cross-round revision check. Client: `StructuredMemoryPanel.svelte` (~184), `PagesTab.svelte`
  (~245) and `ThreadsTab.svelte` (~107) each fetch contents on refresh; the parent owns the contents and passes
  them to the tabs (or the wrapper shares the in-flight read with revision-aware invalidation).
  _Done_: 20 log pages of 1,000 runs materialize about 1,000 metadata rows, not 40,000, with no temp B-tree
  sort; one refresh with Pages or Threads open makes one contents request.
  _Test_: `server/src/tests/structuredMemoryRoutes.test.ts` (rows visited per page; query plan),
  `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts` (one request with each tab).
  _Closes_: E5, E6.

- **M10. Vector cache keys name their space, and admission is a set** (_small_, `memory.md`; after M6).
  `server/src/prompt/embeddings.ts` `HypaProcesser.addText` (~560–582) keys vectors by text, model
  discriminator and custom model name, omitting the endpoint (requests use the configured URL ~495, ~530–532),
  and `server/src/data/vectorCache.ts` clears on resource epochs only (~329–345); after loading cached vectors it
  filters each input by scanning the vector array from the start. Version the key with the normalized endpoint
  identity and every setting that changes the embedding space (never a credential value); keep a `Map` by text
  for admission and do not append vectors already held when several lanes share a processor.
  _Done_: switching endpoints under the same custom model name requests fresh document vectors; 2,000 unique
  warm texts perform 2,000 lookups, not 2,001,000 comparisons.
  _Test_: `server/src/tests/embeddings.test.ts` (endpoint switch; comparison counts on a warm cache),
  `server/src/tests/vectorCache.test.ts`.
  _Closes_: SM U1, SM U2.

## Excluded as edge cases

Each stays in its audit report until the plan retires, then moves to the inbox or the owning guide's Known
Hazards with this reason.

- **AL5** (quadratic inlay recognizer): needs a string with thousands of `{{inlay::` openings and no terminator;
  ordinary text has one or a few. A linear recognizer is a small change if `recognize` is touched.
- **Asset Lifecycle lead** (custom keys replaced during export): unverified; the audit asked for a coordinated
  export-and-replace reproduction first.
- **OTHER-03** (insertion at the chat start drops the carrier's variable snapshots): follows the reroll plan's
  recorded D6 rule; a position-aware commit boundary is a design change for an uncommon insertion.
- **PS2** (algorithm switched during one detached read): needs a memory-algorithm settings change between the
  server's response and the client's assembly of a single plugin read; one incorrect read, nothing stored.
- **PS U1** (own `__proto__` key dropped by the bridge): needs a plugin to store an object with a key spelled
  `__proto__`.
- **RW3** (a departed forced refresh loses its bypass): needs a Re-render whose target is withdrawn while a
  sibling keeps the chunk alive and a same-input replacement is created before the result lands.
- **RW4** (one row over the page pixel budget): needs a single row over 64 M device pixels (about 2,400 CSS
  pixels wide and 8,192 tall at DPR 2); the module header allows the exception. It belongs with the deferred
  screenshot-memory investigation in the inbox ("The screenshot peak grows with the row count").
- **RC4** (import report misses inlays in alternate swipes): an upstream backup whose non-selected swipes
  reference images the backup lacks; the selected text is reported today. One scan over `candidates[].data`
  if `importCharacters.ts`'s report is touched.
- **RC7** (quadratic swipe trimming on import): over 1,000 swipes on one message; the live ring holds 17.
- **Reroll malformed `candidates: []`**: the audit's own "narrow import edge case".
- **C6** (rebuild loses retained imported threads' participants): needs imported or manual thread data with a
  `who` list; no screen creates threads.
- **C7** (a delayed health response overwrites a newer badge): a reordered advisory read after a repair; a
  request generation in `readHealth` (`src/ts/process/chatStatus.svelte.ts`) is cheap when that function is next
  touched.

## Deferred

- **Media URL lifetimes** (AL U1). Without a capable controlling service worker, `getInlayObjectUrl` in
  `src/ts/process/files/inlays.ts` keeps every object URL in `mediaObjectUrls` for the page's life, so evicted
  blobs stay retained. The fix tracks URL ownership by rendered media and cached HTML and releases unowned URLs
  under a byte budget; the existing comment explains why blanket revocation breaks cached renders. This is the
  open "pinned `getFileSrc` / `mediaObjectUrls`" item of the asset-scale work and needs its own design.

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last edit),
  `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit
  (`pnpm docs:ledger` for a trim). Slices that add a table or index (C4, M8, M9) also run
  `server/src/tests/snapshots.test.ts` and the restore and import suites, since restore and import open the
  schema.
- Browser and driver checks, recorded in the slice's commit message: H3 and H5 with
  `util/playwright/offline.sh node util/playwright/checkJobHandoff.mjs`; A1, A2 and A5 with
  `node util/playwright/checkAssetLifecycle.mjs`; R4 and R6 with `node util/playwright/measureRenderWork.mjs`
  at 150 rows; A4 with a large PNG import in `pnpm dev:agent` watching the heap.
- At the end of the run: the whole suite with the slow tag, `pnpm check:docs`, and the seven reports moved to
  `docs/manual-audit/archive/` with the **Excluded** and **Deferred** findings filed as the header says.
