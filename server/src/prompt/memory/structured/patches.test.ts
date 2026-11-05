// @vitest-environment node
import { expect, it } from "vitest";
import {
    CHARACTER_SECTION_SLOTS,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type MemoryPage,
    type MemoryPatch,
    type MemorySection,
} from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { type PageChanges, type PageStamp } from "./pages.ts";
import { applyPatches, commitPages, parsePatches, showTargets } from "./patches.ts";

const section = (heading: string, body = `Old ${heading}`): MemorySection => ({
    heading,
    body,
    provenance: ["old-event"],
    sources: [{ messageId: "old-message", hash: "old-hash", index: 0 }],
    locked: false,
    updatedAt: 1,
});
const page = (id = "bad"): MemoryPage => ({
    ...memoryRecords([id], id).pages[0],
    sections: [section("Gate"), section("Hearth")],
});
const patch = (heading: string, fields: Partial<MemoryPatch> = {}): MemoryPatch => ({
    pageId: "bad",
    heading,
    op: "upsert",
    body: "New text",
    ...fields,
});
const stamp = (): PageStamp => {
    let id = 0;
    return {
        eventId: "event",
        sources: [{ messageId: "message", hash: "hash", index: 100 }],
        at: 123,
        newId: () => `history-${++id}`,
    };
};
const shown = (pages: MemoryPage[]) =>
    new Map(
        pages.map((page) => [
            page.id,
            new Map(page.sections.map(({ heading, body }) => [heading, body as string | null])),
        ]),
    );

it.each([
    ["locked section", "lockedSection"],
    ["unshown section", "unseenSection"],
    ["deleted section", "unseenSection"],
    ["added section", "unseenSection"],
    ["duplicate heading", "duplicateHeading"],
    ["non-slot heading", "notASlot"],
    ["too many sections", "tooManySections"],
    ["blank body", "emptyBody"],
    ["empty page", "emptiesPage"],
] as const)("refuses every patch for %s while applying other pages", (fault, reason) => {
    const bad = page();
    const good = page("good");
    const seen = shown([bad, good]);
    let patches = [patch("Gate"), patch("Hearth")];
    if (fault === "locked section") bad.sections[1].locked = true;
    if (fault === "unshown section") seen.get("bad")!.set("Hearth", null);
    if (fault === "deleted section") bad.sections.pop();
    if (fault === "added section") seen.get("bad")!.delete("Hearth");
    if (fault === "duplicate heading") patches[1] = patch("Gate");
    if (fault === "non-slot heading") {
        bad.type = "character";
        patches[1] = patch("Invented slot");
    }
    if (fault === "too many sections") {
        bad.sections.push(...Array.from({ length: LIMITS.sectionsPerPage - 2 }, (_, i) => section(`Extra ${i}`)));
        patches[1] = patch("Overflow");
    }
    if (fault === "blank body") patches[1].body = " \n\t";
    if (fault === "empty page") patches = [patch("Gate", { op: "delete" }), patch("Hearth", { op: "delete" })];
    patches.push(patch("Gate", { pageId: "good", body: "Allowed" }));
    const before = structuredClone(bad);
    const changes: PageChanges = new Map();
    const warnings = applyPatches({
        pages: new Map([
            [bad.id, bad],
            [good.id, good],
        ]),
        changes,
        patches,
        seen,
        stamp: stamp(),
    });
    expect(changes.has("bad")).toBe(false);
    expect(bad).toEqual(before);
    expect(changes.get("good")!.page.sections).toEqual([
        expect.objectContaining({ heading: "Gate", body: "Allowed" }),
        good.sections[1],
    ]);
    expect(warnings).toEqual([
        expect.objectContaining({
            kind: fault === "empty page" ? "emptiesPage" : "pageRefused",
            pageId: "bad",
            heading: patches[0].heading,
        }),
        expect.objectContaining({ kind: reason, pageId: "bad", heading: patches[1].heading }),
    ]);
});

