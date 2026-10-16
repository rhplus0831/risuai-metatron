// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calcString } from "../../../shared/cbs/calc.ts";
import { createCbsEvaluator } from "../../../shared/cbs/evaluator.ts";
import { CbsLimitError, type CbsUsage } from "../../../shared/cbs/limits.ts";
import type { Chat, Message, character, triggerscript } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import {
    createJobCbsHost,
    SERVER_CBS_JOB_MS,
    SERVER_CBS_MAX_MS,
    SERVER_CBS_MAX_WORK,
    serverCbsLimits,
} from "../jobs/cbsHost.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { type JobScope, loadJobScope } from "../jobs/jobScope.ts";
import { createLuaBindings, type LuaBindingServices, LuaJobFatalError } from "../lua/bindings.ts";
import { createTriggerRuntime, type TriggerHost } from "../prompt/triggers.ts";
import type { HostContext } from "../scripts/workerPool.ts";

// Phase 5 slice 9b, the server's side of the CBS limits: the job host (`server/src/jobs/cbsHost.ts`)
// carries `serverCbsLimits`, parses the default variables once per source text (the first pair of a
// key wins, the character's before the template's, re-read when a text changes), and its `calcString`
// reads a variable once per calculation and answers as the plain calculator over the same getters
// (values, the coercions of odd variable texts, a missing variable, both namespaces, parentheses);
// the bindings (`server/src/lua/bindings.ts`) wrap the run's evaluator so that a reached limit is
// the job's latched fatal failure named after the chat owner, every evaluation after it raises that
// failure, and the limit is seen through the closures made over the evaluator (`services.parse`,
// the Lua `cbs` host function); two bindings of one job share its `cbsUsage` allowance, and one made
// without it has its own; the native effect loop (`server/src/prompt/triggers.ts`) yields a turn once
// it has held the thread 50 ms, so a stop queued meanwhile gets in before the next effect. The
// evaluator's own accounting is in `cbsLimits.test.ts`; the jobs end to end in `cbsLimitsJobs.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;
// A range too large for the work limit (a non-advancing one answers `[]` since slice 1d of the audit plan).
const HUGE = "{{range::[0,1e18]}}";

afterEach(() => {
    vi.restoreAllMocks();
});

/** A scope over plain objects (what `createJobCbsHost` reads), with one character and its chat. */
function plainScope(options: { defaultVariables?: string; templateDefaultVariables?: string; scriptstate?: object }) {
    const chat = {
        id: "k",
        name: "K",
        fmIndex: -1,
        message: [] as Message[],
        scriptstate: options.scriptstate ?? {},
    } as unknown as Chat;
    const char = {
        chaId: "c",
        type: "character",
        name: "Owner",
        chatPage: 0,
        firstMessage: "hi",
        desc: "",
        chats: [chat],
        defaultVariables: options.defaultVariables ?? "",
    } as unknown as character;
    const scope = {
        db: {
            characters: [char],
            personas: [],
            globalChatVariables: {},
            templateDefaultVariables: options.templateDefaultVariables ?? "",
            modules: [],
            enabledModules: [],
            username: "U",
        },
        characterId: "c",
        chatId: "k",
        effectivePersona: { id: "p", name: "U", personaPrompt: "" },
    } as unknown as JobScope;
    return { scope, char, chat };
}

const hostOf = (scope: JobScope, usage: CbsUsage = { usedMs: 0 }) =>
    createJobCbsHost(scope, { rootDir: REPO_ROOT, setChatVar: () => false, limits: serverCbsLimits(usage) });

