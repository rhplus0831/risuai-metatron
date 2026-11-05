import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../../shared/chats.ts";
import type { Message } from "../../../../shared/database.ts";
import { MAX_FEED_PATCH_BYTES, SMALL_FEED_PATCH_BYTES, RESOURCE_KIND } from "../../../../shared/resources.ts";
import { warmMutationGraph } from "./mutationStoresHarness";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// Real store commits reach the real save adapter synchronously, as the live feed does.

const { server, alerts, dispatch } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
    /** When set, a request waits here after authentication and before `beforeDispatch`. */
    dispatch: { gate: null as Promise<void> | null },
}));

vi.mock("../serverAuth", () => ({
    // `authFetch`'s contract: `beforeDispatch` runs after authentication and signing, right before the request.
    authFetch: async (path: string, init?: RequestInit, options: { beforeDispatch?: () => void } = {}) => {
        if (dispatch.gate) {
            await dispatch.gate;
        }
        options.beforeDispatch?.();
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertTerminal: alerts.terminal,
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", async () => (await import("../../tests/globalApiMock")).createGlobalApiMock());

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type Selection = typeof import("../selection.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const chat = (id: string, messages: any[] = []) =>
    ({ id, name: id, note: "", localLore: [], message: messages }) as any;
const create = (characterId: string, id: string, messages: any[] = []) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [{ op: "create", chat: chat(id, messages) }],
});
const refK = { chaId: "c", chatId: "k" };

/**
 * Boots the adapter and the chat module the way `loadData` does, against a store-backed server
 * with the change feed: presets `pa` and `pb`, character `c` (chats `k` with messages a, b, c and
 * `j`, empty) and character `d` (chat `m`), at home. Then live delivery starts.
 */
async function boot(options: { summaries?: boolean; meta?: Record<string, unknown>; messages?: Message[] } = {}) {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true, feed: true });
    fake.set("presets", "main", [
        { id: "pa", name: "p1" },
        { id: "pb", name: "p2" },
    ]);
    fake.set("modelPresets", "main", [
        { id: "ma", name: "m1" },
        { id: "mb", name: "m2" },
    ]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [
            { kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: fake.kind("characters"), id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            create("c", "k", options.messages ?? [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")]),
            create("c", "j"),
            create("d", "m", [m("x", "X")]),
        ],
    });
    if (options.meta) {
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: options.meta }],
            },
        ]);
    }
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chatModule: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, options.summaries ? { chatSummaries: true } : { chats: true });
    sync.seedResources(snapshot);
    chatModule.seedChats(
        (options.summaries ? snapshot.chatSummaries : snapshot.chats) ?? [],
        snapshot.chatOrders ?? [],
    );
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chatModule.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    // The live-update socket's stand-in: each `change` of the loaded epoch goes to `noteRemoteChanges`,
    // then its generation locks to the chat module (`eventFeed.ts` `receive`).
    const live = { paused: false, queue: [] as ServerFeedEvent[] };
    const deliver = (event: ServerFeedEvent) => {
        if (event.type === "change" && event.epoch === client.getResourceEpoch()) {
            sync.noteRemoteChanges(event.changes);
            if (event.streaming) {
                chatModule.noteRemoteStreaming(event.streaming, event.changes);
            }
        }
    };
    fake.onFeed = (event) => (live.paused ? live.queue.push(event) : deliver(event));
    const flushFeed = () => {
        for (const event of live.queue.splice(0)) {
            deliver(event);
        }
    };

    return { fake, sync, client, chat: chatModule, live, flushFeed };
}
beforeAll(() => warmMutationGraph(), 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    dispatch.gate = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
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

type Booted = Awaited<ReturnType<typeof boot>>;
const remote = (b: Booted, ops: ChatOp[]) =>
    b.fake.chatBatch([{ characterId: "c", chatId: "k", baseRevision: b.fake.chat("c", "k")!.revision, ops }]);
const reads = (b: Booted) =>
    b.fake.requests.filter((request) => request.path === "/api/resources/read").map((request) => request.body);
const mirror = (b: Booted) => b.chat.findChat(refK)!;
const latest = (b: Booted) => {
    const event = b.fake.feedEvents.at(-1)!;
    if (event.type !== "change") throw new Error("expected a committed change");
    const notice = event.changes.chats[0];
    expect(notice.patch).toBeDefined();
    return { ...notice.patch!, characterId: "c", id: "k", revision: notice.revision! };
};
const quiet = (b: Booted) => {
    expect(b.chat.hasUnsavedChatWork()).toBe(false);
    expect(alerts.normal).not.toHaveBeenCalled();
    expect(alerts.error).not.toHaveBeenCalled();
};

/** The oversized field is only one byte over the cap; both row encodings must carry it. */
function rerollRows() {
    const candidates = [
        { id: "previous", data: "", scriptstateAfter: { $x: "1" } },
        { id: "other", data: "Other", scriptstateAfter: { $x: "2" } },
    ];
    const text = "x".repeat(MAX_FEED_PATCH_BYTES + 1 - new TextEncoder().encode(JSON.stringify(candidates)).length);
    candidates[0].data = text;
    const original: Message = {
        role: "char",
        chatId: "c",
        data: text,
        candidates,
        selected: 0,
        candidatesRevision: 1,
        scriptstateCheckpoint: { before: { $x: "0" }, after: { $x: "1" } },
    };
    const begun: Message = {
        ...original,
        data: "",
        candidates: [...candidates, { id: "attempt", data: "" }],
        selected: 2,
        candidatesRevision: 2,
        scriptstateCheckpoint: { before: { $x: "0" } },
    };
    const begin: ChatOp[] = [
        {
            op: "patchMessage",
            id: "c",
            set: {
                data: "",
                candidates: begun.candidates,
                selected: 2,
                scriptstateCheckpoint: begun.scriptstateCheckpoint,
            },
            unset: [],
        },
        { op: "setTranslation", id: "c", translation: null },
        { op: "meta", merge: { scriptstate: { $x: "0" } }, mergeUnset: { scriptstate: [] } },
        { op: "begin", id: "c", generationId: "g" },
    ];
    const restored = { ...original, candidatesRevision: 3 };
    const rollback: ChatOp[] = [
        { op: "setMessage", message: original, generation: { id: "g", seq: 1, final: true } },
        { op: "setTranslation", id: "c", translation: null },
    ];
    const selected: Message = {
        ...original,
        data: "Other",
        selected: 1,
        candidatesRevision: 2,
        scriptstateCheckpoint: { before: { $x: "0" }, after: { $x: "2" } },
    };
    const select: ChatOp[] = [
        { op: "selectCandidate", messageId: "c", candidateId: "other", expect: { candidatesRevision: 1 } },
    ];
    return { original, begun, restored, selected, begin, rollback, select };
}

describe("feed patches through the tab save adapter", () => {
    it("applies a filtered patch after an appended id is removed with base rows without rereading the chat", async () => {
        const b = await boot();
        const baseRevision = b.chat.heldChatRevision(refK);
        remote(b, [
            { op: "append", anchor: { start: true }, messages: [m("temporary", "TEMP")] },
            { op: "setText", id: "c", text: "C!" },
            { op: "remove", ids: ["b", "temporary", "a"] },
        ]);

        const patch = latest(b);
        expect(patch.baseRevision).toBe(baseRevision);
        expect(patch.count).toBe(1);
        expect(mirror(b).message).toEqual([m("c", "C!")]);
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        await b.sync.flushResources();
        await vi.advanceTimersByTimeAsync(1500);
        expect(reads(b)).toEqual([]);
        quiet(b);
    });

    it.each(["begin", "write-back", "switch"] as const)(
        "reads an oversized reroll %s carrier and restored variables by id without a whole-chat read",
        async (step) => {
            const rows = rerollRows();
            const original =
                step === "switch"
                    ? {
                          ...rows.original,
                          candidates: [
                              { ...rows.original.candidates![0], data: "Before manual edit" },
                              rows.original.candidates![1],
                          ],
                      }
                    : rows.original;
            const b = await boot({
                messages: [m("a", "A"), m("b", "B"), original],
                meta: { scriptstate: { $x: "1" } },
            });
            b.fake.lock!.addToken("job");
            const attempt = { characterId: "c", chatId: "k", messageId: "c", generationId: "g" };
            const write = (ops: ChatOp[], action?: "begin" | "rollback") => {
                const options = { jobToken: "job", ...(action ? { rerollAttempt: { ...attempt, action } } : {}) };
                b.fake.store.applyChanges(
                    { chats: [{ characterId: "c", chatId: "k", baseRevision: b.fake.chat("c", "k")!.revision, ops }] },
                    options,
                );
            };
            if (step !== "switch") b.fake.lock!.acquire(attempt, { jobId: "J", generationId: "g", token: "job" });
            if (step === "write-back") {
                write(rows.begin, "begin");
                expect(await b.sync.refreshStaleChat(refK)).toBe(true);
                b.fake.requests.length = 0;
            }
            const before = JSON.parse(JSON.stringify(mirror(b)));
            const baseRevision = b.chat.heldChatRevision(refK);
            const expected = step === "begin" ? rows.begun : step === "write-back" ? rows.restored : rows.selected;
            const scriptstate = { $x: step === "begin" ? "0" : step === "write-back" ? "1" : "2" };
            write(
                step === "begin" ? rows.begin : step === "write-back" ? rows.rollback : rows.select,
                step === "switch" ? undefined : step === "begin" ? "begin" : "rollback",
            );
            const event = b.fake.feedEvents.at(-1)!;
            if (event.type !== "change") throw new Error("expected a committed change");
            const revision = b.fake.chat("c", "k")!.revision;
            expect(event.changes.chats[0]).toEqual({
                characterId: "c",
                id: "k",
                revision,
                summaryBase: baseRevision,
                rows: { baseRevision, changed: ["c"], removed: [], count: 3, meta: ["scriptstate"] },
            });
            expect(mirror(b)).toEqual(before);
            expect(b.chat.heldChatRevision(refK)).toBe(baseRevision);
            expect(await b.sync.refreshStaleChat(refK)).toBe(true);
            expect(reads(b)).toEqual([
                {
                    refs: [],
                    chats: [],
                    continue: true,
                    chatRows: [{ characterId: "c", id: "k", revision, messageIds: ["c"], meta: ["scriptstate"] }],
                },
            ]);
            expect(mirror(b)).toEqual({ ...before, scriptstate, message: [m("a", "A"), m("b", "B"), expected] });
            expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
            expect(b.chat.heldChatRevision(refK)).toBe(revision);
            await b.sync.flushResources();
            expect(b.fake.batchCount()).toBe(0);
            quiet(b);
        },
    );

    it("diffs candidate checkpoint cleanup and a later edit from the row before the append group", async () => {
        const data = "x".repeat(SMALL_FEED_PATCH_BYTES);
        const candidates = [
            { id: "old", data: "Old", scriptstateAfter: { $x: "1" } },
            { id: "current", data, scriptstateAfter: { $x: "2" } },
        ];
        const carrier: Message = {
            ...m("b", data, "char"),
            candidates,
            selected: 1,
            candidatesRevision: 1,
            scriptstateCheckpoint: { before: { $x: "0" }, after: { $x: "2" } },
        };
        const b = await boot({ messages: [m("a", "Question"), carrier] });
        const baseRevision = b.chat.heldChatRevision(refK);
        remote(b, [
            { op: "append", anchor: { end: true }, messages: [m("next", "Next question")] },
            { op: "setText", id: "b", text: data + "!" },
        ]);
        const cleaned = [
            { id: "old", data: "Old" },
            { id: "current", data },
        ];
        const event = b.fake.feedEvents.at(-1)!;
        if (event.type !== "change") throw new Error("expected a committed change");
        expect(event.changes.chats[0].rowDelta).toEqual({
            baseRevision,
            count: 3,
            messages: [{ after: "b", message: m("next", "Next question") }],
            rowDiffs: [
                {
                    id: "b",
                    text: { keep: data.length, text: "!" },
                    fields: { set: { candidates: cleaned, candidatesRevision: 2 }, unset: ["scriptstateCheckpoint"] },
                },
            ],
        });
        expect(mirror(b).message).toEqual([
            m("a", "Question"),
            { ...m("b", data + "!", "char"), candidates: cleaned, selected: 1, candidatesRevision: 2 },
            m("next", "Next question"),
        ]);
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(reads(b)).toEqual([]);
        quiet(b);
    });

    it("reads an over-cap carrier once by id and applies inserted and removed rows", async () => {
        const b = await boot();
        const before = JSON.parse(JSON.stringify(mirror(b)));
        const baseRevision = b.chat.heldChatRevision(refK);
        const carrier = {
            ...m("b", "B", "char"),
            candidates: [
                { id: "previous", data: "한".repeat(24 * 1024) },
                { id: "current", data: "B" },
            ],
            candidatesRevision: 1,
        };
        remote(b, [
            { op: "setMessage", message: carrier },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "I")] },
            { op: "remove", ids: ["a", "c"] },
        ]);
        const revision = b.fake.chat("c", "k")!.revision;
        expect(b.chat.heldChatRevision(refK)).toBe(baseRevision);
        expect(mirror(b)).toEqual(before);
        expect(await b.sync.refreshStaleChat(refK)).toBe(true);
        expect(reads(b)).toEqual([
            {
                refs: [],
                chats: [],
                continue: true,
                chatRows: [{ characterId: "c", id: "k", revision, messageIds: ["b", "inserted"], meta: [] }],
            },
        ]);
        expect(mirror(b)).toEqual({ ...before, message: [carrier, m("inserted", "I")] });
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        expect(b.chat.messagePositionOf(refK, "b")).toBe(0);
        expect(b.chat.messagePositionOf(refK, "inserted")).toBe(1);
        await b.sync.flushResources();
        await vi.advanceTimersByTimeAsync(1500);
        expect(reads(b)).toHaveLength(1);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it("applies whole scriptstate and absent-field removal from a reroll manifest without a whole read", async () => {
        const b = await boot({ meta: { scriptstate: { keep: "same", old: "remove" }, folderId: "gone" } });
        const before = JSON.parse(JSON.stringify(mirror(b)));
        const carrier = {
            ...m("b", "B", "char"),
            candidates: [
                { id: "previous", data: "x".repeat(MAX_FEED_PATCH_BYTES + 1) },
                { id: "current", data: "B" },
            ],
            candidatesRevision: 1,
        };
        remote(b, [
            { op: "setMessage", message: carrier },
            { op: "begin", id: "b", generationId: "reroll" },
            {
                op: "meta",
                merge: { scriptstate: { active: "reroll" } },
                mergeUnset: { scriptstate: ["old"] },
                unset: ["folderId"],
            },
        ]);
        const revision = b.fake.chat("c", "k")!.revision;
        expect(await b.sync.refreshStaleChat(refK)).toBe(true);
        expect(reads(b)).toHaveLength(1);
        expect(reads(b)[0].chats).toEqual([]);
        expect(reads(b)[0].chatRows).toEqual([
            {
                characterId: "c",
                id: "k",
                revision,
                messageIds: ["b"],
                meta: expect.arrayContaining(["folderId", "scriptstate"]),
            },
        ]);
        expect(reads(b)[0].chatRows[0].meta).toHaveLength(2);
        const expected = {
            ...before,
            scriptstate: { keep: "same", active: "reroll" },
            message: [m("a", "A", "char"), carrier, m("c", "C")],
        };
        delete expected.folderId;
        expect(mirror(b)).toEqual(expected);
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        await b.sync.flushResources();
        await vi.advanceTimersByTimeAsync(1500);
        expect(reads(b)).toHaveLength(1);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it("applies a metadata-only over-cap manifest without a whole read", async () => {
        const b = await boot();
        const before = JSON.parse(JSON.stringify(mirror(b)));
        const baseRevision = b.chat.heldChatRevision(refK);
        const note = "n".repeat(MAX_FEED_PATCH_BYTES + 1);
        remote(b, [{ op: "meta", set: { note } }]);
        const event = b.fake.feedEvents.at(-1)!;
        if (event.type !== "change") throw new Error("expected a committed change");
        const revision = b.fake.chat("c", "k")!.revision;
        expect(event.changes.chats[0]).toEqual({
            characterId: "c",
            id: "k",
            revision,
            summaryBase: baseRevision,
            rows: { baseRevision, changed: [], removed: [], count: 3, meta: ["note"] },
        });
        expect(await b.sync.refreshStaleChat(refK)).toBe(true);
        expect(reads(b)).toEqual([
            {
                refs: [],
                chats: [],
                continue: true,
                chatRows: [{ characterId: "c", id: "k", revision, messageIds: [], meta: ["note"] }],
            },
        ]);
        expect(mirror(b)).toEqual({ ...before, note });
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        await b.sync.flushResources();
        await vi.advanceTimersByTimeAsync(1500);
        expect(reads(b)).toHaveLength(1);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it.each(["at a newer revision", "deleted"] as const)(
        "reads a moved chat whole once in the same refresh when it is %s",
        async (state) => {
            const b = await boot();
            const before = JSON.parse(JSON.stringify(mirror(b)));
            const carrier = {
                ...m("b", "B", "char"),
                candidates: [
                    { id: "previous", data: "x".repeat(MAX_FEED_PATCH_BYTES + 1) },
                    { id: "current", data: "B" },
                ],
                candidatesRevision: 1,
            };
            remote(b, [{ op: "setMessage", message: carrier }]);
            const requestedRevision = b.fake.chat("c", "k")!.revision;
            b.live.paused = true;
            remote(b, state === "deleted" ? [{ op: "delete" }] : [{ op: "setText", id: "c", text: "newer" }]);
            b.live.queue.length = 0;
            const currentRevision = state === "deleted" ? null : b.fake.chat("c", "k")!.revision;
            expect(await b.sync.refreshStaleChat(refK)).toBe(true);
            expect(reads(b)).toEqual([
                {
                    refs: [],
                    chats: [],
                    continue: true,
                    chatRows: [{ characterId: "c", id: "k", revision: requestedRevision, messageIds: ["b"], meta: [] }],
                },
                { refs: [], chats: [{ characterId: "c", id: "k" }], continue: true },
            ]);
            if (state === "deleted") expect(b.chat.findChat(refK)).toBeUndefined();
            else expect(mirror(b)).toEqual({ ...before, message: [m("a", "A", "char"), carrier, m("c", "newer")] });
            expect(b.chat.heldChatRevision(refK) ?? null).toBe(currentRevision);
            await b.sync.flushResources();
            await vi.advanceTimersByTimeAsync(1500);
            expect(reads(b).flatMap((read) => read.chatRows ?? [])).toHaveLength(1);
            expect(reads(b).flatMap((read) => read.chats ?? [])).toEqual([{ characterId: "c", id: "k" }]);
            expect(b.fake.batchCount()).toBe(0);
            quiet(b);
        },
    );

    it("applies successive row diffs without reads or rebuilding positions, then applies mixed whole rows and metadata", async () => {
        const prefix = "x".repeat(100 * 1024) + "😀";
        const b = await boot({ messages: [m("a", "A"), { ...m("b", prefix, "char"), saying: "gone" }, m("c", "C")] });
        expect(b.chat.messagePositionOf(refK, "b")).toBe(1);
        const positions = b.chat.messagePositionStats();
        const generationInfo = { model: "remote", outputTokens: 34 };
        const steps: { ops: ChatOp[]; row: Message }[] = [
            {
                ops: [{ op: "setText", id: "b", text: prefix + " appended" }],
                row: { ...m("b", prefix + " appended", "char"), saying: "gone" },
            },
            {
                ops: [{ op: "patchMessage", id: "b", set: { generationInfo } }],
                row: { ...m("b", prefix + " appended", "char"), saying: "gone", generationInfo },
            },
            {
                ops: [{ op: "patchMessage", id: "b", unset: ["saying"] }],
                row: { ...m("b", prefix + " appended", "char"), generationInfo },
            },
        ];
        for (const { ops, row } of steps) {
            const baseRevision = b.chat.heldChatRevision(refK);
            remote(b, ops);
            const event = b.fake.feedEvents.at(-1)!;
            if (event.type !== "change") throw new Error("expected a committed change");
            const entry = event.changes.chats[0];
            expect(entry.rowDelta?.baseRevision).toBe(baseRevision);
            expect(entry.rowDelta?.rowDiffs).toHaveLength(1);
            expect(entry.rowDelta).not.toHaveProperty("messages");
            expect(entry).not.toHaveProperty("delta");
            expect(entry).not.toHaveProperty("patch");
            expect(mirror(b).message[1]).toEqual(row);
            expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
            expect(b.chat.heldChatRevision(refK)).toBe(entry.revision);
            expect(b.chat.isChatBehind(refK)).toBe(false);
            expect(b.chat.messagePositionOf(refK, "b")).toBe(1);
            expect(b.chat.messagePositionStats().builds).toBe(positions.builds);
            await b.sync.flushResources();
            await vi.advanceTimersByTimeAsync(1500);
            expect(reads(b)).toEqual([]);
            expect(b.fake.batchCount()).toBe(0);
            quiet(b);
        }
        remote(b, [
            { op: "remove", ids: ["a"] },
            { op: "setText", id: "b", text: prefix + " final" },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "I")] },
            { op: "meta", set: { note: "remote note" } },
        ]);
        expect(mirror(b).message).toEqual([
            { ...m("b", prefix + " final", "char"), generationInfo },
            m("inserted", "I"),
            m("c", "C"),
        ]);
        expect(mirror(b).note).toBe("remote note");
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        await b.sync.flushResources();
        await vi.advanceTimersByTimeAsync(1500);
        expect(reads(b)).toEqual([]);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it.each(["another revision", "short held text", "missing held row", "generating", "stale"] as const)(
        "leaves a row delta unapplied for %s and reads the whole chat once idle",
        async (state) => {
            const data = "x".repeat(100 * 1024);
            const b = await boot({ messages: [m("a", "A"), { ...m("b", data, "char"), saying: "gone" }, m("c", "C")] });
            const baseRevision = b.chat.heldChatRevision(refK)!;
            b.live.paused = true;
            if (state === "another revision") {
                remote(b, [{ op: "meta", set: { note: "missed" } }]);
                b.live.queue.length = 0;
            }
            if (state === "short held text" || state === "missing held row") {
                const held = b.fake.chat("c", "k")!;
                const messages = [
                    m("a", "A"),
                    {
                        ...m(
                            state === "missing held row" ? "other" : "b",
                            state === "short held text" ? "short" : data,
                            "char",
                        ),
                        saying: "gone",
                    },
                    m("c", "C"),
                ];
                b.chat.acceptRemoteChat({ ...held, data: { ...held.data, message: messages } } as Parameters<
                    ChatModule["acceptRemoteChat"]
                >[0]);
            }
            if (state === "generating") {
                expect(
                    b.chat.applyServerGeneration(refK, {
                        jobId: "J",
                        messageId: "c",
                        generationId: "g",
                        seq: 1,
                        text: "streaming",
                    }),
                ).toBe(true);
            }
            if (state === "stale") {
                const future = baseRevision.replace(/:\d+$/, ":999");
                expect(
                    b.sync.applyPatchHydration({
                        characterId: "c",
                        id: "k",
                        baseRevision: future,
                        revision: future.replace(/999$/, "1000"),
                        count: 3,
                    }),
                ).toBe("mismatch");
                expect(b.chat.isChatStale(refK)).toBe(true);
            }
            const before = JSON.parse(JSON.stringify(mirror(b)));
            remote(b, [
                { op: "setText", id: "a", text: "A!" },
                { op: "setText", id: "b", text: data + " appended" },
                { op: "patchMessage", id: "b", set: { generationInfo: { model: "remote" } }, unset: ["saying"] },
                { op: "meta", set: { note: "remote note" } },
            ]);
            const event = b.live.queue[0];
            if (event.type !== "change") throw new Error("expected a committed change");
            expect(event.changes.chats[0].rowDelta?.rowDiffs.map(({ id }) => id)).toEqual(["a", "b"]);
            b.flushFeed();
            expect(reads(b)).toEqual([]);
            expect(mirror(b)).toEqual(before);
            expect(b.chat.heldChatRevision(refK)).toBe(baseRevision);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            if (state === "generating") {
                await vi.advanceTimersByTimeAsync(1500);
                expect(reads(b)).toEqual([]);
                expect(mirror(b)).toEqual(before);
                b.chat.endServerJob("J");
            }
            await b.sync.flushResources();
            await vi.advanceTimersByTimeAsync(1500);
            expect(reads(b)).toHaveLength(1);
            expect(reads(b)[0]).toMatchObject({ chats: [{ characterId: "c", id: "k" }] });
            expect(reads(b)[0].chatSummaryCollections ?? []).toEqual([]);
            expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
            expect(mirror(b).message[1]).toEqual({
                ...m("b", data + " appended", "char"),
                generationInfo: { model: "remote" },
            });
            expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
            expect(b.chat.isChatBehind(refK)).toBe(false);
            await vi.advanceTimersByTimeAsync(1500);
            expect(reads(b)).toHaveLength(1);
            expect(b.fake.batchCount()).toBe(0);
            quiet(b);
        },
    );

    it("applies metadata deltas as remote values equal to a whole read without queuing a write", async () => {
        const memory = "m".repeat(100 * 1024);
        const b = await boot({
            meta: {
                supaMemoryData: memory,
                folderId: "remove me",
                scriptstate: { keep: "same", change: "old", gone: "remove" },
            },
        });
        const expected: Record<string, unknown> = {
            id: "k",
            name: "k",
            note: "remote note",
            localLore: [],
            fmIndex: -1,
            message: [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")],
            supaMemoryData: memory,
            autoTranslate: true,
            scriptstate: { keep: "same", change: "new", added: "value" },
        };
        const cases: { ops: ChatOp[]; scriptstate?: unknown }[] = [
            {
                ops: [
                    {
                        op: "meta",
                        set: { note: "remote note", autoTranslate: true },
                        unset: ["folderId"],
                        merge: { scriptstate: { change: "new", added: "value" } },
                        mergeUnset: { scriptstate: ["gone"] },
                    },
                ],
                scriptstate: expected.scriptstate,
            },
            { ops: [{ op: "meta", set: { scriptstate: "legacy string" } }], scriptstate: "legacy string" },
            { ops: [{ op: "meta", set: { scriptstate: { restored: "map" } } }], scriptstate: { restored: "map" } },
            { ops: [{ op: "meta", unset: ["scriptstate"] }] },
            { ops: [{ op: "meta", merge: { scriptstate: { appeared: "map" } } }], scriptstate: { appeared: "map" } },
        ];
        for (const { ops, scriptstate } of cases) {
            remote(b, ops);
            const event = b.fake.feedEvents.at(-1)!;
            if (event.type !== "change") throw new Error("expected a committed change");
            expect(event.changes.chats[0]).toHaveProperty("delta.metaFields");
            expect(event.changes.chats[0]).not.toHaveProperty("patch");
            if (scriptstate === undefined) delete expected.scriptstate;
            else expected.scriptstate = scriptstate;
            expect(JSON.parse(JSON.stringify(mirror(b)))).toEqual(expected);
            expect(JSON.parse(JSON.stringify(mirror(b)))).toEqual(b.fake.chat("c", "k")!.data);
            expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
            expect(b.chat.isChatBehind(refK)).toBe(false);
            expect(b.chat.hasUnsavedChatWork()).toBe(false);
            await b.sync.flushResources();
            await vi.advanceTimersByTimeAsync(1500);
            expect(reads(b)).toEqual([]);
            expect(b.fake.batchCount()).toBe(0);
            expect(b.fake.requests).toEqual([]);
            quiet(b);
        }
    });

    it("reads a loaded chat for a mismatched delta or a plain reference without echoing metadata", async () => {
        for (const notice of ["mismatched delta", "plain reference"]) {
            const b = await boot({ meta: { supaMemoryData: "m".repeat(100 * 1024) } });
            const base = b.chat.heldChatRevision(refK);
            b.live.paused = true;
            remote(b, [{ op: "meta", set: { note: "missed note" } }]);
            b.live.queue.length = 0;
            remote(b, [{ op: "meta", set: { autoTranslate: true } }]);
            const event = b.live.queue[0];
            if (event.type !== "change") throw new Error("expected a committed change");
            const entry = event.changes.chats[0];
            expect(entry.delta?.baseRevision).not.toBe(base);
            expect(entry.delta).toBeDefined();
            const { characterId, id, revision } = entry;
            b.sync.noteRemoteChanges({
                resources: [],
                chats: [notice === "plain reference" ? { characterId, id, revision } : entry],
                chatOrders: [],
            });
            expect(mirror(b).autoTranslate).toBeUndefined();
            expect(mirror(b).note).toBe("");
            expect(b.chat.heldChatRevision(refK)).toBe(base);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            await vi.advanceTimersByTimeAsync(1500);
            await b.sync.flushResources();
            expect(reads(b)).toHaveLength(1);
            expect(reads(b)[0]).toMatchObject({ chats: [{ characterId: "c", id: "k" }] });
            expect(reads(b)[0].chatSummaryCollections ?? []).toEqual([]);
            expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
            expect(mirror(b)).toMatchObject({ note: "missed note", autoTranslate: true });
            expect(b.chat.heldChatRevision(refK)).toBe(revision);
            expect(b.fake.batchCount()).toBe(0);
            quiet(b);
            b.fake.close();
        }
    });

    it("applies a loaded idle patch immediately without a notice, read, outgoing work, or discard", async () => {
        const b = await boot();
        const scope = b.sync.beginMutationScope();
        remote(b, [
            { op: "remove", ids: ["a"] },
            { op: "setText", id: "b", text: "checkpoint😀" },
            { op: "append", anchor: { after: "b" }, messages: [m("inserted", "I")] },
            { op: "meta", set: { note: "remote note" } },
        ]);
        expect(mirror(b).message.map((row) => [row.chatId, row.data])).toEqual([
            ["b", "checkpoint😀"],
            ["inserted", "I"],
            ["c", "C"],
        ]);
        expect(mirror(b).note).toBe("remote note");
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [], refused: [] });
        expect(b.fake.requests).toEqual([]);
        quiet(b);
    });

    it.each(["another revision", "stale", "local work", "generating"])(
        "falls back to the existing notice/read path for %s",
        async (state) => {
            const b = await boot();
            const scope = b.sync.beginMutationScope();
            const base = b.fake.chat("c", "k")!.revision;
            if (state === "another revision") {
                b.live.paused = true;
                remote(b, [{ op: "meta", set: { note: "unseen prior change" } }]);
                b.live.queue.length = 0;
                b.live.paused = false;
            }
            if (state === "stale") {
                const future = base.replace(/:\d+$/, ":999");
                expect(
                    b.sync.applyPatchHydration({
                        characterId: "c",
                        id: "k",
                        baseRevision: future,
                        revision: future.replace(/999$/, "1000"),
                        count: 3,
                    }),
                ).toBe("mismatch");
                expect(b.chat.isChatStale(refK)).toBe(true);
            }
            if (state === "local work") b.chat.setChatMeta(refK, { note: "local note" });
            if (state === "generating")
                b.chat.applyServerGeneration(refK, {
                    jobId: "J",
                    messageId: "b",
                    generationId: "g",
                    seq: 1,
                    text: "raw streaming",
                });
            remote(b, [{ op: "setText", id: "b", text: "stored checkpoint" }]);
            latest(b);
            expect(b.chat.heldChatRevision(refK)).toBe(base);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            expect(reads(b)).toEqual([]);
            expect(mirror(b).message[1].data).toBe(state === "generating" ? "raw streaming" : "B");
            if (state === "generating") {
                await vi.advanceTimersByTimeAsync(600);
                expect(reads(b)).toEqual([]);
                b.chat.endServerJob("J");
            }
            expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [], refused: [] });
            await vi.advanceTimersByTimeAsync(1200);
            expect(reads(b)).toHaveLength(1);
            expect(reads(b)[0]).toMatchObject({ chats: [{ characterId: "c", id: "k" }] });
            expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
            expect(mirror(b).message[1].data).toBe("stored checkpoint");
            if (state === "local work") expect(mirror(b).note).toBe("local note");
            if (state === "another revision") expect(mirror(b).note).toBe("unseen prior change");
            expect(b.chat.isChatBehind(refK)).toBe(false);
            expect(b.fake.batchCount()).toBe(state === "local work" ? 1 : 0);
            quiet(b);
        },
    );

    it("never applies a feed patch to a chat held only as its summary: the summary base advances its revision with no read", async () => {
        const b = await boot({ summaries: true });
        const scope = b.sync.beginMutationScope();
        const base = b.fake.chat("c", "k")!.revision;
        expect(b.chat.heldChatRevision(refK)).toBe(base);
        remote(b, [{ op: "setText", id: "b", text: "stored checkpoint" }]);
        const { revision } = latest(b);
        // A text write leaves the summary as it was at the held revision: the entry's `summaryBase`.
        const event = b.fake.feedEvents.at(-1)!;
        if (event.type !== "change") throw new Error("expected a committed change");
        expect(event.changes.chats[0].summaryBase).toBe(base);
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        expect(reads(b)).toEqual([]);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [], refused: [] });
        await vi.advanceTimersByTimeAsync(1200);
        // Neither the character's summary list nor the chat whole is read, and nothing is written.
        expect(reads(b)).toEqual([]);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it("lets the owner's later job patch fit both a locked feed notice and an already applied unlocked feed patch", async () => {
        const b = await boot();
        const scope = b.sync.beginMutationScope();
        b.chat.applyServerGeneration(refK, { jobId: "J", messageId: "b", generationId: "g", seq: 1, text: "raw" });
        remote(b, [{ op: "setText", id: "b", text: "stored checkpoint" }]);
        const locked = latest(b);
        expect(mirror(b).message[1].data).toBe("raw");
        expect(b.chat.heldChatRevision(refK)).toBe(locked.baseRevision);
        expect(b.chat.isChatBehind(refK)).toBe(true);
        expect(b.sync.applyPatchHydration(locked, { jobId: "J", streaming: [] })).toBe("applied");
        expect(mirror(b).message[1].data).toBe("stored checkpoint");
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        remote(b, [{ op: "setText", id: "b", text: "unlocked update" }]);
        const unlocked = latest(b);
        expect(mirror(b).message[1].data).toBe("unlocked update");
        expect(b.chat.heldChatRevision(refK)).toBe(unlocked.revision);
        expect(b.sync.applyPatchHydration(unlocked, { jobId: "J", streaming: [] })).toBe("applied");
        expect(mirror(b)).toEqual(b.fake.chat("c", "k")!.data);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [], refused: [] });
        expect(b.fake.requests).toEqual([]);
        quiet(b);
    });
    it.each(["in-flight", "quarantined", "blocked", "deferred"])(
        "retains the ordinary notice while a chat is %s",
        async (state) => {
            const b = await boot();
            b.chat.setChatMeta(refK, { note: "local work" });
            const work = b.chat.takeChatWork(new Set());
            expect(work.groups).toHaveLength(1);
            const group = work.groups[0];
            if (state === "quarantined") b.chat.quarantineChat(group);
            if (state === "blocked") b.chat.recoverChatConflicts(work, new Set(), new Set(), [], new Set([group.key]));
            if (state === "deferred") {
                b.chat.applyServerGeneration(refK, {
                    jobId: "J",
                    messageId: "b",
                    generationId: "g",
                    seq: 1,
                    text: "raw",
                });
                b.chat.recoverChatConflicts(work, new Set([group.key]), new Set(), [b.fake.chat("c", "k")!]);
                // Remove the generation lock so it is the deferral that prevents feed admission.
                b.chat.endServerJob("J");
            }
            const before = JSON.stringify(mirror(b));
            const held = b.chat.heldChatRevision(refK);
            const scope = b.sync.beginMutationScope();
            remote(b, [{ op: "setText", id: "b", text: "remote checkpoint" }]);
            latest(b);
            expect(JSON.stringify(mirror(b))).toBe(before);
            expect(b.chat.heldChatRevision(refK)).toBe(held);
            expect(b.chat.isChatBehind(refK)).toBe(true);
            expect(b.sync.beginMutationScope()).toEqual(scope);
            expect(b.fake.requests).toEqual([]);
            expect(alerts.normal).not.toHaveBeenCalled();
        },
    );
});

