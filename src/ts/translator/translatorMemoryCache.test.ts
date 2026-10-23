// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

// The non-LLM translators keep their translations in memory: a source and its translation, found
// from either side, the least recently used pairs evicted once the strings pass 4,000,000 code units.
// DeepL stands in for them; each request translates "x" to "T:x". The cache is module state, so every
// test uses its own texts.

vi.mock("localforage", () => ({
    default: { createInstance: () => ({ getItem: async () => null, setItem: async () => undefined }) },
}));
vi.mock("src/ts/process/request/request", () => ({ requestChatData: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
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
vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: vi.fn(async (_url: string, init: { body: { text: string[] } }) => ({
        ok: true,
        data: { translations: [{ text: `T:${init.body.text[0]}` }] },
    })),
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("src/ts/util", () => ({
    getNodetextToSentence: vi.fn(),
    sleep: vi.fn(async () => undefined),
    selectSingleFile: vi.fn(),
    decryptBuffer: vi.fn(),
    encryptBuffer: vi.fn(),
}));

import { globalFetch } from "src/ts/globalApi.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { translate } from "./translator";

const fetches = () => vi.mocked(globalFetch).mock.calls.length;

beforeEach(() => {
    vi.mocked(globalFetch).mockClear();
    installFlatDatabase({
        characters: [],
        translatorType: "deepl",
        translator: "ko",
        translatorInputLanguage: "en",
        deeplOptions: { key: "dk", freeApi: true },
    } as any);
});

describe("the in-memory translate cache", () => {
    it("serves a translation again, and its source from the translation, without a request", async () => {
        await expect(translate("Hello", false)).resolves.toBe("T:Hello");
        expect(fetches()).toBe(1);
        await expect(translate("Hello", false)).resolves.toBe("T:Hello");
        await expect(translate("T:Hello", true)).resolves.toBe("Hello");
        expect(fetches()).toBe(1);

        // A reverse translation is found from its source side too.
        await expect(translate("Bonjour", true)).resolves.toBe("T:Bonjour");
        await expect(translate("T:Bonjour", false)).resolves.toBe("Bonjour");
        expect(fetches()).toBe(2);
    });

    it("evicts the least recently used pair once the strings pass the budget", async () => {
        // Each pair is 1,980,002 code units: two fit in 4,000,000, a third does not.
        const a = "a".repeat(990_000);
        const b = "b".repeat(990_000);
        const c = "c".repeat(990_000);
        await translate(a, false);
        await translate(b, false);
        expect(fetches()).toBe(2);

        // Reading `a` makes `b` the least recently used, so `c` evicts `b`.
        await translate(a, false);
        await translate(c, false);
        expect(fetches()).toBe(3);
        await expect(translate(a, false)).resolves.toBe(`T:${a}`);
        await expect(translate(c, false)).resolves.toBe(`T:${c}`);
        expect(fetches()).toBe(3);
        await expect(translate(b, false)).resolves.toBe(`T:${b}`);
        expect(fetches()).toBe(4);
    });
});
