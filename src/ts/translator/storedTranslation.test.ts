// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, MessageTranslation } from "../../../shared/database.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { warmModules } from "../storage/tests/mutationStoresHarness";

// The tab side of the stored translation: `requestStoredTranslation` against a real chat module and
// settings records, with the transport (`authFetch`) and the save barrier (`flushResources`)
// scripted per case. The row never shows the answer itself: the request stays pending until the
// held message holds the stored translation the chat's refresh brings (`hydrateChat` here),
// bounded; every failure alerts once and clears pending.

const hoisted = vi.hoisted(() => ({
    auth: {
        fetch: null as
            null | ((path: string, init: RequestInit, options?: { beforeDispatch?: () => void }) => Promise<Response>),
    },
    flush: { run: null as null | (() => Promise<{ discarded: string[] }>) },
    alerts: { error: vi.fn(), normal: vi.fn() },
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init: RequestInit, options?: { beforeDispatch?: () => void }) =>
        hoisted.auth.fetch!(path, init, options),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../storage/resourceSync.svelte", () => {
    class GenerationBlockedError extends Error {
        constructor() {
            super("A character is still being generated; try again when it finishes");
            this.name = "GenerationBlockedError";
        }
    }
    return { flushResources: () => hoisted.flush.run!(), GenerationBlockedError };
});
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: hoisted.alerts.error,
        alertNormal: hoisted.alerts.normal,
    }),
);
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { language } from "src/lang";

const EPOCH = "00000000-0000-0000-0000-000000000000";
const rev = (n: number) => `${EPOCH}:1:${n}`;
const ref = { chaId: "c", chatId: "k" };

const tr = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
    text,
    sourceHash: translationSourceHash(source),
    targetLanguage: "ko",
    translatedAt: 1,
    ...extra,
});

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

type FetchCall = { path: string; init: RequestInit; options?: { beforeDispatch?: () => void } };

/** Boots the records and the chat module with character `c`, chat `k` (messages a "A", b "B"), selected. */
async function boot(options: { translation?: MessageTranslation; persona?: boolean } = {}) {
    vi.resetModules();
    const { installFlatDatabase } = await import("../storage/tests/installFlatDatabase");
    const selection = await import("../storage/selection.svelte");
    const chat = await import("../storage/chatStore.svelte");
    const characterStore = await import("../storage/characterStore.svelte");
    const client = await import("../storage/resourceClient");
    const views = await import("../storage/settingsViews.svelte");
    installFlatDatabase({
        characters: [{ chaId: "c", type: "character", name: "C", firstMessage: "Hello", chatPage: 0 }],
        botPresets: [{ id: "p1", name: "P1" }],
        modelPresets: [{ id: "m1", name: "M1" }],
        personas:
            options.persona === false
                ? []
                : [
                      { id: "u1", name: "U1" },
                      { id: "u2", name: "U2" },
                  ],
        translatorType: "llm",
        translator: "ko",
        llmTranslationTarget: "message",
    });
    selection.selectPreset("p1");
    selection.selectModelPreset("m1");
    if (options.persona !== false) {
        selection.selectPersona("u1");
    }
    const data = {
        id: "k",
        name: "K",
        note: "",
        localLore: [],
        message: [
            {
                role: "char",
                data: "A",
                chatId: "a",
                ...(options.translation ? { translation: options.translation } : {}),
            },
            { role: "user", data: "B", chatId: "b" },
        ],
    } as unknown as Chat;
    const listed = [{ characterId: "c", id: "k", revision: rev(1), data }];
    const orders = [{ characterId: "c", revision: rev(1), ids: ["k"] }];
    chat.seedChats(listed, orders);
    chat.assembleChats(characterStore.characterList() as never, listed, orders);
    selection.selectCharacter("c");
    chat.selectChat("c", "k");
    client.setResourceEpoch("e1");
    const mismatches: string[] = [];
    client.setEpochMismatchListener((epoch) => {
        mismatches.push(epoch);
    });
    const stored = await import("./storedTranslation.svelte");
    const sync = await import("../storage/resourceSync.svelte");
    const held = (id = "a") => chat.findChat(ref)!.message.find((message) => message.chatId === id);
    /** The server's copy after the runner stored `translation` on message `id` (the chat's refresh). */
    const hydrate = (id: string, translation: MessageTranslation | undefined, revision = 2) =>
        chat.hydrateChat({
            characterId: "c",
            id: "k",
            revision: rev(revision),
            data: JSON.parse(
                JSON.stringify({
                    ...data,
                    message: chat
                        .findChat(ref)!
                        .message.map((message) =>
                            message.chatId === id ? { ...message, translation } : { ...message },
                        ),
                }),
            ) as Chat,
        });
    return { chat, stored, sync, selection, settings: views.settings, held, hydrate, mismatches };
}

