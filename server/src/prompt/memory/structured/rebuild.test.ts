// @vitest-environment node
import { expect, it } from "vitest";
import { createResourceStore } from "../../../data/resourceStore.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../data/kinds.ts";
import { createHypaV3Preset } from "../../../../../shared/hypaV3Presets.ts";
import type { Message } from "../../../../../shared/database.ts";
import {
    ADOPTED_WRITER_RUN,
    memoryAnchorState,
    memoryCostTokens,
    reconcileMemoryEvents,
    type MemoryEvent,
    type MemoryPage,
} from "../../../../../shared/structuredMemory.ts";
import { greetingSourceHash, messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { applyPageTool } from "./pages.ts";
import { backfillFolds, memoryWorkCost, rebuildChanges, rebuildPlan, rebuildSeed, rebuildWindow } from "./rebuild.ts";
import { writerGreeting } from "./window.ts";

const messages: Message[] = ["u1", "a1", "u2", "a2", "u3", "a3", "u4"].map((id) => ({
    chatId: id,
    role: id.startsWith("u") ? "user" : "char",
    data: id,
}));
const event = (id: string, ids: string[], extra: Partial<MemoryEvent> = {}): MemoryEvent => ({
    ...memoryRecords([id]).events[0],
    createdRevision: 7,
    sources: ids.map((messageId) => ({ messageId, index: 0, hash: "original" })),
    ...extra,
});

const NO_SCREENING: { refusal: string[]; format: string[] } = { refusal: [], format: [] };

const anchor = (message: Message, index: number) => ({
    messageId: message.chatId!,
    index,
    hash: messageSourceHash(message),
});

it("folds three turns into the newest active adopted event in chat order without re-anchoring, and only once", () => {
    const replies = [1, 3, 5].map((index) => anchor(messages[index], index + 10));
    const adopted = event("adopted", [], {
        writerRun: ADOPTED_WRITER_RUN,
        suppressed: true,
        sources: replies,
    });
    const older = { ...adopted, id: "older", createdRevision: 1, suppressed: false };
    const stale = { ...adopted, id: "stale", createdRevision: 8, status: "stale" as const };
    const args = { messages, live: [adopted, stale, older], staged: [], screening: NO_SCREENING };
    const before = structuredClone(args);
    const expected = {
        ...adopted,
        sources: [
            anchor(messages[0], 0),
            replies[0],
            anchor(messages[2], 2),
            replies[1],
            anchor(messages[4], 4),
            replies[2],
        ],
    };
    expect(backfillFolds(args)).toEqual([expected]);
    expect(reconcileMemoryEvents([expected], messages, messageSourceHash)).toEqual([expected]);
    expect(backfillFolds({ ...args, live: [expected, stale, older] })).toEqual([]);
    expect(args).toEqual(before);
});

it("leaves users uncited when their reply has only retracted, stored stale, or newly stale events", () => {
    const reply = anchor(messages[1], 1);
    for (const target of [
        event("retracted", [], { sources: [reply], status: "retracted" }),
        event("stale", [], { sources: [reply], status: "stale" }),
        event("changed", [], {
            sources: [{ ...reply, hash: messageSourceHash({ ...messages[1], data: "Before edit" }) }],
        }),
    ]) {
        expect(backfillFolds({ messages, live: [target], staged: [], screening: NO_SCREENING }), target.id).toEqual([]);
    }
});

it("does not fold user messages already cited by live or staged events in any status", () => {
    const target = event("adopted", [], { sources: [1, 3, 5].map((index) => anchor(messages[index], index)) });
    const citedLive = event("live-user", ["u2"], { status: "stale" });
    const citedStaged = event("staged-user", ["u1"], { status: "retracted" });
    expect(
        backfillFolds({ messages, live: [target, citedLive], staged: [citedStaged], screening: NO_SCREENING }),
    ).toEqual([
        { ...target, sources: [target.sources[0], target.sources[1], anchor(messages[4], 4), target.sources[2]] },
    ]);
});

it("folds the user before a screened reply into the next reply's event", () => {
    const first = event("screened", [], { sources: [anchor(messages[1], 1)] });
    const next = event("next", [], { sources: [anchor(messages[3], 3)] });
    expect(
        backfillFolds({
            messages,
            live: [first, next],
            staged: [],
            screening: { refusal: ["a1"], format: [] },
        }),
    ).toEqual([{ ...next, sources: [anchor(messages[0], 0), anchor(messages[2], 2), next.sources[0]] }]);
});

it.each(["moved", "inserted", "changed"] as const)(
    "drops the whole fold when the merged sources would reconcile %s",
    (reason) => {
        const current: Message[] =
            reason === "inserted"
                ? [
                      messages[0],
                      messages[2],
                      { chatId: "disabled", role: "user", data: "Hidden", disabled: true },
                      messages[3],
                  ]
                : messages.slice(0, 4);
        const sources =
            reason === "moved"
                ? [anchor(current[3], 3), anchor(current[1], 1)]
                : reason === "inserted"
                  ? [anchor(current[3], 2)]
                  : [{ ...anchor(current[3], 3), hash: messageSourceHash({ ...current[3], data: "Before edit" }) }];
        const target = event("target", [], {
            sources,
            ...(reason === "inserted" ? {} : { keptState: memoryAnchorState(sources, current, messageSourceHash) }),
        });
        const additions =
            reason === "changed"
                ? [anchor(current[2], 2)]
                : [
                      anchor(current[0], 0),
                      anchor(current[reason === "inserted" ? 1 : 2], reason === "inserted" ? 1 : 2),
                  ];
        expect(reconcileMemoryEvents([target], current, messageSourceHash)[0].status).toBe("active");
        expect(
            reconcileMemoryEvents([{ ...target, sources: [...additions, ...sources] }], current, messageSourceHash)[0],
        ).toMatchObject({ status: "stale", staleReason: reason });
        expect(backfillFolds({ messages: current, live: [target], staged: [], screening: NO_SCREENING })).toEqual([]);
    },
);

it("writes folds in a backfill with or without staged events and returns null only when both are empty", () => {
    const original = event("adopted", ["a1"]);
    const fold = { ...original, sources: [anchor(messages[0], 0), ...original.sources] };
    const { createdRevision: _foldRevision, ...writtenFold } = fold;
    const staged = event("new", ["u2", "a2"]);
    const { createdRevision: _stagedRevision, ...writtenStaged } = staged;
    const live = { pages: [], threads: [], events: [original] };
    const empty = { pages: [], threads: [], events: [] };
    expect(rebuildChanges("backfill", live, empty, [fold])).toEqual({ pages: [], events: [writtenFold] });
    expect(rebuildChanges("backfill", live, { ...empty, events: [staged] }, [fold])).toEqual({
        pages: [],
        events: [writtenStaged, writtenFold],
    });
    expect(rebuildChanges("backfill", live, empty, [])).toBeNull();
});

it("ignores folds in rebuild and fresh swaps even when nothing was staged", () => {
    const original = event("adopted", ["a1"]);
    const fold = { ...original, sources: [anchor(messages[0], 0), ...original.sources] };
    const staged = event("new", ["u2", "a2"]);
    const { createdRevision: _revision, ...written } = staged;
    const live = { pages: [], threads: [], events: [original] };
    const empty = { pages: [], threads: [], events: [] };
    for (const mode of ["rebuild", "fresh"] as const) {
        expect(rebuildChanges(mode, live, empty, [fold])).toBeNull();
        expect(rebuildChanges(mode, live, { ...empty, events: [staged] }, [fold])).toEqual({
            events: [written],
            pages: [],
            threads: [],
            remove: { events: mode === "fresh" ? ["adopted"] : [], pages: [], threads: [] },
        });
    }
});

/** The characters kind `memoryWorkCost` reads the chat's owner through. */
const CHARACTERS = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("characters")!;

function costStore(
    message: Message[],
    events: MemoryEvent[] = [],
    screening: typeof NO_SCREENING = NO_SCREENING,
    omitUserMessages?: boolean,
) {
    return {
        readChatSource: () => ({ data: { message } }),
        get: () => null,
        memory: {
            readWriterSettings: () => ({ screening, omitUserMessages }),
            readContents: () => ({ events }),
            readRecord: (_chaId: string, _chatId: string, _kind: string, id: string) => ({
                data: events.find((record) => record.id === id),
            }),
        },
    } as unknown as Parameters<typeof memoryWorkCost>[0];
}

it("plans reply-less turns separately and groups only turns with replies when omission is on", () => {
    for (const mode of ["rebuild", "backfill", "fresh"] as const) {
        const events = [event("reply-only", ["a1"], { status: mode === "rebuild" ? "retracted" : "active" })];
        const args = { messages, events, mode, turns: 2 as const, screening: NO_SCREENING };
        const legacy =
            mode === "fresh"
                ? [
                      ["u1", "a1", "u2", "a2"],
                      ["u3", "a3"],
                  ]
                : [
                      ["u1", "u2", "a2"],
                      ["u3", "a3"],
                  ];
        expect(rebuildPlan(args)).toEqual(legacy);
        expect(rebuildPlan({ ...args, omitUserMessages: false })).toEqual(legacy);
        expect(rebuildPlan({ ...args, omitUserMessages: true })).toEqual(
            mode === "fresh"
                ? [
                      ["u1", "a1", "u2", "a2"],
                      ["u3", "a3"],
                  ]
                : [["u1"], ["u2", "a2", "u3", "a3"]],
        );
    }
});

it("returns no rebuild window when current replies are gone, disabled or screened under omission", () => {
    const screening = { refusal: ["refusal"], format: [] };
    for (const current of [
        [messages[0]],
        [messages[0], { ...messages[1], disabled: true }],
        [messages[0], { ...messages[1], data: "A refusal" }],
    ]) {
        const expected = {
            ceiling: { id: "u1", inclusive: true },
            window: {
                messages: [messages[0]],
                sources: [{ messageId: "u1", index: 0, hash: messageSourceHash(messages[0]) }],
            },
        };
        expect(rebuildWindow(current, ["u1", "a1"], screening)).toEqual(expected);
        expect(rebuildWindow(current, ["u1", "a1"], screening, false)).toEqual(expected);
        expect(rebuildWindow(current, ["u1", "a1"], screening, true)).toBeNull();
    }
    expect(rebuildWindow(messages, ["u1", "a1"], screening, true)).toEqual({
        ceiling: { id: "a1", inclusive: true },
        window: {
            messages: messages.slice(0, 2),
            sources: messages
                .slice(0, 2)
                .map((message, index) => ({ messageId: message.chatId, index, hash: messageSourceHash(message) })),
        },
    });
});

it("previews only readable windows, messages and UTF-8 bytes in every work mode", async () => {
    const current: Message[] = [
        { chatId: "u1", role: "user", data: "한" },
        { chatId: "a1", role: "char", data: "😀" },
        { chatId: "u2", role: "user", data: "é" },
        { chatId: "a2", role: "char", data: "答" },
        { chatId: "u3", role: "user", data: "x" },
        { chatId: "a3", role: "char", data: "ok" },
        { chatId: "pending", role: "user", data: "Not confirmed" },
    ];
    for (const mode of ["rebuild", "backfill", "fresh", "record"] as const) {
        const events = [event("reply-only", ["a1"], { status: mode === "rebuild" ? "retracted" : "active" })];
        for (const setting of [undefined, false, true]) {
            const cost = await memoryWorkCost(
                costStore(current, events, NO_SCREENING, setting),
                { chaId: "character", chatId: "chat" },
                { mode, turns: 2 },
                CHARACTERS,
            );
            // Fresh reads all 15 bytes (9 reply bytes when on). Rebuild/backfill leave a1 out:
            // 11 bytes when off, and 5 reply bytes when on. Record now skips the covered turn:
            // 8 bytes when off and 5 when on, grouped into one call. Each call adds 3,000 tokens.
            // A backfill with the switch on also counts u1, whose reply the active event cites, as a fold.
            expect(cost, `${mode}, omit=${setting}`).toEqual(
                setting === true
                    ? mode === "fresh"
                        ? { calls: 2, messages: 3, estimatedTokens: 6003 }
                        : mode === "backfill"
                          ? { calls: 1, messages: 2, estimatedTokens: 3002, folds: 1 }
                          : { calls: 1, messages: 2, estimatedTokens: 3002 }
                    : mode === "fresh"
                      ? { calls: 2, messages: 6, estimatedTokens: 6005 }
                      : mode === "record"
                        ? { calls: 1, messages: 4, estimatedTokens: 3003 }
                        : { calls: 2, messages: 5, estimatedTokens: 6004 },
            );
        }
    }
});

it("previews two rebuild calls with 6,000 overhead tokens and four text tokens", async () => {
    // Two turns total 3 + 4 + 2 + 1 = 10 UTF-8 bytes, so ceil(10 / 3) = 4 text tokens.
    const current: Message[] = [
        { chatId: "u1", role: "user", data: "한" },
        { chatId: "a1", role: "char", data: "😀" },
        { chatId: "u2", role: "user", data: "é" },
        { chatId: "a2", role: "char", data: "x" },
    ];
    expect(
        await memoryWorkCost(
            costStore(current),
            { chaId: "character", chatId: "chat" },
            { mode: "rebuild", turns: 1 },
            CHARACTERS,
        ),
    ).toEqual({ calls: 2, messages: 4, estimatedTokens: 6_004 });
});

it("estimates rebuild and backfill calls, messages, and UTF-8 bytes from eligible planned turns", async () => {
    const current: Message[] = [
        { chatId: "old-user", role: "user", data: "Before the reset" },
        { chatId: "old-reply", role: "char", data: "Also before the reset" },
        { chatId: "reset", role: "user", data: "Reset marker", disabled: "allBefore" },
        { chatId: "u1", role: "user", data: "한" },
        { chatId: "a1", role: "char", data: "A REFUSAL" },
        { chatId: "u2", role: "user", data: "é" },
        { chatId: "a2", role: "char", data: "BAD FORMAT" },
        { chatId: "u3", role: "user", data: "x" },
        { chatId: "disabled", role: "char", data: "Disabled reply", disabled: true },
        { chatId: "a3", role: "char", data: "😀" },
        { chatId: "u4", role: "user", data: "Retracted user" },
        { chatId: "a4", role: "char", data: "Retracted reply" },
        { chatId: "u5", role: "user", data: "Q" },
        { chatId: "a5", role: "char", data: "答" },
        { chatId: "u6", role: "user", data: "éé" },
        { chatId: "a6", role: "char", data: "ok" },
        { chatId: "u7", role: "user", data: "끝" },
        { chatId: "a7", role: "char", data: "hello" },
        { chatId: "pending", role: "user", data: "No reply yet" },
    ];
    const store = costStore(
        current,
        [
            event("retracted", ["u4", "a4"], { status: "retracted" }),
            event("recorded-turn", ["u5", "a5"]),
            event("recorded-reply", ["a6"]),
        ],
        { refusal: ["refusal"], format: ["bad format"] },
    );

    // Screening folds u1, u2, u3, a3 into one turn: 3 + 2 + 1 + 4 = 10 UTF-8 bytes.
    // Rebuild also takes [u5, a5] (4 bytes), [u6, a6] (6), and [u7, a7] (8): 10 messages, 28 bytes.
    // Backfill drops the recorded turn and a6, leaving the first turn, [u6] (4), [u7, a7] (8): 7 messages, 22 bytes.
    const estimates = [
        { mode: "rebuild", turns: 1, calls: 4, messages: 10, bytes: 28 },
        { mode: "rebuild", turns: 2, calls: 2, messages: 10, bytes: 28 },
        { mode: "backfill", turns: 1, calls: 3, messages: 7, bytes: 22 },
        { mode: "backfill", turns: 2, calls: 2, messages: 7, bytes: 22 },
    ] as const;
    for (const { mode, turns, calls, messages, bytes } of estimates) {
        expect(
            await memoryWorkCost(store, { chaId: "character", chatId: "chat" }, { mode, turns }, CHARACTERS),
            `${mode}, ${turns} turns`,
        ).toEqual({
            calls,
            messages,
            estimatedTokens: memoryCostTokens(bytes, calls),
        });
    }
});

it("bounds rebuild and backfill eligibility reads by transcript size across 2,000 turns", async () => {
    let reads = 0;
    const pairs = 2_000;
    const current: Message[] = Array.from({ length: pairs }, (_, index) =>
        (["user", "char"] as const).map((role) => ({
            chatId: `${role}-${index}`,
            role,
            data: "x",
            get disabled() {
                reads++;
                return false as const;
            },
        })),
    ).flat();
    const store = costStore(current);
    for (const mode of ["rebuild", "backfill"] as const) {
        for (const turns of [1, 2] as const) {
            reads = 0;
            const calls = pairs / turns;
            expect(
                await memoryWorkCost(store, { chaId: "character", chatId: "chat" }, { mode, turns }, CHARACTERS),
            ).toEqual({
                calls,
                messages: pairs * 2,
                estimatedTokens: memoryCostTokens(pairs * 2, calls),
            });
            expect(reads, `${mode}, ${turns} turns`).toBeLessThanOrEqual(current.length * 2);
        }
    }
});

it("rebuilds retired replacements but excludes personal retractions and backfills uncited users of covered turns", () => {
    const events = [
        event("retired", ["u1", "a1"], { status: "retracted" }),
        event("replacement", ["u1", "a1"]),
        event("retracted", ["u2", "a2"], { status: "retracted" }),
        event("adopted-reply", ["a3"], { writerRun: ADOPTED_WRITER_RUN }),
    ];
    expect(rebuildPlan({ messages, events, mode: "rebuild", turns: 1, screening: NO_SCREENING })).toEqual([
        ["u1", "a1"],
        ["u3", "a3"],
    ]);
    expect(rebuildPlan({ messages, events, mode: "rebuild", turns: 2, screening: NO_SCREENING })).toEqual([
        ["u1", "a1", "u3", "a3"],
    ]);
    expect(rebuildPlan({ messages, events, mode: "backfill", turns: 1, screening: NO_SCREENING })).toEqual([["u3"]]);
    expect(rebuildPlan({ messages, events, mode: "fresh", turns: 1, screening: NO_SCREENING })).toEqual([
        ["u1", "a1"],
        ["u2", "a2"],
        ["u3", "a3"],
    ]);
});

it("carries corrected text into a staged event citing the same message set in a different order", () => {
    const corrected = event("old", ["u1", "a1"], {
        title: "Corrected title",
        summary: "Corrected summary",
        userCorrected: true,
    });
    const staged = event("new", ["a1", "u1"], { title: "Writer title", summary: "Writer summary" });
    const { createdRevision, ...written } = staged;
    const changes = rebuildChanges(
        "rebuild",
        { pages: [], threads: [], events: [corrected] },
        { pages: [], threads: [], events: [staged] },
    );
    expect(changes?.events).toEqual([
        { ...written, title: "Corrected title", summary: "Corrected summary", userCorrected: true },
    ]);
});

it("carries only the correction mark when a staged event covers a superset of the corrected messages", () => {
    const corrected = event("old", ["u1", "a1"], {
        title: "Corrected title",
        summary: "Corrected summary",
        userCorrected: true,
    });
    const staged = event("new", ["u1", "a1", "u2", "a2"], { title: "Writer title", summary: "Writer summary" });
    const { createdRevision, ...written } = staged;
    const changes = rebuildChanges(
        "rebuild",
        { pages: [], threads: [], events: [corrected] },
        { pages: [], threads: [], events: [staged] },
    );
    expect(changes?.events).toEqual([{ ...written, userCorrected: true }]);
});

it("keeps the writer's text without a correction mark in a fresh rebuild over corrected messages", () => {
    const corrected = event("old", ["u1", "a1"], {
        title: "Corrected title",
        summary: "Corrected summary",
        userCorrected: true,
    });
    const staged = event("new", ["u1", "a1"], { title: "Writer title", summary: "Writer summary" });
    const { createdRevision, ...written } = staged;
    const changes = rebuildChanges(
        "fresh",
        { pages: [], threads: [], events: [corrected] },
        { pages: [], threads: [], events: [staged] },
    );
    expect(changes?.events).toEqual([written]);
});

it("seeds nothing for a fresh rebuild and its swap removes every live record and the trash, keeping only the adoption lineage", () => {
    const base = memoryRecords(["place"]).pages[0];
    const personal = {
        ...base,
        sections: [{ ...base.sections[0], heading: "locked", locked: true }],
        gradeByUser: true,
        reshaped: true as const,
    };
    const live = {
        pages: [personal, { ...base, id: "ordinary" }],
        threads: [{ id: "personal", title: "A person's thread", state: "open" as const, who: ["place"] }],
        events: [
            event("pinned", ["u1", "a1"], { pinned: true, suppressed: true, userCorrected: true }),
            event("retracted", ["u2", "a2"], { status: "retracted" }),
        ],
        contents: { trash: [{ id: "binned", title: "Binned", bytes: 1 }] },
    };
    expect(rebuildSeed("fresh", live)).toEqual({ pages: [], threads: [] });
    const staged = {
        pages: [{ ...base, id: "written" }],
        threads: [{ id: "opened", title: "Writer's thread", state: "open" as const, who: [], openedBy: "new" }],
        events: [event("new", ["u1", "a1"])],
    };
    const changes = rebuildChanges("fresh", live, staged)!;
    expect(changes).toEqual({
        events: [{ ...memoryRecords(["new"]).events[0], sources: staged.events[0].sources }],
        pages: staged.pages,
        threads: staged.threads,
        remove: { events: ["pinned", "retracted"], pages: ["place", "ordinary", "binned"], threads: ["personal"] },
    });
    expect(rebuildChanges("fresh", live, { ...staged, events: [] })).toBeNull();
    const adopted = { ...live, events: [event("summary", [], { writerRun: ADOPTED_WRITER_RUN, status: "retracted" })] };
    expect(rebuildChanges("fresh", adopted, staged)?.events).toEqual([
        { ...memoryRecords(["new"]).events[0], sources: staged.events[0].sources, adoptedSummaries: true },
    ]);
});

it("keeps a created note and its section through a rebuild swap and removes them on a fresh rebuild", () => {
    let id = 0;
    const created = applyPageTool(
        { page: () => undefined, pages: () => [], events: () => [], threads: () => [] },
        { kind: "create", title: "Travel notes", heading: "Route", body: "Bring a map." },
        { now: 200, newId: () => `note-${++id}` },
    ).shown!;
    const live = { pages: [created], threads: [], events: [] };
    const seed = rebuildSeed("rebuild", live);
    // A completed window is required for a swap even when the writer never mentions the note.
    const events = [event("new", ["u1", "a1"])];
    const changes = rebuildChanges("rebuild", live, { pages: seed.pages!, threads: seed.threads!, events });
    expect(changes).not.toBeNull();
    expect(changes?.pages).toEqual([
        expect.objectContaining({
            id: "note-1",
            type: "note",
            title: "Travel notes",
            contextMode: "auto",
            namedByUser: true,
            sections: [
                {
                    heading: "Route",
                    body: "Bring a map.",
                    provenance: [],
                    sources: [],
                    locked: false,
                    userCorrected: true,
                    updatedAt: 200,
                },
            ],
        }),
    ]);
    expect(changes?.remove?.pages).toEqual([]);
    const fresh = rebuildSeed("fresh", live);
    const reset = rebuildChanges("fresh", live, { pages: fresh.pages!, threads: fresh.threads!, events });
    expect(reset).not.toBeNull();
    expect(reset?.pages).toEqual([]);
    expect(reset?.remove?.pages).toEqual(["note-1"]);
});

it("keeps a page marked only by personal naming through a rebuild seed and swap but drops it on a fresh rebuild", () => {
    const named: MemoryPage = {
        ...memoryRecords(["place"]).pages[0],
        title: "Harbor",
        aliases: ["Old Port", "Quay"],
        namedByUser: true,
    };
    const live = { pages: [named], threads: [], events: [] };
    const expected = { ...named, sections: [], history: [], links: [] };
    const seed = rebuildSeed("rebuild", live);
    expect(seed).toEqual({ pages: [expected], threads: [] });
    // A completed window is required for a swap, even when the writer never mentions this page.
    const events = [event("new", ["u1", "a1"])];
    const changes = rebuildChanges("rebuild", live, { pages: seed.pages!, threads: seed.threads!, events });
    expect(changes).not.toBeNull();
    expect(changes?.pages).toEqual([expected]);
    expect(changes?.remove?.pages).toEqual([]);

    const fresh = rebuildSeed("fresh", live);
    expect(fresh).toEqual({ pages: [], threads: [] });
    const reset = rebuildChanges("fresh", live, { pages: fresh.pages!, threads: fresh.threads!, events });
    expect(reset).not.toBeNull();
    expect(reset?.pages).toEqual([]);
    expect(reset?.remove?.pages).toEqual(["place"]);
});

it("reads planned windows from current messages with fresh anchors and skips removed or disabled sources", () => {
    const edited = { ...messages[2], data: "Edited user" };
    const current = [messages[0], edited, { ...messages[3], disabled: true }, messages[5]];
    const result = rebuildWindow(current, ["a2", "u2", "a1"], NO_SCREENING);
    expect(result).toEqual({
        ceiling: { id: "u2", inclusive: true },
        window: { messages: [edited], sources: [{ messageId: "u2", index: 1, hash: messageSourceHash(edited) }] },
    });
    expect(rebuildWindow(current, ["a1", "a2"], NO_SCREENING)).toBeNull();
});

it("keeps personal sections and history, chosen pages and threads, and carries events until all their sources are replaced", () => {
    const base = memoryRecords(["place"]).pages[0];
    const sections = ["locked", "pinned", "suppressed", "userCorrected"].map((mark) => ({
        ...base.sections[0],
        heading: mark,
        body: `Person's ${mark}`,
        [mark]: true,
    }));
    const history: MemoryPage["history"] = sections.map((section) => ({
        heading: section.heading,
        before: { ...section, body: "Earlier text" },
        at: 1,
        id: section.heading,
        kind: "change",
        highlighted: false,
    }));
    const personal = { ...base, sections: [...sections, { ...base.sections[0], heading: "automatic" }], history };
    const graded = { ...base, id: "graded", grade: 8, gradeByUser: true };
    const chosen = { ...base, id: "chosen", contextMode: "never" as const };
    const threads = [
        { id: "personal", title: "A person's thread", state: "open" as const, who: [] },
        { id: "automatic", title: "Writer's thread", state: "open" as const, who: [], openedBy: "old" },
    ];
    const live = {
        pages: [personal, graded, chosen, { ...base, id: "ordinary" }],
        threads,
        events: [
            event("replace", ["u1", "a1"], { pinned: true, writerRun: ADOPTED_WRITER_RUN }),
            event("partial", ["a1", "gone"], { suppressed: true, userCorrected: true }),
            event("no-source", [], { writerRun: ADOPTED_WRITER_RUN }),
            event("retracted", ["a1"], { status: "retracted" }),
        ],
    };
    const seed = rebuildSeed("rebuild", live);
    expect(seed.threads).toEqual([threads[0]]);
    expect(seed.pages).toEqual([
        { ...personal, sections, links: [] },
        { ...graded, sections: [], history: [], links: [] },
        { ...chosen, sections: [], history: [], links: [] },
    ]);
    const staged = {
        pages: seed.pages!.map((page) => ({
            ...page,
            sections:
                page.id === "place"
                    ? sections.map((section) => ({ ...section, body: "Patch during run" }))
                    : page.sections,
            history: [],
        })),
        threads: seed.threads!,
        events: [event("new", ["u1", "a1"])],
    };
    const changes = rebuildChanges("rebuild", live, staged)!;
    expect(changes.remove).toEqual({ events: ["replace"], pages: ["ordinary"], threads: ["automatic"] });
    expect(changes.events).toEqual([
        {
            ...memoryRecords(["new"]).events[0],
            sources: staged.events[0].sources,
            pinned: true,
            suppressed: true,
            userCorrected: true,
            adoptedSummaries: true,
        },
    ]);
    expect(changes.pages?.[0]).toEqual({ ...personal, sections });
    expect(changes.pages?.slice(1)).toEqual(seed.pages!.slice(1));
    expect(rebuildChanges("rebuild", live, { ...staged, events: [] })).toBeNull();
    const later = rebuildChanges(
        "rebuild",
        { ...live, events: [{ ...changes.events![0], createdRevision: 8 }] },
        { ...staged, events: [event("newer", ["u1", "a1"])] },
    );
    expect(later?.events?.[0]).toMatchObject({ adoptedSummaries: true });
});

it("keeps live page ids named by retained threads through the rebuild seed and swap", () => {
    const base = memoryRecords(["place"]).pages[0];
    const page: MemoryPage = {
        ...base,
        links: ["writer-place"],
        history: [
            {
                id: "earlier",
                kind: "change",
                heading: base.sections[0].heading,
                before: { ...base.sections[0], body: "Earlier text" },
                at: 1,
                highlighted: false,
            },
        ],
    };
    const scene: MemoryPage = {
        ...page,
        id: "scene",
        type: "scene",
        contextMode: "always",
        participants: ["place"],
    };
    const threads = [
        { id: "personal", title: "Find the key", state: "open" as const, who: ["place", "scene", "missing"] },
        { id: "automatic", title: "Writer's thread", state: "open" as const, who: ["writer-place"], openedBy: "old" },
    ];
    const live = {
        // The writer-only page shares a title with the retained page; references are ids.
        pages: [page, scene, { ...base, id: "writer-place" }],
        threads,
        events: [],
    };
    const expectedPages = [
        { ...page, sections: [], history: [], links: [] },
        { ...scene, sections: [], history: [], links: [], participants: [] },
    ];
    const seed = rebuildSeed("rebuild", live);
    expect(seed).toEqual({ pages: expectedPages, threads: [threads[0]] });

    const changes = rebuildChanges("rebuild", live, {
        pages: seed.pages!,
        threads: seed.threads!,
        events: [event("new", ["u1", "a1"])],
    });
    expect(changes?.pages).toEqual(expectedPages);
    expect(changes?.threads).toEqual([threads[0]]);
    expect(changes?.remove).toEqual({ events: [], pages: ["writer-place"], threads: ["automatic"] });
    expect(rebuildSeed("backfill", live)).toEqual({ pages: live.pages });
});

it("seeds every unmarked section and history entry of merged and split pages", () => {
    const base = memoryRecords(["ordinary"]).pages[0];
    const pages = ["merged", "split"].map((id): MemoryPage => ({
        ...base,
        id,
        reshaped: true,
        sections: [base.sections[0], { ...base.sections[0], heading: "Access", body: "By boat" }],
        history: [
            {
                id: `tool-${id}`,
                kind: id === "merged" ? "merge" : "split",
                heading: null,
                before: null,
                at: 1,
                highlighted: false,
            },
        ],
    }));
    expect(rebuildSeed("rebuild", { pages: [base, ...pages], threads: [] })).toEqual({ pages, threads: [] });
});

it("screens rebuild and backfill plans and rechecks edited replies when building each window", () => {
    const current = structuredClone(messages);
    current[1].data = "A REFUSAL in stored text";
    const screening = { refusal: ["refusal"], format: ["bad format"] };
    const events = [event("recorded", ["u1", "a1"])];
    const before = structuredClone(events);
    const rebuild = rebuildPlan({ messages: current, events, mode: "rebuild", turns: 1, screening });
    expect(rebuild).toEqual([
        ["u1", "u2", "a2"],
        ["u3", "a3"],
    ]);
    expect(rebuildPlan({ messages: current, events, mode: "backfill", turns: 1, screening })).toEqual([
        ["u2", "a2"],
        ["u3", "a3"],
    ]);
    current[3].data = "Now BAD FORMAT";
    expect(rebuildWindow(current, rebuild[0], screening)).toMatchObject({
        window: { messages: [current[0], current[2]] },
    });
    expect(rebuildWindow(current, ["a2"], screening)).toBeNull();
    const changes = rebuildChanges(
        "rebuild",
        { pages: [], threads: [], events },
        { pages: [], threads: [], events: [event("new", ["u1", "u2", "a2"])] },
    );
    expect(changes?.remove?.events ?? []).not.toContain("recorded");
    expect(events).toEqual(before);
});

it("screens the rebuild cost with the chat's preset and falls back after that preset is deleted", async () => {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: ":memory:", kinds });
    try {
        const kind = kinds.get("hypaV3Presets")!;
        const record = store.get(kind, "main")!;
        const defaults = createHypaV3Preset(
            "Default",
            { structured: { screening: { refusal: [], format: [] } } },
            "default",
        );
        const personal = createHypaV3Preset(
            "Chat",
            { structured: { screening: { refusal: ["refusal"], format: [] } } },
            "chat",
        );
        store.put(kind, "main", { items: [defaults, personal], selectedId: "default" }, record.revision);
        store.put(kinds.get("characters")!, "c", { chaId: "c", type: "character", name: "C" }, null);
        store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: "k",
                                memoryPresetId: "chat",
                                message: [
                                    { chatId: "u1", role: "user", data: "Q" },
                                    { chatId: "a1", role: "char", data: "refusal" },
                                    { chatId: "u2", role: "user", data: "Q" },
                                    { chatId: "a2", role: "char", data: "A" },
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        // Screening folds the two user messages and the eligible answer into one 3-byte turn.
        expect(
            await memoryWorkCost(store, { chaId: "c", chatId: "k" }, { mode: "rebuild", turns: 1 }, CHARACTERS),
        ).toEqual({
            calls: 1,
            messages: 3,
            estimatedTokens: 3001,
        });
        store.put(kind, "main", { items: [defaults], selectedId: "default" }, store.get(kind, "main")!.revision);
        // With the default's empty screening, both turns count: 10 bytes plus two call overheads.
        expect(
            await memoryWorkCost(store, { chaId: "c", chatId: "k" }, { mode: "rebuild", turns: 1 }, CHARACTERS),
        ).toEqual({
            calls: 2,
            messages: 4,
            estimatedTokens: 6004,
        });
        expect(store.chatMeta("c", "k")!.data.memoryPresetId).toBe("chat");
    } finally {
        store.close();
    }
});

