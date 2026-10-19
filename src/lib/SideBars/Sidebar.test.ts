import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the rail, its avatars, the character index, and persisted stores real; the editor panels
// and unrelated services are outside these rendering and drag/drop cases.
vi.mock("./CharConfig.svelte", () => ({ default: () => {} }));
vi.mock("./SideChatList.svelte", () => ({ default: () => {} }));
vi.mock("./OpenChatPanel.svelte", () => ({ default: () => {} }));
vi.mock("./DevTool.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/characters", () => ({
    addCharacter: vi.fn(),
    changeChar: vi.fn(),
    createBlankChar: vi.fn(),
    getCharImage: vi.fn(async () => ""),
}));
vi.mock("src/ts/globalApi.svelte", async () => ({
    checkCharOrder: (await import("src/ts/storage/characterOrder")).checkCharOrder,
    openPinnedChat: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({ alertInput: vi.fn(), alertSelect: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn() }));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/process/chatStatus.svelte", async () => {
    const { writable } = await import("svelte/store");
    return {
        chatStatusKey: vi.fn(),
        generatingChatKeys: () => new Set<string>(),
        recoveryChatKeys: writable(new Set<string>()),
        unseenChatKeys: writable(new Set<string>()),
    };
});

import type { Database } from "src/ts/storage/database.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import Sidebar from "./Sidebar.svelte";

const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});
afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

function renderRail(order: Database["characterOrder"]) {
    installFlatDatabaseWithChats({
        characters: [
            { chaId: "root", name: "Root", type: "character", chats: [] },
            { chaId: "member", name: "Member", type: "character", chats: [] },
            { chaId: "trash-root", name: "Trashed root", type: "character", trashTime: 1, chats: [] },
            { chaId: "trash-member", name: "Trashed member", type: "character", trashTime: 1, chats: [] },
        ],
        characterOrder: order,
        menuSideBar: false,
        showFolderName: true,
    });
    selectCharacter(null);
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(Sidebar, { target }));
    flushSync();
    return target;
}

const folder = (data: string[]) => ({ id: "f", name: "Folder", color: "", data });
const avatars = (target: HTMLElement) =>
    [...target.querySelectorAll<HTMLElement>("[data-char-id]")].map((node) => node.dataset.charId);
const row = (target: HTMLElement, id: string) =>
    target.querySelector(`[data-char-id="${id}"]`)!.closest<HTMLElement>('[role="listitem"][draggable="true"]')!;

function openFolder(target: HTMLElement) {
    const label = [...target.querySelectorAll<HTMLElement>("span")].find((node) => node.textContent === "Folder")!;
    label.click();
    flushSync();
}

function drag(source: HTMLElement, destination: HTMLElement) {
    const dataTransfer = new DataTransfer();
    // The native drag preview has no happy-dom implementation; payloads and events stay real.
    dataTransfer.setDragImage = () => {};
    const dispatch = (target: HTMLElement, type: string) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true });
        // happy-dom does not install dataTransfer from DragEventInit.
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        target.dispatchEvent(event);
    };
    dispatch(source, "dragstart");
    dispatch(destination, "dragover");
    dispatch(destination, "drop");
    dispatch(source, "dragend");
    flushSync();
}

describe("Sidebar character rail", () => {
    it("hides trashed characters at the root and inside an open folder", () => {
        const target = renderRail(["trash-root", "root", folder(["trash-member", "member"])]);
        expect(avatars(target)).toEqual(["root"]);
        openFolder(target);
        expect(avatars(target)).toEqual(["root", "member"]);
    });

    it("skips unknown and prototype-named ids at the root and in an open folder without throwing", () => {
        const target = renderRail([
            "unknown-root",
            "toString",
            "root",
            folder(["unknown-member", "toString", "member"]),
        ]);
        expect(avatars(target)).toEqual(["root"]);
        openFolder(target);
        expect(avatars(target)).toEqual(["root", "member"]);
    });

    it("moves the visible member to a root slot and back using raw positions, leaving hidden ids in place", () => {
        const target = renderRail(["hidden-root", "root", folder(["hidden-member", "member"])]);
        openFolder(target);
        expect(avatars(target)).toEqual(["root", "member"]);

        // The insertion slot after Root follows a hidden persisted root entry.
        const rootSlot = row(target, "root").nextElementSibling as HTMLElement;
        expect(rootSlot.getAttribute("role")).toBe("listitem");
        drag(row(target, "member"), rootSlot);
        expect(settings.characterOrder).toEqual(["hidden-root", "root", "member", folder(["hidden-member"])]);
        expect(avatars(target)).toEqual(["root", "member"]);

        // Now both the dragged root avatar and its folder target have hidden entries before them.
        const folderRow = [...target.querySelectorAll<HTMLElement>('[role="listitem"][draggable="true"]')].find(
            (node) => node.textContent?.trim() === "Folder",
        )!;
        drag(row(target, "member"), folderRow);
        expect(settings.characterOrder).toEqual(["hidden-root", "root", folder(["hidden-member", "member"])]);
        expect(avatars(target)).toEqual(["root", "member"]);
    });
});
