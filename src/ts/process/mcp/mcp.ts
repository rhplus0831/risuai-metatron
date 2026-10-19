import { settings, type PresetScope } from "../../storage/settingsViews.svelte";
import { addAuthRefresh, addModule } from "src/ts/storage/collectionStore.svelte";
import { MCPClient, type JsonRPC, type MCPTool, type RPCToolCallContent } from "./mcplib";
import { getModuleMcps, type ModuleChatRef } from "../modules";
import { alertError, alertInput, alertNormal } from "src/ts/alert";
import { v4 } from "uuid";
import type { MCPClientLike } from "./internalmcp";
import { registeredCustomPluginMCPs } from "./pluginmcp";
import { type ChatRef, findChat, mergeChatMeta } from "src/ts/storage/chatStore.svelte";
import { TAB_MCP_IDENTIFIERS } from "../../../../shared/jobs.ts";
import type { PluginCallContext } from "../../plugins/apiV3/pluginContext";

export type MCPToolWithURL = MCPTool & {
    mcpURL: string;
};

export const MCPs: Record<string, MCPClient | MCPClientLike> = {};
export const callOnlyMCPs: Record<string, MCPClient | MCPClientLike> = {};
const callOnlyMCPUrls = ["internal:risuai"];

/**
 * The internal MCPs that live in the tab also for a server job (`TAB_MCP_IDENTIFIERS`): one instance
 * each for both paths (the browser registry below and a job's `mcpList`/`mcpTool` callbacks), so a
 * directory is picked once. The registry's cleanup drops its own reference only.
 */
const tabClients = new Map<string, Promise<MCPClientLike>>();
const tabHandshakes = new Map<string, Promise<unknown>>();

function tabClient(identifier: string): Promise<MCPClientLike> {
    let created = tabClients.get(identifier);
    if (!created) {
        created =
            identifier === "internal:fs"
                ? import("./filesystemclient").then(({ FileSystemClient }) => new FileSystemClient())
                : import("./googlesearchclient").then(({ GoogleSearchClient }) => new GoogleSearchClient());
        tabClients.set(identifier, created);
        created.catch(() => tabClients.delete(identifier));
    }
    return created;
}

/** The tab client of `identifier`, handshaken (concurrent first uses share one handshake). */
export async function readyTabClient(identifier: string): Promise<MCPClientLike> {
    const client = await tabClient(identifier);
    let handshake = tabHandshakes.get(identifier);
    if (!handshake) {
        handshake = client.checkHandshake().finally(() => tabHandshakes.delete(identifier));
        tabHandshakes.set(identifier, handshake);
    }
    await handshake;
    return client;
}

type AnyMCPClient = MCPClient | MCPClientLike;

/**
 * Consumers using a client now (a tool listing or a tool call, `syncMCPs` with `held`): an
 * initialization for another chat does not destroy a client in use; it is destroyed when its last
 * consumer ends.
 */
const leases = new Map<AnyMCPClient, number>();
const destroyWhenFree = new Set<AnyMCPClient>();

function takeLease(client: AnyMCPClient, held: AnyMCPClient[]) {
    leases.set(client, (leases.get(client) ?? 0) + 1);
    held.push(client);
}

function releaseLeases(held: readonly AnyMCPClient[]) {
    for (const client of held) {
        const count = (leases.get(client) ?? 1) - 1;
        if (count > 0) {
            leases.set(client, count);
            continue;
        }
        leases.delete(client);
        if (destroyWhenFree.delete(client)) {
            client.destroy();
        }
    }
}

/** Connects the MCP servers of `chatRef`'s modules (default: the selected chat's), plus `additionalMCPs`. */
export async function initializeMCPs(additionalMCPs?: string[], chatRef?: ModuleChatRef) {
    await syncMCPs(additionalMCPs, chatRef);
}

/**
 * `initializeMCPs`, answering this call's own clients (the servers of `chatRef`'s modules, the
 * additional ones, and the call-only ones), whatever another chat's initialization does to the
 * shared registry meanwhile. With `held`, each client is leased as soon as it is known (release with
 * `releaseLeases(held)`), so no other initialization destroys it while this caller uses it.
 */
