// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { coveredMessages, type MemoryEvent } from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { reconcileEvents } from "./reconcile.ts";

it("reconciles changed, missing, inserted and moved sources on a copy and recovers restored evidence", () => {
    const messages: Message[] = [
        { chatId: "before", role: "user", data: "Earlier" },
        { chatId: "u", role: "user", data: "Open the gate" },
        { chatId: "a", role: "char", data: "The gate opens" },
    ];
    const event: MemoryEvent = {
        ...memoryRecords(["gate"]).events[0],
        createdRevision: 1,
        sources: messages
            .slice(1)
            .map((message, i) => ({ messageId: message.chatId!, index: i + 1, hash: messageSourceHash(message) })),
    };
    const before = structuredClone(event);
    const [prefix, user, reply] = messages;
    const cases = [
        { reason: "changed", messages: [prefix, user, { ...reply, data: "The gate stays shut" }] },
        { reason: "missing", messages: [prefix, user] },
        {
            reason: "inserted",
            messages: [prefix, user, { chatId: "inserted", role: "user" as const, data: "Wait" }, reply],
        },
        { reason: "moved", messages: [prefix, reply, user] },
    ];
    for (const row of cases) {
        const input = structuredClone(row.messages);
        const [read] = reconcileEvents([event], row.messages);
        expect(read, row.reason).toEqual({ ...before, status: "stale", staleReason: row.reason });
        expect([...coveredMessages([read])], row.reason).toEqual([]);
        expect(event).toEqual(before);
        expect(row.messages).toEqual(input);
        expect(reconcileEvents([event], messages)).toEqual([before]);
    }
    for (const harmless of [
        messages.slice(1),
        [{ chatId: "extra", role: "user" as const, data: "Earlier still" }, ...messages],
        [prefix, { ...user, disabled: true }, { ...reply, generationInfo: { model: "new receipt", inputTokens: 5 } }],
    ]) {
        expect(reconcileEvents([event], harmless)).toEqual([before]);
    }
    expect(event).toEqual(before);
});
