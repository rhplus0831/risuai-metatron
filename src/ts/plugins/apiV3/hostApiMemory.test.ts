import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MEMORY_REVISION_CHATS_MAX, sealHypaV3Data } from "../../../../shared/structuredMemory.ts";
import type { Chat } from "../../../../shared/database.ts";

type Api = Record<string, (...args: any[]) => any>;
const { captured, authFetch, readRefs } = vi.hoisted(() => ({
    captured: { api: null as Api | null },
    authFetch: vi.fn(),
    readRefs: vi.fn(),
}));
vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(api: Api) {
            captured.api = api;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
    },
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch }),
);
vi.mock("src/ts/storage/resourceClient", async () =>
    (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock({ readRefs }),
);
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: vi.fn(async () => true) }),
);
// As in hostApiChats: the parser's module-level effect needs the boot graph, which this host fixture does not boot.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: (text: string) => text,
}));

import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { reconcileSelection, settings } from "src/ts/storage/settingsViews.svelte";
import * as chats from "src/ts/storage/chatStore.svelte";
import { executePluginV3 } from "./v3.svelte";
import { declineStructuredMemory, resetStructuredMemorySummaries } from "src/ts/process/structuredMemory.svelte";

const epoch = "00000000-0000-4000-8000-000000000000";
const token = (seq: number, revision: number) => `${epoch}:${seq}:${revision}`;
const ref = { chaId: "c", chatId: "k0" };
const memory = (seq: number, revision: number) =>
    sealHypaV3Data(
        {
            summaries: [{ text: `Memory ${seq} at ${revision}`, chatMemos: ["m"], isImportant: false }],
        },
        token(seq, revision),
    );
const chat = (id: string, hypaV3Data?: Chat["hypaV3Data"]): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    message: [{ chatId: "m", role: "char", data: "Stored message" }],
    ...(hypaV3Data ? { hypaV3Data } : {}),
});
// Read these private budgets from source so the tests can drive their exact boundaries without exporting test API.
const source = readFileSync("src/ts/plugins/apiV3/v3.svelte.ts", "utf8");
const deadline = Number(source.match(/const MEMORY_REFRESH_DEADLINE_MS = (\d+)/)![1]);
const projectionLimit = Number(source.match(/const MEMORY_PROJECTIONS_PER_READ = (\d+)/)![1]);
const recheckWindow = Number(source.match(/const MEMORY_RECHECK_WINDOW_MS = (\d+)/)![1]);
// Marks survive install() and fake-timer resets; this clock only moves forward, including between tests.
let memoryNow = 0;
function passRecheckWindow() {
    memoryNow += recheckWindow + 1;
}
const revisionPath = "/api/memory/structured/revisions";
const projectionPath = (id: string) => `/api/memory/structured/c/${id}/projection`;
const refsOf = (init: RequestInit) => JSON.parse(String(init.body)).chats as { characterId: string; chatId: string }[];
const projectionRequests = () => authFetch.mock.calls.filter(([path]) => path.endsWith("/projection"));
const revisionRequests = () => authFetch.mock.calls.filter(([path]) => path === revisionPath);

