# Archive Center 4.9.0: memory backend analysis

Read-only analysis of Archive Center (AC) 4.9.0 at `/home/codex/refer/archive-center`,
written 2026-11-01 for the metatron memory redesign. Nothing in that tree was run.

How to read the citations:

- Paths without a prefix are relative to `/home/codex/refer/archive-center`. Go paths
  under `go-service/internal/httpapi/` are written as `httpapi/<file>:<line>`, and
  `go-service/internal/store/` as `store/<file>:<line>`.
- `pretty:<line>` is a line in a prettier-formatted copy of the 3 MB plugin
  (`Archive Center.js`, 87,669 lines after formatting). Regenerate it with
  `pnpm exec prettier --parser babel "/home/codex/refer/archive-center/Archive Center.js"`
  from the metatron checkout. The original file has very long lines, so its line numbers
  do not match.
- Eight read-only Luna workers explored the tree in parallel. Every claim below was
  re-checked with a bounded read unless it is marked _(worker, unverified)_.
  Inferences are marked _Inference_.

The two pains this report keeps returning to:

- **P1:** as a chat grows, the user cannot tell whether summarization is working.
- **P2:** HypaV3 is weak for world-setting bots with many characters.

## 1. Overview

**What it is.** AC is a "local-first memory backend". It stores the original chat text
and derived memories locally, then sends memories and original-work evidence relevant to
the current scene with the next request (`README.md:4-5`). It has four runtime parts
(`README.md:33-38`):

| Part                | Role                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `Archive Center.js` | RisuAI plugin (`//@api 3.0`, `pretty:1-6`): observes hooks, talks to backend, applies payload, HUD/UI |
| Go backend          | memory selection, budget assembly, source and turn judgment, storage, orchestration                   |
| MariaDB             | canonical original text, memories and state                                                           |
| ChromaDB            | vector search layer that can be deleted and rebuilt                                                   |

The README says JS "is not a second backend" and that Go owns memory policy and storage
decisions (`README.md:38`).

**Size.** The Go service has 714 files (297 non-test). Non-test Go is about 192k lines,
and the whole service is about 407k lines. The migrations create 81 distinct tables.
`001_schema.sql` alone is 1,951 lines.

**Hooks used** (registered at `pretty:6789-6860`):

- `addRisuScriptHandler("input", onInputHook)` (`pretty:6795`). It only caches the raw
  input, flags history-trim slash commands, and ends stale request contexts
  (`pretty:6673-6697`).
- `addRisuReplacer("beforeRequest", onBeforeRequest)` (`pretty:6811`). This is the read
  path: "search + supervisor + context injection" (`pretty:52528`).
- `addRisuReplacer("afterRequest", onAfterRequest)` (`pretty:6830`). This is the write
  path: "turn save + critic trigger" (`pretty:52529`).
- `addRisuChatListener("output", onRisuOutput)` (`pretty:6841`). It only observes
  worldline/branch facts _(worker)_.
- `registerBodyIntercepter` (`pretty:30596-30611`). It is used only for the experimental
  "memory as PDF" transport modes (`pretty:30480-30530`).
- `onUnload` cleanup (`pretty:6856`).

AC does **not** use `editinput`, `editoutput`, `editprocess`, `editdisplay`,
`addProvider` or `setDatabase`. Only main-model requests take part: `isSaveType` returns
true only for `!type || type === "model"` (`pretty:52535-52541`). The comment there says
submodel, memory, emotion, translate and otherAx requests are ignored.

**Backend calls per turn.**

1. In `beforeRequest`, which RisuAI awaits:
   - `/session-routing/turn-resolution` and `/timeline` lookups for turn binding
     _(worker: `pretty:32305-32341`, `pretty:33009-33043`)_.
   - `/rollback/decision` and `DELETE /rollback/{turn}`, only when a deletion is detected.
   - `POST /prepare-turn` twice. The first call is source-decision only
     (`pretty:53902-53918`, `sourceDecisionOnly: true`). The second is the full
     preparation (`pretty:54150-54166`). The route itself is
     `httpapi/group_turn.go:44`.
   - A legacy JS orchestration helper, which always runs after prepare-turn and receives
     its bundle (`pretty:54376`).
2. After the response, `POST /complete-turn` (`httpapi/group_turn.go:42`). This holds
   the raw save, the Critic call, derived writes and episode checkpoints. `afterRequest`
   returns the response text synchronously (`pretty:55268-55420`) and starts the
   persistence coroutine afterwards, so saving does not delay display.
3. The HUD follows `GET /turn-workflow/events?request_id=` (`pretty:24386`).

**Coexistence with HypaV3/SupaMemory.** Nothing disables RisuAI's own memory. A search
of the plugin for `hypa`/`supa` finds:

- an import tool that reads `activeChat.hypaV3Data.summaries` and posts each summary as
  a separate memory to `/import/hypamemory` (`pretty:63098-63211`;
  `"Saves each HypaMemory summary ... as a separate memory with its original text"`,
  `pretty:2802`);
- a rollback guard that refuses automatic DB rollback when a gap "may be Hypa/RisuAI
  visible history compression" (`pretty:28421`).

_Inference:_ users are expected to turn HypaV3 off themselves, or accept two memory
systems running at once.

**Install burden.** A user runs the Go backend (port 28080), MariaDB (3307) and
ChromaDB (8000, needs Python), and updates the RisuAI plugin separately from the backend
(`README.md:23-24, 77-79`).

The Windows launcher downloads MariaDB 12.3.2 and CPython, then installs ChromaDB 1.5.9.
The full local build refuses to start if Chroma's upsert/readback/delete check fails
(`ops/full-package/00_README_FIRST_WINDOWS.md:25-27, 46-59`). A black console window
must stay open (`:58`). Mobile or other-PC use needs a LAN, Tailscale or HTTPS address
to the PC (`:77-79`). The user also configures an embedding model (`embeddingModel:
"text-embedding-3-small"` by default) and separate LLM slots for the Critic ("sub LLM")
and the Publisher ("plugin main") (`pretty:246-300`; embedding model at `pretty:286`).
Without a Critic config, complete-turn saves raw text only: "critic_config_missing:
derived memory/evidence/KG/... extraction skipped"
(`httpapi/group_turn_complete.go:1176-1180`).

