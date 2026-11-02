import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import type { Chat } from "../../shared/database.ts";
import { MEMORY_RESTORE_BODY_BYTES, type StructuredMemoryFileRecords } from "../../shared/structuredMemory.ts";
import { bootMutations, plain } from "./storage/tests/mutationStoresHarness";

// `importChat` writes the character selected when the dialog opened, captured by id,
// over the real save adapter and the real server store (`storeBackedServer.ts`). A `jsonl` chat and a
// `risuChat` v2 file with folders land in that character after the selection moved, after the list
// was reordered, and after the record was replaced under the same id (the name substitution and the
// folder collision check read the record as it is when the file arrives). The folders are written
// with `updateCharacter` and reach the server with the chats. `changeChatTo(0)` runs only while that
// character is still selected, so another character's chat selection never moves. A target deleted
// while the dialog was open answers `errors.importTargetGone` and writes nothing.

const { server, alerts, picker } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        select: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
    /** What the next `selectSingleFile` answers with; a test's answer runs its "while the dialog is open" step first. */
    picker: { answer: async (): Promise<{ name: string; data: Uint8Array } | null> => null },
}));

vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertSelect: alerts.select,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: alerts.confirm,
        alertStore: alerts.store,
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
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

const jsonl = () => ({
    name: "chat.jsonl",
    data: new TextEncoder().encode(
        [
            JSON.stringify({ user_name: "u", character_name: "c" }),
            JSON.stringify({ name: "u", is_user: true, mes: "hello {{char}}, I am {{user}}" }),
            JSON.stringify({ name: "c", is_user: false, mes: "<char> answers" }),
        ].join("\n"),
    ),
});
const chatV2 = (name: string, folderId: string | null, text: string) => ({
    name,
    message: [{ role: "user", data: text }],
    note: "",
    localLore: [],
    folderId,
    fmIndex: -1,
});
/** A `risuChat` v2 export with two folders: `f1` collides with Alpha's folder, `f2` is new. */
const v2 = () => ({
    name: "chats.json",
    data: encode({
        type: "risuChat",
        ver: 2,
        folders: [
            { id: "f1", name: "Dup", color: "", folded: false },
            { id: "f2", name: "New", color: "", folded: false },
        ],
        data: [chatV2("In f1", "f1", "one"), chatV2("In f2", "f2", "two"), chatV2("Loose", null, "three")],
    }),
});
const folder = (id: string, name: string) => ({ id, name, color: "", folded: false });

