// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    VERIFIED_FILE,
    checkVerified,
    countCommits,
    dueReport,
    formatDue,
    formatVerified,
    ownerGuides,
    ownershipName,
    parseLog,
    parseVerified,
    recordVerified,
} from "./docsDue.mjs";
import { parseOwnership } from "./docsOwner.mjs";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>) {
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }
}

function git(root: string, ...args: string[]) {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
}

/** Writes `files`, commits everything, and returns the commit. */
function commit(root: string, files: Record<string, string>) {
    write(root, files);
    git(root, "add", "--", ".");
    git(root, "commit", "--quiet", "--no-gpg-sign", "-m", "change");
    return git(root, "rev-parse", "HEAD");
}

const RULES = [
    { match: "shared/both.ts", guide: "alpha", shared: true, part: "one half" },
    { match: "shared/both.ts", guide: "beta", shared: true, part: "other half" },
    { match: "src/alpha/**", guide: "alpha" },
    { match: "src/area/**", guide: "area" },
    { match: "src/**", guide: "beta" },
];

function repository() {
    const root = mkdtempSync(path.join(os.tmpdir(), "risu-docs-due-"));
    roots.push(root);
    git(root, "init", "--quiet");
    const first = commit(root, {
        "docs/structure/README.md": "# Doc Maintenance\n",
        "docs/structure/alpha.md": "# Alpha\n",
        "docs/structure/beta.md": "# Beta\n",
        "docs/structure/area/README.md": "# Area\n",
        "docs/structure/area/part.md": "# Part\n",
        "docs/structure/ownership.json": JSON.stringify({ rules: RULES }),
        "src/alpha/a.ts": "1",
        "src/area/x.ts": "1",
        "src/other.ts": "1",
        "shared/both.ts": "1",
    });
    return { root, first };
}

