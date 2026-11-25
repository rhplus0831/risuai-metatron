import { describe, expect, it } from "vitest";
import { languageChinese } from "./cn";
import { languageGerman } from "./de";
import { languageEnglish } from "./en";
import { languageSpanish } from "./es";
import { languageKorean } from "./ko";
import { languageVietnamese } from "./vi";
import { languageChineseTraditional } from "./zh-Hant";

// TriggerV2List fills each `{{field}}` in a trigger description from the effect's field of that name, so a
// translated description must name exactly the fields its English source names.
const placeholders = (text: string) => [...new Set(text.match(/\{\{.+?\}\}/g) ?? [])].sort();

const locales = {
    cn: languageChinese,
    de: languageGerman,
    es: languageSpanish,
    ko: languageKorean,
    vi: languageVietnamese,
    "zh-Hant": languageChineseTraditional,
};

describe("trigger description placeholders", () => {
    it.each(Object.entries(locales))("%s names the same fields as English", (_code, locale) => {
        const english = languageEnglish.triggerDesc as Record<string, unknown>;
        const translated = (locale.triggerDesc ?? {}) as Record<string, unknown>;
        const mismatches = Object.entries(translated).flatMap(([key, text]) => {
            const source = english[key];
            if (typeof text !== "string" || typeof source !== "string") return [];
            const expected = placeholders(source);
            const actual = placeholders(text);
            return expected.join() === actual.join() ? [] : [{ key, expected, actual }];
        });
        expect(mismatches).toEqual([]);
    });
});
