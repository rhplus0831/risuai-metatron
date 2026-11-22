// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { changeLanguage } from "src/lang";
import { initHotkey } from "src/ts/hotkey";
import { askLoreBudgetStop } from "src/ts/process/loreBudgetStop";
import { loreBudgetStopFixture } from "src/ts/process/tests/loreBudgetStopFixture";
import * as settingJump from "src/ts/setting/settingJump.svelte";
import { acceptRemoteChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import {
    botMakerMode,
    CharConfigSubMenu,
    gridOpenStore,
    loreBookSubmenuRequest,
    loreBudgetStopDialog,
    MEMORY_SETTINGS_MENU,
    settingsOpen,
    sideBarStore,
    sidebarLeaveDevTool,
} from "src/ts/stores.svelte";
import LoreBudgetStopDialog from "./LoreBudgetStopDialog.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

const ref = { chaId: "c", chatId: "k" };
const mounted: ReturnType<typeof mount>[] = [];

function seed(owner: Record<string, unknown> = {}) {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                name: "Owner",
                type: "character",
                ...owner,
                chats: [
                    { id: "k", name: "Stopped chat", note: "", localLore: [], message: [] },
                    { id: "j", name: "Other chat", note: "", localLore: [], message: [] },
                ],
            },
        ],
    });
    const chaId = typeof owner.chaId === "string" ? owner.chaId : "c";
    selectCharacter(chaId);
    selectChat(chaId, "k");
    return { chaId, chatId: "k" };
}

function renderShown() {
    const request = get(loreBudgetStopDialog)!;
    expect(request).not.toBeNull();
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(LoreBudgetStopDialog, { target, props: { request } }));
    flushSync();
    const button = (action: string) =>
        target.querySelector<HTMLButtonElement>(`[data-lore-budget-stop-action="${action}"]`);
    return { target, button };
}

beforeAll(() => initHotkey());
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    changeLanguage("en");
    seed();
    settingsOpen.set(true);
    gridOpenStore.set(true);
    sideBarStore.set(false);
    botMakerMode.set(false);
    CharConfigSubMenu.set(0);
    sidebarLeaveDevTool.set(false);
    loreBookSubmenuRequest.set(null);
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    while (get(loreBudgetStopDialog)) get(loreBudgetStopDialog)!.resolve("close");
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("lists the named entries with tokens, remaining count, used budget and global source", () => {
    void askLoreBudgetStop(ref, loreBudgetStopFixture, { messageKept: true });
    const { target } = renderShown();
    expect([...target.querySelectorAll("li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual([
        "Castle || keep 10 tokens",
        "Harbor 11 tokens",
        "Forest 12 tokens",
        "Tower 13 tokens",
        "River 14 tokens",
        "Village 15 tokens",
        "Mountain 16 tokens",
        "Road 17 tokens",
        "and 2 more entries",
    ]);
    expect(target.textContent).toContain("60 / 64");
    expect(target.textContent).toContain("10 entries");
    expect(target.textContent).toContain("145 tokens");
    expect(target.querySelector("[data-lore-budget-stop-limit]")?.textContent).toContain("global lorebook token limit");
    expect(target.querySelector("[data-lore-budget-stop-note]")?.textContent).toContain("The model was not called.");
    expect(target.querySelector("[data-lore-budget-stop-note]")?.textContent).toContain("Your message is in the chat.");
});

it("opens the global token limit as a settings item", async () => {
    const open = vi.spyOn(settingJump, "openSetting");
    const answer = askLoreBudgetStop(ref, loreBudgetStopFixture);
    renderShown().button("changeLimit")!.click();
    expect(await answer).toBe("changeLimit");
    expect(open).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            kind: "item",
            id: "adv.lbToken",
            available: true,
            target: { menu: MEMORY_SETTINGS_MENU, sectionId: "memory.lorebook" },
        }),
    );
    expect(get(settingsOpen)).toBe(true);
    expect(settingJump.currentJump()).toMatchObject({ kind: "item", id: "adv.lbToken", sectionId: "memory.lorebook" });
});

