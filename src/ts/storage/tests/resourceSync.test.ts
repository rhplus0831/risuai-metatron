import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResourceServer } from "./fakeResourceServer";

// The save adapter (`resourceSync.svelte.ts`) against an in-memory stand-in for the resource routes.
// Each test boots a fresh module graph (the adapter keeps its transport state at module level) and
// exercises the real Svelte 5 runes: the watchers, `$state.snapshot`, and `DBState.db` as a proxy.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));

vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));

vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
}));

// `stores.svelte.ts` wires module updates into a module-level effect, and `database.svelte.ts`
// (reached through `process/scripts`) re-exports asset helpers; nothing under test needs them.
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Stores = typeof import("../../stores.svelte");

/** A character record as the server stores it: its own fields, no chats (they are resources of their own). */
function character(chaId: string, name: string, extra: Record<string, unknown> = {}) {
    return { chaId, name, type: "character", ...extra };
}

/**
 * Boots the adapter the way `loadData` does: read, seed, assemble, normalize (`normalize` stands in
 * for `setDatabase`), start, and let the boot compare pass run. `bootBatches` is what that pass sent.
 */
async function boot(options: { prepare?: (server: FakeResourceServer) => void; normalize?: (db: any) => void } = {}) {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("root", "main", { username: "u", formatversion: 5, language: "en" });
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice"));
    fake.set("characters", "b", character("b", "Bob"));
    options.prepare?.(fake);
    server.current = fake;

    const stores: Stores = await import("../../stores.svelte");
    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");

    const snapshot = await client.readKinds(["root", "presets", "modules", "plugins", "pluginStorage", "characters"]);
    sync.seedResources(snapshot);
    const single = (kind: string) => snapshot.kinds[kind]?.[0]?.data as any;
    stores.DBState.db = {
        ...single("root"),
        botPresets: single("presets"),
        modules: single("modules"),
        plugins: single("plugins"),
        pluginCustomStorage: single("pluginStorage"),
        characters: snapshot.kinds.characters.map((record) => record.data),
    } as any;
    stores.selectedCharID.set(-1);
    options.normalize?.(stores.DBState.db);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies();
    fake.requests.length = 0;
    return { fake, stores, client, sync, bootBatches, db: () => stores.DBState.db as any };
}

let generating: string | null = null;