const fetchCalls: FetchCall[] = [];

/** Scripts the transport: every call records itself and answers with `answer(call)`. */
function answerWith(answer: (call: FetchCall, index: number) => Promise<Response>) {
    hoisted.auth.fetch = (path, init, options) => {
        const call = { path, init, options };
        fetchCalls.push(call);
        return answer(call, fetchCalls.length - 1);
    };
}

beforeAll(
    () =>
        warmModules(() =>
            Promise.all([
                import("../storage/tests/installFlatDatabase"),
                import("../storage/selection.svelte"),
                import("../storage/chatStore.svelte"),
                import("../storage/characterStore.svelte"),
                import("../storage/resourceClient"),
                import("../storage/settingsViews.svelte"),
                import("./storedTranslation.svelte"),
                import("../storage/resourceSync.svelte"),
            ]),
        ),
    60_000,
);

beforeEach(() => {
    fetchCalls.length = 0;
    hoisted.alerts.error.mockReset();
    hoisted.alerts.normal.mockReset();
    hoisted.flush.run = async () => ({ discarded: [] });
    hoisted.auth.fetch = async () => {
        throw new Error("no transport scripted");
    };
});

afterEach(() => {
    vi.useRealTimers();
});

describe("requestStoredTranslation: before the request", () => {
    it("stops with translationNoContext when the chat has no complete display context, saving and sending nothing", async () => {
        const { stored } = await boot({ persona: false });
        const flush = vi.fn(async () => ({ discarded: [] }));
        hoisted.flush.run = flush;
        await expect(stored.requestStoredTranslation(ref, "a", { force: false })).resolves.toBe(false);
        expect(hoisted.alerts.error).toHaveBeenCalledTimes(1);
        expect(hoisted.alerts.error).toHaveBeenCalledWith(language.translationNoContext);
        expect(flush).not.toHaveBeenCalled();
        expect(fetchCalls).toEqual([]);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);
    });

    it("does nothing for a message the chat does not hold", async () => {
        const { stored } = await boot();
        await expect(stored.requestStoredTranslation(ref, "zz", { force: false })).resolves.toBe(false);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
        expect(fetchCalls).toEqual([]);
    });

    it("saves every pending change first: a blocked save alerts chatGenerating, a failed one its message, a discard of this chat or a text changed meanwhile translationSourceChanged, a display id changed meanwhile the binding mismatch; nothing is sent", async () => {
        const { stored, sync, chat, selection } = await boot();
        const run = async (flush: () => Promise<{ discarded: string[] }>) => {
            hoisted.alerts.error.mockReset();
            hoisted.flush.run = flush;
            const result = await stored.requestStoredTranslation(ref, "a", { force: false });
            expect(result).toBe(false);
            expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);
            expect(hoisted.alerts.error).toHaveBeenCalledTimes(1);
            return hoisted.alerts.error.mock.calls[0][0] as string;
        };
        expect(
            await run(async () => {
                throw new sync.GenerationBlockedError();
            }),
        ).toBe(language.chatGenerating);
        expect(
            await run(async () => {
                throw new Error("disk full");
            }),
        ).toBe(`${language.translationFailed}: disk full`);
        expect(await run(async () => ({ discarded: ["chats/c/k"] }))).toBe(language.translationSourceChanged);
        // The chat edited while the save ran (an unrelated discard does not matter by itself).
        expect(
            await run(async () => {
                chat.setMessageText(ref, "a", "A edited");
                return { discarded: ["chats/c/other"] };
            }),
        ).toBe(language.translationSourceChanged);
        chat.setMessageText(ref, "a", "A");
        expect(
            await run(async () => {
                selection.selectPersona("u2");
                return { discarded: [] };
            }),
        ).toBe(language.chatBinding.mismatch);
        expect(fetchCalls).toEqual([]);
    });
});

