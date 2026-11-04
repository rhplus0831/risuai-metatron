// `pnpm docs:reads [--out <file>] [<dir>...]`: a one-off measurement of how agents read the guides, from local
// Claude Code session transcripts. It streams every `*.jsonl` under each directory (default
// `~/.claude/projects/-home-codex-risuai-metatron/`; sub-agent transcripts sit in `<session>/subagents/`), parses only
// lines that mention a guide or the reader, and counts each assistant `tool_use` once by its id (a forked session
// copies its parent's history into a new file). The Markdown report goes to `--out` or stdout and holds only counts,
// guide names, and the guides' own headings: no session ids or paths, commands, prompts, or other transcript text.
//   - A guide is `docs/structure/<name>.md` (`<area>/README.md` is the area `<area>`) or `STRUCTURE.md`, under any
//     checkout path.
//   - Per guide: `Read` calls without `offset` and `limit` (whole), `Read` calls with either (ranged), Bash commands
//     naming the guide's path (heredoc bodies stripped first, so a file written through `cat <<EOF` is not counted;
//     a command counted as a `docs:read` of that guide is not counted again as Bash), of which `sed -n`: the Bash
//     commands holding at least one `sed -n` range read of the guide (always a subset), and `docs:read` invocations
//     (`pnpm [--silent] docs:read <guide> [heading]`, `node util/docsRead.mjs ...`).
//   - Per heading: a ranged Read covers lines [offset, offset + limit) (no offset: from line 1; no limit: to the end),
//     a Bash `sed -n 'A,Bp' <guide>` covers [A, B] (one command's ranges of a guide count together, once per
//     heading), and each range counts once for every leaf heading whose own lines
//     (heading line to the next heading of any level) it intersects; lines before the first heading count as
//     `(before the first heading)`. A `docs:read <guide> <heading>` counts for the heading `sectionText` resolves;
//     a query matching no heading or several is counted as unresolved and its text dropped. Whole-file Reads are not
//     spread over headings.
//   - Line numbers map against the guide as it was then: the text at `git rev-list -1 --before=<timestamp>
//     refs/heads/dev` (emulated over one `git log` listing), cached per revision and path. A guide missing there
//     counts under its name with the heading unmapped.
//   - A heading of the current guide (on disk) is untouched when no range touched it or a heading under it, no
//     `docs:read` named it or a heading above it, and it is not in the per-heading counts.
// The count misses reads by Codex and Luna workers (their transcripts are elsewhere), `rg`/`grep` hits printed from
// a guide, and Bash reads other than `sed -n` ranges, which count per guide but not per heading.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUIDE_DIR, INDEX_DOC, parseGuide } from "./docsBudget.mjs";
import { sectionText } from "./docsRead.mjs";

/** The transcript directory read when none is given. */
export const DEFAULT_DIRS = [path.join(os.homedir(), ".claude/projects/-home-codex-risuai-metatron")];
/** A transcript line can matter only when it holds one of these. */
export const LINE_MARKERS = ["docs/structure", "STRUCTURE", "docs:read", "docsRead"];
/** The name `STRUCTURE.md` is counted under. */
export const INDEX_NAME = "STRUCTURE";
/** The heading label of lines before a guide's first heading. */
export const PREAMBLE = "(before the first heading)";

/** A guide path inside a command: not glued to a longer name before it or after it. */
const GUIDE_PATH = /(?<![\w.-])(docs\/structure\/(?:[\w-]+\/)*[\w-]+\.md|STRUCTURE\.md)(?![\w/-]|\.\w)/g;
/** A guide name as `docs:read` takes it: lowercase words and dashes, one optional area folder. */
const GUIDE_NAME = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/;

/** A guide's name from a repository or absolute path (`chat-store`, `structured-memory`, `STRUCTURE`), or null. */
export function guideOfPath(file) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized === INDEX_DOC || normalized.endsWith(`/${INDEX_DOC}`)) {
        return normalized.includes(`${GUIDE_DIR}/`) ? null : INDEX_NAME;
    }
    const match = /(?:^|\/)docs\/structure\/(.+)\.md$/.exec(normalized);
    return match ? match[1].replace(/\/README$/, "") : null;
}

/** The repository paths a guide name may live at, in the order `resolveGuide` tries them. */
export function guidePaths(name) {
    return name === INDEX_NAME ? [INDEX_DOC] : [`${GUIDE_DIR}/${name}.md`, `${GUIDE_DIR}/${name}/README.md`];
}

