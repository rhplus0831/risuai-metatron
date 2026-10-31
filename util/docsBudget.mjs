// `pnpm check:docs`: the documentation size report. Plain Node over the Markdown files (no Vitest or
// Playwright run, no parser dependency). It measures every `*.md` under `docs/structure/` and
// `STRUCTURE.md` against the budgets below and prints
//   - a table of the guides: bytes, `###` headings, largest leaf, items over the length budget, parenthesis
//     depth, unresolved links;
//   - the `##` and `###` sections of each file with their bytes and own bytes;
//   - each finding as `path:line`: long items, deep parentheses, unresolved relative `.md` and `#anchor` links;
//   - the totals of the guides, last, so they are the tail of the output.
// `STRUCTURE.md` has its own row and is in no total. Findings never fail the run: `--report` exits 0
// whatever it finds. The parse is line based: enough for the Markdown these files use, not CommonMark.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GUIDE_BYTES_BUDGET = 40_000;
export const LEAF_BYTES_BUDGET = 8_000;
export const ITEM_CHARS_BUDGET = 600;
export const PAREN_DEPTH_BUDGET = 2;

export const GUIDE_DIR = "docs/structure";
export const INDEX_DOC = "STRUCTURE.md";

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEPARATOR = /^\|[\s:|-]*-[\s:|-]*$/;
/** `[text](dest "title")`, or an image: the text may nest brackets once, a bare destination may hold balanced (). */
const INLINE_LINK =
    /(!?)\[((?:[^[\]]|\[[^[\]]*\])*)\]\([ \t]*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*\)/g;

/**
 * `text` with each code span replaced by `replace(content)`. A run of N backticks closes at the next
 * run of exactly N; an unclosed run is literal text.
 */
