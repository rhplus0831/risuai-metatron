import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Some filesystems refuse directory flushing, including Windows mounts with read-only handles. */
function refusesDirectorySync(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EINVAL" || code === "EPERM";
}

/** Flushes directory entries; only EINVAL/EPERM from opening or syncing the directory are tolerated. */
export async function syncDir(dir: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
        handle = await fs.open(dir, "r");
        await handle.sync();
    } catch (error) {
        if (!refusesDirectorySync(error)) {
            throw error;
        }
    } finally {
        await handle?.close();
    }
}

/** Synchronous directory flush, with the same directory-only refusals as `syncDir`. */
export function syncDirSync(dir: string): void {
    let fd = -1;
    try {
        fd = openSync(dir, "r");
        fsyncSync(fd);
    } catch (error) {
        if (!refusesDirectorySync(error)) {
            throw error;
        }
    } finally {
        if (fd >= 0) {
            closeSync(fd);
        }
    }
}

/** Flushes an already-written file without truncating it; Windows requires a writable handle. */
export async function syncFile(file: string): Promise<void> {
    const handle = await fs.open(file, "r+");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** The existing parent, then every directory a recursive mkdir created, down to its target. */
function createdDirectories(dir: string, first: string): string[] {
    const parent = path.dirname(path.resolve(first));
    const directories = [path.resolve(dir)];
    while (directories[directories.length - 1] !== parent) {
        directories.push(path.dirname(directories[directories.length - 1]));
    }
    return directories.reverse();
}

/** Creates a directory tree and flushes its new entries; an existing tree needs no syncs. */
export async function mkdirDurable(dir: string): Promise<void> {
    const first = await fs.mkdir(dir, { recursive: true });
    if (first !== undefined) {
        for (const directory of createdDirectories(dir, first)) {
            await syncDir(directory);
        }
    }
}

/** Synchronous durable directory creation, for synchronous publication paths. */
export function mkdirDurableSync(dir: string): void {
    const first = mkdirSync(dir, { recursive: true });
    if (first !== undefined) {
        for (const directory of createdDirectories(dir, first)) {
            syncDirSync(directory);
        }
    }
}

/**
 * Writes through an exclusive temporary file, flushes and closes it, then renames and syncs the
 * target directory. `tempDir` defaults to beside the target and must be on the same filesystem.
 * The caller creates the directories; a failed write removes only the temporary file it created.
 */
export function writeFileDurableSync(
    file: string,
    data: string | Uint8Array,
    options: { tempDir?: string; mode?: number } = {},
): void {
    const dir = path.dirname(file);
    const temp = path.join(options.tempDir ?? dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", options.mode);
    try {
        try {
            writeFileSync(fd, data);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, file);
    } catch (error) {
        try {
            rmSync(temp, { force: true });
        } catch {}
        throw error;
    }
    syncDirSync(dir);
}
