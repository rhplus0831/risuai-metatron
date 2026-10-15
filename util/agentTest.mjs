#!/usr/bin/env node
// `pnpm test:agent [--force] [--verbose] [--all] [vitest args]`: `pnpm test` for agents.
//
// Runs `vitest run --tags-filter=!slow` (`--all` drops the tag filter, like `pnpm test:all`) with `util/agentTestReporter.ts` (failures and one summary
// line only, on stdout) and caches the output under `node_modules/.cache/agent-test/` keyed by the
// working tree. Everything the run writes to stderr (Node warnings, worker-thread traces from
// passing tests) is held back: a passing run reports only its line count, a failing run prints the
// last STDERR_TAIL lines after the report, and `--verbose` prints all of it either way. The key is `git write-tree` over a temporary index with every change staged (untracked
// files included, `.gitignore` honored), plus the Node and Vitest versions and the arguments. When
// nothing changed since the last run, the stored output is printed again with the stored exit code
// instead of running the tests, so two agents checking the same tree pay for one run. Failures are
// cached too (the same tree gives the same result); `--force` runs anyway and replaces the entry.
// An explicit `--tags-filter` replaces the default one. The child gets `AGENT_TEST=1`, which is what
// lets it through the human gate in `vitest.config.ts` (`util/requireHuman.mjs`).
// See `docs/structure/build-test-platforms.md`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "node_modules", ".cache", "agent-test");
const vitestBin = join(root, "node_modules", "vitest", "vitest.mjs");
const reporter = "./util/agentTestReporter.ts";
const STDERR_TAIL = 60;

const args = process.argv.slice(2);
const force = args.includes("--force");
const verbose = args.includes("--verbose");
const all = args.includes("--all");
const vitestArgs = args.filter((arg) => arg !== "--force" && arg !== "--verbose" && arg !== "--all");
if (!all && !vitestArgs.some((arg) => arg === "--tags-filter" || arg.startsWith("--tags-filter="))) {
    vitestArgs.unshift("--tags-filter=!slow");
}

const log = (line) => process.stdout.write(`[agent-test] ${line}\n`);

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

function run() {
    return new Promise((done) => {
        const out = [];
        const err = [];
        const result = (code) => ({
            code,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
        });
        const child = spawn(process.execPath, [vitestBin, "run", ...vitestArgs, `--reporter=${reporter}`], {
            cwd: root,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", AGENT_TEST: "1" },
            stdio: ["inherit", "pipe", "pipe"],
            windowsHide: true,
        });
        child.stdout.on("data", (chunk) => {
            process.stdout.write(chunk);
            out.push(chunk);
        });
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

const argsHash = createHash("sha256").update(JSON.stringify(vitestArgs)).digest("hex").slice(0, 16);
const entryFile = join(cacheDir, `${argsHash}.json`);
const key =
    tree === null
        ? null
        : createHash("sha256")
              .update(JSON.stringify([tree, process.version, vitestVersion(), vitestArgs]))
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

const startedAt = Date.now();
const { code, stdout, stderr } = await run();
if (code === null) {
    printStderr(stderr, 1);
    log("interrupted: nothing cached");
    process.exit(1);
}
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
