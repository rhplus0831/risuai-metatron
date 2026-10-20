// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The open chat's header (`OpenChatHeader.svelte`) names the chat from its list entry, with a pin
// for a pinned chat, and follows a rename from elsewhere. Its rename edits a draft that is written
// once, on Enter, the save button, or blur; Escape, an empty or unchanged name, and an Enter that ends
// an IME composition write nothing; a chat deleted while it is edited takes no write. Export passes
// the chat's id to `exportChat`.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/characters", () => ({ exportChat: vi.fn() }));

import { language } from "src/lang";
import { exportChat } from "src/ts/characters";
import { chatEntry, deleteChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import OpenChatHeader from "./OpenChatHeader.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const refK = { chaId: "c", chatId: "k" };
const refJ = { chaId: "c", chatId: "j" };
const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: `Chat ${id.toUpperCase()}`,
    note: "",
    localLore: [],
    message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
    ...fields,
});

function render(chatRef: { chaId: string; chatId: string }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(OpenChatHeader, { target, props: { chat: chatRef } }));
    flushSync();
    const q = <T extends Element>(selector: string) => target.querySelector<T>(selector);
    return {
        target,
        name: () => q<HTMLElement>("[data-open-chat-name]")?.textContent,
        input: () => q<HTMLInputElement>("[data-open-chat-name-input]"),
        rename: () => q<HTMLButtonElement>("[data-open-chat-rename]")!,
        exportButton: () => q<HTMLButtonElement>("[data-open-chat-export]")!,
        startEdit() {
            this.rename().click();
            flushSync();
            return this.input()!;
        },
    };
}

function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}

function key(input: HTMLInputElement, key: string, init: KeyboardEventInit = {}) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    flushSync();
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [chat("k"), chat("j", { pinned: true })],
            },
        ],
    } as any);
    vi.mocked(exportChat).mockClear();
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("OpenChatHeader", () => {
    it("names the chat, shows a pin only for a pinned chat, and follows a rename from elsewhere", () => {
        const k = render(refK);
        expect(k.name()).toBe("Chat K");
        expect(k.target.querySelector(".lucide-pin")).toBeNull();
        expect(k.rename().getAttribute("aria-label")).toBe(language.openChat.rename);

        const j = render(refJ);
        expect(j.name()).toBe("Chat J");
        expect(j.target.querySelector(".lucide-pin")).not.toBeNull();

        setChatMeta(refK, { name: "Renamed elsewhere" });
        flushSync();
        expect(k.name()).toBe("Renamed elsewhere");
    });

    it("renames on Enter, on the save button, and on blur, starting from the current name", () => {
        const header = render(refK);
        let input = header.startEdit();
        expect(input.value).toBe("Chat K");
        expect(document.activeElement).toBe(input);

        type(input, "First");
        key(input, "Enter");
        expect(header.input()).toBeNull();
        expect(chatEntry(refK)?.name).toBe("First");
        expect(header.name()).toBe("First");

        input = header.startEdit();
        type(input, "Second");
        header.rename().click();
        flushSync();
        expect(chatEntry(refK)?.name).toBe("Second");

        input = header.startEdit();
        type(input, "Third");
        input.dispatchEvent(new FocusEvent("blur"));
        flushSync();
        expect(header.input()).toBeNull();
        expect(chatEntry(refK)?.name).toBe("Third");
    });

    it("writes nothing on Escape, on an empty name, or on an Enter that ends an IME composition", () => {
        const header = render(refK);
        let input = header.startEdit();
        type(input, "Dropped");
        key(input, "Escape");
        expect(header.input()).toBeNull();
        expect(chatEntry(refK)?.name).toBe("Chat K");

        input = header.startEdit();
        type(input, "   ");
        key(input, "Enter");
        expect(header.input()).toBeNull();
        expect(chatEntry(refK)?.name).toBe("Chat K");

        input = header.startEdit();
        type(input, "한글");
        key(input, "Enter", { isComposing: true });
        expect(header.input()).toBe(input);
        expect(chatEntry(refK)?.name).toBe("Chat K");
        key(input, "Enter");
        expect(chatEntry(refK)?.name).toBe("한글");
    });

    it("takes no write for a chat deleted while it is edited", () => {
        const header = render(refK);
        const input = header.startEdit();
        type(input, "Late");
        deleteChat(refK);
        flushSync();
        expect(() => input.dispatchEvent(new FocusEvent("blur"))).not.toThrow();
        expect(chatEntry(refK)).toBeUndefined();
    });

    it("exports the chat by its id", () => {
        const header = render(refJ);
        header.exportButton().click();
        expect(exportChat).toHaveBeenCalledWith("j");
    });
});
