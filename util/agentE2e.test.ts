// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    mentions,
    pageImportUses,
    reachesBrowser,
    selectSpecs,
    specSummary,
    staticImports,
    touchedNames,
} from "./agentE2e.mjs";

function spec(file: string, text: string, imports: string[] = ["util/playwright/stack.mjs"]) {
    return { file, text, imports: new Set(imports) };
}

const tracked = [
    "src/ts/storage/chatStore.svelte.ts",
    "src/lib/Others/TerminalNotice.svelte",
    "src/lib/ChatScreens/Chat.svelte",
    "src/ts/index.ts",
    "server/src/index.ts",
    "server/src/tests/fixtures/baseline/markdown.json",
    "shared/presets.ts",
];

describe("mentions", () => {
    it("finds a path or a file name only as a whole", () => {
        expect(
            mentions('await import("/src/ts/storage/chatStore.svelte.ts")', "src/ts/storage/chatStore.svelte.ts"),
        ).toBe(true);
        expect(mentions("`TerminalNotice.svelte`.", "TerminalNotice.svelte")).toBe(true);
        expect(mentions("see server/src/index.ts", "src/index.ts")).toBe(false);
        expect(mentions("OldTerminalNotice.svelte", "TerminalNotice.svelte")).toBe(false);
        expect(mentions("TerminalNotice.svelte.ts", "TerminalNotice.svelte")).toBe(false);
        expect(
            mentions('path.join(root, "server/src/tests/fixtures/baseline")', "server/src/tests/fixtures/baseline"),
        ).toBe(true);
        expect(mentions("server/src/tests/fixtures/baseline/README.md", "server/src/tests/fixtures/baseline")).toBe(
            false,
        );
    });
});

describe("selectSpecs", () => {
    const specs = [
        spec("e2e/a.spec.ts", 'await import("/src/ts/storage/chatStore.svelte.ts");'),
        spec("e2e/b.spec.ts", "// The notice (`TerminalNotice.svelte`) stays up.", [
            "util/playwright/stack.mjs",
            "shared/presets.ts",
        ]),
        spec("e2e/c.spec.ts", 'const dir = path.join(repoRoot, "server/src/tests/fixtures/baseline");'),
    ];

    it("selects the specs that name or import a changed file, and says which file", () => {
        const result = selectSpecs({
            specs,
            changed: [
                "src/lib/Others/TerminalNotice.svelte",
                "shared/presets.ts",
                "src/ts/storage/chatStore.svelte.ts",
            ],
            tracked,
        });
        expect(result.selected).toEqual([
            { file: "e2e/a.spec.ts", because: ["src/ts/storage/chatStore.svelte.ts"] },
            { file: "e2e/b.spec.ts", because: ["src/lib/Others/TerminalNotice.svelte", "shared/presets.ts"] },
        ]);
        expect(result.unnamed).toEqual([]);
    });

    it("selects a spec reading a fixture directory, and a changed spec itself", () => {
        const result = selectSpecs({
            specs,
            changed: ["server/src/tests/fixtures/baseline/markdown.json", "e2e/a.spec.ts"],
            tracked,
        });
        expect(result.selected.map(({ file }) => file)).toEqual(["e2e/a.spec.ts", "e2e/c.spec.ts"]);
    });

    it("reports a changed file no spec names, and leaves guides and unit tests out", () => {
        const result = selectSpecs({
            specs,
            changed: ["src/lib/ChatScreens/Chat.svelte", "docs/structure/persistence.md", "src/ts/storage/x.test.ts"],
            tracked,
        });
        expect(result).toEqual({
            selected: [],
            unnamed: ["src/lib/ChatScreens/Chat.svelte"],
            ignored: ["docs/structure/persistence.md", "src/ts/storage/x.test.ts"],
            narrowed: [],
        });
    });

    it("does not match a file name another tracked file shares", () => {
        const result = selectSpecs({
            specs: [spec("e2e/d.spec.ts", "// boots through index.ts")],
            changed: ["src/ts/index.ts"],
            tracked,
        });
        expect(result.unnamed).toEqual(["src/ts/index.ts"]);
    });

    it("selects every spec for a change to the harness every spec runs on", () => {
        const result = selectSpecs({ specs, changed: ["playwright.config.ts"], tracked });
        expect(result.selected).toHaveLength(specs.length);
    });

    it("selects an importing spec when its extensionless TypeScript helper changes", () => {
        const files: Record<string, string> = {
            "e2e/a.spec.ts": 'import { x } from "./multiClient";',
            "e2e/b.spec.ts": "",
            "e2e/multiClient.ts": "export const x = 1;",
        };
        const read = (file: string) => files[file] ?? null;
        const result = selectSpecs({
            specs: ["e2e/a.spec.ts", "e2e/b.spec.ts"].map((file) => ({
                file,
                text: files[file],
                imports: staticImports(file, read),
            })),
            changed: ["e2e/multiClient.ts"],
            tracked: Object.keys(files),
        });
        expect(result).toEqual({
            selected: [{ file: "e2e/a.spec.ts", because: ["e2e/multiClient.ts"] }],
            unnamed: [],
            ignored: [],
            narrowed: [],
        });
    });

    describe("a script the spec only imports in the page", () => {
        const store = "src/ts/storage/chatStore.svelte.ts";
        const before = "export const selectedChatId = 1;\nexport const draft = 1;\n";
        const handles = [
            spec("e2e/a.spec.ts", `const { selectedChatId } = await import("/${store}");`),
            spec("e2e/b.spec.ts", `const { draft } = await import("/${store}");`),
        ];
        const select = (after: string | null, specs = handles, file = store) =>
            selectSpecs({ specs, changed: [file], tracked, versions: () => ({ before, after }) });

        it("selects only the specs that use a name the change touches, and reports the rest", () => {
            expect(select("export const selectedChatId = 1;\nexport const draft = 2;\n")).toEqual({
                selected: [{ file: "e2e/b.spec.ts", because: [store] }],
                unnamed: [],
                ignored: [],
                narrowed: [{ file: store, touched: ["draft"], skipped: ["e2e/a.spec.ts"] }],
            });
        });

        it("selects no spec for a change that touches no name any of them uses", () => {
            expect(select(`// A comment.\n${before}export const added = 3;\n`)).toEqual({
                selected: [],
                unnamed: [],
                ignored: [],
                narrowed: [{ file: store, touched: ["added"], skipped: ["e2e/a.spec.ts", "e2e/b.spec.ts"] }],
            });
        });

        it("selects every naming spec when the reach of the change cannot be read", () => {
            const both = ["e2e/a.spec.ts", "e2e/b.spec.ts"];
            const files = (result: ReturnType<typeof select>) => result.selected.map(({ file }) => file);
            expect(files(select(null))).toEqual(both);
            expect(files(select(`${before}init();\n`))).toEqual(both);
            const component = "src/lib/Others/TerminalNotice.svelte";
            const mounted = [spec("e2e/c.spec.ts", `const { draft } = await import("/${component}");`)];
            expect(files(select(`${before}export const added = 3;\n`, mounted, component))).toEqual(["e2e/c.spec.ts"]);
        });

        it("selects a spec that also names the script outside a page import", () => {
            const noted = spec("e2e/a.spec.ts", `// Covers ${store}.\nconst { draft } = await import("/${store}");`);
            const result = select(`${before}export const added = 3;\n`, [noted]);
            expect(result.selected).toEqual([{ file: "e2e/a.spec.ts", because: [store] }]);
            expect(result.narrowed).toEqual([]);
        });
    });
});

