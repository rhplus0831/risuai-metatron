// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's memory toggle (`Toggles.svelte`; `docs/structure/memory.md`, "Every core-app path
// that turns `supaMemory` on bumps `supaMemoryOnCount`"): the checkbox writes the character's
// `supaMemory` through a function binding that counts each off→on transition and nothing else, and
// the toggle is shown for a HypaV2-only configuration too.

vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleToggles: vi.fn(() => ""),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertNormal: vi.fn() }));

import { language } from "src/lang";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { activePreset, settings } from "src/ts/storage/settingsViews.svelte";
import { getModuleToggles } from "src/ts/process/modules";
import {
    assembleChats,
    findChat,
    selectChat,
    setChatMeta,
    setChatWorkListener,
    type ChatRef,
} from "src/ts/storage/chatStore.svelte";
import { setRecordWriteListener } from "src/ts/storage/records.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import Toggles from "./Toggles.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render(chatRef: ChatRef | null = { chaId: "c", chatId: "k" }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    // The selected character's record, as `CharConfig.svelte` passes it (a writable wrapper).
    const chara = selectedCharacter()!;
    mounted.push(mount(Toggles, { target, props: { chara, chatRef } }));
    flushSync();
    /** The checkbox of the label that carries `name`, or none. */
    const checkbox = (name: string) => {
        const label = [...target.querySelectorAll("label")].find((entry) => entry.textContent?.includes(name));
        return label?.querySelector<HTMLInputElement>("input[type=checkbox]") ?? null;
    };
    return { target, chara, checkbox };
}

beforeEach(() => {
    vi.mocked(getModuleToggles).mockReturnValue("");
    sessionStorage.clear();
    localStorage.clear();
    installFlatDatabaseWithChats({
        botPresets: [{ id: "toggles", name: "Toggles", customPromptTemplateToggle: "" }],
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "Hello",
                chatPage: 0,
                chats: [{ id: "k", name: "K", note: "", localLore: [], message: [] }],
            },
        ],
        supaModelType: "subModel",
        hypaMemory: false,
        hypav2: false,
        hypaV3: false,
        hanuraiEnable: false,
        jailbreakToggle: false,
    } as any);
    selectCharacter("c");
});

it("renders unset selects at option zero and empty text controls from preset, module, and owner definitions", () => {
    activePreset.customPromptTemplateToggle = "mode=Mode=select=First,Second\ntitle=Title=text\nflag=Flag";
    vi.mocked(getModuleToggles).mockReturnValue("module_mode=Module mode=select=Module first,Module second");
    Object.assign(selectedCharacter()!, {
        customModuleToggle: "owner_mode=Owner mode=select=Owner first,Owner second\nnotes=Notes=textarea",
    });
    const { target, checkbox } = render();
    const selects = [...target.querySelectorAll("select")];
    expect(selects.map((select) => [select.value, select.selectedOptions[0]?.textContent])).toEqual([
        ["0", "First"],
        ["0", "Module first"],
        ["0", "Owner first"],
    ]);
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(checkbox("Flag")!.checked).toBe(false);

    settings.globalChatVariables = { toggle_title: "legacy title", toggle_notes: "legacy notes", toggle_mode: "1" };
    setChatMeta({ chaId: "c", chatId: "k" }, { GLGlobalVariables: { toggle_title: "", toggle_notes: "" } });
    flushSync();
    expect(selects[0].value).toBe("1");
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
});

afterEach(() => {
    setChatWorkListener(null);
    setRecordWriteListener(null);
    for (const component of mounted.splice(0)) {
        unmount(component);
    }
    document.body.innerHTML = "";
});