/**
 * Boots the harness with Alpha (one chat `a1`, a folder `f1`) selected and Beta (chats `b1`, `b2`, the
 * second one selected), and loads `characters.ts` on that graph.
 */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, chat, selectionModule, characterList, sync, fake } = booted;
    const index = (chaId: string) => characterList().findIndex((entry: any) => entry?.chaId === chaId);
    const alpha = characterStore.addCharacter({
        type: "character",
        name: "Alpha",
        chatFolders: [folder("f1", "Alpha folder")],
        chats: [{ id: "a1", name: "A1", message: [], note: "", localLore: [] }],
    });
    const beta = characterStore.addCharacter({
        type: "character",
        name: "Beta",
        chats: [
            { id: "b1", name: "B1", message: [], note: "", localLore: [] },
            { id: "b2", name: "B2", message: [], note: "", localLore: [] },
        ],
    });
    chat.selectChat(beta, "b2");
    selectionModule.selectCharacter(alpha);
    await sync.flushResources();
    fake.requests.length = 0;
    // `globalApi` and `util` stay real (a `vi.mock` wrapper would outlive `vi.resetModules` and keep
    // the first graph's records, so `changeChatTo` would look at a stale selection); the file dialog
    // is spied on this graph's `util`.
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    vi.spyOn(util, "selectSingleFile").mockImplementation(() => picker.answer() as any);
    const globalApi = await import("./globalApi.svelte");
    const downloads: { name: string; data: string }[] = [];
    vi.spyOn(globalApi, "downloadFile").mockImplementation(async (name, data) => {
        downloads.push({
            name,
            data: typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8"),
        });
    });
    const characters = await import("./characters");
    const binding = await import("./storage/chatBinding.svelte");
    const select = (chaId: string) => selectionModule.selectCharacter(chaId);
    const chatsOf = (chaId: string) => plain(booted.character(chaId).chats) as any[];
    const texts = (chaId: string, at: number) => chatsOf(chaId)[at].message.map((message: any) => message.data);
    /** Runs `importChat` with `file`, after `during` ran while the dialog was open. */
    const run = async (
        file: { name: string; data: Uint8Array } | null,
        during: () => Promise<void> | void = () => {},
    ) => {
        picker.answer = async () => {
            await during();
            return file;
        };
        await characters.importChat();
    };
    return { ...booted, characters, binding, alpha, beta, index, select, chatsOf, texts, run, downloads };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
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
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importChat writes the character selected when the dialog opened", () => {
    it("a jsonl chat lands at the top of that character, substitutes its name, and selects it while it is still on screen", async () => {
        const { run, alpha, chatsOf, texts, character, sync, fake, activePersona } = await boot();
        await run(jsonl());
        expect(chatsOf(alpha).map((chat: any) => chat.name)).toEqual(["Imported Chat", "A1"]);
        expect(texts(alpha, 0)).toEqual([`hello Alpha, I am ${activePersona.name}`, "Alpha answers"]);
        expect(chatsOf(alpha)[0].id).toMatch(UUID_V4);
        expect(chatsOf(alpha)[0].folderId).toBeNull();
        // Still selected: the imported chat is the current one.
        expect(character(alpha).chatPage).toBe(0);
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(fake.texts(alpha, chatsOf(alpha)[0].id)).toEqual(texts(alpha, 0));
        expect(fake.order(alpha)).not.toBeNull();
    });

    it("after the selection moved to another character, the chat still lands in the captured one and no selection moves", async () => {
        const { run, alpha, beta, select, chatsOf, texts, character, selectionModule, index, sync, fake } =
            await boot();
        await run(jsonl(), () => select(beta));
        expect(chatsOf(alpha).map((chat: any) => chat.name)).toEqual(["Imported Chat", "A1"]);
        expect(texts(alpha, 0)[1]).toBe("Alpha answers");
        expect(chatsOf(beta).map((chat: any) => chat.name)).toEqual(["B1", "B2"]);
        // Beta keeps its second chat selected; Alpha (not on screen) keeps its old chat, now at index 1.
        expect(character(beta).chatPage).toBe(1);
        expect(character(alpha).chatPage).toBe(1);
        expect(selectionModule.selectedIndex()).toBe(index(beta));
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        await sync.flushResources();
        expect(fake.texts(alpha, chatsOf(alpha)[0].id)).toEqual(texts(alpha, 0));
        expect(fake.chat(beta, "b1")).not.toBeNull();
        expect(fake.chat(beta, "b2")).not.toBeNull();
    });

    it("a v2 file with folders: a colliding folder is re-keyed, a new one kept, the folders are written through updateCharacter and saved with the chats", async () => {
        const { run, alpha, beta, select, chatsOf, character, sync, fake, record } = await boot();
        await run(v2(), () => select(beta));
        const folders = plain(character(alpha).chatFolders) as any[];
        expect(folders.map((entry) => entry.name)).toEqual(["Alpha folder", "Dup", "New"]);
        expect(folders[0].id).toBe("f1");
        expect(folders[1].id).toMatch(UUID_V4);
        expect(folders[2].id).toBe("f2");
        const chats = chatsOf(alpha);
        expect(chats.map((chat: any) => chat.name)).toEqual(["In f1", "In f2", "Loose", "A1"]);
        expect(chats[0].folderId).toBe(folders[1].id);
        expect(chats[1].folderId).toBe("f2");
        expect(chats[2].folderId).toBeNull();
        expect(chats.slice(0, 3).every((chat: any) => UUID_V4.test(chat.id))).toBe(true);
        expect(character(beta).chatFolders).toBeUndefined();
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        await sync.flushResources();
        // Alpha is not selected: the folder write reaches the server as its record's own write.
        expect(record("characters", alpha).chatFolders).toEqual(folders);
        for (const chat of chats) {
            expect(fake.chat(alpha, chat.id)?.data.name).toBe(chat.name);
        }
        expect(record("characters", beta).chatFolders).toBeUndefined();
    });

    it("a character list changed around the target (an earlier character removed) does not redirect the write", async () => {
        const { run, alpha, beta, characterStore, chatsOf, characterList, index } = await boot();
        const opened = index(alpha);
        await run(jsonl(), () => {
            // The list is in creation order and changes only through the character module: the
            // harness's `c`, before Alpha, is removed, so the index Alpha had when the dialog opened
            // now names Beta.
            characterStore.removeCharacter("c");
        });
        expect(index(alpha)).toBe(opened - 1);
        expect(characterList()[opened].chaId).toBe(beta);
        expect(chatsOf(alpha).map((chat: any) => chat.name)).toEqual(["Imported Chat", "A1"]);
        for (const entry of characterList() as any[]) {
            if (entry.chaId !== alpha) {
                expect(plain(entry.chats).some((chat: any) => chat.name === "Imported Chat")).toBe(false);
            }
        }
    });

    it("a record replaced under the same id while the dialog was open: the name and the folders are read from the replacement", async () => {
        const { run, alpha, characterStore, chatsOf, texts, character } = await boot();
        await run(jsonl(), () => {
            characterStore.replaceCharacterFields({ chaId: alpha, type: "character", name: "Renamed" });
        });
        expect(texts(alpha, 0)[1]).toBe("Renamed answers");

        await run(v2(), () => {
            // Now `f2` is the folder Alpha has and `f1` is free.
            characterStore.updateCharacter(alpha, { chatFolders: [folder("f2", "Taken")] });
        });
        const folders = plain(character(alpha).chatFolders) as any[];
        expect(folders.map((entry) => entry.name)).toEqual(["Taken", "Dup", "New"]);
        expect(folders[1].id).toBe("f1");
        expect(folders[2].id).toMatch(UUID_V4);
        expect(folders[2].id).not.toBe("f2");
        const chats = chatsOf(alpha);
        expect(chats[0].folderId).toBe("f1");
        expect(chats[1].folderId).toBe(folders[2].id);
    });

    it("a target deleted while the dialog was open answers importTargetGone and writes nothing", async () => {
        const { run, alpha, characterStore, sync, mirrorText, serverText, fake, characterList } = await boot();
        let mirror = "";
        let serverBefore = "";
        let batches = 0;
        await run(v2(), async () => {
            expect(characterStore.removeCharacter(alpha)).toBe(true);
            await sync.flushResources();
            mirror = mirrorText();
            serverBefore = serverText();
            batches = fake.batchCount();
        });
        expect(alerts.error).toHaveBeenCalledWith(language.errors.importTargetGone);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(serverText()).toBe(serverBefore);
        expect(fake.batchCount()).toBe(batches);
        expect(characterList().some((entry: any) => entry.chaId === alpha)).toBe(false);
        expect(fake.record("characters", alpha)).toBeNull();
    });

    it("with no character selected the dialog does not open", async () => {
        const { characters, selectionModule } = await boot();
        selectionModule.selectCharacter(null);
        const opened = vi.fn(async () => null);
        picker.answer = opened;
        await characters.importChat();
        expect(opened).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });
});

