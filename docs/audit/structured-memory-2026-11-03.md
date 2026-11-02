# Structured Memory evaluation (2026-11-03)

What Structured Memory costs and selects on deterministic fixture chats, and how a real model should be compared with
HypaV3 later. Measured at `01de92df1` with `util/memoryEval.mjs`. Production code is unchanged, and nothing below was
fixed here.

**No figure in this file is a model's recall.** No model ran. The writer is a script that answers every call with
known-good records, and the embedding is a hashed bag of `lexicalTerms`, which sees shared terms and nothing else. The
capture figures say how the read path treats good records under that embedding. D14 lets a recall figure be quoted only
when it was measured on these fixtures with the model named, and that has not happened.

## Conditions

- Machine: WSL2 on Linux 6.18, 24 logical CPUs, Node 24.21.0, SQLite 3.53.4, WAL with `synchronous` 2. One process, no
  other measured load, on a machine other sessions share. Timings are medians of seven unless a table says otherwise.
  Read them as orders of magnitude for this machine, not as budgets.
- Storage: tmpfs, except the rows marked ext4. tmpfs flatters every write.
- Fixtures: seed 1, generated, not committed. `story.ts` builds Korean and English chats with a cast of ten, six places,
  and eight items. Each turn is a user message and a reply. Each event gets a summary of its own and three key lines
  quoted verbatim from the reply, so admission verifies them.

| Fixture | Messages | Message text | Events | Pages | Threads left open |
| ------- | -------- | ------------ | ------ | ----- | ----------------- |
| ko-100  | 200      | 65,503 B     | 95     | 25    | 2                 |
| en-100  | 200      | 50,094 B     | 94     | 25    | 2                 |
| ko-1000 | 2,000    | 645,758 B    | 984    | 25    | 1                 |
| en-1000 | 2,000    | 490,307 B    | 975    | 25    | 1                 |

- The committed sources are about 220 KB: the generator, the scripted upstreams, the harness, the scoring, the
  measurements, the tool, and a gate test. Message text averages 245 bytes in English and 323 in Korean, which is short
  for a roleplay. Every ratio below that sets window size against prompt overhead depends on that.
- The driver: a clean store, then the real rebuild with one-turn windows, through the real request layer, writer,
  admission, patches, compaction, swap, and vector cache. Only `fetch`, the clock, and workers are faked. A live hand-off
  differs: a rebuild is `manual`, staged, writes no receipts on messages, and ignores the pause. Every window recorded,
  with no unverified quote.
- A send here is `readMemoryRecords` plus `selectMemory`. `structuredMemoryStep` is private, so admission, the rest of
  assembly, the hand-off, and the final prompt's verification are outside these numbers. Manifest items stay
  `verified: false`.
- Context is 16,384 tokens with a 400-token response, and memory gets a fifth, 3,276 tokens, unless a row says 32,768.

Run it again with:

```bash
node util/memoryEval.mjs --lang ko,en --turns 100,1000
```

`--section rate` adds 65 s of real time per case, and `--dir` chooses the file system.

## A 1,000-turn send

Warm vector cache, tmpfs, one query that opens the events lane and one control that does not.

| Fixture | `readMemoryRecords` | `selectMemory` | of which `addText` | of which tokenizer | `cache.get` | Longest stall |
| ------- | ------------------- | -------------- | ------------------ | ------------------ | ----------- | ------------- |
| en-1000 | 44 ms               | 520-550 ms     | 194 ms             | 296-327 ms         | 3,892       | 576-605 ms    |
| ko-1000 | 64 ms               | 543-584 ms     | 184 ms             | 324-356 ms         | 3,926       | 622-657 ms    |
| en-100  | 4 ms                | 62-100 ms      | 13 ms              | 43-80 ms           | 438         | 69-106 ms     |

The tokenizer column counts the time any `tokenizeChat` is in flight, about 2,100 calls a send at 1,000 turns. Both "of
which" columns are parts of `selectMemory`, shown so nothing is counted twice.

