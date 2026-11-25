// `pnpm docs:ledger <guide> [--base <ref>] [--strict]`: the mechanical check of a trim's fact ledger.
// It reads the guide at `<ref>` (default `HEAD`, through `git show`) and on disk, and prints each identifier of the
// base's `## Files` and `## Flows` sections (their `###` subsections included) that is now in neither the working
// guide nor a file the working guide names: one line each, with the old heading it came from (`Files > Readers`),
// in order of first appearance. The guide is a name as `pnpm docs:read` takes it.
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
//     another guide's heading is a legitimate destination for a moved fact. With `--strict`, path patterns containing
//     `*` add neither named files nor path-presence matches; exact brace expansions and `.md` links still count.
//   - A span holding `*` outside a path (`MAX_*`, `triggerV2*`) is a pattern, not a name, and yields nothing; so
//     does a command span (`pnpm --silent test:agent <filters>`, or one starting `node`, `npx`, `git`, `corepack`).
// Exit 0 when nothing is missing, 1 when something is, 2 on a usage error, an unknown guide, or a ref without it.
//
// `pnpm docs:ledger --stale [<guide>...]`: the stale-identifier report, over every guide and `STRUCTURE.md` when no
// guide is named. It prints one `path:line stale <id> (<section>)` line per identifier of any section that is a whole
// word of no source file, then a count line. It is a report, not a gate: exit 0 whatever it finds. The number also
// appears per guide in `pnpm check:docs --report`. A rising count on a guide is the sign its facts drifted from the
// code and it is due a read-and-verify pass (Doc Maintenance).
//   - Identifiers are as above, from every section; path spans are left to `check:docs`'s `missing-path` rule.
//   - The source files: the repository's tracked and untracked, non-ignored files (outside a repository, a walk
//     of the root), except `docs/`, Markdown, the roots `check:docs` never checks, the search-excluded payloads
//     listed in `.ignore`, files over `MAX_SOURCE_BYTES`, and names whose extension is not in `SOURCE_TEXT`
//     (a dotfile or an extensionless file such as `.npmrc` or `Dockerfile` is read).
//   - A word is present when it, or it without a leading `$` (a Svelte store subscription), is a whole word of
//     any source file or of the path of any listed file (a test named by its basename, `shutdownAdmission`).
//     Markdown is never a source, so a name only the guides use is stale. Not checked: a token ending or starting
//     in `_` (a prefix such as `VITE_`, a suffix shorthand such as `_events`), one that reads as a commit hash, and
//     Doc Maintenance (`docs/structure/README.md`), which documents conventions, not code.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    GUIDE_DIR,
    INDEX_DOC,
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
/** A code span that quotes a command, whose words are flags and filters, not names. */
export const COMMAND_SPAN = /^(?:pnpm|node|npx|git|corepack)\s/;
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
    if (span.includes("*") || COMMAND_SPAN.test(span)) return [];
    return [...span.matchAll(/[\w$]+/g)]
        .map(([token]) => token)
        .filter((token) => /^[A-Za-z_$]/.test(token) && token.length >= MIN_TOKEN_LENGTH && !GENERIC_WORDS.has(token))
        .map((id) => ({ id, path: false }));
}

/**
 * The identifiers of `text`'s `sections` (`##` headings; null: every section, text before the first heading
 * included), each once, in order of first appearance: `{ id, path, section, line }`, `section` the heading chain it
 * first appeared under (`Files > Readers`, "" before the first heading) and `line` where.
 */
