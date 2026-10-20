// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import {
    MESSAGE_SEARCH_MAX_LIMIT,
    MESSAGE_SEARCH_PATH,
    type MessageSearchHit,
    type MessageSearchPage,
} from "../../../shared/messageSearch.ts";
import { createServerContext } from "../app.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import type { MessageSearchRouteOptions } from "../routes/messageSearch.ts";
import { createSigner, json, TEST_INDEX_HTML } from "./testSupport.ts";

/**
 * `POST /api/chats/search` (archived `docs/plan/search.md` slice 4a). The server is built with
 * `createServerContext({ messageSearch })` directly: the yield between batches is a latch the test
 * holds and releases, and the batch and request limits are small, so paging and the between-batch
 * checks are reached without any real time passing.
 */

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

type SearchServer = Awaited<ReturnType<typeof createSearchServer>>;
// Structural element types: the fixtures push themselves here, so their inferred types cannot be used.
const servers: { close(): Promise<void> }[] = [];
const gates: { release(): void }[] = [];
afterEach(async () => {
    // Parked searches must continue before dispose waits for them.
    for (const gate of gates.splice(0)) {
        gate.release();
    }
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A search that keeps yielding without progress fails its request instead of hanging the test. */
const MAX_YIELDS = 5000;

type YieldGate = ReturnType<typeof createYieldGate>;

/** The injected `yieldTurn`: open (resolves at once) or holding every search that reaches a yield. */
function createYieldGate() {
    let holding = false;
    const parked: (() => void)[] = [];
    let arrivals: (() => void)[] = [];
    const gate = {
        yields: 0,
        /** How many searches wait at a yield now. */
        get parkedCount() {
            return parked.length;
        },
        yieldTurn(): Promise<void> {
            gate.yields += 1;
            if (gate.yields > MAX_YIELDS) {
                throw new Error("The search yielded without progress");
            }
            if (!holding) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
                parked.push(resolve);
                const waiting = arrivals;
                arrivals = [];
                for (const wake of waiting) {
                    wake();
                }
            });
        },
        hold() {
            holding = true;
        },
        /** Resolves once `count` searches wait at a yield. */
        async parked(count: number) {
            while (parked.length < count) {
                await new Promise<void>((resolve) => arrivals.push(resolve));
            }
        },
        /** Lets every parked search continue; later yields resolve at once. */
        release() {
            holding = false;
            for (const wake of parked.splice(0)) {
                wake();
            }
        },
    };
    gates.push(gate);
    return gate;
}

type ErrorBody = { error: string; reason?: string };

async function createSearchServer(messageSearch: MessageSearchRouteOptions = {}) {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-message-search-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    const context = createServerContext({ rootDir, messageSearch });
    const signer = await createSigner();
    await context.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    const s = {
        context,
        app: context.app,
        epoch: "",
        async headers(extra: Record<string, string> = {}) {
            return { "risu-auth": await signer.jwt(), ...extra };
        },
        async request(url: string, init: RequestInit = {}) {
            return context.app.request(url, {
                ...init,
                headers: await s.headers((init.headers as Record<string, string> | undefined) ?? {}),
            });
        },
        async json(url: string, body: unknown, init: RequestInit = {}) {
            return s.request(url, {
                method: "POST",
                ...init,
                headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
                body: JSON.stringify(body),
            });
        },
        async readEpoch() {
            const res = await s.request("/api/resources/ui");
            s.epoch = ((await res.json()) as { epoch: string }).epoch;
            return s.epoch;
        },
        search(body: unknown, init: RequestInit = {}) {
            return s.json(MESSAGE_SEARCH_PATH, body, init);
        },
        async page(body: unknown): Promise<MessageSearchPage> {
            const res = await s.search(body);
            expect(res.status, await res.clone().text()).toBe(200);
            return (await res.json()) as MessageSearchPage;
        },
        /** Every page of a search in order (`limit` and the scope from `body`), as `chatId/messageId`. */
        async allPages(body: Record<string, unknown>) {
            const pages: MessageSearchPage[] = [];
            let cursor: string | null = null;
            do {
                const page: MessageSearchPage = await s.page({ ...body, ...(cursor ? { cursor } : {}) });
                pages.push(page);
                cursor = page.next;
            } while (cursor);
            return pages;
        },
        /** A resource batch with the current epoch; returns the body. */
        async batch(body: Record<string, unknown>) {
            const res = await s.json("/api/resources/batch", body, { headers: { "x-resource-epoch": s.epoch } });
            expect(res.status, await res.clone().text()).toBe(200);
            return (await res.json()) as {
                results: { revision: string | null }[];
                chats?: { revision: string | null }[];
            };
        },
        async close() {
            await context.dispose();
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
    await s.readEpoch();
    servers.push(s);
    return s;
}

const refs = (page: MessageSearchPage) => page.hits.map((hit) => `${hit.chatId}/${hit.messageId}`);
const allRefs = (pages: MessageSearchPage[]) => pages.flatMap(refs);
const m = (id: string, data: string, role: "user" | "char" = "user", time?: number) => ({
    role,
    data,
    chatId: id,
    ...(time === undefined ? {} : { time }),
});
const character = (id: string, extra: Record<string, unknown> = {}) => ({
    kind: "characters",
    id,
    baseRevision: null,
    data: { chaId: id, name: `Name of ${id}`, ...extra },
});
const createChat = (characterId: string, chatId: string, messages: unknown[], name = chatId.toUpperCase()) => ({
    characterId,
    chatId,
    baseRevision: null,
    ops: [{ op: "create", chat: { name, message: messages } }],
});
const group = (characterId: string, chatId: string, baseRevision: string, ops: ChatOp[]) => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});

