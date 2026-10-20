// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkInventory, readPlaywrightConfig, readVitestConfig } from "./testInventory.mjs";

// Built by concatenation: Vitest reads a module tag anywhere in a file's text, so the literal marker
// here would tag this file `slow`.
const MODULE_TAG_SLOW = "/** @module-" + "tag slow */";

const VITEST_CONFIG = `import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        environment: "happy-dom",
        exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
    },
});
`;
const PLAYWRIGHT_CONFIG = `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "e2e", testMatch: "**/*.spec.ts", workers: 1 });
`;

function table(rows: string[]) {
    return [
        "## Tests",
        "",
        "| Test (file in `server/src/tests/`) | Covers | Run after changing |",
        "| --- | --- | --- |",
        ...rows.map((row) => `| ${row} | x | y |`),
        "",
        "After the table.",
        "",
    ].join("\n");
}

const CLEAN: Record<string, string> = {
    "vitest.config.ts": VITEST_CONFIG,
    "playwright.config.ts": PLAYWRIGHT_CONFIG,
    "vitest.setup.test.ts": `it("root", () => {});\n`,
    "src/ts/feature.ts": `import { helper } from "./util";\nexport const feature = helper;\n`,
    "src/ts/util.ts": `export const helper = 1;\n`,
    "src/ts/feature.test.ts": `import { feature } from "./feature";\nimport { make } from "./tests/fixture";\n`,
    "src/ts/tests/fixture.ts": `export const make = () => 1;\n`,
    "src/lib/View.svelte": `<script lang="ts">\n    import { feature } from "../ts/feature";\n</script>\n<p>{feature}</p>\n`,
    "server/src/tests/whole.test.ts": `// @vitest-environment node\n${MODULE_TAG_SLOW}\nit("a", () => {});\n`,
    "server/src/tests/limits.test.ts": [
        `it("is fast", () => {});`,
        `it("ends a runaway loop at the real effect limit, not a stack overflow", { tags: ["slow"], timeout: 9 }, () => {});`,
        `describe("cold loads", () => {`,
        `    it.skip("loads every tokenizer family cold", { tags: ["slow"] }, () => {});`,
        `});`,
        ``,
    ].join("\n"),
    "shared/codec.ts": `export const codec = 1;\n`,
    "util/tool.test.ts": `it("tool", () => {});\n`,
    "e2e/flow.spec.ts": `test("flow", async () => {});\n`,
    "docs/structure/build-test-platforms.md": table([
        "`whole.test.ts` (the whole file)",
        '`limits.test.ts` "ends a runaway loop at the real effect limit, ..." and "loads every tokenizer family cold"',
    ]),
};

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-test-inventory-"));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
    }
    return root;
}

describe("checkInventory", () => {
    it("passes a clean tree", () => {
        expect(checkInventory(tree(CLEAN))).toEqual([]);
    });

    it("reports a test file no runner collects", () => {
        // Under `e2e/` (Vitest excludes it) but not a `*.spec.ts` (Playwright's match).
        const problems = checkInventory(tree({ ...CLEAN, "e2e/helpers.test.ts": `test("x", () => {});\n` }));
        expect(problems).toEqual([expect.stringMatching(/^e2e\/helpers\.test\.ts: collected by no runner/)]);
    });

    it("reports a test file both runners collect", () => {
        const config = VITEST_CONFIG.replace(`, "e2e/**"`, "");
        const problems = checkInventory(tree({ ...CLEAN, "vitest.config.ts": config }));
        expect(problems).toEqual([expect.stringMatching(/^e2e\/flow\.spec\.ts: collected by both/)]);
    });

    it("reports a slow tag the table does not list", () => {
        const problems = checkInventory(
            tree({
                ...CLEAN,
                "server/src/tests/caps.test.ts": `${MODULE_TAG_SLOW}\nit("caps", () => {});\n`,
                "server/src/tests/limits.test.ts":
                    CLEAN["server/src/tests/limits.test.ts"] +
                    `test("waits the real 3 s checkpoint", { tags: ["fast", "slow"] }, () => {});\n`,
            }),
        );
        expect(problems).toEqual([
            expect.stringMatching(
                /^server\/src\/tests\/caps\.test\.ts: `@module-tag slow` is not in the slow-test table/,
            ),
            expect.stringMatching(
                /^server\/src\/tests\/limits\.test\.ts:6: the `slow` test "waits the real 3 s checkpoint"/,
            ),
        ]);
    });

    it("reports a table row whose test carries no slow tag", () => {
        const problems = checkInventory(
            tree({
                ...CLEAN,
                "docs/structure/build-test-platforms.md": table([
                    "`whole.test.ts` (the whole file)",
                    '`limits.test.ts` "ends a runaway loop at the real effect limit, ..." and "loads every tokenizer family cold"',
                    '`limits.test.ts` "is fast"',
                    "`plain.test.ts` (the whole file)",
                ]),
                "server/src/tests/plain.test.ts": `it("plain", () => {});\n`,
            }),
        );
        expect(problems).toEqual([
            expect.stringMatching(
                /:7: no `slow`-tagged test in server\/src\/tests\/limits\.test\.ts is titled "is fast"$/,
            ),
            expect.stringMatching(/:8: server\/src\/tests\/plain\.test\.ts is listed as a whole file but has no/),
        ]);
    });

    it("reports product code that imports test code", () => {
        const problems = checkInventory(
            tree({
                ...CLEAN,
                "src/ts/feature.ts": `import { make } from "./tests/fixture";\nexport const feature = make;\n`,
                "src/lib/View.svelte": `<script lang="ts">\n    const load = () => import("../ts/feature.test");\n</script>\n`,
                "shared/codec.ts": `export { make } from "../src/ts/tests/fixture.ts";\n`,
            }),
        );
        expect(problems).toEqual([
            'src/lib/View.svelte: product code imports test code "../ts/feature.test"',
            'src/ts/feature.ts: product code imports test code "./tests/fixture"',
            'shared/codec.ts: product code imports test code "../src/ts/tests/fixture.ts"',
        ]);
    });
});

