# What RisuBard adds on top of PocketRisu

This report covers the repository at `/home/codex/RisuBard`:
- Origin: `rpaddict/RisuBard`
- `package.json` version: 0.9.72
- HEAD: `6cf7d89`, dated 2026-10-18

All `path:line` pointers are relative to that root. I checked each one with `rg -n` or `sed -n` on 2026-10-20.

## How I separated RisuBard's work from PocketRisu's

PocketRisu's commits are not in RisuBard's history. The root commit is `4c25786` ("feat: publish initial RisuBard source", 2026-08-17, 1,248 files). It is a squashed snapshot that already contains 105 `risubard*` files, so git cannot show where PocketRisu ends and RisuBard begins.

I used three other sources instead:
- the 0.8.4 → 0.9.72 patchnotes in `patchnote/`;
- the roughly 110 design plans in `docs/superpowers/plans/`;
- a file-list comparison against a current PocketRisu checkout at `/home/codex/PocketRisu` (v1.15.0, `f71e1ccc`). This found 939 tracked files under `src/` and `server/` that exist only in RisuBard.

PocketRisu has kept developing since the fork, so some features exist on both sides. Where that applies, the text says so. Some pieces are known to come from PocketRisu or upstream RisuAI, not RisuBard:
- `server/node/model-jobs.cjs`, `request-logs.cjs` and `session-lock.cjs`. RisuBard extended them; for example, it added request purposes and an injection manifest to the request log.
- the help-key checker;
- chat-bound personas (`Chat.bindedPersona`);
- model-preset binding;
- `readInlay` and `parseRisuChat` in the plugin API.

---

## 1. Overview

RisuBard is a self-hosted RisuAI derivative that calls itself a "Next-Gen LLM Storytelling Frontend". Its central claim is that a roleplay chat can keep growing while the size of each prompt stays fixed. It does this by splitting the work three ways:

1. **The original chat is evidence.** Messages are never deleted to save tokens. Every message keeps a stable `chatId`, and memory pages point back to the message IDs they came from.
2. **BardWiki holds long-lived story state.** Each chat gets a folder of Obsidian-compatible Markdown files.
   - *Event* pages record each confirmed turn.
   - *Canonical* pages (also called canon pages in this report) cover characters, locations, factions, creatures, items, concepts and the current scene.
   - An auxiliary LLM writes these after a turn is *confirmed*. Its output is schema-bound JSON. The application serializes that JSON to Markdown and applies changes as section patches that are checked against a content hash.
3. **Each request is compiled under explicit token limits.**
   - Recent history is a window of the last N assistant turns.
   - Wiki pages marked "always" are required input; if they cannot be loaded, generation fails rather than proceeding without them.
   - Retrieved wiki pages and excerpts from original messages are optional. They share a budget made of four limits: target, events, per-source and maximum.
   - Every response records a trace of what was included, without any message bodies.

### How it differs architecturally from PocketRisu

**Storage**
- PocketRisu stores data in a SQLite/chunk-store `database.bin` with WAL maintenance. RisuBard replaced this with a *file-native* data root:
  - per-entity JSON and JSONL files plus content-addressed blobs;
  - a `.sha256` sidecar on every file;
  - writes that go to a temp file, fsync, then rename;
  - a multi-file journal that is replayed forward after a crash;
  - one `.bak` (previous version) per file, and a `trash/` folder;
  - a lock on the whole data directory;
  - polling for external edits, with a review dialog.
- The browser client still saves the monolithic `Database` object through `/api/patch` and `/api/write`. The server applies those writes back onto the canonical files.
- `database.bin` survives only as a lazily rebuilt compatibility *projection*.
- Commits made right after the snapshot remove PocketRisu's chunk store and WAL code: `a8a37b5`, `e42d829` and `b152f43`, all on 2026-08-20.

**Memory**
- HypaMemory and SupaMemory are bypassed for chat responses (`src/ts/process/index.svelte.ts:2515`). BardWiki takes their place.
- Plugins that read `hypaV3Data`, `hypaV2Data` or `supaMemoryData` receive a virtual projection of the BardWiki context instead.

**Request assembly**
- The inherited `sendChat` pipeline keeps its structure. RisuBard splices in a retrieved-memory block (attached to the description slot) and a required-wiki system message (placed at the top).
- The chat-history trimming is replaced by an assistant-turn window.
- Upstream lorebook activation stays, with three additions:
  - an optional retrieval lorebook called "Grimoire";
  - new key-matching modes;
  - per-entry enable flags.
- A small, UI-independent package, `packages/risubard-core`, holds the deterministic context compiler and the memory-delta contracts that the server uses.

**UI**
- New docked workspaces: the BardWiki dock, a save/load dialog, the Character Vault, a lorebook and Grimoire workspace, BardPainter, and the Prompt and Character Assistants.
- A theme-token contract that is enforced by a test.
- A restructured settings navigation.

### Rough size of RisuBard-only code (non-test)

| Area | Lines |
| --- | --- |
| `src/ts/risubard/` | about 16k |
| `server/node/risubard-*` | about 13.6k |
| New storage `.cjs` modules | about 6.9k, plus a 7,681-line `server.cjs` |
| BardPainter | about 8.7k |
| Lorebook and Grimoire | about 8.3k |
| `src/lib/Others/RisuBard*.svelte` | about 12.2k |

The repository has 594 test files in total.

There is also a private edition called "Novelist" (a manuscript mode, kept in a separate `RisuBard-private` repository). The public repository is protected from it by a boundary check; see §2.15.

---

## 2. Feature inventory

**How to read this section**
- **Size:** S means under 500 lines of code, M means 500 to 3,000, L means over 3,000. Tests are not counted.
- **Coupling:** how tightly the feature depends on RisuBard's file-native storage, its server, or BardWiki.

### 2.1 Memory: BardWiki

#### 2.1.1 Wiki files and document model

**What it does for the user.** Every chat has its own folder of Markdown files that you can read, edit and open in Obsidian. A file tree shows them grouped by type: characters, locations, factions, creatures, items, concepts, the current scene, other notes and events. Next to the tree are an editor with a Markdown preview, body search, health diagnostics (broken `[[links]]` and pages with no links), and a "copy to lorebook" button. The Markdown files are the only source of truth. Indexes, vectors and diagnostics can all be rebuilt from them (`docs/ko/memory-wiki.md`, last paragraph).

**How it works**

- **Location.** `<savePath>/risubard/characters/id-<b64(charId)>/chats/id-<b64(chatId)>/wiki/` (`server/node/risubard-memory-workspace.ts:208`, `server/node/risubard-markdown-wiki.ts:637`). The folder contains:
  - `index.md`
  - `current-scene.md`
  - `characters/`, `locations/`, `factions/`, `creatures/`, `items/`, `concepts/`, `notes/`, each holding `<readable title>-<suffix>.md`
  - `events/turn-<sha256(sourceMessageIds)[:24]>.md`
  - `.risubard-history/<docId>/<ts>.md`: a copy of every replaced version
  - `.risubard-trash/`
  - `.risubard-review/`
  - `.risubard-recovery/reboot-batch/`
- **Frontmatter.** The program writes it, never the model (`serializeDocument`, `risubard-markdown-wiki.ts:361`). Fields:
  - `id`, `type`, `status` (active, superseded or retracted), `superseded_by`
  - `created`, `updated`
  - `authoring` (automatic, ai-assisted or manual), `review_status`
  - `context` (always, auto or never), `aliases[]`
  - `source_messages[]` (the last 96), `links[]`
  - `retrieval_metadata`: up to 24 keywords and a `storyTime` value
- **Content hash and saves.** Each document's `contentHash` is the SHA-256 of its file bytes. A manual save, AI-assisted save or plugin save that carries `expectedContentHash` is rejected if the file has changed since it was read.
- **Renames and type changes.** Renaming keeps the internal ID and rewrites `[[links]]` that point to the page. Changing a page's type is refused.
- **Deleting.** Deleting a canonical page moves it to `.risubard-trash/`. Event pages are never moved to trash. Deleting one sets `status: retracted`, after a confirmation.
- **Writes and locking.** Writes are atomic (temp file, then rename) but are **not fsynced** (`writeAtomically`, `risubard-markdown-wiki.ts:617`). A reader/writer queue per (character, chat) orders operations. Operations that touch several chats take all the relevant locks in sorted order (`server/node/risubard-memory-runtime.cjs:58`).
- **Routes.** All routes are POST requests under `/api/risubard/memory/*`:

  | Group | Paths |
  | --- | --- |
  | Reading | `view`, `catalog`, `wiki/documents`, `wiki/search`, `wiki/story`, `inquiry`, `embedding-catalog` |
  | Saving | `wiki/save`, `wiki/document/save`, `wiki/document/manual-save` |
  | Context policy | `context-mode` |
  | Removal | `trash`, `event/retract`, `event/retract-sources` |
  | Bulk edit | `wiki/replace` |
  | Reboot | `reboot/*` |
  | Fork and transfer | `fork`, `fork/complete`, `inherit`, `import` |
  | Save slots | `save-slot/*` |

  Request bodies are checked for exact keys and capped at 512 KB (`server/node/risubard-memory-routes.cjs`).
- **Workspace performance (0.9.64).** The server keeps a per-chat catalog and rereads only the documents that changed. When the tab opens it receives only the table of contents (6.5 MB down to 1.4 MB at 3,000 turns), and document bodies load on demand. Folders show 100 documents at a time. The server reads the wiki ahead of time when a chat opens.

**Decisions and limits**
- The model never chooses IDs, paths or frontmatter. That rule is in the writer skill.
- The 12,000-character body limit was removed on purpose in 0.9.40 and 0.9.52. The design note is `docs/architecture/2026-09-29-bardwiki-long-chat-checkpoint.md`: "do not silently cut a source and then replace the whole document".
- `.bak`-style history is kept under `.risubard-history` and is never pruned.
- The `.risubard-review` accept/revert path exists (`risubard-markdown-wiki.ts:1652`), but automatic saves are stored as `reviewStatus: 'reviewed'` (`server/node/risubard-memory-analysis.ts:2039`). The "unreviewed" flow described in the README is therefore never reached.

**Size and coupling.** L: about 11.7k lines of server code and about 5.8k of client code, plus `RisuBardMemoryWiki.svelte` (2,349 lines). The wiki does **not** use RisuBard's `file-store.cjs` or `user-data-repository.cjs`; it writes with plain `node:fs` under `savePath`. It could move to another Node server with little change. What it does need is stable per-message IDs, and a server that is allowed to keep a folder per chat.

#### 2.1.2 Confirmation-driven automatic writing

**What it does for the user.** After each exchange, an event page records what happened, and the relevant canonical pages are created or updated. A reply only counts once it is *confirmed*. That happens when the next generation succeeds, or when the user chooses "confirm" from the message menu. Rerolls and swipe candidates are never recorded.

**How it works**

- **Trigger.** `projectConfirmedMemoryTurn` (`src/ts/process/index.svelte.ts:1396`) picks the last assistant reply before the newest user message. After a successful generation, `confirmProjectedNarrativeTurn` runs in the background (`index.svelte.ts:3735`).
- **Where the code runs.** The runner is defined in server code (`createMemoryAnalysisRunner`, `server/node/risubard-memory-analysis.ts:1024`) but is executed in the browser through `memoryAnalysisClient.ts`. Model calls therefore go out from the client. The server routes only persist the results.
- **Call 1: analysis** (`bardwiki-analysis`, temperature 0, JSON schema `memoryWriterDraftSchema` at `server/node/risubard-memory-writer.ts:22`). It returns:
  - `title` and `keywords` (up to 24)
  - `temporalHint`
  - `establishedEvents` (up to 12)
  - `stateChanges{subject,before,after}`
  - `characterKnowledge{character,fact,stance: knows|believes}`
  - `persistentFacts`, `openContinuity`
  - `canonicalUpdateCandidates{type,title,aliases,reason,action:create|update,targetDocumentId,confidence}`

  Each string is capped at 500 characters. When the full canonical pages fit the budget, the same call also returns `canonicalPatches`, which saves a second call (`server/node/risubard-combined-memory.ts:18`).
- **Call 2: canonical rewrite** (`bardwiki-canonical-update`). It runs only for candidates that call 1 did not already patch. Targets are split into batches that fit the token budget. Output: `{documents:[{candidateIndex, sections:[{heading, operation: upsert|delete, content}]}]}`.
- **Applying changes.**
  - The event page is serialized by `serializeMemoryWriterDraft` (`risubard-memory-writer.ts:769`) and saved by `saveConfirmedTurn` (`risubard-markdown-wiki.ts:1500`).
  - Canonical pages are patched by `applyCanonicalSectionPatches` (`server/node/risubard-markdown-section-patch.ts:237`). It replaces or deletes `###` sections matched by normalized heading, ignores headings inside code fences, keeps every section that is not mentioned, and refuses a patch that would empty the page.
  - Candidates with confidence below 0.75 are only warned about (`risubard-memory-analysis.ts:1583`).