function install(count = 2) {
    const characters = [{ chaId: "c", name: "C", type: "character", chats: [] }];
    const rows = Array.from({ length: count }, (_, i) => ({
        characterId: "c",
        id: `k${i}`,
        revision: token(i + 1, 1),
        data: chat(`k${i}`, memory(i + 1, 1)),
    }));
    initializeRecords(takeRecordFields({ characters, memoryAlgorithmType: "structuredMemory" }));
    reconcileSelection();
    const orders = [{ characterId: "c", revision: token(1, 1), ids: rows.map(({ id }) => id) }];
    chats.seedChats(rows, orders);
    chats.assembleChats(characters, rows, orders);
    chats.initializeChats();
    selectCharacter("c");
    readRefs.mockImplementation(async (_refs, options) => ({
        epoch,
        items: [],
        chats: options.chats.map(({ id }: { id: string }) => rows.find((row) => row.id === id)),
    }));
    return rows;
}
function respond(revision = 1) {
    authFetch.mockImplementation(async (path: string, init: RequestInit) => {
        if (path === revisionPath)
            return Response.json({
                revisions: refsOf(init).map(({ chatId }) => token(Number(chatId.slice(1)) + 1, revision)),
            });
        const seq = Number(path.split("/").at(-2)!.slice(1)) + 1;
        return Response.json({ revision: token(seq, revision), hypaV3Data: memory(seq, revision) });
    });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function api() {
    await executePluginV3({ name: `memory-${crypto.randomUUID()}`, script: "", version: "3.0" } as any);
    return captured.api!;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    passRecheckWindow();
    vi.spyOn(performance, "now").mockImplementation(() => memoryNow);
    localStorage.clear();
    authFetch.mockReset();
    readRefs.mockReset();
    install();
    respond();
});
afterEach(() => {
    selectCharacter(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("sends one revision request for a tight loop of character reads", async () => {
    const host = await api();
    for (let row = 0; row < 25; row++) {
        const got = await host.getChar();
        expect(got.chats.map((value: Chat) => value.hypaV3Data)).toEqual([memory(1, 1), memory(2, 1)]);
    }
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    expect(refsOf(revisionRequests()[0][1])).toEqual([
        { characterId: "c", chatId: "k0" },
        { characterId: "c", chatId: "k1" },
    ]);
});

it("joins concurrent reads to one revision request and waits for its projection", async () => {
    const host = await api();
    const revision = deferred<Response>();
    const projection = deferred<Response>();
    const revisionEntered = deferred<void>();
    const projectionEntered = deferred<void>();
    authFetch.mockImplementation(async (path: string) => {
        if (path === revisionPath) {
            revisionEntered.resolve();
            return (await revision.promise).clone();
        }
        projectionEntered.resolve();
        return (await projection.promise).clone();
    });
    let completed = 0;
    const read = (): Promise<Chat> =>
        host.getChatFromIndex(0, 0).then((value: Chat) => {
            completed++;
            return value;
        });
    const readings = [read()];
    try {
        await revisionEntered.promise;
        readings.push(read(), read());
        await vi.advanceTimersByTimeAsync(0);
        expect(revisionRequests()).toHaveLength(1);
        expect(completed).toBe(0);

        revision.resolve(Response.json({ revisions: [token(1, 2)] }));
        await projectionEntered.promise;
        // A reader arriving during the projection must also join the entire refresh.
        readings.push(read());
        await vi.advanceTimersByTimeAsync(0);
        expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, projectionPath("k0")]);
        expect(completed).toBe(0);
    } finally {
        revision.resolve(Response.json({ revisions: [token(1, 2)] }));
        projection.resolve(Response.json({ revision: token(1, 2), hypaV3Data: memory(1, 2) }));
        await Promise.all(readings);
    }
    expect(completed).toBe(4);
    for (const value of await Promise.all(readings)) expect(value.hypaV3Data).toEqual(memory(1, 2));
});

it("returns held memory without a request or wait until the window expires from settlement", async () => {
    const host = await api();
    const held = deferred<Response>();
    const entered = deferred<void>();
    authFetch.mockImplementationOnce(async () => {
        entered.resolve();
        return held.promise;
    });
    const first = host.getChatFromIndex(0, 0);
    try {
        await entered.promise;
        // A slow answer must get a full window of its own after it settles.
        passRecheckWindow();
    } finally {
        held.resolve(Response.json({ revisions: [token(1, 1)] }));
        await first;
    }
    expect((await first).hypaV3Data).toEqual(memory(1, 1));
    respond(2);
    memoryNow += recheckWindow - 1;
    let cached: Chat | undefined;
    const reading = host.getChatFromIndex(0, 0).then((value: Chat) => {
        cached = value;
        return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    expect(cached?.hypaV3Data).toEqual(memory(1, 1));
    await reading;

    memoryNow += 2;
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 2));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, revisionPath, projectionPath("k0")]);
});

