// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    ADOPTED_WRITER_RUN,
    memoryCostTokens,
    type MemoryEvent,
    type MemoryPage,
} from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { memoryWorkCost, rebuildChanges, rebuildPlan, rebuildSeed, rebuildWindow } from "./rebuild.ts";

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

function costStore(message: Message[], events: MemoryEvent[] = [], screening: typeof NO_SCREENING = NO_SCREENING) {
    return {
        readChatSource: () => ({ data: { message } }),
        memory: {
            readWriterSettings: () => ({ screening }),
            readContents: () => ({ events }),
            readRecord: (_chaId: string, _chatId: string, _kind: string, id: string) => ({
                data: events.find((record) => record.id === id),
            }),
        },
    } as unknown as Parameters<typeof memoryWorkCost>[0];
}

it("previews two rebuild calls with 6,000 overhead tokens and four text tokens", async () => {
    // Two turns total 3 + 4 + 2 + 1 = 10 UTF-8 bytes, so ceil(10 / 3) = 4 text tokens.
    const current: Message[] = [
        { chatId: "u1", role: "user", data: "한" },
        { chatId: "a1", role: "char", data: "😀" },
        { chatId: "u2", role: "user", data: "é" },
        { chatId: "a2", role: "char", data: "x" },
    ];
    expect(
        await memoryWorkCost(costStore(current), { chaId: "character", chatId: "chat" }, { mode: "rebuild", turns: 1 }),
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
            await memoryWorkCost(store, { chaId: "character", chatId: "chat" }, { mode, turns }),
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
            expect(await memoryWorkCost(store, { chaId: "character", chatId: "chat" }, { mode, turns })).toEqual({
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