export function ledgerIdentifiers(text, rootDirs, sections = LEDGER_SECTIONS) {
    const { segments } = parseGuide(text);
    const found = new Map();
    /** The open headings, outermost first, while inside a checked section; null outside one. */
    let chain = sections === null ? [] : null;
    for (const segment of segments) {
        if (segment.kind === "heading") {
            if (segment.level <= 2) {
                const checked = sections === null || (segment.level === 2 && sections.includes(segment.text));
                chain = checked ? [segment] : null;
            } else if (chain) {
                chain = [...chain.filter((heading) => heading.level < segment.level), segment];
            }
        }
        if (!chain) continue;
        const section = chain.map((heading) => heading.text).join(" > ");
        for (const span of codeSpans(segment.text)) {
            for (const entry of spanIdentifiers(span, rootDirs)) {
                const key = `${entry.path ? "path" : "word"} ${entry.id}`;
                if (!found.has(key)) found.set(key, { ...entry, section, line: segment.line });
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

/** Whether `words` holds `id`, or `id` without the `$` of a Svelte store subscription (`$PlaygroundStore`). */
export const hasWord = (words, id) => words.has(id) || (id.startsWith("$") && words.has(id.slice(1)));

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
        if (!isPath) return !hasWord(words, id);
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

/** The named files and path patterns under `root`; `strict` excludes patterns containing `*` from both. */
export function resolveNamed(root, { pathSpans, links }, { strict = false } = {}) {
    const patterns = pathSpans.flatMap(spanPatterns).filter((pattern) => !strict || !pattern.includes("*"));
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

/** The extensions the stale scan reads as source text; other extensions are binary or data for this purpose. */
export const SOURCE_TEXT = /\.(?:[cm]?[jt]s|svelte|json|css|html?|ya?ml|toml|txt|sh|bat|conf|lua|cbs|xml|svg|snap)$/i;
/** The largest source file the stale scan reads; a bigger one is a payload, not code. */
export const MAX_SOURCE_BYTES = 1 << 20;

/** The directories the root's `.ignore` hides from searches, as `dir/` prefixes, and its other entries as paths. */
function searchExcluded(root) {
    const file = path.join(root, ".ignore");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

/** The repository-relative files under `root`: git's tracked and untracked, non-ignored files, or a walk. */
function listFiles(root) {
    try {
        const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
        });
        if (path.resolve(top.trim()) === path.resolve(root)) {
            const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
            const out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 });
            return [...new Set(out.split("\0").filter(Boolean))];
        }
    } catch {
        // not a repository: walk
    }
    return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
            path
                .relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
                .split(path.sep)
                .join("/"),
        )
        .sort();
}

/** Whether the stale scan reads `rel` as source: see the header's list of what is left out. */
export function isSourceText(rel, excluded = []) {
    const first = rel.slice(0, rel.indexOf("/") >= 0 ? rel.indexOf("/") : rel.length);
    if (UNCHECKED_ROOTS.has(first) || rel === "docs" || rel.startsWith("docs/") || rel.endsWith(".md")) return false;
    if (excluded.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry))) return false;
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return true;
    return SOURCE_TEXT.test(name);
}

/**
 * The whole-word vocabulary of the source under `root`, as `{ words, files }`: the words of every source text and
 * of every listed file's path, `files` the count of texts read.
 */
export function sourceWords(root) {
    const excluded = searchExcluded(root);
    const words = new Set();
    let files = 0;
    for (const rel of listFiles(root)) {
        for (const [word] of rel.matchAll(/[\w$]+/g)) words.add(word);
        if (!isSourceText(rel, excluded)) continue;
        const file = path.join(root, rel);
        let size;
        try {
            size = statSync(file).size;
        } catch {
            continue;
        }
        if (size > MAX_SOURCE_BYTES) continue;
        for (const [word] of readFileSync(file, "utf8").matchAll(/[\w$]+/g)) words.add(word);
        files++;
    }
    return { words, files };
}

/** A token the stale scan does not check: a prefix (`VITE_`), a suffix shorthand (`_events`), or a commit hash. */
export const isUncheckedToken = (id) => id.endsWith("_") || id.startsWith("_") || /^[0-9a-f]{7,40}$/.test(id);

