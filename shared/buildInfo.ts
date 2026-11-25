/**
 * The build a client bundle or the server came from, apart from the compatibility version
 * (`version.json`, the client's `appVer`), which follows the upstream RisuAI release Metatron has
 * caught up with. `server/src/buildInfo.ts` resolves it from the environment or git; Vite puts it in
 * the bundle (`__RISU_BUILD__`) and in `dist/build-info.json`.
 */
export type BuildInfo = {
    /** The full lowercase commit hash, or null when it could not be found. */
    commit: string | null;
    /** The commit's committer date, `YYYY-MM-DD` (git's `%cs`). */
    date: string | null;
    /** Whether the working tree had changes `git status` reports. */
    dirty: boolean;
};

export const UNKNOWN_BUILD: BuildInfo = { commit: null, date: null, dirty: false };

const COMMIT = /^[0-9a-f]{9,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_COMMIT = 9;

/** A build id as `formatBuildId` writes it: `2026.10.26 · a9fa6f8c5`, the date optional, `-dirty` appended. */
export const BUILD_ID_PATTERN = /^(?:\d{4}\.\d{2}\.\d{2} · )?[0-9a-f]{9}(?:-dirty)?$/;

/** `value` as a `BuildInfo`, every field checked; a commit or date of another shape is null. */
export function projectBuildInfo(value: unknown): BuildInfo {
    if (typeof value !== "object" || value === null) {
        return UNKNOWN_BUILD;
    }
    const { commit, date, dirty } = value as Record<string, unknown>;
    const validCommit = typeof commit === "string" && COMMIT.test(commit) ? commit : null;
    return {
        commit: validCommit,
        date: validCommit && typeof date === "string" && DATE.test(date) ? date : null,
        dirty: validCommit !== null && dirty === true,
    };
}

/** The short build id people read and quote (`2026.10.26 · a9fa6f8c5`), or null without a commit. */
export function formatBuildId(info: BuildInfo): string | null {
    if (!info.commit) {
        return null;
    }
    const date = info.date ? `${info.date.replaceAll("-", ".")} · ` : "";
    return `${date}${info.commit.slice(0, SHORT_COMMIT)}${info.dirty ? "-dirty" : ""}`;
}
