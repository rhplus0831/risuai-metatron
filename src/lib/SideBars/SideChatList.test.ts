// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `docs/plan/chat-binding.md`, slice 6: the two new-chat buttons (`SideChatList.svelte`'s and the
// chat list modal's, `src/lib/Others/ChatList.svelte`) start the chat from `initialChatBinding`:
// with `newChatBinding` unset or `inherit` the character's selected chat's bound ids that exist,
// never its `bindingReview`, read before the new chat takes the selection; with `empty` nothing; a
// group chat the same, with its members' first messages. A copy from the chat row's options spreads
// its loaded source and keeps all four fields, a gone id and a pending review included.

const alerts = vi.hoisted(() => ({ chatOption: 0 }));

vi.mock("src/ts/alert", () => ({
    alertChatOptions: vi.fn(async () => alerts.chatOption),
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertSelect: vi.fn(async () => "0"),
    alertStore: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock("src/ts/characters", () => ({
    importChat: vi.fn(),
    exportChat: vi.fn(),
    exportAllChats: vi.fn(),
    createBlankChar: vi.fn(),
    getCharImage: vi.fn(),
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
    changeChatTo: vi.fn(),
    createChatCopyName: (name: string, type: string) => `${name} (${type})`,
}));

import { normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { language } from "src/lang";
import { chatBinding } from "src/ts/storage/chatBinding.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    chatEntry,
    chatList,
    findChat,
    selectChat,
    selectedChatId,
    setChatMeta,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import ChatList from "../Others/ChatList.svelte";
import SideChatList from "./SideChatList.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: `Chat ${id.toUpperCase()}`,
    note: "",
    localLore: [],
    message: [{ role: "char", data: `hi from ${id}`, chatId: `m-${id}` }],
    ...fields,
});
const TAB = { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" };

/**
 * Character `c` (first message "Hello") with the chats `k` (bound to `m1`, `p1`, `u1`), `j` (a gone
 * model preset, `p1`, a padded persona id, review pending), and `n` (unbound), and the group `g` of
 * `c` with the chat `gk` (bound to `m1`, `p1`, `u1`). The tab selects `m2`, `p2`, `u2`: never what a
 * new chat starts from.
 */
beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "Hello",
                chatPage: 0,
                chats: [
                    chat("k", { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" }),
                    chat("j", {
                        modelPresetId: "m-gone",
                        promptPresetId: "p1",
                        bindedPersona: " u1 ",
                        bindingReview: true,
                    }),
                    chat("n"),
                ],
            },
            {
                chaId: "g",
                type: "group",
                name: "G",
                characters: ["c"],
                chatPage: 0,
                chats: [chat("gk", { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" })],
            },
        ],
        botPresets: [
            { id: "p1", name: "Prompt One" },
            { id: "p2", name: "Prompt Two" },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" }),
            normalizeModelPreset({ name: "Model Two", mainSlot: { profileId: "gpt" } }, { id: "m2" }),
        ],
        modelProfiles: [normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o" })],
        personas: [
            { id: "u1", name: "Ann", icon: "", note: "", personaPrompt: "" },
            { id: "u2", name: "Bob", icon: "", note: "", personaPrompt: "" },
        ],
    } as any);
    selectPreset("p2");
    selectModelPreset("m2");
    selectPersona("u2");
    selectCharacter(null);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

const byChaId = (chaId: string) => characterList().find((entry) => entry?.chaId === chaId)!;

function renderSide(chaId: string) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(SideChatList, { target, props: { chara: byChaId(chaId) } }));
    flushSync();
    const newChat = () =>
        [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === language.newChat)!;
    /** The options button of the row showing `name`. */
    const options = (name: string) => {
        const row = [...target.querySelectorAll<HTMLButtonElement>("[data-risu-chat-idx]")].find((entry) =>
            entry.textContent?.includes(name),
        )!;
        return row.querySelector<HTMLElement>('[role="button"]')!;
    };
    return { target, newChat, options };
}

function renderModal() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ChatList, { target, props: { close: vi.fn() } }));
    flushSync();
    // The plus button is the first of the two in the footer row (the second toggles the edit mode).
    const newChat = () => target.querySelector<HTMLButtonElement>(".flex.mt-2.items-center > button")!;
    return { target, newChat };
}

