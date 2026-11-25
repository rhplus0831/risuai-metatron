import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// `getPluginPermission` in the v3 host API: a grant is keyed by the hash of the script captured when
// the plugin was loaded plus the permission, so one consent answers one permission of one plugin,
// a plugin that rewrites its own database copy keeps its original grants, answers are cached per
// (plugin, permission) for the page load and dropped on unload, and "periodically" asks again after
// three days. A standing grant (the settings permission list's) is not asked again, calls behind an
// open prompt share it, and a chat panel's style element needs `globalStyle`.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { db, captured, grants, standing, times, resets, recorded, confirm, checklist, savedStanding } = vi.hoisted(
    () => ({
        db: { characters: [] as any[], plugins: [] as any[], pluginCustomStorage: undefined as any },
        captured: { api: null as CapturedApi | null },
        grants: new Set<string>(),
        standing: new Set<string>(),
        times: new Map<string, number>(),
        resets: new Map<string, number>(),
        recorded: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        checklist: vi.fn(
            async (
                _msg: string,
                _items: readonly { id: string; label: string; checked: boolean }[],
            ): Promise<{ confirmed: boolean; checked: string[] }> => ({ confirmed: false, checked: [] }),
        ),
        savedStanding: vi.fn(
            async (
                _plugin: string,
                _granted: readonly string[],
                _removedGrants: (key: string) => boolean,
                _removedTimes: (key: string) => boolean,
                _expectedResets: number,
            ) => undefined,
        ),
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
        alertConfirmWithChecklist: checklist,
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
        hasStandingGrant: (key: string) => grants.has(key) && standing.has(key),
        getLastGrantTime: (key: string) => times.get(key),
        getPermissionResetCount: (plugin: string) => resets.get(plugin) ?? 0,
        recordPermissionGrants: recorded,
        setStandingPermissionGrants: savedStanding,
    }),
);
vi.mock("src/ts/process/files/inlays", () => ({ getInlayAsset: vi.fn(async () => ({ name: "inlay" })) }));

import { executePluginV3, getV3PluginInstance, loadV3Plugins, reviewPluginPermissions } from "./v3.svelte";
import { chatPanelStore } from "src/ts/stores.svelte";
import { StalePermissionListError } from "./permissionStore";
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
    standing.clear();
    times.clear();
    resets.clear();
    // Reset, not clear: a test's own answer must not reach the next one.
    checklist.mockReset();
    checklist.mockImplementation(async () => ({ confirmed: false, checked: [] }));
    savedStanding.mockReset();
    savedStanding.mockImplementation(async () => undefined);
    recorded.mockClear();
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    vi.useRealTimers();
});

describe("grants", () => {
    it("asks for mainDom consent and returns no root document when it is denied", async () => {
        confirm.mockResolvedValue(false);
        const { api, plugin } = await makeApi();

        expect(await api.getRootDocument()).toBeNull();
        expect(confirm).toHaveBeenCalledExactlyOnceWith(language.mainDomAccessConsent.replace("{}", plugin.name));
        expect(recorded).not.toHaveBeenCalled();
    });

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

    it("does not ask again for a standing grant however old its last grant time", async () => {
        const { api, plugin } = await makeApi("script-standing");
        grants.add("h(script-standing)_db");
        standing.add("h(script-standing)_db");
        times.set(`${plugin.name}_db_lastGrantTime`, Date.now() - 30 * 24 * 60 * 60 * 1000);
        expect(await api.getDatabase()).not.toBeNull();

        // No time at all: the settings list writes none.
        grants.add("h(script-standing)_inlay");
        standing.add("h(script-standing)_inlay");
        expect(await api.readInlay("x")).toEqual({ name: "inlay" });
        expect(confirm).not.toHaveBeenCalled();
        expect(recorded).not.toHaveBeenCalled();
    });
});

