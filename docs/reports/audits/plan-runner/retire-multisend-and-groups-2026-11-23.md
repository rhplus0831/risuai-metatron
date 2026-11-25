# Retire `/multisend` and Group Chats Plan audit, 2026-11-23

- Plan: `docs/plan/retire-multisend-and-groups.md`
- Commit audited: `91d2122bd`. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, in place of the procedure's Sol because slices 1 and 2 change `server/`
  and `shared/` contracts; report written by the session that drafted the plan (Claude Opus 5.5), before any
  plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 11    |
| P2         | 11    |
| P3         | 7     |
| unverified | 1     |

The first turn filed A1 to A19 against the committed draft (7 P1, 5 P2, 6 P3, 1 unverified). The second turn read the
corrections, confirmed twelve, disputed seven (A1, A3, A4, A5, A9, A10, A17), and filed B1 to B11 against the
corrections themselves (4 P1, 6 P2, 1 P3). The corrections made after the second turn were not read again: the
Chat Trash plan's audits showed that each further round mostly finds faults in the sentences the previous round wrote,
so the remaining edge cases became Limitations instead of new guards.

Astra ran no test and no type check; it ran in-memory probes of the command splitter (the unquoted `/multisend` form
falling through to an ordinary send, and the proposed text-command matcher splitting `/multisend|/send hello`). The
two turns took about 34 minutes and 15.4 M tokens. `read_only_violation` was `false` after both turns.

## How each finding was closed

`fixed in plan` means the plan was corrected; `narrowed` means the plan's promise was made smaller instead of adding
enforcement; `limitation` means the case is written in the plan's Limitations section.