/** The folded match the snippet offsets point at. */
const matched = (hit: MessageSearchHit) => hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Characters `c` (chats `k`: k1 "hit one", k2 "hit two", k3 no match; `j`: j1 "hit three"), `d`
 * (chat `dk`: d1 "hit four"), a trashed `t` (chat `tk`: t1), and the playground (chat `pk`: p1), the
 * chats created in that order (so `seq` ascending k, j, dk, tk, pk).
 */
async function seedWorld(s: SearchServer) {
    await s.batch({
        ops: [character("c"), character("d"), character("t", { trashTime: 1 }), character("§playground")],
    });
    await s.batch({
        chats: [
            createChat("c", "k", [
                m("k1", "hit one", "user", 1000),
                m("k2", "hit two", "char"),
                m("k3", "nothing here"),
            ]),
        ],
    });
    await s.batch({ chats: [createChat("c", "j", [m("j1", "hit three")])] });
    await s.batch({ chats: [createChat("d", "dk", [m("d1", "hit four")])] });
    await s.batch({ chats: [createChat("t", "tk", [m("t1", "hit trashed")])] });
    await s.batch({ chats: [createChat("§playground", "pk", [m("p1", "hit playground")])] });
}

describe("POST /api/chats/search hits", () => {
    it("finds Korean and English text with snippets whose offsets point at the match, newest chat and message first", async () => {
        const s = await createSearchServer();
        const english = `${"p".repeat(100)}WORLD${"s".repeat(200)}`;
        await s.batch({ ops: [character("c")] });
        await s.batch({
            chats: [
                createChat(
                    "c",
                    "k",
                    [m("k1", english, "char", 1234), m("k2", "안녕하세요 세계", "user")],
                    "First chat",
                ),
            ],
        });
        await s.batch({ chats: [createChat("c", "j", [m("j1", "the world is round")], "Second chat")] });

        const en = await s.page({ query: "world" });
        expect(refs(en)).toEqual(["j/j1", "k/k1"]);
        expect(en.next).toBeNull();
        expect(en.scannedBytes).toBeGreaterThan(english.length);
        const [second, first] = en.hits;
        expect(second).toMatchObject({
            characterId: "c",
            chatId: "j",
            messageId: "j1",
            chatName: "Second chat",
            characterName: "Name of c",
            role: "user",
            snippet: "the world is round",
            matchStart: 4,
            matchLength: 5,
        });
        expect(second.time).toBeUndefined();
        expect(first).toMatchObject({
            chatName: "First chat",
            role: "char",
            time: 1234,
            snippet: english.slice(40, 225),
            matchStart: 60,
            matchLength: 5,
        });
        expect(matched(first)).toBe("WORLD");

        const ko = await s.page({ query: "세계" });
        expect(refs(ko)).toEqual(["k/k2"]);
        expect(ko.hits[0]).toMatchObject({ snippet: "안녕하세요 세계", matchStart: 6, matchLength: 2 });
        expect(matched(ko.hits[0])).toBe("세계");
        expect(ko.hits[0].time).toBeUndefined();
    });

    it("folds ASCII case only and never splits a surrogate pair at a snippet edge", async () => {
        const s = await createSearchServer();
        const emoji = `${"😀".repeat(40)}xneedley${"😀".repeat(70)}`;
        await s.batch({ ops: [character("c")] });
        await s.batch({
            chats: [createChat("c", "k", [m("a", "Mixed Case Words"), m("b", "ÄÖÜ upper"), m("c", emoji)])],
        });

        const folded = await s.page({ query: "mIXED cASE" });
        expect(refs(folded)).toEqual(["k/a"]);
        expect(matched(folded.hits[0])).toBe("Mixed Case");
        // SQLite's `LIKE` folds ASCII letters only; the snippet lookup agrees with it.
        expect(refs(await s.page({ query: "äöü" }))).toEqual([]);

        const cut = await s.page({ query: "NEEDLE" });
        expect(refs(cut)).toEqual(["k/c"]);
        const hit = cut.hits[0];
        expect(hit.snippet).toBe(emoji.slice(22, 206));
        expect(hit.snippet).not.toMatch(loneSurrogate);
        expect(hit.matchStart).toBe(59);
        expect(matched(hit)).toBe("needle");
    });

    it("matches %, _ and backslash in the query literally", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c")] });
        await s.batch({
            chats: [
                createChat("c", "k", [
                    m("a", "100% sure"),
                    m("b", "100x sure"),
                    m("c", "a_b"),
                    m("d", "aXb"),
                    m("e", "c\\d path"),
                    m("f", "cXd path"),
                ]),
            ],
        });
        expect(refs(await s.page({ query: "0% s" }))).toEqual(["k/a"]);
        expect(refs(await s.page({ query: "a_b" }))).toEqual(["k/c"]);
        expect(refs(await s.page({ query: "c\\d" }))).toEqual(["k/e"]);
        expect(refs(await s.page({ query: "d path" }))).toEqual(["k/f", "k/e"]);
    });

    it("scopes by character and by chat, skips trashed and playground characters without a scope, and searches a named trashed one", async () => {
        const s = await createSearchServer();
        await seedWorld(s);
        expect(refs(await s.page({ query: "hit" }))).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
        expect(refs(await s.page({ query: "hit", characterId: "c" }))).toEqual(["j/j1", "k/k2", "k/k1"]);
        expect(refs(await s.page({ query: "hit", characterId: "c", chatId: "k" }))).toEqual(["k/k2", "k/k1"]);
        expect(refs(await s.page({ query: "hit", characterId: "t" }))).toEqual(["tk/t1"]);
        expect(refs(await s.page({ query: "hit", characterId: "§playground" }))).toEqual(["pk/p1"]);
        expect(refs(await s.page({ query: "hit", characterId: "§playground", chatId: "pk" }))).toEqual(["pk/p1"]);
    });

    it("clamps limit to the maximum", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c")] });
        const messages = Array.from({ length: MESSAGE_SEARCH_MAX_LIMIT + 1 }, (_, i) => m(`c${i}`, `clamp ${i}`));
        await s.batch({ chats: [createChat("c", "k", messages)] });
        const page = await s.page({ query: "clamp", limit: 500 });
        expect(page.hits).toHaveLength(MESSAGE_SEARCH_MAX_LIMIT);
        expect(page.next).not.toBeNull();
        const rest = await s.page({ query: "clamp", limit: 500, cursor: page.next });
        expect(refs(rest)).toEqual(["k/c0"]);
        expect(rest.next).toBeNull();
    });
});

