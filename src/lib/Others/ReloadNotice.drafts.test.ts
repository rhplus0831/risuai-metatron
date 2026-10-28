import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { alertReloadNotice, dismissReloadNotice, reloadNotice } from "src/ts/alert";
import { recoveryDrafts } from "src/ts/storage/recoveryDrafts.svelte";
import type { DraftEntry } from "src/ts/storage/draftJournal";
import ReloadNotice from "./ReloadNotice.svelte";

const NOW = Date.UTC(2026, 9, 28, 12);
let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
const draft: DraftEntry = {
    format: 1,
    type: "draft",
    id: "recovered",
    epoch: "previous-epoch",
    scope: "record",
    target: "ui\0main",
    createdAt: NOW - 60_000,
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
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

it("reactively links to the recovery dialog without a conflict and keeps drafts through review and independent dismissals", () => {
    expect(target.querySelector('[role="status"]')).toBeNull();
    recoveryDrafts.replace([draft], "current-epoch");
    flushSync();
    expect(target.textContent).toContain(language.resourceRecoveryDrafts);
    expect(buttons().map((button) => button.textContent?.trim())).toEqual([
        language.recoveryDrafts.review,
        language.resourceNoticeDismiss,
    ]);
    click(language.recoveryDrafts.review);
    expect(recoveryDrafts.isOpen).toBe(true);
    expect(target.querySelector('[role="dialog"]')).not.toBeNull();
    expect(target.textContent).toContain(language.recoveredChanges);
    // The notice's drafts part would cover the dialog's header; it waits until the dialog closes.
    expect(buttons().some((button) => button.textContent?.trim() === language.recoveryDrafts.review)).toBe(false);
    recoveryDrafts.close();
    flushSync();
    expect(target.querySelector('[role="dialog"]')).toBeNull();
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

    // The dialog still opens after the notice was dismissed (the Settings row opens it).
    void recoveryDrafts.open();
    flushSync();
    expect(target.querySelector('[role="dialog"]')).not.toBeNull();
    recoveryDrafts.close();
    flushSync();
});