it("attaches the greeting only to the first rebuild window, excluding retracted greetings, groups and resets", () => {
    const greeting = writerGreeting({ firstMessage: "Welcome" }, { fmIndex: -1, message: messages })!;
    const retracted = event("retracted-greeting", [], { greeting: greeting.source, status: "retracted" });
    const standing = event("standing-greeting", [], { greeting: greeting.source, status: "stale" });
    for (const mode of ["rebuild", "fresh"] as const) {
        for (const events of [[], [retracted], [retracted, standing]]) {
            expect(
                rebuildPlan({ messages, events, mode, turns: 1, screening: NO_SCREENING, greeting }),
                `${mode}, ${events.map(({ id }) => id)}`,
            ).toEqual([
                mode === "rebuild" && events.length === 1
                    ? ["u1", "a1"]
                    : { ids: ["u1", "a1"], greeting: greeting.source },
                ["u2", "a2"],
                ["u3", "a3"],
            ]);
        }
    }
    for (const row of [
        { owner: { type: "group" as const, firstMessage: "Group greeting" }, messages },
        {
            owner: { firstMessage: "Welcome" },
            messages: [
                { chatId: "reset", role: "user" as const, data: "Old history", disabled: "allBefore" as const },
                ...messages,
            ],
        },
    ]) {
        const greeting = writerGreeting(row.owner, { fmIndex: -1, message: row.messages });
        for (const mode of ["rebuild", "fresh", "backfill"] as const) {
            expect(
                rebuildPlan({ messages: row.messages, events: [], mode, turns: 1, screening: NO_SCREENING, greeting }),
            ).toEqual([
                ["u1", "a1"],
                ["u2", "a2"],
                ["u3", "a3"],
            ]);
        }
    }
});

