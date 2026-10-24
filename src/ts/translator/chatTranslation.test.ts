import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";
import { warmModules } from "../storage/tests/mutationStoresHarness";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// A chat's translation settings on the tab (`src/ts/translator/chatTranslation.svelte.ts`), over
// the chat module booted from summaries against the real server store (nothing loaded, as
// `chatBindingNewChat.test.ts` boots it). Covered:
// - the readers resolve from the list entry: `chatTranslationSettings` (defaults for a chat without
//   the fields and for a non-member), `chatAutoTranslate` (the flag only while a target language is
//   set), `chatTranslatorPreset` (the chat's own, the global one, a deleted one as `missing`),
//   `currentTranslatorPreset` (the selected chat's, also while it is still loading; the global one at
//   home), each tracked;
// - `setChatTranslationSettings` on an unloaded chat changes its list entry, queues one `meta` op
//   (`null` unsets), the server's summary carries the fields, and a load while that op is pending
//   keeps the local value (`SUMMARY_FIELD_TYPES`), with the idle refresh converging after;
// - `initialChatTranslation`: under inherit the six fields of the character's selected chat as stored
//   (unloaded without a read, or loaded), a deleted preset id and typed-but-invalid values included,
//   wrong types left out; `empty`, a character without chats, or an unknown one give nothing; the
//   read is untracked; the created chat carries the fields to the server and is the next source;
// - `importedChatTranslation` drops a `translatorPresetId` that names no preset here (or is blank or
//   not a string), keeps the other fields as imported, mutates the object, and reads nothing.

const serverHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("../storage/serverAuth", () => ({
    authFetch: async (path: string, init?: RequestInit) => serverHolder.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

type ChatModule = typeof import("../storage/chatStore.svelte");
type TranslationModule = typeof import("./chatTranslation.svelte");
type ViewsModule = typeof import("../storage/settingsViews.svelte");
type SelectionModule = typeof import("../storage/selection.svelte");

const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
const ref = (chatId: string, chaId = "c") => ({ chaId, chatId });
const TP1 = createTranslatorPreset("Global one", { id: "tp1", prompt: "One {{slot::content}}" });
const TP2 = createTranslatorPreset("Chat two", { id: "tp2", prompt: "Two {{slot::content}}" });
/** Chat `tuned`'s six fields as stored (`false` and `0` are stored values, not defaults). */
const TUNED = {
    translatorPresetId: "tp2",
    autoTranslate: true,
    translateBotOnly: false,
    bilingualDisplay: true,
    bilingualEmphasis: "translation",
    bilingualSentences: 0,
};
const DANGLING = { translatorPresetId: "tp-gone", autoTranslate: true };
const OFF = {
    translatorPresetId: null,
    autoTranslate: false,
    translateBotOnly: false,
    bilingualDisplay: false,
    bilingualEmphasis: "original",
    bilingualSentences: 0,
};

const create = (characterId: string, id: string, chat: Record<string, unknown>) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [
        {
            op: "create",
            chat: {
                id,
                name: id.toUpperCase(),
                note: "",
                localLore: [],
                message: [m(`${id}-0`, `${id} text`)],
                ...chat,
            },
        },
    ],
});

/**
 * Boots the chat module from summaries against a server holding character `c` with the chats `plain`
 * (first in order, no translation field), `tuned` (`TUNED`), `dangling` (a deleted preset `tp-gone`,
 * auto-translate on), and `odd` (every field of the wrong type but a string emphasis `weird`), and
 * character `e` without chats. The records hold the translator presets `tp1` (selected) and `tp2`;
 * the target language is `ko` and the translator the LLM one. Nothing is chosen and nothing is loaded.
 */
async function boot() {
    vi.resetModules();
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [
            { kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: characters, id: "e", baseRevision: null, data: { chaId: "e", name: "E" } },
        ],
        chats: [
            create("c", "plain", {}),
            create("c", "tuned", TUNED),
            create("c", "dangling", DANGLING),
            create("c", "odd", {
                translatorPresetId: 5,
                autoTranslate: "yes",
                translateBotOnly: 1,
                bilingualDisplay: null,
                bilingualEmphasis: "weird",
                bilingualSentences: "3",
            }),
        ],
    });
    const chat: ChatModule = await import("../storage/chatStore.svelte");
    const translation: TranslationModule = await import("./chatTranslation.svelte");
    const records = await import("../storage/records.svelte");
    const views: ViewsModule = await import("../storage/settingsViews.svelte");
    const selection: SelectionModule = await import("../storage/selection.svelte");
    const characterStore = await import("../storage/characterStore.svelte");
    const probes = await import("../storage/tests/reactiveProbe.svelte");
    const { flushSync } = await import("svelte");
    const read = server.store.readKinds([characters], { chatSummaries: true });
    records.initializeRecords(
        records.takeRecordFields({
            characters: read.kinds.characters.map((record) => record.data),
            translatorPresets: [JSON.parse(JSON.stringify(TP1)), JSON.parse(JSON.stringify(TP2))],
            translatorPresetId: "tp1",
            translatorType: "llm",
            translator: "ko",
        }),
    );
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    // The boot's `ensureChat` (`initializeChats`) is not run, so `e` stays chatless.
    server.requests.length = 0;

    const reads = () => server.requests.filter((request) => request.path === "/api/resources/read").length;
    const take = () => chat.takeChatWork(new Set());
    /** One save cycle: take, apply on the server, acknowledge; the groups taken and the first one's ops. */
    const commit = () => {
        const work = take();
        const result =
            work.groups.length + work.orders.length === 0
                ? { results: [], chats: [], chatOrders: [] }
                : server.store.applyChanges({
                      chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                          characterId,
                          chatId,
                          baseRevision,
                          ops,
                      })),
                      chatOrders: work.orders.map(({ characterId, baseRevision, ids }) => ({
                          characterId,
                          baseRevision,
                          ids,
                      })),
                  });
        chat.ackChatWork(work, result.chats, result.chatOrders);
        return { groups: work.groups, ops: work.groups[0]?.ops ?? [], result };
    };
    /** The server's summary of one chat, as the save loop's list read answers it. */
    const summaryOf = (chaId: string, chatId: string) =>
        server.store
            .readRefs([], { chatSummaryCollections: [chaId] })
            .chatSummaryCollections![0].chats.find((summary) => summary.id === chatId);
    /** Another tab's `meta` write on a chat (its revision moves on). */
    const remoteMeta = (chaId: string, chatId: string, set: Record<string, unknown>) =>
        server.chatBatch([
            {
                characterId: chaId,
                chatId,
                baseRevision: server.chat(chaId, chatId)!.revision,
                ops: [{ op: "meta", set, unset: [] } as any],
            },
        ]);
    /** The idle refresh of one loaded chat, as the save loop runs it (`finishIdleChatRefresh`). */
    const refreshIdle = (target: { chaId: string; chatId: string }) => {
        const notice = chat.chatNoticeSeq(target);
        const issued = chat.heldChatRevision(target);
        const current = server.store.readRefs([], { chats: [{ characterId: target.chaId, id: target.chatId }] });
        return chat.finishIdleChatRefresh(current.chats[0] as any, notice, issued);
    };
    /** A fresh chat of `chaId` as the new-chat buttons build it, from `initialChatTranslation`. */
    const newChat = (chaId: string) => {
        const created = chat.createChat(
            chaId,
            {
                ...translation.initialChatTranslation(chaId),
                message: [],
                note: "",
                name: "New",
                localLore: [],
                fmIndex: -1,
            },
            { index: 0, select: true },
        );
        return { chaId, chatId: created.id! };
    };
    return {
        server,
        chat,
        translation,
        records,
        views,
        selection,
        probes,
        flushSync,
        reads,
        take,
        commit,
        summaryOf,
        remoteMeta,
        refreshIdle,
        newChat,
    };
}

// The modules `boot` imports, once (not the whole storage graph: it does not reach `stores.svelte`).
beforeAll(
    () =>
        warmModules(() =>
            Promise.all([
                StoreBackedServer.preload(),
                import("../storage/chatStore.svelte"),
                import("./chatTranslation.svelte"),
                import("../storage/records.svelte"),
                import("../storage/settingsViews.svelte"),
                import("../storage/selection.svelte"),
                import("../storage/characterStore.svelte"),
                import("../storage/tests/reactiveProbe.svelte"),
            ]),
        ),
    60_000,
);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    serverHolder.current?.close();
});

