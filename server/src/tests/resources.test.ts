// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceKind } from "../data/kinds.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";
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

type Stored = { epoch: string; revision: string; data: unknown };
type Conflict = { error: string; revision: string | null };

// Identity kinds behind the `resourceKinds` seam: the route contract is the subject here, not the
// default kinds' shape rules (`kinds.test.ts`).
const docs: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (input) => input };
const notes: ResourceKind = { name: "notes", schemaVersion: 1, normalize: (input) => input };
const single: ResourceKind = { name: "single", schemaVersion: 1, singleton: true, normalize: (input) => input };
const testKinds = [docs, notes, single];

async function authedServer(resourceKinds: readonly ResourceKind[] = testKinds) {
    const s = await createResourceTestClient({ resourceKinds, epochKind: resourceKinds[0].name });
    servers.push(s);
    return s;
}

/** A server over `DEFAULT_RESOURCE_KINDS`. */
async function defaultServer() {
    const s = await createResourceTestClient();
    servers.push(s);
    return s;
}

async function expectConflict(res: Response, revision: string | null, label: string) {
    expect(res.status, label).toBe(409);
    expect((await res.json()) as Conflict, label).toEqual({ error: "Revision conflict", revision });
}

describe("resource routes", () => {
    it("round-trips a resource through create, get, update, and list, in the SQLite file under save/data", async () => {
        const s = await authedServer();
        expect(existsSync(path.join(s.savePath, "data", "resources.sqlite"))).toBe(true);
        expect(await (await s.list("docs")).json()).toEqual({ epoch: s.epoch, items: [] });
        const missing = await s.get("docs", "p1");
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: "Resource not found", epoch: s.epoch });

        const created = await s.put("docs", "p1", { baseRevision: null, data: { name: "one", temp: 0.5 } });
        expect(created.status).toBe(200);
        const first = (await created.json()) as Stored;
        expect(first.epoch).toBe(s.epoch);
        expect(first.data).toEqual({ name: "one", temp: 0.5 });
        expect(first.revision).toMatch(/^[0-9a-f-]{36}:1:1$/);
        expect(await (await s.get("docs", "p1")).json()).toEqual(first);

        const updated = await s.put("docs", "p1", { baseRevision: first.revision, data: { name: "two" } });
        expect(updated.status).toBe(200);
        const second = (await updated.json()) as Stored;
        expect(second).toEqual({
            epoch: s.epoch,
            revision: first.revision.replace(/:1$/, ":2"),
            data: { name: "two" },
        });
        expect(await (await s.get("docs", "p1")).json()).toEqual(second);
        expect(await (await s.list("docs")).json()).toEqual({
            epoch: s.epoch,
            items: [{ id: "p1", revision: second.revision, data: { name: "two" } }],
        });
        // Kinds do not share ids.
        expect((await s.get("notes", "p1")).status).toBe(404);
    });

    it("marks every resource response Cache-Control: no-store", async () => {
        const s = await authedServer();
        await s.create("docs", "a", 1);
        const responses = [
            await s.list("docs"),
            await s.get("docs", "a"),
            await s.get("docs", "missing"),
            await s.readKinds("docs,notes"),
            await s.readRefs([{ kind: "docs", id: "a" }]),
            await s.batch([{ kind: "docs", id: "b", baseRevision: null, data: 1 }]),
            await s.put("docs", "c", { baseRevision: null, data: 1 }),
            await s.remove("docs", "c", "?baseRevision=x"),
        ];
        for (const res of responses) {
            expect(res.headers.get("cache-control"), res.url).toBe("no-store");
        }
    });

    it("answers 409 with the current revision for a stale update and leaves the record unchanged", async () => {
        const s = await authedServer();
        const first = await s.create("notes", "c1", { v: 1 });
        const current = ((await (await s.put("notes", "c1", { baseRevision: first, data: { v: 2 } })).json()) as Stored)
            .revision;

        await expectConflict(await s.put("notes", "c1", { baseRevision: first, data: { v: 3 } }), current, "stale");
        expect(await (await s.get("notes", "c1")).json()).toEqual({
            epoch: s.epoch,
            revision: current,
            data: { v: 2 },
        });
    });

    it("answers 409 with the current revision for a duplicate create and for malformed or empty tokens", async () => {
        const s = await authedServer();
        const current = await s.create("docs", "m1", 1);

        await expectConflict(await s.put("docs", "m1", { baseRevision: null, data: 2 }), current, "duplicate");
        for (const token of ["", "garbage", current.replace(/^[0-9a-f-]{36}/, "not-a-uuid"), `${current}:1`, "1:1"]) {
            await expectConflict(await s.put("docs", "m1", { baseRevision: token, data: 2 }), current, `put ${token}`);
            await expectConflict(await s.remove("docs", "m1", `?baseRevision=${token}`), current, `delete ${token}`);
        }
        expect(await (await s.get("docs", "m1")).json()).toEqual({ epoch: s.epoch, revision: current, data: 1 });
    });

    it("rejects malformed envelopes with 400 and accepts every falsy data value", async () => {
        const s = await authedServer();
        const envelope = "Body must be { baseRevision: string | null, data }";
        const malformed: [string, unknown][] = [
            ["array", [{ baseRevision: null, data: 1 }]],
            ["missing data", { baseRevision: null }],
            ["missing baseRevision", { data: 1 }],
            ["numeric baseRevision", { baseRevision: 1, data: 1 }],
            ["undefined baseRevision", { baseRevision: undefined, data: 1 }],
        ];
        for (const [label, body] of malformed) {
            const res = await s.put("docs", "r", body);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error: envelope });
        }
        const textBody = await s.request("/api/resources/docs/r", {
            method: "PUT",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({ baseRevision: null, data: 1 }),
        });
        expect(textBody.status).toBe(400);
        expect(await textBody.json()).toEqual({ error: envelope });
        const invalidJson = await s.request("/api/resources/docs/r", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{ baseRevision: null",
        });
        expect(invalidJson.status).toBe(400);
        expect(await invalidJson.json()).toEqual({ error: "Invalid JSON body" });
        expect((await s.get("docs", "r")).status).toBe(404);

        let revision: string | null = null;
        for (const data of [0, "", false, null]) {
            const res = await s.put("docs", "r", { baseRevision: revision, data });
            expect(res.status, JSON.stringify(data)).toBe(200);
            const stored = (await res.json()) as Stored;
            expect(stored.data, JSON.stringify(data)).toBe(data);
            revision = stored.revision;
        }
        expect(await (await s.get("docs", "r")).json()).toEqual({ epoch: s.epoch, revision, data: null });
    });

    it("rejects data the store cannot keep as JSON with 400", async () => {
        const s = await authedServer();
        // Sent as text: a JavaScript `1e400` literal is already `Infinity`, which `JSON.stringify` would drop.
        const raw = (body: string) =>
            s.request("/api/resources/docs/r", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body,
            });
        const infinite = await raw('{"baseRevision":null,"data":{"n":1e400}}');
        expect(infinite.status).toBe(400);
        expect(await infinite.json()).toEqual({ error: "Resource data contains a non-finite number" });

        const nested = (depth: number) => "[".repeat(depth) + "1" + "]".repeat(depth);
        const deep = await raw(`{"baseRevision":null,"data":${nested(257)}}`);
        expect(deep.status).toBe(400);
        expect(await deep.json()).toEqual({ error: "Resource data is nested deeper than 256 levels" });
        expect((await s.get("docs", "r")).status).toBe(404);

        expect((await raw(`{"baseRevision":null,"data":${nested(256)}}`)).status).toBe(200);
    });

    it("runs the kind's normalizer on every write: a rejection is a 400 and the normalized value is stored", async () => {
        const kinds: ResourceKind[] = [
            {
                name: "names",
                schemaVersion: 1,
                normalize(input) {
                    if (typeof input !== "string" || input.trim() === "") {
                        throw new ResourceValidationError("Name must be a non-empty string");
                    }
                    return input.trim();
                },
            },
        ];
        const s = await authedServer(kinds);
        expect((await s.get("presets", "main")).status).toBe(404 /* the default kinds are replaced */);

        for (const data of [1, "   ", null]) {
            const res = await s.put("names", "n", { baseRevision: null, data });
            expect(res.status, JSON.stringify(data)).toBe(400);
            expect(await res.json(), JSON.stringify(data)).toEqual({ error: "Name must be a non-empty string" });
        }
        expect((await s.get("names", "n")).status).toBe(404);

        const created = await s.put("names", "n", { baseRevision: null, data: "  Alice " });
        expect(created.status).toBe(200);
        const stored = (await created.json()) as Stored;
        expect(stored.data).toBe("Alice");
        expect(await (await s.get("names", "n")).json()).toEqual(stored);

        const rejectedUpdate = await s.put("names", "n", { baseRevision: stored.revision, data: "" });
        expect(rejectedUpdate.status).toBe(400);
        expect(await (await s.get("names", "n")).json()).toEqual(stored);
    });

    it("lists records in creation order, unchanged by updates", async () => {
        const s = await authedServer();
        for (const id of ["c", "a", "b"]) {
            await s.create("notes", id, id);
        }
        const revisionOfA = ((await (await s.get("notes", "a")).json()) as Stored).revision;
        expect((await s.put("notes", "a", { baseRevision: revisionOfA, data: "a2" })).status).toBe(200);
        const items = ((await (await s.list("notes")).json()) as { items: (Stored & { id: string })[] }).items;
        expect(items.map((item) => [item.id, item.data])).toEqual([
            ["c", "c"],
            ["a", "a2"],
            ["b", "b"],
        ]);
        expect(await (await s.list("docs")).json()).toEqual({ epoch: s.epoch, items: [] });
    });

    it("deletes with the current token only, and an old token stays stale after a recreate", async () => {
        const s = await authedServer();
        const first = await s.create("docs", "k", { a: 1 });
        const current = ((await (await s.put("docs", "k", { baseRevision: first, data: { a: 2 } })).json()) as Stored)
            .revision;

        await expectConflict(await s.remove("docs", "k", `?baseRevision=${first}`), current, "stale delete");
        expect((await s.get("docs", "k")).status).toBe(200);

        const missingQuery = await s.remove("docs", "k", "");
        expect(missingQuery.status).toBe(400);
        expect(await missingQuery.json()).toEqual({ error: "baseRevision query parameter required" });

        const deleted = await s.remove("docs", "k", `?baseRevision=${current}`);
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ success: true, epoch: s.epoch });
        expect((await s.get("docs", "k")).status).toBe(404);
        expect(await (await s.list("docs")).json()).toEqual({ epoch: s.epoch, items: [] });

        // The record is gone: a token names nothing, and the client learns that with `revision: null`.
        await expectConflict(await s.remove("docs", "k", `?baseRevision=${current}`), null, "delete missing");
        await expectConflict(await s.put("docs", "k", { baseRevision: current, data: 3 }), null, "put missing");

        const recreated = await s.create("docs", "k", { a: 3 });
        expect(recreated).not.toBe(current);
        await expectConflict(await s.put("docs", "k", { baseRevision: current, data: 4 }), recreated, "old put");
        await expectConflict(await s.remove("docs", "k", `?baseRevision=${current}`), recreated, "old delete");
        expect(await (await s.get("docs", "k")).json()).toEqual({
            epoch: s.epoch,
            revision: recreated,
            data: { a: 3 },
        });
    });

    it("fences every mutation on the epoch header: missing or stale is a 412 naming the current epoch", async () => {
        const s = await authedServer();
        const revision = await s.create("docs", "a", 1);
        const stale = "00000000-0000-4000-8000-000000000000";
        for (const epoch of [null, "", stale]) {
            const label = `epoch ${JSON.stringify(epoch)}`;
            const responses = [
                await s.put("docs", "a", { baseRevision: revision, data: 2 }, epoch),
                await s.put("docs", "b", { baseRevision: null, data: 1 }, epoch),
                await s.remove("docs", "a", `?baseRevision=${revision}`, epoch),
                await s.batch([{ kind: "docs", id: "b", baseRevision: null, data: 1 }], epoch),
            ];
            for (const res of responses) {
                expect(res.status, label).toBe(412);
                expect(await res.json(), label).toEqual({ error: "EpochMismatch", epoch: s.epoch });
            }
        }
        // Reads never need it.
        for (const res of [
            await s.request("/api/resources/docs/a", {}, null),
            await s.request("/api/resources/docs", {}, null),
            await s.request("/api/resources?kinds=docs", {}, null),
            await s.json("/api/resources/read", { refs: [{ kind: "docs", id: "a" }] }, {}, null),
        ]) {
            expect(res.status).toBe(200);
        }
        expect(await (await s.get("docs", "a")).json()).toEqual({ epoch: s.epoch, revision, data: 1 });
        expect((await s.get("docs", "b")).status).toBe(404);
    });

    it("answers 404 for an unknown kind and 400 for an invalid id on every route", async () => {
        const s = await authedServer();
        for (const kind of ["unknown", "Docs", "docs%2F", "batch", "read"]) {
            const responses = [
                await s.list(kind),
                await s.get(kind, "x"),
                await s.put(kind, "x", { baseRevision: null, data: 1 }),
                await s.remove(kind, "x", "?baseRevision=t"),
            ];
            for (const res of responses) {
                expect(res.status, kind).toBe(404);
                expect(await res.json(), kind).toEqual({ error: "Unknown resource kind" });
            }
        }
        // A `.` or `..` segment, even percent-encoded, never reaches the route: the URL parser resolves
        // it away (to the list and multi-kind read routes); the store refuses the ids themselves
        // (`resourceStore.test.ts`). A lone surrogate cannot be sent at all (`encodeURIComponent`
        // throws); the batch route covers it.
        const invalid: [string, string][] = [
            ["control character", encodeURIComponent("a\u0000b")],
            ["escape", encodeURIComponent("a\u001bb")],
            ["delete", encodeURIComponent("a\u007fb")],
            ["513 units", "a".repeat(513)],
        ];
        for (const [label, id] of invalid) {
            const responses = [
                await s.request(`/api/resources/docs/${id}`),
                await s.json(`/api/resources/docs/${id}`, { baseRevision: null, data: 1 }, { method: "PUT" }),
                await s.request(`/api/resources/docs/${id}?baseRevision=t`, { method: "DELETE" }),
            ];
            for (const res of responses) {
                expect(res.status, label).toBe(400);
                expect(await res.json(), label).toEqual({ error: "Invalid resource id" });
            }
        }
        for (const dot of [".", "%2E", "%2e"]) {
            expect(await (await s.request(`/api/resources/docs/${dot}`)).json(), dot).toEqual({
                epoch: s.epoch,
                items: [],
            });
            const up = await s.request(`/api/resources/docs/${dot}${dot}`);
            expect(up.status, dot).toBe(400 /* `/api/resources` without kinds */);
            expect(await up.json(), dot).toEqual({ error: "kinds query parameter required" });
        }
        expect(await (await s.list("docs")).json()).toEqual({ epoch: s.epoch, items: [] });
    });

    it("accepts the relaxed ids end to end: dots, spaces, slashes, percent signs, and non-ASCII, up to 512 units", async () => {
        const s = await authedServer();
        const ids = [
            ".x",
            "-x",
            "_x",
            "a b",
            "a/b",
            "a%2Fb",
            "§playground",
            "assets/abc.png",
            "한글 이름",
            "back\\slash",
            "q?a=1#f",
            "a".repeat(512),
        ];
        for (const id of ids) {
            const revision = await s.create("docs", id, { id });
            expect(await (await s.get("docs", id)).json(), id).toEqual({ epoch: s.epoch, revision, data: { id } });
        }
        const listed = ((await (await s.list("docs")).json()) as { items: { id: string }[] }).items.map((i) => i.id);
        expect(listed).toEqual(ids);
        // `a/b` and `a%2Fb` are different records: the client encodes exactly once.
        expect(await (await s.get("docs", "a%2Fb")).json()).toMatchObject({ data: { id: "a%2Fb" } });
        for (const id of ids) {
            const current = ((await (await s.get("docs", id)).json()) as Stored).revision;
            expect((await s.remove("docs", id, `?baseRevision=${current}`)).status, id).toBe(200);
        }
        expect(await (await s.list("docs")).json()).toEqual({ epoch: s.epoch, items: [] });
    });

    it("requires the auth header on every route", async () => {
        const s = await authedServer();
        await s.create("docs", "r", 1);
        const requests: [string, RequestInit][] = [
            ["/api/resources/docs", {}],
            ["/api/resources/docs/r", {}],
            ["/api/resources?kinds=docs", {}],
            [
                "/api/resources/docs/r",
                {
                    method: "PUT",
                    headers: { "content-type": "application/json", "x-resource-epoch": s.epoch },
                    body: JSON.stringify({ baseRevision: null, data: 2 }),
                },
            ],
            ["/api/resources/docs/r?baseRevision=t", { method: "DELETE", headers: { "x-resource-epoch": s.epoch } }],
            [
                "/api/resources/batch",
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-resource-epoch": s.epoch },
                    body: JSON.stringify({ ops: [{ kind: "docs", id: "r", baseRevision: null, data: 2 }] }),
                },
            ],
            [
                "/api/resources/read",
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ refs: [{ kind: "docs", id: "r" }] }),
                },
            ],
        ];
        for (const [url, init] of requests) {
            const res = await s.app.request(url, init);
            expect(res.status, `${init.method ?? "GET"} ${url}`).toBe(400);
            expect(await res.json(), url).toEqual({ error: "No auth header" });
        }
        expect(await (await s.get("docs", "r")).json()).toMatchObject({ data: 1 });
    });
});

