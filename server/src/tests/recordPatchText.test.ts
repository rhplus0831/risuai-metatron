import { describe, expect, it } from "vitest";
import { diffRecordText } from "../data/recordPatchText.ts";

// Only representations unreachable through the store's canonical JSON writer belong here.
// Ordinary feed diffs are exercised through createResourceStore in resourcePatchParts.test.ts.
describe("noncanonical stored text", () => {
    it("ignores JSON whitespace and number spellings while preserving real field and item changes", () => {
        const old = ' \n { "keep" : {"b": [true, null, "escaped \\\" } ]"], "a": 0}, "n": -0, "gone": 1 }\t';
        const next = JSON.stringify({ keep: JSON.parse(old).keep, n: 0, fresh: false }, null, 2).replace(
            '"n": 0',
            '"n": 0e0',
        );
        expect(diffRecordText(old, next, JSON.parse(old), JSON.parse(next))).toEqual({
            set: { fresh: false },
            remove: ["gone"],
        });
        const before = ' [ { "id": "a", "name": "A", "keep": { "x": [1,2] } }, { "id": "b", "old": true } ] ';
        const after =
            '\n[ {"id":"b", "fresh":null}, { "id":"c", "name":"C" }, {"id":"a", "name":"A", "keep":{"x":[1, 2]}} ]\t';
        expect(diffRecordText(before, after, JSON.parse(before), JSON.parse(after))).toEqual({
            items: [{ id: "c", name: "C" }],
            changes: [{ id: "b", set: { fresh: null }, remove: ["old"] }],
            order: ["b", "c", "a"],
        });
    });
    it.each([
        {
            shape: "object",
            old: { keep: 1, gone: true },
            next: { keep: 1, fresh: false },
            expected: { set: { fresh: false }, remove: ["gone"] },
        },
        {
            shape: "array",
            old: [{ id: "a", name: "A" }],
            next: [{ id: "a", name: "B" }, { id: "b" }],
            expected: {
                items: [{ id: "b" }],
                changes: [{ id: "a", set: { name: "B" }, remove: [] }],
                order: ["a", "b"],
            },
        },
    ])("falls back to the supplied $shape values if their text cannot be scanned", ({ shape, old, next, expected }) => {
        const broken = shape === "object" ? '{"keep" ? 1}' : '[{"id" ? "a"}]';
        expect(diffRecordText(broken, JSON.stringify(next), old, next)).toEqual(expected);
    });
});
