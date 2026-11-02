// @vitest-environment node
import path from "node:path";
import type http from "node:http";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { EventFeedFrame } from "../../../shared/events.ts";
import fs from "node:fs/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { ROUTE_TEMPLATES } from "../../../shared/diagnostics.ts";
import {
    ADOPTED_WRITER_RUN,
    isSealedHypaV3Data,
    memoryAnchorState,
    reconcileMemoryEvents,
    writerPaused,
    sealedHypaV3DataIntact,
    MEMORY_RUNS_ROUND_ROWS,
    MEMORY_REVISION_CHATS_MAX,
    STRUCTURED_MEMORY_LIMITS,
} from "../../../shared/structuredMemory.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope, memorySettingsFingerprint, memoryTokenPolicy } from "../jobs/jobScope.ts";
import type { StructuredMemoryTaskInput } from "../../../shared/jobs.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import type { MemoryEvent, MemoryPage, MemoryRun, MemoryThread } from "../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { messageSourceHash } from "../data/memoryStore.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { readRecordSet, rebuildChanges, rebuildSeed } from "../prompt/memory/structured/rebuild.ts";
import { reconcileEvents } from "../prompt/memory/structured/reconcile.ts";
import { changeSection, type PageChanges } from "../prompt/memory/structured/pages.ts";
import { memoryKinds, projectionHistory, writeMemory } from "./memoryFixtures.ts";
import { allowListenerOrigin, createResourceTestClient, type TestServerOptions } from "./testSupport.ts";

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

async function answer(response: Response, status = 200): Promise<any> {
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

async function inheritanceServer(branch: boolean) {
    const s = await server();
    const messages: Message[] = [
        { chatId: "early", role: "char", data: "The gate is closed." },
        { chatId: "late", role: "char", data: "The gate opens." },
    ];
    s.store.applyChanges({
        chats: [
            { id: "other", message: messages },
            { id: chatId, message: branch ? messages.slice(0, 1) : messages },
        ].map(({ id, message }) => ({
            characterId,
            chatId: id,
            baseRevision: s.store.chatRevision(characterId, id),
            ops: [{ op: "append" as const, anchor: { end: true as const }, messages: message }],
        })),
    });
    const events = messages.map((m, index) => ({
        ...event(m.chatId!),
        sources: [{ messageId: m.chatId!, index, hash: messageSourceHash(m) }],
    }));
    const changes: PageChanges = new Map();
    let p: MemoryPage = { ...page("gate"), sections: [] };
    events.forEach((e, index) => {
        changeSection(
            changes,
            p,
            { heading: "Facts", body: messages[index].data, kind: "change" },
            {
                eventId: e.id,
                sources: e.sources,
                at: index + 1,
                newId: () => `history-${index}`,
            },
        );
        p = changes.get(p.id)!.page;
    });
    // The source's event insert revision differs from the destination's first write.
    writeMemory(s.store, characterId, "other", { pages: [p] });
    writeMemory(s.store, characterId, "other", {
        pages: [p],
        events,
        threads: [{ id: "promise", title: "Return", who: ["gate"], state: "open", openedBy: "early" }],
        runs: [run("source-log", "recorded")],
    });
    return { ...s, events, p };
}

function memorySnapshot(s: Awaited<ReturnType<typeof server>>, id: string) {
    const contents = s.store.memory.readContents(characterId, id)!;
    return {
        contents,
        records: Object.fromEntries(
            memoryKinds.map((kind) => [
                kind,
                contents[kind].map(
                    ({ id: recordId }) => s.store.memory.readRecord(characterId, id, kind, recordId)!.data,
                ),
            ]),
        ),
    };
}

function storeAdoptionChat(s: Awaited<ReturnType<typeof server>>, hypaV3Data: unknown) {
    s.store.applyChanges({
        chats: [
            {
                characterId,
                chatId,
                baseRevision: s.store.chatRevision(characterId, chatId),
                ops: [
                    {
                        op: "replace",
                        chat: {
                            ...chat,
                            hypaV3Data: hypaV3Data as Chat["hypaV3Data"],
                            message: [
                                { chatId: "m0", role: "user", data: "Stored question" },
                                { chatId: "m1", role: "char", data: "Stored answer" },
                            ],
                        },
                    },
                ],
            },
        ],
    });
}

it("adopts stored summaries without a body or a new run, preserves the chat and its unsealed reads, and repeats without writing", async () => {
    const s = await server();
    const hypaV3Data = {
        summaries: [
            {
                text: `At 3.5 miles, we stopped. ${"Detail. ".repeat(150)}`,
                chatMemos: [null, "m1", "m0", "m1"],
                isImportant: true,
            },
            { text: "Lost evidence.", chatMemos: ["gone", "m1"], isImportant: false },
        ],
    };
    storeAdoptionChat(s, hypaV3Data);
    const failed = run("failed-before-adoption");
    const initial = s.write({ runs: [failed] });
    const stored = s.store.readChatSource(characterId, chatId);
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const ui = kinds.get("ui")!;
    const row = s.store.get(ui, "main")!;
    s.store.put(ui, "main", { ...(row.data as object), memoryAlgorithmType: "structuredMemory" }, row.revision);

    const result = await answer(await s.request(`${base}/adopt`, { method: "POST" }));
    expect(result).toEqual({ revision: expect.any(String), adopted: 2, stale: 1 });
    expect(result.revision).not.toBe(initial);
    const packed = await answer(await s.request(`${base}/package`));
    const [whole, stale] = packed.events as MemoryEvent[];
    const sources = stored.data!.message.map((m: Message, index: number) => ({
        messageId: m.chatId!,
        hash: messageSourceHash(m),
        index,
    }));
    expect(packed).toEqual({
        revision: result.revision,
        pages: [],
        events: [
            {
                ...event(whole.id, hypaV3Data.summaries[0].text),
                title: "At 3.5 miles, we stopped.",
                storyTime: { text: "" },
                sources,
                writerRun: ADOPTED_WRITER_RUN,
                createdRevision: 2,
                pinned: true,
            },
            {
                ...event(stale.id, "Lost evidence."),
                title: "Lost evidence.",
                storyTime: { text: "" },
                sources: [sources[1], { messageId: "gone", hash: null, index: null }],
                status: "stale",
                staleReason: "missing",
                writerRun: ADOPTED_WRITER_RUN,
                createdRevision: 2,
            },
        ],
        next: null,
    });
    expect(whole.id).not.toBe(stale.id);
    expect(reconcileMemoryEvents(packed.events, stored.data!.message, messageSourceHash)).toEqual(packed.events);
    expect(memorySnapshot(s, chatId).records.runs).toEqual([failed]);
    expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
    const read = await answer(await s.json("/api/resources/read", { chats: [{ characterId, id: chatId }] }));
    const overlay = s.store.readRefs([], { chats: [{ characterId, id: chatId }], memoryProjection: true });
    for (const data of [read.chats[0].data, overlay.chats[0].data]) {
        expect(data?.hypaV3Data).toEqual(hypaV3Data);
        expect(isSealedHypaV3Data(data?.hypaV3Data)).toBe(false);
    }
    const adopted = memorySnapshot(s, chatId);
    expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }))).toEqual({
        revision: result.revision,
        adopted: 0,
        stale: 0,
    });
    expect(memorySnapshot(s, chatId)).toEqual(adopted);
    expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
});

it("writes nothing when adoption finds an existing page, event, or thread", async () => {
    for (const existing of [
        { pages: [page("existing")] },
        { events: [event("existing")] },
        { threads: [{ id: "existing", title: "Return", who: [], state: "open" as const }] },
    ]) {
        const s = await server();
        storeAdoptionChat(s, { summaries: [{ text: "Adoptable.", chatMemos: ["m0", "m1"], isImportant: false }] });
        s.write(existing);
        const before = memorySnapshot(s, chatId);
        const stored = s.store.readChatSource(characterId, chatId);
        expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }))).toEqual({
            revision: before.contents.revision,
            adopted: 0,
            stale: 0,
        });
        expect(memorySnapshot(s, chatId)).toEqual(before);
        expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
    }
});

it("moves no memory revision when the stored chat has no adoptable summary text", async () => {
    const s = await server();
    for (const data of [
        undefined,
        { summaries: [] },
        { summaries: [{ text: " \n\t", chatMemos: ["m0"], isImportant: false }] },
    ]) {
        storeAdoptionChat(s, data);
        const before = memorySnapshot(s, chatId);
        const stored = s.store.readChatSource(characterId, chatId);
        expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }))).toEqual({
            revision: before.contents.revision,
            adopted: 0,
            stale: 0,
        });
        expect(memorySnapshot(s, chatId)).toEqual(before);
        expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
    }
});

it("refuses adoption for another epoch, a missing chat, or an invalid resource id without writing", async () => {
    const s = await server();
    storeAdoptionChat(s, { summaries: [{ text: "Adoptable.", chatMemos: ["m0"], isImportant: false }] });
    const before = memorySnapshot(s, chatId);
    const stored = s.store.readChatSource(characterId, chatId);
    expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }, "another-epoch"), 412)).toEqual({
        error: "EpochMismatch",
        epoch: s.epoch,
    });
    expect(
        await answer(
            await s.request(`${base.replace(encodeURIComponent(chatId), "absent")}/adopt`, { method: "POST" }),
            404,
        ),
    ).toMatchObject({ reason: "chatGone" });
    for (const id of [characterId, chatId]) {
        await answer(await s.request(`${base.replace(encodeURIComponent(id), "%00")}/adopt`, { method: "POST" }), 400);
    }
    expect(memorySnapshot(s, chatId)).toEqual(before);
    expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
});

it("fences adoption behind an admitted job and adopts after the fence falls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entered = deferred();
    const release = deferred();
    const s = await server({
        generationRunner: async (job) => {
            entered.resolve();
            await release.promise;
            job.emit({ type: "done", revision: job.context.chatRevision });
        },
    });
    storeAdoptionChat(s, { summaries: [{ text: "Adoptable.", chatMemos: ["m0", "m1"], isImportant: false }] });
    const context = bindChat(s);
    await answer(
        await s.json("/api/generations", {
            kind: "command",
            clientId: "tab",
            context,
            command: { type: "button", data: "" },
        }),
    );
    await entered.promise;
    const before = memorySnapshot(s, chatId);
    const stored = s.store.readChatSource(characterId, chatId);
    try {
        expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }), 409)).toMatchObject({
            reason: "fenced",
        });
        expect(memorySnapshot(s, chatId)).toEqual(before);
        expect(s.store.readChatSource(characterId, chatId)).toEqual(stored);
    } finally {
        release.resolve();
        await s.context.generationJobs.drain();
    }
    expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }))).toEqual({
        revision: expect.any(String),
        adopted: 1,
        stale: 0,
    });
});

