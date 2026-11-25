// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { createHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import { greetingSourceHash, messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { writerState } from "./step.ts";
import {
    writerGreeting,
    recordedMessages,
    greetingRerecordCeiling,
    confirmedThrough,
    confirmedWindows,
    windowStillConfirmed,
    writerCeiling,
    writerCadence,
    type WriterCadence,
    type WriterWindow,
} from "./window.ts";

describe("confirmed writer windows", () => {
    it("counts only reply tokens when omission is enabled while keeping every turn source", async () => {
        const messages: Message[] = [
            { chatId: "u1", role: "user", data: "Long user text" },
            { chatId: "a1", role: "char", data: "abc" },
            { chatId: "u2", role: "user", data: "More user text" },
            { chatId: "a2", role: "char", data: "def" },
            { chatId: "u3", role: "user", data: "Last user text" },
            { chatId: "a3", role: "char", data: "ghi" },
            { chatId: "next", role: "user", data: "Confirm" },
        ];
        for (const setting of [{}, { omitUserMessages: false }, { omitUserMessages: true }]) {
            const preset = createHypaV3Preset(
                "Tokens",
                {
                    budgetMode: "tokens",
                    structured: { cadence: "tokens", cadenceTokens: 6, ...setting },
                },
                "tokens",
            );
            const windows = await confirmedWindows({
                messages,
                confirmedBefore: "next",
                recorded: { messages: new Set(), greeting: false },
                cadence: writerCadence({ hypaV3Presets: [preset], hypaV3PresetId: preset.id }),
                maxContext: 100,
                tokenizer: { tokenizeChat: async ({ content }) => content.length },
                limit: 10,
            });
            const expected = setting.omitUserMessages
                ? [["u1", "a1", "u2", "a2"]]
                : [
                      ["u1", "a1"],
                      ["u2", "a2"],
                      ["u3", "a3"],
                  ];
            expect(windows?.map(({ messages }) => messages.map(({ chatId }) => chatId))).toEqual(expected);
            expect(windows?.map(({ sources }) => sources)).toEqual(
                expected.map((ids) =>
                    ids.map((messageId) => {
                        const index = messages.findIndex(({ chatId }) => chatId === messageId);
                        return { messageId, index, hash: messageSourceHash(messages[index]) };
                    }),
                ),
            );
        }
    });

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
            screening: { refusal: [], format: [] },
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
            greeting?: boolean;
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
        cases.push(
            {
                name: "a greeting joins only the first turn",
                ceiling: "u4",
                greeting: true,
                expected: [
                    ["u1", "a1"],
                    ["u2", "a2"],
                    ["u3", "a3"],
                ],
            },
            {
                name: "a greeting does not advance every K",
                ceiling: "u4",
                greeting: true,
                cadence: { cadence: "everyK" },
                expected: [["u1", "a1", "u2", "a2"]],
            },
            {
                name: "stored greeting text reaches the token threshold",
                ceiling: "u4",
                greeting: true,
                cadence: { cadence: "tokens" },
                expected: [
                    ["u1", "a1"],
                    ["u2", "a2", "u3", "a3"],
                ],
            },
            {
                name: "a greeting alone is not a turn",
                messages: [message("u1")],
                ceiling: "u1",
                greeting: true,
                expected: [],
            },
        );
        const greeting = writerGreeting({ firstMessage: "{{user}}" }, { fmIndex: -1, message: history })!;
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
                          recorded: { messages: new Set(row.recorded), greeting: false },
                          greeting: row.greeting ? greeting : null,
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
            if (row.greeting) {
                expect(
                    windows?.map((window) => window.greeting),
                    row.name,
                ).toEqual(row.expected.map((_, index) => (index === 0 ? greeting : undefined)));
            }
        }
    });
});

