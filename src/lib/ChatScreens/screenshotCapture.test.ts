import { afterEach, expect, it, vi } from "vitest";
import { prepareScreenshotCapture } from "./screenshotCapture";

type ScreenshotLibrary = Parameters<typeof prepareScreenshotCapture>[0];

function htmlToImage(fontEmbedCSS: string) {
    return {
        getFontEmbedCSS: vi.fn<ScreenshotLibrary["getFontEmbedCSS"]>().mockResolvedValue(fontEmbedCSS),
        toCanvas: vi
            .fn<ScreenshotLibrary["toCanvas"]>()
            .mockImplementation(async () => document.createElement("canvas")),
    };
}

function addStylesheet(css: string) {
    const style = document.createElement("style");
    style.textContent = css;
    document.body.append(style);
    if (!style.sheet) throw new Error("Expected a live stylesheet");
    return style.sheet;
}

function stylesheetRules() {
    return Array.from(document.styleSheets, (sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText));
}

afterEach(() => {
    document.body.replaceChildren();
});

it("forwards each planned pixel ratio to toCanvas with autoscaling disabled", async () => {
    const container = document.createElement("div");
    const oversized = document.createElement("div");
    const neighbour = document.createElement("div");
    container.append(oversized, neighbour);
    document.body.append(container);
    const lib = htmlToImage("");
    const capture = await prepareScreenshotCapture(lib, [oversized, neighbour]);
    const areaLimitedRatio = Math.sqrt(64_000_000 / (2400 * 8192));

    await capture(oversized, areaLimitedRatio);
    await capture(neighbour, 2);

    expect(lib.toCanvas.mock.calls).toEqual([
        [oversized, expect.objectContaining({ pixelRatio: areaLimitedRatio, skipAutoScale: true })],
        [neighbour, expect.objectContaining({ pixelRatio: 2, skipAutoScale: true })],
    ]);
});

it("prepares fonts once for 30 rows and passes the prepared CSS and query option to every capture", async () => {
    const container = document.createElement("div");
    const rows = Array.from({ length: 30 }, () => document.createElement("div"));
    container.append(...rows);
    document.body.append(container);
    const preparedCSS = '@font-face { font-family: Screenshot; src: url("data:font/woff2;base64,AA=="); }';
    const lib = htmlToImage(preparedCSS);

    const capture = await prepareScreenshotCapture(lib, rows);
    for (const row of rows) await capture(row, 1);

    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    expect(lib.toCanvas).toHaveBeenCalledTimes(30);
    for (const row of rows) {
        expect(lib.toCanvas).toHaveBeenCalledWith(row, {
            includeQueryParams: true,
            fontEmbedCSS: preparedCSS,
            pixelRatio: 1,
            skipAutoScale: true,
        });
    }
});

it("prepares fonts on a node containing every row across different parents", async () => {
    const container = document.createElement("div");
    const firstParent = document.createElement("section");
    const secondParent = document.createElement("section");
    const rows = [document.createElement("div"), document.createElement("div"), document.createElement("div")];
    firstParent.append(rows[0]);
    secondParent.append(rows[1], rows[2]);
    container.append(firstParent, secondParent);
    document.body.append(container);
    const lib = htmlToImage("");

    await prepareScreenshotCapture(lib, rows);

    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    const [fontRoot] = lib.getFontEmbedCSS.mock.calls[0];
    for (const row of rows) expect(fontRoot.contains(row)).toBe(true);
});

it("passes an empty prepared CSS string to every capture so no row scans fonts again", async () => {
    const container = document.createElement("div");
    const rows = [document.createElement("div"), document.createElement("div")];
    container.append(...rows);
    document.body.append(container);
    const lib = htmlToImage("");

    const capture = await prepareScreenshotCapture(lib, rows);
    for (const row of rows) await capture(row, 1);

    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    expect(lib.toCanvas).toHaveBeenCalledTimes(2);
    for (const row of rows) {
        expect(lib.toCanvas).toHaveBeenCalledWith(row, {
            includeQueryParams: true,
            fontEmbedCSS: "",
            pixelRatio: 1,
            skipAutoScale: true,
        });
    }
});

it("keeps the original rules and total rule count across two font preparations", async () => {
    const row = document.createElement("div");
    document.body.append(row);
    const preparedCSS = '@font-face { font-family: Screenshot; src: url("data:font/woff2;base64,AA=="); }';
    // happy-dom does not parse @import reliably; mimic html-to-image inserting the imported rules into live sheets.
    const sheets = [
        addStylesheet(`${preparedCSS} .chattext { color: navy; }`),
        addStylesheet(".caption { color: green; } .chattext { color: blue; }"),
    ];
    const originalRules = stylesheetRules();
    const originalRuleCount = originalRules.flat().length;
    const lib = htmlToImage(preparedCSS);
    lib.getFontEmbedCSS.mockImplementation(async () => {
        for (const sheet of sheets) {
            sheet.insertRule(preparedCSS, sheet.cssRules.length);
            sheet.insertRule(".chattext { color: red; }", sheet.cssRules.length);
        }
        return preparedCSS;
    });

    for (let preparation = 0; preparation < 2; preparation++) {
        const capture = await prepareScreenshotCapture(lib, [row]);

        expect(stylesheetRules().flat()).toHaveLength(originalRuleCount);
        expect(stylesheetRules()).toEqual(originalRules);
        await capture(row, 1);
        expect(lib.toCanvas).toHaveBeenLastCalledWith(row, {
            includeQueryParams: true,
            fontEmbedCSS: preparedCSS,
            pixelRatio: 1,
            skipAutoScale: true,
        });
    }
    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(2);
    expect(lib.toCanvas).toHaveBeenCalledTimes(2);
});

it("restores the original rules and propagates a rejected font preparation", async () => {
    const row = document.createElement("div");
    document.body.append(row);
    const fontCSS = '@font-face { font-family: Screenshot; src: url("data:font/woff2;base64,AA=="); }';
    const sheets = [
        addStylesheet(`${fontCSS} .chattext { color: navy; }`),
        addStylesheet(".caption { color: green; } .chattext { color: blue; }"),
    ];
    const originalRules = stylesheetRules();
    const originalRuleCount = originalRules.flat().length;
    const failure = new Error("Font embedding failed");
    const lib = htmlToImage(fontCSS);
    lib.getFontEmbedCSS.mockImplementation(async () => {
        for (const sheet of sheets) {
            sheet.insertRule(fontCSS, sheet.cssRules.length);
            sheet.insertRule(".chattext { color: red; }", sheet.cssRules.length);
        }
        throw failure;
    });

    await expect(prepareScreenshotCapture(lib, [row])).rejects.toBe(failure);

    expect(stylesheetRules().flat()).toHaveLength(originalRuleCount);
    expect(stylesheetRules()).toEqual(originalRules);
    expect(lib.toCanvas).not.toHaveBeenCalled();
});