describe("per-chat prompt toggles", () => {
    const ref = { chaId: "c", chatId: "k" };
    const definitions = "flag=Flag\nmode=Mode=select=First,Second\ntitle=Title=text\nnotes=Notes=textarea";
    const legacy = { toggle_flag: "0", toggle_mode: "0", toggle_title: "legacy", toggle_notes: "legacy notes" };
    const change = (input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    const unload = () =>
        assembleChats(
            [{ chaId: "c" }],
            [{ characterId: "c", id: "k", revision: "r1", name: "K", fmIndex: -1 }],
            [{ characterId: "c", revision: "o1", ids: ["k"] }],
        );

    it("checkbox, select, text, and textarea edits preserve other chat keys and never write legacy settings", () => {
        activePreset.customPromptTemplateToggle = definitions;
        settings.globalChatVariables = { ...legacy };
        setChatMeta(ref, { GLGlobalVariables: { toggle_keep: "keep me" } });
        const recordsWritten = vi.fn();
        setRecordWriteListener(recordsWritten);
        const { target, checkbox } = render();
        expect(target.querySelector("fieldset")!.disabled).toBe(false);
        expect(target.textContent).not.toContain("Local Toggles");
        expect(target.textContent).not.toContain("📌");

        checkbox("Flag")!.click();
        flushSync();
        expect(findChat(ref)!.GLGlobalVariables).toEqual({ toggle_keep: "keep me", toggle_flag: "1" });
        change(target.querySelector("select")!, "1");
        change(target.querySelector<HTMLInputElement>('input[type="text"]')!, "chat title");
        change(target.querySelector("textarea")!, "chat notes");
        expect(findChat(ref)!.GLGlobalVariables).toEqual({
            toggle_keep: "keep me",
            toggle_flag: "1",
            toggle_mode: "1",
            toggle_title: "chat title",
            toggle_notes: "chat notes",
        });
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("uses the supplied chat's preset, module, owner definitions and values while another chat is selected", () => {
        installFlatDatabaseWithChats({
            botPresets: [
                { id: "a", name: "A", customPromptTemplateToggle: "title=Title A=text\nflag=Flag A" },
                { id: "b", name: "B", customPromptTemplateToggle: "title=Title B=text\nflag=Flag B" },
            ],
            characters: [
                {
                    chaId: "a",
                    type: "character",
                    name: "A",
                    customModuleToggle: "owner=Owner A",
                    chats: [
                        {
                            id: "a-chat",
                            name: "A",
                            message: [],
                            promptPresetId: "a",
                            GLGlobalVariables: { toggle_title: "A title", toggle_flag: "1" },
                        },
                    ],
                },
                {
                    chaId: "b",
                    type: "character",
                    name: "B",
                    customModuleToggle: "owner=Owner B",
                    chats: [
                        {
                            id: "b-chat",
                            name: "B",
                            message: [],
                            promptPresetId: "b",
                            GLGlobalVariables: { toggle_title: "B title", toggle_flag: "0" },
                        },
                    ],
                },
            ],
        });
        selectCharacter("b");
        const aRef = { chaId: "a", chatId: "a-chat" };
        vi.mocked(getModuleToggles).mockImplementation((target) =>
            target?.chaId === "a" ? "module=Module A" : "module=Module B",
        );
        const { target, checkbox } = render(aRef);
        expect(target.textContent).toContain("Title A");
        expect(target.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("A title");
        expect(checkbox("Flag A")!.checked).toBe(true);
        expect(checkbox("Module A")).not.toBeNull();
        expect(checkbox("Owner A")).not.toBeNull();
        expect(target.textContent).not.toMatch(/Title B|Flag B|Module B|Owner B/);
        change(target.querySelector<HTMLInputElement>('input[type="text"]')!, "A edited");
        expect(findChat(aRef)!.GLGlobalVariables).toEqual({ toggle_title: "A edited", toggle_flag: "1" });
        expect(findChat({ chaId: "b", chatId: "b-chat" })!.GLGlobalVariables).toEqual({
            toggle_title: "B title",
            toggle_flag: "0",
        });
    });

    it.each(["unloaded", "null"] as const)(
        "disables per-chat inputs for a %s ref but keeps jailbreak and memory enabled",
        (state) => {
            activePreset.customPromptTemplateToggle = definitions;
            activePreset.jailbreak = "Jailbreak prompt";
            activePreset.promptTemplate = null;
            settings.ui.jailbreakToggle = false;
            settings.globalChatVariables = { ...legacy };
            setChatMeta(ref, { GLGlobalVariables: { toggle_title: "selected chat title" } });
            if (state === "unloaded") unload();
            const { target, chara, checkbox } = render(state === "null" ? null : ref);
            const fieldset = target.querySelector("fieldset")!;
            expect(fieldset.disabled).toBe(true);
            expect(fieldset.querySelectorAll("input, select, textarea")).toHaveLength(4);
            expect(target.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
                state === "null" ? "selected chat title" : "legacy",
            );
            const jailbreak = checkbox(language.jailbreakToggle)!;
            const memory = checkbox(language.ToggleSuperMemory)!;
            for (const input of [jailbreak, memory]) {
                expect(input.disabled).toBe(false);
                expect(input.closest("fieldset[disabled]")).toBeNull();
                input.click();
                flushSync();
            }
            expect(settings.ui.jailbreakToggle).toBe(true);
            expect(chara.supaMemory).toBe(true);
            expect(settings.globalChatVariables).toEqual(legacy);
        },
    );

    it("opening an existing chat and mounting the panel neither seeds defaults nor writes settings", () => {
        activePreset.customPromptTemplateToggle = definitions;
        settings.globalChatVariables = { ...legacy };
        const chatWritten = vi.fn();
        const recordsWritten = vi.fn();
        setChatWorkListener(chatWritten);
        setRecordWriteListener(recordsWritten);
        selectCharacter(null);
        selectChat("c", "k");
        selectCharacter("c");
        render();
        flushSync();
        expect(findChat(ref)!.GLGlobalVariables).toBeUndefined();
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("ignores an input event when its chat unloaded after render, before the disabled state flushed", () => {
        activePreset.customPromptTemplateToggle = "title=Title=text";
        settings.globalChatVariables = { ...legacy };
        const { target } = render();
        const input = target.querySelector<HTMLInputElement>('input[type="text"]')!;
        const chatWritten = vi.fn();
        const recordsWritten = vi.fn();
        setChatWorkListener(chatWritten);
        setRecordWriteListener(recordsWritten);
        unload();
        expect(findChat(ref)).toBeUndefined();
        change(input, "too late");
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
        expect(findChat(ref)).toBeUndefined();
        expect(target.querySelector("fieldset")!.disabled).toBe(true);
    });
});

describe("the memory toggle", () => {
    it("counts each off→on transition of supaMemory and nothing else", () => {
        const { chara, checkbox } = render();
        const input = checkbox(language.ToggleSuperMemory);
        expect(input, "the SupaMemory toggle is shown").not.toBeNull();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([undefined, undefined]);
        input!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([true, 1]);
        expect(input!.checked).toBe(true);
        // Off: no count. On again: the second transition.
        input!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([false, 1]);
        input!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([true, 2]);
    });

    it("keeps a stored count going and reads a malformed one as 0", () => {
        const { chara, checkbox } = render();
        chara.supaMemoryOnCount = 4;
        checkbox(language.ToggleSuperMemory)!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([true, 5]);
        chara.supaMemory = false;
        (chara as { supaMemoryOnCount?: unknown }).supaMemoryOnCount = "9";
        flushSync();
        checkbox(language.ToggleSuperMemory)!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([true, 1]);
    });

    it("is shown for a HypaV2-only configuration, under the Hypa label", () => {
        settings.memoryTranslateMedia.supaModelType = "none";
        const hidden = render();
        expect(hidden.checkbox(language.ToggleSuperMemory)).toBeNull();
        expect(hidden.checkbox(language.ToggleHypaMemory)).toBeNull();
        settings.memoryTranslateMedia.hypav2 = true;
        flushSync();
        const { chara, checkbox } = render();
        const input = checkbox(language.ToggleHypaMemory);
        expect(input).not.toBeNull();
        input!.click();
        flushSync();
        expect([chara.supaMemory, chara.supaMemoryOnCount]).toEqual([true, 1]);
    });
});
