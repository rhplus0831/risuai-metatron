import { describe, expect, it } from "vitest";
import { languageEnglish } from "src/lang/en";
import { CONTEXT_METER_FIXED_WARN } from "../../../shared/database.ts";
import {
    accessibilitySettingsHeader,
    accessibilitySettingsItems,
    accessibilitySettingsSections,
} from "./accessibilitySettingsData";
import { advancedSettingsHeader, advancedSettingsItems, advancedSettingsSections } from "./advancedSettingsData";
import { displaySettingsItems, displaySettingsSections, displaySettingsTabs } from "./displaySettingsData.svelte";
import {
    interactionSettingsHeader,
    interactionSettingsItems,
    interactionSettingsSections,
} from "./interactionSettingsData";
import { memorySettingsItems, memorySettingsSections, memorySupaMemoryItems } from "./memorySettingsData";
import { modelAdditionalParamsItems, modelSettingsItems, modelSettingsSections } from "./modelSettingsData";
import { promptSettingsItems, promptSettingsSections } from "./promptSettingsData";
import { itemsById } from "./sections";
import {
    translationSettingsHeader,
    translationSettingsItems,
    translationSettingsSections,
} from "./translationSettingsData";
import type { SettingContext, SettingItem, SettingSection } from "./types";
import { getFullSettingsData } from "./utils";
import { voiceSettingsItems } from "./voiceSettingsData";

// A sectioned page builds its sections by id from its leaf arrays, so every leaf item is placed
// exactly once and the catalog (`getFullSettingsData`) still lists it once. Every sectioned page is
// listed in `PAGES`. An item moved to another page moves its definition into that page's leaf array,
// so the placement check runs over every sectioned page at once.

interface SectionedPage {
    name: string;
    /** The leaf arrays the page renders (they stay the catalog). */
    leaves: SettingItem[][];
    /**
     * Items rendered outside any section: the page heading, or the items a handwritten page places
     * among its own controls.
     */
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
        // Sectioned per tab; its heading is handwritten, so it has no header items.
        name: "display",
        leaves: [displaySettingsItems],
        header: [],
        sections: displaySettingsSections,
    },
    // The pages that received items from Advanced. Their headings are handwritten.
    {
        name: "model",
        leaves: [modelSettingsItems],
        header: modelAdditionalParamsItems,
        sections: modelSettingsSections,
    },
    {
        name: "prompt",
        leaves: [promptSettingsItems],
        header: [],
        sections: promptSettingsSections,
    },
    {
        name: "memory",
        leaves: [memorySettingsItems],
        header: memorySupaMemoryItems,
        sections: memorySettingsSections,
    },
    {
        name: "voice",
        leaves: [voiceSettingsItems],
        header: voiceSettingsItems,
        sections: [],
    },
    // Accessibility split into the Interaction page and what stays.
    {
        name: "interaction",
        leaves: [interactionSettingsItems],
        header: interactionSettingsHeader,
        sections: interactionSettingsSections,
    },
    {
        name: "accessibility",
        leaves: [accessibilitySettingsItems],
        header: accessibilitySettingsHeader,
        sections: accessibilitySettingsSections,
    },
];

