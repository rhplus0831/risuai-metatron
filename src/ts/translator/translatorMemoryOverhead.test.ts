// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

// Goal D: exercise the real 4,000,000-code-unit budget through translate.
// The fake DeepL translates each source to T:source; no private cache inspection.

vi.mock("localforage", () => ({
    default: { createInstance: () => ({ getItem: async () => null, setItem: async () => undefined }) },
}));
vi.mock("src/ts/process/request/request", () => ({ requestChatData: vi.fn() }));
vi.mock("src/ts/alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertConfirm: vi.fn(),
    alertInput: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("src/ts/process/index.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { doingChat: writable(false) };
});
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

// Evict any earlier pair through the public boundary, including this oversized pair itself.
async function emptyCache() {
    await translate("clear".repeat(400_001), false);
    vi.mocked(globalFetch).mockClear();
}
const tiny = (i: number) => `p${String(i).padStart(4, "0")}`;

async function fillBudget() {
    await emptyCache();
    // 1,000 tiny pairs cost 1,000 * (5 + 7 + 64) = 76,000. The ballast costs
    // 1,961,967 + 1,961,969 + 64 = 3,924,000. Together: exactly 4,000,000.
    const ballast = "b".repeat(1_961_967);
    await translate(ballast, false);
    for (let i = 0; i < 1_000; i++) await translate(tiny(i), false);
    return ballast;
}

describe("translation pair overhead", () => {
    it("charges 64 per tiny pair and evicts the least recently used pair after a reverse cache hit", async () => {
        const ballast = await fillBudget();
        expect(fetches()).toBe(1_001);
        // Both directions refresh recency: protect the ballast and p0000, leaving p0001 oldest.
        expect(await translate(`T:${ballast}`, true)).toBe(ballast);
        expect(await translate(tiny(0), false)).toBe(`T:${tiny(0)}`);
        expect(fetches()).toBe(1_001);
        await translate(tiny(1_000), false);
        expect(fetches()).toBe(1_002);
        expect(await translate(`T:${tiny(0)}`, true)).toBe(tiny(0));
        expect(await translate(ballast, false)).toBe(`T:${ballast}`);
        expect(fetches()).toBe(1_002);
        await translate(tiny(1), false);
        expect(fetches()).toBe(1_003);
    });

    it("refunds the same 64 on eviction so repeated inserts evict exactly one tiny pair each", async () => {
        const ballast = await fillBudget();
        await translate(ballast, false);
        await translate(tiny(1_000), false); // Only p0000 must leave.
        await translate(tiny(1_001), false); // Only p0001 must leave.
        expect(fetches()).toBe(1_003);
        await translate(tiny(2), false);
        await translate(`T:${tiny(3)}`, true);
        expect(fetches()).toBe(1_003);
        await translate(tiny(0), false);
        expect(fetches()).toBe(1_004);
    });
});
