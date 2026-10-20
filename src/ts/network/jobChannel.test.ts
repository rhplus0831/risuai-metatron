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
import { MAX_PROVIDER_TEXT_CHARS } from "../../../shared/jobs.ts";
import { createAlertQueue, type AlertQueue } from "../alertQueue";

// Phase 5 slice 6, the client dispatcher of the job channel (`jobChannel.ts`) with controlled
// persistence and plugin dependencies and the real alert module over the real alert queue (RisuNest
// small wins slice A1; a fresh queue per test, with no gap): the one UI queue (questions answered
// with the alert's raw value, toasts and modal notices queued behind an open question, cancellation
// and the job's end removing only the dialog they own, shown or queued behind a local one, stale
// results dropped, bounded memory), and the callbacks (the barrier before and after the hook with its
// failure taxonomy, cancellation stopping unstarted work, results that cannot cross the wire,
// duplicates and replays, the nesting rules, cache pressure, the hook list). The real stores are
// behind the barrier in `jobChannelBarrier.test.ts`.

/** A chat the mocked chat module holds for a character of the fixture. */
type FixtureChat = { id: string; message?: { chatId: string }[] };

const deps = vi.hoisted(() => ({
    /** The alert queue of the test running (`stores.alertStore` reaches it through a proxy). */
    alertQueue: null as unknown as AlertQueue,
    flush: vi.fn<(options?: { scope?: unknown }) => Promise<{ discarded: string[] }>>(),
    applyHydration: vi.fn<(record: unknown) => boolean>(),
    heldChat: vi.fn<(ref: { chaId: string; chatId: string }) => string | null>(),
    heldRecord: vi.fn<(kind: string, id: string) => string | null>(),
    contexts: [] as unknown[],
    selection: null as { characterId: string | null } | null,
    /** The chats the mocked chat module holds, by character (the selected one at `chatPage`). */
    chats: {} as Record<string, { chatPage?: number; chats: { id: string; message?: { chatId: string }[] }[] }>,
    mcps: new Map<string, { callTool: (tool: string, args: unknown) => Promise<unknown> }>(),
    sayTTS: vi.fn(),
    showCompletion: vi.fn(async (_payload: unknown) => {}),
    followTranslations: vi.fn<(ref: unknown, ids: unknown, follow: { report: (message: string) => void }) => void>(),
    stableDiff: vi.fn<(char: unknown, text: string, target: { check?: () => void }) => Promise<unknown>>(),
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
// The chat module's readers the dispatcher calls (Phase 6 slice 9a), over the fixture's chats
// (`deps.chats`, by character, the selected chat at `chatPage`); the characters themselves are in
// the real records (`characterList()`, installed in `beforeEach`). The selected character is the
// real selection's (`deps.selection`, set in `beforeEach`).
vi.mock("../storage/chatStore.svelte", () => {
    const owner = (chaId: string) => deps.chats[chaId];
    const selectedChatId = (chaId: string) => {
        const found = owner(chaId);
        return found?.chats?.[found.chatPage ?? 0]?.id ?? null;
    };
    return {
        heldChatRevision: (ref: { chaId: string; chatId: string }) => deps.heldChat(ref),
        selectedChatId,
        currentChatRef: () => {
            const chaId = deps.selection?.characterId ?? null;
            const chatId = chaId === null ? null : selectedChatId(chaId);
            return chaId !== null && chatId !== null ? { chaId, chatId } : null;
        },
        findChat: (ref: { chaId: string; chatId: string }) =>
            owner(ref.chaId)?.chats?.find((chat) => chat.id === ref.chatId),
        // The speaker's pin and load before each output listener (Phase 6 slice 9b): the fixture's
        // chats are all held here, so a load answers them at once.
        pinChats: () => () => {},
        loadChats: async (chaId: string) => owner(chaId)?.chats ?? [],
        chatList: (chaId: string) =>
            (owner(chaId)?.chats ?? []).map((chat) => ({ id: chat.id, name: "", fmIndex: -1 })),
        withChatsCopy: (copy: { chaId: string }) => ({
            ...copy,
            chats: JSON.parse(JSON.stringify(owner(copy.chaId)?.chats ?? [])),
            chatPage: owner(copy.chaId)?.chatPage ?? 0,
        }),
    };
});
vi.mock("../stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return {
        alertStore: new Proxy({} as AlertQueue, { get: (_target, key) => Reflect.get(deps.alertQueue, key) }),
        ReloadGUIPointer: writable(0),
        ReloadChatPointer: writable({} as Record<string, number>),
        reloadChatKey: (messageId: string | undefined, idx: number) =>
            messageId !== undefined ? `m:${messageId}` : `i:${idx}`,
        CharEmotion: writable({} as Record<string, [string, string, number][]>),
        hypaV3ProgressStore: writable({ open: false, miniMsg: "", msg: "", subMsg: "" }),
        bodyIntercepterStore: [] as { id: string; callback: (body: unknown, type: string) => Promise<unknown> }[],
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
vi.mock("../storage/database.svelte", () => ({}));
vi.mock("../process/tts", () => ({ sayTTS: deps.sayTTS }));
vi.mock("./pushNotifications", () => ({ showCompletionNotification: deps.showCompletion }));
vi.mock("../translator/storedTranslation.svelte", () => ({
    followStoredTranslations: (ref: unknown, ids: unknown, follow: { report: (message: string) => void }) =>
        deps.followTranslations(ref, ids, follow),
}));
vi.mock("../process/stableDiff", () => ({ stableDiff: deps.stableDiff }));
vi.mock("../model/modellist", () => ({ getModelInfo: deps.getModelInfo }));

type Channel = typeof import("./jobChannel");
type Stores = typeof import("../stores.svelte");
type Hooks = typeof import("../plugins/pluginHooks");
type CharacterStore = typeof import("../storage/characterStore.svelte");
type Records = typeof import("../storage/records.svelte");

const EPOCH = "11111111-2222-4333-8444-555555555555";
/** A revision token of the loaded epoch (`<epoch>:<seq>:<revision>`). */
const rev = (seq: number, revision: number, epoch = EPOCH) => `${epoch}:${seq}:${revision}`;
const targets: CallbackTargets = {
    chatRef: { chaId: "c", chatId: "k" },
    presetId: "p",
    modelPresetId: "m",
    personaId: "u",
};
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
let characterStore: CharacterStore;
let records: Records;
/** The fixture's chats: character `c` with chat `k` (messages m1, m2). */
const fixtureChats = (): typeof deps.chats => ({
    c: { chatPage: 0, chats: [{ id: "k", message: [{ chatId: "m1" }, { chatId: "m2" }] }] },
});
/**
 * Puts `character` into the real record list for `body` (the chat module's mock holds `chats` for
 * it), and takes it out again: the membership change of a mocked chat module goes to the records
 * directly, as `characterStore.addCharacter` would hand the chats to the real one.
 */
async function withCharacter(
    character: { chaId: string } & Record<string, unknown>,
    chats: { chatPage?: number; chats: FixtureChat[] } | null,
    body: () => Promise<void> | void,
) {
    records.insertCharacterRecord(character);
    if (chats) {
        deps.chats[character.chaId] = chats;
    }
    try {
        await body();
    } finally {
        records.removeCharacterRecords([character.chaId]);
        delete deps.chats[character.chaId];
    }
}
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
/** Lets the alert queue's gap (0 ms here) and the callback chain run. */
const pump = (ms = 30) => vi.advanceTimersByTimeAsync(ms);
const alert = () => get(stores.alertStore);
/** The user answers the shown dialog the way `AlertComp` does. */
const userAnswers = (msg: string) => stores.alertStore.answer(msg);

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
    deps.showCompletion.mockReset();
    deps.stableDiff.mockReset();
    deps.followTranslations.mockReset();
    deps.alertQueue = createAlertQueue({ type: "none", msg: "" }, { gapMs: 0 });
    stores = await import("../stores.svelte");
    // The mocked stores module outlives `resetModules`: start each test from idle registries.
    stores.bodyIntercepterStore.length = 0;
    stores.ReloadGUIPointer.set(0);
    stores.ReloadChatPointer.set({});
    stores.CharEmotion.set({});
    hooks = (await import("../plugins/pluginHooks")).pluginHooks;
    channel = await import("./jobChannel");
    // The fixture: character `c` in the real records (its chats in the chat module's mock), shown
    // by the tab (the readers resolve it by `selection.characterId`).
    characterStore = await import("../storage/characterStore.svelte");
    records = await import("../storage/records.svelte");
    records.initializeRecords({ characters: [{ chaId: "c", type: "character" }] });
    for (const chaId of Object.keys(deps.chats)) {
        delete deps.chats[chaId];
    }
    Object.assign(deps.chats, fixtureChats());
    const selectionModule = await import("../storage/selection.svelte");
    selectionModule.selectCharacter("c");
    deps.selection = selectionModule.selection;
    expect(deps.selection.characterId).toBe("c");
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

    it("shows the memoryTrim question as a localized selection and answers only a button's choice", async () => {
        // The mocked `language` is the dispatcher's own instance: the strings it shows.
        const { language } = await import("../../lang");
        Object.assign(language, {
            memoryTrimWarning: "memory is off",
            memoryTrimEnable: "turn on",
            memoryTrimOnce: "once",
            memoryTrimIgnore: "ignore",
        });
        send(question("q1", "memoryTrim", {}));
        expect(alert()).toMatchObject({ type: "select", msg: "__DISPLAY__memory is off||turn on||once||ignore" });
        userAnswers("0");
        await pump();
        send(question("q2", "memoryTrim", {}));
        userAnswers("1");
        await pump();
        send(question("q3", "memoryTrim", {}));
        userAnswers("2");
        await pump();
        // Not a button: a closed alert, an index out of range, a choice name typed in.
        send(question("q4", "memoryTrim", {}));
        userAnswers("");
        await pump();
        send(question("q5", "memoryTrim", {}));
        userAnswers("3");
        await pump();
        send(question("q6", "memoryTrim", {}));
        userAnswers("memory");
        await pump();
        expect(tx.answers).toEqual([
            { type: "answer", id: "q1", outcome: "answered", value: "memory" },
            { type: "answer", id: "q2", outcome: "answered", value: "once" },
            { type: "answer", id: "q3", outcome: "answered", value: "ignore" },
            { type: "answer", id: "q4", outcome: "answered", value: null },
            { type: "answer", id: "q5", outcome: "answered", value: null },
            { type: "answer", id: "q6", outcome: "answered", value: null },
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
        expect(get(stores.ReloadChatPointer)).toEqual({ "m:m2": 1 });
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

    it("a notification notice (docs/plan/web-push.md) shows the server's completion text through pushNotifications while the setting is on, and nothing asks for the permission here", async () => {
        const { settings } = await import("../storage/settingsViews.svelte");
        const payload = {
            chaId: "c",
            chatId: "k",
            title: "Risuai",
            body: "Ann's message has been processed.",
            url: "/chat/c/k",
            tag: "risuai-chat-completion",
        };
        settings.ui.notification = false;
        send(notice("notification", payload));
        await pump();
        expect(deps.showCompletion).not.toHaveBeenCalled();
        settings.ui.notification = true;
        send(notice("notification", payload));
        await pump();
        expect(deps.showCompletion).toHaveBeenCalledTimes(1);
        expect(deps.showCompletion).toHaveBeenCalledWith(payload);
        expect(typeof Notification).toBe("undefined");
    });

    it("a translating notice (slice 2.3) starts following the named messages, with a reporter whose failures queue behind a question like an alertError notice; a malformed payload is dropped", async () => {
        send(notice("translating", { chaId: "c", chatId: "k", messageIds: ["m1", "m2"] }));
        await pump();
        expect(deps.followTranslations).toHaveBeenCalledTimes(1);
        const [ref, ids, follow] = deps.followTranslations.mock.calls[0];
        expect(ref).toEqual({ chaId: "c", chatId: "k" });
        expect(ids).toEqual(["m1", "m2"]);
        // The next send asks a question; the translation fails meanwhile: the question stays, and the
        // failure shows after its answer, which is the user's (Astra's challenge of the plan).
        send(question("q1", "alertConfirm", { message: "sure?" }), "J2");
        expect(alert()).toMatchObject({ type: "ask", msg: "sure?" });
        follow.report("translation broke");
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "sure?" });
        expect(tx.answers).toEqual([]);
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "q1", outcome: "answered", value: true }]);
        expect(alert()).toMatchObject({ type: "error", msg: "translation broke" });
        userAnswers("");
        await pump();
        expect(alert().type).toBe("none");
        // Idle: the report shows at once, as a modal notice does.
        follow.report("again");
        await pump();
        expect(alert()).toMatchObject({ type: "error", msg: "again" });
        userAnswers("");
        await pump();

        for (const payload of [
            { chaId: "c", chatId: "k", messageIds: ["m1", 2] },
            { chaId: 1, chatId: "k", messageIds: ["m1"] },
            { chaId: "c", chatId: "k", messageIds: "m1" },
            { chaId: "c", messageIds: ["m1"] },
        ]) {
            send(notice("translating", payload));
        }
        await pump();
        expect(deps.followTranslations).toHaveBeenCalledTimes(1);
    });

    it("drops a cancelled queued question, removes only the dialog the showing one owns, releases the queue, and never sends its late result", async () => {
        send(question("q1"));
        send(question("q2"));
        send(cancel("q2"));
        send(cancel("q1"));
        expect(alert().type).toBe("none");
        await pump();
        expect(tx.answers).toEqual([]);
        // A local status set while the question shows does not replace it; the cancel removes the
        // question's own dialog, and the status set after it shows then.
        send(question("q3"));
        expect(alert()).toMatchObject({ type: "ask", msg: "q q3" });
        stores.alertStore.set({ type: "wait", msg: "local" });
        expect(alert()).toMatchObject({ type: "ask", msg: "q q3" });
        send(cancel("q3"));
        await pump();
        expect(alert()).toMatchObject({ type: "wait", msg: "local" });
        send(question("q4"));
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q q4" });
        // q3's dialog closed with "" when cancelled and its result was dropped; only q4 is answered.
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

    it("a local alert shown during a job question does not replace it, and a job's dialog waits behind local ones", async () => {
        send(question("q1"));
        expect(alert()).toMatchObject({ type: "ask", msg: "q q1" });
        // A local dialog and a local status while the question shows: the question stays.
        const local = stores.alertStore.open({ type: "normal", msg: "local notice" });
        stores.alertStore.set({ type: "wait", msg: "local wait" });
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q q1" });
        expect(tx.answers).toEqual([]);
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "q1", outcome: "answered", value: true }]);
        // The local dialog follows; a question asked meanwhile waits behind it, and a status set
        // after that question shows once every dialog closed.
        expect(alert()).toMatchObject({ type: "normal", msg: "local notice" });
        send(question("q2"));
        stores.alertStore.set({ type: "toast", msg: "copied" });
        await pump();
        expect(alert()).toMatchObject({ type: "normal", msg: "local notice" });
        userAnswers("");
        await expect(local.closed).resolves.toBe("");
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "q q2" });
        userAnswers("no");
        await pump();
        expect(tx.answers[1]).toEqual({ type: "answer", id: "q2", outcome: "answered", value: false });
        expect(alert()).toEqual({ type: "toast", msg: "copied" });
    });

    it("a cancelled question whose dialog waits behind a local one resolves nothing and leaves no waiter; the job's end does the same", async () => {
        const local = stores.alertStore.open({ type: "normal", msg: "local notice" });
        send(question("q1"));
        send(question("q2"));
        expect(alert()).toMatchObject({ type: "normal", msg: "local notice" });
        send(cancel("q1"));
        await pump();
        // The queue moved on to q2 (queued behind the local dialog too); q1's dialog is gone.
        expect(alert()).toMatchObject({ type: "normal", msg: "local notice" });
        expect(tx.answers).toEqual([]);
        channel.endJobChannel("J");
        await pump();
        expect(tx.answers).toEqual([]);
        userAnswers("");
        await expect(local.closed).resolves.toBe("");
        await pump();
        // Nothing of the ended job shows, and nothing waits: the queue is idle.
        expect(alert()).toEqual({ type: "none", msg: "" });
        expect(stores.alertStore.hasDialogs()).toBe(false);
        let idle = false;
        void stores.alertStore.idle().then(() => {
            idle = true;
        });
        await pump();
        expect(idle).toBe(true);
        // A later job's question shows: the UI queue was released.
        send(question("k1", "alertConfirm", { message: "later" }), "K");
        await pump();
        expect(alert()).toMatchObject({ type: "ask", msg: "later" });
        userAnswers("yes");
        await pump();
        expect(tx.answers).toEqual([{ type: "answer", id: "k1", outcome: "answered", value: true }]);
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
        // The newest hydration remembered for the callback's job is applied again once local work settled.
        const record = { kind: "chats", id: "k", characterId: "c", revision: rev(1, 5), data: {} };
        channel.rememberHydration("J", { ...record, revision: rev(1, 4) });
        channel.rememberHydration("J", record);
        channel.rememberHydration("J", { ...record, revision: rev(1, 3) });
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

    it("applies only the callback's own job's remembered hydrations at its barrier, and drops a job's copies at its end", async () => {
        const hook = vi.fn(() => "x");
        hooks.editoutput.add(hook);
        const receipt = { kind: "chats", id: "k", characterId: "c", revision: rev(1, 5) };
        const record = { ...receipt, data: {} };
        deps.applyHydration.mockImplementation(() => {
            deps.heldChat.mockReturnValue(rev(1, 5));
            return true;
        });
        // Job K's copy is not job J's: J's barrier fails without applying it.
        channel.rememberHydration("K", record);
        send(callback("i1", "editoutput", { text: "t" }, { revisions: [receipt] }));
        await pump();
        expect(tx.answers[0]).toEqual(failed("barrier", /chats record k the job changed is not applied/));
        // K ended: its copy is dropped, so a later barrier of K (a callback under the same id) applies nothing.
        channel.endJobChannel("K");
        send(callback("i2", "editoutput", { text: "t" }, { jobId: "K", revisions: [receipt] }), "K");
        await pump();
        expect(tx.answers[1]).toEqual(failed("barrier", /not applied/));
        expect(deps.applyHydration).not.toHaveBeenCalled();
        expect(hook).not.toHaveBeenCalled();
        // Remembered again for K, its barrier applies it and the hook runs.
        channel.rememberHydration("K", record);
        send(callback("i3", "editoutput", { text: "t" }, { jobId: "K", revisions: [receipt] }), "K");
        await pump();
        expect(deps.applyHydration).toHaveBeenCalledWith(record);
        expect(tx.answers[2]).toEqual({ type: "answer", id: "i3", outcome: "answered", value: "x" });
        expect(hook).toHaveBeenCalledTimes(1);
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

    it("refuses an unavailable hook set and a provider that is not loaded, answers chatOutput true with no listener; replacers stop at the first throw, interceptors continue per entry without the hook context", async () => {
        for (const event of [
            callback("u1", "editoutput"),
            callback("u2", "mcpTool", { identifier: "plugin:x", tool: "t", args: {} }),
            callback("u3", "chatOutput", { messageId: "m1", speakerId: "c" }),
            callback("u4", "provider", { name: "p", argument: {} }),
        ]) {
            send(event);
            await pump();
        }
        expect(tx.answers[0]).toEqual(failed("protocol", "The editoutput hook is not registered any more"));
        expect(tx.answers[1]).toEqual(failed("protocol", "The mcpTool hook is not registered any more"));
        // `chatOutput` (slice 11a) runs the registered listeners in order; with none it answers `true`.
        expect(tx.answers[2]).toEqual({ type: "answer", id: "u3", outcome: "answered", value: true });
        // `provider` (slice 11b) runs the registered plugin provider; one that is not loaded fails
        // the callback as a hook failure (the job's request fails), not a protocol one.
        expect(tx.answers[3]).toEqual(failed("hook", "The plugin provider p is not loaded any more"));
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

describe("the reply tail's callbacks (slice 11a)", () => {
    // `chatOutput` walks the live listener set as the tab's own send does (a listener an earlier one
    // removed does not run, one it added does), gives each listener a plain copy of the speaker and
    // the chat as they are then with indices looked up again, logs a throw, and answers `true`.
    it("chatOutput runs the live listener set in order with fresh copies and indices, logs a throw, and answers true", async () => {
        const chat = deps.chats.c.chats[0] as { message: { chatId: string }[] };
        const original = [...chat.message];
        const calls: { name: string; messages: number; messageIndex: number; chatIndex: number }[] = [];
        const listener = (name: string, effect?: () => void) => (arg: unknown) => {
            const {
                chat: seen,
                messageIndex,
                chatIndex,
            } = arg as {
                chat: { message: unknown[] };
                messageIndex: number;
                chatIndex: number;
            };
            calls.push({ name, messages: seen.message.length, messageIndex, chatIndex });
            effect?.();
        };
        try {
            const second = listener("second");
            const third = listener("third");
            const first = listener("first", () => {
                hooks.chatOutput.delete(second);
                hooks.chatOutput.add(() => {
                    calls.push({ name: "throws", messages: -1, messageIndex: -1, chatIndex: -1 });
                    throw new Error("listener broke");
                });
                hooks.chatOutput.add(third);
                // The chat changes under the later listeners: a message inserted before the reply.
                chat.message.unshift({ chatId: "m0" });
            });
            hooks.chatOutput.add(first);
            hooks.chatOutput.add(second);
            send(callback("out", "chatOutput", { messageId: "m2", speakerId: "c" }));
            await pump();
            expect(calls).toEqual([
                { name: "first", messages: 2, messageIndex: 1, chatIndex: 0 },
                { name: "throws", messages: -1, messageIndex: -1, chatIndex: -1 },
                { name: "third", messages: 3, messageIndex: 2, chatIndex: 0 },
            ]);
            expect(tx.answers).toEqual([{ type: "answer", id: "out", outcome: "answered", value: true }]);
            expect(deps.contexts).toEqual([targets, targets, targets]);
            // The copies are plain (not the live records): a listener's edit of its copy changes nothing.
            expect(chat.message.map((message) => message.chatId)).toEqual(["m0", "m1", "m2"]);
            // A speaker the tab no longer has fails the callback as a hook failure.
            send(callback("gone", "chatOutput", { messageId: "m2", speakerId: "nobody" }));
            await pump();
            expect(tx.answers[1]).toEqual(failed("hook", "The chat the output listeners run for is gone"));
        } finally {
            chat.message.splice(0, chat.message.length, ...original);
        }
    });

    it("imggen runs stableDiff for the job's chat with a check that throws once the callback is cancelled, and answers whether an image was shown", async () => {
        deps.stableDiff.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        send(callback("i1", "imggen", { characterId: "c", text: "user: hi \n" }));
        await pump();
        send(callback("i2", "imggen", { characterId: "c", text: "user: hi \n" }));
        await pump();
        expect(tx.answers).toEqual([
            { type: "answer", id: "i1", outcome: "answered", value: true },
            { type: "answer", id: "i2", outcome: "answered", value: false },
        ]);
        expect(deps.stableDiff).toHaveBeenCalledTimes(2);
        const [char, text, target] = deps.stableDiff.mock.calls[0];
        // The character's record wrapper, as the tab's own path hands it over.
        expect(char).toBe(characterStore.characterList()[0]);
        expect(text).toBe("user: hi \n");
        expect(target).toMatchObject({ chatRef: targets.chatRef, pluginContext: targets });
        expect(() => target.check!()).not.toThrow();
        // Cancelled while the prompt request runs: the check throws, no image is asked for, no answer goes out.
        const prompting = deferred<void>();
        let thrown: unknown = null;
        deps.stableDiff.mockImplementationOnce(async (_char, _text, options) => {
            await prompting.promise;
            try {
                options.check?.();
            } catch (error) {
                thrown = error;
                throw error;
            }
            return true;
        });
        send(callback("i3", "imggen", { characterId: "c", text: "t" }));
        await pump();
        send(cancel("i3"));
        prompting.resolve();
        await pump();
        expect(thrown).toMatchObject({ message: "The server cancelled this callback" });
        expect(tx.answers).toHaveLength(2);
        // A character the tab no longer has is a hook failure.
        send(callback("i4", "imggen", { characterId: "nobody", text: "t" }));
        await pump();
        expect(tx.answers[2]).toEqual(failed("hook", "The character to generate for is gone"));
        expect(deps.stableDiff).toHaveBeenCalledTimes(3);
    });

    it("recentEmotions lists the last five emotions shown for the chat's character, or for each member of its group", async () => {
        const shown = (names: string[]) => names.map((name, i) => [name, `${name}.png`, i] as [string, string, number]);
        stores.CharEmotion.set({ c: shown(["a", "b", "c", "d", "e", "f"]), d: shown(["x"]), other: shown(["z"]) });
        expect(channel.recentEmotions("c")).toEqual({ c: ["b", "c", "d", "e", "f"] });
        await withCharacter({ chaId: "g", type: "group", characters: ["c", "d", "e"] }, null, () => {
            // Each member with something shown; a member without is left out, the group itself is not listed.
            expect(channel.recentEmotions("g")).toEqual({ c: ["b", "c", "d", "e", "f"], d: ["x"] });
        });
        expect(channel.recentEmotions("unknown")).toEqual({});
    });
});

describe("the selectedChat callback (slice 12b)", () => {
    it("answers the chat this tab has selected for a character (its chatPage), or null for a character or chat it does not have", async () => {
        await withCharacter(
            { chaId: "o", type: "character" },
            { chatPage: 1, chats: [{ id: "o1" }, { id: "o2" }] },
            () =>
                withCharacter({ chaId: "e", type: "character" }, { chatPage: 0, chats: [] }, async () => {
                    send(callback("s1", "selectedChat", { characterId: "c" }));
                    await pump();
                    send(callback("s2", "selectedChat", { characterId: "o" }));
                    await pump();
                    send(callback("s3", "selectedChat", { characterId: "e" }));
                    await pump();
                    send(callback("s4", "selectedChat", { characterId: "nobody" }));
                    await pump();
                }),
        );
        expect(tx.answers).toEqual([
            { type: "answer", id: "s1", outcome: "answered", value: { chatId: "k" } },
            { type: "answer", id: "s2", outcome: "answered", value: { chatId: "o2" } },
            { type: "answer", id: "s3", outcome: "answered", value: null },
            { type: "answer", id: "s4", outcome: "answered", value: null },
        ]);
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

describe("the provider callback (slice 11b)", () => {
    beforeEach(() => {
        // The 50 ms chunk interval reads the clock: faked with the timers here.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    });
    type Provider = Parameters<Hooks["pluginHooks"]["providers"]["set"]>[1];
    const argument = { prompt_chat: [{ role: "user", content: "hi" }], mode: "model", bias: [], max_tokens: 10 };
    const provider = (id: string) => callback(id, "provider", { name: "p", argument });
    /** Every message the follow's transport took: chunks and answers, in order. */
    const sent = () => tx.answers as unknown as ({ type: string; id: string } & Record<string, unknown>)[];
    const chunk = (id: string, text: string) => ({ type: "chunk", id, text });
    const answers = () => sent().filter((message) => message.type === "answer");
    /** A stream the test feeds (`push`) that records its cancellation. */
    function source<T>() {
        let controller!: ReadableStreamDefaultController<T>;
        const cancelled: unknown[] = [];
        const stream = new ReadableStream<T>({
            start(c) {
                controller = c;
            },
            cancel(reason) {
                cancelled.push(reason ?? "cancelled");
            },
        });
        return { stream, push: (value: T) => controller.enqueue(value), close: () => controller.close(), cancelled };
    }
    /** A provider's byte stream (the tab's own path decodes it as `Response.text()` does). */
    const bytes = (stream: ReadableStream<Uint8Array>) => stream as unknown as ReadableStream<string>;

    it("calls the provider with the server's argument, the job's targets, and an abort signal; a text answers `{ success, content }`, no answer `{ none: true }`; a throw, a text over the cap, and an unloaded provider are hook failures", async () => {
        const seen: { arg: unknown; signal: AbortSignal | undefined }[] = [];
        let impl: Provider = async () => ({ success: true, content: "hello" });
        hooks.providers.set("p", (arg, signal) => {
            seen.push({ arg, signal });
            return impl(arg, signal);
        });
        send(provider("t1"));
        await pump(1);
        expect(seen).toEqual([{ arg: argument, signal: expect.any(AbortSignal) }]);
        expect(deps.contexts.at(-1)).toEqual(targets);
        expect(sent()).toEqual([
            { type: "answer", id: "t1", outcome: "answered", value: { success: true, content: "hello" } },
        ]);
        impl = async () => ({ success: false, content: "the plugin says no" });
        send(provider("t2"));
        await pump(1);
        expect(sent()[1]).toEqual({
            type: "answer",
            id: "t2",
            outcome: "answered",
            value: { success: false, content: "the plugin says no" },
        });
        impl = (async () => undefined) as unknown as Provider;
        send(provider("t3"));
        await pump(1);
        expect(sent()[2]).toEqual({ type: "answer", id: "t3", outcome: "answered", value: { none: true } });
        impl = async () => {
            throw new Error("plugin broke");
        };
        send(provider("t4"));
        await pump(1);
        expect(sent()[3]).toEqual(failed("hook", "plugin broke"));
        impl = async () => ({ success: true, content: "x".repeat(MAX_PROVIDER_TEXT_CHARS + 1) });
        send(provider("t5"));
        await pump(1);
        expect(sent()[4]).toEqual(failed("hook", "The provider's text is too long"));
        impl = async () => ({ success: true, content: "x".repeat(MAX_PROVIDER_TEXT_CHARS) });
        send(provider("t6"));
        await pump(1);
        expect((sent()[5].value as { content: string }).content).toHaveLength(MAX_PROVIDER_TEXT_CHARS);
        hooks.providers.delete("p");
        send(provider("t7"));
        await pump(1);
        expect(sent()[6]).toEqual(failed("hook", "The plugin provider p is not loaded any more"));
        expect(seen).toHaveLength(6);
        // Every callback settled its mutation scope (the barrier before, the scoped flush after).
        expect(deps.flush).toHaveBeenCalledTimes(14);
    });

    it("streams a provider's text as cumulative chunks (the first at once, then the newest at most every 50 ms and at the end) before answering `{ success: true, streamed: true }`, and releases the stream", async () => {
        const text = source<string>();
        hooks.providers.set("p", async () => ({ success: true, content: text.stream }));
        send(provider("s"));
        await pump(1);
        expect(sent()).toEqual([chunk("s", "")]);
        text.push("Hel");
        await pump(1);
        text.push("lo");
        await pump(1);
        // Within the interval: the text waits for it, then goes out whether or not more arrives.
        expect(sent()).toHaveLength(1);
        await pump(49);
        expect(sent()).toEqual([chunk("s", ""), chunk("s", "Hello")]);
        text.push(" wor");
        await pump(1);
        text.push("ld");
        await pump(1);
        expect(sent()).toHaveLength(2);
        text.close();
        await pump(1);
        expect(sent()).toEqual([
            chunk("s", ""),
            chunk("s", "Hello"),
            chunk("s", "Hello world"),
            { type: "answer", id: "s", outcome: "answered", value: { success: true, streamed: true } },
        ]);
        expect(text.stream.locked).toBe(false);
        expect(text.cancelled).toEqual([]);
        // An empty stream: the first chunk and the answer.
        const empty = source<string>();
        hooks.providers.set("p", async () => ({ success: true, content: empty.stream }));
        send(provider("s2"));
        await pump(1);
        empty.close();
        await pump(1);
        expect(sent().slice(4)).toEqual([
            chunk("s2", ""),
            { type: "answer", id: "s2", outcome: "answered", value: { success: true, streamed: true } },
        ]);
        expect(empty.stream.locked).toBe(false);
    });

    it("reads a failed stream whole into the answer, decoding bytes as the tab's own path does (split and incomplete UTF-8), and fails either stream kind over the cap, cancelling its source", async () => {
        const failing = source<Uint8Array>();
        hooks.providers.set("p", async () => ({ success: false, content: bytes(failing.stream) }));
        send(provider("f"));
        await pump(1);
        failing.push(new Uint8Array([0x61, 0xe2]));
        failing.push(new Uint8Array([0x82, 0xac, 0xe2, 0x82]));
        failing.close();
        await pump(1);
        expect(sent()).toEqual([
            { type: "answer", id: "f", outcome: "answered", value: { success: false, content: "a€�" } },
        ]);
        expect(failing.stream.locked).toBe(false);
        expect(failing.cancelled).toEqual([]);
        // A successful byte stream decodes the same way, the pending sequence flushed at the end.
        const okBytes = source<Uint8Array>();
        hooks.providers.set("p", async () => ({ success: true, content: bytes(okBytes.stream) }));
        send(provider("f1"));
        await pump(1);
        okBytes.push(new Uint8Array([0xe2, 0x82]));
        okBytes.close();
        await pump(1);
        expect(sent().slice(1)).toEqual([
            chunk("f1", ""),
            chunk("f1", "�"),
            { type: "answer", id: "f1", outcome: "answered", value: { success: true, streamed: true } },
        ]);
        // A failed stream over the cap: a hook failure, the source cancelled, the reader released.
        const big = source<string>();
        hooks.providers.set("p", async () => ({ success: false, content: big.stream }));
        send(provider("f2"));
        await pump(1);
        big.push("x".repeat(MAX_PROVIDER_TEXT_CHARS));
        big.push("x");
        await pump(1);
        expect(sent().at(-1)).toEqual(failed("hook", "The provider's text is too long"));
        expect(big.cancelled).toHaveLength(1);
        expect(big.stream.locked).toBe(false);
        // A successful stream over the cap likewise; the chunks sent so far stay within the cap.
        const bigOk = source<string>();
        hooks.providers.set("p", async () => ({ success: true, content: bigOk.stream }));
        send(provider("f3"));
        await pump(1);
        bigOk.push("x".repeat(MAX_PROVIDER_TEXT_CHARS));
        await pump(60);
        expect(sent().at(-1)?.text).toHaveLength(MAX_PROVIDER_TEXT_CHARS);
        bigOk.push("x");
        await pump(1);
        expect(sent().at(-1)).toEqual(failed("hook", "The provider's text is too long"));
        expect(bigOk.cancelled).toHaveLength(1);
        expect(bigOk.stream.locked).toBe(false);
    });

    it("a cancel during the stream aborts the provider's signal, cancels the stream, answers nothing, and releases the reader; so does the job's end; a stream returned after the cancel is cancelled too", async () => {
        const slow = source<string>();
        let signal!: AbortSignal;
        hooks.providers.set("p", async (_arg, abort) => {
            signal = abort!;
            return { success: true, content: slow.stream };
        });
        send(provider("c1"));
        await pump(1);
        slow.push("a");
        await pump(1);
        send(cancel("c1"));
        await pump(1);
        expect(signal.aborted).toBe(true);
        expect(slow.cancelled).toHaveLength(1);
        expect(slow.stream.locked).toBe(false);
        expect(answers()).toEqual([]);
        // A late chunk timer never fires a send after the cancel.
        await pump(60);
        expect(sent()).toEqual([chunk("c1", "")]);

        const second = source<string>();
        hooks.providers.set("p", async (_arg, abort) => {
            signal = abort!;
            return { success: true, content: second.stream };
        });
        send(provider("c2"));
        await pump(1);
        channel.endJobChannel("J");
        await pump(1);
        expect(signal.aborted).toBe(true);
        expect(second.cancelled).toHaveLength(1);
        expect(second.stream.locked).toBe(false);
        expect(answers()).toEqual([]);

        // A provider that ignores its signal and returns a stream after the cancel.
        const late = source<string>();
        const returning = deferred<void>();
        hooks.providers.set("p", async () => {
            await returning.promise;
            return { success: true, content: late.stream };
        });
        send(provider("c3"));
        await pump(1);
        send(cancel("c3"));
        await pump(1);
        returning.resolve();
        await pump(1);
        expect(late.cancelled).toHaveLength(1);
        expect(late.stream.locked).toBe(false);
        expect(answers()).toEqual([]);
        // A failed stream: cancelled on the server's cancel as well.
        const failing = source<Uint8Array>();
        hooks.providers.set("p", async () => ({ success: false, content: bytes(failing.stream) }));
        send(provider("c4"));
        await pump(1);
        send(cancel("c4"));
        await pump(1);
        expect(failing.cancelled).toHaveLength(1);
        expect(failing.stream.locked).toBe(false);
        expect(answers()).toEqual([]);
        // The lane is free: the next callback runs and answers.
        hooks.providers.set("p", async () => ({ success: true, content: "fresh" }));
        send(provider("c5"));
        await pump(1);
        expect(answers()).toEqual([
            { type: "answer", id: "c5", outcome: "answered", value: { success: true, content: "fresh" } },
        ]);
        expect(channel.currentChannelCall()).toBeNull();
    });
});
