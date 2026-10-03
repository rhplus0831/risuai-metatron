# Plan review: Phase 6 implementation plan

The two reviews of the draft of [`implementation-plan.md`](implementation-plan.md), kept verbatim
so the per-slice reviewers can read the testing advice and the evidence. Opus's decision on
every point is in the plan's "Plan review decisions" section. File references are to `ee57e2e9`;
the draft itself is not kept (the final plan replaces it).

## GPT-6-Astra plan review (R1 to R16)

Reviewed 2026-10-03 against `metatron`, HEAD `ee57e2e9`. The working tree was clean when inspected. Review target: `/tmp/p6-plan/plan.md`, read together with the canonical Phase 6 slices it amends. Repository paths and line numbers below were checked in this tree; proposed new files are explicitly proposals. Luna reports were leads, not evidence.

**Verdict: revise before execution.** The overall approach is sound: records beneath a temporary facade, a store-level refs-only feed, explicit mutations, then reader migration and lazy chats. The draft corrects substantial Phase 5 drift. It is not yet an executable slice contract: it misses readers, deletes APIs before their callers move, underspecifies several feed races, and would remove shared chat fields still required by the server and public snapshots. These are current single-server/two-tab problems, not production-data or multi-user requirements.

Only this report was written. No build, tests, Docker, network requests, or git mutation commands were run; those would exceed this read-only review. Test advice below is for implementation, not a claim that checks passed.

### 1. Order, transitional ownership, and stops

#### R1 — Keep the new generation-remnants slice, but make its boundary complete

**Problem.** Removing dead browser generation before changing record ownership is a useful independent reduction. The scope nevertheless overlooks dead streaming-state consumers, and the proposed test list is not an exhaustive list of affected cases. Do not confuse removal of browser producers with removal of server generation locks.

**Evidence.** `src/ts/storage/resourceSync.svelte.ts:1886`, `:1993`, and `:2033` call checkpoints during flush, visibility, and unload. `src/ts/storage/chatStore.svelte.ts:558` and `:603` implement live server streaming and job release. `src/lib/ChatScreens/Chats.svelte:13` and `:87` still consume `streamingState`; `chatStore.svelte.ts:470` exposes its reader and `:2349` rewrites its message id. `src/ts/storage/tests/chatLock.svelte.test.ts:118` and `:140` both use browser `beginGeneration`; that file is not already a mixture of browser and server-producer tests as the draft implies. Server-lock coverage also exists in `resourceSyncHydration.test.ts:410`, `:500`, and `:587`.

**Fix.** Keep slice 3. Explicitly remove the inert `streamingState`/`isStreamingMessage` UI branch, or retain it as a documented temporary no-op with an owner in slice 9. Recommended: remove the inert branch here without inventing new streaming-performance behavior. Preserve `serverGenerations`, watermarks, retired generations, job metadata revisions, server retry locks, ordinary chat work and unload acknowledgements. Expand the test-adapter list by symbol search, not the draft's few line ranges. Q6 should confirm the scheduling change from the owner's recorded closeout placement.

#### R2 — File-group reader moves work only after a stronger facade proof

**Problem.** A nested field proxy alone does not implement the promised character-array facade. Existing creators push whole characters, editors replace array elements, and boot replaces the entire array. After removing membership watchers, these operations must perform the same creation, deletion, identity, normalization and chat-adoption work as the mutation module. A proxy that merely queues the parent key is insufficient. There is also a recursion/echo hazard if mutation functions or hydration write through the same public proxy that invokes them.

