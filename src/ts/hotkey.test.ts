// @vitest-environment happy-dom

import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3, slice 5: the preset hotkeys (Ctrl+1 to Ctrl+9) map their index to the preset's id and
// select it for this client through `changeToPreset(id)`, and they do nothing while the popup editor
// is open: `TextAreaInput`'s popup writes its draft back to the field it was opened on when it
// closes, and with a forwarded preset field that is the selected preset (Astra challenge point 2).

vi.mock("./globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("./alert", async () => ({
    // No terminal notice is shown unless a test sets one (a writable here; read-only in `alert.ts`).
    terminalNotice: (await import("svelte/store")).writable<string | null>(null),
    alertMd: vi.fn(),
    alertSelect: vi.fn(),
    alertToast: vi.fn(),
    alertWait: vi.fn(),
    alertRequestLogs: vi.fn(),
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    doingAlert: vi.fn(() => false),
}));
vi.mock("./process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("./parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("./process/index.svelte", () => ({
    sendChat: vi.fn(),
    previewBody: vi.fn(),
    doingChat: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

import { alertNormal, alertToast, doingAlert, terminalNotice } from "./alert";
import { activeHotkeys, hotkeyMatches, initHotkey } from "./hotkey";
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
        // The restore-notice fix after Phase 6 slice 2: no shortcut runs behind the notice.
        (terminalNotice as unknown as Writable<string | null>).set("restored");
        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("a");
        expect(alertToast).not.toHaveBeenCalled();
    });
});

describe("hotkey matching", () => {
    // The Stop B fix (Phase 6): the stored hotkeys are a write-through record since slice 4, and the
    // built-in hotkeys carry no `shift` flag. Matching filled the missing flags in on the stored
    // element, so a session's first key press saved the `hotkeys` record.
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

describe("the stored hotkeys and their ui toggle (Phase 6 slice 7)", () => {
    // `initHotkey` reads the `hotkeys` record and the `ui` section's `enableScrollToActiveChar`
    // through the settings views at each key press: an edit of either is what the next press uses.
    // The records are all there is (slice 10 took the aggregate away).
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

describe("the removed quick settings panel (settings UI plan slice 1)", () => {
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

describe("the previous/next character hotkeys (Phase 6 slice 8)", () => {
    // `prevChar` (Ctrl+[) and `nextChar` (Ctrl+]) step through a copy of the character list sorted by
    // name and select by `chaId`. The slice fixed their bounds: previous does nothing from the first
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

// `docs/plan/chat-binding.md`, slice 5: Ctrl+1..9 picks the prompt preset for the open chat's binding
// (the tab's selection stays), else at home for the tab; nothing runs while a picker list or the
// binding dialog is open. Escape closes only the topmost layer: an alert, else the persona list, the
// model preset list, the prompt preset list, the binding dialog (in the order `App.svelte` mounts
// them), else the settings or the grid as before; a list or the dialog closes also from a focused text
// field, where the other shortcuts stay off.
describe("the preset hotkeys and Escape with the binding layers (slice 5)", () => {
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

    it("Escape with an alert open closes the alert and leaves the list, the dialog, and the settings", () => {
        vi.mocked(doingAlert).mockReturnValue(true);
        settingsOpen.set(true);
        openPresetList.set({ chatRef: refK });
        chatBindingDialog.set(refK);
        pressPlain("Escape");
        expect(alertToast).toHaveBeenCalledWith("Alert Closed");
        expect(layers()).toMatchObject({ preset: { chatRef: refK }, dialog: refK, settings: true });

        // Without a layer, an alert and the settings close together, as before.
        vi.mocked(alertToast).mockClear();
        closeAll();
        settingsOpen.set(true);
        pressPlain("Escape");
        expect(alertToast).toHaveBeenCalledWith("Alert Closed");
        expect(layers()).toMatchObject({ settings: false });
    });
});
