import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, refJ, refK } from "src/ts/storage/tests/mutationStoresHarness";

// Phase 4, slice 3 (`plugin-call-context`) against the real save adapter and the real server store
// (`storeBackedServer.ts`, the `v3SavedWrites.test.ts` harness): what a hook writes for its own
// chat and preset reaches the records those name. A `chatOutput` listener for a chat of a character
// that is not selected edits that character through `setCharacter` and the edit is saved (the
// non-selected character is marked); a hook's `setDatabase({ temperature })` after a preset switch
// lands in the hook's preset of the `presets` record; and the callback persistence contract of the
// canonical slice: a `beginMutationScope` + `flushResources({ scope })` pair around the hook reports
// a discard caused by a conflict during the hook (another tab wrote the `ui` record the hook's
// `setDatabaseLite({ theme })` also writes), and nothing when the hook's writes all persisted.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { server, alerts, captured } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    captured: { api: null as CapturedApi | null },
}));

vi.mock("src/ts/storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
// The real parser module installs a module-level `$effect.root` over `selIdState`, which is still
// uninitialized here because the two modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(apiFactory: CapturedApi) {
            captured.api = apiFactory;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
        terminate() {}
    },
}));
// The listener registration asks for the replacer permission: granted, without a prompt.
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(async () => undefined),
}));

/**
 * Boots the harness (a fresh module graph), loads the host API on that graph, captures the API
 * object of one plugin, and registers `hook` as its `chatOutput` listener. `runWith` invokes the
 * listener as the output-listener runner does, with a context `capture(ref)` captured earlier (the
 * send captures at its start); `run(ref)` captures at the call.
 */
async function boot(hook: (api: CapturedApi) => Promise<void>) {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const v3: typeof import("./v3.svelte") = await import("./v3.svelte");
    const context: typeof import("./pluginContext") = await import("./pluginContext");
    const pluginHooks: typeof import("../pluginHooks") = await import("../pluginHooks");
    pluginHooks.clearPluginHooks();
    captured.api = null;
    await v3.executePluginV3({ name: "plug", script: "", version: "3.0" } as any);
    expect(captured.api).not.toBeNull();
    const api = captured.api!;
    await api.addRisuChatListener("output", () => hook(api));
    expect(pluginHooks.pluginHooks.chatOutput.size).toBe(1);
    const [listener] = pluginHooks.pluginHooks.chatOutput;
    const capture = (ref: { chaId: string; chatId: string }) => context.capturePluginContext(ref);
    const runWith = (callContext: ReturnType<typeof capture>) =>
        context.invokeHook(listener, callContext, {
            char: {},
            chat: {},
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 0,
        });
    const run = (ref: { chaId: string; chatId: string }) => runWith(capture(ref));
    return { ...booted, api, capture, runWith, run };
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

describe("a hook's writes reach the records its context names", () => {
    it("setCharacter from a listener of a non-selected character's chat is saved to that character's record", async () => {
        const seen: Record<string, unknown> = {};
        const { run, sync, record, stores, db, fake } = await boot(async (api) => {
            const character = api.getCharacter();
            seen.chaId = character.chaId;
            seen.chatId = character.chats[character.chatPage].id;
            seen.chatIndex = api.getCurrentChatIndex();
            api.setCharacter({ ...character, desc: "listener wrote" });
        });
        expect(get(stores.selectedCharID)).toBe(-1);
        const before = record("characters", "c");

        await run(refJ);
        await sync.flushResources();

        expect(seen).toEqual({ chaId: "c", chatId: "j", chatIndex: 1 });
        expect(record("characters", "c")).toEqual({ ...before, desc: "listener wrote" });
        expect(db().characters[0].chatPage).toBe(0);
        // The chats are the chat module's: none was rewritten by the round trip.
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(fake.texts("c", "j")).toEqual([]);
        expect(fake.batchBodies().every((body: any) => (body.chats ?? []).length === 0)).toBe(true);
    });

    it("setDatabase({ temperature }) after a preset switch lands in the hook's preset of the presets record", async () => {
        const { capture, runWith, sync, record, selection, selectionModule } = await boot(async (api) => {
            await api.setDatabase({ temperature: 77 });
            api.setDatabaseLite({ maxContext: 4321 });
        });
        const hookPreset = selection.presetId;
        const other = record("presets").find((preset: any) => preset.id !== hookPreset).id;
        // The send captured its context; the user switches presets before the listener runs.
        const context = capture(refK);
        selectionModule.selectPreset(other);

        await runWith(context);
        await sync.flushResources();

        const presets = record("presets");
        expect(presets.find((preset: any) => preset.id === hookPreset)).toMatchObject({
            temperature: 77,
            maxContext: 4321,
        });
        expect(presets.find((preset: any) => preset.id === other).temperature).not.toBe(77);
        expect(presets.find((preset: any) => preset.id === other).maxContext).not.toBe(4321);
        expect(selection.presetId).toBe(other);
    });
});

describe("the callback persistence contract (beginMutationScope + flushResources({ scope }))", () => {
    it("reports a discard caused by a conflict during the hook, and the mirror holds the server's value", async () => {
        const { run, sync, record, fake, db } = await boot(async (api) => {
            // Another tab writes the `ui` record while the hook runs; the hook's write then conflicts.
            fake.set("ui", "main", { ...fake.record("ui", "main")!.data, theme: "remote" });
            api.setDatabaseLite({ theme: "from the hook" });
        });
        const scope = sync.beginMutationScope();
        await run(refK);
        const result = await sync.flushResources({ scope });
        expect(result.discarded).toEqual(["ui/main"]);
        expect(record("ui").theme).toBe("remote");
        expect(db().theme).toBe("remote");
    });

    it("reports nothing when the hook's writes all persisted", async () => {
        const { run, sync, record, characterStore } = await boot(async (api) => {
            api.setDatabaseLite({ theme: "quiet" });
            api.setCharacter({ ...api.getCharacter(), desc: "quiet too" });
        });
        const scope = sync.beginMutationScope();
        await run(refJ);
        expect((await sync.flushResources({ scope })).discarded).toEqual([]);
        expect(record("ui").theme).toBe("quiet");
        expect(record("characters", "c").desc).toBe("quiet too");
        expect((characterStore.findCharacter("c") as any).desc).toBe("quiet too");
    });
});
