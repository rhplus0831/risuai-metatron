import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LLMTokenizer } from "../../shared/llm";
import { DEFAULT_MODEL_PROFILE_ID, normalizeModelPreset, normalizeModelProfile } from "../../shared/presets";
import type { TabTokenScope } from "../../shared/tokenizerChoice";
import { getModelInfo } from "./model/modellist";
import { pluginHooks } from "./plugins/pluginHooks";
import type { character, Chat } from "./storage/database.svelte";
import { activeMainProfile, settings } from "./storage/settingsViews.svelte";
import { installFlatDatabase } from "./storage/tests/installFlatDatabase";
import {
    ChatTokenizer,
    countTokens,
    countTokensInScope,
    encodeWithTokenizer,
    getCharToken,
    getChatToken,
    jobTokenScope,
    tabTokenScope,
    tokenScopeKey,
    tokenize,
    tokenizeAccurate,
} from "./tokenizer";

const mocks = vi.hoisted(() => ({
    authFetch: vi.fn<typeof import("./storage/serverAuth").authFetch>(),
}));

vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

type CountBody = { scope: TabTokenScope; texts: string[] };
const countBodies = () => mocks.authFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as CountBody);

function serveCounts(count: (text: string) => number | null) {
    mocks.authFetch.mockImplementation(async (path, init) => {
        expect(path).toBe("/api/tokens/count");
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
        const body = JSON.parse(String(init?.body)) as CountBody;
        return Response.json({ counts: body.texts.map(count) });
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.authFetch.mockReset();
    installFlatDatabase(
        {
            modelProfiles: [
                normalizeModelProfile({ modelId: "hf:::Xenova/opt-350m" }, { id: DEFAULT_MODEL_PROFILE_ID }),
            ],
            googleClaudeTokenizing: false,
            useTokenizerCaching: false,
        },
        "tokenizer-preset",
    );
    serveCounts(() => 1);
});

afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    pluginHooks.providerOptions.delete("tokenizer-test-plugin");
});