// Every import format passes `importChat`'s `addChats`, which prepares each chat's binding
// (`importedChatBinding`) before `createChat`: the ids that name a prompt preset, model preset, or
// persona here are kept, the others (gone, padded, blank, not a string) dropped, and
// `bindingReview: true` set (an imported `false` overwritten), so the chat is blocked until the
// user confirms it. The saved chat on the server carries the same fields.
describe("importChat prepares each imported chat's binding", () => {
    it("saves imported toggle preset links only when they exist locally, preserving each chat's toggle values", async () => {
        const { run, alpha, chatsOf, settings, sync, fake } = await boot();
        settings.togglePresets = [
            { id: "local-toggle", name: "Local", values: {}, kinds: {}, createdAt: 0, updatedAt: 0 },
        ];
        const inputs = ["local-toggle", "missing-toggle", null, 7, undefined].map((togglePresetId, index) => ({
            ...chatV2(`Imported ${index}`, null, `Message ${index}`),
            togglePresetId,
            GLGlobalVariables: { toggle_title: `Imported text ${index}`, toggle_flag: "0" },
        }));
        await run({ name: "chats.json", data: encode({ type: "risuAllChats", ver: 2, folders: [], data: inputs }) });
        const imported = chatsOf(alpha).slice(0, inputs.length);
        expect(imported).toHaveLength(inputs.length);
        await sync.flushResources();
        for (const [index, chat] of imported.entries()) {
            const stored = fake.chat(alpha, chat.id)!.data;
            for (const copy of [chat, stored]) {
                expect(copy.GLGlobalVariables).toEqual(inputs[index].GLGlobalVariables);
                if (index === 0) expect(copy.togglePresetId).toBe("local-toggle");
                else expect(copy).not.toHaveProperty("togglePresetId");
            }
        }
    });

    /** The ids of the records the harness holds: the first prompt preset, model preset, and persona. */
    const existing = (booted: Awaited<ReturnType<typeof boot>>) => ({
        promptPresetId: booted.settings.presets[0].id as string,
        modelPresetId: booted.settings.modelPresets[0].id as string,
        bindedPersona: booted.activePersona.id as string,
    });
    const chatWith = (name: string, fields: Record<string, unknown>) => ({
        name,
        message: [{ role: "user", data: `${name} text` }],
        note: "a note",
        localLore: [],
        fmIndex: -1,
        ...fields,
    });
    const file = (name: string, value: unknown) => ({ name, data: encode(value) });
    /** The binding fields of a chat as the mirror and the server hold them. */
    const fieldsOf = (chat: Record<string, unknown>) => {
        const picked: Record<string, unknown> = {};
        for (const key of ["modelPresetId", "promptPresetId", "bindedPersona", "bindingReview"]) {
            if (key in chat) {
                picked[key] = chat[key];
            }
        }
        return picked;
    };
    /** The imported chats' fields, in the mirror and on the server after a flush (the top `count` chats). */
    const saved = async (booted: Awaited<ReturnType<typeof boot>>, count: number) => {
        const chats = booted.chatsOf(booted.alpha).slice(0, count);
        await booted.sync.flushResources();
        return chats.map((chat: any) => {
            const stored = booted.fake.chat(booted.alpha, chat.id)!.data as unknown as Record<string, unknown>;
            expect(fieldsOf(stored)).toEqual(fieldsOf(chat));
            expect(booted.binding.chatBinding({ chaId: booted.alpha, chatId: chat.id })).toMatchObject({ ok: false });
            return fieldsOf(chat);
        });
    };

    it("a jsonl chat (no ids) waits for the confirmation", async () => {
        const booted = await boot();
        await booted.run(jsonl());
        expect(await saved(booted, 1)).toEqual([{ bindingReview: true }]);
        expect(booted.binding.chatBinding({ chaId: booted.alpha, chatId: booted.chatsOf(booted.alpha)[0].id })).toEqual(
            {
                ok: false,
                problems: [
                    { field: "modelPresetId", reason: "unset" },
                    { field: "promptPresetId", reason: "unset" },
                    { field: "personaId", reason: "unset" },
                    { field: "review" },
                ],
            },
        );
    });

    it("a risuAllChats v2 file: existing ids kept with an imported false overwritten, gone, padded, blank, and non-string ids dropped", async () => {
        const booted = await boot();
        const ids = existing(booted);
        await booted.run(
            file("chats.json", {
                type: "risuAllChats",
                ver: 2,
                folders: [],
                data: [
                    chatWith("Full", { ...ids, bindingReview: false }),
                    chatWith("Gone", {
                        modelPresetId: "m-gone",
                        promptPresetId: ` ${ids.promptPresetId} `,
                        bindedPersona: "",
                    }),
                    chatWith("Odd", { modelPresetId: 7, promptPresetId: ids.promptPresetId, bindedPersona: null }),
                    chatWith("Bare", {}),
                ],
            }),
        );
        expect(booted.chatsOf(booted.alpha).map((chat: any) => chat.name)).toEqual([
            "Full",
            "Gone",
            "Odd",
            "Bare",
            "A1",
        ]);
        expect(await saved(booted, 4)).toEqual([
            { ...ids, bindingReview: true },
            { bindingReview: true },
            { promptPresetId: ids.promptPresetId, bindingReview: true },
            { bindingReview: true },
        ]);
        expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
        // Confirmed by the user, the fully bound one sends.
        const full = booted.chatsOf(booted.alpha)[0].id;
        booted.binding.chatBindingPatch({ chaId: booted.alpha, chatId: full }, { review: false });
        expect(booted.binding.chatBinding({ chaId: booted.alpha, chatId: full })).toMatchObject({ ok: true });
    });

    it("a risuChat v2 file with one chat", async () => {
        const booted = await boot();
        const ids = existing(booted);
        await booted.run(
            file("chat.json", {
                type: "risuChat",
                ver: 2,
                data: chatWith("One", { modelPresetId: ids.modelPresetId, bindedPersona: "u-gone" }),
            }),
        );
        expect(await saved(booted, 1)).toEqual([{ modelPresetId: ids.modelPresetId, bindingReview: true }]);
    });

    it("a risuAllChats v1 file", async () => {
        const booted = await boot();
        const ids = existing(booted);
        await booted.run(
            file("all.json", {
                type: "risuAllChats",
                ver: 1,
                data: [
                    chatWith("V1 full", { ...ids, bindingReview: false }),
                    chatWith("V1 gone", { modelPresetId: "m-gone", promptPresetId: "p-gone", bindedPersona: "u-gone" }),
                ],
            }),
        );
        expect(booted.chatsOf(booted.alpha).map((chat: any) => chat.name)).toEqual(["V1 full", "V1 gone", "A1"]);
        expect(await saved(booted, 2)).toEqual([{ ...ids, bindingReview: true }, { bindingReview: true }]);
    });

    it("a risuChat v1 file", async () => {
        const booted = await boot();
        const ids = existing(booted);
        await booted.run(
            file("one.json", {
                type: "risuChat",
                ver: 1,
                data: chatWith("Single", { promptPresetId: ids.promptPresetId, bindedPersona: ids.bindedPersona }),
            }),
        );
        expect(await saved(booted, 1)).toEqual([
            { promptPresetId: ids.promptPresetId, bindedPersona: ids.bindedPersona, bindingReview: true },
        ]);
    });

    it("an html export", async () => {
        const booted = await boot();
        const ids = existing(booted);
        const chat = chatWith("Html", { ...ids, promptPresetId: "p-gone", bindingReview: false });
        const html = `<html><body><div class="idat">${JSON.stringify(chat)}</div></body></html>`;
        await booted.run({ name: "chat.html", data: new TextEncoder().encode(html) });
        expect(booted.chatsOf(booted.alpha)[0].name).toBe("Html");
        expect(await saved(booted, 1)).toEqual([
            { modelPresetId: ids.modelPresetId, bindedPersona: ids.bindedPersona, bindingReview: true },
        ]);
    });
});