it("confirms an unchanged window saved with version-1 source hashes and rejects an edited source", () => {
    const reply: Message = { chatId: "reply", role: "char", data: "I will return." };
    const window: WriterWindow = {
        messages: [reply],
        sources: [
            {
                messageId: "reply",
                index: 0,
                // Legacy runs stored bare SHA-256 of [role, data], before speaker-aware v2 hashes.
                hash: createHash("sha256")
                    .update(JSON.stringify(["char", "I will return."]))
                    .digest("hex"),
            },
        ],
    };

    expect(windowStillConfirmed(window, [reply], "reply", { inclusive: true })).toBe(true);
    expect(windowStillConfirmed(window, [{ ...reply, data: "I will stay." }], "reply", { inclusive: true })).toBe(
        false,
    );
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
            recorded: { messages: new Set(), greeting: false },
            cadence: {
                cadence: "manual",
                cadenceTurns: 3,
                cadenceTokens: 100,
                cadenceRatio: 0.1,
                budgetMode: "tokens",
                screening: { refusal: [], format: [] },
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

it("puts one exact remaining-source repair window before ordinary recorded-aware windows", async () => {
    const messages: Message[] = ["u1", "a1", "u2", "a2", "u3", "a3", "next"].map((id) => ({
        chatId: id,
        role: id.startsWith("a") ? "char" : "user",
        data: id,
    }));
    const sources = messages
        .slice(2, 6)
        .map((m, i) => ({ messageId: m.chatId!, index: i + 2, hash: messageSourceHash(m) }));
    const repair = { ...memoryRecords(["repair"]).events[0], createdRevision: 1, sources, rerecord: true };
    const current = messages
        .filter((m) => m.chatId !== "u2")
        .map((m) => (m.chatId === "a2" ? { ...m, disabled: true } : m));
    const args = {
        messages: current,
        confirmedBefore: "next",
        recorded: { messages: new Set(["u2", "a2", "u3", "a3"]), greeting: false },
        cadence: {
            cadence: "everyTurn" as const,
            cadenceTurns: 1,
            cadenceTokens: 1,
            cadenceRatio: 0.1,
            screening: { refusal: [], format: [] },
        },
        maxContext: 1000,
        tokenizer: { tokenize: async () => 1, tokenizeChat: async () => 1 },
        limit: 2,
        manual: true,
    };
    const windows = await confirmedWindows({ ...args, rerecord: [repair] });
    expect(windows!.map(({ rerecords, messages }) => ({ rerecords, ids: messages.map((m) => m.chatId) }))).toEqual([
        { rerecords: "repair", ids: ["u3", "a3"] },
        { rerecords: undefined, ids: ["u1", "a1"] },
    ]);
    expect(windows![0].sources).toEqual(
        current.slice(3, 5).map((m, i) => ({ messageId: m.chatId, index: i + 3, hash: messageSourceHash(m) })),
    );
    expect((await confirmedWindows({ ...args, rerecord: [repair], limit: 1 }))!.map((w) => w.rerecords)).toEqual([
        "repair",
    ]);
    expect((await confirmedWindows(args))!.flatMap((w) => w.messages.map((m) => m.chatId))).toEqual(["u1", "a1"]);
});

it("screens live assistant text after finding the ceiling and folds users into the next turn", async () => {
    const messages: Message[] = [
        { chatId: "u1", role: "user", data: "I CANNOT help" },
        { chatId: "a1", role: "char", data: "Prefix: I CANNOT help with this." },
        { chatId: "u2", role: "user", data: "Try again" },
        { chatId: "a2", role: "char", data: "The gate opens" },
        { chatId: "a3", role: "char", data: "Invalid FORMAT here" },
        { chatId: "next", role: "user", data: "Continue" },
    ];
    const screening = { refusal: ["cannot"], format: ["format"] };
    const args = {
        messages,
        confirmedBefore: "next",
        recorded: { messages: new Set<string>(), greeting: false },
        cadence: { cadence: "everyTurn" as const, cadenceTurns: 1, cadenceTokens: 1, cadenceRatio: 0.1, screening },
        maxContext: 1000,
        tokenizer: { tokenize: async () => 1, tokenizeChat: async () => 1 },
        limit: 10,
    };
    const ids = async (extra = {}) =>
        (await confirmedWindows({ ...args, ...extra }))?.map((w) => w.messages.map((m) => m.chatId));
    expect(await ids()).toEqual([["u1", "u2", "a2"]]);
    expect(await ids({ confirmedBefore: "a3" })).toEqual([["u1", "u2", "a2"]]);
    expect(await ids({ confirmedBefore: "a3", inclusive: true, manual: true })).toEqual([["u1", "u2", "a2"]]);
    expect(await ids({ confirmedBefore: "a1", inclusive: true, manual: true })).toEqual([]);
    expect(confirmedThrough(messages, "next", screening)).toBe("a2");
    screening.refusal = [];
    expect(await ids()).toEqual([
        ["u1", "a1"],
        ["u2", "a2"],
    ]);
    messages[4].data = "A valid ending";
    expect(await ids()).toEqual([["u1", "a1"], ["u2", "a2"], ["a3"]]);
    expect(confirmedThrough(messages, "next", screening)).toBe("a3");
});

it("only a person's start re-records a marked event through screened sources", async () => {
    const messages: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "I cannot help" },
        { chatId: "next", role: "user", data: "Continue" },
    ];
    const repair = {
        ...memoryRecords(["repair"]).events[0],
        createdRevision: 1,
        rerecord: true,
        sources: messages.slice(0, 2).map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) })),
    };
    const before = structuredClone(repair);
    const args = {
        messages,
        confirmedBefore: "next",
        recorded: { messages: new Set(["u", "a"]), greeting: false },
        rerecord: [repair],
        cadence: {
            cadence: "everyTurn" as const,
            cadenceTurns: 1,
            cadenceTokens: 1,
            cadenceRatio: 0.1,
            screening: { refusal: ["cannot"], format: [] },
        },
        maxContext: 1000,
        tokenizer: { tokenize: async () => 1, tokenizeChat: async () => 1 },
        limit: 10,
    };
    expect(await confirmedWindows(args)).toEqual([]);
    expect(repair).toEqual(before);
    expect(await confirmedWindows({ ...args, manual: true })).toEqual([
        { rerecords: "repair", sources: repair.sources, messages: messages.slice(0, 2) },
    ]);
    expect(repair).toEqual(before);
    expect(writerState(undefined, [], "a", new Set(["u", "a"]), [repair])).toEqual({
        state: "pending",
        reason: "repair",
    });
    expect(
        writerState(undefined, [{ id: "failure", bytes: 1, result: "failed" }], "a", new Set(["u", "a"]), [repair]),
    ).toEqual({
        state: "failed",
    });
    expect(writerState(undefined, [], "a", new Set(["u", "a"]), [{ ...repair, status: "retracted" }])).toEqual({
        state: "recorded",
    });
});

