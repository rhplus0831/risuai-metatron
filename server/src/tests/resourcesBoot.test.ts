// @vitest-environment node
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    BOOT_CACHED_KINDS,
    BOOT_ITEM_HASH_PATTERN,
    BOOT_ITEM_KINDS,
    BOOT_RESOURCE_FORMAT,
    MAX_BOOT_BODY_BYTES,
    RESOURCE_BOOT_PATH,
    RESOURCE_KIND,
    type ResourceBootItem,
    type ResourceBootRecord,
    type ResourceBootRequest,
    type ResourceBootResult,
    type ResourceReadKindsResult,
    type ResourceRecord,
} from "../../../shared/resources.ts";
import { createKindRegistry, type ResourceKind } from "../data/kinds.ts";
import { COMPRESS_MIN_BYTES } from "../http/compressedJson.ts";
import { MAX_BOOT_ENTRIES } from "../routes/resourceBoot.ts";
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

type BootError = { error: string };
type Cached = { id: string; revision: string; cached: true };
type Itemized = { id: string; revision: string; items: ResourceBootItem[] };

/** A server over `DEFAULT_RESOURCE_KINDS`. */
async function defaultServer() {
    const s = await createResourceTestClient();
    servers.push(s);
    return s;
}

const ALL_KINDS = Object.values(RESOURCE_KIND);
const character = (id: string, extra: Record<string, unknown> = {}) => ({ chaId: id, ...extra });
const module = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `module ${id}`, ...extra });

const boot = (s: ResourceTestClient, body: unknown, headers: Record<string, string> = {}) =>
    s.json(RESOURCE_BOOT_PATH, body, { headers });

async function bootResult(s: ResourceTestClient, body: ResourceBootRequest): Promise<ResourceBootResult> {
    const res = await boot(s, body);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as ResourceBootResult;
}

