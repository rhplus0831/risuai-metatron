# Open Decisions

Product and design questions the [surveys](../reports/surveys/README.md) and one regression analysis left to the owner. They sat at the bottom of the surveys index until 2026-11-11; the questions that were already answered then (server thumbnails, the upstream backup import, the upstream `.bin` stance, the fix crosscheck, direct asset URLs, the stage spinner) were dropped, and their outcomes are in the [plan archive](../archived-plan/README.md).

The rest were read against the later plans and the code on 2026-11-11: a question a plan settled was removed, and one settled in part was cut to what is still open.

## HaejeokRisuai ([§5](../reports/surveys/haejeok-feature-survey.md#5-open-questions))

- Branch model for persistent in-chat branches (A1): a message tree inside one chat record, or linked chats with a parent pointer.
- Should chat tabs with split panes (A6) be added now that Per-Chat Send supports concurrent sends in one tab? BTW threads (A7) were taken up on 2026-11-14 as the OOC Session plan, which landed the same day ([archive](../archived-plan/README.md)).
- Whether to pursue Termux/Android hosting (E3), which hinges on `onnxruntime-node` running there.

## RisuNest ([§3](../reports/surveys/risunest-ideas.md#3-open-questions))

- Plugin storage isolation (item 11): does any plugin in use intentionally read another plugin's keys and need access after those keys become owned?
