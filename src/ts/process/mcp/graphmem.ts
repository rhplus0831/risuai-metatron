import { getChatVar, setChatVar } from "src/ts/parser/chatVar.svelte";
import { callGraphMemTool, GRAPHMEM_TOOLS, type GraphMemHost } from "../../../../shared/mcp/graphmem.ts";
import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";
import { HypaProcesser } from "../memory/hypamemory";

/** The graph memory tools' host in the tab: the selected chat's variable and the tab's embeddings. */
const tabGraphMemHost: GraphMemHost = {
    getVar: (key) => getChatVar(key),
    setVar: (key, value) => setChatVar(key, value),
    search: async (names) => {
        const processer = new HypaProcesser();
        await processer.embedDocuments(names);
        return (term) => processer.similaritySearch(term);
    },
};

export class GraphMemClient extends MCPClientLike {
    constructor() {
        super("internal:graphmem");
        this.serverInfo.serverInfo.name = "GraphMem";
        this.serverInfo.serverInfo.version = "1.0.0";
        this.serverInfo.instructions = "Memory management using graph database.";
    }

    async getToolList(): Promise<MCPTool[]> {
        return GRAPHMEM_TOOLS;
    }

    async callTool(toolName: string, args: any): Promise<RPCToolCallContent[]> {
        return await callGraphMemTool(tabGraphMemHost, toolName, args);
    }
}
