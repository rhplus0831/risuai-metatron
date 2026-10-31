import type { TransformMode, TransformRequest, TransformContinueRequest } from "../../../../shared/transform.ts";
import type { ChannelAnswer } from "../../../../shared/jobs.ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, refJ, refK, warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";

// The plugin call context against the real save adapter and the real server store
// (`storeBackedServer.ts`, the `v3SavedWrites.test.ts` harness): what a hook writes for its own
// chat and preset reaches the records those name. A `chatOutput` listener for a chat of a character
// that is not selected edits that character through `setCharacter` and the edit is saved (the
// non-selected character is marked); a hook's `setDatabase({ temperature })` after a preset switch
// lands in the hook's preset of the `presets` record; and the callback persistence contract: a
// `beginMutationScope` + `flushResources({ scope })` pair around the hook reports a discard caused
// by a conflict during the hook (another tab wrote the `ui` record the hook's
// `setDatabaseLite({ theme })` also writes), and nothing when the hook's writes all persisted.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { server, alerts, captured } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    captured: { api: null as CapturedApi | null },
}));

vi.mock("src/ts/storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        saveAsset: vi.fn(async () => "assets/saved.png"),
    }),
);
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
 * send captures at its start); `run(ref)` captures at the call. Script tests register through the
 * real API wrapper and run through either the transform continuation or the job-channel dispatcher.
 * Only transform HTTP responses are doubled; saves still reach the store-backed server.
 */
async function boot(hook: (api: CapturedApi) => Promise<void> = async () => {}) {
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
    const transform = await import("src/ts/parser/transformClient");
    const channel = await import("src/ts/network/jobChannel");
    server.current = {
        close: () => booted.fake.close(),
        fetch: (path: string, init?: RequestInit) => {
            if (path === "/api/transform") {
                const body = JSON.parse(init!.body as string) as TransformRequest;
                expect(body.handlers).toBeTruthy();
                return Response.json({
                    results: [],
                    snapshotId: "snapshot",
                    pending: body.targets.map((target) => ({ id: target.id, text: target.source })),
                });
            }
            if (path === "/api/transform/continue") {
                const body = JSON.parse(init!.body as string) as TransformContinueRequest;
                return Response.json({
                    results: body.texts.map((entry) =>
                        "error" in entry
                            ? { ...entry, ok: false }
                            : { ...entry, ok: true, key: "handled", emotions: [], cached: false },
                    ),
                });
            }
            return booted.fake.fetch(path, init);
        },
    };
    const registerScript = (mode: TransformMode, handler: (text: string) => Promise<string>) =>
        api.addRisuScriptHandler(mode === "editdisplay" ? "display" : "process", handler);
    const startTransform = async (mode: TransformMode = "editdisplay") => {
        const captured = transform.captureTransform(0, { chatRef: refK });
        expect(captured).not.toBeNull();
        const result = transform.serverProcessScript(
            booted.stores.createSimpleCharacter(booted.characterList()[0]),
            "input",
            mode,
            0,
            {},
            captured!,
            "message",
        );
        await vi.advanceTimersByTimeAsync(16);
        return { result };
    };
    let callbackId = 0;
    const runJob = (name: "editdisplay" | "chatOutput" = "editdisplay") => {
        const received = deferred<ChannelAnswer>();
        channel.handleChannelEvent(
            "job",
            {
                type: "callback",
                epoch: booted.fake.store.epoch(),
                jobId: "job",
                id: `callback-${++callbackId}`,
                name,
                targets: capture(refK)!,
                revisions: [],
                payload: { text: "input", speakerId: "c", messageId: "c" },
                deadline: Date.now() + 60_000,
            },
            {
                send: (message) => {
                    if (message.type === "answer") received.resolve(message);
                    return true;
                },
            },
        );
        return received.promise;
    };
    return { ...booted, api, capture, runWith, run, registerScript, startTransform, runJob };
}

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeAll(
    () =>
        warmMutationGraph(() =>
            Promise.all([import("./v3.svelte"), import("./pluginContext"), import("../pluginHooks")]),
        ),
    60_000,
);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);
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
        const { run, sync, record, selectionModule, characterList, fake } = await boot(async (api) => {
            const character = await api.getCharacter();
            seen.chaId = character.chaId;
            seen.chatId = character.chats[character.chatPage].id;
            seen.chatIndex = api.getCurrentChatIndex();
            await api.setCharacter({ ...character, desc: "listener wrote" });
        });
        expect(selectionModule.selectedIndex()).toBe(-1);
        const before = record("characters", "c");

        await run(refJ);
        await sync.flushResources();

        expect(seen).toEqual({ chaId: "c", chatId: "j", chatIndex: 1 });
        expect(record("characters", "c")).toEqual({ ...before, desc: "listener wrote" });
        expect((characterList()[0] as any).chatPage).toBe(0);
        // The chats are the chat module's: none was rewritten by the round trip.
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(fake.texts("c", "j")).toEqual([]);
        expect(fake.batchBodies().every((body: any) => (body.chats ?? []).length === 0)).toBe(true);
    });

    it("setDatabase({ temperature, maxContext }) after a switch of both presets lands in the hook's prompt preset and model preset's main profile records", async () => {
        const { capture, runWith, sync, record, selection, selectionModule, collectionStore } = await boot(
            async (api) => {
                await api.setDatabase({ temperature: 77 });
                await api.setDatabaseLite({ maxContext: 4321 });
            },
        );
        const hookPreset = selection.presetId;
        const hookModelPreset = selection.modelPresetId;
        const other = record("presets").find((preset: any) => preset.id !== hookPreset).id;
        const otherModel = record("modelPresets").find((preset: any) => preset.id !== hookModelPreset).id;
        // `maxContext` is the main profile's: the other model preset
        // gets a main profile of its own, so the two model presets do not share the written record.
        const hookProfile = record("modelPresets").find((preset: any) => preset.id === hookModelPreset).mainSlot
            .profileId;
        const otherProfile = collectionStore.addModelProfile({ name: "Other" });
        collectionStore.setMainModelSlot(otherModel, otherProfile);
        // The send captured its context; the user switches both presets before the listener runs.
        const context = capture(refK);
        expect(context).toMatchObject({ presetId: hookPreset, modelPresetId: hookModelPreset });
        selectionModule.selectPreset(other);
        selectionModule.selectModelPreset(otherModel);

        await runWith(context);
        await sync.flushResources();

        const presets = record("presets");
        expect(presets.find((preset: any) => preset.id === hookPreset)).toMatchObject({ temperature: 77 });
        expect(presets.find((preset: any) => preset.id === other).temperature).not.toBe(77);
        const profiles = record("modelProfiles");
        expect(profiles.find((profile: any) => profile.id === hookProfile)).toMatchObject({ maxContext: 4321 });
        expect(profiles.find((profile: any) => profile.id === otherProfile).maxContext).not.toBe(4321);
        expect(presets.every((preset: any) => !("maxContext" in preset))).toBe(true);
        expect(selection.presetId).toBe(other);
        expect(selection.modelPresetId).toBe(otherModel);
    });
});

