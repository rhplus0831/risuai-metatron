import { describe, expect, it } from "vitest";
import { languageEnglish } from "src/lang/en";
import { advancedSettingsHeader, advancedSettingsItems, advancedSettingsSections } from "./advancedSettingsData";
import { displaySettingsItems, displaySettingsSections, displaySettingsTabs } from "./displaySettingsData.svelte";
import { itemsById } from "./sections";
import {
    translationSettingsHeader,
    translationSettingsItems,
    translationSettingsSections,
} from "./translationSettingsData";
import type { SettingItem, SettingSection } from "./types";
import { getFullSettingsData } from "./utils";

// Settings UI plan (`docs/plan/settings-ui-reorg.md`) slice 2: a sectioned page builds its sections by
// id from its leaf arrays, so every leaf item is placed exactly once and the catalog
// (`getFullSettingsData`) still lists it once. Later slices add their pages to `PAGES`. An item moved
// to another page moves its definition into that page's leaf array (slice 6), so the placement check
// runs over every sectioned page at once.

interface SectionedPage {
    name: string;
    /** The leaf arrays the page renders (they stay the catalog). */
    leaves: SettingItem[][];
    /** Items rendered above the sections (the page heading), not in any section. */
    header: SettingItem[];
    sections: SettingSection[];
}

const PAGES: SectionedPage[] = [
    {
        name: "advanced",
        leaves: [advancedSettingsItems],
        header: advancedSettingsHeader,
        sections: advancedSettingsSections,
    },
    {
        name: "translation",
        leaves: [translationSettingsItems],
        header: translationSettingsHeader,
        sections: translationSettingsSections,
    },
    {
        // Sectioned per tab (slice 7); its heading is handwritten, so it has no header items.
        name: "display",
        leaves: [displaySettingsItems],
        header: [],
        sections: displaySettingsSections,
    },
];

/** Item pairs whose second item's condition reads the first: they must share a section. */
const DEPENDENT_PAIRS: [string, string][] = [
    ["adv.dynAssets", "adv.dynAssetsEdit"],
    ["adv.promptInfo", "adv.promptTextInfo"],
    ["lang.translatorLang", "lang.translatorType"],
    ["lang.translatorType", "lang.deeplKey"],
    ["lang.translatorType", "lang.deeplFree"],
    ["lang.translatorType", "lang.deeplXUrl"],
    ["lang.translatorType", "lang.deeplXToken"],
    ["lang.translatorType", "lang.llmPresets"],
    ["lang.translatorType", "lang.llmTranslationTarget"],
    ["lang.translatorType", "lang.googleSourceLang"],
    ["lang.llmTranslationTarget", "lang.translatorHistoryMaxTokens"],
    ["display.theme", "display.guiHTML"],
    ["display.theme", "display.waifuWidth"],
    ["display.theme", "display.waifuWidth2"],
    // `display.colorScheme` (ColorSchemeSelect) sets the `colorSchemeName` the editor's condition reads.
    ["display.colorScheme", "display.customColorScheme"],
    ["display.textTheme", "display.customTextTheme"],
    ["display.font", "display.customFont"],
    ["display.showMemoryLimit", "display.memoryLimitThickness"],
    ["display.customQuotes", "display.leadingDoubleQuote"],
    ["display.customQuotes", "display.trailingDoubleQuote"],
    ["display.customQuotes", "display.leadingSingleQuote"],
    ["display.customQuotes", "display.trailingSingleQuote"],
];

const duplicates = (ids: string[]) => ids.filter((id, index) => ids.indexOf(id) !== index);

