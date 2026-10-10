import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// `docs/plan/chat-binding.md`, slice 6: how a new chat starts (`initialChatBinding`) and how an
// imported chat is prepared (`importedChatBinding`), over the chat module booted from summaries
// against the real server store (nothing loaded, as `chatBinding.test.ts` boots it). Covered:
// - inherit reads the character's selected chat's list entry (unloaded, no read), else its first
//   chat in order; a character without chats or unknown gives nothing;
// - only ids that name records that exist are copied, each omitted otherwise (a gone id, a padded
//   id, an unset field, a record deleted since); `bindingReview` is never copied, and a
//   `bindingReview: false` source gives no key either; the tab's selection is never the source;
// - `empty` gives nothing; anything else (unset, `inherit`, an unexpected value) is inherit;
// - the read is untracked: a reader inside an effect does not re-run when the source changes;
// - the agreed consequence: a source awaiting its confirmation gives its ids to a new chat that
//   can be sent, while the source stays blocked; the create op and the server's summary carry the
//   three fields and no review;
// - a copy or branch that spreads its loaded source keeps all four fields through `createChat`;
// - `importedChatBinding` drops the ids that do not name a record here (or are not non-blank
//   strings), keeps the rest, sets `bindingReview` (an imported `false` overwritten), mutates the
//   object, reads nothing from the tab, and the chat created from it is blocked until confirmed.

const serverHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("../serverAuth", () => ({
    authFetch: async (path: string, init?: RequestInit) => serverHolder.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
}));

type ChatModule = typeof import("../chatStore.svelte");
type BindingModule = typeof import("../chatBinding.svelte");
type RecordsModule = typeof import("../records.svelte");
type ViewsModule = typeof import("../settingsViews.svelte");
type SelectionModule = typeof import("../selection.svelte");

