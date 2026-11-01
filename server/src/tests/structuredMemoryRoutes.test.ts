// @vitest-environment node
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import type { MemoryEvent, MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createResourceTestClient, type TestServerOptions } from "./testSupport.ts";

const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(async () => {
    try {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    } finally {
        vi.useRealTimers();
    }
});

const characterId = "character/문";
const chatId = "chat/one";
const base = `/api/memory/structured/${encodeURIComponent(characterId)}/${encodeURIComponent(chatId)}`;
const chat: Chat = { name: "Story", note: "", localLore: [], message: [] };
const bytes = (record: unknown) => Buffer.byteLength(JSON.stringify(record), "utf8");
const page = (id: string, body = "문 😀"): MemoryPage => ({
    id,
    type: "location",
    title: `Place ${id}`,
    aliases: [],
    contextMode: "auto",
    sections: [{ heading: "Facts", body, provenance: [], sources: [], locked: false, updatedAt: 1 }],
    links: [],
    retrieval: { keywords: [] },
    history: [],
});
const event = (id: string, summary = "Event body"): MemoryEvent => ({
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
    sources: [],
    writerRun: "run",
    createdRevision: 1,
});

async function answer(response: Response, status = 200) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
}

async function server(options: TestServerOptions = {}) {
    const s = await createResourceTestClient(options);
    cleanups.push(() => s.close());
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    // The app does not export its store. A real writer on the same file seeds its read routes.
    const store = createResourceStore({ file: path.join(s.savePath, "data", "resources.sqlite"), kinds });
    cleanups.push(() => store.close());
    store.applyChanges({
        ops: [{ kind: kinds.get("characters")!, id: characterId, baseRevision: null, data: { chaId: characterId } }],
        chats: [chatId, "other"].map((id) => ({
            characterId,
            chatId: id,
            baseRevision: null,
            ops: [{ op: "create" as const, chat }],
        })),
    });
    const write = (changes: Parameters<typeof store.memory.write>[3]) =>
        store.memory.write(
            characterId,
            chatId,
            { epoch: s.epoch, baseRevision: store.memory.readContents(characterId, chatId)!.revision },
            changes,
        );
    return { ...s, store, write };
}

it("lists only this chat's metadata and reads every record kind exactly as stored", async () => {
    const s = await server();
    const p = page("page/one");
    const e = event("event/one");
    const thread: MemoryThread = { id: "thread/one", title: "Question", who: [p.id], state: "open" };
    const run: MemoryRun = {
        id: "run/one",
        window: [],
        model: "writer",
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 3,
        result: "recorded",
        input: "Private writer input",
    };
    const revision = s.write({ pages: [p], events: [e], threads: [thread], runs: [run] });
    s.store.memory.write(
        characterId,
        "other",
        { epoch: s.epoch, baseRevision: s.store.memory.readContents(characterId, "other")!.revision },
        { pages: [page("foreign", "Other chat's body")] },
    );
    expect(await answer(await s.request(base))).toEqual({
        revision,
        pages: [{ id: p.id, type: p.type, title: p.title, bytes: bytes(p) }],
        events: [{ id: e.id, title: e.title, status: e.status, bytes: bytes(e) }],
        threads: [{ id: thread.id, title: thread.title, state: thread.state, bytes: bytes(thread) }],
        runs: [{ id: run.id, result: run.result, bytes: bytes(run) }],
    });
    for (const [kind, record] of [
        ["pages", p],
        ["events", e],
        ["threads", thread],
        ["runs", run],
    ] as const) {
        expect(await answer(await s.request(`${base}/records/${kind}/${encodeURIComponent(record.id)}`))).toEqual({
            revision,
            data: record,
        });
    }
    expect(await answer(await s.request(`${base}/records/pages/foreign`), 404)).toMatchObject({ reason: "recordGone" });
});

