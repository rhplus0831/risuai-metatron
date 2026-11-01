// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_RUNS_ROUND_ROWS, STRUCTURED_MEMORY_LIMITS } from "../../../shared/structuredMemory.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope, memorySettingsFingerprint, memoryTokenPolicy } from "../jobs/jobScope.ts";
import type { StructuredMemoryTaskInput } from "../../../shared/jobs.ts";
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
                { id: "z", title: "Event z", status: "active", messageIds: ["m1"], sourceIndex: 0 },
                {
                    id: "a",
                    title: "Event a",
                    status: "stale",
                    staleReason: "changed",
                    suppressed: true,
                    messageIds: ["m1"],
                    sourceIndex: 0,
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

it("refuses edits while the real memory task is queued or running and accepts them after cancellation", async () => {
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
    expect((await answer(await s.json(`${base}/edits`, { revision, edit }))).data.sections[0].body).toBe(
        "Correction after writer",
    );
});

it("refuses edits for an admitted job and for its message lock on a different chat", async () => {
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
        // A chat slot alone must not fence a sibling chat.
        await answer(await s.json(`${otherPath}/edits`, { revision: otherRevision, edit: { ...edit, locked: false } }));
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
    } finally {
        release.resolve();
        await s.context.generationJobs.drain();
    }
    for (const [url, token] of [
        [base, revision],
        [otherPath, otherRevision],
    ])
        expect((await answer(await s.json(`${url}/edits`, { revision: token, edit }))).data.sections[0].locked).toBe(
            true,
        );
});