async function syncMCPs(
    additionalMCPs: string[] | undefined,
    chatRef: ModuleChatRef,
    held?: AnyMCPClient[],
): Promise<{ active: Record<string, AnyMCPClient>; callOnly: Record<string, AnyMCPClient> }> {
    const own: Record<string, AnyMCPClient> = {};
    const keep = (mcp: string) => {
        const client = MCPs[mcp];
        if (client && !own[mcp]) {
            own[mcp] = client;
            if (held) {
                takeLease(client, held);
            }
        }
    };
    const mcpUrls = getModuleMcps(chatRef);
    if (additionalMCPs && additionalMCPs.length > 0) {
        for (const mcp of additionalMCPs) {
            if (!mcpUrls.includes(mcp)) {
                mcpUrls.push(mcp);
            }
        }
    }
    const callOnlyMCPUrlsThatIsNotInDefault: string[] = [];
    for (const mcp of callOnlyMCPUrls) {
        if (!mcpUrls.includes(mcp)) {
            mcpUrls.push(mcp);
            callOnlyMCPUrlsThatIsNotInDefault.push(mcp);
        }
    }
    for (const mcp of mcpUrls) {
        if (mcp.startsWith("plugin:")) {
            // Resolve every time: reloads can replace or remove a plugin's registered client.
            const client = registeredCustomPluginMCPs.get(mcp);
            if (client) {
                MCPs[mcp] = client;
                keep(mcp);
                await client.checkHandshake();
            } else {
                delete MCPs[mcp];
            }
            continue;
        }
        keep(mcp);
        if (!MCPs[mcp]) {
            let mcpUrl = mcp;

            if (mcp.startsWith("internal:")) {
                switch (mcp) {
                    case "internal:fs":
                    case "internal:googlesearch": {
                        // Registered before its handshake, as every internal client is.
                        MCPs[mcp] = await tabClient(mcp);
                        keep(mcp);
                        await readyTabClient(mcp);
                        continue;
                    }
                    case "internal:risuai": {
                        const { RisuAccessClient } = await import("./risuaccess");
                        MCPs[mcp] = new RisuAccessClient();
                        break;
                    }
                    case "internal:aiaccess": {
                        const { AIAccessClient } = await import("./aiaccess");
                        MCPs[mcp] = new AIAccessClient();
                        break;
                    }
                    case "internal:graphmem": {
                        const { GraphMemClient } = await import("./graphmem");
                        MCPs[mcp] = new GraphMemClient();
                        break;
                    }
                    case "internal:dice": {
                        const { DiceClient } = await import("./dice");
                        MCPs[mcp] = new DiceClient();
                        break;
                    }
                }

                keep(mcp);
                await own[mcp]?.checkHandshake();
                continue;
            }

            if (mcp.startsWith("stdio:")) {
                const MCPJSON = mcp.slice("stdio:".length);
                try {
                    const MCPData = JSON.parse(MCPJSON);
                    if (MCPData.url) {
                        mcpUrl = MCPData.url;
                    } else if (MCPData.command && MCPData.args) {
                        throw new Error("stdio MCPs are not supported");
                    } else {
                        throw new Error("MCP JSON does not contain a valid URL");
                    }
                } catch (error) {
                    throw new Error(`Failed to parse MCP JSON: ${error}`);
                }
            }

            const registerRefresh: typeof MCPClient.prototype.registerRefreshToken = (arg) => {
                addAuthRefresh({
                    url: mcp,
                    ...arg,
                });
            };

            const getRefresh: typeof MCPClient.prototype.getRefreshToken = async () => {
                return settings.authRefreshes.find((refresh) => refresh.url === mcp);
            };

            try {
                if (!mcpUrl.startsWith("https://") && !mcpUrl.startsWith("http://")) {
                    throw new Error("Invalid MCP URL");
                }

                const mcpClient = new MCPClient(mcpUrl);
                mcpClient.registerRefreshToken = registerRefresh;
                mcpClient.getRefreshToken = getRefresh;
                await mcpClient.checkHandshake();
                MCPs[mcp] ??= mcpClient;
                if (MCPs[mcp] !== mcpClient) {
                    // Another initialization connected it meanwhile: that client is the one.
                    mcpClient.destroy();
                }
                keep(mcp);
            } catch (error) {
                console.error(`MCP: Failed to initialize MCP at ${mcp}:`, error);
            }
        }
    }

    for (const key of Object.keys(MCPs)) {
        if (!mcpUrls.includes(key)) {
            // A shared tab client stays as it is for a server job that uses it: only this reference
            // goes. A client another call is using is destroyed when that call ends.
            if (!TAB_MCP_IDENTIFIERS.includes(key)) {
                if (leases.has(MCPs[key])) {
                    destroyWhenFree.add(MCPs[key]);
                } else {
                    MCPs[key].destroy();
                }
            }
            delete MCPs[key];
        }
    }

    for (const mcp of callOnlyMCPUrlsThatIsNotInDefault) {
        if (MCPs[mcp]) {
            callOnlyMCPs[mcp] = MCPs[mcp];
            delete MCPs[mcp];
        }
    }
    const active: Record<string, AnyMCPClient> = {};
    const callOnly: Record<string, AnyMCPClient> = {};
    for (const [mcp, client] of Object.entries(own)) {
        (callOnlyMCPUrlsThatIsNotInDefault.includes(mcp) ? callOnly : active)[mcp] = client;
    }
    return { active, callOnly };
}