## 2. Memory data model

All rows are keyed by `chat_session_id`. The plugin builds this from the character
index and the chat's opaque id, as `char_${charIdx}_cid_${chatUniqueId}`
(`pretty:13642-13690`), with weaker fallbacks after that _(worker:
`pretty:13646-13781`)_.

### 2.1 Original text and source revisions

- `chat_logs(chat_session_id, turn_index, role, content)` is "Canonical: every turn
  starts here. Append-only." (`migrations/001_schema.sql:9-19`). Migration 008 makes
  `(session, turn_index, role)` unique.
- `effective_input_logs` holds the user intent after preprocessing (`001:24-33`).
- `memory_source_revisions` (`migrations/005_memory_derivation_lifecycle.sql:5-38`)
  records one accepted host observation of a turn: `source_revision`, `logical_turn_id`,
  `source_message_id`, `source_generation_id`, `branch_id`, `branch_state`
  (`observed`/`not_exposed`), the raw user and assistant text with hashes,
  `host_observed_at_ms`, and `lifecycle_state` (`active`, `superseded`, `invalidated`,
  `deleted`). A generated column enforces one `active` revision per logical turn (`:21-31`). The
  header comment admits a gap: "Branch identity is intentionally nullable/not_exposed
  because the complete-turn Host observation contract does not expose it" (`:2-3`).
  Migration 006 adds `derived_admission_state` (default `pending`),
  `derived_result_hash`/`json` and `derived_admitted_at`. Migration 009 adds
  `critic_input_snapshot_json`/`hash` "so background reprocessing does not rebuild it
  from mutable state".

- `source_revision` is a hash of session, turn, host message/generation/branch/swipe
  identity and content hashes. `logical_turn_id` hashes session, host identity and the
  user message, so rerolls and edits of one input share it
  (`httpapi/complete_turn_source_acceptance.go:202-281`, worker-cited and consistent with
  the code read at `:760-819`).
- **"Source/turn judgment"** is the backend deciding which accepted host observation is
  authoritative for which canonical turn, and whether a new observation is a duplicate,
  a stale observation, a reroll or an edit. For example, reasons include
  `source_acceptance_stale_or_superseded` and `source_acceptance_deleted_or_rolled_back`,
  and replacement kinds are `host_observed_reroll` and `host_observed_edit`
  (`httpapi/complete_turn_source_acceptance.go:773-819`).

### 2.2 Derived memory

- **`memories`** (`001:38-55`) holds one aggregate row per turn: `summary_json` (the
  Critic extraction), `embedding` (a JSON float array), `importance`,
  `emotional_intensity`, `narrative_significance` and `place_wing`/`place_room`.
- **`direct_evidence_records`** (`001:62-84`) are verbatim excerpts with
  `source_turn_start/end`, `archive_state`, `capture_verification`, `tombstoned` and
  `superseded_by_id`. Critic excerpts land as `verified_direct` /
  `auto_grounded_excerpt` _(worker: `httpapi/turn_memory_admission.go:667-735`)_.
- **`precise_memory_units`** (`migrations/004_precise_memory_units.sql:4-60`) are atomic
  facts tied to an exact span. Columns cover the source (`source_revision`,
  `source_span_start/end`, `evidence_excerpt`, `evidence_hash`, `root_evidence_id`), the
  kind (`event`, `state`, `utterance`, `observation`, `boundary`, `profile`), five entity
  foreign keys (actor, subject, affected, location, object), epistemics (`truth_scope`,
  `epistemic_mode`, `authority_class`, `visibility`, `knowledge_holder_entity_id`,
  `reveal_condition`) and state (`admission_state`, `review_state`, `lifecycle_state`).
  A CHECK requires `source_span_end > source_span_start`. The precise-unit gate requires
  the excerpt to match the supplied span exactly, or to occur exactly once in the turn,
  and requires a matching verified direct-evidence row _(worker:
  `httpapi/turn_precise_memory.go:163-179, 922-973`)_.

- **Lifecycle tables** (005): `memory_derivation_dependencies` is a parent→child edge
  table per source revision. `memory_reprocessing_jobs` and `memory_vector_outbox` are
  leased queues with states `pending`, `leased`, `retryable`, `permanent`, `completed`,
  `stale_rejected` and `needs_embedding`.
- **Other projections**: `kg_triples` with `valid_from`/`valid_to` (`001:90-104`),
  `character_events`, `world_rules` by scope/category/key (`001:345-363`),
  `pending_threads` with `thread_key` and status (`001:401-422`), `storylines`,
  `trust_states`, `active_states`, `canonical_state_layers`, and the support-only
  `consequence_records`, `psychology_branches` and `theme_offscreen_carries`
  (`001:691-814`). Most user-facing tables carry the manual-trust flags `pinned`, `suppressed` and
  `user_corrected`.

- **Summary hierarchy:** `episode_summaries`, `chapter_summaries`, `arc_summaries` and
  `saga_digests` (`001:459-605`). `arc_summaries` and `saga_digests` are defined twice in
  `001`. See §8 for which of these are actually produced.

### 2.3 Entities and identity

The legacy `entities` table is name-keyed (`001:255-274`). The 3.6 identity layer adds:

- `entity_identities` (`migrations/003_entity_identity_v1.sql:4-32`) gives each entity a
  `stable_entity_id`, `canonical_label`, `review_state` (default `needs_review`),
  `presence_authority` and source pointers. The table comment reads "display labels are
  not merge keys".
- `entity_identity_surfaces` (`:35-61`) are "Source-linked names and aliases; lookup
  candidates only, never automatic identity merges".
- `entity_identity_links` (`:63-79`) are "Reviewed split, merge, alias, and
  cross-namespace links; no implicit promotion".
- `speaker_attributions` (`:102-131`) are grounded speaker spans: "ambiguous speakers
  remain needs_review".

### 2.4 Character state with field provenance

