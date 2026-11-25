// `pnpm docs:contracts <file-or-dir>...`: what a module already documents, read before a guide's `Files` entry is
// trimmed to a pointer. For each source file it prints the module header, then each exported declaration as
// `line kind name` with the doc comment directly above it, then the exports without one, then `documented N of M`;
// several files end with a total. A directory expands recursively to its `.ts`, `.mts`, `.js`, `.mjs`, and `.svelte`
// files, leaving out `*.test.*`, `*.spec.*`, `*.d.ts`, files under a `tests/` directory, and `node_modules`; a file
// named directly is read whatever its name.
//   - A doc comment is a `/** */` block with only whitespace between it and the declaration; a `//` comment after
//     the block, or alone, leaves the declaration undocumented.
//   - Declarations: functions (overloads once, with the first overload's comment that has one), classes,
//     interfaces, type aliases, enums, namespaces, each name of an `export const/let/var` list (the statement's
//     comment covers all of them), `export default`, and a local declaration exported by `export { a as b }`.
//     Re-exports of other modules (`export { a } from`, `export * from`, an imported name exported again) are no
//     declarations: they are listed apart and never counted as undocumented.
//   - The module header is the first `/** */` block after the imports, before the first other statement, skipping
//     blocks containing only `@typedef`/`@callback` tags without prose. A block touching that statement with no
//     blank line between is the statement's comment, not a header. In `.mjs` only, when no such header is found,
//     a leading `//` block before the imports counts instead; a shebang may precede it.
//   - A `.svelte` file's `<script module>` is read as a module. Its instance `<script>` has no exports but
//     `export const/function` (component exports); the `$props()` destructuring is not one. Its contract is the
//     instance script's header, by the same rule, except that a block touching a `$props()` statement counts.
// Exit 0 normally, 1 when a file does not parse (the others still print), 2 on a usage error or a missing path.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseSvelte } from "svelte/compiler";
import ts from "typescript";

/** Source files a directory argument expands to. */
const SOURCE_FILE = /\.(ts|mts|js|mjs|svelte)$/;
/** Files a directory argument leaves out: tests and declaration files. */
const SKIPPED_FILE = /\.(test|spec)\.|\.d\.ts$/;

/** Whether a directory walk keeps the repository-relative or absolute `file`. */
export function isContractSource(file) {
    const parts = file.split(/[\\/]/);
    const name = parts.at(-1);
    return SOURCE_FILE.test(name) && !SKIPPED_FILE.test(name) && !parts.slice(0, -1).includes("tests");
}

/** The line, 1-based, of character `offset` in `text`. */
function lineAt(text, offset) {
    let line = 1;
    for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
    return line;
}

/** A `/** *\/` block as its text lines: the delimiters and each line's leading `*` go, inner indentation stays. */
export function commentText(block) {
    const lines = block
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .split("\n")
        .map((line, index) => (index === 0 ? line.trim() : line.replace(/^\s*\* ?/, "").trimEnd()));
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
    return lines.join("\n");
}

const isDocBlock = (text, range) =>
    range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
    text.startsWith("/**", range.pos) &&
    text.slice(range.pos, range.end) !== "/**/";

/** The leading comments of `node`, each `{ pos, end, kind }`. */
const leadingComments = (text, node) => ts.getLeadingCommentRanges(text, node.pos) ?? [];

/** The `/** *\/` block directly above `node` (only whitespace between), as `{ pos, end }`, or null. */
function docBlock(text, node) {
    const last = leadingComments(text, node).at(-1);
    return last && isDocBlock(text, last) ? last : null;
}

const isImport = (statement) =>
    ts.isImportDeclaration(statement) ||
    (ts.isImportEqualsDeclaration(statement) && !hasModifier(statement, ts.SyntaxKind.ExportKeyword));

function hasModifier(node, kind) {
    return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ?? false;
}

