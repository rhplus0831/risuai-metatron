import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { alertReloadNotice, dismissReloadNotice, reloadNotice } from "src/ts/alert";
import { recoveryDrafts } from "src/ts/storage/recoveryDrafts.svelte";
import type { DraftEntry } from "src/ts/storage/draftJournal";
import ReloadNotice from "./ReloadNotice.svelte";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
const draft: DraftEntry = {
    format: 1,
    type: "draft",
    id: "recovered",
    epoch: "previous-epoch",
    scope: "record",
    target: "ui\0main",
    createdAt: 100,
    size: 20,
    layers: { latest: { version: 1, value: { op: "update", baseRevision: "old-base", text: '{"theme":"local"}' } } },
};
const buttons = () => [...target.querySelectorAll("button")];
const click = (label: string, index = 0) => {
    const matching = buttons().filter((button) => button.textContent?.trim() === label);
    expect(matching[index]).toBeDefined();
    matching[index].click();
    flushSync();
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    dismissReloadNotice();
    recoveryDrafts.replace([], "current-epoch");
    target = document.createElement("div");
    document.body.append(target);
    component = mount(ReloadNotice, { target });
    flushSync();
});
afterEach(async () => {
    if (component) await unmount(component);
    target.remove();
    recoveryDrafts.replace([], "current-epoch");
    dismissReloadNotice();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it("reactively offers Export without a conflict and keeps drafts through export and independent dismissals", async () => {
    expect(target.querySelector('[role="status"]')).toBeNull();
    recoveryDrafts.replace([draft], "current-epoch");
    flushSync();
    expect(target.textContent).toContain(language.resourceRecoveryDrafts);
    expect(buttons().map((button) => button.textContent?.trim())).toEqual([
        language.export,
        language.resourceNoticeDismiss,
    ]);
    const downloads: { blob: Blob; name?: string }[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        downloads.push({ blob: blob as Blob });
        return "blob:recovered-changes";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
        downloads.at(-1)!.name = this.download;
    });
    click(language.export);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("recovered-changes.json");
    const exported: unknown = JSON.parse(await downloads[0].blob.text());
    expect(exported).toEqual({ drafts: [{ ...draft, otherEpoch: true }] });
    expect(recoveryDrafts.entries).toEqual([{ ...draft, otherEpoch: true }]);
    expect(target.textContent).toContain(language.resourceRecoveryDrafts);

    alertReloadNotice("A remote conflict");
    flushSync();
    click(language.resourceNoticeDismiss, 0);
    expect(get(reloadNotice)).toBeNull();
    expect(target.textContent).toContain(language.resourceRecoveryDrafts);
    alertReloadNotice("Another remote conflict");
    flushSync();
    click(language.resourceNoticeDismiss, 1);
    expect(target.textContent).not.toContain(language.resourceRecoveryDrafts);
    expect(target.textContent).toContain("Another remote conflict");
    expect(get(reloadNotice)).toBe("Another remote conflict");
    expect(recoveryDrafts.entries).toHaveLength(1);
    click(language.resourceNoticeDismiss);
    expect(target.querySelector('[role="status"]')).toBeNull();
});