`character_states` (`001:380-397`) has these JSON columns: `appearance`, `personality`,
`status`, `relationships`, `speech_style`, and `field_provenance_json` from migration 014.
The migration comment says: "Observation, occurrence, effectiveness and learning time are
separate JSON metadata dimensions; no backfill assigns the snapshot turn to old fields".

`SaveCharacterState` reads the latest snapshot, fills empty top-level columns from it,
re-applies stored manual edits, recomputes provenance, and **inserts a new row**, so each
save adds a snapshot (`store/mariadb_runtime_state.go:63-150`).

### 2.5 Subjective memory, persona capsules, reference material

- `protagonist_entity_memories` (`001:188-215`) is the "Subjective entity memory bank".
  It has `owner_entity_role` (`protagonist`/`npc`), `owner_visibility`, `secret_guard`
  and `target_reveal_policy`.
- `persona_memory_capsules`, `persona_memory_entries` and `persona_capsule_attachments`
  carry protagonist recollections into other sessions, support-only, after explicit
  attachment (`001:144-237`).
- Canon packs and the reference library are original-work material: works, documents,
  timeline nodes, entities, claims, claim knowers, and per-session bindings
  (`001:984-1240`, `migrations/002_canon_pack_storage.sql`). This material is kept apart
  from chat memory.
- The lorebook reference tables (`migrations/010_lorebook_reference_entries.sql:1-86`)
  keep read-only snapshots of the host lorebook: "Host lore remains separate from
  canonical memories ... only an explicitly complete observed snapshot may replace the
  current entry projection".
- `session_fork_lineage` (`001:752-779`, with additions in 011 and 012) has
  `parent_scope_id`, `copied_from_session_id`, `fork_turn`, `fork_source_message_id`,
  `fork_source_role` and `inheritance_mode` (default `conservative_import`). Its comment
  reads "Support-only: copied/forked session lineage ... not canonical truth writers".

## 3. Write path

**Save confirmation point** (`저장 확정 시점`, `pretty:1391-1393`). The setting
`turnFinalizationMode` defaults to `immediate_after_response` (`pretty:221`).

- **현재 턴 (current turn).** The Critic and the save run right after the response.
- **이전 턴 (previous turn, `next_user_input`).** The just-finished turn is confirmed only
  when the next user input arrives. JS keeps a per-session marker and calls
  `/complete-turn` for the previous pair from the next `beforeRequest`. A reroll or edit
  of the same input group does not trigger it (`pretty:11332-11481`, reason
  `previous_turn_critic_pipelined`).

Go describes the policy as `confirmed_memory_horizon: through_previous_confirmed_turn`,
`previous_turn_critic: pipeline_with_current_generation` and
`current_generation_blocked: false` (`httpapi/prepare_turn_priority_memory.go:35-45`).

The README says this mode shows two progress cards, "current response generation" and
"previous-turn critic/save" (`README.md:7-9`, labels at `pretty:1611-1612`).
_Inference:_ the point of this mode is to avoid spending a Critic call on responses the
user rerolls.

**Request flow inside `/complete-turn`** (`httpapi/group_turn_complete.go:118-1260`):

1. Idempotency wrapper keyed by a client idempotency key and a request fingerprint
   (`:129-164`).
2. Source acceptance (§2.1). A rejection invalidates the HUD workflow and returns early
   (`:151-157`).
3. Raw persistence of the user/assistant pair. An OOC turn guard skips all writes
   (`:560-598`).
4. **Critic LLM call**, synchronous in the request (`:736-778`). Its reasons are
   recorded as HUD stage outcomes, for example `critic_skipped: raw_chat_logs_not_durable`
   and `assistant_content_missing`.
5. Derived persistence, embeddings and the vector outbox.
6. Episode checkpoint and hierarchy checkpoint (`:1198-1215`).

**Critic contract.** The system prompt is `prompts/critic_system.txt`, which users can
edit through a prompt API (`AC_PROMPT_DIR`, `.env.example`). It opens:

> You are the "Critic," Archive Center's background roleplay memory extractor. Extract
> durable Archive Center memory data from the latest completed turn as one strict JSON
> object. ... Never drop grounded records to shorten output; merge only true duplicates.
> (`prompts/critic_system.txt:2-4`)

Key rules:

- `<Latest_Turn>` is the only authority for new events (`:7`).
- Evidence excerpts must be "one uninterrupted contiguous span of the original
  latest-turn text ... Never insert ellipses" (`:15`).
- History is separated from current state and from belief: "`narrative_events` are what
  happened; `state_claims` are evidence-bound current facts; `belief_updates` are a named
  perspective owner's knowledge" (`:106`).
- Promises and goals carry a stable `lifecycle_key` with transitions
  `create|progress|partial|complete|cancel|modify|pause|resume`. The key must be copied
  "byte-for-byte" from the ledger (`:109-113`).
- Secrets are split by knowledge scope (`:160-162`).
- `prune_targets` "never authorizes deletion" (`:173`).

The prompt offers about 30 output surfaces (`:39-45`), and the world-rule audit is always
on (`:101-103`). The prompt is 179 lines and about 35 KB.

The user message (`httpapi/turn_extraction_critic.go:2160-2207`) holds session, turn and
`input_mode` lines, a `<Memory_Generation_Language>` block,
`<Latest_Turn>[User]…[Assistant]…</Latest_Turn>`, `<Recent_Context_JSON>` (previous
canonical turn plus relevant memory), `<Critic_Archive_Ledger_JSON>` (a bounded ledger
with lanes `direct_evidence`, `recent_accepted_memory`, `active_state_snapshot`,
`unresolved_pending_thread`, `recent_resolution_event`;
`httpapi/group_critic_ledger.go:26`) and `<Language_Context_JSON>`.

**Model calls, defaults and parsing.**

