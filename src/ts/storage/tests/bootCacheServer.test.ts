// @vitest-environment node
import { CHAT_SUMMARY_FORMAT } from "../../../../shared/chats.ts";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventInput } from "../../../../shared/diagnostics.ts";
import {
    RESOURCE_BOOT_PATH,
    chatCollectionClaim,
    type ResourceBootResult,
    RESOURCE_KIND,
    type ResourceBootRequest,
    type ResourceReadKindsResult,
} from "../../../../shared/resources.ts";
import { indexedDbBootCacheStore, itemKey, loadBootSnapshot, recordKey } from "../bootCache";

// The boot cache against the real boot route (the equivalence oracle): the snapshot a boot through
// the cache gives equals `GET /api/resources` exactly (the JSON text of every record, the envelope,
// the order), on the first boot, on a boot that claims everything, and after a module edit, a
// character edit, a deleted character and a reordered module list; the cache holds the server's
// texts and never the character with a TTS key. The adapter runs on `fake-indexeddb`; the unit and
// fallback cases are in `bootCache.test.ts`.
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
    vi.useRealTimers();
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
        answers: [] as ResourceBootResult[],
        fullReads: 0,
        readBoot: async (request: ResourceBootRequest) => {
            deps.requests.push(request);
            const res = await s.json(RESOURCE_BOOT_PATH, request);
            expect(res.status, await res.clone().text()).toBe(200);
            const answer = (await res.json()) as ResourceBootResult;
            deps.answers.push(answer);
            return answer;
        },
        readKinds: async () => {
            deps.fullReads += 1;
            return fullRead(s);
        },
        report: (event: DiagnosticEventInput) => deps.events.push(event),
    };
    return deps;
}

async function chatBatch(s: TestClient, body: unknown) {
    const response = await s.json("/api/resources/batch", body);
    expect(response.status, await response.clone().text()).toBe(200);
}

/** Chat seq interleaves characters; order seq follows character creation instead. */
async function seedInterleavedChats(s: TestClient) {
    for (const id of ["c1", "c2", "c3"]) await s.create("characters", id, character(id));
    await chatBatch(s, {
        chats: ["c2", "c1", "c3", "c2", "c1", "c3"].map((characterId, index) => ({
            characterId,
            chatId: `chat${index}`,
            baseRevision: null,
            ops: [{ op: "create", chat: { name: `Chat ${index}`, message: [] } }],
        })),
    });
}

