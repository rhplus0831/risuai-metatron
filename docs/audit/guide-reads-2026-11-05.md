# Guide Reads 2026-11-05

Scanned 1212 transcript files in 340 directories of local Claude Code
sessions (sub-agent transcripts included); the counted guide reads span 2026-09-26 to 2026-11-04. Each tool call counts once by its
id, so a forked session's copied history is not counted twice. Method and contract: the header comment of
`util/guideReads.mjs`. Undercount: reads by Codex and Luna workers are not in these transcripts, and `rg` or
`grep` output from a guide, like any Bash read but a `sed -n` range, counts per guide but not per heading.

## Per guide

| Guide                          | Whole-file Reads | Ranged Reads |  Bash | of which `sed -n` | docs:read |
| ------------------------------ | ---------------: | -----------: | ----: | ----------------: | --------: |
| STRUCTURE                      |               88 |           95 |  2469 |               819 |        11 |
| a                              |                0 |            0 |     1 |                 0 |         0 |
| agents-and-presets             |                0 |            0 |     3 |                 1 |         0 |
| app-shell                      |                2 |           14 |   249 |                67 |         0 |
| assets                         |                0 |            0 |     4 |                 1 |         2 |
| assets-and-saves               |                0 |            0 |     2 |                 2 |         0 |
| backend                        |                0 |            0 |     6 |                 3 |         0 |
| backup-sync-hub                |                7 |           10 |   184 |                39 |         0 |
| build-test-platforms           |                5 |           14 |   896 |               200 |         8 |
| cbs-rendering                  |                2 |           13 |   204 |                54 |         0 |
| characters-modules             |                6 |           15 |   335 |                79 |         0 |
| chat-pipeline                  |                5 |           31 |   627 |               146 |        14 |
| chat-store                     |                5 |            2 |    92 |                21 |         9 |
| data-and-events                |                0 |            0 |     7 |                 3 |         0 |
| development-and-observability  |                0 |            0 |     2 |                 1 |         0 |
| diagnostics                    |                3 |            2 |   126 |                33 |         0 |
| domain-glossary                |                0 |            0 |     2 |                 0 |         0 |
| draft-recovery                 |                1 |           11 |    27 |                 7 |         5 |
| durable-mutations-and-recovery |                0 |            0 |     7 |                 2 |         0 |
| generated-and-legacy           |                0 |            0 |     1 |                 0 |         0 |
| generation-rejection-register  |                0 |            0 |     4 |                 1 |         0 |
| global-api                     |                1 |           18 |   406 |               100 |         0 |
| intermediate-display           |                0 |            0 |     8 |                 3 |         0 |
| live-update-feed               |                0 |            0 |     5 |                 1 |         0 |
| live-updates                   |                0 |            0 |     6 |                 1 |         5 |
| llm-requests                   |                2 |           17 |   256 |                68 |         0 |
| mcp                            |                0 |            0 |     3 |                 1 |         0 |
| media-aux                      |                3 |           13 |   187 |                46 |         0 |
| memory                         |                4 |           29 |   305 |                61 |         0 |
| network-jobs                   |                0 |            0 |     4 |                 1 |         0 |
| persistence                    |                8 |           40 |  1359 |               324 |        10 |
| plugin-sandbox                 |                0 |            0 |     5 |                 0 |         0 |
| plugins                        |                0 |            0 |     1 |                 0 |         0 |
| plugins-and-mcp                |                0 |            0 |     4 |                 2 |         0 |
| plugins-mcp                    |                7 |           10 |   343 |                79 |         0 |
| prompt-assembly-and-scripting  |                0 |            0 |     4 |                 0 |         0 |
| providers-and-models           |                0 |            0 |     2 |                 1 |         0 |
| README                         |                0 |            0 |     2 |                 0 |         0 |
| resource-sync                  |                2 |           11 |    47 |                13 |         0 |
| scripts-triggers               |                4 |            0 |   168 |                40 |         0 |
| self-host-server               |                3 |           59 |  1684 |               441 |        17 |
| server                         |                0 |            0 |     1 |                 0 |         0 |
| server-generation              |                1 |            0 |   111 |                26 |         0 |
| server-resources               |                2 |           11 |    92 |                14 |         0 |
| server-resources-and-bridges   |                0 |            0 |     3 |                 3 |         0 |
| server-sync                    |                0 |            0 |     1 |                 0 |         0 |
| settings-i18n                  |                2 |           16 |   253 |                49 |         0 |
| structured-memory              |               37 |           21 |   242 |                38 |         1 |
| structured-memory-lifecycle    |                6 |            6 |    44 |                10 |         0 |
| structured-memory-pages        |                0 |            2 |     3 |                 0 |         0 |
| structured-memory-read         |                7 |            6 |    82 |                20 |         0 |
| structured-memory-rebuild      |                0 |            2 |    24 |                 8 |         0 |
| structured-memory-writer       |               10 |           11 |    89 |                22 |         0 |
| structured-memory/projection   |                0 |            0 |     4 |                 0 |         0 |
| structured-memory/records      |                0 |            7 |     3 |                 1 |         0 |
| test-harness                   |                1 |            8 |   110 |                22 |         0 |
| translation                    |                0 |            0 |     2 |                 1 |         0 |
| translation-and-input-hooks    |                0 |            0 |     4 |                 2 |         0 |
| ui-theming                     |                3 |           17 |   455 |                84 |        13 |
| **all**                        |              227 |          511 | 11570 |              2961 |        95 |

Bash counts every command naming the guide's path, writes and `git` commands included; `sed -n` is the
part that prints a line range.

Whole-file share of guide Reads: 30.8% (227 of 738); the Agent Read Protocol asks for section reads instead.

2 `docs:read` calls named no guide (a placeholder, a variable, or a typo).

## Compared with the first audit

The whole-file share is 30.8% (227 of 738) now against 30.5% (223 of 731) on 2026-11-04; this scan read 1212
transcript files in 340 directories, the first 1195 files in 334. The difference of the two **all** rows gives 4
whole-file and 3 ranged Reads added since, a whole-file share of 57.1% (4 of 7) for the added Reads, while `docs:read`
calls rose from 24 to 95 (4 of the 78 added Reads and `docs:read` calls were whole-file); both scans are cumulative
over the transcripts still on disk, so the added counts are a difference of two scans and approximate. The four wave-1
guides (self-host-server, persistence, chat-pipeline, ui-theming) were rewritten between the two audits, so their
per-heading counts mix reads of the old headings (mapped against dev at read time) with reads of the new ones, while
their untouched lists are against the new headings. Per D7, Codex and Luna worker reads and Bash reads other than
`sed -n` ranges are undercounted, so the counts order work inside a guide and never justify deleting a fact. The
`a` row (one Bash command, in this audit and the first) is not a guide: the script counts any guide path a Bash
command names without checking that the guide ever existed, so that row is a placeholder path; it changes no Read
count and no heading count.

## Wave-2 ledger order

These untouched `Files` and `Flows` headings go first in each wave-2 guide's fact ledger (D7); a touched heading is
not evidence that a fact is needed elsewhere, and an untouched one is not evidence that it can go.

