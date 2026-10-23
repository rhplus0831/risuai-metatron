# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

- [Combined Run](combined-run.md): an index over the eight plans below for one `plan-runner`
  run, so their slices are scheduled as one pool (77 slices, ids prefixed per plan, cross-plan
  shared files, one added slice ST0); 47 of 77 slices landed. The plans below keep their
  design and slice text; their `Status:` lines are updated at retirement, not per slice.
- [Chat Checkpoints](chat-checkpoints.md): named per-chat save slots on the server
  (messages, variables, chat lore, memory) with load, safety and auto checkpoints;
  planned; slice 6's wait on the `heap-memory-reduction` merge is over.
- [Static Audit Fixes](static-audit-fixes.md): the 2026-10-23 static audit's data-loss,
  network, and resource findings (refused data at close, lost-create recovery, toggle preset
  merge, live-feed backoff, ComfyUI polling, cancellation, export worker, auth files);
  planned, 14 slices in three chains.
- [Small Fixes](small-fixes.md): independent small defects left by finished plans and the
  fork research (TLS keys, plugin RPC logs, body-limit 500s, WebLLM model, static caching,
  Korean keys); planned, 12 slices.
- [Direct Asset URLs](direct-asset-urls.md): an authenticated asset route served through the
  service worker so the browser HTTP cache holds asset bytes instead of the tab's memory;
  planned, slices 0–7, slice 0 is a browser probe.
- [Server Thumbnails](server-thumbnails.md): server-resized character, group, and persona
  icons for lists and chat avatars; planned, 5 slices. Runs after Direct Asset URLs
  (owner decision 2026-10-23) and moves onto its asset route first.
- [Server Tokenizer](server-tokenizer.md): the tab counts tokens through a server route and
  drops its own tokenizer copy and `public/token/` payloads; planned, 4 slices.
- [Generation Stage Spinner](generation-stage-spinner.md): the server reports each job's
  stage (preparing, memory, generating, finishing) and the send/stop spinner shows the
  selected chat's stage again; planned, 4 slices.
- [Upstream Integration](upstream-integration.md): ports of upstream Risuai changes up to
  `f50b5942` (current `.bin` block saves and plugin storage index, plugin boundaries, lore
  flags, HypaV3 vectors, Gemini roles, catalog, Lua features, UI fixes), an inventory of all
  79 upstream commits, and a lasting ledger at the end; planned, 23 slices in five chains.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
