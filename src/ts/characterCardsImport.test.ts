import { readFileSync } from "node:fs";
import path from "node:path";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { cardV2, cardV3, characterBook, charx, nested, pngWithText } from "./storage/tests/importFixtures";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

// Phase 4, slice 7 (`docs/plan/phases/slices/phase-4-external-contracts/imports-through-the-module.md`):
// `importCharacterProcess` creates its records through `addCharacter` over the real save adapter and
// the real server store (`storeBackedServer.ts`). A JSON V2 card, an off-spec JSON card, a PNG
// (`chara` chunk, through the real chunk reader), and a CharX (`card.json`, through the real zip
// importer) each add one character with a fresh `chaId`, a chat with an id, and an order entry, and
// the character, its chat, and the order are on the server after one cycle. The `statics.imports`
// stamp goes through `incrementStatic`. A card `addCharacter` refuses (JSON nested past the check's
// limit) leaves the character list, the chats, and the order unchanged; the stamp and a saved image
// stay (the importer is not transactional, Astra challenge point 3), and the UI entry
// (`importCharacter`) reports the refusal. A card the reader rejects earlier reports `noData`.

const { server, alerts, picker, assets } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
    /** The files the next `selectFileByDom` answers with. */
    picker: { files: [] as File[] },
    assets: { saved: [] as Uint8Array[] },
}));

vi.mock("./storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: alerts.confirm,
    alertStore: alerts.store,
    alertWait: vi.fn(),
    alertInput: vi.fn(async () => ""),
    alertSelect: vi.fn(async () => ""),
    alertAddCharacter: vi.fn(),
    alertCardExport: vi.fn(),
    alertClear: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertMd: vi.fn(),
    waitAlert: vi.fn(),
}));
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
// The real RPack reads its byte map through `fetch` of a Vite asset; the map comes from disk here.
vi.mock("./rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "./rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    // `globalApi` and `util` stay real (a `vi.mock` wrapper would outlive `vi.resetModules` and keep
    // the first graph's `DBState`); the asset store, `sleep` (a faked timer), and the file dialog are
    // spied on this graph's namespaces.
    const globalApi = await import("./globalApi.svelte");
    vi.spyOn(globalApi, "saveAsset").mockImplementation((async (data: Uint8Array) => {
        assets.saved.push(data);
        return `asset-${assets.saved.length}`;
    }) as any);
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    vi.spyOn(util, "selectFileByDom").mockImplementation(async () => picker.files);
    const cards = await import("./characterCards");
    const { db, fake, sync } = booted;
    const ids = () => db().characters.map((entry: any) => entry.chaId as string);
    const order = () => plain(db().characterOrder) as string[];
    /** The character added last, the chat it got, and what the server holds for both after a cycle. */
    const added = async (before: string[]) => {
        const chaId = ids().find((id) => !before.includes(id))!;
        expect(chaId).toMatch(UUID_V4);
        const character = booted.character(chaId);
        expect(character.chats).toHaveLength(1);
        expect(character.chats[0].id).toMatch(UUID_V4);
        expect(order()).toContain(chaId);
        await sync.flushResources();
        const record = booted.record("characters", chaId);
        expect(record.chaId).toBe(chaId);
        expect(fake.chat(chaId, character.chats[0].id)).not.toBeNull();
        expect(booted.record("characterOrder")).toContain(chaId);
        return { chaId, character: plain(character), record };
    };
    return { ...booted, cards, ids, order, added };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./characterCards");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    // The browser's `structuredClone` passes `undefined` through; the setup's JSON clone throws on it,
    // and the card importer clones the risuai extension a card may omit.
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    picker.files = [];
    assets.saved.length = 0;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importCharacterProcess creates the character through addCharacter", () => {
    it("a JSON V2 card: the character, its chat, and the order entry are created in one cycle and saved", async () => {
        const { cards, ids, added, db, stores } = await boot();
        const before = ids();
        const card = cardV2("Json", { character_book: characterBook("Json Lore", "json lore") });
        const index = await cards.importCharacterProcess({ name: "card.json", data: encode(card) });
        expect(index).toBe(db().characters.length - 1);
        const { character, record } = await added(before);
        expect(character.name).toBe("Json");
        expect(character.firstMessage).toBe("hello from Json");
        expect(character.globalLore).toEqual([expect.objectContaining({ comment: "Json Lore", content: "json lore" })]);
        expect(record.name).toBe("Json");
        expect(record.globalLore).toEqual(character.globalLore);
        expect(alerts.normal).toHaveBeenCalledWith(language.importedCharacter);
        expect(alerts.error).not.toHaveBeenCalled();
        // The JSON paths return before the stamp, as before the slice.
        expect(db().statics?.imports ?? 0).toBe(0);
        expect(get(stores.selectedCharID)).toBe(-1);
    });

    it("an off-spec JSON card (name, description, first message) goes through convertOffSpecCards and addCharacter", async () => {
        const { cards, ids, added } = await boot();
        const before = ids();
        await cards.importCharacterProcess({
            name: "off.json",
            data: encode({ name: "Off", description: "off desc", first_mes: "hi off" }),
        });
        const { character, record } = await added(before);
        expect(character).toMatchObject({ name: "Off", desc: "off desc", firstMessage: "hi off" });
        expect(record).toMatchObject({ name: "Off", desc: "off desc" });
        expect(alerts.normal).toHaveBeenCalledWith(language.importedCharacter);
    });

    it("a PNG card (`chara` chunk): the image is saved, the stamp goes up by one, and the character is saved", async () => {
        const { cards, ids, added, db } = await boot();
        const before = ids();
        const png = pngWithText({ chara: cardV2("Png", {}, { additionalText: "from png" }) });
        const index = await cards.importCharacterProcess({ name: "card.png", data: png });
        expect(index).toBe(db().characters.length - 1);
        const { character, record } = await added(before);
        expect(character.name).toBe("Png");
        expect(character.image).toBe("asset-1");
        expect(character.additionalText).toBe("from png");
        expect(record.image).toBe("asset-1");
        expect(db().statics.imports).toBe(1);
        expect(alerts.normal).toHaveBeenCalledWith(language.importedCharacter);
    });

    it("a CharX card (`card.json`, V3) through the real zip importer: the V3 fields land and the stamp goes up", async () => {
        const { cards, ids, added, db } = await boot();
        const before = ids();
        const index = await cards.importCharacterProcess({ name: "card.charx", data: charx(cardV3("Charx")) });
        expect(index).toBe(db().characters.length - 1);
        const { character, record } = await added(before);
        expect(character.name).toBe("Charx");
        expect(character.nickname).toBe("Charx nick");
        expect(character.creation_date).toBe(1);
        expect(record.nickname).toBe("Charx nick");
        expect(db().statics.imports).toBe(1);
        // A second import of the same file is another character with its own id.
        await cards.importCharacterProcess({ name: "card.charx", data: charx(cardV3("Charx")) });
        expect(ids()).toHaveLength(before.length + 2);
        expect(new Set(ids()).size).toBe(before.length + 2);
        expect(db().statics.imports).toBe(2);
    });

    it("a character imported with `returnCharacter` (the module converter's path) is returned and not added", async () => {
        const { cards, ids, order, db } = await boot();
        const before = ids();
        const char = await cards.importCharacterProcess({
            name: "card.charx",
            data: charx(cardV3("Detached")),
            returnCharacter: true,
        });
        expect(char).toMatchObject({ name: "Detached", chaId: expect.stringMatching(UUID_V4) });
        expect(ids()).toEqual(before);
        expect(order()).not.toContain((char as any).chaId);
        expect(db().statics.imports).toBe(1);
    });
});

