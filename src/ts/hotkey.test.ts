// @vitest-environment happy-dom

import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The preset hotkeys (Ctrl+1 to Ctrl+9) map their index to the preset's id and select it for this
// client through `changeToPreset(id)`, and they do nothing while the popup editor is open:
// `TextAreaInput`'s popup writes its draft back to the field it was opened on when it closes, and
// with a forwarded preset field that is the selected preset.

vi.mock("./globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        // No terminal notice is shown unless a test sets one (a writable here; read-only in `alert.ts`).
        terminalNotice: (await import("svelte/store")).writable<string | null>(null),
    }),
);
vi.mock("./process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("./parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("./process/index.svelte", () => ({
    sendChat: vi.fn(),
    previewChat: vi.fn(),
    doingChat: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

import { alertMd, alertNormal, alertToast, alertWait, doingAlert, terminalNotice } from "./alert";
import { previewChat } from "./process/index.svelte";
import { beginLocalSend } from "./process/localSends";
import { activeHotkeys, hotkeyMatches, initHotkey } from "./hotkey";
import { NEXT_DIALOG_GAP_MS } from "./alertQueue";
import { defaultHotkeys } from "./defaulthotkeys";
import { language } from "src/lang";
import { characterList } from "./storage/characterStore.svelte";
import type { Database } from "./storage/database.svelte";
import { setRecordWriteListener } from "./storage/records.svelte";
import { llmSecretState, setMaskedSecrets } from "./storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../shared/llmSecrets.ts";
import { chatEntry, selectChat } from "./storage/chatStore.svelte";
import { selectCharacter, selectedIndex, selection, selectPreset } from "./storage/selection.svelte";
import { activePreset, selectedPresetIndex, settings } from "./storage/settingsViews.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "./storage/tests/installFlatDatabase";
import {
    alertStore,
    chatBindingDialog,
    gridOpenStore,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    popUpEditorStore,
    settingsOpen,
} from "./stores.svelte";

let installed = false;

function press(key: string) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    // The write-only `llmSecrets` state (7b): an empty masked record and no queued credential write.
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({}));
    installFlatDatabase({
        characters: [],
        botPresets: [
            { id: "a", name: "A", temperature: 80 },
            { id: "b", name: "B", temperature: 50 },
            { id: "c", name: "C", temperature: 30 },
        ],
    } as unknown as Database);
    if (!installed) {
        initHotkey();
        installed = true;
    }
    vi.mocked(alertToast).mockClear();
    popUpEditorStore.open = false;
});

afterEach(() => {
    (terminalNotice as unknown as Writable<string | null>).set(null);
    popUpEditorStore.open = false;
});

describe("preset hotkeys", () => {
    it("select the preset at the index by its id, and ignore an index past the list", async () => {
        press("3");
        await Promise.resolve();
        expect(selection.presetId).toBe("c");
        expect(activePreset.temperature).toBe(30);
        expect(alertToast).toHaveBeenLastCalledWith("Changed to Preset: C");

        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");

        press("9");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");
        expect(alertToast).toHaveBeenCalledTimes(2);

        // A reorder does not move the selection: the id is what is kept.
        settings.presets.reverse();
        expect(selection.presetId).toBe("b");
        expect(selectedPresetIndex()).toBe(1);
        press("1");
        await Promise.resolve();
        expect(selection.presetId).toBe("c");
    });

    it("count the active presets only, in list order, as the list's active view numbers them", async () => {
        // The archive feature (risuai-fastify `ee5382a9a` port): an archived preset has no number.
        settings.presets[1].archived = true;
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("c");
        expect(alertToast).toHaveBeenLastCalledWith("Changed to Preset: C");

        // The archived one is unreachable by number, and the count is of the active ones.
        press("3");
        await Promise.resolve();
        expect(selection.presetId).toBe("c");
        expect(alertToast).toHaveBeenCalledTimes(1);

        // A restore puts it back at its list position.
        settings.presets[1].archived = false;
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");

        // Every preset archived: no number picks anything, and the selection stays.
        for (const preset of settings.presets) {
            preset.archived = true;
        }
        press("1");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");
        expect(alertToast).toHaveBeenCalledTimes(2);
    });

    it("do nothing while the popup editor is open, and work again once it closes", async () => {
        popUpEditorStore.open = true;
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("a");
        expect(alertToast).not.toHaveBeenCalled();

        popUpEditorStore.open = false;
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");
        expect(alertToast).toHaveBeenCalledTimes(1);
    });

    it("do nothing while an alert is open", async () => {
        vi.mocked(doingAlert).mockReturnValueOnce(true);
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("a");
        expect(alertToast).not.toHaveBeenCalled();
    });

    it("do nothing while the terminal (restore) notice is shown", async () => {
        // No shortcut runs behind the notice.
        (terminalNotice as unknown as Writable<string | null>).set("restored");
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("a");
        expect(alertToast).not.toHaveBeenCalled();
    });
});

describe("hotkey matching", () => {
    // The stored hotkeys are a write-through record, and the built-in hotkeys carry no `shift` flag.
    // A matcher that filled the missing flags in on the stored element would save the `hotkeys`
    // record at a session's first key press.
    it("reads a stored hotkey with missing modifier flags as 'not held' and writes nothing, for the dispatch and the textarea caller", async () => {
        installFlatDatabase({
            characters: [],
            botPresets: [{ id: "a", name: "A" }],
            hotkeys: [
                { key: "r", ctrl: true, alt: true, action: "reroll" },
                { key: "e", ctrl: true, action: "popupEditor" },
            ],
        } as unknown as Database);
        const written: string[] = [];
        setRecordWriteListener((kind) => written.push(kind));
        try {
            // The dispatch walks every hotkey: Ctrl+Alt+R matches the first, the second is compared too.
            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "r",
                    ctrlKey: true,
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                }),
            );
            await Promise.resolve();
            // `TextAreaInput`'s popup-editor check passes the stored element itself.
            const popup = settings.hotkeys.find((hotkey) => hotkey.action === "popupEditor");
            expect(hotkeyMatches(popup, new KeyboardEvent("keydown", { key: "e", ctrlKey: true }))).toBe(true);
            expect(
                hotkeyMatches(popup, new KeyboardEvent("keydown", { key: "e", ctrlKey: true, shiftKey: true })),
            ).toBe(false);
            expect(hotkeyMatches(popup, new KeyboardEvent("keydown", { key: "e", ctrlKey: true, altKey: true }))).toBe(
                false,
            );
            expect(written).toEqual([]);
            expect(JSON.parse(JSON.stringify(settings.hotkeys))).toEqual([
                { key: "r", ctrl: true, alt: true, action: "reroll" },
                { key: "e", ctrl: true, action: "popupEditor" },
            ]);
        } finally {
            setRecordWriteListener(null);
        }
    });
});

