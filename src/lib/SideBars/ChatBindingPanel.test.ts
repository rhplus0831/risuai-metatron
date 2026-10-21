// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The binding panel (`ChatBindingPanel.svelte`) shows a chat's model preset, prompt preset, and persona by
// name, or as not set or deleted, from the chat's list entry; it follows a binding patch, a record's deletion
// and return, and a rename; a pending review shows its note and a confirm button that clears it; the bound
// persona's non-blank note shows as written; a row opens its picker for this chat (the picker store holds
// `{ chatRef }`); a chat that is not a member shows nothing, and a confirm after the chat went does not
// throw. The dialog (`ChatBindingDialog.svelte`) wraps the panel, names the chat, focuses its close button,
// and closes itself when the chat is gone.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { language } from "src/lang";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { chatEntry, deleteChat } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { chatBindingDialog, openModelPresetList, openPersonaList, openPresetList } from "src/ts/stores.svelte";
import ChatBindingDialog from "../Others/ChatBindingDialog.svelte";
import ChatBindingPanel from "./ChatBindingPanel.svelte";

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
const strings = language.chatBinding;

function renderPanel(chatRef: { chaId: string; chatId: string }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ChatBindingPanel, { target, props: { chatRef } }));
    flushSync();
    const row = (field: string) => target.querySelector<HTMLButtonElement>(`[data-chat-binding-field="${field}"]`)!;
    /** The three rows' values as shown (model preset, prompt preset, persona). */
    const values = () =>
        ["modelPresetId", "promptPresetId", "personaId"].map((field) => row(field).querySelector(".grow")?.textContent);
    const confirmButton = () =>
        [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === strings.confirmReview);
    return { target, row, values, confirmButton };
}

function renderDialog(chatRef: { chaId: string; chatId: string }) {
    const close = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ChatBindingDialog, { target, props: { chatRef, close } }));
    flushSync();
    return { target, close };
}

/** Chat `k` binds `m1`, `p1`, `u1`; chat `j` binds a gone model preset and `p1`, with a review pending. */
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
                chats: [
                    chat("k", { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" }),
                    chat("j", { modelPresetId: "m-gone", promptPresetId: "p1", bindingReview: true }),
                ],
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
    openPresetList.set(false);
    openModelPresetList.set(false);
    openPersonaList.set(false);
    chatBindingDialog.set(null);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("ChatBindingPanel", () => {
    it("shows the bound records by name, or not set / deleted, and follows a patch, a deletion, a return, and a rename", () => {
        const panel = renderPanel(refK);
        expect(panel.values()).toEqual(["Model One", "Prompt One", "Ann"]);
        expect(panel.confirmButton()).toBeUndefined();

        chatBindingPatch(refK, { promptPresetId: "p2", personaId: null });
        flushSync();
        expect(panel.values()).toEqual(["Model One", "Prompt Two", strings.unset]);

        settings.modelPresets.splice(0, 1);
        flushSync();
        expect(panel.values()).toEqual([strings.gone, "Prompt Two", strings.unset]);
        settings.modelPresets.push(
            normalizeModelPreset({ name: "Model One again", mainSlot: { profileId: "gpt" } }, { id: "m1" }),
        );
        flushSync();
        expect(panel.values()).toEqual(["Model One again", "Prompt Two", strings.unset]);

        settings.presets[1].name = "Prompt Two renamed";
        flushSync();
        expect(panel.values()).toEqual(["Model One again", "Prompt Two renamed", strings.unset]);
    });

    it("shows the review note with a confirm button that clears the review; the gone and unset rows stay", () => {
        const panel = renderPanel(refJ);
        expect(panel.values()).toEqual([strings.gone, "Prompt One", strings.unset]);
        expect(panel.target.textContent).toContain(strings.review);
        panel.confirmButton()!.click();
        flushSync();
        expect(chatEntry(refJ)).not.toHaveProperty("bindingReview");
        expect(panel.target.textContent).not.toContain(strings.review);
        expect(panel.confirmButton()).toBeUndefined();
        expect(panel.values()).toEqual([strings.gone, "Prompt One", strings.unset]);

        chatBindingPatch(refJ, { review: true });
        flushSync();
        expect(panel.confirmButton()).toBeDefined();
    });

    it("shows the bound persona's note as written under the rows, and nothing when it is blank or the persona is unset or gone", () => {
        const panel = renderPanel(refK);
        const noteBlock = () => panel.target.querySelector("[data-chat-binding-persona-note]");
        expect(noteBlock()).toBeNull();

        settings.personas[0].note = "Fantasy runs\nsecond line";
        flushSync();
        expect(noteBlock()?.textContent?.trim()).toBe("Fantasy runs\nsecond line");

        settings.personas[0].note = "  \n ";
        flushSync();
        expect(noteBlock()).toBeNull();

        settings.personas[1].note = "Bob's memo";
        chatBindingPatch(refK, { personaId: "u2" });
        flushSync();
        expect(noteBlock()?.textContent?.trim()).toBe("Bob's memo");

        settings.personas.splice(1, 1);
        flushSync();
        expect(noteBlock()).toBeNull();
        chatBindingPatch(refK, { personaId: null });
        flushSync();
        expect(noteBlock()).toBeNull();
    });

    it("a row opens its picker for this chat", () => {
        const panel = renderPanel(refJ);
        panel.row("modelPresetId").click();
        expect(get(openModelPresetList)).toEqual({ chatRef: refJ });
        panel.row("promptPresetId").click();
        expect(get(openPresetList)).toEqual({ chatRef: refJ });
        panel.row("personaId").click();
        expect(get(openPersonaList)).toEqual({ chatRef: refJ });
        expect(get(chatBindingDialog)).toBeNull();
    });

    it("shows nothing for a chat that is gone, and a confirm clicked as the chat goes does not throw", () => {
        const panel = renderPanel(refJ);
        const confirm = panel.confirmButton()!;
        deleteChat(refJ);
        expect(() => confirm.click()).not.toThrow();
        flushSync();
        expect(panel.target.querySelector("[data-chat-binding-panel]")).toBeNull();
        expect(chatEntry(refJ)).toBeUndefined();
        expect(chatEntry(refK)).toMatchObject({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });

        const never = renderPanel({ chaId: "c", chatId: "nope" });
        expect(never.target.querySelector("[data-chat-binding-panel]")).toBeNull();
    });
});

describe("ChatBindingDialog", () => {
    it("names the chat, holds the panel, focuses its close button, and closes on the button", () => {
        const dialog = renderDialog(refK);
        expect(dialog.target.textContent).toContain("Chat K");
        expect(dialog.target.querySelector("[data-chat-binding-panel]")).not.toBeNull();
        const closeButton = dialog.target.querySelector<HTMLButtonElement>(`[aria-label="${strings.close}"]`)!;
        expect(document.activeElement).toBe(closeButton);
        expect(dialog.target.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("true");
        closeButton.click();
        expect(dialog.close).toHaveBeenCalledTimes(1);
    });

    it("closes itself when its chat stops being a member", () => {
        const dialog = renderDialog(refJ);
        expect(dialog.close).not.toHaveBeenCalled();
        deleteChat(refJ);
        flushSync();
        expect(dialog.close).toHaveBeenCalledTimes(1);
    });
});
