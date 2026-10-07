// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lucideIconFiles, rewriteLucideImports } from "./vitest.lucideImports";

/**
 * The test-only rewrite of `@lucide/svelte` imports (`vitest.lucideImports.ts`). A statement it
 * cannot map stays correct but makes every test that reaches it import all the icons again, so
 * this pins that every import in the app still maps after a lucide upgrade.
 */
const files = lucideIconFiles();

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /\.(svelte|[cm]?[jt]s)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("the lucide import rewrite", () => {
    it("maps the icons, their Lucide/Icon aliases, and the deprecated aliases to the icon files", () => {
        expect(files.get("X")).toBe("x");
        expect(files.get("LucideX")).toBe("x");
        expect(files.get("XIcon")).toBe("x");
        expect(files.get("AlarmCheck")).toBe("alarm-check");
        for (const file of new Set(files.values())) {
            expect(() =>
                readFileSync(path.join(import.meta.dirname, "node_modules/@lucide/svelte/dist/icons", `${file}.js`)),
            ).not.toThrow();
        }
    });

    it("rewrites every barrel import in src/ and keeps each file's line count", () => {
        let rewritten = 0;
        for (const file of sourceFiles(path.join(import.meta.dirname, "src"))) {
            const code = readFileSync(file, "utf8");
            if (!code.includes("@lucide/svelte")) {
                continue;
            }
            const out = rewriteLucideImports(code, files);
            expect(out, file).not.toMatch(/from\s*["']@lucide\/svelte["']/);
            expect(out.split("\n").length, file).toBe(code.split("\n").length);
            rewritten++;
        }
        expect(rewritten).toBeGreaterThan(0);
    });

    it("rewrites renames, and leaves a statement with any unknown name as it is", () => {
        expect(
            rewriteLucideImports(`import {\n    X,\n    Check as Ok,\n} from "@lucide/svelte";\nlet a;`, files),
        ).toBe(`import X from "@lucide/svelte/icons/x"; import Ok from "@lucide/svelte/icons/check";\n\n\n\nlet a;`);
        const unknown = `import { X, icons } from "@lucide/svelte";`;
        expect(rewriteLucideImports(unknown, files)).toBe(unknown);
        const typeOnly = `import { type IconProps } from "@lucide/svelte";`;
        expect(rewriteLucideImports(typeOnly, files)).toBe(typeOnly);
    });
});
