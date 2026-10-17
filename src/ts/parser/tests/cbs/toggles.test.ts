import { beforeEach, expect, it, vi } from "vitest";

vi.mock(import("../../../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    return {
        CurrentTriggerIdStore: writable(null),
        CharEmotion: writable({}),
    } as unknown as typeof import("../../../stores.svelte");
});
vi.mock(
    import("../../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
            defaultSdDataFunc: () => [],
        }) as unknown as typeof import("../../../storage/database.svelte"),
);
vi.mock(import("../../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

import { getGlobalChatVar, getGlobalChatVarOf } from "../../chatVar.svelte";
import { risuChatParser, risuChatParserScoped } from "../../parser.svelte";
import { selectChat } from "../../../storage/chatStore.svelte";
import { selectCharacter, selectPreset } from "../../../storage/selection.svelte";
import { installFlatDatabaseWithChats } from "../../../storage/tests/installFlatDatabase";

const ref = { chaId: "owner", chatId: "chat" };
const captured = { presetId: "captured", modelPresetId: "selected", personaId: "persona" };

beforeEach(() => {
    installFlatDatabaseWithChats({
        botPresets: [
            {
                id: "selected",
                name: "Selected",
                customPromptTemplateToggle:
                    "preset=Preset=textarea\ncollision=Preset first=text\nscoped=Selected checkbox",
            },
            {
                id: "captured",
                name: "Captured",
                customPromptTemplateToggle: "scoped=Captured text=text\nscope_only=Captured checkbox",
                moduleIntergration: "scoped-module",
            },
        ],
        personas: [{ id: "persona", name: "User", personaPrompt: "" }],
        globalChatVariables: { toggle_scoped: "7", toggle_owner: "legacy" },
        enabledModules: ["enabled"],
        modules: [
            {
                id: "enabled",
                name: "Enabled",
                customModuleToggle:
                    "module=Module=select=First,Second\ncollision=Module checkbox\nmodule_first=Module first=textarea",
            },
            { id: "chat-module", name: "Chat module", customModuleToggle: "chat_module=Chat module" },
            { id: "scoped-module", name: "Scoped module", customModuleToggle: "scope_module=Scope module=text" },
            { id: "disabled", name: "Disabled", customModuleToggle: "disabled=Disabled" },
        ],
        characters: [
            {
                chaId: "owner",
                type: "character",
                name: "Owner",
                customModuleToggle: "owner=Owner=text\nmodule_first=Owner checkbox\ncollision=Owner checkbox",
                chats: [
                    {
                        id: "chat",
                        message: [],
                        modules: ["chat-module"],
                        GLGlobalVariables: { toggle_scoped: "", toggle_owner: "" },
                    },
                ],
            },
            {
                chaId: "other",
                type: "character",
                name: "Other",
                customModuleToggle: "other=Other=textarea",
                chats: [{ id: "other-chat", message: [] }],
            },
        ],
    });
    selectPreset("selected");
    selectCharacter("owner");
    selectChat("owner", "chat");
});

it("reads preset, enabled module, and chat owner defaults through selected and explicit chat accessors", () => {
    const keys = ["preset", "module", "chat_module", "owner", "collision", "module_first", "disabled", "other"];
    for (const read of [getGlobalChatVar, (key: string) => getGlobalChatVarOf(ref, key)]) {
        expect(keys.map((key) => read(`toggle_${key}`))).toEqual(["", "0", "0", "", "", "", "null", "null"]);
    }
    const other = { chaId: "other", chatId: "other-chat" };
    expect(getGlobalChatVarOf(other, "toggle_other")).toBe("");
    expect(getGlobalChatVarOf(other, "toggle_chat_module")).toBe("null");
    expect(
        risuChatParser(
            "[{{getglobalvar::toggle_module}}|{{getglobalvar::toggle_owner}}|{{getglobalvar::toggle_collision}}]",
            { chatRef: ref },
        ),
    ).toBe("[0||]");
});

it("uses the captured preset and its modules for scoped reads, conditions, and calculator", () => {
    // Empty chat text wins over legacy 7 in the captured preset; the selected checkbox falls back to 7.
    expect(getGlobalChatVar("toggle_scoped")).toBe("7");
    expect(getGlobalChatVar("toggle_scoped", captured)).toBe("");
    expect(getGlobalChatVarOf(ref, "toggle_scope_only", captured)).toBe("0");
    const input =
        "[{{getglobalvar::toggle_scoped}}|{{getglobalvar::toggle_scope_only}}|{{getglobalvar::toggle_scope_module}}] {{#when::toggle::scoped}}ON{{:else}}OFF{{/when}} {{#when::scope_only::tis::0}}FIRST{{:else}}WRONG{{/when}} {{#when::scope_only::tisnot::0}}WRONG{{:else}}ZERO{{/when}} {{? @toggle_scoped + 1}}";
    for (const arg of [{}, { chatRef: ref }]) {
        expect(risuChatParserScoped(input, arg, captured)).toBe("[|0|] OFF FIRST ZERO 1");
    }
    expect(risuChatParser("{{? @toggle_scoped + 1}}")).toBe("8");
});
