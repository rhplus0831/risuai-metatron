// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    coveredMessages,
    memoryAnchorState,
    STRUCTURED_MEMORY_LIMITS,
    type MemoryEvent,
    type MemoryPage,
    type MemoryThread,
    type MemoryThreadState,
} from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import {
    applyEventRelease,
    applyEventRepair,
    applyEventText,
    applyPageEdit,
    applyThreadEdit,
    MemoryEditRefusal,
    parseMemoryEdit,
} from "./edits.ts";
import { reconcileEvents } from "./reconcile.ts";

const page: MemoryPage = {
    id: "p",
    type: "location",
    title: "Gate",
    aliases: [],
    contextMode: "auto",
    sections: [{ heading: "Facts", body: "Closed", provenance: ["e"], sources: [], locked: false, updatedAt: 7 }],
    links: [],
    retrieval: { keywords: [] },
    history: [{ id: "h", heading: "Facts", before: null, kind: "edit", highlighted: false, at: 7 }],
};
const stamp = { now: 20, newId: () => "edit-id" };

it("accepts trimmed event titles and intact summaries at their limits and refuses blank or oversized text", () => {
    const title = "t".repeat(STRUCTURED_MEMORY_LIMITS.eventTitleChars);
    const summary = `\n${"s".repeat(STRUCTURED_MEMORY_LIMITS.eventSummaryChars - 2)}\n`;
    const edit = { kind: "eventText", eventId: "e", title, summary };
    expect(parseMemoryEdit({ ...edit, title: ` ${title} ` })).toEqual(edit);
    for (const invalid of [
        { title: " \n\t" },
        { summary: " \n\t" },
        { title: `${title}x` },
        { summary: `${summary}x` },
    ]) {
        expect(parseMemoryEdit({ ...edit, ...invalid }), JSON.stringify(invalid)).toBeNull();
    }
});

it("corrects only an event's title, summary and user mark while preserving evidence and repair state", () => {
    const event: MemoryEvent = {
        ...memoryRecords(["e"]).events[0],
        createdRevision: 7,
        status: "stale",
        staleReason: "changed",
        sources: [{ messageId: "m", index: 2, hash: "recorded" }],
        keptState: "accepted sources",
        rerecord: true,
        grade: 3,
        pinned: true,
        suppressed: true,
    };
    const before = structuredClone(event);
    expect(
        applyEventText(event, { kind: "eventText", eventId: "e", title: "Gate closed", summary: "It stayed shut." }),
    ).toEqual({ ...before, title: "Gate closed", summary: "It stayed shut.", userCorrected: true });
    expect(event).toEqual(before);
});

it("refuses corrections to retracted events as invalid even when the text is unchanged", () => {
    const event: MemoryEvent = {
        ...memoryRecords(["e"]).events[0],
        createdRevision: 1,
        status: "retracted",
    };
    for (const title of ["Correction", event.title]) {
        expect(() => applyEventText(event, { kind: "eventText", eventId: "e", title, summary: event.summary })).toThrow(
            expect.objectContaining({ reason: "invalid" }),
        );
    }
});

it("leaves equal event text and releases of unmarked events unchanged", () => {
    const event = { ...memoryRecords(["e"]).events[0], createdRevision: 1 };
    const edit = { kind: "eventText" as const, eventId: "e", title: event.title, summary: event.summary };
    expect(applyEventText(event, edit)).toBeNull();
    expect(applyEventText({ ...event, userCorrected: true }, edit)).toBeNull();
    expect(applyEventRelease(event)).toBeNull();
});

it("releases only the event correction mark and keeps the corrected text and other fields", () => {
    const event: MemoryEvent = {
        ...memoryRecords(["e"]).events[0],
        createdRevision: 7,
        title: "Corrected title",
        summary: "Corrected summary",
        sources: [{ messageId: "m", index: 2, hash: "recorded" }],
        keptState: "accepted sources",
        rerecord: true,
        grade: 3,
        pinned: true,
    };
    expect(parseMemoryEdit({ kind: "eventRelease", eventId: "e" })).toEqual({ kind: "eventRelease", eventId: "e" });
    const marked = { ...event, userCorrected: true as const };
    expect(applyEventRelease(marked)).toEqual(event);
    expect(marked.userCorrected).toBe(true);
});

