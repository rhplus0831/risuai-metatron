import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `risuChatParserScoped` (`parser.svelte.ts`), the CBS parser for a frozen plugin call context. The
// preset fields come from the context's prompt or model preset, whichever owns the field, and the
// persona from the context's persona, whatever the tab selects afterwards; everything else is the
// tab's; a context preset, model preset, or persona that no longer exists fails the parse with
// `PluginTargetGoneError`. The plugin host's `parseRisuChat` inside a hook and the transport's `cbs`
// callback use it (`pluginContext.test.ts`, `transport.test.ts`).

vi.mock(import("../../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    return {
        CurrentTriggerIdStore: writable<string | null>(null),
        CharEmotion: writable({}),
    } as unknown as typeof import("../../stores.svelte");
});

vi.mock(import("../../storage/database.svelte"), () => {
    return {
        appVer: "1234.5.67",
        defaultSdDataFunc: () => [],
    } as unknown as typeof import("../../storage/database.svelte");
});

vi.mock(import("../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: vi.fn(() => Promise.resolve("")),
}));

import { ParseMarkdown, risuChatParser, risuChatParserScoped } from "../parser.svelte";
import { getChatVarOf, setChatVarOf } from "../chatVar.svelte";
import { getFileSrc } from "../../globalApi.svelte";
import { getUserIcon } from "../../util";
import { PluginTargetGoneError } from "../../plugins/apiV3/pluginContext";
import { characterList } from "../../storage/characterStore.svelte";
import { chatBindingPatch } from "../../storage/chatBinding.svelte";
import { selectChat } from "../../storage/chatStore.svelte";
import { selectCharacterAt, selectModelPreset, selectPersona, selectPreset } from "../../storage/selection.svelte";
import { readSettingsRoot, settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "../../storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";

/**
 * The tab's database, installed in the records (as the removed `setDatabaseLite` installed one;
 * there is no whole-database object): the parser reads the settings through the record views, the
 * selected character through the character store and its chat through the chat module, with the
 * presets and persona selected by id. The prompt presets `p-ctx`/`p-sel` carry the prompt fields;
 * the model presets of the same ids name main profiles whose model id and `maxContext` the parser
 * reads as the roots `aiModel` and `maxContext`.
 */
function database(selected: { preset: string; modelPreset?: string; persona: string }) {
    const raw = {
        botPresets: [
            {
                id: "p-ctx",
                name: "Context",
                templateDefaultVariables: "x=ctx",
                moduleIntergration: "mod-ctx",
                mainPrompt: "ctx main",
            },
            {
                id: "p-sel",
                name: "Selected",
                templateDefaultVariables: "x=sel",
                moduleIntergration: "mod-sel",
                mainPrompt: "sel main",
            },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Context", mainSlot: { profileId: "m-ctx" } }, { id: "p-ctx" }),
            normalizeModelPreset({ name: "Selected", mainSlot: { profileId: "m-sel" } }, { id: "p-sel" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "m-ctx", name: "Context", modelId: "ctx-model", maxContext: 1111 }),
            normalizeModelProfile({ id: "m-sel", name: "Selected", modelId: "sel-model", maxContext: 2222 }),
        ],
        personas: [
            { id: "u-ctx", name: "Ctx Persona", personaPrompt: "the context persona", icon: "icon-ctx" },
            { id: "u-sel", name: "Sel Persona", personaPrompt: "the selected persona", icon: "icon-sel" },
        ],
        // The modules the presets' integration lists name (`moduleIntergration`).
        modules: [
            { id: "mod-ctx", name: "Ctx module", namespace: "ns-ctx", lorebook: [] },
            { id: "mod-sel", name: "Sel module", namespace: "ns-sel", lorebook: [] },
        ],
        characters: [
            {
                chaId: "c",
                name: "Cara",
                image: "char-img",
                chatPage: 0,
                chats: [
                    { id: "k", message: [], scriptstate: {}, bindedPersona: "" },
                    { id: "j", message: [], scriptstate: {}, bindedPersona: "" },
                ],
                defaultVariables: "",
            },
        ],
        globalChatVariables: {},
    };
    installFlatDatabaseWithChats(raw);
    selectCharacterAt(0);
    selectChat("c", "k");
    selectPreset(selected.preset);
    selectModelPreset(selected.modelPreset ?? selected.preset);
    selectPersona(selected.persona);
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    database({ preset: "p-sel", persona: "u-sel" });
});
afterEach(() => {
    vi.restoreAllMocks();
});