| Item             | Value                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls per turn   | 1 Critic call (`httpapi/turn_extraction_critic.go:682-698`)                                                                                    |
| Message shape    | system + user, `JSONResponse: true`                                                                                                            |
| Temperature      | 0.2 (`httpapi/turn_extraction.go:604`)                                                                                                         |
| `max_tokens`     | 30000 (`:605-606`)                                                                                                                             |
| Model slot       | the plugin's "sub LLM" slot, synced as `critic*` runtime keys (`pretty:16880-16897`)                                                           |
| World-rule audit | separate LLM call `runCompleteTurnWorldRuleAudit` (`:918`), called only from admin backfill (`httpapi/group_admin_world_rule_backfill.go:229`) |

Output handling (`:726-779`) runs `parseJSONFromLLMContent` with structural repair
(failures: `CRITIC_JSON_MISSING`, `CRITIC_JSON_TRUNCATED`, `CRITIC_JSON_PARSE_FAILED`),
then `validateCriticExtractionSchema` (bad fields quarantined, hard failure
`CRITIC_SCHEMA_INVALID`), `quarantineCriticProtectedCandidates` and
`admitCriticInteractionLanesWithTrustedIdentities`.

**What one confirmed turn produces.** In MariaDB authority mode, the admission
transaction does the following _(worker: `store/mariadb_memory_admission.go:116-264`,
`httpapi/turn_memory_admission.go:141-235`)_: it upserts one aggregate `memories` row,
reconciles current-turn `direct_evidence_records` (omitted evidence is tombstoned and
queued for vector delete), writes `precise_memory_units`, enqueues vector work, and flips
the source revision `pending → committed`. The turn may also produce KG triples, a
`character_states` snapshot per changed character, pending-thread and lifecycle
projections, deduplicated world rules, and entity identities, surfaces and speaker
attributions.

The HUD counts reflect this fan-out: `turn_summary`, `precise_memory`,
`direct_evidence`, `knowledge_graph`, `relationship_state`, `entity_identity`,
`identity_surface`, `identity_binding`, `speaker_attribution`, `subjective_memory`,
`world_rule`, `character_state`, `narrative_state`, `episode_summary` and
`vector_index` (`httpapi/turn_workflow_hud.go:85-105`).

Embedding: the public memory projection is embedded synchronously in the request
(`httpapi/turn_extraction_persist.go:160-186`). Evidence and precise-unit vectors go
through `memory_vector_outbox`, which a background worker processes.

**Preprocessing specialists** run on the read path and are covered in §4. The write path
has no specialists.

**Failure handling.**

- A Critic failure leaves the raw chat logs durable, writes a `critic_extract_failed`
  audit and enqueues a durable `memory_reprocessing_jobs` row. `CRITIC_SCHEMA_INVALID`
  starts as `permanent` _(worker: `httpapi/group_turn_complete.go:1044-1076`,
  `httpapi/complete_turn_source_revision.go:163-188`)_.
- The worker (`httpapi/memory_reprocessing_worker.go:17-26, 760-779`) retries after
  `criticReprocessingIntervalSec` (default 30 s, or longer if the provider sent
  `retry_after`). It processes 4 jobs per wake and replays the stored Critic input
  snapshot. A source that is no longer active becomes `stale_rejected` (`:750-757`).
- An embedding failure keeps the rows and records `embedding_call_failed`
  (`httpapi/turn_extraction_persist.go:174-178`). In the outbox path the job becomes
  `needs_embedding`.
- The JS side keeps its own durable failed queue: 50 entries, 7 days, 4 attempts
  (`pretty:314-316`).

**Reroll, edit, delete and fork** are covered in §7.

## 4. Read/injection path

**Scene characterization.** The vector query set (`httpapi/prepare_turn_recall.go:62-135`)
is the first available of `continuity_query`, the raw user input or the latest
non-assistant message, plus up to `recent_conversation_reference_count` completed
exchanges (default 5, `pretty:220`), each its own query (`user:\n…\nassistant:\n…`).
Each query is embedded. The history embeddings are skipped if the primary embedding
fails (`:290-345`), so one turn costs up to six embedding calls.

Scene membership comes from the latest current `active_states` or `canonical_state`
scene row, which gives `present_entities` and `present_characters`. Entity scope has
three tiers: **Direct** (known names in the current input), **Scene** (confirmed scene
entities) and **Known** (all names and aliases) _(worker:
`httpapi/prepare_turn_recollection.go:575-663, 942-1106`)_.

**Candidate selection.**

1. **Vector recall.** Chroma is a support-only selector. Hits are hydrated from MariaDB
   by id, filtered to the public projection, and admitted at cosine ≥ 0.30 _(worker:
   `prepare_turn_recall.go:2735-2881`)_. Evidence and world-rule hits are hydrated, and
   tombstoned or superseded evidence is rejected. Private NPC precise units never enter
   the general vector lane _(worker: `store/mariadb_precise_memory.go:446-461`)_.
2. **Lexical admission over all stored memories** (no BM25): distinctive-term overlap,
   adjacent phrase pairs and inflection forms. Direct-entity matching is enforced for
   candidates outside the current scene _(worker)_.
3. **Priority score** (`httpapi/prepare_turn_priority_memory.go:1721-1723`):
   `relevance*0.60 + importance*0.25 + recency*0.15 + continuity_bonus + structured_bias`.
   - Recency decays with a 32-turn half-life and a floor of 0.20 (`:24-25, 1500-1507`).
   - Structured bias adds speaker +0.04, location +0.05 and storyline +0.06, capped at
     +0.12 (`:1525-1544`).
   - Continuity adds +0.04 for character/world lanes, +0.03 for unresolved goals and
     +0.04 for canonical-state rows (`:1577-1588`).
4. **Pinned material.** Pinned world rules and pinned open threads bypass the relevance
   test _(worker: `prepare_turn_assembly.go:620-715, 944-985`)_.

**Budgets.** All budgets are counted in characters, not tokens.

| Setting                      | Default                   | Source           |
| ---------------------------- | ------------------------- | ---------------- |
| `maxInjectionChars`          | 32000                     | `pretty:226`     |
| `injectionBudgetExtraChars`  | 4000                      | `pretty:230`     |
| `protectedSecretBudgetChars` | 4000                      | `pretty:231`     |
| `referenceInjectionMaxChars` | 3000 (original work)      | `pretty:227`     |
| `lorebookReferenceMaxChars`  | 3000                      | `pretty:228`     |
| `narrativeSupportMaxChars`   | 3000 (Publisher guidance) | `pretty:322`     |
| `memoryDeliveryBudgets`      | per-lane, see below       | `pretty:234-241` |