describe("the stored hotkeys and their ui toggle", () => {
    // `initHotkey` reads the `hotkeys` record and the `ui` section's `enableScrollToActiveChar`
    // through the settings views at each key press: an edit of either is what the next press uses.
    // The records are all there is (there is no aggregate database).
    const pressWith = (key: string) =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));

    it("dispatch the stored hotkeys, follow an edit of the record, and drop scrollToActiveChar while its toggle is off", () => {
        installFlatDatabase({
            characters: [],
            botPresets: [{ id: "a", name: "A" }],
            hotkeys: [
                { key: "j", ctrl: true, action: "settings" },
                { key: "k", ctrl: true, action: "scrollToActiveChar" },
            ],
            enableScrollToActiveChar: true,
        } as unknown as Database);
        const scrolls = vi.fn();
        window.addEventListener("scrollToActiveCharacter", scrolls);
        try {
            settingsOpen.set(false);
            pressWith("j");
            expect(get(settingsOpen)).toBe(true);
            pressWith("k");
            expect(scrolls).toHaveBeenCalledTimes(1);

            settings.ui.enableScrollToActiveChar = false;
            pressWith("k");
            expect(scrolls).toHaveBeenCalledTimes(1);

            settings.hotkeys[0].key = "m";
            pressWith("j");
            expect(get(settingsOpen)).toBe(true);
            pressWith("m");
            expect(get(settingsOpen)).toBe(false);
        } finally {
            window.removeEventListener("scrollToActiveCharacter", scrolls);
            settingsOpen.set(false);
        }
    });
});

