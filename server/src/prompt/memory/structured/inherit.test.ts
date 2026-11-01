// @vitest-environment node
import { expect, it } from "vitest";
import type { Message } from "../../../../../shared/database.ts";
import {
    reconcileMemoryEvents,
    type MemoryEvent,
    type MemoryPage,
    type MemorySource,
    type MemoryThread,
} from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { applyPageEdit } from "./edits.ts";
import { inheritedRecords } from "./inherit.ts";
import { addPage, changeSection, newScenePage, type PageChanges, type PageStamp } from "./pages.ts";

const message = (chatId: string, data: string, role: Message["role"] = "char"): Message => ({ chatId, data, role });
const hashOf = ({ role, data }: Message) => JSON.stringify([role, data]);
const anchor = (m: Message, index: number): MemorySource => ({ messageId: m.chatId!, index, hash: hashOf(m) });
const event = (id: string, sources: MemorySource[]): MemoryEvent => ({
    ...memoryRecords([id]).events[0],
    createdRevision: 7,
    sources,
});
const page = (id: string): MemoryPage => ({ ...memoryRecords([id]).pages[0], sections: [] });
const stamp = (e: MemoryEvent, at: number): PageStamp => ({
    eventId: e.id,
    sources: e.sources,
    at,
    newId: () => `history-${at}`,
});
function change(p: MemoryPage, heading: string, body: string | null, e: MemoryEvent, at: number): MemoryPage {
    const changes: PageChanges = new Map();
    changeSection(changes, p, { heading, body, kind: "change" }, stamp(e, at));
    return changes.get(p.id)!.page;
}

it("maps ids before positions, requires identical role and text, and never borrows another source message", () => {
    const sourceMessages = [
        message("same-id", "Edited since recording"),
        message("new-id", "Unchanged"),
        message("role", "Same words", "user"),
        message("text", "Old words"),
        message("first-ok", "ok"),
        message("second-ok", "ok"),
    ];
    const messages = [
        sourceMessages[0],
        message("copy-new-id", "Unchanged"),
        message("copy-role", "Same words", "char"),
        message("copy-text", "New words"),
        sourceMessages[5],
    ];
    const stored = anchor(message("same-id", "Originally recorded"), 12);
    const events = [
        event("by-id", [stored]),
        { ...event("retracted", [anchor(sourceMessages[1], 20)]), status: "retracted" as const },
        event("wrong-role", [anchor(sourceMessages[2], 2)]),
        event("wrong-text", [anchor(sourceMessages[3], 3)]),
        event("borrowed-ok", [anchor(sourceMessages[4], 4)]),
        event("moved-id", [anchor(sourceMessages[5], 5)]),
        event("partial", [stored, anchor(sourceMessages[3], 3)]),
        event("unanchored", [{ messageId: "same-id", hash: null, index: null }]),
    ];
    const before = structuredClone({ events, sourceMessages, messages });
    const result = inheritedRecords({ pages: [], threads: [], events, sourceMessages, messages, hashOf });
    expect(result.events).toEqual(
        [
            events[0],
            { ...events[1], sources: [{ messageId: "copy-new-id", index: 20, hash: '["char","Unchanged"]' }] },
            events[5],
        ].map(({ createdRevision, ...record }) => record),
    );
    expect({ events, sourceMessages, messages }).toEqual(before);
});

it("leaves rerecord requests in the source chat while copies and branches preserve the rest of each crossing event", () => {
    const sourceMessages = [message("early", "Edited wording"), message("late", "After the branch point")];
    const { createdRevision, ...record } = event("marked", [anchor(message("early", "Recorded wording"), 12)]);
    const preserved = {
        ...record,
        pinned: true,
        suppressed: true,
        userCorrected: true,
        keptState: JSON.stringify([["early", '["char","Kept wording"]', 0]]),
        status: "stale" as const,
        staleReason: "changed" as const,
    };
    const sourceEvent: MemoryEvent = { ...preserved, createdRevision, rerecord: true };
    const before = structuredClone(sourceEvent);

    for (const messages of [sourceMessages, [message("branch-early", "Edited wording")]]) {
        const result = inheritedRecords({
            pages: [],
            threads: [],
            events: [sourceEvent],
            sourceMessages,
            messages,
            hashOf,
        });
        expect(result.events).toStrictEqual([
            {
                ...preserved,
                sources: [{ messageId: messages[0].chatId!, index: 12, hash: '["char","Recorded wording"]' }],
            },
        ]);
        expect(sourceEvent).toStrictEqual(before);
    }
});

