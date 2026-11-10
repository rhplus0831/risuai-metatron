# Chat Scan Observations

Moved verbatim from `docs/structure/persistence.md` (`Known Hazards`) at commit `87e20a26d`; the first passage was added by `9d09288b0` (2026-10-07), the second by `4bea9f9db` (2026-10-24).

- A character wrapper's read-only `chats` view builds a fresh array of the loaded chats on every read; read one chat
  through `findChat`, not by scanning `chats` in a loop (a test helper doing that over 1,000 chats timed out).
- The server's `chats` table has only `UNIQUE (characterId, id)`. A per-character newest-first walk
  (`WHERE characterId = ? AND seq < ? ORDER BY seq DESC LIMIT 1`) picks that index and sorts a temporary B-tree on every
  call, quadratic over a character's chats (about 3 s for 5,000 chats). Write `+characterId` so SQLite walks the rowid
  instead, as `searchNextCharacterChat` in `server/src/data/chatStore.ts` does. A `(characterId, seq)` index would be an
  `IF NOT EXISTS` addition (the snapshot layout check reads `PRAGMA table_info` only); add it only when several readers
  need it.
