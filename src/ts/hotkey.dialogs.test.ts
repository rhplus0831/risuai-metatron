// @vitest-environment happy-dom
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { NEXT_DIALOG_GAP_MS, type AlertDialog } from "./alertQueue";

vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { initHotkey } from "./hotkey";
import { hostMode } from "./network/remoteHost";
import { alertConfirmWithCheckbox, alertConfirmWithChecklist, openAlertDialog } from "./alert";
import { selection, selectPreset } from "./storage/selection.svelte";
import { installFlatDatabaseWithChats } from "./storage/tests/installFlatDatabase";
import {
    alertStore,
    chatBindingDialog,
    gridOpenStore,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    settingsOpen,
} from "./stores.svelte";

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
    hostMode.set(false);
    localStorage.removeItem("risu-remote-host");
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
    hostMode.set(false);
    localStorage.removeItem("risu-remote-host");
    openPersonaList.set(false);
    openModelPresetList.set(false);
    openPresetList.set(false);
    chatBindingDialog.set(null);
    settingsOpen.set(false);
    gridOpenStore.set(false);
    for (const dialog of dialogs.splice(0)) dialog.cancel();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    alertStore.clearStatus();
    document.body.replaceChildren();
    window.dispatchEvent(new Event("blur"));
    vi.useRealTimers();
});

it("host mode blocks stored hotkeys, preset shortcuts, and Escape closing app layers", async () => {
    installFlatDatabaseWithChats({
        characters: [],
        botPresets: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ],
        hotkeys: [{ key: "k", ctrl: true, action: "settings" }],
    });
    selectPreset("b");
    hostMode.set(true);

    stroke(document, "k", { ctrlKey: true });
    expect(get(settingsOpen)).toBe(false);
    stroke(document, "1", { ctrlKey: true });
    await Promise.resolve();
    expect(selection.presetId).toBe("b");

    settingsOpen.set(true);
    stroke(document, "Escape");
    expect(get(settingsOpen)).toBe(true);
    settingsOpen.set(false);
    gridOpenStore.set(true);
    stroke(document, "Escape");
    expect(get(gridOpenStore)).toBe(true);
    gridOpenStore.set(false);

    const chatRef = { chaId: "c", chatId: "k" };
    for (const picker of [openPersonaList, openModelPresetList, openPresetList]) {
        picker.set({ chatRef });
        stroke(document, "Escape");
        expect(get(picker)).toEqual({ chatRef });
        picker.set(false);
    }
    chatBindingDialog.set(chatRef);
    stroke(document, "Escape");
    expect(get(chatBindingDialog)).toEqual(chatRef);
});

it("host mode still lets Enter confirm and Escape dismiss a shown dialog", async () => {
    hostMode.set(true);
    settingsOpen.set(true);
    const confirmed = open("ask");
    expect(alertStore.dialogVisible()).toBe(true);
    stroke(document, "Enter");
    expect(alertStore.dialogVisible()).toBe(false);
    await expect(confirmed.closed).resolves.toBe("yes");
    expect(get(settingsOpen)).toBe(true);

    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    const dismissed = open("ask");
    expect(alertStore.dialogVisible()).toBe(true);
    stroke(document, "Escape");
    expect(alertStore.dialogVisible()).toBe(false);
    await expect(dismissed.closed).resolves.toBe("");
    expect(get(settingsOpen)).toBe(true);
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

it("Enter accepts a checkbox confirmation with its current state while the checkbox is focused", async () => {
    const field = document.createElement("input");
    field.type = "checkbox";
    const dialogElement = document.createElement("div");
    dialogElement.setAttribute("data-alert-dialog", "");
    dialogElement.append(field);
    document.body.append(dialogElement);
    const question = openAlertDialog(() => alertConfirmWithCheckbox("Remove plug?", "Also delete its stored data"));
    dialogs.push(question.dialog!);
    alertStore.setConfirmChecked(false, get(alertStore));
    field.focus();
    stroke(field, "Enter");
    // Check closure before awaiting so a broken hotkey fails without a timeout.
    expect(alertStore.dialogVisible()).toBe(false);
    await expect(question.value).resolves.toEqual({ confirmed: true, checked: false });
});

it("Enter accepts a checklist confirmation with its current items while one of its checkboxes is focused", async () => {
    const field = document.createElement("input");
    field.type = "checkbox";
    const dialogElement = document.createElement("div");
    dialogElement.setAttribute("data-alert-dialog", "");
    dialogElement.append(field);
    document.body.append(dialogElement);
    const question = openAlertDialog(() =>
        alertConfirmWithChecklist("Permissions?", [
            { id: "db", label: "Read the database", checked: true },
            { id: "mainDom", label: "Access the main document", checked: true },
        ]),
    );
    dialogs.push(question.dialog!);
    alertStore.setConfirmChecked(false, get(alertStore), "db");
    field.focus();
    stroke(field, "Enter");
    expect(alertStore.dialogVisible()).toBe(false);
    await expect(question.value).resolves.toEqual({ confirmed: true, checked: ["mainDom"] });
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
