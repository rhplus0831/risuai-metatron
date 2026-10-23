import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRef } from "../storage/chatStore.svelte";
import type { sendChatOnServer } from "./serverGeneration";

// Exercise the tab's public send boundary; the server work stays pending until the test ends it.
const stubs = vi.hoisted(() => ({
    serverSend: vi.fn<typeof sendChatOnServer>(),
    currentChatRef: vi.fn<() => ChatRef | null>(),
    chatEntry: vi.fn(),
}));
vi.mock("./serverGeneration", () => ({ sendChatOnServer: stubs.serverSend }));
vi.mock("../storage/chatStore.svelte", () => ({
    currentChatRef: stubs.currentChatRef,
    chatEntry: stubs.chatEntry,
}));

const chatA: ChatRef = { chaId: "character-a", chatId: "chat-a" };
const chatB: ChatRef = { chaId: "character-b", chatId: "chat-b" };
const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
type ServerResult = Awaited<ReturnType<typeof sendChatOnServer>>;
type Entries = [string, ChatRef | null][];
let process: typeof import("./index.svelte");
// The registry `sendChat` writes: imported with it after each module reset (one instance).
let registry: typeof import("./localSends");

const entries = (): Entries => [...get(registry.localSends)];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

beforeEach(async () => {
    vi.resetModules();
    stubs.serverSend.mockReset();
    stubs.currentChatRef.mockReset().mockReturnValue(chatB);
    stubs.chatEntry.mockReset().mockReturnValue({ id: chatA.chatId });
    registry = await import("./localSends");
    process = await import("./index.svelte");
});

afterEach(() => vi.restoreAllMocks());