/** The guides and `STRUCTURE.md` under `root`, as repository paths, the index last; Doc Maintenance is left out. */
function guidePaths(root) {
    const guides = readdirSync(path.join(root, GUIDE_DIR), { recursive: true })
        .filter((rel) => rel.endsWith(".md") && rel !== "README.md")
        .map((rel) => `${GUIDE_DIR}/${rel.split(path.sep).join("/")}`)
        .sort();
    return existsSync(path.join(root, INDEX_DOC)) ? [...guides, INDEX_DOC] : guides;
}

/**
 * The stale identifiers of the guides `rels` (default: every guide and `STRUCTURE.md`) under `root`: names in code
 * spans of any section that are whole words of no source file. `{ guides: [{ rel, checked, stale: [{ id,
 * section, line }] }], checked, stale, files }`, `files` the source files read.
 */
export function staleIdentifiers(root, rels = guidePaths(root)) {
    const rootDirs = new Set(
        readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    );
    const { words, files } = sourceWords(root);
    const guides = rels.map((rel) => {
        const identifiers = ledgerIdentifiers(readFileSync(path.join(root, rel), "utf8"), rootDirs, null).filter(
            (entry) => !entry.path && !isUncheckedToken(entry.id),
        );
        const stale = identifiers
            .filter(({ id }) => !hasWord(words, id))
            .map(({ id, section, line }) => ({ id, section, line }));
        return { rel, checked: identifiers.length, stale };
    });
    return {
        guides,
        checked: guides.reduce((sum, guide) => sum + guide.checked, 0),
        stale: guides.reduce((sum, guide) => sum + guide.stale.length, 0),
        files,
    };
}

/** The stale report: one `path:line stale <id> (<section>)` line per identifier, then the count line. */
export function formatStale({ guides, checked, stale, files }) {
    const lines = guides.flatMap((guide) =>
        guide.stale.map(({ id, section, line }) => `${guide.rel}:${line} stale ${id}${section ? ` (${section})` : ""}`),
    );
    const where = guides.filter((guide) => guide.stale.length > 0).length;
    lines.push(
        `[docs:ledger] ${stale} stale identifier(s) in ${where} of ${guides.length} guides, ` +
            `${checked} checked against ${files} source files`,
    );
    return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const args = process.argv.slice(2);
    const usage = (message) => {
        process.stderr.write(
            `${message ? `${message}\n` : ""}usage: pnpm docs:ledger <guide> [--base <ref>] [--strict]\n` +
                `       pnpm docs:ledger --stale [<guide>...]\n`,
        );
        process.exit(2);
    };
    let base = "HEAD";
    let strict = false;
    let stale = false;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--base") {
            if (!args[i + 1]) usage("--base needs a ref");
            base = args[++i];
        } else if (args[i].startsWith("--base=")) base = args[i].slice("--base=".length);
        else if (args[i] === "--strict") strict = true;
        else if (args[i] === "--stale") stale = true;
        else if (args[i].startsWith("-")) usage(`unknown option ${args[i]}`);
        else positional.push(args[i]);
    }
    if (stale) {
        if (base !== "HEAD" || strict) usage("--stale takes no --base or --strict");
        const rels = positional.map((name) => {
            const rel = resolveGuide(root, name);
            if (!rel) {
                process.stderr.write(`no guide named ${name}; one of:\n${guideNames(root).join("\n")}\n`);
                process.exit(2);
            }
            return rel;
        });
        process.stdout.write(formatStale(staleIdentifiers(root, rels.length > 0 ? rels : undefined)));
        process.exit(0);
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
    const { files, patterns } = resolveNamed(root, namedTargets(workText, rel, rootDirs), { strict });
    const texts = [workText, ...files.map((file) => readFileSync(path.join(root, file), "utf8"))];
    const missing = missingIdentifiers(identifiers, { texts, patterns });
    process.stdout.write(`${formatLedger(rel, base, missing, { checked: identifiers.length, files: files.length })}\n`);
    process.exitCode = missing.length > 0 ? 1 : 0;
}
