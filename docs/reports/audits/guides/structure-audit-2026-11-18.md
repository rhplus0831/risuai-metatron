# Structure guide audit, 2026-11-18

The audit covered `STRUCTURE.md`, Doc Maintenance and all 37 guides at `744d17cad`. Built-in Codex sub-agents checked
each guide against its source and tests. A second reader checked each set of changes, including where readers would find
material removed from a guide. The path audit compared the old and new ownership rules across all tracked files. The
previous full audit read `e44b4786b`. [Previous report](structure-audit-2026-11-10.md)

## Results

| Measure                                                 |  Before |   After |
| ------------------------------------------------------- | ------: | ------: |
| Index and guide Markdown, bytes                         | 992,595 | 941,026 |
| Repository-wide invariants, bytes including subsections |   7,923 |   7,449 |
| Files above the 36,000-byte target                      |       8 |       0 |
| Headings above the 7,000-byte target for their own text |       2 |       0 |
| Identifiers flagged by the stale scan                   |       9 |       0 |

The task index now routes OOC questions, Draft/BTW input hooks, per-chat memory, request interception, remote sends, the
headless host and completion push holds. The ownership changes affect 42 tracked paths. For example, a per-chat memory
setter leads to the memory guide, the output meter test leads to server generation, and the shared command client lists
send admission, job following and trigger dispatch separately. [Task index](../../../../STRUCTURE.md#choose-by-task) ·
[Ownership rules](../../../structure/ownership.json)

## Where to find the contracts

- **Chat and rendering.** The chat guide follows a send from the composer through admission, replay and recovery.
  `sendMain`, `processMultiCommand`, `runInputHook` and `answerQuestion` own the individual branches. The rendering
  guide distinguishes the normal sanitized result from `notrim`. Editor range handling and fuzzy asset lookup lead to
  `findAllOriginalRangesFromHtml` and `getClosestMatch`. The script guide routes Lua permissions and command effects to
  the bindings and trigger implementations. [Chat pipeline](../../../structure/chat-pipeline.md) ·
  [Rendering](../../../structure/cbs-rendering.md) · [Scripts and triggers](../../../structure/scripts-triggers.md)
- **Models and plugins.** Job and standalone tab paths now locate WebLLM and Plugin execution explicitly. Request
  interception has one section for prompt insertion, retries, token reservation and tests. Plugin startup, deferred
  reload, permission reviews and quiet waits each point to their governing export. The MCP guide distinguishes
  advertised tools from direct calls. [LLM requests](../../../structure/llm-requests.md#request-interception) ·
  [Plugins](../../../structure/plugin-sandbox.md) · [MCP](../../../structure/mcp.md)
- **Memory.** `shared/chatMemory.ts` owns the precedence of the chat choice, preset and owner default. The Structured
  Memory folder routes story dates and greeting coverage to the read guide, writer admission and repairs to the writer
  guide, and cost estimates to rebuild. Record and search field lists now lead to the shared types and route handlers.
  The saved manifest is read from reply context reports by `lastMemoryManifest`. The separate table discussed in the
  original Structured Memory design remains in its archived plan. [Memory](../../../structure/memory.md) ·
  [Structured Memory](../../../structure/structured-memory/README.md) · [Plan archive](../../../archived-plan/README.md)
- **Persistence and server data.** Pinning, editor draft lifetimes, conflict handling and journal replay each have an
  owner. Field normalization points to the shared helpers, folder merges to `recordMerge.ts`, and storage limits to the
  schema and store. The feed guide owns publication and `chatFeedChange`. Remote-command HTTP admission leads to
  `registerRemoteCommandRoutes`, while the tab's pickup and recovery lead to `remoteHost.ts`.
  [Persistence](../../../structure/persistence.md) · [Draft recovery](../../../structure/draft-recovery.md) ·
  [Server resources](../../../structure/server-resources.md) · [Network jobs](../../../structure/network-jobs.md)
- **Interface and support.** The guides now distinguish tab-selected editors from chat bindings, the flat persona picker
  from the foldered catalog, and original-message or stored-translation drafts from component-local editors. Headless
  dialog policy, standing plugin grants and the host check have a single destination. Translation, TTS, backup and
  diagnostics send readers to their concrete provider, import or report boundary.
  [Settings](../../../structure/settings-i18n.md) · [Chat UI](../../../structure/ui-theming.md) ·
  [Headless host](../../../structure/build-test-platforms.md#headless-host) · [Diagnostics](../../../structure/diagnostics.md)

## Verification

`pnpm check:docs` passed for guide outlines, links, source paths, budgets, ownership and verification records. The strict
and default fact ledgers compared the pre-edit `Files` and `Flows` identifiers with the combined tree. Both reported the
same six intentional removals across four guides.

| Previous reference                               | Current destination                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `manualChunks`, `envPrefix`, `src/**/*` in build | The guide describes Vite's defaults and the actual source inclusions in `tsconfig.json`. |
| `FromHtml` in rendering                          | The export is `findAllOriginalRangesFromHtml` in `src/ts/parser/partialEdit.ts`.         |
| `risuAccess` in server generation                | The host is `risuAccessHost` in `server/src/mcp/internal.ts`.                            |
| `contextOrPage` in the test harness              | `clearSafeBootAttempts` takes `target` in `util/playwright/stack.mjs`.                   |

The stale scan checked the resulting guide identifiers against the current source. The documentation and test-inventory
tools passed 91 focused tests across eight files. The inventory matched 667 test files, and all 37 eligible guides record
the audited source revision.
[Verification record](../../../structure/verified.json)

An incoming-link check compared Markdown section links with the pre-edit tree. The two unresolved references predate
this audit. They lead from the November 5 incremental-chat and job-handoff reports to backlog entries since retired.

## Findings outside the guides

The separate findings file records 12 follow-ups with evidence. Seven were exercised in isolation, including the HypaV2
blank-summary case narrowed from the existing inbox. Four runtime risks were identified by source review, and one test
header still describes a removed UI control. [Audit findings](../../../research/found-issues.md)

Two earlier inbox entries were retired. The plugin guide is below its size target. For unknown memory event statuses,
the JSON chat restore rejected the event, Markdown import rejected the affected record, and the shared
snapshot/checkpoint row validator rejected it. A direct call to retrieval with an invalid object bypasses those checks.
[Project inbox](../../../backlog/found-issues.md)
