import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

// The handlers that await a dialog or a save capture their character (and chat) by id before the
// first await and find it again after each one, so a selection change, a reorder, or a deletion
// meanwhile neither redirects the write nor throws. Also the selection by id (`changeChar(chaId)`) and the
// add dialog selecting the character it created, not the last one in the list. Against the real
// save adapter and server store (`storeBackedServer.ts`): character `c` with chats `k` (messages
// A, B, C) and `j`.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        select: vi.fn(),
        selectChar: vi.fn(),
        confirm: vi.fn(),
        moduleSelect: vi.fn(),
        addCharacter: vi.fn(),
        clear: vi.fn(),
    },
}));

vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertSelect: alerts.select,
        alertSelectChar: alerts.selectChar,
        alertConfirm: alerts.confirm,
        alertModuleSelect: alerts.moduleSelect,
        alertAddCharacter: alerts.addCharacter,
        alertClear: alerts.clear,
    }),
);
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn((text: string) => text),
}));
vi.mock("./process/index.svelte", () => ({}));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));

/** A promise the test resolves itself, for a dialog that stays open until the test acts. */
function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

/** Lets the handler run up to its next await. */
const settleMicrotasks = async () => {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
};

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    // `globalApi`, `util`, and `database.svelte` stay real (a `vi.mock` wrapper would outlive
    // `vi.resetModules` and keep the first graph's records); the file dialog, the image store, the
    // picked-file save, and the download are spied on this graph.
    const util = await import("./util");
    const database = await import("./storage/database.svelte");
    const globalApi = await import("./globalApi.svelte");
    const assetQueue = await import("./storage/assetQueue");
    const downloads: { name: string; data: string }[] = [];
    vi.spyOn(globalApi, "downloadFile").mockImplementation((async (name: string, data: Uint8Array | string) => {
        downloads.push({ name, data: typeof data === "string" ? data : Buffer.from(data).toString("utf-8") });
    }) as any);
    const characters = await import("./characters");
    const group = await import("./process/group");
    const modules = await import("./process/modules");
    const cards = await import("./characterCards");
    const d = booted.characterStore.addCharacter({ chaId: "d", name: "D" });
    await booted.sync.flushResources();
    return { ...booted, util, database, assetQueue, characters, group, modules, cards, downloads, d };
}

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./characters");
}, 60_000);

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

describe("selection by id", () => {
    it("changeChar selects another character while a send is running", async () => {
        const { characters, characterStore, selection } = await boot();
        const { anyLocalSend, beginLocalSend, isLocalSend } = await import("./process/localSends");
        characterStore.selectCharacter("c");
        const sending = { chaId: "c", chatId: "running" };
        const release = beginLocalSend(sending)!;

        try {
            await characters.changeChar("d");

            expect(selection.characterId).toBe("d");
            expect(isLocalSend(sending)).toBe(true);
            expect(get(anyLocalSend)).toBe(true);
        } finally {
            release();
        }
    });

    it("changeChar selects the character by its id (also after an earlier one left the list); an unknown id is home", async () => {
        const { characters, characterStore, selection, selectionModule } = await boot();
        const e = characterStore.addCharacter({ chaId: "e", name: "E" });
        await characters.changeChar(e);
        expect(selection.characterId).toBe(e);
        expect(selectionModule.selectedIndex()).toBe(2);
        characterStore.removeCharacter("c");
        expect(selection.characterId).toBe(e);
        expect(selectionModule.selectedIndex()).toBe(1);
        await characters.changeChar("d");
        expect(selection.characterId).toBe("d");
        await characters.changeChar("gone");
        expect(selection.characterId).toBeNull();
        expect(selectionModule.selectedIndex()).toBe(-1);
    });

    it("the add dialog selects the character it created, and nothing when its import added none", async () => {
        const { characters, cards, characterStore, selection } = await boot();
        alerts.addCharacter.mockResolvedValueOnce("createfromScratch");
        await characters.addCharacter();
        const created = selection.characterId!;
        expect(characterStore.characterList().map((entry) => entry.chaId)).toEqual(["c", "d", created]);

        alerts.addCharacter.mockResolvedValueOnce("createGroup");
        await characters.addCharacter();
        expect(characterStore.selectedCharacter()!.type).toBe("group");

        // A failed import: the selection stays where it was (it used to select the last in the list).
        characterStore.selectCharacter(null);
        vi.spyOn(cards, "importCharacter").mockResolvedValueOnce(null);
        alerts.addCharacter.mockResolvedValueOnce("importCharacter");
        await characters.addCharacter();
        expect(selection.characterId).toBeNull();

        vi.spyOn(cards, "importCharacter").mockResolvedValueOnce("d");
        alerts.addCharacter.mockResolvedValueOnce("importCharacter");
        await characters.addCharacter();
        expect(selection.characterId).toBe("d");
    });
});