it("backfills an unrecorded greeting before messages and none once any event cites it", () => {
    const greeting = writerGreeting({ firstMessage: "Welcome" }, { fmIndex: -1, message: messages })!;
    const args = { messages, mode: "backfill" as const, turns: 1 as const, screening: NO_SCREENING, greeting };
    const ordinary = [
        ["u1", "a1"],
        ["u2", "a2"],
        ["u3", "a3"],
    ];
    const greetingOnly = { ids: [], greeting: greeting.source };
    expect(rebuildPlan({ ...args, events: [] })).toEqual([greetingOnly, ...ordinary]);
    for (const status of ["active", "stale", "retracted"] as const) {
        // A changed greeting is still recorded; backfill must not silently re-record it.
        const cited = event(status, [], {
            greeting: { fmIndex: 0, hash: greetingSourceHash("Earlier greeting") },
            status,
            suppressed: true,
        });
        expect(rebuildPlan({ ...args, events: [cited] }), status).toEqual(ordinary);
    }
    const recorded = event("recorded-messages", ["u1", "a1", "u2", "a2", "u3", "a3"]);
    expect(rebuildPlan({ ...args, events: [recorded] })).toEqual([greetingOnly]);
    expect(rebuildPlan({ ...args, messages: [messages[0]], events: [] })).toEqual([greetingOnly]);
    expect(rebuildPlan({ ...args, messages: [{ ...messages[0], disabled: true }], events: [] })).toEqual([]);
});