/** The tools of `chatRef`'s MCP servers (its own clients, leased while they are listed). */
export async function getMCPTools(additionalMCPs?: string[], chatRef?: ModuleChatRef, context?: PluginCallContext) {
    const held: AnyMCPClient[] = [];
    try {
        const { active } = await syncMCPs(additionalMCPs, chatRef, held);
        const tools: MCPToolWithURL[] = [];
        for (const [key, client] of Object.entries(active)) {
            const t = (await (key.startsWith("plugin:") ? client.getToolList(context) : client.getToolList())).map(
                (tool) => {
                    return {
                        ...tool,
                        mcpURL: key,
                    };
                },
            );

            tools.push(...t);
        }
        return tools;
    } finally {
        releaseLeases(held);
    }
}

export async function getMCPMeta(additionalMCPs?: string[]) {
    await initializeMCPs(additionalMCPs);
    const meta: Record<string, typeof MCPClient.prototype.serverInfo> = {};
    for (const key of Object.keys(MCPs)) {
        meta[key] = MCPs[key].serverInfo;
    }
    return meta;
}

/**
 * An internal client whose tools act on a chat (`internal:graphmem`, `internal:risuai`): a call that
 * names its chat runs on that chat (null: none), never on the selection. `scope` is the request's
 * captured prompt and model preset, for a variable's preset default.
 */
type ChatToolClient = {
    callToolForChat(
        chatRef: ChatRef | null,
        toolName: string,
        args: any,
        scope?: PresetScope,
    ): Promise<RPCToolCallContent[]>;
};

function sameChat(a: ChatRef, b: ChatRef) {
    return a.chaId === b.chaId && a.chatId === b.chatId;
}

function isChatToolClient(client: AnyMCPClient): client is AnyMCPClient & ChatToolClient {
    return typeof (client as Partial<ChatToolClient>).callToolForChat === "function";
}

/**
 * Calls a tool on `chatRef`'s MCP servers (its own clients, leased for the call). A client whose
 * tools act on a chat runs them on `chatRef` too; without one (`undefined`, the Playground) it keeps
 * using the selection.
 */
export async function callMCPTool(
    methodName: string,
    args: any,
    chatRef?: ModuleChatRef,
    context?: PluginCallContext,
): Promise<RPCToolCallContent[]> {
    const held: AnyMCPClient[] = [];
    try {
        const { active, callOnly } = await syncMCPs(undefined, chatRef, held);
        const combinedMCPs = { ...active, ...callOnly };
        for (const key of Object.keys(combinedMCPs)) {
            const client = combinedMCPs[key];
            const isPlugin = key.startsWith("plugin:");
            const tools = await (isPlugin ? client.getToolList(context) : client.getToolList());
            const tool = tools.find((t) => t.name === methodName);
            if (tool) {
                if (isPlugin) {
                    return await client.callTool(methodName, args, context);
                }
                if (chatRef !== undefined && isChatToolClient(client)) {
                    // The context's preset is the request's when it was captured for the same chat.
                    const scope =
                        context && chatRef && sameChat(context.chatRef, chatRef)
                            ? { presetId: context.presetId, modelPresetId: context.modelPresetId }
                            : undefined;
                    return await client.callToolForChat(chatRef, methodName, args, scope);
                }
                return await client.callTool(methodName, args);
            }
        }
    } finally {
        releaseLeases(held);
    }
    return [
        {
            type: "text",
            text: `Tool ${methodName} not found on any MCP`,
        },
    ];
}

//Currently just a wrapper for getMCPTools, but can be extended later for more than MCPs
/** The tools for a request of `chatRef`'s chat (default: the selected chat; its modules choose the MCP servers). */
export async function getTools(chatRef?: ModuleChatRef, context?: PluginCallContext) {
    return await getMCPTools(undefined, chatRef, context);
}

//Currently just a wrapper for callMCPTool, but can be extended later for more than MCPs
export async function callTool(methodName: string, args: any, chatRef?: ModuleChatRef, context?: PluginCallContext) {
    return await callMCPTool(methodName, args, chatRef, context);
}

