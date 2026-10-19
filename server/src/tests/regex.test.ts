// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, customscript } from "../../../shared/database.ts";
import {
    createScriptCache,
    regexScriptCacheKey,
    runRegexScripts,
    type RegexScriptEffect,
    type RegexScriptRun,
} from "../../../shared/scripts/regex.ts";
import { createNodeCbsEvaluator } from "./cbsHost.ts";

/**
 * The shared regex engine (Phase 5 slice 3) under plain Node: the script loop as `processScriptFull`
 * ran it on the client (flags, `<order n>` and the other `<...>` actions, the `@@` directives, the
 * skipped scripts), the effects applied where their script matched, and the cache helpers. The
 * client wrapper around it is covered by `src/ts/process/scripts.test.ts`.
 */
const script = (fields: Partial<customscript>): customscript => ({
    comment: "",
    in: "",
    out: "",
    type: "editoutput",
    ...fields,
});

const identity = (text: string) => text;

const run = (data: string, scripts: customscript[], fields: Partial<RegexScriptRun> = {}) =>
    runRegexScripts(data, scripts, {
        mode: "editoutput",
        chatID: -1,
        parse: identity,
        repeatBackSource: () => "",
        ...fields,
    });

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the script loop", () => {
    it("runs the scripts of the mode only, in declaration order", () => {
        const scripts = [
            script({ in: "a", out: "b" }),
            script({ in: "b", out: "c", type: "editinput" }),
            script({ in: "b", out: "d" }),
        ];
        expect(run("a", scripts).data).toBe("d");
        expect(run("a", scripts, { mode: "editinput" }).data).toBe("a");
    });

    it("sorts by <order n> descending once any script carries one; unordered scripts count as 0", () => {
        const scripts = [
            script({ in: "a", out: "b" }),
            script({ in: "a", out: "z", ableFlag: true, flag: "g<order 1>" }),
            script({ in: "z", out: "y", ableFlag: true, flag: "g<order 5>" }),
        ];
        // order 5 (no match), order 1 (a -> z), then the unordered script (a -> b: no match left).
        expect(run("a", scripts).data).toBe("z");
    });

    it("skips an empty pattern, a malformed pattern, and keeps running the later scripts", () => {
        const scripts = [
            script({ in: "", out: "X" }),
            script({ in: "(unclosed", out: "Y" }),
            script({ in: "hello", out: "bye" }),
        ];
        expect(run("hello", scripts).data).toBe("bye");
        expect(console.error).toHaveBeenCalledTimes(1);
    });

    it("drops unsupported and repeated flags, falls back to u, and ignores the flag without ableFlag", () => {
        expect(run("Hello hello", [script({ in: "hello", out: "hi", ableFlag: true, flag: "ggi z" })]).data).toBe(
            "hi hi",
        );
        expect(run("aaa", [script({ in: "a", out: "b", ableFlag: true, flag: "z" })]).data).toBe("baa");
        // Quirk: an action-only flag leaves an empty flag string, which falls back to `g`, not `u`.
        expect(run("aaa", [script({ in: "a", out: "b", ableFlag: true, flag: "<cbs>" })]).data).toBe("bbb");
        expect(run("aaa", [script({ in: "a", out: "b", flag: "i" })]).data).toBe("bbb");
    });

    it("expands $n to a newline; quirk: {{data}} in the output stays literal", () => {
        // `outScript.replace(/{{data}}/g, "$&")` inserts the match itself, so nothing changes.
        expect(run("cat dog", [script({ in: "cat", out: "[{{data}}]$n" })]).data).toBe("[{{data}}]\n dog");
    });

    it("appends a newline to an output ending in > unless <no_end_nl>", () => {
        expect(run("x", [script({ in: "x", out: "<em>x</em>" })]).data).toBe("<em>x</em>\n");
        expect(run("x", [script({ in: "x", out: "<em>x</em>", ableFlag: true, flag: "g<no_end_nl>" })]).data).toBe(
            "<em>x</em>",
        );
    });

    it("parses a <cbs> pattern and the replaced text through the run's parse", () => {
        const parse = (text: string) => text.replaceAll("{{char}}", "Risu");
        const scripts = [script({ in: "{{char}}", out: "{{char}}!", ableFlag: true, flag: "g<cbs>" })];
        expect(run("Risu said hi", scripts, { parse }).data).toBe("Risu! said hi");
        // Without the action the pattern is literal and does not match.
        expect(run("Risu said hi", [script({ in: "{{char}}", out: "x" })], { parse }).data).toBe("Risu said hi");
    });

    it("moves matches to the top or the bottom with group substitution; a named group stays literal", () => {
        expect(
            run("body\n<note>keep</note>", [
                script({ in: "<note>(.*?)</note>", out: "@@move_top [$1]", ableFlag: true, flag: "g" }),
            ]).data,
        ).toBe("[keep]\nbody\n");
        expect(
            run("<note>keep</note>\nbody", [
                script({ in: "<note>(?<n>.*?)</note>", out: "$<n> $&", ableFlag: true, flag: "g<move_bottom>" }),
            ]).data,
        ).toBe("\nbody\n$<n> <note>keep</note>");
        expect(run("body", [script({ in: "<x>", out: "@@move_top", ableFlag: true, flag: "g" })]).data).toBe("body");
    });

    it("parses a moved result through the run's parse, like the other replacements (crosscheck row 11)", () => {
        const parse = (text: string) => text.replaceAll("{{user}}", "Uma");
        expect(
            run("<note>hi</note> body", [script({ in: "<note>(.*?)</note>", out: "@@move_top {{user}}: $1" })], {
                parse,
            }).data,
        ).toBe("Uma: hi\n body");
        expect(
            run(
                "<note>hi</note> body",
                [script({ in: "<note>(.*?)</note>", out: "{{user}}: $1", ableFlag: true, flag: "g<move_bottom>" })],
                { parse },
            ).data,
        ).toBe(" body\nUma: hi");
    });
});