describe("requestStoredTranslation: the request and the wait", () => {
    it("POSTs the ids the chat displays with and the epoch header, joins a second call, and stays pending after the answer until the held message holds that translation", async () => {
        const { stored, held, hydrate } = await boot();
        const answer = deferred<Response>();
        answerWith(() => answer.promise);
        const T = tr("ㄱ", "A", { presetId: "tp", translatedAt: 77 });

        const first = stored.requestStoredTranslation(ref, "a", { force: false });
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        expect(stored.requestStoredTranslation(ref, "a", { force: true })).toBe(first);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        const [call] = fetchCalls;
        expect(call.path).toBe("/api/translate/message");
        expect(call.init.method).toBe("POST");
        const headers = new Headers(call.init.headers);
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("x-resource-epoch")).toBe("e1");
        expect(JSON.parse(call.init.body as string)).toEqual({
            characterId: "c",
            chatId: "k",
            messageId: "a",
            presetId: "p1",
            modelPresetId: "m1",
            personaId: "u1",
            force: false,
        });

        let settled: boolean | null = null;
        void first.then((value) => {
            settled = value;
        });
        answer.resolve(json(200, { outcome: "applied", translation: T }));
        await new Promise((resolve) => setTimeout(resolve, 250));
        // The answer alone shows nothing: the held message is still bare and the request pending.
        expect(settled).toBeNull();
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        expect(held()!.translation).toBeUndefined();

        expect(hydrate("a", T)).toBe(true);
        await expect(first).resolves.toBe(true);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);
        expect(stored.freshTranslation(held()!)).toEqual(T);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
        expect(fetchCalls).toHaveLength(1);
    });

    it("ends the wait when the text changes instead, or after 15 s, without an alert", async () => {
        vi.useFakeTimers();
        const { stored, chat, held } = await boot();
        answerWith(async (call) => {
            const body = JSON.parse(call.init.body as string) as { messageId: string };
            const source = held(body.messageId)!.data;
            return json(200, { outcome: "applied", translation: tr("t", source) });
        });

        let settledA: boolean | null = null;
        void stored.requestStoredTranslation(ref, "a", { force: false }).then((value) => {
            settledA = value;
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(settledA).toBeNull();
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        chat.setMessageText(ref, "a", "A again");
        await vi.advanceTimersByTimeAsync(200);
        expect(settledA).toBe(true);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);

        let settledB: boolean | null = null;
        void stored.requestStoredTranslation(ref, "b", { force: false }).then((value) => {
            settledB = value;
        });
        await vi.advanceTimersByTimeAsync(14_000);
        expect(settledB).toBeNull();
        await vi.advanceTimersByTimeAsync(1_500);
        expect(settledB).toBe(true);
        expect(stored.isStoredTranslationPending(ref, "b")).toBe(false);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });

    it("resolves at once on `fresh` when the held message already holds the translation", async () => {
        const T = tr("ㄱ", "A");
        const { stored } = await boot({ translation: T });
        answerWith(async () => json(200, { outcome: "fresh", translation: T }));
        await expect(stored.requestStoredTranslation(ref, "a", { force: false })).resolves.toBe(true);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });

    it("bounds the whole exchange at 21 minutes (two server deadlines: a request behind an older text's run waits for both), authentication included, and a request authenticated after the deadline is not sent", async () => {
        vi.useFakeTimers();
        const { stored } = await boot();
        let beforeDispatch: (() => void) | undefined;
        answerWith((call) => {
            beforeDispatch = call.options?.beforeDispatch;
            return new Promise<Response>(() => {});
        });
        const request = stored.requestStoredTranslation(ref, "a", { force: false });
        await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        expect(beforeDispatch).toBeDefined();
        expect(() => beforeDispatch!()).not.toThrow();
        await vi.advanceTimersByTimeAsync(61 * 1000);
        await expect(request).resolves.toBe(false);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);
        expect(hoisted.alerts.error).toHaveBeenCalledTimes(1);
        expect(hoisted.alerts.error).toHaveBeenCalledWith(`${language.translationFailed}: No answer in time`);
        expect(() => beforeDispatch!()).toThrow(/No answer in time/);
    });
});

