// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guideNames, outline, resolveGuide, sectionText } from "./docsRead.mjs";

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

    it("resolves a guide by name, by area folder, by path, and as STRUCTURE", () => {
        const root = tree({
            "STRUCTURE.md": "# STRUCTURE\n",
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
        expect(resolveGuide(root, "missing")).toBeNull();
        expect(guideNames(root)).toEqual(["area", "area/read", "chat-store"]);
    });
});
