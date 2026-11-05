import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain, refK, warmMutationGraph } from "../storage/tests/mutationStoresHarness";
import type { StoreBackedServer } from "../storage/tests/storeBackedServer";

const io = vi.hoisted(() => ({ server: null as StoreBackedServer | null }));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => io.server!.fetch(path, init),
    }),
);
vi.mock("../alert", async () => (await import("../tests/alertMock")).createAlertMock());
vi.mock("../globalApi.svelte", async () => (await import("../tests/globalApiMock")).createGlobalApiMock());

let sync: typeof import("../storage/resourceSync.svelte") | undefined;
const unloadListeners = new Set<EventListenerOrEventListenerObject>();
beforeAll(() => warmMutationGraph(() => import("./rerollCandidates")));
beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        if (type === "beforeunload" && listener) unloadListeners.add(listener);
        add(type, listener, options);
    });
});
afterEach(() => {
    sync?.stopResourceSync();
    sync = undefined;
    for (const listener of unloadListeners) window.removeEventListener("beforeunload", listener);
    unloadListeners.clear();
    io.server?.close();
    io.server = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function boot() {
    const harness = await bootMutations((server) => (io.server = server));
    sync = harness.sync;
    const { fake, chat } = harness;
    fake.chatBatch([
        {
            characterId: "c",
            chatId: "k",
            baseRevision: fake.chat("c", "k")!.revision,
            ops: [
                {
                    op: "patchMessage",
                    id: "c",
                    set: {
                        data: "Second",
                        candidates: [
                            { id: "first", data: "First", scriptstateAfter: { $x: "1", $foreign: "1" } },
                            { id: "second", data: "Second", scriptstateAfter: { $x: "2", $foreign: "2" } },
                        ],
                        selected: 1,
                        scriptstateCheckpoint: { before: { $x: "0" }, after: { $x: "2", $foreign: "2" } },
                    },
                },
                { op: "meta", set: { scriptstate: { $x: "2", $foreign: "2" } } },
            ],
        },
    ]);
    chat.acceptRemoteChat(fake.chat("c", "k")!);
    fake.requests.length = 0;
    const candidates = await import("./rerollCandidates");
    return { ...harness, ...candidates, row: () => chat.findChat(refK)!.message.at(-1)! };
}

describe("candidate switching through the save adapter", () => {
    it("queues one stable-id switch with the mirror revision, applies it optimistically, and preserves the server's newer variable edit", async () => {
        const { fake, chat, sync, switchCandidate, row } = await boot();
        const revision = row().candidatesRevision!;
        expect(["a", "b", "c"].map((id) => chat.messagePositionOf(refK, id))).toEqual([0, 1, 2]);
        const positions = chat.messagePositionStats();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", merge: { scriptstate: { $foreign: "9" } } }],
            },
        ]);
        fake.holdNextBatch = true;
        const pending = switchCandidate(refK, "c", "first");
        try {
            expect(row()).toMatchObject({ data: "First", selected: 0, candidatesRevision: revision + 1 });
            expect(chat.messagePositionStats()).toEqual({ builds: positions.builds, lookups: positions.lookups + 1 });
            expect(["a", "b", "c"].map((id) => chat.messagePositionOf(refK, id))).toEqual([0, 1, 2]);
            expect(chat.messagePositionStats().builds).toBe(positions.builds);
            expect(plain(chat.findChat(refK)!.scriptstate)).toEqual({ $x: "1", $foreign: "1" });
            await vi.advanceTimersByTimeAsync(0);
            expect(fake.batchBodies().flatMap((body) => body.chats.flatMap((group: any) => group.ops))).toEqual([
                {
                    op: "selectCandidate",
                    messageId: "c",
                    candidateId: "first",
                    expect: { candidatesRevision: revision },
                },
            ]);
            expect(fake.releaseBatch).not.toBeNull();
        } finally {
            await vi.advanceTimersByTimeAsync(0);
            fake.releaseBatch?.();
            await pending;
        }
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(plain(chat.findChat(refK))).toEqual(fake.chat("c", "k")!.data);
        expect(plain(chat.findChat(refK)!.scriptstate)).toEqual({ $x: "1", $foreign: "9" });
    });

    it("switches to the previous candidate through the screen callback without rebuilding message positions", async () => {
        const { fake, chat, row } = await boot();
        let controls: { unReroll: () => Promise<void> } | undefined;
        const children = ["Chat", "Chats", "Suggestion", "CreatorQuote", "ContextMeter"].map(
            (name) => `../../lib/ChatScreens/${name}.svelte`,
        );
        for (const child of children)
            vi.doMock(child, () => ({
                default: (_anchor: unknown, props: typeof controls) => {
                    if (child.endsWith("/Chats.svelte")) controls = props;
                },
            }));
        const { mount, unmount, flushSync } = await import("svelte");
        const { settings } = await import("../storage/settingsViews.svelte");
        settings.ui.autoScrollToNewMessage = false;
        const { selectCharacter, selection } = await import("../storage/selection.svelte");
        selectCharacter("c");
        chat.selectChat("c", "k");
        selection.chatOpen = true;
        const target = document.createElement("div");
        document.body.append(target);
        let screen: ReturnType<typeof mount> | undefined;
        try {
            const { default: Screen } = await import("../../lib/ChatScreens/DefaultChatScreen.svelte");
            screen = mount(Screen, { target });
            flushSync();
            expect(controls).toBeDefined();
            expect(["a", "b", "c"].map((id) => chat.messagePositionOf(refK, id))).toEqual([0, 1, 2]);
            const positions = chat.messagePositionStats();
            const pending = controls!.unReroll();
            expect(row()).toMatchObject({ data: "First", selected: 0 });
            expect(chat.messagePositionStats()).toEqual({ builds: positions.builds, lookups: positions.lookups + 1 });
            expect(["a", "b", "c"].map((id) => chat.messagePositionOf(refK, id))).toEqual([0, 1, 2]);
            expect(chat.messagePositionStats().builds).toBe(positions.builds);
            await pending;
            expect(fake.batchBodies().flatMap((body) => body.chats.flatMap((group: any) => group.ops))).toEqual([
                { op: "selectCandidate", messageId: "c", candidateId: "first", expect: { candidatesRevision: 1 } },
            ]);
            expect(plain(chat.findChat(refK))).toEqual(fake.chat("c", "k")!.data);
        } finally {
            if (screen) await unmount(screen);
            target.remove();
            for (const child of children) vi.doUnmock(child);
        }
    });

    it("refuses a second switch until the first answer settles without queueing another operation", async () => {
        const { fake, sync, switchCandidate, row } = await boot();
        fake.holdNextBatchResponse = true;
        const pending = switchCandidate(refK, "c", "first").then(
            () => null,
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(0);
        const second = switchCandidate(refK, "c", "second").then(
            () => null,
            (error: unknown) => error,
        );
        try {
            expect(fake.releaseBatchResponse).not.toBeNull();
            expect(row()).toMatchObject({ data: "First", selected: 0 });
        } finally {
            fake.releaseBatchResponse?.();
            await pending;
        }
        expect(await pending).toBeNull();
        expect(await second).toBeInstanceOf(Error);
        await sync.flushResources();
        expect(fake.batchBodies().flatMap((body) => body.chats.flatMap((group: any) => group.ops))).toHaveLength(1);
    });

    it.each(["locked", "busy"])("refuses a %s chat before changing its mirror or queue", async (state) => {
        const { fake, chat, sync, switchCandidate } = await boot();
        const before = plain(chat.findChat(refK));
        const { beginLocalSend } = await import("./localSends");
        const release = state === "busy" ? beginLocalSend(refK) : null;
        if (state === "locked")
            chat.noteRemoteStreaming([
                { characterId: "c", id: "k", streaming: [{ messageId: "c", generationId: "G", seq: 0 }] },
            ]);
        try {
            await expect(switchCandidate(refK, "c", "first")).rejects.toThrow();
            expect(plain(chat.findChat(refK))).toEqual(before);
            await sync.flushResources();
            expect(fake.batchBodies()).toEqual([]);
            expect(chat.chatHasUnackedWork(refK)).toBe(false);
        } finally {
            release?.();
            chat.releaseFeedLocks();
        }
    });

    it("re-reads the current candidates after a stale switch is refused and never retries the old selection", async () => {
        const { fake, chat, sync, switchCandidate, row } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [
                    {
                        op: "patchMessage",
                        id: "c",
                        set: {
                            data: "Third",
                            candidates: [
                                ...fake.chat("c", "k")!.data.message.at(-1)!.candidates!,
                                { id: "third", data: "Third" },
                            ],
                            selected: 2,
                        },
                    },
                ],
            },
        ]);
        const remote = fake.chat("c", "k")!;
        await switchCandidate(refK, "c", "first");
        await sync.flushResources();
        expect(row()).toMatchObject({
            data: "Third",
            selected: 2,
            candidatesRevision: remote.data.message.at(-1)!.candidatesRevision,
        });
        expect(row().candidates!.map((candidate) => candidate.id)).toEqual(["first", "second", "third"]);
        expect(plain(chat.findChat(refK))).toEqual(remote.data);
        expect(
            fake.requests.some(
                (request) =>
                    request.path === "/api/resources/read" &&
                    request.body.chats?.some((entry: any) => entry.id === "k"),
            ),
        ).toBe(true);
        expect(fake.batchBodies().flatMap((body) => body.chats.flatMap((group: any) => group.ops))).toHaveLength(1);
        expect(chat.chatHasUnackedWork(refK)).toBe(false);
    });

    it("addresses neighboring candidates from a read and offers in-place reroll only for a one-reply tail", async () => {
        const { chat, rerollCarrier, neighborCandidateId } = await boot();
        const current = plain(chat.findChat(refK)) as NonNullable<ReturnType<typeof chat.findChat>>;
        const carrier = rerollCarrier(current)!;
        expect(carrier.chatId).toBe("c");
        expect(neighborCandidateId(carrier, -1)).toBe("first");
        expect(neighborCandidateId(carrier, 1)).toBeNull();
        expect(neighborCandidateId({ ...carrier, selected: 0 }, 1)).toBe("second");
        expect(neighborCandidateId({ ...carrier, selected: 0 }, -1)).toBeNull();
        expect(
            rerollCarrier({
                message: [...current.message, { role: "char", chatId: "comment", data: "note", isComment: true }],
            }),
        ).toEqual(carrier);
        expect(
            rerollCarrier({
                message: [...current.message, { role: "char", chatId: "second-reply", data: "another speaker" }],
            }),
        ).toBeNull();
        expect(
            rerollCarrier({ message: [...current.message, { role: "user", chatId: "next-user", data: "next" }] }),
        ).toBeNull();
    });
});
