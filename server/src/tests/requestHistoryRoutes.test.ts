// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LlmRequestEvent } from "../../../shared/llm/request.ts";
import {
    REQUEST_HISTORY_DEFAULT_LIMIT,
    REQUEST_HISTORY_MIN_LIMIT,
    type RequestHistoryBegin,
    type RequestHistoryRecord,
    type RequestHistorySummary,
} from "../data/requestHistory.ts";
import { REQUEST_HISTORY_PATH } from "../routes/requestHistory.ts";
import { createResourceTestClient, createSigner, TEST_INDEX_HTML, type ResourceTestClient } from "./testSupport.ts";

// The history routes (`server/src/routes/requestHistory.ts`) on the real app, and the two `providers`
// settings as `createServerContext` reads them (`server/src/app.ts`). The routes: the JWT before
// anything (the server's 400 for a missing or invalid token), `GET` paging newest first through the
// `next` cursor, each filter and their combination, an empty parameter absent, a 400 for a malformed
// cursor (the shape and the safe-integer bound), page size, or status, the row with its content by id
// and a 404, `DELETE` as a 204 (an empty history too) with the list empty after, a 500 when the
// delete failed while the store stays open (another connection holds the write lock), a 503 with
// `Retry-After` on every route once the store is closed (also closed while a request is already in
// flight, after its admission) or never opened, and the admission middleware: a 503 during shutdown
// and `Cache-Control: no-store` on every answer (200, 204, 400, 404, 500, 503, the limiter's 429, the
// body limit's 413). The settings: `requestHistoryContent` read when a request begins (off makes the
// new row a summary while an older row keeps its content; a record written without it reads as on),
// `requestHistoryLimit` read at every prune (a cap of 10 prunes at the next write, a value under 10
// reads as 10, a record written without it reads as 1,000). The observer's throwing content getter is
// in `requestCapture.test.ts`, the store's own rules in `requestHistory.test.ts`.

