// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The multi-line input's expand button opens the shared popup editor on the field's text; closing
// the popup writes its text back to the field and tells the field's consumers. The write-back is
// refused when the field no longer shows what the popup was opened on (its bound value changed
// under it, or a newer open took the popup), so a popup never overwrites another field or a
// replaced record. The button follows the field's height; the hotkey and long-press paths do not.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import { language } from "src/lang";
import type { Database } from "src/ts/storage/database.svelte";
import { defaultHotkeys } from "src/ts/defaulthotkeys";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { closePopupEditorSession, openPopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import TextAreaInput from "./TextAreaInput.svelte";

type Props = {
    value: string;
    height?: "20" | "default";
    popupEditor?: boolean | "auto";
    popupLanguage?: string;
    popupEditorContext?: unknown;
    onInput?: () => void;
    onchange?: (e: { currentTarget: HTMLTextAreaElement | HTMLDivElement }) => void;
};

const mounted: ReturnType<typeof mount>[] = [];
const initialPopup = { ...popUpEditorStore };

function render(initial: Props) {
    const props = $state(initial);
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(TextAreaInput, { target, props }));
    flushSync();
    const expandButton = () =>
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`);
    const textarea = () => target.querySelector<HTMLTextAreaElement>("textarea")!;
    return { props, target, expandButton, textarea };
}

/** Closes the current popup with `text` and lets the opener's poll observe the close. */
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
        hotkeys: structuredClone(defaultHotkeys),
    } as unknown as Database);
    settings.ui.longPressToPopupEditor = false;
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    Object.assign(popUpEditorStore, initialPopup);
    vi.useRealTimers();
});

describe("TextAreaInput popup editor", () => {
    it("shows the expand button on a field of default height, not on a short one, and never when turned off", () => {
        expect(render({ value: "" }).expandButton()).not.toBeNull();
        expect(render({ value: "", height: "20" }).expandButton()).toBeNull();
        expect(render({ value: "", height: "20", popupEditor: true }).expandButton()).not.toBeNull();
        expect(render({ value: "", popupEditor: false }).expandButton()).toBeNull();
    });

    it("keeps the long-press path on a short field and drops it only when the popup is turned off", () => {
        settings.ui.longPressToPopupEditor = true;
        const short = render({ value: "short note", height: "20" });
        short.textarea().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        expect(popUpEditorStore).toMatchObject({ open: true, value: "short note" });
        closePopupEditorSession(popUpEditorStore.sessionId);

        const off = render({ value: "no popup", popupEditor: false });
        off.textarea().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        expect(popUpEditorStore.open).toBe(false);
    });

    it("takes the popup hotkey only once the IME composition ended", () => {
        const hotkey = settings.hotkeys.find((hk) => hk.action === "popupEditor")!;
        const ui = render({ value: "한글" });
        const press = (composing: { isComposing?: boolean; keyCode?: number }) => {
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
            ui.textarea().dispatchEvent(ev);
        };
        // A stroke the IME is still composing, or Safari's commit key after it ended the composition.
        press({ isComposing: true });
        press({ keyCode: 229 });
        expect(popUpEditorStore.open).toBe(false);
        press({});
        expect(popUpEditorStore).toMatchObject({ open: true, value: "한글" });
    });

    it("opens the popup on the field's text and language, and a close writes the text back and notifies", async () => {
        const onInput = vi.fn();
        const onchange = vi.fn();
        const ui = render({ value: "return 1", popupLanguage: "lua", onInput, onchange });
        ui.expandButton()!.click();
        flushSync();
        expect(popUpEditorStore).toMatchObject({ open: true, value: "return 1", language: "lua" });

        await closePopupWith("return 2");
        expect(ui.props.value).toBe("return 2");
        expect(ui.textarea().value).toBe("return 2");
        expect(onInput).toHaveBeenCalledTimes(1);
        expect(onchange).toHaveBeenCalledTimes(1);
        expect(onchange.mock.calls[0][0].currentTarget).toBe(ui.textarea());
    });

    it("discards the popup's text and closes it when the bound value changes under it", async () => {
        const onchange = vi.fn();
        const ui = render({ value: "chat A note", onchange });
        ui.expandButton()!.click();
        flushSync();
        expect(popUpEditorStore.open).toBe(true);
        popUpEditorStore.value = "typed for chat A";

        // The field now shows another record (a chat switch replaced the bound value).
        ui.props.value = "chat B note";
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.props.value).toBe("chat B note");
        expect(onchange).not.toHaveBeenCalled();
    });

    it("does not write a popup that a newer open took over, even when its own open run ends", async () => {
        const first = render({ value: "first field" });
        const second = render({ value: "second field" });
        first.expandButton()!.click();
        flushSync();
        const firstSession = popUpEditorStore.sessionId;
        second.expandButton()!.click();
        flushSync();
        expect(popUpEditorStore.sessionId).not.toBe(firstSession);
        expect(popUpEditorStore.value).toBe("second field");
        await vi.advanceTimersByTimeAsync(100);

        await closePopupWith("edited second");
        expect(second.props.value).toBe("edited second");
        expect(first.props.value).toBe("first field");
    });

    it("discards the popup when the field's context changes while it is open", async () => {
        const ui = render({ value: "same text", popupEditorContext: "chat-a" });
        ui.expandButton()!.click();
        flushSync();
        popUpEditorStore.value = "typed";
        ui.props.popupEditorContext = "chat-b";
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.props.value).toBe("same text");
    });

    it("discards the popup when the field's context changes away and back while it is open", async () => {
        const ui = render({ value: "same text", popupEditorContext: "chat-a" });
        ui.expandButton()!.click();
        flushSync();
        popUpEditorStore.value = "typed";
        ui.props.popupEditorContext = "chat-b";
        flushSync();
        ui.props.popupEditorContext = "chat-a";
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.props.value).toBe("same text");
    });

    it("closes its own popup when the field unmounts, and leaves a popup another field took over alone", async () => {
        // The store writes of an open settle on the flush; a teardown reads values from before a pending
        // batch, as a real field's popup has always flushed long before the field goes away.
        const leaving = render({ value: "leaving" });
        leaving.expandButton()!.click();
        flushSync();
        await unmount(mounted.pop()!);
        expect(popUpEditorStore.open).toBe(false);

        const taken = render({ value: "taken over" });
        const taker = render({ value: "taker" });
        taken.expandButton()!.click();
        flushSync();
        taker.expandButton()!.click();
        flushSync();
        expect(popUpEditorStore.value).toBe("taker");
        // `taken` lost its popup to `taker`; its unmount must not close the taker's popup.
        await unmount(mounted.shift()!);
        expect(popUpEditorStore.open).toBe(true);
        await closePopupWith("edited by taker");
        expect(taker.props.value).toBe("edited by taker");
        expect(taken.props.value).toBe("taken over");
    });
});