describe("server token counts", () => {
    it("coalesces same-tick calls by scope and returns each text's server count", async () => {
        const answers: Record<string, number> = { alpha: 7, beta: 2, GAMMA: 11, delta: 5 };
        serveCounts((text) => answers[text]);
        const counts = Promise.all([
            countTokens("alpha"),
            tokenize("beta"),
            tokenizeAccurate("{{upper::gamma}}{{slot}}"),
        ]);
        activeMainProfile.modelId = "gpt4om";
        const otherScope = countTokens("delta");
        expect(mocks.authFetch).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(await counts).toEqual([7, 2, 11]);
        expect(await otherScope).toBe(5);
        expect(countBodies().map(({ scope, texts }) => [scope.aiModel, texts])).toEqual([
            ["hf:::Xenova/opt-350m", ["alpha", "beta", "GAMMA"]],
            ["gpt4om", ["delta"]],
        ]);
    });

    it("splits a batch after 256 texts without losing their results", async () => {
        const texts = Array.from({ length: 257 }, (_, i) => `text-${i}`);
        serveCounts((text) => Number(text.slice(5)) + 10);
        const counts = Promise.all(texts.map((text) => countTokens(text)));
        await vi.runAllTimersAsync();

        expect(countBodies().map(({ texts }) => texts)).toEqual([texts.slice(0, 256), texts.slice(256)]);
        expect(await counts).toEqual(Array.from({ length: 257 }, (_, i) => i + 10));
    });

    it("splits at one MiB of serialized UTF-8 text, including JSON escaping", async () => {
        // Each quoted JSON string is 524,288 bytes: 3 bytes per Korean character, 2 per newline,
        // and 2 quotes. Two fit exactly; the final text must start a new request.
        const half = "한\n".repeat(104_857) + "a";
        const texts = [half, half, "tail"];
        serveCounts((text) => (text === "tail" ? 3 : 17));
        const counts = Promise.all(texts.map((text) => countTokens(text)));
        await vi.runAllTimersAsync();

        expect(countBodies().map(({ texts }) => texts.length)).toEqual([2, 1]);
        expect(countBodies().flatMap(({ texts }) => texts)).toEqual(texts);
        expect(await counts).toEqual([17, 17, 3]);
    });

    it("reuses counts only for the same scope while caching is enabled", async () => {
        settings.providers.useTokenizerCaching = true;
        serveCounts(() => 23);
        const first = countTokens("cached text");
        await vi.runAllTimersAsync();
        expect(await first).toBe(23);
        const cached = countTokens("cached text");
        await vi.runAllTimersAsync();
        expect(await cached).toBe(23);
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);

        activeMainProfile.modelId = "gpt4om";
        serveCounts(() => 31);
        const differentScope = countTokens("cached text");
        await vi.runAllTimersAsync();
        expect(await differentScope).toBe(31);
        expect(mocks.authFetch).toHaveBeenCalledTimes(2);

        settings.providers.useTokenizerCaching = false;
        for (const answer of [41, 43]) {
            serveCounts(() => answer);
            const uncached = countTokens("cached text");
            await vi.runAllTimersAsync();
            expect(await uncached).toBe(answer);
        }
        expect(mocks.authFetch).toHaveBeenCalledTimes(4);
    });

    it("evicts the least recently used count when the cache exceeds 1500 texts", async () => {
        settings.providers.useTokenizerCaching = true;
        const texts = Array.from({ length: 1500 }, (_, i) => `lru-${i}`);
        const initial = Promise.all(texts.map((text) => countTokens(text)));
        await vi.runAllTimersAsync();
        await initial;
        mocks.authFetch.mockClear();

        const refreshed = countTokens(texts[0]);
        await vi.runAllTimersAsync();
        expect(await refreshed).toBe(1);
        expect(mocks.authFetch).not.toHaveBeenCalled();
        const extra = countTokens("lru-extra");
        await vi.runAllTimersAsync();
        await extra;
        const retained = countTokens(texts[0]);
        const evicted = countTokens(texts[1]);
        await vi.runAllTimersAsync();
        expect(await retained).toBe(1);
        expect(await evicted).toBe(1);
        expect(countBodies().map(({ texts }) => texts)).toEqual([["lru-extra"], ["lru-1"]]);
    });

    it("isolates signal-bearing counts and rejects aborts with the signal's reason", async () => {
        const controller = new AbortController();
        const reason = new Error("editor superseded");
        mocks.authFetch.mockImplementation(async (_path, init) => {
            if (init?.signal) {
                return new Promise<Response>((_resolve, reject) => {
                    init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                        once: true,
                    });
                });
            }
            return Response.json({ counts: [13, 17] });
        });
        const ordinary = Promise.all([countTokens("first"), countTokens("second")]);
        const aborted = countTokens("editing", undefined, controller.signal);
        const rejection = expect(aborted).rejects.toBe(reason);
        await vi.runAllTimersAsync();
        expect(countBodies().map(({ texts }) => texts)).toEqual([["editing"], ["first", "second"]]);
        expect(mocks.authFetch.mock.calls[0][1]?.signal).toBe(controller.signal);
        expect(await ordinary).toEqual([13, 17]);

        controller.abort(reason);
        await rejection;
        const calls = mocks.authFetch.mock.calls.length;
        await expect(countTokens("never sent", undefined, controller.signal)).rejects.toBe(reason);
        await vi.runAllTimersAsync();
        expect(mocks.authFetch).toHaveBeenCalledTimes(calls);
    });

    it("rejects only the text whose server count is null", async () => {
        const answers: Record<string, number | null> = { before: 5, "<|endoftext|>": null, after: 9 };
        serveCounts((text) => answers[text]);
        const results = Promise.allSettled(Object.keys(answers).map((text) => countTokens(text)));
        await vi.runAllTimersAsync();

        expect(await results).toEqual([
            { status: "fulfilled", value: 5 },
            { status: "rejected", reason: expect.any(Error) },
            { status: "fulfilled", value: 9 },
        ]);
        expect(countBodies().map(({ texts }) => texts)).toEqual([["before", "<|endoftext|>", "after"]]);
    });

    it("sends the captured preset's complete tokenizer scope without calling its legacy plugin tokenizer", async () => {
        const tokenizerFunc = vi.fn(async () => [101, 102, 103]);
        pluginHooks.providerOptions.set("tokenizer-test-plugin", { tokenizer: "custom", tokenizerFunc });
        installFlatDatabase({
            botPresets: [
                { id: "selected", name: "Selected" },
                { id: "captured", name: "Captured" },
            ],
            modelPresets: [
                normalizeModelPreset({ mainSlot: { profileId: "selected-profile" } }, { id: "selected" }),
                normalizeModelPreset({ mainSlot: { profileId: "plugin-profile" } }, { id: "captured" }),
            ],
            modelProfiles: [
                normalizeModelProfile({ modelId: "gpt4om", customTokenizer: "mistral" }, { id: "selected-profile" }),
                normalizeModelProfile(
                    { modelId: "custom", currentPluginProvider: "tokenizer-test-plugin", customTokenizer: "llama" },
                    { id: "plugin-profile" },
                ),
            ],
            googleClaudeTokenizing: true,
            useTokenizerCaching: true,
        });
        const scope = { presetId: "captured", modelPresetId: "captured" };
        const expected: TabTokenScope = {
            aiModel: "custom",
            currentPluginProvider: "tokenizer-test-plugin",
            customTokenizer: "llama",
            modelTokenizer: LLMTokenizer.Unknown,
            modelInternalID: "custom",
            pluginTokenizer: "custom",
            googleClaudeTokenizing: true,
            useTokenizerCaching: true,
        };
        expect(activeMainProfile.modelId).toBe("gpt4om");
        expect(tabTokenScope(scope)).toEqual(expected);
        const { modelInternalID: _internalID, ...withoutInternalID } = expected;
        expect(tabTokenScope(scope, { ...getModelInfo("custom"), internalID: undefined })).toEqual(withoutInternalID);
        const pluginCount = countTokens("plugin scope", scope);
        const selectedCount = countTokens("selected scope");
        await vi.runAllTimersAsync();

        expect(await pluginCount).toBe(1);
        expect(await selectedCount).toBe(1);
        expect(countBodies()).toEqual([
            { scope: expected, texts: ["plugin scope"] },
            {
                scope: {
                    aiModel: "gpt4om",
                    currentPluginProvider: "",
                    customTokenizer: "mistral",
                    modelTokenizer: LLMTokenizer.tiktokenO200Base,
                    modelInternalID: "gpt-4o-mini",
                    pluginTokenizer: "none",
                    googleClaudeTokenizing: true,
                    useTokenizerCaching: true,
                },
                texts: ["selected scope"],
            },
        ]);
        expect(tokenizerFunc).not.toHaveBeenCalled();
    });

    it("counts all 51 chat messages in one request using content alone", async () => {
        const texts = Array.from({ length: 51 }, (_, i) => `message-${i}`);
        serveCounts((text) => Number(text.slice(8)) + 1);
        const total = getChatToken({
            message: texts.map((data, i) => ({ data, role: i % 2 ? "char" : "user", saying: "Bot" })),
        } as Chat);
        await vi.runAllTimersAsync();

        expect(await total).toBe((51 * 52) / 2);
        expect(countBodies().map(({ texts }) => texts)).toEqual([texts]);
    });

    it("counts character fields and filtered lore together while preserving their separate totals", async () => {
        const texts = ["Ada desc", "kind Ada", "scene", "Ada lore\nmore", "second"];
        const answers = [7, 3, 5, 11, 13];
        serveCounts((text) => answers[texts.indexOf(text)]);
        const total = getCharToken({
            type: "character",
            name: "Ada",
            desc: "{{char}} desc",
            personality: "kind <char>",
            scenario: "scene",
            globalLore: [{ content: "@@activate\n\n{{char}} lore\nmore" }, { content: "second" }],
        } as character);
        await vi.runAllTimersAsync();

        expect(await total).toEqual({ persistant: 7 + 3 + 5, dynamic: 11 + 13 });
        expect(countBodies().map(({ texts }) => texts)).toEqual([texts]);
    });

    it("posts the playground tokenizer and text to the encode route and returns its ids", async () => {
        mocks.authFetch.mockResolvedValue(Response.json({ ids: [71, 0, 902] }));
        expect(await encodeWithTokenizer("playground text", "llama3")).toEqual([71, 0, 902]);
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);
        expect(mocks.authFetch.mock.calls[0]).toEqual([
            "/api/tokens/encode",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tokenizer: "llama3", text: "playground text" }),
            }),
        ]);
    });
});