it("budgets rounds by stored UTF-8 bytes, includes the first oversized record and sends pages before events", async () => {
    const pages = [page("a", "문😀".repeat(80)), page("b", "문😀".repeat(80)), page("large", "x".repeat(5000))];
    const budget = bytes(pages[0]) + bytes(pages[1]);
    const s = await server({ routeLimits: { memoryPackageRoundBytes: budget } });
    const events = [event("a"), event("b", "stale summary")];
    events[1].status = "stale";
    const revision = s.write({
        pages,
        events,
        threads: [{ id: "not-packaged", title: "Thread", who: [], state: "open" }],
        runs: [
            {
                id: "not-packaged",
                window: [],
                model: "writer",
                inputTokens: 0,
                outputTokens: 0,
                durationMs: 0,
                result: "failed",
            },
        ],
    });
    const round = (cursor?: number) =>
        s.request(
            `${base}/package${cursor === undefined ? "" : `?${new URLSearchParams({ cursor: String(cursor), revision })}`}`,
        );
    expect(await answer(await round())).toEqual({ revision, pages: pages.slice(0, 2), events: [], next: 2 });
    expect(await answer(await round(2))).toEqual({ revision, pages: [pages[2]], events: [], next: 3 });
    expect(await answer(await round(3))).toEqual({ revision, pages: [], events, next: null });
    expect(await answer(await round(100))).toEqual({ revision, pages: [], events: [], next: null });
    // One byte below the two-record boundary must leave the second page for the next round.
    const below = await server({ routeLimits: { memoryPackageRoundBytes: budget - 1 } });
    const belowRevision = below.write({ pages: pages.slice(0, 2) });
    expect(await answer(await below.request(`${base}/package`))).toEqual({
        revision: belowRevision,
        pages: [pages[0]],
        events: [],
        next: 1,
    });
});

it("rejects stale revisions, missing chats and records, invalid inputs and another or missing epoch without caching", async () => {
    const s = await server();
    const initial = s.store.memory.readContents(characterId, chatId)!.revision;
    expect(await answer(await s.request(`${base}/package`))).toEqual({
        revision: initial,
        pages: [],
        events: [],
        next: null,
    });
    const revision = s.write({ pages: [page("p")] });
    expect(
        await answer(
            await s.request(`${base}/package?${new URLSearchParams({ cursor: "0", revision: initial })}`),
            409,
        ),
    ).toMatchObject({ revision });
    const paths = [base, `${base}/records/pages/p`, `${base}/package`];
    for (const url of paths) {
        for (const epoch of ["another-epoch", null]) {
            expect(await answer(await s.request(url, {}, epoch), 412)).toEqual({
                error: "EpochMismatch",
                epoch: s.epoch,
            });
        }
        expect(await answer(await s.request(url.replace(encodeURIComponent(chatId), "absent")), 404)).toMatchObject({
            reason: "chatGone",
        });
        for (const id of [characterId, chatId]) {
            await answer(await s.request(url.replace(encodeURIComponent(id), "%00")), 400);
        }
    }
    expect(await answer(await s.request(`${base}/records/pages/absent`), 404)).toMatchObject({ reason: "recordGone" });
    await answer(await s.request(`${base}/records/pages/%00`), 400);
    await answer(await s.request(`${base}/records/unknown/p`), 400);
    for (const cursor of ["", "-1", "1.5", "NaN", "9007199254740992"]) {
        await answer(await s.request(`${base}/package?${new URLSearchParams({ cursor })}`), 400);
    }
});

it("authenticates and rate-limits all three read routes with no-store on refusals", async () => {
    // Reading the epoch uses the first of four requests in this frozen window.
    const s = await server({ routeLimits: { requestsPerMinute: 4 } });
    s.write({ pages: [page("p")] });
    const paths = [base, `${base}/records/pages/p`, `${base}/package`];
    for (const url of paths) {
        const response = await s.app.request(url, { headers: { "x-resource-epoch": s.epoch } });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(response.status).not.toBe(429);
    }
    for (const url of paths) {
        await answer(await s.request(url), 429);
    }
});

it("refuses all structured memory reads with no-store and 503 during shutdown", async () => {
    const s = await server();
    s.write({ pages: [page("p")] });
    s.context.beginShutdown();
    for (const url of [base, `${base}/records/pages/p`, `${base}/package`]) {
        await answer(await s.request(url), 503);
    }
});