describe("POST /api/chats/search paging", () => {
    it("returns every hit once and in order across limit-1 pages", async () => {
        const s = await createSearchServer();
        await seedWorld(s);
        const pages = await s.allPages({ query: "hit", limit: 1 });
        for (const page of pages.slice(0, 4)) {
            expect(page.hits).toHaveLength(1);
        }
        expect(allRefs(pages)).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
        expect(pages[pages.length - 1].next).toBeNull();
    });

    it("ends a page at the byte budget with fewer hits than limit and a cursor", async () => {
        const s = await createSearchServer({ budgetBytes: 1 });
        await seedWorld(s);
        const first = await s.page({ query: "hit", limit: 30 });
        expect(first.hits.length).toBeLessThan(30);
        expect(first.hits.length).toBeLessThanOrEqual(1);
        expect(first.next).not.toBeNull();
        expect(first.scannedBytes).toBeGreaterThan(0);
        const pages = await s.allPages({ query: "hit", limit: 30 });
        expect(allRefs(pages)).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
    });

    it("neither repeats nor loses a hit when a message is inserted before the anchor and texts change between pages", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c")] });
        const created = await s.batch({
            chats: [
                createChat(
                    "c",
                    "k",
                    [1, 2, 3, 4, 5].map((n) => m(`m${n}`, `hit ${n}`)),
                ),
            ],
        });
        const revision = created.chats![0].revision!;

        const first = await s.page({ query: "hit", limit: 1 });
        expect(refs(first)).toEqual(["k/m5"]);
        expect(first.next).not.toBeNull();

        // A message inserted after m2 shifts m3, m4, and the anchor m5 up by one; the anchor's own
        // text and m4's change (a checkpoint bumps the revision, not positions).
        await s.batch({
            chats: [
                group("c", "k", revision, [
                    { op: "append", messages: [m("n", "hit inserted")], anchor: { after: "m2" } },
                    { op: "setText", id: "m5", text: "hit 5 edited" },
                    { op: "setText", id: "m4", text: "HIT 4 edited" },
                ]),
            ],
        });

        const rest = await s.allPages({ query: "hit", limit: 1, cursor: first.next });
        expect(allRefs(rest)).toEqual(["k/m4", "k/m3", "k/n", "k/m2", "k/m1"]);
        expect(matched(rest[0].hits[0])).toBe("HIT");
    });

    it("continues below a cursor whose chat was deleted, without visiting its recreation", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c")] });
        await s.batch({ chats: [createChat("c", "j", [m("j1", "hit old")])] });
        const created = await s.batch({ chats: [createChat("c", "k", [m("k1", "hit k1"), m("k2", "hit k2")])] });
        const revision = created.chats![0].revision!;

        const first = await s.page({ query: "hit", limit: 1 });
        expect(refs(first)).toEqual(["k/k2"]);

        await s.batch({ chats: [group("c", "k", revision, [{ op: "delete" }])] });
        await s.batch({ chats: [createChat("c", "k", [m("k1", "hit again"), m("k9", "hit new incarnation")])] });

        const rest = await s.allPages({ query: "hit", limit: 1, cursor: first.next });
        expect(allRefs(rest)).toEqual(["j/j1"]);
        // A fresh search sees the new incarnation first.
        expect(refs(await s.page({ query: "hit" }))).toEqual(["k/k9", "k/k1", "j/j1"]);
    });

    it("drops the cursor's chat when its character was trashed between pages", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c"), character("d")] });
        await s.batch({ chats: [createChat("d", "dk", [m("d1", "hit d")])] });
        await s.batch({ chats: [createChat("c", "k", [m("k1", "hit 1"), m("k2", "hit 2"), m("k3", "hit 3")])] });
        const first = await s.page({ query: "hit", limit: 1 });
        expect(refs(first)).toEqual(["k/k3"]);

        const record = (await (await s.request("/api/resources/characters/c")).json()) as {
            revision: string;
            data: Record<string, unknown>;
        };
        await s.batch({
            ops: [
                { kind: "characters", id: "c", baseRevision: record.revision, data: { ...record.data, trashTime: 5 } },
            ],
        });

        const rest = await s.allPages({ query: "hit", limit: 1, cursor: first.next });
        expect(allRefs(rest)).toEqual(["dk/d1"]);
    });

    it("makes progress with one-unit batches over empty chats and skipped characters", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, batchBytes: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        for (const id of ["e1", "e2", "e3"]) {
            await s.batch({ chats: [createChat("c", id, [])] });
        }
        await s.batch({ chats: [createChat("t", "tk2", [m("t2", "hit trashed too")])] });
        await s.batch({ chats: [createChat("d", "dj", [m("d2", "hit five")])] });

        const page = await s.page({ query: "hit" });
        expect(refs(page)).toEqual(["dj/d2", "dk/d1", "j/j1", "k/k2", "k/k1"]);
        expect(page.next).toBeNull();
        expect(gate.yields).toBeGreaterThan(5);

        const pages = await s.allPages({ query: "hit", limit: 1 });
        expect(allRefs(pages)).toEqual(["dj/d2", "dk/d1", "j/j1", "k/k2", "k/k1"]);
        const scoped = await s.allPages({ query: "hit", characterId: "c", limit: 1 });
        expect(allRefs(scoped)).toEqual(["j/j1", "k/k2", "k/k1"]);
        expect(gate.yields).toBeLessThan(MAX_YIELDS);
    });
});

