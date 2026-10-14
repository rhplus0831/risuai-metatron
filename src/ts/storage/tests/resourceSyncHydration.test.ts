import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../../shared/database.ts";
import type { GenerationEvent } from "../../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 5 slice 5 on the client: a server generation job's events mirrored without any outgoing
// write (`applyHydration`, `hydrateChat`, `applyServerGeneration`, the stream watermarks and
// buffer, the job-scoped locks), and the save loop's handling of a 409 `reason: "generating"`
// (work kept and retried after `JOB_RETRY_MS`, no empty polling, unsaved accounting, the flush
// refusal). The save adapter and the chat module run for real, with their Svelte watchers, against
// the real server store guarded by the real generation lock (`StoreBackedServer.create({ lock })`).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
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
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");
type Transport = typeof import("../../network/generationJobs");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string | undefined, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const refK = { chaId: "c", chatId: "k" };
const serverRef = { characterId: "c", chatId: "k" };
const B = { characterId: "c", chatId: "k", messageId: "b" };
/** The same token `n` writes later (`<epoch>:<seq>:<revision>`). */
const bumped = (token: string, n: number) =>
    token.replace(/:\d+$/, `:${Number(token.slice(token.lastIndexOf(":") + 1)) + n}`);
/** The same record's token from an earlier incarnation (`seq` one lower). */
const earlierIncarnation = (token: string) => {
    const [epoch, seq, revision] = token.split(":");
    return `${epoch}:${Number(seq) - 1}:${revision}`;
};

/**
 * Boots the adapter, the chat module, and the transport the way `loadData` does: the server holds
 * the collections and a character `c` with chats `k` (messages a, b, c) and `j` (empty), guarded by
 * the generation lock; read with chats, seed, install the records (`installBootRecords`), select
 * `c`, start, and let the boot pass run.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true });
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
                            message: [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")],
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

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const transport: Transport = await import("../../network/generationJobs");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");
    const { characterList }: CharacterStore = await import("../characterStore.svelte");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacterAt(0);
    chat.initializeChats();
    fake.requests.length = 0;
    // Each boot's graph registers its own window and document listeners on the shared ones; the
    // tests call this graph's directly, so an earlier test's graph never answers for it.
    const listeners = new Map<string, EventListener>();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(((type: string, listener: EventListener) => {
        listeners.set(type, listener);
    }) as never);
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(((
        type: string,
        listener: EventListener,
    ) => {
        listeners.set(type, listener);
    }) as never);
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    const fire = (type: string) => {
        const event = new Event(type, { cancelable: true });
        listeners.get(type)!(event);
        return event.defaultPrevented;
    };
    /** Whether this graph's `beforeunload` asks for the browser's warning (unsaved work). */
    const unloadWarning = () => fire("beforeunload");
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    /** The character wrappers, with the chat module's compatibility view (`chats`, `chatPage`). */
    const characters = () => characterList() as any[];
    const character = () => characters().find((entry: any) => entry.chaId === "c");
    const mirrorChat = (id = "k") => character().chats.find((entry: any) => entry.id === id) as Chat | undefined;
    const text = (id: string) => mirrorChat()!.message.find((entry) => entry.chatId === id)?.data;
    const locked = (id: string) => chat.isMessageLocked(refK, id);
    const epoch = fake.store.epoch();
    /** A chat `resource` event of job `jobId` with the server's copy of `k` and the given streaming list. */
    const chatEvent = (
        jobId: string,
        streaming: { messageId: string; generationId: string; seq: number }[],
        override: { revision?: string; data?: Chat } = {},
    ): GenerationEvent & { type: "resource"; kind: "chats" } => {
        const record = fake.chat("c", "k")!;
        return {
            type: "resource",
            epoch,
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: override.revision ?? record.revision,
            data: override.data ?? record.data,
            streaming,
        } as any;
    };
    /** The server copy of `k` with message `id`'s text replaced (a processed checkpoint the job stored). */
    const copyWith = (id: string, value: string): Chat => {
        const data = JSON.parse(JSON.stringify(fake.chat("c", "k")!.data)) as Chat;
        data.message.find((entry) => entry.chatId === id)!.data = value;
        return data;
    };
    const apply = (jobId: string, event: GenerationEvent) => transport.applyGenerationEvent(jobId, refK, event);
    const chunk = (generationId: string, seq: number, value: string, messageId = "b"): GenerationEvent => ({
        type: "chunk",
        epoch,
        messageId,
        generationId,
        text: value,
        seq,
    });
    const accepted = (jobId: string, generationId: string, messageId = "b", seq = 0): GenerationEvent => ({
        type: "accepted",
        epoch,
        jobId,
        messageId,
        generationId,
        revision: fake.chat("c", "k")!.revision,
        text: "",
        seq,
    });
    /** The server's stored row of message `id` of `k` (what a patch carries for it). */
    const row = (id: string, chatId = "k") =>
        JSON.parse(JSON.stringify(fake.chat("c", chatId)!.data.message.find((entry) => entry.chatId === id)));
    /** The server's chat `k` without its messages (a patch's `meta`). */
    const metaNow = (chatId = "k") => {
        const { message: _message, ...meta } = JSON.parse(JSON.stringify(fake.chat("c", chatId)!.data)) as Chat;
        return meta as Record<string, unknown>;
    };
    /** A `chatPatch` event of job `jobId` on `k` (`revision` defaults to the server's current one). */
    const patchEvent = (
        jobId: string,
        streaming: { messageId: string; generationId: string; seq: number }[],
        body: {
            baseRevision: string;
            revision?: string;
            meta?: Record<string, unknown>;
            removed?: string[];
            messages?: { after: string | null; message: unknown }[];
            count: number;
            id?: string;
        },
    ): GenerationEvent => {
        const { id, ...rest } = body;
        return {
            type: "chatPatch",
            epoch,
            characterId: "c",
            id: id ?? "k",
            revision: body.revision ?? fake.chat("c", id ?? "k")!.revision,
            ...rest,
            streaming,
        } as GenerationEvent;
    };
    /** A server write on `k` as another writer or the job makes it; returns the new revision. */
    const serverWrite = (ops: any[], chatId = "k") => {
        fake.chatBatch([{ characterId: "c", chatId, baseRevision: fake.chat("c", chatId)!.revision, ops }]);
        return fake.chat("c", chatId)!.revision;
    };
    const ids = (chatId = "k") => mirrorChat(chatId)!.message.map((entry) => entry.chatId);
    return {
        row,
        metaNow,
        patchEvent,
        serverWrite,
        ids,
        fake,
        sync,
        chat,
        transport,
        settings,
        characters,
        character,
        mirrorChat,
        text,
        locked,
        epoch,
        chatEvent,
        copyWith,
        apply,
        chunk,
        accepted,
        fire,
        unloadWarning,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // `Date` too: the job-retry block compares `Date.now()` with its deadline.
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

describe("resource hydration", () => {
    it("applies a newer record without echoing it back, and later local edits save on the hydrated revision", async () => {
        const { fake, sync, character, fire } = await boot();
        fake.set("characters", "c", { chaId: "c", name: "C by the job" });
        const record = fake.record("characters", "c")!;
        expect(sync.applyHydration({ kind: "characters", id: "c", revision: record.revision, data: record.data })).toBe(
            true,
        );
        expect(character().name).toBe("C by the job");
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
        // The watchers run (the hydrated record is marked), the loop runs: nothing goes out.
        await tick();
        await sync.flushResources();
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        fire("visibilitychange");
        await vi.advanceTimersByTimeAsync(1000);
        fire("pagehide");
        expect(fake.batchCount()).toBe(0);
        expect(alerts.normal).not.toHaveBeenCalled();
        // A genuine edit afterwards saves on the hydrated revision: no conflict, no reload.
        character().name = "C by me";
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.record("characters", "c")!.data).toMatchObject({ name: "C by me" });
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("applies consecutive records with a watcher tick between them: the first one's own dirty mark is no local change", async () => {
        const { fake, sync, character } = await boot();
        for (const name of ["C2", "C3"]) {
            fake.set("characters", "c", { chaId: "c", name });
            const record = fake.record("characters", "c")!;
            expect(
                sync.applyHydration({ kind: "characters", id: "c", revision: record.revision, data: record.data }),
            ).toBe(true);
            expect(character().name).toBe(name);
            await tick();
        }
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        expect(character().name).toBe("C3");
    });

    it("keeps a genuine local edit over a hydration, and keeps the newest refused record for after the next cycle", async () => {
        const { fake, sync, character } = await boot();
        character().name = "local edit";
        await tick();
        fake.set("characters", "c", { chaId: "c", name: "C by the job" });
        const record = fake.record("characters", "c")!;
        expect(sync.applyHydration({ kind: "characters", id: "c", revision: record.revision, data: record.data })).toBe(
            false,
        );
        expect(character().name).toBe("local edit");
        // The local edit goes out on the old revision and conflicts: the ordinary reload applies
        // the server copy (which is the hydrated one) with the notice; nothing of the hydration
        // was written by the client.
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.record("characters", "c")!.data).toMatchObject({ name: "C by the job" });
        expect(character().name).toBe("C by the job");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
    });

    it("defers a record whose batch is in flight and applies it after the cycle when it is still newer", async () => {
        const { fake, sync, character } = await boot();
        character().name = "local edit";
        fake.holdNextBatch = true;
        const flushing = sync.flushResources();
        await vi.advanceTimersByTimeAsync(600);
        expect(fake.releaseBatch).not.toBeNull();
        const before = fake.record("characters", "c")!;
        const newer = {
            kind: "characters",
            id: "c",
            revision: bumped(before.revision, 5),
            data: { chaId: "c", name: "from the job" },
        };
        expect(sync.applyHydration(newer)).toBe(false);
        expect(character().name).toBe("local edit");
        fake.releaseBatch!();
        await flushing;
        expect(fake.record("characters", "c")!.data).toMatchObject({ name: "local edit" });
        // The deferred record was newer than what the save landed: applied after the cycle, no echo.
        expect(character().name).toBe("from the job");
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
    });

    it("ignores an older incarnation or revision, another epoch, an unparsable token, a deletion, hidden kinds, and records it does not hold", async () => {
        const { fake, sync, character } = await boot();
        const record = fake.record("characters", "c")!;
        const data = { chaId: "c", name: "ignored" };
        for (const [label, hydration] of [
            ["same revision", { kind: "characters", id: "c", revision: record.revision, data }],
            ["older revision", { kind: "characters", id: "c", revision: bumped(record.revision, -1), data }],
            [
                "older incarnation",
                { kind: "characters", id: "c", revision: earlierIncarnation(bumped(record.revision, 9)), data },
            ],
            [
                "other epoch",
                { kind: "characters", id: "c", revision: `00000000-0000-4000-8000-000000000000:9:9`, data },
            ],
            ["unparsable", { kind: "characters", id: "c", revision: "r9", data }],
            ["deletion", { kind: "characters", id: "c", revision: bumped(record.revision, 1), data: null }],
            ["hidden", { kind: "llmSecrets", id: "main", revision: bumped(record.revision, 1), data: {} }],
            [
                "unknown record",
                { kind: "characters", id: "zz", revision: bumped(record.revision, 1), data: { chaId: "zz" } },
            ],
            ["unknown kind", { kind: "nope", id: "main", revision: bumped(record.revision, 1), data: {} }],
        ] as [string, Parameters<Sync["applyHydration"]>[0]][]) {
            expect(sync.applyHydration(hydration), label).toBe(false);
        }
        expect(character().name).toBe("C");
        expect(fake.record("characters", "zz")).toBeNull();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });
});

describe("chat hydration", () => {
    it("replaces an idle chat with the server copy and moves its revision, without an outgoing write; a busy chat waits for an idle refresh", async () => {
        const { fake, sync, chat, mirrorChat, chatEvent, apply } = await boot();
        const revision = fake.chat("c", "k")!.revision;
        fake.chatBatch([
            {
                ...serverRef,
                baseRevision: revision,
                ops: [{ op: "append", messages: [m("d", "D")], anchor: { end: true } }],
            },
        ]);
        apply("J", chatEvent("J", []));
        expect(mirrorChat()!.message.map((entry) => entry.chatId)).toEqual(["a", "b", "c", "d"]);
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        expect(alerts.normal).not.toHaveBeenCalled();
        // A local op afterwards is based on the hydrated revision.
        chat.appendMessage(refK, m("e", "E"));
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.batchBodies()[0].chats[0].baseRevision).toBe(
            fake
                .chat("c", "k")!
                .revision.replace(/:\d+$/, `:${Number(revision.slice(revision.lastIndexOf(":") + 1)) + 1}`),
        );
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "D", "E"]);
        // The same revision applies too (a hydration at the held revision is not older); an older
        // one, or one of another epoch, changes nothing.
        expect(sync.applyHydration({ ...chatEvent("J", []), job: undefined } as any)).toBe(true);
        expect(sync.applyHydration({ ...chatEvent("J", [], { revision }), job: undefined } as any)).toBe(false);
        // Busy: a pending local op keeps the mirror's copy; the server copy arrives with the idle refresh.
        chat.setChatMeta(refK, { note: "local note" });
        fake.chatBatch([
            {
                ...serverRef,
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "append", messages: [m("f", "F")], anchor: { end: true } }],
            },
        ]);
        expect(sync.applyHydration({ ...chatEvent("J", []), job: undefined } as any)).toBe(false);
        expect(mirrorChat()!.message.map((entry) => entry.chatId)).toEqual(["a", "b", "c", "d", "e"]);
        await sync.flushResources();
        expect(fake.chat("c", "k")!.data.note).toBe("local note");
        expect(mirrorChat()!.message.map((entry) => entry.chatId)).toEqual(["a", "b", "c", "d", "e", "f"]);
        expect(mirrorChat()!.note).toBe("local note");
    });
});

