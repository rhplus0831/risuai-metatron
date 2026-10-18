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
vi.mock("src/ts/alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertConfirm: vi.fn(),
    alertInput: vi.fn(),
}));

import { language } from "src/lang";
import { alertConfirm, alertInput } from "src/ts/alert";
import type { TogglePreset } from "../../../shared/togglePresets.ts";
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

function render(chatRef: ChatRef | null = { chaId: "c", chatId: "k" }, presets = true) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    // The selected character's record, as `CharConfig.svelte` passes it (a writable wrapper).
    const chara = selectedCharacter()!;
    mounted.push(mount(Toggles, { target, props: { chara, chatRef, presets } }));
    flushSync();
    /** The checkbox of the label that carries `name`, or none. */
    const checkbox = (name: string) => {
        const label = [...target.querySelectorAll("label")].find((entry) => entry.textContent?.includes(name));
        return label?.querySelector<HTMLInputElement>("input[type=checkbox]") ?? null;
    };
    return { target, chara, checkbox };
}

beforeEach(() => {
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(false);
    vi.mocked(alertInput).mockReset().mockResolvedValue("");
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
        togglePresets: [],
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
    // The toggle selects only: the preset panel's own select (`data-toggle-preset-select`) comes first.
    const selects = [...target.querySelectorAll<HTMLSelectElement>("select:not([data-toggle-preset-select])")];
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

it("nests rows between keyless group and groupEnd lines and closes a named group at ==groupEnd", () => {
    activePreset.customPromptTemplateToggle = [
        "=Style=group",
        "inside=Inside",
        "==groupEnd",
        "==divider",
        "named=Named=group",
        "nested=Nested",
        "==groupEnd",
        "outside=Outside",
    ].join("\n");
    const { target, checkbox } = render();
    const groupButton = (name: string) =>
        [...target.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
    expect(groupButton("Style")).toBeDefined();
    expect(groupButton("Named")).toBeDefined();
    expect(target.querySelectorAll("hr")).toHaveLength(1);
    // Grouped rows stay hidden in their closed accordions; the row after the last groupEnd does not.
    expect(checkbox("Inside")).toBeNull();
    expect(checkbox("Nested")).toBeNull();
    expect(checkbox("Outside")).not.toBeNull();
    groupButton("Style")!.click();
    flushSync();
    expect(checkbox("Inside")).not.toBeNull();
    expect(checkbox("Nested")).toBeNull();
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
        change(target.querySelector<HTMLSelectElement>("select:not([data-toggle-preset-select])")!, "1");
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
            // The four toggle controls; the preset panel's select sits in the same disabled fieldset.
            expect(fieldset.querySelectorAll("input, select:not([data-toggle-preset-select]), textarea")).toHaveLength(
                4,
            );
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

describe("toggle preset panel", () => {
    const ref = { chaId: "c", chatId: "k" };
    const definitions = "flag=Flag\nmode=Mode=select=First,Second\ntitle=Title=text\nnotes=Notes=textarea";
    const defaults = { flag: "0", mode: "0", title: "", notes: "" };
    const kinds = { flag: "checkbox", mode: "select", title: "text", notes: "textarea" } as const;
    const legacy = { toggle_unrelated: "legacy must survive" };
    const saved = (id = "p", values = defaults): TogglePreset => ({
        id,
        name: `Preset ${id}`,
        values: { ...values },
        kinds: { ...kinds },
        createdAt: 1,
        updatedAt: 2,
    });
    const select = (target: HTMLElement) => target.querySelector<HTMLSelectElement>("[data-toggle-preset-select]")!;
    const button = (target: HTMLElement, action: "save" | "saveAsNew" | "rename" | "remove") =>
        target.querySelector<HTMLButtonElement>(`button[aria-label="${language.togglePresets[action]}"]`)!;
    const state = (target: HTMLElement) => target.querySelector("[data-toggle-preset-state]")?.textContent ?? null;
    const settle = async () => {
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
    };
    const choose = (target: HTMLElement, id: string) => {
        const input = select(target);
        input.value = id;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const unload = () =>
        assembleChats(
            [{ chaId: "c" }],
            [{ characterId: "c", id: "k", revision: "r1", name: "K", fmIndex: -1 }],
            [{ characterId: "c", revision: "o1", ids: ["k"] }],
        );
    function pending<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((done) => {
            resolve = done;
        });
        return { promise, resolve };
    }
    function observeWrites() {
        const chatWritten = vi.fn();
        const recordsWritten = vi.fn();
        setChatWorkListener(chatWritten);
        setRecordWriteListener(recordsWritten);
        return { chatWritten, recordsWritten };
    }

    beforeEach(() => {
        activePreset.customPromptTemplateToggle = definitions;
        settings.globalChatVariables = { ...legacy };
        settings.togglePresets = [saved(), saved("q")];
    });

    it("places the localized preset controls first in the chat fieldset only for enabled value-toggle panels", () => {
        activePreset.customPromptTemplateToggle = "help=Help=caption\nrule=Rule=divider";
        const { target } = render();
        expect(target.querySelector("[data-toggle-presets]")).toBeNull();
        activePreset.customPromptTemplateToggle = definitions;
        flushSync();
        const fieldset = target.querySelector("fieldset")!;
        expect(fieldset.firstElementChild).toBe(target.querySelector("[data-toggle-presets]"));
        expect(fieldset.firstElementChild!.textContent).toContain(language.togglePresets.title);
        expect(select(target).getAttribute("aria-label")).toBe(language.togglePresets.title);
        expect([...select(target).options].map(({ value, textContent }) => [value, textContent])).toEqual([
            ["", language.togglePresets.none],
            ["p", "Preset p"],
            ["q", "Preset q"],
        ]);
        for (const action of ["save", "saveAsNew"] as const)
            expect(button(target, action).title).toBe(language.togglePresets[action]);
        expect(button(target, "rename")).toBeNull();
        expect(button(target, "remove")).toBeNull();
        expect(state(target)).toBeNull();
        setChatMeta(ref, { togglePresetId: "p", GLGlobalVariables: { toggle_flag: "1" } });
        const preview = render(ref, false).target;
        expect(preview.querySelector("[data-toggle-presets]")).toBeNull();
        expect(preview.querySelector("[data-toggle-differs]")).toBeNull();
        expect(preview.querySelector("fieldset")!.querySelectorAll("input, select, textarea")).toHaveLength(4);
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(alertInput).not.toHaveBeenCalled();
    });

    it("shows edited, mismatch and deleted states and marks differing rows of all four kinds inside and outside groups", async () => {
        activePreset.customPromptTemplateToggle =
            definitions +
            "\ng=Group=group\ngflag=Group flag\ngmode=Group mode=select=First,Second\ngtitle=Group title=text\ngnotes=Group notes=textarea\ne=End=groupEnd";
        settings.togglePresets = [
            {
                ...saved(),
                values: { ...defaults, gflag: "0", gmode: "0", gtitle: "", gnotes: "" },
                kinds: { ...kinds, gflag: "checkbox", gmode: "select", gtitle: "text", gnotes: "textarea" },
            },
        ];
        setChatMeta(ref, { togglePresetId: "p" });
        const { target } = render();
        [...target.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Group")!.click();
        flushSync();
        expect(state(target)).toBeNull();
        expect(target.querySelectorAll("[data-toggle-differs]")).toHaveLength(0);
        for (const action of ["rename", "remove"] as const)
            expect(button(target, action).title).toBe(language.togglePresets[action]);
        setChatMeta(ref, {
            GLGlobalVariables: {
                toggle_flag: "1",
                toggle_mode: "1",
                toggle_title: "changed",
                toggle_notes: "changed",
                toggle_gflag: "1",
                toggle_gmode: "1",
                toggle_gtitle: "changed",
                toggle_gnotes: "changed",
            },
        });
        flushSync();
        expect(state(target)).toBe(language.togglePresets.edited);
        const markers = [...target.querySelectorAll<HTMLElement>("[data-toggle-differs]")];
        expect(markers.map((marker) => marker.parentElement!.textContent!.trim())).toEqual([
            "Flag",
            "Mode",
            "Title",
            "Notes",
            "Group flag",
            "Group mode",
            "Group title",
            "Group notes",
        ]);
        for (const marker of markers) {
            expect(marker.classList.contains("text-draculared")).toBe(true);
            expect(marker.title).toBe(language.togglePresets.differs);
        }
        setChatMeta(ref, { GLGlobalVariables: {} });
        settings.togglePresets[0].kinds.orphan = "text";
        flushSync();
        expect(state(target)).toBe(language.togglePresets.mismatch);
        expect(target.querySelectorAll("[data-toggle-differs]")).toHaveLength(0);
        delete settings.togglePresets[0].values.title;
        settings.togglePresets[0].kinds.flag = "text";
        flushSync();
        expect(
            [...target.querySelectorAll("[data-toggle-differs]")].map((marker) =>
                marker.parentElement!.textContent!.trim(),
            ),
        ).toEqual(["Flag", "Title"]);
        settings.togglePresets = [];
        flushSync();
        // Svelte's select option observer settles after the option list changes.
        await settle();
        expect(state(target)).toBe(language.togglePresets.deleted);
        expect(select(target).value).toBe("p");
        expect([...select(target).options].map(({ value, textContent }) => [value, textContent])).toEqual([
            ["", language.togglePresets.none],
            ["p", language.togglePresets.deleted],
        ]);
        expect(button(target, "rename")).toBeNull();
        expect(button(target, "remove")).toBeNull();
        setChatMeta(ref, {}, ["togglePresetId"]);
        flushSync();
        expect(state(target)).toBeNull();
        expect(target.querySelectorAll("[data-toggle-differs]")).toHaveLength(0);
    });

    it("saves a new named preset, confirms overwrite, and always asks a name for Save as new or a deleted link", async () => {
        const { target } = render();
        const { recordsWritten } = observeWrites();
        vi.mocked(alertInput).mockResolvedValueOnce("  Mine  ");
        button(target, "save").click();
        await settle();
        expect(alertInput).toHaveBeenCalledWith(language.togglePresets.namePrompt);
        expect(alertConfirm).not.toHaveBeenCalled();
        const firstId = findChat(ref)!.togglePresetId!;
        expect(settings.togglePresets[2]).toMatchObject({ id: firstId, name: "Mine", values: defaults, kinds });
        expect(select(target).value).toBe(firstId);
        setChatMeta(ref, { GLGlobalVariables: { toggle_title: "new title", toggle_keep: "keep" } });
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        button(target, "save").click();
        await settle();
        expect(alertConfirm).toHaveBeenCalledWith(language.togglePresets.overwriteConfirm("Mine"));
        expect(settings.togglePresets).toHaveLength(3);
        expect(settings.togglePresets[2].values).toEqual({ ...defaults, title: "new title" });
        expect(state(target)).toBeNull();
        vi.mocked(alertInput).mockResolvedValueOnce("Copy");
        button(target, "saveAsNew").click();
        await settle();
        expect(alertInput).toHaveBeenCalledTimes(2);
        expect(alertConfirm).toHaveBeenCalledTimes(1);
        expect(settings.togglePresets).toHaveLength(4);
        expect(findChat(ref)!.togglePresetId).toBe(settings.togglePresets[3].id);
        expect(findChat(ref)!.togglePresetId).not.toBe(firstId);
        setChatMeta(ref, { togglePresetId: "deleted" });
        flushSync();
        vi.mocked(alertInput).mockResolvedValueOnce("Replacement");
        button(target, "save").click();
        await settle();
        expect(alertInput).toHaveBeenCalledTimes(3);
        expect(settings.togglePresets[4].name).toBe("Replacement");
        expect(findChat(ref)!.togglePresetId).toBe(settings.togglePresets[4].id);
        expect(new Set(recordsWritten.mock.calls.map(([key]) => key))).toEqual(new Set(["togglePresets"]));
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("prefills Rename and confirms Delete by name, retaining the deleted link and chat values", async () => {
        setChatMeta(ref, { togglePresetId: "p", GLGlobalVariables: { toggle_title: "chat title" } });
        const { target } = render();
        const { chatWritten } = observeWrites();
        vi.mocked(alertInput).mockResolvedValueOnce("  Renamed  ");
        button(target, "rename").click();
        await settle();
        expect(alertInput).toHaveBeenCalledWith(language.togglePresets.namePrompt, [], "Preset p");
        expect(select(target).selectedOptions[0].textContent).toBe("Renamed");
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        button(target, "remove").click();
        await settle();
        expect(alertConfirm).toHaveBeenCalledWith(language.removeConfirm + "Renamed");
        expect(settings.togglePresets).toEqual([saved("q")]);
        expect(findChat(ref)).toMatchObject({ togglePresetId: "p", GLGlobalVariables: { toggle_title: "chat title" } });
        expect(select(target).value).toBe("p");
        expect(state(target)).toBe(language.togglePresets.deleted);
        expect(chatWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("cancelled and blank save or rename dialogs and cancelled overwrite or delete make no writes", async () => {
        setChatMeta(ref, { togglePresetId: "p" });
        const { target } = render();
        const { chatWritten, recordsWritten } = observeWrites();
        for (const action of ["save", "remove", "saveAsNew", "rename"] as const) {
            button(target, action).click();
            await settle();
        }
        for (const action of ["saveAsNew", "rename"] as const) {
            vi.mocked(alertInput).mockResolvedValueOnce(" \n ");
            button(target, action).click();
            await settle();
        }
        expect(alertConfirm).toHaveBeenCalledTimes(2);
        expect(alertInput).toHaveBeenCalledTimes(4);
        expect(settings.togglePresets).toEqual([saved(), saved("q")]);
        expect(select(target).value).toBe("p");
        expect(findChat(ref)!.GLGlobalVariables).toBeUndefined();
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
    });

    it("restores a cancelled choice, applies an accepted choice and unlinks None without changing values", async () => {
        settings.togglePresets[1].values = { flag: "1", mode: "1", title: "from q", notes: "notes" };
        setChatMeta(ref, { togglePresetId: "p", GLGlobalVariables: { toggle_keep: "keep" } });
        const { target } = render();
        const { chatWritten, recordsWritten } = observeWrites();
        choose(target, "q");
        await settle();
        expect(alertConfirm).toHaveBeenCalledWith(language.togglePresets.applyConfirm("Preset q"));
        expect(select(target).value).toBe("p");
        expect(findChat(ref)).toMatchObject({ togglePresetId: "p", GLGlobalVariables: { toggle_keep: "keep" } });
        expect(chatWritten).not.toHaveBeenCalled();
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        choose(target, "q");
        await settle();
        const applied = {
            toggle_keep: "keep",
            toggle_flag: "1",
            toggle_mode: "1",
            toggle_title: "from q",
            toggle_notes: "notes",
        };
        expect(findChat(ref)).toMatchObject({ togglePresetId: "q", GLGlobalVariables: applied });
        expect(select(target).value).toBe("q");
        expect(state(target)).toBeNull();
        choose(target, "");
        await settle();
        expect(Object.hasOwn(findChat(ref)!, "togglePresetId")).toBe(false);
        expect(findChat(ref)!.GLGlobalVariables).toEqual(applied);
        expect(select(target).value).toBe("");
        expect(state(target)).toBeNull();
        expect(alertConfirm).toHaveBeenCalledTimes(2);
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("applies equal resolved defaults without confirmation even when the preset has missing values and stale keys", async () => {
        settings.togglePresets = [{ ...saved(), values: { stale: "ignore" }, kinds: {} }];
        const { target } = render();
        choose(target, "p");
        await settle();
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(findChat(ref)).toMatchObject({
            togglePresetId: "p",
            GLGlobalVariables: {
                toggle_flag: "0",
                toggle_mode: "0",
                toggle_title: "",
                toggle_notes: "",
            },
        });
        expect(select(target).value).toBe("p");
        expect(state(target)).toBe(language.togglePresets.mismatch);
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("guards every handler when the chat unloads before an event, without relying on fieldset disabling", async () => {
        setChatMeta(ref, { togglePresetId: "p" });
        const { target } = render();
        const buttons = ["save", "saveAsNew", "rename", "remove"].map(
            (action: "save" | "saveAsNew" | "rename" | "remove") => button(target, action),
        );
        const { chatWritten, recordsWritten } = observeWrites();
        unload();
        expect(findChat(ref)).toBeUndefined();
        // Intentionally dispatch before Svelte flushes; happy-dom also permits these
        // clicks under a disabled fieldset, so only the handlers can refuse them.
        for (const control of buttons) control.click();
        choose(target, "q");
        await settle();
        expect(alertInput).not.toHaveBeenCalled();
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(settings.togglePresets).toEqual([saved(), saved("q")]);
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it("restores the previous selection and writes nothing if its chat unloads during apply confirmation", async () => {
        settings.togglePresets[1].values.title = "different";
        setChatMeta(ref, { togglePresetId: "p" });
        const { target } = render();
        const dialog = pending<boolean>();
        vi.mocked(alertConfirm).mockReturnValueOnce(dialog.promise);
        choose(target, "q");
        expect(alertConfirm).toHaveBeenCalledWith(language.togglePresets.applyConfirm("Preset q"));
        unload();
        await settle();
        const { chatWritten, recordsWritten } = observeWrites();
        dialog.resolve(true);
        await settle();
        expect(select(target).value).toBe("p");
        expect(findChat(ref)).toBeUndefined();
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
        expect(settings.globalChatVariables).toEqual(legacy);
    });

    it.each(["save", "saveAsNew", "rename", "remove"] as const)(
        "refuses %s after the chat unloads during its dialog",
        async (action) => {
            setChatMeta(ref, { togglePresetId: "p" });
            const { target } = render();
            const confirm = pending<boolean>();
            const input = pending<string>();
            vi.mocked(alertConfirm).mockReturnValueOnce(confirm.promise);
            vi.mocked(alertInput).mockReturnValueOnce(input.promise);
            button(target, action).click();
            expect(vi.mocked(alertConfirm).mock.calls.length + vi.mocked(alertInput).mock.calls.length).toBe(1);
            unload();
            const { chatWritten, recordsWritten } = observeWrites();
            confirm.resolve(true);
            input.resolve("New name");
            await settle();
            expect(settings.togglePresets).toEqual([saved(), saved("q")]);
            expect(findChat(ref)).toBeUndefined();
            expect(chatWritten).not.toHaveBeenCalled();
            expect(recordsWritten).not.toHaveBeenCalled();
        },
    );

    it.each(["save", "rename", "remove"] as const)(
        "%s keeps the captured id when the link and preset objects change during the dialog",
        async (action) => {
            setChatMeta(ref, { togglePresetId: "p", GLGlobalVariables: { toggle_title: "capture me" } });
            const { target } = render();
            const confirm = pending<boolean>();
            const input = pending<string>();
            vi.mocked(alertConfirm).mockReturnValueOnce(confirm.promise);
            vi.mocked(alertInput).mockReturnValueOnce(input.promise);
            button(target, action).click();
            if (action === "save")
                expect(alertConfirm).toHaveBeenCalledWith(language.togglePresets.overwriteConfirm("Preset p"));
            if (action === "remove") expect(alertConfirm).toHaveBeenCalledWith(language.removeConfirm + "Preset p");
            if (action === "rename")
                expect(alertInput).toHaveBeenCalledWith(language.togglePresets.namePrompt, [], "Preset p");
            // A fresh collection in a different order and another linked preset must
            // not redirect the outstanding dialog to q or mutate a detached p object.
            settings.togglePresets = [saved("q"), { ...saved(), name: "Remote name" }];
            setChatMeta(ref, { togglePresetId: "q" });
            flushSync();
            confirm.resolve(true);
            input.resolve("Renamed p");
            await settle();
            expect(settings.togglePresets[0]).toEqual(saved("q"));
            if (action === "save") {
                expect(settings.togglePresets[1]).toMatchObject({
                    id: "p",
                    name: "Remote name",
                    values: { ...defaults, title: "capture me" },
                });
                expect(findChat(ref)!.togglePresetId).toBe("p");
            } else if (action === "rename") {
                expect(settings.togglePresets[1]).toMatchObject({ id: "p", name: "Renamed p", values: defaults });
                expect(findChat(ref)!.togglePresetId).toBe("q");
            } else {
                expect(settings.togglePresets).toEqual([saved("q")]);
                expect(findChat(ref)!.togglePresetId).toBe("q");
            }
            expect(settings.globalChatVariables).toEqual(legacy);
        },
    );

    it("re-finds an apply target after confirmation and restores the old selection if that preset was deleted", async () => {
        settings.togglePresets[1].values.title = "before dialog";
        setChatMeta(ref, { togglePresetId: "p" });
        const { target } = render();
        const first = pending<boolean>();
        vi.mocked(alertConfirm).mockReturnValueOnce(first.promise);
        choose(target, "q");
        settings.togglePresets = [saved("q", { ...defaults, title: "after dialog" }), saved()];
        first.resolve(true);
        await settle();
        expect(findChat(ref)).toMatchObject({
            togglePresetId: "q",
            GLGlobalVariables: { toggle_title: "after dialog" },
        });
        const second = pending<boolean>();
        vi.mocked(alertConfirm).mockReturnValueOnce(second.promise);
        choose(target, "p");
        settings.togglePresets = [settings.togglePresets[0]];
        flushSync();
        const { chatWritten, recordsWritten } = observeWrites();
        second.resolve(true);
        await settle();
        expect(select(target).value).toBe("q");
        expect(findChat(ref)!.togglePresetId).toBe("q");
        expect(chatWritten).not.toHaveBeenCalled();
        expect(recordsWritten).not.toHaveBeenCalled();
    });
});