beforeEach(() => {
    generating = null;
    // The adapter's debounce and backoff timers; cleared after each test so an earlier test's
    // adapter instance never wakes up against a later test's fake server.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("seeding and no echo", () => {
    it("writes nothing after boot when the mirror equals the server", async () => {
        const { fake, sync, bootBatches } = await boot();
        expect(bootBatches).toEqual([]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("saves the load-time normalization once (the first compare pass) and then stays quiet", async () => {
        const { fake, sync, bootBatches } = await boot({
            normalize: (db) => {
                // What `setDatabase` adds after seeding.
                db.newDefault = true;
                db.characters[1].bias = [];
            },
        });
        expect(fake.data("root", "main").newDefault).toBe(true);
        expect(fake.data("characters", "b").bias).toEqual([]);
        expect(fake.data("characters", "a").bias).toBeUndefined();
        expect(bootBatches).toHaveLength(1);
        expect(bootBatches[0].ops.map((op) => `${op.kind}/${op.id}`).sort()).toEqual(["characters/b", "root/main"]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("neither tracks nor saves the mirror's chats, selection, and render key with the character record", async () => {
        const { fake, sync, db, stores } = await boot();
        stores.selectedCharID.set(0);
        await tick();
        db().characters[0].chats = [{ id: "a-chat", message: [{ role: "user", data: "hi", chatId: "m1" }] }];
        db().characters[0].chatPage = 0;
        db().characters[0].reloadKeys = { 0: 1 };
        await sync.flushResources();
        // Chats are saved by the chat module; the selection and the render key are client-only.
        expect(fake.batchCount()).toBe(0);
        db().characters[0].chats[0].message[0].data = "edited outside the chat module";
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        db().characters[0].name = "Alice 2";
        await sync.flushResources();
        const saved = fake.data("characters", "a");
        expect(saved.name).toBe("Alice 2");
        expect(saved).not.toHaveProperty("chats");
        expect(saved).not.toHaveProperty("chatPage");
        expect(saved).not.toHaveProperty("reloadKeys");
    });
});

describe("dirty generations", () => {
    it("saves a root edit with the seeded revision and records the new one", async () => {
        const { fake, sync, db } = await boot();
        const before = fake.get("root", "main")!.revision;
        db().username = "edited";
        await sync.flushResources();
        const [batch] = fake.batchBodies();
        expect(batch.ops).toHaveLength(1);
        expect(batch.ops[0]).toMatchObject({ kind: "root", id: "main", baseRevision: before });
        expect(batch.ops[0].data).not.toHaveProperty("characters");
        expect(batch.ops[0].data).not.toHaveProperty("botPresets");
        expect(fake.data("root", "main").username).toBe("edited");
        const afterFirst = fake.get("root", "main")!.revision;
        expect(afterFirst).not.toBe(before);
        db().username = "edited again";
        await sync.flushResources();
        expect(fake.batchBodies()[1].ops[0].baseRevision).toBe(afterFirst);
        expect(fake.data("root", "main").username).toBe("edited again");
    });

    it("watches presets deeply, and only the selected character deeply", async () => {
        const { fake, sync, db, stores } = await boot();
        db().botPresets[0].name = "renamed preset";
        stores.selectedCharID.set(1);
        await tick();
        db().characters[1].name = "Bob 2";
        db().characters[0].name = "Alice unsaved";
        await sync.flushResources();
        expect(fake.data("presets", "main")[0].name).toBe("renamed preset");
        expect(fake.data("characters", "b").name).toBe("Bob 2");
        expect(fake.data("characters", "a").name).toBe("Alice");
        sync.markCharactersDirty(["a"]);
        await sync.flushResources();
        expect(fake.data("characters", "a").name).toBe("Alice unsaved");
    });

    it("keeps an edit made while its batch is in flight dirty and saves it in the next cycle", async () => {
        const { fake, sync, db } = await boot();
        fake.holdNextBatch = true;
        db().username = "first";
        const flushed = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        db().username = "second";
        await tick();
        fake.releaseBatch!();
        await flushed;
        // The flush covered "first"; "second" was made during the request and goes out on its own.
        expect(fake.data("root", "main").username).toBe("first");
        await vi.waitFor(() => expect(fake.data("root", "main").username).toBe("second"), { timeout: 3000 });
        expect(fake.batchCount()).toBe(2);
    });

    it("flush waits for an edit made before the call even when a later edit replaces its generation", async () => {
        const { fake, sync, db } = await boot();
        fake.holdNextBatch = true;
        db().username = "barrier-A";
        void sync.flushResources().catch(() => {});
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        db().username = "barrier-B";
        await tick();
        const flushed = sync.flushResources();
        db().username = "barrier-C";
        await tick();
        fake.releaseBatch!();
        const result = await flushed;
        expect(result.discarded).toEqual([]);
        expect(fake.data("root", "main").username).toBe("barrier-C");
    });
});

describe("membership", () => {
    it("creates a new character and deletes a removed one", async () => {
        const { fake, sync, db } = await boot();
        db().characters.push(character("c", "Carol"));
        db().characters.splice(0, 1);
        await sync.flushResources();
        expect(fake.get("characters", "c")).not.toBeNull();
        expect(fake.get("characters", "a")).toBeNull();
        const [batch] = fake.batchBodies();
        expect(batch.ops.find((op) => op.id === "c")).toMatchObject({ baseRevision: null });
        expect(batch.ops.find((op) => op.id === "a")).toMatchObject({ delete: true });
    });

    it("saves a character added while a batch is in flight without another edit", async () => {
        const { fake, sync, db } = await boot();
        fake.holdNextBatch = true;
        db().username = "in flight";
        void sync.flushResources().catch(() => {});
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        db().characters.push(character("late", "Late"));
        await tick();
        fake.releaseBatch!();
        await vi.waitFor(() => expect(fake.get("characters", "late")).not.toBeNull(), { timeout: 3000 });
    });

    it("renames a duplicate chaId before sending, so no record overwrites another", async () => {
        const { fake, sync, db } = await boot();
        db().characters.push(JSON.parse(JSON.stringify(db().characters[0])));
        await sync.flushResources();
        const ids = db().characters.map((entry: any) => entry.chaId);
        expect(new Set(ids).size).toBe(3);
        expect(ids[0]).toBe("a");
        for (const id of ids) {
            expect(fake.get("characters", id)).not.toBeNull();
        }
    });
});

describe("conflicts", () => {
    it("reloads a record another tab changed, reports the discard, and shows the notice once", async () => {
        const { fake, sync, db, stores } = await boot();
        fake.set("characters", "a", character("a", "Alice from tab B"));
        fake.set("root", "main", { ...fake.data<Record<string, unknown>>("root", "main")!, username: "remote user" });
        stores.selectedCharID.set(0);
        await tick();
        db().characters[0].name = "local edit";
        db().username = "local user";
        const result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["characters/a", "root/main"]);
        expect(db().characters[0].name).toBe("Alice from tab B");
        expect(db().username).toBe("remote user");
        expect(fake.data("characters", "a").name).toBe("Alice from tab B");
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        // The hydrated data is the saved state: nothing is echoed back.
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
    });

    it("does not echo a reloaded root whose keys the other tab wrote in another order", async () => {
        const { fake, sync, db } = await boot();
        const reversed = Object.fromEntries(Object.entries(fake.data("root", "main")).reverse());
        reversed.username = "reordered";
        fake.set("root", "main", reversed);
        db().username = "stale";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["root/main"]);
        expect(db().username).toBe("reordered");
        const rootBatches = fake.batchBodies().filter((batch) => batch.ops.some((op) => op.kind === "root"));
        expect(rootBatches).toHaveLength(1);
        await sync.flushResources();
        expect(fake.batchBodies().filter((batch) => batch.ops.some((op) => op.kind === "root"))).toHaveLength(1);
    });

    it("sends the non-conflicting operations of a rejected batch in the next cycle", async () => {
        const { fake, sync, db } = await boot();
        fake.set("root", "main", { ...fake.data<Record<string, unknown>>("root", "main")!, username: "remote" });
        db().username = "local";
        db().modules.push({ name: "new module" });
        await sync.flushResources();
        expect(fake.data("modules", "main")).toEqual([{ name: "new module" }]);
        expect(db().username).toBe("remote");
    });

    it("treats a 409 after a lost response as committed when the server holds what was sent", async () => {
        const { fake, sync, db } = await boot();
        fake.dropNextBatchResponse = true;
        db().username = "committed but unacknowledged";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.data("root", "main").username).toBe("committed but unacknowledged");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(db().username).toBe("committed but unacknowledged");
        expect(alerts.normal).not.toHaveBeenCalled();
        db().username = "next";
        await sync.flushResources();
        expect(fake.data("root", "main").username).toBe("next");
    });

    it("removes a character deleted elsewhere and moves the selection home", async () => {
        const { fake, sync, db, stores } = await boot();
        fake.delete("characters", "a");
        stores.selectedCharID.set(0);
        await tick();
        db().characters[0].name = "edit on a deleted character";
        await sync.flushResources();
        expect(db().characters.map((entry: any) => entry.chaId)).toEqual(["b"]);
        expect(get(stores.selectedCharID)).toBe(-1);
    });

    it("notifies remote-change listeners for every reloaded record", async () => {
        const { fake, sync, db } = await boot();
        const seen: string[] = [];
        const off = sync.onRemoteRecordApplied((kind, id) => seen.push(`${kind}/${id}`));
        fake.set("characters", "b", character("b", "Bob remote"));
        sync.markCharactersDirty(["b"]);
        db().characters[1].name = "Bob local";
        await sync.flushResources();
        expect(seen).toEqual(["characters/b"]);
        off();
    });
});

describe("generation deferral", () => {
    it("keeps the generating character's local state, refuses to flush it, and reloads it inside the cycle when the generation ends", async () => {
        const { fake, sync, db, stores } = await boot();
        sync.setGeneratingCharacter(() => generating);
        const seen: string[] = [];
        sync.onRemoteRecordApplied((kind, id) => seen.push(`${kind}/${id}`));
        stores.selectedCharID.set(0);
        await tick();
        generating = "a";
        fake.set("characters", "a", character("a", "remote name"));
        db().characters[0].name = "local name";
        db().username = "saved anyway";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(db().characters[0].name).toBe("local name");
        expect(seen).toEqual([]);
        // The batch was atomic, so the root edit was rejected with it; the loop saves it on its own,
        // and later cycles neither write nor delete the deferred character. Every flush is refused
        // while the deferred character still has a pending edit.
        await vi.waitFor(() => expect(fake.data("root", "main").username).toBe("saved anyway"), { timeout: 3000 });
        db().username = "another";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        await vi.waitFor(() => expect(fake.data("root", "main").username).toBe("another"), { timeout: 3000 });
        expect(fake.data("characters", "a").name).toBe("remote name");

        generating = null;
        sync.releaseDeferredCharacters();
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/a"]);
        expect(db().characters[0].name).toBe("remote name");
        expect(seen).toEqual(["characters/a"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
    });

    it("retries a failed deferred reload with the cycle's backoff and keeps the character excluded meanwhile", async () => {
        const { fake, sync, db, stores } = await boot();
        sync.setGeneratingCharacter(() => generating);
        stores.selectedCharID.set(0);
        await tick();
        generating = "a";
        fake.set("characters", "a", character("a", "remote name"));
        db().characters[0].name = "local name";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        generating = null;
        fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(db().characters[0].name).toBe("local name");
        expect(fake.data("characters", "a").name).toBe("remote name");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/a"]);
        expect(db().characters[0].name).toBe("remote name");
    });

    it("defers by the generating character's id, not by the current selection", async () => {
        const { fake, sync, db, stores } = await boot();
        sync.setGeneratingCharacter(() => generating);
        generating = "b";
        stores.selectedCharID.set(0);
        await tick();
        fake.set("characters", "b", character("b", "remote Bob"));
        sync.markCharactersDirty(["b"]);
        db().characters[1].name = "local Bob";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        expect(db().characters[1].name).toBe("local Bob");
    });
});

describe("restore (412) and errors", () => {
    it("halts, alerts, and reloads on a 412 from a batch", async () => {
        const { fake, sync, db } = await boot();
        fake.restore("epoch-2");
        db().username = "after restore";
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.normalWait).toHaveBeenCalledWith("restored");
        await vi.waitFor(() => expect((location as any).reload).toHaveBeenCalled());
        expect(fake.data("root", "main").username).toBe("u");
        await expect(sync.flushResources()).rejects.toThrow(/restored/);
    });

    it("halts when a conflict read answers with another epoch", async () => {
        const { fake, sync, db } = await boot();
        fake.set("root", "main", { ...fake.data<Record<string, unknown>>("root", "main")!, username: "remote" });
        fake.readEpoch = "epoch-from-a-restore";
        db().username = "local";
        await expect(sync.flushResources()).rejects.toThrow();
        expect(alerts.normalWait).toHaveBeenCalledWith("restored");
        expect(db().username).toBe("local");
    });

    it("halts when any other resource request hits a 412 (the transport listener)", async () => {
        const { fake, sync, client, db } = await boot();
        fake.restore("epoch-3");
        await expect(
            client.putResource("inlays", "x", { name: "x", ext: "json", type: "signature" }, null),
        ).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(alerts.normalWait).toHaveBeenCalledWith("restored");
        db().username = "never saved";
        await expect(sync.flushResources()).rejects.toThrow(/restored/);
        expect(fake.batchCount()).toBe(0);
    });

    it("reports a 413 once as permanent and does not retry on its own until the next change", async () => {
        const { fake, sync, db } = await boot();
        fake.maxBodyBytes = 200;
        db().username = "x".repeat(300);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 413 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1200);
        expect(fake.batchCount()).toBe(1);
        // An explicit flush tries again (the caller asked), still without a second alert.
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 413 });
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(fake.batchCount()).toBe(2);
        fake.maxBodyBytes = Infinity;
        db().username = "small again";
        await sync.flushResources();
        expect(fake.data("root", "main").username).toBe("small again");
    });

    it("keeps everything dirty through a retryable failure and saves once the server answers", async () => {
        const { fake, sync, db } = await boot();
        fake.failNext = { status: 503, times: 1 };
        db().username = "retry me";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 503 });
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(fake.data("root", "main").username).toBe("retry me");
    });
});

