import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAnswer } from "../../../../shared/jobs.ts";

type Api = Record<string, (...args: any[]) => any>;
const harness = vi.hoisted(() => ({
    api: null as Api | null,
    mcps: [] as string[],
    fetch: vi.fn(),
    internal: {
        list: vi.fn(async () => [{ name: "local_tool", description: "local", inputSchema: { type: "object" } }]),
        call: vi.fn(async () => [{ type: "text", text: "local result" }]),
    },
}));
vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(api: Api) {
            harness.api = api;
        }
        run() {}
        terminate() {}
    },
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    appendFetchLog: vi.fn(),
    getFetchLogs: vi.fn(),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
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
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(),
}));

vi.mock("src/ts/process/mcp/filesystemclient", () => ({
    FileSystemClient: class {
        getToolList = harness.internal.list;
        callTool = harness.internal.call;
        async checkHandshake() {}
        destroy() {}
    },
}));
vi.mock("src/ts/process/mcp/googlesearchclient", () => ({
    GoogleSearchClient: class {
        getToolList = harness.internal.list;
        callTool = harness.internal.call;
        async checkHandshake() {}
        destroy() {}
    },
}));
vi.mock("src/ts/storage/serverAuth", () => ({
    authFetch: (...args: unknown[]) => harness.fetch(...args),
    getNodeServerProxyAuth: async () => "",
}));

import { executePluginV3, loadV3Plugins } from "./v3.svelte";
import { capturePluginContext } from "./pluginContext";
import { callTool, getTools, initializeMCPs } from "src/ts/process/mcp/mcp";
import { handleChannelEvent, endJobChannel } from "src/ts/network/jobChannel";
import { requestChatData } from "src/ts/process/request/request";
import { requestServer } from "src/ts/process/request/transport";
import * as resourceSync from "src/ts/storage/resourceSync.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    selectCharacter,
    selectPreset,
    selectModelPreset,
    selectPersona,
    selection,
} from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";