describe("the effects", () => {
    it("returns @@emo and @@inject in script order and removes an injected match", () => {
        const scripts = [
            script({ in: "A", out: "@@emo  happy " }),
            script({ in: "B", out: "@@inject" }),
            script({ in: "C", out: "@@emo sad" }),
            script({ in: "D", out: "x", ableFlag: true, flag: "g<inject>" }),
        ];
        const result = run("ABCD", scripts, { chatID: 0 });
        expect(result.data).toBe("AC");
        expect(result.effects).toEqual([
            { kind: "emotion", name: "happy" },
            { kind: "inject", text: "ABCD" },
            { kind: "emotion", name: "sad" },
            { kind: "inject", text: "ACD" },
        ]);
    });

    it("quirk: @@inject needs a message index; at -1 the directive text replaces the match", () => {
        const result = run("XY", [script({ in: "X", out: "@@inject" })]);
        expect(result.data).toBe("@@injectY");
        expect(result.effects).toEqual([]);
    });

    it("applies each effect where its script matched, so a later script's CBS reads the write", () => {
        const db = {
            username: "User",
            personas: [],
            globalChatVariables: {},
            templateDefaultVariables: "",
            characters: [
                {
                    type: "character",
                    chaId: "c",
                    name: "Bot",
                    chatPage: 0,
                    chats: [{ id: "chat", fmIndex: -1, message: [{ chatId: "m", role: "char", data: "OLD" }] }],
                },
            ],
        } as unknown as Database;
        // The chat is read-only to the app outside the chat module; this sink stands in for it.
        const chat = db.characters[0].chats[0] as unknown as { message: { data: string }[] };
        const chatRef = { chaId: "c", chatId: "chat" };
        const evaluator = createNodeCbsEvaluator(db, { selectedCharID: 0 });
        const parse = (text: string) => evaluator.risuChatParser(text, { chatID: 0, chatRef });
        const seen: RegexScriptEffect[] = [];
        const scripts = [
            script({ in: "X", out: "@@inject" }),
            script({ in: "Y", out: "{{lastmessage}}" }),
            script({ in: "{{lastmessage}}", out: "[seen:$&]", ableFlag: true, flag: "g<cbs>" }),
        ];
        const applied = run("XY", scripts, {
            chatID: 0,
            parse,
            applyEffect: (effect) => {
                seen.push(effect);
                if (effect.kind === "inject") {
                    chat.message[0].data = effect.text;
                }
            },
        });
        expect(applied.data).toBe("[seen:XY]");
        expect(chat.message[0].data).toBe("XY");
        expect(applied.effects).toEqual([{ kind: "inject", text: "XY" }]);
        expect(seen).toEqual(applied.effects);

        // Without the sink the effects are only collected; the chat keeps its text and later CBS reads it.
        chat.message[0].data = "OLD";
        const collected = run("XY", scripts, { chatID: 0, parse });
        expect(collected.data).toBe("[seen:OLD]");
        expect(collected.effects).toEqual([{ kind: "inject", text: "XY" }]);
        expect(chat.message[0].data).toBe("OLD");
    });

    it("a throwing sink skips the rest of that script only; the effect stays recorded", () => {
        const scripts = [
            script({ in: "X", out: "@@inject" }),
            script({ in: "A", out: "@@emo happy" }),
            script({ in: "Y", out: "y!" }),
        ];
        const result = run("XAY", scripts, {
            chatID: 0,
            applyEffect: (effect) => {
                if (effect.kind === "inject") {
                    throw new Error("message locked");
                }
            },
        });
        // The injected match is not removed (the removal follows the sink), the later scripts run.
        expect(result.data).toBe("XAy!");
        expect(result.effects).toEqual([
            { kind: "inject", text: "XAY" },
            { kind: "emotion", name: "happy" },
        ]);
        expect(console.error).toHaveBeenCalledTimes(1);
    });
});

