# Structured Memory evaluation fixtures

What is here measures the read path of Structured Memory over records a scripted writer produced from
a deterministic chat, and the token shape of writing and reading beside HypaV3 on the same chat. The
writer behind the records is a script that answers each window with the story's own plan, and the
embedding is a lexical hash of a text's terms. So every figure here is a pipeline check: it says how
admission, retrieval, the card, and the budget treat known-good records. It says nothing about what a
model would record or recall, and no figure from here is a recall figure. A real-model comparison is
the export and the rubric below, graded by a person.

## Files

- `story.ts`: the generator. `generateStory({ language, turns, seed })` gives a chat of `turns` turns
  over a cast of ten, six places, and eight items, each turn's scripted analysis answer and page
  patches (pages named by title), the final scene's attendance, and the labelled probes. A reply
  holds its beat's key sentence and two detail lines verbatim; the answer quotes those three as its
  key lines, no quoted line repeats across turns, and the summary is a sentence in other words, so an
  event embeds four texts as a real writer's would. Pure and seeded: its own PRNG, no clock, no random ids. Twenty turns is the least a story holds every beat
  the probes need. Nothing generated is committed; the word lists and the rules are the fixture.
- `scriptedWriter.ts`: the chat upstream (`createScriptedChat`), which tells analysis, patch,
  compaction, and HypaV3 summary requests apart by their frames, checks an analysis request holds its
  window's message text, a patch request its admitted event, and a compaction request the section
  body the script wrote, and throws on anything else; and the embedding upstream
  (`createScriptedEmbeddings`, `lexicalEmbedding`): a signed 256-slot hash of `lexicalTerms`,
  normalized. Both record what they were asked.
- `harness.ts`: `createFixture` puts the story's chat in a real resource store on a temp dir, with the
  real request layer, embeddings over a real vector cache (wrapped only to count reads), the token
  counter over injected tokenizers, and the real memory task service. `rebuild` records the chat
  through the real rebuild run (one-turn windows, the chain of tasks, the swap); `summarize` is the
  HypaV3 side through the real hand-off until the lookahead plan settles; `send` is
  `readMemoryRecords` plus `selectMemory` over the stored chat and one in-memory user message (under
  HypaV3, `prepareHypaV3` plus `selectHypaV3`, select only). `applySetup` retracts an event through the
  event repair, edits a message through `applyChanges`, or hides a page. `createStubTokenizers`
  gives a deterministic count for a gate; the tool injects the real tokenizers.