describe("sendChat owns the tab's send state", () => {
    it.each([
        { end: "success", target: "explicit" },
        { end: "success", target: "selected" },
        { end: "refusal", target: "explicit" },
        { end: "throw", target: "explicit" },
    ] as const)("holds the $target target's entry from before the first await until $end", async ({ end, target }) => {
        const { sendChat, doingChat } = process;
        const { localSends, isLocalSend } = registry;
        const expectedTarget = target === "explicit" ? chatA : chatB;
        const held: Entries = [[keyOf(expectedTarget), expectedTarget]];
        const server = deferred<ServerResult>();
        const onServerRefused = vi.fn();
        const error = new Error("server send failed");
        const transitions: Entries[] = [];
        const serverObservations: Entries[] = [];
        const unsubscribe = localSends.subscribe((sends) => transitions.push([...sends]));
        stubs.serverSend.mockImplementationOnce(() => {
            serverObservations.push(entries());
            return server.promise;
        });
        let sending: Promise<boolean> | undefined;

        try {
            expect(entries()).toEqual([]);
            expect(get(doingChat)).toBe(false);
            sending = sendChat(-1, {
                ...(target === "explicit" ? { target: chatA } : {}),
                onServerRefused,
            });
            expect(stubs.serverSend).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ target: expectedTarget }),
            );
            // Taken synchronously, before the server work begins.
            expect(serverObservations).toEqual([held]);
            expect(entries()).toEqual(held);
            expect(isLocalSend(expectedTarget)).toBe(true);
            expect(get(doingChat)).toBe(true);

            // Switching the selection cannot retarget the send that is already in flight.
            stubs.currentChatRef.mockReturnValue(target === "explicit" ? chatB : chatA);
            expect(entries()).toEqual(held);
            if (end === "throw") {
                const rejected = expect(sending).rejects.toBe(error);
                server.reject(error);
                await rejected;
            } else {
                server.resolve(
                    end === "success"
                        ? { ok: true, outcome: "started" }
                        : { ok: false, outcome: "refused", refusal: "definite" },
                );
                expect(await sending).toBe(end === "success");
            }

            expect(entries()).toEqual([]);
            expect(get(doingChat)).toBe(false);
            expect(transitions).toEqual([[], held, []]);
            if (end === "refusal") {
                expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            } else {
                expect(onServerRefused).not.toHaveBeenCalled();
            }
        } finally {
            server.resolve({ ok: true, outcome: "started" });
            await sending?.catch(() => {});
            unsubscribe();
        }
    });

    it("holds the tab entry for a send without a selected chat", async () => {
        const { sendChat, doingChat } = process;
        const { isLocalSend } = registry;
        stubs.currentChatRef.mockReturnValue(null);
        const server = deferred<ServerResult>();
        stubs.serverSend.mockImplementationOnce(() => {
            expect(entries()).toEqual([["", null]]);
            return server.promise;
        });
        const sending = sendChat(-1, {});
        try {
            expect(stubs.serverSend).toHaveBeenCalledExactlyOnceWith(
                expect.not.objectContaining({ target: expect.anything() }),
            );
            expect(entries()).toEqual([["", null]]);
            expect(get(doingChat)).toBe(true);
            expect(isLocalSend(chatA)).toBe(false);
            // Still one send per tab: a chat's send is refused meanwhile.
            expect(await sendChat(-1, { target: chatA })).toBe(false);
            expect(stubs.serverSend).toHaveBeenCalledTimes(1);
        } finally {
            server.resolve({ ok: true, outcome: "started" });
            expect(await sending).toBe(true);
        }
        expect(entries()).toEqual([]);
        expect(get(doingChat)).toBe(false);
    });

    it("refuses chat B while chat A runs without touching A's entry", async () => {
        const { sendChat, doingChat } = process;
        const { localSends } = registry;
        const server = deferred<ServerResult>();
        stubs.serverSend.mockReturnValueOnce(server.promise);
        const sendingA = sendChat(-1, { target: chatA });
        const notifications = vi.fn();
        const unsubscribe = localSends.subscribe(notifications);
        const onServerRefused = vi.fn();

        try {
            expect(entries()).toEqual([[keyOf(chatA), chatA]]);
            expect(await sendChat(-1, { target: chatB, onServerRefused })).toBe(false);
            expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            expect(stubs.serverSend).toHaveBeenCalledTimes(1);
            // Only the subscription's own first call: the refusal published nothing.
            expect(notifications).toHaveBeenCalledTimes(1);
            expect(entries()).toEqual([[keyOf(chatA), chatA]]);
            expect(get(doingChat)).toBe(true);
        } finally {
            server.resolve({ ok: true, outcome: "started" });
            await sendingA;
            unsubscribe();
        }
        expect(entries()).toEqual([]);
        expect(get(doingChat)).toBe(false);
    });

    it("refuses a gone explicit target before taking any entry", async () => {
        const { sendChat } = process;
        const { localSends } = registry;
        stubs.chatEntry.mockReturnValue(undefined);
        const notifications = vi.fn();
        const unsubscribe = localSends.subscribe(notifications);
        const onServerRefused = vi.fn();

        expect(await sendChat(-1, { target: chatA, onServerRefused })).toBe(false);
        expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
        expect(stubs.serverSend).not.toHaveBeenCalled();
        expect(notifications).toHaveBeenCalledTimes(1);
        expect(entries()).toEqual([]);
        unsubscribe();
    });

    it("refuses a send started from a registry notification of another send's start (the guard reads the registry, not its derived view)", async () => {
        const { sendChat, doingChat } = process;
        const { localSends } = registry;
        const onServerRefused = vi.fn();
        let reentrant: Promise<boolean> | undefined;
        // Subscribed before any reader of `doingChat`, so this listener runs before the derived
        // view's own update: `doingChat` is still false while A's entry is already held.
        const unsubscribe = localSends.subscribe((sends) => {
            if (sends.size === 1 && reentrant === undefined) {
                expect(get(doingChat)).toBe(false);
                reentrant = sendChat(-1, { target: chatB, onServerRefused });
            }
        });
        const unsubscribeBusy = doingChat.subscribe(() => {});
        const server = deferred<ServerResult>();
        stubs.serverSend.mockReturnValueOnce(server.promise);
        const sendingA = sendChat(-1, { target: chatA });

        try {
            expect(await reentrant).toBe(false);
            expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            expect(stubs.serverSend).toHaveBeenCalledTimes(1);
            expect(entries()).toEqual([[keyOf(chatA), chatA]]);
        } finally {
            server.resolve({ ok: true, outcome: "started" });
            await sendingA;
            unsubscribe();
            unsubscribeBusy();
        }
        expect(entries()).toEqual([]);
    });
});
