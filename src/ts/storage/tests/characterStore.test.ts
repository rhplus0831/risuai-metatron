import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, m, plain, refK } from "./mutationStoresHarness";

// Phase 4, slice 1 (`docs/plan/phases/slices/phase-4-external-contracts/character-and-collection-mutations.md`):
// the character mutation module (`characterStore.svelte.ts`) and the relocated `checkCharOrder`
// (`characterOrder.ts`) against the real server store: a refusal throws and changes nothing (mirror
// and server compared after the next cycle), a write lands by id and is saved, the chats stay the
// chat module's, and the selection follows a removal.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
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

async function boot() {
    vi.resetModules();
    return bootMutations((fake) => {
        server.current = fake;
    });
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("updateCharacter", () => {
    it("sends a non-selected character's record in the next cycle with only the patched field changed", async () => {
        const { fake, sync, characterStore, record, stores } = await boot();
        expect(get(stores.selectedCharID)).toBe(-1);
        const before = record("characters", "c");
        expect(characterStore.updateCharacter("c", { desc: "patched" })).toBe(true);
        await sync.flushResources();
        expect(record("characters", "c")).toEqual({ ...before, desc: "patched" });
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(1);
        expect(batches[0].ops.map((op: any) => `${op.kind}/${op.id}`)).toEqual(["characters/c"]);
        expect(batches[0].chats ?? []).toEqual([]);
    });

    it("refuses the fixed fields, prototype names, and non-data values, and changes nothing", async () => {
        const { characterStore, refused, validation } = await boot();
        for (const patch of [
            { chats: [] },
            { chatPage: 1 },
            { reloadKeys: [] },
            { chaId: "other" },
            { type: "group" },
            JSON.parse('{"__proto__":{"x":1}}'),
            { desc: () => 1 },
            { desc: Number.NaN },
            { desc: 1n },
            { desc: new Date() },
        ]) {
            await refused(() => characterStore.updateCharacter("c", patch), validation.MutationValidationError);
        }
        await refused(() => characterStore.updateCharacter("c", "no" as any), validation.MutationValidationError);
    });

    it("returns false for a character that does not exist, without sending anything", async () => {
        const { fake, sync, characterStore } = await boot();
        expect(characterStore.updateCharacter("nope", { desc: "x" })).toBe(false);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("removes a field for an undefined value, and detaches the patch", async () => {
        const { sync, characterStore, record, character } = await boot();
        const value = { nested: ["x"] };
        characterStore.updateCharacter("c", { desc: "d", extra: value });
        value.nested.push("y");
        expect(plain(character("c").extra)).toEqual({ nested: ["x"] });
        await sync.flushResources();
        expect(record("characters", "c")).toMatchObject({ desc: "d", extra: { nested: ["x"] } });
        characterStore.updateCharacter("c", { desc: undefined });
        expect("desc" in character("c")).toBe(false);
        await sync.flushResources();
        expect(record("characters", "c")).not.toHaveProperty("desc");
    });

    it("stores keys named like Object.prototype members as own properties, keeps the chats, and saves them", async () => {
        const { sync, chat, characterStore, record, character, db, stores } = await boot();
        const chatsBefore = character("c").chats;
        expect(characterStore.updateCharacter("c", { toString: "x", constructor: 1, desc: "d" })).toBe(true);
        expect(characterStore.updateCharacter("c", { valueOf: "v", hasOwnProperty: 2 })).toBe(true);
        const copy = plain(character("c"));
        expect(copy).toMatchObject({ toString: "x", constructor: 1, valueOf: "v", hasOwnProperty: 2, desc: "d" });
        expect(Object.hasOwn(character("c"), "toString")).toBe(true);
        // The chats are the same values: the chat module still addresses them.
        expect(character("c").chats).toBe(chatsBefore);
        chat.appendMessage(refK, m("d", "D"));
        await sync.flushResources();
        expect(record("characters", "c")).toMatchObject({ toString: "x", constructor: 1, valueOf: "v", desc: "d" });
        expect(record("characters", "c")).not.toHaveProperty("chats");
        expect(server.current.texts("c", "k")).toEqual(["A", "B", "C", "D"]);
        // A later ordinary patch, and one on the selected character, still land on the same record.
        stores.selectedCharID.set(0);
        characterStore.updateCharacter("c", { desc: "again", constructor: 3 });
        await sync.flushResources();
        expect(record("characters", "c")).toMatchObject({ desc: "again", constructor: 3, toString: "x" });
        expect(db().characters).toHaveLength(1);
    });
});

describe("addCharacter", () => {
    it("creates the record, its chats, and the order entry, assigning a missing id", async () => {
        const { fake, sync, characterStore, record, character, db } = await boot();
        const id = characterStore.addCharacter({
            name: "New",
            chats: [{ name: "first", message: [{ role: "user", data: "hi" }] }, { name: "second" }],
        });
        expect(typeof id).toBe("string");
        expect(character(id).chats.map((chat: any) => chat.name)).toEqual(["first", "second"]);
        expect(character(id).chats.every((chat: any) => typeof chat.id === "string")).toBe(true);
        expect(character(id).chats[0].message[0].chatId).toEqual(expect.any(String));
        expect(db().characterOrder).toContain(id);
        await sync.flushResources();
        expect(record("characters", id)).toMatchObject({ chaId: id, name: "New" });
        expect(record("characters", id)).not.toHaveProperty("chats");
        expect(fake.order(id)!.ids).toHaveLength(2);
        expect(fake.texts(id, fake.order(id)!.ids[0])).toEqual(["hi"]);
        expect(record("characterOrder")).toEqual(["c", id]);
    });

    it("gives a character without chats one chat, keeps a given id, and refuses a taken one", async () => {
        const { fake, sync, characterStore, character, refused, validation } = await boot();
        expect(characterStore.addCharacter({ chaId: "given", name: "G" })).toBe("given");
        expect(character("given").chats).toHaveLength(1);
        expect(character("given").chatPage).toBe(0);
        await sync.flushResources();
        expect(fake.order("given")!.ids).toHaveLength(1);
        await refused(
            () => characterStore.addCharacter({ chaId: "c", name: "dup" }),
            validation.MutationValidationError,
        );
    });

    it("refuses malformed input, chats, and messages before anything is installed", async () => {
        const { characterStore, refused, validation, db } = await boot();
        for (const input of [
            "text",
            null,
            [],
            { name: "x", type: "persona" },
            { name: "x", chaId: 5 },
            { name: "x", chats: "k" },
            { name: "x", chats: [null] },
            { name: "x", chats: [[]] },
            { name: "x", chats: [{ message: null }] },
            { name: "x", chats: [{ message: [1] }] },
            { name: "x", chats: [{ message: [{ data: () => 1 }] }] },
        ]) {
            await refused(() => characterStore.addCharacter(input), validation.MutationValidationError);
        }
        expect(db().characters).toHaveLength(1);
    });
});

describe("replaceCharacterFields", () => {
    it("replaces the own fields by id, keeps the mirror's chats, and saves own prototype-named keys", async () => {
        const { sync, characterStore, record, character } = await boot();
        const chatsBefore = character("c").chats;
        const replacement = JSON.parse(
            '{"__proto__":{"x":1},"chaId":"c","name":"Replaced","toString":"t","constructor":9,"chats":[],"chatPage":7}',
        );
        expect(characterStore.replaceCharacterFields(replacement)).toBe(true);
        expect(character("c").name).toBe("Replaced");
        expect(character("c").chats).toBe(chatsBefore);
        expect(character("c").chatPage).toBe(0);
        expect(Object.hasOwn(plain(character("c")), "__proto__")).toBe(true);
        await sync.flushResources();
        const saved = record("characters", "c");
        expect(saved).toMatchObject({ name: "Replaced", toString: "t", constructor: 9 });
        // The mirror keeps an own `__proto__`; the character projection goes through `$state.snapshot`,
        // which drops it (the adapter's rule, `persistence.md`), so only the other keys reach the server.
        expect(Object.hasOwn(saved, "__proto__")).toBe(false);
        expect(saved).not.toHaveProperty("chats");
        expect(server.current.texts("c", "k")).toEqual(["A", "B", "C"]);
    });

    it("requires the id, returns false for an unknown one, and refuses malformed input", async () => {
        const { fake, sync, characterStore, refused, validation } = await boot();
        await refused(
            () => characterStore.replaceCharacterFields({ name: "no id" }),
            validation.MutationValidationError,
        );
        await refused(
            () => characterStore.replaceCharacterFields({ chaId: "c", chats: [null] }),
            validation.MutationValidationError,
        );
        expect(characterStore.replaceCharacterFields({ chaId: "nope", name: "x" })).toBe(false);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });
});

// Phase 4, slice 3: the render key (`reloadKeys`, never saved) is left out of the JSON check and of
// the detached copy, so a character a plugin read back after a send (where the key is a number, or
// was `NaN` before the send stopped producing it) round-trips; the check still refuses a root that
// is not a plain object (a `Date`, a `Map`, a class instance, an object with an inherited id) before
// anything changes (Astra challenge point 5).
describe("checkCharacterInput and the render key", () => {
    it("accepts a character whose reloadKeys is a number, NaN, or a list, keeps the mirror's key, and saves none", async () => {
        const { sync, characterStore, record, character, db } = await boot();
        (db().characters[0] as any).reloadKeys = 3;
        for (const reloadKeys of [7, Number.NaN, ["x"], undefined]) {
            expect(() => characterStore.checkCharacterInput({ chaId: "c", reloadKeys })).not.toThrow();
        }
        expect(characterStore.replaceCharacterFields({ chaId: "c", name: "round trip", reloadKeys: Number.NaN })).toBe(
            true,
        );
        expect(character("c").name).toBe("round trip");
        expect(character("c").reloadKeys).toBe(3);
        const added = characterStore.addCharacter({ name: "with key", chats: [], reloadKeys: Number.NaN });
        expect("reloadKeys" in character(added)).toBe(false);
        expect(characterStore.replaceCharacterAt(1, { chaId: "r", name: "replacing", chats: [], reloadKeys: 9 })).toBe(
            "r",
        );
        expect("reloadKeys" in character("r")).toBe(false);
        await sync.flushResources();
        expect(record("characters", "c")).toMatchObject({ name: "round trip" });
        expect(record("characters", "c")).not.toHaveProperty("reloadKeys");
        expect(record("characters", "r")).not.toHaveProperty("reloadKeys");
    });

    it("refuses a root that is not a plain object, or a non-JSON field next to the key, and changes nothing", async () => {
        const { characterStore, refused, validation } = await boot();
        class Character {
            chaId = "c";
            name = "instance";
        }
        for (const bad of [
            new Date(0),
            new Map([["chaId", "c"]]),
            new Character(),
            Object.create({ chaId: "c", name: "inherited id" }),
            { chaId: "c", reloadKeys: 1, desc: () => 1 },
            { chaId: "c", reloadKeys: 1, desc: 1n },
        ]) {
            await refused(() => characterStore.replaceCharacterFields(bad), validation.MutationValidationError);
            await refused(() => characterStore.addCharacter(bad), validation.MutationValidationError);
            await refused(() => characterStore.replaceCharacterAt(0, bad), validation.MutationValidationError);
        }
        // A null-prototype object is plain data.
        const bare = Object.assign(Object.create(null), { chaId: "c", name: "bare" });
        expect(characterStore.replaceCharacterFields(bare)).toBe(true);
    });
});

describe("replaceCharacterAt", () => {
    it("refuses the same id, an index outside the list, a taken id, and a generating character", async () => {
        const { chat, characterStore, refused, validation, sync } = await boot();
        characterStore.addCharacter({ chaId: "d", name: "D" });
        await sync.flushResources();
        await refused(
            () => characterStore.replaceCharacterAt(0, { chaId: "c", name: "x" }),
            validation.MutationValidationError,
        );
        for (const index of [3, -1, 0.5, Number.NaN]) {
            await refused(
                () => characterStore.replaceCharacterAt(index, { name: "x" }),
                validation.MutationValidationError,
            );
        }
        await refused(
            () => characterStore.replaceCharacterAt(1, { chaId: "c", name: "x" }),
            validation.MutationValidationError,
        );
        chat.beginGeneration(refK, "a", "g");
        await sync.flushResources(); // the `begin` op is sent, so the refusal check compares a settled server
        await refused(() => characterStore.replaceCharacterAt(0, { name: "x" }), validation.MutationValidationError);
        chat.endGeneration(refK, "a", "g");
    });

    it("puts a different character at the index, saving it with its chats and deleting the old one", async () => {
        const { fake, sync, characterStore, characterOrder, record, db } = await boot();
        const id = characterStore.replaceCharacterAt(0, { name: "Swap", chats: [{ message: [m(undefined, "s")] }] });
        expect(db().characters.map((entry: any) => entry.chaId)).toEqual([id]);
        await sync.flushResources();
        expect(fake.record("characters", "c")).toBeNull();
        expect(fake.chat("c", "k")).toBeNull();
        expect(record("characters", id)).toMatchObject({ name: "Swap" });
        expect(fake.texts(id, fake.order(id)!.ids[0])).toEqual(["s"]);
        // Like the plugin branch it replaces, it leaves the order to the next repair (an add, a removal, a boot).
        characterOrder.checkCharOrder();
        expect(plain(db().characterOrder)).toEqual([id]);
        // The list's length appends.
        const appended = characterStore.replaceCharacterAt(1, { name: "Appended" });
        await sync.flushResources();
        expect(db().characters.map((entry: any) => entry.chaId)).toEqual([id, appended]);
        expect(record("characters", appended)).toMatchObject({ name: "Appended" });
    });
});

describe("removeCharacter", () => {
    it("refuses a generating character and returns false for an unknown one", async () => {
        const { fake, sync, chat, characterStore, refused, validation } = await boot();
        chat.beginGeneration(refK, "a", "g");
        await sync.flushResources();
        await refused(() => characterStore.removeCharacter("c"), validation.MutationValidationError);
        chat.endGeneration(refK, "a", "g");
        await sync.flushResources();
        const batches = fake.batchCount();
        expect(characterStore.removeCharacter("nope")).toBe(false);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(batches);
    });

    it("deletes the character with its chats and order entry, and keeps the selection on its character", async () => {
        const { fake, sync, characterStore, record, db, stores } = await boot();
        const a = characterStore.addCharacter({ name: "A" });
        const b = characterStore.addCharacter({ name: "B" });
        await sync.flushResources();
        stores.selectedCharID.set(1); // `a`
        // A removal after the selected index leaves it.
        expect(characterStore.removeCharacter(b)).toBe(true);
        expect(db().characters[get(stores.selectedCharID)].chaId).toBe(a);
        // A removal before it moves it down.
        expect(characterStore.removeCharacter("c")).toBe(true);
        expect(get(stores.selectedCharID)).toBe(0);
        expect(db().characters[0].chaId).toBe(a);
        await sync.flushResources();
        expect(fake.record("characters", "c")).toBeNull();
        expect(fake.record("characters", b)).toBeNull();
        expect(fake.chat("c", "k")).toBeNull();
        expect(fake.order("c")).toBeNull();
        expect(record("characterOrder")).toEqual([a]);
        // Removing the selected character selects none.
        expect(characterStore.removeCharacter(a)).toBe(true);
        expect(get(stores.selectedCharID)).toBe(-1);
        await sync.flushResources();
        expect(fake.record("characters", a)).toBeNull();
        expect(record("characterOrder")).toEqual([]);
    });
});

describe("checkCharOrder", () => {
    it("appends missing characters, drops stale ids and empty folders, and skips trashed and playground characters", async () => {
        const { characterOrder, characterStore, db } = await boot();
        const d = characterStore.addCharacter({ chaId: "d", name: "D" });
        const t = characterStore.addCharacter({ chaId: "t", name: "T" });
        characterStore.updateCharacter(t, { trashTime: 1 });
        characterStore.addCharacter({ chaId: "§playground", name: "P" });
        db().characterOrder = [
            "gone",
            { id: "f1", name: "empty", data: [] },
            { id: "f2", name: "f", data: ["c", "gone"] },
            null,
        ];
        characterOrder.checkCharOrder();
        expect(plain(db().characterOrder)).toEqual([{ id: "f2", name: "f", data: ["c"] }, d]);
        // Trash removes from the order; restore puts it back.
        expect(db().characterOrder).not.toContain(t);
        characterStore.updateCharacter(t, { trashTime: undefined });
        characterOrder.checkCharOrder();
        expect(db().characterOrder).toContain(t);
        expect(db().characterOrder).not.toContain("§playground");
    });

    it("tolerates a folder without a member list (counted as empty) and finishes an emptied folder on the next call", async () => {
        const { characterOrder, db } = await boot();
        db().characterOrder = [{ id: "legacy", name: "no data" }, { id: "f", name: "f", data: ["gone"] }, "c"];
        expect(() => characterOrder.checkCharOrder()).not.toThrow();
        // The legacy folder went; the folder emptied by the member filter survives one call.
        expect(plain(db().characterOrder)).toEqual([{ id: "f", name: "f", data: [] }, "c"]);
        characterOrder.checkCharOrder();
        expect(plain(db().characterOrder)).toEqual(["c"]);
    });

    it("is the same function the app and the plugin API import from globalApi", async () => {
        const { characterOrder } = await boot();
        vi.doUnmock("../../globalApi.svelte");
        vi.resetModules();
        const globalApi = await import("../../globalApi.svelte");
        expect(typeof globalApi.checkCharOrder).toBe("function");
        expect(globalApi.checkCharOrder.toString()).toBe(characterOrder.checkCharOrder.toString());
    });
});
