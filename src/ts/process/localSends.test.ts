import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRef } from "../storage/chatStore.svelte";

// The local send registry (`chat-pipeline.md` Files): one entry per chat this tab sends in, taken
// by `beginLocalSend` before the send's first await and removed by the release it returns; a send
// without a chat holds the tab entry, which counts for `anyLocalSend` and fences no chat. The
// registry is a singleton without a reset, so every test loads a fresh module.

const chatA: ChatRef = { chaId: "character-a", chatId: "chat-a" };
const chatB: ChatRef = { chaId: "character-b", chatId: "chat-b" };
const keyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
let registry: typeof import("./localSends");

const entries = () => [...get(registry.localSends)];

beforeEach(async () => {
    vi.resetModules();
    registry = await import("./localSends");
});

describe("the local send registry", () => {
    it("holds one entry per chat from its begin to its release; anyLocalSend is whether any is held", () => {
        const { beginLocalSend, isLocalSend, anyLocalSend } = registry;
        expect(entries()).toEqual([]);
        expect(get(anyLocalSend)).toBe(false);

        const releaseA = beginLocalSend(chatA)!;
        expect(releaseA).toBeTypeOf("function");
        expect(entries()).toEqual([[keyOf(chatA), chatA]]);
        expect(isLocalSend(chatA)).toBe(true);
        expect(isLocalSend(chatB)).toBe(false);
        expect(get(anyLocalSend)).toBe(true);

        const releaseB = beginLocalSend(chatB)!;
        expect(entries()).toEqual([
            [keyOf(chatA), chatA],
            [keyOf(chatB), chatB],
        ]);
        expect(isLocalSend(chatB)).toBe(true);

        releaseA();
        expect(entries()).toEqual([[keyOf(chatB), chatB]]);
        expect(isLocalSend(chatA)).toBe(false);
        expect(get(anyLocalSend)).toBe(true);

        releaseB();
        expect(entries()).toEqual([]);
        expect(get(anyLocalSend)).toBe(false);
    });

    it("refuses a second begin of a chat that already has an entry, until that entry is released", () => {
        const { beginLocalSend, isLocalSend } = registry;
        const release = beginLocalSend(chatA)!;
        expect(beginLocalSend(chatA)).toBeNull();
        expect(beginLocalSend({ ...chatA })).toBeNull();
        expect(isLocalSend(chatA)).toBe(true);

        release();
        expect(beginLocalSend(chatA)).not.toBeNull();
    });

    it("a send without a chat holds the tab entry, which counts for anyLocalSend and fences no chat", () => {
        const { beginLocalSend, isLocalSend, anyLocalSend } = registry;
        const release = beginLocalSend(null)!;
        expect(release).toBeTypeOf("function");
        expect(entries()).toEqual([["", null]]);
        expect(get(anyLocalSend)).toBe(true);
        expect(isLocalSend(chatA)).toBe(false);
        expect(beginLocalSend(null)).toBeNull();
        // A chat's send runs beside it.
        const releaseA = beginLocalSend(chatA)!;
        expect(entries()).toEqual([
            ["", null],
            [keyOf(chatA), chatA],
        ]);

        release();
        expect(entries()).toEqual([[keyOf(chatA), chatA]]);
        expect(get(anyLocalSend)).toBe(true);
        releaseA();
        expect(get(anyLocalSend)).toBe(false);
    });

    it("a release removes its own entry once: repeated, or after a newer begin of the chat, it changes nothing", () => {
        const { beginLocalSend, isLocalSend } = registry;
        const notifications: string[][] = [];
        const unsubscribe = registry.localSends.subscribe((sends) => notifications.push([...sends.keys()]));

        const first = beginLocalSend(chatA)!;
        first();
        first();
        expect(isLocalSend(chatA)).toBe(false);
        expect(notifications).toEqual([[], [keyOf(chatA)], []]);

        const second = beginLocalSend(chatA)!;
        first();
        expect(isLocalSend(chatA)).toBe(true);
        expect(notifications).toEqual([[], [keyOf(chatA)], [], [keyOf(chatA)]]);
        second();
        expect(isLocalSend(chatA)).toBe(false);
        unsubscribe();
    });

    it("copies the chat it is given and publishes a new Map per change", () => {
        const { beginLocalSend, isLocalSend } = registry;
        const seen: ReadonlyMap<string, ChatRef | null>[] = [];
        const unsubscribe = registry.localSends.subscribe((sends) => seen.push(sends));
        const given = { ...chatA };
        const release = beginLocalSend(given)!;
        given.chatId = "moved";
        expect(isLocalSend(chatA)).toBe(true);
        expect(get(registry.localSends).get(keyOf(chatA))).toEqual(chatA);
        expect(get(registry.localSends).get(keyOf(chatA))).not.toBe(given);
        release();
        expect(seen).toHaveLength(3);
        expect(new Set(seen).size).toBe(3);
        unsubscribe();
    });

    it("isLocalSend reads the Map it is given, else the registry", () => {
        const { beginLocalSend, isLocalSend } = registry;
        const release = beginLocalSend(chatA)!;
        expect(isLocalSend(chatA, new Map())).toBe(false);
        expect(isLocalSend(chatB, new Map([[keyOf(chatB), chatB]]))).toBe(true);
        expect(isLocalSend(chatA)).toBe(true);
        release();
    });

    // Last in the file: a throwing store subscriber leaves `svelte/store`'s shared notification
    // queue unfinished, so no later store notification in this process reaches its subscribers.
    it("leaves nothing held when a subscriber throws at the begin, so the chat can begin again", () => {
        const { beginLocalSend, isLocalSend } = registry;
        const error = new Error("subscriber failed");
        let throwOnce = true;
        registry.localSends.subscribe((sends) => {
            if (throwOnce && sends.size > 0) {
                throwOnce = false;
                throw error;
            }
        });

        expect(() => beginLocalSend(chatA)).toThrow(error);
        expect(isLocalSend(chatA)).toBe(false);
        expect(entries()).toEqual([]);
        expect(beginLocalSend(chatA)).not.toBeNull();
        expect(isLocalSend(chatA)).toBe(true);
    });
});