/** Memory HTTP is scripted only in these tests; the real save adapter and server chat store remain in use. */
function serveMemory(
    booted: Awaited<ReturnType<typeof boot>>,
    answer: (chatId: string, route: string, init?: RequestInit) => Response | Promise<Response>,
) {
    const requests: { chatId: string; route: string; body: unknown; saved: unknown }[] = [];
    server.current = {
        close: () => booted.fake.close(),
        fetch: (path: string, init?: RequestInit) => {
            const match = new URL(path, "http://test").pathname.match(
                /^\/api\/memory\/structured\/([^/]+)\/([^/]+)(?:\/(.*))?$/,
            );
            if (!match) return booted.fake.fetch(path, init);
            const chatId = decodeURIComponent(match[2]);
            const route = match[3] ?? "";
            requests.push({
                chatId,
                route,
                body: init?.body ? JSON.parse(init.body as string) : null,
                saved: plain(booted.fake.chat(decodeURIComponent(match[1]), chatId)),
            });
            return answer(chatId, route, init);
        },
    };
    return requests;
}

function fileRecords(id: string): StructuredMemoryFileRecords {
    return {
        pages: [
            {
                id: `page-${id}`,
                type: "location",
                title: `Place ${id}`,
                aliases: [],
                contextMode: "auto",
                sections: [
                    {
                        heading: "Facts",
                        body: `Body ${id}`,
                        provenance: [`event-${id}`],
                        sources: [],
                        locked: false,
                        updatedAt: 1,
                    },
                ],
                links: [],
                retrieval: { keywords: [] },
                history: [],
            },
        ],
        events: [
            {
                id: `event-${id}`,
                title: `Event ${id}`,
                summary: `Summary ${id}`,
                status: "active",
                participants: [],
                storyTime: { text: "Morning" },
                keyLines: [],
                stateChanges: [],
                knowledge: [],
                relationshipShifts: [],
                openThreads: { add: [], close: [], transitions: [] },
                sources: [],
                writerRun: "private-run",
                createdRevision: 7,
            },
        ],
        threads: [{ id: `thread-${id}`, title: `Return ${id}`, who: [], state: "open" }],
    };
}
const pausedChat = (id: string): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    fmIndex: -1,
    hypaV3Data: { summaries: [{ text: "Real HypaV3 summary", chatMemos: ["m0"], isImportant: false }] },
    message: [0, 1].map((i) => ({
        chatId: `${id}-m${i}`,
        role: "char",
        data: `Message ${i}`,
        generationInfo: {
            model: "story-model",
            generationId: `generation-${i}`,
            memory: { state: "skipped", reason: "writerPaused", pages: [], refused: [], unverified: [], warnings: [] },
        },
    })),
});
function memoryRead(records: StructuredMemoryFileRecords, route: string, runs: unknown[] = []) {
    return Response.json(
        route === "package"
            ? { revision: "r", pages: records.pages, events: records.events, next: null }
            : route === "threads"
              ? { revision: "r", threads: records.threads, next: null }
              : { revision: "r", ...records, runs },
    );
}

