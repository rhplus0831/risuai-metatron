// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { translatorPipelineSignature } from "../../../shared/translation/pipeline.ts";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";

// The tab's LLM translator runs the selected preset's steps through the shared pipeline, each step
// one `requestChatData(..., "translate")`, and caches the result in `LLMTranslateCache` under
// `llm:<hash>:<source>`, the hash of the pipeline signature, the languages, and the translator
// note. Another prompt, preset, language, or note reads and writes other entries; the in-memory
// `translate` cache is skipped for the LLM translator; a failed step alerts and gives the source
// back without caching.

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
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.alertError,
    }),
);
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
import { globalFetch } from "src/ts/globalApi.svelte";
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
    writeLLMCacheEntry,
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
/** Each request's captured ids and named profile, in call order. */
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
            "a step's model",
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

// The tab translates with the selected chat's translator preset (its list entry), else the global
// selection; `runTranslator` reads it once for every chunk of a call as a plain copy, so a preset
// deleted while a chunk runs neither changes the later chunks nor throws (the record view resolves
// by id on each read), and the next call falls back; the playground's `globalPreset` ignores the
// chat's preset.
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

// Every step's request carries the ids a chatless request would read when the run began
// (`requestIds`: the prompt preset, model preset, and persona), captured once for every chunk of a
// `runTranslator` call and once per `translateHTML` context, and a step on a profile names it
// (`profileId`); a step on the translate slot names none.
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

