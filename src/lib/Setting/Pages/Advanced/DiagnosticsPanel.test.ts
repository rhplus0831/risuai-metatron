// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Request history slice 9 (`docs/plan/request-history-diagnostics.md`, decision 6): the Diagnostics
// panel. The report is built on open and by Refresh, shown as text; Copy, Download, and Save act on
// the report shown (never a rebuilt one); only Save sends anything; every save answer and a failed
// copy become a fixed localized notice; the controls are disabled before a report exists and while
// a build or save runs.

const deps = vi.hoisted(() => ({
    createDiagnosticReport: vi.fn<() => Promise<string>>(),
    saveDiagnosticReport: vi.fn<(text: string) => Promise<unknown>>(),
    copyText: vi.fn<(text: string) => Promise<boolean>>(),
    downloadFile: vi.fn<(name: string, data: string) => Promise<void>>(),
}));
vi.mock("src/ts/diagnostics/report", () => ({
    createDiagnosticReport: () => deps.createDiagnosticReport(),
    saveDiagnosticReport: (text: string) => deps.saveDiagnosticReport(text),
}));
vi.mock("src/lib/Others/RequestLogs/requestLogView", () => ({
    copyText: (text: string) => deps.copyText(text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    downloadFile: (name: string, data: string) => deps.downloadFile(name, data),
}));

import { language } from "src/lang";
import DiagnosticsPanel from "./DiagnosticsPanel.svelte";

const REPORT_A = "Metatron diagnostic report v1\nServer: current\n\n";
const REPORT_B = "Metatron diagnostic report v1\nServer: unavailable\n\n";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
}
/** Lets the pending microtasks run (the timers are fake) and the view settle. */
const settle = async () => {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
};

let target: HTMLElement;
const mounted: object[] = [];
beforeEach(() => {
    vi.useFakeTimers();
    deps.createDiagnosticReport.mockReset();
    deps.saveDiagnosticReport.mockReset();
    deps.copyText.mockReset();
    deps.downloadFile.mockReset();
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    target.remove();
    vi.useRealTimers();
});

