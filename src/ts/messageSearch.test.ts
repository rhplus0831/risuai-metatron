// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The message search request (`searchMessages` over `authFetch`: the body per scope, the cursor,
// the answers) and the jump lifecycle (`requestMessageJump` replaces, `claim` answers once, stale
// tokens change nothing, a selection change cancels: the chat module and the selection are mocked
// as reactive stores so the module's effect and its character listener run).

type ChatRef = { chaId: string; chatId: string };

const mocks = vi.hoisted(() => ({
    ref: null as unknown as Writable<ChatRef | null>,
    selection: null as unknown as Writable<{ characterId: string | null; chatOpen: boolean }>,
    versions: new Map<string, number>(),
    listeners: new Set<() => void>(),
    authFetch: vi.fn(),
}));

vi.mock("./storage/chatStore.svelte", async () => {
    const { writable, fromStore } = await import("svelte/store");
    const store = writable<ChatRef | null>(null);
    mocks.ref = store;
    const current = fromStore(store);
    return {
        currentChatRef: () => current.current,
        // Bumped by every selection, the same chat included (as `selectChat` does): the jump must not read it.
        chatSelectionVersion: (chaId: string) => mocks.versions.get(chaId) ?? 0,
    };
});
vi.mock("./storage/selection.svelte", async () => {
    const { writable, fromStore } = await import("svelte/store");
    const store = writable({ characterId: null as string | null, chatOpen: false });
    mocks.selection = store;
    const current = fromStore(store);
    return {
        selection: {
            get characterId() {
                return current.current.characterId;
            },
            get chatOpen() {
                return current.current.chatOpen;
            },
        },
        onCharacterSelectionChanged: (listener: () => void) => {
            mocks.listeners.add(listener);
            return () => mocks.listeners.delete(listener);
        },
    };
});
vi.mock("./storage/serverAuth", () => ({ authFetch: mocks.authFetch }));

import { MESSAGE_SEARCH_PATH, type MessageSearchPage } from "../../shared/messageSearch.ts";
import {
    cancelMessageJump,
    claimMessageJump,
    completeMessageJump,
    isMessageJumpCurrent,
    messageJumpStopped,
    messageSearchBody,
    messageSearchScopeKey,
    pendingMessageJump,
    requestMessageJump,
    searchMessages,
} from "./messageSearch.svelte";

const A = { chaId: "c1", chatId: "k1" };
const B = { chaId: "c1", chatId: "k2" };
const OTHER = { chaId: "c2", chatId: "k3" };

/** Selects a chat as `openPinnedChat` (or the router applying a chat URL) does: the chat, then the character, then open. */
function openChat(ref: ChatRef) {
    mocks.versions.set(ref.chaId, (mocks.versions.get(ref.chaId) ?? 0) + 1);
    mocks.ref.set({ ...ref });
    const changed = get(mocks.selection).characterId !== ref.chaId;
    mocks.selection.set({ characterId: ref.chaId, chatOpen: true });
    if (changed) for (const listener of [...mocks.listeners]) listener();
}

function goHome() {
    mocks.ref.set(null);
    const changed = get(mocks.selection).characterId !== null;
    mocks.selection.set({ characterId: null, chatOpen: false });
    if (changed) for (const listener of [...mocks.listeners]) listener();
}

/** Whether a promise settled by now (a latch over a few microtasks: no timer). */
async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
        done = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return done;
}

beforeEach(() => {
    mocks.versions.clear();
    mocks.authFetch.mockReset();
    goHome();
    flushSync();
});

afterEach(() => {
    goHome();
    flushSync();
});

