// @vitest-environment node
import { expect, it } from "vitest";
import type { MemoryPage, MemoryThread, MemoryThreadState } from "../../../../../shared/structuredMemory.ts";
import { applyPageEdit, applyThreadEdit, MemoryEditRefusal, parseMemoryEdit } from "./edits.ts";

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
