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
import type { Chat as ChatRecord } from "../../../shared/database.ts";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { assembleChats, chatEntry, seedChats, selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { doingChat } from "src/ts/process/index.svelte";
import {
    exportLLMCacheAsJSON,
    getCurrentTranslatorPreset,
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
/** Each request's captured ids and named profile (translation slice 3.1), in call order. */
const routing = () =>
    request.requestChatData.mock.calls.map(([arg]) => ({
        requestIds: arg.requestIds,
        profileId: arg.profileId,
        named: Object.hasOwn(arg, "profileId"),
    }));

/**
 * Two prompt presets (with their implied model presets, `installFlatDatabase`) and two personas, so a
 * run can be caught switching between them; `pp-1`/`u1` selected.
 */
const SELECTABLE = {
    botPresets: [
        { id: "pp-1", name: "PP 1" },
        { id: "pp-2", name: "PP 2" },
    ],
    personas: [
        { id: "u1", name: "U1" },
        { id: "u2", name: "U2" },
    ],
};
const IDS_1 = { presetId: "pp-1", modelPresetId: "pp-1", personaId: "u1" };
const IDS_2 = { presetId: "pp-2", modelPresetId: "pp-2", personaId: "u2" };
function selectPair(ids: typeof IDS_1) {
    selectPreset(ids.presetId);
    selectModelPreset(ids.modelPresetId);
    selectPersona(ids.personaId);
}

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
        ...SELECTABLE,
        translatorPresets: [twoSteps(), oneStep()],
        translatorPresetId: "two",
        translatorType: "llm",
        translator: "ko",
        translatorInputLanguage: "en",
    } as any);
    selectPair(IDS_1);
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
        changed(
            "a step's model (slice 3.1)",
            () => (settings.translatorPresets.items[0].steps[0].model = { mode: "profile", profileId: "pr-1" }),
        );
        changed(
            "another profile",
            () => (settings.translatorPresets.items[0].steps[0].model = { mode: "profile", profileId: "pr-2" }),
        );
        // The request ids are not part of the key: a cached translation serves whatever is selected.
        selectPair(IDS_2);
        expect(llmTranslationCacheKey("Hello")).toBe([...seen].at(-1));
        selectPair(IDS_1);
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