describe("requestStoredTranslation: the answers", () => {
    it("maps 412 to the epoch handler without an alert, 409 to its strings, other failures to translationFailed with the server's text or the status, validates a 200, treats `ignored` as a source change, and clears pending every time", async () => {
        const { stored, mismatches } = await boot();
        const cases: { answer: () => Promise<Response>; alert: string | null }[] = [
            { answer: async () => json(412, { error: "EpochMismatch", epoch: "e2" }), alert: null },
            { answer: async () => json(409, { error: "generating" }), alert: language.chatGenerating },
            {
                answer: async () => json(409, { error: "chatBindingMismatch", problems: [] }),
                alert: language.chatBinding.mismatch,
            },
            {
                answer: async () => json(502, { error: "The provider refused" }),
                alert: `${language.translationFailed}: The provider refused`,
            },
            {
                answer: async () => new Response("<html>bad gateway</html>", { status: 500 }),
                alert: `${language.translationFailed}: HTTP 500`,
            },
            { answer: async () => json(404, {}), alert: `${language.translationFailed}: HTTP 404` },
            {
                answer: async () => json(200, { outcome: "done", translation: tr("x", "A") }),
                alert: `${language.translationFailed}: an unexpected answer`,
            },
            {
                answer: async () => json(200, { outcome: "applied", translation: { text: "x" } }),
                alert: `${language.translationFailed}: an unexpected answer`,
            },
            {
                answer: async () => new Response("not json", { status: 200 }),
                alert: `${language.translationFailed}: an unexpected answer`,
            },
            {
                answer: async () => json(200, { outcome: "ignored", translation: null }),
                alert: language.translationSourceChanged,
            },
            {
                answer: async () => {
                    throw new Error("socket closed");
                },
                alert: `${language.translationFailed}: socket closed`,
            },
        ];
        for (const [index, entry] of cases.entries()) {
            hoisted.alerts.error.mockReset();
            answerWith(entry.answer);
            await expect(stored.requestStoredTranslation(ref, "a", { force: true }), `case ${index}`).resolves.toBe(
                false,
            );
            expect(stored.isStoredTranslationPending(ref, "a"), `case ${index}`).toBe(false);
            if (entry.alert === null) {
                expect(hoisted.alerts.error, `case ${index}`).not.toHaveBeenCalled();
            } else {
                expect(hoisted.alerts.error, `case ${index}`).toHaveBeenCalledTimes(1);
                expect(hoisted.alerts.error, `case ${index}`).toHaveBeenCalledWith(entry.alert);
            }
        }
        expect(mismatches).toEqual(["e2"]);
        // No automatic retry anywhere.
        expect(fetchCalls).toHaveLength(cases.length);
    });
});