const isPropsStatement = (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
        (decl) =>
            decl.initializer &&
            ts.isCallExpression(decl.initializer) &&
            ts.isIdentifier(decl.initializer.expression) &&
            decl.initializer.expression.text === "$props",
    );

/** Whether a doc block contains only typedef/callback tags, without prose. */
function isTypeOnlyBlock(text, range) {
    const source = ts.createSourceFile(
        "header.js",
        `${text.slice(range.pos, range.end)}\nconst value = 0;`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const doc = source.statements[0].jsDoc?.[0];
    return (
        !doc?.comment &&
        doc?.tags?.length > 0 &&
        doc.tags.every((tag) => !tag.comment && ["typedef", "callback"].includes(tag.tagName.text))
    );
}

/**
 * The header as `{ pos, end, kind }`, or null: the first doc block before the first non-import statement, skipping
 * type-only blocks. A touching block is the statement's comment unless `touchingCounts(statement)`. With only
 * imports, look after the last one. In `.mjs`, fall back to a leading `//` block, optionally after a shebang.
 */
function headerBlock(source, touchingCounts = () => false) {
    const text = source.text;
    const statement = source.statements.find((s) => !isImport(s));
    const ranges = statement
        ? leadingComments(text, statement)
        : (ts.getLeadingCommentRanges(text, source.endOfFileToken.pos) ?? []);
    const first = ranges.find((range) => isDocBlock(text, range) && !isTypeOnlyBlock(text, range));
    if (first) {
        const touching =
            statement &&
            first === ranges.at(-1) &&
            !/\n[ \t]*\r?\n/.test(text.slice(first.end, statement.getStart(source)));
        if (!touching || touchingCounts(statement)) return first;
    }
    if (!source.fileName.endsWith(".mjs")) return null;
    const leading = /^(?:#![^\n]*\n)?[ \t]*(\/\/[^\n]*(?:\n[ \t]*\/\/[^\n]*)*)/.exec(text);
    return leading
        ? {
              pos: leading[0].length - leading[1].length,
              end: leading[0].length,
              kind: ts.SyntaxKind.SingleLineCommentTrivia,
          }
        : null;
}

const kindOf = (statement) =>
    ts.isFunctionDeclaration(statement)
        ? "function"
        : ts.isClassDeclaration(statement)
          ? "class"
          : ts.isInterfaceDeclaration(statement)
            ? "interface"
            : ts.isTypeAliasDeclaration(statement)
              ? "type"
              : ts.isEnumDeclaration(statement)
                ? "enum"
                : ts.isModuleDeclaration(statement)
                  ? "namespace"
                  : null;

const variableKind = (list) =>
    list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var";

/** The names a binding name declares: an identifier, or every name of a destructuring pattern. */
function bindingNames(name) {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/** The top-level declarations of `source` by local name, as `{ kind, statement }`: the first of overloads. */
function localDeclarations(source) {
    const locals = new Map();
    for (const statement of source.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const decl of statement.declarationList.declarations) {
                for (const name of bindingNames(decl.name)) {
                    if (!locals.has(name))
                        locals.set(name, { kind: variableKind(statement.declarationList), statement });
                }
            }
            continue;
        }
        const kind = kindOf(statement);
        if (kind && statement.name && ts.isIdentifier(statement.name) && !locals.has(statement.name.text)) {
            locals.set(statement.name.text, { kind, statement });
        }
    }
    return locals;
}

/**
 * The exports of a TypeScript or JavaScript source, parsed whole: `{ header, exports, reexports }`. `header` is the
 * module header's text or null and `headerLine` its line; each export is `{ line, kind, name, doc }`, `doc` the
 * comment's text or null, in source order; each re-export is `{ line, text }`. `lineOffset` shifts every line (a
 * `<script>` inside a `.svelte` file); `instance` reads a Svelte instance script (no `$props()` export, the props
 * statement's touching block counts as the header).
 */
export function scriptContracts(text, { fileName = "source.ts", lineOffset = 0, instance = false } = {}) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
    const lineOf = (pos) => lineAt(text, pos) + lineOffset;
    const header = headerBlock(source, instance ? isPropsStatement : undefined);
    // The header, separated from the first statement by a blank line, is no comment of that statement.
    const docOf = (node) => {
        const block = docBlock(text, node);
        return block && block.pos !== header?.pos ? commentText(text.slice(block.pos, block.end)) : null;
    };
    const exports = [];
    const reexports = [];
    const seen = new Set();
    const add = (statement, kind, name) => {
        const key = `${kind} ${name}`;
        if (seen.has(key)) {
            // An overload: the first signature with a comment carries it.
            const entry = exports.find((e) => `${e.kind} ${e.name}` === key);
            if (entry && entry.doc === null) entry.doc = docOf(statement);
            return;
        }
        seen.add(key);
        exports.push({ line: lineOf(statement.getStart(source)), kind, name, doc: docOf(statement) });
    };
    const locals = localDeclarations(source);
    for (const statement of source.statements) {
        const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
        if (ts.isExportDeclaration(statement)) {
            const local =
                !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause);
            const elements = local ? statement.exportClause.elements : [];
            const kept = [];
            for (const element of elements) {
                const declared = locals.get((element.propertyName ?? element.name).text);
                if (declared) add(declared.statement, declared.kind, element.name.text);
                else kept.push(element.getText(source));
            }
            if (!local) reexports.push({ line: lineOf(statement.getStart(source)), text: statement.getText(source) });
            else if (kept.length > 0) {
                reexports.push({ line: lineOf(statement.getStart(source)), text: `export { ${kept.join(", ")} }` });
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            add(statement, "default", "expression");
            continue;
        }
        if (ts.isImportEqualsDeclaration(statement) && exported) {
            reexports.push({ line: lineOf(statement.getStart(source)), text: statement.getText(source) });
            continue;
        }
        if (!exported) continue;
        if (ts.isVariableStatement(statement)) {
            if (instance && isPropsStatement(statement)) continue;
            const kind = variableKind(statement.declarationList);
            for (const decl of statement.declarationList.declarations) {
                for (const name of bindingNames(decl.name)) add(statement, kind, name);
            }
            continue;
        }
        const kind = kindOf(statement);
        if (!kind) continue;
        const name = statement.name && ts.isIdentifier(statement.name) ? statement.name.text : null;
        if (isDefault) add(statement, "default", name ? `${kind} ${name}` : kind);
        else if (name) add(statement, kind, name);
    }
    return {
        header: header
            ? header.kind === ts.SyntaxKind.SingleLineCommentTrivia
                ? text
                      .slice(header.pos, header.end)
                      .split("\n")
                      .map((line) => line.replace(/^[ \t]*\/\/ ?/, "").trimEnd())
                      .join("\n")
                : commentText(text.slice(header.pos, header.end))
            : null,
        headerLine: header ? lineOf(header.pos) : null,
        exports: exports.sort((a, b) => a.line - b.line),
        reexports,
    };
}

