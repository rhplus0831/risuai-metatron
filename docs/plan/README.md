# Active Plans

Plans live here while work is in progress. Current architecture guides describe
shipped behavior; [the archive](../archived-plan/README.md) records completed plans,
historical paths/commits, retrieval commands, and pending manual follow-ups. The five feature
plans below were revised on 2026-11-04 after the
[plan design audit](../audit/plan-design-audit-2026-11-04.md); Job Handoff, Asset Lifecycle and Reroll
Candidates were then challenged again and revised a second time the same day. Plugin Storage and Data API was drafted on 2026-11-05.

- [Job Handoff](job-handoff.md): another tab of the same user (a PC marked as a worker) takes over
  the owner role of a running generation job when the creating tab goes silent, asked at creation, or
  picked by name; a takeover is a ticketed attach against an open offer whose owner switch takes effect
  only when no callback delivered to the old owner is outstanding (a callback in flight on a device that
  then sleeps is never re-delivered and settles by the owner-absent policy, which the creator is told),
  request lanes follow the owner, every socket of a job shares one chat baseline so the creator keeps
  watching the stream, notices go by kind (dialogs to the owner, display effects to every socket, device
  effects to the creator), and the creator replays skipped listeners when no owner is attached at the
  end; D1–D8 recommended, Q1–Q4 answered (Q3 superseded by the notice groups), Slice 1 landed.
- [Asset Lifecycle](asset-lifecycle.md): the server marks every stored asset from one retention graph (every
  text column of the live store, chat metadata and the memory tables included, the checkpoint pages a checkpoint
  names, every retained snapshot, exports from their copy to the end of their stream, recent uploads and a
  one-hour lease) with one recognizer over decoded string values (bounded `assets/` tails by prefix, the
  `/api/asset/` and `/sw/img/` hex forms in either case), reports disk use as logical size, deduplicated size, per-owner shares and orphan inlay records, runs
  a daily read-only scan, and deletes unreferenced assets only after a grace period (3 days minimum, 7 default),
  fail-closed, in a synchronous recheck-and-unlink turn against the mark's own write count, under a per-key
  lock that every publish path and every import's final record write shares, started by the user after a
  complete run of this server process; snapshots gain pins, labels, manual takes,
  and deletion; heavy operations get a disk preflight; D1–D14 recommended, Q1–Q3 answered (Q1's minimum
  superseded), no slice scheduled.
- [Reroll Candidates](reroll-candidates.md): the alternatives of the newest reply persist on the
  message as `candidates` with stable ids, a list revision and the selected index under a per-message size
  budget; a reroll regenerates
  that message in place as a server job (the candidate push and the per-key variable restore precede the
  `begin`, and an end without a reply writes the previous candidate back in the generation's final write
  with the attempt's own variable writes rolled back from a per-key ledger the store keeps while the
  carrier is locked, leaving another writer's values); a candidate switch is a server op that names the candidate by id
  and the list by revision, evaluated from the stored row, and moves the variables and the checkpoint's
  `after` with it while the turn's `before` is kept; the extra samples of one request
  become candidates; only the newest reply keeps the snapshots and a discarded candidate is never memory
  input; the tab takes the in-place path only when the server's `hello` advertises it; Slice 2 merges with or
  after Incremental Chat Transport Slice 4 (a traffic dependency, not a code one: separate branches are fine,
  the merge runs the listed integration checks); D1–D14 recommended, Q1–Q4 answered, no slice scheduled.
- [Render Work Budget](render-work-budget.md): a superseded or unmounted chat row's render run is aborted
  through one signal (parser, transform, translation and retry stop instead of being hidden, and the
  auto-translate probe's remembered inputs are written only once it completes), deterministic parser errors
  never retry while the reachable I/O failures (inlay and file reads, the Google fetch, the LLM cache read)
  retry twice with a delay, transform batches count subscribers and a chunk its last subscriber leaves settles
  as cancelled outside the failure path, the LLM translation join never serves a regeneration and fences its
  cache write, identical post-CBS CSS is scoped once in a bounded cache, and the screenshot export sizes its
  output once, releases each source, pages large exports and downloads a Blob; Slice 0 carries two small items
  (the message index belongs to Incremental Chat Transport); D1–D9 recommended, Q1–Q4 answered (Q3 narrowed),
  no slice scheduled.
- [Incremental Chat Transport](incremental-chat-transport.md): every by-id message lookup in the chat
  store goes through one validated per-chat position index, a feed entry past 8 KiB carries a per-row field
  diff with the text as a delta instead of the whole row, the owner's job `chatPatch` names a byte-equal
  streamed row by its stream sequence instead of carrying it, a reconnect after an away-time change replays a
  bounded epoch-scoped change log (one row per committed ref, written before `COMMIT`, the table created at
  open) against a map frozen at `hello` with the whole listing as the fallback, both sockets carry `proto=1`,
  and an over-cap change of a loaded chat reads its rows by id (Slice 4, no longer gated: Reroll Candidates
  Slice 2 merges with or after it); D1–D10 recommended, Q1–Q4 answered (Q2 and Q4 superseded), no slice scheduled.
- [Plugin Storage and Data API](plugin-storage.md): plugin data becomes visible, owned, and cheap to move: a plugin
  data page lists and deletes what every storage namespace holds and permission grants become revocable (a reset per
  plugin, revoked on removal); a `pluginStorage` write sends the changed key as a nested patch one level down and a
  plugin toggle sends that plugin by name; `pluginStorage` gets an owner (the plugin's name) in a new reserved
  dictionary with legacy read-through, claim-on-write and a per-owner `clear()`, while `safeLocalStorage` and
  `getLocalPluginStorage()` stay the documented shared channels; a `pluginCustomStorage` write keeps reserved
  dictionaries it leaves out; `getDatabase` with characters reads unloaded chats by ref in batches as detached copies
  after this tab's saves settle (never installed, pinned or evicted; hooks and doubtful characters keep the current
  path; an equality test against the old path is the acceptance check) and reuses copies whose held revision has not
  moved, `setDatabase` loads only characters whose chats changed, new plugins get a summaries option and a paged chat
  read, and a browser spec checks the sandbox; drafted 2026-11-05, D1–D12 recommended, Q1–Q5 answered, no
  slice scheduled.

When a plan is completed or retired, remove its file and active link and record it
in the archive. Use `None` here when no plans remain active.
