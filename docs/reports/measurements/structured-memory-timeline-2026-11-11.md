# Structured Memory recent timeline (2026-11-11)

What the recent timeline puts in the card and what it costs, on the deterministic fixture chats of the
[2026-11-03 evaluation](structured-memory-2026-11-03.md), before and after, from one run. Measured over `6a13a0b79`
with the shares this report settled (flow 0.25, pages 0.45, events 0.15, evidence 0.10, threads 0.05; decision D14 of
the [Recent Timeline plan](../../plan/structured-memory-recent-timeline.md)) and `RETRIEVAL_LIMITS.flowCandidates` 200.

**No figure in this file is a model's recall.** The writer is scripted and the embedding is lexical, as in the
2026-11-03 report. Whether replies recall recent events better is the real-model A/B in
[manual checks](../../backlog/manual-checks.md).

## Conditions

- Machine and fixtures as in the 2026-11-03 report: WSL2, 24 logical CPUs, Node 24.21.0, SQLite 3.53.4, tmpfs, seed 1;
  ko-1000 has 984 events and en-1000 has 975, each chat 25 pages. One machine other sessions share.
- Each fixture is rebuilt once. Every probe query (nine) is then sent at three budgets and two settings. A row is the
  median over the nine sends, one send each, so its times are single samples; the `send` table below has the medians
  of seven.
  - Budgets: 16,384 and 32,768 tokens of context with memory a fifth (maxima 3,276 and 6,553), and a memory maximum of
    50,000 (tokens mode, 131,072 of context, nothing reduced).
  - **timeline** is the default `auto` split.
  - **before** is `manual` with flow 0, pages 2,000, events 1,500, evidence 700, threads 300. Slice 1 pins that as
    the old title-only card.
- Card tokens are counted with `claude`, the selection's family. "Run" is the events the flow lane shows in full
  (manifest items with reason `timeline`). "Titles" are the title lines after the run (`recent`).

Run it again with:

```bash
node util/memoryEval.mjs --lang ko,en --turns 100,1000 --section eval,ledger,send
```

The default sections also run `checkpoint`, `estimate`, and `health`, which this report does not need.

## The card at each budget, 1,000 turns

Lane cells are target / spent; `titles only` is the old flow sentinel target.

| Fixture | Budget | Setting  | flow              | pages          | events        | evidence      | threads    | Run | Titles | Card   |
| ------- | ------ | -------- | ----------------- | -------------- | ------------- | ------------- | ---------- | --- | ------ | ------ |
| en-1000 | 3,276  | timeline | 819 / 1,126       | 1,474 / 1,434  | 491 / 441     | 327 / 123     | 163 / 0    | 10  | 8      | 3,230  |
| en-1000 | 3,276  | before   | titles only / 326 | 2,000 / 1,938  | 1,500 / 773   | 700 / 64      | 300 / 0    | 0   | 8      | 3,169  |
| en-1000 | 6,553  | timeline | 1,638 / 1,946     | 2,948 / 3,109  | 982 / 884     | 655 / 374     | 327 / 43   | 24  | 7      | 6,497  |
| en-1000 | 6,553  | before   | titles only / 326 | 2,000 / 3,737  | 1,500 / 1,768 | 700 / 374     | 300 / 43   | 0   | 8      | 6,471  |
| en-1000 | 50,000 | timeline | 12,500 / 12,898   | 22,500 / 3,737 | 7,500 / 3,257 | 5,000 / 374   | 2,500 / 43 | 200 | 8      | 20,738 |
| en-1000 | 50,000 | before   | titles only / 326 | 2,000 / 3,737  | 1,500 / 5,349 | 700 / 374     | 300 / 43   | 0   | 8      | 9,976  |
| ko-1000 | 3,276  | timeline | 819 / 1,198       | 1,474 / 1,381  | 491 / 394     | 327 / 93      | 163 / 43   | 5   | 7      | 3,235  |
| ko-1000 | 3,276  | before   | titles only / 388 | 2,000 / 1,865  | 1,500 / 799   | 700 / 90      | 300 / 0    | 0   | 8      | 3,250  |
| ko-1000 | 6,553  | timeline | 1,638 / 1,955     | 2,948 / 2,811  | 982 / 810     | 655 / 652     | 327 / 43   | 13  | 8      | 6,495  |
| ko-1000 | 6,553  | before   | titles only / 388 | 2,000 / 3,725  | 1,500 / 1,392 | 700 / 678     | 300 / 43   | 0   | 8      | 6,433  |
| ko-1000 | 50,000 | timeline | 12,500 / 18,697   | 22,500 / 7,661 | 7,500 / 7,726 | 5,000 / 1,014 | 2,500 / 43 | 196 | 8      | 35,586 |
| ko-1000 | 50,000 | before   | titles only / 388 | 2,000 / 7,661  | 1,500 / 9,562 | 700 / 1,014   | 300 / 43   | 0   | 8      | 18,474 |

The required lane (cap 1,500) spent 71 in English and 87 in Korean in every row.

- **At 3,276 and 6,553 the card fills either way; what changes is what fills it.** The title-only card spent its room
  on pages and on events the events lane found. The timeline card gives 1,100 to 1,950 tokens to the newest 5 to 24
  events in full, in order. The pages lane pays most of that (next section).
- **At 50,000 the budget is used about twice as much, and still not filled.** The card grows from 9,976 to 20,738
  tokens in English and from 18,474 to 35,586 in Korean. The run reaches `flowCandidates` (a median of 200 in English
  and 196 in Korean). The pages, evidence, and threads lanes spend what they spent under the title-only card, which is
  all their candidates hold, and the events lane spends less, since the run now shows its recent events. What stays
  empty is what this chat offers no more of under these bounds.
