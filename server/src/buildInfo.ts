import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type BuildInfo, projectBuildInfo, UNKNOWN_BUILD } from "../../shared/buildInfo.ts";

/** Runs `git <args>` in `cwd` and returns its trimmed output; throws when git is missing or fails. */
export type GitRunner = (args: string[], cwd: string) => string;

const runGit: GitRunner = (args, cwd) =>
    execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
    }).trim();

/**
 * The build of the checkout at `rootDir`. `RISU_BUILD_COMMIT` (with the optional `RISU_BUILD_DATE`,
 * `YYYY-MM-DD`, and `RISU_BUILD_DIRTY=true`) wins when set: the Docker build has no `.git`.
 * Otherwise git gives the HEAD commit, its committer date (`%cs`, the same on every machine), and
 * whether `git status` lists a change. Unknown when neither works.
 */
export function resolveBuildInfo(
    rootDir: string,
    env: Record<string, string | undefined> = process.env,
    git: GitRunner = runGit,
): BuildInfo {
    const envCommit = env.RISU_BUILD_COMMIT?.trim().toLowerCase();
    if (envCommit) {
        return projectBuildInfo({
            commit: envCommit,
            date: env.RISU_BUILD_DATE?.trim(),
            dirty: env.RISU_BUILD_DIRTY?.trim() === "true",
        });
    }
    try {
        return projectBuildInfo({
            commit: git(["rev-parse", "HEAD"], rootDir),
            date: git(["log", "-1", "--format=%cs"], rootDir),
            dirty: git(["status", "--porcelain"], rootDir) !== "",
        });
    } catch {
        return UNKNOWN_BUILD;
    }
}

/**
 * The build the server reports: `dist/build-info.json`, which `pnpm build` writes beside the client it
 * serves, read on every call because a build can replace `dist/` under a running server. Without the
 * file (a checkout that was never built, such as `pnpm dev`) it is `fallback`, `resolveBuildInfo` by
 * default.
 */
export function readServerBuildInfo(
    rootDir: string,
    fallback: () => BuildInfo = () => resolveBuildInfo(rootDir),
): BuildInfo {
    let text: string;
    try {
        text = readFileSync(path.join(rootDir, "dist", "build-info.json"), "utf8");
    } catch {
        return fallback();
    }
    try {
        return projectBuildInfo(JSON.parse(text));
    } catch {
        return UNKNOWN_BUILD;
    }
}

/**
 * The build of the server code running, which the resource store's normalization stamp names: the
 * checkout's build when it has a commit, with its `dirty`, and `dist/build-info.json` never consulted.
 * `readServerBuildInfo` alone would be wrong, because it names the served client's build, and a
 * checkout runs its server from TypeScript without a build, so that file can name a commit whose
 * server code is not the code running. Without a commit (no `.git`) it is the file's commit, which in
 * a built image is the server's commit too, and unknown when that fails as well.
 */
export function resolveNormalizationIdentity(
    rootDir: string,
    checkout: () => BuildInfo = () => resolveBuildInfo(rootDir),
): BuildInfo {
    const build = checkout();
    return build.commit ? build : readServerBuildInfo(rootDir, () => UNKNOWN_BUILD);
}
