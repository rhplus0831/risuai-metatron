// @vitest-environment node
import { expect, it } from "vitest";
import {
    normalizeStructuredMemorySettings,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type MemoryEvent,
    type MemoryPage,
    type MemoryPageCandidate,
    type MemoryThread,
    type StructuredMemoryPageTool,
} from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { parseAnalysis } from "./analysis.ts";
import {
    aliasSeeds,
    applyPageTool,
    castSlice,
    MemoryPageToolRefusal,
    pageToolIds,
    parseMemoryPageTool,
    planPages,
    type PageToolRecords,
} from "./pages.ts";
import { analysisSlots } from "./prompts.ts";
import { prepareRetrieval } from "./retrieve.ts";

const page = (id: string, fields: Partial<MemoryPage> = {}): MemoryPage => ({
    ...memoryRecords([id], id).pages[0],
    ...fields,
});
const create = (title: string): MemoryPageCandidate => ({
    create: { type: "character", title, aliases: [] },
    reason: "Named in the window",
    confidence: LIMITS.createConfidence,
});

it("names the same pages in the writer cast and retrieval after removing spaces and comments", async () => {
    const pages = [
        page("mary", { title: "  MARY Ann  " }),
        page("bird", { title: "Captain", aliases: ["  Blue Bird  "] }),
        page("ghost", { title: "Ghost" }),
        page("phantom", { title: "Phantom" }),
    ];
    const messages = [{ data: "maryann waved at the BLUEBIRD. {{// Ghost }} {{comment: Phantom}}" }];
    const castIds = castSlice(pages, messages).map(({ id }) => id);
    const retrieval = await prepareRetrieval({
        pages,
        events: [],
        threads: [],
        entries: messages.map(({ data }) => ({ messageId: "m", text: data, role: "char" as const })),
        stage: [],
        window: { start: 0, dropped: new Set() },
        settings: normalizeStructuredMemorySettings({}),
    });
    expect(castIds).toEqual(["mary", "bird"]);
    expect([...retrieval.found]).toEqual([
        ["mary", "named"],
        ["bird", "named"],
    ]);
    expect([...retrieval.found.keys()]).toEqual(castIds);
});

it("lists only always pages, scene participants, and window names in the bounded analysis cast", () => {
    const scene = page("scene", { type: "scene", contextMode: "always", participants: ["present"] });
    const relevant = [
        page("named"),
        page("alias", { aliases: ["Captain"] }),
        page("present"),
        page("always", { contextMode: "always" }),
        scene,
    ];
    const messages = [{ role: "char" as const, chatId: "m", data: "NAMED greets the captain." }];
    const slot = (pages: MemoryPage[]) =>
        analysisSlots({
            language: "English",
            cast: castSlice(pages, messages),
            scene,
            threads: [],
            previousTitle: undefined,
            messages,
            window: { messages, sources: [{ messageId: "m", hash: "hash", index: 0 }] },
            speaker: () => "Cara",
        }).cast;
    const small = slot(relevant);
    const large = slot([...Array.from({ length: 40 }, (_, i) => page(`unrelated-${i}`)), ...relevant]);
    expect(large).toBe(small);
    expect(small.split("\n").map((line) => JSON.parse(line).id)).toEqual(["always", "present", "named", "alias"]);
    const crowded = Array.from({ length: LIMITS.promptPages + 1 }, (_, i) =>
        page(`always-${i}`, { contextMode: "always" }),
    );
    expect(castSlice([scene, ...crowded, ...relevant], messages).map(({ id }) => id)).toEqual(
        crowded.slice(0, LIMITS.promptPages).map(({ id }) => id),
    );
});

it("seeds aliases from lore names and member nicknames without treating lore keys as identities", () => {
    const seeds = aliasSeeds(
        [
            { comment: "Rivals", key: "Alice,Bob" },
            { comment: "Harbor", key: " Port, Quay " },
            { comment: "Regex", key: "A.*", useRegex: true },
            { comment: "Folder", key: "Hidden", mode: "folder" },
            { comment: "Malformed", key: { nested: true } },
            { comment: 17, key: ["wrong"] },
            null,
            ["legacy"],
        ],
        [
            { name: "Cara", nickname: "Captain" },
            { name: 42, nickname: {} },
        ],
    );
    const result = planPages({
        pages: [],
        candidates: ["Alice", "Bob", "Rivals", "Harbor", "Regex", "Folder", "Malformed", "Captain"].map(create),
        seeds,
        repeated: false,
        newPageId: (key) => key,
    });
    expect(result.created.map(({ title, aliases }) => ({ title, aliases }))).toEqual([
        { title: "Alice", aliases: [] },
        { title: "Bob", aliases: [] },
        { title: "Rivals", aliases: ["Alice", "Bob"] },
        { title: "Harbor", aliases: ["Port", "Quay"] },
        { title: "Regex", aliases: [] },
        { title: "Folder", aliases: [] },
        { title: "Malformed", aliases: [] },
        { title: "Captain", aliases: ["Cara"] },
    ]);
    const existing = page("cara", { type: "character", title: "Cara" });
    const matched = planPages({
        pages: [page("place-cara", { title: "Cara" }), existing],
        candidates: [create("Captain")],
        seeds,
        repeated: false,
        newPageId: () => "unexpected",
    });
    expect(matched.created).toEqual([]);
    expect(matched.targets.map(({ page }) => page)).toEqual([existing]);
    expect(existing.aliases).toEqual([]);
});