it.each([false, true])(
    "inherits server records for branch=%s once, with no source runs or later branch body",
    async (branch) => {
        const s = await inheritanceServer(branch);
        const sourceBefore = memorySnapshot(s, "other");
        const initial = s.store.memory.readContents(characterId, chatId)!.revision;
        const inherited = await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }));
        expect(inherited).toEqual({ revision: expect.any(String), inherited: true });
        expect(inherited.revision).not.toBe(initial);
        const expectedPage = branch
            ? {
                  ...s.p,
                  sections: [
                      {
                          heading: "Facts",
                          body: "The gate is closed.",
                          provenance: ["early"],
                          sources: s.events[0].sources,
                          locked: false,
                          updatedAt: 2,
                      },
                  ],
                  history: [s.p.history[0]],
              }
            : s.p;
        expect(await answer(await s.request(`${base}/package`))).toEqual({
            revision: inherited.revision,
            pages: [expectedPage],
            events: (branch ? s.events.slice(0, 1) : s.events).map((e) => ({ ...e, createdRevision: 1 })),
            next: null,
        });
        expect(await answer(await s.request(`${base}/records/threads/promise`))).toEqual({
            revision: inherited.revision,
            data: { id: "promise", title: "Return", who: ["gate"], state: "open", openedBy: "early" },
        });
        expect(await answer(await s.request(`${base}/runs`))).toEqual({
            revision: inherited.revision,
            total: 0,
            runs: [],
            next: null,
        });
        expect(memorySnapshot(s, "other")).toEqual(sourceBefore);
        const copied = memorySnapshot(s, chatId);
        writeMemory(s.store, characterId, "other", { pages: [page("new-source-page")] });
        expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }))).toEqual({
            revision: inherited.revision,
            inherited: false,
        });
        expect(memorySnapshot(s, chatId)).toEqual(copied);
    },
);

it.each(memoryKinds)("writes nothing when the destination already holds only a %s row", async (kind) => {
    const s = await inheritanceServer(true);
    const records = {
        pages: [page("existing")],
        events: [event("existing")],
        threads: [{ id: "existing", title: "Existing", who: [], state: "paused" as const }],
        runs: [run("existing")],
    };
    s.write({ [kind]: records[kind] });
    const before = memorySnapshot(s, chatId);
    expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }))).toEqual({
        revision: before.contents.revision,
        inherited: false,
    });
    expect(memorySnapshot(s, chatId)).toEqual(before);
});

it("leaves an empty destination unchanged on an epoch refusal or missing source", async () => {
    const s = await inheritanceServer(true);
    const before = memorySnapshot(s, chatId);
    expect(
        await answer(
            await s.request(
                `${base}/inherit`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ sourceChatId: "other" }),
                },
                "old-epoch",
            ),
            412,
        ),
    ).toEqual({ error: "EpochMismatch", epoch: s.epoch });
    expect(memorySnapshot(s, chatId)).toEqual(before);
    expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "missing" }), 404)).toMatchObject({
        reason: "chatGone",
    });
    expect(memorySnapshot(s, chatId)).toEqual(before);
});

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
        adoption: { adoptable: 0, declined: false, resettable: false },
        rebuild: null,
        recordedLanguage: null,
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

/** What a budget test reads of a `/coverage` or `/runs` round. */
type RoundIds = { events: { id: string }[]; runs: { id: string }[]; next: number | null };

const run = (id: string, result: MemoryRun["result"] = "failed"): MemoryRun => ({
    id,
    result,
    window: [{ messageId: `message-${id}`, hash: "hash", index: 2 }],
    model: "writer",
    inputTokens: 11,
    outputTokens: 7,
    durationMs: 123,
    input: "Private message text",
    settingsFingerprint: "Private settings",
    error: "Private error text",
});

it("serves coverage facts in storage order without reading recorded runs or disclosing bodies", async () => {
    const s = await server();
    const active = { ...event("z"), sources: [{ messageId: "m1", hash: "h", index: 0 }] };
    const stale = {
        ...event("a"),
        status: "stale" as const,
        staleReason: "changed" as const,
        suppressed: true,
        sources: active.sources,
    };
    const failed = {
        ...run("z"),
        receipt: {
            state: "failed" as const,
            reason: "requestFailed",
            pages: [],
            refused: [],
            unverified: [],
            warnings: [],
        },
    };
    const skipped = {
        ...run("a", "skipped"),
        reason: "writerPaused",
        receipt: { ...failed.receipt, reason: "receiptFallback" },
    };
    const revision = s.write({
        events: [active, stale],
        runs: [run("recorded", "recorded"), failed, skipped, run("pending", "pending")],
    });
    // Poison a body the route must never read. The contents remain readable on the real database.
    const db = new DatabaseSync(path.join(s.savePath, "data", "resources.sqlite"));
    try {
        db.prepare("UPDATE memory_runs SET data = ? WHERE id = ?").run("invalid JSON", "recorded");
        expect(await answer(await s.request(`${base}/coverage`))).toEqual({
            revision,
            events: [
                {
                    id: "z",
                    title: "Event z",
                    status: "active",
                    messageIds: ["m1"],
                    sourceIndex: 0,
                    sources: active.sources,
                },
                {
                    id: "a",
                    title: "Event a",
                    status: "stale",
                    staleReason: "changed",
                    suppressed: true,
                    messageIds: ["m1"],
                    sourceIndex: 0,
                    sources: active.sources,
                },
            ],
            runs: [
                { id: "z", result: "failed", reason: "requestFailed", messageIds: ["message-z"] },
                { id: "a", result: "skipped", reason: "writerPaused", messageIds: ["message-a"] },
                { id: "pending", result: "pending", messageIds: ["message-pending"] },
            ],
            next: null,
        });
    } finally {
        db.close();
    }
});

it.each(["coverage", "runs"])(
    "budgets %s before reading bodies and serves the first oversized record",
    async (route) => {
        const s = await server({ routeLimits: { memoryPackageRoundBytes: 1 } });
        const revision = s.write({ events: [event("first")], runs: [run("older"), run("newer")] });
        const db = new DatabaseSync(path.join(s.savePath, "data", "resources.sqlite"));
        try {
            // This is the next round's body for both routes. Reading ahead would fail the current request.
            db.prepare("UPDATE memory_runs SET data = ? WHERE id = ?").run("invalid JSON", "older");
            const first = (await answer(await s.request(`${base}/${route}`))) as RoundIds;
            expect(first).toMatchObject({ revision, next: 1 });
            expect(route === "coverage" ? first.events.map(({ id }) => id) : first.runs.map(({ id }) => id)).toEqual([
                route === "coverage" ? "first" : "newer",
            ]);
            db.prepare("UPDATE memory_runs SET data = ? WHERE id = ?").run(JSON.stringify(run("older")), "older");
            const second = (await answer(
                await s.request(`${base}/${route}?${new URLSearchParams({ cursor: "1", revision })}`),
            )) as RoundIds;
            expect(second.runs.map(({ id }) => id)).toEqual(["older"]);
            expect(second.next).toBe(route === "coverage" ? 2 : null);
            if (route === "coverage") {
                expect(
                    await answer(await s.request(`${base}/coverage?${new URLSearchParams({ cursor: "2", revision })}`)),
                ).toMatchObject({ runs: [{ id: "newer" }], next: null });
            }
        } finally {
            db.close();
        }

        // A projected fact can fit even though its stored UTF-8 body cannot. Charge the latter.
        const largeEvent = event("first", "문😀".repeat(80));
        const largeRun = (id: string) => ({ ...run(id), input: "문😀".repeat(80) });
        const limit = bytes(route === "coverage" ? largeEvent : largeRun("newer")) + bytes(largeRun("older")) - 1;
        const bounded = await server({ routeLimits: { memoryPackageRoundBytes: limit } });
        const boundedRevision = bounded.write({ events: [largeEvent], runs: [largeRun("older"), largeRun("newer")] });
        const boundaryDb = new DatabaseSync(path.join(bounded.savePath, "data", "resources.sqlite"));
        try {
            // Same stored byte size, unreadable body: a read before budgeting is observable.
            boundaryDb
                .prepare("UPDATE memory_runs SET data = ? WHERE id = ?")
                .run("x".repeat(bytes(largeRun("older"))), "older");
            const first = (await answer(await bounded.request(`${base}/${route}`))) as RoundIds;
            expect(first).toMatchObject({ revision: boundedRevision, next: 1 });
            expect(route === "coverage" ? first.events.map(({ id }) => id) : first.runs.map(({ id }) => id)).toEqual([
                route === "coverage" ? "first" : "newer",
            ]);
        } finally {
            boundaryDb.close();
        }
    },
);

it("pages runs newest first with a row cap, total, and no input or settings fingerprint", async () => {
    const s = await server();
    const runs = Array.from({ length: MEMORY_RUNS_ROUND_ROWS + 2 }, (_, i) => run(`run-${i}`, "recorded"));
    const revision = s.write({ runs });
    const publicRuns = runs.map(({ input, settingsFingerprint, ...logged }) => logged).reverse();
    expect(await answer(await s.request(`${base}/runs`))).toEqual({
        revision,
        total: runs.length,
        runs: publicRuns.slice(0, MEMORY_RUNS_ROUND_ROWS),
        next: MEMORY_RUNS_ROUND_ROWS,
    });
    expect(
        await answer(
            await s.request(
                `${base}/runs?${new URLSearchParams({ cursor: String(MEMORY_RUNS_ROUND_ROWS), revision })}`,
            ),
        ),
    ).toEqual({ revision, total: runs.length, runs: publicRuns.slice(MEMORY_RUNS_ROUND_ROWS), next: null });
});

it.each(["coverage", "runs"])(
    "refuses invalid cursors, missing chats, stale revisions and epochs on %s",
    async (route) => {
        const s = await server();
        const initial = s.store.memory.readContents(characterId, chatId)!.revision;
        const revision = s.write({ runs: [run("r")] });
        for (const cursor of ["", "-1", "1.5", "NaN", "9007199254740992"]) {
            await answer(await s.request(`${base}/${route}?${new URLSearchParams({ cursor })}`), 400);
        }
        expect(
            await answer(
                await s.request(`${base}/${route}?${new URLSearchParams({ cursor: "1", revision: initial })}`),
                409,
            ),
        ).toEqual({ error: expect.any(String), revision });
        expect(
            await answer(await s.request(`${base.replace(encodeURIComponent(chatId), "gone")}/${route}`), 404),
        ).toMatchObject({ reason: "chatGone" });
        expect(await answer(await s.request(`${base}/${route}`, {}, "old-epoch"), 412)).toEqual({
            error: "EpochMismatch",
            epoch: s.epoch,
        });
    },
);

