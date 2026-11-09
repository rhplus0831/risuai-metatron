# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

## Contents

- [assets](#assets) (1)
- [backup-sync-hub](#backup-sync-hub) (1)
- [diagnostics](#diagnostics) (1)
- [memory](#memory) (1)
- [persistence](#persistence) (1)
- [plugin-sandbox](#plugin-sandbox) (2)
- [resource-sync](#resource-sync) (1)
- [self-host-server](#self-host-server) (3)
- [server-resources](#server-resources) (1)

## assets

Guide: [Assets: Sources, Client, Queues, Batch Codec](../structure/assets.md#known-hazards).

- Direct URLs already handed out are not re-rendered when the page loses its controller or capability. Without a signing
  worker they load from the browser HTTP cache or fail with 401; only new source calls use the fallback.

## backup-sync-hub

Guide: [Backups, Realm Hub](../structure/backup-sync-hub.md#known-hazards).

- The RisuRealm terms gate is client-side only: `GET /hub-proxy/*` (unauthenticated) and `POST /api/import/realm` do not
  check `ui.realmTermsAccepted`.

## diagnostics

Guide: [Request History and Diagnostics](../structure/diagnostics.md#known-hazards).

- Daily event appends are unsynced, so a power loss can lose recent events; whole-file state, report, and share writes
  flush their staged files before rename.

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- The custom embedding URL is fetched directly by the server with no local-target restriction.

## persistence

Guide: [Persistence: Database, Records, Mutation Stores](../structure/persistence.md#known-hazards).

- A character trashed or deleted on the server after the remote repair's read and before its write, with no order change
  between, can be appended. Its id leaves only once this tab holds the trash or deletion and a later `checkCharOrder`
  runs (arrival alone does not run the repair).

## plugin-sandbox

Guide: [Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions](../structure/plugin-sandbox.md#known-hazards).

- Consented capabilities reach further than their names suggest (never reviewed): `mainDom` lets a plugin listen on
  `document` through `getRootDocument` and forwards keys (except from the terminal notice's opening until reload), so a
  plugin could observe typing in the password or credential prompts; `mainDom` also allows document-wide queries and
  mutation; `nativeFetch` lets a plugin choose its headers; the RPC dispatcher in `factory.ts` looks callables up
  without an allowlist.
- A plugin event listener lives until the wrapper that registered it removes it by id or plugins reload: removing
  its element from the page keeps it (and the element).

## resource-sync

Guide: [Resource Sync: Boot, Save Adapter, Conflicts, Transport](../structure/resource-sync.md#known-hazards).

- A save's echo arriving before its acknowledgement schedules a cycle 50 ms later (`noteRemoteChanges`), so continuous
  typing can save more often than the debounce. [Measurements](../audit/projection-bindings-2026-10-04.md) no longer
  show extra saves; coalescing would bound the 50 ms echo cycle.

## self-host-server

Guide: [Self-Host Server (Hono on Node), Docker](../structure/self-host-server.md#known-hazards).

- `/api/asset/*` verification is in memory and stat-based; it starts empty after restart and cannot detect an outside
  same-size edit that restores the full stat.
- JWT validation does not check issuer, audience, `typ`, or `iat`, and a token without `exp` does not expire.
- `/hub-proxy` is unauthenticated (its forwarded request headers are an allowlist since 2026-11-10).

## server-resources

Guide: [Server resources](../structure/server-resources.md#known-hazards).

- `normalizeCharacterOrder` validates only a folder's `data` members (non-strings are dropped) and keeps a folder whose
  `id`, `name`, or `color` is missing or malformed, since older saves hold such folders; the boot repair tolerates them.
