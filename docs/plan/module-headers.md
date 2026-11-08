# Module Headers Plan

Status: drafted 2026-11-08, after the owner retired the whole-tree byte gate (`f0dd6db44`) and added the stale report
(`0c137ab45`). Decisions D1–D10 are recommendations for the owner; the **Open questions** Q1–Q4 were answered on
2026-11-08 with their recommended options (persistence joins, server-generation does not; no tests per slice; no
cap on found issues, one sweep after; pairs). Measurements are at `0c137ab45` on `dev`; re-run the commands under
**Current state** before a slice starts (STRUCTURE.md protocol step 5). Landed: 1 (`b786a0938`), 2 (`ca958b7ec`), 4 (`28b6c54fe`).

Sources: the owner's 2026-11-08 decision not to run a second Guides To Source pass (the `Files` sections are already
path, role, and identifier pointers: 475 of 807 named source paths carry a module header, 8,106 of 9,796 exports a doc
comment, and 96% of the `Flows` subsections are cross-module or conceptual, so nothing is left to move); the archived
[Guides To Source](../archived-plan/README.md#completed-plans) plan (`git show 786dfc3d3:docs/plan/guides-to-source.md`),
whose D2 (per-guide procedure), D4 (source comment form), and D6 (low-coverage areas write source first, from the code)
this plan carries over; the guide rules in [Doc Maintenance](../structure/README.md); and the measurements below.

Owning guides when sliced: [self-host-server](../structure/self-host-server.md),
[chat-pipeline](../structure/chat-pipeline.md), [global-api](../structure/global-api.md),
[llm-requests](../structure/llm-requests.md), and [persistence](../structure/persistence.md) (Q1);
[server-generation](../structure/server-generation.md) stays out (Q1). The scripts the slices run
(`util/docsContracts.mjs`, `util/docsLedger.mjs`, `util/docsRead.mjs`) belong to
[build-test-platforms](../structure/build-test-platforms.md) and are not changed by this plan.

## Goal

Source documentation where the guides are read and changed most and the module headers are thinnest. For each guide
in scope, every source path its `Files` section names has a `/** */` module header, and every export of the paths
that guide owns has a doc comment; a path the guide names but another guide owns gets its header and comments on the
identifiers the entry names. The guide's `Files` entry then shrinks to the path, its role, and the identifiers to look
up, as a by-product and only where the header now holds the rest. The goal is header coverage, not bytes: there is no
byte target, no tree ratchet, and no trim of any other guide.

Coverage is measured per guide with two commands: `pnpm docs:read <guide> Files` lists the named paths, and
`pnpm docs:contracts <paths>` prints each file's module header (or `module header: none`), each export with its doc
comment, the exports without one, and `documented N of M`. A guide is done when that run prints no
`module header: none` and, for the paths the guide owns, `documented M of M` for every file.

## Current state

Measured on 2026-11-08 at `0c137ab45`. Reads are guide reads counted by `pnpm docs:reads` since 2026-09-26; churn is
the commits touching the guide since 2026-10-09; the header and export columns are from `pnpm docs:contracts` over
every source path the guide's `Files` section names, by the recipe below (the session that chose this plan counted a
narrower path set the same day: self-host-server 3 of 21 headers and 65 of 103 exports, chat-pipeline 6 of 36 and
188 of 228, global-api 8 of 22 and 162 of 203, llm-requests 23 of 63 and 204 of 350; the recipe below is the baseline
a slice re-measures against).

| Guide                   | Reads | Churn | Named source paths | With a module header | Exports documented |
| ----------------------- | ----: | ----: | -----------------: | -------------------: | -----------------: |
| self-host-server        |   856 |   179 |                 26 |                    4 |          99 of 145 |
| chat-pipeline           |   295 |   109 |                 36 |                    6 |         188 of 228 |
| global-api              |   235 |    75 |                 21 |                   12 |         158 of 198 |
| llm-requests            |   160 |    39 |                 58 |                   24 |         185 of 320 |
| persistence (Q1: in)    |   647 |     – |                 29 |                   17 |         439 of 553 |
| server-generation (out) |    58 |     – |                 23 |                    9 |         213 of 265 |

The recipe, for one guide (a `.json` or other non-source path the section names, such as `server/tsconfig.json`, is
left out; a glob or brace span is expanded by hand):