| Guide                | Untouched `Files`/`Flows` headings                                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build-test-platforms | Files > Changed-file checks; Files > Heap analysis; Files > Upstream `.bin` check; Files > Environment variables; Files > Web; Files > Service worker; Files > Worker Web Push; Flows > Development; Flows > CI                                                                                                         |
| characters-modules   | Files > Cards and CharX; Files > Characters; Files > Modules; Files > Module import; Files > Personas and conversion; Files > Module settings; Files > Asset pickers and lists; Flows > Card import; Flows > Realm download; Flows > Export reads and failures; Flows > Drops and deep links; Flows > Module activation |
| app-shell            | Files > Router; Files > Bootstrap; Files > Stores and platform; Files > Hotkeys and observers; Files > Home screen; Flows > Boot; Flows > Safe boot; Flows > Screen selection; Flows > Escape order; Flows > Alert dialog keys                                                                                          |
| settings-i18n        | Files > Registry and helpers; Files > Data arrays; Files > Renderers and credential links; Files > Settings navigation; Files > Prompt and parameter editors; Files > Languages                                                                                                                                         |
| llm-requests         | Files > Catalogue and model resolution; Files > Model preset slots; Files > Credentials; Files > Tab request layer; Files > Server request layer; Files > Tokenizer selection and server counting; Files > Tab token counting; Files > Settings pages                                                                   |
| memory               | Files > Embedding processors; Files > UI; Flows > Server persistence; Flows > Server embeddings and local models                                                                                                                                                                                                        |
| cbs-rendering        | Files > CBS runtime; Files > Client host and renderer; Files > Variables; Files > Other parsers and editors; Flows > Evaluation; Flows > Mixed render refresh                                                                                                                                                           |
| backup-sync-hub      | Flows > RisuRealm terms; Flows > Realm access; Flows > Realm download                                                                                                                                                                                                                                                   |
| global-api           | none                                                                                                                                                                                                                                                                                                                    |
| media-aux            | Files > TTS; Files > Image generation; Files > Media; Files > Playground; Files > Settings                                                                                                                                                                                                                              |
| scripts-triggers     | none                                                                                                                                                                                                                                                                                                                    |
| diagnostics          | none                                                                                                                                                                                                                                                                                                                    |

## Per heading

### STRUCTURE

2 outline `docs:read` calls; 1 reads of a revision without the guide (unmapped).

| Heading                                           | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------- | ----------------------: | --------: |
| Repository-Wide Invariants                        |                     754 |         1 |
| Agent Read Protocol                               |                     558 |         3 |
| STRUCTURE                                         |                     535 |         0 |
| Choose By Task                                    |                     359 |         1 |
| Path Ownership                                    |                     330 |         0 |
| Glossary                                          |                     116 |         0 |
| Doc Maintenance                                   |                     101 |         4 |
| Repository-Wide Invariants > Tooling              |                      65 |         0 |
| Repository-Wide Invariants > Verification         |                      63 |         0 |
| Repository-Wide Invariants > Data and persistence |                      62 |         0 |
| Repository-Wide Invariants > Release              |                      51 |         0 |
| Repository-Wide Invariants > Platform and network |                      48 |         0 |
| Repository-Wide Invariants > Security             |                      48 |         0 |
| Dead, Placeholder, or Unwired Code                |                      45 |         0 |
| Repository-Wide Invariants > UI                   |                      44 |         0 |
| Path Ownership > Chat, memory, and requests       |                      38 |         0 |
| Migration History                                 |                      31 |         0 |
| Path Ownership > Features, shell, and UI          |                      17 |         0 |
| Path Ownership > Server, build, and tests         |                      10 |         0 |

Every current `##`/`###` heading was touched.

### a

No heading-level reads.

The guide is gone from the current tree.

### agents-and-presets

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### app-shell

| Heading                   | Ranges (Read, `sed -n`) | docs:read |
| ------------------------- | ----------------------: | --------: |
| Flows                     |                      42 |         0 |
| Files                     |                      25 |         0 |
| State                     |                      24 |         0 |
| Recipes                   |                      13 |         0 |
| Tests                     |                      12 |         0 |
| Invariants                |                      11 |         0 |
| Scope                     |                      10 |         0 |
| Coupling                  |                       9 |         0 |
| App Shell                 |                       8 |         0 |
| Known Hazards             |                       7 |         0 |
| Flows > URL routes        |                       1 |         0 |
| Files > Entry and screens |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Router; Files > Bootstrap; Files > Stores and platform; Files > Hotkeys and observers; Files > Home screen; Flows > Boot; Flows > Safe boot; Flows > Screen selection; Flows > Escape order; Flows > Alert dialog keys; Recipes > Add a screen or modal; Recipes > Change startup; Recipes > Add platform behavior; Recipes > Add a hotkey; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### assets

2 outline `docs:read` calls; 1 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Files > Asset sources; Files > Asset client; Files > Asset queues; Files > Batch codec; Flows; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues.

### assets-and-saves

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### backend

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### backup-sync-hub

| Heading                          | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------- | ----------------------: | --------: |
| Files                            |                      19 |         0 |
| Tests                            |                      16 |         0 |
| Recipes                          |                      15 |         0 |
| Scope                            |                      13 |         0 |
| Flows                            |                      13 |         0 |
| Invariants                       |                      13 |         0 |
| State                            |                      11 |         0 |
| Known Hazards                    |                      11 |         0 |
| Coupling                         |                      10 |         0 |
| Backups, Realm Hub               |                       7 |         0 |
| Flows > Upstream database export |                       3 |         0 |
| Flows > Upstream database import |                       2 |         0 |
| Flows > Upstream library import  |                       1 |         0 |
| Known Hazards > Issues           |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > RisuRealm terms; Flows > Realm access; Flows > Realm download.

### build-test-platforms

2 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                                                                           | Ranges (Read, `sed -n`) | docs:read |
| --------------------------------------------------------------------------------- | ----------------------: | --------: |
| Tests                                                                             |                      95 |         1 |
| Files                                                                             |                      78 |         0 |
| Tests > Test rules                                                                |                      57 |         0 |
| Scope                                                                             |                      40 |         0 |
| Recipes                                                                           |                      37 |         0 |
| Known Hazards                                                                     |                      34 |         0 |
| Invariants                                                                        |                      27 |         0 |
| Build, Test Harness, Service Worker, Release                                      |                      22 |         0 |
| Flows                                                                             |                      21 |         0 |
| Coupling                                                                          |                      18 |         0 |
| State                                                                             |                      15 |         0 |
| Files > Documentation check                                                       |                       7 |         2 |
| Files > Prettier config                                                           |                       4 |         0 |
| Files > Relevant `package.json` scripts                                           |                       3 |         1 |
| Known Hazards > Issues                                                            |                       2 |         0 |
| Known Hazards > Gotchas                                                           |                       2 |         0 |
| Build, Test Harness, Mobile (Capacitor), Service Worker, Release                  |                       1 |         0 |
| Build, Test Harness, Desktop (Tauri), Mobile (Capacitor), Service Worker, Release |                       1 |         0 |
| Files > Build compression                                                         |                       1 |         0 |
| Build, Service Worker, Release                                                    |                       1 |         0 |
| Flows > Production                                                                |                       1 |         0 |
| Files > Dev runner                                                                |                       1 |         0 |
| Files > Config files                                                              |                       1 |         0 |
| Files > Direct assets                                                             |                       0 |         1 |