describe("a job's reply in the mirror", () => {
    it("locks the reply for the job, orders chunks, shows a covered checkpoint over older stream text, and restores the newest chunk when the claim drops", async () => {
        const { sync, fake, text, locked, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        apply("J", accepted("J", "g1"));
        expect(locked("b")).toBe(true);
        expect(locked("a")).toBe(false);
        expect(text("b")).toBe("");
        apply("J", chunk("g1", 1, "RAW ONE"));
        apply("J", chunk("g1", 2, "RAW TWO"));
        apply("J", chunk("g1", 1, "RAW ONE again"));
        // The mirror takes one stream update per frame: the newest chunk shows at the next one.
        await vi.waitFor(() => expect(text("b")).toBe("RAW TWO"));
        // A processed checkpoint that holds chunk 2: shown, still locked.
        let revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 2 }], {
                revision,
                data: copyWith("b", "PROCESSED TWO"),
            }),
        );
        expect(text("b")).toBe("PROCESSED TWO");
        expect(locked("b")).toBe(true);
        // A newer chunk shows over it; a copy claiming less keeps the stream text.
        apply("J", chunk("g1", 3, "RAW THREE"));
        expect(text("b")).toBe("RAW THREE");
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 0 }], {
                revision,
                data: copyWith("b", "STORED ZERO"),
            }),
        );
        expect(text("b")).toBe("RAW THREE");
        // A copy covering chunk 3 shows; a later copy with a lower claim restores the newest chunk,
        // not the previous processed text.
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 3 }], {
                revision,
                data: copyWith("b", "PROCESSED THREE"),
            }),
        );
        expect(text("b")).toBe("PROCESSED THREE");
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 1 }], {
                revision,
                data: copyWith("b", "STORED ONE"),
            }),
        );
        expect(text("b")).toBe("RAW THREE");
        // A covered chunk arriving after the copy is kept in the buffer, not shown, until a lower claim.
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 5 }], {
                revision,
                data: copyWith("b", "PROCESSED FIVE"),
            }),
        );
        apply("J", chunk("g1", 4, "RAW FOUR"));
        expect(text("b")).toBe("PROCESSED FIVE");
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 2 }], {
                revision,
                data: copyWith("b", "STORED TWO"),
            }),
        );
        expect(text("b")).toBe("RAW FOUR");
        expect(locked("b")).toBe(true);
        // The terminal hydration lists nothing streaming: the final text shows and the lock goes;
        // the terminal event is then a no-op, and a late chunk of the ended generation is dropped.
        revision = bumped(revision, 1);
        apply("J", chatEvent("J", [], { revision, data: copyWith("b", "FINAL") }));
        expect(text("b")).toBe("FINAL");
        expect(locked("b")).toBe(false);
        apply("J", { type: "done", epoch: fake.store.epoch(), revision, messageId: "b" });
        apply("J", chunk("g1", 9, "LATE"));
        expect(text("b")).toBe("FINAL");
        expect(locked("b")).toBe(false);
        // Nothing of this went out.
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("releases a reply finalized while the job continues, scopes releases to the job, retires a replaced generation, and orders job metadata across revisions", async () => {
        const { fake, chat, text, locked, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        // Job A owns a (g1) and b (g2); job B owns c (g3).
        apply("A", accepted("A", "g1", "a"));
        apply("A", accepted("A", "g2", "b"));
        apply("B", accepted("B", "g3", "c"));
        apply("A", chunk("g1", 1, "A1", "a"));
        apply("A", chunk("g2", 1, "B1", "b"));
        apply("B", chunk("g3", 1, "C1", "c"));
        expect([locked("a"), locked("b"), locked("c")]).toEqual([true, true, true]);
        // A's copy lists only b streaming (holding none of its chunks): a is final there (released,
        // its text taken from the copy), b keeps its streamed text; B's c is untouched.
        let revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "A",
            chatEvent("A", [{ messageId: "b", generationId: "g2", seq: 0 }], {
                revision,
                data: copyWith("a", "A FINAL"),
            }),
        );
        expect([locked("a"), locked("b"), locked("c")]).toEqual([false, true, true]);
        expect(text("a")).toBe("A FINAL");
        expect(text("b")).toBe("B1");
        expect(text("c")).toBe("C1");
        // An ended job's empty list releases its own locks only.
        revision = bumped(revision, 1);
        apply("B", chatEvent("B", [], { revision, data: copyWith("c", "C FINAL") }));
        expect([locked("b"), locked("c")]).toEqual([true, false]);
        expect(text("c")).toBe("C FINAL");
        expect(text("b")).toBe("B1");
        // A continue: g4 takes b over; g2's late chunk is dropped, g4's applies.
        apply("A", accepted("A", "g4", "b", 0));
        apply("A", chunk("g2", 5, "OLD GENERATION", "b"));
        apply("A", chunk("g4", 1, "NEW GENERATION", "b"));
        await vi.waitFor(() => expect(text("b")).toBe("NEW GENERATION"));
        expect(locked("b")).toBe(true);
        // Metadata ordering while the chat is busy (a local edit pends): a revision-12 copy still
        // listing b is consumed; a delayed revision-11 copy with an empty list changes nothing.
        chat.setChatMeta(refK, { note: "local" });
        const r12 = bumped(revision, 2);
        const r11 = bumped(revision, 1);
        apply(
            "A",
            chatEvent("A", [{ messageId: "b", generationId: "g4", seq: 1 }], {
                revision: r12,
                data: copyWith("b", "unapplied"),
            }),
        );
        expect(text("b")).toBe("NEW GENERATION");
        expect(locked("b")).toBe(true);
        apply("A", chatEvent("A", [], { revision: r11, data: copyWith("b", "unapplied") }));
        expect(locked("b")).toBe(true);
        apply("A", chunk("g4", 2, "STILL STREAMING", "b"));
        expect(text("b")).toBe("STILL STREAMING");
        // A copy older than the held revision changes nothing either, metadata included.
        apply(
            "A",
            chatEvent("A", [], { revision: bumped(fake.chat("c", "k")!.revision, -1), data: copyWith("b", "ancient") }),
        );
        expect(locked("b")).toBe(true);
        // The terminal event releases what the job still holds and marks the chat for a refresh.
        apply("A", { type: "error", epoch: fake.store.epoch(), message: "x", status: 499, reason: "aborted" });
        expect(locked("b")).toBe(false);
        expect(chat.isChatGenerating(refK)).toBe(false);
    });

    it("refuses a client edit of a message a server job locks, keeps the other messages editable, and marks the character generating until the job ends", async () => {
        const { chat, text, apply, accepted } = await boot();
        apply("J", accepted("J", "g1"));
        expect(() => chat.setMessageText(refK, "b", "mine")).toThrow(/being generated/);
        expect(text("b")).toBe("");
        expect(chat.isCharacterGenerating("c")).toBe(true);
        chat.setMessageText(refK, "a", "fine");
        apply("J", { type: "done", epoch: "x", revision: null });
        expect(chat.isCharacterGenerating("c")).toBe(false);
    });
});