describe("the request", () => {
    it("builds the body per scope and adds the cursor only when given", () => {
        expect(messageSearchBody("hi", { kind: "all" })).toEqual({ query: "hi" });
        expect(messageSearchBody("hi", { kind: "character", chaId: "c1" })).toEqual({ query: "hi", characterId: "c1" });
        expect(messageSearchBody("hi", { kind: "chat", ref: A })).toEqual({
            query: "hi",
            characterId: "c1",
            chatId: "k1",
        });
        expect(messageSearchBody("hi", { kind: "all" }, "cur")).toEqual({ query: "hi", cursor: "cur" });
        expect(messageSearchBody("hi", { kind: "all" }, undefined)).not.toHaveProperty("cursor");
    });

    it("keys a scope by its kind and ids", () => {
        expect(messageSearchScopeKey({ kind: "chat", ref: { ...A } })).toBe(
            messageSearchScopeKey({ kind: "chat", ref: A }),
        );
        expect(messageSearchScopeKey({ kind: "chat", ref: A })).not.toBe(
            messageSearchScopeKey({ kind: "chat", ref: B }),
        );
        expect(messageSearchScopeKey({ kind: "character", chaId: "c1" })).not.toBe(
            messageSearchScopeKey({ kind: "all" }),
        );
    });

    it("posts the body with the cursor and signal, and answers the page", async () => {
        const page: MessageSearchPage = { hits: [], next: "n1", scannedBytes: 3 };
        mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200 }));
        const controller = new AbortController();
        await expect(searchMessages("hi", { kind: "chat", ref: A }, "c0", controller.signal)).resolves.toEqual({
            kind: "page",
            page,
        });
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);
        const [path, init] = mocks.authFetch.mock.calls[0] as [string, RequestInit];
        expect(path).toBe(MESSAGE_SEARCH_PATH);
        expect(init.method).toBe("POST");
        expect(init.signal).toBe(controller.signal);
        expect(JSON.parse(init.body as string)).toEqual({ query: "hi", characterId: "c1", chatId: "k1", cursor: "c0" });
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    });

    it("answers epoch for a 409 with that reason, and an error state for every other failure", async () => {
        mocks.authFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: "replaced", reason: "epoch" }), { status: 409 }),
        );
        await expect(searchMessages("hi", { kind: "all" })).resolves.toEqual({ kind: "epoch" });

        mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "busy" }), { status: 429 }));
        await expect(searchMessages("hi", { kind: "all" })).resolves.toEqual({ kind: "error", message: "busy" });

        mocks.authFetch.mockResolvedValueOnce(new Response("", { status: 503 }));
        await expect(searchMessages("hi", { kind: "all" })).resolves.toEqual({ kind: "error", message: "HTTP 503" });

        mocks.authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "locked" }), { status: 409 }));
        await expect(searchMessages("hi", { kind: "all" })).resolves.toEqual({ kind: "error", message: "locked" });

        mocks.authFetch.mockRejectedValueOnce(new Error("offline"));
        await expect(searchMessages("hi", { kind: "all" })).resolves.toEqual({ kind: "error", message: "offline" });

        const controller = new AbortController();
        mocks.authFetch.mockImplementationOnce(async () => {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
        });
        await expect(searchMessages("hi", { kind: "all" }, undefined, controller.signal)).resolves.toEqual({
            kind: "aborted",
        });
    });
});

