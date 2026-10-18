// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 3b: the share button awaits the exporter and clears a wait it left behind. The exporters
// themselves (and their own failure alerts) are covered by src/ts/exportBatches.test.ts.
const { exporters, alerts, store } = vi.hoisted(() => ({
    exporters: { exportModule: vi.fn(), exportModuleLegacy: vi.fn() },
    alerts: { error: vi.fn(), select: vi.fn() },
    store: { alertStore: null as any },
}));

vi.mock("src/lib/Setting/Pages/Module/ModuleMenu.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/process/modules", () => ({ ...exporters, importModule: vi.fn() }));
vi.mock("src/ts/process/mcp/mcp", () => ({ importMCPModule: vi.fn() }));
vi.mock("src/ts/interchangeability", () => ({ convertModuleToCharacter: vi.fn() }));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ addCharacter: vi.fn() }));
vi.mock("src/ts/gui/tooltip", () => ({
    tooltip: (node: HTMLElement, tip: string) => {
        node.dataset.tip = tip;
    },
}));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: {
        modules: [{ id: "module-id", name: "Shared", description: "" }],
        enabledModules: [],
        ui: {},
    },
    activePreset: { modules: [] },
}));
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    store.alertStore = writable({ type: "none", msg: "" });
    return { alertStore: store.alertStore };
});
vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(),
    alertNormal: vi.fn(),
    alertError: alerts.error,
    alertSelect: alerts.select,
    alertClear: () => store.alertStore.set({ type: "none", msg: "" }),
}));

import ModuleSettings from "./ModuleSettings.svelte";
import { language } from "src/lang";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();
});
afterEach(async () => {
    await unmount(instance);
    target.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

const WAIT = { type: "wait", msg: "Loading... (Adding Assets 3 / 10)" };
const share = () => target.querySelector<HTMLButtonElement>(`button[data-tip="${language.download}"]`)!;
const alert = () => get(store.alertStore as ReturnType<typeof writable<{ type: string; msg: string }>>);
function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("module share button", () => {
    it.each([
        ["CharX", "0", "exportModule"],
        ["RisuM", "1", "exportModuleLegacy"],
    ] as const)("%s: waits for the export before clearing the wait it left", async (_label, choice, name) => {
        alerts.select.mockResolvedValue(choice);
        const gate = deferred();
        exporters[name].mockImplementation(async () => {
            store.alertStore.set(WAIT);
            await gate.promise;
        });
        share().click();
        await vi.waitFor(() => expect(exporters[name]).toHaveBeenCalledOnce());
        expect(exporters[name].mock.calls[0][0]).toMatchObject({ id: "module-id" });
        await Promise.resolve();
        // The export is still running: its wait alert stays.
        expect(alert()).toEqual(WAIT);
        gate.resolve();
        // An exporter that failed without replacing its wait (an `alertError` it ignored).
        await vi.waitFor(() => expect(alert().type).toBe("none"));
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it.each(["wait", "progress"])("a rejected export clears a stale %s alert and adds no error alert", async (type) => {
        alerts.select.mockResolvedValue("1");
        const failure = new Error("export failed");
        exporters.exportModuleLegacy.mockImplementation(async () => {
            store.alertStore.set({ type, msg: "Loading..." });
            throw failure;
        });
        share().click();
        // The alert starts as "none": wait for the failure to be caught before reading it.
        await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(failure));
        await vi.waitFor(() => expect(alert().type).toBe("none"));
        expect(alerts.error).not.toHaveBeenCalled();

        // The row stays usable: the next share runs a new export.
        exporters.exportModuleLegacy.mockImplementation(async () => {
            store.alertStore.set({ type: "normal", msg: language.successExport });
        });
        share().click();
        await vi.waitFor(() => expect(exporters.exportModuleLegacy).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(alert()).toEqual({ type: "normal", msg: language.successExport }));
    });

    it.each([
        ["the exporter's error alert", { type: "error", msg: "getItem Error" }],
        ["the success alert", { type: "normal", msg: language.successExport }],
    ])("keeps %s", async (_label, final) => {
        alerts.select.mockResolvedValue("0");
        exporters.exportModule.mockImplementation(async () => {
            store.alertStore.set(WAIT);
            store.alertStore.set(final);
        });
        share().click();
        await vi.waitFor(() => expect(exporters.exportModule).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(alert()).toEqual(final);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});
