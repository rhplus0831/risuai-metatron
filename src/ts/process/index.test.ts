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
const started: ServerResult = { ok: true, outcome: "started" };
const refused: ServerResult = { ok: false, outcome: "refused", refusal: "definite" };

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

describe("sendChat owns its chat's send entry", () => {
    it.each([
        { end: "success", target: "explicit" },
        { end: "success", target: "selected" },
        { end: "refusal", target: "explicit" },
        { end: "throw", target: "explicit" },
    ] as const)("holds the $target target's entry from before the first await until $end", async ({ end, target }) => {
        const { sendChat } = process;
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

            // Switching the selection cannot retarget the send that is already in flight.
            stubs.currentChatRef.mockReturnValue(target === "explicit" ? chatB : chatA);
            expect(entries()).toEqual(held);
            if (end === "throw") {
                const rejected = expect(sending).rejects.toBe(error);
                server.reject(error);
                await rejected;
            } else {
                server.resolve(end === "success" ? started : refused);
                expect(await sending).toBe(end === "success");
            }

            expect(entries()).toEqual([]);
            expect(transitions).toEqual([[], held, []]);
            if (end === "refusal") {
                expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            } else {
                expect(onServerRefused).not.toHaveBeenCalled();
            }
        } finally {
            server.resolve(started);
            await sending?.catch(() => {});
            unsubscribe();
        }
    });

    it("holds the tab entry for a send without a selected chat, beside which a chat's send runs", async () => {
        const { sendChat } = process;
        const { isLocalSend } = registry;
        stubs.currentChatRef.mockReturnValue(null);
        const tabServer = deferred<ServerResult>();
        const chatServer = deferred<ServerResult>();
        stubs.serverSend.mockImplementationOnce(() => {
            expect(entries()).toEqual([["", null]]);
            return tabServer.promise;
        });
        const sending = sendChat(-1, {});
        let sendingA: Promise<boolean> | undefined;
        try {
            expect(stubs.serverSend).toHaveBeenCalledExactlyOnceWith(
                expect.not.objectContaining({ target: expect.anything() }),
            );
            expect(entries()).toEqual([["", null]]);
            expect(isLocalSend(chatA)).toBe(false);
            // The tab entry fences no chat: a chat's send is admitted beside it.
            stubs.serverSend.mockReturnValueOnce(chatServer.promise);
            sendingA = sendChat(-1, { target: chatA });
            expect(stubs.serverSend).toHaveBeenCalledTimes(2);
            expect(entries()).toEqual([
                ["", null],
                [keyOf(chatA), chatA],
            ]);
            // A second send without a chat is the one the tab entry refuses.
            expect(await sendChat(-1, {})).toBe(false);
            expect(stubs.serverSend).toHaveBeenCalledTimes(2);
        } finally {
            tabServer.resolve(started);
            chatServer.resolve(started);
            expect(await sending).toBe(true);
            expect(await sendingA).toBe(true);
        }
        expect(entries()).toEqual([]);
    });

    it.each([
        { first: "A", end: "success" },
        { first: "B", end: "success" },
        { first: "A", end: "refusal" },
        { first: "B", end: "throw" },
    ] as const)(
        "runs chats A and B together, refuses a second send and a preview of A while A runs, and when $first ends with $end releases only its own chat",
        async ({ first, end }) => {
            const { sendChat, previewChat } = process;
            const { localSends, isLocalSend } = registry;
            const servers = { A: deferred<ServerResult>(), B: deferred<ServerResult>() };
            const both: Entries = [
                [keyOf(chatA), chatA],
                [keyOf(chatB), chatB],
            ];
            stubs.serverSend.mockImplementation((arg) =>
                keyOf(arg.target!) === keyOf(chatA) ? servers.A.promise : servers.B.promise,
            );
            const sendingA = sendChat(-1, { target: chatA });
            const sendingB = sendChat(-1, { target: chatB });
            const settle = async () => {
                servers.A.resolve(started);
                servers.B.resolve(started);
                await Promise.allSettled([sendingA, sendingB]);
            };

            try {
                // Both admitted, each holding its own entry.
                expect(stubs.serverSend).toHaveBeenCalledTimes(2);
                expect(stubs.serverSend.mock.calls.map(([arg]) => arg.target)).toEqual([chatA, chatB]);
                expect(entries()).toEqual(both);

                // A second send of A, and a preview of A, are refused without touching A's entry.
                const notifications = vi.fn();
                const unsubscribe = localSends.subscribe(notifications);
                const onServerRefused = vi.fn();
                expect(await sendChat(-1, { target: chatA, onServerRefused })).toBe(false);
                expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
                expect(await previewChat("preview", chatA)).toBeNull();
                expect(stubs.serverSend).toHaveBeenCalledTimes(2);
                // Only the subscription's own first call: the refusals published nothing.
                expect(notifications).toHaveBeenCalledTimes(1);
                unsubscribe();
                expect(entries()).toEqual(both);

                // The first send to end releases its own chat; the other stays held.
                const [ending, other] = first === "A" ? [chatA, chatB] : [chatB, chatA];
                const server = servers[first];
                const sending = first === "A" ? sendingA : sendingB;
                if (end === "throw") {
                    const error = new Error("server send failed");
                    const rejected = expect(sending).rejects.toBe(error);
                    server.reject(error);
                    await rejected;
                } else {
                    server.resolve(end === "success" ? started : refused);
                    expect(await sending).toBe(end === "success");
                }
                expect(isLocalSend(ending)).toBe(false);
                expect(entries()).toEqual([[keyOf(other), other]]);

                // The other ends in turn, releasing the last entry.
                servers[first === "A" ? "B" : "A"].resolve(started);
                expect(await (first === "A" ? sendingB : sendingA)).toBe(true);
                expect(entries()).toEqual([]);
            } finally {
                await settle();
            }
        },
    );

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

    it("from a registry notification of A's start, refuses a send of A and admits one of B (the guard reads the registry itself)", async () => {
        const { sendChat } = process;
        const { localSends } = registry;
        const onServerRefused = vi.fn();
        const servers = { A: deferred<ServerResult>(), B: deferred<ServerResult>() };
        let reentrantA: Promise<boolean> | undefined;
        let reentrantB: Promise<boolean> | undefined;
        // Runs while A's entry is being published: the admission sees it already.
        const unsubscribe = localSends.subscribe((sends) => {
            if (sends.has(keyOf(chatA)) && reentrantA === undefined) {
                reentrantA = sendChat(-1, { target: chatA, onServerRefused });
                reentrantB = sendChat(-1, { target: chatB });
            }
        });
        stubs.serverSend.mockImplementation((arg) =>
            keyOf(arg.target!) === keyOf(chatA) ? servers.A.promise : servers.B.promise,
        );
        const sendingA = sendChat(-1, { target: chatA });

        try {
            expect(await reentrantA).toBe(false);
            expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            // B's server call runs inside A's publication, before A's own.
            expect(stubs.serverSend).toHaveBeenCalledTimes(2);
            expect(stubs.serverSend.mock.calls.map(([arg]) => arg.target)).toEqual([chatB, chatA]);
            expect(entries()).toEqual([
                [keyOf(chatA), chatA],
                [keyOf(chatB), chatB],
            ]);
        } finally {
            servers.A.resolve(started);
            servers.B.resolve(started);
            await sendingA;
            await reentrantB;
            unsubscribe();
        }
        expect(entries()).toEqual([]);
    });
});
