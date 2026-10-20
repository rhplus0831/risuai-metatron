import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, refK } from "./mutationStoresHarness";

// Phase 4, slice 1: `beginMutationScope` and `flushResources({ scope })` (`resourceSync.svelte.ts`).
// The scope is a time window: the flush reports every key a conflict discarded since the scope
// began, whether the discard happened before the flush was called or during it, for resources and
// for chats, and including an unrelated write's discard (the documented conservative failure).
// Without a scope, `flushResources` reports only the discards since its own call.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
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

async function boot() {
    vi.resetModules();
    return bootMutations((fake) => {
        server.current = fake;
    });
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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

/** Another tab writes the `ui` record, so the next local `ui` save conflicts. */
function remoteThemeEdit(fake: any, theme: string) {
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, theme });
}

describe("beginMutationScope", () => {
    it("reports a discard raised by a cycle that ran before the flush was called, which a plain flush does not", async () => {
        const { fake, sync, collectionStore, settings } = await boot();
        const scope = sync.beginMutationScope();
        remoteThemeEdit(fake, "remote");
        collectionStore.updateSettings({ theme: "local" });
        // The debounced cycle runs, conflicts, and reloads the record before anyone flushes.
        await vi.advanceTimersByTimeAsync(600);
        await vi.waitFor(() => expect(settings.ui.theme).toBe("remote"));
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect((await sync.flushResources({ scope })).discarded).toEqual(["ui/main"]);
        expect(fake.record("ui", "main")!.data.theme).toBe("remote");
    });

    it("reports a discard raised by the flush's own batch, and an unrelated discard in the window", async () => {
        const { fake, sync, collectionStore, characterStore, record } = await boot();
        const scope = sync.beginMutationScope();
        fake.beforeNextBatch = () => remoteThemeEdit(fake, "remote");
        // The scoped writer changes a character; a settings edit made meanwhile is what conflicts.
        characterStore.updateCharacter("c", { desc: "mine" });
        collectionStore.updateSettings({ theme: "unrelated local" });
        const result = await sync.flushResources({ scope });
        expect(result.discarded).toEqual(["ui/main"]);
        expect(record("characters", "c").desc).toBe("mine");
        expect(record("ui").theme).toBe("remote");
        // A discard before the scope began is not in a later scope's report.
        const later = sync.beginMutationScope();
        collectionStore.updateSettings({ theme: "after" });
        expect((await sync.flushResources({ scope: later })).discarded).toEqual([]);
        expect(record("ui").theme).toBe("after");
    });

    it("covers the chat discard sequence too: a chat conflict before the flush is reported with the scope", async () => {
        const { fake, sync, chat, characterList } = await boot();
        const scope = sync.beginMutationScope();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        // A bulk removal needs the current revision: it conflicts and is discarded by the reload.
        chat.removeMessages(refK, ["b", "c"]);
        await vi.advanceTimersByTimeAsync(600);
        await vi.waitFor(() => expect((characterList()[0] as any).chats[0].note).toBe("remote"));
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect((await sync.flushResources({ scope })).discarded).toEqual(["chats/c/k"]);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
    });

    it("reports nothing for a scope whose window saw no conflict", async () => {
        const { sync, collectionStore, record } = await boot();
        const scope = sync.beginMutationScope();
        collectionStore.updateSettings({ theme: "quiet" });
        collectionStore.incrementStatic("messages");
        expect((await sync.flushResources({ scope })).discarded).toEqual([]);
        expect(record("ui").theme).toBe("quiet");
        expect(record("statics").messages).toBe(1);
    });
});
