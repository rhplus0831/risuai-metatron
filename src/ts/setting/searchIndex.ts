// The settings search: where each registry item lives, and a ranked search over the items, their
// sections, and the settings pages. Pure: no runes, no DOM. The location table is built from the
// same leaf arrays and sections the pages render, never from copies, so an item that moves page
// moves its location with it.
import type { SettingContext, SettingItem, SettingSection } from "./types";
import { language } from "src/lang";
import { languageEnglish } from "src/lang/en";
import { matchText, prepareQuery, MATCH_SCORE, type PreparedQuery } from "../util/koreanSearch";
import { activeMainProfile } from "../storage/settingsViews.svelte";
import {
    API_KEYS_SETTINGS_MENU,
    IMAGE_GENERATION_SETTINGS_MENU,
    INTERACTION_SETTINGS_MENU,
    MEMORY_SETTINGS_MENU,
    MODEL_PROFILES_SETTINGS_MENU,
    MODEL_SETTINGS_MENU,
    PROMPT_SETTINGS_MENU,
    TRANSLATION_SETTINGS_MENU,
    VOICE_SETTINGS_MENU,
} from "../settingsMenu";
import { accessibilitySettingsHeader, accessibilitySettingsSections } from "./accessibilitySettingsData";
import { advancedSettingsHeader, advancedSettingsSections } from "./advancedSettingsData";
import { allBasicParameterItems, modelParameterItems } from "./botSettingsParamsData";
import { chatFormatSettingsItems } from "./chatFormatSettingsData";
import { displaySettingsTabs } from "./displaySettingsData.svelte";
import { interactionSettingsHeader, interactionSettingsSections } from "./interactionSettingsData";
import { languageSettingsItems } from "./languageSettingsData.svelte";
import { memorySettingsSections, memorySupaMemoryItems } from "./memorySettingsData";
import { modelAdditionalParamsItems, modelSettingsSections } from "./modelSettingsData";
import { promptSettingsSections } from "./promptSettingsData";
import { translationSettingsHeader, translationSettingsSections } from "./translationSettingsData";
import { voiceSettingsItems } from "./voiceSettingsData";
import { checkCondition, getFullSettingsData, getLabel, languageText, sectionHasVisibleItems } from "./utils";

type Language = typeof languageEnglish;

/** A handwritten accordion that must start open for its item to show. */
export type SettingOpener = "model.additionalParams" | "profile.chatFormat";

/** Where a jump goes: the page (`SettingsMenuIndex`), its tab, section, and accordion. */
export interface SettingTarget {
    menu: number;
    /** Display's tab id (`displaySettingsTabs`), or the Prompt page's `submenu` (1 parameters, 3 others). */
    tab?: string | number;
    /** The `SettingSection.id` holding the item. */
    sectionId?: string;
    opener?: SettingOpener;
}

/** An item's one canonical destination. */
export interface SettingLocation extends SettingTarget {
    itemId: string;
    /** The parents' conditions the registry does not carry (a handwritten page's `{#if}` chain). */
    available?: (ctx: SettingContext) => boolean;
}

/** Why a hit is listed but cannot be shown. */
export type SettingUnavailableReason = "hidden" | "noMainProfile";

export interface SettingHit {
    kind: "item" | "section" | "page";
    /** The item id, the section id, or `page:<menu>` (a navigation entry) / `tab:<menu>` (a Model tab). */
    id: string;
    /** Never empty, in the current language. */
    label: string;
    /** The page, its tab, and the section, in the current language. */
    breadcrumb: string[];
    target: SettingTarget;
    /** A Connections item's target profile: the main slot's. */
    profileId?: string;
    available: boolean;
    reason?: SettingUnavailableReason;
    score: number;
}

export const SETTING_HIT_LIMIT = 50;

/** The Prompt preset page's `submenu` values. */
const PROMPT_PARAMETERS_TAB = 1;
const PROMPT_OTHERS_TAB = 3;

interface SectionPlace {
    section: SettingSection;
    target: SettingTarget;
}

