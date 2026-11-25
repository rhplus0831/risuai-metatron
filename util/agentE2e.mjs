// Spec selection for `pnpm test:agent --e2e` (`util/agentTest.mjs`): which Playwright specs in `e2e/`
// a change reaches. Every spec drives the whole app, so no import graph says which spec covers a
// change; the selection is by name instead. A spec is selected for a changed file when
// - the spec is the changed file, or the spec reaches it through relative static imports (followed
//   through the harness files in `e2e/` and `util/playwright/`, resolving extensionless imports);
// - the spec's text names the file: its repository path (`/src/...` dynamic imports included), its
//   file name when no other tracked file has that name, or one of its parent directories (fixture
//   directories a spec reads);
// - the file is one every spec runs on (EVERY_SPEC_FILES).
// A spec that names a script only by importing it in the page (`await import("/src/ts/x.ts")` in a
// `page.evaluate`, to read or set the app's state) uses a few of its exports as handles. Such a spec
// is selected only when the change touches a name it uses (`pageImportUses`, `touchedNames`); the
// specs left out are reported with the names the change touches.
// Guides, notes, and unit tests are never matched (`reachesBrowser`). A changed file no spec names
// is reported, so the agent can name the specs that cover the behavior instead. See
// `docs/structure/test-harness.md`.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";

const require = createRequire(import.meta.url);
let typescript;

/** The TypeScript parser, loaded on first use: only a page import of a changed script needs it. */
function parser() {
    return (typescript ??= require("typescript"));
}

/** Changes to these reach every spec: the browser harness, the stack, and the app's build. */
export const EVERY_SPEC_FILES = new Set([
    "playwright.config.ts",
    "util/playwright/globalSetup.mjs",
    "util/playwright/stack.mjs",
    "vite.config.ts",
    "index.html",
    "pnpm-lock.yaml",
]);

/** Whether a change to `file` can show in a browser spec: not a guide, a note, or a unit test. */
export function reachesBrowser(file) {
    if (file.startsWith("docs/") || file.startsWith("handover/")) return false;
    if (file.endsWith(".md")) return false;
    return !/\.test\.[cm]?[jt]sx?$/.test(file);
}

const PATH_CHAR = /[\w./-]/;

/**
 * Whether `text` names `token` (a path or a file name) as a whole: not inside a longer name or path.
 * A leading `/` is allowed when nothing path-like comes before it (`"/src/ts/x.ts"`, `../shared/x.ts`),
 * so `src/x.ts` is not found inside `server/src/x.ts`; a trailing `.` ends a sentence.
 */
export function mentions(text, token) {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
        const before = text[at - 1];
        const okBefore =
            before === undefined ||
            !PATH_CHAR.test(before) ||
            (before === "/" && (at < 2 || !/[\w-]/.test(text[at - 2])));
        const after = text[at + token.length];
        const okAfter =
            after === undefined ||
            (after === "." ? !/\w/.test(text[at + token.length + 1] ?? "") : !PATH_CHAR.test(after));
        if (okBefore && okAfter) return true;
    }
    return false;
}

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function isHarness(file) {
    return file.startsWith("e2e/") || file.startsWith("util/playwright/");
}

/**
 * The repository paths `file` reaches through relative static imports, following the harness files
 * (`e2e/`, `util/playwright/`) and stopping at app and shared code. `read` returns a file's text, or
 * null when it cannot be read. Resolve the exact path, then `.ts`, `.svelte.ts`, and `/index.ts`,
 * keeping the normalized path when none is readable.
 */
export function staticImports(file, read) {
    const reached = new Set();
    const pending = [file];
    while (pending.length > 0) {
        const current = pending.pop();
        const text = read(current);
        if (text === null) continue;
        for (const [, specifier] of text.matchAll(IMPORT_PATTERN)) {
            const normalized = posix.normalize(posix.join(posix.dirname(current), specifier));
            const target =
                [normalized, `${normalized}.ts`, `${normalized}.svelte.ts`, `${normalized}/index.ts`].find(
                    (candidate) => read(candidate) !== null,
                ) ?? normalized;
            if (reached.has(target)) continue;
            reached.add(target);
            if (isHarness(target)) pending.push(target);
        }
    }
    reached.delete(file);
    return reached;
}

