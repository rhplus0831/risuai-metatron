//Although these are TECHNICALLY not MCPs, but for the users, we will stick to that name

import type { MCPTool, RPCToolCallContent } from "./mcplib";
import type { PluginCallContext } from "../../plugins/apiV3/pluginContext";

/**
 * Base for internal and plugin clients. The remote client is `src/ts/process/mcp/mcplib.ts`.
 * Listing and calls accept a trailing caller signal for cancellable network work.
 * Dispatchers pass the optional trailing `context` only to `plugin:` clients. A client whose tools
 * act on a chat also implements `callToolForChat(chatRef, name, args, scope?)`:
 * `callMCPTool` in `src/ts/process/mcp/mcp.ts` uses it for any supplied chat argument, including
 * `null`, and uses `callTool` only when that argument is `undefined` (no request chat).
 */
export class MCPClientLike {
    url: string;
    serverInfo: {
        protocolVersion: string;
        capabilities: {
            [key: string]: any;
        };
        serverInfo: {
            name: string;
            version: string;
        };
        instructions?: string;
    };

    constructor(url: string) {
        this.url = url;
        this.serverInfo = {
            protocolVersion: "2025-03-26",
            capabilities: {
                tools: {},
            },
            serverInfo: {
                name: "Internal Tool",
                version: "1.0.0",
            },
        };
    }

    async checkHandshake() {
        return this.serverInfo;
    }

    async getToolList(_context?: PluginCallContext, _signal?: AbortSignal): Promise<MCPTool[]> {
        return [];
    }

    async callTool(
        toolName: string,
        args: any,
        _context?: PluginCallContext,
        _signal?: AbortSignal,
    ): Promise<RPCToolCallContent[]> {
        return [
            {
                type: "text",
                text: `Tool ${toolName} not implemented`,
            },
        ];
    }

    destroy() {
        // No cleanup needed for internal tools
    }
}
