# Structured Memory health read (2026-11-03)

What `POST /api/memory/structured/health` costs at its 64-chat limit, on the store's real tables. `node:sqlite` is
synchronous, so a read's time is time the whole server waits. Node 24.21.0, SQLite 3.53.4, WSL2, one in-process store, the
median of seven reads. The JSON sizes are before `compressedJson`.

Each page is about 54,000 characters: 8 sections of 1,700 Hangul characters, each past the `character` budget, and 60
history entries of 500 characters. That is about 140 KB of stored bytes.

| Fixture per chat                    | Read                    | Server time | Chats answered | Answer  |
| ----------------------------------- | ----------------------- | ----------- | -------------- | ------- |
| 40 pages, 500 events, 1,000 runs    | First form, no budget   | 1,281 ms    | 64             | 6,604 B |
| 200 pages, 2,000 events, 5,000 runs | First form, no budget   | 6,196 ms    | 64             | 6,796 B |
| 40 pages, 500 events, 1,000 runs    | One pass, no budget     | 543 ms      | 64             | 6,604 B |
| 40 pages, 500 events, 1,000 runs    | One pass, 16 MiB budget | 17 ms       | 2              | 218 B   |
| 200 pages, 2,000 events, 5,000 runs | One pass, 16 MiB budget | 42 ms       | 1              | 118 B   |
| 5 pages, 50 events, 100 runs        | One pass, 16 MiB budget | 25 ms       | 23             | 2,312 B |

- The first form parsed each page twice and carried bodies into JavaScript. One statement over `json_each`, with both
  counts in SQL, took 441 ms of the 543 ms. Events took 59 ms, runs 32 ms, stale counts 16 ms, and page byte sums 3 ms.
- `MEMORY_HEALTH_ROUND_BYTES` bounds a request's work, not its answer. The first chat is always answered, so one very
  large chat is the worst single request: 42 ms in the table.
- At that page size a tab needs 32 requests for 64 chats. Each is its own short stall, and they run one after another.
- A 64-chat answer with non-zero counts in `structuredMemoryRoutes.test.ts` weighs 6,284 bytes, under the test's 8 KiB
  bound.
