// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";

// Translation slice 1.2 (`docs/plan/translation.md`): the tab's LLM translator runs the selected
// preset's steps through the shared pipeline, each step one `requestChatData(..., "translate")`,
// and caches the result in `LLMTranslateCache` under `llm:<hash>:<source>`, the hash of the
// pipeline signature, the languages, and the translator note. Another prompt, preset, language, or
// note reads and writes other entries; the in-memory `translate` cache is skipped for the LLM
// translator; a failed step alerts and gives the source back without caching.

const request = vi.hoisted(() => ({ requestChatData: vi.fn() }));
const alerts = vi.hoisted(() => ({ alertError: vi.fn() }));
const store = vi.hoisted(() => new Map<string, string>());

// `LLMTranslateCache` in memory: the key and value contract is all the translator relies on.
vi.mock("localforage", () => ({
    default: {
        createInstance: () => ({
            getItem: async (key: string) => (store.has(key) ? store.get(key) : null),
            setItem: async (key: string, value: string) => {
                store.set(key, value);
                return value;
            },
            removeItem: async (key: string) => {
                store.delete(key);
            },
            clear: async () => store.clear(),
            keys: async () => [...store.keys()],
            iterate: async (fn: (value: string, key: string, index: number) => void) => {
                let index = 1;
                for (const [key, value] of [...store]) {
                    fn(value, key, index++);
                }
            },
        }),
    },
}));
vi.mock("src/ts/process/request/request", () => ({ requestChatData: request.requestChatData }));
vi.mock("src/ts/alert", () => ({
    alertError: alerts.alertError,
    alertNormal: vi.fn(),
    alertConfirm: vi.fn(),
    alertInput: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("src/ts/process/index.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { doingChat: writable(false) };
});
// The chat pipeline, the parser, the server transform, the modules, and the model list are not
// under test; the translator only reaches them on paths these tests do not take.
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
    applyMarkdownToNode: vi.fn(),
}));
vi.mock("src/ts/parser/transformClient", () => ({
    captureTransform: vi.fn(() => null),
    serverProcessScript: vi.fn(async (text: string) => text),
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
}));
vi.mock("src/ts/model/modellist", () => ({ getModelInfoForMode: vi.fn(() => ({ id: "gpt-test" })) }));
vi.mock("src/ts/globalApi.svelte", () => ({ globalFetch: vi.fn(), downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/util", () => ({
    getNodetextToSentence: vi.fn(),
    sleep: vi.fn(async () => undefined),
    selectSingleFile: vi.fn(),
    decryptBuffer: vi.fn(),
    encryptBuffer: vi.fn(),
}));

import { get } from "svelte/store";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { doingChat } from "src/ts/process/index.svelte";
import {
    exportLLMCacheAsJSON,
    getLLMCache,
    llmTranslationCacheKey,
    runTranslator,
    searchLLMCache,
    translate,
    translateHTML,
} from "./translator";

const KEY = /^llm:[0-9a-f]{14}:/;

const twoSteps = () =>
    createTranslatorPreset("Two", {
        id: "two",
        steps: [
            {
                id: "s1",
                name: "Draft",
                prompt: "Draft {{slot::content}} into {{slot}} from {{slot::from}}",
                maxResponse: 11,
                outputKey: "draft",
            },
            {
                id: "s2",
                name: "Polish",
                prompt: "Polish {{slot::prev}} (draft {{slot::out::draft}}; note {{slot::tnote}})",
                maxResponse: 22,
            },
        ],
    });
const oneStep = () => createTranslatorPreset("One", { id: "one", prompt: "Other {{slot::content}}", maxResponse: 5 });

/** The request's messages and size, in call order. */
const requests = () =>
    request.requestChatData.mock.calls.map(([arg, mode]) => ({
        mode,
        maxTokens: arg.maxTokens,
        messages: arg.formated,
    }));

const succeed = (...results: string[]) => {
    for (const result of results) {
        request.requestChatData.mockResolvedValueOnce({ type: "success", result });
    }
};