describe("POST /api/chats/search between batches", () => {
    it("lets another request's handler run while a search waits between batches", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        gate.hold();
        const pending = s.search({ query: "hit" });
        await gate.parked(1);

        // A resource read, and a search answered before its first batch (every other search of this
        // server would reach the held yield too).
        const read = await s.request("/api/resources/characters/c");
        expect(read.status).toBe(200);
        const other = await s.search({ query: "nothing", characterId: "nobody" });
        expect(other.status).toBe(404);
        expect(gate.parkedCount).toBe(1);

        gate.release();
        const res = await pending;
        expect(res.status).toBe(200);
        expect(refs((await res.json()) as MessageSearchPage)).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
    });

    it("answers 409 reason epoch when a restore replaced the data between batches", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        const snapshot = await s.context.snapshots.snapshotNow();
        gate.hold();
        const pending = s.search({ query: "hit" });
        await gate.parked(1);

        const restored = await s.request(`/api/backups/${snapshot.id}/restore`, {
            method: "POST",
            headers: { "x-resource-epoch": s.epoch },
        });
        expect(restored.status).toBe(200);
        gate.release();

        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect((await res.json()) as ErrorBody).toMatchObject({ reason: "epoch" });

        // The data is searchable again under the new epoch.
        await s.readEpoch();
        expect(refs(await s.page({ query: "hit" }))).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
    });

    it("answers 429 to a third concurrent search and frees the slots when the others end", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        gate.hold();
        const first = s.search({ query: "hit" });
        const second = s.search({ query: "hit", characterId: "c" });
        await gate.parked(2);

        const third = await s.search({ query: "hit" });
        expect(third.status).toBe(429);
        expect(third.headers.get("retry-after")).toBe("1");
        expect(third.headers.get("cache-control")).toBe("no-store");

        gate.release();
        expect((await first).status).toBe(200);
        expect((await second).status).toBe(200);
        expect((await s.search({ query: "hit" })).status).toBe(200);
    });

    it("answers 400 once the request was aborted between batches and frees its slot", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, maxConcurrent: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        gate.hold();
        const controller = new AbortController();
        const pending = s.search({ query: "hit" }, { signal: controller.signal });
        await gate.parked(1);
        expect((await s.search({ query: "hit" })).status).toBe(429);

        controller.abort();
        gate.release();
        const res = await pending;
        expect(res.status).toBe(400);
        expect((await res.json()) as ErrorBody).toEqual({ error: "The request was aborted" });
        expect((await s.search({ query: "hit" })).status).toBe(200);
    });

    it("answers 503 with Retry-After under maintenance, at admission and at the next batch", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        gate.hold();
        const pending = s.search({ query: "hit" });
        await gate.parked(1);

        await s.context.snapshots.withMaintenance(async () => {
            const refused = await s.search({ query: "hit" });
            expect(refused.status).toBe(503);
            expect(refused.headers.get("retry-after")).toBe("5");
            expect(refused.headers.get("cache-control")).toBe("no-store");
            gate.release();
            const ended = await pending;
            expect(ended.status).toBe(503);
            expect(ended.headers.get("retry-after")).toBe("5");
        });
        expect((await s.search({ query: "hit" })).status).toBe(200);
    });

    it("is refused during shutdown while a running search is waited for", async () => {
        const gate = createYieldGate();
        const s = await createSearchServer({ batchRows: 1, yieldTurn: gate.yieldTurn });
        await seedWorld(s);
        gate.hold();
        const pending = s.search({ query: "hit" });
        await gate.parked(1);

        const disposing = s.context.dispose();
        const refused = await s.app.request(MESSAGE_SEARCH_PATH, json({ query: "hit" }));
        expect(refused.status).toBe(503);
        expect((await refused.json()) as ErrorBody).toEqual({ error: "The server is shutting down" });

        gate.release();
        const res = await pending;
        expect(res.status).toBe(200);
        expect(refs((await res.json()) as MessageSearchPage)).toEqual(["dk/d1", "j/j1", "k/k2", "k/k1"]);
        await disposing;
    });
});