/** `command` without its heredoc bodies: the lines after a `<<WORD` operator through the line holding only `WORD`. */
export function stripHeredocs(command) {
    const lines = command.split("\n");
    const out = [];
    const pending = [];
    for (const line of lines) {
        if (pending.length > 0) {
            if (line.replace(/^\t+/, "").trim() === pending[0]) pending.shift();
            continue;
        }
        out.push(line);
        for (const match of line.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) pending.push(match[2]);
    }
    return out.join("\n");
}

/** The words of a shell fragment up to its first unquoted operator (`|`, `;`, `&`, `<`, `>`, newline), unquoted. */
export function shellWords(text) {
    const words = [];
    let word = null;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = null;
            else if (char === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
            else word += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            word ??= "";
        } else if (char === "\\" && i + 1 < text.length) {
            word = (word ?? "") + text[++i];
        } else if (/\s/.test(char)) {
            if (char === "\n") break;
            if (word !== null) words.push(word);
            word = null;
        } else if (/[|;&<>]/.test(char)) {
            // `2>&1` and friends: a digit run glued to the operator belongs to it.
            if (word !== null && !/^\d+$/.test(word)) words.push(word);
            word = null;
            break;
        } else {
            word = (word ?? "") + char;
        }
    }
    if (word !== null) words.push(word);
    return words;
}

/**
 * The guide name a `docs:read` argument names (a name, an area or its README, `STRUCTURE`, or a path), or null.
 * Bare `README` names the guides index; `README.md` names the repository README and is not a guide.
 */
