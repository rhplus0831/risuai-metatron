// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

// Search plan slice 4b: the chat screen's jump to a message by id, through the pure helper
// `messageJump.ts` (`DefaultChatScreen.svelte`'s `scrollToMessageId` injects its state and DOM).
// The window arithmetic is checked against the row range `Chats.svelte`'s `updateChatBody`
// renders (`length - 1` down to `length - window`, or `folded` down to `folded - window`), and the
// decisions are driven through hooks that change the chat at each await boundary: the index is
// found again by id after every await (D1), never kept across one.

import { MESSAGE_JUMP_ROUNDS, messageJumpWindow, runMessageJump, type MessageJumpDeps } from "./messageJump";

/** The indices `Chats.svelte` renders for a window (its `loadStart`/`loadEnd`), newest first. */
function renderedRange(length: number, window: number, folded: number): number[] {
    let loadStart = length - 1;
    let loadEnd = length - window;
    if (folded !== -1) {
        loadStart = folded;
        loadEnd = Math.max(0, folded - window);
    }
    const rows: number[] = [];
    for (let i = loadStart; i >= Math.max(0, loadEnd); i--) rows.push(i);
    return rows;
}

describe("messageJumpWindow", () => {
    it("grows an unfolded window to five rows past the target and never shrinks it", () => {
        expect(messageJumpWindow({ length: 100, index: 40, loadPages: 10, folded: -1 })).toEqual({
            clearFold: false,
            loadPages: 65,
        });
        expect(renderedRange(100, 65, -1)).toContain(40);
        expect(renderedRange(100, 64, -1)).not.toContain(40 - 5);
        expect(messageJumpWindow({ length: 100, index: 40, loadPages: 80, folded: -1 })).toEqual({
            clearFold: false,
            loadPages: 80,
        });
    });

    it("keeps a fold above the target and grows the folded window from the fold", () => {
        expect(messageJumpWindow({ length: 1000, index: 150, loadPages: 100, folded: 200 })).toEqual({
            clearFold: false,
            loadPages: 100,
        });
        expect(messageJumpWindow({ length: 1000, index: 150, loadPages: 20, folded: 200 })).toEqual({
            clearFold: false,
            loadPages: 55,
        });
        expect(renderedRange(1000, 55, 200)).toContain(150);
        // The fold's own row is rendered under the fold: no clearing needed.
        expect(messageJumpWindow({ length: 1000, index: 200, loadPages: 20, folded: 200 }).clearFold).toBe(false);
    });

    it("clears a fold below the target and keeps every row shown so far, as the show-all button does", () => {
        // The plan review's example: `length - index + 5` alone (804) would drop rows 100..196.
        const before = renderedRange(1000, 100, 200);
        const window = messageJumpWindow({ length: 1000, index: 201, loadPages: 100, folded: 200 });
        expect(window).toEqual({ clearFold: true, loadPages: 900 });
        const after = renderedRange(1000, window.loadPages, -1);
        expect(after).toContain(201);
        for (const row of before) expect(after).toContain(row);
    });

    it("grows past the kept rows when the margin reaches further than they do", () => {
        const window = messageJumpWindow({ length: 1000, index: 999, loadPages: 1, folded: 998 });
        expect(window).toEqual({ clearFold: true, loadPages: 6 });
        expect(renderedRange(1000, 6, -1)).toContain(999);
        expect(renderedRange(1000, 5, -1)).not.toContain(994);
    });
});

type Hooks = Partial<Record<"tick" | "whenRendered" | "settleImages", () => void>>;

/**
 * A chat screen in miniature: messages by id, the fold and window, rows rendered for the window as
 * `Chats.svelte` would (connected elements with `data-chat-index` and `data-chat-id`), the three
 * waits as resolved promises whose hooks run when the wait starts (the chat changes under the
 * jump there), and a log of the scrolls and the ring.
 */
