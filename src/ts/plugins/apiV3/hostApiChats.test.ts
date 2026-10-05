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

const { captured, dbMocks } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
    dbMocks: { setDatabase: vi.fn() },
}));

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

vi.mock("src/ts/storage/database.svelte", async () => {
    const stores = await vi.importActual<typeof import("src/ts/stores.svelte")>("src/ts/stores.svelte");
    return {
        getDatabase: () => stores.DBState.db,
        setDatabase: dbMocks.setDatabase,
        getCurrentCharacter: vi.fn(),
        setCurrentChat: vi.fn(),
    };
});

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
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

import { DBState } from "src/ts/stores.svelte";
import { installForwarding } from "src/ts/storage/forwarding.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { selectCharacter, selectPreset } from "src/ts/storage/selection.svelte";
import * as chatStore from "src/ts/storage/chatStore.svelte";
import { characterList, removeCharacter } from "src/ts/storage/characterStore.svelte";
import { executePluginV3 } from "./v3.svelte";

const refK = { chaId: "c", chatId: "k" };
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

/** The records and the chat module installed as `setDatabaseLite` and boot install a database. */
function forwardedDatabase(fields: Record<string, unknown>) {
    selectPreset("preset");
    const raw: Record<string, unknown> = { botPresets: [{ id: "preset", name: "P", temperature: 0 }], ...fields };
    const characters = (Array.isArray(raw.characters) ? raw.characters : []) as { chaId: string; chats?: any[] }[];
    const chats = characters.flatMap((char) =>
        (char.chats ?? []).map((entry) => ({ characterId: char.chaId, id: entry.id, revision: "r1", data: entry })),
    );
    const orders = characters.map((char) => ({
        characterId: char.chaId,
        revision: "o1",
        ids: (char.chats ?? []).map((entry) => entry.id),
    }));
    initializeRecords(takeRecordFields(raw));
    chatStore.assembleChats(characters, chats, orders);
    return installForwarding(raw) as any;
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
const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

beforeEach(() => {
    DBState.db = forwardedDatabase({ characters: liveCharacters(), pluginCustomStorage: undefined });
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
        expect(DBState.db.theme).toBe("sync");
        await atOnce;

        const later = api.setDatabaseLite({
            characters: [{ ...liveCharacters()[0], name: "Later" }, liveCharacters()[1]],
        });
        expect(characterList()[0].name).toBe("C");
        await later;
        expect(characterList()[0].name).toBe("Later");
        expect(chatIds("c")).toEqual(["k", "j"]);
    });

    it("a character deleted while the list's chats load is skipped with a warning, never recreated; the rest of the list lands", async () => {
        const api = await makeApi();
        const [c, d] = liveCharacters();
        const running = api.setDatabaseLite({
            characters: [
                { ...c, name: "C2" },
                { ...d, name: "D2" },
                { name: "new one", chats: [] },
            ],
        });
        removeCharacter("d");
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