async function fullRead(s: ResourceTestClient, kinds: readonly string[], chatSummaries = false) {
    const res = await s.request(`/api/resources?kinds=${kinds.join(",")}${chatSummaries ? "&chatSummaries=1" : ""}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ResourceReadKindsResult;
}

/** The contract's hash, computed from the item as the client received it (not the server's function). */
const hashOf = (item: unknown) => createHash("sha256").update(JSON.stringify(item)).digest("base64url").slice(0, 22);

const isCached = (record: ResourceBootRecord): record is Cached => "cached" in record && record.cached === true;
const isItemized = (record: ResourceBootRecord): record is Itemized => "items" in record && Array.isArray(record.items);

/** A boot answer as a plain read: every `items` record rebuilt by position from `data` or the client's item map. */
function expand(
    result: ResourceBootResult,
    itemTexts: ReadonlyMap<string, unknown> = new Map(),
): ResourceReadKindsResult {
    const kinds: Record<string, ResourceRecord[]> = {};
    for (const [name, records] of Object.entries(result.kinds)) {
        kinds[name] = records.map((record) => {
            if (isCached(record)) {
                throw new Error(`cached record ${name}/${record.id} cannot be expanded`);
            }
            if (!isItemized(record)) {
                return record;
            }
            const data = record.items.map((item, index) => {
                if (Object.hasOwn(item, "data")) {
                    return item.data;
                }
                if (!itemTexts.has(item.hash)) {
                    throw new Error(`${name}/${record.id} item ${index} (${item.hash}) was omitted but is unknown`);
                }
                return itemTexts.get(item.hash);
            });
            return { id: record.id, revision: record.revision, data };
        });
    }
    const { format: _format, kinds: _kinds, ...rest } = result;
    return { ...rest, kinds };
}

/** The `known` inventory as a client holding `read` sends it (both lists present). */
type KnownInventory = {
    records: { kind: string; id: string; revision: string }[];
    items: { kind: string; hashes: string[] }[];
};
/** The full `known` inventory a client holding `read` would send. */
function knownOf(read: ResourceReadKindsResult): KnownInventory {
    const records: { kind: string; id: string; revision: string }[] = [];
    const items: { kind: string; hashes: string[] }[] = [];
    for (const kind of BOOT_CACHED_KINDS) {
        for (const record of read.kinds[kind] ?? []) {
            records.push({ kind, id: record.id, revision: record.revision });
            if (BOOT_ITEM_KINDS.includes(kind) && Array.isArray(record.data)) {
                items.push({ kind, hashes: record.data.map(hashOf) });
            }
        }
    }
    return { records, items };
}

/** The item map a client holding `read` would have. */
function itemsOf(read: ResourceReadKindsResult): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const kind of BOOT_ITEM_KINDS) {
        for (const record of read.kinds[kind] ?? []) {
            if (Array.isArray(record.data)) {
                for (const item of record.data) {
                    map.set(hashOf(item), item);
                }
            }
        }
    }
    return map;
}

function expectCached(record: ResourceBootRecord, id: string, revision: string, label: string) {
    expect(record, label).toStrictEqual({ id, revision, cached: true });
}

function expectWhole(record: ResourceBootRecord, id: string, label: string): ResourceRecord {
    expect(isCached(record), label).toBe(false);
    expect(isItemized(record), label).toBe(false);
    expect(Object.hasOwn(record, "data"), label).toBe(true);
    expect(record.id, label).toBe(id);
    return record as ResourceRecord;
}

function expectItemized(record: ResourceBootRecord, id: string, label: string): Itemized {
    expect(isItemized(record), label).toBe(true);
    expect(Object.hasOwn(record, "data"), label).toBe(false);
    expect(Object.hasOwn(record, "cached"), label).toBe(false);
    expect(record.id, label).toBe(id);
    return record as Itemized;
}

/** The array positions of an `items` record carrying `data` (as a property). */
const sentPositions = (record: Itemized) =>
    record.items.flatMap((item, index) => (Object.hasOwn(item, "data") ? [index] : []));

describe("POST /api/resources/boot without an inventory", () => {
    it("answers the format, the epoch, and what GET /api/resources answers, item kinds as items", async () => {
        const s = await defaultServer();
        await s.create("characters", "b", character("b", { name: "Bee" }));
        await s.create("characters", "a", character("a"));
        // Two equal modules at positions 0 and 2: the answer keeps both with the same hash.
        await s.create("modules", "main", [module("m1"), module("m2", { description: "two" }), module("m1")]);

        const read = await fullRead(s, ALL_KINDS, true);
        const result = await bootResult(s, { kinds: [...ALL_KINDS], chatSummaries: true });
        expect(result.format).toBe(BOOT_RESOURCE_FORMAT);
        expect(result.epoch).toBe(s.epoch);
        expect(Object.keys(result.kinds)).toEqual(ALL_KINDS);
        expect(expand(result)).toEqual(read);

        for (const kind of ALL_KINDS) {
            for (const record of result.kinds[kind]) {
                const label = `${kind}/${record.id}`;
                expect(isCached(record), label).toBe(false);
                expect(isItemized(record), label).toBe(BOOT_ITEM_KINDS.includes(kind));
            }
        }
        const modules = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(modules.revision).toBe(read.kinds.modules[0].revision);
        expect(modules.items).toHaveLength(3);
        for (const [index, item] of modules.items.entries()) {
            expect(item.hash, `item ${index}`).toMatch(BOOT_ITEM_HASH_PATTERN);
            expect(item.hash, `item ${index}`).toBe(hashOf(item.data));
            expect(item.data, `item ${index}`).toEqual((read.kinds.modules[0].data as unknown[])[index]);
        }
        expect(modules.items[0].hash).toBe(modules.items[2].hash);
        expect(modules.items[0].hash).not.toBe(modules.items[1].hash);
        // `presets` materializes one default preset: an item record too.
        const presets = expectItemized(result.kinds.presets[0], "main", "presets");
        expect(presets.items.length).toBeGreaterThan(0);
        expect(presets.items.map((item) => item.hash)).toEqual((read.kinds.presets[0].data as unknown[]).map(hashOf));
        // Characters are whole records, in creation order.
        expect(result.kinds.characters.map((record) => record.id)).toEqual(["b", "a"]);
    });

    it("leaves out the chat summaries unless asked, and dedupes the requested kinds", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        const result = await bootResult(s, { kinds: ["ui", "characters", "ui"] });
        expect(Object.keys(result.kinds)).toEqual(["ui", "characters"]);
        expect(Object.hasOwn(result, "chatSummaries")).toBe(false);
        expect(Object.hasOwn(result, "chatOrders")).toBe(false);

        const withSummaries = await bootResult(s, { kinds: ["characters"], chatSummaries: true });
        const read = await fullRead(s, ["characters"], true);
        expect(withSummaries.chatSummaries).toEqual(read.chatSummaries);
        expect(withSummaries.chatOrders).toEqual(read.chatOrders);
        expect(withSummaries.chatOrders?.map((order) => order.characterId)).toEqual(["a"]);
    });

    it("projects the write-only kind as GET does", async () => {
        const s = await defaultServer();
        const secret = (await (await s.get("llmSecrets", "main")).json()) as { revision: string; data: unknown };
        await s.put("llmSecrets", "main", { baseRevision: secret.revision, data: { openAI: "sk-very-secret" } });
        const read = await fullRead(s, ["llmSecrets"]);
        const result = await bootResult(s, {
            kinds: ["llmSecrets"],
            known: { records: [{ kind: "llmSecrets", id: "main", revision: read.kinds.llmSecrets[0].revision }] },
        });
        const record = expectWhole(result.kinds.llmSecrets[0], "main", "llmSecrets");
        expect(record).toEqual(read.kinds.llmSecrets[0]);
        expect(JSON.stringify(record.data)).not.toContain("sk-very-secret");
    });
});

describe("POST /api/resources/boot with known revisions", () => {
    it("answers cached for a current revision, data for a stale one, and whole for other kinds", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const b = await s.create("characters", "b", character("b"));
        await s.create("modules", "main", [module("m1")]);
        const before = await fullRead(s, ALL_KINDS, true);
        const known = knownOf(before);

        // Everything current: every cached kind's record is `cached`, the rest whole.
        const all = await bootResult(s, { kinds: [...ALL_KINDS], chatSummaries: true, known });
        expect(all.epoch).toBe(before.epoch);
        for (const kind of BOOT_CACHED_KINDS) {
            for (const [index, record] of before.kinds[kind].entries()) {
                expectCached(all.kinds[kind][index], record.id, record.revision, `${kind}/${record.id}`);
            }
        }
        for (const kind of ALL_KINDS.filter((name) => !BOOT_CACHED_KINDS.includes(name))) {
            expect(all.kinds[kind], kind).toEqual(before.kinds[kind]);
        }
        expect(all.chatSummaries).toEqual(before.chatSummaries);
        expect(all.chatOrders).toEqual(before.chatOrders);

        // One character edited: only it carries data, at its new revision.
        const edited = await s.put("characters", "a", { baseRevision: a, data: character("a", { name: "Changed" }) });
        expect(edited.status).toBe(200);
        const after = await fullRead(s, ["characters"]);
        const partial = await bootResult(s, { kinds: ["characters", "modules"], known });
        expect(partial.kinds.characters).toHaveLength(2);
        const changed = expectWhole(partial.kinds.characters[0], "a", "characters/a");
        expect(changed).toEqual(after.kinds.characters[0]);
        expect(changed.revision).not.toBe(a);
        expectCached(partial.kinds.characters[1], "b", b, "characters/b");
        expectCached(partial.kinds.modules[0], "main", before.kinds.modules[0].revision, "modules");

        // A record claimed at a revision it never had is a miss.
        const wrong = await bootResult(s, {
            kinds: ["characters"],
            known: { records: [{ kind: "characters", id: "b", revision: a }] },
        });
        expect(expectWhole(wrong.kinds.characters[1], "b", "characters/b").data).toEqual(
            after.kinds.characters[1].data,
        );
    });

    it("never caches a kind outside BOOT_CACHED_KINDS, whatever the client claims", async () => {
        const s = await defaultServer();
        const read = await fullRead(s, ["ui", "hotkeys"]);
        const result = await bootResult(s, {
            kinds: ["ui", "hotkeys"],
            known: {
                records: [
                    { kind: "ui", id: "main", revision: read.kinds.ui[0].revision },
                    { kind: "hotkeys", id: "main", revision: read.kinds.hotkeys[0].revision },
                ],
                items: [{ kind: "ui", hashes: [hashOf(read.kinds.ui[0].data)] }],
            },
        });
        expect(result.kinds).toEqual(read.kinds);
    });

    it("misses a revision from another epoch while item hashes still match", async () => {
        const s = await defaultServer();
        await s.create("characters", "a", character("a"));
        await s.create("modules", "main", [module("m1"), module("m2")]);
        const snapshot = await s.context.snapshots.snapshotNow();
        const before = await fullRead(s, ["characters", "modules", "presets"]);
        const known = knownOf(before);

        const restored = await s.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" });
        expect(restored.status).toBe(200);
        const epoch = await s.readEpoch();
        expect(epoch).not.toBe(before.epoch);

        const result = await bootResult(s, { kinds: ["characters", "modules", "presets"], known });
        expect(result.epoch).toBe(epoch);
        const after = await fullRead(s, ["characters", "modules", "presets"]);
        expect(after.kinds.modules[0].data).toEqual(before.kinds.modules[0].data);
        expect(expectWhole(result.kinds.characters[0], "a", "characters/a")).toEqual(after.kinds.characters[0]);
        const modules = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(modules.revision).toBe(after.kinds.modules[0].revision);
        expect(modules.revision).not.toBe(before.kinds.modules[0].revision);
        // The content did not change, so every item is bare: the hashes are content addressed.
        expect(sentPositions(modules)).toEqual([]);
        expect(modules.items.map((item) => item.hash)).toEqual(known.items.find((e) => e.kind === "modules")!.hashes);
        expect(expand(result, itemsOf(before))).toEqual(after);
    });

    it("answers a record created since as whole and leaves a deleted one out", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const c = await s.create("characters", "c", character("c"));
        const before = await fullRead(s, ["characters"]);
        const known = knownOf(before);
        expect((await s.remove("characters", "c", `?baseRevision=${encodeURIComponent(c)}`)).status).toBe(200);
        await s.create("characters", "d", character("d"));

        const result = await bootResult(s, { kinds: ["characters"], known });
        expect(result.kinds.characters.map((record) => record.id)).toEqual(["a", "d"]);
        expectCached(result.kinds.characters[0], "a", a, "characters/a");
        const after = await fullRead(s, ["characters"]);
        expect(expectWhole(result.kinds.characters[1], "d", "characters/d")).toEqual(after.kinds.characters[1]);
    });
});

describe("POST /api/resources/boot with known item hashes", () => {
    it("sends only the edited item's data, bare hashes for the rest, and rebuilds by position", async () => {
        const s = await defaultServer();
        const revision = await s.create("modules", "main", [module("m1"), module("m2"), module("m3")]);
        const before = await fullRead(s, ["modules"]);
        const known = knownOf(before);
        const held = itemsOf(before);
        const hashes = known.items[0].hashes;
        expect(hashes).toHaveLength(3);

        const edit = [module("m1"), module("m2", { description: "edited" }), module("m3")];
        const edited = await s.put("modules", "main", { baseRevision: revision, data: edit });
        expect(edited.status).toBe(200);
        const after = await fullRead(s, ["modules"]);

        const result = await bootResult(s, { kinds: ["modules"], known });
        const modules = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(modules.revision).toBe(after.kinds.modules[0].revision);
        expect(modules.items).toHaveLength(3);
        expect(sentPositions(modules)).toEqual([1]);
        expect(modules.items[0]).toStrictEqual({ hash: hashes[0] });
        expect(modules.items[2]).toStrictEqual({ hash: hashes[2] });
        expect(modules.items[1].hash).not.toBe(hashes[1]);
        expect(modules.items[1].hash).toBe(hashOf(modules.items[1].data));
        expect(modules.items[1].data).toEqual((after.kinds.modules[0].data as unknown[])[1]);
        expect(expand(result, held)).toEqual(after);
    });

    it("answers a reorder, a removal, and a duplicate with bare hashes in the new order", async () => {
        const s = await defaultServer();
        const revision = await s.create("modules", "main", [module("m1"), module("m2"), module("m3")]);
        const before = await fullRead(s, ["modules"]);
        const known = knownOf(before);
        const [h1, h2, h3] = known.items[0].hashes;

        const reordered = await s.put("modules", "main", {
            baseRevision: revision,
            data: [module("m3"), module("m1"), module("m3")],
        });
        expect(reordered.status).toBe(200);
        const after = await fullRead(s, ["modules"]);

        const result = await bootResult(s, { kinds: ["modules"], known });
        const modules = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(modules.items).toStrictEqual([{ hash: h3 }, { hash: h1 }, { hash: h3 }]);
        expect(h2).not.toBe(h3);
        expect(expand(result, itemsOf(before))).toEqual(after);

        // Emptied: `items: []`.
        const emptied = await s.put("modules", "main", { baseRevision: after.kinds.modules[0].revision, data: [] });
        expect(emptied.status).toBe(200);
        const empty = await bootResult(s, { kinds: ["modules"], known });
        expect(expectItemized(empty.kinds.modules[0], "main", "modules").items).toStrictEqual([]);
        expect(expand(empty).kinds.modules[0].data).toEqual([]);
    });

    it("adds up hash lists of one kind, ignores hashes of other kinds, and needs no revision claim", async () => {
        const s = await defaultServer();
        const revision = await s.create("modules", "main", [module("m1"), module("m2")]);
        const before = await fullRead(s, ["modules", "presets"]);
        const [h1, h2] = knownOf(before).items.find((e) => e.kind === "modules")!.hashes;
        const presetHashes = knownOf(before).items.find((e) => e.kind === "presets")!.hashes;
        await s.put("modules", "main", { baseRevision: revision, data: [module("m2"), module("m1")] });

        const result = await bootResult(s, {
            kinds: ["modules", "presets"],
            known: {
                items: [
                    { kind: "modules", hashes: [h1] },
                    { kind: "modules", hashes: [h2] },
                    // A preset hash under the modules kind does not stand for a module.
                    { kind: "modules", hashes: presetHashes },
                    // Module hashes under presets do not stand for presets.
                    { kind: "presets", hashes: [h1, h2] },
                ],
            },
        });
        const modules = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(modules.items).toStrictEqual([{ hash: h2 }, { hash: h1 }]);
        const presets = expectItemized(result.kinds.presets[0], "main", "presets");
        expect(sentPositions(presets)).toEqual(presets.items.map((_, index) => index));
        expect(presets.items.map((item) => item.hash)).toEqual(presetHashes);
    });

    it("hashes the wire-canonical item text, with falsy items and odd keys present as data", async () => {
        // Identity normalizers: the route contract is the subject, not the default kinds' shape rules.
        const modules: ResourceKind = { name: "modules", schemaVersion: 1, singleton: true, normalize: (i) => i };
        const docs: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (i) => i };
        const s = await createResourceTestClient({ resourceKinds: [modules, docs], epochKind: "docs" });
        servers.push(s);
        const items = [
            null,
            0,
            "",
            false,
            { ["__proto__"]: 1, z: "\ud800", a: [1e21, -1, 1.5], 10: "int key", 2: "first" },
            "한국어",
        ];
        const revision = await s.create("modules", "main", items);
        const read = await fullRead(s, ["modules"]);
        expect(read.kinds.modules[0].data).toEqual(items);
        const result = await bootResult(s, { kinds: ["modules"] });
        const record = expectItemized(result.kinds.modules[0], "main", "modules");
        expect(record.revision).toBe(revision);
        expect(record.items).toHaveLength(items.length);
        for (const [index, item] of record.items.entries()) {
            expect(Object.hasOwn(item, "data"), `item ${index}`).toBe(true);
            expect(item.data, `item ${index}`).toEqual(items[index]);
            expect(JSON.stringify(item.data), `item ${index}`).toBe(JSON.stringify(items[index]));
            expect(item.hash, `item ${index}`).toBe(hashOf(item.data));
        }
        // Naming every hash from the received items leaves every item bare, including the falsy ones.
        const bare = await bootResult(s, {
            kinds: ["modules"],
            known: { items: [{ kind: "modules", hashes: record.items.map((item) => item.hash) }] },
        });
        const bareRecord = expectItemized(bare.kinds.modules[0], "main", "modules");
        expect(sentPositions(bareRecord)).toEqual([]);
        expect(expand(bare, itemsOf(read))).toEqual(read);
    });

    it("answers an item kind whose data is not an array whole, and a projected item kind whole and projected", async () => {
        const modules: ResourceKind = { name: "modules", schemaVersion: 1, singleton: true, normalize: (i) => i };
        const presets: ResourceKind = {
            name: "presets",
            schemaVersion: 1,
            singleton: true,
            normalize: (i) => i,
            project: (data) => ({ ...(data as Record<string, unknown>), secret: "masked" }),
        };
        const docs: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (i) => i };
        const s = await createResourceTestClient({ resourceKinds: [modules, presets, docs], epochKind: "docs" });
        servers.push(s);
        const moduleRevision = await s.create("modules", "main", { not: "an array" });
        const presetRevision = await s.create("presets", "main", { secret: "plain", list: [1, 2] });
        const read = await fullRead(s, ["modules", "presets"]);
        expect(read.kinds.presets[0].data).toEqual({ secret: "masked", list: [1, 2] });

        const result = await bootResult(s, {
            kinds: ["modules", "presets"],
            known: {
                records: [
                    { kind: "modules", id: "main", revision: "not-the-revision" },
                    { kind: "presets", id: "main", revision: presetRevision },
                ],
                items: [{ kind: "presets", hashes: [hashOf(1), hashOf(2)] }],
            },
        });
        const moduleRecord = expectWhole(result.kinds.modules[0], "main", "modules");
        expect(moduleRecord).toEqual({ id: "main", revision: moduleRevision, data: { not: "an array" } });
        // A kind with `project` is never cached or itemized, even at a known revision.
        const presetRecord = expectWhole(result.kinds.presets[0], "main", "presets");
        expect(presetRecord).toEqual(read.kinds.presets[0]);

        const cached = await bootResult(s, {
            kinds: ["modules"],
            known: { records: [{ kind: "modules", id: "main", revision: moduleRevision }] },
        });
        expectCached(cached.kinds.modules[0], "main", moduleRevision, "modules");
    });
});

describe("POST /api/resources/boot inventory semantics", () => {
    it("coalesces equal claims, misses on conflicting ones, and ignores entries of unknown or unrequested kinds", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const b = await s.create("characters", "b", character("b"));
        const result = await bootResult(s, {
            kinds: ["characters"],
            known: {
                records: [
                    { kind: "characters", id: "a", revision: a },
                    { kind: "characters", id: "a", revision: a },
                    { kind: "characters", id: "b", revision: b },
                    { kind: "characters", id: "b", revision: "another" },
                    { kind: "characters", id: "gone", revision: a },
                    { kind: "modules", id: "main", revision: "unrequested" },
                    { kind: "nope", id: "x", revision: "unknown kind" },
                    { kind: "__proto__", id: "constructor", revision: "odd names" },
                ],
                items: [
                    { kind: "nope", hashes: ["A".repeat(22)] },
                    { kind: "characters", hashes: ["B".repeat(22)] },
                ],
            },
        });
        expect(Object.keys(result.kinds)).toEqual(["characters"]);
        expectCached(result.kinds.characters[0], "a", a, "characters/a");
        expectWhole(result.kinds.characters[1], "b", "characters/b");
    });

    it("accepts 5000 records and hashes in all, and 400s one more (counted before dropping)", async () => {
        const s = await defaultServer();
        const a = await s.create("characters", "a", character("a"));
        const claim = { kind: "characters", id: "a", revision: a };
        const hash = "a".repeat(22);
        const records = (n: number) => Array.from({ length: n }, () => claim);
        const hashes = (n: number) => Array.from({ length: n }, () => hash);

        const full = await boot(s, {
            kinds: ["characters"],
            known: { records: records(MAX_BOOT_ENTRIES - 1), items: [{ kind: "modules", hashes: hashes(1) }] },
        });
        expect(full.status).toBe(200);
        expectCached(((await full.json()) as ResourceBootResult).kinds.characters[0], "a", a, "characters/a");

        const over = await boot(s, {
            kinds: ["characters"],
            known: { records: records(MAX_BOOT_ENTRIES - 1), items: [{ kind: "modules", hashes: hashes(2) }] },
        });
        expect(over.status).toBe(400);
        expect(((await over.json()) as BootError).error).toContain("5000");

        // Entries of an ignored kind still count.
        const ignored = await boot(s, {
            kinds: ["characters"],
            known: { records: Array.from({ length: MAX_BOOT_ENTRIES + 1 }, () => ({ ...claim, kind: "nope" })) },
        });
        expect(ignored.status).toBe(400);
        const wrappers = await boot(s, {
            kinds: ["characters"],
            known: { items: Array.from({ length: MAX_BOOT_ENTRIES + 1 }, () => ({ kind: "nope", hashes: [] })) },
        });
        expect(wrappers.status).toBe(400);
        const manyKinds = await boot(s, { kinds: Array.from({ length: MAX_BOOT_ENTRIES + 1 }, () => "ui") });
        expect(manyKinds.status).toBe(400);
        const dupKinds = await boot(s, { kinds: Array.from({ length: MAX_BOOT_ENTRIES }, () => "ui") });
        expect(dupKinds.status).toBe(200);
    });

    it.each<[string, unknown]>([
        ["an array body", []],
        ["no kinds", {}],
        ["empty kinds", { kinds: [] }],
        ["a non-string kind", { kinds: [1] }],
        ["an unknown kind", { kinds: ["ui", "nope"] }],
        ["a reserved name as a kind", { kinds: ["boot"] }],
        ["chatSummaries 1", { kinds: ["ui"], chatSummaries: 1 }],
        ["chatSummaries false", { kinds: ["ui"], chatSummaries: false }],
        ["known null", { kinds: ["ui"], known: null }],
        ["known array", { kinds: ["ui"], known: [] }],
        ["records null", { kinds: ["characters"], known: { records: null } }],
        ["items null", { kinds: ["modules"], known: { items: null } }],
        ["records object", { kinds: ["characters"], known: { records: {} } }],
        ["a record without revision", { kinds: ["characters"], known: { records: [{ kind: "characters", id: "a" }] } }],
        [
            "an empty revision",
            { kinds: ["characters"], known: { records: [{ kind: "characters", id: "a", revision: "" }] } },
        ],
        [
            "an overlong revision",
            { kinds: ["characters"], known: { records: [{ kind: "characters", id: "a", revision: "r".repeat(257) }] } },
        ],
        [
            "an invalid id",
            { kinds: ["characters"], known: { records: [{ kind: "characters", id: "", revision: "r" }] } },
        ],
        ["a non-object record", { kinds: ["characters"], known: { records: ["characters"] } }],
        [
            "a record of an ignored kind without an id",
            { kinds: ["ui"], known: { records: [{ kind: "nope", revision: "r" }] } },
        ],
        ["an item entry without hashes", { kinds: ["modules"], known: { items: [{ kind: "modules" }] } }],
        ["hashes as a string", { kinds: ["modules"], known: { items: [{ kind: "modules", hashes: "a".repeat(22) }] } }],
        ["a short hash", { kinds: ["modules"], known: { items: [{ kind: "modules", hashes: ["abc"] }] } }],
        [
            "a base64 (not url) hash",
            { kinds: ["modules"], known: { items: [{ kind: "modules", hashes: ["a".repeat(21) + "+"] }] } },
        ],
        ["a non-string hash", { kinds: ["modules"], known: { items: [{ kind: "modules", hashes: [1] }] } }],
        ["a bad hash of an ignored kind", { kinds: ["ui"], known: { items: [{ kind: "nope", hashes: ["x"] }] } }],
    ])("400s a malformed body: %s", async (_label, body) => {
        const s = await defaultServer();
        const res = await boot(s, body, { "accept-encoding": "zstd" });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(typeof ((await res.json()) as BootError).error).toBe("string");
    });

    it("400s invalid JSON and a non-JSON content type's empty object", async () => {
        const s = await defaultServer();
        const invalid = await s.request(RESOURCE_BOOT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: "Invalid JSON body" });
        const text = await s.request(RESOURCE_BOOT_PATH, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({ kinds: ["ui"] }),
        });
        expect(text.status).toBe(400);
    });

    it("reserves `boot` as a kind name", () => {
        expect(() => createKindRegistry([{ name: "boot", schemaVersion: 1, normalize: (i) => i }])).toThrow(
            "Invalid resource kind name: boot",
        );
    });
});

describe("POST /api/resources/boot body cap and authentication", () => {
    /** A valid boot body of exactly `bytes` UTF-8 bytes (ASCII padding). */
    const bodyOf = (bytes: number) => {
        const frame = JSON.stringify({ kinds: ["ui"], pad: "" });
        return JSON.stringify({ kinds: ["ui"], pad: "x".repeat(bytes - frame.length) });
    };
    const post = (s: ResourceTestClient, body: string, headers: Record<string, string> = {}) =>
        s.request(RESOURCE_BOOT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body,
        });

    it("accepts a body at the cap and 413s one byte more, declared or streamed", async () => {
        const s = await defaultServer();
        const atCap = bodyOf(MAX_BOOT_BODY_BYTES);
        expect(Buffer.byteLength(atCap, "utf8")).toBe(MAX_BOOT_BODY_BYTES);
        const over = bodyOf(MAX_BOOT_BODY_BYTES + 1);

        // No declared length (a streamed body): the route's limiter counts the bytes.
        expect((await post(s, atCap)).status).toBe(200);
        const streamed = await post(s, over);
        expect(streamed.status).toBe(413);
        expect(await streamed.json()).toEqual({ error: "Request body too large" });

        // A declared length: the limiter trusts it, so the route measures what it read.
        expect((await post(s, atCap, { "content-length": "1" })).status).toBe(200);
        const declared = await post(s, over, { "content-length": "1" });
        expect(declared.status).toBe(413);
        expect(await declared.json()).toEqual({ error: "Request body too large" });
        expect((await post(s, over, { "content-length": String(over.length) })).status).toBe(413);
    });

    it("measures UTF-8 bytes, not UTF-16 units", async () => {
        const s = await defaultServer();
        const frame = JSON.stringify({ kinds: ["ui"], pad: "" });
        const units = Math.ceil((MAX_BOOT_BODY_BYTES - frame.length) / 3) + 1;
        const body = JSON.stringify({ kinds: ["ui"], pad: "한".repeat(units) });
        expect(body.length).toBeLessThan(MAX_BOOT_BODY_BYTES);
        expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_BOOT_BODY_BYTES);
        expect((await post(s, body, { "content-length": "1" })).status).toBe(413);
        expect((await post(s, body)).status).toBe(413);
    });

    it("denies an unauthenticated request before reading its body", async () => {
        const s = await defaultServer();
        const small = await s.app.request(RESOURCE_BOOT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kinds: ["ui"] }),
        });
        expect(small.status).not.toBe(200);
        expect(small.status).not.toBe(413);
        const oversized = await s.app.request(RESOURCE_BOOT_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bodyOf(MAX_BOOT_BODY_BYTES + 1),
        });
        expect(oversized.status).toBe(small.status);
        expect(await oversized.json()).toEqual(await small.json());
    });

    it("skips the app's own body limit only on the path the route serves", async () => {
        const s = await defaultServer();
        const declared = { "content-length": String(200 * 1024 * 1024) };
        // The route (one trailing slash is the same path): its own cap answers.
        expect((await post(s, bodyOf(64), declared)).status).toBe(413);
        expect((await post(s, bodyOf(64))).status).toBe(200);
        const slash = await s.request(`${RESOURCE_BOOT_PATH}/`, {
            method: "POST",
            headers: { "content-type": "application/json", ...declared },
            body: bodyOf(64),
        });
        expect(slash.status).toBe(413);
        expect((await s.json(`${RESOURCE_BOOT_PATH}/`, { kinds: ["ui"] })).status).toBe(200);
        // Not the route: the app's limit still applies.
        const double = await s.request(`${RESOURCE_BOOT_PATH}//`, {
            method: "POST",
            headers: { "content-type": "application/json", ...declared },
            body: bodyOf(64),
        });
        expect(double.status).toBe(413);
        const sibling = await s.request(`${RESOURCE_BOOT_PATH}/x`, {
            method: "POST",
            headers: { "content-type": "application/json", ...declared },
            body: bodyOf(64),
        });
        expect(sibling.status).toBe(413);
    });
});

