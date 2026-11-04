// `pnpm check:docs`: the documentation check. Plain Node over the Markdown files (no Vitest or
// Playwright run, no parser dependency). It measures every `*.md` under `docs/structure/` and
// `STRUCTURE.md`, all under one uniform budget, and fails, printing one `path:line rule message` line per
// finding, on
//   - `ceiling`: a file over the guide budget;
//   - `leaf`: a heading of any level whose own text, up to the next heading, is over the leaf budget. Text before
//     a file's first heading is in no leaf and counts only toward the guide budget;
//   - `item`: a list item or table row over the item budget;
//   - `paren-depth`: a heading, item, row, or paragraph with parentheses nested too deep outside code spans;
//   - `sections` and `hazards`: a guide's `##` headings, or its `Known Hazards` `###` headings, off the fixed outline
//     (`STRUCTURE.md` and an area folder's `README.md` are indexes with no outline);
//   - `unresolved-link`: a relative `.md` or `#anchor` link that does not resolve;
//   - `self-link`: a link to the file it is in, with no anchor;
//   - `label`: a work-tracking label, matched on joined segment text so a line wrap cannot split one. In a guide
//     the whole text counts; in `STRUCTURE.md` only prose, because its rules quote the labels and link the plans;
//   - `missing-path`: a code span naming a repository path that does not exist. A span is a path when it is one
//     token of path characters with a `/` and starts with a directory of the repository root (not an untracked one
//     such as `node_modules`); `{a,b}` expands, `*` must match something, a trailing `/` needs a directory. A
//     missing path git ignores is a runtime file and passes. Identifiers in code spans and paths without a `/`
//     (`package.json`) are not validated;
//   - `ownership`: the ownership manifest (`docs/structure/ownership.json`, read by `util/docsOwner.mjs`) is not
//     JSON or has a bad rule, a rule matches no tracked path or only paths an earlier rule owns, a tracked path under
//     `src/`, `server/`, `shared/`, `util/`, `e2e/`, or `public/` has no rule, or a rule names no guide. Tracked
//     paths are what git lists, untracked files it does not ignore included; outside a repository there are none
//     and a missing manifest has no rules, so the rule finds nothing;
//   - `tree`: the guides and `STRUCTURE.md` together over `TREE_BYTES_RATCHET`. A trim lowers the ratchet to within
//     1,000 bytes of the new total; nothing raises it.
// It also prints, without failing, one `near` line per file over the guide target and per heading over the leaf
// target, each with the bytes left under its budget: the targets are where a trim or a split lands, so a guide
// keeps room for the changes that follow instead of sitting at the budget, where every edit fails the gate.
//
// `--report` exits 0 whatever it finds and prints
//   - a table of the guides: bytes, headroom under the guide budget, `###` headings, largest leaf, items over the
//     length budget, parenthesis depth, unresolved links;
//   - the `##` and `###` sections of each file with their bytes and own bytes;
//   - each finding as `path:line`: long items, deep parentheses, unresolved links, section order, hazard
//     headings, self-links, labels;
//   - the totals of the guides, last, so they are the tail of the output.
// `STRUCTURE.md` has its own row and is in no total. The parse is line based: enough for the Markdown these
// files use, not CommonMark.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkOwnership, OWNERSHIP_FILE } from "./docsOwner.mjs";

export const GUIDE_BYTES_BUDGET = 40_000;
export const LEAF_BYTES_BUDGET = 8_000;
/** Where a trim or a split lands: over a target the check warns (`near`), over a budget it fails. */
export const GUIDE_BYTES_TARGET = 36_000;
export const LEAF_BYTES_TARGET = 7_000;
export const ITEM_CHARS_BUDGET = 600;
export const PAREN_DEPTH_BUDGET = 2;
/**
 * The most the guides and `STRUCTURE.md` may hold together. Lower it in the change that lowers the total, to
 * within 1,000 bytes of the new total; a change that needs it raised moves or deletes text instead.
 */
export const TREE_BYTES_RATCHET = 966_000;

export const GUIDE_DIR = "docs/structure";
export const INDEX_DOC = "STRUCTURE.md";

/** Every guide's `##` headings, in order. */
export const GUIDE_SECTIONS = [
    "Scope",
    "Files",
    "Flows",
    "State",
    "Coupling",
    "Invariants",
    "Recipes",
    "Tests",
    "Known Hazards",
];
/** The `###` headings `Known Hazards` may hold, in order. */
export const HAZARD_HEADINGS = ["Issues", "Limitations", "Gotchas"];

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEPARATOR = /^\|[\s:|-]*-[\s:|-]*$/;
const LABEL = /\b(?:Slice|Phase|Stop) [0-9A-Z]|docs\/plan\//g;
/**
 * `[text](dest "title")`, or an image: the text may nest brackets once, a bare destination may hold balanced ().
 * An escaped `\[` opens no link.
 */
