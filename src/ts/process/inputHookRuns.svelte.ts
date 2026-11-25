import type { ChatRef } from "../storage/chatStore.svelte";

/**
 * Tracks this chat screen's input hook runs by stable chat ref. Each chat has at most one run;
 * ending it removes only that run. Stop controllers belong to `sendAborts.svelte.ts`.
 */

export type InputHookRunKind = "draft" | "btw";

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;

/** The screen's hook runs by chat, with a reactive kind (the Map is replaced on each change). */
export function createInputHookRuns() {
    let runs: ReadonlyMap<string, { kind: InputHookRunKind }> = $state.raw(new Map());

    /** Reserves this chat unless a hook already runs there; `end` releases only this reservation once. */
    function begin(ref: ChatRef, kind: InputHookRunKind): { end: () => void } | null {
        const key = keyOf(ref);
        if (runs.has(key)) {
            return null;
        }
        const run = { kind };
        runs = new Map(runs).set(key, run);
        let held = true;
        const end = () => {
            if (!held) {
                return;
            }
            held = false;
            if (runs.get(key) === run) {
                const next = new Map(runs);
                next.delete(key);
                runs = next;
            }
        };
        return { end };
    }

    /** The kind of hook running in this chat, or null (reactive). */
    function kindOf(ref: ChatRef | null): InputHookRunKind | null {
        return ref === null ? null : (runs.get(keyOf(ref))?.kind ?? null);
    }

    return { begin, kindOf };
}
