import fc from "fast-check";
import { beforeEach, expect, test, vi } from "vitest";
import { characterList } from "../../storage/characterStore.svelte";
import {
    ackChatWork,
    findChat,
    hasChatWork,
    seedChats,
    selectChat,
    setChatMeta,
    takeChatWork,
} from "../../storage/chatStore.svelte";
import { selectCharacterAt } from "../../storage/selection.svelte";
import { activePreset, settings } from "../../storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "../../storage/tests/installFlatDatabase";
import { getChatVar, getChatVarOf, getGlobalChatVar, setChatVar, setChatVarOf } from "../chatVar.svelte";

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
// database; there is no whole-database object), which `chatVar.svelte` reads through the settings
// views (the global variables, and the template's default variables in the selected preset), the
// character store (the selected character, by `selection.characterId`) and the chat module (its
// selected chat). The character and its chat are selected as `selectedCharID` 0 and the chat page
// selected them. Chat `q` is never reset below: the queued-op test reads its queue, which no fixture
// reset is folded into.
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
                {
                    id: "q",
                    scriptstate: { $kept: "k" },
                },
            ],
            defaultVariables: "",
        },
    ],
});
// The chats as the server holds them (revisions), so the module's queue can be taken as a batch.
seedChats(
    [
        { characterId: "c", id: "k", revision: "r1" },
        { characterId: "c", id: "q", revision: "r1" },
    ],
    [{ characterId: "c", revision: "o1", ids: ["k", "q"] }],
);
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

test("setChatVar and setChatVarOf queue the one entry as a `meta` merge of `scriptstate`, never the whole map", () => {
    const refQ = { chaId: "c", chatId: "q" };
    /** The ops queued for `q` since the last take (the fixture's resets of `k` are taken too). */
    const opsOfQ = () => {
        const work = takeChatWork(new Set());
        const group = work.groups.find((entry) => entry.chatId === "q");
        ackChatWork(
            work,
            work.groups.map((entry, index) => ({ characterId: "c", id: entry.chatId, revision: `r${2 + index}` })),
            [],
        );
        return group?.ops ?? [];
    };
    opsOfQ();

    selectChat("c", "q");
    try {
        expect(setChatVar("hp", "5")).toBe(true);
        expect(getChatVar("hp")).toBe("5");
        expect(getChatVar("kept")).toBe("k");
        expect(opsOfQ()).toEqual([{ op: "meta", merge: { scriptstate: { $hp: "5" } } }]);
        // The same value again writes nothing.
        expect(setChatVar("hp", "5")).toBe(false);
        expect(hasChatWork()).toBe(false);
    } finally {
        selectChat("c", "k");
    }

    expect(setChatVarOf(refQ, "mp", "7")).toBe(true);
    expect(getChatVarOf(refQ, "mp")).toBe("7");
    expect(opsOfQ()).toEqual([{ op: "meta", merge: { scriptstate: { $mp: "7" } } }]);
    expect(setChatVarOf(refQ, "mp", "7")).toBe(false);
    expect(setChatVarOf(null, "mp", "8")).toBe(false);
    expect(setChatVarOf({ chaId: "c", chatId: "gone" }, "mp", "8")).toBe(false);
    expect(hasChatWork()).toBe(false);
    expect(findChat(refQ)!.scriptstate).toEqual({ $kept: "k", $hp: "5", $mp: "7" });
    expect(findChat({ chaId: "c", chatId: "k" })!.scriptstate).toEqual({});
});