**Evidence.** `src/ts/storage/characterStore.svelte.ts:99` adds a character, assigns chat identities through `normalizeNewCharacter`, and repairs order; `:126` replaces an array element. `src/ts/bootstrap.ts:286` replaces the array. `src/lib/SideBars/CharConfig.svelte:657` replaces a character. Membership currently has separate logic at `src/ts/storage/resourceSync.svelte.ts:1946`. The spike only specifies nested-container operations over individual records (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/spike-projection-bindings.md:89` onward).

**Fix.** Add spike proofs for top-level membership `push/splice`, indexed replacement, whole-array assignment, create-with-chats, deletion cascade, duplicate ids, retained references after replacement, and remote hydration producing zero queued mutations. Specify a private raw-record application path beneath public mutation wrappers. Either provide a membership facade that batches an array operation atomically, or migrate the small set of structural writers in slice 5. **Recommend moving structural writers in slice 5**, leaving ordinary field readers/bindings for slice 8; it is simpler than emulating every transient array state. Expand that slice's allowed UI files accordingly.

The fallback to explicit function bindings also requires changing allowed files: slices 4/5 currently prohibit `src/lib` changes. If the spike rejects deep tracking, ownership cannot switch while those direct writers remain. Amend fallback scope before starting ownership, not after a stopping condition is reached.

#### R3 — Do not delete dirty-mark APIs before callers migrate

**Problem.** Slice 5 deletes `markCharactersDirty` and `markCharacterDirtyAt`, but several named callers are assigned to later slices. The proposed intermediate commit will not compile. Merely removing imports would also lose writes unless the facade captures them.

**Evidence.** `src/ts/characters.ts:166`, `:183`, `:193`, `:889`, `:915`, `:949`; `src/lib/SideBars/CharConfig.svelte:73`, `:1005`; and `src/ts/process/serverGeneration.ts:54` still use the helpers. The latter is a live pre-send write, not removed Phase 5 code.

**Fix.** Prefer temporary forwarding helpers that queue the appropriate character record, delete them after slice 8, and test non-selected-character writes while the shims exist. Alternatively move all callers into slice 5, increasing its scope. Do not retain watchers merely to keep these callers working. Spell out actual dependencies as `4 -> 6,7`, `5 -> 8`, `7 -> 8` for shared files, and `8 -> 9`; the drawing must not suggest readers can start directly after Stop A.

#### R4 — Split chat projection from activating lazy loading

**Problem.** Slice 9 changes server read contracts, client ownership, dozens of synchronous readers, plugin snapshots/writers, selection, LRU, and job lifetime simultaneously. Its loaded-map facade cannot safely stand in for a complete legacy chat array. It is the largest correctness boundary, with no useful isolation in the current single commit.

**Evidence.** `src/ts/storage/chatStore.svelte.ts:735` assumes a loaded mirror chat; `:2661` ignores notices for unknown chats. `src/ts/plugins/apiV3/pluginContext.ts:42` synchronously resolves the bound persona from `findChat`. `src/ts/process/mcp/risuaccess/host.ts:30` reads the selected chat without loading it. `src/ts/network/jobChannel.ts:374` checks held revisions before callbacks. The canonical slice's “Compatibility views” and “Readers of non-selected chats” explicitly depend on all such readers moving together.

**Fix.** Recommended split, keeping existing numbering as 9a/9b:

- **9a: chat record API and reader migration, eager boot retained.** Move full chats to the owned map, separate compatibility types, introduce loading/detached-read/pin APIs, move all consumers, and add the server summary endpoint/types. Eager loading makes transitional commits coherent.
- **9b: summaries at boot and eviction enabled.** Turn on asynchronous selection, job pins, stale-summary refresh, and LRU only after no reader relies on a partial legacy array.

Trade-off: an extra commit and short-lived eager bridge versus much smaller failure diagnosis. Keep Stop C after 9b; no extra owner stop is needed unless a reader cannot be made load-safe. Pin before starting the load, release in `finally`, and cover refused sends, aborts, reconnects, callbacks, and terminal hydration. Use a selection-request generation/id check so a slow load for A cannot select A after the user selected B.

#### R5 — Retain four stops, with concrete exit evidence

Stop A is appropriate for the binding verdict and live convergence, B for completed record ownership, C for all readers plus lazy loading, and D for closeout. Do not merge live updates with ownership: testing the feed against the existing mirror first is valuable. Run 6 then 7 sequentially by default; their helper changes can couple them even with disjoint files.

Add to Stop B: zero persistence watchers, working structural facade, no dangling mark helpers, and no hydration echo. Add to Stop C: an explicit remaining-symbol allowlist, not “every reader moved” while parser/CBS and snapshots are intentionally waiting for 10. Add to Stop D: compatibility exports, local auth/asset flows, and preserved server request assertions. These boundaries follow `PLAN.md:89` (adapter removed only when writers route) and `:94` (source changes before shape shrinks).

### 2. Reader ownership audit

The draft's principal counts are reproducible: `DBState.db` 1,745 matching lines/123 files; `getDatabase(` 150/43; `selectedCharID` 544/47; indexed character pattern 417/21; `.chatPage` 110/35. These are textual counts, including comments and API names, with `*.test.ts` and `**/tests/**` excluded, not counts of executable reads.

**The ownership answer is no: not every live reader has an explicit, correct reader-slice owner.** Slice 10's catch-all is a safety net, not a substitute for assigning the following now:

| Verified evidence                                                                      | Problem and concrete owner/fix                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ts/alert.ts:51`, `:80`                                                            | Unassigned live accessor. Slice 7: read `usePlainFetch` from its settings record; keep alerts callable before boot finishes.                                                                               |
| `src/ts/process/regexFiles.ts:11`, `:30`                                               | Editor regex reads remain. Slice 7: selected preset/global-script records; this is not the removed server runtime.                                                                                         |
| `src/ts/process/stringlize.ts:44`, `:104`, `:149`, `:198`, `:273`                      | Browser formatting helpers still read presets. Slice 7; do not assume all request formatting left with Phase 5.                                                                                            |
| `src/ts/process/templates/jsonSchema.ts:124`, `:133`                                   | Schema helpers need selected preset context. Slice 7.                                                                                                                                                      |
| `src/ts/process/templates/chatTemplate.ts:17`, `:18`                                   | Settings and current-character wrapper. Slice 7 for settings, 8 for character resolution; keep shared pure formatter.                                                                                      |
| `src/ts/plugins/apiV3/pluginContext.ts:43`                                             | Mentioned in baseline, not assigned an actual migration. Slice 7 for preset/persona records; 9a for load-before-context capture. Do not silently use the ambient persona when the target chat is unloaded. |
| `src/ts/process/mcp/risuaccess/host.ts:29`                                             | Phase 5 moved reads into this tab host; listing only old handler files misses it. Slice 7 modules, 8 character list, 9a `currentMessages` with load/pin. Server `internal.ts` is a different host.         |
| `src/ts/storage/characterOrder.ts:12`                                                  | Referenced conceptually but omitted from allowed files. Slices 4/5 own explicit order writes and record membership reads.                                                                                  |
| `src/ts/process/files/inlays.ts:549`                                                   | The asset/feed scopes do not migrate `supportsInlayImage`'s `aiModel` read. Add slice 7.                                                                                                                   |
| `src/lib/ChatScreens/EmotionBox.svelte:7`, `ResizeBox.svelte:63`                       | Whole `getEmotion(DBState.db, ...)` arguments are not merely settings reads. Slice 8 owns these call sites and `util.ts` signature together (or explicitly defer all three to 10). Recommend 8.            |
| `src/ts/parser/parser.svelte.ts:470`, `:597`                                           | Character reads are missing from slice 8; display-settings scope in 7 and late CBS scope in 10 do not suffice. Add 8, with chat/CBS context work in 9a/10.                                                 |
| `src/ts/process/request/request.ts:493`, `transport.ts:55`, `src/ts/process/tts.ts:89` | Current-character wrappers survive despite their files being described as settings consumers. Add slice 8, with chat references in 9a.                                                                     |

Appendix A assigns all 150 files in the union search to phases of work, including infrastructure and comment-only matches. This is a proposed corrected ownership ledger; it does not claim the draft already contains those assignments. Multi-owner files must migrate by access category, not disappear wholesale from the next slice's inventory. Extend discovery to optional `DBState?.db`, imported accessor aliases, `getCurrentCharacter/getCurrentChat/getCharacterByIndex`, setters, and selection helpers. A literal `DBState.db` zero gate alone is insufficient (`src/ts/stores.svelte.ts:173`, `:183` use optional chains).

### 3. Live-update design

#### R6 — Reuse revision semantics, not a simplified “different seq” rule

**Problem.** The amendment correctly says to reuse hydration, but the canonical slice still says any different incarnation applies. A delayed older incarnation must not replace a recreated record. Null/deletion reads also have no comparable revision, so revision comparison alone cannot prevent a late 404 from erasing a newer recreation.

**Evidence.** `shared/resources.ts:133` orders by increasing `(seq, revision)` within one epoch. `src/ts/storage/resourceSync.svelte.ts:1794` rejects `<= 0`. `src/ts/storage/chatStore.svelte.ts:2644` compares non-null revisions, but `:2648` clears notices for null unconditionally. Thus the existing refresh helper is not a complete proof for concurrent feed reconciliation/deletion.

**Fix.** Make the canonical rule `compareRevision(incoming, held) > 0`, with separately defined equal-revision job metadata handling. Serialize/coalesce ref reads per key and retain an invalidation generation. A response may apply a deletion only if its request is still current and no newer notice/local acknowledgement/hydration superseded it; otherwise refetch. Reconcile omissions should enqueue a read, not blindly delete newer local state. Gate every response by epoch/session generation. Test delayed deletion -> recreation, delayed old incarnation, an event during revision-list reconciliation, and restore during an outstanding read. No replay log or durable tombstone is needed for this project.

#### R7 — Chat content deduplication must preserve job metadata

**Problem.** “The job resource event and feed event apply once” is too blunt. The job copy carries locks/watermarks absent from a refs-only feed. Skipping the equal-revision job event can leave a message locked or lose streaming ownership; using ordinary remote replacement on a streaming owner's chat can regress text.

**Evidence.** `src/ts/storage/chatStore.svelte.ts:643` separates content hydration from metadata; `:648` permits equal-revision job metadata, and `:701` restores newer stream text. `:735` permits equal content revisions. `src/ts/network/jobChannel.ts:383` flushes and checks hydration receipts before a callback. `shared/jobs.ts:411` deliberately hides secrets and auth refreshes from job hydration.

**Fix.** Keep job metadata processing even when the feed already installed the content revision. The owner continues to receive chunks/callback barriers on its job socket; the feed never owns a job or releases its locks. Feed chat refreshes wait while the owner chat is busy, or go through the same watermark-aware hydration mechanism. Preserve the callback receipt cache/barrier. Test both event orders at identical revisions, finalization while a job continues, a late chunk after finalization, and callback execution after a feed-first hydration. Treat this as correctness, not merely deduplicating fetch counts.

#### R8 — Store publisher needs a commit accumulator and nullable order deletions

**Problem.** The location is correct, but “publish after every put/delete/transaction” risks publishing inner writes before their enclosing transaction commits and double-publishing them. Changed chat orders in batch results do not include every character side effect. The proposed wire example allows null resource/chat revisions but not null chat-order revisions, despite cascaded deletion.

**Evidence.** `server/src/data/resourceStore.ts:322` joins an existing transaction; `:512` creates an order; `:550` deletes character chats/order. Batch paths repeat these at `:679` and `:686`; `:709` only returns the chat operation outcome's orders. `:725` permits grouped put/delete transactions and resets transaction state in `:757`. `server/src/data/chatStore.ts:869` deletes chats and their order without returning their refs.

**Fix.** Accumulate refs in the outer write scope, including side effects captured before deletion; discard on rollback; collapse repeated writes to final revisions; publish once after commit and after transaction state is cleared. Make order revision nullable for removal. Listener failure must not convert an already committed write into a reported write failure. Publish `replaceAll`'s epoch only after the new epoch is installed. Tests must cover grouped writes with an inner success followed by conflict/throw, caught conflicts, listener throws, character creation with empty order, cascaded deletion, chat create/delete order updates, and idempotent/no-op chat operations. This is a store concern; route-level emitters are not recommended.

#### R9 — Feed auth must refresh the JWT on reconnect

**Problem.** The amendment chooses the correct JWT-only server helper, but leaves the canonical “reconnects with the same URL” instruction. That URL's token expires.

**Evidence.** `src/ts/storage/nodeStorage.ts:21` gives JWTs five minutes; `server/src/routes/auth.ts:53` checks expiry; `:109` exposes JWT-only `isAuthorizedToken`, versus the password-accepting proxy helper at `:113`. `src/ts/network/generationJobs.ts:255` obtains auth when connecting. The app's one dispatcher is `server/src/app.ts:337`.

**Fix.** Reuse the route/path, obtain a freshly signed JWT for each feed connection, and rebuild the URL. Keep bounded reconnect/backoff and dispose old timers/listeners. Protect the revisions route with normal resource auth; a missing/invalid/expired token and raw password must fail the feed handshake. Include reconnect after more than five minutes in browser validation. Add `eventFeed.ts`, `network/generationJobs.ts`, `network/auxFetch.ts`, and `process/request/transport.ts` to slice 10's auth-import migration; they are absent from its enumerated split callers.

#### R10 — Pending remote work must have a complete application lifecycle

**Problem.** The pending-set idea is right, but resource dirty marks are not always real edits, and chat membership events cannot be handled solely with `markChatNoticed`. Remote deletion of a character can also destroy dirty child-chat work if only the character's own key is checked.

**Evidence.** `src/ts/storage/resourceSync.svelte.ts:1798` compares projected text because a dirty mark alone may be hydration; `:1707` removes a character and calls `forgetCharacter`. `chatStore.svelte.ts:2663` ignores unloaded/unknown chats, and `:2680` clears local order work in `acceptRemoteCollection`. `:2604` lists chat refresh exclusions.

**Fix.** Define eligibility in terms of real unsent changes, sending keys, quarantine, server-job retry blocks, and child/order work for destructive membership changes. Drain pending entries on acknowledgement, conflict settlement, no-op dirty cleanup, quarantine release, retry expiry and generation completion—not just successful saves. New characters/chats and removed orders need a separate membership application path with order reconciliation; do not call the destructive conflict helper for unsolicited updates. Capture epoch and application-time state after `tick()` while watchers remain. After ownership switches, hydration must use private application paths with no `onWrite` callback. Test a remote parent deletion while a child edit is unsent, new chat creation in an already-held character, and pending work that becomes eligible without another user edit.

#### R11 — `llmSecrets` needs revision/sibling adoption, not only `setMaskedSecrets`

**Problem.** Refreshing the masked status alone leaves the resource's held revision and readable siblings stale. Conversely, reusing conflict adoption indiscriminately can report a discard for an unsolicited event.

**Evidence.** `src/ts/storage/resourceSync.svelte.ts:981` already distinguishes saved siblings, local sibling edits, and status refreshes; its conflicting branch calls `acceptRemote` and shows a notice at `:994`. `src/ts/storage/llmSecrets.svelte.ts:95` overlays pending credential writes on masked status. `server/src/data/kinds.ts:199` masks reads and preserves omitted secrets on writes. `src/ts/process/mcp/mcp.ts:140` reads `authRefreshes`; server jobs write refresh changes through `server/src/mcp/jobTools.ts:169`.

**Fix.** Specify feed adoption for the complete masked resource: revision, sibling text, status invalidation, and pending secret operations. Reuse the useful comparisons, but defer unsolicited conflicting siblings until the normal save/conflict path decides them; do not add discard bookkeeping merely for a feed event. Invalidate all relevant credential-dependent caches on a newer remote secret revision even if `{set,hint}` is unchanged. Keep `authRefreshes` client-readable and included in ordinary feed dispatch, while leaving it excluded from job callback hydration. Test two distinct credentials with the same hint, pending secret writes plus sibling edits, and a job OAuth refresh reaching the other tab. The refs-only broadcast must never include credential data.

Removing `chatChangeNotices` when this feed passes the same-browser matrix is recommended. Remove its producer in `src/ts/network/generationJobs.ts:368` and startup at `resourceSync.svelte.ts:1986`, not only the module. Preserve notices/idle-refresh machinery that the new feed still needs. Permission-store reload and targeted inlay invalidation are sensible; both need stale-response protection using their own held revisions/cache generations.

### 4. Owner questions

| Question                | Review and recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Checkpoint observers | **Ask; agree with 3 s checkpoints.** `server/src/prompt/runner.ts:44` already sets 3,000 ms. It meets convergence without another observer protocol. Explain that observers get checkpoint text and server-enforced edit refusals, not necessarily the owner's live lock/stream UI. Ask separately only if identical lock UI is required.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2. Trash/order cleanup  | **Recommend client explicit mutations, but distinguish maintenance from idle hydration.** Existing expiry deletion is `bootstrap.ts:374`, order repair `characterOrder.ts:12`. No need for a new server sweep for an alpha project. Decide this as implementation detail unless owner wants expiry to happen without a browser. Run no-write checks on a settled valid store, and separately assert the expected writes for expired trash or invalid order. Do not demand migration of disposable historical saves.                                                                                                                                                                                                                              |
| 3. BroadcastChannel     | **Decide without owner: remove after feed equivalence.** It is redundant transport, not a product choice. A fallback adds two invalidation paths and does not solve cross-device disconnection. Preserve existing guarantees via feed tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4. Character deferral   | **Recommend removal, but fix the justification and keep review coverage.** The entire scope is not frozen: `server/src/jobs/jobScope.ts:32` freezes configuration while `:37` describes live character/chat overlays. The correct argument is that replacing the tab's mirror is not mutating the job's in-memory object; job writes and callback barriers still explicitly refresh server records. Verify hydration plus callbacks and ordinary edits during a send. This can be a technical decision; if keeping it as owner-facing behavior, state exactly which conflict notice/update may arrive sooner.                                                                                                                                    |
| 5. Selection timestamp  | **Ask; agree with removing selection-time stamping.** `characters.ts:718` stamps on selection and `MobileCharacters.svelte:64` displays/sorts interaction; `serverGeneration.ts:52` retains the pre-send stamp. This changes visible recency, so record owner acceptance. Note that current pre-send code also reaches preview modes (`serverGeneration.ts:56`); do not silently change that policy in this question.                                                                                                                                                                                                                                                                                                                            |
| 6. Early remnants       | **Ask once as a scheduling amendment; agree.** Phase 5's explicit decision at `docs/plan/phases/slices/phase-5-server-side-processing/implementation-plan.md:217` places them in closeout. Moving the same removal earlier is technically preferable; no extra scope is implied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7. Request oracles      | **Removal already authorized; test coverage is a technical obligation.** Stop E includes test-only provider oracles. Recommend removing the implementations after adapting useful assertions to server entrypoints. `serverParity.test.ts:572` contains the differential comparison, but `requests.responses.test.ts:6` imports the oracle directly and its tests at `:218`, `:503`, `:632`, `:754` are behavioral tests, not a “differential half.” There is no server-only half there to retain automatically. Rehost equivalent assertions, or identify existing server cases that cover each behavior, before deletion. Frozen oracle fixtures add ongoing dependency/mocking cost; retaining captured input/output expectations is cheaper. |

Missing owner decision: **the explicit-mutation interpretation of a write-through property assignment**, already required by the spike's “Owner verdict line.” List it with the questions, or explicitly make it the decision at Stop A. Define fallback scope then. Do not ask the owner to choose revision capture mechanics, LRU internals, deletion fencing, or test harness design: reviewers should settle those from invariants. Four owner stops can remain unchanged.

### 5. Remaining slice amendments and invariants

#### R12 — Separate record types from compatibility characters; do not remove shared fields wholesale

**Problem.** Slice 9 deletes `chats/chatPage` from `shared/database.ts`, while slice 10 promises unchanged plugin snapshots and the server continues to use those character shapes. This creates work outside the slice's allowed files and risks changing shared contracts unnecessarily.

**Evidence.** `shared/database.ts:587`, `:590`, `:748`, `:751` declare the fields. `server/src/jobs/jobScope.ts:170` assembles compatibility characters and `:230` reads their chats; `server/src/jobs/cbsHost.ts:105`, `shared/cbs/registry.ts:125`, and `shared/cbs/evaluator.ts:711` depend on the same shape. These are live server/shared consumers.

**Fix.** Recommended: introduce a chat-free client resource type, e.g. an `Omit` of the compatibility character fields (also excluding render-only fields), and keep `character/groupChat` or a clearly named compatibility type for server CBS models, cards and plugin snapshots. Apply the no-chat type to client records so type checking exposes client readers. Alternative: rename/retype every compatibility consumer in 9a, with a much larger shared/server diff; no functional benefit justifies that expansion here. Keep `DeepReadonly` wherever still used; its deletion is not a goal.

#### R13 — Normalize creation/imports comprehensively and deterministically

**Problem.** The “seven non-pure steps” improvement still labels defaults too broadly. `creation_date = Date.now()` is not pure; lorebook version conversion and legacy TTS conversion are deterministic transforms rather than inherently interactive operations. Restricting them to `characterCards.ts` misses other accepted creation/import APIs. Also `checkNewFormat` contains character defaults absent from the named selection formatter.

**Evidence.** `characters.ts:690` generates a timestamp; `:691`, `:697`, and `:739` perform lore/TTS conversions; `bootstrap.ts:291` through `:308` supply additional defaults. `characterStore.svelte.ts:99` is the common external creation boundary. `bootstrap.ts:318` contains interactive module repair, while `:363` is a deterministic lore conversion. `database.svelte.ts:61` normalizes presets/personas but `:64` merely defaults modules to `[]`.

**Fix.** Enumerate defaults from both boot and formatter. Put deterministic normalization in shared pure helpers reused by creation and the server normalizer; assign id/time once in the creator or inject time explicitly, never on reads or every normalizer pass. Keep chat creation/fmIndex/note transfer in the chat/import orchestration layer. Cover cards, module imports, plugin-created characters and native character/group creation as applicable. Drop obsolete save-layout repair under the alpha policy; keep compatibility transformations required for accepted shared artifacts. Move interactive malformed-module handling to import, not perpetual startup. Replace the draft's “old-store boot” migration gate with a settled current-schema fixture plus relevant artifact import cases.

#### R14 — Fix the actual CBS host and snapshot redaction scope

**Problem.** `src/ts/cbs.ts` is not the live host. Deleting the shared evaluator's fallback could break the server and custom CBS functions. An unconstrained “records read model” can also recreate the aggregate being removed. The old slice's report builder description (“every section except secrets...”) risks losing preset/persona fields and changing its report schema.

**Evidence.** `src/ts/cbs.ts:1` is a three-line re-export. Actual client hosts are `src/ts/parser/parser.svelte.ts:1084`, `:1160`, `:1182`; the host contract is `shared/cbs/types.ts:66`, with evaluator fallback at `shared/cbs/evaluator.ts:701`. Existing report logic is `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:24` onward. Forwarded preset/persona aliases are defined in `src/ts/storage/forwarding.svelte.ts:15`.

**Fix.** Assign parser host/context work to 10 (and preloading to 9a); keep shared fallback unless all hosts are deliberately adapted. Pass a bounded, operation-scoped read model with captured ids and loaded chat context, or field selectors; no globally cached reactive aggregate. Preserve existing report keys/redaction and plugin subset semantics with snapshot builders, including aliases and per-tab selection. A fresh detached snapshot is allowed; a replacement live database service is not. Include `__proto__` preservation using JSON-safe cloning rather than `$state.snapshot` for user-keyed maps.

#### R15 — Flush-time revision capture is acceptable only with the application fence

The recommendation can stay, with an explicit contract: a dirty/in-flight record cannot have its saved base advanced by unsolicited hydration, and a write during flight remains queued on the acknowledged base for the next cycle. Otherwise flush-time capture can authorize stale content with a newer revision. Evidence: operations take saved revisions from `src/ts/storage/resourceSync.svelte.ts:633`; hydration guards at `:1798`; public forwarding resolves writes untracked at `forwarding.svelte.ts:38`.

Add edit -> remote notification -> flush, edit during own acknowledgement, and edit -> same-task selection switch proofs. Record identity must be captured at the mutation, even when revision is captured at flush. Cached nested wrappers must rebind only within the same logical record after replacement; they must never redirect a retained old preset reference to the newly selected preset. Removing dirty watchers does not permit asynchronous write-back effects.

#### R16 — Small corrections across slices 4–11

- **4:** Agree on 13 collections including `statics`, explicit sibling-only secret writes, and keeping the Phase 4 mutation names. Boot application and remote application need a non-mutating raw path, not public write-through setters. Keep preset/persona resolution and secret cleanup/copy side effects when moving lifecycle functions (`forwarding.svelte.ts:64`, `llmSecrets.svelte.ts:70`).
- **5:** Preserve home selection as null/id with a correct `-1` shim. Selection persistence must maintain this tab's choice without forcing another tab's selection; `selection.svelte.ts:1` documents session-first and localStorage new-tab fallback. Move the `supaMemory` mutation into explicit selection handling, not a new persistence watcher (`stores.svelte.ts:169`). Ordinary render effects such as `moduleUpdate` can remain.
- **6/7:** Agree on registry callbacks, aliases, `SecretInput`, and one-argument `applyPresetTemplate`. Make the `CharConfig` module write owned by **7**, not “6 or 7”; 6 is settings pages. Audit async bindings for captured ids, not just textual replacement. Preserve `edittrans` in the tab as explicitly accepted at Phase 5 Stop E (`implementation-plan.md:214`).
- **8:** Resolve every selection/index use to the intended id before awaits. Own helper signature changes and their callers in the same slice (R2/R3 and ownership table). Plugin index APIs may retain stable creation-order mapping at their compatibility boundary.
- **9:** Summary excludes messages, memory, bookmarks and `toolCalls`; full/detached reads preserve them. Keep UI paging as a render window. A detached export/plugin snapshot must define whether it first flushes pending local edits: recommend flush, reject an unresolved/discarded save for operations promising current data, then read server chats. Otherwise changing to detached reads silently returns older content than today's mirror. Existing `exportAsDataset.ts:7` reads the current database; `jobChannel.ts:383` demonstrates an existing explicit flush/discard barrier.
- **10:** Migrate all auth imports (R9), preserve asset key semantics, and keep actual asset routes while deleting only generic storage methods. Recompute a real allowlist; do not let it authorize arbitrary new reader architecture here. `setDatabaseLite`/forwarding tests need harness changes rather than pretending Phase 3/4 suites remain unchanged.
- **11:** Agree with no Vite proxy change, deletion of the app dispatcher branch/GC/dispose, and retaining browser caches still used. Preserve `/proxy2` local-network policy. Measure transform cost as the canonical slice specifies; do not turn the known asset hang or duplicate-render follow-ups into migration blockers. Move lasting behavior notes/validation gaps into guides before removing the plan; record the final report/measurements in the closeout commit so git history contains them.

Invariant assessment: D1/D4 change deliberately at slices 4/5/9, so update their documentation when ownership changes, not only at the last stop. D2/PLAN 5 require normalized projection equality and no echo writes; D3/PLAN 6 require unchanged persisted misspellings and compatibility aliases. U4 requires home/selection preservation through deletion and async loading. T1–T3 require pnpm, strict Node/shared compilation, relative `.ts` shared imports, and runes only in Svelte files. P1 retains the server-only gate; P2 retains server providers and intentional Plugin/WebLLM browser exceptions and write-only credentials. **There is no P3 invariant in current STRUCTURE.md** (P2 ends before Security at `STRUCTURE.md:114` onward); do not invent one. S1 retains parser sanitization and scoped CSS while changing context acquisition; S2 retains low-level permission gates and plugin consent. No proposed reader convenience should bypass them. Relevant anchors: `STRUCTURE.md:31`, `:58`, `:73`, `:83`, `:86`, `:108`, `:114`, `:125`, `:129`, `:144`; `PLAN.md:88`–`:107`.

### 6. Validation and deliberate test invalidation

Run existing `pnpm check` and `pnpm test` per implementation slice, plus format checks of changed content and the required phase-wide formatting gate. Build and Playwright are essential for runtime production changes; a test-only spike need not run Docker or the full browser matrix. `playwright.config.ts:3` describes the isolated local stack. Browser validation should use local fixtures/fake providers; it need not contact public providers. Docker validates the packaged Node/shared paths and production proxy/auth behavior, not just the Vite dev build.

No new tests were created in this review. The recommendations describe coverage the implementation/test-management step must preserve or supply under its applicable test-editing authorization. Separate harness adaptations from deliberately removed assertions in the adapter report.

| Slice | Required meaningful checks                                                                                                                                                                                                                                                                                                                                                    | Existing tests deliberately affected                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Svelte harness proves nested writes, membership bridge, identity after switch/replacement, no hydration echo, deletion, own `__proto__`, no full serialization per keystroke; compare cost with an actual baseline. No Docker; real browser binding check if harness differs from compiled component behavior.                                                                | No existing behavior invalidated. Reuse `forwardingSpike.test.ts`/`forwardingHarness.svelte.ts` assumptions rather than modifying them to force a pass.                                                                                                                                                                                                                                                                                                       |
| 2     | Unit/store/route/socket coverage for R6–R11, all commit paths and rollback; two browser contexts for edit/creation/deletion/reorder/secret-status/auth-refresh, reconnect, epoch restore, callback overlap and checkpoint observation. Docker at A.                                                                                                                           | `chatChangeNotices.test.ts` retires if module removed; `resourceSyncNotices.test.ts` retains equivalent convergence/busy-refresh assertions via feed. Adapt generation socket notice assertions and fixtures as needed. Existing `resourceSyncHydration.test.ts:327` exclusion tests remain valid for **job hydration**, even though feed accepts more kinds.                                                                                                 |
| 3     | Existing server hydration/job lock/flush/unload suites; browser send/continue/abort, navigate during send, ordinary pagehide edits.                                                                                                                                                                                                                                           | Browser-generation cases in `chatStore.test.ts:309`, `:346`, `:383`, `:435`, `:478`, `:741`, `:756`, `:776`, `:803`, `:860`, `:900`, `:991`; inspect/rehost mixed assertions rather than delete every case. `chatLock.svelte.test.ts:92`, `:139`; mixed `resourceSyncNotices`, `characterStore`, `resourceSyncHydration:566`, `resourceSyncChats:262`, `:361`, `:463`, `:541`. Keep ordinary lost-acknowledgement, pagehide, queue, and server-lock behavior. |
| 4     | Record transport/normalizers/secrets/collection lifecycle, conflicts and idle reload; settings pages under unchanged facade; preset/persona e2e.                                                                                                                                                                                                                              | Watcher-specific portions of `resourceSync.test.ts`, `resourceSyncSections.test.ts`, `resourceSyncSecrets.test.ts`, forwarding/settingWrappers suites and mutation-store harnesses. Keep behavior assertions, adapt seeding/flush harness only where needed. Existing Phase 3/4 suites are not promised source-identical.                                                                                                                                     |
| 5     | Character membership, non-selected writes, array bridge, selection shims, normalization/import, trash/order maintenance, deletion during send; browser create/group/import/trash/reorder; Docker B.                                                                                                                                                                           | `characterStore.test.ts`, `characters.test.ts`, `characterCardsImport.test.ts`, `resourceSyncChats.test.ts`, selection/mutationScope harnesses. Selection-time timestamp assertions intentionally change only with Q5. If deferral removed, old deferral-specific assertions change, but conflict notices and job callback behavior stay.                                                                                                                     |
| 6     | Registry callback/condition/onChange contexts; settings pages including nested arrays, secrets and preset switch; existing preset/persona e2e.                                                                                                                                                                                                                                | `OtherBotSettings.hypaV3Export.test.ts`, `Language/TranslatorPresetSettings.test.ts`, `settingWrappers.test.ts`: direct aggregate mocks adapt. No output/export behavior should be deleted.                                                                                                                                                                                                                                                                   |
| 7     | Onboarding, theme, hotkeys, formatting/schema helpers, auxiliary requests, browser Plugin/WebLLM exceptions, translator edittrans, memory modal/playground; focused browser UI flows.                                                                                                                                                                                         | Direct DB mocks in request `transport.test.ts`, `tokenizer.test.ts`, `plugins.test.ts`, translator tests, `NanoGPTDashboard.test.ts`, TTS tests and settings-consumer harnesses. Keep provider routing and no-credential-leak assertions.                                                                                                                                                                                                                     |
| 8     | Selection and captured ids after await, character editors/lore/scripts, mobile/grid/emotion rendering, plugin and tab MCP context; focused Playwright interaction.                                                                                                                                                                                                            | `hotkey.test.ts`, `characters.test.ts`, card/import and pluginContext/hostApi suites: selection/aggregate fixtures adapt; index API contract remains.                                                                                                                                                                                                                                                                                                         |
| 9a/9b | Summary server route shape/no message reads; full/detached preservation; selected/pending/in-flight/quarantined/generating pins, >8 chats, rapid selection A/B, stale load, new/delete membership, plugin setters after eviction, callback context before selection change. Browser branches/bookmarks/HypaV3/export/plugins/MCP and 30-chat/2,000-message fixture; Docker C. | Eager mirror assumptions in `chatStore`, `resourceSyncChats`, `resourceSyncHydration`, `bootSnapshot`, `localLoreDraft` consumers, `charactersImportChat`, plugin host/context/saved-write suites, `jobChannelBarrier`, `serverGeneration`, `transformClient`, parser scoped/CBS fixtures. Adapt setup to explicit load; never weaken “complete chat” assertions.                                                                                             |
| 10    | Strict client+server type check, build, full existing unit/e2e; snapshot shape/redaction, asset auth/bytes, startup, zero outgoing idle reload, plugin getters/setters and compatibility exports. Docker before archive (may be final-stop smoke).                                                                                                                            | `database.setDatabase.test.ts`, facade-specific forwarding/forwardingSpike tests retire or move surviving guarantees to records. `autoStorage.test.ts` retires; `nodeStorage.test.ts` splits into auth/assets. All aggregate-mocking harnesses need migration. **All five current e2e specs reference the aggregate**, not just unit tests (examples below).                                                                                                  |
| 11    | Full remaining gates, no production live accessor/codec/old route; Docker two-client matrix including restart/restore; transform timing and docs link/identifier audit.                                                                                                                                                                                                       | `proxyStreamJobs.test.ts` removed; proxy-specific `generations.test.ts:564` case adapted. Oracle files deleted only after useful `serverParity` and Responses assertions are rehosted/mapped (Q7).                                                                                                                                                                                                                                                            |

Important corrections to validation:

- Current `e2e/idleReload.spec.ts:26` expects first boot to create modules/plugins, and `:36` asserts those two writes. `:43` asserts zero writes on reload. If server normalization now creates these records, deliberately change the **first-boot** expectation in slice 4/10, not the reload guarantee. If Q2 retains expiry/order maintenance, test that separately rather than weakening every idle gate.
- E2E setup reads/writes the aggregate at `e2e/presetSelection.spec.ts:21`, `personaBinding.spec.ts:30`, `idleReload.spec.ts:48`, `serverTransform.spec.ts:285`, and `transformGolden.spec.ts:102`. The adapter list must include all five; retain user-visible assertions while changing seeding/selecting/inspection. `pnpm test:e2e` alone does not cover the proposed feed matrix today.
- Test symbol searches must exclude both `*.test.ts` and `**/tests/**` when measuring production. Tests-only oracle files do not have `.test.ts` suffixes. Conversely a production compile must still include supported shared/server consumers. Keep plugin API method names and injected CBS `getDatabase` methods distinct from the removed live accessor.
- Avoid a Docker smoke for the test-only spike. A, B, C and D remain sensible image gates; do not repeat an unchanged full matrix on every mechanical reader file move. Per-slice standard unit/type gates and targeted browser checks remain valuable.

### 7. Post-implementation Challenge and reviewer

A reviewer is needed for **every production slice**, including test adaptations. A separate Challenge is most valuable at 1 (binding verdict), 2 (feed), 4/5 (ownership/facade), 9a/9b (chat contracts/lazy lifetime), and 10 (aggregate/auth/snapshot removal). Keep both there; the reviewer should independently examine evidence and not merely execute Challenge advice.

A separate Challenge can be skipped for **3**, if scope is strictly dead browser producers and tests with retained server-lock coverage; if it also removes character deferral, keep the Challenge. It can be skipped for **6/7/8** when they are constrained reader migrations using an already proven record API, with a complete ownership ledger, passing existing assertions and targeted browser evidence. Escalate any new mutation mechanism, async context change or unplanned API design to Challenge. It can be skipped for **11** if route/oracle retirement has its prescribed coverage and the reviewer performs a final invariant/exit audit; a final phase-wide Challenge is still reasonable if 11 contains substantive behavioral work.

For **1**, a single independent reviewer who checks the proofs and records the verdict can technically cover both roles; if keeping a named Challenge session for the segment, use it to challenge the mutation interpretation and retained-reference proofs rather than duplicating mechanical review. These are suggested workflow reductions, not authorization to override an owner's explicitly retained process. The Phase 5 Stop E record (`implementation-plan.md:220`) explicitly carries the test adapter/commit/stops exception; the final Phase 6 plan should state the chosen review cadence once.

### Appendix A. Corrected full-file ownership ledger

The following 150 files are the complete union of the literal searches below in current `src`, excluding tests, declarations and Markdown. The line is the first textual match (sometimes an import/comment), not necessarily the first executable access. Rows assign all access categories that must be handled; a slice number does not mean every reference in the file belongs to that slice. Infrastructure rows explicitly persist through multiple slices. No file is silently assigned to an unspecified “straggler” step.

```sh
rg -n 'DBState\.db|getDatabase\(|selectedCharID|selIdState|\.chatPage' src \
  -g '!*.test.ts' -g '!**/tests/**' -g '!*.d.ts' -g '!*.md'
```

| Current-tree evidence                                               | Corrected owner(s), using draft numbering                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/App.svelte:51`                                                 | 7 UI read; 10 final shell cleanup                                                          |
| `src/lib/ChatScreens/BackgroundDom.svelte:5`                        | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/ChatScreens/Chat.svelte:83`                                | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/ChatScreens/ChatBody.svelte:101`                           | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/ChatScreens/ChatScreen.svelte:5`                           | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/ChatScreens/Chats.svelte:12`                               | 3 inert streaming branch; 7 settings; 8 characters; 9 full chat rendering                  |
| `src/lib/ChatScreens/DefaultChatScreen.svelte:25`                   | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/ChatScreens/EmotionBox.svelte:7`                           | 8 getEmotion signature/caller                                                              |
| `src/lib/ChatScreens/PartialEditController.svelte:815`              | 9 chat addressing                                                                          |
| `src/lib/ChatScreens/ResizeBox.svelte:63`                           | 8 getEmotion signature/caller                                                              |
| `src/lib/ChatScreens/Suggestion.svelte:6`                           | 7 settings; 8 character reads; 9 chat reads                                                |
| `src/lib/Mobile/MobileCharacters.svelte:78`                         | 8 character list; 9 summary chat count                                                     |
| `src/lib/Others/AlertComp.svelte:21`                                | 7 settings; 8 characters; 9 branch/full-chat reads                                         |
| `src/lib/Others/AllSeperateParameters.svelte:28`                    | 7                                                                                          |
| `src/lib/Others/BookmarkList.svelte:11`                             | 8 character resolution; 9 selected chat                                                    |
| `src/lib/Others/ChatList.svelte:6`                                  | 8 character resolution; 9 summaries                                                        |
| `src/lib/Others/CustomSidebarConfig.svelte:24`                      | 7                                                                                          |
| `src/lib/Others/GridCatalog.svelte:7`                               | 8 list/selection; 10 residual formatChars signature                                        |
| `src/lib/Others/HypaV3Modal.svelte:6`                               | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/bulk-edit-actions.svelte:4`             | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/category-manager-modal.svelte:5`        | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/modal-footer.svelte:4`                  | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/modal-summary-item.svelte:26`           | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/tag-manager-modal.svelte:5`             | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/HypaV3Modal/utils.ts:6`                             | 7 settings; 8 character resolution; 9 full chat/memory                                     |
| `src/lib/Others/IrisModal.svelte:68`                                | 7                                                                                          |
| `src/lib/Others/PopupEditor.svelte:23`                              | 7 settings; 8 current-character helper                                                     |
| `src/lib/Others/ProTools/EasyPanel.svelte:23`                       | 7                                                                                          |
| `src/lib/Others/PromptDiffModal.svelte:152`                         | 7                                                                                          |
| `src/lib/Others/WelcomeRisu.svelte:26`                              | 7                                                                                          |
| `src/lib/Playground/PlaygroundEmbedding.svelte:60`                  | 7                                                                                          |
| `src/lib/Playground/PlaygroundMenu.svelte:4`                        | 5 structural creator if facade omitted; 7 settings; 8 character selection                  |
| `src/lib/Playground/PlaygroundSubtitle.svelte:23`                   | 7                                                                                          |
| `src/lib/Setting/Pages/Advanced/BanCharacterSetSettings.svelte:53`  | 6                                                                                          |
| `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte:29`     | 6                                                                                          |
| `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:24`    | 10 report snapshot                                                                         |
| `src/lib/Setting/Pages/BotSettings.svelte:58`                       | 6                                                                                          |
| `src/lib/Setting/Pages/ClaudeThinkingSeparateParams.svelte:11`      | 6                                                                                          |
| `src/lib/Setting/Pages/Display/ColorSchemeSelect.svelte:31`         | 6                                                                                          |
| `src/lib/Setting/Pages/Display/CustomBackgroundToggle.svelte:11`    | 6                                                                                          |
| `src/lib/Setting/Pages/Display/CustomColorSchemeEditor.svelte:26`   | 6                                                                                          |
| `src/lib/Setting/Pages/Display/CustomTextThemeEditor.svelte:16`     | 6                                                                                          |
| `src/lib/Setting/Pages/Display/NotificationToggle.svelte:10`        | 6                                                                                          |
| `src/lib/Setting/Pages/Display/NullableTextColorToggle.svelte:13`   | 6                                                                                          |
| `src/lib/Setting/Pages/DisplaySettings.svelte:11`                   | 6                                                                                          |
| `src/lib/Setting/Pages/GlobalLoreBookSettings.svelte:20`            | 6                                                                                          |
| `src/lib/Setting/Pages/GlobalRegex.svelte:12`                       | 6                                                                                          |
| `src/lib/Setting/Pages/HotkeySettings.svelte:19`                    | 6                                                                                          |
| `src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte:22` | 6                                                                                          |
| `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte:10`           | 6                                                                                          |
| `src/lib/Setting/Pages/Module/ModuleChatMenu.svelte:9`              | 6 settings; 8 characters; 9 chats                                                          |
| `src/lib/Setting/Pages/Module/ModuleMenu.svelte:32`                 | 6                                                                                          |
| `src/lib/Setting/Pages/Module/ModuleSettings.svelte:67`             | 6 modules; 5 structural creation if facade omitted; 8 character readers                    |
| `src/lib/Setting/Pages/OobaSettings.svelte:25`                      | 6                                                                                          |
| `src/lib/Setting/Pages/OpenrouterSettings.svelte:15`                | 6                                                                                          |
| `src/lib/Setting/Pages/OtherBotSettings.svelte:6`                   | 6 settings; 8 character access                                                             |
| `src/lib/Setting/Pages/PersonaSettings.svelte:29`                   | 6                                                                                          |
| `src/lib/Setting/Pages/PluginSettings.svelte:30`                    | 6                                                                                          |
| `src/lib/Setting/Pages/PromptSettings.svelte:29`                    | 6                                                                                          |
| `src/lib/Setting/Pages/SeparateParametersSection.svelte:17`         | 6                                                                                          |
| `src/lib/Setting/SettingRenderer.svelte:20`                         | 6                                                                                          |
| `src/lib/Setting/Settings.svelte:197`                               | 6                                                                                          |
| `src/lib/Setting/Wrappers/SettingSegmented.svelte:53`               | 6                                                                                          |
| `src/lib/Setting/botpreset.svelte:44`                               | 6                                                                                          |
| `src/lib/Setting/listedPersona.svelte:25`                           | 6                                                                                          |
| `src/lib/Setting/lorepreset.svelte:23`                              | 6                                                                                          |
| `src/lib/SideBars/CharConfig.svelte:14`                             | 5 structural/mark bridge; 7 module writes; 8 character editors; 9 chat metadata            |
| `src/lib/SideBars/CustomSidebar.svelte:3`                           | 7 settings; 8 characters; 9 chats                                                          |
| `src/lib/SideBars/DevTool.svelte:2`                                 | 7 settings; 8 characters; 9 chats                                                          |
| `src/lib/SideBars/LoreBook/LoreBookData.svelte:299`                 | 8 character lore; 9 chat local lore; 7 any settings                                        |
| `src/lib/SideBars/LoreBook/LoreBookList.svelte:5`                   | 8 character lore; 9 chat local lore; 7 any settings                                        |
| `src/lib/SideBars/LoreBook/LoreBookSetting.svelte:16`               | 8 character lore; 9 chat local lore; 7 any settings                                        |
| `src/lib/SideBars/Scripts/TriggerV2List.svelte:477`                 | 7 settings/registry reads                                                                  |
| `src/lib/SideBars/SideChatList.svelte:18`                           | 7 settings; 8 characters; 9 summary list                                                   |
| `src/lib/SideBars/Sidebar.svelte:6`                                 | 8 list/order/selection                                                                     |
| `src/lib/SideBars/Toggles.svelte:3`                                 | 7 settings; 8 characters; 9 chats                                                          |
| `src/lib/UI/GUI/MultiLangDisplay.svelte:15`                         | 7                                                                                          |
| `src/lib/UI/GUI/TextAreaInput.svelte:283`                           | 7                                                                                          |
| `src/lib/UI/GUI/TextAreaResizable.svelte:39`                        | 7                                                                                          |
| `src/lib/UI/MainMenu.svelte:66`                                     | 7                                                                                          |
| `src/lib/UI/ModelList.svelte:126`                                   | 7                                                                                          |
| `src/lib/UI/NanoGPTDashboard.svelte:45`                             | 7                                                                                          |
| `src/lib/UI/PromptDataItem.svelte:115`                              | 7                                                                                          |
| `src/lib/UI/Realm/RealmHubIcon.svelte:21`                           | 7                                                                                          |
| `src/lib/UI/Realm/RealmPopUp.svelte:47`                             | 7                                                                                          |
| `src/lib/UI/Title.svelte:23`                                        | 7                                                                                          |
| `src/ts/alert.ts:51`                                                | 7                                                                                          |
| `src/ts/bootstrap.ts:15`                                            | 2 feed; 4/5 assembly/defaults; 9 boot summaries; 10 aggregate removal                      |
| `src/ts/characterCards.ts:34`                                       | 5 import normalization; 8 identity; 9 chat reads; 10 exports                               |
| `src/ts/characters.ts:24`                                           | 5 structural writers/defaults; 8 character readers; 9 chat import/export                   |
| `src/ts/drive/backuplocal.ts:192`                                   | 10 inventory snapshots                                                                     |
| `src/ts/globalApi.svelte.ts:15`                                     | 7 settings; 8 character selection; 9 chat folds/selection; 10 auth/assets/saveDb           |
| `src/ts/gui/animation.ts:4`                                         | 7                                                                                          |
| `src/ts/gui/colorscheme.ts:220`                                     | 7                                                                                          |
| `src/ts/gui/guisize.ts:9`                                           | 7                                                                                          |
| `src/ts/hotkey.ts:14`                                               | 7 settings; 8 id selection                                                                 |
| `src/ts/media/compressImage/compressImage.ts:6`                     | 7                                                                                          |
| `src/ts/model/modellist.ts:42`                                      | 7                                                                                          |
| `src/ts/network/jobChannel.ts:54`                                   | 7 settings; 8 character lookup; 9 callback chat lifetime/barrier                           |
| `src/ts/parser/chatVar.svelte.ts:2`                                 | 7 globals; 9 loaded chat                                                                   |
| `src/ts/parser/parser.svelte.ts:13`                                 | 7 display/settings; 8 characters; 9 chat context; 10 CBS host                              |
| `src/ts/parser/transformClient.ts:131`                              | 7 settings; 9 context; 10 auth import                                                      |
| `src/ts/persona.ts:20`                                              | 7 selection/records; 10 any remaining snapshot boundary                                    |
| `src/ts/plugins/apiV3/permissionStore.ts:6`                         | 2 feed reload; match is a DBState comment, not an aggregate read                           |
| `src/ts/plugins/apiV3/pluginContext.ts:43`                          | 7 preset/persona capture; 9 load-safe bound-persona context                                |
| `src/ts/plugins/apiV3/v3.svelte.ts:68`                              | 7 settings; 8 character APIs; 9 chat APIs; 10 subset snapshots                             |
| `src/ts/plugins/plugins.svelte.ts:116`                              | 7 settings; 10 snapshot/allowlist cleanup                                                  |
| `src/ts/process/command.ts:12`                                      | 7 settings; 8 identity; 9 chat addressing                                                  |
| `src/ts/process/files/inlays.ts:549`                                | 2 invalidation; 7 supportsInlayImage; 10 asset client                                      |
| `src/ts/process/group.ts:8`                                         | 8 characters; 9 chats                                                                      |
| `src/ts/process/lorebook.svelte.ts:3`                               | 5 any removed mark shim callers; 7 settings; 8 character lore; 9 local chat lore           |
| `src/ts/process/mcp/googlesearchclient.ts:39`                       | 7                                                                                          |
| `src/ts/process/mcp/mcp.ts:140`                                     | 7 settings/auth refreshes; 9 tool records                                                  |
| `src/ts/process/mcp/risuaccess/host.ts:29`                          | 7 modules; 8 character list; 9 async currentMessages                                       |
| `src/ts/process/mcp/risuaccess/utils.ts:10`                         | 8 character resolution                                                                     |
| `src/ts/process/memory/contextualEmbedding.ts:34`                   | 7                                                                                          |
| `src/ts/process/memory/hypamemory.ts:45`                            | 7                                                                                          |
| `src/ts/process/memory/hypamemoryv2.ts:41`                          | 7                                                                                          |
| `src/ts/process/memory/hypav3.ts:119`                               | 7                                                                                          |
| `src/ts/process/modules.ts:370`                                     | 4 module lifecycle; 7 settings; 8 character writes; 9 chat modules                         |
| `src/ts/process/prompt.ts:357`                                      | 7                                                                                          |
| `src/ts/process/regexFiles.ts:11`                                   | 7                                                                                          |
| `src/ts/process/request/request.ts:106`                             | 7 settings; 8 current-character wrapper                                                    |
| `src/ts/process/request/shared.ts:36`                               | 7                                                                                          |
| `src/ts/process/request/transport.ts:56`                            | 7 settings; 8 character; 9 chat context; 10 auth import                                    |
| `src/ts/process/serverCommands.ts:222`                              | 7 settings; 8 identity; 9 target load/pin                                                  |
| `src/ts/process/serverGeneration.ts:46`                             | 5 dirty-mark bridge; 7 statics; 8 character write; 9 target load/pin                       |
| `src/ts/process/stableDiff.ts:25`                                   | 7                                                                                          |
| `src/ts/process/stringlize.ts:44`                                   | 7                                                                                          |
| `src/ts/process/templates/chatTemplate.ts:17`                       | 7 preset; 8 current character                                                              |
| `src/ts/process/templates/jsonSchema.ts:124`                        | 7                                                                                          |
| `src/ts/process/tts.ts:100`                                         | 7 settings; 8 current character                                                            |
| `src/ts/setting/types.ts:125`                                       | 6                                                                                          |
| `src/ts/setting/utils.ts:25`                                        | 6                                                                                          |
| `src/ts/storage/browserLocalImport.ts:216`                          | 7 settings access; 10 boot/import wiring                                                   |
| `src/ts/storage/characterOrder.ts:12`                               | 4 order record; 5 character membership                                                     |
| `src/ts/storage/characterStore.svelte.ts:5`                         | 5 ownership; 9 chat-free client type                                                       |
| `src/ts/storage/chatStore.svelte.ts:18`                             | 2 remote apply; 3 browser remnants; 5 facade integration; 9 chat ownership/lazy loading    |
| `src/ts/storage/collectionStore.svelte.ts:53`                       | 4 ownership; 10 final preset/helper moves                                                  |
| `src/ts/storage/database.svelte.ts:36`                              | 4/5 forwarding wrappers; 9 loaded-chat wrapper; 10 removal                                 |
| `src/ts/storage/exportAsDataset.ts:7`                               | 9 detached complete reads; 10 snapshot cleanup                                             |
| `src/ts/storage/forwarding.svelte.ts:15`                            | 4/5 facade; 9 eager compatibility bridge; 10 removal                                       |
| `src/ts/storage/llmSecrets.svelte.ts:18`                            | 2 remote status; 4 record ownership                                                        |
| `src/ts/storage/localLoreDraft.svelte.ts:3`                         | 9 selected loaded-chat draft                                                               |
| `src/ts/storage/pluginStorageStore.svelte.ts:24`                    | 4 record transport                                                                         |
| `src/ts/storage/resourceSync.svelte.ts:45`                          | 2 feed; 3 browser remnants; 4/5 ownership; 9 chat integration; 10 mirror removal           |
| `src/ts/stores.svelte.ts:27`                                        | 5 id shims/selection mutation; 9 chat module reads; 10 DBState removal                     |
| `src/ts/tokenizer.ts:92`                                            | 7 settings; 9 chat/context reads                                                           |
| `src/ts/translator/translator.ts:10`                                | 7                                                                                          |
| `src/ts/util.ts:4`                                                  | 7 personas; 8 characters/getEmotion; 9 loaded-chat helpers; 10 residual snapshot signature |

Final review verification: every explicit full-path citation in this report exists and its line number is within the current file; the final `git status --short` remained empty. No repository files or git state were changed.

## Reviewer evaluation of the draft and the review (F-a to F-m)

Evaluated 2026-10-03 at `metatron` HEAD `ee57e2e9`, clean tree (re-checked at the end). Inputs:
`/tmp/p6-plan/plan.md` (Opus draft), `/tmp/p6-plan/plan-review.md` (Astra, R1-R16, owner table,
validation table, Appendix A), the Luna reports as leads, and the canonical Phase 6 files. Every
claim below that carries a `file:line` was read in the current tree. No repository file was
changed, no command changed git state, nothing was run against the network; this file is the only
output.

### 0. Summary

- The draft's direction and most of its drift corrections hold in the code. Astra's review is
  mostly accurate and its strongest points (R2/R3 the facade cannot absorb character membership
  writes and the dirty-mark callers outside slice 5's files; R4 the 9a/9b split; R6 the
  "different seq" rule; R8 the commit accumulator; R9 the JWT on reconnect; R12 the shared
  `chats`/`chatPage` shape; R14 the real CBS host) should be adopted.
- Where I push back: R10's protection of child-chat edits during a remote parent deletion and
  R6's per-key read serialization are more machinery than an alpha, single-user, two-tab app
  needs; R1's "remove the inert streaming branch" silently turns a user-visible setting into a
  no-op; R16-5 assumes the character selection is persisted, which it is not today; Q7's
  "rehost before deletion" is right only for behavior the server tests do not already cover.
- Both documents miss: the streaming display optimization has been dead since the cutover (F-a);
  `forageStorage` is the asset path, not removable (F-b); the draft would start persisting the
  character selection (F-c); the CBS host contract can be narrowed by type (F-d); own-write feed
  echoes cause a needless read per save (F-e); the deferral watches the selected character, not
  the send target, which is the real argument for removing it (F-f); two plugin test files and
  three source files are missing from the lists (F-g, F-h); who writes the spike (F-i); and four
  smaller items (F-j to F-m).
- Final shape: 12 slices (the draft's 11 with 9 split into 9a/9b), four stops as drafted. The
  deferral removal moves from slice 3 to slice 5, so slice 3 is pure dead code and needs no
  Challenge. Owner questions: four (section 5); everything else is a planner decision.

### 1. Verification of load-bearing claims

### Draft claims

| Claim                                                                                                      | Verdict                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Counts table                                                                                               | Holds (within one line)                                                    | My union search gives 150 files; `DBState\.db` gives 1,744 lines / 122 files with tests and `**/tests/**` excluded (draft 1,745 / 123; the difference is a `.d.ts`/`.md` match).                                                                                                                                                                                                                 |
| `checkpointAllGenerations` still called by flush and visibility; `unloadCheckpoint` by pagehide            | Holds                                                                      | `resourceSync.svelte.ts:1886`, `:1993`, `:2033`.                                                                                                                                                                                                                                                                                                                                                 |
| `beginGeneration`, `endGeneration`, `hasRunningGenerations`, `setStreamingState` have no production caller | Holds                                                                      | `rg` finds them only as definitions and inside `releaseGeneration` (`chatStore.svelte.ts:525`, `:1027`, `:841`, `:1096`; `:1064`).                                                                                                                                                                                                                                                               |
| `applyHydration` excludes `llmSecrets` and `authRefreshes`                                                 | Holds                                                                      | `shared/jobs.ts:411` `HIDDEN_HYDRATION_KINDS`.                                                                                                                                                                                                                                                                                                                                                   |
| `chatChangeNotices.ts` overlaps the feed                                                                   | Holds; path is `src/ts/storage/`, not `network/`                           | Producer `network/generationJobs.ts:370`, `:388`; start `resourceSync.svelte.ts:1986`; throttle 1 s (`chatChangeNotices.ts:16`).                                                                                                                                                                                                                                                                 |
| `applyServerGeneration` writes only into a chat in the mirror                                              | Holds                                                                      | `chatStore.svelte.ts:565-568` returns false without `mirrorChat(ref)`.                                                                                                                                                                                                                                                                                                                           |
| The character deferral is live                                                                             | Holds, but the count is wrong                                              | `bootstrap.ts:201-216`; about a dozen `deferredCharacters`/`generatingCharacter()` sites in `resourceSync.svelte.ts` (217, 261, 298, 315, 660, 684, 913, 1389, 1405, 1521, 1619-1637, 1810), not five.                                                                                                                                                                                           |
| The deferral is safe to delete because "a server job reads its own frozen scope"                           | **Wrong justification**                                                    | `server/src/jobs/jobScope.ts:32-37`: configuration is frozen, but "the job's chat and the characters" are a live overlay re-read by `refreshChat`/`refreshCharacter`. The removal is still right, for the reason in F-f.                                                                                                                                                                         |
| `characterFormatUpdate` has seven non-pure steps                                                           | Holds                                                                      | `characters.ts:609-736`: `ensureChat`, `postHistoryInstructions` (668-677), `creation_date ??= Date.now()` (690), `updateLorebooks` (691), `updateInlayScreen` (693), TTS (697-700), `lastInteraction` (718, unconditional; `changeChar` passes an `updateInteraction` flag the function ignores, `characters.ts:1001`), `fmIndex` (725-731).                                                    |
| `setDatabase` still normalizes presets/personas/modules                                                    | Holds                                                                      | `database.svelte.ts:61-64` (`normalizePresets`, `normalizePersonas`, `modules ??= []`).                                                                                                                                                                                                                                                                                                          |
| `NodeStorage` is not assets-only; `AutoStorage`/`forageStorage` are live                                   | Holds, but see F-b: the "generic" `getItem`/`setItem` _are_ the asset path | `nodeStorage.ts` `setItem`/`getItem`/`keys`/`removeItem` over `/api/write                                                                                                                                                                                                                                                                                                                        | read | list | remove`; `forageStorage.getItem/setItem` carry every asset and inlay read/write (`globalApi.svelte.ts:111-201`, `inlays.ts:161`, `:236`, `:537`). |
| No `vite.config.ts` proxy entry; `README.md:74` stale                                                      | Holds                                                                      | `README.md:74` lists `/proxy-stream-jobs`; the `generations.test.ts:564` case is the dispatcher test.                                                                                                                                                                                                                                                                                            |
| Registry: four item pairs                                                                                  | Holds                                                                      | `displaySettingsData.svelte.ts:417-454` (`customQuotesData[0..3]`).                                                                                                                                                                                                                                                                                                                              |
| Server store anchors                                                                                       | Hold                                                                       | `resourceStore.ts:497` put, `:535` delete, `:586` applyChanges, `:706` COMMIT, `:725` transaction, `:883` replaceAll; callers `routes/resources.ts:197/274/301`, `backups.ts:99/346`, `generationJobs.ts:476`, `llmSecrets.ts:73`. Job writes (including MCP `writeRefresh`, `jobTools.ts:169-174`) all go through `job.write` → `applyChanges`, so a store-level publisher covers every writer. |
| "Five test files mix client-generation and server-lock cases"                                              | Partly wrong                                                               | `chatLock.svelte.test.ts:118`, `:140` are both browser `beginGeneration` (Astra is right). The list also misses `plugins/apiV3/hostApi.test.ts:360/364` and `hostApiRouting.test.ts:461/471` (F-g).                                                                                                                                                                                              |
| Slice 5: "`selection.characterId` per tab, `sessionStorage` like the others"                               | **Behavior change, unrecorded** (F-c)                                      | Today the character selection is not stored: `bootstrap.ts:119` starts at `-1`; `selection.svelte.ts:25` writes preset/persona to both `sessionStorage` and `localStorage`. The canonical slice says "per tab, not persisted".                                                                                                                                                                   |
| Q7: "keep the server-only assertions" of `requests.responses.test.ts`                                      | Wrong framing                                                              | The file imports only the oracle (`requests.responses.test.ts:6`); it has no server half. The oracle README already records "removed with those tests in Phase 6's closeout".                                                                                                                                                                                                                    |

### Astra claims

All cited anchors I opened exist and say what Astra says (R1 `Chats.svelte:13/87`, `chatStore:470/2349`;
R2 `characterStore:99/126`, `bootstrap:286`, `CharConfig:657`; R3 the mark callers; R4
`pluginContext:42-43`, `risuaccess/host.ts:29-30`, `jobChannel:374/383`; R6 `compareRevision`
`shared/resources.ts:133`, `resourceSync:1794`, `chatStore:2644-2650`; R7 `hydrateChat`
`chatStore:637-728` and `applyChatHydration` equal-revision acceptance at `:749`; R9
`nodeStorage.ts:21` (5 min), `auth.ts:109/113`; R11 `adoptSecretRecord` `resourceSync:981-997`;
R12 `shared/database.ts:587/590/748/751`, `jobScope:170/230`, `cbsHost:105`, `registry:125`,
`evaluator:701/711`; R14 `src/ts/cbs.ts` is a 3-line re-export, client hosts `parser.svelte.ts:1084`,
`:1160`, `:1182`). Two corrections: R1 calls the streaming branch "inert" without noting the setting
it disables (F-a); Appendix A misses three files (F-h).

### 2. Verdicts on the review

### R1 — keep slice 3, complete its boundary

**Agree with changes.** Keep the slice, expand the adapter list by symbol search (add F-g's two
plugin files), keep `serverGenerations`, watermarks, retired generations, job metadata and
server-lock behavior. Two changes:

- The `streamingState` branch is not just inert code: it is what made the
  `streamingDisplayOptimizationMode` setting (`advancedSettingsData.ts:246`) do anything. Removing
  the branch while keeping the setting makes the setting a silent no-op. This is an owner choice
  (F-a, owner question 3), not a cleanup.
- The deferral (`deferredCharacters`, `setGeneratingCharacter`, `watchGeneration`) is live
  server-send code, not dead browser code. It moves to slice 5 (where the same `resourceSync`
  character sites are rewritten anyway). Slice 3 then stays mechanical, which is what lets its
  Challenge be skipped.

### R2 — the facade cannot stand in for character membership; move structural writers to slice 5

**Agree.** The structural character writers are few and specific: `PlaygroundMenu.svelte:34`,
`:44`; `CharConfig.svelte:657`, `:764`; `ModuleSettings.svelte:88`; `DefaultChatScreen.svelte:1055`;
and in `characters.ts` (already in slice 5's files) `:37`, `:43`, `:182`, `:192`, `:213`, `:223`, and
`removeChar`'s `chars.splice(index, 1)` + `DBState.db.characters = chars` (`:948-955`), which removes
a character without `removeCharacter`. Several are Svelte-3 self-assignments
(`characters[i] = characters[i]`) that become deletions. Widen slice 5's allowed files to these
`src/lib` sites. Keep the spike proofs for indexed replacement, retained references after
replacement, and "hydration produces zero queued writes"; drop the proofs for a membership facade
(push/splice/whole-array semantics) because nothing will rely on it after slice 5. Collections are
not affected: a collection is one record holding the array (`resourceSync.svelte.ts:1693-1700`), so
the 38 `push`/`splice` sites on `modules`, `personas`, `botPresets` etc. are ordinary record writes.

### R3 — do not delete the dirty-mark helpers before their callers move

**Agree with changes.** The holes are real: `CharConfig.svelte:1005` and `serverGeneration.ts:54`
are outside slice 5's files; `bootstrap.ts:212` goes with the deferral. Prefer moving the two
callers into slice 5 (one line each; `serverGeneration.ts:52-54` becomes
`updateCharacter(chaId, { lastInteraction })`) over a temporary forwarding shim. Adopt the explicit
dependency list (`4 → 6, 7`; `5 → 8`; `7 → 8` for shared files; `8 → 9a`).

### R4 — split slice 9 into 9a (records and readers, eager boot) and 9b (summaries and eviction)

**Agree.** The cited readers (`pluginContext.ts:42`, `risuaccess/host.ts:30`, `jobChannel.ts:383`,
`applyChatHydration` requiring a mirrored chat) show the single slice has no safe intermediate state.
The selection-request id check (a slow load of A never selects A after B) is cheap; adopt. Pin before
the load and release in `finally`; adopt.

### R5 — four stops with concrete exit evidence

**Agree.** The added exit evidence is checkable and cheap.

### Section 2 table (unassigned readers) and Appendix A

**Agree with changes.** Every row I opened holds (`alert.ts:51`, `regexFiles.ts:11`,
`inlays.ts:549`, `risuaccess/host.ts:29`, `EmotionBox.svelte:7`, `request.ts:493`). Adopt the ledger
as the starting inventory, copied into the final implementation plan (it lives only in `/tmp`), with
three missing files added (F-h) and regenerated at each reader slice's start. The extended discovery
(`DBState?.db`, `getCurrentCharacter`/`getCurrentChat`/`getCharacterByIndex`, setters) is right;
Astra's own ledger did not apply it, which is how F-h was missed.

### R6 — reuse revision ordering, not "a different seq applies"

**Agree with changes.** The canonical rule (`live-updates.md:128`: apply when `seq` differs) would
apply an older incarnation; `compareRevision > 0` (`shared/resources.ts:133`) is already what
`applyHydration` uses (`resourceSync.svelte.ts:1794-1797`). Also compare the change set's revision
with the held one _before_ reading (F-e). For a `null` (deleted) read, one guard is enough: apply the
deletion only if the held revision is unchanged since the read was issued, else re-read. **Disagree**
with per-key read serialization plus an invalidation generation: the 50 ms batch and that one guard
cover a two-tab app; a delete-then-recreate of the same id needs a restore (which changes the epoch)
or a reimport with an identical id. No replay log or tombstone, as Astra itself says.

### R7 — chat deduplication must keep job metadata

**Agree with changes**, smaller than written. The existing code already does the right thing:
`applyChatHydration` accepts an equal revision (`chatStore.svelte.ts:749`) and `hydrateChat`
processes job metadata when `metadataCurrent` (`:650`), and the feed's chat path is
`markChatNoticed` + idle refresh, which waits while the chat is generating (`canRefreshChat`,
`:2604-2614`). The plan only has to say: the feed never dedupes away a job socket event, and the
draft's validation line "apply once" means "read once", not "process once". Tests for both event
orders at one revision are enough; the late-chunk-after-final case is already covered by retired
generations.

### R8 — store publisher with a commit accumulator

**Agree.** Accumulate in the outer write scope, drop on rollback, publish once after commit and
after `transactionState` is cleared (`resourceStore.ts:757`), nullable order revision for cascaded
deletion, a listener failure never fails a committed write. This is the natural shape, not
over-engineering. Extend the existing dispatcher test (`generations.test.ts:564`) with the events
path in slice 2, so slice 11 only drops the proxy half.

### R9 — fresh JWT per feed connection

**Agree.** `nodeStorage.ts:21` signs for five minutes; a reconnect with the original URL fails after
that. The extra auth-import callers for slice 10 hold: `auxFetch.ts:2`, `generationJobs.ts:11`,
`transport.ts:22` import `authFetch`/`getNodeServerProxyAuth` from `nodeStorage`.

### R10 — pending remote work lifecycle

**Agree with changes.** Adopt: eligibility by real unsent change (the existing text comparison at
`resourceSync.svelte.ts:1798`), drain on acknowledgement/conflict/no-op cleanup/quarantine release/
retry expiry/job end, a separate membership path for new characters and chats (never
`acceptRemoteCollection` for unsolicited events), and raw application paths with no write-back after
ownership switches. **Disagree** with protecting a tab's unsent child-chat edits when another tab
deletes the parent character: deletion already goes through trash (`characters.ts:948`), the user
asked for it, and the server rejects the orphaned writes. Record it as accepted behavior; no extra
test.

### R11 — `llmSecrets` feed adoption

**Agree with changes.** Reuse `adoptSecretRecord` (`resourceSync.svelte.ts:981-997`) for its first
two branches; for the third (local sibling edit and remote sibling change), defer to the pending set
instead of `acceptRemote` + notice, and let the normal save's 409 decide. Invalidate credential
caches on any newer revision. The "two credentials with the same hint" test is cheap and catches a
real cache bug; keep it. Agree on removing `chatChangeNotices` including its producer and start-up.

### Owner-question table

| Q                         | Astra                                     | My verdict                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Observer granularity    | Ask; 3 s                                  | **Agree, as a confirmation, not an open design question.** Same-browser tabs already see checkpoint granularity today (the Stop D fix via `chatChangeNotices`); the feed extends that to other devices. `runner.ts:44` is 3 s.                                                                                                                                                                                                   |
| 2 Trash/order maintenance | Implementation detail                     | **Agree.** Client mutations at boot; the boot that prunes writes, an idle boot does not. Separate assertions for "expired trash writes a delete" and "settled store writes nothing".                                                                                                                                                                                                                                             |
| 3 BroadcastChannel        | Decide without owner                      | **Agree.** Remove after the feed passes the same-browser case.                                                                                                                                                                                                                                                                                                                                                                   |
| 4 Deferral                | Technical decision, fix the justification | **Agree**, with the justification in F-f, and in slice 5 (not 3).                                                                                                                                                                                                                                                                                                                                                                |
| 5 Selection stamp         | Ask                                       | **Agree.** Visible recency change (`MobileCharacters.svelte:64` sorts by it). Keep the pre-send stamp as is, previews included.                                                                                                                                                                                                                                                                                                  |
| 6 Early remnants          | Ask once                                  | **Agree with changes.** It keeps the removal inside Phase 6 as the owner decided; moving it earlier is only a scheduling change. State it in the plan the owner approves; no separate question.                                                                                                                                                                                                                                  |
| 7 Oracles                 | Removal authorized; rehost first          | **Agree with changes.** Removal is authorized (Stop E; oracle README). Before deleting, the test adapter maps each `requests.responses.test.ts` case (27 `it` blocks) to a server test and retargets only the uncovered ones to the server port in `server/src/llm/`. `serverParity.test.ts`'s differential part goes. `memoryOracle.test.ts` is a different oracle (the HypaV3 browser code stays for the modal); not in scope. |

**Missing owner decision (the write-through record as the explicit mutation of invariant 2):
agree.** Ask it at Stop A, with the spike's evidence, and define the fallback's file scope before
slice 4 starts (Astra R2's last paragraph is right: slices 4/5 forbid `src/lib` today).

### R12 — keep the shared compatibility shape; give client records a chat-free type

**Agree.** The server CBS host and the shared registry read `chats`/`chatPage`
(`cbsHost.ts:105`, `registry.ts:125`, `evaluator.ts:711`). An `Omit` client record type exposes
client readers through the compiler without touching server contracts.

### R13 — creation and import normalization

**Agree with changes.** Enumerate defaults from both `checkNewFormat` (`bootstrap.ts:286-308`) and
`characterFormatUpdate`, put deterministic ones in a shared pure helper used by `addCharacter` and
the server normalizer, inject time once at creation. Under the alpha policy, drop the save-layout
repairs outright (the `checkNewFormat` character block, `assignIds`, the module lorebook prompt at
`:316-366`) rather than relocating them; keep only transforms that accepted card/module files need
(`updateLorebooks` for imported lore v1, the TTS `none` mapping only if old cards carry it). Replace
the draft's "old-store boot" gate with a settled current-schema fixture plus card/module import
cases.

### R14 — the real CBS host and snapshot scope

**Agree, and make it compiler-enforced (F-d).** Keep the shared evaluator fallback; adapt the
client hosts (`parser.svelte.ts:1084`, `:1160-1182`). Preserve the settings-report keys and
redaction and the plugin subset semantics.

### R15 — flush-time base revision capture with an application fence

**Agree.** The three extra proofs (edit → remote notice → flush; edit during own acknowledgement;
edit → same-task selection switch) are the right ones and belong in the spike.

### R16 — small corrections

- 4: **Agree** (13 collections, sibling-only secret writes, raw application path).
- 5: **Agree with changes.** "Selection persistence must not force another tab's selection" assumes
  the character selection is stored; it is not today, and should stay unstored (F-c). Move the
  `supaMemory` write (`stores.svelte.ts:169-177`) into `selectCharacter`; keep `moduleUpdate` as a
  render effect.
- 6/7: **Agree**; the `CharConfig.svelte:1773` module push is slice 7's.
- 8: **Agree.**
- 9: **Agree** on summary fields and flush-before-detached-read (`flushResources` exists; cheap).
- 10: **Agree**, made precise by F-b.
- 11: **Agree.** The asset hang and duplicate render stay out (Stop D/E decisions).
- Invariant paragraph: agree; the "no P3" remark is harmless (the draft does not cite a P3).

### Validation table and corrections

**Agree with changes.** Adopt: no Docker or browser matrix for the test-only spike; the
`idleReload.spec.ts:36` first-boot expectation (`modules+`, `plugins+`) changes deliberately if
slice 4 moves those defaults to the server, and `:43` (reload writes nothing) never changes; all
five e2e specs touch the aggregate (`idleReload:48`, `presetSelection:21`, `personaBinding:30`,
`serverTransform:285`, `transformGolden:102`) and are adapted in slice 10 (they keep working through
the facade until then); production gates exclude `*.test.ts` and `**/tests/**`. Add F-g's two plugin
files to slice 3's row. The slice 3 row's `chatStore.test.ts` list should be "every case that calls
`beginGeneration`/`endGeneration`/`checkpointGeneration`" (27 matches), not line numbers.

### Section 7 — Challenge and reviewer cadence

**Agree with changes.** Fable review on every slice (the exception requires it). Challenge on 1
(scoped to the proof set and the verdict), 2, 4, 5, 9a, 9b, 10. Skip on 3 (once the deferral moved
to 5), 6, 7, 8 (the reviewer audits every index → id conversion across an await), and 11. The draft's
"every slice gets a Challenge" is more than needed; escalate a skipped slice to a Challenge only if
it adds a mutation function or changes async context.

### 3. Additions (missed by both documents)

**F-a. The streaming display optimization has been inert since the cutover.**
`setStreamingState` has no caller outside `releaseGeneration` (`chatStore.svelte.ts:1064`), which
only the dead browser path reaches; `applyServerGeneration` (`:558-598`) never sets it. So
`Chats.svelte:86-95` never sees a streaming message, and the `strong` mode's raw rendering
(`Chat.svelte:425`) and the hide-translate/edit branches (`:728`, `:1137`, `:1154`) never run for a
server send. `e2e/serverTransform.spec.ts:274` passes for all three modes because locked messages
render raw anyway; it does not assert any mode difference. Fix: owner question 3. Recommended: rewire
in slice 3 (set the streaming state on a job's first chunk for the target message with the configured
mode, clear it in `endServerJob` and on the final hydration release; about ten lines in
`chatStore.svelte.ts`) so the setting keeps its meaning; the alternative is deleting the setting with
the branch.

**F-b. `forageStorage` is the asset store; do not delete it.** Every asset and inlay read/write is
`forageStorage.getItem/setItem` → `NodeStorage` → `/api/read|write` with an `assets/` key
(`globalApi.svelte.ts:111-201`, `inlays.ts:161/236/537`, server `routes/storage.ts:229/346`). The
draft's step 0 wording ("delete the generic file methods, `AutoStorage`, and `forageStorage`") would
break assets. Fix for slice 10: an asset client (`readAsset`/`writeAsset` over the same routes)
replaces `forageStorage` at its callers (`globalApi`, `inlays`, `characterCards`, `modules`); delete
`AutoStorage`, `keys`, `removeItem` (no client caller), and move `authFetch`/`getNodeServerProxyAuth`
to an auth module with all eight importers (`rg 'from .*nodeStorage'`). The server routes stay.

**F-c. Do not start persisting the character selection.** The draft adds `selection.characterId` "in
`sessionStorage` like the others"; today a reload starts at home (`bootstrap.ts:119`), and
`selection.svelte.ts:25` would also write it to `localStorage`, so a new tab would open the last
character. Under 9b it would also force a chat load at boot. Fix: `characterId` lives in the
`selection` object but is excluded from `save()`, as the canonical slice says ("not persisted").

**F-d. Narrow the CBS host type instead of building a database-shaped view.** The shared registry
and evaluator read only `aiModel`, `subModel`, `maxContext`, `promptTemplate`, `mainPrompt`,
`jailbreak`, `jailbreakToggle`, `globalNote`, `language`, and `characters` (counted over
`shared/cbs/*.ts`). Change `CbsHost.getDatabase: () => Database` (`shared/cbs/types.ts:66`) and
`CbsParseArg.db` (`:21`) to a `Pick<Database, ...>` plus a character lookup; the server's job `db`
satisfies it unchanged, and the client host reads exactly those fields from the records. This turns
R14's "bounded read model" and the Safety Contract ("no aggregate under another name") into a
compile error instead of a review judgement. Slice 10.

**F-e. Own-write echoes.** On one server the feed event of a tab's own save can arrive before the
HTTP acknowledgement. With the draft's flow (read, then compare; the key is in flight, so it goes
pending and is re-read after the acknowledgement) every save costs a second read. Fix: compare the
change set's revision with the held revision on receipt and drop it when not newer; when draining
pending entries on acknowledgement, drop those whose revision is at or below the acknowledged one
without reading. Same rule removes the redundant read of the job owner's chat after its final
hydration.

**F-f. The real argument for removing the deferral.** `watchGeneration` takes the _selected_
character when `doingChat` starts (`bootstrap.ts:207`), while a server send may target another
character (`serverGeneration.ts:46`, `arg.target ?? currentChatRef()`). The post-send
`markCharactersDirty([generatingId])` (`bootstrap.ts:212`) is redundant since the pre-send stamp
marks the target (`serverGeneration.ts:54`). No client code holds a character object across a server
job. So the deferral protects nothing the server relies on and sometimes guards the wrong character.
Remove it in slice 5 with its tests; keep the generation lock's edit refusals.

**F-g. Missing tests in slice 3's adapter list.** `src/ts/plugins/apiV3/hostApi.test.ts:360/364` and
`hostApiRouting.test.ts:461/471` use browser `beginGeneration`/`endGeneration` as a lock fixture for
the plugin's generation protection. They are harness changes (lock through a server generation), not
deletions.

**F-h. Three files missing from Appendix A.** `src/lib/Others/SavePopupIcon.svelte:7`
(`DBState?.db?.showSavingIcon`, slice 7), `src/ts/gui/branches.ts:69` (`getCurrentCharacter`,
slice 8), `src/ts/process/files/multisend.ts:1` (an unused `getDatabase, setDatabase` import, slice
10).

**F-i. Who writes the spike.** Slice 1 is test code. In Phase 3 the Fable test-adapter wrote the
spike from Opus's proof list (`phase-3-settings-sections/implementation-plan.md:178-183`). The draft's
workflow section only describes adapting invalidated tests. Fix: state that the test-adapter writes
the spike harness and proofs, Opus defines the proofs and records the verdict, the reviewer reviews.

**F-j. Doc invariants move with the slices.** `PLAN.md` invariant 7 and the STRUCTURE protocol step
7 require guides and D1-D4 to change in the same change. D4's "call `markCharactersDirty`"
instruction becomes false at slice 5 and D1's "`character.chats` read-only mirror fields" at 9a.
Each slice updates its guide lines; slice 11 does the full rewrite.

**F-k. `README.md:74` is stale today.** It lists `/proxy-stream-jobs` as forwarded by the dev server;
fix it in the plan commit (doc-only), not at closeout.

**F-l. Optional split of slice 5.** With the structural writers, the two mark callers, the deferral,
the selection id and the `characterFormatUpdate` split, slice 5 is the largest ownership slice. If
its diff grows past what one review can check, split the normalization (`characterFormatUpdate`, the
server character normalizer, import steps, trash/order maintenance) into 5b before Stop B. Planner's
call at slice start; no new stop.

**F-m. Translator and HypaV3 selections are shared, preset and persona selections are per tab.**
`applySettingsRecord` writes the server's `selectedId` into the mirror (`resourceSync.svelte.ts:1678-1680`);
with the feed, choosing a translator or HypaV3 preset in one tab switches it live in the other.
This is the Phase 3 design, not a defect; record it in the live-updates validation so a tester does
not report it.

### 4. Final slices, order, stops

```
0  plan commit (phase file, slice amendments, ledger, README:74)
1  spike (test-adapter writes it) ─┐
2  live updates ───────────────────┴─ Stop A (binding verdict = owner Q1; two-tab matrix on the flat mirror)
3  generation remnants (dead code; streaming state per owner Q3)
4  settings ownership
5  character ownership (+ structural writers, the two mark callers, deferral removal, selection id unpersisted)
   ─ Stop B (zero persistence watchers, no mark helpers, no hydration echo; Docker smoke)
6  readers: settings pages
7  readers: settings consumers (sequential after 6)
8  readers: characters
9a chat records and readers, eager boot
9b summaries at boot, pins, LRU
   ─ Stop C (symbol allowlist re-measured; Docker smoke)
10 aggregate removal (+ CBS host narrowing F-d, asset client F-b, snapshot builders, e2e adaptation)
11 closeout (proxy route, oracles per Q7 verdict, guides, archive) ─ Stop D (Docker two-client matrix)
```

- 9a/9b: right (R4).
- Structural character writers in slice 5: right (R2); they are few, listed above.
- Challenge skippable for 3, 6, 7, 8, 11 under the conditions in section 2; keep it for 1 (scoped),
  2, 4, 5, 9a, 9b, 10.
- Astra sessions per segment as drafted (A: 1-2, B: 3-5, C: 6-9b, D: 10-11).
- Docker at the four stops only; the idle-reload spec after every save-path slice (2, 4, 5, 9a, 9b,
  10).

### 5. Owner questions (must answer) and planner decisions

Owner questions:

1. **Write-through record as the explicit mutation** (at Stop A, with the spike's evidence; if
   rejected, the fallback is explicit function bindings at every site, and slices 4/5 gain the
   `src/lib` files). Recommended: accept if the proofs pass.
2. **Selecting a character no longer stamps `lastInteraction`** (only a send does), so the mobile
   list's recency means "last sent". Recommended: accept.
3. **Streaming display optimization** (F-a): rewire it to server streams in slice 3, or delete the
   setting with the branch. Recommended: rewire (small, keeps a user-visible setting meaningful).
4. **Observer granularity, as a confirmation:** other tabs and devices see a running reply at 3 s
   checkpoints, as same-browser tabs already do since Stop D; no per-chunk observer stream.
   Recommended: confirm.

Planner decisions (state in the plan, report at the stop, do not ask): generation remnants as slice
3 inside Phase 6 (scheduling only); `chatChangeNotices` removed after the feed passes; the deferral
removed in slice 5 (F-f); trash and order maintenance as client mutations at boot; oracles removed
with uncovered Responses cases retargeted to the server port; `selection.characterId` not
persisted; 9a/9b; structural writers in slice 5; revision capture at flush with the R15 fence; LRU
size, pins, and deletion fencing per R4/R6 as amended; the CBS host type narrowing; the asset client.