/** Follows a page import to what the spec reads off it; false when that is not a list of names. */
function collectUses(ts, call, uses) {
    if (!ts.isAwaitExpression(call.parent)) return false;
    let node = call.parent;
    while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        uses.add(parent.name.text);
        return true;
    }
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== node) return false;
    if (ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
            const key = element.propertyName ?? element.name;
            if (element.dotDotDotToken || !ts.isIdentifier(key)) return false;
            uses.add(key.text);
        }
        return true;
    }
    if (!ts.isIdentifier(parent.name)) return false;
    // A namespace binding: every reference in its function must read a member off it.
    const binding = parent.name;
    let scope = parent.parent;
    while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    let readable = true;
    const visit = (child) => {
        if (ts.isIdentifier(child) && child.text === binding.text && child !== binding) {
            const owner = child.parent;
            if (ts.isPropertyAccessExpression(owner) && owner.expression === child) uses.add(owner.name.text);
            else if (!(ts.isPropertyAccessExpression(owner) && owner.name === child)) readable = false;
        }
        ts.forEachChild(child, visit);
    };
    visit(scope);
    return readable;
}

/**
 * The exports `specText` uses from `file` when it names the file only by importing it in the page:
 * the destructured names, the members read off a namespace binding, and `(await import(...)).name`.
 * Null when the spec depends on the whole file: it names the path anywhere else (a comment, a
 * string), or uses an import some other way (for its side effects, passed on, not awaited).
 */
export function pageImportUses(specText, file) {
    const ts = parser();
    const source = ts.createSourceFile("spec.ts", specText, ts.ScriptTarget.Latest, true);
    const calls = [];
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteralLike(node.arguments[0]) &&
            node.arguments[0].text === `/${file}`
        )
            calls.push(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (calls.length === 0) return null;
    let rest = specText;
    for (const call of calls) {
        const [specifier] = call.arguments;
        const start = specifier.getStart(source);
        rest = rest.slice(0, start) + " ".repeat(specifier.end - start) + rest.slice(specifier.end);
    }
    if (mentions(rest, file)) return null;
    const uses = new Set();
    for (const call of calls) if (!collectUses(ts, call, uses)) return null;
    return uses;
}

/**
 * A script's top-level statements as `{ key, names, uses }`: the statement's text without its leading
 * comment, the names it declares, and the identifiers it refers to. Import and export lists give one
 * entry per binding, so adding a binding changes no other. `names` is null where a change reaches
 * every importer (a side-effect import, `export *`) and empty for a statement that declares nothing.
 * Types are left out: they are erased before the browser runs the script. Null when `text` has a
 * syntax error.
 */
