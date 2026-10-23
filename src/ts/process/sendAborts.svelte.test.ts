import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import type { ChatRef } from "../storage/chatStore.svelte";
import { createSendAborts } from "./sendAborts.svelte";

// The chat screen's Stop controllers by chat (`createSendAborts`): Stop in one chat aborts that
// chat's send only; a release removes only its own controller; `has` is reactive. This file is
// `.svelte.test.ts` so an `$effect` can watch `has` the way the screen's Stop condition does.

const chatA: ChatRef = { chaId: "character-a", chatId: "chat-a" };
const chatB: ChatRef = { chaId: "character-b", chatId: "chat-b" };

describe("createSendAborts", () => {
    it("aborts the given chat's send only: Stop in A leaves B's controller, and B's Stop aborts B", () => {
        const aborts = createSendAborts();
        const a = aborts.begin(chatA);
        const b = aborts.begin(chatB);
        expect(aborts.has(chatA)).toBe(true);
        expect(aborts.has(chatB)).toBe(true);

        aborts.abort(chatA);
        expect(a.signal.aborted).toBe(true);
        expect(b.signal.aborted).toBe(false);
        // An aborted send still shows as running until it ends.
        expect(aborts.has(chatA)).toBe(true);

        a.release();
        expect(aborts.has(chatA)).toBe(false);
        expect(aborts.has(chatB)).toBe(true);

        aborts.abort(chatB);
        expect(b.signal.aborted).toBe(true);
        b.release();
        expect(aborts.has(chatB)).toBe(false);
        // Nothing to abort: no throw.
        aborts.abort(chatA);
    });

    it("a release removes its own controller once: an older release keeps a newer one of the same chat", () => {
        const aborts = createSendAborts();
        const older = aborts.begin(chatA);
        const newer = aborts.begin(chatA);

        older.release();
        expect(aborts.has(chatA)).toBe(true);
        aborts.abort(chatA);
        expect(older.signal.aborted).toBe(false);
        expect(newer.signal.aborted).toBe(true);

        newer.release();
        expect(aborts.has(chatA)).toBe(false);
        // A repeated release changes nothing, also once another send holds the chat again.
        const next = aborts.begin(chatA);
        newer.release();
        older.release();
        expect(aborts.has(chatA)).toBe(true);
        aborts.abort(chatA);
        expect(next.signal.aborted).toBe(true);
        next.release();
        expect(aborts.has(chatA)).toBe(false);
    });

    it("has is reactive, per chat, and false for no chat", () => {
        const aborts = createSendAborts();
        const seen: [boolean, boolean, boolean][] = [];
        const stop = $effect.root(() => {
            $effect(() => {
                seen.push([aborts.has(chatA), aborts.has(chatB), aborts.has(null)]);
            });
        });
        try {
            flushSync();
            expect(seen).toEqual([[false, false, false]]);
            const a = aborts.begin(chatA);
            flushSync();
            expect(seen.at(-1)).toEqual([true, false, false]);
            const b = aborts.begin(chatB);
            flushSync();
            expect(seen.at(-1)).toEqual([true, true, false]);
            a.release();
            flushSync();
            expect(seen.at(-1)).toEqual([false, true, false]);
            b.release();
            flushSync();
            expect(seen.at(-1)).toEqual([false, false, false]);
            expect(seen).toHaveLength(5);
        } finally {
            stop();
        }
    });
});
