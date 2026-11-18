# Plan post-verification — 2026-11-18

What was reviewed: the seven plans retired between 2026-11-15 and 2026-11-18, each read as a finished whole against
`dev` at `504a7af45`, where the whole suite (11 528 tests) and `pnpm check` passed before the run. The owner asked
for it after a list of retired plans showed these seven had never been read after their runs.

| ID  | Plan                                      | Last text                                                       |
| --- | ----------------------------------------- | --------------------------------------------------------------- |
| IH  | Input Hooks                               | `git show 00e88ceba:docs/plan/input-hooks.md`                   |
| HH  | Headless Host                             | `git show f545e0fb8:docs/plan/headless-host.md`                 |
| CN  | Completion Notification After Plugin Work | `git show 41d8239df:docs/plan/completion-after-plugins.md`      |
| SB  | Sidebar-Only Chat Binding                 | `git show a8f624aff:docs/plan/sidebar-only-binding.md`          |
| MF  | Module and Persona Folders                | `git show 50c75d147:docs/plan/module-persona-folders.md`        |
| RI  | Request Interception                      | `git show 0eca3c7c1:docs/plan/request-interception.md`          |
| SD  | Structured Memory Story Dates             | `git show e20bd2809:docs/plan/structured-memory-story-dates.md` |

Each plan's text had been audited before its run ([plan-runner audits](plan-runner/README.md)) and each slice was
verified by the session that landed it. Nobody had read a finished plan against its own decisions, against the plans
that landed beside it, or against the commits that changed it afterwards. The plans retired up to 2026-11-13 were
covered by the [wide review](wide-review-2026-11-14.md); Generation Progress Window, OOC Session, and Structured
Memory Greeting Source were read the same way on 2026-11-14, and Remote Host has
[its own post-audit](remote-host-post-audit-2026-11-16.md).

The run was also a trial of the GPT-6.2 models, at the owner's request: the earlier reviews used GPT-6 Astra and
GPT-6.1 Sol.

The briefs, the fourteen reports, the probes, and the reruns are kept outside the repository, under the review
material folder of 2026-11-18.

## Method

1. One read-only GPT-6.2-Astra session (`xhigh`) per plan, each in its own detached worktree, with a common brief and
   a cut file. The cut file named the plan's slice commits, the later commits that touched its files (and which of
   them changed the plan's result on purpose), ten or so points where a slice could pass its tests and miss the
   decision, and the seams with the neighboring plans.
2. Each report had to fill a decision table (the code that carries out each decision and the test that would fail
   if it were reversed), a table of slice promises, a row per point and seam with what was read and what was run,
   and five break-tests. A P1 or P2 needed a file and line, a trigger written as steps, and a probe with its command
   and output.
3. The orchestrating session reran every P1 and P2 probe once and read the cited code for the findings it rated.
4. One GPT-6.2-Sol session (`xhigh`) per report, which had not seen the verifier's reasoning beyond the report, tried
   to refute its P1 and P2 findings: whether the probe drives a product entry point, whether an ordinary user reaches
   the trigger, whether the behavior was there before the plan, whether it is recorded, the consequence, the
   priority, and the cheapest fix. P3 findings were not re-read.
5. Who ran which tests was fixed in the briefs: nobody reran an existing test on unchanged code, a break-test ran
   once in its broken state with `--no-rerun`, and a refuter got the orchestrator's rerun output instead of rerunning
   a probe.

## Result

| ID  | Verifier | Tokens | Filed (P1 / P2 / P3) | Refuter | Tokens |
| --- | -------- | ------ | -------------------- | ------- | ------ |
| IH  | 41 min   | 21.7 M | 1 / 3 / 1            | 6 min   | 2.5 M  |
| HH  | 28 min   | 10.8 M | 1 / 3 / 3            | 7 min   | 2.1 M  |
| CN  | 28 min   | 17.5 M | 0 / 1 / 4            | 3 min   | 1.3 M  |
| SB  | 28 min   | 18.8 M | 0 / 1 / 3            | 4 min   | 1.1 M  |
| MF  | 27 min   | 14.3 M | 1 / 3 / 2            | 7 min   | 2.2 M  |
| RI  | 24 min   | 14.6 M | 1 / 2 / 3            | 6 min   | 1.9 M  |
| SD  | 27 min   | 14.3 M | 0 / 2 / 1            | 5 min   | 1.6 M  |

