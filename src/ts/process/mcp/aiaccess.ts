import { AIACCESS_TOOLS, callAiAccessTool } from "../../../../shared/mcp/aiaccess.ts";
import { capturePluginContext } from "../../plugins/apiV3/pluginContext";
import type { ChatRef } from "../../storage/chatStore.svelte";
import { activePersona, type PresetScope } from "../../storage/settingsViews.svelte";
import { requestChatData } from "../request/request";
import { MCPClientLike } from "./internalmcp";
import type { MCPTool, RPCToolCallContent } from "./mcplib";

/**
 * The tab's host of `shared/mcp/aiaccess.ts`; `server/src/mcp/internal.ts` runs the same tools and
 * logic over a job's host. `callTool` starts a chatless request (`chatRef: null`), with no plugin
 * context or captured scope. `callToolForChat` passes its explicit chat to `requestChatData` in
 * `src/ts/process/request/request.ts`, with a plugin context captured for that chat and overridden
 * by the request's preset scope when supplied. A chatless call with a scope passes `requestIds`
 * containing that scope and the active persona id instead; null stays chatless.
 */
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