The per-lane auto split weighs `direct_evidence` 3500, `event_recent` 3500,
`character_objective` 2500, `subjective_relationship` 3000, `world_state` 2500 and
`unresolved_goal` 1800 over an 18,000 denominator
(`httpapi/prepare_turn_priority_memory.go:1898-1937`). Every populated lane gets a core
round first, then overflow is ordered by score. In auto mode, unused space can be lent
between lanes. The protected-secret and body-tracking lanes are independent _(worker:
`:2385-2430`)_.

When the host reports token counts, Go converts the remaining context tokens back into a
character cap _(worker: `httpapi/prepare_turn_governor.go:10-61`)_.

`source_ref` formats are `<source_table>:<row_id>`, or `<source_table>:line:<sha256-prefix>`
without an id (`:1704-1710`); character memory uses `character-memory:<sha256>` and
lorebook entries `host_entry:<id>` or `scope:<id>/ordinal:<n>` _(worker)_.

**Injected payload shape.** Go returns `payload_application_plan.v1` with
`apply_rule: "apply_exact_text_without_reassembly"` (`httpapi/prepare_turn_render.go:187-221`).
Its lanes, in order, are `original_work`, `long_term_memory`, optional
`preprocessing_notes`, optional `lorebook_reference` and `output_guidance`
(`:151-174, 224-276`).

Inside long-term memory, sections are titled `[Latest Direct Evidence]`,
`[Protected Memory Guidance]`, `[Event and Recent Memories]`,
`[Character Objective States]`, `[Subjective Memories and Relationships]`,
`[Item, Location, and World States]`, `[Unresolved Goals]` and optionally
`[Body State Context]` (`httpapi/prepare_turn_memory_budget.go:15-34`). Lines look like
`- [source turn N] …`, and state snapshots are marked `[state snapshot turn N; fields may
be older]` _(worker: `:2777-2818`)_.

Recent chat is deliberately **not** duplicated: "RisuAI already carries recent chat in
the completed main-model payload" (`:177-180`).

JS inserts exactly one message (`pretty:51557-51637`):

```js
{ role: "system", content: "[Archive Center — Auxiliary Context]\n\n" + auxiliary_text }
```

If an identical block already exists, it is reused or de-duplicated. A conflicting block
causes a refusal.

Placement is set by `auxiliaryInjectionPlacement`, default `"auto"` (`pretty:223`). Auto
inserts after a configured anchor marker if there is one, otherwise before the latest
user message, otherwise after the first system message (`pretty:51470-51541`). The
explicit modes are `end`, `after_first_system`, `before_latest_user` and
`after_last_cache_point`.

JS then hash-checks that the block landed (`pretty:51854-51960`), with statuses
`applied`, `ambiguous` or `missing`. The experimental PDF modes render the same memory
text into a PDF for Gemini or provider-manager transports (`pretty:2025-2032`, Go
`internal/pdfmemory`).

**Publisher (supervisor) layer.** `prompts/supervisor_system.txt` casts the model as "Book
Author and Director for the main roleplay model" (`:2-3`), states "The user decides the
story's direction" (`:5`), and requires the contract `publisher_output.v3`
(`:52-64`):

```json
{
  "contract_version": "publisher_output.v3",
  "items": [
    {
      "role": "book_author|director",
      "field": "...",
      "text": "...",
      "source_refs": ["..."]
    }
  ]
}
```

Book Author fields are `current_arc`, `narrative_goal` and `next_beats`. The Director
field is `pressure_level`, with `quiet|low|medium|high` (`:66-70`).

Its input packet holds only delivered material: `current_input`,
`accepted_recent_context`, `delivered_memory`, `delivered_character_memory`,
`delivered_context`, `delivered_lorebook_reference` and optional
`delivered_preprocessing_notes` (`:11-17, 19-26`).

Guide strengths (`:28-39`) run from `weak` (brief optional hints) through `medium`
(connected recommendations), `strong` (execution priorities) and `extreme` (action,
reaction and consequence) to `maximum` (an execution brief with opening, development and
landing); `none` disables the Publisher. Go renders the result under `[Publisher
Guidance]` or `[Book Author]`/`[Director]` in a compact, standard or explicit format
(`httpapi/prepare_turn_render.go:752-786`).

Plugin defaults are `narrativeGuideMode: "auto"` and `narrativeGuideStrength: "weak"`
(`pretty:319-320`). Go resolves `auto` to `standard`, not to a genre guess
(`httpapi/prepare_turn_planner.go:634-643`). So the Publisher runs once per turn,
**blocking before the main request**, as soon as the "plugin main" slot is configured.
That slot is synced to the `supervisor*` keys (`pretty:16899-16926`).

**The Publisher is separable from memory.** Memory assembly finishes before the
Publisher runs, and a skipped Publisher only drops the guidance lane _(worker:
`group_turn_prepare.go:1098-1157, 1613-1725`)_.

**Preprocessing specialists** (optional, off by default: `multiAgentSettings.Enabled` is
false, `httpapi/prepare_turn_multi_agent.go:194-199`). There are five editor roles
(`:30-35`): `event_recent` (사건·진행 이력), `character_objective` (인물의 객관적 상태),
`subjective_relationship` (개인 경험·관계·비밀), `world_state` (세계·장소·물건) and `unresolved_goal`
(미해결 목표·복선). The shared prompt says to work "BEFORE the main roleplay response" and to
"deliver a scene-specific selection, not an inventory" (`:37-40`). Per-role defaults are
temperature 0.2, 2048 max tokens and a 120 s timeout (`:197`). Each role selects refs
and writes attributed notes. There is an optional second round per role for a search or
hand-off. Roles that share a connection are batched into one provider call _(worker)_. A
separate optional "Jev" external selector (`httpapi/prepare_turn_jev.go:19-39`) is off
by default.

