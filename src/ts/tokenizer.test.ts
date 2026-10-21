import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL_PROFILE_ID, normalizeModelProfile } from "../../shared/presets";
import { activeMainProfile, settings } from "./storage/settingsViews.svelte";
import { installFlatDatabase } from "./storage/tests/installFlatDatabase";
import { encode } from "./tokenizer";

const mocks = vi.hoisted(() => {
    const fixture = {
        modelId: "hf:::Xenova/opt-350m",
        currentPluginProvider: "",
        customTokenizer: "",
        enableCustomFlags: false,
    };
    return { fixture, constructedWith: [] as string[], supportsImages: false };
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
    supportsInlayImage: () => mocks.supportsImages,
}));

vi.mock("@dqbd/tiktoken", () => ({
    Tiktoken: class {
        freed = false;
        constructor(bpeRanks: string) {
            mocks.constructedWith.push(bpeRanks);
        }
        encode(text: string) {
            // The WASM handle is gone once freed.
            if (this.freed) {
                throw new Error("encode on a freed Tiktoken");
            }
            return Array.from(text, (char) => char.codePointAt(0) ?? 0);
        }
        free() {
            this.freed = true;
        }
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
// views: its model fields (`modelId`, `currentPluginProvider`) are the main profile of the one
// model preset, the tokenizer toggles the `providers` section's. A case changes them through the
// views.
installFlatDatabase(
    {
        modelProfiles: [normalizeModelProfile({ ...mocks.fixture }, { id: DEFAULT_MODEL_PROFILE_ID })],
        googleClaudeTokenizing: false,
        useTokenizerCaching: false,
    },
    "tokenizer-preset",
);

describe("encode", () => {
    it("tokenizes WebLLM models (LLMTokenizer.Local) with the default tiktoken encoder", async () => {
        // The installed main profile is what the tokenizer reads (not a default of an absent field).
        expect(activeMainProfile.modelId).toBe(mocks.fixture.modelId);
        const result = await encode("hi");

        expect(Array.from(result)).toEqual([104, 105]);
        expect(mocks.constructedWith).toEqual(["cl100k_base"]);
    });
});

describe("the routing shared with the server", () => {
    const base = { ...mocks.fixture };
    const restore = () => {
        activeMainProfile.modelId = base.modelId;
        activeMainProfile.currentPluginProvider = base.currentPluginProvider;
    };

    it("a legacy plugin provider without options counts with o200k_base; a `custom` tokenizer without its function answers [0]", async () => {
        const { pluginHooks } = await import("./plugins/pluginHooks");
        try {
            activeMainProfile.modelId = "custom";
            activeMainProfile.currentPluginProvider = "absent";
            expect(Array.from(await encode("hi"))).toEqual([104, 105]);
            expect(mocks.constructedWith.at(-1)).toBe("o200k_base");
            pluginHooks.providerOptions.set("p", { tokenizer: "custom" } as any);
            activeMainProfile.currentPluginProvider = "p";
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
    it("uses the main profile and its OpenRouter or NanoGPT wire model for image tokens", async () => {
        const { ChatTokenizer } = await import("./tokenizer");
        const saved = {
            modelId: activeMainProfile.modelId,
            openrouterRequestModel: activeMainProfile.openrouterRequestModel,
            nanogptRequestModel: activeMainProfile.nanogptRequestModel,
            quality: settings.providers.gptVisionQuality,
        };
        try {
            mocks.supportsImages = true;
            settings.providers.gptVisionQuality = "low";
            const counter = new ChatTokenizer(3, "noName");
            const image = { type: "image" as const, base64: "", width: 1024, height: 1024 };
            activeMainProfile.modelId = "gpt4om";
            expect(counter.tokenizeMultiModal(image)).toBe(2833);
            activeMainProfile.openrouterRequestModel = "openai/gpt-4o-mini";
            activeMainProfile.modelId = "openrouter";
            expect(counter.tokenizeMultiModal(image)).toBe(2833);
            activeMainProfile.nanogptRequestModel = "openai/gpt-5.5";
            activeMainProfile.modelId = "nanogpt";
            expect(counter.tokenizeMultiModal(image)).toBe(308);
        } finally {
            activeMainProfile.modelId = saved.modelId;
            activeMainProfile.openrouterRequestModel = saved.openrouterRequestModel;
            activeMainProfile.nanogptRequestModel = saved.nanogptRequestModel;
            settings.providers.gptVisionQuality = saved.quality;
            mocks.supportsImages = false;
        }
    });

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

describe("tiktoken parsers (crosscheck row 14)", () => {
    it("counts for both encoders at once, neither on a parser the other count freed", async () => {
        const base = { ...mocks.fixture };
        try {
            // A cl100k_base parser is loaded (the WebLLM model of the fixture).
            expect(Array.from(await encode("a"))).toEqual([97]);
            // An o200k_base count starts loading its parser; a cl100k_base count runs meanwhile.
            activeMainProfile.modelId = "custom";
            activeMainProfile.currentPluginProvider = "absent";
            const o200k = encode("hi");
            activeMainProfile.modelId = base.modelId;
            activeMainProfile.currentPluginProvider = base.currentPluginProvider;
            const cl100k = encode("yo");
            expect((await Promise.all([o200k, cl100k])).map((tokens) => Array.from(tokens))).toEqual([
                [104, 105],
                [121, 111],
            ]);
            // Both stay loaded: switching back and forth loads nothing more.
            const built = mocks.constructedWith.length;
            activeMainProfile.modelId = "custom";
            activeMainProfile.currentPluginProvider = "absent";
            expect(Array.from(await encode("hi"))).toEqual([104, 105]);
            expect(mocks.constructedWith.length).toBe(built);
        } finally {
            activeMainProfile.modelId = base.modelId;
            activeMainProfile.currentPluginProvider = base.currentPluginProvider;
        }
    });
});
