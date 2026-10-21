// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two new-chat buttons (`SideChatList.svelte`'s and the chat list modal's,
// `src/lib/Others/ChatList.svelte`) start the chat from `initialChatBinding`: with `newChatBinding`
// unset or `inherit` the character's selected chat's bound ids that exist, never its
// `bindingReview`, read before the new chat takes the selection; with `empty` nothing; a group chat
// the same, with its members' first messages. A copy from the chat row's options spreads its loaded
// source and keeps all four fields, a gone id and a pending review included.

const alerts = vi.hoisted(() => ({ chatOption: 0 }));
/** The SortableJS instances the list created, so a test can run a drop's `onEnd` (happy-dom cannot drag). */
const sortables = vi.hoisted(
    () =>
        [] as {
            destroyed: boolean;
            options: { group: string; disabled?: boolean; onEnd: (event: unknown) => Promise<void> };
        }[],
);

vi.mock("sortablejs/modular/sortable.core.esm.js", () => {
    class Sortable {
        options: any;
        destroyed = false;
        constructor(_el: HTMLElement, options: any) {
            this.options = options;
            sortables.push(this);
        }
        destroy() {
            this.destroyed = true;
        }
        option(name: string, value: unknown) {
            this.options[name] = value;
        }
        static create(el: HTMLElement, options: any) {
            return new Sortable(el, options);
        }
    }
    return { default: Sortable };
});

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertChatOptions: vi.fn(async () => alerts.chatOption),
        alertConfirm: vi.fn(async () => true),
        alertSelect: vi.fn(async () => "0"),
    }),
);
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
import { alertConfirm, alertSelect } from "src/ts/alert";
import { chatBinding } from "src/ts/storage/chatBinding.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { applyRawCharacter } from "src/ts/storage/records.svelte";
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
    sortables.length = 0;
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

