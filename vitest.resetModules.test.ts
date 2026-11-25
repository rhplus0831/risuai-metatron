import { describe, expect, it, vi } from "vitest";
import { keepsModule } from "./vitest.resetModules.ts";

// Pins the selective `vi.resetModules()` that `vitest.setup.ts` installs from `vitest.resetModules.ts`.
// It reads Vitest's worker state, so a Vitest upgrade that changes that state's shape leaves Vitest's
// full reset in place, and the "keeps" cases here fail.

/** One function of a client module, of a `shared/` module, and of a package the runner evaluates. */
const load = async () => ({
    client: (await import("src/ts/ime")).isImeComposing,
    shared: (await import("./shared/textHash.ts")).textHash,
    svelte: (await import("svelte")).tick,
});

describe("vi.resetModules", () => {
    it("re-evaluates a client module and keeps a shared module and a package", async () => {
        const before = await load();
        vi.resetModules();
        const after = await load();
        expect(after.client).not.toBe(before.client);
        expect(after.shared).toBe(before.shared);
        expect(after.svelte).toBe(before.svelte);
    });

    it.each(["doMock", "doUnmock"] as const)(
        "re-evaluates everything once after vi.%s, which changes what a kept module should import",
        async (change) => {
            const before = await load();
            if (change === "doMock") {
                vi.doMock("src/ts/cbs", () => ({}));
            } else {
                vi.doUnmock("src/ts/cbs");
            }
            vi.resetModules();
            const full = await load();
            expect(full.client).not.toBe(before.client);
            expect(full.shared).not.toBe(before.shared);
            expect(full.svelte).not.toBe(before.svelte);

            vi.resetModules();
            const selective = await load();
            expect(selective.client).not.toBe(full.client);
            expect(selective.shared).toBe(full.shared);
            expect(selective.svelte).toBe(full.svelte);
        },
    );
});

describe("keepsModule", () => {
    const root = "/work/app";

    it.each([
        ["/work/app/node_modules/.pnpm/svelte@5.0.0/node_modules/svelte/src/index-client.js", true],
        ["/work/app/shared/textHash.ts", true],
        ["/work/app/shared/llm/models.ts?raw", true],
        ["/work/app/shared/tests/fixture.ts", false],
        ["/work/app/shared/llm/tests/fixture.ts", false],
        ["/work/app/shared/llm/models.test.ts", false],
        ["/work/app/src/ts/storage/chatStore.svelte.ts", false],
        ["/work/app/src/shared/thing.ts", false],
        ["/work/app/server/src/app.ts", false],
        // Another checkout's `shared/` is not this project's.
        ["/work/other/shared/textHash.ts", false],
    ])("%s: %s", (id, kept) => {
        expect(keepsModule(id, root)).toBe(kept);
    });
});
