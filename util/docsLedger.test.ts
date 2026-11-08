// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    MAX_SOURCE_BYTES,
    formatLedger,
    formatStale,
    isSourceText,
    ledgerIdentifiers,
    missingIdentifiers,
    namedTargets,
    resolveNamed,
    staleIdentifiers,
} from "./docsLedger.mjs";

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
            { id: "fileFact", path: false, section: "Files", line: 5 },
            { id: "readerFact", path: false, section: "Files > Readers", line: 7 },
            { id: "flowFact", path: false, section: "Flows", line: 9 },
            { id: "deliveryFact", path: false, section: "Flows > Delivery", line: 11 },
        ]);
    });

    it("scans every section with lines when asked; a span holding * or starting a command yields nothing", () => {
        const text =
            "intro `earlyFact`\n# Guide\n## Scope\n`scopeFact` `MAX_*` `pnpm --silent test:agent someFilter`\n## Files\n`fileFact`";
        expect(ledgerIdentifiers(text, new Set(), null)).toEqual([
            { id: "earlyFact", path: false, section: "", line: 1 },
            { id: "scopeFact", path: false, section: "Scope", line: 4 },
            { id: "fileFact", path: false, section: "Files", line: 6 },
        ]);
        expect(ledgerIdentifiers(text, new Set())).toEqual([
            { id: "fileFact", path: false, section: "Files", line: 6 },
        ]);
    });

    it("retains facts anywhere in the working guide and reports every lost identifier", () => {
        const base = "## Files\n`keptFact` `lostReader`\n## Flows\n### Delivery\n`lostWriter`";
        const work = "# Guide\n## Known Hazards\nkeptFact is still recorded here.";
        const identifiers = ledgerIdentifiers(base, new Set());
        const missing = missingIdentifiers(identifiers, { texts: [work], patterns: [] });
        expect(missing).toEqual([
            { id: "lostReader", path: false, section: "Files", line: 2 },
            { id: "lostWriter", path: false, section: "Flows > Delivery", line: 5 },
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
            { id: "hiddenFact", path: false, section: "Files", line: 2 },
            { id: "absentFact", path: false, section: "Files", line: 2 },
        ]);
    });

    it("treats a repository-path span as one path rather than word tokens", () => {
        const identifiers = ledgerIdentifiers("## Files\n`src/old-reader.ts`", new Set(["src"]));
        expect(identifiers).toEqual([{ id: "src/old-reader.ts", path: true, section: "Files", line: 2 }]);
        expect(missingIdentifiers(identifiers, { texts: ["src old reader ts"], patterns: [] })).toEqual([
            { id: "src/old-reader.ts", path: true, section: "Files", line: 2 },
        ]);
        expect(missingIdentifiers(identifiers, { texts: ["`src/old-reader.ts`"], patterns: [] })).toEqual([]);
    });

    it("excludes glob files and path matches in strict mode while retaining exact braces and Markdown links", () => {
        const base = [
            "## Files",
            "`droppedFact` `readerFact` `writerFact` `linkedFact`",
            "`src/lost.ts` `src/reader.ts` `src/writer.ts`",
        ].join("\n");
        const work = "## Files\n`src/*.ts`, `src/{reader,writer}.ts`\n[Moved](moved.md#linkedfact)";
        const root = tree({
            [GUIDE]: work,
            "src/lost.ts": "export const droppedFact = 1;",
            "src/reader.ts": "export const readerFact = 1;",
            "src/writer.ts": "export const writerFact = 1;",
            "docs/structure/moved.md": "# Moved\n## linkedFact",
        });
        const rootDirs = new Set(["src", "docs"]);
        const identifiers = ledgerIdentifiers(base, rootDirs);
        const targets = namedTargets(work, GUIDE, rootDirs);
        const missing = ({ files, patterns }: ReturnType<typeof resolveNamed>) =>
            missingIdentifiers(identifiers, {
                texts: [work, ...files.map((file) => readFileSync(path.join(root, file), "utf8"))],
                patterns,
            });

        expect(missing(resolveNamed(root, targets))).toEqual([]);
        expect(missing(resolveNamed(root, targets, { strict: true }))).toEqual([
            { id: "droppedFact", path: false, section: "Files", line: 2 },
            { id: "src/lost.ts", path: true, section: "Files", line: 2 },
        ]);
    });
});

