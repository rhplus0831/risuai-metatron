import { type ChatRef, currentChatRef, findChat } from "../storage/chatStore.svelte";

/** A reply's reroll candidates: the one it shows (`index`), and the chat and message it was generated in. */
type Candidates = { values: string[]; index: number; ref: ChatRef; messageId: string };

const rerolls = new Map<string, Candidates>();

/**
 * The selected chat's candidates of generation `genId` with the reply's current text stored into the
 * candidate it shows, so an edit made since the last swap is what swapping back to that candidate
 * brings. Null when the selected chat is not the one the reply was generated in (a copied chat keeps
 * the reply's ids and generation) or the reply there is gone or carries another generation.
 */
function currentCandidates(genId: string): Candidates | null {
    const entry = rerolls.get(genId);
    const ref = currentChatRef();
    if (!entry || !ref || ref.chaId !== entry.ref.chaId || ref.chatId !== entry.ref.chatId) {
        return null;
    }
    const message = findChat(ref)?.message.find((candidate) => candidate.chatId === entry.messageId);
    if (message?.generationInfo?.generationId !== genId) {
        return null;
    }
    entry.values[entry.index] = message.data;
    return entry;
}

/**
 * Swaps to the next candidate of `entry` in direction `step`, an empty one included (the screen
 * applies any candidate that is not null, so a reply emptied by an edit is reachable). Null at the end.
 */
function swapFrom(entry: Candidates, step: 1 | -1) {
    const index = entry.index + step;
    if (index < 0 || index >= entry.values.length) {
        return null;
    }
    entry.index = index;
    return entry.values[index];
}

export function Prereroll(genId: string) {
    const entry = currentCandidates(genId);
    return entry ? swapFrom(entry, 1) : null;
}
export function PreUnreroll(genId: string) {
    const entry = currentCandidates(genId);
    return entry ? swapFrom(entry, -1) : null;
}

/** The reroll alternatives of reply `messageId` in `ref`; the reply shows the first. */
export function addRerolls(genId: string, values: string[], ref: ChatRef, messageId: string) {
    rerolls.set(genId, { values: [...values], index: 0, ref: { chaId: ref.chaId, chatId: ref.chatId }, messageId });
}
