import path from "node:path";
import { stat, statfs } from "node:fs/promises";

const warnedPaths = new Set<string>();

/** Disk capacity available to this process (bavail, not privileged bfree); failures answer null and log once per path. */
export type DiskStatfs = (
    path: string,
) => Promise<{ bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }>;

export async function freeBytes(
    path: string,
    options: { statfs?: DiskStatfs } = {},
): Promise<{ free: number; total: number } | null> {
    try {
        const result = await (options.statfs ?? statfs)(path);
        return {
            free: Number(result.bavail) * Number(result.bsize),
            total: Number(result.blocks) * Number(result.bsize),
        };
    } catch (error) {
        if (!warnedPaths.has(path)) {
            warnedPaths.add(path);
            console.error(`[Server] Disk space unavailable for ${path}: ${String(error).replace(/[\r\n]+/g, " ")}`);
        }
        return null;
    }
}

/** A known space shortage; only this error maps to the backup routes' 507 response. */
export class InsufficientStorageError extends Error {
    readonly needed: number;
    readonly free: number;
    constructor(needed: number, free: number) {
        super("Insufficient Storage");
        this.name = "InsufficientStorageError";
        this.needed = needed;
        this.free = free;
    }
}

/** Remaining allocations plus 5% or 64 MiB of slack; unsupported statfs disables this guard. */
export async function ensureFreeSpace(
    directory: string,
    estimate: number,
    options: { statfs?: DiskStatfs } = {},
): Promise<void> {
    if (!Number.isFinite(estimate) || estimate < 0) throw new Error("Invalid disk space estimate");
    const disk = await freeBytes(directory, options);
    const needed = Math.ceil(estimate + Math.max(estimate * 0.05, 64 * 1024 * 1024));
    if (disk && disk.free < needed) throw new InsufficientStorageError(needed, disk.free);
}

/** Conservative backup size: committed data may still be in the WAL, not the main SQLite file. */
export async function liveDatabaseBytes(
    savePath: string,
    databaseFile = path.join(savePath, "data", "resources.sqlite"),
): Promise<number> {
    const sizes = await Promise.all(
        [databaseFile, databaseFile + "-wal"].map(async (file) => {
            try {
                return (await stat(file)).size;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
                throw error;
            }
        }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
}