**Hidden extra calls** _(inference from code paths)_. The legacy JS orchestration helper
runs on every turn (`pretty:54376`). Its "plugin main shadow" input-improvement call runs
whenever `pluginMainApplyMode` is not `off` (default `"shadow"`, `pretty:327`) and the
plugin-main slot is configured (`pretty:42838, 48653-48670`). When the Critic slot is
also configured, a "sub LLM second pass" review follows (`pretty:48885-48893`, function
at `pretty:42613`).

In shadow mode their output is only traced, not applied (`pretty:42818-42858`).
_Inference:_ a user who configures both slots pays two extra **blocking** LLM calls per
turn for traces.

**Prompt-cache considerations.** Go does not state a provider prompt-cache stability
guarantee _(worker)_. The default placement (just before the latest user message) and
the `after_last_cache_point` option keep the long prefix stable, and each LLM slot has a
`claudePromptCacheMode` setting (`pretty:196-200, 262`). _Inference:_ the auxiliary block
changes every turn, so anything after it is uncached. The 32,000-character default
budget makes that block large.

## 5. Verification and inspection UX

**Per-turn HUD.** This is the strongest answer to P1. Go keeps a per-request workflow
with 12 fixed stages (`httpapi/turn_workflow_hud.go:44-77`):

```text
prepare_source → recall_materialization → context_assembly → publisher_llm →
payload_ready → awaiting_final_output → final_output_accepted → raw_persist →
critic_llm → derived_persist_and_index → summary_checkpoints → complete
```

Korean labels include 기억·근거 불러오기, 평론가 호출 and 요약·근거·관계 저장 및 색인
(`pretty:1676, 1735-1745`).

Each stage carries status, start and end time, duration, `reason_code` and an
`llm_call` flag (`:119-130`). Nine "facts" each name an owner (`risu_host`, `go_backend`,
`canonical_store` or `vector_store`) and a status, such as `payload_delivery`,
`raw_persistence`, `derived_memory` and `vector_index` (`:107-117`). Per-category save
counts are listed in §3.

