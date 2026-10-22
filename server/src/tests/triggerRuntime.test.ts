// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { calcString } from "../../../shared/cbs/calc.ts";
import type { Chat, Message, character, groupChat } from "../../../shared/database.ts";
import type { GenerationQuestion } from "../../../shared/jobs.ts";
import type { RequestArgs } from "../../../shared/llm/request.ts";
import type { triggerEffect, triggerscript } from "../../../shared/triggers.ts";
import { type LuaBindingServices, LuaJobFatalError, type LuaWorkingCopy } from "../lua/bindings.ts";
import { createCommandExecutor } from "../prompt/commands.ts";
import {
    createTriggerRuntime,
    displayAllowList,
    hasRequestTriggers,
    MAX_TRIGGER_EFFECTS,
    parseKeyValue,
    requestAllowList,
    type TriggerArg,
    type TriggerHost,
    type TriggerMode,
} from "../prompt/triggers.ts";
import { runRegexOp } from "../scripts/worker.ts";
import type { HostContext } from "../scripts/workerPool.ts";

// The server trigger runtime (`server/src/prompt/triggers.ts`), the port of the client's
// `runTrigger`, over controlled job services, the real regex engine (`runRegexOp`, which the worker
// runs), and the real command executor for the `/trigger` route. Expected values are derived from
// the client's effect switch (`src/ts/process/triggers.ts`), not from the port: variables and their
// precedence, the immediate `scriptstate`/note writes (none in display runs), control flow, the
// manual-name and mode filters, the allowlists and the bare returns, the array, dictionary, string,
// and calculator effects with the client's fallback values, the evaluation order of an output name
// against its value, the six regex sites with the client's error behavior and its replacer quirks,
// the chat, character, persona, and UI effects, `triggerlua` on the working copy with the
// character-patch listener, recursion (the depth rule, the shared effect limit on both routes
// without a stack overflow), the returned temporary variables, and the cancellation fences (an abort
// or a fatal failure never becomes an effect's fallback value, nor a later service call).

const m = (id: string, data: string, role: "user" | "char" = "user"): Message => ({ role, data, chatId: id });
const v = (value: string) => ({ value, valueType: "value" });
const ef = (type: string, fields: Record<string, unknown> = {}, indent = 0) =>
    ({ type, indent, ...fields }) as unknown as triggerEffect;
const setVar = (name: string, operator: string, value: string, indent = 0) =>
    ef("v2SetVar", { var: name, operator, ...v(value) }, indent);
const say = (role: "user" | "char", value: string, indent = 0) => ef("v2Impersonate", { role, ...v(value) }, indent);
const out = (type: string, outputVar: string, fields: Record<string, unknown> = {}, indent = 0) =>
    ef(type, { outputVar, ...fields }, indent);
const trig = (effect: triggerEffect[], extra: Partial<triggerscript> = {}): triggerscript =>
    ({ comment: "go", type: "manual", conditions: [], effect, ...extra }) as triggerscript;
const lua = (code: string, extra: Partial<triggerscript> = {}) =>
    trig([ef("triggerlua", { code })], { comment: "lua", ...extra });

type Harness = ReturnType<typeof harness>;

/**
 * The runtime over fake job services: a live chat the immediate writes land on (CBS reads it, as the
 * job's CBS reads the stored chat), a stored character the patches land on, recorded notices,
 * questions, requests, images, Lua runs, and commands, a trace of every CBS parse and token count,
 * and a controller for the run's abort.
 */
function harness(options: {
    triggers: triggerscript[];
    chat?: Partial<Chat>;
    char?: Partial<character>;
    moduleTriggers?: triggerscript[];
    templateDefaultVariables?: string;
    selectedPersonaPrompt?: string;
    effectivePersonaId?: string | null;
    cbs?: Record<string, string>;
}) {
    const controller = new AbortController();
    const trace: string[] = [];
    const notices: { kind: string; payload: Record<string, unknown> }[] = [];
    const questions: GenerationQuestion[] = [];
    const answers: unknown[] = [];
    const metaWrites: Record<string, unknown>[] = [];
    /** The store's side of a variable setter: one key per change, as the job's coalescer takes it. */
    const varWrites: [string, string][] = [];
    const chatOps: unknown[] = [];
    const characterPatches: Record<string, unknown>[] = [];
    const personaWrites: [string, string][] = [];
    const requests: { arg: RequestArgs; mode: string }[] = [];
    const images: { prompt: string; negative: string; characterId: string }[] = [];
    const similarities: { source: string; values: string[] }[] = [];
    const luaRuns: { code: string; mode: string; lowLevelAccess: boolean; working: LuaWorkingCopy }[] = [];
    const commands: string[] = [];
    const listeners = new Set<(characterId: string, patch: Record<string, unknown>) => void>();
    const state = {
        chatGone: false,
        characterGone: false,
        personaGone: false,
        fatal: null as LuaJobFatalError | null,
        requestAnswer: { type: "success", result: "llm said" } as unknown,
        imageAnswer: "inlay-1" as string | null,
        /** The similarity service's ranking; the default reverses the values (an order the input does not have). */
        similarityAnswer: null as null | ((source: string, values: string[]) => string[]),
        tokens: async (text: string) => text.length,
        lua: null as null | ((code: string, working: LuaWorkingCopy) => Promise<{ stopSending: boolean }>),
        command: null as null | ((line: string) => Promise<unknown>),
    };
    const live: Chat = {
        id: "k",
        name: "K",
        message: [m("m1", "greeting", "char"), m("m2", "hi there")],
        scriptstate: {},
        fmIndex: -1,
        ...options.chat,
    } as Chat;
    const stored: character = {
        chaId: "c",
        type: "character",
        name: "C",
        desc: "d0",
        firstMessage: "first",
        alternateGreetings: ["alt0", "alt1"],
        defaultVariables: "dv=7\nbad\n=x",
        lowLevelAccess: true,
        replaceGlobalNote: "",
        globalLore: [],
        triggerscript: options.triggers,
        ...options.char,
    } as unknown as character;
    /** A stand-in CBS: `{{getvar::x}}` reads the live chat (the job's stored chat), `{{trigger_id}}` the job's. */
    const parse = (text: string) => {
        trace.push(`parse:${text}`);
        return text
            .replace(/\{\{getvar::([^}]+)\}\}/g, (_, key: string) => {
                const value = live.scriptstate?.[`$${key}`];
                return value === undefined || value === null ? "null" : String(value);
            })
            .replace(/\{\{trigger_id\}\}/g, "tid")
            .replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => options.cbs?.[key] ?? whole);
    };
    const latch = (error: unknown) => {
        state.fatal ??= error instanceof LuaJobFatalError ? error : new LuaJobFatalError(String(error));
        return state.fatal;
    };
    const fence = (ctx?: HostContext) => {
        if (state.fatal) {
            throw state.fatal;
        }
        if (controller.signal.aborted || ctx?.signal.aborted) {
            throw latch(new LuaJobFatalError("request aborted"));
        }
    };
    const services: LuaBindingServices = {
        fence,
        latch,
        liveChat: () => live,
        chatExists: () => !state.chatGone,
        refresh: () => !state.chatGone,
        writeChat(build, ctx) {
            fence(ctx);
            if (state.chatGone) {
                return;
            }
            const ops = build(live);
            for (const op of ops ?? []) {
                if (op.op === "meta") {
                    Object.assign(live, structuredClone(op.set));
                    metaWrites.push(op.set ?? {});
                } else {
                    chatOps.push(op);
                }
            }
        },
        setChatVar(key, value, ctx) {
            fence(ctx);
            if (state.chatGone || live.scriptstate?.[`$${key}`] === value) {
                return false;
            }
            live.scriptstate = { ...live.scriptstate, [`$${key}`]: value };
            varWrites.push([key, value]);
            return true;
        },
        getChatVar: (key) => String(live.scriptstate?.[`$${key}`] ?? "null"),
        patchCharacter(patch, ctx) {
            fence(ctx);
            if (state.characterGone) {
                return false;
            }
            characterPatches.push(structuredClone(patch));
            Object.assign(stored, structuredClone(patch));
            return true;
        },
        patchPersonaPrompt(personaId, value, ctx) {
            fence(ctx);
            if (state.personaGone) {
                return false;
            }
            personaWrites.push([personaId, value]);
            return true;
        },
        async ask(question, ctx) {
            fence(ctx);
            questions.push(question);
            const answer = answers.shift();
            return typeof answer === "function" ? await (answer as () => Promise<unknown>)() : answer;
        },
        notice: (notice) => notices.push(notice as { kind: string; payload: Record<string, unknown> }),
        async request(arg, mode, ctx) {
            fence(ctx);
            requests.push({ arg, mode });
            return state.requestAnswer as never;
        },
        collectStreamText: async () => "",
        async generateImageInlay(prompt, negative, characterId, ctx) {
            fence(ctx);
            images.push({ prompt, negative, characterId });
            return state.imageAnswer;
        },
        tokenize: async (text) => {
            trace.push(`tokens:${text}`);
            return state.tokens(text);
        },
        activateLore: async () => ({ actives: [] }) as never,
        parse,
        calc: (text) => calcString(text, { getChatVar: () => "0", getGlobalChatVar: () => "0" }) as number,
        // The harness has no embeddings service: the production refusal of a job without one.
        embeddings: () => {
            throw new Error("The embeddings service is not available");
        },
        async similarity(source, values, ctx) {
            fence(ctx);
            similarities.push({ source, values: [...values] });
            return state.similarityAnswer ? state.similarityAnswer(source, values) : [...values].reverse();
        },
    };
    const ctx: HostContext = {
        identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
        access: "lowLevel",
        signal: controller.signal,
        regex: async (op) => {
            trace.push(`regex:${op.op}:${op.pattern}`);
            return runRegexOp(op);
        },
    };
    const effects = { count: 0 };
    const host: TriggerHost = {
        services,
        chatRef: { chaId: "c", chatId: "k" },
        ctx,
        observeCharacterPatches(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async runLua(code, runOptions) {
            luaRuns.push({ code, ...runOptions });
            return state.lua ? await state.lua(code, runOptions.working) : { stopSending: false };
        },
        moduleTriggers: () => options.moduleTriggers ?? [],
        templateDefaultVariables: options.templateDefaultVariables ?? "tv=9",
        selectedPersonaPrompt: options.selectedPersonaPrompt ?? "selected persona",
        effectivePersonaId: options.effectivePersonaId === undefined ? "u" : options.effectivePersonaId,
        async runCommand(line) {
            commands.push(line);
            return state.command ? await state.command(line) : undefined;
        },
        effects,
    };
    const runtime = createTriggerRuntime(host);
    /** A Lua setter wrote the run's character: the bindings notify every running trigger. */
    const luaPatched = (patch: Record<string, unknown>) => {
        Object.assign(stored, patch);
        for (const listener of [...listeners]) {
            listener("c", patch);
        }
    };
    const run = (mode: TriggerMode = "manual", arg: Partial<TriggerArg> = {}) =>
        runtime.runTrigger(structuredClone(stored), mode, {
            chat: structuredClone(live),
            ...(mode === "manual" ? { manualName: "go" } : {}),
            ...arg,
        });
    return {
        runtime,
        run,
        live,
        stored,
        controller,
        trace,
        notices,
        questions,
        answers,
        metaWrites,
        varWrites,
        chatOps,
        characterPatches,
        personaWrites,
        requests,
        images,
        similarities,
        luaRuns,
        commands,
        effects,
        state,
        services,
        ctx,
        luaPatched,
        listeners,
    };
}

