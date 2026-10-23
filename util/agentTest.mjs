#!/usr/bin/env node
// `pnpm test:agent [--force] [--verbose] [--all] [--slow-tests[=<ms>]] [--no-rerun] [vitest args]`:
// `pnpm test` for agents.
//
// Runs `vitest run --tags-filter=!slow` (`--all` drops the tag filter, like `pnpm test:all`) with
// `util/agentTestReporter.ts` (failures and one summary line only, on stdout; `--slow-tests` adds a
// warning listing the passed tests slower than <ms>, default 1000) and caches the output under
// `node_modules/.cache/agent-test/` keyed by the working tree. Everything the run writes to stderr (Node warnings, worker-thread traces from
// passing tests) is held back: a passing run reports only its line count, a failing run prints the
// last STDERR_TAIL lines after the report, and `--verbose` prints all of it either way. The key is `git write-tree` over a temporary index with every change staged (untracked
// files included, `.gitignore` honored), plus the Node and Vitest versions and the arguments. When
// nothing changed since the last run, the stored output is printed again with the stored exit code
// instead of running the tests, so two agents checking the same tree pay for one run. Failures are
// cached too (the same tree gives the same result); `--force` runs anyway and replaces the entry.
// An explicit `--tags-filter` replaces the default one. The child gets `AGENT_TEST=1`, which is what
// lets it through the human gate in `vitest.config.ts` (`util/requireHuman.mjs`).
// When a run fails in at most MAX_RERUN_FILES files (and has no unhandled errors), each of those files
// runs again alone, one at a time, after the full run: a file that passes alone counts as passed, its
// full-run failures are listed in a FLAKY warning and appended to FLAKY_LOG, and a file that fails again
// shows the failures of its run alone. `--no-rerun` (which `test:overload` passes) turns this off.
// See `docs/structure/build-test-platforms.md`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_RERUN_FILES, RESULTS_FILE_ENV, mergeRerun, planRerun, withoutFilters } from "./agentTestResults.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "node_modules", ".cache", "agent-test");
const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
const reporter = "./util/agentTestReporter.ts";
/** How the wrapper hands `--slow-tests` to the reporter (empty: no slow-test list). */
const SLOW_TESTS_ENV = "RISU_REPORT_SLOW_TESTS_MS";
const STDERR_TAIL = 60;
/** One JSON line per test that failed in a full run and passed when its file ran alone. */
const FLAKY_LOG = join(cacheDir, "flaky.jsonl");

const SLOW_TESTS_DEFAULT_MS = 1000;

const args = process.argv.slice(2);
const force = args.includes("--force");
const verbose = args.includes("--verbose");
const all = args.includes("--all");
const rerun = !args.includes("--no-rerun");
const isSlowTests = (arg) => arg === "--slow-tests" || arg.startsWith("--slow-tests=");
// `--slow-tests[=<ms>]`: the reporter also lists the passed tests slower than this (it gets the
// threshold through SLOW_TESTS_ENV); never forwarded to Vitest.
let slowTestsMs;
for (const arg of args.filter(isSlowTests)) {
    const value = arg === "--slow-tests" ? String(SLOW_TESTS_DEFAULT_MS) : arg.slice("--slow-tests=".length);
    if (!/^\d+$/.test(value)) {
        process.stderr.write(`[agent-test] --slow-tests=<ms> takes a whole number of milliseconds, got "${value}"\n`);
        process.exit(2);
    }
    slowTestsMs = Number(value);
}
const vitestArgs = args.filter(
    (arg) => arg !== "--force" && arg !== "--verbose" && arg !== "--all" && arg !== "--no-rerun" && !isSlowTests(arg),
);
if (!all && !vitestArgs.some((arg) => arg === "--tags-filter" || arg.startsWith("--tags-filter="))) {
    vitestArgs.unshift("--tags-filter=!slow");
}

const log = (line) => process.stdout.write(`[agent-test] ${line}\n`);
// The cache key's arguments: the Vitest arguments plus the wrapper options that change the output.
const keyArgs = [
    ...vitestArgs,
    ...(slowTestsMs === undefined ? [] : [`--slow-tests=${slowTestsMs}`]),
    rerun ? `--rerun-alone=${MAX_RERUN_FILES}` : "--no-rerun",
];

