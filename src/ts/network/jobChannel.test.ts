import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    CallbackTargets,
    ChannelAnswer,
    GenerationCallbackEvent,
    GenerationChannelEvent,
    GenerationNotice,
    GenerationQuestionEvent,
} from "../../../shared/jobs.ts";

// Phase 5 slice 6, the client dispatcher of the job channel (`jobChannel.ts`) with controlled
// persistence and plugin dependencies and the real alert module over its polling store: the one UI
// queue (questions answered with the alert's raw value, toasts and modal notices queued behind an
// open question, cancellation and the job's end closing only the alert they own, stale results
// dropped, bounded memory), and the callbacks (the barrier before and after the hook with its
// failure taxonomy, cancellation stopping unstarted work, results that cannot cross the wire,
// duplicates and replays, the nesting rules, cache pressure, the hook list). The real stores are
// behind the barrier in `jobChannelBarrier.test.ts`.

const deps = vi.hoisted(() => ({
    flush: vi.fn<(options?: { scope?: unknown }) => Promise<{ discarded: string[] }>>(),
    applyHydration: vi.fn<(record: unknown) => boolean>(),
    heldChat: vi.fn<(ref: { chaId: string; chatId: string }) => string | null>(),
    heldRecord: vi.fn<(kind: string, id: string) => string | null>(),
    contexts: [] as unknown[],
    mcps: new Map<string, { callTool: (tool: string, args: unknown) => Promise<unknown> }>(),
    sayTTS: vi.fn(),
    getModelInfo: vi.fn((id: string) => ({
        id,
        name: id,
        internalID: id,
        provider: 0,
        format: 0,
        flags: [],
        parameters: [],
        tokenizer: 0,
    })),
}));

