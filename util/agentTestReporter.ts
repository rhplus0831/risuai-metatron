// Vitest reporter for agents: prints nothing while tests run, then only the failures (test name,
// error message, diff, in-repo stack frames, that test's console output) and one summary line. With
// `test:agent --slow-tests[=<ms>]` it also lists the passed tests slower than that, as a warning
// that never changes the exit code (the wrapper passes the threshold in RISU_REPORT_SLOW_TESTS_MS).
// When the wrapper sets RESULTS_FILE_ENV it also writes the run's per-file results there, for the
// wrapper's rerun of failed files alone (`util/agentTestResults.mjs`).
// Used by `pnpm test:agent` (`util/agentTest.mjs`). See `docs/structure/build-test-platforms.md`.
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import type { Reporter, TestModule, TestRunEndReason, UserConsoleLog, Vitest } from "vitest/node";
import { RESULTS_FILE_ENV, summaryLine } from "./agentTestResults.mjs";

// The text fields are `unknown`: an error thrown outside `expect` (node:assert, a custom error) can
// carry a number or an object as `actual`/`expected`, and the reporter must still print the failure.
interface ErrorLike {
    name?: string;
    message?: unknown;
    stack?: unknown;
    stacks?: ReadonlyArray<{ file: string; line: number; column: number; method?: string }>;
    diff?: unknown;
    expected?: unknown;
    actual?: unknown;
    cause?: ErrorLike;
}

const MAX_FRAMES = 6;
const MAX_DIFF_LINES = 60;
const MAX_VALUE_LINES = 12;
const MAX_LOG_LINES = 40;
const MAX_CAUSE_DEPTH = 3;
const MAX_SLOW_TESTS = 10;

/** One test file's line in the results file (`util/agentTestResults.mjs`). */
interface FileResult {
    file: string;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
    /** Module and suite errors. */
    errors: number;
    failures: { name: string; message: string }[];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const toText = (value: unknown): string =>
    typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 100 });
const stripAnsi = (value: unknown): string => toText(value).replace(ANSI, "");

const firstLine = (errors: ReadonlyArray<ErrorLike>): string =>
    errors.length === 0
        ? ""
        : (stripAnsi(errors[0].message ?? "")
              .trim()
              .split("\n")[0] ?? "");

const capLines = (text: unknown, max: number): string[] => {
    const lines = stripAnsi(text).replace(/\s+$/, "").split("\n");
    if (lines.length <= max) return lines;
    return [...lines.slice(0, max), `... (${lines.length - max} more lines)`];
};

export default class AgentTestReporter implements Reporter {
    private root = process.cwd();
    /** The slow-test list's threshold in ms; undefined: no list. */
    private slowTestsMs: number | undefined;
    private startedAt = Date.now();
    private logs = new Map<string, UserConsoleLog[]>();
    private logLines = new Map<string, number>();

    onInit(vitest: Vitest): void {
        this.root = vitest.config.root;
        const slowTestsMs = process.env.RISU_REPORT_SLOW_TESTS_MS;
        this.slowTestsMs = slowTestsMs && /^\d+$/.test(slowTestsMs) ? Number(slowTestsMs) : undefined;
    }

    onTestRunStart(): void {
        this.startedAt = Date.now();
        this.logs.clear();
        this.logLines.clear();
    }

    // Logs are kept per task and printed only under a failing test, capped at MAX_LOG_LINES each.
    onUserConsoleLog(log: UserConsoleLog): void {
        const id = log.taskId ?? "";
        const seen = this.logLines.get(id) ?? 0;
        if (seen > MAX_LOG_LINES) return;
        this.logLines.set(id, seen + log.content.split("\n").length);
        const list = this.logs.get(id) ?? [];
        list.push(log);
        this.logs.set(id, list);
    }

    onTestRunEnd(
        modules: ReadonlyArray<TestModule>,
        unhandledErrors: ReadonlyArray<ErrorLike>,
        reason: TestRunEndReason,
    ): void {
        const files: FileResult[] = [];
        const slow: { duration: number; name: string }[] = [];

        for (const module of modules) {
            const file = this.relative(module.moduleId);
            const result: FileResult = { file, passed: 0, failed: 0, skipped: 0, pending: 0, errors: 0, failures: [] };
            files.push(result);
            const fail = (name: string, errors: ReadonlyArray<ErrorLike>, taskId: string) => {
                result.failures.push({ name, message: firstLine(errors) });
                this.printFailure(`FAIL ${name}`, errors, taskId);
            };
            const errors = module.errors();
            if (errors.length > 0) {
                result.errors += 1;
                fail(`${file} (module)`, errors, module.id);
            }
            for (const suite of module.children.allSuites()) {
                const suiteErrors = suite.errors();
                if (suiteErrors.length === 0) continue;
                result.errors += 1;
                fail(`${file} > ${suite.fullName} (suite)`, suiteErrors, suite.id);
            }
            for (const test of module.children.allTests()) {
                const testResult = test.result();
                if (testResult.state === "failed") {
                    result.failed += 1;
                    fail(`${file} > ${test.fullName}`, testResult.errors, test.id);
                } else if (testResult.state === "passed") {
                    result.passed += 1;
                    const duration = test.diagnostic()?.duration ?? 0;
                    if (this.slowTestsMs !== undefined && duration > this.slowTestsMs)
                        slow.push({ duration, name: `${file} > ${test.fullName}` });
                } else if (testResult.state === "skipped") {
                    result.skipped += 1;
                } else {
                    result.pending += 1;
                }
            }
        }
        for (const error of unhandledErrors) {
            this.printFailure("UNHANDLED ERROR", [error]);
        }
        const slowLines = this.slowLines(slow);
        for (const line of slowLines) this.write(line);

        const durationMs = Date.now() - this.startedAt;
        this.write(
            summaryLine({
                reason,
                files,
                unhandledErrors: unhandledErrors.length,
                seconds: (durationMs / 1000).toFixed(1),
            }),
        );
        const resultsFile = process.env[RESULTS_FILE_ENV];
        if (resultsFile) {
            writeFileSync(
                resultsFile,
                JSON.stringify({ reason, durationMs, unhandledErrors: unhandledErrors.length, slowLines, files }),
            );
        }
    }

