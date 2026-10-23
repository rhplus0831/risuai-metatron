// Spec selection for `pnpm test:agent --e2e` (`util/agentTest.mjs`): which Playwright specs in `e2e/`
// a change reaches. Every spec drives the whole app, so no import graph says which spec covers a
// change; the selection is by name instead. A spec is selected for a changed file when
// - the spec is the changed file, or the spec reaches it through relative static imports (followed
//   through the harness files in `e2e/` and `util/playwright/`);
// - the spec's text names the file: its repository path (`/src/...` dynamic imports included), its
//   file name when no other tracked file has that name, or one of its parent directories (fixture
//   directories a spec reads);
// - the file is one every spec runs on (EVERY_SPEC_FILES).
// Guides, notes, and unit tests are never matched (`reachesBrowser`). A changed file no spec names
// is reported, so the agent can name the specs that cover the behavior instead. See
// `docs/structure/build-test-platforms.md`.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";

/** Changes to these reach every spec: the browser harness, the stack, and the app's build. */
export const EVERY_SPEC_FILES = new Set([
    "playwright.config.ts",
    "util/playwright/globalSetup.mjs",
    "util/playwright/stack.mjs",
    "vite.config.ts",
    "index.html",
    "pnpm-lock.yaml",
]);

/** Whether a change to `file` can show in a browser spec: not a guide, a note, or a unit test. */
export function reachesBrowser(file) {
    if (file.startsWith("docs/") || file.startsWith("handover/")) return false;
    if (file.endsWith(".md")) return false;
    return !/\.test\.[cm]?[jt]sx?$/.test(file);
}

const PATH_CHAR = /[\w./-]/;

/**
 * Whether `text` names `token` (a path or a file name) as a whole: not inside a longer name or path.
 * A leading `/` is allowed when nothing path-like comes before it (`"/src/ts/x.ts"`, `../shared/x.ts`),
 * so `src/x.ts` is not found inside `server/src/x.ts`; a trailing `.` ends a sentence.
 */
export function mentions(text, token) {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
        const before = text[at - 1];
        const okBefore =
            before === undefined ||
            !PATH_CHAR.test(before) ||
            (before === "/" && (at < 2 || !/[\w-]/.test(text[at - 2])));
        const after = text[at + token.length];
        const okAfter =
            after === undefined ||
            (after === "." ? !/\w/.test(text[at + token.length + 1] ?? "") : !PATH_CHAR.test(after));
        if (okBefore && okAfter) return true;
    }
    return false;
}

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function isHarness(file) {
    return file.startsWith("e2e/") || file.startsWith("util/playwright/");
}

/**
 * The repository paths `file` reaches through relative static imports, following the harness files
 * (`e2e/`, `util/playwright/`) and stopping at app and shared code. `read` returns a file's text, or
 * null when it cannot be read.
 */
export function staticImports(file, read) {
    const reached = new Set();
    const pending = [file];
    while (pending.length > 0) {
        const current = pending.pop();
        const text = read(current);
        if (text === null) continue;
        for (const [, specifier] of text.matchAll(IMPORT_PATTERN)) {
            const target = posix.normalize(posix.join(posix.dirname(current), specifier));
            if (reached.has(target)) continue;
            reached.add(target);
            if (isHarness(target)) pending.push(target);
        }
    }
    reached.delete(file);
    return reached;
}

/**
 * Picks the specs a change reaches. `specs` are `{ file, text, imports }` (`imports` from
 * `staticImports`), `changed` the changed repository paths, `tracked` every repository path (for the
 * file names no other file shares). Returns `{ selected: [{ file, because }], unnamed, ignored }`:
 * the selected specs in `specs` order with the changed files that selected each, the changed files
 * that can reach the browser but no spec names, and the changed files that cannot.
 */
export function selectSpecs({ specs, changed, tracked }) {
    const nameCount = new Map();
    for (const path of tracked) {
        const name = posix.basename(path);
        nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
    const ignored = changed.filter((file) => !reachesBrowser(file));
    const relevant = changed.filter(reachesBrowser);
    const reasons = new Map(specs.map((spec) => [spec.file, []]));
    const named = new Set();
    for (const file of relevant) {
        const name = posix.basename(file);
        const dirs = [];
        for (let dir = posix.dirname(file); dir.includes("/"); dir = posix.dirname(dir)) dirs.push(dir);
        for (const spec of specs) {
            const hit =
                EVERY_SPEC_FILES.has(file) ||
                spec.file === file ||
                spec.imports.has(file) ||
                mentions(spec.text, file) ||
                ((nameCount.get(name) ?? 0) <= 1 && mentions(spec.text, name)) ||
                dirs.some((dir) => mentions(spec.text, dir));
            if (!hit) continue;
            reasons.get(spec.file).push(file);
            named.add(file);
        }
    }
    return {
        selected: specs
            .filter((spec) => reasons.get(spec.file).length > 0)
            .map((spec) => ({ file: spec.file, because: reasons.get(spec.file) })),
        unnamed: relevant.filter((file) => !named.has(file)),
        ignored,
    };
}

const SUMMARY_MAX = 110;

/** The first sentence of a spec's first comment: what it checks, for the list printed when nothing is selected. */
export function specSummary(text) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("//"));
    if (start === -1) return "";
    const block = [];
    for (const line of lines.slice(start)) {
        if (!line.startsWith("//")) break;
        block.push(line.replace(/^\/\/\s?/, "").trim());
    }
    const comment = block.join(" ");
    const end = comment.search(/\.(\s|$)/);
    const sentence = end === -1 ? comment : comment.slice(0, end + 1);
    return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1)}…` : sentence;
}

function git(root, gitArgs) {
    const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout.split("\0").filter(Boolean);
}

/**
 * The repository paths changed since `since` (a revision; HEAD by default): committed after it,
 * staged, unstaged, deleted, renamed (both names), and untracked files (`.gitignore` honored).
 */
export function changedFiles(root, since = "HEAD") {
    const diff = git(root, ["diff", "--name-only", "--no-renames", "-z", since, "--"]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return [...new Set([...diff, ...untracked])].sort();
}

/** Every tracked and untracked repository path (`.gitignore` honored). */
export function repositoryFiles(root) {
    return git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
}

/** The specs in `e2e/`, in Playwright's run order (file names sorted), with their text and imports. */
export function loadSpecs(root) {
    const read = (file) => {
        try {
            return readFileSync(posix.join(root, file), "utf8");
        } catch {
            return null;
        }
    };
    return readdirSync(posix.join(root, "e2e"))
        .filter((name) => name.endsWith(".spec.ts"))
        .sort()
        .map((name) => {
            const file = `e2e/${name}`;
            return { file, text: read(file) ?? "", imports: staticImports(file, read) };
        });
}