const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
const ref = (chatId: string, chaId = "c") => ({ chaId, chatId });
const FULL = { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" };
const TAB = { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" };

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
 * Boots the chat module from summaries against a server holding character `c` with the chats
 * `unbound` (first in order), `bound` (`m2`, `p2`, `u2`), `padded` (model preset `" m1 "`, prompt
 * preset `p-gone`, persona `u1`, review pending), and `reviewed` (`m1`, `p1`, `u1`, with
 * `bindingReview: false`); character `d` with `other` (`m2`, `p2`, `u2`) first and `second`
 * unbound; and character `e` without chats (the boot's `ensureChat` is not run, so it stays
 * chatless). The records hold the prompt presets `p1`, `p2`, the model presets `m1`, `m2`, and the
 * personas `u1`, `u2`; the tab selects `p1`, `m1`, `u1`. Nothing is chosen and nothing is loaded.
 */
async function boot() {
    vi.resetModules();
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [
            { kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: characters, id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
            { kind: characters, id: "e", baseRevision: null, data: { chaId: "e", name: "E" } },
        ],
        chats: [
            create("c", "unbound", {}),
            create("c", "bound", FULL),
            create("c", "padded", {
                modelPresetId: " m1 ",
                promptPresetId: "p-gone",
                bindedPersona: "u1",
                bindingReview: true,
            }),
            create("c", "reviewed", { ...TAB, bindingReview: false }),
            create("d", "other", FULL),
            create("d", "second", {}),
        ],
    });
    const chat: ChatModule = await import("../chatStore.svelte");
    const binding: BindingModule = await import("../chatBinding.svelte");
    const records: RecordsModule = await import("../records.svelte");
    const views: ViewsModule = await import("../settingsViews.svelte");
    const selection: SelectionModule = await import("../selection.svelte");
    const characterStore = await import("../characterStore.svelte");
    const probes = await import("./reactiveProbe.svelte");
    const { flushSync } = await import("svelte");
    const read = server.store.readKinds([characters], { chatSummaries: true });
    records.initializeRecords(
        records.takeRecordFields({
            characters: read.kinds.characters.map((record) => record.data),
            botPresets: [
                { id: "p1", name: "P1" },
                { id: "p2", name: "P2" },
            ],
            modelPresets: [
                { id: "m1", name: "M1" },
                { id: "m2", name: "M2" },
            ],
            personas: [
                { id: "u1", name: "U1" },
                { id: "u2", name: "U2" },
            ],
        }),
    );
    selection.selectPreset("p1");
    selection.selectModelPreset("m1");
    selection.selectPersona("u1");
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    server.requests.length = 0;

    const reads = () => server.requests.filter((request) => request.path === "/api/resources/read").length;
    /** One save cycle: take, apply on the server, acknowledge; the ops of the one group taken. */
    const commit = () => {
        const work = chat.takeChatWork(new Set());
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
        expect(work.groups.length).toBeLessThanOrEqual(1);
        return work.groups[0]?.ops ?? [];
    };
    /** The server's summary of one chat, as the save loop's list read answers it. */
    const summaryOf = (chaId: string, chatId: string) =>
        server.store
            .readRefs([], { chatSummaryCollections: [chaId] })
            .chatSummaryCollections![0].chats.find((summary) => summary.id === chatId);
    /** A fresh chat of `chaId` as the new-chat buttons build it, from `initialChatBinding`. */
    const newChat = (chaId: string) => {
        const created = chat.createChat(
            chaId,
            { ...binding.initialChatBinding(chaId), message: [], note: "", name: "New", localLore: [], fmIndex: -1 },
            { index: 0, select: true },
        );
        return { chaId, chatId: created.id! };
    };
    return { server, chat, binding, records, views, selection, probes, flushSync, reads, commit, summaryOf, newChat };
}

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

describe("initialChatBinding", () => {
    it("inherits from the character's selected chat, unloaded and without a read, else from its first chat; a chatless or unknown character gives nothing", async () => {
        const { chat, binding, reads } = await boot();
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["unbound", "bound", "padded", "reviewed"]);
        // Nothing chosen: the first chat in order.
        expect(binding.initialChatBinding("c")).toEqual({});
        expect(binding.initialChatBinding("d")).toEqual(FULL);

        chat.selectChat("c", "bound");
        expect(chat.findChat(ref("bound"))).toBeUndefined();
        expect(binding.initialChatBinding("c")).toEqual(FULL);
        expect(chat.findChat(ref("bound"))).toBeUndefined();
        expect(reads()).toBe(0);

        chat.selectChat("d", "second");
        expect(binding.initialChatBinding("d")).toEqual({});

        expect(chat.selectedChatId("e")).toBeNull();
        expect(binding.initialChatBinding("e")).toEqual({});
        expect(binding.initialChatBinding("nobody")).toEqual({});
    });

    it("copies only the ids that name records that exist, omits the rest, never the review, and never the tab's selection", async () => {
        const { chat, binding, records, flushSync } = await boot();
        chat.selectChat("c", "padded");
        const fromPadded = binding.initialChatBinding("c");
        expect(fromPadded).toEqual({ bindedPersona: "u1" });
        expect(Object.keys(fromPadded)).toEqual(["bindedPersona"]);

        chat.selectChat("c", "reviewed");
        const fromReviewed = binding.initialChatBinding("c");
        expect(fromReviewed).toEqual(TAB);
        expect(Object.keys(fromReviewed).sort()).toEqual(["bindedPersona", "modelPresetId", "promptPresetId"]);

        // The tab's selection (`p1`, `m1`, `u1`) is not a source: an unbound chat gives nothing.
        chat.selectChat("c", "unbound");
        expect(Object.keys(binding.initialChatBinding("c"))).toEqual([]);

        // A record deleted since the source was bound is dropped; one that is back is copied again.
        chat.selectChat("c", "bound");
        records.trackedRecord<any[]>("personas")!.splice(1, 1);
        flushSync();
        expect(binding.initialChatBinding("c")).toEqual({ modelPresetId: "m2", promptPresetId: "p2" });
        records.replaceRecordList(records.trackedRecord<any[]>("modelPresets")!, [{ id: "m1", name: "M1" }]);
        flushSync();
        expect(binding.initialChatBinding("c")).toEqual({ promptPresetId: "p2" });
        records.trackedRecord<any[]>("personas")!.push({ id: "u2", name: "U2 again" });
        flushSync();
        expect(binding.initialChatBinding("c")).toEqual({ promptPresetId: "p2", bindedPersona: "u2" });
        chat.selectChat("c", "padded");
        records.trackedRecord<any[]>("personas")!.splice(0, 1);
        flushSync();
        expect(binding.initialChatBinding("c")).toEqual({});
    });

    it("empty gives nothing; unset, inherit, or an unexpected value is inherit", async () => {
        const { chat, binding, views } = await boot();
        chat.selectChat("c", "bound");
        expect(views.settings.ui.newChatBinding).toBeUndefined();
        expect(binding.initialChatBinding("c")).toEqual(FULL);
        views.settings.ui.newChatBinding = "empty";
        expect(binding.initialChatBinding("c")).toEqual({});
        expect(binding.initialChatBinding("d")).toEqual({});
        views.settings.ui.newChatBinding = "inherit";
        expect(binding.initialChatBinding("c")).toEqual(FULL);
        (views.settings.ui as Record<string, unknown>).newChatBinding = "Empty";
        expect(binding.initialChatBinding("c")).toEqual(FULL);
        (views.settings.ui as Record<string, unknown>).newChatBinding = 1;
        expect(binding.initialChatBinding("c")).toEqual(FULL);
    });

    it("is untracked: a reader inside an effect does not re-run when the source, the records, or the setting change", async () => {
        const { chat, binding, records, views, probes, flushSync } = await boot();
        chat.selectChat("c", "bound");
        const probe = probes.createProbe(() => binding.initialChatBinding("c"));
        expect(probe.seen).toEqual([FULL]);
        binding.chatBindingPatch(ref("bound"), { personaId: "u1" });
        chat.selectChat("c", "unbound");
        records.trackedRecord<any[]>("personas")!.splice(0, 2);
        views.settings.ui.newChatBinding = "empty";
        flushSync();
        expect(probe.seen).toEqual([FULL]);
        expect(binding.initialChatBinding("c")).toEqual({});
        probe.dispose();
    });

    it("a source awaiting its confirmation gives its ids to a new chat that can be sent while it stays blocked; the create op and the summary carry the fields and no review", async () => {
        const { server, chat, binding, commit, summaryOf, newChat } = await boot();
        binding.chatBindingPatch(ref("bound"), { review: true });
        commit();
        expect(binding.chatBinding(ref("bound"))).toEqual({ ok: false, problems: [{ field: "review" }] });
        chat.selectChat("c", "bound");

        const created = newChat("c");
        expect(chat.chatList("c")[0].id).toBe(created.chatId);
        expect(chat.selectedChatId("c")).toBe(created.chatId);
        expect(chat.chatEntry(created)).toEqual({ id: created.chatId, name: "New", fmIndex: -1, ...FULL });
        expect(binding.chatBinding(created)).toEqual({
            ok: true,
            ids: { modelPresetId: "m2", promptPresetId: "p2", personaId: "u2" },
        });
        expect(binding.chatBinding(ref("bound"))).toEqual({ ok: false, problems: [{ field: "review" }] });

        const ops = commit();
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: "create", chat: { id: created.chatId, name: "New", ...FULL } });
        expect((ops[0] as any).chat).not.toHaveProperty("bindingReview");
        expect(server.chat("c", created.chatId)!.data).toMatchObject(FULL);
        expect(server.chat("c", created.chatId)!.data).not.toHaveProperty("bindingReview");
        expect(summaryOf("c", created.chatId)).toMatchObject(FULL);
        expect(summaryOf("c", created.chatId)).not.toHaveProperty("bindingReview");
        expect(chat.hasChatWork()).toBe(false);

        // The next new chat inherits from the one just created (now the selected chat).
        const next = newChat("c");
        expect(chat.chatEntry(next)).toMatchObject(FULL);
        expect(chat.chatEntry(next)).not.toHaveProperty("bindingReview");
    });

    it("a copy or branch that spreads its loaded source keeps all four fields through createChat", async () => {
        const { server, chat, commit, summaryOf } = await boot();
        const source = await chat.ensureChatLoaded(ref("padded"));
        const copy = chat.createChat(
            "c",
            { ...JSON.parse(JSON.stringify(source)), id: "copy", name: "PADDED (Copy)" },
            { index: 0 },
        );
        expect(copy.id).toBe("copy");
        const fields = {
            modelPresetId: " m1 ",
            promptPresetId: "p-gone",
            bindedPersona: "u1",
            bindingReview: true,
        };
        expect(chat.chatEntry(ref("copy"))).toEqual({ id: "copy", name: "PADDED (Copy)", fmIndex: -1, ...fields });
        const ops = commit();
        expect(ops[0]).toMatchObject({ op: "create", chat: { id: "copy", ...fields } });
        expect(server.chat("c", "copy")!.data).toMatchObject(fields);
        expect(summaryOf("c", "copy")).toMatchObject(fields);
    });
});