describe("calls behind an open prompt", () => {
    it("share the one prompt and its answer", async () => {
        let answer!: (allowed: boolean) => void;
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const { api } = await makeApi("script-shared");

        const first = api.requestPluginPermission("fetchLogs");
        const second = api.requestPluginPermission("fetchLogs");
        const logs = api.getFetchLogs();
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        answer(true);

        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(await logs).toHaveLength(1);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledTimes(1);
    });
});

describe("chat panel styles", () => {
    const panel = (plugin: { name: string }) => chatPanelStore.find((entry) => entry.pluginName === plugin.name);
    const styled = "<div><style>body{color:red}</style><p>panel</p></div>";

    it("shows a panel without a style element without asking", async () => {
        const { api, plugin } = await makeApi("script-panel-plain");
        expect(api.setChatPanel('<p style="color:red">panel</p>')).toEqual({ id: `${plugin.name}:default` });
        expect(panel(plugin)?.html).toBe('<p style="color:red">panel</p>');
        expect(confirm).not.toHaveBeenCalled();
    });

    it("asks for globalStyle before showing a panel that carries a style element, and keeps it when allowed", async () => {
        const { api, plugin } = await makeApi("script-panel-allowed");
        const shown = api.setChatPanel(styled);
        expect(panel(plugin)).toBeUndefined();

        expect(await shown).toEqual({ id: `${plugin.name}:default` });
        expect(confirm).toHaveBeenCalledExactlyOnceWith(language.globalStyleConsent.replace("{}", plugin.name));
        expect(recorded).toHaveBeenCalledWith(
            { grants: ["h(script-panel-allowed)_globalStyle"], lastGrantTime: undefined },
            expect.any(Function),
        );
        expect(panel(plugin)?.html).toBe(styled);
    });

    // An SVG style element is covered by e2e/pluginSandbox.spec.ts: happy-dom's parser drops it.
    it("shows the panel without its style element and rules when globalStyle is denied", async () => {
        confirm.mockResolvedValue(false);
        const { api, plugin } = await makeApi("script-panel-denied");

        expect(await api.setChatPanel(styled)).toEqual({ id: `${plugin.name}:default` });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(panel(plugin)?.html).toBe("<div><p>panel</p></div>");

        // The denial is cached: the next styled panel is stripped without a second prompt.
        await api.setChatPanel(`<style>p{display:none}</style><p>again</p>`);
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(panel(plugin)?.html).toBe("<p>again</p>");
    });

    it("lets a later call for the same panel win over one still waiting for consent", async () => {
        let answer!: (allowed: boolean) => void;
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const { api, plugin } = await makeApi("script-panel-order");

        const waiting = api.setChatPanel(styled);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        api.setChatPanel("<p>newer</p>");
        answer(true);
        await waiting;
        expect(panel(plugin)?.html).toBe("<p>newer</p>");

        const removedWhileWaiting = api.setChatPanel(styled, { id: "other" });
        api.setChatPanel(null, { id: "other" });
        await removedWhileWaiting;
        expect(chatPanelStore.find((entry) => entry.id === "other")).toBeUndefined();
    });

    it("keeps a panel removed, or set by another plugin, while an earlier call for its id waited for consent", async () => {
        let answer!: (allowed: boolean) => void;
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const first = await makeApi("script-panel-unregister");
        const byId = (id: string) => chatPanelStore.find((entry) => entry.id === id);

        const removed = first.api.setChatPanel(styled, { id: "removed" });
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        first.api.unregisterUIPart("removed");
        const shared = first.api.setChatPanel(styled, { id: "shared" });

        // A second plugin of another name, loaded beside the first.
        captured.api = null;
        const other = { name: `perm-test-${++counter}`, script: "script-panel-other", version: "3.0" };
        await executePluginV3(other as any);
        captured.api!.setChatPanel("<p>theirs</p>", { id: "shared" });

        answer(true);
        await Promise.all([removed, shared]);
        expect(byId("removed")).toBeUndefined();
        expect(byId("shared")).toMatchObject({ pluginName: other.name, html: "<p>theirs</p>" });
    });

    it("shows nothing when the plugin unloads while consent is pending", async () => {
        let answer!: (allowed: boolean) => void;
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const { api, plugin } = await makeApi("script-panel-unload");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        onTestFinished(() => warn.mockRestore());

        const waiting = api.setChatPanel(styled);
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        await loadV3Plugins([]);
        answer(true);
        expect(await waiting).toBeUndefined();
        expect(panel(plugin)).toBeUndefined();
    });
});

