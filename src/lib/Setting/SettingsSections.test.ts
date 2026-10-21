// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `SettingsSections` renders an ordinary section as a named region (`section` labelled by its `h3`), a
// collapsible one as a closed accordion with its badge, and nothing for a section whose items all hide by
// their conditions.

vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/parser/transformClient", () => ({ resetTransformEffects: vi.fn() }));
vi.mock("src/ts/process/index.svelte", () => ({}));

import { language } from "src/lang";
import type { SettingHit } from "src/ts/setting/searchIndex";
import {
    currentJump,
    finishJump,
    jumpVersion,
    openSetting,
    scrollToSetting,
    SETTING_HIGHLIGHT_MS,
} from "src/ts/setting/settingJump.svelte";
import type { SettingItem, SettingSection } from "src/ts/setting/types";
import type { Database } from "src/ts/storage/database.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
import SettingsSections from "./SettingsSections.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(sections: SettingSection[]) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(SettingsSections, { target, props: { sections } }));
    flushSync();
    return target;
}

const check = (id: string, bindKey: "showUnrecommended" | "useExperimental", extra: Partial<SettingItem> = {}) =>
    ({ id, type: "check", fallbackLabel: id, bindKey, ...extra }) as SettingItem;

beforeEach(() => {
    installFlatDatabase({ characters: [], botPresets: [{ id: "a", name: "A" }] } as unknown as Database);
    settings.ui.useExperimental = false;
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("SettingsSections", () => {
    it("renders an ordinary section as a region labelled by its h3, with its description and items", () => {
        const target = render([
            {
                id: "test.ordinary",
                labelKey: "settingsSectionFeatureAccess",
                descriptionKey: "settingsSectionFeatureAccessDesc",
                items: [check("test.unrec", "showUnrecommended")],
            },
        ]);
        const section = target.querySelector<HTMLElement>('section[data-settings-section="test.ordinary"]')!;
        expect(section).not.toBeNull();
        const heading = section.querySelector("h3")!;
        expect(heading.textContent).toBe(language.settingsSectionFeatureAccess);
        expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
        expect(heading.id).not.toBe("");
        expect(section.textContent).toContain(language.settingsSectionFeatureAccessDesc);
        expect(section.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    });

    it("renders a collapsible section closed, with its badge, and shows its items once opened", () => {
        const target = render([
            {
                id: "test.legacy",
                labelKey: "settingsSectionLegacy",
                descriptionKey: "settingsSectionLegacyDesc",
                badgeKey: "unrecommended",
                collapsible: true,
                items: [check("test.unrec", "showUnrecommended")],
            },
        ]);
        const wrapper = target.querySelector<HTMLElement>('[data-settings-section="test.legacy"]')!;
        expect(wrapper).not.toBeNull();
        expect(wrapper.querySelector("section")).toBeNull();
        const button = wrapper.querySelector("button")!;
        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(button.textContent).toContain(language.settingsSectionLegacy);
        expect(button.textContent).toContain(language.unrecommended);
        expect(wrapper.querySelector("input[type=checkbox]")).toBeNull();
        expect(wrapper.textContent).not.toContain(language.settingsSectionLegacyDesc);

        button.click();
        flushSync();
        expect(button.getAttribute("aria-expanded")).toBe("true");
        expect(wrapper.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
        expect(wrapper.textContent).toContain(language.settingsSectionLegacyDesc);
    });

    it("renders nothing for a section whose items all hide, and the section once one shows", () => {
        const hidden = { condition: (ctx: { settings: typeof settings }) => ctx.settings.ui.useExperimental };
        const target = render([
            {
                id: "test.experimental",
                labelKey: "settingsSectionExperimental",
                collapsible: true,
                items: [check("test.exp1", "useExperimental", hidden), check("test.exp2", "useExperimental", hidden)],
            },
            {
                id: "test.hiddenOrdinary",
                labelKey: "settingsSectionRequestsTools",
                items: [check("test.exp3", "useExperimental", hidden)],
            },
        ]);
        expect(target.querySelector("[data-settings-section]")).toBeNull();
        expect(target.textContent).not.toContain(language.settingsSectionExperimental);
        expect(target.querySelector("h3")).toBeNull();

        settings.ui.useExperimental = true;
        flushSync();
        expect(target.querySelector('[data-settings-section="test.experimental"]')).not.toBeNull();
        expect(target.querySelector('section[data-settings-section="test.hiddenOrdinary"]')).not.toBeNull();
    });
});

// A collapsible section the pending jump names (`currentJump()`, read at mount) starts open; the
// jump's finish neither closes it nor drops the row's ring; a later re-creation of the accordion
// (Display switches tabs on one instance) stays closed once the jump finished.
describe("SettingsSections with a search jump", () => {
    const MENU = 6;
    const legacy = (): SettingSection => ({
        id: "test.legacy",
        labelKey: "settingsSectionLegacy",
        collapsible: true,
        items: [check("test.unrec", "showUnrecommended")],
    });
    const experimental = (): SettingSection => ({
        id: "test.experimental",
        labelKey: "settingsSectionExperimental",
        collapsible: true,
        items: [check("test.exp", "useExperimental")],
    });
    const jumpTo = (overrides: Partial<SettingHit>) =>
        openSetting({
            kind: "item",
            id: "test.unrec",
            label: "test.unrec",
            breadcrumb: [],
            target: { menu: MENU, sectionId: "test.legacy" },
            available: true,
            score: 1,
            ...overrides,
        });
    const expanded = (target: HTMLElement, id: string) =>
        target.querySelector(`[data-settings-section="${id}"] button`)?.getAttribute("aria-expanded");

    beforeEach(() => {
        vi.useFakeTimers();
        SettingsMenuIndex.set(MENU);
    });

    afterEach(() => {
        finishJump(jumpVersion());
        settingsOpen.set(false);
        SettingsMenuIndex.set(-1);
        vi.useRealTimers();
    });

    it("mounts the named section open and the other closed; both the opening and the ring survive finishJump", async () => {
        const version = jumpTo({});
        const target = render([legacy(), experimental()]);
        expect(expanded(target, "test.legacy")).toBe("true");
        expect(expanded(target, "test.experimental")).toBe("false");

        await expect(scrollToSetting("test.unrec", target)).resolves.toBe(true);
        const ringed = target.querySelector<HTMLElement>('[data-setting-id="test.unrec"] > .ring-2');
        expect(ringed).not.toBeNull();

        finishJump(version);
        flushSync();
        expect(currentJump()).toBeNull();
        expect(expanded(target, "test.legacy")).toBe("true");
        expect(ringed!.isConnected).toBe(true);
        expect(ringed!.classList.contains("ring-primary-500")).toBe(true);
        vi.advanceTimersByTime(SETTING_HIGHLIGHT_MS);
        expect(ringed!.classList.contains("ring-2")).toBe(false);
    });

    it("keeps the named section closed for an unavailable jump, and for a jump to another page", () => {
        jumpTo({ available: false, reason: "hidden" });
        expect(expanded(render([legacy()]), "test.legacy")).toBe("false");

        jumpTo({ target: { menu: MENU + 1, sectionId: "test.legacy" } });
        SettingsMenuIndex.set(MENU);
        expect(expanded(render([legacy()]), "test.legacy")).toBe("false");
    });
});
