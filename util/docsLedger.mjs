// `pnpm docs:ledger <guide> [--base <ref>]`: the mechanical check of a trim's fact ledger. It reads the guide at
// `<ref>` (default `HEAD`, through `git show`) and on disk, and prints each identifier of the base's `## Files` and
// `## Flows` sections (their `###` subsections included) that is now in neither the working guide nor a file the
// working guide names: one line each, with the old heading it came from (`Files > Readers`), in order of first
// appearance. The guide is a name as `pnpm docs:read` takes it.
//   - Identifiers come from code spans only (fenced code is opaque, as in `pnpm check:docs`). A span that is a
//     repository path by the `missing-path` rule of `util/docsBudget.mjs` is the path itself, one per brace
//     expansion, with no trailing `/`. Any other span yields its tokens: each run of letters, digits, `_`, and `$`
//     that starts with a letter, `_`, or `$`. A dotted name is its parts (`pending.createSnapshot` is `pending` and
//     `createSnapshot`), since the source spells the parts apart (`pending` declared here, `.createSnapshot()` read
//     there) and a whole-word search stops at the dot anyway.
//   - Too generic to check: a token under 3 characters, and the literals and keywords in `GENERIC_WORDS`.
//   - A token is present when it is a whole word (bounded by anything but letters, digits, `_`, `$`) of the working
//     guide's full text or of a named file. A path is present when the working guide names it (an expansion of one
//     of its path spans, or a match of one of its globs), or when it occurs whole in that text or a named file.
//   - The named files: each path span of the working guide, braces expanded and globs matched, that is a file
//     (a directory is not searched), plus each relative `.md` link target of the working guide that exists, since
//     another guide's heading is a legitimate destination for a moved fact.
// Exit 0 when nothing is missing, 1 when something is, 2 on a usage error, an unknown guide, or a ref without it.
import { execFileSync } from "node:child_process";
import { globSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    PATH_SPAN,
    UNCHECKED_ROOTS,
    codeSpans,
    expandBraces,
    inlineLinks,
    linkTarget,
    parseGuide,
} from "./docsBudget.mjs";
import { guideNames, resolveGuide } from "./docsRead.mjs";

/** The `##` sections whose identifiers the ledger checks. */
export const LEDGER_SECTIONS = ["Files", "Flows"];
/** The shortest token checked: shorter ones (`id`, `db`, `ui`) match nearly any text. */
export const MIN_TOKEN_LENGTH = 3;
/** Literals and keywords a code span quotes as code, not as a name to look up. */
export const GENERIC_WORDS = new Set([
    "true",
    "false",
    "null",
    "undefined",
    "this",
    "new",
    "return",
    "const",
    "let",
    "var",
    "function",
    "class",
    "async",
    "await",
    "typeof",
    "void",
    "export",
    "import",
    "from",
    "default",
]);

/**
 * Whether `span` names a repository path, by the `missing-path` rule: one token of path characters with a `/`, not
 * starting with one, without `...`, whose first segment is in `rootDirs` (the root's directories) and is tracked.
 */
export function isPathSpan(span, rootDirs) {
    if (!PATH_SPAN.test(span) || !span.includes("/") || span.includes("...") || span.startsWith("/")) return false;
    const first = span.slice(0, span.indexOf("/"));
    return rootDirs.has(first) && !UNCHECKED_ROOTS.has(first);
}

/** The identifiers a code span yields, as `{ id, path }`: its path expansions, or its non-generic tokens. */
export function spanIdentifiers(span, rootDirs) {
    if (isPathSpan(span, rootDirs)) {
        return expandBraces(span.replace(/\/$/, "")).map((id) => ({ id, path: true }));
    }
    return [...span.matchAll(/[\w$]+/g)]
        .map(([token]) => token)
        .filter((token) => /^[A-Za-z_$]/.test(token) && token.length >= MIN_TOKEN_LENGTH && !GENERIC_WORDS.has(token))
        .map((id) => ({ id, path: false }));
}

/**
 * The identifiers of `text`'s `LEDGER_SECTIONS`, each once, in order of first appearance: `{ id, path, section }`,
 * `section` the heading chain it first appeared under (`Files > Readers`).
 */
export function ledgerIdentifiers(text, rootDirs) {
    const { segments } = parseGuide(text);
    const found = new Map();
    /** The open headings, outermost first, while inside a ledger section; null outside one. */
    let chain = null;
    for (const segment of segments) {
        if (segment.kind === "heading") {
            if (segment.level <= 2) {
                chain = segment.level === 2 && LEDGER_SECTIONS.includes(segment.text) ? [segment] : null;
            } else if (chain) {
                chain = [...chain.filter((heading) => heading.level < segment.level), segment];
            }
        }
        if (!chain) continue;
        const section = chain.map((heading) => heading.text).join(" > ");
        for (const span of codeSpans(segment.text)) {
            for (const entry of spanIdentifiers(span, rootDirs)) {
                const key = `${entry.path ? "path" : "word"} ${entry.id}`;
                if (!found.has(key)) found.set(key, { ...entry, section });
            }
        }
    }
    return [...found.values()];
}

/**
 * What the guide `text` at repository path `rel` names: `{ pathSpans, links }`, the path spans (as written) and the
 * repository paths of its relative `.md` links to other files, each once, in order. Links leaving the repository
 * are dropped.
 */