Current `##`/`###` headings no read touched: Files > Changed-file checks; Files > Heap analysis; Files > Upstream `.bin` check; Files > Environment variables; Files > Web; Files > Service worker; Files > Worker Web Push; Flows > Development; Flows > CI.

### cbs-rendering

| Heading                                     | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------- | ----------------------: | --------: |
| Files                                       |                      27 |         0 |
| Tests                                       |                      22 |         0 |
| Known Hazards                               |                      17 |         0 |
| Flows                                       |                      16 |         0 |
| Invariants                                  |                      16 |         0 |
| Scope                                       |                      13 |         0 |
| Coupling                                    |                      12 |         0 |
| Recipes                                     |                      11 |         0 |
| State                                       |                      10 |         0 |
| Known Hazards > Limitations                 |                       7 |         0 |
| Known Hazards > Issues                      |                       6 |         0 |
| CBS Template Language and Message Rendering |                       6 |         0 |
| Known Hazards > Gotchas                     |                       4 |         0 |
| Flows > Display transform                   |                       2 |         0 |
| State > Caches                              |                       2 |         0 |
| Files > Script transform client             |                       1 |         0 |
| Flows > Display                             |                       1 |         0 |
| Flows > Display transform failures          |                       1 |         0 |
| Flows > Shared styles                       |                       1 |         0 |
| State > Variable storage                    |                       1 |         0 |
| Files > Inlays                              |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > CBS runtime; Files > Client host and renderer; Files > Variables; Files > Other parsers and editors; Flows > Evaluation; Flows > Mixed render refresh; Recipes > Add a CBS function; Recipes > Change message display; Recipes > Change variable semantics.

### characters-modules

| Heading                              | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------ | ----------------------: | --------: |
| Invariants                           |                      34 |         0 |
| Files                                |                      32 |         0 |
| Tests                                |                      32 |         0 |
| Flows                                |                      28 |         0 |
| Recipes                              |                      21 |         0 |
| Known Hazards                        |                      20 |         0 |
| State                                |                      13 |         0 |
| Scope                                |                      13 |         0 |
| Coupling                             |                      13 |         0 |
| Characters, Cards, Modules, Personas |                      10 |         0 |
| Files > Lorebook filter              |                       1 |         0 |
| Files > Chat lore overrides          |                       1 |         0 |
| Files > Character editor             |                       1 |         0 |
| Files > Lorebook editor              |                       1 |         0 |
| Files > Import transports            |                       1 |         0 |
| Flows > Import results               |                       1 |         0 |
| Flows > Card export                  |                       1 |         0 |
| Invariants > Characters and chats    |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Cards and CharX; Files > Characters; Files > Modules; Files > Module import; Files > Personas and conversion; Files > Module settings; Files > Asset pickers and lists; Flows > Card import; Flows > Realm download; Flows > Export reads and failures; Flows > Drops and deep links; Flows > Module activation; Invariants > Card formats; Invariants > Asset list rows; Invariants > Effective modules; Invariants > Lorebook rows and writers; Invariants > Personas; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### chat-pipeline

7 outline `docs:read` calls; 3 `docs:read` queries matching no heading or several.

| Heading                                         | Ranges (Read, `sed -n`) | docs:read |
| ----------------------------------------------- | ----------------------: | --------: |
| Files                                           |                      62 |         0 |
| Flows                                           |                      46 |         0 |
| Tests                                           |                      43 |         0 |
| Known Hazards                                   |                      40 |         0 |
| State                                           |                      34 |         0 |
| Flows > Job client and reply                    |                      34 |         0 |
| Invariants                                      |                      24 |         0 |
| Scope                                           |                      21 |         1 |
| Coupling                                        |                      20 |         0 |
| Recipes                                         |                      18 |         0 |
| Known Hazards > Issues                          |                      15 |         0 |
| Chat Pipeline: Send → Prompt → Request → Reply  |                      15 |         0 |
| Known Hazards > Limitations                     |                      12 |         0 |
| Known Hazards > Gotchas                         |                      10 |         0 |
| Flows > Stop for a job this tab does not follow |                       4 |         0 |
| Flows > Replays and uncertain creates           |                       4 |         0 |
| Flows > Send, in `DefaultChatScreen.svelte`     |                       2 |         2 |
| Files > Context report                          |                       4 |         0 |
| Files > Composer and drafts                     |                       3 |         1 |
| Flows > Request id retention                    |                       3 |         0 |
| Flows > Reply tail and sequences                |                       3 |         0 |
| Flows > Recovery reads                          |                       2 |         0 |
| Files > Reroll modules                          |                       2 |         0 |
| Files > Slash commands, groups, and search      |                       2 |         0 |
| Flows > Reroll                                  |                       2 |         0 |
| Flows > Job creation and Stop                   |                       2 |         0 |
| Flows > Not in `sendChat`                       |                       2 |         0 |
| Files > Send client and registries              |                       1 |         0 |
| Files > Prompt and templates                    |                       1 |         0 |
| Files > Lore                                    |                       1 |         0 |
| Files > Inlays                                  |                       1 |         0 |
| Flows > Reconnect and status reads              |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Send; Invariants > Lore matching.

### chat-store

5 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 4 reads of a revision without the guide (unmapped).

| Heading                                              | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------- | ----------------------: | --------: |
| Flows > Summaries and refresh                        |                       5 |         2 |
| Flows > Whole-chat writers                           |                       7 |         0 |
| Flows > Job hydration                                |                       6 |         0 |
| Flows > By-id ops                                    |                       5 |         0 |
| Flows > Server memory writes                         |                       5 |         0 |
| Flows > Map merges                                   |                       4 |         0 |
| Flows > Server generation jobs                       |                       4 |         0 |
| Flows > Chat checkpoints                             |                       4 |         0 |
| Scope                                                |                       3 |         0 |
| Files                                                |                       3 |         0 |
| Files > Readers                                      |                       3 |         0 |
| Files > Last chatted                                 |                       3 |         0 |
| Files > On-demand reads                              |                       3 |         0 |
| Files > Save adapter side                            |                       3 |         0 |
| Flows > Chat writes                                  |                       3 |         0 |
| Flows > Stored translations                          |                       3 |         0 |
| Flows > Job chunks                                   |                       3 |         0 |
| Flows > Callback hydration                           |                       3 |         0 |
| Flows > Restore floor                                |                       2 |         1 |
| Chat Store: Chat Module, Write Protocol, Checkpoints |                       2 |         0 |
| Flows                                                |                       2 |         0 |
| Flows > Selection                                    |                       2 |         0 |
| Flows > Deferral                                     |                       2 |         0 |
| State                                                |                       2 |         0 |
| Known Hazards > Limitations                          |                       2 |         0 |
| Files > Pins and eviction                            |                       1 |         0 |
| Files > Boundaries                                   |                       1 |         0 |
| Files > Locks and streaming                          |                       1 |         0 |
| Files > Render versions                              |                       1 |         0 |
| Files > Character lifecycle                          |                       1 |         0 |
| Files > Chat lists                                   |                       1 |         0 |
| Coupling                                             |                       1 |         0 |
| Invariants                                           |                       1 |         0 |
| Recipes                                              |                       1 |         0 |
| Tests                                                |                       1 |         0 |
| Known Hazards                                        |                       1 |         0 |
| Known Hazards > Issues                               |                       1 |         0 |
| Known Hazards > Gotchas                              |                       1 |         0 |

