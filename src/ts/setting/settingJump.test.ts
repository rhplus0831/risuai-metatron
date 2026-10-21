import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The settings deep link's state (`openSetting`, `currentJump`, `finishJump`, `jumpVersion`) and
// its DOM step (`scrollToSetting`, `scrollToSection`) over a hand-built row.

vi.mock("../process/modules", () => ({ moduleUpdate: vi.fn(), getModules: () => [] }));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: (text: string) => text }));
vi.mock("../parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("../globalApi.svelte", () => ({ saveAsset: vi.fn(), downloadFile: vi.fn() }));
vi.mock("../process/index.svelte", () => ({}));

import { get } from "svelte/store";
import { SettingsMenuIndex, settingsOpen } from "../stores.svelte";
import { displaySettingsTabs, takeRequestedDisplayTab } from "./displaySettingsData.svelte";
import type { SettingHit } from "./searchIndex";
import {
    currentJump,
    finishJump,
    jumpVersion,
    openSetting,
    scrollToSection,
    scrollToSetting,
    SETTING_HIGHLIGHT_MS,
} from "./settingJump.svelte";

function hit(overrides: Partial<SettingHit> & { menu: number; tab?: string | number; sectionId?: string }): SettingHit {
    const { menu, tab, sectionId, ...rest } = overrides;
    return {
        kind: "item",
        id: "adv.retries",
        label: "Request Retrys when Fail",
        breadcrumb: [],
        target: { menu, ...(tab !== undefined ? { tab } : {}), ...(sectionId !== undefined ? { sectionId } : {}) },
        available: true,
        score: 1,
        ...rest,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    settingsOpen.set(false);
    SettingsMenuIndex.set(-1);
});

afterEach(() => {
    // The pending jump is module state: clear whatever a test left.
    finishJump(jumpVersion());
    takeRequestedDisplayTab();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("openSetting", () => {
    it("opens the settings on the hit's menu, records the jump, and increments the version", () => {
        const before = jumpVersion();
        const version = openSetting(hit({ menu: 6, sectionId: "adv.requests", profileId: "echo" }));
        expect(version).toBe(before + 1);
        expect(jumpVersion()).toBe(before + 1);
        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(6);
        expect(currentJump()).toEqual({
            version,
            kind: "item",
            id: "adv.retries",
            menu: 6,
            tab: undefined,
            sectionId: "adv.requests",
            opener: undefined,
            profileId: "echo",
            available: true,
            reason: undefined,
        });
    });

    it("answers the jump only while its menu is the one shown", () => {
        openSetting(hit({ menu: 6 }));
        SettingsMenuIndex.set(3);
        expect(currentJump()).toBeNull();
        SettingsMenuIndex.set(6);
        expect(currentJump()).not.toBeNull();
    });

    it("requests Display's tab for a Display hit, also an unavailable one, and for no other page", () => {
        openSetting(hit({ menu: 3, tab: "layout", available: false, reason: "hidden" }));
        expect(takeRequestedDisplayTab()).toBe(displaySettingsTabs.findIndex((tab) => tab.id === "layout"));
        openSetting(hit({ menu: 16, tab: 3 }));
        expect(takeRequestedDisplayTab()).toBe(0);
    });

    it("gives two consecutive jumps to the same page two versions, the later one pending", () => {
        const first = openSetting(hit({ menu: 6, id: "adv.retries" }));
        const second = openSetting(hit({ menu: 6, id: "adv.genTime" }));
        expect(second).toBe(first + 1);
        expect(currentJump()?.id).toBe("adv.genTime");
    });
});

describe("finishJump", () => {
    it("clears only its own version's jump and never changes the version", () => {
        const first = openSetting(hit({ menu: 6, id: "adv.retries" }));
        const second = openSetting(hit({ menu: 6, id: "adv.genTime" }));
        finishJump(first);
        expect(currentJump()?.version).toBe(second);
        finishJump(second);
        expect(currentJump()).toBeNull();
        expect(jumpVersion()).toBe(second);
        // Finishing again, or a stale version, is harmless.
        finishJump(second);
        expect(jumpVersion()).toBe(second);
    });
});

/** A row as `SettingRenderer` renders it: a box-less wrapper around the item's own element. */
function row(id: string, children: HTMLElement[]): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "contents";
    wrapper.dataset.settingId = id;
    wrapper.append(...children);
    document.body.append(wrapper);
    return wrapper;
}

function element(tag: string, boxed: boolean): HTMLElement {
    const node = document.createElement(tag);
    if (!boxed) node.getClientRects = () => [] as unknown as DOMRectList;
    node.scrollIntoView = vi.fn();
    return node;
}

describe("scrollToSetting", () => {
    it("scrolls the row's first child with a box into view and rings it until the timer runs", async () => {
        const boxless = element("span", false);
        const boxed = element("div", true);
        const later = element("div", true);
        row("adv.retries", [boxless, boxed, later]);

        await expect(scrollToSetting("adv.retries")).resolves.toBe(true);
        expect(boxed.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        expect(boxless.scrollIntoView).not.toHaveBeenCalled();
        expect(later.scrollIntoView).not.toHaveBeenCalled();
        expect(boxed.classList.contains("ring-2")).toBe(true);
        expect(boxed.classList.contains("ring-primary-500")).toBe(true);
        expect(boxless.classList.contains("ring-2")).toBe(false);

        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS - 1);
        expect(boxed.classList.contains("ring-2")).toBe(true);
        vi.advanceTimersByTime(1);
        expect(boxed.classList.contains("ring-2")).toBe(false);
        expect(boxed.classList.contains("ring-primary-500")).toBe(false);
    });

    it("does nothing for an unknown row, a row with no boxed child, or a row outside the root", async () => {
        const boxless = element("span", false);
        row("adv.retries", [boxless]);
        const other = element("div", true);
        row("adv.genTime", [other]);
        const root = document.createElement("div");
        document.body.append(root);

        await expect(scrollToSetting("adv.missing")).resolves.toBe(false);
        await expect(scrollToSetting("adv.retries")).resolves.toBe(false);
        await expect(scrollToSetting("adv.genTime", root)).resolves.toBe(false);
        expect(other.scrollIntoView).not.toHaveBeenCalled();
        expect(document.querySelector(".ring-2")).toBeNull();
    });

    it("touches nothing when the jump is no longer current after the tick", async () => {
        const boxed = element("div", true);
        row("adv.retries", [boxed]);
        let current = true;
        const scrolled = scrollToSetting("adv.retries", document, () => current);
        current = false;
        await expect(scrolled).resolves.toBe(false);
        expect(boxed.scrollIntoView).not.toHaveBeenCalled();
        expect(boxed.classList.contains("ring-2")).toBe(false);
    });
});

describe("scrollToSection", () => {
    it("scrolls the section's wrapper into view and rings it; a box-less wrapper is left alone", async () => {
        const section = element("section", true);
        section.dataset.settingsSection = "model.advanced";
        const hidden = element("div", false);
        hidden.dataset.settingsSection = "model.customModels";
        document.body.append(section, hidden);

        await expect(scrollToSection("model.advanced")).resolves.toBe(true);
        expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        expect(section.classList.contains("ring-2")).toBe(true);
        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS);
        expect(section.classList.contains("ring-2")).toBe(false);

        await expect(scrollToSection("model.customModels")).resolves.toBe(false);
        expect(hidden.scrollIntoView).not.toHaveBeenCalled();
        await expect(scrollToSection("model.advanced", document, () => false)).resolves.toBe(false);
        expect(section.scrollIntoView).toHaveBeenCalledTimes(1);
    });
});