// A chat whose `folderId` names no folder of its character (a two-tab move/delete race, a refused
// folder write) lists at the root (`chatFolderOf`) and keeps its id; a drop always passes
// `reorderChats` a permutation; a folder delete resolves its folder and character by id after the
// confirm.
describe("a chat whose folder does not exist", () => {
    const rowOf = (target: HTMLElement, name: string) =>
        [...target.querySelectorAll<HTMLElement>("[data-risu-chat-idx]")].find((row) =>
            row.textContent?.includes(name),
        )!;
    const inFolder = (row: HTMLElement) => row.closest("[data-risu-chat-folder-idx]") !== null;
    /** Runs the drop handler of the chat lists, as SortableJS does after a drag. */
    const drop = async () => {
        const chatsSortable = sortables.find((entry) => entry.options.group === "chats")!;
        await chatsSortable.options.onEnd.call(chatsSortable, {});
        flushSync();
    };

    it("lists at the root with its id kept, and in its folder once that folder exists", () => {
        byChaId("c").chatFolders = [{ id: "f", name: "Folder", folded: false }];
        setChatMeta({ chaId: "c", chatId: "k" }, { folderId: "gone" });
        setChatMeta({ chaId: "c", chatId: "j" }, { folderId: "f" });
        const { target } = renderSide("c");
        expect(target.querySelectorAll("[data-risu-chat-idx]")).toHaveLength(3);
        expect(inFolder(rowOf(target, "Chat K"))).toBe(false);
        expect(inFolder(rowOf(target, "Chat J"))).toBe(true);
        expect(inFolder(rowOf(target, "Chat N"))).toBe(false);
        expect(chatEntry({ chaId: "c", chatId: "k" })?.folderId).toBe("gone");

        byChaId("c").chatFolders = [...byChaId("c").chatFolders, { id: "gone", name: "Back", folded: false }];
        flushSync();
        expect(inFolder(rowOf(target, "Chat K"))).toBe(true);
        expect(target.querySelectorAll("[data-risu-chat-idx]")).toHaveLength(3);
    });

    it("a drop reorders with a dangling member, keeps its id, and moves a real member out of its folder", async () => {
        byChaId("c").chatFolders = [{ id: "f", name: "Folder", folded: false }];
        setChatMeta({ chaId: "c", chatId: "k" }, { folderId: "gone" });
        setChatMeta({ chaId: "c", chatId: "j" }, { folderId: "f" });
        const { target } = renderSide("c");
        // Drag N above K at the root, and J out of its folder to the end of the root.
        const root = rowOf(target, "Chat K").parentElement!;
        root.insertBefore(rowOf(target, "Chat N"), rowOf(target, "Chat K"));
        root.appendChild(rowOf(target, "Chat J"));
        await drop();
        expect(ids("c")).toEqual(["n", "k", "j"]);
        expect(chatEntry({ chaId: "c", chatId: "k" })?.folderId).toBe("gone");
        expect(chatEntry({ chaId: "c", chatId: "j" })).not.toHaveProperty("folderId");
        expect(inFolder(rowOf(target, "Chat K"))).toBe(false);
    });

    it("a drop missing a chat's row still passes a permutation, appending that chat", async () => {
        const { target } = renderSide("c");
        const root = rowOf(target, "Chat K").parentElement!;
        root.appendChild(rowOf(target, "Chat K"));
        rowOf(target, "Chat J").remove();
        await drop();
        expect(ids("c")).toEqual(["n", "k", "j"]);
    });

    it("a folder delete confirmed after another folder was put first deletes the confirmed folder", async () => {
        byChaId("c").chatFolders = [
            { id: "a", name: "Folder A", folded: false },
            { id: "b", name: "Folder B", folded: false },
        ];
        setChatMeta({ chaId: "c", chatId: "k" }, { folderId: "b" });
        setChatMeta({ chaId: "c", chatId: "j" }, { folderId: "a" });
        let confirm!: (value: boolean) => void;
        vi.mocked(alertConfirm).mockImplementationOnce(() => new Promise<boolean>((resolve) => (confirm = resolve)));
        const { target } = renderSide("c");
        const folderB = target.querySelector<HTMLElement>('[data-risu-chat-folder-idx="1"]')!;
        expect(folderB.textContent).toContain("Folder B");
        const trash = [...folderB.querySelector("button")!.querySelectorAll<HTMLElement>('[role="button"]')][2];
        trash.click();
        await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledWith(`${language.removeConfirm}Folder B`));

        // Another tab's folder arrives at the front while the confirm is open.
        byChaId("c").chatFolders = [{ id: "x", name: "Folder X", folded: false }, ...byChaId("c").chatFolders];
        flushSync();
        confirm(true);
        await vi.waitFor(() => expect(byChaId("c").chatFolders.map((folder) => folder.id)).toEqual(["x", "a"]));
        expect(chatEntry({ chaId: "c", chatId: "k" })).not.toHaveProperty("folderId");
        expect(chatEntry({ chaId: "c", chatId: "j" })?.folderId).toBe("a");
    });

    it("a folder delete confirmed after the selection moved to another character changes only the first", async () => {
        byChaId("c").chatFolders = [{ id: "same", name: "Shared", folded: false }];
        byChaId("g").chatFolders = [{ id: "same", name: "Shared", folded: false }];
        setChatMeta({ chaId: "c", chatId: "k" }, { folderId: "same" });
        setChatMeta({ chaId: "g", chatId: "gk" }, { folderId: "same" });
        let confirm!: (value: boolean) => void;
        vi.mocked(alertConfirm).mockImplementationOnce(() => new Promise<boolean>((resolve) => (confirm = resolve)));
        const target = document.createElement("div");
        document.body.appendChild(target);
        // The selected character as `Sidebar.svelte` passes it, read through the prop at each access.
        let selected = byChaId("c");
        mounted.push(
            mount(SideChatList, {
                target,
                props: {
                    get chara() {
                        return selected;
                    },
                },
            }),
        );
        flushSync();
        const folder = target.querySelector<HTMLElement>('[data-risu-chat-folder-idx="0"]')!;
        [...folder.querySelector("button")!.querySelectorAll<HTMLElement>('[role="button"]')][2].click();
        await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalled());

        selected = byChaId("g");
        confirm(true);
        await vi.waitFor(() => expect(byChaId("c").chatFolders).toEqual([]));
        expect(chatEntry({ chaId: "c", chatId: "k" })).not.toHaveProperty("folderId");
        expect(byChaId("g").chatFolders.map((entry) => entry.id)).toEqual(["same"]);
        expect(chatEntry({ chaId: "g", chatId: "gk" })?.folderId).toBe("same");
    });
});

