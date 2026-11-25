// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetVerification } from "../http/assetVerification.ts";

let directory: string;
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "asset-verification-test-"));
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function file(bytes: string) {
    const fullPath = path.join(directory, `${sha256(bytes)}.png`);
    await fs.writeFile(fullPath, bytes);
    return { fullPath, stat: await fs.stat(fullPath, { bigint: true }), hash: sha256(bytes) };
}

describe("asset verification queue", () => {
    it("hashes one file at a time and records a result for every accepted file", async () => {
        const files = await Promise.all([file("first"), file("second"), file("third")]);
        const started = files.map(() => deferred<string>());
        const release = files.map(() => deferred<void>());
        let active = 0;
        let maxActive = 0;
        let calls = 0;
        const verification = new AssetVerification({
            maxPending: files.length,
            hasher: async (handle) => {
                const call = calls++;
                active += 1;
                maxActive = Math.max(maxActive, active);
                try {
                    const bytes = await handle.readFile("utf8");
                    started[call].resolve(bytes);
                    await release[call].promise;
                    return sha256(bytes);
                } finally {
                    active -= 1;
                }
            },
        });
        // A mismatching digest must also get a recorded result, rather than being silently dropped.
        const expectedHashes = [files[0].hash, sha256("different bytes"), files[2].hash];
        try {
            expect(verification.request(files[0].fullPath, expectedHashes[0])).toBe(true);
            await started[0].promise;
            for (let i = 1; i < files.length; i++) {
                expect(verification.request(files[i].fullPath, expectedHashes[i])).toBe(true);
            }
            const hashed: string[] = [];
            for (let i = 0; i < files.length; i++) {
                hashed.push(await started[i].promise);
                expect(active).toBe(1);
                release[i].resolve();
            }
            await verification.idle();
            expect(maxActive).toBe(1);
            expect(hashed.sort()).toEqual(["first", "second", "third"]);
            expect(files.map(({ fullPath, stat }) => verification.lookupVerification(fullPath, stat))).toEqual([
                "verified",
                "mismatch",
                "verified",
            ]);
        } finally {
            release.forEach((gate) => gate.resolve());
            await verification.idle();
        }
    });

    it("refuses a full queue without dropping accepted files and accepts the refused file after draining", async () => {
        const files = await Promise.all([file("accepted one"), file("accepted two"), file("retry later")]);
        const started = deferred<void>();
        const release = deferred<void>();
        const hashed: string[] = [];
        const verification = new AssetVerification({
            maxPending: 2,
            hasher: async (handle) => {
                const bytes = await handle.readFile("utf8");
                hashed.push(bytes);
                started.resolve();
                await release.promise;
                return sha256(bytes);
            },
        });
        try {
            expect(verification.request(files[0].fullPath, files[0].hash)).toBe(true);
            await started.promise;
            expect(verification.request(files[1].fullPath, files[1].hash)).toBe(true);
            expect(verification.request(files[2].fullPath, files[2].hash)).toBe(false);
            release.resolve();
            await verification.idle();
            expect(hashed.sort()).toEqual(["accepted one", "accepted two"]);
            for (const { fullPath, stat } of files.slice(0, 2)) {
                expect(verification.lookupVerification(fullPath, stat)).toBe("verified");
            }
            expect(verification.lookupVerification(files[2].fullPath, files[2].stat)).toBe("unknown");
            expect(verification.request(files[2].fullPath, files[2].hash)).toBe(true);
            await verification.idle();
            expect(verification.lookupVerification(files[2].fullPath, files[2].stat)).toBe("verified");
            expect(hashed.sort()).toEqual(["accepted one", "accepted two", "retry later"]);
        } finally {
            release.resolve();
            await verification.idle();
        }
    });
});

