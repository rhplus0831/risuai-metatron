import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_TASKS_PATH, type MemoryTaskEntry } from "../../../shared/events.ts";
import type { MemoryTaskStatus } from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { KINDS, SAVE_DEBOUNCE_MS, warmMutationGraph } from "../storage/tests/mutationStoresHarness";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// The tab's memory task module (`memoryTasks.svelte.ts`) over the real chat module and save loop
// against the real server store in memory: the feed handlers (frames, `hello`, the reconnect's
// revision listing) are called as `eventFeed.ts` calls them, a task's commit is a server write of
// `hypaV3Data`, and the loop's reads adopt it under fake timers. Covered here:
// - the fence while a task is queued or running, then until the mirror holds the terminal's revision
//   (the terminal asks the loop to read the chat; the badge count follows the status and clears on
//   `done`);
// - a tab whose first sight of a task is a terminal (a frame or a `hello` entry, a no-commit
//   `skipped` included) with a revision the mirror lacks, one it holds, or none (the chat is gone);
// - a disconnect, ten minutes, an empty `hello`, and the listing keep the fence until adoption; a
//   `hello` restores a running task's badge and replaces the status map;
// - a read refused for pending local work does not clear the fence; a late read for an earlier task
//   does not clear a newer task's fence; a terminal of another task leaves a live task alone;
// - "Summarize now": the fence from before the flush, the request, the answers (a refusal, queued,
//   `pendingManual`, one superseded by a frame, a late one for a task already known terminal), a
//   transport failure's uncertain fence and what resolves it, one request per chat, and "Cancel".

const { server, routes } = vi.hoisted(() => ({
    server: { current: null as any },
    /** The memory task routes: every request as sent, answered by the test's `answer`. */
    routes: {
        requests: [] as { path: string; init: RequestInit }[],
        answer: null as null | ((path: string, init: RequestInit) => Promise<Response>),
    },
}));

vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: async (path: string, init: RequestInit = {}) => {
            if (path.startsWith(MEMORY_TASKS_PATH)) {
                routes.requests.push({ path, init });
                return await routes.answer!(path, init);
            }
            return await server.current.fetch(path, init);
        },
    }),
);
vi.mock("../alert", async () => (await import("../tests/alertMock")).createAlertMock());
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Tasks = typeof import("./memoryTasks.svelte");
type ChatModule = typeof import("../storage/chatStore.svelte");
type Sync = typeof import("../storage/resourceSync.svelte");

const refK = { chaId: "c", chatId: "k" };
const keyK = "c\u0000k";
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const summary = (text: string, memo: string) => ({ text, chatMemos: [memo], isImportant: false });
const json = (status: number, body: unknown) => Response.json(body, { status });