vi.mock("../storage/resourceSync.svelte", () => ({
    flushResources: (options?: { scope?: unknown }) => deps.flush(options),
    beginMutationScope: () => ({ resource: 7, chat: 3 }),
    applyHydration: (record: unknown) => deps.applyHydration(record),
    heldRecordRevision: (kind: string, id: string) => deps.heldRecord(kind, id),
}));
vi.mock("../storage/chatStore.svelte", () => ({
    heldChatRevision: (ref: { chaId: string; chatId: string }) => deps.heldChat(ref),
}));
vi.mock("../stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return {
        alertStore: writable({ type: "none", msg: "" }),
        selectedCharID: writable(0),
        ReloadGUIPointer: writable(0),
        ReloadChatPointer: writable({} as Record<number, number>),
        CharEmotion: writable({} as Record<string, [string, string, number][]>),
        hypaV3ProgressStore: writable({ open: false, miniMsg: "", msg: "", subMsg: "" }),
        bodyIntercepterStore: [] as { id: string; callback: (body: unknown, type: string) => Promise<unknown> }[],
        DBState: {
            db: {
                notification: false,
                characters: [
                    {
                        chaId: "c",
                        type: "character",
                        chatPage: 0,
                        chats: [{ id: "k", message: [{ chatId: "m1" }, { chatId: "m2" }] }],
                    },
                ],
            },
        },
    };
});
vi.mock("../plugins/apiV3/pluginContext", () => ({
    invokeHook: (hook: (...args: unknown[]) => unknown, context: unknown, ...args: unknown[]) => {
        deps.contexts.push(context);
        return hook(...args);
    },
    PluginTargetGoneError: class PluginTargetGoneError extends Error {},
}));
vi.mock("../process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: deps.mcps }));
vi.mock("../util", () => ({ sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }));
vi.mock("../../lang", () => ({ language: {} }));
vi.mock("../storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../process/tts", () => ({ sayTTS: deps.sayTTS }));
vi.mock("../model/modellist", () => ({ getModelInfo: deps.getModelInfo }));

type Channel = typeof import("./jobChannel");
type Stores = typeof import("../stores.svelte");
type Hooks = typeof import("../plugins/pluginHooks");

const EPOCH = "11111111-2222-4333-8444-555555555555";
/** A revision token of the loaded epoch (`<epoch>:<seq>:<revision>`). */
const rev = (seq: number, revision: number, epoch = EPOCH) => `${epoch}:${seq}:${revision}`;
const targets: CallbackTargets = { chatRef: { chaId: "c", chatId: "k" }, presetId: "p", personaId: "u" };
const question = (
    id: string,
    kind: GenerationQuestionEvent["kind"] = "alertConfirm",
    payload: unknown = { message: `q ${id}` },
    extra: Partial<GenerationQuestionEvent> = {},
): GenerationQuestionEvent =>
    ({ type: "question", epoch: EPOCH, id, deadline: 10_000, kind, payload, ...extra }) as GenerationQuestionEvent;
const callback = (
    id: string,
    name: GenerationCallbackEvent["name"] = "editoutput",
    payload: unknown = { text: "t" },
    extra: Partial<GenerationCallbackEvent> = {},
): GenerationCallbackEvent => ({
    type: "callback",
    epoch: EPOCH,
    id,
    jobId: "J",
    name,
    targets,
    revisions: [],
    payload,
    deadline: 10_000,
    ...extra,
});
const notice = (kind: GenerationNotice["kind"], payload: unknown = {}): GenerationChannelEvent =>
    ({ type: "notice", epoch: EPOCH, kind, payload }) as GenerationChannelEvent;
const cancel = (id: string): GenerationChannelEvent => ({ type: "cancel", epoch: EPOCH, id });
const failed = (failure: string, error: string | RegExp, discarded?: string[]) =>
    expect.objectContaining({
        outcome: "failed",
        failure,
        error: typeof error === "string" ? error : expect.stringMatching(error),
        ...(discarded ? { discarded } : {}),
    });
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let channel: Channel;
let stores: Stores;
let hooks: Hooks["pluginHooks"];
/** A follow's `send`: the answers it took, in order. */
function transport() {
    const answers: ChannelAnswer[] = [];
    return {
        answers,
        send: vi.fn((message: ChannelAnswer) => {
            answers.push(message);
            return true;
        }),
    };
}
let tx: ReturnType<typeof transport>;
const send = (event: GenerationChannelEvent, jobId = "J", through = tx) =>
    channel.handleChannelEvent(jobId, event, through);
/** Lets the alert pollers (10 ms) and the callback chain run. */
const pump = (ms = 30) => vi.advanceTimersByTimeAsync(ms);
const alert = () => get(stores.alertStore);
/** The user answers the alert the way `AlertComp` does. */
const userAnswers = (msg: string) => stores.alertStore.set({ type: "none", msg });

beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    deps.flush.mockReset().mockResolvedValue({ discarded: [] });
    deps.applyHydration.mockReset().mockReturnValue(true);
    deps.heldChat.mockReset().mockReturnValue(rev(1, 1));
    deps.heldRecord.mockReset().mockReturnValue(rev(1, 1));
    deps.contexts.length = 0;
    deps.mcps.clear();
    deps.sayTTS.mockReset();
    stores = await import("../stores.svelte");
    // The mocked stores module outlives `resetModules`: start each test from idle registries.
    stores.bodyIntercepterStore.length = 0;
    stores.alertStore.set({ type: "none", msg: "" });
    stores.ReloadGUIPointer.set(0);
    stores.ReloadChatPointer.set({});
    stores.CharEmotion.set({});
    hooks = (await import("../plugins/pluginHooks")).pluginHooks;
    channel = await import("./jobChannel");
    tx = transport();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("notices and questions", () => {
    it("shows a question, answers it with the alert's raw value, and holds a toast, a modal notice, and the next question behind it", async () => {
        send(question("q1"));
        expect(alert()).toMatchObject({ type: "ask", msg: "q q1" });
        send(notice("alertToast", { message: "toast" }));
        send(notice("alertNormal", { message: "modal" }));
        send(question("q2", "alertInput", { message: "name?", defaultValue: "d" }));
        await pump();
        // Nothing replaced the question in the shared store.
        expect(alert()).toMatchObject({ type: "ask", msg: "q q1" });
        expect(tx.answers).toEqual([]);
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "q1", outcome: "answered", value: true }]);
        // The toast is not awaited; the modal notice is, then the next question.
        expect(alert()).toMatchObject({ type: "normal", msg: "modal" });
        userAnswers("");
        await pump();
        expect(alert()).toMatchObject({ type: "input", msg: "name?", defaultValue: "d" });
        userAnswers("typed");
        await pump();
        expect(tx.answers[1]).toEqual({ type: "answer", id: "q2", outcome: "answered", value: "typed" });
        // The other kinds: a selection's index, a refusal, a character, a module (its own poller).
        send(question("q3", "alertSelect", { options: ["x", "y"], display: "pick" }));
        expect(alert()).toMatchObject({ type: "select", msg: "__DISPLAY__pick||x||y" });
        userAnswers("1");
        await pump();
        send(question("q4", "alertConfirm", { message: "sure?" }));
        userAnswers("no");
        await pump();
        send(question("q5", "alertSelectChar", {}));
        expect(alert().type).toBe("selectChar");
        userAnswers("chaId-1");
        await pump();
        send(question("q6", "alertModuleSelect", {}));
        expect(alert().type).toBe("selectModule");
        userAnswers("module-1");
        await pump(50);
        expect(tx.answers.slice(2).map((answer) => [answer.id, (answer as { value: unknown }).value])).toEqual([
            ["q3", "1"],
            ["q4", false],
            ["q5", "chaId-1"],
            ["q6", "module-1"],
        ]);
    });

    it("shows a toast at once while idle, awaits a modal notice before a later question, and applies the other effects directly", async () => {
        send(notice("alertToast", { message: "now" }));
        expect(alert()).toMatchObject({ type: "toast", msg: "now" });
        send(notice("alertWait", { message: "working" }));
        expect(alert()).toMatchObject({ type: "wait", msg: "working" });
        send(notice("alertClear"));
        expect(alert().type).toBe("none");
        send(notice("alertError", { message: "oops" }));
        send(question("q1"));
        expect(alert()).toMatchObject({ type: "error", msg: "oops" });
        await pump();
        expect(alert().type).toBe("error");
        userAnswers("");
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q q1" });
        send(cancel("q1"));

        send(notice("reloadDisplay"));
        send(notice("updateGUI"));
        expect(get(stores.ReloadGUIPointer)).toBe(2);
        // A chat reload names the message; only the chat the screen shows is bumped.
        send(notice("reloadChat", { chaId: "c", chatId: "k", messageId: "m2" }));
        send(notice("reloadChat", { chaId: "c", chatId: "other", messageId: "m2" }));
        send(notice("reloadChat", { chaId: "c", chatId: "k", messageId: "gone" }));
        expect(get(stores.ReloadChatPointer)).toEqual({ 1: 1 });
        send(notice("emotion", { chaId: "c", name: "joy", image: "img" }));
        expect(get(stores.CharEmotion).c).toEqual([["joy", "img", expect.any(Number)]]);
        send(notice("progress", { open: true, miniMsg: "a", msg: "b", subMsg: "c" }));
        expect(get(stores.hypaV3ProgressStore)).toEqual({ open: true, miniMsg: "a", msg: "b", subMsg: "c" });
        send(notice("tts", { chaId: "c", text: "hello" }));
        send(notice("tts", { chaId: "nope", text: "hello" }));
        await pump();
        expect(deps.sayTTS).toHaveBeenCalledTimes(1);
        expect(deps.sayTTS.mock.calls[0][1]).toBe("hello");
    });

    it("drops a cancelled queued question, closes only the alert the showing one owns, releases the queue, and never sends its late result", async () => {
        send(question("q1"));
        send(question("q2"));
        send(cancel("q2"));
        send(cancel("q1"));
        expect(alert().type).toBe("none");
        await pump();
        expect(tx.answers).toEqual([]);
        // Local UI replaced the job's alert: a cancel leaves it, but the queue moves on.
        send(question("q3"));
        expect(alert()).toMatchObject({ type: "ask", msg: "q q3" });
        stores.alertStore.set({ type: "wait", msg: "local" });
        send(cancel("q3"));
        await pump();
        expect(alert()).toMatchObject({ type: "wait", msg: "local" });
        send(question("q4"));
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q q4" });
        // Both q3's abandoned poller and q4's see this answer; only q4 is answered.
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "q4", outcome: "answered", value: true }]);
        // A cancelled question delivered again stays dropped; an answered one is answered from the cache.
        send(question("q3", "alertConfirm", { message: "q q3" }, { replay: true }));
        send(question("q4", "alertConfirm", { message: "q q4" }, { replay: true }));
        expect(alert().type).toBe("none");
        expect(tx.answers).toHaveLength(2);
        expect(tx.answers[1].id).toBe("q4");
        // A replay this page never saw is presented; a duplicate while it waits is not shown twice.
        send(question("q5", "alertConfirm", { message: "q q5" }, { replay: true }));
        send(question("q5", "alertConfirm", { message: "q q5" }, { replay: true }));
        expect(alert()).toMatchObject({ type: "ask", msg: "q q5" });
        userAnswers("no");
        await pump();
        expect(tx.answers.map((answer) => answer.id)).toEqual(["q4", "q4", "q5"]);
    });

    it("closes the showing question and drops the queued ones of a job that ended, keeping another job's", async () => {
        send(question("q1"));
        send(question("q2"));
        send(question("k1", "alertConfirm", { message: "other job" }), "K");
        channel.endJobChannel("J");
        expect(alert().type).toBe("none");
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "other job" });
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "k1", outcome: "answered", value: true }]);
        // The ended job's question delivered again (its cancel was lost) is not reopened.
        send(question("q1"));
        expect(alert().type).toBe("none");
    });

    it("keeps the remembered requests bounded: the oldest cancelled ones are forgotten, the recent ones stay suppressed", async () => {
        for (let index = 0; index < 505; index += 1) {
            send(question(`c${index}`));
            send(cancel(`c${index}`));
        }
        channel.endJobChannel("J");
        await pump();
        expect(alert().type).toBe("none");
        send(question("c5"));
        await pump();
        expect(alert().type).toBe("none");
        send(question("c4"));
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q c4" });
    });
});

