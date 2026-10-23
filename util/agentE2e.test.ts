// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mentions, reachesBrowser, selectSpecs, specSummary, staticImports } from "./agentE2e.mjs";

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
