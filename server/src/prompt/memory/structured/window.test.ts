// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { confirmedWindows, windowStillConfirmed, writerCeiling, type WriterCadence } from "./window.ts";

describe("confirmed writer windows", () => {
    it("closes only uncovered confirmed turns at the selected cadence", async () => {
        const message = (id: string, disabled?: Message["disabled"]): Message => ({
            chatId: id,
            role: id.startsWith("u") ? "user" : "char",
            data: id,
            ...(disabled === undefined ? {} : { disabled }),
        });
        const history = ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"].map((id) => message(id));
        const cadence: WriterCadence = {
            cadence: "everyTurn",
            cadenceTurns: 2,
            cadenceTokens: 8,
            cadenceRatio: 0.12,
            budgetMode: "tokens",
        };
        const cases: {
            name: string;
            messages?: Message[];
            continueId?: string;
            ceiling: string | null;
            cadence?: Partial<WriterCadence>;
            manual?: boolean;
            recorded?: string[];
            expected: string[][];
        }[] = [
            {
                name: "the latest reply is unconfirmed",
                ceiling: "u4",
                expected: [
                    ["u1", "a1"],
                    ["u2", "a2"],
                    ["u3", "a3"],
                ],
            },
            { name: "no user has confirmed a reply", messages: [message("a1")], ceiling: null, expected: [] },
            {
                name: "a reply after the last user stays open",
                messages: history.slice(0, 2),
                ceiling: "u1",
                expected: [],
            },
            {
                name: "continuing the newest reply",
                continueId: "a4",
                ceiling: "u4",
                expected: [
                    ["u1", "a1"],
                    ["u2", "a2"],
                    ["u3", "a3"],
                ],
            },
            { name: "continuing an older reply", continueId: "a2", ceiling: "a2", expected: [["u1", "a1"]] },
            {
                name: "disabled messages and reset history",
                messages: [
                    message("u0"),
                    message("a0"),
                    message("u1", "allBefore"),
                    message("a1", true),
                    message("u2"),
                    message("a2"),
                    message("u3"),
                    message("a3"),
                    message("u4", true),
                ],
                ceiling: "u3",
                expected: [["u2", "a2"]],
            },
            {
                name: "each assistant closes its own turn",
                messages: [
                    message("u1"),
                    message("a1"),
                    message("a2"),
                    message("u2"),
                    message("u3"),
                    message("a3"),
                    message("u4"),
                ],
                ceiling: "u4",
                expected: [["u1", "a1"], ["a2"], ["u2", "u3", "a3"]],
            },
            {
                name: "recorded messages are omitted",
                ceiling: "u4",
                recorded: ["u1", "a2"],
                expected: [["a1"], ["u3", "a3"]],
            },
            {
                name: "every K leaves a partial window",
                ceiling: "u4",
                cadence: { cadence: "everyK" },
                expected: [["u1", "a1", "u2", "a2"]],
            },
            {
                name: "manual start closes the partial window",
                ceiling: "u4",
                cadence: { cadence: "everyK" },
                manual: true,
                expected: [
                    ["u1", "a1", "u2", "a2"],
                    ["u3", "a3"],
                ],
            },
            {
                name: "token threshold closes at eight tokens",
                ceiling: "u4",
                cadence: { cadence: "tokens" },
                expected: [["u1", "a1", "u2", "a2"]],
            },
            {
                name: "ratio threshold uses twelve of a hundred tokens",
                ceiling: "u4",
                cadence: { cadence: "tokens", budgetMode: "ratio" },
                expected: [["u1", "a1", "u2", "a2", "u3", "a3"]],
            },
            {
                name: "manual cadence does not close automatically",
                ceiling: "u4",
                cadence: { cadence: "manual" },
                expected: [],
            },
        ];
        for (const row of cases) {
            const messages = row.messages ?? history;
            const ceiling = writerCeiling(messages, row.continueId);
            expect(ceiling, row.name).toBe(row.ceiling);
            const windows =
                ceiling === null
                    ? []
                    : await confirmedWindows({
                          messages,
                          confirmedBefore: ceiling,
                          recorded: new Set(row.recorded),
                          cadence: { ...cadence, ...row.cadence },
                          maxContext: 100,
                          tokenizer: { tokenizeChat: async (chat) => chat.content.length },
                          limit: 20,
                          manual: row.manual,
                      });
            expect(
                windows?.map((window) => window.messages.map((entry) => entry.chatId)),
                row.name,
            ).toEqual(row.expected);
        }
    });
});

it("includes the manually confirmed assistant in both window planning and commit validation", async () => {
    const messages: Message[] = ["u1", "a1", "u2", "a2"].map((id) => ({
        chatId: id,
        role: id.startsWith("u") ? "user" : "char",
        data: id,
    }));
    for (const row of [
        { id: "a1", inclusive: true, expected: [["u1", "a1"]] },
        {
            id: "a2",
            inclusive: true,
            expected: [
                ["u1", "a1"],
                ["u2", "a2"],
            ],
        },
        { id: "a2", inclusive: false, expected: [["u1", "a1"]] },
    ]) {
        const windows = await confirmedWindows({
            messages,
            confirmedBefore: row.id,
            inclusive: row.inclusive,
            recorded: new Set(),
            cadence: {
                cadence: "manual",
                cadenceTurns: 3,
                cadenceTokens: 100,
                cadenceRatio: 0.1,
                budgetMode: "tokens",
            },
            manual: true,
            maxContext: 1000,
            tokenizer: { tokenizeChat: async () => 1 },
            limit: 10,
        });
        expect(windows?.map((window) => window.messages.map((message) => message.chatId))).toEqual(row.expected);
        for (const window of windows!) {
            expect(windowStillConfirmed(window, messages, row.id, { inclusive: row.inclusive })).toBe(true);
            if (window.sources.at(-1)!.messageId === row.id) {
                expect(windowStillConfirmed(window, messages, row.id)).toBe(false);
                expect(
                    windowStillConfirmed(
                        window,
                        messages.map((message) =>
                            message.chatId === row.id ? { ...message, disabled: true } : message,
                        ),
                        row.id,
                        { inclusive: true },
                    ),
                ).toBe(false);
            }
        }
    }
});