const ids = (chaId: string) => chatList(chaId).map((entry) => entry.id);
const first = (chaId: string) => chatEntry({ chaId, chatId: ids(chaId)[0] })!;
const strip = (entry: Record<string, unknown>) => {
    const { id, name, fmIndex, ...rest } = entry;
    return rest;
};

describe("chat pins in the sidebar", () => {
    it.each(["root", "folder"])("shows a pin before only the pinned %s row's name", (placement) => {
        const pinned = { chaId: "c", chatId: "k" };
        setChatMeta(pinned, { pinned: true });
        setChatMeta({ chaId: "c", chatId: "j" }, { pinned: false });
        if (placement === "folder") {
            byChaId("c").chatFolders = [{ id: "f", name: "Folder", folded: false }];
            for (const chatId of ["k", "j", "n"]) {
                setChatMeta({ chaId: "c", chatId }, { folderId: "f" });
            }
        }
        const { target } = renderSide("c");
        const rows = () => [...target.querySelectorAll("[data-risu-chat-idx]")];
        expect(rows()).toHaveLength(3);
        expect(rows().map((row) => row.querySelectorAll("svg.lucide-pin").length)).toEqual([1, 0, 0]);
        expect(rows()[0].querySelector("svg.lucide-pin")!.nextElementSibling?.textContent).toBe("Chat K");

        setChatMeta(pinned, {}, ["pinned"]);
        flushSync();
        expect(target.querySelectorAll("svg.lucide-pin")).toHaveLength(0);
    });

    it("copying a pinned row clears the copy's pin and keeps the source pinned", async () => {
        alerts.chatOption = 0;
        const source = { chaId: "c", chatId: "j" };
        setChatMeta(source, { pinned: true });
        const side = renderSide("c");
        side.options("Chat J").click();
        await vi.waitFor(() => expect(ids("c")).toHaveLength(4));
        const copy = chatList("c").find((entry) => entry.name === "Chat J (Copy)")!;
        expect(copy.id).not.toBe(source.chatId);
        expect(copy).not.toHaveProperty("pinned");
        expect(findChat({ chaId: "c", chatId: copy.id })).not.toHaveProperty("pinned");
        expect(findChat(source)).toHaveProperty("pinned", true);
        expect(chatEntry(source)).toHaveProperty("pinned", true);
    });
});

describe("new chat toggle inheritance", () => {
    it.each(["sidebar", "modal"] as const)(
        "the %s button copies the selected chat's map and preset link, and the empty policy omits both",
        (surface) => {
            const source = { chaId: "c", chatId: "j" };
            const toggles = { toggle_flag: "0", toggle_title: "selected chat" };
            setChatMeta(
                { chaId: "c", chatId: "k" },
                { GLGlobalVariables: { toggle_title: "first chat" }, togglePresetId: "first-preset" },
            );
            setChatMeta(source, { GLGlobalVariables: toggles, togglePresetId: "selected-preset" });
            settings.globalChatVariables = { toggle_title: "legacy" };
            settings.ui.newChatBinding = "inherit";
            selectCharacter("c");
            selectChat("c", "j");
            const list = surface === "sidebar" ? renderSide("c") : renderModal();
            list.newChat().click();
            flushSync();
            const created = { chaId: "c", chatId: ids("c")[0] };
            expect(created.chatId).not.toBe("j");
            expect(findChat(created)!.GLGlobalVariables).toEqual(toggles);
            expect(findChat(created)!.togglePresetId).toBe("selected-preset");
            setChatMeta(created, { GLGlobalVariables: { toggle_flag: "1", toggle_title: "edited new chat" } });
            expect(findChat(source)!.GLGlobalVariables).toEqual(toggles);
            expect(findChat(source)!.togglePresetId).toBe("selected-preset");
            settings.ui.newChatBinding = "empty";
            list.newChat().click();
            flushSync();
            expect(findChat({ chaId: "c", chatId: ids("c")[0] })!.GLGlobalVariables).toBeUndefined();
            expect(findChat({ chaId: "c", chatId: ids("c")[0] })).not.toHaveProperty("togglePresetId");
            expect(settings.globalChatVariables).toEqual({ toggle_title: "legacy" });
        },
    );
});

