import type { SettingItem } from "./types";
import { changeLanguage, language } from "src/lang";
import { languageEnglish } from "src/lang/en";
import { sleep } from "../util";
import { alertNormal, alertSelect } from "../alert";
import { downloadFile } from "../globalApi.svelte";

/**
 * UI language data for `src/lib/Setting/Pages/LanguageSettings.svelte`; translator options belong to
 * `src/ts/setting/translationSettingsData.ts`. `translang` exports a locale for translators, not a UI
 * locale. Bundled locales, picker options, and first-boot browser matching in `src/ts/bootstrap.ts`
 * are separate lists. The `.svelte.ts` extension supports reactive `langState`.
 */

/** Whether a local language change has completed; controls the close-settings warning. */
export const langState = $state({ changed: false });

/** UI language picker and its warning; `translang` is the translation-file export action. */
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
        /**
         * When `translang` is selected, export the locale and restore English; then apply the stored
         * UI language and set `langState.changed`.
         */
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