- **`addText` is quadratic, and it is not yet the main cost.** A fresh processor over a warm cache:

  | Texts | Cache reads alone | `addText` | The scan's share by difference |
  | ----- | ----------------- | --------- | ------------------------------ |
  | 1,000 | 33 ms             | 36 ms     | 3 ms                           |
  | 2,000 | 75 ms             | 89 ms     | 14 ms                          |
  | 4,000 | 143 ms            | 203 ms    | 60 ms                          |
  | 8,000 | 285 ms            | 517 ms    | 232 ms                         |

  The scan quadruples per doubling. At the four texts per event seen here, a 1,000-turn chat spends about 60 ms on it and
  143 ms on cache reads, and the scan overtakes the reads only past about 10,000 texts. A writer at the five key lines
  `keyLinesPerEvent` allows would get there at about 1,700 turns.

- **One `loadVector` per text holds:** `cache.get` is about four per event, and each read hashes a key, runs a statement,
  and copies a vector.
- **The largest single part is the tokenizer, which the plan did not name.** `selectMemory` counts every entry that
  leaves the prompt, about 2,000 at this length, and then each candidate line.
- **The claim about `readRecordedMessages` is corrected.** A send parses every event and page once, in
  `readMemoryRecords`, and `recordedMessages` then reads the result in memory. `readRerecordEvents` and
  `readRecordedMessages` are the task's planning (`memoryTasks.ts`), not the send's: 21 + 21 ms in English, 24 + 25 ms in
  Korean, once for each hand-off that plans windows. They are two more full parses of the events, one after the other.
- **The stall is the whole send here, and that overstates production.** The scripted embedding answers without real
  I/O, so nothing reaches the macrotask queue. A production send yields at its query's embedding call. Everything before
  that call still runs in one stretch: the read, the reconciliation, and a warm `addText` over the event texts.

Worth doing, in order of return for the risk: a `Set` in `addText`'s filter, one read that loads many vectors, and a
token count kept per message so a send does not count the same 2,000 entries again. `embeddings.ts` is a statement for
statement port, so the first two change that file's rule, though neither changes a result.

## Checkpoint save

Real saves through `applyChanges` with `tx.save`, on fresh databases. "Second" repeats the save with nothing changed.

| Records                                     | Stored  | Encoded  | Filesystem | First  | Second |
| ------------------------------------------- | ------- | -------- | ---------- | ------ | ------ |
| 2,000 runs of 32 KiB input                  | 79.2 MB | 104.6 MB | tmpfs      | 756 ms | 494 ms |
| 2,000 runs of 32 KiB input                  | 79.2 MB | 104.6 MB | ext4       | 951 ms | 512 ms |
| en-1000 as rebuilt (975 events, 1,000 runs) | 28.8 MB | 33.1 MB  | tmpfs      | 306 ms | 243 ms |
| en-1000 as rebuilt                          | 28.8 MB | 33.1 MB  | ext4       | 411 ms | 227 ms |
| ko-1000 as rebuilt                          | 32.8 MB | 37.2 MB  | tmpfs      | 504 ms | 416 ms |

