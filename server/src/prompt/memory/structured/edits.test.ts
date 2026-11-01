// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    coveredMessages,
    memoryAnchorState,
    type MemoryPage,
    type MemoryThread,
    type MemoryThreadState,
} from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash } from "../../../data/memoryStore.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { applyEventRepair, applyPageEdit, applyThreadEdit, MemoryEditRefusal, parseMemoryEdit } from "./edits.ts";
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
    expect([...coveredMessages(reconcileEvents([kept], changed))]).toEqual(["u", "a"]);
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
