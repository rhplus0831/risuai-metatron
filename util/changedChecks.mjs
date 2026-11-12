// `pnpm check`, `pnpm check:changed`, and `pnpm format:changed`: the type check, and the local checks
// narrowed to what git says changed.
// The changed set is every path that differs between the base and the working tree (committed, staged,
// or not), plus untracked files that `.gitignore` does not hide. The base defaults to the merge base of
// HEAD and `origin/dev`, so a branch's own commits count; with no `origin/dev` it is HEAD.
//   - `format [--write]`: Prettier on the changed files that still exist, `--check` unless `--write`, with
//     the same cache as `pnpm format:check`. `.prettierignore` still applies, and files Prettier cannot
//     parse are skipped.
//   - `types`: the whole client (`svelte-check`), server (`tsc`), and e2e (`tsc --noEmit`) programs, in
//     parallel. A type error can surface in a file nobody touched, so a program is never narrowed to the
//     changed files: it is only skipped when every changed path is one it cannot read. The e2e program
//     reads `e2e/`, `src/`, `shared/`, and `util/` imports, plus the root tsconfig and dependencies; it
//     does not read the Playwright runner config. An unknown path runs all three programs. The server
//     `tsc` keeps an incremental cache in `node_modules/.cache/tsc/`.
//     Its first line names the guides that own the changed paths (`ownersLine`, from the manifest
//     `util/docsOwner.mjs` reads), the guides sharing a file included, then the changed paths under the owned
//     roots (`src/`, `server/`, `shared/`, `util/`, `e2e/`, `public/`) that no rule owns. A changed path
//     outside those roots with no rule (docs, root Markdown, the lockfile) is left out of the line.
//   - `types --all` (`pnpm check`): all three programs, whatever changed, with no git lookup and no
//     owner line. Nothing is skipped and no stored result is replayed, so CI runs this one.
// Either `types` form starts its programs together: each prints one block when it ends (its name, its
// duration, its exit code, then its whole output), so blocks never interleave and come in the order
// the programs finish, not a fixed one. The last line is the verdict (`typeCheckVerdict`): it names
// every program that failed, since a failed block can sit above a later passing one. The exit code
// is 1 when any program failed. Side by side the three take as long as `svelte-check` alone.
// `--base <ref>` picks another base. `pnpm format:check` stays the full formatting check; CI runs it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OWNED_ROOTS, ownerOf, readOwnership } from "./docsOwner.mjs";

/** Paths outside all three type-checked programs: docs and assets. */
const INERT = [
    /\.md$/i,
    /^(docs|handover|\.claude|\.github|\.vscode|\.idea)\//,
    /\.(png|jpe?g|gif|webp|avif|ico)$/i,
    /^(\.prettierignore|\.prettierrc\.json|\.ignore|\.gitignore|\.gitattributes|\.git-blame-ignore-revs)$/,
    /^(\.dockerignore|Dockerfile|LICENSE|playwright\.config\.ts)$/,
];

/** Tooling and e2e sources are outside the client and server programs. */
const E2E_ONLY = /^(util|e2e)\//;

/** The e2e program imports client/shared code and tools, but no server, public assets, or build config. */
const E2E_UNREAD = [
    /^(server|public)\//,
    /^(index\.html|tsconfig\.node\.json|vite\.config\.ts|svelte\.config\.[cm]?[jt]s)$/,
];

/** Paths the client program reads but the server program does not. */
const CLIENT_ONLY = [
    /^(src|public)\//,
    /^(index\.html|tsconfig\.json|tsconfig\.node\.json|vite\.config\.ts|svelte\.config\.[cm]?[jt]s)$/,
];

/** The three type-checked programs, by their `typeCheckTargets` key. */
const PROGRAMS = {
    // Not `svelte-check --incremental`: with svelte-check 4.7 it reported two errors the normal run
    // does not, an unused `@ts-expect-error` and a `LegacyComponentType` mismatch.
    client: {
        label: "svelte-check",
        pkg: "svelte-check",
        bin: "svelte-check",
        args: ["--tsconfig", "./tsconfig.json"],
    },
    server: {
        label: "tsc server",
        pkg: "typescript",
        bin: "tsc",
        args: [
            "-p",
            "server/tsconfig.json",
            "--incremental",
            "--tsBuildInfoFile",
            "node_modules/.cache/tsc/server.tsbuildinfo",
        ],
    },
    e2e: { label: "tsc e2e", pkg: "typescript", bin: "tsc", args: ["-p", "e2e/tsconfig.json", "--noEmit"] },
};

const isInert = (file) => INERT.some((pattern) => pattern.test(file));

/** Which whole programs a changed set reaches: `client` (`svelte-check`), `server` and `e2e` (`tsc`). */
export function typeCheckTargets(files) {
    const reaching = files.filter((file) => !isInert(file));
    const app = reaching.filter((file) => !E2E_ONLY.test(file));
    return {
        client: app.length > 0,
        server: app.some((file) => !CLIENT_ONLY.some((pattern) => pattern.test(file))),
        e2e:
            files.some((file) => file.startsWith("e2e/")) ||
            reaching.some((file) => !E2E_UNREAD.some((pattern) => pattern.test(file))),
    };
}

/**
 * The owner line for the changed `files` under the parsed ownership `rules`: the owning guides, sorted, those
 * sharing a file included, then the changed paths under `OWNED_ROOTS` that no rule owns. Paths outside those roots
 * with no owner are left out.
 */
