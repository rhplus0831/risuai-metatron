// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MAX_READ_RESPONSE_BYTES } from "../../../../../shared/resources.ts";
import { parseMemoryPackage } from "./importPackage.ts";

// Literal wire fixture, with substitutions only for the malformed-record cases below.
const pageText =
    '---\nid: "place"\ntype: "location"\ntitle: "Place"\naliases: []\ncontextMode: "auto"\nlinks: []\nretrieval: {"keywords":[]}\nsections: [{"heading":"Facts","provenance":[],"sources":[],"locked":false,"updatedAt":1,"bodyLines":1}]\n---\n\n## Facts\n\nAt the harbor\n\n';

it.each(["location", "scene"] as const)("imports a %s page with trashedAt metadata as a live page", (type) => {
    const contextMode = type === "scene" ? "always" : "auto";
    const text = pageText
        .replace('type: "location"', `type: ${JSON.stringify(type)}`)
        .replace('contextMode: "auto"', `contextMode: ${JSON.stringify(contextMode)}\ntrashedAt: 123`);
    const parsed = parseMemoryPackage([{ path: `pages/${type}/place.md`, text }]);
    expect(parsed).toStrictEqual({
        pages: [
            {
                id: "place",
                type,
                title: "Place",
                aliases: [],
                contextMode,
                links: [],
                retrieval: { keywords: [] },
                sections: [
                    {
                        heading: "Facts",
                        body: "At the harbor",
                        provenance: [],
                        sources: [],
                        locked: false,
                        updatedAt: 1,
                    },
                ],
                history: [],
            },
        ],
        events: [],
        threads: [],
        refusals: [],
    });
    expect(parsed.pages[0]).not.toHaveProperty("trashedAt");
});

it("refuses bad files individually without losing valid pages or polluting prototypes", () => {
    const files = [
        { path: "pages/location/good.md", text: pageText.replace('id: "place"', 'id: "good"') },
        { path: "pages/location/bad.md", text: "broken frontmatter" },
        { path: "pages/location/duplicate.md", text: pageText.replace('id: "place"', 'id: "good"') },
        { path: "pages/location/invalid.md", text: pageText.replace('id: "place"', 'id: "\\u0000"') },
        {
            path: "pages/location/large.md",
            text: pageText.replace("At the harbor", "x".repeat(MAX_READ_RESPONSE_BYTES + 1)),
        },
        {
            path: "pages/scene/first.md",
            text: pageText.replace('id: "place"', 'id: "scene"').replace('type: "location"', 'type: "scene"'),
        },
        {
            path: "pages/scene/second.md",
            text: pageText.replace('id: "place"', 'id: "scene-two"').replace('type: "location"', 'type: "scene"'),
        },
        { path: "timeline.md", text: '---\npackageVersion: 3\nrevision: "r"\n---\n\n' },
        { path: "threads.md", text: '---\npackageVersion: 3\nrevision: "r"\n---\n\n' },
        {
            path: "pages/location/prototype.md",
            text: pageText.replace('id: "place"', 'id: "prototype"\n__proto__: {"pollutedByPackage":true}'),
        },
    ];
    const parsed = parseMemoryPackage(files);
    expect(parsed.pages.map(({ id }) => id)).toEqual(["good", "scene", "prototype"]);
    expect(parsed.refusals.map(({ file, reason }) => ({ file, reason }))).toEqual(
        expect.arrayContaining([
            { file: "pages/location/bad.md", reason: "unreadable" },
            { file: "pages/location/duplicate.md", reason: "duplicateId" },
            { file: "pages/location/invalid.md", reason: "invalidId" },
            { file: "pages/location/large.md", reason: "tooLarge" },
            { file: "pages/scene/second.md", reason: "secondScene" },
            { file: "timeline.md", reason: "newerVersion" },
            { file: "threads.md", reason: "newerVersion" },
        ]),
    );
    expect(parsed.refusals).toHaveLength(7);
    expect(Object.getPrototypeOf(parsed.pages[2])).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "pollutedByPackage")).toBe(false);
    expect(Object.hasOwn(Array.prototype, "pollutedByPackage")).toBe(false);
    expect(parsed.events).toEqual([]);
    expect(parsed.threads).toEqual([]);
});

// What the tab's renderers write, which the client's test keeps true.
const renderedPackage = new URL("../../../tests/fixtures/memoryPackage.json", import.meta.url);

it("round trips rendered pages, timeline and threads verbatim and drops legacy thread references once", () => {
    const files = JSON.parse(readFileSync(renderedPackage, "utf8")) as { path: string; text: string }[];
    const body = '## x\n---\n```yaml\nid: "not metadata"\n```\n> quote\n';
    const page = {
        id: "place",
        type: "location",
        title: "Place",
        aliases: ["Port"],
        contextMode: "auto",
        links: [],
        retrieval: { keywords: [] },
        reshaped: true,
        history: [],
        sections: [
            { heading: "  Facts\t  and\n details  ", body, provenance: [], sources: [], locked: false, updatedAt: 1 },
        ],
    };
    const event = {
        id: "event",
        title: "Event event",
        summary: body,
        status: "active",
        participants: [],
        storyTime: { text: "Morning" },
        keyLines: [{ speaker: "  Captain\tName ", text: "one\n  two" }],
        stateChanges: [],
        knowledge: [],
        relationshipShifts: [],
        openThreads: {
            add: [{ title: "Return", who: ["place"] }],
            close: ["t"],
            transitions: [{ threadId: "t", to: "done" }],
        },
        sources: [{ messageId: "m0", hash: "hash", index: 0 }],
        writerRun: "run",
    };
    const threads = [
        { id: "t", title: "  Return\t soon  ", state: "done", who: ["place"], openedBy: "event", closedBy: "event" },
    ];
    expect(parseMemoryPackage(files)).toEqual({ pages: [page], events: [event], threads, refusals: [] });
    const legacy = parseMemoryPackage(
        files
            .slice(0, 2)
            .map((file) => ({ ...file, text: file.text.replace("packageVersion: 2", "packageVersion: 1") })),
    );
    expect(legacy).toEqual({
        pages: [page],
        events: [{ ...event, openThreads: { add: event.openThreads.add, close: [], transitions: [] } }],
        threads: [],
        refusals: [{ file: "threads.md", reason: "missingThreads" }],
    });
});