export function guideOfArgument(argument) {
    const stripped = argument.replace(/^\.\//, "").replace(/\/$/, "");
    const fromPath = guideOfPath(stripped);
    if (fromPath) return fromPath;
    const name = stripped.replace(/\.md$/, "");
    if (name === INDEX_NAME || stripped === "README") return name;
    const guide = name.replace(/^([^/]+)\/README$/, "$1");
    return GUIDE_NAME.test(guide) ? guide : null;
}

const DOCS_READ =
    /(?:\bpnpm(?:\s+(?:--silent|-s|--dir\s+\S+|-C\s+\S+))*\s+(?:run\s+)?docs:read|\bnode\s+(?:\S*\/)?util\/docsRead\.mjs)(?=\s|$)/g;

/**
 * The `docs:read` invocations in a Bash command: `{ guide, heading }` each, `heading` the query text or null for an
 * outline, `guide` null when the argument names no guide (a placeholder or a variable).
 */
export function docsReadCalls(command) {
    const calls = [];
    for (const match of command.matchAll(DOCS_READ)) {
        const [guide, ...rest] = shellWords(command.slice(match.index + match[0].length));
        if (guide === undefined) continue;
        calls.push({ guide: guideOfArgument(guide), heading: rest.length > 0 ? rest.join(" ") : null });
    }
    return calls;
}

/** The guides a Bash command names by path, each once. */
export function bashGuides(command) {
    const guides = new Set();
    for (const match of command.matchAll(GUIDE_PATH)) {
        const guide = guideOfPath(match[1]);
        if (guide) guides.add(guide);
    }
    return [...guides];
}

/** The `sed -n` print ranges a Bash command applies to a guide: `{ guide, ranges }`, each range `[first, last]`. */
export function sedRanges(command) {
    const found = [];
    for (const match of command.matchAll(/\bsed\s+(?:-[nE]+\s+)*-n\s+/g)) {
        const words = shellWords(command.slice(match.index + match[0].length));
        const [script, ...files] = words;
        if (!script || !/^[\d,;p\s$]+$/.test(script)) continue;
        const ranges = [];
        for (const part of script.split(";")) {
            const range = /^\s*(\d+)(?:,(\d+|\$))?p\s*$/.exec(part);
            if (!range) continue;
            const first = Number(range[1]);
            ranges.push([first, range[2] === undefined ? first : range[2] === "$" ? Infinity : Number(range[2])]);
        }
        if (ranges.length === 0) continue;
        for (const file of files) {
            const guide = guideOfPath(file);
            if (guide) found.push({ guide, ranges });
        }
    }
    return found;
}

/**
 * What one assistant `tool_use` block does to the guides, as events: `{ kind, guide, ranges?, heading? }`, `kind`
 * one of `whole`, `ranged`, `bash`, `docsRead`; `ranges` (lines, inclusive) on a ranged Read or a `sed` read;
 * `heading` the query of a `docs:read` (null for an outline). A `docs:read` naming no guide is `{ kind: "docsRead",
 * guide: null }`.
 */
export function guideEvents(block) {
    const input = block.input ?? {};
    if (block.name === "Read" && typeof input.file_path === "string") {
        const guide = guideOfPath(input.file_path);
        if (!guide) return [];
        if (input.offset === undefined && input.limit === undefined) return [{ kind: "whole", guide }];
        const first = Math.max(1, Number(input.offset ?? 1) || 1);
        const last = input.limit === undefined ? Infinity : first + Number(input.limit) - 1;
        return [{ kind: "ranged", guide, ranges: [[first, last]] }];
    }
    if (block.name !== "Bash" || typeof input.command !== "string") return [];
    const command = stripHeredocs(input.command);
    const events = [];
    const viaReader = new Set();
    for (const call of docsReadCalls(command)) {
        events.push({ kind: "docsRead", guide: call.guide, heading: call.heading });
        if (call.guide) viaReader.add(call.guide);
    }
    // One `sed` event per guide per command, holding all its ranges, so `sed -n` stays a subset of Bash and each
    // heading counts once per command; a guide the command reads through the reader changes neither count.
    const sedByGuide = new Map();
    for (const { guide, ranges } of sedRanges(command)) {
        if (viaReader.has(guide)) continue;
        sedByGuide.set(guide, [...(sedByGuide.get(guide) ?? []), ...ranges]);
    }
    for (const guide of new Set([...bashGuides(command), ...sedByGuide.keys()])) {
        if (viaReader.has(guide)) continue;
        events.push({ kind: "bash", guide });
    }
    for (const [guide, ranges] of sedByGuide) events.push({ kind: "sed", guide, ranges });
    return events;
}

/**
 * The headings of a guide's text as `{ label, level, line, end }`: `label` the heading chain below the `#` title
 * (`Files > Readers`; the title is its own text), `end` the last line of its own text, before the next heading of
 * any level.
 */
export function headingLines(text) {
    const { sections } = parseGuide(text);
    const total = text.split("\n").length;
    const chain = [];
    return sections.map((section, i) => {
        while (chain.length > 0 && chain.at(-1).level >= section.level) chain.pop();
        chain.push(section);
        const below = chain.filter((entry) => entry.level > 1);
        return {
            label: (below.length > 0 ? below : chain).map((entry) => entry.heading).join(" > "),
            level: section.level,
            line: section.line,
            end: (sections[i + 1]?.line ?? total + 1) - 1,
        };
    });
}

/** The heading labels whose own lines a range `[first, last]` intersects, in order; `PREAMBLE` for earlier lines. */
export function headingsTouched(headings, [first, last]) {
    const touched = [];
    if (first < (headings[0]?.line ?? Infinity)) touched.push(PREAMBLE);
    for (const heading of headings) {
        if (heading.line <= last && heading.end >= first) touched.push(heading.label);
    }
    return touched;
}

/** Labels at or under `label` (a heading chain) among `headings`. */
const under = (headings, label) => headings.filter((h) => h.label === label || h.label.startsWith(`${label} > `));

/** An empty tally, filled by `countEvent`. */
export function emptyTally() {
    return { guides: new Map(), unresolvedGuide: 0, first: null, last: null };
}

function guideStats(tally, guide) {
    if (!tally.guides.has(guide)) {
        tally.guides.set(guide, {
            whole: 0,
            ranged: 0,
            bash: 0,
            sed: 0,
            docsRead: 0,
            outline: 0,
            unmapped: 0,
            unresolved: 0,
            headings: new Map(),
            covered: new Set(),
        });
    }
    return tally.guides.get(guide);
}

function bump(stats, label, field) {
    if (!stats.headings.has(label)) stats.headings.set(label, { ranges: 0, docsRead: 0 });
    stats.headings.get(label)[field]++;
}

/**
 * Adds one event to `tally`. `guideText` is the guide's text at the event's time, or null when the guide did not
 * exist then (its ranges and headings count as unmapped). `timestamp` widens the covered span.
 */
export function countEvent(tally, event, guideText, timestamp) {
    if (event.kind === "docsRead" && (!event.guide || event.unknown)) {
        tally.unresolvedGuide++;
        return;
    }
    if (timestamp) {
        if (!tally.first || timestamp < tally.first) tally.first = timestamp;
        if (!tally.last || timestamp > tally.last) tally.last = timestamp;
    }
    const stats = guideStats(tally, event.guide);
    stats[event.kind]++;
    const mappable = event.kind === "ranged" || event.kind === "sed" || (event.kind === "docsRead" && event.heading);
    if (!mappable) {
        if (event.kind === "docsRead") stats.outline++;
        return;
    }
    if (guideText === null) {
        stats.unmapped++;
        return;
    }
    const headings = headingLines(guideText);
    if (event.kind === "docsRead") {
        let section;
        try {
            ({ section } = sectionText(guideText, event.heading));
        } catch {
            stats.unresolved++;
            return;
        }
        const label = headings.find((h) => h.line === section.line).label;
        bump(stats, label, "docsRead");
        // The reader prints the section through its subsections; the headings above it are its context.
        for (const h of under(headings, label)) stats.covered.add(h.label);
        for (const h of headings) if (label.startsWith(`${h.label} > `)) stats.covered.add(h.label);
        return;
    }
    const labels = new Set(event.ranges.flatMap((range) => headingsTouched(headings, range)));
    for (const label of labels) {
        bump(stats, label, "ranges");
        stats.covered.add(label);
        for (const h of headings) if (label.startsWith(`${h.label} > `)) stats.covered.add(h.label);
    }
}

const pct = (part, whole) => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`);
const cell = (text) => String(text).replace(/\|/g, "\\|");

/**
 * The Markdown report of a tally. `meta` is `{ date, files, dirs }`: the report date, the transcript files scanned,
 * and how many directories held them. `current(guide)` is the guide's text now, or null when it is gone.
 */
export function formatReport(tally, { date, files, dirs }, current) {
    const names = [...tally.guides.keys()].sort((a, b) =>
        a === INDEX_NAME ? -1 : b === INDEX_NAME ? 1 : a.localeCompare(b),
    );
    const total = { whole: 0, ranged: 0, bash: 0, sed: 0, docsRead: 0 };
    for (const stats of tally.guides.values()) for (const key of Object.keys(total)) total[key] += stats[key];
    const span = tally.first ? `${tally.first.slice(0, 10)} to ${tally.last.slice(0, 10)}` : "no guide reads found";
    const out = [
        `# Guide Reads ${date}`,
        "",
        `Scanned ${files} transcript files in ${dirs} ${dirs === 1 ? "directory" : "directories"} of local Claude Code`,
        `sessions (sub-agent transcripts included); the counted guide reads span ${span}. Each tool call counts once by its`,
        "id, so a forked session's copied history is not counted twice. Method and contract: the header comment of",
        "`util/guideReads.mjs`. Undercount: reads by Codex and Luna workers are not in these transcripts, and `rg` or",
        "`grep` output from a guide, like any Bash read but a `sed -n` range, counts per guide but not per heading.",
        "",
        "## Per guide",
        "",
        "| Guide | Whole-file Reads | Ranged Reads | Bash | of which `sed -n` | docs:read |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        ...names.map((name) => {
            const s = tally.guides.get(name);
            return `| ${cell(name)} | ${s.whole} | ${s.ranged} | ${s.bash} | ${s.sed} | ${s.docsRead} |`;
        }),
        `| **all** | ${total.whole} | ${total.ranged} | ${total.bash} | ${total.sed} | ${total.docsRead} |`,
        "",
        "Bash counts every command naming the guide's path, writes and `git` commands included; `sed -n` is the",
        "part that prints a line range.",
        "",
        `Whole-file share of guide Reads: ${pct(total.whole, total.whole + total.ranged)} (${total.whole} of ${
            total.whole + total.ranged
        }); the Agent Read Protocol asks for section reads instead.`,
    ];
    if (tally.unresolvedGuide > 0) {
        out.push(
            "",
            `${tally.unresolvedGuide} \`docs:read\` calls named no guide (a placeholder, a variable, or a typo).`,
        );
    }
    out.push("", "## Per heading");
    for (const name of names) {
        const s = tally.guides.get(name);
        out.push("", `### ${name}`, "");
        const notes = [];
        if (s.outline > 0) notes.push(`${s.outline} outline \`docs:read\` calls`);
        if (s.unresolved > 0) notes.push(`${s.unresolved} \`docs:read\` queries matching no heading or several`);
        if (s.unmapped > 0) notes.push(`${s.unmapped} reads of a revision without the guide (unmapped)`);
        if (notes.length > 0) out.push(`${notes.join("; ")}.`, "");
        const rows = [...s.headings].sort((a, b) => b[1].ranges + b[1].docsRead - (a[1].ranges + a[1].docsRead));
        if (rows.length === 0) out.push("No heading-level reads.");
        else {
            out.push("| Heading | Ranges (Read, `sed -n`) | docs:read |", "| --- | ---: | ---: |");
            for (const [label, counts] of rows) out.push(`| ${cell(label)} | ${counts.ranges} | ${counts.docsRead} |`);
        }
        const text = current(name);
        if (text === null) {
            out.push("", "The guide is gone from the current tree.");
            continue;
        }
        const untouched = headingLines(text)
            .filter((h) => h.level === 2 || h.level === 3)
            .filter((h) => !s.covered.has(h.label));
        out.push(
            "",
            untouched.length === 0
                ? "Every current `##`/`###` heading was touched."
                : `Current \`##\`/\`###\` headings no read touched: ${untouched.map((h) => cell(h.label)).join("; ")}.`,
        );
    }
    return `${out.join("\n")}\n`;
}

