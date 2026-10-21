import { beforeEach, describe, expect, it, vi } from "vitest";

// The app's entry on the self-host server (`src/boot.ts`) starts the diagnostics collector before
// any app module is even evaluated (`src/startApp.ts` is imported dynamically, after the start), so
// a failure while the app's modules load is already watched. Both modules are stubbed: what matters
// is the order.

const order = vi.hoisted(() => [] as string[]);

vi.mock("./ts/diagnostics/collector", () => {
    order.push("collector module");
    return {
        startDiagnosticsCollector: () => order.push("collector start"),
    };
});
vi.mock("./startApp", () => {
    order.push("startApp module");
    return {
        startApp: () => order.push("startApp"),
    };
});

beforeEach(() => {
    vi.resetModules();
    order.length = 0;
});

describe("boot", () => {
    it("starts the diagnostics collector, then loads and starts the app", async () => {
        const { boot } = await import("./boot");
        // Importing the entry evaluates the collector only: the app's modules are not loaded yet.
        expect(order).toEqual(["collector module"]);
        await boot();
        expect(order).toEqual(["collector module", "collector start", "startApp module", "startApp"]);
    });
});