const locations: SettingLocation[] = [];
const sectionPlaces: SectionPlace[] = [];

function placeItems(items: readonly SettingItem[], place: Omit<SettingLocation, "itemId">): void {
    for (const item of items) {
        if (item.type === "header" || item.type === "accordion") continue;
        locations.push({ itemId: item.id, ...place });
    }
}

function placeSections(sections: readonly SettingSection[], target: SettingTarget): void {
    for (const section of sections) {
        const sectionTarget = { ...target, sectionId: section.id };
        sectionPlaces.push({ section, target: sectionTarget });
        placeItems(section.items, sectionTarget);
    }
}

// `MemorySettings.svelte`'s chain: Hanurai, then HypaV2, then HypaV3, then the SupaMemory block
// (the only renderer of `memorySupaMemoryItems`), whose own test is transcribed as written.
const supaMemoryBranch = (ctx: SettingContext): boolean => {
    const media = ctx.settings.memoryTranslateMedia;
    return (
        !media.hanuraiEnable &&
        !media.hypav2 &&
        !media.hypaV3 &&
        media.supaModelType !== "none" &&
        media.hypav2 === false &&
        media.hypaV3 === false
    );
};

placeItems(accessibilitySettingsHeader, { menu: 11 });
placeSections(accessibilitySettingsSections, { menu: 11 });
placeItems(interactionSettingsHeader, { menu: INTERACTION_SETTINGS_MENU });
placeSections(interactionSettingsSections, { menu: INTERACTION_SETTINGS_MENU });
placeItems(advancedSettingsHeader, { menu: 6 });
placeSections(advancedSettingsSections, { menu: 6 });
placeItems(translationSettingsHeader, { menu: TRANSLATION_SETTINGS_MENU });
placeSections(translationSettingsSections, { menu: TRANSLATION_SETTINGS_MENU });
for (const tab of displaySettingsTabs) {
    placeSections(tab.sections, { menu: 3, tab: tab.id });
}
placeItems(modelAdditionalParamsItems, { menu: MODEL_SETTINGS_MENU, opener: "model.additionalParams" });
placeSections(modelSettingsSections, { menu: MODEL_SETTINGS_MENU });
// The Prompt page's Ooba block (`OobaSettings.svelte`) renders the chat format items too; Connections
// is their destination.
placeItems(modelParameterItems, { menu: MODEL_PROFILES_SETTINGS_MENU });
placeItems(chatFormatSettingsItems, { menu: MODEL_PROFILES_SETTINGS_MENU, opener: "profile.chatFormat" });
placeItems(allBasicParameterItems, { menu: PROMPT_SETTINGS_MENU, tab: PROMPT_PARAMETERS_TAB });
placeSections(promptSettingsSections, { menu: PROMPT_SETTINGS_MENU, tab: PROMPT_OTHERS_TAB });
placeItems(memorySupaMemoryItems, { menu: MEMORY_SETTINGS_MENU, available: supaMemoryBranch });
placeSections(memorySettingsSections, { menu: MEMORY_SETTINGS_MENU });
// Rendered under the emotion method's select, which gates nothing.
placeItems(voiceSettingsItems, { menu: VOICE_SETTINGS_MENU });
placeItems(languageSettingsItems, { menu: 10 });

/** Every non-header, non-accordion registry item's location, in page order. */
export const SETTING_LOCATIONS: readonly SettingLocation[] = locations;

const locationById = new Map(locations.map((location) => [location.itemId, location]));
const sectionById = new Map(sectionPlaces.map((place) => [place.section.id, place.section]));

export function settingLocation(itemId: string): SettingLocation | undefined {
    return locationById.get(itemId);
}

interface PageEntry {
    menu: number;
    label: (lang: Language) => string;
}

