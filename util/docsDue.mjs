// `pnpm docs:due [<guide>...]`: how much code changed under each guide since it was last read against the source,
// the figure Doc Maintenance uses to pick the next read-and-verify pass. It prints one line per guide (every guide
// when none is named), most commits first, then a count line:
//   `<guide>  <n> commit(s) since verified <commit> <date>`
//   `<guide>  <n> commit(s) since added <commit> <date>, never verified`
//   `<guide>  not committed yet, never verified`
//   `<guide>  recorded commit <commit> is not in this repository`
// It is a report, not a gate: exit 0 whatever it finds, 2 on a usage error, an unknown guide, or a bad record.
//
// `pnpm docs:due --verified <guide>...` records `HEAD` as the commit the named guides were read against and prints
// each record. Run it in the pass, before the pass's own commit: the record is the source revision that was read,
// so the pass's guide fixes do not count against it and later source commits do.
//
// The record is `docs/structure/verified.json`: `{ "comment": "...", "guides": { "<guide>": "<commit>" } }`, a
// guide name as `pnpm docs:read` takes it and a full 40-character commit, names sorted. `pnpm check:docs` validates
// it through `checkVerified` (rule `verified`); whether the commit exists is checked only here, since a shallow
// clone lacks old commits.
//   - The guides: every name `pnpm docs:read` takes under `docs/structure/`, except Doc Maintenance (`README`),
//     which documents conventions, not code. `STRUCTURE.md` is not one: its rules point at the guides.
//   - A guide's paths are those whose owner in the ownership manifest (`util/docsOwner.mjs`: the first matching
//     rule, and for a shared file every guide of its group) is the guide. A guide in an area folder that no rule
//     names counts the area's paths (`structured-memory/read` counts what `structured-memory` owns).
//   - A commit counts once for a guide when it changed at least one of the guide's paths, by the path's name in
//     that commit and today's rules. Merge commits are skipped: their changes count on the commits merged.
//   - An unrecorded guide counts from the commit that added its file (the latest one, for a file added again).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownerOf, readOwnership } from "./docsOwner.mjs";
import { guideNames, resolveGuide } from "./docsRead.mjs";

export const VERIFIED_FILE = "docs/structure/verified.json";
/** The guide name of Doc Maintenance, which has no record. */
export const MAINTENANCE_GUIDE = "README";

const COMMENT =
    "The commit each guide was last read against the source at (Doc Maintenance, read-and-verify pass). " +
    "Written by `pnpm docs:due --verified <guide>...`; `pnpm docs:due` counts the commits to each guide's paths " +
    "since. util/docsDue.mjs states the format.";
const COMMIT = /^[0-9a-f]{40}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The record `text` as `{ guides, problems }`: `guides` maps each well-formed entry's guide to its commit, and a
 * problem is `{ line, message }` for malformed JSON, a bad shape, or an entry whose commit is not 40 hex digits
 * (left out of `guides`). A missing record is `text` null: no entries.
 */
export function parseVerified(text) {
    if (text === null) return { guides: {}, problems: [] };
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        const line = Number(/line (\d+)/.exec(error.message)?.[1] ?? 1);
        return { guides: {}, problems: [{ line, message: `not JSON: ${error.message}` }] };
    }
    if (!isObject(data) || !isObject(data.guides)) {
        return { guides: {}, problems: [{ line: 1, message: "expected an object with a `guides` object" }] };
    }
    const problems = [];
    const extra = Object.keys(data).filter((key) => key !== "guides" && key !== "comment");
    if (extra.length > 0) problems.push({ line: 1, message: `unknown top-level keys: ${extra.join(", ")}` });
    const lines = text.split("\n");
    const lineOf = (name) => lines.findIndex((line) => line.includes(JSON.stringify(name))) + 1 || 1;
    const guides = {};
    for (const [name, commit] of Object.entries(data.guides)) {
        if (typeof commit === "string" && COMMIT.test(commit)) guides[name] = commit;
        else problems.push({ line: lineOf(name), message: `${name}: not a full 40-character commit` });
    }
    return { guides, problems };
}

