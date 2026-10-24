// @vitest-environment happy-dom
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NEXT_DIALOG_GAP_MS, type AlertDialog } from "./alertQueue";

vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { initHotkey } from "./hotkey";
import { installFlatDatabaseWithChats } from "./storage/tests/installFlatDatabase";
import { alertStore, settingsOpen } from "./stores.svelte";

const dialogs: AlertDialog[] = [];
const open = (type: "select" | "ask" = "select") => {
    const dialog = alertStore.open({ type, msg: "Continue?" });
    dialogs.push(dialog);
    return dialog;
};
function stroke(target: EventTarget, key: string, modifiers: KeyboardEventInit = {}) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...modifiers }));
}

beforeAll(() => initHotkey());
beforeEach(() => {
    vi.useFakeTimers();
    window.dispatchEvent(new Event("blur"));
    settingsOpen.set(false);
    installFlatDatabaseWithChats({
        characters: [],
        hotkeys: [
            { key: "Enter", ctrl: true, alt: true, action: "send" },
            { key: "k", ctrl: true, action: "settings" },
            { key: "q", action: "settings" },
        ],
    });
});
afterEach(async () => {
    for (const dialog of dialogs.splice(0)) dialog.cancel();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    alertStore.clearStatus();
    document.body.replaceChildren();
    window.dispatchEvent(new Event("blur"));
    vi.useRealTimers();
});

it("blocks stored plain and modifier hotkeys while a dialog is visible or queued, then restores them", async () => {
    const send = document.createElement("button");
    send.className = "button-icon-send";
    const sent = vi.fn();
    send.addEventListener("click", sent);
    const composer = document.createElement("textarea");
    document.body.append(send, composer);
    const shortcuts = () => {
        composer.focus();
        stroke(composer, "Enter", { ctrlKey: true, altKey: true });
        expect(sent).not.toHaveBeenCalled();
        composer.blur();
        stroke(document, "k", { ctrlKey: true });
        expect(get(settingsOpen)).toBe(false);
        stroke(document, "q");
        expect(get(settingsOpen)).toBe(false);
        expect(sent).not.toHaveBeenCalled();
    };

    const first = open();
    const second = open();
    expect(alertStore.dialogVisible()).toBe(true);
    shortcuts();
    first.cancel();
    expect(alertStore.dialogVisible()).toBe(false);
    expect(alertStore.hasDialogs()).toBe(true);
    shortcuts();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    expect(alertStore.dialogVisible()).toBe(true);
    shortcuts();
    second.cancel();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);

    composer.focus();
    stroke(composer, "Enter", { ctrlKey: true, altKey: true });
    expect(sent).toHaveBeenCalledOnce();
    composer.blur();
    stroke(document, "k", { ctrlKey: true });
    expect(get(settingsOpen)).toBe(true);
    stroke(document, "q");
    expect(get(settingsOpen)).toBe(false);
});

it.each(["input", "textarea"] as const)(
    "keeps Shift+Enter in a focused %s from answering an ask dialog",
    async (tag) => {
        const field = document.createElement(tag);
        document.body.append(field);
        field.focus();
        const dialog = open("ask");
        stroke(field, "Enter", { shiftKey: true });
        expect(alertStore.dialogVisible()).toBe(true);
        expect(get(alertStore).type).toBe("ask");

        field.blur();
        stroke(document, "Enter");
        await expect(dialog.closed).resolves.toBe("yes");
    },
);
