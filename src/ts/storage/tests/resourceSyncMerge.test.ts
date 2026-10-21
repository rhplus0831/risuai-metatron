import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../../shared/characters.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";

// A conflicting character or `statics` record whose server copy changed only in ways this client
// can take (`benignChanges`, `mergeConcurrentChange` in `resourceSync.svelte.ts`) is merged into
// the mirror and written again on the server's revision, with no discard and no reload notice. Any
// other remote change conflicts as before. The save adapter runs for real (fresh module graph per
// test, Svelte runes) against the in-memory fake. The `lastInteraction` rule (a send job stamps it
// on the server with the server's clock): the server's finite stamp is taken whenever this client
// left the field as saved, even an earlier one; the later of two only when both sides moved it.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
}));
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
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");

/** A character as the server stores it: the shared defaults filled in. */
function character(chaId: string, name: string, extra: Record<string, unknown> = {}) {
    return normalizeCharacter({ chaId, name, type: "character", ...extra });
}

function group(chaId: string, extra: Record<string, unknown> = {}) {
    return normalizeCharacter({
        chaId,
        name: "Group",
        type: "group",
        characters: ["a", "b"],
        characterActive: [true, true],
        characterTalks: [0.5, 0.5],
        ...extra,
    });
}

/**
 * Boots the adapter as `loadData` does (see `resourceSync.test.ts`): characters `a` (stamp 100)
 * and `b`, a group `g`, and `statics` `{ messages: 4, imports: 0 }`. Character `a` is selected.
 */
async function boot(options: { prepare?: (server: FakeResourceServer) => void } = {}) {
    vi.resetModules();
    const fake = new FakeResourceServer();
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice", { lastInteraction: 100, desc: "base" }));
    fake.set("characters", "b", character("b", "Bob", { lastInteraction: 100 }));
    fake.set("characters", "g", group("g", { lastInteraction: 100 }));
    await materialize(fake);
    fake.set("statics", "main", { messages: 4, imports: 0 });
    options.prepare?.(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");
    const { characterList }: CharacterStore = await import("../characterStore.svelte");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacterAt(0);
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    /** The character wrappers, with the chat module's compatibility view (`chats`, `chatPage`). */
    const characters = () => characterList() as any[];
    const mirror = (id: string) => characters().find((entry: any) => entry.chaId === id);
    /** A write "another tab" makes on the server's current copy of a record. */
    const remote = (kind: string, id: string, change: (data: any) => void) => {
        const data = JSON.parse(JSON.stringify(fake.data(kind, id)));
        change(data);
        fake.set(kind, id, data);
    };
    const changed: string[] = [];
    sync.onRemoteRecordApplied((kind, id) => changed.push(`${kind}/${id}`));
    return { fake, sync, settings, characters, mirror, remote, changed };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    // The chat-change notices (started by `startResourceSync`) stay closed in these tests.
    vi.stubGlobal("BroadcastChannel", undefined);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("a character another tab only opened or sent to", () => {
    it("keeps the local edit and the later stamp: no discard, no notice, no listener, one merged write, no echo", async () => {
        const { fake, sync, mirror, remote, changed } = await boot();
        remote("characters", "a", (data) => (data.lastInteraction = 200));
        mirror("a").desc = "local edit";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ desc: "local edit", lastInteraction: 200 });
        expect(mirror("a")).toMatchObject({ desc: "local edit", lastInteraction: 200 });
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(changed).toEqual([]);
        // The rejected batch and the merged write.
        expect(fake.batchCount()).toBe(2);
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(2);
    });

    it("takes the server's stamp, even an earlier one, when this client left the field as saved; keeps the later of two when both moved it; takes the server's when the local copy has none", async () => {
        const { fake, sync, mirror, remote, changed } = await boot();
        // Both sides moved the stamp (the local copy from 100 to 300): the later one stays.
        remote("characters", "a", (data) => (data.lastInteraction = 90));
        mirror("a").lastInteraction = 300;
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a").lastInteraction).toBe(300);

        // The server stamps with its own clock. A tab that only edited `desc` (its stamp is still the
        // saved 300) takes the server's 50 even though it is earlier (the server corrected a future
        // stamp an older client clock wrote): the unrelated edit survives, the corrected stamp is what
        // the merged write persists, and the dirty tab does not restore the old value.
        remote("characters", "a", (data) => (data.lastInteraction = 50));
        mirror("a").desc = "local 2";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ lastInteraction: 50, desc: "local 2" });
        expect(mirror("a")).toMatchObject({ lastInteraction: 50, desc: "local 2" });
        expect(sync.heldRecordRevision("characters", "a")).toBe(fake.get("characters", "a")!.revision);
        // Idle afterwards: the merged write was the last one, no echo of the server's stamp.
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.data("characters", "a")).toMatchObject({ lastInteraction: 50, desc: "local 2" });
        // The stamp alone is never announced to the listeners.
        expect(changed).toEqual([]);

        remote("characters", "b", (data) => (data.lastInteraction = 400));
        delete mirror("b").lastInteraction;
        mirror("b").name = "Bob local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "b")).toMatchObject({ lastInteraction: 400, name: "Bob local" });
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("keeps a later local stamp over an earlier server stamp only when this client changed the stamp itself", async () => {
        const { fake, sync, mirror, remote } = await boot();
        // Saved 100, local 300 (changed here), server 50: the later of the two.
        remote("characters", "a", (data) => (data.lastInteraction = 50));
        mirror("a").lastInteraction = 300;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a").lastInteraction).toBe(300);
        // Saved 300, local 300 (unchanged), server 200: the server's.
        remote("characters", "a", (data) => (data.lastInteraction = 200));
        mirror("a").desc = "edited";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ lastInteraction: 200, desc: "edited" });
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("conflicts as before for a stamp that is not a finite number", async () => {
        const { fake, sync, mirror, remote } = await boot();
        remote("characters", "a", (data) => (data.lastInteraction = "yesterday"));
        mirror("a").lastInteraction = 300;
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
        expect(mirror("a")).toMatchObject({ lastInteraction: "yesterday", desc: "base" });
        expect(fake.data("characters", "a").desc).toBe("base");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
    });

    it("works for a character that is not selected (saved by its own write) and for a group", async () => {
        const { fake, sync, mirror, remote } = await boot();
        remote("characters", "b", (data) => (data.lastInteraction = 200));
        mirror("b").name = "Bob local";
        remote("characters", "g", (data) => (data.lastInteraction = 200));
        mirror("g").characterActive[1] = false;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "b")).toMatchObject({ name: "Bob local", lastInteraction: 200 });
        expect(fake.data("characters", "g")).toMatchObject({
            characters: ["a", "b"],
            characterActive: [true, false],
            lastInteraction: 200,
        });
    });
});

