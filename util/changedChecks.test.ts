// @vitest-environment node
import { describe, expect, it } from "vitest";
import { typeCheckTargets } from "./changedChecks.mjs";

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