// A preset on Send Text As-Is sends the whole text of a `runTranslator` call in one pipeline run
// (no line chunking), and `translateLLM` keeps the text and the reply as they are (no
// `<risu-style>` placeholders, no `ERR::` check, no trim). The cache key carries the flag only when
// it is on, so the keys of every preset without it are those from before the option; the mode is
// captured with the context when a call starts.
describe("Send Text As-Is", () => {
    const SOURCE = "first <risu-style>.a{color:red}</risu-style>\n\n{{img::x}}\nsecond ";
    const turnOn = () => {
        settings.translatorPresets.items[0].sendTextAsIs = true;
    };
    const turnOff = () => {
        delete settings.translatorPresets.items[0].sendTextAsIs;
    };

    it("keys the cache by exactly the pipeline, the languages, and the note while the option is off (a stray false included), and by another key while it is on", async () => {
        const off = llmTranslationCacheKey("Hello");
        // The formula from before the option: a preset without it reads and writes its old entries.
        const signature = JSON.stringify({
            pipeline: translatorPipelineSignature(twoSteps().steps),
            to: "ko",
            from: "en",
            translatorNote: "",
        });
        expect(off).toBe(`llm:${translationSourceHash(signature)}:Hello`);
        settings.translatorPresets.items[0].sendTextAsIs = false;
        expect(llmTranslationCacheKey("Hello")).toBe(off);
        turnOn();
        const on = llmTranslationCacheKey("Hello");
        expect(on).toMatch(KEY);
        expect(on).not.toBe(off);
        expect(on.endsWith(":Hello")).toBe(true);

        // Each mode reads, lists, and writes its own entries.
        succeed("D", "ON");
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("ON");
        expect(await getLLMCache("Hello")).toBe("ON");
        turnOff();
        expect(await getLLMCache("Hello")).toBeNull();
        expect(await searchLLMCache("Hello")).toEqual([]);
        succeed("D", "OFF");
        await expect(runTranslator("Hello", false, "ko", "en")).resolves.toBe("OFF");
        expect(await getLLMCache("Hello")).toBe("OFF");
        turnOn();
        expect(await getLLMCache("Hello")).toBe("ON");
        expect(await searchLLMCache("Hello")).toEqual([{ key: "Hello", value: "ON" }]);
        expect(await exportLLMCacheAsJSON()).toEqual({ [off]: "OFF", [on]: "ON" });
    });

    it("sends the whole text of a runTranslator call in one run, <risu-style> blocks included, and returns the reply as it is: untrimmed, an ERR:: or <style-data> text kept, nothing alerted", async () => {
        turnOn();
        const reply = ' ERR:: <style-data style-index="0"></style-data> 둘째\n';
        succeed("D", reply);
        await expect(runTranslator(SOURCE, false, "ko", "en")).resolves.toBe(reply);
        expect(requests()).toEqual([
            {
                mode: "translate",
                maxTokens: 11,
                messages: [{ role: "system", content: `Draft ${SOURCE} into ko from en` }],
            },
            { mode: "translate", maxTokens: 22, messages: [{ role: "system", content: "Polish D (draft D; note )" }] },
        ]);
        expect(alerts.alertError).not.toHaveBeenCalled();
        expect(await getLLMCache(SOURCE)).toBe(reply);
        // Served from the cache as it is; a failed step still alerts and gives the text back.
        await expect(runTranslator(SOURCE, false, "ko", "en")).resolves.toBe(reply);
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "provider down" });
        await expect(runTranslator("Other", false, "ko", "en")).resolves.toBe("Other");
        expect(alerts.alertError).toHaveBeenCalledWith("provider down");
        expect(await getLLMCache("Other")).toBeNull();

        // Off: the same text goes part by part as before, the <risu-style> block as a placeholder
        // restored in the reply, each part trimmed, the parts joined around the kept lines.
        turnOff();
        succeed("D1", ' <style-data style-index="0"></style-data> 첫째 ', "D2", "둘째");
        await expect(runTranslator(SOURCE, false, "ko", "en")).resolves.toBe(
            ".a{color:red} 첫째\n\n\n{{img::x}}\n둘째",
        );
        expect(
            requests()
                .slice(3)
                .map((entry) => entry.messages[0].content),
        ).toEqual([
            'Draft first <style-data style-index="0"></style-data> into ko from en',
            "Polish D1 (draft D1; note )",
            "Draft second into ko from en",
            "Polish D2 (draft D2; note )",
        ]);
    });

    it("translateHTML sends the whole html in both modes: as it is with the option, its <risu-style> blocks as placeholders without it", async () => {
        const html = "<p>Hi</p><risu-style>.b{}</risu-style>\n\n<p>There</p>";
        turnOn();
        succeed("D", " <p>안녕</p> ");
        await expect(translateHTML(html, false, "", -1)).resolves.toBe(" <p>안녕</p> ");
        expect(requests()[0].messages[0].content).toBe(`Draft ${html} into ko from en`);
        turnOff();
        succeed("D", '<p>안녕</p><style-data style-index="0"></style-data>');
        await expect(translateHTML(html, false, "", -1)).resolves.toBe("<p>안녕</p>.b{}");
        expect(requests()[2].messages[0].content).toBe(
            'Draft <p>Hi</p><style-data style-index="0"></style-data>\n\n<p>There</p> into ko from en',
        );
        expect(request.requestChatData).toHaveBeenCalledTimes(4);
    });

    it("captures the mode when a call starts: a flag changed during a request governs neither the processing of that call nor the key its entries are written under", async () => {
        turnOn();
        const on = llmTranslationCacheKey(SOURCE);
        request.requestChatData.mockImplementationOnce(async () => {
            // The preset page (or another tab's update) turns the option off during the first step.
            turnOff();
            return { type: "success", result: "D" };
        });
        succeed(" raw ");
        await expect(runTranslator(SOURCE, false, "ko", "en")).resolves.toBe(" raw ");
        expect(requests()).toHaveLength(2);
        expect(requests()[0].messages[0].content).toBe(`Draft ${SOURCE} into ko from en`);
        // Written under the on-mode key the call started with: the off mode selected now reads nothing.
        expect(await exportLLMCacheAsJSON()).toEqual({ [on]: " raw " });
        expect(await getLLMCache(SOURCE)).toBeNull();
        turnOn();
        expect(await getLLMCache(SOURCE)).toBe(" raw ");

        // The other direction: turned on during an off call's first part, the second part still runs
        // off (the captured copy), and both parts are written under the off-mode keys.
        turnOff();
        const offKey = (text: string) => llmTranslationCacheKey(text);
        const [keyA, keyB] = [offKey("a"), offKey("b")];
        request.requestChatData.mockImplementationOnce(async () => {
            turnOn();
            return { type: "success", result: "DA" };
        });
        succeed("A", "DB", "B");
        await expect(runTranslator("a\n\nb", false, "ko", "en")).resolves.toBe("A\n\nB");
        expect(
            requests()
                .slice(2)
                .map((entry) => entry.messages[0].content),
        ).toEqual([
            "Draft a into ko from en",
            "Polish DA (draft DA; note )",
            "Draft b into ko from en",
            "Polish DB (draft DB; note )",
        ]);
        expect(await exportLLMCacheAsJSON()).toEqual({ [on]: " raw ", [keyA]: "A", [keyB]: "B" });
        expect(await getLLMCache("b")).toBeNull();
        turnOff();
        expect(await getLLMCache("b")).toBe("B");
    });
});