- The 100-turn chats show the same shape at a smaller run. At 3,276, the run is 10 events in English and 4 in Korean.
  At 50,000 it holds every eligible event (91 and 92), with one title left.

## The pages lane and the shares

At 16,384 tokens of context the flow's share is taken from the pages lane. In the 1,000-turn chats the pages on stage
are long: about 500 tokens each in English and 914 to 947 in Korean. The old fixed target, 2,000, was 61% of a 3,276
maximum. Under the shipped shares the pages lane spends 1,434 against 1,938 in English and 1,381 against 1,865 in
Korean, and every send loses one page that was on stage.

The plan's first shares (flow 0.40, pages 0.30) lost more, so this slice measured the alternatives before D14. Each
cell is the on-stage pages lost over the nine probe sends (compared with "before" at the same budget), then the
median run.

| Shares (flow / pages) | ko-100, 3,276 | en-1000, 3,276 | ko-1000, 3,276 | ko-1000, 6,553 | en-1000, 6,553 |
| --------------------- | ------------- | -------------- | -------------- | -------------- | -------------- |
| 0.40 / 0.30           | 16, run 10    | 18, run 18     | 9, run 10      | 15, run 25     | 6, run 40      |
| 0.30 / 0.40           | 9, run 6      | 9, run 13      | 9, run 7       | 15, run 17     | 0, run 29      |
| 0.25 / 0.45 (shipped) | 0, run 4      | 9, run 10      | 9, run 5       | 6, run 13      | 0, run 24      |
| 0.20 / 0.50           | 0, run 3      | 0, run 7       | 9, run 2       | 6, run 11      | 0, run 19      |
| 0.20 / 0.30           | 3, run 4      | 14, run 7      | 6, run 2       | 6, run 10      | 0, run 19      |

en-100 lost no on-stage page under any split measured, and ko-100 none at 6,553. Events, evidence, and threads kept 0.15,
0.10, and 0.05.

The comparison rows ran in scratch with `manual` targets equal to each split's floors. The shipped row matches the
tool's own run above.

- Lowering only the flow share (the last row) loses more than moving the same share to pages, as 0.20 / 0.50 does.
- In the Korean 1,000-turn chat no split loses less at 3,276 while it keeps a run of more than two events: two pages
  of 914 to 947 tokens need about 57% of the maximum.
- The owner chose 0.25 / 0.45 (D14). On the 100-turn chats it loses no on-stage page, and at 6,553 it more than halves the
  Korean loss and removes the English one. At 16,384 a 1,000-turn chat still loses one on-stage page per send,
  recorded in `read.md` Limitations.
- The other pages lost at 16,384 are pages a query named or linked, not on stage: in ko-100, 18 over nine sends.

## The `threads` lane

At 16,384 the English 1,000-turn chat still gives the one open thread nothing, against a target of 163. The Korean chat gives it 43, where the title-only card gave it 0. At 32,768 and above it is shown in both
languages. The starvation `read.md` records at 16,384 stays for English.

## Events-lane candidates the run already held (D11)

The events lane ranks its candidates before the run is known. Over the nine probe sends, out of 288 candidates (48
per opened lane, summed):

| Fixture | 3,276 | 6,553 | 50,000 |
| ------- | ----- | ----- | ------ |
| en-1000 | 11    | 18    | 76     |
| ko-1000 | 3     | 3     | 43     |
| en-100  | 38    | 84    | 288    |
| ko-100  | 2     | 5     | 32     |

ko-100 opened the events lane less often: 32 candidates in all, not 288.

At small budgets the run holds a few recent events, and the lane's candidates are older ones, so they rarely overlap.
At 50,000 a candidate the run holds becomes a candidate place lost to recall of older events, a sixth to a quarter of
them at 1,000 turns. D10 keeps it from being shown twice, and the run shows it in full anyway.

## Selection time

The timeline counts every offered full line before it spends, up to `flowCandidates`, whatever the budget. At 1,000
turns that is about 400 more `tokenizeChat` calls a send (about 2,590 against 2,190):

| Fixture | `selectMemory`, timeline | `selectMemory`, before | `send` section (medians of seven) |
| ------- | ------------------------ | ---------------------- | --------------------------------- |
| en-1000 | 557 to 603 ms            | 513 to 529 ms          | 529 to 559 ms                     |
| ko-1000 | 589 to 657 ms            | 544 to 569 ms          | 562 to 585 ms                     |

The timeline and before columns run across the three budgets.

`read.md` recorded 520 to 584 ms. The timeline adds about 45 to 90 ms at 1,000 turns, and up to 657 ms at the 50,000
maximum in Korean. The owner kept `flowCandidates` at 200 (D14): lowering it would cut the run at the 50,000 maximum,
where it reaches the bound. Counting lines only as the run reaches them would remove the cost without the cut. That
needs a change in `retrieve.ts` and `lanes.ts`, outside this plan.

## The fixture changes

- `fixture.send` takes a per-send `maxContext` and settings patch, so one rebuild serves every row. With `diagnostics`
  it lists the events lane's candidates.
- `scoreProbe` reports the found item's `reason`, and the eval table splits flow items into `timeline` and `recent`.
  Capture still counts a title as found: what it says is "selected", not "shown in full". The tool reports the two
  apart.

## Limitations

- Those of the 2026-11-03 report: one seed, one story shape, a writer that is never wrong, short messages.
- A page's length here follows the scripted writer's patches over 1,000 turns. A real chat's on-stage pages may be
  shorter or longer, which moves the share at which they fit.
- The per-budget rows are single samples per send. Their times move by tens of milliseconds between runs on this
  machine; the first run of this slice (shares 0.40 / 0.30) read 559 to 673 ms for the timeline rows.
