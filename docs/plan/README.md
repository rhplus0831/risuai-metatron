# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups.

- [Storage Settings Page](storage-settings-page.md): move Settings → Advanced → Storage to its own page in the
  Data group and rework it: a disk bar with the space used outside RisuAI, cleanup rows with kind filters, image
  previews and no default selection, one-line snapshot rows, collapsed owners and totals, and a Backups link in place
  of "Load internal backup". Previews go through a new lease-free `GET /api/assets/preview/*`. Five slices: the page
  and its controller (A), overview/details/owners (B), the cleanup list (C), snapshot rows and the Backups link (D),
  the preview route (E). Every design decision answered by the owner 2026-11-07.
  Landed: A, D, E.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
