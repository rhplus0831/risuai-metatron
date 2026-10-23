import type { ChatRef } from "../storage/chatStore.svelte";

const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;

/**
 * The chat screen's own sends by chat, each with the controller its Stop aborts: Stop in one chat
 * aborts that chat's send only. `has` is reactive (the Map is replaced on each change).
 */
export function createSendAborts() {
    let controllers: ReadonlyMap<string, AbortController> = $state.raw(new Map());

    /**
     * Registers a new controller for `ref`'s send and returns its signal and release. The release
     * removes the entry once, only while it is still that send's controller.
     */
    function begin(ref: ChatRef): { signal: AbortSignal; release: () => void } {
        const key = keyOf(ref);
        const controller = new AbortController();
        controllers = new Map(controllers).set(key, controller);
        let held = true;
        const release = () => {
            if (!held) {
                return;
            }
            held = false;
            if (controllers.get(key) === controller) {
                const next = new Map(controllers);
                next.delete(key);
                controllers = next;
            }
        };
        return { signal: controller.signal, release };
    }

    /** Whether a send of this screen runs in `ref`'s chat (reactive). */
    function has(ref: ChatRef | null): boolean {
        return ref !== null && controllers.has(keyOf(ref));
    }

    /** Aborts `ref`'s send of this screen, if one runs. */
    function abort(ref: ChatRef): void {
        controllers.get(keyOf(ref))?.abort();
    }

    return { begin, has, abort };
}