describe("the server host", () => {
    it("carries the server limits: 10,000,000 work units and 5 s per parse, 60 s of evaluation per job", () => {
        const usage: CbsUsage = { usedMs: 0 };
        const limits = serverCbsLimits(usage);
        expect([SERVER_CBS_MAX_WORK, SERVER_CBS_MAX_MS, SERVER_CBS_JOB_MS]).toEqual([10_000_000, 5000, 60_000]);
        expect(limits).toEqual({ maxWork: 10_000_000, maxMs: 5000, total: { usage, maxMs: 60_000 } });
        expect(limits.total!.usage).toBe(usage);
        const { scope } = plainScope({});
        const host = hostOf(scope, usage);
        expect(host.limits).toEqual(limits);
        const ev = createCbsEvaluator(host);
        const error = (() => {
            try {
                ev.risuChatParser(HUGE);
            } catch (e) {
                return e as CbsLimitError;
            }
            throw new Error("expected a CbsLimitError");
        })();
        expect(error).toBeInstanceOf(CbsLimitError);
        expect(error.message).toBe("CBS limit reached: one template took more than 10000000 steps");
        expect(usage.usedMs).toBeGreaterThan(0);
    });

    it("reads a default variable as before: the chat's state first, then the character's defaults, then the template's, else null", () => {
        const { scope, char, chat } = plainScope({
            defaultVariables: "a=1\nb=2\na=9\nbad\n=x\nc=",
            templateDefaultVariables: "b=20\nd=4",
            scriptstate: { $a: "state" },
        });
        const host = hostOf(scope);
        const read = (key: string) => host.getChatVar(key, { chaId: "c", chatId: "k" });
        expect(read("a")).toBe("state");
        expect(read("b")).toBe("2");
        expect(read("d")).toBe("4");
        expect(read("c")).toBe("null");
        expect(read("bad")).toBe("null");
        expect(read("missing")).toBe("null");
        // The cache follows the source texts: a changed default or template is read again.
        char.defaultVariables = "b=3";
        expect(read("b")).toBe("3");
        expect(read("d")).toBe("4");
        (scope.db as { templateDefaultVariables: string }).templateDefaultVariables = "d=40";
        expect(read("d")).toBe("40");
        // The chat's state still wins, and a cleared state falls back.
        (chat as { scriptstate: Record<string, unknown> }).scriptstate = {};
        expect(read("a")).toBe("null");
        // The host reads the same answers as the live evaluator does through `{{getvar}}`.
        const ev = createCbsEvaluator(host);
        expect(ev.risuChatParser("{{getvar::b}}-{{getvar::d}}-{{getvar::zz}}", { chara: char })).toBe("3-40-null");
    });

    it("calculates as the plain calculator over the same variables, odd texts included, reading each variable once per calculation", () => {
        const values: Record<string, string> = {
            x: "7",
            y: "2.5",
            neg: "-3",
            zero: "-0",
            text: "abc",
            mixed: "12abc",
            nul: "null",
            inf: "Infinity",
            huge: "1e400",
            hex: "0x10",
            spaced: " 5 ",
            empty: "",
            nan: "NaN",
            exp: "1e3",
        };
        const scriptstate = Object.fromEntries(Object.entries(values).map(([key, value]) => [`$${key}`, value]));
        let reads = 0;
        const counted = new Proxy(scriptstate, {
            get(target, property, receiver) {
                reads++;
                return Reflect.get(target, property, receiver);
            },
        });
        const { scope } = plainScope({ scriptstate: counted });
        (scope.db as { globalChatVariables: Record<string, string> }).globalChatVariables = { g: "4", t: "x1" };
        const host = hostOf(scope);
        // The reference: the calculator over the host's own getters, as the host called it before.
        const plain = (text: string) =>
            calcString(text, {
                getChatVar: (key) => host.getChatVar(key),
                getGlobalChatVar: (key) => host.getGlobalChatVar(key),
            });
        const names = Object.keys(values);
        const expressions = [
            ...names.map((name) => `$${name}`),
            ...names.map((name) => `$${name}+$${name}`),
            ...names.map((name) => `($${name})*2`),
            ...names.map((name) => `$${name}>0`),
            "$x+$y*2",
            "($x+$y)*2",
            "$x+($y*($neg+1))",
            "@g+$x",
            "@g*@g+@t",
            "@missing+$missing",
            "$x==7",
            "$x!=7",
            "$x>=7&&$y<3",
            "!$zero",
            "$huge/$inf",
            "1+2",
            "",
            "((",
            "$x^2%5",
        ];
        for (const expression of expressions) {
            expect(host.calcString(expression), expression).toEqual(plain(expression));
        }
        // One calculation reads a variable once however often it is named.
        reads = 0;
        host.calcString("$x+$x+($x*$x)+$x");
        expect(reads).toBe(1);
        reads = 0;
        host.calcString("$x+$y+$x");
        expect(reads).toBe(2);
        // The memo is per calculation: a changed value is read by the next one.
        scriptstate.$x = "8";
        expect(host.calcString("$x*2")).toBe(16);
        // Through the evaluator too.
        const ev = createCbsEvaluator(host);
        expect(ev.risuChatParser("{{? $x+$y}} {{calc::($x)*@g}}")).toBe("10.5 32");
    });
});

