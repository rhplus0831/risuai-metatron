# Research notes

Read-only surveys of sibling RisuAI forks, written on 2026-10-20 against metatron
`44e18f2ae`. They list what each fork has that metatron lacks, what metatron already
covers, and what should not be ported. None of them changed code. Pending decisions
from each survey are collected at the bottom. Three later notes are not fork surveys: the
2026-10-23 spinner analysis looks at a metatron regression, the upstream ledger records
which upstream RisuAI commits metatron has taken and how to run the next intake, and the
found-issues list collects out-of-scope bugs and stale docs that sessions noticed while
working on something else.

| File                                                                                         | Subject                                                                                                                                                                                                                                | Written by                                                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [haejeok-feature-survey.md](haejeok-feature-survey.md)                                       | HaejeokRisuai (`/home/codex/HaejeokRisuai`): 47 candidates A1–F7 with fit and effort, top 10 picks, not-worth-porting list, open questions                                                                                             | Opus sub-agent, main claims re-checked by the session                                                |
| [risunest-ideas.md](risunest-ideas.md)                                                       | RisuNest (`/home/codex/RisuNest`): 18 ranked candidates plus a lower-priority bundle, already-covered list, open questions                                                                                                             | Opus sub-agent, six claims re-checked by the session                                                 |
| [pocketrisu-risubard-picks.md](pocketrisu-risubard-picks.md)                                 | PocketRisu + RisuBard: the cross-checked pick list (port now / adopt as policy / needs its own plan / do not port / shared-code bug fixes to compare), with a recommended order                                                        | Session, from the three surveys below                                                                |
| [pocketrisu-survey.md](pocketrisu-survey.md)                                                 | PocketRisu v1.15.0 (`/home/codex/PocketRisu`): ~60 features, 19 design concepts, 29 bug fixes, route map                                                                                                                               | Opus sub-agent                                                                                       |
| [risubard-survey.md](risubard-survey.md)                                                     | RisuBard 0.9.72 (`/home/codex/RisuBard`): features added on top of PocketRisu, 24 concepts, plugin API, doc/code mismatches                                                                                                            | Opus sub-agent                                                                                       |
| [metatron-inventory-vs-pocketrisu-risubard.md](metatron-inventory-vs-pocketrisu-risubard.md) | What metatron already has, partly has, or lacks, as the baseline for the PocketRisu/RisuBard comparison                                                                                                                                | Opus sub-agent                                                                                       |
| [pocketrisu-fix-crosscheck.md](pocketrisu-fix-crosscheck.md)                                 | Whether the 18 PocketRisu shared-code bug fixes (picks §5) apply to metatron: verdicts with file:line evidence; 7 still present, summarized in picks §5.1                                                                              | Opus sub-agents, still-present rows re-checked by the session                                        |
| [chat-generation-stage-colors-analysis.md](chat-generation-stage-colors-analysis.md)         | Why the send/stop spinner no longer changes color (its stage class is fixed to 0 since server jobs replaced the browser pipeline), with a server-reported stage design and a smaller client-side alternative; inspected at `79ae26cc4` | Not recorded; imported 2026-10-23                                                                    |
| [upstream-ledger.md](upstream-ledger.md)                                                     | Upstream RisuAI (`/home/codex/Risuai`) `25001174..f50b5942`: 79 commits with dispositions, harness targets, intake procedure                                                                                                           | Codex sub-agent, from the Upstream Integration plan's inventory; checked by the session              |
| [found-issues.md](found-issues.md)                                                           | 107 out-of-scope bugs, latent defects, stale docs and comments, and test flakes noticed 2026-10-14..24, grouped by area; delete an entry when it is fixed                                                                              | Agent sessions while working on other changes; moved from project memory 2026-10-24, not re-verified |

## Decisions these surveys left open

### HaejeokRisuai ([§5](haejeok-feature-survey.md#5-open-questions))

1. Branch model for persistent in-chat branches (A1): message tree inside one chat record, or linked chats with a parent pointer.
2. Cross-device stop (A13): is dropping the `clientId` match safe for plugin-provider jobs, which stream through the owning tab.
3. ~~Server thumbnails (B1): native `sharp` in the Docker image (and Termux) or a WASM encoder; icon 128² and catalog 512×768 sizes.~~ Planned 2026-10-23: [Server Thumbnails](../plan/server-thumbnails.md) (default native `sharp`, short side 256/512 uncropped; its D1/D2), to run after Direct Asset URLs.
4. ~~Upstream backup import (A14): how old an upstream backup must still be accepted.~~ Done 2026-10-21 (Upstream `.bin` Compatibility, all slices S1–S8 on branch `upstream-bin-compat`; [archived plan](../archived-plan/README.md)): every `\x07`/`\x08`/`\x09` `database.risudat` and both cold-storage record names are imported (its D9).
5. Product direction: chat tabs with split panes (A6) and BTW threads (A7) both need concurrent sends in one tab, against the current mid-send switch design.
6. Whether to pursue Termux/Android hosting (E3), which hinges on `onnxruntime-node` running there.

### RisuNest ([§3](risunest-ideas.md#3-open-questions))

1. ~~Upstream `.bin` import/export (item 10): keep the "no migration owed" stance, or accept a one-way converter now that there are users.~~ Decided 2026-10-20: upstream formats get a migration path (the old stance applies only to formats made during implementation); import (full replace) and export; Risu Account backups refused with an error. Done 2026-10-21: import and the RisuAI-compatible export landed as Upstream `.bin` Compatibility (slices S1–S8 on branch `upstream-bin-compat`; [archived plan](../archived-plan/README.md)); a restore in upstream RisuAI's own UI is still unverified.
2. Reroll candidate shape (item 9): whether the persisted `responseVariants` field should match PocketRisu's for interchange.
3. CI host: whether the self-hosted forge is Forgejo or Gitea with Actions runners, which decides whether item 5 is a workflow file or a server hook.
4. Asset garbage collection (item 7): how far the mark phase must scan free text, plus grace period and pinned-snapshot semantics.
5. Plugin storage isolation (item 11): whether any plugin in use reads another plugin's keys on purpose.
6. Which items to plan first; the session recommended bundling the six S-sized items (alert queue, safe boot, three plugin fixes, test network guard, CI/dockerignore, engineering rules) into one `docs/plan` entry.

### PocketRisu / RisuBard ([§6](pocketrisu-risubard-picks.md#6-recommended-order))

1. ~~Whether to start with the read-only comparison of the 18 shared-code bug fixes in §5.~~ Done 2026-10-20: [pocketrisu-fix-crosscheck.md](pocketrisu-fix-crosscheck.md). Which of the still-present rows to fix is open.
2. ~~Direct asset URLs with immutable caching (§2.1) need a security design against DPoP before they can be planned with the heap-memory work.~~ Planned 2026-10-23 with its security design: [Direct Asset URLs](../plan/direct-asset-urls.md). Done 2026-10-23: the service worker signs the existing `risu-auth` token for the page's asset loads (the plan's D1 (a)), with no cookie; verified content names are cached `immutable`.
3. The plugin permission keying and `pluginCustomStorage` merge rules (§2.3) need a check against the v3 plugin runtime before adoption.

### Chat generation spinner ([recommended fix](chat-generation-stage-colors-analysis.md#recommended-fix-server-reported-stages))

1. ~~Whether to restore the stage colors with server-reported job stages (recommended) or the limited client-side approximation; not planned yet.~~ Planned 2026-10-23 with server-reported stages: [Generation Stage Spinner](../plan/generation-stage-spinner.md).