describe("a refused or rejected card", () => {
    const deep = () => cardV2("Deep", { extensions: { risuai: {}, deep: nested(300) } });

    it("a card addCharacter refuses (nested past the JSON check) changes no character, chat, or order entry", async () => {
        const { cards, ids, serverText, mirrorText, sync, fake, validation, db } = await boot();
        const characters = mirrorText();
        const server = serverText();
        const batches = fake.batchCount();
        await expect(cards.importCharacterProcess({ name: "deep.json", data: encode(deep()) })).rejects.toBeInstanceOf(
            validation.MutationValidationError,
        );
        expect(mirrorText()).toBe(characters);
        await sync.flushResources();
        expect(serverText()).toBe(server);
        expect(fake.batchCount()).toBe(batches);
        expect(ids()).toEqual(JSON.parse(characters).characters.map((entry: any) => entry.chaId));
        expect(db().statics?.imports ?? 0).toBe(0);
    });

    it("through a PNG the stamp and the saved image stay (the importer is not transactional), the list is unchanged", async () => {
        const { cards, ids, order, sync, validation, db } = await boot();
        const before = ids();
        const orderBefore = order();
        await expect(
            cards.importCharacterProcess({ name: "deep.png", data: pngWithText({ chara: deep() }) }),
        ).rejects.toBeInstanceOf(validation.MutationValidationError);
        expect(ids()).toEqual(before);
        expect(order()).toEqual(orderBefore);
        expect(db().statics.imports).toBe(1);
        expect(assets.saved).toHaveLength(1);
        await sync.flushResources();
        expect(server.current.record("characterOrder", "main").data).toEqual(orderBefore);
    });

    it("the UI entry (importCharacter) reports the refusal as an error and imports nothing", async () => {
        const { cards, ids } = await boot();
        const before = ids();
        picker.files = [new File([encode(deep())], "deep.json")];
        await cards.importCharacter();
        expect(ids()).toEqual(before);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(String(alerts.error.mock.calls[0][0])).toContain("not JSON data");
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it("a JSON file the reader rejects (no greeting) reports noData and changes nothing", async () => {
        const { cards, mirrorText, serverText, sync, fake } = await boot();
        const characters = mirrorText();
        const before = serverText();
        const batches = fake.batchCount();
        await cards.importCharacterProcess({ name: "bad.json", data: encode({ name: "Bad", description: "d" }) });
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(mirrorText()).toBe(characters);
        await sync.flushResources();
        expect(serverText()).toBe(before);
        expect(fake.batchCount()).toBe(batches);
    });

    it("a PNG without a card chunk reports noData; only the stamp moved", async () => {
        const { cards, ids, db } = await boot();
        const before = ids();
        await cards.importCharacterProcess({ name: "blank.png", data: pngWithText({}) });
        expect(alerts.error).toHaveBeenCalledWith(language.errors.noData);
        expect(ids()).toEqual(before);
        expect(db().statics.imports).toBe(1);
    });
});
