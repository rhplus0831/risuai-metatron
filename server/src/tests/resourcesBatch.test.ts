// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

type BatchResult = { epoch: string; results: { kind: string; id: string; revision: string | null }[] };
type BatchConflict = { error: string; conflicts: { kind: string; id: string; revision: string | null }[] };
type ReadKinds = { epoch: string; kinds: Record<string, { id: string; revision: string; data: unknown }[]> };
type ReadRefs = {
    epoch: string;
    items: { kind: string; id: string; revision: string | null; data: unknown }[];
    chats: unknown[];
    chatCollections: unknown[];
};

const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, ...extra });
const create = (kind: string, id: string, data: unknown) => ({ kind, id, baseRevision: null, data });

describe("POST /api/resources/batch", () => {
    it("applies writes and deletions of several kinds as one unit and answers the new tokens in operation order", async () => {
        const s = await defaultServer();
        // `presets/main` is materialized (slice 3), so the batch writes over it with its current revision.
        const presets = ((await (await s.get("presets", "main")).json()) as { revision: string }).revision;
        const created = await s.batch([
            create("root", "main", { username: "u" }),
            { kind: "presets", id: "main", baseRevision: presets, data: [{ name: "p" }] },
            create("characters", "b", character("b")),
            create("characters", "a", character("a")),
            create("inlays", "assets/x.png", { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png" }),
        ]);
        expect(created.status).toBe(200);
        const result = (await created.json()) as BatchResult;
        expect(result.epoch).toBe(s.epoch);
        expect(result.results.map((r) => `${r.kind}/${r.id}`)).toEqual([
            "root/main",
            "presets/main",
            "characters/b",
            "characters/a",
            "inlays/assets/x.png",
        ]);
        for (const r of result.results) {
            expect(r.revision, r.id).toMatch(r.kind === "presets" ? /^[0-9a-f-]{36}:\d+:2$/ : /^[0-9a-f-]{36}:\d+:1$/);
            expect(r, r.id).not.toHaveProperty("data");
        }
        const tokens = Object.fromEntries(result.results.map((r) => [`${r.kind}/${r.id}`, r.revision!]));
        expect(tokens["presets/main"]).toBe(presets.replace(/:1$/, ":2"));

        const mixed = await s.batch([
            { kind: "characters", id: "a", baseRevision: tokens["characters/a"], data: character("a", { name: "A" }) },
            { kind: "characters", id: "b", baseRevision: tokens["characters/b"], delete: true },
            create("characters", "c", character("c")),
            { kind: "root", id: "main", baseRevision: tokens["root/main"], data: { username: "v" } },
        ]);
        expect(mixed.status).toBe(200);
        const second = (await mixed.json()) as BatchResult;
        expect(second.results).toEqual([
            { kind: "characters", id: "a", revision: tokens["characters/a"].replace(/:1$/, ":2") },
            { kind: "characters", id: "b", revision: null },
            { kind: "characters", id: "c", revision: expect.stringMatching(/:1$/) },
            { kind: "root", id: "main", revision: tokens["root/main"].replace(/:1$/, ":2") },
        ]);
        const state = (await (await s.readKinds("root,characters,presets")).json()) as ReadKinds;
        expect(state.kinds.root).toEqual([
            { id: "main", revision: second.results[3].revision, data: { username: "v" } },
        ]);
        expect(state.kinds.characters.map((c) => [c.id, c.data])).toEqual([
            ["a", character("a", { name: "A" })],
            ["c", character("c")],
        ]);
        // The batch's write, not the materialized default, is what is stored.
        expect(state.kinds.presets).toMatchObject([
            { id: "main", revision: tokens["presets/main"], data: [{ name: "p" }] },
        ]);
    });

    it("lists every stale operation in one 409 and applies nothing", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const b = await s.create("characters", "b", character("b"));
        const stale = await s.batch([
            create("characters", "a", character("a")), // exists: a null create conflicts
            { kind: "characters", id: "b", baseRevision: b, data: character("b", { name: "B" }) }, // current
            { kind: "characters", id: "gone", baseRevision: a, data: character("gone") }, // missing
            { kind: "characters", id: "c", baseRevision: "garbage", delete: true }, // malformed token
            create("characters", "d", character("d")), // valid create
        ]);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
            error: "Revision conflict",
            conflicts: [
                { kind: "characters", id: "a", revision: a },
                { kind: "characters", id: "gone", revision: null },
                { kind: "characters", id: "c", revision: null },
            ],
        } satisfies BatchConflict);
        const state = (await (await s.readKinds("characters")).json()) as ReadKinds;
        expect(state.kinds.characters).toEqual([
            { id: "a", revision: a, data: character("a") },
            { id: "b", revision: b, data: character("b") },
        ]);
    });

    it("refuses duplicate kind and id pairs, malformed operations, and singleton rule violations with the operation index", async () => {
        const s = await defaultServer();
        const cases: [string, unknown[], string][] = [
            [
                "duplicate",
                [create("characters", "x", character("x")), create("characters", "x", character("x"))],
                "ops[1]: duplicate kind and id",
            ],
            ["not an object", [1], "ops[0]: must be an object"],
            ["unknown kind", [create("nope", "x", 1)], "ops[0]: unknown resource kind"],
            ["reserved kind", [create("batch", "x", 1)], "ops[0]: unknown resource kind"],
            ["invalid id", [create("characters", "a\u0000", 1)], "ops[0]: invalid resource id"],
            ["lone surrogate", [create("characters", "a\ud800", 1)], "ops[0]: invalid resource id"],
            [
                "no baseRevision",
                [{ kind: "characters", id: "x", data: 1 }],
                "ops[0]: baseRevision must be a string or null",
            ],
            [
                "both",
                [{ kind: "characters", id: "x", baseRevision: null, data: 1, delete: true }],
                "ops[0]: must have exactly one of data and delete",
            ],
            [
                "neither",
                [{ kind: "characters", id: "x", baseRevision: null }],
                "ops[0]: must have exactly one of data and delete",
            ],
            [
                "delete false",
                [{ kind: "characters", id: "x", baseRevision: "t", delete: false }],
                "ops[0]: a deletion is { delete: true } with a string baseRevision",
            ],
            [
                "delete null base",
                [{ kind: "characters", id: "x", baseRevision: null, delete: true }],
                "ops[0]: a deletion is { delete: true } with a string baseRevision",
            ],
            ["singleton id", [create("root", "other", {})], "ops[0]: root has only the record main"],
            [
                "singleton delete",
                [{ kind: "presets", id: "main", baseRevision: "t", delete: true }],
                "ops[0]: presets cannot be deleted",
            ],
            [
                "normalizer",
                [create("characters", "x", { chaId: "y" })],
                "ops[0]: character.chaId must equal the resource id",
            ],
            [
                "root excluded key",
                [create("root", "main", { characters: [] })],
                "ops[0]: root must not hold characters",
            ],
            [
                "later op",
                [create("characters", "ok", character("ok")), create("characters", "bad", { chaId: "bad", chats: [] })],
                "ops[1]: character must not hold chats",
            ],
        ];
        for (const [label, ops, error] of cases) {
            const res = await s.batch(ops);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error });
        }
        const envelope = "Body must be { ops?, chats?, chatOrders? } with 1 to 5000 operations";
        for (const [label, body, error] of [
            ["empty", { ops: [] }, envelope],
            ["not an array", { ops: {} }, "ops must be an array"],
            ["missing", {}, envelope],
            [
                "too many",
                { ops: Array.from({ length: 5001 }, (_, i) => create("characters", `c${i}`, character(`c${i}`))) },
                envelope,
            ],
        ] as [string, unknown, string][]) {
            const res = await s.json("/api/resources/batch", body);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error });
        }
        // Nothing was applied: no root or character record, and `presets/main` is still the materialized
        // default preset at its first revision (slice 3).
        const state = (await (await s.readKinds("root,characters,presets")).json()) as ReadKinds;
        expect(state.epoch).toBe(s.epoch);
        expect(state.kinds.root).toEqual([]);
        expect(state.kinds.characters).toEqual([]);
        expect(state.kinds.presets).toMatchObject([
            { id: "main", revision: expect.stringMatching(/:1$/), data: [{ name: "New Preset" }] },
        ]);
    });

    it("takes 5,000 operations in one batch", async () => {
        const s = await defaultServer();
        const ops = Array.from({ length: 5000 }, (_, i) => create("characters", `c${i}`, character(`c${i}`)));
        const res = await s.batch(ops);
        expect(res.status).toBe(200);
        expect(((await res.json()) as BatchResult).results).toHaveLength(5000);
        expect(((await (await s.readKinds("characters")).json()) as ReadKinds).kinds.characters).toHaveLength(5000);
    });
});

