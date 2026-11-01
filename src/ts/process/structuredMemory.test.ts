// @vitest-environment node
import path from "node:path";
import type { Message } from "../../../shared/database.ts";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type { MemoryEvent, MemoryPage, MemorySource } from "../../../shared/structuredMemory.ts";
import { setEpochMismatchListener, setResourceEpoch } from "../storage/resourceClient";
import {
    buildStructuredMemoryPackage,
    buildStructuredMemoryLog,
    readStructuredMemoryCoverage,
    joinMemoryCoverage,
    memoryRunView,
    memoryPagePath,
    memoryReceiptView,
    newestAssistantMessageId,
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

it("shows missing receipts only on the newest eligible assistant and distinguishes recorded, failed, paused, and tab-bound turns", () => {
    const message = (chatId: string, role: "user" | "char", disabled?: true | "allBefore") => ({
        chatId,
        role,
        data: chatId,
        disabled,
    });
    const messages = [
        message("a0", "char"),
        message("reset", "user", "allBefore"),
        message("a1", "char"),
        message("u2", "user"),
        message("disabled", "char", true),
    ];
    expect(newestAssistantMessageId(messages)).toBe("a1");
    expect(newestAssistantMessageId(messages.slice(0, 2))).toBeUndefined();
    for (const taskLive of [true, false]) {
        for (const row of messages) {
            expect(memoryReceiptView(undefined, { newest: row.chatId === "a1", taskLive })).toMatchObject({
                kind: row.chatId !== "a1" ? "hidden" : taskLive ? "working" : "none",
                action: row.chatId === "a1" ? "record" : null,
            });
        }
    }
    for (const [receipt, kind, action] of [
        [{ state: "recorded", eventId: "event" }, "recorded", null],
        [{ state: "failed", reason: "requestFailed" }, "failed", "record"],
        [{ state: "notAutomatic", reason: "pluginModel" }, "notAutomatic", "record"],
        [{ state: "notAutomatic", reason: "requestTrigger" }, "notAutomatic", "record"],
        [{ state: "skipped", reason: "writerPaused" }, "paused", "resume"],
    ] as const) {
        expect(memoryReceiptView(receipt, { newest: false, taskLive: false })).toMatchObject({ kind, action });
    }
});

it.each(["coverage", "log"])(
    "restarts the %s read from nothing and exports only the successful revision",
    async (kind) => {
        const response = (revision: string, id: string, next: number | null) =>
            Response.json({ revision, events: [{ id }], runs: [{ id }], total: 2, next });
        authFetch
            .mockResolvedValueOnce(response("r1", "discarded-first", 1))
            .mockResolvedValueOnce(Response.json({ revision: "r2" }, { status: 409 }))
            .mockResolvedValueOnce(response("r2", "discarded-second", 1))
            .mockResolvedValueOnce(Response.json({ revision: "r3" }, { status: 409 }))
            .mockResolvedValueOnce(response("r3", "current-first", 1))
            .mockResolvedValueOnce(response("r3", "current-last", null));
        const result =
            kind === "coverage" ? await readStructuredMemoryCoverage(ref) : await buildStructuredMemoryLog(ref);
        expect(result.outcome).toBe("ok");
        if (result.outcome !== "ok") throw new Error(JSON.stringify(result));
        const value = "bytes" in result.value ? JSON.parse(strFromU8(result.value.bytes)) : result.value;
        expect(value).toEqual(
            kind === "coverage"
                ? {
                      revision: "r3",
                      events: [{ id: "current-first" }, { id: "current-last" }],
                      runs: [{ id: "current-first" }, { id: "current-last" }],
                  }
                : {
                      logVersion: expect.any(Number),
                      revision: "r3",
                      runs: [{ id: "current-first" }, { id: "current-last" }],
                  },
        );
        if ("name" in result.value) expect(result.value.name).toMatch(/\.json$/);
        const route = kind === "coverage" ? "coverage" : "runs";
        expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
            `${base}/${route}`,
            `${base}/${route}?cursor=1&revision=r1`,
            `${base}/${route}`,
            `${base}/${route}?cursor=1&revision=r2`,
            `${base}/${route}`,
            `${base}/${route}?cursor=1&revision=r3`,
        ]);
        for (const [, init] of authFetch.mock.calls)
            expect(new Headers(init?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
    },
);

it.each(["coverage", "log"])(
    "refuses the %s read after three revision changes and returns I/O failures",
    async (kind) => {
        const read = kind === "coverage" ? readStructuredMemoryCoverage : buildStructuredMemoryLog;
        authFetch.mockResolvedValue(Response.json({ revision: "new" }, { status: 409 }));
        expect(await read(ref)).toEqual({ outcome: "refused", reason: "changed" });
        expect(authFetch).toHaveBeenCalledTimes(3);
        authFetch.mockReset().mockRejectedValue(new Error("offline"));
        expect(await read(ref)).toEqual({ outcome: "failed", error: "offline" });
        expect(authFetch).toHaveBeenCalledTimes(1);
    },
);

it("joins coverage by eligibility, event precedence, newest run and receipt notices, never missing receipts", () => {
    const ids = [
        "before",
        "reset",
        "disabled",
        "covered",
        "stale",
        "suppressed",
        "retracted",
        "failed",
        "skipped",
        "running",
        "notice",
        "paused",
        "receipt-only",
        "missing",
    ];
    const messages: Message[] = ids.map((chatId) => ({
        chatId,
        role: "char" as const,
        data: chatId,
        ...(chatId === "reset" ? { disabled: "allBefore" as const } : chatId === "disabled" ? { disabled: true } : {}),
        generationInfo: {
            memory: {
                pages: [],
                refused: [],
                unverified: [],
                warnings: [],
                ...(chatId === "notice"
                    ? { state: "notAutomatic" as const, reason: "pluginModel" }
                    : chatId === "paused"
                      ? { state: "skipped" as const, reason: "writerPaused" }
                      : { state: "recorded" as const, eventId: "receipt-is-not-proof" }),
            },
        },
    }));
    delete messages.at(-1)!.generationInfo;
    const facts = {
        events: [
            { id: "active", title: "Active", status: "active" as const, messageIds: ["before", "disabled", "covered"] },
            {
                id: "stale-event",
                title: "Stale",
                status: "stale" as const,
                staleReason: "changed" as const,
                messageIds: ["covered", "stale"],
            },
            {
                id: "suppressed-event",
                title: "Suppressed",
                status: "active" as const,
                suppressed: true,
                messageIds: ["covered", "stale", "suppressed"],
            },
            {
                id: "retracted-event",
                title: "Retracted",
                status: "retracted" as const,
                messageIds: ["covered", "stale", "suppressed", "retracted"],
            },
        ],
        runs: [
            // The notice and no-receipt rows are named by no run.
            { id: "older", result: "skipped" as const, reason: "writerPaused", messageIds: ids.slice(0, 10) },
            {
                id: "failed-run",
                result: "failed" as const,
                reason: "requestFailed",
                messageIds: ["covered", "stale", "suppressed", "retracted", "failed"],
            },
            { id: "skipped-run", result: "skipped" as const, reason: "emptyWindow", messageIds: ["skipped"] },
            { id: "pending-run", result: "pending" as const, messageIds: ["running"] },
        ],
    };
    const joined = joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: true });
    expect(joined.rows.map(({ state, reason }) => [state, reason])).toEqual([
        ["excluded", "disabled"],
        ["excluded", "disabled"],
        ["excluded", "disabled"],
        ["covered", undefined],
        ["stale", "changed"],
        ["excluded", "suppressed"],
        ["excluded", "retracted"],
        ["failed", "requestFailed"],
        ["skipped", "emptyWindow"],
        ["pending", undefined],
        ["skipped", "pluginModel"],
        ["skipped", "writerPaused"],
        ["pending", undefined],
        ["pending", undefined],
    ]);
    expect(joined.counts).toEqual({ covered: 1, stale: 1, excluded: 5, failed: 1, skipped: 3, pending: 3 });
});

