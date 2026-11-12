// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { programKeys } from "./changedChecks.mjs";
import { cachedRun, checkSettings, programKey, workingTreeFiles } from "./typeCheckCache.mjs";

const temporary: string[] = [];
function temporaryDirectory() {
    const dir = mkdtempSync(path.join(tmpdir(), "type-check-cache-"));
    temporary.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, text: string) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
}

const settings = { tools: ["typescript@5.9.3"], installed: "installed-1", rules: ["rules-1"] };
const tree = [
    { path: "src/App.svelte", id: "100644 a1" },
    { path: "server/src/main.ts", id: "100644 b1" },
    { path: "shared/session.ts", id: "100644 c1" },
    { path: "util/playwright/stack.mjs", id: "100644 d1" },
    { path: "e2e/fixtures.ts", id: "100644 e1" },
    { path: "docs/structure/app-shell.md", id: "100644 f1" },
];
const withFile = (file: string, id: string) => [...tree.filter((entry) => entry.path !== file), { path: file, id }];
const changedKeys = (files: typeof tree, other = settings) => {
    const before = programKeys(settings, tree);
    const after = programKeys(other, files);
    return (["client", "server", "e2e"] as const).filter((program) => before[program] !== after[program]);
};

describe("programKeys", () => {
    it("gives the three programs different keys for the same files", () => {
        const keys = programKeys(settings, tree);

        expect(new Set(Object.values(keys)).size).toBe(3);
    });

    it("keeps every key when a guide changes, is added, or is removed", () => {
        expect(changedKeys(withFile("docs/structure/app-shell.md", "100644 f2"))).toEqual([]);
        expect(changedKeys(withFile("docs/plan/new.md", "100644 g1"))).toEqual([]);
        expect(changedKeys(tree.filter((entry) => !entry.path.startsWith("docs/")))).toEqual([]);
    });

    it("changes only the keys of the programs that read the changed file", () => {
        expect(changedKeys(withFile("src/App.svelte", "100644 a2"))).toEqual(["client", "e2e"]);
        expect(changedKeys(withFile("server/src/main.ts", "100644 b2"))).toEqual(["client", "server"]);
        expect(changedKeys(withFile("shared/session.ts", "100644 c2"))).toEqual(["client", "server", "e2e"]);
        expect(changedKeys(withFile("util/playwright/stack.mjs", "100644 d2"))).toEqual(["e2e"]);
        expect(changedKeys(withFile("e2e/fixtures.ts", "100644 e2"))).toEqual(["e2e"]);
    });

    it("changes a key when a file the program reads is added, removed, renamed, or hidden by .gitignore", () => {
        expect(changedKeys(withFile("e2e/new.spec.ts", "100644 h1"))).toEqual(["e2e"]);
        expect(changedKeys(tree.filter((entry) => entry.path !== "e2e/fixtures.ts"))).toEqual(["e2e"]);
        expect(
            changedKeys([
                ...tree.filter((entry) => entry.path !== "e2e/fixtures.ts"),
                { path: "e2e/moved.ts", id: "100644 e1" },
            ]),
        ).toEqual(["e2e"]);
        expect(changedKeys(withFile("e2e/fixtures.ts", "ignored e1"))).toEqual(["e2e"]);
    });

    it("changes every key with a tool version, the installed packages, or a rule script", () => {
        const all = ["client", "server", "e2e"];

        expect(changedKeys(tree, { ...settings, tools: ["typescript@5.9.4"] })).toEqual(all);
        expect(changedKeys(tree, { ...settings, installed: "installed-2" })).toEqual(all);
        expect(changedKeys(tree, { ...settings, rules: ["rules-2"] })).toEqual(all);
    });
});

describe("programKey", () => {
    it("changes with the command line and not with the order of the files", () => {
        const reaches = () => true;
        const key = programKey(["typescript", "tsc", "-p", "e2e/tsconfig.json"], settings, tree, reaches);

        expect(
            programKey(["typescript", "tsc", "-p", "e2e/tsconfig.json"], settings, [...tree].reverse(), reaches),
        ).toBe(key);
        expect(
            programKey(["typescript", "tsc", "-p", "e2e/tsconfig.json", "--strict"], settings, tree, reaches),
        ).not.toBe(key);
    });
});

