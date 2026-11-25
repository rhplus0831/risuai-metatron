// `pnpm docs:owner <path>...`: which guide owns a repository path, read from the ownership manifest
// (`docs/structure/ownership.json`). It prints one line per path, `<path> <guide>`, and for a file two or more
// guides share, `; also <guide> (<part>)` for each other guide, then exits 1 when any path has no owner and 2
// without arguments. A path need not exist: a planned new file has an owner too.
//
// The manifest is `{ "comment": "...", "rules": [...] }`, each rule `{ "match", "guide" }` with an optional
// `"shared": true` and `"part"`. The rules are ordered and the first match wins, so specific rules come first and
// the fallback directories last. A glob's `*` and `?` stay inside one path segment and match a leading dot,
// `**` crosses segments (`a/**` matches everything under `a/`, `a/**/b` matches `a/b`), and `{x,y}` is either
// choice; matching is on the path text alone. Test files follow the code they exercise through their own globs,
// placed before the fallbacks. Shared rules have the same `match`, sit together, and each names its `part`: the
// first is the owner and the others print after it.
// `pnpm check:docs` validates the manifest through `checkOwnership`; `pnpm check:changed` prints the owners of
// the changed paths through `ownerOf`.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OWNERSHIP_FILE = "docs/structure/ownership.json";
/** The root directories whose every tracked path must have an owner. */
export const OWNED_ROOTS = ["src", "server", "shared", "util", "e2e", "public"];

const RULE_KEYS = new Set(["match", "guide", "shared", "part"]);

/** The anchored regular expression for a manifest glob; throws on unbalanced braces. */
export function globRegExp(glob) {
    let out = "";
    let depth = 0;
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === "*" && glob[i + 1] === "*") {
            i++;
            if (glob[i + 1] === "/") {
                i++;
                out += "(?:.*/)?";
            } else out += ".*";
        } else if (char === "*") out += "[^/]*";
        else if (char === "?") out += "[^/]";
        else if (char === "{") {
            depth++;
            out += "(?:";
        } else if (char === "}" && depth > 0) {
            depth--;
            out += ")";
        } else if (char === "," && depth > 0) out += "|";
        else out += char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    }
    if (depth > 0) throw new Error("unbalanced braces");
    return new RegExp(`^${out}$`);
}

/** The line of each `"match"` key in `text`, in order: rule `i` is at the `i`th, when every rule has one. */
function matchLines(text) {
    const lines = [];
    text.split("\n").forEach((line, i) => {
        for (const _ of line.matchAll(/"match"\s*:/g)) lines.push(i + 1);
    });
    return lines;
}

/**
 * The manifest `text` as `{ rules, problems }`. A rule is `{ match, guide, shared, part, line, regexp }`; a
 * problem is `{ line, message }` for malformed JSON or a bad rule shape, and a rule with a problem is left out.
 */
export function parseOwnership(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        const line = Number(/line (\d+)/.exec(error.message)?.[1] ?? 1);
        return { rules: [], problems: [{ line, message: `not JSON: ${error.message}` }] };
    }
    const problems = [];
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isObject(data) || !Array.isArray(data.rules)) {
        return { rules: [], problems: [{ line: 1, message: "expected an object with a `rules` array" }] };
    }
    const extra = Object.keys(data).filter((key) => key !== "rules" && key !== "comment");
    if (extra.length > 0) problems.push({ line: 1, message: `unknown top-level keys: ${extra.join(", ")}` });
    const lines = matchLines(text);
    const rules = [];
    data.rules.forEach((rule, index) => {
        const line = lines[index] ?? 1;
        const bad = (message) => problems.push({ line, message: `rule ${index + 1}: ${message}` });
        if (!isObject(rule)) return bad("not an object");
        const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
        if (unknown.length > 0) return bad(`unknown keys: ${unknown.join(", ")}`);
        if (typeof rule.match !== "string" || rule.match === "") return bad("`match` is not a non-empty string");
        if (typeof rule.guide !== "string" || rule.guide === "") return bad("`guide` is not a non-empty string");
        if (rule.shared !== undefined && rule.shared !== true) return bad("`shared` is not true");
        const shared = rule.shared === true;
        if (shared && (typeof rule.part !== "string" || rule.part === "")) return bad("a shared rule needs a `part`");
        if (!shared && rule.part !== undefined) return bad("only a shared rule has a `part`");
        let regexp;
        try {
            regexp = globRegExp(rule.match);
        } catch (error) {
            return bad(`${rule.match}: ${error.message}`);
        }
        rules.push({ match: rule.match, guide: rule.guide, shared, part: rule.part ?? null, line, regexp });
    });
    return { rules, problems };
}

