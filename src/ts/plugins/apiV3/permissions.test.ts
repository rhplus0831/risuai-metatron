import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// `getPluginPermission` in the v3 host API: a grant is keyed by the hash of the script captured when
// the plugin was loaded plus the permission, so one consent answers one permission of one plugin,
// a plugin that rewrites its own database copy keeps its original grants, answers are cached per
// (plugin, permission) for the page load and dropped on unload, and "periodically" asks again after
// three days.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { db, captured, grants, times, recorded, confirm } = vi.hoisted(() => ({
    db: { characters: [] as any[], plugins: [] as any[], pluginCustomStorage: undefined as any },
    captured: { api: null as CapturedApi | null },
    grants: new Set<string>(),
    times: new Map<string, number>(),
    recorded: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
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
    },
}));
vi.mock("src/ts/storage/database.svelte", () => ({
    getDatabase: () => db,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    setCurrentChat: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        getFetchLogs: vi.fn(() => [{ url: "https://example.com/path?q=1", body: "", response: "", success: true }]),
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: confirm,
    }),
);
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async (bytes: Uint8Array) => `h(${new TextDecoder().decode(bytes)})`),
    risuChatParser: vi.fn((text: string) => text),
    risuUnescape: (text: string) => text,
}));
vi.mock("./permissionStore", async () =>
    (await import("./tests/permissionStoreMock")).createPermissionStoreMock({
        hasPermissionGrant: (key: string) => grants.has(key),
        getLastGrantTime: (key: string) => times.get(key),
        recordPermissionGrants: recorded,
    }),
);
vi.mock("src/ts/process/files/inlays", () => ({ getInlayAsset: vi.fn(async () => ({ name: "inlay" })) }));

import { executePluginV3, getV3PluginInstance, loadV3Plugins } from "./v3.svelte";
import { language } from "src/lang";
import { endJobChannel, handleChannelEvent } from "src/ts/network/jobChannel";
import { requestChatData } from "src/ts/process/request/request";
import * as resourceSync from "src/ts/storage/resourceSync.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { findChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { pluginHooks, type PluginProviderArgument } from "../pluginHooks";
import { capturePluginContext, invokeHook } from "./pluginContext";

let counter = 0;

async function makeApi(script = "script-a"): Promise<{ api: CapturedApi; plugin: any }> {
    captured.api = null;
    const plugin = { name: `perm-test-${++counter}`, script, version: "3.0" };
    db.plugins = [plugin];
    await executePluginV3(plugin as any);
    expect(captured.api).not.toBeNull();
    return { api: captured.api!, plugin };
}

beforeEach(() => {
    grants.clear();
    times.clear();
    recorded.mockClear();
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    vi.useRealTimers();
});

