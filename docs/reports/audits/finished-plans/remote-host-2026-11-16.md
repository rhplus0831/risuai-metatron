# Remote Host post-audit — 2026-11-16

What was reviewed: the finished Remote Host feature on `dev` at `56c612168`, after the plan was retired
(`git show baba43d2e:docs/plan/remote-host.md`; slices `70069d83d`, `34c397120`, `388db8c4e`, `67eff665d`,
`e48176226`, `36286b681`, `31afc0e85`). The owner asked for it because the plan changes several contracts between
the server and the tabs at once.

The plan's text had been audited before its run ([report](../plan-runner/remote-host-2026-11-15.md)) and each slice was
challenged before it landed. Two things had not been done: nobody had read the finished result by contract (each
challenge saw one slice, and slices 3, 4, 6, and 7 each extended the command contract after the relay was reviewed),
and the pre-run audit's last corrections (S1 to S5, about Stop and the returned reports) were applied without a
further reading.

The briefs, the five reports, and the probe tests are kept outside the repository, under the review material folder
of 2026-11-16.

## Method

1. The code was cut by contract boundary, not by slice, one read-only GPT-6-Astra session (`xhigh`) per cut, each in
   its own detached worktree:
   - **R, the relay's contract.** A table of every state a command can be in by every message that can reach the
     registry, and a route boundary review of the five routes.
   - **L, a send's lifecycle across the three parties.** A timeline of one press of Send (ten points, from the
     sender's preflight to its chat read) by eight faults (a host reload, a feed that closes and reopens on either
     side, a lost HTTP answer, a server restart, a second press), with five rules every cell must keep: one
     generation per press, no fallback while a host run may exist, no definite refusal while a create may still run,
     every send ends, the user's text is never lost.
   - **S, Stop and the returned reports.** Stop at each moment by the relay cancel's answer and the generation
     cancel's answer, and every place a send shows something, for a local send, a host's run, and the sender. The
     plan's own text was under review here.
   - **C, the existing contracts the plan edited, host mode, and the remote reload.** Every hunk of an existing
     file: is the behavior of a tab with the feature off what it was at `952c4baec`?
2. Each report had to fill its table completely, cover a list of points with what was read and what was run, break
   five guarded product lines to see whether their tests fail, and give a probe test with its command and output for
   every P1 or P2.
3. The orchestrating session reran every P1 and P2 probe and read the cited code.
4. One further Astra session, which had not seen the verifiers' reasoning, tried to refute the six P1 and P2
   findings: whether an ordinary user reaches the trigger, whether the behavior was there before the feature, the
   consequence, and the cheapest fix.

## Result

| Cut    | Time   | Tokens | Filed                              |
| ------ | ------ | ------ | ---------------------------------- |
| R      | 29 min | 6.5 M  | 3 P2                               |
| L      | 21 min | 7.5 M  | 1 P1, 1 P2                         |
| S      | 22 min | 11.1 M | 1 P3                               |
| C      | 27 min | 11.2 M | 1 P2, 1 P3                         |
| Refute | 16 min | 4.7 M  | 5 kept (1 lowered), 1 pre-existing |

About 41 M tokens in all. The four verifiers ran at the same time.

Every probe behaved as its report says. The priorities below are the refuter's, then the orchestrating session's
where it differs, with the reason.

- **L-2 (filed P1; refuter P1; session P2).** `registryRefusal` (`src/ts/network/generationJobs.ts`) takes a `409`
  with `stale` or `chatBindingMismatch` as proof that an earlier uncertain create was not admitted. That held while
  one tab was the only creator of a request id. A remote command's host is a second creator: it runs its own
  preflight later and can create under the old id. A send that ended uncertain, retried locally with remote sending
  turned off, and refused as stale, drops its request id; the next Send gets a new one, and the host's later create
  appends a second reply. The session rates it P2 for the chain it needs (an uncertain end, remote sending turned
  off, a chat write inside the create's round trip or a binding change during the preflight, a third press, a host
  still delayed).
- **R-1 (P2; session P3).** The relay's `report` accepts a `running` report after an `uncertain` one of the same
  attempt, erases the result with its reports, and restarts the 40-minute drop. The host abandons a report after its
  deadline and sends the next; the abandoned request has to reach the server after the later one, which needs
  something in front of the server that keeps forwarding it.
