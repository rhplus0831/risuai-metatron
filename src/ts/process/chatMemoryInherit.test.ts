// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sealHypaV3Data, type MemoryReceipt } from "../../../shared/structuredMemory.ts";
import type { Chat } from "../../../shared/database.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";

const { authFetch, flushResources, alertError } = vi.hoisted(() => ({
    authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
    flushResources: vi.fn<typeof import("../storage/resourceSync.svelte").flushResources>(),
    alertError: vi.fn<typeof import("../alert").alertError>(),
}));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch }),
);
vi.mock("../alert", async () => (await import("../tests/alertMock")).createAlertMock({ alertError }));
// Script only the save boundary; the chat queue, scope, error class, settings and route client stay real.
vi.mock("../storage/resourceSync.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../storage/resourceSync.svelte")>()),
    flushResources,
}));

const source = { chaId: "character/문", chatId: "source/chat" };
const input: Chat = {
    id: source.chatId, // A copy's colliding id is replaced by the real createChat.
    name: "Copied story",
    note: "",
    localLore: [],
    message: [{ chatId: "m", role: "char", data: "At the gate" }],
};
const saved: Awaited<ReturnType<typeof flushResources>> = { discarded: [], refused: [] };
type Modules = {
    inherit: typeof import("./chatMemoryInherit.svelte");
    chat: typeof import("../storage/chatStore.svelte");
    sync: typeof import("../storage/resourceSync.svelte");
    client: typeof import("../storage/resourceClient");
    views: typeof import("../storage/settingsViews.svelte");
    language: typeof import("../../lang").language;
};
let m: Modules;

async function load(): Promise<Modules> {
    return {
        inherit: await import("./chatMemoryInherit.svelte"),
        chat: await import("../storage/chatStore.svelte"),
        sync: await import("../storage/resourceSync.svelte"),
        client: await import("../storage/resourceClient"),
        views: await import("../storage/settingsViews.svelte"),
        language: (await import("../../lang")).language,
    };
}
beforeAll(async () => {
    await load();
}, 60_000);
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    authFetch.mockReset().mockResolvedValue(Response.json({ revision: "memory-r1", inherited: true }));
    flushResources.mockReset().mockResolvedValue(saved);
    alertError.mockReset();
    m = await load();
    m.client.setResourceEpoch("epoch");
    (await import("../storage/tests/installFlatDatabase")).installFlatDatabaseWithChats({
        memoryAlgorithmType: "structuredMemory",
        characters: [{ chaId: source.chaId, name: "Character", type: "character", chats: [structuredClone(input)] }],
    });
    m.chat.seedChats(
        [{ characterId: source.chaId, id: source.chatId, revision: "epoch:1:1" }],
        [{ characterId: source.chaId, ids: [source.chatId], revision: "epoch:3:1" }],
    );
});
afterEach(() => {
    m.client.setEpochMismatchListener(null);
    vi.clearAllTimers();
    vi.useRealTimers();
});