it.each(["structuredMemory", "hypaMemoryV3"])(
    "exports JSON and HTML under %s with only the applicable projection and receipts removed",
    async (algorithm) => {
        const b = await boot();
        b.settings.ui.memoryAlgorithmType = algorithm;
        const input = pausedChat("exported");
        b.chat.createChat(b.alpha, input);
        await b.sync.flushResources();
        const records = fileRecords(input.id!);
        serveMemory(b, (_chatId, route) =>
            memoryRead(records, route, [{ id: "private-run", input: "PRIVATE PROMPT" }]),
        );
        for (const mode of ["0", "2"]) {
            alerts.select.mockResolvedValueOnce(mode);
            if (mode === "2") alerts.select.mockResolvedValueOnce("1").mockResolvedValueOnce("0");
            await b.characters.exportChat(input.id!);
            expect(b.downloads).toHaveLength(mode === "0" ? 1 : 2);
            const text = b.downloads.at(-1)!.data;
            const envelope = mode === "0" ? JSON.parse(text) : null;
            const exported = envelope
                ? envelope.data
                : JSON.parse(new DOMParser().parseFromString(text, "text/html").querySelector(".idat")!.textContent!);
            if (envelope) {
                expect(envelope).toMatchObject({
                    type: "risuChat",
                    ver: 2,
                    structuredMemory: [{ chatId: input.id, ...records }],
                });
                expect(envelope.data).not.toHaveProperty("structuredMemory");
                expect(envelope.structuredMemory[0]).not.toHaveProperty("runs");
            }
            if (algorithm === "structuredMemory") expect(exported).not.toHaveProperty("hypaV3Data");
            else expect(exported.hypaV3Data).toEqual(input.hypaV3Data);
            expect(exported.message.map((message: any) => message.generationInfo)).toEqual([
                { model: "story-model", generationId: "generation-0" },
                { model: "story-model", generationId: "generation-1" },
            ]);
            expect(text).not.toContain("PRIVATE PROMPT");
        }
        expect(plain(b.chat.findChat({ chaId: b.alpha, chatId: input.id! }))).toMatchObject(input);
        expect(b.fake.chat(b.alpha, input.id!)!.data).toMatchObject(input);
    },
);