describe("callbacks", () => {
    it("runs the hook set in order under the job's targets behind the barrier, flushes its writes in a scope, and answers the JSON result", async () => {
        const seen: string[] = [];
        hooks.editoutput.add(async (text) => {
            seen.push(`a:${text}`);
            expect(channel.currentChannelCall()).toEqual({ jobId: "J", callbackId: "cb", targets });
            return null;
        });
        hooks.editoutput.add((text) => {
            seen.push(`b:${text}`);
            return text.toUpperCase();
        });
        deps.heldChat.mockReturnValue(rev(2, 1));
        send(
            callback(
                "cb",
                "editoutput",
                { text: "hi" },
                { revisions: [{ kind: "chats", id: "k", characterId: "c", revision: rev(2, 1) }] },
            ),
        );
        await pump();
        expect(seen).toEqual(["a:hi", "b:hi"]);
        expect(deps.contexts).toEqual([targets, targets]);
        expect(deps.flush.mock.calls).toEqual([[undefined], [{ scope: { resource: 7, chat: 3 } }]]);
        expect(tx.answers).toEqual([{ type: "answer", id: "cb", outcome: "answered", value: "HI" }]);
        expect(channel.currentChannelCall()).toBeNull();
        expect(deps.applyHydration).not.toHaveBeenCalled();
    });

    it("fails the barrier before any hook runs: a rejected or discarding pre-flush, a record not held at the receipt's revision, another epoch; a remembered hydration is applied again first", async () => {
        const hook = vi.fn(() => "x");
        hooks.editoutput.add(hook);
        deps.flush.mockRejectedValueOnce(new Error("quarantined"));
        send(callback("f1"));
        await pump();
        expect(tx.answers[0]).toEqual(failed("barrier", /Local changes could not be saved: quarantined/));
        deps.flush.mockResolvedValueOnce({ discarded: ["characters/c"] });
        send(callback("f2"));
        await pump();
        expect(tx.answers[1]).toEqual(
            failed("barrier", /discarded local changes before the callback/, ["characters/c"]),
        );
        const receipt = { kind: "chats", id: "k", characterId: "c", revision: rev(1, 5) };
        send(callback("f3", "editoutput", { text: "t" }, { revisions: [receipt] }));
        await pump();
        expect(tx.answers[2]).toEqual(failed("barrier", /chats record k the job changed is not applied/));
        send(
            callback(
                "f4",
                "editoutput",
                { text: "t" },
                { revisions: [{ ...receipt, revision: rev(1, 1, "22222222-2222-4333-8444-555555555555") }] },
            ),
        );
        await pump();
        expect(tx.answers[3]).toEqual(failed("barrier", /not applied/));
        expect(hook).not.toHaveBeenCalled();
        expect(deps.applyHydration).not.toHaveBeenCalled();
        // The newest remembered hydration is applied again once local work settled.
        const record = { kind: "chats", id: "k", characterId: "c", revision: rev(1, 5), data: {} };
        channel.rememberHydration({ ...record, revision: rev(1, 4) });
        channel.rememberHydration(record);
        channel.rememberHydration({ ...record, revision: rev(1, 3) });
        deps.applyHydration.mockImplementation(() => {
            deps.heldChat.mockReturnValue(rev(1, 5));
            return true;
        });
        send(callback("f5", "editoutput", { text: "t" }, { revisions: [receipt] }));
        await pump();
        expect(deps.applyHydration).toHaveBeenCalledWith(record);
        expect(tx.answers[4]).toEqual({ type: "answer", id: "f5", outcome: "answered", value: "x" });
        expect(hook).toHaveBeenCalledTimes(1);
        // A non-chat record goes through the record accessor, and a newer held revision passes.
        deps.heldRecord.mockReturnValue(rev(9, 1));
        send(
            callback(
                "f6",
                "editoutput",
                { text: "t" },
                { revisions: [{ kind: "characters", id: "c", revision: rev(3, 1) }] },
            ),
        );
        await pump();
        expect(tx.answers[5]).toMatchObject({ outcome: "answered" });
        expect(deps.heldRecord).toHaveBeenCalledWith("characters", "c");
    });

    it("settles the hook's writes even when it threw: a discard or a rejected flush is a barrier failure, else the throw is a hook failure with its text", async () => {
        let behavior: () => unknown = () => "ok";
        hooks.editoutput.add(() => behavior() as string);
        behavior = () => {
            throw new Error("bad hook");
        };
        send(callback("h1"));
        await pump();
        expect(tx.answers[0]).toEqual(failed("hook", "bad hook"));
        expect(deps.flush).toHaveBeenCalledTimes(2);
        behavior = () => {
            throw 0;
        };
        send(callback("h2"));
        await pump();
        expect(tx.answers[1]).toEqual(failed("hook", "0"));
        behavior = () => {
            throw undefined;
        };
        send(callback("h3"));
        await pump();
        expect(tx.answers[2]).toEqual(failed("hook", "undefined"));
        behavior = () => "fine";
        deps.flush.mockResolvedValueOnce({ discarded: [] }).mockResolvedValueOnce({ discarded: ["chats/c/k"] });
        send(callback("h4"));
        await pump();
        expect(tx.answers[3]).toEqual(failed("barrier", /discarded changes the callback made/, ["chats/c/k"]));
        behavior = () => {
            throw new Error("thrown, but the barrier wins");
        };
        deps.flush.mockResolvedValueOnce({ discarded: [] }).mockRejectedValueOnce(new Error("halted"));
        send(callback("h5"));
        await pump();
        expect(tx.answers[4]).toEqual(failed("barrier", /could not be saved: halted/));
    });

    it("answers a protocol failure for a result that cannot cross the wire, and round-trips an ordinary one", async () => {
        // An after-request replacer's result is sent as is (an edit hook's null keeps the text).
        let result: unknown;
        hooks.replacerafterRequest.add(() => result as string);
        const cases: [unknown, RegExp][] = [
            [undefined, /returned no JSON value/],
            [() => 1, /returned no JSON value/],
            [10n, /not JSON/],
        ];
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        cases.push([cyclic, /not JSON/]);
        const payload = { text: "t", model: "m" };
        for (const [index, [value, message]] of cases.entries()) {
            result = value;
            send(callback(`r${index}`, "replacerafterRequest", payload));
            await pump();
            expect(tx.answers[index]).toEqual(failed("protocol", message));
        }
        result = { text: "ok", nested: [1, { deep: true }], gone: undefined };
        send(callback("ok", "replacerafterRequest", payload));
        await pump();
        expect(tx.answers[4]).toEqual({
            type: "answer",
            id: "ok",
            outcome: "answered",
            value: { text: "ok", nested: [1, { deep: true }] },
        });
    });

    it("refuses an unavailable hook set and the callbacks later slices own; replacers stop at the first throw, interceptors continue per entry without the hook context", async () => {
        for (const event of [
            callback("u1", "editoutput"),
            callback("u2", "mcpTool", { identifier: "plugin:x", tool: "t", args: {} }),
            callback("u3", "chatOutput", {}),
            callback("u4", "provider", { name: "p" }),
        ]) {
            send(event);
            await pump();
        }
        expect(tx.answers.map((answer) => (answer as { error: string }).error)).toEqual([
            "The editoutput hook is not registered any more",
            "The mcpTool hook is not registered any more",
            "The chatOutput callback is not supported yet",
            "The provider callback is not supported yet",
        ]);
        expect(tx.answers.every((answer) => (answer as { failure: string }).failure === "protocol")).toBe(true);
        const second = vi.fn((messages: unknown) => messages);
        hooks.replacerbeforeRequest.add(() => {
            throw new Error("first replacer");
        });
        hooks.replacerbeforeRequest.add(second as never);
        send(callback("rep", "replacerbeforeRequest", { messages: [{ role: "user", content: "m" }], model: "gpt" }));
        await pump();
        expect(tx.answers[4]).toEqual(failed("hook", "first replacer"));
        expect(second).not.toHaveBeenCalled();
        hooks.replacerafterRequest.add(async (text, model) => `${text}/${model}`);
        send(callback("after", "replacerafterRequest", { text: "out", model: "gpt" }));
        await pump();
        expect(tx.answers[5]).toMatchObject({ outcome: "answered", value: "out/gpt" });
        deps.contexts.length = 0;
        stores.bodyIntercepterStore.push(
            {
                id: "throws",
                callback: async () => {
                    throw new Error("interceptor");
                },
            },
            { id: "empty", callback: async () => null },
            { id: "adds", callback: async (body: unknown, type: string) => ({ ...(body as object), type }) },
        );
        send(callback("int", "bodyIntercepter", { body: { a: 1 }, type: "openai" }));
        await pump();
        expect(tx.answers[6]).toMatchObject({ outcome: "answered", value: { a: 1, type: "openai" } });
        expect(deps.contexts).toEqual([]);
        deps.mcps.set("plugin:x", {
            callTool: async (tool, args) => [{ type: "text", text: `${tool}:${JSON.stringify(args)}` }],
        });
        send(callback("mcp", "mcpTool", { identifier: "plugin:x", tool: "sum", args: { n: 2 } }));
        await pump();
        expect(tx.answers[7]).toMatchObject({ outcome: "answered", value: [{ type: "text", text: 'sum:{"n":2}' }] });
        expect(deps.contexts).toEqual([]);
    });

    it("starts nothing after a cancel: not a tool behind a pending pre-flush, not the next hook of a set; the result is kept but not sent", async () => {
        const flushing = deferred<{ discarded: string[] }>();
        deps.flush.mockReturnValueOnce(flushing.promise);
        const tool = vi.fn(async () => []);
        deps.mcps.set("plugin:x", { callTool: tool });
        send(callback("m", "mcpTool", { identifier: "plugin:x", tool: "t", args: {} }));
        send(cancel("m"));
        flushing.resolve({ discarded: [] });
        await pump();
        expect(tool).not.toHaveBeenCalled();
        expect(tx.answers).toEqual([]);
        // Between two hooks: the first one is running when the cancel arrives.
        const running = deferred<string>();
        const second = vi.fn((text: string) => text);
        hooks.editoutput.add(() => running.promise);
        hooks.editoutput.add(second);
        send(callback("e"));
        await pump();
        send(cancel("e"));
        running.resolve("done");
        await pump();
        expect(second).not.toHaveBeenCalled();
        expect(tx.answers).toEqual([]);
        // The mutations of what did run were still settled (the scoped flush ran).
        expect(deps.flush).toHaveBeenCalledTimes(4);
        // The lane is free again: both hooks run for the next callback (the first resolves at once now).
        send(callback("next"));
        await pump();
        expect(second).toHaveBeenCalledTimes(1);
        expect(tx.answers).toEqual([{ type: "answer", id: "next", outcome: "answered", value: "done" }]);
    });

    it("never runs a callback twice: a duplicate while it runs answers once on the newest transport, a completed one is answered from the cache, and a replay without state is refused", async () => {
        const running = deferred<string>();
        const hook = vi.fn(() => running.promise);
        hooks.editoutput.add(hook);
        send(callback("cb"));
        await pump();
        const newer = transport();
        send(callback("cb", "editoutput", { text: "t" }, { replay: true }), "J", newer);
        await pump();
        expect(hook).toHaveBeenCalledTimes(1);
        running.resolve("R");
        await pump();
        expect(tx.answers).toEqual([]);
        expect(newer.answers).toEqual([{ type: "answer", id: "cb", outcome: "answered", value: "R" }]);
        send(callback("cb", "editoutput", { text: "t" }, { replay: true }), "J", newer);
        await pump();
        expect(newer.answers).toHaveLength(2);
        expect(hook).toHaveBeenCalledTimes(1);
        send(callback("unknown", "editoutput", { text: "t" }, { replay: true }), "J", newer);
        await pump();
        expect(newer.answers[2]).toEqual(failed("protocol", /may already have run before this page loaded/));
        // Refused once, refused the same way on a later duplicate.
        send(callback("unknown", "editoutput", { text: "t" }, { replay: true }), "J", newer);
        await pump();
        expect(newer.answers[3]).toEqual(newer.answers[2]);
    });

    it("keeps one outstanding callback with one child: a second root and a third level are refused, a child must name the top", async () => {
        const parent = deferred<string>();
        const child = deferred<string>();
        let turn = 0;
        hooks.editoutput.add(() => (turn++ === 0 ? parent.promise : child.promise));
        send(callback("p"));
        await pump();
        send(callback("root2"));
        send(callback("wrong", "editoutput", { text: "t" }, { parentId: "nope" }));
        await pump();
        expect(tx.answers.map((answer) => answer.id)).toEqual(["root2", "wrong"]);
        expect(
            tx.answers.every((answer) => /only inside the outstanding one/.test((answer as { error: string }).error)),
        ).toBe(true);
        // An aux request's callback arrives on the aux job's own socket.
        send(callback("c", "editoutput", { text: "t" }, { parentId: "p", jobId: "aux" }), "aux");
        await pump();
        expect(channel.currentChannelCall()).toMatchObject({ jobId: "aux", callbackId: "c" });
        send(callback("g", "editoutput", { text: "t" }, { parentId: "c" }));
        await pump();
        expect(tx.answers[2]).toEqual(failed("protocol", /one level deep/));
        child.resolve("C");
        await pump();
        expect(tx.answers[3]).toMatchObject({ id: "c", outcome: "answered", value: "C" });
        expect(channel.currentChannelCall()).toMatchObject({ callbackId: "p" });
        parent.resolve("P");
        await pump();
        expect(tx.answers[4]).toMatchObject({ id: "p", outcome: "answered", value: "P" });
        expect(channel.currentChannelCall()).toBeNull();
    });

    it("protects a running parent from cache pressure: after 505 completed children a replay of it is neither refused nor run again", async () => {
        const parent = deferred<string>();
        const hook = vi.fn((text: string) => (text === "parent" ? parent.promise : text));
        hooks.editoutput.add(hook);
        send(callback("p", "editoutput", { text: "parent" }));
        await pump();
        for (let index = 0; index < 505; index += 1) {
            send(callback(`child${index}`, "editoutput", { text: `child${index}` }, { parentId: "p" }));
            await vi.advanceTimersByTimeAsync(1);
        }
        expect(tx.answers).toHaveLength(505);
        send(callback("p", "editoutput", { text: "parent" }, { replay: true }));
        await pump();
        expect(hook).toHaveBeenCalledTimes(506);
        expect(tx.answers).toHaveLength(505);
        parent.resolve("P");
        await pump();
        expect(tx.answers).toHaveLength(506);
        expect(tx.answers[505]).toMatchObject({ id: "p", outcome: "answered", value: "P" });
    });

    it("stops answering for a job that ended while its callback runs", async () => {
        const running = deferred<string>();
        hooks.editoutput.add(() => running.promise);
        send(callback("cb"));
        await pump();
        channel.endJobChannel("J");
        running.resolve("late");
        await pump();
        expect(tx.answers).toEqual([]);
    });

    it("lists the registered hooks from the live registries with a copy of each provider descriptor", async () => {
        expect(await channel.registeredHooks()).toEqual({
            replacers: { beforeRequest: false, afterRequest: false },
            scripts: [],
            interceptors: false,
            chatOutput: false,
            providers: [],
            mcpTools: [],
        });
        hooks.replacerafterRequest.add((text) => text);
        hooks.editinput.add((text) => text);
        hooks.editdisplay.add((text) => text);
        hooks.chatOutput.add(() => {});
        hooks.providers.set("prov", async () => ({ success: true, content: "" }));
        stores.bodyIntercepterStore.push({ id: "i", callback: async (body) => body });
        deps.mcps.set("plugin:tool", { callTool: async () => [] });
        const listed = await channel.registeredHooks();
        expect(listed).toEqual({
            replacers: { beforeRequest: false, afterRequest: true },
            scripts: ["editinput", "editdisplay"],
            interceptors: true,
            chatOutput: true,
            providers: [{ name: "prov", model: deps.getModelInfo("pluginmodel:::prov") }],
            mcpTools: ["plugin:tool"],
        });
        expect(deps.getModelInfo).toHaveBeenCalledWith("pluginmodel:::prov");
        expect(listed.providers[0].model).not.toBe(deps.getModelInfo.mock.results[0].value);
    });
});