/** The cache's stores, raw. */
async function dump() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("risu-boot-cache", 2);
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

    it("caches inlays as whole records and re-sends only a stale inlay through the real route", async () => {
        const s = await server();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const inlay = { name: "Image", ext: "png", type: "image", asset: "assets/image.png", width: 32, height: 16 };
        await s.create("inlays", "i1", inlay);
        await s.create("inlays", "i2", { ...inlay, name: "Other" });
        const store = indexedDbBootCacheStore(APP);
        const cold = depsFor(s, store);
        const first = await loadBootSnapshot(cold);
        const before = await fullRead(s);
        expect(cold.answers[0].kinds.inlays).toEqual(before.kinds.inlays);
        expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(before));
        await first.commit();
        const state = await dump();
        for (const record of before.kinds.inlays) {
            expect(state.records.get(recordKey("inlays", record.id))).toEqual({
                kind: "inlays",
                id: record.id,
                revision: record.revision,
                text: JSON.stringify(record.data),
            });
        }
        const warm = depsFor(s, store);
        expect(JSON.stringify((await loadBootSnapshot(warm)).snapshot)).toBe(JSON.stringify(before));
        expect(warm.requests[0].known?.records?.filter(({ kind }) => kind === "inlays")).toEqual(
            before.kinds.inlays.map(({ id, revision }) => ({ kind: "inlays", id, revision })),
        );
        expect(warm.answers[0].kinds.inlays).toEqual(
            before.kinds.inlays.map(({ id, revision }) => ({ id, revision, cached: true })),
        );
        await putRecord(s, "inlays", "i1", { ...inlay, name: "Edited image" });
        const changed = depsFor(s, store);
        const boot = await loadBootSnapshot(changed);
        const after = await fullRead(s);
        expect(changed.answers[0].kinds.inlays).toEqual([
            after.kinds.inlays[0],
            { id: "i2", revision: before.kinds.inlays[1].revision, cached: true },
        ]);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(after));
        expect([cold.fullReads, warm.fullReads, changed.fullReads]).toEqual([0, 0, 0]);
    });

    it.each(["a metadata change", "a message append", "an added chat", "a removed chat", "a changed order"] as const)(
        "re-sends only the affected character after %s and reconstructs interleaved summaries and orders exactly",
        async (change) => {
            const s = await server();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            await seedInterleavedChats(s);
            const store = indexedDbBootCacheStore(APP);
            const first = await loadBootSnapshot(depsFor(s, store));
            const before = await fullRead(s);
            expect(before.chatSummaries!.map(({ characterId }) => characterId)).toEqual([
                "c2",
                "c1",
                "c3",
                "c2",
                "c1",
                "c3",
            ]);
            expect(before.chatOrders!.map(({ characterId }) => characterId)).toEqual(["c1", "c2", "c3"]);
            expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(before));
            await first.commit();
            const warm = depsFor(s, store);
            const warmBoot = await loadBootSnapshot(warm);
            expect(
                warm.requests[0].known?.chatCollections
                    ?.slice()
                    .sort((a, b) => a.characterId.localeCompare(b.characterId)),
            ).toEqual(
                ["c1", "c2", "c3"].map((characterId) => ({
                    characterId,
                    claim: chatCollectionClaim(
                        CHAT_SUMMARY_FORMAT,
                        characterId,
                        before.chatOrders!.find((row) => row.characterId === characterId)!.revision,
                        before.chatSummaries!.filter((row) => row.characterId === characterId),
                    ),
                })),
            );
            expect(warm.answers[0].cachedChatCollections?.slice().sort()).toEqual(["c1", "c2", "c3"]);
            expect(warm.answers[0].chatSummaries).toEqual([]);
            expect(warm.answers[0].chatOrders).toEqual([]);
            expect(warm.answers[0].chatSummaryFormat).toBe(CHAT_SUMMARY_FORMAT);
            expect(warmBoot.snapshot.chatSummaries!.map(({ id }) => id)).toEqual([
                "chat0",
                "chat1",
                "chat2",
                "chat3",
                "chat4",
                "chat5",
            ]);
            expect(warmBoot.snapshot.chatOrders!.map(({ characterId }) => characterId)).toEqual(["c1", "c2", "c3"]);
            expect(JSON.stringify(warmBoot.snapshot)).toBe(JSON.stringify(before));
            await warmBoot.commit();

            const target = before.chatSummaries!.find(({ id }) => id === "chat0")!;
            const order = before.chatOrders!.find(({ characterId }) => characterId === "c2")!;
            if (change === "a changed order") {
                await chatBatch(s, {
                    chatOrders: [{ characterId: "c2", baseRevision: order.revision, ids: [...order.ids].reverse() }],
                });
            } else {
                const ops =
                    change === "a metadata change"
                        ? [{ op: "meta", set: { name: "Renamed" } }]
                        : change === "a message append"
                          ? [
                                {
                                    op: "append",
                                    anchor: { end: true },
                                    messages: [{ role: "user", chatId: "message1", data: "Hello", time: 123 }],
                                },
                            ]
                          : change === "an added chat"
                            ? [{ op: "create", chat: { name: "New", message: [] } }]
                            : [{ op: "delete" }];
                await chatBatch(s, {
                    chats: [
                        {
                            characterId: "c2",
                            chatId: change === "an added chat" ? "new" : target.id,
                            baseRevision: change === "an added chat" ? null : target.revision,
                            ops,
                        },
                    ],
                });
            }
            const deps = depsFor(s, store);
            const boot = await loadBootSnapshot(deps);
            const full = await fullRead(s);
            const answer = deps.answers[0];
            expect(answer.chatSummaryFormat).toBe(CHAT_SUMMARY_FORMAT);
            expect(answer.cachedChatCollections?.slice().sort()).toEqual(["c1", "c3"]);
            expect(answer.chatSummaries).toEqual(full.chatSummaries!.filter(({ characterId }) => characterId === "c2"));
            expect(answer.chatOrders).toEqual(full.chatOrders!.filter(({ characterId }) => characterId === "c2"));
            expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(full));
            expect(warm.fullReads).toBe(0);
            expect(deps.fullReads).toBe(0);
            expect(deps.events).toEqual([]);
        },
    );

    it.each(["another", "missing"] as const)(
        "does not cache summaries from an answer with %s chatSummaryFormat and falls back if that answer omits cached collections",
        async (format) => {
            const s = await server();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            await seedInterleavedChats(s);
            const store = indexedDbBootCacheStore(APP);
            const withFormat = () => {
                const deps = depsFor(s, store);
                const readBoot = deps.readBoot;
                deps.readBoot = async (request) => {
                    const answer = await readBoot(request);
                    if (format === "missing") delete answer.chatSummaryFormat;
                    else answer.chatSummaryFormat = CHAT_SUMMARY_FORMAT + 1;
                    return answer;
                };
                return deps;
            };
            const full = await fullRead(s);
            const cold = withFormat();
            const first = await loadBootSnapshot(cold);
            expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(full));
            await first.commit();
            expect([...(await dump()).records.keys()].filter((key) => key.startsWith("@chatCollection"))).toEqual([]);
            const next = depsFor(s, store);
            const nextBoot = await loadBootSnapshot(next);
            expect(next.requests[0].known?.chatCollections ?? []).toEqual([]);
            expect(next.answers[0].cachedChatCollections).toEqual([]);
            expect(next.answers[0].chatSummaries).toEqual(full.chatSummaries);
            expect(next.answers[0].chatOrders).toEqual(full.chatOrders);
            expect(JSON.stringify(nextBoot.snapshot)).toBe(JSON.stringify(full));
            await nextBoot.commit();
            // Now there is a valid collection to claim, but the producer's format no longer agrees.
            const incompatible = withFormat();
            const fallback = await loadBootSnapshot(incompatible);
            expect(incompatible.requests[0].known?.chatCollections).toHaveLength(3);
            expect(incompatible.answers[0].cachedChatCollections).toHaveLength(3);
            expect(JSON.stringify(fallback.snapshot)).toBe(JSON.stringify(full));
            expect(incompatible.fullReads).toBe(1);
            expect(incompatible.events).toContainEqual(
                expect.objectContaining({ kind: "bootCache", phase: "fallback", reason: "format" }),
            );
            await fallback.commit();
            expect((await dump()).records.size).toBe(0);
        },
    );

    it("falls back to the plain read when an answer omits an unclaimed chat collection", async () => {
        const s = await server();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await seedInterleavedChats(s);
        const deps = depsFor(s);
        const readBoot = deps.readBoot;
        deps.readBoot = async (request) => {
            const answer = await readBoot(request);
            answer.cachedChatCollections = ["c2"];
            answer.chatSummaries = answer.chatSummaries!.filter(({ characterId }) => characterId !== "c2");
            answer.chatOrders = answer.chatOrders!.filter(({ characterId }) => characterId !== "c2");
            return answer;
        };
        const boot = await loadBootSnapshot(deps);
        expect(deps.requests[0]).not.toHaveProperty("known");
        expect(deps.fullReads).toBe(1);
        expect(JSON.stringify(boot.snapshot)).toBe(JSON.stringify(await fullRead(s)));
        expect(deps.events).toContainEqual(
            expect.objectContaining({ kind: "bootCache", phase: "fallback", reason: "incomplete" }),
        );
        await boot.commit();
        expect((await dump()).records.size).toBe(0);
    });

    it("a modified cached text that still parses falls back to the plain read and clears the cache (a character under another id)", async () => {
        const s = await server();
        await s.create("characters", "c1", character("c1"));
        const store = indexedDbBootCacheStore(APP);
        await (await loadBootSnapshot(depsFor(s, store))).commit();
        const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open("risu-boot-cache", 2);
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
            // The claimed records count the character's chat collection too.
            expect.objectContaining({ kind: "bootCache", phase: "fallback", reason: "incomplete", records: 3 }),
            { kind: "bootCache", phase: "cleared", reason: "incomplete" },
        ]);
        expect((await dump()).records.size).toBe(0);
    });
});