- **R-2 (P2, narrowed; session P3).** The registry caps open commands per target and each body, and has no total. A
  closed command keeps its result (up to the body cap) for ten minutes, and a socket can register under a new client
  id for another sixteen open commands. Only an authenticated caller reaches it, the same caller can already fill
  the disk through routes that existed before, and a plugin's sandbox cannot make these requests.
- **C-1 (P2, narrowed; session P3).** The alert layer is above the host lock screen by the plan's own text, and
  every queued dialog can be dismissed. What is left: a `wait` or `progress` overlay has no button and covers "Leave
  host mode", and host mode skips the Escape that replaces a progress overlay with a toast.
- **R-3 (filed P2; P3).** `speakerChaId` is part of the relay's command identity and not of the generation's
  `requestFingerprint`. No caller that ships posts one id with two speakers.
- **L-1 (filed P2; pre-existing).** The send preflight awaits `flushResources` without a bound, so a resource write
  whose answer never arrives holds the send, its reservation, and Stop. `runServerJob` had the same wait at
  `952c4baec`; the feature added a caller, not the wait.
- **S-1 (P3).** A report's text shortened to fit the body cap can be cut inside a surrogate pair.
- **C-2 (P3).** The remote send help text still says only Send and Send Draft go to the host; Continue and the
  in-place reroll do too since slice 7.

What came back clean:

- Stop and the returned reports, the part whose last corrections had not been re-read, had no P1 or P2. The
  generation's cancel tombstone (72 hours) outlasts the relay's latest delivery of a stopped command (40 minutes),
  and no report is shown twice or dropped for a caller that does not ask for returned reports.
- With the feature off, every existing caller behaves as before. The moved markup of `src/App.svelte` was compared
  by syntax tree: its 32 component mounts keep their order, conditions, and attributes.
- All twenty break-tests failed as they should.

The entry already recorded from the plan's run (a host's `uncertain` report leaves the relay's `attempted` false) is
still present, and three cuts saw it; none found a second path with the same effect.

## Fixes

The owner asked for the findings to be filed and fixed the same day. The session that ran the audit made the fixes
(commits `cffaecfeb`, `5f655810c`, `99b948198`, `922e204a2`), each with a regression test that was run against its
fix reverted, and then steered the two verifiers whose cuts the fixes touch to read them again in their own threads
(R: 23 minutes, 5.3 M tokens; L: 8 minutes, 4.0 M tokens).

- Fixed: L-2, R-1, R-2, R-3, S-1, C-1, C-2, and the entry the plan's run had left (an `uncertain` report now marks
  the command attempted).
- The relay's verifier found two gaps in the first fix, both fixed before it was committed: a reload recovery's
  result-less `uncertain` still erased a stored result, and a result could exceed the reserved size because JSON
  numbers grow when parsed (`1e20`), which put the retained bytes above the new bound.
- It also showed that the relay's identity still differs from the generation's for field combinations no caller
  sends. That is recorded in [found issues](../../../backlog/found-issues.md#remote-commands), with L-1.
- The lifecycle's verifier found nothing new: its probe of the dropped request id fails where it should, and the
  next Send ends with one generation whether the host never created, is running, or has ended.
- The leave control above the alert layer was not looked at in a browser; it is in
  [manual checks](../../../backlog/manual-checks.md).

## Notes for the next audit of this kind

- Cutting by contract boundary found what the pre-run audit and seven slice challenges had not: both real findings
  (L-2 and R-1) sit where one party's rule meets another party's. L-2 is a rule of the generation client that the
  plan never edited and that stopped being true once a second creator existed. A cut by slice reads only what a
  slice changed.
- The table-first brief (fill every cell, then the points) gave full coverage in all four reports. No verifier
  stopped early.
- The verifiers rated by consequence and the refuter kept most ratings. Asking the refuter for "each step that needs
  a coincidence and how wide its window is" is what separated the findings worth fixing first from the rest.
- The manual checks of the plan stay with the owner ([manual checks](../../../backlog/manual-checks.md)): a phone
  sending through a host whose screen is off, and the lock screen over a plugin's full-screen UI.
