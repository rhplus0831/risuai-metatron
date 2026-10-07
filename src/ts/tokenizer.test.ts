import { describe, expect, it, vi } from "vitest";

import { activePreset } from "./storage/settingsViews.svelte";
import { installFlatDatabase } from "./storage/tests/installFlatDatabase";
import { encode } from "./tokenizer";

const mocks = vi.hoisted(() => {
    const fixture = {
        aiModel: "hf:::Xenova/opt-350m",
        currentPluginProvider: "",
        customTokenizer: "",
        enableCustomFlags: false,
        googleClaudeTokenizing: false,
        useTokenizerCaching: false,
    };
    return { fixture, constructedWith: [] as string[] };
});

// `database.svelte` (reached through the records' graph) re-exports the asset writer.
vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: vi.fn(),
    saveAsset: vi.fn(),
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

// The fixture installed into the records, since the tokenizer reads the settings through the record
// views (Phase 6 slice 7): its root preset fields (`aiModel`, `currentPluginProvider`) become the one
// preset's, the others the `providers` section's. A case changes them through the views.
installFlatDatabase({ ...mocks.fixture }, "tokenizer-preset");

describe("encode", () => {
    it("tokenizes WebLLM models (LLMTokenizer.Local) with the default tiktoken encoder", async () => {
        // The installed preset is what the tokenizer reads (not a default of an absent field).
        expect(activePreset.aiModel).toBe(mocks.fixture.aiModel);
        const result = await encode("hi");

        expect(Array.from(result)).toEqual([104, 105]);
        expect(mocks.constructedWith).toEqual(["cl100k_base"]);
    });
});

describe("the routing shared with the server (Phase 5 slice 4)", () => {
    const base = { ...mocks.fixture };
    const restore = () => {
        activePreset.aiModel = base.aiModel;
        activePreset.currentPluginProvider = base.currentPluginProvider;
    };

    it("a legacy plugin provider without options counts with o200k_base; a `custom` tokenizer without its function answers [0]", async () => {
        const { pluginHooks } = await import("./plugins/pluginHooks");
        try {
            activePreset.aiModel = "custom";
            activePreset.currentPluginProvider = "absent";
            expect(Array.from(await encode("hi"))).toEqual([104, 105]);
            expect(mocks.constructedWith.at(-1)).toBe("o200k_base");
            pluginHooks.providerOptions.set("p", { tokenizer: "custom" } as any);
            activePreset.currentPluginProvider = "p";
            expect(Array.from(await encode("hi"))).toEqual([0]);
            pluginHooks.providerOptions.set("p", { tokenizer: "custom", tokenizerFunc: async () => [7, 8, 9] } as any);
            expect(Array.from(await encode("hi"))).toEqual([7, 8, 9]);
        } finally {
            pluginHooks.providerOptions.delete("p");
            restore();
        }
    });
});

describe("ChatTokenizer", () => {
    it("is the shared arithmetic over the client's encode, inlay support, and vision quality", async () => {
        const { ChatTokenizer } = await import("./tokenizer");
        const counter = new ChatTokenizer(3, "name");
        // The mocked tiktoken counts one id per character; inlay images are unsupported here, so an
        // image counts as the additional tokens.
        expect(
            await counter.tokenizeChat({
                role: "user",
                content: "hello",
                name: "ab",
                multimodals: [{ type: "image", base64: "", width: 512, height: 512 }],
            }),
        ).toBe(5 + 3 + (2 + 1) + 3);
        expect(await new ChatTokenizer(1, "noName").tokenizeChats([{ role: "user", content: "ab", name: "x" }])).toBe(
            3,
        );
    });
});
