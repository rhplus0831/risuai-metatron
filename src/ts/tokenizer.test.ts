import { describe, expect, it, vi } from "vitest";

import { encode } from "./tokenizer";

const mocks = vi.hoisted(() => ({
    db: {
        aiModel: "hf:::Xenova/opt-350m",
        currentPluginProvider: "",
        customTokenizer: "",
        enableCustomFlags: false,
        googleClaudeTokenizing: false,
        useTokenizerCaching: false,
    },
    constructedWith: [] as string[],
}));

vi.mock("src/ts/storage/database.svelte", () => ({
    getCurrentCharacter: () => null,
    getDatabase: () => mocks.db,
}));

vi.mock("src/ts/stores.svelte", () => ({
    DBState: { db: mocks.db },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: vi.fn(),
}));

vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: (text: string) => text,
}));

vi.mock("src/ts/process/files/inlays", () => ({
    supportsInlayImage: () => false,
}));

vi.mock("@dqbd/tiktoken", () => ({
    Tiktoken: class {
        constructor(bpeRanks: string) {
            mocks.constructedWith.push(bpeRanks);
        }
        encode(text: string) {
            return Array.from(text, (char) => char.codePointAt(0) ?? 0);
        }
        free() {}
    },
}));

vi.mock("@dqbd/tiktoken/encoders/cl100k_base.json", () => ({
    bpe_ranks: "cl100k_base",
    special_tokens: {},
    pat_str: "",
}));

vi.mock("src/etc/o200k_base.json", () => ({
    bpe_ranks: "o200k_base",
    special_tokens: {},
    pat_str: "",
}));

describe("encode", () => {
    it("tokenizes WebLLM models (LLMTokenizer.Local) with the default tiktoken encoder", async () => {
        const result = await encode("hi");

        expect(Array.from(result)).toEqual([104, 105]);
        expect(mocks.constructedWith).toEqual(["cl100k_base"]);
    });
});