export function namedTargets(text, rel, rootDirs) {
    const pathSpans = new Set();
    const links = new Set();
    for (const { text: segmentText } of parseGuide(text).segments) {
        for (const span of codeSpans(segmentText)) if (isPathSpan(span, rootDirs)) pathSpans.add(span);
        for (const destination of inlineLinks(segmentText)) {
            const target = linkTarget(destination);
            if (!target) continue;
            const file = path.posix.normalize(
                path.posix.join(path.posix.dirname(rel), target.file || path.posix.basename(rel)),
            );
            if (file !== rel && file !== ".." && !file.startsWith("../")) links.add(file);
        }
    }
    return { pathSpans: [...pathSpans], links: [...links] };
}

/** The patterns a path span stands for: its brace expansions, without a trailing `/`. */
export const spanPatterns = (span) => expandBraces(span.replace(/\/$/, ""));

/** Whether `text` holds the path `id` whole: not preceded or followed by more path characters. */
function holdsPath(text, id) {
    for (let at = text.indexOf(id); at >= 0; at = text.indexOf(id, at + 1)) {
        const before = text[at - 1] ?? "";
        const after = text.slice(at + id.length, at + id.length + 2);
        if (!/[\w$./-]/.test(before) && !/^([\w$/-]|\.[\w$])/.test(after)) return true;
    }
    return false;
}

/** The whole-word vocabulary of `texts`: every maximal run of letters, digits, `_`, and `$`. */
export function wordSet(texts) {
    const words = new Set();
    for (const text of texts) for (const [word] of text.matchAll(/[\w$]+/g)) words.add(word);
    return words;
}

/**
 * The entries of `identifiers` (from `ledgerIdentifiers`) present nowhere: not a word of `texts` (the working guide
 * and its named files) and, for a path, not among `patterns` (the working guide's path expansions, globs matched
 * with `path.matchesGlob`) nor whole in `texts`.
 */
export function missingIdentifiers(identifiers, { texts, patterns }) {
    const words = wordSet(texts);
    const exact = new Set(patterns);
    const globs = patterns.filter((pattern) => pattern.includes("*"));
    return identifiers.filter(({ id, path: isPath }) => {
        if (!isPath) return !words.has(id);
        if (exact.has(id) || globs.some((glob) => path.posix.matchesGlob(id, glob))) return false;
        return !texts.some((text) => holdsPath(text, id));
    });
}

/** The report: one line per missing identifier under a count line, or one line saying none is missing. */
export function formatLedger(rel, base, missing, { checked, files }) {
    const scope = `${base}:${rel} ${LEDGER_SECTIONS.join(" and ")}`;
    if (missing.length === 0) {
        return `${rel}: nothing missing: every identifier of ${scope} (${checked}) is in the guide or the ${files} files it names`;
    }
    const width = Math.max(...missing.map(({ id }) => id.length));
    const lines = missing.map(({ id, section }) => `  ${id.padEnd(width)}  (${section})`);
    return [
        `${rel}: ${missing.length} of ${checked} identifiers of ${scope} are in neither the guide nor the ${files} files it names:`,
        ...lines,
    ].join("\n");
}

/** The repository files the guide's `namedTargets` resolve to under `root`, and the path patterns it names. */
export function resolveNamed(root, { pathSpans, links }) {
    const patterns = pathSpans.flatMap(spanPatterns);
    const files = new Set();
    const isFile = (rel) => {
        try {
            return statSync(path.join(root, rel)).isFile();
        } catch {
            return false;
        }
    };
    for (const pattern of patterns) {
        const matches = pattern.includes("*") ? globSync(pattern, { cwd: root }) : [pattern];
        for (const match of matches) if (isFile(match)) files.add(match.split(path.sep).join("/"));
    }
    for (const link of links) if (isFile(link)) files.add(link);
    return { files: [...files], patterns };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const args = process.argv.slice(2);
    const usage = (message) => {
        process.stderr.write(`${message ? `${message}\n` : ""}usage: pnpm docs:ledger <guide> [--base <ref>]\n`);
        process.exit(2);
    };
    let base = "HEAD";
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--base") {
            if (!args[i + 1]) usage("--base needs a ref");
            base = args[++i];
        } else if (args[i].startsWith("--base=")) base = args[i].slice("--base=".length);
        else if (args[i].startsWith("-")) usage(`unknown option ${args[i]}`);
        else positional.push(args[i]);
    }
    if (positional.length !== 1) usage();
    const rel = resolveGuide(root, positional[0]);
    if (!rel) {
        process.stderr.write(`no guide named ${positional[0]}; one of:\n${guideNames(root).join("\n")}\n`);
        process.exit(2);
    }
    let baseText;
    try {
        baseText = execFileSync("git", ["show", `${base}:${rel}`], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
        process.stderr.write(`${base} has no ${rel}\n`);
        process.exit(2);
    }
    const rootDirs = new Set(
        readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    );
    const workText = readFileSync(path.join(root, rel), "utf8");
    const identifiers = ledgerIdentifiers(baseText, rootDirs);
    const { files, patterns } = resolveNamed(root, namedTargets(workText, rel, rootDirs));
    const texts = [workText, ...files.map((file) => readFileSync(path.join(root, file), "utf8"))];
    const missing = missingIdentifiers(identifiers, { texts, patterns });
    process.stdout.write(`${formatLedger(rel, base, missing, { checked: identifiers.length, files: files.length })}\n`);
    process.exitCode = missing.length > 0 ? 1 : 0;
}
