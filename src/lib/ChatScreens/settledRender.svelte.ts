import { untrack } from "svelte";
import { type ChatRef, chatHasUnackedWork, isChatGenerating } from "src/ts/storage/chatStore.svelte";

type Registration = { active: boolean; callback: () => void; dispose: () => void };
type WaitingChat = { ref: ChatRef; rows: Map<() => void, Registration> };

const waiting = new Map<string, WaitingChat>();
let registryVersion = $state(0);
let stopWatching: (() => void) | undefined;
let frame: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function settled(ref: ChatRef): boolean {
    return !chatHasUnackedWork(ref) && !isChatGenerating(ref);
}

function cancelDrain() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
}

function registryChanged() {
    untrack(() => {
        registryVersion += 1;
        if (waiting.size === 0) {
            stopWatching?.();
            stopWatching = undefined;
            cancelDrain();
        }
    });
}

function drain() {
    cancelDrain();
    const ready: Registration[] = [];
    for (const [key, chat] of waiting) {
        // Recheck after the effect: another edit or lock may have arrived before this frame.
        if (!settled(chat.ref)) continue;
        waiting.delete(key);
        ready.push(...chat.rows.values());
    }
    if (ready.length === 0) return;
    registryChanged();
    // Remove every settled chat's waits first, so a callback can register a new render safely.
    for (const row of ready) {
        if (!row.active) continue;
        row.active = false;
        row.callback();
    }
}

function scheduleDrain() {
    if (timer !== undefined) return;
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(drain);
    timer = setTimeout(drain, 16);
}

/**
 * Wait once for a chat with no unacknowledged work or locked messages. A mounted row uses the same
 * callback for repeated reports; its disposer permanently cancels this registration, even during a drain.
 */
export function waitForSettledRender(ref: ChatRef, callback: () => void): () => void {
    const key = JSON.stringify([ref.chaId, ref.chatId]);
    let chat = waiting.get(key);
    if (!chat) {
        chat = { ref: { ...ref }, rows: new Map() };
        waiting.set(key, chat);
    }
    const existing = chat.rows.get(callback);
    if (existing) return existing.dispose;
    const owner = chat;
    const row: Registration = {
        active: true,
        callback,
        dispose() {
            if (!row.active) return;
            row.active = false;
            owner.rows.delete(callback);
            if (owner.rows.size === 0 && waiting.get(key) === owner) waiting.delete(key);
            registryChanged();
        },
    };
    chat.rows.set(callback, row);
    registryChanged();
    stopWatching ??= $effect.root(() => {
        $effect(() => {
            void registryVersion;
            for (const chat of waiting.values()) {
                if (settled(chat.ref)) scheduleDrain();
            }
        });
    });
    return row.dispose;
}