Every current `##`/`###` heading was touched.

### data-and-events

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### development-and-observability

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### diagnostics

1 reads of a revision without the guide (unmapped).

| Heading                                      | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------------- | ----------------------: | --------: |
| Files > Browser                              |                      18 |         0 |
| Files > Journal, reports, and support copies |                      11 |         0 |
| Tests                                        |                       9 |         0 |
| Files > History and checked failures         |                       8 |         0 |
| Flows                                        |                       6 |         0 |
| State                                        |                       6 |         0 |
| Known Hazards                                |                       4 |         0 |
| Recipes                                      |                       4 |         0 |
| Request History and Diagnostics              |                       3 |         0 |
| Scope                                        |                       3 |         0 |
| Files                                        |                       3 |         0 |
| Known Hazards > Limitations                  |                       3 |         0 |
| Coupling                                     |                       3 |         0 |
| Invariants                                   |                       3 |         0 |
| Known Hazards > Issues                       |                       2 |         0 |

Every current `##`/`###` heading was touched.

### domain-glossary

No heading-level reads.

The guide is gone from the current tree.

### draft-recovery

1 outline `docs:read` calls; 13 reads of a revision without the guide (unmapped).

| Heading                                                 | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------- | ----------------------: | --------: |
| Flows > Conflict capture                                |                       3 |         0 |
| Scope                                                   |                       1 |         1 |
| Files                                                   |                       1 |         1 |
| Flows > Chat recovery                                   |                       1 |         1 |
| Draft Recovery: Journal, Composer Rows, Recovery Drafts |                       1 |         0 |
| Flows > Recovery drafts                                 |                       1 |         0 |
| Flows > Apply                                           |                       1 |         0 |
| Flows > Chat journal                                    |                       0 |         1 |

Current `##`/`###` headings no read touched: Flows > Journal store; Flows > Eligibility; Flows > Composer API; Flows > Journal writes; Flows > Split confirmation; Flows > Boot recovery; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### durable-mutations-and-recovery

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### generated-and-legacy

No heading-level reads.

The guide is gone from the current tree.

### generation-rejection-register

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### global-api

| Heading                                | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------- | ----------------------: | --------: |
| Files                                  |                      70 |         0 |
| Tests                                  |                      23 |         0 |
| Flows                                  |                      22 |         0 |
| Known Hazards                          |                      16 |         0 |
| Scope                                  |                      14 |         0 |
| Coupling                               |                      11 |         0 |
| Invariants                             |                      10 |         0 |
| Recipes                                |                      10 |         0 |
| State                                  |                      10 |         0 |
| Files > Asset queues                   |                       6 |         0 |
| Files > Job channel                    |                       5 |         0 |
| Global API, Network, Utilities, Alerts |                       5 |         0 |
| Files > Asset sources                  |                       4 |         0 |
| Files > Asset client                   |                       3 |         0 |
| Files > Batch codec                    |                       3 |         0 |
| Files > Web Push                       |                       2 |         0 |
| Files > Generation job client          |                       2 |         0 |
| Files > Terminal and reload notices    |                       2 |         0 |
| Known Hazards > Issues                 |                       2 |         0 |
| Known Hazards > Limitations            |                       2 |         0 |
| Known Hazards > Gotchas                |                       2 |         0 |
| Files > Other `globalApi` exports      |                       1 |         0 |
| Files > `util.ts`                      |                       1 |         0 |
| Files > Alert queue                    |                       1 |         0 |
| Files > Alert helpers and `AlertComp`  |                       1 |         0 |
| Files > Network clients                |                       1 |         0 |
| Files > Other modules                  |                       1 |         0 |

Every current `##`/`###` heading was touched.

### intermediate-display

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### live-update-feed

1 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Flows; Flows > Live-update hello; Flows > Frame admission; Flows > Own chat changes; Flows > Feed chat entries; Flows > Coalescing and publish order; Flows > Publication budget; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations.

### live-updates

2 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several; 1 reads of a revision without the guide (unmapped).

| Heading                   | Ranges (Read, `sed -n`) | docs:read |
| ------------------------- | ----------------------: | --------: |
| Flows > Live updates      |                       0 |         1 |
| Flows > Chat live updates |                       0 |         1 |

Current `##`/`###` headings no read touched: Scope; Files; Flows > Feed connection; Flows > Feed locks; Flows > Restore halt; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations.

### llm-requests

| Heading                                      | Ranges (Read, `sed -n`) | docs:read |
| -------------------------------------------- | ----------------------: | --------: |
| Files                                        |                      55 |         0 |
| Tests                                        |                      22 |         0 |
| Known Hazards                                |                      18 |         0 |
| Recipes                                      |                      18 |         0 |
| Flows                                        |                      17 |         0 |
| Invariants                                   |                      16 |         0 |
| Scope                                        |                      14 |         0 |
| Coupling                                     |                      13 |         0 |
| State                                        |                      11 |         0 |
| LLM Requests, Model Catalogue, Tokenizers    |                       9 |         0 |
| Invariants > Compatibility Model-Root Writes |                       9 |         0 |
| Known Hazards > Issues                       |                       1 |         0 |
| Known Hazards > Limitations                  |                       1 |         0 |
| Known Hazards > Gotchas                      |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Catalogue and model resolution; Files > Model preset slots; Files > Credentials; Files > Tab request layer; Files > Server request layer; Files > Tokenizer selection and server counting; Files > Tab token counting; Files > Settings pages.

### mcp

1 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Files > MCP registry; Files > Remote MCP client; Files > Local MCP clients; Files > RisuAccess; Flows; Flows > Tool dispatch; Flows > Callbacks in the tab; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### media-aux

| Heading                                                                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                                        |                      33 |         0 |
| Tests                                                                        |                      16 |         0 |
| Flows                                                                        |                      14 |         0 |
| State                                                                        |                      12 |         0 |
| Scope                                                                        |                       8 |         0 |
| Known Hazards                                                                |                       7 |         0 |
| Coupling                                                                     |                       6 |         0 |
| Recipes                                                                      |                       5 |         0 |
| Media and Auxiliary Features: TTS, Image Generation, Translation, Playground |                       5 |         0 |
| Invariants                                                                   |                       4 |         0 |
| Known Hazards > Issues                                                       |                       3 |         0 |
| Files > Translator                                                           |                       2 |         0 |
| Files > LLM translation                                                      |                       2 |         0 |
| Known Hazards > Gotchas                                                      |                       2 |         0 |
| Files > Server translation                                                   |                       1 |         0 |
| Files > Stored translation                                                   |                       1 |         0 |
| Files > Chat row on the stored path                                          |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > TTS; Files > Image generation; Files > Media; Files > Playground; Files > Settings; Recipes > Add a TTS provider; Recipes > Add an image backend; Recipes > Change aux routing; Recipes > Change media compression.

### memory

