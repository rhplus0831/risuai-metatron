/**
 * Client-local switches of the Phase 5 server pipeline, kept in this browser's `localStorage`
 * (not the database: each tab of this browser reads the same value, other browsers their own) and
 * removed at the cutover. Off by default; a storage that cannot be read reads as off.
 *
 * - `risu.serverGeneration`: the generation path through server jobs (slices 8a to 12; Lua buttons
 *   from 8a).
 * - `risu.serverTransform`: message rendering through the server transform (slice 13).
 */
export type ClientFlag = "risu.serverGeneration" | "risu.serverTransform";

export function readClientFlag(flag: ClientFlag): boolean {
    try {
        return localStorage.getItem(flag) === "1";
    } catch {
        return false;
    }
}

export function writeClientFlag(flag: ClientFlag, on: boolean): void {
    try {
        if (on) {
            localStorage.setItem(flag, "1");
        } else {
            localStorage.removeItem(flag);
        }
    } catch {
        // A storage that cannot be written keeps the flag as it was.
    }
}