describe("the sidebar's new chat button", () => {
    it("inherits the selected chat's existing ids (not the first chat's, not the tab's), without the review, and selects the new chat", () => {
        selectChat("c", "j");
        const side = renderSide("c");
        expect(ids("c")).toEqual(["k", "j", "n"]);
        side.newChat().click();
        flushSync();
        expect(ids("c")).toHaveLength(4);
        expect(ids("c").slice(1)).toEqual(["k", "j", "n"]);
        expect(first("c")).toMatchObject({ name: "New Chat 4", promptPresetId: "p1" });
        expect(strip(first("c"))).toEqual({ promptPresetId: "p1" });
        expect(selectedChatId("c")).toBe(ids("c")[0]);
        // The source keeps its review; the new chat has none.
        expect(chatEntry({ chaId: "c", chatId: "j" })).toMatchObject({ bindingReview: true });
        expect(chatBinding({ chaId: "c", chatId: ids("c")[0] })).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });

        // A fully bound selected chat: the new chat can be sent at once.
        selectChat("c", "k");
        side.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
        expect(chatBinding({ chaId: "c", chatId: ids("c")[0] })).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });

        // The chat just created is now the selected one: the next new chat inherits from it.
        side.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
    });

    it("an unbound selected chat gives nothing, never the tab's selection; empty gives nothing even from a bound chat", () => {
        selectChat("c", "n");
        const side = renderSide("c");
        side.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({});
        expect(first("c")).not.toMatchObject(TAB);

        settings.ui.newChatBinding = "empty";
        selectChat("c", "k");
        side.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({});
        expect(chatBinding({ chaId: "c", chatId: ids("c")[0] })).toMatchObject({ ok: false });

        // Anything but `empty` is inherit.
        (settings.ui as Record<string, unknown>).newChatBinding = "whatever";
        selectChat("c", "k");
        side.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
    });

    it("a group chat inherits its selected chat's binding and starts with the members' first messages", () => {
        const side = renderSide("g");
        side.newChat().click();
        flushSync();
        expect(ids("g")).toHaveLength(2);
        expect(strip(first("g"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
        expect(selectedChatId("g")).toBe(ids("g")[0]);
        expect(findChat({ chaId: "g", chatId: ids("g")[0] })?.message).toEqual([
            { saying: "c", role: "char", data: "Hello", chatId: expect.any(String) },
        ]);
    });

    it("a copy from the row's options keeps all four fields of its source: a gone id, a padded id, and the pending review", async () => {
        alerts.chatOption = 0;
        const side = renderSide("c");
        side.options("Chat J").click();
        await vi.waitFor(() => expect(ids("c")).toHaveLength(4));
        flushSync();
        const copy = chatList("c").find((entry) => entry.name === "Chat J (Copy)")!;
        expect(copy).toMatchObject({
            modelPresetId: "m-gone",
            promptPresetId: "p1",
            bindedPersona: " u1 ",
            bindingReview: true,
        });
        expect(copy.id).not.toBe("j");
    });
});

describe("the chat list modal's new chat button", () => {
    it("inherits the selected character's selected chat's existing ids, and empty gives nothing", () => {
        selectCharacter("c");
        selectChat("c", "j");
        const modal = renderModal();
        modal.newChat().click();
        flushSync();
        expect(ids("c")).toHaveLength(4);
        expect(strip(first("c"))).toEqual({ promptPresetId: "p1" });
        expect(first("c").name).toBe("New Chat 4");
        expect(selectedChatId("c")).toBe(ids("c")[0]);

        selectChat("c", "k");
        modal.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });

        settings.ui.newChatBinding = "empty";
        modal.newChat().click();
        flushSync();
        expect(strip(first("c"))).toEqual({});
    });

    it("a group inherits too, with the members' first messages", () => {
        selectCharacter("g");
        const modal = renderModal();
        modal.newChat().click();
        flushSync();
        expect(ids("g")).toHaveLength(2);
        expect(strip(first("g"))).toEqual({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
        expect(findChat({ chaId: "g", chatId: ids("g")[0] })?.message).toEqual([
            { saying: "c", role: "char", data: "Hello", chatId: expect.any(String) },
        ]);
    });
});