it("keeps recorded gaps so an inserted event still reconciles stale after ids change", () => {
    const sourceMessages = [message("a", "Before"), message("inserted", "New turn"), message("b", "After")];
    const e = event("spanning", [anchor(sourceMessages[0], 0), anchor(sourceMessages[2], 1)]);
    const messages = sourceMessages.map((m) => ({ ...m, chatId: `copy-${m.chatId}` }));
    let p = change(page("p"), "facts", "Old wording", e, 1);
    p = change(p, "facts", "New wording", e, 2);
    const result = inheritedRecords({ pages: [p], threads: [], events: [e], sourceMessages, messages, hashOf });
    expect(reconcileMemoryEvents([e], sourceMessages, hashOf)[0]).toMatchObject({
        status: "stale",
        staleReason: "inserted",
    });
    expect(reconcileMemoryEvents(result.events!, messages, hashOf)[0]).toMatchObject({
        status: "stale",
        staleReason: "inserted",
    });
    const expectedSources = [
        { messageId: "copy-a", hash: '["char","Before"]', index: 0 },
        { messageId: "copy-b", hash: '["char","After"]', index: 1 },
    ];
    expect(result.events![0].sources).toEqual(expectedSources);
    expect(result.pages![0].sections[0].sources).toEqual(expectedSources);
    expect(result.pages![0].history[1].before?.sources).toEqual(expectedSources);
});

it("does not rewind a full copy when an event has already lost its message", () => {
    const messages = [message("present", "Still here")];
    const kept = event("kept", [anchor(messages[0], 0)]);
    const dead = event("dead", [anchor(message("deleted", "Already gone"), 1)]);
    let p = addPage(new Map(), newScenePage("scene"), stamp(dead, 1));
    p = { ...change(p, "state", "Current scene", dead, 2), participants: ["alice"] };
    p = change(p, "place", "Current place", kept, 3);
    const thread: MemoryThread = {
        id: "t",
        title: "Finished",
        who: [],
        state: "done",
        openedBy: dead.id,
        closedBy: dead.id,
    };
    const result = inheritedRecords({
        pages: [p],
        events: [kept, dead],
        threads: [thread],
        sourceMessages: messages,
        messages,
        hashOf,
    });
    expect(result.pages).toEqual([
        {
            ...p,
            sections: [{ ...p.sections[0], provenance: [], sources: [], unsupported: true }, p.sections[1]],
        },
    ]);
    expect(result.threads).toEqual([thread]);
    expect(result.events?.map(({ id }) => id)).toEqual(["kept"]);
});

it("rewinds branch bodies from page history, removes later creations, and clears scene attendance", () => {
    const sourceMessages = [message("early", "At the gate"), message("late", "Inside the palace")];
    const early = event("early", [anchor(sourceMessages[0], 0)]);
    const late = event("late", [anchor(sourceMessages[1], 1)]);
    let p = change(page("place"), "state", "Gate closed", early, 1);
    p = change(p, "old", "Old sign", early, 2);
    p = change(p, "state", "Gate open", late, 3);
    // A different heading must keep its own history even after the state heading's cut.
    p = change(p, "unrelated", "Stone walls", early, 4);
    p = change(p, "new", "Palace secret", late, 5);
    p = change(p, "old", null, late, 6);
    p = applyPageEdit(
        p,
        { kind: "section", pageId: p.id, heading: "state", body: "Polished palace secret" },
        { now: 7, newId: () => "user-edit" },
    )!;
    p.sections[0] = { ...p.sections[0], locked: true, disputed: true, unsupported: true };
    p.links = ["palace", "scene"];
    const palace = change(addPage(new Map(), page("palace"), stamp(late, 8)), "facts", "Secret room", late, 9);
    const scene = {
        ...change(newScenePage("scene"), "state", "At the gate", early, 10),
        participants: ["palace"],
    };
    const pages = [p, palace, scene];
    const before = structuredClone(pages);
    const result = inheritedRecords({
        pages,
        events: [early, late],
        threads: [{ id: "t", title: "Visit", who: ["place", "palace"], state: "open" }],
        sourceMessages,
        messages: sourceMessages.slice(0, 1),
        hashOf,
    });
    expect(result.pages?.map(({ id }) => id)).toEqual(["place", "scene"]);
    expect(result.pages![0].sections).toEqual([
        {
            heading: "state",
            body: "Gate closed",
            provenance: ["early"],
            sources: early.sources,
            locked: true,
            userCorrected: true,
            updatedAt: 3,
        },
        {
            heading: "unrelated",
            body: "Stone walls",
            provenance: ["early"],
            sources: early.sources,
            locked: false,
            updatedAt: 4,
        },
        {
            heading: "old",
            body: "Old sign",
            provenance: ["early"],
            sources: early.sources,
            locked: false,
            updatedAt: 6,
        },
    ]);
    expect(result.pages![0].history.map(({ id }) => id)).toEqual(["history-1", "history-2", "history-4"]);
    expect(result.pages![0].links).toEqual(["scene"]);
    expect(result.pages![1]).toEqual({ ...scene, participants: [] });
    expect(result.threads![0].who).toEqual(["place"]);
    expect(result.events?.map(({ id }) => id)).toEqual(["early"]);
    expect(pages).toEqual(before);
});

