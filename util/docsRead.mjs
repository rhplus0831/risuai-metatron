// `pnpm docs:read <guide> [heading...]`: the guide reader of the Agent Read Protocol. With a guide alone it prints the
// guide's headings with their bytes, so the next read can be sections instead of the file; with a heading it prints
// that section through its subsections. The guide is a name (`chat-store`, `structured-memory/read`), an area folder
// (`structured-memory`, its `README.md`), `STRUCTURE`, or a path. `README` and `README.md` (also with `./`) name Doc
// Maintenance. Headings and queries ignore backticks and case, matching whole text, then prefix, then substring;
// several matches list themselves instead of printing one.
// The heading arguments joined by spaces are one query, so a heading of several words needs no quotes. When that
// matches no heading and there are several arguments, each argument is a heading of its own (quote one of several
// words): the sections found print in document order, and an argument naming no single heading gets a warning on
// stderr, before the sections, with exit code 2.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUIDE_DIR, INDEX_DOC, parseGuide } from "./docsBudget.mjs";

/** The repository path `name` names, or null: README aliases name Doc Maintenance; otherwise paths come first. */
export function resolveGuide(root, name) {
    if (/^(?:\.\/)?README(?:\.md)?$/.test(name)) name = `${GUIDE_DIR}/README.md`;
    const stripped = name.replace(/\.md$/, "").replace(/\/$/, "");
    const candidates = [
        name,
        `${GUIDE_DIR}/${stripped}.md`,
        `${GUIDE_DIR}/${stripped}/README.md`,
        ...(stripped === "STRUCTURE" ? [INDEX_DOC] : []),
    ];
    return (
        candidates.find((rel) => {
            const file = path.join(root, rel);
            return existsSync(file) && statSync(file).isFile();
        }) ?? null
    );
}

/** The guide names `resolveGuide` accepts under `root`, sorted: a folder guide as `area/guide`, a folder as `area`. */
export function guideNames(root) {
    return readdirSync(path.join(root, GUIDE_DIR), { recursive: true })
        .filter((rel) => rel.endsWith(".md"))
        .map((rel) =>
            rel
                .split(path.sep)
                .join("/")
                .replace(/\.md$/, "")
                .replace(/\/README$/, ""),
        )
        .sort();
}

/** One line per heading of `text`: the heading as written, then its own bytes and, with subsections, its total. */
export function outline(text) {
    return parseGuide(text).sections.map(({ level, heading, bytes, ownBytes }) => {
        const size = bytes === ownBytes ? `${ownBytes} bytes` : `${ownBytes} bytes, ${bytes} with subsections`;
        return `${"#".repeat(level)} ${heading}  (${size})`;
    });
}