    // A warning only: the gate's timeout is a hang guard (`STRUCTURE.md` V3), and a duration measured
    // beside parallel workers or other load says little about the test alone.
    private slowLines(slow: { duration: number; name: string }[]): string[] {
        if (this.slowTestsMs === undefined || slow.length === 0) return [];
        slow.sort((a, b) => b.duration - a.duration);
        const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
        const lines = [
            `SLOW ${slow.length} passed ${slow.length === 1 ? "test" : "tests"} took over ${seconds(this.slowTestsMs)} in this run ` +
                "(a warning, not a failure; durations under load or beside parallel workers are inflated):",
        ];
        for (const { duration, name } of slow.slice(0, MAX_SLOW_TESTS)) lines.push(`  ${seconds(duration)} ${name}`);
        if (slow.length > MAX_SLOW_TESTS) lines.push(`  ... and ${slow.length - MAX_SLOW_TESTS} more`);
        lines.push("");
        return lines;
    }

    private printFailure(header: string, errors: ReadonlyArray<ErrorLike>, taskId?: string): void {
        this.write(header);
        for (const error of errors) this.printError(error, "  ", 0);
        const logs = taskId ? this.logs.get(taskId) : undefined;
        if (logs && logs.length > 0) {
            this.write("  console:");
            let budget = MAX_LOG_LINES;
            for (const log of logs) {
                for (const line of capLines(log.content, budget)) {
                    this.write(`    [${log.type}] ${line}`);
                    budget -= 1;
                }
                if (budget <= 0) break;
            }
        }
        this.write("");
    }

    private printError(error: ErrorLike, indent: string, depth: number): void {
        const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
        const message = stripAnsi(error.message ?? "").replace(/\s+$/, "") || "(no message)";
        const [first, ...rest] = message.split("\n");
        this.write(`${indent}${name}${first}`);
        for (const line of rest) this.write(`${indent}${line}`);

        if (error.diff) {
            for (const line of capLines(error.diff, MAX_DIFF_LINES)) this.write(`${indent}${line}`);
        } else if (error.expected !== undefined || error.actual !== undefined) {
            if (error.expected !== undefined) {
                this.write(`${indent}expected:`);
                for (const line of capLines(error.expected, MAX_VALUE_LINES)) this.write(`${indent}  ${line}`);
            }
            if (error.actual !== undefined) {
                this.write(`${indent}actual:`);
                for (const line of capLines(error.actual, MAX_VALUE_LINES)) this.write(`${indent}  ${line}`);
            }
        }

        for (const frame of this.frames(error)) this.write(`${indent}  at ${frame}`);

        if (error.cause && depth < MAX_CAUSE_DEPTH) {
            this.write(`${indent}caused by:`);
            this.printError(error.cause, `${indent}  `, depth + 1);
        }
    }

    // In-repo frames only: a frame from node_modules, Node internals, or an anonymous function is noise
    // to an agent, and when no frame is in the repository the message already names the file.
    private frames(error: ErrorLike): string[] {
        const parsed = (error.stacks ?? []).map(
            (frame) =>
                `${this.relative(frame.file)}:${frame.line}:${frame.column}${frame.method ? ` ${frame.method}` : ""}`,
        );
        const raw =
            parsed.length > 0
                ? parsed
                : stripAnsi(error.stack ?? "")
                      .split("\n")
                      .filter((line) => /^\s*at /.test(line))
                      .map((line) => line.trim().replace(/^at /, ""))
                      .map((line) => this.relative(line.replace(/file:\/\//g, "")));
        const frames: string[] = [];
        for (const frame of raw) {
            if (frame.includes("node_modules/") || frame.includes("node:") || frame.includes("<anonymous>")) continue;
            if (isAbsolute(frame) || frame.includes("(/")) continue;
            if (frames[frames.length - 1] !== frame) frames.push(frame);
        }
        return frames.slice(0, MAX_FRAMES);
    }

    private relative(text: string): string {
        const path = text.replace(/^file:\/\//, "");
        return path.split(`${this.root}/`).join("");
    }

    private write(line: string): void {
        process.stdout.write(`${line}\n`);
    }
}
