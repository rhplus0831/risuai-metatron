# Archived Plans and Migration History

Completed plans are removed from `docs/plan/`; their last versions remain in the
commit trees below. Current guides describe shipped behavior. Historical decision
labels (O1–O9, R/H items, numbered binding decisions, translation slices) refer to
these archived designs, not to live files in the working tree.

Documentation audit: 2026-10-17. Archiving an implemented design does not certify
its pending manual checks. [Active work](../plan/README.md) remains separate.

## Retrieve a Historical Plan

Use the commit and original path together, for example:

```sh
git show 317a97ce:docs/plan/model-profiles.md
git show df25006f:docs/plan/translation.md
git show e148f7276:docs/plan/web-push.md
git show ab11ea9d0:docs/plan/request-history-diagnostics.md
git show 154711858:docs/plan/chat-toggles-and-presets.md
git ls-tree -r --name-only 9d09288b -- docs/plan/PLAN.md docs/plan/phases/
```

For another entry, substitute its commit/path. A historical reference such as
`docs/plan/chat-binding.md` is retrievable with `git show 809b35cc:docs/plan/chat-binding.md`;
it is not a current architecture guide.

## Completed Plans

| Design                              | Last tree / original paths                                                | Current owner                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-owned data, Phases 0–6       | `9d09288b`: `docs/plan/PLAN.md`, `docs/plan/phases/`                      | [persistence](../structure/persistence.md), [server](../structure/self-host-server.md)                                                          |
| Split Preset and Chat Binding       | `809b35cc`: `docs/plan/split-preset.md`, `docs/plan/chat-binding.md`      | [persistence](../structure/persistence.md), [settings](../structure/settings-i18n.md)                                                           |
| Shared API Keys and Model Profiles  | `317a97ce`: `docs/plan/shared-api-keys.md`, `docs/plan/model-profiles.md` | [LLM requests](../structure/llm-requests.md)                                                                                                    |
| Translation and URL Routes          | `df25006f`: `docs/plan/translation.md`, `docs/plan/url-routes.md`         | [media/translation](../structure/media-aux.md), [app shell/routes](../structure/app-shell.md)                                                   |
| Web Push                            | `e148f7276`: `docs/plan/web-push.md`                                      | [browser notifications](../structure/global-api.md), [worker](../structure/build-test-platforms.md), [server](../structure/self-host-server.md) |
| Request History and Diagnostics     | `ab11ea9d0`: `docs/plan/request-history-diagnostics.md`                   | [diagnostics](../structure/diagnostics.md), [LLM capture](../structure/llm-requests.md)                                                         |
| Per-Chat Toggles and Toggle Presets | `154711858`: `docs/plan/chat-toggles-and-presets.md`                      | [persistence](../structure/persistence.md), [UI/theming](../structure/ui-theming.md), [CBS/rendering](../structure/cbs-rendering.md)            |

The archived Web Push file still says “planned”; the implementation shipped in
`e148f7276`. Its historical status text must not be used as the current feature state.
Request History and Diagnostics records both implementation phases as done.

## Server-Owned Data Chronology

These boundaries matter to old saves, archives, and fixtures. This chronology was
moved from `STRUCTURE.md`; the compact router links here instead.

| Step    | Change                                                                                                    | Last commit |
| ------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| Phase 0 | Shared schema and server resource store                                                                   | `a82359f7`  |
| Phase 1 | Per-collection resources; block save and remote saving removed without migration                          | `46d63674`  |
| Phase 2 | Server chat records, explicit mutation API, generation fence                                              | `577c43ae`  |
| Phase 3 | Settings sections/collections (store version 3), no root record, preset/persona ids, separate credentials | `e9e608ad`  |
| Phase 4 | External contracts write through mutation modules                                                         | `ce43f2b9`  |
| Phase 5 | Server generation, prompts, scripts, providers; `12ed3bae` cutover removed browser generation             | `ee57e2e9`  |
| Phase 6 | Thin client, write-through records, live updates, lazy chats, no whole-database object                    | `9d09288b`  |

## Remaining Follow-Ups

These are retained design/verification debt, not unimplemented versions of the
features above. Confirm current code and the owner's Known Hazards before acting.

- Model profiles: named keys for remaining `/proxy2` auxiliary operations and
  `getFreeOpenRouterModels`; a distinct `submodel` slot (O3); global provider toggles
  moving to profiles (O7: `openrouterMiddleOut`, `openrouterFallback`, caching,
  `autofillRequestUrl`, `reverseProxyOobaMode`, `vertexRegion`).
- Translation: optional phase 4 (greeting translation and bilingual partial edit),
  plus manual bilingual-display verification.
- URL routes: manual checks on desktop Chrome, Android Chrome/PWA, and iOS Safari,
  including H1 and its fallback if those checks fail.
- Web Push: real browser permission/subscription/reload behavior, hidden/closed and
  visible-tab completion without duplicates, notification click routing, Firefox,
  Android PWA over HTTPS, available iOS Home Screen app, insecure-LAN fallback,
  and service-worker update behavior. These were not run by this documentation audit.
- Request history/diagnostics: full viewer/error-alert workflow across request
  sources, content-off rows while earlier content stays, restore leaving history
  unchanged, and production Docker+sftp isolation. Verify the restricted account
  can read `state.json`, `events/`, `reports/`, and `shared/` but cannot read
  `save/data/`; pull a job share, withdraw it, and save/pull a phone browser report.
  The application does not configure the sftp account or chroot.
- Per-chat toggles/presets: drop the read-only legacy `globalChatVariables`
  collection with a one-time seed of each chat's map after a release has passed;
  decide an explicit default in the toggle grammar (a cross-user `.risup` format
  change); similarity sorting and partial apply; `.risutoggle` export/import;
  plugin, MCP, and chat-command exposure of presets; writing toggle values from
  CBS, Lua, or triggers.
- Toggle preset persistence/cache: `togglePresets` saves as a whole record, so two
  tabs saving at once can drop one tab's new preset while its chat link lands as
  "deleted". Every collection, including this one, enters the job scope and
  render-cache key, so saving a preset invalidates cached renders. An exclusion
  list in `server/src/jobs/jobScope.ts` would avoid that unnecessary invalidation.
- Per-chat toggle verification: browser checks still to record for isolation
  across two chats of one character, New Chat under both inherit/empty policies,
  and prompt info showing the chat's values. Record the dedicated
  `e2e/0-idleReload.spec.ts` result too; the slice 4 smoke already checked idle
  reload, preset workflows, reload persistence, preview controls, and mobile
  width. Archiving does not certify these remaining checks.
- Consolidated browser/production verification debt remains tracked in the active
  [audit/performance plan](../plan/audit-findings-perf.md), especially Phase 5.

## Archive Procedure

Remove a completed/retired plan and its active-list link, then add its last existing
commit/path, current guide ownership, and unresolved follow-ups here. Verify with
`git show <commit>:<path>` before deleting it. Keep operational contracts in current
guides rather than asking readers to load a historical plan.
