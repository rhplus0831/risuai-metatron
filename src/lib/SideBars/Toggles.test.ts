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
import { setChatMeta } from "src/ts/storage/chatStore.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import Toggles from "./Toggles.svelte";

const mounted: ReturnType<typeof mount>[] = [];

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    // The selected character's record, as `CharConfig.svelte` passes it (a writable wrapper).
    const chara = selectedCharacter()!;
    mounted.push(mount(Toggles, { target, props: { chara, noContainer: true } }));
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
    for (const component of mounted.splice(0)) {
        unmount(component);
    }
    document.body.innerHTML = "";
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
