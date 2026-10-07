# Server test fixtures

Each fixture here is either a hand-maintained record or a frozen capture. The subfolder READMEs
(`baseline/`, `tokens/`, `memory/`) state which, and how a deliberate behavior change is reflected.

## `cbs-parity.json`

Hand-maintained. The CBS host-parity cases of Phase 5 slice 3: the same strings evaluated by the
client wrapper (`src/ts/parser/tests/cbs/hostParity.test.ts`) and by the shared evaluator under plain
Node (`server/src/tests/cbs.test.ts`, plus the bounded evaluator in `cbsLimits.test.ts`). The file's
own `readme` key describes the case shape. The expected values were derived by hand from the
registry and evaluator code, and the cases named `quirk` pin legacy behavior on purpose. There is no
capture script. A deliberate change to CBS semantics edits the affected expected values in the same
commit as the code, and both runtimes must still agree.
