import { CharacterHandler } from "./characters.ts";
import { ChatHandler } from "./chats.ts";
import { type MCPTool, type MCPToolHandler, type RisuAccessHost, type RPCToolCallContent } from "./host.ts";
import { ModuleHandler } from "./modules.ts";

/**
 * The RisuAccess tools over a host, as `RisuAccessClient` (`src/ts/process/mcp/risuaccess/client.ts`)
 * lists and dispatches them: the character, chat, and module handlers in that order; a handler's
 * throw answers `Error: <message>` unless `fatal` says the failure is not the tool's own.
 */
export function createRisuAccess(host: RisuAccessHost, fatal: (error: unknown) => boolean = () => false) {
    const handlers: MCPToolHandler[] = [new CharacterHandler(host), new ChatHandler(host), new ModuleHandler(host)];
    return {
        tools(): MCPTool[] {
            return handlers.flatMap((handler) => handler.getTools());
        },
        async call(toolName: string, args: any): Promise<RPCToolCallContent[]> {
            try {
                for (const handler of handlers) {
                    const result = await handler.handle(toolName, args);
                    if (result) {
                        return result;
                    }
                }
            } catch (error) {
                if (fatal(error)) {
                    throw error;
                }
                return [{ type: "text", text: `Error: ${(error as { message?: unknown })?.message}` }];
            }
            return [{ type: "text", text: `Tool ${toolName} not found.` }];
        },
    };
}