- **Prompt.** The writer contract is kept as Markdown in the repository: `src/ts/risubard/skills/bardwiki-memory-writer/SKILL.md`, `references/event-schema.md` and `references/english-contract.md`. The last one is imported raw as the system prompt (`risubard-memory-writer.ts:5`).
  - Wiki Prompt Presets (`src/ts/risubard/wikiPromptPreset.ts`) refine what gets tracked, for example a puzzle and clue tracker. Each preset has stages (analysis, canonical rewrite, response guidance). Official presets are versioned (`공식기본-260922` … v6), and earlier versions are kept as fixtures.
  - Per-character and per-chat "Wiki Guide" text refines it further.
  - Neither presets nor guides can change the schema.
- **Language and style.** The writing language (Korean or English) is chosen independently of the UI and chat language. It is fixed per document; changing it does not translate existing pages. The canonical writing style is chosen separately: concise, standard, ultra-compressed, or a custom style up to 1,000 characters.

**Decisions and limits**
- Only confirmed text is evidence.
- At most 8 canonical targets per turn by default.
- Invalid or empty output leaves the wiki unchanged; the full reply is never saved as a fallback note.
- Wiki writing blocks new generation, reroll and continue until it finishes.
- If some canonical pages fail to save, the turn is not marked complete. The pages that did save are kept, and retries skip any page whose hash already matches the receipt's `afterHash`.

**Size and coupling.** L. It is coupled to the wiki files, and needs a hook in the send pipeline plus a separate auxiliary-model request path.

#### 2.1.3 Character canon maintenance (compaction)

**What it does for the user.** Long character pages stop growing every turn.

**How it works.** `maintainCharacterCanon` (`server/node/risubard-canonical-maintenance.ts:314`) runs as part of the same save. It triggers when a page exceeds 0.8 × the per-source token budget and has grown 1.25× since the last pass (`cardMaintenanceDue`, `:59`). It only touches the knowledge, relationships, turning-points and equipment sections. An item counts as "covered" only if at least 60% of its bigrams appear in a cover document. If the result is not at most 0.9× the original size, it is discarded. The function never throws.

**Origin.** Plan `2026-10-09-narrative-timeline-and-canon-maintenance.md`. It records the real case behind this: a character's "knowledge and secrets" section grew from 0 to 19 items over 27 saves and never shrank, and its "relationships" paragraph merged scenes out of order. The v6 writing standard also moves world facts into location and concept pages.

**Size and coupling.** M, wiki-specific.

#### 2.1.4 Story timeline cues ("recent flow" and "N turns ago")

**What it does for the user.** The model stops confusing the order of similar events that happened outside the recent window. The plan's example is breakfast before sleeping versus breakfast after.

**How it works**
- The client sends the order of up to 96 messages that come before the recent window (`server/node/risubard-inquiry-timeline.ts:5`).
- The server builds a `narrative-memory:recent-flow` source. It lists up to 8 event titles, oldest first, each labelled with how many turns ago it happened. Its size is capped at `min(400, maximum/4)` tokens.
- Retrieved event pages also carry the "N turns ago" label.

**Size and coupling.** S. It is easy to port anywhere event records carry source message IDs.

#### 2.1.5 Story arc ("아크 플롯", arc plot) and "story so far" (이야기)

**What it does for the user.** A compact plot-overview page (overview, turning points, open threads) is updated every N confirmed events and links to representative events. A "story so far" tab joins each active event's summary in message order and links back to the source messages.

**How it works**
- A reserved `other` page carries a checkpoint comment, `<!-- risubard-story-arc-checkpoint: <eventId> -->`.
- `buildStoryArcUpdatePlan` (`server/node/risubard-story-arc-writer.ts:134`) synthesizes a candidate once enough new events exist. The rewrite has to link at least one event from the current window.
- The ArcPlotter settings set caps on the number of arcs, turning points, open threads and characters.
- `buildStorySoFar` (`src/ts/risubard/storySoFar.ts:47`) orders events by resolving `sourceMessageIds` against the current message array when it reads them (`src/ts/risubard/eventOrder.ts:20`). The comment: "deleting a turn cannot stale stored indices".
- A per-character chronology tab was added in 0.9.52 and removed again in 0.9.53.

**Size and coupling.** M.

#### 2.1.6 Wiki reboot

**What it does for the user.** Rebuilds the whole wiki from the chat transcript. The user picks a starting turn and chooses whether each batch covers 1 or 2 turns. Progress can be watched as a temporary wiki fills up. The job can be paused or resumed and survives an app restart. The old wiki is replaced atomically only at the end. This is also the supported way to "translate" a wiki into a new writing language.

**How it works**
- The job state lives on the chat as `chat.risuBardWikiReboot` (`createWikiRebootJob`, `src/ts/risubard/wikiReboot.ts:105`). It holds the staging chat ID `reboot-<uuid>`, the batch size, the language (fixed when the job starts), target and completed IDs, and per-message receipts.
- Each batch runs `begin`, then `record`, then `complete`. `begin` writes a recovery manifest and copies of the baseline pages.
- After a crash, `recoverRebootBatch` (`risubard-markdown-wiki.ts:1178`) either uses the recorded receipt or rolls the batch back.
- `finalizeWikiReboot` (`index.svelte.ts:548`) calls replace, then finalize, rewrites confirmation flags, and removes the staging copy.
- Generation is locked while a job exists. The UI shows why, and the lock no longer follows the chat into copies (0.9.66 fix).

**Size and coupling.** M–L. It depends on the wiki fork and replace primitives.

#### 2.1.7 BardChat (wiki admin command terminal)

**What it does for the user.** A natural-language terminal at the bottom of the wiki dock. Examples: "make a page per character and record the current relationships", or one of 14 templates such as COMBINE, SPLIT, DEDUPLICATE, RECONCILE, TIMELINE, RENAME and RECLASSIFY (`src/ts/risubard/bardChatCommandTemplates.ts:9`). It can edit several documents at once. You choose which context to inject: wiki, chat, system prompt, character description, persona, or lorebooks. The last run can be undone once, and changed pages get a "New" badge.

**How it works**
- `executeDirectWikiCommand` (`src/ts/risubard/directWikiCommand.ts:400`) makes one `bardwiki-admin` call with a schema of operations: `upsert`, `trash` or `retract-event`, with `targetDocumentId`, `type`, `title`, `aliases` and `markdown`.
- Long pages are edited block by block (`splitDirectWikiBlocks`, `src/ts/risubard/directWikiBlocks.ts:26`). Block IDs come from the position and SHA-256 of each block, so no markers are inserted into the canonical file. Blocks the model leaves alone keep their original bytes.
- All targets are planned before anything is written.
- Undo is a single snapshot slot held in server memory (`risubard-markdown-wiki.ts:716`). A restart loses it, and it refuses to restore if the wiki has changed since.

**Size and coupling.** M.

#### 2.1.8 Fork, inherit, import/export and copy to lorebook

**What it does for the user.**
- Copying a chat or branching at the newest message carries the wiki along.
- "Start a new chat with this wiki" continues the memory in a blank chat.
- A portable `.json` wiki package can be exported and imported.
- Any page can be copied into the character lorebook as an inactive entry.

**How it works**
- **Fork** (`forkMemoryWorkspace`, `server/node/risubard-memory-fork.ts:164`): stage into `<dest>.fork-<uuid>` with a `.risubard-fork.json` marker, then the client saves the chat, then calls `fork/complete` with finalize or discard. This two-phase fork is reused by Character Vault cloning.
- **Historical branches** (from an older message) are refused on the server: "historical branches require save/load" (`:197`).
- **Inherit** (`server/node/risubard-wiki-transfer.ts:10`) copies `wiki/` and prefixes its sources with `inherited:<hash>:`, so retraction and ordering logic treat them as coming before the new chat.
- **Import** (`:27`) builds in a staging area, checks that the live wiki did not change meanwhile, then publishes through replace.
  - Package format: `{format:'risubard-wiki', version:1}`, up to 16 MB.
  - Only active canonical pages are included; events and the arc page are left out.
- **Chat JSON from the same install** carries its wiki along when re-imported (0.9.6). A foreign chat JSON instead has its confirmation markers reset (`src/ts/risubard/chatImportMemory.ts`).

**Size and coupling.** M.

#### 2.1.9 Optional semantic search (embeddings)

**What it does for the user.** When turned on, it finds wiki pages and past messages even when the wording differs. It reuses the HypaMemory embedding settings and is off by default.

**How it works**
- **Chunking.** Pages are chunked by headings and paragraphs, about 1,000 characters each with 120 characters of overlap, with the title and heading prefixed (`src/ts/risubard/wikiEmbeddingChunks.ts:16`).
- **Embedding and storage.** The client embeds the chunks. Vectors are cached by `hash('wiki-vector-v1', provider.identity, docId, text)` (`src/ts/risubard/wikiEmbeddingIndex.ts:105`), encoded as `RBV1` plus Float32 little-endian (`wikiVectorCodec.ts`), and stored at `<data>/bardwiki-vectors/<aa>/<hash>.rbv` (`server/node/bardwiki-vector-store.cjs:42`). Reads and writes are batched through `/api/read-many`.
- **Ranking.** Results are merged with lexical results by reciprocal-rank fusion, using rank rather than the raw score (k=60), so different embedding models combine stably.
- **Stale vectors.** Vectors whose `contentHash` no longer matches are ignored.

**Decisions**
- Vectors were moved out of the main key-value store in 0.9.64, because tens of thousands of entries made every asset save rewrite a 29 MB manifest.
- Embedding is never turned on silently.
- If embedding is not ready or fails, search falls back to lexical.

**Size and coupling.** M. It is portable and needs only a blob store.

#### 2.1.10 OOC turns and the OOC notepad

**What it does for the user.**
- Assistant replies marked `<!-- OOC_turn -->` are out-of-character. They are always left out of wiki analysis, reboot and past-message search.
- They can be hidden from the chat.
- A notepad dialog groups them by turn range (for example `4–5`, `8`, `10–12`), with search and jump-to-message.
- Trailing OOC turns after the last story reply are kept in the response context and do **not** count toward the recent-message limit.
- A preset toggle named `ooc` (any case) can switch them off (0.9.60).

**How it works.** `oocTurnIndices` (`src/ts/risubard/oocTurns.ts:69`) returns each OOC reply together with the user message before it. The send pipeline detects the toggle at `index.svelte.ts:2347`.

**Size and coupling.** S, and portable. It is a good pattern for any fork that has OOC chatter.

#### 2.1.11 Legacy structured graph and `packages/risubard-core`

The `risubard-core` package (about 3.4k lines) contains:
- `contextCompiler.ts`: `compileContext` at `packages/risubard-core/src/contextCompiler.ts:54`. Required sources come first and throw if they exceed the input limit. Optional sources are then sorted by priority, then by recency, and greedily packed. Omitted sources are listed with `reason:'budget'`.
- `memoryDelta.ts`: a reducer over add-fact, append-event and invalidate-fact operations, each with evidence references.
- `narrativeDelta`, `narrativeGraph`, `narrativeIndex` and `narrativeInquiry`.
- `writerCommand`, `modelOutput` and `modelResponse`.

The server memory modules import these. The graph and "v2 structured memory" now serve only old wikis (`wiki.mode === 'v2'`); the README states that graph state takes no part in confirmation, display or prompt injection. The `ContextSource` type is still the common currency for the required-wiki and narrative-context code.

**Takeaway.** A clean example of a separately authored, UI-free core behind an adapter layer (`docs/architecture/code-boundaries.md`).

### 2.2 Request assembly and the fixed-budget compiler

#### 2.2.1 Prompt layout

**What it does for the user.** The model gets a bounded, predictable prompt whatever the length of the chat.

**How it works**

Default layout, where `risuBardCacheFriendlyContext` is off:

1. **Top of the prompt.** A required-wiki **system message** (`removable:false`), added at `src/ts/process/index.svelte.ts:2916`. It is built by `createRequiredWikiMessage` (`src/ts/risubard/requiredWikiContext.ts:16`) and contains the evidence rules, the wiki-preset response guide, and the full text of every `context: always` page and the scene page.
2. **Description slot.** `createNarrativeSourcesPrompt` (`src/ts/risubard/narrativeContext.ts:524`) builds the retrieved memory: the narrative-continuity rules, then "Relevant narrative memory", with each source written as `- [source "<id>"] <content>`. It is merged into the description by `mergeNarrativeContextWithStaticPrompt` (`:572`).
   - The rules (`narrativeContext.ts:72`) tell the model to treat the sources as authoritative, to prefer direct chat evidence and event pages for past details, to prefer canonical pages for the present, and that canon "does not establish when" something happened.