```sh
pnpm --silent docs:read <guide> Files | grep -o '`[^`]*`' | tr -d '`' \
  | grep -E '^(src|server|shared|util|e2e|public)/.*\.(ts|mts|js|mjs|svelte)$' | sort -u > /tmp/<guide>.paths
pnpm --silent docs:contracts $(cat /tmp/<guide>.paths) | tee /tmp/<guide>.contracts | tail -1
grep -c 'module header: none' /tmp/<guide>.contracts
pnpm --silent docs:owner $(cat /tmp/<guide>.paths)
```

Other facts the slices rely on:

- `pnpm docs:contracts` counts a `/** */` block directly above a declaration; a `//` comment does not count, and a
  block touching the first statement after the imports is that statement's comment, not a module header. Re-exports
  are listed apart and never counted as undocumented. A `.svelte` file's contract is the header of its instance
  `<script>`; a block touching the `$props()` statement counts.
- `pnpm docs:ledger <guide>` compares the base revision's `Files` and `Flows` identifiers with the working guide and
  the files it names; `pnpm docs:ledger --stale <guide>` lists names in code spans that no source file holds. At
  `0c137ab45` the six guides above have one stale identifier between them (`llm-requests.md:315`, `Fixtures`).
- `pnpm check:docs` validates relative links, repository paths in code spans, the guide outline, the per-file and
  per-section budgets, and `ownership.json`; it prints the tree total as a trend figure with no gate.
- The four guides' named paths overlap in six files (the owner in parentheses): self-host-server and chat-pipeline
  share `shared/assetMime.ts` (self-host-server); self-host-server and llm-requests share `server/src/app.ts`
  (self-host-server), `server/src/routes/proxy.ts` (self-host-server), and `server/src/llm/auxOps.ts` (llm-requests);
  chat-pipeline and llm-requests share `shared/contextReport.ts` and `src/ts/process/stringlize.ts` (both
  chat-pipeline). global-api shares no named path with any of the other three. persistence shares
  `src/ts/storage/settingsViews.svelte.ts` with llm-requests and `shared/jobs.ts` with server-generation;
  server-generation shares `server/src/llm/requests.ts`, `server/src/routes/llm.ts`, and `server/src/routes/tokens.ts`
  with llm-requests.
- The Guides To Source run (2026-11-04 and 2026-11-05) ran no test suite at the owner's request and produced 35
  found-issues entries, two-thirds of them code defects, which the Found Issues Sweep plan then worked through. Those
  entries came from reading the code closely, not from a missing test run; this plan's slices will read code just as
  closely.

## Decisions

- **D1. The unit of work is a source path the guide's `Files` section names.** The recipe under **Current state**
  defines the set: every repository path in a code span of the section that is a `.ts`, `.mts`, `.js`, `.mjs`, or
  `.svelte` file, whoever owns it. Paths named only under `Flows`, `Tests`, or `Known Hazards`, test files, and
  configuration files are out. For a path the guide owns (`pnpm docs:owner`), the slice documents every export; for a
  path another guide owns, the module header and the identifiers the entry names, leaving the rest to that guide's
  slice or a later plan. This keeps a slice from rewriting `shared/database.ts` (persistence) because llm-requests
  names one constant in it.
- **D2. The per-slice procedure, carried from Guides To Source D2 and D6.** A slice: (1) runs the recipe and keeps the
  `docs:contracts` output as its before list; (2) for each path without a header, reads the module and writes the
  header from the code, then the doc comments the exports lack; (3) only then reads the guide's `Files` entry (and the
  `Flows`, `State`, and `Invariants` sentences that name the path) and compares each claim with what it just read in
  the code; (4) rewrites the `Files` entry to path, role, and identifiers where the header now holds the rest, keeping
  every heading anchor another guide links to (`rg -o '<guide>\.md#[a-z0-9-]+' docs STRUCTURE.md`); (5) runs
  `pnpm docs:ledger <guide>` for the trim ledger, then `pnpm docs:ledger --stale <guide>`, `pnpm docs:contracts` over
  the before list again, `pnpm check`, `pnpm check:docs`, and `pnpm format:check`; (6) commits once, with the ledger
  (one destination per removed fact, by old section) and the before and after coverage lines in the message. The
  order matters: the header is written from the code before the guide is read, so the guide's text cannot leak into
  the source (D6 of the archived plan).
