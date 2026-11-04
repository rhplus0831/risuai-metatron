// `pnpm format:changed` and `pnpm check:changed`: the local checks narrowed to what git says changed.
// The changed set is every path that differs between the base and the working tree (committed, staged,
// or not), plus untracked files that `.gitignore` does not hide. The base defaults to the merge base of
// HEAD and `origin/dev`, so a branch's own commits count; with no `origin/dev` it is HEAD.
//   - `format [--write]`: Prettier on the changed files that still exist, `--check` unless `--write`, with
//     the same cache as `pnpm format:check`. `.prettierignore` still applies, and files Prettier cannot
//     parse are skipped.
//   - `types`: the whole client program (`svelte-check`) and the whole server program (`tsc`), in
//     parallel. A type error can surface in a file nobody touched, so a program is never narrowed to the
//     changed files: it is only skipped when every changed path is one it cannot read (`isInert`). An
//     unknown path runs both programs. The server `tsc` keeps an incremental cache, as `pnpm check` does.
//     Its first line names the guides that own the changed paths (`ownersLine`, from the manifest
//     `util/docsOwner.mjs` reads), the guides sharing a file included, then the changed paths under the owned
//     roots (`src/`, `server/`, `shared/`, `util/`, `e2e/`, `public/`) that no rule owns. A changed path
//     outside those roots with no rule (docs, root Markdown, the lockfile) is left out of the line.
// `--base <ref>` picks another base. `pnpm check` and `pnpm format:check` stay the full checks; CI runs
// those.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OWNED_ROOTS, ownerOf, readOwnership } from "./docsOwner.mjs";

/** Paths outside both type-checked programs: docs, tooling the programs never import, and assets. */
const INERT = [
    /\.md$/i,
    /^(docs|util|e2e|handover|\.claude|\.github|\.vscode|\.idea)\//,
    /\.(png|jpe?g|gif|webp|avif|ico)$/i,
    /^(\.prettierignore|\.prettierrc\.json|\.ignore|\.gitignore|\.gitattributes|\.git-blame-ignore-revs)$/,
    /^(\.dockerignore|Dockerfile|LICENSE|playwright\.config\.ts)$/,
];

/** Paths only the client program reads: the server and shared code never import them. */
const CLIENT_ONLY = [
    /^(src|public)\//,
    /^(index\.html|tsconfig\.json|tsconfig\.node\.json|vite\.config\.ts|svelte\.config\.[cm]?[jt]s)$/,
];

const SERVER_TSC_ARGS = [
    "-p",
    "server/tsconfig.json",
    "--incremental",
    "--tsBuildInfoFile",
    "node_modules/.cache/tsc/server.tsbuildinfo",
];

const isInert = (file) => INERT.some((pattern) => pattern.test(file));

/** Which programs a changed set reaches: `client` (`svelte-check`) and `server` (`tsc`). */
export function typeCheckTargets(files) {
    const reaching = files.filter((file) => !isInert(file));
    return {
        client: reaching.length > 0,
        server: reaching.some((file) => !CLIENT_ONLY.some((pattern) => pattern.test(file))),
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

/** Runs a package's bin with Node, buffering its output so parallel runs print one block each. */
function run(root, label, pkg, name, args) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [binPath(root, pkg, name), ...args], { cwd: root });
        const chunks = [];
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.on("close", (code) => {
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            process.stdout.write(`[changed] ${label} (${seconds} s, exit ${code})\n${Buffer.concat(chunks)}`);
            resolve(code ?? 1);
        });
    });
}

async function format(root, files, write) {
    const present = files.filter((file) => existsSync(path.join(root, file)));
    if (present.length === 0) {
        console.log("[changed] prettier: no changed files");
        return 0;
    }
    const mode = write ? "--write" : "--check";
    return run(root, `prettier ${mode}: ${present.length} files`, "prettier", "prettier", [
        mode,
        "--cache",
        "--ignore-unknown",
        "--no-error-on-unmatched-pattern",
        "--",
        ...present,
    ]);
}

async function types(root, files) {
    const targets = typeCheckTargets(files);
    const runs = [];
    if (targets.client) {
        runs.push(run(root, "svelte-check", "svelte-check", "svelte-check", ["--tsconfig", "./tsconfig.json"]));
    } else console.log("[changed] svelte-check: skipped, no changed path reaches the client program");
    if (targets.server) runs.push(run(root, "tsc server", "typescript", "tsc", SERVER_TSC_ARGS));
    else console.log("[changed] tsc server: skipped, no changed path reaches the server program");
    const codes = await Promise.all(runs);
    return codes.find((code) => code !== 0) ?? 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const [command, ...args] = process.argv.slice(2);
    const baseIndex = args.indexOf("--base");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (!["format", "types"].includes(command) || (baseIndex !== -1 && !args[baseIndex + 1])) {
        console.error("usage: node util/changedChecks.mjs <format [--write] | types> [--base <ref>]");
        process.exit(2);
    }
    const base = resolveBase(root, baseIndex === -1 ? undefined : args[baseIndex + 1]);
    const files = changedFiles(root, base);
    if (command === "types") console.log(rootOwnersLine(root, files));
    console.log(`[changed] base ${base.slice(0, 9)}: ${files.length} changed paths`);
    process.exitCode =
        command === "format" ? await format(root, files, args.includes("--write")) : await types(root, files);
}