it("parses trimmed section additions at the text limits and refuses blank or oversized text", () => {
    const edit = {
        kind: "sectionAdd",
        pageId: "p",
        heading: "h".repeat(STRUCTURED_MEMORY_LIMITS.labelChars),
        body: "b".repeat(STRUCTURED_MEMORY_LIMITS.sectionBodyChars),
    };
    expect(parseMemoryEdit({ ...edit, heading: ` ${edit.heading} ` })).toEqual(edit);
    for (const field of ["heading", "body"] as const) {
        for (const value of [" \n\t", `${edit[field]}x`]) {
            expect(parseMemoryEdit({ ...edit, [field]: value }), field).toBeNull();
        }
    }
});

it("appends a personally corrected section with empty evidence and eventless edit history", () => {
    const edit = parseMemoryEdit({ kind: "sectionAdd", pageId: "p", heading: "  Route  ", body: "Bring a map." });
    if (!edit || edit.kind !== "sectionAdd") throw new Error("A valid section addition was refused");
    expect(applyPageEdit(page, edit, stamp)).toStrictEqual({
        ...page,
        sections: [
            ...page.sections,
            {
                heading: "Route",
                body: "Bring a map.",
                provenance: [],
                sources: [],
                locked: false,
                userCorrected: true,
                updatedAt: 20,
            },
        ],
        history: [
            ...page.history,
            { id: "edit-id", heading: "Route", before: null, kind: "edit", highlighted: false, at: 20 },
        ],
    });
});

it("refuses added sections on character and scene pages, duplicate headings and full pages", () => {
    const edit = { kind: "sectionAdd", pageId: "p", heading: "Route", body: "Bring a map." } as const;
    const full = {
        ...page,
        sections: Array.from({ length: STRUCTURED_MEMORY_LIMITS.sectionsPerPage }, (_, i) => ({
            ...page.sections[0],
            heading: `Section ${i}`,
        })),
    };
    for (const refused of [
        { ...page, type: "character" as const },
        { ...page, type: "scene" as const },
        { ...page, sections: [{ ...page.sections[0], heading: "Route" }] },
        full,
    ]) {
        expect(() => applyPageEdit(refused, edit, stamp)).toThrow(
            expect.objectContaining({ reason: "invalid", constructor: MemoryEditRefusal }),
        );
    }
});

it("changes locks without history, marks and clears user grades, and keeps the scene context mode", () => {
    const locked = applyPageEdit(page, { kind: "sectionLock", pageId: "p", heading: "Facts", locked: true }, stamp)!;
    expect(locked).toEqual({ ...page, sections: [{ ...page.sections[0], locked: true }] });
    expect(
        parseMemoryEdit({ kind: "page", pageId: "p", grade: 0, gradeByUser: false, type: "scene", id: "forged" }),
    ).toEqual({ kind: "page", pageId: "p", grade: 0 });
    const graded = applyPageEdit(page, { kind: "page", pageId: "p", grade: 0 }, stamp)!;
    expect(graded).toEqual({ ...page, grade: 0, gradeByUser: true });
    expect(applyPageEdit(graded, { kind: "page", pageId: "p", grade: null }, stamp)).toEqual(page);
    expect(applyPageEdit(page, { kind: "page", pageId: "p", contextMode: "never" }, stamp)).toEqual({
        ...page,
        contextMode: "never",
    });
    const scene: MemoryPage = { ...page, type: "scene", contextMode: "always", participants: [] };
    for (const contextMode of ["auto", "never"] as const)
        expect(() => applyPageEdit(scene, { kind: "page", pageId: "p", contextMode }, stamp)).toThrow(
            MemoryEditRefusal,
        );
    expect(scene.contextMode).toBe("always");
});

it("lets threads enter every state and removes closing evidence when an ended thread reopens", () => {
    const states: MemoryThreadState[] = ["open", "progress", "partial", "done", "cancelled", "paused"];
    for (const from of states) {
        const ended = from === "done" || from === "cancelled";
        const thread: MemoryThread = {
            id: "t",
            title: "Promise",
            who: ["p"],
            state: from,
            openedBy: "opening",
            ...(ended ? { closedBy: "closing" } : {}),
        };
        for (const state of states) {
            expect(
                parseMemoryEdit({
                    kind: "thread",
                    threadId: "t",
                    state,
                    who: [],
                    openedBy: "forged",
                    closedBy: "forged",
                }),
            ).toEqual({ kind: "thread", threadId: "t", state });
            const expected: MemoryThread = { ...thread, state };
            if (ended && state !== "done" && state !== "cancelled") delete expected.closedBy;
            expect(applyThreadEdit(thread, { kind: "thread", threadId: "t", state })).toEqual(
                state === from ? null : expected,
            );
        }
        expect(thread.closedBy).toBe(ended ? "closing" : undefined);
    }
});