function scriptKind(fileName) {
    return /\.m?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * The contracts of one file's text, by its name: `{ scripts }`, one entry per script, each a `scriptContracts`
 * result plus `{ label }` (`module` for a TypeScript or JavaScript file and a `<script module>`, `instance` for a
 * Svelte instance script, whose header is the component contract). Throws when a `.svelte` file does not parse.
 */
export function fileContracts(fileName, text) {
    if (!fileName.endsWith(".svelte")) {
        return { scripts: [{ label: "module", ...scriptContracts(text, { fileName }) }] };
    }
    const root = parseSvelte(text, { filename: fileName, modern: true });
    const scripts = [];
    for (const [label, script] of [
        ["module", root.module],
        ["instance", root.instance],
    ]) {
        if (!script) continue;
        const { start, end } = script.content;
        scripts.push({
            label,
            ...scriptContracts(text.slice(start, end), {
                fileName: `${fileName}.ts`,
                lineOffset: lineAt(text, start) - 1,
                instance: label === "instance",
            }),
        });
    }
    return { scripts };
}

const indent = (text, prefix) =>
    text
        .split("\n")
        .map((line) => (line === "" ? "" : `${prefix}${line}`))
        .join("\n");

/** `{ documented, total }` over a `fileContracts` result's exports. */
export function contractCounts({ scripts }) {
    const all = scripts.flatMap((script) => script.exports);
    return { documented: all.filter((entry) => entry.doc !== null).length, total: all.length };
}

/** The report of one file, as text lines: the path, header, documented exports, undocumented ones, the count. */
export function formatFile(rel, contracts) {
    const out = [rel];
    const svelte = rel.endsWith(".svelte");
    for (const script of contracts.scripts) {
        const where = svelte ? (script.label === "instance" ? "<script>" : "<script module>") : null;
        const title = script.label === "instance" ? "component contract" : "module header";
        const label = where ? `${where} ${script.label === "instance" ? title : "header"}` : title;
        if (script.header === null) out.push(`  ${label}: none`);
        else out.push(`  ${label}: line ${script.headerLine}`, indent(script.header, "      "));
    }
    const all = contracts.scripts.flatMap((script) => script.exports);
    for (const entry of all.filter((e) => e.doc !== null)) {
        out.push(`  ${entry.line} ${entry.kind} ${entry.name}`, indent(entry.doc, "      "));
    }
    const missing = all.filter((e) => e.doc === null);
    if (missing.length > 0) {
        out.push("  without a doc comment:");
        for (const entry of missing) out.push(`    ${entry.line} ${entry.kind} ${entry.name}`);
    }
    const reexports = contracts.scripts.flatMap((script) => script.reexports);
    if (reexports.length > 0) {
        out.push("  re-exports (not counted):");
        for (const entry of reexports) out.push(`    ${entry.line} ${entry.text.replace(/\s+/g, " ")}`);
    }
    const { documented, total } = contractCounts(contracts);
    out.push(`  documented ${documented} of ${total}`);
    return out;
}

/** The source files under directory `dir` that `isContractSource` keeps, sorted, skipping `node_modules`. */
export function sourceFiles(dir) {
    const files = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== "node_modules" && entry.name !== ".git") walk(full);
            } else if (entry.isFile() && isContractSource(path.relative(dir, full))) files.push(full);
        }
    };
    walk(dir);
    return files;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const args = process.argv.slice(2);
    if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
        process.stderr.write("usage: pnpm docs:contracts <file-or-dir>...\n");
        process.exit(2);
    }
    const files = [];
    for (const arg of args) {
        if (!existsSync(arg)) {
            process.stderr.write(`no such path: ${arg}\n`);
            process.exit(2);
        }
        if (statSync(arg).isDirectory()) files.push(...sourceFiles(arg));
        else if (SOURCE_FILE.test(arg)) files.push(arg);
        else {
            process.stderr.write(`not a .ts, .mts, .js, .mjs, or .svelte file: ${arg}\n`);
            process.exit(2);
        }
    }
    let documented = 0;
    let total = 0;
    let failed = false;
    const blocks = [];
    const shown = (file) => {
        const rel = path.relative(process.cwd(), path.resolve(file));
        return rel.startsWith("..") ? path.resolve(file) : rel;
    };
    for (const file of [...new Set(files.map(shown))]) {
        try {
            const contracts = fileContracts(file, readFileSync(file, "utf8"));
            const counts = contractCounts(contracts);
            documented += counts.documented;
            total += counts.total;
            blocks.push(formatFile(file, contracts).join("\n"));
        } catch (error) {
            failed = true;
            process.stderr.write(`${file}: does not parse: ${error.message.split("\n")[0]}\n`);
        }
    }
    let output = blocks.join("\n\n");
    if (blocks.length > 1)
        output += `\n\ntotal: documented ${documented} of ${total} exports in ${blocks.length} files`;
    process.stdout.write(`${output}\n`);
    process.exitCode = failed ? 1 : 0;
}
