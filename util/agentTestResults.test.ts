// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergeRerun, planRerun, summaryLine, withoutFilters } from "./agentTestResults.mjs";

function file(
    name: string,
    counts: { passed?: number; failed?: number; errors?: number } = {},
    failures: string[] = [],
) {
    return {
        file: name,
        passed: counts.passed ?? 0,
        failed: counts.failed ?? 0,
        skipped: 0,
        pending: 0,
        errors: counts.errors ?? 0,
        failures: failures.map((test) => ({ name: `${name} > ${test}`, message: `${test} broke` })),
    };
}

function report(files: ReturnType<typeof file>[], extra: { reason?: string; unhandledErrors?: number } = {}) {
    return { reason: "failed", durationMs: 12_300, unhandledErrors: 0, slowLines: [], files, ...extra };
}

describe("planRerun", () => {
    it("reruns only the files that failed", () => {
        const plan = planRerun(
            report([
                file("a.test.ts", { passed: 3 }),
                file("b.test.ts", { failed: 1 }),
                file("c.test.ts", { errors: 1 }),
            ]),
        );
        expect(plan).toEqual({ files: ["b.test.ts", "c.test.ts"] });
    });

    it("does not rerun more failed files than the cap, and says why", () => {
        const files = ["a", "b", "c"].map((name) => file(`${name}.test.ts`, { failed: 1 }));
        expect(planRerun(report(files), 2)).toEqual({ files: [], reason: expect.stringContaining("3 files failed") });
        expect(planRerun(report(files), 3).files).toHaveLength(3);
    });

    it("does not rerun a run with unhandled errors, an interrupted run, or a run without results", () => {
        const failing = [file("a.test.ts", { failed: 1 })];
        expect(planRerun(report(failing, { unhandledErrors: 1 })).files).toEqual([]);
        expect(planRerun(report(failing, { reason: "interrupted" })).files).toEqual([]);
        expect(planRerun(null).files).toEqual([]);
    });
});

describe("withoutFilters", () => {
    it("drops the file filters and keeps option values that share their text", () => {
        expect(withoutFilters(["-t", "src", "--tags-filter=!slow", "src"], ["src"])).toEqual([
            "-t",
            "src",
            "--tags-filter=!slow",
        ]);
    });
});

describe("mergeRerun", () => {
    const fullRun = () =>
        report([
            file("a.test.ts", { passed: 4 }),
            file("b.test.ts", { passed: 1, failed: 1 }, ["times out under load"]),
            file("c.test.ts", { passed: 2, failed: 1 }, ["real bug"]),
        ]);
    const clean = (name: string, passed: number) => ({
        file: name,
        code: 0,
        stdout: `OK ${passed} passed (1 files, 0.5s)\n`,
        report: report([file(name, { passed })], { reason: "passed" }),
    });

    it("counts a file that passes alone as passed and lists its full-run failures as FLAKY", () => {
        const run = report([file("a.test.ts", { passed: 4 }), file("b.test.ts", { passed: 1, failed: 1 }, ["slow"])]);
        const merged = mergeRerun(run, [clean("b.test.ts", 2)], 500);

        expect(merged.code).toBe(0);
        expect(merged.flaky).toEqual([{ name: "b.test.ts > slow", message: "slow broke" }]);
        expect(merged.stdout).toContain(
            "FLAKY 1 test failed in the full run and passed when their files ran again alone",
        );
        expect(merged.stdout.trimEnd().split("\n").at(-1)).toBe(
            "OK 6 passed (2 files, 12.3s, 1 failed file rerun alone in 0.5s)",
        );
    });

    it("keeps a file that fails again alone failing and shows that run's failures, not the full run's", () => {
        const failedAgain = {
            file: "c.test.ts",
            code: 1,
            stdout: "FAIL c.test.ts > real bug\n  expected 1 to be 2\n\nFAIL 1 failed, 2 passed (1 of 1 files failed, 0.4s)\n",
            report: report([file("c.test.ts", { passed: 2, failed: 1 }, ["real bug"])]),
        };
        const merged = mergeRerun(fullRun(), [clean("b.test.ts", 2), failedAgain], 900);

        expect(merged.code).toBe(1);
        expect(merged.flaky.map(({ name }) => name)).toEqual(["b.test.ts > times out under load"]);
        expect(merged.stdout).toContain("RERUN c.test.ts failed again when run alone");
        expect(merged.stdout).toContain("FAIL c.test.ts > real bug\n  expected 1 to be 2");
        expect(merged.stdout).not.toContain("FAIL 1 failed, 2 passed (1 of 1 files failed");
        expect(merged.stdout.trimEnd().split("\n").at(-1)).toBe(
            "FAIL 1 failed, 8 passed (1 of 3 files failed, 12.3s, 2 failed files rerun alone in 0.9s)",
        );
    });

    it("does not clear a file whose rerun exits 0 without running it", () => {
        const empty = { file: "b.test.ts", code: 0, stdout: "", report: report([], { reason: "passed" }) };
        const merged = mergeRerun(fullRun(), [empty], 100);

        expect(merged.code).toBe(1);
        expect(merged.flaky).toEqual([]);
    });

    it("keeps the run failing when a rerun crashed without results", () => {
        const crashed = { file: "b.test.ts", code: 1, stdout: "", report: null };
        const run = report([file("b.test.ts", { passed: 1, failed: 1 }, ["slow"])]);
        expect(mergeRerun(run, [crashed], 100).code).toBe(1);
    });
});

describe("summaryLine", () => {
    it("is FAIL when the run did not pass even without failed tests", () => {
        expect(
            summaryLine({
                reason: "failed",
                files: [file("a.test.ts", { passed: 1 })],
                unhandledErrors: 1,
                seconds: "1.0",
            }),
        ).toBe("FAIL 0 failed, 1 passed, 1 unhandled errors (0 of 1 files failed, 1.0s)");
    });
});