function replaceCodeSpans(text, replace) {
    const runs = [...text.matchAll(/`+/g)];
    let out = "";
    let copied = 0;
    for (let i = 0; i < runs.length; i++) {
        const size = runs[i][0].length;
        const close = runs.findIndex((run, j) => j > i && run[0].length === size);
        if (close < 0) continue;
        out += text.slice(copied, runs[i].index) + replace(text.slice(runs[i].index + size, runs[close].index));
        copied = runs[close].index + size;
        i = close;
    }
    return out + text.slice(copied);
}

const stripCodeSpans = (text) => replaceCodeSpans(text, () => "");

/**
 * One Markdown file as `{ bytes, segments, sections }`. A segment is `{ kind, line, text }`, with
 * `level` on a heading: kinds `heading`, `item`, `row`, `paragraph`. A row's text has each run of
 * whitespace collapsed to one space, so column padding is not measured. A section is one heading of level
 * 2 or deeper: `{ level, heading, line, bytes, ownBytes }`, where `bytes` runs to the next heading of
 * the same or a higher level and `ownBytes` to the next heading of any level. Fenced code is opaque.
 */
export function parseGuide(text) {
    const segments = [];
    const headings = [];
    /** The list items a following line can still continue, outermost first. */
    let openItems = [];
    let paragraph = null;
    /** Whether the previous line was item text, so a plain line continues it whatever its indentation. */
    let lazy = false;
    let fence = null;
    let offset = 0;
    const closeItems = (indent) => {
        while (openItems.length > 0 && openItems.at(-1).indent >= indent) openItems.pop();
    };
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];
        const start = offset;
        offset += Buffer.byteLength(raw) + 1;
        const line = raw.trim();
        if (fence !== null) {
            if (line.length >= fence.length && line === fence[0].repeat(line.length)) fence = null;
            continue;
        }
        const wasLazy = lazy;
        lazy = false;
        if (line === "") {
            paragraph = null;
            continue;
        }
        const indent = raw.search(/\S/);
        const opener = FENCE.exec(line);
        if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
            fence = opener[1];
            paragraph = null;
            closeItems(indent);
            continue;
        }
        const heading = HEADING.exec(raw.trimEnd());
        if (heading) {
            const title = (heading[2] ?? "").replace(/(^|[ \t]+)#+$/, "").trim();
            segments.push({ kind: "heading", line: index + 1, text: title, level: heading[1].length });
            headings.push({ level: heading[1].length, heading: title, line: index + 1, start });
            openItems = [];
            paragraph = null;
            continue;
        }
        const marker = LIST_MARKER.exec(line);
        if (marker) {
            closeItems(indent);
            const segment = { kind: "item", line: index + 1, text: (marker[2] ?? "").trim() };
            segments.push(segment);
            openItems.push({ indent, segment });
            paragraph = null;
            lazy = true;
            continue;
        }
        if (line.startsWith("|")) {
            closeItems(indent);
            paragraph = null;
            if (!TABLE_SEPARATOR.test(line)) {
                segments.push({ kind: "row", line: index + 1, text: line.replace(/\s+/g, " ") });
            }
            continue;
        }
        // After a blank line, a fence, or a table row, only text indented past a marker stays in that item.
        if (!wasLazy) closeItems(indent);
        const open = openItems.at(-1)?.segment ?? paragraph;
        if (open) {
            open.text = open.text === "" ? line : `${open.text} ${line}`;
        } else {
            paragraph = { kind: "paragraph", line: index + 1, text: line };
            segments.push(paragraph);
        }
        lazy = openItems.length > 0;
    }
    const bytes = Buffer.byteLength(text);
    const startOf = (entry) => entry?.start ?? bytes;
    const sections = [];
    headings.forEach((entry, i) => {
        if (entry.level < 2) return;
        const next = headings.slice(i + 1).find((other) => other.level <= entry.level);
        sections.push({
            level: entry.level,
            heading: entry.heading,
            line: entry.line,
            bytes: startOf(next) - entry.start,
            ownBytes: startOf(headings[i + 1]) - entry.start,
        });
    });
    return { bytes, segments, sections };
}

/** A heading's rendered text: backticks and emphasis markers go, the text stays, a link keeps its text. */
function headingPlainText(heading) {
    const spans = [];
    const masked = replaceCodeSpans(heading, (content) => {
        spans.push(content);
        return `\0${spans.length - 1}\0`;
    });
    return (
        masked
            .replace(INLINE_LINK, "$2")
            .replace(/[*~]/g, "")
            // An underscore pair is emphasis only at word edges: `snake_case` keeps its underscore.
            .replace(/(?<![\p{L}\p{N}_])(_+)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2")
            .replace(/\0(\d+)\0/g, (_, index) => spans[Number(index)])
    );
}

/** The GitHub anchors of a Markdown file's headings, in order: a repeated slug takes `-1`, `-2`, ... */
export function headingAnchors(text) {
    const used = new Map();
    const anchors = [];
    for (const segment of parseGuide(text).segments) {
        if (segment.kind !== "heading") continue;
        const slug = headingPlainText(segment.text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N} _-]/gu, "")
            .replaceAll(" ", "-");
        let anchor = slug;
        while (used.has(anchor)) {
            used.set(slug, used.get(slug) + 1);
            anchor = `${slug}-${used.get(slug)}`;
        }
        used.set(anchor, 0);
        anchors.push(anchor);
    }
    return anchors;
}

/** The deepest parenthesis nesting of prose: code spans and link destinations are not prose. */
export function parenDepth(text) {
    const prose = stripCodeSpans(text).replace(INLINE_LINK, "$2");
    let depth = 0;
    let deepest = 0;
    for (const char of prose) {
        if (char === "(") deepest = Math.max(deepest, ++depth);
        else if (char === ")") depth = Math.max(depth - 1, 0);
    }
    return deepest;
}

/** The destinations of the inline links in `text`: no images, nothing inside a code span. */
export function inlineLinks(text) {
    return [...stripCodeSpans(text).matchAll(INLINE_LINK)]
        .filter((match) => match[1] === "")
        .map((match) => match[3].replace(/^<(.*)>$/, "$1"));
}

function percentDecode(text) {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/** A link destination as `{ file, anchor }`, `file` empty for a bare `#anchor`; null when it is not checked. */
export function linkTarget(destination) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("/")) return null;
    const hash = destination.indexOf("#");
    const file = percentDecode(hash < 0 ? destination : destination.slice(0, hash));
    const anchor = hash < 0 ? null : percentDecode(destination.slice(hash + 1));
    if (file === "" ? !anchor : !file.endsWith(".md")) return null;
    return { file, anchor };
}

/** Reads the anchors of repository files, once each; null for a missing or unreadable target. */
function anchorReader(root) {
    const cache = new Map();
    return (rel) => {
        if (!cache.has(rel)) {
            let anchors = null;
            try {
                anchors = new Set(headingAnchors(readFileSync(path.join(root, rel), "utf8")));
            } catch (error) {
                if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
            }
            cache.set(rel, anchors);
        }
        return cache.get(rel);
    };
}

/** Why a link from `rel` to `destination` does not resolve, or null when it does (or is not checked). */
function linkProblem(rel, destination, readAnchors) {
    const target = linkTarget(destination);
    if (!target) return null;
    const file = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), target.file || path.posix.basename(rel)),
    );
    // A path leaving the repository names nothing this checkout holds.
    if (file === ".." || file.startsWith("../")) return "no such file";
    const anchors = readAnchors(file);
    if (!anchors) return "no such file";
    return target.anchor && !anchors.has(target.anchor) ? "no such anchor" : null;
}

