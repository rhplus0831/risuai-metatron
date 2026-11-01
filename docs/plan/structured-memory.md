# Structured Memory Plan (initial design)

Status: design drafted 2026-11-01 from the owner's request, sliced the same day. Landed: 1a (e6f734303), 2a (19820d111), 1b (89cf98299), 1c (61e93aa7e), 1d (e979f105d), 2b (c627a7b05), 2c (30c6aad33), 2d (9d7bd42be), 2e (32f3113e4), 3a (fdbd31190), 3b (65c940e0d), 3c (40f1a6f26), 4a (e3c90eb7d). All nine open
questions were answered by the owner (see **Answered questions**). The persisted discriminator is `structuredMemory`;
"Structured memory" stays the settings label until the owner renames it.

Sources: the owner's request (2026-11-01: HypaV3 compresses well but the user cannot verify it on long chats and it is
weak for world-setting bots with many characters); the [memory guide](../structure/memory.md) at `43d7e4a07`; the
BardWiki sections of the [RisuBard survey](../research/risubard-survey.md) (§2.1–2.2), RisuBard's own long-chat
experiment (`docs/ko/memory-wiki-long-chat-experiment.md`) and its 2026-09-29 long-chat checkpoint note; and the three
reports under [docs/research/memory-systems/](../research/memory-systems/README.md) written for this design by Opus
sub-agents: [HypaPlus](../research/memory-systems/hypaplus.md),
[Archive Center](../research/memory-systems/archive-center.md), and
[Dusk Atelier](../research/memory-systems/dusk-atelier.md).

Owning guide: a new `docs/structure/structured-memory.md`, created by slice 1a, because
[memory](../structure/memory.md), [server-generation](../structure/server-generation.md),
[chat-pipeline](../structure/chat-pipeline.md), [persistence](../structure/persistence.md),
[server-resources](../structure/server-resources.md), [chat-store](../structure/chat-store.md), and
[ui-theming](../structure/ui-theming.md) have too little room left under the guide budget.

## Goal

A memory system a user can trust on a 1,000-turn chat with a cast of ten:

- **Verifiable.** After every send the user can see what memory went into the prompt and why, what the writer did with
  the last confirmed turn, which messages are covered, and where the last failure was. Nothing is silently dropped,
  trimmed, or resurrected.
- **Entity-aware.** Story state lives in pages per character, place, faction, item, and concept plus one scene page,
  with per-character knowledge and directed relationships, so a world bot's cast does not collapse into one
  chronological summary stream.
- **Evidence-preserving.** Every derived record names the messages it came from and their content hash; the original
  wording can be retrieved as evidence; deleting or editing a source retracts or flags what was derived from it.
- **Bounded.** The prompt's memory share is a cap spent in lanes the user can read, never a quota to fill; the writer's
  cost per turn is predictable and configurable.
- **At home in metatron.** Runs in the server job and the background memory task service, stores in the server's
  records with revisions, reports through the context report, and keeps the `supaMemory` gate, the memory card, and the
  plugin-visible `hypaV3Data` shape working.

Not goals: file-native Markdown storage or Obsidian round-tripping (export and import are enough); a second vector
database; replacing SupaMemory, HypaV2, or Hanurai (they stay selectable); a guidance or "director" layer that steers
the main model's creative choices (Archive Center's publisher); affection gauges rendered as HUD.

## Current state

### HypaV3 in metatron

- Data: `Chat.hypaV3Data` holds `summaries[]` (`{ text, chatMemos: string[], isImportant, categoryId?, tags? }`) and
  `metrics` (the indices of the last selection's important, recent, similar, random, and deferred summaries). A summary
  already records its source message ids (`chatMemos`), the one property every system below depends on.
- Write: the send's job summarizes the oldest uncovered window (`maxChatsPerSummary` messages, `summaryChunkSeparator`
  splits) with the `memory` model slot, saves each summary at its checkpoint under a writer lease, and hands the chat
  to the background memory task service when a lookahead plan says more is due. Source validation drops windows whose
  messages changed. Token and ratio budget modes go through `resolveHypaV3Budget`.
- Read: `selectHypaV3` fills the memory budget in the order important → recent → similar (embeddings over summary
  chunks) → random, keeps `queryChatCount` recent messages raw, and prepends one `<Past Events Summary>` card with
  `memo: "supaMemory"`. Uncovered history that does not fit is trimmed behind the protected tail (`coverage: "gap"`).
- Report: `ContextReport.memory` carries kind, tokens, budget, coverage, `summarized`, `prepared`, `reserved`,
  `summarizeIn`, `lookaheadIn`; the composer's `ContextMeter` reads it. It does not say which summaries were sent or
  why.
- UI: `HypaV3Modal` edits a synced copy of the chat's data (search, filters, categories, tags, bulk edit, resummarize,
  reset), shows the task status line, and marks each summary with the last selection's important/recent/similar badges.
  It shows no per-send manifest, no per-turn receipt, no coverage map, and no writer log.

### Why it fails the two complaints

- **Verification.** The only per-send evidence is three badges inside the modal and the meter's totals. A user cannot
  tell from the chat which summaries the last reply saw, whether a given message is covered, or that a background task
  skipped (`localSummarization`, `staleInput`) three sends ago. Summaries are free text with no title, no time hint,
  and no participants, so a 400-summary list cannot be scanned, and a summary's text is never checked against its
  sources after an edit (the window is only revalidated before a save).
- **Casts.** One summary per window mixes every character present; selection is by recency and similarity to the last
  `queryChatCount` messages. A character absent for 200 turns comes back with whatever similarity finds, with no page
  that says what she currently knows, wants, or holds. Nothing distinguishes what a character knows from what the
  reader knows, and the summarizer never sees the cast or the earlier summaries, so duplicates and contradictions
  accumulate.

### Seams the design builds on

- `assemblePrompt`'s memory step and `MemoryHost` (`server/src/prompt/memory/host.ts`): the job's tokenizer, `request`
  with the memory slot, embeddings, regex worker, progress, fence, signal. A new algorithm is a branch there plus its
  persistence (memory guide `Recipes`).
- The memory task service (`server/src/prompt/memory/memoryTasks.ts`): a queue with caps, per-chat writer leases,
  write fences on every tab, hand-off right before a job's `done`, manual start, terminal statuses the modal shows. The
  per-turn writer is a new task kind on this service, not a new service.
- The context report (`shared/contextReport.ts`) and `ContextMeter.svelte`: the per-send manifest extends
  `ContextReport.memory`; `MessageGenerationInfo` is where a per-message trace already lives.
- Chat storage: messages as rows by id with one revision per chat; per-field chat metadata through `setChatMeta`;
  checkpoints, copies, and exports carry chat fields. A page store with many small records should be its own tables
  beside the chat tables (same chat id, revision-checked writes), because whole-field writes to a chat blob are exactly
  the hazard the memory guide records for `hypaV3Data` (a plugin's whole-chat result replaces the job's summaries).
- Embeddings: `server/src/prompt/embeddings.ts` with `save/data/vectors.sqlite`; keys carry the model identity.
- Lore activation (`shared/lore/activation.ts`): name and alias matching over the last `scanDepth` messages is already
  the server's deterministic retrieval primitive; entity pages can reuse its matching rules and its budget pass.
- Plugins: V3 plugins read `hypaV3Data` through the chat; RisuBard answers them with a projection of the wiki context,
  and metatron should do the same rather than break them.

## What the other systems do