const texts = (chat: Chat | undefined) => chat?.message.map((message) => `${message.role}:${message.data}`) ?? [];
const notice = (h: Harness, kind: string) => h.notices.filter((entry) => entry.kind === kind);

afterEach(() => {
    vi.restoreAllMocks();
});

describe("variables", () => {
    it("applies every operator on the working copy's scriptstate, hands the store one key per change, and CBS reads the write", async () => {
        const h = harness({
            triggers: [
                trig([
                    setVar("x", "=", "5"),
                    setVar("x", "+=", "2"),
                    setVar("y", "-=", "3"), // "null" → 0 - 3
                    setVar("x", "*=", "3"),
                    setVar("x", "/=", "7"),
                    setVar("x", "%=", "2"),
                    setVar("x", "=", "{{getvar::x}}"), // no change: no write
                    say("char", "x={{getvar::x}} y={{getvar::y}}"),
                ]),
            ],
        });
        const result = await h.run();
        expect(result?.chat.scriptstate).toEqual({ $x: "1", $y: "-3" });
        expect(texts(result?.chat).at(-1)).toBe("char:x=1 y=-3");
        expect(h.varWrites).toEqual([
            ["x", "5"],
            ["x", "7"],
            ["y", "-3"],
            ["x", "21"],
            ["x", "3"],
            ["x", "1"],
        ]);
        expect(h.metaWrites).toEqual([]);
        expect(notice(h, "updateGUI")).toHaveLength(1);
    });

    it("reads a local, then the scriptstate, then the character's and the template's defaults, else \"null\"", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2DeclareLocalVar", { var: "dv", ...v("local") }),
                    out("v2ConcatString", "o1", {
                        source1: "dv",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                    ef("v2EndIndent", {}, 0),
                    out("v2ConcatString", "o2", {
                        source1: "dv",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                    out("v2ConcatString", "o3", {
                        source1: "tv",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                    out("v2ConcatString", "o4", {
                        source1: "zz",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                    out("v2ConcatString", "o5", {
                        source1: "s",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                ]),
            ],
            chat: { scriptstate: { $s: "stored" } },
        });
        const result = await h.run();
        expect(result?.chat.scriptstate).toMatchObject({
            $o1: "local",
            $o2: "7",
            $o3: "9",
            $o4: "null",
            $o5: "stored",
        });
        // `parseKeyValue` keeps only `key=value` lines.
        expect(parseKeyValue("dv=7\nbad\n=x\n")).toEqual([["dv", "7"]]);
        expect(parseKeyValue(undefined)).toEqual([]);
    });

    it("scopes a local to its indent, writes a set of it to the local and not the chat, and clears it at the indent's end", async () => {
        const h = harness({
            triggers: [
                trig([
                    setVar("g", "=", "1"),
                    ef("v2If", { condition: "=", source: "g", target: "1", targetType: "value" }),
                    ef("v2DeclareLocalVar", { var: "l", ...v("a") }, 1),
                    setVar("l", "=", "b", 1),
                    say("char", "in {{getvar::l}}", 1),
                    out(
                        "v2ConcatString",
                        "inner",
                        { source1: "l", source1Type: "var", source2: "", source2Type: "value" },
                        1,
                    ),
                    ef("v2EndIndent", {}, 1),
                    out("v2ConcatString", "after", {
                        source1: "l",
                        source1Type: "var",
                        source2: "",
                        source2Type: "value",
                    }),
                ]),
            ],
        });
        const result = await h.run();
        // The local never reaches the chat: CBS (the stored chat) sees "null"; the native read sees it.
        expect(texts(result?.chat).at(-1)).toBe("char:in null");
        expect(result?.chat.scriptstate).toEqual({ $g: "1", $inner: "b", $after: "null" });
    });

    it("in display mode writes temporary variables only, reads them after the defaults, and persists nothing", async () => {
        // A manual run with `displayMode` reaches the writers' guards (a display run's allowlist
        // would filter them first); the guards are the same.
        const h = harness({
            triggers: [
                trig([
                    setVar("x", "=", "1"),
                    setVar("dv", "=", "2"),
                    out("v2ConcatString", "o", { source1: "x", source1Type: "var", source2: "dv", source2Type: "var" }),
                    ef("v2SetAuthorNote", v("n")),
                    ef("v2SetCharacterDesc", v("d")),
                    ef("v2SetPersonaDesc", v("p")),
                    ef("v2CreateLorebook", {
                        name: "L",
                        nameType: "value",
                        key: "",
                        keyType: "value",
                        content: "",
                        contentType: "value",
                        insertOrder: "",
                        insertOrderType: "value",
                    }),
                ]),
            ],
        });
        const tempVars: Record<string, string> = {};
        const result = await h.run("manual", { displayMode: true, tempVars });
        // The defaults still win over a temporary value: `dv` reads the character's "7".
        expect(tempVars).toEqual({ x: "1", dv: "2", o: "17" });
        expect(result?.tempVars).toBe(tempVars);
        expect(result?.chat.note).toBe("n");
        expect(h.metaWrites).toEqual([]);
        expect(h.varWrites).toEqual([]);
        expect(h.characterPatches).toEqual([]);
        expect(h.personaWrites).toEqual([]);
        expect(notice(h, "updateGUI")).toEqual([]);
    });

    it("owns and returns the temporary-variable map when the caller gives none", async () => {
        const h = harness({ triggers: [trig([setVar("x", "=", "yes")], { type: "display" })] });
        const result = await h.run("display", { displayMode: true });
        expect(result?.tempVars).toEqual({ x: "yes" });
    });

    it("warns and goes on when the chat is gone, writing nothing", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const h = harness({ triggers: [trig([setVar("x", "=", "1"), ef("v2SetAuthorNote", v("n"))])] });
        h.state.chatGone = true;
        const result = await h.run();
        expect(result?.chat.scriptstate).toEqual({ $x: "1" });
        expect(result?.chat.note).toBe("n");
        expect(h.metaWrites).toEqual([]);
        expect(h.varWrites).toEqual([]);
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
            expect.stringMatching(/chat is gone/),
            expect.stringMatching(/chat is gone/),
        ]);
    });
});

describe("control flow", () => {
    const branch = (condition: string, source: string, target: string, targetType = "value") => [
        ef("v2If", { condition, source, target, targetType }),
        say("char", "yes", 1),
        ef("v2EndIndent", {}, 1),
        ef("v2Else"),
        say("char", "no", 1),
        ef("v2EndIndent", {}, 1),
    ];

    it.each([
        ["=", "1.0", "1", "yes"],
        ["=", "a", "a", "yes"],
        ["!=", "1.0", "1", "no"],
        [">", "2", "1", "yes"],
        ["<", "2", "1", "no"],
        [">=", "1", "1", "yes"],
        ["<=", "2", "1", "no"],
        ["∈", "a", '["a","b"]', "yes"],
        ["∈", "a", "not json", "no"],
        ["∋", '["a"]', "a", "yes"],
        ["∉", "c", '["a"]', "yes"],
        ["∉", "a", "not json", "yes"],
        ["∌", '["a"]', "a", "no"],
        ["≒", "1.00001", "1", "yes"],
        ["≒", "Hello World", "helloworld", "yes"],
        ["≡", "1", "true", "yes"],
        ["≡", "0", "false", "yes"],
        ["≡", "x", "x", "yes"],
    ])("`%s` with source %j and target %j takes the %s branch", async (condition, source, target, branchTaken) => {
        const h = harness({
            triggers: [trig([setVar("s", "=", source), ...branch(condition, "s", target)])],
        });
        const result = await h.run();
        expect(texts(result?.chat).slice(2)).toEqual([`char:${branchTaken}`]);
    });

    it("reads a v2If source as a variable and a v2IfAdvanced source by its type", async () => {
        const h = harness({
            triggers: [
                trig([
                    setVar("s", "=", "7"),
                    ef("v2IfAdvanced", {
                        condition: "=",
                        source: "7",
                        sourceType: "value",
                        target: "s",
                        targetType: "var",
                    }),
                    say("char", "advanced", 1),
                    ef("v2EndIndent", {}, 1),
                ]),
            ],
        });
        expect(texts((await h.run())?.chat).slice(2)).toEqual(["char:advanced"]);
    });

    it("loops N times with the counter kept per trigger, breaks out of a loop, and stops the trigger", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2LoopNTimes", v("3")),
                    setVar("n", "+=", "1", 1),
                    ef("v2EndIndent", { endOfLoop: true }, 1),
                    ef("v2Loop"),
                    setVar("k", "+=", "1", 1),
                    ef("v2If", { condition: "=", source: "k", target: "2", targetType: "value" }, 1),
                    ef("v2BreakLoop", {}, 2),
                    ef("v2EndIndent", {}, 2),
                    ef("v2EndIndent", { endOfLoop: true }, 1),
                    say("char", "after loops"),
                    ef("v2StopTrigger"),
                    say("char", "never"),
                ]),
                trig([say("char", "second trigger")]),
            ],
        });
        const result = await h.run();
        expect(result?.chat.scriptstate).toEqual({ $n: "3", $k: "2" });
        expect(texts(result?.chat).slice(2)).toEqual(["char:after loops", "char:second trigger"]);
    });

    it("yields to the event loop every 100 loop iterations without losing count", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2LoopNTimes", v("250")),
                    setVar("n", "+=", "1", 1),
                    ef("v2EndIndent", { endOfLoop: true }, 1),
                ]),
            ],
        });
        expect((await h.run())?.chat.scriptstate).toEqual({ $n: "250" });
    });
});