describe("the readers", () => {
    it("read a chat's settings from its list entry (unloaded, no read), defaults for a chat without them or a non-member", async () => {
        const { chat, translation, reads } = await boot();
        expect(chat.findChat(ref("tuned"))).toBeUndefined();
        expect(translation.chatTranslationSettings(ref("tuned"))).toEqual(TUNED);
        expect(translation.chatTranslationSettings(ref("plain"))).toEqual(OFF);
        expect(translation.chatTranslationSettings(ref("dangling"))).toEqual({ ...OFF, ...DANGLING });
        // `odd`: the summary kept the string emphasis, which reads as the default.
        expect(chat.chatEntry(ref("odd"))).toEqual({ id: "odd", name: "ODD", fmIndex: -1, bilingualEmphasis: "weird" });
        expect(translation.chatTranslationSettings(ref("odd"))).toEqual(OFF);
        expect(translation.chatTranslationSettings(ref("nope"))).toEqual(OFF);
        expect(translation.chatTranslationSettings(ref("plain", "nobody"))).toEqual(OFF);
        expect(translation.chatTranslationSettings(null)).toEqual(OFF);
        expect(translation.chatTranslationSettings(undefined)).toEqual(OFF);
        expect(reads()).toBe(0);
    });

    it("chatAutoTranslate is the chat's flag only while a target language is set; tracked over both", async () => {
        const { chat, translation, views, probes, flushSync } = await boot();
        expect(translation.chatAutoTranslate(ref("tuned"))).toBe(true);
        expect(translation.chatAutoTranslate(ref("plain"))).toBe(false);
        expect(translation.chatAutoTranslate(ref("nope"))).toBe(false);
        expect(translation.chatAutoTranslate(null)).toBe(false);
        const probe = probes.createProbe(() => translation.chatAutoTranslate(ref("tuned")));
        expect(probe.seen).toEqual([true]);
        views.settings.memoryTranslateMedia.translator = "";
        flushSync();
        expect(probe.seen).toEqual([true, false]);
        views.settings.memoryTranslateMedia.translator = "ja";
        flushSync();
        expect(probe.seen).toEqual([true, false, true]);
        translation.setChatTranslationSettings(ref("tuned"), { autoTranslate: null });
        flushSync();
        expect(probe.seen).toEqual([true, false, true, false]);
        expect(chat.chatEntry(ref("tuned"))).not.toHaveProperty("autoTranslate");
        probe.dispose();
    });

    it("chatTranslatorPreset resolves the chat's own, the global one, or a deleted one as missing; tracked over the presets", async () => {
        const { translation, views, probes, flushSync } = await boot();
        expect(translation.chatTranslatorPreset(ref("tuned"))).toEqual({ preset: TP2, source: "chat", missing: false });
        expect(translation.chatTranslatorPreset(ref("plain"))).toEqual({
            preset: TP1,
            source: "global",
            missing: false,
        });
        expect(translation.chatTranslatorPreset(ref("dangling"))).toEqual({
            preset: TP1,
            source: "global",
            missing: true,
        });
        expect(translation.chatTranslatorPreset(ref("nope"))).toEqual({
            preset: TP1,
            source: "global",
            missing: false,
        });
        expect(translation.globalTranslatorPreset()).toEqual(TP1);

        const probe = probes.createProbe(() => translation.chatTranslatorPreset(ref("dangling")).source);
        expect(probe.seen).toEqual(["global"]);
        // The deleted preset comes back (an import, another tab): the chat uses it again, nothing rewritten.
        views.settings.translatorPresets.items.push(createTranslatorPreset("Back", { id: "tp-gone" }));
        flushSync();
        expect(probe.seen).toEqual(["global", "chat"]);
        expect(translation.chatTranslatorPreset(ref("dangling")).preset.name).toBe("Back");
        views.settings.translatorPresets.items.splice(2, 1);
        flushSync();
        expect(probe.seen).toEqual(["global", "chat", "global"]);
        // The global selection moves: the chats without their own follow it.
        views.settings.translatorPresets.selectedId = "tp2";
        expect(translation.chatTranslatorPreset(ref("plain")).preset).toEqual(TP2);
        expect(translation.chatTranslatorPreset(ref("dangling")).preset).toEqual(TP2);
        expect(translation.globalTranslatorPreset()).toEqual(TP2);
        probe.dispose();
    });

    it("currentTranslatorPreset is the selected chat's, at once while that chat still loads, and the global one at home", async () => {
        const { chat, translation, selection, probes, flushSync } = await boot();
        expect(chat.currentChatRef()).toBeNull();
        expect(translation.currentTranslatorPreset()).toEqual(TP1);
        const probe = probes.createProbe(() => translation.currentTranslatorPreset().id);
        expect(probe.seen).toEqual(["tp1"]);

        selection.selectCharacter("c");
        chat.selectChat("c", "tuned");
        // Selected, not loaded yet: the list entry answers.
        expect(chat.currentChatRef()).toEqual(ref("tuned"));
        expect(chat.selectedChat()).toBeNull();
        expect(translation.currentTranslatorPreset()).toEqual(TP2);
        flushSync();
        expect(probe.seen).toEqual(["tp1", "tp2"]);

        chat.selectChat("c", "dangling");
        flushSync();
        expect(translation.currentTranslatorPreset()).toEqual(TP1);
        chat.selectChat("c", "tuned");
        flushSync();
        selection.selectCharacter(null);
        flushSync();
        expect(translation.currentTranslatorPreset()).toEqual(TP1);
        expect(probe.seen).toEqual(["tp1", "tp2", "tp1", "tp2", "tp1"]);
        probe.dispose();
    });
});

