// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetVerification } from "../http/assetVerification.ts";

let directory: string;
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "asset-verification-test-"));
});
afterEach(async () => {
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
