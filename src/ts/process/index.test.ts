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
type ServerResult = Awaited<ReturnType<typeof sendChatOnServer>>;
let process: typeof import("./index.svelte");

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
    process = await import("./index.svelte");
});

afterEach(() => vi.restoreAllMocks());

describe("sendChat owns the tab's send state", () => {
    it.each([
        { end: "success", target: "explicit" },
        { end: "success", target: "selected" },
        { end: "refusal", target: "explicit" },
        { end: "throw", target: "explicit" },
    ] as const)("publishes the $target target and releases both stores after $end", async ({ end, target }) => {
        const { sendChat, doingChat, sendingChatRef } = process;
        const expectedTarget = target === "explicit" ? chatA : chatB;
        const server = deferred<ServerResult>();
        const onServerRefused = vi.fn();
        const error = new Error("server send failed");
        const busyTransitions: { busy: boolean; target: ChatRef | null }[] = [];
        const serverObservations: { busy: boolean; target: ChatRef | null }[] = [];
        const unsubscribe = doingChat.subscribe((busy) => {
            busyTransitions.push({ busy, target: get(sendingChatRef) });
        });
        stubs.serverSend.mockImplementationOnce(() => {
            serverObservations.push({ busy: get(doingChat), target: get(sendingChatRef) });
            return server.promise;
        });
        let sending: Promise<boolean> | undefined;

        try {
            expect(get(doingChat)).toBe(false);
            expect(get(sendingChatRef)).toBeNull();
            sending = sendChat(-1, {
                ...(target === "explicit" ? { target: chatA } : {}),
                onServerRefused,
            });
            expect(stubs.serverSend).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ target: expectedTarget }),
            );
            expect(serverObservations).toEqual([{ busy: true, target: expectedTarget }]);
            expect(get(doingChat)).toBe(true);
            expect(get(sendingChatRef)).toEqual(expectedTarget);

            // Switching the selection cannot retarget the send that is already in flight.
            stubs.currentChatRef.mockReturnValue(target === "explicit" ? chatB : chatA);
            expect(get(sendingChatRef)).toEqual(expectedTarget);
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

            expect(get(doingChat)).toBe(false);
            expect(get(sendingChatRef)).toBeNull();
            // Busy turns on before a target is published; the target is cleared before idle.
            expect(busyTransitions).toEqual([
                { busy: false, target: null },
                { busy: true, target: null },
                { busy: false, target: null },
            ]);
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

    it("refuses chat B while chat A runs without touching A's busy flag or target", async () => {
        const { sendChat, doingChat, sendingChatRef } = process;
        const server = deferred<ServerResult>();
        stubs.serverSend.mockReturnValueOnce(server.promise);
        const sendingA = sendChat(-1, { target: chatA });
        const flagWrites = vi.spyOn(doingChat, "set");
        const targetWrites = vi.spyOn(sendingChatRef, "set");
        const onServerRefused = vi.fn();

        try {
            expect(get(doingChat)).toBe(true);
            expect(get(sendingChatRef)).toEqual(chatA);
            expect(await sendChat(-1, { target: chatB, onServerRefused })).toBe(false);
            expect(onServerRefused).toHaveBeenCalledExactlyOnceWith(false);
            expect(stubs.serverSend).toHaveBeenCalledTimes(1);
            expect(flagWrites).not.toHaveBeenCalled();
            expect(targetWrites).not.toHaveBeenCalled();
            expect(get(doingChat)).toBe(true);
            expect(get(sendingChatRef)).toEqual(chatA);
        } finally {
            server.resolve({ ok: true, outcome: "started" });
            await sendingA;
        }
        expect(get(doingChat)).toBe(false);
        expect(get(sendingChatRef)).toBeNull();
    });
});
