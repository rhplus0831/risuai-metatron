// `pnpm docs:read <guide> [heading]`: the guide reader of the Agent Read Protocol. With a guide alone it prints the
// guide's headings with their bytes, so the next read can be one section instead of the file; with a heading it
// prints that section through its subsections. The guide is a name (`chat-store`, `structured-memory/read`), an
// area folder (`structured-memory`, its `README.md`), `STRUCTURE`, or a path. `README` and `README.md` (also with
// `./`) name Doc Maintenance. Headings and queries ignore backticks and case, matching whole text, then prefix,
// then substring; several matches list themselves instead of printing one.
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

/**
 * The section of `text` that `query` names: `{ section, text }`, the text running to the next heading of the same
 * or a higher level. Throws, naming the candidates, when the query matches none or several headings.
 */
export function sectionText(text, query) {
    const { sections } = parseGuide(text);
    const plain = (heading) => heading.replace(/`/g, "").toLowerCase();
    const wanted = plain(query.trim());
    const matches =
        [
            sections.filter((section) => plain(section.heading) === wanted),
            sections.filter((section) => plain(section.heading).startsWith(wanted)),
            sections.filter((section) => plain(section.heading).includes(wanted)),
        ].find((found) => found.length > 0) ?? [];
    if (matches.length !== 1) {
        const list = matches.length > 0 ? matches : sections;
        const names = list.map((section) => `  ${"#".repeat(section.level)} ${section.heading}`).join("\n");
        const problem = matches.length > 0 ? `matches ${matches.length} headings` : "matches no heading";
        throw new Error(`"${query}" ${problem}:\n${names}`);
    }
    const [section] = matches;
    const index = sections.indexOf(section);
    const next = sections.slice(index + 1).find((other) => other.level <= section.level);
    const lines = text.split("\n");
    return {
        section,
        text: lines
            .slice(section.line - 1, next ? next.line - 1 : lines.length)
            .join("\n")
            .trimEnd(),
    };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const [name, ...rest] = process.argv.slice(2);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (!name) {
        process.stderr.write(`usage: pnpm docs:read <guide> [heading]\nguides:\n${guideNames(root).join("\n")}\n`);
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
        try {
            const { section, text: body } = sectionText(text, rest.join(" "));
            process.stdout.write(`${rel}:${section.line}\n${body}\n`);
        } catch (error) {
            process.stderr.write(`${error.message}\n`);
            process.exit(2);
        }
    }
}