describe("handlers that await keep their target", () => {
    it("skips a failed member image, saves the loaded members as the group image, and clears the wait", async () => {
        const { characters, characterStore, character, database } = await boot();
        const globalApi = await import("./globalApi.svelte");
        const { alertStore } = await import("./alert");
        characterStore.addCharacter({ chaId: "e", name: "E", image: "e.png" });
        character("c").image = "c.png";
        character("d").image = "d.png";
        const groupId = characters.createNewGroup();
        character(groupId).characters = ["c", "d", "e"];
        characterStore.selectCharacter(groupId);
        vi.spyOn(globalApi, "getFileSrc").mockImplementation(async (loc) => `data:image/png;base64,${loc}`);
        const save = vi.spyOn(database, "saveImage").mockResolvedValue("group.png");
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as any);
        vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AQID");
        const images: ControlledImage[] = [];
        const loading = gate<void>();
        class ControlledImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            src = "";
            crossOrigin = "";
            constructor() {
                images.push(this);
                if (images.length === 3) loading.resolve();
            }
        }
        vi.stubGlobal("Image", ControlledImage);
        let finished = false;
        const work = characters.makeGroupImage().then(() => {
            finished = true;
        });
        await loading.promise;
        expect(alertStore.set).toHaveBeenCalledWith(expect.objectContaining({ type: "wait" }));
        images[0].onload?.();
        images[1].onerror?.();
        images[2].onload?.();
        await vi.advanceTimersByTimeAsync(0);

        expect(finished).toBe(true);
        await work;
        expect(drawImage).toHaveBeenCalledTimes(2);
        expect(drawImage.mock.calls.map(([image]) => image)).toEqual(expect.arrayContaining([images[0], images[2]]));
        expect(save).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
        expect(character(groupId).image).toBe("group.png");
        expect(alerts.clear).toHaveBeenCalledOnce();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("addCharEmotion writes the character it was opened for, though another is selected after the dialog", async () => {
        const { characters, characterStore, util, assetQueue, character, sync, record } = await boot();
        characterStore.selectCharacter("c");
        const dialog = gate<File[]>();
        vi.spyOn(util, "selectMultipleFileHandles").mockReturnValueOnce(dialog.promise);
        vi.spyOn(assetQueue, "savePickedFiles").mockResolvedValue(["img-1"]);
        const running = characters.addCharEmotion("c");
        await settleMicrotasks();
        characterStore.selectCharacter("d");
        dialog.resolve([new File([new Uint8Array([1])], "happy.png")]);
        await running;
        expect(plain(character("c").emotionImages)).toEqual([["happy", "img-1"]]);
        expect(plain(character("d").emotionImages ?? [])).toEqual([]);
        expect(get(characters.addingEmotion)).toBe(false);
        await sync.flushResources();
        expect(record("characters", "c").emotionImages).toEqual([["happy", "img-1"]]);
    });

    it("addCharEmotion stops without an error when its character is deleted during a save", async () => {
        const { characters, characterStore, util, assetQueue, character } = await boot();
        characterStore.selectCharacter("c");
        vi.spyOn(util, "selectMultipleFileHandles").mockResolvedValueOnce([
            new File([new Uint8Array([1])], "one.png"),
            new File([new Uint8Array([2])], "two.png"),
        ]);
        vi.spyOn(assetQueue, "savePickedFiles").mockImplementation(async () => {
            characterStore.removeCharacter("c");
            return ["img-1", "img-2"];
        });
        await expect(characters.addCharEmotion("c")).resolves.toBeUndefined();
        expect(character("c")).toBeUndefined();
        expect(plain(character("d").emotionImages ?? [])).toEqual([]);
        expect(get(characters.addingEmotion)).toBe(false);
    });

    it("exportChat exports the chat it was opened for, though the chats are reordered and another character selected meanwhile", async () => {
        const { characters, characterStore, chat, downloads } = await boot();
        characterStore.selectCharacter("c");
        chat.selectChat("c", "k");
        const dialog = gate<string>();
        alerts.select.mockReturnValueOnce(dialog.promise);
        const running = characters.exportChat("k");
        await settleMicrotasks();
        chat.reorderChats("c", ["j", "k"]);
        characterStore.selectCharacter("d");
        dialog.resolve("0");
        await running;
        expect(alerts.error).not.toHaveBeenCalled();
        expect(downloads).toHaveLength(1);
        expect(downloads[0].name.startsWith("C_")).toBe(true);
        const exported = JSON.parse(downloads[0].data);
        expect(exported.type).toBe("risuChat");
        expect(exported.data.id).toBe("k");
        expect(exported.data.message.map((message: any) => message.data)).toEqual(["A", "B", "C"]);
    });

    it("exportChat exports nothing when its chat is deleted during the dialog", async () => {
        const { characters, characterStore, chat, downloads } = await boot();
        characterStore.selectCharacter("c");
        chat.selectChat("c", "k");
        const dialog = gate<string>();
        alerts.select.mockReturnValueOnce(dialog.promise);
        const running = characters.exportChat("k");
        await settleMicrotasks();
        chat.deleteChat({ chaId: "c", chatId: "k" });
        dialog.resolve("0");
        await running;
        expect(downloads).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("addGroupChar adds the member to the group it was opened for, and stops when the group is deleted meanwhile", async () => {
        const { characters, characterStore, group, character, sync, record } = await boot();
        const g = characters.createNewGroup();
        characterStore.selectCharacter(g);
        const pick = gate<string>();
        alerts.selectChar.mockReturnValueOnce(pick.promise);
        alerts.confirm.mockResolvedValueOnce(false);
        const running = group.addGroupChar();
        await settleMicrotasks();
        characterStore.selectCharacter("c");
        pick.resolve("d");
        await running;
        expect(plain(character(g).characters)).toEqual(["d"]);
        expect(character(g).characterActive).toHaveLength(1);
        await sync.flushResources();
        expect(record("characters", g).characters).toEqual(["d"]);

        // Deleted during the member dialog, then during the first-message confirmation.
        for (const during of ["pick", "confirm"] as const) {
            const h = characters.createNewGroup();
            characterStore.selectCharacter(h);
            const pickH = gate<string>();
            const confirmH = gate<boolean>();
            alerts.selectChar.mockReturnValueOnce(pickH.promise);
            alerts.confirm.mockReturnValueOnce(confirmH.promise);
            const runningH = group.addGroupChar();
            await settleMicrotasks();
            if (during === "pick") {
                characterStore.removeCharacter(h);
            }
            pickH.resolve("c");
            await settleMicrotasks();
            if (during === "confirm") {
                characterStore.removeCharacter(h);
            }
            confirmH.resolve(true);
            await expect(runningH).resolves.toBeUndefined();
            expect(character(h)).toBeUndefined();
        }
        expect(plain(character(g).characters)).toEqual(["d"]);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("applyModule applies to the character selected when its dialog opened, and to none once that one is deleted", async () => {
        const { characterStore, collectionStore, modules, character, sync, record } = await boot();
        const lore = { key: "m", comment: "from module", content: "module lore", mode: "normal", insertorder: 100 };
        const moduleId = collectionStore.addModule({ name: "M", description: "", id: "mod-m", lorebook: [lore] });
        characterStore.selectCharacter("c");
        const dialog = gate<string>();
        alerts.moduleSelect.mockReturnValueOnce(dialog.promise);
        const running = modules.applyModule();
        await settleMicrotasks();
        characterStore.selectCharacter("d");
        dialog.resolve(moduleId);
        await running;
        expect(plain(character("c").globalLore).map((entry: any) => entry.content)).toEqual(["module lore"]);
        expect(plain(character("d").globalLore ?? [])).toEqual([]);
        await sync.flushResources();
        expect(record("characters", "c").globalLore.map((entry: any) => entry.content)).toEqual(["module lore"]);

        const again = gate<string>();
        alerts.moduleSelect.mockReturnValueOnce(again.promise);
        const second = modules.applyModule();
        await settleMicrotasks();
        characterStore.removeCharacter("d");
        again.resolve(moduleId);
        await expect(second).resolves.toBeUndefined();
        expect(plain(character("c").globalLore)).toHaveLength(1);
    });
});
