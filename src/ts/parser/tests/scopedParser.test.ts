import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 7a: `risuChatParserScoped` (`parser.svelte.ts`), the CBS parser for a frozen plugin
// call context. The preset fields come from the context's prompt or model preset, whichever owns the
// field (`docs/plan/split-preset.md`), and the persona from the context's persona, whatever the tab
// selects afterwards; everything else is the tab's; a context preset, model preset, or persona that
// no longer exists fails the parse with `PluginTargetGoneError`. The plugin host's `parseRisuChat`
// inside a hook and the transport's `cbs` callback use it (`pluginContext.test.ts`, `transport.test.ts`).

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
    getFileSrc: () => Promise.resolve(""),
}));

import { risuChatParser, risuChatParserScoped } from "../parser.svelte";
import { PluginTargetGoneError } from "../../plugins/apiV3/pluginContext";
import { characterList } from "../../storage/characterStore.svelte";
import { selectChat } from "../../storage/chatStore.svelte";
import { selectCharacterAt, selectModelPreset, selectPersona, selectPreset } from "../../storage/selection.svelte";
import { settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "../../storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";

/**
 * The tab's database, installed in the records (as the removed `setDatabaseLite` installed one;
 * there is no whole-database object since Phase 6 slice 10): the parser reads the settings through
 * the record views (Phase 6 slice 7), the selected character through the character store (slice 8)
 * and its chat through the chat module (slice 9a), with the presets and persona selected by id. The
 * prompt presets `p-ctx`/`p-sel` carry the prompt fields; the model presets of the same ids name
 * main profiles (`docs/plan/model-profiles.md`) whose model id and `maxContext` the parser reads as
 * the roots `aiModel` and `maxContext`.
 */
function database(selected: { preset: string; modelPreset?: string; persona: string }) {
    const raw = {
        botPresets: [
            {
                id: "p-ctx",
                name: "Context",
                templateDefaultVariables: "",
                mainPrompt: "ctx main",
            },
            {
                id: "p-sel",
                name: "Selected",
                templateDefaultVariables: "",
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
            { id: "u-ctx", name: "Ctx Persona", personaPrompt: "the context persona" },
            { id: "u-sel", name: "Sel Persona", personaPrompt: "the selected persona" },
        ],
        characters: [
            {
                chaId: "c",
                name: "Cara",
                chatPage: 0,
                chats: [{ id: "k", message: [], scriptstate: {}, bindedPersona: "" }],
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
        // (`docs/plan/split-preset.md`: the two are selected independently).
        const mixed = { presetId: "p-ctx", modelPresetId: "p-sel", personaId: "u-ctx" };
        const text = "{{model}}|{{maxcontext}}|{{mainprompt}}";
        expect(risuChatParserScoped(text, {}, mixed)).toBe("sel-model|2222|ctx main");
        expect(risuChatParserScoped(text, {}, { ...mixed, presetId: "p-sel", modelPresetId: "p-ctx" })).toBe(
            "ctx-model|1111|sel main",
        );
        // Two scopes that differ only by the model preset share no cached evaluator (Astra plan
        // review point 1): the same prompt preset and persona read different model presets.
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
});
