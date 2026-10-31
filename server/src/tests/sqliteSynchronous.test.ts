// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestServer, TEST_INDEX_HTML } from "./testSupport.ts";

const servers: ReturnType<typeof createTestServer>[] = [];
const dirs: string[] = [];

afterEach(async () => {
    try {
        await Promise.all(servers.splice(0).map((server) => server.context.dispose()));
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

function serverRoot() {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-sqlite-synchronous-"));
    dirs.push(rootDir);
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    return rootDir;
}

describe("RISU_SQLITE_SYNCHRONOUS", () => {
    it.each([
        { label: "normal", value: "normal", expected: 1 },
        { label: "unset", value: undefined, expected: 2 },
        { label: "empty", value: "", expected: 2 },
        { label: "full", value: "full", expected: 2 },
    ])(
        "selects resource durability for $label while history, vectors and generation receipts stay NORMAL",
        ({ value, expected }) => {
            vi.stubEnv("RISU_SQLITE_SYNCHRONOUS", value);
            const connections = new Map<string, DatabaseSync>();
            const exec = DatabaseSync.prototype.exec;
            vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
                const databases = this.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
                const main = databases.find((database) => database.name === "main");
                if (main) {
                    connections.set(main.file, this);
                }
                return exec.call(this, sql);
            });

            const server = createTestServer({ rootDir: serverRoot() });
            servers.push(server);
            for (const [name, synchronous] of [
                ["resources", expected],
                ["request-history", 1],
                ["vectors", 1],
                ["generation-jobs", 1],
            ] as const) {
                const file = path.join(server.savePath, "data", `${name}.sqlite`);
                expect(connections.get(file)?.prepare("PRAGMA synchronous").get(), file).toEqual({ synchronous });
            }
        },
    );

    it.each(["off", "NORMAL"])(
        "refuses %s before creating resources.sqlite and names RISU_SQLITE_SYNCHRONOUS",
        (value) => {
            vi.stubEnv("RISU_SQLITE_SYNCHRONOUS", value);
            const rootDir = serverRoot();
            expect(() => {
                const server = createTestServer({ rootDir });
                servers.push(server);
            }).toThrow(/RISU_SQLITE_SYNCHRONOUS/);
            expect(existsSync(path.join(rootDir, "save", "data", "resources.sqlite"))).toBe(false);
        },
    );
});