describe("following a server hand-off", () => {
    const follow = () => ({ report: vi.fn<(message: string) => void>() });

    it("posts an unforced request per id at once, without the save barrier or the stability checks, and holds the row pending until the translation arrives; `ignored` and a missing context say nothing", async () => {
        const { stored, held, hydrate } = await boot();
        const flush = vi.fn(async () => ({ discarded: [] }));
        hoisted.flush.run = flush;
        const answers = new Map<string, ReturnType<typeof deferred<Response>>>();
        answerWith(async (call) => {
            const body = JSON.parse(call.init.body as string) as { messageId: string };
            const entry = deferred<Response>();
            answers.set(body.messageId, entry);
            return entry.promise;
        });
        const reporter = follow();
        stored.followStoredTranslations(ref, ["a", "b"], reporter);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        expect(stored.isStoredTranslationPending(ref, "b")).toBe(true);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
        expect(flush).not.toHaveBeenCalled();
        expect(fetchCalls.map((call) => JSON.parse(call.init.body as string))).toEqual([
            {
                characterId: "c",
                chatId: "k",
                messageId: "a",
                presetId: "p1",
                modelPresetId: "m1",
                personaId: "u1",
                force: false,
            },
            {
                characterId: "c",
                chatId: "k",
                messageId: "b",
                presetId: "p1",
                modelPresetId: "m1",
                personaId: "u1",
                force: false,
            },
        ]);

        // The run's write lands through the chat refresh: pending until then, then shown.
        const T = tr("ㄱ", "A", { translatedAt: 5 });
        answers.get("a")!.resolve(json(200, { outcome: "applied", translation: T }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        expect(hydrate("a", T)).toBe(true);
        await vi.waitFor(() => expect(stored.isStoredTranslationPending(ref, "a")).toBe(false));
        expect(stored.freshTranslation(held("a")!)).toEqual(T);
        // The user edited the text meanwhile: the run's `ignored` is not a failure to report.
        answers.get("b")!.resolve(json(200, { outcome: "ignored", translation: null }));
        await vi.waitFor(() => expect(stored.isStoredTranslationPending(ref, "b")).toBe(false));
        expect(reporter.report).not.toHaveBeenCalled();
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
        expect(fetchCalls).toHaveLength(2);

        // No complete display context: nothing sent, nothing said.
        const { stored: bare } = await boot({ persona: false });
        answerWith(async () => json(200, { outcome: "fresh", translation: T }));
        bare.followStoredTranslations(ref, ["a"], reporter);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(bare.isStoredTranslationPending(ref, "a")).toBe(false);
        expect(fetchCalls).toHaveLength(2);

        // A text edited in the tab (not saved) stops a manual request; a follow still asks (the server
        // translates its own copy) and takes the run's `ignored` quietly.
        const edited = await boot();
        edited.chat.setMessageText(ref, "a", "A edited in the tab");
        answerWith(async () => json(200, { outcome: "ignored", translation: null }));
        edited.stored.followStoredTranslations(ref, ["a"], reporter);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(3));
        expect(flush).not.toHaveBeenCalled();
        expect(JSON.parse(fetchCalls[2].init.body as string)).toMatchObject({ messageId: "a", force: false });
        await vi.waitFor(() => expect(edited.stored.isStoredTranslationPending(ref, "a")).toBe(false));
        expect(reporter.report).not.toHaveBeenCalled();
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });

    it("reports a failure through the follow (never the alert store directly): a refusal, a failed request, a bad answer; a manual request still alerts", async () => {
        const { stored } = await boot();
        const cases: { answer: () => Promise<Response>; report: string }[] = [
            { answer: async () => json(409, { error: "generating" }), report: language.chatGenerating },
            {
                answer: async () => json(409, { error: "chatBindingMismatch" }),
                report: language.chatBinding.mismatch,
            },
            {
                answer: async () => json(502, { error: "The provider refused" }),
                report: `${language.translationFailed}: The provider refused`,
            },
            {
                answer: async () => json(200, { outcome: "done", translation: null }),
                report: `${language.translationFailed}: an unexpected answer`,
            },
            {
                answer: async () => {
                    throw new Error("socket closed");
                },
                report: `${language.translationFailed}: socket closed`,
            },
        ];
        for (const [index, entry] of cases.entries()) {
            const reporter = follow();
            answerWith(entry.answer);
            await expect(
                stored.requestStoredTranslation(ref, "a", { force: false, follow: reporter }),
                `case ${index}`,
            ).resolves.toBe(false);
            expect(reporter.report.mock.calls, `case ${index}`).toEqual([[entry.report]]);
            expect(stored.isStoredTranslationPending(ref, "a"), `case ${index}`).toBe(false);
        }
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
        // The 412 handler is shared and silent either way.
        answerWith(async () => json(412, { error: "EpochMismatch", epoch: "e9" }));
        const reporter = follow();
        await expect(stored.requestStoredTranslation(ref, "a", { force: false, follow: reporter })).resolves.toBe(
            false,
        );
        expect(reporter.report).not.toHaveBeenCalled();
        // A manual request keeps alerting.
        answerWith(async () => json(502, { error: "The provider refused" }));
        await expect(stored.requestStoredTranslation(ref, "a", { force: true })).resolves.toBe(false);
        expect(hoisted.alerts.error).toHaveBeenCalledWith(`${language.translationFailed}: The provider refused`);
    });

    it("a hand-off that arrives while a request for the message runs follows again once it settles (the row pending throughout), reporting through the newer follow; a plain second call does not", async () => {
        const { stored, held, hydrate } = await boot();
        const answers: ReturnType<typeof deferred<Response>>[] = [];
        answerWith(async () => {
            const entry = deferred<Response>();
            answers.push(entry);
            return entry.promise;
        });
        const first = follow();
        const second = follow();
        const running = stored.requestStoredTranslation(ref, "a", { force: false, follow: first });
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        // A Continue's hand-off arrives: the running request may have joined the older text's run.
        stored.followStoredTranslations(ref, ["a"], second);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetchCalls).toHaveLength(1);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);

        // The first settles (the old run's write was ignored): another request follows at once.
        answers[0].resolve(json(200, { outcome: "ignored", translation: null }));
        await expect(running).resolves.toBe(false);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
        expect(JSON.parse(fetchCalls[1].init.body as string)).toMatchObject({ messageId: "a", force: false });
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(true);
        // Its failure is the newer follow's to report.
        answers[1].resolve(json(502, { error: "The provider refused" }));
        await vi.waitFor(() => expect(stored.isStoredTranslationPending(ref, "a")).toBe(false));
        expect(first.report).not.toHaveBeenCalled();
        expect(second.report.mock.calls).toEqual([[`${language.translationFailed}: The provider refused`]]);
        expect(fetchCalls).toHaveLength(2);

        // The follow-again is consumed: a third request starts from nothing, and a plain second call
        // (the toggle) while it runs joins it without arranging another.
        const third = follow();
        stored.followStoredTranslations(ref, ["a"], third);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(3));
        const joined = stored.requestStoredTranslation(ref, "a", { force: false });
        const T = tr("ㄱ", "A", { translatedAt: 9 });
        answers[2].resolve(json(200, { outcome: "applied", translation: T }));
        hydrate("a", T);
        await expect(joined).resolves.toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fetchCalls).toHaveLength(3);
        expect(stored.isStoredTranslationPending(ref, "a")).toBe(false);
        expect(stored.freshTranslation(held("a")!)).toEqual(T);
        expect(third.report).not.toHaveBeenCalled();
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });
});