describe("runner collection", () => {
    it("keeps a file a negated exclude names (Vitest's glob drops a negated ignore)", () => {
        const config = VITEST_CONFIG.replace(`".claude/**"`, `".claude/**", "!src/ts/feature.test.ts"`);
        expect(checkInventory(tree({ ...CLEAN, "vitest.config.ts": config }))).toEqual([]);
    });

    it("drops a file a negated include names", () => {
        const config = VITEST_CONFIG.replace("exclude:", `include: ["**/*.test.ts", "!util/**"],\n        exclude:`);
        expect(checkInventory(tree({ ...CLEAN, "vitest.config.ts": config }))).toEqual([
            "util/tool.test.ts: collected by no runner (orphan test file)",
        ]);
    });

    it("reports a test file only the other runner collects", () => {
        // Vitest collects the spec (no `e2e/**` exclude) while Playwright ignores it.
        const vitest = VITEST_CONFIG.replace(`, "e2e/**"`, "");
        const playwright = PLAYWRIGHT_CONFIG.replace("workers: 1", `testIgnore: "**/flow.spec.ts", workers: 1`);
        expect(
            checkInventory(tree({ ...CLEAN, "vitest.config.ts": vitest, "playwright.config.ts": playwright })),
        ).toEqual(["e2e/flow.spec.ts: collected by Vitest, not by its runner Playwright"]);
        // Playwright collects a `util/` test that Vitest excludes.
        const vitestNoUtil = VITEST_CONFIG.replace(`".claude/**"`, `".claude/**", "util/**"`);
        const playwrightUtil = `export default defineConfig({ testDir: ".", testMatch: ["e2e/**/*.spec.ts", "util/**/*.test.ts"] });\n`;
        expect(
            checkInventory(
                tree({ ...CLEAN, "vitest.config.ts": vitestNoUtil, "playwright.config.ts": playwrightUtil }),
            ),
        ).toEqual(["util/tool.test.ts: collected by Playwright, not by its runner Vitest"]);
    });

    it("matches Playwright patterns against the absolute path, case-insensitively", () => {
        // A `testIgnore` naming the checkout's own directory ignores everything in it, as Playwright does.
        const ignoreRoot = PLAYWRIGHT_CONFIG.replace(
            "workers: 1",
            `testIgnore: "**/risu-test-inventory-*/**", workers: 1`,
        );
        expect(checkInventory(tree({ ...CLEAN, "playwright.config.ts": ignoreRoot }))).toEqual([
            "e2e/flow.spec.ts: collected by no runner (orphan test file)",
        ]);
        const upperCase = PLAYWRIGHT_CONFIG.replace(`"**/*.spec.ts"`, `"**/*.SPEC.TS"`);
        expect(checkInventory(tree({ ...CLEAN, "playwright.config.ts": upperCase }))).toEqual([]);
    });

    it("resolves an absolute testDir against the tree, not the working directory", () => {
        // The tree is under the OS temporary directory, so it differs from the process's working directory.
        const root = tree(CLEAN);
        const config = PLAYWRIGHT_CONFIG.replace(
            `testDir: "e2e"`,
            `testDir: ${JSON.stringify(path.join(root, "e2e"))}`,
        );
        writeFileSync(path.join(root, "playwright.config.ts"), config);
        expect(checkInventory(root)).toEqual([]);
    });

    it("walks hidden directories", () => {
        // Collected: Vitest globs with `dot: true`.
        expect(checkInventory(tree({ ...CLEAN, "src/.hidden/h.test.ts": `it("h", () => {});\n` }))).toEqual([]);
        // Excluded: the walker still has to find the file to report it.
        const config = VITEST_CONFIG.replace(`".claude/**"`, `".claude/**", "**/.stale/**"`);
        expect(
            checkInventory(
                tree({ ...CLEAN, "vitest.config.ts": config, "src/.stale/old.test.ts": `it("old", () => {});\n` }),
            ),
        ).toEqual(["src/.stale/old.test.ts: collected by no runner (orphan test file)"]);
    });
});