describe("which remote changes are merged", () => {
    it("takes a field neither the base nor the local copy has (the screen's `supaMemory: false`, any other while idle) and tells the listeners", async () => {
        const { fake, sync, mirror, remote, changed } = await boot();
        remote("characters", "a", (data) => {
            data.lastInteraction = 200;
            data.supaMemory = false;
            data.defaultVariables = "x=1";
        });
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(mirror("a")).toMatchObject({ supaMemory: false, defaultVariables: "x=1", desc: "local" });
        expect(fake.data("characters", "a")).toMatchObject({
            supaMemory: false,
            defaultVariables: "x=1",
            desc: "local",
            lastInteraction: 200,
        });
        expect(changed).toEqual(["characters/a"]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("takes a remote null for an absent field (null is a value) while idle", async () => {
        const { fake, sync, mirror, remote } = await boot();
        remote("characters", "a", (data) => (data.extra = null));
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(Object.hasOwn(mirror("a"), "extra")).toBe(true);
        expect(mirror("a").extra).toBeNull();
        expect(fake.data("characters", "a")).toMatchObject({ extra: null, desc: "local" });
    });

    it("takes a field both copies changed to the same value, and a nested value the server only re-ordered", async () => {
        const { fake, sync, mirror, remote } = await boot({
            prepare: (fake) =>
                fake.set(
                    "characters",
                    "a",
                    character("a", "Alice", {
                        lastInteraction: 100,
                        desc: "base",
                        nested: { x: 1, y: { p: 1, q: 2 } },
                    }),
                ),
        });
        remote("characters", "a", (data) => {
            data.name = "Same";
            data.nested = { y: { q: 2, p: 1 }, x: 1 };
        });
        mirror("a").name = "Same";
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ name: "Same", desc: "local", nested: { x: 1 } });
    });

    it("stores the server's text as the base: an equal merge (a key-order difference only) is not echoed", async () => {
        const { fake, sync, mirror, remote } = await boot();
        // The server's copy differs in key order only plus a later stamp; the local copy's change is
        // an older stamp, so the merged record equals the server's.
        const current = fake.data("characters", "a");
        fake.set("characters", "a", { ...Object.fromEntries(Object.entries(current).reverse()), lastInteraction: 200 });
        mirror("a").lastInteraction = 150;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(mirror("a").lastInteraction).toBe(200);
        // Only the rejected batch: the merged record equals the server's, nothing is written.
        expect(fake.batchCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(1);
    });

    it.each([
        ["a substantive edit of a field this client did not touch", (data: any) => (data.name = "Remote name")],
        ["an ordinary deletion", (data: any) => delete data.desc],
        ["a re-ordered array", (data: any) => (data.tags = ["b", "a"])],
        ["a different edit of the same nested object", (data: any) => (data.nested.x = 9)],
        ["a type change", (data: any) => (data.type = "group")],
    ])("conflicts as before for %s", async (_label, change) => {
        const { fake, sync, mirror, remote, changed } = await boot({
            prepare: (fake) =>
                fake.set(
                    "characters",
                    "a",
                    character("a", "Alice", {
                        lastInteraction: 100,
                        desc: "base",
                        tags: ["a", "b"],
                        nested: { x: 1, y: 1 },
                    }),
                ),
        });
        remote("characters", "a", (data) => {
            change(data);
            data.lastInteraction = 200;
        });
        mirror("a").nested.y = 2;
        mirror("a").lastInteraction = 150;
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/a"]);
        expect(JSON.parse(JSON.stringify(mirror("a")))).toMatchObject(
            Object.fromEntries(Object.entries(fake.data("characters", "a")).filter(([key]) => key !== "chats")),
        );
        expect(fake.data("characters", "a").nested.y).toBe(1);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(changed).toEqual(["characters/a"]);
    });

    it("conflicts for a remote deletion of a null field (null is not absence)", async () => {
        const { sync, mirror, remote } = await boot({
            prepare: (fake) =>
                fake.set("characters", "a", character("a", "Alice", { lastInteraction: 100, extra: null })),
        });
        remote("characters", "a", (data) => delete data.extra);
        mirror("a").name = "local";
        expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
        expect(Object.hasOwn(mirror("a"), "extra")).toBe(false);
    });

    it("a membership change against a local activity edit follows normal conflict handling", async () => {
        const { fake, sync, mirror, remote } = await boot();
        // Remote removes member a and adds c, with the parallel arrays unchanged in value.
        remote("characters", "g", (data) => (data.characters = ["b", "c"]));
        mirror("g").characterActive[0] = false;
        expect((await sync.flushResources()).discarded).toEqual(["characters/g"]);
        expect(mirror("g")).toMatchObject({ characters: ["b", "c"], characterActive: [true, true] });
        expect(fake.data("characters", "g").characterActive).toEqual([true, true]);
    });

    it("handles own `constructor` and `__proto__` keys without inherited lookups or a partial merge", async () => {
        const withOwn = JSON.parse(
            '{"chaId":"a","name":"Alice","type":"character","lastInteraction":100,"constructor":"ext"}',
        );
        const { fake, sync, mirror, remote } = await boot({
            prepare: (fake) => fake.set("characters", "a", withOwn),
        });
        // An own `constructor` on the mirror does not block a stamp merge, and it is kept.
        remote("characters", "a", (data) => (data.lastInteraction = 150));
        mirror("a").name = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ constructor: "ext", name: "local", lastInteraction: 150 });

        // A remote deletion of the own `constructor` (with a stamp): a deletion, so a conflict. The
        // stamp is not taken on its own before the refusal: the whole record is the server's.
        remote("characters", "a", (data) => {
            delete data.constructor;
            data.lastInteraction = 200;
        });
        mirror("a").name = "local 2";
        expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
        expect(Object.hasOwn(mirror("a"), "constructor")).toBe(false);
        expect(mirror("a")).toMatchObject({ name: "local", lastInteraction: 200 });

        // A remote-only own `__proto__` is refused: a conflict, never a prototype change.
        const current = JSON.stringify(fake.data("characters", "a"));
        fake.set("characters", "a", JSON.parse(`${current.slice(0, -1)},"__proto__":{"polluted":true}}`));
        mirror("a").name = "local 3";
        expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
        expect(({} as any).polluted).toBeUndefined();
        expect(mirror("a").name).toBe("local");
    });

    // A field the mirror object only inherits cannot be assigned in place on the Svelte proxy, so the
    // merge would drop it and the next write would delete it on the server (`assignsInherited`).
    it.each(["toString", "constructor", "valueOf", "hasOwnProperty"])(
        "conflicts for a remote addition of an inherited name (%s): the server keeps it, the local edit is discarded with the notice, and later writes keep it",
        async (field) => {
            const { fake, sync, mirror, remote, changed } = await boot();
            remote("characters", "a", (data) => (data[field] = "from tab B"));
            mirror("a").name = "local";
            expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
            expect(alerts.normal).toHaveBeenCalledWith("reloaded");
            expect(changed).toEqual(["characters/a"]);
            expect(fake.data("characters", "a")).toMatchObject({ [field]: "from tab B", name: "Alice" });
            expect(Object.hasOwn(mirror("a"), field)).toBe(true);
            expect(mirror("a")[field]).toBe("from tab B");
            expect(mirror("a").name).toBe("Alice");

            mirror("a").desc = "after";
            expect((await sync.flushResources()).discarded).toEqual([]);
            expect(fake.data("characters", "a")).toMatchObject({ [field]: "from tab B", desc: "after" });
        },
    );

    it("conflicts for a remote inherited-name addition to `statics`, and the server keeps it", async () => {
        const { fake, sync, settings, remote } = await boot();
        remote("statics", "main", (data) => {
            data.messages = 6;
            data.toString = 1;
        });
        settings.statics.messages = 5;
        expect((await sync.flushResources()).discarded).toEqual(["statics/main"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(fake.data("statics", "main")).toMatchObject({ messages: 6, toString: 1 });
        expect(Object.hasOwn(settings.statics, "toString")).toBe(true);
        settings.statics.messages = 7;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("statics", "main")).toMatchObject({ messages: 7, toString: 1 });
    });

    it("isolates a throwing remote-change listener: the merge completes and the other listeners run", async () => {
        const { fake, sync, mirror, remote, changed } = await boot();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        sync.onRemoteRecordApplied(() => {
            throw new Error("listener");
        });
        const after: string[] = [];
        sync.onRemoteRecordApplied((kind, id) => after.push(`${kind}/${id}`));
        remote("characters", "a", (data) => (data.supaMemory = false));
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ supaMemory: false, desc: "local" });
        expect(changed).toEqual(["characters/a"]);
        expect(after).toEqual(["characters/a"]);
        expect(errors).toHaveBeenCalled();
    });

    it("does not merge a create: a local new character whose id another tab created conflicts as before", async () => {
        const { fake, sync, mirror } = await boot();
        // The list changes through the character module (a push through the list wrapper is refused).
        const characterStore = await import("../characterStore.svelte");
        characterStore.addCharacter(character("n", "Local new", { lastInteraction: 1 }));
        await tick();
        fake.set("characters", "n", character("n", "Local new", { lastInteraction: 2 }));
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/n"]);
        expect(mirror("n").lastInteraction).toBe(2);
    });
});