describe("the read helpers and the row choices", () => {
    it("freshTranslation is the whole record while its hash matches, an empty text included, else null", async () => {
        const T = tr("", "A", { presetId: "tp" });
        const { stored, held, chat } = await boot({ translation: T });
        expect(stored.freshTranslation(held()!)).toEqual(T);
        expect(stored.heldMessage(ref, "a")).toBe(held());
        expect(stored.heldMessage(ref, "zz")).toBeUndefined();
        expect(stored.freshTranslation({ data: "A", translation: { text: "x" } })).toBeNull();
        expect(stored.freshTranslation({ data: "A" })).toBeNull();
        chat.setMessageText(ref, "a", "A2");
        expect(stored.freshTranslation(held()!)).toBeNull();
    });

    it("keeps an explicit show/hide choice per chat and message, null when none was made", async () => {
        const { stored } = await boot();
        expect(stored.storedTranslationChoice(ref, "a")).toBeNull();
        stored.setStoredTranslationChoice(ref, "a", true);
        expect(stored.storedTranslationChoice(ref, "a")).toBe(true);
        expect(stored.storedTranslationChoice(ref, "b")).toBeNull();
        expect(stored.storedTranslationChoice({ chaId: "c", chatId: "other" }, "a")).toBeNull();
        stored.setStoredTranslationChoice(ref, "a", false);
        expect(stored.storedTranslationChoice(ref, "a")).toBe(false);
    });

    it("usesStoredTranslation is the LLM translator on `message`", async () => {
        const { stored, settings } = await boot();
        expect(stored.usesStoredTranslation()).toBe(true);
        settings.memoryTranslateMedia.llmTranslationTarget = "rendered";
        expect(stored.usesStoredTranslation()).toBe(false);
        settings.memoryTranslateMedia.llmTranslationTarget = "message";
        settings.memoryTranslateMedia.translatorType = "google";
        expect(stored.usesStoredTranslation()).toBe(false);
    });
});