describe("grants", () => {
    it("answers from a stored grant for that permission only; other permissions still ask", async () => {
        const { api, plugin } = await makeApi("script-a");
        grants.add("h(script-a)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now());
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(await api.readInlay("x")).toEqual({ name: "inlay" });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith(
            { grants: ["h(script-a)_inlay"], lastGrantTime: expect.any(Object) },
            expect.any(Function),
        );
    });

    it("records a consent under the (script hash, permission) key and caches the answer", async () => {
        const { api } = await makeApi("script-b");
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(recorded).toHaveBeenCalledWith(
            { grants: ["h(script-b)_fetchLogs"], lastGrantTime: undefined },
            expect.any(Function),
        );
        expect(await api.getFetchLogs()).toHaveLength(1);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("caches a denial per permission and keeps asking for other permissions", async () => {
        confirm.mockResolvedValue(false);
        const { api } = await makeApi("script-c");
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(await api.getFetchLogs()).toBeNull();
        expect(await api.requestPluginPermission("sendChat")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(recorded).not.toHaveBeenCalled();
    });

    it("hashes the script captured at load, not the database copy a plugin may rewrite", async () => {
        const { api, plugin } = await makeApi("original");
        grants.add("h(original)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now());
        plugin.script = "rewritten by a db-granted plugin";
        db.plugins[0].script = "rewritten by a db-granted plugin";
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        grants.clear();
        // A grant for the rewritten script does not answer the loaded plugin either.
        const { api: second } = await makeApi("loaded");
        grants.add("h(rewritten)_fetchLogs");
        db.plugins[0].script = "rewritten";
        confirm.mockResolvedValue(false);
        expect(await second.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("keeps a consent for the page load even when saving the grant fails", async () => {
        recorded.mockRejectedValueOnce(new Error("offline"));
        const { api } = await makeApi("script-d");
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe("provider permission", () => {
    const argument = (): PluginProviderArgument => ({
        prompt_chat: [{ role: "user", content: "A prompt for the provider" }],
        frequency_penalty: 0,
        min_p: 0,
        presence_penalty: 0,
        repetition_penalty: 1,
        top_k: 0,
        top_p: 1,
        temperature: 0.8,
        mode: "model",
        max_tokens: 20,
    });

    async function registerProvider() {
        const { api, plugin } = await makeApi();
        const name = `provider-${plugin.name}`;
        const answer = { success: true, content: "The plugin's answer" };
        const func = vi.fn(async (_arg: PluginProviderArgument, _signal?: AbortSignal) => answer);
        api.addProvider(name, func);
        const hook = pluginHooks.providers.get(name);
        expect(hook).toBeDefined();
        return { plugin, name, func, hook: hook!, answer };
    }

    it("returns a failure naming the plugin without calling it when provider consent is denied", async () => {
        confirm.mockResolvedValue(false);
        const { plugin, func, hook } = await registerProvider();

        const result = await invokeHook(hook, undefined, argument(), new AbortController().signal);

        expect(func).not.toHaveBeenCalled();
        expect(result).toEqual({
            success: false,
            content: language.pluginProviderPermissionDenied.replace("{}", plugin.name),
        });
        expect(confirm).toHaveBeenCalledExactlyOnceWith(language.providerPermissionConsent.replace("{}", plugin.name));
    });

    it("returns the cached denial on a second provider call without another prompt or a plugin call", async () => {
        confirm.mockResolvedValueOnce(false);
        const { plugin, func, hook } = await registerProvider();
        const denied = {
            success: false,
            content: language.pluginProviderPermissionDenied.replace("{}", plugin.name),
        };

        expect(await invokeHook(hook, undefined, argument(), new AbortController().signal)).toEqual(denied);
        expect(await invokeHook(hook, undefined, argument(), new AbortController().signal)).toEqual(denied);

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(func).not.toHaveBeenCalled();
    });

    it("calls a consented provider with the prompt in v3 mode and returns its answer unchanged", async () => {
        const { func, hook, answer } = await registerProvider();
        const arg = argument();
        const expected = { ...arg, mode: "v3" };
        const signal = new AbortController().signal;

        expect(await invokeHook(hook, undefined, arg, signal)).toBe(answer);

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(func).toHaveBeenCalledExactlyOnceWith(expected, signal);
    });

    it("returns the aborted failure without calling the plugin when the request aborts while consent is pending", async () => {
        let answerConsent!: (answer: boolean) => void;
        confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => (answerConsent = resolve)));
        const { func, hook } = await registerProvider();
        const abort = new AbortController();

        const running = invokeHook(hook, undefined, argument(), abort.signal);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(func).not.toHaveBeenCalled();
        abort.abort();
        answerConsent(true);

        expect(await running).toEqual({ success: false, content: language.pluginProviderRequestAborted });
        expect(func).not.toHaveBeenCalled();
    });

    it("answers server provider callbacks with prompted and cached denials without calling the plugin", async () => {
        confirm.mockResolvedValueOnce(false);
        const { plugin, name, func } = await registerProvider();
        const send = vi.fn(() => true);
        const flush = vi.spyOn(resourceSync, "flushResources").mockResolvedValue({ discarded: [], refused: [] });
        const jobId = `job-${plugin.name}`;

        try {
            for (let call = 0; call < 2; call += 1) {
                // Distinct callback ids make this a second provider request, not a channel replay.
                const id = `callback-${plugin.name}-${call}`;
                handleChannelEvent(
                    jobId,
                    {
                        type: "callback",
                        epoch: "epoch-1",
                        jobId,
                        id,
                        name: "provider",
                        targets: {
                            chatRef: { chaId: "character", chatId: "chat" },
                            presetId: "preset",
                            modelPresetId: "model-preset",
                            personaId: "persona",
                        },
                        revisions: [],
                        payload: { name, argument: argument() },
                        deadline: Date.now() + 10_000,
                    },
                    { send },
                );
                await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(call + 1));

                expect(func).not.toHaveBeenCalled();
                expect(send).toHaveBeenNthCalledWith(call + 1, {
                    type: "answer",
                    id,
                    outcome: "answered",
                    value: {
                        success: false,
                        content: language.pluginProviderPermissionDenied.replace("{}", plugin.name),
                    },
                });
            }
            expect(confirm).toHaveBeenCalledTimes(1);
        } finally {
            endJobChannel(jobId);
            flush.mockRestore();
        }
    });

    it("fails a tab request with the denied message on both the prompted and cached paths without calling the plugin", async () => {
        confirm.mockResolvedValueOnce(false);
        const { plugin, name, func } = await registerProvider();
        installFlatDatabase({
            characters: [],
            aiModel: `pluginmodel:::${name}`,
            temperature: 80,
            maxResponse: 20,
            requestRetrys: 0,
            useStreaming: false,
        });

        for (let call = 0; call < 2; call += 1) {
            const result = await requestChatData(
                { formated: argument().prompt_chat, bias: {}, tools: [], chatRef: null },
                "model",
            );

            expect(func).not.toHaveBeenCalled();
            expect(result).toEqual({
                type: "fail",
                result: language.pluginProviderPermissionDenied.replace("{}", plugin.name),
                model: `pluginmodel:::${name}`,
            });
        }
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe("unload", () => {
    it("drops the cached answers when the plugin is unloaded, so a reload asks again", async () => {
        const { api, plugin } = await makeApi("script-e");
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
        await loadV3Plugins([]);
        expect(getV3PluginInstance(plugin.name)).toBeUndefined();
        await executePluginV3(plugin as any);
        const reloaded = captured.api!;
        expect(reloaded).not.toBe(api);
        expect(await reloaded.requestPluginPermission("sendChat")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

describe("periodic permissions", () => {
    it("asks again three days after the last grant and records the new time", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
        const { api, plugin } = await makeApi("script-f");
        grants.add("h(script-f)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now() - 2 * 24 * 60 * 60 * 1000);
        expect(await api.getDatabase()).not.toBeNull();
        expect(confirm).not.toHaveBeenCalled();

        await loadV3Plugins([]);
        await executePluginV3(plugin as any);
        const later = captured.api!;
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now() - 4 * 24 * 60 * 60 * 1000);
        expect(await later.getDatabase()).not.toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith(
            {
                grants: ["h(script-f)_db"],
                lastGrantTime: { [`${plugin.name}_db_lastGrantTime`]: Date.now() },
            },
            expect.any(Function),
        );
    });
});

describe("dbWrite", () => {
    const now = Date.UTC(2026, 8, 29);
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const ref = { chaId: "write-character", chatId: "write-chat" };
    const character = (name: string) => ({ chaId: ref.chaId, type: "character", name });
    const setters = [
        { name: "setDatabase", args: (value: string) => [{ theme: value }], field: "theme" },
        { name: "setDatabaseLite", args: (value: string) => [{ theme: value }], field: "theme" },
        { name: "setChar", args: (value: string) => [character(value)], field: "name" },
        { name: "setCharacter", args: (value: string) => [character(value)], field: "name" },
        { name: "setCharacterToIndex", args: (value: string) => [0, character(value)], field: "name" },
        { name: "setChatToIndex", args: (value: string) => [0, 0, { note: value }], field: "note" },
    ];
    const stored = () => ({
        theme: settings.ui.theme,
        name: characterList()[0]?.name,
        note: findChat(ref)?.note,
    });
    const original = { theme: "before", name: "before", note: "before" };

    beforeEach(() => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        onTestFinished(() => clock.mockRestore());
        installFlatDatabaseWithChats({
            theme: "before",
            characters: [
                {
                    ...character("before"),
                    chats: [{ id: ref.chatId, name: "Chat", note: "before", message: [], localLore: [] }],
                },
            ],
        });
        selectCharacter(ref.chaId);
    });

    it.each(setters)(
        "$name requires separate consent from db, writes on grant, and caches grant and refusal",
        async ({ name, args, field }) => {
            const { api, plugin } = await makeApi();
            grants.add("h(script-a)_db");
            times.set(`${plugin.name}_db_lastGrantTime`, now);
            // A recent timestamp alone is not a dbWrite grant.
            times.set(`${plugin.name}_dbWrite_lastGrantTime`, now);
            expect(await api.requestPluginPermission("db")).toBe(true);
            expect(confirm).not.toHaveBeenCalled();

            let answer!: (value: boolean) => void;
            confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
            const pending = api[name](...args("granted"));
            await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
            expect(confirm).toHaveBeenCalledWith(language.dbWriteConsent.replace("{}", plugin.name));
            expect(stored()).toEqual(original);
            answer(true);
            expect(await pending).toBeUndefined();
            expect(stored()).toEqual({ ...original, [field]: "granted" });
            expect(recorded).toHaveBeenCalledExactlyOnceWith(
                { grants: ["h(script-a)_dbWrite"], lastGrantTime: { [`${plugin.name}_dbWrite_lastGrantTime`]: now } },
                expect.any(Function),
            );
            await api[name](...args("cached grant"));
            expect(stored()).toEqual({ ...original, [field]: "cached grant" });
            expect(confirm).toHaveBeenCalledTimes(1);

            const { api: denied, plugin: deniedPlugin } = await makeApi("denied-script");
            confirm.mockClear();
            confirm.mockResolvedValue(false);
            recorded.mockClear();
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            onTestFinished(() => warn.mockRestore());
            for (let call = 0; call < 2; call++) {
                await expect(denied[name](...args("must not write"))).resolves.toBeUndefined();
                expect(stored()).toEqual({ ...original, [field]: "cached grant" });
                expect(warn).toHaveBeenNthCalledWith(
                    call + 1,
                    `[RisuAI Plugin: ${deniedPlugin.name}] Refused ${name}: the dbWrite permission was not granted`,
                );
            }
            expect(confirm).toHaveBeenCalledExactlyOnceWith(language.dbWriteConsent.replace("{}", deniedPlugin.name));
            expect(recorded).not.toHaveBeenCalled();
        },
    );

    it("rechecks dbWrite only when uncached and the last grant is older than three days", async () => {
        const { api, plugin } = await makeApi();
        grants.add("h(script-a)_dbWrite");
        const timeKey = `${plugin.name}_dbWrite_lastGrantTime`;
        times.set(timeKey, now - threeDays);
        await api.setDatabaseLite({ theme: "at three days" });
        expect(settings.ui.theme).toBe("at three days");
        expect(confirm).not.toHaveBeenCalled();

        vi.mocked(Date.now).mockReturnValue(now + 1);
        await api.setDatabaseLite({ theme: "page cached" });
        expect(settings.ui.theme).toBe("page cached");
        expect(confirm).not.toHaveBeenCalled();

        await loadV3Plugins([]);
        await executePluginV3(plugin);
        await captured.api!.setDatabaseLite({ theme: "renewed" });
        expect(settings.ui.theme).toBe("renewed");
        expect(confirm).toHaveBeenCalledExactlyOnceWith(language.dbWriteConsent.replace("{}", plugin.name));
        expect(recorded).toHaveBeenCalledExactlyOnceWith(
            { grants: ["h(script-a)_dbWrite"], lastGrantTime: { [timeKey]: now + 1 } },
            expect.any(Function),
        );
    });

    it("binds dbWrite to the loaded script and asks again after loading changed code", async () => {
        const { api, plugin } = await makeApi("original-write-script");
        grants.add("h(original-write-script)_dbWrite");
        times.set(`${plugin.name}_dbWrite_lastGrantTime`, now);
        plugin.script = "changed-write-script";
        await api.setDatabaseLite({ theme: "original loaded script" });
        expect(settings.ui.theme).toBe("original loaded script");
        expect(confirm).not.toHaveBeenCalled();

        await loadV3Plugins([]);
        await executePluginV3(plugin);
        await captured.api!.setDatabaseLite({ theme: "changed loaded script" });
        expect(settings.ui.theme).toBe("changed loaded script");
        expect(confirm).toHaveBeenCalledExactlyOnceWith(language.dbWriteConsent.replace("{}", plugin.name));
        expect(recorded).toHaveBeenCalledExactlyOnceWith(
            {
                grants: ["h(changed-write-script)_dbWrite"],
                lastGrantTime: { [`${plugin.name}_dbWrite_lastGrantTime`]: now },
            },
            expect.any(Function),
        );
    });

    it("refuses all six setters in a read-only transform continuation before asking for consent", async () => {
        const { api, plugin } = await makeApi();
        grants.add("h(script-a)_replacer");
        times.set(`${plugin.name}_replacer_lastGrantTime`, now);
        const before = new Set(pluginHooks.chatOutput);
        await api.addRisuChatListener("output", async () => {
            for (const { name, args } of setters) {
                await expect(api[name](...args("must not write"))).resolves.toBeUndefined();
                expect(stored()).toEqual(original);
            }
        });
        const listener = [...pluginHooks.chatOutput].find((entry) => !before.has(entry))!;
        expect(listener).toBeDefined();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warn.mockRestore());
        await invokeHook(listener, { ...capturePluginContext(ref)!, purpose: "transform" }, {} as any);
        expect(confirm).not.toHaveBeenCalled();
        expect(recorded).not.toHaveBeenCalled();
    });

    it("rejects an unknown permission even with a stored grant, without a prompt", async () => {
        const { api } = await makeApi();
        grants.add("h(script-a)_unknownPermission");
        expect(await api.requestPluginPermission("unknownPermission")).toBe(false);
        expect(confirm).not.toHaveBeenCalled();
        expect(recorded).not.toHaveBeenCalled();
    });
});