it("bounds a greeting-only window before the first eligible message and refuses a changed stored greeting", () => {
    const current = [{ ...messages[0], chatId: "disabled", disabled: true }, ...messages];
    const greeting = writerGreeting({ firstMessage: "Welcome" }, { fmIndex: -1, message: current })!;
    const entry = { ids: [], greeting: { ...greeting.source } };
    expect(rebuildWindow(current, entry, NO_SCREENING, false, greeting)).toEqual({
        window: { messages: [], sources: [], greeting: { source: entry.greeting, text: "Welcome" } },
        ceiling: { id: "u1", inclusive: false },
    });
    for (const changed of [
        null,
        { ...greeting, source: { ...greeting.source, fmIndex: 0 } },
        { text: "Goodbye", source: { ...greeting.source, hash: greetingSourceHash("Goodbye") } },
    ]) {
        expect(rebuildWindow(current, entry, NO_SCREENING, false, changed)).toBe("windowChanged");
    }
});

it("replaces standing greeting-only events with their marks and retains retractions and uncovered mixed events", () => {
    const greeting = { fmIndex: -1, hash: greetingSourceHash("Welcome") };
    const live = {
        pages: [],
        threads: [],
        events: [
            event("standing", [], { greeting, status: "stale", pinned: true, suppressed: true, userCorrected: true }),
            event("retracted", [], { greeting, status: "retracted" }),
            event("mixed", ["u1", "a1"], { greeting }),
        ],
    };
    const staged = event("new-greeting", [], { greeting });
    const { createdRevision, ...written } = staged;
    const changes = rebuildChanges("rebuild", live, { pages: [], threads: [], events: [staged] });
    expect(changes?.remove?.events).toEqual(["standing"]);
    expect(changes?.events).toEqual([
        {
            ...written,
            title: live.events[0].title,
            summary: live.events[0].summary,
            pinned: true,
            suppressed: true,
            userCorrected: true,
        },
    ]);
    const messageOnly = rebuildChanges("rebuild", live, {
        pages: [],
        threads: [],
        events: [event("new-messages", ["u1", "a1"])],
    });
    expect(messageOnly?.remove?.events).toEqual([]);
});

