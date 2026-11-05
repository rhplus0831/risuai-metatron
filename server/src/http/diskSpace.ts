import { statfs } from "node:fs/promises";

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
