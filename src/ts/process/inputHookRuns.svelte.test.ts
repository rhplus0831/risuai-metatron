import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import type { ChatRef } from "../storage/chatStore.svelte";
import { createInputHookRuns } from "./inputHookRuns.svelte";

const chatA: ChatRef = { chaId: "character-a", chatId: "story" };
const chatB: ChatRef = { chaId: "character-a", chatId: "other" };

describe("createInputHookRuns", () => {
    it("reserves one run per chat while two chats can run independently", () => {
        const runs = createInputHookRuns();
        expect(runs.kindOf(chatA)).toBeNull();
        const a = runs.begin(chatA, "draft");
        expect(a).not.toBeNull();
        expect(runs.begin({ ...chatA }, "btw")).toBeNull();
        const b = runs.begin(chatB, "btw");
        expect(b).not.toBeNull();
        const sameIdOtherOwner = runs.begin({ chaId: "character-b", chatId: "story" }, "draft");
        expect(sameIdOtherOwner).not.toBeNull();
        expect(runs.kindOf(chatA)).toBe("draft");
        expect(runs.kindOf(chatB)).toBe("btw");
        a!.end();
        expect(runs.kindOf(chatA)).toBeNull();
        expect(runs.kindOf(chatB)).toBe("btw");
        b!.end();
        expect(runs.kindOf(chatB)).toBeNull();
        sameIdOtherOwner!.end();
    });

    it("ends a run once and keeps a later run when an old end is called again", () => {
        const runs = createInputHookRuns();
        const older = runs.begin(chatA, "draft")!;
        older.end();
        older.end();
        expect(runs.kindOf(chatA)).toBeNull();
        const later = runs.begin(chatA, "btw");
        expect(later).not.toBeNull();
        older.end();
        expect(runs.kindOf(chatA)).toBe("btw");
        expect(runs.begin(chatA, "draft")).toBeNull();
        later!.end();
        expect(runs.kindOf(chatA)).toBeNull();
    });

    it("reactively reports each chat's kind and null for no chat", () => {
        const runs = createInputHookRuns();
        const seen: ("draft" | "btw" | null)[][] = [];
        const stop = $effect.root(() => {
            $effect(() => {
                seen.push([runs.kindOf(chatA), runs.kindOf(chatB), runs.kindOf(null)]);
            });
        });
        try {
            flushSync();
            expect(seen.at(-1)).toEqual([null, null, null]);
            const a = runs.begin(chatA, "draft")!;
            flushSync();
            expect(seen.at(-1)).toEqual(["draft", null, null]);
            const b = runs.begin(chatB, "btw")!;
            flushSync();
            expect(seen.at(-1)).toEqual(["draft", "btw", null]);
            a.end();
            flushSync();
            expect(seen.at(-1)).toEqual([null, "btw", null]);
            b.end();
            flushSync();
            expect(seen.at(-1)).toEqual([null, null, null]);
        } finally {
            stop();
        }
    });
});