describe("POST /api/resources/boot compression", () => {
    it("compresses a large answer per Accept-Encoding to the same JSON", async () => {
        const s = await defaultServer();
        await s.create("modules", "main", [module("big", { description: "x".repeat(COMPRESS_MIN_BYTES) })]);
        const plain = await boot(s, { kinds: ["modules"] });
        expect(plain.status).toBe(200);
        expect(plain.headers.get("content-encoding")).toBeNull();
        expect(plain.headers.get("vary")).toContain("Accept-Encoding");
        expect(plain.headers.get("cache-control")).toBe("no-store");
        const expected = await plain.json();

        for (const [header, encoding] of [
            ["gzip, deflate, br, zstd", "zstd"],
            ["gzip, deflate, br", "gzip"],
        ] as const) {
            const res = await boot(s, { kinds: ["modules"] }, { "accept-encoding": header });
            expect(res.status, header).toBe(200);
            expect(res.headers.get("content-encoding"), header).toBe(encoding);
            expect(res.headers.get("content-type"), header).toBe("application/json");
            expect(res.headers.get("cache-control"), header).toBe("no-store");
            const bytes = Buffer.from(await res.arrayBuffer());
            expect(Number(res.headers.get("content-length")), header).toBe(bytes.byteLength);
            expect(bytes.byteLength, header).toBeLessThan(COMPRESS_MIN_BYTES / 4);
            const text = encoding === "zstd" ? zlib.zstdDecompressSync(bytes) : zlib.gunzipSync(bytes);
            expect(JSON.parse(text.toString("utf8")), header).toEqual(expected);
        }

        // A cached answer is small and goes out as it is.
        const read = await fullRead(s, ["modules"]);
        const cached = await boot(s, { kinds: ["modules"], known: knownOf(read) }, { "accept-encoding": "zstd" });
        expect(cached.status).toBe(200);
        expect(cached.headers.get("content-encoding")).toBeNull();
        expectCached(
            ((await cached.json()) as ResourceBootResult).kinds.modules[0],
            "main",
            read.kinds.modules[0].revision,
            "modules",
        );
    });
});

describe("ResourceBootRecord", () => {
    it("has mutually exclusive variants", () => {
        const whole: ResourceBootRecord = { id: "main", revision: "r", data: [] };
        const cached: ResourceBootRecord = { id: "main", revision: "r", cached: true };
        const items: ResourceBootRecord = {
            id: "main",
            revision: "r",
            items: [{ hash: "h" }, { hash: "h", data: null }],
        };
        // @ts-expect-error a record is not both cached and whole
        const cachedAndWhole: ResourceBootRecord = { id: "main", revision: "r", cached: true, data: [] };
        // @ts-expect-error a record is not both itemized and whole
        const itemsAndWhole: ResourceBootRecord = { id: "main", revision: "r", items: [], data: [] };
        // @ts-expect-error a record is not both cached and itemized
        const cachedAndItems: ResourceBootRecord = { id: "main", revision: "r", cached: true, items: [] };
        expect([whole, cached, items, cachedAndWhole, itemsAndWhole, cachedAndItems]).toHaveLength(6);
    });
});
