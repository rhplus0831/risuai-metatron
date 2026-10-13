// @vitest-environment node
/** @module-tag slow */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Request history slice 7 (`docs/plan/request-history-diagnostics.md`): the process hook `main.ts`
// installs, in a fresh plain `node` process (Vitest's own `uncaughtException` and
// `unhandledRejection` listeners would change what reaches the monitor). An
// `uncaughtExceptionMonitor` bound to the journal records the fault (its origin and class name, never
// its message) and writes `state.json` synchronously before Node ends the process as it would without
// the monitor: an uncaught exception and, with no `unhandledRejection` listener in the process, an
// unhandled rejection too, both with exit code 1.

const SERVER_SRC = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
// After both (the cases run concurrently).
afterAll(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/** A script wired as `main.ts` wires the monitor, which then faults in `mode`. */
function writeScript(root: string): string {
    const script = path.join(root, "crash.mjs");
    writeFileSync(
        script,
        `
import { createDiagnosticsJournal } from ${JSON.stringify(path.join(SERVER_SRC, "diagnostics/journal.ts"))};
import { errorFields } from ${JSON.stringify(path.join(SERVER_SRC, "diagnostics/log.ts"))};
const [dir, mode] = process.argv.slice(2);
const journal = createDiagnosticsJournal({ dir });
journal.start();
process.on("uncaughtExceptionMonitor", (error, origin) => {
    try {
        journal.record({ kind: "runtime", origin, ...errorFields(error) });
        journal.writeState();
    } catch {}
});
// Without the fault the process would end here with 3.
setTimeout(() => process.exit(3), 3000);
if (mode === "throw") {
    setTimeout(() => {
        throw new TypeError("the secret message");
    }, 10);
} else {
    Promise.reject(new RangeError("the secret rejection"));
}
`,
    );
    return script;
}

/** Runs the script with plain `node` (no flags, no `NODE_OPTIONS`): the default rejection mode. */
async function crash(mode: "throw" | "reject") {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-diagnostics-crash-"));
    roots.push(root);
    const dir = path.join(root, "diag");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [writeScript(root), dir, mode], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const [day] = readdirSync(path.join(dir, "events"));
    const text = readFileSync(path.join(dir, "events", day), "utf8");
    const events = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as Record<string, unknown>;
    return { code, stderr, text, events, state };
}

describe.concurrent("a fatal fault in a plain Node process", () => {
    it("records an uncaught exception and writes the state before the process exits with 1, the crash output unchanged", async ({
        expect,
    }) => {
        const { code, stderr, text, events, state } = await crash("throw");
        expect(code).toBe(1);
        expect(stderr).toContain("TypeError: the secret message");
        expect(events).toEqual([
            { at: expect.any(Number), kind: "runtime", origin: "uncaughtException", name: "TypeError", stack: [] },
        ]);
        expect(text).not.toContain("secret");
        expect(state).toMatchObject({ version: 1, node: process.versions.node, journal: { writeFailures: 0 } });
        expect(JSON.stringify(state)).not.toContain("secret");
    });

    it("records an unhandled rejection (origin `unhandledRejection`) the same way: no listener suppresses Node's default", async ({
        expect,
    }) => {
        const { code, stderr, text, events, state } = await crash("reject");
        expect(code).toBe(1);
        expect(stderr).toContain("RangeError: the secret rejection");
        expect(events).toEqual([
            { at: expect.any(Number), kind: "runtime", origin: "unhandledRejection", name: "RangeError", stack: [] },
        ]);
        expect(text).not.toContain("secret");
        expect(state).toMatchObject({ version: 1, journal: { writeFailures: 0 } });
    });
});