function measureFile(root, rel, readAnchors) {
    const { bytes, segments, sections } = parseGuide(readFileSync(path.join(root, rel), "utf8"));
    const longItems = [];
    const deepSegments = [];
    const unresolvedLinks = [];
    let maxParenDepth = 0;
    for (const { kind, line, text } of segments) {
        for (const destination of inlineLinks(text)) {
            const reason = linkProblem(rel, destination, readAnchors);
            if (reason) unresolvedLinks.push({ line, target: destination, reason });
        }
        if (kind === "heading") continue;
        if (kind !== "paragraph") {
            const length = [...text].length;
            if (length > ITEM_CHARS_BUDGET) longItems.push({ line, kind, length });
        }
        const depth = parenDepth(text);
        maxParenDepth = Math.max(maxParenDepth, depth);
        if (depth > PAREN_DEPTH_BUDGET) deepSegments.push({ line, kind, depth });
    }
    const largestLeaf = sections.reduce(
        (best, { ownBytes, heading, line }) =>
            best && best.bytes >= ownBytes ? best : { bytes: ownBytes, heading, line },
        null,
    );
    return {
        path: rel,
        bytes,
        overBudget: bytes > GUIDE_BYTES_BUDGET,
        h3Count: sections.filter((section) => section.level === 3).length,
        sections,
        largestLeaf,
        longItems,
        maxParenDepth,
        deepSegments,
        unresolvedLinks,
    };
}

const countKind = (items, kind) => items.filter((item) => item.kind === kind).length;

/**
 * The measurement of the repository at `root`, as plain data: `{ guides, index, totals }`. `guides`
 * is sorted by path; `index` is `STRUCTURE.md`, which `totals` leaves out.
 */
export function measureDocs(root) {
    const readAnchors = anchorReader(root);
    const paths = readdirSync(path.join(root, GUIDE_DIR), { recursive: true })
        .filter((name) => name.endsWith(".md"))
        .map((name) => `${GUIDE_DIR}/${name.split(path.sep).join("/")}`)
        .sort();
    const guides = paths.map((rel) => measureFile(root, rel, readAnchors));
    const largest = guides
        .filter((guide) => guide.largestLeaf)
        .reduce(
            (best, guide) =>
                best && best.bytes >= guide.largestLeaf.bytes ? best : { ...guide.largestLeaf, path: guide.path },
            null,
        );
    const longItems = guides.flatMap((guide) => guide.longItems);
    return {
        guides,
        index: measureFile(root, INDEX_DOC, readAnchors),
        totals: {
            guideCount: guides.length,
            bytes: guides.reduce((sum, guide) => sum + guide.bytes, 0),
            h3Count: guides.reduce((sum, guide) => sum + guide.h3Count, 0),
            guidesOverBudget: guides.filter((guide) => guide.overBudget).length,
            largestLeaf: largest,
            listItemsOver: countKind(longItems, "item"),
            tableRowsOver: countKind(longItems, "row"),
            deepSegments: guides.reduce((sum, guide) => sum + guide.deepSegments.length, 0),
            unresolvedLinks: guides.reduce((sum, guide) => sum + guide.unresolvedLinks.length, 0),
        },
    };
}

/** Fixed-width lines for `rows` of cells: the first column left-aligned, the others right-aligned. */
function table(rows) {
    const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
    return rows.map((row) =>
        row
            .map((cell, column) => {
                const text = String(cell);
                return column === 0 ? text.padEnd(widths[column]) : text.padStart(widths[column]);
            })
            .join("  ")
            .trimEnd(),
    );
}

