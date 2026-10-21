// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stripThoughtsBlock } from "../prompt/thoughts.ts";
import { parseChatML } from "../prompt/triggers.ts";

// Prompt assembly and the display trigger's ChatML parser strip `<Thoughts>` blocks with a linear
// scan that keeps the semantics of the former `/<Thoughts>(.+)<\/Thoughts>/gms`: at most one block,
// from the first opening tag to the last closing tag, with at least one character inside. The former
// regex backtracked once per unmatched opening tag (quadratic: about 2.4 s for 200 KB, minutes for 1
// MB), so the large case below fails by Vitest's timeout on that implementation and needs no
// wall-clock assertion.

describe("stripThoughtsBlock", () => {
    it.each([
        ["no tags", "plain\ntext", "plain\ntext", []],
        ["one block", "a<Thoughts>x</Thoughts>b", "ab", ["x"]],
        ["a block spanning lines", "a<Thoughts>x\ny</Thoughts>b", "ab", ["x\ny"]],
        ["an empty block stays", "a<Thoughts></Thoughts>b", "a<Thoughts></Thoughts>b", []],
        [
            "two blocks become one capture",
            "a<Thoughts>x</Thoughts>b<Thoughts>y</Thoughts>c",
            "ac",
            ["x</Thoughts>b<Thoughts>y"],
        ],
        ["nested blocks", "a<Thoughts>x<Thoughts>y</Thoughts>z</Thoughts>b", "ab", ["x<Thoughts>y</Thoughts>z"]],
        ["an unmatched opening", "a<Thoughts>x", "a<Thoughts>x", []],
        ["an unmatched closing", "a</Thoughts>x", "a</Thoughts>x", []],
        ["a closing before the opening", "</Thoughts>a<Thoughts>", "</Thoughts>a<Thoughts>", []],
        ["a trailing unmatched opening", "a<Thoughts>x</Thoughts>b<Thoughts>", "ab<Thoughts>", ["x"]],
        [
            "an empty block before a block",
            "<Thoughts></Thoughts>a<Thoughts>x</Thoughts>",
            "",
            ["</Thoughts>a<Thoughts>x"],
        ],
        ["case-sensitive tags", "<thoughts>x</Thoughts>", "<thoughts>x</Thoughts>", []],
        ["no attributes", "<Thoughts foo>x</Thoughts>", "<Thoughts foo>x</Thoughts>", []],
    ])("%s", (_name, input, text, thoughts) => {
        expect(stripThoughtsBlock(input)).toEqual({ text, thoughts });
    });

    it("leaves a megabyte of unmatched opening tags unchanged without backtracking", () => {
        const input = "<Thoughts>".repeat(100_000);
        expect(input.length).toBe(1_000_000);
        const result = stripThoughtsBlock(input);
        expect(result.thoughts).toEqual([]);
        expect(result.text).toBe(input);
    });

    it("keeps one block among many unmatched openings, first opening to last closing", () => {
        const input = "<Thoughts>".repeat(50_000) + "x</Thoughts>" + "<Thoughts>".repeat(50_000);
        const result = stripThoughtsBlock(input);
        expect(result.text).toBe("<Thoughts>".repeat(50_000));
        expect(result.thoughts).toEqual(["<Thoughts>".repeat(49_999) + "x"]);
    });
});

describe("parseChatML thoughts", () => {
    const identity = (text: string) => text;

    it("moves a message's block into its thoughts", () => {
        const data = "<|im_start|>assistant<|im_sep|><Thoughts>plan</Thoughts>hi<|im_end|>";
        expect(parseChatML(data, identity)).toEqual([{ role: "assistant", content: "hi", thoughts: ["plan"] }]);
    });

    it("keeps unmatched openings in the content and parses them in linear time", () => {
        const body = "<Thoughts>".repeat(100_000);
        const data = `<|im_start|>user<|im_sep|>${body}<|im_end|>`;
        expect(parseChatML(data, identity)).toEqual([{ role: "user", content: body, thoughts: [] }]);
    });
});
