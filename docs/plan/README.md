# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

Active planning and implementation:

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
  icons for lists and chat avatars; planned, 5 slices. Overlaps Direct Asset URLs on
  `risuCache` and the asset route: choose which runs first before either's client slice.
- [Server Tokenizer](server-tokenizer.md): the tab counts tokens through a server route and
  drops its own tokenizer copy and `public/token/` payloads; planned, 4 slices.
- [Upstream Integration](upstream-integration.md): an intake ledger for upstream Risuai
  changes and a seeded backlog (current `.bin` block saves, plugin boundaries, lore flags,
  HypaV3 vectors, Gemini roles); planned, not in the slice format.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