| Heading                                  | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------- | ----------------------: | --------: |
| Flows > Server                           |                      23 |         0 |
| State                                    |                      22 |         0 |
| Files                                    |                      20 |         0 |
| Invariants                               |                      20 |         0 |
| Tests                                    |                      20 |         0 |
| Known Hazards                            |                      16 |         0 |
| Flows                                    |                      14 |         0 |
| Coupling                                 |                      14 |         0 |
| Recipes                                  |                      14 |         0 |
| Scope                                    |                      12 |         0 |
| Long-Term Memory and Embeddings          |                       8 |         0 |
| Known Hazards > Issues                   |                       6 |         0 |
| Flows > Background memory task           |                       5 |         0 |
| Flows > Selection, in `assemblePrompt`   |                       5 |         0 |
| Flows > V3 standard flow                 |                       5 |         0 |
| Known Hazards > Limitations              |                       4 |         0 |
| Flows > HypaV3 job modes                 |                       4 |         0 |
| Invariants > The memory toggle count     |                       3 |         0 |
| Flows > V3 `summarize`                   |                       3 |         0 |
| Flows > HypaV3 parts                     |                       3 |         0 |
| Server (Phase 5 slice 10)                |                       2 |         0 |
| Server                                   |                       2 |         0 |
| Flows > The no-memory trim question      |                       2 |         0 |
| Files > Algorithms                       |                       2 |         0 |
| Known Hazards > Gotchas                  |                       2 |         0 |
| Invariants > Deferred stored summaries   |                       2 |         0 |
| Flows > Tab embedding routing            |                       2 |         0 |
| Flows > Protection at the final re-check |                       2 |         0 |
| Flows > Summary writers                  |                       2 |         0 |
| Flows > Progress and the stop control    |                       2 |         0 |
| Invariants > Memory writes               |                       1 |         0 |
| Invariants > Token accounting            |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Embedding processors; Files > UI; Flows > Server persistence; Flows > Server embeddings and local models; Invariants > Data and memo values; Invariants > Server and tab copies; Invariants > Embedding credentials; Invariants > Embedding cache keys and limits.

### network-jobs

1 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Files > Network clients; Files > Generation job client; Files > Job channel; Files > Web Push; Flows; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### persistence

6 outline `docs:read` calls.

| Heading                                                            | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------ | ----------------------: | --------: |
| Flows                                                              |                     158 |         0 |
| Files                                                              |                     106 |         0 |
| Tests                                                              |                      99 |         0 |
| Known Hazards                                                      |                      82 |         0 |
| Invariants                                                         |                      80 |         0 |
| State                                                              |                      68 |         0 |
| Recipes                                                            |                      62 |         0 |
| Coupling                                                           |                      54 |         0 |
| Scope                                                              |                      46 |         1 |
| Persistence: Database, Server Resources, Save Adapter              |                      35 |         0 |
| Known Hazards > Gotchas                                            |                      20 |         1 |
| Known Hazards > Limitations                                        |                      19 |         0 |
| Known Hazards > Issues                                             |                      16 |         0 |
| Files > Settings records                                           |                       4 |         1 |
| Files > Shared shapes                                              |                       4 |         0 |
| Files > Record wrappers                                            |                       4 |         0 |
| Persistence: Database, Save Format, Storage Backends               |                       3 |         0 |
| Flows > Backend                                                    |                       3 |         0 |
| Flows > Device caches                                              |                       3 |         0 |
| Files > Mutation modules                                           |                       3 |         0 |
| Flows > Resources                                                  |                       3 |         0 |
| Flows > Character order repair                                     |                       2 |         1 |
| Flows > Browser-local import                                       |                       2 |         0 |
| Flows > Access                                                     |                       2 |         0 |
| Flows > Selection and deletion                                     |                       2 |         0 |
| State > Chat fields                                                |                       2 |         0 |
| State > Chat binding                                               |                       2 |         0 |
| State > Chat toggles                                               |                       2 |         0 |
| State > Messages                                                   |                       2 |         0 |
| Persistence: Database, Save Format, Storage Backends, Cold Storage |                       1 |         0 |
| Persistence: Database, Records, Mutation Stores                    |                       1 |         0 |
| State > Database                                                   |                       1 |         0 |

Every current `##`/`###` heading was touched.

### plugin-sandbox

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Files > Plugin install and registries; Files > Sandbox host; Files > Host API; Flows; Flows > Load and reset; Flows > Hook entry points; Flows > Hook targets; Flows > Database setters; Flows > Deferred reload; Flows > Job owner presence; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### plugins

No heading-level reads.

The guide is gone from the current tree.

### plugins-and-mcp

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### plugins-mcp

| Heading                               | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------- | ----------------------: | --------: |
| Known Hazards                         |                      34 |         0 |
| Tests                                 |                      31 |         0 |
| Invariants                            |                      25 |         0 |
| Files                                 |                      21 |         0 |
| Flows                                 |                      21 |         0 |
| State                                 |                      16 |         0 |
| Recipes                               |                      16 |         0 |
| Coupling                              |                      13 |         0 |
| Scope                                 |                       9 |         0 |
| Plugins (v3 Sandbox) and MCP Tools    |                       8 |         0 |
| Known Hazards > Issues                |                       6 |         0 |
| Flows > Job owner presence            |                       4 |         0 |
| Known Hazards > Gotchas               |                       4 |         0 |
| Flows > Hook entry points             |                       3 |         0 |
| Flows > Hook targets                  |                       3 |         0 |
| Files > Sandbox host                  |                       2 |         0 |
| Files > Host API                      |                       2 |         0 |
| Files > MCP registry                  |                       2 |         0 |
| Flows > Load and reset                |                       2 |         0 |
| Files > Plugin install and registries |                       2 |         0 |
| Flows > Database setters              |                       2 |         0 |
| Flows > Deferred reload               |                       2 |         0 |
| Flows > Tool dispatch                 |                       2 |         0 |
| Known Hazards > Limitations           |                       2 |         0 |
| Files > Remote MCP client             |                       1 |         0 |
| Files > Local MCP clients             |                       1 |         0 |
| Files > RisuAccess                    |                       1 |         0 |

The guide is gone from the current tree.

### prompt-assembly-and-scripting

No heading-level reads.

The guide is gone from the current tree.

### providers-and-models

1 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### README

No heading-level reads.

The guide is gone from the current tree.

### resource-sync

13 reads of a revision without the guide (unmapped).

