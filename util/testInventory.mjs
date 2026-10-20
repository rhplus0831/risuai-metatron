// `pnpm check:tests`: the test inventory check. Plain Node over the source tree (no Vitest or
// Playwright run, so the `requireHuman` gate does not apply). It fails, listing each mismatch, when
//   - a test file under `src`, `server`, `shared`, `util`, `e2e`, or the root is collected by neither
//     runner (`vitest.config.ts` include/exclude, `playwright.config.ts` testDir/testMatch/testIgnore),
//     by both, or only by the other one (Playwright owns `e2e/**/*.spec.ts`, Vitest the rest);
//   - a `slow` tag (`/** @module-tag slow */`, or `tags: ["slow"]` on a test or suite) is missing from
//     the slow-test table in `docs/structure/build-test-platforms.md` `Tests`, a table row names a
//     test that carries no `slow` tag, or a test's `tags` is not a literal string or an array of literal strings;
//   - a non-test file under `src`, `server/src`, or `shared` imports test code (a `tests/` path or a
//     `*.test`/`*.spec` module). A test file is a `*.test.*`/`*.spec.*` file or any file under a
//     `tests/` directory.
// The configs are read as source, not run: a config shape this file does not understand (a
// non-literal pattern, an object spread, an unsupported pattern-list spread, or a duplicate key,
// `projects`, `typecheck`, `respectGitIgnore`, no
// `testDir`) is an error, not a guess. The patterns are applied by each runner's own code: Vitest's
// file glob (tinyglobby, as Vitest calls it) and Playwright's `createFileMatcher` on the absolute path.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseSvelte } from "svelte/compiler";
import ts from "typescript";
import { configDefaults } from "vitest/config";

const require = createRequire(import.meta.url);
const { globSync } = createRequire(require.resolve("vitest/package.json"))("tinyglobby");
const { createFileMatcher } = createRequire(require.resolve("@playwright/test/package.json"))("playwright/lib/util");

/** Test-like file names: what Vitest's and Playwright's default patterns collect. */
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_NAME = /\.([cm]?[jt]sx?|svelte)$/;
/** Where test files are looked for: these directories and the root's own files. */
export const TEST_ROOTS = ["src", "server", "shared", "util", "e2e"];
/** Where product files are checked for test imports. */
export const PRODUCT_ROOTS = ["src", "server/src", "shared"];
export const SLOW_TABLE_DOC = "docs/structure/build-test-platforms.md";
/** The first header cell of the slow-test table; a row's bare file name is relative to this directory. */
const SLOW_TABLE_HEADER = /^Test \(file in `([^`]+)`\)$/;
const PLAYWRIGHT_DEFAULT_MATCH = "**/*.@(spec|test).?(c|m)[jt]s?(x)";

/** Files under `dir` (repository-relative, posix), skipping `node_modules` and `.git`. */
function walk(root, dir, out = []) {
    let entries;
    try {
        entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return out;
        throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            walk(root, rel, out);
        } else if (entry.isFile()) {
            out.push(rel);
        }
    }
    return out;
}

function rootFiles(root) {
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
}

/** Whether `rel` is test code: a `*.test.*`/`*.spec.*` file or anything under a `tests/` directory. */
export function isTestPath(rel) {
    const parts = rel.split("/");
    return TEST_NAME.test(parts.at(-1)) || parts.slice(0, -1).includes("tests");
}

function parse(file, text) {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The object literal passed to the `defineConfig(...)` the file default-exports. */
function configObject(file, text) {
    const source = parse(file, text);
    for (const statement of source.statements) {
        if (!ts.isExportAssignment(statement)) continue;
        let expression = statement.expression;
        if (ts.isCallExpression(expression) && expression.expression.getText(source) === "defineConfig") {
            expression = expression.arguments[0];
        }
        if (expression && ts.isObjectLiteralExpression(expression)) return { source, object: expression };
    }
    throw new Error(`${file}: no \`export default defineConfig({ ... })\` object to read`);
}

/**
 * The value of property `name` in a config object literal. A spread, a computed name, or a method
 * could hide any key, so the object is refused instead of read past.
 */