const INLINE_LINK =
    /(?<!\\)(!?)\[((?:[^[\]]|\[[^[\]]*\])*)\]\([ \t]*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*\)/g;

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
/** The contents of the code spans in `text`, in order. */
export function codeSpans(text) {
    const spans = [];
    replaceCodeSpans(text, (content) => {
        spans.push(content);
        return "";
    });
    return spans;
}
/** `text` as prose: code spans and link destinations are not prose. */
const proseText = (text) => stripCodeSpans(text).replace(INLINE_LINK, "$2");

/** The fence `text` opens, or null. A backtick fence's info string holds no backtick. */
function fenceOpened(text) {
    const opener = FENCE.exec(text);
    return opener && !(opener[1][0] === "`" && opener[2].includes("`")) ? opener[1] : null;
}

/**
 * One Markdown file as `{ bytes, segments, sections }`. A segment is `{ kind, line, text }`, with
 * `level` on a heading: kinds `heading`, `item`, `row`, `paragraph`. A row's text has each run of
 * whitespace collapsed to one space, so column padding is not measured. A section is one heading of any
 * level: `{ level, heading, line, bytes, ownBytes }`, where `bytes` runs to the next heading of
 * the same or a higher level and `ownBytes` to the next heading of any level. Fenced code is opaque.
 * A line starting with `|` is a row only in a table, so a wrapped item can continue on one.
 */