// The tab passes no history, so a prompt's history slots are empty in its requests while the
// current input is kept; its cache key is deliberately unchanged (the formula from before history
// slots, over the pipeline, the languages, and the note), so an entry cached under a prompt with a
// literal history slot is still served, and `regenerate` replaces it.
describe("the history slots in the tab", () => {
    const historyPreset = () =>
        createTranslatorPreset("History", {
            id: "hist",
            steps: [
                {
                    id: "h1",
                    name: "Draft",
                    prompt: "H[{{slot::history::3}}][{{slot::historytrans::2}}][{{slot::history::0}}] {{slot::content}}",
                    maxResponse: 11,
                },
                { id: "h2", name: "Polish", prompt: "Only {{slot::history::1}} into {{slot}}", maxResponse: 22 },
            ],
        });

    it("expands the history slots to empty, keeps the input, keeps the old key, serves an entry cached under it, and replaces it on regenerate", async () => {
        settings.translatorPresets.items.push(historyPreset());
        settings.translatorPresets.selectedId = "hist";
        const key = llmTranslationCacheKey("Hello");
        const signature = JSON.stringify({
            pipeline: translatorPipelineSignature(historyPreset().steps),
            to: "ko",
            from: "en",
            translatorNote: "",
        });
        expect(key).toBe(`llm:${translationSourceHash(signature)}:Hello`);

        // An entry from before the slots had a meaning is served as it is.
        store.set(key, "OLD");
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("OLD");
        expect(request.requestChatData).not.toHaveBeenCalled();

        // Regenerate: the pipeline runs with the slots empty, the source kept, and the entry replaced.
        succeed("D", "NEW");
        await expect(translateHTML("Hello", false, "", -1, true)).resolves.toBe("NEW");
        expect(requests()).toEqual([
            { mode: "translate", maxTokens: 11, messages: [{ role: "system", content: "H[][][] Hello" }] },
            {
                mode: "translate",
                maxTokens: 22,
                messages: [
                    { role: "system", content: "Only  into ko" },
                    { role: "user", content: "D" },
                ],
            },
        ]);
        expect(await getLLMCache("Hello")).toBe("NEW");
        expect(store.get(key)).toBe("NEW");
        await expect(translateHTML("Hello", false, "", -1)).resolves.toBe("NEW");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);
        expect(alerts.alertError).not.toHaveBeenCalled();
    });
});