// The folder color dialogs resolve the character and the folder by the ids captured before the
// first dialog, never by the row's `#each` item or `chara`.
describe("a folder color chosen while the folders change", () => {
    /** The first dialog answers "change color" at once; the color list waits for `pick`. */
    function holdColorDialog() {
        let pick!: (value: string) => void;
        vi.mocked(alertSelect).mockClear();
        vi.mocked(alertSelect)
            .mockImplementationOnce(async () => "0")
            .mockImplementationOnce(() => new Promise<string>((resolve) => (pick = resolve)));
        return (color: string) => pick(String(["red", "green", "blue"].indexOf(color)));
    }
    const colorButton = (target: HTMLElement, index: number) => {
        const folder = target.querySelector<HTMLElement>(`[data-risu-chat-folder-idx="${index}"]`)!;
        return [...folder.querySelector("button")!.querySelectorAll<HTMLElement>('[role="button"]')][0];
    };
    const colors = (chaId: string) => byChaId(chaId).chatFolders.map((folder) => [folder.id, folder.color]);

    it("recolors the chosen folder after another folder was put first", async () => {
        byChaId("c").chatFolders = [
            { id: "a", name: "Folder A", folded: false },
            { id: "b", name: "Folder B", folded: false },
        ];
        const pick = holdColorDialog();
        const { target } = renderSide("c");
        colorButton(target, 1).click();
        await vi.waitFor(() => expect(alertSelect).toHaveBeenCalledTimes(2));

        byChaId("c").chatFolders = [{ id: "x", name: "Folder X", folded: false }, ...byChaId("c").chatFolders];
        flushSync();
        pick("green");
        await vi.waitFor(() => expect(colors("c")).toContainEqual(["b", "green"]));
        expect(colors("c")).toEqual([
            ["x", undefined],
            ["a", undefined],
            ["b", "green"],
        ]);
    });

    it("recolors nothing when the chosen folder was deleted meanwhile", async () => {
        byChaId("c").chatFolders = [
            { id: "a", name: "Folder A", folded: false },
            { id: "b", name: "Folder B", folded: false },
        ];
        const pick = holdColorDialog();
        const { target } = renderSide("c");
        colorButton(target, 0).click();
        await vi.waitFor(() => expect(alertSelect).toHaveBeenCalledTimes(2));

        byChaId("c").chatFolders = byChaId("c").chatFolders.filter((folder) => folder.id !== "a");
        flushSync();
        pick("red");
        await new Promise((resolve) => setTimeout(resolve, 0));
        flushSync();
        expect(colors("c")).toEqual([["b", undefined]]);
    });

    it("recolors the first character's folder after the selection moved to another character", async () => {
        byChaId("c").chatFolders = [{ id: "same", name: "Shared", folded: false }];
        byChaId("g").chatFolders = [{ id: "same", name: "Shared G", folded: false }];
        const pick = holdColorDialog();
        const target = document.createElement("div");
        document.body.appendChild(target);
        // The selected character as `Sidebar.svelte` passes it: a reactive prop.
        const selected = writable(byChaId("c"));
        const chara = fromStore(selected);
        mounted.push(
            mount(SideChatList, {
                target,
                props: {
                    get chara() {
                        return chara.current;
                    },
                },
            }),
        );
        flushSync();
        colorButton(target, 0).click();
        await vi.waitFor(() => expect(alertSelect).toHaveBeenCalledTimes(2));

        selected.set(byChaId("g"));
        flushSync();
        expect(target.querySelector('[data-risu-chat-folder-idx="0"]')!.textContent).toContain("Shared G");
        pick("blue");
        await vi.waitFor(() => expect(colors("c")).toEqual([["same", "blue"]]));
        expect(colors("g")).toEqual([["same", undefined]]);
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

// The filter field matches a chat's name and its folder's name through the Korean-aware matcher; a
// filtered view opens its folders without writing `folded`, and every SortableJS instance is disabled
// while the field is non-empty.
describe("the chat list filter", () => {
    beforeEach(() => {
        byChaId("c").chatFolders = [{ id: "f", name: "Harbor", folded: true }];
        setChatMeta({ chaId: "c", chatId: "k" }, { name: "해적 이야기", folderId: "f" });
        setChatMeta({ chaId: "c", chatId: "j" }, { name: "Boat Trip", folderId: "f" });
        setChatMeta({ chaId: "c", chatId: "n" }, { name: "Root Chat" });
    });

    const field = (target: HTMLElement) =>
        target.querySelector<HTMLInputElement>(`input[placeholder="${language.search}"]`)!;
    const type = (target: HTMLElement, text: string) => {
        field(target).value = text;
        field(target).dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    /** The names of the chat rows the user can see (not under a `hidden` element). */
    const shown = (target: HTMLElement) =>
        [...target.querySelectorAll<HTMLElement>("[data-risu-chat-idx]")]
            .filter((row) => !row.closest(".hidden"))
            .map((row) => row.textContent!.trim());
    const folderShown = (target: HTMLElement) =>
        !target.querySelector('[data-risu-chat-folder-idx="0"]')!.classList.contains("hidden");
    const live = () => sortables.filter((entry) => !entry.destroyed);
    const dragDisabled = () => live().map((entry) => entry.options.disabled === true);

    it("a foldered chat's name shows that chat in its opened folder and hides the rest, without unfolding it", () => {
        const { target } = renderSide("c");
        expect(shown(target)).toEqual(["Root Chat"]);
        type(target, "boat");
        expect(shown(target)).toEqual(["Boat Trip"]);
        expect(folderShown(target)).toBe(true);
        expect(byChaId("c").chatFolders[0].folded).toBe(true);
    });

    it("an initial-consonant query matches a Korean chat name", () => {
        const { target } = renderSide("c");
        type(target, "ㅎㅈ");
        expect(shown(target)).toEqual(["해적 이야기"]);
    });

    it("a folder's name shows all of its chats, and an unmatched folder is hidden", () => {
        const { target } = renderSide("c");
        type(target, "harb");
        expect(shown(target)).toEqual(["해적 이야기", "Boat Trip"]);
        type(target, "root");
        expect(shown(target)).toEqual(["Root Chat"]);
        expect(folderShown(target)).toBe(false);
    });

    it("drag is off while filtered, also for instances created then, and clearing restores rows and drag", async () => {
        const { target } = renderSide("c");
        expect(dragDisabled()).toEqual([false, false, false]);
        type(target, "boat");
        expect(dragDisabled()).toEqual([true, true, true]);

        // The list's instances are created again (as after a drop) while the field is non-empty.
        const chatsSortable = live().find((entry) => entry.options.group === "chats")!;
        await chatsSortable.options.onEnd.call(chatsSortable, {});
        flushSync();
        expect(sortables.filter((entry) => entry.destroyed)).toHaveLength(3);
        expect(dragDisabled()).toEqual([true, true, true]);

        type(target, "");
        expect(dragDisabled()).toEqual([false, false, false]);
        // The folder is folded again: its rows are hidden as before the filter.
        expect(shown(target)).toEqual(["Root Chat"]);
        byChaId("c").chatFolders[0].folded = false;
        flushSync();
        expect(shown(target)).toEqual(["해적 이야기", "Boat Trip", "Root Chat"]);
    });

    it("resets when the character changes, not when the server replaces the same character's record", () => {
        const target = document.createElement("div");
        document.body.appendChild(target);
        const selected = writable(byChaId("c"));
        const chara = fromStore(selected);
        mounted.push(
            mount(SideChatList, {
                target,
                props: {
                    get chara() {
                        return chara.current;
                    },
                },
            }),
        );
        flushSync();
        type(target, "boat");
        applyRawCharacter("c", { ...JSON.parse(JSON.stringify(byChaId("c"))), name: "C refreshed" });
        selected.set(byChaId("c"));
        flushSync();
        expect(byChaId("c").name).toBe("C refreshed");
        expect(field(target).value).toBe("boat");
        expect(shown(target)).toEqual(["Boat Trip"]);

        selected.set(byChaId("g"));
        flushSync();
        expect(field(target).value).toBe("");
        expect(shown(target)).toEqual(["Chat GK"]);
        expect(dragDisabled().every((disabled) => !disabled)).toBe(true);
    });
});