it("counts a failed revision check for the window and retries after it expires", async () => {
    const host = await api();
    authFetch.mockImplementationOnce(async () => Response.json({ error: "offline" }, { status: 503 }));
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 1));
    respond(2);
    memoryNow += recheckWindow - 1;
    const cached = await host.getChatFromIndex(0, 0);
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    expect(cached.hypaV3Data).toEqual(memory(1, 1));

    memoryNow += 2;
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 2));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, revisionPath, projectionPath("k0")]);
});

it("counts a timed-out revision check for the window and retries after it expires", async () => {
    const host = await api();
    const held = deferred<Response>();
    const entered = deferred<void>();
    authFetch.mockImplementationOnce(async () => {
        entered.resolve();
        return held.promise;
    });
    const reading = host.getChatFromIndex(0, 0);
    try {
        await entered.promise;
        memoryNow += deadline;
        await vi.advanceTimersByTimeAsync(deadline);
        expect((await reading).hypaV3Data).toEqual(memory(1, 1));
    } finally {
        held.resolve(Response.json({ revisions: [token(1, 1)] }));
        await reading;
        await vi.advanceTimersByTimeAsync(0);
    }
    respond(2);
    memoryNow += recheckWindow - 1;
    const cached = await host.getChatFromIndex(0, 0);
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    expect(cached.hypaV3Data).toEqual(memory(1, 1));

    memoryNow += 2;
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 2));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, revisionPath, projectionPath("k0")]);
});

it("fetches the moved projection beyond the per-read cap after the window", async () => {
    const rows = install(projectionLimit + 1);
    const host = await api();
    respond(2);
    const first = await host.getDatabase(["characters"]);
    expect(revisionRequests()).toHaveLength(1);
    expect(refsOf(revisionRequests()[0][1])).toHaveLength(rows.length);
    expect(projectionRequests()).toHaveLength(projectionLimit);
    const fetched = new Set(projectionRequests().map(([path]) => path));
    const tail = rows.filter(({ id }) => !fetched.has(projectionPath(id)));
    expect(tail).toHaveLength(1);
    expect(first.characters[0].chats.map((value: Chat) => value.hypaV3Data)).toEqual(
        rows.map(({ id }, index) => memory(index + 1, fetched.has(projectionPath(id)) ? 2 : 1)),
    );

    authFetch.mockClear();
    expect((await host.getDatabase(["characters"])).characters).toEqual(first.characters);
    expect(authFetch).not.toHaveBeenCalled();
    passRecheckWindow();
    const second = await host.getDatabase(["characters"]);
    expect(revisionRequests()).toHaveLength(1);
    expect(projectionRequests().map(([path]) => path)).toEqual(tail.map(({ id }) => projectionPath(id)));
    expect(second.characters[0].chats.map((value: Chat) => value.hypaV3Data)).toEqual(
        rows.map((_, index) => memory(index + 1, 2)),
    );
});

it("asks about a chat beyond the revision cap on the very next read", async () => {
    const rows = install(MEMORY_REVISION_CHATS_MAX + 1);
    const host = await api();
    expect((await host.getDatabase(["characters"])).characters[0].chats).toHaveLength(rows.length);
    expect(authFetch).toHaveBeenCalledTimes(1);
    const asked = refsOf(revisionRequests()[0][1]);
    expect(asked).toHaveLength(MEMORY_REVISION_CHATS_MAX);
    const askedIds = new Set(asked.map(({ chatId }) => chatId));
    const tail = rows.filter(({ id }) => !askedIds.has(id));
    expect(tail).toHaveLength(1);

    // No clock advance: an unasked chat has no check to throttle.
    expect((await host.getDatabase(["characters"])).characters[0].chats).toHaveLength(rows.length);
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, revisionPath]);
    expect(refsOf(revisionRequests()[1][1])).toEqual(tail.map(({ id }) => ({ characterId: "c", chatId: id })));
});

it("drops a held projection under another algorithm inside the window without a request", async () => {
    const host = await api();
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 1));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    authFetch.mockClear();
    settings.ui.memoryAlgorithmType = "hypaV3";
    expect(await host.getChatFromIndex(0, 0)).not.toHaveProperty("hypaV3Data");
    expect(chats.findChat(ref)).not.toHaveProperty("hypaV3Data");
    expect(authFetch).not.toHaveBeenCalled();
});