describe("setChatTranslationSettings on an unloaded chat", () => {
    it("changes the list entry, queues one meta op (null unsets), the server's summary carries the fields, and equal values queue nothing", async () => {
        const { server, chat, translation, reads, take, commit, summaryOf } = await boot();
        const target = ref("plain");
        const before = server.chat("c", "plain")!;
        translation.setChatTranslationSettings(target, {
            autoTranslate: true,
            translatorPresetId: "tp2",
            bilingualSentences: 3,
            translateBotOnly: false,
        });
        const set = { autoTranslate: true, translatorPresetId: "tp2", bilingualSentences: 3, translateBotOnly: false };
        expect(chat.chatEntry(target)).toEqual({ id: "plain", name: "PLAIN", fmIndex: -1, ...set });
        expect(translation.chatTranslationSettings(target)).toEqual({ ...OFF, ...set });
        expect(chat.findChat(target)).toBeUndefined();
        expect(reads()).toBe(0);
        const first = commit();
        expect(first.groups).toHaveLength(1);
        expect(first.ops).toEqual([{ op: "meta", set, unset: [] }]);
        expect(server.chat("c", "plain")!.data).toMatchObject(set);
        expect(server.chat("c", "plain")!.revision).not.toBe(before.revision);
        expect(summaryOf("c", "plain")).toEqual({
            characterId: "c",
            id: "plain",
            revision: server.chat("c", "plain")!.revision,
            name: "PLAIN",
            fmIndex: -1,
            ...set,
        });
        expect(chat.hasChatWork()).toBe(false);

        // `null` unsets (back to the default; the preset back to the global one); an omitted or
        // `undefined` member changes nothing; unsetting a field that is not there queues nothing.
        translation.setChatTranslationSettings(target, {
            autoTranslate: null,
            translatorPresetId: null,
            bilingualDisplay: undefined,
            bilingualEmphasis: null,
        });
        expect(chat.chatEntry(target)).toEqual({
            id: "plain",
            name: "PLAIN",
            fmIndex: -1,
            bilingualSentences: 3,
            translateBotOnly: false,
        });
        expect(translation.chatTranslatorPreset(target)).toEqual({ preset: TP1, source: "global", missing: false });
        const second = commit();
        expect(second.ops).toEqual([{ op: "meta", set: {}, unset: ["autoTranslate", "translatorPresetId"] }]);
        for (const field of ["autoTranslate", "translatorPresetId", "bilingualEmphasis"]) {
            expect(server.chat("c", "plain")!.data, field).not.toHaveProperty(field);
            expect(summaryOf("c", "plain"), field).not.toHaveProperty(field);
        }
        expect(summaryOf("c", "plain")).toMatchObject({ bilingualSentences: 3, translateBotOnly: false });
        translation.setChatTranslationSettings(target, { bilingualSentences: 3, translateBotOnly: false });
        translation.setChatTranslationSettings(target, { autoTranslate: null });
        translation.setChatTranslationSettings(target, {});
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);

        // A wrong type or a non-member is refused as a whole.
        expect(() => translation.setChatTranslationSettings(target, { autoTranslate: "yes" as never })).toThrow(
            /boolean/,
        );
        expect(() =>
            translation.setChatTranslationSettings(target, {
                bilingualDisplay: true,
                bilingualSentences: "3" as never,
            }),
        ).toThrow(/number/);
        expect(() => translation.setChatTranslationSettings(ref("nope"), { autoTranslate: true })).toThrow(/No chat/);
        expect(chat.chatEntry(target)).not.toHaveProperty("bilingualDisplay");
        expect(take().groups).toEqual([]);
        expect(reads()).toBe(0);
        // Loaded afterwards, the chat shows the fields.
        const loaded = await chat.ensureChatLoaded(target);
        expect(loaded).toMatchObject({ id: "plain", bilingualSentences: 3, translateBotOnly: false });
        expect(loaded).not.toHaveProperty("autoTranslate");
        expect(loaded).not.toHaveProperty("translatorPresetId");
    });

    it("a load while the meta op is pending keeps the local value over the read, and the idle refresh after the acknowledgement brings another writer's field", async () => {
        const { server, chat, translation, commit, remoteMeta, refreshIdle } = await boot();
        const target = ref("dangling");
        const original = chat.heldChatRevision(target);
        translation.setChatTranslationSettings(target, { autoTranslate: null, translatorPresetId: "tp2" });
        expect(chat.chatEntry(target)).toEqual({
            id: "dangling",
            name: "DANGLING",
            fmIndex: -1,
            translatorPresetId: "tp2",
        });
        // Another tab turns on bot-only translation meanwhile.
        remoteMeta("c", "dangling", { translateBotOnly: true });
        const remote = server.chat("c", "dangling")!;
        expect(remote.data).toMatchObject({ ...DANGLING, translateBotOnly: true });

        const loaded = await chat.ensureChatLoaded(target);
        // The copy: the local list fields over the read (the other writer's list field masked for now).
        expect(loaded).toMatchObject({ id: "dangling", translatorPresetId: "tp2" });
        expect(loaded).not.toHaveProperty("autoTranslate");
        expect(loaded).not.toHaveProperty("translateBotOnly");
        expect(translation.chatTranslationSettings(target)).toEqual({ ...OFF, translatorPresetId: "tp2" });
        expect(translation.chatTranslatorPreset(target)).toEqual({ preset: TP2, source: "chat", missing: false });
        // The queued meta op keeps its base: the read's newer revision is not held.
        expect(remote.revision).not.toBe(original);
        expect(chat.heldChatRevision(target)).toBe(original);
        expect(chat.hasChatWork()).toBe(true);

        // Saved on that older base as a stale-base list-field write.
        const { result } = commit();
        expect(result.chats[0].stale).toBe(true);
        expect(server.chat("c", "dangling")!.data).toMatchObject({ translatorPresetId: "tp2", translateBotOnly: true });
        expect(server.chat("c", "dangling")!.data).not.toHaveProperty("autoTranslate");
        expect(chat.idleChatRefreshes()).toEqual([target]);
        expect(refreshIdle(target)).toBe(true);
        expect(chat.findChat(target)).toMatchObject({ translatorPresetId: "tp2", translateBotOnly: true });
        expect(translation.chatTranslationSettings(target)).toEqual({
            ...OFF,
            translatorPresetId: "tp2",
            translateBotOnly: true,
        });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("initialChatTranslation", () => {
    it("inherits the selected chat's six fields as stored (unloaded, no read), a deleted preset id and typed invalid values included, wrong types left out; a chatless or unknown character gives nothing", async () => {
        const { chat, translation, reads } = await boot();
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["plain", "tuned", "dangling", "odd"]);
        // Nothing chosen: the first chat in order, which has no settings.
        expect(translation.initialChatTranslation("c")).toEqual({});

        chat.selectChat("c", "tuned");
        expect(chat.findChat(ref("tuned"))).toBeUndefined();
        const fromTuned = translation.initialChatTranslation("c");
        expect(fromTuned).toEqual(TUNED);
        expect(Object.keys(fromTuned)).toEqual(Object.keys(TUNED));
        expect(chat.findChat(ref("tuned"))).toBeUndefined();
        expect(reads()).toBe(0);

        // A deleted preset id is copied (it falls back in the new chat as it does in the source).
        chat.selectChat("c", "dangling");
        expect(translation.initialChatTranslation("c")).toEqual(DANGLING);
        // Only typed values; the reader defaults the string emphasis in the new chat too.
        chat.selectChat("c", "odd");
        expect(translation.initialChatTranslation("c")).toEqual({ bilingualEmphasis: "weird" });

        expect(chat.selectedChatId("e")).toBeNull();
        expect(translation.initialChatTranslation("e")).toEqual({});
        expect(translation.initialChatTranslation("nobody")).toEqual({});
        expect(reads()).toBe(0);
    });

    it("reads a loaded source the same way, and a local change of the source before the new chat", async () => {
        const { chat, translation, reads } = await boot();
        chat.selectChat("c", "tuned");
        await chat.ensureChatLoaded(ref("tuned"));
        expect(reads()).toBe(1);
        expect(translation.initialChatTranslation("c")).toEqual(TUNED);
        translation.setChatTranslationSettings(ref("tuned"), { autoTranslate: null, bilingualSentences: 4 });
        const { autoTranslate: _auto, ...rest } = TUNED;
        expect(translation.initialChatTranslation("c")).toEqual({ ...rest, bilingualSentences: 4 });
        expect(reads()).toBe(1);
    });

    it("empty gives nothing; unset, inherit, or an unexpected value is inherit; never a global value", async () => {
        const { chat, translation, views } = await boot();
        chat.selectChat("c", "tuned");
        expect(views.settings.ui.newChatBinding).toBeUndefined();
        expect(translation.initialChatTranslation("c")).toEqual(TUNED);
        views.settings.ui.newChatBinding = "empty";
        expect(translation.initialChatTranslation("c")).toEqual({});
        expect(translation.initialChatTranslation("e")).toEqual({});
        views.settings.ui.newChatBinding = "inherit";
        expect(translation.initialChatTranslation("c")).toEqual(TUNED);
        (views.settings.ui as Record<string, unknown>).newChatBinding = "Empty";
        expect(translation.initialChatTranslation("c")).toEqual(TUNED);
        (views.settings.ui as Record<string, unknown>).newChatBinding = 1;
        expect(translation.initialChatTranslation("c")).toEqual(TUNED);
        // The global selection is not a source: a chat without its own preset gives no preset id.
        chat.selectChat("c", "plain");
        views.settings.translatorPresets.selectedId = "tp2";
        expect(translation.initialChatTranslation("c")).toEqual({});
    });

    it("is untracked: a reader inside an effect does not re-run when the source, the chosen chat, or the setting change", async () => {
        const { chat, translation, views, probes, flushSync } = await boot();
        chat.selectChat("c", "tuned");
        const probe = probes.createProbe(() => translation.initialChatTranslation("c"));
        expect(probe.seen).toEqual([TUNED]);
        translation.setChatTranslationSettings(ref("tuned"), { autoTranslate: null });
        chat.selectChat("c", "plain");
        views.settings.ui.newChatBinding = "empty";
        flushSync();
        expect(probe.seen).toEqual([TUNED]);
        expect(translation.initialChatTranslation("c")).toEqual({});
        probe.dispose();
    });

    it("the new chat carries the inherited fields to the server and its summary, and is the next source", async () => {
        const { server, chat, translation, commit, summaryOf, newChat } = await boot();
        chat.selectChat("c", "dangling");
        const created = newChat("c");
        expect(chat.chatList("c")[0].id).toBe(created.chatId);
        expect(chat.selectedChatId("c")).toBe(created.chatId);
        expect(chat.chatEntry(created)).toEqual({ id: created.chatId, name: "New", fmIndex: -1, ...DANGLING });
        expect(translation.chatTranslatorPreset(created)).toEqual({ preset: TP1, source: "global", missing: true });
        expect(translation.chatAutoTranslate(created)).toBe(true);

        const { groups, ops } = commit();
        expect(groups).toHaveLength(1);
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "create", chat: { id: created.chatId, name: "New", ...DANGLING } });
        expect(server.chat("c", created.chatId)!.data).toMatchObject(DANGLING);
        expect(summaryOf("c", created.chatId)).toMatchObject(DANGLING);
        expect(chat.hasChatWork()).toBe(false);

        // The next new chat inherits from the one just created (now the selected chat), with its edits.
        translation.setChatTranslationSettings(created, { translatorPresetId: "tp2", bilingualDisplay: true });
        const next = newChat("c");
        expect(chat.chatEntry(next)).toEqual({
            id: next.chatId,
            name: "New",
            fmIndex: -1,
            translatorPresetId: "tp2",
            autoTranslate: true,
            bilingualDisplay: true,
        });
    });
});