describe("workingTreeFiles", () => {
    const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    function repository() {
        const root = temporaryDirectory();
        git(root, "init", "--quiet");
        write(root, ".gitignore", "*.local\n");
        write(root, "src/tracked.ts", "export const a = 1;\n");
        git(root, "add", ".gitignore", "src/tracked.ts");
        return root;
    }
    const idOf = (root: string, file: string) => workingTreeFiles(root)?.files.find((entry) => entry.path === file)?.id;

    it("lists a tracked file by its content on disk and an untracked file, and leaves the index alone", () => {
        const root = repository();
        const staged = idOf(root, "src/tracked.ts");
        write(root, "src/tracked.ts", "export const a = 2;\n");
        write(root, "e2e/untracked.ts", "export const b = 1;\n");

        const listed = workingTreeFiles(root);

        expect(listed?.files.map((entry) => entry.path).sort()).toEqual([
            ".gitignore",
            "e2e/untracked.ts",
            "src/tracked.ts",
        ]);
        expect(idOf(root, "src/tracked.ts")).not.toBe(staged);
        expect(git(root, "status", "--porcelain")).toBe("A  .gitignore\nAM src/tracked.ts\n?? e2e/\n");
    });

    it("gives a different tree id for different content and the same one for the same content", () => {
        const root = repository();
        const first = workingTreeFiles(root)?.tree;
        write(root, "src/tracked.ts", "export const a = 2;\n");
        const second = workingTreeFiles(root)?.tree;
        write(root, "src/tracked.ts", "export const a = 1;\n");

        expect(second).not.toBe(first);
        expect(workingTreeFiles(root)?.tree).toBe(first);
    });

    it("lists a file .gitignore hides under a source root by its content, and not one outside the roots", () => {
        const root = repository();
        write(root, "src/hidden.local", "one\n");
        write(root, "notes.local", "one\n");
        const first = idOf(root, "src/hidden.local");
        write(root, "src/hidden.local", "two\n");

        expect(first).toMatch(/^ignored [0-9a-f]{40}$/);
        expect(idOf(root, "src/hidden.local")).toMatch(/^ignored [0-9a-f]{40}$/);
        expect(idOf(root, "src/hidden.local")).not.toBe(first);
        expect(idOf(root, "notes.local")).toBeUndefined();
    });

    it("is null outside a git checkout", () => {
        expect(workingTreeFiles(temporaryDirectory())).toBeNull();
    });
});

describe("checkSettings", () => {
    function installed(lock: string | null, typescript = "5.9.3") {
        const root = temporaryDirectory();
        for (const [name, version] of [
            ["typescript", typescript],
            ["svelte-check", "4.7.6"],
            ["svelte", "5.0.0"],
        ]) {
            write(root, `node_modules/${name}/package.json`, JSON.stringify({ version }));
        }
        if (lock !== null) write(root, "node_modules/.pnpm/lock.yaml", lock);
        return root;
    }

    it("names the installed tools and changes with the installed lockfile", () => {
        const first = checkSettings(installed("lockfileVersion: '9.0'\n"));

        expect(first?.tools).toEqual(["typescript@5.9.3", "svelte-check@4.7.6", "svelte@5.0.0"]);
        expect(checkSettings(installed("lockfileVersion: '9.0'\n"))).toEqual(first);
        expect(checkSettings(installed("lockfileVersion: '9.1'\n"))?.installed).not.toBe(first?.installed);
        expect(checkSettings(installed("lockfileVersion: '9.0'\n", "5.9.4"))?.tools[0]).toBe("typescript@5.9.4");
    });

    it("is null when nothing says what is installed, so no result is stored or replayed", () => {
        expect(checkSettings(installed(null))).toBeNull();
    });
});