it("exports all chats with an entry for pages, events or threads, stripping receipts even from run-only chats", async () => {
    const b = await boot();
    b.settings.ui.memoryAlgorithmType = "structuredMemory";
    const kinds = ["pages", "events", "threads", "runs", "empty"] as const;
    const inputs = kinds.map(pausedChat);
    for (const input of inputs) b.chat.createChat(b.alpha, input);
    await b.sync.flushResources();
    const entries = kinds.slice(0, 3).map((kind) => ({
        chatId: kind,
        pages: [],
        events: [],
        threads: [],
        [kind]: fileRecords(kind)[kind as keyof StructuredMemoryFileRecords],
    }));
    serveMemory(b, (chatId, route) =>
        memoryRead(
            entries.find((entry) => entry.chatId === chatId) ?? { pages: [], events: [], threads: [] },
            route,
            chatId === "runs" ? [{ id: "private-run", input: "PRIVATE PROMPT" }] : [],
        ),
    );
    await b.characters.exportAllChats();
    expect(b.downloads).toHaveLength(1);
    const file = JSON.parse(b.downloads[0].data);
    expect(file).toMatchObject({ type: "risuAllChats", ver: 2 });
    expect(file.structuredMemory).toHaveLength(3);
    expect(file.structuredMemory).toEqual(expect.arrayContaining(entries));
    for (const input of inputs) {
        const exported = file.data.find((chat: Chat) => chat.id === input.id);
        expect(exported).not.toHaveProperty("structuredMemory");
        if (["pages", "events", "threads"].includes(input.id!)) expect(exported).not.toHaveProperty("hypaV3Data");
        else expect(exported.hypaV3Data).toEqual(input.hypaV3Data);
        expect(exported.message.map((message: any) => message.generationInfo)).toEqual(
            input.id === "empty"
                ? input.message.map((message) => message.generationInfo)
                : [
                      { model: "story-model", generationId: "generation-0" },
                      { model: "story-model", generationId: "generation-1" },
                  ],
        );
    }
    expect(b.downloads[0].data).not.toContain("PRIVATE PROMPT");
    expect(alerts.normal).toHaveBeenCalledWith(language.successExport);
    expect(alerts.error).not.toHaveBeenCalled();
});