function topLevel(ts, text, fileName) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
    if (source.parseDiagnostics.length > 0) return null;
    const identifiers = (node, into) => {
        if (ts.isIdentifier(node)) into.add(node.text);
        ts.forEachChild(node, (child) => {
            identifiers(child, into);
        });
        return into;
    };
    const bound = (name, into) => {
        if (ts.isIdentifier(name)) into.push(name.text);
        else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bound(element.name, into);
    };
    const entries = [];
    for (const statement of source.statements) {
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
        const key = statement.getText(source);
        if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            const from = statement.moduleSpecifier.getText(source);
            if (!clause) entries.push({ key, names: null });
            if (!clause || clause.isTypeOnly) continue;
            const add = (binding, name) =>
                entries.push({ key: `import ${binding} from ${from}`, names: [name], uses: new Set() });
            if (clause.name) add(clause.name.text, clause.name.text);
            const bindings = clause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) add(`* as ${bindings.name.text}`, bindings.name.text);
            else if (bindings)
                for (const element of bindings.elements)
                    if (!element.isTypeOnly) add(`{${element.getText(source)}}`, element.name.text);
            continue;
        }
        if (ts.isExportDeclaration(statement)) {
            if (statement.isTypeOnly) continue;
            const clause = statement.exportClause;
            const from = statement.moduleSpecifier?.getText(source) ?? "";
            if (!clause || !ts.isNamedExports(clause)) {
                entries.push({ key, names: null });
                continue;
            }
            for (const element of clause.elements)
                if (!element.isTypeOnly)
                    entries.push({
                        key: `export {${element.getText(source)}} from ${from}`,
                        names: [element.name.text],
                        uses: new Set([(element.propertyName ?? element.name).text]),
                    });
            continue;
        }
        const names = [];
        if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations) bound(declaration.name, names);
        else if (ts.isExportAssignment(statement)) names.push("default");
        else if (
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isModuleDeclaration(statement)
        )
            names.push(statement.name?.text ?? "default");
        entries.push({ key, names, uses: identifiers(statement, new Set()) });
    }
    return entries;
}

/**
 * The top-level names a change to a script touches: the declarations whose text differs between
 * `before` and `after` (added and removed ones included), then every declaration of either version
 * that refers to a touched name, repeated until none is added, so a changed helper touches the
 * exports that call it. A statement that declares nothing passes the touch on to every identifier it
 * refers to. Comment-only and type-only changes touch nothing. Null when the reach cannot be read
 * off the names: a syntax error, or a change to a statement that declares nothing, to a side-effect
 * import, or to an `export *`, all of which run for every importer.
 */
export function touchedNames(before, after, fileName = "module.ts") {
    const ts = parser();
    const sides = [topLevel(ts, before, fileName), topLevel(ts, after, fileName)];
    if (sides.includes(null)) return null;
    const [was, now] = sides.map((side) => {
        const count = new Map();
        for (const { key } of side) count.set(key, (count.get(key) ?? 0) + 1);
        return count;
    });
    const entries = sides.flat();
    const touched = new Set();
    for (const entry of entries) {
        if (was.get(entry.key) === now.get(entry.key)) continue;
        if (entry.names === null || entry.names.length === 0) return null;
        for (const name of entry.names) touched.add(name);
    }
    const named = entries.filter((entry) => entry.names !== null);
    for (let grew = touched.size > 0; grew;) {
        grew = false;
        for (const entry of named) {
            const own = entry.names.length > 0 ? entry.names : [...entry.uses];
            if (own.every((name) => touched.has(name))) continue;
            if (![...entry.uses].some((name) => touched.has(name))) continue;
            for (const name of own) touched.add(name);
            grew = true;
        }
    }
    return touched;
}

/** The scripts `touchedNames` reads; a change to any other file reaches every spec that names it. */
const SCRIPT = /\.[cm]?[jt]s$/;

/**
 * Picks the specs a change reaches. `specs` are `{ file, text, imports }` (`imports` from
 * `staticImports`), `changed` the changed repository paths, `tracked` every repository path (for the
 * file names no other file shares). `versions(file)` returns a changed file's `{ before, after }`
 * text (null for a side that does not exist); without it no page import is narrowed. Returns
 * `{ selected: [{ file, because }], unnamed, ignored, narrowed: [{ file, touched, skipped }] }`: the
 * selected specs in `specs` order with the changed files that selected each, the changed files that
 * can reach the browser but no spec names, the changed files that cannot, and for each changed file
 * that left specs out, the names its change touches (sorted) and the specs that import it in the page
 * without using one of them.
 */
