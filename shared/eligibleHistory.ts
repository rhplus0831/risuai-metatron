import type { Message } from "./database.ts";

/**
 * Selects stored history for prompt assembly and context digests without mutating the input.
 * The last `allBefore` marker cuts off itself and everything earlier; a reset also tells callers
 * to omit a greeting they would otherwise add. Kept messages retain their chronological order.
 */

/**
 * The messages a send reads: from the end back to the last `allBefore` message (excluded), skipping
 * disabled ones. `reset` is true when an `allBefore` message cut the history (the greeting is then
 * left out too).
 */
export function eligibleHistory<T extends Pick<Message, "disabled">>(
    messages: readonly T[],
): { messages: T[]; reset: boolean } {
    const eligible: T[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.disabled === true) {
            continue;
        }
        if (message.disabled === "allBefore") {
            return { messages: eligible, reset: true };
        }
        eligible.unshift(message);
    }
    return { messages: eligible, reset: false };
}
