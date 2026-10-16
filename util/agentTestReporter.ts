// Vitest reporter for agents: prints nothing while tests run, then only the failures (test name,
// error message, diff, in-repo stack frames, that test's console output) and one summary line.
// Used by `pnpm test:agent` (`util/agentTest.mjs`). See `docs/structure/build-test-platforms.md`.
import { isAbsolute } from "node:path";
import { inspect } from "node:util";
import type { Reporter, TestModule, TestRunEndReason, UserConsoleLog, Vitest } from "vitest/node";

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

const ANSI = /\u001b\[[0-9;]*m/g;
const toText = (value: unknown): string =>
    typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 100 });
const stripAnsi = (value: unknown): string => toText(value).replace(ANSI, "");

const capLines = (text: unknown, max: number): string[] => {
    const lines = stripAnsi(text).replace(/\s+$/, "").split("\n");
    if (lines.length <= max) return lines;
    return [...lines.slice(0, max), `... (${lines.length - max} more lines)`];
};

export default class AgentTestReporter implements Reporter {
    private root = process.cwd();
    private startedAt = Date.now();
    private logs = new Map<string, UserConsoleLog[]>();
    private logLines = new Map<string, number>();

    onInit(vitest: Vitest): void {
        this.root = vitest.config.root;
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
        let failed = 0;
        let passed = 0;
        let skipped = 0;
        let pending = 0;
        let moduleErrors = 0;
        const failedFiles = new Set<string>();

        for (const module of modules) {
            const file = this.relative(module.moduleId);
            const errors = module.errors();
            if (errors.length > 0) {
                moduleErrors += 1;
                failedFiles.add(file);
                this.printFailure(`FAIL ${file} (module)`, errors, module.id);
            }
            for (const suite of module.children.allSuites()) {
                const suiteErrors = suite.errors();
                if (suiteErrors.length === 0) continue;
                moduleErrors += 1;
                failedFiles.add(file);
                this.printFailure(`FAIL ${file} > ${suite.fullName} (suite)`, suiteErrors, suite.id);
            }
            for (const test of module.children.allTests()) {
                const result = test.result();
                if (result.state === "failed") {
                    failed += 1;
                    failedFiles.add(file);
                    this.printFailure(`FAIL ${file} > ${test.fullName}`, result.errors, test.id);
                } else if (result.state === "passed") {
                    passed += 1;
                } else if (result.state === "skipped") {
                    skipped += 1;
                } else {
                    pending += 1;
                }
            }
        }
        for (const error of unhandledErrors) {
            this.printFailure("UNHANDLED ERROR", [error]);
        }

        const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        const files = `${modules.length} files`;
        const parts = [`${failed} failed`, `${passed} passed`];
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (pending > 0) parts.push(`${pending} not run`);
        if (moduleErrors > 0) parts.push(`${moduleErrors} module/suite errors`);
        if (unhandledErrors.length > 0) parts.push(`${unhandledErrors.length} unhandled errors`);

        const ok = failed === 0 && moduleErrors === 0 && unhandledErrors.length === 0 && reason === "passed";
        if (reason === "interrupted") {
            this.write(`INTERRUPTED ${parts.join(", ")} (${files}, ${seconds}s)`);
        } else if (modules.length === 0) {
            this.write(`FAIL no test files matched (${seconds}s)`);
        } else if (ok) {
            this.write(`OK ${parts.slice(1).join(", ")} (${files}, ${seconds}s)`);
        } else {
            this.write(`FAIL ${parts.join(", ")} (${failedFiles.size} of ${files} failed, ${seconds}s)`);
        }
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
