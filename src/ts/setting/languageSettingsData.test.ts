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
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
// `./utils` (the wrapper's write) reaches the settings views and the stores, whose module effect is
// not under test.
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
}));
vi.mock("../util", () => ({ sleep: vi.fn(async () => undefined), selectFileByDom: vi.fn() }));
vi.mock("../translator/translator", () => ({
    exportLLMCacheAsJSON: vi.fn(),
    importLLMCacheFromJSON: vi.fn(),
    clearLLMCache: vi.fn(),
}));

import { translatorHistoryMaxTokens } from "../../../shared/translation/historySlots.ts";
import { languageEnglish } from "src/lang/en";
import { languageSettingsItems } from "./languageSettingsData.svelte";
import type { SettingContext, SettingItem } from "./types";
import { getSettingValue, updateSettingValue } from "./utils";

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

    it("has no global auto-translate item (a chat setting since docs/plan/translation.md slice 2.1) and keeps the cache buttons for the LLM translator on either target", () => {
        expect(languageSettingsItems.some((entry) => entry.id === "lang.autoTranslate")).toBe(false);
        // `bindKey` is typed by the settings root keys, so a build fails on the dropped field already.
        expect(languageSettingsItems.some((entry) => (entry.bindKey as string) === "autoTranslate")).toBe(false);
        // The label stays: the chat panel's auto-translate row uses it.
        expect(languageEnglish.autoTranslation).toBeTypeOf("string");
        for (const target of ["message", "rendered"]) {
            const media = { translator: "ko", translatorType: "llm", llmTranslationTarget: target };
            const cacheButtons = languageSettingsItems.filter((entry) => /^lang\.(export|import)Cache$/.test(entry.id));
            expect(cacheButtons.length).toBeGreaterThan(0);
            for (const button of cacheButtons) {
                expect(button.condition ? button.condition(ctx(media)) : true, `${button.id} ${target}`).toBe(true);
            }
        }
    });
});

// `docs/plan/translation.md` slice 3.3: the history slots' budget, `lang.translatorHistoryMaxTokens`,
// a number item shown for the LLM translator on the stored translation only; its own getter reads
// the field as stored and its setter writes only what the server normalizer keeps (a finite number
// above 0, exactly), through the wrapper's `updateSettingValue`.
describe("the history budget item", () => {
    const BUDGET = "lang.translatorHistoryMaxTokens";
    const LLM_MESSAGE: Media = { translator: "ko", translatorType: "llm", llmTranslationTarget: "message" };
    /** A context whose `memoryTranslateMedia` record the test can read back. */
    const budgetCtx = (translatorHistoryMaxTokens: unknown, media: Media = LLM_MESSAGE) => {
        const record = { ...media, translatorHistoryMaxTokens };
        return { ctx: { settings: { memoryTranslateMedia: record } } as unknown as SettingContext, record };
    };

    it("is a number item right after the target select, with its label and help, a minimum hint of 1, and no bound key", () => {
        const budget = item(BUDGET);
        expect(budget.type).toBe("number");
        expect(budget.labelKey).toBe("translatorHistoryMaxTokens");
        expect(budget.helpKey).toBe("translatorHistoryMaxTokens");
        expect(budget.options).toEqual({ min: 1 });
        expect(budget.bindKey).toBeUndefined();
        expect(budget.bindPath).toBeUndefined();
        expect(budget.getValue).toBeTypeOf("function");
        expect(budget.setValue).toBeTypeOf("function");
        expect(languageEnglish.translatorHistoryMaxTokens).toBeTypeOf("string");
        expect(languageEnglish.help.translatorHistoryMaxTokens).toBeTypeOf("string");
        expect(languageEnglish.help.translatorPrompt).toContain("{{slot::history::N}}");
        expect(languageEnglish.help.translatorPrompt).toContain("{{slot::historytrans::N}}");
        const ids = languageSettingsItems.map((entry) => entry.id);
        expect(ids.indexOf(BUDGET)).toBe(ids.indexOf("lang.llmTranslationTarget") + 1);
    });

    it("is shown for the LLM translator on the stored translation only", () => {
        expect(shown(BUDGET, LLM_MESSAGE)).toBe(true);
        expect(shown(BUDGET, { ...LLM_MESSAGE, llmTranslationTarget: "rendered" })).toBe(false);
        expect(shown(BUDGET, { ...LLM_MESSAGE, translatorType: "google" })).toBe(false);
        expect(shown(BUDGET, { ...LLM_MESSAGE, translatorType: "deepl", llmTranslationTarget: "rendered" })).toBe(
            false,
        );
        expect(shown(BUDGET, { ...LLM_MESSAGE, translator: "" })).toBe(false);
    });

    it("reads the field as stored and writes only a finite number above 0, exactly, through the wrapper's write", () => {
        const budget = item(BUDGET);
        const { ctx, record } = budgetCtx(2048);
        expect(getSettingValue(budget, ctx)).toBe(2048);
        // What the normalizer would not keep never enters the record: a cleared field (NaN), 0, a
        // negative, a nonfinite, or a non-number.
        for (const value of [
            0,
            -0,
            -1,
            -0.5,
            Number.NaN,
            Infinity,
            -Infinity,
            "5",
            "",
            null,
            undefined,
            true,
            [],
            {},
        ]) {
            updateSettingValue(budget, value, ctx);
            expect(record.translatorHistoryMaxTokens, String(value)).toBe(2048);
        }
        // A valid write lands as it is (no rounding, a fraction kept) and is what the normalizer keeps.
        for (const value of [1, 0.5, 3000.25, 2048, 1e9]) {
            updateSettingValue(budget, value, ctx);
            expect(record.translatorHistoryMaxTokens, String(value)).toBe(value);
            expect(translatorHistoryMaxTokens(record.translatorHistoryMaxTokens), String(value)).toBe(value);
            expect(getSettingValue(budget, ctx), String(value)).toBe(value);
        }
        // No client-side default: a record without the field reads as it is.
        expect(getSettingValue(budget, budgetCtx(undefined).ctx)).toBeUndefined();
    });
});
