# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Durable Drafts](durable-drafts.md): unsaved changes survive a lost page (an IndexedDB journal
  recovered in the same epoch), conflicts keep the local version, and saves stop waiting for
  unrelated reads (audit F02–F04). Slices 1 and 9 landed.
- [Job Protocol](job-protocol.md): a lost create answer is replayed instead of run twice, a
  command's `/multisend` runs on the server as one sequence job, an absent owner frees its chat in
  minutes, another tab or device can stop a chat's job, and a restart reads as an ended job (audit
  F15, F16, TJ06).
- [Boot Bytes](boot-bytes.md): "last chatted" comes from the chats so a send stops invalidating
  boot-cached characters, boot reads plugin permissions once, a reconnect that missed nothing skips
  the revision listing, app scripts are served compressed, and verified present assets are not
  uploaded again (audit ST02, ST03, ST06). Drafted and Astra-reviewed; no slice landed.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
