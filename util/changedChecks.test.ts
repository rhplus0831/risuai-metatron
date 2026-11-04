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
    it("skips both programs when nothing changed", () => {
        expect(typeCheckTargets([])).toEqual({ client: false, server: false });
    });

    it("skips both programs for docs, tooling outside the programs, and assets", () => {
        const files = ["STRUCTURE.md", "docs/structure/app-shell.md", "util/docsBudget.mjs", "e2e/a.spec.ts", "a.png"];
        expect(typeCheckTargets(files)).toEqual({ client: false, server: false });
    });

    it("runs only the client program for client-only paths", () => {
        expect(typeCheckTargets(["src/App.svelte"])).toEqual({ client: true, server: false });
        expect(typeCheckTargets(["tsconfig.json"])).toEqual({ client: true, server: false });
    });

    it("runs both programs for server and shared code, since the client imports both", () => {
        expect(typeCheckTargets(["server/src/main.ts"])).toEqual({ client: true, server: true });
        expect(typeCheckTargets(["shared/realmImport.ts"])).toEqual({ client: true, server: true });
    });

    it("runs both programs for dependency changes and unknown paths", () => {
        expect(typeCheckTargets(["pnpm-lock.yaml"])).toEqual({ client: true, server: true });
        expect(typeCheckTargets(["vitest.testNetwork.ts"])).toEqual({ client: true, server: true });
        expect(typeCheckTargets(["somewhere/new.ts"])).toEqual({ client: true, server: true });
    });
});
