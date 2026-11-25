import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { RisuPlugin } from "./plugins.svelte";

type Api = Record<string, (...args: any[]) => any>;
const harness = vi.hoisted(() => ({
    hosts: [] as any[],
    mcps: [] as string[],
    fetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>(),
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: harness.fetch }),
);
vi.mock("./apiV3/factory", () => ({
    SandboxHost: class {
        result: unknown;
        terminate = vi.fn();
        constructor(readonly api: Api) {
            harness.hosts.push(this);
        }
        run(_iframe: unknown, script: string) {
            this.result = new Function("risuai", script)(this.api);
        }
    },
}));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => "hash"),
    risuChatParser: (s: string) => s,
    risuChatParserScoped: (s: string) => s,
    risuEscape: (s: string) => s,
    risuUnescape: (s: string) => s,
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: () => [],
    getModuleMcps: () => [...harness.mcps],
}));
vi.mock("./apiV3/permissionStore", async () =>
    (await import("./apiV3/tests/permissionStoreMock")).createPermissionStoreMock({
        hasPermissionGrant: () => true,
        getLastGrantTime: () => Date.now(),
        recordPermissionGrants: vi.fn(),
    }),
);

import { loadPlugins } from "./plugins.svelte";
import { SandboxHost } from "./apiV3/factory";
import { customV3ProviderMetaStore, executePluginV3, getV3PluginInstance, loadV3Plugins } from "./apiV3/v3.svelte";
import { customProviderStore, pluginHooks } from "./pluginHooks";
import { getModelInfo, getModelList, LLMTokenizer, LLMFlags } from "src/ts/model/modellist";
import {
    additionalSettingsMenu,
    additionalFloatingActionButtons,
    additionalHamburgerMenu,
    additionalChatMenu,
    bodyIntercepterStore,
    chatPanelStore,
} from "src/ts/stores.svelte";
import { getTTSPreprocessors, getTTSPostprocessors } from "src/ts/process/ttsHooks";
import * as resourceSync from "src/ts/storage/resourceSync.svelte";
import { registeredHooks } from "src/ts/network/jobChannel";
import { registeredCustomPluginMCPs } from "src/ts/process/mcp/pluginmcp";
import { callTool, getTools, initializeMCPs, MCPs, callOnlyMCPs } from "src/ts/process/mcp/mcp";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";