- **D3. Source comment form, carried from Guides To Source D4.** A module header is one `/** */` block after the
  imports and before the first declaration, separated from it by a blank line, as `shared/sections.ts` and
  `src/ts/storage/chatStore.svelte.ts` have; an export's rule is a JSDoc block on the export; a Svelte component's
  contract is a JSDoc block at the top of its instance `<script>`. A header says what the module is for, the
  invariant, ordering, or failure behavior the body does not show, and names other modules by path when a rule
  crosses one. It never names a guide heading (anchors move), carries no plan, slice, or audit label (STRUCTURE.md
  T5), and does not retell history. A header stays under about 40 lines; beyond that the rules go on the exports. An
  export whose name and signature say everything gets one line, not a paragraph.
- **D4. A guide claim the code contradicts is never copied into a header.** When the code and the guide disagree, the
  slice decides from the code: if the guide drifted (a renamed identifier, a changed default, a route that moved), the
  slice fixes the sentence in its own guide in the same commit; if the code looks wrong (the guide describes the
  intended behavior and the code does something else), the slice records a found-issues entry with the path, the
  identifier, what the guide says, what the code does, and why it matters, and leaves both as they are. The header
  describes the code as it is. A slice fixes no code.
- **D5. Shared files.** Two slices running at once never touch the same source file (the paths above). A file both
  name is written by the slice whose guide owns it; the other slice leaves that file and its `Files` entry for it as
  they are, and notes the deferral in its commit message. Two slices that run one after another need no rule: the
  later one re-runs `docs:contracts` and adds only what is missing. The pairing under D8 and Q4 follows from this.