describe("POST /api/chats/search refusals", () => {
    const expect400 = async (s: SearchServer, body: unknown, error: string | RegExp) => {
        const res = await s.search(body);
        const text = await res.text();
        expect(res.status, text).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const parsed = JSON.parse(text) as ErrorBody;
        if (typeof error === "string") {
            expect(parsed.error).toBe(error);
        } else {
            expect(parsed.error).toMatch(error);
        }
    };

    it("answers 400 for a malformed body, query, id, cursor, or limit", async () => {
        const s = await createSearchServer();
        await seedWorld(s);
        const valid = (await s.page({ query: "hit", limit: 1 })).next!;

        await expect400(s, { query: "a" }, /2 to 200 characters/);
        await expect400(s, { query: "  h  " }, /2 to 200 characters/);
        await expect400(s, { query: "   " }, /2 to 200 characters/);
        // One code point after NFC (e + combining acute).
        await expect400(s, { query: "é" }, /2 to 200 characters/);
        await expect400(s, { query: "x".repeat(201) }, /2 to 200 characters/);
        await expect400(s, { query: "hi\u0000t" }, /well-formed/);
        await expect400(s, { query: "hi\ud800" }, /well-formed/);
        await expect400(s, { query: 12 }, "query must be a string");
        await expect400(s, {}, "query must be a string");
        await expect400(s, { query: "hit", extra: 1 }, "Unknown field: extra");
        await expect400(s, { query: "hit", chatId: "k" }, "chatId needs characterId");
        await expect400(s, { query: "hit", characterId: "bad\u0001id" }, "characterId must be an id");
        await expect400(s, { query: "hit", characterId: "c", chatId: "" }, "chatId must be an id");
        await expect400(s, { query: "hit", cursor: `!!${valid}!!` }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: `${valid}=` }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: Buffer.from('[0,"a",0]').toString("base64url") }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: Buffer.from('[1,"a",-1]').toString("base64url") }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: Buffer.from('[1,"a"]').toString("base64url") }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: Buffer.from("{}").toString("base64url") }, "Invalid cursor");
        await expect400(s, { query: "hit", cursor: 5 }, "Invalid cursor");
        await expect400(s, { query: "hit", limit: 0 }, "limit must be a positive integer");
        await expect400(s, { query: "hit", limit: 1.5 }, "limit must be a positive integer");
        await expect400(s, { query: "hit", limit: "5" }, "limit must be a positive integer");
        await expect400(s, ["hit"], "The body must be an object");
        await expect400(s, "hit", "Invalid JSON body");

        const malformed = await s.request(MESSAGE_SEARCH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
        });
        expect(malformed.status).toBe(400);
        // A 200-code-point query at the boundary is accepted.
        expect((await s.search({ query: "x".repeat(200) })).status).toBe(200);
        expect(refs(await s.page({ query: "hit", cursor: valid, limit: 1 }))).toEqual(["j/j1"]);
    });

    it("answers 404 for a named character or chat that does not exist", async () => {
        const s = await createSearchServer();
        await seedWorld(s);
        const missingCharacter = await s.search({ query: "hit", characterId: "nobody" });
        expect(missingCharacter.status).toBe(404);
        expect(missingCharacter.headers.get("cache-control")).toBe("no-store");
        expect((await missingCharacter.json()) as ErrorBody).toEqual({ error: "The character does not exist" });

        const missingChat = await s.search({ query: "hit", characterId: "c", chatId: "nope" });
        expect(missingChat.status).toBe(404);
        expect((await missingChat.json()) as ErrorBody).toEqual({ error: "The chat does not exist" });

        // Another character's chat is not this character's.
        expect((await s.search({ query: "hit", characterId: "d", chatId: "k" })).status).toBe(404);
        expect((await s.search({ query: "hit", characterId: "nobody", chatId: "k" })).status).toBe(404);
    });

    it("answers 400 No auth header without authentication, before reading the body", async () => {
        const s = await createSearchServer();
        const res = await s.app.request(MESSAGE_SEARCH_PATH, json({ query: "hit" }));
        expect(res.status).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect((await res.json()) as ErrorBody).toEqual({ error: "No auth header" });
        // The missing header, not the oversized body, decides.
        const big = await s.app.request(MESSAGE_SEARCH_PATH, json({ query: "x".repeat(5000) }));
        expect(big.status).toBe(400);
        expect((await big.json()) as ErrorBody).toEqual({ error: "No auth header" });
    });

    it("caps the body at 4 KiB of received bytes, whatever Content-Length declares", async () => {
        const s = await createSearchServer();
        const oversized = await s.search({ query: "hit", characterId: "x".repeat(5000) });
        expect(oversized.status).toBe(413);
        expect(oversized.headers.get("cache-control")).toBe("no-store");
        expect((await oversized.json()) as ErrorBody).toEqual({ error: "Request body too large" });

        const understated = await s.search(
            { query: "hit", characterId: "x".repeat(5000) },
            {
                headers: { "content-length": "20" },
            },
        );
        expect(understated.status).toBe(413);
        expect((await understated.json()) as ErrorBody).toEqual({ error: "Request body too large" });

        const declaredLarge = await s.search({ query: "hit" }, { headers: { "content-length": "99999" } });
        expect(declaredLarge.status).toBe(413);
    });

    it("sends Cache-Control no-store on every answer, the trailing-slash path included", async () => {
        const s = await createSearchServer();
        await seedWorld(s);
        const ok = await s.search({ query: "hit" });
        expect(ok.status).toBe(200);
        expect(ok.headers.get("cache-control")).toBe("no-store");
        const slash = await s.json(`${MESSAGE_SEARCH_PATH}/`, { query: "hit" });
        expect(slash.status).toBe(200);
        expect(slash.headers.get("cache-control")).toBe("no-store");
        const bad = await s.search({ query: "h" });
        expect(bad.status).toBe(400);
        expect(bad.headers.get("cache-control")).toBe("no-store");
    });
});

