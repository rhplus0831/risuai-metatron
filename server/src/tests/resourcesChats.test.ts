// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import {
    type BatchConflict,
    isChatConflict,
    isChatOrderConflict,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    type ResourceReadRefsAnswer,
    type ResourceReadRefsResult,
} from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { registerResourceRoutes } from "../routes/resources.ts";
import type { AppEnv } from "../types.ts";
import { createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

const servers: ResourceTestClient[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function defaultServer() {
    const s = await createResourceTestClient();
    servers.push(s);
    return s;
}

const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, baseRevision: string | null, ops: ChatOp[], characterId = "c") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
const createCharacter = (id: string) => ({ kind: "characters", id, baseRevision: null, data: { chaId: id } });
const post = async (s: ResourceTestClient, body: unknown, epoch?: string | null) => {
    const res = await s.json("/api/resources/batch", body, {}, epoch);
    return {
        status: res.status,
        body: (await res.json()) as ResourceBatchResult & { error?: string; conflicts?: BatchConflict[] },
    };
};
const readAll = async (s: ResourceTestClient) =>
    (await (await s.request("/api/resources?kinds=characters&chats=1")).json()) as ResourceReadKindsResult;

/** A character `c` with chat `k` (messages a, b) over the route; returns the tokens. */
async function seed(s: ResourceTestClient) {
    const r = await post(s, {
        ops: [createCharacter("c")],
        chats: [
            group("k", null, [{ op: "create", chat: { name: "K", message: [m("a", "A"), m("b", "B")] } as never }]),
        ],
    });
    expect(r.status).toBe(200);
    return {
        character: r.body.results[0].revision!,
        chat: r.body.chats![0].revision!,
        order: r.body.chatOrders![0].revision,
    };
}

function defer() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

describe("POST /api/resources/batch with chats", () => {
    it("creates a character with its chat in one body, answers the chat and order results, and reads them back", async () => {
        const s = await defaultServer();
        const r = await post(s, {
            ops: [createCharacter("c")],
            chats: [
                group("k", null, [
                    {
                        op: "create",
                        chat: { name: "K", message: [m("a", "A"), { role: "char", data: "no id" } as never] } as never,
                    },
                    { op: "meta", set: { note: "n" } },
                ]),
            ],
        });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({
            epoch: s.epoch,
            // Revision 1 of a new incarnation; the seq comes after the materialized singleton rows.
            results: [{ kind: "characters", id: "c", revision: expect.stringMatching(/:\d+:1$/) }],
            chats: [
                {
                    characterId: "c",
                    id: "k",
                    revision: expect.stringMatching(/:1:2$/),
                    messageIds: ["a", expect.stringMatching(/^[0-9a-f-]{36}$/)],
                },
            ],
            chatOrders: [{ characterId: "c", revision: expect.stringMatching(/:1:2$/), ids: ["k"] }],
        });
        const generated = r.body.chats![0].messageIds![1];
        // A chat-only batch: `results` is empty, and the response spreads the chat parts.
        const edit = await post(s, {
            chats: [
                group("k", r.body.chats![0].revision, [
                    { op: "append", messages: [m("r", "", "char")], anchor: { end: true } },
                    { op: "begin", id: "r", generationId: "g" },
                    { op: "setText", id: "r", text: "streamed", generation: { id: "g", seq: 1 } },
                ]),
            ],
        });
        expect(edit.status).toBe(200);
        expect(edit.body).toEqual({
            epoch: s.epoch,
            results: [],
            chats: [{ characterId: "c", id: "k", revision: expect.stringMatching(/:1:5$/), checkpoints: ["applied"] }],
            chatOrders: [],
        });

        const all = await readAll(s);
        expect(all.kinds.characters).toEqual([
            { id: "c", revision: r.body.results[0].revision, data: normalizeCharacter({ chaId: "c" }) },
        ]);
        expect(all.chats).toEqual([
            {
                characterId: "c",
                id: "k",
                revision: edit.body.chats![0].revision,
                data: {
                    id: "k",
                    name: "K",
                    note: "n",
                    localLore: [],
                    fmIndex: -1,
                    message: [
                        m("a", "A"),
                        { role: "char", data: "no id", chatId: generated },
                        m("r", "streamed", "char"),
                    ],
                },
                streaming: [],
            },
        ]);
        expect(all.chatOrders).toEqual([{ characterId: "c", revision: r.body.chatOrders![0].revision, ids: ["k"] }]);
        // Without `chats=1` the response has no chat parts; another value is refused.
        const plain = (await (await s.request("/api/resources?kinds=characters")).json()) as ResourceReadKindsResult;
        expect(plain).not.toHaveProperty("chats");
        expect(plain).not.toHaveProperty("chatOrders");
        for (const value of ["0", "true", ""]) {
            const bad = await s.request(`/api/resources?kinds=characters&chats=${value}`);
            expect(bad.status, value).toBe(400);
            expect(await bad.json(), value).toEqual({ error: "chats query parameter must be 1" });
        }
        expect((await s.request("/api/resources?chats=1")).status).toBe(400);

        // Ref reads: single chats (missing ones with null) and whole collections (unknown character: null order).
        const refs = await s.json("/api/resources/read", {
            chats: [
                { characterId: "c", id: "k" },
                { characterId: "c", id: "zz" },
            ],
            chatCollections: ["c", "nobody"],
        });
        expect(refs.status).toBe(200);
        const body = (await refs.json()) as ResourceReadRefsResult;
        expect(body).toEqual({
            epoch: s.epoch,
            items: [],
            chats: [all.chats![0], { characterId: "c", id: "zz", revision: null, data: null }],
            chatCollections: [
                { characterId: "c", order: all.chatOrders![0], chats: [all.chats![0]] },
                { characterId: "nobody", order: null, chats: [] },
            ],
        });
        for (const [label, ref, error] of [
            ["chat ref not an object", { chats: ["k"] }, "chats[0] must name a valid characterId and id"],
            [
                "chat ref invalid id",
                { chats: [{ characterId: "c", id: "" }] },
                "chats[0] must name a valid characterId and id",
            ],
            [
                "chat ref later",
                {
                    chats: [
                        { characterId: "c", id: "k" },
                        { characterId: 1, id: "k" },
                    ],
                },
                "chats[1] must name a valid characterId and id",
            ],
            ["collection not an id", { chatCollections: [1] }, "chatCollections must be character ids"],
            ["collection invalid id", { chatCollections: [".."] }, "chatCollections must be character ids"],
            ["chats not an array", { chats: {} }, "Body must be { refs?, chats?, chatCollections? } of arrays"],
            [
                "collections not an array",
                { chatCollections: "c" },
                "Body must be { refs?, chats?, chatCollections? } of arrays",
            ],
            ["nothing named", { refs: [], chats: [], chatCollections: [] }, "Body must name 1 to 5000 entries"],
            [
                "too many across lists",
                {
                    refs: Array.from({ length: 2500 }, () => ({ kind: "characters", id: "c" })),
                    chatCollections: Array.from({ length: 2501 }, () => "c"),
                },
                "Body must name 1 to 5000 entries",
            ],
        ] as [string, unknown, string][]) {
            const bad = await s.json("/api/resources/read", ref);
            expect(bad.status, label).toBe(400);
            expect(await bad.json(), label).toEqual({ error });
        }
    });

    it("answers 409 with every conflict of the mixed union and applies nothing", async () => {
        const s = await defaultServer();
        const tokens = await seed(s);
        const before = await readAll(s);
        const stale = (token: string) => token.replace(/:\d+$/, ":9");
        const r = await post(s, {
            ops: [
                { kind: "characters", id: "c", baseRevision: stale(tokens.character), data: { chaId: "c", name: "x" } },
                createCharacter("d"),
            ],
            chats: [
                group("k", stale(tokens.chat), [{ op: "delete" }]),
                group("gone", tokens.chat, [{ op: "setText", id: "a", text: "x" }]),
                group("n", null, [{ op: "create", chat: {} as never }]),
                group("e", null, [{ op: "create", chat: {} as never }], "d"),
            ],
            chatOrders: [
                { characterId: "c", baseRevision: stale(tokens.order), ids: ["k"] },
                { characterId: "nobody", baseRevision: tokens.order, ids: [] },
            ],
        });
        expect(r.status).toBe(409);
        const conflicts = r.body.conflicts!;
        expect(r.body.error).toBe("Revision conflict");
        expect(conflicts).toEqual([
            { kind: "characters", id: "c", revision: tokens.character },
            { kind: "chat", characterId: "c", id: "k", revision: tokens.chat },
            { kind: "chat", characterId: "c", id: "gone", revision: null },
            // `d` was not created (the batch conflicted), so its chat has no parent.
            { kind: "chat", characterId: "d", id: "e", revision: null },
            { kind: "chatOrder", characterId: "c", revision: tokens.order },
            { kind: "chatOrder", characterId: "nobody", revision: null },
        ]);
        expect(conflicts.filter(isChatConflict).map((c) => c.id)).toEqual(["k", "gone", "e"]);
        expect(conflicts.filter(isChatOrderConflict).map((c) => c.characterId)).toEqual(["c", "nobody"]);
        expect(conflicts.filter((c) => !isChatConflict(c) && !isChatOrderConflict(c))).toEqual([
            { kind: "characters", id: "c", revision: tokens.character },
        ]);
        expect(await readAll(s)).toEqual(before);
        // Only stale chat and order entries: same status, only their kinds.
        const chatsOnly = await post(s, {
            chats: [group("k", stale(tokens.chat), [{ op: "replace", chat: {} as never }])],
            chatOrders: [{ characterId: "c", baseRevision: stale(tokens.order), ids: ["k"] }],
        });
        expect(chatsOnly.status).toBe(409);
        expect(chatsOnly.body.conflicts!.map((c) => c.kind)).toEqual(["chat", "chatOrder"]);
        expect(await readAll(s)).toEqual(before);
    });

    it("refuses malformed chat envelopes, illegal op combinations, and oversized batches with 400", async () => {
        const s = await defaultServer();
        const tokens = await seed(s);
        const before = await readAll(s);
        const cases: [string, unknown, string][] = [
            // Alone, a non-array counts zero operations and fails the envelope check (below); beside
            // an op it reaches the store.
            ["ops not an array", { ops: "x", chats: [] }, "ops must be an array"],
            ["chats not an array", { ops: [createCharacter("x")], chats: {} }, "chats must be an array"],
            ["chatOrders not an array", { ops: [createCharacter("x")], chatOrders: {} }, "chatOrders must be an array"],
            ["group not an object", { chats: [1] }, "chats[0]: must name a valid characterId and chatId"],
            [
                "group without ops",
                { chats: [{ characterId: "c", chatId: "k", baseRevision: tokens.chat }] },
                "chats[0]: ops must be a non-empty array",
            ],
            ["empty ops", { chats: [group("k", tokens.chat, [])] }, "chats[0]: ops must be a non-empty array"],
            [
                "delete with another op",
                { chats: [group("k", tokens.chat, [{ op: "delete" }, { op: "meta", set: { note: "x" } }])] },
                "chats[0]: delete must be the only op",
            ],
            [
                "create not first",
                {
                    chats: [
                        group("n", null, [
                            { op: "meta", set: {} },
                            { op: "create", chat: {} as never },
                        ]),
                    ],
                },
                "chats[0]: create must be the first op",
            ],
            [
                "create with a base",
                { chats: [group("n", tokens.chat, [{ op: "create", chat: {} as never }])] },
                "chats[0]: baseRevision must be null for a create and a revision string otherwise",
            ],
            [
                "edit without a base",
                { chats: [group("k", null, [{ op: "meta", set: {} }])] },
                "chats[0]: baseRevision must be null for a create and a revision string otherwise",
            ],
            [
                "same chat twice",
                {
                    chats: [
                        group("k", tokens.chat, [{ op: "meta", set: {} }]),
                        group("k", tokens.chat, [{ op: "meta", set: {} }]),
                    ],
                },
                "chats[1]: duplicate chat",
            ],
            [
                "meta on message",
                { chats: [group("k", tokens.chat, [{ op: "meta", set: { message: [] } }])] },
                "chats[0].ops[0]: chat meta cannot change message",
            ],
            [
                "meta on id",
                { chats: [group("k", tokens.chat, [{ op: "meta", unset: ["id"] }])] },
                "chats[0].ops[0]: chat meta cannot change id",
            ],
            [
                "unknown op",
                { chats: [group("k", tokens.chat, [{ op: "shuffle" } as never])] },
                "chats[0].ops[0]: unknown op shuffle",
            ],
            [
                "bad anchor",
                { chats: [group("k", tokens.chat, [{ op: "append", messages: [m("x")], anchor: {} as never }])] },
                "chats[0].ops[0]: append.anchor must be { start: true }, { end: true }, or { after: id }",
            ],
            [
                "append without ids",
                {
                    chats: [
                        group("k", tokens.chat, [
                            { op: "append", messages: [{ role: "user", data: "x" } as never], anchor: { end: true } },
                        ]),
                    ],
                },
                "chats[0].ops[0]: message.chatId must be a valid id",
            ],
            [
                "setText wrong type",
                { chats: [group("k", tokens.chat, [{ op: "setText", id: "a", text: 1 } as never])] },
                "chats[0].ops[0]: setText must be { id, text }",
            ],
            [
                "bad generation",
                {
                    chats: [
                        group("k", tokens.chat, [
                            { op: "setText", id: "a", text: "t", generation: { id: "g", seq: -1 } },
                        ]),
                    ],
                },
                "chats[0].ops[0]: generation must be { id, seq, final? }",
            ],
            [
                "order without ids",
                { chatOrders: [{ characterId: "c", baseRevision: tokens.order }] },
                "chatOrders[0]: ids must be a duplicate-free array of chat ids",
            ],
            [
                "order not a permutation",
                { chatOrders: [{ characterId: "c", baseRevision: tokens.order, ids: ["k", "zz"] }] },
                "chatOrders for c: ids must be a permutation of the character's chats",
            ],
            [
                "deletes the character and edits its chat",
                {
                    ops: [{ kind: "characters", id: "c", baseRevision: tokens.character, delete: true }],
                    chats: [group("k", tokens.chat, [{ op: "meta", set: { note: "x" } }])],
                },
                "the batch deletes character c and also changes its chats",
            ],
            [
                "deletes the character and reorders",
                {
                    ops: [{ kind: "characters", id: "c", baseRevision: tokens.character, delete: true }],
                    chatOrders: [{ characterId: "c", baseRevision: tokens.order, ids: ["k"] }],
                },
                "the batch deletes character c and also changes its chats",
            ],
            [
                "meta value the normalizer refuses",
                { chats: [group("k", tokens.chat, [{ op: "meta", set: { note: 1 } }])] },
                "chats[0].ops[0]: chat.name and chat.note must be strings",
            ],
        ];
        for (const [label, body, error] of cases) {
            const r = await post(s, body);
            expect(r.status, label).toBe(400);
            expect(r.body, label).toEqual({ error });
        }
        // The cap counts nested chat ops and reorders; a malformed group counts as one.
        const envelope = "Body must be { ops?, chats?, chatOrders? } with 1 to 5000 operations";
        const meta = (n: number) => Array.from({ length: n }, (): ChatOp => ({ op: "meta", set: { note: "x" } }));
        for (const [label, body] of [
            ["nothing", {}],
            ["chats not an array, alone", { chats: {} }],
            ["empty lists", { ops: [], chats: [], chatOrders: [] }],
            ["5,001 nested", { chats: [group("k", tokens.chat, meta(5001))] }],
            [
                "4,999 nested + 2 ops",
                { ops: [createCharacter("x"), createCharacter("y")], chats: [group("k", tokens.chat, meta(4999))] },
            ],
            [
                "5,000 nested + a reorder",
                {
                    chats: [group("k", tokens.chat, meta(5000))],
                    chatOrders: [{ characterId: "c", baseRevision: tokens.order, ids: ["k"] }],
                },
            ],
            ["5,001 malformed groups", { chats: Array.from({ length: 5001 }, () => 1) }],
        ] as [string, unknown][]) {
            const r = await post(s, body);
            expect(r.status, label).toBe(400);
            expect(r.body, label).toEqual({ error: envelope });
        }
        expect(await readAll(s)).toEqual(before);
        const full = await post(s, { chats: [group("k", tokens.chat, meta(5000))] });
        expect(full.status).toBe(200);
        expect(full.body.chats![0].revision).toBe(tokens.chat.replace(/:\d+$/, ":5001"));
    });

    it("fences chat bodies on auth, the epoch header, and maintenance, while reads stay open", async () => {
        const s = await defaultServer();
        const tokens = await seed(s);
        const before = await readAll(s);
        const chatBody = { chats: [group("k", tokens.chat, [{ op: "meta", set: { note: "x" } }] as ChatOp[])] };
        const readBody = { chats: [{ characterId: "c", id: "k" }] };
        for (const [url, body] of [
            ["/api/resources/batch", chatBody],
            ["/api/resources/read", readBody],
        ] as [string, unknown][]) {
            const res = await s.app.request(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-resource-epoch": s.epoch },
                body: JSON.stringify(body),
            });
            expect(res.status, url).toBe(400);
            expect(await res.json(), url).toEqual({ error: "No auth header" });
        }
        expect((await s.app.request("/api/resources?kinds=characters&chats=1")).status).toBe(400);
        for (const epoch of [null, "", "00000000-0000-4000-8000-000000000000"]) {
            const r = await post(s, chatBody, epoch);
            expect(r.status, String(epoch)).toBe(412);
            expect(r.body, String(epoch)).toEqual({ error: "EpochMismatch", epoch: s.epoch });
            const reorder = await post(
                s,
                { chatOrders: [{ characterId: "c", baseRevision: tokens.order, ids: ["k"] }] },
                epoch,
            );
            expect(reorder.status, String(epoch)).toBe(412);
        }
        // Reads never need the epoch.
        expect((await s.request("/api/resources?kinds=characters&chats=1", {}, null)).status).toBe(200);
        expect((await s.json("/api/resources/read", readBody, {}, null)).status).toBe(200);

        const inside = defer();
        const release = defer();
        const maintenance = s.context.snapshots.withMaintenance(async () => {
            inside.resolve();
            await release.promise;
        });
        await inside.promise;
        const closed = await post(s, chatBody);
        expect(closed.status).toBe(503);
        expect(closed.body).toEqual({ error: "Maintenance in progress" });
        expect((await s.request("/api/resources?kinds=characters&chats=1")).status).toBe(200);
        expect((await s.json("/api/resources/read", { chatCollections: ["c"] })).status).toBe(200);
        release.resolve();
        await maintenance;
        expect(await readAll(s)).toEqual(before);
        expect((await post(s, chatBody)).status).toBe(200);
    });

    it("deletes a character's chats and order through the DELETE route and the batch", async () => {
        const s = await defaultServer();
        const tokens = await seed(s);
        const d = await post(s, {
            ops: [createCharacter("d")],
            chats: [group("k", null, [{ op: "create", chat: { message: [m("x")] } as never }], "d")],
        });
        expect((await readAll(s)).chats).toHaveLength(2);
        const removed = await s.remove("characters", "c", `?baseRevision=${encodeURIComponent(tokens.character)}`);
        expect(removed.status).toBe(200);
        let all = await readAll(s);
        expect(all.chats!.map((c) => [c.characterId, c.id])).toEqual([["d", "k"]]);
        expect(all.chatOrders!.map((o) => o.characterId)).toEqual(["d"]);
        const batch = await post(s, {
            ops: [{ kind: "characters", id: "d", baseRevision: d.body.results[0].revision, delete: true }],
        });
        expect(batch.status).toBe(200);
        all = await readAll(s);
        expect(all).toEqual({ epoch: s.epoch, kinds: { characters: [] }, chats: [], chatOrders: [] });
        // The old chat token names nothing now: a chat-only write is a 409 with revision null.
        const late = await post(s, { chats: [group("k", tokens.chat, [{ op: "setText", id: "a", text: "x" }])] });
        expect(late.status).toBe(409);
        expect(late.body.conflicts).toEqual([{ kind: "chat", characterId: "c", id: "k", revision: null }]);
    });
});