// The navigation entries of `Settings.svelte` (`navGroups`), in its order.
const PAGES: PageEntry[] = [
    { menu: MODEL_SETTINGS_MENU, label: (lang) => lang.model },
    { menu: PROMPT_SETTINGS_MENU, label: (lang) => lang.prompt },
    { menu: 12, label: (lang) => lang.persona },
    { menu: MEMORY_SETTINGS_MENU, label: (lang) => lang.memorySettings },
    { menu: IMAGE_GENERATION_SETTINGS_MENU, label: (lang) => lang.imageGeneration },
    { menu: VOICE_SETTINGS_MENU, label: (lang) => lang.voiceSettings },
    { menu: TRANSLATION_SETTINGS_MENU, label: (lang) => lang.translationSettings },
    { menu: 14, label: (lang) => lang.modules },
    { menu: 4, label: (lang) => lang.plugin },
    { menu: 3, label: (lang) => lang.display },
    { menu: INTERACTION_SETTINGS_MENU, label: (lang) => lang.interactionSettings },
    { menu: 11, label: (lang) => lang.accessibility },
    { menu: 10, label: (lang) => lang.language },
    { menu: 15, label: (lang) => lang.hotkey },
    { menu: 0, label: (lang) => lang.backups },
    { menu: 6, label: (lang) => lang.advancedSettings },
    { menu: 77, label: (lang) => lang.supporterThanks },
];

// The Model menu's tabs (`ModelMenuTabs.svelte`), which share its one navigation entry.
const MODEL_TABS: PageEntry[] = [
    { menu: MODEL_SETTINGS_MENU, label: (lang) => lang.modelPresetTab },
    { menu: MODEL_PROFILES_SETTINGS_MENU, label: (lang) => lang.modelProfiles.title },
    { menu: API_KEYS_SETTINGS_MENU, label: (lang) => lang.apiKeys },
];

const PROMPT_TABS: Record<number, (lang: Language) => string> = {
    [PROMPT_PARAMETERS_TAB]: (lang) => lang.parameters,
    [PROMPT_OTHERS_TAB]: (lang) => lang.others,
};

