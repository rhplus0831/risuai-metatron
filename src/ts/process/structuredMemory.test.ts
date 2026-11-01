// @vitest-environment node
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type { MemoryEvent, MemoryPage, MemorySource } from "../../../shared/structuredMemory.ts";
import { setEpochMismatchListener, setResourceEpoch } from "../storage/resourceClient";
import {
    buildStructuredMemoryPackage,
    memoryPagePath,
    readStructuredMemoryContents,
    readStructuredMemoryRecord,
    renderMemoryPage,
    renderMemoryTimeline,
} from "./structuredMemory.svelte";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>() }));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch }),
);

const ref = { chaId: "character/문", chatId: "chat/one" };
const base = "/api/memory/structured/character%2F%EB%AC%B8/chat%2Fone";
beforeEach(() => {
    authFetch.mockReset();
    setResourceEpoch("epoch");
});
afterEach(() => {
    setEpochMismatchListener(null);
    setResourceEpoch("");
});

const page = (id: string, body = "Current body"): MemoryPage => ({
    id,
    type: "location",
    title: "Place",
    aliases: [],
    contextMode: "auto",
    sections: [{ heading: "Facts", body, provenance: [], sources: [], locked: false, updatedAt: 1 }],
    links: [],
    retrieval: { keywords: [] },
    history: [
        {
            id: "history",
            heading: "Facts",
            before: { body: "HISTORY MUST STAY OUT", provenance: [], sources: [] },
            kind: "edit",
            highlighted: false,
            at: 1,
        },
    ],
});
const event = (id: string, sources: MemorySource[] = [], summary = "Current summary"): MemoryEvent => ({
    id,
    title: `Event ${id}`,
    summary,
    status: "active",
    participants: [],
    storyTime: { text: "Morning" },
    keyLines: [],
    stateChanges: [],
    knowledge: [],
    relationshipShifts: [],
    openThreads: { add: [], close: [], transitions: [] },
    sources,
    writerRun: "run",
    createdRevision: 1,
});
const anchored = (index: number): MemorySource => ({ messageId: `m${index}`, hash: "hash", index });
const unanchored: MemorySource = { messageId: "lost", hash: null, index: null };
const round = (revision: string, pages: MemoryPage[], events: MemoryEvent[], next: number | null) =>
    Response.json({ revision, pages, events, next });

/** Read only metadata and its advertised lengths; never search the bodies for Markdown delimiters. */
function metadata(lines: string[], start: number, end: string) {
    const fields: Record<string, any> = {};
    let cursor = start;
    while (cursor < lines.length && lines[cursor] !== end) {
        const colon = lines[cursor].indexOf(": ");
        expect(colon).toBeGreaterThan(0);
        fields[lines[cursor].slice(0, colon)] = JSON.parse(lines[cursor].slice(colon + 2));
        cursor++;
    }
    expect(lines[cursor]).toBe(end);
    return { fields, next: cursor + 2 };
}

function splitPage(text: string) {
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    const header = metadata(lines, 1, "---");
    let cursor = header.next;
    const bodies: string[] = [];
    for (const section of header.fields.sections) {
        expect(lines[cursor]).toBe(`## ${section.heading}`);
        expect(lines[cursor + 1]).toBe("");
        bodies.push(lines.slice(cursor + 2, cursor + 2 + section.bodyLines).join("\n"));
        cursor += 2 + section.bodyLines;
        expect(lines[cursor++]).toBe("");
    }
    expect(lines.slice(cursor)).toEqual([""]);
    return { fields: header.fields, bodies };
}