const scope = { presetId: "p-ctx", modelPresetId: "p-ctx", personaId: "u-ctx" };
const input = "{{user}}|{{persona}}|{{model}}|{{maxcontext}}|{{char}}";

describe("risuChatParserScoped", () => {
    it("reads the context's preset fields and persona while the plain parser reads the selection", () => {
        expect(risuChatParser(input)).toBe("Sel Persona|the selected persona|sel-model|2222|Cara");
        expect(risuChatParserScoped(input, {}, scope)).toBe("Ctx Persona|the context persona|ctx-model|1111|Cara");
        // The same scope after the selection moved elsewhere: still the context's records.
        database({ preset: "p-sel", persona: "u-sel" });
        settings.modelProfiles[1].modelId = "sel-model-2";
        expect(risuChatParserScoped(input, {}, scope)).toBe("Ctx Persona|the context persona|ctx-model|1111|Cara");
        // A scope naming the selected records reads them, live (an edit after the capture is seen).
        settings.personas[1].name = "Sel Persona 2";
        expect(
            risuChatParserScoped(
                "{{user}}|{{model}}",
                {},
                { presetId: "p-sel", modelPresetId: "p-sel", personaId: "u-sel" },
            ),
        ).toBe("Sel Persona 2|sel-model-2");
    });

    it("reads each preset field from its owner: the model fields from the context's model preset, the prompt fields from its prompt preset, and keys its cache by both ids", () => {
        // The prompt preset of `p-ctx` with the model preset of `p-sel`, and the other way round
        // (the two are selected independently).
        const mixed = { presetId: "p-ctx", modelPresetId: "p-sel", personaId: "u-ctx" };
        const text = "{{model}}|{{maxcontext}}|{{mainprompt}}";
        expect(risuChatParserScoped(text, {}, mixed)).toBe("sel-model|2222|ctx main");
        expect(risuChatParserScoped(text, {}, { ...mixed, presetId: "p-sel", modelPresetId: "p-ctx" })).toBe(
            "ctx-model|1111|sel main",
        );
        // Two scopes that differ only by the model preset share no cached evaluator: the same prompt preset and persona read different model presets.
        expect(risuChatParserScoped("{{model}}", {}, { ...scope, modelPresetId: "p-ctx" })).toBe("ctx-model");
        expect(risuChatParserScoped("{{model}}", {}, { ...scope, modelPresetId: "p-sel" })).toBe("sel-model");
        expect(risuChatParserScoped("{{model}}", {}, { ...scope, modelPresetId: "p-ctx" })).toBe("ctx-model");
    });

    it("keeps the parse arguments (the chat, the character) of the plain parser", () => {
        expect(risuChatParserScoped("{{char}} and {{user}}", { chatRef: { chaId: "c", chatId: "k" } }, scope)).toBe(
            "Cara and Ctx Persona",
        );
        expect(risuChatParserScoped("{{char}}", { chara: characterList()[0] }, scope)).toBe("Cara");
    });

    it("refuses a context preset, model preset, or persona that no longer exists instead of falling back to the selection", () => {
        expect(() => risuChatParserScoped("{{user}}", {}, { ...scope, personaId: "missing" })).toThrow(
            PluginTargetGoneError,
        );
        expect(() => risuChatParserScoped("{{model}}", {}, { ...scope, presetId: "missing" })).toThrow(
            PluginTargetGoneError,
        );
        // A gone model preset fails the parse too, even for a prompt-owned field.
        expect(() => risuChatParserScoped("{{mainprompt}}", {}, { ...scope, modelPresetId: "missing" })).toThrow(
            PluginTargetGoneError,
        );
        // A parse that touches none still fails when a target is gone: the scope is checked when the database is read.
        expect(() => risuChatParserScoped("plain {{char}}", {}, { ...scope, presetId: "missing" })).toThrow(
            PluginTargetGoneError,
        );
        // The plain parser is unaffected.
        expect(risuChatParser("{{user}}")).toBe("Sel Persona");
    });

    it("reads `{{maxcontext}}` as the main model's effective size: the scope's prompt preset's override when on and above 0, else its model preset's main profile; the settings root stays the profile's", () => {
        const ctxPreset = settings.presets.find((preset) => preset.id === "p-ctx")!;
        ctxPreset.maxContextOverride = true;
        ctxPreset.maxContextOverrideSize = 5555;
        // The scope's prompt preset carries the override: it replaces the main profile's size of
        // whichever model preset the scope names (the server's request database reads the same).
        expect(risuChatParserScoped("{{maxcontext}}", {}, scope)).toBe("5555");
        expect(risuChatParserScoped("{{maxcontext}}", {}, { ...scope, modelPresetId: "p-sel" })).toBe("5555");
        // A scope whose prompt preset has no override reads the model preset's profile.
        expect(risuChatParserScoped("{{maxcontext}}", {}, { ...scope, presetId: "p-sel" })).toBe("1111");
        // The plain parser follows the selection: `p-sel` has no override; `p-ctx` does, over the
        // selected model preset's profile (`p-sel`, 2222), while the settings root, which the plugin
        // `getDatabase`/`setDatabase` round trip reads and writes back, keeps the profile's size.
        expect(risuChatParser("{{maxcontext}}")).toBe("2222");
        selectPreset("p-ctx");
        expect(risuChatParser("{{maxcontext}}")).toBe("5555");
        expect(readSettingsRoot("maxContext")).toBe(2222);
        expect(settings.modelProfiles.map((profile) => profile.maxContext)).toEqual([1111, 2222]);
        // 0 is unset and a flag that is off leaves the profile's size, in both parsers (the getters
        // are live: the cached scoped evaluator sees the edit).
        ctxPreset.maxContextOverrideSize = 0;
        expect(risuChatParser("{{maxcontext}}")).toBe("2222");
        expect(risuChatParserScoped("{{maxcontext}}", {}, scope)).toBe("1111");
        ctxPreset.maxContextOverrideSize = 5555;
        ctxPreset.maxContextOverride = false;
        expect(risuChatParser("{{maxcontext}}")).toBe("2222");
        expect(risuChatParserScoped("{{maxcontext}}", {}, scope)).toBe("1111");
    });
});