describe("reviewPluginPermissions", () => {
    const plugin = { name: "review-plugin", displayName: "Review", script: "script-new" };
    const checkedIds = () =>
        checklist.mock.calls[0][1].filter((item: { checked: boolean }) => item.checked).map((item) => item.id);

    it("checks the script's grants and the replaced version's, then saves the chosen ones as standing", async () => {
        grants.add("h(script-new)_db");
        grants.add("h(script-old)_provider");
        grants.add("h(script-new)_mainDom");
        checklist.mockResolvedValue({ confirmed: true, checked: ["db", "provider", "globalStyle"] });

        expect(await reviewPluginPermissions(plugin, { previousScript: "script-old", installing: true })).toBe(true);

        const [message, items] = checklist.mock.calls[0];
        expect(message).toContain("Review");
        expect(message).toContain(language.pluginPermissionsCarriedOver);
        expect(message).toContain(language.pluginPermissionsInstallNote);
        expect(items.map((item) => item.id)).toEqual([
            "fetchLogs",
            "db",
            "dbWrite",
            "mainDom",
            "replacer",
            "provider",
            "sendChat",
            "inlay",
            "globalStyle",
        ]);
        expect(checkedIds()).toEqual(["db", "mainDom", "provider"]);

        expect(savedStanding).toHaveBeenCalledTimes(1);
        const [name, granted, removedGrants, removedTimes, expectedResets] = savedStanding.mock.calls[0];
        expect(name).toBe("review-plugin");
        expect(expectedResets).toBe(0);
        expect(granted).toEqual(["h(script-new)_db", "h(script-new)_provider", "h(script-new)_globalStyle"]);
        // Unchosen permissions of this script are revoked; chosen ones and other scripts' grants stay.
        expect(removedGrants("h(script-new)_mainDom")).toBe(true);
        expect(removedGrants("h(script-new)_db")).toBe(false);
        expect(removedGrants("h(script-old)_provider")).toBe(false);
        expect(removedGrants("h(script-old)_mainDom")).toBe(false);
        expect(removedTimes("review-plugin_mainDom_lastGrantTime")).toBe(true);
        expect(removedTimes("review-plugin_db_lastGrantTime")).toBe(false);
    });

    it("revokes an unchosen permission for the script of that name still running", async () => {
        const { plugin: running } = await makeApi("script-running");
        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });

        expect(await reviewPluginPermissions({ name: running.name, script: "script-stored" })).toBe(true);

        const [, granted, removedGrants] = savedStanding.mock.calls[0];
        expect(granted).toEqual(["h(script-stored)_db"]);
        expect(removedGrants("h(script-running)_mainDom")).toBe(true);
        expect(removedGrants("h(script-running)_db")).toBe(false);
    });

    it("saves against the reset count read when the list was opened, not the one at its answer", async () => {
        resets.set("review-plugin", 4);
        checklist.mockImplementation(async () => {
            // Another tab reset the plugin while the list was open.
            resets.set("review-plugin", 5);
            return { confirmed: true, checked: ["db"] };
        });
        await reviewPluginPermissions(plugin);
        expect(savedStanding.mock.calls[0][4]).toBe(4);
    });

    it("saves nothing and reports a stale list when its target changed while the list was open", async () => {
        const stillCurrent = vi.fn(() => false);
        // Declining never asks whether the target is still current.
        expect(await reviewPluginPermissions(plugin, { stillCurrent })).toBe(false);
        expect(stillCurrent).not.toHaveBeenCalled();

        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        await expect(reviewPluginPermissions(plugin, { stillCurrent })).rejects.toThrow(
            language.pluginPermissionsStale,
        );
        expect(savedStanding).not.toHaveBeenCalled();

        stillCurrent.mockReturnValue(true);
        expect(await reviewPluginPermissions(plugin, { stillCurrent })).toBe(true);
    });

    it("reports a list that a reset made stale in the user's language", async () => {
        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        savedStanding.mockRejectedValueOnce(new StalePermissionListError());
        await expect(reviewPluginPermissions(plugin)).rejects.toThrow(language.pluginPermissionsStale);
    });

    it("saves an empty list while a running script of that name, or a cached answer, still holds a permission", async () => {
        const { api, plugin: running } = await makeApi("script-running-grant");
        grants.add("h(script-running-grant)_mainDom");
        checklist.mockResolvedValue({ confirmed: true, checked: [] });
        expect(await reviewPluginPermissions({ name: running.name, script: "script-stored-empty" })).toBe(true);
        expect(savedStanding.mock.calls[0][2]("h(script-running-grant)_mainDom")).toBe(true);

        // A consent whose save failed holds only as a cached answer.
        grants.clear();
        savedStanding.mockClear();
        recorded.mockRejectedValueOnce(new Error("offline"));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        onTestFinished(() => error.mockRestore());
        expect(await api.requestPluginPermission("sendChat")).toBe(true);
        expect(await reviewPluginPermissions({ name: running.name, script: "script-running-grant" })).toBe(true);
        expect(savedStanding).toHaveBeenCalledTimes(1);
        confirm.mockResolvedValue(false);
        expect(await api.requestPluginPermission("sendChat")).toBe(false);
    });

    it("changes nothing when the user declines or confirms the list that is already saved", async () => {
        grants.add("h(script-new)_db");
        standing.add("h(script-new)_db");
        expect(await reviewPluginPermissions(plugin)).toBe(false);
        expect(checklist.mock.calls[0][0]).not.toContain(language.pluginPermissionsInstallNote);
        // Declining a changed list saves nothing either.
        grants.add("h(script-new)_mainDom");
        checklist.mockResolvedValueOnce({ confirmed: false, checked: ["db"] });
        expect(await reviewPluginPermissions(plugin)).toBe(false);
        grants.delete("h(script-new)_mainDom");

        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        expect(await reviewPluginPermissions(plugin)).toBe(false);
        expect(savedStanding).not.toHaveBeenCalled();
    });

    it("saves a prompt's grant as standing even when the checked list is unchanged", async () => {
        grants.add("h(script-new)_db");
        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        expect(await reviewPluginPermissions(plugin)).toBe(true);
        expect(savedStanding.mock.calls[0][1]).toEqual(["h(script-new)_db"]);
    });

    it("answers false to a prompt that was open when the list was saved, and records nothing for it", async () => {
        let answer!: (allowed: boolean) => void;
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
        const { api, plugin: running } = await makeApi("script-open-prompt");
        const pending = api.requestPluginPermission("sendChat");
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        let saving!: () => void;
        savedStanding.mockImplementationOnce(
            () => new Promise<undefined>((resolve) => (saving = () => resolve(undefined))),
        );
        const review = reviewPluginPermissions({ name: running.name, script: "script-open-prompt" });
        await vi.waitFor(() => expect(savedStanding).toHaveBeenCalledTimes(1));
        // Answered while the save is still on its way: the list being saved already wins.
        answer(true);
        expect(await pending).toBe(false);
        expect(recorded).not.toHaveBeenCalled();
        saving();
        expect(await review).toBe(true);
    });

    it("drops the plugin's cached answers when the list is saved, so a revoked permission asks again", async () => {
        const { api, plugin: running } = await makeApi("script-cached");
        expect(await api.requestPluginPermission("fetchLogs")).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);

        checklist.mockResolvedValue({ confirmed: true, checked: ["db"] });
        await reviewPluginPermissions({ name: running.name, script: "script-cached" });
        grants.delete("h(script-cached)_fetchLogs");
        confirm.mockResolvedValue(false);
        expect(await api.requestPluginPermission("fetchLogs")).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
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
