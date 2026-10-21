import type { RPCToolCallContent, ToolDescriptor } from "../../../shared/llm/request.ts";

/**
 * `internal:dice` on the server (`src/ts/process/mcp/dice.ts`): the same tool and
 * the same rolls. The server bounds one call, which the tab does not: the notation's length and the
 * dice rolled in all (a roll runs on the server's main thread).
 */
export const MAX_DICE_NOTATION_CHARS = 200;
export const MAX_DICE_PER_CALL = 1000;

export const DICE_TOOLS: ToolDescriptor[] = [
    {
        name: "rollDice",
        description: "Roll dice based on the given notation.",
        inputSchema: {
            type: "object",
            properties: {
                notation: {
                    type: "string",
                    description: 'The dice notation to roll, e.g., "2d6+3".',
                },
            },
            required: ["notation"],
        },
    },
];

export function rollDice(notation: string, random: () => number = Math.random): { total: number; details: string } {
    if (notation.length > MAX_DICE_NOTATION_CHARS) {
        throw new Error(`The dice notation is longer than ${MAX_DICE_NOTATION_CHARS} characters`);
    }
    const dicePattern = /(\d*)d(\d+)([+-]\d+)?/g;
    const terms: { count: number; sides: number; modifier: number; text: string | undefined }[] = [];
    let dice = 0;
    let match: RegExpExecArray | null;
    while ((match = dicePattern.exec(notation)) !== null) {
        const count = parseInt(match[1]) || 1;
        dice += count;
        // Checked before a single die is rolled.
        if (dice > MAX_DICE_PER_CALL) {
            throw new Error(`The notation rolls more than ${MAX_DICE_PER_CALL} dice`);
        }
        terms.push({ count, sides: parseInt(match[2]), modifier: match[3] ? parseInt(match[3]) : 0, text: match[3] });
    }
    let total = 0;
    const details: string[] = [];
    for (const { count, sides, modifier, text } of terms) {
        let rollTotal = 0;
        const rolls: number[] = [];
        for (let i = 0; i < count; i++) {
            const roll = Math.floor(random() * sides) + 1;
            rolls.push(roll);
            rollTotal += roll;
        }
        rollTotal += modifier;
        total += rollTotal;
        details.push(
            `${count}d${sides}${modifier ? text : ""}: [${rolls.join(", ")}]${modifier ? ` ${text}` : ""} = ${rollTotal}`,
        );
    }
    return { total, details: details.join("; ") };
}

export async function callDiceTool(toolName: string, args: unknown): Promise<RPCToolCallContent[]> {
    if (toolName === "rollDice") {
        const notation = String((args as { notation?: unknown } | null | undefined)?.notation);
        const result = rollDice(notation);
        return [{ type: "text", text: `Rolled ${notation}: ${result.total} (Details: ${result.details})` }];
    }
    throw new Error(`Unknown tool: ${toolName}`);
}