describe("which triggers run", () => {
    it("runs the triggers named by the manual name, every Lua trigger with that name as its mode, and skips legacy conditional ones", async () => {
        const h = harness({
            triggers: [
                trig([say("char", "named")]),
                trig([say("char", "other")], { comment: "other" }),
                trig([say("char", "conditional")], { conditions: [{ type: "var" }] as never }),
                lua("code"),
                lua("module code", { comment: "mod" }),
            ],
            moduleTriggers: [trig([say("char", "from module")], { lowLevelAccess: false })],
        });
        const result = await h.run();
        // A module trigger of that name runs too, after the character's.
        expect(texts(result?.chat).slice(2)).toEqual(["char:named", "char:from module"]);
        expect(h.luaRuns.map((run) => [run.code, run.mode, run.lowLevelAccess])).toEqual([
            ["code", "go", true],
            ["module code", "go", true],
        ]);
    });

    it("without a manual name runs the triggers of the mode, Lua with that mode, and a module trigger with its module's access", async () => {
        const h = harness({
            triggers: [trig([say("char", "manual")]), trig([say("char", "start")], { type: "start" }), lua("code")],
            moduleTriggers: [lua("module", { lowLevelAccess: false })],
        });
        const result = await h.run("start", { manualName: undefined });
        expect(texts(result?.chat).slice(2)).toEqual(["char:start"]);
        expect(h.luaRuns.map((run) => [run.mode, run.lowLevelAccess])).toEqual([
            ["start", true],
            ["start", false],
        ]);
    });

    it('gives Lua the mode "manual" when a manual run names nothing, and the empty name as it is', async () => {
        const h = harness({ triggers: [lua("code")] });
        await h.run("manual", { manualName: undefined });
        await h.run("manual", { manualName: "" });
        expect(h.luaRuns.map((run) => run.mode)).toEqual(["manual", ""]);
    });

    it("returns null when the character and its modules have no trigger", async () => {
        const h = harness({ triggers: [] });
        expect(await h.run()).toBeNull();
        expect(h.effects.count).toBe(0);
    });
});

describe("allowlists and bare returns", () => {
    it("skips what the display and request allowlists exclude and keeps the client's lists", async () => {
        expect(displayAllowList).toContain("v2SetDisplayState");
        expect(displayAllowList).not.toContain("v2RunTrigger");
        expect(requestAllowList).toContain("v2GetRequestStateLength");
        expect(requestAllowList).not.toContain("v2Command");
        const h = harness({
            triggers: [
                trig(
                    [
                        setVar("x", "=", "1"),
                        say("char", "no"),
                        ef("v2Command", v("/echo no")),
                        ef("v2RunTrigger", { target: "go" }),
                    ],
                    {
                        type: "display",
                    },
                ),
            ],
        });
        const result = await h.run("display", { displayMode: true });
        expect(texts(result?.chat)).toHaveLength(2);
        expect(h.commands).toEqual([]);
        expect(result?.tempVars).toEqual({ x: "1" });
    });

    it.each([
        ["v2ShowAlert in a display-mode run", trig([ef("v2ShowAlert", v("x"))]), "manual", { displayMode: true }],
        [
            "v2GetAlertInput in a display-mode run",
            trig([out("v2GetAlertInput", "o", { display: "q", displayType: "value" })]),
            "manual",
            { displayMode: true },
        ],
        [
            "v2GetAlertSelect in a display-mode run",
            trig([out("v2GetAlertSelect", "o", { display: "q", displayType: "value", ...v("a|b") })]),
            "manual",
            { displayMode: true },
        ],
        ["v2GetDisplayState outside display mode", trig([out("v2GetDisplayState", "o")]), "manual", {}],
        [
            "v2SetRequestState outside display mode",
            trig([ef("v2SetRequestState", { index: "0", indexType: "value", ...v("x") })]),
            "manual",
            {},
        ],
        ["a bracketed v2MakeArrayVar name", trig([ef("v2MakeArrayVar", { var: "[x]" })]), "manual", {}],
        ["a braced v2MakeDictVar name", trig([ef("v2MakeDictVar", { var: "{x}" })]), "manual", {}],
        ["a braced v2ClearDict name", trig([ef("v2ClearDict", { var: "{x}" })]), "manual", {}],
    ] as [string, triggerscript, TriggerMode, Partial<TriggerArg>][])(
        "returns no result (undefined) for %s, as the client's bare return",
        async (_name, trigger, mode, arg) => {
            // (A display run's allowlist would filter the UI effects before their guard; a manual
            // run with `displayMode` reaches it.)
            const h = harness({ triggers: [trigger] });
            expect(await h.run(mode, arg)).toBeUndefined();
            expect(h.notices).toEqual([]);
            expect(h.questions).toEqual([]);
        },
    );

    it("skips v2ImgGen, v2RunLLM, v2CheckSimilarity, and v2SendAIprompt without lowLevelAccess", async () => {
        const h = harness({
            triggers: [
                trig([
                    out("v2ImgGen", "i", { ...v("p"), negValue: "", negValueType: "value" }),
                    out("v2RunLLM", "l", { ...v("prompt"), model: "model" }),
                    out("v2CheckSimilarity", "s", { source: "a", sourceType: "value", ...v("b") }),
                    ef("v2SendAIprompt"),
                ]),
            ],
            char: { lowLevelAccess: false },
        });
        const result = await h.run();
        expect(result?.chat.scriptstate).toEqual({});
        expect(result?.sendAIprompt).toBe(false);
        expect(h.images).toEqual([]);
        expect(h.requests).toEqual([]);
    });
});