describe("ChatTokenizer", () => {
    it("uses the main profile and its OpenRouter or NanoGPT wire model for image tokens", () => {
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
    });

    it("keeps the shared arithmetic over server counts, names, thoughts, and unsupported images", async () => {
        const answers: Record<string, number> = { hello: 7, ab: 2, thought: 11 };
        serveCounts((text) => answers[text]);
        const named = new ChatTokenizer(3, "name").tokenizeChat(
            {
                role: "user",
                content: "hello",
                name: "ab",
                thoughts: ["thought"],
                multimodals: [{ type: "image", base64: "", width: 512, height: 512 }],
            },
            { countThoughts: true },
        );
        const unnamed = new ChatTokenizer(1, "noName").tokenizeChats([
            { role: "user", content: "ab", name: "ignored" },
        ]);
        await vi.runAllTimersAsync();

        expect(await named).toBe(7 + 3 + (2 + 1) + 3 + (11 + 1));
        expect(await unnamed).toBe(2 + 1);
        expect(countBodies().flatMap(({ texts }) => texts)).toEqual(
            expect.arrayContaining(["hello", "ab", "ab", "thought"]),
        );
        expect(countBodies().flatMap(({ texts }) => texts)).not.toContain("ignored");
    });
});

describe("job scope counts", () => {
    it("jobTokenScope is the tab scope without the plugin provider's tokenizer", () => {
        pluginHooks.providerOptions.set("tokenizer-test-plugin", { tokenizer: "custom", tokenizerFunc: vi.fn() });
        activeMainProfile.modelId = "custom";
        activeMainProfile.currentPluginProvider = "tokenizer-test-plugin";
        const tab = tabTokenScope();
        expect(tab.pluginTokenizer).toBe("custom");
        expect(jobTokenScope()).toEqual({ ...tab, pluginTokenizer: "none" });
        expect(tokenScopeKey(jobTokenScope())).not.toBe(tokenScopeKey(tab));
        // Without a plugin provider the two scopes are one.
        activeMainProfile.modelId = "gpt4om";
        activeMainProfile.currentPluginProvider = "";
        expect(jobTokenScope()).toEqual(tabTokenScope());
    });

    it("countTokensInScope posts the captured scope after the selection changes, in the batch of same-scope counts", async () => {
        const answers: Record<string, number> = { captured: 4, tab: 6, late: 8, switched: 10 };
        serveCounts((text) => answers[text]);
        const captured = jobTokenScope();
        const first = countTokensInScope("captured", captured);
        const tab = countTokens("tab");
        activeMainProfile.modelId = "gpt4om";
        const late = countTokensInScope("late", captured);
        const switched = countTokens("switched");
        await vi.runAllTimersAsync();

        expect(await Promise.all([first, tab, late, switched])).toEqual([4, 6, 8, 10]);
        const bodies = countBodies();
        expect(bodies.map(({ texts }) => texts)).toEqual([["captured", "tab", "late"], ["switched"]]);
        expect(bodies[0].scope).toEqual(captured);
        expect(bodies[1].scope.aiModel).toBe("gpt4om");
    });

    it("countTokensInScope reuses a cached count only for the captured scope's key, and sends nothing for an aborted signal", async () => {
        settings.providers.useTokenizerCaching = true;
        const captured = jobTokenScope();
        serveCounts(() => 3);
        const first = countTokensInScope("cached", captured);
        await vi.runAllTimersAsync();
        expect(await first).toBe(3);
        const calls = mocks.authFetch.mock.calls.length;
        expect(await countTokensInScope("cached", captured)).toBe(3);
        expect(mocks.authFetch).toHaveBeenCalledTimes(calls);
        // Another model's captured scope has another key: the cache does not answer.
        activeMainProfile.modelId = "gpt4om";
        const other = countTokensInScope("cached", jobTokenScope());
        await vi.runAllTimersAsync();
        expect(await other).toBe(3);
        expect(mocks.authFetch).toHaveBeenCalledTimes(calls + 1);

        const reason = new Error("superseded");
        await expect(countTokensInScope("never sent", captured, AbortSignal.abort(reason))).rejects.toBe(reason);
        await vi.runAllTimersAsync();
        expect(mocks.authFetch).toHaveBeenCalledTimes(calls + 1);
    });
});