describe("the stored translation edit session", () => {
    it("opens on a fresh translation only, with the chat, the message, the source hash, and a detached copy of the translation", async () => {
        const T = tr("ㄱ", "A", { presetId: "tp" });
        const { stored, held } = await boot({ translation: T });
        const edit = stored.beginStoredTranslationEdit(ref, "a");
        expect(edit).toEqual({ ref: { chaId: "c", chatId: "k" }, messageId: "a", sourceHash: T.sourceHash, base: T });
        expect(edit!.base).not.toBe(held()!.translation);
        expect(stored.beginStoredTranslationEdit(ref, "b")).toBeNull();
        expect(stored.beginStoredTranslationEdit(ref, "zz")).toBeNull();
    });

    it("writes the edit with the base's presetId and targetLanguage, the captured hash, a new translatedAt, and `edited: true`", async () => {
        const T = tr("ㄱ", "A", { presetId: "tp", translatedAt: 5 });
        const { stored, held } = await boot({ translation: T });
        const edit = stored.beginStoredTranslationEdit(ref, "a")!;
        const before = Date.now();
        expect(stored.saveStoredTranslationEdit(edit, "ㄴ")).toBe(true);
        const written = held()!.translation as MessageTranslation;
        expect(written).toMatchObject({
            text: "ㄴ",
            sourceHash: T.sourceHash,
            presetId: "tp",
            targetLanguage: "ko",
            edited: true,
        });
        expect(written.translatedAt).toBeGreaterThanOrEqual(before);
        expect(stored.freshTranslation(held()!)).toEqual(written);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();

        // A base without a presetId writes none.
        const bare = stored.beginStoredTranslationEdit(ref, "a")!;
        bare.base = tr("ㄴ", "A");
        expect(stored.saveStoredTranslationEdit(bare, "ㄷ")).toBe(true);
        expect(Object.hasOwn(held()!.translation as object, "presetId")).toBe(false);
    });

    it("refuses and alerts when the text changed since the editor opened, when the message is gone, or when a generation locks it, leaving the held translation alone", async () => {
        const T = tr("ㄱ", "A");
        const { stored, held, chat } = await boot({ translation: T });
        const edit = stored.beginStoredTranslationEdit(ref, "a")!;

        chat.setMessageText(ref, "a", "A edited");
        expect(stored.saveStoredTranslationEdit(edit, "ㄴ")).toBe(false);
        expect(hoisted.alerts.error).toHaveBeenLastCalledWith(language.translationEditStale);
        expect(held()!.translation).toEqual(T);
        chat.setMessageText(ref, "a", "A");

        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g", text: "A", seq: 0 });
        expect(stored.saveStoredTranslationEdit(edit, "ㄴ")).toBe(false);
        expect(hoisted.alerts.error).toHaveBeenLastCalledWith(language.chatGenerating);
        expect(held()!.translation).toEqual(T);

        const other = stored.beginStoredTranslationEdit(ref, "b");
        expect(other).toBeNull();
        chat.removeMessages(ref, ["b"]);
        const gone = { ...edit, messageId: "b" };
        expect(stored.saveStoredTranslationEdit(gone, "x")).toBe(false);
        expect(hoisted.alerts.error).toHaveBeenLastCalledWith(language.translationEditStale);
        expect(hoisted.alerts.error).toHaveBeenCalledTimes(3);
    });
});