describe("@@repeat_back", () => {
    const previous = () => "the previous reply ends here";

    it("appends the previous message's match in the requested position when the text has none", () => {
        const at = (variant: string) =>
            run("now", [script({ in: "ends here", out: `@@repeat_back ${variant}`.trim() })], {
                chatID: 1,
                repeatBackSource: previous,
            }).data;
        expect(at("")).toBe("nowends here");
        expect(at("end")).toBe("nowends here");
        expect(at("start")).toBe("ends herenow");
        expect(at("end_nl")).toBe("now\nends here");
        expect(at("start_nl")).toBe("ends here\nnow");
        expect(at("sideways")).toBe("now");
    });

    it("quirk: when the text already matches, the directive text replaces the match; nothing without a message index", () => {
        const scripts = [script({ in: "now", out: "@@repeat_back" })];
        expect(run("now", scripts, { chatID: 1, repeatBackSource: previous }).data).toBe("@@repeat_back");
        expect(run("x", [script({ in: "ends", out: "@@repeat_back" })], { repeatBackSource: previous }).data).toBe("x");
    });

    it("quirk: a previous message that does not match throws inside the script, which is skipped", () => {
        const scripts = [script({ in: "zzz", out: "@@repeat_back" }), script({ in: "now", out: "later" })];
        const result = run("now", scripts, { chatID: 1, repeatBackSource: previous });
        expect(result.data).toBe("later");
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(vi.mocked(console.error).mock.calls[0][0]).toBeInstanceOf(TypeError);
    });

    it("skips the script when the source throws (no previous message to read)", () => {
        const result = run("now", [script({ in: "zzz", out: "@@repeat_back" })], {
            chatID: 0,
            repeatBackSource: () => {
                throw new Error("no chat");
            },
        });
        expect(result.data).toBe("now");
        expect(console.error).toHaveBeenCalledTimes(1);
    });
});

describe("the cache helpers", () => {
    it("keys a run by its text, mode, chat, and the scripts of the mode with <cbs> patterns expanded", () => {
        const scripts = [
            script({ in: "{{char}}", out: "x", ableFlag: true, flag: "g<cbs>" }),
            script({ in: "{{char}}", out: "y", type: "editinput" }),
        ];
        const parse = (text: string) => text.replaceAll("{{char}}", "Risu");
        const key = regexScriptCacheKey(scripts, "text", "editoutput", 0, "c/chat", parse);
        expect(key).toBe("text|||editoutput|||c/chat|||Risu|||x0|||g<cbs>|||1");
        expect(regexScriptCacheKey(scripts, "text", "editoutput", 0, "c/other", parse)).not.toBe(key);
        expect(regexScriptCacheKey(scripts, "text", "editoutput", 1, "c/chat", parse)).not.toBe(key);
        expect(regexScriptCacheKey(scripts, "text", "editinput", 0, "c/chat", parse)).toBe(
            "text|||editinput|||c/chat|||{{char}}|||y0||||||0",
        );
    });

    it("keeps the most recent entries up to its limit and resets", () => {
        const cache = createScriptCache(2);
        cache.set("a", "1");
        cache.set("b", "2");
        cache.set("c", "3");
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe("2");
        expect(cache.get("c")).toBe("3");
        cache.reset();
        expect(cache.get("b")).toBeUndefined();
    });
});