- **D6. Checks per slice: `pnpm check` and `pnpm check:docs`, not the test suite (Q2).** A slice changes comments and
  Markdown only, so no test can change its result except one that reads source text (STRUCTURE.md V9), and none reads
  these modules. `pnpm check` must stay green: svelte-check and the strict server project read the comments, and a
  malformed block is a parse error. `pnpm docs:contracts` after the edit confirms the header is recognized as one
  (D3's blank line). The full `pnpm --silent test:agent` gate runs once on the combined tree in the final slice.
- **D7. Found issues: record, do not fix, no cap on recording (Q3).** A slice that notices a defect while reading
  saves it the way every session does (the agents' project memory first, moved into
  [found issues](../research/found-issues.md) by the plan-runner when the run finishes), in the inbox's form: path,
  identifier, why it matters, suggested handling. It does not reproduce the defect, write a test for it, or fix it,
  and it spends no more than the entry on it. A cap on entries would hide defects, so none; the cap is on effort per
  entry. The entries are swept once, after the last slice lands, by one session (a small Found Issues Sweep as the
  earlier one), not by the slices.
- **D8. Pairing: two sessions at once, on guides that share no file they would both write (Q4).** Pair A is
  self-host-server beside chat-pipeline: their one shared path, `shared/assetMime.ts`, is self-host-server's under
  D5. Pair B, after both of A have landed, is global-api beside llm-requests: they share nothing, and llm-requests
  finds `server/src/app.ts`, `server/src/routes/proxy.ts`, `shared/contextReport.ts`, and
  `src/ts/process/stringlize.ts` already done by pair A. Slice 5, persistence, runs alone after pair B (Q1 left
  server-generation out, so there is no pair C): it writes `shared/jobs.ts`, whose owner does not join, and
  `src/ts/storage/settingsViews.svelte.ts`, which llm-requests deferred to it. Each session of a pair rebases onto
  the other's commit before landing and re-runs `pnpm check:docs` on the combined tree.
- **D9. The guide shrinks only as a by-product.** A `Files` entry becomes path, role, and identifiers when, and only
  when, the header and export comments now hold what the entry said; a fact the header does not hold stays in the
  guide. No `Flows` subsection moves, no other guide is trimmed, and no byte figure is a target or a check. The
  `Known Hazards`, `Tests`, `State`, `Coupling`, and `Invariants` sections are touched only to fix a claim under D4.
- **D10. Each slice reports its coverage in the commit message.** The message carries the guide's before and after
  lines (`N paths without a header`, `documented N of M`), the trim ledger, the deferred shared files (D5), and the
  count of found-issues entries saved, so the archive entry can state the plan's result without re-measuring.

## Open questions

- **Q1. Do persistence and server-generation join?** Answered 2026-11-08: persistence yes, server-generation no, as
  recommended; Slice 5 runs alone after pair B and Slice 6 is kept as a path list for a later plan. Recommended:
  persistence yes, server-generation no.
  persistence is the second most-read guide (647 reads) and its named paths lack 12 headers and 114 export comments,
  26 of them in `shared/jobs.ts` (server-generation's), 11 each in `shared/chatCheckpoints.ts` and
  `src/ts/storage/pluginStorageStore.svelte.ts`, 10 each in `shared/resources.ts` and
  `src/ts/storage/settingsViews.svelte.ts`; it also owns `src/ts/storage/settingsViews.svelte.ts` and `shared/database.ts`, which
  llm-requests names and defers under D1 and D5. server-generation has the fewest reads of the six (58), and three
  of its 14 header-less paths are llm-requests files that Slice 4 writes anyway. Alternative: both join as pair C;
  or neither, and the plan ends after pair B.
- **Q2. Do slices run tests?** Answered 2026-11-08: no, as recommended. Recommended: no, `pnpm check` and
  `pnpm check:docs` per slice (D6) and one full
  `pnpm --silent test:agent` in the final slice. Alternative: each slice also runs `pnpm --silent test:agent` on the
  directories of the paths it touched (for self-host-server, `server/src/http server/src/routes server/src/data`);
  it costs a few minutes per slice and can only catch a comment that broke a source-text test.
- **Q3. Who sweeps the found issues, and is there a cap per slice?** Answered 2026-11-08: no cap, one sweep session
  after the last slice, as recommended. Recommended: no cap on recording, one sweep
  session after the last slice lands (D7), scoped to the entries this run added; the slices never fix. Alternative:
  a cap of five entries per slice, the rest noted as "more in `<path>`" in the commit message; or the slices fix
  one-line defects in place, which turns a comments-only diff into a code diff and brings the test suite back (Q2).
- **Q4. Pairs or serial?** Answered 2026-11-08: pairs, as recommended; with Q1 the rounds are pair A, pair B, then
  Slice 5 alone. Recommended: pairs as D8, A then B, four sessions in two rounds.
  Alternative: strictly serial in the **Recommended order**; slower, with no rebase step and no D5 deferral.

## Slices

One guide per slice, one session and one commit each, by D2. Each slice's path list is the recipe's output at
`0c137ab45`; the session re-runs the recipe first and works from the current list. Under each slice, "owned
elsewhere" marks the paths another guide owns (D1: header and the named identifiers only).

### Slice 1: self-host-server (D1–D7, D9, D10; needs nothing)

26 named source paths, 22 without a header, 99 of 145 exports documented. Owned elsewhere: `server/src/llm/auxOps.ts`
(llm-requests, deferred to Slice 4 under D5 when Slice 4 runs beside this one; written here otherwise),
`shared/assetBatch.ts` (assets), `shared/notifications.ts` (network-jobs). `server/tsconfig.json` is named but is
not source.

```text
server/src/app.ts                        header missing, 2 of 3
server/src/data/assetLifecycle.ts        2 of 9
server/src/data/durableWrite.ts          header missing
server/src/data/orderedWriter.ts         header missing, 1 of 2
server/src/http/assetThumbnails.ts       header missing, 2 of 6
server/src/http/assetVerification.ts     header missing, 5 of 6
server/src/http/body.ts                  header missing, 1 of 2
server/src/http/clientIp.ts              header missing, 3 of 4
server/src/http/compressedJson.ts        3 of 4
server/src/http/diskSpace.ts             header missing, 4 of 5
server/src/http/rateLimit.ts             header missing, 2 of 3
server/src/http/staticCache.ts           header missing, 2 of 3
server/src/listenConfig.ts               header missing, 4 of 5
server/src/llm/auxOps.ts                 header missing, 3 of 5 (owned by llm-requests)
server/src/main.ts                       header missing
server/src/push/pushService.ts           header missing, 3 of 5
server/src/routes/assetLifecycle.ts      header missing
server/src/routes/auth.ts                header missing, 2 of 7
server/src/routes/proxy.ts               header missing
server/src/routes/push.ts                header missing
server/src/routes/storage.ts             header missing, 12 of 15
shared/assetBatch.ts                     (owned by assets)
shared/assetLifecycle.ts                 header missing, 3 of 16
shared/assetMime.ts                      header missing
shared/notifications.ts                  (owned by network-jobs)
shared/routes.ts                         header missing
```

- The `Files` section already says "a module's contract is its doc comments"; the `Routes`, `Rate limits`, and the
  per-family route subsections under `Files` describe admission, limiters, and body caps per route. Where
  `server/src/app.ts`'s header and the route modules' headers now state those, the subsections become the route
  list with a pointer; where a rule spans routes (the four limiter buckets, the thumbnail sizes repeated in three
  places), it stays.
- Done when: the recipe prints no `module header: none` for the guide and `documented M of M` for every owned path;
  `pnpm docs:ledger self-host-server` is empty; `pnpm docs:ledger --stale self-host-server` reports no more than
  before; `pnpm check`, `pnpm check:docs`, and `pnpm format:check` pass; the commit message carries D10's lines.

### Slice 2: chat-pipeline (D1–D7, D9, D10; needs nothing; runs beside Slice 1)

36 named source paths, 30 without a header, 188 of 228 exports documented. Owned elsewhere: `shared/assetMime.ts`
(self-host-server, Slice 1's under D5), `src/ts/bootstrap.ts` (app-shell), `src/ts/network/generationJobs.ts`
(network-jobs), `src/ts/process/serverCommands.ts` (scripts-triggers).

```text
shared/assetMime.ts                            header missing (Slice 1 writes it)
shared/contextReport.ts                        header missing, 17 of 21
shared/eligibleHistory.ts                      header missing
shared/lore/activation.ts                      header missing, 7 of 10
shared/lore/overrides.ts                       5 of 6
shared/messageSearch.ts                        header missing, 7 of 9
shared/openai.ts                               header missing, 0 of 2
shared/presetTemplates.ts                      header missing, 1 of 8
shared/prompt/chatTemplate.ts                  header missing, 2 of 5
shared/prompt/templateCheck.ts                 header missing
src/ts/bootstrap.ts                            header missing (owned by app-shell)
src/ts/messageSearch.svelte.ts                 15 of 16
src/ts/network/generationJobs.ts               (owned by network-jobs)
src/ts/process/chatStatus.svelte.ts            header missing, 13 of 15
src/ts/process/command.ts                      header missing
src/ts/process/composerDrafts.svelte.ts        2 of 3
src/ts/process/files/inlays.ts                 18 of 21
src/ts/process/files/multisend.ts              header missing
src/ts/process/group.ts                        header missing
src/ts/process/index.svelte.ts                 header missing
src/ts/process/infunctions.ts                  header missing
src/ts/process/inputTranslation.svelte.ts      header missing, 3 of 4
src/ts/process/jobStages.ts                    header missing
src/ts/process/localSends.ts                   header missing
src/ts/process/loreOverrides.ts                header missing
src/ts/process/lorebook.svelte.ts              header missing, 5 of 7
src/ts/process/prompt.ts                       header missing, 2 of 5
src/ts/process/rerollCandidates.ts             header missing
src/ts/process/rerollHistory.ts                header missing
src/ts/process/sendAborts.svelte.ts            header missing
src/ts/process/sendDraft.ts                    header missing
src/ts/process/serverCommands.ts               (owned by scripts-triggers)
src/ts/process/serverGeneration.ts             header missing
src/ts/process/stringlize.ts                   header missing, 1 of 6
src/ts/process/templates/chatTemplate.ts       header missing
src/ts/process/templates/templates.ts          header missing
```

- `src/ts/process/index.svelte.ts` is the send entrypoint and the largest module here; its header stays within D3's
  40 lines (what `sendChat` and `previewChat` promise, the server-job boundary) and the rest goes on the exports.
  `shared/lore/activation.ts` is shared with the server: its header names the host contract (`LoreHost`), and the
  matching rules stay under the guide's `Lore matching` heading, which other guides link to.
- Done when: as Slice 1, for chat-pipeline, with `shared/assetMime.ts` either done by Slice 1 or deferred in the
  message.

### Slice 3: global-api (D1–D7, D9, D10; needs 1 and 2 landed; runs beside Slice 4)

21 named source paths, 9 without a header, 158 of 198 exports documented. Owned elsewhere: `src/App.svelte` and
`src/ts/hotkey.ts` (app-shell), `src/lib/Others/RequestLogs/RequestLogsPopup.svelte` and
`src/lib/Others/RequestLogs/ServerRequestHistory.svelte` (diagnostics), `src/ts/storage/characterOrder.ts`
(persistence), `src/ts/storage/resourceSync.svelte.ts` (resource-sync).

```text
src/App.svelte                                            (owned by app-shell)
src/lib/Others/AlertComp.svelte
src/lib/Others/IrisModal.svelte
src/lib/Others/ReloadNotice.svelte
src/lib/Others/RequestLogs/RequestLogsPopup.svelte        (owned by diagnostics)
src/lib/Others/RequestLogs/ServerRequestHistory.svelte    (owned by diagnostics)
src/lib/Others/TerminalNotice.svelte
src/ts/alert.ts                                           32 of 38
src/ts/alertQueue.ts                                      header missing
src/ts/chatFold.svelte.ts                                 header missing
src/ts/dragTypes.ts
src/ts/globalApi.svelte.ts                                header missing, 34 of 38
src/ts/hotkey.ts                                          header missing (owned by app-shell)
src/ts/iris.ts                                            header missing
src/ts/licenses.ts                                        header missing
src/ts/sourcemap.ts                                       header missing, 1 of 2
src/ts/storage/characterOrder.ts                          (owned by persistence)
src/ts/storage/resourceSync.svelte.ts                     34 of 37 (owned by resource-sync)
src/ts/util.ts                                            header missing, 30 of 54
src/ts/util/inlayTokens.ts                                header missing
src/ts/util/koreanSearch.ts                               3 of 5
```

- `src/ts/globalApi.svelte.ts` is the facade three guides share (`ownership.json` marks its asset and fetch parts as
  assets' and network-jobs'); its header says what the facade is and where each part's rules live, by path, and
  stays within D3's limit. `src/ts/util.ts` has 24 undocumented exports, most of them small helpers: one line each.
- Done when: as Slice 1, for global-api.

### Slice 4: llm-requests (D1–D7, D9, D10; needs 1 and 2 landed; runs beside Slice 3)

58 named source paths, 34 without a header, 185 of 320 exports documented. Owned elsewhere: `server/src/app.ts` and
`server/src/routes/proxy.ts` (self-host-server, done by Slice 1), `shared/contextReport.ts` and
`src/ts/process/stringlize.ts` (chat-pipeline, done by Slice 2), `server/src/routes/tokens.ts` (server-generation),
`shared/database.ts` and `src/ts/storage/settingsViews.svelte.ts` (persistence; deferred to Slice 5),
`src/lib/Setting/Pages/ModelProfilesSettings.svelte` (settings-i18n). This is the low-coverage area of the four
(`server/src/llm` was 46% documented when Guides To Source measured it), so it adds the most source lines.

```text
server/src/app.ts                                         (Slice 1)
server/src/llm/anthropic.ts                               header missing, 0 of 1
server/src/llm/auxOps.ts                                  header missing, 3 of 5
server/src/llm/credentials.ts                             header missing
server/src/llm/google.ts                                  header missing, 0 of 1
server/src/llm/messages.ts                                header missing, 0 of 1
server/src/llm/nai.ts                                     header missing, 0 of 2
server/src/llm/openAI/requests.ts                         header missing, 0 of 3
server/src/llm/openAI/shared.ts                           header missing, 2 of 3
server/src/llm/openrouter.ts                              header missing
server/src/llm/outer.ts                                   header missing
server/src/llm/redact.ts                                  header missing, 2 of 5
server/src/llm/request.ts                                 header missing, 8 of 12
server/src/llm/requests.ts                                header missing, 10 of 15
server/src/llm/settings.ts                                header missing, 9 of 11
server/src/llm/shared.ts                                  header missing, 2 of 5
server/src/llm/sseLines.ts                                header missing
server/src/prompt/tokenizers/index.ts                     header missing, 1 of 3
server/src/prompt/tokenizers/payloads.ts                  header missing, 2 of 3
server/src/prompt/tokens.ts                               4 of 8
server/src/routes/llm.ts                                  header missing
server/src/routes/proxy.ts                                (Slice 1)
server/src/routes/tokens.ts                               header missing (owned by server-generation)
shared/contextReport.ts                                   (Slice 2)
shared/database.ts                                        header missing, 12 of 36 (owned by persistence)
shared/llm.ts                                             2 of 10
shared/llm/credentialBinding.ts                           header missing, 2 of 4
shared/llm/credentialSlots.ts                             header missing, 1 of 3
shared/llm/modelSlots.ts                                  2 of 3
shared/llm/models.ts                                      header missing, 3 of 4
shared/llm/thinkingResolver.ts                            header missing, 1 of 2
shared/llm/types.ts                                       0 of 7
shared/prompt/chatTokens.ts                               header missing
shared/prompt/imageTokens.ts
shared/tokenizerChoice.ts                                 header missing, 6 of 9
src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte
src/lib/Setting/Pages/ApiKeysSettings.svelte
src/lib/Setting/Pages/Model/ModelProfileEditor.svelte
src/lib/Setting/Pages/Model/ProfileSlotSelect.svelte
src/lib/Setting/Pages/ModelProfilesSettings.svelte        (owned by settings-i18n)
src/lib/UI/GUI/CredentialSelect.svelte
src/lib/UI/ModelGrid.svelte
src/lib/UI/ModelList.svelte
src/lib/UI/NanoGPTDashboard.svelte
src/lib/UI/NanoGPTProviderPicker.svelte
src/lib/UI/OpenrouterProviderList.svelte
src/ts/model/credentials.ts                               4 of 6
src/ts/model/modellist.ts                                 header missing
src/ts/model/nanogpt.ts                                   0 of 11
src/ts/model/ollama.ts                                    1 of 3
src/ts/model/openrouter.ts                                1 of 5
src/ts/process/request/request.ts                         header missing, 5 of 9
src/ts/process/request/shared.ts                          header missing, 2 of 6
src/ts/process/request/transport.ts                       header missing
src/ts/process/stringlize.ts                              (Slice 2)
src/ts/storage/settingsViews.svelte.ts                    40 of 50 (owned by persistence)
src/ts/tokenCountField.ts
src/ts/tokenizer.ts                                       11 of 15
```

- The provider adapters (`anthropic.ts`, `google.ts`, `openAI/requests.ts`, `nai.ts`, `openrouter.ts`) each get a
  header naming the request shape they build, the stream parser's snapshot contract (the guide's `Flows` keeps the
  cross-adapter rule), and the error mapping through `server/src/llm/messages.ts`. `server/src/llm/request.ts`'s
  dispatch by `LLMFormat` goes on `requestChatDataMain`, not into a 40-line header.
- Done when: as Slice 1, for llm-requests, with the persistence-owned deferrals named in the message.

### Slice 5: persistence (D1–D7, D9, D10; Q1; needs 3 and 4 landed; runs alone)

29 named source paths, 12 without a header, 439 of 553 exports documented. Owned elsewhere: `shared/jobs.ts`
(server-generation, which does not join under Q1, so written here), `shared/translatorPresets.ts`
(translation), `src/ts/storage/pluginStorageStore.svelte.ts` (plugin-sandbox). This slice also takes the two files
Slice 4 deferred, `shared/database.ts` and `src/ts/storage/settingsViews.svelte.ts`, and `src/ts/storage/characterOrder.ts`
from Slice 3, since persistence owns them.

```text
shared/characters.ts
shared/chatBinding.ts                         5 of 12
shared/chatCheckpoints.ts                     header missing, 7 of 18
shared/chatLoadPages.ts                       header missing, 1 of 6
shared/chats.ts                               18 of 20
shared/ids.ts                                 header missing
shared/jobs.ts                                66 of 92 (owned by server-generation)
shared/mutationValidation.ts
shared/personas.ts                            header missing
shared/presets.ts                             27 of 33
shared/recordPatch.ts
shared/resources.ts                           header missing, 50 of 60
shared/sections.ts                            15 of 21
shared/togglePresets.ts
shared/translatorPresets.ts                   header missing, 9 of 11 (owned by translation)
src/ts/chatLoadPages.ts                       header missing
src/ts/storage/characterStore.svelte.ts       16 of 18
src/ts/storage/collectionStore.svelte.ts      32 of 34
src/ts/storage/database.svelte.ts             header missing, 1 of 4
src/ts/storage/exportAsDataset.ts             header missing
src/ts/storage/llmSecrets.svelte.ts           header missing, 11 of 16
src/ts/storage/mutationValidation.ts          header missing
src/ts/storage/pluginStorageStore.svelte.ts   19 of 30 (owned by plugin-sandbox)
src/ts/storage/presets.svelte.ts
src/ts/storage/records.svelte.ts              47 of 48
src/ts/storage/selection.svelte.ts            header missing, 10 of 15
src/ts/storage/serverAuth.ts
src/ts/storage/settingsViews.svelte.ts        40 of 50
src/ts/storage/snapshots.svelte.ts
```

- `src/ts/storage/database.svelte.ts` is the legacy snapshot's module and the heaviest header here; `shared/jobs.ts`
  (92 exports, 26 undocumented) is the largest export list in the plan and is written here (Q1).
- Done when: as Slice 1, for persistence.

### Slice 6: server-generation (not run: Q1 answered no on 2026-11-08; the path list stays for a later plan)

23 named source paths, 14 without a header, 213 of 265 exports documented. Owned elsewhere: `server/src/llm/requests.ts`,
`server/src/routes/llm.ts`, and `shared/llm/request.ts` (llm-requests, done by Slice 4), `server/src/data/vectorCache.ts`
(memory), `server/src/translation/runner.ts` (translation).

```text
server/src/data/generationReceipts.ts
server/src/data/vectorCache.ts                4 of 6 (owned by memory)
server/src/jobs/channel.ts                    8 of 9
server/src/jobs/commandRunner.ts
server/src/jobs/generationJobs.ts             header missing
server/src/jobs/runSetup.ts
server/src/llm/requests.ts                    header missing, 10 of 15 (Slice 4)
server/src/prompt/assemble.ts                 5 of 7
server/src/prompt/displayKinds.ts             header missing
server/src/prompt/displayScope.ts             header missing
server/src/prompt/runner.ts                   header missing, 11 of 12
server/src/prompt/transform.ts                header missing, 4 of 5
server/src/prompt/transformCache.ts           header missing, 1 of 3
server/src/routes/generations.ts              header missing
server/src/routes/llm.ts                      header missing (Slice 4)
server/src/routes/memoryTasks.ts              header missing
server/src/routes/tokens.ts                   header missing
server/src/routes/transform.ts                header missing
server/src/routes/translate.ts                header missing
server/src/translation/runner.ts              (owned by translation)
shared/jobs.ts                                66 of 92
shared/llm/request.ts                         header missing, 8 of 20 (Slice 4)
shared/transform.ts
```

- `shared/jobs.ts` is also persistence's named path (`ownership.json` gives it to server-generation, with
  network-jobs for the tab channel part): this slice writes it under D5.
- Done when: as Slice 1, for server-generation.

### Slice 7: the combined check and the archive entry (D6, D7, D10; needs Slices 1–5 landed)

- On the combined tree: the recipe for every guide in scope, `pnpm docs:ledger --stale` for them, `pnpm check:docs
--report` (the `stale` column), `pnpm check`, and the full `pnpm --silent test:agent` gate, once.
- The found-issues entries this run saved are in [found issues](../research/found-issues.md) (the plan-runner moves
  them); the sweep session of D7 and Q3 is proposed to the owner, not run here.
- The plan moves to the archive with the before and after table from **Current state**, per guide, and the count of
  found-issues entries.
- Done when: every guide in scope passes its **Done when**, the gate is green, and the archive entry is committed.

## Recommended order

Pair A: Slices 1 and 2 at once. Pair B: Slices 3 and 4 at once, after both of A landed. Slice 5 alone, after B.
Slice 7 last; Slice 6 does not run (Q1). Within a pair, the second to land rebases onto the first and re-runs
`pnpm check:docs` on the combined tree.

## Verification

- Every slice: `pnpm docs:contracts` over the guide's named paths prints no `module header: none` and `documented M
of M` for every owned path; `pnpm docs:ledger <guide>` empty; `pnpm docs:ledger --stale <guide>` not above the
  before count; `pnpm check`, `pnpm check:docs`, and `pnpm format:check` green; the commit message carries the trim
  ledger by old section and D10's lines; the diff touches only the named source files (comments), the slice's own
  guide, and nothing under `src/`, `server/`, or `shared/` that changes behavior (a reviewer reads the diff with
  `git diff --ignore-all-space -- ':!docs'` and finds only comment hunks).
- Every slice: one lookup trial, as Guides To Source ran: a fresh agent answers one question from the guide's domain
  through the protocol (STRUCTURE.md, `pnpm docs:read`, the `Files` pointer, the header), its path recorded in the
  commit message; a miss becomes a routing line in the guide in that commit.
- The whole plan (Slice 7): the table under **Current state** re-measured for every guide in scope, every header
  column equal to the path count; the full test gate once; `pnpm check:docs --report` shows no stale rise for the
  guides in scope.

## Out of scope

- Moving `Flows` subsections into source, or deleting any; any whole-tree or every-guide pass; any byte target, byte
  check, or tree ratchet; trimming a guide a slice does not own.
- Fixing a defect a slice finds (D4, D7); renaming, moving, or re-exporting anything; changing a signature to make
  a comment simpler.
- Paths a guide names only under `Flows`, `Tests`, `State`, or `Known Hazards`; test files; `server/tsconfig.json`
  and other configuration.
- New rules in `pnpm check:docs` or new scripts (see **Later**).

## Later

- A `missing-header` rule in `pnpm check:docs`: every source path a `Files` section names has a module header,
  enabled per guide once that guide reaches coverage, so a new entry cannot regress it.
- The two items the archived plan left: an identifier check (a backticked identifier in a `Files` entry exists in
  the path the entry names) and a `Files` generator from the owned modules' exports.
- The same measure over the remaining guides, ordered by reads and churn from a fresh `pnpm docs:reads`, when the
  owner wants another round; the `Current state` recipe is the ranking tool.