it("never automatically adds a readable event's greeting again, regardless of status or current source", async () => {
    const messages: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
        { chatId: "next", role: "user", data: "Continue" },
    ];
    const greeting = writerGreeting({ firstMessage: "Welcome" }, { fmIndex: -1, message: messages })!;
    for (const status of ["active", "stale", "retracted"] as const) {
        for (const citation of [
            greeting.source,
            { fmIndex: 0, hash: greeting.source.hash },
            { fmIndex: -1, hash: "v3:old-text" },
        ]) {
            const event = { ...memoryRecords(["cited"]).events[0], sources: [], status, greeting: citation };
            const recorded = recordedMessages([event]);
            expect(recorded).toEqual({ messages: new Set(), greeting: true });
            const windows = await confirmedWindows({
                messages,
                confirmedBefore: "next",
                recorded,
                greeting,
                cadence: {
                    cadence: "everyTurn",
                    cadenceTurns: 1,
                    cadenceTokens: 1,
                    cadenceRatio: 0.1,
                    screening: { refusal: [], format: [] },
                },
                maxContext: 100,
                tokenizer: { tokenizeChat: async () => 1 },
                limit: 1,
            });
            expect(windows).toHaveLength(1);
            expect(windows![0].messages).toEqual(messages.slice(0, 2));
            expect(windows![0]).not.toHaveProperty("greeting");
        }
    }
    const unreadable = { ...memoryRecords(["bad"]).events[0], sources: [], greeting: greeting.source };
    Object.assign(unreadable, { summary: 42 });
    expect(recordedMessages([unreadable]).greeting).toBe(false);
});