it("keeps only the seen source state, marks rerecord without replacing evidence, and makes retraction final", () => {
    const original: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
    ];
    const event = {
        ...memoryRecords(["e"]).events[0],
        createdRevision: 1,
        sources: original.map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) })),
    };
    const changed = [original[0], { ...original[1], data: "Edited" }];
    const state = memoryAnchorState(event.sources, changed, messageSourceHash);
    const keep = { kind: "event" as const, eventId: "e", repair: "keep" as const, state };
    expect(parseMemoryEdit({ ...keep, status: "retracted", sources: [] })).toEqual(keep);
    expect(parseMemoryEdit({ kind: "event", eventId: "e", repair: "keep" })).toBeNull();
    expect(() => applyEventRepair(event, keep, original, messageSourceHash)).toThrow(
        expect.objectContaining({ reason: "changed" }),
    );
    const kept = applyEventRepair(event, keep, changed, messageSourceHash)!;
    expect(kept).toEqual({ ...event, keptState: state });
    expect([...coveredMessages(reconcileEvents([kept], changed)).messages]).toEqual(["u", "a"]);
    expect(reconcileEvents([kept], [original[0], { ...original[1], data: "Edited again" }])[0]).toMatchObject({
        status: "stale",
        staleReason: "changed",
    });
    const rerecord = { kind: "event" as const, eventId: "e", repair: "rerecord" as const };
    const marked = applyEventRepair(event, rerecord, changed, messageSourceHash)!;
    expect(marked).toEqual({ ...event, rerecord: true });
    expect(() => applyEventRepair(event, rerecord, [changed[1], changed[0]], messageSourceHash)).toThrow(
        expect.objectContaining({ reason: "invalid" }),
    );
    const retracted = applyEventRepair(
        marked,
        { kind: "event", eventId: "e", repair: "retract" },
        changed,
        messageSourceHash,
    )!;
    expect(retracted).toEqual({ ...event, status: "retracted" });
    for (const edit of [keep, rerecord])
        expect(() => applyEventRepair(retracted, edit, changed, messageSourceHash)).toThrow(
            expect.objectContaining({ reason: "invalid" }),
        );
    expect(event).not.toHaveProperty("rerecord");
});

it("parses a closed section keep and preserves text, evidence sources and marks while dropping only retracted provenance", () => {
    const edit = { kind: "sectionKeep" as const, pageId: "p", heading: "Facts", preserve: true };
    expect(parseMemoryEdit({ ...edit, body: "forged", unsupported: true, provenance: ["forged"] })).toEqual(edit);
    for (const invalid of [
        { ...edit, preserve: undefined },
        { ...edit, preserve: "true" },
        { ...edit, heading: null },
    ])
        expect(parseMemoryEdit(invalid)).toBeNull();
    const flagged: MemoryPage = {
        ...page,
        sections: [
            {
                ...page.sections[0],
                unsupported: true,
                disputed: true,
                locked: true,
                pinned: true,
                suppressed: true,
                provenance: ["dead", "active", "stale", "unknown", "dead"],
                sources: [{ messageId: "removed", index: 1, hash: "recorded" }],
            },
        ],
    };
    const events = [
        { id: "dead", status: "retracted" as const },
        { id: "active", status: "active" as const },
        { id: "stale", status: "stale" as const },
    ];
    const { unsupported, ...section } = flagged.sections[0];
    for (const preserve of [true, false]) {
        expect(applyPageEdit(flagged, { ...edit, preserve }, stamp, events)).toEqual({
            ...flagged,
            sections: [
                {
                    ...section,
                    provenance: ["active", "stale", "unknown"],
                    ...(preserve ? { userCorrected: true } : {}),
                },
            ],
        });
    }
    expect(flagged.sections[0].unsupported).toBe(true);
});

