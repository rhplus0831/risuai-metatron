import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 7a: `risuChatParserScoped` (`parser.svelte.ts`), the CBS parser for a frozen plugin
// call context. The preset fields and the persona come from the context's records, whatever the
// tab selects afterwards; everything else is the tab's; a context preset or persona that no longer
// exists fails the parse with `PluginTargetGoneError`. The plugin host's `parseRisuChat` inside a
// hook and the transport's `cbs` callback use it (`pluginContext.test.ts`, `transport.test.ts`).

const holder = vi.hoisted(() => ({
    dbState: { db: {} as any },
    selectedCharID: null as unknown as import("svelte/store").Writable<number>,
}));

vi.mock(import("../../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    holder.selectedCharID = writable(0);
    return {
        DBState: holder.dbState,
        selIdState: { selId: 0 },
        selectedCharID: holder.selectedCharID,
        CurrentTriggerIdStore: writable<string | null>(null),
        CharEmotion: writable({}),
    } as unknown as typeof import("../../stores.svelte");
});

vi.mock(import("../../storage/database.svelte"), async () => {
    const { get } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    const current = () => holder.dbState.db.characters?.[get(holder.selectedCharID)];
    return {
        appVer: "1234.5.67",
        defaultSdDataFunc: () => [],
        getDatabase: () => holder.dbState.db,
        getCurrentCharacter: () => current(),
        getCurrentChat: () => current()?.chats?.[current().chatPage],
    } as unknown as typeof import("../../storage/database.svelte");
});

vi.mock(import("../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

import { risuChatParser, risuChatParserScoped } from "../parser.svelte";
import { PluginTargetGoneError } from "../../plugins/apiV3/pluginContext";
import { DBState } from "../../stores.svelte";
import { installForwarding } from "../../storage/forwarding.svelte";
import { initializeRecords, takeRecordFields } from "../../storage/records.svelte";
import { selectPersona, selectPreset } from "../../storage/selection.svelte";

/**
 * The tab's database, installed as `setDatabaseLite` installs one (`database.svelte` is mocked
 * here): its fields moved into the records, the forwarding accessors on, and the preset and persona
 * selected, since the parser reads the settings through the record views (Phase 6 slice 7). The
 * forwarding layer serves the selected preset and persona under their root names.
 */
function database(selected: { preset: string; persona: string }) {
    const raw = {
        botPresets: [
            { id: "p-ctx", name: "Context", aiModel: "ctx-model", maxContext: 1111, templateDefaultVariables: "" },
            { id: "p-sel", name: "Selected", aiModel: "sel-model", maxContext: 2222, templateDefaultVariables: "" },
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
    initializeRecords(takeRecordFields(raw));
    installForwarding(raw);
    selectPreset(selected.preset);
    selectPersona(selected.persona);
    return raw as any;
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    DBState.db = database({ preset: "p-sel", persona: "u-sel" }) as never;
});
afterEach(() => {
    vi.restoreAllMocks();
});

const scope = { presetId: "p-ctx", personaId: "u-ctx" };
const input = "{{user}}|{{persona}}|{{model}}|{{maxcontext}}|{{char}}";

describe("risuChatParserScoped", () => {
    it("reads the context's preset fields and persona while the plain parser reads the selection", () => {
        expect(risuChatParser(input)).toBe("Sel Persona|the selected persona|sel-model|2222|Cara");
        expect(risuChatParserScoped(input, {}, scope)).toBe("Ctx Persona|the context persona|ctx-model|1111|Cara");
        // The same scope after the selection moved elsewhere: still the context's records.
        DBState.db = database({ preset: "p-sel", persona: "u-sel" }) as never;
        DBState.db.botPresets[1].aiModel = "sel-model-2";
        expect(risuChatParserScoped(input, {}, scope)).toBe("Ctx Persona|the context persona|ctx-model|1111|Cara");
        // A scope naming the selected records reads them, live (an edit after the capture is seen).
        DBState.db.personas[1].name = "Sel Persona 2";
        expect(risuChatParserScoped("{{user}}|{{model}}", {}, { presetId: "p-sel", personaId: "u-sel" })).toBe(
            "Sel Persona 2|sel-model-2",
        );
    });

    it("keeps the parse arguments (the chat, the character) of the plain parser", () => {
        expect(risuChatParserScoped("{{char}} and {{user}}", { chatRef: { chaId: "c", chatId: "k" } }, scope)).toBe(
            "Cara and Ctx Persona",
        );
        expect(risuChatParserScoped("{{char}}", { chara: DBState.db.characters[0] }, scope)).toBe("Cara");
    });

    it("refuses a context preset or persona that no longer exists instead of falling back to the selection", () => {
        expect(() => risuChatParserScoped("{{user}}", {}, { presetId: "p-ctx", personaId: "missing" })).toThrow(
            PluginTargetGoneError,
        );
        expect(() => risuChatParserScoped("{{model}}", {}, { presetId: "missing", personaId: "u-ctx" })).toThrow(
            PluginTargetGoneError,
        );
        // A parse that touches neither still fails when a target is gone: the scope is checked when the database is read.
        expect(() => risuChatParserScoped("plain {{char}}", {}, { presetId: "missing", personaId: "u-ctx" })).toThrow(
            PluginTargetGoneError,
        );
        // The plain parser is unaffected.
        expect(risuChatParser("{{user}}")).toBe("Sel Persona");
    });
});
