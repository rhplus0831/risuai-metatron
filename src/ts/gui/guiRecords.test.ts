// @vitest-environment happy-dom

import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The GUI appliers (`colorscheme.ts`, `guisize.ts`, `animation.ts`, ...) read the `ui` section record
// through the settings views, not a captured database. Each one applies what the record holds when it runs:
// a later edit and the records replaced by a conflict reload or a restore (installed afresh) are what the
// next call applies, never a captured object. The color-scheme writers write the `ui` record and queue its
// write, and nothing else. The records are all there is (there is no aggregate database): the readers and
// the writers (`updateSettings`) reach them only through the views.

vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../process/index.svelte", () => ({
    sendChat: vi.fn(),
    doingChat: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

import { updateAnimationSpeed } from "./animation";
import {
    changeColorSchemeType,
    ColorSchemeTypeStore,
    updateColorScheme,
    updateCustomColorScheme,
    updateTextThemeAndCSS,
} from "./colorscheme";
import { sideBarSize, textAreaSize, textAreaTextSize, updateGuisize } from "./guisize";
import type { Database } from "../storage/database.svelte";
import { setRecordWriteListener, trackedRecord } from "../storage/records.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { installFlatDatabase } from "../storage/tests/installFlatDatabase";
import { CustomCSSStore } from "../stores.svelte";

const scheme = (type: "dark" | "light", bgcolor: string) => ({
    type,
    bgcolor,
    darkbg: "#000001",
    borderc: "#000002",
    selected: "#000003",
    draculared: "#000004",
    textcolor: "#000005",
    textcolor2: "#000006",
    darkBorderc: "#000007",
    darkbutton: "#000008",
});

const textTheme = (standard: string) => ({
    FontColorStandard: standard,
    FontColorItalic: "#100001",
    FontColorBold: "#100002",
    FontColorItalicBold: "#100003",
    FontColorQuote1: "#100004",
    FontColorQuote2: "#100005",
});

function database(extra: Record<string, unknown> = {}): Database {
    return {
        characters: [],
        botPresets: [{ id: "a", name: "A" }],
        colorScheme: scheme("dark", "#111111"),
        colorSchemeName: "custom",
        customColorScheme: scheme("dark", "#222222"),
        textTheme: "custom",
        customTextTheme: textTheme("#aaaaaa"),
        font: "custom",
        customFont: "Fancy Font",
        customCSS: ".a { color: red; }",
        textAreaSize: 2,
        sideBarSize: 3,
        textAreaTextSize: 1,
        animationSpeed: 0.7,
        ...extra,
    } as unknown as Database;
}

const css = (name: string) => document.documentElement.style.getPropertyValue(name);
const ui = () => trackedRecord<Record<string, any>>("ui")!;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

let written: string[];

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    installFlatDatabase(database());
    written = [];
    setRecordWriteListener((kind) => written.push(kind));
});

afterEach(() => {
    setRecordWriteListener(null);
});

describe("updateColorScheme", () => {
    it("applies the ui record's color scheme, and the record as it is at the next call", () => {
        updateColorScheme();
        expect(css("--risu-theme-bgcolor")).toBe("#111111");
        expect(css("--risu-theme-darkbutton")).toBe("#000008");
        expect(get(ColorSchemeTypeStore)).toBe("dark");

        settings.ui.colorScheme = scheme("light", "#333333");
        updateColorScheme();
        expect(css("--risu-theme-bgcolor")).toBe("#333333");
        expect(get(ColorSchemeTypeStore)).toBe("light");

        // The records replaced by a conflict reload or a restore: the next call reads the new record.
        installFlatDatabase(database({ colorScheme: scheme("dark", "#444444") }));
        updateColorScheme();
        expect(css("--risu-theme-bgcolor")).toBe("#444444");
        expect(written).toEqual(["ui"]);
    });

    it("declares the scheme's type as the root color-scheme, dark for a scheme without one", () => {
        updateColorScheme();
        expect(document.documentElement.style.colorScheme).toBe("dark");

        settings.ui.colorScheme = scheme("light", "#333333");
        updateColorScheme();
        expect(document.documentElement.style.colorScheme).toBe("light");

        // After a light scheme, so a missing type must write dark rather than keep the previous value.
        const { type: _type, ...untyped } = scheme("light", "#666666");
        settings.ui.colorScheme = untyped as ReturnType<typeof scheme>;
        updateColorScheme();
        expect(document.documentElement.style.colorScheme).toBe("dark");
        expect(css("--risu-theme-bgcolor")).toBe("#666666");
    });
});