describe("batch sizing", () => {
    it("measures UTF-8 bytes", async () => {
        const { sync } = await boot();
        expect(sync.utf8ByteLength("abc")).toBe(3);
        expect(sync.utf8ByteLength("é")).toBe(2);
        expect(sync.utf8ByteLength("가")).toBe(3);
        expect(sync.utf8ByteLength("😀")).toBe(4);
        const mixed = JSON.stringify({ text: "가나다 abc 😀 é" });
        expect(sync.utf8ByteLength(mixed)).toBe(new TextEncoder().encode(mixed).byteLength);
    });

    it("packs by byte size, so two records of 60 MiB each never share a batch", async () => {
        const { sync } = await boot();
        const big = { bytes: 62_914_657 };
        expect(sync.splitBatches([big, big]).map((batch) => batch.length)).toEqual([1, 1]);
        const small = { bytes: 10 };
        expect(sync.splitBatches([small, big, big, small])).toEqual([
            [small, big],
            [big, small],
        ]);
    });

    it("packs at most 5,000 operations per batch", async () => {
        const { sync } = await boot();
        const ops = Array.from({ length: 5001 }, () => ({ bytes: 1 }));
        expect(sync.splitBatches(ops).map((batch) => batch.length)).toEqual([5000, 1]);
    });

    it("sends the character records as UTF-8 within the cap", async () => {
        const { fake, sync, db } = await boot();
        // Each character is about 3 bytes per Hangul character; both fit only when measured correctly.
        db().characters[0].desc = "가".repeat(1000);
        db().characters[1].desc = "가".repeat(1000);
        sync.markCharactersDirty("all");
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
        expect(fake.data("characters", "a").desc).toHaveLength(1000);
    });
});

describe("plugin storage keys", () => {
    it("saves an own `__proto__` key of the plugin storage", async () => {
        const { fake, sync, db } = await boot();
        db().pluginCustomStorage._safeLocalPluginStorage = { ordinary: 1, ["__proto__"]: { probe: "value" } };
        await sync.flushResources();
        const saved = fake.data("pluginStorage", "main")._safeLocalPluginStorage;
        expect(Object.hasOwn(saved, "__proto__")).toBe(true);
        expect(saved.__proto__).toEqual({ probe: "value" });
        expect(saved.ordinary).toBe(1);
    });
});