const refB = { chaId: "b", chatId: "chat-b" };
const character = (id: string) => {
    const found = characterList().find((c) => c.chaId === id)!;
    if (found.type === "group") throw new Error("Expected an individual character");
    return found;
};
const preset = (id: string) => settings.presets.find((p) => p.id === id)!;
const identifier = "plugin:context";
const schema = (name: string) => ({ name, description: "Inspect the target", inputSchema: { type: "object" } });
let api: Api;
let serial = 0;
const jobs: string[] = [];
beforeEach(async () => {
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? value : JSON.parse(JSON.stringify(value)),
    );
    installFlatDatabaseWithChats({
        botPresets: [
            { id: "a", name: "A", temperature: 10, aiModel: "reverse_proxy" },
            { id: "b", name: "B", temperature: 20, aiModel: "reverse_proxy" },
        ],
        personas: [{ id: "p", name: "Persona", icon: "", personaPrompt: "" }],
        characters: ["a", "b"].map((id) => ({
            chaId: id,
            name: id.toUpperCase(),
            type: "character",
            desc: `original ${id}`,
            chatPage: 0,
            customscript: [],
            triggerscript: [],
            globalLore: [],
            chats: [
                {
                    id: `chat-${id}`,
                    name: id,
                    message: [],
                    note: "",
                    localLore: [],
                    modelPresetId: id,
                    promptPresetId: id,
                    bindedPersona: "p",
                },
            ],
        })),
        characterOrder: ["a", "b"],
        plugins: [],
        modules: [],
        enabledModules: [],
        useStreaming: false,
        genTime: 1,
        requestRetrys: 0,
        banCharacterset: [],
    });
    selectCharacter("a");
    selectPreset("a");
    selectModelPreset("a");
    selectPersona("p");
    harness.mcps = [];
    harness.fetch.mockReset();
    harness.internal.list.mockClear();
    harness.internal.call.mockClear();
    vi.spyOn(resourceSync, "flushResources").mockResolvedValue({ discarded: [] });
    await executePluginV3({ name: `mcp-context-${++serial}`, version: "3.0", script: "" } as never);
    api = harness.api!;
});
afterEach(async () => {
    for (const job of jobs.splice(0)) endJobChannel(job);
    await loadV3Plugins([]);
    harness.mcps = [];
    await initializeMCPs();
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function editTarget(label: string, temperature: number) {
    await Promise.resolve(); // The context must survive a callback's asynchronous work.
    const target = await api.getChar();
    target.desc = label;
    await api.setChar(target);
    await api.setDatabase({ temperature });
    return target.chaId;
}
async function register() {
    await api.registerMCP(
        { identifier, name: "Context", version: "1", description: "Context" },
        async () => [schema(`inspect_${await editTarget("listed", 31)}`)],
        async () => [{ type: "text", text: await editTarget("called", 42) }],
    );
    harness.mcps = [identifier];
}
function expectTarget(label: string, temperature: number) {
    expect(character("b").desc).toBe(label);
    expect(preset("b").temperature).toBe(temperature);
    expect(character("a").desc).toBe("original a");
    expect(preset("a").temperature).toBe(10);
    expect(selection.characterId).toBe("a");
}
async function jobCallback(name: "mcpList" | "mcpTool", id = identifier) {
    const jobId = `context-job-${++serial}`;
    jobs.push(jobId);
    return new Promise<ChannelAnswer>((resolve) =>
        handleChannelEvent(
            jobId,
            {
                type: "callback",
                epoch: "context-epoch",
                id: `callback-${serial}`,
                jobId,
                name,
                targets: capturePluginContext(refB)!,
                revisions: [],
                deadline: Date.now() + 10_000,
                payload: { identifier: id, tool: "inspect_b", args: { from: "job" } },
            },
            {
                send: (message) => {
                    resolve(message as ChannelAnswer);
                    return true;
                },
            },
        ),
    );
}

// Real transport/SSE handling, with the provider's events and the server's callback answer endpoint
// controlled here. A result is sent only after the callback answer, as on the real server.
function serverReply(callback = false) {
    const posted: any[] = [];
    const answers: any[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const event = (value: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    const finish = () => {
        event({ type: "result", response: { type: "success", result: "ok" } });
        stream.close();
    };
    harness.fetch.mockImplementation(async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (url === "/api/llm/request") {
            posted.push(body);
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        stream = controller;
                        event({ type: "accepted", id: "request-context" });
                        if (callback)
                            event({
                                type: "callback",
                                id: "tool-context",
                                name: "mcpTool",
                                payload: { name: "inspect_b", args: {} },
                            });
                        else finish();
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            );
        }
        if (url === "/api/llm/request/request-context/answer") {
            answers.push(body);
            finish();
            return Response.json({ accepted: true });
        }
        throw new Error(`Unexpected URL ${url}`);
    });
    return { posted, answers };
}
const request = () => ({
    formated: [{ role: "user" as const, content: "hi" }],
    bias: {},
    useStreaming: false,
    chatRef: refB,
    pluginContext: capturePluginContext(refB)!,
});

describe("plugin MCP call context", () => {
    it("runs job mcpList callbacks against B's character and preset while A is selected", async () => {
        await register();
        expect(await jobCallback("mcpList")).toMatchObject({ outcome: "answered", value: [schema("inspect_b")] });
        expectTarget("listed", 31);
        expect((await api.getChar()).chaId).toBe("a");
    });
    it("runs job mcpTool callbacks against B's character and preset while A is selected", async () => {
        await register();
        expect(await jobCallback("mcpTool")).toMatchObject({
            outcome: "answered",
            value: [{ type: "text", text: "b" }],
        });
        expectTarget("called", 42);
        expect((await api.getChar()).chaId).toBe("a");
    });
    it("lists the tab request's tools using B's context through requestChatData and getTools", async () => {
        await register();
        const server = serverReply();
        expect(await requestChatData(request(), "model")).toMatchObject({ type: "success" });
        expect(server.posted[0].tools).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "inspect_b" })]),
        );
        expectTarget("listed", 31);
    });
    it("answers a tab mcpTool callback with B's context for both ownership listing and execution", async () => {
        await register();
        const server = serverReply(true);
        expect(
            await requestServer(request(), "model", null, { id: "reverse_proxy", flags: [], tokenizer: 1 } as never),
        ).toMatchObject({ type: "success" });
        expect(server.answers).toEqual([
            expect.objectContaining({
                callbackId: "tool-context",
                outcome: "answered",
                value: [{ type: "text", text: "b" }],
            }),
        ]);
        expectTarget("called", 42);
        expect((await api.getChar()).chaId).toBe("a");
    });
    it.each(["internal:fs", "internal:googlesearch"])(
        "passes no plugin context to %s on either dispatch path",
        async (id) => {
            harness.mcps = [id];
            expect(await jobCallback("mcpList", id)).toMatchObject({ outcome: "answered" });
            expect(await jobCallback("mcpTool", id)).toMatchObject({ outcome: "answered" });
            expect(await getTools(refB, capturePluginContext(refB))).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "local_tool" })]),
            );
            expect(await callTool("local_tool", {}, refB, capturePluginContext(refB))).toEqual([
                { type: "text", text: "local result" },
            ]);
            for (const args of harness.internal.list.mock.calls) expect(args).toEqual([]);
            for (const args of harness.internal.call.mock.calls) expect(args).toHaveLength(2);
        },
    );
});