describe("docs:ledger --stale", () => {
    it("reads source text, dotfiles and extensionless files, not docs, Markdown, binaries or excluded payloads", () => {
        expect(isSourceText("src/a.svelte")).toBe(true);
        expect(isSourceText("Dockerfile")).toBe(true);
        expect(isSourceText(".npmrc")).toBe(true);
        expect(isSourceText(".prettierrc.json")).toBe(true);
        expect(isSourceText("README.md")).toBe(false);
        expect(isSourceText("docs/plan/a.json")).toBe(false);
        expect(isSourceText("node_modules/a/index.js")).toBe(false);
        expect(isSourceText("public/a.png")).toBe(false);
        expect(isSourceText("src/vendor/a.ts", ["src/vendor/"])).toBe(false);
        expect(isSourceText("public/plugin_start.7z", ["public/plugin_start.7z"])).toBe(false);
        expect(isSourceText("src/vendors.ts", ["src/vendor/"])).toBe(true);
    });

    it("reports identifiers no source text or file path holds, and skips paths, prefixes, hashes and Doc Maintenance", () => {
        const guide = [
            "# Guide",
            "## Files",
            "`src/kept.ts`: `keptFact`, `neighborFact`, `goneFact`, `$storeFact`, `VITE_`, `MAX_*`, `_events`,",
            "`0123abcdef`, `src/missing.ts`.",
            "## Tests",
            "`namedByFile`, `docOnlyFact`, `vendorFact`, `bigFact`, `imageFact`, `dotFact`",
        ].join("\n");
        const root = tree({
            [GUIDE]: guide,
            "docs/structure/README.md": "# Doc Maintenance\n`derivable:`",
            "docs/structure/other.md": "# Other\n`docOnlyFact`",
            "STRUCTURE.md": "# STRUCTURE\n`indexFact` `keptFact`",
            "src/kept.ts": "export const keptFact = 1; const storeFact = 2;",
            "src/neighbor.ts": "export const neighborFact = 1;",
            "src/tests/namedByFile.test.ts": "",
            ".ignore": "# search-only\nsrc/vendor/\n",
            "src/vendor/big.js": "vendorFact",
            "src/big.json": `bigFact${" ".repeat(MAX_SOURCE_BYTES)}`,
            "src/image.png": "imageFact",
            ".prettierrc": '{ "dotFact": true }',
        });
        const result = staleIdentifiers(root);
        expect(result.guides.map((entry) => entry.rel)).toEqual([GUIDE, "docs/structure/other.md", "STRUCTURE.md"]);
        expect(result.guides[0].checked).toBe(10);
        expect(result.guides[0].stale).toEqual([
            { id: "goneFact", section: "Files", line: 3 },
            { id: "docOnlyFact", section: "Tests", line: 6 },
            { id: "vendorFact", section: "Tests", line: 6 },
            { id: "bigFact", section: "Tests", line: 6 },
            { id: "imageFact", section: "Tests", line: 6 },
        ]);
        expect(result.guides[1].stale).toEqual([{ id: "docOnlyFact", section: "Other", line: 2 }]);
        expect(result.guides[2].stale).toEqual([{ id: "indexFact", section: "STRUCTURE", line: 2 }]);
        expect(result).toMatchObject({ checked: 13, stale: 7, files: 5 });

        const report = formatStale(result);
        expect(report.split("\n")).toEqual([
            `${GUIDE}:3 stale goneFact (Files)`,
            `${GUIDE}:6 stale docOnlyFact (Tests)`,
            `${GUIDE}:6 stale vendorFact (Tests)`,
            `${GUIDE}:6 stale bigFact (Tests)`,
            `${GUIDE}:6 stale imageFact (Tests)`,
            "docs/structure/other.md:2 stale docOnlyFact (Other)",
            "STRUCTURE.md:2 stale indexFact (STRUCTURE)",
            "[docs:ledger] 7 stale identifier(s) in 3 of 3 guides, 13 checked against 5 source files",
            "",
        ]);
        expect(staleIdentifiers(root, [GUIDE]).guides.map((entry) => entry.rel)).toEqual([GUIDE]);
    });
});
