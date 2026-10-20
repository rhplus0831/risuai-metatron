import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamImportReport } from "../../shared/upstreamBackup.ts";

// The upstream import's report dialog (`alert.ts` `alertUpstreamImportReport`, rendered by
// `UpstreamImportReport.svelte`): the full replace is authorized only by that dialog's own Restore
// answer. Any other way the alert store leaves the dialog (another alert replacing it, a plain
// confirmation answered "yes" meanwhile) resolves false. The real module, with the shared alert
// store as a plain writable and fake timers for `waitAlert`'s polling.

const { alertStore } = vi.hoisted(() => ({ alertStore: { current: null as any } }));

vi.mock("./stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    alertStore.current = writable({ type: "none", msg: "" });
    return { alertStore: alertStore.current };
});
vi.mock("./storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../lang", () => ({ language: { errors: {} } }));
vi.mock("./util", () => ({ sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }));

import { alertConfirm, alertUpstreamImportReport, upstreamImportReportStore } from "./alert";

const report: UpstreamImportReport = {
    counts: {
        promptPresets: 1,
        modelPresets: 1,
        modelProfiles: 0,
        credentials: 0,
        personas: 1,
        customModels: 0,
        modules: 0,
        plugins: 0,
        characters: 2,
        groups: 0,
        chats: 3,
        messages: 9,
    },
    converted: [],
    excluded: [],
    missingAssets: [],
};

/** Whether `promise` settled, after the alert poll ran. */
async function answered(promise: Promise<boolean>): Promise<boolean | null> {
    let value: boolean | null = null;
    void promise.then((result) => (value = result));
    await vi.advanceTimersByTimeAsync(50);
    return value;
}

beforeEach(() => {
    vi.useFakeTimers();
    alertStore.current.set({ type: "none", msg: "" });
});
afterEach(() => {
    vi.useRealTimers();
});

describe("alertUpstreamImportReport", () => {
    it("shows the report and resolves true only through the dialog's own Restore answer", async () => {
        const pending = alertUpstreamImportReport(report);
        expect(get(alertStore.current)).toEqual({ type: "upstreamImportReport", msg: "" });
        const dialog = get(upstreamImportReportStore)!;
        expect(dialog.report).toBe(report);
        expect(dialog.changedWrites).toBeNull();
        expect(await answered(pending)).toBeNull();
        // The component: the dialog's answer, then the alert cleared.
        dialog.answer(true);
        alertStore.current.set({ type: "none", msg: "" });
        expect(await answered(pending)).toBe(true);
        expect(get(upstreamImportReportStore)).toBeNull();
    });

    it("resolves false for Cancel, and carries the changed-since-review count to the dialog", async () => {
        const pending = alertUpstreamImportReport(report, { changedWrites: 3 });
        const dialog = get(upstreamImportReportStore)!;
        expect(dialog.changedWrites).toBe(3);
        dialog.answer(false);
        alertStore.current.set({ type: "none", msg: "" });
        expect(await answered(pending)).toBe(false);
    });

    it("resolves false when another confirmation replaces the dialog and is answered yes", async () => {
        const pending = alertUpstreamImportReport(report);
        // A plugin's or any other confirmation shown meanwhile, answered with the generic "yes".
        const other = alertConfirm("something else?");
        expect(get(alertStore.current)).toEqual({ type: "ask", msg: "something else?" });
        alertStore.current.set({ type: "none", msg: "yes" });
        expect(await answered(other)).toBe(true);
        expect(await answered(pending)).toBe(false);
        expect(get(upstreamImportReportStore)).toBeNull();
    });

    it("resolves false when the alert is simply cleared", async () => {
        const pending = alertUpstreamImportReport(report);
        alertStore.current.set({ type: "none", msg: "yes" });
        expect(await answered(pending)).toBe(false);
    });
});
