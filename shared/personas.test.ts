import { describe, expect, it } from "vitest";
import { personaNoteFirstLine } from "./personas.ts";

// The persona list shows a multi-line persona note on one line: its first non-blank line, trimmed.
describe("personaNoteFirstLine", () => {
    it("takes the first non-blank line, trimmed, across line ending styles", () => {
        expect(personaNoteFirstLine("Fantasy runs\nsecond line")).toBe("Fantasy runs");
        expect(personaNoteFirstLine("\r\n   \r\n  Modern AU  \r\nmore")).toBe("Modern AU");
        expect(personaNoteFirstLine("\r  old mac\rnext")).toBe("old mac");
        expect(personaNoteFirstLine("single")).toBe("single");
    });

    it("gives an empty string for a blank, missing, or non-string note", () => {
        expect(personaNoteFirstLine("")).toBe("");
        expect(personaNoteFirstLine(" \n\t\n ")).toBe("");
        expect(personaNoteFirstLine(undefined)).toBe("");
        expect(personaNoteFirstLine(3)).toBe("");
    });
});
