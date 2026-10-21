// The settings deep link: opening a search hit records a jump and remounts the target page, so the
// mount-time consumers (Display's `takeRequestedDisplayTab`, `Accordion`'s `startOpen`, the Prompt
// page's tab, the Connections selection) apply on every jump, also to the page already shown.
// `Settings.svelte` keys its page by the menu and `jumpVersion()`, and runs the jump (scroll or the
// unavailable note) once the page mounted.
import { tick } from "svelte";
import { get } from "svelte/store";
import { SettingsMenuIndex, settingsOpen } from "../stores.svelte";
import { requestDisplayTab } from "./displaySettingsData.svelte";
import type { SettingHit, SettingOpener, SettingUnavailableReason } from "./searchIndex";

/** A recorded jump: the hit's destination, copied at `openSetting`. */
export interface SettingJump {
    version: number;
    kind: SettingHit["kind"];
    /** The item id, the section id, or the page/tab hit's id. */
    id: string;
    menu: number;
    tab?: string | number;
    sectionId?: string;
    opener?: SettingOpener;
    profileId?: string;
    available: boolean;
    reason?: SettingUnavailableReason;
}

/** How long the row's highlight ring stays (as the chat's `scrollToMessage`). */
export const SETTING_HIGHLIGHT_MS = 2000;
const HIGHLIGHT_CLASSES = ["ring-2", "ring-primary-500"];

/** Only `openSetting` increments it, and nothing clears it: the page key reads it. */
let version = $state(0);
/** The jump the next mount of its page applies; not reactive, nothing renders from it. */
let pending: SettingJump | null = null;

/** The current jump version (reactive): `Settings.svelte` keys its page by it. */
export function jumpVersion(): number {
    return version;
}

/**
 * Open the settings at a search hit: a new jump version, the jump recorded for the page's next mount,
 * Display's tab requested, then the settings opened on the hit's menu. Returns the jump's version.
 * Takes the hit, not an id: section and page hits have no item location, and the hit's availability
 * and target profile were computed by `searchSettings` for the main slot's profile.
 */
export function openSetting(hit: SettingHit): number {
    version += 1;
    const { menu, tab, sectionId, opener } = hit.target;
    pending = {
        version,
        kind: hit.kind,
        id: hit.id,
        menu,
        tab,
        sectionId,
        opener,
        profileId: hit.profileId,
        available: hit.available,
        reason: hit.reason,
    };
    if (menu === 3 && typeof tab === "string") requestDisplayTab(tab);
    settingsOpen.set(true);
    SettingsMenuIndex.set(menu);
    return version;
}

/** The pending jump while its page is the one shown (exact menu), else null. Not reactive. */
export function currentJump(): SettingJump | null {
    return pending !== null && pending.menu === get(SettingsMenuIndex) ? pending : null;
}

/** Clear the pending jump when it is still `jumpVersion`'s; never changes `jumpVersion()`. */
export function finishJump(jumpVersion: number): void {
    if (pending?.version === jumpVersion) pending = null;
}

/** The first element child with a box: a row's wrapper is `display: contents`. */
function firstBoxedChild(wrapper: Element): HTMLElement | null {
    for (const child of wrapper.children) {
        if (child instanceof HTMLElement && child.getClientRects().length > 0) return child;
    }
    return null;
}

function highlight(element: HTMLElement): void {
    element.scrollIntoView({ block: "center" });
    element.classList.add(...HIGHLIGHT_CLASSES);
    setTimeout(() => element.classList.remove(...HIGHLIGHT_CLASSES), SETTING_HIGHLIGHT_MS);
}

/**
 * After a tick, scroll the item's row (`[data-setting-id]`, its first child with a box) into view and
 * ring it for `SETTING_HIGHLIGHT_MS`. `root` scopes the lookup (the mounted page); `isCurrent` is
 * asked after the tick, before any DOM work, so an outdated jump touches nothing. Returns whether it
 * highlighted a row.
 */
export async function scrollToSetting(
    itemId: string,
    root: ParentNode = document,
    isCurrent: () => boolean = () => true,
): Promise<boolean> {
    await tick();
    if (!isCurrent()) return false;
    const wrapper = root.querySelector(`[data-setting-id="${CSS.escape(itemId)}"]`);
    const row = wrapper ? firstBoxedChild(wrapper) : null;
    if (!row) return false;
    highlight(row);
    return true;
}

/** As `scrollToSetting`, for a section hit: its `[data-settings-section]` wrapper. */
export async function scrollToSection(
    sectionId: string,
    root: ParentNode = document,
    isCurrent: () => boolean = () => true,
): Promise<boolean> {
    await tick();
    if (!isCurrent()) return false;
    const section = root.querySelector(`[data-settings-section="${CSS.escape(sectionId)}"]`);
    if (!(section instanceof HTMLElement) || section.getClientRects().length === 0) return false;
    highlight(section);
    return true;
}
