// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatLedger, ledgerIdentifiers, missingIdentifiers, namedTargets, resolveNamed } from "./docsLedger.mjs";

const GUIDE = "docs/structure/example.md";
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-docs-ledger-"));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
}

describe("docs:ledger", () => {
    it("checks Files and Flows including subsections, excluding other sections", () => {
        const base = [
            "# Guide",
            "## Scope",
            "`scopeOnly`",
            "## Files",
            "`fileFact`",
            "### Readers",
            "`readerFact`",
            "## Flows",
            "`flowFact`",
            "### Delivery",
            "`deliveryFact`",
            "## Known Hazards",
            "### Issues",
            "`hazardOnly`",
        ].join("\n");
        expect(ledgerIdentifiers(base, new Set())).toEqual([
            { id: "fileFact", path: false, section: "Files" },
            { id: "readerFact", path: false, section: "Files > Readers" },
            { id: "flowFact", path: false, section: "Flows" },
            { id: "deliveryFact", path: false, section: "Flows > Delivery" },
        ]);
    });

    it("retains facts anywhere in the working guide and reports every lost identifier", () => {
        const base = "## Files\n`keptFact` `lostReader`\n## Flows\n### Delivery\n`lostWriter`";
        const work = "# Guide\n## Known Hazards\nkeptFact is still recorded here.";
        const identifiers = ledgerIdentifiers(base, new Set());
        const missing = missingIdentifiers(identifiers, { texts: [work], patterns: [] });
        expect(missing).toEqual([
            { id: "lostReader", path: false, section: "Files" },
            { id: "lostWriter", path: false, section: "Flows > Delivery" },
        ]);
        const report = formatLedger(GUIDE, "base-ref", missing, { checked: 3, files: 0 });
        expect(report).toContain(": 2 of 3 identifiers");
        expect(
            report
                .split("\n")
                .slice(1)
                .map((line) => line.trim().replace(/\s+/g, " ")),
        ).toEqual(["lostReader (Files)", "lostWriter (Flows > Delivery)"]);
    });

    it("finds facts in named source files and relative Markdown targets, without searching directories", () => {
        const base = "## Files\n`codeFact` `linkedFact` `hiddenFact` `absentFact`";
        const work = "# Guide\n## Files\n`src/owner.ts`, `src/hidden/`\n[Moved](moved.md#linkedfact)";
        const root = tree({
            [GUIDE]: work,
            "src/owner.ts": "export const codeFact = 1;",
            "docs/structure/moved.md": "# Moved\n## linkedFact",
            "src/hidden/worker.ts": "export const hiddenFact = 1;",
            "src/unlisted.ts": "export const absentFact = 1;",
        });
        const rootDirs = new Set(["src", "docs"]);
        const { files, patterns } = resolveNamed(root, namedTargets(work, GUIDE, rootDirs));
        const missing = missingIdentifiers(ledgerIdentifiers(base, rootDirs), {
            texts: [work, ...files.map((file) => readFileSync(path.join(root, file), "utf8"))],
            patterns,
        });
        expect(missing).toEqual([
            { id: "hiddenFact", path: false, section: "Files" },
            { id: "absentFact", path: false, section: "Files" },
        ]);
    });

    it("treats a repository-path span as one path rather than word tokens", () => {
        const identifiers = ledgerIdentifiers("## Files\n`src/old-reader.ts`", new Set(["src"]));
        expect(identifiers).toEqual([{ id: "src/old-reader.ts", path: true, section: "Files" }]);
        expect(missingIdentifiers(identifiers, { texts: ["src old reader ts"], patterns: [] })).toEqual([
            { id: "src/old-reader.ts", path: true, section: "Files" },
        ]);
        expect(missingIdentifiers(identifiers, { texts: ["`src/old-reader.ts`"], patterns: [] })).toEqual([]);
    });
});
