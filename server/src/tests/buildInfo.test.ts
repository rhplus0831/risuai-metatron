// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNKNOWN_BUILD } from "../../../shared/buildInfo.ts";
import { type GitRunner, readServerBuildInfo, resolveBuildInfo } from "../buildInfo.ts";

const COMMIT = "a9fa6f8c5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a";

const dirs: string[] = [];
const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-build-info-"));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A git that answers each subcommand from `answers` and records what it was asked. */
const fakeGit = (answers: Record<string, string>) => {
    const calls: { args: string[]; cwd: string }[] = [];
    const git: GitRunner = (args, cwd) => {
        calls.push({ args, cwd });
        const answer = answers[args[0]];
        if (answer === undefined) {
            throw new Error(`git ${args[0]} failed`);
        }
        return answer;
    };
    return { git, calls };
};

describe("resolveBuildInfo", () => {
    it("takes RISU_BUILD_COMMIT, RISU_BUILD_DATE, and RISU_BUILD_DIRTY over git, trimmed and lowercased", () => {
        const { git, calls } = fakeGit({ "rev-parse": "f".repeat(40), log: "2020-01-01", status: " M x" });
        const env = { RISU_BUILD_COMMIT: ` ${COMMIT.toUpperCase()}\n`, RISU_BUILD_DATE: "2026-10-26 " };
        expect(resolveBuildInfo("/repo", env, git)).toEqual({ commit: COMMIT, date: "2026-10-26", dirty: false });
        expect(resolveBuildInfo("/repo", { ...env, RISU_BUILD_DIRTY: "true\n" }, git).dirty).toBe(true);
        expect(resolveBuildInfo("/repo", { ...env, RISU_BUILD_DIRTY: "" }, git).dirty).toBe(false);
        expect(resolveBuildInfo("/repo", { RISU_BUILD_COMMIT: COMMIT }, git)).toEqual({
            commit: COMMIT,
            date: null,
            dirty: false,
        });
        expect(calls).toEqual([]);
        expect(resolveBuildInfo("/repo", { RISU_BUILD_COMMIT: "not-a-hash" }, git)).toEqual(UNKNOWN_BUILD);
    });

    it("asks git in the root for HEAD, its committer date, and the status when the environment has no commit", () => {
        const { git, calls } = fakeGit({ "rev-parse": COMMIT, log: "2026-10-26", status: "" });
        expect(resolveBuildInfo("/repo", { RISU_BUILD_COMMIT: "  " }, git)).toEqual({
            commit: COMMIT,
            date: "2026-10-26",
            dirty: false,
        });
        expect(calls.map((call) => call.cwd)).toEqual(["/repo", "/repo", "/repo"]);
        const dirty = fakeGit({ "rev-parse": COMMIT, log: "2026-10-26", status: "?? new.ts" });
        expect(resolveBuildInfo("/repo", {}, dirty.git).dirty).toBe(true);
    });

    it("is unknown when git fails at any step", () => {
        for (const missing of ["rev-parse", "log", "status"]) {
            const answers: Record<string, string> = { "rev-parse": COMMIT, log: "2026-10-26", status: "" };
            delete answers[missing];
            expect(resolveBuildInfo("/repo", {}, fakeGit(answers).git)).toEqual(UNKNOWN_BUILD);
        }
    });

    it("asks a real git the right questions: the commit, the committer's own date, and dirty after an edit", () => {
        const dir = tempDir();
        const env = {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.invalid",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.invalid",
            // Late on the 26th at +09:00 is the 26th for `%cs` on any machine (the 26th 14:30 UTC).
            GIT_COMMITTER_DATE: "2026-10-26T23:30:00+09:00",
        };
        const run = (...args: string[]) =>
            execFileSync("git", args, { cwd: dir, env, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
        run("init", "-q");
        writeFileSync(path.join(dir, "a.txt"), "a");
        run("add", "a.txt");
        run("commit", "-q", "--no-gpg-sign", "-m", "a");
        const head = run("rev-parse", "HEAD").trim();
        // Real git without the production timeout, so a slow machine cannot turn the answer unknown.
        const git: GitRunner = (args, cwd) => {
            expect(cwd).toBe(dir);
            return run(...args).trim();
        };

        expect(resolveBuildInfo(dir, {}, git)).toEqual({ commit: head, date: "2026-10-26", dirty: false });
        writeFileSync(path.join(dir, "a.txt"), "b");
        expect(resolveBuildInfo(dir, {}, git).dirty).toBe(true);
    });
});

describe("readServerBuildInfo", () => {
    const checkout = { commit: "f".repeat(40), date: "2020-01-01", dirty: false };
    const counted = () => {
        let calls = 0;
        return {
            fallback: () => {
                calls++;
                return checkout;
            },
            calls: () => calls,
        };
    };

    it("reports dist/build-info.json, the build the server serves, read again after a build replaced it", () => {
        const dir = tempDir();
        mkdirSync(path.join(dir, "dist"));
        const file = path.join(dir, "dist", "build-info.json");
        writeFileSync(file, JSON.stringify({ commit: COMMIT, date: "2026-10-26", dirty: true }));
        const { fallback, calls } = counted();
        expect(readServerBuildInfo(dir, fallback)).toEqual({ commit: COMMIT, date: "2026-10-26", dirty: true });
        writeFileSync(file, JSON.stringify({ commit: "b".repeat(40), date: "2026-10-27", dirty: false }));
        expect(readServerBuildInfo(dir, fallback)).toEqual({
            commit: "b".repeat(40),
            date: "2026-10-27",
            dirty: false,
        });
        expect(calls()).toBe(0);
    });

    it("is the checkout's build without the file, and unknown when the file is not JSON", () => {
        const dir = tempDir();
        const { fallback, calls } = counted();
        expect(readServerBuildInfo(dir, fallback)).toEqual(checkout);
        expect(calls()).toBe(1);
        mkdirSync(path.join(dir, "dist"));
        writeFileSync(path.join(dir, "dist", "build-info.json"), "{");
        expect(readServerBuildInfo(dir, fallback)).toEqual(UNKNOWN_BUILD);
        expect(calls()).toBe(1);
    });
});