const budgetStores: ReturnType<typeof createResourceStore>[] = [];
afterEach(() => {
    for (const store of budgetStores.splice(0)) store.close();
});

function budgetedChats(readResponseBytes: number) {
    const kinds = createKindRegistry([
        ...DEFAULT_RESOURCE_KINDS,
        { name: "docs", schemaVersion: 1, normalize: (input) => input },
    ]);
    const store = createResourceStore({ file: ":memory:", kinds });
    budgetStores.push(store);
    const app = new Hono<AppEnv>();
    registerResourceRoutes(app, {
        store,
        kinds,
        readResponseBytes,
        auth: { checkAuth: async () => null } as unknown as Parameters<typeof registerResourceRoutes>[1]["auth"],
        limiter: async (_c, next) => {
            await next();
        },
        maintenance: { active: false, assertOpen() {}, enter: () => () => {} },
    });
    store.put(kinds.get("docs")!, "zero", 0, null);
    return {
        store,
        kinds,
        seed: (id: string, chats: { id: string; name?: string; note?: string; message: ReturnType<typeof m>[] }[]) => {
            store.put(kinds.get("characters")!, id, { chaId: id, name: id }, null);
            store.applyChanges({
                chats: chats.map((chat) => group(chat.id, null, [{ op: "create", chat: chat as never }], id)),
            });
        },
        read: async (body: unknown) => {
            const response = await app.request("/api/resources/read", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as ResourceReadRefsAnswer;
        },
    };
}

const zeroRef = { kind: "docs", id: "zero" };
const chatIds = (read: ResourceReadRefsAnswer) => read.chats?.map(({ characterId, id }) => [characterId, id]);

describe("chat read budgets", () => {
    it.each([undefined, true])(
        "deduplicates chats and both collection lists with continuation %s",
        async (continuation) => {
            const s = budgetedChats(16 * 1024);
            for (const id of ["a", "b"]) s.seed(id, [{ id: "k", message: [m("m", id)] }]);
            const a = { characterId: "a", id: "k" };
            const b = { characterId: "b", id: "k" };
            const read = await s.read({
                chats: [a, b, a, b],
                chatCollections: ["b", "a", "b"],
                chatSummaryCollections: ["a", "b", "a"],
                continue: continuation,
            });
            expect(chatIds(read)).toEqual([
                ["a", "k"],
                ["b", "k"],
            ]);
            expect(read.chatCollections?.map(({ characterId }) => characterId)).toEqual(["b", "a"]);
            expect(read.chatSummaryCollections?.map(({ characterId }) => characterId)).toEqual(["a", "b"]);
            expect(read).not.toHaveProperty("unanswered");
        },
    );

    it("keeps an oversized character and its collections together at its first mention", async () => {
        const s = budgetedChats(1);
        for (const id of ["a", "b", "c"]) s.seed(id, [{ id: "k", message: [m("m", id)] }]);
        const refs = ["a", "b"].map((id) => ({ kind: "characters", id }));
        const chats = [{ characterId: "a", id: "k" }];
        const read = await s.read({
            refs,
            chats,
            chatCollections: ["b", "a", "c"],
            chatSummaryCollections: ["c", "a", "b"],
            continue: true,
        });
        expect(read.items.map(({ id }) => id)).toEqual(["a"]);
        expect(read.chats).toEqual([]);
        expect(read.chatCollections).toMatchObject([
            { characterId: "a", order: { ids: ["k"] }, chats: [{ id: "k", data: { message: [m("m", "a")] } }] },
        ]);
        expect(read.chatSummaryCollections).toMatchObject([{ characterId: "a", chats: [{ id: "k" }] }]);
        expect(read.unanswered).toEqual({
            refs: [refs[1]],
            chats,
            chatCollections: ["b", "c"],
            chatSummaryCollections: ["c", "b"],
        });
        const next = await s.read({ ...read.unanswered, continue: true });
        expect(next.items.map(({ id }) => id)).toEqual(["b"]);
        expect(next.chatCollections?.map(({ characterId }) => characterId)).toEqual(["b"]);
        expect(next.chatSummaryCollections?.map(({ characterId }) => characterId)).toEqual(["b"]);
        expect(next.unanswered).toEqual({ refs: [], chats, chatCollections: ["c"], chatSummaryCollections: ["c"] });
    });

    it("serves refs then individual chats then collections then summaries without skipping a blocked group", async () => {
        const s = budgetedChats(1);
        s.seed("a", [
            { id: "k", message: [m("m", "K")] },
            { id: "j", message: [m("m", "J")] },
        ]);
        s.seed("b", [{ id: "k", message: [m("m", "B")] }]);
        const chats = ["k", "j"].map((id) => ({ characterId: "a", id }));
        const request = { refs: [zeroRef], chats, chatCollections: ["a"], chatSummaryCollections: ["b"] };
        const whole = await s.read(request);
        expect(whole.items).toHaveLength(1);
        expect(chatIds(whole)).toEqual([
            ["a", "k"],
            ["a", "j"],
        ]);
        expect(whole.chatCollections?.[0].chats.map(({ id }) => id)).toEqual(["k", "j"]);
        expect(whole.chatSummaryCollections?.[0].chats.map(({ id }) => id)).toEqual(["k"]);
        expect(whole).not.toHaveProperty("unanswered");
        const first = await s.read({ ...request, continue: true });
        expect(first.items).toMatchObject([{ ...zeroRef, data: 0 }]);
        expect(first.unanswered).toEqual({ ...request, refs: [] });
        const second = await s.read({ ...first.unanswered, continue: true });
        expect(chatIds(second)).toEqual([["a", "k"]]);
        expect(second.unanswered).toEqual({
            refs: [],
            chats: [chats[1]],
            chatCollections: ["a"],
            chatSummaryCollections: ["b"],
        });
        const third = await s.read({ ...second.unanswered, continue: true });
        expect(chatIds(third)).toEqual([["a", "j"]]);
        const fourth = await s.read({ ...third.unanswered, continue: true });
        expect(fourth.chatCollections?.[0].chats.map(({ id }) => id)).toEqual(["k", "j"]);
        expect(fourth.unanswered).toEqual({ refs: [], chats: [], chatCollections: [], chatSummaryCollections: ["b"] });
        const fifth = await s.read({ ...fourth.unanswered, continue: true });
        expect(fifth.chatSummaryCollections).toMatchObject([{ characterId: "b", chats: [{ id: "k" }] }]);
        expect(fifth).not.toHaveProperty("unanswered");
    });

    it("leaves an over-budget collection unread until its next round", async () => {
        const prepare = DatabaseSync.prototype.prepare;
        let messageRows = 0;
        const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
            const statement = prepare.call(this, sql);
            if (sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position") {
                const all = statement.all;
                statement.all = function (...args) {
                    const rows = Reflect.apply(all, this, args);
                    messageRows += rows.length;
                    return rows;
                };
                const get = statement.get;
                statement.get = function (...args) {
                    const row = Reflect.apply(get, this, args);
                    if (row) messageRows++;
                    return row;
                };
                const iterate = statement.iterate;
                statement.iterate = function* (this: typeof statement, ...args: Parameters<typeof iterate>) {
                    for (const row of Reflect.apply(iterate, this, args)) {
                        messageRows++;
                        yield row;
                    }
                } as unknown as typeof iterate;
            }
            return statement;
        });
        try {
            const s = budgetedChats(1024);
            s.seed("a", [{ id: "k", message: [m("m1", "x".repeat(2048)), m("m2", "tail")] }]);
            messageRows = 0;
            const first = await s.read({ refs: [zeroRef], chatCollections: ["a"], continue: true });
            expect(first.unanswered).toEqual({
                refs: [],
                chats: [],
                chatCollections: ["a"],
                chatSummaryCollections: [],
            });
            expect(messageRows).toBe(0);
            const next = await s.read({ ...first.unanswered, continue: true });
            expect(next.chatCollections?.[0].chats[0].data.message).toEqual([
                m("m1", "x".repeat(2048)),
                m("m2", "tail"),
            ]);
            expect(messageRows).toBe(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("charges UTF-8 message bytes for both chats and whole collections", async () => {
        const s = budgetedChats(1024);
        s.seed("a", [{ id: "k", message: [m("m", "界".repeat(400))] }]);
        // 400 characters are 1,200 stored UTF-8 bytes before JSON and chat metadata.
        for (const entries of [{ chats: [{ characterId: "a", id: "k" }] }, { chatCollections: ["a"] }]) {
            const read = await s.read({ refs: [zeroRef], ...entries, continue: true });
            expect(read.chats).toEqual([]);
            expect(read.chatCollections).toEqual([]);
            expect(read.unanswered).toEqual({
                refs: [],
                chats: [],
                chatCollections: [],
                chatSummaryCollections: [],
                ...entries,
            });
        }
    });

    it("charges metadata once per chat even when it has several messages", async () => {
        const s = budgetedChats(3072);
        s.seed("a", [{ id: "k", note: "n".repeat(2048), message: [m("a", "A"), m("b", "B"), m("c", "C")] }]);
        // One 2 KiB note plus three small rows fits; charging the note per message does not.
        for (const entries of [{ chats: [{ characterId: "a", id: "k" }] }, { chatCollections: ["a"] }]) {
            const read = await s.read({ refs: [zeroRef], ...entries, continue: true });
            expect(read).not.toHaveProperty("unanswered");
            const chat = read.chats?.[0] ?? read.chatCollections?.[0].chats[0];
            expect(chat?.data).toMatchObject({
                note: "n".repeat(2048),
                message: [m("a", "A"), m("b", "B"), m("c", "C")],
            });
        }
    });

    it("charges summary collections by stored projections and order text", async () => {
        const projectionBytes = Buffer.byteLength(JSON.stringify({ name: "A", fmIndex: -1 }));
        const orderBytes = Buffer.byteLength(JSON.stringify(["k"]));
        const s = budgetedChats(1 + orderBytes + projectionBytes);
        s.seed("a", [{ id: "k", name: "A", note: "n".repeat(2048), message: [m("m", "x".repeat(2048))] }]);
        s.seed("b", [{ id: "k", name: "B", message: [] }]);
        const read = await s.read({ refs: [zeroRef], chatSummaryCollections: ["a", "b"], continue: true });
        expect(read.chatSummaryCollections).toMatchObject([
            { characterId: "a", order: { ids: ["k"] }, chats: [{ id: "k", name: "A", fmIndex: -1 }] },
        ]);
        expect(read.unanswered).toEqual({ refs: [], chats: [], chatCollections: [], chatSummaryCollections: ["b"] });
        // The same projection with a two-byte resource no longer fits: the order bytes count too.
        s.store.put(s.kinds.get("docs")!, "two", 10, null);
        const smaller = await s.read({
            refs: [{ kind: "docs", id: "two" }],
            chatSummaryCollections: ["a"],
            continue: true,
        });
        expect(smaller.chatSummaryCollections ?? []).toEqual([]);
        expect(smaller.unanswered?.chatSummaryCollections).toEqual(["a"]);
    });
});
