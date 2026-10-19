// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventInput } from "../../../../shared/diagnostics.ts";
import {
    RESOURCE_BOOT_PATH,
    RESOURCE_KIND,
    type ResourceBootRequest,
    type ResourceReadKindsResult,
} from "../../../../shared/resources.ts";
import { indexedDbBootCacheStore, itemKey, loadBootSnapshot, recordKey } from "../bootCache";

// The boot cache against the real boot route (`docs/plan/boot-resource-cache.md` slice 3, the
// oracle of Sol's plan review point 7): the snapshot a boot through the cache gives equals
// `GET /api/resources` exactly (the JSON text of every record, the envelope, the order), on the
// first boot, on a boot that claims everything, and after a module edit, a character edit, a
// deleted character and a reordered module list; the cache holds the server's texts and never the
// character with a TTS key. The adapter runs on `fake-indexeddb`; the unit and fallback cases are
// in `bootCache.test.ts`.
//
// The server's test support is loaded through a computed path (as `backuplocalSnapshot.test.ts`):
// a static import would pull the server's sources into the client's `svelte-check` program.

const SERVER_TESTS = "../../../../server/src/tests/";

type TestClient = {
    request(url: string, init?: RequestInit): Promise<Response>;
    json(url: string, body: unknown, init?: RequestInit): Promise<Response>;
    put(kind: string, id: string, body: unknown): Promise<Response>;
    create(kind: string, id: string, data: unknown): Promise<string>;
    remove(kind: string, id: string, query: string): Promise<Response>;
    close(): Promise<void>;
};
type Support = { createResourceTestClient(): Promise<TestClient> };
let support: Support;
const servers: TestClient[] = [];

const ALL_KINDS = Object.values(RESOURCE_KIND) as string[];
const APP = "v1";

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    support = (await import(/* @vite-ignore */ `${SERVER_TESTS}testSupport.ts`)) as Support;
});
afterAll(() => {
    vi.restoreAllMocks();
});
beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, name: `name ${id}`, ...extra });
const module = (id: string, assets: number) => ({
    id,
    name: `module ${id}`,
    description: "",
    assets: Array.from({ length: assets }, (_, index) => [`a${index}`, `assets/${id}${index}.png`, "png"]),
});

async function server() {
    const s = await support.createResourceTestClient();
    servers.push(s);
    return s;
}

async function putRecord(s: TestClient, kind: string, id: string, data: unknown) {
    const current = (await (await s.request(`/api/resources/${kind}/${id}`)).json()) as { revision?: string | null };
    const res = await s.put(kind, id, { baseRevision: current.revision ?? null, data });
    expect(res.status, await res.clone().text()).toBe(200);
}

async function fullRead(s: TestClient): Promise<ResourceReadKindsResult> {
    const res = await s.request(`/api/resources?kinds=${ALL_KINDS.join(",")}&chatSummaries=1`);
    expect(res.status).toBe(200);
    return (await res.json()) as ResourceReadKindsResult;
}

function depsFor(s: TestClient, store = indexedDbBootCacheStore(APP)) {
    const deps = {
        store,
        appVer: APP,
        events: [] as DiagnosticEventInput[],
        requests: [] as ResourceBootRequest[],
        fullReads: 0,
        readBoot: async (request: ResourceBootRequest) => {
            deps.requests.push(request);
            const res = await s.json(RESOURCE_BOOT_PATH, request);
            expect(res.status, await res.clone().text()).toBe(200);
            return (await res.json()) as unknown;
        },
        readKinds: async () => {
            deps.fullReads += 1;
            return fullRead(s);
        },
        report: (event: DiagnosticEventInput) => deps.events.push(event),
    };
    return deps;
}