// `docs/plan/translation.md` slice 2.2: the tab translates with the selected chat's translator preset
// (its list entry), else the global selection; `runTranslator` reads it once for every chunk of a
// call as a plain copy, so a preset deleted while a chunk runs neither changes the later chunks nor
// throws (the record view resolves by id on each read), and the next call falls back; the
// playground's `globalPreset` ignores the chat's preset.
describe("the preset per call", () => {
    const ref = { chaId: "c", chatId: "k" };

    /** Installs character `c` holding chat `k` with `fields`, selected; the presets `two` (global) and `one`. */
    function selectChatWith(fields: Record<string, unknown>) {
        installFlatDatabase({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    firstMessage: "Hello",
                    chatPage: 0,
                    customscript: [],
                    emotionImages: [],
                    additionalAssets: [],
                    triggerscript: [],
                },
            ],
            ...SELECTABLE,
            translatorPresets: [twoSteps(), oneStep()],
            translatorPresetId: "two",
            translatorType: "llm",
            translator: "ko",
            translatorInputLanguage: "en",
        } as any);
        selectPair(IDS_1);
        const data = {
            id: "k",
            name: "K",
            note: "",
            localLore: [],
            message: [{ role: "user", data: "B", chatId: "b" }],
            ...fields,
        } as unknown as ChatRecord;
        const listed = [{ characterId: "c", id: "k", revision: "e:1:1", data }];
        const orders = [{ characterId: "c", revision: "e:1:1", ids: ["k"] }];
        seedChats(listed, orders);
        assembleChats([selectedCharacter() ?? { chaId: "c" }] as never, listed, orders);
        selectCharacter("c");
        selectChat("c", "k");
    }

    it("translates with the selected chat's preset, with the global one at home or for a chat without its own, and with the global one under globalPreset", async () => {
        const atHome = llmTranslationCacheKey("Hello");
        selectChatWith({ translatorPresetId: "one" });
        expect(getCurrentTranslatorPreset().id).toBe("one");
        // The editors' key follows the chat's preset: the key the global `one` would give.
        const withChat = llmTranslationCacheKey("Hello");
        expect(withChat).not.toBe(atHome);
        succeed("ONE");
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("ONE");
        expect(requests()).toEqual([
            { mode: "translate", maxTokens: 5, messages: [{ role: "system", content: "Other Hello" }] },
        ]);
        expect(await getLLMCache("Hello")).toBe("ONE");

        // The playground: the global preset, whatever the chat names.
        succeed("D", "GLOBAL");
        await expect(runTranslator("Hello", false, "ko", "en", { globalPreset: true })).resolves.toBe("GLOBAL");
        expect(requests().slice(1)).toEqual([
            {
                mode: "translate",
                maxTokens: 11,
                messages: [{ role: "system", content: "Draft Hello into ko from en" }],
            },
            { mode: "translate", maxTokens: 22, messages: [{ role: "system", content: "Polish D (draft D; note )" }] },
        ]);

        // Home: the global selection, whose key is the one from before.
        selectCharacter(null);
        expect(getCurrentTranslatorPreset().id).toBe("two");
        expect(llmTranslationCacheKey("Hello")).toBe(atHome);
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("GLOBAL");
        expect(request.requestChatData).toHaveBeenCalledTimes(3);

        // A chat without its own preset, and one naming the global selection: the same context.
        selectChatWith({});
        expect(getCurrentTranslatorPreset().id).toBe("two");
        expect(llmTranslationCacheKey("Hello")).toBe(atHome);
        selectChatWith({ translatorPresetId: "two" });
        expect(llmTranslationCacheKey("Hello")).toBe(atHome);
        // Selecting `one` globally gives the chat's context of before.
        selectCharacter(null);
        settings.translatorPresets.selectedId = "one";
        expect(llmTranslationCacheKey("Hello")).toBe(withChat);
    });

    it("reads the preset once per call: a preset deleted while the first chunk runs lets the second chunk finish with the captured steps, and the next call falls back to the global one", async () => {
        selectChatWith({ translatorPresetId: "one" });
        request.requestChatData.mockImplementationOnce(async () => {
            // The preset editor deletes the chat's preset (or another tab's update removes it) mid-run.
            const presets = settings.translatorPresets.items;
            presets.splice(
                presets.findIndex((preset) => preset.id === "one"),
                1,
            );
            return { type: "success", result: "F1" };
        });
        succeed("F2");
        await expect(runTranslator("first\n\nsecond", false, "ko", "en")).resolves.toBe("F1\n\nF2");
        expect(requests()).toEqual([
            { mode: "translate", maxTokens: 5, messages: [{ role: "system", content: "Other first" }] },
            { mode: "translate", maxTokens: 5, messages: [{ role: "system", content: "Other second" }] },
        ]);
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect(settings.translatorPresets.items.map((preset) => preset.id)).toEqual(["two"]);
        // Nothing rewritten: the chat still names the deleted preset; the tab resolves the global one.
        expect(chatEntry(ref)?.translatorPresetId).toBe("one");
        expect(getCurrentTranslatorPreset().id).toBe("two");

        // The next call is independent: the global preset's two steps.
        succeed("D", "FALLBACK");
        await expect(runTranslator("first", false, "ko", "en")).resolves.toBe("FALLBACK");
        expect(requests().slice(2)).toEqual([
            {
                mode: "translate",
                maxTokens: 11,
                messages: [{ role: "system", content: "Draft first into ko from en" }],
            },
            { mode: "translate", maxTokens: 22, messages: [{ role: "system", content: "Polish D (draft D; note )" }] },
        ]);
        // The deleted preset's entries stay in the cache under their own key, unread by the current context.
        expect(Object.keys(await exportLLMCacheAsJSON())).toHaveLength(3);
        expect(await getLLMCache("second")).toBeNull();
    });
});