it("downloads chats after a partial memory read fails and replaces the success notice while other chats still export", async () => {
    const b = await boot();
    b.settings.ui.memoryAlgorithmType = "structuredMemory";
    const input = pausedChat("failed");
    b.chat.createChat(b.alpha, input);
    await b.sync.flushResources();
    serveMemory(b, (chatId, route) =>
        chatId === "failed" && route === "threads"
            ? Response.json({ error: "Offline" }, { status: 503 })
            : memoryRead(fileRecords(chatId), route),
    );
    alerts.select.mockResolvedValueOnce("0");
    await b.characters.exportChat(input.id!);
    expect(b.downloads).toHaveLength(1);
    const single = JSON.parse(b.downloads[0].data);
    expect(single.data).toMatchObject(input);
    expect(single).not.toHaveProperty("structuredMemory");
    expect(alerts.error).toHaveBeenCalledExactlyOnceWith(language.structuredMemory.memoryFile.exportedWithoutRecords);
    expect(alerts.normal).not.toHaveBeenCalled();
    alerts.error.mockClear();
    await b.characters.exportAllChats();
    expect(b.downloads).toHaveLength(2);
    const all = JSON.parse(b.downloads[1].data);
    expect(all.data.find((chat: Chat) => chat.id === "failed")).toMatchObject(input);
    expect(all.structuredMemory).toEqual([{ chatId: "a1", ...fileRecords("a1") }]);
    expect(alerts.error).toHaveBeenCalledExactlyOnceWith(
        language.structuredMemory.memoryFile.allExportedWithoutRecords(1),
    );
    expect(alerts.normal).not.toHaveBeenCalled();
});

