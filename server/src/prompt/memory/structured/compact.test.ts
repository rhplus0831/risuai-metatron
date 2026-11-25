// @vitest-environment node
import { expect, it } from "vitest";
import {
    MEMORY_SECTION_BUDGETS,
    STRUCTURED_MEMORY_LIMITS as LIMITS,
    type MemoryPage,
    type MemoryReceipt,
} from "../../../../../shared/structuredMemory.ts";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { compactionTargets, readCompaction, type CompactionTarget } from "./compact.ts";
import { commitPages } from "./patches.ts";
import { type PageStamp } from "./pages.ts";

it("targets a changed section only when it exceeds its own page type's budget", () => {
    for (const type of ["character", "location", "faction", "item", "concept", "note"] as const) {
        const page: MemoryPage = { ...memoryRecords([type], type).pages[0], type };
        const budget = MEMORY_SECTION_BUDGETS[type];
        page.sections = [budget - 1, budget, budget + 1].map((length, i) => ({
            ...page.sections[0],
            heading: `Section ${i}`,
            body: "x".repeat(length),
        }));
        const receipts: MemoryReceipt["pages"] = [
            {
                pageId: page.id,
                created: false,
                sections: page.sections.map(({ heading }) => ({ heading, beforeHash: "old", afterHash: "new" })),
            },
        ];
        expect(compactionTargets([page], receipts), type).toEqual({
            targets: [
                {
                    page: { id: type, title: type, type },
                    heading: "Section 2",
                    body: "x".repeat(budget + 1),
                },
            ],
            warnings: [],
        });
    }
});

it("keeps only a strictly shorter usable answer without trimming or cutting its body", () => {
    const target: CompactionTarget = {
        page: { id: "harbor", title: "Harbor", type: "location" },
        heading: "Gate",
        body: "x".repeat(MEMORY_SECTION_BUDGETS.location + 100),
    };
    for (const text of ["not JSON", "{}", '{"body":42}', '{"body":" \\n\\t"}']) {
        expect(readCompaction(target, text), text).toEqual({
            ok: false,
            warning: { kind: "compactionFailed", pageId: "harbor", heading: "Gate", detail: "Harbor: Gate" },
        });
    }
    for (const body of [target.body, "y".repeat(target.body.length + 1), "z".repeat(LIMITS.sectionBodyChars + 1)]) {
        expect(readCompaction(target, JSON.stringify({ body })), `length ${body.length}`).toEqual({
            ok: false,
            warning: { kind: "compactionNotSmaller", pageId: "harbor", heading: "Gate", detail: "Harbor: Gate" },
        });
    }
    const body = ` \r\n${"한".repeat(MEMORY_SECTION_BUDGETS.location)}😀\t `;
    expect(readCompaction(target, JSON.stringify({ body }))).toEqual({
        ok: true,
        compaction: { pageId: "harbor", heading: "Gate", from: target.body, body },
    });
});

it("drops a compaction when the fresh attempt no longer changes or permits its section", () => {
    const original = memoryRecords(["harbor"], "Harbor").pages[0];
    const from = "x".repeat(MEMORY_SECTION_BUDGETS.location + 1);
    for (const reason of ["changed body", "identical upsert", "locked", "refused sibling"] as const) {
        const fresh = structuredClone(original);
        fresh.sections.push({ ...fresh.sections[0], heading: "Hearth", body: "Warm" });
        const seen = new Map([[fresh.id, new Map(fresh.sections.map(({ heading, body }) => [heading, body]))]]);
        if (reason === "changed body") fresh.sections[0].body = "A person's replacement";
        if (reason === "identical upsert") {
            fresh.sections[0].body = from;
            seen.get(fresh.id)!.set("Gate", from);
        }
        if (reason === "locked") fresh.sections[0].locked = true;
        if (reason === "refused sibling") fresh.sections[1].locked = true;
        let id = 0;
        const stamp: PageStamp = { eventId: "event", sources: [], at: 123, newId: () => `history-${++id}` };
        const input: Parameters<typeof commitPages>[0] = {
            pages: [fresh],
            plan: { targets: [], created: [], refused: [], names: new Map() },
            admission: { event: memoryRecords(["event"]).events[0], repeated: false, scene: null },
            patches: [
                { pageId: fresh.id, heading: "Gate", op: "upsert", body: from },
                { pageId: fresh.id, heading: "Hearth", op: "upsert", body: "Lit" },
            ],
            seen,
            compactions: [],
            sceneId: "scene",
            stamp,
        };
        const withoutCompaction = commitPages(input);
        id = 0;
        const result = commitPages({
            ...input,
            compactions: [{ pageId: fresh.id, heading: "Gate", from, body: "Short" }],
        });
        expect(result.warnings, reason).toEqual([
            ...withoutCompaction.warnings,
            { kind: "compactionStale", pageId: "harbor", heading: "Gate", detail: "Harbor: Gate" },
        ]);
        expect(result.pages, reason).toEqual(withoutCompaction.pages);
        expect(result.receipts, reason).toEqual(withoutCompaction.receipts);
        expect(result.vectorTexts, reason).toEqual(withoutCompaction.vectorTexts);
    }
});

it("targets character knowledge over 1000 characters but leaves goals of the same length alone", () => {
    const page = memoryRecords(["Ada"], "Ada").pages[0];
    page.type = "character";
    page.sections = ["knowledge", "goals"].map((heading) => ({
        ...page.sections[0],
        heading,
        body: "x".repeat(1100),
    }));
    const result = compactionTargets(
        [page],
        [
            {
                pageId: page.id,
                created: false,
                sections: page.sections.map(({ heading }) => ({ heading, beforeHash: "old", afterHash: "new" })),
            },
        ],
    );
    expect(result.targets.map(({ heading }) => heading)).toEqual(["knowledge"]);
    expect(result.warnings).toEqual([]);
});