function guideRow(guide) {
    return [
        guide.path,
        guide.bytes,
        guide.overBudget ? "yes" : "no",
        guide.h3Count,
        guide.largestLeaf?.bytes ?? 0,
        guide.longItems.length,
        countKind(guide.longItems, "item"),
        countKind(guide.longItems, "row"),
        guide.maxParenDepth,
        guide.deepSegments.length,
        guide.unresolvedLinks.length,
    ];
}

/** The report for a `measureDocs` result, ending in the guide totals. */
export function formatReport(measure) {
    const { guides, index, totals } = measure;
    const files = [...guides, index];
    const lines = [];
    const header = [
        "guide",
        "bytes",
        `>${GUIDE_BYTES_BUDGET}`,
        "###",
        "largestLeaf",
        `items>${ITEM_CHARS_BUDGET}`,
        "list",
        "rows",
        "parens",
        `depth>${PAREN_DEPTH_BUDGET}`,
        "unresolved",
    ];
    const byBytes = [...guides].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
    const rows = table([header, ...byBytes.map(guideRow), guideRow(index)]);
    const [head, ...body] = rows;
    lines.push("[check:docs] Guides", `  ${head}`);
    lines.push(...body.slice(0, -1).map((row) => `  ${row}`), "", `  ${body.at(-1)}`, "");

    lines.push("[check:docs] Sections");
    for (const file of files) {
        lines.push(`  ${file.path}`);
        const sections = file.sections
            .filter((section) => section.level <= 3)
            .map((section) => [
                `${"#".repeat(section.level)} ${section.heading}`,
                section.bytes,
                section.ownBytes,
                section.ownBytes > LEAF_BYTES_BUDGET ? "over" : "",
            ]);
        lines.push(...table([["heading", "bytes", "ownBytes", ""], ...sections]).map((row) => `    ${row}`));
    }
    lines.push("");

    const findings = (title, pick, format) => {
        const found = files.flatMap((file) => pick(file).map((entry) => `  ${file.path}:${format(entry)}`));
        lines.push(`[check:docs] ${title}: ${found.length}`, ...found, "");
    };
    findings(
        `Items over ${ITEM_CHARS_BUDGET} characters`,
        (file) => file.longItems,
        ({ line, kind, length }) => `${line} ${kind} ${length}`,
    );
    findings(
        `Segments above parenthesis depth ${PAREN_DEPTH_BUDGET}`,
        (file) => file.deepSegments,
        ({ line, kind, depth }) => `${line} ${kind} depth ${depth}`,
    );
    findings(
        "Unresolved links",
        (file) => file.unresolvedLinks,
        ({ line, target, reason }) => `${line} ${target} (${reason})`,
    );

    const leaf = totals.largestLeaf;
    lines.push(
        `[check:docs] Totals (guides only, ${INDEX_DOC} excluded)`,
        `[check:docs] guides: ${totals.guideCount}`,
        `[check:docs] total bytes: ${totals.bytes}`,
        `[check:docs] ### headings: ${totals.h3Count}`,
        `[check:docs] guides over ${GUIDE_BYTES_BUDGET} bytes: ${totals.guidesOverBudget}`,
        `[check:docs] largest leaf: ${leaf ? `${leaf.bytes} bytes, ${leaf.path} "${leaf.heading}"` : "none"}`,
        `[check:docs] list items over ${ITEM_CHARS_BUDGET}: ${totals.listItemsOver}`,
        `[check:docs] table rows over ${ITEM_CHARS_BUDGET}: ${totals.tableRowsOver}`,
        `[check:docs] items over ${ITEM_CHARS_BUDGET}, both kinds: ${totals.listItemsOver + totals.tableRowsOver}`,
        `[check:docs] segments above depth ${PAREN_DEPTH_BUDGET}: ${totals.deepSegments}`,
        `[check:docs] unresolved links: ${totals.unresolvedLinks}`,
    );
    return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.some((arg) => arg !== "--report")) {
        process.stderr.write("usage: node util/docsBudget.mjs --report\n");
        process.exit(2);
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write(formatReport(measureDocs(root)));
}