3. **Everything else keeps upstream order.** Preset, persona, lorebook, depth prompts, the windowed history, then the latest user message.

The server returns sources in this order: the recent-flow summary, then the selected wiki pages, then original-message excerpts headed "Original historical chat evidence (role, order N)".

**Required versus optional**
- **Required:** pages with `contextMode === 'always'` plus every `scene` page. They are fetched in a separate call with no ranking and no per-source cap, up to 32 pages (`server/node/risubard-markdown-inquiry.ts:12`). A failed read is retried once with a 60-second timeout. If it still fails, **generation aborts** with an error (`index.svelte.ts:1618`).
- **Optional:** any failure is non-fatal. The request goes out without memory, and a diagnostic records why.

**Budget**

Defaults are in `src/ts/risubard/risuBardSettings.ts:12-22`:

| Setting | Default |
| --- | --- |
| target | 4,000 |
| events | 3,000 |
| perSource | 2,000 |
| maximum | 7,500 |
| analysis | 8,192 |
| historical-source matches | 8 |
| inquiry timeout | 10 s |

Presets (`src/ts/risubard/memoryBudgetPreset.ts:35`):

| Preset | target | events | perSource | maximum |
| --- | --- | --- | --- | --- |
| 절약 (economy) | 3,000 | 2,000 | 1,500 | 5,500 |
| 보통 (standard, default) | 4,000 | 3,000 | 2,000 | 7,500 |
| 넉넉 (generous) | 6,000 | 4,000 | 2,500 | 10,500 |

- **Reserving room for required pages.** `reserveRequiredWikiBudget` (`requiredWikiContext.ts:7`) subtracts required tokens from `maximum`. If fewer than 256 tokens remain, the optional lookup is skipped.
- **Lanes inside the inquiry** (`risubard-markdown-inquiry.ts` ~776–950):
  - up to 4 non-event "map" anchor pages;
  - event pages get their own `events` lane, used only when the query reads as past, causal, detail or chronology (checked with a regex);
  - historical excerpts count against the map lane;
  - everything is capped by `maximum` and by `perSource`;
  - at most 12 documents in total;
  - token counts use `cl100k_base`.
- **Overflow.** An optional page that does not fit is left out. Only in a final pass may a non-event canonical page be trimmed, and only if at least 256 tokens of room remain. A trimmed page is marked `[Partial canon excerpt trimmed to fit the memory budget; omitted parts are not evidence of absence]` (`risubard-markdown-inquiry.ts:21-22`). Event pages are never trimmed.
- **Final context check.** When a required message exists, the input limit becomes `maxContext − maxResponse` (`index.svelte.ts:2947`). Removable history is emptied from the front. If the prompt still does not fit, the request fails with `toomuchtoken`. Required pages are never silently cut.

**Size and coupling.** M for the client seams. The retrieval itself is server-side over Markdown files (L).

#### 2.2.2 Recent-history window counted in assistant turns

**What it does for the user.** A "recent messages for the response" setting, with a matching but independent "recent messages for analysis" setting. Both are configurable globally, per bot, and per chat. Past user messages can be optionally left out, but the current user message is always kept.

**How it works**
- `selectNarrativeWorkingMessages` (`narrativeContext.ts:655`) keeps the last N **assistant replies**, the user messages between them, and the pending user message. N defaults to 12. The first message is added only when fewer turns exist.
- The upstream SupaMemory and HypaMemory summarizers are skipped (`index.svelte.ts:2515`).

**Note.** `docs/ko/memory-wiki.md` still says N counts messages, with the current input included. Since 0.9.33 the code counts assistant turns.

**Size and coupling.** S, and portable.

#### 2.2.3 Retrieval: lexical, link graph, semantic, and the optional "BardChan" reranker

**How it works**
- **Lexical scoring** (`risubard-markdown-inquiry.ts:315`):
  - IDF-weighted, so a rare clue outranks common words (0.9.6);
  - title and alias matches, links, content and keywords;
  - Korean suffix stripping and a stopword list;
  - entity hints from lorebook names score 10,000.
- **Link expansion.** Follows `[[link]]` hops from the matched pages: up to 2 hops, 8 documents per hop, 16 edges per document. Story-arc pages route to the events they link to. Up to 64 candidates and 32 direct seeds.
- **Semantic matches** are fused by reciprocal-rank fusion (RRF).
- **BardChan rerank** (`src/ts/risubard/bardChanReranker.ts:75`) is off by default. It runs only when the top two candidates are close (second ≥ 0.7 × first). It sends up to 8 candidates with 240-character excerpts to a model at temperature 0 with 64 output tokens, and the model must return `{"ids":[…]}`. If it fails, the first result stands.
- **Design input.** The 0.9.6 patchnote cites the T-Mem, MRAgent, TiMem and Memora papers. The 2026-09-29 checkpoint cites LongMemEval as an evaluation framing.

#### 2.2.4 Recalling original past messages as evidence

**What it does for the user.** Original chat lines that fell out of the window come back as evidence, labelled "과거 원문 · 턴 N" ("original past message, turn N"). For example, the exact wording of a promise.

**How it works**
- **Lexical, on the client** (`findHistoricalSourceMatches`, `src/ts/risubard/historicalSourceRecall.ts:202`): BM25-style IDF over messages older than the response window. Excerpts are cut to 1,200 characters around the best term. Default 8 matches, maximum 32.
- **Semantic.** An index per message, merged with the lexical results by RRF (`mergeHistoricalSourceMatches`, `historicalSourceEmbedding.ts:96`).
- **Evidence requests.** Selected event pages carry `sourceMessageIds`. The server sends back `evidenceRequests`, and the client resolves those IDs locally and queries again once (`narrativeContext.ts:455-476`). That way the exact source turn of a selected event is preferred over text that merely looks similar.
- **What is left out.** Recent turns, OOC turns and disabled messages are excluded before ranking.

**Size and coupling.** M. Needs stable message IDs and events that record which messages they came from.

#### 2.2.5 Dynamic ("long-term memory auto-expansion") budget

**What it does for the user.** A single dropdown: off, economy, balanced or recall. It lets the retrieval budget grow as the chat grows, up to a user-set ceiling (default 12,000).

**How it works** (`src/ts/risubard/dynamicMemoryBudget.ts:8`)
- `growth = maxGrowth[mode] · p · (2 − p)`, where `p = min(1, chars/500,000)` and `maxGrowth` is 0.25, 0.5 or 1 for economy, balanced and recall. This is a quadratic ease-out that levels off at 500k characters of active assistant text.
- `maximum`, `target`, `events` and `analysis` grow. `perSource` stays fixed.
- It is projected at runtime only (`resolveDynamicMemorySettings`, `:69`); saved settings are untouched.

**Note.** The 2026-09-29 design doc proposed `log2(turns/baseline)` steps. The shipped code uses characters with the curve above.

**Size and coupling.** S, and portable.

#### 2.2.6 Cache-friendly layout option (0.9.70, commit `aa582e0`)

**What it does for the user.** When on, the per-turn memory block and the required-wiki block are inserted **just before the latest user message** rather than at the top or in the description. This keeps the preset, description, lorebook and older chat as a stable prefix, so the provider's prompt cache keeps hitting. Off by default.

**How it works.** `insertBeforeLatestUserMessage` (`narrativeContext.ts:557`). If there is no user turn, the blocks are appended before any trailing assistant prefill. The token count is taken before insertion.

**Size and coupling.** S, and portable.

#### 2.2.7 Body-free context trace, injection manifest and "chat evidence report"

**What it does for the user.**
- Each generated message records what went into it.
- The wiki log tab shows requests and wiki saves in one stream.
- A per-chat **evidence report** can be exported as Markdown. A sample is in `log/risubard-chat-evidence-*.md`. Each request lists its purpose, model, provider, result, duration, input/output/reasoning/cached tokens, and an "input composition" table: tokens per system message, chat history, wiki, lorebook and so on.

**How it works**
- **Per-message trace:** `generationInfo.risuBardContext`, built by `createRisuBardContextTrace` (`src/ts/risubard/memoryActivity.ts:49`). It records the recent message IDs and roles, the selected wiki paths, inquiry timing, the selected token count, and a diagnostic (`createWikiInquiryDiagnostic`, `src/ts/risubard/wikiInquiryDiagnostics.ts:41`).
  - The diagnostic status is one of skipped, failed, empty, not-injected, partial or injected.
  - "Injected" is *verified* by finding each `[source "id"]` tag and its content in the final formatted prompt, after preset and Lua edits.
- **Request-log manifest.** `buildInjectionManifest` (`src/ts/status/requestStatus.ts:130`) splits each message's exact token count across its tagged sources (`{kind,name,tokens}`). Any remainder is reported as "request prompt overhead".
- **Purposes.** `src/ts/requestPurpose.ts:3` defines 11 purposes: chat-response, bardwiki-analysis, bardwiki-canonical-update, bardwiki-admin, bardwiki-bard-chan-rerank, persona-builder, lore-builder, bard-painter, bard-lore-analysis, prompt-assistant and character-assistant. A server whitelist must match (`server/node/request-logs.cjs:19`).
- **Evidence report.** `buildChatRequestEvidence` (`src/ts/risubard/chatRequestEvidence.ts:333`) loads body-free rows. The report states that it excludes prompts, responses, headers and auth; only the reasoning *token count* is included.
- **Turn receipt.** Each `char` message records what the wiki writer did as a `CanonicalTurnReceipt` (`src/ts/risubard/canonicalTurnReceipt.ts:13`): source message IDs, event IDs, `changes{documentId,action,afterHash}`, warnings and notes. It is displayed under the message by `RisuBardTurnReceipt.svelte`.

**Caveat.** The README says "request logs omit request and response bodies". The developer request log (`server/node/request-logs.cjs:10,76-77`) actually stores request and response bodies after passing them through `maskSensitive`. Each body is capped at 2 MB, and the whole store at 256 MB. Bodies are returned only when `bodies=1` is requested. The body-free claim holds for the evidence report, the context trace and the wiki activity log.

**Size and coupling.** M. The manifest and purpose taxonomy are portable.

#### 2.2.8 Request pipeline hardening

- **`modelProvenance.ts:15`.** Logs the model ID actually sent on the wire, separately from the preset's display name. Since 0.8.11, display and request use the same binding rules, and background wiki jobs use the *owning* chat's model binding even if the user has switched chats.
- **`responseRetryPolicy.ts`.**
  - The retry count is clamped to 0–20.
  - Transport errors are retried only when no tools are involved.
  - A banned-script character filter turns such replies into retryable failures.
  - There is no retry after streaming has started.
- **`structuredOutputFallback.ts:46`.** If a provider rejects the native schema, the request is resent without `responseSchema`, with the schema placed in the system prompt instead.
- **`providerOutputTokenLimit.ts:8`.** Parses the allowed maximum out of Vertex, Anthropic and OpenAI "max tokens" rejection messages and retries once. Used for BardWiki and lore analysis, not for main chat.
- **`src/ts/process/generationTarget.ts`.** Pins writes to the original character and chat when the user switches chats while a reply is generating (0.9.52).
- **Ollama.** Native JSON schema, output-token and temperature options for internal non-streaming calls.

### 2.3 Chat save/load, turn navigation and chat tools

#### 2.3.1 Visual-novel-style save slots: manual, quicksave and autosave

**What it does for the user.**
- The save/load dialog shows an autosave strip, a fixed quicksave tile, and a grid of manual slots.
- Each slot shows the turn count, the last user and character lines, and the latest wiki event title with an excerpt.
- You can save new, overwrite, rename, delete, load in place, or "load as new chat".
- A floating save/load toolbar can be dragged and anchors to the nearest edge (`src/ts/risubard/saveLoadShortcutLayout.ts:18`).
- Composer buttons offer quicksave and quickload.
- Loading rolls back **the chat, its variables and scriptstate, the chat lorebook, and the BardWiki together**.

**How it works**
- **Contents of a slot.** `chat.bin` holds the whole chat as msgpack. `risubard-save.json` is the manifest (saveId, sourceChatId, name, turnCount, latestMessageId, latestEvent). `risubard-save-files.json` lists `{path,hash,size}` for every file in the wiki workspace.
- **Shared page store.** Files go into a content-addressed store shared by all slots of a character, `characters/<id>/save-store/<hh>/<sha256>` (`snapshotWorkspaceToStore`, `server/node/risubard-memory-save-store.ts:116`). An unchanged page is stored once. Files are re-hashed only when their stat stamp changes. Pages are garbage-collected when a slot is replaced or deleted (`releaseStorePages`, `:233`).
- **Routes.** `POST /api/risubard/memory/save-slot` (`server/node/risubard-memory-routes.cjs:195`) plus `/list`, `/preview`, `/rename`, `/delete` and `/load`.
- **Load sequence** (`loadSavedChat`, `src/lib/ChatScreens/ChatScreen.svelte:207`):
  1. `prepareMemorySaveLoad` (`server/node/risubard-memory-save.ts:444`) rebuilds the workspace in a staging area and returns a fork token.
  2. The client swaps the chat and forces a full save.
  3. Only then does it finalize. If anything fails, it discards and restores the old chat.