it("leaves reset histories, groups and empty greetings out of the first window", async () => {
    const messages: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
        { chatId: "next", role: "user", data: "Continue" },
    ];
    for (const row of [
        { owner: { type: "group" as const, firstMessage: "Group greeting" }, messages },
        {
            owner: { firstMessage: "Welcome" },
            messages: [
                { chatId: "reset", role: "user" as const, data: "Old history", disabled: "allBefore" as const },
                ...messages,
            ],
        },
        { owner: { firstMessage: "" }, messages },
        { owner: { firstMessage: '<p class="empty"></p><!-- nothing -->' }, messages },
    ]) {
        const greeting = writerGreeting(row.owner, { fmIndex: -1, message: row.messages });
        expect(greeting).toBeNull();
        const windows = await confirmedWindows({
            messages: row.messages,
            confirmedBefore: "next",
            greeting,
            recorded: recordedMessages([]),
            cadence: {
                cadence: "everyTurn",
                cadenceTurns: 1,
                cadenceTokens: 1,
                cadenceRatio: 0.1,
                screening: { refusal: [], format: [] },
            },
            maxContext: 100,
            tokenizer: { tokenizeChat: async () => 1 },
            limit: 1,
        });
        expect(windows).toHaveLength(1);
        expect(windows![0].messages).toEqual(messages.slice(0, 2));
        expect(windows![0]).not.toHaveProperty("greeting");
    }
});

it("keeps or adds the current greeting when re-recording the first event", async () => {
    const messages: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
        { chatId: "next", role: "user", data: "Continue" },
    ];
    const sources = messages
        .slice(0, 2)
        .map((message, index) => ({ messageId: message.chatId!, index, hash: messageSourceHash(message) }));
    const greeting = writerGreeting({ firstMessage: "New greeting" }, { fmIndex: -1, message: messages })!;
    for (const prior of [undefined, { fmIndex: 0, hash: "v3:old" }]) {
        const event = {
            ...memoryRecords(["first"]).events[0],
            createdRevision: 1,
            sources,
            rerecord: true,
            ...(prior ? { greeting: prior } : {}),
        };
        const windows = await confirmedWindows({
            messages,
            confirmedBefore: "next",
            greeting,
            recorded: recordedMessages([event]),
            rerecord: [event],
            manual: true,
            cadence: {
                cadence: "everyTurn",
                cadenceTurns: 1,
                cadenceTokens: 1,
                cadenceRatio: 0.1,
                screening: { refusal: [], format: [] },
            },
            maxContext: 100,
            tokenizer: { tokenizeChat: async () => 1 },
            limit: 1,
        });
        expect(windows).toEqual([{ rerecords: "first", sources, messages: messages.slice(0, 2), greeting }]);
    }
});

it("confirms greeting-only repairs before the first eligible stored message and rechecks their greeting source", async () => {
    const messages: Message[] = [
        { chatId: "disabled", role: "user", data: "Ignored", disabled: true },
        { chatId: "reply", role: "char", data: "First reply" },
        { chatId: "later", role: "char", data: "Later reply" },
    ];
    const greeting = writerGreeting({ firstMessage: "Welcome" }, { fmIndex: -1, message: messages })!;
    const event = {
        ...memoryRecords(["first"]).events[0],
        createdRevision: 1,
        rerecord: true,
        greeting: greeting.source,
        sources: [{ messageId: "gone", index: 0, hash: "v3:gone" }],
    };
    expect(greetingRerecordCeiling(messages, [event], greeting)).toBe("reply");
    const windows = await confirmedWindows({
        messages,
        confirmedBefore: "reply",
        greeting,
        recorded: recordedMessages([event]),
        rerecord: [event],
        manual: true,
        cadence: {
            cadence: "everyTurn",
            cadenceTurns: 1,
            cadenceTokens: 1,
            cadenceRatio: 0.1,
            screening: { refusal: [], format: [] },
        },
        maxContext: 100,
        tokenizer: { tokenizeChat: async () => 1 },
        limit: 1,
    });
    expect(windows).toEqual([{ rerecords: "first", sources: [], messages: [], greeting }]);
    const window = windows![0];
    expect(windowStillConfirmed(window, messages, "reply", { greeting: greeting.source })).toBe(true);
    expect(windowStillConfirmed(window, messages, "disabled", { greeting: greeting.source })).toBe(false);
    expect(windowStillConfirmed(window, messages, "reply", { greeting: { ...greeting.source, fmIndex: 0 } })).toBe(
        false,
    );
    expect(
        windowStillConfirmed(window, messages, "reply", {
            greeting: { ...greeting.source, hash: greetingSourceHash("Goodbye") },
        }),
    ).toBe(false);
    expect(
        windowStillConfirmed(window, messages, "reply", {
            greeting: { ...greeting.source, hash: greetingSourceHash('<b class="new">Welcome</b>') },
        }),
    ).toBe(true);
});