describe("docs:due", () => {
    it("reads a record and reports malformed JSON, a bad shape, and a commit that is not 40 hex digits", () => {
        expect(parseVerified(null)).toEqual({ guides: {}, problems: [] });
        expect(parseVerified(formatVerified({ beta: COMMIT_B, alpha: COMMIT_A }))).toEqual({
            guides: { alpha: COMMIT_A, beta: COMMIT_B },
            problems: [],
        });
        expect(parseVerified("{").problems).toEqual([
            expect.objectContaining({ message: expect.stringMatching(/^not JSON/) }),
        ]);
        expect(parseVerified("[]").problems).toEqual([
            { line: 1, message: "expected an object with a `guides` object" },
        ]);
        expect(parseVerified('{ "guides": [] }').problems).toHaveLength(1);
        const text = `{\n  "extra": 1,\n  "guides": {\n    "alpha": "${COMMIT_A}",\n    "beta": "abc1234",\n    "gamma": 5\n  }\n}\n`;
        expect(parseVerified(text)).toEqual({
            guides: { alpha: COMMIT_A },
            problems: [
                { line: 1, message: "unknown top-level keys: extra" },
                { line: 5, message: "beta: not a full 40-character commit" },
                { line: 6, message: "gamma: not a full 40-character commit" },
            ],
        });
    });

    it("rejects a record for a name that is no guide, and for Doc Maintenance", () => {
        const text = formatVerified({ alpha: COMMIT_A, README: COMMIT_A, gone: COMMIT_B, "area/part": COMMIT_B });
        const names = new Set(["alpha", "README", "area", "area/part"]);
        expect(checkVerified(text, names)).toEqual([
            { line: 4, message: "README: not a guide" },
            { line: 7, message: "gone: not a guide" },
        ]);
        expect(checkVerified(null, names)).toEqual([]);
    });

    it("writes the record with sorted names in the form Prettier keeps", () => {
        const text = formatVerified({ beta: COMMIT_B, "area/part": COMMIT_A, alpha: COMMIT_A });
        expect(Object.keys(JSON.parse(text).guides)).toEqual(["alpha", "area/part", "beta"]);
        expect(text).toMatch(/^\{\n  "comment": ".+",\n  "guides": \{\n    "alpha": "a{40}",\n/);
        expect(text.endsWith("  }\n}\n")).toBe(true);
        expect(formatVerified({})).toMatch(/\n  "guides": \{\}\n\}\n$/);
    });

    it("counts a commit once per guide that owns a changed path, a shared file for each of its guides", () => {
        const { rules } = parseOwnership(JSON.stringify({ rules: RULES }));
        expect(ownerGuides(rules, "shared/both.ts")).toEqual(["alpha", "beta"]);
        expect(ownerGuides(rules, "src/alpha/a.ts")).toEqual(["alpha"]);
        expect(ownerGuides(rules, "docs/plan/x.md")).toEqual([]);
        const commits = parseLog(
            "\0c3\n\nsrc/alpha/a.ts\nsrc/alpha/b.ts\n\0c2\n\nshared/both.ts\n\0c1\n\nsrc/other.ts\ndocs/plan/x.md\n\0c0\n",
        );
        expect(commits).toEqual([
            { commit: "c3", files: ["src/alpha/a.ts", "src/alpha/b.ts"] },
            { commit: "c2", files: ["shared/both.ts"] },
            { commit: "c1", files: ["src/other.ts", "docs/plan/x.md"] },
            { commit: "c0", files: [] },
        ]);
        const owners = (file: string) => ownerGuides(rules, file);
        expect(countCommits(commits, owners, "alpha")).toBe(2);
        expect(countCommits(commits, owners, "beta")).toBe(2);
        expect(countCommits(commits, owners, "area")).toBe(0);
    });

    it("gives a guide in an area folder the area's paths unless a rule names the guide", () => {
        const { rules } = parseOwnership(JSON.stringify({ rules: RULES }));
        expect(ownershipName(rules, "area/part")).toBe("area");
        expect(ownershipName(rules, "area")).toBe("area");
        expect(ownershipName(rules, "alpha")).toBe("alpha");
        expect(ownershipName(rules, "nowhere/part")).toBe("nowhere/part");
        const named = parseOwnership(JSON.stringify({ rules: [{ match: "src/x/**", guide: "area/part" }, ...RULES] }));
        expect(ownershipName(named.rules, "area/part")).toBe("area/part");
    });

    it("counts from the commit that added an unrecorded guide, and from the recorded commit once verified", () => {
        const { root, first } = repository();
        commit(root, { "src/alpha/a.ts": "2" });
        const second = commit(root, { "src/area/x.ts": "2", "shared/both.ts": "2" });
        commit(root, { "src/alpha/a.ts": "3", "docs/structure/alpha.md": "# Alpha\n\nEdited.\n" });
        commit(root, { "docs/structure/beta.md": "# Beta\n\nEdited.\n" });

        const added = (guide: string, commits: number) =>
            expect.objectContaining({ guide, state: "added", commit: first, commits });
        const verified = (guide: string, commits: number) =>
            expect.objectContaining({ guide, state: "verified", commit: second, commits });
        expect(dueReport(root)).toEqual([added("alpha", 3), added("area", 1), added("area/part", 1), added("beta", 1)]);

        expect(recordVerified(root, ["alpha", "area/part"], second)).toEqual({ alpha: second, "area/part": second });
        expect(readFileSync(path.join(root, VERIFIED_FILE), "utf8")).toBe(
            formatVerified({ alpha: second, "area/part": second }),
        );
        expect(dueReport(root)).toEqual([
            verified("alpha", 1),
            added("area", 1),
            added("beta", 1),
            verified("area/part", 0),
        ]);
        expect(dueReport(root, ["beta"])).toEqual([added("beta", 1)]);

        // A later record keeps the others.
        expect(recordVerified(root, ["beta"], first)).toEqual({ alpha: second, "area/part": second, beta: first });
    });

    it("reports a recorded commit the repository lacks and a guide in no commit, without a count", () => {
        const { root } = repository();
        write(root, { "docs/structure/fresh.md": "# Fresh\n" });
        recordVerified(root, ["alpha"], COMMIT_A);
        const rows = dueReport(root, ["alpha", "fresh"]);
        expect(rows).toEqual([
            { guide: "alpha", state: "unknown", commit: COMMIT_A, date: null, commits: null },
            { guide: "fresh", state: "uncommitted", commit: null, date: null, commits: null },
        ]);
        expect(formatDue(rows)).toBe(
            "alpha  recorded commit aaaaaaaaa is not in this repository\n" +
                "fresh  not committed yet, never verified\n" +
                "[docs:due] 2 guide(s), 0 with a verified record\n",
        );
    });

    it("skips merge commits and prints the rows most commits first", () => {
        const { root, first } = repository();
        git(root, "checkout", "--quiet", "-b", "side");
        commit(root, { "src/alpha/a.ts": "side" });
        git(root, "checkout", "--quiet", "-");
        commit(root, { "src/other.ts": "main" });
        git(root, "merge", "--quiet", "--no-ff", "--no-gpg-sign", "-m", "merge", "side");
        expect(dueReport(root, ["alpha", "beta"])).toEqual([
            expect.objectContaining({ guide: "alpha", commits: 1 }),
            expect.objectContaining({ guide: "beta", commits: 1 }),
        ]);

        expect(
            formatDue([
                { guide: "alpha", state: "verified", commit: COMMIT_B, date: "2026-01-02", commits: 12 },
                { guide: "area/part", state: "added", commit: first, date: "2026-01-01", commits: 1 },
            ]),
        ).toBe(
            "alpha      12 commits since verified bbbbbbbbb 2026-01-02\n" +
                `area/part  1 commit since added ${first.slice(0, 9)} 2026-01-01, never verified\n` +
                "[docs:due] 2 guide(s), 1 with a verified record\n",
        );
    });
});