describe("arrays, dictionaries, strings, and the calculator", () => {
    it("runs the array effects and writes the client's fallback values on invalid JSON", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2MakeArrayVar", { var: "a" }),
                    ef("v2PushArrayVar", { var: "a", ...v("x") }),
                    ef("v2PushArrayVar", { var: "a", ...v("y") }),
                    ef("v2UnshiftArrayVar", { var: "a", ...v("w") }),
                    ef("v2SpliceArrayVar", { var: "a", start: "1", startType: "value", item: "s", itemType: "value" }),
                    ef("v2SetArrayVar", { var: "a", index: "0", indexType: "value", ...v("W") }),
                    ef("v2SetArrayVar", { var: "a", index: "nan", indexType: "value", ...v("Z") }),
                    out("v2GetArrayVarLength", "len", { var: "a" }),
                    out("v2GetArrayVar", "at1", { var: "a", index: "1", indexType: "value" }),
                    out("v2GetArrayVar", "at9", { var: "a", index: "9", indexType: "value" }),
                    out("v2GetIndexOfValueInArrayVar", "idx", { var: "a", ...v("y") }),
                    out("v2SliceArrayVar", "sl", {
                        var: "a",
                        start: "1",
                        startType: "value",
                        end: "3",
                        endType: "value",
                    }),
                    out("v2JoinArrayVar", "joined", {
                        var: "a",
                        varType: "var",
                        delimiter: "-",
                        delimiterType: "value",
                    }),
                    out("v2PopArrayVar", "popped", { var: "a" }),
                    out("v2ShiftArrayVar", "shifted", { var: "a" }),
                    ef("v2RemoveIndexFromArrayVar", { var: "a", index: "0", indexType: "value" }),
                    // The fallbacks: an invalid array.
                    setVar("bad", "=", "not json"),
                    out("v2GetArrayVarLength", "badLen", { var: "bad" }),
                    out("v2GetArrayVar", "badAt", { var: "bad", index: "0", indexType: "value" }),
                    out("v2GetIndexOfValueInArrayVar", "badIdx", { var: "bad", ...v("y") }),
                    out("v2SliceArrayVar", "badSl", {
                        var: "bad",
                        start: "0",
                        startType: "value",
                        end: "1",
                        endType: "value",
                    }),
                    out("v2JoinArrayVar", "badJoin", {
                        var: "bad",
                        varType: "var",
                        delimiter: "-",
                        delimiterType: "value",
                    }),
                    out("v2PopArrayVar", "badPop", { var: "bad" }),
                    setVar("bad2", "=", "not json"),
                    ef("v2PushArrayVar", { var: "bad2", ...v("x") }),
                ]),
            ],
        });
        const s = (await h.run())?.chat.scriptstate ?? {};
        expect(s).toMatchObject({
            $len: "4", // ["W","s","x","y"]
            $at1: "s",
            $at9: "null",
            $idx: "3",
            $sl: '["s","x"]',
            $joined: "W-s-x-y",
            $popped: "y",
            $shifted: "W",
            $a: '["x"]',
            $badLen: "0",
            $badAt: "null",
            $badIdx: "-1",
            $badSl: "[]",
            $badJoin: "",
            $badPop: "null",
            // The pop fallback resets the variable; the push fallback does too.
            $bad: "[]",
            $bad2: "[]",
        });
    });

    it("runs the dictionary effects with the client's fallbacks, including a set on a non-dictionary creating one", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2MakeDictVar", { var: "d" }),
                    ef("v2SetDictVar", { var: "d", varType: "var", key: "k", keyType: "value", ...v("1") }),
                    ef("v2SetDictVar", { var: "d", varType: "var", key: "j", keyType: "value", ...v("2") }),
                    ef("v2SetDictVar", { var: "ignored", varType: "value", key: "k", keyType: "value", ...v("1") }),
                    out("v2GetDictVar", "g", { var: "d", varType: "var", key: "k", keyType: "value" }),
                    out("v2GetDictVar", "gm", { var: "d", varType: "var", key: "zz", keyType: "value" }),
                    out("v2HasDictKey", "h", { var: "d", varType: "var", key: "j", keyType: "value" }),
                    out("v2GetDictSize", "n", { var: "d", varType: "var" }),
                    out("v2GetDictKeys", "keys", { var: "d", varType: "var" }),
                    out("v2GetDictValues", "vals", { var: "d", varType: "var" }),
                    ef("v2DeleteDictKey", { var: "d", varType: "var", key: "k", keyType: "value" }),
                    setVar("bad", "=", "oops"),
                    ef("v2SetDictVar", { var: "bad", varType: "var", key: "k", keyType: "value", ...v("v") }),
                    setVar("bad2", "=", "oops"),
                    out("v2GetDictVar", "bg", { var: "bad2", varType: "var", key: "k", keyType: "value" }),
                    out("v2HasDictKey", "bh", { var: "bad2", varType: "var", key: "k", keyType: "value" }),
                    out("v2GetDictSize", "bn", { var: "bad2", varType: "var" }),
                    out("v2GetDictKeys", "bk", { var: "bad2", varType: "var" }),
                    ef("v2DeleteDictKey", { var: "bad2", varType: "var", key: "k", keyType: "value" }),
                    ef("v2ClearDict", { var: "d" }),
                ]),
            ],
        });
        const s = (await h.run())?.chat.scriptstate ?? {};
        expect(s).toMatchObject({
            $g: "1",
            $gm: "null",
            $h: "1",
            $n: "2",
            $keys: '["k","j"]',
            $vals: '["1","2"]',
            $bad: '{"k":"v"}',
            $bg: "null",
            $bh: "0",
            $bn: "0",
            $bk: "[]",
            $bad2: "{}",
            $d: "{}",
        });
        expect(s.$ignored).toBeUndefined();
    });

    it("runs the string effects and the calculator with `$var` substitution (an unparsable variable counts 0)", async () => {
        const h = harness({
            triggers: [
                trig([
                    setVar("s", "=", "Hello World"),
                    out("v2GetCharAt", "c1", { source: "s", sourceType: "var", index: "1", indexType: "value" }),
                    out("v2GetCharAt", "c9", { source: "s", sourceType: "var", index: "99", indexType: "value" }),
                    out("v2GetCharCount", "n", { source: "s", sourceType: "var" }),
                    out("v2ToLowerCase", "lo", { source: "s", sourceType: "var" }),
                    out("v2ToUpperCase", "up", { source: "s", sourceType: "var" }),
                    out("v2SetCharAt", "set", {
                        source: "s",
                        sourceType: "var",
                        index: "0",
                        indexType: "value",
                        ...v("J"),
                    }),
                    out("v2SplitString", "sp", {
                        source: "s",
                        sourceType: "var",
                        delimiter: " ",
                        delimiterType: "value",
                    }),
                    out("v2ConcatString", "cat", {
                        source1: "a",
                        source1Type: "value",
                        source2: "s",
                        source2Type: "var",
                    }),
                    setVar("x", "=", "4"),
                    setVar("w", "=", "word"),
                    out("v2Calculate", "calc", { expression: "($x + 2) * 3 - $w", expressionType: "value" }),
                    out("v2Calculate", "calcBad", { expression: "(", expressionType: "value" }),
                ]),
            ],
        });
        const s = (await h.run())?.chat.scriptstate ?? {};
        expect(s).toMatchObject({
            $c1: "e",
            $c9: "null",
            $n: "11",
            $lo: "hello world",
            $up: "HELLO WORLD",
            $set: "Jello World",
            $sp: '["Hello","World"]',
            $cat: "aHello World",
            $calc: "18",
        });
        expect(["0", "NaN"]).toContain(s.$calcBad);
    });

    it("evaluates an output name against its value in the client's order (name before a throwing access, and before an awaited count)", async () => {
        const h = harness({
            triggers: [
                trig([out("v2GetArrayVarLength", "out", { var: "arr" }), out("v2Tokenize", "tout", { ...v("text") })]),
            ],
            chat: { scriptstate: { $arr: "null" } },
        });
        await h.run();
        expect(h.trace).toEqual([
            // `setVar(parse(outputVar), JSON.parse(getVar(parse(var))).length)`: the name, then the throw, then the fallback's name again.
            "parse:arr",
            "parse:out",
            "parse:out",
            // `setVar(parse(outputVar), (await tokenize(parse(value))).toString())`: both names before the count.
            "parse:text",
            "parse:tout",
            "tokens:text",
        ]);
    });
});

