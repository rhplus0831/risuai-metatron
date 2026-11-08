// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./alert", async () => (await import("./tests/alertMock")).createAlertMock());
vi.mock("./storage/serverAuth", async () => (await import("./storage/tests/serverAuthMock")).createServerAuthMock());

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

it("aiLawApplies uses only the boolean disclosure flag captured when the page loads", async () => {
    for (const [flag, expected] of [
        [undefined, false],
        [true, true],
        ["true", false],
    ] as const) {
        vi.stubGlobal("__RISU_AI_DISCLOSURE__", flag);
        vi.resetModules();
        const { aiLawApplies } = await import("./globalApi.svelte");
        expect(aiLawApplies(), `page flag: ${String(flag)}`).toBe(expected);

        vi.stubGlobal("__RISU_AI_DISCLOSURE__", !expected);
        expect(aiLawApplies(), "the loaded page keeps its original flag").toBe(expected);
    }
});
