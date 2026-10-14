// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
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
/** A character as the server stores it: the shared defaults filled in (the `characters` normalizer). */
const stored = (id: string, extra: Record<string, unknown> = {}) => normalizeCharacter(character(id, extra));
const create = (kind: string, id: string, data: unknown) => ({ kind, id, baseRevision: null, data });

describe("POST /api/resources/batch", () => {
    it("applies writes and deletions of several kinds as one unit and answers the new tokens in operation order", async () => {
        const s = await defaultServer();
        // `presets/main` is materialized (slice 3), so the batch writes over it with its current revision.
        const presets = ((await (await s.get("presets", "main")).json()) as { revision: string }).revision;
        // `pluginStorage`: a singleton the store does not materialize, so the batch creates it.
        const created = await s.batch([
            create("pluginStorage", "main", { note: "u" }),
            { kind: "presets", id: "main", baseRevision: presets, data: [{ name: "p" }] },
            create("characters", "b", character("b")),
            create("characters", "a", character("a")),
            create("inlays", "assets/x.png", { name: "x", ext: "png", type: "image", asset: "assets/inlay_x.png" }),
        ]);
        expect(created.status).toBe(200);
        const result = (await created.json()) as BatchResult;
        expect(result.epoch).toBe(s.epoch);
        expect(result.results.map((r) => `${r.kind}/${r.id}`)).toEqual([
            "pluginStorage/main",
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
            {
                kind: "pluginStorage",
                id: "main",
                baseRevision: tokens["pluginStorage/main"],
                data: { note: "v" },
            },
        ]);
        expect(mixed.status).toBe(200);
        const second = (await mixed.json()) as BatchResult;
        expect(second.results).toEqual([
            { kind: "characters", id: "a", revision: tokens["characters/a"].replace(/:1$/, ":2") },
            { kind: "characters", id: "b", revision: null },
            { kind: "characters", id: "c", revision: expect.stringMatching(/:1$/) },
            { kind: "pluginStorage", id: "main", revision: tokens["pluginStorage/main"].replace(/:1$/, ":2") },
        ]);
        const state = (await (await s.readKinds("pluginStorage,characters,presets")).json()) as ReadKinds;
        expect(state.kinds.pluginStorage).toEqual([
            { id: "main", revision: second.results[3].revision, data: { note: "v" } },
        ]);
        expect(state.kinds.characters.map((c) => [c.id, c.data])).toEqual([
            ["a", stored("a", { name: "A" })],
            ["c", stored("c")],
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
            { id: "a", revision: a, data: stored("a") },
            { id: "b", revision: b, data: stored("b") },
        ]);
    });

    it("refuses duplicate kind and id pairs, malformed operations, and singleton rule violations with the operation index", async () => {
        const s = await defaultServer();
        const freshPresets = ((await (await s.readKinds("presets")).json()) as ReadKinds).kinds.presets;
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
                "ops[0]: must have exactly one of data, delete, and patch",
            ],
            [
                "neither",
                [{ kind: "characters", id: "x", baseRevision: null }],
                "ops[0]: must have exactly one of data, delete, and patch",
            ],
            [
                "patch and data",
                [{ kind: "characters", id: "x", baseRevision: "t", data: 1, patch: { set: {} } }],
                "ops[0]: must have exactly one of data, delete, and patch",
            ],
            [
                "patch and delete",
                [{ kind: "characters", id: "x", baseRevision: "t", delete: true, patch: { set: {} } }],
                "ops[0]: must have exactly one of data, delete, and patch",
            ],
            [
                "patch null base",
                [{ kind: "characters", id: "x", baseRevision: null, patch: { set: { name: "x" } } }],
                "ops[0]: a patch needs a string baseRevision",
            ],
            [
                "patch of a projecting kind",
                [{ kind: "llmSecrets", id: "main", baseRevision: "t", patch: { set: { openAIKey: "sk" } } }],
                "ops[0]: llmSecrets takes no patch",
            ],
            [
                "patch of a singleton's other id",
                [{ kind: "modules", id: "other", baseRevision: "t", patch: { order: [] } }],
                "ops[0]: modules has only the record main",
            ],
            [
                "malformed patch",
                [{ kind: "characters", id: "x", baseRevision: "t", patch: "name" }],
                "ops[0]: a patch is { set?, remove? } or { items?, changes?, order? }",
            ],
            [
                "mixed patch",
                [{ kind: "characters", id: "x", baseRevision: "t", patch: { set: { name: "x" }, order: [] } }],
                "ops[0]: a patch is either a field patch or an item patch",
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
            ["singleton id", [create("pluginStorage", "other", {})], "ops[0]: pluginStorage has only the record main"],
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
            ["singleton normalizer", [create("pluginStorage", "main", [])], "ops[0]: pluginStorage must be an object"],
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
        // Nothing was applied: no pluginStorage or character record, and `presets/main` is still the
        // materialized default preset at its first revision (slice 3).
        const state = (await (await s.readKinds("pluginStorage,characters,presets")).json()) as ReadKinds;
        expect(state.epoch).toBe(s.epoch);
        expect(state.kinds.pluginStorage).toEqual([]);
        expect(state.kinds.characters).toEqual([]);
        expect(state.kinds.presets).toEqual(freshPresets);
        expect(state.kinds.presets).toMatchObject([{ id: "main", revision: expect.stringMatching(/:1$/) }]);
    });

    // Audit item A1: a batch op may be a record patch (`patch` with a string `baseRevision`): a
    // field patch of a character, an item patch of `modules`; the store checks its shape and applies
    // it at the base revision, normalized like a write; a stale base is the usual 409.
    it("applies field and item patches at their base revision, normalized, and conflicts or refuses them like writes", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a", { name: "A", desc: "d" }));
        // `modules` is a singleton the store does not materialize: the batch creates it.
        const seeded = await s.batch([
            create("modules", "main", [
                { id: "m1", name: "one", lorebook: [] },
                { id: "m2", name: "two" },
            ]),
        ]);
        expect(seeded.status).toBe(200);
        const m = ((await seeded.json()) as BatchResult).results[0].revision!;

        const patched = await s.batch([
            {
                kind: "characters",
                id: "a",
                baseRevision: a,
                patch: { set: { name: "A2", extra: [1] }, remove: ["desc"] },
            },
            {
                kind: "modules",
                id: "main",
                baseRevision: m,
                patch: {
                    items: [{ id: "m3", name: "three" }],
                    changes: [{ id: "m1", set: { name: "ONE" } }],
                    order: ["m3", "m1"],
                },
            },
        ]);
        expect(patched.status).toBe(200);
        const result = (await patched.json()) as BatchResult;
        expect(result.results).toEqual([
            { kind: "characters", id: "a", revision: a.replace(/:1$/, ":2") },
            { kind: "modules", id: "main", revision: m.replace(/:1$/, ":2") },
        ]);
        const read = (await (
            await s.readRefs([
                { kind: "characters", id: "a" },
                { kind: "modules", id: "main" },
            ])
        ).json()) as ReadRefs;
        // The character's result is normalized: `desc` comes back as its default.
        expect(read.items[0]).toEqual({
            kind: "characters",
            id: "a",
            revision: result.results[0].revision,
            data: stored("a", { name: "A2", extra: [1] }),
        });
        expect(read.items[1]).toEqual({
            kind: "modules",
            id: "main",
            revision: result.results[1].revision,
            data: [
                { id: "m3", name: "three" },
                { id: "m1", name: "ONE", lorebook: [] },
            ],
        });

        // A stale base: the 409 lists it with the current revision, and the valid op beside it is not applied.
        const stale = await s.batch([
            { kind: "characters", id: "a", baseRevision: a, patch: { set: { name: "A3" } } },
            { kind: "modules", id: "main", baseRevision: result.results[1].revision, patch: { order: [] } },
        ]);
        expect(stale.status).toBe(409);
        expect(await stale.json()).toEqual({
            error: "Revision conflict",
            conflicts: [{ kind: "characters", id: "a", revision: result.results[0].revision }],
        } satisfies BatchConflict);
        // A patch the stored record does not fit, or whose result the normalizer refuses: a 400 naming the op.
        for (const [label, op, error] of [
            [
                "item patch of an object",
                { kind: "characters", id: "a", baseRevision: result.results[0].revision, patch: { order: [] } },
                "ops[0]: the record's items have no unique ids",
            ],
            [
                "field patch of a list",
                { kind: "modules", id: "main", baseRevision: result.results[1].revision, patch: { set: { x: 1 } } },
                "ops[0]: a field patch needs an object record",
            ],
            [
                "unknown item",
                {
                    kind: "modules",
                    id: "main",
                    baseRevision: result.results[1].revision,
                    patch: { changes: [{ id: "zz", set: { name: "z" } }] },
                },
                'ops[0]: the item "zz" is not in the record',
            ],
            [
                "refused module",
                {
                    kind: "modules",
                    id: "main",
                    baseRevision: result.results[1].revision,
                    patch: { changes: [{ id: "m1", set: { lorebook: "no" } }] },
                },
                "ops[0]: modules[1]: a module's lorebook must be a list",
            ],
            [
                "refused character",
                {
                    kind: "characters",
                    id: "a",
                    baseRevision: result.results[0].revision,
                    patch: { set: { chaId: "b" } },
                },
                "ops[0]: character.chaId must equal the resource id",
            ],
        ] as [string, unknown, string][]) {
            const res = await s.batch([op]);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error });
        }
        const after = (await (
            await s.readRefs([
                { kind: "characters", id: "a" },
                { kind: "modules", id: "main" },
            ])
        ).json()) as ReadRefs;
        expect(after.items).toEqual(read.items);
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
        const res = await s.readKinds("characters,pluginStorage,,characters,");
        expect(res.status).toBe(200);
        const body = (await res.json()) as ReadKinds;
        expect(Object.keys(body.kinds)).toEqual(["characters", "pluginStorage"]);
        expect(body.epoch).toBe(s.epoch);
        expect(body.kinds.characters.map((c) => c.id)).toEqual(["b", "a"]);
        expect(body.kinds.pluginStorage).toEqual([]);

        for (const [query, error] of [
            ["", "kinds query parameter required"],
            [",", "kinds query parameter required"],
            ["characters,nope", "Unknown resource kind: nope"],
            ["Characters", "Unknown resource kind: Characters"],
            // The `root` kind is gone (slice 6): a read of it is refused like any unknown kind.
            ["root", "Unknown resource kind: root"],
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
        const storage = await s.create("pluginStorage", "main", { note: "u" });
        const res = await s.readRefs([
            { kind: "characters", id: "a" },
            { kind: "characters", id: "gone" },
            { kind: "pluginStorage", id: "main" },
            { kind: "characters", id: "a" },
        ]);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            epoch: s.epoch,
            items: [
                { kind: "characters", id: "a", revision: a, data: stored("a") },
                { kind: "characters", id: "gone", revision: null, data: null },
                { kind: "pluginStorage", id: "main", revision: storage, data: { note: "u" } },
                { kind: "characters", id: "a", revision: a, data: stored("a") },
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
            [
                "singleton id",
                { refs: [{ kind: "pluginStorage", id: "other" }] },
                "pluginStorage has only the record main",
            ],
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
