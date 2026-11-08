// @vitest-environment node
import path from "node:path";
import { readFileSync } from "node:fs";
import type { Message } from "../../../shared/database.ts";
import { strFromU8, strToU8, zipSync, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import type {
    MemoryEvent,
    MemoryPage,
    MemorySource,
    MemoryThread,
    StructuredMemoryImportFile,
    StructuredMemoryImportRefusal,
} from "../../../shared/structuredMemory.ts";
import { setEpochMismatchListener, setResourceEpoch } from "../storage/resourceClient";
import {
    readStructuredMemoryCost,
    abandonStructuredMemoryRebuild,
    memoryMessageHash,
    memoryMessageHasher,
    reconcileMemoryCoverage,
    buildStructuredMemoryPackage,
    buildStructuredMemoryLog,
    readStructuredMemoryCoverage,
    readStructuredMemoryFile,
    joinMemoryCoverage,
    memoryRunView,
    memoryTimelineRows,
    memoryPageHistoryView,
    memoryBlockEntries,
    memoryPagePath,
    memoryReceiptView,
    memoryTestResultView,
    memoryWriterNotice,
    newestAssistantMessageId,
    readStructuredMemoryContents,
    readStructuredMemoryRecord,
    renderMemoryPage,
    renderMemoryTimeline,
    renderMemoryThreads,
    structuredMemoryPageTool,
    importStructuredMemoryPackage,
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
const NO_SCREENING = { refusal: [], format: [] };
const noThreads = (revision: string) => Response.json({ revision, threads: [], next: null });

it("shares pending contents only for the same chat and epoch before a memory write answer settles", async () => {
    const pending: { resolve: (response: Response) => void; promise: Promise<Response> }[] = [];
    authFetch.mockImplementation(() => {
        let resolve!: (response: Response) => void;
        const promise = new Promise<Response>((done) => {
            resolve = done;
        });
        pending.push({ resolve, promise });
        return promise;
    });
    const reads: ReturnType<typeof readStructuredMemoryContents>[] = [];
    const read = (chat = ref) => {
        const answer = readStructuredMemoryContents(chat);
        reads.push(answer);
        return answer;
    };
    const contents = (revision: string) => Response.json({ revision, pages: [], events: [], threads: [], runs: [] });
    try {
        read();
        read();
        expect(authFetch).toHaveBeenCalledTimes(1);
        read({ ...ref, chatId: "other" });
        expect(authFetch).toHaveBeenCalledTimes(2);
        setResourceEpoch("replacement");
        read();
        read();
        expect(authFetch).toHaveBeenCalledTimes(3);
        const write = structuredMemoryPageTool(ref, "seen", { kind: "merge", sourceId: "a", targetId: "b" });
        read();
        expect(authFetch).toHaveBeenCalledTimes(4);
        // A refusal is also a settled write answer: it can reveal a newer server revision.
        pending[3].resolve(Response.json({ revision: "changed" }, { status: 409 }));
        expect(await write).toEqual({ outcome: "refused", reason: "changed" });
        read();
        read();
        expect(authFetch).toHaveBeenCalledTimes(5);
        // Settling an older read must leave the newer in-flight read available to share.
        pending[2].resolve(contents("before-write"));
        expect(await reads[3]).toMatchObject({ outcome: "ok", value: { revision: "before-write" } });
        read();
        expect(authFetch).toHaveBeenCalledTimes(5);
        pending[4].resolve(contents("after-write"));
        expect(await reads.at(-1)).toMatchObject({ outcome: "ok", value: { revision: "after-write" } });
        read();
        expect(authFetch).toHaveBeenCalledTimes(6);
    } finally {
        pending.forEach(({ resolve }) => resolve(contents("cleanup")));
        await Promise.all(reads);
    }
});

it("exports every Log round using decreasing inclusive seq cursors", async () => {
    authFetch
        .mockResolvedValueOnce(Response.json({ revision: "r", total: 3, runs: [{ id: "newest" }], next: 73 }))
        .mockResolvedValueOnce(Response.json({ revision: "r", total: 3, runs: [{ id: "middle" }], next: 12 }))
        .mockResolvedValueOnce(Response.json({ revision: "r", total: 3, runs: [{ id: "oldest" }], next: null }));
    const result = await buildStructuredMemoryLog(ref);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error(JSON.stringify(result));
    expect(JSON.parse(strFromU8(result.value.bytes))).toMatchObject({
        revision: "r",
        runs: [{ id: "newest" }, { id: "middle" }, { id: "oldest" }],
    });
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        `${base}/runs`,
        `${base}/runs?cursor=73&revision=r`,
        `${base}/runs?cursor=12&revision=r`,
    ]);
});