it("refreshes every chat-returning getter in one batch, waits for moved projections, and reuses whole-read revisions", async () => {
    const host = await api();
    const getters = [
        { read: () => host.getChatFromIndex(0, 0), values: (value: any) => [value], ids: ["k0"] },
        ...["getChar", "getCharacter", "getCharacterFromIndex"].map((method) => ({
            read: () => host[method](0),
            values: (value: any) => value.chats,
            ids: ["k0", "k1"],
        })),
        {
            read: () => host.getDatabase(["characters"]),
            values: (value: any) => value.characters[0].chats,
            ids: ["k0", "k1"],
        },
    ];
    for (const getter of getters) {
        passRecheckWindow();
        install();
        respond();
        authFetch.mockClear();
        expect(getter.values(await getter.read())[0].hypaV3Data).toEqual(memory(1, 1));
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch.mock.calls[0][0]).toBe(revisionPath);
        expect(authFetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
        expect(refsOf(authFetch.mock.calls[0][1])).toEqual(getter.ids.map((chatId) => ({ characterId: "c", chatId })));
        const held = deferred<Response>();
        const entered = deferred<void>();
        authFetch.mockImplementation(async (path: string, init: RequestInit) => {
            if (path === revisionPath)
                return Response.json({
                    revisions: refsOf(init).map(({ chatId }) =>
                        token(Number(chatId.slice(1)) + 1, chatId === "k0" ? 2 : 1),
                    ),
                });
            entered.resolve();
            return held.promise;
        });
        let done = false;
        passRecheckWindow();
        const reading = getter.read().then((value: any) => {
            done = true;
            return value;
        });
        try {
            await entered.promise;
            expect(done).toBe(false);
        } finally {
            held.resolve(Response.json({ revision: token(1, 2), hypaV3Data: memory(1, 2) }));
            await reading;
        }
        const values = getter.values(await reading);
        expect(values[0].hypaV3Data).toEqual(memory(1, 2));
        if (values.length > 1) expect(values[1].hypaV3Data).toEqual(memory(2, 1));
        expect(projectionRequests().map(([path]) => path)).toEqual([projectionPath("k0")]);
    }
});

it("skips locally ineligible chats and all writes, then refreshes a session-created chat once saved", async () => {
    const host = await api();
    const original = {
        chaId: "c",
        name: "C",
        type: "character",
        chats: [chat("k0", memory(1, 1)), chat("k1", memory(2, 1))],
        chatPage: 0,
    };
    await host.setChar(original);
    await host.setCharacter(original);
    await host.setCharacterToIndex(0, original);
    await host.setDatabase({ characters: [original] });
    await host.setDatabaseLite({ characters: [original] });
    await host.getDatabase(["theme"]);
    expect(authFetch).not.toHaveBeenCalled();
    settings.ui.memoryAlgorithmType = "hypaV3";
    expect((await host.getChar()).chats.every((value: Chat) => value.hypaV3Data === undefined)).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();
    const real = { summaries: [{ text: "Owned by HypaV3", chatMemos: [], isImportant: true }] };
    chats.setChatMeta(ref, { hypaV3Data: real });
    settings.ui.memoryAlgorithmType = "structuredMemory";
    chats.createChat("c", chat("new"));
    authFetch.mockImplementation(async (_path: string, init: RequestInit) =>
        Response.json({ revisions: refsOf(init).map(() => null) }),
    );
    const got = await host.getChar();
    expect(got.chats.find((value: Chat) => value.id === "k0").hypaV3Data).toEqual(real);
    expect(refsOf(authFetch.mock.calls[0][1])).toEqual([{ characterId: "c", chatId: "k1" }]);
    // A session-created chat whose create was acknowledged has a server token and no projection yet.
    install(1);
    chats.createChat("c", chat("new"));
    const work = chats.takeChatWork(new Set());
    chats.ackChatWork(work, [{ characterId: "c", id: "new", revision: token(9, 1) }], []);
    authFetch.mockClear();
    authFetch.mockImplementation(async (path: string) =>
        Response.json(
            path === revisionPath ? { revisions: [token(9, 2)] } : { revision: token(9, 2), hypaV3Data: memory(9, 2) },
        ),
    );
    const index = chats.chatList("c").findIndex(({ id }) => id === "new");
    expect((await host.getChatFromIndex(0, index)).hypaV3Data).toEqual(memory(9, 2));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, projectionPath("new")]);
});

