// Results of a `pnpm test:agent` run, shared by the reporter (`util/agentTestReporter.ts`) and the
// wrapper (`util/agentTest.mjs`): the summary line, and the rerun of failed files alone.
//
// With RESULTS_FILE_ENV set, the reporter writes a results file next to its output:
//   { reason, durationMs, unhandledErrors, slowLines, files: [FileResult] }
// where FileResult is { file, passed, failed, skipped, pending, errors, failures: [{ name, message }] }
// (`errors` counts module and suite errors; `failures` names each failed test, suite, or module as its
// FAIL line does). When a full run fails only in a few files, the wrapper runs each of those files
// again alone, one at a time, and a file that passes alone counts as passed: its tests failed under
// the full run's load (parallel workers, other processes), not in the code. See
// `docs/structure/build-test-platforms.md`.

/** How the wrapper tells the reporter where to write the results file. */
export const RESULTS_FILE_ENV = "RISU_REPORT_RESULTS_FILE";
/** More failed files than this is taken as a real break, not load, and is not rerun. */
export const MAX_RERUN_FILES = 5;
const MAX_FLAKY_LINES = 10;

/**
 * The reporter's last line: `OK <n> passed, ...` or `FAIL <n> failed, ...`. `note` is appended inside
 * the parentheses.
 */
export function summaryLine({ reason, files, unhandledErrors, seconds, note }) {
    const sum = (key) => files.reduce((total, file) => total + file[key], 0);
    const failed = sum("failed");
    const errors = sum("errors");
    const parts = [`${failed} failed`, `${sum("passed")} passed`];
    if (sum("skipped") > 0) parts.push(`${sum("skipped")} skipped`);
    if (sum("pending") > 0) parts.push(`${sum("pending")} not run`);
    if (errors > 0) parts.push(`${errors} module/suite errors`);
    if (unhandledErrors > 0) parts.push(`${unhandledErrors} unhandled errors`);
    const tail = `${seconds}s${note ? `, ${note}` : ""}`;
    const fileCount = `${files.length} files`;

    if (reason === "interrupted") return `INTERRUPTED ${parts.join(", ")} (${fileCount}, ${tail})`;
    if (files.length === 0) return `FAIL no test files matched (${tail})`;
    if (failed === 0 && errors === 0 && unhandledErrors === 0 && reason === "passed")
        return `OK ${parts.slice(1).join(", ")} (${fileCount}, ${tail})`;
    const failedFiles = files.filter((file) => file.failed > 0 || file.errors > 0).length;
    return `FAIL ${parts.join(", ")} (${failedFiles} of ${fileCount} failed, ${tail})`;
}

/**
 * Which files to run again alone after a failed run: `{ files }`, or `{ files: [], reason }` when the
 * failure is not one a rerun can clear (`reason` is empty when there is nothing to say).
 */
export function planRerun(report, maxFiles = MAX_RERUN_FILES) {
    if (!report || !Array.isArray(report.files)) return { files: [], reason: "" };
    if (report.reason !== "failed") return { files: [], reason: "" };
    if (report.unhandledErrors > 0)
        return { files: [], reason: "not rerun: unhandled errors belong to no single file" };
    const files = report.files.filter((file) => file.failed > 0 || file.errors > 0).map((file) => file.file);
    if (files.length === 0) return { files: [], reason: "" };
    if (files.length > maxFiles)
        return {
            files: [],
            reason: `not rerun: ${files.length} files failed (more than ${maxFiles} is taken as a real break, not load)`,
        };
    return { files };
}

/**
 * `args` without the file filters Vitest parsed out of them (`filters`, from `parseCLI`), so a rerun
 * names only its own file. Each filter removes its last occurrence: positional arguments follow the
 * option values that could share their text.
 */
export function withoutFilters(args, filters) {
    const rest = [...args];
    for (const filter of filters) {
        const index = rest.lastIndexOf(filter);
        if (index !== -1) rest.splice(index, 1);
    }
    return rest;
}

/** The reporter's stdout without its summary line (the last non-empty line). */
function withoutSummary(stdout) {
    const lines = stdout.replace(/\s+$/, "").split("\n");
    lines.pop();
    const text = lines.join("\n").replace(/\s+$/, "");
    return text === "" ? "" : `${text}\n\n`;
}

const isClean = (rerun) =>
    rerun.code === 0 &&
    rerun.report?.reason === "passed" &&
    rerun.report.unhandledErrors === 0 &&
    rerun.report.files.some(
        (file) => file.file === rerun.file && file.failed === 0 && file.errors === 0 && file.passed > 0,
    );

/**
 * The run's final output after `reruns` ({ file, code, stdout, report }, one per planned file): a file
 * whose rerun passed has its full-run failures listed as FLAKY and its counts taken from the rerun; a
 * file that failed again shows the rerun's failures instead of the full run's. Returns
 * { stdout, code, flaky: [{ name, message }] }.
 */
export function mergeRerun(report, reruns, rerunMs) {
    const files = report.files.map((file) => ({ ...file }));
    const flaky = [];
    let failedOutput = "";
    let unhandledErrors = report.unhandledErrors;
    for (const rerun of reruns) {
        const index = files.findIndex((file) => file.file === rerun.file);
        const original = files[index];
        const alone = rerun.report?.files.find((file) => file.file === rerun.file);
        if (isClean(rerun)) {
            flaky.push(...original.failures);
            files[index] = alone;
            continue;
        }
        if (alone) files[index] = alone;
        unhandledErrors += rerun.report?.unhandledErrors ?? 0;
        failedOutput += `RERUN ${rerun.file} failed again when run alone; the failures below are from that run.\n\n`;
        failedOutput += rerun.report ? withoutSummary(rerun.stdout) : rerun.stdout;
    }

    let stdout = failedOutput;
    if (report.slowLines.length > 0) stdout += `${report.slowLines.join("\n")}\n`;
    if (flaky.length > 0) {
        stdout +=
            `FLAKY ${flaky.length} ${flaky.length === 1 ? "test" : "tests"} failed in the full run and passed when ` +
            "their files ran again alone (load-sensitive: a warning, not a failure; do not fix " +
            `${flaky.length === 1 ? "it" : "them"} as part of this change. Logged in node_modules/.cache/agent-test/flaky.jsonl):\n`;
        for (const { name, message } of flaky.slice(0, MAX_FLAKY_LINES)) {
            stdout += `  ${name}\n`;
            if (message) stdout += `    ${message}\n`;
        }
        if (flaky.length > MAX_FLAKY_LINES) stdout += `  ... and ${flaky.length - MAX_FLAKY_LINES} more\n`;
        stdout += "\n";
    }
    const failed = files.some((file) => file.failed > 0 || file.errors > 0) || unhandledErrors > 0;
    const count = reruns.length;
    stdout += `${summaryLine({
        reason: failed ? "failed" : "passed",
        files,
        unhandledErrors,
        seconds: (report.durationMs / 1000).toFixed(1),
        note: `${count} failed ${count === 1 ? "file" : "files"} rerun alone in ${(rerunMs / 1000).toFixed(1)}s`,
    })}\n`;
    return { stdout, code: failed ? 1 : 0, flaky };
}