/** A live task's status, as the server reports it. */
const live = (taskId: string, state: "queued" | "running", done = 0, total = 0): MemoryTaskStatus => ({
    taskId,
    state,
    done,
    total,
});
/** A terminal status with the revision the chat had when the task's writes closed. */
const terminal = (
    taskId: string,
    state: "done" | "failed" | "cancelled" | "skipped",
    terminalRevision: string | null,
    extra: { reason?: string; error?: string; lastCommittedRevision?: string; done?: number; total?: number } = {},
): MemoryTaskStatus => ({
    taskId,
    state,
    done: extra.done ?? 0,
    total: extra.total ?? 0,
    terminalRevision,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.lastCommittedRevision ? { lastCommittedRevision: extra.lastCommittedRevision } : {}),
});
const entry = (status: MemoryTaskStatus, ref = refK): MemoryTaskEntry => ({
    characterId: ref.chaId,
    chatId: ref.chatId,
    status,
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Boots the save loop and the chat module the way `loadData` does against a server holding a
 * character `c` with chat `k` (messages a, b; summaries "one", "two") and chat `j` (empty): read,
 * seed, install, start, let the boot compare pass run.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create();
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
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
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char"), m("b", "B")],
                            hypaV3Data: { summaries: [summary("one", "a"), summary("two", "b")], categories: [] },
                        } as any,
                    },
                ],
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J", note: "", localLore: [], message: [] } as any }],
            },
        ],
    });
    server.current = fake;
    routes.requests.length = 0;
    routes.answer = null;

    const client = await import("../storage/resourceClient");
    const sync: Sync = await import("../storage/resourceSync.svelte");
    const chat: ChatModule = await import("../storage/chatStore.svelte");
    const bootstrap = await import("../bootstrap");
    const selection = await import("../storage/selection.svelte");
    const tasks: Tasks = await import("./memoryTasks.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;

    /** The chat's revision on the server now. */
    const serverRevision = () => fake.chat("c", "k")!.revision;
    /** A task's commit on the server: the summaries written as the chat's `hypaV3Data`; returns the new revision. */
    const taskWrite = (texts: string[]) => {
        fake.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: serverRevision(),
                    ops: [
                        {
                            op: "meta",
                            set: {
                                hypaV3Data: {
                                    summaries: texts.map((text, index) => summary(text, `m${index}`)),
                                    categories: [],
                                },
                            },
                        },
                    ],
                },
            ],
        });
        return serverRevision();
    };
    /** The summaries the mirror holds. */
    const stored = () => ((chat.findChat(refK) as any)?.hypaV3Data?.summaries ?? []).map((s: any) => s.text);
    /** The save loop's next cycle (its reads included). */
    const settle = () => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 100);
    const fenced = () => tasks.memoryTaskFenced(refK);
    const awaiting = () => tasks.memoryTaskAwaitingSync(refK);
    const state = () => tasks.memoryTaskStatus(refK)?.state ?? null;
    /** The reconnect as `eventFeed.ts` runs it: the `hello`, then the listing to the module and the loop. */
    const reconnect = (entries: MemoryTaskEntry[]) => {
        const hello = tasks.noteMemoryTaskHello(entries);
        const listing = fake.store.listRevisions();
        tasks.noteMemoryTaskListing(hello, listing);
        sync.reconcileRemote(listing);
        return hello;
    };
    return {
        fake,
        client,
        sync,
        chat,
        tasks,
        serverRevision,
        taskWrite,
        stored,
        settle,
        fenced,
        awaiting,
        state,
        reconnect,
    };
}