// The change feed carries the generation locks, so a tab that does not follow the job (an observer,
// or an owner whose follow was lost) shows the generating reply locked from the job's first write's
// frame to its final write's (or its end's) frame, with no job socket. A feed lock is a lock only:
// the observer keeps taking the checkpoint patches. The edit race before the lock frame still goes
// through the refused-edit discard (a refused edit of the generating reply is dropped, not retried
// over the final text).
describe("the feed's generation locks", () => {
    const B = { characterId: "c", chatId: "k", messageId: "b" };
    const lockOf = (messageId: string, generationId: string, seq = 0) => ({ messageId, generationId, seq });
    const jobLock = (b: Booted, generationId = "g") => {
        b.fake.lock!.addToken("T");
        b.fake.lock!.acquire(B, { jobId: "J", generationId, token: "T" });
    };
    /**
     * The job's own write (its token) with the locks its committed hook announces, as `writeAsJob`
     * publishes them; `release`: the final write releases `b` before the list is built.
     */
    const jobWrite = (
        b: Booted,
        ops: ChatOp[],
        streaming: ReturnType<typeof lockOf>[],
        options: { release?: string } = {},
    ) =>
        b.fake.store.applyChanges(
            { chats: [{ characterId: "c", chatId: "k", baseRevision: b.fake.chat("c", "k")!.revision, ops }] },
            {
                epoch: b.fake.store.epoch(),
                jobToken: "T",
                committed: () => {
                    if (options.release) b.fake.lock!.release(B, "T", options.release);
                    return [{ characterId: "c", id: "k", streaming }];
                },
            },
        );
    /** The job's end: its locks released and published again without a write (`finalize`). */
    const jobEnd = (b: Booted) => {
        b.fake.lock!.endJob("T");
        b.fake.store.publishStreaming([{ characterId: "c", id: "k", streaming: [] }]);
    };
    const locked = (b: Booted, id = "b") => b.chat.isMessageLocked(refK, id);
    const setText = (op: "setText", id: string, text: string): ChatOp => ({ op, id, text });

    it.each([
        { behavior: "keeps", streaming: [lockOf("b", "g", 1)], expectedLock: true },
        { behavior: "releases", streaming: [], expectedLock: false },
    ])("$behavior the reply lock according to a newer whole read's snapshot", async ({ streaming, expectedLock }) => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "waiting for provider")], [lockOf("b", "g", 1)]);
        const announcedRevision = b.chat.heldChatRevision(refK);
        expect(locked(b)).toBe(true);

        // An unrelated write advances the chat; its frame never reaches this observer.
        b.live.paused = true;
        remote(b, [{ op: "meta", set: { note: "another writer" } }]);
        if (!expectedLock) jobEnd(b);
        b.fake.streamingForChat = (characterId, id) => (characterId === "c" && id === "k" ? streaming : undefined);
        const readRevision = b.fake.chat("c", "k")!.revision;
        expect(readRevision).not.toBe(announcedRevision);
        expect(locked(b)).toBe(true);

        b.sync.reconcileRemote(b.fake.store.listRevisions());
        await vi.advanceTimersByTimeAsync(1000);
        expect(reads(b)).toEqual([expect.objectContaining({ chats: [{ characterId: "c", id: "k" }] })]);
        expect(mirror(b).note).toBe("another writer");
        expect(b.chat.heldChatRevision(refK)).toBe(readRevision);
        expect(locked(b)).toBe(expectedLock);
        expect(b.chat.isChatGenerating(refK)).toBe(expectedLock);
        quiet(b);
    });

    it("recovers a lost follow by unlocking the reply from an empty whole-read snapshot at the same revision", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "last checkpoint")], [lockOf("b", "g", 1)]);
        const revision = b.chat.heldChatRevision(refK);
        expect(
            b.chat.applyServerGeneration(refK, {
                jobId: "J",
                messageId: "b",
                generationId: "g",
                seq: 1,
                text: "last checkpoint",
            }),
        ).toBe(true);
        b.chat.endServerJob("J");
        b.live.paused = true;
        jobEnd(b); // The job ends without writing, and its release frame is missed too.
        b.fake.streamingForChat = () => [];
        expect(locked(b)).toBe(true);
        expect(b.chat.isChatGenerating(refK)).toBe(true);

        // `recoverJobChat` uses this stale mark and the save loop's immediate idle refresh.
        expect(b.chat.markChatStale(refK)).toBe(true);
        expect(await b.sync.refreshStaleChat(refK)).toBe(true);
        expect(reads(b)).toEqual([expect.objectContaining({ chats: [{ characterId: "c", id: "k" }] })]);
        expect(b.chat.heldChatRevision(refK)).toBe(revision);
        expect(mirror(b).message[1].data).toBe("last checkpoint");
        expect(locked(b)).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        quiet(b);
    });

    it("does not reinstall a lock from a whole-read answer delayed past the job's end frame", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "waiting for provider")], [lockOf("b", "g", 1)]);
        b.live.paused = true;
        remote(b, [{ op: "meta", set: { note: "sampled while running" } }]);
        b.live.queue.length = 0;
        b.live.paused = false;
        b.fake.streamingForChat = () => [lockOf("b", "g", 1)];
        let onSampled!: () => void;
        let releaseAnswer!: () => void;
        const sampled = new Promise<void>((resolve) => {
            onSampled = resolve;
        });
        const answer = new Promise<void>((resolve) => {
            releaseAnswer = resolve;
        });
        const fetch = b.fake.fetch;
        vi.spyOn(b.fake, "fetch").mockImplementation(async (path, init) => {
            const response = await fetch(path, init);
            if (path === "/api/resources/read") {
                onSampled();
                await answer;
            }
            return response;
        });
        b.chat.markChatStale(refK);
        const refresh = b.sync.refreshStaleChat(refK);
        try {
            await sampled;
            expect(locked(b)).toBe(true);
            jobEnd(b); // No refs: a revision fence alone cannot reject the pending snapshot.
            expect(locked(b)).toBe(false);
        } finally {
            releaseAnswer();
            await refresh;
        }
        expect(mirror(b).note).toBe("sampled while running");
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(locked(b)).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        quiet(b);
    });

    it("releases a removed chat's feed locks when a collection read drops its held revision", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "last checkpoint")], [lockOf("b", "g", 1)]);
        b.live.paused = true;
        jobEnd(b);
        remote(b, [{ op: "delete" }]);
        expect(locked(b)).toBe(true);
        expect(b.chat.heldChatRevision(refK)).not.toBeNull();

        const read = await b.client.readRefs([], { chatSummaryCollections: ["c"] });
        expect(b.chat.applyRemoteCollection(read.chatSummaryCollections![0])).toBe(true);
        expect(b.chat.chatList("c").map((entry) => entry.id)).toEqual(["j"]);
        expect(b.chat.heldChatRevision(refK)).toBeNull();
        expect(locked(b)).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        quiet(b);
    });

    it.each(["feed", "this tab"])(
        "protects character membership during a %s job and defers recovery only for this tab's stream",
        async (owner) => {
            const b = await boot();
            const characters = await import("../characterStore.svelte");
            jobLock(b);
            jobWrite(b, [setText("setText", "b", "streamed")], [lockOf("b", "g", 1)]);
            if (owner === "this tab") {
                b.chat.applyServerGeneration(refK, {
                    jobId: "J",
                    messageId: "b",
                    generationId: "g",
                    seq: 1,
                    text: "streamed",
                });
            }
            expect(b.chat.isCharacterGenerating("c")).toBe(true);
            expect(b.chat.isCharacterGenerating("d")).toBe(false);
            expect(() => characters.removeCharacter("c")).toThrow(/generating/);
            expect(() => characters.replaceCharacterAt(0, { chaId: "replacement", name: "Replacement" })).toThrow(
                /generating/,
            );
            expect(characters.removeCharacters(["c"])).toEqual([]);
            expect(characters.characterList().map((character) => character.chaId)).toEqual(["c", "d"]);

            // The missed deletion makes the sibling edit conflict and forces a recovery list read.
            b.live.paused = true;
            b.fake.chatBatch([
                {
                    characterId: "c",
                    chatId: "j",
                    baseRevision: b.fake.chat("c", "j")!.revision,
                    ops: [{ op: "delete" }],
                },
            ]);
            b.chat.setChatMeta({ chaId: "c", chatId: "j" }, { note: "queued on the deleted sibling" });
            expect(await b.sync.flushResources()).toEqual({ discarded: ["chats/c/j"], refused: [] });
            const recoveryReads = () => reads(b).filter((body) => body.chatSummaryCollections?.includes("c"));
            // The recovery's list read runs in the background queue, not in the flush.
            await vi.advanceTimersByTimeAsync(1000);
            expect(recoveryReads()).toHaveLength(owner === "feed" ? 1 : 0);
            expect(b.chat.chatList("c").map((entry) => entry.id)).toEqual(owner === "feed" ? ["k"] : ["k", "j"]);
            expect(b.chat.isCharacterGenerating("c")).toBe(true);

            b.chat.endServerJob("J");
            // Ending this tab's follow does not release the independent feed lock.
            expect(b.chat.isCharacterGenerating("c")).toBe(true);
            expect(await b.sync.flushResources()).toEqual({ discarded: [], refused: [] });
            await vi.advanceTimersByTimeAsync(1000);
            expect(recoveryReads()).toHaveLength(1);
            expect(b.chat.chatList("c").map((entry) => entry.id)).toEqual(["k"]);
            b.live.paused = false;
            jobEnd(b);
            expect(b.chat.isCharacterGenerating("c")).toBe(false);
        },
    );

    it("locks the reply from the job's first write's frame, keeps taking its checkpoint patches, hands it to another generation, and releases it on the final write's frame", async () => {
        const b = await boot();
        const scope = b.sync.beginMutationScope();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        expect(locked(b)).toBe(true);
        expect(b.chat.isMessageLocked(refK, "a")).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(true);
        expect(b.chat.lockedChatKeys()).toEqual(new Set(["c\u0000k"]));
        // A feed lock also guards the character's membership (the save loop's character hydration
        // still goes on: it waits only for this tab's own streams).
        expect(b.chat.isCharacterGenerating("c")).toBe(true);
        expect(() => b.chat.setMessageText(refK, "b", "mine")).toThrow(/being generated/);
        expect(() => b.chat.removeMessages(refK, ["b"])).toThrow(/being generated/);
        // The checkpoint's feed patch applied at once: the observer sees progress, with no read.
        expect(mirror(b).message[1].data).toBe("one");
        expect(reads(b)).toEqual([]);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        jobWrite(b, [setText("setText", "b", "one two")], [lockOf("b", "g", 2)]);
        expect(mirror(b).message[1].data).toBe("one two");
        expect(locked(b)).toBe(true);
        // A handoff: the frame lists the message under the next generation; it stays locked.
        jobWrite(b, [setText("setText", "b", "one two three")], [lockOf("b", "g2", 0)]);
        expect(locked(b)).toBe(true);
        // The final write's frame carries the release.
        jobWrite(b, [setText("setText", "b", "FINAL")], [], { release: "g2" });
        expect(locked(b)).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        expect(b.chat.lockedChatKeys()).toEqual(new Set());
        expect(mirror(b).message[1].data).toBe("FINAL");
        jobEnd(b);
        expect(locked(b)).toBe(false);
        expect(reads(b)).toEqual([]);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
        // Unlocked: an edit goes out as usual.
        b.chat.setMessageText(refK, "b", "edited after");
        expect(await b.sync.flushResources({ scope })).toEqual({ discarded: [], refused: [] });
        expect(b.fake.texts("c", "k")).toEqual(["A", "edited after", "C"]);
    });

    it("an edit sent before the lock frame arrives goes through the refused-edit discard; the frame then refuses edits, the read keeps the lock, and the final reply wins", async () => {
        const b = await boot();
        b.live.paused = true;
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        // No lock here yet: the edit is accepted locally and refused by the server (409 `generating`).
        b.chat.setMessageText(refK, "b", "edited");
        await expect(b.sync.flushResources()).resolves.toEqual({ discarded: ["chats/c/k"], refused: [] });
        expect(b.fake.texts("c", "k")).toEqual(["A", "one", "C"]);
        expect(alerts.normal.mock.calls.map(([value]) => value).sort()).toEqual(["generating", "reloaded"]);
        expect(b.chat.hasUnsavedChatWork()).toBe(false);
        // The lock frame arrives (its patch does not fit the stale chat): the reply is locked now.
        b.live.paused = false;
        b.flushFeed();
        expect(locked(b)).toBe(true);
        expect(() => b.chat.setMessageText(refK, "b", "again")).toThrow(/being generated/);
        // The idle read that puts the server's reply back is at the frame's revision: the lock stays.
        await vi.advanceTimersByTimeAsync(2000);
        expect(mirror(b).message[1].data).toBe("one");
        expect(b.chat.isChatStale(refK)).toBe(false);
        expect(locked(b)).toBe(true);
        jobWrite(b, [setText("setText", "b", "FINAL")], [], { release: "g" });
        expect(locked(b)).toBe(false);
        expect(mirror(b).message[1].data).toBe("FINAL");
        jobEnd(b);
        await vi.advanceTimersByTimeAsync(6000);
        expect(b.fake.texts("c", "k")).toEqual(["A", "FINAL", "C"]);
        expect(b.fake.batchCount()).toBe(1);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("keeps the feed lock when this tab's follow of the job is lost, through the job's later frames, until the job's end frame", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        // The owner follows its job: its own lock joins the feed's.
        expect(
            b.chat.applyServerGeneration(refK, { jobId: "J", messageId: "b", generationId: "g", seq: 1, text: "one" }),
        ).toBe(true);
        expect(locked(b)).toBe(true);
        // The follow ends `lost` (`releaseGenerationJob` → `endServerJob`) while the server job goes on.
        b.chat.endServerJob("J");
        expect(locked(b)).toBe(true);
        expect(b.chat.isChatGenerating(refK)).toBe(true);
        expect(() => b.chat.setMessageText(refK, "b", "mine")).toThrow(/being generated/);
        // The next checkpoint's frame announces the same generation again: still locked, and the
        // whole read the lost follow caused (at that frame's revision) keeps it.
        jobWrite(b, [setText("setText", "b", "one two")], [lockOf("b", "g", 2)]);
        expect(locked(b)).toBe(true);
        await vi.advanceTimersByTimeAsync(2000);
        expect(mirror(b).message[1].data).toBe("one two");
        expect(locked(b)).toBe(true);
        // The job ends without a final write (an abort): its end frame, with no refs, releases.
        jobEnd(b);
        expect(locked(b)).toBe(false);
        expect(b.chat.isChatGenerating(refK)).toBe(false);
        expect(b.chat.hasUnsavedChatWork()).toBe(false);
    });

    it("the owner's job events of a generation the feed already released still apply: the two locks are independent", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        jobWrite(b, [setText("setText", "b", "FINAL")], [], { release: "g" });
        expect(locked(b)).toBe(false);
        // The job socket is behind the feed: its stream and terminal arrive after the feed's release.
        expect(
            b.chat.applyServerGeneration(refK, { jobId: "J", messageId: "b", generationId: "g", seq: 1, text: "one" }),
        ).toBe(true);
        expect(locked(b)).toBe(true);
        expect(mirror(b).message[1].data).toBe("one");
        b.chat.endServerJob("J");
        expect(locked(b)).toBe(false);
        // The reverse: the owner's end first, then a late lock frame and its release frame.
        jobLock(b, "g3");
        jobWrite(b, [setText("setText", "b", "three")], [lockOf("b", "g3", 1)]);
        expect(locked(b)).toBe(true);
        jobEnd(b);
        expect(locked(b)).toBe(false);
    });

    it("locks by id a chat held as its summary and a message the mirror does not hold yet; the chat loads locked at the frame's revision", async () => {
        const b = await boot({ summaries: true });
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        expect(b.chat.findChat(refK)).toBeUndefined();
        expect(locked(b)).toBe(true);
        expect(b.chat.isChatGenerating(refK)).toBe(true);
        const loaded = await b.chat.loadChat(refK);
        expect(loaded!.message[1].data).toBe("one");
        expect(locked(b)).toBe(true);
        // A frame naming a message the mirror lacks (a `begin` whose patch did not fit): locked by id.
        b.chat.noteRemoteStreaming([
            { characterId: "c", id: "k", streaming: [lockOf("b", "g", 1), lockOf("zz", "g9", 0)] },
        ]);
        expect(b.chat.isMessageLocked(refK, "zz")).toBe(true);
        jobWrite(b, [setText("setText", "b", "FINAL")], [], { release: "g" });
        expect(locked(b)).toBe(false);
        expect(b.chat.isMessageLocked(refK, "zz")).toBe(false);
    });

    it("replaces every feed lock from a hello snapshot without releasing this tab's job locks", async () => {
        const b = await boot();
        const other = { chaId: "d", chatId: "m" };
        b.chat.noteRemoteStreaming([
            { characterId: "c", id: "k", streaming: [lockOf("a", "finished")] },
            { characterId: "d", id: "m", streaming: [lockOf("x", "also-finished")] },
        ]);
        expect(
            b.chat.applyServerGeneration(refK, {
                jobId: "own-job",
                messageId: "c",
                generationId: "own-generation",
                seq: 1,
                text: "own reply",
            }),
        ).toBe(true);
        expect(locked(b, "a")).toBe(true);
        expect(b.chat.isMessageLocked(other, "x")).toBe(true);
        expect(locked(b)).toBe(false);

        b.chat.replaceFeedLocks([
            {
                characterId: "c",
                id: "k",
                revision: b.fake.chat("c", "k")!.revision,
                streaming: [lockOf("b", "running", 2)],
            },
        ]);
        expect(locked(b, "a")).toBe(false);
        expect(b.chat.isMessageLocked(other, "x")).toBe(false);
        expect(locked(b)).toBe(true);
        expect(locked(b, "c")).toBe(true);

        b.chat.replaceFeedLocks([]);
        expect(locked(b)).toBe(false);
        expect(locked(b, "c")).toBe(true);
        b.chat.endServerJob("own-job");
        expect(locked(b, "c")).toBe(false);
    });

    it("keeps a snapshot lock through reconciliation's whole read at its revision and releases it after a newer whole read", async () => {
        const b = await boot();
        b.live.paused = true;
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "waiting for provider")], [lockOf("b", "g", 1)]);
        const snapshotRevision = b.fake.chat("c", "k")!.revision;
        expect(mirror(b).message[1].data).toBe("B");
        expect(locked(b)).toBe(false);

        b.chat.replaceFeedLocks([
            {
                characterId: "c",
                id: "k",
                revision: snapshotRevision,
                streaming: [lockOf("b", "g", 1)],
            },
        ]);
        expect(locked(b)).toBe(true);
        b.sync.reconcileRemote(b.fake.store.listRevisions());
        await vi.advanceTimersByTimeAsync(1000);
        expect(reads(b)).toHaveLength(1);
        expect(mirror(b).message[1].data).toBe("waiting for provider");
        expect(b.chat.heldChatRevision(refK)).toBe(snapshotRevision);
        expect(locked(b)).toBe(true);

        remote(b, [{ op: "meta", set: { note: "newer stored chat" } }]);
        b.sync.reconcileRemote(b.fake.store.listRevisions());
        await vi.advanceTimersByTimeAsync(1000);
        expect(reads(b)).toHaveLength(2);
        expect(mirror(b).note).toBe("newer stored chat");
        expect(b.chat.heldChatRevision(refK)).toBe(b.fake.chat("c", "k")!.revision);
        expect(locked(b)).toBe(false);
        expect(b.fake.batchCount()).toBe(0);
        quiet(b);
    });

    it("a whole read releases a lock announced at an older revision and keeps one at its own; a `hello` snapshot without the lock, a chat's removal, and a character's forgetting drop locks without retiring the generation", async () => {
        const b = await boot();
        jobLock(b);
        jobWrite(b, [setText("setText", "b", "one")], [lockOf("b", "g", 1)]);
        const server = () => b.fake.chat("c", "k")! as any;
        b.chat.acceptRemoteChat(server());
        expect(locked(b)).toBe(true);
        // Another writer's change advances the revision with no lock frame (the socket missed it).
        b.live.paused = true;
        remote(b, [{ op: "meta", set: { note: "other writer" } }]);
        b.live.queue.length = 0;
        b.live.paused = false;
        expect(locked(b)).toBe(true);
        b.chat.acceptRemoteChat(server());
        expect(locked(b)).toBe(false);
        // The job's next write announces the lock again: not retired.
        jobWrite(b, [setText("setText", "b", "one two")], [lockOf("b", "g", 2)]);
        expect(locked(b)).toBe(true);
        b.chat.replaceFeedLocks([]);
        expect(locked(b)).toBe(false);
        jobWrite(b, [setText("setText", "b", "one two three")], [lockOf("b", "g", 3)]);
        expect(locked(b)).toBe(true);
        // A chat gone on the server (its read answers null) and a forgotten character drop their locks.
        b.chat.acceptRemoteChat({ characterId: "c", id: "k", revision: null, data: null });
        expect(locked(b)).toBe(false);
        b.chat.noteRemoteStreaming([{ characterId: "c", id: "j", streaming: [lockOf("x", "gx", 0)] }]);
        expect(b.chat.isMessageLocked({ chaId: "c", chatId: "j" }, "x")).toBe(true);
        b.chat.forgetCharacter("c");
        expect(b.chat.lockedChatKeys()).toEqual(new Set());
    });
});
