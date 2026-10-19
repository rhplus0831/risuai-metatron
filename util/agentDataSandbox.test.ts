// @vitest-environment node
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentDataSandboxMode, prepareAgentDataSandbox } from "./agentDataSandbox.mjs";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function tempRoot() {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-sandbox-test-"));
    roots.push(root);
    return root;
}

function write(file: string, content: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}

/** A `save/` with every kind of entry the clone copies or leaves behind; the database stays open in WAL mode. */
function makeSource(root: string) {
    const source = path.join(root, "save");
    mkdirSync(path.join(source, "data"), { recursive: true });
    const db = new DatabaseSync(path.join(source, "data", "resources.sqlite"));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
    const vectors = new DatabaseSync(path.join(source, "data", "vectors.sqlite"));
    vectors.exec("CREATE TABLE v (x INTEGER); INSERT INTO v VALUES (7);");
    vectors.close();
    write(path.join(source, "data", "request-history.sqlite"), "history");
    write(path.join(source, "assets", "a.png"), "image a");
    write(path.join(source, "assets", "nested", "b.png"), "image b");
    write(path.join(source, "server", "password"), "digest");
    write(path.join(source, "server", "web_push_vapid.json"), "{}");
    write(path.join(source, "backups", "snapshot.bin"), "backup");
    write(path.join(source, "diagnostics", "state.json"), "{}");
    write(path.join(source, "models", "transformers", "model.bin"), "model");
    write(path.join(source, "loose.risum"), "loose");
    return { source, db };
}

describe("parseAgentDataSandboxMode", () => {
    it("defaults to clone and accepts the three modes in any case", () => {
        expect(parseAgentDataSandboxMode(undefined)).toBe("clone");
        expect(parseAgentDataSandboxMode(" ")).toBe("clone");
        expect(parseAgentDataSandboxMode("KEEP")).toBe("keep");
        expect(parseAgentDataSandboxMode(" fresh ")).toBe("fresh");
    });

    it("refuses anything else", () => {
        expect(() => parseAgentDataSandboxMode("copy")).toThrow("Invalid RISU_AGENT_DATA_MODE: copy");
    });
});

describe("prepareAgentDataSandbox", () => {
    it("clones the databases and links the assets, leaving auth, backups, and diagnostics behind", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        const sandbox = path.join(root, "save-agent");
        try {
            const summary = await prepareAgentDataSandbox({ sourceDir: source, sandboxDir: sandbox, mode: "clone" });
            expect(summary).toContain("data/resources.sqlite");
            expect(summary).toContain("assets/ (2 files)");
        } finally {
            db.close();
        }

        // Listed before the copies are opened below: opening a WAL database adds its -wal and -shm files.
        expect(readdirSync(sandbox).sort()).toEqual(["assets", "data"]);
        expect(readdirSync(path.join(sandbox, "data")).sort()).toEqual(["resources.sqlite", "vectors.sqlite"]);
        // Nothing is left beside the sandbox.
        expect(readdirSync(root).sort()).toEqual(["save", "save-agent"]);

        const copy = new DatabaseSync(path.join(sandbox, "data", "resources.sqlite"), { readOnly: true });
        expect(copy.prepare("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
        copy.close();
        const vectors = new DatabaseSync(path.join(sandbox, "data", "vectors.sqlite"), { readOnly: true });
        expect(vectors.prepare("SELECT x FROM v").all()).toEqual([{ x: 7 }]);
        vectors.close();

        expect(readFileSync(path.join(sandbox, "assets", "nested", "b.png"), "utf8")).toBe("image b");
        expect(statSync(path.join(sandbox, "assets", "a.png")).ino).toBe(
            statSync(path.join(source, "assets", "a.png")).ino,
        );
    });

    it("replaces an existing sandbox on clone and keeps it on keep", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        const sandbox = path.join(root, "save-agent");
        write(path.join(sandbox, "marker"), "old");

        expect(await prepareAgentDataSandbox({ sourceDir: source, sandboxDir: sandbox, mode: "keep" })).toContain(
            "kept the existing sandbox",
        );
        expect(existsSync(path.join(sandbox, "marker"))).toBe(true);

        await prepareAgentDataSandbox({ sourceDir: source, sandboxDir: sandbox, mode: "clone" });
        expect(existsSync(path.join(sandbox, "marker"))).toBe(false);
        expect(existsSync(path.join(sandbox, "data", "resources.sqlite"))).toBe(true);
        expect(readdirSync(root).sort()).toEqual(["save", "save-agent"]);
    });

    it("clones on keep when there is no sandbox yet", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        const sandbox = path.join(root, "save-agent");
        await prepareAgentDataSandbox({ sourceDir: source, sandboxDir: sandbox, mode: "keep" });
        expect(existsSync(path.join(sandbox, "data", "resources.sqlite"))).toBe(true);
    });

    it("starts empty on fresh and when the source does not exist", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        const sandbox = path.join(root, "save-agent");
        write(path.join(sandbox, "marker"), "old");
        expect(await prepareAgentDataSandbox({ sourceDir: source, sandboxDir: sandbox, mode: "fresh" })).toContain(
            "created an empty sandbox",
        );
        expect(readdirSync(sandbox)).toEqual([]);

        const other = path.join(root, "other-agent");
        await prepareAgentDataSandbox({ sourceDir: path.join(root, "missing"), sandboxDir: other, mode: "clone" });
        expect(readdirSync(other)).toEqual([]);
    });

    it("refuses a sandbox inside the source, a source inside the sandbox, and the same directory", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        for (const [sourceDir, sandboxDir] of [
            [source, path.join(source, "agent")],
            [path.join(root, "outer", "save"), path.join(root, "outer")],
            [source, source],
        ]) {
            await expect(prepareAgentDataSandbox({ sourceDir, sandboxDir, mode: "clone" })).rejects.toThrow(
                "must be apart from the source directory",
            );
        }
        expect(readdirSync(source).sort()).toEqual([
            "assets",
            "backups",
            "data",
            "diagnostics",
            "loose.risum",
            "models",
            "server",
        ]);
    });

    it("refuses a sandbox reached through a symbolic link into the source", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        symlinkSync(source, path.join(root, "alias"), "dir");
        await expect(
            prepareAgentDataSandbox({
                sourceDir: source,
                sandboxDir: path.join(root, "alias", "agent"),
                mode: "clone",
            }),
        ).rejects.toThrow("must be apart from the source directory");
    });

    it("refuses a symbolic-link or non-directory sandbox", async () => {
        const root = tempRoot();
        const { source, db } = makeSource(root);
        db.close();
        const target = path.join(root, "elsewhere");
        mkdirSync(target);
        symlinkSync(target, path.join(root, "linked-agent"), "dir");
        await expect(
            prepareAgentDataSandbox({ sourceDir: source, sandboxDir: path.join(root, "linked-agent"), mode: "clone" }),
        ).rejects.toThrow("must not be a symbolic link");

        write(path.join(root, "file-agent"), "x");
        await expect(
            prepareAgentDataSandbox({ sourceDir: source, sandboxDir: path.join(root, "file-agent"), mode: "clone" }),
        ).rejects.toThrow("must be a directory");
    });
});
