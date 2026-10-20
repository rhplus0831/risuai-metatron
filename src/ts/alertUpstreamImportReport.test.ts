import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamImportReport } from "../../shared/upstreamBackup.ts";
import { createAlertQueue, type AlertQueue } from "./alertQueue";

// The upstream import's report dialog (`alert.ts` `alertUpstreamImportReport`, rendered by
// `UpstreamImportReport.svelte`): the full replace is authorized only by that dialog's own Restore
// answer. Closing it any other way (a generic "yes" close, a clear) resolves false, and another
// confirmation opened meanwhile waits its turn instead of answering it. The real module over the real
// alert queue, a fresh one per test so a dialog one test leaves open never reaches the next.

const { alertStore } = vi.hoisted(() => ({ alertStore: { current: null as unknown as AlertQueue } }));

vi.mock("./stores.svelte", () => ({
    alertStore: new Proxy({} as AlertQueue, { get: (_target, key) => Reflect.get(alertStore.current, key) }),
}));
vi.mock("./storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../lang", () => ({ language: { errors: {} } }));

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

/** What `promise` resolved with once the pending tasks ran, or null while it is pending. */
async function answered<T>(promise: Promise<T>): Promise<T | null> {
    let value: T | null = null;
    void promise.then((result) => (value = result));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return value;
}

beforeEach(() => {
    alertStore.current = createAlertQueue({ type: "none", msg: "" }, { gapMs: 0 });
});

describe("alertUpstreamImportReport", () => {
    it("shows the report and resolves true only through the dialog's own Restore answer", async () => {
        const pending = alertUpstreamImportReport(report);
        expect(get(alertStore.current)).toEqual({ type: "upstreamImportReport", msg: "" });
        const dialog = get(upstreamImportReportStore)!;
        expect(dialog.report).toBe(report);
        expect(dialog.changedWrites).toBeNull();
        expect(await answered(pending)).toBeNull();
        // The component: the dialog's answer, then its close.
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

    it("keeps another confirmation queued behind it, and a generic yes close never restores", async () => {
        const pending = alertUpstreamImportReport(report);
        // A plugin's or any other confirmation opened meanwhile waits behind the report.
        const other = alertConfirm("something else?");
        expect(get(alertStore.current)).toEqual({ type: "upstreamImportReport", msg: "" });
        alertStore.current.set({ type: "none", msg: "yes" });
        expect(await answered(pending)).toBe(false);
        expect(get(upstreamImportReportStore)).toBeNull();
        // The confirmation shows next and answers only itself.
        expect(get(alertStore.current)).toEqual({ type: "ask", msg: "something else?" });
        expect(await answered(other)).toBeNull();
        alertStore.current.set({ type: "none", msg: "yes" });
        expect(await answered(other)).toBe(true);
    });

    it("resolves false when the dialog is cancelled before it is answered", async () => {
        const pending = alertUpstreamImportReport(report);
        alertStore.current.answer("");
        expect(await answered(pending)).toBe(false);
        expect(get(upstreamImportReportStore)).toBeNull();
    });
});
