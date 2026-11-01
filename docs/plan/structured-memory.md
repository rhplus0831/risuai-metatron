# Structured Memory Plan (initial design)

Status: initial design, drafted 2026-11-01 from the owner's request; no slice is scheduled. All nine open questions
were answered by the owner the same day (see **Answered questions**); slicing can start. The persisted discriminator
is `structuredMemory`; "Structured memory" stays the settings label until the owner renames it.

Sources: the owner's request (2026-11-01: HypaV3 compresses well but the user cannot verify it on long chats and it is
weak for world-setting bots with many characters); the [memory guide](../structure/memory.md) at `43d7e4a07`; the
BardWiki sections of the [RisuBard survey](../research/risubard-survey.md) (§2.1–2.2), RisuBard's own long-chat
experiment (`docs/ko/memory-wiki-long-chat-experiment.md`) and its 2026-09-29 long-chat checkpoint note; and the three
reports under [docs/research/memory-systems/](../research/memory-systems/README.md) written for this design by Opus
sub-agents: [HypaPlus](../research/memory-systems/hypaplus.md),
[Archive Center](../research/memory-systems/archive-center.md), and
[Dusk Atelier](../research/memory-systems/dusk-atelier.md).

Owning guides when sliced: [memory](../structure/memory.md) (algorithms, modal, tasks), with
[server-generation](../structure/server-generation.md) for the job step and task wiring,
[chat-pipeline](../structure/chat-pipeline.md) for the context report, [persistence](../structure/persistence.md) and
[server-resources](../structure/server-resources.md) for the new records, [chat-store](../structure/chat-store.md) for
the write fences, and [ui-theming](../structure/ui-theming.md) for the meter and the panel.

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
candidates are never written. A write never blocks the send that triggered it (D3); the manifest of that send says
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

- New tables keyed by `(characterId, chatId)`: `memory_pages`, `memory_sections` (or sections embedded per page row if
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
  `isImportant` for events with grade or pins, metrics from the last manifest. Writes to that projection from plugins
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

## Proposed slice order (not scheduled)

1. **Store and types**: tables, shared types, revision rules, routes, the `hypaV3Data` projection, Markdown export.
2. **Writer, events only**: the task kind, confirm-on-next, analysis call without page candidates, the slot-assembled
   default prompt with the language setting and the plain instructions text, receipts, the coverage view, the writer
   log, pause on failures, the token ledger.
3. **Read path and manifest**: lanes for events and evidence, the window rule, the card, `ContextReport.memory.items`,
   the meter popover, the preview.
4. **Pages and scene**: candidates and patches, the pages lane, knowledge and "does not know", the Pages and Timeline
   tabs, locks and history.
5. **Reconciliation**: anchors at read time, retraction on delete, re-record on edit, copies and branches, checkpoints
   and exports.
6. **Migration and rebuild**: adopt HypaV3 data, the resumable rebuild.
7. **Growth and review**: compaction, change highlighting with revert, prompt fine-tuning with its guide and test
   run, lorebook export, aliases merge and split.
8. **Evaluation**: fixtures, probes, the A/B recipe, and the numbers in the docs.

Slices 2 and 3 together already answer the first complaint for the new algorithm; slice 4 answers the second.

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
  of the first version (D3, D10).
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
