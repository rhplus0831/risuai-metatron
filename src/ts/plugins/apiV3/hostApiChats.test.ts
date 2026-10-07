import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 9a (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// "Plugins" under "Implementation notes, 9a" and "After the challenge"): the character records hold
// no chats, so the v3 host builds the legacy shape at the boundary and the setters load first.
// - `getChar`/`getCharacterFromIndex`/`getDatabase` answer a detached character with its chats and
//   `chatPage`; `getChatFromIndex` finds its chat again after the load (null once it is deleted).
// - `setChar` reconciles the chats through the chat module: an omitted chat is deleted (never the
//   last one), a `chatPage` selects, and the pins taken for the load are released on success and on
//   a refusal.
// - `setDatabaseLite` applies at once when no chats load (the forwarded fields see the selection of
//   the call), after the load otherwise; a character deleted while its chats load is skipped, not
//   recreated.
// The mocks are `hostApi.test.ts`'s.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured, reads } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
    /**
     * The chat module's reads (`readRefs`, Phase 6 slice 9b) for the chats a fixture installs as
     * summaries (`installDatabase`'s `unloaded`): each read answers `chats` by key, after `gate`
     * resolves while one is set (the test releases it to end the load).
     */
    reads: {
        chats: new Map<string, { characterId: string; id: string; revision: string; data: unknown }>(),
        gate: null as Promise<void> | null,
        count: 0,
    },
}));

vi.mock("src/ts/storage/resourceClient", async (importOriginal) => {
    const actual = await importOriginal<typeof import("src/ts/storage/resourceClient")>();
    return {
        ...actual,
        readRefs: async (_refs: unknown, options: { chats?: { characterId: string; id: string }[] } = {}) => {
            reads.count += 1;
            if (reads.gate) {
                await reads.gate;
            }
            return {
                epoch: "test",
                items: [],
                chatCollections: [],
                chats: (options.chats ?? []).map(
                    ({ characterId, id }) =>
                        reads.chats.get(`${characterId}/${id}`) ?? { characterId, id, revision: null, data: null },
                ),
            };
        },
    };
});

vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(apiFactory: CapturedApi) {
            captured.api = apiFactory;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
    },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));

vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { selectCharacter, selectPreset } from "src/ts/storage/selection.svelte";
import { reconcileSelection, settings } from "src/ts/storage/settingsViews.svelte";
import * as chatStore from "src/ts/storage/chatStore.svelte";
import { characterList, removeCharacter } from "src/ts/storage/characterStore.svelte";
import { executePluginV3 } from "./v3.svelte";

const refK = { chaId: "c", chatId: "k" };
/** The fixture's chat revision: a parsable token (a load compares the read's token with the held one). */
const REVISION = "00000000-0000-4000-8000-000000000000:1:1";
const message = (id: string, data: string, role: "user" | "char" = "char") => ({ role, data, chatId: id }) as any;
const chat = (id: string, name: string, messages: any[] = []) => ({
    id,
    name,
    note: "",
    localLore: [],
    message: messages,
});

/** `c` with chats `k` (messages a, b) and `j`; `d` with `kd`. */
function liveCharacters() {
    return [
        {
            chaId: "c",
            type: "character",
            name: "C",
            desc: "about c",
            chatPage: 0,
            chats: [chat("k", "K", [message("a", "A"), message("b", "B", "user")]), chat("j", "J")],
        },
        { chaId: "d", type: "character", name: "D", chatPage: 0, chats: [chat("kd", "KD")] },
    ];
}

/**
 * The records and the chat module installed as boot installs them (the whole-database aggregate is
 * gone since Phase 6 slice 10): the record fields into the records, the selection resolved, and the
 * characters' chats into the chat module. The chats of the characters in `unloaded` are held as
 * their summaries, as boot holds every chat (Phase 6 slice 9b); a load reads them through the
 * mocked `readRefs` (`reads`).
 */
function installDatabase(fields: Record<string, unknown>, unloaded: readonly string[] = []) {
    selectPreset("preset");
    const raw: Record<string, unknown> = { botPresets: [{ id: "preset", name: "P", temperature: 0 }], ...fields };
    const characters = (Array.isArray(raw.characters) ? raw.characters : []) as { chaId: string; chats?: any[] }[];
    reads.chats.clear();
    reads.gate = null;
    reads.count = 0;
    const chats = characters.flatMap((char) =>
        (char.chats ?? []).map((entry) => {
            const record = { characterId: char.chaId, id: entry.id, revision: REVISION, data: entry };
            // Every chat can be read back (a chat evicted by the trim is loaded again through `readRefs`).
            reads.chats.set(`${char.chaId}/${entry.id}`, record);
            if (!unloaded.includes(char.chaId)) {
                return record;
            }
            return { characterId: char.chaId, id: entry.id, revision: REVISION, name: entry.name, fmIndex: -1 };
        }),
    );
    const orders = characters.map((char) => ({
        characterId: char.chaId,
        revision: "o1",
        ids: (char.chats ?? []).map((entry) => entry.id),
    }));
    initializeRecords(takeRecordFields(raw));
    reconcileSelection();
    chatStore.assembleChats(characters, chats, orders);
}

