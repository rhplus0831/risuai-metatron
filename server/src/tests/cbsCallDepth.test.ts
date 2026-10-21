// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCbsEvaluator, type CbsParseArg } from "../../../shared/cbs/evaluator.ts";
import { CbsLimitError } from "../../../shared/cbs/limits.ts";
import type { Database } from "../../../shared/database.ts";
import { createNodeCbsEvaluator, createNodeCbsHost } from "./cbsHost.ts";

// The evaluator's call depth of 20 counts the parses in progress, not the parses done. Before the
// fix every parse incremented the caller's `arg.callStack` and never restored it, so the twentieth
// sibling `{{call::f}}`, the nineteenth message of a `{{history}}` (the registry passes one
// `matcherArg` to every nested parse) and the twenty-fifth `{{description}}` answered "ERROR: Call
// stack limit reached". Genuine recursion still stops there. The budget (`limits.ts`) is the bound
// of a fan-out of calls, which the shared counter used to cap as a side effect; that trade-off is
// pinned here.

const ERROR = "ERROR: Call stack limit reached";

function database(): Database {
    return {
        characters: [
            {
                name: "Bot",
                chaId: "c",
                type: "character",
                desc: "D",
                firstMessage: "Greeting",
                chatPage: 0,
                chats: [
                    {
                        id: "k",
                        fmIndex: -1,
                        message: Array.from({ length: 25 }, (_, index) => ({
                            role: "char",
                            data: `Message ${index + 1}`,
                        })),
                    },
                ],
            },
        ],
        personas: [],
        globalChatVariables: {},
    } as unknown as Database;
}

let db: Database;
beforeEach(() => {
    db = database();
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

const parse = (text: string, arg?: CbsParseArg) =>
    createNodeCbsEvaluator(db, { selectedCharID: 0 }).risuChatParser(text, arg);

/**
 * A chain of `depth` functions, each calling the one below; the innermost answers "x". Defined from
 * the outermost down: a function's body is evaluated when it is defined, so a body that calls a
 * function defined later keeps the call literal, and the calls nest at call time.
 */
const chain = (depth: number) =>
    Array.from({ length: depth }, (_, i) => depth - i)
        .map((n) => `{{#func f${n}}}{{call::f${n - 1}}}{{/func}}`)
        .join("") +
    "{{#func f0}}x{{/func}}" +
    `{{call::f${depth}}}`;

describe("the call depth counts nested parses only", () => {
    it("twenty, twenty-five and a hundred sibling calls all answer", () => {
        for (const count of [20, 25, 100]) {
            const result = parse("{{#func f}}hello|{{/func}}" + "{{call::f}}".repeat(count));
            expect(result, `${count} calls`).toBe("hello|".repeat(count));
        }
    });

    it("sibling calls inside a loop all answer", () => {
        const items = JSON.stringify(Array.from({ length: 30 }, (_, i) => i));
        expect(parse(`{{#func f}}hello|{{/func}}{{#each ${items} as n}}{{call::f}}{{/each}}`)).toBe(
            "hello|".repeat(30),
        );
    });

    it("the registry's nested parses of one call share nothing: 25 descriptions and a 25-message history", () => {
        expect(parse("{{description}}".repeat(25))).toBe("D".repeat(25));
        const history = (JSON.parse(parse("{{history}}")) as string[]).map((entry) => JSON.parse(entry).data);
        expect(history).toEqual(["Greeting", ...Array.from({ length: 25 }, (_, i) => `Message ${i + 1}`)]);
    });

    it("a chain of nested calls answers up to depth 20 and errors past it", () => {
        // The top-level parse is depth 1, `call::fN` depth 2, ..., `f0` depth N + 2: 20 at N = 18.
        expect(parse(chain(18))).toBe("x");
        expect(parse(chain(19))).toBe(ERROR);
        expect(parse(chain(21))).toBe(ERROR);
    });

    it("genuine recursion answers exactly the error text, and the budget stays whole afterwards", () => {
        expect(parse("{{#func loop}}{{call::loop}}{{/func}}{{call::loop}}")).toBe(ERROR);
        expect(parse("{{description}}")).toBe("D");
    });

    it("a parse leaves the caller's argument object as it was", () => {
        const arg: CbsParseArg = {};
        expect(parse("{{#func f}}ok{{/func}}{{call::f}}", arg)).toBe("ok");
        expect(arg).toEqual({});
        // The depth a caller passes is the parent's: this parse is one deeper, the call two.
        expect(parse("{{#func f}}ok{{/func}}{{call::f}}", { callStack: 18 })).toBe("ok");
        expect(parse("{{#func f}}ok{{/func}}{{call::f}}", { callStack: 19 })).toBe(ERROR);
    });

    it("a function defined inside a called body stays visible to the caller, as before", () => {
        expect(parse("{{#func outer}}{{#func inner}}inner{{/func}}{{/func}}{{call::outer}}{{call::inner}}")).toBe(
            "inner",
        );
    });

    it("a function defined in one history message is not visible in the next (the shared argument is no longer written)", () => {
        (db.characters[0].chats[0] as { message: unknown }).message = [
            { role: "char", data: "{{#func f}}{{#func inner}}leaked{{/func}}{{/func}}{{call::f}}" },
            { role: "char", data: "{{call::inner}}" },
        ];
        const history = (JSON.parse(parse("{{history}}")) as string[]).map((entry) => JSON.parse(entry).data);
        expect(history).toEqual(["Greeting", "", "{{call::inner}}"]);
    });

    it("a fan-out of calls is bounded by the work budget, no longer by the shared counter", () => {
        const bounded = createCbsEvaluator({
            ...createNodeCbsHost(db, { selectedCharID: 0 }),
            limits: { maxWork: 100_000, maxMs: 1_000_000, now: () => 0 },
        });
        let error: unknown;
        try {
            bounded.risuChatParser("{{#func f}}a{{call::f}}{{call::f}}{{/func}}{{call::f}}");
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(CbsLimitError);
        expect((error as CbsLimitError).reason).toBe("work");
        expect(bounded.risuChatParser("{{description}}")).toBe("D");
    });
});
