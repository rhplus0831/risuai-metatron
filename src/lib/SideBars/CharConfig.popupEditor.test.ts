// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

// `CharConfig`'s fields follow the selected character, which the previous/next character hotkeys
// change while a popup editor stays open. Each field passes its character as the popup's context,
// so a popup opened on one character is discarded after a switch instead of landing in the next
// one, even when both hold the same text. Mounted over the real records, selection, and popup
// editor; unrelated panels and file loading are doubled.

vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        holdFileSrc: () => ({ src: Promise.resolve(""), release: () => {} }),
        getFileSrc: vi.fn(async () => ""),
    }),
);
vi.mock("src/ts/characters", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/characters")>()),
    getCharImage: vi.fn(async () => ""),
}));
vi.mock("src/ts/tokenizer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/tokenizer")>()),
    countTokens: vi.fn(async () => 0),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lib/SideBars/LoreBook/LoreBookSetting.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));

import CharConfig from "./CharConfig.svelte";
import { CharConfigSubMenu, closePopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    document.body.replaceChildren();
    vi.useRealTimers();
});

it("a field's popup writes the character it opened on; a character switch while it is open discards it", async () => {
    vi.useFakeTimers();
    const previousPopup = { ...popUpEditorStore };
    try {
        installFlatDatabaseWithChats({
            characters: ["c1", "c2"].map((chaId) => ({
                chaId,
                type: "character",
                name: chaId,
                desc: "",
                chatPage: 0,
                chats: [{ id: `${chaId}-chat`, name: "K", note: "", localLore: [], message: [] }],
            })),
        });
        settings.ui.longPressToPopupEditor = true;
        selectCharacter("c1");
        CharConfigSubMenu.set(0);
        const target = document.createElement("div");
        document.body.append(target);
        instance = mount(CharConfig, { target });
        flushSync();
        // The description is the tab's first field.
        const openDescriptionPopup = () => {
            target
                .querySelector("textarea")!
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
            expect(popUpEditorStore).toMatchObject({ open: true, value: "" });
        };
        const closePopupWith = async (text: string) => {
            popUpEditorStore.value = text;
            closePopupEditorSession(popUpEditorStore.sessionId);
            await vi.advanceTimersByTimeAsync(100);
            flushSync();
            await vi.advanceTimersByTimeAsync(0);
            flushSync();
        };
        const descriptions = () => characterList().map((entry) => (entry as { desc: string }).desc);

        openDescriptionPopup();
        popUpEditorStore.value = "typed for c1";
        selectCharacter("c2");
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(descriptions()).toEqual(["", ""]);

        openDescriptionPopup();
        await closePopupWith("typed for c2");
        expect(descriptions()).toEqual(["", "typed for c2"]);
    } finally {
        popUpEditorStore.open = false;
        await vi.advanceTimersByTimeAsync(100);
        Object.assign(popUpEditorStore, previousPopup);
    }
});