The 5d figure of about 660 ms is the right order for that shape. 64 MB counted the inputs alone; the rows hold 79 MB and
encode to 105 MB. These holds are synchronous, and a save runs at each automatic checkpoint (off until a person sets a
policy, every 5 turns in the dialog's default) and at each load's safety checkpoint. The ko-1000 hold is larger than the
English one at similar size because reading and measuring non-ASCII text costs more.

Replayed attribution of the second save. It repeats the save's steps on a scratch page table, so it shows where the time
goes and is no instrumented split of the real save. Its parts plus a residual make its own total.

| Records           | Total  | `JSON.stringify` | Page SHA | Read   | Join  | Inserts | `byteLength` | Row-id SHA | Residual |
| ----------------- | ------ | ---------------- | -------- | ------ | ----- | ------- | ------------ | ---------- | -------- |
| 2,000 runs, tmpfs | 512 ms | 253 ms           | 102 ms   | 57 ms  | 45 ms | 12 ms   | 15 ms        | 12 ms      | 16 ms    |
| en-1000, tmpfs    | 245 ms | 71 ms            | 74 ms    | 30 ms  | 22 ms | 19 ms   | 6 ms         | 13 ms      | 11 ms    |
| ko-1000, tmpfs    | 444 ms | 88 ms            | 85 ms    | 112 ms | 43 ms | 43 ms   | 30 ms        | 13 ms      | 31 ms    |

Nothing is inserted on the second pass: `INSERT OR IGNORE` finds every page.

**A hash cache is not worth it.** Two designs were weighed.

- A cache of page text to hash: key the page text, value its SHA-256. It removes page hashing alone, about 20 to 30%
  of the hold, and still builds every page, so the key costs what the hash saved.
- A cache of finished manifests: key the chat and its memory revision, value the chunk hashes by kind, invalidated by any
  memory write and checked against page retention. It would skip nearly everything for a chat whose memory did not move.
  But the memory revision moves with every recorded turn, so an automatic checkpoint, which follows new turns, misses it
  by construction. It helps only a load's safety checkpoint of an idle chat.

The hold is the stored bytes, so the cheaper answers are fewer bytes and one encoding less:

- Drop `input` from a run once it is recorded. The only reader found is `replayedInput`, which reads the newest run that
  did not record; the Log route strips it. Whole-row readers (snapshots, the package, copies) were not traced, so confirm
  those first.
- `JSON.stringify` of an already-JSON row is 30 to 50% of the English and synthetic holds. Storing the row text without the
  second encoding is a checkpoint format change, so it needs a reader for both forms.

## The cost preview

`memoryWorkCost` (mode rebuild, one turn) before the run, against the analysis calls' real input. Prompts are counted
from what reached the `fetch` boundary, with real tokenizers. The preview covers analysis input alone, so the other calls
are beside it, not against it.

| Fixture | Calls | Preview   | Actual, `o200k_base` | Actual, `cl100k_base` | Actual, `claude` | Ratio     | Patch input, `o200k_base` |
| ------- | ----- | --------- | -------------------- | --------------------- | ---------------- | --------- | ------------------------- |
| en-100  | 100   | 166,698   | 188,483              | 189,873               | 192,604          | 1.13-1.16 | 89,875                    |
| ko-100  | 100   | 171,835   | 226,923              | 273,198               | 287,076          | 1.32-1.67 | 98,119                    |
| en-1000 | 1,000 | 1,663,436 | 2,210,864            | 2,224,012             | 2,271,322        | 1.33-1.37 | 1,451,147                 |
| ko-1000 | 1,000 | 1,715,253 | 3,025,239            | 3,791,626             | 3,971,501        | 1.76-2.32 | 1,868,834                 |

Both starting values are off, and only one of them matters.

| Fixture | Bytes per token, `o200k_base` | `cl100k_base` | `claude` | Overhead per call, first tenth to last, `o200k_base` | Overall, three families |
| ------- | ----------------------------- | ------------- | -------- | ---------------------------------------------------- | ----------------------- |
| en-1000 | 4.29                          | 4.16          | 4.15     | 1,824 to 2,106                                       | 2,096-2,153             |
| ko-1000 | 3.46                          | 2.27          | 2.09     | 2,194 to 2,966                                       | 2,838-3,662             |

- Overhead is (analysis input − raw window tokens) / calls. It holds the frame and format, about 800 tokens by a small
  prompt, then the cast, scene, threads, and previous messages. It grows with the chat because the cast slot does: 1,953
  to 3,263 characters in English. Page text in Korean costs far more tokens per character.
- Bytes÷3 sits between the languages. It reads about 40% high for English under every family. For Korean it reads 15%
  high under `o200k_base` and 32 to 44% low under the other two. It matters less than it looks: the window is 5 to 8% of
  analysis input at these turn lengths.

**Proposal: leave bytes÷3 and raise `MEMORY_CALL_OVERHEAD_TOKENS` from 1,500 to 3,000.** Actual over preview would become:

| Fixture | At 1,500  | At 2,500  | At 3,000  |
| ------- | --------- | --------- | --------- |
| en-100  | 1.13-1.16 | 0.71-0.72 | 0.60-0.61 |
| ko-100  | 1.32-1.67 | 0.83-1.06 | 0.70-0.89 |
| en-1000 | 1.33-1.37 | 0.83-0.85 | 0.70-0.72 |
| ko-1000 | 1.76-2.32 | 1.11-1.46 | 0.94-1.24 |

3,000 is the value that stops under-promising by much on a long Korean chat: 24% at worst, and a preview is what a person
spends by. Its price is an estimate up to two-thirds high on a short English one. Real pages are likely larger than
these scripted ones, which leans the same way. Check it against a real model before changing it.

Beyond the constants: the preview leaves out patch input (about 62 to 66% of analysis input at 1,000 turns, on a script
that patches 80% of its windows), compaction, and all output. The whole writer's input is about 1.6 to 1.7 times the
analysis figure, and output adds about a fifth of that. The preview's text says it is the least, which is true; the
wording may want to say by how much once a real run sets the patch rate.

## The health read

`store.memory.readHealth(refs, MEMORY_HEALTH_ROUND_BYTES)` on real tables, each chat with two small pages, so the 16 MiB
page budget never cuts anything. Every row answered all its refs.

| Chats | Events each | Runs each | Event body | Read   |
| ----- | ----------- | --------- | ---------- | ------ |
| 1     | 1,000       | 0         | 200 B      | 1.2 ms |
| 1     | 5,000       | 0         | 200 B      | 7.5 ms |
| 1     | 20,000      | 0         | 200 B      | 30 ms  |
| 1     | 5,000       | 0         | 4,000 B    | 20 ms  |
| 1     | 0           | 1,000     | 200 B      | 0.5 ms |
| 1     | 0           | 5,000     | 200 B      | 2.2 ms |
| 1     | 0           | 20,000    | 200 B      | 10 ms  |
| 64    | 1,000       | 0         | 200 B      | 88 ms  |
| 64    | 5,000       | 5,000     | 200 B      | 635 ms |

**The premise holds, and the size of it is small today.** Cost is linear in events, runs, and event-body size, and the
page budget bounds none of them, so the worst round in the table is 635 ms on the request thread, all 64 answered, with
the budget untouched. A chat of 1,000 turns costs about 2 ms, and 64 of those about 120 ms. Only pinned chats and the open
chat are read, at most once a minute. A chat with 5,000 events is roughly a 5,000-turn chat, so the 635 ms row needs 64
very long pinned chats. If it becomes real, count a chat's event and run rows into the budget the way page bytes are.
This extends the [health read audit](structured-memory-health-read-2026-11-03.md), which measured page-heavy chats.

## `getChatFromIndex` and the rate limit

A real server with the default limit, 2,000 requests a minute per IP, over loopback. A serial loop reproduces the
client's gate: a chat is checked when its last check settled 2 s or more ago, one chat per request. 65 s of real time per
case.

| Case                                       | Requests in the first minute | Refused | First 429 | Median call |
| ------------------------------------------ | ---------------------------- | ------- | --------- | ----------- |
| 60 chats                                   | 1,800                        | 0       | none      | 1.0 ms      |
| 70 chats                                   | 2,100                        | 104     | 56.1 s    | 0.9 ms      |
| 200 chats                                  | 6,000                        | 4,005   | 18.2 s    | 0.6 ms      |
| 200 chats, 40 ms added per call            | 1,434                        | 0       | none      | 1.6 ms      |
| 200 chats, a `resources/read` before each  | 12,000                       | 10,005  | 8.5 s     | 0.5 ms      |
| 60 chats, plus a neighbour GET every 10 ms | 7,206                        | 5,209   | 16.7 s    | 0.5 ms      |

**Confirmed, for the path it describes, and it is worse in one way than the claim.**

- 2,000 a minute is 33.3 a second, which is 67 chats per 2 s window. 60 stay under it and 70 pass it.
- It is a limit on sustained requests, in one fixed window from the key's first hit, not a 2 s bucket. A serial walker
  reaches it only when a whole visit takes under 30 ms. Past a real network that may not hold, and 200 chats with 40 ms
  added stay well under it.
- A visit can be two requests. `getChatFromIndex` loads a chat first, and at most eight idle chats stay loaded, so a walk
  over many chats reloads through `POST /api/resources/read` on the same limiter. That case hit the limit in 8.5 s.
- The cost falls on everyone in the bucket. From about 20 s to the reset, the neighbour route was refused every time.
  Storage and auth routes have buckets of their own. `refreshChatProjections` itself treats a refusal as a settled check
  and keeps the held value, so the plugin read still answers.
- Bulk readers batch their refs into one request and are not this case. A chat under another algorithm, or one not
  loaded, sends nothing.
- The loop is a surrogate. The client code did not run here, and its own overhead per call, `$state.snapshot` of each
  chat included, was not measured. The setup's few seeding requests count against the same window.

## Capture and exclusion

Over a send's manifest at the fixture's real final scene. Nine probes per fixture, each from the stored chat plus one
new user message. A stage is never overridden; the final turns are small talk, so no tail text opens the events lane by itself.
This is a pipeline check on the read path, with the scripted writer and the lexical embedding named above.

| Fixture           | Needed found | Forbidden kept out | Boundary held | Comparison, both found | Distractors selected |
| ----------------- | ------------ | ------------------ | ------------- | ---------------------- | -------------------- |
| ko-100            | 3 of 4       | 3 of 3             | 1 of 1        | 1 of 1                 | 0 of 9               |
| en-100            | 3 of 4       | 3 of 3             | 1 of 1        | 0 of 1                 | 2 of 9               |
| ko-1000           | 2 of 3       | 3 of 3             | 1 of 1        | 0 of 1                 | 1 of 58              |
| en-1000           | 2 of 3       | 3 of 3             | 1 of 1        | 0 of 1                 | 1 of 58              |
| ko-1000 at 32,768 | 3 of 3       | 3 of 3             | 1 of 1        | 0 of 1                 | 1 of 58              |
| en-1000 at 32,768 | 3 of 3       | 3 of 3             | 1 of 1        | 0 of 1                 | 2 of 58              |

- Exclusion is the invariant, and it held everywhere: a retracted event, an event whose source reply was edited, and a
  page set to `never`. Only the record is checked: their raw messages may stay in the prompt by design.
- The knowledge boundary held everywhere: the character's line states the secret only inside `does not know:`.
- The needed misses at 16,384 are all the same record, the open thread. `threads` is the last lane in order, and with
  three quotes per event line the events and evidence lanes spend the budget first. At 32,768 it is found.
- The comparison misses survive the larger budget in the long chats. A query that names two events ranks each by its best
  similarity, and in a long chat one of them (`event:548` in both languages) falls below others that share more terms. The
  en-100 chat missed both at 16,384. A real embedding may rank them differently.
- An unanswerable query selected at most 2 of its labelled distractors. Lanes opening is not a failure by itself. The
  control that repeats nothing kept the events lane closed, though the evidence lane still took 2 to 6 older messages by
  lexical match, because the query reads the small-talk tail too.
- With 8,192 of context, in an earlier run of the fixture before key lines grew to three, the memory budget of 1,638 tokens
  went to the required, flow, and pages lanes, and the events and threads lanes got nothing. Flow has no token target and
  comes before them.

## The token ledger

Per chat, recounted with `o200k_base` from what reached the `fetch` boundary. The selection itself counts with `claude`,
which is the budget the cards fill. Same chat, same context, the same memory maximum, the same
`PINNED_PRESET`. HypaV3 is the standard implementation with no random lane, handed off until its lookahead plan settled,
with summaries scripted to 0.3 of their window. This gives the shape of the tokens. It says nothing about which memory
is better, and it is not Q2's capture comparison.

| Fixture | Algorithm  | Writer calls | Writer input | Writer output | Card per send | Raw per send    |
| ------- | ---------- | ------------ | ------------ | ------------- | ------------- | --------------- |
| en-1000 | Structured | 1,843        | 3,682,285    | 811,471       | 3,211         | 327 (7 entries) |
| en-1000 | HypaV3     | 304          | 115,033      | 31,897        | 3,102         | 12,259 (214)    |
| ko-1000 | Structured | 1,823        | 4,911,971    | 1,072,949     | 2,342         | 531 (7)         |
| ko-1000 | HypaV3     | 322          | 191,671      | 55,013        | 1,955         | 7,170 (76)      |

Per-send figures are the median of nine probe sends at the end of the chat.

- `cl100k_base` and `claude` stay within 3% of these in English. In Korean, they count about 1.3 times as many, and
  the ko-1000 card reaches 3,253 of its 3,276 tokens under `claude`.
- Per recorded turn, English: 2,211 analysis, 1,451 patch, and 20 compaction input tokens, then 811 output. A turn of this
  transcript is about 115 tokens, which is the warning in the plan's Costs section seen plainly: the frame and the cast
  cost many times the text they record. Longer turns narrow that ratio, and only the deferred cadences cut the calls.
- HypaV3 summarizes only what no longer fits, so it writes about 3 to 4% of the tokens here.
- Against that, at the end of the chat structured memory's prompt carries about 3,500 tokens of memory and history where
  HypaV3 carries about 15,400, because `windowTurns` keeps three turns raw and HypaV3 fills the context. That spends fewer
  tokens on the main model on every send, with less raw text in front of it. What that does to replies is the A/B's
  question.
- The writer's calls go to the `memory` slot and the sends to the main model. Which side wins on money depends on those
  two prices, and no price is assumed here.
- At 100 turns the English chat fits the context, so HypaV3 made 4 summaries against structured memory's 183 calls.

## A/B recipe for a real model

The script stands in for the writer, so what remains needs a person and a model.

1. Export a chat and its probes. Each probe in `*-probes.json` carries its kind, query, setup, and the rubric.

   ```bash
   node util/memoryEval.mjs --lang ko --turns 1000 --section eval --export ./memory-ab
   ```

2. On a dev stack, make a character with the name and greeting the probes file gives, and import `*-chat.json`
   (`risuChat`, version 2). The app gives the chat a new id, so read ids from the app. Make a second copy from the same file.
3. Name the writer's model, the send's model, and the embedding model, and keep all three the same in both arms. Keep the
   context and the memory budget the same too. A figure with no model named may not be quoted.
4. Arm A: choose Structured Memory and run a rebuild with one-turn windows. Arm B: choose HypaV3 and let its summaries
   settle. Wait for the writer or the summaries to finish before the first probe, and give neither arm scripted records.
5. Apply each probe's setup in both arms: the retraction, the reply edit, or the hidden page. HypaV3 has no equivalent
   of the first and third, so grade those probes for structured memory alone.
6. Send each probe from a fresh branch of the settled chat, never one after another in one branch: a probe in the history
   becomes the next probe's context and the writer's next input.
7. A person grades each reply by the rubric. A reply can name a fact while denying it, and it can invent one, so matching
   words is not enough.
8. Record per arm: the grades by probe kind, the writer's input and output from the panel's Log, the send's tokens from
   the context report, and the models. Under structured memory, keep the final manifest too, whose items carry `verified`.

Q2 asks whether structured memory matches HypaV3's capture at equal tokens, so compare the two at settings that spend
equal tokens, and say which tokens. This fixture is one story with its seed, so a real run should also cover a chat that
was not generated.

## Limitations

- One seed, one story shape, and a writer that is never wrong. Real writers will produce more repeats, refusals, and failed
  patches, so the call counts here are floors for a clean run.
- The scripted patch rate (about 80% of windows) and the page sizes are chosen, not observed. Every figure that mixes
  them, the overhead and the total writer input above all, inherits that.
- Few threads stay open and the lore, groups, and media paths are not exercised.
- The rebuild measures a clean one-shot run. The live cadence, the pause, and message receipts were not measured.
- Timings come from one shared machine, under WSL2, with tmpfs for most rows.