- **What a load does not change** (`applyMemorySavePromptSettings`, `src/ts/risubard/memorySaveSlots.ts:154`): the current persona, prompt preset, model bindings and `toggle_*` values. The comment reads: "Save slots rewind story state, not the current sidebar preferences."
- **Autosave.**
  - Every 5 turns by default (configurable 1–100), firing on turns 1, 6, 11 and so on.
  - Keeps 5 slots by default (1–20) in a ring of IDs `__risubard_auto__<chat>__<n>` (`src/ts/risubard/memorySavePolicy.ts:54,65`).
  - Runs only after generation **and** wiki writing have finished.
  - A failed autosave does not count as saved.
- **Quicksave.** One reserved ID per chat.

**Decisions**
- Plan `2026-08-27-save-slot-only-history.md` makes save slots *the only* point you can rewind to. Per-turn wiki snapshots and per-document undo were removed.
- Because of that, deleting messages that serve as wiki evidence, or branching from history, is either blocked or sent through save/load plus reboot.
- An overwrite writes the new slot completely before replacing the old one.
- No limit on the number of manual slots was found.

**Size and coupling.** M (about 1.9k lines). Tightly coupled to the wiki workspace and its fork protocol. The slot idea itself (msgpack chat plus a content-addressed page set plus preferences kept apart) is portable to a server that stores chats and memory records.

#### 2.3.2 Scriptstate checkpoints for rerolls and swipes (`src/ts/chatScriptstateCheckpoint.ts:53`)

**What it does for the user.** Variables written by an assistant reply no longer pile up across rerolls. Selecting a swipe restores that swipe's variable state.

**How it works.** Each response keeps `scriptstateCheckpoint{before,after}` plus a checkpoint per swipe. Only the **latest** message keeps checkpoints. 0.9.69 fixed chats that had grown to tens of MB because every message kept two full copies.

**Size and coupling.** S, and portable. This is a real correctness gap in upstream.

#### 2.3.3 Bounded chat pages and turn navigation

**What it does for the user.** The chat shows one fixed page of messages at a time (default 30, range 10–200). A page and turn jump control is provided. Jumps from the OOC notepad, sources and bookmarks switch to the right page first.

**How it works.** `getChatPageBounds` (`src/ts/chatPagination.ts:29`) and `buildChatTurnNavigation` (`src/ts/chatTurnNavigation.ts:14`). It is UI only; `chat.message` stays a plain array.

**Size and coupling.** S, and portable.

#### 2.3.4 Chat content paging and chunked upload

**How it works**
- **Download.** `GET /api/chat-content/:chaId/:chatIndex/page` (`server/node/server.cjs:5839`) returns metadata plus a slice of messages (10–500 per page, default 200). The client fetches the pages concurrently, checks they are contiguous and the total is stable, then **reassembles the full array**. This limits transfer spikes, not client memory.
- **Upload.** Optional chunks (default 8 MiB) go to `/api/chat-content-upload` (`server/node/chat-content-upload.cjs:11`). Limits: 2 GiB maximum, 8 pending uploads, a 10-minute TTL. No live chat changes until the last chunk is accepted.

**Size and coupling.** S–M.

#### 2.3.5 Message deletion that respects wiki evidence

**What it does for the user.** The dialog offers to delete one message, or a message plus everything after it, and shows exact counts. It warns that linked event pages will be retracted, that other canonical pages are *not* rolled back, and that a wiki reboot is the way to get exact history.

**How it works.** `rm()` (`src/lib/ChatScreens/Chat.svelte:154`) collects the stable IDs of the removed messages and calls `retractWikiEventsBySourceMessages` **before** changing the array. If retraction fails, the deletion is aborted.

**Size and coupling.** S, coupled to the wiki.

#### 2.3.6 Chat merge, fork, copy with memory, and bulk delete

- **Merge** (`buildMergedChat`, `src/ts/risubard/chatMerge.ts:18`):
  - Concatenates two or more chats and gives every message a new ID.
  - Drops receipts, Hypa data and reboot jobs.
  - Turns an `allBefore` cutoff into per-message `disabled` flags and remaps bookmarks.
  - Does **not** copy any memory ("Keep settings, never derived memory").
- **Copy and branch.** Copying uses the two-phase wiki fork. Branching at the head forks the wiki; branching from history resets the wiki state.
- **Bulk delete.** A checkbox per chat, confirmation listing the chat names, and it refuses to delete every chat (`SideChatList.svelte:210`).

**Size and coupling.** S–M.

#### 2.3.7 Scroll anchoring and retained chat HTML

**What it does for the user.** The message being read stays in place while images or inlays load and messages re-render. The new message's start is shown when you open a chat.

**How it works**
- `captureChatScrollAnchor` and `restoreChatScrollAnchor` (`src/lib/ChatScreens/chatScrollAnchor.ts:74`) record the topmost visible paragraph or media element and its offset. `ResizeObserver` restores the position before paint.
- `retainedChatHtml` (`src/lib/ChatScreens/retainedChatHtml.ts:75`) patches the committed DOM against the *previous parser output* instead of replacing `innerHTML`. Detached copies are built in an inert document so `<audio autoplay>` does not fire.

**Size and coupling.** S–M, pure UI, portable.

#### 2.3.8 Find and replace, gallery, and assistant-chat actions

- **Find and replace** (`src/ts/risubard/findReplace.ts:58`). Literal search across chat messages, swipes and names, and optionally the wiki through `POST /api/risubard/memory/wiki/replace`. Shows a preview with counts and is blocked while generation is running.
- **Gallery** (`src/ts/risubard/gallery.ts:16`). Clips a message range into a titled "memory gallery" slot stored on the **character** (`character.risuBardGallery`) and included in exports.
- **Assistant docks.** Fork, copy and delete for each message, plus Markdown export (`src/ts/risubard/assistantChat.ts`).

### 2.4 Storage: file-native data, integrity and external editing

**This replaces PocketRisu's storage.**

#### 2.4.1 Data root, canonical files and the compatibility projection

**What it does for the user.** User data is stored as ordinary files under `RISUBARD_DATA_ROOT` (`docs/en/file-native-storage.md`). Corruption is confined to individual files and is recoverable. Startup reads only small manifests.

**How it works**
- **Choosing the root** (`resolveDataRoot`, `server/node/data-root.cjs:20`):
  - `RISUBARD_DATA_ROOT` if set;
  - on Termux, `~/.local/share/risubard`;
  - otherwise `<cwd>/save`.

  Roots on Android `/sdcard` and `/storage/emulated` are **rejected**, because fsync and rename are unreliable there.
- **Layout:**
  - `settings/app.json`
  - `secrets/credentials.json`, split out of the settings by a key-name regex
  - `presets/<id>.json`, `modules/<id>.json`, `personas/<id>.json`, `lorebooks/<id>.json`
  - `characters/<id|friendly>/metadata.json`, with `chats/<id|friendly>/{metadata.json, messages.jsonl, draft.json}`
  - `index/sidebar.json`
  - `kv/manifest.json` and `kv/objects/<sha256>` (content-addressed blobs)
  - `inlays/`, `logs/*.jsonl`, `request-logs/`, `model-jobs/<id>/{state.json,events.jsonl}`
  - `risubard/` (BardWiki), `bardwiki-vectors/`
  - `trash/`, `migration-backups/`

  Every canonical file has a `.sha256` sidecar and one `.bak`.
- **Message durability.** User messages are fsynced before the model request goes out. Streaming drafts are written to `draft.json` so a half-finished reply can be recovered.
- **"Projection"** is the legacy RisuAI `Database` object rebuilt from the canonical files, plus a compatibility `database.bin` that is rebuilt lazily (`server/node/compatibility-cache.cjs:8`).
  - The client still sends `/api/patch` (JSON-Patch plus `expectedHash`) or `/api/write` (ETag).
  - The server acknowledges at once and persists after a 5-second debounce through `writeCanonicalProjection` (`server/node/canonical-projection-writer.cjs:7`).
  - That function takes a narrow direct path when the direct-write tracker proves the patch was narrow (only chat state, or only one preset). Otherwise it does a full `importLegacyDatabase` sync.
- **"Shadow"** (`server/node/projection-shadow.cjs:54`). After saves have been quiet for 3 seconds, it exports the legacy DB from the files and deep-compares it with memory. Results go to `logs/storage-observation.jsonl`. A match allows the faster "deferred compatibility" path.

**Measured effect** (0.9.39/0.9.40, a 60 MB save, median):
- typical save: 3.40 s → 0.30 s
- file-reflect time: 2.53 s → 0.29 s
- temp data per save: 55.7 MiB → 2.6 MiB

**Size and coupling.** L: about 6.9k lines across about 40 `.cjs` files, plus wiring in `server.cjs`. This *is* the storage layer.

#### 2.4.2 Crash-safe write protocol, journal, `.bak` and trash

**How it works**
- **Single-file writes** (`atomicWriteFile`, `server/node/file-store.cjs:154`):
  1. Write a temp file opened with `wx` and mode 0600, then fsync it.
  2. Re-read it and compare the sha256.
  3. Copy the old file to `.bak` (through its own temp file and rename).
  4. Rename the temp file over the target.
  5. Replace the sidecar atomically.
  6. Fsync the parent directory. This step is skipped on Windows.
- **Multi-file transactions** (`commitTransaction`, `:411`):
  1. Stage every file into `.journal/<id>.stage/N.data`, then fsync and verify each one.
  2. Check preconditions: entries that should be unchanged still match, and no other program wrote to a target during the save.
  3. Write the journal file with `state:'prepared'` and the list of entries.
  4. Publish idempotently, skipping targets that already match.
  5. Clean up.

  `recoverTransactions` (`:548`) replays leftover journals forward when the server starts.
- **Trash.** `moveToTrash` (`:564`) moves the file, its sidecar and its `.bak` to `trash/<ISO stamp>/<relpath>`. This applies to deleted presets, modules, personas, lorebooks, chats and finalized drafts.

**Limits found in the code**
- Only one previous version (`.bak`) is kept per file. There is no N-revision history.
- `.bak` files and `trash/` are never pruned automatically.
- Deleting a whole character is a **hard** `rmSync` inside the journal (`file-store.cjs:271`; it is emitted at `user-data-repository.cjs:915`). That contradicts "deletes move to trash".
- Unreferenced KV blobs are unlinked by background GC: older than 1 hour, at most 5,000 per run, every 5 minutes.

#### 2.4.3 Locks and single-writer sessions

- **Data root lock** (`acquireDataRootLock`, `server/node/data-root-lock.cjs:62`). Created with `mkdir .risubard-server.lock` plus `owner.json{pid,token}`. A stale lock is renamed and removed. Fails with `DATA_ROOT_IN_USE`. In 0.9.64 the portable "development" and "normal" launchers became mutually exclusive.
- **Session lock** (`server/node/session-lock.cjs:63`, inherited from PocketRisu). Another session may take over only if it booted after the holder's last write *and* sends `x-user-active: 1`. Otherwise it gets 423.
- **Session handoff** (`createSessionHandoff`, `src/ts/storage/sessionHandoff.ts:17`). Never discards unsaved local state without asking the user to download it or reload (0.9.42).

#### 2.4.4 Save conflicts and external-change review

**What it does for the user.**
- If another program changes a data file while the app is open, saving **pauses** and a review dialog opens. It shows the changed files, the changed fields, and lore entries that were added, removed or modified. Credential values are hidden (`••••••`).
- **"Accept external changes"** merges character and lorebook changes in place. Any other kind of change triggers a full reload. Unsaved local edits to the same entries are kept in a browser recovery record, or downloaded as JSON.
- **"Keep app content"** backs the external files up to `trash/external-changes-*` before overwriting them.
- Broken JSON is shown with its line and column and cannot be accepted.

**How it works**
- **Detection** uses projection-revision fingerprints (size, `mtimeNs` and sidecar per file) compared with `cache/canonical-projection-revision.json`. Edited files are identified by a sha256 mismatch with their sidecar (`server/node/external-change-review.cjs:38`).
- **Polling.** When the setting is on, the client polls every 3 seconds while visible. Otherwise detection happens at the next save, which returns 409 `EXTERNAL_CHANGES_PENDING` or `CANONICAL_FILES_CHANGED`.
- **Save sequence.** `beginSave` and `settle` (`server/node/canonical-projection-sync.cjs:78`) accept only the save's own writes. A file another program changed during the save stays pending (0.9.71 fix).
- **Retries.** `createCanonicalSaveConflict` (`src/ts/storage/canonicalSaveConflict.ts:4`) gates every retry, including full writes, until the user decides.
- **Resolve route.** `POST /api/external-changes/resolve` (`server.cjs:3707`).

