#!/usr/bin/env node
// `pnpm test:overload [--runs N] [--cpu N] [--testTimeout MS] [files or vitest args]`: the gated suite
// under the reference overload.
//
// Picks one CPU this process may use (the last one `taskset -pc` lists, or `--cpu`), pins eight
// busy-loop burners to it, and runs `util/agentTest.mjs --force --no-rerun <args> --maxWorkers=3`
// pinned to the same CPU, `--runs` times (default 3). The test run gets about 1/9 of a CPU with deschedules of
// seconds, which is what a test that depends on real time fails under (`STRUCTURE.md` V3). No
// `--testTimeout` is passed unless given: the gate's own timeout (`vitest.config.ts`) is a hang
// guard, not a budget, so slowness alone does not fail a run here; the load exposes tests that
// depend on real time or the scheduler (investigate each failure). With no files the whole gated
// suite runs. Exits 1 when
// any run fails and names the failed runs, 2 on a usage error or when the overload itself broke (a
// burner that could not start or exited during a run). Linux only (`taskset`).
//
// Each run is one supervisor (this file with `--supervise`), started in its own session and process
// group: it starts the burners and the run, so the burners and the tests share one scheduler
// autogroup, and reports the run's result over IPC. This process then kills that whole group, which
// also takes a Vitest left behind by a wrapper that died. It does the same on exit, error, SIGINT and
// SIGTERM. A supervisor whose parent is gone kills its group, and a burner whose supervisor is gone
// exits. See `docs/structure/build-test-platforms.md` `Tests`.
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "..");
const agentTest = join(root, "util", "agentTest.mjs");
const BURNERS = 8;
const MAX_WORKERS = 3;
// Supervisor exit codes besides the run's 0 (passed) and 1 (failed).
const BROKEN = 3;
// Spins, and exits once its parent is no longer the supervisor whose pid it was given (the supervisor
// is gone and it was reparented, even before it started).
const BURNER_SOURCE =
    "const parent = Number(process.argv[1]); for (;;) { if (process.ppid !== parent) process.exit(0); for (let i = 0; i < 1e7; i++); }";

const log = (line) => process.stdout.write(`[overload] ${line}\n`);

if (process.argv[2] === "--supervise") {
    supervise(JSON.parse(process.argv[3]));
} else {
    await main();
}

// One run: the burners and the wrapper, all in this process's group (the caller started it detached).
// The result goes to the caller over IPC; this process then stays, so the group never loses its
// watchdog, until the caller kills the whole group.
function supervise({ cpu, wrapperArgs, parent }) {
    // The caller is gone (killed without cleaning up): take the whole group down.
    const orphaned = () => process.kill(0, "SIGKILL");
    process.on("disconnect", orphaned);
    setInterval(() => {
        if (process.ppid !== parent) orphaned();
    }, 250).unref();

    let settled = false;
    const finish = (code, message) => {
        if (settled) return;
        settled = true;
        if (message) process.stderr.write(`[overload] ${message}\n`);
        process.send({ code });
    };
    process.on("uncaughtException", (error) => finish(BROKEN, `supervisor error: ${error.stack ?? error}`));

    for (let i = 1; i <= BURNERS; i++) {
        const burner = spawn(
            "taskset",
            ["-c", String(cpu), process.execPath, "-e", BURNER_SOURCE, String(process.pid)],
            { stdio: "ignore" },
        );
        burner.on("error", (error) => finish(BROKEN, `cannot start burner ${i}: ${error.message}`));
        burner.on("exit", (code, signal) =>
            finish(
                BROKEN,
                `burner ${i} exited (${signal ?? `exit code ${code}`}) during the run: the overload is gone`,
            ),
        );
    }

    const run = spawn("taskset", ["-c", String(cpu), process.execPath, agentTest, ...wrapperArgs], {
        cwd: root,
        stdio: "inherit",
    });
    run.on("error", (error) => finish(BROKEN, `cannot start the run: ${error.message}`));
    run.on("close", (code, signal) => {
        if (code === 0) finish(0);
        else finish(1, `the run ended with ${signal ?? `exit code ${code}`}`);
    });
}

