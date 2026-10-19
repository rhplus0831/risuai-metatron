/**
 * Translation Settings Data
 *
 * Data-driven definition for the TranslationSettings page (settings UI plan slice 6): the translator,
 * its options, and the LLM translator's cache. The UI language stays on the Language page
 * (`languageSettingsData.svelte.ts`).
 */

import type { SettingItem, SettingSection } from "./types";
import { itemsById } from "./sections";
import { language } from "src/lang";
import { selectFileByDom } from "../util";
import { alertNormal, alertConfirm, alertError, alertWait } from "../alert";
import { downloadFile } from "../globalApi.svelte";
import { exportLLMCacheAsJSON, importLLMCacheFromJSON, clearLLMCache } from "../translator/translator";

export const translationSettingsItems: SettingItem[] = [
    {
        id: "translation.header",
        type: "header",
        labelKey: "translationSettings",
        options: { level: "h2" },
    },

    // Translator Base
    {
        id: "lang.translatorLang",
        type: "select",
        labelKey: "translatorLanguage",
        bindKey: "translator",
        classes: "mt-4",
        options: {
            selectOptions: [
                { value: "", labelKey: "disabled" },
                { value: "ko", label: "Korean" },
                { value: "ru", label: "Russian" },
                { value: "zh", label: "Chinese" },
                {
                    value: "zh-TW",
                    label: "Chinese (Traditional)",
                    condition: (ctx) => ctx.settings.memoryTranslateMedia.translatorType === "google",
                },
                {
                    value: "fa",
                    label: "Persian (Farsi)",
                    condition: (ctx) => ctx.settings.memoryTranslateMedia.translatorType === "google",
                },
                { value: "ja", label: "Japanese" },
                { value: "fr", label: "French" },
                { value: "es", label: "Spanish" },
                { value: "pt", label: "Portuguese" },
                { value: "de", label: "German" },
                { value: "id", label: "Indonesian" },
                { value: "ms", label: "Malaysian" },
                { value: "uk", label: "Ukranian" },
            ],
        },
    },

    {
        id: "lang.translatorType",
        type: "select",
        labelKey: "translatorType",
        bindKey: "translatorType",
        classes: "mt-4",
        condition: (ctx) => !!ctx.settings.memoryTranslateMedia.translator,
        options: {
            selectOptions: [
                { value: "google", label: "Google" },
                { value: "deepl", label: "DeepL" },
                { value: "llm", label: "Ax. Model" },
                { value: "deeplX", label: "DeepL X" },
            ],
        },
    },

    // Translator Specific Configurations
    {
        id: "lang.deeplKey",
        type: "text",
        labelKey: "deeplKey",
        bindPath: "deeplOptions.key",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "deepl",
    },

    {
        id: "lang.deeplFree",
        type: "check",
        labelKey: "deeplFreeKey",
        bindPath: "deeplOptions.freeApi",
        classes: "mt-2",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "deepl",
    },

    {
        id: "lang.deeplXUrl",
        type: "text",
        labelKey: "deeplXUrl",
        bindPath: "deeplXOptions.url",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "deeplX",
    },

    {
        id: "lang.deeplXToken",
        type: "text",
        labelKey: "deeplXToken",
        bindPath: "deeplXOptions.token",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "deeplX",
    },

    {
        id: "lang.llmPresets",
        type: "custom",
        componentId: "TranslatorPresetSettings",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm",
    },

    {
        id: "lang.llmTranslationTarget",
        type: "select",
        labelKey: "llmTranslationTarget",
        bindKey: "llmTranslationTarget",
        helpKey: "llmTranslationTarget",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm",
        options: {
            selectOptions: [
                { value: "message", labelKey: "llmTranslationTargetMessage" },
                { value: "rendered", labelKey: "llmTranslationTargetRendered" },
            ],
        },
    },

    // The history slots' budget (`docs/plan/translation.md` slice 3.3): only the server runner builds
    // them, so it is shown for the stored path. Only a value the normalizer keeps is written (a finite
    // number above 0); a cleared field writes nothing.
    {
        id: "lang.translatorHistoryMaxTokens",
        type: "number",
        labelKey: "translatorHistoryMaxTokens",
        helpKey: "translatorHistoryMaxTokens",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm" &&
            ctx.settings.memoryTranslateMedia.llmTranslationTarget === "message",
        options: { min: 1 },
        getValue: (ctx) => ctx.settings.memoryTranslateMedia.translatorHistoryMaxTokens,
        setValue: (value, ctx) => {
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                ctx.settings.memoryTranslateMedia.translatorHistoryMaxTokens = value;
            }
        },
    },

    {
        id: "lang.googleSourceLang",
        type: "select",
        labelKey: "sourceLanguage",
        bindKey: "translatorInputLanguage",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "google",
        options: {
            selectOptions: [
                { value: "auto", label: "Auto" },
                { value: "en", label: "English" },
                { value: "zh", label: "Chinese" },
                { value: "ja", label: "Japanese" },
                { value: "ko", label: "Korean" },
                { value: "fr", label: "French" },
                { value: "es", label: "Spanish" },
                { value: "de", label: "German" },
                { value: "ru", label: "Russian" },
            ],
        },
    },

    // General Translation Options (auto-translate is a chat setting: the chat panel's translation section)
    {
        id: "lang.combineTranslation",
        type: "check",
        labelKey: "combineTranslation",
        bindKey: "combineTranslation",
        helpKey: "combineTranslation",
        classes: "mt-4",
        condition: (ctx) => !!ctx.settings.memoryTranslateMedia.translator,
    },

    {
        id: "lang.legacyTranslation",
        type: "check",
        labelKey: "legacyTranslation",
        bindKey: "legacyTranslation",
        helpKey: "legacyTranslation",
        classes: "mt-4",
        // The rendered path's option: every translator but the LLM one on `"message"` takes it.
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            (ctx.settings.memoryTranslateMedia.translatorType !== "llm" ||
                ctx.settings.memoryTranslateMedia.llmTranslationTarget === "rendered"),
    },

    {
        id: "lang.translateBeforeHTML",
        type: "check",
        labelKey: "translateBeforeHTMLFormatting",
        bindKey: "translateBeforeHTMLFormatting",
        helpKey: "translateBeforeHTMLFormatting",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm" &&
            ctx.settings.memoryTranslateMedia.llmTranslationTarget === "rendered",
    },

    {
        id: "lang.autoTranslateCachedOnly",
        type: "check",
        labelKey: "autoTranslateCachedOnly",
        bindKey: "autoTranslateCachedOnly",
        helpKey: "autoTranslateCachedOnly",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm" &&
            ctx.settings.memoryTranslateMedia.llmTranslationTarget === "rendered",
    },

    // Moved from Advanced (settings UI plan slice 6), keeping its id.
    {
        id: "adv.noWaitTrans",
        type: "check",
        labelKey: "noWaitForTranslate",
        bindKey: "noWaitForTranslate",
        classes: "mt-4",
    },

    // Moved from Accessibility (settings UI plan slice 6), keeping its id.
    {
        id: "acc.showTranslationLoading",
        type: "check",
        labelKey: "showTranslationLoading",
        bindKey: "showTranslationLoading",
        classes: "mt-4",
        keywords: ["translation", "loading", "indicator"],
    },

    // Moved from Advanced's experimental items (settings UI plan slice 6), keeping its id and its
    // `useExperimental` condition.
    {
        id: "adv.exp.googleTrans",
        type: "check",
        fallbackLabel: "New Google Translate Experimental",
        bindKey: "useExperimentalGoogleTranslator",
        condition: (ctx) => ctx.settings.ui.useExperimental,
        helpKey: "unrecommended",
        helpUnrecommended: true,
        classes: "mt-4",
    },

    // Translation Cache
    {
        id: "lang.exportCache",
        type: "button",
        labelKey: "exportTranslationCache",
        classes: "mt-4",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm",
        options: {
            onClick: async () => {
                alertWait(language.loading);
                try {
                    const cache = await exportLLMCacheAsJSON();
                    const entries = Object.keys(cache).length;
                    if (entries === 0) {
                        alertNormal(language.exportTranslationCacheEmpty);
                        return;
                    }
                    const json = JSON.stringify(cache, null, 2);
                    await downloadFile("translation_cache.json", new TextEncoder().encode(json));
                    alertNormal(language.exportTranslationCacheSuccess);
                } catch (e: any) {
                    alertError(e.message);
                }
            },
        },
    },

    {
        id: "lang.importCache",
        type: "button",
        labelKey: "importTranslationCache",
        classes: "mt-2",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm",
        options: {
            onClick: async () => {
                try {
                    const files = await selectFileByDom([".json"]);
                    if (!files || files.length === 0) return;
                    if (!files[0].name.endsWith(".json")) {
                        alertError("Invalid file type. Please select a .json file.");
                        return;
                    }
                    const text = await files[0].text();
                    const data = JSON.parse(text);
                    if (typeof data !== "object" || Array.isArray(data)) {
                        alertError("Invalid JSON format");
                        return;
                    }
                    for (const [key, value] of Object.entries(data)) {
                        if (typeof key !== "string" || typeof value !== "string") {
                            alertError("Invalid JSON format");
                            return;
                        }
                    }
                    const confirmed = await alertConfirm(language.importTranslationCacheConfirm);
                    if (!confirmed) return;
                    alertWait(language.loading);
                    const { count, failed } = await importLLMCacheFromJSON(data as Record<string, string>);
                    if (failed > 0) {
                        alertError(
                            language.importTranslationCacheFailed
                                .replace("{0}", String(count))
                                .replace("{1}", String(failed)),
                        );
                    } else {
                        alertNormal(language.importTranslationCacheSuccess.replace("{0}", String(count)));
                    }
                } catch (e: any) {
                    alertError(e.message);
                }
            },
        },
    },

    {
        id: "lang.clearCache",
        type: "button",
        labelKey: "clearTranslationCache",
        classes: "mt-2",
        condition: (ctx) =>
            !!ctx.settings.memoryTranslateMedia.translator &&
            ctx.settings.memoryTranslateMedia.translatorType === "llm",
        options: {
            onClick: async () => {
                try {
                    const confirmed = await alertConfirm(language.clearTranslationCacheConfirm);
                    if (!confirmed) return;
                    alertWait(language.loading);
                    await clearLLMCache();
                    alertNormal(language.clearTranslationCacheSuccess);
                } catch (e: any) {
                    alertError(e.message);
                }
            },
        },
    },
];

