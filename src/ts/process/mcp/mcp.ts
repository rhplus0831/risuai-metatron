import { addAuthRefresh, addModule } from "src/ts/storage/collectionStore.svelte";
import { MCPClient, type JsonRPC, type MCPTool, type RPCToolCallContent } from "./mcplib";
import { DBState } from "src/ts/stores.svelte";
import { getModuleMcps } from "../modules";
import { alertError, alertInput, alertNormal } from "src/ts/alert";
import { v4 } from "uuid";
import type { MCPClientLike } from "./internalmcp";
import { registeredCustomPluginMCPs } from "./pluginmcp";
import { type ChatRef, findChat, mergeChatMeta } from "src/ts/storage/chatStore.svelte";
import { TAB_MCP_IDENTIFIERS } from "../../../../shared/jobs.ts";

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

export async function initializeMCPs(additionalMCPs?: string[]) {
    const mcpUrls = getModuleMcps();
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
        if (!MCPs[mcp]) {
            let mcpUrl = mcp;

            if (mcp.startsWith("internal:")) {
                switch (mcp) {
                    case "internal:fs":
                    case "internal:googlesearch": {
                        // Registered before its handshake, as every internal client is.
                        MCPs[mcp] = await tabClient(mcp);
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

                await MCPs[mcp].checkHandshake();
                continue;
            }

            if (mcp.startsWith("plugin:")) {
                const customMCP = registeredCustomPluginMCPs.get(mcp);
                if (customMCP) {
                    MCPs[mcp] = customMCP;
                    await MCPs[mcp].checkHandshake();
                    continue;
                }
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
                return DBState.db.authRefreshes.find((refresh) => refresh.url === mcp);
            };

            try {
                if (!mcpUrl.startsWith("https://") && !mcpUrl.startsWith("http://")) {
                    throw new Error("Invalid MCP URL");
                }

                const mcpClient = new MCPClient(mcpUrl);
                mcpClient.registerRefreshToken = registerRefresh;
                mcpClient.getRefreshToken = getRefresh;
                await mcpClient.checkHandshake();
                MCPs[mcp] = mcpClient;
            } catch (error) {
                console.error(`MCP: Failed to initialize MCP at ${mcp}:`, error);
            }
        }
    }

    for (const key of Object.keys(MCPs)) {
        if (!mcpUrls.includes(key)) {
            // A shared tab client stays as it is for a server job that uses it: only this reference goes.
            if (!TAB_MCP_IDENTIFIERS.includes(key)) {
                MCPs[key].destroy();
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
}

export async function getMCPTools(additionalMCPs?: string[]) {
    await initializeMCPs(additionalMCPs);
    const tools: MCPToolWithURL[] = [];
    for (const key of Object.keys(MCPs)) {
        const t = (await MCPs[key].getToolList()).map((tool) => {
            return {
                ...tool,
                mcpURL: key,
            };
        });

        tools.push(...t);
    }
    return tools;
}

export async function getMCPMeta(additionalMCPs?: string[]) {
    await initializeMCPs(additionalMCPs);
    const meta: Record<string, typeof MCPClient.prototype.serverInfo> = {};
    for (const key of Object.keys(MCPs)) {
        meta[key] = MCPs[key].serverInfo;
    }
    return meta;
}

export async function callMCPTool(methodName: string, args: any): Promise<RPCToolCallContent[]> {
    await initializeMCPs();
    const combinedMCPs = { ...MCPs, ...callOnlyMCPs };
    for (const key of Object.keys(combinedMCPs)) {
        const tools = await combinedMCPs[key].getToolList();
        const tool = tools.find((t) => t.name === methodName);
        if (tool) {
            return await combinedMCPs[key].callTool(methodName, args);
        }
    }
    return [
        {
            type: "text",
            text: `Tool ${methodName} not found on any MCP`,
        },
    ];
}

//Currently just a wrapper for getMCPTools, but can be extended later for more than MCPs
export async function getTools() {
    return await getMCPTools();
}

//Currently just a wrapper for callMCPTool, but can be extended later for more than MCPs
export async function callTool(methodName: string, args: any) {
    return await callMCPTool(methodName, args);
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