beforeEach(() => {
    store.clear();
    doingChat.set(false);
    installFlatDatabase({
        characters: [],
        translatorPresets: [twoSteps(), oneStep()],
        translatorPresetId: "two",
        translatorType: "llm",
        translator: "ko",
        translatorInputLanguage: "en",
    } as any);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("llmTranslationCacheKey", () => {
    it("prefixes the source with a hash of the pipeline, the languages, and the note, and nothing else", () => {
        const key = llmTranslationCacheKey("Hello");
        expect(key).toMatch(KEY);
        expect(key.endsWith(":Hello")).toBe(true);
        expect(llmTranslationCacheKey("Hello")).toBe(key);
        const prefix = key.slice(0, -"Hello".length);
        expect(llmTranslationCacheKey("Other")).toBe(`${prefix}Other`);

        // Renaming the preset or a step, or reordering nothing, keeps the key.
        settings.translatorPresets.items[0].name = "Renamed";
        settings.translatorPresets.items[0].steps[1].name = "Renamed step";
        expect(llmTranslationCacheKey("Hello")).toBe(key);

        // The prompt, the size, an output key, a step toggle, the selected preset, and each language change it.
        const seen = new Set([key]);
        const changed = (label: string, edit: () => void) => {
            edit();
            const next = llmTranslationCacheKey("Hello");
            expect(next, label).toMatch(KEY);
            expect(seen.has(next), label).toBe(false);
            seen.add(next);
        };
        changed("prompt", () => (settings.translatorPresets.items[0].steps[0].prompt = "Changed {{slot::content}}"));
        changed("maxResponse", () => (settings.translatorPresets.items[0].steps[0].maxResponse = 12));
        changed("outputKey", () => (settings.translatorPresets.items[0].steps[0].outputKey = "other"));
        changed("disable a step", () => (settings.translatorPresets.items[0].steps[1].enabled = false));
        changed("select another preset", () => (settings.translatorPresets.selectedId = "one"));
        changed("target language", () => (settings.memoryTranslateMedia.translator = "ja"));
        changed("source language", () => (settings.memoryTranslateMedia.translatorInputLanguage = "auto"));
    });
});

describe("the LLM translation", () => {
    it("runs every step through the pipeline on the translate slot and caches the result under the full key", async () => {
        succeed("<think>plan</think>\nDRAFT", "FINAL");
        await expect(runTranslator("Hello", false, "ko", "en", { translatorNote: "formal" })).resolves.toBe("FINAL");
        expect(requests()).toEqual([
            {
                mode: "translate",
                maxTokens: 11,
                messages: [{ role: "system", content: "Draft Hello into ko from en" }],
            },
            {
                mode: "translate",
                maxTokens: 22,
                messages: [{ role: "system", content: "Polish DRAFT (draft DRAFT; note formal)" }],
            },
        ]);
        expect(request.requestChatData.mock.calls[0][0]).toMatchObject({ useStreaming: false, noMultiGen: true });
        expect(alerts.alertError).not.toHaveBeenCalled();

        // The note is part of the key: the entry is not the one `translateHTML` would read without it.
        const stored = Object.entries(await exportLLMCacheAsJSON());
        expect(stored).toEqual([[expect.stringMatching(KEY), "FINAL"]]);
        expect(stored[0][0].endsWith(":Hello")).toBe(true);
        expect(stored[0][0]).not.toBe(llmTranslationCacheKey("Hello"));
        expect(await getLLMCache("Hello")).toBeNull();

        // The same request again is served from the cache; the same text without the note is not.
        await expect(runTranslator("Hello", false, "ko", "en", { translatorNote: "formal" })).resolves.toBe("FINAL");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
        succeed("D2", "F2");
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("F2");
        expect(request.requestChatData).toHaveBeenCalledTimes(4);
        expect(requests()[3].messages[0].content).toBe("Polish D2 (draft D2; note )");
        expect(await getLLMCache("Hello")).toBe("F2");
    });

    it("reads and lists only the current context's entries by their source text", async () => {
        succeed("D", "FINAL");
        await runTranslator("Hello world", false, "ko", "en");
        expect(await getLLMCache("Hello world")).toBe("FINAL");
        expect(await searchLLMCache("lo wo")).toEqual([{ key: "Hello world", value: "FINAL" }]);
        expect(await searchLLMCache("llm:")).toEqual([]);

        // Another prompt: a miss, a new request, and its own entry; the old one is not listed.
        settings.translatorPresets.items[0].steps[0].prompt = "Changed {{slot::content}}";
        expect(await getLLMCache("Hello world")).toBeNull();
        expect(await searchLLMCache("Hello")).toEqual([]);
        succeed("D2", "CHANGED");
        await expect(runTranslator("Hello world", false, "ko", "en")).resolves.toBe("CHANGED");
        expect(request.requestChatData).toHaveBeenCalledTimes(4);
        expect(await searchLLMCache("Hello")).toEqual([{ key: "Hello world", value: "CHANGED" }]);
        expect(Object.keys(await exportLLMCacheAsJSON())).toHaveLength(2);

        // Back to the first prompt: the first entry is read again without a request.
        settings.translatorPresets.items[0].steps[0].prompt = twoSteps().steps[0].prompt;
        await expect(runTranslator("Hello world", false, "ko", "en")).resolves.toBe("FINAL");
        expect(request.requestChatData).toHaveBeenCalledTimes(4);
    });

    it("skips the in-memory translate cache for the LLM translator, so a preset change is seen", async () => {
        succeed("D", "FIRST");
        await expect(translate("Hello", false)).resolves.toBe("FIRST");
        await expect(translate("Hello", false)).resolves.toBe("FIRST");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
        settings.translatorPresets.selectedId = "one";
        succeed("SECOND");
        await expect(translate("Hello", false)).resolves.toBe("SECOND");
        expect(request.requestChatData).toHaveBeenCalledTimes(3);
        expect(requests()[2]).toEqual({
            mode: "translate",
            maxTokens: 5,
            messages: [{ role: "system", content: "Other Hello" }],
        });
    });

    it("alerts a failed step and gives the source back without caching it", async () => {
        succeed("D");
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "provider down" });
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("Hello");
        expect(alerts.alertError).toHaveBeenCalledWith("provider down");
        expect(await getLLMCache("Hello")).toBeNull();
        expect(await exportLLMCacheAsJSON()).toEqual({});

        request.requestChatData.mockResolvedValueOnce({ type: "streaming", result: null });
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("Hello");
        expect(alerts.alertError).toHaveBeenLastCalledWith("Unexpected response type");
    });

    it("translates only from the cache while a chat is generating, with the context read once", async () => {
        doingChat.set(true);
        expect(get(doingChat)).toBe(true);
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("Hello");
        expect(request.requestChatData).not.toHaveBeenCalled();

        doingChat.set(false);
        succeed("D", "FINAL");
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("FINAL");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);

        doingChat.set(true);
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("FINAL");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
        // Another preset while generating: no entry, so the source stays.
        settings.translatorPresets.selectedId = "one";
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("Hello");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
    });
});
