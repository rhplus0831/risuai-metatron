import { AIACCESS_TOOLS, callAiAccessTool } from "../../../../shared/mcp/aiaccess.ts";
import { capturePluginContext } from "../../plugins/apiV3/pluginContext";
import type { ChatRef } from "../../storage/chatStore.svelte";
import { activePersona, type PresetScope } from "../../storage/settingsViews.svelte";
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
        return await this.callToolForChat(null, methodName, args);
    }

    async callToolForChat(
        chatRef: ChatRef | null,
        methodName: string,
        args: any,
        scope?: PresetScope,
    ): Promise<RPCToolCallContent[]> {
        const context = capturePluginContext(chatRef);
        const pluginContext = context && scope ? { ...context, ...scope } : context;
        const requestIds = !chatRef && scope ? { ...scope, personaId: activePersona.id ?? "" } : undefined;
        return await callAiAccessTool(
            {
                runLLM: (formated, mode) =>
                    requestChatData({ formated, bias: {}, chatRef, pluginContext, requestIds }, mode),
            },
            methodName,
            args,
        );
    }
}
