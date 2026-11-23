// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The persona list picks through `changeUserPersona` (`pickBinding("personaId", ...)`). Without
// `chatRef` it is the settings' list: it marks and picks the tab's selection, also with a chat open,
// names no chat, and leaves the open chat's binding. A list opened for a given chat (`chatRef`) picks
// for that chat, selected or not, marks its bound persona that exists (none when unset or gone, never
// the view's tab fallback), names the chat, and closes when it is gone.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
// `persona.ts` pulls the PNG and inlay code in; its `changeUserPersona` is one line over `pickBinding`.
vi.mock("src/ts/persona", async () => {
    const { pickBinding } = await import("src/ts/storage/chatBindingPick");
    return {
        changeUserPersona: (id: string, target: { chaId: string; chatId: string } | null) =>
            pickBinding("personaId", id, target),
    };
});

import type { Chat } from "../../../shared/database.ts";
import { language } from "src/lang";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import {
    acceptRemoteChat,
    assembleChats,
    chatEntry,
    installChatTrashState,
    isActiveChat,
    selectChat,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selection, selectPersona } from "src/ts/storage/selection.svelte";
import { activePersona, editedPersona } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import ListedPersona from "./listedPersona.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const refK = { chaId: "c", chatId: "k" };
const refJ = { chaId: "c", chatId: "j" };
const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    note: "",
    localLore: [],
    message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
    ...fields,
});

function render(chatRef?: { chaId: string; chatId: string }) {
    const close = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ListedPersona, { target, props: { close, chatRef } }));
    flushSync();
    const rows = () => [...target.querySelectorAll<HTMLButtonElement>("button.border-t-1")];
    const rowNamed = (name: string) => rows().find((row) => row.textContent?.includes(name))!;
    const selectedNames = () =>
        rows()
            .filter((row) => row.classList.contains("bg-selected"))
            .map((row) => row.textContent?.trim());
    return { target, close, rows, rowNamed, selectedNames };
}

/** The tab selects `Ann`; chat `k` binds `Bob`, chat `j` binds nothing; `k` is open. */
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
                chats: [chat("k", { bindedPersona: "u2" }), chat("j")],
            },
        ],
        personas: [
            { id: "u1", name: "Ann", icon: "", note: "", personaPrompt: "" },
            { id: "u2", name: "Bob", icon: "", note: "", personaPrompt: "" },
            { id: "u3", name: "Cid", icon: "", note: "", personaPrompt: "" },
        ],
    } as any);
    selectPersona("u1");
    selectCharacter("c");
    selectChat("c", "k");
});

afterEach(async () => {
    selectCharacter(null);
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("the persona list with a chat open", () => {
    it("without chatRef the list marks the tab's selection, names no chat, and a pick selects for the tab, leaving the open chat's binding", () => {
        const list = render();
        expect(list.rows().map((row) => row.textContent?.trim())).toEqual(["Ann", "Bob", "Cid"]);
        expect(list.target.textContent).not.toContain(language.chatBinding.forChat("K"));
        // The open chat runs with its `Bob`, but the settings' list is the tab's `Ann`.
        expect(activePersona.id).toBe("u2");
        expect(editedPersona.id).toBe("u1");
        expect(list.selectedNames()).toEqual(["Ann"]);

        list.rowNamed("Cid").click();
        flushSync();
        expect(selection.personaId).toBe("u3");
        expect(editedPersona.name).toBe("Cid");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "u2" });
        expect(chatEntry(refJ)).not.toHaveProperty("bindedPersona");
        expect(activePersona.name).toBe("Bob");
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("a list opened for the open chat marks its bound persona, names it, and a pick binds it, not the tab", () => {
        const list = render(refK);
        expect(list.target.textContent).toContain(language.chatBinding.forChat("K"));
        // The edited view shows the tab's `Ann`, but the highlight is the binding's.
        expect(editedPersona.id).toBe("u1");
        expect(list.selectedNames()).toEqual(["Bob"]);

        list.rowNamed("Cid").click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "u3" });
        expect(chatEntry(refJ)).not.toHaveProperty("bindedPersona");
        expect(selection.personaId).toBe("u1");
        expect(activePersona.name).toBe("Cid");
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("without chatRef the mark stays on the tab's selection whatever the open chat binds", () => {
        selectChat("c", "j");
        const list = render();
        expect(list.selectedNames()).toEqual(["Ann"]);
        expect(list.target.textContent).not.toContain(language.chatBinding.forChat("J"));

        chatBindingPatch(refJ, { personaId: "u-gone" });
        flushSync();
        expect(list.selectedNames()).toEqual(["Ann"]);
        chatBindingPatch(refJ, { personaId: "u2" });
        flushSync();
        expect(activePersona.id).toBe("u2");
        expect(list.selectedNames()).toEqual(["Ann"]);
    });

    it("a list opened for a chat marks nothing for an unset or gone binding although the view falls back to the tab's persona", () => {
        selectChat("c", "j");
        const list = render(refJ);
        expect(activePersona.id).toBe("u1");
        expect(list.selectedNames()).toEqual([]);
        expect(list.target.textContent).toContain(language.chatBinding.forChat("J"));

        chatBindingPatch(refJ, { personaId: "u-gone" });
        flushSync();
        expect(list.selectedNames()).toEqual([]);
        chatBindingPatch(refJ, { personaId: "u2" });
        flushSync();
        expect(list.selectedNames()).toEqual(["Bob"]);
    });

    it("a list opened for a chat picks for that chat, not the open one, and closes when that chat is gone", () => {
        const list = render(refJ);
        expect(list.target.textContent).toContain(language.chatBinding.forChat("J"));
        expect(list.selectedNames()).toEqual([]);
        list.rowNamed("Ann").click();
        flushSync();
        expect(chatEntry(refJ)).toMatchObject({ bindedPersona: "u1" });
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "u2" });
        expect(selection.personaId).toBe("u1");
        expect(list.close).toHaveBeenCalledTimes(1);

        const another = render(refJ);
        // Another tab deleted the chat for good; a whole read finds it gone.
        acceptRemoteChat({ characterId: refJ.chaId, id: refJ.chatId, revision: null, data: null });
        expect(chatEntry(refJ)).toBeUndefined();
        flushSync();
        expect(another.close).toHaveBeenCalledTimes(1);
    });

    it("a list opened for a chat closes when another tab moves that chat to the Trash", () => {
        // Token revisions, so the mark can be ordered against the chats.
        const revision = "00000000-0000-4000-8000-000000000000:1:1";
        const rows = [chat("k", { bindedPersona: "u2" }), chat("j")].map((data) => ({
            characterId: "c",
            id: data.id,
            revision,
            trashedAt: null,
            data: data as Chat,
        }));
        assembleChats([{ chaId: "c" }], rows, [{ characterId: "c", revision, ids: ["k", "j"] }]);
        const list = render(refJ);
        expect(list.close).not.toHaveBeenCalled();
        installChatTrashState(refJ, revision, 5);
        expect(isActiveChat(refJ)).toBe(false);
        // The chat stays a member, read-only, so the raw entry is still there.
        expect(chatEntry(refJ)).toBeDefined();
        flushSync();
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("at home the list marks and picks the tab's selection and names no chat", () => {
        selectCharacter(null);
        const list = render();
        expect(list.target.textContent).not.toContain("For this chat");
        expect(list.selectedNames()).toEqual(["Ann"]);
        list.rowNamed("Cid").click();
        flushSync();
        expect(selection.personaId).toBe("u3");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "u2" });
        expect(list.close).toHaveBeenCalledTimes(1);
    });
});