describe("importedChatBinding", () => {
    const imported = (fields: Record<string, unknown>) =>
        ({ name: "Imported", note: "", localLore: [], message: [], ...fields }) as any;

    it("keeps the ids that name records here, drops the others, sets the review (an imported false overwritten), and mutates the object", async () => {
        const { binding, reads } = await boot();
        const full = imported({ ...FULL, bindingReview: false });
        expect(binding.importedChatBinding(full)).toBeUndefined();
        expect(full).toEqual(imported({ ...FULL, bindingReview: true }));

        const mixed = imported({ modelPresetId: "m-gone", promptPresetId: " p1 ", bindedPersona: "u1" });
        binding.importedChatBinding(mixed);
        expect(mixed).toEqual(imported({ bindedPersona: "u1", bindingReview: true }));
        expect(Object.keys(mixed)).not.toContain("modelPresetId");
        expect(Object.keys(mixed)).not.toContain("promptPresetId");

        const odd = imported({ modelPresetId: 5, promptPresetId: "", bindedPersona: null, bindingReview: "yes" });
        binding.importedChatBinding(odd);
        expect(odd).toEqual(imported({ bindingReview: true }));

        const bare = imported({});
        binding.importedChatBinding(bare);
        expect(bare).toEqual(imported({ bindingReview: true }));
        expect(reads()).toBe(0);
    });

    it("the chat created from it carries the kept ids and waits for the confirmation", async () => {
        const { server, chat, binding, commit, summaryOf } = await boot();
        const partial = imported({ modelPresetId: "m1", promptPresetId: "p-gone", bindedPersona: "u2" });
        binding.importedChatBinding(partial);
        const created = chat.createChat("c", partial, { index: 0 });
        const target = ref(created.id!);
        expect(chat.chatEntry(target)).toEqual({
            id: created.id,
            name: "Imported",
            fmIndex: -1,
            modelPresetId: "m1",
            bindedPersona: "u2",
            bindingReview: true,
        });
        expect(binding.chatBinding(target)).toEqual({
            ok: false,
            problems: [{ field: "promptPresetId", reason: "unset" }, { field: "review" }],
        });
        commit();
        expect(server.chat("c", created.id!)!.data).toMatchObject({
            modelPresetId: "m1",
            bindedPersona: "u2",
            bindingReview: true,
        });
        expect(summaryOf("c", created.id!)).toMatchObject({
            modelPresetId: "m1",
            bindedPersona: "u2",
            bindingReview: true,
        });

        // Confirmed and completed by the user: sendable.
        binding.chatBindingPatch(target, { promptPresetId: "p1", review: false });
        expect(binding.chatBinding(target)).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u2" },
        });
    });
});
