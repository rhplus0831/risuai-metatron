# HypaPlus-R v0.1.65: memory plugin analysis

Research input for a new metatron memory system. It explains what the
community plugin HypaPlus-R does and what metatron should borrow or avoid,
measured against two user pains:

- **P-verify**: as a chat grows, the user cannot tell whether summarization
  works correctly.
- **P-world**: HypaV3 serves persona + one bot well but is weak for
  world-setting bots with many characters.

## Sources and citation convention

- Primary: `save/hypaplus.js`, "HypaPlus-R v0.1.65", build
  `0.1.65+p102.20261031` (1.8 MB, 597 lines). Read as data, never run.
- Secondary: `/home/codex/refer/Dusk-Atelier/HypaPlus_1.0.9.g-local.12.js`,
  compared briefly in section 10.
- `hp:N` / `hp109:N` cite line N of a copy pretty-printed with the repo's
  Prettier 3.9.9 (`pnpm exec prettier --parser babel save/hypaplus.js`;
  26,883 and 6,511 lines). Regenerate the copies to follow a citation.
- **Inference** marks conclusions drawn from the code, not stated by it.
  Korean UI strings and prompts are quoted as written.

## 1. Overview

HypaPlus-R is a RisuAI plugin (API 3.0) that keeps long-term memory for
roleplay logs. It cuts the chat into chunks of about 30 messages, asks a
model to turn each chunk into structured `<event>`/`<facts>` records
("nodes"), removes summarized messages from the live prompt, and on each turn
injects a token-budgeted set of nodes picked by embedding similarity plus a
time or recency term.

Header (`save/hypaplus.js:1-25`): `//@api 3.0`, `//@allowed-ipc
provider-manager`, `//@version 0.1.65`, and 20 `//@arg` settings
(chunk_size, max_memory_tokens, auto_summarize, embedding_url / model /
provider / dimensions / api_key, time_decay_days, time_scoring_mode,
time_weight, similarity_weight, score_formula, time_bonus,
recency_half_life, include_user_messages, auto_summarize_threshold,
embedding_context_messages, recent_node_cache, recent_node_cache_count,
use_giga_trans_source).

Plugin API surface:

| Surface                                                         | Use                                                                                                       | Where                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `addRisuScriptHandler("input")`                                 | starts the background summary job on a 1:1 send with text                                                 | hp:26787, hp:14808-14832            |
| `addRisuScriptHandler("process")`                               | wraps every prompt message in a CBS `{{#if}}` that drops summarized messages; also starts the summary job | hp:26788-26840                      |
| `addRisuReplacer("beforeRequest")`                              | retrieval and injection, only for `type` `main`/`model`                                                   | hp:26842, hp:15092-15097            |
| `addRisuReplacer("afterRequest")`                               | bookkeeping only (UI invalidation, log flush)                                                             | hp:26843, hp:15328-15350            |
| `onUnload`                                                      | removes the four handlers                                                                                 | hp:26848-26868                      |
| `registerSetting` + `registerButton` (`location: "chat"`)       | opens the full-screen GUI                                                                                 | hp:26871-26881                      |
| `runLLMModel`                                                   | default summary route (`mode: "memory"`)                                                                  | hp:2853                             |
| `nativeFetch`                                                   | direct model and embedding requests                                                                       | hp:2716                             |
| `pluginStorage` (51 call sites)                                 | per-chat state, vector buckets, memos, settings, HMAC key                                                 | see section 2                       |
| `getLocalPluginStorage`                                         | device-local diagnostics, tokenizer files, translation cache                                              | hp:1141-1147, hp:7348-7351, hp:9164 |
| `getChatFromIndex`, `getCharacterFromIndex`, `getCurrent*Index` | reads the chat (all messages) on demand                                                                   | hp:4184-4237, hp:8803-8810          |
| `postPluginChannelMessage` / `addPluginChannelListener`         | provider-manager IPC; kept, but no route uses it now                                                      | hp:2553-2554, hp:2569-2596          |

The brief's hook names map to v3 names: HypaPlus uses `input` (editinput)
and `process` (editprocess) only. It registers no `output`/`display`
handler.