describe("cachedRun", () => {
    const passed = { code: 0, output: "0 errors\n", seconds: 33.4 };
    const options = (
        dir: string | null,
        run: () => Promise<typeof passed | { code: null; output: string; seconds: number }>,
    ) => ({
        dir,
        key: "key-1" as string | null,
        force: false,
        run,
        unchanged: () => true,
        now: () => Date.parse("2026-11-12T12:00:00.000Z"),
    });

    it("runs on a miss, then replays the stored result without running", async () => {
        const dir = path.join(temporaryDirectory(), "cache");
        const run = vi.fn(async () => passed);

        expect(await cachedRun(options(dir, run))).toEqual({ ...passed, replayed: false });
        expect(await cachedRun(options(dir, run))).toEqual({
            ...passed,
            replayed: true,
            finishedAt: "2026-11-12T12:00:00.000Z",
        });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("stores a failure and replays it as a failure", async () => {
        const dir = temporaryDirectory();
        const failed = { code: 2, output: "a.ts(1,1): error TS2322\n", seconds: 3.5 };

        await cachedRun(options(dir, async () => failed));
        const run = vi.fn(async () => passed);

        expect(await cachedRun(options(dir, run))).toMatchObject({ ...failed, replayed: true });
        expect(run).not.toHaveBeenCalled();
    });

    it("runs for another key", async () => {
        const dir = temporaryDirectory();
        await cachedRun(options(dir, async () => passed));
        const run = vi.fn(async () => passed);

        expect(await cachedRun({ ...options(dir, run), key: "key-2" })).toMatchObject({ replayed: false });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("runs with force whatever is stored, and replaces the stored result", async () => {
        const dir = temporaryDirectory();
        await cachedRun(options(dir, async () => passed));
        const failed = { code: 1, output: "1 error\n", seconds: 30 };
        const run = vi.fn(async () => failed);

        expect(await cachedRun({ ...options(dir, run), force: true })).toEqual({ ...failed, replayed: false });
        expect(await cachedRun(options(dir, run))).toMatchObject({ ...failed, replayed: true });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("stores nothing for a run a signal ended or one the working tree changed under", async () => {
        const dir = temporaryDirectory();
        const killed = vi.fn(async () => ({ code: null, output: "", seconds: 1 }));
        const raced = vi.fn(async () => passed);

        await cachedRun(options(dir, killed));
        await cachedRun(options(dir, killed));
        await cachedRun({ ...options(dir, raced), unchanged: () => false });
        await cachedRun({ ...options(dir, raced), unchanged: () => false });

        expect(killed).toHaveBeenCalledTimes(2);
        expect(raced).toHaveBeenCalledTimes(2);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("runs every time and stores nothing without a cache directory or a key", async () => {
        const dir = temporaryDirectory();
        const run = vi.fn(async () => passed);

        await cachedRun(options(null, run));
        await cachedRun(options(null, run));
        await cachedRun({ ...options(dir, run), key: null });
        await cachedRun({ ...options(dir, run), key: null });

        expect(run).toHaveBeenCalledTimes(4);
        expect(readdirSync(dir)).toEqual([]);
    });

    it("runs when the stored file is damaged or holds another key's result", async () => {
        const dir = temporaryDirectory();
        const run = vi.fn(async () => passed);
        write(dir, "key-1.json", "{ not json");

        expect(await cachedRun(options(dir, run))).toMatchObject({ replayed: false });
        write(dir, "key-1.json", JSON.stringify({ key: "key-9", code: 0, output: "", seconds: 1 }));
        expect(await cachedRun(options(dir, run))).toMatchObject({ replayed: false });
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("deletes results older than fourteen days when it stores one", async () => {
        const dir = temporaryDirectory();
        const day = 24 * 60 * 60;
        const now = Date.parse("2026-11-12T12:00:00.000Z") / 1000;
        write(dir, "old.json", "{}");
        write(dir, "recent.json", "{}");
        utimesSync(path.join(dir, "old.json"), now - 15 * day, now - 15 * day);
        utimesSync(path.join(dir, "recent.json"), now - 13 * day, now - 13 * day);

        await cachedRun(options(dir, async () => passed));

        expect(readdirSync(dir).sort()).toEqual(["key-1.json", "recent.json"]);
    });
});