Full reports: [RisuBard survey §2.1–2.2](../research/risubard-survey.md#21-memory-bardwiki),
[hypaplus.md](../research/memory-systems/hypaplus.md), [archive-center.md](../research/memory-systems/archive-center.md),
[dusk-atelier.md](../research/memory-systems/dusk-atelier.md). This section keeps only what the decisions use.

### BardWiki (RisuBard)

- **Model.** Per chat, Markdown pages by type (characters, locations, factions, creatures, items, concepts, notes, one
  scene page) plus one event page per confirmed turn (`events/turn-<hash(sourceMessageIds)>.md`). The program writes
  the frontmatter (`id`, `type`, `status` active/superseded/retracted, `context` always/auto/never, `aliases`,
  `source_messages`, `links`, keywords, `storyTime`); the model never chooses ids, paths, or metadata.
- **Write.** A reply is evidence only once confirmed (the next generation succeeds, or the user confirms). Call 1
  (temperature 0, JSON schema): title, keywords, `establishedEvents`, `stateChanges{subject,before,after}`,
  `characterKnowledge{character,fact,stance: knows|believes}`, `persistentFacts`, `openContinuity`,
  `canonicalUpdateCandidates{type,title,aliases,action,targetDocumentId,confidence}`. Call 2 rewrites only the `###`
  sections of the targets as `upsert|delete` patches; untouched sections keep their bytes; a patch that would empty a
  page is refused; candidates under 0.75 confidence are warned, not applied. At most 8 targets per turn. Writing blocks
  the next generation. Character pages are compacted when they pass 0.8 × the per-source budget.
- **Read.** Required pages (`always` + scene) go in a top system message and abort the send if unreadable; retrieved
  pages go into the description slot (or, with the cache-friendly option, just before the latest user message) as
  `- [source "<id>"] <content>` under continuity rules. Retrieval is IDF lexical (title, alias, links, keywords; lore
  names score 10,000) plus up to two `[[link]]` hops, fused with optional embeddings by reciprocal rank; an optional
  reranker runs only on near ties. Budgets: target 4,000 / events 3,000 / per source 2,000 / maximum 7,500 tokens, in
  lanes (up to 4 anchor pages; the events lane opens only when the query reads as past or causal); a "recent flow" of
  up to 8 event titles labelled "N turns ago"; original-message excerpts resolved from the selected events'
  `sourceMessageIds` first, lexical and semantic search second. A dynamic budget option grows the lanes with chat size.
- **Verification.** Every generated message stores a body-free context trace whose status is skipped, failed, empty,
  not-injected, partial, or injected, where "injected" is verified by finding each `[source "id"]` in the final
  prompt. The request log splits each message's tokens across tagged sources (an injection manifest). Each reply shows a
  turn receipt: source ids, event ids, page changes with `afterHash`, warnings. A wiki log tab joins requests and
  saves; an evidence report exports per chat.
- **Consistency.** Deleting a message retracts the events that cite it (after a confirmation); rerolls and swipes are
  never recorded; forks copy the wiki through a two-phase staging; a resumable "wiki reboot" rebuilds everything from
  the transcript.
- **Measured.** One 21-reply session on a flash model: the last request used 17,247 input tokens against an estimated
  67,950 for the full transcript (3.9×), but cumulative input over the session was 873,836 against about 894,532 for
  transcript-only (1.02×) because wiki writing itself consumed 322,812 input tokens (37% of the total). The author
  states the 80%/96% recall figures are targets and that no A/B against the full transcript was run.
- **Known failures.** Character "knowledge and secrets" sections grew from 0 to 19 items over 27 saves and never
  shrank, and relationship paragraphs merged scenes out of order (answered by compaction and by moving world facts to
  location and concept pages); the designed "unreviewed" save flow is never reached because automatic saves are stored
  as reviewed; the model calls run from the browser although the runner is server code.
- **Take.** The event-plus-pages shape, program-owned metadata, confirmation as the evidence boundary, section patches,
  the `knows|believes` split, lanes with a hard maximum, the recent-flow line, evidence from `sourceMessageIds`, the
  verified injection trace, and the turn receipt. Avoid: writing that blocks the next send, a per-turn write cost that
  rivals the transcript, pages that only grow, files as the store.

### HypaPlus-R 0.1.65 (plugin)

- **Model.** Chunks of 30 counted messages, each turned into Korean `<event>`/`<facts>` nodes (time, place, characters,
  content, up to 5 verbatim lines); facts' `characters` means "who learned it". Nodes carry a wall-clock `createdAt`;
  an undated fact gets the real current time, which the story-time decay then trusts. Nothing compacts nodes.
- **Write.** A background job that never blocks a send, started from the `input` and `process` hooks, runs when at
  least 40 messages are pending and never summarizes the newest message or anything after the message that was newest
  when it started. A `pending` chunk with source ids and a SHA-256 anchor per message is saved before the model call;
  output after the 300 s timeout is never committed; failures stay `failed` and are retried on the same sources. The
  summarizer receives only the bare message bodies joined by blank lines: no speaker labels, indices, cast, persona, or
  earlier nodes. Reply screening (refusal and format lists) can exclude or halt before a chunk is summarized.
- **Read.** Summarized messages are removed from the prompt by a CBS `{{#if chat_index >= N}}` wrapper whose boundary
  moves only when a chunk completes. The query is the last 5 messages; the default score is `1-(1-time)(1-sim)` over
  model-written story dates, the opt-in one similarity plus a small chunk-order recency bonus. Favorites go first, the
  rest fill a 10,000-token budget greedily, then everything is re-sorted by story time. The block goes into
  `[HypaPlus.memory]`/`[HypaPlus.cached]` placeholders in the preset, each span ending in an HMAC marker the main model
  sees (about 67 tokens per slot).
- **Verification.** Pending count and list; the nodes used in the last request with similarity, time, and total
  scores; per-node embedding failure reasons; a query preview; a three-view source viewer per chunk (original,
  summarizer input after rules, stored raw); a story-date calendar; log lines per turn (where memory went, tokens
  against budget, timings). An integrity audit compares each anchor with the live message and badges a chunk `stale` or
  `unverified` with a reason (content changed, missing, inserted, moved); a cleanup dialog offers delete, detach,
  re-summarize the remaining sources, or keep. Missing: any per-turn history, the final prompt text, a coverage or
  faithfulness check, duplicate or contradiction detection.
- **Consistency.** Copies and branches inherit only chunks whose every source message maps onto the new chat, so a
  branch never inherits memory from after its branch point. Stale chunks stay injected until the user acts.
- **Take.** Content anchors with an audit and repair choices, pending → done/failed states saved before the call, the
  per-request boundary that protects the message being answered, the source viewer, inheritance by message-id mapping,
  reply screening. Avoid: a summarizer blind to the cast and to existing memory, model-visible bookkeeping markers,
  wall-clock fallbacks in story time, unbounded nodes with a greedy fill, a hard-coded output language.

### Dusk Atelier 1.8.0 (plugin, "장기기억")

- **Model.** Per chat, a JSON folder: people (`name, aliases, pinned, ctx always|auto|never, digest, records[]`),
  scenes (summary ≤ 400 characters, ≤ 3 facts, place, when, `who[]`, `pov[]`), directed relationship shift logs
  (`a>b`), six 0–10 emotion gauges per directed pair, open threads with ids, expectation gaps, tombstones of deleted
  text, and the analysis cursor. Each record ("act", ≤ 80 characters) carries an anchor `{at, mid, h}` (message index,
  message id, FNV hash of the first 200 characters), retrieval keys, `know[]` for secrets, three model-scored axes
  (persistence, change, reach, 0–3 each) from which code computes a grade D–EX with per-reply caps, trust fields (fact
  or inference, confidence, lasting attribute with `was:` history, disputed `hold`), mention and use counters, and user
  locks. A separate RisuPot wiki (off by default) adds typed documents with section provenance, a people-profile layer,
  writer receipts, and 60 history snapshots.
- **Write.** Default `confirm: "next"`: a reply is analysed only when the user sends the next message, in the
  background, with a 4 s debounce and one run at a time; rerolls before that cost nothing. The model gets the cast (up
  to 30 known people with their last act and attributes), the previous scene, open threads with ids, the emotion state,
  up to 6 earlier messages, and the newest reply; it returns one JSON object that code validates, clamps, grades,
  deduplicates (character-bigram Jaccard ≥ 0.8 against the person's last 10 records, counting distinct source replies),
  and reconciles (change, conditional, history, contradiction by confidence). Threads close only by an id the model was
  given; a user lock forces `hold` and raises an alert. After 5 consecutive failures auto-recording pauses with a
  visible notice. A per-person digest compresses old low-grade records; a user-edited digest is never overwritten.
- **Read.** Before each request the folder is reconciled on a copy against the live chat (orphans of rerolled or
  deleted replies drop out without being deleted). Relevance gating: `always` and pinned people first, then people in
  the scene's `who`, named in the last two messages, or hit by a key or embedding; others are excluded as
  `not-relevant`; each person is included whole or not at all within 1,200 target / 2,500 cap tokens. Score =
  grade weight × `0.97^age` × strength × key boost × semantic boost. Sections: current scene, story so far, characters
  (digest plus top 5 key moments with `[inferred, uncertain]` and `(was: …)` tags), open threads, feelings,
  relationship shifts, "Knowledge limits (who knows what)", up to 2 verbatim source lines whose message hash still
  matches. One system message placed before the last user message by default.
- **Verification.** Home card with the last request's result or the reason nothing was injected (seven reason codes);
  a usage bar classing records as used, digested, unrelated, or budget (with a defect that labels every exclusion
  "budget"); an exact next-request preview built without side effects; an editor for lines of the injected block whose
  edits show "not applied" when the line changes; per-record badges (grade, fact or inference, confidence, disputed,
  ended, repetitions, source turn); field locks with one-step undo; a backfill panel. Missing: a persisted per-turn
  manifest, record-level reasons and scores, a per-message analysis status, a quality check of a digest against the
  records it replaced; a five-step turn strip was built and tested but never wired into a screen.
- **Consistency.** Orphaning at read time covers rerolls and deletions; emotion deltas from vanished replies are
  reverted; threads closed by a discarded analysis reopen. Edits past the first 200 characters are invisible (a fix
  exists only on an unreleased branch). RisuPot's writer is stronger: identity is message id plus a SHA-256 of the
  content, a vanished source rolls its history back atomically, a user edit in between stops with a manual conflict,
  and receipts make retries idempotent. A scope id stored inside the chat detects copied twins and forks the memory.
- **Measured.** One synthetic 60-turn run without model calls: injected block 336 → 358 tokens, 5/5 probes in both
  versions; the analysis system prompt grew 632 → 1,060 tokens. No real-chat measurements exist. A capture and
  exclusion rate tool over hand-labelled cases exists.
- **Take.** Confirm on next message, read-time reconciliation, per-person records with relevance gating and
  whole-or-nothing slots, `know[]` with "does not know" lines, model-scored axes with code-computed grades and caps,
  locks, tombstones, undo, the side-effect-free preview, the conflict classes with `was:` history, RisuPot's receipts
  and rollback. Avoid: blocking work inside the request (the 4 s embedding wait), identity by name only, one growing
  JSON blob, writing-style default prompts inside the extraction call, feedback loops where being injected delays
  forgetting, two memory systems on one chat.

### Archive Center 4.9.0 (plugin + Go backend)

- **Model.** A RisuAI plugin (`input`, `beforeRequest`, `afterRequest` hooks only) talking to a Go backend with
  MariaDB and ChromaDB: 81 tables, about 192k lines of Go, a 3 MB plugin. Canonical rows per turn (`chat_logs`,
  append-only; `memory_source_revisions` with content hashes, one active revision per logical turn, and the critic's
  input snapshot kept for exact replay), derived rows (`memories` aggregate per turn, `direct_evidence_records`,
  `precise_memory_units`: atomic facts tied to an exact source span with kind, five entity references, epistemics
  (`truth_scope`, `epistemic_mode`, `visibility`, `knowledge_holder_entity_id`), and admission, review, and lifecycle
  states), `entity_identities` with source-linked alias surfaces and reviewed links ("display labels are not merge
  keys"), `character_states` snapshots with per-field provenance, threads with lifecycle keys, a summary hierarchy, fork
  lineage, and read-only lorebook snapshots.
- **Write.** One Critic call per turn (temperature 0.2, up to 30k output tokens, a 35 KB system prompt with about 30
  output surfaces), after the response is shown. Default confirms the current turn right away; the "previous turn"
  option confirms the last reply only when the next input arrives so rerolls cost no call. Every stored fact must quote
  one contiguous span of the turn, and code verifies the quote is in the source before admitting it. A failed Critic
  keeps the raw text durable and a leased background job retries from the saved input. Promises and goals carry
  lifecycle keys with transitions (`create|progress|partial|complete|cancel|modify|pause|resume`) copied byte-for-byte
  from a ledger the model is shown. Manual trust flags (`pinned`, `suppressed`, `user_corrected`) are captured and
  re-applied around replacement and rollback.
- **Read.** Up to six query embeddings before the request (the input plus five recent exchanges), vector hits hydrated
  from MariaDB and admitted at cosine ≥ 0.30, lexical overlap over all memories, a priority score of relevance 0.60 +
  importance 0.25 + recency 0.15 (32-turn half-life) plus small structured bonuses; pinned rules and threads bypass
  relevance. Objective character state is delivered only for characters confirmed present in the scene or named in the
  input; NPC-private memories of in-scene owners are deliberately delivered as labelled "subtext". Typed lanes with
  their own budgets (direct evidence, recent events, character objective state, subjective and relationships, world and
  items, unresolved goals), a core round per lane first, then overflow by score with lending between lanes. Budgets
  are in characters (32,000 default plus side lanes); everything goes into one system message before the latest user
  message, hash-checked after insertion. An optional Publisher (guidance) call and specialist calls run before the
  request and block it.
- **Verification.** A per-turn workflow card with 12 fixed stages (prepare source → recall → assembly → publisher →
  payload ready → awaiting output → output accepted → raw persist → critic → derived persist and index → summary
  checkpoints → complete), each with status, timings, a reason code, and an owner; per-category save counts; a review
  tab with every applied lane's text and candidate → selected → final → excluded counts; a memory explorer with edit,
  delete, regenerate per turn, trust toggles, merge and unmerge. Missing: what the Critic actually extracted per turn
  (only saved counts, a 400-character debug preview), the final provider payload, any whole-chat health view.
- **Consistency.** Reroll or edit of the latest turn supersedes its revision and invalidates its derived rows, but only
  at the canonical tail; older edits have no automatic invalidation; deletions must be a contiguous suffix; branches
  write fork lineage and recall searches the worldline's ancestors; copies go through a migration saga. State claims
  have no `retract` transition (unknown values silently become `set`).
- **Measured.** Nothing; no cost or quality figures are checked in. By the report's reading, the Critic input is
  roughly 10–20k tokens per turn before the turn text, and once both model slots are configured two more blocking calls
  run per turn whose output is only logged.
- **Take.** Code-verified verbatim evidence spans, the stage ledger with reason codes and owners, the critic input
  snapshot for exact retries, lifecycle keys for threads, trust flags that survive re-extraction, lanes with a core
  round and lending, scene-gated state, identity that never merges on similarity. Avoid: the process stack, blocking
  pre-request calls, a 30-surface prompt with a 30k output budget, character budgets, a UI that shows counts instead of
  the extracted facts and their quotes, audit-only pruning without retraction.

### What they agree on

Every system that answers either complaint independently arrived at the same five properties, and HypaV3 has none of
them:

1. A record is written only for a **confirmed** reply, never the one being generated or rerolled (Archive Center
   offers this as its "previous turn" option; the other three make it the rule).
2. Every record carries **source message ids and a content hash**, checked again at read time.
3. The writer sees the **cast and the existing memory** (ids, aliases, last state) so it updates instead of
   duplicating; code, not the model, owns ids, metadata, grades, and caps.
4. Memory is **per entity**, included whole or not at all under a hard maximum, with knowledge scoped to who knows it.
5. The user gets **a per-send record of what was injected and why** and a per-turn record of what the writer did.

Where they differ, the design picks: BardWiki's pages-plus-events shape over Dusk's flat per-person acts (pages hold
places, factions, and items too), Dusk's background confirm-on-next over BardWiki's blocking write, HypaPlus's audit
badges and repair choices over silent orphaning, and the server's own tables over files or plugin storage.

## Design

### D1. Shape: events, pages, scene, and the chat as evidence

Per chat, three record kinds plus the chat itself:

- **Event**: one per confirmed assistant turn by default (per window of K turns in batch mode, Q3). Fields the writer
  returns: `title`, `summary` (bounded), `participants[]` (page ids), `storyTime` hint (free text plus an optional
  ordinal; never a wall clock), `keyLines[]` (≤ 5 verbatim lines with speaker), `stateChanges[]`
  (`{pageId, section, before, after}`), `knowledge[]` (`{pageId, fact, stance: knows|believes}`),
  `relationshipShifts[]` (`{from, to, direction, note}`), `openThreads` (`add[]`, `close[]` by id). Fields code owns:
  `id`, `sources[]` (`{messageId, hash, index}`), `status` (`active|retracted|stale`), `writerRun` id, created
  revision.
- **Page**: typed `character|location|faction|item|concept|scene|note`, with `id`, `title`, `aliases[]`,
  `contextMode` (`always|auto|never`), `sections[]` (`{heading, body, provenance: eventIds[], locked, updatedAt}`),
  `links[]` (page ids), `grade` (optional 0–9, user over AI), `retrieval` (keywords, last used), and a bounded history
  of replaced section bodies, each entry with the change kind (`create|change|contradiction|delete|...`), a
  `highlighted` flag, and `revertedBy` when the user undid it (Q8; the fields exist from slice 1, the UI comes in
  slice 7). A character page has fixed section slots the writer must use (identity, current state,
  relationships, knowledge, goals, inventory, open continuity) so retrieval and compaction can address them; other
  types have fewer. Exactly one `scene` page: present participants, place, time, immediate state; it is rewritten, not
  appended.
- **Thread**: open promises, foreshadowing, and questions with ids, `who[]`, a lifecycle
  (`open|progress|partial|done|cancelled|paused`) whose transitions the writer names by the thread's id (Archive
  Center's lifecycle keys), and the event that closed it.
- **Evidence**: the chat's messages, addressed by id; events' `keyLines` and original excerpts are retrieved from them,
  never copied into a second store beyond the bounded key lines.

HypaV3's flat summaries map onto events with `sources` = `chatMemos` and no participants (D12).

### D2. Evidence boundary: confirm on the next message

A reply becomes evidence when the user sends the next message (the job for turn N confirms the last assistant reply
before it, as Dusk's `confirmedAiIndex` and BardWiki's `projectConfirmedMemoryTurn` do), or when the user presses
"record now" on a message. The newest assistant message, a reply being streamed, rerolled, or continued, and swipe
candidates are never written. A write never blocks the send that triggered it (D3), except when the user answers the gap question with "summarize now" (owner, 2026-11-02), which runs the writer in the job once, as HypaV3 does; the manifest of that send says
"turn N−1 not yet recorded" so the user knows the reply was made without it.

### D3. Writer: a background task on the memory task service

- The writer is a task kind on `memoryTasks.ts`: queued by the runner's hand-off right before `done` with the confirmed
  message ids, running under the chat's writer lease, fenced like HypaV3's task (every tab's panel is read-only while
  it runs), bounded by `MEMORY_TASK_LIMITS`, and ended `skipped` with a reason when a start check fails. Manual
  "record now" and backfill of an older chat reuse the same queue with a cost preview (calls, estimated tokens).
- Cadence setting: every confirmed turn (default); every K confirmed turns (one event per window, cheaper, coarser);
  token-based, where the writer waits until the uncovered raw history reaches a token threshold under the chat's
  budget mode, as HypaV3's budget and lookahead headroom rules do today; or manual only. Every automatic mode uses the
  same contract over the window it closes (one turn, K turns, or the turns the threshold releases).
- Model: the `memory` slot (`subModel` by default), as HypaV3; a local WebLLM summarizer is refused with the existing
  `localSummarization` skip. Plugin-provider slots and `request` triggers need the tab, so automatic recording is off
  for them: the panel and the receipt say "not recording automatically" with the reason (which slot or trigger needs
  the tab), and "record now" runs the writer from the tab (Q6).
- Prompts (Q5): each call's prompt is assembled from named slots (`{{slot::format}}`, `{{slot::rules}}`,
  `{{slot::language}}`, `{{slot::cast}}`, `{{slot::scene}}`, `{{slot::threads}}`, `{{slot::previous}}`,
  `{{slot::messages}}`) through the task host's ChatML parser and CBS, as HypaV3's summarization prompt is today. In
  the plain mode the frame is code's and the preset adds only a free "writer instructions" text. With the preset's
  **prompt fine-tuning** box checked, the preset's ChatML for the analysis call and for the patch call replaces the
  default entirely, quoting the slots it wants; a "view default prompt" button shows the full default with its slots,
  and a stored guide says what may change (wording, order, examples, language) and what may not (field names and
  types; the validator below is the same in both modes, so a missing field fails the run with that reason in the log
  and the receipt). Checking the box warns that a wrong prompt breaks recording; while it is on, the panel, the health
  badge, and every receipt say "custom prompt". A **test run** replays the last window without saving and shows the
  parsed output and its validation errors.
- Two calls at most per window, both JSON with schemas validated and clamped in code:
  1. **Analysis** (temperature 0): input is the cast as `{id, title, aliases, lastState, currentSectionsSummary}` for
     pages matched in the window plus `always` pages, the scene page, open threads with ids, the previous event's
     title, up to M earlier messages for context, and the window's messages with speaker labels and ids; output is the
     event (D1) plus `pageCandidates[]` (`{targetId | create: {type, title, aliases}, reason, confidence}`). Code drops
     participants that name no page and no create, caps candidates (8 by default), and refuses creates below a
     confidence threshold into an "unresolved mentions" list for the user instead of making a page.
  2. **Page patches**: for accepted candidates, section `upsert|delete` patches only (BardWiki's rule); untouched
     sections keep their bytes; a patch that empties a page, touches a locked section, or targets a section the call
     was not shown is refused and logged. Batched to the analysis budget; a partial failure keeps the pages that saved
     and the receipt lists the rest.
- Code checks evidence before admission: each `keyLine` and each knowledge or state item's `quote` must be a
  contiguous substring of a message in the window (Archive Center's rule); an item whose quote is not found is kept
  out and listed in the receipt as unverified, never silently dropped.
- Code owns deduplication (an event whose `summary` is near-identical to the previous one for the same participants is
  merged into it with a repeat count), conflict classes for lasting attributes (`change` supersedes with `was:`;
  `contradiction` above the confidence threshold supersedes and is highlighted, below it both values are kept as
  disputed with an alert; neither waits for approval, Q8), caps per reply, and thread closing by
  id only. Grades, if kept (Q7), come from model-scored axes and code-computed thresholds.
- Failure: a run saves nothing partial except pages that fully applied; the event stays `pending` with the error and
  the run keeps its exact input snapshot so a retry replays the same call; the next run retries the same window; after
  5 consecutive failures auto-recording pauses with a visible notice and a resume button. Output arriving after the
  deadline is discarded. Pinned, suppressed, and user-corrected flags on existing records are re-applied after any
  re-record.

### D4. Provenance, reconciliation, and retraction

- Every event and section carries `sources[] {messageId, hash (full content SHA-256), index}`; the hash is of the
  stored message, not the formatted one.
- The read path reconciles on a copy before every send: an event whose source is missing or whose hash changed becomes
  `stale` for that send (excluded from the lanes, its key lines never quoted) and the panel badges it with the reason
  (changed, missing, inserted, moved), with repair choices per event: re-record from the remaining sources, retract,
  keep as is. Nothing is deleted by reconciliation.
- Deleting a message retracts the events that cite it after a confirmation (BardWiki); sections whose provenance is
  only retracted events are flagged "unsupported" for review, never auto-reverted (a page may still be right). Editing
  a confirmed message queues a re-record of its event; the old event stays until the new one commits.
- Chat copy and branch: a branch inherits only events and section provenance whose every source maps onto the new chat
  (by id, else by position with identical role and text), so nothing from after the branch point crosses (HypaPlus);
  pages are copied with sections kept where any provenance survived and flagged otherwise. Checkpoints and chat
  exports carry the records with the chat (server bundles them with the chat row); the upstream export writes the
  `hypaV3Data` projection (D11).

### D5. Storage: server tables beside the chat tables

- New tables keyed by the chat's incarnation `chats.seq`, dropped with it by cascade: `memory_state`, `memory_pages`, `memory_sections` (or sections embedded per page row if
  the row stays small), `memory_events`, `memory_threads`, `memory_runs` (writer log: window, model, tokens, result,
  receipt), `memory_manifests` (optional, if the per-send manifest outgrows `generationInfo`). One revision per chat's
  memory, checked on every write; a stale write is refused and retried from a fresh read, never merged by field.
- Shared types in `shared/memory.ts` (or a new `shared/structuredMemory.ts`), ownership in `shared/sections.ts` for
  the settings, normalization under `server/src/data/normalize/` (invariant D2). Routes under `/api/memory/...` beside
  the task routes; the read budget rules of server-resources apply (bodies on demand, the panel receives a table of
  contents first).
- Vectors: event summaries, key lines, and page sections embedded through `server/src/prompt/embeddings.ts` into the
  existing vector cache, keyed by record id, content hash, and model; a changed section misses once.
- Markdown export per chat (pages as files with YAML frontmatter, events as a timeline) and import of the same package;
  no file watching, no round-trip guarantee for hand edits beyond the import.

### D6. Read path: lanes under a hard maximum

In `assemblePrompt`'s memory step, replacing HypaV3's select when the chat's algorithm is structured memory:

1. **Window.** Keep the last R assistant turns and the user messages between them raw (counted in assistant turns, not
   messages; `queryChatCount` becomes this). Older history is dropped from the prompt only where an active event
   covers it; uncovered older history stays raw and trims from the front exactly as HypaV3's `trimUncovered` does, so
   `coverage: "gap"` keeps its meaning and the background writer closes gaps.
2. **Required lane**: the scene page and every `always` page, whole, under a required cap; if the cap is exceeded the
   send fails with a named error listing the pages (nothing is silently cut; the user shrinks or demotes a page).
3. **Recent flow**: the titles of the last F events with "N turns ago" computed from current message positions.
4. **Pages lane**: candidate pages are the participants of the scene, pages whose title or alias appears in the last S
   messages (lore-activation matching rules), pages linked from those within one hop, and pages whose sections embed
   near the query (the last Q messages); ranked by match kind, then recency of last update, then similarity; each page
   contributes its current-state and relationship sections whole, plus only the knowledge items whose subject is on
   stage; a page that does not fit is left out whole. For every character on stage, a "does not know" line lists
   secrets of other pages the character is not a knower of.
5. **Events lane**: opens when the window reads as past, causal, or chronological, or when similarity to an event is
   high; events are ranked by similarity and participant overlap, included whole with their key lines.
6. **Evidence lane**: original excerpts for the selected events' sources (bounded per excerpt and in count), lexical
   and semantic matches over messages older than the window second.
7. **Threads**: open threads whose `who` is on stage.

Budget: `resolveHypaV3Budget`'s two modes give the maximum; the lanes have targets and the maximum is the only hard
limit; required pages reserve first, then each populated lane gets a core round up to its target, then the rest of the
maximum is lent to lanes by item score (Archive Center's core-then-overflow rule). Token counts use the job's tokenizer. The lanes are a cap, not a quota: a quiet
scene leaves room empty.

### D7. Placement and format

- Default: the existing memory card (`memo: "supaMemory"`) at the front of history, so presets, Lua, the recheck, and
  plugins that expect it keep working. The card has two parts in a fixed order: a stable part (required pages, recent
  flow) and a volatile part (pages, events, evidence, threads).
- Option: the volatile part before the latest user message (cache-friendly), with the stable part staying in the card.
- Format: a short rule header (sources are authoritative for the past, the scene for the present, recent messages win),
  then one line per item with a stable item tag the manifest can find in the final prompt (`[m:<id>]`, stripped from
  what the model sees only if a provider forbids it; otherwise a few tokens per item is the price of verification).
  Field values are written in the writer's configured language (Q5: an explicit setting, the UI language at first,
  overridable per character and per chat), never hard-coded; changing it does not translate stored records (a rebuild
  does, D12).

### D8. Verification surfaces

The answer to the first complaint. Everything below reads stored data; nothing is estimated after the fact.

- **Per-send manifest** in `ContextReport.memory.items[]`: `{id, kind, lane, reason, tokens, verified}` for every
  included item, the excluded candidates with their reason (`budget`, `not-relevant`, `never`, `stale`), the lanes'
  targets and spend, the window's confirmed-through message id, and the writer state at send time (`recorded`,
  `pending turn N−1`, `failed`, `paused`). `verified` is set by finding the item tag in the final formatted prompt after
  scripts and `editRequest` (BardWiki's rule). The `ContextMeter` line shows memory tokens and a status word; its
  popover lists the items; the panel's Timeline and Pages views badge "used in the last send".
- **Per-turn receipt** stored with the confirmed message (`generationInfo.memory`): event id, pages created or changed
  with before and after section hashes, candidates refused (reason, confidence), warnings (disputed attribute, locked
  section skipped), model and token cost. Shown under the message as one collapsible line ("Recorded: 1 event, 2 pages
  updated, 1 refused, 1 to check") with a link to the diff in the panel; highlighted changes (Q8) carry a revert
  button there and in the page history. A pending or failed turn shows that instead.
- **Coverage view**: each message's state (`covered` by event id, `pending`, `failed`, `skipped` with reason,
  `excluded` by screening or the user, `stale`), the uncovered gap in tokens, and what the next send will drop raw.
- **Writer log**: one row per run (window, model, input and output tokens, duration, result, error), exportable, with
  the run's extracted event and candidates viewable in full next to their quotes (Archive Center shows only counts;
  this design shows the facts).
- **Turn stage ledger**: the send's job already reports stages; the memory step adds its own with reason codes
  (window chosen, lanes filled, card verified, writer queued, writer skipped with reason), shown in the generation
  spinner's detail and kept in the manifest, so "nothing happened" always has a stated reason.
- **Preview**: the exact memory block the next send would get, with the manifest, built without marking anything used.
- **Health badge** on the chat and the sidebar: the worst of writer paused, coverage gap over a threshold, stale events,
  unsupported sections, required lane over cap, page growth past its section budget; a custom writer prompt (D3) shows
  as its own state.

### D9. The panel

`HypaV3Modal` stays for HypaV3 chats; structured-memory chats open a memory panel with tabs:

- **Pages**: a tree by type with the scene pinned on top; an editor with sections, locks, provenance per section
  (jump to the events and messages), history with diffs, aliases, context mode, grade, merge and split (aliases move,
  provenance follows), delete to trash, export to lorebook as an inactive entry.
- **Timeline**: events in current message order with participants, "N turns ago", status badges, repair choices, jump
  to sources; retracted events shown struck through.
- **Coverage** (D8), **Log** (D8), **Threads**, and **Settings** (cadence, window, lanes, language, model, writer
  instructions or the fine-tuned prompts with their test run, change highlighting and its kinds, screening lists,
  per-chat overrides).
- Every write goes through the chat's memory revision and the memory task fence; a refused edit is undone in the copy,
  as the modal does today.

### D10. Multi-character rules

- Pages have stable ids; the writer references ids, and a create needs a confidence above the threshold or a user
  confirmation from the "unresolved mentions" list. Aliases, merge, and split are user tools; lorebook entry names and
  the group's member names seed the alias table.
- Knowledge is per page with `knows|believes` and a knower list on secrets; the pages lane emits "does not know" lines
  for characters on stage.
- Relationships are directed (`from → to`) shift logs with a current one-line state per direction; gauges are out of
  the first version (Q7).
- The scene page is the attendance record: its participants drive the pages lane, and group chats write the speaker's
  id on each event.
- The writer's analysis input includes only the pages matched in the window plus `always` pages, so a cast of forty
  costs the same per turn as a cast of four.

### D11. Compatibility and the algorithm chain

- Structured memory is a new algorithm in the priority chain (memory guide `Selection`), selected per the existing
  settings page; the `supaMemory` toggle gate, the trim question, `supaMemoryOnCount`, and the memory card stay. One
  owner per chat: turning it on for a chat that has HypaV3 data offers migration (D12), never both.
- Plugins that read `hypaV3Data` get a projection: each active event as a summary with `chatMemos` = its source ids,
  `isImportant` for pinned events and events of grade 6 or above (`importantEventGrade`, code's constant), metrics from the last manifest. Writes to that projection from plugins
  are refused with a notice.
- The upstream export writes the same projection.

### D12. Migration and rebuild

- Adopt: existing HypaV3 summaries become events (`sources` = `chatMemos`, no participants, title from the first
  sentence) so coverage is kept on day one; the writer then records new turns normally.
- Rebuild from transcript: a resumable job (batches of one or two turns, staging records, atomic swap at the end, pause
  and resume across restarts, generation locked for the chat while it runs) chained as tasks on the service so it
  stays under the per-task deadline. It is also how an adopted chat gains pages, and how a language change is applied.
- A cost preview precedes both.

### D13. Growth control

- Section budgets per page type; when a section passes its budget the writer is asked for a compaction of that section
  only (history kept, a diff shown in the receipt), and a compaction that is not smaller is discarded.
- Attributes supersede (`was:`) instead of accumulating; superseded facts also leave the scene page and the recent
  flow.
- Events are never compacted; old low-value events leave the lanes by ranking, not by deletion.
- No counter rewards being injected.

### D14. Evaluation before claims

- Fixture chats (Korean and English, 100 and 1,000 turns, a cast of ten, with labelled probes: needed records, records
  that must not leak, knowledge-boundary questions, two-event comparisons, unanswerable questions) in
  `server/src/tests/fixtures/memory/`; a capture and exclusion rate tool over the manifest, like Dusk's `evalRetrieval`.
- A per-chat token ledger: writer input and output, memory tokens per send, raw window tokens, against HypaV3 on the
  same fixture.
- Nothing in the settings or docs quotes a recall figure that was not measured on these fixtures with the model named.

## Costs

Per confirmed turn with defaults: one analysis call (cast slice plus window; a few thousand input tokens) and, when
candidates are accepted, one patch call; both on the `memory` slot in the background. Per send: the memory block under
the maximum plus the raw window; an embedding of the query and of new records. BardWiki's measurement is the warning:
per-turn writing can cost as much as the transcript it saves, so the batch cadence (D3) and the small analysis input
(D10) are not optional extras, and the ledger (D14) is part of the first slice that writes anything.

## Slices

Each slice lands alone as one commit. The numbers keep the order of the first design (1 store, 2 writer, 3 read path, 4
pages, 5 reconciliation, 6 migration, 7 growth and review, 8 evaluation); slices 2 and 3 together answer the first
complaint, slice 4 the second.

Code layout: `shared/structuredMemory.ts` (types and pure rules), `server/src/data/memoryStore.ts` (the tables),
`server/src/prompt/memory/structured/` (writer and read path), `server/src/routes/structuredMemory.ts` (routes under
`/api/memory/structured/...`), `src/ts/process/structuredMemory.svelte.ts` (the tab's client and state),
`src/lib/Others/StructuredMemory/` (the panel).

Rules for every slice:

- **Checks.** `pnpm format:check`, `pnpm check`, `pnpm check:docs`, `pnpm --silent test:agent` once after the last source
  edit; the affected `slow` and `e2e` sets, with `pnpm check:tests` when the slow-test table changes; V4 (`rg` each changed export and wire field) and V6 (each new test shown
  failing once with its line broken).
- **Guide.** The owning guides are `docs/structure/structured-memory.md`; for the writer, `docs/structure/structured-memory-writer.md`, split on 2026-11-01 when the first passed its budget; and for the read path, receipts, and panel, `docs/structure/structured-memory-read.md`, split on 2026-11-02 ahead of slices 4b and 4c. The seven guides this design touches have
  between 500 and 5,300 bytes free under the 40,000-byte budget (`pnpm check:docs` fails over it), which does not hold
  28 slices of contracts, so contracts go to the new guide, which later slices extend, and an existing guide gets only
  a link or a swap that deletes as much as it adds.
- **Strings.** User-visible text goes in `src/lang/en.ts` under `structuredMemory`; two slices that add strings do not
  run at the same time.
- **Reachability.** Nothing is selectable before slice 3c. Until then `db.memoryAlgorithmType === "structuredMemory"`
  exists only in tests, and every existing algorithm behaves exactly as before.
- **Fence.** Server code writes the tables only through `memoryStore.ts`, synchronously, after the task's or route's
  fence check. Panel writes carry the memory revision (D5).
- **Device checks.** Real browser and device checks go to the owner as a checklist in the slice report.

Refinements the slicing added to the design, found against the code:

- D5's key is the chat's incarnation `chats.seq` with `ON DELETE CASCADE`, as `chatGroups` and `chatSummaries` do, so a
  deleted and recreated chat never inherits rows. Routes still address a chat by `(characterId, chatId)`.
- The tables are raw SQLite tables behind `memoryStore.ts`, not a registered `ResourceKind`: the panel reads a table of
  contents and bodies on demand, and the change feed stays the chat's.
- Restores copy only what the snapshot walk emits, so the tables would be silently lost on a restore or an archive
  import. Slice 1c closes that before any record exists.
- `memoryAlgorithmType` is written by the settings page and read by nothing today, and the selection runs on the flags.
  Slice 2b makes it the selector for this one value, ahead of the existing chain; old saves whose value disagrees with
  the flags cannot hold `structuredMemory`.
- The source hash covers the message's role and `data` only. `generationInfo` lives in `messages.data`'s JSON, so a
  receipt write must not change a hash; it does bump the chat revision and send a change frame, one per recorded turn.
- A restart loses the queue. The writer's window comes from stored coverage, not from the hand-off, so the next send
  picks up the uncovered confirmed turns, at most `maxWriterWindows` (8, owner, 2026-11-01) windows per task, with the rest on later hand-offs; bulk catch-up is the previewed backfill (6b). No startup scan exists.
- Copy and branch reach the server as plain `create` groups with no origin, so the tab calls an idempotent inherit route
  after the create (slice 5c).
- `searchMatch` in `shared/lore/activation.ts` is private; slice 4b exports it rather than copying the rules.
- Slice 8 runs on scripted model output and adds the A/B recipe. A measured recall figure needs a real model run, which
  the owner starts; until then the settings and docs quote none (D14).

### Slice 1a: types, pure rules, and the guide (D1, D4, D11; needs nothing) — _small_

Files: new `shared/structuredMemory.ts` and its test; new `docs/structure/structured-memory.md`; `STRUCTURE.md` (Choose By
Task and Path Ownership rows); `docs/structure/memory.md` (a swap: one link in `Scope`).

- The discriminator constant `"structuredMemory"` (Q1); event, page, section, thread, run, receipt, and source types as
  D1 and D4 give them, including the page history entry with change kind, `highlighted`, and `revertedBy` (Q8) and the
  scored axes and grade (Q7); the fixed character section slots; the record limits.
- `projectHypaV3Data(events, manifest)`: the pure D11 projection. Tests: `chatMemos` equal source ids, retracted events
  are left out.

### Slice 1b: tables and the memory store (D5; needs 1a) — _hard_

Files: new `server/src/data/memoryStore.ts` and `server/src/tests/memoryStore.test.ts`; `server/src/data/chatStore.ts`
(the DDL joins `CHAT_OPEN_SCHEMA_SQL`, not `CHAT_TABLE_COLUMNS`); `server/src/data/resourceStore.ts` (exposes the store).

- `memory_state` (one revision per chat), `memory_pages`, `memory_events`, `memory_threads`, `memory_runs`, each with
  `chatSeq` and the cascade. Sections embed in the page row unless a test shows the row growing past the read budget.
- Synchronous writes inside one transaction with an expected revision and the epoch; a stale write is a typed refusal,
  never a field merge. Table-of-contents reads carry ids, titles, status, and sizes; bodies are read by id.
- `messageSourceHash(message)`: SHA-256 of role and `data`. Test: a `generationInfo` change keeps the hash.

### Slice 1c: snapshots and restores carry the tables (D5; needs 1b) — _hard_

Files: `server/src/data/chatStore.ts` (the snapshot walk, the staging sink, `copyStagedChats`),
`server/src/data/resourceStore.ts`, `server/src/data/restore/stageValidatedSnapshot.ts`, `server/src/data/memoryStore.ts`, tests in
`server/src/tests/restoreStage.test.ts` and `backups.test.ts`.

- An optional all-or-none table group, like the checkpoint tables: a snapshot from before the tables restores with none;
  a partial group is refused. Rows are remapped through the staged-to-live chat seq map.
- Test: rows survive a snapshot restore and an archive import; an old snapshot restores; `replaceAll` leaves no rows of
  the replaced chats.

### Slice 1d: read routes, the tab client, Markdown export (D5; needs 1b) — _small_

Files: new `server/src/routes/structuredMemory.ts` and its test; `server/src/app.ts`; new
`src/ts/process/structuredMemory.svelte.ts` and its test.

- Table of contents, record by id, and a per-chat Markdown package (pages with YAML frontmatter, events as a timeline),
  under the read budgets of server-resources, with the epoch and `authFetch` as the task routes use them. Import is
  slice 7d.

### Slice 2a: writer settings (D3, Q3, Q5, Q8; needs 1a) — _small_

Files: `shared/memory.ts` (`HypaV3Settings`), `shared/hypaV3Presets.ts`, `server/src/jobs/jobScope.ts`
(`memorySettingsFingerprint`), `shared/database.ts` (the chat and character language override and the chat highlight
mode), `shared/chatCheckpoints.ts` (their field classes), the chat and character normalizers under
`server/src/data/normalize/` and `server/src/data/chats.ts`, tests beside them.

- A nested `structured` object in the memory preset: cadence (`everyTurn`, `everyK`, `tokens`, `manual`) with K and the
  token threshold, window R, flow F, lane targets, required cap, screening lists, instructions, the fine-tuning switch
  and prompts, highlight mode and kinds. Invalid values take defaults (`createHypaV3Preset`'s rule). No UI.

### Slice 2b: the writer task kind and hand-off (D2, D3, Q6; needs 1b, 2a) — _hard_

Files: `shared/jobs.ts` (`MemoryTaskInput` by kind, `kind` on the status), `server/src/prompt/memory/memoryTasks.ts`,
`server/src/prompt/assemble.ts` (the selection, the `memoryConfigured` gate, a step that keeps raw history and returns
the hand-off), `server/src/prompt/runner.ts`, new `server/src/prompt/memory/structured/window.ts`,
`src/ts/process/memoryTasks.svelte.ts`, tests in `server/src/tests/memoryTasks.test.ts`, `memoryJobs.test.ts`.

- HypaV3's checks and work move behind the kind unchanged (its tests stay green unedited). The writer's work is an
  injected function, filled in 2c.
- `window.ts`: the confirmed window from stored coverage and the cadence; the newest assistant reply, a generating one,
  and swipe candidates are never in it. Start checks refuse a `Plugin` slot or an applicable `request` trigger with
  `pluginModel` and `requestTrigger`, and a local summarizer with `localSummarization` (Q6).

### Slice 2c: analysis call, events, threads, failure rules (D1, D3, Q5, Q7; needs 2b) — _hard_

Files: new `server/src/prompt/memory/structured/{prompts,analysis,writer}.ts` and tests; `memoryTasks.ts` (the wiring
only); `shared/structuredMemory.ts`; `memoryStore.ts`.

- Plain-mode slot assembly through the task host's ChatML parser and CBS, with the language setting. Temperature 0;
  output validated and clamped; no page candidates yet (participants only name existing pages).
- Code checks quotes against the window's messages; an unverified item is listed, never dropped. Deduplication, caps,
  threads closed by id only. A grade is the sum of the three axes (0–9); an event without axes has none.
  `projectHypaV3Data` takes the grade threshold of D11, in `shared/structuredMemory.ts`, and the guide's Limitations entry on it goes.
- `memory_runs` keeps the exact input snapshot, tokens, and result. A failed run retries the same window from that
  snapshot; after 5 consecutive failures auto-recording pauses; output after the deadline is discarded; event vectors are
  warmed as `warmHypaV3Vectors` does, into the existing cache.

### Slice 2d: receipts and record now (D2, D3, D8, Q6; needs 2c) — _hard_

Files: `shared/database.ts` (`MessageGenerationInfo.memory`), `structured/writer.ts`, `routes/structuredMemory.ts`,
`src/lib/ChatScreens/Chat.svelte` (`genInfo`), new `src/lib/ChatScreens/MemoryReceiptLine.svelte`,
`src/ts/process/structuredMemory.svelte.ts`, `src/lang/en.ts`.

- The receipt is written with `patchMessage` under the task fence; the collapsible line shows recorded, pending, failed,
  or "not recording automatically" with the slot or trigger that needs the tab. "Record now" and the resume button run
  through the service; for a tab-bound slot it runs as a job on the owner's channel, as blocking HypaV3 does (Q6).

### Slice 2e: panel shell, Coverage, and Log (D8, D9; needs 1d, 2d) — _hard_

Files: new `src/lib/Others/StructuredMemory/{StructuredMemoryPanel,CoverageTab,LogTab}.svelte` and tests;
`src/App.svelte` (the mount picks the panel by algorithm); `routes/structuredMemory.ts`;
`src/ts/process/structuredMemory.svelte.ts`; `src/lang/en.ts`.

- `SegmentedControl` tabs; the task fence from `memoryTasks.svelte.ts` makes the panel read-only. Coverage: each
  message's state, the gap in tokens, what the next send drops raw. Log: one row per run with the extracted event next
  to its quotes, exportable.

### Slice 3a: lanes and retrieval (D6, D7; needs 2c) — _hard_

Files: new `server/src/prompt/memory/structured/{lanes,retrieve,card}.ts` and tests.

- Pure pieces: the window rule in assistant turns, the budget through `resolveHypaV3Budget`, targets then a core round
  then lending, recent flow, the events lane (past or causal reading, similarity, participant overlap), the evidence
  lane, the threads lane, and the card's stable and volatile parts with `[m:<id>]` tags. Similarity goes through
  `MemoryHost` embeddings.

### Slice 3b: the step, the card, and the manifest (D6–D8; needs 2b, 3a) — _hard_

Files: `server/src/prompt/assemble.ts` (the step, the report, verification), new
`server/src/prompt/memory/structured/step.ts`, `shared/contextReport.ts` (`items`, the kind, parsing),
`server/src/prompt/memory/hypav3.ts` (the gap trim extracted, HypaV3 unchanged), tests.

- `memo: "supaMemory"` stays; uncovered history trims as `trimUncovered` does, with `coverage: "gap"` and the gap
  question; the protected tail goes into `protectedEntries`; the cache-friendly placement option.
- `verified` is set by finding each tag in the final prompt after scripts and `editRequest`, in `buildContextReport`.
  The manifest holds included and excluded items with reasons, lane spend, the confirmed-through id, the writer state,
  and the stage ledger.

### Slice 3c: meter, preview, and the settings option (D8, D11; needs 2e, 3b) — _hard_

Files: `src/lib/ChatScreens/ContextMeter.svelte`, `src/lib/Setting/Pages/MemorySettings.svelte`,
`src/ts/setting/memorySettingsData.ts`, `routes/structuredMemory.ts` (preview), the panel's badges, `src/lang/en.ts`.

- The meter's status word and item list; "used in the last send" badges; the preview on the job's `preview` path, marking
  nothing. The option writes `memoryAlgorithmType` and clears the other flags, and exposes the preset fields of 2a except
  the fine-tuning ones. Selecting it leaves `hypaV3Data` untouched; such a chat starts with a coverage gap until 6a.
- An empty card whose events still dropped covered history reports `coverage: "gap"` (owner, 2026-11-02): the model did not
  see that history. The guide's Limitations entry on it goes. The meter's guard on the kind goes with its string.

### Slice 4a: page candidates and patches (D1, D3, D10; needs 2c) — _hard_

Files: new `server/src/prompt/memory/structured/{patches,pages}.ts` and tests; `structured/{prompts,analysis,writer}.ts`;
`memoryStore.ts`.

- The analysis input gains the cast slice (pages matched in the window plus `always` pages); candidates and creates under
  the confidence threshold; "unresolved mentions"; alias seeds from lore entry names and group members. The patch call:
  section `upsert|delete`, refusals for locked, unseen, and emptying patches; partial failure keeps saved pages. Scene
  page rewrite, conflict classes with `was:`, disputed values, history entries, section vectors.

### Slice 4b: required lane, pages lane, knowledge (D6, D10, Q4, Q9; needs 3b, 4a) — _hard_

Files: `shared/lore/activation.ts` (`searchMatch` exported, behavior unchanged), `structured/{lanes,retrieve,card,step}.ts`,
tests.

- Required pages whole under the cap; over it the send ends with a `SendError` listing the pages. Candidates by scene
  participants, name and alias match, one link hop, and similarity; whole-or-nothing; knowledge items on stage with
  private labels; "does not know" lines; `never` pages hidden.

### Slice 4c: Pages, Timeline, and Threads tabs (D9; needs 2e, 4a) — _hard_

Files: new `src/lib/Others/StructuredMemory/{PagesTab,TimelineTab,ThreadsTab}.svelte` and tests;
`StructuredMemoryPanel.svelte`; `routes/structuredMemory.ts` (revision-checked edits); `memoryStore.ts`;
`src/ts/process/structuredMemory.svelte.ts`; `src/lang/en.ts`.

- The page tree with the scene on top, section editing, locks, provenance jumps, history with diffs, context mode, grade;
  events in message order with sources; thread lifecycle. A refused edit is undone in the copy, as the modal does.

### Slice 5a: anchors at read time and repair (D4; needs 4b, 4c) — _hard_

Files: new `server/src/prompt/memory/structured/reconcile.ts` and tests; `structured/{retrieve,step}.ts`;
`TimelineTab.svelte`; `routes/structuredMemory.ts`; `src/lang/en.ts`.

- Reconciliation on a copy: a changed, missing, inserted, or moved source makes the event `stale` for that send, with the
  reason in the manifest and a badge. Repairs per event: re-record, retract, keep. Reconciliation deletes nothing.

### Slice 5b: retraction on delete, re-record on edit (D4; needs 5a) — _hard_

Files: `server/src/data/chatStore.ts` (`applyGroup` reports removed and rewritten message ids), `structured/reconcile.ts`,
`memoryTasks.ts`, `src/ts/storage/chatStore.svelte.ts` (`removeMessages`' confirmation), `src/lang/en.ts`, tests.

- Deleting cited messages asks, then retracts; sections left with only retracted provenance are flagged "unsupported",
  never reverted. An edit queues a re-record and the old event stays until the new one commits. A `generationInfo` or
  translation write triggers nothing.

### Slice 5c: copies and branches (D4; needs 4a) — _hard_

Files: new `server/src/prompt/memory/structured/inherit.ts` and tests; `routes/structuredMemory.ts`;
`memoryStore.ts`; `src/ts/process/structuredMemory.svelte.ts`; `src/lib/SideBars/SideChatList.svelte`,
`src/lib/Others/ChatList.svelte`, and the branch path in `src/lib/ChatScreens/Chat.svelte`.

- After its `create`, the tab calls an idempotent inherit route. Sources map by id, else by position with identical role
  and text; events with any unmapped source do not cross; pages keep sections with surviving provenance, flagged
  otherwise. A failed call leaves a chat with a coverage gap and a notice, never a wrong record.

### Slice 5d: checkpoints and chat files (D4; needs 4a) — _hard_

Files: `shared/chatCheckpoints.ts`, `server/src/data/checkpointStore.ts`, `server/src/data/checkpointService.ts`,
`src/ts/characters.ts` (chat export and import), `memoryStore.ts`, tests.

- A checkpoint carries the chat's memory records and loading it restores them under a new memory revision. Exported
  chat JSON carries them and `importChat` restores them on the new chat.

### Slice 5e: the `hypaV3Data` projection for plugins and upstream (D11; needs 4a) — _hard_

Files: `server/src/data/upstream/exportDatabase.ts`, the full-chat read in `server/src/data/chatStore.ts`,
`src/ts/storage/chatStore.svelte.ts` (`applyChatResult`), `src/ts/plugins/apiV3/v3.svelte.ts`, `src/lang/en.ts`, tests.

- A structured chat's full read overlays the projection, so every plugin reader gets it unchanged. `applyChatResult` and
  the new-chat path drop a changed value with a `warnRefused` notice; the stored field stays absent. The upstream export
  writes the same projection.

### Slice 6a: adopt HypaV3 data (D11, D12; needs 3c, 5a) — _small_

Files: new `server/src/prompt/memory/structured/adopt.ts` and tests; `routes/structuredMemory.ts`; the panel;
`src/lang/en.ts`.

- A chat with summaries and no records is offered adoption: each summary becomes an event (`sources` from `chatMemos`,
  title from the first sentence, hashes from the messages as stored; a missing message makes it `stale`). `hypaV3Data`
  stays as it was until the user resets it.

### Slice 6b: rebuild and backfill (D3, D12; needs 6a) — _hard_

Files: new `server/src/prompt/memory/structured/rebuild.ts` and tests; `memoryTasks.ts`; `memoryStore.ts` (staging rows and
the atomic swap); `routes/structuredMemory.ts`; the panel; `src/lang/en.ts`.

- A chained, resumable task under the per-task deadline, with persisted progress, a cost preview, generation locked for
  the chat, and an atomic swap at the end. Backfill is the same run limited to uncovered turns. A language change offers
  a rebuild.

### Slice 7a: compaction (D13; needs 4a) — _hard_

Files: new `server/src/prompt/memory/structured/compact.ts` and tests; `structured/writer.ts`; `shared/structuredMemory.ts`.

- Section budgets per page type; a section over budget gets one compaction call; a result that is not smaller is
  discarded; history keeps the old body and the receipt the diff. Events are never compacted.

### Slice 7b: change highlighting and revert (Q8; needs 4c) — _hard_

Files: `structured/pages.ts`, `routes/structuredMemory.ts`, `PagesTab.svelte`, `MemoryReceiptLine.svelte`,
`MemorySettings.svelte`, `src/lang/en.ts`, tests.

- The three modes, per chat with a global default, and the kinds as checkboxes; importance comes from the change kind in
  code. Revert from the receipt and the history, recorded as `revertedBy: user`, which the writer's input then carries so
  the change is not proposed again; the notice counts the items added after it that stay.

### Slice 7c: prompt fine-tuning (D3, Q5; needs 2e, 3c) — _hard_

Files: `structured/prompts.ts`, `routes/structuredMemory.ts` (test run), `MemorySettings.svelte`, new
`src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`, the panel and receipt's "custom prompt" state, `src/lang/en.ts`.

- The ChatML replaces each call's default and quotes `{{slot::…}}`; validation is the same in both modes. The default
  prompt is viewable, the guide text is stored, checking the box warns, and a test run replays the last window without
  saving and shows the parsed output and errors.

### Slice 7d: page tools and Markdown import (D5, D9, D10; needs 4c) — _hard_

Files: `structured/pages.ts`, `routes/structuredMemory.ts`, `PagesTab.svelte`, new
`server/src/prompt/memory/structured/importPackage.ts`, `src/lang/en.ts`, tests.

- Merge and split (aliases move, provenance follows), delete to trash, export to the lorebook as an inactive entry, and
  import of the 1d package with a per-file refusal list. No round trip is promised for hand edits.

### Slice 7e: health badge and screening (D8, D9; needs 5a, 7a) — _hard_

Files: `src/lib/SideBars/ChatStatusBadge.svelte`, `src/lib/SideBars/chatStatus.ts`, the chat header, `structured/window.ts`,
`routes/structuredMemory.ts`, `MemorySettings.svelte`, `src/lang/en.ts`, tests.

- The worst of writer paused, gap over a threshold, stale events, unsupported sections, required lane over cap, page over
  budget, and custom prompt. Screening lists mark a message `excluded` in Coverage; per-chat overrides join the panel's
  Settings tab.

### Slice 8: evaluation (D14; needs all) — _hard_

Files: new fixtures under `server/src/tests/fixtures/memory/structured/`, new `util/memoryEval.mjs`, a test beside the
fixtures, new `docs/audit/structured-memory-<date>.md`.

- Korean and English chats of 100 and 1,000 turns with a cast of ten and labelled probes; scripted writer output; a capture
  and exclusion rate tool over the manifest; the token ledger beside HypaV3 on the same fixture; the A/B recipe for a
  real model. Guide text states no recall figure.

## Recommended order

1a; then 1b and 2a; 1c, 1d, and 2b; 2c; 2d and 3a; 2e and 3b; 3c; 4a; 4b and 4c; 5a, 5d, and 7a; 5b and 5c; then 5e, 6a,
6b, 7b, 7c, 7d, 7e, and 8 one at a time. The later run is serial because each adds strings or shares the panel's route
file. `memoryTasks.ts`, `assemble.ts`, `memoryStore.ts`, `routes/structuredMemory.ts`, and `structured/writer.ts` each have
one writer at a time through this order; the guide is shared by all, and a conflict there is docs only.

## Out of scope

Guidance or director prompts; affection or emotion gauges as a HUD; a reranker model call inside the send; file-native
storage with external-edit detection; per-character chronology tabs; translating existing records on a language
change (a rebuild does it); a cross-chat or cross-character shared memory.

## Open questions

None. Q1–Q9 are answered below; new questions found while slicing go here.

## Answered questions

Answered by the owner on 2026-11-01:

- **Q1. Name.** The algorithm's persisted discriminator is `structuredMemory`: the value the settings page stores in
  `memoryAlgorithmType` (D11) and the name any per-chat record under D5 carries for the algorithm. Fixed before slice
  1 and never renamed. The settings label stays "Structured memory" for now; it is a translation string the owner may
  change later without touching stored data.
- **Q2. Replace or coexist.** Opt-in. HypaV3 stays the default for new chats; structured memory is chosen per the
  settings page, and existing HypaV3 chats are offered migration only when the owner turns it on (D11, D12). Revisit
  the default once the evaluation fixtures (D14) show it matches HypaV3's capture rate at equal tokens.
- **Q3. Default cadence.** Every confirmed turn by default, with the cost ledger visible. The writer can be deferred the
  way metatron's HypaV3 defers today: by turns (every K confirmed turns) or by tokens (wait until the uncovered raw
  history reaches a threshold under the chat's budget mode), both one setting away (D3).
- **Q4. Required-lane overflow.** Fail the send with a named error that lists the pages over the cap; nothing is
  silently cut (D6).
- **Q5. Writer language and prompts.** Language is an explicit setting: the UI language at first, overridable per
  character and per chat; stored records are not translated when it changes (a rebuild does it). Prompts have two
  tiers, both in the memory preset as HypaV3's summarization prompts are. Plain mode: code owns the format and the
  validation rules, and the user adds only a free "writer instructions" text. Fine-tuning mode (a checkbox): the user's
  ChatML replaces the default prompt of each writer call entirely and quotes the writer's inputs through named slots
  (`{{slot::format}}`, `{{slot::rules}}`, `{{slot::language}}`, `{{slot::cast}}`, `{{slot::scene}}`,
  `{{slot::threads}}`, `{{slot::previous}}`, `{{slot::messages}}`), with ordinary CBS also processed; the default
  prompt is viewable, a stored guide says what may change and what may not, a test run replays the last window without
  saving, checking the box warns that a wrong prompt breaks recording, and the panel, health badge, and receipts show
  "custom prompt" while it is on. Validation of the output is identical in both modes (D3). Slot quoting is
  recommended over pasted text so a later format change reaches the user's prompt.
- **Q6. Plugin-provider memory slot.** Manual recording only. The panel and the receipt show "not recording
  automatically" together with the reason (the slot or trigger that needs the tab), so the user knows why and can press
  "record now" (D3). HypaV3 keeps its blocking-in-job path.
- **Q7. Grades and gauges.** As recommended: scored axes and a grade on events and knowledge items; emotion gauges out
  of the first version (D3, D10). The projection's `isImportant` threshold is grade 6 (owner, 2026-11-01; D11); Q8's
  highlighting threshold is separate.
- **Q8. Review mode.** No change ever waits for approval: writer output is applied and used at once, every change is
  in the receipt and the page history, and the user reverts from either. The owner's three-mode idea (as Claude Code's
  permission modes) is kept as a **highlighting** setting, per chat with a global default: highlight nothing /
  highlight important changes (default) / highlight every change. "Important" is decided by code from the change
  kind, never by a model score: a new page, a contradiction of a lasting attribute, a deletion or retraction, and
  optionally a `change` above a grade threshold; the settings page shows these kinds as checkboxes. A reverted change
  is recorded as `revertedBy: user` so the writer does not propose it again, and the revert notice counts the items
  added after it that stay. The hard guarantee for content that must not change without the user is the per-section
  lock (D1, D9), not a waiting mode. Two existing rules stay as the only exceptions to apply-at-once: a contradiction
  below the confidence threshold is kept as disputed with both values (D3), and a low-confidence new character stays
  in the unresolved-mentions list instead of becoming a page (D10). The status fields land with slice 1's storage;
  the UI in slice 7.
- **Q9. Secrets of characters on stage.** As recommended: carried in the prompt, labelled as that character's private
  knowledge; hidden only for `never` pages (D6, D10).

## Review record

Drafted by the session from the sources above. The three sub-agent reports were read in full by the session and their
authors state they re-checked the cited lines; the session itself re-verified only the BardWiki budgets and experiment
numbers against RisuBard's documents, and relies on the reports for the HypaPlus, Archive Center, and Dusk Atelier
line citations. The owner reviewed the draft and answered Q1–Q9 on 2026-11-01 (**Answered questions**).
