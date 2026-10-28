# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Boot Bytes](boot-bytes.md): "last chatted" comes from the chats so a send stops invalidating
  boot-cached characters, boot reads plugin permissions once, a reconnect that missed nothing skips
  the revision listing, app scripts are served compressed, and verified present assets are not
  uploaded again (audit ST02, ST03, ST06). Drafted and Astra-reviewed; landed: 1, 2, 4, 6.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
