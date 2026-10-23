import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `pluginWorkIdle` / `onPluginWorkChange` (`plugins-mcp.md` Flows step 6): the idle definition a
// deferred reload waits for, collected over the tab's sends (`localSends`), the jobs' plugin work
// (`generationJobs.ts`), the host-side hook invocations still running (a wrapped hook; a provider
// from before its permission prompt), and each loaded sandbox's `isIdle`. The sandbox is mocked
// with a controllable idle flag; the job channel is real.

type CapturedApi = Record<string, (...args: any[]) => any>;

const harness = vi.hoisted(() => ({
    db: { characters: [] as any[], plugins: [] as any[], pluginCustomStorage: undefined as any },
    hosts: [] as { idle: boolean; listener: (() => void) | null }[],
    captured: { api: null as CapturedApi | null },
    confirm: vi.fn(async () => true),
}));

vi.mock("./factory", () => ({
    SandboxHost: class {
        idle = true;
        listener: (() => void) | null = null;
        constructor(apiFactory: CapturedApi) {
            harness.captured.api = apiFactory;
            harness.hosts.push(this);
        }
        run() {}
        onActivityChanged(listener: () => void) {
            this.listener = listener;
        }
        isIdle() {
            return this.idle;
        }
        terminate() {
            this.idle = true;
        }
    },
}));
vi.mock("src/ts/storage/database.svelte", () => ({
    getDatabase: () => harness.db,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    setCurrentChat: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: harness.confirm,
    }),
);
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async (bytes: Uint8Array) => `h(${new TextDecoder().decode(bytes)})`),
    risuChatParser: vi.fn((text: string) => text),
    risuUnescape: (text: string) => text,
}));
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => false,
    getLastGrantTime: () => undefined,
    recordPermissionGrants: vi.fn(async () => undefined),
}));

import { executePluginV3, loadV3Plugins, onPluginWorkChange, pluginWorkIdle } from "./v3.svelte";
import { noteChannelCallbacks } from "src/ts/network/generationJobs";
import { endJobChannel, handleChannelEvent } from "src/ts/network/jobChannel";
import { beginLocalSend } from "src/ts/process/localSends";
import type { ChatRef } from "src/ts/storage/chatStore.svelte";
import * as resourceSync from "src/ts/storage/resourceSync.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { pluginHooks, type PluginProviderArgument } from "../pluginHooks";
import { invokeHook } from "./pluginContext";

installFlatDatabase({ characters: [], plugins: [] });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let counter = 0;
let changed: ReturnType<typeof vi.fn<() => void>>;
let unsubscribe: () => void;
const chatA: ChatRef = { chaId: "a", chatId: "a0" };
const chatB: ChatRef = { chaId: "b", chatId: "b0" };
/** The sends begun on the registry, released at the test's end at the latest. */
const releases: (() => void)[] = [];
const send = (ref: ChatRef) => {
    const release = beginLocalSend(ref)!;
    expect(release).not.toBeNull();
    releases.push(release);
    return release;
};

async function makeApi(): Promise<{ api: CapturedApi; plugin: any }> {
    harness.captured.api = null;
    const plugin = { name: `idle-test-${++counter}`, script: `script ${counter}`, version: "3.0" };
    harness.db.plugins = [plugin];
    await executePluginV3(plugin as any);
    expect(harness.captured.api).not.toBeNull();
    return { api: harness.captured.api!, plugin };
}

