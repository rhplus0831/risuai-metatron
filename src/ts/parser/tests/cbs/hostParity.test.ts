import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { get } from "svelte/store";

// The client half of the Phase 5 slice 3 host-parity test: the cases of
// `server/src/tests/fixtures/cbs-parity.json` through the client wrapper (`risuChatParser` with the
// live-database host of `parser.svelte.ts`: the selection, `CurrentTriggerIdStore`, `window`,
// `navigator`, the chat variables). `server/src/tests/cbs.test.ts` answers the same cases from a
// Node host; the expected values are hand-derived and pin the legacy quirks.

const holder = vi.hoisted(() => ({
    dbState: { db: {} as any },
    selectedCharID: null as unknown as import("svelte/store").Writable<number>,
    triggerId: null as unknown as import("svelte/store").Writable<string | null>,
}));

vi.mock(import("../../../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    // The real selection's index shim, as `stores.svelte` exports it (Phase 6 slice 8: the readers
    // resolve the selected character by `selection.characterId`, which `set(index)` selects).
    holder.selectedCharID = (await import("../../../storage/selection.svelte")).selectedCharacterIndex;
    holder.triggerId = writable<string | null>(null);
    return {
        DBState: holder.dbState,
        selIdState: { selId: 0 },
        selectedCharID: holder.selectedCharID,
        CurrentTriggerIdStore: holder.triggerId,
        CharEmotion: writable({}),
    } as unknown as typeof import("../../../stores.svelte");
});

vi.mock(import("../../../storage/database.svelte"), async () => {
    const { get } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    const current = () => holder.dbState.db.characters?.[get(holder.selectedCharID)];
    return {
        appVer: "1234.5.67",
        // `findCharacterbyId` builds a blank character for an unknown speaker.
        defaultSdDataFunc: () => [],
        getDatabase: () => holder.dbState.db,
        getCurrentCharacter: () => current(),
        getCurrentChat: () => current()?.chats?.[current().chatPage],
    } as unknown as typeof import("../../../storage/database.svelte");
});

vi.mock(import("../../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

import { risuChatParser } from "../../parser.svelte";
import { CurrentTriggerIdStore, DBState, selectedCharID } from "../../../stores.svelte";
import { installFlatDatabase } from "../../../storage/tests/installFlatDatabase";
import { assembleChats } from "../../../storage/chatStore.svelte";

type ParityCase = {
    name: string;
    input: string;
    expected: string;
    triggerId?: string;
    arg?: {
        chatID?: number;
        chatRef?: { chaId: string; chatId: string };
        charaId?: string;
        chara?: string;
        rmVar?: boolean;
        consistantChar?: boolean;
    };
};

const parity = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../../../../server/src/tests/fixtures/cbs-parity.json"), "utf8"),
) as {
    fixedTime: string;
    viewport: { width: number; height: number };
    browserLanguage: string;
    selectedCharID: number;
    database: unknown;
    cases: ParityCase[];
};

const previousTz = process.env.TZ;

beforeAll(() => {
    process.env.TZ = "UTC";
    expect(new Date(parity.fixedTime).getHours()).toBe(12);
    Object.defineProperty(window, "innerWidth", { value: parity.viewport.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: parity.viewport.height, configurable: true });
    Object.defineProperty(navigator, "language", { value: parity.browserLanguage, configurable: true });
});

afterAll(() => {
    if (previousTz === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = previousTz;
    }
});

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(parity.fixedTime), toFake: ["Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The capture installed as `setDatabaseLite` installs a database (`database.svelte` is mocked
    // here), since the parser reads the settings through the record views (Phase 6 slice 7). It is
    // the flat shape the Node host reads: its root preset fields become the one preset's.
    const database = JSON.parse(JSON.stringify(parity.database));
    // The records hold no chats (Phase 6 slice 9a): the capture's chats are held in the chat module,
    // as boot assembles them (every chat page of the capture is 0, its first chat).
    const characters = database.characters as { chaId: string; chats: { id: string }[] }[];
    const chats = characters.flatMap((char) =>
        char.chats.map((chat) => ({ characterId: char.chaId, id: chat.id, revision: "r1", data: chat as any })),
    );
    const orders = characters.map((char) => ({
        characterId: char.chaId,
        revision: "o1",
        ids: char.chats.map((chat) => chat.id),
    }));
    DBState.db = installFlatDatabase(database, "parity-preset");
    assembleChats(DBState.db.characters, chats, orders);
    selectedCharID.set(parity.selectedCharID);
    CurrentTriggerIdStore.set(null);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the client wrapper answers the host-parity cases", () => {
    test("the window and navigator stand in for the capture's viewport and locale", () => {
        expect([window.innerWidth, window.innerHeight, navigator.language]).toEqual([1280, 720, "en-US"]);
        expect(get(selectedCharID)).toBe(0);
    });

    for (const entry of parity.cases) {
        test(entry.name, () => {
            CurrentTriggerIdStore.set(entry.triggerId ?? null);
            const { charaId, ...rest } = entry.arg ?? {};
            const arg: Parameters<typeof risuChatParser>[1] = { ...rest };
            if (charaId) {
                arg.chara = DBState.db.characters.find((candidate) => candidate.chaId === charaId);
            }
            expect(risuChatParser(entry.input, arg)).toBe(entry.expected);
        });
    }
});