function create() {
    return m.inherit.createInheritingChat(source, input, { index: 0, select: true });
}
/** The scripted save loop acknowledges the real queue, just as a server response would. */
function acknowledgeCreate() {
    const work = m.chat.takeChatWork(new Set());
    m.chat.ackChatWork(
        work,
        work.groups.map(({ characterId, chatId }) => ({ characterId, id: chatId, revision: "epoch:2:1" })),
        work.orders.map(({ characterId, ids }) => ({ characterId, ids, revision: "epoch:3:1" })),
    );
}
const settle = () => vi.advanceTimersByTimeAsync(0);
function expectRequest(chatId: string) {
    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe(`/api/memory/structured/character%2F%EB%AC%B8/${encodeURIComponent(chatId)}/inherit`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ sourceChatId: source.chatId });
    expect(new Headers(init?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
}

it("creates immediately but asks inheritance only after saving, using the created id and no records under another algorithm", async () => {
    m.views.settings.ui.memoryAlgorithmType = "hypaMemoryV3";
    let finish!: (result: typeof saved) => void;
    flushResources.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const created = create();
    expect(created.id).not.toBe(source.chatId);
    expect(m.chat.findChat({ chaId: source.chaId, chatId: created.id! })?.message).toEqual(input.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(authFetch).not.toHaveBeenCalled();
    acknowledgeCreate();
    // An unrelated discarded chat must not prevent this copy from inheriting.
    finish({ discarded: ["chats/other/unrelated"], refused: [] });
    await settle();
    expectRequest(created.id!);
    expect(alertError).not.toHaveBeenCalled();
});

it("waits for a generation-blocked create to be acknowledged before asking inheritance", async () => {
    flushResources.mockRejectedValueOnce(new m.sync.GenerationBlockedError([]));
    const created = create();
    await vi.advanceTimersByTimeAsync(249);
    expect(authFetch).not.toHaveBeenCalled();
    expect(alertError).not.toHaveBeenCalled();
    acknowledgeCreate();
    await vi.advanceTimersByTimeAsync(1);
    expectRequest(created.id!);
    expect(alertError).not.toHaveBeenCalled();
});

it("bounds a generation-blocked wait and asks the route even if the create remains unacknowledged", async () => {
    flushResources.mockRejectedValueOnce(new m.sync.GenerationBlockedError([]));
    const created = create();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(authFetch).not.toHaveBeenCalled();
    expect(alertError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expectRequest(created.id!);
    expect(alertError).not.toHaveBeenCalled();
});

it.each(["discarded", "refused", "failed"] as const)(
    "keeps the created chat and reports a %s save without asking inheritance",
    async (failure) => {
        flushResources.mockImplementationOnce(async () => {
            if (failure === "failed") throw new Error("Save offline");
            const created = m.chat.chatList(source.chaId).find(({ id }) => id !== source.chatId)!;
            return { ...saved, [failure]: [`chats/${source.chaId}/${created.id}`] };
        });
        const created = create();
        await settle();
        expect(authFetch).not.toHaveBeenCalled();
        expect(alertError).toHaveBeenCalledExactlyOnceWith(m.language.structuredMemory.inherit.failed(created.name));
        expect(m.chat.findChat({ chaId: source.chaId, chatId: created.id! })?.message).toEqual(input.message);
        expect(m.chat.findChat(source)?.message).toEqual(input.message);
    },
);

it.each([
    { algorithm: "structuredMemory", status: 503, notice: true },
    { algorithm: "hypaMemoryV3", status: 503, notice: false },
    { algorithm: "structuredMemory", status: 409, notice: true },
    { algorithm: "structuredMemory", status: 412, notice: false },
] as const)(
    "handles $status under $algorithm with inheritance notice=$notice and no retry",
    async ({ algorithm, status, notice }) => {
        m.views.settings.ui.memoryAlgorithmType = algorithm;
        const epochNotice = vi.fn();
        m.client.setEpochMismatchListener(epochNotice);
        authFetch.mockResolvedValueOnce(
            Response.json(
                status === 412
                    ? { error: "EpochMismatch", epoch: "new-epoch" }
                    : status === 409
                      ? { error: "Busy", reason: "fenced" }
                      : { error: "Unavailable" },
                { status },
            ),
        );
        const created = create();
        await vi.advanceTimersByTimeAsync(60_000);
        expectRequest(created.id!);
        expect(alertError.mock.calls).toEqual(
            notice ? [[m.language.structuredMemory.inherit.failed(created.name)]] : [],
        );
        expect(epochNotice).toHaveBeenCalledTimes(status === 412 ? 1 : 0);
        expect(m.chat.findChat({ chaId: source.chaId, chatId: created.id! })?.message).toEqual(input.message);
    },
);

it.each(["acknowledged", "still queued"])(
    "restores a generation-blocked import after its create is %s",
    async (end) => {
        m.views.settings.ui.memoryAlgorithmType = "hypaMemoryV3";
        flushResources.mockRejectedValueOnce(new m.sync.GenerationBlockedError([]));
        authFetch.mockResolvedValueOnce(Response.json({ revision: "restored", restored: true }));
        const scope = m.sync.beginMutationScope();
        const created = m.chat.createChat(source.chaId, input, { index: 0 });
        const records = {
            pages: [],
            events: [],
            threads: [{ id: "t", title: "Return", who: [], state: "open" as const }],
        };
        m.inherit.restoreChatMemory(source.chaId, [{ chatId: created.id!, name: created.name, records }], scope);
        await vi.advanceTimersByTimeAsync(end === "acknowledged" ? 249 : 29_999);
        expect(authFetch).not.toHaveBeenCalled();
        expect(alertError).not.toHaveBeenCalled();
        if (end === "acknowledged") acknowledgeCreate();
        await vi.advanceTimersByTimeAsync(1);
        expect(authFetch).toHaveBeenCalledExactlyOnceWith(
            `/api/memory/structured/character%2F%EB%AC%B8/${encodeURIComponent(created.id!)}/restore`,
            expect.objectContaining({ method: "POST", body: JSON.stringify(records) }),
        );
        expect(new Headers(authFetch.mock.calls[0][1]?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
        expect(m.chat.findChat({ chaId: source.chaId, chatId: created.id! })?.message).toEqual(input.message);
        expect(alertError).not.toHaveBeenCalled();
    },
);

it("keeps imports whose create was discarded, refused or failed and reports them without restoring", async () => {
    const scope = m.sync.beginMutationScope();
    const created = ["Discarded", "Refused", "Offline"].map((name) =>
        m.chat.createChat(source.chaId, { ...input, name }),
    );
    flushResources
        .mockResolvedValueOnce({ discarded: [`chats/${source.chaId}/${created[0].id}`], refused: [] })
        .mockResolvedValueOnce({ discarded: [], refused: [`chats/${source.chaId}/${created[1].id}`] })
        .mockRejectedValueOnce(new Error("Offline"));
    m.inherit.restoreChatMemory(
        source.chaId,
        created.map(({ id, name }) => ({
            chatId: id!,
            name,
            records: { pages: [], events: [], threads: [{ id: "t", title: "Return", who: [], state: "open" }] },
        })),
        scope,
    );
    await settle();
    expect(authFetch).not.toHaveBeenCalled();
    expect(alertError).toHaveBeenCalledExactlyOnceWith(
        m.language.structuredMemory.memoryFile.restoreFailed("Discarded, Refused, Offline"),
    );
    for (const { id } of created)
        expect(m.chat.findChat({ chaId: source.chaId, chatId: id! })?.message).toEqual(input.message);
});

it("copies and branches without carrying a projection into the new chat or its create request", async () => {
    const { alertToast } = await import("../alert");
    vi.mocked(alertToast).mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
        for (const message of [input.message, []]) {
            const created = m.inherit.createInheritingChat(
                source,
                {
                    ...input,
                    message,
                    hypaV3Data: sealHypaV3Data({
                        summaries: [{ text: "Projected", chatMemos: ["m"], isImportant: true }],
                    }),
                },
                {},
            );
            expect(created).not.toHaveProperty("hypaV3Data");
            expect(created.message).toEqual(message);
            const work = m.chat.takeChatWork(new Set());
            expect(work.groups.find((group) => group.chatId === created.id)!.ops[0]).toMatchObject({ op: "create" });
            expect(JSON.stringify(m.chat.chatWorkBody(work))).not.toContain("hypaV3Data");
            await settle();
        }
        expect(alertToast).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    } finally {
        warn.mockRestore();
    }
});

it("copies and branches without message or candidate memory receipts, preserving other fields and the caller's input", async () => {
    const retainedMessages: Chat["message"] = [
        {
            chatId: "reply",
            role: "char",
            data: "The gate opens",
            name: "Gatekeeper",
            saying: "gatekeeper",
            time: 123,
            generationInfo: {
                model: "reply-model",
                generationId: "reply-generation",
                inputTokens: 30,
                outputTokens: 12,
                maxContext: 4096,
                stageTiming: { stage1: 2, stage4: 9 },
            },
            promptInfo: { promptName: "Story" },
            candidates: [
                {
                    id: "closed",
                    data: "The gate stays closed",
                    generationInfo: { model: "first-model", inputTokens: 20, outputTokens: 8 },
                    promptInfo: { promptName: "First attempt" },
                    scriptstateAfter: { $gate: "closed" },
                },
                {
                    id: "open",
                    data: "The gate opens",
                    generationInfo: { model: "second-model", generationId: "second-generation", outputTokens: 12 },
                    scriptstateAfter: { $gate: "open" },
                },
            ],
            selected: 1,
            candidatesRevision: 4,
            scriptstateCheckpoint: { before: { $gate: "closed" }, after: { $gate: "open" } },
        },
        { chatId: "question", role: "user", data: "What is beyond the gate?", disabled: false },
    ];
    const receipt: MemoryReceipt = {
        state: "skipped",
        reason: "writerPaused",
        runId: "source-run",
        pages: [],
        refused: [],
        unverified: [],
        warnings: [],
    };
    const retained = retainedMessages;
    const copied: Chat = {
        ...input,
        message: retained.map((message) =>
            message.generationInfo
                ? {
                      ...message,
                      generationInfo: { ...message.generationInfo, memory: receipt },
                      candidates: message.candidates!.map((candidate) => ({
                          ...candidate,
                          generationInfo: { ...candidate.generationInfo, memory: receipt },
                      })),
                  }
                : { ...message },
        ),
    };
    const original = structuredClone(copied);
    const created = m.inherit.createInheritingChat(source, copied, {});
    expect(copied).toStrictEqual(original);
    expect(m.chat.findChat({ chaId: source.chaId, chatId: created.id! })?.message).toStrictEqual(retained);
    const work = m.chat.takeChatWork(new Set());
    const body = m.chat.chatWorkBody(work).chats.map((chat) => JSON.parse(chat));
    expect(body.find(({ chatId }) => chatId === created.id)?.ops).toEqual([
        expect.objectContaining({ op: "create", chat: expect.objectContaining({ message: retained }) }),
    ]);
    await settle();
    expect(copied).toStrictEqual(original);
});
