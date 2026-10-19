# Research notes

Read-only surveys of sibling RisuAI forks, written on 2026-10-20 against metatron
`44e18f2ae`. They list what each fork has that metatron lacks, what metatron already
covers, and what should not be ported. None of them changed code. Pending decisions
from each survey are collected at the bottom.

| File                                                                                         | Subject                                                                                                                                                                         | Written by                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [haejeok-feature-survey.md](haejeok-feature-survey.md)                                       | HaejeokRisuai (`/home/codex/HaejeokRisuai`): 47 candidates A1–F7 with fit and effort, top 10 picks, not-worth-porting list, open questions                                      | Opus sub-agent, main claims re-checked by the session         |
| [risunest-ideas.md](risunest-ideas.md)                                                       | RisuNest (`/home/codex/RisuNest`): 18 ranked candidates plus a lower-priority bundle, already-covered list, open questions                                                      | Opus sub-agent, six claims re-checked by the session          |
| [pocketrisu-risubard-picks.md](pocketrisu-risubard-picks.md)                                 | PocketRisu + RisuBard: the cross-checked pick list (port now / adopt as policy / needs its own plan / do not port / shared-code bug fixes to compare), with a recommended order | Session, from the three surveys below                         |
| [pocketrisu-survey.md](pocketrisu-survey.md)                                                 | PocketRisu v1.15.0 (`/home/codex/PocketRisu`): ~60 features, 19 design concepts, 29 bug fixes, route map                                                                        | Opus sub-agent                                                |
| [risubard-survey.md](risubard-survey.md)                                                     | RisuBard 0.9.72 (`/home/codex/RisuBard`): features added on top of PocketRisu, 24 concepts, plugin API, doc/code mismatches                                                     | Opus sub-agent                                                |
| [metatron-inventory-vs-pocketrisu-risubard.md](metatron-inventory-vs-pocketrisu-risubard.md) | What metatron already has, partly has, or lacks, as the baseline for the PocketRisu/RisuBard comparison                                                                         | Opus sub-agent                                                |
| [pocketrisu-fix-crosscheck.md](pocketrisu-fix-crosscheck.md)                                 | Whether the 18 PocketRisu shared-code bug fixes (picks §5) apply to metatron: verdicts with file:line evidence; 7 still present, summarized in picks §5.1                       | Opus sub-agents, still-present rows re-checked by the session |

## Decisions these surveys left open

### HaejeokRisuai ([§5](haejeok-feature-survey.md#5-open-questions))

1. Branch model for persistent in-chat branches (A1): message tree inside one chat record, or linked chats with a parent pointer.
2. Cross-device stop (A13): is dropping the `clientId` match safe for plugin-provider jobs, which stream through the owning tab.
3. Server thumbnails (B1): native `sharp` in the Docker image (and Termux) or a WASM encoder; icon 128² and catalog 512×768 sizes.
4. Upstream backup import (A14): how old an upstream backup must still be accepted.
5. Product direction: chat tabs with split panes (A6) and BTW threads (A7) both need concurrent sends in one tab, against the current mid-send switch design.
6. Whether to pursue Termux/Android hosting (E3), which hinges on `onnxruntime-node` running there.

### RisuNest ([§3](risunest-ideas.md#3-open-questions))

1. Upstream `.bin` import/export (item 10): keep the "no migration owed" stance, or accept a one-way converter now that there are users.
2. Reroll candidate shape (item 9): whether the persisted `responseVariants` field should match PocketRisu's for interchange.
3. CI host: whether the self-hosted forge is Forgejo or Gitea with Actions runners, which decides whether item 5 is a workflow file or a server hook.
4. Asset garbage collection (item 7): how far the mark phase must scan free text, plus grace period and pinned-snapshot semantics.
5. Plugin storage isolation (item 11): whether any plugin in use reads another plugin's keys on purpose.
6. Which items to plan first; the session recommended bundling the six S-sized items (alert queue, safe boot, three plugin fixes, test network guard, CI/dockerignore, engineering rules) into one `docs/plan` entry.

### PocketRisu / RisuBard ([§6](pocketrisu-risubard-picks.md#6-recommended-order))

1. ~~Whether to start with the read-only comparison of the 18 shared-code bug fixes in §5.~~ Done 2026-10-20: [pocketrisu-fix-crosscheck.md](pocketrisu-fix-crosscheck.md). Which of the still-present rows to fix is open.
2. Direct asset URLs with immutable caching (§2.1) need a security design against DPoP before they can be planned with the heap-memory work.
3. The plugin permission keying and `pluginCustomStorage` merge rules (§2.3) need a check against the v3 plugin runtime before adoption.
