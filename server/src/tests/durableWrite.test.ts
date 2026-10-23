// @vitest-environment node
import * as fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncDir, syncDirSync, syncFile, writeFileDurableSync } from "../data/durableWrite.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()) }));

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "risu-durable-write-"));
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("durable file publication", () => {
    it("flushes and closes unique temporary files before rename, then flushes the directory before returning", () => {
        const target = path.join(dir, "state.json");
        const events: string[] = [];
        const opened = new Map<number, string>();
        const temporaries: string[] = [];
        const { openSync, fsyncSync, closeSync, renameSync } = fs;
        vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
            const fd = openSync(file, flags, mode);
            opened.set(fd, String(file) === dir ? "directory" : "file");
            if (String(file) !== dir) {
                expect(flags).toBe("wx");
                expect(String(file)).not.toBe(target);
                temporaries.push(String(file));
            }
            return fd;
        });
        vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
            fsyncSync(fd);
            events.push(`${opened.get(fd)} sync`);
        });
        vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
            closeSync(fd);
            events.push(`${opened.get(fd)} close`);
        });
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
            renameSync(from, to);
            events.push("rename");
        });

        for (const content of ["first", "replacement"]) {
            writeFileDurableSync(target, content);
            events.push("returned");
            expect(events).toEqual([
                "file sync",
                "file close",
                "rename",
                "directory sync",
                "directory close",
                "returned",
            ]);
            expect(fs.readFileSync(target, "utf8")).toBe(content);
            expect(fs.readdirSync(dir)).toEqual(["state.json"]);
            events.length = 0;
        }
        expect(new Set(temporaries).size).toBe(2);
    });

    it("tolerates only EINVAL and EPERM from directory open or sync, in both APIs", async () => {
        for (const phase of ["open", "sync"] as const) {
            for (const code of ["EINVAL", "EPERM", "EIO"]) {
                const error = failure(code);
                const context = `${phase}: ${code}`;
                const handle = await promises.open(dir, "r");
                const close = vi.spyOn(handle, "close");
                const fd = fs.openSync(dir, "r");
                const closeSync = vi.spyOn(fs, "closeSync");
                vi.spyOn(promises, "open").mockImplementation(async () => {
                    if (phase === "open") throw error;
                    return handle;
                });
                vi.spyOn(fs, "openSync").mockImplementation(() => {
                    if (phase === "open") throw error;
                    return fd;
                });
                vi.spyOn(handle, "sync").mockRejectedValue(error);
                vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
                    throw error;
                });
                try {
                    if (code === "EIO") {
                        await expect(syncDir(dir), context).rejects.toBe(error);
                        expect(() => syncDirSync(dir), context).toThrow(error);
                    } else {
                        await expect(syncDir(dir), context).resolves.toBeUndefined();
                        expect(() => syncDirSync(dir), context).not.toThrow();
                    }
                    expect(close, context).toHaveBeenCalledTimes(phase === "sync" ? 1 : 0);
                    expect(closeSync, context).toHaveBeenCalledTimes(phase === "sync" ? 1 : 0);
                } finally {
                    vi.restoreAllMocks();
                    if (phase === "open") {
                        await handle.close();
                        fs.closeSync(fd);
                    }
                }
            }
        }
    });

    it("propagates every file sync error, closes the handle, and preserves the previous publication", async () => {
        const target = path.join(dir, "state.json");
        fs.writeFileSync(target, "previous");
        for (const code of ["EINVAL", "EPERM", "EIO"]) {
            const error = failure(code);
            const handle = await promises.open(target, "r+");
            const close = vi.spyOn(handle, "close");
            vi.spyOn(promises, "open").mockResolvedValue(handle);
            vi.spyOn(handle, "sync").mockRejectedValue(error);
            vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
                throw error;
            });
            const rename = vi.spyOn(fs, "renameSync");
            try {
                await expect(syncFile(target), code).rejects.toBe(error);
                expect(close, code).toHaveBeenCalledOnce();
                expect(() => writeFileDurableSync(target, "replacement"), code).toThrow(error);
                expect(rename, code).not.toHaveBeenCalled();
                expect(fs.readFileSync(target, "utf8"), code).toBe("previous");
                expect(fs.readdirSync(dir), code).toEqual(["state.json"]);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });
});
