import { AIACCESS_TOOLS, callAiAccessTool } from "../../../../shared/mcp/aiaccess.ts";
import { requestChatData } from "../request/request";
import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";

export class AIAccessClient extends MCPClientLike {
    private directoryHandle: FileSystemDirectoryHandle | null = null;
    private initialized: boolean = false;

    constructor() {
        super("internal:aiaccess");
        this.serverInfo.serverInfo.name = "AI Access Client";
        this.serverInfo.instructions = "Client for accessing AI services and tools.";
    }
    async getToolList(): Promise<MCPTool[]> {
        return AIACCESS_TOOLS;
    }

    async callTool(methodName: string, args: any): Promise<RPCToolCallContent[]> {
        return await callAiAccessTool(
            { runLLM: (formated, mode) => requestChatData({ formated, bias: {} }, mode) },
            methodName,
            args,
        );
    }
}