it("replaces a covered mixed event only after the greeting is gone and still carries greeting-only events", () => {
    const greeting = { fmIndex: -1, hash: greetingSourceHash("Welcome") };
    const live = {
        pages: [],
        threads: [],
        events: [event("mixed", ["a1"], { greeting }), event("greeting-only", [], { greeting })],
    };
    const replacement = event("replacement", ["a1"]);
    const staged = { pages: [], threads: [], events: [replacement] };
    const { createdRevision, ...written } = replacement;

    const removedGreeting = rebuildChanges("rebuild", live, staged, [], false);
    expect(removedGreeting?.events).toEqual([written]);
    expect(removedGreeting?.remove?.events).toEqual(["mixed"]);

    const presentGreeting = rebuildChanges("rebuild", live, staged, [], true);
    expect(presentGreeting?.events).toEqual([written]);
    expect(presentGreeting?.remove?.events).toEqual([]);
});

it("estimates a marked greeting repair as a separate Record now call with no messages", async () => {
    const store = createResourceStore({ file: ":memory:", kinds: createKindRegistry(DEFAULT_RESOURCE_KINDS) });
    try {
        const firstMessage = "한😀é";
        const ref = { chaId: "c", chatId: "k" };
        const query = { mode: "record", turns: 1, through: "a1" } as const;
        store.put(CHARACTERS, ref.chaId, { chaId: ref.chaId, type: "character", name: "C", firstMessage }, null);
        store.applyChanges({
            chats: [
                {
                    characterId: ref.chaId,
                    chatId: ref.chatId,
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: ref.chatId, fmIndex: -1, message: messages.slice(0, 2) } }],
                },
            ],
        });
        expect(await memoryWorkCost(store, ref, query, CHARACTERS)).toEqual({
            calls: 1,
            messages: 2,
            estimatedTokens: memoryCostTokens(4, 1),
        });

        store.memory.write(
            ref.chaId,
            ref.chatId,
            { epoch: store.epoch(), baseRevision: store.memory.readContents(ref.chaId, ref.chatId)!.revision },
            {
                events: [
                    event("greeting", [], {
                        greeting: { fmIndex: -1, hash: greetingSourceHash(firstMessage) },
                        rerecord: true,
                    }),
                ],
            },
        );

        expect(await memoryWorkCost(store, ref, query, CHARACTERS)).toEqual({
            calls: 2,
            messages: 2,
            estimatedTokens: memoryCostTokens(4 + Buffer.byteLength(firstMessage), 2),
        });
    } finally {
        store.close();
    }
});