// A preset on Exclude Chain-of-Thought strips the `<Thoughts>` and `<think>` blocks of the text
// once before it is sent (`translateLLM` for an As-Is `runTranslator` call and for `translateHTML`;
// the protected `runTranslator` strips the whole text before its line cut and passes the chunks as
// prepared), a text left blank is an empty translation, a failure returns the text as given, and
// the cache key carries `excludeThoughts: true` only when on, after the existing fields, plus
// `inputPrepared: true` for the prepared chunks, so a prepared text and the same raw text (which
// would be stripped again: the strip is not idempotent) never share an entry.
describe("Exclude Chain-of-Thought", () => {
    /** A non-idempotent text: one strip leaves `ONCE`, a second would leave `visible`. */
    const NONIDEM = "<thi<think>x</think>nk>secret</think>visible";
    const ONCE = "<think>secret</think>visible";
    const one = () => settings.translatorPresets.items.find((entry) => entry.id === "one")!;
    const setExclude = (on: boolean) => {
        if (on) {
            one().excludeThoughts = true;
        } else {
            delete one().excludeThoughts;
        }
    };
    const setAsIs = (on: boolean) => {
        if (on) {
            one().sendTextAsIs = true;
        } else {
            delete one().sendTextAsIs;
        }
    };
    /** The `one` preset's key of `text` under the signature fields `extra` appended in order. */
    const keyOf = (extra: Record<string, true>, text: string) =>
        `llm:${translationSourceHash(
            JSON.stringify({
                pipeline: translatorPipelineSignature(oneStep().steps),
                to: "ko",
                from: "en",
                translatorNote: "",
                ...extra,
            }),
        )}:${text}`;
    const ON = { excludeThoughts: true } as const;
    const PREPARED = { excludeThoughts: true, inputPrepared: true } as const;
    const contents = () => requests().map((entry) => entry.messages[0].content);

    beforeEach(() => {
        settings.translatorPresets.selectedId = "one";
        setExclude(true);
    });

    it("keys the cache by the old formula while off (a stray false included), appends excludeThoughts: true after sendTextAsIs when on, and keys the protected chunks apart with inputPrepared: true", async () => {
        setExclude(false);
        expect(llmTranslationCacheKey("Hello")).toBe(keyOf({}, "Hello"));
        one().excludeThoughts = false;
        expect(llmTranslationCacheKey("Hello")).toBe(keyOf({}, "Hello"));
        setAsIs(true);
        expect(llmTranslationCacheKey("Hello")).toBe(keyOf({ sendTextAsIs: true }, "Hello"));
        setExclude(true);
        expect(llmTranslationCacheKey("Hello")).toBe(keyOf({ sendTextAsIs: true, excludeThoughts: true }, "Hello"));
        setAsIs(false);
        expect(llmTranslationCacheKey("Hello")).toBe(keyOf(ON, "Hello"));
        expect(llmTranslationCacheKey("Hello")).toMatch(KEY);

        // A protected chunk's entry: the chunk of the stripped text under the prepared signature.
        succeed("안녕");
        await expect(runTranslator("<think>r</think>Hello", false, "ko", "en")).resolves.toBe("안녕");
        expect(await exportLLMCacheAsJSON()).toEqual({ [keyOf(PREPARED, "Hello")]: "안녕" });
        // Neither the public key nor the plugin reads see it: the rendered path strips the raw text.
        expect(await getLLMCache("Hello")).toBeNull();
        expect(await getLLMCache("<think>r</think>Hello")).toBeNull();
        expect(await searchLLMCache("Hello")).toEqual([]);
    });

    it("keeps a prepared chunk and the same raw text apart in both population orders: each path sends its own request text, and the editors' key is the raw one", async () => {
        // Protected first: the whole text stripped once, the chunk sent as it is (not stripped again).
        succeed("PROTECTED");
        await expect(runTranslator(NONIDEM, false, "ko", "en")).resolves.toBe("PROTECTED");
        expect(contents()).toEqual([`Other ${ONCE}`]);
        expect(await exportLLMCacheAsJSON()).toEqual({ [keyOf(PREPARED, ONCE)]: "PROTECTED" });
        // The chunk's text on the direct path is raw text: stripped once more, its own request and entry.
        succeed("DIRECT");
        await expect(translateHTML(ONCE, false, "", -1)).resolves.toBe("DIRECT");
        expect(contents()).toEqual([`Other ${ONCE}`, "Other visible"]);
        expect(await exportLLMCacheAsJSON()).toEqual({
            [keyOf(PREPARED, ONCE)]: "PROTECTED",
            [keyOf(ON, ONCE)]: "DIRECT",
        });
        expect(llmTranslationCacheKey(ONCE)).toBe(keyOf(ON, ONCE));
        expect(await getLLMCache(ONCE)).toBe("DIRECT");
        expect(await searchLLMCache("secret")).toEqual([{ key: ONCE, value: "DIRECT" }]);
        // An editor's write lands on the raw entry and never reaches the protected run.
        await writeLLMCacheEntry(llmTranslationCacheKey(ONCE), "EDITED");
        await expect(translateHTML(ONCE, false, "", -1)).resolves.toBe("EDITED");
        await expect(runTranslator(NONIDEM, false, "ko", "en")).resolves.toBe("PROTECTED");
        expect(request.requestChatData).toHaveBeenCalledTimes(2);

        // Direct first: the protected run still makes its own request with the prepared text.
        store.clear();
        vi.clearAllMocks();
        succeed("DIRECT2");
        await expect(translateHTML(ONCE, false, "", -1)).resolves.toBe("DIRECT2");
        succeed("PROTECTED2");
        await expect(runTranslator(NONIDEM, false, "ko", "en")).resolves.toBe("PROTECTED2");
        expect(contents()).toEqual(["Other visible", `Other ${ONCE}`]);
        expect(await exportLLMCacheAsJSON()).toEqual({
            [keyOf(ON, ONCE)]: "DIRECT2",
            [keyOf(PREPARED, ONCE)]: "PROTECTED2",
        });
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("with Send Text As-Is strips the whole text exactly once in translateLLM, keyed by the original text: whitespace kept without a tag, trimmed after a block, the original returned on failure", async () => {
        setAsIs(true);
        succeed("ONCE");
        await expect(runTranslator(NONIDEM, false, "ko", "en")).resolves.toBe("ONCE");
        expect(contents()).toEqual([`Other ${ONCE}`]);
        expect(await exportLLMCacheAsJSON()).toEqual({
            [keyOf({ sendTextAsIs: true, excludeThoughts: true }, NONIDEM)]: "ONCE",
        });
        expect(await getLLMCache(NONIDEM)).toBe("ONCE");
        await expect(runTranslator(NONIDEM, false, "ko", "en")).resolves.toBe("ONCE");
        expect(request.requestChatData).toHaveBeenCalledTimes(1);

        // No opening tag: the text goes as it is, surrounding whitespace and a stray closing tag included.
        succeed(" kept ");
        await expect(runTranslator("  Hello </think> \n", false, "ko", "en")).resolves.toBe(" kept ");
        expect(contents()[1]).toBe("Other   Hello </think> \n");
        // A block spanning blank and asset lines leaves whole, and the rest is trimmed.
        succeed("T");
        await expect(
            runTranslator("  <THINK a='b'>\nx\n\n{{img::x}}\n</think>  Hello \n", false, "ko", "en"),
        ).resolves.toBe("T");
        expect(contents()[2]).toBe("Other Hello");

        // A failed step: one alert, the text as given (not the stripped text), nothing cached.
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "provider down" });
        await expect(runTranslator("<think>r</think>Hello", false, "ko", "en")).resolves.toBe("<think>r</think>Hello");
        expect(alerts.alertError).toHaveBeenCalledTimes(1);
        expect(alerts.alertError).toHaveBeenCalledWith("provider down");
        expect(await getLLMCache("<think>r</think>Hello")).toBeNull();
        expect(Object.keys(await exportLLMCacheAsJSON())).toHaveLength(3);
    });

    it("without Send Text As-Is strips the whole text before the line cut (a block spanning blank and asset lines leaves whole), joins adjacent lines with a newline, and keys each chunk of the stripped text as prepared", async () => {
        const text = "intro\n<Thoughts>\nline a\n\n{{img::x}}\nline b\n</Thoughts>\nfirst\nsecond\n\n{{img::y}}\nthird";
        succeed("I", "FS", "T");
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe("I\n\nFS\n\n\n{{img::y}}\nT");
        // Adjacent lines go out as one chunk joined with a newline, as on the server.
        expect(contents()).toEqual(["Other intro", "Other first\nsecond", "Other third"]);
        expect(await exportLLMCacheAsJSON()).toEqual({
            [keyOf(PREPARED, "intro")]: "I",
            [keyOf(PREPARED, "first\nsecond")]: "FS",
            [keyOf(PREPARED, "third")]: "T",
        });
        // Served from those entries again; the raw path reads none of them.
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe("I\n\nFS\n\n\n{{img::y}}\nT");
        expect(request.requestChatData).toHaveBeenCalledTimes(3);
        expect(await getLLMCache("intro")).toBeNull();
        expect(await searchLLMCache("intro")).toEqual([]);
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("translateHTML strips before the <risu-style> placeholders, so a style inside a removed block cannot come back from the style table; raw tags go, a rendered <details> stays", async () => {
        const html = "<think>secret <risu-style>.x{}</risu-style></think><p>Hi</p><risu-style>.b{}</risu-style>";
        succeed('<p>안녕</p><style-data style-index="0"></style-data><style-data style-index="1"></style-data>');
        await expect(translateHTML(html, false, "", -1)).resolves.toBe("<p>안녕</p>.b{}");
        expect(contents()).toEqual(['Other <p>Hi</p><style-data style-index="0"></style-data>']);
        expect(await exportLLMCacheAsJSON()).toEqual({ [keyOf(ON, html)]: "<p>안녕</p>.b{}" });

        // The accepted scope: the markdown step has already turned `<Thoughts>` into `<details>` on
        // the rendered path, which is kept; only raw tags (translateBeforeHTMLFormatting's text) go.
        const rendered = "<details><summary>Thoughts</summary>secret</details><p>Hi</p>";
        succeed("R");
        await expect(translateHTML(rendered, false, "", -1)).resolves.toBe("R");
        expect(contents()[1]).toBe(`Other ${rendered}`);
        succeed("W");
        await expect(translateHTML("<Thoughts>raw</Thoughts>\n<p>Hi</p>", false, "", -1)).resolves.toBe("W");
        expect(contents()[2]).toBe("Other <p>Hi</p>");
    });

    it("reports a chunk's failure to the protected runTranslator, which returns its whole text as given: the first chunk, a later one after an unchanged success, a later step; one alert, the failed chunk uncached", async () => {
        const text = "<think>r</think>Hello\n\nWorld";
        // The first chunk fails: the second is never sent.
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "provider down" });
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe(text);
        expect(request.requestChatData).toHaveBeenCalledTimes(1);
        expect(alerts.alertError).toHaveBeenCalledTimes(1);
        expect(await exportLLMCacheAsJSON()).toEqual({});

        // A later chunk fails after a success whose reply equals its input (equality is not failure).
        succeed("Hello");
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "second down" });
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe(text);
        expect(contents().slice(1)).toEqual(["Other Hello", "Other World"]);
        expect(alerts.alertError).toHaveBeenCalledTimes(2);
        expect(alerts.alertError).toHaveBeenLastCalledWith("second down");
        expect(await exportLLMCacheAsJSON()).toEqual({ [keyOf(PREPARED, "Hello")]: "Hello" });

        // A later step fails (the two-step preset): the first chunk's draft is not a translation.
        settings.translatorPresets.items[0].excludeThoughts = true;
        settings.translatorPresets.selectedId = "two";
        succeed("D");
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "polish down" });
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe(text);
        expect(request.requestChatData).toHaveBeenCalledTimes(5);
        expect(alerts.alertError).toHaveBeenCalledTimes(3);
        expect(Object.keys(await exportLLMCacheAsJSON())).toHaveLength(1);

        // Without the option a chunk's failure keeps the old behavior: the chunk's text joined in.
        settings.translatorPresets.selectedId = "one";
        setExclude(false);
        request.requestChatData.mockResolvedValueOnce({ type: "fail", result: "old way" });
        succeed("W");
        await expect(runTranslator(text, false, "ko", "en")).resolves.toBe("<think>r</think>Hello\n\nW");
        expect(contents().slice(5)).toEqual(["Other <think>r</think>Hello", "Other World"]);
        expect(alerts.alertError).toHaveBeenCalledTimes(4);
    });

    it('a text the strip leaves blank is an empty translation: cached as "" under the original key on the As-Is and direct paths (a regeneration replacing a manual entry, the next read a hit), returned without a request or an entry by the protected path', async () => {
        const only = "<Thoughts>\nonly\n</Thoughts>";
        await expect(translateHTML(only, false, "", -1)).resolves.toBe("");
        expect(request.requestChatData).not.toHaveBeenCalled();
        expect(await exportLLMCacheAsJSON()).toEqual({ [keyOf(ON, only)]: "" });
        expect(await getLLMCache(only)).toBe("");
        await expect(translateHTML(only, false, "", -1)).resolves.toBe("");
        // A manual entry (the editors) is served until a regeneration replaces it with "".
        await writeLLMCacheEntry(llmTranslationCacheKey(only), "MANUAL");
        await expect(translateHTML(only, false, "", -1)).resolves.toBe("MANUAL");
        await expect(translateHTML(only, false, "", -1, true)).resolves.toBe("");
        expect(await getLLMCache(only)).toBe("");
        await expect(translateHTML(only, false, "", -1)).resolves.toBe("");
        // While a chat generates, the entry is served; without one the html stays, nothing written.
        doingChat.set(true);
        await expect(translateHTML(only, false, "", -1)).resolves.toBe("");
        await expect(translateHTML("<think>other</think>", false, "", -1)).resolves.toBe("<think>other</think>");
        expect(Object.keys(await exportLLMCacheAsJSON())).toHaveLength(1);
        doingChat.set(false);

        setAsIs(true);
        await expect(runTranslator(only, false, "ko", "en")).resolves.toBe("");
        expect(await exportLLMCacheAsJSON()).toEqual({
            [keyOf(ON, only)]: "",
            [keyOf({ sendTextAsIs: true, excludeThoughts: true }, only)]: "",
        });
        setAsIs(false);
        store.clear();
        await expect(runTranslator(only, false, "ko", "en")).resolves.toBe("");
        await expect(runTranslator("<think>a</think>\n\n<think>b</think>", false, "ko", "en")).resolves.toBe("");
        expect(await exportLLMCacheAsJSON()).toEqual({});
        expect(request.requestChatData).not.toHaveBeenCalled();
        expect(alerts.alertError).not.toHaveBeenCalled();
    });

    it("captures the option when a call starts: flipped during the first chunk's request, the later chunks and the keys stay with the captured mode in both directions", async () => {
        const onKeys = () => [keyOf(PREPARED, "first"), keyOf(PREPARED, "second")];
        request.requestChatData.mockImplementationOnce(async () => {
            setExclude(false);
            return { type: "success", result: "F" };
        });
        succeed("S");
        await expect(runTranslator("<think>a</think>first\n\n<think>b</think>second", false, "ko", "en")).resolves.toBe(
            "F\n\nS",
        );
        expect(contents()).toEqual(["Other first", "Other second"]);
        expect(await exportLLMCacheAsJSON()).toEqual({ [onKeys()[0]]: "F", [onKeys()[1]]: "S" });
        // Off now: the raw path reads none of them.
        expect(await getLLMCache("second")).toBeNull();

        // Turned on during an off call: the second chunk keeps its block and the off keys.
        request.requestChatData.mockImplementationOnce(async () => {
            setExclude(true);
            return { type: "success", result: "F2" };
        });
        succeed("S2");
        await expect(runTranslator("first\n\n<think>b</think>second", false, "ko", "en")).resolves.toBe("F2\n\nS2");
        expect(contents().slice(2)).toEqual(["Other first", "Other <think>b</think>second"]);
        expect(await exportLLMCacheAsJSON()).toMatchObject({
            [keyOf({}, "first")]: "F2",
            [keyOf({}, "<think>b</think>second")]: "S2",
        });
        expect(await getLLMCache("<think>b</think>second")).toBeNull();
        setExclude(false);
        expect(await getLLMCache("<think>b</think>second")).toBe("S2");
    });

    it("leaves another translator alone: DeepL gets the text with its blocks", async () => {
        installFlatDatabase({
            characters: [],
            translatorPresets: [twoSteps(), { ...oneStep(), excludeThoughts: true }],
            translatorPresetId: "one",
            translatorType: "deepl",
            translator: "ko",
            translatorInputLanguage: "en",
            deeplOptions: { key: "k", freeApi: true },
        } as any);
        vi.mocked(globalFetch).mockResolvedValueOnce({ ok: true, data: { translations: [{ text: "X" }] } } as never);
        await expect(runTranslator("<think>r</think>Hello", false, "ko", "en")).resolves.toBe("X");
        expect(vi.mocked(globalFetch).mock.calls[0][1]).toMatchObject({ body: { text: ["<think>r</think>Hello"] } });
        expect(request.requestChatData).not.toHaveBeenCalled();
        expect(await exportLLMCacheAsJSON()).toEqual({});
    });
});
