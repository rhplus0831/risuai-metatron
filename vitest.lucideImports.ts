import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Test-only: rewrites `import { Icon, Other as Alias } from "@lucide/svelte"` into one
 * `import Icon from "@lucide/svelte/icons/<file>"` per icon.
 *
 * The package's main entry re-exports every icon (about 1,700 components, plus their `Lucide*`,
 * `*Icon`, and legacy aliases). The build tree-shakes it and the dev server pre-bundles it, but
 * Vitest imports every one of those modules in every test file that reaches an icon, about 15 s of
 * import per file. Pre-bundling it for Vitest (`deps.optimizer`) gives the icons their own copy of
 * the Svelte runtime, which breaks mounting them inside the app's components.
 *
 * The map comes from the package's own re-export lines (`dist/icons/index.js` and
 * `dist/aliases/*.js`). A statement with any name the map does not hold (a type, `icons`,
 * `defaultAttributes`, a name a later version moved) is left as it is: still correct, only slow.
 * The rewrite keeps the statement's line count, so later lines keep their numbers.
 */
const BARREL_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']@lucide\/svelte["'];?/g;
const RE_EXPORT =
    /export\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?default\s+as\s+(\w+)\s*\}\s*from\s*'(?:\.\.\/icons\/|\.\/)([\w-]+)\.(?:svelte|js)'/g;

export function lucideIconFiles(): Map<string, string> {
    const dist = path.dirname(createRequire(import.meta.url).resolve("@lucide/svelte"));
    const files = new Map<string, string>();
    for (const barrel of ["icons/index.js", "aliases/aliases.js", "aliases/prefixed.js", "aliases/suffixed.js"]) {
        for (const [, name, file] of readFileSync(path.join(dist, barrel), "utf8").matchAll(RE_EXPORT)) {
            files.set(name, file);
        }
    }
    return files;
}

export function rewriteLucideImports(code: string, files: Map<string, string>): string {
    return code.replace(BARREL_IMPORT, (statement, list: string) => {
        const imports: string[] = [];
        for (const spec of list.split(",")) {
            const trimmed = spec.trim();
            if (!trimmed) {
                continue;
            }
            const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(trimmed);
            const file = match && files.get(match[1]);
            if (!match || !file) {
                return statement;
            }
            imports.push(`import ${match[2] ?? match[1]} from "@lucide/svelte/icons/${file}";`);
        }
        return imports.join(" ") + "\n".repeat(statement.split("\n").length - 1);
    });
}

export function lucideImports(): Plugin {
    let files: Map<string, string> | null = null;
    return {
        name: "risu:lucide-imports",
        enforce: "pre",
        transform(code, id) {
            if (id.includes("/node_modules/") || !/\.(svelte|[cm]?[jt]s)$/.test(id.split("?")[0])) {
                return null;
            }
            if (!code.includes("@lucide/svelte")) {
                return null;
            }
            files ??= lucideIconFiles();
            const rewritten = rewriteLucideImports(code, files);
            return rewritten === code ? null : { code: rewritten, map: null };
        },
    };
}