it("applies only a closed edit to stored evidence and records the replaced locked body", async () => {
    const s = await server();
    const original = page("p", "The gate was closed.");
    Object.assign(original.sections[0], {
        provenance: ["opening"],
        sources: [{ messageId: "m", hash: "kept-hash", index: 3 }],
        locked: true,
        unsupported: true,
        disputed: true,
    });
    original.history = [{ id: "prior", heading: "Facts", before: null, kind: "edit", highlighted: false, at: 1 }];
    let revision = s.write({ pages: [original] });
    const edited = await answer(
        await s.json(`${base}/edits`, {
            revision,
            edit: {
                kind: "section",
                pageId: "p",
                heading: "Facts",
                body: "The gate is open.",
                id: "forged",
                type: "scene",
                history: [],
                provenance: [],
                sources: [],
                locked: false,
                unsupported: false,
                eventId: "forged",
                sections: [],
            },
            data: { ...original, id: "forged" },
        }),
    );
    expect(edited.kind).toBe("pages");
    expect(edited.revision).not.toBe(revision);
    const { disputed: _disputed, ...kept } = original.sections[0];
    const expected = {
        ...original,
        sections: [{ ...kept, body: "The gate is open.", userCorrected: true, updatedAt: Date.now() }],
        history: [
            ...original.history,
            {
                id: expect.any(String),
                heading: "Facts",
                before: {
                    body: "The gate was closed.",
                    provenance: ["opening"],
                    sources: original.sections[0].sources,
                },
                kind: "edit",
                highlighted: false,
                at: Date.now(),
            },
        ],
    };
    expect(edited.data).toEqual(expected);
    expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({
        revision: edited.revision,
        data: expected,
    });
    expect((await answer(await s.request(base))).pages.map((row: MemoryPage) => row.id)).toEqual(["p"]);
    revision = edited.revision;
    for (const body of [" \n\t", "x".repeat(STRUCTURED_MEMORY_LIMITS.sectionBodyChars + 1)]) {
        await answer(
            await s.json(`${base}/edits`, { revision, edit: { kind: "section", pageId: "p", heading: "Facts", body } }),
            400,
        );
        expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({ revision, data: expected });
    }
});

it("refuses stale edits including no-ops without writing any record or revision", async () => {
    const s = await server();
    const p = page("p");
    const thread: MemoryThread = { id: "t", title: "Promise", who: [], state: "open" };
    const stale = s.write({ pages: [p], threads: [thread] });
    const current = s.write({ events: [event("new")] });
    const before = await answer(await s.request(base));
    for (const edit of [
        { kind: "section", pageId: "p", heading: "Facts", body: "A rejected correction" },
        { kind: "section", pageId: "p", heading: "Facts", body: p.sections[0].body },
        { kind: "sectionLock", pageId: "p", heading: "Facts", locked: false },
        { kind: "page", pageId: "p", contextMode: "auto" },
        { kind: "thread", threadId: "t", state: "open" },
    ]) {
        expect(await answer(await s.json(`${base}/edits`, { revision: stale, edit }), 409)).toMatchObject({
            revision: current,
        });
        expect(await answer(await s.request(base))).toEqual(before);
        expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({ revision: current, data: p });
        expect(await answer(await s.request(`${base}/records/threads/t`))).toEqual({ revision: current, data: thread });
    }
    const accepted = await answer(
        await s.json(`${base}/edits`, { revision: current, edit: { kind: "thread", threadId: "t", state: "paused" } }),
    );
    expect(accepted).toEqual({ revision: expect.any(String), kind: "threads", data: { ...thread, state: "paused" } });
    expect(accepted.revision).not.toBe(current);
    expect(await answer(await s.request(`${base}/records/threads/t`))).toEqual({
        revision: accepted.revision,
        data: accepted.data,
    });
});

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function bindChat(s: Awaited<ReturnType<typeof server>>, id = chatId) {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const first = (name: string) => (s.store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const binding = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    s.store.applyChanges({
        chats: [
            {
                characterId,
                chatId: id,
                baseRevision: s.store.chatRevision(characterId, id),
                ops: [
                    {
                        op: "meta",
                        set: {
                            promptPresetId: binding.presetId,
                            modelPresetId: binding.modelPresetId,
                            bindedPersona: binding.personaId,
                        },
                    },
                    {
                        op: "append",
                        anchor: { end: true },
                        messages: [
                            { chatId: "u", role: "user", data: "A gate." },
                            { chatId: "a", role: "char", data: "The gate opens." },
                            { chatId: "next", role: "user", data: "Continue." },
                        ],
                    },
                ],
            },
        ],
    });
    return {
        characterId,
        chatId: id,
        ...binding,
        chatRevision: s.store.chatRevision(characterId, id)!,
        mode: "normal" as const,
        input: "",
    };
}

it("refuses edits and inheritance while the real memory task is queued or running and accepts them after cancellation", async () => {
    // Hold tokenizer file I/O, not a task implementation; fake deadlines cannot race the test.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const s = await server({ memoryTaskOptions: { now: () => 0 } });
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    function replace<T>(name: string, update: (data: T) => T) {
        const kind = kinds.get(name)!;
        const record = s.store.get(kind, "main")!;
        s.store.put(kind, "main", update(record.data as T), record.revision);
    }
    replace<Record<string, unknown>>("ui", (data) => ({ ...data, memoryAlgorithmType: "structuredMemory" }));
    replace<Record<string, unknown>[]>("modelProfiles", (data) => [
        { ...data[0], modelId: "reverse_proxy", customTokenizer: "claude" },
    ]);
    replace<{ items: { settings: Record<string, unknown> }[] }>("hypaV3Presets", (data) => ({
        ...data,
        items: [{ ...data.items[0], settings: { ...data.items[0].settings, structured: { cadence: "tokens" } } }],
    }));
    const characterKind = kinds.get("characters")!;
    const owner = s.store.get(characterKind, characterId)!;
    s.store.put(characterKind, characterId, { ...(owner.data as object), supaMemory: true }, owner.revision);
    const context = bindChat(s);
    const scope = loadJobScope(s.store, kinds, context);
    const { presetId, modelPresetId, personaId } = context;
    const input: StructuredMemoryTaskInput = {
        kind: "structuredMemory",
        chatRef: { chaId: characterId, chatId },
        epoch: s.epoch,
        admittedRevision: scope.chatRevision,
        sourceGeneration: scope.chatSourceGeneration!,
        speakerId: null,
        binding: { presetId, modelPresetId, personaId },
        effective: { presetId, modelPresetId, fromChain: false },
        maxContext: 10000,
        maxResponse: 100,
        tokenPolicy: memoryTokenPolicy(scope, 3),
        settingsFingerprint: memorySettingsFingerprint(scope),
        confirmedBefore: "next",
    };
    const revision = s.write({ pages: [page("p")] });
    const before = await answer(await s.request(`${base}/records/pages/p`));
    const entered = deferred();
    const release = deferred();
    const access = fs.access;
    const spy = vi.spyOn(fs, "access").mockImplementation(async (...args) => {
        if (String(args[0]).endsWith("/claude/claude.json")) {
            entered.resolve();
            await release.promise;
        }
        return access(...args);
    });
    const tasks = s.context.memoryTasks!;
    const lease = await tasks.acquireSummaryWriter(input.chatRef, "hold-queue");
    const edit = { kind: "section", pageId: "p", heading: "Facts", body: "Correction after writer" };
    const refused = async () => {
        expect(await answer(await s.json(`${base}/edits`, { revision, edit }), 409)).toMatchObject({
            reason: "fenced",
        });
        expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual(before);
        expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }), 409)).toMatchObject({
            reason: "fenced",
        });
        expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual(before);
    };
    try {
        tasks.handOff(input);
        expect(tasks.status(input.chatRef)?.state).toBe("queued");
        await refused();
        lease.release();
        await entered.promise;
        expect(tasks.status(input.chatRef)?.state).toBe("running");
        await refused();
    } finally {
        tasks.cancel(input.chatRef);
        lease.release();
        release.resolve();
        await tasks.drain();
        spy.mockRestore();
    }
    expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }))).toEqual({
        revision,
        inherited: false,
    });
    expect((await answer(await s.json(`${base}/edits`, { revision, edit }))).data.sections[0].body).toBe(
        "Correction after writer",
    );
});

it("refuses edits and inheritance for an admitted job and for its message lock on a different chat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entered = deferred<RunningJob>();
    const release = deferred();
    const s = await server({
        generationRunner: async (job) => {
            entered.resolve(job);
            await release.promise;
            job.emit({ type: "done", revision: job.context.chatRevision });
        },
    });
    const context = bindChat(s);
    bindChat(s, "other");
    const revision = s.write({ pages: [page("p")] });
    const otherPath = base.replace(encodeURIComponent(chatId), "other");
    const otherRevision = s.store.memory.write(
        characterId,
        "other",
        {
            epoch: s.epoch,
            baseRevision: s.store.memory.readContents(characterId, "other")!.revision,
        },
        { pages: [page("p")] },
    );
    const edit = { kind: "sectionLock", pageId: "p", heading: "Facts", locked: true };
    await answer(
        await s.json("/api/generations", {
            kind: "command",
            clientId: "tab",
            context,
            command: { type: "button", data: "" },
        }),
    );
    const job = await entered.promise;
    try {
        expect(await answer(await s.json(`${base}/edits`, { revision, edit }), 409)).toMatchObject({
            reason: "fenced",
        });
        expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({ revision, data: page("p") });
        expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }), 409)).toMatchObject({
            reason: "fenced",
        });
        // A chat slot alone must not fence a sibling chat.
        await answer(await s.json(`${otherPath}/edits`, { revision: otherRevision, edit: { ...edit, locked: false } }));
        expect(await answer(await s.json(`${otherPath}/inherit`, { sourceChatId: chatId }))).toEqual({
            revision: otherRevision,
            inherited: false,
        });
        job.write(() => ({
            chats: [
                {
                    characterId,
                    chatId: "other",
                    baseRevision: s.store.chatRevision(characterId, "other"),
                    ops: [{ op: "begin", id: "a", generationId: "held" }],
                },
            ],
        }));
        expect(s.context.generationJobs.chatBusy(characterId, "other")).toBe(false);
        expect(await answer(await s.json(`${otherPath}/edits`, { revision: otherRevision, edit }), 409)).toMatchObject({
            reason: "fenced",
        });
        expect(await answer(await s.request(`${otherPath}/records/pages/p`))).toEqual({
            revision: otherRevision,
            data: page("p"),
        });
        expect(await answer(await s.json(`${otherPath}/inherit`, { sourceChatId: chatId }), 409)).toMatchObject({
            reason: "fenced",
        });
    } finally {
        release.resolve();
        await s.context.generationJobs.drain();
    }
    expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }))).toEqual({
        revision,
        inherited: false,
    });
    for (const [url, token] of [
        [base, revision],
        [otherPath, otherRevision],
    ])
        expect((await answer(await s.json(`${url}/edits`, { revision: token, edit }))).data.sections[0].locked).toBe(
            true,
        );
});

