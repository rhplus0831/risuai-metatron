// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { normalizePreset } from "../../../../shared/presets.ts";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { selectPreset, selectCharacter, setChatOpen } from "src/ts/storage/selection.svelte";
import { selectChat, currentChatRef } from "src/ts/storage/chatStore.svelte";
import { closePopupEditorSession, popUpEditorStore, settingsOpen } from "src/ts/stores.svelte";
import { initHotkey } from "src/ts/hotkey";
import PromptPresetSettings from "./PromptPresetSettings.svelte";
import PopupEditor from "src/lib/Others/PopupEditor.svelte";
const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);
const mounted: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    for (const instance of mounted) await unmount(instance);
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
});
it("does not redirect a bound preset popup to the tab preset when Home closes its chat", async () => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chats: [{ id: "chat", name: "chat", message: [], localLore: [], promptPresetId: "a" }],
            },
        ],
        botPresets: [
            normalizePreset({ id: "a", name: "Bound preset", moduleIntergration: "" }),
            normalizePreset({ id: "b", name: "Tab preset", moduleIntergration: "" }),
        ],
        useLegacyGUI: false,
    });
    selectPreset("b");
    selectCharacter("c");
    selectChat("c", "chat");
    setChatOpen(true);
    settingsOpen.set(true);
    expect(activePreset.id).toBe("a");
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(PromptPresetSettings, { target }));
    flushSync();
    const button = (name: string) =>
        [...target.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === name,
        )!;
    button(language.others).click();
    flushSync();
    button(language.moduleIntergration).click();
    flushSync();
    const area = [...target.querySelectorAll<HTMLTextAreaElement>("textarea")].find((area) =>
        area.closest("div.relative")?.querySelector("button"),
    )!;
    expect(area).toBeDefined();
    area.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();
    expect(popUpEditorStore.open).toBe(true);
    expect(popUpEditorStore.value).toBe("");
    localStorage.setItem("risu-popup-editor-monaco", "false");
    const popupTarget = document.createElement("div");
    document.body.append(popupTarget);
    mounted.push(mount(PopupEditor, { target: popupTarget }));
    flushSync();
    const popupArea = popupTarget.querySelector<HTMLTextAreaElement>("textarea")!;
    popupArea.value = "draft for bound preset A";
    popupArea.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    initHotkey();
    popupArea.focus();
    popupArea.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true, cancelable: true }));
    flushSync();
    console.log("HOME", { chat: currentChatRef(), preset: activePreset.id, open: popUpEditorStore.open });
    expect(activePreset.id).toBe("b");
    closePopupEditorSession(popUpEditorStore.sessionId);
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    const saved = settings.presets.map((preset) => ({ id: preset.id, moduleIntergration: preset.moduleIntergration }));
    console.log("SAVED PRESETS", JSON.stringify(saved));
    expect(saved).toEqual([
        { id: "a", moduleIntergration: "" },
        { id: "b", moduleIntergration: "" },
    ]);
});