function property(object, name, source, file) {
    const seen = new Set();
    let value;
    for (const prop of object.properties) {
        const key =
            prop.name &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name))
                ? prop.name.text
                : undefined;
        if (key === undefined || !(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))) {
            throw new Error(
                `${file}: \`${prop.getText(source)}\` is not a plain property; util/testInventory.mjs cannot read it`,
            );
        }
        // JavaScript keeps the last of two equal keys; refused rather than read either way.
        if (seen.has(key)) throw new Error(`${file}: \`${key}\` is set twice; util/testInventory.mjs cannot read it`);
        seen.add(key);
        if (key === name) value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
    }
    return value;
}

function refuse(file, object, names, source) {
    for (const name of names) {
        if (property(object, name, source, file)) {
            throw new Error(`${file}: \`${name}\` is not supported by util/testInventory.mjs; teach it first`);
        }
    }
}

/** A pattern list: string literals and `...configDefaults.<key>` spreads. */
function patternList(file, node, source, defaults) {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (!ts.isArrayLiteralExpression(node)) {
        throw new Error(`${file}: \`${node.getText(source)}\` is not a literal pattern list`);
    }
    return node.elements.flatMap((element) => {
        if (ts.isStringLiteralLike(element)) return [element.text];
        if (ts.isSpreadElement(element)) {
            const match = /^configDefaults\.(include|exclude)$/.exec(element.expression.getText(source));
            if (match && defaults) return defaults[match[1]];
        }
        throw new Error(`${file}: \`${element.getText(source)}\` is not a literal pattern`);
    });
}

/** `test.include`/`test.exclude` of a Vitest config, defaults filled in. */
export function readVitestConfig(text, defaults = configDefaults, file = "vitest.config.ts") {
    const { source, object } = configObject(file, text);
    refuse(file, object, ["root"], source);
    const test = property(object, "test", source, file);
    if (!test) return { include: [...defaults.include], exclude: [...defaults.exclude] };
    if (!ts.isObjectLiteralExpression(test)) throw new Error(`${file}: \`test\` is not an object literal`);
    // `typecheck` can collect other files or none of the runtime ones (`typecheck.only`).
    refuse(file, test, ["projects", "workspace", "dir", "root", "includeSource", "typecheck"], source);
    const include = property(test, "include", source, file);
    const exclude = property(test, "exclude", source, file);
    return {
        include: include ? patternList(file, include, source, defaults) : [...defaults.include],
        exclude: exclude ? patternList(file, exclude, source, defaults) : [...defaults.exclude],
    };
}

/** `testDir`/`testMatch`/`testIgnore` of a Playwright config, defaults filled in. */
export function readPlaywrightConfig(text, file = "playwright.config.ts") {
    const { source, object } = configObject(file, text);
    refuse(file, object, ["projects", "respectGitIgnore"], source);
    const testMatch = property(object, "testMatch", source, file);
    const testIgnore = property(object, "testIgnore", source, file);
    const match = testMatch ? patternList(file, testMatch, source) : [PLAYWRIGHT_DEFAULT_MATCH];
    const ignore = testIgnore ? patternList(file, testIgnore, source) : [];
    const testDir = property(object, "testDir", source, file);
    // Without a `testDir` Playwright also skips what `.gitignore` lists (`respectGitIgnore`).
    if (!testDir || testDir.text === "")
        throw new Error(`${file}: no \`testDir\`; util/testInventory.mjs does not read .gitignore`);
    if (!ts.isStringLiteralLike(testDir)) throw new Error(`${file}: \`testDir\` is not a string literal`);
    return { testDir: testDir.text, testMatch: match, testIgnore: ignore };
}

/**
 * The files Vitest collects (repository-relative, posix): its own file glob, as Vitest 4 calls it
 * (`globFiles`: tinyglobby with `dot: true`, the excludes as `ignore`, no directory expansion).
 */
export function vitestFiles(root, config) {
    return new Set(
        globSync(config.include, { cwd: root, dot: true, ignore: config.exclude, expandDirectories: false }),
    );
}