it("repairs events through revisioned edits and refuses abandoned keep states and ineligible rerecords", async () => {
    const s = await server();
    bindChat(s);
    const messages = (s.store.readChatSource(characterId, chatId).data as Chat).message;
    const e = {
        ...event("e"),
        sources: messages.slice(0, 2).map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) })),
    };
    const staleRevision = s.write({ events: [e] });
    let revision = s.write({ pages: [page("other")] });
    const writeMessages = (message: Message[]) =>
        s.store.applyChanges({
            chats: [
                {
                    characterId,
                    chatId,
                    baseRevision: s.store.chatRevision(characterId, chatId),
                    ops: [{ op: "replace", chat: { ...chat, message } }],
                },
            ],
        });
    const changed = messages.map((m) => (m.chatId === "a" ? { ...m, data: "The gate is closed" } : m));
    writeMessages(changed);
    const state = memoryAnchorState(e.sources, changed, messageSourceHash);
    const edit = (repair: "keep" | "retract" | "rerecord") => ({
        kind: "event",
        eventId: "e",
        repair,
        ...(repair === "keep" ? { state } : {}),
    });
    for (const repair of ["keep", "retract", "rerecord"] as const) {
        expect(
            await answer(await s.json(`${base}/edits`, { revision: staleRevision, edit: edit(repair) }), 409),
        ).toMatchObject({ revision });
        expect(s.store.memory.readRecord(characterId, chatId, "events", "e")).toEqual({ revision, data: e });
    }
    writeMessages(messages.map((m) => (m.chatId === "a" ? { ...m, data: "Changed once more" } : m)));
    expect(await answer(await s.json(`${base}/edits`, { revision, edit: edit("keep") }), 409)).toMatchObject({
        reason: "changed",
    });
    expect(s.store.memory.readRecord(characterId, chatId, "events", "e")).toEqual({ revision, data: e });
    writeMessages(changed);
    const kept = await answer(await s.json(`${base}/edits`, { revision, edit: edit("keep") }));
    expect(kept).toEqual({ revision: expect.any(String), kind: "events", data: { ...e, keptState: state } });
    revision = kept.revision;
    expect(reconcileEvents([kept.data], changed)[0].status).toBe("active");
    expect(
        reconcileEvents(
            [kept.data],
            changed.map((m) => ({ ...m, data: `${m.data}!` })),
        )[0].status,
    ).toBe("stale");
    writeMessages([changed[1], changed[0], changed[2]]);
    await answer(await s.json(`${base}/edits`, { revision, edit: edit("rerecord") }), 400);
    writeMessages(changed);
    const marked = await answer(await s.json(`${base}/edits`, { revision, edit: edit("rerecord") }));
    expect(marked.data).toEqual({ ...kept.data, rerecord: true });
    const retired = await answer(await s.json(`${base}/edits`, { revision: marked.revision, edit: edit("retract") }));
    expect(retired.data).toEqual({ ...kept.data, status: "retracted" });
    for (const repair of ["keep", "rerecord"] as const)
        await answer(await s.json(`${base}/edits`, { revision: retired.revision, edit: edit(repair) }), 400);
    expect(s.store.memory.readRecord(characterId, chatId, "events", "e")).toEqual({
        revision: retired.revision,
        data: retired.data,
    });
});

it("retracts cited events on a confirmed delete or panel repair and only flags sections with exclusively retracted provenance", async () => {
    for (const action of ["delete", "repair"] as const) {
        const s = await server();
        bindChat(s);
        const messages = (s.store.readChatSource(characterId, chatId).data as Chat).message;
        const cited = {
            ...event("cited"),
            rerecord: true,
            sources: messages
                .slice(0, 2)
                .map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) })),
        };
        const p = page("facts", "The user's current body");
        p.history = [
            {
                id: "earlier",
                heading: "Fact 0",
                kind: "change",
                highlighted: false,
                at: 0,
                eventId: "cited",
                before: { body: "The previous body must not return", provenance: [], sources: [] },
            },
        ];
        p.sections = [["cited"], ["cited", "active"], [], ["cited", "unknown"]].map((provenance, index) => ({
            ...p.sections[0],
            heading: `Fact ${index}`,
            provenance,
            sources: cited.sources,
            locked: true,
            userCorrected: true,
        }));
        const revision = s.write({ events: [cited, event("active")], pages: [p] });
        if (action === "delete") {
            await answer(
                await s.json("/api/resources/batch", {
                    chats: [
                        {
                            characterId,
                            chatId,
                            baseRevision: s.store.chatRevision(characterId, chatId),
                            ops: [{ op: "remove", ids: ["a"], retract: true }],
                        },
                    ],
                }),
            );
            expect(
                (s.store.readChatSource(characterId, chatId).data as Chat).message.map(({ chatId }) => chatId),
            ).toEqual(["u", "next"]);
        } else {
            await answer(
                await s.json(`${base}/edits`, {
                    revision,
                    edit: { kind: "event", eventId: "cited", repair: "retract" },
                }),
            );
        }
        const { rerecord, ...retired } = cited;
        expect((await answer(await s.request(`${base}/records/events/cited`))).data, action).toEqual({
            ...retired,
            status: "retracted",
        });
        expect((await answer(await s.request(`${base}/records/pages/facts`))).data, action).toEqual({
            ...p,
            sections: [{ ...p.sections[0], unsupported: true }, ...p.sections.slice(1)],
        });
    }
});

it("marks text and role edits for re-recording, ignores generation info and translations, and leaves unasked deletes missing", async () => {
    const s = await server();
    bindChat(s);
    const messages = (s.store.readChatSource(characterId, chatId).data as Chat).message;
    const original = {
        ...event("cited"),
        sources: [{ messageId: "a", index: 1, hash: messageSourceHash(messages[1]) }],
    };
    const batch = async (ops: ChatOp[]) =>
        answer(
            await s.json("/api/resources/batch", {
                chats: [{ characterId, chatId, baseRevision: s.store.chatRevision(characterId, chatId), ops }],
            }),
        );
    for (const op of [
        { op: "setText", id: "a", text: "Edited text" },
        { op: "setMessage", message: { ...messages[1], data: "Replaced text" } },
        { op: "patchMessage", id: "a", set: { role: "user" } },
    ] satisfies ChatOp[]) {
        await batch([{ op: "setMessage", message: messages[1] }]);
        const revision = s.write({ events: [original] });
        await batch([
            { op: "patchMessage", id: "a", set: { generationInfo: { model: "writer" } } },
            {
                op: "setTranslation",
                id: "a",
                translation: {
                    text: "문이 열린다",
                    sourceHash: translationSourceHash(messages[1].data),
                    targetLanguage: "ko",
                    translatedAt: 1,
                },
            },
        ]);
        expect((s.store.readChatSource(characterId, chatId).data as Chat).message[1]).toMatchObject({
            generationInfo: { model: "writer" },
            translation: { text: "문이 열린다" },
        });
        expect(s.store.memory.readRecord(characterId, chatId, "events", original.id)).toEqual({
            revision,
            data: original,
        });
        await batch([op]);
        expect(s.store.memory.readRecord(characterId, chatId, "events", original.id)!.data).toEqual({
            ...original,
            rerecord: true,
        });
    }
    s.write({ events: [original] });
    const before = s.store.memory.readContents(characterId, chatId);
    await batch([{ op: "remove", ids: ["a"] }]);
    expect(s.store.memory.readContents(characterId, chatId)).toEqual(before);
    const stored = s.store.memory.readRecord(characterId, chatId, "events", original.id)!.data;
    expect(stored).toEqual(original);
    expect(
        reconcileEvents([stored], (s.store.readChatSource(characterId, chatId).data as Chat).message)[0],
    ).toMatchObject({ status: "stale", staleReason: "missing" });
});

it("fences every event repair behind an admitted job without changing memory", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entered = deferred<RunningJob>();
    const release = deferred();
    const s = await server({
        generationRunner: async (job) => {
            entered.resolve(job);
            await release.promise;
            job.emit({ type: "done", revision: job.context.chatRevision });
        },
    });
    const context = bindChat(s);
    const e = event("e");
    const revision = s.write({ events: [e] });
    await answer(
        await s.json("/api/generations", {
            kind: "command",
            clientId: "tab",
            context,
            command: { type: "button", data: "" },
        }),
    );
    await entered.promise;
    try {
        for (const repair of ["keep", "rerecord", "retract"]) {
            expect(
                await answer(
                    await s.json(`${base}/edits`, {
                        revision,
                        edit: { kind: "event", eventId: "e", repair, state: "seen" },
                    }),
                    409,
                ),
            ).toMatchObject({ reason: "fenced" });
            expect(s.store.memory.readRecord(characterId, chatId, "events", "e")).toEqual({ revision, data: e });
        }
    } finally {
        release.resolve();
        await s.context.generationJobs.drain();
    }
    expect(
        (
            await answer(
                await s.json(`${base}/edits`, { revision, edit: { kind: "event", eventId: "e", repair: "retract" } }),
            )
        ).data.status,
    ).toBe("retracted");
});

it("restores chat file records on another store with active whole events, an empty Log and no pause", async () => {
    const source = await server();
    const destination = await server();
    bindChat(source);
    const original = source.store.readChatSource(characterId, chatId).data as Chat;
    const sources = original.message.map((m, index) => ({ messageId: m.chatId!, index, hash: messageSourceHash(m) }));
    const p = page("place", "The gate opens. Nothing in this page may be lost.");
    p.sections[0].sources = sources;
    p.sections[0].provenance = ["arrival"];
    const e = { ...event("arrival"), sources, rerecord: true, keptState: "source-kept-state" };
    const threads: MemoryThread[] = [
        { id: "return", title: "Return to the gate", who: [p.id], state: "open", openedBy: e.id },
    ];
    source.write({ pages: [p] });
    source.write({ pages: [p], events: [e], threads, runs: Array.from({ length: 5 }, (_, i) => run(`private-${i}`)) });
    const sourceBefore = memorySnapshot(source, chatId);
    const packed = await answer(await source.request(`${base}/package`));
    const threaded = await answer(
        await source.request(`${base}/threads?revision=${encodeURIComponent(packed.revision)}&cursor=0`),
    );
    const file = JSON.parse(
        JSON.stringify({
            type: "risuChat",
            ver: 2,
            data: original,
            structuredMemory: [{ chatId, pages: packed.pages, events: packed.events, threads: threaded.threads }],
        }),
    );
    // Script the import's new chat id and preserve its message ids on a separate destination store.
    const importedId = "imported-on-another-server";
    await answer(
        await destination.json("/api/resources/batch", {
            chats: [
                {
                    characterId,
                    chatId: importedId,
                    baseRevision: null,
                    ops: [{ op: "create", chat: { ...file.data, id: importedId } }],
                },
            ],
        }),
    );
    const importedBase = `/api/memory/structured/${encodeURIComponent(characterId)}/${importedId}`;
    const restored = await answer(await destination.json(`${importedBase}/restore`, file.structuredMemory[0]));
    expect(restored.restored).toBe(true);
    const restoredPackage = await answer(await destination.request(`${importedBase}/package`));
    const expectedEvent = { ...event("arrival"), sources, keptState: "source-kept-state", createdRevision: 1 };
    expect(restoredPackage).toEqual({ revision: restored.revision, pages: [p], events: [expectedEvent], next: null });
    expect((await answer(await destination.request(`${importedBase}/threads`))).threads).toEqual(threads);
    const imported = destination.store.readChatSource(characterId, importedId).data as Chat;
    expect(imported.message).toEqual(original.message);
    expect(reconcileMemoryEvents(restoredPackage.events, imported.message, messageSourceHash)).toEqual([expectedEvent]);
    const log = await answer(await destination.request(`${importedBase}/runs`));
    expect(log).toEqual({ revision: restored.revision, runs: [], total: 0, next: null });
    expect(writerPaused(log.runs)).toBe(false);
    expect(memorySnapshot(source, chatId)).toEqual(sourceBefore);
});