| Heading                                              | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------- | ----------------------: | --------: |
| Known Hazards > Limitations                          |                       4 |         0 |
| Flows > Live updates                                 |                       3 |         0 |
| Flows > Chat live updates                            |                       3 |         0 |
| Flows > Feed connection                              |                       3 |         0 |
| Flows > Batch composition                            |                       2 |         0 |
| Flows > Restore halt                                 |                       2 |         0 |
| Resource Sync: Save Adapter, Transport, Live Updates |                       2 |         0 |
| Scope                                                |                       2 |         0 |
| Files                                                |                       2 |         0 |
| Flows > Serialization                                |                       2 |         0 |
| Flows > Conflicts                                    |                       2 |         0 |
| Flows > Transport                                    |                       2 |         0 |
| State                                                |                       2 |         0 |
| Known Hazards > Gotchas                              |                       2 |         0 |
| Flows                                                |                       1 |         0 |
| Flows > Boot load                                    |                       1 |         0 |
| Flows > Boot cache                                   |                       1 |         0 |
| Flows > Dirty marking                                |                       1 |         0 |
| Flows > Save cycle                                   |                       1 |         0 |
| Flows > Read deadlines                               |                       1 |         0 |
| Flows > Record patches                               |                       1 |         0 |
| Flows > Lost answers                                 |                       1 |         0 |
| Flows > Refusals and quarantine                      |                       1 |         0 |
| Flows > Record merge                                 |                       1 |         0 |
| Flows > Chat and order conflicts                     |                       1 |         0 |
| Flows > Generating refusals                          |                       1 |         0 |
| Flows > Record hydration                             |                       1 |         0 |
| Flows > Credential writes                            |                       1 |         0 |
| Flows > Feed locks                                   |                       1 |         0 |
| Flows > flushResources                               |                       1 |         0 |
| Flows > Unload                                       |                       1 |         0 |
| Coupling                                             |                       1 |         0 |
| Invariants                                           |                       1 |         0 |
| Recipes                                              |                       1 |         0 |
| Tests                                                |                       1 |         0 |
| Known Hazards                                        |                       1 |         0 |
| Known Hazards > Issues                               |                       1 |         0 |

Every current `##`/`###` heading was touched.

### scripts-triggers

| Heading                                       | Ranges (Read, `sed -n`) | docs:read |
| --------------------------------------------- | ----------------------: | --------: |
| State                                         |                      15 |         0 |
| Tests                                         |                      14 |         0 |
| Flows                                         |                      12 |         0 |
| Files                                         |                      11 |         0 |
| Recipes                                       |                      10 |         0 |
| Known Hazards                                 |                       9 |         0 |
| Invariants                                    |                       8 |         0 |
| Coupling                                      |                       7 |         0 |
| Scope                                         |                       7 |         0 |
| Regex Scripts, Triggers, Lua Scripting        |                       3 |         0 |
| Regex Scripts, Triggers, Lua/Python Scripting |                       1 |         0 |

Current `##`/`###` headings no read touched: Known Hazards > Issues; Known Hazards > Limitations; Known Hazards > Gotchas.

### self-host-server

9 outline `docs:read` calls; 1 `docs:read` queries matching no heading or several.

| Heading                                                       | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                         |                     156 |         0 |
| Tests                                                         |                     132 |         0 |
| Flows                                                         |                     110 |         0 |
| Invariants                                                    |                      86 |         0 |
| Known Hazards                                                 |                      86 |         0 |
| Files > Routes                                                |                      84 |         0 |
| Recipes                                                       |                      53 |         1 |
| State                                                         |                      53 |         0 |
| Scope                                                         |                      46 |         1 |
| Self-Host Server (Hono on Node), Docker                       |                      39 |         0 |
| Coupling                                                      |                      36 |         0 |
| Routes                                                        |                      24 |         0 |
| Known Hazards > Gotchas                                       |                      24 |         0 |
| Known Hazards > Limitations                                   |                      23 |         0 |
| Known Hazards > Issues                                        |                      19 |         0 |
| Flows > Changes from the former Express server                |                      12 |         0 |
| Files > Storage routes                                        |                       5 |         1 |
| State > Auth and push files                                   |                       4 |         0 |
| Self-Host Server (Hono on Node), Docker, Edge Proxies         |                       3 |         0 |
| State > Disk layout                                           |                       3 |         0 |
| State > Thumbnail cache                                       |                       1 |         2 |
| Files > Rate limits                                           |                       3 |         0 |
| Routes (`server.cjs`)                                         |                       2 |         0 |
| Flows > Proxying                                              |                       2 |         0 |
| Files > Asset responses                                       |                       2 |         0 |
| Files > Auth routes                                           |                       2 |         0 |
| Flows > Request bodies                                        |                       0 |         2 |
| Invariants > Migration checklist (Express → Fastify/Hono/...) |                       1 |         0 |
| State > User files                                            |                       1 |         0 |
| State > Process memory                                        |                       1 |         0 |
| Files > Missing asset check                                   |                       1 |         0 |
| Files > Thumbnail variant                                     |                       1 |         0 |
| Files > Entrypoints and configuration                         |                       1 |         0 |
| Files > Services and helpers                                  |                       1 |         0 |
| Files > Proxy routes                                          |                       1 |         0 |
| Files > Push routes                                           |                       1 |         0 |
| Files > Request history and diagnostics routes                |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Boot; Flows > Login flow.

### server

No heading-level reads.

The guide is gone from the current tree.

### server-generation

1 reads of a revision without the guide (unmapped).

| Heading                                           | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------- | ----------------------: | --------: |
| Flows > Generation channels                       |                       5 |         0 |
| Flows > Job chat and barriers                     |                       5 |         0 |
| Flows > Prompt job execution                      |                       5 |         0 |
| Coupling                                          |                       5 |         0 |
| State                                             |                       4 |         0 |
| Flows > Generation admission                      |                       4 |         0 |
| Known Hazards                                     |                       4 |         0 |
| Known Hazards > Issues                            |                       4 |         0 |
| Flows > Coalescing and publish order              |                       4 |         0 |
| Files                                             |                       4 |         0 |
| Files > Runtime modules                           |                       4 |         0 |
| Files > Generation routes                         |                       4 |         0 |
| Invariants                                        |                       3 |         0 |
| Recipes                                           |                       3 |         0 |
| Tests                                             |                       3 |         0 |
| Flows > Transform confirmations                   |                       3 |         0 |
| Known Hazards > Limitations                       |                       3 |         0 |
| Known Hazards > Gotchas                           |                       3 |         0 |
| Flows > Publication budget                        |                       3 |         0 |
| Flows > Live-update hello                         |                       3 |         0 |
| Flows > Frame admission                           |                       3 |         0 |
| Server generation and live channels               |                       3 |         0 |
| Scope                                             |                       3 |         0 |
| Flows                                             |                       3 |         0 |
| Flows > Own chat changes                          |                       3 |         0 |
| Flows > Feed chat entries                         |                       3 |         0 |
| Flows > Command sequences                         |                       2 |         0 |
| Flows > Local model refusals                      |                       2 |         0 |
| Files > Live-update socket                        |                       2 |         0 |
| State > Process memory                            |                       2 |         0 |
| Files > Transform, translation, and memory routes |                       1 |         0 |
| Files > LLM and token routes                      |                       1 |         0 |
| State > Job receipts                              |                       1 |         0 |

Current `##`/`###` headings no read touched: Flows > Chat-slot lookup and stop.

### server-resources