/** The cache's stores, raw. */
async function dump() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("risu-boot-cache", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["records", "items", "meta"], "readonly");
    const all = async (name: string) => {
        const store = tx.objectStore(name);
        const [keys, values] = await Promise.all([
            new Promise<IDBValidKey[]>((resolve) => {
                const request = store.getAllKeys();
                request.onsuccess = () => resolve(request.result);
            }),
            new Promise<unknown[]>((resolve) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
            }),
        ]);
        return new Map(keys.map((key, index) => [key as string, values[index]]));
    };
    const [records, items, meta] = await Promise.all([all("records"), all("items"), all("meta")]);
    await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
    db.close();
    return { records, items, meta: meta.get("meta") as { generation: string } | undefined };
}

/** Every cached-kind record of the full read is in the cache as the server's own text (or its items' texts), except the credential holder. */
async function expectCacheOf(full: ResourceReadKindsResult) {
    const { records, items } = await dump();
    for (const kind of ["characters", "modules", "presets"]) {
        for (const record of full.kinds[kind] ?? []) {
            const stored = records.get(recordKey(kind, record.id)) as
                { revision: string; text?: string; hashes?: string[] } | undefined;
            const data = record.data as Record<string, unknown>;
            if (
                kind === "characters" &&
                typeof (data.oaiTTSConfig as { apiKey?: unknown })?.apiKey === "string" &&
                data.oaiTTSConfig["apiKey"] !== ""
            ) {
                expect(stored, `${kind}/${record.id} holds a credential`).toBeUndefined();
                continue;
            }
            expect(stored, `${kind}/${record.id}`).toBeDefined();
            expect(stored!.revision).toBe(record.revision);
            if (stored!.text !== undefined) {
                expect(stored!.text).toBe(JSON.stringify(record.data));
            } else {
                const texts = stored!.hashes!.map((hash) => items.get(itemKey(kind, hash)));
                expect(`[${texts.join(",")}]`).toBe(JSON.stringify(record.data));
            }
        }
    }
}