describe("the regex sites", () => {
    it("v2ExtractRegex substitutes the groups, `$&`, and `$$`, empties them without a match, and throws on an invalid pattern", async () => {
        const extract = (regex: string, result: string, outputVar: string, value = "abc123") =>
            out("v2ExtractRegex", outputVar, {
                ...v(value),
                regex,
                regexType: "value",
                flags: "i",
                flagsType: "value",
                result,
                resultType: "value",
            });
        const h = harness({
            triggers: [
                trig([extract("([A-Z]+)(\\d+)", "$2-$1 [$&] $$ $9", "hit"), extract("zzz", "$1 [$&] $$", "miss")]),
            ],
        });
        const s = (await h.run())?.chat.scriptstate;
        expect(s).toEqual({ $hit: "123-abc [abc123] $ ", $miss: " [] $" });
        const bad = harness({ triggers: [trig([extract("(", "", "o")])] });
        await expect(bad.run()).rejects.toThrow(/Invalid regular expression|Unterminated group/);
    });

    it("v2SplitString splits by a `/pattern/flags` or a bare regex, keeping captured separators, and falls back to [source] on an invalid one", async () => {
        const split = (delimiter: string, outputVar: string) =>
            out("v2SplitString", outputVar, {
                source: "a1b22c",
                sourceType: "value",
                delimiter,
                delimiterType: "regex",
            });
        const h = harness({
            triggers: [trig([split("/\\d+/g", "slashed"), split("(\\d)", "captured"), split("(", "bad")])],
        });
        const s = (await h.run())?.chat.scriptstate;
        expect(s).toEqual({ $slashed: '["a","b","c"]', $captured: '["a","1","b","2","","2","c"]', $bad: '["a1b22c"]' });
    });

    it('v2QuickSearchChat tests the last `depth` messages strictly, loosely, or by regex (an invalid one throws), and answers "0" for a NaN depth', async () => {
        const search = (condition: string, value: string, outputVar: string, depth = "2") =>
            out("v2QuickSearchChat", outputVar, { ...v(value), depth, depthType: "value", condition });
        const h = harness({
            triggers: [
                trig([
                    search("strict", "there", "strict"),
                    search("strict", "ther", "strictPart"),
                    search("loose", "GREET", "loose"),
                    search("loose", "greet", "shallow", "1"),
                    search("regex", "^gre+ting hi", "regex"),
                    search("regex", "x", "nan", "nope"),
                ]),
            ],
        });
        expect((await h.run())?.chat.scriptstate).toEqual({
            $strict: "1",
            $strictPart: "0",
            $loose: "1",
            $shallow: "0",
            $regex: "1",
            $nan: "0",
        });
        const bad = harness({ triggers: [trig([search("regex", "(", "o")])] });
        await expect(bad.run()).rejects.toThrow();
    });

    it("v2GetLorebookByName matches comments case-insensitively and compiles the pattern even with no entry, so an invalid one throws", async () => {
        const lore = (comment: string) => ({
            key: "",
            comment,
            content: "c",
            mode: "normal",
            insertorder: 100,
            alwaysActive: false,
            secondkey: "",
            selective: false,
        });
        const h = harness({
            triggers: [trig([out("v2GetLorebookByName", "hits", { name: "^L", nameType: "value" })])],
            char: {
                globalLore: [
                    lore("lore one"),
                    lore("other"),
                    lore("Lore two"),
                    { ...lore("x"), comment: undefined } as never,
                ] as never,
            },
        });
        expect((await h.run())?.chat.scriptstate).toEqual({ $hits: "[0,2]" });
        const empty = harness({
            triggers: [trig([out("v2GetLorebookByName", "hits", { name: "(", nameType: "value" })])],
        });
        await expect(empty.run()).rejects.toThrow();
        expect(empty.trace.filter((entry) => entry.startsWith("regex:"))).toEqual(["regex:test:("]);
    });

    it('v2RegexTest answers "1"/"0" and "0" for an invalid pattern', async () => {
        const test = (regex: string, outputVar: string) =>
            out("v2RegexTest", outputVar, { ...v("Hello"), regex, regexType: "value", flags: "i", flagsType: "value" });
        const h = harness({ triggers: [trig([test("^h", "yes"), test("^x", "no"), test("(", "bad")])] });
        expect((await h.run())?.chat.scriptstate).toEqual({ $yes: "1", $no: "0", $bad: "0" });
    });

    describe("v2ReplaceString", () => {
        /** The client's replacer (`src/ts/process/triggers.ts` `v2ReplaceString`), the oracle for the worker-based port. */
        const clientReplace = (
            source: string,
            pattern: string,
            flags: string,
            resultFormat: string,
            replacement: string,
        ) =>
            source.replace(new RegExp(pattern, flags), (...args: unknown[]) => {
                const match = args[0] as string;
                const groups = args.slice(1, -2) as (string | number | undefined)[];
                const targetGroupMatch = resultFormat.match(/^\$(\d+)$/);
                if (targetGroupMatch) {
                    const targetIndex = Number(targetGroupMatch[1]);
                    if (targetIndex === 0) {
                        return replacement;
                    }
                    const targetGroup = groups[targetIndex - 1];
                    if (targetGroup) {
                        return match.replace(targetGroup as string, replacement);
                    }
                }
                return resultFormat
                    .replace(/\$[0-9]+/g, (placeholder) => {
                        const index = Number(placeholder.slice(1));
                        return index === 0 ? match : String(groups[index - 1] || "");
                    })
                    .replace(/\$&/g, match)
                    .replace(/\$\$/g, "$");
            });
        const replace = (
            fields: { source: string; regex: string; result: string; replacement: string; flags: string },
            outputVar = "o",
        ) =>
            out("v2ReplaceString", outputVar, {
                source: fields.source,
                sourceType: "value",
                regex: fields.regex,
                regexType: "value",
                result: fields.result,
                resultType: "value",
                replacement: fields.replacement,
                replacementType: "value",
                flags: fields.flags,
                flagsType: "value",
            });

        it.each([
            [
                "a global format replacement",
                { source: "a1b22c", regex: "(\\d+)", result: "[$1|$&|$0|$$]", replacement: "", flags: "g" },
            ],
            [
                "a non-global one (first match only)",
                { source: "a1b2", regex: "\\d", result: "#", replacement: "", flags: "" },
            ],
            [
                "`$0` as the format: the replacement replaces the match",
                { source: "a1b2", regex: "\\d", result: "$0", replacement: "X", flags: "g" },
            ],
            [
                "`$1` as the format: the replacement inside the match",
                { source: "key=val;k2=v2", regex: "(\\w+)=(\\w+)", result: "$2", replacement: "<v>", flags: "g" },
            ],
            [
                "`$1` naming an unmatched group: the format path",
                { source: "ab", regex: "(x)?(b)", result: "$1", replacement: "Z", flags: "g" },
            ],
            [
                "an unmatched capture as an empty string",
                { source: "ab", regex: "(x)?(b)", result: "[$1][$2]", replacement: "", flags: "g" },
            ],
            [
                "named groups: the match offset becomes the last group (the client's `slice(1, -2)`)",
                { source: "aXbX", regex: "(?<l>X)", result: "$1-$2", replacement: "", flags: "g" },
            ],
            [
                "named groups with `$2` as the format: the offset is replaced inside the match",
                { source: "12 and 12", regex: "(?<d>1)2", result: "$2", replacement: "Q", flags: "g" },
            ],
            ["a zero-width global match", { source: "abc", regex: "(?=b)", result: "^", replacement: "", flags: "g" }],
            ["a sticky non-global match", { source: "aab", regex: "a", result: "X", replacement: "", flags: "y" }],
            [
                "unicode and the `$$` escape",
                { source: "😀x😀", regex: "\\p{Emoji}", result: "$$$&", replacement: "", flags: "gu" },
            ],
        ])("reproduces the client's replacer for %s", async (_name, fields) => {
            const h = harness({ triggers: [trig([replace(fields)])] });
            const expected = clientReplace(
                fields.source,
                fields.regex,
                fields.flags,
                fields.result,
                fields.replacement,
            );
            expect((await h.run())?.chat.scriptstate).toEqual({ $o: expected });
        });

        it("falls back to the source on an invalid pattern, reading the source again", async () => {
            const h = harness({
                triggers: [trig([replace({ source: "src", regex: "(", result: "$1", replacement: "", flags: "" })])],
            });
            expect((await h.run())?.chat.scriptstate).toEqual({ $o: "src" });
            expect(h.trace.filter((entry) => entry === "parse:src")).toHaveLength(2);
        });
    });
});

