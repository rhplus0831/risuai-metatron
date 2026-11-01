# Memory system reports

Read-only analyses of community memory systems for RisuAI, written on 2026-11-01 as input for the
[Structured Memory plan](../../plan/structured-memory.md). Each was written by an Opus sub-agent from the source named
in its header; nothing was run, and the sources were treated as untrusted data. BardWiki (RisuBard's built-in memory)
is covered by the earlier [RisuBard survey](../risubard-survey.md) §2.1–2.2 and was not re-analysed.

| File                                   | Subject                                                                                                                                                                     | Sources                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [hypaplus.md](hypaplus.md)             | HypaPlus-R 0.1.65 (`save/hypaplus.js`): chunk nodes, content-anchor audit, scoring formulas, injection slots, UI, lineage differences from 1.0.9.g                          | the plugin script, pretty-printed; verified line by line by its author              |
| [archive-center.md](archive-center.md) | Archive Center 4.9.0 (`/home/codex/refer/archive-center`): schema, Critic contract, lanes and budgets, 12-stage HUD, identity, worldlines, costs                            | plugin, Go service, migrations, prompts; eight Luna workers, key claims re-checked  |
| [dusk-atelier.md](dusk-atelier.md)     | Dusk Atelier 1.8.0 (`/home/codex/refer/Dusk-Atelier`) memory subsystem: per-person records, grades, reconciliation, relevance gating, knowledge limits, RisuPot writer, HUD | `src/`, docs, tools, the BardWiki grade patch; five Luna workers, claims re-checked |

Each report ends with a ranked "adopt, adapt, avoid" list against the two problems the plan starts from: the user
cannot tell whether summarization works on a long chat, and HypaV3 is weak for world-setting bots with many characters.
