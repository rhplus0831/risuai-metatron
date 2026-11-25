import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";
import { invokeHook, type PluginCallContext } from "../../plugins/apiV3/pluginContext";

/**
 * Current plugin clients, read on every `syncMCPs` in `src/ts/process/mcp/mcp.ts` and by
 * `src/ts/network/jobChannel.ts` for the job's `mcpTools` identifiers and `mcpList`/`mcpTool`
 * callbacks. Callbacks resolve the current registration rather than retaining the client at job creation.
 */
export const registeredCustomPluginMCPs: Map<string, CustomPluginMCPClient> = new Map();

/**
 * Hands each call's context directly to the stored callbacks through `invokeHook`.
 * `registerMCP` in `src/ts/plugins/apiV3/v3.svelte.ts` wraps those callbacks per plugin instance
 * with `withContext` and installs unload cleanup guarded by this client's identity.
 */
export class CustomPluginMCPClient extends MCPClientLike {
    #getToolList: () => Promise<MCPTool[]>;
    #callTool: (toolName: string, content: any) => Promise<RPCToolCallContent[]>;
    constructor(arg: {
        identifier: string;
        name: string;
        version: string;
        description: string;
        getToolList: () => Promise<MCPTool[]>;
        callTool: (toolName: string, content: any) => Promise<RPCToolCallContent[]>;
    }) {
        super(arg.identifier);
        this.serverInfo.serverInfo.name = arg.name;
        this.serverInfo.serverInfo.version = arg.version;
        this.serverInfo.instructions = arg.description;
        this.#getToolList = arg.getToolList;
        this.#callTool = arg.callTool;
    }

    async getToolList(context?: PluginCallContext) {
        return await invokeHook(this.#getToolList, context);
    }

    async callTool(toolName: string, args: any, context?: PluginCallContext) {
        return await invokeHook(this.#callTool, context, toolName, args);
    }
}

export function registerMCPModule(
    arg: {
        identifier: string;
        name: string;
        version: string;
        description: string;
    },
    getToolList: () => Promise<MCPTool[]>,
    callTool: (toolName: string, content: any) => Promise<RPCToolCallContent[]>,
) {
    if (!arg.identifier.startsWith("plugin:")) {
        throw new Error(`MCP module identifier must start with 'plugin:'.`);
    }
    const client = new CustomPluginMCPClient({
        ...arg,
        getToolList,
        callTool,
    });
    registeredCustomPluginMCPs.set(arg.identifier, client);
    return client;
}

/**
 * Deletes the registration, then loads `src/ts/process/mcp/mcp.ts` to remove retained tab entries.
 * Each `MCPs`/`callOnlyMCPs` entry is dropped if it is the removed client or the identifier is still
 * unregistered after the import; a newly registered replacement already in a registry is retained.
 * The dynamic import avoids an initialization cycle through the plugin host and module parser.
 */
export async function unregisterMCPModule(identifier: string) {
    const client = registeredCustomPluginMCPs.get(identifier);
    registeredCustomPluginMCPs.delete(identifier);
    const { MCPs, callOnlyMCPs } = await import("./mcp");
    for (const registry of [MCPs, callOnlyMCPs]) {
        if (registry[identifier] === client || !registeredCustomPluginMCPs.has(identifier)) {
            delete registry[identifier];
        }
    }
}