- `evaluate.ts`: pure scoring and the ledger. `resolveLabel` maps `event:<turn>` (by the reply's
  message id in an event's sources), `page:<title>`, and `thread:<title>` to records and throws on an
  unresolved label. `scoreProbe` scores one probe over a send's manifest and card text;
  `summarizeScores` gives the rates per kind over distinct records. `writerLedger`, `sendLedger`,
  `analysisOverhead`, and `analysisSlotSizes` count the captured calls and sends with any counter.
- `measure.ts`: the measurements that need no story: cache reads beside `addText`, checkpoint saves
  with a replayed attribution, the health read over many events and runs, and the revisions route
  under the real limiter on a listening server.
- `util/memoryEval.mjs` (repository root): the tool that runs the sections and prints the tables.

## What the probes check

Each probe is one send: the whole stored chat plus one new user message, at the story's real final
scene, whose last turns are neutral small talk so that no tail text opens a lane by itself.

- `needed`: the named records must be in the selection manifest. The design's lanes find an event
  by its text (the query mirrors the event's own sentence, with a cue that reads as past), a page by
  its name in the query, a thread by its parties being on stage.
- `mustNotLeak`: a quarrel retracted through the event repair, a find whose reply was edited after
  recording (reconciliation reads the event stale), and a place's page set to `never`. The record
  must be absent from the manifest. Its raw message may stay in the prompt by design, so no text
  absence is checked.
- `knowledge`: a secret told by one character to another; a third is on stage. That character's page
  line in the card must hold the fact only after `does not know:`.
- `comparison`: where an item was hidden and where it was found later: two events, both needed, and
  the rate of comparisons with every part present.
- `unanswerable`: a question about something that never happened, with labelled real events sharing
  a word with it (the silver flute beside the asked silver violin). The score is how many distractors
  were selected, reported as is; lanes opening is not a failure. A second probe repeats nothing and
  shows what the lanes select on their own.

Capture is needed records found over distinct needed records, exclusion forbidden records absent over
distinct forbidden records, both over the manifest (`selected.items`, none of them verified by a final
prompt). A label that names no record throws: it is a fixture error, never a miss.

## Running

```
node util/memoryEval.mjs [--lang ko,en] [--turns 100,1000] [--seed N] [--dir path]
                         [--section eval,ledger,send,checkpoint,estimate,health,rate]
                         [--json file] [--export dir] [--repeat N] [--max-context N]
```

The default sections are all but `rate`, which runs six cases of 65 s of real time on a listening
server and must be asked for. Each section prints its conditions (Node and SQLite versions, tokenizer
families, the file system of `--dir`, the repeat count). `--max-context` (default 16384) is the send's
and the writer's context, and a fifth of it the memory budget of both algorithms; a 100-turn English
chat fits it, so HypaV3 summarizes nothing there and the ledger compares at 1,000 turns.
`--json` keeps the raw values. The run exits
non-zero on a window that did not record, a label that resolves to no record, or a scripted request
the story did not expect. Temp databases go under `--dir` (default the OS temp dir) and are removed.

- `eval`: the probe table and the rates per kind, with whether the events lane opened and why, and
  the best lexical cosine between the query and the records it mirrors.
- `ledger`: writer input and output tokens by call kind (analysis, patch, compaction) and, on the same
  chat in a second store, HypaV3's summary calls; per send, the card's tokens and the raw history
  kept, under each tokenizer family. Same `maxContext`, same memory budget, no random lane. A
  token-shape ledger: HypaV3's summaries are a fixed share of their window, so it compares nothing
  about capture.
- `send`: `readMemoryRecords` and `selectMemory` timed apart, with the nested `addText` shown as "of
  which" (the prototype method is timed while it runs as it is), `cache.get` calls, the selection's
  own `tokenizeChat` calls and busy time (the tokenizer the send gets is wrapped to count, overlapping
  calls counted once, nothing else changes), the longest gap between two `setImmediate` ticks during
  the send (how long the thread was held), and the writer
  task's two planning reads labelled as not part of a send; then cache reads alone beside `addText`
  over 1k to 8k warm texts with a fresh processor per pass. The scripted embedding answers without
  real I/O, so a production send yields once more, at the query's embedding call, than this one.
- `checkpoint`: a first and a second save through the real transaction, on the fixture's records and
  on 2,000 synthetic runs of 32 KiB, with journal and synchronous modes; then the same page work
  replayed step by step on a scratch table, labelled an attribution with its residual, not a split of
  the real save.
- `estimate`: the cost preview (`memoryWorkCost`, bytes over three plus a constant per call) against
  the analysis calls' actual input under each family, the patch and compaction calls listed beside
  and never counted against it, the per-call overhead over the window's raw text for the first and
  last tenth of the calls with the slot sizes, and the window text's bytes per token.
- `health`: `readHealth` under the round budget over one chat with 1k, 5k, and 20k events, larger
  event bodies, 1k to 20k runs, 64 chats of 1k events, and 64 chats of 5k events and 5k runs, each
  in its own store, with the store's setup time beside (it is said so when it passes a minute).
- `rate`: a real server with the default limits on loopback; a serial walker that calls the revisions
  route for one chat whenever that chat settled two seconds or more ago, 60, 70, and 200 chats, 200
  with 40 ms after each call, 200 with a resource read before each call, and 60 beside a neighbour
  route on the same limiter. The client code does not run; the walker only reproduces its window.
- `--export dir` writes, per language and turn count, a `risuChat` version 2 file the app imports and
  a `probes.json` with the queries, labels, setups (each with its `target`: the turn, its event's
  title, and the reply's message id, or the page's title, and for an edit the text to write), and a
  rubric.

## The real-model comparison

The export is the recipe's input. Import the chat into a character named as in `probes.json`, with
its greeting as the first message, once per algorithm from the same baseline; let each algorithm build
its own memory with the real model and wait for the writer or the summaries to settle; then send each
probe from a fresh branch of that chat, never one after another in one branch, and grade the reply
by the rubric. A figure from that run is quoted with the model and the embedding model named, and
the token use of each arm beside it. The fixtures here cannot stand in for it.

## Differences from a live chat

The rebuild drives the writer: `manual: true`, staged tables and a swap, no receipts on messages, no
pause, and every window one turn. The probe's user message is kept in memory and never stored. The
HypaV3 side runs the real hand-off, with the preset pinned (`PINNED_PRESET` in `harness.ts`).

## Sizes

The generated data is not committed; `storySizes` reports a story's message count, message bytes, and
JSON bytes, and the tool prints them for each fixture it builds.
