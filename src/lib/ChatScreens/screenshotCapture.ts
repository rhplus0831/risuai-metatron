import type * as HtmlToImage from "html-to-image";
import type { Options } from "html-to-image/lib/types";

// html-to-image's cache otherwise keys by the query-free URL, so a thumbnail would stand in for the original.
export const SCREENSHOT_CAPTURE_OPTIONS = { includeQueryParams: true } satisfies Options;

/**
 * Prepares fonts once per export on the rows' common ancestor so every row's fonts are included.
 * Every capture reuses the CSS, even when empty; otherwise html-to-image re-expands surviving
 * @import rules into the live stylesheet and refetches fonts for each row.
 */
export async function prepareScreenshotCapture(
    lib: Pick<typeof HtmlToImage, "getFontEmbedCSS" | "toCanvas">,
    rows: readonly HTMLElement[],
) {
    let fontRoot = rows[0];
    if (!fontRoot) return (row: HTMLElement) => lib.toCanvas(row, SCREENSHOT_CAPTURE_OPTIONS);

    while (!rows.every((row) => fontRoot.contains(row))) {
        const parent = fontRoot.parentElement;
        if (!parent) throw new Error("Screenshot rows do not share a common ancestor");
        fontRoot = parent;
    }

    const fontEmbedCSS = await lib.getFontEmbedCSS(fontRoot, SCREENSHOT_CAPTURE_OPTIONS);
    return (row: HTMLElement) => lib.toCanvas(row, { ...SCREENSHOT_CAPTURE_OPTIONS, fontEmbedCSS });
}
