// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResourceKind } from "../data/kinds.ts";
import { ResourceValidationError } from "../data/resourceStore.ts";
import { createSigner, createTestServer, json } from "./testSupport.ts";

const servers: ReturnType<typeof createTestServer>[] = [];

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(() => {
    for (const s of servers.splice(0)) {
        s.close();
    }
});

type Server = Awaited<ReturnType<typeof authedServer>>;
type Stored = { revision: string; data: unknown };
type Conflict = { error: string; revision: string | null };

async function authedServer(resourceKinds?: readonly ResourceKind[]) {
    const s = createTestServer({ password: "pw", resourceKinds });
    servers.push(s);
    const signer = await createSigner();
    await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    const headers = async (extra: Record<string, string> = {}) => ({ "risu-auth": await signer.jwt(), ...extra });
    return { ...s, headers };
}

const put = async (s: Server, kind: string, id: string, body: unknown) =>
    s.app.request(`/api/resources/${kind}/${id}`, {
        method: "PUT",
        headers: await s.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
    });
const get = async (s: Server, kind: string, id: string) =>
    s.app.request(`/api/resources/${kind}/${id}`, { headers: await s.headers() });
const list = async (s: Server, kind: string) => s.app.request(`/api/resources/${kind}`, { headers: await s.headers() });
const remove = async (s: Server, kind: string, id: string, query: string) =>
    s.app.request(`/api/resources/${kind}/${id}${query}`, { method: "DELETE", headers: await s.headers() });

/** Creates a record and returns its revision token. */
async function create(s: Server, kind: string, id: string, data: unknown): Promise<string> {
    const res = await put(s, kind, id, { baseRevision: null, data });
    expect(res.status, `create ${kind}/${id}`).toBe(200);
    return ((await res.json()) as Stored).revision;
}

async function expectConflict(res: Response, revision: string | null, label: string) {
    expect(res.status, label).toBe(409);
    expect((await res.json()) as Conflict, label).toEqual({ error: "Revision conflict", revision });
}