it("restores only empty chats, never writes supplied runs, and refuses malformed records atomically", async () => {
    const s = await server();
    const records = {
        pages: [page("p")],
        events: [{ ...event("e"), createdRevision: 99, rerecord: true, keptState: "kept" }],
        threads: [{ id: "t", title: "Return", who: [], state: "open" as const }],
    };
    const empty = memorySnapshot(s, chatId);
    const malformed = {
        ...records,
        pages: [{ ...records.pages[0], sections: [{ ...records.pages[0].sections[0], provenance: [null] }] }],
    };
    await answer(await s.json(`${base}/restore`, malformed), 400);
    expect(memorySnapshot(s, chatId)).toEqual(empty);
    const accepted = await answer(await s.json(`${base}/restore`, { ...records, runs: [run("private")] }));
    expect(accepted.restored).toBe(true);
    expect(memorySnapshot(s, chatId).records).toEqual({
        ...records,
        events: [{ ...event("e"), createdRevision: 1, keptState: "kept" }],
        runs: [],
    });
    for (const existing of [
        { pages: [page("existing")] },
        { events: [event("existing")] },
        { threads: [records.threads[0]] },
        { runs: [run("existing")] },
    ]) {
        const occupied = await server();
        occupied.write(existing);
        const before = memorySnapshot(occupied, chatId);
        expect(await answer(await occupied.json(`${base}/restore`, records))).toEqual({
            revision: before.contents.revision,
            restored: false,
        });
        expect(memorySnapshot(occupied, chatId)).toEqual(before);
    }
});

it("caps restore bodies using the app's memory restore limit without writing a partial record", async () => {
    const s = await server({ routeLimits: { memoryRestoreBodyBytes: 512 } });
    const before = memorySnapshot(s, chatId);
    await answer(
        await s.json(`${base}/restore`, { pages: [page("large", "x".repeat(1024))], events: [], threads: [] }),
        413,
    );
    expect(memorySnapshot(s, chatId)).toEqual(before);
    expect(
        (
            await answer(
                await s.json(`${base}/restore`, {
                    pages: [],
                    events: [],
                    threads: [{ id: "small", title: "Return", who: [], state: "open" }],
                }),
            )
        ).restored,
    ).toBe(true);
});

it("fences restore behind an admitted job and accepts the same records after it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const entered = deferred();
    const release = deferred();
    const s = await server({
        generationRunner: async (job) => {
            entered.resolve();
            await release.promise;
            job.emit({ type: "done", revision: job.context.chatRevision });
        },
    });
    const context = bindChat(s);
    const records = { pages: [page("p")], events: [], threads: [] };
    const before = memorySnapshot(s, chatId);
    await answer(
        await s.json("/api/generations", {
            kind: "command",
            clientId: "tab",
            context,
            command: { type: "button", data: "" },
        }),
    );
    await entered.promise;
    try {
        expect(await answer(await s.json(`${base}/restore`, records), 409)).toMatchObject({ reason: "fenced" });
        expect(memorySnapshot(s, chatId)).toEqual(before);
    } finally {
        release.resolve();
        await s.context.generationJobs.drain();
    }
    expect((await answer(await s.json(`${base}/restore`, records))).restored).toBe(true);
});

it("reads whole threads in revision-bound byte rounds and refuses a stale continuation", async () => {
    const threads: MemoryThread[] = [
        { id: "a", title: "문😀".repeat(80), who: [], state: "open" },
        { id: "b", title: "문😀".repeat(80), who: [], state: "paused" },
        { id: "c", title: "x".repeat(5000), who: [], state: "done", openedBy: "event" },
    ];
    const s = await server({ routeLimits: { memoryPackageRoundBytes: bytes(threads[0]) + bytes(threads[1]) } });
    const revision = s.write({ threads });
    expect(await answer(await s.request(`${base}/threads`))).toEqual({
        revision,
        threads: threads.slice(0, 2),
        next: 2,
    });
    const continuation = `${base}/threads?cursor=2&revision=${encodeURIComponent(revision)}`;
    expect(await answer(await s.request(continuation))).toEqual({ revision, threads: [threads[2]], next: null });
    s.write({ threads: [{ ...threads[2], state: "cancelled" }] });
    await answer(await s.request(continuation), 409);
});

it("projects reconciled memory on every full resource route while jobs and checkpoints read stored fields", async () => {
    const s = await server();
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const ui = kinds.get("ui")!;
    const row = s.store.get(ui, "main")!;
    s.store.put(ui, "main", { ...(row.data as object), memoryAlgorithmType: "structuredMemory" }, row.revision);
    const history = projectionHistory();
    s.store.applyChanges({
        chats: [
            {
                characterId,
                chatId,
                baseRevision: s.store.chatRevision(characterId, chatId),
                ops: [{ op: "replace", chat: { ...chat, message: history.messages } }],
            },
        ],
    });
    s.write({ events: history.events });
    const context = bindChat(s);
    const readChats = await answer(
        await s.request("/api/resources/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chats: [{ characterId, id: chatId }] }),
        }),
    );
    const collections = await answer(
        await s.request("/api/resources/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chatCollections: [characterId] }),
        }),
    );
    const all = await answer(await s.request("/api/resources?kinds=characters&chats=1"));
    for (const read of [readChats.chats, collections.chatCollections[0].chats, all.chats]) {
        const value = read.find((entry: { id: string }) => entry.id === chatId).data.hypaV3Data;
        expect(sealedHypaV3DataIntact(value)).toBe(true);
        const { structuredMemoryProjection: _seal, structuredMemoryRevision: _revision, ...data } = value;
        expect(data).toEqual(history.expected);
    }
    expect(s.store.readChatSource(characterId, chatId).data).not.toHaveProperty("hypaV3Data");
    expect(s.store.readRefs([], { chats: [{ characterId, id: chatId }] }).chats[0].data).not.toHaveProperty(
        "hypaV3Data",
    );
    expect(loadJobScope(s.store, kinds, context).db.characters[0].chats[0]).not.toHaveProperty("hypaV3Data");
    const saved = s.store.checkpoints.save(characterId, chatId, "Stored fields", "manual")!;
    expect(s.store.checkpoints.compose(characterId, chatId, saved.id)).not.toHaveProperty("hypaV3Data");
    expect(s.store.memory.readRecord(characterId, chatId, "events", "changed")!.data).toMatchObject({
        status: "active",
    });
});

it("projects only when the selected algorithm, events, and stored summary ownership permit it", async () => {
    const s = await server();
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const history = projectionHistory();
    const real = { summaries: [{ text: "Owned by HypaV3", chatMemos: [], isImportant: false }] };
    for (const [id, hypaV3Data, events] of [
        [chatId, undefined, true],
        ["empty", { summaries: [] }, true],
        ["owned", real, true],
        ["no-events", { summaries: [] }, false],
    ] as const) {
        const revision = s.store.chatRevision(characterId, id);
        s.store.applyChanges({
            chats: [
                {
                    characterId,
                    chatId: id,
                    baseRevision: revision,
                    ops: [
                        {
                            op: revision ? "replace" : "create",
                            chat: { ...chat, message: history.messages, ...(hypaV3Data ? { hypaV3Data } : {}) },
                        },
                    ],
                },
            ],
        });
        if (events) writeMemory(s.store, characterId, id, { events: history.events });
    }
    for (const algorithm of ["hypaV3", "structuredMemory"]) {
        const ui = kinds.get("ui")!;
        const row = s.store.get(ui, "main")!;
        s.store.put(ui, "main", { ...(row.data as object), memoryAlgorithmType: algorithm }, row.revision);
        const body = await answer(
            await s.request("/api/resources/read", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chatCollections: [characterId] }),
            }),
        );
        const data = (id: string) => body.chatCollections[0].chats.find((c: { id: string }) => c.id === id).data;
        expect(data("owned").hypaV3Data).toEqual(real);
        expect(data("no-events").hypaV3Data).toEqual({ summaries: [] });
        if (algorithm === "hypaV3") {
            expect(data(chatId)).not.toHaveProperty("hypaV3Data");
            expect(data("empty").hypaV3Data).toEqual({ summaries: [] });
        } else {
            for (const id of [chatId, "empty"])
                expect(data(id).hypaV3Data).toMatchObject({ summaries: history.expected.summaries });
        }
    }
});

it("answers the same revision-sealed reconciled projection as a whole read, including all-retracted and no-projection states", async () => {
    const s = await server();
    const ui = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("ui")!;
    s.store.put(ui, "main", { memoryAlgorithmType: "structuredMemory" }, s.store.get(ui, "main")!.revision);
    const history = projectionHistory();
    s.store.applyChanges({
        chats: [
            {
                characterId,
                chatId,
                baseRevision: s.store.chatRevision(characterId, chatId),
                ops: [{ op: "replace", chat: { ...chat, message: history.messages } }],
            },
        ],
    });
    const revisions = () => s.json("/api/memory/structured/revisions", { chats: [{ characterId, chatId }] });
    const whole = async () => {
        const body = await answer(await s.json("/api/resources/read", { chats: [{ characterId, id: chatId }] }));
        return body.chats[0].data.hypaV3Data;
    };
    const first = s.write({ events: history.events });
    expect(await answer(await revisions())).toEqual({ revisions: [first] });
    const projected = await answer(await s.request(`${base}/projection`));
    expect(projected.revision).toBe(first);
    expect(projected.hypaV3Data).toEqual(await whole());
    expect(projected.hypaV3Data).toEqual({
        ...history.expected,
        structuredMemoryRevision: first,
        structuredMemoryProjection: expect.any(String),
    });
    expect(sealedHypaV3DataIntact(projected.hypaV3Data)).toBe(true);
    const second = s.write({ events: history.events.map((entry) => ({ ...entry, status: "retracted" as const })) });
    expect(await answer(await revisions())).toEqual({ revisions: [second] });
    const empty = await answer(await s.request(`${base}/projection`));
    expect(empty.hypaV3Data).toMatchObject({ summaries: [], structuredMemoryRevision: second });
    expect(sealedHypaV3DataIntact(empty.hypaV3Data)).toBe(true);
    expect(empty.hypaV3Data).toEqual(await whole());
    s.write({ remove: { events: history.events.map(({ id }) => id) } });
    expect(await answer(await revisions())).toEqual({ revisions: [null] });
    expect(await answer(await s.request(`${base}/projection`))).toMatchObject({ hypaV3Data: null });
    expect(await whole()).toBeUndefined();
});

