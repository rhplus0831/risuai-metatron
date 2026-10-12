import { describe, expect, it, vi } from "vitest";

// The language page's translation items (`docs/plan/translation.md` slice 1.4, `media-aux.md`):
// `lang.llmTranslationTarget` is shown for the LLM translator only; `legacyTranslation` for every
// translator but the LLM one on `"message"` (it drives the rendered path); `translateBeforeHTML` and
// `autoTranslateCachedOnly` only for the LLM translator on `"rendered"`. The conditions read
// `ctx.settings.memoryTranslateMedia` alone, so a minimal context stands in for the real one.

vi.mock("../alert", () => ({
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertWait: vi.fn(),
}));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn() }));
vi.mock("../util", () => ({ sleep: vi.fn(async () => undefined), selectFileByDom: vi.fn() }));
vi.mock("../translator/translator", () => ({
    exportLLMCacheAsJSON: vi.fn(),
    importLLMCacheFromJSON: vi.fn(),
    clearLLMCache: vi.fn(),
}));

import { languageEnglish } from "src/lang/en";
import { languageSettingsItems } from "./languageSettingsData.svelte";
import type { SettingContext, SettingItem } from "./types";

type Media = { translator: string; translatorType: string; llmTranslationTarget: string };

const ctx = (media: Media): SettingContext =>
    ({ settings: { memoryTranslateMedia: media } }) as unknown as SettingContext;

const item = (id: string): SettingItem => {
    const found = languageSettingsItems.find((entry) => entry.id === id);
    expect(found, id).toBeDefined();
    return found!;
};

const shown = (id: string, media: Media) => item(id).condition!(ctx(media));

const WATCHED = [
    "lang.llmTranslationTarget",
    "lang.legacyTranslation",
    "lang.translateBeforeHTML",
    "lang.autoTranslateCachedOnly",
];
const visible = (media: Media) => WATCHED.filter((id) => shown(id, media));

describe("the language page's stored-translation items", () => {
    it("lang.llmTranslationTarget binds the field, offers the two targets by their labelKey entries, and has a help entry", () => {
        const select = item("lang.llmTranslationTarget");
        expect(select.type).toBe("select");
        expect(select.bindKey).toBe("llmTranslationTarget");
        expect(select.helpKey).toBe("llmTranslationTarget");
        expect(select.options?.selectOptions).toEqual([
            { value: "message", labelKey: "llmTranslationTargetMessage" },
            { value: "rendered", labelKey: "llmTranslationTargetRendered" },
        ]);
        expect(languageEnglish.llmTranslationTargetMessage).toBeTypeOf("string");
        expect(languageEnglish.llmTranslationTargetRendered).toBeTypeOf("string");
        expect(languageEnglish.help.llmTranslationTarget).toBeTypeOf("string");
        // It follows the preset editor, before the Google source language.
        const ids = languageSettingsItems.map((entry) => entry.id);
        expect(ids.indexOf("lang.llmTranslationTarget")).toBe(ids.indexOf("lang.llmPresets") + 1);
    });

    it("shows the select and the rendered-path toggles by translator and target", () => {
        // The LLM translator on the stored path: the select alone.
        expect(visible({ translator: "ko", translatorType: "llm", llmTranslationTarget: "message" })).toEqual([
            "lang.llmTranslationTarget",
        ]);
        // The LLM translator on the rendered path: the select and all three rendered toggles.
        expect(visible({ translator: "ko", translatorType: "llm", llmTranslationTarget: "rendered" })).toEqual(WATCHED);
        // Another translator: the legacy toggle only, whatever the target reads (a hidden value is kept).
        expect(visible({ translator: "ko", translatorType: "google", llmTranslationTarget: "message" })).toEqual([
            "lang.legacyTranslation",
        ]);
        expect(visible({ translator: "ko", translatorType: "deepl", llmTranslationTarget: "rendered" })).toEqual([
            "lang.legacyTranslation",
        ]);
        // No translator language: nothing.
        expect(visible({ translator: "", translatorType: "llm", llmTranslationTarget: "message" })).toEqual([]);
        expect(visible({ translator: "", translatorType: "google", llmTranslationTarget: "message" })).toEqual([]);
    });

    it("offers the four remaining translators and no Bergamot item (docs/plan/translation.md slice 1.5)", () => {
        expect(item("lang.translatorType").options?.selectOptions?.map((option) => option.value)).toEqual([
            "google",
            "deepl",
            "llm",
            "deeplX",
        ]);
        expect(languageSettingsItems.some((entry) => entry.id === "lang.bergamotHtml")).toBe(false);
        // `bindKey` is typed by the settings root keys, so a build fails on the dropped field already.
        expect(languageSettingsItems.some((entry) => (entry.bindKey as string) === "htmlTranslation")).toBe(false);
        expect(Object.hasOwn(languageEnglish, "htmlTranslation")).toBe(false);
    });

    it("keeps the auto-translate toggle and the cache buttons for the LLM translator on either target", () => {
        for (const target of ["message", "rendered"]) {
            const media = { translator: "ko", translatorType: "llm", llmTranslationTarget: target };
            const auto = item("lang.autoTranslate");
            expect(auto.condition ? auto.condition(ctx(media)) : true, `autoTranslate ${target}`).toBe(true);
            const cacheButtons = languageSettingsItems.filter((entry) => /^lang\.(export|import)Cache$/.test(entry.id));
            expect(cacheButtons.length).toBeGreaterThan(0);
            for (const button of cacheButtons) {
                expect(button.condition ? button.condition(ctx(media)) : true, `${button.id} ${target}`).toBe(true);
            }
        }
    });
});