describe("updateTextThemeAndCSS", () => {
    it("applies the custom text theme, font, and CSS from the ui record, and follows its edits", () => {
        updateTextThemeAndCSS();
        expect(css("--FontColorStandard")).toBe("#aaaaaa");
        expect(css("--FontColorQuote2")).toBe("#100005");
        expect(css("--risu-font-family")).toBe("Fancy Font");
        expect(get(CustomCSSStore)).toBe(".a { color: red; }");

        settings.ui.textTheme = "standard";
        settings.ui.font = "default";
        settings.ui.customCSS = "";
        updateTextThemeAndCSS();
        // `standard` over the dark scheme the record holds.
        expect(css("--FontColorStandard")).toBe("#fafafa");
        expect(css("--risu-font-family")).toBe("Arial, sans-serif");
        expect(get(CustomCSSStore)).toBe("");

        settings.ui.colorScheme = scheme("light", "#555555");
        updateTextThemeAndCSS();
        expect(css("--FontColorStandard")).toBe("#0f172a");

        installFlatDatabase(database({ customTextTheme: textTheme("#bbbbbb"), customCSS: ".b {}" }));
        updateTextThemeAndCSS();
        expect(css("--FontColorStandard")).toBe("#bbbbbb");
        expect(get(CustomCSSStore)).toBe(".b {}");
    });
});

describe("the color-scheme writers", () => {
    it("changeColorSchemeType writes the custom scheme's type and installs it as the scheme, in the ui record only", () => {
        changeColorSchemeType("light");
        expect(plain(ui().customColorScheme)).toEqual(scheme("light", "#222222"));
        expect(plain(ui().colorScheme)).toEqual(scheme("light", "#222222"));
        expect(ui().colorSchemeName).toBe("custom");
        expect(css("--risu-theme-bgcolor")).toBe("#222222");
        expect(get(ColorSchemeTypeStore)).toBe("light");
        expect(new Set(written)).toEqual(new Set(["ui"]));
        // The installed scheme is a copy: a later edit of the custom scheme does not reach it.
        settings.ui.customColorScheme.bgcolor = "#999999";
        expect(ui().colorScheme.bgcolor).toBe("#222222");
    });

    it("updateCustomColorScheme installs the record's custom scheme as it is now", () => {
        installFlatDatabase(database({ customColorScheme: scheme("dark", "#666666") }));
        updateCustomColorScheme();
        expect(ui().colorScheme.bgcolor).toBe("#666666");
        expect(css("--risu-theme-bgcolor")).toBe("#666666");
    });
});

describe("updateGuisize and updateAnimationSpeed", () => {
    it("apply the ui record's sizes and speed, and the record as it is at the next call", () => {
        updateGuisize();
        updateAnimationSpeed();
        expect([get(textAreaSize), get(sideBarSize), get(textAreaTextSize)]).toEqual([2, 3, 1]);
        expect(css("--sidebar-size")).toBe("36rem");
        expect(css("--risu-animation-speed")).toBe("0.7s");

        settings.ui.sideBarSize = 1;
        settings.ui.animationSpeed = 0.2;
        updateGuisize();
        updateAnimationSpeed();
        expect(get(sideBarSize)).toBe(1);
        expect(css("--sidebar-size")).toBe("28rem");
        expect(css("--risu-animation-speed")).toBe("0.2s");

        installFlatDatabase(database({ textAreaSize: -1, sideBarSize: 0, animationSpeed: 1 }));
        updateGuisize();
        updateAnimationSpeed();
        expect(get(textAreaSize)).toBe(-1);
        expect(css("--sidebar-size")).toBe("24rem");
        expect(css("--risu-animation-speed")).toBe("1s");
        // Reading writes nothing.
        expect(written).toEqual(["ui", "ui"]);
    });
});