it("authenticates, limits, epoch-checks and validates both projection refresh routes", async () => {
    const s = await server();
    const revisions = "/api/memory/structured/revisions";
    const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chats: [{ characterId, chatId }] }),
    };
    for (const [url, options] of [
        [revisions, init],
        [`${base}/projection`, { headers: {} }],
    ] as const) {
        const denied = await s.app.request(url, {
            ...options,
            headers: { ...options.headers, "x-resource-epoch": s.epoch },
        });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(denied.status).toBeLessThan(500);
        expect(denied.status).not.toBe(429);
        for (const epoch of [null, "wrong-epoch"]) await answer(await s.request(url, options, epoch), 412);
    }
    for (const bad of ["", "\u0000", 12]) {
        for (const field of ["characterId", "chatId"]) {
            await answer(await s.json(revisions, { chats: [{ characterId, chatId, [field]: bad }] }), 400);
        }
    }
    for (const id of [characterId, chatId])
        await answer(await s.request(`${base}/projection`.replace(encodeURIComponent(id), "%00")), 400);
    await answer(
        await s.json(revisions, {
            chats: Array.from({ length: MEMORY_REVISION_CHATS_MAX + 1 }, () => ({ characterId: "c", chatId: "k" })),
        }),
        400,
    );
    expect(ROUTE_TEMPLATES).toContain(revisions);
    expect(ROUTE_TEMPLATES).toContain("/api/memory/structured/:characterId/:chatId/projection");
    // Epoch read consumes one request; these two consume the remainder of the frozen window.
    const limited = await server({ routeLimits: { requestsPerMinute: 3 } });
    await answer(await limited.request(revisions, init));
    await answer(await limited.request(`${base}/projection`));
    await answer(await limited.request(revisions, init), 429);
    await answer(await limited.request(`${base}/projection`), 429);
});

it("refuses projection event bytes over the round cap before reading any message", async () => {
    const input = event("large", "x".repeat(1000));
    const s = await server({ routeLimits: { memoryPackageRoundBytes: bytes(input) - 1 } });
    const ui = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("ui")!;
    s.store.put(ui, "main", { memoryAlgorithmType: "structuredMemory" }, s.store.get(ui, "main")!.revision);
    s.write({ events: [input] });
    const messages: string[] = [];
    const spies = (["get", "all", "iterate"] as const).map((method) => {
        const original = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
            this: StatementSync,
            ...args: unknown[]
        ) {
            if (/\bmessages\b/.test(this.sourceSQL)) messages.push(this.sourceSQL);
            return Reflect.apply(original, this, args);
        });
    });
    try {
        expect(await answer(await s.request(`${base}/projection`), 413)).toMatchObject({ reason: "tooLarge" });
        expect(messages).toEqual([]);
    } finally {
        spies.forEach((spy) => spy.mockRestore());
    }
});

it("declines once, stops offering adoption, refuses later adoption and preserves real summaries and projection reads", async () => {
    const s = await server();
    const ui = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("ui")!;
    const current = s.store.get(ui, "main")!;
    s.store.put(ui, "main", { ...(current.data as object), memoryAlgorithmType: "structuredMemory" }, current.revision);
    const summaries = { summaries: [{ text: "Keep this old memory.", chatMemos: ["m0", "m1"], isImportant: false }] };
    storeAdoptionChat(s, summaries);
    const before = memorySnapshot(s, chatId);
    const chatBefore = s.store.readChatSource(characterId, chatId);
    expect((await answer(await s.request(base))).adoption).toEqual({
        adoptable: 1,
        declined: false,
        resettable: false,
    });
    const declined = await answer(await s.request(`${base}/decline`, { method: "POST" }));
    const revision = before.contents.revision.replace(/:0$/, ":1");
    expect(declined).toEqual({ revision, declined: true });
    expect((await answer(await s.request(base))).adoption).toEqual({ adoptable: 0, declined: true, resettable: false });
    const after = memorySnapshot(s, chatId);
    expect(after.records).toEqual(before.records);
    expect(await answer(await s.request(`${base}/decline`, { method: "POST" }))).toEqual({ revision, declined: false });
    expect(await answer(await s.request(`${base}/adopt`, { method: "POST" }))).toEqual({
        revision,
        adopted: 0,
        stale: 0,
    });
    expect(memorySnapshot(s, chatId)).toEqual(after);
    expect(s.store.readChatSource(characterId, chatId)).toEqual(chatBefore);
    expect(
        await answer(await s.json("/api/memory/structured/revisions", { chats: [{ characterId, chatId }] })),
    ).toEqual({ revisions: [null] });
    expect(await answer(await s.request(`${base}/projection`))).toEqual({ revision, hypaV3Data: null });
    const read = await answer(await s.json("/api/resources/read", { chats: [{ characterId, id: chatId }] }));
    expect(read.chats[0].data.hypaV3Data).toEqual(summaries);
});

it("carries a decline through copies and branches even without crossing records, once only", async () => {
    for (const mode of ["copy", "branch", "no source records", "no supported records"] as const) {
        const s = mode === "no source records" ? await server() : await inheritanceServer(mode !== "copy");
        writeMemory(s.store, characterId, "other", { adoptionDeclined: true });
        if (mode === "no supported records")
            writeMemory(s.store, characterId, "other", { remove: { pages: ["gate"], threads: ["promise"] } });
        storeAdoptionChat(s, { summaries: [{ text: "Old memory", chatMemos: [], isImportant: false }] });
        if (mode === "copy" || mode === "branch") {
            const source = s.store.readChatSource(characterId, "other").data as Chat;
            s.store.applyChanges({
                chats: [
                    {
                        characterId,
                        chatId,
                        baseRevision: s.store.chatRevision(characterId, chatId),
                        ops: [
                            {
                                op: "replace",
                                chat: {
                                    ...source,
                                    id: chatId,
                                    message: mode === "copy" ? source.message : source.message.slice(0, 1),
                                },
                            },
                        ],
                    },
                ],
            });
        }
        const before = memorySnapshot(s, "other");
        const start = s.store.memory.readContents(characterId, chatId)!.revision;
        const result = await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }));
        expect(result).toEqual({
            revision: start.replace(/:0$/, ":1"),
            inherited: mode === "copy" || mode === "branch",
        });
        expect((await answer(await s.request(base))).adoption).toMatchObject({ adoptable: 0, declined: true });
        const inherited = memorySnapshot(s, chatId);
        expect(inherited.contents.events.map(({ id }) => id)).toEqual(
            mode === "copy" ? ["early", "late"] : mode === "branch" ? ["early"] : [],
        );
        expect(await answer(await s.json(`${base}/inherit`, { sourceChatId: "other" }))).toEqual({
            revision: result.revision,
            inherited: false,
        });
        expect(memorySnapshot(s, chatId)).toEqual(inherited);
        expect(memorySnapshot(s, "other")).toEqual(before);
    }
});

it("leaves decline out of chat files while restoring records leaves an existing decline in place", async () => {
    const source = await server();
    storeAdoptionChat(source, { summaries: [{ text: "Old memory", chatMemos: ["m0"], isImportant: false }] });
    await answer(await source.request(`${base}/decline`, { method: "POST" }));
    const packed = await answer(await source.request(`${base}/package`));
    const threaded = await answer(await source.request(`${base}/threads`));
    const file = JSON.parse(
        JSON.stringify({
            type: "risuChat",
            ver: 2,
            data: source.store.readChatSource(characterId, chatId).data,
            structuredMemory: { pages: packed.pages, events: packed.events, threads: threaded.threads },
        }),
    );
    expect(file.data).not.toHaveProperty("adoptionDeclined");
    expect(file.structuredMemory).toEqual({ pages: [], events: [], threads: [] });
    const imported = await server();
    storeAdoptionChat(imported, file.data.hypaV3Data);
    await answer(await imported.json(`${base}/restore`, file.structuredMemory));
    expect((await answer(await imported.request(base))).adoption).toEqual({
        adoptable: 1,
        declined: false,
        resettable: false,
    });
    const restored = await answer(
        await source.json(`${base}/restore`, { pages: [page("imported")], events: [], threads: [] }),
    );
    expect(restored.restored).toBe(true);
    expect(source.store.memory.readContents(characterId, chatId)?.adoptionDeclined).toBe(true);
    expect((await answer(await source.request(base))).adoption).toMatchObject({ adoptable: 0, declined: true });
});