/** Playwright's rule: a file under `testDir` whose absolute path its `testMatch`, and no `testIgnore`, matches. */
export function collectedByPlaywright(root, rel, config) {
    const absolute = path.resolve(root, rel);
    const inDir = path.relative(path.resolve(root, config.testDir), absolute);
    if (inDir === ".." || inDir.startsWith(`..${path.sep}`) || path.isAbsolute(inDir)) return false;
    return createFileMatcher(config.testMatch)(absolute) && !createFileMatcher(config.testIgnore)(absolute);
}

/** Test-like files under the test roots and the root itself. */
export function findTestFiles(root) {
    const files = [...rootFiles(root), ...TEST_ROOTS.flatMap((dir) => walk(root, dir))];
    return files.filter((rel) => TEST_NAME.test(rel.split("/").at(-1))).sort();
}

/** Mismatches between the test files and the two runners' configs. */
export function checkRunners(root, files = findTestFiles(root)) {
    const vitest = readVitestConfig(readFileSync(path.join(root, "vitest.config.ts"), "utf8"));
    const playwright = readPlaywrightConfig(readFileSync(path.join(root, "playwright.config.ts"), "utf8"));
    const byVitestSet = vitestFiles(root, vitest);
    const problems = [];
    for (const rel of files) {
        const byVitest = byVitestSet.has(rel);
        const byPlaywright = collectedByPlaywright(root, rel, playwright);
        // The owner: Playwright for `e2e/**/*.spec.ts`, Vitest for every other test file.
        const owner = rel.startsWith("e2e/") && rel.endsWith(".spec.ts") ? "Playwright" : "Vitest";
        if (byVitest && byPlaywright) problems.push(`${rel}: collected by both Vitest and Playwright`);
        else if (!byVitest && !byPlaywright) problems.push(`${rel}: collected by no runner (orphan test file)`);
        else if ((owner === "Vitest") !== byVitest) {
            problems.push(`${rel}: collected by ${byVitest ? "Vitest" : "Playwright"}, not by its runner ${owner}`);
        }
    }
    return problems;
}

/**
 * Whether a call is a test or suite, by Vitest's own rule (`describe`, `suite`, `it`, `test`, a name
 * starting with `test` or ending with `Test`), also with modifiers (`it.skip`, `describe.each(...)`,
 * ``it.each`table` ``).
 */
function isTestCall(node, source) {
    let callee = node.expression;
    while (
        ts.isPropertyAccessExpression(callee) ||
        ts.isCallExpression(callee) ||
        ts.isTaggedTemplateExpression(callee)
    ) {
        callee = ts.isTaggedTemplateExpression(callee) ? callee.tag : callee.expression;
    }
    if (!ts.isIdentifier(callee)) return false;
    const name = callee.getText(source);
    return ["describe", "suite", "it", "test"].includes(name) || name.startsWith("test") || name.endsWith("Test");
}

/** Whether the file carries a `slow` module tag, read as Vitest reads it (anywhere in the text). */
function hasSlowModuleTag(text) {
    return [...text.matchAll(/(?:\/\/|\*)\s*@module-tag\s+([\w\-/]+)\b/g)].some((match) => match[1] === "slow");
}

/** `node` without the type-only wrappers around it (`as const`, `satisfies`, parentheses). */
function unwrap(node) {
    while (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node)
    ) {
        node = node.expression;
    }
    return node;
}

