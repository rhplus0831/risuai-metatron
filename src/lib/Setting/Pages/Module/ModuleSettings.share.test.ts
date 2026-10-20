// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertQueue, type AlertQueue } from "src/ts/alertQueue";

// Slice 3b: the share button awaits the exporter and clears a wait it left behind. The exporters
// themselves (and their own failure alerts) are covered by src/ts/exportBatches.test.ts. The alert
// store is the real queue (RisuNest small wins slice A1), a fresh one per test: a stale wait or
// progress is a status the button clears; an error or success dialog is never closed by it.
const { exporters, alerts, store } = vi.hoisted(() => ({
    exporters: { exportModule: vi.fn(), exportModuleLegacy: vi.fn() },
    alerts: { error: vi.fn(), select: vi.fn() },
    store: { alertStore: null as unknown as AlertQueue },
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
vi.mock("src/ts/stores.svelte", () => ({
    alertStore: new Proxy({} as AlertQueue, { get: (_target, key) => Reflect.get(store.alertStore, key) }),
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertSelect: alerts.select,
        // As the real one: the status only, never a dialog.
        alertClear: () => store.alertStore.clearStatus(),
    }),
);

import ModuleSettings from "./ModuleSettings.svelte";
import { language } from "src/lang";

let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.alertStore = createAlertQueue({ type: "none", msg: "" }, { gapMs: 0 });
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

const WAIT = { type: "wait", msg: "Loading... (Adding Assets 3 / 10)" } as const;
const share = () => target.querySelector<HTMLButtonElement>(`button[data-tip="${language.download}"]`)!;
const alert = () => get(store.alertStore);
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
            store.alertStore.set({ type: type as "wait" | "progress", msg: "Loading..." });
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
        ["the exporter's error alert", { type: "error", msg: "getItem Error" } as const],
        ["the success alert", { type: "normal", msg: language.successExport } as const],
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
        // The dialog is still open for its caller: the status clear did not answer it.
        expect(store.alertStore.dialogVisible()).toBe(true);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("clears a stale wait held behind the exporter's own dialog without closing that dialog", async () => {
        // A wait set after the dialog opened stays as the status behind it; the share button clears it.
        alerts.select.mockResolvedValue("0");
        const final = { type: "normal", msg: language.successExport } as const;
        exporters.exportModule.mockImplementation(async () => {
            store.alertStore.set(final);
            store.alertStore.set(WAIT);
        });
        share().click();
        await vi.waitFor(() => expect(exporters.exportModule).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(alert()).toEqual(final);
        expect(store.alertStore.status()).toBeNull();
        store.alertStore.answer("");
        expect(alert()).toEqual({ type: "none", msg: "" });
    });
});