describe("the HypaV3 progress overlay", () => {
    // Phase 5 slice 10: the overlay is owned by the job whose `progress` notice opened it. Another
    // job's closing notice does not close it; the owner's does, and so does the owner's end (an abort
    // closes the channel before the server's closing notice can arrive). A job that ends while
    // another owns the overlay leaves it open.
    const progress = (open: boolean, msg: string) => notice("progress", { open, miniMsg: "", msg, subMsg: "" });
    const overlay = () => get(stores.hypaV3ProgressStore);
    const closed = { open: false, miniMsg: "", msg: "", subMsg: "" };

    it("ignores another job's closing notice while the opening job's overlay shows, and closes on the owner's", () => {
        send(progress(true, "A works"), "A");
        send(progress(true, "B works"), "B");
        expect(overlay()).toMatchObject({ open: true, msg: "B works" });
        send(progress(false, "A done"), "A");
        expect(overlay()).toMatchObject({ open: true, msg: "B works" });
        send(progress(false, ""), "B");
        expect(overlay()).toEqual(closed);
        // Nothing owns it now: a closing notice of any job applies, an opening one takes it.
        send(progress(false, "late"), "A");
        expect(overlay()).toMatchObject({ open: false, msg: "late" });
        send(progress(true, "A again"), "A");
        expect(overlay()).toMatchObject({ open: true, msg: "A again" });
    });

    it("closes the overlay when the owning job ends without a closing notice, and keeps it when another job ends", () => {
        send(progress(true, "A works"), "A");
        send(progress(true, "B works"), "B");
        channel.endJobChannel("A");
        expect(overlay()).toMatchObject({ open: true, msg: "B works" });
        channel.endJobChannel("B");
        expect(overlay()).toEqual(closed);
        // A preview job owns it the same way.
        send(progress(true, "preview works"), "P");
        channel.endJobChannel("P");
        expect(overlay()).toEqual(closed);
        // The ended owner's late closing notice changes nothing.
        send(progress(true, "C works"), "C");
        send(progress(false, ""), "B");
        expect(overlay()).toMatchObject({ open: true, msg: "C works" });
    });
});