describe("pageImportUses", () => {
    const file = "src/ts/stores.svelte.ts";
    const uses = (text: string) => {
        const names = pageImportUses(text, file);
        return names && [...names].sort();
    };

    it("reads the destructured names, a namespace's members, and a member of the awaited import", () => {
        expect(
            uses(`
                test("a", async ({ page }) => {
                    await page.evaluate(async () => {
                        const {
                            settingsOpen,
                            SettingsMenuIndex: index,
                        } = await import("/${file}");
                        const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
                        settingsOpen.set(settings.open);
                        index.set(1);
                    });
                    await page.evaluate(async () => {
                        const stores = await import("/${file}");
                        stores.sideBarStore.set(false);
                        return other.stores;
                    });
                    await page.evaluate(async () => (await import("/${file}")).alertStore.set(null));
                });
            `),
        ).toEqual(["SettingsMenuIndex", "alertStore", "settingsOpen", "sideBarStore"]);
    });

    it("is null when the spec depends on the whole file", () => {
        expect(uses(`// Reads ${file}.\nconst { a } = await import("/${file}");`)).toBeNull();
        expect(uses(`await import("/${file}");`)).toBeNull();
        expect(uses(`const stores = await import("/${file}");\nseed(stores);`)).toBeNull();
        expect(uses(`const { a, ...rest } = await import("/${file}");`)).toBeNull();
        expect(uses(`import("/${file}").then((stores) => stores.a);`)).toBeNull();
        expect(uses('const { a } = await import("/src/ts/other.ts");')).toBeNull();
    });
});

