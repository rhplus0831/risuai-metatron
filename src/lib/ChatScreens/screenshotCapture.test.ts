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

afterEach(() => {
    document.body.replaceChildren();
});

it("prepares fonts once for 30 rows and passes the prepared CSS and query option to every capture", async () => {
    const container = document.createElement("div");
    const rows = Array.from({ length: 30 }, () => document.createElement("div"));
    container.append(...rows);
    document.body.append(container);
    const preparedCSS = '@font-face { font-family: Screenshot; src: url("data:font/woff2;base64,AA=="); }';
    const lib = htmlToImage(preparedCSS);

    const capture = await prepareScreenshotCapture(lib, rows);
    for (const row of rows) await capture(row);

    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    expect(lib.toCanvas).toHaveBeenCalledTimes(30);
    for (const row of rows) {
        expect(lib.toCanvas).toHaveBeenCalledWith(row, { includeQueryParams: true, fontEmbedCSS: preparedCSS });
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
    for (const row of rows) await capture(row);

    expect(lib.getFontEmbedCSS).toHaveBeenCalledTimes(1);
    expect(lib.toCanvas).toHaveBeenCalledTimes(2);
    for (const row of rows) {
        expect(lib.toCanvas).toHaveBeenCalledWith(row, { includeQueryParams: true, fontEmbedCSS: "" });
    }
});