describe("slow tags", () => {
    const LIMITS = CLEAN["server/src/tests/limits.test.ts"];
    const ROWS = [
        "`whole.test.ts` (the whole file)",
        '`limits.test.ts` "ends a runaway loop at the real effect limit, ..." and "loads every tokenizer family cold"',
    ];

    it("reads a tag on an it.each tagged template's test", () => {
        const limits = LIMITS + 'it.each`\n    a\n    ${1}\n`("row $a", { tags: ["slow"] }, () => {});\n';
        expect(checkInventory(tree({ ...CLEAN, "server/src/tests/limits.test.ts": limits }))).toEqual([
            expect.stringMatching(/^server\/src\/tests\/limits\.test\.ts:6: the `slow` test "row \$a" is not in/),
        ]);
        const docs = table([...ROWS, '`limits.test.ts` "row $a"']);
        expect(
            checkInventory(
                tree({
                    ...CLEAN,
                    "server/src/tests/limits.test.ts": limits,
                    "docs/structure/build-test-platforms.md": docs,
                }),
            ),
        ).toEqual([]);
    });

    it("reports tags it cannot read, which no table row satisfies", () => {
        // No "slow" anywhere in this fixture: the unreadable value is reported all the same.
        const opaque = `import { tagList } from "./tagList";\nit("x", { tags: tagList }, () => {});\n`;
        expect(opaque.includes("slow")).toBe(false);
        const docs = table([...ROWS, '`opaque.test.ts` "x"']);
        expect(
            checkInventory(
                tree({
                    ...CLEAN,
                    "server/src/tests/opaque.test.ts": opaque,
                    "docs/structure/build-test-platforms.md": docs,
                }),
            ),
        ).toEqual([
            expect.stringMatching(/:7: no `slow`-tagged test in server\/src\/tests\/opaque\.test\.ts is titled "x"$/),
            "server/src/tests/opaque.test.ts:2: a test's `tags` is not a literal list of strings; util/testInventory.mjs cannot read it",
        ]);
        // A shorthand property and an accessor hide the value even with "slow" in the file.
        const hidden = [
            `const tags = ["slow"];`,
            `it("y", { tags }, () => {});`,
            `it("z", { get tags() { return ["slow"]; } }, () => {});`,
            ``,
        ].join("\n");
        expect(checkInventory(tree({ ...CLEAN, "server/src/tests/hidden.test.ts": hidden }))).toEqual([
            "server/src/tests/hidden.test.ts:2: a test's `tags` is not a literal list of strings; util/testInventory.mjs cannot read it",
            "server/src/tests/hidden.test.ts:3: a test's `tags` is not a literal list of strings; util/testInventory.mjs cannot read it",
        ]);
    });

    it("reads tags behind type-only wrappers", () => {
        const limits =
            LIMITS +
            `it("typed", { tags: ["slow"] as const }, () => {});\n` +
            `test("single", { tags: "slow" } as const, () => {});\n`;
        const docs = table([...ROWS, '`limits.test.ts` "typed" and "single"']);
        expect(
            checkInventory(
                tree({
                    ...CLEAN,
                    "server/src/tests/limits.test.ts": limits,
                    "docs/structure/build-test-platforms.md": docs,
                }),
            ),
        ).toEqual([]);
    });
});

