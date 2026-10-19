import { getChatVar, getChatVarOf, setChatVar, setChatVarOf } from "src/ts/parser/chatVar.svelte";
import { callGraphMemTool, GRAPHMEM_TOOLS, type GraphMemHost } from "../../../../shared/mcp/graphmem.ts";
import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";
import { HypaProcesser } from "../memory/hypamemory";
import { type ChatRef, findChat } from "src/ts/storage/chatStore.svelte";
import type { PresetScope } from "src/ts/storage/settingsViews.svelte";

async function search(names: string[]) {
    const processer = new HypaProcesser();
    // `addText` stores the vectors `similaritySearch` ranks (`embedDocuments` only returns them).
    await processer.addText(names);
    return (term: string) => processer.similaritySearch(term);
}

/** The graph memory tools' host in the tab for a call without a chat: the selected chat's variable. */
const selectedGraphMemHost: GraphMemHost = {
    getVar: (key) => getChatVar(key),
    setVar: (key, value) => setChatVar(key, value),
    search,
};

/**
 * The host for a request's chat: its variable by id, whatever the selection is (the server's job
 * host keeps the graph in the job chat the same way). The preset default is `scope`'s, else the
 * chat's display preset.
 */
function chatGraphMemHost(ref: ChatRef, scope: PresetScope | undefined): GraphMemHost {
    return {
        getVar: (key) => getChatVarOf(ref, key, scope),
        setVar: (key, value) => setChatVarOf(ref, key, value),
        search,
    };
}

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

    /** A call without a chat (the Playground): the selected chat. */
    async callTool(toolName: string, args: any): Promise<RPCToolCallContent[]> {
        return await callGraphMemTool(selectedGraphMemHost, toolName, args);
    }

    /**
     * A request's call (`callMCPTool`): the graph of `chatRef`. The chat must be loaded (the request
     * pins and loads it until its events end); a missing chat or none is an error answer, not a graph
     * written nowhere.
     */
    async callToolForChat(
        chatRef: ChatRef | null,
        toolName: string,
        args: any,
        scope?: PresetScope,
    ): Promise<RPCToolCallContent[]> {
        if (!chatRef) {
            return [{ type: "text", text: "Error: The graph memory needs a chat, and this request has none." }];
        }
        if (!findChat(chatRef)) {
            return [{ type: "text", text: "Error: The chat this request is for is not loaded." }];
        }
        return await callGraphMemTool(chatGraphMemHost(chatRef, scope), toolName, args);
    }
}
