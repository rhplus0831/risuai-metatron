import fc from "fast-check";
import { beforeEach, expect, test, vi } from "vitest";
import { characterList } from "../../storage/characterStore.svelte";
import { selectChat, setChatMeta } from "../../storage/chatStore.svelte";
import { selectCharacterAt } from "../../storage/selection.svelte";
import { activePreset, settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "../../storage/tests/installFlatDatabase";
import { getChatVar, getGlobalChatVar, setChatVar } from "../chatVar.svelte";

//#region module mocks

vi.mock(
    import("../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
        }) as typeof import("../../storage/database.svelte"),
);

vi.mock(import("../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

//#endregion

// The fixture lives in the records (installed as the removed `setDatabaseLite` installed a
// database; there is no whole-database object since Phase 6 slice 10), which `chatVar.svelte`
// reads through the settings views (Phase 6 slice 7: the global variables, and the template's
// default variables in the selected preset), the character store (slice 8: the selected character,
// by `selection.characterId`) and the chat module (slice 9a: its selected chat). The character and
// its chat are selected as `selectedCharID` 0 and the chat page selected them.
installFlatDatabaseWithChats({
    globalChatVariables: {},
    botPresets: [{ id: "preset", name: "Preset", templateDefaultVariables: "" }],
    characters: [
        {
            chaId: "c",
            chatPage: 0,
            chats: [
                {
                    id: "k",
                    scriptstate: {},
                },
            ],
            defaultVariables: "",
        },
    ],
});
selectCharacterAt(0);
selectChat("c", "k");

/** The fixture's character record (its wrapper in the character list). */
const character = () => characterList()[0];

/**
 * Resets `globalChatVariables` and its default values, as well as the character's chat's
 * scriptstate and its default values, where the readers read them.
 */
function resetChatVariables() {
    setChatMeta({ chaId: "c", chatId: "k" }, { scriptstate: {} });
    character().defaultVariables = "";
    settings.globalChatVariables = {};
    activePreset.templateDefaultVariables = "";
}

const anyValidDefaultVarKey = fc.string({ minLength: 1, unit: "grapheme" }).filter((s) => !/[=\n]/.test(s));
const anyValidDefaultVarValue = fc
    .anything()
    .map(JSON.stringify)
    .filter((s) => s !== undefined && !/[=\n]/.test(s));

beforeEach(() => {
    vi.resetAllMocks();
    resetChatVariables();
});

test("can get a character default variable", () => {
    fc.assert(
        fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
            character().defaultVariables = `${key}=${value}`;
            expect(getChatVar(key)).toBe(value);
        }),
    );
});

test("can get a template default variable", () => {
    fc.assert(
        fc.property(anyValidDefaultVarKey, anyValidDefaultVarValue, (key, value) => {
            activePreset.templateDefaultVariables = `${key}=${value}`;
            expect(getChatVar(key)).toBe(value);
        }),
    );
});

test("can set and get a chat variable", () => {
    fc.assert(
        fc.property(
            fc.string({ unit: "grapheme" }),
            fc
                .anything()
                .filter((v) => v !== undefined)
                .map(JSON.stringify),
            (key, value) => {
                setChatVar(key, value);
                expect(getChatVar(key)).toBe(value);
            },
        ),
    );
});

test("can set a chat variable over its default value", () => {
    character().defaultVariables = "char=default";
    activePreset.templateDefaultVariables = "template=default";

    setChatVar("char", "overridden");
    setChatVar("template", "overridden");

    expect(getChatVar("char")).toBe("overridden");
    expect(getChatVar("template")).toBe("overridden");
});

test("can get a global chat variable", () => {
    fc.assert(
        fc.property(
            fc.string({ unit: "grapheme" }),
            fc
                .anything()
                .filter((v) => v !== undefined)
                .map(JSON.stringify),
            (key, value) => {
                settings.globalChatVariables[`toggle_${key}`] = value;

                expect(getGlobalChatVar(`toggle_${key}`)).toBe(value);
            },
        ),
    );
});

test('returns "null" for undefined variables', () => {
    fc.assert(
        fc.property(fc.string({ unit: "grapheme" }), (key) => {
            expect(getChatVar(key)).toBe("null");
            expect(getGlobalChatVar(`toggle_${key}`)).toBe("null");
        }),
    );
});