it("resets only adopted real summaries, publishes the chat revision and preserves a later summary", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const s = await server();
    const ui = createKindRegistry(DEFAULT_RESOURCE_KINDS).get("ui")!;
    const current = s.store.get(ui, "main")!;
    s.store.put(ui, "main", { ...(current.data as object), memoryAlgorithmType: "structuredMemory" }, current.revision);
    const node = serve({ fetch: s.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", resolve));
    allowListenerOrigin(node);
    s.context.attachWebSocket(node);
    const ws = new WebSocket(
        `ws://127.0.0.1:${(node.address() as { port: number }).port}/api/events/ws?risu-auth=${await s.signer.jwt()}`,
    );
    const frames: EventFeedFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    cleanups.push(async () => {
        ws.terminate();
        node.closeAllConnections();
        await new Promise<void>((resolve) => node.close(() => resolve()));
    });
    await new Promise<void>((resolve) => ws.once("message", () => resolve()));
    const summaries = { summaries: [{ text: "Adopted memory.", chatMemos: ["m0", "m1"], isImportant: false }] };
    storeAdoptionChat(s, summaries);
    const refuse = async () => {
        const before = s.store.readChatSource(characterId, chatId);
        const memory = memorySnapshot(s, chatId);
        expect((await answer(await s.request(base))).adoption.resettable).toBe(false);
        expect(await answer(await s.request(`${base}/reset-summaries`, { method: "POST" }))).toEqual({
            chatRevision: before.revision,
            reset: false,
        });
        expect(s.store.readChatSource(characterId, chatId)).toEqual(before);
        expect(memorySnapshot(s, chatId)).toEqual(memory);
    };
    await refuse();
    s.write({ events: [event("ordinary")] });
    await refuse();
    s.write({ remove: { events: ["ordinary"] } });
    await answer(await s.request(`${base}/adopt`, { method: "POST" }));
    expect((await answer(await s.request(base))).adoption.resettable).toBe(true);
    const memory = memorySnapshot(s, chatId);
    const beforeRevision = s.store.chatRevision(characterId, chatId)!;
    const result = await answer(await s.request(`${base}/reset-summaries`, { method: "POST" }));
    expect(result.reset).toBe(true);
    expect(result.chatRevision).not.toBe(beforeRevision);
    expect(s.store.readChatSource(characterId, chatId).data).not.toHaveProperty("hypaV3Data");
    expect(memorySnapshot(s, chatId)).toEqual(memory);
    await new Promise<void>((resolve) => {
        ws.once("pong", () => resolve());
        ws.ping();
    });
    expect(frames.filter((frame) => frame.type === "change")).toEqual([
        expect.objectContaining({
            changes: expect.objectContaining({
                chats: [expect.objectContaining({ characterId, id: chatId, revision: result.chatRevision })],
            }),
        }),
    ]);
    const read = await answer(await s.json("/api/resources/read", { chats: [{ characterId, id: chatId }] }));
    expect(isSealedHypaV3Data(read.chats[0].data.hypaV3Data)).toBe(true);
    expect(read.chats[0].data.hypaV3Data.summaries.map((summary: { text: string }) => summary.text)).toEqual([
        "Adopted memory.",
    ]);
    await refuse();
    const newer = { summaries: [{ text: "New summary after reset", chatMemos: ["m1"], isImportant: true }] };
    storeAdoptionChat(s, newer);
    expect((await answer(await s.request(`${base}/projection`))).hypaV3Data).toBeNull();
    expect(s.store.readChatSource(characterId, chatId).data?.hypaV3Data).toEqual(newer);
    s.write({ adoptionDeclined: true });
    await refuse();
});

function stageRun(s: Awaited<ReturnType<typeof server>>, id = chatId) {
    s.store.memory.rebuild.begin(characterId, id, { epoch: s.epoch, mode: "rebuild", plan: [["u", "a"]] }, {});
    const staged = s.store.memory.rebuild.staged;
    staged.write(
        characterId,
        id,
        { epoch: s.epoch, baseRevision: staged.readContents(characterId, id)!.revision, advance: true },
        {
            pages: [page("staged")],
            events: [event("staged")],
            threads: [{ id: "staged", title: "Staged thread", who: [], state: "open" }],
        },
    );
}

it("previews rebuild, backfill and record costs from stored messages without writing, even during a run", async () => {
    const s = await server();
    bindChat(s);
    const messages: Message[] = ["u1", "a1", "u2", "a2", "u3", "a3", "u4"].map((id) => ({
        chatId: id,
        role: id.startsWith("u") ? "user" : "char",
        data: "한",
    }));
    s.store.applyChanges({
        chats: [
            {
                characterId,
                chatId,
                baseRevision: s.store.chatRevision(characterId, chatId),
                ops: [
                    {
                        op: "replace",
                        chat: { ...(s.store.readChatSource(characterId, chatId).data as Chat), message: messages },
                    },
                ],
            },
        ],
    });
    s.write({
        events: [
            {
                ...event("adopted"),
                writerRun: ADOPTED_WRITER_RUN,
                sources: [{ messageId: "a1", index: 1, hash: messageSourceHash(messages[1]) }],
            },
        ],
    });
    stageRun(s);
    const before = memorySnapshot(s, chatId);
    const chatBefore = s.store.readChatSource(characterId, chatId);
    const writes = s.store.writeCount();
    for (const [query, expected] of [
        ["mode=rebuild&turns=2", { calls: 2, messages: 6 }],
        ["mode=backfill&turns=1", { calls: 3, messages: 5 }],
        ["mode=record&turns=1&through=a3", { calls: 2, messages: 4 }],
    ] as const) {
        const cost = await answer(await s.request(`${base}/cost?${query}`));
        expect(cost).toMatchObject(expected);
        expect(Number.isSafeInteger(cost.estimatedTokens)).toBe(true);
        expect(cost.estimatedTokens).toBeGreaterThan(0);
    }
    expect(memorySnapshot(s, chatId)).toEqual(before);
    expect(s.store.readChatSource(characterId, chatId)).toEqual(chatBefore);
    expect(s.store.writeCount()).toBe(writes);
});

it("fences generation and memory mutations during a stopped run while allowing previews, checkpoint saves and live-only exports and copies", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const admitted: string[] = [];
    const s = await server({
        generationRunner: async (job) => {
            admitted.push(job.kind);
            job.emit({ type: "done", revision: job.context.chatRevision });
        },
    });
    const context = bindChat(s);
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const ui = kinds.get("ui")!;
    s.store.put(
        ui,
        "main",
        { ...(s.store.get(ui, "main")!.data as object), memoryAlgorithmType: "structuredMemory" },
        s.store.get(ui, "main")!.revision,
    );
    s.write({ pages: [page("live")], events: [event("live")] });
    stageRun(s);
    s.store.memory.rebuild.noteStop(characterId, chatId, { epoch: s.epoch, reason: "cancelled" });
    const before = memorySnapshot(s, chatId);
    for (const action of [
        { kind: "send" },
        { kind: "continue" },
        { kind: "command", command: { type: "manual", name: "trigger" } },
        { kind: "command", command: { type: "button", data: "button" } },
        { kind: "command", command: { type: "memoryRecord", messageId: "a" } },
    ]) {
        const response = await s.json("/api/generations", { ...action, context, clientId: "tab" });
        expect(response.status, await response.text()).toBe(409);
    }
    expect(admitted).toEqual([]);
    await answer(await s.json("/api/generations", { kind: "preview", context, clientId: "tab" }));
    await s.context.generationJobs.drain();
    expect(admitted).toEqual(["preview"]);
    const mutations = [
        [
            "edits",
            { revision: before.contents.revision, edit: { kind: "page", pageId: "live", contextMode: "always" } },
        ],
        ["adopt", {}],
        ["decline", {}],
        ["reset-summaries", {}],
        ["restore", { pages: [], events: [], threads: [] }],
        ["inherit", { sourceChatId: "other" }],
    ] as const;
    for (const [route, body] of mutations)
        expect(await answer(await s.json(`${base}/${route}`, body), 409)).toMatchObject({ reason: "fenced" });
    const saved = await answer(
        await s.json("/api/chat-checkpoints/save", { characterId, chatId, name: "During rebuild" }),
    );
    await answer(
        await s.json("/api/chat-checkpoints/load", {
            characterId,
            chatId,
            id: saved.checkpoint.id,
            chatBaseRevision: context.chatRevision,
        }),
        409,
    );
    const checkpoint = s.store.checkpoints.readMemory(characterId, chatId, saved.checkpoint.id)!;
    expect(checkpoint.captured).toBe(true);
    if (!checkpoint.captured) throw new Error("Checkpoint missed live memory");
    expect(checkpoint.texts.pages.map((text) => JSON.parse(text))).toEqual([page("live")]);
    expect(checkpoint.texts.events.map((text) => JSON.parse(text).id)).toEqual(["live"]);
    expect(checkpoint.texts.threads).toEqual([]);
    expect(await answer(await s.request(`${base}/package`))).toMatchObject({
        pages: [page("live")],
        events: [expect.objectContaining({ id: "live" })],
        next: null,
    });
    expect(await answer(await s.request(`${base}/threads`))).toMatchObject({ threads: [] });
    const other = `/api/memory/structured/${encodeURIComponent(characterId)}/other`;
    expect(await answer(await s.json(`${other}/inherit`, { sourceChatId: chatId }))).toMatchObject({ inherited: true });
    expect(memorySnapshot(s, "other").records.pages).toEqual([page("live")]);
    expect(s.store.memory.rebuild.status(characterId, "other")).toBeNull();
    expect(memorySnapshot(s, chatId)).toEqual(before);
    s.store.put(
        ui,
        "main",
        { ...(s.store.get(ui, "main")!.data as object), memoryAlgorithmType: "hypaV3" },
        s.store.get(ui, "main")!.revision,
    );
    await answer(await s.json("/api/generations", { kind: "send", context, clientId: "tab" }));
    await s.context.generationJobs.drain();
    expect(admitted).toEqual(["preview", "send"]);
    expect(await answer(await s.request(`${base}/rebuild/abandon`, { method: "POST" }))).toMatchObject({
        abandoned: true,
    });
    expect(memorySnapshot(s, chatId)).toEqual(before);
});

it("reconciles message edits and confirmed deletions into both live and staged events during a rebuild", async () => {
    const s = await server();
    bindChat(s);
    const stored = s.store.readChatSource(characterId, chatId).data as Chat;
    const sources = stored.message
        .slice(0, 2)
        .map((message, index) => ({ messageId: message.chatId!, index, hash: messageSourceHash(message) }));
    s.write({ events: [{ ...event("live"), sources }] });
    stageRun(s);
    const staged = s.store.memory.rebuild.staged;
    staged.write(
        characterId,
        chatId,
        { epoch: s.epoch, baseRevision: staged.readContents(characterId, chatId)!.revision },
        { events: [{ ...event("staged"), sources }] },
    );
    const edit = (ops: ChatOp[]) =>
        s.json("/api/resources/batch", {
            chats: [{ characterId, chatId, baseRevision: s.store.chatRevision(characterId, chatId), ops }],
        });
    await answer(await edit([{ op: "patchMessage", id: "a", set: { data: "The gate shuts." } }]));
    expect(s.store.memory.readRecord(characterId, chatId, "events", "live")?.data).toMatchObject({ rerecord: true });
    expect(staged.readRecord(characterId, chatId, "events", "staged")?.data).toMatchObject({ rerecord: true });
    await answer(await edit([{ op: "remove", ids: ["a"], retract: true }]));
    expect(s.store.memory.readRecord(characterId, chatId, "events", "live")?.data.status).toBe("retracted");
    expect(staged.readRecord(characterId, chatId, "events", "staged")?.data.status).toBe("retracted");
});

