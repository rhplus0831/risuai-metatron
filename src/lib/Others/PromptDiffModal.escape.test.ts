// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { writable, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `docs/plan/chat-binding.md`, slice 5 (Astra challenge point 2): the prompt comparison is the
// topmost layer over the preset list, so Escape closes it through its own close (which saves the
// preferences) and never reaches the global hotkey listener (`hotkey.ts`), which would close the
// preset list under it too. The modal listens on the document in the capture phase; an alert or the
// terminal notice above it keeps its Escape, and other keys pass through.

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        terminalNotice: (await import("svelte/store")).writable<string | null>(null),
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { doingAlert, terminalNotice } from "src/ts/alert";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PromptDiffModal from "./PromptDiffModal.svelte";

const mounted: ReturnType<typeof mount>[] = [];
/** What a bubbling document listener (the global hotkey handler's phase) sees. */
const bubbled = vi.fn();
const key = (name: string) => new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });

function render() {
    const onClose = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(PromptDiffModal, { target, props: { firstPresetId: 0, secondPresetId: 1, onClose } }));
    flushSync();
    return { target, onClose };
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        botPresets: [
            { id: "p1", name: "One", promptTemplate: [{ type: "plain", type2: "normal", text: "a", role: "system" }] },
            { id: "p2", name: "Two", promptTemplate: [{ type: "plain", type2: "normal", text: "b", role: "system" }] },
        ],
    } as any);
    settings.ui.promptDiffPrefs = undefined as any;
    document.addEventListener("keydown", bubbled);
    vi.mocked(doingAlert).mockReturnValue(false);
    (terminalNotice as unknown as Writable<string | null>).set(null);
});

afterEach(async () => {
    document.removeEventListener("keydown", bubbled);
    bubbled.mockClear();
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("the comparison's Escape", () => {
    it("closes the comparison through its own close, saves the preferences, and never reaches the bubbling listener", () => {
        const modal = render();
        const inside = modal.target.querySelector("button")!;
        const event = key("Escape");
        inside.dispatchEvent(event);
        expect(modal.onClose).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(bubbled).not.toHaveBeenCalled();
        expect(settings.ui.promptDiffPrefs).toMatchObject({ diffStyle: expect.any(String) });
    });

    it("leaves Escape to an alert or the terminal notice above it, and lets other keys through", () => {
        const modal = render();
        vi.mocked(doingAlert).mockReturnValue(true);
        document.body.dispatchEvent(key("Escape"));
        expect(modal.onClose).not.toHaveBeenCalled();
        expect(bubbled).toHaveBeenCalledTimes(1);

        vi.mocked(doingAlert).mockReturnValue(false);
        (terminalNotice as unknown as Writable<string | null>).set("restored");
        document.body.dispatchEvent(key("Escape"));
        expect(modal.onClose).not.toHaveBeenCalled();
        expect(bubbled).toHaveBeenCalledTimes(2);

        (terminalNotice as unknown as Writable<string | null>).set(null);
        document.body.dispatchEvent(key("a"));
        expect(modal.onClose).not.toHaveBeenCalled();
        expect(bubbled).toHaveBeenCalledTimes(3);
    });

    it("stops listening once it is closed", async () => {
        const modal = render();
        await unmount(mounted.pop()!);
        document.body.dispatchEvent(key("Escape"));
        expect(modal.onClose).not.toHaveBeenCalled();
        expect(bubbled).toHaveBeenCalledTimes(1);
    });
});
