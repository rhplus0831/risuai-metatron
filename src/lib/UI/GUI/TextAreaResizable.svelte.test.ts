// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The auto-growing message editor opts into the popup editor: with `popupEditor` it shows the
// expand button and takes the popup hotkey, and a close writes the popup's text back unless the
// bound value changed meanwhile. `stableHeight` trades auto-growth for a fixed scrollable area.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/gui/longtouch", () => ({
    longpress: (node: HTMLElement, callback: (event: Event) => void) => {
        node.addEventListener("test-longpress", callback);
        return { destroy: () => node.removeEventListener("test-longpress", callback) };
    },
}));

import { language } from "src/lang";
import type { Database } from "src/ts/storage/database.svelte";
import { defaultHotkeys } from "src/ts/defaulthotkeys";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { closePopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import TextAreaResizable from "./TextAreaResizable.svelte";

type Props = {
    value: string;
    popupEditor?: boolean;
    stableHeight?: boolean;
    onchange?: () => void;
};

const mounted: ReturnType<typeof mount>[] = [];
const initialPopup = { ...popUpEditorStore };

function render(initial: Props) {
    const props = $state(initial);
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(TextAreaResizable, { target, props }));
    flushSync();
    const expandButton = () =>
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`);
    const textarea = () => target.querySelector<HTMLTextAreaElement>("textarea")!;
    return { props, target, expandButton, textarea };
}

async function closePopupWith(text: string) {
    popUpEditorStore.value = text;
    closePopupEditorSession(popUpEditorStore.sessionId);
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabase({
        characters: [],
        personas: [],
        zoomsize: 100,
        lineHeight: 1.25,
        hotkeys: structuredClone(defaultHotkeys),
    } as unknown as Database);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    Object.assign(popUpEditorStore, initialPopup);
    vi.useRealTimers();
});

describe("TextAreaResizable popup editor", () => {
    it("shows the expand button and takes the popup hotkey only when opted in", () => {
        const plain = render({ value: "plain" });
        expect(plain.expandButton()).toBeNull();
        const hotkey = settings.hotkeys.find((hk) => hk.action === "popupEditor")!;
        const press = (textarea: HTMLTextAreaElement, composing: { isComposing?: boolean; keyCode?: number } = {}) => {
            const ev = new KeyboardEvent("keydown", {
                key: hotkey.key,
                ctrlKey: hotkey.ctrl,
                shiftKey: hotkey.shift,
                altKey: hotkey.alt,
                bubbles: true,
                cancelable: true,
            });
            for (const [name, value] of Object.entries(composing)) {
                Object.defineProperty(ev, name, { value });
            }
            textarea.dispatchEvent(ev);
        };
        press(plain.textarea());
        expect(popUpEditorStore.open).toBe(false);

        const popup = render({ value: "with popup", popupEditor: true });
        expect(popup.expandButton()).not.toBeNull();
        // A stroke the IME is still composing, or Safari's commit key after it ended the composition.
        press(popup.textarea(), { isComposing: true });
        press(popup.textarea(), { keyCode: 229 });
        expect(popUpEditorStore.open).toBe(false);
        press(popup.textarea());
        expect(popUpEditorStore).toMatchObject({ open: true, value: "with popup" });
    });

    it("writes the popup's text back on close and reports the change", async () => {
        const onchange = vi.fn();
        const ui = render({ value: "before", popupEditor: true, onchange });
        ui.expandButton()!.click();
        flushSync();
        expect(popUpEditorStore).toMatchObject({ open: true, value: "before" });
        await closePopupWith("after");
        expect(ui.props.value).toBe("after");
        expect(ui.textarea().value).toBe("after");
        expect(onchange).toHaveBeenCalledTimes(1);
    });

    it("closes the popup it opened when destroyed in the same turn, before the open's batch flushed", async () => {
        const ui = render({ value: "gone", popupEditor: true });
        ui.expandButton()!.click();
        expect(popUpEditorStore.open).toBe(true);
        // No `flushSync()` between the click and the unmount: the teardown runs against the values
        // from before the open's batch (Svelte 5), so the session check must not read `$state`.
        await unmount(mounted.pop()!);
        expect(popUpEditorStore.open).toBe(false);
    });

    it("discards the popup when the bound value changes under it", async () => {
        const onchange = vi.fn();
        const ui = render({ value: "row A", popupEditor: true, onchange });
        ui.expandButton()!.click();
        flushSync();
        popUpEditorStore.value = "typed in popup";
        ui.props.value = "row B";
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.props.value).toBe("row B");
        expect(onchange).not.toHaveBeenCalled();
    });

    it("keeps a fixed scrollable height with stableHeight and grows otherwise", () => {
        const stable = render({ value: "one\ntwo", stableHeight: true });
        expect(stable.textarea().style.height).toBe("16rem");
        expect(stable.textarea().classList.contains("overflow-y-auto")).toBe(true);
        const growing = render({ value: "one\ntwo" });
        expect(growing.textarea().style.height).not.toBe("16rem");
        expect(growing.textarea().classList.contains("overflow-y-hidden")).toBe(true);
    });
});