// Phase 5 cutover: the job's chat event can come before its `accepted` (a reply appended with
// `begin`), and the reply is locked from that event on (`hydrateChat`), holding no stream update yet.
describe("a reply locked by its job's chat event, before its stream", () => {
    /** The `accepted` snapshot carrying the text the job had streamed so far. */
    const withText = (event: GenerationEvent, text: string): GenerationEvent => ({ ...event, text }) as GenerationEvent;

    it("locks the reply at the chat event (a reactive change), then the first accepted and chunk stream into it, and the terminal copy unlocks it", async () => {
        const { fake, sync, chat, text, locked, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        // Loaded after the boot's module reset, so the probe and the chat module share one Svelte runtime.
        const { createProbe } = await import("./reactiveProbe.svelte");
        const { flushSync } = await import("svelte");
        const probe = createProbe(() => chat.isMessageLocked(refK, "b"));
        let revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 0 }], { revision, data: copyWith("b", "") }),
        );
        flushSync();
        expect(probe.seen).toEqual([false, true]);
        expect(locked("a")).toBe(false);
        expect(text("b")).toBe("");
        expect(() => chat.setMessageText(refK, "b", "mine")).toThrow(/being generated/);
        apply("J", accepted("J", "g1", "b", 0));
        expect(locked("b")).toBe(true);
        apply("J", chunk("g1", 1, "RAW ONE"));
        expect(text("b")).toBe("RAW ONE");
        revision = bumped(revision, 1);
        apply("J", chatEvent("J", [], { revision, data: copyWith("b", "FINAL") }));
        flushSync();
        expect(text("b")).toBe("FINAL");
        expect(locked("b")).toBe(false);
        expect(probe.seen).toEqual([false, true, false]);
        probe.dispose();
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("locks a reply whose copy local work keeps out without claiming its text: the accepted snapshot at the copy's claim shows, and the local work saves alone", async () => {
        const { fake, sync, chat, text, locked, chatEvent, copyWith, apply, accepted } = await boot();
        chat.setChatMeta(refK, { note: "local note" });
        const revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 3 }], {
                revision,
                data: copyWith("b", "SERVER THREE"),
            }),
        );
        // Busy: the mirror keeps its copy, and the reply is locked all the same.
        expect(text("b")).toBe("B");
        expect(locked("b")).toBe(true);
        apply("J", withText(accepted("J", "g1", "b", 3), "RAW THREE"));
        expect(text("b")).toBe("RAW THREE");
        await sync.flushResources();
        expect(fake.chat("c", "k")!.data.note).toBe("local note");
        // The streamed text is not written back as this tab's change.
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(locked("b")).toBe(true);
    });

    it("keeps a covering processed copy shown over the first accepted snapshot at its claim, and shows that raw text when a later copy claims less", async () => {
        const { fake, text, locked, chatEvent, copyWith, apply, accepted } = await boot();
        let revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 5 }], {
                revision,
                data: copyWith("b", "PROCESSED FIVE"),
            }),
        );
        expect(text("b")).toBe("PROCESSED FIVE");
        expect(locked("b")).toBe(true);
        apply("J", withText(accepted("J", "g1", "b", 5), "RAW FIVE"));
        expect(text("b")).toBe("PROCESSED FIVE");
        revision = bumped(revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 2 }], {
                revision,
                data: copyWith("b", "STORED TWO"),
            }),
        );
        expect(text("b")).toBe("RAW FIVE");
        expect(locked("b")).toBe(true);
    });

    it("does not lock again for a generation the terminal ended (a delayed copy still listing it), or for a chat copy without a job", async () => {
        const { fake, sync, text, locked, chatEvent, copyWith, apply, accepted } = await boot();
        apply("J", accepted("J", "g1"));
        expect(locked("b")).toBe(true);
        apply("J", { type: "error", epoch: fake.store.epoch(), message: "x", status: 499, reason: "aborted" });
        expect(locked("b")).toBe(false);
        apply("J", chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 0 }]));
        expect(locked("b")).toBe(false);
        // Another tab's view: the same copy without the job's metadata applies and locks nothing.
        const revision = bumped(fake.chat("c", "k")!.revision, 1);
        expect(
            sync.applyHydration({
                ...chatEvent("J", [{ messageId: "c", generationId: "g2", seq: 0 }], {
                    revision,
                    data: copyWith("c", "OTHER TAB"),
                }),
                job: undefined,
            } as any),
        ).toBe(true);
        expect(text("c")).toBe("OTHER TAB");
        expect(locked("c")).toBe(false);
    });

    it("hands the message to a continue's new generation at its chat event, dropping the old generation's late chunks", async () => {
        const { fake, text, locked, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        apply("J", accepted("J", "g1"));
        apply("J", chunk("g1", 2, "FIRST REPLY"));
        const revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g2", seq: 0 }], {
                revision,
                data: copyWith("b", "FIRST REPLY"),
            }),
        );
        expect(locked("b")).toBe(true);
        apply("J", chunk("g1", 3, "OLD GENERATION"));
        expect(text("b")).toBe("FIRST REPLY");
        apply("J", withText(accepted("J", "g2", "b", 0), "FIRST REPLY"));
        apply("J", chunk("g2", 1, "FIRST REPLY, CONTINUED"));
        await vi.waitFor(() => expect(text("b")).toBe("FIRST REPLY, CONTINUED"));
        expect(locked("b")).toBe(true);
    });
});

