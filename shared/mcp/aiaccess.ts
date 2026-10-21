import type { MCPTool, RPCToolCallContent } from "./risuaccess/host.ts";

/**
 * What the LLM tool (`internal:aiaccess`) needs from where it runs: a request of the main model
 * (`model`) or the lighter one (`otherAx`) with the given messages and no bias, as the tab's
 * `requestChatData` or a server job's own request.
 */
export type AiAccessHost = {
    runLLM(
        formated: { role: any; content: any }[],
        mode: "model" | "otherAx",
    ): Promise<{ type: string; result?: unknown }>;
};

export const AIACCESS_TOOLS: MCPTool[] = [
    {
        name: "runLLM",
        description: "Run a large language model (LLM) with specified parameters.",
        inputSchema: {
            type: "object",
            properties: {
                model: {
                    type: "string",
                    description:
                        'The type of the LLM to use. "normal" for full model, "lite" for a smaller, faster model.',
                    enum: ["normal", "lite"],
                },
                messages: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            role: {
                                type: "string",
                                enum: ["user", "assistant", "system"],
                                description: "The role of the message sender.",
                            },
                            content: {
                                type: "string",
                                description: "The content of the message.",
                            },
                        },
                        required: ["role", "content"],
                    },
                    description: "Messages to send to the LLM.",
                },
            },
            required: ["model", "messages"],
        },
    },
];

export async function callAiAccessTool(
    host: AiAccessHost,
    methodName: string,
    args: any,
): Promise<RPCToolCallContent[]> {
    if (methodName === "runLLM") {
        const { model, messages } = args;
        if (!model || !messages || !Array.isArray(messages)) {
            return [
                {
                    type: "text",
                    text: "Invalid arguments for runLLM. Please provide a valid model and messages.",
                },
            ];
        }
        const r = await host.runLLM(
            messages.map((msg: any) => ({
                role: msg.role,
                content: msg.content,
            })),
            model === "lite" ? "otherAx" : "model",
        );

        return [
            {
                type: "text",
                text: JSON.stringify({
                    success: r.type === "success",
                    message: r.result,
                }),
            },
        ];
    }
    return [
        {
            type: "text",
            text: `Method ${methodName} not found.`,
        },
    ];
}