describe("multi-kind and ref reads", () => {
    it("reads several kinds in one call, deduplicating the query, and refuses unknown or missing kinds", async () => {
        const s = await defaultServer();
        await s.create("characters", "b", character("b"));
        await s.create("characters", "a", character("a"));
        const res = await s.readKinds("characters,root,,characters,");
        expect(res.status).toBe(200);
        const body = (await res.json()) as ReadKinds;
        expect(Object.keys(body.kinds)).toEqual(["characters", "root"]);
        expect(body.epoch).toBe(s.epoch);
        expect(body.kinds.characters.map((c) => c.id)).toEqual(["b", "a"]);
        expect(body.kinds.root).toEqual([]);

        for (const [query, error] of [
            ["", "kinds query parameter required"],
            [",", "kinds query parameter required"],
            ["characters,nope", "Unknown resource kind: nope"],
            ["Root", "Unknown resource kind: Root"],
            ["batch", "Unknown resource kind: batch"],
        ]) {
            const bad = await s.readKinds(query);
            expect(bad.status, query).toBe(400);
            expect(await bad.json(), query).toEqual({ error });
        }
        expect((await s.request("/api/resources")).status).toBe(400);
    });

    it("reads named records in one call, with null revision and data for a missing one", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const root = await s.create("root", "main", { username: "u" });
        const res = await s.readRefs([
            { kind: "characters", id: "a" },
            { kind: "characters", id: "gone" },
            { kind: "root", id: "main" },
            { kind: "characters", id: "a" },
        ]);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            epoch: s.epoch,
            items: [
                { kind: "characters", id: "a", revision: a, data: character("a") },
                { kind: "characters", id: "gone", revision: null, data: null },
                { kind: "root", id: "main", revision: root, data: { username: "u" } },
                { kind: "characters", id: "a", revision: a, data: character("a") },
            ],
            chats: [],
            chatCollections: [],
        } satisfies ReadRefs);

        const envelope = "Body must name 1 to 5000 entries";
        for (const [label, body, error] of [
            ["empty", { refs: [] }, envelope],
            ["missing", {}, envelope],
            ["too many", { refs: Array.from({ length: 5001 }, () => ({ kind: "characters", id: "a" })) }, envelope],
            ["not arrays", { refs: {} }, "Body must be { refs?, chats?, chatCollections? } of arrays"],
            ["unknown kind", { refs: [{ kind: "nope", id: "a" }] }, "refs[0] must name a known kind and a valid id"],
            [
                "invalid id",
                {
                    refs: [
                        { kind: "characters", id: "a" },
                        { kind: "characters", id: "" },
                    ],
                },
                "refs[1] must name a known kind and a valid id",
            ],
            ["not an object", { refs: ["characters/a"] }, "refs[0] must name a known kind and a valid id"],
            ["singleton id", { refs: [{ kind: "root", id: "other" }] }, "root has only the record main"],
        ] as [string, unknown, string][]) {
            const bad = await s.json("/api/resources/read", body);
            expect(bad.status, label).toBe(400);
            expect(await bad.json(), label).toEqual({ error });
        }
    });

    it("carries relaxed ids through batch and ref reads", async () => {
        const s = await defaultServer();
        const ids = ["§playground", "assets/abc.png", "a b/c%2Fd", "가나다", "x".repeat(512)];
        const res = await s.batch(ids.map((id) => create("characters", id, character(id))));
        expect(res.status).toBe(200);
        const refs = (await (await s.readRefs(ids.map((id) => ({ kind: "characters", id })))).json()) as ReadRefs;
        expect(refs.items.map((item) => [item.id, (item.data as { chaId: string }).chaId])).toEqual(
            ids.map((id) => [id, id]),
        );
        for (const id of ids) {
            expect((await s.get("characters", id)).status, id).toBe(200);
        }
    });
});
