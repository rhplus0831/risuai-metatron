import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { resolveStorageKey } from "../routes/storage.ts";
import type { ResourceTestClient } from "./testSupport.ts";

export function sweepClock() {
    let wall = Date.UTC(2030, 0, 20);
    let mono = 3_600_000;
    return {
        options: { wallClock: () => wall, monoClock: () => mono, graceMs: 1000 },
        advanceWall(ms = 1000) {
            wall += ms;
        },
        setMono(ms: number) {
            mono = ms;
        },
    };
}
export function seedSweepAsset(s: Pick<ResourceTestClient, "savePath">, key: string, bytes = "old bytes") {
    const file = resolveStorageKey(s.savePath, key)!;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    utimesSync(file, 1, 1);
    return file;
}
export async function matureSweep(s: ResourceTestClient, clock: ReturnType<typeof sweepClock>) {
    expect((await s.context.assetLifecycle.scan()).complete).toBe(true);
    clock.advanceWall();
    expect((await s.context.assetLifecycle.scan()).complete).toBe(true);
}
export function liveBytes(savePath: string) {
    const file = path.join(savePath, "data", "resources.sqlite");
    return [file, file + "-wal"].reduce((sum, name) => {
        try {
            return sum + statSync(name).size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return sum;
            throw error;
        }
    }, 0);
}
export const diskNeeded = (estimate: number) => Math.ceil(estimate + Math.max(64 * 1024 * 1024, estimate * 0.05));
export const diskWithFree = (free: number) => ({ bavail: free, bsize: 1, blocks: free });
