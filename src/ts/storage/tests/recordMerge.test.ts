import { describe, expect, it } from "vitest";
import { mergeItemCollection } from "../recordMerge";

describe("collection membership after merging", () => {
    it("refuses disjoint deletions that empty a required collection but permits an optional collection to become empty", () => {
        const a = { id: "a", name: "A" };
        const b = { id: "b", name: "B" };
        // Each side kept one item, but together their deletions remove both.
        expect(mergeItemCollection("presets", [a, b], [a], [b])).toBeNull();
        expect(mergeItemCollection("togglePresets", [a, b], [a], [b])).toEqual([]);
    });
});