export function ownersLine(rules, files) {
    const guides = new Set();
    const unowned = [];
    for (const file of files) {
        const owner = ownerOf(rules, file);
        if (owner) [owner, ...owner.also].forEach(({ guide }) => guides.add(guide));
        else if (OWNED_ROOTS.some((root) => file.startsWith(`${root}/`))) unowned.push(file);
    }
    const owners = guides.size > 0 ? [...guides].sort().join(", ") : "none";
    return `[changed] owners: ${owners}${unowned.length > 0 ? `; no owner: ${unowned.join(", ")}` : ""}`;
}

/** `ownersLine` for the manifest under `root`, or why it cannot be read. */
function rootOwnersLine(root, files) {
    try {
        const rules = readOwnership(root);
        return rules ? ownersLine(rules, files) : "[changed] owners: no ownership manifest";
    } catch (error) {
        return `[changed] owners: unreadable manifest, ${error.message}`;
    }
}

function git(root, args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function resolveBase(root, base) {
    if (base) return git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
    try {
        return git(root, ["merge-base", "HEAD", "origin/dev"]).trim();
    } catch {
        return git(root, ["rev-parse", "HEAD"]).trim();
    }
}

/** Repository-relative paths changed since `base`, deletions and both sides of a rename included. */
export function changedFiles(root, base) {
    const split = (out) => out.split("\0").filter(Boolean);
    const tracked = split(git(root, ["diff", "--name-only", "--no-renames", "-z", base]));
    const untracked = split(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    return [...new Set([...tracked, ...untracked])].sort();
}

function binPath(root, pkg, name) {
    const dir = path.join(root, "node_modules", pkg);
    const { bin } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return path.join(dir, typeof bin === "string" ? bin : bin[name]);
}

/**
 * Runs a package's bin with Node, buffering its output so parallel runs print one block each, headed
 * `[<tag>] <label> (<seconds> s, exit <code>)`. Resolves to the exit code, 1 when a signal ended it.
 */
function run(root, tag, label, pkg, name, args) {
    return new Promise((resolve) => {
        const started = Date.now();
        // The child writes to a pipe, so it is told when the block will be shown on a terminal.
        const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
        const child = spawn(process.execPath, [binPath(root, pkg, name), ...args], { cwd: root, env });
        const chunks = [];
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.on("close", (code) => {
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            process.stdout.write(`[${tag}] ${label} (${seconds} s, exit ${code})\n${Buffer.concat(chunks)}`);
            resolve(code ?? 1);
        });
    });
}

/**
 * The exit code and last line of a type check from its programs' `results` (`{ label, code }`, in
 * the order they were started): 1 and the failed programs when any exit code is not 0.
 */
export function typeCheckVerdict(tag, results, seconds) {
    const failed = results.filter(({ code }) => code !== 0);
    if (results.length === 0) return { code: 0, line: `[${tag}] no program to run` };
    const took = `${results.length} of ${Object.keys(PROGRAMS).length} programs in ${seconds.toFixed(1)} s`;
    if (failed.length === 0) return { code: 0, line: `[${tag}] passed: ${took}` };
    const names = failed.map(({ label, code }) => `${label} (exit ${code})`).join(", ");
    return { code: 1, line: `[${tag}] FAILED: ${names}; ${took}` };
}

async function format(root, files, write) {
    const present = files.filter((file) => existsSync(path.join(root, file)));
    if (present.length === 0) {
        console.log("[changed] prettier: no changed files");
        return 0;
    }
    const mode = write ? "--write" : "--check";
    return run(root, "changed", `prettier ${mode}: ${present.length} files`, "prettier", "prettier", [
        mode,
        "--cache",
        "--ignore-unknown",
        "--no-error-on-unmatched-pattern",
        "--",
        ...present,
    ]);
}

/** Runs the programs `targets` selects side by side and prints the verdict line; resolves to the exit code. */
async function types(root, tag, targets) {
    const started = Date.now();
    const runs = [];
    for (const [key, { label, pkg, bin, args }] of Object.entries(PROGRAMS)) {
        if (targets[key]) {
            // `tsc` colors its output only for a terminal, and here it writes to a pipe.
            const shown = bin === "tsc" && process.stdout.isTTY ? [...args, "--pretty"] : args;
            runs.push(run(root, tag, label, pkg, bin, shown).then((code) => ({ label, code })));
        } else {
            console.log(`[${tag}] ${label}: skipped, no changed path reaches the ${key} program`);
        }
    }
    const { code, line } = typeCheckVerdict(tag, await Promise.all(runs), (Date.now() - started) / 1000);
    console.log(line);
    return code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const [command, ...args] = process.argv.slice(2);
    const baseIndex = args.indexOf("--base");
    const all = command === "types" && args.includes("--all");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (
        !["format", "types"].includes(command) ||
        (baseIndex !== -1 && (all || !args[baseIndex + 1])) ||
        (args.includes("--all") && !all)
    ) {
        console.error("usage: node util/changedChecks.mjs <format [--write] | types> [--base <ref>] | types --all");
        process.exit(2);
    }
    if (all) {
        process.exitCode = await types(root, "check", { client: true, server: true, e2e: true });
    } else {
        const base = resolveBase(root, baseIndex === -1 ? undefined : args[baseIndex + 1]);
        const files = changedFiles(root, base);
        if (command === "types") console.log(rootOwnersLine(root, files));
        console.log(`[changed] base ${base.slice(0, 9)}: ${files.length} changed paths`);
        process.exitCode =
            command === "format"
                ? await format(root, files, args.includes("--write"))
                : await types(root, "changed", typeCheckTargets(files));
    }
}
