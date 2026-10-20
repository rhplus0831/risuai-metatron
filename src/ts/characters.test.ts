import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../shared/resources.ts";
import { FakeResourceServer } from "./storage/tests/fakeResourceServer";
import { materialize } from "./storage/tests/serverKinds";

// `removeChar` (trash) and `restoreChar` against the save adapter: both write `trashTime` on a
// character that is usually not the selected one (the catalog opens from the home screen), so the
// write must be marked dirty or it never reaches the server and the character is either back
// after a reload or, three days later, deleted for good by the boot pass.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined), confirm: vi.fn() },
}));

vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("./alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: alerts.confirm,
    alertAddCharacter: vi.fn(),
    alertSelect: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: vi.fn(),
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", removeConfirm: "?", removeConfirm2: "?" },
    changeLanguage: vi.fn(),
}));
vi.mock("./process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("./parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./characterCards", () => ({ importCharacter: vi.fn() }));
// The emotion picker and the save queue are doubled for `addCharEmotion`.
const { picker } = vi.hoisted(() => ({ picker: { current: async (): Promise<File[]> => [] } }));
vi.mock("./util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./util")>()),
    selectMultipleFileHandles: () => picker.current(),
}));
vi.mock("./storage/assetQueue", () => ({
    savePickedFiles: async (files: File[]) => files.map((file) => `key-${file.name}`),
}));

type Sync = typeof import("./storage/resourceSync.svelte");
type Client = typeof import("./storage/resourceClient");
type Characters = typeof import("./characters");
type Bootstrap = typeof import("./bootstrap");
type CharacterStore = typeof import("./storage/characterStore.svelte");
type SelectionModule = typeof import("./storage/selection.svelte");

function character(chaId: string, name: string, extra: Record<string, unknown> = {}) {
    return { chaId, name, type: "character", chats: [], chatPage: 0, ...extra };
}