/**
 * What is wrong with the record `text` for the guide names `names` (a set, as `pnpm docs:read` takes them), as
 * `{ line, message }` problems: those of `parseVerified`, and an entry for a name that is no guide or is Doc
 * Maintenance.
 */
export function checkVerified(text, names) {
    const { guides, problems } = parseVerified(text);
    const lines = (text ?? "").split("\n");
    for (const name of Object.keys(guides)) {
        if (names.has(name) && name !== MAINTENANCE_GUIDE) continue;
        const line = lines.findIndex((entry) => entry.includes(JSON.stringify(name))) + 1 || 1;
        problems.push({ line, message: `${name}: not a guide` });
    }
    return problems;
}

/** The record text for `guides` (guide to commit): names sorted, as Prettier formats it. */
export function formatVerified(guides) {
    const sorted = Object.fromEntries(Object.entries(guides).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return `${JSON.stringify({ comment: COMMENT, guides: sorted }, null, 2)}\n`;
}

/** The name the ownership `rules` know the guide `name` by: its own, or its area folder's when no rule names it. */
export function ownershipName(rules, name) {
    if (rules.some((rule) => rule.guide === name) || !name.includes("/")) return name;
    const area = name.slice(0, name.indexOf("/"));
    return rules.some((rule) => rule.guide === area) ? area : name;
}

/** The commits of a `git log --name-only --format=%x00%H` listing, as `{ commit, files }`, newest first. */
export function parseLog(out) {
    return out
        .split("\0")
        .slice(1)
        .map((entry) => {
            const [commit, ...files] = entry.split("\n").filter(Boolean);
            return { commit, files };
        });
}

/** The guides the ownership `rules` give the path `file` to: its owner, then the others of a shared file. */
export function ownerGuides(rules, file) {
    const found = ownerOf(rules, file);
    return found ? [found.guide, ...found.also.map((other) => other.guide)] : [];
}

/** How many of `commits` (from `parseLog`) changed a path that `owners` (path to guide names) gives to `guide`. */
export function countCommits(commits, owners, guide) {
    return commits.filter(({ files }) => files.some((file) => owners(file).includes(guide))).length;
}

function git(root, args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 256 << 20 });
}

/** `{ commit, date }` of `ref` under `root` (the short date of the commit), or null when git does not know it. */
function commitInfo(root, ref) {
    try {
        const [commit, date] = git(root, ["show", "--no-patch", "--format=%H %cs", `${ref}^{commit}`])
            .trim()
            .split(" ");
        return { commit, date };
    } catch {
        return null;
    }
}

/** The record under `root`; throws on a problem in it. */
export function readVerified(root) {
    const file = path.join(root, VERIFIED_FILE);
    const { guides, problems } = parseVerified(existsSync(file) ? readFileSync(file, "utf8") : null);
    if (problems.length > 0) throw new Error(`${VERIFIED_FILE}:${problems[0].line} ${problems[0].message}`);
    return guides;
}

/** The guides `pnpm docs:due` lists under `root`: every guide name but Doc Maintenance. */
export const dueGuides = (root) => guideNames(root).filter((name) => name !== MAINTENANCE_GUIDE);

/**
 * The report rows for the guides `names` under `root`, most commits first, then by name:
 * `{ guide, state, commit, date, commits }`. `state` is `verified` (counted from the recorded commit), `added`
 * (unrecorded: from the commit that added the guide file), `uncommitted` (unrecorded and in no commit), or
 * `unknown` (the recorded commit is not in the repository); the last two have `commits` null.
 */
