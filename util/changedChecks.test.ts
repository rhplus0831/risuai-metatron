// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownersLine, resolveBase, typeCheckTargets, typeCheckVerdict } from "./changedChecks.mjs";
import { parseOwnership } from "./docsOwner.mjs";

describe("ownersLine", () => {
    it("sorts and deduplicates all owning guides and lists only unowned paths under owned roots", () => {
        const { rules } = parseOwnership(
            JSON.stringify({
                rules: [
                    { match: "shared/session.ts", guide: "zeta", shared: true, part: "records" },
                    { match: "shared/session.ts", guide: "alpha", shared: true, part: "transport" },
                    { match: "src/owned/**", guide: "zeta" },
                    { match: "server/owned/**", guide: "beta" },
                ],
            }),
        );
        const files = [
            "shared/session.ts",
            "src/owned/main.ts",
            "server/owned/main.ts",
            "src/uncovered.ts",
            "server/uncovered.ts",
            "shared/uncovered.ts",
            "util/uncovered.mjs",
            "e2e/uncovered.spec.ts",
            "public/uncovered.svg",
            "docs/unowned.md",
        ];

        expect(ownersLine(rules, files)).toBe(
            "[changed] owners: alpha, beta, zeta; no owner: src/uncovered.ts, server/uncovered.ts, " +
                "shared/uncovered.ts, util/uncovered.mjs, e2e/uncovered.spec.ts, public/uncovered.svg",
        );
    });
});

describe("typeCheckTargets", () => {
    it("skips all programs when nothing changed", () => {
        expect(typeCheckTargets([])).toEqual({ client: false, server: false, e2e: false });
    });

    it("skips all programs for docs, static assets and Playwright runner configuration", () => {
        for (const file of ["STRUCTURE.md", "docs/structure/app-shell.md", "a.png", "playwright.config.ts"]) {
            expect(typeCheckTargets([file])).toEqual({ client: false, server: false, e2e: false });
        }
    });

    it.each(["e2e/fixtures.ts", "util/playwright/stack.mjs"])("selects only e2e for %s", (file) => {
        expect(typeCheckTargets([file])).toEqual({ client: false, server: false, e2e: true });
    });

    it("selects client and e2e for client sources and the inherited tsconfig", () => {
        expect(typeCheckTargets(["src/App.svelte"])).toEqual({ client: true, server: false, e2e: true });
        expect(typeCheckTargets(["tsconfig.json"])).toEqual({ client: true, server: false, e2e: true });
    });

    it("selects the app programs for server code and also e2e for shared code", () => {
        expect(typeCheckTargets(["server/src/main.ts"])).toEqual({ client: true, server: true, e2e: false });
        expect(typeCheckTargets(["shared/realmImport.ts"])).toEqual({ client: true, server: true, e2e: true });
    });

    it("selects only the client for public assets", () => {
        expect(typeCheckTargets(["public/style.css"])).toEqual({ client: true, server: false, e2e: false });
    });

    it("selects all programs for dependency changes and unknown paths", () => {
        expect(typeCheckTargets(["pnpm-lock.yaml"])).toEqual({ client: true, server: true, e2e: true });
        expect(typeCheckTargets(["vitest.testNetwork.ts"])).toEqual({ client: true, server: true, e2e: true });
        expect(typeCheckTargets(["somewhere/new.ts"])).toEqual({ client: true, server: true, e2e: true });
    });
});

describe("typeCheckVerdict", () => {
    it("passes with exit code 0 when every program exits 0", () => {
        const results = [
            { label: "svelte-check", code: 0 },
            { label: "tsc server", code: 0 },
            { label: "tsc e2e", code: 0 },
        ];

        expect(typeCheckVerdict("check", results, 35.44)).toEqual({
            code: 0,
            line: "[check] passed: 3 of 3 programs in 35.4 s",
        });
    });

    it("fails with exit code 1 and names every failed program, whichever one finished last", () => {
        const results = [
            { label: "svelte-check", code: 0 },
            { label: "tsc server", code: 2 },
            { label: "tsc e2e", code: 1 },
        ];

        expect(typeCheckVerdict("check", results, 35)).toEqual({
            code: 1,
            line: "[check] FAILED: tsc server (exit 2), tsc e2e (exit 1); 3 of 3 programs in 35.0 s",
        });
        expect(typeCheckVerdict("changed", [results[0], results[2]], 8).code).toBe(1);
    });

    it("counts the results replayed from the cache, in a pass and in a failure", () => {
        const results = [
            { label: "svelte-check", code: 0, replayed: true },
            { label: "tsc server", code: 2, replayed: true },
            { label: "tsc e2e", code: 0, replayed: false },
        ];

        expect(typeCheckVerdict("check", [results[0], results[2]], 7.3).line).toBe(
            "[check] passed: 2 of 3 programs in 7.3 s, 1 replayed from stored results (--force runs them)",
        );
        expect(typeCheckVerdict("check", results, 7.3)).toEqual({
            code: 1,
            line:
                "[check] FAILED: tsc server (exit 2); 3 of 3 programs in 7.3 s, " +
                "2 replayed from stored results (--force runs them)",
        });
    });

    it("counts only the programs that ran and passes when none had to", () => {
        expect(typeCheckVerdict("changed", [{ label: "tsc e2e", code: 0 }], 7.3).line).toBe(
            "[changed] passed: 1 of 3 programs in 7.3 s",
        );
        expect(typeCheckVerdict("changed", [], 0)).toEqual({ code: 0, line: "[changed] no program to run" });
    });
});

describe("resolveBase", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function git(root: string, ...args: string[]) {
        return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
            cwd: root,
            encoding: "utf8",
            stdio: "pipe",
            env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" },
        }).trim();
    }

    function commit(root: string, text: string) {
        writeFileSync(path.join(root, "file.txt"), text);
        git(root, "add", "--", ".");
        git(root, "commit", "--quiet", "--no-gpg-sign", "-m", text);
        return git(root, "rev-parse", "HEAD");
    }

    /** A `work` branch one commit past local `dev`, which is one commit past `origin/dev`. */
    function repository() {
        const root = mkdtempSync(path.join(os.tmpdir(), "risu-changed-checks-"));
        roots.push(root);
        git(root, "init", "--quiet", "--initial-branch=dev");
        const pushed = commit(root, "pushed");
        git(root, "update-ref", "refs/remotes/origin/dev", pushed);
        const local = commit(root, "local");
        git(root, "checkout", "--quiet", "-b", "work");
        const work = commit(root, "work");
        return { root, pushed, local, work };
    }

    it("defaults to the merge base with local dev, not with origin/dev behind it", () => {
        const { root, local } = repository();

        expect(resolveBase(root, undefined)).toBe(local);
    });

    it("falls back to origin/dev without a local dev, then to HEAD without either", () => {
        const { root, pushed, work } = repository();

        git(root, "branch", "--quiet", "-D", "dev");
        expect(resolveBase(root, undefined)).toBe(pushed);
        git(root, "update-ref", "-d", "refs/remotes/origin/dev");
        expect(resolveBase(root, undefined)).toBe(work);
    });

    it("does not take a tag named dev for the branch", () => {
        const { root, pushed, local } = repository();

        git(root, "tag", "dev", pushed);
        expect(resolveBase(root, undefined)).toBe(local);
    });

    it("resolves an explicit base to its commit", () => {
        const { root, pushed, work } = repository();

        expect(resolveBase(root, "origin/dev")).toBe(pushed);
        expect(resolveBase(root, "HEAD")).toBe(work);
    });
});
