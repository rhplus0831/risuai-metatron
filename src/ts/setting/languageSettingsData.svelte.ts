/**
 * Language Settings Data
 *
 * Data-driven definition for the LanguageSettings page: the UI language only. The translator and its
 * options are the Translation page's (`translationSettingsData.ts`).
 * Uses `.svelte.ts` extension to support reactive `langState` via Svelte 5 runes.
 */

import type { SettingItem } from "./types";
import { changeLanguage, language } from "src/lang";
import { languageEnglish } from "src/lang/en";
import { sleep } from "../util";
import { alertNormal, alertSelect } from "../alert";
import { downloadFile } from "../globalApi.svelte";

export const langState = $state({ changed: false });

export const languageSettingsItems: SettingItem[] = [
    {
        id: "lang.header",
        type: "header",
        labelKey: "language",
        options: { level: "h2" },
    },

    // UI Language
    {
        id: "lang.uiLanguage",
        type: "select",
        labelKey: "UiLanguage",
        bindKey: "language",
        classes: "mt-4",
        options: {
            selectOptions: [
                { value: "de", label: "Deutsch" },
                { value: "en", label: "English" },
                { value: "ko", label: "한국어" },
                { value: "cn", label: "中文" },
                { value: "zh-Hant", label: "中文(繁體)" },
                { value: "vi", label: "Tiếng Việt" },
                { value: "translang", label: "[Translate in your own language]" },
            ],
        },
        onChange: async (val, ctx) => {
            if (val === "translang") {
                const j = await alertSelect(["Continue Translating Existing Language", "Make a new language"]);

                if (parseInt(j) === 0) {
                    const langs = ["de", "ko", "cn", "vi", "zh-Hant"];
                    const lang = parseInt(await alertSelect(langs));
                    changeLanguage(langs[lang]);
                    downloadFile("lang.json", new TextEncoder().encode(JSON.stringify(language, null, 4)));
                    alertNormal(
                        "Downloaded JSON, translate it, and send it to the dev by discord DM and email. I will add it to the next version.",
                    );
                } else {
                    downloadFile("lang.json", new TextEncoder().encode(JSON.stringify(languageEnglish, null, 4)));
                    alertNormal(
                        "Downloaded JSON, translate it, and send it to the dev by discord DM and email. I will add it to the next version.",
                    );
                }

                ctx.settings.ui.language = "en";
            }

            await sleep(10);
            changeLanguage(ctx.settings.ui.language);
            langState.changed = true;
        },
    },

    {
        id: "lang.restartWarn",
        type: "header",
        fallbackLabel: "Close the settings to take effect",
        options: { level: "span" },
        classes: "bg-red-500 text-sm",
        condition: () => langState.changed,
    },
];