const argument = (): PluginProviderArgument => ({
    prompt_chat: [{ role: "user", content: "A prompt" }],
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

beforeEach(() => {
    harness.hosts.length = 0;
    harness.confirm.mockReset().mockResolvedValue(true);
    changed = vi.fn<() => void>();
    unsubscribe = onPluginWorkChange(changed);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(pluginWorkIdle()).toBe(true);
});

afterEach(async () => {
    unsubscribe();
    await loadV3Plugins([]);
    for (const release of releases.splice(0)) {
        release();
    }
    vi.restoreAllMocks();
});

describe("pluginWorkIdle", () => {
    it("is false while a provider awaits its permission prompt, before any guest callback exists", async () => {
        const consent = deferred<boolean>();
        harness.confirm.mockReturnValueOnce(consent.promise);
        const { api } = await makeApi();
        const answer = deferred<{ success: boolean; content: string }>();
        const func = vi.fn(async () => answer.promise);
        api.addProvider("consent-provider", func);
        const hook = pluginHooks.providers.get("consent-provider")!;

        const running = invokeHook(hook, undefined, argument(), new AbortController().signal);
        await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1));
        expect(func).not.toHaveBeenCalled();
        expect(pluginWorkIdle()).toBe(false);

        consent.resolve(true);
        await vi.waitFor(() => expect(func).toHaveBeenCalledTimes(1));
        expect(pluginWorkIdle()).toBe(false);
        changed.mockClear();
        answer.resolve({ success: true, content: "done" });
        await expect(running).resolves.toEqual({ success: true, content: "done" });
        expect(pluginWorkIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();
    });

    it("is false while a wrapped hook runs; a hook that throws synchronously settles at once", async () => {
        const { api } = await makeApi();
        const gate = deferred<string>();
        api.addRisuScriptHandler("input", () => gate.promise);
        const [handler] = [...pluginHooks.editinput];

        const running = handler("text");
        expect(pluginWorkIdle()).toBe(false);
        changed.mockClear();
        gate.resolve("edited");
        await expect(running).resolves.toBe("edited");
        expect(pluginWorkIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();

        api.addRisuScriptHandler("output", () => {
            throw new Error("sync failure");
        });
        const [thrower] = [...pluginHooks.editoutput];
        expect(() => thrower("text")).toThrow("sync failure");
        expect(pluginWorkIdle()).toBe(true);
    });

    it("is false while a job channel callback runs, until its answer is sent", async () => {
        const { api, plugin } = await makeApi();
        const answer = deferred<{ success: boolean; content: string }>();
        const func = vi.fn(async () => answer.promise);
        const name = `channel-provider-${plugin.name}`;
        api.addProvider(name, func);
        const send = vi.fn(() => true);
        const flush = vi.spyOn(resourceSync, "flushResources").mockResolvedValue({ discarded: [] });
        const jobId = `job-${plugin.name}`;
        try {
            handleChannelEvent(
                jobId,
                {
                    type: "callback",
                    epoch: "epoch-1",
                    jobId,
                    id: `callback-${plugin.name}`,
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
            expect(pluginWorkIdle()).toBe(false);
            await vi.waitFor(() => expect(func).toHaveBeenCalledTimes(1));
            expect(pluginWorkIdle()).toBe(false);
            changed.mockClear();
            answer.resolve({ success: true, content: "answered" });
            await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
            expect(pluginWorkIdle()).toBe(true);
            expect(changed).toHaveBeenCalled();
        } finally {
            endJobChannel(jobId);
            flush.mockRestore();
        }
    });

    it("is false during a send, while a job holds plugin work, or while a sandbox is busy; each notifies", async () => {
        await makeApi();
        const [host] = harness.hosts;

        const release = send(chatA);
        expect(pluginWorkIdle()).toBe(false);
        changed.mockClear();
        release();
        expect(pluginWorkIdle()).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);

        noteChannelCallbacks(1);
        expect(pluginWorkIdle()).toBe(false);
        changed.mockClear();
        noteChannelCallbacks(0);
        expect(pluginWorkIdle()).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);

        host.idle = false;
        expect(pluginWorkIdle()).toBe(false);
        changed.mockClear();
        host.listener!();
        expect(changed).toHaveBeenCalledTimes(1);
        host.idle = true;
        expect(pluginWorkIdle()).toBe(true);

        // An unloaded sandbox no longer counts, and its unload notifies.
        host.idle = false;
        changed.mockClear();
        await loadV3Plugins([]);
        expect(pluginWorkIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();

        // An unsubscribed listener hears nothing more.
        unsubscribe();
        changed.mockClear();
        noteChannelCallbacks(1);
        noteChannelCallbacks(0);
        send(chatA)();
        expect(changed).not.toHaveBeenCalled();
    });

    it("stays busy until the last of two sends ends, and reports idle at that final release", () => {
        const observed: boolean[] = [];
        changed.mockImplementation(() => observed.push(pluginWorkIdle()));
        const releaseA = send(chatA);
        const releaseB = send(chatB);
        expect(pluginWorkIdle()).toBe(false);
        observed.length = 0;

        releaseA();
        expect(pluginWorkIdle()).toBe(false);
        expect(observed).not.toContain(true);

        releaseB();
        expect(pluginWorkIdle()).toBe(true);
        expect(observed.at(-1)).toBe(true);
    });
});