// The import route's own reader, loaded by a computed path: a literal import would put the server's module
// graph into the client type check, whose compiler options it does not build under.
const importPackagePath = "../../../server/src/prompt/memory/structured/importPackage.ts";
const { parseMemoryPackage } = (await import(/* @vite-ignore */ importPackagePath)) as {
    parseMemoryPackage: (files: readonly StructuredMemoryImportFile[]) => {
        pages: MemoryPage[];
        events: Omit<MemoryEvent, "createdRevision">[];
        threads: MemoryThread[];
        refusals: StructuredMemoryImportRefusal[];
    };
};

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
        .mockResolvedValueOnce(noThreads(revision))
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
    expect(Object.keys(files)).toHaveLength(4);
    const parsed = parseMemoryPackage(Object.entries(files).map(([path, text]) => ({ path, text })));
    const { createdRevision, ...exportedEvent } = e;
    expect(parsed).toEqual({
        pages: pages.map((page) => ({ ...page, history: [] })),
        events: [exportedEvent],
        threads: [],
        refusals: [],
    });
    expect(files["timeline.md"]).toContain(`revision: "${revision}"\n`);
    for (const [name, text] of Object.entries(files).filter(([name]) => name.startsWith("pages/"))) {
        expect(name.split("/").slice(0, 2)).toEqual(["pages", "location"]);
        expect(text).not.toContain("HISTORY MUST STAY OUT");
    }
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        base,
        `${base}/records/pages/a%2Fb`,
        `${base}/package`,
        `${base}/package?cursor=1&revision=${encodeURIComponent(revision)}`,
        `${base}/package?cursor=2&revision=${encodeURIComponent(revision)}`,
        `${base}/threads?cursor=0&revision=${encodeURIComponent(revision)}`,
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
        .mockResolvedValueOnce(round("epoch:1:3", [], [event("current")], null))
        .mockResolvedValueOnce(noThreads("epoch:1:3"));
    const files = await packageFiles();
    expect(Object.keys(files)).toHaveLength(3);
    const parsed = parseMemoryPackage(Object.entries(files).map(([path, text]) => ({ path, text })));
    const { createdRevision, ...exportedEvent } = event("current");
    expect(parsed).toEqual({
        pages: [{ ...page("current"), history: [] }],
        events: [exportedEvent],
        threads: [],
        refusals: [],
    });
    expect(files["timeline.md"]).toContain('revision: "epoch:1:3"\n');
    expect(JSON.stringify(files)).not.toContain("discarded");
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
        `${base}/package`,
        `${base}/package?cursor=2&revision=epoch%3A1%3A1`,
        `${base}/package`,
        `${base}/package?cursor=2&revision=epoch%3A1%3A2`,
        `${base}/package`,
        `${base}/package?cursor=1&revision=epoch%3A1%3A3`,
        `${base}/threads?cursor=0&revision=epoch%3A1%3A3`,
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

it("round trips section bodies and summaries containing headings and delimiters without page history", () => {
    const bodies = ["first\n## x\n```md\n---\n```\nlast\n\n", "", "tail\n"];
    const p = page("p");
    p.sections = bodies.map((body, i) => ({
        ...p.sections[0],
        heading: i === 0 ? "  Section\t 0\n details  " : `Section ${i}`,
        body,
    }));
    const events = bodies.map((body, i) => event(String(i), [], body));
    const text = renderMemoryPage(p);
    const parsed = parseMemoryPackage([
        { path: memoryPagePath(p), text },
        { path: "timeline.md", text: renderMemoryTimeline(events, "epoch:1:1") },
        { path: "threads.md", text: renderMemoryThreads([], "epoch:1:1") },
    ]);
    expect(parsed).toEqual({
        pages: [{ ...p, history: [] }],
        events: events.map(({ createdRevision, ...event }) => event),
        threads: [],
        refusals: [],
    });
    expect(text).not.toContain("HISTORY MUST STAY OUT");
});