describe("a running generation's character (the generation deferral is gone)", () => {
    /**
     * Makes `a` generating as the app does: a server job of this tab streams into a chat of it (the
     * mirror's chats are local, so the chat is placed there directly through the chat module,
     * `installCharacterChats`). Returns the job's end. Nothing holds a generating character back: the
     * merge takes what it takes while idle, and any other change conflicts at once.
     */
    async function generate(mirror: (id: string) => any) {
        const chat = await import("../chatStore.svelte");
        chat.installCharacterChats(
            "a",
            [{ id: "ka", name: "K", note: "", localLore: [], message: [{ role: "char", data: "", chatId: "r" }] }],
            mirror("a"),
        );
        chat.applyServerGeneration(
            { chaId: "a", chatId: "ka" },
            { jobId: "J", messageId: "r", generationId: "g1", text: "so far", seq: 0 },
        );
        expect(chat.isCharacterGenerating("a")).toBe(true);
        return () => chat.endServerJob("J");
    }

    it("rebases a stamp-only and an exact `supaMemory: false` change while generating, with no discard", async () => {
        const { fake, sync, mirror, remote } = await boot();
        const end = await generate(mirror);
        remote("characters", "a", (data) => {
            data.lastInteraction = 200;
            data.supaMemory = false;
        });
        mirror("a").lastInteraction = 150;
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ lastInteraction: 200, supaMemory: false, desc: "local" });
        expect(alerts.normal).not.toHaveBeenCalled();
        end();
    });

    it.each([
        ["a new substantive field", { defaultVariables: "x=1" }],
        ["`lowLevelAccess: true`", { lowLevelAccess: true }],
        ["`supaMemory: true`", { supaMemory: true }],
        ['`supaMemory: "false"`', { supaMemory: "false" }],
        ["`supaMemory: null`", { supaMemory: null }],
        ["the safe default mixed with a substantive addition", { supaMemory: false, lowLevelAccess: true }],
    ])(
        "takes %s while generating as while idle (a field neither the base nor the local copy has): merged into the live character, no discard",
        async (_label, added) => {
            const { fake, sync, mirror, remote, changed } = await boot();
            const end = await generate(mirror);
            const live = mirror("a");
            remote("characters", "a", (data) => {
                Object.assign(data, added);
                data.lastInteraction = 200;
            });
            live.desc = "local";
            expect((await sync.flushResources()).discarded).toEqual([]);
            // The merge reaches the object the screen and the send read, and is written once.
            expect(mirror("a")).toBe(live);
            expect(live).toMatchObject({ ...added, lastInteraction: 200, desc: "local" });
            expect(fake.data("characters", "a")).toMatchObject({ ...added, lastInteraction: 200, desc: "local" });
            expect(changed).toEqual(["characters/a"]);
            expect(alerts.normal).not.toHaveBeenCalled();
            const batches = fake.batchCount();
            await vi.advanceTimersByTimeAsync(3000);
            expect(fake.batchCount()).toBe(batches);
            end();
        },
    );

    it("conflicts at once for a substantive change while generating; a later stamp-only change then merges", async () => {
        const { fake, sync, mirror, remote } = await boot();
        const end = await generate(mirror);
        remote("characters", "a", (data) => (data.name = "Remote name"));
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual(["characters/a"]);
        expect(mirror("a")).toMatchObject({ name: "Remote name", lastInteraction: 100, desc: "base" });
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        remote("characters", "a", (data) => (data.lastInteraction = 300));
        mirror("a").lastInteraction = 250;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(mirror("a")).toMatchObject({ name: "Remote name", lastInteraction: 300, desc: "base" });
        expect(fake.data("characters", "a")).toMatchObject({ name: "Remote name", lastInteraction: 300, desc: "base" });
        end();
    });
});