function screen(ids: string[], options: { loadPages?: number; folded?: number; hooks?: Hooks } = {}) {
    const state = {
        messages: ids.map((chatId) => ({ chatId })),
        loadPages: options.loadPages ?? 10,
        folded: options.folded ?? -1,
        current: true,
        clearFoldCalls: 0,
        setLoadPagesCalls: [] as number[],
        scrolled: [] as string[],
        rung: [] as string[],
        isCurrentCalls: 0,
    };
    const hooks = options.hooks ?? {};
    const container = document.createElement("div");
    document.body.appendChild(container);
    const render = () => {
        container.replaceChildren();
        for (const index of renderedRange(state.messages.length, state.loadPages, state.folded)) {
            const row = document.createElement("div");
            row.dataset.chatIndex = String(index);
            row.dataset.chatId = state.messages[index].chatId;
            container.appendChild(row);
        }
    };
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
        stop = resolve;
    });
    const deps: MessageJumpDeps = {
        isCurrent: () => {
            state.isCurrentCalls += 1;
            return state.current;
        },
        stopped,
        messages: () => state.messages,
        foldedIndex: () => state.folded,
        clearFold: () => {
            state.clearFoldCalls += 1;
            // `chatFoldedStateMessageIndex` follows `chatFoldedState.data` in an effect: after the tick.
            hooks.tick = hooks.tick ?? (() => {});
            const inner = hooks.tick;
            hooks.tick = () => {
                state.folded = -1;
                hooks.tick = inner;
                inner();
            };
        },
        loadPages: () => state.loadPages,
        setLoadPages: (value) => {
            state.loadPages = value;
            state.setLoadPagesCalls.push(value);
        },
        tick: async () => {
            hooks.tick?.();
            render();
        },
        whenRendered: async () => {
            hooks.whenRendered?.();
            render();
        },
        findRow: (index) => {
            const row = container.querySelector<HTMLElement>(`[data-chat-index="${index}"]`);
            return row?.isConnected ? row : null;
        },
        scrollTo: (row) => {
            state.scrolled.push(`${row.dataset.chatIndex}:${row.dataset.chatId}`);
        },
        settleImages: async () => {
            hooks.settleImages?.();
            render();
        },
        ring: (row) => {
            state.rung.push(`${row.dataset.chatIndex}:${row.dataset.chatId}`);
        },
    };
    render();
    return { state, deps, hooks, stop, container };
}

const ids = (count: number) => Array.from({ length: count }, (_, i) => `m${i}`);