describe("touchedNames", () => {
    const touched = (before: string, after: string) => {
        const names = touchedNames(before, after);
        return names && [...names].sort();
    };
    const base = [
        'import { writable } from "svelte/store";',
        'export { PROMPT_MENU, MODEL_MENU } from "./settingsMenu";',
        "const limit = 3;",
        "function clamp(value: number) {\n    return Math.min(value, limit);\n}",
        "/** The open page. */\nexport const page = writable(clamp(0));",
        "export const sideBar = writable(false);",
    ];
    const edit = (from: string, to: string) => base.join("\n").replace(from, to);

    it("touches a changed declaration and the declarations that refer to it", () => {
        expect(touched(base.join("\n"), edit("writable(false)", "writable(true)"))).toEqual(["sideBar"]);
        expect(touched(base.join("\n"), edit("limit = 3", "limit = 4"))).toEqual(["clamp", "limit", "page"]);
        expect(touched(base.join("\n"), `${base.join("\n")}\nexport const added = page;`)).toEqual(["added"]);
        expect(touched(base.join("\n"), base.slice(0, -1).join("\n"))).toEqual(["sideBar"]);
    });

    it("touches one binding of an import or export list, not the list", () => {
        expect(touched(base.join("\n"), edit("MODEL_MENU }", "MODEL_MENU, HOOKS_MENU }"))).toEqual(["HOOKS_MENU"]);
        expect(touched(base.join("\n"), edit("{ writable }", "{ writable, readable }"))).toEqual(["readable"]);
        expect(touched(base.join("\n"), edit('"svelte/store"', '"./store"'))).toEqual(["page", "sideBar", "writable"]);
    });

    it("touches nothing for a change to comments or types", () => {
        expect(touched(base.join("\n"), edit("The open page.", "The page on screen."))).toEqual([]);
        expect(
            touched(
                `${base.join("\n")}\nexport type Page = number;`,
                `${base.join("\n")}\nexport type Page = string;\nexport interface Menu {}\nimport type { A } from "./a";`,
            ),
        ).toEqual([]);
    });

    it("is null when the change runs for every importer or cannot be parsed", () => {
        expect(touched(base.join("\n"), `${base.join("\n")}\npage.set(1);`)).toBeNull();
        expect(touched(base.join("\n"), `import "./polyfill";\n${base.join("\n")}`)).toBeNull();
        expect(touched(base.join("\n"), `${base.join("\n")}\nexport * from "./more";`)).toBeNull();
        expect(touched(base.join("\n"), edit("limit = 3;", "limit = ;"))).toBeNull();
    });
});

describe("staticImports", () => {
    it("follows relative imports through harness files and stops at app and shared code", () => {
        const files: Record<string, string> = {
            "e2e/a.spec.ts":
                'import { openApp } from "../util/playwright/stack.mjs";\nimport x from "../shared/presets.ts";',
            "util/playwright/stack.mjs": 'import { y } from "./modelProfiles.mjs";',
            "util/playwright/modelProfiles.mjs": 'import { z } from "../../shared/sections.ts";',
            "shared/presets.ts": 'import { w } from "./other.ts";',
        };
        const read = (file: string) => files[file] ?? null;
        expect([...staticImports("e2e/a.spec.ts", read)].sort()).toEqual([
            "shared/presets.ts",
            "shared/sections.ts",
            "util/playwright/modelProfiles.mjs",
            "util/playwright/stack.mjs",
        ]);
    });

    it("resolves the first readable path and follows extensionless harness imports", () => {
        const files: Record<string, string> = {
            "e2e/a.spec.ts": `
                import { x } from "./multiClient";
                import "./exact";
                import "./state";
                import "./folder";
                import "./nested/../missing";
            `,
            "e2e/multiClient.ts": 'import { y } from "../shared/presets";',
            "e2e/multiClient.svelte.ts": "",
            "e2e/multiClient/index.ts": "",
            "e2e/exact": "",
            "e2e/exact.ts": "",
            "e2e/exact.svelte.ts": "",
            "e2e/exact/index.ts": "",
            "e2e/state.svelte.ts": "",
            "e2e/state/index.ts": "",
            "e2e/folder/index.ts": "",
            "shared/presets.ts": "",
        };
        const read = (file: string) => files[file] ?? null;
        expect([...staticImports("e2e/a.spec.ts", read)].sort()).toEqual([
            "e2e/exact",
            "e2e/folder/index.ts",
            "e2e/missing",
            "e2e/multiClient.ts",
            "e2e/state.svelte.ts",
            "shared/presets.ts",
        ]);
    });
});

describe("reachesBrowser", () => {
    it("leaves out guides, notes, and unit tests", () => {
        expect(reachesBrowser("src/ts/a.ts")).toBe(true);
        expect(reachesBrowser("e2e/openChat.spec.ts")).toBe(true);
        expect(reachesBrowser("docs/structure/x.md")).toBe(false);
        expect(reachesBrowser("STRUCTURE.md")).toBe(false);
        expect(reachesBrowser("server/src/tests/a.test.ts")).toBe(false);
        expect(reachesBrowser("server/src/tests/fixtures/a.json")).toBe(true);
    });
});

describe("specSummary", () => {
    it("is the first sentence of the first comment", () => {
        expect(specSummary('import x from "y";\n\n// The closed chat: a screen.\n// More text.\nconst a = 1;')).toBe(
            "The closed chat: a screen.",
        );
        expect(specSummary("// Lazy loading in the browser,\n// against the stack. More.")).toBe(
            "Lazy loading in the browser, against the stack.",
        );
    });
});