describe("the flush barrier around a merge", () => {
    it("stays pending while the merged write is held, resolves with an empty report once it is acknowledged, and keeps an edit made during the write", async () => {
        const { fake, sync, mirror, remote } = await boot();
        // Another tab stamps the character right before this tab's batch reaches the server.
        fake.beforeNextBatch = () => {
            remote("characters", "a", (data) => (data.lastInteraction = 200));
            fake.holdNextBatch = true;
        };
        mirror("a").desc = "local";
        let settled = false;
        const flushing = sync.flushResources().then((result) => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);
        expect(fake.data("characters", "a").desc).toBe("base");
        mirror("a").personality = "typed during the write";
        fake.releaseBatch!();
        expect(await flushing).toEqual({ discarded: [] });
        expect(fake.data("characters", "a")).toMatchObject({ desc: "local", lastInteraction: 200 });
        // The edit made during the write was not acknowledged by it (the server still holds the default);
        // the next flush saves it.
        expect(fake.data("characters", "a").personality).toBe("");
        await sync.flushResources();
        expect(fake.data("characters", "a").personality).toBe("typed during the write");
    });

    it("keeps an edit made while the conflict read is in flight", async () => {
        const { fake, sync, mirror, remote } = await boot();
        remote("characters", "a", (data) => (data.lastInteraction = 200));
        server.current = {
            fetch: async (path: string, init?: RequestInit) => {
                const response = await fake.fetch(path, init);
                if (path === "/api/resources/read") {
                    mirror("a").personality = "typed during the read";
                }
                return response;
            },
        };
        mirror("a").desc = "local";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({
            desc: "local",
            personality: "typed during the read",
            lastInteraction: 200,
        });
    });

    it("does not acknowledge the merged edit when its write fails: the flush rejects and the edit is saved later", async () => {
        const { fake, sync, mirror, remote } = await boot();
        fake.beforeNextBatch = () => {
            remote("characters", "a", (data) => (data.lastInteraction = 200));
            fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/batch" };
        };
        mirror("a").desc = "local";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(fake.data("characters", "a").desc).toBe("base");
        await vi.advanceTimersByTimeAsync(5000);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("characters", "a")).toMatchObject({ desc: "local", lastInteraction: 200 });
    });

    it("recognizes a lost acknowledgement of the merged write on the retry", async () => {
        const { fake, sync, mirror, remote } = await boot();
        fake.beforeNextBatch = () => {
            remote("characters", "a", (data) => (data.lastInteraction = 200));
            fake.dropNextBatchResponse = false;
            fake.beforeNextBatch = () => {
                fake.dropNextBatchResponse = true;
            };
        };
        mirror("a").desc = "local";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.data("characters", "a").desc).toBe("local");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(mirror("a").desc).toBe("local");
    });

    it("resolves concurrent flush callers once the merged write is saved", async () => {
        const { fake, sync, mirror, remote } = await boot();
        remote("characters", "a", (data) => (data.lastInteraction = 200));
        mirror("a").desc = "local";
        const [first, second] = await Promise.all([sync.flushResources(), sync.flushResources()]);
        expect(first).toEqual({ discarded: [] });
        expect(second).toEqual({ discarded: [] });
        expect(fake.data("characters", "a").desc).toBe("local");
    });

    it("resends the rest of the rejected batch with the merge (a section edit in the same batch)", async () => {
        const { fake, sync, settings, mirror, remote } = await boot();
        remote("characters", "a", (data) => (data.lastInteraction = 200));
        mirror("a").desc = "local";
        settings.ui.theme = "local theme";
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("ui", "main").theme).toBe("local theme");
        expect(fake.data("characters", "a").desc).toBe("local");
    });
});

