import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// The client half of the Phase 5 slice 3 host-parity test: the cases of
// `server/src/tests/fixtures/cbs-parity.json` through the client wrapper (`risuChatParser` with the
// live-database host of `parser.svelte.ts`: the selection, `CurrentTriggerIdStore`, `window`,
// `navigator`, the chat variables). `server/src/tests/cbs.test.ts` answers the same cases from a
// Node host; the expected values are hand-derived and pin the legacy quirks.

vi.mock(import("../../../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    return {
        CurrentTriggerIdStore: writable<string | null>(null),
        CharEmotion: writable({}),
    } as unknown as typeof import("../../../stores.svelte");
});

vi.mock(import("../../../storage/database.svelte"), () => {
    return {
        appVer: "1234.5.67",
        // `findCharacterbyId` builds a blank character for an unknown speaker.
        defaultSdDataFunc: () => [],
    } as unknown as typeof import("../../../storage/database.svelte");
});

vi.mock(import("../../../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
}));

import { risuChatParser } from "../../parser.svelte";
import { CurrentTriggerIdStore } from "../../../stores.svelte";
import { characterList } from "../../../storage/characterStore.svelte";
import { initializeChats } from "../../../storage/chatStore.svelte";
import { selectCharacterAt, selectedIndex } from "../../../storage/selection.svelte";
import { installFlatDatabaseWithChats } from "../../../storage/tests/installFlatDatabase";

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
    // The capture installed in the records (as the removed `setDatabaseLite` installed a database;
    // there is no whole-database object since Phase 6 slice 10), since the parser reads the settings
    // through the record views (Phase 6 slice 7) and the characters through the character store
    // (slice 8). It is the flat shape the Node host reads: its root preset fields become the one
    // preset's. The records hold no chats (slice 9a): the capture's chats are held in the chat
    // module, as boot assembles them, and each character's chat page selected (every chat page of
    // the capture is 0, its first chat, which `initializeChats` selects).
    const database = JSON.parse(JSON.stringify(parity.database));
    installFlatDatabaseWithChats(database, "parity-preset");
    initializeChats();
    selectCharacterAt(parity.selectedCharID);
    CurrentTriggerIdStore.set(null);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("the client wrapper answers the host-parity cases", () => {
    test("the window and navigator stand in for the capture's viewport and locale", () => {
        expect([window.innerWidth, window.innerHeight, navigator.language]).toEqual([1280, 720, "en-US"]);
        expect(selectedIndex()).toBe(0);
    });

    for (const entry of parity.cases) {
        test(entry.name, () => {
            CurrentTriggerIdStore.set(entry.triggerId ?? null);
            const { charaId, ...rest } = entry.arg ?? {};
            const arg: Parameters<typeof risuChatParser>[1] = { ...rest };
            if (charaId) {
                arg.chara = characterList().find((candidate) => candidate.chaId === charaId);
            }
            expect(risuChatParser(entry.input, arg)).toBe(entry.expected);
        });
    }
});