/** The page heading, above the sections. */
export const translationSettingsHeader: SettingItem[] = itemsById(translationSettingsItems, ["translation.header"]);

/**
 * The Translation page's sections (archived, `docs/archived-plan/README.md`, slice 6), over
 * `translationSettingsItems`. `lang.translatorLang` has no condition: it turns translation on, so the
 * Translator section always shows; most other items read `translator`/`translatorType` and hide with it.
 */
export const translationSettingsSections: SettingSection[] = [
    {
        id: "translation.translator",
        labelKey: "settingsSectionTranslator",
        descriptionKey: "settingsSectionTranslatorDesc",
        items: itemsById(translationSettingsItems, [
            "lang.translatorLang",
            "lang.translatorType",
            "lang.deeplKey",
            "lang.deeplFree",
            "lang.deeplXUrl",
            "lang.deeplXToken",
            "lang.llmPresets",
            "lang.llmTranslationTarget",
            "lang.translatorHistoryMaxTokens",
            "lang.googleSourceLang",
        ]),
    },
    {
        id: "translation.behavior",
        labelKey: "settingsSectionTranslationBehavior",
        items: itemsById(translationSettingsItems, [
            "lang.combineTranslation",
            "lang.legacyTranslation",
            "lang.translateBeforeHTML",
            "lang.autoTranslateCachedOnly",
            "adv.noWaitTrans",
            "acc.showTranslationLoading",
        ]),
    },
    {
        id: "translation.experimental",
        labelKey: "settingsSectionExperimental",
        descriptionKey: "settingsSectionExperimentalDesc",
        collapsible: true,
        items: itemsById(translationSettingsItems, ["adv.exp.googleTrans"]),
    },
    {
        id: "translation.cache",
        labelKey: "settingsSectionTranslationCache",
        descriptionKey: "settingsSectionTranslationCacheDesc",
        items: itemsById(translationSettingsItems, ["lang.exportCache", "lang.importCache", "lang.clearCache"]),
    },
];
