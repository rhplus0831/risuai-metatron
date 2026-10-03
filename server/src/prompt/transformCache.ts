import type { TransformEmotion } from "../../../shared/transform.ts";

export type TransformCacheEntry = { text: string; emotions: TransformEmotion[] };

/** The keys whose "Re-render" generation is kept (the oldest is forgotten past this). */
const MAX_GENERATIONS = 4096;

const sizeOf = (entry: TransformCacheEntry) =>
    Buffer.byteLength(entry.text) +
    entry.emotions.reduce((sum, emotion) => sum + emotion.name.length + emotion.image.length, 0);

/**
 * The script transform's result cache (Phase 5 slice 13): an LRU of `entries` results and `bytes`
 * of text, a result over `entryBytes` not kept. A key has a generation: `invalidate` ("Re-render",
 * `noCache`) drops the entry and raises it, and a result computed under an older generation is not
 * stored (`set` with the generation read when its work began), so an older fill finishing late
 * cannot replace the newer one. A key without a generation of its own has the cache's floor; when
 * the oldest generations are forgotten (past `MAX_GENERATIONS`) or the cache is cleared, the floor
 * rises above every generation handed out, so no fill begun before can be stored. One cache per
 * process; `clear` empties it (a new epoch).
 */
export function createTransformCache(
    limits: { entries: number; bytes: number; entryBytes: number } = {
        entries: 512,
        bytes: 16 * 1024 * 1024,
        entryBytes: 512 * 1024,
    },
) {
    const entries = new Map<string, { entry: TransformCacheEntry; size: number }>();
    const generations = new Map<string, number>();
    /** The generation of a key without one of its own. */
    let floor = 0;
    /** The highest generation handed out. */
    let highest = 0;
    let bytes = 0;
    const generationOf = (key: string) => generations.get(key) ?? floor;
    /** Forgets every key's generation: the floor rises above all of them. */
    const raiseFloor = () => {
        highest++;
        floor = highest;
        generations.clear();
    };

    const remove = (key: string) => {
        const found = entries.get(key);
        if (found) {
            entries.delete(key);
            bytes -= found.size;
        }
    };

    return {
        get(key: string): TransformCacheEntry | undefined {
            const found = entries.get(key);
            if (!found) {
                return undefined;
            }
            entries.delete(key);
            entries.set(key, found);
            return found.entry;
        },
        generation: generationOf,
        invalidate(key: string): void {
            remove(key);
            if (generations.size >= MAX_GENERATIONS && !generations.has(key)) {
                // Forgetting one key's generation would let a fill begun under it be stored: all go at once.
                raiseFloor();
            }
            highest++;
            generations.delete(key);
            generations.set(key, highest);
        },
        /** Stores `entry` unless the key's generation moved on since `generation` was read. */
        set(key: string, entry: TransformCacheEntry, generation: number): boolean {
            if (generationOf(key) !== generation) {
                return false;
            }
            const size = sizeOf(entry);
            remove(key);
            if (size > limits.entryBytes) {
                return false;
            }
            entries.set(key, { entry, size });
            bytes += size;
            while (entries.size > limits.entries || bytes > limits.bytes) {
                remove(entries.keys().next().value as string);
            }
            return true;
        },
        clear(): void {
            entries.clear();
            raiseFloor();
            bytes = 0;
        },
        get size() {
            return entries.size;
        },
    };
}

export type TransformCache = ReturnType<typeof createTransformCache>;