beforeAll(() => warmMutationGraph(() => import("./memoryTasks.svelte")), 60_000);

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("the fence over frames and the save loop", () => {
    it("fences while the task is queued or running, then until the loop adopted the terminal's revision; the count follows and clears on done", async () => {
        const { tasks, chat, taskWrite, stored, settle, fenced, awaiting, state, serverRevision } = await boot();
        expect(fenced()).toBe(false);
        expect(tasks.summarizingChats().size).toBe(0);

        tasks.noteMemoryTaskFrame({ type: "memoryTask", epoch: "x", ...entry(live("A", "queued")) });
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(false);
        expect(state()).toBe("queued");
        expect(tasks.summarizingChats()).toEqual(new Map([[keyK, null]]));

        tasks.noteMemoryTaskFrame(entry(live("A", "running", 1, 3)));
        expect(tasks.summarizingChats()).toEqual(new Map([[keyK, { done: 1, total: 3 }]]));
        // A running task without a known total has no count.
        tasks.noteMemoryTaskFrame(entry(live("A", "running", 0, 0)));
        expect(tasks.summarizingChats()).toEqual(new Map([[keyK, null]]));

        // The task commits; its terminal reaches the tab before the loop read the chat.
        const before = serverRevision();
        const committed = taskWrite(["one", "two", "three"]);
        tasks.noteMemoryTaskFrame(
            entry(terminal("A", "done", committed, { done: 3, total: 3, lastCommittedRevision: committed })),
        );
        expect(state()).toBe("done");
        expect(tasks.summarizingChats().size).toBe(0);
        expect(stored()).toEqual(["one", "two"]);
        expect(chat.heldChatRevision(refK)).toBe(before);
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);

        // The loop reads the chat (the terminal told it to): the mirror holds the summaries, the fence drops.
        await settle();
        expect(stored()).toEqual(["one", "two", "three"]);
        expect(chat.heldChatRevision(refK)).toBe(committed);
        expect(fenced()).toBe(false);
        expect(awaiting()).toBe(false);
        expect(state()).toBe("done");
    });

    it("fences a first-seen terminal whose revision the mirror lacks (a no-commit skipped included), not one it holds or a gone chat's", async () => {
        const { tasks, fake, settle, fenced, awaiting, state, serverRevision } = await boot();
        // Another tab renamed the chat: the server is ahead of the mirror; the task read that and skipped.
        fake.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: serverRevision(),
                    ops: [{ op: "meta", set: { name: "K2" } }],
                },
            ],
        });
        tasks.noteMemoryTaskFrame(entry(terminal("S", "skipped", serverRevision(), { reason: "staleInput" })));
        expect(state()).toBe("skipped");
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        await settle();
        expect(fenced()).toBe(false);

        // A terminal at the revision the mirror holds already: no fence.
        tasks.noteMemoryTaskFrame(entry(terminal("T", "failed", serverRevision(), { error: "boom" })));
        expect(state()).toBe("failed");
        expect(fenced()).toBe(false);

        // The chat is gone on the server (`terminalRevision` null): nothing to wait for.
        tasks.noteMemoryTaskFrame(entry(terminal("U", "cancelled", null, { reason: "chatGone" })));
        expect(fenced()).toBe(false);

        // A malformed frame changes nothing.
        tasks.noteMemoryTaskFrame({ characterId: "c", chatId: "k", status: { taskId: "V", state: "done" } });
        expect(state()).toBe("cancelled");
    });

    it("keeps the fence over a disconnect, ten minutes, an empty hello, and the listing until the loop adopted the listed revision", async () => {
        const { tasks, sync, taskWrite, stored, settle, fenced, awaiting, state, serverRevision } = await boot();
        tasks.noteMemoryTaskFrame(entry(live("A", "running", 1, 2)));
        // The socket drops; the task commits and its terminal expires from the server's snapshot meanwhile.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        const committed = taskWrite(["one", "two", "three"]);
        expect(fenced()).toBe(true);

        const hello = tasks.noteMemoryTaskHello([]);
        expect(state()).toBeNull();
        expect(tasks.summarizingChats().size).toBe(0);
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);

        // A listing of an earlier connection changes nothing; this connection's names the committed revision.
        tasks.noteMemoryTaskListing(hello - 1, { epoch: "", resources: [], chats: [], chatOrders: [] });
        expect(fenced()).toBe(true);
        const listing = server.current.store.listRevisions();
        expect(listing.chats.find((chat: any) => chat.id === "k")?.revision).toBe(committed);
        tasks.noteMemoryTaskListing(hello, listing);
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        sync.reconcileRemote(listing);
        expect(stored()).toEqual(["one", "two"]);

        await settle();
        expect(stored()).toEqual(["one", "two", "three"]);
        expect(fenced()).toBe(false);
        expect(serverRevision()).toBe(committed);
    });

    it("restores a running task's badge from a reconnect hello, fences a terminal first seen there, and drops a chat the listing lacks", async () => {
        const { tasks, fake, taskWrite, settle, fenced, awaiting, state, reconnect } = await boot();
        reconnect([entry(live("A", "running", 2, 4))]);
        expect(state()).toBe("running");
        expect(tasks.summarizingChats()).toEqual(new Map([[keyK, { done: 2, total: 4 }]]));
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(false);

        // The next hello carries its terminal (the task committed while disconnected).
        const committed = taskWrite(["one", "two", "three"]);
        reconnect([entry(terminal("A", "done", committed, { done: 4, total: 4, lastCommittedRevision: committed }))]);
        expect(state()).toBe("done");
        expect(tasks.summarizingChats().size).toBe(0);
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        await settle();
        expect(fenced()).toBe(false);

        // A hello replaces the status map: a chat absent from the snapshot has no status any more.
        reconnect([]);
        expect(state()).toBeNull();

        // A chat deleted on the server: a tracked chat the listing lacks is released (nothing to adopt).
        const refJ = { chaId: "c", chatId: "j" };
        tasks.noteMemoryTaskFrame(entry(live("B", "queued"), refJ));
        expect(tasks.memoryTaskFenced(refJ)).toBe(true);
        fake.store.applyChanges({
            chats: [
                { characterId: "c", chatId: "j", baseRevision: fake.chat("c", "j")!.revision, ops: [{ op: "delete" }] },
            ],
        });
        reconnect([]);
        await settle();
        expect(tasks.memoryTaskFenced(refJ)).toBe(false);
    });

    it("keeps the fence when a read is refused for pending local work, until the loop saved it and adopted the server's copy", async () => {
        const { tasks, chat, taskWrite, stored, settle, fenced } = await boot();
        chat.setChatMeta(refK, { name: "Mine" });
        const held = chat.heldChatRevision(refK);
        const committed = taskWrite(["one", "two", "three"]);
        tasks.noteMemoryTaskFrame(entry(terminal("A", "done", committed, { lastCommittedRevision: committed })));
        expect(fenced()).toBe(true);

        // The server's copy arrives while the rename is unsaved: refused (not adopted), the base stays.
        const copy = server.current.chat("c", "k")!;
        expect(chat.hydrateChat({ characterId: "c", id: "k", revision: copy.revision, data: copy.data })).toBe(false);
        expect(chat.heldChatRevision(refK)).toBe(held);
        expect(stored()).toEqual(["one", "two"]);
        expect(fenced()).toBe(true);

        // The loop saves the rename on the older base and reads the chat: both land, the fence drops.
        await settle();
        await settle();
        expect(stored()).toEqual(["one", "two", "three"]);
        expect(chat.findChat(refK)?.name).toBe("Mine");
        expect(server.current.chat("c", "k")!.data.name).toBe("Mine");
        expect(fenced()).toBe(false);
    });

    it("lets neither a late read for an earlier task nor another task's terminal clear a newer task's fence", async () => {
        const { tasks, chat, taskWrite, stored, settle, fenced, state } = await boot();
        const first = taskWrite(["one", "two", "three"]);
        tasks.noteMemoryTaskFrame(entry(terminal("A", "done", first, { lastCommittedRevision: first })));
        // Before the loop read A's commit, B starts (a send handed the chat off again).
        tasks.noteMemoryTaskFrame(entry(live("B", "running", 0, 1)));
        expect(state()).toBe("running");
        await settle();
        expect(stored()).toEqual(["one", "two", "three"]);
        expect(chat.heldChatRevision(refK)).toBe(first);
        expect(fenced()).toBe(true);

        // A queued task C cancelled while B runs: B stays the chat's status and fence.
        tasks.noteMemoryTaskFrame(entry(terminal("C", "cancelled", first, { reason: "cancelled" })));
        expect(state()).toBe("running");
        expect(fenced()).toBe(true);

        const second = taskWrite(["one", "two", "three", "four"]);
        tasks.noteMemoryTaskFrame(entry(terminal("B", "done", second, { lastCommittedRevision: second })));
        expect(state()).toBe("done");
        expect(fenced()).toBe(true);
        await settle();
        expect(stored()).toEqual(["one", "two", "three", "four"]);
        expect(fenced()).toBe(false);
    });
});