it("round trips event key lines and quotes resembling metadata and fences without losing the next records", () => {
    const quoted = event("quoted", [anchored(0)]);
    quoted.title = "  Event\t with\n quotes  ";
    quoted.keyLines = [
        { speaker: "key", text: '{"id":"not an event","summaryLines":0}' },
        { speaker: "  ```yaml\n ", text: 'id: "forged"\n```\n---\n## x' },
    ];
    const next = event("next", [anchored(1)]);
    const threads = [{ id: "thread", title: "  Next\t step\n ", state: "open" as const, who: [], openedBy: "quoted" }];
    const parsed = parseMemoryPackage([
        { path: "timeline.md", text: renderMemoryTimeline([quoted, next], "r") },
        { path: "threads.md", text: renderMemoryThreads(threads, "r") },
    ]);
    expect(parsed).toEqual({
        pages: [],
        events: [quoted, next].map(({ createdRevision, ...event }) => event),
        threads,
        refusals: [],
    });
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
    const parsed = parseMemoryPackage([
        { path: "timeline.md", text: renderMemoryTimeline(events, "revision") },
        { path: "threads.md", text: renderMemoryThreads([], "revision") },
    ]);
    expect(parsed.refusals).toEqual([]);
    expect(parsed.events.map(({ id }) => id)).toEqual([
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
    const joined = joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: true, screening: NO_SCREENING });
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
    expect(
        joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: true, screening: NO_SCREENING }),
    ).toMatchObject({
        gap: [2],
        leaving: [1],
    });
    expect(
        joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: false, screening: NO_SCREENING }),
    ).toMatchObject({
        gap: [2],
        leaving: [],
    });
    expect(
        joinMemoryCoverage(messages, facts, { windowTurns: 2, memoryOn: true, screening: NO_SCREENING }),
    ).toMatchObject({
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
            answer: 3,
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
        expect(memoryRunView(run)).not.toHaveProperty("answer");
    }
    expect(memoryRunView({ answer: '{"patches": [' }).answer).toBe('{"patches": [');
});

it("extracts the final messages a preview's memory block names, in its order, skipping indexes it cannot read", () => {
    const messages = [
        { role: "system", content: "Unrelated legacy block", memo: "supaMemory" },
        { role: "system", content: "Stable promise" },
        { role: "user", content: "What now?", memo: "last" },
        { role: "system", content: "Volatile door is open", memo: "rewritten-by-script" },
    ];
    expect(memoryBlockEntries(messages, [1, 3])).toEqual([messages[1], messages[3]]);
    expect(memoryBlockEntries(messages, [1, -1, 4, 1.5, "3", null])).toEqual([messages[1]]);
    expect(memoryBlockEntries(messages, [])).toEqual([]);
    for (const block of [undefined, null, "1", { 0: 1 }]) {
        expect(memoryBlockEntries(messages, block)).toEqual([]);
    }
});

