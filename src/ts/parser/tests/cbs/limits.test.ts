import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { language } from "src/lang";
import { CbsLimitError } from "../../../../../shared/cbs/limits";
import { risuChatParser, risuChatParserForDisplay } from "../../parser.svelte";
import { holdMockedChats, resetChatVariables, type MockedCharacter } from "./lib";
import { selection } from "../../../storage/selection.svelte";

//#region module mocks

vi.mock(
    import("../../../storage/database.svelte"),
    () =>
        ({
            appVer: "1234.5.67",
        }) as unknown as typeof import("../../../storage/database.svelte"),
);

vi.mock(import("../../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

// `stores.svelte` runs module effects over the selection and the chat; nothing under test reads it.
vi.mock(import("../../../stores.svelte"), () => ({}) as unknown as typeof import("../../../stores.svelte"));

//#endregion

// Audit UI-01 (`docs/plan/audit-findings-perf.md`, slice 1d): the tab's CBS host carries a budget
// (`CLIENT_CBS_LIMITS` in `parser.svelte.ts`, the server's work limit and 2 s per top-level parse),
// so a template that never ends throws `CbsLimitError` instead of holding the UI thread, and the
// display call sites (`risuChatParserForDisplay`: the chat row's pre-pass, the background, the popup
// preview) show a localized text for that parse. Every other caller keeps the throw (the server's
// `cbs` callback fails its request on purpose). A non-advancing range is refused before the loop.
// Before the fix `{{range::[0,1e18]}}` ran until the heap was exhausted and `{{range::[0,1,0]}}`
// forever.

const characters: MockedCharacter[] = [
    { chaId: "c", chatPage: 0, chats: [{ id: "k", scriptstate: {} } as any], defaultVariables: "" },
];

selection.characterId = "c";
holdMockedChats(characters);

const HUGE = "{{range::[0,1e18]}}";
const WORK_MESSAGE = "CBS limit reached: one template took more than 10000000 steps";

beforeEach(() => {
    vi.resetAllMocks();
    resetChatVariables(characters);
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("the client CBS budget", () => {
    test("a huge range ends with the work limit on the plain wrapper", () => {
        let error: unknown;
        try {
            risuChatParser(HUGE);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(CbsLimitError);
        expect((error as CbsLimitError).reason).toBe("work");
        expect((error as CbsLimitError).message).toBe(WORK_MESSAGE);
    });

    test("the budget starts over for the next top-level parse", () => {
        expect(() => risuChatParser(HUGE)).toThrow(CbsLimitError);
        expect(risuChatParser("a".repeat(1000) + "{{range::[3]}}")).toBe("a".repeat(1000) + '["0","1","2"]');
    });

    test("a non-advancing range answers [] without reaching the limit", () => {
        expect(risuChatParser("{{range::[0,1,0]}}")).toBe("[]");
        expect(risuChatParser("{{range::[0,1,-1]}}")).toBe("[]");
        expect(risuChatParser("{{range::[0,1e400]}}")).toBe("[]");
    });

    test("the display wrapper answers the localized text for a limit, with the reason, and warns once", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(risuChatParserForDisplay("before " + HUGE)).toBe(
            language.cbsLimitReached.replace("{{reason}}", WORK_MESSAGE),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBeInstanceOf(CbsLimitError);
        // The next display parse is not affected.
        expect(risuChatParserForDisplay("ok {{range::[3]}}")).toBe('ok ["0","1","2"]');
    });

    test("the text has the key in every language file that defines it", () => {
        expect(language.cbsLimitReached).toContain("{{reason}}");
    });
});

describe("the call depth on the client host", () => {
    test("twenty-five sibling calls answer, genuine recursion stops with the error text", () => {
        expect(risuChatParser("{{#func f}}hello|{{/func}}" + "{{call::f}}".repeat(25))).toBe("hello|".repeat(25));
        expect(risuChatParser("{{#func loop}}{{call::loop}}{{/func}}{{call::loop}}")).toBe(
            "ERROR: Call stack limit reached",
        );
    });
});
