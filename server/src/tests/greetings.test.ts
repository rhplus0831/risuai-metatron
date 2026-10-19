import { describe, expect, it } from "vitest";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";
import type { Database } from "../../../shared/database.ts";
import { greetingIndex, greetingText, nextGreetingIndex, previousGreetingIndex } from "../../../shared/greetings.ts";
import { createNodeCbsHost } from "./cbsHost.ts";

// A chat's greeting index (`fmIndex`) as every converted reader reads it (`shared/greetings.ts`): a
// missing, non-integer, or out-of-range index is the main first message (-1).

const character = { firstMessage: "main", alternateGreetings: ["alt0", "alt1"] };
const invalid = [undefined, null, "0", 1.5, Number.NaN, -2, 2, 7];

describe("greetingIndex and greetingText", () => {
    it("keeps -1 and each alternate's index, and reads every other value as -1", () => {
        expect([-1, 0, 1].map((index) => greetingIndex(index, 2))).toEqual([-1, 0, 1]);
        expect([-1, 0, 1].map((index) => greetingText(character, index))).toEqual(["main", "alt0", "alt1"]);
        for (const index of invalid) {
            expect(greetingIndex(index, 2), String(index)).toBe(-1);
            expect(greetingText(character, index), String(index)).toBe("main");
        }
        // A character without alternates (a group has none) shows its first message for any index.
        expect(greetingText({ firstMessage: "group" }, 0)).toBe("group");
        expect(greetingText({ firstMessage: "solo", alternateGreetings: [] }, 0)).toBe("solo");
    });

    it("rerolls forward and back from the normalized index, wrapping through -1", () => {
        expect([-1, 0, 1].map((index) => nextGreetingIndex(index, 2))).toEqual([0, 1, -1]);
        expect([-1, 0, 1].map((index) => previousGreetingIndex(index, 2))).toEqual([1, -1, 0]);
        // A stale index starts from the main first message, so the next page is the first alternate and
        // the previous one the last; neither lands out of range again.
        expect(nextGreetingIndex(7, 2)).toBe(0);
        expect(previousGreetingIndex(7, 2)).toBe(1);
        expect(nextGreetingIndex(undefined, 2)).toBe(0);
        // Without alternates both stay on the first message.
        expect(nextGreetingIndex(-1, 0)).toBe(-1);
        expect(previousGreetingIndex(-1, 0)).toBe(-1);
        expect(previousGreetingIndex(3, 0)).toBe(-1);
    });
});

describe("the CBS greeting reads", () => {
    function parse(fmIndex: unknown, text: string) {
        const db = {
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    ...character,
                    chatPage: 0,
                    chats: [{ id: "k", message: [], fmIndex, scriptstate: {} }],
                },
            ],
            personas: [],
        } as unknown as Database;
        return createCbsEvaluator(createNodeCbsHost(db, { selectedCharID: 0 })).risuChatParser(text);
    }

    it("previouscharchat and history answer the chosen greeting, and the first message for an index out of range", () => {
        expect(parse(1, "{{previouscharchat}}")).toBe("alt1");
        expect(parse(1, "{{history}}")).toContain("alt1");
        for (const index of [2, 9, -2, undefined]) {
            expect(parse(index, "{{previouscharchat}}"), String(index)).toBe("main");
            expect(parse(index, "{{history}}"), String(index)).toContain("main");
        }
    });
});