it.each(["character", "group"])("names the %s's own limit and opens its lorebook settings", async (type) => {
    seed({ type, loreSettings: { tokenBudget: 0 } });
    const answer = askLoreBudgetStop(ref, loreBudgetStopFixture);
    const { target, button } = renderShown();
    expect(target.querySelector("[data-lore-budget-stop-limit]")?.textContent).toContain(`the ${type}'s own`);
    button("changeLimit")!.click();
    expect(await answer).toBe("changeLimit");
    expect(get(settingsOpen)).toBe(false);
    expect(get(gridOpenStore)).toBe(false);
    expect(get(sideBarStore)).toBe(true);
    expect(get(botMakerMode)).toBe(true);
    expect(get(CharConfigSubMenu)).toBe(3);
    expect(get(sidebarLeaveDevTool)).toBe(true);
    expect(get(loreBookSubmenuRequest)).toBe(2);
});

it("opens Manage lorebook in the character editor and closes settings and the grid", async () => {
    const answer = askLoreBudgetStop(ref, loreBudgetStopFixture);
    renderShown().button("manageLorebook")!.click();
    expect(await answer).toBe("manageLorebook");
    expect(get(settingsOpen)).toBe(false);
    expect(get(gridOpenStore)).toBe(false);
    expect(get(sideBarStore)).toBe(true);
    expect(get(botMakerMode)).toBe(true);
    expect(get(CharConfigSubMenu)).toBe(3);
    expect(get(sidebarLeaveDevTool)).toBe(true);
    expect(get(loreBookSubmenuRequest)).toBeNull();
});

it.each(["unselected", "playground", "private"])("hides navigation for %s chats", (kind) => {
    const stopped = seed(
        kind === "playground" ? { chaId: "§playground" } : kind === "private" ? { license: "private" } : {},
    );
    void askLoreBudgetStop(stopped, loreBudgetStopFixture);
    const { button } = renderShown();
    if (kind === "unselected") {
        expect(button("changeLimit")).not.toBeNull();
        selectChat("c", "j");
        flushSync();
    }
    expect(button("changeLimit")).toBeNull();
    expect(button("manageLorebook")).toBeNull();
    expect(button("warnOffAndSend")).not.toBeNull();
    expect(button("close")).not.toBeNull();
});

it.each(["warnOffAndSend", "close"] as const)("answers %s and clears the dialog", async (choice) => {
    const answer = askLoreBudgetStop(ref, loreBudgetStopFixture);
    renderShown().button(choice)!.click();
    expect(await answer).toBe(choice);
    expect(get(loreBudgetStopDialog)).toBeNull();
});

it("queues stops in arrival order and Escape closes only the displayed request", async () => {
    const first = askLoreBudgetStop(ref, loreBudgetStopFixture);
    const shown = get(loreBudgetStopDialog);
    const secondAnswered = vi.fn();
    const second = askLoreBudgetStop({ chaId: "c", chatId: "j" }, loreBudgetStopFixture).then(secondAnswered);
    renderShown();
    await Promise.resolve();
    expect(get(loreBudgetStopDialog)).toBe(shown);
    expect(secondAnswered).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(get(loreBudgetStopDialog)?.ref).toEqual({ chaId: "c", chatId: "j" });
    expect(await first).toBe("close");
    expect(secondAnswered).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }));
    await Promise.resolve();
    expect(secondAnswered).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await second;
    expect(secondAnswered).toHaveBeenCalledExactlyOnceWith("close");
    expect(get(loreBudgetStopDialog)).toBeNull();
});

it.each(["unmounted", "removed"])("answers Close when the dialog is %s", async (reason) => {
    const answer = askLoreBudgetStop(ref, loreBudgetStopFixture);
    renderShown();
    if (reason === "unmounted") await unmount(mounted.pop()!);
    else {
        // Another tab deleted the chat for good; a whole read finds it gone.
        acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: null, data: null });
        flushSync();
    }
    expect(get(loreBudgetStopDialog)).toBeNull();
    expect(await answer).toBe("close");
});