describe("default kinds over the routes", () => {
    it("accepts only the id main for a singleton kind and refuses to delete it", async () => {
        const s = await defaultServer();
        for (const kind of ["presets", "modules", "plugins", "pluginStorage", "pluginPermissions"]) {
            const data = kind === "pluginPermissions" ? { grants: {}, lastGrantTime: {} } : [];
            const payload = kind === "pluginStorage" ? {} : data;
            const other = await s.put(kind, "other", { baseRevision: null, data: payload });
            expect(other.status, kind).toBe(400);
            expect(await other.json(), kind).toEqual({ error: `${kind} has only the record main` });
            expect((await s.get(kind, "other")).status, kind).toBe(400);
            // `presets/main` is materialized, so it is written over with its current revision.
            const existing =
                kind === "presets"
                    ? ((await (await s.get(kind, "main")).json()) as { revision: string }).revision
                    : null;
            const written = await s.put(kind, "main", { baseRevision: existing, data: payload });
            expect(written.status, kind).toBe(200);
            const revision = ((await written.json()) as { revision: string }).revision;
            const deleted = await s.remove(kind, "main", `?baseRevision=${revision}`);
            expect(deleted.status, kind).toBe(400);
            expect(await deleted.json(), kind).toEqual({ error: `${kind} cannot be deleted` });
            expect((await s.get(kind, "main")).status, kind).toBe(200);
        }
    });

    it("keeps characters and inlays keyed by their own ids, with the character's chaId matching", async () => {
        const s = await defaultServer();
        const mismatch = await s.put("characters", "c1", { baseRevision: null, data: { chaId: "c2" } });
        expect(mismatch.status).toBe(400);
        expect(await mismatch.json()).toEqual({ error: "character.chaId must equal the resource id" });
        const revision = await s.create("characters", "c1", { chaId: "c1" });
        await s.create("characters", "§playground", { chaId: "§playground" });
        await s.create("inlays", "assets/abc.png", {
            name: "a",
            ext: "png",
            type: "image",
            asset: "assets/inlay_a.png",
        });
        expect((await s.remove("characters", "c1", `?baseRevision=${revision}`)).status).toBe(200);
        expect(
            ((await (await s.list("characters")).json()) as { items: { id: string }[] }).items.map((i) => i.id),
        ).toEqual(["§playground"]);
        expect((await s.get("inlays", "assets/abc.png")).status).toBe(200);
    });
});
