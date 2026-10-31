// @vitest-environment node
import * as fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    syncDir,
    syncDirSync,
    syncFile,
    writeFileDurable,
    writeFileDurableSync,
    type DurableFs,
} from "../data/durableWrite.ts";

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

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("asynchronous durable publication", () => {
    it("keeps the old file until the exclusive temporary file is flushed, then waits for the directory flush", async () => {
        const target = path.join(dir, "keys.json");
        fs.writeFileSync(target, "old");
        const fileSync = deferred<void>();
        const fileEntered = deferred<void>();
        const dirSync = deferred<void>();
        const dirEntered = deferred<void>();
        const operations: string[] = [];
        const api: DurableFs = {
            ...promises,
            async open(file, flags, mode) {
                const handle = await promises.open(file, flags, mode);
                const sync = handle.sync.bind(handle);
                if (file !== dir) {
                    expect(flags).toBe("wx");
                    expect(mode).toBe(0o600);
                    expect(file).not.toBe(target);
                }
                return Object.assign(handle, {
                    sync: async () => {
                        operations.push(file === dir ? "directory" : "file");
                        (file === dir ? dirEntered : fileEntered).resolve();
                        await (file === dir ? dirSync : fileSync).promise;
                        await sync();
                    },
                });
            },
            async rename(from, to) {
                operations.push("rename");
                await promises.rename(from, to);
            },
        };
        let answered = false;
        const writing = writeFileDurable(target, "new", { mode: 0o600, fs: api }).then(() => {
            answered = true;
        });
        try {
            await fileEntered.promise;
            expect(fs.readFileSync(target, "utf8")).toBe("old");
            expect(answered).toBe(false);
            fileSync.resolve();
            await dirEntered.promise;
            expect(fs.readFileSync(target, "utf8")).toBe("new");
            expect(operations).toEqual(["file", "rename", "directory"]);
            expect(answered).toBe(false);
        } finally {
            fileSync.resolve();
            dirSync.resolve();
            await writing;
        }
        expect(answered).toBe(true);
        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(dir)).toEqual(["keys.json"]);
    });

    it("cleans up only a temporary file it created and preserves the target after a failed write", async () => {
        const target = path.join(dir, "keys.json");
        const unrelated = path.join(dir, ".someone-elses.tmp");
        fs.writeFileSync(target, "old");
        fs.writeFileSync(unrelated, "keep");
        for (const phase of ["open", "sync", "rename"] as const) {
            let temporary = "";
            const error = failure(phase === "open" ? "EEXIST" : "EIO");
            const api: DurableFs = {
                ...promises,
                async open(file, flags, mode) {
                    temporary = file;
                    expect(flags).toBe("wx");
                    if (phase === "open") {
                        fs.writeFileSync(file, "owned by another writer");
                        throw error;
                    }
                    const handle = await promises.open(file, flags, mode);
                    if (phase === "sync")
                        Object.assign(handle, {
                            sync: async () => {
                                throw error;
                            },
                        });
                    return handle;
                },
                async rename(from, to) {
                    if (phase === "rename") throw error;
                    await promises.rename(from, to);
                },
            };
            await expect(writeFileDurable(target, "new", { fs: api }), phase).rejects.toBe(error);
            expect(fs.readFileSync(target, "utf8"), phase).toBe("old");
            expect(fs.readFileSync(unrelated, "utf8"), phase).toBe("keep");
            if (phase === "open") {
                expect(fs.readFileSync(temporary, "utf8")).toBe("owned by another writer");
                fs.unlinkSync(temporary);
            } else expect(fs.existsSync(temporary), phase).toBe(false);
        }
        expect(fs.readdirSync(dir).sort()).toEqual([".someone-elses.tmp", "keys.json"]);
    });

    it("tolerates EINVAL and EPERM only for the directory flush and rejects other durability failures", async () => {
        const target = path.join(dir, "keys.json");
        for (const directory of [true, false]) {
            for (const code of ["EINVAL", "EPERM", "EIO"]) {
                fs.writeFileSync(target, "old");
                const error = failure(code);
                const api: DurableFs = {
                    ...promises,
                    async open(file, flags, mode) {
                        const handle = await promises.open(file, flags, mode);
                        if ((file === dir) === directory)
                            Object.assign(handle, {
                                sync: async () => {
                                    throw error;
                                },
                            });
                        return handle;
                    },
                };
                const writing = writeFileDurable(target, "new", { fs: api });
                if (directory && code !== "EIO") await expect(writing).resolves.toBeUndefined();
                else await expect(writing).rejects.toBe(error);
                expect(fs.readFileSync(target, "utf8")).toBe(directory ? "new" : "old");
                expect(fs.readdirSync(dir)).toEqual(["keys.json"]);
            }
        }
    });
});