describe("the removed quick settings panel", () => {
    // The panel is gone, but Ctrl+Q stays a built-in hotkey: the dispatch still matches the stored
    // `quickSettings` entry, keeps the key from the browser, and only says where the panel's parts went.
    it("Ctrl+Q shows the removal notice and prevents the browser's default", () => {
        installFlatDatabase({
            characters: [],
            botPresets: [{ id: "a", name: "A" }],
            hotkeys: [{ key: "q", ctrl: true, action: "quickSettings" }],
        } as unknown as Database);
        vi.mocked(alertNormal).mockClear();
        settingsOpen.set(false);
        const ev = new KeyboardEvent("keydown", { key: "q", ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(ev);

        expect(alertNormal).toHaveBeenCalledTimes(1);
        expect(alertNormal).toHaveBeenCalledWith(language.quickSettingsRemoved);
        expect(ev.defaultPrevented).toBe(true);
        expect(get(settingsOpen)).toBe(false);
        expect(settings.hotkeys.map((hotkey) => hotkey.action)).toEqual(["quickSettings"]);
    });

    it("activeHotkeys hides quickSettings from the hotkey table, with or without scrollToActiveChar", () => {
        expect(defaultHotkeys.some((hotkey) => hotkey.action === "quickSettings")).toBe(true);
        const actions = defaultHotkeys.map((hotkey) => hotkey.action);

        const listed = activeHotkeys(defaultHotkeys, { enableScrollToActiveChar: true });
        expect(listed.map((hotkey) => hotkey.action)).toEqual(actions.filter((action) => action !== "quickSettings"));

        const withoutScroll = activeHotkeys(defaultHotkeys, { enableScrollToActiveChar: false });
        expect(withoutScroll.map((hotkey) => hotkey.action)).toEqual(
            actions.filter((action) => action !== "quickSettings" && action !== "scrollToActiveChar"),
        );
        // The rows are the list's own elements, so the table edits the stored hotkeys.
        expect(listed[0]).toBe(defaultHotkeys[0]);
    });
});

describe("the previous/next character hotkeys", () => {
    // `prevChar` (Ctrl+[) and `nextChar` (Ctrl+]) step through a copy of the character list sorted by
    // name and select by `chaId`. Their bounds: previous does nothing from the first
    // character or from home, next does nothing from the last and selects the first from home.
    const pressChar = (key: "[" | "]") =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
    const character = (chaId: string, name: string) => ({ chaId, name, type: "character", chats: [], chatPage: 0 });

    beforeEach(() => {
        // Created in this order (the list position), not in name order.
        installFlatDatabase({
            characters: [character("c", "Carol"), character("a", "Alice"), character("b", "Bob")],
            botPresets: [{ id: "a", name: "A" }],
        } as unknown as Database);
    });

    afterEach(() => {
        selectCharacter(null);
    });

    it("next selects the first by name from home, steps by name, and does nothing from the last", () => {
        expect(selection.characterId).toBeNull();
        pressChar("]");
        expect(selection.characterId).toBe("a");
        pressChar("]");
        expect(selection.characterId).toBe("b");
        pressChar("]");
        expect(selection.characterId).toBe("c");
        pressChar("]");
        expect(selection.characterId).toBe("c");
        // The list itself is not sorted (the plugin index APIs address its positions).
        expect(characterList().map((entry) => entry.chaId)).toEqual(["c", "a", "b"]);
    });

    it("previous steps back by name, does nothing from the first, and does nothing from home", () => {
        selectCharacter("c");
        pressChar("[");
        expect(selection.characterId).toBe("b");
        pressChar("[");
        expect(selection.characterId).toBe("a");
        pressChar("[");
        expect(selection.characterId).toBe("a");

        selectCharacter(null);
        expect(() => pressChar("[")).not.toThrow();
        expect(selection.characterId).toBeNull();
    });

    it("previous works from the last character by name (it used to refuse it)", () => {
        selectCharacter("c");
        expect(selectedIndex()).toBe(0);
        pressChar("[");
        expect(selection.characterId).toBe("b");
        expect(selectedIndex()).toBe(2);
    });
});

// Ctrl+1..9 picks the prompt preset for the open chat's binding (the tab's selection stays), else at
// home for the tab; nothing runs while a picker list or the binding dialog is open. Escape closes only
// the topmost layer: an alert, else the persona list, the model preset list, the prompt preset list,
// the binding dialog (in the order `App.svelte` mounts them), else the settings or the grid as before;
// a list or the dialog closes also from a focused text field, where the other shortcuts stay off.
describe("the preset hotkeys and Escape with the binding layers", () => {
    const refK = { chaId: "c", chatId: "k" };
    const refJ = { chaId: "c", chatId: "j" };
    const chat = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
        ...fields,
    });
    const pressPlain = (key: string) =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    /** A whole stroke: the key goes down (`repeat` for an auto-repeat) and, unless held, up again. */
    const stroke = (key: string, { repeat = false, hold = false } = {}) => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true }));
        if (!hold) {
            document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
        }
    };
    const layers = () => ({
        persona: get(openPersonaList),
        model: get(openModelPresetList),
        preset: get(openPresetList),
        dialog: get(chatBindingDialog),
        settings: get(settingsOpen),
        grid: get(gridOpenStore),
    });
    const closeAll = () => {
        openPersonaList.set(false);
        openModelPresetList.set(false);
        openPresetList.set(false);
        chatBindingDialog.set(null);
        settingsOpen.set(false);
        gridOpenStore.set(false);
    };

    /** The tab selects `a`; chat `k` binds `b`, chat `j` binds nothing; `k` is open. */
    beforeEach(() => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [chat("k", { promptPresetId: "b" }), chat("j")],
                },
            ],
            botPresets: [
                { id: "a", name: "A", temperature: 80 },
                { id: "b", name: "B", temperature: 50 },
                { id: "c", name: "C", temperature: 30 },
            ],
        } as unknown as Database);
        selectPreset("a");
        selectCharacter("c");
        selectChat("c", "k");
        closeAll();
        vi.mocked(doingAlert).mockReset().mockReturnValue(false);
    });

    afterEach(() => {
        closeAll();
        selectCharacter(null);
        document.body.replaceChildren();
    });

    it("Ctrl+N binds the open chat's prompt preset and leaves the tab's selection; at home it selects for the tab", async () => {
        press("3");
        await Promise.resolve();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "c" });
        expect(chatEntry(refJ)).not.toHaveProperty("promptPresetId");
        expect(selection.presetId).toBe("a");
        expect(activePreset.temperature).toBe(30);
        expect(alertToast).toHaveBeenLastCalledWith("Changed to Preset: C");

        selectCharacter(null);
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "c" });
        expect(alertToast).toHaveBeenCalledTimes(2);
    });

    it("Ctrl+N does nothing while a picker list or the binding dialog is open", async () => {
        for (const open of [
            () => openPresetList.set(true),
            () => openModelPresetList.set({ chatRef: refJ }),
            () => openPersonaList.set(true),
            () => chatBindingDialog.set(refJ),
        ]) {
            closeAll();
            open();
            press("3");
            await Promise.resolve();
            expect(chatEntry(refK)).toMatchObject({ promptPresetId: "b" });
            expect(selection.presetId).toBe("a");
            expect(alertToast).not.toHaveBeenCalled();
        }
        closeAll();
        press("3");
        await Promise.resolve();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "c" });
    });

    it("Escape closes one layer per press, from the top: persona list, model list, preset list, dialog, then settings", () => {
        openPersonaList.set({ chatRef: refJ });
        openModelPresetList.set(true);
        openPresetList.set({ chatRef: refK });
        chatBindingDialog.set(refJ);
        settingsOpen.set(true);

        pressPlain("Escape");
        expect(layers()).toEqual({
            persona: false,
            model: true,
            preset: { chatRef: refK },
            dialog: refJ,
            settings: true,
            grid: false,
        });
        pressPlain("Escape");
        expect(layers()).toMatchObject({ model: false, preset: { chatRef: refK }, dialog: refJ, settings: true });
        pressPlain("Escape");
        expect(layers()).toMatchObject({ preset: false, dialog: refJ, settings: true });
        pressPlain("Escape");
        expect(layers()).toMatchObject({ dialog: null, settings: true });
        pressPlain("Escape");
        expect(layers()).toMatchObject({ dialog: null, settings: false });
        expect(alertToast).not.toHaveBeenCalled();
    });

    it("Escape leaves the grid under a layer, and closes it once no layer is open", () => {
        gridOpenStore.set(true);
        chatBindingDialog.set(refK);
        pressPlain("Escape");
        expect(layers()).toMatchObject({ dialog: null, grid: true });
        pressPlain("Escape");
        expect(layers()).toMatchObject({ grid: false });
    });

    it("Escape closes a list or the dialog from a focused text field, where it closes nothing else", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);
        settingsOpen.set(true);
        openPresetList.set(true);
        chatBindingDialog.set(refK);

        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(layers()).toMatchObject({ preset: false, dialog: refK, settings: true });
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(layers()).toMatchObject({ dialog: null, settings: true });
        // No layer: the focused-input guard keeps Escape away from the settings, as before.
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        expect(layers()).toMatchObject({ settings: true });
    });

    it("Escape with an alert open closes the alert and leaves the list, the dialog, and the settings", async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(doingAlert).mockReturnValue(true);
            settingsOpen.set(true);
            openPresetList.set({ chatRef: refK });
            chatBindingDialog.set(refK);
            // The real queue: Escape answers the shown dialog with "" and toasts.
            const first = alertStore.open({ type: "ask", msg: "sure?" });
            stroke("Escape");
            await expect(first.closed).resolves.toBe("");
            expect(alertToast).toHaveBeenCalledWith("Alert Closed");
            expect(layers()).toMatchObject({ preset: { chatRef: refK }, dialog: refK, settings: true });

            // Without a layer, an alert and the settings close together, as before.
            vi.mocked(alertToast).mockClear();
            closeAll();
            settingsOpen.set(true);
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
            const second = alertStore.open({ type: "ask", msg: "again?" });
            stroke("Escape");
            await expect(second.closed).resolves.toBe("");
            expect(alertToast).toHaveBeenCalledWith("Alert Closed");
            expect(layers()).toMatchObject({ settings: false });
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
            expect(alertStore.hasDialogs()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    // The dialog key gate (`createDialogKeyGate` wired in `initHotkey`): a dialog takes Enter only from a
    // stroke that began after it appeared, never during the gap before it shows, and the default action of
    // an Enter over an `ask` dialog is prevented whether the stroke is taken or not.
    it("Enter answers an ask dialog only from a new stroke, not a held one nor one during the gap", async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(doingAlert).mockReturnValue(true);
            // Enter is held as the dialog appears: its repeats do not answer it.
            stroke("Enter", { hold: true });
            const first = alertStore.open({ type: "ask", msg: "first?" });
            const repeated = new KeyboardEvent("keydown", {
                key: "Enter",
                repeat: true,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(repeated);
            await Promise.resolve();
            expect(repeated.defaultPrevented).toBe(true);
            expect(alertStore.dialogVisible()).toBe(true);
            // Released and pressed again: a new stroke answers it.
            document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
            stroke("Enter");
            await expect(first.closed).resolves.toBe("yes");

            // The next dialog is queued during the gap: an Enter then answers nothing.
            const second = alertStore.open({ type: "ask", msg: "second?" });
            stroke("Enter");
            await Promise.resolve();
            expect(alertStore.dialogVisible()).toBe(false);
            expect(alertStore.hasDialogs()).toBe(true);
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
            expect(alertStore.dialogVisible()).toBe(true);
            // Shown with no key held: the first Enter answers it.
            stroke("Enter");
            await expect(second.closed).resolves.toBe("yes");
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
            expect(alertStore.hasDialogs()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    // A dialog of another type has buttons of its own: a gate-rejected Enter on one of them (its
    // default action would click it) is prevented; a new stroke, or a button outside the dialog, is not.
    it("keeps a held Enter from natively clicking a button of a visible dialog, and nothing else", async () => {
        vi.useFakeTimers();
        const dialog = document.createElement("div");
        dialog.setAttribute("data-alert-dialog", "");
        const inside = document.createElement("button");
        dialog.appendChild(inside);
        const outside = document.createElement("button");
        document.body.append(dialog, outside);
        const enterOn = (target: HTMLElement, repeat: boolean) => {
            const event = new KeyboardEvent("keydown", { key: "Enter", repeat, bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            return event;
        };
        try {
            vi.mocked(doingAlert).mockReturnValue(true);
            stroke("Enter", { hold: true });
            const select = alertStore.open({ type: "select", msg: "a||b" });
            expect(enterOn(inside, true).defaultPrevented).toBe(true);
            expect(enterOn(outside, true).defaultPrevented).toBe(false);
            expect(alertStore.dialogVisible()).toBe(true);
            document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
            // A new stroke on the button: the browser's click is left to answer the dialog.
            expect(enterOn(inside, false).defaultPrevented).toBe(false);
            select.cancel();
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
            // No dialog shown: a held Enter on a dialog-like button is not touched.
            stroke("Enter", { hold: true });
            expect(enterOn(inside, true).defaultPrevented).toBe(false);
            document.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
        } finally {
            dialog.remove();
            outside.remove();
            vi.useRealTimers();
        }
    });
});

describe("text entry outside an input or textarea (crosscheck row 13)", () => {
    // A plain-key hotkey (Space: focus the composer) stays away from text being typed: an editable
    // element (`contenteditable` with no value counts) or an EditContext host, the plain `div`
    // Chrome's Monaco types into.
    const setup = (configure: (host: HTMLElement) => void) => {
        const composer = document.createElement("textarea");
        composer.className = "text-input-area";
        const host = document.createElement("div");
        host.tabIndex = 0;
        configure(host);
        document.body.append(composer, host);
        host.focus();
        expect(document.activeElement).toBe(host);
        return { composer, host };
    };
    const space = () => new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const focusInput = defaultHotkeys.find((hotkey) => hotkey.action === "focusInput")!;

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it.each([
        ["an EditContext host", (host: HTMLElement) => Object.assign(host, { editContext: {} })],
        ["a contenteditable element", (host: HTMLElement) => host.setAttribute("contenteditable", "")],
    ])("keeps Space in %s", (_, configure) => {
        const { host } = setup(configure);
        const event = space();
        host.dispatchEvent(event);
        expect(document.activeElement).toBe(host);
        expect(event.defaultPrevented).toBe(false);
        expect(hotkeyMatches(focusInput, space())).toBe(false);
    });

    it("still runs Space from a plain element", () => {
        const { host, composer } = setup(() => {});
        host.dispatchEvent(space());
        expect(document.activeElement).toBe(composer);
    });
});

describe("the model select hotkey (crosscheck row 14)", () => {
    it("Ctrl+M opens the model preset list and closes it again", () => {
        openModelPresetList.set(false);
        press("m");
        expect(get(openModelPresetList)).toBe(true);
        press("m");
        expect(get(openModelPresetList)).toBe(false);
    });
});

// The preview hotkey (`previewRequest`): the selected chat's request body comes back from
// `previewChat`, so a refused or failed preview shows nothing (it used to parse the last preview's
// body again), the chat's own work refuses it before anything is shown, and the hotkey clears only
// the wait it set.
describe("the preview hotkey", () => {
    const refK = { chaId: "c", chatId: "k" };
    const chat = (id: string) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
    });
    const pressU = () =>
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "u", ctrlKey: true, bubbles: true, cancelable: true }),
        );
    /** The last status set through the real queue (`alertWait` is a mock: it writes the status itself). */
    const status = () => alertStore.status();

    beforeEach(() => {
        installFlatDatabaseWithChats({
            characters: [{ chaId: "c", type: "character", name: "C", chatPage: 0, chats: [chat("k")] }],
            botPresets: [{ id: "a", name: "A" }],
            hotkeys: [{ key: "u", ctrl: true, action: "previewRequest" }],
        } as unknown as Database);
        selectCharacter("c");
        selectChat("c", "k");
        vi.mocked(alertMd).mockClear();
        vi.mocked(alertWait)
            .mockReset()
            .mockImplementation((msg: string) => alertStore.set({ type: "wait", msg }));
        vi.mocked(previewChat).mockReset();
        alertStore.clearStatus();
    });

    afterEach(() => {
        alertStore.clearStatus();
        selectCharacter(null);
    });

    it("shows the body previewChat returns for the selected chat, and nothing for a preview that did not run", async () => {
        vi.mocked(previewChat).mockResolvedValueOnce('{"model":"m","messages":[]}');
        pressU();
        await vi.waitFor(() => expect(alertMd).toHaveBeenCalledTimes(1));
        expect(previewChat).toHaveBeenCalledExactlyOnceWith("previewPrompt", refK);
        expect(vi.mocked(alertMd).mock.calls[0][0]).toContain('"model": "m"');
        expect(status()).toBeNull();

        // Refused (null): the earlier body is not shown again, and the wait is cleared.
        vi.mocked(previewChat).mockResolvedValueOnce(null);
        pressU();
        await vi.waitFor(() => expect(previewChat).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(status()).toBeNull());
        expect(alertWait).toHaveBeenCalledTimes(2);
        expect(alertMd).toHaveBeenCalledTimes(1);
    });

    it("refuses while the selected chat has a send of its own, before any wait is shown", async () => {
        const release = beginLocalSend(refK)!;
        try {
            pressU();
            await Promise.resolve();
            await Promise.resolve();
            expect(previewChat).not.toHaveBeenCalled();
            expect(alertWait).not.toHaveBeenCalled();
            expect(alertMd).not.toHaveBeenCalled();
        } finally {
            release();
        }
    });

    it("clears only its own wait: a status set during the preview is left to its owner", async () => {
        const newer = { type: "wait", msg: "another caller" } as const;
        vi.mocked(previewChat).mockImplementationOnce(async () => {
            alertStore.set(newer);
            return null;
        });
        pressU();
        await vi.waitFor(() => expect(previewChat).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        await Promise.resolve();
        expect(status()).toBe(newer);
        expect(alertMd).not.toHaveBeenCalled();
    });
});