| ID  | Severity   | Finding                                                                                                                           | Outcome                                                                                                                             |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A1  | P1         | A no-op case still lets an unquoted `/multisend a\|\|\|b` fall through to a send                                                  | fixed in plan (D1), confirmed in part; the rest is B1                                                                               |
| A2  | P1         | Hiding the catalog trash removes Restore while trash expiry still runs                                                            | narrowed: the catalog trash keeps listing a trashed group; trash schedules unchanged; confirmed                                     |
| A3  | P1         | Translation, transforms, standalone LLM, Structured Memory edits, checkpoints, trash, resource writes bypass the create admission | narrowed: D6 guards generation create and the manual memory start; the other routes are a limitation (D7, D12); the remainder is B7 |
| A4  | P1         | Route, `changeChar`, pinned chat, remote host act on the chat before `selectCharacter`                                            | fixed in plan (D8); the boot pass is B2                                                                                             |
| A5  | P1         | The remote repair only appends; plugin and upstream orders bypass the repair                                                      | fixed in plan (D9a); the mixed-version part is B3, the upstream anchor B8                                                           |
| A6  | P1         | A filtered plugin index can replace the wrong stored character by position                                                        | fixed in plan (D11a), confirmed                                                                                                     |
| A7  | P1         | The snapshot builder, by-id reads, and the plugin pre-send append bypass the plugin view                                          | fixed in plan (D11, D11a), confirmed                                                                                                |
| A8  | P2         | Admission has no unconditional owner read                                                                                         | fixed in plan (D6), confirmed                                                                                                       |
| A9  | P2         | Structured Memory starts and background memory admissions misidentified                                                           | fixed in plan (D6); the rest is B5 and B6                                                                                           |
| A10 | P2         | Refused-data banner, recovery drafts, history, progress and remote-host rows                                                      | narrowed: labels may name a group, open actions go through D8; the Retry and export part is B7                                      |
| A11 | P2         | `risu-list-characters` lists groups                                                                                               | fixed in plan (D9), confirmed                                                                                                       |
| A12 | P2         | The receipt store rebuilds `sequence` on reopen                                                                                   | fixed in plan (D3, slice 1), confirmed                                                                                              |
| A13 | P3         | "Writes the order record once" is wrong as stated                                                                                 | fixed in plan (D9a), confirmed                                                                                                      |
| A14 | P3         | Stored selection and search scope picker described wrongly                                                                        | fixed in plan (D8, D9, slice 3), confirmed                                                                                          |
| A15 | P3         | Locale key misnamed; the live event feeds a statistic                                                                             | fixed in plan (D4), confirmed                                                                                                       |
| A16 | P3         | An attempted sequence invokes the checkpoint policy, not one checkpoint                                                           | fixed in plan (Current State, D3), confirmed                                                                                        |
| A17 | P3         | Slices 1 and 3 share locale files; 1 and 2 share tests                                                                            | fixed in plan (slice order); the rest is B11                                                                                        |
| A18 | P3         | Existing tests fail for reasons outside the named cases                                                                           | fixed in plan (slices 1 to 3), confirmed                                                                                            |
| A19 | unverified | Provenance of the 2026-11-23 reproduction                                                                                         | fixed in plan (Current State), confirmed against the external review report                                                         |
| B1  | P1         | The text-command matcher needs whitespace after the name; CBS runs before the case                                                | fixed in plan (D1: exact token before argument evaluation, `\|` as a boundary; slice 1 tests), not read again                       |
| B2  | P1         | Boot and collection reconcile run `ensureChat` on every owner                                                                     | limitation: an archived group without a chat gets an empty `Chat 1`, as any owner does today                                        |
| B3  | P1         | Old and new tabs can keep undoing each other's order; an early order keeps an unknown id                                          | fixed in plan (D9a: the remote repair stops appending groups but removes nothing) and limitation for the leftover id                |
| B4  | P1         | `groupArchived` as a definite refusal can drop an earlier create's uncertainty                                                    | fixed in plan (D6: the existing `chatTrashed` refusal path); the same-id type change is a limitation                                |
| B5  | P2         | The manual-memory client does not decode `groupArchived`                                                                          | fixed in plan (D6, slice 3)                                                                                                         |
| B6  | P2         | Hand-off and warming can follow a send admitted before a same-id type change                                                      | limitation: a record's `type` changes only through a raw resource write                                                             |
| B7  | P2         | Pinned health scan, resumed jobs, handoffs, push refreshes, banner Retry still name a group chat                                  | fixed in plan for the pinned health scan (D8); limitation for work from before the upgrade and the banner's Retry and export        |
| B8  | P2         | The upstream order converter has no owner types                                                                                   | fixed in plan (D7, D9a, slice 2: `importDatabase.ts` passes non-group ids)                                                          |
| B9  | P2         | Plugin `characterOrder` read and bulk chat preparation still reach hidden groups                                                  | fixed in plan (D9a, D11a, slice 4)                                                                                                  |
| B10 | P2         | "Dormant" covered the archive checks and the trash management                                                                     | fixed in plan (D12)                                                                                                                 |
| B11 | P3         | Unnamed shared files and a misplaced validator anchor                                                                             | fixed in plan (slice order, D4, slice 2)                                                                                            |

The limitations chosen for A3, B2, B3, B4, B6, and B7 followed the owner's goal (less code for a feature nobody uses);
the owner confirmed all of them the same day, recorded as the plan's Q8.

Re-check list: no planned edit touches the four mechanisms. `patchMessage` closes the fence in the existing-row path
(`server/src/data/chatStore.ts:2669`); `chatFeedChange` sizes the three forms against `MAX_FEED_PATCH_BYTES` (64 KiB)
and falls back to the id manifest (`server/src/data/chatStore.ts:1988` to `:2119`); `STORE_TABLES_SQL` runs under
`user_version === 0` and on a fresh restore staging database (`server/src/data/resourceStore.ts:788`, `:4017`); and
`sendText` delivery accounting is unchanged, slice 1 only removes one event sent through it
(`server/src/jobs/generationJobs.ts:1057` to `:1079`).