/** The `*.jsonl` files under `dir`, recursively, sorted. */
export function transcriptFiles(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort();
}

/**
 * The guide text reader over `refs/heads/dev` under `root`: `textAt(timestamp, guide)` is the guide's text at the
 * last dev commit at or before the timestamp, or null (no such commit, or no guide there). One `git log` lists the
 * commits; each revision and path is read once.
 */
export function devReader(root, ref = "refs/heads/dev") {
    const commits = execFileSync("git", ["log", "--format=%H %ct", ref], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 28,
    })
        .trim()
        .split("\n")
        .map((line) => {
            const [hash, time] = line.split(" ");
            return { hash, time: Number(time) };
        });
    const revisions = new Map();
    const texts = new Map();
    const revisionAt = (timestamp) => {
        const seconds = Math.floor(Date.parse(timestamp) / 1000);
        if (!revisions.has(seconds)) revisions.set(seconds, commits.find((c) => c.time <= seconds)?.hash ?? null);
        return revisions.get(seconds);
    };
    const show = (rev, rel) => {
        const key = `${rev}:${rel}`;
        if (!texts.has(key)) {
            let text = null;
            try {
                text = execFileSync("git", ["show", key], {
                    cwd: root,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                    maxBuffer: 1 << 26,
                });
            } catch {
                text = null;
            }
            texts.set(key, text);
        }
        return texts.get(key);
    };
    return (timestamp, guide) => {
        const rev = timestamp ? revisionAt(timestamp) : null;
        if (!rev) return null;
        for (const rel of guidePaths(guide)) {
            const text = show(rev, rel);
            if (text !== null) return text;
        }
        return null;
    };
}

