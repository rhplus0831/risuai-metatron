// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `botpreset.svelte` lists either preset kind. The model list selects, adds, copies, and removes
// model presets (a copy keeps its profile references; the model preset holds no key) and never
// touches the prompt presets; the prompt-only actions (export, import, comparison, the Ctrl+1..9
// numbers) stay on the prompt list.

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    error: vi.fn(),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: mocks.confirm,
        alertError: mocks.error,
    }),
);
// Reached through `stores.svelte.ts` and the preset functions' import path; nothing under test needs them.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn(), globalFetch: vi.fn() }));

import { MODEL_PRESET_DEFAULT_NAME, normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { settings, activePreset, activeModelPreset, activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { selectCharacter, selection, selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { chatBinding, chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { chatEntry, deleteChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { language } from "src/lang";
import Botpreset from "./botpreset.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(kind: "prompt" | "model") {
    const close = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(Botpreset, { target, props: { kind, close } }));
    flushSync();
    const rows = () => [...target.querySelectorAll<HTMLButtonElement>("button[draggable]")];
    const rowNamed = (name: string) => {
        const row = rows().find((entry) => entry.textContent?.includes(name));
        expect(row, `Expected a row named ${name}`).toBeDefined();
        return row!;
    };
    const icon = (root: Element, name: string) => root.querySelector<HTMLElement>(`.lucide-${name}`)?.parentElement;
    return { target, close, rows, rowNamed, icon };
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        useLegacyGUI: false,
        showPromptComparison: true,
        botPresets: [
            { id: "p1", name: "Prompt One", temperature: 80 },
            { id: "p2", name: "Prompt Two", temperature: 50 },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" }),
            normalizeModelPreset({ name: "Model Two", mainSlot: { profileId: "claude" } }, { id: "m2" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o" }),
            normalizeModelProfile({ id: "claude", name: "Claude", modelId: "claude" }),
        ],
    } as any);
    selectPreset("p1");
    selectModelPreset("m1");
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("the model preset list", () => {
    it("lists the model presets with the selected one marked, without the prompt-only actions", () => {
        const list = render("model");
        expect(list.rows().map((row) => row.textContent?.trim())).toEqual(["Model One", "Model Two"]);
        expect(list.rowNamed("Model One").classList.contains("bg-selected")).toBe(true);
        expect(list.target.querySelector("h2")?.textContent).toBe("Model Presets");
        for (const prompt of ["share-2", "hard-drive-upload", "git-compare"]) {
            expect(list.target.querySelector(`.lucide-${prompt}`), prompt).toBeNull();
        }
    });

    it("selects a model preset on click and leaves the prompt preset selected", () => {
        const list = render("model");
        list.rowNamed("Model Two").click();
        flushSync();
        expect(activeModelPreset.id).toBe("m2");
        expect(activeMainProfile.modelId).toBe("claude");
        expect(activePreset.id).toBe("p1");
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("adds a default model preset, and copies one with its profile references", () => {
        const list = render("model");
        list.icon(list.target, "plus")!.click();
        flushSync();
        expect(settings.modelPresets.map((preset) => preset.name)).toEqual([
            "Model One",
            "Model Two",
            MODEL_PRESET_DEFAULT_NAME,
        ]);

        list.icon(list.rowNamed("Model Two"), "copy")!.click();
        flushSync();
        const copy = settings.modelPresets[3];
        expect(copy.name).toBe("Model Two Copy");
        expect(copy.mainSlot).toEqual({ profileId: "claude" });
        expect(settings.modelProfiles).toHaveLength(2);
        expect(settings.presets).toHaveLength(2);
        expect(list.close).not.toHaveBeenCalled();
    });

    it("removes a model preset after the dialog, reselecting, but never the last one", async () => {
        const list = render("model");
        mocks.confirm.mockResolvedValueOnce(true);
        list.icon(list.rowNamed("Model One"), "trash")!.click();
        await settle();
        flushSync();
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["m2"]);
        expect(activeModelPreset.id).toBe("m2");
        expect(settings.presets).toHaveLength(2);

        list.icon(list.rowNamed("Model Two"), "trash")!.click();
        await settle();
        expect(mocks.error).toHaveBeenCalledTimes(1);
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["m2"]);
    });

    it("renames a model preset in edit mode", () => {
        const list = render("model");
        list.icon(list.target, "pencil")!.click();
        flushSync();
        const input = list.target.querySelector<HTMLInputElement>("input")!;
        input.value = "Renamed";
        input.dispatchEvent(new Event("input"));
        flushSync();
        expect(settings.modelPresets[0].name).toBe("Renamed");
        expect(settings.presets[0].name).toBe("Prompt One");
    });
});

describe("the prompt preset list", () => {
    it("keeps the prompt actions and selects only the prompt preset", () => {
        const list = render("prompt");
        expect(list.target.querySelector("h2")?.textContent).toBe("Prompt Presets");
        expect(list.rows().map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
            "1 Prompt One",
            "2 Prompt Two",
        ]);
        for (const prompt of ["share-2", "hard-drive-upload", "git-compare"]) {
            expect(list.target.querySelector(`.lucide-${prompt}`), prompt).not.toBeNull();
        }
        list.rowNamed("Prompt Two").click();
        flushSync();
        expect(activePreset.id).toBe("p2");
        expect(activeModelPreset.id).toBe("m1");
    });
});

// The list picks for the chat the screen shows. With an open chat a pick binds that chat (the tab's
// selection stays), the highlight is the chat's bound record that exists (none when unset or gone,
// never the view's tab fallback), and the list names the chat. A list opened for a given chat
// (`chatRef`) picks for that chat, selected or not, and closes when it is gone. A deletion names
// how many chats bind the record, leaves those chats as they are, and moves the tab's selection
// only when it named the record. At home everything is the tab's, as before.
describe("the lists with a chat open", () => {
    const chat = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
        ...fields,
    });
    const refK = { chaId: "c", chatId: "k" };
    const refJ = { chaId: "c", chatId: "j" };

    /** The tab selects `p1`/`m1`; chat `k` binds `p2`/`m2`, chat `j` binds nothing; `k` is open. */
    beforeEach(() => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [chat("k", { modelPresetId: "m2", promptPresetId: "p2" }), chat("j")],
                },
            ],
            useLegacyGUI: false,
            showPromptComparison: true,
            botPresets: [
                { id: "p1", name: "Prompt One", temperature: 80 },
                { id: "p2", name: "Prompt Two", temperature: 50 },
                { id: "p3", name: "Prompt Three", temperature: 30 },
            ],
            modelPresets: [
                normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" }),
                normalizeModelPreset({ name: "Model Two", mainSlot: { profileId: "claude" } }, { id: "m2" }),
                normalizeModelPreset({ name: "Model Three", mainSlot: { profileId: "gpt" } }, { id: "m3" }),
            ],
            modelProfiles: [
                normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o" }),
                normalizeModelProfile({ id: "claude", name: "Claude", modelId: "claude" }),
            ],
        } as any);
        selectPreset("p1");
        selectModelPreset("m1");
        selectCharacter("c");
        selectChat("c", "k");
    });

    afterEach(() => {
        selectCharacter(null);
    });

    function renderFor(kind: "prompt" | "model", chatRef?: { chaId: string; chatId: string }) {
        const close = vi.fn();
        const target = document.createElement("div");
        document.body.appendChild(target);
        mounted.push(mount(Botpreset, { target, props: { kind, close, chatRef } }));
        flushSync();
        const rows = () => [...target.querySelectorAll<HTMLButtonElement>("button[draggable]")];
        const rowNamed = (name: string) => rows().find((entry) => entry.textContent?.includes(name))!;
        const selectedNames = () =>
            rows()
                .filter((row) => row.classList.contains("bg-selected"))
                .map((row) => row.textContent?.replace(/\s+/g, " ").trim());
        const icon = (root: Element, name: string) => root.querySelector<HTMLElement>(`.lucide-${name}`)?.parentElement;
        return { target, close, rows, rowNamed, selectedNames, icon };
    }

    it("marks the open chat's bound preset, names the chat, and a pick binds the chat, not the tab", () => {
        const prompt = renderFor("prompt");
        expect(prompt.target.textContent).toContain(language.chatBinding.forChat("K"));
        // The view shows the chat's `p2` too, but the highlight is the binding's, not the view's.
        expect(activePreset.id).toBe("p2");
        expect(prompt.selectedNames()).toEqual(["2 Prompt Two"]);

        prompt.rowNamed("Prompt Three").click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p3", modelPresetId: "m2" });
        expect(selection.presetId).toBe("p1");
        expect(activePreset.id).toBe("p3");
        expect(prompt.close).toHaveBeenCalledTimes(1);

        const model = renderFor("model");
        expect(model.selectedNames()).toEqual(["Model Two"]);
        model.rowNamed("Model Three").click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p3", modelPresetId: "m3" });
        expect(selection.modelPresetId).toBe("m1");
        expect(chatEntry(refJ)).not.toHaveProperty("promptPresetId");
    });

    it("marks nothing for an unset or gone binding although the view falls back to the tab's preset", () => {
        selectChat("c", "j");
        const prompt = renderFor("prompt");
        expect(activePreset.id).toBe("p1");
        expect(prompt.selectedNames()).toEqual([]);
        expect(prompt.target.textContent).toContain(language.chatBinding.forChat("J"));

        chatBindingPatch(refJ, { promptPresetId: "p-gone" });
        flushSync();
        expect(prompt.selectedNames()).toEqual([]);
        chatBindingPatch(refJ, { promptPresetId: "p2" });
        flushSync();
        expect(prompt.selectedNames()).toEqual(["2 Prompt Two"]);
    });

    it("a list opened for a chat picks for that chat, not the open one, and closes when that chat is gone", () => {
        const prompt = renderFor("prompt", refJ);
        expect(prompt.target.textContent).toContain(language.chatBinding.forChat("J"));
        expect(prompt.selectedNames()).toEqual([]);
        prompt.rowNamed("Prompt Two").click();
        flushSync();
        expect(chatEntry(refJ)).toMatchObject({ promptPresetId: "p2" });
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p2", modelPresetId: "m2" });
        expect(selection.presetId).toBe("p1");
        expect(prompt.close).toHaveBeenCalledTimes(1);

        const model = renderFor("model", refJ);
        deleteChat(refJ);
        flushSync();
        expect(model.close).toHaveBeenCalledTimes(1);
        expect(selection.modelPresetId).toBe("m1");
    });

    it("at home the list marks and picks the tab's selection and names no chat", () => {
        selectCharacter(null);
        const prompt = renderFor("prompt");
        expect(prompt.target.textContent).not.toContain("For this chat");
        expect(prompt.selectedNames()).toEqual(["1 Prompt One"]);
        prompt.rowNamed("Prompt Three").click();
        flushSync();
        expect(selection.presetId).toBe("p3");
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p2" });
    });

    it("deleting a prompt preset names the chats bound to it, leaves them bound, and moves only a tab selection that named it", async () => {
        selectPreset("p3");
        const prompt = renderFor("prompt");
        mocks.confirm.mockResolvedValueOnce(true);
        prompt.icon(prompt.rowNamed("Prompt Two"), "trash")!.click();
        await settle();
        flushSync();
        expect(mocks.confirm).toHaveBeenLastCalledWith(
            `${language.removeConfirm}Prompt Two\n\n${language.chatBinding.usedByChats(1)}`,
        );
        expect(settings.presets.map((preset) => preset.id)).toEqual(["p1", "p3"]);
        // The chat keeps the id (shown as deleted); the tab's `p3` was not the deleted one and stays.
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p2" });
        expect(chatBinding(refK)).toMatchObject({ ok: false });
        expect((chatBinding(refK) as { problems: unknown[] }).problems).toContainEqual({
            field: "promptPresetId",
            reason: "gone",
        });
        expect(selection.presetId).toBe("p3");

        // The tab's own preset deleted: the selection moves to the first remaining one, the chat is untouched.
        mocks.confirm.mockResolvedValueOnce(true);
        prompt.icon(prompt.rowNamed("Prompt Three"), "trash")!.click();
        await settle();
        flushSync();
        expect(mocks.confirm).toHaveBeenLastCalledWith(`${language.removeConfirm}Prompt Three`);
        expect(settings.presets.map((preset) => preset.id)).toEqual(["p1"]);
        expect(selection.presetId).toBe("p1");
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p2" });
    });

    it("deleting a model preset names the chats bound to it and leaves them bound", async () => {
        const model = renderFor("model");
        mocks.confirm.mockResolvedValueOnce(true);
        model.icon(model.rowNamed("Model Two"), "trash")!.click();
        await settle();
        flushSync();
        expect(mocks.confirm).toHaveBeenLastCalledWith(
            `${language.removeConfirm}Model Two\n\n${language.chatBinding.usedByChats(1)}`,
        );
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["m1", "m3"]);
        expect(chatEntry(refK)).toMatchObject({ modelPresetId: "m2" });
        expect(selection.modelPresetId).toBe("m1");
    });
});