it("keeps unsupported bodies when history is lost or no standing evidence crosses", () => {
    const sourceMessages = [message("early", "Before"), message("late", "After")];
    const early = event("early", [anchor(sourceMessages[0], 0)]);
    const late = event("late", [anchor(sourceMessages[1], 1)]);
    const retracted = { ...event("retracted", early.sources), status: "retracted" as const };
    let p = change(page("p"), "mixed", "Earlier account", early, 1);
    p = change(p, "mixed", "Later account", late, 2);
    p = change(p, "retracted", "Retracted account", retracted, 3);
    p = change(p, "only-late", "Only later evidence", late, 4);
    p.history = []; // A bounded history can no longer hold the changes needed for a rewind.
    const result = inheritedRecords({
        pages: [p],
        events: [early, late, retracted],
        threads: [],
        sourceMessages,
        messages: sourceMessages.slice(0, 1),
        hashOf,
    });
    expect(result.pages![0].sections).toEqual([
        { ...p.sections[0], provenance: ["early"], sources: early.sources, unsupported: true },
        { ...p.sections[1], unsupported: true },
        { ...p.sections[2], provenance: [], sources: [], unsupported: true },
    ]);
    expect(result.events?.map(({ id, status }) => [id, status])).toEqual([
        ["early", "active"],
        ["retracted", "retracted"],
    ]);
});

it("drops later threads and restores moved threads from crossing events in recording order", () => {
    const sourceMessages = [message("early", "Before"), message("late", "After")];
    const first = event("first", [anchor(sourceMessages[0], 0)]);
    const second = event("second", first.sources);
    const late = event("late", [anchor(sourceMessages[1], 1)]);
    first.openThreads.close = ["reopened", "ended"];
    second.openThreads.transitions = [
        { threadId: "reopened", to: "paused" },
        { threadId: "ended", to: "cancelled" },
    ];
    late.openThreads.transitions = [
        { threadId: "reopened", to: "done" },
        { threadId: "ended", to: "open" },
    ];
    const threads: MemoryThread[] = [
        { id: "new", title: "Later question", who: [], state: "open", openedBy: "late" },
        { id: "reopened", title: "Pause", who: [], state: "done", openedBy: "first", closedBy: "late" },
        { id: "ended", title: "Cancel", who: [], state: "open", openedBy: "first" },
        { id: "closed-only", title: "Open again", who: [], state: "done", closedBy: "late" },
        { id: "untouched", title: "User decision", who: [], state: "paused" },
    ];
    const result = inheritedRecords({
        pages: [],
        events: [first, second, late],
        threads,
        sourceMessages,
        messages: sourceMessages.slice(0, 1),
        hashOf,
    });
    expect(result.threads).toEqual([
        { id: "reopened", title: "Pause", who: [], state: "paused", openedBy: "first" },
        { id: "ended", title: "Cancel", who: [], state: "cancelled", openedBy: "first", closedBy: "second" },
        { id: "closed-only", title: "Open again", who: [], state: "open" },
        threads[4],
    ]);
});