describe("resource routes", () => {
    it("round-trips a resource through create, get, update, and list, in the SQLite file under save/data", async () => {
        const s = await authedServer();
        expect(existsSync(path.join(s.savePath, "data", "resources.sqlite"))).toBe(true);
        expect(await (await list(s, "presets")).json()).toEqual({ items: [] });
        expect((await get(s, "presets", "p1")).status).toBe(404);

        const created = await put(s, "presets", "p1", { baseRevision: null, data: { name: "one", temp: 0.5 } });
        expect(created.status).toBe(200);
        const first = (await created.json()) as Stored;
        expect(first.data).toEqual({ name: "one", temp: 0.5 });
        expect(first.revision).toMatch(/^[0-9a-f-]{36}:1:1$/);
        expect(await (await get(s, "presets", "p1")).json()).toEqual(first);

        const updated = await put(s, "presets", "p1", { baseRevision: first.revision, data: { name: "two" } });
        expect(updated.status).toBe(200);
        const second = (await updated.json()) as Stored;
        expect(second).toEqual({ revision: first.revision.replace(/:1$/, ":2"), data: { name: "two" } });
        expect(await (await get(s, "presets", "p1")).json()).toEqual(second);
        expect(await (await list(s, "presets")).json()).toEqual({ items: [{ id: "p1", ...second }] });
        // Kinds do not share ids.
        expect((await get(s, "characters", "p1")).status).toBe(404);
    });

    it("answers 409 with the current revision for a stale update and leaves the record unchanged", async () => {
        const s = await authedServer();
        const first = await create(s, "characters", "c1", { v: 1 });
        const current = (
            (await (await put(s, "characters", "c1", { baseRevision: first, data: { v: 2 } })).json()) as Stored
        ).revision;

        await expectConflict(
            await put(s, "characters", "c1", { baseRevision: first, data: { v: 3 } }),
            current,
            "stale",
        );
        expect(await (await get(s, "characters", "c1")).json()).toEqual({ revision: current, data: { v: 2 } });
    });

    it("answers 409 with the current revision for a duplicate create and for malformed or empty tokens", async () => {
        const s = await authedServer();
        const current = await create(s, "modules", "m1", 1);

        await expectConflict(await put(s, "modules", "m1", { baseRevision: null, data: 2 }), current, "duplicate");
        for (const token of ["", "garbage", current.replace(/^[0-9a-f-]{36}/, "not-a-uuid"), `${current}:1`, "1:1"]) {
            await expectConflict(
                await put(s, "modules", "m1", { baseRevision: token, data: 2 }),
                current,
                `put ${token}`,
            );
            await expectConflict(
                await remove(s, "modules", "m1", `?baseRevision=${token}`),
                current,
                `delete ${token}`,
            );
        }
        expect(await (await get(s, "modules", "m1")).json()).toEqual({ revision: current, data: 1 });
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
            const res = await put(s, "root", "r", body);
            expect(res.status, label).toBe(400);
            expect(await res.json(), label).toEqual({ error: envelope });
        }
        const textBody = await s.app.request("/api/resources/root/r", {
            method: "PUT",
            headers: await s.headers({ "content-type": "text/plain" }),
            body: JSON.stringify({ baseRevision: null, data: 1 }),
        });
        expect(textBody.status).toBe(400);
        expect(await textBody.json()).toEqual({ error: envelope });
        const invalidJson = await s.app.request("/api/resources/root/r", {
            method: "PUT",
            headers: await s.headers({ "content-type": "application/json" }),
            body: "{ baseRevision: null",
        });
        expect(invalidJson.status).toBe(400);
        expect(await invalidJson.json()).toEqual({ error: "Invalid JSON body" });
        expect((await get(s, "root", "r")).status).toBe(404);

        let revision: string | null = null;
        for (const data of [0, "", false, null]) {
            const res = await put(s, "root", "r", { baseRevision: revision, data });
            expect(res.status, JSON.stringify(data)).toBe(200);
            const stored = (await res.json()) as Stored;
            expect(stored.data, JSON.stringify(data)).toBe(data);
            revision = stored.revision;
        }
        expect(await (await get(s, "root", "r")).json()).toEqual({ revision, data: null });
    });

    it("rejects data the store cannot keep as JSON with 400", async () => {
        const s = await authedServer();
        // Sent as text: a JavaScript `1e400` literal is already `Infinity`, which `JSON.stringify` would drop.
        const infinite = await s.app.request("/api/resources/root/r", {
            method: "PUT",
            headers: await s.headers({ "content-type": "application/json" }),
            body: '{"baseRevision":null,"data":{"n":1e400}}',
        });
        expect(infinite.status).toBe(400);
        expect(await infinite.json()).toEqual({ error: "Resource data contains a non-finite number" });

        const nested = (depth: number) => "[".repeat(depth) + "1" + "]".repeat(depth);
        const deep = await s.app.request("/api/resources/root/r", {
            method: "PUT",
            headers: await s.headers({ "content-type": "application/json" }),
            body: `{"baseRevision":null,"data":${nested(257)}}`,
        });
        expect(deep.status).toBe(400);
        expect(await deep.json()).toEqual({ error: "Resource data is nested deeper than 256 levels" });
        expect((await get(s, "root", "r")).status).toBe(404);

        const ok = await s.app.request("/api/resources/root/r", {
            method: "PUT",
            headers: await s.headers({ "content-type": "application/json" }),
            body: `{"baseRevision":null,"data":${nested(256)}}`,
        });
        expect(ok.status).toBe(200);
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
        expect((await get(s, "root", "r")).status).toBe(404 /* the default kinds are replaced */);

        for (const data of [1, "   ", null]) {
            const res = await put(s, "names", "n", { baseRevision: null, data });
            expect(res.status, JSON.stringify(data)).toBe(400);
            expect(await res.json(), JSON.stringify(data)).toEqual({ error: "Name must be a non-empty string" });
        }
        expect((await get(s, "names", "n")).status).toBe(404);

        const created = await put(s, "names", "n", { baseRevision: null, data: "  Alice " });
        expect(created.status).toBe(200);
        const stored = (await created.json()) as Stored;
        expect(stored.data).toBe("Alice");
        expect(await (await get(s, "names", "n")).json()).toEqual(stored);

        const rejectedUpdate = await put(s, "names", "n", { baseRevision: stored.revision, data: "" });
        expect(rejectedUpdate.status).toBe(400);
        expect(await (await get(s, "names", "n")).json()).toEqual(stored);
    });

    it("lists records in creation order, unchanged by updates", async () => {
        const s = await authedServer();
        for (const id of ["c", "a", "b"]) {
            await create(s, "plugins", id, id);
        }
        const revisionOfA = ((await (await get(s, "plugins", "a")).json()) as Stored).revision;
        expect((await put(s, "plugins", "a", { baseRevision: revisionOfA, data: "a2" })).status).toBe(200);
        const items = ((await (await list(s, "plugins")).json()) as { items: (Stored & { id: string })[] }).items;
        expect(items.map((item) => [item.id, item.data])).toEqual([
            ["c", "c"],
            ["a", "a2"],
            ["b", "b"],
        ]);
        expect(await (await list(s, "modules")).json()).toEqual({ items: [] });
    });

    it("deletes with the current token only, and an old token stays stale after a recreate", async () => {
        const s = await authedServer();
        const first = await create(s, "pluginStorage", "k", { a: 1 });
        const current = (
            (await (await put(s, "pluginStorage", "k", { baseRevision: first, data: { a: 2 } })).json()) as Stored
        ).revision;

        await expectConflict(await remove(s, "pluginStorage", "k", `?baseRevision=${first}`), current, "stale delete");
        expect((await get(s, "pluginStorage", "k")).status).toBe(200);

        const missingQuery = await remove(s, "pluginStorage", "k", "");
        expect(missingQuery.status).toBe(400);
        expect(await missingQuery.json()).toEqual({ error: "baseRevision query parameter required" });

        const deleted = await remove(s, "pluginStorage", "k", `?baseRevision=${current}`);
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ success: true });
        expect((await get(s, "pluginStorage", "k")).status).toBe(404);
        expect(await (await list(s, "pluginStorage")).json()).toEqual({ items: [] });

        // The record is gone: a token names nothing, and the client learns that with `revision: null`.
        await expectConflict(await remove(s, "pluginStorage", "k", `?baseRevision=${current}`), null, "delete missing");
        await expectConflict(
            await put(s, "pluginStorage", "k", { baseRevision: current, data: 3 }),
            null,
            "put missing",
        );

        const recreated = await create(s, "pluginStorage", "k", { a: 3 });
        expect(recreated).not.toBe(current);
        await expectConflict(
            await put(s, "pluginStorage", "k", { baseRevision: current, data: 4 }),
            recreated,
            "old put",
        );
        await expectConflict(
            await remove(s, "pluginStorage", "k", `?baseRevision=${current}`),
            recreated,
            "old delete",
        );
        expect(await (await get(s, "pluginStorage", "k")).json()).toEqual({ revision: recreated, data: { a: 3 } });
    });

    it("answers 404 for an unknown kind and 400 for an invalid id on every route", async () => {
        const s = await authedServer();
        for (const kind of ["unknown", "Root", "root%2F"]) {
            const responses = [
                await list(s, kind),
                await get(s, kind, "x"),
                await put(s, kind, "x", { baseRevision: null, data: 1 }),
                await remove(s, kind, "x", "?baseRevision=t"),
            ];
            for (const res of responses) {
                expect(res.status, kind).toBe(404);
                expect(await res.json(), kind).toEqual({ error: "Unknown resource kind" });
            }
        }
        // (`..`, even percent-encoded, never reaches the route: the URL parser resolves it away.)
        for (const id of [".x", "-x", "_x", "a%20b", "a%2Fb", "a".repeat(129), "%E3%81%82"]) {
            const responses = [
                await get(s, "root", id),
                await put(s, "root", id, { baseRevision: null, data: 1 }),
                await remove(s, "root", id, "?baseRevision=t"),
            ];
            for (const res of responses) {
                expect(res.status, id).toBe(400);
                expect(await res.json(), id).toEqual({ error: "Invalid resource id" });
            }
        }
        expect((await put(s, "root", "a.b_c-D", { baseRevision: null, data: 1 })).status).toBe(200);
        expect((await put(s, "root", "a".repeat(128), { baseRevision: null, data: 1 })).status).toBe(200);
        expect(await (await list(s, "root")).json()).toMatchObject({
            items: [{ id: "a.b_c-D" }, { id: "a".repeat(128) }],
        });
    });

    it("requires the auth header on every route", async () => {
        const s = await authedServer();
        await create(s, "root", "r", 1);
        const requests: [string, RequestInit][] = [
            ["/api/resources/root", {}],
            ["/api/resources/root/r", {}],
            [
                "/api/resources/root/r",
                {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ baseRevision: null, data: 2 }),
                },
            ],
            ["/api/resources/root/r?baseRevision=t", { method: "DELETE" }],
        ];
        for (const [url, init] of requests) {
            const res = await s.app.request(url, init);
            expect(res.status, `${init.method ?? "GET"} ${url}`).toBe(400);
            expect(await res.json(), url).toEqual({ error: "No auth header" });
        }
        expect(await (await get(s, "root", "r")).json()).toMatchObject({ data: 1 });
    });
});
