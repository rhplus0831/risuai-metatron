// @vitest-environment happy-dom

import type { Writable } from "svelte/store";
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
import { initHotkey } from "./hotkey";
import { setDatabase, type Database } from "./storage/database.svelte";
import { llmSecretState, setMaskedSecrets } from "./storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../shared/llmSecrets.ts";
import { selection, selectPreset } from "./storage/selection.svelte";
import { DBState, popUpEditorStore } from "./stores.svelte";

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
    DBState.db = {} as Database;
    setDatabase({
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
    DBState.db = {} as Database;
});

describe("preset hotkeys", () => {
    it("select the preset at the index by its id, and ignore an index past the list", async () => {
        press("3");
        await Promise.resolve();
        expect(selection.presetId).toBe("c");
        expect(DBState.db.temperature).toBe(30);
        expect(alertToast).toHaveBeenLastCalledWith("Changed to Preset: C");

        press("2");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");

        press("9");
        await Promise.resolve();
        expect(selection.presetId).toBe("b");
        expect(alertToast).toHaveBeenCalledTimes(2);

        // A reorder does not move the selection: the id is what is kept.
        DBState.db.botPresets.reverse();
        expect(selection.presetId).toBe("b");
        expect(DBState.db.botPresetsId).toBe(1);
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