// Phase 6 slice 3 (owner decision 3): the streaming display optimization follows the server stream.
// A generation's first stream update makes its message `streamingState`, with the configured mode;
// every release of that generation's lock clears it.
describe("the streaming state follows a job's stream", () => {
    const state = (chat: ChatModule) => ({ ...chat.streamingState });
    const none = { chaId: null, chatId: null, messageId: null, mode: undefined };

    it("is set by a generation's first stream update with the configured mode, not by its chat event's placeholder lock, keeps that mode, and is cleared at the job's end", async () => {
        const { fake, chat, settings, locked, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        settings.ui.streamingDisplayOptimizationMode = "strong";
        const revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply(
            "J",
            chatEvent("J", [{ messageId: "b", generationId: "g1", seq: 0 }], { revision, data: copyWith("b", "") }),
        );
        expect(locked("b")).toBe(true);
        expect(state(chat)).toEqual(none);
        apply("J", accepted("J", "g1", "b", 0));
        expect(state(chat)).toEqual({ ...refK, messageId: "b", mode: "strong" });
        expect(chat.isStreamingMessage(refK, "b")).toBe(true);
        // A later chunk of the same generation keeps the mode it started with.
        settings.ui.streamingDisplayOptimizationMode = "balanced";
        apply("J", chunk("g1", 1, "RAW ONE"));
        expect(state(chat)).toEqual({ ...refK, messageId: "b", mode: "strong" });
        apply("J", { type: "done", epoch: fake.store.epoch(), revision: null });
        expect(locked("b")).toBe(false);
        expect(state(chat)).toEqual(none);

        // Without the setting: "off". A generation that starts with a chunk sets it too.
        // Cleared through the view (the section views are frozen accessors; the record holds the value).
        settings.ui.streamingDisplayOptimizationMode = undefined;
        apply("K", chunk("g2", 0, "FIRST", "c"));
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "off" });
    });

    it("is cleared when a chat event releases the generation or hands its message to another one, and a later generation keeps it when an earlier one's lock is released", async () => {
        const { fake, chat, settings, chatEvent, copyWith, apply, chunk, accepted } = await boot();
        settings.ui.streamingDisplayOptimizationMode = "balanced";
        apply("A", accepted("A", "g1", "a"));
        expect(state(chat)).toEqual({ ...refK, messageId: "a", mode: "balanced" });
        // Another job's generation takes the state over.
        apply("B", accepted("B", "g3", "c"));
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "balanced" });
        // A's chat event no longer lists g1: its lock goes, B's state stays.
        let revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply("A", chatEvent("A", [], { revision, data: copyWith("a", "A FINAL") }));
        expect(chat.isMessageLocked(refK, "a")).toBe(false);
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "balanced" });
        // A's terminal event releases nothing of B's.
        apply("A", { type: "done", epoch: fake.store.epoch(), revision: null });
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "balanced" });

        // B's chat event hands c to a continue's generation g4: g3's state goes; g4's placeholder
        // lock sets nothing until its first stream update.
        revision = bumped(revision, 1);
        apply("B", chatEvent("B", [{ messageId: "c", generationId: "g4", seq: 0 }], { revision }));
        expect(chat.isMessageLocked(refK, "c")).toBe(true);
        expect(state(chat)).toEqual(none);
        settings.ui.streamingDisplayOptimizationMode = "strong";
        apply("B", chunk("g4", 1, "CONTINUED", "c"));
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "strong" });

        // A continue that arrives as a stream update first (g5 replaces g4 without a chat event)
        // takes the state over; g4's late chunk changes nothing; the release of g5 clears it.
        apply("B", accepted("B", "g5", "c", 0));
        apply("B", chunk("g4", 9, "OLD", "c"));
        expect(state(chat)).toEqual({ ...refK, messageId: "c", mode: "strong" });
        revision = bumped(revision, 1);
        apply("B", chatEvent("B", [], { revision, data: copyWith("c", "C FINAL") }));
        expect(chat.isMessageLocked(refK, "c")).toBe(false);
        expect(state(chat)).toEqual(none);

        // Another job's chat event names a new owner of a message job C streams into: C's state goes,
        // and the new owner's placeholder lock keeps the message locked.
        apply("C", accepted("C", "g6", "a"));
        expect(state(chat)).toEqual({ ...refK, messageId: "a", mode: "strong" });
        revision = bumped(revision, 1);
        apply("D", chatEvent("D", [{ messageId: "a", generationId: "g7", seq: 0 }], { revision }));
        expect(chat.isMessageLocked(refK, "a")).toBe(true);
        expect(state(chat)).toEqual(none);
    });

    it("is cleared by a release in a copy local work keeps out (the lock goes all the same)", async () => {
        const { fake, chat, chatEvent, copyWith, apply, accepted } = await boot();
        apply("J", accepted("J", "g1"));
        expect(state(chat)).toEqual({ ...refK, messageId: "b", mode: "off" });
        chat.setChatMeta(refK, { note: "local" });
        const revision = bumped(fake.chat("c", "k")!.revision, 1);
        apply("J", chatEvent("J", [], { revision, data: copyWith("b", "FINAL") }));
        expect(chat.isMessageLocked(refK, "b")).toBe(false);
        expect(state(chat)).toEqual(none);
    });
});