describe("awaited asset verification", () => {
    it.each([
        { label: "the default concurrency of four", concurrency: undefined, limit: 4 },
        { label: "an injected concurrency of two", concurrency: 2, limit: 2 },
    ])("awaits hashes with $label", async ({ concurrency, limit }) => {
        const files = await Promise.all(Array.from({ length: 6 }, (_, i) => file(`content-${i}`)));
        // Pre-open the file handles and make admission I/O immediately resolved. Draining virtual
        // timers then drains every admission continuation up to the held hashes, without racing disk I/O.
        const handles = await Promise.all(files.map(({ fullPath }) => fs.open(fullPath, "r")));
        const open = fs.open.bind(fs);
        for (const [index, handle] of handles.entries()) {
            const stat = handle.stat.bind(handle);
            vi.spyOn(handle, "stat").mockImplementation((options) =>
                options?.bigint ? Promise.resolve(files[index].stat) : stat(options),
            );
        }
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const index = files.findIndex(({ fullPath }) => fullPath === args[0]);
            return index < 0 ? open(...args) : handles[index];
        });
        vi.useFakeTimers();
        const started = files.map(() => deferred<void>());
        const release = files.map(() => deferred<void>());
        let active = 0;
        let maximum = 0;
        let calls = 0;
        let settled = false;
        const verification = new AssetVerification();
        const result = verification.verifyFiles(
            files.map(({ fullPath, hash }) => ({ fullPath, expectedHex: hash })),
            {
                concurrency,
                hasher: async (handle) => {
                    const index = calls++;
                    active++;
                    maximum = Math.max(maximum, active);
                    started[index].resolve();
                    try {
                        await release[index].promise;
                        return sha256(await handle.readFile("utf8"));
                    } finally {
                        active--;
                    }
                },
            },
        );
        void result.then(() => {
            settled = true;
        });
        try {
            await Promise.all(started.slice(0, limit).map((gate) => gate.promise));
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);
            expect(maximum).toBe(limit);
            for (let i = 0; i < files.length; i++) {
                await started[i].promise;
                release[i].resolve();
            }
            expect(await result).toEqual(new Set(files.map(({ fullPath }) => fullPath)));
            expect(maximum).toBe(limit);
        } finally {
            release.forEach((gate) => gate.resolve());
            await result;
        }
    });

    it("reserves the read budget in name order and does not refund completed hashes", async () => {
        const files = await Promise.all([file("aaaa"), file("bbbb"), file("ccc"), file("d")]);
        const started = deferred<void>();
        const release = deferred<void>();
        const hashed: string[] = [];
        const verification = new AssetVerification();
        const inputs = files.map(({ fullPath, hash }) => ({ fullPath, expectedHex: hash }));
        const result = verification.verifyFiles(inputs, {
            concurrency: 1,
            readBudgetBytes: 7,
            hasher: async (handle, size) => {
                const bytes = await handle.readFile("utf8");
                expect(size).toBe(Buffer.byteLength(bytes));
                hashed.push(bytes);
                started.resolve();
                await release.promise;
                return sha256(bytes);
            },
        });
        try {
            await started.promise;
            release.resolve();
            expect(await result).toEqual(new Set([files[0].fullPath, files[2].fullPath]));
            expect(hashed).toEqual(["aaaa", "ccc"]);
            // Fresh-stat answers need no read budget, but a replaced file must be checked again.
            const hasher = async () => {
                throw new Error("cached file was hashed");
            };
            expect(await verification.verifyFiles(inputs, { readBudgetBytes: 0, hasher })).toEqual(
                new Set([files[0].fullPath, files[2].fullPath]),
            );
            const replacement = path.join(directory, "replacement");
            await fs.writeFile(replacement, "aaaa");
            await fs.rename(replacement, files[0].fullPath);
            expect(await verification.verifyFiles(inputs, { readBudgetBytes: 0, hasher })).toEqual(
                new Set([files[2].fullPath]),
            );
        } finally {
            release.resolve();
            await result;
        }
    });

    it.each(["record", "forget", "replace"])("does not report a file present after a concurrent %s", async (change) => {
        const original = await file("original");
        const started = deferred<void>();
        const release = deferred<void>();
        const verification = new AssetVerification();
        const result = verification.verifyFiles([{ fullPath: original.fullPath, expectedHex: original.hash }], {
            hasher: async (handle) => {
                const digest = sha256(await handle.readFile("utf8"));
                started.resolve();
                await release.promise;
                return digest;
            },
        });
        try {
            await started.promise;
            if (change === "record") verification.recordVerification(original.fullPath, original.stat, false);
            if (change === "forget") verification.forgetVerification(original.fullPath);
            if (change === "replace") {
                const replacement = path.join(directory, "replacement");
                await fs.writeFile(replacement, "replaced");
                await fs.rename(replacement, original.fullPath);
            }
            release.resolve();
            expect(await result).toEqual(new Set());
        } finally {
            release.resolve();
            await result;
        }
    });
});