function splitTimeline(text: string) {
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    const header = metadata(lines, 1, "---");
    let cursor = header.next;
    const events: { fields: Record<string, any>; summary: string }[] = [];
    while (cursor < lines.length - 1) {
        expect(lines[cursor]).toMatch(/^## /);
        expect(lines[cursor + 1]).toBe("");
        expect(lines[cursor + 2]).toBe("```yaml");
        const entry = metadata(lines, cursor + 3, "```");
        cursor = entry.next;
        events.push({
            fields: entry.fields,
            summary: lines.slice(cursor, cursor + entry.fields.summaryLines).join("\n"),
        });
        cursor += entry.fields.summaryLines;
        expect(lines[cursor++]).toBe("");
    }
    expect(lines.slice(cursor)).toEqual([""]);
    return { fields: header.fields, events };
}

async function packageFiles() {
    const result = await buildStructuredMemoryPackage(ref);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(JSON.stringify(result));
    return Object.fromEntries(
        Object.entries(unzipSync(result.value.bytes)).map(([name, value]) => [name, strFromU8(value)]),
    );
}

it("reads with encoded ids and the epoch header and zips every round into Markdown", async () => {
    const pages = [page("a/b"), page("a%2Fb", "Second body")];
    const e = event("event/one");
    const revision = "epoch:1:1";
    authFetch
        .mockResolvedValueOnce(
            Response.json({
                revision,
                pages: pages.map(({ id, type, title }) => ({ id, type, title, bytes: 1 })),
                events: [{ id: e.id, title: e.title, status: e.status, bytes: 1 }],
                threads: [],
                runs: [],
            }),
        )
        .mockResolvedValueOnce(Response.json({ revision, data: pages[0] }))
        .mockResolvedValueOnce(round(revision, [pages[0]], [], 1))
        .mockResolvedValueOnce(round(revision, [pages[1]], [], 2))
        .mockResolvedValueOnce(round(revision, [], [e], null))
        .mockResolvedValueOnce(Response.json({ error: "Record not found", reason: "recordGone" }, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ error: "Chat not found", reason: "chatGone" }, { status: 404 }));
    expect(await readStructuredMemoryContents(ref)).toMatchObject({
        outcome: "ok",
        value: { revision, pages: [{ id: "a/b" }, { id: "a%2Fb" }], events: [{ id: e.id }] },
    });
    expect(await readStructuredMemoryRecord(ref, "pages", "a/b")).toEqual({
        outcome: "ok",
        value: { revision, data: pages[0] },
    });
    const files = await packageFiles();
    expect(Object.keys(files)).toHaveLength(3);
    expect(splitTimeline(files["timeline.md"]).events.map(({ fields }) => fields.id)).toEqual([e.id]);
    expect(splitTimeline(files["timeline.md"]).fields.revision).toBe(revision);
    const exported = Object.entries(files)
        .filter(([name]) => name !== "timeline.md")
        .map(([name, text]) => {
            expect(name.split("/").slice(0, 2)).toEqual(["pages", "location"]);
            const parsed = splitPage(text);
            expect(parsed.fields).not.toHaveProperty("history");
            expect(text).not.toContain("HISTORY MUST STAY OUT");
            return [parsed.fields.id, parsed.bodies];
        });
    expect(exported).toEqual([
        ["a/b", ["Current body"]],
        ["a%2Fb", ["Second body"]],
    ]);
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        base,
        `${base}/records/pages/a%2Fb`,
        `${base}/package`,
        `${base}/package?cursor=1&revision=${encodeURIComponent(revision)}`,
        `${base}/package?cursor=2&revision=${encodeURIComponent(revision)}`,
    ]);
    for (const [, init] of authFetch.mock.calls) {
        expect(new Headers(init?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
        expect(init?.cache).toBe("no-store");
    }
    expect(await readStructuredMemoryRecord(ref, "pages", "missing")).toEqual({
        outcome: "refused",
        reason: "recordGone",
    });
    expect(await readStructuredMemoryContents({ ...ref, chatId: "missing" })).toEqual({
        outcome: "refused",
        reason: "chatGone",
    });
});

it("discards partial pages and events on revision changes and can complete the third read", async () => {
    authFetch
        .mockResolvedValueOnce(round("epoch:1:1", [page("discarded-first")], [event("discarded-first")], 2))
        .mockResolvedValueOnce(Response.json({ revision: "epoch:1:2" }, { status: 409 }))
        .mockResolvedValueOnce(round("epoch:1:2", [page("discarded-second")], [event("discarded-second")], 2))
        .mockResolvedValueOnce(Response.json({ revision: "epoch:1:3" }, { status: 409 }))
        .mockResolvedValueOnce(round("epoch:1:3", [page("current")], [], 1))
        .mockResolvedValueOnce(round("epoch:1:3", [], [event("current")], null));
    const files = await packageFiles();
    expect(Object.keys(files)).toHaveLength(2);
    const pageText = Object.entries(files).find(([name]) => name !== "timeline.md")![1];
    expect(splitPage(pageText).fields.id).toBe("current");
    const timeline = splitTimeline(files["timeline.md"]);
    expect(timeline.fields.revision).toBe("epoch:1:3");
    expect(timeline.events.map(({ fields }) => fields.id)).toEqual(["current"]);
    expect(JSON.stringify(files)).not.toContain("discarded");
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        `${base}/package`,
        `${base}/package?cursor=2&revision=epoch%3A1%3A1`,
        `${base}/package`,
        `${base}/package?cursor=2&revision=epoch%3A1%3A2`,
        `${base}/package`,
        `${base}/package?cursor=1&revision=epoch%3A1%3A3`,
    ]);
});