describe("the jump lifecycle", () => {
    it("replaces an older jump with a newer token and settles the older one's stop", async () => {
        openChat(A);
        const first = requestMessageJump(A, "m1");
        const firstStopped = messageJumpStopped(first);
        expect(pendingMessageJump()).toMatchObject({ token: first, ref: A, messageId: "m1", state: "pending" });
        expect(await settled(firstStopped)).toBe(false);

        const second = requestMessageJump(A, "m2");
        expect(second).toBeGreaterThan(first);
        expect(isMessageJumpCurrent(first)).toBe(false);
        expect(isMessageJumpCurrent(second)).toBe(true);
        expect(pendingMessageJump()).toMatchObject({ token: second, messageId: "m2" });
        expect(await settled(firstStopped)).toBe(true);
        expect(await settled(messageJumpStopped(second))).toBe(false);
        expect(await settled(messageJumpStopped(first))).toBe(true);
    });

    it("claims once: a claim for another ref, or a second claim, is null", () => {
        openChat(A);
        const token = requestMessageJump(A, "m1");
        expect(claimMessageJump(B)).toBeNull();
        expect(pendingMessageJump()?.token).toBe(token);
        expect(claimMessageJump(A)).toEqual({ token, ref: A, messageId: "m1", state: "claimed" });
        expect(claimMessageJump(A)).toBeNull();
        expect(pendingMessageJump()).toBeNull();
        expect(isMessageJumpCurrent(token)).toBe(true);
    });

    it("ignores a stale token on complete and cancel, and drops the jump on the current one", async () => {
        openChat(A);
        const token = requestMessageJump(A, "m1");
        completeMessageJump(token - 1);
        cancelMessageJump(token + 1);
        expect(isMessageJumpCurrent(token)).toBe(true);
        expect(pendingMessageJump()?.token).toBe(token);

        claimMessageJump(A);
        const stopped = messageJumpStopped(token);
        completeMessageJump(token);
        expect(isMessageJumpCurrent(token)).toBe(false);
        expect(await settled(stopped)).toBe(true);
        expect(await settled(messageJumpStopped(token))).toBe(true);

        const again = requestMessageJump(A, "m2");
        cancelMessageJump(again);
        expect(isMessageJumpCurrent(again)).toBe(false);
        expect(pendingMessageJump()).toBeNull();
    });

    it("cancels a pending jump when another chat is selected, and selecting its chat again claims nothing", async () => {
        openChat(A);
        flushSync();
        const token = requestMessageJump(A, "m1");
        const stopped = messageJumpStopped(token);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(true);

        openChat(B);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(false);
        expect(claimMessageJump(A)).toBeNull();
        expect(await settled(stopped)).toBe(true);

        openChat(A);
        flushSync();
        expect(pendingMessageJump()).toBeNull();
        expect(claimMessageJump(A)).toBeNull();
        expect(isMessageJumpCurrent(token)).toBe(false);
    });

    it("cancels a claimed jump when another chat is selected, so the screen's wait is released", async () => {
        openChat(A);
        flushSync();
        const token = requestMessageJump(A, "m1");
        flushSync();
        expect(claimMessageJump(A)?.token).toBe(token);
        const stopped = messageJumpStopped(token);
        expect(await settled(stopped)).toBe(false);

        openChat(B);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(false);
        expect(await settled(stopped)).toBe(true);
        openChat(A);
        flushSync();
        expect(claimMessageJump(A)).toBeNull();
    });

    it("keeps a pending and a claimed jump when the same chat is selected again (the router closing the catalog over it)", () => {
        openChat(A);
        flushSync();
        const token = requestMessageJump(A, "m1");
        flushSync();
        openChat(A);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(true);
        expect(claimMessageJump(A)?.token).toBe(token);

        openChat(A);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(true);
        // Leaving it still ends it.
        openChat(B);
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(false);
    });

    it("drops the jump at once when another character (or home) is selected", () => {
        openChat(A);
        flushSync();
        const token = requestMessageJump(A, "m1");
        openChat(OTHER);
        // The character listener runs synchronously: no flush needed.
        expect(isMessageJumpCurrent(token)).toBe(false);
        expect(pendingMessageJump()).toBeNull();

        openChat(A);
        flushSync();
        const second = requestMessageJump(A, "m2");
        claimMessageJump(A);
        goHome();
        expect(isMessageJumpCurrent(second)).toBe(false);
    });

    it("drops the jump when its chat closes, and keeps it across an unrelated rerun of the effect", () => {
        openChat(A);
        flushSync();
        const token = requestMessageJump(A, "m1");
        flushSync();
        // The same chat published again (a new ref object, no selection change): still current.
        mocks.ref.set({ ...A });
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(true);
        expect(pendingMessageJump()?.token).toBe(token);

        mocks.selection.set({ characterId: A.chaId, chatOpen: false });
        flushSync();
        expect(isMessageJumpCurrent(token)).toBe(false);
        expect(claimMessageJump(A)).toBeNull();
    });
});