it("orders Timeline by surviving messages then stored positions and ages from the newest surviving source", () => {
    const messages: Message[] = [
        { chatId: "before", role: "char", data: "Before boundary" },
        { chatId: "boundary", role: "user", data: "Boundary", disabled: "allBefore" },
        { chatId: "a", role: "char", data: "First reply" },
        { chatId: "disabled", role: "char", data: "Not read", disabled: true },
        { chatId: "blank", role: "char", data: " \n" },
        { chatId: "b", role: "char", data: "Second reply" },
        { chatId: "tail", role: "user", data: "Latest question" },
    ];
    const events = [
        { id: "unknown", messageIds: ["gone"] },
        { id: "late", messageIds: ["tail"], sourceIndex: 0 },
        { id: "tie-first", messageIds: [], sourceIndex: 2 },
        { id: "spanning", messageIds: ["b", "gone", "a"], sourceIndex: 99 },
        { id: "tie-last", messageIds: ["a"] },
        { id: "fallback", messageIds: ["gone"], sourceIndex: 1 },
        { id: "old", messageIds: ["before"] },
        { id: "unknown-last", messageIds: [] },
    ].map((row) => ({ sourceIndex: null, ...row, title: row.id, status: "active" as const }));
    expect(memoryTimelineRows(events, messages).map(({ event, turnsAgo }) => [event.id, turnsAgo])).toEqual([
        ["old", 2],
        ["fallback", null],
        ["tie-first", null],
        ["spanning", 1],
        ["tie-last", 2],
        ["late", 1],
        ["unknown", null],
        ["unknown-last", null],
    ]);
});

it("compares page history only with the next entry of its heading or the live section", () => {
    const p = page("p", "Facts now");
    p.sections.push({ ...p.sections[0], heading: "Other", body: "Other now" });
    const entry = (id: string, heading: string | null, body: string | null, at: number) => ({
        id,
        heading,
        before: body === null ? null : { body, provenance: [], sources: [] },
        kind: "edit" as const,
        highlighted: false,
        at,
    });
    p.history = [
        entry("created", "Facts", null, 1),
        entry("other", "Other", "Other before", 2),
        entry("updated", "Facts", "Facts before", 3),
        entry("page", null, null, 4),
    ];
    const marks = { highlighted: false, reverted: false, revertable: false };
    expect(memoryPageHistoryView(p)).toEqual([
        { ...marks, id: "page", heading: null, kind: "edit", at: 4, before: null, after: null },
        { ...marks, id: "updated", heading: "Facts", kind: "edit", at: 3, before: "Facts before", after: "Facts now" },
        { ...marks, id: "other", heading: "Other", kind: "edit", at: 2, before: "Other before", after: "Other now" },
        { ...marks, id: "created", heading: "Facts", kind: "edit", at: 1, before: null, after: "Facts before" },
    ]);
});

it("hashes role and Unicode text exactly like server source anchors including a lone surrogate", () => {
    // Fixed server messageSourceHash values; no server imports in the Node client test.
    const message = { role: "char", data: '문 😀\ud800\nquote: "' } as const;
    const v1 = "db8d581f5fb0f0005aa6337e8568fca94baa45dc48b0a9ec2a01cbda9197f8b5";
    const v2 = "v2:fb3ad95bd266b99de71f60e1303e8a2f65c85f886e4bf8960ba96330341313b5";
    // Version 3 digests the markup-stripped text, which equals this plain text.
    const v3 = "v3:fb3ad95bd266b99de71f60e1303e8a2f65c85f886e4bf8960ba96330341313b5";
    expect(memoryMessageHash(message)).toBe(v3);
    expect(memoryMessageHash(message, v1)).toBe(v1);
    expect(memoryMessageHash(message, v2)).toBe(v2);
    // Display markup leaves the version 3 hash alone; version 2 still reads it raw.
    const marked = { ...message, data: '문 <b>😀</b>\ud800\nquote: "\n\n<div class="am"><img src="x"></div>\n' };
    expect(memoryMessageHash(marked)).toBe(v3);
    expect(memoryMessageHash(marked, v2)).toBe("v2:c6c056e5def16121e6d4f71ca9c8d42a2fdba67eb560f92e3bfe3ef0f783cf05");
});