// `docs/plan/translation.md` slice 3.1: every step's request carries the ids a chatless request would
// read when the run began (`requestIds`: the prompt preset, model preset, and persona), captured once
// for every chunk of a `runTranslator` call and once per `translateHTML` context, and a step on a
// profile names it (`profileId`); a step on the translate slot names none.
describe("the request ids and the step's profile", () => {
    const mixed = () =>
        createTranslatorPreset("Mixed", {
            id: "mixed",
            steps: [
                {
                    id: "a",
                    prompt: "A {{slot::content}}",
                    maxResponse: 1,
                    model: { mode: "profile", profileId: "pr-a" },
                },
                { id: "b", prompt: "B {{slot::prev}}", maxResponse: 2 },
                { id: "c", prompt: "C {{slot::prev}}", maxResponse: 3, model: { mode: "profile", profileId: "pr-c" } },
            ],
        });

    it("passes every step the captured ids, and a profile step its profile id only", async () => {
        settings.translatorPresets.items.push(mixed());
        settings.translatorPresets.selectedId = "mixed";
        succeed("A", "B", "C");
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("C");
        expect(routing()).toEqual([
            { requestIds: IDS_1, profileId: "pr-a", named: true },
            { requestIds: IDS_1, profileId: undefined, named: false },
            { requestIds: IDS_1, profileId: "pr-c", named: true },
        ]);
        expect(requests().map((entry) => entry.mode)).toEqual(["translate", "translate", "translate"]);
        // The ids are read from the views: another selection, another capture for the next call.
        selectPair(IDS_2);
        succeed("A2", "B2", "C2");
        await expect(runTranslator("Other", false, "ko", "en")).resolves.toBe("C2");
        expect(
            routing()
                .slice(3)
                .map((entry) => entry.requestIds),
        ).toEqual([IDS_2, IDS_2, IDS_2]);
    });

    it("captures the ids once per call: a selection switch during the first step moves neither the later steps nor the later chunks", async () => {
        // The two-step global preset; the text has two chunks (a blank line between them).
        request.requestChatData.mockImplementationOnce(async () => {
            // The user opens another chat (or picks other presets) while the first request runs.
            selectPair(IDS_2);
            return { type: "success", result: "D1" };
        });
        succeed("F1", "D2", "F2");
        await expect(runTranslator("first\n\nsecond", false, "ko", "en")).resolves.toBe("F1\n\nF2");
        expect(requests().map((entry) => entry.messages[0].content)).toEqual([
            "Draft first into ko from en",
            "Polish D1 (draft D1; note )",
            "Draft second into ko from en",
            "Polish D2 (draft D2; note )",
        ]);
        expect(routing().map((entry) => entry.requestIds)).toEqual([IDS_1, IDS_1, IDS_1, IDS_1]);
        for (const entry of routing()) {
            expect(entry.named).toBe(false);
        }
        // `translateHTML` reads its context once too: a switch during its first step keeps the second.
        selectPair(IDS_1);
        request.requestChatData.mockImplementationOnce(async () => {
            selectPair(IDS_2);
            return { type: "success", result: "D3" };
        });
        succeed("F3");
        await expect(translateHTML("Third", false, "", -1)).resolves.toBe("F3");
        expect(
            routing()
                .slice(4)
                .map((entry) => entry.requestIds),
        ).toEqual([IDS_1, IDS_1]);
        // The next call starts from the switched selection.
        succeed("D4", "F4");
        await runTranslator("Fourth", false, "ko", "en");
        expect(
            routing()
                .slice(6)
                .map((entry) => entry.requestIds),
        ).toEqual([IDS_2, IDS_2]);
    });
});