export function dueReport(root, names = dueGuides(root)) {
    const rules = readOwnership(root) ?? [];
    const recorded = readVerified(root);
    const logs = new Map();
    const owned = new Map();
    const owners = (file) => {
        if (!owned.has(file)) owned.set(file, ownerGuides(rules, file));
        return owned.get(file);
    };
    const commitsSince = (commit) => {
        if (!logs.has(commit)) {
            const out = git(root, ["log", "--no-merges", "--name-only", "--format=%x00%H", `${commit}..HEAD`]);
            logs.set(commit, parseLog(out));
        }
        return logs.get(commit);
    };
    const rows = names.map((guide) => {
        const record = recorded[guide];
        let base;
        if (record) {
            base = commitInfo(root, record);
            if (!base) return { guide, state: "unknown", commit: record, date: null, commits: null };
        } else {
            const added = git(root, ["log", "--diff-filter=A", "--format=%H", "-1", "--", resolveGuide(root, guide)]);
            base = added.trim() ? commitInfo(root, added.trim()) : null;
            if (!base) return { guide, state: "uncommitted", commit: null, date: null, commits: null };
        }
        const commits = countCommits(commitsSince(base.commit), owners, ownershipName(rules, guide));
        return { guide, state: record ? "verified" : "added", ...base, commits };
    });
    return rows.sort((a, b) => (b.commits ?? -1) - (a.commits ?? -1) || (a.guide < b.guide ? -1 : 1));
}

/** The report text: one line per row of `dueReport`, then the count line. */
export function formatDue(rows) {
    const width = Math.max(0, ...rows.map(({ guide }) => guide.length));
    const lines = rows.map(({ guide, state, commit, date, commits }) => {
        const name = guide.padEnd(width);
        if (state === "unknown") return `${name}  recorded commit ${commit.slice(0, 9)} is not in this repository`;
        if (state === "uncommitted") return `${name}  not committed yet, never verified`;
        const count = `${commits} commit${commits === 1 ? "" : "s"}`;
        return state === "verified"
            ? `${name}  ${count} since verified ${commit.slice(0, 9)} ${date}`
            : `${name}  ${count} since added ${commit.slice(0, 9)} ${date}, never verified`;
    });
    const verified = rows.filter(({ state }) => state === "verified").length;
    lines.push(`[docs:due] ${rows.length} guide(s), ${verified} with a verified record`);
    return `${lines.join("\n")}\n`;
}

/** Records `commit` for the guides `names` in the record under `root` and returns the whole record. */
export function recordVerified(root, names, commit) {
    const guides = { ...readVerified(root) };
    for (const name of names) guides[name] = commit;
    writeFileSync(path.join(root, VERIFIED_FILE), formatVerified(guides));
    return guides;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const args = process.argv.slice(2);
    const fail = (message) => {
        process.stderr.write(`${message}\n`);
        process.exit(2);
    };
    const usage = "usage: pnpm docs:due [<guide>...]\n       pnpm docs:due --verified <guide>...";
    const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--verified");
    if (unknown) fail(`unknown option ${unknown}\n${usage}`);
    const record = args.includes("--verified");
    const listed = dueGuides(root);
    // A name as `pnpm docs:read` lists it, also for a guide given as a path, so the record's keys and the report's
    // rows are spelled one way.
    const named = args
        .filter((arg) => arg !== "--verified")
        .map((arg) =>
            arg
                .replace(/^(?:\.\/)?(?:docs\/structure\/)?/, "")
                .replace(/\.md$/, "")
                .replace(/\/(?:README)?$/, ""),
        );
    const names = [...new Set(named)];
    const bad = names.find((name) => !listed.includes(name));
    if (bad) fail(`no guide named ${bad}; one of:\n${listed.join("\n")}`);
    if (record && names.length === 0) fail(`--verified needs a guide\n${usage}`);
    try {
        if (record) {
            const head = commitInfo(root, "HEAD");
            if (!head) fail("HEAD is not a commit");
            recordVerified(root, names, head.commit);
            for (const name of names)
                process.stdout.write(`${name}  verified ${head.commit.slice(0, 9)} ${head.date}\n`);
        } else {
            process.stdout.write(formatDue(dueReport(root, names.length > 0 ? names : listed)));
        }
    } catch (error) {
        fail(error.message);
    }
}
