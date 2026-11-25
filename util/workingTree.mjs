// The identity of a checkout's working tree, for result caches keyed by "nothing changed"
// (`util/agentTest.mjs`, `util/typeCheckCache.mjs`).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Runs git in `root` with extra environment; the caller reads `status` and `stdout`. */
export function git(root, args, env = {}) {
    return spawnSync("git", args, {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
}

/**
 * Tree id of the working tree of `root`: a copy of the real index (so unchanged files keep their stat
 * cache and are not re-hashed) with everything staged, untracked files included and `.gitignore`
 * honored, written as a tree object. The real index is not touched. Null outside git, or when the
 * add or the write-tree fails.
 */
export function workingTreeId(root) {
    const gitDir = git(root, ["rev-parse", "--git-dir"]);
    if (gitDir.status !== 0) return null;
    const realIndex = join(resolve(root, gitDir.stdout.trim()), "index");
    const tmp = mkdtempSync(join(tmpdir(), "working-tree-"));
    const tmpIndex = join(tmp, "index");
    try {
        if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
        const env = { GIT_INDEX_FILE: tmpIndex };
        if (git(root, ["add", "-A", "--", "."], env).status !== 0) return null;
        const tree = git(root, ["write-tree"], env);
        return tree.status === 0 ? tree.stdout.trim() : null;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