export function selectSpecs({ specs, changed, tracked, versions }) {
    const nameCount = new Map();
    for (const path of tracked) {
        const name = posix.basename(path);
        nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
    const ignored = changed.filter((file) => !reachesBrowser(file));
    const relevant = changed.filter(reachesBrowser);
    const reasons = new Map(specs.map((spec) => [spec.file, []]));
    const named = new Set();
    const narrowed = [];
    for (const file of relevant) {
        const name = posix.basename(file);
        const dirs = [];
        for (let dir = posix.dirname(file); dir.includes("/"); dir = posix.dirname(dir)) dirs.push(dir);
        // Read on the first spec that names the file by its path alone; null: every such spec is selected.
        let touched;
        const touchedByChange = () => {
            if (touched !== undefined) return touched;
            const sides = versions && SCRIPT.test(file) ? versions(file) : null;
            const readable = typeof sides?.before === "string" && typeof sides.after === "string";
            return (touched = readable ? touchedNames(sides.before, sides.after, name) : null);
        };
        const skipped = [];
        for (const spec of specs) {
            const whole =
                EVERY_SPEC_FILES.has(file) ||
                spec.file === file ||
                spec.imports.has(file) ||
                ((nameCount.get(name) ?? 0) <= 1 && mentions(spec.text, name)) ||
                dirs.some((dir) => mentions(spec.text, dir));
            if (!whole && !mentions(spec.text, file)) continue;
            named.add(file);
            if (!whole && touchedByChange() !== null) {
                const uses = pageImportUses(spec.text, file);
                if (uses !== null && ![...uses].some((use) => touched.has(use))) {
                    skipped.push(spec.file);
                    continue;
                }
            }
            reasons.get(spec.file).push(file);
        }
        if (skipped.length > 0) narrowed.push({ file, touched: [...touched].sort(), skipped });
    }
    return {
        selected: specs
            .filter((spec) => reasons.get(spec.file).length > 0)
            .map((spec) => ({ file: spec.file, because: reasons.get(spec.file) })),
        unnamed: relevant.filter((file) => !named.has(file)),
        ignored,
        narrowed,
    };
}

const SUMMARY_MAX = 110;

/** The first sentence of a spec's first comment: what it checks, for the list printed when nothing is selected. */
export function specSummary(text) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("//"));
    if (start === -1) return "";
    const block = [];
    for (const line of lines.slice(start)) {
        if (!line.startsWith("//")) break;
        block.push(line.replace(/^\/\/\s?/, "").trim());
    }
    const comment = block.join(" ");
    const end = comment.search(/\.(\s|$)/);
    const sentence = end === -1 ? comment : comment.slice(0, end + 1);
    return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1)}…` : sentence;
}

function git(root, gitArgs) {
    const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout.split("\0").filter(Boolean);
}

/**
 * The repository paths changed since `since` (a revision; HEAD by default): committed after it,
 * staged, unstaged, deleted, renamed (both names), and untracked files (`.gitignore` honored).
 */
export function changedFiles(root, since = "HEAD") {
    const diff = git(root, ["diff", "--name-only", "--no-renames", "-z", since, "--"]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return [...new Set([...diff, ...untracked])].sort();
}

/**
 * A changed file's text at `since` and in the working tree, the two sides `changedFiles` compares;
 * null for a side that does not exist (an added or a deleted file).
 */
export function fileVersions(root, since, file) {
    const shown = spawnSync("git", ["show", `${since}:${file}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    let after = null;
    try {
        after = readFileSync(posix.join(root, file), "utf8");
    } catch {
        // Deleted since `since`.
    }
    return { before: shown.status === 0 ? shown.stdout : null, after };
}

/** Every tracked and untracked repository path (`.gitignore` honored). */
export function repositoryFiles(root) {
    return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
}

/** The specs in `e2e/`, in Playwright's run order (file names sorted), with their text and imports. */
export function loadSpecs(root) {
    const read = (file) => {
        try {
            return readFileSync(posix.join(root, file), "utf8");
        } catch {
            return null;
        }
    };
    return readdirSync(posix.join(root, "e2e"))
        .filter((name) => name.endsWith(".spec.ts"))
        .sort()
        .map((name) => {
            const file = `e2e/${name}`;
            return { file, text: read(file) ?? "", imports: staticImports(file, read) };
        });
}
