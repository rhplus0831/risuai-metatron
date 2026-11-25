// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    checkDocs,
    expandBraces,
    formatCheck,
    formatReport,
    GUIDE_BYTES_BUDGET,
    GUIDE_BYTES_TARGET,
    GUIDE_SECTIONS,
    INDEX_SECTION,
    INDEX_SECTION_BYTES_BUDGET,
    INDEX_SECTION_BYTES_TARGET,
    ITEM_CHARS_BUDGET,
    LEAF_BYTES_BUDGET,
    LEAF_BYTES_TARGET,
    measureDocs,
    nearTarget,
    PAREN_DEPTH_BUDGET,
} from "./docsBudget.mjs";

const GUIDE = "docs/structure/example.md";
const SECTIONS = ["Scope", "Files", "Flows", "State", "Coupling", "Invariants", "Recipes", "Tests", "Known Hazards"];

function guide(bodies: Record<string, string> = {}) {
    return (
        "# Guide\n\n" +
        SECTIONS.map((section) => `## ${section}\n\n${bodies[section] ? `${bodies[section]}\n\n` : ""}`).join("")
    );
}

function fillBytes(bytes: number) {
    return "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2);
}

function headingAtSize(heading: string, bytes: number) {
    const prefix = `${heading}\n\n`;
    return prefix + fillBytes(bytes - Buffer.byteLength(prefix) - 2) + "\n\n";
}

function guideAtSize(bytes: number, perSection = 4_000) {
    const text = guide(Object.fromEntries(SECTIONS.map((section) => [section, "x".repeat(perSection)])));
    // Spread the file across headings so only the file budget can fail.
    return text.replace("# Guide\n\n", `# Guide\n\n${fillBytes(bytes - Buffer.byteLength(text) - 2)}\n\n`);
}

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string> = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-docs-budget-"));
    roots.push(root);
    for (const [rel, text] of Object.entries({ "STRUCTURE.md": "# STRUCTURE\n", [GUIDE]: guide(), ...files })) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
    return root;
}

const finding = (file: string, line: number, rule: string) => expect.objectContaining({ path: file, line, rule });