/** A real store with one character and chat, and the production bindings over a fake job. */
function bindingsSetup(options: { desc?: string; triggerscript?: triggerscript[]; usage?: CbsUsage | null } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-cbs-limits-host-"));
    const store: ResourceStore = createResourceStore({ file: path.join(dir, "data", "resources.sqlite"), kinds });
    const cleanup = () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    };
    const singleton = (name: string, data: unknown) => {
        const row = store.get(kind(name), "main");
        store.applyChanges({ ops: [{ kind: kind(name), id: "main", baseRevision: row?.revision ?? null, data }] });
    };
    singleton(RESOURCE_KIND.presets, [{ id: "p", name: "p" }]);
    singleton(RESOURCE_KIND.modelPresets, [{ id: "m", name: "m", aiModel: "gpt-4o" }]);
    singleton("personas", [{ id: "u", name: "Uma" }]);
    store.applyChanges({
        ops: [
            {
                kind: kind(RESOURCE_KIND.characters),
                id: "c",
                baseRevision: null,
                data: {
                    chaId: "c",
                    type: "character",
                    name: "Owner Name",
                    firstMessage: "hello",
                    desc: options.desc ?? "",
                    triggerscript: options.triggerscript ?? [],
                },
            },
        ] as never,
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            fmIndex: -1,
                            // The chat's binding (`docs/plan/chat-binding.md`): the job scope checks the context's ids against it.
                            modelPresetId: "m",
                            promptPresetId: "p",
                            bindedPersona: "u",
                            message: [{ role: "user", data: "hi", chatId: "m1" }],
                        },
                    },
                ],
            },
        ],
    });
    const context = {
        characterId: "c",
        chatId: "k",
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        mode: "button",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const scope = loadJobScope(store, kinds, context);
    const fatal: LuaJobFatalError[] = [];
    const jobController = new AbortController();
    let writes = 0;
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "button", data: "" },
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
        },
        ownerAttached: () => true,
        epoch: store.epoch(),
        signal: jobController.signal,
        emit() {},
        emitRecords: () => [],
        write: (build) => {
            writes++;
            return store.applyChanges(build() as never, { epoch: store.epoch() });
        },
        onClientMessage: () => () => {},
    };
    const make = (usage: CbsUsage | null | undefined) =>
        createLuaBindings({
            job,
            scope,
            store,
            kinds,
            rootDir: REPO_ROOT,
            savePath: path.join(dir, "save"),
            llm: {} as never,
            tokens: { count: async (text: string) => text.length, encode: async () => [] } as never,
            runCharacterId: "c",
            engineCharacterId: "c",
            ...(usage === null ? {} : { cbsUsage: usage ?? { usedMs: 0 } }),
            onFatal: (error) => fatal.push(error),
        });
    const ctx: HostContext = {
        identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
        access: "lowLevel",
        signal: new AbortController().signal,
        regex: async () => ({ value: false }),
    };
    const chat = () => store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data as Chat;
    return { store, scope, make, ctx, fatal, chat, writes: () => writes, cleanup };
}

