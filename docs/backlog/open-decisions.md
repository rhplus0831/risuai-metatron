# Open Decisions

Product and design questions the [surveys](../reports/surveys/README.md) and one regression analysis left to the owner. They sat at the bottom of the surveys index until 2026-11-11; the questions that were already answered then (server thumbnails, the upstream backup import, the upstream `.bin` stance, the fix crosscheck, direct asset URLs, the stage spinner) were dropped, and their outcomes are in the [plan archive](../archived-plan/README.md).

The rest were not re-read when they moved. Plans that ran after the surveys appear to answer several; each such entry names the plan. Confirm against that plan, then delete the entry.

## HaejeokRisuai ([§5](../reports/surveys/haejeok-feature-survey.md#5-open-questions))

- Branch model for persistent in-chat branches (A1): a message tree inside one chat record, or linked chats with a parent pointer.
- Cross-device stop (A13): is dropping the `clientId` match safe for plugin-provider jobs, which stream through the owning tab. Job Protocol slice 5 added the stop from another tab or device.
- Product direction: chat tabs with split panes (A6) and BTW threads (A7) both need concurrent sends in one tab, against the current mid-send switch design. Per-Chat Send has since let different chats of one tab send at the same time.
- Whether to pursue Termux/Android hosting (E3), which hinges on `onnxruntime-node` running there.

## RisuNest ([§3](../reports/surveys/risunest-ideas.md#3-open-questions))

- Reroll candidate shape (item 9): whether the persisted `responseVariants` field should match PocketRisu's for interchange. Reroll Candidates landed a `candidates` schema with a RisuAI-compatible export and import mapping.
- CI host: whether the self-hosted forge is Forgejo or Gitea with Actions runners, which decides whether item 5 is a workflow file or a server hook. RisuNest Small Wins D1 chose GitLab CI.
- Asset garbage collection (item 7): how far the mark phase must scan free text, plus grace period and pinned-snapshot semantics. Asset Lifecycle landed the mark, the sweep, and snapshot pins.
- Plugin storage isolation (item 11): whether any plugin in use reads another plugin's keys on purpose. Plugin Storage and Data API landed owned `pluginStorage` with legacy read-through.
- Which items to plan first; the session recommended bundling the six S-sized items (alert queue, safe boot, three plugin fixes, test network guard, CI/dockerignore, engineering rules) into one plan. RisuNest Small Wins was that plan.

## PocketRisu / RisuBard ([§6](../reports/surveys/pocketrisu-risubard-picks.md#6-recommended-order))

- The plugin permission keying and `pluginCustomStorage` merge rules (§2.3) need a check against the v3 plugin runtime before adoption. Plugin Storage and Data API kept the reserved dictionaries on a `pluginCustomStorage` write.