describe("the boot through the cache against the real route", () => {
    it("equals the full read on the first boot, on a boot that claims everything, and after edits, a deletion and a reorder; the cache holds the server's texts", async () => {
        const s = await server();
        await putRecord(s, "modules", "main", [module("m1", 3), module("m2", 2), module("m1", 3)]);
        await s.create("characters", "c1", character("c1"));
        await s.create("characters", "c2", character("c2", { oaiTTSConfig: { apiKey: "secret" } }));
        const store = indexedDbBootCacheStore(APP);

        // First boot: nothing claimed.
        let deps = depsFor(s, store);
        let boot = await loadBootSnapshot(deps);
        let full = await fullRead(s);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(full));
        expect(deps.requests[0]).not.toHaveProperty("known");
        expect(deps.fullReads).toBe(0);
        expect(deps.events).toEqual([]);
        await boot.commit();
        await expectCacheOf(full);
        let state = await dump();
        expect([...state.items.keys()].filter((key) => key.startsWith("modules"))).toHaveLength(2);
        expect(state.records.has(recordKey("characters", "c2"))).toBe(false);

        // Second boot: every record and hash claimed, everything `cached`, the same result.
        deps = depsFor(s, store);
        boot = await loadBootSnapshot(deps);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(full));
        const known = deps.requests[0].known!;
        expect(known.records.map((entry) => `${entry.kind}/${entry.id}`).sort()).toEqual(
            ["characters/c1", "modules/main", "presets/main"].sort(),
        );
        expect(known.items.find((entry) => entry.kind === "modules")?.hashes).toHaveLength(2);
        const raw = (await (await s.json(RESOURCE_BOOT_PATH, deps.requests[0])).json()) as {
            kinds: Record<string, Record<string, unknown>[]>;
        };
        expect(raw.kinds.characters.map((record) => record.cached ?? false)).toEqual([true, false]);
        expect(raw.kinds.modules[0].cached).toBe(true);
        expect(raw.kinds.presets[0].cached).toBe(true);
        await boot.commit();
        const generation = state.meta?.generation;
        state = await dump();
        expect(state.meta?.generation).not.toBe(generation);

        // One module changed, one character renamed, one created: a partial answer, the same result,
        // the old item collected.
        await putRecord(s, "modules", "main", [module("m1", 3), module("m3", 5), module("m1", 3)]);
        await putRecord(s, "characters", "c1", character("c1", { name: "renamed" }));
        await s.create("characters", "c3", character("c3"));
        deps = depsFor(s, store);
        boot = await loadBootSnapshot(deps);
        full = await fullRead(s);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(full));
        const partial = (await (await s.json(RESOURCE_BOOT_PATH, deps.requests[0])).json()) as {
            kinds: Record<string, Record<string, unknown>[]>;
        };
        const items = partial.kinds.modules[0].items as { hash: string; data?: unknown }[];
        expect(items.map((item) => Object.hasOwn(item, "data"))).toEqual([false, true, false]);
        expect(partial.kinds.presets[0].cached).toBe(true);
        expect(partial.kinds.characters.every((record) => !record.cached)).toBe(true);
        await boot.commit();
        await expectCacheOf(full);
        state = await dump();
        expect([...state.items.keys()].filter((key) => key.startsWith("modules"))).toHaveLength(2);
        expect(state.records.has(recordKey("characters", "c3"))).toBe(true);

        // A deleted character and a reordered module list.
        const c3 = (full.kinds.characters.find((record) => record.id === "c3") as { revision: string }).revision;
        const removed = await s.remove("characters", "c3", `?baseRevision=${encodeURIComponent(c3)}`);
        expect(removed.status, await removed.clone().text()).toBe(200);
        await putRecord(s, "modules", "main", [module("m3", 5), module("m1", 3), module("m1", 3)]);
        deps = depsFor(s, store);
        boot = await loadBootSnapshot(deps);
        full = await fullRead(s);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(full));
        expect(full.kinds.characters.map((record) => record.id)).toEqual(["c1", "c2"]);
        const reordered = (await (await s.json(RESOURCE_BOOT_PATH, deps.requests[0])).json()) as {
            kinds: Record<string, Record<string, unknown>[]>;
        };
        expect(
            (reordered.kinds.modules[0].items as { data?: unknown }[]).every((item) => !Object.hasOwn(item, "data")),
        ).toBe(true);
        await boot.commit();
        await expectCacheOf(full);
        state = await dump();
        expect(state.records.has(recordKey("characters", "c3"))).toBe(false);
        expect(deps.events).toEqual([]);
        expect(deps.fullReads).toBe(0);
    });

    it("a modified cached text that still parses falls back to the plain read and clears the cache (a character under another id)", async () => {
        const s = await server();
        await s.create("characters", "c1", character("c1"));
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(s, store))).commit();
        const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("risu-boot-cache", 1);
            request.onsuccess = () => resolve(request.result);
        });
        const tx = db.transaction("records", "readwrite");
        const key = recordKey("characters", "c1");
        const stored = await new Promise<{ text: string }>((resolve) => {
            const request = tx.objectStore("records").get(key);
            request.onsuccess = () => resolve(request.result);
        });
        tx.objectStore("records").put({ ...stored, text: JSON.stringify(character("other")) }, key);
        await new Promise<void>((resolve) => (tx.oncomplete = () => resolve()));
        db.close();
        const deps = depsFor(s, store);
        const boot = await loadBootSnapshot(deps);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(await fullRead(s)));
        expect(boot.snapshot.kinds.characters.map((record) => (record.data as { chaId: string }).chaId)).toEqual([
            "c1",
        ]);
        await boot.commit();
        expect(deps.events).toEqual([
            expect.objectContaining({ kind: "bootCache", phase: "fallback", reason: "incomplete", records: 2 }),
            { kind: "bootCache", phase: "cleared", reason: "incomplete" },
        ]);
        expect((await dump()).records.size).toBe(0);
    });
});
