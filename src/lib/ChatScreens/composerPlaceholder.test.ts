import { describe, expect, it } from "vitest";
import { language } from "src/lang";
import { composerPlaceholder } from "./composerPlaceholder";

const names = { setupNeeded: false, playground: false, persona: "철수", character: "아리아" };

describe("composerPlaceholder", () => {
    it("names the persona and the character", () => {
        expect(composerPlaceholder(names)).toBe("철수 → 아리아");
    });

    it("keeps the arrow's leading space when the persona has no name", () => {
        expect(composerPlaceholder({ ...names, persona: "" })).toBe(" → 아리아");
        expect(composerPlaceholder({ ...names, persona: undefined })).toBe(" → 아리아");
    });

    it("shortens a long persona, counting an emoji as one character, and keeps the character whole", () => {
        expect(composerPlaceholder({ ...names, persona: "가".repeat(8) })).toBe(`${"가".repeat(8)} → 아리아`);
        expect(composerPlaceholder({ ...names, persona: "😀".repeat(9), character: "나".repeat(40) })).toBe(
            `${"😀".repeat(8)}… → ${"나".repeat(40)}`,
        );
    });

    it("is empty in the playground", () => {
        expect(composerPlaceholder({ ...names, playground: true })).toBe("");
    });

    it("asks for the setup before anything else, also in the playground", () => {
        expect(composerPlaceholder({ ...names, setupNeeded: true })).toBe(language.chatBinding.setupNeeded);
        expect(composerPlaceholder({ ...names, setupNeeded: true, playground: true })).toBe(
            language.chatBinding.setupNeeded,
        );
    });
});
