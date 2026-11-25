import merge from "lodash/merge";
import { languageChinese } from "./cn";
import { languageGerman } from "./de";
import { languageEnglish } from "./en";
import { languageKorean } from "./ko";
import { languageVietnamese } from "./vi";
import { languageChineseTraditional } from "./zh-Hant";
import { languageSpanish } from "./es";

/**
 * Bundled UI locales. Manual selection needs a locale here, a `changeLanguage` branch, and an option
 * in `src/ts/setting/languageSettingsData.svelte.ts`; `BROWSER_UI_LANGUAGES` and
 * `BROWSER_UI_LANGUAGE_MAP` in `src/ts/bootstrap.ts` only control first-boot browser-language matching.
 */

/** Current UI strings, replaced by `changeLanguage`; English defines the complete type. */
export let language: typeof languageEnglish = languageEnglish;

/** Merge a recognized locale over a fresh English clone; English and unknown codes use English directly. */
export function changeLanguage(lang: string) {
    if (lang === "cn") {
        language = merge(safeStructuredClone(languageEnglish), languageChinese);
    } else if (lang === "de") {
        language = merge(safeStructuredClone(languageEnglish), languageGerman);
    } else if (lang === "ko") {
        language = merge(safeStructuredClone(languageEnglish), languageKorean);
    } else if (lang === "vi") {
        language = merge(safeStructuredClone(languageEnglish), languageVietnamese);
    } else if (lang === "zh-Hant") {
        language = merge(safeStructuredClone(languageEnglish), languageChineseTraditional);
    } else if (lang === "es") {
        language = merge(safeStructuredClone(languageEnglish), languageSpanish);
    } else {
        language = languageEnglish;
    }
}