// A plain parse for a chat (`arg.chatRef`) runs on that chat's display ids (each bound record that
// exists, else the tab's selection), while a parse without a chat reads the settings views, which
// follow the selected chat.
describe("risuChatParser for a chat", () => {
    const k = { chaId: "c", chatId: "k" };
    const j = { chaId: "c", chatId: "j" };
    const ctx = "Ctx Persona|the context persona|ctx-model|1111|Cara";
    const sel = "Sel Persona|the selected persona|sel-model|2222|Cara";

    it("reads the chat's bound records, else the tab's, per field; a background chat never reads the selected chat's binding", () => {
        chatBindingPatch(k, { promptPresetId: "p-ctx", modelPresetId: "p-ctx", personaId: "u-ctx" });
        // The selected chat `k` is bound: the views and a parse for `k` read its records.
        expect(risuChatParser(input)).toBe(ctx);
        expect(risuChatParser(input, { chatRef: k })).toBe(ctx);
        // Chat `j` is unbound and not selected: the tab's, not `k`'s.
        expect(risuChatParser(input, { chatRef: j })).toBe(sel);
        // A partial binding: the unbound persona falls back; the presets hold.
        chatBindingPatch(k, { personaId: null });
        expect(risuChatParser(input, { chatRef: k })).toBe("Sel Persona|the selected persona|ctx-model|1111|Cara");
        expect(risuChatParser(input)).toBe("Sel Persona|the selected persona|ctx-model|1111|Cara");
        // A bound record that is gone falls back for that field only.
        chatBindingPatch(k, { personaId: "u-gone" });
        expect(risuChatParser(input, { chatRef: k })).toBe("Sel Persona|the selected persona|ctx-model|1111|Cara");
    });

    it("a ref captured for a chat keeps reading that chat after the selection moved to another chat", () => {
        chatBindingPatch(k, { promptPresetId: "p-ctx", modelPresetId: "p-ctx", personaId: "u-ctx" });
        selectChat("c", "j");
        expect(risuChatParser(input)).toBe(sel);
        expect(risuChatParser(input, { chatRef: j })).toBe(sel);
        expect(risuChatParser(input, { chatRef: k })).toBe(ctx);
        // The tab's selection changes: an unbound chat follows it, a bound one does not.
        selectPreset("p-ctx");
        selectPersona("u-ctx");
        expect(risuChatParser(input, { chatRef: j })).toBe("Ctx Persona|the context persona|sel-model|2222|Cara");
        expect(risuChatParser(input, { chatRef: k })).toBe(ctx);
    });
});