About 112 M tokens for the verifiers and 12.6 M for the refuters. Seven verifiers were started together; five ran at
once and two waited about ten minutes before their first step (the times above leave that wait out).

All nineteen P1 and P2 probes behaved as their reports say, and none was refuted outright. Six findings describe
behavior older than their plan, one is the plan's own decision, and five were narrowed. No plan was found not to
carry out a decision that its own tests claimed to guard: of the 35 break-tests, the verifiers reported two tests
that stayed green under their break (CN-3, RI-4).

The priorities below are the verifier's, the refuter's, and the orchestrating session's ("session").

- **HH-1 (filed P1; refuter P1; session P2).** The headless host starts Chrome with certificate errors ignored for
  the whole browser context. The plan's text says that is safe because the app's address is loopback, but the page
  also loads stylesheets from two public hosts, and plugins and providers make their own HTTPS requests from it.
  Someone on the host's network path can answer those with any certificate. The session rates it P2 for the position
  it needs.
- **IH-1 (filed P1; refuter P1, pre-existing; session P2).** A chat has one send hand-off row. When a send fails
  while the composer holds newer text, the failed send's text stays only in that row; sending the newer text
  overwrites it, and the first text is gone from the composer, the journal, and the chat. Two ordinary sends did the
  same before the plan. The plan widened it: a failed draft send is also kept out by a newer draft, translation, or
  attachment, and its row holds both boxes.
