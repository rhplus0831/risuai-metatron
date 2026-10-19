import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { RisuPlugin } from "./plugins.svelte";

type Api = Record<string, (...args: any[]) => any>;
const harness = vi.hoisted(() => ({ hosts: [] as any[], mcps: [] as string[] }));
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
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
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
vi.mock("./apiV3/permissionStore", () => ({
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(),
}));

import { loadPlugins } from "./plugins.svelte";
import { customV3ProviderMetaStore, executePluginV3, getV3PluginInstance, loadV3Plugins } from "./apiV3/v3.svelte";
import { customProviderStore, pluginHooks } from "./pluginHooks";
import { getModelInfo, getModelList, LLMTokenizer } from "src/ts/model/modellist";
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
    installFlatDatabase({ characters: [], plugins: [], modules: [], enabledModules: [] });
    harness.hosts.length = 0;
    harness.mcps = [];
});
afterEach(async () => {
    // Also clean up after a mutation that deliberately leaves alternate instances alive.
    while (harness.hosts.some((h) => !h.terminate.mock.calls.length)) await loadV3Plugins([]);
    await initializeMCPs();
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
    vi.restoreAllMocks();
});

describe("plugin reload lifecycle", () => {
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
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
