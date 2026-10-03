import { type MCPTool, MCPToolHandler, type RisuAccessHost, type RPCToolCallContent } from "./host.ts";

/** The chat tool of RisuAccess, over a `RisuAccessHost` (the tab's mirror, or a server job's store). */
export class ChatHandler extends MCPToolHandler {
    private readonly host: RisuAccessHost;

    constructor(host: RisuAccessHost) {
        super();
        this.host = host;
    }

    getTools(): MCPTool[] {
        return [
            {
                name: "risu-get-chat-history",
                description: "Get the chat history with user and a Risuai character. ordered by time, newest first.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description:
                                "The ID or name of the Risuai character. This can be a character name or ID. if its blank string, it will use the current character.",
                        },
                        count: {
                            type: "integer",
                            description: "The number of chat history entries to retrieve. maximum and default is 20.",
                            default: 20,
                        },
                        offset: {
                            type: "integer",
                            description:
                                "The offset to start retrieving chat history entries from. This is useful for pagination.",
                        },
                    },
                    required: ["id"],
                },
            },
        ];
    }

    async handle(toolName: string, args: any): Promise<RPCToolCallContent[] | null> {
        if (toolName === "risu-get-chat-history") {
            return await this.getChatHistory(args.id, args.count, args.offset);
        }
        return null;
    }

    async getChatHistory(id: string, count: number = 20, offset: number = 0): Promise<RPCToolCallContent[]> {
        const char = this.host.getCharacter(id);
        if (!char) {
            return [
                {
                    type: "text",
                    text: `Error: Character with ID ${id} not found.`,
                },
            ];
        }
        if (char.type === "group") {
            return [
                {
                    type: "text",
                    text: `Error: The id pointed to a group chat, not a character.`,
                },
            ];
        }

        if (count > 100) count = 100;
        if (count < 1) count = 1;
        if (offset < 0) offset = 0;

        // To get "newest first", we must reverse the array.
        const reversedMessages = [...(await this.host.currentMessages(char))].reverse();

        // Now that the array is sorted from newest to oldest, we can slice it
        const history = reversedMessages.slice(offset, offset + count);

        const ordered = history.map((entry) => ({
            type: "text",
            text: `${entry.role === "char" ? char.name : "User"}: ${entry.data}`,
        }));

        return [
            {
                type: "text",
                text: JSON.stringify(ordered),
            },
        ];
    }
}