async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    // No `root` record since slice 6; the character order is a collection record of its own.
    fake.set("characterOrder", "main", ["a", "b"]);
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice"));
    fake.set("characters", "b", character("b", "Bob"));
    await materialize(fake);
    server.current = fake;

    const client: Client = await import("./storage/resourceClient");
    const sync: Sync = await import("./storage/resourceSync.svelte");
    const characters: Characters = await import("./characters");
    const bootstrap: Bootstrap = await import("./bootstrap");
    const characterStore: CharacterStore = await import("./storage/characterStore.svelte");
    const selectionModule: SelectionModule = await import("./storage/selection.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    // The real boot installs the records (Phase 6 slice 10); the tab starts at home.
    bootstrap.installBootRecords(snapshot);
    selectionModule.selectCharacter(null);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    return { fake, sync, characters, characterList: () => characterStore.characterList() as any[] };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    alerts.confirm.mockResolvedValue(true);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("trash and restore", () => {
    it("saves the trash time of a character that is not selected", async () => {
        const { fake, sync, characters, characterList } = await boot();
        await characters.removeChar("b", "Bob", "normal");
        expect(characterList()[1].trashTime).toEqual(expect.any(Number));
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toEqual(expect.any(Number));
        expect(fake.data("characterOrder", "main")).toEqual(["a"]);
    });

    it("saves a restore from the trash, so the character is not deleted by a later boot", async () => {
        const { fake, sync, characters, characterList } = await boot();
        await characters.removeChar("b", "Bob", "normal");
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toEqual(expect.any(Number));

        characters.restoreChar("b");
        expect(characterList()[1].trashTime).toBeUndefined();
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toBeUndefined();
        expect(fake.data("characterOrder", "main")).toEqual(["a", "b"]);
    });
});

// The emotion and portrait writers over the immutable asset lists (heap plan B2): each one replaces
// the character's `emotionImages` / `ccAssets` whole through the record, the stored list is frozen,
// the edit is saved, and `addCharEmotion` appends to the latest list of the character found again
// by `chaId` after its awaits (nothing when it is gone meanwhile).
describe("emotion images and portraits", () => {
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    const icon = (name: string) => ({ type: "icon", uri: `icons/${name}.png`, name, ext: "png" });

    it("rmCharEmotion and addCharEmotion replace the list; the add targets the character's latest list", async () => {
        const { fake, sync, characters, characterList } = await boot();
        const records = await import("./storage/records.svelte");
        const a = () => characterList().find((entry) => entry.chaId === "a");
        a().emotionImages = [
            ["joy", "emotions/joy.png"],
            ["calm", "emotions/calm.png"],
            ["sad", "emotions/sad.png"],
        ];
        await sync.flushResources();
        const before = a().emotionImages;
        expect(records.isFrozenAssetList(before)).toBe(true);
        characters.rmCharEmotion("a", 1);
        expect(a().emotionImages).not.toBe(before);
        expect(records.isFrozenAssetList(a().emotionImages)).toBe(true);
        expect(a().emotionImages[0]).toBe(before[0]);
        expect(plain(a().emotionImages)).toEqual([
            ["joy", "emotions/joy.png"],
            ["sad", "emotions/sad.png"],
        ]);
        await sync.flushResources();
        expect(fake.data("characters", "a").emotionImages).toEqual([
            ["joy", "emotions/joy.png"],
            ["sad", "emotions/sad.png"],
        ]);

        // The picker resolves after another edit replaced the list: the add appends to the latest one.
        let release: (files: File[]) => void = () => {};
        picker.current = () => new Promise((resolve) => (release = resolve));
        const adding = characters.addCharEmotion("a");
        await Promise.resolve();
        a().emotionImages = [...a().emotionImages, ["meanwhile", "emotions/m.png"]];
        release([new File(["x"], "happy.png"), new File(["y"], "wink.webp")]);
        await adding;
        expect(plain(a().emotionImages)).toEqual([
            ["joy", "emotions/joy.png"],
            ["sad", "emotions/sad.png"],
            ["meanwhile", "emotions/m.png"],
            ["happy", "key-happy.png"],
            ["wink", "key-wink.webp"],
        ]);
        expect(records.isFrozenAssetList(a().emotionImages)).toBe(true);
        await sync.flushResources();
        expect(fake.data("characters", "a").emotionImages).toEqual(plain(a().emotionImages));

        // A character removed while the picker is open gets nothing, and nothing throws.
        picker.current = () => new Promise((resolve) => (release = resolve));
        const late = characters.addCharEmotion("b");
        await Promise.resolve();
        records.removeCharacterRecords(["b"]);
        release([new File(["z"], "gone.png")]);
        await late;
        expect(characterList().find((entry) => entry.chaId === "b")).toBeUndefined();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("changeCharImage and dumpCharImage replace ccAssets and swap the portrait", async () => {
        const { fake, sync, characters, characterList } = await boot();
        const records = await import("./storage/records.svelte");
        const a = () => characterList().find((entry) => entry.chaId === "a");
        a().image = "portrait-0";
        a().ccAssets = [icon("first"), icon("second")];
        await sync.flushResources();
        const before = a().ccAssets;
        expect(records.isFrozenAssetList(before)).toBe(true);
        characters.changeCharImage("a", 0);
        expect(a().image).toBe("icons/first.png");
        expect(plain(a().ccAssets)).toEqual([
            icon("second"),
            { type: "icon", name: "iconx", uri: "portrait-0", ext: "png" },
        ]);
        expect(records.isFrozenAssetList(a().ccAssets)).toBe(true);
        expect(a().ccAssets[0]).toBe(before[1]);
        expect(Object.isFrozen(a().ccAssets[1])).toBe(true);
        await sync.flushResources();
        expect(fake.data("characters", "a")).toMatchObject({ image: "icons/first.png", ccAssets: plain(a().ccAssets) });

        // Without a portrait there is nothing to dump; with one, it is appended and the portrait cleared.
        a().image = "";
        const unchanged = a().ccAssets;
        characters.dumpCharImage("a");
        expect(a().ccAssets).toBe(unchanged);
        a().image = "portrait-1";
        characters.dumpCharImage("a");
        expect(a().image).toBe("");
        expect(plain(a().ccAssets)).toEqual([
            icon("second"),
            { type: "icon", name: "iconx", uri: "portrait-0", ext: "png" },
            { type: "icon", name: "iconx", uri: "portrait-1", ext: "png" },
        ]);
        // A character without `ccAssets` yet gets a fresh frozen list.
        const b = () => characterList().find((entry) => entry.chaId === "b");
        b().image = "portrait-b";
        characters.dumpCharImage("b");
        expect(plain(b().ccAssets)).toEqual([{ type: "icon", name: "iconx", uri: "portrait-b", ext: "png" }]);
        expect(records.isFrozenAssetList(b().ccAssets)).toBe(true);
        await sync.flushResources();
        expect(fake.data("characters", "b").ccAssets).toEqual(plain(b().ccAssets));
    });
});