describe("importedChatTranslation", () => {
    const imported = (fields: Record<string, unknown>) =>
        ({ name: "Imported", note: "", localLore: [], message: [], ...fields }) as any;

    it("keeps a preset id that names a preset here, drops a deleted, blank, or non-string one, keeps the other fields as imported, mutates the object, and reads nothing", async () => {
        const { translation, reads } = await boot();
        const full = imported(TUNED);
        expect(translation.importedChatTranslation(full)).toBeUndefined();
        expect(full).toEqual(imported(TUNED));

        const gone = imported({ ...DANGLING, bilingualSentences: 99, bilingualEmphasis: "weird" });
        translation.importedChatTranslation(gone);
        expect(gone).toEqual(imported({ autoTranslate: true, bilingualSentences: 99, bilingualEmphasis: "weird" }));
        expect(Object.keys(gone)).not.toContain("translatorPresetId");

        for (const id of ["", "   ", " tp2 ", 5, null, { id: "tp2" }]) {
            const odd = imported({ translatorPresetId: id, translateBotOnly: true });
            translation.importedChatTranslation(odd);
            expect(odd, JSON.stringify(id)).toEqual(imported({ translateBotOnly: true }));
        }

        const bare = imported({});
        translation.importedChatTranslation(bare);
        expect(bare).toEqual(imported({}));
        expect(Object.keys(bare)).not.toContain("translatorPresetId");
        expect(reads()).toBe(0);
    });

    it("the chat created from it resolves the kept preset, and the global one after a drop", async () => {
        const { server, chat, translation, commit, summaryOf } = await boot();
        const kept = imported(TUNED);
        translation.importedChatTranslation(kept);
        const first = chat.createChat("c", kept, { index: 0 });
        expect(translation.chatTranslatorPreset(ref(first.id!))).toEqual({
            preset: TP2,
            source: "chat",
            missing: false,
        });
        const dropped = imported(DANGLING);
        translation.importedChatTranslation(dropped);
        const second = chat.createChat("c", dropped, { index: 0 });
        expect(chat.chatEntry(ref(second.id!))).toEqual({
            id: second.id,
            name: "Imported",
            fmIndex: -1,
            autoTranslate: true,
        });
        expect(translation.chatTranslatorPreset(ref(second.id!))).toEqual({
            preset: TP1,
            source: "global",
            missing: false,
        });
        expect(commit().groups).toHaveLength(2);
        expect(server.chat("c", first.id!)!.data).toMatchObject(TUNED);
        expect(summaryOf("c", second.id!)).toMatchObject({ autoTranslate: true });
        expect(summaryOf("c", second.id!)).not.toHaveProperty("translatorPresetId");
    });
});