describe("statics counts (best effort)", () => {
    const counts = (fake: FakeResourceServer) => {
        const { messages, imports } = fake.data("statics", "main");
        return { messages, imports };
    };

    it("adds this client's increments to the server's count, for both counts", async () => {
        const { fake, sync, settings, remote } = await boot();
        remote("statics", "main", (data) => {
            data.messages = 6;
            data.imports = 1;
        });
        settings.statics.messages = 5;
        settings.statics.imports = 2;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(counts(fake)).toEqual({ messages: 7, imports: 3 });
        expect(settings.statics).toMatchObject({ messages: 7, imports: 3 });
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("counts equal values in otherwise different records as independent increments", async () => {
        const { fake, sync, settings, remote } = await boot();
        remote("statics", "main", (data) => {
            data.messages = 5;
            data.imports = 1;
        });
        settings.statics.messages = 5;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(counts(fake)).toEqual({ messages: 6, imports: 1 });
    });

    it("accepts the documented limits: identical records keep one increment, a lost answer followed by another writer counts it twice", async () => {
        const { fake, sync, settings, remote } = await boot();
        // Both tabs raised messages 4 → 5: the server holds what was sent, nothing to merge.
        remote("statics", "main", (data) => (data.messages = 5));
        settings.statics.messages = 5;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(counts(fake).messages).toBe(5);

        // This tab writes 5 → 6 and loses the answer; another tab writes 7; the retry adds again.
        fake.dropNextBatchResponse = true;
        settings.statics.messages = 6;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        remote("statics", "main", (data) => (data.messages = 7));
        await vi.advanceTimersByTimeAsync(5000);
        await sync.flushResources();
        expect(counts(fake).messages).toBe(8);
    });

    it.each([
        ["an absent count as 0", { messages: 4 }, { imports: 2 }, 5, { messages: 5, imports: 2 }],
        [
            "the larger count when the sum is not a safe integer",
            { messages: 4 },
            { messages: Number.MAX_SAFE_INTEGER },
            5,
            { messages: Number.MAX_SAFE_INTEGER },
        ],
        ["the larger count when the sum is negative", { messages: 10 }, { messages: 0 }, 5, { messages: 5 }],
    ])("takes %s", async (_label, base, remoteChange, localMessages, expected) => {
        const { fake, sync, settings, remote } = await boot({ prepare: (fake) => fake.set("statics", "main", base) });
        remote("statics", "main", (data) => Object.assign(data, remoteChange));
        settings.statics.messages = localMessages;
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("statics", "main")).toEqual(expected);
        expect(settings.statics).toMatchObject(expected);
    });

    it("conflicts as before for a count that is not a number", async () => {
        const { sync, settings, remote } = await boot();
        remote("statics", "main", (data) => (data.messages = "many"));
        settings.statics.messages = 5;
        expect((await sync.flushResources()).discarded).toEqual(["statics/main"]);
        expect(settings.statics.messages).toBe("many");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
    });
});

describe("the pluginStorage record every plugin shares", () => {
    type PluginStorageStore = typeof import("../pluginStorageStore.svelte");
    /** The plugin storage module of the booted graph, with a discard listener recording its calls. */
    async function pluginStorage(sync: Sync) {
        const store: PluginStorageStore = await import("../pluginStorageStore.svelte");
        const discards: any[] = [];
        sync.onPluginStorageDiscarded((lost) => discards.push(lost));
        return { store, discards };
    }
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    /** Nothing more is written: the merged write was the last one, no echo of the server's copy. */
    async function idle(fake: FakeResourceServer, sync: Sync) {
        const batches = fake.batchCount();
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(batches);
    }

    it("keeps both tabs' writes of different keys (both creating the namespace): merged, written once on the server's revision, no discard, no notice, no event, no echo", async () => {
        const { fake, sync, settings, remote, changed } = await boot();
        const { store, discards } = await pluginStorage(sync);
        remote("pluginStorage", "main", (data) => (data._pluginStorage = { remote: 1 }));
        store.setPluginStorageItem("local", { v: 2 });
        expect((await sync.flushResources()).discarded).toEqual([]);
        const merged = { _pluginStorage: { remote: 1, local: { v: 2 } } };
        expect(fake.data("pluginStorage", "main")).toEqual(merged);
        expect(plain(settings.pluginStorage)).toEqual(merged);
        expect(store.getPluginStorageValue("remote")).toBe(1);
        expect(sync.heldRecordRevision("pluginStorage", "main")).toBe(fake.get("pluginStorage", "main")!.revision);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(discards).toEqual([]);
        // The key taken from the server is announced (caches derived from the record).
        expect(changed).toEqual(["pluginStorage/main"]);
        // The rejected batch and the merged write.
        expect(fake.batchCount()).toBe(2);
        await idle(fake, sync);
    });

    it("takes a namespace only the other tab added, and merges the other reserved namespace and custom keys the same way", async () => {
        const { fake, sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { custom: 1 }),
        });
        const { store, discards } = await pluginStorage(sync);
        remote("pluginStorage", "main", (data) => {
            data._safeLocalPluginStorage = { theirs: "s" };
            data.other = 2;
        });
        store.setPluginStorageItem("k", 1);
        store.setSafeLocalPluginValue("mine", "m");
        store.setPluginCustomValue("custom", { changed: true });
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({
            custom: { changed: true },
            other: 2,
            _pluginStorage: { k: 1 },
            _safeLocalPluginStorage: { theirs: "s", mine: "m" },
        });
        expect(store.getSafeLocalPluginValue("theirs")).toBe("s");
        expect(discards).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        await idle(fake, sync);
    });

    it("merges removals and a clear per key, and a key both tabs set to the same value", async () => {
        const { fake, sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: { a: 1, b: 2, c: 3 } }),
        });
        const { store, discards } = await pluginStorage(sync);
        // The other tab removes `a`; this tab changes `b`.
        remote("pluginStorage", "main", (data) => delete data._pluginStorage.a);
        store.setPluginStorageItem("b", 20);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { b: 20, c: 3 } });
        expect(store.getPluginStorageValue("a")).toBeNull();

        // This tab removes `c` and sets `same`; the other tab changes `b` and sets `same` to the same value.
        remote("pluginStorage", "main", (data) => {
            data._pluginStorage.b = 200;
            data._pluginStorage.same = { x: 1 };
        });
        store.removePluginStorageItem("c");
        store.setPluginStorageItem("same", { x: 1 });
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { b: 200, same: { x: 1 } } });
        expect(store.getPluginStorageValue("b")).toBe(200);

        // This tab clears the namespace while the other tab adds `d`: the clear removes the saved keys only.
        remote("pluginStorage", "main", (data) => (data._pluginStorage.d = 4));
        store.clearPluginStorage();
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { d: 4 } });
        expect(store.pluginStorageKeys()).toEqual(["d"]);
        expect(discards).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        await idle(fake, sync);
    });

    it("discards the whole unsaved record on a same-key race, with the notice, and tells the listeners every lost key after the record is settled", async () => {
        const { fake, sync, settings, remote, changed } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: { k: 1 }, custom: 1 }),
        });
        const { store, discards } = await pluginStorage(sync);
        const seen: unknown[] = [];
        sync.onPluginStorageDiscarded((lost) => {
            // After the mirror holds the server copy and the base moved to its revision.
            seen.push([
                store.getPluginStorageValue("k"),
                sync.heldRecordRevision("pluginStorage", "main") === fake.get("pluginStorage", "main")!.revision,
                lost.pluginStorage.slice(),
            ]);
        });
        remote("pluginStorage", "main", (data) => (data._pluginStorage.k = 2));
        store.setPluginStorageItem("k", 3);
        store.setPluginStorageItem("other", "lost too");
        store.setSafeLocalPluginValue("s", 1);
        store.setPluginCustomValue("custom", 9);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: { k: 2 }, custom: 1 });
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { k: 2 }, custom: 1 });
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(changed).toEqual(["pluginStorage/main"]);
        expect(discards).toEqual([{ pluginStorage: ["k", "other"], localPluginStorage: ["s"], customStorage: true }]);
        expect(seen).toEqual([[2, true, ["k", "other"]]]);
        // Nothing is echoed back, and the next write starts from the reloaded record.
        await idle(fake, sync);
        store.setPluginStorageItem("k", 4);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { k: 4 }, custom: 1 });
        expect(discards).toHaveLength(1);
    });

    it("conflicts for a custom key both tabs changed (flagged, never named) and for a remote deletion of a key this tab changed", async () => {
        const { fake, sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: { k: 1 }, custom: 1 }),
        });
        const { store, discards } = await pluginStorage(sync);
        remote("pluginStorage", "main", (data) => (data.custom = 2));
        store.setPluginCustomValue("custom", 3);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(fake.data("pluginStorage", "main").custom).toBe(2);
        expect(discards).toEqual([{ pluginStorage: [], localPluginStorage: [], customStorage: true }]);

        remote("pluginStorage", "main", (data) => delete data._pluginStorage.k);
        store.setPluginStorageItem("k", 5);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: {}, custom: 2 });
        expect(store.getPluginStorageValue("k")).toBeNull();
        expect(discards[1]).toEqual({ pluginStorage: ["k"], localPluginStorage: [], customStorage: false });
    });

    it("reads a saved list namespace as its entries when both tabs converted it, and keeps a list the server holds now atomic", async () => {
        const { fake, sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: ["old"] }),
        });
        const { store, discards } = await pluginStorage(sync);
        // Both tabs' first write turned the list into the dictionary of its entries, each adding a key.
        remote("pluginStorage", "main", (data) => (data._pluginStorage = { "0": "old", r: 1 }));
        store.setPluginStorageItem("l", 2);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { "0": "old", r: 1, l: 2 } });
        expect(discards).toEqual([]);

        // The other tab replaced the dictionary with a list (`setDatabase`): a value, so a conflict.
        remote("pluginStorage", "main", (data) => (data._pluginStorage = [9]));
        store.setPluginStorageItem("l", 3);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: [9] });
        expect(store.getPluginStorageValue("0")).toBe(9);
        expect(discards).toEqual([{ pluginStorage: ["l"], localPluginStorage: [], customStorage: false }]);
    });

    it("reports a lost namespace shape (a list turned into an object, an empty namespace created here) under customStorage even when no entry differs", async () => {
        const { fake, sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: [1] }),
        });
        const { store, discards } = await pluginStorage(sync);
        // This tab wrote the dictionary form through `setDatabase`; the other tab wrote another list.
        store.setPluginCustomValue("_pluginStorage", { "0": 1 });
        remote("pluginStorage", "main", (data) => (data._pluginStorage = [2]));
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: [2] });
        expect(discards).toEqual([{ pluginStorage: [], localPluginStorage: [], customStorage: true }]);

        // A `clear` of the never-written local namespace creates it empty; it goes with another key's conflict.
        store.setPluginStorageItem("k", 2);
        store.clearSafeLocalPluginStorage();
        remote("pluginStorage", "main", (data) => (data._pluginStorage = { "0": 2, k: 3 }));
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(fake.data("pluginStorage", "main")).toEqual({ _pluginStorage: { "0": 2, k: 3 } });
        expect(discards[1]).toEqual({ pluginStorage: ["k"], localPluginStorage: [], customStorage: true });
    });

    it("keeps inherited names as own keys at both levels: no prototype change, both tabs' keys on the server", async () => {
        const { fake, sync, settings, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", JSON.parse('{"_pluginStorage":{"k":1}}')),
        });
        const { store, discards } = await pluginStorage(sync);
        fake.set(
            "pluginStorage",
            "main",
            JSON.parse(
                '{"_pluginStorage":{"k":1,"constructor":"ext","__proto__":{"polluted":true}},"__proto__":{"top":true}}',
            ),
        );
        store.setPluginStorageItem("toString", "local");
        store.setPluginStorageItem("mine", 1);
        expect((await sync.flushResources()).discarded).toEqual([]);
        const saved = fake.data("pluginStorage", "main");
        expect(Object.hasOwn(saved, "__proto__")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(saved, "__proto__")!.value).toEqual({ top: true });
        expect(Object.getOwnPropertyDescriptor(saved._pluginStorage, "__proto__")!.value).toEqual({ polluted: true });
        expect(saved._pluginStorage).toMatchObject({ k: 1, constructor: "ext", toString: "local", mine: 1 });
        expect(Object.getPrototypeOf(saved._pluginStorage)).toBe(Object.prototype);
        expect(({} as any).polluted).toBeUndefined();
        expect(({} as any).top).toBeUndefined();
        expect(store.getPluginStorageValue("constructor")).toBe("ext");
        expect(store.getPluginStorageValue("__proto__")).toEqual({ polluted: true });
        expect(JSON.stringify(settings.pluginStorage)).toContain('"__proto__":{"top":true}');
        expect(discards).toEqual([]);

        // This tab now writes the `__proto__` key while the other tab adds another: still a key merge.
        remote("pluginStorage", "main", (data) => (data._pluginStorage.k2 = 2));
        store.setPluginStorageItem("__proto__", "mine");
        expect((await sync.flushResources()).discarded).toEqual([]);
        const next = fake.data("pluginStorage", "main")._pluginStorage;
        expect(Object.getOwnPropertyDescriptor(next, "__proto__")!.value).toBe("mine");
        expect(next.k2).toBe(2);
        expect(remote).toBeDefined();
        await idle(fake, sync);
    });

    it("isolates a throwing discard listener and gives every listener its own copy of the keys", async () => {
        const { sync, remote } = await boot({
            prepare: (fake) => fake.set("pluginStorage", "main", { _pluginStorage: { k: 1 } }),
        });
        const { store, discards } = await pluginStorage(sync);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        sync.onPluginStorageDiscarded(() => {
            throw new Error("listener");
        });
        sync.onPluginStorageDiscarded((lost) => {
            lost.pluginStorage.push("mutated");
            lost.customStorage = true;
        });
        const last: unknown[] = [];
        sync.onPluginStorageDiscarded((lost) => last.push(lost));
        remote("pluginStorage", "main", (data) => (data._pluginStorage.k = 2));
        store.setPluginStorageItem("k", 3);
        expect((await sync.flushResources()).discarded).toEqual(["pluginStorage/main"]);
        expect(errors).toHaveBeenCalled();
        expect(discards).toEqual([{ pluginStorage: ["k"], localPluginStorage: [], customStorage: false }]);
        expect(last).toEqual([{ pluginStorage: ["k"], localPluginStorage: [], customStorage: false }]);
    });
});