describe("documentation budgets", () => {
    it("reports an ownership finding for a tracked source path the manifest does not cover", () => {
        const root = tree({
            "src/uncovered.ts": "",
            "docs/structure/ownership.json": JSON.stringify({
                rules: [{ match: "STRUCTURE.md", guide: "example" }],
            }),
        });
        execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
        execFileSync("git", ["add", "--", "."], { cwd: root, stdio: "pipe" });

        expect(checkDocs(measureDocs(root))).toEqual([
            expect.objectContaining({
                path: "docs/structure/ownership.json",
                rule: "ownership",
                message: expect.stringContaining("src/uncovered.ts"),
            }),
        ]);
    });

    it("passes a clean tree with the required outline and OK output", () => {
        expect(GUIDE_SECTIONS).toEqual(SECTIONS);
        const measure = measureDocs(
            tree({
                [GUIDE]: guide({
                    Scope: "[Files](#files) and [Index](../../STRUCTURE.md#structure).",
                    "Known Hazards": "### Issues\n\n### Limitations\n\n### Gotchas",
                }),
            }),
        );
        const findings = checkDocs(measure);
        expect(findings).toEqual([]);
        expect(formatCheck(findings)).toBe("[check:docs] OK\n");
    });

    it("rejects a guide one byte above the uniform file budget", () => {
        expect(GUIDE_BYTES_BUDGET).toBe(40_000);
        const nested = "docs/structure/nested/guide.md";
        for (const bytes of [40_000, 40_001]) {
            const measure = measureDocs(tree({ [nested]: guideAtSize(bytes) }));
            expect(measure.guides.find((file) => file.path === nested)).toMatchObject({
                bytes,
                overBudget: bytes > 40_000,
            });
            expect(checkDocs(measure)).toEqual(bytes === 40_000 ? [] : [finding(nested, 1, "ceiling")]);
        }
    });

    it("rejects a leaf heading one byte above its budget", () => {
        expect(LEAF_BYTES_BUDGET).toBe(8_000);
        for (const bytes of [8_000, 8_001]) {
            const text = guide({ Scope: headingAtSize("### Detail", bytes).slice(0, -2) });
            const measure = measureDocs(tree({ [GUIDE]: text }));
            expect(measure.guides[0].largestLeaf).toMatchObject({ bytes, line: 5 });
            expect(checkDocs(measure)).toEqual(bytes === 8_000 ? [] : [finding(GUIDE, 5, "leaf")]);
        }
    });

    it("warns, without failing, on a guide or a leaf heading over its target", () => {
        expect(GUIDE_BYTES_TARGET).toBe(36_000);
        expect(LEAF_BYTES_TARGET).toBe(7_000);
        for (const bytes of [36_000, 36_001, 40_000]) {
            const measure = measureDocs(tree({ [GUIDE]: guideAtSize(bytes, 3_800) }));
            expect(checkDocs(measure)).toEqual([]);
            expect(nearTarget(measure)).toEqual(bytes === 36_000 ? [] : [finding(GUIDE, 1, "near")]);
        }
        // Over the budget, the `ceiling` finding stands alone.
        expect(nearTarget(measureDocs(tree({ [GUIDE]: guideAtSize(40_001) })))).toEqual([]);
        // `## Scope` plus its blank lines is 12 bytes of the leaf.
        for (const bytes of [7_000, 7_001, 8_000, 8_001]) {
            const measure = measureDocs(tree({ [GUIDE]: guide({ Scope: "x".repeat(bytes - 12) }) }));
            expect(checkDocs(measure)).toEqual(bytes === 8_001 ? [finding(GUIDE, 3, "leaf")] : []);
            expect(nearTarget(measure)).toEqual(bytes === 7_000 || bytes === 8_001 ? [] : [finding(GUIDE, 3, "near")]);
        }
        const warnings = nearTarget(measureDocs(tree({ [GUIDE]: guideAtSize(36_001, 3_800) })));
        expect(formatCheck([], warnings)).toBe(
            "docs/structure/example.md:1 near 36001 bytes, target 36000, 3999 under the budget\n" +
                "[check:docs] OK, 1 near the budget\n",
        );
        expect(formatCheck([{ path: GUIDE, line: 1, rule: "ceiling", message: "x" }], warnings)).toMatch(
            /\n\[check:docs\] FAIL: 1 finding\(s\), 1 near the budget\n$/,
        );
    });

    it("measures wrapped items, unwrapped items and table rows with code spans included", () => {
        expect(ITEM_CHARS_BUDGET).toBe(600);
        for (const length of [600, 601]) {
            const item = `${"a".repeat(300)} \`${"b".repeat(length - 303)}\``;
            const body = [
                `- ${item}`,
                "",
                `- ${item.replace(" ", "\n  ")}`,
                "",
                "| Value |",
                "| --- |",
                `| \`${"c".repeat(length - 6)}\` |`,
            ].join("\n");
            const measure = measureDocs(tree({ [GUIDE]: guide({ Scope: body }) }));
            expect(checkDocs(measure)).toEqual(
                length === 600 ? [] : [5, 7, 12].map((line) => finding(GUIDE, line, "item")),
            );
        }
    });

    it("rejects a blockquoted list item over the item budget", () => {
        const text = guide({ Scope: `> - ${"x".repeat(601)}` });
        expect(checkDocs(measureDocs(tree({ [GUIDE]: text })))).toEqual([finding(GUIDE, 5, "item")]);
    });

    it("counts spaces inside table code spans but collapses column padding", () => {
        const spaces = " ".repeat(601);
        const body = ["| Value |", "| --- |", `| \`${spaces}\` |`, `|${spaces}value${spaces}|`].join("\n");
        const measure = measureDocs(tree({ [GUIDE]: guide({ Scope: body }) }));

        expect(checkDocs(measure)).toEqual([finding(GUIDE, 7, "item")]);
    });

    it("rejects three nested parentheses while ignoring parentheses inside a code span", () => {
        expect(PAREN_DEPTH_BUDGET).toBe(2);
        for (const depth of [2, 3]) {
            const body = `${"(".repeat(depth)}text \`((((code))))\`${")".repeat(depth)}`;
            const measure = measureDocs(tree({ [GUIDE]: guide({ Scope: body }) }));
            expect(measure.guides[0].maxParenDepth).toBe(depth);
            expect(checkDocs(measure)).toEqual(depth === 2 ? [] : [finding(GUIDE, 5, "paren-depth")]);
        }
    });

    it("rejects guide sections in the wrong order", () => {
        const text = guide().replace("## Scope\n\n## Files", "## Files\n\n## Scope");
        expect(checkDocs(measureDocs(tree({ [GUIDE]: text })))).toEqual([finding(GUIDE, 3, "sections")]);
    });

    it("rejects unknown or out-of-order Known Hazards subheadings", () => {
        for (const [body, line] of [
            ["### Risks", 21],
            ["### Gotchas\n\n### Issues", 23],
        ] as const) {
            expect(checkDocs(measureDocs(tree({ [GUIDE]: guide({ "Known Hazards": body }) })))).toEqual([
                finding(GUIDE, line, "hazards"),
            ]);
        }
    });

    it("rejects an unresolved relative Markdown link", () => {
        const text = guide({ Scope: "[Missing](missing.md)" });
        expect(checkDocs(measureDocs(tree({ [GUIDE]: text })))).toEqual([finding(GUIDE, 5, "unresolved-link")]);
    });

    it("rejects an unresolved anchor", () => {
        const text = guide({ Scope: "[Present](#scope) and [Missing](#missing)" });
        expect(checkDocs(measureDocs(tree({ [GUIDE]: text })))).toEqual([finding(GUIDE, 5, "unresolved-link")]);
    });

    it("rejects a code span naming a missing repository path, with braces expanded and globs matched", () => {
        expect(expandBraces("src/{a,b/{c,d}}.ts")).toEqual(["src/a.ts", "src/b/c.ts", "src/b/d.ts"]);
        const present = "`src/{a,b}.ts`, `src/c*.ts`, `src/`, `src/a.ts` `other/x.ts` `/api/x` `a.b` `src/...`";
        const missing = "`src/{a,missing}.ts`, `src/d*.ts`, `src/a.ts/`";
        const root = tree({
            [GUIDE]: guide({ Files: present, Flows: missing }),
            "src/a.ts": "",
            "src/b.ts": "",
            "src/c1.ts": "",
        });
        const findings = checkDocs(measureDocs(root));
        expect(findings).toEqual([
            finding(GUIDE, 11, "missing-path"),
            finding(GUIDE, 11, "missing-path"),
            finding(GUIDE, 11, "missing-path"),
        ]);
        expect(findings.map((entry) => entry.message)).toEqual([
            "src/{a,missing}.ts (no such path: src/missing.ts)",
            "src/d*.ts (no such path: src/d*.ts)",
            "src/a.ts/ (not a directory: src/a.ts)",
        ]);
    });

    it("checks a missing brace alternative after a git-ignored alternative", () => {
        const root = tree({
            [GUIDE]: guide({ Files: "`src/{ignored.local,missing.ts}`" }),
            ".gitignore": "*.local\n",
            "src/present.ts": "",
            "docs/structure/ownership.json": JSON.stringify({
                rules: [{ match: "src/**", guide: "example" }],
            }),
        });
        execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
        execFileSync("git", ["add", "--", "."], { cwd: root, stdio: "pipe" });

        const findings = checkDocs(measureDocs(root));
        expect(findings).toEqual([finding(GUIDE, 7, "missing-path")]);
        expect(findings.map((entry) => entry.message)).toEqual([
            "src/{ignored.local,missing.ts} (no such path: src/missing.ts)",
        ]);
    });

    it("measures the guides and STRUCTURE.md together and prints the total in the verdict without a limit", () => {
        const measure = measureDocs(tree());
        const { treeBytes } = measure.totals;
        expect(treeBytes).toBe(measure.totals.bytes + measure.index.bytes);
        expect(checkDocs(measure)).toEqual([]);
        expect(formatCheck([], [], treeBytes)).toBe(`[check:docs] OK, tree ${treeBytes} bytes\n`);
        expect(formatCheck([], [])).toBe("[check:docs] OK\n");
    });

    it("rejects a link to its own file without an anchor", () => {
        const text = guide({ Scope: "[Self](example.md) and [Section](example.md#scope)" });
        expect(checkDocs(measureDocs(tree({ [GUIDE]: text })))).toEqual([finding(GUIDE, 5, "self-link")]);
    });

    it("rejects work-tracking labels, including a wrapped label", () => {
        for (const label of ["Slice 1", "Phase\nA", "Stop 2", "docs/plan/pending.md"]) {
            expect(checkDocs(measureDocs(tree({ [GUIDE]: guide({ Scope: label }) })))).toEqual([
                finding(GUIDE, 5, "label"),
            ]);
        }
    });

    it("holds STRUCTURE.md to the same file and heading size budgets", () => {
        for (const bytes of [40_000, 40_001]) {
            const measure = measureDocs(tree({ "STRUCTURE.md": guideAtSize(bytes) }));
            expect(measure.index).toMatchObject({ bytes, overBudget: bytes > 40_000 });
            expect(checkDocs(measure)).toEqual(bytes === 40_000 ? [] : [finding("STRUCTURE.md", 1, "ceiling")]);
        }
        for (const bytes of [8_000, 8_001]) {
            const measure = measureDocs(tree({ "STRUCTURE.md": headingAtSize("# STRUCTURE", bytes) }));
            expect(checkDocs(measure)).toEqual(bytes === 8_000 ? [] : [finding("STRUCTURE.md", 1, "leaf")]);
        }
    });

    it("holds the index's invariants section, with its subsections, to its own budget and target", () => {
        expect([INDEX_SECTION_BYTES_TARGET, INDEX_SECTION_BYTES_BUDGET]).toEqual([8_000, 10_000]);
        // The section heading and its blank line are 31 bytes; two leaves keep each under the leaf target.
        const section = (bytes: number) =>
            `## ${INDEX_SECTION}\n\n` + headingAtSize("### One", 5_000) + headingAtSize("### Two", bytes - 5_031);
        const index = (bytes: number) =>
            "# STRUCTURE\n\n## Agent Read Protocol\n\nSteps.\n\n" +
            section(bytes) +
            headingAtSize("## Choose By Task", 6_000);
        for (const bytes of [8_000, 8_001, 10_000, 10_001]) {
            const measure = measureDocs(tree({ "STRUCTURE.md": index(bytes) }));
            expect(measure.index.indexSection).toMatchObject({ heading: INDEX_SECTION, line: 7, bytes });
            expect(checkDocs(measure)).toEqual(bytes === 10_001 ? [finding("STRUCTURE.md", 7, "index-section")] : []);
            expect(nearTarget(measure)).toEqual(
                bytes === 8_000 || bytes === 10_001 ? [] : [finding("STRUCTURE.md", 7, "near")],
            );
        }
        expect(formatCheck([], nearTarget(measureDocs(tree({ "STRUCTURE.md": index(8_001) }))))).toBe(
            `STRUCTURE.md:7 near "${INDEX_SECTION}" 8001 bytes with subsections, target 8000, 1999 under the budget\n` +
                "[check:docs] OK, 1 near the budget\n",
        );
        expect(checkDocs(measureDocs(tree({ "STRUCTURE.md": index(10_001) })))[0].message).toBe(
            `"${INDEX_SECTION}" 10001 bytes with subsections, budget 10000, 1 over`,
        );
        // Only the index has the section: the same heading in an area folder's README is an ordinary heading.
        const readme = "docs/structure/area/README.md";
        const measure = measureDocs(tree({ [readme]: `# Area\n\n${section(10_001)}` }));
        expect(measure.guides.find((file) => file.path === readme)?.indexSection).toBeNull();
        expect(checkDocs(measure)).toEqual([]);
        expect(nearTarget(measure)).toEqual([]);
    });

    it("rejects a verification record that names no guide or holds a short commit", () => {
        const record = "docs/structure/verified.json";
        const commit = "c".repeat(40);
        const text = (guides: Record<string, string>) => `${JSON.stringify({ guides }, null, 2)}\n`;
        expect(checkDocs(measureDocs(tree({ [record]: text({ example: commit }) })))).toEqual([]);
        const findings = checkDocs(measureDocs(tree({ [record]: text({ example: "c0ffee1", gone: commit }) })));
        expect(findings).toEqual([finding(record, 3, "verified"), finding(record, 4, "verified")]);
        expect(findings.map((entry) => entry.message)).toEqual([
            "example: not a full 40-character commit",
            "gone: not a guide",
        ]);
        expect(checkDocs(measureDocs(tree({ [record]: "{" })))).toEqual([finding(record, 1, "verified")]);
    });

    it("holds an area folder's README to the budgets but not to the guide outline", () => {
        const readme = "docs/structure/area/README.md";
        const nested = "docs/structure/area/topic.md";
        const index =
            "# Area\n\n## Scope\n\nText.\n\n## Guides\n\n| Task | Guide |\n| --- | --- |\n| Topic | [topic](topic.md) |\n";
        expect(checkDocs(measureDocs(tree({ [readme]: index, [nested]: guide() })))).toEqual([]);
        expect(checkDocs(measureDocs(tree({ [readme]: index, [nested]: "# Topic\n\n## Guides\n" })))).toEqual([
            finding(nested, 3, "sections"),
        ]);
        expect(checkDocs(measureDocs(tree({ [readme]: headingAtSize("# Area", 8_001) })))).toEqual([
            finding(readme, 1, "leaf"),
        ]);
    });

    it("checks a final level-one heading against the leaf budget", () => {
        for (const bytes of [8_000, 8_001]) {
            const text = guide() + headingAtSize("# Appendix", bytes);
            const measure = measureDocs(tree({ [GUIDE]: text }));
            expect(measure.guides[0].largestLeaf).toMatchObject({ bytes, line: 21 });
            expect(checkDocs(measure)).toEqual(bytes === 8_000 ? [] : [finding(GUIDE, 21, "leaf")]);
        }
    });

    it("prints each finding, and a report of the sizes and findings with the guide totals last", () => {
        const text = guide({ Scope: `- ${"x".repeat(601)}\n\n[Missing](missing.md)` });
        const index = headingAtSize("# STRUCTURE", 1_000);
        const measure = measureDocs(tree({ [GUIDE]: text, "STRUCTURE.md": index }));
        const findings = checkDocs(measure);
        expect(findings).toEqual([finding(GUIDE, 5, "item"), finding(GUIDE, 7, "unresolved-link")]);
        expect(
            formatCheck(findings)
                .trimEnd()
                .split("\n")
                .filter((line) => /^.+:\d+ \S+ .+/.test(line)),
        ).toEqual([
            expect.stringMatching(/^docs\/structure\/example\.md:5 item .+/),
            expect.stringMatching(/^docs\/structure\/example\.md:7 unresolved-link .+/),
        ]);

        const report = formatReport(measure);
        expect(report).toMatch(/^\[check:docs\] Guides\n/);
        expect(report).toMatch(/^\s+guide\s+bytes\s+headroom\s+>40000\s+###\s+largestLeaf\s+items>600/m);
        const bytes = Buffer.byteLength(text);
        expect(report).toMatch(new RegExp(`^  docs/structure/example\\.md\\s+${bytes}\\s+${40_000 - bytes}\\s`, "m"));
        expect(report).toMatch(/^  STRUCTURE\.md\s+1000\s+39000\s/m);
        expect(report).toContain("[check:docs] Sections\n");
        expect(report).toMatch(/^    ## Scope\s+\d+\s+\d+/m);
        expect(report).toMatch(/^  docs\/structure\/example\.md:5 \S+ 601$/m);
        expect(report).toMatch(/^  docs\/structure\/example\.md:7 missing\.md /m);
        const totals = report.slice(report.indexOf("[check:docs] Totals"));
        expect(totals).toMatch(/^\[check:docs\] Totals \(guides only, STRUCTURE\.md excluded\)\n/);
        expect(totals).toContain("[check:docs] guides: 1\n");
        expect(totals).toContain(`[check:docs] total bytes: ${Buffer.byteLength(text)}\n`);
        expect(totals).toContain("[check:docs] guides over 36000 bytes, the target: 0\n");
        expect(totals).toContain("[check:docs] leaves over 7000 bytes, the target: 0\n");
        expect(totals).toContain("[check:docs] list items over 600: 1\n");
        expect(totals).toContain("[check:docs] unresolved links: 1\n");
        expect(totals).toMatch(/\[check:docs\] labels: 0\n$/);
    });

    it("adds a stale-identifier column and total to the report only when given a stale scan", () => {
        const measure = measureDocs(tree({ [GUIDE]: guide({ Scope: "`someFact`" }) }));
        const plain = formatReport(measure);
        expect(plain).not.toMatch(/^\s+guide\s.*\sstale$/m);
        expect(plain).not.toContain("stale identifiers");
        const stale = {
            guides: [{ rel: GUIDE, checked: 3, stale: [{ id: "someFact", section: "Scope", line: 4 }] }],
            checked: 3,
            stale: 1,
            files: 2,
        };
        const report = formatReport(measure, stale);
        expect(report).toMatch(/^\s+guide\s+bytes\s.*\sunresolved\s+stale$/m);
        expect(report).toMatch(/^  docs\/structure\/example\.md\s.*\s1$/m);
        expect(report).toMatch(/^  STRUCTURE\.md\s.*\s0$/m);
        expect(report).toContain(
            "[check:docs] stale identifiers, STRUCTURE.md included (names in code spans in no source file; " +
                "pnpm docs:ledger --stale lists them): 1 of 3\n",
        );
    });
});