it("joins reconciled held messages as stale with no leaving coverage or request and restores them immediately", () => {
    const messages: Message[] = [
        { chatId: "u", role: "user", data: "Question" },
        { chatId: "a", role: "char", data: "Answer" },
        { chatId: "tail", role: "char", data: "Newest reply" },
    ];
    const sources = messages
        .slice(0, 2)
        .map((m, index) => ({ messageId: m.chatId!, index, hash: memoryMessageHash(m) }));
    const facts = {
        revision: "r1",
        events: [{ ...event("e", sources), messageIds: ["u", "a"], sourceIndex: 0 }],
        runs: [],
    };
    const before = structuredClone(facts);
    const hash = memoryMessageHasher();
    const join = () =>
        joinMemoryCoverage(messages, reconcileMemoryCoverage(facts, messages, hash), {
            windowTurns: 1,
            memoryOn: true,
            screening: NO_SCREENING,
        });
    expect(join().leaving).toEqual([0, 1]);
    messages[1].data = "Edited answer";
    const stale = join();
    expect(stale.rows.slice(0, 2).map(({ state, reason }) => [state, reason])).toEqual([
        ["stale", "changed"],
        ["stale", "changed"],
    ]);
    expect(stale.counts).toMatchObject({ covered: 0, stale: 2 });
    expect(stale.leaving).toEqual([]);
    expect(stale.gap).toEqual([0, 1]);
    messages[1].data = "Answer";
    expect(join().leaving).toEqual([0, 1]);
    expect(facts).toEqual(before);
    expect(authFetch).not.toHaveBeenCalled();
});

it("reads whole chat files across package and thread rounds, restarting both at a moved revision", async () => {
    vi.useFakeTimers();
    try {
        const contents = (revision: string) =>
            Response.json({
                revision,
                pages: [{ id: "page" }],
                events: [{ id: "event" }],
                threads: [{ id: "thread" }],
                runs: [{ id: "private-run" }],
            });
        const threads = [
            { id: "t1", title: "Return", who: ["page"], state: "open" },
            { id: "t2", title: "Promise", who: [], state: "done", closedBy: "event" },
        ];
        const p = page("page");
        const e = event("event", [anchored(0)]);
        authFetch
            .mockResolvedValueOnce(contents("old"))
            .mockResolvedValueOnce(round("old", [page("abandoned")], [], null))
            .mockResolvedValueOnce(
                Response.json({ revision: "old", threads: [{ ...threads[0], id: "abandoned" }], next: 1 }),
            )
            .mockResolvedValueOnce(Response.json({ reason: "changed", revision: "new" }, { status: 409 }))
            .mockResolvedValueOnce(contents("new"))
            .mockResolvedValueOnce(round("new", [p], [], 1))
            .mockResolvedValueOnce(round("new", [], [e], null))
            .mockResolvedValueOnce(Response.json({ revision: "new", threads: [threads[0]], next: 1 }))
            .mockResolvedValueOnce(Response.json({ revision: "new", threads: [threads[1]], next: null }));
        expect(await readStructuredMemoryFile(ref)).toEqual({
            outcome: "ok",
            value: { rows: true, pages: [p], events: [e], threads },
        });
        expect(authFetch.mock.calls.map(([url]) => url)).toEqual([
            base,
            `${base}/package?cursor=0&revision=old`,
            `${base}/threads?cursor=0&revision=old`,
            `${base}/threads?cursor=1&revision=old`,
            base,
            `${base}/package?cursor=0&revision=new`,
            `${base}/package?cursor=1&revision=new`,
            `${base}/threads?cursor=0&revision=new`,
            `${base}/threads?cursor=1&revision=new`,
        ]);
    } finally {
        vi.useRealTimers();
    }
});

it("refuses a changing or vanished chat file without partial records, but treats initial chatGone as empty", async () => {
    vi.useFakeTimers();
    try {
        const contents = () =>
            Response.json({ revision: "r", pages: [{ id: "p" }], events: [], threads: [], runs: [] });
        const gone = () => Response.json({ reason: "chatGone" }, { status: 404 });
        authFetch.mockResolvedValueOnce(gone());
        expect(await readStructuredMemoryFile(ref)).toEqual({
            outcome: "ok",
            value: { rows: false, pages: [], events: [], threads: [] },
        });
        for (const disappearsAfterRestart of [false, true]) {
            authFetch
                .mockReset()
                .mockResolvedValueOnce(contents())
                .mockResolvedValueOnce(round("r", [page("partial")], [], null));
            if (disappearsAfterRestart) {
                authFetch
                    .mockResolvedValueOnce(Response.json({ reason: "changed" }, { status: 409 }))
                    .mockResolvedValueOnce(gone());
            } else {
                authFetch.mockResolvedValueOnce(gone());
            }
            expect(await readStructuredMemoryFile(ref)).toEqual({ outcome: "refused", reason: "chatGone" });
        }
        authFetch.mockReset();
        for (let attempt = 0; attempt < 3; attempt++) {
            authFetch
                .mockResolvedValueOnce(contents())
                .mockResolvedValueOnce(round("r", [page("partial")], [], null))
                .mockResolvedValueOnce(Response.json({ reason: "changed" }, { status: 409 }));
        }
        expect(await readStructuredMemoryFile(ref)).toEqual({ outcome: "refused", reason: "changed" });
        expect(authFetch).toHaveBeenCalledTimes(9);
    } finally {
        vi.useRealTimers();
    }
});