describe("POST /api/chats/search with malformed stored text (Challenge 1 and 2)", () => {
    it("does not report a stored lone surrogate as a hit for the replacement character", async () => {
        const s = await createSearchServer();
        await s.batch({ ops: [character("c")] });
        // Stored as the JSON escape `\ud800`; SQLite decodes it as U+FFFD, JavaScript keeps it.
        await s.batch({
            chats: [createChat("c", "k", [m("real", "a real �x here"), m("lone", "\ud800xx after")])],
        });
        const first = await s.page({ query: "�x", limit: 1 });
        expect(refs(first)).toEqual(["k/real"]);
        expect(matched(first.hits[0])).toBe("�x");
        const all = await s.allPages({ query: "�x", limit: 1 });
        expect(allRefs(all)).toEqual(["k/real"]);
        for (const hit of all.flatMap((page) => page.hits)) {
            expect(hit.matchLength).toBe(2);
        }
    });

    it("answers 400, not 500, when the body stream fails without a declared length", async () => {
        const s = await createSearchServer();
        const res = await s.request(MESSAGE_SEARCH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"query":'));
                    controller.error(new DOMException("The client went away", "AbortError"));
                },
            }),
            // Node's fetch needs `duplex` for a stream body.
            duplex: "half",
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
    });
});