function englishText(key: string | undefined): string {
    const value = key ? (languageEnglish as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : "";
}

function englishLabel(item: SettingItem): string {
    return englishText(item.labelKey) || (item.fallbackLabel ?? "");
}

function breadcrumbOf(target: SettingTarget): string[] {
    const isModelTab = MODEL_TABS.some((tab) => tab.menu === target.menu);
    const page = isModelTab ? PAGES[0] : PAGES.find((entry) => entry.menu === target.menu);
    const crumbs = page ? [page.label(language)] : [];
    if (isModelTab) {
        crumbs.push(MODEL_TABS.find((tab) => tab.menu === target.menu)!.label(language));
    }
    if (typeof target.tab === "string") {
        const tab = displaySettingsTabs.find((entry) => entry.id === target.tab);
        if (tab) crumbs.push(languageText(tab.labelKey));
    } else if (typeof target.tab === "number" && PROMPT_TABS[target.tab]) {
        crumbs.push(PROMPT_TABS[target.tab](language));
    }
    const section = target.sectionId ? sectionById.get(target.sectionId) : undefined;
    if (section) crumbs.push(languageText(section.labelKey));
    return crumbs.filter((crumb) => crumb !== "");
}

function bestMatch(texts: readonly string[], query: PreparedQuery): number {
    let best = 0;
    for (const text of texts) {
        if (text !== "") best = Math.max(best, matchText(text, query));
    }
    return best;
}

/** A label match outranks every keyword or section-title match. */
const LABEL_RANK = MATCH_SCORE.exact;

interface Candidate {
    score: number;
    build: () => SettingHit;
}

/**
 * The hits for `query`, best first, at most `SETTING_HIT_LIMIT`: the navigation pages and the Model
 * tabs, the section titles, and every registry item but headers and accordions. An item matches on
 * its label (current language and English), its keywords, and its section's title; equal scores
 * keep that order. `ctx` is the context the pages render with; a Connections item is checked
 * against the main slot's profile instead, and a hit whose own or parents' condition fails stays
 * listed as unavailable.
 */
export function searchSettings(query: string, ctx: SettingContext): SettingHit[] {
    const prepared = prepareQuery(query);
    if (!prepared) return [];
    const candidates: Candidate[] = [];

    const addPage = (entry: PageEntry, idPrefix: "page" | "tab") => {
        const label = entry.label(language);
        const score = bestMatch([label, entry.label(languageEnglish)], prepared);
        if (score === 0 || label === "") return;
        candidates.push({
            score: LABEL_RANK + score,
            build: () => {
                const target = { menu: entry.menu };
                const breadcrumb = breadcrumbOf(target);
                return {
                    kind: "page",
                    id: `${idPrefix}:${entry.menu}`,
                    label,
                    // A Model tab's own label is its last crumb; the hit shows the menu above it.
                    breadcrumb: idPrefix === "tab" ? breadcrumb.slice(0, -1) : [],
                    target,
                    available: true,
                    score: LABEL_RANK + score,
                };
            },
        });
    };
    PAGES.forEach((entry) => addPage(entry, "page"));
    MODEL_TABS.forEach((entry) => addPage(entry, "tab"));

    for (const { section, target } of sectionPlaces) {
        const label = languageText(section.labelKey);
        const score = bestMatch([label, englishText(section.labelKey)], prepared);
        if (score === 0 || label === "") continue;
        candidates.push({
            score: LABEL_RANK + score,
            build: () => {
                const available = sectionHasVisibleItems(section, ctx);
                return {
                    kind: "section",
                    id: section.id,
                    label,
                    breadcrumb: breadcrumbOf({ ...target, sectionId: undefined }),
                    target,
                    available,
                    ...(available ? {} : { reason: "hidden" as const }),
                    score: LABEL_RANK + score,
                };
            },
        });
    }

    for (const item of getFullSettingsData()) {
        const location = locationById.get(item.id);
        if (!location) continue;
        const section = location.sectionId ? sectionById.get(location.sectionId) : undefined;
        const ownLabel = getLabel(item);
        const sectionLabel = section ? languageText(section.labelKey) : "";
        const label = ownLabel || sectionLabel;
        if (label === "") continue;
        const labelScore = bestMatch([ownLabel, englishLabel(item)], prepared);
        const otherScore = bestMatch(
            [...(item.keywords ?? []), sectionLabel, section ? englishText(section.labelKey) : ""],
            prepared,
        );
        const score = labelScore > 0 ? LABEL_RANK + labelScore : otherScore;
        if (score === 0) continue;
        candidates.push({ score, build: () => itemHit(item, location, section, label, score, ctx) });
    }

    // `sort` is stable, so equal scores keep the order above.
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, SETTING_HIT_LIMIT).map((candidate) => candidate.build());
}

function itemHit(
    item: SettingItem,
    location: SettingLocation,
    section: SettingSection | undefined,
    label: string,
    score: number,
    ctx: SettingContext,
): SettingHit {
    const target: SettingTarget = { menu: location.menu };
    if (location.tab !== undefined) target.tab = location.tab;
    if (location.sectionId !== undefined) target.sectionId = location.sectionId;
    if (location.opener !== undefined) target.opener = location.opener;
    const hit: SettingHit = {
        kind: "item",
        id: item.id,
        label,
        breadcrumb: breadcrumbOf(target),
        target,
        available: true,
        score,
    };
    let itemCtx = ctx;
    if (location.menu === MODEL_PROFILES_SETTINGS_MENU) {
        // Connections edits the profile it selects; the jump selects the main slot's, so the
        // conditions read that one. A dangling main slot gets no substitute.
        const profileId = activeMainProfile.id;
        if (profileId === undefined) {
            return { ...hit, available: false, reason: "noMainProfile" };
        }
        hit.profileId = profileId;
        itemCtx = { ...ctx, modelProfile: activeMainProfile };
    }
    const available =
        checkCondition(item, itemCtx) &&
        (location.available?.(itemCtx) ?? true) &&
        (section ? sectionHasVisibleItems(section, itemCtx) : true);
    return available ? hit : { ...hit, available: false, reason: "hidden" };
}