/** The index of the first rule matching `file`, or -1. */
function ownerIndex(rules, file) {
    return rules.findIndex((rule) => rule.regexp.test(file));
}

/**
 * The owner of the repository path `file` under the parsed `rules`, or null: `{ guide, part, rule, also }`, where
 * `also` lists the other `{ guide, part }` of a shared file.
 */
export function ownerOf(rules, file) {
    const index = ownerIndex(rules, file);
    if (index < 0) return null;
    const rule = rules[index];
    const also = rule.shared
        ? rules
              .filter((other) => other !== rule && other.shared && other.match === rule.match)
              .map(({ guide, part }) => ({ guide, part }))
        : [];
    return { guide: rule.guide, part: rule.part, rule, also };
}

/** The `docs:owner` line for `file`. */
export function formatOwner(rules, file) {
    const owner = ownerOf(rules, file);
    if (!owner) return `${file} (no owner)`;
    const also = owner.also.map(({ guide, part }) => `${guide} (${part})`).join(", ");
    return `${file} ${owner.guide}${also ? `; also ${also}` : ""}`;
}

/**
 * What is wrong with the manifest `text` for the repository paths `tracked`, as `{ line, message }` problems:
 * malformed JSON or rule shape; a rule matching no tracked path, or only paths an earlier rule owns; a tracked path
 * under `OWNED_ROOTS` that no rule owns; a guide not in `guides` (the names `docs:read` resolves); a shared group
 * that is split or has one rule. A missing manifest is `text` null: no rules, so every owned path is uncovered.
 */
export function checkOwnership(text, tracked, guides) {
    const { rules, problems } = text === null ? { rules: [], problems: [] } : parseOwnership(text);
    const owned = new Set();
    const uncovered = [];
    for (const file of tracked) {
        const index = ownerIndex(rules, file);
        if (index >= 0) owned.add(index);
        else if (OWNED_ROOTS.some((root) => file.startsWith(`${root}/`))) uncovered.push(file);
    }
    rules.forEach((rule, index) => {
        const at = (message) => problems.push({ line: rule.line, message: `${rule.match}: ${message}` });
        if (!guides.has(rule.guide)) at(`no guide named ${rule.guide}`);
        const group = rules.filter((other) => other.match === rule.match);
        const first = rules.indexOf(group[0]);
        if (rule.shared) {
            if (group.length < 2) at("a shared rule needs another shared rule with the same match");
            else if (group.some((other, i) => !other.shared || rules[first + i] !== other)) {
                at("rules with the same match must all be shared and sit together");
            }
        }
        // A shared group's later rules never own a path: the first one does, for all of them.
        if (rule.shared && index !== first) return;
        if (owned.has(index)) return;
        const matches = tracked.some((file) => rule.regexp.test(file));
        at(matches ? "every path it matches belongs to an earlier rule" : "matches no tracked path");
    });
    for (const file of uncovered) problems.push({ line: 1, message: `${file}: no rule owns this path` });
    return problems;
}

/** The parsed rules of the manifest under `root`, or null when it is missing; throws on a problem in it. */
export function readOwnership(root) {
    const file = path.join(root, OWNERSHIP_FILE);
    if (!existsSync(file)) return null;
    const { rules, problems } = parseOwnership(readFileSync(file, "utf8"));
    if (problems.length > 0) {
        const first = problems[0];
        throw new Error(`${OWNERSHIP_FILE}:${first.line} ${first.message}`);
    }
    return rules;
}

/** `file` as a repository path: relative to `root`, forward slashes, no leading `./`; a trailing `/` stays. */
export function repoPath(root, file) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    return /[\\/]$/.test(file) && relative !== "" ? `${relative}/` : relative;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    process.stdout.on("error", (error) => {
        if (error.code !== "EPIPE") throw error;
    });
    const files = process.argv.slice(2);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (files.length === 0) {
        process.stderr.write("usage: pnpm docs:owner <path>...\n");
        process.exit(2);
    }
    let rules;
    try {
        rules = readOwnership(root);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(2);
    }
    if (!rules) {
        process.stderr.write(`no ownership manifest at ${OWNERSHIP_FILE}\n`);
        process.exit(2);
    }
    const relative = files.map((file) => repoPath(root, file));
    process.stdout.write(`${relative.map((file) => formatOwner(rules, file)).join("\n")}\n`);
    if (relative.some((file) => !ownerOf(rules, file))) process.exitCode = 1;
}