export function parseGuide(text) {
    const segments = [];
    const headings = [];
    /** The list items a following line can still continue, outermost first. */
    let openItems = [];
    let paragraph = null;
    /** Whether the previous line was item text, so a plain line continues it whatever its indentation. */
    let lazy = false;
    /** Whether the previous line was a table row or separator. */
    let inTable = false;
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
        const wasTable = inTable;
        inTable = false;
        if (line === "") {
            paragraph = null;
            continue;
        }
        const indent = raw.search(/\S/);
        const opened = fenceOpened(line);
        if (opened) {
            fence = opened;
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
            // An item opening with a fence has no text of its own: the fence is the rest of the marker line.
            fence = fenceOpened(marker[2] ?? "");
            const segment = { kind: "item", line: index + 1, text: fence ? "" : (marker[2] ?? "").trim() };
            segments.push(segment);
            openItems.push({ indent, segment });
            paragraph = null;
            lazy = fence === null;
            continue;
        }
        if (line.startsWith("|") && (wasTable || TABLE_SEPARATOR.test(lines[index + 1]?.trim() ?? ""))) {
            closeItems(indent);
            paragraph = null;
            inTable = true;
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
    const sections = headings.map((entry, i) => {
        const next = headings.slice(i + 1).find((other) => other.level <= entry.level);
        return {
            level: entry.level,
            heading: entry.heading,
            line: entry.line,
            bytes: startOf(next) - entry.start,
            ownBytes: startOf(headings[i + 1]) - entry.start,
        };
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
    let depth = 0;
    let deepest = 0;
    for (const char of proseText(text)) {
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

/** The repository path a `linkTarget` from `rel` names. */
const linkFile = (rel, target) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(rel), target.file || path.posix.basename(rel)));

/** Why a link from `rel` to `destination` does not resolve, or null when it does (or is not checked). */
function linkProblem(rel, destination, readAnchors) {
    const target = linkTarget(destination);
    if (!target) return null;
    const file = linkFile(rel, target);
    // A path leaving the repository names nothing this checkout holds.
    if (file === ".." || file.startsWith("../")) return "no such file";
    const anchors = readAnchors(file);
    if (!anchors) return "no such file";
    return target.anchor && !anchors.has(target.anchor) ? "no such anchor" : null;
}

export const PATH_SPAN = /^[\w@.{},*/-]+$/;
/** Root directories whose contents are not tracked, so a path under one is not checked. */
export const UNCHECKED_ROOTS = new Set(["node_modules", "dist", ".git", ".claude"]);

/** `pattern` with its `{a,b}` groups expanded, outermost first, in order; a brace group without a comma stays literal. */
export function expandBraces(pattern) {
    const open = pattern.indexOf("{");
    if (open < 0) return [pattern];
    const choices = [];
    let depth = 0;
    let start = open + 1;
    let close = -1;
    for (let i = open; i < pattern.length && close < 0; i++) {
        const char = pattern[i];
        if (char === "{") depth++;
        else if (char === "}" && --depth === 0) close = i;
        else if (char === "," && depth === 1) {
            choices.push(pattern.slice(start, i));
            start = i + 1;
        }
    }
    if (close < 0 || choices.length === 0) return [pattern];
    choices.push(pattern.slice(start, close));
    const head = pattern.slice(0, open);
    const tail = pattern.slice(close + 1);
    return choices.flatMap((choice) => expandBraces(`${head}${choice}${tail}`));
}

/** Whether git ignores `pattern` under `root`: a runtime file a guide may name. False outside a repository. */
function gitIgnores(root, pattern) {
    try {
        execFileSync("git", ["check-ignore", "-q", "--", pattern], { cwd: root, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Why the repository path `span` names under `root` is missing, or null when every expansion exists or is a
 * runtime file git ignores.
 */
function pathProblem(root, span) {
    const wantsDir = span.endsWith("/");
    for (const pattern of expandBraces(wantsDir ? span.slice(0, -1) : span)) {
        const matches = pattern.includes("*")
            ? globSync(pattern, { cwd: root })
            : existsSync(path.join(root, pattern))
              ? [pattern]
              : [];
        if (matches.length === 0) return gitIgnores(root, pattern) ? null : `no such path: ${pattern}`;
        if (wantsDir && !matches.every((match) => statSync(path.join(root, match)).isDirectory())) {
            return `not a directory: ${pattern}`;
        }
    }
    return null;
}

/**
 * Checks the repository paths that code spans name, once each: null for a span that is not a path or whose
 * path exists, else why it is missing. A path is one token of path characters holding a `/`, not starting with
 * one, without `...`, whose first segment is a tracked directory of the root.
 */
function pathChecker(root) {
    const cache = new Map();
    const rootDirs = new Set(
        readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name),
    );
    return (span) => {
        if (!PATH_SPAN.test(span) || !span.includes("/") || span.includes("...") || span.startsWith("/")) return null;
        const first = span.slice(0, span.indexOf("/"));
        if (!rootDirs.has(first) || UNCHECKED_ROOTS.has(first)) return null;
        if (!cache.has(span)) cache.set(span, pathProblem(root, span));
        return cache.get(span);
    };
}

/** Whether a link from `rel` to `destination` names `rel` itself with no anchor. */
function isSelfLink(rel, destination) {
    const target = linkTarget(destination);
    return target !== null && !target.anchor && linkFile(rel, target) === rel;
}

/** How a guide's `##` headings leave `GUIDE_SECTIONS`, as at most one `{ line, message }`, at the first difference. */
function sectionProblems(sections) {
    const found = sections.filter((section) => section.level === 2);
    const size = Math.max(found.length, GUIDE_SECTIONS.length);
    const at = Array.from({ length: size }).findIndex((_, i) => found[i]?.heading !== GUIDE_SECTIONS[i]);
    if (at < 0) return [];
    const expected = GUIDE_SECTIONS[at] ?? "no further section";
    return [
        {
            line: found[at]?.line ?? found.at(-1)?.line ?? 1,
            message: `\`##\` heading ${at + 1} is ${found[at]?.heading ?? "missing"}, expected ${expected}`,
        },
    ];
}

/** The `###` headings under `Known Hazards` outside `HAZARD_HEADINGS`, out of order, or repeated. */
function hazardProblems(sections) {
    const problems = [];
    let inHazards = false;
    let last = -1;
    for (const { level, heading, line } of sections) {
        if (level === 2) {
            inHazards = heading === "Known Hazards";
            last = -1;
        }
        if (!inHazards || level !== 3) continue;
        const rank = HAZARD_HEADINGS.indexOf(heading);
        if (rank < 0) problems.push({ line, message: `${heading} is not one of ${HAZARD_HEADINGS.join(", ")}` });
        else if (rank <= last) problems.push({ line, message: `${heading} is out of order or repeated` });
        else last = rank;
    }
    return problems;
}

function measureFile(root, rel, readAnchors, checkPath) {
    const { bytes, segments, sections } = parseGuide(readFileSync(path.join(root, rel), "utf8"));
    // `STRUCTURE.md` and an area folder's `README.md` are indexes: the budgets, links, and labels apply, the guide
    // outline does not.
    const isGuide = rel !== INDEX_DOC && path.posix.basename(rel) !== "README.md";
    const longItems = [];
    const deepSegments = [];
    const unresolvedLinks = [];
    const missingPaths = [];
    const selfLinks = [];
    const labels = [];
    let maxParenDepth = 0;
    for (const { kind, line, text } of segments) {
        for (const destination of inlineLinks(text)) {
            const reason = linkProblem(rel, destination, readAnchors);
            if (reason) unresolvedLinks.push({ line, target: destination, reason });
            if (isSelfLink(rel, destination)) selfLinks.push({ line, target: destination });
        }
        for (const span of codeSpans(text)) {
            const reason = checkPath(span);
            if (reason) missingPaths.push({ line, span, reason });
        }
        for (const [label] of (isGuide ? text : proseText(text)).matchAll(LABEL)) {
            labels.push({ line, kind, label });
        }
        if (kind !== "heading" && kind !== "paragraph") {
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
        headroom: GUIDE_BYTES_BUDGET - bytes,
        overBudget: bytes > GUIDE_BYTES_BUDGET,
        overTarget: bytes > GUIDE_BYTES_TARGET,
        h3Count: sections.filter((section) => section.level === 3).length,
        sections,
        largestLeaf,
        longItems,
        maxParenDepth,
        deepSegments,
        unresolvedLinks,
        missingPaths,
        sectionProblems: isGuide ? sectionProblems(sections) : [],
        hazardProblems: isGuide ? hazardProblems(sections) : [],
        selfLinks,
        labels,
    };
}

const countKind = (items, kind) => items.filter((item) => item.kind === kind).length;

/**
 * The repository paths git tracks under `root`, plus untracked files it does not ignore, that exist on disk; empty
 * when `root` is not the top of a git work tree.
 */
function trackedPaths(root) {
    try {
        const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
        });
        if (realpathSync(top.trim()) !== realpathSync(root)) return [];
        const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
        const out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 });
        return [...new Set(out.split("\0").filter(Boolean))].filter((rel) => existsSync(path.join(root, rel)));
    } catch {
        return [];
    }
}

/** The `ownership` problems of the manifest under `root`, against its tracked paths and the guides in `guidePaths`. */
function ownershipProblems(root, guidePaths) {
    const file = path.join(root, OWNERSHIP_FILE);
    const text = existsSync(file) ? readFileSync(file, "utf8") : null;
    const names = guidePaths.map((rel) =>
        rel
            .slice(GUIDE_DIR.length + 1)
            .replace(/\.md$/, "")
            .replace(/\/README$/, ""),
    );
    return checkOwnership(text, trackedPaths(root), new Set(names));
}

/**
 * The measurement of the repository at `root`, as plain data: `{ guides, index, ownership, totals }`. `guides`
 * is sorted by path; `index` is `STRUCTURE.md`, which `totals` leaves out except in `treeBytes`; `ownership` is the
 * manifest's `{ line, message }` problems.
 */
export function measureDocs(root) {
    const readAnchors = anchorReader(root);
    const checkPath = pathChecker(root);
    const paths = readdirSync(path.join(root, GUIDE_DIR), { recursive: true })
        .filter((name) => name.endsWith(".md"))
        .map((name) => `${GUIDE_DIR}/${name.split(path.sep).join("/")}`)
        .sort();
    const guides = paths.map((rel) => measureFile(root, rel, readAnchors, checkPath));
    const index = measureFile(root, INDEX_DOC, readAnchors, checkPath);
    const largest = guides
        .filter((guide) => guide.largestLeaf)
        .reduce(
            (best, guide) =>
                best && best.bytes >= guide.largestLeaf.bytes ? best : { ...guide.largestLeaf, path: guide.path },
            null,
        );
    const longItems = guides.flatMap((guide) => guide.longItems);
    const bytes = guides.reduce((sum, guide) => sum + guide.bytes, 0);
    return {
        guides,
        index,
        ownership: ownershipProblems(root, paths),
        totals: {
            guideCount: guides.length,
            bytes,
            treeBytes: bytes + index.bytes,
            h3Count: guides.reduce((sum, guide) => sum + guide.h3Count, 0),
            guidesOverBudget: guides.filter((guide) => guide.overBudget).length,
            guidesOverTarget: guides.filter((guide) => guide.overTarget).length,
            largestLeaf: largest,
            leavesOverTarget: guides.reduce(
                (sum, guide) => sum + guide.sections.filter((section) => section.ownBytes > LEAF_BYTES_TARGET).length,
                0,
            ),
            listItemsOver: countKind(longItems, "item"),
            tableRowsOver: countKind(longItems, "row"),
            deepSegments: guides.reduce((sum, guide) => sum + guide.deepSegments.length, 0),
            unresolvedLinks: guides.reduce((sum, guide) => sum + guide.unresolvedLinks.length, 0),
            missingPaths: guides.reduce((sum, guide) => sum + guide.missingPaths.length, 0),
            sectionProblems: guides.reduce((sum, guide) => sum + guide.sectionProblems.length, 0),
            hazardProblems: guides.reduce((sum, guide) => sum + guide.hazardProblems.length, 0),
            selfLinks: guides.reduce((sum, guide) => sum + guide.selfLinks.length, 0),
            labels: guides.reduce((sum, guide) => sum + guide.labels.length, 0),
        },
    };
}

/**
 * What fails for a `measureDocs` result, as `{ path, line, rule, message }` findings, each file's in rule order,
 * the tree's last. `treeRatchet` stands in for `TREE_BYTES_RATCHET`.
 */
export function checkDocs(measure, { treeRatchet = TREE_BYTES_RATCHET } = {}) {
    const findings = [];
    const add = (file, line, rule, message) => findings.push({ path: file, line, rule, message });
    for (const file of [...measure.guides, measure.index]) {
        if (file.overBudget) {
            add(file.path, 1, "ceiling", `${file.bytes} bytes, budget ${GUIDE_BYTES_BUDGET}, ${-file.headroom} over`);
        }
        for (const { line, heading, ownBytes } of file.sections) {
            if (ownBytes > LEAF_BYTES_BUDGET) {
                const over = ownBytes - LEAF_BYTES_BUDGET;
                add(
                    file.path,
                    line,
                    "leaf",
                    `"${heading}" ${ownBytes} bytes, budget ${LEAF_BYTES_BUDGET}, ${over} over`,
                );
            }
        }
        for (const { line, kind, length } of file.longItems) {
            add(file.path, line, "item", `${kind} ${length} characters, budget ${ITEM_CHARS_BUDGET}`);
        }
        for (const { line, kind, depth } of file.deepSegments) {
            add(file.path, line, "paren-depth", `${kind} depth ${depth}, budget ${PAREN_DEPTH_BUDGET}`);
        }
        for (const { line, message } of file.sectionProblems) add(file.path, line, "sections", message);
        for (const { line, message } of file.hazardProblems) add(file.path, line, "hazards", message);
        for (const { line, target, reason } of file.unresolvedLinks) {
            add(file.path, line, "unresolved-link", `${target} (${reason})`);
        }
        for (const { line, span, reason } of file.missingPaths)
            add(file.path, line, "missing-path", `${span} (${reason})`);
        for (const { line, target } of file.selfLinks) add(file.path, line, "self-link", target);
        for (const { line, kind, label } of file.labels) add(file.path, line, "label", `${kind} ${label}`);
    }
    for (const { line, message } of measure.ownership ?? []) add(OWNERSHIP_FILE, line, "ownership", message);
    const { treeBytes } = measure.totals;
    if (treeBytes > treeRatchet) {
        const over = treeBytes - treeRatchet;
        add(
            INDEX_DOC,
            1,
            "tree",
            `${treeBytes} bytes in the guides and ${INDEX_DOC}, ratchet ${treeRatchet}, ${over} over ` +
                `(the ratchet rule: ${GUIDE_DIR}/README.md)`,
        );
    }
    return findings;
}

/**
 * What is over a target but within its budget, as `near` warnings in the shape of `checkDocs` findings, each
 * with the bytes left under the budget. A file or heading over its budget has a finding instead.
 */
export function nearTarget(measure) {
    const warnings = [];
    const add = (file, line, message) => warnings.push({ path: file, line, rule: "near", message });
    for (const file of [...measure.guides, measure.index]) {
        if (file.overTarget && !file.overBudget) {
            add(file.path, 1, `${file.bytes} bytes, target ${GUIDE_BYTES_TARGET}, ${file.headroom} under the budget`);
        }
        for (const { line, heading, ownBytes } of file.sections) {
            if (ownBytes > LEAF_BYTES_TARGET && ownBytes <= LEAF_BYTES_BUDGET) {
                const left = LEAF_BYTES_BUDGET - ownBytes;
                add(
                    file.path,
                    line,
                    `"${heading}" ${ownBytes} bytes, target ${LEAF_BYTES_TARGET}, ${left} under the budget`,
                );
            }
        }
    }
    return warnings;
}

/**
 * What the check prints for `checkDocs` findings and `nearTarget` warnings: the warnings never fail it. `tree`
 * (`{ bytes, ratchet }`) adds the tree total to the verdict, so a trim sees how far the ratchet can come down.
 */
export function formatCheck(findings, warnings = [], tree = null) {
    const lines = [...findings, ...warnings].map(
        ({ path: file, line, rule, message }) => `${file}:${line} ${rule} ${message}`,
    );
    const near = warnings.length > 0 ? `, ${warnings.length} near the budget` : "";
    const total = tree ? `, tree ${tree.bytes} of ${tree.ratchet}` : "";
    const verdict = findings.length > 0 ? `FAIL: ${findings.length} finding(s)${near}${total}` : `OK${near}${total}`;
    return `${[...lines, `[check:docs] ${verdict}`].join("\n")}\n`;
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
        guide.headroom,
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
        "headroom",
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
            .filter((section) => section.level >= 2 && section.level <= 3)
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
    findings(
        "Missing paths",
        (file) => file.missingPaths,
        ({ line, span, reason }) => `${line} ${span} (${reason})`,
    );
    findings(
        "Section order",
        (file) => file.sectionProblems,
        ({ line, message }) => `${line} ${message}`,
    );
    findings(
        "Hazard headings",
        (file) => file.hazardProblems,
        ({ line, message }) => `${line} ${message}`,
    );
    findings(
        "Self-links",
        (file) => file.selfLinks,
        ({ line, target }) => `${line} ${target}`,
    );
    findings(
        "Labels",
        (file) => file.labels,
        ({ line, kind, label }) => `${line} ${kind} ${label}`,
    );

    const ownership = measure.ownership ?? [];
    lines.push(
        `[check:docs] Ownership: ${ownership.length}`,
        ...ownership.map(({ line, message }) => `  ${OWNERSHIP_FILE}:${line} ${message}`),
        "",
    );

    const leaf = totals.largestLeaf;
    lines.push(
        `[check:docs] Totals (guides only, ${INDEX_DOC} excluded)`,
        `[check:docs] guides: ${totals.guideCount}`,
        `[check:docs] total bytes: ${totals.bytes}`,
        `[check:docs] ### headings: ${totals.h3Count}`,
        `[check:docs] guides over ${GUIDE_BYTES_BUDGET} bytes: ${totals.guidesOverBudget}`,
        `[check:docs] guides over ${GUIDE_BYTES_TARGET} bytes, the target: ${totals.guidesOverTarget}`,
        `[check:docs] largest leaf: ${leaf ? `${leaf.bytes} bytes, ${leaf.path} "${leaf.heading}"` : "none"}`,
        `[check:docs] leaves over ${LEAF_BYTES_TARGET} bytes, the target: ${totals.leavesOverTarget}`,
        `[check:docs] list items over ${ITEM_CHARS_BUDGET}: ${totals.listItemsOver}`,
        `[check:docs] table rows over ${ITEM_CHARS_BUDGET}: ${totals.tableRowsOver}`,
        `[check:docs] items over ${ITEM_CHARS_BUDGET}, both kinds: ${totals.listItemsOver + totals.tableRowsOver}`,
        `[check:docs] segments above depth ${PAREN_DEPTH_BUDGET}: ${totals.deepSegments}`,
        `[check:docs] unresolved links: ${totals.unresolvedLinks}`,
        `[check:docs] missing paths: ${totals.missingPaths}`,
        `[check:docs] tree bytes, ${INDEX_DOC} included: ${totals.treeBytes} (ratchet ${TREE_BYTES_RATCHET})`,
        `[check:docs] section order problems: ${totals.sectionProblems}`,
        `[check:docs] hazard heading problems: ${totals.hazardProblems}`,
        `[check:docs] self-links: ${totals.selfLinks}`,
        `[check:docs] labels: ${totals.labels}`,
    );
    return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--report")) {
        process.stderr.write("usage: node util/docsBudget.mjs [--report]\n");
        process.exit(2);
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const measure = measureDocs(root);
    if (args.length > 0) {
        process.stdout.write(formatReport(measure));
    } else {
        const findings = checkDocs(measure);
        const tree = { bytes: measure.totals.treeBytes, ratchet: TREE_BYTES_RATCHET };
        const output = formatCheck(findings, nearTarget(measure), tree);
        (findings.length > 0 ? process.stderr : process.stdout).write(output);
        if (findings.length > 0) process.exitCode = 1;
    }
}
