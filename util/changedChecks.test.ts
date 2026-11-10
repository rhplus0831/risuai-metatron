// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ownersLine, typeCheckTargets } from "./changedChecks.mjs";
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
