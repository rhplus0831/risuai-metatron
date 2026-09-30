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

vi.mock("./storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));
vi.mock("./alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: alerts.confirm,
    alertAddCharacter: vi.fn(),
    alertSelect: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: vi.fn(),
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", removeConfirm: "?", removeConfirm2: "?" },
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

type Sync = typeof import("./storage/resourceSync.svelte");
type Client = typeof import("./storage/resourceClient");
type Stores = typeof import("./stores.svelte");
type Characters = typeof import("./characters");
type Bootstrap = typeof import("./bootstrap");

function character(chaId: string, name: string, extra: Record<string, unknown> = {}) {
    return { chaId, name, type: "character", chats: [], chatPage: 0, ...extra };
}

async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    // The residual root as the client writes it (`RESIDUAL_ROOT_KEYS` only); the character order is
    // a collection record of its own.
    fake.set("root", "main", { username: "u", botPresetsId: 0 });
    fake.set("characterOrder", "main", ["a", "b"]);
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", character("a", "Alice"));
    fake.set("characters", "b", character("b", "Bob"));
    await materialize(fake);
    server.current = fake;

    const stores: Stores = await import("./stores.svelte");
    const client: Client = await import("./storage/resourceClient");
    const sync: Sync = await import("./storage/resourceSync.svelte");
    const characters: Characters = await import("./characters");
    const bootstrap: Bootstrap = await import("./bootstrap");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    stores.DBState.db = bootstrap.assembleDatabase(snapshot);
    stores.selectedCharID.set(-1);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    return { fake, stores, sync, characters, db: () => stores.DBState.db as any };
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
        const { fake, sync, characters, db } = await boot();
        await characters.removeChar("b", "Bob", "normal");
        expect(db().characters[1].trashTime).toEqual(expect.any(Number));
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toEqual(expect.any(Number));
        expect(fake.data("characterOrder", "main")).toEqual(["a"]);
    });

    it("saves a restore from the trash, so the character is not deleted by a later boot", async () => {
        const { fake, sync, characters, db } = await boot();
        await characters.removeChar("b", "Bob", "normal");
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toEqual(expect.any(Number));

        characters.restoreChar("b");
        expect(db().characters[1].trashTime).toBeUndefined();
        await sync.flushResources();
        expect(fake.data("characters", "b").trashTime).toBeUndefined();
        expect(fake.data("characterOrder", "main")).toEqual(["a", "b"]);
    });
});
