import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";
import { invokeHook, type PluginCallContext } from "../../plugins/apiV3/pluginContext";

export const registeredCustomPluginMCPs: Map<string, CustomPluginMCPClient> = new Map();

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

export async function unregisterMCPModule(identifier: string) {
    const client = registeredCustomPluginMCPs.get(identifier);
    registeredCustomPluginMCPs.delete(identifier);
    // The tab registry also retains clients between requests. Do not leave a dead sandbox there.
    // Load it here to avoid an initialization cycle through the plugin host and module parser.
    const { MCPs, callOnlyMCPs } = await import("./mcp");
    for (const registry of [MCPs, callOnlyMCPs]) {
        if (registry[identifier] === client || !registeredCustomPluginMCPs.has(identifier)) {
            delete registry[identifier];
        }
    }
}