describe("settings page sections", () => {
    it("keeps item ids unique across the catalog", () => {
        expect(duplicates(getFullSettingsData().map((item) => item.id))).toEqual([]);
    });

    it("keeps section ids unique across every sectioned page", () => {
        expect(duplicates(PAGES.flatMap((page) => page.sections.map((section) => section.id)))).toEqual([]);
    });

    it("places every leaf item of the sectioned pages in exactly one section, as a leaf array's own object", () => {
        const leaves = PAGES.flatMap((page) => page.leaves.flat());
        const headers = PAGES.flatMap((page) => page.header);
        const placed = PAGES.flatMap((page) => page.sections.flatMap((section) => section.items));
        expect(duplicates(leaves.map((item) => item.id))).toEqual([]);
        expect(duplicates(placed.map((item) => item.id))).toEqual([]);
        for (const item of [...placed, ...headers]) {
            expect(leaves, item.id).toContain(item);
        }
        const headerIds = new Set(headers.map((item) => item.id));
        const placedIds = new Set(placed.map((item) => item.id));
        expect(placed.filter((item) => headerIds.has(item.id)).map((item) => item.id)).toEqual([]);
        expect(
            leaves.filter((item) => !headerIds.has(item.id) && !placedIds.has(item.id)).map((item) => item.id),
        ).toEqual([]);
        // Every placed item and header is in the catalog once (the sections hold no copies).
        const catalog = getFullSettingsData();
        for (const item of [...placed, ...headers]) {
            expect(
                catalog.filter((entry) => entry === item),
                item.id,
            ).toHaveLength(1);
        }
    });

    for (const page of PAGES) {
        it(`builds the ${page.name} page's header and sections from its own leaf arrays`, () => {
            const leaves = page.leaves.flat();
            for (const item of [...page.header, ...page.sections.flatMap((section) => section.items)]) {
                expect(leaves, item.id).toContain(item);
            }
        });
    }

    it("keeps the Translation page's way in visible: the translator language select comes first, with no condition", () => {
        const select = translationSettingsItems.find((item) => item.id === "lang.translatorLang");
        expect(select).toBeDefined();
        expect(select!.condition).toBeUndefined();
        expect(translationSettingsSections[0].items[0]).toBe(select);
        expect(translationSettingsSections[0].collapsible).toBeFalsy();
    });

    it("splits the Display page into its four tabs, whose sections are the page's sections in tab order", () => {
        expect(displaySettingsTabs.map((tab) => tab.labelKey)).toEqual([
            "theme",
            "displayTabLayout",
            "displayTabChatAppearance",
            "displayTabSoundNotifications",
        ]);
        expect(displaySettingsTabs.flatMap((tab) => tab.sections)).toEqual(displaySettingsSections);
        const english = languageEnglish as Record<string, unknown>;
        for (const tab of displaySettingsTabs) {
            expect(typeof english[tab.labelKey], tab.labelKey).toBe("string");
            expect(tab.sections.length, tab.id).toBeGreaterThan(0);
        }
        // Collapsible only for the rarely used: Custom CSS.
        expect(displaySettingsSections.filter((section) => section.collapsible).map((section) => section.id)).toEqual([
            "display.theme.customCSS",
        ]);
    });

    it("keeps the memory limit thickness directly under the toggle its condition reads", () => {
        const ids = displaySettingsSections.flatMap((section) => section.items.map((item) => item.id));
        expect(ids[ids.indexOf("display.showMemoryLimit") + 1]).toBe("display.memoryLimitThickness");
    });

    it("gives every section an English heading, description, and badge for the keys it names", () => {
        const keys = PAGES.flatMap((page) =>
            page.sections.flatMap((section) =>
                [section.labelKey, section.descriptionKey, section.badgeKey].filter((key) => key !== undefined),
            ),
        );
        const english = languageEnglish as Record<string, unknown>;
        expect(keys.filter((key) => typeof english[key] !== "string" || english[key] === "")).toEqual([]);
    });

    it("keeps each dependent pair in one section", () => {
        const sections = PAGES.flatMap((page) => page.sections);
        for (const [first, second] of DEPENDENT_PAIRS) {
            const holder = sections.find((section) => section.items.some((item) => item.id === first));
            expect(holder, first).toBeDefined();
            expect(
                holder!.items.map((item) => item.id),
                `${second} with ${first}`,
            ).toContain(second);
        }
    });
});

describe("itemsById", () => {
    const leaf: SettingItem[] = [
        { id: "a", type: "check" },
        { id: "b", type: "check" },
    ];

    it("returns the leaf array's own objects in the order asked", () => {
        const items = itemsById(leaf, ["b", "a"]);
        expect(items).toEqual([leaf[1], leaf[0]]);
        expect(items[0]).toBe(leaf[1]);
        expect(items[1]).toBe(leaf[0]);
    });

    it("throws on an unknown id", () => {
        expect(() => itemsById(leaf, ["a", "missing"])).toThrow(/Unknown setting item id: missing/);
    });

    it("throws on an id asked for twice", () => {
        expect(() => itemsById(leaf, ["a", "b", "a"])).toThrow(/Duplicate setting item id: a/);
    });
});