// `mergeItemAdds` and `ITEM_LIST_MERGE_KINDS` (persistence.md Save step 5): a conflicting item list
// keeps the items this client added over the server's list (its items and order), appended in this
// client's order, with no discard and no notice; every other local change of the list (an edit,
// removal, or reorder of a saved item, an add under an id the server added with another value, a
// list without valid ids) conflicts as before, and so does a list of a kind outside the set,
// whatever ids its items carry.
describe("item lists: this tab's adds over another tab's list", () => {
    type CollectionStore = typeof import("../collectionStore.svelte");
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    const names = (list: unknown) => (plain(list) as any[]).map((entry) => entry.name);
    const presets = [
        { id: "pa", name: "p1" },
        { id: "pb", name: "p2" },
    ];
    /** Boots with two saved presets `pa` and `pb`, and returns the collection store of the graph. */
    async function bootPresets(prepare?: (fake: FakeResourceServer) => void) {
        const h = await boot({
            prepare: (fake) => {
                fake.set("presets", "main", presets);
                prepare?.(fake);
            },
        });
        const collection: CollectionStore = await import("../collectionStore.svelte");
        return { ...h, collection };
    }
    /** Nothing more is written: the merged write was the last one, no echo of the server's copy. */
    async function idle(fake: FakeResourceServer, sync: Sync) {
        const batches = fake.batchCount();
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(batches);
    }
    const noNotice = () => {
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    };
    /** The conflict replaced the local list with the server's, the discard reported and the notice shown. */
    const discarded = async (h: { fake: FakeResourceServer; sync: Sync; settings: any }, kind: string) => {
        expect((await h.sync.flushResources()).discarded).toEqual([`${kind}/main`]);
        expect(plain(h.settings[kind])).toEqual(h.fake.data(kind, "main"));
        expect(h.sync.heldRecordRevision(kind, "main")).toBe(h.fake.get(kind, "main")!.revision);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        // The rejected batch only: nothing of this tab's was written.
        expect(h.fake.batchCount()).toBe(1);
    };

    it("presets: an added preset over another tab's rename of a saved one: both kept, written once on the server's revision, no discard, no notice, the listener told, no echo", async () => {
        const { fake, sync, settings, remote, changed, collection } = await bootPresets();
        remote("presets", "main", (data) => (data[1].name = "theirs"));
        const id = collection.addPreset({ name: "mine" });
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(names(fake.data("presets", "main"))).toEqual(["p1", "theirs", "mine"]);
        expect(fake.data("presets", "main")[2].id).toBe(id);
        expect(names(settings.presets)).toEqual(["p1", "theirs", "mine"]);
        expect(plain(settings.presets)).toEqual(fake.data("presets", "main"));
        expect(sync.heldRecordRevision("presets", "main")).toBe(fake.get("presets", "main")!.revision);
        noNotice();
        expect(changed).toEqual(["presets/main"]);
        // The rejected batch and the merged write.
        expect(fake.batchCount()).toBe(2);
        await idle(fake, sync);
    });

    it("personas: both tabs add (different ids) and the server removes a saved one this tab left alone: the server's list, then this tab's add; the selection follows by id", async () => {
        const { fake, sync, settings, remote, changed } = await boot({
            prepare: (fake) =>
                fake.set("personas", "main", [
                    { id: "ua", name: "A", icon: "", personaPrompt: "", note: "" },
                    { id: "ub", name: "B", icon: "", personaPrompt: "", note: "" },
                ]),
        });
        const collection: CollectionStore = await import("../collectionStore.svelte");
        const selection = await import("../selection.svelte");
        remote("personas", "main", (data) => {
            data.splice(0, 1);
            data.push({ id: "theirs", name: "Theirs", icon: "", personaPrompt: "", note: "" });
        });
        const id = collection.addPersona({ name: "Mine" });
        selection.selectPersona(id);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(names(fake.data("personas", "main"))).toEqual(["B", "Theirs", "Mine"]);
        expect(names(settings.personas)).toEqual(["B", "Theirs", "Mine"]);
        expect(plain(settings.personas)[2].id).toBe(id);
        expect(selection.selection.personaId).toBe(id);
        expect(sync.heldRecordRevision("personas", "main")).toBe(fake.get("personas", "main")!.revision);
        noNotice();
        expect(changed).toEqual(["personas/main"]);
        expect(fake.batchCount()).toBe(2);
        await idle(fake, sync);
    });

    it("appends several adds in this tab's order, wherever this tab inserted them, after the server's list in the server's order", async () => {
        const { fake, sync, settings, remote } = await bootPresets();
        // The other tab reversed the saved items and renamed one; this tab put `x` first and `y` last.
        remote("presets", "main", (data) => data.reverse() && (data[0].name = "theirs"));
        settings.presets.unshift({ id: "x", name: "X" } as any);
        settings.presets.push({ id: "y", name: "Y" } as any);
        expect(names(settings.presets)).toEqual(["X", "p1", "p2", "Y"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(plain(settings.presets)).toEqual([
            { id: "pb", name: "theirs" },
            { id: "pa", name: "p1" },
            { id: "x", name: "X" },
            { id: "y", name: "Y" },
        ]);
        expect(fake.data("presets", "main")).toEqual(plain(settings.presets));
        noNotice();
        expect(fake.batchCount()).toBe(2);
        await idle(fake, sync);
    });

    it("takes an item both tabs added under one id with equal values once, with nothing written back", async () => {
        const { fake, sync, settings, remote, changed } = await bootPresets();
        remote("presets", "main", (data) => {
            data[0].name = "theirs";
            data.push({ id: "x", name: "X" });
        });
        settings.presets.push({ id: "x", name: "X" } as any);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(plain(settings.presets)).toEqual([
            { id: "pa", name: "theirs" },
            { id: "pb", name: "p2" },
            { id: "x", name: "X" },
        ]);
        expect(fake.data("presets", "main")).toEqual(plain(settings.presets));
        expect(sync.heldRecordRevision("presets", "main")).toBe(fake.get("presets", "main")!.revision);
        noNotice();
        expect(changed).toEqual(["presets/main"]);
        // The merge equals the server's list: the rejected batch was the only write.
        expect(fake.batchCount()).toBe(1);
        await idle(fake, sync);
    });

    it("conflicts for an item both tabs added under one id with different values", async () => {
        const h = await bootPresets();
        h.remote("presets", "main", (data) => data.push({ id: "x", name: "X" }));
        h.settings.presets.push({ id: "x", name: "Other" } as any);
        await discarded(h, "presets");
        expect(names(h.settings.presets)).toEqual(["p1", "p2", "X"]);
    });

    it.each(["edit", "remove", "reorder"])(
        "conflicts for this tab's %s of a saved item (the server changed only another item), losing the add alongside it",
        async (change) => {
            const h = await bootPresets();
            const { settings, remote, collection } = h;
            remote("presets", "main", (data) => (data[1].name = "theirs"));
            if (change === "edit") {
                settings.presets[0].name = "mine";
            } else if (change === "remove") {
                settings.presets.splice(0, 1);
            } else {
                settings.presets = [plain(settings.presets[1]), plain(settings.presets[0])];
            }
            collection.addPreset({ name: "added" });
            await discarded(h, "presets");
            expect(names(settings.presets)).toEqual(["p1", "theirs"]);
        },
    );

    it("keeps a local removal or reorder the server made too, and a server-only edit of a saved item", async () => {
        const { fake, sync, settings, remote, collection } = await bootPresets();
        // Both tabs removed `pa` and the server renamed `pb`; this tab adds one.
        remote("presets", "main", (data) => {
            data.splice(0, 1);
            data[0].name = "theirs";
        });
        settings.presets.splice(0, 1);
        collection.addPreset({ name: "added" });
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(names(settings.presets)).toEqual(["theirs", "added"]);
        expect(fake.data("presets", "main")).toEqual(plain(settings.presets));
        noNotice();
        expect(fake.batchCount()).toBe(2);
        await idle(fake, sync);
    });

    it.each([
        ["missing", { name: "no id" }],
        ["repeated", { id: "pa", name: "dup" }],
    ])("conflicts as before when a local item's id is %s", async (_case, item) => {
        const h = await bootPresets();
        h.remote("presets", "main", (data) => (data[1].name = "theirs"));
        h.settings.presets.push(item as any);
        await discarded(h, "presets");
        expect(names(h.settings.presets)).toEqual(["p1", "theirs"]);
    });

    it("conflicts as before for a kind outside the set (plugins), even for disjoint adds with valid ids", async () => {
        const h = await boot();
        const collection: CollectionStore = await import("../collectionStore.svelte");
        h.remote("plugins", "main", (data) => data.push({ id: "q", name: "theirs" }));
        collection.upsertPlugin({ id: "p", name: "mine" });
        await discarded(h, "plugins");
        expect(names(h.settings.plugins)).toEqual(["theirs"]);
    });
});