| Heading                              | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------ | ----------------------: | --------: |
| Flows > Snapshots and restore        |                       7 |         0 |
| State > Store tables                 |                       7 |         0 |
| State > Store open and normalization |                       7 |         0 |
| State > Process memory               |                       7 |         0 |
| Flows > Read budget                  |                       7 |         0 |
| Flows > Chat summaries               |                       7 |         0 |
| State > Checkpoint tables            |                       6 |         0 |
| State > Store connection             |                       5 |         0 |
| Flows > Archive export and import    |                       5 |         0 |
| State                                |                       5 |         0 |
| Flows > Epoch and response rules     |                       5 |         0 |
| Invariants                           |                       4 |         0 |
| Flows > Validation                   |                       4 |         0 |
| Flows > Upstream backups             |                       4 |         0 |
| State > Summary projection           |                       4 |         0 |
| Flows > Chat activity                |                       4 |         0 |
| Flows > File imports                 |                       3 |         0 |
| Flows > Maintenance                  |                       3 |         0 |
| Known Hazards > Limitations          |                       3 |         0 |
| Flows > Chat writes and checkpoints  |                       3 |         0 |
| Coupling                             |                       3 |         0 |
| Recipes                              |                       3 |         0 |
| Scope                                |                       3 |         0 |
| Files > Backup and import internals  |                       3 |         0 |
| Flows                                |                       3 |         0 |
| Known Hazards                        |                       2 |         0 |
| Known Hazards > Issues               |                       2 |         0 |
| Flows > Install                      |                       2 |         0 |
| Flows > Shutdown during a restore    |                       2 |         0 |
| Tests                                |                       2 |         0 |
| Server resources                     |                       2 |         0 |
| Files                                |                       2 |         0 |
| Files > Store and chats              |                       2 |         0 |
| Files > File import routes           |                       2 |         0 |
| Known Hazards > Gotchas              |                       1 |         0 |
| Files > Resource routes              |                       1 |         0 |
| Files > Message search route         |                       1 |         0 |
| Files > Chat checkpoint routes       |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Credential routes; Files > Backup routes; Files > Upstream backup routes.

### server-resources-and-bridges

3 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### server-sync

No heading-level reads.

The guide is gone from the current tree.

### settings-i18n

| Heading                                                | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------ | ----------------------: | --------: |
| Files                                                  |                      29 |         0 |
| State                                                  |                      20 |         0 |
| Invariants                                             |                      20 |         0 |
| Tests                                                  |                      17 |         0 |
| Recipes                                                |                      15 |         0 |
| Scope                                                  |                      15 |         0 |
| Flows                                                  |                      14 |         0 |
| Coupling                                               |                      10 |         0 |
| Settings UI, Bot Presets, Prompt Template Editor, i18n |                      10 |         0 |
| Known Hazards                                          |                       9 |         0 |
| Known Hazards > Issues                                 |                       5 |         0 |
| Known Hazards > Gotchas                                |                       3 |         0 |
| Files > Other handwritten pages                        |                       2 |         0 |
| Files > Declarative pages                              |                       1 |         0 |
| Files > Model and Prompt pages                         |                       1 |         0 |
| Files > Preset lists                                   |                       1 |         0 |
| Files > Settings search and jumps                      |                       1 |         0 |
| Files > Memory page                                    |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Registry and helpers; Files > Data arrays; Files > Renderers and credential links; Files > Settings navigation; Files > Prompt and parameter editors; Files > Languages.

### structured-memory

1 outline `docs:read` calls.

| Heading                                                                | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------- | ----------------------: | --------: |
| Invariants                                                             |                      19 |         0 |
| State > Memory tables                                                  |                      15 |         0 |
| Files                                                                  |                      15 |         0 |
| Recipes                                                                |                      15 |         0 |
| Tests                                                                  |                      15 |         0 |
| State                                                                  |                      14 |         0 |
| Flows > The HypaV3 projection                                          |                      14 |         0 |
| Known Hazards > Gotchas                                                |                      12 |         0 |
| Known Hazards > Limitations                                            |                      12 |         0 |
| Coupling                                                               |                      11 |         0 |
| Flows > A memory write                                                 |                      10 |         0 |
| Known Hazards                                                          |                      10 |         0 |
| Scope                                                                  |                       9 |         0 |
| Flows > The read routes                                                |                       9 |         0 |
| Flows                                                                  |                       8 |         0 |
| Flows > The edit route                                                 |                       6 |         0 |
| Flows > The Markdown package                                           |                       5 |         0 |
| Structured Memory: Events, Pages, Threads, Receipts                    |                       4 |         0 |
| Structured Memory: Records, Tables, Store, Routes, Package, Projection |                       3 |         0 |
| Flows > The restore route                                              |                       3 |         0 |
| Flows > Receipts                                                       |                       2 |         0 |
| Flows > The read path                                                  |                       2 |         0 |
| Known Hazards > Issues                                                 |                       2 |         0 |
| Flows > The memory panel                                               |                       1 |         0 |
| Flows > Reconciliation and repairs                                     |                       1 |         0 |
| Flows > A checkpoint                                                   |                       1 |         0 |
| Flows > Copies and branches                                            |                       1 |         0 |
| Flows > The writer's windows                                           |                       1 |         0 |
| Flows > The writer task                                                |                       1 |         0 |
| Flows > A writer run                                                   |                       1 |         0 |
| Flows > Record now                                                     |                       1 |         0 |
| Flows > The analysis prompt                                            |                       1 |         0 |
| Flows > Admission                                                      |                       1 |         0 |
| Flows > The reset                                                      |                       1 |         0 |

Current `##`/`###` headings no read touched: Guides.

### structured-memory-lifecycle

1 reads of a revision without the guide (unmapped).

| Heading                                                                      | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------------------- | ----------------------: | --------: |
| Invariants                                                                   |                       5 |         0 |
| Flows > Chat files                                                           |                       4 |         0 |
| Coupling                                                                     |                       4 |         0 |
| Known Hazards > Limitations                                                  |                       4 |         0 |
| Flows > Copies and branches                                                  |                       3 |         0 |
| State                                                                        |                       3 |         0 |
| Flows > Reconciliation and repairs                                           |                       2 |         0 |
| Flows > Retraction and edits                                                 |                       2 |         0 |
| Flows > A checkpoint                                                         |                       2 |         0 |
| Structured Memory Lifecycle: Reconciliation, Retraction, Checkpoints, Copies |                       2 |         0 |
| Scope                                                                        |                       2 |         0 |
| Files                                                                        |                       2 |         0 |
| Flows                                                                        |                       1 |         0 |
| Recipes                                                                      |                       1 |         0 |
| Tests                                                                        |                       1 |         0 |
| Known Hazards                                                                |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-pages

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### structured-memory-read

1 reads of a revision without the guide (unmapped).

| Heading                                                             | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------- | ----------------------: | --------: |
| Flows > The memory panel                                            |                      15 |         0 |
| Flows > The writer line                                             |                       8 |         0 |
| Flows > Receipts                                                    |                       7 |         0 |
| Flows > Pages, Timeline, and Threads                                |                       7 |         0 |
| Flows > The read path                                               |                       6 |         0 |
| Flows > Panel edits                                                 |                       6 |         0 |
| Tests                                                               |                       6 |         0 |
| Files                                                               |                       5 |         0 |
| State                                                               |                       5 |         0 |
| Recipes                                                             |                       5 |         0 |
| Known Hazards > Limitations                                         |                       4 |         0 |
| Known Hazards > Gotchas                                             |                       4 |         0 |
| Scope                                                               |                       4 |         0 |
| Coupling                                                            |                       4 |         0 |
| Structured Memory Read Path: Lanes, Card, Manifest, Receipts, Panel |                       3 |         0 |
| Flows                                                               |                       3 |         0 |
| Invariants                                                          |                       3 |         0 |
| Known Hazards                                                       |                       3 |         0 |
| Known Hazards > Issues                                              |                       3 |         0 |
| Flows > Prompt fine-tuning                                          |                       1 |         0 |
| Flows > The test run                                                |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-rebuild

