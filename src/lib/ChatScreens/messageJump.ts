/**
 * The chat screen's jump to a message by id (archived `docs/plan/search.md` slice 4b): the decisions of
 * `DefaultChatScreen.svelte`'s `scrollToMessageId`, with the component's state and DOM injected so
 * they can be tested without mounting the screen. Every await is followed by an ownership check and a
 * fresh lookup of the message by its id (D1): the index is never kept across an await.
 */

/** Rows rendered past the target, as `scrollToMessage` loads them (the context above it). */
export const MESSAGE_JUMP_MARGIN = 5;
/** How many times the jump re-plans after the chat changed under it before it gives up. */
export const MESSAGE_JUMP_ROUNDS = 5;
/** The row scrolled to first, before images settle: a few messages before the target. */
const PRE_SCROLL_ROWS = 3;

/**
 * The window that shows message `index`. `Chats.svelte` renders `length - 1` down to
 * `length - loadPages`, or, while folded at `folded`, `folded` down to `folded - loadPages`; a target
 * above the fold clears it, keeping the rows shown so far (`loadPages + length - folded`, as the
 * chat screen's show-all button does). The window only grows.
 */
export function messageJumpWindow(arg: { length: number; index: number; loadPages: number; folded: number }): {
    clearFold: boolean;
    loadPages: number;
} {
    const { length, index, loadPages, folded } = arg;
    if (folded !== -1 && index <= folded) {
        return { clearFold: false, loadPages: Math.max(loadPages, folded - index + MESSAGE_JUMP_MARGIN) };
    }
    const kept = folded !== -1 ? loadPages + length - folded : loadPages;
    return { clearFold: folded !== -1, loadPages: Math.max(kept, length - index + MESSAGE_JUMP_MARGIN) };
}

export type MessageJumpOutcome = "done" | "gone" | "stopped";

export interface MessageJumpDeps {
    /** The jump still owns the screen: its token is current, its chat selected and shown, the transcript the same. */
    isCurrent(): boolean;
    /** Settles when the jump ends (replaced, cancelled, its chat left): every wait races it. */
    stopped: Promise<void>;
    /** The selected chat's messages (the jump's chat), or null when it is not loaded. */
    messages(): readonly { readonly chatId?: string }[] | null;
    /** `chatFoldedStateMessageIndex.index`: -1 without a fold. */
    foldedIndex(): number;
    /** Clears the fold (`chatFoldedState.data = null`). */
    clearFold(): void;
    loadPages(): number;
    setLoadPages(value: number): void;
    /** Svelte's `tick`. */
    tick(): Promise<void>;
    /** `Chats.whenRendered()`: the rows' deferred mount and reveal. */
    whenRendered(): Promise<void>;
    /** The connected row rendering `index` under this screen's transcript, or null. */
    findRow(index: number): HTMLElement | null;
    /** Scrolls a row to the top of the transcript, at once. */
    scrollTo(row: HTMLElement): void;
    /** Waits (bounded) for the transcript's images, so the final scroll lands after their layout shift. */
    settleImages(): Promise<void>;
    /** Highlights the row (the ring a timer removes). */
    ring(row: HTMLElement): void;
}

/**
 * Brings message `messageId` of the selected chat into view and rings it. `gone` when the chat no
 * longer holds it; `stopped` when the jump lost the screen or the row never showed.
 */
export async function runMessageJump(messageId: string, deps: MessageJumpDeps): Promise<MessageJumpOutcome> {
    const STOPPED = Symbol("stopped");
    const stopped = deps.stopped.then(() => STOPPED);
    /** Waits, then answers whether the jump still owns the screen; a failed wait counts as settled. */
    const settle = async (wait: Promise<unknown>): Promise<boolean> => {
        const result = await Promise.race([
            wait.then(
                () => undefined,
                () => undefined,
            ),
            stopped,
        ]);
        return result !== STOPPED && deps.isCurrent();
    };
    /** The message's index, found again by id; null when the chat is not loaded, -1 when it is gone. */
    const indexOf = (): number | null => {
        const messages = deps.messages();
        return messages === null ? null : messages.findIndex((message) => message.chatId === messageId);
    };
    /** The row of the target, only when it still renders this message. */
    const targetRow = (index: number): HTMLElement | null => {
        const row = deps.findRow(index);
        return row && row.dataset.chatId === messageId ? row : null;
    };

    for (let round = 0; round < MESSAGE_JUMP_ROUNDS; round++) {
        if (!deps.isCurrent()) {
            return "stopped";
        }
        let index = indexOf();
        if (index === null) {
            return "stopped";
        }
        if (index === -1) {
            return "gone";
        }
        const length = deps.messages()!.length;
        const window = messageJumpWindow({
            length,
            index,
            loadPages: deps.loadPages(),
            folded: deps.foldedIndex(),
        });
        if (window.clearFold) {
            deps.clearFold();
        }
        if (window.loadPages !== deps.loadPages()) {
            deps.setLoadPages(window.loadPages);
        }
        if (!(await settle(deps.tick())) || !(await settle(deps.whenRendered()))) {
            return "stopped";
        }

        index = indexOf();
        if (index === null) {
            return "stopped";
        }
        if (index === -1) {
            return "gone";
        }
        const row = targetRow(index);
        if (!row) {
            // The chat changed under the jump (a message added before it, a fold set): plan again.
            continue;
        }
        deps.scrollTo(deps.findRow(Math.max(0, index - PRE_SCROLL_ROWS)) ?? row);
        if (!(await settle(deps.settleImages()))) {
            return "stopped";
        }

        index = indexOf();
        if (index === null) {
            return "stopped";
        }
        if (index === -1) {
            return "gone";
        }
        const settled = targetRow(index);
        if (!settled) {
            continue;
        }
        deps.scrollTo(settled);
        // Once more after the last layout adjustments, as `scrollToMessage` does.
        if (!(await settle(deps.tick()))) {
            return "stopped";
        }
        index = indexOf();
        if (index === null) {
            return "stopped";
        }
        if (index === -1) {
            return "gone";
        }
        const final = targetRow(index);
        if (!final) {
            continue;
        }
        deps.scrollTo(final);
        deps.ring(final);
        return "done";
    }
    return "stopped";
}