function git(gitArgs, env = {}) {
    return spawnSync("git", gitArgs, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
}

// Tree id of the working tree: a copy of the real index (so unchanged files keep their stat cache
// and are not re-hashed) with everything staged, written as a tree object. Null outside git.
function workingTreeId() {
    const gitDir = git(["rev-parse", "--git-dir"]);
    if (gitDir.status !== 0) return null;
    const realIndex = join(resolve(root, gitDir.stdout.trim()), "index");
    const tmp = mkdtempSync(join(tmpdir(), "agent-test-"));
    const tmpIndex = join(tmp, "index");
    try {
        if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
        const env = { GIT_INDEX_FILE: tmpIndex };
        if (git(["add", "-A", "--", "."], env).status !== 0) return null;
        const tree = git(["write-tree"], env);
        return tree.status === 0 ? tree.stdout.trim() : null;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

function vitestVersion() {
    try {
        return JSON.parse(readFileSync(join(root, "node_modules", "vitest", "package.json"), "utf8")).version;
    } catch {
        return "unknown";
    }
}

function ago(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function readEntry(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

// Runs Vitest with `runArgs`, holding its stdout and stderr; the reporter prints nothing until the end.
// Returns the exit code (null when killed by a signal), the output, and the parsed results file (null
// when the reporter wrote none).
function run(runArgs, slowTests) {
    const tmp = mkdtempSync(join(tmpdir(), "agent-test-results-"));
    const resultsFile = join(tmp, "results.json");
    return new Promise((done) => {
        const out = [];
        const err = [];
        const result = (code) => {
            const report = readEntry(resultsFile);
            rmSync(tmp, { recursive: true, force: true });
            return {
                code,
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(err).toString("utf8"),
                report,
            };
        };
        const child = spawn(process.execPath, [vitestBin, "run", ...runArgs, `--reporter=${reporter}`], {
            cwd: root,
            env: {
                ...process.env,
                NO_COLOR: "1",
                FORCE_COLOR: "0",
                AGENT_TEST: "1",
                [SLOW_TESTS_ENV]: slowTests,
                [RESULTS_FILE_ENV]: resultsFile,
            },
            stdio: ["inherit", "pipe", "pipe"],
            windowsHide: true,
        });
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        child.on("error", (error) => {
            err.push(Buffer.from(`${error.message}\n`));
            done(result(1));
        });
        child.on("close", (code, signal) => done(result(signal ? null : code)));
    });
}

function printStderr(stderr, exitCode) {
    const lines = stderr
        .replace(/\s+$/, "")
        .split("\n")
        .filter((line) => line !== "");
    if (lines.length === 0) return;
    if (verbose) {
        log(`stderr of the run (${lines.length} lines):`);
        process.stdout.write(`${lines.join("\n")}\n`);
    } else if (exitCode !== 0) {
        const tail = lines.slice(-STDERR_TAIL);
        const skipped = lines.length - tail.length;
        log(
            `stderr of the run${skipped > 0 ? ` (last ${tail.length} of ${lines.length} lines; --verbose for all)` : ""}:`,
        );
        process.stdout.write(`${tail.join("\n")}\n`);
    } else {
        log(`${lines.length} lines of stderr held back from the passing run (--verbose prints them)`);
    }
}

const tree = workingTreeId();
if (tree === null) log("not a git checkout (or git failed): running without the cache");

const argsHash = createHash("sha256").update(JSON.stringify(keyArgs)).digest("hex").slice(0, 16);
const entryFile = join(cacheDir, `${argsHash}.json`);
const key =
    tree === null
        ? null
        : createHash("sha256")
              .update(JSON.stringify([tree, process.version, vitestVersion(), keyArgs]))
              .digest("hex");

const cached = key === null || force ? null : readEntry(entryFile);
if (cached && cached.key === key && typeof cached.exitCode === "number") {
    log(
        `cached result from ${ago(cached.finishedAt)}: working tree unchanged (tree ${tree.slice(0, 7)}). ` +
            "Pass --force to run again.",
    );
    process.stdout.write(cached.stdout);
    printStderr(cached.stderr, cached.exitCode);
    process.exit(cached.exitCode);
}

function interrupted(stdout, stderr) {
    process.stdout.write(stdout);
    printStderr(stderr, 1);
    log("interrupted: nothing cached");
    process.exit(1);
}

// Runs each file of a failed full run that `planRerun` accepts again alone, one at a time, and returns
// the final output (`mergeRerun`), or the full run's own when there is nothing to rerun.
async function rerunFailedFiles(full) {
    const plan = planRerun(full.report);
    if (plan.files.length === 0) {
        return {
            ...full,
            stdout: plan.reason ? `${full.stdout}[agent-test] ${plan.reason}\n` : full.stdout,
        };
    }
    log(`${plan.files.length} failed ${plan.files.length === 1 ? "file" : "files"}; running each again alone`);
    const { parseCLI } = await import("vitest/node");
    const options = withoutFilters(vitestArgs, parseCLI(["vitest", "run", ...vitestArgs]).filter);
    const startedAt = Date.now();
    const reruns = [];
    let stderr = full.stderr;
    for (const file of plan.files) {
        const alone = await run([...options, file], "");
        stderr += alone.stderr === "" ? "" : `[agent-test] stderr of ${file} run alone:\n${alone.stderr}`;
        if (alone.code === null) interrupted(full.stdout + alone.stdout, stderr);
        reruns.push({ file, ...alone });
    }
    const merged = mergeRerun(full.report, reruns, Date.now() - startedAt);
    if (merged.flaky.length > 0) {
        mkdirSync(cacheDir, { recursive: true });
        const at = new Date().toISOString();
        appendFileSync(
            FLAKY_LOG,
            merged.flaky
                .map(({ name, message }) => `${JSON.stringify({ at, tree, args: vitestArgs, name, message })}\n`)
                .join(""),
        );
    }
    return { code: merged.code, stdout: merged.stdout, stderr };
}

const startedAt = Date.now();
const full = await run(vitestArgs, slowTestsMs === undefined ? "" : String(slowTestsMs));
if (full.code === null) interrupted(full.stdout, full.stderr);
const { code, stdout, stderr } = full.code !== 0 && rerun ? await rerunFailedFiles(full) : full;
process.stdout.write(stdout);
printStderr(stderr, code);
if (key !== null) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
        entryFile,
        JSON.stringify(
            {
                key,
                tree,
                args: vitestArgs,
                exitCode: code,
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAt,
                stdout,
                stderr,
            },
            null,
            2,
        ),
    );
    log(`cached (tree ${tree.slice(0, 7)}); the next run on this working tree replays this output`);
}
process.exit(code);
