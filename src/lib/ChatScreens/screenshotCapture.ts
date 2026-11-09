import type * as HtmlToImage from "html-to-image";
import type { Options } from "html-to-image/lib/types";

// html-to-image's cache otherwise keys by the query-free URL, so a thumbnail would stand in for the original.
export const SCREENSHOT_CAPTURE_OPTIONS = { includeQueryParams: true } satisfies Options;

/**
 * Prepares fonts once per export on the rows' common ancestor so every row's fonts are included.
 * Removes rules inserted during font preparation from previously readable sheets, even on failure,
 * restoring their original rules and cascade before capturing rows.
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

    // html-to-image re-expands @import rules into live sheets on every call, including non-font rules.
    const originalRules = new Map<CSSStyleSheet, Set<CSSRule>>();
    for (const sheet of Array.from(fontRoot.ownerDocument.styleSheets)) {
        try {
            originalRules.set(sheet, new Set(Array.from(sheet.cssRules)));
        } catch {
            // Cross-origin sheets can be unreadable; their imported copies go into readable sheets.
        }
    }

    let fontEmbedCSS: string;
    try {
        fontEmbedCSS = await lib.getFontEmbedCSS(fontRoot, SCREENSHOT_CAPTURE_OPTIONS);
    } finally {
        for (const [sheet, rules] of originalRules) {
            for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
                if (!rules.has(sheet.cssRules[index])) sheet.deleteRule(index);
            }
        }
    }
    return (row: HTMLElement) => lib.toCanvas(row, { ...SCREENSHOT_CAPTURE_OPTIONS, fontEmbedCSS });
}