it("releases a corrected section by removing its mark alone, and changes nothing of an unmarked one", () => {
    const edit = { kind: "sectionRelease" as const, pageId: "p", heading: "Facts" };
    expect(parseMemoryEdit({ ...edit, userCorrected: true, body: "forged", locked: false })).toEqual(edit);
    expect(parseMemoryEdit({ ...edit, heading: null })).toBeNull();
    const marked: MemoryPage = {
        ...page,
        sections: [
            { ...page.sections[0], userCorrected: true, unsupported: true, locked: true, pinned: true },
            { ...page.sections[0], heading: "Other", userCorrected: true },
        ],
    };
    const { userCorrected, ...released } = marked.sections[0];
    expect(applyPageEdit(marked, edit, stamp)).toEqual({ ...marked, sections: [released, marked.sections[1]] });
    expect(marked.sections[0].userCorrected).toBe(true);
    expect(applyPageEdit(page, edit, stamp)).toBeNull();
    expect(() => applyPageEdit(marked, { ...edit, heading: "Gone" }, stamp)).toThrow(
        expect.objectContaining({ reason: "sectionGone" }),
    );
});

it("keeps only flagged sections, never clears a prior correction, refuses a missing heading, and leaves body edits flagged", () => {
    const keep = { kind: "sectionKeep" as const, pageId: "p", heading: "Facts", preserve: false };
    for (const preserve of [false, true]) expect(applyPageEdit(page, { ...keep, preserve }, stamp)).toBeNull();
    const flagged: MemoryPage = {
        ...page,
        sections: [{ ...page.sections[0], unsupported: true, userCorrected: true }],
    };
    const { unsupported, ...section } = flagged.sections[0];
    expect(applyPageEdit(flagged, keep, stamp)).toEqual({ ...flagged, sections: [section] });
    expect(() => applyPageEdit(flagged, { ...keep, heading: "Gone" }, stamp)).toThrow(
        expect.objectContaining({ reason: "sectionGone" }),
    );
    const edited = applyPageEdit(
        flagged,
        { kind: "section", pageId: "p", heading: "Facts", body: "Person's wording" },
        stamp,
    )!;
    expect(edited.sections[0]).toEqual({ ...flagged.sections[0], body: "Person's wording", updatedAt: 20 });
});

it("keeps the shown greeting without rewriting the event or its pending repairs", () => {
    const greeting = { fmIndex: -1, hash: "recorded" };
    const current = { fmIndex: 0, hash: "shown" };
    const event: MemoryEvent = {
        ...memoryRecords(["e"]).events[0],
        createdRevision: 1,
        greeting,
        greetingKept: { fmIndex: -1, hash: "previously accepted" },
        status: "stale",
        staleReason: "changed",
        rerecord: true,
        suppressed: true,
    };
    const before = structuredClone(event);
    const edit = { kind: "event" as const, eventId: "e", repair: "keepGreeting" as const, greeting: current };
    expect(parseMemoryEdit({ ...edit, status: "active", sources: [], rerecord: false })).toEqual(edit);
    expect(applyEventRepair(event, edit, [], messageSourceHash, true, current)).toEqual({
        ...before,
        greetingKept: current,
    });
    expect(event).toEqual(before);
});

it("refuses a moved greeting or an event with no keepable greeting", () => {
    const greeting = { fmIndex: -1, hash: "recorded" };
    const shown = { fmIndex: 0, hash: "shown" };
    const event = { ...memoryRecords(["e"]).events[0], createdRevision: 1, greeting };
    const edit = { kind: "event" as const, eventId: "e", repair: "keepGreeting" as const, greeting: shown };
    for (const current of [
        { ...shown, fmIndex: 1 },
        { ...shown, hash: "changed again" },
    ]) {
        expect(() => applyEventRepair(event, edit, [], messageSourceHash, true, current)).toThrow(
            expect.objectContaining({ reason: "changed" }),
        );
    }
    for (const invalid of [
        { ...memoryRecords(["e"]).events[0], createdRevision: 1 },
        { ...event, status: "retracted" as const },
    ]) {
        expect(() => applyEventRepair(invalid, edit, [], messageSourceHash, true, shown)).toThrow(
            expect.objectContaining({ reason: "invalid" }),
        );
    }
    expect(() => applyEventRepair(event, edit, [], messageSourceHash, false, null)).toThrow(
        expect.objectContaining({ reason: "invalid" }),
    );
});