it("refuses changed memory after three complete read attempts", async () => {
    authFetch.mockImplementation(async () => {
        const request = authFetch.mock.calls.length;
        if (request > 6) throw new Error("Unexpected fourth attempt");
        return request % 2 === 1
            ? round(`epoch:1:${request}`, [page("partial")], [], 1)
            : Response.json({ revision: `epoch:1:${request}` }, { status: 409 });
    });
    expect(await buildStructuredMemoryPackage(ref)).toEqual({ outcome: "refused", reason: "changed" });
    expect(authFetch).toHaveBeenCalledTimes(6);
});

it("stops a partial package immediately on 412 and notifies the epoch mismatch listener", async () => {
    const replaced = vi.fn();
    setEpochMismatchListener(replaced);
    authFetch
        .mockResolvedValueOnce(round("epoch:1:1", [page("partial")], [], 1))
        .mockResolvedValueOnce(Response.json({ error: "EpochMismatch", epoch: "replacement" }, { status: 412 }))
        .mockImplementation(async () => round("replacement:1:1", [], [], null));
    expect(await buildStructuredMemoryPackage(ref)).toEqual({ outcome: "refused", reason: "epoch" });
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(replaced.mock.calls).toEqual([["replacement"]]);
});

it("splits verbatim section bodies and event summaries by exact metadata line counts and omits page history", () => {
    const bodies = ["first\n## x\n```md\n---\n```\nlast\n\n", "", "tail\n"];
    const p = page("p");
    p.sections = bodies.map((body, i) => ({ ...p.sections[0], heading: `Section ${i}`, body }));
    const text = renderMemoryPage(p);
    const parsed = splitPage(text);
    expect(parsed.fields.sections.map((section: { bodyLines: number }) => section.bodyLines)).toEqual([8, 1, 2]);
    expect(parsed.bodies).toEqual(bodies);
    expect(parsed.fields).not.toHaveProperty("history");
    expect(text).not.toContain("HISTORY MUST STAY OUT");
    const timeline = splitTimeline(
        renderMemoryTimeline(
            bodies.map((body, i) => event(String(i), [], body)),
            "epoch:1:1",
        ),
    );
    expect(timeline.events.map(({ fields }) => fields.summaryLines)).toEqual([8, 1, 2]);
    expect(timeline.events.map(({ summary }) => summary)).toEqual(bodies);
});

it("orders events by their smallest anchored source index, preserving arrival ties and placing unanchored events last", () => {
    const events = [
        event("no-sources"),
        event("later", [anchored(4)]),
        event("first-tie", [anchored(9), unanchored, anchored(1)]),
        event("second-tie", [anchored(1)]),
        event("unanchored", [unanchored]),
        event("earliest", [anchored(0)]),
    ];
    events[2].status = "retracted";
    events[4].status = "stale";
    const timeline = splitTimeline(renderMemoryTimeline(events, "revision"));
    expect(timeline.events.map(({ fields }) => fields.id)).toEqual([
        "earliest",
        "first-tie",
        "second-tie",
        "later",
        "no-sources",
        "unanchored",
    ]);
});

it("keeps page files inside their type folder and gives distinct ids distinct paths", () => {
    const ids = [
        "/../../outside",
        "%2F..%2F..%2Foutside",
        "a/b",
        "a%2Fb",
        "a\\b",
        "*",
        "%2A",
        "문/😀",
        "x".repeat(512),
    ];
    const paths = ids.map((id) => memoryPagePath({ ...page(id), title: '../Places\\folder/unsafe:*?"<>|[]' }));
    for (const filename of paths) {
        expect(filename.split("/")).toHaveLength(3);
        expect(filename.startsWith("pages/location/")).toBe(true);
        expect(filename).not.toContain("\\");
        expect(path.posix.dirname(filename)).toBe("pages/location");
    }
    expect(new Set(paths).size).toBe(ids.length);
});