it("retains held values on failed answers and removes only sealed values when either route answers null", async () => {
    const host = await api();
    for (const response of [
        () => Response.json({ error: "offline" }, { status: 503 }),
        () => Response.json({ revisions: [] }),
    ]) {
        passRecheckWindow();
        authFetch.mockClear();
        authFetch.mockImplementation(response);
        expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 1));
        expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath]);
    }
    passRecheckWindow();
    authFetch.mockClear();
    respond(2);
    authFetch
        .mockImplementationOnce(async () => Response.json({ revisions: [token(1, 2)] }))
        .mockImplementationOnce(async () => Response.json({ error: "offline" }, { status: 503 }));
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(memory(1, 1));
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([revisionPath, projectionPath("k0")]);
    for (const throughProjection of [false, true]) {
        passRecheckWindow();
        install();
        authFetch.mockClear();
        authFetch.mockImplementation(async (path: string) =>
            Response.json(
                path === revisionPath
                    ? { revisions: [throughProjection ? token(1, 2) : null] }
                    : { revision: token(1, 2), hypaV3Data: null },
            ),
        );
        expect(await host.getChatFromIndex(0, 0)).not.toHaveProperty("hypaV3Data");
        expect(authFetch).toHaveBeenCalledTimes(throughProjection ? 2 : 1);
    }
});

it.each(["revisions", "projection"])("bounds a hung %s answer and refuses its late installation", async (stage) => {
    const host = await api();
    const held = deferred<Response>();
    const entered = deferred<void>();
    let signal: AbortSignal;
    authFetch.mockImplementation(async (path: string, init: RequestInit) => {
        if (stage === "projection" && path === revisionPath) return Response.json({ revisions: [token(1, 2)] });
        signal = init.signal!;
        entered.resolve();
        return held.promise;
    });
    let done = false;
    const reading = host.getChatFromIndex(0, 0).then((value: Chat) => {
        done = true;
        return value;
    });
    try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
        expect((await reading).hypaV3Data).toEqual(memory(1, 1));
        expect(signal!.aborted).toBe(true);
    } finally {
        held.resolve(
            Response.json(
                stage === "projection" ? { revision: token(1, 2), hypaV3Data: memory(1, 2) } : { revisions: [null] },
            ),
        );
        await reading;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(chats.findChat(ref)!.hypaV3Data).toEqual(memory(1, 1));
});

it("caps database projections, prioritizes the selected chat, and reaches beyond repeatedly failing chats", async () => {
    const count = projectionLimit * 2 + 3;
    install(count);
    chats.selectChat("c", `k${count - 1}`);
    const host = await api();
    const visited = new Set<string>();
    authFetch.mockImplementation(async (path: string, init: RequestInit) => {
        if (path === revisionPath)
            return Response.json({
                revisions: refsOf(init).map(({ chatId }) => token(Number(chatId.slice(1)) + 1, 2)),
            });
        const id = path.split("/").at(-2)!;
        visited.add(id);
        return Response.json({ error: "unavailable" }, { status: 503 });
    });
    for (let round = 0; round < count; round++) {
        passRecheckWindow();
        authFetch.mockClear();
        const got = await host.getDatabase(["characters"]);
        expect(got.characters[0].chats).toHaveLength(count);
        expect(got.characters[0].chats[0].hypaV3Data).toEqual(memory(1, 1));
        expect(revisionRequests()).toHaveLength(1);
        expect(projectionRequests()).toHaveLength(projectionLimit);
        expect(projectionRequests()[0][0]).toBe(projectionPath(`k${count - 1}`));
        if (visited.size === count) break;
    }
    expect(visited.size).toBe(count);
});

