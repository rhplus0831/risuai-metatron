# Slice: Server Snapshots And Archives

Status: done on 2026-09-29 (review round 1).

Phase: [Phase 1](../../phase-1-per-collection-resources.md), plan sections A6-A8.

## Scope

Allowed files: `server/src/data/{snapshots,archive,resourceStore}.ts`,
`server/src/routes/{backups,storage}.ts`, `server/src/app.ts`, `server/src/main.ts`.

## Decisions

- `node:sqlite` `backup()` into a hidden temp file, switched to rollback-journal mode, published by
  rename; 20 kept; a tick only after committed writes.
- One promise-chain lock for snapshots, export copies, restores, and imports; `withMaintenance`
  closes resource and storage mutations (503) and waits for admitted storage writes.
- Restore: validate the source completely (real tables and columns, every row through the kind
  registry), safety snapshot, epoch check, one transaction, new epoch.
- Archive v2 keeps the old u32 framing and adds `manifest.json` first; the export snapshots before
  listing assets; the import validates the whole archive before any write, adds only missing assets
  (hard link, never overwrite), and refuses Risu Account and pre-v2 archives.
- Shutdown: `dispose` waits for admitted backup operations; `main.ts` gives them 30 s.

## Validation

As in the phase file. Astra's first challenge found six bugs (fixed by Opus: storage-route
maintenance, shutdown tracking, export order, export staging leak, stuck import flag, silently
skipped assets). Its second challenge and the remaining first-round points were edge cases; Fable
fixed them with tests (lazy admission, export finalizer, storage drain, shutdown response, manifest
duplicates, lookalike databases, epoch recheck before asset writes, inlay asset keys, archive
index caps).

## Residual risk

Restore and import block the serving thread while they validate and install a large database.