it("reads raw line breaks in bodies, a comma before a closing bracket, and JSON inside thoughts", () => {
    // As a model writes a list body: the break between items is a raw one, not `\n`.
    const listBody = '"- Mira: her sister.\n- Oren:\tan old friend."';
    const keptBody = String.raw`"keeps \"quotes\", \\n, and ,] as written"`;
    const answer = [
        '<think>A draft: {"patches": [</think>',
        `{"patches": [{"pageId": "p", "heading": "relationships", "op": "upsert", "body": ${listBody}},`,
        `{"pageId": "p", "heading": "knowledge", "op": "upsert", "body": ${keptBody},},]}`,
    ].join("\n");
    expect(parsePatches(answer)).toEqual({
        ok: true,
        warnings: [],
        patches: [
            {
                pageId: "p",
                heading: "relationships",
                op: "upsert",
                body: "- Mira: her sister.\n- Oren:\tan old friend.",
            },
            { pageId: "p", heading: "knowledge", op: "upsert", body: 'keeps "quotes", \\n, and ,] as written' },
        ],
    });
});

it("tells an answer that is not JSON from one with no patches list", () => {
    expect(parsePatches('{"patches": [{"body": "She said "no" twice"}]}')).toEqual({
        ok: false,
        error: expect.stringMatching(/^The model's answer is not valid JSON: \S/),
    });
    expect(parsePatches('{"edits": []}')).toEqual({
        ok: false,
        error: 'The model\'s answer has no valid "patches" list',
    });
});

it("shows whole sections within the patch budget and marks omitted headings", () => {
    const full = page("full");
    full.sections = Array.from({ length: LIMITS.promptPatchChars / LIMITS.sectionBodyChars }, (_, i) =>
        section(`Full ${i}`, "x".repeat(LIMITS.sectionBodyChars)),
    );
    full.sections.push(section("Omitted", "must not be truncated"));
    const excluded = page("excluded");
    const targets = [full, excluded].map((page) => ({
        page,
        candidate: { targetId: page.id, confidence: 1, reason: "Update" },
    }));
    const result = showTargets(targets);
    expect(result.rows).toEqual([
        {
            id: "full",
            title: "full",
            type: "location",
            sections: full.sections.slice(0, -1).map(({ heading, body }) => ({ heading, body })),
            notShown: ["Omitted"],
        },
    ]);
    expect(result.seen.get("full")!.get("Omitted")).toBeNull();
    expect(result.seen.has("excluded")).toBe(false);
    expect(result.refused).toEqual([{ candidate: targets[1].candidate, refusal: "overBudget" }]);
});

it("refuses a fully locked character without spending the next page's patch budget", () => {
    const locked = page("locked");
    locked.type = "character";
    locked.sections = CHARACTER_SECTION_SLOTS.map((heading) => ({
        ...section(heading, "x".repeat(LIMITS.sectionBodyChars)),
        locked: true,
    }));
    const editable = page("editable");
    editable.sections = [section("Gate", "The gate is open.")];
    const targets = [locked, editable].map((page) => ({
        page,
        candidate: { targetId: page.id, confidence: 1, reason: "Update" },
    }));

    const result = showTargets(targets);

    expect(result.refused).toEqual([{ candidate: targets[0].candidate, refusal: "allLocked" }]);
    expect(result.rows).toEqual([
        {
            id: "editable",
            title: "editable",
            type: "location",
            sections: [{ heading: "Gate", body: "The gate is open." }],
            notShown: [],
        },
    ]);
    expect(result.seen).toEqual(new Map([["editable", new Map([["Gate", "The gate is open."]])]]));
});

it("shows editable bodies before compact locked context and still refuses locked patches", () => {
    const locked = page("locked");
    locked.type = "character";
    locked.sections = CHARACTER_SECTION_SLOTS.slice(0, -1).map((heading) => ({
        ...section(heading, "x".repeat(LIMITS.sectionBodyChars)),
        locked: true,
    }));
    const editable = page("editable");
    // Leave room for only one locked excerpt, so excerpts charged first would hide an editable body.
    editable.sections = [
        section("First", "a".repeat(LIMITS.sectionBodyChars)),
        section("Second", "b".repeat(LIMITS.sectionBodyChars)),
        section(
            "Third",
            "c".repeat(LIMITS.promptPatchChars - 2 * LIMITS.sectionBodyChars - LIMITS.promptSectionSummaryChars),
        ),
    ];
    const targets = [locked, editable].map((page) => ({
        page,
        candidate: { targetId: page.id, confidence: 1, reason: "Update" },
    }));

    const result = showTargets(targets);

    expect(result.refused).toEqual([]);
    expect(result.rows).toEqual([
        {
            id: "locked",
            title: "locked",
            type: "character",
            sections: [
                ...locked.sections.map(({ heading }) => expect.objectContaining({ heading, locked: true })),
                { heading: CHARACTER_SECTION_SLOTS.at(-1), empty: true },
            ],
            notShown: [],
        },
        {
            id: "editable",
            title: "editable",
            type: "location",
            sections: editable.sections.map(({ heading, body }) => ({ heading, body })),
            notShown: [],
        },
    ]);
    for (const row of result.rows[0].sections.slice(0, -1)) {
        expect(row).not.toHaveProperty("body");
        const excerpt = "excerpt" in row ? row.excerpt : undefined;
        expect(excerpt?.length ?? 0).toBeLessThanOrEqual(LIMITS.promptSectionSummaryChars);
    }
    expect(result.seen).toEqual(
        new Map<string, Map<string, string | null>>([
            [locked.id, new Map(locked.sections.map(({ heading }) => [heading, null]))],
            [editable.id, new Map(editable.sections.map(({ heading, body }) => [heading, body]))],
        ]),
    );

    const before = structuredClone(locked);
    const changes: PageChanges = new Map();
    const warnings = applyPatches({
        pages: new Map([locked, editable].map((page) => [page.id, page])),
        changes,
        patches: [
            patch(CHARACTER_SECTION_SLOTS[0], { pageId: locked.id, body: "Overwrite lock" }),
            patch("First", { pageId: editable.id, body: "Updated editable text" }),
        ],
        seen: result.seen,
        stamp: stamp(),
    });
    expect(warnings).toEqual([
        expect.objectContaining({ kind: "lockedSection", pageId: locked.id, heading: CHARACTER_SECTION_SLOTS[0] }),
    ]);
    expect(changes.has(locked.id)).toBe(false);
    expect(locked).toEqual(before);
    expect(changes.get(editable.id)!.page.sections).toEqual([
        expect.objectContaining({ heading: "First", body: "Updated editable text" }),
        ...editable.sections.slice(1),
    ]);
});

it("preserves conflict history, disputes weak contradictions, and refuses overflowing joins", () => {
    const cases = [
        {
            name: "change",
            fields: { was: "Old Gate" },
            body: "New Gate\n(was: Old Gate)",
            kind: "change",
            disputed: false,
        },
        {
            name: "existing was line",
            fields: { was: "Old Gate", body: "New Gate\n(was: Old Gate)" },
            body: "New Gate\n(was: Old Gate)",
            kind: "change",
            disputed: false,
        },
        {
            name: "nested was",
            fields: { was: "Old Gate\n(was: Older Gate\n(was: Oldest Gate))" },
            body: "New Gate\n(was: Old Gate)",
            kind: "change",
            disputed: false,
        },
        {
            name: "was of only a was line",
            fields: { was: " (was: Old Gate)" },
            body: "New Gate",
            kind: "change",
            disputed: false,
        },
        {
            name: "strong contradiction",
            fields: { conflict: "contradiction", confidence: LIMITS.contradictionConfidence },
            body: "New Gate",
            kind: "contradiction",
            disputed: false,
        },
        {
            name: "weak contradiction",
            fields: { conflict: "contradiction", confidence: LIMITS.contradictionConfidence - 0.01 },
            body: "Old Gate\n[disputed] New Gate",
            kind: "contradiction",
            disputed: true,
        },
        {
            name: "unscored contradiction",
            fields: { conflict: "contradiction" },
            body: "Old Gate\n[disputed] New Gate",
            kind: "contradiction",
            disputed: true,
        },
    ] as const;
    for (const row of cases) {
        const before = page();
        const changes: PageChanges = new Map();
        const warnings = applyPatches({
            pages: new Map([[before.id, before]]),
            changes,
            patches: [patch("Gate", { body: "New Gate", ...row.fields })],
            seen: shown([before]),
            stamp: stamp(),
        });
        const after = changes.get("bad")!.page;
        expect(after.sections[0].body, row.name).toBe(row.body);
        expect(after.sections[0].disputed ?? false, row.name).toBe(row.disputed);
        expect(after.history, row.name).toEqual([
            expect.objectContaining({
                heading: "Gate",
                kind: row.kind,
                eventId: "event",
                before: { body: "Old Gate", provenance: ["old-event"], sources: before.sections[0].sources },
            }),
        ]);
        expect(warnings, row.name).toEqual(
            row.disputed ? [expect.objectContaining({ kind: "disputed", pageId: "bad", heading: "Gate" })] : [],
        );
    }
    for (const fields of [{ was: "old" }, { conflict: "contradiction" as const }]) {
        const before = page();
        const changes: PageChanges = new Map();
        const warnings = applyPatches({
            pages: new Map([[before.id, before]]),
            changes,
            patches: [patch("Gate", { body: "x".repeat(LIMITS.sectionBodyChars), ...fields })],
            seen: shown([before]),
            stamp: stamp(),
        });
        expect(changes.size).toBe(0);
        expect(warnings).toEqual([expect.objectContaining({ kind: "sectionTooLong" })]);
    }
});

it("bounds section evidence and replacement history while preserving untouched bytes", () => {
    const before = page();
    before.sections.push(section("Untouched", " \r\n  exact 한글 😀\t "));
    before.sections[0].provenance = Array.from({ length: LIMITS.sectionEvidence }, (_, i) => `event-${i}`);
    before.sections[0].sources = Array.from({ length: LIMITS.sectionEvidence }, (_, i) => ({
        messageId: `m-${i}`,
        hash: `hash-${i}`,
        index: i,
    }));
    before.history = Array.from({ length: LIMITS.pageHistoryEntries }, (_, i) => ({
        id: `old-${i}`,
        heading: "Gate",
        before: null,
        kind: "create",
        highlighted: false,
        eventId: `event-${i}`,
        at: i,
    }));
    const changes: PageChanges = new Map();
    expect(
        applyPatches({
            pages: new Map([[before.id, before]]),
            changes,
            patches: [patch("Gate"), patch("Hearth", { op: "delete" })],
            seen: shown([before]),
            stamp: stamp(),
        }),
    ).toEqual([]);
    const after = changes.get("bad")!.page;
    expect(after.sections).toEqual([
        expect.objectContaining({
            heading: "Gate",
            body: "New text",
            provenance: [...before.sections[0].provenance.slice(1), "event"],
            sources: [...before.sections[0].sources.slice(1), { messageId: "message", hash: "hash", index: 100 }],
        }),
        before.sections[2],
    ]);
    expect(after.history).toEqual([
        ...before.history.slice(2),
        ...["Gate", "Hearth"].map((heading, i) => ({
            id: `history-${i + 1}`,
            heading,
            before: {
                body: before.sections[i].body,
                provenance: before.sections[i].provenance,
                sources: before.sections[i].sources,
            },
            kind: i === 0 ? "change" : "delete",
            highlighted: false,
            eventId: "event",
            at: 123,
        })),
    ]);
});

it("highlights committed kinds under the selected mode and the higher event or page grade", () => {
    const cases = [
        {
            mode: "none",
            kinds: ["create", "contradiction", "delete", "change"],
            eventGrade: 6,
            pageGrade: 6,
            expected: [],
        },
        {
            mode: "all",
            kinds: [],
            eventGrade: 0,
            pageGrade: 0,
            expected: ["create", "contradiction", "delete", "change"],
        },
        {
            mode: "important",
            kinds: ["create", "contradiction", "delete", "change"],
            eventGrade: 3,
            pageGrade: 3,
            expected: ["create", "contradiction", "delete"],
        },
        { mode: "important", kinds: ["change"], eventGrade: 4, pageGrade: 0, expected: ["change"] },
        { mode: "important", kinds: ["change"], eventGrade: 0, pageGrade: 4, expected: ["change"] },
        { mode: "important", kinds: ["create"], eventGrade: 6, pageGrade: 6, expected: ["create"] },
    ] as const;
    for (const row of cases) {
        const before = page();
        before.grade = row.pageGrade;
        before.sections = [section("change"), section("contradiction"), section("delete"), section("identical")];
        const result = commitPages({
            pages: [before],
            plan: { targets: [], created: [], refused: [], names: new Map() },
            admission: { event: memoryRecords(["event"]).events[0], repeated: false, scene: null },
            patches: [
                patch("create"),
                patch("change"),
                patch("contradiction", { conflict: "contradiction", confidence: 1 }),
                patch("delete", { op: "delete" }),
                patch("identical", { body: "Old identical" }),
            ],
            seen: shown([before]),
            compactions: [],
            sceneId: "scene",
            stamp: {
                ...stamp(),
                grade: row.eventGrade,
                highlight: { mode: row.mode, kinds: row.kinds, changeGrade: 4 },
            },
        });
        const saved = result.pages.find(({ id }) => id === "bad")!;
        expect(
            saved.history
                .filter(({ highlighted }) => highlighted)
                .map(({ kind }) => kind)
                .sort(),
            JSON.stringify(row),
        ).toEqual([...row.expected].sort());
        expect(
            result.receipts
                .find(({ pageId }) => pageId === "bad")!
                .sections.filter(({ highlighted }) => highlighted)
                .map(({ highlighted }) => highlighted)
                .sort(),
        ).toEqual([...row.expected].sort());
        expect(saved.history.find(({ heading }) => heading === "identical")!.highlighted).toBe(false);
    }
});

it("replaces corrections with a forced highlight and a marked snapshot but keeps identical and disputed corrections", () => {
    for (const mode of ["none", "important", "all"] as const) {
        const before = page();
        before.sections = ["replace", "identical", "disputed", "locked"].map((heading) => ({
            ...section(heading),
            userCorrected: true,
            pinned: true,
            suppressed: true,
            unsupported: true,
            locked: heading === "locked",
        }));
        const commit = (patches: MemoryPatch[]) =>
            commitPages({
                pages: [before],
                plan: { targets: [], created: [], refused: [], names: new Map() },
                admission: { event: memoryRecords(["event"]).events[0], repeated: false, scene: null },
                patches,
                seen: shown([before]),
                compactions: [],
                sceneId: "scene",
                stamp: { ...stamp(), highlight: { mode, kinds: [], changeGrade: 6 } },
            });
        const result = commit([
            patch("replace"),
            patch("identical", { body: "Old identical" }),
            patch("disputed", { conflict: "contradiction", confidence: 0 }),
        ]);
        const saved = result.pages.find(({ id }) => id === "bad")!;
        expect(saved.sections.find(({ heading }) => heading === "replace")).toMatchObject({ body: "New text" });
        expect(saved.sections.find(({ heading }) => heading === "replace")!.userCorrected).toBeUndefined();
        expect(saved.sections.find(({ heading }) => heading === "identical")).toMatchObject({
            body: "Old identical",
            userCorrected: true,
        });
        expect(saved.sections.find(({ heading }) => heading === "disputed")).toMatchObject({
            body: "Old disputed\n[disputed] New text",
            userCorrected: true,
            disputed: true,
        });
        expect(saved.history.find(({ heading }) => heading === "replace")).toMatchObject({
            highlighted: true,
            before: {
                body: "Old replace",
                provenance: ["old-event"],
                sources: before.sections[0].sources,
                userCorrected: true,
                pinned: true,
                suppressed: true,
                unsupported: true,
            },
        });
        expect(saved.history.find(({ heading }) => heading === "identical")!.highlighted).toBe(false);
        expect(result.receipts.find(({ pageId }) => pageId === "bad")!.sections[0].highlighted).toBe("change");
        const locked = commit([patch("locked")]);
        expect(locked.warnings).toContainEqual(expect.objectContaining({ kind: "lockedSection" }));
        expect(locked.pages.some(({ id }) => id === "bad")).toBe(false);
    }
});

it("refuses an oversized patch alone while applying the page's other patch", () => {
    const before = page();
    const parsed = parsePatches(
        JSON.stringify({
            patches: [
                patch("Gate", { body: "x".repeat(LIMITS.sectionBodyChars + 1) }),
                patch("Hearth", { body: "Lit" }),
            ],
        }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const changes: PageChanges = new Map();
    const warnings = applyPatches({
        pages: new Map([[before.id, before]]),
        changes,
        patches: parsed.patches,
        seen: shown([before]),
        stamp: stamp(),
    });
    expect(warnings).toEqual([expect.objectContaining({ kind: "sectionTooLong", heading: "Gate" })]);
    expect(changes.get(before.id)?.page.sections).toEqual([
        before.sections[0],
        expect.objectContaining({ heading: "Hearth", body: "Lit" }),
    ]);
});

it("refuses remaining edits that would empty the page after an oversized creation is dropped", () => {
    const before = page();
    const changes: PageChanges = new Map();
    const warnings = applyPatches({
        pages: new Map([[before.id, before]]),
        changes,
        patches: [
            patch("New", { body: "x".repeat(LIMITS.sectionBodyChars + 1) }),
            patch("Gate", { op: "delete" }),
            patch("Hearth", { op: "delete" }),
        ],
        seen: shown([before]),
        stamp: stamp(),
    });
    expect(changes.size).toBe(0);
    expect(warnings.map(({ kind, heading }) => ({ kind, heading }))).toEqual([
        { kind: "sectionTooLong", heading: "New" },
        { kind: "emptiesPage", heading: "Gate" },
        { kind: "emptiesPage", heading: "Hearth" },
    ]);
});