describe("the callback persistence contract (beginMutationScope + flushResources({ scope }))", () => {
    it("reports a discard caused by a conflict during the hook, and the mirror holds the server's value", async () => {
        const { run, sync, record, fake, settings } = await boot(async (api) => {
            // Another tab writes the `ui` record while the hook runs; the hook's write then conflicts.
            fake.set("ui", "main", { ...fake.record("ui", "main")!.data, theme: "remote" });
            await api.setDatabaseLite({ theme: "from the hook" });
        });
        const scope = sync.beginMutationScope();
        await run(refK);
        const result = await sync.flushResources({ scope });
        expect(result.discarded).toEqual(["ui/main"]);
        expect(record("ui").theme).toBe("remote");
        expect(settings.ui.theme).toBe("remote");
    });

    it("reports nothing when the hook's writes all persisted", async () => {
        const { run, sync, record, characterStore } = await boot(async (api) => {
            await api.setDatabaseLite({ theme: "quiet" });
            await api.setCharacter({ ...(await api.getCharacter()), desc: "quiet too" });
        });
        const scope = sync.beginMutationScope();
        await run(refJ);
        expect((await sync.flushResources({ scope })).discarded).toEqual([]);
        expect(record("ui").theme).toBe("quiet");
        expect(record("characters", "c").desc).toBe("quiet too");
        expect((characterStore.findCharacter("c") as any).desc).toBe("quiet too");
    });
});