it("keeps adopted summaries and their reset offer through repeated swaps, replacing only fully reproduced events", async () => {
    const s = await server();
    storeAdoptionChat(s, {
        summaries: [{ text: "Reproducible summary", chatMemos: ["m0", "m1"], isImportant: false }],
    });
    await answer(await s.request(`${base}/adopt`, { method: "POST" }));
    s.write({ events: [event("carried")] });
    const chatBefore = s.store.readChatSource(characterId, chatId);
    const initial = readRecordSet(s.store.memory, characterId, chatId)!;
    const reproduced = initial.events.find(({ sources }) => sources.length === 2)!;
    const carried = initial.events.find(({ sources }) => sources.length === 0)!;
    for (let i = 0; i < 2; i++) {
        const live = readRecordSet(s.store.memory, characterId, chatId)!;
        const rebuild = s.store.memory.rebuild;
        rebuild.begin(
            characterId,
            chatId,
            { epoch: s.epoch, mode: "rebuild", plan: [["m0", "m1"]] },
            rebuildSeed("rebuild", live),
        );
        rebuild.staged.write(
            characterId,
            chatId,
            { epoch: s.epoch, baseRevision: rebuild.staged.readContents(characterId, chatId)!.revision, advance: true },
            {
                events: [{ ...event(`new-${i}`), sources: reproduced.sources }],
                runs: [{ ...run(`new-${i}`), result: "recorded", language: i === 0 ? "English" : "Korean" }],
            },
        );
        const staged = readRecordSet(rebuild.staged, characterId, chatId)!;
        rebuild.swap(
            characterId,
            chatId,
            { epoch: s.epoch, baseRevision: live.contents.revision },
            rebuildChanges("rebuild", live, staged)!,
        );
        expect(s.store.memory.readRecord(characterId, chatId, "events", carried.id)?.data).toEqual(carried);
        expect(s.store.memory.readContents(characterId, chatId)!.events.map(({ id }) => id)).toEqual([
            carried.id,
            `new-${i}`,
        ]);
        expect(s.store.memory.readRecord(characterId, chatId, "events", `new-${i}`)?.data.createdRevision).toBe(
            Number(live.contents.revision.split(":").at(-1)) + 1,
        );
        expect(s.store.readChatSource(characterId, chatId)).toEqual(chatBefore);
        // The latest failure does not replace the language of the latest recorded run.
        s.write({ runs: [{ ...run(`failed-${i}`), result: "failed", language: "French" }] });
        expect(await answer(await s.request(base))).toMatchObject({
            adoption: { resettable: true },
            recordedLanguage: i === 0 ? "English" : "Korean",
        });
    }
});

it("refuses held rebuild starts and resumes through the same job admission as record now and still abandons", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const s = await server({ memoryTaskOptions: { now: () => 1 } });
    storeAdoptionChat(s, {
        summaries: [{ text: "Adopt or decline first", chatMemos: ["m0", "m1"], isImportant: false }],
    });
    const context = bindChat(s);
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    for (const [name, id, fields] of [
        ["ui", "main", { memoryAlgorithmType: "structuredMemory" }],
        ["characters", characterId, { supaMemory: true }],
    ] as const) {
        const kind = kinds.get(name)!;
        const row = s.store.get(kind, id)!;
        s.store.put(kind, id, { ...(row.data as object), ...fields }, row.revision);
    }
    const before = memorySnapshot(s, chatId);
    for (const resume of [false, true]) {
        if (resume) stageRun(s);
        const accepted = await answer(
            await s.json("/api/generations", {
                kind: "command",
                clientId: "tab",
                context,
                command: resume
                    ? { type: "memoryRebuild", resume: true }
                    : { type: "memoryRebuild", mode: "rebuild", turns: 1 },
            }),
        );
        await s.context.generationJobs.drain();
        expect(s.context.generationJobs.status(accepted.jobId, "tab")?.terminal).toMatchObject({
            type: "error",
            status: 409,
            message: expect.stringContaining("Adopt or decline"),
        });
        expect(memorySnapshot(s, chatId)).toEqual(before);
        if (!resume) expect(s.store.memory.rebuild.status(characterId, chatId)).toBeNull();
    }
    expect(await answer(await s.request(`${base}/rebuild/abandon`, { method: "POST" }))).toMatchObject({
        abandoned: true,
    });
    expect(memorySnapshot(s, chatId)).toEqual(before);
});

it("restores a writer change's text, evidence and marks once and counts only later unretracted events", async () => {
    const s = await server();
    const earlier = {
        body: "The gate was closed.",
        provenance: ["old"],
        sources: [{ messageId: "old-message", hash: "old-hash", index: 0 }],
        userCorrected: true,
        disputed: true,
        unsupported: true,
        pinned: true,
        suppressed: true,
    };
    const p = page("p", "The gate is open.");
    p.sections[0] = {
        ...p.sections[0],
        provenance: ["opening"],
        sources: [],
        locked: true,
        pinned: true,
        suppressed: true,
    };
    p.history = [
        {
            id: "change",
            heading: "Facts",
            before: earlier,
            kind: "change",
            eventId: "opening",
            highlighted: true,
            at: 2,
        },
    ];
    const stale = s.write({
        pages: [p],
        events: [
            event("old"),
            event("opening"),
            { ...event("removed"), status: "retracted" },
            event("later"),
            { ...event("stale"), status: "stale" },
        ],
    });
    const reverted = await answer(
        await s.json(`${base}/revert`, { revision: stale, pageId: "p", historyId: "change" }),
    );
    expect(reverted).toMatchObject({
        reverted: true,
        laterEvents: 2,
        data: {
            sections: [{ ...earlier, heading: "Facts", locked: true, updatedAt: Date.now() }],
            history: [
                { ...p.history[0], revertedBy: "user" },
                {
                    id: expect.any(String),
                    heading: "Facts",
                    kind: "revert",
                    highlighted: false,
                    at: Date.now(),
                    before: {
                        body: "The gate is open.",
                        provenance: ["opening"],
                        sources: [],
                        pinned: true,
                        suppressed: true,
                    },
                },
            ],
        },
    });
    expect(reverted.data.history).toHaveLength(2);
    expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({
        revision: reverted.revision,
        data: reverted.data,
    });
    expect(
        await answer(await s.json(`${base}/revert`, { revision: reverted.revision, pageId: "p", historyId: "change" })),
    ).toEqual({ ...reverted, reverted: false, laterEvents: 0 });
    expect(
        await answer(await s.json(`${base}/revert`, { revision: stale, pageId: "p", historyId: "change" }), 409),
    ).toMatchObject({ revision: reverted.revision });
    expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({
        revision: reverted.revision,
        data: reverted.data,
    });

    const orphan = { ...p, id: "orphan", history: [{ ...p.history[0], eventId: "not-listed" }] };
    const revision = s.write({ pages: [orphan] });
    expect(
        await answer(await s.json(`${base}/revert`, { revision, pageId: "orphan", historyId: "change" })),
    ).toMatchObject({ reverted: true, laterEvents: 0 });
});

it("reverts compactions with their patch by either id and undoes repeated-event changes newest first", async () => {
    const s = await server();
    const snapshot = (body: string) => ({ body, provenance: [], sources: [] });
    for (const historyId of ["patch", "compact"]) {
        const p = page(historyId, "Shortened");
        p.history = [
            {
                id: "patch",
                heading: "Facts",
                before: snapshot("Original"),
                kind: "change",
                eventId: "same-event",
                highlighted: true,
                at: 1,
            },
            {
                id: "compact",
                heading: "Facts",
                before: snapshot("Long replacement"),
                kind: "compact",
                eventId: "same-event",
                highlighted: true,
                at: 1,
            },
        ];
        const revision = s.write({ pages: [p] });
        const result = await answer(await s.json(`${base}/revert`, { revision, pageId: p.id, historyId }));
        expect(result.data.sections[0].body).toBe("Original");
        expect(result.data.history).toEqual([
            ...p.history.map((entry) => ({ ...entry, revertedBy: "user" })),
            expect.objectContaining({ kind: "revert", before: snapshot("Shortened"), highlighted: false }),
        ]);
    }
    const p = page("scene", "Third scene");
    p.type = "scene";
    p.history = [
        {
            id: "first",
            heading: "Facts",
            before: snapshot("First scene"),
            kind: "change",
            eventId: "repeat",
            highlighted: true,
            at: 1,
        },
        {
            id: "second",
            heading: "Facts",
            before: snapshot("Second scene"),
            kind: "change",
            eventId: "repeat",
            highlighted: true,
            at: 1,
        },
    ];
    let revision = s.write({ pages: [p] });
    expect(
        await answer(await s.json(`${base}/revert`, { revision, pageId: p.id, historyId: "first" }), 409),
    ).toMatchObject({ reason: "superseded" });
    const latest = await answer(await s.json(`${base}/revert`, { revision, pageId: p.id, historyId: "second" }));
    expect(latest.data.sections[0].body).toBe("Second scene");
    expect(latest.data.history[0].revertedBy).toBeUndefined();
    const oldest = await answer(
        await s.json(`${base}/revert`, { revision: latest.revision, pageId: p.id, historyId: "first" }),
    );
    expect(oldest.data.sections[0].body).toBe("First scene");

    const edited = page("edited", "Writer text");
    edited.history = [{ ...p.history[0], id: "writer" }];
    revision = s.write({ pages: [edited] });
    const personal = await answer(
        await s.json(`${base}/edits`, {
            revision,
            edit: { kind: "section", pageId: edited.id, heading: "Facts", body: "My correction" },
        }),
    );
    expect(personal.data.history.at(-1)).toMatchObject({ kind: "edit", highlighted: false });
    expect(
        await answer(
            await s.json(`${base}/revert`, { revision: personal.revision, pageId: edited.id, historyId: "writer" }),
            409,
        ),
    ).toMatchObject({ reason: "superseded" });
    expect(await answer(await s.request(`${base}/records/pages/edited`))).toEqual({
        revision: personal.revision,
        data: personal.data,
    });

    const compact = page("trimmed", "Shortened");
    compact.history = [
        {
            id: "compact",
            heading: "Facts",
            before: snapshot("Long replacement"),
            kind: "compact",
            eventId: "old",
            highlighted: true,
            at: 1,
        },
    ];
    revision = s.write({ pages: [compact] });
    expect(
        await answer(await s.json(`${base}/revert`, { revision, pageId: compact.id, historyId: "compact" }), 409),
    ).toMatchObject({ reason: "superseded" });
});

it("refuses non-writer and lost history entries and fences reverts throughout a rebuild", async () => {
    const s = await server();
    const p = page("p");
    p.history = [
        { id: "create", heading: null, before: null, kind: "create", eventId: "e", highlighted: true, at: 1 },
        { id: "edit", heading: "Facts", before: null, kind: "edit", highlighted: false, at: 2 },
        { id: "revert", heading: "Facts", before: null, kind: "revert", highlighted: false, at: 3 },
        { id: "writer", heading: "Facts", before: null, kind: "create", eventId: "e", highlighted: true, at: 4 },
    ];
    const revision = s.write({ pages: [p] });
    for (const historyId of ["create", "edit", "revert"])
        await answer(await s.json(`${base}/revert`, { revision, pageId: "p", historyId }), 400);
    expect(
        await answer(await s.json(`${base}/revert`, { revision, pageId: "p", historyId: "evicted" }), 404),
    ).toMatchObject({ reason: "recordGone" });
    stageRun(s);
    for (const stopped of [false, true]) {
        if (stopped) s.store.memory.rebuild.noteStop(characterId, chatId, { epoch: s.epoch, reason: "cancelled" });
        expect(
            await answer(await s.json(`${base}/revert`, { revision, pageId: "p", historyId: "writer" }), 409),
        ).toMatchObject({ reason: "fenced" });
    }
    expect(await answer(await s.request(`${base}/records/pages/p`))).toEqual({ revision, data: p });
});
