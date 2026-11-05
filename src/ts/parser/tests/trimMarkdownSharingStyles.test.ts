import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import css from "@adobe/css-tools";
import { ParseMarkdown, trimMarkdown, trimMarkdownSharingStyles } from "../parser.svelte";
import { ChatStyleRegistry } from "../chatStyles";
import { setChatVar } from "../chatVar.svelte";
import { selectChat } from "../../storage/chatStore.svelte";
import { resetRecords } from "../../storage/records.svelte";
import { selectCharacter } from "../../storage/selection.svelte";
import { settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "../../storage/tests/installFlatDatabase";
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

vi.mock(import("../../globalApi.svelte"), async () =>
    (await import("../../tests/globalApiMock")).createGlobalApiMock({ getFileSrc: () => Promise.resolve("") }),
);

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
const parseHtml = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
};

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

describe("CSS preparation cache", () => {
    beforeEach(() => {
        installFlatDatabaseWithChats({
            returnCSSError: false,
            characters: [
                {
                    chaId: "style-cache-character",
                    type: "character",
                    defaultVariables: "",
                    chats: [{ id: "style-cache-chat", scriptstate: { $color: "red" } }],
                },
            ],
        });
        selectCharacter("style-cache-character");
        selectChat("style-cache-character", "style-cache-chat");
    });

    afterEach(() => {
        selectCharacter(null);
        resetRecords();
    });

    it("prepares thirty identical row styles once and shares one registry sheet across both trim APIs", async () => {
        const md = await notrim("<style>.cache-repeated{color:red}</style>");
        const expected = ".chattext .x-risu-cache-repeated{color:red;}";
        const parse = vi.spyOn(css, "parse");
        const registry = new ChatStyleRegistry();
        try {
            for (let row = 0; row < 30; row++) {
                const result = trimMarkdownSharingStyles(md);
                expect(result.styles).toEqual([{ css: expected, attributes: [] }]);
                expect(parseHtml(result.html).querySelector("style")?.textContent).toBe("/**/");
                registry.acquire(result.styles[0], row, 0);
            }
            expect(parse).toHaveBeenCalledTimes(1);
            expect(Array.from(registry.container.children, (sheet) => sheet.textContent)).toEqual([expected]);
            expect(parseHtml(trimMarkdown(md)).querySelector("style")?.textContent).toBe(expected);
            expect(parse).toHaveBeenCalledTimes(1);
        } finally {
            registry.destroy();
        }
    });

    it("evaluates CBS for every row and keys preparations by its exact CSS output", async () => {
        const md = await notrim("<style>.cache-variable{color:{{getvar::color}}}</style>");
        const parse = vi.spyOn(css, "parse");
        const registry = new ChatStyleRegistry();
        try {
            const red = trimMarkdownSharingStyles(md);
            registry.acquire(red.styles[0], 0, 0);
            expect(setChatVar("color", "blue")).toBe(true);
            const blue = trimMarkdownSharingStyles(md);
            registry.acquire(blue.styles[0], 1, 0);

            expect(parse).toHaveBeenCalledTimes(2);
            expect(red.styles).toEqual([{ css: ".chattext .x-risu-cache-variable{color:red;}", attributes: [] }]);
            expect(blue.styles).toEqual([{ css: ".chattext .x-risu-cache-variable{color:blue;}", attributes: [] }]);
            expect(Array.from(registry.container.children, (sheet) => sheet.textContent).sort()).toEqual([
                ".chattext .x-risu-cache-variable{color:blue;}",
                ".chattext .x-risu-cache-variable{color:red;}",
            ]);

            // Different raw CSS with the same evaluated text reuses the blue preparation.
            const literal = await notrim("<style>.cache-variable{color:blue}</style>");
            expect(parseHtml(trimMarkdown(literal)).querySelector("style")?.textContent).toBe(
                ".chattext .x-risu-cache-variable{color:blue;}",
            );
            expect(parse).toHaveBeenCalledTimes(2);
        } finally {
            registry.destroy();
        }
    });

    it("retains 256 preparations and evicts the least recently used after a cache hit", async () => {
        const rows = await Promise.all(
            Array.from({ length: 257 }, (_, index) => notrim(`<style>.cache-entry-${index}{color:red}</style>`)),
        );
        const parse = vi.spyOn(css, "parse");
        const restore = (index: number) => {
            expect(trimMarkdownSharingStyles(rows[index]).styles).toEqual([
                { css: `.chattext .x-risu-cache-entry-${index}{color:red;}`, attributes: [] },
            ]);
        };

        for (let index = 0; index < 256; index++) restore(index);
        expect(parse).toHaveBeenCalledTimes(256);
        restore(0);
        expect(parse).toHaveBeenCalledTimes(256);
        restore(256);
        expect(parse).toHaveBeenCalledTimes(257);
        restore(0);
        expect(parse).toHaveBeenCalledTimes(257);
        restore(1);
        expect(parse).toHaveBeenCalledTimes(258);
    });

    it("evicts the least recently used preparation above 4 MiB of UTF-16 keys and values", () => {
        // Each entry is 1.5 MiB including both strings at two bytes per code unit.
        // Two fit; three exceed 4 MiB even though their keys alone, values alone, or UTF-16
        // code-unit counts without the byte multiplier would fit.
        const entries = ["a", "b", "c"].map((name) => {
            const rule = `.cache-bytes-${name}{content:""}`;
            const scopedRule = `.chattext .x-risu-cache-bytes-${name}{content:"";}`;
            const baseBytes = (rule.length + scopedRule.length) * 2;
            // Each value code unit appears in both key and value, costing four bytes.
            const value = "x".repeat(Math.floor((1.5 * 1024 * 1024 - baseBytes) / 4));
            const text = `.cache-bytes-${name}{content:"${value}"}`;
            return {
                md: `<risu-style>${Buffer.from(text).toString("hex")}</risu-style>`,
                expected: `.chattext .x-risu-cache-bytes-${name}{content:"${value}";}`,
            };
        });
        const parse = vi.spyOn(css, "parse");
        const restore = (index: number) => {
            const result = trimMarkdownSharingStyles(entries[index].md);
            expect(result.styles).toHaveLength(1);
            // Keep a failure from printing megabytes of CSS.
            expect(result.styles[0].css === entries[index].expected).toBe(true);
        };

        restore(0);
        restore(1);
        expect(parse).toHaveBeenCalledTimes(2);
        restore(0);
        expect(parse).toHaveBeenCalledTimes(2);
        restore(2);
        expect(parse).toHaveBeenCalledTimes(3);
        restore(0);
        expect(parse).toHaveBeenCalledTimes(3);
        restore(1);
        expect(parse).toHaveBeenCalledTimes(4);
    });

    it("returns a sheet larger than 4 MiB correctly without retaining its preparation", () => {
        const rule = '.cache-oversized{content:""}';
        const scopedRule = '.chattext .x-risu-cache-oversized{content:"";}';
        const baseBytes = (rule.length + scopedRule.length) * 2;
        const value = "x".repeat(Math.floor((4 * 1024 * 1024 - baseBytes) / 4) + 1);
        const text = `.cache-oversized{content:"${value}"}`;
        const md = `<risu-style>${Buffer.from(text).toString("hex")}</risu-style>`;
        const expected = `.chattext .x-risu-cache-oversized{content:"${value}";}`;
        const parse = vi.spyOn(css, "parse");

        const shared = trimMarkdownSharingStyles(md);
        expect(parseHtml(shared.html).querySelector("style")?.textContent).toBe("/**/");
        expect(shared.styles).toHaveLength(1);
        expect(shared.styles[0].css === expected).toBe(true);
        expect(parse).toHaveBeenCalledTimes(1);
        const restored = parseHtml(trimMarkdown(md));
        expect(restored.querySelectorAll("style")).toHaveLength(1);
        expect(restored.querySelector("style")?.textContent === expected).toBe(true);
        expect(parse).toHaveBeenCalledTimes(2);
    });

    it("retries broken CSS and reads the current error setting on each render", async () => {
        const md = await notrim("<style>.cache-broken{color:red;</style>");
        const parse = vi.spyOn(css, "parse");

        settings.ui.returnCSSError = true;
        const error = parseHtml(trimMarkdown(md));
        expect(error.textContent.trim()).toMatch(/^CSS ERROR: .+/);
        expect(error.querySelector("style, risu-style")).toBeNull();
        expect(parse).toHaveBeenCalledTimes(1);

        settings.ui.returnCSSError = false;
        const hidden = trimMarkdownSharingStyles(md);
        expect(hidden.styles).toEqual([]);
        const empty = parseHtml(hidden.html);
        expect(empty.textContent.trim()).toBe("");
        expect(empty.querySelector("style, risu-style")).toBeNull();
        expect(parse).toHaveBeenCalledTimes(2);
    });
});
