import { writable } from "svelte/store";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DBState } from "../../../stores.svelte";
import { risuChatParser } from "../../parser.svelte";
import { holdMockedChats, resetChatVariables } from "./lib";
import { setChatVar } from "../../chatVar.svelte";
import { selection } from "../../../storage/selection.svelte";

//#region module mocks

vi.mock(
    import("../../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
            getCurrentCharacter: () => ({}),
            getDatabase: () => ({}),
        }) as typeof import("../../../storage/database.svelte"),
);

vi.mock(import("../../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

vi.mock(import("../../../stores.svelte"), () => {
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
                globalChatVariables: {},
                templateDefaultVariables: "",
            },
        },
        selIdState: {
            selId: 0,
        },
        selectedCharID: writable(0),
    } as unknown as typeof import("../../../stores.svelte");
});

//#endregion

// The readers resolve the selected character by `selection.characterId` (Phase 6 slice 8), over
// the character list (`characterList()`, here the mocked `DBState.db.characters`): the fixture's
// character is the selected one, as `selectedCharID` 0 selected it.
selection.characterId = "c";
// The chat module holds the chat (Phase 6 slice 9a): the character in the records, its chat assembled.
holdMockedChats();

const template = (op: string, body: string) => `{{${op}}}${body}{{/}}`;
const quickParse = (...args: Parameters<typeof template>) => risuChatParser(template(...args));

beforeEach(() => {
    vi.resetAllMocks();
    resetChatVariables();
});

describe("#each", () => {
    test("can loop over a simple array literal", () => {
        expect(quickParse("#each [1, 2, 3] as n", "{{slot::n}} ")).toBe("123");
    });

    test("can loop over a simple array in a variable", () => {
        setChatVar("arr", JSON.stringify([1, 2, 3]));
        expect(quickParse("#each {{getvar::arr}} as n", "{{slot::n}} ")).toBe("123");
    });

    test("can loop over a 2D array literal", () => {
        expect(
            quickParse("#each::keep [[1, 2], [3, 4]] as x", template("#each::keep {{slot::x}} as y", "{{slot::y}}\n")),
        ).toBe("1\n2\n3\n4\n");
    });

    test("can loop over a 2D array literal", () => {
        setChatVar(
            "arr",
            JSON.stringify([
                [1, 2],
                [3, 4],
            ]),
        );
        expect(
            quickParse("#each::keep {{getvar::arr}} as x", template("#each::keep {{slot::x}} as y", "{{slot::y}}\n")),
        ).toBe("1\n2\n3\n4\n");
    });

    test("empty array produces no output", () => {
        expect(quickParse("#each [] as n", "{{slot::n}} ")).toBe("");
    });

    test("does nothing when not a JSON array, pass the input as is", () => {
        expect(quickParse("#each a,b,c as n", "{{slot::n}} ")).toBe("a,b,c");
        expect(quickParse("#each {{getvar::aa}} as n", "{{slot::n}} ")).toBe("null");
        expect(quickParse("#each [1][2] as n", "{{slot::n}} ")).toBe("[1][2]");
    });

    test("trimes whitespaces of its body", () => {
        expect(quickParse("#each [1, 2, 3] as n", " \n - {{slot::n}}\n  ")).toBe(`- 1- 2- 3`);
    });

    test("can be nested", () => {
        expect(
            quickParse("#each::keep [1, 2] as x", template("#each::keep [3, 4] as y", "{{slot::x}}{{slot::y}}\n")),
        ).toBe("13\n14\n23\n24\n");
    });

    test("works in #when ... :else", () => {
        /*
    :else is sensitive to line breaks
    {{#when A}}
      {{#each [1, 2, 3] as n}}{{slot::n}}{{/}}
    {{:else}}
      {{#each [3, 2, 1] as n}}{{slot::n}}{{/}}
    {{/}}
    */
        const nestedTemplate = (a: string) =>
            `{{#when ${a}}}\n{{#each [1, 2, 3] as n}}{{slot::n}}{{/}}\n{{:else}}\n{{#each [3, 2, 1] as n}}{{slot::n}}{{/}}\n{{/}}`;

        expect(risuChatParser(nestedTemplate("1"))).toBe("123");
        expect(risuChatParser(nestedTemplate("0"))).toBe("321");
    });

    test('can omit "as"', () => {
        expect(quickParse("#each [1, 2, 3] n", "{{slot::n}} ")).toBe("123");
        expect(quickParse("#each [1, 2, 3] n", "{{slot::n}} ")).toBe("123");
    });

    describe("Operators: whitespaces", () => {
        test("::keep preserves all whitespaces", () => {
            expect(quickParse("#each::keep [1, 2, 3] as n", "  - {{slot::n}}\n")).toBe(`  - 1\n  - 2\n  - 3\n`);
        });
    });
});