The plugin streams this over `/turn-workflow/events` and renders cards with
human-readable reasons (`pretty:1609-1671`), such as 평론가 설정 없음 ("critic config
missing"), 원문 저장 미확정 ("raw save not durable"), 이미 처리된 턴 ("duplicate turn replay") and 호출
실패 후 본문 계속 ("publisher failed open"). In previous-turn mode there are two cards: 현재 턴 생성
and 직전 턴 평론가·저장.

**Per-turn inspection** in the "Review" (편집 확인) and "Status" tabs
(`pretty:348-363`) show the effective input, every applied payload lane and its text,
the memory-delivery classes, candidate → selected → final → excluded character counts
per lane, preprocessing notes, and provider budget ledgers with provider-reported tokens
(unreported tokens are not estimated) _(worker; spot-checked at `pretty:714-722,
34204-34221, 37030`)_.

**Memory explorer** (기억 tab) pages chat logs, memories, direct evidence, KG,
hierarchy, entities and lorebook. Memories and KG can be edited, deleted and regenerated
per turn (`/explorer/memories/regenerate`); direct evidence can be reviewed,
revalidated and edited; a Trust tab gives storylines, world rules and hooks independent
📌 pinned, 🚫 suppressed and ✎ user_corrected toggles; characters can be merged and
unmerged _(worker; endpoints verified in the plugin endpoint list)_.

Manual trust survives reroll and replay. It is captured and restored around replacement
and rollback (`httpapi/narrative_state_contract.go:1143-1215`,
`httpapi/complete_turn_logical_replacement.go:60`), and an e2e smoke checks it
(`ops/manual-trust-ui-e2e.cjs`). Manual character edits are re-applied on every later
save (`store/mariadb_runtime_state.go:73-96`).

Other tabs: 세계선 (worldlines), 원작 DB (original work), 로어북 (lorebook), 프롬프트
(editable prompts) and 고급 (advanced/debug, with a Critic-ledger probe, session compare
and audit trail). Diagnostics export is redacted (`/diagnostics/report`).

**What is missing or weak.**

- The UI does not show the Critic's actual output per turn. `extractCriticSummary` keeps
  only memory/KG attempted/saved booleans and a status (`pretty:34204-34221`). A code
  comment says "critic는 backend background task — critic_result는 async이므로 null"
  (`pretty:56998-56999`). Debug mode keeps a 400-character preview _(worker)_. A user
  sees how many things were saved, not what the model claimed and which excerpt backs it,
  unless they open the explorer and search by turn.
- The final provider payload is out of view. The Effective Input section says "이후
  플러그인 처리와 최종 제공자 요청은 이 화면의 관측 범위 밖입니다" ("later plugin
  processing and the final provider request are outside this view") (`pretty:714-717`).
- Protected-secret text shows as counts only (`counts_only_no_secret_text`,
  `pretty:37030`).
- There is no "memory health over the whole chat" view, such as coverage per turn range
  or a list of turns whose Critic failed. _Inference_ from the tab list; the failed queue
  and audit log exist but are debug surfaces.
- The surface is very large: 13 settings tabs and 3,978 i18n entries across Korean,
  English and Japanese (about 1,300 per language).
  _Inference:_ discoverability is a problem in its own right.

## 6. Multi-character handling

- **Identity.** A stable id is reused only on an exact canonical label in the same
  namespace and kind, backed by an independent source span. Similar names never merge.
  The one automatic link is the Critic supplying an exact `identity_evidence_excerpt`
  that ties an alias to a unique prior canonical surface _(worker:
  `httpapi/turn_entity_identity.go:226-379, 504-600`)_. The prompt backs this up:
  "spelling or similarity never proves sameness ... People sharing a given name stay
  distinct" (`prompts/critic_system.txt:80, 85`). Operator merges are links, not
  rewrites, and can be undone _(worker: `httpapi/group_characters.go:121-251`)_.
- **Per-character state.** `character_states` snapshots per name, with field provenance
  (§2.4); stable ids are overlaid at read time _(worker)_. Objective state is delivered
  only for **scene** entities; with no confirmed scene, objective delivery is marked
  unobserved _(worker: `httpapi/prepare_turn_assembly.go:255-296`)_. Characters outside
  the scene contribute only through relevant relationships. _Inference:_ this is the
  main mechanism that keeps a 30-character world bot from flooding the prompt, and it
  depends on the Critic recording `scene_state` presence each turn.
- **Knowledge scoping.**
  - `belief_updates`, `protected_secrets` (`known_by`, `suspected_by`, `unknown_to`,
    `misinformed_by`, `revealed_to`) and `subjective_entity_memories` become
    holder-scoped precise units with `knowledge_holder_entity_id` and `visibility`
    _(worker: `httpapi/turn_precise_memory.go:382-700`)_.
  - The perspective lane requires the current POV to equal the holder _(worker:
    `character_perspective.go:54-246`)_.
  - NPC-private memories of in-scene owners are **intentionally delivered** to the model
    as `[Character Private Recollection]`, with the instruction text "NPC private memory
    is the owning NPC's interpretation/bias, not player knowledge ... Use only as subtext"
    (`httpapi/prepare_turn_recollection.go:130-149`).
  - The preprocessing prompt carries an explicit scope-reading rule: absence of viewers
    "is not evidence that nobody or everybody knows"
    (`httpapi/prepare_turn_multi_agent.go:28`).
- **Group chats.** There is no group-chat model. The plugin has no `groupChat`
  references. A session is one character index plus one chat
  (`pretty:13642-13690`), so a RisuAI group chat would arrive as one message stream
  _(worker; inference)_. Multi-character support lives entirely in the extracted
  entities, not in host roles.
- **Cross-session.** Persona capsules carry protagonist recollections into other
  sessions after explicit approval and attachment. Critic `persona_capsule_candidates`
  queue as pending: "Automatic capsule creation is disabled"
  (`prompts/critic_system.txt:169-170`).

## 7. Consistency under edits

**Reroll or edit of the latest response.** A new observation with the same
`logical_turn_id` but a different `source_revision` replaces the old one: "Revision
identity, not only text inequality, owns supersession"
(`httpapi/complete_turn_source_acceptance.go:787-819`). "ReplaceLogicalTurn is
intentionally limited to the canonical tail"; otherwise it fails with
`logical_turn_not_current_tail` (`store/mariadb_logical_turn_replace.go:65-122`). The
replacement transaction marks the old revision `superseded`, invalidates its
dependencies, precise units, jobs and outbox upserts, queues vector deletes, and inserts
the new pair _(worker: `:123-169`, `store/mariadb_memory_derivation.go:501-619`)_.
Manual trust is captured and restored around it.

**Older edits.** No generic "edit turn N → invalidate N and later" path exists _(worker,
consistent with the tail-only rule above)_. An older edit becomes a conflict, a new
logical turn, or needs an explicit rollback or rescan.

**Deletions.** The host history must be an exact prefix of the stored source history,
and only a contiguous missing suffix is accepted; a change in the middle is a conflict
_(worker: `httpapi/group_turn_range_decision.go:184-204, 370-437`)_. The rollback route
then invalidates revisions and physically removes tail rows (`rollbackAutoEnabled: true`,
`pretty:309`). Ambiguous gaps, possibly from history compression, block automatic
rollback (`pretty:28421`).

**Branches (worldlines).** An official RisuAI branch, confirmed through the output
listener and route checks, writes a `session_fork_lineage` row. A `char`-role fork
inherits through `fork_turn` and a `user`-role fork through `fork_turn-1`; automatic
worldline rows use `inheritance_mode: none` _(worker:
`httpapi/group_step23_fork_lineage.go:779-790`, `group_turn_range_decision.go:1556-1573`)_.
Vector recall searches the current session **plus its worldline history sessions**
_(worker: `prepare_turn_recall.go:356-442`)_.

**Chat copies and moves** use a separate saga (`/sessions/migrate-preview|complete|
lock-source|reindex|rollback`). Its modes are `copy_then_lock_source` and
`copy_keep_source`, with row maps and vector-parity checks before the source is locked
(`001:608-690`, `httpapi/group_session_migration.go`).

**Retraction is weak.** `state_claims` accept `correction`, `supersede`, `clear`,
`cancel` and similar transitions, but not `retract`; unknown values become `""` and then
default to `set` (`httpapi/narrative_state_contract.go:199-207, 76-78`). `prune_targets`
are only audit hints. Direct evidence has manual tombstone and supersede actions
_(worker: `group_memory_explorer_write.go:548-617`)_.

**Known host limits.** `afterRequest` exposes no message, generation or branch id; AC
marks these `not_exposed_by_risu_afterRequest` (`pretty:31031-31098`) and infers them
from pre-request anchors and hashes. _Inference:_ much of AC's complexity
(source-acceptance contracts v1–v3, routing baselines, hash-matching rollback) exists to
rebuild message identity that the host does not provide.

## 8. Costs and limits

**LLM calls per turn on the default path, with both slots configured** _(inference from
the cited gates)_:

| When                              | Call                                                                                           | Blocking?                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Before the main request           | up to 6 query embeddings                                                                       | yes                                           |
| Before the main request           | 1 Publisher call (default guide `auto`/`weak`); `llmRetryCount` 3 retries in the UI _(worker)_ | yes                                           |
| Before the main request           | plugin-main shadow call and sub-LLM second pass, if configured                                 | yes                                           |
| Before the main request, optional | specialists: 5 roles × up to 2 rounds, grouped by connection                                   | yes                                           |
| After the response                | 1 Critic call (temperature 0.2, up to 30k output tokens) plus 1 synchronous memory embedding   | blocks `/complete-turn`, not response display |
| Background                        | outbox embeddings for evidence and precise units                                               | no                                            |

**Tokens.** The Critic input is the 35 KB system prompt plus the latest turn, the
previous turn, relevant memories and the ledger. _Inference:_ that is roughly 10–20k
input tokens per turn before the turn text. No measured figures exist in the repo. The
injected block can reach 32,000 + 4,000 + 3,000 + 3,000 + 3,000 characters of auxiliary
context.

**Summary hierarchy.**

- Episode summaries are generated every 5 turns (`episodeIntervalTurns: 5`,
  `pretty:303`). They are **deterministic, with no LLM**:
  `"generation_source": "deterministic_ds1a_fallback"`. They are built from memory and
  evidence lines and raw lines truncated to 220–260 runes, have no embedding, and the
  summary is capped at 700 runes (`httpapi/group_narrative_hierarchy.go:186-241`;
  checkpoint at `httpapi/group_turn_complete.go:1609-1656`).
- Chapter, arc and saga promotion needs `long_session_refresh_enabled`
  (`:1658-1678`). It is off on the default complete path. When enabled, it uses the Main
  model _(worker)_.
- _Inference:_ in 4.9.0, long-range memory comes from per-turn facts plus retrieval, not
  from LLM summaries.

**Storage growth** per turn: one `memories` row, N evidence rows, M precise units, one
`character_states` snapshot per touched character (an INSERT each time,
`store/mariadb_runtime_state.go:148`), KG rows, audit logs, a source revision holding
the full raw text a second time, and the Critic input snapshot JSON. Superseded
revisions are kept, not deleted.

**Limits and gaps.** There is no group-chat model, no retraction of state claims and no
generic older-edit invalidation, and branch identity is `not_exposed`.

- Session ids depend on the character index (`char_<idx>_cid_<id>`). _Inference:_ the
  session migration and normalization tooling, with 126 `sessionNormalize.*` i18n entries,
  exists to repair that.
- Episode summaries are text-truncation digests.
- Most UI strings exist in Korean, English and Japanese; many Go comments are
  Korean-first.

## 9. What metatron should adopt, adapt, or avoid

Metatron already owns a Node/Hono server, per-chat records with message identity, and
server-side generation jobs. It can therefore host memory in-process and keep AC's
policy without AC's process stack or its host-identity reconstruction.

### Adopt

1. **Per-turn memory workflow card with fixed stages and reason codes (P1).** AC's
   12-stage ledger, owner-attributed facts and per-category counts (§5) answer "is
   summarization working" turn by turn. Metatron's generation job could emit the same
   stage events.
2. **Verbatim, code-checked evidence for every stored fact (P1, P2).** The model must
   quote one contiguous span, and code checks it is a substring of the source message
   before admitting the fact. The UI can then show the quote next to the fact and link
   to the message.
3. **Source-revision fencing keyed to message id and content hash (P1).** Supersede on
   reroll, invalidate on delete, reject stale work in background jobs, and store the
   extractor input snapshot so retries replay exactly. Metatron has real message ids, so
   it can do this without AC's hash heuristics.
4. **The "previous turn" confirmation option.** Extract the prior turn when the user
   moves on, so rerolls do not spend extraction calls. Keep "current turn" as the
   default for short chats.
5. **Typed lanes with independent budgets and lending (P2).** Use direct evidence,
   events, objective character state, subjective/relationship, world/item/location and
   unresolved goals, each with its own cap and a core round first. This is better than
   one ranked list for many-character settings.
6. **Scene-gated character state (P2).** Deliver objective state only for characters in
   the confirmed scene or named in the input. Others appear only through relevant
   relationships.
7. **Identity rules (P2).** Use stable entity ids, keep aliases as source-linked
   surfaces, and never merge on name similarity. Operator merge and unmerge should be
   links that rewrite no rows.
8. **Lifecycle keys for promises and threads.** Use explicit transitions (create,
   progress, partial with remaining obligations, complete, cancel, pause, resume) and
   copy keys byte-for-byte from a ledger the extractor is shown.
9. **Manual trust flags that survive re-extraction.** `pinned`, `suppressed` and
   `user_corrected` should be re-applied after replay or reroll.
10. **Durable retry queue with leases.** A failed extraction keeps the raw text durable
    and retries in the background with a visible status.

### Adapt

1. **The Critic contract.** Keep the authority rules and the separation of history,
   current state and belief. Do not keep the 179-line, ~30-surface prompt with a 30k
   output budget. Start with events, state claims, threads, entities and beliefs/secrets,
   and measure cost before adding more.
2. **Knowledge scoping.** Holder-scoped facts plus a POV-gated perspective lane help
   world bots. Decide explicitly whether NPC-private memories reach the model as
   "subtext" the way AC does it, or stay hidden.
3. **Episode digests.** AC's deterministic 5-turn digest is cheap but crude. Metatron's
   HypaV3 summaries could become this layer, with per-turn facts and evidence underneath
   (P1: the summary can cite its turns).
4. **Lorebook as a separate reference lane** with its own budget, read-only snapshots and
   no mixing into canonical memory.
5. **Publisher and preprocessing.** These are cleanly separable and optional. Defer
   them. If they are added later, keep the "delivered material only, `source_refs`
   required" input contract.

### Avoid

1. **The deployment stack.** Go + MariaDB + ChromaDB + Python, 81 tables and a 3 MB
   plugin are far beyond what metatron's single server needs.
2. **Blocking extra calls whose output is discarded.** AC's default shadow input
   rewrite and second-pass review only feed traces.
3. **A 32,000-character default injection** in one system block. Budget in tokens
   against the model context instead.
4. **Session identity derived from list indexes.**
5. **Audit-only "prune" hints with no real retraction path.** Design correction and
   retraction as first-class transitions.
6. **A Critic summary UI that hides what was extracted.** Show the facts and their
   quotes, not only saved counts.

## Could not determine

- Real per-turn token cost and latency. The repo has budgets and ledgers but no recorded
  measurements.
- Quality outcomes: no evaluation corpus results are checked in.
  `testdata/core-regression-suite.json` only lists test regexes.
- How a RisuAI group chat behaves end to end.
- Whether the plugin-main shadow and second-pass calls actually fire on a live default
  install. The code gates say yes when both slots are configured, but this was not run.
- The exact default Critic-ledger item and character limits
  (`httpapi/group_critic_ledger.go:37-51` shows the knobs, not the defaults).