describe("script handlers in transform continuations", () => {
    it.each(["editdisplay", "editprocess"] as const)(
        "%s leaves the saved character unchanged while private storage and own arguments persist",
        async (mode) => {
            const b = await boot();
            const before = b.record("characters", "c");
            await b.registerScript(mode, async (text) => {
                const character = await b.api.getCharacter();
                await b.api.setCharacter({ ...character, desc: "persisted by transform" });
                await b.api._setPluginStorage("private", { count: 1 });
                await b.api.setArgument("a", "own argument");
                await b.api.setArg("plug::legacy", "own legacy argument");
                return `${text} handled`;
            });
            const { result } = await b.startTransform(mode);
            expect(await result).toMatchObject({ data: "input handled" });
            await b.sync.flushResources();
            expect(b.record("characters", "c")).toEqual(before);
            expect(b.record("pluginStorage")._pluginStorage.private).toEqual({ count: 1 });
            expect(b.record("plugins").find((plugin: any) => plugin.name === "plug").realArg).toMatchObject({
                a: "own argument",
                legacy: "own legacy argument",
            });
            expect(console.warn).toHaveBeenCalled();
        },
    );

    it("refuses durable setters with warnings and non-throwing return values", async () => {
        const b = await boot();
        b.collectionStore.upsertPlugin({ name: "other", realArg: { a: "original" } } as any);
        await b.sync.flushResources();
        const before = b.serverText();
        const returns: Record<string, unknown> = {};
        await b.registerScript("editdisplay", async (text) => {
            const character = await b.api.getCharacter();
            const calls: Record<string, () => unknown> = {
                setChar: () => b.api.setChar({ ...character, desc: "refused" }),
                setCharacterToIndex: () => b.api.setCharacterToIndex(0, { ...character, desc: "refused" }),
                setChatToIndex: () => b.api.setChatToIndex(0, 0, { ...character.chats[0], note: "refused" }),
                setDatabase: () => b.api.setDatabase({ theme: "refused", custom: "refused" }),
                setDatabaseLite: () => b.api.setDatabaseLite({ theme: "refused", custom: "refused" }),
                changeColorScheme: () => b.api.changeColorScheme("light"),
                setColorScheme: () => b.api.setColorScheme({}),
                changeTextTheme: () => b.api.changeTextTheme("highcontrast"),
                setCustomTextTheme: () => b.api.setCustomTextTheme({}),
                checkCharOrder: () => b.api.checkCharOrder(),
                setArg: () => b.api.setArg("other::a", "refused"),
                sendChat: () => b.api.sendChat("refused"),
                saveAsset: () => b.api.saveAsset(new Uint8Array([1, 2, 3])),
            };
            for (const [name, call] of Object.entries(calls)) {
                const warnings = vi.mocked(console.warn).mock.calls.length;
                returns[name] = await call();
                expect(vi.mocked(console.warn).mock.calls.length, `${name} must warn`).toBeGreaterThan(warnings);
            }
            return `${text} handled`;
        });
        const { result } = await b.startTransform();
        expect(await result).toMatchObject({ data: "input handled" });
        expect(returns).toMatchObject({ sendChat: false, saveAsset: "" });
        await b.sync.flushResources();
        expect(b.serverText()).toBe(before);
    });

    it("parses CBS in a transform without saving variable writes even with runVar enabled", async () => {
        const b = await boot();
        b.chat.setChatMeta(refK, { scriptstate: { $guarded: "saved" } });
        await b.sync.flushResources();
        await b.registerScript("editdisplay", async () => {
            await b.api.parseRisuChat("{{setvar::guarded::changed}}", { runVar: true });
            return b.api.parseRisuChat("{{getvar::guarded}}");
        });
        const { result } = await b.startTransform();
        const parsed = await result;
        await b.sync.flushResources();
        expect(b.fake.chat("c", "k")!.data.scriptstate).toEqual({ $guarded: "saved" });
        expect(parsed).toMatchObject({ data: "saved" });
    });

    it("allows the same registered display handler to save through a job-channel callback", async () => {
        const b = await boot();
        await b.registerScript("editdisplay", async (text) => {
            await b.api.setCharacter({ ...(await b.api.getCharacter()), desc: "written by job" });
            return `${text} handled`;
        });
        expect(await b.runJob()).toMatchObject({ outcome: "answered", value: "input handled" });
        await b.sync.flushResources();
        expect(b.record("characters", "c").desc).toBe("written by job");
    });

    it("refuses writes while a transform is active beneath an overlapping writable hook and permits them after it ends", async () => {
        const releaseTransform = deferred();
        const transformEntered = deferred();
        const releaseJob = deferred();
        const jobEntered = deferred();
        const b = await boot(async (api) => {
            jobEntered.resolve();
            await releaseJob.promise;
            await api.setCharacter({ ...(await api.getCharacter()), desc: "written after transform" });
        });
        const before = b.record("characters", "c");
        await b.registerScript("editdisplay", async (text) => {
            transformEntered.resolve();
            await releaseTransform.promise;
            return `${text} handled`;
        });
        const { result } = await b.startTransform();
        await transformEntered.promise;
        const job = b.runJob("chatOutput");
        await jobEntered.promise;
        // This instance's innermost context is now writable, while its transform is still alive.
        await b.api.setCharacter({ ...(await b.api.getCharacter()), desc: "escaped through inner hook" });
        await b.sync.flushResources();
        expect(b.record("characters", "c")).toEqual(before);
        expect(console.warn).toHaveBeenCalled();
        releaseTransform.resolve();
        expect(await result).toMatchObject({ data: "input handled" });
        releaseJob.resolve();
        expect(await job).toMatchObject({ outcome: "answered" });
        await b.sync.flushResources();
        expect(b.record("characters", "c").desc).toBe("written after transform");
    });
});