it("caps a database revision batch and rotates to chats beyond the first batch", async () => {
    const count = MEMORY_REVISION_CHATS_MAX + 2;
    install(count);
    chats.selectChat("c", `k${count - 1}`);
    const host = await api();
    const visited = new Set<string>();
    for (let round = 0; round < 2; round++) {
        passRecheckWindow();
        authFetch.mockClear();
        expect((await host.getDatabase(["characters"])).characters[0].chats).toHaveLength(count);
        expect(authFetch).toHaveBeenCalledTimes(1);
        const asked = refsOf(authFetch.mock.calls[0][1]);
        expect(asked).toHaveLength(MEMORY_REVISION_CHATS_MAX);
        expect(asked[0].chatId).toBe(`k${count - 1}`);
        asked.forEach(({ chatId }) => visited.add(chatId));
    }
    expect(visited.size).toBe(count);
});

it("loads a chat added by a collection update during refresh before returning the database", async () => {
    const rows = install(1);
    const host = await api();
    const held = deferred<Response>();
    const entered = deferred<void>();
    authFetch.mockImplementation(async () => {
        entered.resolve();
        return held.promise;
    });
    const reading = host.getDatabase(["characters"]);
    try {
        await entered.promise;
        rows.push({ characterId: "c", id: "k1", revision: token(2, 1), data: chat("k1", memory(2, 1)) });
        chats.applyRemoteCollection({
            characterId: "c",
            order: { characterId: "c", revision: token(1, 2), ids: ["k0", "k1"] },
            chats: rows.map(({ data, ...row }) => ({ ...row, name: data.name, fmIndex: -1 })),
        });
        expect(chats.findChat({ chaId: "c", chatId: "k1" })).toBeUndefined();
    } finally {
        held.resolve(Response.json({ revisions: [token(1, 1)] }));
        await reading;
    }
    const got = await reading;
    expect(got.characters[0].chats.map((value: Chat) => value.id)).toEqual(["k0", "k1"]);
    expect(got.characters[0].chats[1].message).toEqual(chat("k1").message);
    expect(readRefs).toHaveBeenCalledTimes(1);
});

it("preserves declined real summaries and refreshes an adopted chat's projection after reset hydration", async () => {
    const rows = install();
    const real = { summaries: [{ text: "Real HypaV3 memory", chatMemos: ["m"], isImportant: true }] };
    for (const row of rows)
        chats.hydrateChat({ ...row, revision: token(Number(row.id.slice(1)) + 1, 2), data: chat(row.id, real) });
    const host = await api();
    const fetch = authFetch.getMockImplementation()!;
    authFetch.mockImplementation((path: string, init: RequestInit) => {
        if (path.endsWith("/decline")) return Promise.resolve(Response.json({ revision: token(1, 1), declined: true }));
        if (path.endsWith("/reset-summaries"))
            return Promise.resolve(Response.json({ chatRevision: token(2, 3), reset: true }));
        return fetch(path, init);
    });
    expect((await declineStructuredMemory(ref)).outcome).toBe("ok");
    expect((await host.getChatFromIndex(0, 0)).hypaV3Data).toEqual(real);
    expect(revisionRequests()).toHaveLength(0);
    expect(projectionRequests()).toHaveLength(0);
    expect((await resetStructuredMemorySummaries({ chaId: "c", chatId: "k1" })).outcome).toBe("ok");
    // The reset's chat notice is hydrated before the next plugin read; its memory revision did not move.
    chats.hydrateChat({ characterId: "c", id: "k1", revision: token(2, 3), data: chat("k1") });
    const result = await host.getChar();
    expect(result.chats.map((value: Chat) => value.hypaV3Data)).toEqual([real, memory(2, 1)]);
    expect(refsOf(revisionRequests()[0][1])).toEqual([{ characterId: "c", chatId: "k1" }]);
    expect(projectionRequests().map(([path]) => path)).toEqual([projectionPath("k1")]);
    expect(chats.findChat(ref)?.hypaV3Data).toEqual(real);
});