- **MF-1 (filed P1; refuter: pre-existing, P2 for the new part; session P2).** A library can hold two modules with
  one id (an upstream database import and a plugin's whole-list write both keep the pair, and it survives a reload).
  The catalog's trash button confirms by name and removes the first module with the id, which can be the other one.
  That is older than the plan. New with the plan: filing moves both rows, and the removal clears the shared folder
  membership.
- **RI-1 (filed P1; refuter P2, narrowed; session P3).** A live update of the `providers` section replaces the rule
  objects, the popup editor's row identity guard closes the session, and the text typed in the popup is not written
  back. Another tab or device has to save any provider setting while the popup is open.
- **HH-2 (P2, narrowed; session P3).** The script's restart closes the tab and opens a new one, which has no
  `sessionStorage`. A remote command whose receipt was pending is never reported: the requester sees "no answer"
  and the relay keeps the entry until it drops it. A remote "Reload page" keeps the tab and is not affected.
- **HH-3 (P2; session P3).** The restart wait is reset from the failed load's ready time, which keeps growing while
  the page is down. A renderer that crashes a second after ready waits 5, 10, 20, 40, 80, then 10 seconds again.
- **HH-4 (P2; session P3).** The script reads its settings from a copy of the environment. On Windows the copy loses
  the case-insensitive lookup, so `Port` or `Risu_Chrome` is not found while the server finds `PORT` under any
  spelling. The commit that added Windows support says it was checked on Linux only.
- **IH-4 (P2; session P3).** The Send Draft button reads the local send state without subscribing to it. After a
  slash command or a send ends it stays disabled until the draft is edited; Enter still sends.
- **MF-2 (P2; session P3).** The merge compares a folder's member ids in order. Two tabs that file the same items
  in another order conflict, although the plan says the order means nothing and equal changes converge; the losing
  tab takes the server's list and an unrelated rename it held is dropped. It needs one tab holding unsaved folder
  changes while another device files the same items.
- **RI-2 (P2; session P3).** A command job loads its scope again for each part, so a rule edited while the job runs
  reaches the later parts. The plan says a job's later requests use the list the job started with. A group send
  keeps one list.
- **RI-3 (P2; session P3).** The rule's text area is plain, but the popup editor still opens as Markdown, and its
  Preview and token count evaluate CBS that the request sends as written.
- **SD-1 (P2, narrowed; session P3).** The plan put the rule against day-relative words into the analysis and patch
  rules. Page compaction is a third call that writes text a later send reads, and its rules lack it. Whether a model
  then writes "yesterday" was shown with a scripted answer, not measured.
- **IH-3 (P2, pre-existing; session P3).** A send that is still pending when the user opens and closes Settings
  settles into the destroyed composer. The failed text is in the hand-off row and comes back when the chat is shown
  again or the page reloads. Ordinary sends did the same before the plan.
- **MF-3 (filed P2; P3).** An item whose id is only whitespace (an upstream import can bring one) cannot be filed:
  the persona select returns silently and the module move throws.
- **MF-4 (filed P2; P3, pre-existing).** With one id twice in `enabledModules`, the module's own button removes one
  entry and leaves the module on, while the folder's switch removes both.
- **SB-1 (filed P2; P3, pre-existing).** A template drag in progress when another tab deletes the shown preset drops
  into the preset the page fell back to and reorders it.
- **SD-2 (filed P2; P3).** The Timeline row drops an event's date when the event has no time text. Only a hand-made
  backup stores such an event.
- **CN-1 (filed P2; pre-existing, not this plan's).** A plugin's edit of a reply that is still locked is refused
  before it is queued, so the host's save check sees nothing and releases. Waiting for the time limit would change
  only when the notification arrives: the edit is lost either way, and the refusal is in
  [the plugin guide](../../structure/plugin-sandbox.md).
- **IH-2 (filed P2; by design).** A hook's busy state and its Stop are screen-local by the plan's D10, so a send is
  admitted after a Settings round trip while the old hook still runs; its result is dropped.

The seventeen P3 findings are guide sentences (a limit or exclusion a plan decided and no guide records, or a
sentence a later commit made wrong), the two tests above, a wrong module comment, a log line that loses its position,
a settings box that shows a value the server clamped, a request type that lacks a field its caller passes, and a
folder count the picker shows without the enabled part.

Clean results worth keeping: Sidebar-Only Chat Binding's central case (a chat bound to one preset while the tab
selects another: edits reach the selected record, the request uses the bound one) and every first-party caller of
`pickBinding`; Structured Memory Story Dates' claim that stored records without a date render byte for byte as
before, compared against the renderer before the plan; Request Interception's "once, at one of two places" over
every path that reaches a model; the state table of the completion hold; both isolated browser runs of the headless
host check.

## The 6.2 models against the earlier runs

|                                  | GPT-6 Astra (2026-11-14, 2026-11-16) | GPT-6.2 Astra (this run) |
| -------------------------------- | ------------------------------------ | ------------------------ |
| One verifier                     | 18 to 29 min, 6.5 to 11.2 M tokens   | 24 to 41 min, 11 to 22 M |
| P1 and P2 filed per report       | 0.7 to 1.5                           | 2.7                      |
| Filed P1 or P2 kept by a refuter | 5 of 6 (one lowered)                 | 12 of 19 (three lowered) |

- The 6.2 verifier read further and wrote more probes: about 1.5 times the time and 1.7 times the tokens per plan.
  Every finding it filed reproduced, so it did not file hypotheses.
- It rates high and does not separate a plan's defect from an older one: four P1 were filed, the refuters kept two
  (one of them older than its plan), and six of nineteen findings predate their plan. The brief's line about a P1 and
  P2 list longer than six did not hold it back.
- A GPT-6.2-Sol refuter took 3 to 7 minutes and 1 to 2.5 M tokens for one to four findings, and its "before the
  plan" reading is what sorted the list. A 6.2 verifier without a refuter would overstate.
- The comparison is not clean: seven verifiers shared the machine (three or four before), and the brief gained a
  section on later commits and the split of test runs.

## Notes for the next run of this kind

- Ask the verifier, not only the refuter, to read the same code at the plan's base before it rates a finding.
- A cut file took about five minutes to write once the plan had been read. Listing the later commits that touched a
  plan's files, with the ones that changed its result on purpose, kept two deliberate changes (the removed binding
  note, the Windows support) out of the findings.
- Starting seven agents at once ran five; plan the wall clock for two waves.