async function main() {
    const usage = (message) => {
        process.stderr.write(`[overload] ${message}\n`);
        process.exit(2);
    };

    if (process.platform !== "linux") {
        usage(`needs Linux (taskset and CPU affinity); this is ${process.platform}`);
    }

    // `--name value` or `--name=value`; returns the value and removes the option from `args`.
    function takeOption(args, name) {
        for (let i = 0; i < args.length; i++) {
            if (args[i] === name) {
                if (i + 1 >= args.length) usage(`${name} needs a value`);
                return args.splice(i, 2)[1];
            }
            if (args[i].startsWith(`${name}=`)) return args.splice(i, 1)[0].slice(name.length + 1);
        }
        return undefined;
    }

    function integer(name, value, min) {
        if (!/^\d+$/.test(value) || Number(value) < min) usage(`${name} must be an integer >= ${min}, got "${value}"`);
        return Number(value);
    }

    // The CPUs `taskset -pc <pid>` reports, e.g. "pid 42's current affinity list: 0-3,6".
    function allowedCpus() {
        const result = spawnSync("taskset", ["-pc", String(process.pid)], { encoding: "utf8" });
        if (result.error || result.status !== 0) {
            usage(`taskset failed (${result.error?.message ?? result.stderr.trim()}); install util-linux`);
        }
        const list = result.stdout.split(":").pop().trim();
        const cpus = [];
        for (const part of list.split(",")) {
            const [from, to = from] = part.split("-").map(Number);
            for (let cpu = from; cpu <= to; cpu++) cpus.push(cpu);
        }
        if (cpus.length === 0 || cpus.some(Number.isNaN)) usage(`cannot read the affinity list "${list}"`);
        return cpus;
    }

    // A bare `--` would put the options added below after Vitest's option terminator.
    const args = process.argv.slice(2).filter((arg) => arg !== "--");
    const runs = integer("--runs", takeOption(args, "--runs") ?? "3", 1);
    const testTimeoutOption = takeOption(args, "--testTimeout");
    const testTimeout = testTimeoutOption === undefined ? undefined : integer("--testTimeout", testTimeoutOption, 1);
    const cpuOption = takeOption(args, "--cpu");
    if (args.some((arg) => /^--max-?workers(=|$)/i.test(arg))) {
        usage(`--maxWorkers is fixed at ${MAX_WORKERS} (the reference overload)`);
    }
    const cpus = allowedCpus();
    const cpu = cpuOption === undefined ? cpus.at(-1) : integer("--cpu", cpuOption, 0);
    if (!cpus.includes(cpu)) usage(`--cpu ${cpu} is not in this process's affinity list (${cpus.join(",")})`);

    // `--no-rerun`: a failure under the overload is what this run looks for, so it must not be cleared
    // by the wrapper's rerun of failed files alone.
    const wrapperArgs = ["--force", "--no-rerun", ...args, `--maxWorkers=${MAX_WORKERS}`];
    if (testTimeout !== undefined) wrapperArgs.push(`--testTimeout=${testTimeout}`);

    let supervisor = null;
    let stopping = false;
    const killGroup = (signal) => {
        if (!supervisor?.pid) return;
        try {
            process.kill(-supervisor.pid, signal);
        } catch {
            // The group is empty.
        }
    };
    const running = () => supervisor !== null && supervisor.exitCode === null && supervisor.signalCode === null;

    process.on("exit", () => killGroup("SIGKILL"));
    for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ]) {
        process.on(signal, () => {
            if (stopping) return;
            stopping = true;
            log(`${signal}: stopping the run and the burners`);
            if (!running()) process.exit(code);
            // Let Vitest end on SIGTERM; the exit handler sends SIGKILL to whatever is left.
            killGroup("SIGTERM");
            const timer = setTimeout(() => process.exit(code), 3000);
            supervisor.once("close", () => {
                clearTimeout(timer);
                process.exit(code);
            });
        });
    }
    process.on("uncaughtException", (error) => {
        process.stderr.write(`[overload] ${error.stack ?? error}\n`);
        process.exit(2);
    });

    function runOnce() {
        return new Promise((done) => {
            supervisor = spawn(
                process.execPath,
                [self, "--supervise", JSON.stringify({ cpu, wrapperArgs, parent: process.pid })],
                // A new session and process group; stdin closed, since a background group must not read
                // the terminal; an IPC channel for the result.
                { cwd: root, detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] },
            );
            let result;
            supervisor.on("message", (message) => {
                result = message.code;
                killGroup("SIGKILL");
            });
            supervisor.on("error", (error) => {
                log(`cannot start the supervisor: ${error.message}`);
                done(BROKEN);
            });
            supervisor.on("close", (code, signal) => {
                killGroup("SIGKILL");
                if (stopping) return; // The signal handler exits.
                if (result === undefined)
                    log(`the supervisor ended without a result (${signal ?? `exit code ${code}`})`);
                done(result ?? BROKEN);
            });
        });
    }

    log(
        `CPU ${cpu}, ${BURNERS} burners, --maxWorkers=${MAX_WORKERS}, ` +
            `${testTimeout === undefined ? "default timeouts" : `--testTimeout=${testTimeout}`}, ${runs} run(s)` +
            `${args.length === 0 ? ", whole gated suite" : ""}`,
    );
    const failed = [];
    for (let run = 1; run <= runs; run++) {
        log(`run ${run}/${runs}`);
        const startedAt = Date.now();
        const code = await runOnce();
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (code === BROKEN) {
            log(`run ${run}/${runs} aborted after ${seconds} s: the overload broke, so no result counts`);
            process.exit(2);
        }
        if (code === 0) {
            log(`run ${run}/${runs} passed (${seconds} s)`);
        } else {
            failed.push(run);
            log(`run ${run}/${runs} FAILED (${seconds} s)`);
        }
    }
    if (failed.length > 0) {
        log(`${failed.length} of ${runs} run(s) failed: run ${failed.join(", run ")}`);
        process.exit(1);
    }
    log(`all ${runs} run(s) passed`);
}