describe("chat, character, persona, and UI effects", () => {
    it("edits the working copy: cut, modify, impersonate, and the message reads", async () => {
        const h = harness({
            triggers: [
                trig([
                    out("v2GetMessageCount", "count"),
                    out("v2GetLastMessage", "last"),
                    out("v2GetMessageAtIndex", "at0", { index: "0", indexType: "value" }),
                    out("v2GetMessageAtIndex", "at9", { index: "9", indexType: "value" }),
                    out("v2GetLastUserMessage", "lastUser"),
                    out("v2GetLastCharMessage", "lastChar"),
                    out("v2GetFirstMessage", "first"),
                    out("v2GetAuthorNote", "note0"),
                    say("user", "third"),
                    ef("v2ModifyChat", { index: "0", indexType: "value", ...v("edited") }),
                    ef("v2ModifyChat", { index: "9", indexType: "value", ...v("nowhere") }),
                    ef("v2CutChat", { start: "1", startType: "value", end: "nan", endType: "value" }),
                    ef("v2SetAuthorNote", v("note!")),
                    out("v2GetAuthorNote", "note1"),
                ]),
            ],
            chat: { fmIndex: 1 },
        });
        const result = await h.run();
        expect(texts(result?.chat)).toEqual(["user:hi there", "user:third"]);
        expect(result?.chat.scriptstate).toMatchObject({
            $count: "2",
            $last: "hi there",
            $at0: "greeting",
            $at9: "null",
            $lastUser: "hi there",
            $lastChar: "greeting",
            $first: "alt1",
            $note0: "",
            $note1: "note!",
        });
        expect(result?.chat.note).toBe("note!");
        expect(h.metaWrites).toEqual([{ note: "note!" }]);
        // The stored chat is untouched by the copy's edits: only the immediate writes landed.
        expect(texts(h.live)).toEqual(["char:greeting", "user:hi there"]);
    });

    it("v2GetFirstMessage reads a missing or out-of-range greeting index as the main first message", async () => {
        for (const fmIndex of [2, 9, -2, undefined]) {
            const h = harness({ triggers: [trig([out("v2GetFirstMessage", "first")])], chat: { fmIndex } });
            expect((await h.run())?.chat.scriptstate, String(fmIndex)).toMatchObject({ $first: "first" });
        }
    });

    it("writes the character effects one field at a time on the copy's character, and goes on with a warning when it is gone", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const loreFields = (name: string, content: string, insertOrder = "5") => ({
            name,
            nameType: "value",
            key: "k-" + name,
            keyType: "value",
            content,
            contentType: "value",
            insertOrder,
            insertOrderType: "value",
        });
        const h = harness({
            triggers: [
                trig([
                    ef("v2SetCharacterDesc", v("desc1")),
                    out("v2GetCharacterDesc", "d"),
                    ef("v2SetReplaceGlobalNote", v("gn")),
                    out("v2GetReplaceGlobalNote", "gn"),
                    ef("v2CreateLorebook", loreFields("L1", "c1")),
                    ef("v2CreateLorebook", loreFields("L2", "c2", "nan")),
                    ef("v2ModifyLorebookByIndex", {
                        index: "1",
                        indexType: "value",
                        name: "{{slot}}-mod",
                        nameType: "value",
                        key: "{{slot}}",
                        keyType: "value",
                        content: "{{slot}}!",
                        contentType: "value",
                        insertOrder: "{{slot}}",
                        insertOrderType: "value",
                    }),
                    ef("v2SetLorebookAlwaysActive", { index: "0", indexType: "value", value: true }),
                    ef("v2SetLorebookAlwaysActive", { index: "7", indexType: "value", value: true }),
                    out("v2GetAllLorebooks", "all"),
                    out("v2GetLorebookByIndex", "by1", { index: "1", indexType: "value" }),
                    out("v2GetLorebookByIndex", "by9", { index: "9", indexType: "value" }),
                    out("v2GetLorebookCountNew", "n"),
                    ef("v2DeleteLorebookByIndex", { index: "0", indexType: "value" }),
                    ef("v2DeleteLorebookByIndex", { index: "9", indexType: "value" }),
                    out("v2GetLorebookCountNew", "n2"),
                ]),
            ],
        });
        const result = await h.run();
        expect(result?.chat.scriptstate).toMatchObject({
            $d: "desc1",
            $gn: "gn",
            $all: '["c1","c2!"]',
            $by1: "c2!",
            $by9: "null",
            $n: "2",
            $n2: "1",
        });
        // Two creates, the modify, one activation (the out-of-range one warns and writes nothing),
        // one delete (the out-of-range one writes nothing).
        expect(h.characterPatches.map((patch) => Object.keys(patch))).toEqual([
            ["desc"],
            ["replaceGlobalNote"],
            ["globalLore"],
            ["globalLore"],
            ["globalLore"],
            ["globalLore"],
            ["globalLore"],
        ]);
        expect(h.stored.globalLore).toEqual([
            {
                key: "k-L2",
                comment: "L2-mod",
                content: "c2!",
                mode: "normal",
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false,
            },
        ]);
        expect(h.stored.globalLore.at(0)?.insertorder).toBe(100); // "{{slot}}" of the NaN-defaulted 100
        expect(h.characterPatches[2]).toEqual({
            globalLore: [
                {
                    key: "k-L1",
                    comment: "L1",
                    content: "c1",
                    mode: "normal",
                    insertorder: 5,
                    alwaysActive: false,
                    secondkey: "",
                    selective: false,
                },
            ],
        });

        const gone = harness({ triggers: [trig([ef("v2SetCharacterDesc", v("x")), out("v2GetCharacterDesc", "d")])] });
        gone.state.characterGone = true;
        expect((await gone.run())?.chat.scriptstate).toEqual({ $d: "x" });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/character is gone/));
    });

    it("writes the persona description to the job's effective persona and reads the frozen selected one; none or a gone persona warns", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const h = harness({
            triggers: [trig([ef("v2SetPersonaDesc", v("new prompt")), out("v2GetPersonaDesc", "p")])],
            effectivePersonaId: "bound",
        });
        expect((await h.run())?.chat.scriptstate).toEqual({ $p: "selected persona" });
        expect(h.personaWrites).toEqual([["bound", "new prompt"]]);

        const none = harness({ triggers: [trig([ef("v2SetPersonaDesc", v("x"))])], effectivePersonaId: null });
        await none.run();
        const gone = harness({ triggers: [trig([ef("v2SetPersonaDesc", v("x"))])] });
        gone.state.personaGone = true;
        await gone.run();
        expect(none.personaWrites).toEqual([]);
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
            expect.stringMatching(/No persona is selected/),
            expect.stringMatching(/persona is gone/),
        ]);
    });

    it("turns alerts into notices and questions, GUI updates into notices, and a chat update into a reloadChat of the stored message", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2ShowAlert", v("hello {{getvar::dv}}")),
                    out("v2GetAlertInput", "name", { display: "Name?", displayType: "value" }),
                    out("v2GetAlertSelect", "pick", { display: "Pick", displayType: "value", ...v("a|b|c") }),
                    ef("v2UpdateGUI"),
                    ef("v2UpdateChatAt", { index: 1 }),
                    ef("v2UpdateChatAt", { index: 9 }),
                    ef("v2ConsoleLog", { source: "logged", sourceType: "value" }),
                ]),
            ],
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        h.answers.push("Ada", "b");
        const result = await h.run();
        expect(result?.chat.scriptstate).toEqual({ $name: "Ada", $pick: "b" });
        expect(h.questions).toEqual([
            { kind: "alertInput", payload: { message: "Name?" } },
            { kind: "alertSelect", payload: { options: ["a", "b", "c"], display: "Pick" } },
        ]);
        expect(h.notices).toEqual([
            { kind: "alertNormal", payload: { message: "hello null" } },
            { kind: "updateGUI", payload: {} },
            { kind: "reloadChat", payload: { chaId: "c", chatId: "k", messageId: "m2" } },
            // The run changed variables: one more updateGUI at its end.
            { kind: "updateGUI", payload: {} },
        ]);
        expect(log).toHaveBeenCalledWith("[Trigger]", "logged");
    });

    it("runs v2ImgGen, v2RunLLM (with its model and the ChatML body), v2CheckSimilarity, and v2SendAIprompt with lowLevelAccess", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const h = harness({
            triggers: [
                trig([
                    out("v2ImgGen", "img", { ...v("a cat"), negValue: "dogs", negValueType: "value" }),
                    out("v2RunLLM", "llm", {
                        ...v("<|im_start|>system<|im_sep|>be brief<|im_end|><|im_start|>user<|im_sep|>hi<|im_end|>"),
                        model: "submodel",
                        streaming: true,
                    }),
                    out("v2CheckSimilarity", "sim", { source: "a", sourceType: "value", ...v("b§c") }),
                    ef("v2SendAIprompt"),
                ]),
            ],
        });
        const result = await h.run();
        expect(result?.sendAIprompt).toBe(true);
        // The similarity search gets the source and the value split on `§`; its ranking is joined with `§`.
        expect(result?.chat.scriptstate).toEqual({ $img: "{{inlay::inlay-1}}", $llm: "llm said", $sim: "c§b" });
        expect(h.similarities).toEqual([{ source: "a", values: ["b", "c"] }]);
        expect(h.images).toEqual([{ prompt: "a cat", negative: "dogs", characterId: "c" }]);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].mode).toBe("submodel");
        expect(h.requests[0].arg).toMatchObject({
            formated: [
                { role: "system", content: "be brief" },
                { role: "user", content: "hi" },
            ],
            useStreaming: true,
            noMultiGen: true,
            chatRef: { chaId: "c", chatId: "k" },
        });

        // A failed image and a failed request write "null"; a plain prompt is one user message.
        const failing = harness({
            triggers: [
                trig([
                    out("v2ImgGen", "img", { ...v("p"), negValue: "", negValueType: "value" }),
                    out("v2RunLLM", "llm", { ...v("plain"), model: "model" }),
                ]),
            ],
        });
        failing.state.imageAnswer = null;
        failing.state.requestAnswer = { type: "fail", result: "nope" };
        expect((await failing.run())?.chat.scriptstate).toEqual({ $img: "null", $llm: "null" });
        expect(failing.requests[0].arg.formated).toEqual([{ role: "user", content: "plain" }]);

        // A streaming answer is collected to its last snapshot.
        const streaming = harness({ triggers: [trig([out("v2RunLLM", "llm", { ...v("p"), model: "model" })])] });
        streaming.state.requestAnswer = {
            type: "streaming",
            result: new ReadableStream({
                start(controller) {
                    controller.enqueue({ "0": "par" });
                    controller.enqueue({ "0": "partial answer" });
                    controller.close();
                },
            }),
        };
        expect((await streaming.run())?.chat.scriptstate).toEqual({ $llm: "partial answer" });
    });

    it("adds system prompts, counts their tokens at the end, and stops prompt sending", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2SystemPrompt", { location: "start", ...v("S") }),
                    ef("v2SystemPrompt", { location: "promptend", ...v("PE") }),
                    ef("v2StopPromptSending"),
                ]),
            ],
        });
        const result = await h.run();
        expect(result?.additonalSysPrompt).toEqual({ start: "S\n\n", historyend: "", promptend: "PE\n\n" });
        expect(result?.tokens).toBe(7);
        expect(result?.stopSending).toBe(true);
        expect(h.trace.filter((entry) => entry.startsWith("tokens:"))).toEqual(["tokens:S\n\n", "tokens:PE\n\n"]);
    });

    it("runs v2Command with the CBS'd line through the job's executor and v2Wait as an abortable sleep", async () => {
        const h = harness({
            triggers: [
                trig([ef("v2Command", v("/echo {{getvar::dv}}")), ef("v2Wait", v("0.01")), say("char", "after")]),
            ],
        });
        expect(texts((await h.run())?.chat).at(-1)).toBe("char:after");
        expect(h.commands).toEqual(["/echo null"]);

        // The sleep ends with the signal's own reason (the runner lets an abort escape as it is).
        const waiting = harness({ triggers: [trig([ef("v2Wait", v("30")), say("char", "never")])] });
        const run = waiting.run();
        setTimeout(() => waiting.controller.abort(new Error("stop")), 20);
        await expect(run).rejects.toThrow("stop");
        expect(waiting.commands).toEqual([]);
    });
});

