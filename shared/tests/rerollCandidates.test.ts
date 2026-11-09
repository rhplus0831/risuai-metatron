// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Chat, Message } from "../database.ts";
import { isLatestReply, isRerollCarrier, trimCandidates, type CandidateNoticeCode } from "../rerollCandidates.ts";

const message = (chatId: string, role: Message["role"], isComment = false): Message => ({
    chatId,
    role,
    isComment,
    data: chatId,
});
const user = message("user", "user");
const reply = message("reply", "char");
const comment = message("comment", "char", true);

/** Observe array reads without changing the messages or the array methods. */
function observedChat(messages: Message[]) {
    const visited: number[] = [];
    const chat: Chat = {
        name: "Tail",
        note: "",
        localLore: [],
        message: new Proxy(messages, {
            get(target, key, receiver) {
                if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) visited.push(Number(key));
                return Reflect.get(target, key, receiver);
            },
        }),
    };
    return { chat, visited };
}

describe("trimCandidates", () => {
    it.each([
        {
            bound: "count",
            data: "x",
            kept: [1, 31, ...Array.from({ length: 14 }, (_, index) => 50 + index)],
            dropped: 48,
        },
        {
            bound: "bytes after count trimming",
            // Twelve 16 KiB texts fill the 192 KiB budget before JSON overhead; only eleven fit.
            data: "x".repeat(16 * 1024),
            kept: [1, 31, ...Array.from({ length: 9 }, (_, index) => 55 + index)],
            dropped: 53,
        },
    ])("keeps the previous and selected replies in order under the $bound bound", ({ data, kept, dropped }) => {
        const candidates = Array.from({ length: 64 }, (_, index) => ({ id: `reply-${index}`, data }));
        const notices: CandidateNoticeCode[] = [];
        const result = trimCandidates(
            { ...reply, data, candidates, selected: 31 },
            (code) => notices.push(code),
            "reply-1",
        );

        expect(result.candidates?.map(({ id }) => id)).toEqual(kept.map((index) => `reply-${index}`));
        expect(result.candidates?.map(({ data }) => data)).toEqual(kept.map(() => data));
        expect(result.selected).toBe(1);
        expect(result.data).toBe(data);
        expect(notices).toEqual(Array(dropped).fill("rerollCandidateDropped"));
    });
});

describe("reply tail predicates", () => {
    it("recognizes reroll carriers through comments and stops at the preceding non-comment message", () => {
        const cases: { messages: Message[]; id: string; expected: boolean; visited: number[] }[] = [
            {
                messages: [message("older", "char"), user, comment, reply, comment],
                id: "reply",
                expected: true,
                visited: [4, 3, 2, 1],
            },
            { messages: [], id: "reply", expected: false, visited: [] },
            { messages: [comment], id: "reply", expected: false, visited: [0] },
            { messages: [comment, reply, comment], id: "reply", expected: true, visited: [2, 1, 0] },
            {
                messages: [user, message("earlier", "char"), comment, reply, comment],
                id: "reply",
                expected: false,
                visited: [4, 3, 2, 1],
            },
            { messages: [user, reply, comment], id: "user", expected: false, visited: [2, 1] },
            { messages: [reply, user, comment], id: "user", expected: false, visited: [2, 1] },
        ];
        for (const scenario of cases) {
            const { chat, visited } = observedChat(scenario.messages);
            expect(isRerollCarrier(chat, scenario.id), JSON.stringify(scenario)).toBe(scenario.expected);
            expect(visited, JSON.stringify(scenario)).toEqual(scenario.visited);
        }
    });

    it("finds the latest non-comment id without visiting earlier messages or requiring a char role", () => {
        const cases: { messages: Message[]; id: string; expected: boolean; visited: number[] }[] = [
            { messages: [], id: "reply", expected: false, visited: [] },
            { messages: [comment], id: "comment", expected: false, visited: [0] },
            { messages: [user, reply, comment], id: "reply", expected: true, visited: [2, 1] },
            { messages: [user, reply, comment], id: "user", expected: false, visited: [2, 1] },
            { messages: [reply, user, comment], id: "user", expected: true, visited: [2, 1] },
            { messages: [reply, user, comment], id: "reply", expected: false, visited: [2, 1] },
        ];
        for (const scenario of cases) {
            const { chat, visited } = observedChat(scenario.messages);
            expect(isLatestReply(chat, scenario.id), JSON.stringify(scenario)).toBe(scenario.expected);
            expect(visited, JSON.stringify(scenario)).toEqual(scenario.visited);
        }
    });
});
