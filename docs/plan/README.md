# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Module Headers](module-headers.md): module headers and export doc comments for the source the hot, thin guides
  name, measured as coverage, not bytes: for each guide in scope every path its `Files` section names gets a `/** */`
  module header and its owned exports get doc comments, written from the code before the guide is read, with a guide
  claim the code contradicts fixed in the guide or recorded in found issues and never copied into a header; the
  `Files` entry shrinks to path, role, and identifiers only as a by-product. One slice per guide: self-host-server,
  chat-pipeline, global-api, llm-requests, persistence (server-generation stays out, Q1), run as pairs that share no
  file, `pnpm check` and `pnpm check:docs` per slice and the full test gate once at the end. Drafted 2026-11-08,
  D1–D10 recommended, Q1–Q4 open. Landed: none.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