// Scoped CBS: the preset-owned variable defaults and module integration are the scope's
// (a `presetChain` pick included), while a stored chat variable stays the parse's chat's.
describe("risuChatParserScoped reads the variable defaults and the module integration from its scope", () => {
    const k = { chaId: "c", chatId: "k" };
    const text = "{{getvar::x}}|{{moduleenabled::ns-ctx}}|{{moduleenabled::ns-sel}}";
    const selScope = { presetId: "p-sel", modelPresetId: "p-sel", personaId: "u-sel" };

    it("the scope's preset wins over the chat's display preset; a stored variable is the chat's", () => {
        // `k` is unbound: its display preset is the tab's (`p-sel`), as the views'.
        expect(risuChatParser(text)).toBe("sel|0|1");
        expect(risuChatParser(text, { chatRef: k })).toBe("sel|0|1");
        expect(getChatVarOf(k, "x")).toBe("sel");
        expect(risuChatParserScoped(text, {}, scope)).toBe("ctx|1|0");
        expect(risuChatParserScoped(text, { chatRef: k }, scope)).toBe("ctx|1|0");
        expect(getChatVarOf(k, "x", scope)).toBe("ctx");
        // `k` bound to `p-ctx`: a parse for `k` reads it; a scope naming `p-sel` (a pick) still wins.
        chatBindingPatch(k, { promptPresetId: "p-ctx", modelPresetId: "p-ctx", personaId: "u-ctx" });
        expect(risuChatParser(text, { chatRef: k })).toBe("ctx|1|0");
        expect(risuChatParser(text)).toBe("ctx|1|0");
        expect(risuChatParserScoped(text, { chatRef: k }, selScope)).toBe("sel|0|1");
        // The stored value of the parse's chat wins over every default.
        setChatVarOf(k, "x", "stored");
        expect(risuChatParserScoped(text, { chatRef: k }, selScope)).toBe("stored|0|1");
        expect(risuChatParserScoped(text, { chatRef: k }, scope)).toBe("stored|1|0");
        expect(risuChatParser(text, { chatRef: k })).toBe("stored|1|0");
    });
});

// The asset pass of `ParseMarkdown` reads the render's persona icon before its first await, for the
// chat selected when the render began, also without a transform context.
describe("ParseMarkdown's asset pass", () => {
    const k = { chaId: "c", chatId: "k" };

    it("uses the icon of the persona the render's chat showed when it began, not the chat selected after an await", async () => {
        chatBindingPatch(k, { personaId: "u-ctx" });
        expect(getUserIcon()).toBe("icon-ctx");
        // The character image is resolved first: the user switches to the unbound chat `j` meanwhile.
        vi.mocked(getFileSrc).mockImplementation(async (path: string) => {
            if (path === "char-img") {
                selectChat("c", "j");
            }
            return `src:${path}`;
        });
        try {
            const out = await ParseMarkdown("{{source::user}}", characterList()[0] as never, "normal", -1, {}, null);
            expect(getUserIcon()).toBe("icon-sel");
            expect(vi.mocked(getFileSrc).mock.calls.map(([path]) => path)).toEqual(["char-img", "icon-ctx"]);
            expect(out).toContain("src:icon-ctx");
            expect(out).not.toContain("icon-sel");
        } finally {
            vi.mocked(getFileSrc).mockReset();
            vi.mocked(getFileSrc).mockImplementation(() => Promise.resolve(""));
        }
    });
});
