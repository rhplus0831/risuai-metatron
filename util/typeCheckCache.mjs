// The result cache of the type check (`util/changedChecks.mjs` `types`, so `pnpm check` and
// `pnpm check:changed`): one stored result per program (client, server, e2e) and per set of inputs.
//
// A program's key is a hash over everything its result depends on:
//   - every file of the working tree the program can read, as git blob ids. The tree is the working
//     tree with every change staged in a temporary index (`workingTreeId`), so uncommitted and
//     untracked files count. Files no program reads (docs, Markdown, images: `typeCheckTargets`) are
//     left out, so a guide edit keeps the key; a `util/` or `e2e/` edit keeps the client and server keys;
//   - files `.gitignore` hides under the source roots (IGNORED_ROOTS), by content: a program reads
//     them, and the tree does not hold them;
//   - the program's command line, the installed `typescript`, `svelte-check`, and `svelte` versions,
//     and the installed dependency set (`node_modules/.pnpm/lock.yaml`, which pnpm writes on install:
//     the tracked lockfile says what should be installed, this file what is);
//   - the scripts that decide all of the above (RULE_FILES), so changing a rule drops every entry;
//   - what shapes the stored output (a terminal, an agent session), which the caller adds to the settings.
// The tsconfig files and the tracked lockfile are files of the tree.
//
// Entries live in `<git common dir>/type-check-cache/<key>.json`, which every worktree of the
// repository shares: a branch checked in its worktree and then fast-forwarded into another checkout
// is the same tree there. Measured over a week of agent sessions, about one check in six would have
// replayed, a quarter of those from another checkout
// (docs/reports/measurements/toolchain/type-check-time-2026-11-12.md).
//
// A result is stored only when the program ran to its end (any exit code, not a signal) and the
// working tree was the same before and after the run. A failure is stored too: the same inputs fail
// the same way. `--force`, or `CI` in the environment, runs every program and replaces its entry.
// No key (not a git checkout, nothing installed) means no cache: the program runs.
// Entries older than MAX_AGE_MS are deleted when a result is stored.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, workingTreeId } from "./workingTree.mjs";

/** Roots a program reads source from; a file `.gitignore` hides there is hashed into the keys. */
const IGNORED_ROOTS = ["src", "server", "shared", "util", "e2e", "public"];
/** The scripts whose rules the keys rest on: which files reach a program, and how a key is built. */
const RULE_FILES = ["changedChecks.mjs", "typeCheckCache.mjs", "workingTree.mjs"];
const TOOLS = ["typescript", "svelte-check", "svelte"];
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The files of the working tree of `root` as `{ path, id }`, tracked and untracked (`id` is the mode
 * and blob id) plus the files `.gitignore` hides under IGNORED_ROOTS (`id` is `ignored` and the blob
 * id of the content), with the tree id; null when git cannot say.
 */
export function workingTreeFiles(root) {
    const tree = workingTreeId(root);
    if (tree === null) return null;
    const listing = git(root, ["ls-tree", "-r", "-z", tree]);
    if (listing.status !== 0) return null;
    const files = listing.stdout
        .split("\0")
        .filter(Boolean)
        .map((line) => {
            const tab = line.indexOf("\t");
            const [mode, , id] = line.slice(0, tab).split(" ");
            return { path: line.slice(tab + 1), id: `${mode} ${id}` };
        });
    const hidden = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...IGNORED_ROOTS]);
    if (hidden.status !== 0) return null;
    const hiddenPaths = hidden.stdout.split("\0").filter(Boolean);
    if (hiddenPaths.length > 0) {
        const ids = git(root, ["hash-object", "--no-filters", "--", ...hiddenPaths]);
        if (ids.status !== 0) return null;
        const lines = ids.stdout.split("\n").filter(Boolean);
        if (lines.length !== hiddenPaths.length) return null;
        hiddenPaths.forEach((file, index) => files.push({ path: file, id: `ignored ${lines[index]}` }));
    }
    return { tree, files };
}

/**
 * What a result depends on besides the working tree: the installed tool versions, the installed
 * dependency set, and the rule scripts. Null when the dependency set cannot be read.
 */
export function checkSettings(root) {
    try {
        const tools = TOOLS.map((name) => {
            const manifest = readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8");
            return `${name}@${JSON.parse(manifest).version}`;
        });
        const installed = sha256(readFileSync(path.join(root, "node_modules", ".pnpm", "lock.yaml")));
        const here = path.dirname(fileURLToPath(import.meta.url));
        const rules = RULE_FILES.map((name) => sha256(readFileSync(path.join(here, name))));
        return { tools, installed, rules };
    } catch {
        return null;
    }
}

/**
 * The cache key of one program: `command` is its command line, `settings` is `checkSettings`, and
 * `reaches(path)` says whether the program can read a file of `files`.
 */
export function programKey(command, settings, files, reaches) {
    const read = files.filter(({ path: file }) => reaches(file)).map(({ path: file, id }) => `${id}\t${file}`);
    return sha256(JSON.stringify([command, settings, read.sort()]));
}

/** The directory every worktree of the repository at `root` shares, or null outside git. */
export function cacheDirectory(root) {
    const common = git(root, ["rev-parse", "--git-common-dir"]);
    return common.status === 0 ? path.join(path.resolve(root, common.stdout.trim()), "type-check-cache") : null;
}

function readEntry(dir, key) {
    try {
        const entry = JSON.parse(readFileSync(path.join(dir, `${key}.json`), "utf8"));
        const valid = entry.key === key && Number.isInteger(entry.code) && typeof entry.output === "string";
        return valid ? entry : null;
    } catch {
        return null;
    }
}

function storeEntry(dir, key, entry, now) {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        try {
            if (now - statSync(file).mtimeMs > MAX_AGE_MS) rmSync(file, { force: true });
        } catch {
            // Another checkout removed it first.
        }
    }
    // Written beside the entry and renamed, so another checkout never reads half a file.
    const partial = path.join(dir, `${key}.${process.pid}.partial`);
    writeFileSync(partial, JSON.stringify({ key, ...entry }, null, 2));
    renameSync(partial, path.join(dir, `${key}.json`));
}

/**
 * One program through the cache. `run()` resolves to `{ code, output, seconds }`, `code` null when a
 * signal ended the program; `unchanged()` says whether the inputs are still the ones `key` was made
 * from. Resolves to that result with `replayed` (and `finishedAt` of the stored run when replayed).
 * With `force`, or without `dir` or `key`, the stored result is not read.
 */
export async function cachedRun({ dir, key, force, run, unchanged, now = Date.now }) {
    const usable = dir !== null && key !== null;
    const stored = usable && !force ? readEntry(dir, key) : null;
    if (stored) {
        return {
            code: stored.code,
            output: stored.output,
            seconds: stored.seconds,
            finishedAt: stored.finishedAt,
            replayed: true,
        };
    }
    const result = await run();
    if (usable && result.code !== null && unchanged()) {
        try {
            storeEntry(dir, key, { ...result, finishedAt: new Date(now()).toISOString() }, now());
        } catch {
            // A cache that cannot be written is not a failed check.
        }
    }
    return { ...result, replayed: false };
}