describe("triggerlua", () => {
    it("runs Lua on the working copy with the trigger's access, takes the copy back, propagates stopSending, and reads a Lua character patch natively", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("triggerlua", { code: "the code" }),
                    out("v2GetCharacterDesc", "d"),
                    say("char", "after lua"),
                ]),
            ],
            char: { lowLevelAccess: false },
        });
        h.state.lua = async (_code, working) => {
            // What the bindings do in working mode: edit the copy's messages, delegate the variables,
            // and notify the setters' patches to the running triggers.
            working.chat.message.push({ role: "char", data: `lua ${working.getVar("dv")}` });
            working.setVar("lv", "1");
            h.luaPatched({ desc: "lua desc" });
            return { stopSending: true };
        };
        const result = await h.run();
        expect(h.luaRuns.map((run) => [run.code, run.mode, run.lowLevelAccess])).toEqual([["the code", "go", false]]);
        expect(texts(result?.chat)).toEqual(["char:greeting", "user:hi there", "char:lua 7", "char:after lua"]);
        expect(result?.chat.scriptstate).toEqual({ $lv: "1", $d: "lua desc" });
        expect(result?.stopSending).toBe(true);
        // The listener is gone with the run.
        expect(h.listeners.size).toBe(0);
    });

    it("lets a Lua failure (a load error, a spent budget) end the run", async () => {
        const h = harness({ triggers: [trig([ef("triggerlua", { code: "x" }), say("char", "never")])] });
        h.state.lua = async () => {
            throw new Error("Lua: boom");
        };
        await expect(h.run()).rejects.toThrow("Lua: boom");
    });
});

describe("recursion and the effect limit", () => {
    it("v2RunTrigger nests a manual run sharing the chat, the prompts, stop, display data, and the temporary variables, ten levels deep without lowLevelAccess", async () => {
        const h = harness({
            triggers: [
                trig([
                    setVar("depth", "+=", "1"),
                    say("char", "d{{getvar::depth}}"),
                    ef("v2RunTrigger", { target: "go" }),
                ]),
            ],
            char: { lowLevelAccess: false },
        });
        const result = await h.run();
        // The first run plus ten nested runs (recursiveCount 0..9 pass the guard).
        expect(result?.chat.scriptstate).toEqual({ $depth: "11" });
        expect(texts(result?.chat)).toHaveLength(13);
        expect(h.effects.count).toBe(33);
    });

    it("hands display data and temporary variables through a nested run (recorded: the client loses them)", async () => {
        const h = harness({
            triggers: [
                trig([ef("v2RunTrigger", { target: "inner" }), out("v2GetDisplayState", "seen")], { type: "display" }),
                trig([setVar("t", "=", "temp"), ef("v2SetDisplayState", v("set by inner"))], {
                    comment: "inner",
                    type: "display",
                }),
            ],
        });
        // The allowlists exclude v2RunTrigger from display runs; a manual run with displayMode is
        // the nested shape the port supports.
        const result = await h.run("manual", { manualName: "go", displayMode: true, displayData: "before" });
        expect(result?.displayData).toBe("set by inner");
        expect(result?.tempVars).toEqual({ t: "temp", seen: "set by inner" });
        expect(h.metaWrites).toEqual([]);
        expect(h.varWrites).toEqual([]);
    });

    it(
        "ends a privileged self-recursion with the job's effect limit, not a stack overflow",
        { tags: ["slow"], timeout: 30_000 },
        async () => {
            const h = harness({ triggers: [trig([ef("v2RunTrigger", { target: "go" })])] });
            await expect(h.run()).rejects.toThrow(`more than ${MAX_TRIGGER_EFFECTS} trigger effects`);
            expect(h.effects.count).toBe(MAX_TRIGGER_EFFECTS + 1);
        },
    );

    it(
        "ends `/trigger` recursion through the real command executor with the same shared limit",
        { tags: ["slow"], timeout: 30_000 },
        async () => {
            const h = harness({ triggers: [trig([ef("v2Command", v("/trigger go"))])] });
            const executor = createCommandExecutor({
                services: h.services,
                ctx: h.ctx,
                character: () => h.stored,
                runManualTrigger: async (name) => {
                    await h.runtime.runTrigger(h.stored, "manual", { chat: structuredClone(h.live), manualName: name });
                },
                multisend: () => {},
            });
            h.state.command = (line) => executor.processMultiCommand(line);
            await expect(h.run()).rejects.toThrow(`more than ${MAX_TRIGGER_EFFECTS} trigger effects`);
            expect(h.effects.count).toBe(MAX_TRIGGER_EFFECTS + 1);
        },
    );

    it("ends an endless loop with the limit", async () => {
        const h = harness({
            triggers: [trig([ef("v2Loop"), setVar("n", "+=", "1", 1), ef("v2EndIndent", { endOfLoop: true }, 1)])],
        });
        await expect(h.run()).rejects.toThrow(/more than/);
    });
});

