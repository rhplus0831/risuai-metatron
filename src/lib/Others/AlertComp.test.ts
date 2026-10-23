// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { alertData } from "src/ts/alert";
import { NEXT_DIALOG_GAP_MS, type AlertDialog } from "src/ts/alertQueue";
import { initHotkey } from "src/ts/hotkey";
import { alertStore, settingsOpen } from "src/ts/stores.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import AlertComp from "./AlertComp.svelte";

const dialogs: AlertDialog[] = [];
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let composer: HTMLTextAreaElement;

function open(data: alertData) {
    const dialog = alertStore.open(data);
    dialogs.push(dialog);
    return dialog;
}

async function showAlert() {
    component = mount(AlertComp, { target });
    flushSync();
    await tick();
}

async function hideAlert() {
    if (component) {
        await unmount(component);
        component = undefined;
    }
    await tick();
}

function dialogPanel() {
    const panel = target.querySelector<HTMLDivElement>("[data-alert-dialog] > div");
    expect(panel).not.toBeNull();
    return panel!;
}

function stroke(key: string) {
    const active = document.activeElement!;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    active.dispatchEvent(event);
    active.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return event;
}

beforeAll(() => {
    initHotkey();
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installFlatDatabase({ characters: [], botPresets: [{ id: "preset", name: "Preset" }] });
    settingsOpen.set(false);
    window.dispatchEvent(new Event("blur"));
    target = document.createElement("div");
    composer = document.createElement("textarea");
    composer.className = "text-input-area";
    document.body.append(composer, target);
    composer.focus();
});

afterEach(async () => {
    for (const dialog of dialogs.splice(0)) dialog.cancel();
    alertStore.clearStatus();
    await hideAlert();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    document.body.replaceChildren();
    window.dispatchEvent(new Event("blur"));
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("alert dialog focus and keyboard answers", () => {
    it.each([
        ["Enter", "yes"],
        ["Escape", ""],
    ])("takes focus from the composer so a fresh %s answers an ask dialog, then returns focus", async (key, answer) => {
        expect(document.activeElement).toBe(composer);
        const dialog = open({ type: "ask", msg: "Continue?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());

        expect(stroke(key).defaultPrevented).toBe(true);
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(dialog.closed).resolves.toBe(answer);
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });

    it("returns focus to the original composer only after the queued dialogs finish, across unmounts", async () => {
        const first = open({ type: "normal", msg: "First notice" });
        const second = open({ type: "pluginconfirm", msg: "Allow plugin?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        stroke("Enter");
        expect(alertStore.dialogVisible()).toBe(false);
        await expect(first.closed).resolves.toBe("yes");

        // App unmounts AlertComp while the queue publishes type "none" between dialogs.
        await hideAlert();
        expect(alertStore.hasDialogs()).toBe(true);
        expect(document.activeElement).not.toBe(composer);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        stroke("Escape");
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(second.closed).resolves.toBe("");
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });

    it("preserves focus moved elsewhere before the last dialog closes", async () => {
        const dialog = open({ type: "ask", msg: "Continue?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        const other = document.createElement("input");
        document.body.append(other);
        other.focus();
        dialog.cancel();
        await expect(dialog.closed).resolves.toBe("");
        await hideAlert();
        expect(document.activeElement).toBe(other);
    });

    it("leaves the composer focused when wait, wait2, and progress overlays appear", async () => {
        for (const type of ["wait", "wait2", "progress"] as const) {
            const data = { type, msg: "Working", submsg: "50" };
            if (type === "wait2") open(data);
            else alertStore.set(data);
            await showAlert();
            expect(document.activeElement).toBe(composer);
            // wait2 is queued, although its invisible status panel must not take focus.
            alertStore.answer("");
            alertStore.clearStatus();
            await hideAlert();
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        }
    });

    it.each([
        ["Enter", "Edited answer"],
        ["Escape", ""],
    ])("focuses an input dialog's own field and answers a fresh %s there", async (key, answer) => {
        const dialog = open({ type: "input", msg: "Name", defaultValue: "Initial answer" });
        await showAlert();
        const input = target.querySelector<HTMLInputElement>("#alert-input")!;
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);

        composer.focus();
        expect(stroke("Enter").defaultPrevented).toBe(false);
        expect(alertStore.dialogVisible()).toBe(true);
        input.focus();
        input.value = "Edited answer";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await tick();
        expect(stroke(key).defaultPrevented).toBe(true);
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(dialog.closed).resolves.toBe(answer);
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });
});