Coexistence with HypaV3 or SupaMemory: the code never reads or disables
host memory settings. The only mention is a comment listing "HypaV3 screen"
as a case without an input hook (hp:14743). It replaces host memory only in
effect: the `process` trim removes summarized messages and
`beforeRequest` injects its own block. **Inference**: if the user leaves
HypaV3 on, both systems run and the host also summarizes. A global on/off
switch (P42) makes the plugin pass requests through untouched (hp:916,
hp:15098-15107).

The code is heavily hardened: numbered work items (P8 through P102) cover
chat-switch races, storage failures, cross-chat injection, and host forks
(PocketRisu-Android). The GUI alone spans hp:15686-26776.

## 2. Memory data model

Storage is `risuai.pluginStorage`, keyed per character and chat:

- State: `hypaplus_state_v2:[charId,chatId]`, or the older
  `hypaplus_state_{charId}_{chatId}` when neither id contains `_`
  (hp:529-551). A one-time backup key `hypaplus_fix3_original_backup_v1`
  protects the pre-migration state (hp:539, hp:9998-10022).
- Vectors: a sidecar, `hypaplus_vec_v1:[charId,chatId,bucketId]`, buckets of
  about 256 KB (hp:1404-1430), `f32` by default with an `f16` option
  (hp:1507, hp:1465-1516). The comment explains the split: "Node vectors live
  in bucket keys, not in the state key read by external plugins" (hp:1405).
- Also: memos `hypaplus_memos_v1:[charId,chatId]` (hp:16224-16233); global
  settings, prompt and presets (hp:33-37); the HMAC key (hp:14846); and,
  device-local, the log `hypaplus_diag_v1` (hp:1147) and tokenizer files
  (hp:7377).

State object (hp:864-872, plus fields set elsewhere): `chunks`,
`lastNodeScores`, `lastSelectedNodeIds`, `chatRegex`,
`translationVisibleNodeIds`, `ownerCharId`/`ownerChatId`, `settingsOverride`
(per-chat overrides of scoring and budget, hp:3283-3312),
`lastVerifiedSummarizedIndex`, `p14Verdicts`, `p14Review`.

Chunk record (hp:12350-12362 for a new chunk, hp:12010-12018 for the
summarizer output):

- `id`: string, `max(existing)+1` (hp:8595-8603), so ids are reused after a
  delete (hp:12988 says so). Chunk `"0"` holds manual and memo nodes.
- `summarized` (`pending` | `done` | `failed`), `createdAt`, `messageCount`.
- Source references: `chatIds` (set only when `done`), `sourceChatIds` while
  pending or failed, and `messageAnchors` per source:
  `{sourceIndex, role, contentLength, contentHash}` where the hash is
  SHA-256 of the raw stored message (hp:3466-3474, hp:3458-3462).
- Exclusions: `p8ExcludedSourceMessages` (covered but not sent),
  `p14Filter` (screening verdicts), `p15HiddenExcluded` (host-hidden).
- Integrity: `p8SourceIntegrity` with status `stale` or `unverified`,
  reasons and a detection time (hp:4932-4944); `p41SourceDetached`.
- `p97Key` (UUID recency anchor, hp:12990-12995); `memo` (user note,
  searchable, never embedded or injected, hp:18420-18421).

Node record (parser at hp:8741-8801):

- `id` (numeric string, `max+1` across all chunks, hp:8389-8397), `type`
  (`event` | `facts`), `time` (normalized `YYYY-MM-DD HH:mm`, optionally a
  range with `→`), `location` (events only), `characters` (array split on
  commas), `content`, `dialogues` (`[{speaker, text}]`, events only),
  `createdAt` (wall clock).
- Added later: `favorite`, `embedding`, `embeddingSourceHash`,
  `embeddingConfigHash`, `translation` (content, dialogues, target language,
  source hash, model), `p97Anchor` (manual/memo nodes), `memoId`.
- Language: the default prompt forces Korean field values (hp:613). There is
  no language field; node translation is a separate display feature with its
  own prompt (hp:45-50).
- A `<facts>` block without a time gets the **real** current time
  (`nowTimeString()`, hp:8792, hp:8638-8642), not a story time.

