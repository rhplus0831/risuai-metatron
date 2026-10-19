// The disposable storage of `pnpm dev:agent` (`util/agentDev.mjs`): a copy of `save/` in `save-agent/`,
// so an agent-driven session can change data freely and never touches the human store. See
// `docs/structure/build-test-platforms.md`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** @typedef {"clone" | "keep" | "fresh"} AgentDataSandboxMode */

/**
 * `RISU_AGENT_DATA_MODE`: `clone` (default) copies `save/` again on every start, `keep` reuses an
 * existing sandbox (clones when there is none), `fresh` starts empty.
 *
 * @param {string | undefined} raw
 * @returns {AgentDataSandboxMode}
 */
export function parseAgentDataSandboxMode(raw) {
    if (!raw?.trim()) {
        return "clone";
    }
    const mode = raw.trim().toLowerCase();
    if (mode === "clone" || mode === "keep" || mode === "fresh") {
        return mode;
    }
    throw new Error(`Invalid RISU_AGENT_DATA_MODE: ${raw} (expected clone, keep, or fresh)`);
}

// What a clone carries over. The databases go through SQLite's online backup, which gives a
// consistent copy while a `pnpm dev:human` server holds the source open and writes its WAL. The
// vector cache is checked against the resource store's epoch at startup, so the pair stays valid.
const SQLITE_FILES = ["data/resources.sqlite", "data/vectors.sqlite"];
// Asset files are staged and renamed into place, never rewritten (`routes/storage.ts`), so a hard
// link is safe: a write or delete in either tree replaces or removes only that tree's entry.
const LINKED_DIRS = ["assets"];
// Left behind on purpose: `server/` (password, known keys, Web Push keys and subscriptions; the agent
// server bypasses auth), `backups/`, `diagnostics/`, `data/request-history.sqlite` (diagnostic data
// with request content), `models/` (a download cache), and loose files at the top level.

/**
 * Prepares `sandboxDir` from `sourceDir` and returns a one-line summary for the runner's log. The
 * copy is built in a staging directory beside the sandbox and swapped in, so a failed clone leaves the
 * previous sandbox as it was.
 *
 * @param {{ sourceDir: string, sandboxDir: string, mode: AgentDataSandboxMode }} options
 * @returns {Promise<string>}
 */
export async function prepareAgentDataSandbox({ sourceDir, sandboxDir, mode }) {
    const source = path.resolve(sourceDir);
    const sandbox = path.resolve(sandboxDir);
    assertDisjoint(canonicalPath(source), canonicalPath(sandbox), source, sandbox);
    const existed = validateSandbox(sandbox);
    if (mode === "keep" && existed) {
        return `kept the existing sandbox at ${sandbox}`;
    }
    const parent = path.dirname(sandbox);
    fs.mkdirSync(parent, { recursive: true });
    const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(sandbox)}.staging-`));
    try {
        const summary = await populate(source, staging, sandbox, mode);
        replaceSandbox(staging, sandbox, existed);
        return summary;
    } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
    }
}

async function populate(source, staging, sandbox, mode) {
    if (mode === "fresh" || !fs.existsSync(source)) {
        return `created an empty sandbox at ${sandbox}`;
    }
    const cloned = [];
    for (const file of SQLITE_FILES) {
        const from = path.join(source, file);
        if (fs.existsSync(from)) {
            const to = path.join(staging, file);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            await snapshotDatabase(from, to);
            cloned.push(file);
        }
    }
    for (const dir of LINKED_DIRS) {
        const from = path.join(source, dir);
        if (fs.existsSync(from) && fs.statSync(from).isDirectory()) {
            const files = linkTree(from, path.join(staging, dir));
            cloned.push(`${dir}/ (${files} file${files === 1 ? "" : "s"})`);
        }
    }
    if (cloned.length === 0) {
        return `created an empty sandbox at ${sandbox} (nothing to clone in ${source})`;
    }
    return `cloned ${cloned.join(", ")} from ${source} into ${sandbox}`;
}

async function snapshotDatabase(from, to) {
    const db = new DatabaseSync(from, { readOnly: true });
    try {
        await backup(db, to);
    } finally {
        db.close();
    }
}

/** Hard links every file under `sourceDir`, or copies it when linking fails (another filesystem). */
function linkTree(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    let files = 0;
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const from = path.join(sourceDir, entry.name);
        const to = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            files += linkTree(from, to);
        } else if (entry.isFile()) {
            try {
                fs.linkSync(from, to);
            } catch {
                fs.copyFileSync(from, to);
            }
            files += 1;
        }
    }
    return files;
}

function pathExists(file) {
    try {
        fs.lstatSync(file);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

/** The real path of `file`, resolving the deepest part that exists (the sandbox may not exist yet). */
function canonicalPath(file) {
    const suffix = [];
    let existing = file;
    while (!pathExists(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) {
            break;
        }
        suffix.unshift(path.basename(existing));
        existing = parent;
    }
    return path.resolve(fs.realpathSync(existing), ...suffix);
}

function validateSandbox(sandbox) {
    if (!pathExists(sandbox)) {
        return false;
    }
    const stat = fs.lstatSync(sandbox);
    if (stat.isSymbolicLink()) {
        throw new Error(`The agent data sandbox (${sandbox}) must not be a symbolic link`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`The agent data sandbox (${sandbox}) must be a directory`);
    }
    return true;
}

// The sandbox is replaced recursively, so neither directory may contain the other, also through a
// symbolic link in a parent.
function assertDisjoint(canonicalSource, canonicalSandbox, source, sandbox) {
    const contains = (parent, child) => {
        const rel = path.relative(parent, child);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (contains(canonicalSource, canonicalSandbox) || contains(canonicalSandbox, canonicalSource)) {
        throw new Error(`The agent data sandbox (${sandbox}) must be apart from the source directory (${source})`);
    }
}

function replaceSandbox(staging, sandbox, existed) {
    if (validateSandbox(sandbox) !== existed) {
        throw new Error(`The agent data sandbox (${sandbox}) changed while it was being prepared`);
    }
    if (!existed) {
        fs.renameSync(staging, sandbox);
        return;
    }
    const previous = `${sandbox}.previous-${randomUUID()}`;
    fs.renameSync(sandbox, previous);
    try {
        fs.renameSync(staging, sandbox);
    } catch (error) {
        fs.renameSync(previous, sandbox);
        throw error;
    }
    fs.rmSync(previous, { recursive: true });
}