describe("the fences", () => {
    it("after an abort during the first final token count, starts no other count and rejects", async () => {
        const h = harness({
            triggers: [
                trig([
                    ef("v2SystemPrompt", { location: "start", ...v("one") }),
                    ef("v2SystemPrompt", { location: "historyend", ...v("two") }),
                ]),
            ],
        });
        h.state.tokens = async () => {
            h.controller.abort(new Error("stop"));
            return 1;
        };
        await expect(h.run()).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(h.trace.filter((entry) => entry.startsWith("tokens:"))).toEqual(["tokens:one\n\n"]);
    });

    it("after an abort while a question waits, sets no variable, sends no notice, and writes nothing more", async () => {
        const h = harness({
            triggers: [
                trig([
                    out("v2GetAlertInput", "a", { display: "q", displayType: "value" }),
                    setVar("x", "=", "1"),
                    ef("v2ShowAlert", v("late")),
                ]),
            ],
        });
        h.answers.push(async () => {
            h.controller.abort(new Error("stop"));
            return "late answer";
        });
        await expect(h.run()).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(h.metaWrites).toEqual([]);
        expect(h.varWrites).toEqual([]);
        expect(h.notices).toEqual([]);
    });

    it("never turns an abort or a fatal failure during a regex into the site's fallback value", async () => {
        const abortedRegex = harness({
            triggers: [
                trig([
                    out("v2RegexTest", "o", {
                        ...v("x"),
                        regex: "x",
                        regexType: "value",
                        flags: "",
                        flagsType: "value",
                    }),
                ]),
            ],
        });
        abortedRegex.ctx.regex = async () => {
            abortedRegex.controller.abort(new Error("stop"));
            return { value: true };
        };
        await expect(abortedRegex.run()).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(abortedRegex.metaWrites).toEqual([]);

        const fatalReplace = harness({
            triggers: [
                trig([
                    out("v2ReplaceString", "o", {
                        source: "s",
                        sourceType: "value",
                        regex: "s",
                        regexType: "value",
                        result: "$0",
                        resultType: "value",
                        replacement: "r",
                        replacementType: "value",
                        flags: "",
                        flagsType: "value",
                    }),
                ]),
            ],
        });
        fatalReplace.ctx.regex = async () => {
            throw fatalReplace.services.latch(new LuaJobFatalError("owner lost"));
        };
        await expect(fatalReplace.run()).rejects.toThrow("owner lost");
        expect(fatalReplace.metaWrites).toEqual([]);
    });

    it("checks the abort before every effect: an aborted run with a pending effect writes nothing more", async () => {
        const h = harness({ triggers: [trig([setVar("x", "=", "1"), setVar("y", "=", "2")])] });
        const originalSet = h.services.setChatVar;
        h.services.setChatVar = (key, value, ctx) => {
            const changed = originalSet(key, value, ctx);
            h.controller.abort(new Error("stop after the first write"));
            return changed;
        };
        await expect(h.run()).rejects.toBeInstanceOf(LuaJobFatalError);
        expect(h.varWrites).toEqual([["x", "1"]]);
    });
});

describe("the run's character copy", () => {
    it("shares the asset lists with the source and copies every other field, so the run's edits leave the source alone", async () => {
        const additionalAssets: [string, string, string][] = [["a", "assets/a.png", "png"]];
        const emotionImages: [string, string][] = [["happy", "assets/happy.png"]];
        const ccAssets = [{ type: "x-risu-asset", uri: "assets/b.png", name: "b", ext: "png" }];
        const h = harness({
            triggers: [
                trig([
                    ef("v2SetCharacterDesc", v("desc1")),
                    ef("v2CreateLorebook", {
                        name: "L1",
                        nameType: "value",
                        key: "k",
                        keyType: "value",
                        content: "c",
                        contentType: "value",
                        insertOrder: "5",
                        insertOrderType: "value",
                    }),
                    out("v2GetLorebookCountNew", "n"),
                ]),
            ],
            char: { additionalAssets, emotionImages, ccAssets } as Partial<character>,
        });
        const source = structuredClone(h.stored);
        source.additionalAssets = additionalAssets;
        source.emotionImages = emotionImages;
        source.ccAssets = ccAssets;
        const keys = Object.keys(source);
        let seen: character | undefined;
        const parse = h.services.parse;
        h.services.parse = (text, chara) => {
            seen = chara as character;
            return parse(text, chara);
        };
        const result = await h.runtime.runTrigger(source, "manual", {
            chat: structuredClone(h.live),
            manualName: "go",
        });
        expect(result?.chat.scriptstate).toMatchObject({ $n: "1" });
        expect(seen).toBeDefined();
        expect(seen).not.toBe(source);
        expect(Object.keys(seen!)).toEqual(keys);
        // The asset lists are the source's own arrays (no effect writes them).
        expect(seen!.additionalAssets).toBe(additionalAssets);
        expect(seen!.emotionImages).toBe(emotionImages);
        expect(seen!.ccAssets).toBe(ccAssets);
        // Every other field is the run's: its lore, description, and trigger flags never reach the source.
        expect(seen!.globalLore).toHaveLength(1);
        expect(source.globalLore).toEqual([]);
        expect(seen!.desc).toBe("desc1");
        expect(source.desc).toBe("d0");
        expect(seen!.triggerscript).not.toBe(source.triggerscript);
        expect(source.triggerscript[0].lowLevelAccess).toBeUndefined();
    });

    it("keeps a stored own `__proto__` field as an own field of the copy", async () => {
        const h = harness({ triggers: [trig([setVar("x", "=", "1")])] });
        const source = Object.assign(JSON.parse('{"__proto__":{"x":1}}'), structuredClone(h.stored)) as character;
        let seen: character | undefined;
        const parse = h.services.parse;
        h.services.parse = (text, chara) => {
            seen = chara as character;
            return parse(text, chara);
        };
        await h.runtime.runTrigger(source, "manual", { chat: structuredClone(h.live), manualName: "go" });
        expect(seen).toBeDefined();
        expect(Object.hasOwn(seen!, "__proto__")).toBe(true);
        expect((seen as unknown as Record<string, unknown>)["__proto__"]).toEqual({ x: 1 });
        expect(Object.getPrototypeOf(seen)).toBe(Object.prototype);
    });
});

describe("the request-trigger predicate", () => {
    const requestTrig = (effect: triggerEffect[], extra: Partial<triggerscript> = {}) =>
        trig(effect, { type: "request", ...extra });

    it.each([
        [
            "a character's request trigger with a request effect",
            { triggers: [requestTrig([setVar("x", "=", "1")])] },
            true,
        ],
        ["a module's request trigger", { triggers: [], moduleTriggers: [requestTrig([setVar("x", "=", "1")])] }, true],
        [
            "a request trigger with legacy conditions (never run)",
            { triggers: [requestTrig([setVar("x", "=", "1")], { conditions: [{ type: "var", var: "x" }] as never })] },
            false,
        ],
        [
            "a request trigger whose every effect the request allowlist excludes",
            {
                triggers: [
                    requestTrig([
                        say("char", "no"),
                        ef("v2Command", v("/echo no")),
                        ef("v2RunTrigger", { target: "go" }),
                    ]),
                ],
            },
            false,
        ],
        [
            "a request trigger with one request effect among excluded ones",
            { triggers: [requestTrig([say("char", "no"), ef("v2Comment", { text: "note" })])] },
            true,
        ],
        ["a trigger of another type", { triggers: [trig([setVar("x", "=", "1")], { type: "output" })] }, false],
        [
            "a Lua trigger of another type (selected in every mode, but Lua is not a request effect)",
            { triggers: [lua("code", { type: "output" })] },
            false,
        ],
        ["a character with no trigger", { triggers: [] }, false],
        ["an empty request trigger", { triggers: [requestTrig([])] }, false],
    ] as [string, { triggers: triggerscript[]; moduleTriggers?: triggerscript[] }, boolean][])(
        "agrees with a request run on whether any effect runs: %s",
        async (_case, options, fires) => {
            const h = harness(options);
            await h.run("request", { displayMode: true, displayData: "[]" });
            // Every effect a run reaches counts against the job's limit: the run's own word on it.
            expect(h.effects.count > 0).toBe(fires);
            expect(hasRequestTriggers(h.stored, options.moduleTriggers ?? [])).toBe(fires);
        },
    );

    it("is false for a group and for no owner, whose request trigger the job never runs, whatever their triggers", () => {
        const triggers = [requestTrig([setVar("x", "=", "1")])];
        const group = { chaId: "g", type: "group", triggerscript: triggers } as unknown as groupChat;
        expect(hasRequestTriggers(group, triggers)).toBe(false);
        expect(hasRequestTriggers(undefined, triggers)).toBe(false);
    });
});