Size growth: one chunk per `chunk_size` counted messages, with no cap on
nodes per chunk ("Record as many necessary events and facts as possible. It
doesn't matter how many you record.", hp:614). Nothing prunes or compacts
nodes automatically; the only reduction is the manual node merge, which
concatenates contents with `\n---\n` (hp:8557-8593). **Inference**: storage
and the candidate set grow linearly with chat length; vectors dominate the
bytes (one vector per node).

## 3. Write path

Trigger. Summaries never block a send (P16, hp:14423-14430). The `input`
hook and the first `process` call of a request each try to start one
background job (hp:14808-14827, hp:26825-26830); `p16KickSummary` refuses a
second job and schedules one rerun (hp:14562-14596). The job
(`runAutoSummarizationCatchUp`, hp:14337-14420) loops chunk by chunk and
stops when:

```js
// hp:14378
if (eligibleCount < autoSummarizeThreshold || eligibleSummarizable < chunkSize) {
```

`eligible` is the pending messages minus the newest one and capped at the
newest message that existed when the job started (hp:14369-14376), so the
message being answered, rerolled or streamed is never summarized. Defaults:
threshold 40 pending, chunk 30 counted messages (hp:51-52). The `//@arg`
text says "when unsummarized messages exceed token limit"
(`save/hypaplus.js:7`), but the code counts messages, not tokens.

Manual triggers in the GUI: "자동 요약" (run the same catch-up), "수동 요약"
(a dialog that previews the planned chunks with a checkbox per message,
hp:20782-20830), re-summarize one chunk (`reSummarizeChunkImpl`,
hp:12465), retry failed chunks, and "전체 재요약" with configurable
concurrency (hp:22908, hp:23032).

Chunking (`runSummarization`, hp:12041-12436):

- Start after the last message of any `done` chunk; prepend the greeting
  (chat index −1) for the first chunk unless excluded (hp:12087-12100).
- A window holds `take` messages that "would be SENT": user turns count only
  when `include_user_messages` is on, host-hidden messages count only when
  the P15 toggle is off (hp:5501-5506, hp:12111-12127). Uncounted user turns
  ride along but are recorded as excluded sources.
- P14 screening: user-editable refusal and format lists check each AI reply;
  a hit maps to include, exclude, or halt, optionally asking the user per
  turn (hp:5356-5360, hp:5478-5496, hp:12139-12195). If a reroll, edit or
  delete changed the window while that dialog was open, the summary is
  deferred (hp:12177-12193).
- If a failed chunk covers the same sources, it is retried instead of a new
  chunk being created (hp:12265-12322).

Source text. Each message's `content` is read with GigaTrans handling
(hp:4256): with `use_giga_trans_source` on (default), only the text inside
`<GigaTrans>` blocks is kept; off, those blocks are stripped (hp:4017-4034).
An optional Yumi translation source reads the original from the chat's
script state (hp:4038). The user's "summary" regex rules run on the batch
(hp:12339). Then:

```js
// hp:11933-11934
const messagesText = messages.map((m) => m.content).join("\n\n");
const parsedPrompt = buildPromptMessages(summaryPrompt, messagesText);
```

No role, speaker name, message index, persona or character card goes to the
summarizer; nor do earlier nodes. The model sees only bare message bodies
separated by blank lines.

Prompt. `DEFAULT_SUMMARY_PROMPT` (hp:608-722) is a ChatML template parsed
into messages (hp:11731-11804). Key instructions:

- "capture ONLY core plot progressions, major character turning points,
  critical relationship/emotion shifts, and crucial worldbuilding/facts. You
  must IGNORE trivial daily activities" (hp:612)
- "ALL extracted field values inside the XML tags MUST be generated in
  natural, precise Korean" (hp:613); "Rating: NC-21+" (hp:617)
- Event schema `시간 / 장소 / 인물 / 내용 / --- 대사 ---` (hp:630-639);
  "Summarize at the MACRO level" and a new block "ONLY when a major plot
  point occurs" (hp:643-645); "ABSOLUTELY NO PRONOUNS" (hp:652)
- "Extract MAX 5 plot-critical dialogues per event", verbatim (hp:655-658)
- Facts schema `인물` = "character(s) who learned the fact" (hp:668-672);
  categories: secrets and documents, plot items, relationship shifts,
  permanent status changes, binding promises (hp:678-684); "Record only
  facts that were newly learned by a character" (hp:687); no repeats of the
  events block (hp:693)
- A prefilled assistant turn and "Ok. Let's start." (hp:713-722); the direct
  route drops a trailing assistant prefill for models that reject it
  (hp:2861-2867).

Model. `summaryConnection` defaults to route `risu`, mode `memory`
(hp:2539-2541), which calls
`risuai.runLLMModel({ messages, mode: c.risuMode, allowPlugins: true })`
(hp:2853), the host's memory/auxiliary model. The `direct` route calls
OpenAI-compatible, Gemini, Vertex AI or Anthropic endpoints through
`nativeFetch` with an output cap of 20,000 tokens by default
(hp:2506-2513, hp:2851-2905). The provider-manager IPC transport is still in
the file but "No connection route uses it now; the PM route was removed"
(hp:2553-2554).

Commit protocol:

1. A `pending` chunk with sources and anchors is saved before the model call
   (hp:12345-12362).
2. 300 s timeout including streaming (hp:11954); output arriving after the
   timeout is never committed (hp:11966-11968, hp:12000-12003). The comment
   admits the provider request may keep running "without host AbortSignal
   support" (hp:11986-11987).
3. Response rules run, then `<event>`/`<facts>` parsing; a block opening
   inside a block is rejected as leaked reasoning (hp:8692-8698); a plain
   untagged answer is kept as one event only when the user opted in
   (hp:11931, hp:8717-8738).
4. Success: nodes get ids, `chatIds` replace `sourceChatIds`, status `done`,
   save, then background pre-embedding of the new nodes
   (hp:12370-12392, hp:12424).
5. Failure: status `failed`, saved, retried later on the same sources
   (hp:12394-12401). The auto job retries retryable failures (429, 5xx,
   network, timeout, empty) after 5 s and 20 s (hp:14431-14437); a format
   failure is not repeated within the same send (hp:14389).

Cancellation: a chat switch defers the run (`SUMMARY_CHAT_CHANGED`); a GUI
run's "멈추기" stops before the next chunk (hp:15380).

Memos (P76/P78) are a second write path. The user selects nodes and/or
messages and writes a request; a model writes a plain-text memo under rules
such as "When the source shows an actual change in state or an explicit
correction, write "전엔 A, 지금 B"" and, for unsettled conflicts, "keep both and
group them under 확인 필요" (hp:844, prompt hp:828-858). A memo can then be
converted into nodes by a second prompt ("Cover every detail once", hp:786,
prompt hp:770-819); those nodes go to chunk `"0"` with a recency anchor
(hp:16358-16420). Long sources are split into parts and merged
(hp:15944-15992).

## 4. Read and injection path

Prompt trim. On the first `process` call of a request the plugin fixes a
boundary (the "prompt view") and wraps each message:

```js
// hp:26838
return `{{#if {{greater_equal::{{chat_index}}::${view.threshold}}}}}\n${text}\n{{/if}}`;
```

The threshold is the last summarized array index converted to the host's
`chat_index` numbering, which skips hidden messages (hp:4158-4167,
hp:14647-14659). Only `done` chunks move the boundary (hp:9024-9052).
**Inference**: the host then drops the emptied messages, so the live context
is memory plus the most recent unsummarized messages (about 10 to 40 with
defaults, more after failures).

Query. `buildEmbeddingQuery` takes the last `embedding_context_messages`
(default 5, hp:1001) chat messages, newest always included
(hp:11590-11595), applies "query" regex rules (hp:11597-11598), drops the
oldest whole messages to fit Voyage or Gemini input limits
(hp:11601-11688), and joins them with `\n` (hp:11690). If the query is empty,
the last user message from the request is used (hp:14031). Only nodes of
chunks that were `done` when the prompt view opened are candidates
(hp:14722-14734).

Scoring, legacy formula (default `score_formula`, hp:1988):

```js
// hp:12945 (time score, relative to the newest node's story time, hp:14308)
return 1.0 / Math.sqrt(1.0 + diffDays / getEffectiveTimeDecayDays());
// hp:13530-13535
const similarityScore = similarityScores.get(node.id) ?? 0.5;
const timeFactor = effectiveMode === "none" ? 1 : Math.pow(1.0 - timeScore, getEffectiveTimeWeight());
const combinedScore = 1.0 - timeFactor * Math.pow(1.0 - similarityScore, getEffectiveSimilarityWeight());
```

The time score uses the LLM-written in-story `time` of each node against
the latest node's time; unparseable times score 0.5 (hp:12929-12946).
Nodes with `combined < 0.05` are skipped (hp:13587).

Scoring, similarity formula (P96/P97, opt-in):

```js
// hp:12969
combined: timed ? (u + beta * time) / (1 + beta) : u; // u = clamp(similarity, 0, 1)
// hp:13005  recency r = 2^(-k/H), k = conversation chunks after the node's chunk
const r = (k) => Math.pow(2, -k / h);
```

Defaults β = 0.05, H = 2 chunks (hp:1989-1993). The comment states the
intent: "Exp's time term is chunk progress order, not story time"
(hp:1991). Nodes under similarity 0.05 are dropped; nodes without a vector
are appended newest-first after the ranked ones (hp:12949-12988).

Budget. `max_memory_tokens` (default 10,000, hp:53) counts real tokens of a
chosen model family (estimate by default, optional exact WASM tokenizers for
Gemini/GPT/DeepSeek, hp:7345-7353). Selection (hp:13565-13601):

1. Favorite nodes first, chronologically, each if it fits.
2. Then by score; a node that does not fit is skipped and smaller ones may
   still enter (greedy, +1 token per joining newline).
3. The chosen set is re-sorted chronologically (`compareNodesByTime`).

If the final signed text still exceeds the budget, the lowest-priority
non-favorite is dropped without a second retrieval (hp:15226-15247).

Recent node cache (off by default, hp:1995): the N newest nodes by story
time (hp:9001-9008) are admitted newest-first within the same budget,
excluded from retrieval, re-sorted chronologically and placed in
`[HypaPlus.cached]` (hp:15187-15210).

Placement and format. The user's preset holds `[HypaPlus.memory]` and
`[HypaPlus.cached]` placeholders. Without a memory placeholder the block is
appended to the first system message, or a new system message is inserted
at the front (hp:15032-15040, hp:15005-15010). Each node renders through a
template; defaults:

```text
[기억: [[time]] | [[location]] | [[characters]]]   (hp:62)
[[content]]
[[dialogues]]
[사실: [[time]] | [[characters]]]                  (hp:63)
[[content]]
```

Every injected span carries an HMAC-SHA-256 suffix
`[HP29:<scope>:<mode>:<len36>:<tag>]` (hp:14913-14918) so that a re-run of
`beforeRequest` can find and restore its own earlier injection
(hp:14921-14970) and refuse unverifiable spans (hp:15144-15147). The suffix
reaches the main model; the plan reserves 67 tokens per filled slot
(hp:15010).

Guards: retrieval has a 30 s cap, after which the turn uses a
similarity-free choice and the late result only stores vectors
(hp:13696-13702, hp:13985-14066); a request whose messages belong to
another chat gets no memory (hp:15067-15090, hp:15153-15159).

Prompt-cache friendliness:

- The trim boundary moves only when a chunk completes (about every 30
  counted messages), so the history prefix is stable between summaries.
- The signature follows the body "for prefix reuse" (hp:14844).
- **Inference**: the memory block changes most turns because retrieval
  depends on the latest 5 messages, so any cache prefix ends at the
  `[HypaPlus.memory]` slot. `[HypaPlus.cached]` changes only when a new
  chunk lands; this analysis found no guidance on ordering the two slots.

## 5. Embeddings

- Providers: `openai` (any OpenAI-compatible URL; default), `voyageai`,
  `voyage-context` (contextualized chunk embeddings), `cohere` (official or
  Azure Foundry), `gemini` (`save/hypaplus.js:9-12`, hp:6095-6116). Query
  and document input types are sent where the provider supports them
  (hp:6489-6538).
- Node text: default mode `legacy` joins content, location, characters and
  dialogue text with spaces (hp:1983, hp:5886-5893); the other mode drops
  characters. User exclusion regexes apply to content first (hp:5887).
- Dimensions: `embedding_dimensions` is passed through (0 = model default);
  a cached vector is valid only if its length equals the query vector's
  length (hp:13327).
- Cache: vectors live on the node and persist in the sidecar. Validity needs
  `embeddingSourceHash` (hash of the node text) and `embeddingConfigHash`
  (provider, endpoint, model, dimensions, text mode) to match
  (hp:13327-13336, hp:5910-5941). Editing a node or changing the model
  re-embeds only what changed.
- Batching: 80,000 heuristic tokens per batch (hp:54), at most 512 vectors
  per request (hp:7235), Voyage per-input and per-request limits
  (hp:8033); oversize nodes are reported, never truncated (hp:13405-13418).
  Voyage-context groups re-embed together when one sibling changes
  (hp:13362-13364).
- Pre-embedding: new nodes are embedded right after a summary, so the next
  turn only embeds the query (hp:14068-14200). A query prefetch at `input`
  (P58) can start the query embedding early; the code default is on
  (hp:2005) while the section comment says "off by default" (hp:14735).
- Retries: 2 s and 6 s, a 30 s retry budget per retrieval, 90 s per request
  (hp:6174-6179).
- Failure fallback: no query vector means every node gets the neutral 0.5
  (legacy) or the newest-first fill (similarity formula); each node records
  an "embedding gap" reason shown in its card (hp:13280-13284,
  hp:18659-18668). With no endpoint configured, selection is time-only.

## 6. Verification and inspection UX

What the user can see or do (GUI opened from settings or the chat button):

- **Pending count and list**: "남은 메시지 N개" with each unsummarized
  message (hp:18481-18505).
- **Last-request view**: a filter shows only the nodes requested in the last
  turn plus cached nodes (`lastSelectedNodeIds`, hp:18440-18460). Each card
  shows similarity, time score, total and a token estimate
  (hp:18659-18668). Only the last request is kept (hp:1937-1952).
- **Per-turn log lines** (Logs tab, up to 2,000 entries, area and level
  filters, export; hp:1018, hp:26477-26520): where memory went ("기억 N개 →
  [HypaPlus.memory] 자리", hp:15299-15314), tokens against budget
  (hp:7931-7945), "기억 N개 중 M개 넣음" (hp:13976-13983), step timings
  (hp:13772-13836), dispatch time and summary usage (hp:15316, hp:2894).
- **Query preview**: the exact query text the next retrieval would embed,
  with message count and token estimate (hp:22175-22209).
- **Node tools**: search, advanced search over content, people, place,
  dialogue, speaker, time, chunk memo, translation, chunk range, type and
  undated (hp:18782-18800); sort; favorites; edit; manual node; merge;
  translate; delete; backup/restore; clear all (hp:18514-18518). The wide
  layout shows a node's sibling nodes and its source messages
  (hp:18251-18265).
- **Chunk tools**: a calendar by story date (hp:19172); cards with badges
  for pending, failed, "원문 변경 감지" (stale), "원문 검증 필요"
  (unverified) and detached (hp:19940-19965); a source viewer with three
  views (original, summarizer input after rules, stored raw)
  (hp:21027-21040); re-summarize; retry failed; per-chunk memo; lorebook
  export by date (hp:11281).
- **Link health notice**: summary paused, or "원문 변경 청크 N개 · 확인 필요 N개"
  (hp:16849-16866).
- **Progress**: summary progress phases and a floating activity button
  (P73) (hp:925-963, hp:21981).

What is missing:

- No view of the assembled prompt or of the memory text exactly as sent;
  the user reconstructs it from node ids and log lines.
- No history of selections per turn or per message; the next request
  overwrites the last one.
- No check of summary quality against the source: no coverage measure
  (which messages produced no node), no faithfulness check, no diff between
  an old and a re-summarized chunk.
- No duplicate or contradiction detection across chunks.
- No per-character or entity view (section 7).

## 7. Multi-character handling

There is no entity model. Multi-character support is limited to:

- The `인물` field on every node (hp:633, hp:669), parsed into
  `characters[]` (hp:8750-8756), rendered in the injected header, included
  in legacy embedding text (hp:5891-5893), and searchable in advanced search
  (hp:18786).
- For facts, `인물` means "character(s) who learned the fact" (hp:669), a
  knowledge-scope signal. The memo-to-node prompt sharpens it: "인물 lists
  only the characters the memo states as knowing the fact, not its subject"
  (hp:792).
- Prompt rules: no pronouns, explicit names and places (hp:652); speaker
  names on dialogue lines (hp:635-637).
- The memo request prompt asks the model to distinguish "what each character
  knows from what they do not know" and to attribute claims (hp:838-839).

Gaps:

- Characters never filter or boost retrieval; ranking uses only similarity
  and time.
- The summarizer gets no speaker labels (hp:11933), no character list and
  no persona. In a group chat or a narrator-driven world bot, attribution
  depends on the prose naming the speakers. **Inference**: misattribution
  risk grows with cast size.
- No relationship graph, no per-character state, no scene or location
  state, no tracking of who is present.
- Group chats get the `process` path only (hp:14425, hp:14807); there is no
  group-specific logic.

## 8. Consistency under edits

- **Reroll and continue**: the newest message is never summarized during a
  generation, and the auto job caps every chunk at the message that was
  newest when it started (hp:14354-14376). The prompt boundary is fixed per
  request (hp:14627-14659), so a reroll keeps the answered user turn in the
  live context.
- **Edit of a summarized message**: the audit compares each anchor's SHA-256
  with the live message and marks the chunk `stale` with reason
  `content-changed` (hp:4758-4835, hp:4932). Its nodes stay injected; a
  notice and badge appear; re-summarizing is manual.
- **Deletion**: `missing-or-duplicate-id` makes the chunk stale. A cleanup
  dialog offers per chunk: delete (memory too), detach (keep memory, leave
  link health), re-summarize from the remaining sources, or keep
  (hp:4442-4516, hp:22377, hp:22483).
- **Insertion and moves**: `inserted-message`, `message-moved` and
  `excluded-source-count-changed` reasons; an approved re-summary may absorb
  inserted messages (hp:4884-4920, hp:12612-12636).
- **Id rewrites**: when message ids change, links are rebuilt from content
  anchors; if that is unsafe, auto summary stops and the last verified
  boundary is kept for trimming (hp:9083-9111, hp:16852-16860).
- **Copies and branches** (P32): a new empty chat finds its source by branch
  marker, shared message ids, or the "(Copy)" name suffix, maps message ids
  (same id, or same position with identical role and text), and inherits
  only chunks whose every source maps, so a branch never inherits memories
  from after its branch point; manual chunk `"0"` is always copied
  (hp:9281-9330). The comment notes ownership is "Not a complete ownership
  proof for RisuAI-style copies" (hp:15050).
- **Stale nodes**: nothing re-aligns automatically; old nodes stay injected
  until the user acts.

## 9. Costs and limits

Per turn (defaults):

- Model calls: none on most turns. One summary call per 30 counted messages
  (about 15 exchanges with user turns counted), in the background. Output cap
  20,000 tokens on the direct route (hp:2513).
- Embedding calls: one query embedding (possibly prefetched); node
  embeddings only for new or changed nodes, normally done right after a
  summary.
- Prompt tokens: up to 10,000 memory tokens (hp:53) plus about 67 tokens per
  signed slot (hp:15010). The live chat shrinks to unsummarized messages,
  which offsets part of this.
- Latency: retrieval capped at 30 s (hp:13702); summary timeout 300 s
  (hp:11954); embedding request timeout 90 s (hp:6179).
- Local work: a chat read and SHA-256 audit per request burst, token counts
  per candidate node, optional WASM tokenizer downloads.

Limits and caveats visible in code (no `TODO`/`FIXME` markers exist):

- Voyage token checks are heuristic: "this is not an exact tokenizer"
  (hp:59); one query message over the Gemini limit is still sent
  (hp:11680).
- Timed-out provider requests keep running (hp:11986-11987).
- Chunk ids are reused (hp:12988); P97 uses separate keys for that reason.
- The `auto_summarize` arg text says "token limit" but the trigger counts
  messages (section 3).
- The P58 default and its comment disagree (section 5).
- Facts without a time get the wall-clock time (hp:8792), which skews the
  legacy story-time decay.

## 10. Comparison with HypaPlus 1.0.9.g-local.12

The Dusk-Atelier file is "a local maintenance build ... Based on the user's
installed 1.0.9.f. Not an upstream release" (hp109:22-24). Differences that
matter:

| Area            | 1.0.9.g-local.12                                                                                                           | HypaPlus-R 0.1.65                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Summary timing  | blocking: runs inside `beforeRequest` and `afterRequest` until pending < threshold (hp109:2333-2361, called at hp109:2449) | background job, never blocks the send (P16)                |
| Injection modes | `selected` or `all` ("전체 기억 주입": every node, no retrieval) (hp109:229, hp109:2285-2287, hp109:3212-3213)             | selection only                                             |
| Marker          | `<hypaplus_full_memory>` tags (hp109:71-72, hp109:6296-6334)                                                               | HMAC-signed `[HP29:…]` suffixes                            |
| Embeddings      | one OpenAI-compatible endpoint; empty URL = no similarity (`HypaPlus_1.0.9.g-local.12.js:8-9`)                             | five providers, sidecar vectors, pre-embedding             |
| Default budget  | 20,000 tokens (hp109:68)                                                                                                   | 10,000 tokens                                              |
| Source tracking | `chatIds` / `msgIndices`, no content anchors                                                                               | anchors, integrity audit, detach/cleanup, copy inheritance |
| Storage key     | `hypaplus_state_{char}_{chat}` (hp109:78-80)                                                                               | v2 tuple key, legacy mirror                                |
| Extras          | none of the memo, translation, lorebook export, screening or log tooling                                                   | all of these                                               |

The summary prompt, `<event>`/`<facts>` schema, CBS trim, placeholders and
legacy scoring are shared (hp109:82-, hp109:6482, hp109:2050-2053).
The "all" mode is worth noting: it trades tokens for zero retrieval error,
which suits short-to-medium chats.

## 11. What metatron should adopt, adapt, or avoid

Context: metatron's HypaV3 defaults to 6 chats per summary with 40 % recent
and 40 % similar memory ratios (`shared/hypaV3Presets.ts:33-35`), runs in the
server-side generation job, and is edited through `HypaV3Modal`. Ranked by
value to the two pains:

1. **Adopt: source provenance with content anchors and an integrity audit**
   (P-verify): ids plus SHA-256 anchors, stale/unverified reasons, and
   repair choices make "is memory still true to the chat" answerable.
2. **Adopt and extend: a per-turn injection record** (P-verify): HypaPlus
   keeps only the last selection plus log lines; store per generated message
   the injected memories, scores, query and budget.
3. **Adopt: coverage surfaces** (P-verify): unsummarized count and list, a
   summarize-plan preview with per-message exclusion, and a source viewer
   (raw, summarizer input, stored).
4. **Adopt: pending → done/failed states saved before the model call**,
   retries on the same sources, no late commits (P-verify): failures stay
   visible instead of leaving silent holes.
5. **Adapt: structured event/facts records** (P-world): time, place,
   characters, verbatim key lines, no pronouns, facts scoped to knowers; add
   the speaker labels, indices and cast list HypaPlus omits.
6. **Adapt: memo consolidation into entity/state sheets** (P-world): the
   "전엔 A, 지금 B" and "확인 필요" rules suit sheets updated in place; HypaPlus
   offers this only as a manual flow.
7. **Adapt: use `characters` in retrieval** (P-world): boost or filter by the
   cast in recent messages; HypaPlus only embeds the names.
8. **Adopt: never summarize the message being answered or rerolled**, with a
   per-request boundary (P-verify).
9. **Adopt: copy/branch inheritance by message-id mapping**, only chunks
   wholly before the branch point.
10. **Adapt: chunk-order recency (P97) over story-time decay**: the legacy
    decay trusts model-written dates and wall-clock fallbacks.
11. **Adapt: pinned memories and a stable recent block placed before the
    per-turn retrieved block**, for prompt-cache reuse.
12. **Adapt: reply screening before summarization**, so refusals and broken
    replies do not become memory.
13. **Avoid: a summarizer blind to existing memory** (P-world, P-verify):
    duplicates and contradictions are left to the user.
14. **Avoid: model-visible bookkeeping markers**. **Inference**: the HMAC
    suffixes exist so a plugin can recognize its injections in host-built
    messages; metatron builds prompts on the server and can track them out
    of band.
15. **Avoid: a hard-coded output language** in the default prompt.
16. **Avoid: unbounded node growth with a greedy budget fill**; plan
    consolidation (merge, supersede, archive).
17. **Consider: an "inject everything" mode** (1.0.9.g) for short chats or
    large contexts; it removes retrieval as a failure source while the user
    checks summaries.
