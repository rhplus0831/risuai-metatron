// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import { ADOPTED_WRITER_RUN, type MemoryEvent, type MemoryPage } from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { rebuildChanges, rebuildPlan, rebuildSeed, rebuildWindow } from "./rebuild.ts";

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

const NO_SCREENING = { refusal: [], format: [] };

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