/** A test options object's tags: `"slow"`, `"none"`, or `"unreadable"` (not a literal string list). */
function slowTagOf(options, source) {
    const prop = options.properties.find(
        (p) => p.name && p.name.getText(source).replace(/^["']|["']$/g, "") === "tags",
    );
    if (!prop) return "none";
    if (!ts.isPropertyAssignment(prop)) return "unreadable";
    const tags = unwrap(prop.initializer);
    const list = ts.isArrayLiteralExpression(tags) ? tags.elements.map(unwrap) : [tags];
    if (!list.every((e) => ts.isStringLiteralLike(e))) return "unreadable";
    return list.some((e) => e.text === "slow") ? "slow" : "none";
}

/**
 * The `slow` tags of one test file: `{ title: null }` for a module tag, else the tagged test's or
 * suite's title (null when not a literal).
 */
export function slowTagsOf(rel, text) {
    const tags = [];
    if (hasSlowModuleTag(text)) tags.push({ file: rel, title: null, module: true });
    // Parsing is the check's main cost; skip files with neither slow tags nor tags to validate.
    if (!text.includes("slow") && !text.includes("tags")) return tags;
    const source = parse(rel, text);
    const visit = (node) => {
        if (ts.isCallExpression(node) && isTestCall(node, source)) {
            const options = node.arguments.map(unwrap).find((arg) => ts.isObjectLiteralExpression(arg));
            const tag = options ? slowTagOf(options, source) : "none";
            if (tag !== "none") {
                const title = node.arguments[0];
                tags.push({
                    file: rel,
                    title: title && ts.isStringLiteralLike(title) ? title.text : null,
                    module: false,
                    unreadable: tag === "unreadable",
                    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return tags;
}

/**
 * The rows of the slow-test table: `{ file, whole, titles }`. A cell names its file in backticks
 * (bare names are relative to the header's directory, a name with a `/` to the repository), then
 * either "(the whole file)" or one or more double-quoted titles, where `...` stands for any text.
 */
export function readSlowTable(markdown) {
    const lines = markdown.split("\n");
    const start = lines.findIndex((line) => {
        const cell = line.split("|")[1]?.trim();
        return cell !== undefined && SLOW_TABLE_HEADER.test(cell);
    });
    if (start < 0) throw new Error(`${SLOW_TABLE_DOC}: no slow-test table (header "Test (file in \`...\`)")`);
    const dir = SLOW_TABLE_HEADER.exec(lines[start].split("|")[1].trim())[1].replace(/\/$/, "");
    const rows = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) {
        const cell = lines[i].split("|")[1].trim();
        const name = /`([^`]+)`/.exec(cell)?.[1];
        const titles = [...cell.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        rows.push({
            line: i + 1,
            cell,
            file: name === undefined ? null : name.includes("/") ? name : `${dir}/${name}`,
            whole: cell.includes("(the whole file)"),
            titles,
        });
    }
    return rows;
}

function titlePattern(title) {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${title.split("...").map(escape).join("[\\s\\S]*")}$`);
}

/** Mismatches between the `slow` tags and the table rows. */
export function compareSlowTable(tags, rows) {
    const problems = [];
    const named = new Set();
    for (const row of rows) {
        const where = `${SLOW_TABLE_DOC}:${row.line}`;
        if (!row.file) {
            problems.push(`${where}: the row names no test file`);
            continue;
        }
        const inFile = tags.filter((tag) => tag.file === row.file && !tag.unreadable);
        if (!row.whole && row.titles.length === 0) {
            problems.push(`${where}: the row names no test ("(the whole file)" or a quoted title)`);
        }
        if (row.whole) {
            const moduleTag = inFile.find((tag) => tag.module);
            if (moduleTag) named.add(moduleTag);
            else problems.push(`${where}: ${row.file} is listed as a whole file but has no \`@module-tag slow\``);
        }
        for (const title of row.titles) {
            const pattern = titlePattern(title);
            const matches = inFile.filter((tag) => !tag.module && tag.title !== null && pattern.test(tag.title));
            if (matches.length === 0)
                problems.push(`${where}: no \`slow\`-tagged test in ${row.file} is titled "${title}"`);
            for (const tag of matches) named.add(tag);
        }
    }
    for (const tag of tags) {
        if (named.has(tag)) continue;
        if (tag.unreadable)
            problems.push(
                `${tag.file}:${tag.line}: a test's \`tags\` is not a literal list of strings; util/testInventory.mjs cannot read it`,
            );
        else if (tag.module)
            problems.push(`${tag.file}: \`@module-tag slow\` is not in the slow-test table of ${SLOW_TABLE_DOC}`);
        else if (tag.title === null)
            problems.push(`${tag.file}:${tag.line}: a \`slow\` tag on a test whose title is not a literal`);
        else
            problems.push(
                `${tag.file}:${tag.line}: the \`slow\` test "${tag.title}" is not in the slow-test table of ${SLOW_TABLE_DOC}`,
            );
    }
    return problems;
}

export function checkSlowTable(root, files = findTestFiles(root)) {
    const tags = files.flatMap((rel) => slowTagsOf(rel, readFileSync(path.join(root, rel), "utf8")));
    const rows = readSlowTable(readFileSync(path.join(root, SLOW_TABLE_DOC), "utf8"));
    return compareSlowTable(tags, rows);
}

/** Whether an import specifier names test code. */
export function isTestSpecifier(specifier) {
    // Normalized first: `./tests/../feature` names `./feature`.
    const parts = path.posix.normalize(specifier.split("?")[0]).split("/");
    // `./tests` itself names the directory's index module.
    return parts.includes("tests") || /\.(test|spec)(\.[cm]?[jt]sx?)?$/.test(parts.at(-1));
}

/** The literal module specifiers of a Svelte AST: imports, re-exports, `import()`, and `require()` in scripts and the template. */
function svelteImports(ast) {
    const found = [];
    const seen = new Set();
    const visit = (node) => {
        if (!node || typeof node !== "object" || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) return node.forEach(visit);
        let source =
            node.type === "ImportDeclaration" ||
            node.type === "ImportExpression" ||
            node.type === "ExportAllDeclaration" ||
            node.type === "ExportNamedDeclaration"
                ? node.source
                : undefined;
        if (node.type === "TSImportType") source = node.argument;
        else if (node.type === "TSExternalModuleReference") source = node.expression;
        else if (
            node.type === "CallExpression" &&
            node.callee.type === "Identifier" &&
            node.callee.name === "require"
        ) {
            source = node.arguments[0];
        }
        while (source) {
            if (source.type === "TSLiteralType") source = source.literal;
            else if (
                source.type === "TSAsExpression" ||
                source.type === "TSSatisfiesExpression" ||
                source.type === "ParenthesizedExpression"
            ) {
                source = source.expression;
            } else break;
        }
        if (source?.type === "Literal" && typeof source.value === "string") found.push(source.value);
        else if (source?.type === "TemplateLiteral" && source.expressions.length === 0) {
            found.push(source.quasis[0].value.cooked);
        }
        for (const [key, value] of Object.entries(node)) {
            if (key !== "parent" && key !== "metadata") visit(value);
        }
    };
    visit(ast);
    return found;
}

/**
 * The import specifiers of one source file: static, re-export, and dynamic. A `.svelte` file goes
 * through Svelte's parser, so its template expressions count and its comments do not.
 */
export function importsOf(rel, text) {
    if (rel.endsWith(".svelte")) return svelteImports(parseSvelte(text, { filename: rel, modern: true }));
    return ts.preProcessFile(text, true, true).importedFiles.map((file) => file.fileName);
}

/** Non-test files under the product roots that import test code. */
export function checkProductImports(root) {
    const problems = [];
    for (const rel of PRODUCT_ROOTS.flatMap((dir) => walk(root, dir))) {
        if (!SOURCE_NAME.test(rel) || isTestPath(rel)) continue;
        for (const specifier of importsOf(rel, readFileSync(path.join(root, rel), "utf8"))) {
            if (isTestSpecifier(specifier)) problems.push(`${rel}: product code imports test code "${specifier}"`);
        }
    }
    return problems;
}

export function checkInventory(root) {
    const files = findTestFiles(root);
    return [...checkRunners(root, files), ...checkSlowTable(root, files), ...checkProductImports(root)];
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const problems = checkInventory(root);
    if (problems.length > 0) {
        process.stderr.write(
            `[check:tests] ${problems.length} mismatch(es):\n${problems.map((p) => `  ${p}\n`).join("")}`,
        );
        process.exit(1);
    }
    process.stdout.write(`[check:tests] OK: ${findTestFiles(root).length} test files, slow table, product imports\n`);
}