const servers: ResourceTestClient[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
beforeAll(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    warn.mockClear();
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(options: Parameters<typeof createResourceTestClient>[0] = {}) {
    const s = await createResourceTestClient(options);
    servers.push(s);
    return s;
}

/** A begin with every optional field absent and content on, overridable. */
function row(id: string, overrides: Partial<RequestHistoryBegin> = {}): RequestHistoryBegin {
    return {
        id,
        jobId: null,
        source: "send",
        mode: "main",
        chaId: null,
        chatId: null,
        messageId: null,
        content: true,
        ...overrides,
    };
}

/** Begins `ids` on the server's own store, in order. */
function begin(s: ResourceTestClient, ids: string[], overrides: Partial<RequestHistoryBegin> = {}) {
    for (const id of ids) {
        s.context.requestHistory.begin(row(id, overrides));
    }
}

type Page = { items: RequestHistorySummary[]; next: string | null };

/** `GET /api/request-history<query>`: the answer, and its page when it is a 200 (the body is read). */
async function list(s: ResourceTestClient, query = "") {
    const res = await s.request(`${REQUEST_HISTORY_PATH}${query}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    return { res, text, page: res.status === 200 ? (JSON.parse(text) as Page) : null };
}

async function ids(s: ResourceTestClient, query = ""): Promise<string[]> {
    const { res, text, page } = await list(s, query);
    expect(res.status, text).toBe(200);
    return page!.items.map((item) => item.id);
}

async function get(s: ResourceTestClient, id: string) {
    const res = await s.request(`${REQUEST_HISTORY_PATH}/${encodeURIComponent(id)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    return res;
}

async function deleteAll(s: ResourceTestClient, init: RequestInit = {}) {
    const res = await s.request(REQUEST_HISTORY_PATH, { method: "DELETE", ...init });
    expect(res.headers.get("cache-control")).toBe("no-store");
    return res;
}

const unavailable = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "The request history is unavailable" });
};
/** The list route's answer, unread. */
const listRaw = (s: ResourceTestClient) => s.request(REQUEST_HISTORY_PATH);

type Providers = { revision: string; data: Record<string, unknown> };

async function readProviders(s: ResourceTestClient): Promise<Providers> {
    const res = await s.get("providers", "main");
    expect(res.status).toBe(200);
    return (await res.json()) as Providers;
}

/** Writes the providers record with `patch` over its current data (an `undefined` field is left out). */
async function setProviders(s: ResourceTestClient, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await readProviders(s);
    const res = await s.put("providers", "main", {
        baseRevision: current.revision,
        data: { ...current.data, ...patch },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as Providers).data;
}

/**
 * A tab request that the layer admits (its row begun) and refuses at its settings load (the preset
 * does not exist): the row's `content` flag is the setting as read at admission.
 */
async function admittedRequest(s: ResourceTestClient): Promise<string> {
    const res = await s.json("/api/llm/request", {
        clientId: "tab-1",
        mode: "model",
        context: {
            presetId: "missing",
            modelPresetId: "missing",
            personaId: "missing",
            selectedPersonaId: "missing",
            selectedCharacterId: null,
            speakerId: null,
            mainModel: { imageInput: false },
            tokenizer: {
                aiModel: "reverse_proxy",
                currentPluginProvider: "",
                modelTokenizer: 1,
                pluginTokenizer: "none",
                customTokenizer: "",
                googleClaudeTokenizing: false,
                useTokenizerCaching: false,
            },
        },
        arg: { formated: [{ role: "user", content: "hi" }], bias: {} },
        tools: [],
        toolRecords: {},
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const events = (await res.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice("data: ".length)) as LlmRequestEvent);
    expect(events[0]?.type).toBe("accepted");
    expect(events.at(-1)).toMatchObject({ type: "result", response: { type: "fail" } });
    return (events[0] as { id: string }).id;
}

describe("GET /api/request-history", () => {
    it("requires a JWT, answers no-store, and pages the summaries newest first through the next cursor", async () => {
        const s = await server();
        begin(s, ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
        const noHeader = await s.app.request(REQUEST_HISTORY_PATH);
        expect(noHeader.status).toBe(400);
        expect(await noHeader.json()).toEqual({ error: "No auth header" });
        expect(noHeader.headers.get("cache-control")).toBe("no-store");
        const stranger = await createSigner();
        const unknownKey = await s.app.request(REQUEST_HISTORY_PATH, {
            headers: { "risu-auth": await stranger.jwt() },
        });
        expect(unknownKey.status).toBe(400);
        expect(unknownKey.headers.get("cache-control")).toBe("no-store");
        const broken = await s.app.request(REQUEST_HISTORY_PATH, {
            headers: { "risu-auth": await s.signer.jwt({ breakSignature: true }) },
        });
        expect(broken.status).toBe(400);
        expect(broken.headers.get("cache-control")).toBe("no-store");

        const first = await list(s, "?limit=3");
        expect(first.res.status).toBe(200);
        // The shared limiter is on the route.
        expect(first.res.headers.get("ratelimit-limit")).toBe("2000");
        expect(first.page!.items.map((item) => item.id)).toEqual(["r7", "r6", "r5"]);
        expect(first.page!.next).toMatch(/^[1-9][0-9]*$/);
        // Summaries: no content fields.
        expect(first.page!.items[0]).toMatchObject({ id: "r7", status: "pending", source: "send", content: true });
        expect(first.page!.items[0]).not.toHaveProperty("prompt");
        expect(first.page!.items[0]).not.toHaveProperty("exchanges");
        const second = await list(s, `?limit=3&cursor=${first.page!.next}`);
        expect(second.page!.items.map((item) => item.id)).toEqual(["r4", "r3", "r2"]);
        const third = await list(s, `?limit=3&cursor=${second.page!.next}`);
        expect(third.page).toEqual({ items: [expect.objectContaining({ id: "r1" })], next: null });
        // The empty parameters are absent: the default page size, the first page.
        expect(await ids(s, "?limit=&cursor=&chaId=&chatId=&jobId=&status=")).toEqual([
            "r7",
            "r6",
            "r5",
            "r4",
            "r3",
            "r2",
            "r1",
        ]);
        expect((await list(s)).page!.next).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });

    it("filters by chaId, chatId, jobId, and status, combined", async () => {
        const s = await server();
        const history = s.context.requestHistory;
        begin(s, ["a1", "a2"], { chaId: "A", chatId: "A-1", jobId: "j1" });
        begin(s, ["a3"], { chaId: "A", chatId: "A-2", jobId: "j2" });
        begin(s, ["b1"], { chaId: "B", chatId: "B-1", jobId: "j3" });
        begin(s, ["t1"], { source: "tab" });
        history.finish("a1", { status: "success" });
        history.finish("a3", { status: "error", error: "e" });
        history.finish("b1", { status: "aborted" });
        expect(await ids(s)).toEqual(["t1", "b1", "a3", "a2", "a1"]);
        expect(await ids(s, "?chaId=A")).toEqual(["a3", "a2", "a1"]);
        expect(await ids(s, "?chatId=A-1")).toEqual(["a2", "a1"]);
        expect(await ids(s, "?jobId=j1")).toEqual(["a2", "a1"]);
        expect(await ids(s, "?status=pending")).toEqual(["t1", "a2"]);
        expect(await ids(s, "?status=error")).toEqual(["a3"]);
        expect(await ids(s, "?status=aborted")).toEqual(["b1"]);
        expect(await ids(s, "?status=success")).toEqual(["a1"]);
        expect(await ids(s, "?status=interrupted")).toEqual([]);
        expect(await ids(s, "?chaId=A&status=success")).toEqual(["a1"]);
        expect(await ids(s, "?chaId=A&chatId=A-1&jobId=j1&status=pending")).toEqual(["a2"]);
        expect(await ids(s, "?chaId=A&chatId=B-1")).toEqual([]);
        expect(await ids(s, "?chaId=none")).toEqual([]);
        // A filtered page cursors within the filter.
        const page = (await list(s, "?chaId=A&limit=2")).page!;
        expect(page.items.map((item) => item.id)).toEqual(["a3", "a2"]);
        expect(await ids(s, `?chaId=A&limit=2&cursor=${page.next}`)).toEqual(["a1"]);
    });

    it("answers 400 for a malformed cursor, page size, or status, and clamps a well-formed page size", async () => {
        const s = await server();
        begin(s, ["r1", "r2", "r3"]);
        for (const cursor of [
            "abc",
            "0",
            "-1",
            "01",
            "1e3",
            "%203",
            "1.5",
            "99999999999999999999",
            "9007199254740993",
        ]) {
            const { res, text } = await list(s, `?cursor=${cursor}`);
            expect(res.status, cursor).toBe(400);
            expect(JSON.parse(text)).toEqual({ error: "Invalid cursor" });
        }
        // The cursor is exclusive (the rows before it): the largest safe integer lists every row.
        expect(await ids(s, `?cursor=${Number.MAX_SAFE_INTEGER}`)).toEqual(["r3", "r2", "r1"]);
        for (const limit of ["abc", "-1", "1.5", "10000", "%202", "1e2"]) {
            const { res, text } = await list(s, `?limit=${limit}`);
            expect(res.status, limit).toBe(400);
            expect(JSON.parse(text)).toEqual({ error: "Invalid limit" });
        }
        expect(await ids(s, "?limit=0")).toEqual(["r3"]);
        expect(await ids(s, "?limit=0001")).toEqual(["r3"]);
        expect(await ids(s, "?limit=9999")).toEqual(["r3", "r2", "r1"]);
        for (const status of ["done", "SUCCESS", "pending,error", "%20pending"]) {
            const { res, text } = await list(s, `?status=${status}`);
            expect(res.status, status).toBe(400);
            expect(JSON.parse(text)).toEqual({ error: "Invalid status" });
        }
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("GET /api/request-history/:id", () => {
    it("answers the row with its content, decodes the id, and answers 404 for an unknown one", async () => {
        const s = await server();
        const history = s.context.requestHistory;
        history.begin(row("r1", { prompt: [{ role: "user", content: "hi" }], chaId: "c", chatId: "k" }));
        history.exchange("r1", {
            url: "https://api.example/v1",
            header: '{"Authorization":"[redacted]"}',
            body: '{"model":"m"}',
            response: "ok",
            success: true,
            status: 200,
            date: "d",
        });
        history.finish("r1", { status: "success", httpStatus: 200 });
        history.begin(row("id with space/and slash", { content: false }));
        const res = await get(s, "r1");
        expect(res.status).toBe(200);
        const record = (await res.json()) as RequestHistoryRecord;
        expect(record).toMatchObject({
            id: "r1",
            chaId: "c",
            chatId: "k",
            status: "success",
            httpStatus: 200,
            content: true,
            prompt: JSON.stringify([{ role: "user", content: "hi" }]),
            exchangeCount: 1,
            error: null,
        });
        expect(record.exchanges).toEqual([
            {
                url: "https://api.example/v1",
                header: '{"Authorization":"[redacted]"}',
                body: '{"model":"m"}',
                response: "ok",
                success: true,
                status: 200,
                date: "d",
                responseType: null,
            },
        ]);
        expect(record).toHaveProperty("truncation");
        const spaced = await get(s, "id with space/and slash");
        expect(spaced.status).toBe(200);
        expect(await spaced.json()).toMatchObject({ id: "id with space/and slash", content: false, exchanges: null });
        const missing = await get(s, "nope");
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: "No such request" });
        const noHeader = await s.app.request(`${REQUEST_HISTORY_PATH}/r1`);
        expect(noHeader.status).toBe(400);
        expect(noHeader.headers.get("cache-control")).toBe("no-store");
    });
});

describe("DELETE /api/request-history", () => {
    it("removes every row (204), also from an empty history, and answers 500 when the delete failed while the store stays open", async () => {
        const s = await server();
        const history = s.context.requestHistory;
        begin(s, ["r1", "r2", "r3"]);
        history.exchange("r1", { url: "u", header: "{}", body: "{}", response: "ok", success: true, date: "d" });
        const noHeader = await s.app.request(REQUEST_HISTORY_PATH, { method: "DELETE" });
        expect(noHeader.status).toBe(400);
        expect(noHeader.headers.get("cache-control")).toBe("no-store");
        expect(await ids(s)).toEqual(["r3", "r2", "r1"]);

        const deleted = await deleteAll(s);
        expect(deleted.status).toBe(204);
        expect(await deleted.text()).toBe("");
        expect(await ids(s)).toEqual([]);
        expect(history.stats()).toEqual({ rows: 0, bytes: 0 });
        // An empty history deletes fine.
        expect((await deleteAll(s)).status).toBe(204);

        // Another connection holds the write lock: the delete fails, nothing is removed, the store stays open.
        begin(s, ["r4"]);
        const other = new DatabaseSync(path.join(s.savePath, "data", "request-history.sqlite"));
        try {
            other.exec("BEGIN IMMEDIATE");
            const failed = await deleteAll(s);
            expect(failed.status).toBe(500);
            expect(await failed.json()).toEqual({ error: "The request history could not be deleted" });
            expect(history.available()).toBe(true);
            expect(await ids(s)).toEqual(["r4"]);
            expect(warn).toHaveBeenCalledTimes(1);
            other.exec("ROLLBACK");
        } finally {
            other.close();
        }
        expect((await deleteAll(s)).status).toBe(204);
        expect(await ids(s)).toEqual([]);
        // The store goes on after the failure.
        begin(s, ["r5"]);
        expect(await ids(s)).toEqual(["r5"]);
    });
});

describe("an unavailable history", () => {
    it("answers 503 with Retry-After on every route once the store is closed, also when it closes while a request is in flight", async () => {
        const s = await server();
        begin(s, ["r1"]);
        // The request is admitted (the middleware ran, the store was open) and is awaiting its JWT
        // check when the store closes: the handler checks the store again, after the JWT.
        const headers = await s.headers();
        const inFlight = s.app.request(REQUEST_HISTORY_PATH, { headers });
        s.context.requestHistory.close();
        await unavailable(await inFlight);
        await unavailable(await listRaw(s));
        await unavailable(await get(s, "r1"));
        await unavailable(await deleteAll(s));
        // The JWT still comes first.
        const noHeader = await s.app.request(REQUEST_HISTORY_PATH);
        expect(noHeader.status).toBe(400);
        // And so does the validation.
        const bad = await s.request(`${REQUEST_HISTORY_PATH}?cursor=abc`);
        expect(bad.status).toBe(400);
        expect(warn).not.toHaveBeenCalled();
    });

    it("answers 503 on every route when the store never opened (its file is unusable)", async () => {
        // A prepared root whose history file path is a directory: the store is inert from the start,
        // the resource store beside it works.
        const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-request-history-routes-"));
        mkdirSync(path.join(rootDir, "dist"));
        writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
        mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
        writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
        mkdirSync(path.join(rootDir, "save", "data", "request-history.sqlite"), { recursive: true });
        const s = await server({ rootDir });
        expect(s.context.requestHistory.available()).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        await unavailable(await listRaw(s));
        await unavailable(await get(s, "r1"));
        await unavailable(await deleteAll(s));
        // The rest of the server is up.
        expect((await s.get("providers", "main")).status).toBe(200);
    });
});

describe("the admission middleware", () => {
    it("refuses the history routes with 503 during shutdown, and sets no-store on a 413 and on the limiter's 429", async () => {
        const s = await server();
        // The body limit's 413 comes before the route (and before the JWT): no-store nevertheless.
        const tooLarge = await s.app.request(REQUEST_HISTORY_PATH, {
            method: "DELETE",
            body: "x",
            headers: { "content-length": String(101 * 1024 * 1024) },
        });
        expect(tooLarge.status).toBe(413);
        expect(await tooLarge.json()).toEqual({ error: "Request body too large" });
        expect(tooLarge.headers.get("cache-control")).toBe("no-store");

        // The limiter's 429 (2,000 per minute per client, the client's earlier requests counted;
        // without a JWT each hit is a quick 400).
        let hits = 0;
        let limited: Response | undefined;
        while (hits < 2001 && !limited) {
            const res = await s.app.request(REQUEST_HISTORY_PATH);
            hits++;
            if (res.status === 429) {
                limited = res;
            } else {
                expect(res.status).toBe(400);
            }
        }
        expect(hits).toBeGreaterThan(1990);
        expect(limited!.headers.get("retry-after")).toMatch(/^[0-9]+$/);
        expect(limited!.headers.get("cache-control")).toBe("no-store");
        expect(await limited!.json()).toEqual({ error: "Too many requests. Please retry shortly." });
        const stillLimited = await s.request(REQUEST_HISTORY_PATH);
        expect(stillLimited.status).toBe(429);
        expect(stillLimited.headers.get("cache-control")).toBe("no-store");

        s.context.beginShutdown();
        for (const [url, init] of [
            [REQUEST_HISTORY_PATH, {}],
            [`${REQUEST_HISTORY_PATH}/r1`, {}],
            [REQUEST_HISTORY_PATH, { method: "DELETE" }],
            [`${REQUEST_HISTORY_PATH}/`, {}],
        ] as [string, RequestInit][]) {
            const refused = await s.request(url, init);
            expect(refused.status, url).toBe(503);
            expect(refused.headers.get("retry-after")).toBe("5");
            expect(refused.headers.get("connection")).toBe("close");
            expect(refused.headers.get("cache-control")).toBe("no-store");
            expect(await refused.json()).toEqual({ error: "The server is shutting down" });
        }
        // A sibling path is not the history: no refusal, no no-store.
        const sibling = await s.request("/api/request-historyx");
        expect(sibling.status).toBe(404);
        expect(sibling.headers.get("cache-control")).toBeNull();
        await s.context.dispose();
        expect(s.context.requestHistory.available()).toBe(false);
        // Disposed: still the shutdown refusal, before the store is looked at.
        const disposed = await listRaw(s);
        expect(disposed.status).toBe(503);
        expect(await disposed.json()).toEqual({ error: "The server is shutting down" });
    });
});

describe("the settings", () => {
    it("requestHistoryContent is read when a request begins: off makes the new row a summary while an older row keeps its content; a record written without it reads as on", async () => {
        const s = await server();
        const history = s.context.requestHistory;
        expect((await readProviders(s)).data).toMatchObject({
            requestHistoryContent: true,
            requestHistoryLimit: REQUEST_HISTORY_DEFAULT_LIMIT,
        });
        history.begin(row("old", { prompt: "p" }));
        const on = await admittedRequest(s);
        expect(history.get(on)).toMatchObject({ content: true, status: "error", source: "tab" });

        expect(await setProviders(s, { requestHistoryContent: false })).toMatchObject({ requestHistoryContent: false });
        const off = await admittedRequest(s);
        expect(history.get(off)).toMatchObject({ content: false, status: "error", prompt: null, exchanges: null });
        expect((await (await get(s, "old")).json()) as RequestHistoryRecord).toMatchObject({
            content: true,
            prompt: '"p"',
            exchanges: [],
        });
        expect((await (await get(s, on)).json()) as RequestHistoryRecord).toMatchObject({ content: true });

        // The field left out of a write: the normalizer's default, on.
        expect(await setProviders(s, { requestHistoryContent: undefined })).toMatchObject({
            requestHistoryContent: true,
        });
        const again = await admittedRequest(s);
        expect(history.get(again)).toMatchObject({ content: true });
        expect(history.get(off)).toMatchObject({ content: false });
        expect(warn).not.toHaveBeenCalled();
    });

    it("requestHistoryLimit is read at every prune: a cap of 10 prunes at the next write, a value under 10 reads as 10, a record written without it reads as 1,000", async () => {
        const s = await server();
        const history = s.context.requestHistory;
        const named = (count: number, from = 1) => Array.from({ length: count }, (_, i) => `r${from + i}`);
        begin(s, named(12));
        expect(history.stats().rows).toBe(12);

        // The setting alone prunes nothing; the next write does.
        await setProviders(s, { requestHistoryLimit: REQUEST_HISTORY_MIN_LIMIT });
        expect(history.stats().rows).toBe(12);
        begin(s, ["r13"]);
        expect(history.stats().rows).toBe(REQUEST_HISTORY_MIN_LIMIT);
        expect(await ids(s)).toEqual(named(10, 4).reverse());

        // Under the minimum: clamped to 10.
        await setProviders(s, { requestHistoryLimit: 1 });
        begin(s, ["r14"]);
        expect(history.stats().rows).toBe(REQUEST_HISTORY_MIN_LIMIT);
        expect(await ids(s)).toEqual(named(10, 5).reverse());

        // Raised: the history grows to the new cap.
        await setProviders(s, { requestHistoryLimit: 12 });
        begin(s, ["r15", "r16", "r17"]);
        expect(history.stats().rows).toBe(12);
        expect(await ids(s)).toEqual(named(12, 6).reverse());

        // Left out of a write: the default, 1,000.
        expect(await setProviders(s, { requestHistoryLimit: undefined })).toMatchObject({
            requestHistoryLimit: REQUEST_HISTORY_DEFAULT_LIMIT,
        });
        begin(s, ["r18", "r19"]);
        expect(history.stats().rows).toBe(14);
        expect(warn).not.toHaveBeenCalled();
    });
});