describe("a refusal for a generating message", () => {
    const lockB = (fake: StoreBackedServer) => {
        fake.lock!.addToken("T");
        fake.lock!.acquire(B, { jobId: "J", generationId: "g1", token: "T" });
    };

    it("keeps a refused message edit, retries it once after JOB_RETRY_MS without polling, shows the notice once, and refuses a flush meanwhile", async () => {
        const { fake, sync, chat, unloadWarning } = await boot();
        lockB(fake);
        const timeouts = vi.spyOn(globalThis, "setTimeout");
        chat.setMessageText(refK, "b", "edited");
        chat.setMessageText(refK, "a", "also edited");
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(fake.batchCount()).toBe(1);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(alerts.normal).toHaveBeenCalledWith("generating");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(unloadWarning()).toBe(true);
        // No cycle before the retry: no request and no short reschedule.
        timeouts.mockClear();
        await vi.advanceTimersByTimeAsync(4400);
        expect(fake.batchCount()).toBe(1);
        expect(timeouts.mock.calls.filter(([, delay]) => typeof delay === "number" && delay <= 500)).toEqual([]);
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(fake.batchCount()).toBe(1);
        // The job ends: the retry lands at the deadline, both edits in one group.
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(1200);
        expect(fake.batchCount()).toBe(2);
        expect(fake.texts("c", "k")).toEqual(["also edited", "edited", "C"]);
        expect(chat.hasUnsavedChatWork()).toBe(false);
        // The loop's own follow-up debounce settles the cycle's marks; nothing more goes out.
        await vi.advanceTimersByTimeAsync(600);
        expect(fake.batchCount()).toBe(2);
        expect(unloadWarning()).toBe(false);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(2);
        expect(alerts.normal).toHaveBeenCalledTimes(1);
    });

    it("holds a reorder behind a refused chat delete without polling, and sends both at the retry", async () => {
        const { fake, sync, chat, character, unloadWarning } = await boot();
        lockB(fake);
        const timeouts = vi.spyOn(globalThis, "setTimeout");
        chat.deleteChat(refK);
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(fake.batchCount()).toBe(1);
        expect(fake.chat("c", "k")).not.toBeNull();
        expect(character().chats.map((entry: any) => entry.id)).toEqual(["j"]);
        chat.reorderChats("c", ["j"]);
        timeouts.mockClear();
        await vi.advanceTimersByTimeAsync(4000);
        expect(fake.batchCount()).toBe(1);
        expect(timeouts.mock.calls.filter(([, delay]) => typeof delay === "number" && delay <= 500)).toEqual([]);
        expect(unloadWarning()).toBe(true);
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(1600);
        expect(fake.batchCount()).toBe(2);
        expect(fake.chat("c", "k")).toBeNull();
        expect(fake.order("c")!.ids).toEqual(["j"]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(2);
    });

    it("keeps a refused character delete as an unsaved membership change without polling, refuses a flush, and deletes at the retry; an undo clears it", async () => {
        const { fake, sync, chat, characters, unloadWarning } = await boot();
        const characterStore = await import("../characterStore.svelte");
        lockB(fake);
        const timeouts = vi.spyOn(globalThis, "setTimeout");
        // The list changes through the character module (Phase 6 slice 5: a splice through the
        // list wrapper is refused); removing the selected character selects home.
        // Phase 6 slice 9a: a copy of the record carries no chats; the legacy shape with them is
        // built with `withChatsCopy`.
        const removed = chat.withChatsCopy(JSON.parse(JSON.stringify(characters()[0])));
        expect(characterStore.removeCharacter("c")).toBe(true);
        await tick();
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(fake.batchCount()).toBe(1);
        expect(fake.batchBodies()[0].ops).toEqual([
            expect.objectContaining({ kind: "characters", id: "c", delete: true }),
        ]);
        expect(fake.record("characters", "c")).not.toBeNull();
        expect(alerts.normal).toHaveBeenCalledWith("generating");
        expect(unloadWarning()).toBe(true);
        timeouts.mockClear();
        await vi.advanceTimersByTimeAsync(4000);
        expect(fake.batchCount()).toBe(1);
        expect(timeouts.mock.calls.filter(([, delay]) => typeof delay === "number" && delay <= 500)).toEqual([]);
        // Undo: the character is back, nothing is owed for it any more. Added back through the
        // character module, it also enters the character order (the fixture's order is `[]`), and it is
        // prepared as a creation (Phase 6 slice 5b), which stamps the `creation_date` the fixture's
        // record lacks: those two are the writes the undo sends, the character's a field patch (audit
        // item A1) of that one stamp on the server's record at its held revision, no delete.
        const stored = fake.record("characters", "c")!;
        characterStore.addCharacter(removed);
        await tick();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(2);
        expect(fake.batchBodies()[1]).toEqual({
            ops: [
                expect.objectContaining({ kind: "characterOrder", id: "main", data: ["c"] }),
                {
                    kind: "characters",
                    id: "c",
                    baseRevision: stored.revision,
                    patch: { set: { creation_date: expect.any(Number) }, remove: [] },
                },
            ],
            chats: [],
            chatOrders: [],
        });
        expect(fake.record("characters", "c")!.data).toEqual({ ...stored.data, creation_date: expect.any(Number) });
        await sync.flushResources();
        expect({
            chatWork: chat.hasUnsavedChatWork(),
            runnable: chat.hasChatWork(),
            idle: chat.idleChatRefreshes(),
            deferred: chat.deferredReloads(),
            mirror: characters().map((entry: any) => [entry.chaId, entry.chats.map((c: any) => c.id)]),
        }).toEqual({ chatWork: false, runnable: false, idle: [], deferred: [], mirror: [["c", ["k", "j"]]] });
        expect(unloadWarning()).toBe(false);
        // Deleted again while still locked, then the job ends: the retry deletes it with its chats.
        expect(characterStore.removeCharacter("c")).toBe(true);
        await tick();
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(5500);
        expect(fake.record("characters", "c")).toBeNull();
        expect(fake.chat("c", "k")).toBeNull();
        expect(unloadWarning()).toBe(false);
    });

    it("handles an ordinary conflict and a generating refusal in one batch: the record reloads with its notice, the chat work waits", async () => {
        const { fake, sync, chat, settings } = await boot();
        lockB(fake);
        settings.ui.theme = "mine";
        fake.set("ui", "main", { ...(fake.record("ui", "main")!.data as object), theme: "theirs" });
        chat.setMessageText(refK, "b", "edited");
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(settings.ui.theme).toBe("theirs");
        expect(alerts.normal.mock.calls.map(([text]) => text).sort()).toEqual(["generating", "reloaded"]);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(5500);
        expect(fake.texts("c", "k")).toEqual(["A", "edited", "C"]);
    });
});

// The job chat's `chatPatch` (`hydrateChatPatch`, through `applyPatchHydration` and the transport's
// `applyGenerationEvent`): the change between two stored revisions, applied only to a mirror that
// holds exactly the patch's base or its revision and has no local work, with the job's lock handling
// of a whole hydration; otherwise the chat is marked for an idle refresh (`busy`, `mismatch`).
describe("a job's chat patch", () => {
    /** The same record's token from a later incarnation (`seq` one higher). */
    const laterIncarnation = (token: string) => {
        const [epoch, seq, revision] = token.split(":");
        return `${epoch}:${Number(seq) + 1}:${revision}`;
    };

    it("applies at its base: inserts and replaces its rows as owned copies after their anchors, keeps every other message's object, replaces the meta, moves the held revision, and echoes nothing", async () => {
        const { fake, sync, chat, mirrorChat, text, apply, patchEvent, row, metaNow, serverWrite, ids } = await boot();
        const base = fake.chat("c", "k")!.revision;
        expect(chat.heldChatRevision(refK)).toBe(base);
        const before = chat.findChat(refK)!;
        const [keepA, , keepC] = before.message;
        const revision = serverWrite([
            { op: "append", messages: [m("d", "D", "char")], anchor: { end: true } },
            { op: "setText", id: "b", text: "B by the job" },
            { op: "meta", set: { note: "noted by the job" } },
        ]);
        apply(
            "J",
            patchEvent("J", [], {
                baseRevision: base,
                revision,
                meta: metaNow(),
                messages: [
                    { after: "a", message: row("b") },
                    { after: "c", message: row("d") },
                ],
                count: 4,
            }),
        );
        expect(ids()).toEqual(["a", "b", "c", "d"]);
        expect(text("b")).toBe("B by the job");
        expect(text("d")).toBe("D");
        expect(mirrorChat()!.note).toBe("noted by the job");
        const after = chat.findChat(refK)!;
        expect(after.message[0]).toBe(keepA);
        expect(after.message[2]).toBe(keepC);
        expect(chat.heldChatRevision(refK)).toBe(revision);
        expect(chat.idleChatRefreshes()).toEqual([]);
        // Nothing went out for the patch; a local edit afterwards saves on the patched revision.
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        chat.setMessageText(refK, "a", "mine");
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.texts("c", "k")).toEqual(["mine", "B by the job", "C", "D"]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("applies a removal, keeping the surviving messages' objects, and a patch spanning several server revisions from the held base", async () => {
        const { fake, chat, text, apply, patchEvent, row, metaNow, serverWrite, ids } = await boot();
        const base = fake.chat("c", "k")!.revision;
        const [keepA, , keepC] = chat.findChat(refK)!.message;
        serverWrite([{ op: "remove", ids: ["b"] }]);
        serverWrite([{ op: "meta", set: { name: "Renamed" } }]);
        const revision = serverWrite([{ op: "setText", id: "c", text: "C later" }]);
        apply(
            "J",
            patchEvent("J", [], {
                baseRevision: base,
                revision,
                meta: metaNow(),
                removed: ["b"],
                messages: [{ after: "a", message: row("c") }],
                count: 2,
            }),
        );
        expect(ids()).toEqual(["a", "c"]);
        expect(text("c")).toBe("C later");
        expect(chat.findChat(refK)!.name).toBe("Renamed");
        expect(chat.findChat(refK)!.message[0]).toBe(keepA);
        expect(chat.findChat(refK)!.message[1]).not.toBe(keepC);
        expect(chat.heldChatRevision(refK)).toBe(revision);
    });

    it("installs the job's generated row under the streamed text at a new and at an equal revision, honours the claim as a watermark, and releases the reply at the terminal patch", async () => {
        const { fake, sync, text, locked, apply, chunk, accepted, patchEvent, row, serverWrite } = await boot();
        apply("J", accepted("J", "g1"));
        apply("J", chunk("g1", 1, "RAW ONE"));
        apply("J", chunk("g1", 2, "RAW TWO"));
        await vi.waitFor(() => expect(text("b")).toBe("RAW TWO"));
        // The job's processed checkpoint covering chunk 2: the stored row shows over the raw text.
        const r0 = fake.chat("c", "k")!.revision;
        const r1 = serverWrite([{ op: "setText", id: "b", text: "PROCESSED TWO" }]);
        apply(
            "J",
            patchEvent("J", [{ messageId: "b", generationId: "g1", seq: 2 }], {
                baseRevision: r0,
                revision: r1,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        expect(text("b")).toBe("PROCESSED TWO");
        expect(locked("b")).toBe(true);
        expect(fake.texts("c", "k")).toEqual(["A", "PROCESSED TWO", "C"]);
        // A newer chunk shows over it. An equal-revision patch (nothing stored changed) still carries
        // the generated row and claims 0: the stored text is installed and the newer stream put back.
        apply("J", chunk("g1", 3, "RAW THREE"));
        expect(text("b")).toBe("RAW THREE");
        apply(
            "J",
            patchEvent("J", [{ messageId: "b", generationId: "g1", seq: 0 }], {
                baseRevision: r1,
                revision: r1,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        expect(text("b")).toBe("RAW THREE");
        expect(locked("b")).toBe(true);
        // An equal-revision patch claiming chunk 3 shows the stored text over the raw one.
        apply(
            "J",
            patchEvent("J", [{ messageId: "b", generationId: "g1", seq: 3 }], {
                baseRevision: r1,
                revision: r1,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        expect(text("b")).toBe("PROCESSED TWO");
        expect(locked("b")).toBe(true);
        // The terminal patch lists nothing streaming: the stored final shows and the lock goes; the
        // terminal event is a no-op and a late chunk of the ended generation is dropped.
        const r2 = serverWrite([{ op: "setText", id: "b", text: "FINAL" }]);
        apply(
            "J",
            patchEvent("J", [], {
                baseRevision: r1,
                revision: r2,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        expect(text("b")).toBe("FINAL");
        expect(locked("b")).toBe(false);
        apply("J", { type: "done", epoch: fake.store.epoch(), revision: r2, messageId: "b" });
        apply("J", chunk("g1", 9, "LATE"));
        expect(text("b")).toBe("FINAL");
        await tick();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("locks a reply the patch lists before its stream (a reply appended with `begin`), as a whole copy does", async () => {
        const { fake, chat, text, locked, apply, chunk, accepted, patchEvent, row, serverWrite, ids } = await boot();
        const base = fake.chat("c", "k")!.revision;
        const revision = serverWrite([{ op: "append", messages: [m("r", "", "char")], anchor: { end: true } }]);
        apply(
            "J",
            patchEvent("J", [{ messageId: "r", generationId: "g1", seq: 0 }], {
                baseRevision: base,
                revision,
                messages: [{ after: "c", message: row("r") }],
                count: 4,
            }),
        );
        expect(ids()).toEqual(["a", "b", "c", "r"]);
        expect(locked("r")).toBe(true);
        expect(() => chat.setMessageText(refK, "r", "mine")).toThrow(/being generated/);
        apply("J", accepted("J", "g1", "r", 0));
        apply("J", chunk("g1", 1, "RAW ONE", "r"));
        expect(text("r")).toBe("RAW ONE");
    });

    it("refuses a patch whose base is not the held revision (a missed change), even when its revision is newer, marks the chat for a refresh, and refuses every patch while it is marked; the whole copy then applies and clears the mark", async () => {
        const { fake, sync, chat, apply, patchEvent, row, metaNow, serverWrite, ids } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        const r1 = serverWrite([{ op: "meta", set: { note: "missed" } }]);
        const r2 = serverWrite([{ op: "append", messages: [m("d", "D")], anchor: { end: true } }]);
        const intermediate = {
            characterId: "c",
            id: "k",
            baseRevision: r1,
            revision: r2,
            messages: [{ after: "c", message: row("d") }],
            count: 4,
        };
        expect(sync.applyPatchHydration(intermediate, { jobId: "J", streaming: [] })).toBe("mismatch");
        expect(ids()).toEqual(["a", "b", "c"]);
        expect(chat.findChat(refK)!.note).toBe("");
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(chat.idleChatRefreshes()).toEqual([refK]);
        // Marked: even the patch from the held base is refused (the mirror may not match it any more).
        const exact = { ...intermediate, baseRevision: r0, meta: metaNow() };
        expect(sync.applyPatchHydration(exact, { jobId: "J", streaming: [] })).toBe("mismatch");
        expect(ids()).toEqual(["a", "b", "c"]);
        // The whole copy (what the resync brings) applies and ends the mark.
        apply("J", {
            ...(fake.chat("c", "k") as any),
            type: "resource",
            epoch: fake.store.epoch(),
            kind: "chats",
            streaming: [],
        });
        expect(ids()).toEqual(["a", "b", "c", "d"]);
        expect(chat.findChat(refK)!.note).toBe("missed");
        expect(chat.heldChatRevision(refK)).toBe(r2);
        expect(chat.idleChatRefreshes()).toEqual([]);
        // And the next patch from that copy applies.
        const r3 = serverWrite([{ op: "setText", id: "d", text: "D later" }]);
        expect(
            sync.applyPatchHydration(
                {
                    characterId: "c",
                    id: "k",
                    baseRevision: r2,
                    revision: r3,
                    messages: [{ after: "c", message: row("d") }],
                    count: 4,
                },
                { jobId: "J", streaming: [] },
            ),
        ).toBe("applied");
        expect(chat.heldChatRevision(refK)).toBe(r3);
    });

    it("keeps local work over a patch (`busy`, marked for a refresh) while releasing the locks the copy no longer lists; the refresh reads the chat whole once the work settled", async () => {
        const { fake, sync, chat, text, locked, apply, accepted, patchEvent, row, serverWrite } = await boot();
        apply("J", accepted("J", "g1"));
        chat.setChatMeta(refK, { note: "local note" });
        const r0 = fake.chat("c", "k")!.revision;
        const r1 = serverWrite([{ op: "setText", id: "b", text: "FINAL" }]);
        expect(
            sync.applyPatchHydration(
                {
                    characterId: "c",
                    id: "k",
                    baseRevision: r0,
                    revision: r1,
                    messages: [{ after: "a", message: row("b") }],
                    count: 3,
                },
                { jobId: "J", streaming: [] },
            ),
        ).toBe("busy");
        expect(text("b")).toBe("");
        expect(locked("b")).toBe(false);
        expect(chat.heldChatRevision(refK)).toBe(r0);
        // The local note lands on an older revision (a stale acknowledgement keeps the held revision
        // and the mark), and the same cycle's idle refresh then reads the chat whole: the job's text
        // arrives with the note kept. (A flush with nothing to send runs no cycle: see the DEFECTS below.)
        await sync.flushResources();
        expect(fake.chat("c", "k")!.data.note).toBe("local note");
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(1);
        expect(text("b")).toBe("FINAL");
        expect(chat.findChat(refK)!.note).toBe("local note");
        expect(chat.heldChatRevision(refK)).toBe(fake.chat("c", "k")!.revision);
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(fake.texts("c", "k")).toEqual(["A", "FINAL", "C"]);
    });

    it("ignores a patch of another epoch, one older than the held revision, one of an earlier incarnation, or an inverted one (`old`), and refuses one of a later incarnation (`mismatch`)", async () => {
        const { fake, sync, chat, ids } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        const job = { jobId: "J", streaming: [] };
        const body = { characterId: "c", id: "k", count: 3 };
        const otherEpoch = (token: string) => `22222222-2222-4333-8444-555555555555${token.slice(token.indexOf(":"))}`;
        expect(sync.applyPatchHydration({ ...body, baseRevision: otherEpoch(r0), revision: otherEpoch(r0) }, job)).toBe(
            "old",
        );
        expect(sync.applyPatchHydration({ ...body, baseRevision: bumped(r0, -1), revision: bumped(r0, -1) }, job)).toBe(
            "old",
        );
        expect(
            sync.applyPatchHydration(
                { ...body, baseRevision: earlierIncarnation(r0), revision: earlierIncarnation(r0) },
                job,
            ),
        ).toBe("old");
        expect(sync.applyPatchHydration({ ...body, baseRevision: bumped(r0, 2), revision: bumped(r0, 1) }, job)).toBe(
            "old",
        );
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.heldChatRevision(refK)).toBe(r0);
        // The chat was recreated on the server (a later incarnation): the mirror's copy is obsolete.
        expect(
            sync.applyPatchHydration(
                { ...body, baseRevision: laterIncarnation(r0), revision: laterIncarnation(r0) },
                job,
            ),
        ).toBe("mismatch");
        expect(chat.idleChatRefreshes()).toEqual([refK]);
        expect(ids()).toEqual(["a", "b", "c"]);
        expect(chat.heldChatRevision(refK)).toBe(r0);
    });

    it("refuses a patch that does not fit the mirror as a whole, changing nothing: an unknown anchor, a wrong count, a repeated row, a row of a removed id, or a row that would move a message", async () => {
        const { fake, sync, chat, ids } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        const job = { jobId: "J", streaming: [] };
        const d = m("d", "D");
        const bad = [
            { messages: [{ after: "zz", message: d }], count: 4 },
            { messages: [{ after: "c", message: d }], count: 5 },
            {
                messages: [
                    { after: "c", message: d },
                    { after: "d", message: d },
                ],
                count: 4,
            },
            { removed: ["b"], messages: [{ after: "a", message: m("b", "B") }], count: 3 },
            { messages: [{ after: "c", message: m("a", "A moved") }], count: 3 },
            { messages: [{ after: "a", message: { role: "user", data: "no id" } }], count: 4 },
        ];
        for (const body of bad) {
            const before = [...chat.findChat(refK)!.message];
            expect(chat.idleChatRefreshes()).toEqual([]);
            expect(
                sync.applyPatchHydration(
                    { characterId: "c", id: "k", baseRevision: r0, revision: r0, ...body } as any,
                    job,
                ),
                JSON.stringify(body),
            ).toBe("mismatch");
            expect(ids()).toEqual(["a", "b", "c"]);
            expect([...chat.findChat(refK)!.message]).toEqual(before);
            before.forEach((message, index) => expect(chat.findChat(refK)!.message[index]).toBe(message));
            expect(chat.heldChatRevision(refK)).toBe(r0);
            expect(chat.idleChatRefreshes()).toEqual([refK]);
            // Reset the mark with the whole copy (what the resync brings).
            expect(
                sync.applyHydration({
                    kind: "chats",
                    id: "k",
                    characterId: "c",
                    revision: r0,
                    data: fake.chat("c", "k")!.data,
                }),
            ).toBe(true);
        }
    });
});

// The fix round of the `chatPatch` change (Astra's challenge points 1 to 4): the recovery after a
// patch the mirror could not take. The send path (`runServerJob`: `flushResources`, then
// `refreshStaleChat`) brings a chat this tab knows is behind current before a job is created; a
// stale mark wakes the save loop even without a lock to release; a very large chat takes a patch
// without the list being read or rewritten whole. The transport's recovery (a `busy` copy saved,
// then `resync`) is covered in `src/ts/network/generationJobs.test.ts` over stubs; here the events
// are applied without a follow, so the send path is exercised alone.
describe("recovery after a refused chat patch", () => {
    /**
     * A reply streams while a local edit pends; the checkpoint patch is `busy`, the edit then lands on
     * an older revision (the held one stays), and the provider stalls: no further patch arrives. At the
     * end, the terminal patch is based on the refused checkpoint's copy, which the mirror never took:
     * a mismatch, and the job has ended.
     */
    async function stalledThenEnded() {
        const b = await boot();
        const { fake, sync, chat, apply, accepted, patchEvent, row, serverWrite } = b;
        apply("J", accepted("J", "g1"));
        const r0 = fake.chat("c", "k")!.revision;
        chat.setChatMeta(refK, { note: "local note" });
        const r1 = serverWrite([{ op: "setText", id: "b", text: "ONE" }]);
        apply(
            "J",
            patchEvent("J", [{ messageId: "b", generationId: "g1", seq: 1 }], {
                baseRevision: r0,
                revision: r1,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        await sync.flushResources();
        expect(fake.chat("c", "k")!.data.note).toBe("local note");
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(chat.isChatStale(refK)).toBe(true);
        expect(chat.isMessageLocked(refK, "b")).toBe(true);
        // A stalled provider: no checkpoint for a long while, and nothing reads the chat meanwhile
        // (the generation blocks the idle refresh).
        await vi.advanceTimersByTimeAsync(30_000);
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toEqual([]);
        // The end: the final write, the terminal patch from the last copy handed over, the result.
        const r3 = serverWrite([{ op: "setText", id: "b", text: "FINAL" }]);
        apply(
            "J",
            patchEvent("J", [], {
                baseRevision: r1,
                revision: r3,
                messages: [{ after: "a", message: row("b") }],
                count: 3,
            }),
        );
        apply("J", { type: "done", epoch: fake.store.epoch(), revision: r3, messageId: "b" });
        expect(chat.isMessageLocked(refK, "b")).toBe(false);
        return { ...b, r0, r3 };
    }

    it("the send path brings the chat current after a terminal mismatch: the flush alone has nothing to wait for, and `refreshStaleChat` then reads the chat whole, so the job names the server's revision", async () => {
        const { fake, sync, chat, text, r0, r3 } = await stalledThenEnded();
        // What `runServerJob` does before creating the job: the flush (nothing is owed: it runs no
        // cycle and the chat stays as it is), then the read of a chat known to be behind.
        await sync.flushResources();
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(chat.isChatBehind(refK)).toBe(true);
        expect(await sync.refreshStaleChat(refK)).toBe(true);
        expect(chat.heldChatRevision(refK)).toBe(r3);
        expect(text("b")).toBe("FINAL");
        expect(chat.findChat(refK)!.note).toBe("local note");
        expect(chat.isChatBehind(refK)).toBe(false);
        expect(chat.isChatStale(refK)).toBe(false);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(1);
        // Current: another call reads nothing.
        expect(await sync.refreshStaleChat(refK)).toBe(true);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(1);
    });

    it("without a send, the lock release at the end scheduled the idle refresh, which runs after the save loop's debounce", async () => {
        const { fake, chat, text, r3 } = await stalledThenEnded();
        expect(chat.heldChatRevision(refK)).not.toBe(r3);
        expect(text("b")).not.toBe("FINAL");
        await vi.advanceTimersByTimeAsync(1500);
        expect(chat.heldChatRevision(refK)).toBe(r3);
        expect(text("b")).toBe("FINAL");
        expect(fake.requests.some((request) => request.path === "/api/resources/read")).toBe(true);
    });

    it("`refreshStaleChat` reads nothing and answers false while the chat generates, answers false when a local change arrives during its read (the read is not taken), and true once the next read is taken", async () => {
        const { fake, sync, chat, text, apply, accepted, serverWrite } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        // Behind by a mismatched patch (which still lists the reply streaming: its lock stays), and
        // generating: not idle, so no read; still behind.
        apply("J", accepted("J", "g1"));
        const r1 = serverWrite([{ op: "setText", id: "a", text: "A1" }]);
        expect(
            sync.applyPatchHydration(
                { characterId: "c", id: "k", baseRevision: r1, revision: r1, count: 3 },
                { jobId: "J", streaming: [{ messageId: "b", generationId: "g1", seq: 0 }] },
            ),
        ).toBe("mismatch");
        expect(chat.isMessageLocked(refK, "b")).toBe(true);
        fake.requests.length = 0;
        expect(await sync.refreshStaleChat(refK)).toBe(false);
        expect(fake.requests).toEqual([]);
        expect(chat.heldChatRevision(refK)).toBe(r0);
        // The job ends: idle. A change typed while the read is in flight keeps the read out (local
        // work is never overwritten): false, and the chat is still behind.
        apply("J", { type: "done", epoch: fake.store.epoch(), revision: r1 });
        const reading = sync.refreshStaleChat(refK);
        chat.setChatMeta(refK, { note: "typed meanwhile" });
        expect(await reading).toBe(false);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(1);
        expect(text("a")).toBe("A");
        expect(chat.isChatBehind(refK)).toBe(true);
        // The second attempt of the send path: the change saved, then the read taken.
        await sync.flushResources();
        expect(await sync.refreshStaleChat(refK)).toBe(true);
        expect(text("a")).toBe("A1");
        expect(chat.findChat(refK)!.note).toBe("typed meanwhile");
        expect(chat.heldChatRevision(refK)).toBe(fake.chat("c", "k")!.revision);
        expect(chat.isChatBehind(refK)).toBe(false);
    });

    it("`refreshStaleChat` answers an unanswered live notice too: the noticed chat is read whole", async () => {
        const { fake, sync, chat, serverWrite } = await boot();
        const refJ = { chaId: "c", chatId: "j" };
        const revision = serverWrite([{ op: "meta", set: { name: "J renamed" } }], "j");
        expect(chat.noteRemoteChat(refJ, revision)).toBe("noticed");
        expect(chat.isChatStale(refJ)).toBe(false);
        expect(chat.isChatBehind(refJ)).toBe(true);
        expect(await sync.refreshStaleChat(refJ)).toBe(true);
        expect(chat.findChat(refJ)!.name).toBe("J renamed");
        expect(chat.heldChatRevision(refJ)).toBe(revision);
        expect(chat.isChatBehind(refJ)).toBe(false);
    });

    it("`chatHydrationHold` tells queued or in-flight work (saved by a flush) from work no save settles (a refusal for a generating message), and `isChatStale` a stale acknowledgement", async () => {
        const { fake, sync, chat, apply, accepted, serverWrite } = await boot();
        expect(chat.chatHydrationHold(refK)).toBe("none");
        expect(chat.isChatStale(refK)).toBe(false);
        chat.setChatMeta(refK, { note: "mine" });
        expect(chat.chatHydrationHold(refK)).toBe("saving");
        await sync.flushResources();
        expect(chat.chatHydrationHold(refK)).toBe("none");
        expect(chat.isChatStale(refK)).toBe(false);
        // A write landing on an older revision while the chat generates: a stale acknowledgement keeps
        // the held revision and marks the chat (nothing holds it: a save settled it).
        apply("J", accepted("J", "g1"));
        const r0 = fake.chat("c", "k")!.revision;
        serverWrite([{ op: "setText", id: "a", text: "theirs" }]);
        chat.setChatMeta(refK, { note: "later" });
        await sync.flushResources();
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(chat.isChatStale(refK)).toBe(true);
        expect(chat.chatHydrationHold(refK)).toBe("none");
        // A message edit refused for a generating message: held until the job ends.
        fake.lock!.addToken("T");
        fake.lock!.acquire({ ...B, messageId: "c" }, { jobId: "J", generationId: "g1", token: "T" });
        chat.setMessageText(refK, "c", "edited");
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(chat.chatHydrationHold(refK)).toBe("held");
        fake.lock!.endJob("T");
        await vi.advanceTimersByTimeAsync(5500);
        expect(fake.texts("c", "k")).toEqual(["theirs", "B", "edited"]);
        expect(chat.chatHydrationHold(refK)).toBe("none");
    });

    it("the end of a job that locked nothing wakes the save loop: the idle refresh reads a chat a terminal mismatch marked stale", async () => {
        const { fake, sync, chat, text, apply, serverWrite } = await boot();
        const r0 = fake.chat("c", "k")!.revision;
        // Another writer's change this tab has not seen (its live feed is down): the mirror holds r0.
        const r1 = serverWrite([{ op: "setText", id: "a", text: "theirs" }]);
        expect(
            sync.applyPatchHydration(
                { characterId: "c", id: "k", baseRevision: r1, revision: r1, count: 3 },
                { jobId: "J", streaming: [] },
            ),
        ).toBe("mismatch");
        apply("J", { type: "done", epoch: fake.store.epoch(), revision: r1 });
        expect(chat.heldChatRevision(refK)).toBe(r0);
        expect(chat.idleChatRefreshes()).toEqual([refK]);
        fake.requests.length = 0;
        await vi.advanceTimersByTimeAsync(1500);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(1);
        expect(text("a")).toBe("theirs");
        expect(chat.heldChatRevision(refK)).toBe(r1);
        expect(chat.isChatStale(refK)).toBe(false);
    });

    it("applies an empty equal-revision patch and an append on a very large chat without reading or rewriting the list: the earlier messages keep their objects", async () => {
        const { fake, sync, chat, serverWrite } = await boot();
        const count = 150_000;
        const big = Array.from({ length: count }, (_, index) => m(`m${index}`, "x"));
        const revision = serverWrite([{ op: "append", messages: big, anchor: { end: true } }], "j");
        const refJ = { chaId: "c", chatId: "j" };
        expect(
            sync.applyHydration({
                kind: "chats",
                id: "j",
                characterId: "c",
                revision,
                data: fake.chat("c", "j")!.data,
            }),
        ).toBe(true);
        const held = chat.findChat(refJ)!;
        expect(held.message).toHaveLength(count);
        const [first] = held.message;
        const last = held.message[count - 1];
        expect(
            sync.applyPatchHydration(
                { characterId: "c", id: "j", baseRevision: revision, revision, count },
                { jobId: "J", streaming: [] },
            ),
        ).toBe("applied");
        const next = bumped(revision, 1);
        expect(
            sync.applyPatchHydration(
                {
                    characterId: "c",
                    id: "j",
                    baseRevision: revision,
                    revision: next,
                    messages: [{ after: `m${count - 1}`, message: m("z", "Z", "char") }],
                    count: count + 1,
                },
                { jobId: "J", streaming: [] },
            ),
        ).toBe("applied");
        expect(chat.findChat(refJ)!.message).toHaveLength(count + 1);
        expect(chat.findChat(refJ)!.message[0]).toBe(first);
        expect(chat.findChat(refJ)!.message[count - 1]).toBe(last);
        expect(chat.findChat(refJ)!.message[count].chatId).toBe("z");
        expect(chat.heldChatRevision(refJ)).toBe(next);
    });

    it("places rows by their anchors (an insertion chain, a row after a replaced one, a removal before the anchor, a start insertion), takes removed ids the mirror lacks, and refuses a null anchor on a later row", async () => {
        const { fake, sync, chat, ids } = await boot();
        const job = { jobId: "J", streaming: [] };
        let held = fake.chat("c", "k")!.revision;
        /** A patch from the held revision to the next synthetic one (the planner reads only the mirror). */
        const step = (body: Partial<Parameters<typeof sync.applyPatchHydration>[0]> & { count: number }) => {
            const next = bumped(held, 1);
            const outcome = sync.applyPatchHydration(
                { characterId: "c", id: "k", baseRevision: held, revision: next, ...body },
                job,
            );
            if (outcome === "applied") {
                held = next;
            }
            return outcome;
        };
        const [a, b, c] = chat.findChat(refK)!.message;
        // A chain: e after the inserted d.
        expect(
            step({
                messages: [
                    { after: "c", message: m("d", "D") },
                    { after: "d", message: m("e", "E") },
                ],
                count: 5,
            }),
        ).toBe("applied");
        expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
        expect(chat.findChat(refK)!.message.slice(0, 3)).toEqual([a, b, c]);
        // A replaced row and an insertion anchored on it; the messages before it keep their objects.
        expect(
            step({
                messages: [
                    { after: "a", message: m("b", "B2") },
                    { after: "b", message: m("x", "X") },
                ],
                count: 6,
            }),
        ).toBe("applied");
        expect(ids()).toEqual(["a", "b", "x", "c", "d", "e"]);
        expect(chat.findChat(refK)!.message[0]).toBe(a);
        expect(chat.findChat(refK)!.message[3]).toBe(c);
        expect(chat.findChat(refK)!.message[1].data).toBe("B2");
        // A removal before the row's anchor, and one the mirror lacks (an equal-revision replay).
        expect(step({ removed: ["x", "gone"], messages: [{ after: "d", message: m("e", "E2") }], count: 5 })).toBe(
            "applied",
        );
        expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
        expect(chat.findChat(refK)!.message[4].data).toBe("E2");
        // A start insertion (the first row's null anchor); a null anchor on a later row does not fit.
        expect(step({ messages: [{ after: null, message: m("s", "S") }], count: 6 })).toBe("applied");
        expect(ids()).toEqual(["s", "a", "b", "c", "d", "e"]);
        expect(
            step({
                messages: [
                    { after: "e", message: m("f", "F") },
                    { after: null, message: m("t", "T") },
                ],
                count: 8,
            }),
        ).toBe("mismatch");
        expect(ids()).toEqual(["s", "a", "b", "c", "d", "e"]);
        expect(chat.heldChatRevision(refK)).toBe(held);
    });
});