it("keeps the adoption reason on a receipt but restores the writer action after the choice", () => {
    const receipt = { state: "notAutomatic", reason: "awaitingAdoption" };
    expect(memoryReceiptView(receipt, { newest: true, taskLive: false })).toMatchObject({
        kind: "notAutomatic",
        reason: "awaitingAdoption",
        action: null,
    });
    for (const cadence of ["everyTurn", "manual"] as const) {
        const current = { memoryOn: true, cadence, paused: false, pendingRepairs: 0, receipt, taskLive: false };
        expect(memoryWriterNotice({ ...current, adoptionHeld: true })).toEqual({
            kind: "notAutomatic",
            reason: "awaitingAdoption",
            action: null,
        });
        expect(memoryWriterNotice({ ...current, adoptionHeld: true, paused: true })).toEqual({
            kind: "notAutomatic",
            reason: "awaitingAdoption",
            action: null,
        });
        expect(memoryWriterNotice({ ...current, adoptionHeld: false })).toEqual(
            cadence === "manual"
                ? { kind: "notAutomatic", reason: "manual", action: "record" }
                : { kind: null, action: "record" },
        );
    }
});

it("reads cost previews and durable run metadata and abandons through the epoch-bound chat endpoint", async () => {
    authFetch.mockImplementation(async (url, init) => {
        expect(new Headers(init?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
        if (url === `${base}/cost?mode=record&turns=2&through=reply%2F%EB%AC%B8`) {
            expect(init?.method ?? "GET").toBe("GET");
            return Response.json({ calls: 2, messages: 3, estimatedTokens: 4000 });
        }
        if (url === base)
            return Response.json({
                revision: "r1",
                pages: [],
                events: [],
                threads: [],
                runs: [],
                rebuild: { mode: "backfill", done: 2, total: 5, resumable: false, reason: "sourceReplaced" },
                recordedLanguage: "Korean",
            });
        if (url === `${base}/rebuild/abandon`) {
            expect(init?.method).toBe("POST");
            expect(init?.body).toBeUndefined();
            return Response.json({ revision: "r1", abandoned: true });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    expect(await readStructuredMemoryCost(ref, { mode: "record", turns: 2, through: "reply/문" })).toEqual({
        outcome: "ok",
        value: { calls: 2, messages: 3, estimatedTokens: 4000 },
    });
    expect(await readStructuredMemoryContents(ref)).toMatchObject({
        outcome: "ok",
        value: { recordedLanguage: "Korean", rebuild: { mode: "backfill", done: 2, total: 5, resumable: false } },
    });
    expect(await abandonStructuredMemoryRebuild(ref)).toEqual({
        outcome: "ok",
        value: { revision: "r1", abandoned: true },
    });
    authFetch.mockResolvedValue(Response.json({ calls: 2, messages: 3 }));
    expect((await readStructuredMemoryCost(ref, { mode: "backfill", turns: 1 })).outcome).toBe("failed");
});

it("reads test results of unknown shape and preserves custom prompt receipt and run details", () => {
    for (const value of [
        undefined,
        null,
        7,
        "text",
        [],
        {},
        { kind: "preview" },
        { kind: "memoryTest", outcome: "unknown" },
    ])
        expect(memoryTestResultView(value)).toBeNull();
    const result = memoryTestResultView({
        kind: "memoryTest",
        outcome: "failed",
        customPrompt: true,
        messageIds: ["m1", null, 2],
        patchCalled: true,
        analysis: { event: { title: "<b>Title</b>" } },
        patches: [{ body: "<script>text</script>" }],
        error: "Missing scene",
        slots: { analysis: { unquoted: ["rules", 1], unknown: ["typo"] }, patch: null },
        warnings: null,
        refused: [{ candidate: { targetId: "Gate" }, refusal: "lockedSection" }],
        unverified: null,
        inputTokens: 12,
        outputTokens: {},
    });
    expect(result).toMatchObject({
        outcome: "failed",
        customPrompt: true,
        messageIds: ["m1"],
        patchCalled: true,
        analysis: { event: { title: "<b>Title</b>" } },
        patches: [{ body: "<script>text</script>" }],
        error: "Missing scene",
        slots: { analysis: { unquoted: ["rules"], unknown: ["typo"] }, patch: { unquoted: [], unknown: [] } },
        warnings: [],
        refused: [{ candidate: "Gate", refusal: "lockedSection" }],
        unverified: [],
        inputTokens: 12,
        outputTokens: 0,
    });
    const receipt = { state: "failed", customPrompt: true, error: "Missing scene", reason: "customPromptInvalid" };
    expect(memoryReceiptView(receipt, { newest: true, taskLive: false })).toMatchObject({
        customPrompt: true,
        error: "Missing scene",
    });
    expect(memoryRunView({ customPrompt: true, error: "Missing scene", receipt })).toMatchObject({
        customPrompt: true,
        error: "Missing scene",
        reason: "customPromptInvalid",
    });
    expect(
        memoryReceiptView({ ...receipt, customPrompt: "true", error: 4 }, { newest: true, taskLive: false }),
    ).toMatchObject({ customPrompt: false });
    expect(memoryRunView({ customPrompt: "true" }).customPrompt).toBe(false);
});

it("renders the literal import fixtures with exact bodies, whitespace headings and key lines", () => {
    const body = '## x\n---\n```yaml\nid: "not metadata"\n```\n> quote\n';
    const p = page("place", body);
    p.sections[0].heading = "  Facts\t  and\n details  ";
    p.aliases = ["Port"];
    p.reshaped = true;
    const e = event("event", [anchored(0)], body);
    e.keyLines = [{ speaker: "  Captain\tName ", text: "one\n  two" }];
    e.openThreads = {
        add: [{ title: "Return", who: ["place"] }],
        close: ["t"],
        transitions: [{ threadId: "t", to: "done" }],
    };
    const threads = [
        {
            id: "t",
            title: "  Return\t soon  ",
            state: "done" as const,
            who: ["place"],
            openedBy: "event",
            closedBy: "event",
        },
    ];
    const files = [
        { path: memoryPagePath(p), text: renderMemoryPage(p) },
        { path: "timeline.md", text: renderMemoryTimeline([e], "r") },
        { path: "threads.md", text: renderMemoryThreads(threads, "r") },
    ];
    expect(files[1].text).toContain("packageVersion: 2\n");
    expect(files[2].text).toContain("packageVersion: 2\n");
    const fixture = new URL("../../../server/src/tests/fixtures/memoryPackage.json", import.meta.url);
    expect(files).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
    const { createdRevision, ...exportedEvent } = e;
    expect(parseMemoryPackage(files)).toEqual({
        pages: [{ ...p, history: [] }],
        events: [exportedEvent],
        threads,
        refusals: [],
    });
});

it("sends page tools and unzipped package files with the displayed revision and current epoch", async () => {
    const p = page("selected");
    authFetch.mockImplementation(async (url, init) => {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get(RESOURCE_EPOCH_HEADER)).toBe("epoch");
        if (url.endsWith("/page-tools")) {
            expect(JSON.parse(init!.body as string)).toEqual({
                revision: "displayed",
                tool: { kind: "merge", sourceId: "source", targetId: "selected" },
            });
            return Response.json({ revision: "saved", data: p });
        }
        expect(url).toBe(`${base}/import`);
        expect(JSON.parse(init!.body as string)).toEqual({
            revision: "empty",
            files: [
                { path: "timeline.md", text: "timeline text" },
                { path: "threads.md", text: "thread text" },
            ],
        });
        return Response.json({
            revision: "imported",
            imported: { pages: 0, events: 1, threads: 1 },
            refusals: [{ file: "bad.md", reason: "unreadable" }],
        });
    });
    expect(
        await structuredMemoryPageTool(ref, "displayed", { kind: "merge", sourceId: "source", targetId: "selected" }),
    ).toEqual({ outcome: "ok", value: { revision: "saved", data: p } });
    const zip = zipSync({ "timeline.md": strToU8("timeline text"), "threads.md": strToU8("thread text") });
    expect(await importStructuredMemoryPackage(ref, "empty", zip)).toEqual({
        outcome: "ok",
        value: {
            revision: "imported",
            imported: { pages: 0, events: 1, threads: 1 },
            refusals: [{ file: "bad.md", reason: "unreadable" }],
        },
    });
});

it("keeps citations above live screening and screening above runs and receipts without adding screened gaps", () => {
    const messages: Message[] = [
        { chatId: "cited", role: "char", data: "Cannot help: bad format" },
        { chatId: "refusal", role: "char", data: "Prefix CANNOT HELP: BAD FORMAT suffix" },
        {
            chatId: "format",
            role: "char",
            data: "Bad Format",
            generationInfo: {
                memory: {
                    state: "skipped",
                    reason: "writerPaused",
                    pages: [],
                    refused: [],
                    unverified: [],
                    warnings: [],
                },
            },
        },
        { chatId: "user", role: "user", data: "Cannot help: bad format" },
        { chatId: "latest", role: "char", data: "Answer" },
    ];
    const facts = {
        events: [{ id: "e", title: "Recorded", status: "active" as const, messageIds: ["cited"] }],
        runs: [{ id: "failed", result: "failed" as const, messageIds: ["refusal"] }],
    };
    const screening = { refusal: ["cannot help"], format: ["bad format"] };
    const join = () => joinMemoryCoverage(messages, facts, { windowTurns: 1, memoryOn: true, screening });
    const before = structuredClone(facts);
    expect(join().rows.map(({ state, reason }) => ({ state, reason }))).toEqual([
        { state: "covered", reason: undefined },
        { state: "excluded", reason: "screenedRefusal" },
        { state: "excluded", reason: "screenedFormat" },
        { state: "pending", reason: undefined },
        { state: "pending", reason: undefined },
    ]);
    expect(join()).toMatchObject({ gap: [], leaving: [0] });
    screening.refusal = [];
    expect(join().rows[1]).toMatchObject({ state: "excluded", reason: "screenedFormat" });
    messages[1].data = "Corrected answer";
    expect(join().rows[1]).toMatchObject({ state: "failed", runId: "failed" });
    expect(join().gap).toEqual([1]);
    expect(facts).toEqual(before);
});

it("prefers the current writer rule, clears old tab-bound warnings on null, and keeps receipt fallback when absent", () => {
    const current = {
        memoryOn: true,
        cadence: "everyTurn" as const,
        paused: false,
        pendingRepairs: 0,
        adoptionHeld: false,
        taskLive: false,
    };
    for (const reason of ["pluginModel", "requestTrigger"] as const) {
        const receipt = { state: "notAutomatic", reason };
        const other = reason === "pluginModel" ? "requestTrigger" : "pluginModel";
        expect(memoryWriterNotice({ ...current, receipt, writerBlockingReason: other })).toEqual({
            kind: "notAutomatic",
            reason: other,
            action: "record",
        });
        expect(memoryWriterNotice({ ...current, receipt, writerBlockingReason: null })).toEqual({
            kind: null,
            action: "record",
        });
        expect(memoryWriterNotice({ ...current, receipt })).toEqual({
            kind: "notAutomatic",
            reason,
            action: "record",
        });
        expect(memoryWriterNotice({ ...current, receipt: undefined, writerBlockingReason: reason })).toEqual({
            kind: "notAutomatic",
            reason,
            action: "record",
        });
    }
});