const plugin = (name: string, version = "old", enabled = true): RisuPlugin => ({
    name,
    script: `return ${JSON.stringify(version)}`,
    version: "3.0",
    enabled,
    arguments: {},
    realArg: {},
    customLink: [],
    argMeta: {},
});
const host = (name: string) => getV3PluginInstance(name)!.host as unknown as (typeof harness.hosts)[number];
const providerPlugin = (name: string): RisuPlugin => ({
    ...plugin(name),
    script: `risuai.addProvider(${JSON.stringify(name)}, async () => ({ success: true, content: "reply" }));`,
});
const expectProviders = (names: string[]) => {
    const ids = names.map((name) => `pluginmodel:::${name}`).sort();
    expect(get(customProviderStore).slice().sort()).toEqual([...names].sort());
    expect(customV3ProviderMetaStore.map((model) => model.id).sort()).toEqual(ids);
    expect(
        getModelList({ groupedByProvider: true })
            .filter((group) => group.providerName === "Plugins")
            .flatMap((group) => group.models.map((model) => model.id))
            .sort(),
    ).toEqual(ids);
    expect([...pluginHooks.providers.keys()].sort()).toEqual([...names].sort());
    expect([...pluginHooks.providerOptions.keys()].sort()).toEqual([...names].sort());
};
const metadata = { identifier: "plugin:reload", name: "reload", version: "1", description: "reload" };
const tools = [{ name: "version", description: "version", inputSchema: { type: "object" } }];
const register = (api: Api, value: string) =>
    api.registerMCP(
        metadata,
        async () => tools,
        async () => [{ type: "text", text: value }],
    );
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    installFlatDatabase({ characters: [], plugins: [], modules: [], enabledModules: [] });
    harness.hosts.length = 0;
    harness.mcps = [];
    harness.fetch.mockReset();
});
afterEach(async () => {
    // Also clean up after a mutation that deliberately leaves alternate instances alive.
    while (harness.hosts.some((h) => !h.terminate.mock.calls.length)) await loadV3Plugins([]);
    await initializeMCPs();
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("plugin reload lifecycle", () => {
    it("refuses every hook and UI registration throughout unload and on the replaced instance, while the replacement accepts them", async () => {
        const name = "fenced-instance";
        const entry = { ...plugin(name), allowedIPC: [name] };
        settings.plugins = [entry];
        await executePluginV3(entry);
        const old = host(name);
        const late = vi.fn<(...args: any[]) => any>(() => []);
        const fresh = vi.fn<(...args: any[]) => any>(() => []);
        const storageRegistration = vi.spyOn(resourceSync, "onPluginStorageDiscarded");
        const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
        const menus = [
            additionalSettingsMenu,
            additionalFloatingActionButtons,
            additionalHamburgerMenu,
            additionalChatMenu,
            chatPanelStore,
        ];
        async function registerAll(api: Api, callback: typeof late) {
            api.addProvider(name, callback);
            for (const mode of ["input", "output", "process", "display"]) api.addRisuScriptHandler(mode, callback);
            await api.addRisuReplacer("beforeRequest", callback);
            await api.addRisuReplacer("afterRequest", callback);
            await api.addRisuChatListener("output", callback);
            await api.addTTSPreprocessor(callback);
            await api.addTTSPostprocessor(callback);
            await api.registerBodyIntercepter(callback);
            api.registerMCP(metadata, async () => tools, callback);
            api.addPluginChannelListener("events", callback);
            api.onStorageDiscarded(callback);
            api.onUnload(callback);
            api.registerSetting("Setting", callback);
            for (const location of ["action", "chat", "hamburger"])
                api.registerButton({ name: "Button", icon: "", iconType: "none", location }, callback);
            api.setChatPanel("<p>panel</p>");
            return api.createMutationObserver(callback);
        }
        const expectEmpty = () => {
            expectProviders([]);
            for (const key of [
                "editinput",
                "editoutput",
                "editprocess",
                "editdisplay",
                "replacerbeforeRequest",
                "replacerafterRequest",
                "chatOutput",
            ] as const)
                expect.soft(pluginHooks[key].size, key).toBe(0);
            expect.soft(getTTSPreprocessors()).toEqual([]);
            expect.soft(getTTSPostprocessors()).toEqual([]);
            expect.soft(bodyIntercepterStore).toEqual([]);
            for (const menu of menus) expect.soft(menu).toEqual([]);
            expect.soft(registeredCustomPluginMCPs.has(metadata.identifier)).toBe(false);
            expect.soft(storageRegistration).not.toHaveBeenCalled();
            old.api.postPluginChannelMessage(name, "events", "after unload");
            expect.soft(late).not.toHaveBeenCalled();
        };
        const entered = deferred();
        const hold = deferred();
        let duringUnload!: Promise<unknown>;
        old.api.onUnload(() => {
            duringUnload = registerAll(old.api, late);
            entered.resolve();
            return duringUnload.then(() => hold.promise);
        });
        const reloading = loadV3Plugins([entry]);
        try {
            await entered.promise;
            expect(await duringUnload).toBeUndefined();
            expect(old.terminate).not.toHaveBeenCalled();
            expectEmpty();
            // The sandbox stays alive for the entire one-second cleanup allowance.
            await vi.advanceTimersByTimeAsync(999);
            expect(await registerAll(old.api, late)).toBeUndefined();
            expectEmpty();
            await vi.advanceTimersByTimeAsync(1);
            await reloading;
            expect(old.terminate).toHaveBeenCalledTimes(1);
            expect(host(name)).not.toBe(old);
            expect(await registerAll(old.api, late)).toBeUndefined();
            expectEmpty();
            const observer = await registerAll(host(name).api, fresh);
            expect(observer).toBeDefined();
            expectProviders([name]);
            expect(pluginHooks.editinput.size).toBe(1);
            expect(pluginHooks.replacerbeforeRequest.size).toBe(1);
            expect(pluginHooks.chatOutput.size).toBe(1);
            expect(getTTSPreprocessors()).toEqual([fresh]);
            expect(getTTSPostprocessors()).toEqual([fresh]);
            expect(bodyIntercepterStore).toHaveLength(1);
            for (const menu of menus) expect(menu).toHaveLength(1);
            expect(storageRegistration).toHaveBeenCalledTimes(1);
            expect(registeredCustomPluginMCPs.has(metadata.identifier)).toBe(true);
            host(name).api.postPluginChannelMessage(name, "events", "new instance");
            expect(fresh).toHaveBeenCalledTimes(1);
            expect(warnings.mock.calls.some(([message]) => String(message).includes("Refused"))).toBe(true);
            await loadV3Plugins([]);
            expect(late).not.toHaveBeenCalled();
            expect(fresh).toHaveBeenCalledTimes(2); // IPC, then the replacement's own unload.
        } finally {
            hold.resolve();
            await reloading;
        }
    });

    it("rejects a failed sandbox start, terminates its host and removes its instance and iframe", async () => {
        const entry = plugin("failed-start");
        const error = new Error("sandbox start failed");
        let iframe!: HTMLIFrameElement;
        vi.spyOn(SandboxHost.prototype, "run").mockImplementation((frame) => {
            iframe = frame as HTMLIFrameElement;
            expect(document.body.contains(iframe)).toBe(true);
            throw error;
        });

        try {
            await expect(executePluginV3(entry)).rejects.toBe(error);
            expect.soft(getV3PluginInstance(entry.name)).toBeUndefined();
            expect.soft(document.body.contains(iframe)).toBe(false);
            expect.soft(harness.hosts[0].terminate).toHaveBeenCalledTimes(1);
        } finally {
            await loadV3Plugins([]);
        }
    });

    it("removes disabled and deleted providers, including registrations made during unload", async () => {
        const disabled = providerPlugin("disabled-provider");
        const removed = providerPlugin("removed-provider");
        settings.plugins = [disabled, removed, providerPlugin("keeper-provider")];
        await loadPlugins();
        expectProviders([disabled.name, removed.name, "keeper-provider"]);

        const old = host(removed.name);
        const duringUnload = vi.fn(() => {
            expect(old.terminate).not.toHaveBeenCalled();
            old.api.addProvider("unloading-provider", async () => ({ success: true, content: "too late" }));
        });
        old.api.onUnload(duringUnload);
        settings.plugins = [{ ...disabled, enabled: false }, providerPlugin("keeper-provider")];
        await loadPlugins();

        expect(duringUnload).toHaveBeenCalledTimes(1);
        expect(old.terminate).toHaveBeenCalledTimes(1);
        expectProviders(["keeper-provider"]);
    });

    it("lists a startup provider exactly once after two reloads", async () => {
        settings.plugins = [providerPlugin("repeat-provider")];
        await loadPlugins();
        expectProviders(["repeat-provider"]);
        for (let reload = 0; reload < 2; reload++) {
            const old = host("repeat-provider");
            await loadPlugins();
            expect(old.terminate).toHaveBeenCalledTimes(1);
            expect(host("repeat-provider")).not.toBe(old);
            expectProviders(["repeat-provider"]);
        }
    });

    it("replaces a duplicate provider's options and model metadata", async () => {
        settings.plugins = [providerPlugin("duplicate-provider")];
        await loadPlugins();
        const latestModel = {
            name: "Latest model",
            shortName: "Latest",
            fullName: "Latest model version",
            internalID: "latest-backend",
            flags: [],
            parameters: ["temperature"],
            tokenizer: LLMTokenizer.Unknown,
        };
        const latestOptions = { tokenizer: "latest-tokenizer", model: latestModel };
        host("duplicate-provider").api.addProvider(
            "duplicate-provider",
            async () => ({ success: true, content: "latest reply" }),
            latestOptions,
        );

        expectProviders(["duplicate-provider"]);
        expect(pluginHooks.providerOptions.get("duplicate-provider")).toEqual(latestOptions);
        expect(customV3ProviderMetaStore).toEqual([
            expect.objectContaining({ id: "pluginmodel:::duplicate-provider", ...latestModel }),
        ]);
        expect(getModelInfo("pluginmodel:::duplicate-provider")).toMatchObject(latestModel);
    });

    it("rejects invalid new descriptors atomically while valid partial options default and reach job creation", async () => {
        await executePluginV3(plugin("descriptor-owner"));
        const api = host("descriptor-owner").api;
        const callback = vi
            .fn<NonNullable<ReturnType<typeof pluginHooks.providers.get>>>()
            .mockResolvedValue({ success: true, content: "invalid" });
        for (const model of [
            { name: 42 },
            { internalID: {} },
            { flags: ["system"] },
            { parameters: [42] },
            { tokenizer: "unknown" },
        ]) {
            expect(() => api.addProvider("invalid", callback, { tokenizer: "custom", model })).toThrow(
                new TypeError("Invalid plugin provider model descriptor"),
            );
            expectProviders([]);
        }
        expect(callback).not.toHaveBeenCalled();
        api.addProvider("partial", callback, { model: { name: "Partial model" } });
        const descriptor = customV3ProviderMetaStore[0];
        expect(descriptor).toMatchObject({
            id: "pluginmodel:::partial",
            name: "Partial model",
            shortName: "partial",
            fullName: "partial",
            internalID: "pluginmodel:::partial",
            tokenizer: LLMTokenizer.Unknown,
        });
        expect(descriptor.flags).toEqual([LLMFlags.hasFullSystemPrompt]);
        expect(descriptor.parameters).toContain("temperature");
        const { createGenerationJob, releaseGenerationJob } = await import("src/ts/network/generationJobs");
        harness.fetch.mockResolvedValue(Response.json({ jobId: "partial-provider-job" }));
        try {
            await expect(
                createGenerationJob({
                    kind: "send",
                    context: {
                        characterId: "c",
                        chatId: "chat",
                        presetId: null,
                        modelPresetId: null,
                        personaId: null,
                        mode: "normal",
                        input: "hello",
                        chatRevision: "r1",
                    },
                }),
            ).resolves.toEqual({ outcome: "created", jobId: "partial-provider-job" });
            const sent = JSON.parse(String(harness.fetch.mock.calls[0][1]?.body));
            expect(sent.hooks.providers).toEqual([{ name: "partial", model: descriptor }]);
        } finally {
            releaseGenerationJob("partial-provider-job");
        }
    });

    it("rejects a provider replacement atomically and keeps its old callback and complete metadata", async () => {
        await executePluginV3(plugin("replacement-owner"));
        const api = host("replacement-owner").api;
        const original = vi
            .fn<NonNullable<ReturnType<typeof pluginHooks.providers.get>>>()
            .mockResolvedValue({ success: true, content: "original reply" });
        const rejected = vi
            .fn<NonNullable<ReturnType<typeof pluginHooks.providers.get>>>()
            .mockResolvedValue({ success: true, content: "rejected reply" });
        const options = { tokenizer: "old-tokenizer", model: { name: "Original model", parameters: ["temperature"] } };
        api.addProvider("preserved", original, options);
        const callback = pluginHooks.providers.get("preserved")!;
        const descriptor = structuredClone(customV3ProviderMetaStore[0]);
        expect(() =>
            api.addProvider("preserved", rejected, {
                tokenizer: "replacement-tokenizer",
                model: { name: "Replacement", flags: ["invalid"] },
            }),
        ).toThrow("Invalid plugin provider model descriptor");
        expectProviders(["preserved"]);
        expect(pluginHooks.providers.get("preserved")).toBe(callback);
        expect(pluginHooks.providerOptions.get("preserved")).toEqual(options);
        expect(customV3ProviderMetaStore).toEqual([descriptor]);
        expect(getModelInfo("pluginmodel:::preserved")).toMatchObject(descriptor);
        await expect(callback({} as Parameters<typeof callback>[0], new AbortController().signal)).resolves.toEqual({
            success: true,
            content: "original reply",
        });
        expect(original).toHaveBeenCalledTimes(1);
        expect(rejected).not.toHaveBeenCalled();
        expect((await registeredHooks()).providers).toEqual([{ name: "preserved", model: descriptor }]);
    });

    it("terminates every old sandbox once and executes both updated scripts", async () => {
        settings.plugins = [plugin("one"), plugin("two")];
        await loadPlugins();
        const old = [host("one"), host("two")];
        settings.plugins = [plugin("one", "new one"), plugin("two", "new two")];
        await loadPlugins();
        for (const instance of old) expect(instance.terminate).toHaveBeenCalledTimes(1);
        expect(host("one").result).toBe("new one");
        expect(host("two").result).toBe("new two");
        expect(harness.hosts.filter((h) => !h.terminate.mock.calls.length)).toHaveLength(2);
    });

    it.each(["disabled", "removed"] as const)(
        "unregisters a %s plugin's sandbox, hooks and warmed MCP client",
        async (state) => {
            settings.plugins = [plugin("keeper"), plugin("retired")];
            await loadPlugins();
            const old = host("retired");
            old.api.addRisuScriptHandler("output", async () => "retired");
            await old.api.addRisuReplacer("beforeRequest", async () => []);
            await old.api.addRisuChatListener("output", async () => {});
            await register(old.api, "retired");
            harness.mcps = [metadata.identifier];
            expect(await getTools()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "version" })]));
            expect(MCPs[metadata.identifier]).toBeDefined();
            settings.plugins = [
                plugin("keeper"),
                ...(state === "disabled" ? [plugin("retired", "disabled code", false)] : []),
            ];
            await loadPlugins();
            expect(old.terminate).toHaveBeenCalledTimes(1);
            expect(getV3PluginInstance("retired")).toBeUndefined();
            expect(registeredCustomPluginMCPs.has(metadata.identifier)).toBe(false);
            expect(MCPs[metadata.identifier]).toBeUndefined();
            expect(callOnlyMCPs[metadata.identifier]).toBeUndefined();
            expect(pluginHooks.editoutput.size).toBe(0);
            expect(pluginHooks.replacerbeforeRequest.size).toBe(0);
            expect(pluginHooks.chatOutput.size).toBe(0);
            expect(await getTools()).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "version" })]),
            );
        },
    );

    it("keeps a newer registration of the same MCP identifier when its old owner unloads", async () => {
        await executePluginV3(plugin("old-owner"));
        const old = host("old-owner");
        // Spawn the successor during unload: it is not in this reload's old-instance snapshot.
        old.api.onUnload(() => {
            void executePluginV3(plugin("new-owner"));
            void register(host("new-owner").api, "new");
        });
        await register(old.api, "old");
        harness.mcps = [metadata.identifier];
        await getTools(); // Warm the dispatch registry with the old client.
        await loadV3Plugins([]);
        expect(old.terminate).toHaveBeenCalledTimes(1);
        expect(registeredCustomPluginMCPs.has(metadata.identifier)).toBe(true);
        expect(await callTool("version", {})).toEqual([{ type: "text", text: "new" }]);
    });

    it("serializes overlapping reloads and keeps each caller's captured plugin list", async () => {
        settings.plugins = [plugin("initial")];
        await loadPlugins();
        const entered = deferred(),
            release = deferred();
        host("initial").api.onUnload(() => {
            entered.resolve();
            return release.promise;
        });
        const started = vi.fn();
        // Observe each real sandbox start, including the intermediate queued list.
        const initial = host("initial");
        const run = Object.getPrototypeOf(initial).run;
        vi.spyOn(Object.getPrototypeOf(initial), "run").mockImplementation(function (this: any, ...args: any[]) {
            started(args[1]);
            return run.apply(this, args);
        });
        settings.plugins = [plugin("first", "first snapshot")];
        const first = loadPlugins();
        await entered.promise;
        settings.plugins = [plugin("second", "second snapshot")];
        const second = loadPlugins();
        settings.plugins = [plugin("unrequested")];
        try {
            // Let a non-serialized reload finish if it can; no wall-clock sleep is needed.
            await vi.advanceTimersByTimeAsync(0);
            expect(started).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await Promise.all([first, second]);
        }
        expect(started.mock.calls.map(([script]) => script)).toEqual([
            plugin("first", "first snapshot").script,
            plugin("second", "second snapshot").script,
        ]);
        expect(getV3PluginInstance("initial")).toBeUndefined();
        expect(getV3PluginInstance("first")).toBeUndefined();
        expect(getV3PluginInstance("unrequested")).toBeUndefined();
        expect(host("second").result).toBe("second snapshot");
        for (const h of harness.hosts.filter((h) => h !== host("second"))) expect(h.terminate).toHaveBeenCalledTimes(1);
    });
});