function open() {
    mounted.push(mount(DiagnosticsPanel, { target }));
    flushSync();
    const button = (label: string) =>
        [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;
    return {
        button,
        refresh: () => button(language.diagnosticsRefresh),
        copy: () => button(language.diagnosticsCopy) ?? button(language.diagnosticsCopied),
        download: () => button(language.diagnosticsDownload),
        save: () => button(language.diagnosticsSave) ?? button(language.diagnosticsSaving),
        report: () => target.querySelector("pre")?.textContent ?? null,
        text: () => target.textContent ?? "",
    };
}

describe("DiagnosticsPanel", () => {
    it("builds the report on open and shows it as text; before it exists Copy, Download, and Save are disabled, and the server notice follows the report", async () => {
        const first = deferred<string>();
        deps.createDiagnosticReport.mockReturnValueOnce(first.promise);
        const panel = open();
        expect(deps.createDiagnosticReport).toHaveBeenCalledTimes(1);
        expect(panel.text()).toContain(language.diagnosticsBuilding);
        expect(panel.report()).toBeNull();
        expect(panel.refresh()!.disabled).toBe(true);
        expect(panel.copy()!.disabled).toBe(true);
        expect(panel.download()!.disabled).toBe(true);
        expect(panel.save()!.disabled).toBe(true);
        first.resolve(REPORT_B);
        await settle();
        expect(panel.report()).toBe(REPORT_B);
        expect(panel.text()).not.toContain(language.diagnosticsBuilding);
        expect(panel.text()).toContain(language.diagnosticsServerUnavailable);
        for (const control of [panel.refresh(), panel.copy(), panel.download(), panel.save()]) {
            expect(control!.disabled).toBe(false);
        }
        expect(deps.saveDiagnosticReport).not.toHaveBeenCalled();
        expect(deps.copyText).not.toHaveBeenCalled();
        expect(deps.downloadFile).not.toHaveBeenCalled();
    });

    it("Refresh builds again (one build at a time), replaces the text, and clears the notice", async () => {
        deps.createDiagnosticReport.mockResolvedValueOnce(REPORT_A);
        const panel = open();
        await settle();
        expect(panel.report()).toBe(REPORT_A);
        expect(panel.text()).not.toContain(language.diagnosticsServerUnavailable);
        deps.saveDiagnosticReport.mockResolvedValueOnce({ ok: false, failure: "network", status: null });
        panel.save()!.click();
        await settle();
        expect(panel.text()).toContain(language.diagnosticsSaveNetwork);
        const second = deferred<string>();
        deps.createDiagnosticReport.mockReturnValueOnce(second.promise);
        panel.refresh()!.click();
        flushSync();
        expect(panel.text()).not.toContain(language.diagnosticsSaveNetwork);
        expect(panel.refresh()!.disabled).toBe(true);
        expect(panel.save()!.disabled).toBe(true);
        // The report shown stays until the new one is built; a second click does nothing.
        expect(panel.report()).toBe(REPORT_A);
        panel.refresh()!.click();
        expect(deps.createDiagnosticReport).toHaveBeenCalledTimes(2);
        second.resolve(REPORT_B);
        await settle();
        expect(panel.report()).toBe(REPORT_B);
        expect(panel.text()).toContain(language.diagnosticsServerUnavailable);
    });

    it("Copy copies the report shown and says so briefly, or says it could not; Download hands the report shown to `downloadFile` under a stamped name", async () => {
        deps.createDiagnosticReport.mockResolvedValueOnce(REPORT_A);
        const panel = open();
        await settle();
        deps.copyText.mockResolvedValueOnce(true);
        panel.copy()!.click();
        await settle();
        expect(deps.copyText).toHaveBeenCalledWith(REPORT_A);
        expect(panel.button(language.diagnosticsCopied)).not.toBeNull();
        await vi.advanceTimersByTimeAsync(1500);
        flushSync();
        expect(panel.button(language.diagnosticsCopied)).toBeNull();
        expect(panel.button(language.diagnosticsCopy)).not.toBeNull();
        deps.copyText.mockResolvedValueOnce(false);
        panel.copy()!.click();
        await settle();
        expect(panel.button(language.diagnosticsCopied)).toBeNull();
        expect(panel.text()).toContain(language.diagnosticsCopyFailed);
        deps.downloadFile.mockResolvedValueOnce(undefined);
        panel.download()!.click();
        await settle();
        expect(deps.downloadFile).toHaveBeenCalledTimes(1);
        const [name, data] = deps.downloadFile.mock.calls[0];
        expect(name).toMatch(/^metatron-diagnostics-\d{8}T\d{9}Z\.txt$/);
        expect(data).toBe(REPORT_A);
        expect(deps.createDiagnosticReport).toHaveBeenCalledTimes(1);
        expect(deps.saveDiagnosticReport).not.toHaveBeenCalled();
    });

    it("Save sends the report shown once, disables Save and Refresh meanwhile, and shows the saved name or the fixed message of each failure", async () => {
        deps.createDiagnosticReport.mockResolvedValueOnce(REPORT_A);
        const panel = open();
        await settle();
        const pending = deferred<unknown>();
        deps.saveDiagnosticReport.mockReturnValueOnce(pending.promise);
        panel.save()!.click();
        flushSync();
        expect(deps.saveDiagnosticReport).toHaveBeenCalledWith(REPORT_A);
        expect(panel.button(language.diagnosticsSaving)).not.toBeNull();
        expect(panel.save()!.disabled).toBe(true);
        expect(panel.refresh()!.disabled).toBe(true);
        expect(panel.copy()!.disabled).toBe(false);
        panel.save()!.click();
        panel.refresh()!.click();
        expect(deps.saveDiagnosticReport).toHaveBeenCalledTimes(1);
        expect(deps.createDiagnosticReport).toHaveBeenCalledTimes(1);
        pending.resolve({ ok: true, name: "20261013T101500123Z-0123abcd.txt" });
        await settle();
        expect(panel.text()).toContain(
            language.diagnosticsSaved.replace("{{name}}", "20261013T101500123Z-0123abcd.txt"),
        );
        expect(panel.save()!.disabled).toBe(false);
        expect(panel.refresh()!.disabled).toBe(false);

        const answers: [unknown, string][] = [
            [{ ok: true, name: null }, language.diagnosticsSavedNoName],
            [{ ok: false, failure: "refused", status: 400 }, language.diagnosticsSaveRefused],
            [{ ok: false, failure: "tooLarge", status: 413 }, language.diagnosticsSaveTooLarge],
            [{ ok: false, failure: "unavailable", status: 503 }, language.diagnosticsSaveUnavailable],
            [
                { ok: false, failure: "failed", status: 500 },
                language.diagnosticsSaveFailed.replace("{{status}}", "500"),
            ],
            [{ ok: false, failure: "failed", status: null }, language.diagnosticsSaveFailed.replace("{{status}}", "?")],
            [{ ok: false, failure: "network", status: null }, language.diagnosticsSaveNetwork],
            [{ ok: false, failure: "timeout", status: null }, language.diagnosticsSaveUnconfirmed],
        ];
        for (const [answer, notice] of answers) {
            deps.saveDiagnosticReport.mockResolvedValueOnce(answer);
            panel.save()!.click();
            await settle();
            expect(panel.text()).toContain(notice);
        }
        expect(deps.saveDiagnosticReport).toHaveBeenCalledTimes(1 + answers.length);
        for (const call of deps.saveDiagnosticReport.mock.calls) {
            expect(call[0]).toBe(REPORT_A);
        }
        expect(panel.text()).not.toContain("{{");
    });
});
