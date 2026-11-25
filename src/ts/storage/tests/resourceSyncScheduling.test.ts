import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import type { StoreBackedServer } from "./storeBackedServer";

const { server, chatWork } = vi.hoisted(() => ({
    server: { current: null as StoreBackedServer | null },
    chatWork: {
        hasIdleRefresh: vi.fn(() => false),
        wake: null as (() => void) | null,
    },
}));

vi.mock("../serverAuth", async () =>
    (await import("./serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => server.current!.fetch(path, init),
    }),
);
vi.mock("../../alert", async () => (await import("../../tests/alertMock")).createAlertMock());
vi.mock("../chatStore.svelte", async () =>
    (await import("./chatStoreMock")).createChatStoreMock({
        hasIdleRefresh: chatWork.hasIdleRefresh,
        noteRemoteChat: vi.fn(() => "noticed"),
        setChatWorkListener: vi.fn((listener) => {
            chatWork.wake = listener;
        }),
    }),
);

async function boot() {
    vi.resetModules();
    vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    const harness = await bootMutations((fake) => {
        server.current = fake;
    });
    chatWork.hasIdleRefresh.mockClear();
    return harness;
}

beforeAll(() => warmMutationGraph(), 60_000);
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    chatWork.hasIdleRefresh.mockReturnValue(false);
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    server.current?.close();
});

describe("refresh scheduling", () => {
    it("reuses a pending refresh timer without probing work for every remote chat notice", async () => {
        const { sync, chat } = await boot();
        chatWork.hasIdleRefresh.mockReturnValue(true);
        for (const id of ["k", "j", "k", "j", "k", "j"]) {
            sync.noteRemoteChanges({
                resources: [],
                chats: [{ characterId: "c", id, revision: "remote" }],
                chatOrders: [],
            });
        }

        expect(chat.noteRemoteChat).toHaveBeenCalledTimes(6);
        expect(chatWork.hasIdleRefresh).toHaveBeenCalledTimes(1);
    });

    it("keeps the pending timer when an earlier refresh request finds no work", async () => {
        const { sync } = await boot();
        const timers = vi.spyOn(globalThis, "setTimeout");
        const cancel = vi.spyOn(globalThis, "clearTimeout");
        chatWork.hasIdleRefresh.mockReturnValue(true);
        chatWork.wake!();
        const pending = timers.mock.results[0].value;
        expect(timers.mock.calls[0][1]).toBe(SAVE_DEBOUNCE_MS);
        timers.mockClear();
        cancel.mockClear();
        chatWork.hasIdleRefresh.mockReturnValue(false).mockClear();

        sync.noteRemoteChanges({
            resources: [],
            chats: [{ characterId: "c", id: "k", revision: "remote" }],
            chatOrders: [],
        });

        expect(chatWork.hasIdleRefresh).toHaveBeenCalledTimes(1);
        expect(cancel).not.toHaveBeenCalledWith(pending);
        // Let the independent save cycle finish; the original refresh still wakes at its deadline.
        await vi.advanceTimersByTimeAsync(50);
        chatWork.hasIdleRefresh.mockClear();
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 50);
        expect(chatWork.hasIdleRefresh).toHaveBeenCalledTimes(1);
    });
});
