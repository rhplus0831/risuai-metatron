// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractCounts, fileContracts, formatFile, sourceFiles } from "./docsContracts.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-docs-contracts-"));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
}

describe("docs:contracts", () => {
    it("skips typedef and callback blocks without prose and finds a later module header", () => {
        for (const tag of ["@typedef {object} Record", "@callback Reader"]) {
            const typeOnly = `/** ${tag} */`;
            for (const file of ["reader.ts", "reader.js", "reader.mjs"]) {
                expect(fileContracts(file, `${typeOnly}\n\nexport const value = 1;`).scripts[0]).toMatchObject({
                    header: null,
                    headerLine: null,
                });
                expect(
                    fileContracts(file, `${typeOnly}\n\n/** Reads records. */\n\nexport const value = 1;`).scripts[0],
                ).toMatchObject({ header: "Reads records.", headerLine: 3 });
            }
        }
    });

    it("uses a leading line-comment block as an MJS header only when no doc header qualifies", () => {
        const text = [
            "// Reads records.",
            "// Keeps their revisions.",
            "",
            "/** @typedef {object} Record */",
            "",
            "export const value = 1;",
        ].join("\n");
        expect(fileContracts("reader.mjs", text).scripts[0]).toMatchObject({
            header: "Reads records.\nKeeps their revisions.",
            headerLine: 1,
        });
        expect(fileContracts("reader.mjs", `#!/usr/bin/env node\n${text}`).scripts[0]).toMatchObject({
            header: "Reads records.\nKeeps their revisions.",
            headerLine: 2,
        });
        for (const file of ["reader.ts", "reader.js"]) {
            expect(fileContracts(file, text).scripts[0]).toMatchObject({ header: null, headerLine: null });
        }
        const withDocHeader = text.replace("/** @typedef {object} Record */", "/** Documents this module. */");
        expect(fileContracts("reader.mjs", withDocHeader).scripts[0]).toMatchObject({
            header: "Documents this module.",
            headerLine: 4,
        });
    });

    it("prints attached doc comments and the documented export count for TS and JS", () => {
        const text = [
            "/** Reads a record. */",
            "export function read() { return 1; }",
            "/** Stores a record. */",
            "export const write = () => {};",
            "export const missing = 0;",
        ].join("\n");
        const root = tree({ "reader.ts": text, "reader.js": text });
        for (const file of ["reader.ts", "reader.js"]) {
            const contracts = fileContracts(file, readFileSync(path.join(root, file), "utf8"));
            expect(contracts.scripts[0].exports).toEqual([
                { line: 2, kind: "function", name: "read", doc: "Reads a record." },
                { line: 4, kind: "const", name: "write", doc: "Stores a record." },
                { line: 5, kind: "const", name: "missing", doc: null },
            ]);
            expect(contractCounts(contracts)).toEqual({ documented: 2, total: 3 });
            const report = formatFile(file, contracts).join("\n");
            expect(report).toContain("Reads a record.");
            expect(report).toMatch(/without a doc comment:\n\s+5 const missing/);
            expect(report).toContain("documented 2 of 3");
        }
    });

    it("leaves line comments and doc blocks separated by a line comment undocumented", () => {
        const contracts = fileContracts(
            "reader.ts",
            [
                "// A line comment.",
                "export const lineOnly = 1;",
                "/** Detached documentation. */",
                "// Intervening comment.",
                "export const detached = 2;",
            ].join("\n"),
        );
        expect(contracts.scripts[0].exports).toEqual([
            { line: 2, kind: "const", name: "lineOnly", doc: null },
            { line: 5, kind: "const", name: "detached", doc: null },
        ]);
        expect(contractCounts(contracts)).toEqual({ documented: 0, total: 2 });
    });

    it("keeps re-exports out of the undocumented declarations and denominator", () => {
        const contracts = fileContracts(
            "index.ts",
            [
                'import { imported } from "./dependency.js";',
                "export { imported };",
                'export { remote } from "./other.js";',
                'export * from "./other.js";',
                "/** Local contract. */",
                "export const local = 1;",
            ].join("\n"),
        );
        expect(contracts.scripts[0].exports).toEqual([
            { line: 6, kind: "const", name: "local", doc: "Local contract." },
        ]);
        expect(contracts.scripts[0].reexports).toHaveLength(3);
        expect(contractCounts(contracts)).toEqual({ documented: 1, total: 1 });
        const report = formatFile("index.ts", contracts).join("\n");
        expect(report).toContain("re-exports (not counted):");
        expect(report).not.toContain("without a doc comment:");
        expect(report).toContain("documented 1 of 1");
    });

    it("reads documented exports from both Svelte scripts", () => {
        const contracts = fileContracts(
            "Widget.svelte",
            [
                '<script module lang="ts">',
                "/** Shared contract. */",
                "export const shared = 1;",
                "</script>",
                '<script lang="ts">',
                "/** Opens the widget. */",
                "export function open() {}",
                "</script>",
            ].join("\n"),
        );
        expect(contracts.scripts.map(({ label, exports }) => ({ label, exports }))).toEqual([
            { label: "module", exports: [{ line: 3, kind: "const", name: "shared", doc: "Shared contract." }] },
            { label: "instance", exports: [{ line: 7, kind: "function", name: "open", doc: "Opens the widget." }] },
        ]);
        expect(contractCounts(contracts)).toEqual({ documented: 2, total: 2 });
    });

    it("expands directories to source files while excluding tests", () => {
        const root = tree({
            "src/main.ts": "export const main = 1;",
            "src/nested/helper.js": "export const helper = 1;",
            "src/Widget.svelte": "<p>Widget</p>",
            "src/main.test.ts": "export const test = 1;",
            "src/nested/helper.spec.js": "export const spec = 1;",
            "src/tests/fixture.ts": "export const fixture = 1;",
            "src/types.d.ts": "export declare const value: number;",
            "src/node_modules/vendor/index.js": "export const vendor = 1;",
            "src/README.md": "# Sources",
        });
        expect(
            sourceFiles(root)
                .map((file) => path.relative(root, file))
                .sort(),
        ).toEqual(["src/Widget.svelte", "src/main.ts", "src/nested/helper.js"]);
    });
});