**History and dead code**
- A recursive `fs.watch` live monitor (0.9.41) was **retired** in 0.9.66: Node's emulated recursive watch stalled the server on Linux, Docker and Termux (`server/node/live-file-monitoring.cjs:7`). Polling and fingerprints replaced it.
- An "external edit session" mode (pause saves, edit, adopt) is now unreachable code.
- Since 0.9.72, character asset folders are re-read only with an explicit "asset reload" button.

**Size and coupling.** M, tightly coupled to file-native storage. The *UX policy* is portable: pause and review instead of silently overwriting, show field-level diffs, mask secrets, back up whichever side loses. So is the "files changed while the app was closed are adopted on the next read, with JSON position errors" rule.

#### 2.4.5 Asset integrity and per-character asset folders (V3/V4 pilots)

**What it does for the user.**
- Assets are content-addressed.
- An opt-in "V3" layout gives each character a readable, name-based folder with its assets copied in. Files dropped into that folder can be registered with "asset reload".
- An opt-in "V4" removes a character's exclusive assets from the shared KV manifest to keep it small. The originals are kept and the change can be reverted.
- The same options exist for modules.
- Both are developer-settings pilots.

**How it works**
- `kvGetOriginal` re-hashes on every read and throws on mismatch (`server/node/file-kv.cjs:236`).
- `readVerified` (`server/node/character-assets.cjs:399`) checks size and fstat identity before and after the read, refuses symlinks, and verifies the sha256 unless a trusted stat stamp (`dev:ino:size:mtimeNs:ctimeNs`) is cached. Files changed within the last 5 seconds are always re-hashed.
- The directory mapping never reuses or reassigns a published folder name (`server/node/character-directories.cjs:73`).
- `findClosestAsset` (`src/ts/parser/closestAsset.ts:45`) is a Levenshtein nearest-name fallback for missing asset references. It was extended to module assets in 0.9.72.

**Decisions** (`docs/ko/asset-integrity.md`)
- Stat stamps are hints that something changed, not proofs.
- fs-verity was considered and rejected.
- **Regression tests count reads, not time.** An unchanged `sync()` must do zero asset-body reads and zero index writes. Changing one asset must not read unrelated assets.

**Size and coupling.** M–L, tightly coupled.

#### 2.4.6 Backup, restore, migration and updater

- **Backups.** Full backups carry the canonical tree, assets and BardWiki under flat names, `risubard-canonical-v1_<b64url path>` (`server/node/canonical-backup-name.cjs`).
- **Restore** (`publishBackupRestore`, `server/node/backup-restore-transaction.cjs:40`):
  1. Stage everything.
  2. Reject symlinks, case collisions and any `.sha256` files in the input.
  3. Run one journal transaction that moves the live tree to `trash/backup-<uuid>/` and publishes the staged files.
  4. If interrupted, resume on the next start.
- **Other formats.**
  - A lossy RisuAI-compatible export is available as a separate legacy option.
  - Encrypted account backups from original web Risu are supported (0.9.7).
  - PocketRisu-compatible backup filenames (0.9.31).
- **Inspection.** `pnpm inspect:backup` streams multi-GB backups and prints only counts and anonymized ID hashes.
- **Diagnostics.** A downloadable storage diagnostic report contains no names, messages, paths or IDs.
- **SQLite migration** (`migrateLegacySqlite`, `server/node/legacy-sqlite-import.cjs:17`). Runs once. Copies `risuai.db` to `migration-backups/`, then streams rows through the built-in `node:sqlite`. Normal runtime has no SQLite dependency, and a test enforces that.
- **The V2 rollback.** A "V2" named-folder layout shipped in 0.9.26–0.9.27 and was **rolled back** in 0.9.28. The read-only converter `scripts/convert-v2-to-v0925.cjs` (854 lines) rebuilds V1 in a staging folder, verifies hashes, then renames it into place; it never touches the source (`docs/ko/v2-to-v1-conversion.md`).
- **Updater** (`docs/architecture/automatic-updater.md`). Checks GitHub releases. A portable self-update helper swaps the files and rolls back if that fails. User files in the install root are preserved. Stale `%TEMP%` updater folders are cleaned after one day.

### 2.5 Character Vault, collection organizer and import pipeline

#### 2.5.1 Character Vault

**What it does for the user.** A full-screen manager for large collections. Square cards with a name overlay on hover. Folders with colours and cover images, an "unfiled" view, and sorting. Multi-select to move, rename, delete or clone, with or without chats. Sidebar "quick access" pins for characters and folders, with a "new" badge. Storage-layout badges such as V3 and V4.

**How it works**
- Pure functions in `src/ts/characterVault.ts` act on `Database.characters`, `characterOrder` and a new `Database.characterVault{quickAccess,newCharacterIds}`.
- `createCharacterVaultClones` (`src/ts/characterVault.ts:79`) assigns new `chaId`s, gives names a collision-safe ` (2)` suffix (`src/ts/displayName.ts`), assigns new chat IDs, and records `chatForks`.
- `cloneSelected` (`src/lib/SideBars/CharacterVaultDialog.svelte:345`) first loads placeholder chats. It then forks each chat's wiki through `/api/risubard/memory/fork` (`risubard-memory-routes.cjs:389`), forces a full save, and finally finalizes or rolls back the forks.
- Deletion is now permanent, with a double confirmation (`:445`). Since 0.9.40 it also reclaims unshared assets, except when any character is unloaded or remote.

**Size and coupling.** M (about 520 lines of TS and 930 of Svelte). The pure parts port easily. Cloning with chats depends on the wiki fork.

#### 2.5.2 Collection organizer for presets, modules, plugins and wiki presets

**What it does for the user.** Folders, an "unfiled" view, search, counts, multi-select, drag-and-drop, and ordering, all inside the normal list. Deleting a folder never deletes its items, and organizing never changes which preset, module or plugin is active (0.8.7).

**How it works.** `collectionOrganizer.ts` stores `{folders, folderByItemId, itemOrder}` for each kind in `Database.collectionOrganizers`, separately from the items themselves. `CollectionOrganizerList.svelte` (597 lines) renders it.

**Size and coupling.** S–M. Very portable. A good pattern: organization metadata kept apart from the data it organizes.

#### 2.5.3 Transactional import with progress and recovery

**What it does for the user.** Card and module imports can be cancelled. A live progress panel is fed by server events. If the browser dies partway, the next load offers to roll back or reset. Very large `.charx` files trigger a "module or character?" prompt before anything is unpacked. Success is reported only after both the browser and the server have saved (0.9.32).

**How it works**
- `ImportTransaction` (`src/ts/storage/importTransaction.ts:36`) keeps a write-ahead journal in `localStorage` (`risubard-pending-import-v1`). It never overwrites content-addressed assets that already exist. Rollback removes the owners first, then the new keys.
- `runImport` (`src/ts/importSession.ts:114`) subscribes to `/api/import-progress/:id` and waits for the server's canonical flush before committing.
- `inspectCharx` (`src/ts/charxPreflight.ts:9`) reads only the ZIP central directory (ZIP64 and JPEG-prefixed files included). It asks the user at 150 MB or 5,000 assets.
- `importTaskYield.ts` yields through a MessageChannel so throttling in background tabs does not stall the import.

**Size and coupling.** M. The journal idea and `charxPreflight` are portable. The recovery routes are specific to RisuBard's server.

#### 2.5.4 RisuRealm browser and other smaller additions

- **RisuRealm browser.** Opens from the home screen, with creator search, Enter-to-search, tag autocomplete, and direct import of characters and modules (0.8.4, 0.9.34, 0.9.41, 0.9.55).
- **Duplicate names.** Get ` (2)` and ` (3)` suffixes on import, clone and rename (0.9.40).
- **Message size display** (`src/ts/messageSize.ts`).
- **Display name helpers** (`src/ts/displayName.ts`).

### 2.6 Persona

#### 2.6.1 Character-owned personas and per-chat binding

**What it does for the user.** Personas can be global (as upstream) or **owned by a character**. Badges show the scope, and personas can be copied between stores. Each chat binds a persona, and new chats inherit the previous chat's persona. A pin toggles that inheritance (0.9.32). A chat-bound persona is highlighted with a "binding" colour, distinct from the global selection.

**How it works**
- `character.personas?: RisuPersona[]`, with new fields `id`, `note`, `embeddedModule` and `portraitPrompt`.
- `getEffectivePersona` (`src/ts/personaScopes.ts:53`) resolves the character's own personas, then global ones, then `db.selectedPersona`.
- The per-chat binding uses the upstream `Chat.bindedPersona`, which PocketRisu also has. RisuBard adds the character scope, the inheritance pin, and stable persona IDs.

**Size and coupling.** S, portable.

#### 2.6.2 Persona-scoped modules (0.8.7)

**What it does for the user.** Modules can be assigned to particular personas. Modules assigned to the active persona are added on top of the global, chat and character modules.

**Coupling.** S, portable.

#### 2.6.3 AI Persona Builder

**What it does for the user.** An LLM editor, outside the chat, that writes or revises a persona description. You choose context sources: the system prompt (all text blocks of the current preset, with overlays and toggle conditions applied), the character description, character or module lorebooks, task and style presets, and an undo history of originals.

**How it works**
- `buildPersonaBuilderMessages` (`src/ts/personaBuilder.ts:267`) builds a system message with `<instruction>` blocks, and a user message with `<context name=…>` blocks, a `<draft>`, and the user's OOC instruction. Closing tags inside content are escaped.
- Character lore is matched against the instruction plus the draft by the real lorebook engine, so only relevant entries go in (0.8.13).
- A non-streaming `requestChatData` call returns the new draft.

**Size and coupling.** M, portable.

#### 2.6.4 AI persona portrait (0.9.67)

**What it does for the user.** A brush button draws a 1024×1024 waist-up portrait from the persona description using NovelAI. An LLM first fills in tags for composition, appearance, clothing and expression. A one-line edit such as "make the hair silver" changes only that part.

**How it works.**
- The LLM call returns JSON. The contract is at `src/ts/bardPainter/personaPortrait.ts:40`.
- The result is cached on the persona as `portraitPrompt`, together with a hash of the description, so an unchanged description skips the LLM.
- The image request reuses BardPainter's request builder.

**Coupling.** Needs BardPainter and a NovelAI key.

### 2.7 Authoring assistants: Prompt Assistant and Character Assistant (0.9.66–0.9.71)

**What it does for the user.** Both are docked right-sidebar chats for creators, opened from the developer tools.

**Prompt Assistant** advises on a prompt preset.
- It can attach up to 200 recent chat lines, plus the *actual final prompt* of the last request, taken from the request log.
- It notices preset edits made since the last question and mentions them first.
- Block references in its answer become links that open the Prompt V2 editor at that block.
- It is advice-only.

**Character Assistant** analyzes a bot: its fields, extra greetings, lorebook, regex and triggers, and optionally linked modules, the current preset and toggles, and a reference bot.
- It reads only what it needs.
- It proposes **edit cards** that you apply, skip, apply in bulk or revert. Conflicts are detected.
- A **play-test** mode drives N turns of real chat as a simulated user, either automatic or step-by-step. It runs in a new "play test N" chat through the normal send pipeline, so triggers, regex, preset and lorebook all apply. Each turn records which lorebook entries actually fired.

**How it works**
- **Prompt Assistant** is two-stage (`sendPromptAssistant`, `src/ts/risubard/promptAssistantStore.ts:268`).
  - A select call sees only a block index, about 15% of the preset's size, and returns the block numbers it needs.
  - A streaming answer call then receives those blocks, plus any blocks that changed since the last send (detected by fingerprint diff).
- **Character Assistant** gives the model a table of contents with refs such as `bot:lore:12`.
  - The model asks for material with `<read ref=".." lines="a-b">` and `<search query="..">` tags (`src/ts/risubard/characterAssistant.ts:498`).
  - The runtime answers for up to 6 rounds, then forces a final answer (`sendCharacterAssistant`, `characterAssistantStore.ts:293`).
  - Edits use the format `<edit ref slot><find>…</find><replace>…</replace></edit>`, specified at `src/ts/risubard/characterAssistantEdits.ts:300`. Each `find` must match exactly once.
  - Play mode is started by `startPlay` (`src/ts/risubard/characterAssistantPlayRuntime.ts:245`).
- **Projects** are stored outside the main save, as KV files `risubard/character-assistant/index.json` and `projects/<id>.json`. They can be forked, have messages deleted, and be exported to Markdown.
- Bots with private licences are not analyzed.

**Size and coupling.** L (about 2.7k lines of TS and 3.6k of Svelte). The loops are pure and portable. They depend on a KV store, the request log (for "actual request"), and optionally on BardWiki for play-test context.

