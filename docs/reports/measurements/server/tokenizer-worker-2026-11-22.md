# Tokenizer worker — 2026-11-22

What was measured: whether a running server answers an unrelated read and a short token count while one long local
count runs, before and after the Tokenizer Worker plan moved every local tokenizer load and encode into worker threads
(`server/src/prompt/tokenizers/workerHost.ts` `createWorkerTokenizers`: an ordinary worker, and a long worker for a
text over `LONG_TEXT_UNITS`, 131,072 UTF-16 units). Also what the move costs: the round trip of a prompt-sized batch
and the server's resident set. The last section repeats the in-process figures the plan was designed from.

## How

- **Commits.** BEFORE is the plan's base, `2f129b7b2`, where the server's own `createTokenizers` set encodes on the
  main thread. AFTER is `08227d1af`, with slices 1 to 3 landed. Both ran from a clean tree of that commit with the same
  dependencies (the lockfile is the same at both).
- **Machine.** One shared machine, 32 cores, Node 24.21.0, one server at a time. Load average (1 min) 0.31 to 0.78
  during the runs. BEFORE ran from 05:53 to 05:55 and AFTER from 05:55 to 05:58, 2026-11-22 KST.
- **Server.** `node server/src/main.ts` bound to 127.0.0.1, a fresh `RISU_SAVE_DIR` and `RISU_DIAGNOSTICS_DIR` per
  commit, a password set through `RISU_PASSWORD_SHA256`, no auth bypass. Every request carried the signed `risu-auth`
  token of a key registered through `POST /api/login`. No Google key, so no count left the process.
- **Read.** `GET /api/test_auth`, which verifies the token and touches no tokenizer, sent every 50 ms on a fixed
  schedule (not waiting for the previous one) from the moment the long count was sent until it answered. Its limiter
  and the token routes' each allow 2,000 requests a minute; the run sent 1,200 a minute and got no 429.
- **Scopes.** Every `TabTokenScope` had `useTokenizerCaching: false`, `pluginTokenizer: "none"`, and
  `googleClaudeTokenizing: false`. The family was chosen by `aiModel` and `modelTokenizer`, traced through
  `tokenScopeFromTab` and `selectTokenizer` (`shared/tokenizerChoice.ts`): `novellist` (`novellist`, 7), `gemma`
  (`gemini-2.5-flash`, 10; Google counting off selects `gemma`), `claude` (`claude-sonnet-4-6`, 6), and `cl100k_base`
  (`gpt35_0125`, 1).
- **Long texts.** As long as the whole JSON body, scope included, fits `MAX_TOKEN_BODY_BYTES` (2,097,152 bytes); one
  more repetition puts either body one byte over.

  | Case                  | Text UTF-16 units | Text UTF-8 bytes | Body bytes |   Count |
  | --------------------- | ----------------: | ---------------: | ---------: | ------: |
  | `novellist`, `😀` × n |         1,048,476 |        2,096,952 |  2,097,149 |       1 |
  | `gemma`, `a` × n      |         2,096,947 |        2,096,947 |  2,097,152 | 262,119 |

  The counts are the same at both commits. `novellist` gives any run of that emoji one token (also in thread, for 1,
  2, 10, and 1,000 of them), so its count says nothing about the time it takes.

- **One run.** One `POST /api/tokens/count` with the long text; a run is void unless it answers 200 with `counts`
  holding one non-negative integer (none was). About 1 s after it was sent, two short counts of one 48-character
  sentence: one for the same scope and one for `claude`. Each family was counted once with a short text first, so no
  timed run includes a first load. Three runs per case and commit, alternating `novellist` and `gemma`, 3 s apart.
  Times are from the client's `fetch` to the whole answer.

A throwaway script; nothing in the repository runs it.

## A read and a short count during a long count

Each row is three runs. "Reads answered during" counts reads answered before the long count's answer; the BEFORE reads
were all answered, after it, at once.

| Case        | Commit |  Long count (ms) | Reads answered during | Read latency max (ms) | Short count, same family (ms) | Short count, `claude` (ms) |
| ----------- | ------ | ---------------: | --------------------: | --------------------: | ----------------------------: | -------------------------: |
| `novellist` | BEFORE | 23,049 to 23,559 |            0 of 1,401 |                23,510 |              22,061 to 22,569 |           22,062 to 22,570 |
| `novellist` | AFTER  | 23,332 to 23,635 |        1,408 of 1,408 |                   5.6 |                    3.5 to 4.1 |                 3.2 to 3.6 |
| `gemma`     | BEFORE |   5,569 to 5,766 |              0 of 339 |                 5,718 |                4,591 to 4,778 |             4,592 to 4,779 |
| `gemma`     | AFTER  |   6,213 to 6,274 |            374 of 374 |                   4.9 |                    4.0 to 5.0 |                 3.2 to 4.3 |

- BEFORE, every read and every short count waited for the long count: a short count sent 1 s in answered with the long one, and read latency fell from the whole count's length to nothing over the run (median 11.6 to
  12.0 s for `novellist`, 2.8 to 2.9 s for `gemma`). The two short counts were answered within 1 ms of each other.
- AFTER, the read's p99 stayed at or under 3.8 ms, the longest gap between two read answers was 52 to 55 ms (the 50 ms
  schedule), and every short count answered in under 5.1 ms, before the long count. The `gemma` short count shows the
  ordinary worker answering while the long worker encodes the same family.