it("reads bounded page candidates and reports malformed and excess entries", () => {
    const aliases = Array.from({ length: LIMITS.aliasesPerPage + 1 }, (_, i) => `Alias ${i}`);
    const candidate = {
        ...create("x".repeat(LIMITS.labelChars + 1)),
        reason: "r".repeat(LIMITS.factChars + 1),
        create: { type: "character", title: "x".repeat(LIMITS.labelChars + 1), aliases },
    };
    const parsed = parseAnalysis(
        JSON.stringify({
            event: memoryRecords(["event"]).events[0],
            pageCandidates: [
                null,
                candidate,
                ...Array.from({ length: LIMITS.pageCandidates }, (_, i) => ({
                    targetId: `p${i}`,
                    confidence: 1,
                    reason: "Update",
                })),
            ],
        }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.analysis.pageCandidates).toHaveLength(LIMITS.pageCandidates);
    expect(parsed.analysis.pageCandidates[0]).toEqual({
        create: {
            type: "character",
            title: "x".repeat(LIMITS.labelChars),
            aliases: aliases.slice(0, LIMITS.aliasesPerPage),
        },
        reason: "r".repeat(LIMITS.factChars),
        confidence: LIMITS.createConfidence,
    });
    expect(parsed.analysis.pageCandidates.at(-1)).toMatchObject({ targetId: `p${LIMITS.pageCandidates - 2}` });
    expect(parsed.warnings).toEqual(
        expect.arrayContaining([
            { kind: "malformed", detail: "pageCandidates: 1" },
            { kind: "capped", detail: "pageCandidates: 1" },
            { kind: "capped", detail: "pageCandidates.aliases: 1" },
        ]),
    );
});

const toolRecords = (
    pages: MemoryPage[],
    events: MemoryEvent[] = [],
    threads: MemoryThread[] = [],
): PageToolRecords => ({
    page: (id) => pages.find((page) => page.id === id),
    pages: () => pages.filter(({ trashedAt }) => trashedAt === undefined),
    events: () => events,
    threads: () => threads,
});

it("parses every page tool shape and its page ids and refuses a split without headings", () => {
    const cases: { tool: StructuredMemoryPageTool; ids: string[] }[] = [
        { tool: { kind: "trash", pageId: "source" }, ids: ["source"] },
        { tool: { kind: "untrash", pageId: "source" }, ids: ["source"] },
        { tool: { kind: "purge", pageId: "source" }, ids: ["source"] },
        { tool: { kind: "merge", sourceId: "source", targetId: "target" }, ids: ["source", "target"] },
        {
            tool: { kind: "split", pageId: "source", headings: ["Gate"], title: "Harbor", aliases: ["Port"] },
            ids: ["source"],
        },
    ];
    for (const { tool, ids } of cases) {
        const parsed = parseMemoryPageTool(tool);
        expect(parsed).toEqual(tool);
        if (!parsed) throw new Error("A valid page tool was refused");
        expect(pageToolIds(parsed)).toEqual(ids);
    }
    expect(
        parseMemoryPageTool({ kind: "split", pageId: "source", headings: [], title: "Harbor", aliases: [] }),
    ).toBeNull();
});

it("trashes and restores a whole page without changing its references or content", () => {
    const original = page("source", { links: ["other"] });
    const related = { ...memoryRecords(["event"]).events[0], createdRevision: 1, participants: ["source"] };
    const stamp = { now: 200, newId: () => "unused" };
    const trashed = applyPageTool(toolRecords([original], [related]), { kind: "trash", pageId: "source" }, stamp);
    const binned = { ...original, trashedAt: 200 };
    expect(trashed).toEqual({ changes: { pages: [binned] }, shown: binned, flag: [] });
    const restored = applyPageTool(toolRecords([binned], [related]), { kind: "untrash", pageId: "source" }, stamp);
    expect(restored).toStrictEqual({ changes: { pages: [original] }, shown: original, flag: ["source"] });
    expect(original).not.toHaveProperty("trashedAt");
    expect(related.participants).toEqual(["source"]);
});

it("merges references onto the target and trashes the source with an eventless history blocker", () => {
    const source = page("source", { title: "Old Port" });
    const target = page("target", { title: "Harbor" });
    source.sections[0].body = "Old Port";
    target.sections[0].body = "Harbor";
    const linked = page("linked", { links: ["source", "target"] });
    const scene = page("scene", { type: "scene", contextMode: "always", participants: ["source", "target"] });
    const alreadyTrashed = page("binned", { trashedAt: 100, links: ["source"] });
    const event: MemoryEvent = {
        ...memoryRecords(["event"]).events[0],
        createdRevision: 1,
        participants: ["source", "target"],
        speakerId: "source",
        stateChanges: [{ pageId: "source", section: "Gate", before: "Shut", after: "Open", quote: "Opened" }],
        knowledge: [
            {
                pageId: "source",
                fact: "The gate is open",
                stance: "knows",
                quote: "Opened",
                knowers: ["source", "target"],
            },
        ],
        relationshipShifts: [{ from: "source", to: "target", direction: "closer", note: "Same harbor" }],
        openThreads: { add: [{ title: "Return", who: ["source", "target"] }], close: [], transitions: [] },
    };
    const thread: MemoryThread = { id: "thread", title: "Return", who: ["source", "target"], state: "open" };
    const result = applyPageTool(
        toolRecords([source, target, linked, scene, alreadyTrashed], [event], [thread]),
        { kind: "merge", sourceId: "source", targetId: "target" },
        { now: 200, newId: () => "merge-history" },
    );
    const merged = {
        ...target,
        aliases: ["Old Port"],
        sections: [{ ...target.sections[0], body: "Harbor\n\nOld Port", updatedAt: 200 }],
        history: [
            {
                id: "merge-history",
                heading: "Gate",
                before: { body: "Harbor", provenance: [], sources: [] },
                kind: "merge",
                highlighted: false,
                at: 200,
            },
        ],
        reshaped: true,
    };
    expect(result).toStrictEqual({
        changes: {
            pages: [
                merged,
                { ...source, trashedAt: 200 },
                { ...linked, links: ["target"] },
                { ...scene, participants: ["target"] },
            ],
            events: [
                {
                    ...event,
                    participants: ["target"],
                    speakerId: "target",
                    stateChanges: [
                        { pageId: "target", section: "Gate", before: "Shut", after: "Open", quote: "Opened" },
                    ],
                    knowledge: [
                        {
                            pageId: "target",
                            fact: "The gate is open",
                            stance: "knows",
                            quote: "Opened",
                            knowers: ["target"],
                        },
                    ],
                    relationshipShifts: [{ from: "target", to: "target", direction: "closer", note: "Same harbor" }],
                    openThreads: { add: [{ title: "Return", who: ["target"] }], close: [], transitions: [] },
                },
            ],
            threads: [{ ...thread, who: ["target"] }],
        },
        shown: merged,
        flag: ["target"],
    });
    expect(result.shown!.history[0]).not.toHaveProperty("eventId");
    expect(alreadyTrashed.links).toEqual(["source"]);
    expect(event.participants).toEqual(["source", "target"]);
});

it("splits selected sections and aliases into a reshaped page while leaving event references on the original", () => {
    const source = page("source", { aliases: ["Port", "Quay"], contextMode: "always", grade: 4, gradeByUser: true });
    const moved = { ...source.sections[0], heading: "Harbor", body: "At the waterfront", locked: true };
    source.sections.push(moved);
    const event = { ...memoryRecords(["event"]).events[0], createdRevision: 1, participants: ["source"] };
    const result = applyPageTool(
        toolRecords([source], [event]),
        { kind: "split", pageId: "source", headings: ["Harbor"], title: "Waterfront", aliases: ["Port"] },
        { now: 200, newId: () => "split-id" },
    );
    const created: MemoryPage = {
        id: "split-id",
        type: "location",
        title: "Waterfront",
        aliases: ["Port"],
        contextMode: "always",
        sections: [moved],
        links: [],
        retrieval: { keywords: [] },
        grade: 4,
        gradeByUser: true,
        history: [{ id: "split-id", heading: null, before: null, kind: "split", highlighted: false, at: 200 }],
        reshaped: true,
    };
    const remaining: MemoryPage = {
        ...source,
        aliases: ["Quay"],
        sections: [source.sections[0]],
        history: [
            {
                id: "split-id",
                heading: "Harbor",
                before: { body: "At the waterfront", provenance: [], sources: [] },
                kind: "split",
                highlighted: false,
                at: 200,
            },
        ],
        reshaped: true,
    };
    expect(result).toStrictEqual({ changes: { pages: [remaining, created] }, shown: created, flag: [] });
    for (const page of result.changes.pages!) {
        expect(page.history[0]).not.toHaveProperty("eventId");
    }
    expect(event.participants).toEqual(["source"]);
});

it("refuses to trash the scene page", () => {
    const scene = page("scene", { type: "scene", contextMode: "always" });
    expect(() =>
        applyPageTool(toolRecords([scene]), { kind: "trash", pageId: "scene" }, { now: 200, newId: () => "unused" }),
    ).toThrow(expect.objectContaining({ reason: "invalid", constructor: MemoryPageToolRefusal }));
    expect(scene).not.toHaveProperty("trashedAt");
});