const plain = (heading) => heading.replace(/`/g, "").toLowerCase();
const headingLine = (section) => `${"#".repeat(section.level)} ${section.heading}`;

/** The headings among `sections` that `query` names: by whole text, else by prefix, else by substring. */
function headingMatches(sections, query) {
    const wanted = plain(query.trim());
    return (
        [
            sections.filter((section) => plain(section.heading) === wanted),
            sections.filter((section) => plain(section.heading).startsWith(wanted)),
            sections.filter((section) => plain(section.heading).includes(wanted)),
        ].find((found) => found.length > 0) ?? []
    );
}

/** Why `query` names no single heading: `matches` when it names several, else every heading of `sections`. */
function missMessage(query, matches, sections) {
    const names = (matches.length > 0 ? matches : sections).map((section) => `  ${headingLine(section)}`).join("\n");
    const problem = matches.length > 0 ? `matches ${matches.length} headings` : "matches no heading";
    return `"${query}" ${problem}:\n${names}`;
}

/** The text of `section`, one of `sections` of `text`, running to the next heading of the same or a higher level. */
function sectionBody(text, sections, section) {
    const next = sections.slice(sections.indexOf(section) + 1).find((other) => other.level <= section.level);
    const lines = text.split("\n");
    return lines
        .slice(section.line - 1, next ? next.line - 1 : lines.length)
        .join("\n")
        .trimEnd();
}

/**
 * The section of `text` that `query` names: `{ section, text }`, the text running to the next heading of the same
 * or a higher level. Throws, naming the candidates, when the query matches none or several headings.
 */
export function sectionText(text, query) {
    const { sections } = parseGuide(text);
    const matches = headingMatches(sections, query);
    if (matches.length !== 1) throw new Error(missMessage(query, matches, sections));
    return { section: matches[0], text: sectionBody(text, sections, matches[0]) };
}

/**
 * The sections of `text` that the heading arguments `queries` name: `{ found, missed }`. The arguments joined by
 * spaces are one query; when that matches no heading and there are several arguments, each argument is a query of
 * its own. `found` holds `{ query, section, text }` as `sectionText` gives them, in argument order; `missed` holds
 * `{ query, matches }`, `matches` the several headings the query names, or none.
 */
export function sectionTexts(text, queries) {
    const { sections } = parseGuide(text);
    const joined = queries.join(" ");
    const each = queries.length > 1 && headingMatches(sections, joined).length === 0 ? queries : [joined];
    const found = [];
    const missed = [];
    for (const query of each) {
        const matches = headingMatches(sections, query);
        if (matches.length === 1) {
            found.push({ query, section: matches[0], text: sectionBody(text, sections, matches[0]) });
        } else {
            missed.push({ query, matches });
        }
    }
    return { found, missed };
}

/**
 * What `docs:read <guide> <heading>...` prints for the guide at `rel` with text `text`: `{ out, err }`. `out` holds
 * each section `sectionTexts` found under a `<rel>:<line>` line, in document order, a section inside another printed
 * one left out. `err` is empty when every query named one heading; otherwise it names each query that did not, with
 * the candidates, and for several queries says how many sections are missing and that a query may be a typo.
 */
export function sectionReport(rel, text, queries) {
    const { found, missed } = sectionTexts(text, queries);
    const printed = [];
    for (const entry of found.toSorted((a, b) => a.section.line - b.section.line)) {
        const last = printed.at(-1);
        if (last && entry.section.line < last.section.line + last.text.split("\n").length) continue;
        printed.push(entry);
    }
    const out = printed.map((entry) => `${rel}:${entry.section.line}\n${entry.text}\n`).join("\n");
    if (missed.length === 0) return { out, err: "" };
    const { sections } = parseGuide(text);
    const total = found.length + missed.length;
    if (total === 1) return { out, err: `${missMessage(missed[0].query, missed[0].matches, sections)}\n` };
    const rest = found.length > 0 ? `the other ${found.length} follow` : "nothing is printed";
    const lines = [
        `warning: ${missed.length} of ${total} headings name no single section (a typo?); ${rest}.`,
        `Each argument was read as a heading of its own, since "${queries.join(" ")}" matches no heading.`,
    ];
    for (const { query, matches } of missed) {
        if (matches.length === 0) lines.push(`  "${query}" matches no heading`);
        else
            lines.push(
                `  "${query}" matches ${matches.length} headings:`,
                ...matches.map((s) => `    ${headingLine(s)}`),
            );
    }
    if (missed.some(({ matches }) => matches.length === 0)) {
        lines.push(`headings of ${rel}:`, ...sections.map((section) => `  ${headingLine(section)}`));
    }
    return { out, err: `${lines.join("\n")}\n` };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const [name, ...rest] = process.argv.slice(2);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (!name) {
        process.stderr.write(`usage: pnpm docs:read <guide> [heading...]\nguides:\n${guideNames(root).join("\n")}\n`);
        process.exit(2);
    }
    const rel = resolveGuide(root, name);
    if (!rel) {
        process.stderr.write(`no guide named ${name}; one of:\n${guideNames(root).join("\n")}\n`);
        process.exit(2);
    }
    const text = readFileSync(path.join(root, rel), "utf8");
    if (rest.length === 0) {
        process.stdout.write(`${rel} (${Buffer.byteLength(text)} bytes)\n${outline(text).join("\n")}\n`);
    } else {
        const { out, err } = sectionReport(rel, text, rest);
        process.stderr.write(err);
        process.stdout.write(out);
        if (err) process.exitCode = 2;
    }
}