export async function importMCPModule() {
    const x = await alertInput("Please enter the URL of the MCP module to import:", [
        ["internal:aiaccess", "LLM Call Client (internal:aiaccess)"],
        ["internal:risuai", "Risu Access Client (internal:risuai)"],
        ["internal:fs", "File System Client (internal:fs)"],
        ["internal:googlesearch", "Google Search Client (internal:googlesearch)"],
        ["internal:dice", "Dice Tool Client (internal:dice)"],
        ["internal:graphmem", "Graph Memory Client (internal:graphmem)"],
        ["https://mcp.paypal.com/sse", "PayPal MCP (https://mcp.paypal.com/sse)"],
        ["https://mcp.linear.app/sse", "Linear MCP (https://mcp.linear.app/sse)"],
        ["https://rag-mcp-2.whatsmcp.workers.dev/sse", "OneContext MCP (https://rag-mcp-2.whatsmcp.workers.dev/sse)"],
        ["https://browser.mcp.cloudflare.com/sse", "Cloudflare Browser MCP (https://browser.mcp.cloudflare.com/sse)"],
        ["https://mcp.deepwiki.com/mcp", "DeepWiki MCP (https://mcp.deepwiki.com/mcp)"],
    ]);

    if (
        !x.startsWith("http://localhost") &&
        !x.startsWith("http://127") &&
        !x.startsWith("https:") &&
        !x.startsWith("internal:") &&
        !x.startsWith("stdio:") &&
        !x.startsWith("plugin:")
    ) {
        alertError("Invalid URL");
        return;
    }
    try {
        const metas = await getMCPMeta([x]);
        console.log(metas);
        const meta = metas[x];
        if (!meta) {
            alertError("MCP module not found or invalid URL");
            return;
        }
        addModule({
            name: meta.serverInfo.name,
            description: "MCP from " + x,
            mcp: {
                url: x,
            },
            id: v4(),
            lorebook: [
                {
                    comment: "MCP Info",
                    content: `@@mcp\n\n<MCP Info>Name:${meta.serverInfo.name}\nVersion:${meta.serverInfo.version}\nInst:${meta.instructions ?? "None"}</MCP Info>`,
                    key: "",
                    alwaysActive: true,
                    secondkey: "",
                    insertorder: 0,
                    mode: "normal",
                    selective: false,
                },
            ],
        });
        alertNormal(`MCP module imported successfully!\nName: ${meta.serverInfo.name}`);
    } catch (error) {
        alertError(error);
    }
}

export type toolCallData = {
    call: {
        id: string;
        name: string;
        arg: any;
    };
    response: RPCToolCallContent[];
};

let droppedLogged = false;

/**
 * Remembers a tool call and gives its marker. It is stored with the request's chat (`chat.toolCalls`,
 * Phase 5 slice 11b), where the server reads it too; a request without a chat, or whose chat is
 * gone, remembers nothing (the browser's own LocalForage store was removed at the cutover).
 */
export async function encodeToolCall(call: toolCallData, chatRef?: ChatRef | null) {
    call.call.id = call.call.id || v4();
    if (chatRef && findChat(chatRef)) {
        mergeChatMeta(chatRef, "toolCalls", { [call.call.id]: call });
    } else if (!droppedLogged) {
        droppedLogged = true;
        console.warn("[MCP] A tool call without a chat is not remembered");
    }
    return `<tool_call>${call.call.id}\uf100${call.call.name}</tool_call>\n\n`;
}

/**
 * The remembered call a marker (whole, or its inner text) stands for, from the chat's own record
 * (`chatRef`). A marker remembered in the browser's former LocalForage store (before slice 11b, or
 * without a chat) no longer resolves.
 */
export async function decodeToolCall(text: string, chatRef?: ChatRef | null): Promise<toolCallData | undefined> {
    text = text.trim();
    if (text.startsWith("<tool_call>")) {
        // The opening tag is cut off (the end bound used to be 0, which emptied the text).
        text = text.slice("<tool_call>".length).trim();
    }
    if (text.endsWith("</tool_call>")) {
        text = text.slice(0, -"</tool_call>".length).trim();
    }
    const [callId] = text.split("\uf100");
    if (!callId) {
        return undefined;
    }
    const stored = chatRef ? findChat(chatRef)?.toolCalls : undefined;
    if (stored && Object.hasOwn(stored, callId)) {
        return JSON.parse(JSON.stringify(stored[callId])) as toolCallData;
    }
    return undefined;
}
