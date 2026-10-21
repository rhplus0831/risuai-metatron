import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The settings location table (`SETTING_LOCATIONS`, every registry item's one destination, read
// from the arrays the pages render) and `searchSettings` over the real settings views a fixture
// installs.

await vi.hoisted(async () => {
    const { Buffer: BufferPolyfill } = await import("buffer");
    (globalThis as any).Buffer = BufferPolyfill;
});

vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    alertSelect: vi.fn(),
    alertConfirm: vi.fn(),
    alertWait: vi.fn(),
    alertMd: vi.fn(),
}));
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../translator/translator", () => ({
    exportLLMCacheAsJSON: vi.fn(),
    importLLMCacheFromJSON: vi.fn(),
    clearLLMCache: vi.fn(),
}));

import { changeLanguage } from "src/lang";
import { normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { SETTINGS_PAGES } from "../router/routes";
import { MODEL_PROFILES_SETTINGS_MENU } from "../settingsMenu";
import { deleteModelProfile } from "../storage/collectionStore.svelte";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import {
    activeMainProfile,
    activeModelPreset,
    activePersona,
    activePreset,
    settings,
} from "../storage/settingsViews.svelte";
import { accessibilitySettingsSections } from "./accessibilitySettingsData";
import { advancedSettingsSections } from "./advancedSettingsData";
import { displaySettingsSections } from "./displaySettingsData.svelte";
import { interactionSettingsSections } from "./interactionSettingsData";
import { memorySettingsSections } from "./memorySettingsData";
import { modelSettingsSections } from "./modelSettingsData";
import { promptSettingsSections } from "./promptSettingsData";
import { searchSettings, SETTING_HIT_LIMIT, SETTING_LOCATIONS, settingLocation, type SettingHit } from "./searchIndex";
import { translationSettingsSections } from "./translationSettingsData";
import type { SettingContext } from "./types";
import { getFullSettingsData } from "./utils";

const ALL_SECTIONS = [
    ...accessibilitySettingsSections,
    ...interactionSettingsSections,
    ...advancedSettingsSections,
    ...translationSettingsSections,
    ...displaySettingsSections,
    ...modelSettingsSections,
    ...promptSettingsSections,
    ...memorySettingsSections,
];

function boot() {
    installFlatDatabase({
        characters: [],
        botPresets: [{ id: "a", name: "A" }],
        modelPresets: [normalizeModelPreset({ name: "A", mainSlot: { profileId: "pa" } }, { id: "a" })],
        modelProfiles: [
            normalizeModelProfile({ name: "PA", modelId: "model-a" }, { id: "pa" }),
            normalizeModelProfile({ name: "PB", modelId: "model-b" }, { id: "pb" }),
        ],
        personas: [{ id: "p1", name: "U" }],
        hanuraiEnable: false,
        hypav2: false,
        hypaV3: false,
        supaModelType: "none",
    });
}

/** The context the pages render with, over a model info that offers the given parameters. */
function ctx(parameters: string[] = []): SettingContext {
    const modelInfo = { id: "model-a", flags: [], parameters };
    return {
        settings,
        preset: activePreset,
        modelPreset: activeModelPreset,
        modelProfile: activeMainProfile,
        persona: activePersona,
        modelInfo,
        subModelInfo: modelInfo,
    } as unknown as SettingContext;
}

function hit(query: string, id: string, context = ctx()): SettingHit | undefined {
    return searchSettings(query, context).find((entry) => entry.kind === "item" && entry.id === id);
}

beforeEach(boot);
afterEach(() => changeLanguage("en"));

describe("SETTING_LOCATIONS", () => {
    it("gives every non-header, non-accordion item exactly one location, and names only real items", () => {
        const items = getFullSettingsData().filter((item) => item.type !== "header" && item.type !== "accordion");
        const ids = SETTING_LOCATIONS.map((location) => location.itemId);
        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
        expect([...ids].sort()).toEqual(items.map((item) => item.id).sort());
    });

    it("places each item on a real page, in a section that holds the catalog's own object", () => {
        const menus = new Set<number>(Object.values(SETTINGS_PAGES));
        const catalog = new Map(getFullSettingsData().map((item) => [item.id, item]));
        for (const location of SETTING_LOCATIONS) {
            expect(menus.has(location.menu), location.itemId).toBe(true);
            if (location.sectionId === undefined) continue;
            const section = ALL_SECTIONS.find((entry) => entry.id === location.sectionId);
            expect(section?.items.includes(catalog.get(location.itemId)!), location.itemId).toBe(true);
        }
    });

    it("names the handwritten accordions and the Connections destination of the chat-format items", () => {
        expect(settingLocation("acc.applyAdditionalParamsToAll")?.opener).toBe("model.additionalParams");
        expect(settingLocation("chatFormat.template")).toMatchObject({
            menu: MODEL_PROFILES_SETTINGS_MENU,
            opener: "profile.chatFormat",
        });
        expect(settingLocation("display.zoomsize")).toMatchObject({ menu: 3, tab: "layout" });
    });
});

describe("searchSettings", () => {
    it("finds the context size by its keyword, on Connections", () => {
        expect(hit("context", "params.maxContext")).toMatchObject({
            target: { menu: MODEL_PROFILES_SETTINGS_MENU },
            available: true,
            profileId: "pa",
        });
    });

    it("matches a Korean label and its initial consonants under Korean, and still the English label", () => {
        changeLanguage("ko");
        expect(hit("최대 컨텍스트", "params.maxContext")?.label).toBe("최대 컨텍스트 크기");
        expect(hit("ㅊㄷㅋㅌㅅㅌ", "params.maxContext")).toBeDefined();
        expect(hit("Max Context Size", "params.maxContext")?.label).toBe("최대 컨텍스트 크기");
    });

    it("ranks a weaker label match above a stronger keyword-only match", () => {
        // "token" is a whole keyword of `params.maxContext`, only a substring of `adv.lbToken`'s label.
        const ids = searchSettings("token", ctx()).map((entry) => entry.id);
        expect(ids).toContain("params.maxContext");
        expect(ids.indexOf("adv.lbToken")).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf("adv.lbToken")).toBeLessThan(ids.indexOf("params.maxContext"));
    });

    it("lists an item whose own condition fails as unavailable", () => {
        expect(hit("Top K", "params.topK")).toMatchObject({ available: false, reason: "hidden" });
        expect(hit("Top K", "params.topK", ctx(["top_k"]))).toMatchObject({ available: true });
    });

    it("lists adv.remPunc as available only in the SupaMemory branch of the Memory page", () => {
        const media = settings.memoryTranslateMedia;
        const remPunc = () => hit("Memory Punctuation Removal", "adv.remPunc")?.available;
        media.supaModelType = "subModel";
        media.hypaV3 = true;
        expect(remPunc()).toBe(false);
        media.hypaV3 = false;
        media.hanuraiEnable = true;
        expect(remPunc()).toBe(false);
        media.hanuraiEnable = false;
        expect(remPunc()).toBe(true);
        media.supaModelType = "none";
        expect(remPunc()).toBe(false);
    });

    it("lists a Connections item as unavailable when the main slot's profile was deleted", () => {
        expect(deleteModelProfile("pa")).toBe(true);
        expect(activeMainProfile.id).toBeUndefined();
        const maxContext = hit("Max Context Size", "params.maxContext");
        expect(maxContext).toMatchObject({ available: false, reason: "noMainProfile" });
        expect(maxContext?.profileId).toBeUndefined();
        expect(hit("Chat Format", "chatFormat.template")).toMatchObject({ available: false, reason: "noMainProfile" });
    });

    it("labels every hit, an item without a label of its own by its section", () => {
        for (const query of ["e", "a", "notification", "ㅅ", "custom", "color", "jinja"]) {
            const hits = searchSettings(query, ctx());
            expect(hits.length).toBeLessThanOrEqual(SETTING_HIT_LIMIT);
            for (const entry of hits) expect(entry.label, `${query} ${entry.id}`).not.toBe("");
        }
        expect(hit("notification", "display.notification")?.label).toBe("Notifications");
    });

    it("finds the pages and the Model tabs by their navigation labels", () => {
        const hits = searchSettings("connections", ctx());
        expect(hits[0]).toMatchObject({ kind: "page", id: `tab:${MODEL_PROFILES_SETTINGS_MENU}`, available: true });
        expect(searchSettings("", ctx())).toEqual([]);
    });
});