async function makeApi(): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3({
        name: `hostApiChats-test-${Math.random().toString(36).slice(2)}`,
        script: "",
        version: "3.0",
    } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

const ids = () => characterList().map((entry) => entry?.chaId);
const chatIds = (chaId: string) => chatStore.chatList(chaId).map((entry) => entry.id);
/** Installs the fixture again with `d`'s chat held as its summary (a setter naming `d` loads it first). */
function unloadD() {
    installDatabase({ characters: liveCharacters(), pluginCustomStorage: undefined }, ["d"]);
    chatStore.initializeChats();
    selectCharacter("c");
    expect(chatStore.findChat({ chaId: "d", chatId: "kd" })).toBeUndefined();
    expect(chatIds("d")).toEqual(["kd"]);
}
/** Holds every chat read until `release` is called. */
function holdReads() {
    let release!: () => void;
    reads.gate = new Promise<void>((resolve) => (release = resolve));
    return {
        release: () => {
            reads.gate = null;
            release();
        },
    };
}
const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

beforeEach(() => {
    installDatabase({ characters: liveCharacters(), pluginCustomStorage: undefined });
    // As boot does after the assembly: the remembered selections (none: the preference `selectChat`
    // wrote to localStorage in the last test is cleared) replace the last test's.
    localStorage.clear();
    chatStore.initializeChats();
    selectCharacter("c");
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    selectCharacter(null);
    vi.restoreAllMocks();
});

describe("the getters", () => {
    it("getChar and getCharacterFromIndex answer the legacy shape detached: the record with its chats and chatPage", async () => {
        const api = await makeApi();
        chatStore.selectChat("c", "j");
        for (const got of [await api.getChar(), await api.getCharacter(), await api.getCharacterFromIndex(0)]) {
            expect(got).toMatchObject({ chaId: "c", name: "C", desc: "about c", chatPage: 1 });
            expect(got.chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
            expect(got.chats[0].message.map((entry: any) => entry.data)).toEqual(["A", "B"]);
            got.name = "changed by the plugin";
            got.chats[0].message.push(message("z", "Z"));
            got.chats.pop();
        }
        expect(characterList()[0].name).toBe("C");
        expect(chatStore.findChat(refK)!.message).toHaveLength(2);
        expect(chatIds("c")).toEqual(["k", "j"]);
        expect(await api.getCharacterFromIndex(5)).toBeNull();
        expect(chatStore.isChatPinned("c")).toBe(false);
    });

    it("getDatabase with characters answers every character with its chats, read in one pass after the load", async () => {
        const api = await makeApi();
        const db = await api.getDatabase(["characters", "characterOrder"]);
        expect(db.characters.map((entry: any) => entry.chaId)).toEqual(["c", "d"]);
        expect(db.characters.map((entry: any) => entry.chats.map((c: any) => c.id))).toEqual([["k", "j"], ["kd"]]);
        expect(db.characters.map((entry: any) => entry.chatPage)).toEqual([0, 0]);
        db.characters[0].chats[0].message.push(message("z", "Z"));
        expect(chatStore.findChat(refK)!.message).toHaveLength(2);
        expect(chatStore.isChatPinned("c")).toBe(false);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });

    it("getChatFromIndex finds its chat again after the load: the chat as it is then, null once it was deleted", async () => {
        const api = await makeApi();
        expect((await api.getChatFromIndex(0, 0)).id).toBe("k");
        expect(await api.getChatFromIndex(0, 5)).toBeNull();
        expect(await api.getChatFromIndex(5, 0)).toBeNull();

        const changed = api.getChatFromIndex(0, 0);
        chatStore.setChatMeta(refK, { note: "changed meanwhile" });
        expect((await changed).note).toBe("changed meanwhile");

        const deleted = api.getChatFromIndex(0, 0);
        chatStore.deleteChat(refK);
        expect(await deleted).toBeNull();
        // The index named `k` when the call came, not `j` (now at index 0).
        expect(chatIds("c")).toEqual(["j"]);
    });
});

describe("the setters", () => {
    it("setChar outside a hook applies the fields, deletes an omitted chat through the chat module (never the last one), and a chatPage selects", async () => {
        const api = await makeApi();
        const got = await api.getChar();
        await api.setChar({ ...got, name: "Renamed", chats: [got.chats[0]], chatPage: 0 });
        expect(characterList()[0].name).toBe("Renamed");
        expect(chatIds("c")).toEqual(["k"]);
        expect(chatStore.findChat({ chaId: "c", chatId: "j" })).toBeUndefined();
        expect(chatStore.isChatPinned("c")).toBe(false);

        // The last chat is never deleted (the list keeps it, without a warning).
        await api.setChar({ ...(await api.getChar()), chats: [] });
        expect(chatIds("c")).toEqual(["k"]);
        expect(warnings()).toEqual([]);

        await api.setChar({
            ...(await api.getChar()),
            chats: [chat("n", "N"), ...(await api.getChar()).chats],
            chatPage: 0,
        });
        expect(chatIds("c")).toEqual(["n", "k"]);
        expect(chatStore.selectedChatId("c")).toBe("n");
        await api.setChar({ ...(await api.getChar()), chatPage: 1 });
        expect(chatStore.selectedChatId("c")).toBe("k");
    });

    it("the pins taken for a setter's load are released after a refusal too", async () => {
        const api = await makeApi();
        await api.setCharacterToIndex(0, "not a character");
        expect(warnings()).toEqual([expect.stringMatching(/Refused a character/)]);
        expect(ids()).toEqual(["c", "d"]);
        expect(chatStore.isChatPinned("c")).toBe(false);
        await api.setDatabaseLite({ characters: [{ ...liveCharacters()[0], chaId: 5 }] });
        expect(ids()).toEqual(["c", "d"]);
        expect(chatStore.isChatPinned("c")).toBe(false);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });

    it("setDatabaseLite applies at once when no chats load, after the load when a characters list names existing characters", async () => {
        const api = await makeApi();
        const atOnce = api.setDatabaseLite({ theme: "sync" });
        expect(settings.ui.theme).toBe("sync");
        await atOnce;

        // `d`'s chat is held as its summary (Phase 6 slice 9b): the list names `d`, so its chats load
        // first; the read is held until the test releases it.
        unloadD();
        const { release } = holdReads();
        const later = api.setDatabaseLite({
            characters: [{ ...liveCharacters()[0], name: "Later" }, liveCharacters()[1]],
        });
        await Promise.resolve();
        expect(reads.count).toBe(1);
        expect(characterList()[0].name).toBe("C");
        release();
        await later;
        expect(characterList()[0].name).toBe("Later");
        expect(chatIds("c")).toEqual(["k", "j"]);
        expect(chatIds("d")).toEqual(["kd"]);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });

    it("a character deleted while the list's chats load is skipped with a warning, never recreated; the rest of the list lands", async () => {
        const api = await makeApi();
        // `d`'s chat is held as its summary (Phase 6 slice 9b): its load is in flight when `d` is deleted.
        unloadD();
        const { release } = holdReads();
        const [c, d] = liveCharacters();
        const running = api.setDatabaseLite({
            characters: [
                { ...c, name: "C2" },
                { ...d, name: "D2" },
                { name: "new one", chats: [] },
            ],
        });
        await Promise.resolve();
        expect(reads.count).toBe(1);
        removeCharacter("d");
        release();
        await running;
        expect(characterList().map((entry) => [entry?.chaId, entry?.name])).toEqual([
            ["c", "C2"],
            [expect.any(String), "new one"],
        ]);
        expect(ids()).not.toContain("d");
        expect(warnings()).toEqual([expect.stringMatching(/deleted while their chats loaded/)]);
        expect(chatStore.isChatPinned("c")).toBe(false);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });
});

// Phase 6 slice 9b: boot holds summaries, chats load on demand, and idle loaded chats are evicted
// beyond eight. The plugin boundary loads what it copies or reconciles, pins it meanwhile, and refuses
// a character whose chats were replaced (even under the same ids) while they loaded.
describe("lazy loading (Phase 6 slice 9b)", () => {
    /** `c` with twelve chats (`k` with messages a, b; `j`; `x0`..`x9`), `d` with `kd`. */
    function manyCharacters() {
        const [c, d] = liveCharacters();
        return [
            {
                ...c,
                chats: [
                    ...c.chats,
                    ...Array.from({ length: 10 }, (_, i) => chat(`x${i}`, `X${i}`, [message(`x${i}-0`, `X${i}`)])),
                ],
            },
            d,
        ];
    }
    const loadedIds = (chaId: string) => chatIds(chaId).filter((id) => chatStore.findChat({ chaId, chatId: id }));
    /** Holds every fixture chat's revision, as boot's `seedChats` does (the trim evicts saved chats only). */
    const seedRevisions = () =>
        chatStore.seedChats(
            [...reads.chats.values()],
            characterList().map((entry) => ({
                characterId: entry!.chaId,
                revision: REVISION,
                ids: chatIds(entry!.chaId),
            })),
        );
    /** The chat ops queued so far, taken as the save loop takes them: `chatId` with its op names. */
    const queuedOps = () =>
        chatStore.takeChatWork(new Set()).groups.map((group) => [group.chatId, group.ops.map((op) => op.op)]);

    it("a getter on a character whose chats are not loaded loads them first (one read), answers every chat complete, and releases the pins", async () => {
        const api = await makeApi();
        unloadD();
        const got = await api.getCharacterFromIndex(1);
        expect(reads.count).toBe(1);
        expect(got.chats.map((entry: any) => entry.id)).toEqual(["kd"]);
        expect(got.chats[0].name).toBe("KD");
        expect(got.chatPage).toBe(0);
        expect(chatStore.isChatPinned("d")).toBe(false);
        // `getDatabase` with characters loads `d` too (it was not loaded before): one read per character with unloaded chats.
        unloadD();
        const db = await api.getDatabase(["characters"]);
        expect(db.characters.map((entry: any) => entry.chats.map((c: any) => c.id))).toEqual([["k", "j"], ["kd"]]);
        // (`unloadD` reset the count.)
        expect(reads.count).toBe(1);
        expect(chatStore.isChatPinned("c")).toBe(false);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });

    it("setChar after an eviction: the plugin's change to the evicted chat is applied as a change, not a create; a chat left out of the list is deleted through the order", async () => {
        installDatabase({ characters: manyCharacters(), pluginCustomStorage: undefined });
        chatStore.initializeChats();
        seedRevisions();
        selectCharacter("c");
        const api = await makeApi();
        const got = await api.getChar();
        expect(got.chats.map((entry: any) => entry.id)).toEqual([
            "k",
            "j",
            ...Array.from({ length: 10 }, (_, i) => `x${i}`),
        ]);
        // Thirteen loaded (`kd` too), `k` selected: the trim keeps eight idle chats and evicts the
        // least recently used (which ones, and how many, depends on the recency stamps and the unsent
        // work earlier cases left in the shared module: at least two of the `x` chats go).
        chatStore.trimLoadedChats();
        const evicted = chatIds("c").filter((id) => !chatStore.findChat({ chaId: "c", chatId: id }));
        expect(evicted.length).toBeGreaterThanOrEqual(2);
        expect(evicted.every((id) => id.startsWith("x"))).toBe(true);
        const [changed, omitted] = evicted;
        reads.count = 0;
        await api.setChar({
            ...got,
            chats: got.chats
                .filter((entry: any) => entry.id !== omitted)
                .map((entry: any) =>
                    entry.id === changed ? { ...entry, note: "from the plugin", name: "Renamed" } : entry,
                ),
        });
        // The evicted chats were loaded for the reconcile (one read) and the changed one changed in
        // place: a `meta` change, no create; the omitted one is deleted.
        expect(reads.count).toBe(1);
        expect(chatIds("c")).toEqual(got.chats.map((entry: any) => entry.id).filter((id: string) => id !== omitted));
        expect(chatStore.findChat({ chaId: "c", chatId: changed })).toMatchObject({
            note: "from the plugin",
            name: "Renamed",
        });
        expect(chatStore.chatEntry({ chaId: "c", chatId: changed })?.name).toBe("Renamed");
        const ops = queuedOps().filter(([id]) => id === changed || id === omitted);
        expect(ops).toEqual(
            expect.arrayContaining([
                [changed, ["meta"]],
                [omitted, ["delete"]],
            ]),
        );
        expect(ops).toHaveLength(2);
        expect(warnings()).toEqual([]);
        expect(chatStore.isChatPinned("c")).toBe(false);
    });

    it("a setter or getter whose character's chats were replaced under the same ids while they loaded is refused: nothing is applied, the pins are released", async () => {
        const api = await makeApi();
        unloadD();
        const { release } = holdReads();
        const [, d] = liveCharacters();
        const setting = api.setCharacterToIndex(1, { ...d, name: "Later" });
        await Promise.resolve();
        expect(reads.count).toBe(1);
        // A re-import of `d` under the same ids while the setter's load is out.
        chatStore.installCharacterChats("d", [chat("kd", "KD again")] as any, { firstMsgIndex: -1 });
        release();
        await expect(setting).rejects.toThrow(/character/);
        expect(characterList()[1].name).toBe("D");
        expect(chatStore.findChat({ chaId: "d", chatId: "kd" })?.name).toBe("KD again");
        expect(chatStore.isChatPinned("d")).toBe(false);

        // The same for a getter: the copy is never of the replacement.
        unloadD();
        const holding = holdReads();
        const getting = api.getCharacterFromIndex(1);
        await Promise.resolve();
        chatStore.installCharacterChats("d", [chat("kd", "KD replaced")] as any, { firstMsgIndex: -1 });
        holding.release();
        await expect(getting).rejects.toThrow(/character/);
        expect(chatStore.isChatPinned("d")).toBe(false);
    });
});
