// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guideNames, outline, resolveGuide, sectionReport, sectionText, sectionTexts } from "./docsRead.mjs";

const TEXT = [
    "# Guide",
    "",
    "## Scope",
    "",
    "Routes the task.",
    "",
    "## Files",
    "",
    "### Readers",
    "",
    "`read()`: a reader.",
    "",
    "### Writers",
    "",
    "`write()`: a writer.",
    "",
    "## Known Hazards",
    "",
    "### Issues",
    "",
    "One issue.",
    "",
].join("\n");

/** Two headings one prefix names, so arguments joined into that prefix are one ambiguous query. */
const PATHS = "# Guide\n## Read path\nOne.\n## Read paths\nTwo.\n";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-docs-read-"));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
}

describe("docs:read", () => {
    it("lists every heading with its own bytes and, for a heading with subsections, the total", () => {
        expect(outline(TEXT)).toEqual([
            "# Guide  (9 bytes, 157 with subsections)",
            "## Scope  (28 bytes)",
            "## Files  (10 bytes, 79 with subsections)",
            "### Readers  (34 bytes)",
            "### Writers  (35 bytes)",
            "## Known Hazards  (18 bytes, 41 with subsections)",
            "### Issues  (23 bytes)",
        ]);
    });

    it("prints a section through its subsections, up to the next heading of its level", () => {
        const { section, text } = sectionText(TEXT, "files");
        expect(section).toMatchObject({ level: 2, heading: "Files", line: 7 });
        expect(text).toBe("## Files\n\n### Readers\n\n`read()`: a reader.\n\n### Writers\n\n`write()`: a writer.");
        expect(sectionText(TEXT, "Issues").text).toBe("### Issues\n\nOne issue.");
    });

    it("matches a heading by whole text before prefix before substring, and refuses an ambiguous query", () => {
        expect(sectionText(TEXT, "known").section.heading).toBe("Known Hazards");
        expect(sectionText(TEXT, "riter").section.heading).toBe("Writers");
        expect(sectionText(TEXT, "s").section.heading).toBe("Scope");
        expect(() => sectionText(TEXT, "er")).toThrow(/matches 2 headings:\n {2}### Readers\n {2}### Writers$/);
        expect(() => sectionText(TEXT, "absent")).toThrow(/matches no heading:\n {2}# Guide/);
    });

    it("ignores backticks in heading queries while preserving the section text", () => {
        const text = "# Guide\n## Relevant `package.json` scripts\n\nUse pnpm.\n## Next\nOther text.";
        for (const query of ["Relevant `package.json` scripts", "`package.json` scripts"]) {
            const result = sectionText(text, query);
            expect(result.section).toMatchObject({ heading: "Relevant `package.json` scripts", line: 2 });
            expect(result.text).toBe("## Relevant `package.json` scripts\n\nUse pnpm.");
        }
    });

    it("reads the heading arguments as one query first, then as one query each", () => {
        const names = (queries: string[]) => {
            const { found, missed } = sectionTexts(TEXT, queries);
            return { found: found.map((entry) => entry.section.heading), missed: missed.map((entry) => entry.query) };
        };
        expect(names(["Known", "Hazards"])).toEqual({ found: ["Known Hazards"], missed: [] });
        expect(names(["Known Hazards", "Scope"])).toEqual({ found: ["Known Hazards", "Scope"], missed: [] });
        expect(names(["Scope", "Readerz", "er"])).toEqual({ found: ["Scope"], missed: ["Readerz", "er"] });
        // One argument, or arguments that together match several headings, stay one query.
        expect(names(["absent"])).toEqual({ found: [], missed: ["absent"] });
        expect(sectionTexts(PATHS, ["Read", "pa"]).missed).toMatchObject([{ query: "Read pa", matches: [{}, {}] }]);
    });

    it("prints several sections in document order, leaving out one inside another", () => {
        const scope = "g.md:3\n## Scope\n\nRoutes the task.\n";
        const files = `g.md:7\n${sectionText(TEXT, "Files").text}\n`;
        expect(sectionReport("g.md", TEXT, ["Scope"])).toEqual({ out: scope, err: "" });
        expect(sectionReport("g.md", TEXT, ["Writers", "Files", "Scope", "Files"])).toEqual({
            out: `${scope}\n${files}`,
            err: "",
        });
        expect(sectionReport("g.md", TEXT, ["Issues", "Readers"]).out).toBe(
            "g.md:9\n### Readers\n\n`read()`: a reader.\n\ng.md:19\n### Issues\n\nOne issue.\n",
        );
    });

    it("prints the sections found and warns about each heading argument that names no single heading", () => {
        const headings =
            "  # Guide\n  ## Scope\n  ## Files\n  ### Readers\n  ### Writers\n  ## Known Hazards\n  ### Issues\n";
        expect(sectionReport("g.md", TEXT, ["Scope", "Readerz", "er"])).toEqual({
            out: "g.md:3\n## Scope\n\nRoutes the task.\n",
            err:
                "warning: 2 of 3 headings name no single section (a typo?); the other 1 follow.\n" +
                'Each argument was read as a heading of its own, since "Scope Readerz er" matches no heading.\n' +
                '  "Readerz" matches no heading\n' +
                '  "er" matches 2 headings:\n    ### Readers\n    ### Writers\n' +
                `headings of g.md:\n${headings}`,
        });
        // Only ambiguous arguments: the candidates are enough, without the whole heading list.
        expect(sectionReport("g.md", TEXT, ["er", "ers"])).toEqual({
            out: "",
            err:
                "warning: 2 of 2 headings name no single section (a typo?); nothing is printed.\n" +
                'Each argument was read as a heading of its own, since "er ers" matches no heading.\n' +
                '  "er" matches 2 headings:\n    ### Readers\n    ### Writers\n' +
                '  "ers" matches 2 headings:\n    ### Readers\n    ### Writers\n',
        });
        // A single query keeps the message `sectionText` throws.
        expect(sectionReport("g.md", TEXT, ["absent"])).toEqual({
            out: "",
            err: `"absent" matches no heading:\n${headings}`,
        });
        expect(sectionReport("g.md", PATHS, ["Read", "pa"]).err).toBe(
            '"Read pa" matches 2 headings:\n  ## Read path\n  ## Read paths\n',
        );
    });

    it("resolves guide names, area folders, paths, STRUCTURE, and README aliases", () => {
        const root = tree({
            "STRUCTURE.md": "# STRUCTURE\n",
            "README.md": "# Repository\n",
            "docs/structure/README.md": "# Doc Maintenance\n",
            "docs/structure/chat-store.md": TEXT,
            "docs/structure/area/README.md": "# Area\n",
            "docs/structure/area/read.md": TEXT,
        });
        expect(resolveGuide(root, "chat-store")).toBe("docs/structure/chat-store.md");
        expect(resolveGuide(root, "chat-store.md")).toBe("docs/structure/chat-store.md");
        expect(resolveGuide(root, "docs/structure/chat-store.md")).toBe("docs/structure/chat-store.md");
        expect(resolveGuide(root, "area")).toBe("docs/structure/area/README.md");
        expect(resolveGuide(root, "area/read")).toBe("docs/structure/area/read.md");
        expect(resolveGuide(root, "STRUCTURE")).toBe("STRUCTURE.md");
        for (const alias of ["README", "README.md", "./README", "./README.md", "docs/structure/README.md"]) {
            expect(resolveGuide(root, alias)).toBe("docs/structure/README.md");
        }
        expect(resolveGuide(root, "missing")).toBeNull();
        expect(guideNames(root)).toEqual(["README", "area", "area/read", "chat-store"]);
    });
});