- The long count itself took the same time for `novellist` (median 23,533 ms BEFORE, 23,519 AFTER) and about 10% longer
  for `gemma` (5,693 and 6,255). Its caller still waits for it (plan D10).
- The AFTER long worker was one thread for all six runs: the first `novellist` run started it, and it was alive, with
  `novellist` and then `gemma` loaded, for the others. It had ended 65 s after the last long answer
  (`LONG_WORKER_IDLE_MS` is 60 s).
- One read of the first BEFORE `novellist` run failed with `ECONNRESET` and is left out of its latency figures; an
  earlier attempt, discarded because its script stopped at the first read error, had one too. AFTER had none. The cause
  is not known.

## Round trip of a prompt-sized batch

One `POST /api/tokens/count` of 512 distinct texts of 322 to 331 characters (the route's most; a prompt of 2,000 texts is
four of these), five per family and commit, the same texts at both commits and fresh texts per repetition.

| Family        | BEFORE median (ms) | AFTER median (ms) | AFTER minus BEFORE, per text (ms) |
| ------------- | -----------------: | ----------------: | --------------------------------: |
| `cl100k_base` |               78.3 |             140.0 |                              0.12 |
| `claude`      |               85.4 |             147.1 |                              0.12 |
| `gemma`       |               74.0 |             136.0 |                              0.12 |

Every count matched between the commits. The cost is the 0.1 ms round trip the in-process spike measured (below), the
same for every family: about 0.24 s on a prompt of 2,000 uncached texts.

## Resident set

`VmRSS` of the server process (its worker threads included), MiB. Each row adds to the one above.

| After                                            | BEFORE | AFTER |
| ------------------------------------------------ | -----: | ----: |
| Start and the first authenticated read           |    158 |   154 |
| A Claude send's families (`claude`)              |    203 |   220 |
| A Gemini send's families (`claude` and `gemma`)  |    375 |   416 |
| Also `novellist` and `cl100k_base`               |    395 |   465 |
| The six long counts, the long worker still alive |  2,114 | 2,332 |
| The long worker ended (AFTER only)               |      — | 1,972 |
| The batches                                      |  2,122 | 1,984 |
| Peak (`VmHWM`)                                   |  2,139 | 2,337 |

A send counts its prompt, `tokenizeNum`, and the output meter with the main model's scope, so a Claude send loads
`claude` and a Gemini send without Google counting `gemma`. The worker set costs 17 to 70 MiB more with the same
families loaded. The long counts' 2 MiB texts and their ids take most of the growth after them at both commits; while
the long worker lives it holds its own copy of the families it counted (plan D5), and its end gave back 360 MiB.

## The plan's in-process figures

From the scripts the plan was designed from (`docs/plan/tokenizer-worker.md`, Measured): a worker that owns a
`createTokenizers` set and answers `load`, `count`, and `encode` messages, driven from a second file, on the same
machine and Node, one run each, at `2f129b7b2`.

- Every family loads in a worker thread and counts the same sample text as on the main thread (fifteen equal counts).
  Load times are the main thread's (6 to 770 ms a family).
- With all fifteen families loaded the process's resident set is 679 MB when the main thread loads them and 681 MB when
  the worker does (74 MB before either). After the worker is terminated it is 300 MB.
- A round trip costs about 0.1 ms. 2,000 texts of about 330 characters, one awaited after another: 371 ms in thread and
  593 ms through the worker for `cl100k_base`, 459 and 681 for `claude`, 334 and 541 for `llama3`, 177 and 402 for
  `novelai`, 394 and 642 for `gemma`. Returning the ids (a transferred `Uint32Array`) costs the same as returning the
  count. Posting all 2,000 at once saves about a fifth of the worker figure.
- While the worker counted 1 MiB of one letter with `gemma` (2.9 s), the main thread's longest event loop delay was
  5 ms.
- A worker can be terminated inside an encode: `gemma` at 1.5 s into a 2 MiB text (with `@huggingface/transformers`,
  and so `onnxruntime-node`, loaded in that thread), `novellist`, and `claude`. `terminate` settled in 8 to 35 ms, the
  process went on, and a new worker loaded the family in 174 to 488 ms and counted.
- Worst time by length, each family over nine kinds of text (one letter, spaced words, Hangul, CJK, emoji, digits,
  punctuation, spaces, mixed) of the same length in UTF-16 units, in thread:

  | Length  | Slowest                        | Second                       | Every other family |
  | ------- | ------------------------------ | ---------------------------- | ------------------ |
  | 65,536  | `gemma` on Hangul, 322 ms      | `cohere` on digits, 118 ms   | under 100 ms       |
  | 131,072 | `gemma` on Hangul, 585 ms      | `novellist` on emoji, 357 ms | under 240 ms       |
  | 262,144 | `novellist` on emoji, 1,408 ms | `gemma` on Hangul, 1,189 ms  | under 470 ms       |

  These nine kinds are not the slowest text of a length. A text that keeps tiktoken's package path is not split: the
  plan's audit measured 6.5 s for `cl100k_base` on 65,535 letters followed by U+0295.

## Reading

The goal of the plan holds on a running server: a long local count no longer holds the server's thread. Before, a read
and a short count waited out the whole count, 5.6 s for `gemma` and 23.5 s for `novellist`; after, both answered in
milliseconds throughout. What it costs is about 0.12 ms per uncached text, tens of MiB of resident set with the
families a send uses, and, while a long count's worker lives, a second copy of the families it loaded.
