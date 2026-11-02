// @vitest-environment node
import { expect, it } from "vitest";
import { memoryRecords } from "../../../tests/memoryFixtures.ts";
import { parseRestoredRecords } from "./restore.ts";

it("keeps genuine records beyond writer limits whole, removing only runs and source lifecycle fields", () => {
    const { pages, events, threads, runs } = memoryRecords(["saved"]);
    const section = pages[0].sections[0];
    pages[0].sections = Array.from({ length: 33 }, (_, index) => ({ ...section, heading: `Section ${index}` }));
    pages.push({ ...pages[0], id: "scene", type: "scene", sections: [{ ...section, body: "문".repeat(4000) }] });
    events[0].openThreads.close = Array.from({ length: 16 }, (_, index) => `closed-${index}`);
    events[0].sources = [{ messageId: "lost", hash: null, index: null }];
    events[0].keptState = "kept-state";
    const expected = structuredClone({ pages, events, threads });
    const body = {
        pages,
        events: [{ ...events[0], createdRevision: 87, rerecord: true }],
        threads,
        runs,
    };
    expect(parseRestoredRecords(body)).toEqual(expected);
});

it("refuses malformed nested records instead of accepting or repairing them", () => {
    const valid = memoryRecords(["saved"]);
    const corruptions = [
        {
            ...valid,
            pages: [
                {
                    ...valid.pages[0],
                    sections: [
                        { ...valid.pages[0].sections[0], sources: [{ messageId: "m", hash: "h", index: null }] },
                    ],
                },
            ],
        },
        {
            ...valid,
            pages: [
                {
                    ...valid.pages[0],
                    history: [
                        {
                            id: "h",
                            heading: null,
                            kind: "edit",
                            highlighted: false,
                            at: 1,
                            before: { body: "old", provenance: [], sources: [null] },
                        },
                    ],
                },
            ],
        },
        { ...valid, pages: [{ ...valid.pages[0], retrieval: { keywords: [7] } }] },
        {
            ...valid,
            events: [{ ...valid.events[0], knowledge: [{ pageId: "p", fact: "f", stance: "impossible", quote: "q" }] }],
        },
        {
            ...valid,
            events: [
                {
                    ...valid.events[0],
                    openThreads: { add: [], close: [], transitions: [{ threadId: "t", to: "impossible" }] },
                },
            ],
        },
        { ...valid, events: [{ ...valid.events[0], sources: [{ messageId: "m", hash: null, index: 0 }] }] },
        { ...valid, threads: [{ ...valid.threads[0], who: [null] }] },
        { ...valid, threads: [{ ...valid.threads[0], state: "impossible" }] },
    ];
    for (const body of [null, [], {}, { ...valid, events: null }, ...corruptions]) {
        expect(parseRestoredRecords(body), JSON.stringify(body)).toBeNull();
    }
});
