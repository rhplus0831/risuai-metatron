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

import { alertToast, doingAlert, terminalNotice } from "./alert";
import { hotkeyMatches, initHotkey } from "./hotkey";
import { characterList } from "./storage/characterStore.svelte";
import type { Database } from "./storage/database.svelte";
import { setRecordWriteListener } from "./storage/records.svelte";
import { llmSecretState, setMaskedSecrets } from "./storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../shared/llmSecrets.ts";
import { selectCharacter, selectedIndex, selection, selectPreset } from "./storage/selection.svelte";
import { activePreset, selectedPresetIndex, settings } from "./storage/settingsViews.svelte";
import { installFlatDatabase } from "./storage/tests/installFlatDatabase";
import { popUpEditorStore, settingsOpen } from "./stores.svelte";

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
