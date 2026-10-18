import { describe, expect, it } from "vitest";
import { languageEnglish } from "src/lang/en";
import { advancedSettingsHeader, advancedSettingsItems, advancedSettingsSections } from "./advancedSettingsData";
import { itemsById } from "./sections";
import type { SettingItem, SettingSection } from "./types";
import { getFullSettingsData } from "./utils";

// Settings UI plan (`docs/plan/settings-ui-reorg.md`) slice 2: a sectioned page builds its sections by
// id from its leaf arrays, so every leaf item is placed exactly once and the catalog
// (`getFullSettingsData`) still lists it once. Later slices add their pages to `PAGES`.

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
];

/** Item pairs whose second item's condition reads the first: they must share a section. */
const DEPENDENT_PAIRS: [string, string][] = [
    ["adv.dynAssets", "adv.dynAssetsEdit"],
    ["adv.promptInfo", "adv.promptTextInfo"],
];

const duplicates = (ids: string[]) => ids.filter((id, index) => ids.indexOf(id) !== index);

describe("settings page sections", () => {
    it("keeps item ids unique across the catalog", () => {
        expect(duplicates(getFullSettingsData().map((item) => item.id))).toEqual([]);
    });

    it("keeps section ids unique across every sectioned page", () => {
        expect(duplicates(PAGES.flatMap((page) => page.sections.map((section) => section.id)))).toEqual([]);
    });

    for (const page of PAGES) {
        it(`places every ${page.name} leaf item in exactly one section, as the leaf array's own object`, () => {
            const leaves = page.leaves.flat();
            const placed = page.sections.flatMap((section) => section.items);
            expect(duplicates(placed.map((item) => item.id))).toEqual([]);
            for (const item of [...placed, ...page.header]) {
                expect(leaves, item.id).toContain(item);
            }
            const headerIds = new Set(page.header.map((item) => item.id));
            const placedIds = new Set(placed.map((item) => item.id));
            expect(placed.filter((item) => headerIds.has(item.id)).map((item) => item.id)).toEqual([]);
            expect(
                leaves.filter((item) => !headerIds.has(item.id) && !placedIds.has(item.id)).map((item) => item.id),
            ).toEqual([]);
            // Every placed item is in the catalog once (the sections hold no copies).
            const catalog = getFullSettingsData();
            for (const item of placed) {
                expect(
                    catalog.filter((entry) => entry === item),
                    item.id,
                ).toHaveLength(1);
            }
        });
    }

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