/** Item pairs whose second item's condition reads the first: they must share a section. */
const DEPENDENT_PAIRS: [string, string][] = [
    ["adv.dynAssets", "adv.dynAssetsEdit"],
    ["adv.promptInfo", "adv.promptTextInfo"],
    // Not a condition, but the minimum only means something with auto-continue on.
    ["adv.autoCont", "adv.autoContinueMin"],
    ["acc.autoScrollToNewMessage", "acc.alwaysScrollToNewMessage"],
    ["acc.autoScrollToNewMessage", "acc.scrollToReplyStartAfterStreaming"],
    ["acc.autoScrollToNewMessage", "acc.newMessageButtonStyle"],
    ["acc.alwaysScrollToNewMessage", "acc.newMessageButtonStyle"],
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
    ["interaction.contextMeterEnabled", "interaction.contextMeterTurnUnit"],
    ["interaction.contextMeterEnabled", "interaction.contextMeterFixedWarn"],
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

    it("takes Advanced apart: only its own sections' items stay, and the local network controls left the catalog", () => {
        const advancedIds = advancedSettingsSections.flatMap((section) => section.items.map((item) => item.id));
        for (const moved of [
            "adv.retries",
            "adv.customModels",
            "adv.addPrompt",
            "adv.banChar",
            "adv.lbDepth",
            "adv.remPunc",
            "adv.emoPrompt",
            "adv.personaNote",
            "display.showPromptComparison",
            "adv.scrollToActive",
            "adv.bookmark",
        ]) {
            expect(advancedIds, moved).not.toContain(moved);
        }
        expect(advancedSettingsSections.map((section) => section.id)).not.toContain("advanced.other");
        const catalog = getFullSettingsData();
        const chatNavigation = interactionSettingsSections.find(
            (section) => section.id === "interaction.chatNavigation",
        )!;
        for (const id of ["adv.scrollToActive", "adv.bookmark"]) {
            expect(
                chatNavigation.items.map((item) => item.id),
                id,
            ).toContain(id);
            expect(
                catalog.filter((item) => item.id === id),
                id,
            ).toHaveLength(1);
        }
        expect(
            catalog.filter((item) => item.bindKey === "localNetworkMode" || item.bindKey === "localNetworkTimeoutSec"),
        ).toEqual([]);
        // The preset pages say their moved globals apply to every preset; their custom editors have no accordion of their own.
        for (const section of [...modelSettingsSections, ...promptSettingsSections]) {
            expect(section.collapsible, section.id).toBe(true);
            expect(section.descriptionKey, section.id).toBeDefined();
        }
        for (const id of ["adv.customModels", "adv.banChar"]) {
            expect(catalog.find((item) => item.id === id)!.componentProps, id).toEqual({ noAccordion: true });
        }
    });

    it("keeps the memory limit thickness directly under the toggle its condition reads", () => {
        const ids = displaySettingsSections.flatMap((section) => section.items.map((item) => item.id));
        expect(ids[ids.indexOf("display.showMemoryLimit") + 1]).toBe("display.memoryLimitThickness");
    });

    it("puts the context meter's settings in their own Interaction section, the basis settings shown only while the meter is on", () => {
        const section = interactionSettingsSections.find((entry) => entry.id === "interaction.contextMeter")!;
        expect(section.collapsible).toBeFalsy();
        expect(section.items.map((item) => item.id)).toEqual([
            "interaction.contextMeterEnabled",
            "interaction.contextMeterTurnUnit",
            "interaction.contextMeterFixedWarn",
        ]);
        const [enabled, turnUnit, fixedWarn] = section.items;
        expect(enabled.bindKey).toBe("contextMeter");
        expect(enabled.condition).toBeUndefined();
        const ctx = (ui: Record<string, unknown>) => ({ settings: { ui } }) as unknown as SettingContext;
        for (const item of [turnUnit, fixedWarn]) {
            expect(item.condition!(ctx({ contextMeter: true })), item.id).toBe(true);
            expect(item.condition!(ctx({ contextMeter: false })), item.id).toBe(false);
        }
        // Read as the meter reads it: anything but `message` counts turns.
        expect(turnUnit.options?.segmentOptions?.map((option) => option.value)).toEqual(["user", "message"]);
        expect(turnUnit.getValue!(ctx({ contextMeterTurnUnit: "message" }))).toBe("message");
        for (const stored of ["user", "turn", undefined]) {
            expect(turnUnit.getValue!(ctx({ contextMeterTurnUnit: stored })), String(stored)).toBe("user");
        }
        expect(fixedWarn).toMatchObject({ type: "slider", bindKey: "contextMeterFixedWarn" });
        expect([fixedWarn.options?.min, fixedWarn.options?.max]).toEqual([
            CONTEXT_METER_FIXED_WARN.min,
            CONTEXT_METER_FIXED_WARN.max,
        ]);
        const english = languageEnglish as unknown as Record<string, unknown> & { help: Record<string, unknown> };
        for (const item of section.items) {
            expect(typeof english[item.labelKey!], item.id).toBe("string");
            if (item.helpKey) expect(typeof english.help[item.helpKey], item.id).toBe("string");
        }
        for (const option of turnUnit.options!.segmentOptions!) {
            expect(typeof english[option.labelKey!], String(option.value)).toBe("string");
        }
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