1 reads of a revision without the guide (unmapped).

| Heading                                                                        | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------------------------------------------ | ----------------------: | --------: |
| Flows > During a run                                                           |                       3 |         0 |
| Flows > What a rebuild keeps                                                   |                       3 |         0 |
| Flows > The cost preview                                                       |                       3 |         0 |
| Known Hazards > Limitations                                                    |                       2 |         0 |
| Scope                                                                          |                       2 |         0 |
| Flows                                                                          |                       2 |         0 |
| Flows > A run                                                                  |                       2 |         0 |
| Flows > The plan                                                               |                       2 |         0 |
| Tests                                                                          |                       1 |         0 |
| Known Hazards                                                                  |                       1 |         0 |
| Known Hazards > Gotchas                                                        |                       1 |         0 |
| Structured Memory Rebuild: Runs, Staging, the Swap, Backfill, the Cost Preview |                       1 |         0 |
| Files                                                                          |                       1 |         0 |
| Flows > Backfill                                                               |                       1 |         0 |
| Flows > The swap                                                               |                       1 |         0 |
| Flows > The language change                                                    |                       1 |         0 |
| State                                                                          |                       1 |         0 |

The guide is gone from the current tree.

### structured-memory-writer

| Heading                                                          | Ranges (Read, `sed -n`) | docs:read |
| ---------------------------------------------------------------- | ----------------------: | --------: |
| Files                                                            |                      11 |         0 |
| Flows > The writer's windows                                     |                      10 |         0 |
| Flows > The writer task                                          |                      10 |         0 |
| Flows > A writer run                                             |                      10 |         0 |
| Flows                                                            |                       9 |         0 |
| State                                                            |                       9 |         0 |
| Flows > Record now                                               |                       8 |         0 |
| Scope                                                            |                       8 |         0 |
| Flows > The scene page                                           |                       8 |         0 |
| Flows > The gap run                                              |                       7 |         0 |
| Flows > The patch call                                           |                       7 |         0 |
| Known Hazards > Limitations                                      |                       6 |         0 |
| Tests                                                            |                       6 |         0 |
| Invariants                                                       |                       6 |         0 |
| Coupling                                                         |                       6 |         0 |
| Flows > The analysis prompt                                      |                       5 |         0 |
| Structured Memory Writer: Windows, Tasks, Runs, Admission, Pages |                       5 |         0 |
| Flows > Compaction                                               |                       5 |         0 |
| Known Hazards                                                    |                       4 |         0 |
| Flows > Admission                                                |                       4 |         0 |
| Recipes                                                          |                       4 |         0 |
| Known Hazards > Gotchas                                          |                       3 |         0 |
| Flows > Pages                                                    |                       3 |         0 |

The guide is gone from the current tree.

### structured-memory/projection

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Flows; Flows > The HypaV3 projection; Flows > A tab's read; Flows > The tab's mirror; Flows > A plugin's read; Flows > The upstream export; Flows > The reset; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### structured-memory/records

8 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Flows; Flows > The read routes; Flows > The edit route; Flows > The revert route; Flows > The restore route; Flows > The Markdown package; Flows > A memory write; State; State > Memory tables; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Limitations; Known Hazards > Gotchas.

### test-harness

8 reads of a revision without the guide (unmapped).

| Heading                         | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------- | ----------------------: | --------: |
| Flows > Browser specs           |                       5 |         0 |
| Tests > Slow-test table         |                       5 |         0 |
| Test Harness                    |                       5 |         0 |
| Scope                           |                       5 |         0 |
| Files                           |                       4 |         0 |
| Files > Reporter                |                       4 |         0 |
| Flows > Whole-suite lock        |                       3 |         0 |
| Tests > Slow tests              |                       3 |         0 |
| Files > Browser stack           |                       3 |         0 |
| Tests                           |                       3 |         0 |
| Files > Check scripts           |                       2 |         0 |
| Files > Measurement scripts     |                       2 |         0 |
| Tests > Timeouts                |                       2 |         0 |
| Files > Fixtures                |                       2 |         0 |
| Known Hazards                   |                       2 |         0 |
| Flows > Overload runner         |                       2 |         0 |
| Files > Vitest config and setup |                       2 |         0 |
| Files > Test inventory          |                       2 |         0 |
| Tests > Test rules              |                       2 |         0 |
| Recipes                         |                       1 |         0 |
| Coupling                        |                       1 |         0 |
| Tests > Mock factories          |                       1 |         0 |
| Tests > Network guard           |                       1 |         0 |
| Flows                           |                       1 |         0 |
| Flows > Test wrapper            |                       1 |         0 |
| Flows > Failed-file rerun       |                       1 |         0 |
| Known Hazards > Gotchas         |                       1 |         0 |
| Files > Human gate              |                       1 |         0 |

Current `##`/`###` headings no read touched: State; Invariants.

### translation

1 reads of a revision without the guide (unmapped).

No heading-level reads.

Current `##`/`###` headings no read touched: Scope; Files; Files > Translator; Files > LLM translation; Files > Presets and `.risutl`; Files > Server translation; Files > Stored translation; Files > Chat row on the stored path; Files > Bilingual display; Files > Translator pipeline and slots; Files > Settings; Flows; State; Coupling; Invariants; Recipes; Tests; Known Hazards; Known Hazards > Issues.

### translation-and-input-hooks

2 reads of a revision without the guide (unmapped).

No heading-level reads.

The guide is gone from the current tree.

### ui-theming

5 outline `docs:read` calls; 4 `docs:read` queries matching no heading or several.

| Heading                                    | Ranges (Read, `sed -n`) | docs:read |
| ------------------------------------------ | ----------------------: | --------: |
| Files                                      |                      68 |         0 |
| Tests                                      |                      23 |         0 |
| Known Hazards                              |                      20 |         0 |
| Scope                                      |                      18 |         0 |
| Invariants                                 |                      15 |         0 |
| Recipes                                    |                      13 |         0 |
| UI Components and Theming                  |                      12 |         0 |
| Coupling                                   |                      10 |         0 |
| Flows                                      |                      10 |         0 |
| State                                      |                       9 |         0 |
| Known Hazards > Limitations                |                       5 |         0 |
| Known Hazards > Issues                     |                       4 |         0 |
| Files > Message row                        |                       4 |         0 |
| Files > Sidebar                            |                       2 |         2 |
| Known Hazards > Gotchas                    |                       3 |         0 |
| Files > Message editors                    |                       2 |         0 |
| Files > Theme                              |                       0 |         1 |
| Files > GUI primitives                     |                       0 |         1 |
| Files > Transcript rows and the mount hold |                       1 |         0 |
| Files > Transcript scrolling               |                       1 |         0 |

Current `##`/`###` headings no read touched: Files > Chat screen; Files > Composer; Files > Context meter; Files > Dialogs, popovers, and portals; Files > Editor token counts; Files > Other UI.