it("charges greeting UTF-8 bytes once and a greeting-only backfill call without adding a message", async () => {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: ":memory:", kinds });
    try {
        store.put(
            kinds.get("characters")!,
            "c",
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "한😀é",
            },
            null,
        );
        const current: Message[] = [
            { chatId: "u1", role: "user", data: "x" },
            { chatId: "a1", role: "char", data: "ok" },
            { chatId: "u2", role: "user", data: "x" },
            { chatId: "a2", role: "char", data: "ok" },
        ];
        store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: "k", fmIndex: -1, message: current } }],
                },
            ],
        });
        // Nine greeting bytes plus six message bytes: five text tokens, with 3,000 per call.
        for (const mode of ["rebuild", "fresh", "backfill"] as const) {
            expect(
                await memoryWorkCost(store, { chaId: "c", chatId: "k" }, { mode, turns: 1 }, CHARACTERS),
                mode,
            ).toEqual({
                calls: mode === "backfill" ? 3 : 2,
                messages: 4,
                estimatedTokens: mode === "backfill" ? 9005 : 6005,
            });
        }
        store.memory.write(
            "c",
            "k",
            { epoch: store.epoch(), baseRevision: store.memory.readContents("c", "k")!.revision },
            {
                events: [event("recorded", ["u1", "a1", "u2", "a2"])],
            },
        );
        expect(
            await memoryWorkCost(store, { chaId: "c", chatId: "k" }, { mode: "backfill", turns: 1 }, CHARACTERS),
        ).toEqual({ calls: 1, messages: 0, estimatedTokens: 3003 });
    } finally {
        store.close();
    }
});