### 2.8 Lorebook workspace, Grimoire and Lore Builder

#### 2.8.1 Lorebook workspace

**What it does for the user.**
- A full-pane editor that replaces the inline list. It has a folder tree, multi-select with an anchor, drag and drop (before, after or inside), batch editing, keys that can expand to full width, resizable panes, and session restore per scope (selection, open folders, scroll, caret).
- A new folder is created above the selection. Move buttons shift items by 10 or 1 (0.9.64).
- Since 0.9.67 it opens *inside the chat area*, so the Character Assistant stays visible beside it.
- A CBS condition view splits nested `if`, `or` and `equal` blocks into condition and body without running them. A CBS variable sidebar collects variable names and candidate values and edits chat or default values (0.8.13).

**How it works**
- `src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte` (1,855 lines).
- Pure operations live in `src/ts/lorebook/workspaceOperations.ts`, for example `ensureLorebookIds` at `:136`.
- "Local activation" switches a character lore entry on per chat. It inserts a `mode:'child'`, `alwaysActive` stub with the same ID into `chat.localLore`.
- `loremasterMigration.ts` restores entries that the third-party "Loremaster" plugin had disabled.

**Size and coupling.** L for the UI, with no storage coupling.

#### 2.8.2 Lorebook matching and activation changes

**How it works**
- `matchesLorebookKey` (`src/ts/process/lorebookMatching.ts:22`) supports three modes:
  - `partial`: upstream behaviour;
  - `whitespace`: whole-token match;
  - `word-boundary`: uses `Intl.Segmenter` and allows Korean particles after the key, so `앨리스가` matches `앨리스` but `Aliceville` does not match `Alice`.
- A per-entry `enabled` flag is added. Recursion can be capped with `maxRecursionSteps`.

**Size and coupling.** S, very portable. The word-boundary mode is a real improvement for Korean and CJK keys.

#### 2.8.3 Grimoire ("BardLore"): retrieval-based lorebook

**What it does for the user.** With "use for generation" on for a character, Grimoire picks only the relevant character-lore entries for each turn instead of scanning keys across the whole book. It uses no LLM at generation time. Each entry carries search metadata:

| Field | Values or meaning |
| --- | --- |
| kind | system, character, location, faction, item, event, concept or other |
| aliases, tags | extra names and topic words |
| search summary | a short text used for matching |
| facets | `key=value` pairs, each with search aliases |
| activation | required, keyed (key or alias hit), retrieve (key plus relevance) or never |
| injection role | `full` or `index-only` |
| explicit links | each with a relation and a retrieval direction: supporting, discoverable, ambient or none |

A **search preview** shows what was selected, what was excluded, and why.

**How it works**
- **Storage.** `BardLoreState` (schema 2) is stored on `character.bardLore` (`src/ts/lorebook/bardLore.ts:7-157`). Metadata sits in a **side table keyed by `sourceLegacyId` and `sourceHash`**, and `materializeBardLoreEntries` (`:839`) joins it back onto `globalLore`. Original entries are never rewritten, and editing an entry in either the normal lorebook or Grimoire syncs both ways (0.9.15).
- **Selection** (`selectBardLoreEntries`, `src/ts/lorebook/bardLoreRetrieval.ts:103`):
  1. Required entries go in first. If they exceed the maximum, a `BardLoreBudgetError` is thrown rather than dropping any silently.
  2. A query planner sets the intent (lookup, scene, list or describe) and parses kind, facet and count filters ("세 명" means three people) **from the last user message only**. History is evidence, never a command.
  3. Direct key and alias hits rank first.
  4. Sparse scoring is weighted per field.
  5. Explicit links are followed, with score decay, up to a depth limit.
  6. Results are capped by target tokens, entry count and maximum tokens.
- **Exclusion reasons** are logged in the lore match log: `kind-mismatch`, `token-limit`, `requested-count` and others.
- **Integration** (`src/ts/process/lorebook.svelte.ts:104`). Selected entries are cloned with `alwaysActive:true` and fed into the **unchanged legacy pipeline**, so legacy budgets and ordering still apply afterwards. Chat and module lore keep key scanning.

**Size and coupling.** L (about 4.5k lines of TS and 1.5k of Svelte). Client-only and stored inside the character JSON, so it is **very portable**. It is one of the more interesting standalone ideas.

#### 2.8.4 Grimoire AI metadata analysis (`docs/ko/grimoire-ai-analysis.md`)

**What it does for the user.** An optional batch LLM pass drafts the metadata.
- Drafts are kept for side-by-side review and applied explicitly. They never change the lore text.
- A two-pane workbench shows the request plan (estimated requests and input tokens), lets you pick targets and filter by type, and shows status per item.
- "Recommended settings" are provided.
- It runs in the background across characters, can be paused and resumed, and keeps completed drafts when stopped (0.9.67).
- A "local split (no AI)" breaks NPC, faction and item rosters into atoms deterministically. It refuses when boundaries are ambiguous, and turns the source entry into `index-only`.
- Large rosters whose estimated output exceeds the output limit are unchecked by default.

**How it works**
- Batches are planned by input-token budget.
- Entries in the prompt are addressed by integer `ref`, not UUID.
- The strict JSON schema is `bardLoreAnalysisSchema`, about line 181 of `src/ts/lorebook/bardLoreAnalysis.ts`. Each entry has `ref, kind, activation, aliases, tags, summary, facets, injection, atoms, links[{targetRef, relation, retrieval}]`.
- The provider output limit is respected.
- Invalid JSON gets one full-object retry. A partial-recovery path salvages the valid entries, and truncated runs retry only the failed items in smaller batches (0.9.40).
- The run snapshots its settings, language and instruction preset, so a resume uses the same prompt.
- Applying a draft is refused if the entry's `sourceHash` has changed since analysis.
- Failure diagnostics separate output-limit, context-overflow, refusal and JSON errors.
- Instruction presets are protected; you clone one to edit it.
- Metadata can be moved between installs as `risubard-bard-lore-metadata` v1, with links addressed by handle (`bardLorePortable.ts`).

**Size and coupling.** L, client-only.

#### 2.8.5 Lore Builder (0.9.20)

**What it does for the user.** An LLM assistant, outside the chat, that writes or revises a single lore entry. Context sources: system prompt, description, lorebook, module lore, and a message range (0.9.34). Task and style presets are available in Korean and English.

**How it works.**
- `buildLoreBuilderMessages` (`src/ts/loreBuilder.ts:242`) builds the prompt with escaped `<instruction>`, `<context>` and `<draft>` blocks.
- Related lore is chosen by the real `loadLoreBookV3Prompt`.
- The output is Markdown that the user applies.

**Size and coupling.** S–M, portable.

### 2.9 Prompt preset tooling

#### 2.9.1 Prompt V2 workbench (0.9.23, 0.9.31)

**What it does for the user.** A three-pane editor for prompt blocks (list, editor, preview) with these parts:
- visual and source modes;
- per-block activation conditions edited as a form;
- a **live toggle preview** that shades body text active or inactive for simulated toggle values;
- a "where is this toggle used" search;
- find and replace across blocks.

**How it works.**
- Conditions **compile to plain CBS**, so presets stay upstream-compatible. The output has the form `{{#when::keep::{{equal::{{getglobalvar::KEY}}::VAL}}::and::…}}…{{/when}}` (`compilePromptV2Text`, `src/ts/promptV2.ts:68`).
- Hand-written CBS is detected and marked as not editable in the form.
- The toggle template is parsed into a tree of groups and dividers.
- The same workspace edits the BardWiki prompt presets.

**Size and coupling.** M–L, portable.

#### 2.9.2 Prompt block injector (overlay, 0.9.32)

**What it does for the user.** Extract blocks from other presets, by default those whose title contains `📙`, into "profiles". Map each one to skip, or to go before, replace, or go after a target block of the active preset, **without editing that preset**. Save the combinations as "application presets". A composed preview can be saved as a new preset.

**How it works.**
- `composePromptBlockOverlay` (`src/ts/promptBlockOverlay.ts:471`) runs at request time (`index.svelte.ts:1442`) and in BardPainter.
- Rules reference blocks by `{index, name, type}` and fall back gracefully when the target moves.
- Toggles referenced by the injected blocks can be appended to the toggle template.

**Size and coupling.** M–L, portable.

#### 2.9.3 Toggle presets pinned per chat (0.9.14)

**What it does for the user.** Named snapshots of toggle values that can be applied to a chat. Values are pinned into the chat (`chat.GLGlobalVariables` plus a `togglePresetBaseline`), and the UI shows where the chat has drifted from that baseline.

**Note.** PocketRisu has a `togglePreset` concept too; compare before porting. RisuBard's additions are the per-chat pinning and the baseline diff (`src/ts/storage/togglePresetBaseline.ts`).

**Size and coupling.** S.

#### 2.9.4 Danbooru tag autocomplete (0.9.45)

**What it does for the user.** Tag completion in BardPainter prompt fields, with Hangul jamo and initial-consonant (choseong) search and a weight display.

**How it works.** A Web Worker indexes `public/data/danbooru/db.csv` lazily. If the index cannot load, it fails open and simply shows no suggestions (`src/ts/tagAutocomplete/*`).

**Size and coupling.** S–M, portable.

#### 2.9.5 LLM translation cache manager (0.8.7)

**What it does for the user.** Search, page through (100 at a time), edit, delete, import and export cached translations. Conflict detection per entry stops one window from overwriting another's edits. A late in-flight translation cannot bring a deleted value back.

**Size and coupling.** S–M.

### 2.10 First Message Studio (0.8.10 → beta 0.8.12)

**What it does for the user.** A no-code builder for interactive opening screens:
- multi-step choices that set variables;
- free-text inputs;
- localized strings, with LLM translation of the UI text;
- per-option presentation: speaker, description, and an illustration chosen from the character's assets;
- conditional "scenarios" whose rule groups are ANDed together and whose conditions within a group are ORed;
- skins, scoped custom CSS, and sanitized extra HTML with `{{variable}}` display;
- project import and export.

Cards built with it **still play in stock RisuAI**.

**How it works**
- **Project model.** `FirstMessageStudioProject` (`src/ts/firstMessageStudio.ts:111`) holds stages, options, effects, `nextStageId`, inputs, presentation, variables, localization, appearance and scenario rules.
- **Runtime.** A pure state machine (`applyStudioOption`, `:556`) persists variables as `$name` in `scriptstate`.
- **Storage.** The editable source is `character.firstMessageStudio`, exported as `extensions.risuai.firstMessageStudio` (`src/ts/characterCards.ts:94`).
- **Compatibility compile.** On save, `compileFirstMessageStudioCompatibility` (`src/ts/firstMessageStudioSharing.ts:183`) produces three things:
  1. a plain CBS/HTML first message marked `<!-- risubard-first-message-studio -->`, using `{{getvar}}`, `{{#if}}` and `risu-trigger` buttons;
  2. trigger scripts whose names start with `[First Message Studio] `;
  3. a managed block in `defaultVariables`.

  It replaces only entries it owns. RisuBard renders the native Svelte runtime instead of the compiled version (`Chat.svelte:277`).
- **Sharing.** Project files use the envelope `{type:'risubard-first-message-studio', version:1, project}`.

**Size and coupling.** M (about 1.05k lines of TS and 1.36k of Svelte). **No storage coupling; the most portable feature in the fork.**

### 2.11 Export: Arca.live chat saver and chat-log copy (0.9.3, 0.9.6, 0.9.11, 0.9.40)

**What it does for the user.** Copies one rendered message, or a whole chat or message range, as rich HTML that pastes cleanly into the arca.live editor (a Korean forum). Character CSS, backgrounds, dialogue and thought colours, and images survive. There is a title header with an optional avatar (oval, square or thumbnail-title). Image width, font size and paragraph spacing are adjustable. Inactive messages, comments and placeholders are left out.

**How it works**
- `exportArcaHtml` (`src/ts/arcaExport.ts:719`) walks the **live rendered DOM**:
  - computed styles are inlined through an allowlist;
  - horizontal flex layouts are rewritten as tables;
  - CSS background images become `<img>` data URLs;
  - buttons, inputs, scripts, SVG and iframes are dropped;
  - "complex" blocks are rasterized with `html-to-image`.
- `arcaSemanticFormatting.ts` maps thought, quote, sound and choice markers to fixed palettes.
- `buildArcaLogClipboardHtml` (`src/ts/arcaChatLog.ts:158`) builds the log. The output goes to the clipboard as both `text/html` and `text/plain`. The output is HTML, not BBCode.

**Size and coupling.** M, client-only and portable. The approach (render with the real chat component, then inline an allowlisted subset of computed styles) generalizes to any "share to forum or blog" exporter.