describe("the bindings", () => {
    const cleanups: (() => void)[] = [];
    afterEach(() => {
        for (const cleanup of cleanups.splice(0).reverse()) {
            cleanup();
        }
    });

    it("latch a reached limit as the job's fatal failure named after the chat owner, seen through every closure, and evaluate nothing after it", () => {
        const setup = bindingsSetup({ desc: HUGE });
        cleanups.push(setup.cleanup);
        const bindings = setup.make(undefined);
        // Through `services.parse` (what the native triggers, lore and the regex scripts call).
        let caught: unknown;
        try {
            bindings.services.parse("[{{description}}]", null);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(LuaJobFatalError);
        expect((caught as Error).message).toBe(
            "CBS limit reached: one template took more than 10000000 steps (Owner Name)",
        );
        expect(bindings.fatal()).toBe(caught);
        expect(setup.fatal).toEqual([caught]);
        // Latched: an ordinary evaluation afterwards raises the same failure, and a write is refused.
        expect(() => bindings.evaluator.risuChatParser("plain")).toThrow(caught as Error);
        expect(() => bindings.services.parse("plain", null)).toThrow(caught as Error);
        expect(() => bindings.services.setChatVar("late", "1")).toThrow(caught as Error);
        expect(setup.writes()).toBe(0);
        expect(setup.chat().scriptstate ?? {}).toEqual({});
        // The first failure wins: a second limit does not replace it.
        expect(setup.fatal).toHaveLength(1);
    });

    it("let the Lua `cbs` host function raise the latched failure, and refuse the write a script makes after catching it", () => {
        const setup = bindingsSetup({});
        cleanups.push(setup.cleanup);
        const bindings = setup.make(undefined);
        const before = bindings.evaluator.risuChatParser("{{char}} says {{user}}");
        expect(before).toBe("Owner Name says Uma");
        const cbs = bindings.host.sync!.cbs as (args: unknown[], ctx: HostContext) => unknown;
        expect(() => cbs([HUGE], setup.ctx)).toThrow(/CBS limit reached: .* \(Owner Name\)/);
        const setChatVar = bindings.host.sync!.setChatVar as (args: unknown[], ctx: HostContext) => unknown;
        expect(() => setChatVar(["late", "1"], setup.ctx)).toThrow(LuaJobFatalError);
        expect(setup.writes()).toBe(0);
    });

    it("keep an ordinary failing function as its literal text: only the limit is fatal", () => {
        const setup = bindingsSetup({});
        cleanups.push(setup.cleanup);
        const bindings = setup.make(undefined);
        // `replace` and `join` without arguments throw inside the registry; `range::x` is a legal empty range.
        expect(bindings.services.parse("a {{replace}} b {{join}} c {{range::x}}", null)).toBe(
            "a {{replace}} b {{join}} c []",
        );
        expect(bindings.fatal()).toBeNull();
    });

    it("share one job allowance between the runs' bindings, and give a bindings without one its own", () => {
        const setup = bindingsSetup({});
        cleanups.push(setup.cleanup);
        const usage: CbsUsage = { usedMs: 0 };
        const first = setup.make(usage);
        const second = setup.make(usage);
        first.evaluator.risuChatParser("{{char}} ".repeat(2000));
        const afterFirst = usage.usedMs;
        expect(afterFirst).toBeGreaterThan(0);
        second.evaluator.risuChatParser("{{char}} ".repeat(2000));
        expect(usage.usedMs).toBeGreaterThan(afterFirst);
        // The allowance is spent (as the input stage and the earlier speakers of a job may have spent it):
        // the next run's first evaluation is refused at its entry and latched, in that run only.
        usage.usedMs = SERVER_CBS_JOB_MS;
        const third = setup.make(usage);
        expect(() => third.evaluator.risuChatParser("x")).toThrow(/took more than 60000 ms in all \(Owner Name\)/);
        expect(third.fatal()).toBeInstanceOf(LuaJobFatalError);
        expect(() => second.evaluator.risuChatParser("x")).toThrow(/60000 ms in all/);
        // A bindings made without a job usage counts for itself.
        const alone = setup.make(null);
        expect(alone.evaluator.risuChatParser("{{char}}")).toBe("Owner Name");
        expect(alone.fatal()).toBeNull();
    });
});

describe("the native effect loop", () => {
    /**
     * The runtime over fake services whose `parse` holds the thread for `holdMs`, with the effect
     * loop reading `now` (the real clock unless given). The first parse queues a stop due
     * `stopAfterMs` later: queued inside the first effect, it cannot race the run's own first turn.
     */
    function runtimeHolding(holdMs: number, effects: number, stopAfterMs: number, now?: () => number) {
        const controller = new AbortController();
        const parsed: string[] = [];
        let fatal: LuaJobFatalError | null = null;
        const latch = (error: unknown) => {
            fatal ??= error instanceof LuaJobFatalError ? error : new LuaJobFatalError(String(error));
            return fatal;
        };
        const fence = (ctx?: HostContext) => {
            if (fatal) {
                throw fatal;
            }
            if (controller.signal.aborted || ctx?.signal.aborted) {
                throw latch(new LuaJobFatalError("request aborted"));
            }
        };
        const chat = { id: "k", name: "K", message: [], scriptstate: {}, fmIndex: -1 } as unknown as Chat;
        const char = {
            chaId: "c",
            type: "character",
            name: "C",
            desc: "",
            firstMessage: "first",
            lowLevelAccess: true,
            globalLore: [],
            triggerscript: [
                {
                    comment: "start",
                    type: "start",
                    conditions: [],
                    effect: Array.from({ length: effects }, (_, i) => ({
                        type: "v2SetVar",
                        var: `v${i}`,
                        operator: "=",
                        value: `value ${i}`,
                        valueType: "value",
                        indent: 0,
                    })),
                },
            ],
        } as unknown as character;
        const services = {
            fence,
            latch,
            liveChat: () => chat,
            chatExists: () => true,
            refresh: () => true,
            writeChat: (build: (chat: Chat) => { op: string; set?: object }[] | null, ctx?: HostContext) => {
                fence(ctx);
                // The store's side: a `meta` op lands on the live chat (the runtime works on its copy).
                for (const op of build(chat) ?? []) {
                    if (op.op === "meta") {
                        Object.assign(chat, structuredClone(op.set));
                    }
                }
            },
            // The store's side of a setter: the key lands on the live chat (the runtime works on its copy).
            setChatVar: (key: string, value: string, ctx?: HostContext) => {
                fence(ctx);
                chat.scriptstate = { ...chat.scriptstate, [`$${key}`]: value };
                return true;
            },
            getChatVar: () => "null",
            patchCharacter: () => true,
            patchPersonaPrompt: () => true,
            ask: async () => undefined,
            notice: () => {},
            request: async () => ({ type: "success", result: "" }),
            collectStreamText: async () => "",
            generateImageInlay: async () => null,
            tokenize: async (text: string) => text.length,
            activateLore: async () => ({ actives: [] }),
            parse: (text: string) => {
                if (parsed.length === 0) {
                    setTimeout(() => controller.abort(), stopAfterMs);
                }
                parsed.push(text);
                const until = performance.now() + holdMs;
                while (performance.now() < until) {
                    // Holding the thread, as a large legal CBS parse does.
                }
                return text;
            },
            calc: () => 0,
        } as unknown as LuaBindingServices;
        const ctx: HostContext = {
            identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
            access: "lowLevel",
            signal: controller.signal,
            regex: async () => ({ value: false }),
        };
        const host: TriggerHost = {
            services,
            chatRef: { chaId: "c", chatId: "k" },
            ctx,
            observeCharacterPatches: () => () => {},
            moduleTriggers: () => [],
            effects: { count: 0 },
            templateDefaultVariables: "",
            selectedPersonaPrompt: "",
            effectivePersonaId: null,
            runCommand: async () => undefined,
            runLua: async () => ({ stopSending: false }),
            now,
        } as unknown as TriggerHost;
        return { runtime: createTriggerRuntime(host), controller, parsed, chat, char, effects: host.effects };
    }

    it("yields a turn once an effect held the thread over 50 ms, so a stop queued meanwhile ends the run before the next effect", async () => {
        // Queued from the first effect and due during it, the stop can only run on a yield.
        const { runtime, parsed, char, chat, effects } = runtimeHolding(80, 4, 5);
        await expect(runtime.runTrigger(char, "start", { chat, displayMode: false })).rejects.toThrow(
            "request aborted",
        );
        // The first effect ran whole (its value, then its output name: two parses, one key), the
        // second never started.
        expect(parsed).toEqual(["value 0", "v0"]);
        expect(effects.count).toBe(1);
        expect(chat.scriptstate).toEqual({ $v0: "value 0" });
    });

    it("does not yield between quick effects: a stop queued during them lands after the run", async () => {
        // A stopped clock: the effects take no time, however long the machine takes to run them.
        const { runtime, controller, parsed, char, chat } = runtimeHolding(0, 4, 0, () => 0);
        const result = await runtime.runTrigger(char, "start", { chat, displayMode: false });
        expect(result).not.toBeNull();
        expect(parsed).toHaveLength(8);
        expect(Object.keys(chat.scriptstate!).sort()).toEqual(["$v0", "$v1", "$v2", "$v3"]);
        // The stop queued from the first effect was still pending through the run, and lands after it.
        expect(controller.signal.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.signal.aborted).toBe(true);
    });
});
