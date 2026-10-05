import fc from "fast-check";
import { writable } from "svelte/store";
import { beforeEach, expect, test, vi } from "vitest";
import { DBState } from "../../stores.svelte";
import { initializeRecords, takeRecordFields } from "../../storage/records.svelte";
import { activePreset, settings } from "../../storage/settingsViews.svelte";
import { getChatVar, getGlobalChatVar, setChatVar } from "../chatVar.svelte";
import { resetChatVariables } from "./cbs/lib";

//#region module mocks

vi.mock(
    import("../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
            getCurrentCharacter: () => ({}),
            getCurrentChat: () => DBState.db.characters[0].chats[0],
            getDatabase: () => ({}),
        }) as typeof import("../../storage/database.svelte"),
);

vi.mock(import("../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

vi.mock(import("../../stores.svelte"), () => {
    return {
        DBState: {
            db: {
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
            },
        },
        selIdState: {
            selId: 0,
        },
        selectedCharID: writable(0),
    } as unknown as typeof import("../../stores.svelte");
});

//#endregion

// The settings live in the records (installed as `setDatabaseLite` installs a database), which
// `chatVar.svelte` reads through the settings views (Phase 6 slice 7): the global variables, and
// the template's default variables in the selected preset. The character stays on `DBState.db`.
initializeRecords(
    takeRecordFields({
        globalChatVariables: {},
        botPresets: [{ id: "preset", name: "Preset", templateDefaultVariables: "" }],
    }),
);

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
            DBState.db.characters[0].defaultVariables = `${key}=${value}`;
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
    DBState.db.characters[0].defaultVariables = "char=default";
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