### 2.12 BardPainter and media (0.9.43 → 0.9.67)

**What it does for the user.**
1. Select a passage in a chat message and get a NovelAI V4.5/V5 illustration of that moment.
2. Edit the generated prompt blocks for each subject.
3. Keep saved **character identities and outfits**, either global or per bot (outfits shared across characters since 0.9.58).
4. Use style presets and locked "expression fragments". Lore entries can be linked. The AI can choose the image size.
5. Drag the result to a paragraph in the message.

There is also a gallery per character and chat, and pasting an external image into a message body is supported. Shared generation settings can travel inside the card.

**How it works.**

1. **Selection.** The selection is mapped back to offsets in the source text (`selection.ts`).
2. **Context.** Gathered from lorebook matching, recent chat and BardWiki memory.
3. **Scene plan.** `buildPainterMessages` (`src/ts/bardPainter/prompt.ts:44`) asks an LLM for a v2 scene-plan JSON. The plan has a scene (tags, location, framing, camera), subjects (identity and outfit IDs, appearance, clothing, state, pose fields) and interactions. A malformed or declined plan gets one repair turn.
4. **Compile.** `compilePainterScenePlan` (`src/ts/bardPainter/scenePlan.ts:20`) routes interaction clauses to the right subjects and expands catalog tags.
5. **Image request.** `buildPainterImageRequest` (`prompt.ts:192`) builds the NovelAI v4 payload, using `characterPrompts` and `v4_prompt.char_captions`.
6. **Save.** The image is compressed to WebP with its metadata kept, stored as an **inlay asset that records its owning character and chat**, and indexed in the gallery under `inlay_generation/<assetId>`.
7. **Insertion.** `insertPainterReference` (`src/ts/bardPainter/selection.ts:162`) inserts `{{inlay::<id>}}` at the paragraph you picked.

**Storage.**
- Per chat: `chat.bardPainter`.
- Per bot: `character.bardPainter`, exported as `extensions.risubard.bardPainter`.
- Global: `Database.bardPainter*`.

**Size and coupling.** L (about 3.3k lines of TS and 2k of Svelte). The prompt, scene-plan and request modules are pure. Coupling comes from inlay ownership, gallery storage, BardWiki context, and NovelAI being the only supported provider.

### 2.13 Plugin API

**Summary.** RisuBard adds:
- the `Risuai.bardWiki` API;
- a compatibility shim that projects BardWiki into legacy HypaMemory and SupaMemory fields;
- the provider options `overrideRequestStatus` and `structuredOutput`;
- draggable plugin floating action buttons (FABs) that are confined to the chat area;
- per-plugin chat-output listeners;
- verified plugin updates;
- logging of plugin request bodies and fetches;
- a Lua `setGlobalVar`.

Details are in §4.

### 2.14 UI redesign and theme tokens

#### 2.14.1 Editable semantic theme tokens

**What it does for the user.** Each colour scheme can edit 28 semantic roles: binding, info, success, warning, danger and secondary, each with bg, border and on- variants, plus overlay, shadow, media and switch-thumb. Palettes can be picked visually. Code highlighting and the Monaco editor follow the theme.

**How it works.**
- `src/ts/gui/uiThemeTokens.ts` is a typed registry with labels and dark and light defaults.
- `ColorScheme.uiColors` overrides are accepted only as valid hex. They are emitted as `--risu-theme-*` mapped to `--color-*`.
- `monacoTheme.ts` expands the values to hex, because Monaco cannot read CSS variables.
- `textTheme.ts` picks chat text colours with contrast in mind.

**Enforcement.** `src/lib/UI/GUI/ThemeTokenContract.test.ts` (`pnpm check:theme-tokens`) requires that:
- every token is declared in `styles.css` under `@theme static`;
- global rules contain **no raw hex, rgb, hsl, `white` or `black`**;
- no Tailwind gray or slate scales are used;
- highlight.js is themed through tokens.

**Size and coupling.** S–M, portable. The contract test is the transferable piece.

#### 2.14.2 Modal surfaces and overlay layers

**What it does for the user.** One modal surface style is used across settings, presets, plugins, bookmarks and character management (0.9.2). Overlay tiers are bounded (0.9.15). Dialogs sit above the BardWiki dock, dropdowns sit above dialogs but below confirmations, and toasts never cover confirmations.

**How it works.** There is a `ModalSurfaceContract.test.ts` and a `DialogLayering.test.ts`. The plan `2026-09-02-overlay-layer-system.md` names a `modalLayerStack.ts` that does not exist, so treat it as partly implemented.

#### 2.14.3 Settings and other UI changes

- **Settings navigation** (`src/ts/setting/settingsNavigation.ts`) groups settings into five sections: AI, RisuBard (common settings, wiki prompt, Grimoire prompt), Experience, Extensions and System. Items are filtered by scope (all, full, desktop or dev). Tabbed workspaces wrap the older pages.
- **Startup screen** (`src/ts/startupScreen.ts`). A dependency-free boot screen that shows the current step and retries a failed CSS preload. A failed start reports which step failed.
- **Loading activity** (`src/ts/gui/loadingActivity.ts`). One cancellable foreground load, background chips, and a failure toast.
- **Layout.**
  - Resizable sidebars and an adjustable side-navigator position.
  - Foldable-phone sidebar fixes.
  - A BardWiki "focus view" for desktops at 125% or higher zoom (0.9.72).
  - BardWiki desktop and mobile layout switching (0.9.12).

**Coupling.** None.

### 2.15 Development process and boundary checks

- **`scripts/check-public-boundary.mjs`** (`pnpm check:public-boundary`). Fails if the private roots `src/ts/novelist` or `src/lib/Novelist` exist, if production code imports them, or if it mentions identifiers such as `NovelProject`, `ManuscriptDocument` or `sourceManuscript`. It keeps the private "Novelist" edition out of the public repository.
- **`scripts/check-brand-boundary.test.ts`.**
  - Bans the legacy product tokens `jelly` and `pocketrisu` in tracked and untracked file paths and contents, with a whitelist of exceptions.
  - Also asserts that the "PocketRisu" name stays in backup-compatibility guidance.
  - The `jellybard` → `risubard` storage-key migration in `src/ts/plugins/providerRequestStatus.ts:41` suggests an intermediate "JellyBard" lineage.
- **`scripts/check-release-inputs.cjs`.** Checks that every patch declared in the workspace and lockfile is present in the release workflow's `app-build` file list and is COPYed in the Dockerfile before `pnpm install`.
- **`docs/architecture/change-validation.md`.**
  - Path-filtered CI workflows: `storage-change-check.yml` (Windows and Linux, Node 24) and `dependency-change-check.yml`.
  - Local gates: `pnpm verify:storage-change` (2 client and 5 server test files) and `check:release-inputs`.
  - The release gate `verify:release` runs `check`, `test`, `test:compat` and `build`.
- **`docs/architecture/code-boundaries.md`.**
  - Inherited GPLv3 code stays at the repository root.
  - `packages/risubard-core` holds independently authored, UI-free code, with "no copying or mechanical translation" from the inherited code.
  - `src/ts/risubard` is the adapter layer.
  - The doc's line "no core functionality is introduced" is out of date.
- **Compatibility suite** (`test/compat`, 17 files). It covers:
  - backup round-trip, export stability and restore regressions;
  - upstream replacement and import;
  - account backup import and browser download;
  - direct chat writes;
  - coldstorage and the deferred database;
  - Google service-account tokens;
  - orphan-folder normalization;
  - preset v4 round-trip;
  - remote-block migration;
  - settings-only export;
  - storage observation.

  The vitest config matches PocketRisu's; the suite contents differ.
- **Benchmarks.** `pnpm bench:wiki-scale` runs synthetic 100, 1,000, 5,000 and 10,000-turn wiki scale tests on both client and server.
- **Release process.** The patchnote format is strict: each version has `[기능]` (feature), `[안정성]` (stability), `[성능]` (performance) and similar tags, and an `*-arca.txt` forum copy. Measured numbers are presented as measurements, with their sample sizes and caveats.
- **Plans.** About 110 dated plans in `docs/superpowers/plans/` record goals, global constraints, a "review focus" and tasks. Example: the timeline plan requires that user chat content never goes into test fixtures, because the repository is public.

---

## 3. Concepts and ideas worth borrowing

These are worth considering even if the feature itself is not ported.

1. **Keep evidence, memory and compiled context separate.** Keep the original transcript untouched as evidence. Keep long-lived state in a reviewable store. Compile each request under explicit limits. The docs repeat that "tokens are a cap, not a quota". The long-chat experiment (`docs/ko/memory-wiki-long-chat-experiment.md`) gives the measured cost: 17,247 input tokens against an estimated 67,950 for a full transcript, at turn 21.

2. **Required context fails loudly; optional context degrades quietly.** If a required source cannot be loaded, the request stops with an error rather than being trimmed. Optional sources may be left out, and the trace records why. When a canon page *is* trimmed, it carries this marker: "omitted parts are not evidence of absence". That marker is a cheap guard against the model treating absence as fact.

3. **Verify that injection actually happened.** The diagnostic searches the *final* formatted prompt for each `[source "id"]` tag, after preset and Lua edits, and reports one of injected, partial or not-injected. A pipeline with programmable prompt edits needs this; without it, "we retrieved X" says nothing about "the model saw X".

4. **Injection manifest and purpose taxonomy on every model call.** Record per-source token attribution as `{kind,name,tokens}`, with any remainder labelled "overhead". Use a fixed list of request purposes that the client and the server whitelist share. Offer a per-chat evidence report that contains no message bodies. This makes cost and "why did it forget X" questions answerable.

5. **The program owns structure; the model supplies meaning.** The LLM returns a schema-bound draft. The application decides IDs, file paths, frontmatter and links, and serializes to Markdown. The writer contract lives in the repository as a Markdown skill file imported raw as the system prompt (`src/ts/risubard/skills/bardwiki-memory-writer/`). Official prompt presets are versioned and never overwrite user presets.

6. **Section patches with hash preconditions.** Update memory pages by heading-level `upsert` and `delete`, leave untouched sections byte-identical, and refuse a write when the stored content hash has moved. Archive every replaced version. The same idea at block level is in BardChat: block IDs come from position plus SHA-256, so no markers are inserted into the canonical text.

7. **A confirmation boundary for memory.** A reply becomes memory only when the user continues past it or confirms it. Rerolls and swipes are never recorded. Each confirmed turn stores a receipt with source IDs, changed documents and `afterHash`, which makes the operation idempotent to retry.

8. **Deleting evidence retracts what was derived from it.** Before deleting messages, retract the memory events derived from them, and abort the deletion if that fails. Be explicit about what is *not* rolled back.

9. **Save slots as the single rewind boundary.** Instead of keeping per-turn memory snapshots, offer save/load points that snapshot chat plus memory together, deduplicated through a content-addressed page store. Loading restores the story, not the user's current preferences: persona, preset, model binding and toggles stay as they are. Autosave runs only after generation and memory writing have both finished.

10. **Two-phase fork with a pending marker.** Stage the derived data, save the primary record, then finalize, or discard if the save failed. RisuBard uses this for chat copy, Vault clone, save load, reboot and wiki import.

11. **A cache-friendly placement option.** Put per-turn volatile memory just before the latest user message, so the preset, description, lore and older chat form a stable prefix for provider prompt caching. It costs little to offer as a toggle.

12. **Timeline cues instead of trusting dates.** "N turns ago" labels and a short "recent flow" list of event titles, computed from message order, replace unreliable in-story dates. This is cheap and addresses a common long-chat failure.

13. **Compaction with measurable guardrails.** Compact a memory page only past a size threshold and with hysteresis (0.8× budget, then 1.25× growth before the next pass). Drop only items that are covered elsewhere, measured as at least 60% bigram overlap. Restore the original if a wiki link would vanish. Discard any result that is not at least 10% smaller.

14. **Protocol for borrowing a legacy plugin.** Expose new memory to old plugins as a virtual projection in the fields they already read (`hypaV3Data.summaries` and similar). Inject it only into the clone handed to the plugin, and strip it on save (`src/ts/risubard/pluginBardWiki.ts:93,123`).

15. **Compile to an upstream-compatible fallback.** First Message Studio compiles to CBS plus triggers, and Prompt V2 compiles to CBS `#when` blocks. The rich editor is a fork feature, but the artifacts still run in stock RisuAI. This keeps cards shareable.

16. **Side-table metadata for third-party content.** Grimoire stores search metadata keyed by entry ID plus a source hash instead of rewriting lorebook entries. AI-drafted metadata goes through draft, then review, then apply. Applying is refused if the source hash has changed since the draft was made.

17. **Read query filters from the last user message only.** Treat history as evidence, never as a command, and log the reason for every exclusion: kind mismatch, token limit, requested count and so on.