it("imports each file entry by its old chat id after saving new chats, regardless of algorithm, and skips legacy files", async () => {
    const b = await boot();
    b.settings.ui.memoryAlgorithmType = "hypaMemoryV3";
    const requests = serveMemory(b, () => Response.json({ revision: "restored", restored: true }));
    const inputs = ["first", "second"].map((id) => ({
        ...chatV2(id, null, id),
        id,
        message: [{ chatId: `${id}-message`, role: "char", data: id }],
    }));
    await b.run({
        name: "memory.json",
        data: encode({
            type: "risuAllChats",
            ver: 2,
            data: inputs,
            structuredMemory: [
                { chatId: "second", ...fileRecords("second") },
                { chatId: "first", ...fileRecords("first") },
            ],
        }),
    });
    await b.sync.flushResources();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    for (const [index, input] of inputs.entries()) {
        const imported = b.chatsOf(b.alpha)[index];
        expect(imported.id).toMatch(UUID_V4);
        expect(imported.id).not.toBe(input.id);
        expect(imported.message).toEqual(input.message);
        expect(requests[index]).toMatchObject({
            chatId: imported.id,
            route: "restore",
            body: fileRecords(input.id),
            saved: { data: { id: imported.id, message: input.message } },
        });
        expect(b.fake.chat(b.alpha, imported.id)!.data).not.toHaveProperty("structuredMemory");
    }
    expect(alerts.error).not.toHaveBeenCalled();
    await b.run({
        name: "old.json",
        data: encode({ type: "risuChat", ver: 2, data: { ...inputs[0], id: "legacy", name: "Legacy" } }),
    });
    await b.sync.flushResources();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);
    expect(b.chatsOf(b.alpha)[0].name).toBe("Legacy");
});

it("keeps all imported chats and reports refused, unrestored and oversized records once without stopping later restores", async () => {
    const b = await boot();
    b.settings.ui.memoryAlgorithmType = "hypaMemoryV3";
    const inputs = ["Refused", "Not restored", "Oversized", "Healthy"].map((id) => ({ ...chatV2(id, null, id), id }));
    const responses = [
        () => Response.json({ reason: "fenced" }, { status: 409 }),
        () => Response.json({ revision: "busy", restored: false }),
        () => Response.json({ error: "Body too large" }, { status: 413 }),
        () => Response.json({ revision: "restored", restored: true }),
    ];
    const requests = serveMemory(b, () => responses.shift()!());
    await b.run({
        name: "memory.json",
        data: encode({
            type: "risuAllChats",
            ver: 2,
            data: inputs,
            structuredMemory: inputs.map(({ id }) => ({ chatId: id, ...fileRecords(id) })),
        }),
    });
    await b.sync.flushResources();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)!.body).toEqual(fileRecords("Healthy"));
    const imported = b.chatsOf(b.alpha).slice(0, 4);
    expect(imported.map((chat) => chat.name)).toEqual(inputs.map((chat) => chat.name));
    for (const chat of imported) expect(b.fake.chat(b.alpha, chat.id)!.data.name).toBe(chat.name);
    expect(alerts.error).toHaveBeenCalledExactlyOnceWith(
        [
            language.structuredMemory.memoryFile.restoreFailed("Refused, Not restored"),
            language.structuredMemory.memoryFile.restoreTooLarge(
                "Oversized",
                MEMORY_RESTORE_BODY_BYTES / (1024 * 1024),
            ),
        ].join("\n\n"),
    );
    expect(alerts.normal).toHaveBeenCalledWith(language.successImport);
});