/**
 * Streams the transcripts and counts their guide reads: `{ tally, files }`. `textAt(timestamp, guide)` reads a guide
 * as it was (see `devReader`); `known(guide)` says whether a guide of that name exists now.
 */
export async function scanTranscripts(dirs, textAt, known = () => true) {
    const tally = emptyTally();
    const seen = new Set();
    const files = dirs.flatMap(transcriptFiles);
    for (const file of files) {
        const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!LINE_MARKERS.some((marker) => line.includes(marker))) continue;
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            if (record?.type !== "assistant" || !Array.isArray(record.message?.content)) continue;
            for (const block of record.message.content) {
                if (block?.type !== "tool_use" || !block.id || seen.has(block.id)) continue;
                seen.add(block.id);
                for (const event of guideEvents(block)) {
                    const reader = event.kind === "docsRead" && event.guide;
                    const mappable = event.guide && (event.ranges || (reader && event.heading));
                    const text = mappable || reader ? textAt(record.timestamp, event.guide) : null;
                    // A `docs:read` argument is a guide only when such a guide existed then or exists now.
                    if (reader && text === null && !known(event.guide)) event.unknown = true;
                    countEvent(tally, event, text, record.timestamp);
                }
            }
        }
    }
    return { tally, files: files.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const args = process.argv.slice(2);
    let out = null;
    const dirs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--out" && args[i + 1]) out = args[++i];
        else if (args[i].startsWith("--out=")) out = args[i].slice("--out=".length);
        else if (args[i].startsWith("-")) {
            process.stderr.write("usage: pnpm docs:reads [--out <file>] [<transcript dir>...]\n");
            process.exit(2);
        } else dirs.push(args[i]);
    }
    const scanned = dirs.length > 0 ? dirs : DEFAULT_DIRS;
    const current = (guide) => {
        for (const rel of guidePaths(guide)) {
            const file = path.join(root, rel);
            if (existsSync(file)) return readFileSync(file, "utf8");
        }
        return null;
    };
    const { tally, files } = await scanTranscripts(scanned, devReader(root), (guide) => current(guide) !== null);
    const date = new Date().toISOString().slice(0, 10);
    const report = formatReport(tally, { date, files, dirs: scanned.length }, current);
    if (out) writeFileSync(out, report);
    else process.stdout.write(report);
}