it("counts the raw window in assistant turns and leaves only covered eligible history when memory is on", () => {
    const messages = [
        { chatId: "disabled", role: "char" as const, data: "disabled", disabled: true },
        { chatId: "u0", role: "user" as const, data: "old question" },
        { chatId: "a0", role: "char" as const, data: "old answer" },
        { chatId: "u1", role: "user" as const, data: "new question" },
        { chatId: "blank", role: "char" as const, data: "  " },
        { chatId: "a1", role: "char" as const, data: "new answer" },
        { chatId: "tail", role: "user" as const, data: "next question" },
    ];
    const facts = {
        events: [{ id: "event", title: "Event", status: "active" as const, messageIds: ["disabled", "u0", "a1"] }],
        runs: [],
    };
    expect(joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: true })).toMatchObject({
        gap: [2],
        leaving: [1],
    });
    expect(joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: false })).toMatchObject({
        gap: [2],
        leaving: [],
    });
    expect(joinMemoryCoverage(messages, facts, { windowTurns: 2, memoryOn: true })).toMatchObject({
        gap: [],
        leaving: [],
    });
});

it("reads malformed stored runs without throwing or inventing an extraction", () => {
    for (const run of [
        null,
        [],
        "broken",
        {
            id: "wrong",
            window: [null, 3, { index: "2" }],
            model: {},
            inputTokens: {},
            analysis: { event: [] },
            receipt: { unverified: "wrong" },
        },
    ]) {
        expect(memoryRunView(run)).toMatchObject({
            range: null,
            event: null,
            candidates: [],
            unverified: [],
            warnings: [],
        });
        expect(memoryRunView(run)).not.toHaveProperty("inputTokens");
        expect(memoryRunView(run)).not.toHaveProperty("model");
    }
});
