// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Chat, Message } from "../database.ts";
import { isLatestReply, isRerollCarrier } from "../rerollCandidates.ts";

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