describe("product imports", () => {
    it("reads a `./tests` index import but not a path normalized out of tests/", () => {
        const feature = `import { make } from "./tests";\nimport { helper } from "./tests/../util";\nexport const feature = make;\n`;
        expect(checkInventory(tree({ ...CLEAN, "src/ts/feature.ts": feature }))).toEqual([
            'src/ts/feature.ts: product code imports test code "./tests"',
        ]);
    });

    it("reads a Svelte script behind a generics attribute and the template, not a comment", () => {
        const view = [
            `<script lang="ts" generics="T extends Record<string, unknown>">`,
            `    import { make } from "../ts/tests/fixture";`,
            `</script>`,
            `<!-- <script>import { stale } from "../ts/tests/stale";</script> -->`,
            `{#await import("../ts/feature.test") then m}{m.feature}{/await}`,
            ``,
        ].join("\n");
        // Sorted: the parser lists the template before the script, and that order is not the contract.
        expect(checkInventory(tree({ ...CLEAN, "src/lib/View.svelte": view })).sort()).toEqual([
            'src/lib/View.svelte: product code imports test code "../ts/feature.test"',
            'src/lib/View.svelte: product code imports test code "../ts/tests/fixture"',
        ]);
    });

    it("reads the TypeScript import forms of a Svelte script", () => {
        const view = [
            `<script lang="ts">`,
            `    type A = import("../ts/tests/first").A;`,
            `    type B = typeof import("../ts/tests/second");`,
            `    const c = import("../ts/tests/third" as string);`,
            `    const d = require("../ts/tests/fourth");`,
            `    import e = require("../ts/tests/fifth");`,
            `</script>`,
            ``,
        ].join("\n");
        expect(checkInventory(tree({ ...CLEAN, "src/lib/View.svelte": view }))).toEqual(
            ["first", "second", "third", "fourth", "fifth"].map(
                (name) => `src/lib/View.svelte: product code imports test code "../ts/tests/${name}"`,
            ),
        );
    });
});

describe("config reading", () => {
    it("reads quoted keys and refuses an object spread or a duplicate key", () => {
        const defaults = { include: ["**/*.test.ts"], exclude: ["**/node_modules/**"] };
        expect(
            readVitestConfig(`export default defineConfig({ "test": { "exclude": ["e2e/**"] } });`, defaults),
        ).toEqual({ include: ["**/*.test.ts"], exclude: ["e2e/**"] });
        expect(() =>
            readVitestConfig(`export default defineConfig({ test: { ...base, exclude: ["e2e/**"] } });`, defaults),
        ).toThrow(/not a plain property/);
        expect(() =>
            readVitestConfig(`export default defineConfig({ test: { exclude: [], exclude: ["e2e/**"] } });`, defaults),
        ).toThrow(/`exclude` is set twice/);
        expect(() =>
            readVitestConfig(
                `export default defineConfig({ test: { exclude: [], "exclude": ["e2e/**"] } });`,
                defaults,
            ),
        ).toThrow(/`exclude` is set twice/);
    });

    it("refuses the collection modes it does not read", () => {
        const defaults = { include: ["**/*.test.ts"], exclude: [] };
        expect(() =>
            readVitestConfig(`export default defineConfig({ test: { typecheck: { enabled: true } } });`, defaults),
        ).toThrow(/`typecheck` is not supported/);
        expect(() =>
            readPlaywrightConfig(`export default defineConfig({ testDir: "e2e", respectGitIgnore: false });`),
        ).toThrow(/`respectGitIgnore` is not supported/);
        expect(() => readPlaywrightConfig(`export default defineConfig({ testMatch: "**/*.spec.ts" });`)).toThrow(
            /no `testDir`/,
        );
        expect(() => readPlaywrightConfig(`export default defineConfig({ testDir: "" });`)).toThrow(/no `testDir`/);
        expect(readPlaywrightConfig(`export default defineConfig({ testDir: "." });`).testDir).toBe(".");
    });

    it("fills in Vitest's defaults and refuses a shape it cannot read", () => {
        const defaults = { include: ["**/*.test.ts"], exclude: ["**/node_modules/**"] };
        expect(readVitestConfig(VITEST_CONFIG, defaults)).toEqual({
            include: ["**/*.test.ts"],
            exclude: ["**/node_modules/**", "e2e/**", ".claude/**"],
        });
        expect(() =>
            readVitestConfig(`export default defineConfig({ test: { include: patterns } });`, defaults),
        ).toThrow(/not a literal pattern list/);
        expect(() => readVitestConfig(`export default defineConfig({ test: { projects: ["a"] } });`, defaults)).toThrow(
            /`projects` is not supported/,
        );
        expect(() => readPlaywrightConfig(`export default defineConfig({ testMatch: /spec/ });`)).toThrow(
            /not a literal pattern list/,
        );
    });
});