describe("runMessageJump", () => {
    it("finds the message by id, grows the window, scrolls a row before it first, then the row twice and rings it", async () => {
        const { state, deps } = screen(ids(50));
        await expect(runMessageJump("m10", deps)).resolves.toBe("done");
        expect(state.setLoadPagesCalls).toEqual([45]);
        expect(state.clearFoldCalls).toBe(0);
        expect(state.scrolled).toEqual(["7:m7", "10:m10", "10:m10"]);
        expect(state.rung).toEqual(["10:m10"]);
        // Ownership is checked after every await (tick, whenRendered, settleImages, the final tick) and before the first.
        expect(state.isCurrentCalls).toBe(5);
    });

    it("answers gone for an id the chat does not hold, without touching the window", async () => {
        const { state, deps } = screen(ids(5));
        await expect(runMessageJump("other", deps)).resolves.toBe("gone");
        expect(state.setLoadPagesCalls).toEqual([]);
        expect(state.scrolled).toEqual([]);
    });

    it("stops once the jump lost the screen after an await, without scrolling", async () => {
        const { state, deps, hooks } = screen(ids(50));
        hooks.whenRendered = () => {
            state.current = false;
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("stopped");
        expect(state.setLoadPagesCalls).toEqual([45]);
        expect(state.scrolled).toEqual([]);
        expect(state.rung).toEqual([]);
    });

    it("stops when the jump is dropped while a wait never settles, and when the chat is not loaded", async () => {
        const { state, deps, stop } = screen(ids(50));
        deps.whenRendered = () => new Promise(() => {});
        const run = runMessageJump("m10", deps);
        let settled = false;
        void run.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        state.current = false;
        stop();
        await expect(run).resolves.toBe("stopped");
        expect(state.scrolled).toEqual([]);

        const unloaded = screen(ids(5));
        unloaded.deps.messages = () => null;
        await expect(runMessageJump("m1", unloaded.deps)).resolves.toBe("stopped");
    });

    it("clears a fold below the target, keeping the rows shown, and keeps a fold above it", async () => {
        const below = screen(ids(50), { loadPages: 10, folded: 20 });
        await expect(runMessageJump("m30", below.deps)).resolves.toBe("done");
        expect(below.state.clearFoldCalls).toBe(1);
        expect(below.state.setLoadPagesCalls).toEqual([40]);
        expect(below.state.rung).toEqual(["30:m30"]);

        const above = screen(ids(50), { loadPages: 10, folded: 40 });
        await expect(runMessageJump("m30", above.deps)).resolves.toBe("done");
        expect(above.state.clearFoldCalls).toBe(0);
        expect(above.state.setLoadPagesCalls).toEqual([15]);
        expect(above.state.rung).toEqual(["30:m30"]);
    });

    it("follows the message when an older message is inserted while the rows mount (D1)", async () => {
        const { state, deps, hooks } = screen(ids(50));
        hooks.tick = () => {
            state.messages = [{ chatId: "older" }, ...state.messages];
            hooks.tick = undefined;
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("done");
        expect(state.scrolled).toEqual(["8:m7", "11:m10", "11:m10"]);
        expect(state.rung).toEqual(["11:m10"]);
    });

    it("plans again when newer messages pushed the target out of the window after the first render", async () => {
        const { state, deps, hooks } = screen(ids(50));
        hooks.whenRendered = () => {
            state.messages = [...state.messages, ...ids(10).map((id) => ({ chatId: `new-${id}` }))];
            hooks.whenRendered = undefined;
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("done");
        expect(state.setLoadPagesCalls).toEqual([45, 55]);
        expect(state.rung).toEqual(["10:m10"]);
    });

    it("answers gone when the message is deleted while the images settle, without the final scroll", async () => {
        const { state, deps, hooks } = screen(ids(50));
        hooks.settleImages = () => {
            state.messages = state.messages.filter((message) => message.chatId !== "m10");
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("gone");
        expect(state.scrolled).toEqual(["7:m7"]);
        expect(state.rung).toEqual([]);
    });

    it("gives up after the bounded rounds when the row never renders the message", async () => {
        const { state, deps } = screen(ids(50));
        const findRow = deps.findRow;
        deps.findRow = (index) => {
            const row = findRow(index);
            if (row) row.dataset.chatId = "someone-else";
            return row;
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("stopped");
        expect(state.setLoadPagesCalls).toEqual([45]);
        expect(state.scrolled).toEqual([]);
        // Per round: the check at the start, one after the tick, one after whenRendered.
        expect(state.isCurrentCalls).toBe(MESSAGE_JUMP_ROUNDS * 3);
    });

    it("does not scroll a stale row: the final lookups are by the current index and id", async () => {
        const { state, deps, hooks } = screen(ids(50));
        const scrollTo = vi.fn(deps.scrollTo);
        deps.scrollTo = scrollTo;
        // The final tick inserts an older message: the last scroll and the ring use the shifted row.
        let ticks = 0;
        hooks.tick = () => {
            ticks += 1;
            if (ticks === 2) state.messages = [{ chatId: "older" }, ...state.messages];
        };
        await expect(runMessageJump("m10", deps)).resolves.toBe("done");
        expect(state.scrolled).toEqual(["7:m7", "10:m10", "11:m10"]);
        expect(state.rung).toEqual(["11:m10"]);
        expect(scrollTo).toHaveBeenCalledTimes(3);
    });
});