describe("Summarize now and Cancel", () => {
    it("fences the chat before the flush, sends the start with the epoch header, and releases on a definite refusal", async () => {
        const { tasks, client, fenced, awaiting } = await boot();
        routes.answer = async () => json(503, { error: "Memory tasks are not enabled", reason: "notEnabled" });
        const started = tasks.startMemoryTask(refK);
        // Synchronously, before the flush began: an edit made during the flush is refused.
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(false);
        expect(tasks.memoryTaskRequestPending(refK)).toBe(true);
        expect(await started).toEqual({ outcome: "refused", reason: "notEnabled" });
        expect(fenced()).toBe(false);
        expect(tasks.memoryTaskRequestPending(refK)).toBe(false);
        expect(routes.requests).toHaveLength(1);
        const [{ path, init }] = routes.requests;
        expect(path).toBe(MEMORY_TASKS_PATH);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get(RESOURCE_EPOCH_HEADER)).toBe(client.getResourceEpoch());
        expect(JSON.parse(init.body as string)).toEqual({ characterId: "c", chatId: "k" });

        // The other refusals and a 404.
        for (const [status, body, reason] of [
            [429, { reason: "queueFull" }, "queueFull"],
            [503, { reason: "maintenance" }, "maintenance"],
            [404, { error: "Chat not found" }, "chatGone"],
        ] as const) {
            routes.answer = async () => json(status, body);
            expect(await tasks.startMemoryTask(refK)).toEqual({ outcome: "refused", reason });
            expect(fenced()).toBe(false);
        }
    });

    it("takes a queued answer as the live status, keeps one request per chat, shows pendingManual once, and cancels", async () => {
        const { tasks, fenced, state } = await boot();
        routes.answer = async () => json(200, { outcome: "pendingManual" });
        expect(await tasks.startMemoryTask(refK)).toEqual({ outcome: "pendingManual" });
        expect(tasks.memoryTaskPendingManual(refK)).toBe(true);
        expect(fenced()).toBe(false);

        const answer = deferred<Response>();
        routes.answer = () => answer.promise;
        const started = tasks.startMemoryTask(refK);
        await vi.advanceTimersByTimeAsync(0);
        expect(await tasks.startMemoryTask(refK)).toEqual({ outcome: "busy" });
        expect(await tasks.cancelMemoryTask(refK)).toEqual({ outcome: "busy" });
        answer.resolve(json(200, { outcome: "queued", status: live("A", "queued") }));
        expect(await started).toEqual({ outcome: "queued" });
        expect(state()).toBe("queued");
        expect(fenced()).toBe(true);
        expect(tasks.memoryTaskPendingManual(refK)).toBe(false);
        expect(tasks.summarizingChats()).toEqual(new Map([[keyK, null]]));

        routes.answer = async () => json(200, { cancelled: true });
        expect(await tasks.cancelMemoryTask(refK)).toEqual({ outcome: "cancelled" });
        const [, , { path, init }] = routes.requests;
        expect(path).toBe(`${MEMORY_TASKS_PATH}/c/k`);
        expect(init.method).toBe("DELETE");
        // The task's end comes as its frame; until then the status and fence stay.
        expect(fenced()).toBe(true);
        tasks.noteMemoryTaskFrame(entry(terminal("A", "cancelled", server.current.chat("c", "k")!.revision)));
        expect(state()).toBe("cancelled");
        expect(fenced()).toBe(false);
    });

    it("does not revive a task's fence from a late queued answer once its terminal was adopted, and lets a frame's status win over the answer's", async () => {
        const { tasks, fenced, state, serverRevision } = await boot();
        const answer = deferred<Response>();
        routes.answer = () => answer.promise;
        const started = tasks.startMemoryTask(refK);
        await vi.advanceTimersByTimeAsync(0);
        expect(fenced()).toBe(true);
        // The task ran and ended before its start answer got through (the socket was down while it ran,
        // so its terminal is the first frame seen); the mirror holds its revision.
        tasks.noteMemoryTaskFrame(entry(terminal("A", "done", serverRevision())));
        expect(fenced()).toBe(true);
        answer.resolve(json(200, { outcome: "queued", status: live("A", "queued") }));
        expect(await started).toEqual({ outcome: "queued" });
        expect(state()).toBe("done");
        expect(fenced()).toBe(false);
        expect(tasks.memoryTaskAwaitingSync(refK)).toBe(false);

        // A frame of another task meanwhile: the answer's task may still be live, so the fence is kept
        // live, but the frame's status stands.
        const again = deferred<Response>();
        routes.answer = () => again.promise;
        const second = tasks.startMemoryTask(refK);
        await vi.advanceTimersByTimeAsync(0);
        tasks.noteMemoryTaskFrame(entry(terminal("Z", "skipped", serverRevision(), { reason: "staleInput" })));
        again.resolve(json(200, { outcome: "running", status: live("B", "running", 0, 2) }));
        expect(await second).toEqual({ outcome: "running" });
        expect(state()).toBe("skipped");
        expect(fenced()).toBe(true);
        tasks.noteMemoryTaskFrame(entry(terminal("B", "done", serverRevision())));
        expect(fenced()).toBe(false);
    });

    it("keeps an uncertain fence after a transport failure or an unrecognized answer until a frame or a reconnect resolves it", async () => {
        const { tasks, fenced, awaiting, state, reconnect } = await boot();
        routes.answer = async () => {
            throw new TypeError("Failed to fetch");
        };
        expect(await tasks.startMemoryTask(refK)).toEqual({
            outcome: "failed",
            stage: "request",
            error: "Failed to fetch",
        });
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        expect(state()).toBeNull();

        // A retry refused for good puts the uncertain fence back; a retry that is accepted makes it live.
        routes.answer = async () => json(503, { reason: "notEnabled" });
        expect(await tasks.startMemoryTask(refK)).toEqual({ outcome: "refused", reason: "notEnabled" });
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        routes.answer = async () => json(200, { outcome: "queued", status: live("A", "queued") });
        expect(await tasks.startMemoryTask(refK)).toEqual({ outcome: "queued" });
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(false);
        tasks.noteMemoryTaskFrame(entry(terminal("A", "done", server.current.chat("c", "k")!.revision)));
        expect(fenced()).toBe(false);

        // An unrecognized 200 body is as uncertain as a lost answer; the reconnect's listing resolves it.
        routes.answer = async () => json(200, { outcome: "queued" });
        expect(await tasks.startMemoryTask(refK)).toEqual({
            outcome: "failed",
            stage: "request",
            error: "Unexpected answer",
        });
        expect(fenced()).toBe(true);
        expect(awaiting()).toBe(true);
        reconnect([]);
        expect(fenced()).toBe(false);

        // A live frame resolves it too.
        routes.answer = async () => {
            throw new TypeError("Failed to fetch");
        };
        await tasks.startMemoryTask(refK);
        expect(awaiting()).toBe(true);
        tasks.noteMemoryTaskFrame(entry(live("C", "queued")));
        expect(awaiting()).toBe(false);
        expect(state()).toBe("queued");
    });

    it("supersedes a pendingManual answer a frame overtook, and every answer after the epoch changed", async () => {
        const { tasks, fenced, state } = await boot();
        const answer = deferred<Response>();
        routes.answer = () => answer.promise;
        const started = tasks.startMemoryTask(refK);
        await vi.advanceTimersByTimeAsync(0);
        tasks.noteMemoryTaskFrame(entry(live("A", "running", 0, 1)));
        answer.resolve(json(200, { outcome: "pendingManual" }));
        expect(await started).toEqual({ outcome: "superseded" });
        expect(tasks.memoryTaskPendingManual(refK)).toBe(false);
        expect(state()).toBe("running");
        expect(fenced()).toBe(true);

        const late = deferred<Response>();
        routes.answer = () => late.promise;
        const cancel = tasks.cancelMemoryTask(refK);
        await vi.advanceTimersByTimeAsync(0);
        tasks.resetMemoryTasks();
        expect(state()).toBeNull();
        expect(fenced()).toBe(false);
        late.resolve(json(200, { cancelled: true }));
        expect(await cancel).toEqual({ outcome: "superseded" });
        expect(fenced()).toBe(false);
    });
});
