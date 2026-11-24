// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const fixture = "src/input.local";

function project() {
    const root = mkdtempSync(path.join(tmpdir(), "agent-test-cache-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "--quiet"], { cwd: root, env });

    const write = (file: string, text: string) => {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, text);
    };
    mkdirSync(path.join(root, "util/playwright"), { recursive: true });
    for (const file of [
        "agentTest.mjs",
        "agentTestResults.mjs",
        "agentE2e.mjs",
        "playwright/globalSetup.mjs",
        "playwright/stack.mjs",
        "typeCheckCache.mjs",
        "workingTree.mjs",
    ]) {
        copyFileSync(path.join(import.meta.dirname, file), path.join(root, "util", file));
    }
    write(".gitignore", "*.local\nnode_modules/\ndist/\nsave/\n");
    write(fixture, "pass");
    write("node_modules/vitest/package.json", JSON.stringify({ version: "1.0.0" }));
    write(
        "node_modules/vitest/vitest.mjs",
        `import { readFileSync, writeFileSync } from "node:fs";
        const value = readFileSync(${JSON.stringify(fixture)}, "utf8");
        if (process.env.AGENT_TEST_FIXTURE_MUTATE === "1") {
            writeFileSync(${JSON.stringify(fixture)}, "fail");
        }
        console.log(\`fixture result: \${value}\`);
        process.exitCode = value === "pass" ? 0 : 1;`,
    );
    const run = (mutate = false) =>
        spawnSync(
            process.execPath,
            ["util/agentTest.mjs", "input.test.ts", "--no-lock", "--no-rerun", "--maxWorkers=4"],
            {
                cwd: root,
                encoding: "utf8",
                env: { ...env, AGENT_TEST_FIXTURE_MUTATE: mutate ? "1" : "0" },
            },
        );
    return { run, write };
}

describe("the agent test result cache", () => {
    it("replays after unrelated ignored writes and reruns after an ignored source input changes", () => {
        const { run, write } = project();
        expect(run().status).toBe(0);

        for (const directory of ["node_modules", "dist", "save"]) write(`${directory}/unrelated`, "new content");
        const replay = run();
        expect(replay.status).toBe(0);
        expect(replay.stdout).toContain("[agent-test] cached result");

        write(fixture, "fail");
        const changed = run();
        expect(changed.status).toBe(1);
        expect(changed.stdout).toContain("fixture result: fail");
    });

    it("does not replay a result from a run whose ignored source input changed during execution", () => {
        const { run, write } = project();
        const mutated = run(true);
        expect(mutated.status).toBe(0);

        write(fixture, "pass");
        const restored = run();
        expect(restored.status).toBe(0);
        expect(restored.stdout).not.toContain("[agent-test] cached result");
        expect(mutated.stdout).toContain("cache inputs changed during the run, result was not saved");
    });
});