18. **External-edit policy.** Never silently overwrite a file another program changed. Pause saving and show diffs at field and lore-entry level, with secrets masked. On "keep app", back up the external version to trash. Report broken JSON with its line and column. Adopt files edited while the app was closed on the next read.

19. **Storage-integrity habits.**
    - A sha256 sidecar on every file.
    - Temp file, fsync, verify, rename, then fsync the directory.
    - A forward-replayed journal for multi-file commits.
    - A data-root process lock.
    - Reject roots on filesystems without reliable rename and fsync (Android shared storage).
    - Stat-stamp caches treated as *hints*, with re-hashing inside a 5-second "racy" window.
    - A background shadow comparison between the canonical files and the compatibility projection.
    - Diagnostic reports that contain no personal data.

20. **Performance tests that count I/O, not time.** Assert zero body reads and zero index writes for an unchanged sync, so a fast developer machine cannot hide a regression (`docs/ko/asset-integrity.md`).

21. **Scriptstate checkpoint per response.** Keep `before` and `after` variable state on the latest reply only, so rerolls and swipe switches restore variables correctly without unbounded growth.

22. **Boundary checks as tests.**
    - A public/private boundary scanner.
    - A banned-brand-token test.
    - A release-input checker that matches workflow file lists, the Dockerfile and lockfile patches.
    - A theme-token contract test that bans raw colours.
    - Path-filtered CI gates for storage changes.

23. **Script safety.** Lua `setGlobalVar` refuses `toggle_*` keys so bot scripts cannot flip preset toggles (`src/ts/process/scriptings.ts:153`).

24. **Honest documentation.** Docs and patchnotes separate measured from estimated numbers, give sample sizes, and say what was *not* validated. Examples: "recall targets of 80% and 96% are goals, not achieved"; "no full-transcript A/B was run". Rolled-back features are announced as rolled back: V2 storage, batch analysis, the chronology tab, live file watching.

---

## 4. Plugin API additions

All of the following were absent from the PocketRisu checkout at v1.15.0. Types are in `src/ts/plugins/apiV3/risuai.d.ts`.

### 4.1 `Risuai.bardWiki` (0.9.36)

The full reference is `docs/ko/bardwiki-plugin-api.md`; the implementation is `src/ts/risubard/pluginBardWiki.ts`, 492 lines. It is also reachable as `risuai.bardWiki`.

**Methods**
- `getContext({ query? })` returns `{ content, sources, recentMessages, metrics }`.
  - `content` is ready to insert into a prompt.
  - `recentMessages` follows the chat's "response recent messages" setting and always includes the latest user message.
  - If `query` is omitted, the latest user message is used.
- `getDocuments({ types?, statuses? })` returns documents with these fields: `id`, `type`, `status`, `title`, `aliases`, `content`, `links`, `contextMode` and `contentHash`. The server's `wikiPath` is **never** exposed.
  - Types: event, character, location, scene, faction, creature, item, concept and other.
- `saveDocument({ documentId?, type, title, aliases, markdown, expectedContentHash? })` creates or updates a document. `expectedContentHash` gives optimistic concurrency: if the hash is stale, the call throws, and the plugin must re-read and merge.
- `setContextMode({ documentId, contextMode: 'always'|'auto'|'never', expectedContentHash })`.
- `trashDocument(id)` moves the document to the BardWiki trash.

**Scope and permissions**
- Every call is scoped to the current character and saved chat. A plugin cannot name another chat or a server path.
- Reads need no permission.
- The first write asks for a per-plugin BardWiki write permission. If the user denies it, the call returns `null`.
- Validation failures, a stale hash, or "no saved chat" throw.

### 4.2 Legacy long-term-memory compatibility shim

Plugins that read chats through `getCharacter()`, `getChar()`, the index getters or the permitted database getters receive a **virtual BardWiki context** in three fields: `chat.hypaV3Data.summaries`, `chat.hypaV2Data.mainChunks` and `chat.supaMemoryData`.

- The context contains the retrieved documents and the configured recent messages.
- It is marked `bardwiki-plugin-context-v1` and exists only in the returned clone. `stripBardWikiVirtualMemory` removes it if the plugin saves the object back.
- If the lookup fails, the getter returns the original data.
- A 30-second, 32-entry cache (`src/ts/risubard/pluginContextCache.ts`) prevents repeated reads.
- The docs advise turning off any "send full transcript" option in such plugins.

### 4.3 Provider registration options (`docs/ko/plugin-provider-compatibility.md`)

- **`addProvider(name, fn, { overrideRequestStatus })`**
  - Accepts a boolean or a sync or async callback. It suppresses RisuBard's advanced request-status window for providers that draw their own (0.8.8).
  - The older inverse option `hostRequestStatus:false` and `hostRequestStatusStorageKey` are still honoured. The latter migrates `jellybard` keys to `risubard` (`src/ts/plugins/providerRequestStatus.ts:41`).
- **`structuredOutput: true`**
  - The host passes `args.structured_output` and `args.response_schema{name,strict,schema}` to the provider, and still keeps a schema prompt as a fallback.
  - If the provider rejects the native field, the host retries once without it (`shouldFallbackFromNativeStructuredOutput`, `src/ts/plugins/providerStructuredOutput.ts:103`).
  - The docs ask plugins not to post-process JSON text.
- Since 0.9.9, plugin providers that do not stream are supported in internal calls. Since 0.9.19, v3 provider registration is supported.

### 4.4 Smaller plugin-facing additions

- **Draggable action buttons.** `registerButton` with `location:'action'` gets draggable FABs with a 6 px drag threshold. They are keyboard-movable, confined to the chat panel rather than floating over BardWiki, and their position is stored as viewport ratios keyed by plugin plus `id` (or name). See `src/ts/plugins/floatingActionButtonLayout.ts`; this is the only `plugins.md` change.
- **Chat-output listeners** (`src/ts/plugins/pluginChatOutput.ts`). Listeners are owned per plugin and cleaned up on unload. Listeners receive a serialized snapshot argument (`char`, `chat` and the indices). A v2 compatibility owner is included. The 0.8.12 patchnote also lists screen-wake-lock permission (the iframe `allow="screen-wake-lock"`, `apiV3/factory.ts:809`) and an inlay access permission.
- **Request logging.** Plugin provider requests are logged with an injection manifest, a body, and locally counted output tokens (`src/ts/process/request/pluginRequestEvidence.ts`). Plugin `nativeFetch` and `risuFetch` calls are logged separately with headers and bodies (`src/ts/plugins/pluginFetchLogging.ts`, 0.9.39).
- **Verified updates** (`src/ts/plugins/pluginUpdate.ts`). Fetches with `no-store`, reports success only when the installed script actually changed and was saved, and retries through the server when the browser fetch fails.
- **Plugin source editing** (0.9.22) and plugin folders through the collection organizer.
- **Fullscreen plugin layering** (`src/ts/plugins/apiV3/pluginFrameLayer.ts`). A fullscreen plugin iframe drops below host permission dialogs that the plugin is waiting on (0.9.70).
- **Lua `setGlobalVar(id, key, value)`** (0.9.72, `src/ts/process/scriptings.ts:153`).
  - Persists a global variable across chats.
  - Refuses empty keys and `toggle_*` keys.
  - Bots can feature-detect it with `if setGlobalVar then`.
- **HTTP origin support.** API v3 plugins work over plain HTTP on a LAN, because the secure random generator falls back to a method that works there (0.9.39).
- **`parseRisuChat`** (0.9.63 patchnote). It also exists in PocketRisu now; the origin is unclear.

---

## 5. Known limitations, experiments and documented gaps

### 5.1 Experiments and targets the authors marked as not done

- **Long-chat experiment** (`docs/ko/memory-wiki-long-chat-experiment.md`, 2026-08-22). One session, 21 answers, Gemini 3.7 Flash.
  - The final request used 17,247 input tokens against an estimated 67,950 for the full transcript (3.9×).
  - Cumulative input was 873,836 tokens against an estimated 1,257,690 for full transcript plus a memory engine (43.9% more). Against full transcript alone the totals are almost equal (1.02×), because wiki writing itself cost 322,812 input tokens.
  - Quality: all 4 key events were recovered, with 2 small compression errors.
  - **No A/B against the full transcript was run.** The comparison is counterfactual, computed with `cl100k_base`.
- **Long-chat checkpoint** (`docs/architecture/2026-09-29-bardwiki-long-chat-checkpoint.md`).
  - The recall goals of 80% (paraphrased questions) and 96% (questions with identifiable names) are **targets, not measured**.
  - The semantic scale tests use deterministic vectors.
  - Synthetic scale runs at 100 to 10,000 records showed final wiki usage of 489 to 901 tokens and local lookup of about 85 to 168 ms. These are not real-chat guarantees.
  - Automatic splitting of character pages into topics was **not** implemented.
  - The per-character chronology tab was rolled back by user request.
  - Undecided items: the Markdown form of partial-section IDs, metadata for linking characters to the chronology, the incremental format for the semantic index of original messages, and the coefficients for each mode.

### 5.2 Features that were rolled back or retired

| Feature | Shipped | Outcome |
| --- | --- | --- |
| V2 named-folder storage | 0.9.26–0.9.27 | Rolled back in 0.9.28; offline converter added |
| BardWiki "Batch analysis" | 0.9.32 | Rolled back in 0.9.33 after HTTP 400 errors |
| Recursive `fs.watch` live file monitoring | 0.9.41 | Removed in 0.9.66; it stalled servers on Linux, Docker and Termux. Replaced by polling and conflict review (0.9.69) |
| "External edit session" mode | — | Now unreachable code |
| Character chronology tab | 0.9.52 | Removed in 0.9.53 |

Other items in this category:
- The legacy v2 structured graph memory survives only for old wikis.
- The "unreviewed / `.risubard-review`" acceptance flow is implemented but never triggered by automatic writes.
- Per-turn wiki snapshots and per-document undo were removed in favour of save slots (0.9.2).
- `planCharacterPackage` (owned versus global resources per character) is a schema that is never activated.
- The V3 and V4 per-character and per-module asset folders are opt-in developer pilots, with no automatic bulk transition.
- First Message Studio is labelled **beta**.

### 5.3 Documentation that does not match the code

These are mismatches found during this survey.

- **Budget defaults.** `docs/ko/memory-wiki.md` still gives defaults of 2,000 / 2,000 / 6,000. The code uses 4,000 / 3,000 / 2,000 / 7,500 (preset "보통").
- **Recent-message count.** The same doc says the response recent-message count counts messages including the current input. The code counts assistant turns.
- **Required pages over the limit.** The same doc says required pages over the limit stop generation. In the code, they fail the request only when the whole model context cannot fit them. The route's `budget-exceeded` mapping (`risubard-memory-routes.cjs:634`) is vestigial.
- **Request log bodies.** The README says request logs omit bodies, URLs and keys. The developer request log stores request and response bodies (masked, each capped at 2 MB) and masked URLs. Only the evidence report, the context trace and the activity log are body-free.
- **Trash on delete.** The docs say "deletes move to trash". Whole-character deletion is a hard `rmSync`. `.bak` files and trash are never pruned.
- **Review flow.** The README says automatic wiki changes are "marked unreviewed". Automatic saves use `reviewStatus: 'reviewed'`.
- **Dynamic budget formula.** The design note proposes a turn-based `log2` formula. The code eases out over characters with a plateau at 500k, and the long-chat test feeds turns into it.
- **Code boundaries.** `docs/architecture/code-boundaries.md` says no core functionality has been introduced. `packages/risubard-core` is used in production.
- **Overlay plan.** `2026-09-02-overlay-layer-system.md` names a `modalLayerStack.ts` that does not exist.
- **Baseline path.** The "current narrative baseline" path is dormant. `prepareContext` returns `baseline: null` because `nativeV2Analysis: true` is always set.
- **Unused module.** `src/ts/chatViewSession.ts` has no importer outside tests.

### 5.4 Durability and robustness gaps visible in the code

- BardWiki and vector writes use temp file plus rename **without fsync**. This is unlike the canonical store. It is acceptable for vectors, which are a cache, but less so for wiki pages.
- BardChat undo lives in server memory, so a restart loses it. The canonical-maintenance cooldown and the session lock are also held in memory.
- Parent-directory fsync is skipped on Windows.
- Chat paging limits transfer size, but the client still holds the full message array.
- Compaction cannot verify that meaning is preserved. It only enforces link preservation, coverage of at least 60% of bigrams, and at least a 10% size reduction. The plan acknowledges this as a remaining risk.
- A transient "empty JSON parse at startup" was reported in 0.9.40. The root cause was not found.
- Long OOC runs are not counted against the message limit and can grow tokens without a cap. The OOC notepad help text warns about this.
- If remote embeddings are enabled, new chat-message segments are sent to the chosen embedding provider. The initial indexing cost and storage grow with chat length, and local candidate scanning is linear.
