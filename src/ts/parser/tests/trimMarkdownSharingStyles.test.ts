import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParseMarkdown, trimMarkdown, trimMarkdownSharingStyles } from "../parser.svelte";
import {
    BILINGUAL_MUTED_CLASS,
    BILINGUAL_PAIR_CLASS,
    pruneEmptyBilingualPairs,
    pruneEmptyBilingualPairsIn,
} from "../../translator/bilingualInterleave";

//#region module mocks

vi.mock(
    import("../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
        }) as unknown as typeof import("../../storage/database.svelte"),
);

vi.mock(import("../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

// `stores.svelte` runs module effects over the selection and the chat; nothing under test reads it.
vi.mock(import("../../stores.svelte"), async () => (await import("src/ts/tests/storesMock")).createStoresMock({}));

//#endregion

// `trimMarkdownSharingStyles`: `trimMarkdown`'s tree with the shareable styles' CSS
// handed out and an inert comment left in their place; `trimMarkdown` itself is unchanged.

// Decoding a style runs the real parser, whose CBS budget (`CLIENT_CBS_LIMITS`) allows 2 s of
// `performance.now()` per parse; a starved test worker could reach it and get the decoder's fallback.
// A stopped clock leaves only the work limit, which these small sheets never reach.
beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => {
    vi.restoreAllMocks();
});

const SCOPED = ".chattext .x-risu-mybox{color:red;}";
const notrim = (text: string) => ParseMarkdown(text, null, "notrim");

describe("trimMarkdownSharingStyles", () => {
    it("hands out a decoded style's CSS and leaves an inert placeholder; trimMarkdown keeps the copy", async () => {
        const md = await notrim('<style>.mybox { color: red; }</style><div class="mybox">hello</div>');
        const shared = trimMarkdownSharingStyles(md);
        expect(shared.styles).toEqual([{ css: SCOPED, attributes: [] }]);
        expect(shared.html).toContain("<style>/**/</style>");
        expect(shared.html).toContain('<div class="x-risu-mybox">hello</div>');
        expect(shared.html).not.toContain(SCOPED);
        expect(trimMarkdown(md)).toContain(`<style>${SCOPED}</style>`);
    });

    it("takes a style an earlier trim restored (the rendered-translation path)", async () => {
        const restored = await ParseMarkdown(
            '<style>.mybox { color: red; }</style><div class="mybox">hello</div>',
            null,
            "back",
        );
        expect(restored).toContain(`<style>${SCOPED}</style>`);
        const shared = trimMarkdownSharingStyles(restored);
        expect(shared.styles).toEqual([{ css: SCOPED, attributes: [] }]);
        expect(shared.html).toContain("<style>/**/</style>");
    });

    it("shares an attributed style with its sanitized attributes, the placeholder keeping them", async () => {
        const md = await notrim('<style media="all">.probe { color: blue }</style><span class="probe">x</span>');
        const shared = trimMarkdownSharingStyles(md);
        expect(shared.styles).toEqual([{ css: ".probe { color: blue }", attributes: [["media", "all"]] }]);
        expect(shared.html).toContain('<style media="all">/**/</style>');
    });

    it("returns the styles in document order", async () => {
        const md = await notrim("<style>.a { color: red }</style>\n\n<p>x</p>\n\n<style>.b { color: blue }</style>");
        expect(trimMarkdownSharingStyles(md).styles.map((style) => style.css)).toEqual([
            ".chattext .x-risu-a{color:red;}",
            ".chattext .x-risu-b{color:blue;}",
        ]);
    });

    it.each([
        ["@layer", "@layer c2a { .probe { color: red } }"],
        ["layer()", "@import url(x.css) layer(a);"],
        ["@scope", "@scope { .probe { color: red } }"],
    ])("keeps a sheet with %s inline, untouched", async (_name, css) => {
        // A raw `<STYLE>` is not encoded (the encoder's regex is exact), so it survives sanitizing as is.
        const md = await notrim(`<STYLE>${css}</STYLE><span class="probe">x</span>`);
        const shared = trimMarkdownSharingStyles(md);
        expect(shared.styles).toEqual([]);
        expect(shared.html).toContain(`<style>${css}</style>`);
    });

    it("keeps an empty style untouched", () => {
        const shared = trimMarkdownSharingStyles("<style></style><p>x</p>");
        expect(shared.styles).toEqual([]);
        expect(shared.html).toBe("<style></style><p>x</p>");
    });

    it("restores <risu-style> only on the case-sensitive guard trimMarkdown uses", () => {
        const hex = Buffer.from(".probe{color:red}").toString("hex");
        const upper = `<RISU-STYLE>${hex}</RISU-STYLE>`;
        expect(trimMarkdownSharingStyles(upper)).toEqual({ html: trimMarkdown(upper), styles: [] });
        expect(trimMarkdown(upper)).toContain("<risu-style>");

        const lower = `<risu-style>${hex}</risu-style>`;
        expect(trimMarkdownSharingStyles(lower).styles).toEqual([
            { css: ".chattext .x-risu-probe{color:red;}", attributes: [] },
        ]);
    });

    it("runs prepare on the tree before taking the styles out, so a side holding only a style is kept", () => {
        const side = `<div class="${BILINGUAL_MUTED_CLASS}"><style>.chattext .x{color:blue}</style></div>`;
        const html = `<style>.chattext p{color:red}</style><div class="${BILINGUAL_PAIR_CLASS}"><p>Hello</p>${side}</div>`;
        const legacy = pruneEmptyBilingualPairs(trimMarkdown(html));
        expect(legacy).toContain(side);

        const shared = trimMarkdownSharingStyles(html, pruneEmptyBilingualPairsIn);
        expect(shared.styles.map((style) => style.css)).toEqual([".chattext p{color:red}", ".chattext .x{color:blue}"]);
        expect(shared.html).toBe(legacy.replaceAll(/<style>[^<]*<\/style>/g, "<style>/**/</style>"));
    });

    it("renders a body without styles as trimMarkdown does", () => {
        const html = "<p>Hello <b>there</b></p>";
        expect(trimMarkdownSharingStyles(html)).toEqual({ html: trimMarkdown(html), styles: [] });
        expect(trimMarkdownSharingStyles("")).toEqual({ html: "", styles: [] });
    });
});