describe("store.searchMessages inside a transaction (Challenge 3)", () => {
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const characters = kinds.get("characters")!;
    const stores: ResourceStore[] = [];
    afterEach(() => {
        for (const store of stores.splice(0)) {
            store.close();
        }
    });
    const limits = { budgetBytes: 1 << 30, batchRows: 1, batchBytes: 1 << 30 };

    it("refuses to start while a transaction is active, so a rolled-back name never reaches a hit", async () => {
        const store = createResourceStore({ file: ":memory:", kinds });
        stores.push(store);
        store.applyChanges({
            ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "committed" } }],
            chats: [createChat("c", "k", [m("a", "hit a"), m("b", "hit b")])],
        });
        const record = store.get(characters, "c")!;
        let pending: Promise<unknown> | undefined;
        let release!: () => void;
        const latch = new Promise<void>((resolve) => (release = resolve));
        expect(() =>
            store.transaction(() => {
                store.put(characters, "c", { ...(record.data as object), name: "ROLLED BACK" }, record.revision);
                try {
                    pending = store.searchMessages(
                        { query: "hit", cursor: null, limit: 10 },
                        { ...limits, yieldTurn: () => latch },
                    );
                } catch (error) {
                    pending = Promise.reject(error);
                }
                throw new Error("roll back");
            }),
        ).toThrow("roll back");
        release();
        await expect(pending!).rejects.toThrow();

        expect((store.get(characters, "c")!.data as { name: string }).name).toBe("committed");
        const outcome = await store.searchMessages(
            { query: "hit", cursor: null, limit: 10 },
            { ...limits, yieldTurn: () => Promise.resolve() },
        );
        expect("hits" in outcome && outcome.hits.map((hit) => hit.characterName)).toEqual(["committed", "committed"]);
    });
});
