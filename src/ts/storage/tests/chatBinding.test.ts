import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// `docs/plan/chat-binding.md`, slice 1: the client side of a chat's binding
// (`src/ts/storage/chatBinding.svelte.ts`) over the chat module booted from summaries against the
// real server store, with the save loop driven by hand (`take` → `applyChanges` → `ack`, as
// `chatLazyLoading.test.ts` does). Covered here:
// - `chatBinding` and `chatBindingIds` answer `undefined` for a chat that is not a member, never the
//   tab's selection; `chatBindingPatch` on one throws as `setChatMeta` does;
// - the binding of an unloaded chat resolves from its summary and is written through one `meta` op
//   (`personaId` as `bindedPersona`; `null` unbinds; `review` sets `bindingReview: true` or removes
//   it; an omitted or `undefined` member changes nothing); the server's summary and the chat loaded
//   afterwards carry the same fields;
// - the ids are read as stored (`bindingReview: false` kept, a padded id unchanged) and every
//   problem is reported, the raw ids readable beside them;
// - a reader re-runs when a bound record is removed or replaced, when the binding is patched, and
//   when a remote summary refresh changes the chat's list fields.

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
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

type ChatModule = typeof import("../chatStore.svelte");
type BindingModule = typeof import("../chatBinding.svelte");
type RecordsModule = typeof import("../records.svelte");

const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
const ref = (chatId: string, chaId = "c") => ({ chaId, chatId });

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
 * Boots the chat module from summaries, the way `loadData` does, against a server holding
 * character `c` with chats `unbound` (no binding), `reviewed` (bound to `m1`, `p1`, `u1`, with
 * `bindingReview: false`), `padded` (model preset `" m1 "`, prompt preset `p-gone`, persona `u1`,
 * review pending), and `bound` (bound to `m2`, `p2`, `u2`). The records hold the prompt presets
 * `p1`, `p2`, the model presets `m1`, `m2`, and the personas `u1`, `u2`. Nothing is selected and
 * nothing is loaded.
 */
async function boot() {
    vi.resetModules();
    const server = await StoreBackedServer.create();
    serverHolder.current = server;
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            create("c", "unbound", {}),
            create("c", "reviewed", {
                modelPresetId: "m1",
                promptPresetId: "p1",
                bindedPersona: "u1",
                bindingReview: false,
            }),
            create("c", "padded", {
                modelPresetId: " m1 ",
                promptPresetId: "p-gone",
                bindedPersona: "u1",
                bindingReview: true,
            }),
            create("c", "bound", { modelPresetId: "m2", promptPresetId: "p2", bindedPersona: "u2" }),
        ],
    });
    const chat: ChatModule = await import("../chatStore.svelte");
    const binding: BindingModule = await import("../chatBinding.svelte");
    const records: RecordsModule = await import("../records.svelte");
    const characterStore = await import("../characterStore.svelte");
    const probes = await import("./reactiveProbe.svelte");
    // Svelte is part of the reset module graph: the flush must be the instance the records use.
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
    chat.seedChats(read.chatSummaries!, read.chatOrders!);
    chat.assembleChats(characterStore.characterList() as any, read.chatSummaries!, read.chatOrders!);
    chat.initializeChats();
    server.requests.length = 0;

    const take = () => chat.takeChatWork(new Set());
    /** One save cycle: take, apply on the server, acknowledge; the ops of the one group taken. */
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
        expect(work.groups.length).toBeLessThanOrEqual(1);
        return work.groups[0]?.ops ?? [];
    };
    /** The server's summary of one chat, as the save loop's list read answers it. */
    const summaryOf = (chatId: string) =>
        server.store
            .readRefs([], { chatSummaryCollections: ["c"] })
            .chatSummaryCollections![0].chats.find((summary) => summary.id === chatId);
    /** Another tab's `meta` write on a chat, then the summary list applied as the idle refresh does. */
    const remoteMeta = (chatId: string, set: Record<string, unknown>, unset: string[] = []) => {
        server.chatBatch([
            {
                characterId: "c",
                chatId,
                baseRevision: server.chat("c", chatId)!.revision,
                ops: [{ op: "meta", set, unset } as any],
            },
        ]);
        const collection = server.store.readRefs([], { chatSummaryCollections: ["c"] }).chatSummaryCollections![0];
        expect(chat.applyRemoteCollection(collection, chat.heldChatRevisionsOf("c"))).toBe(true);
    };
    return { server, chat, binding, records, probes, flushSync, take, commit, summaryOf, remoteMeta };
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

const UNSET = [
    { field: "modelPresetId", reason: "unset" },
    { field: "promptPresetId", reason: "unset" },
    { field: "personaId", reason: "unset" },
];

describe("a chat that is not a member", () => {
    it("reads as undefined (never the tab's selection) and refuses a patch as setChatMeta does", async () => {
        const { chat, binding, take } = await boot();
        for (const target of [ref("nope"), ref("unbound", "nobody"), ref("", "")]) {
            expect(binding.chatBinding(target), target.chatId).toBeUndefined();
            expect(binding.chatBindingIds(target), target.chatId).toBeUndefined();
            expect(() => binding.chatBindingPatch(target, { modelPresetId: "m1" }), target.chatId).toThrow(/No chat/);
            expect(() => binding.chatBindingPatch(target, {}), target.chatId).toThrow(/No chat/);
        }
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["unbound", "reviewed", "padded", "bound"]);
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("the binding of an unloaded chat", () => {
    it("resolves from the summary, is written through one meta op, and the server's summary and the loaded chat carry it", async () => {
        const { server, chat, binding, commit, summaryOf } = await boot();
        const target = ref("unbound");
        expect(chat.findChat(target)).toBeUndefined();
        expect(binding.chatBinding(target)).toEqual({ ok: false, problems: UNSET });
        expect(binding.chatBindingIds(target)).toEqual({
            modelPresetId: null,
            promptPresetId: null,
            personaId: null,
            review: false,
        });

        binding.chatBindingPatch(target, { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" });
        expect(chat.findChat(target)).toBeUndefined();
        expect(chat.chatEntry(target)).toEqual({
            id: "unbound",
            name: "UNBOUND",
            fmIndex: -1,
            modelPresetId: "m1",
            promptPresetId: "p1",
            bindedPersona: "u1",
        });
        expect(binding.chatBinding(target)).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });
        expect(server.requests.filter((request) => request.path === "/api/resources/read")).toEqual([]);
        expect(commit()).toEqual([
            { op: "meta", set: { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" }, unset: [] },
        ]);
        expect(server.chat("c", "unbound")!.data).toMatchObject({
            modelPresetId: "m1",
            promptPresetId: "p1",
            bindedPersona: "u1",
        });
        expect(summaryOf("unbound")).toMatchObject({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
        expect(chat.hasChatWork()).toBe(false);

        // The chat loaded afterwards shows the same binding; the resolver reads the loaded chat then.
        const loaded = await chat.ensureChatLoaded(target);
        expect(loaded).toMatchObject({ modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1" });
        expect(binding.chatBinding(target)).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });
    });

    it("review: true sets bindingReview and blocks, review: false removes it; null unbinds a field; an omitted or undefined member is a no-op", async () => {
        const { server, chat, binding, take, commit, summaryOf } = await boot();
        const target = ref("bound");
        expect(binding.chatBinding(target)).toEqual({
            ok: true,
            ids: { modelPresetId: "m2", promptPresetId: "p2", personaId: "u2" },
        });

        binding.chatBindingPatch(target, { review: true });
        expect(binding.chatBinding(target)).toEqual({ ok: false, problems: [{ field: "review" }] });
        // The raw ids stay readable while the review is pending.
        expect(binding.chatBindingIds(target)).toEqual({
            modelPresetId: "m2",
            promptPresetId: "p2",
            personaId: "u2",
            review: true,
        });
        expect(commit()).toEqual([{ op: "meta", set: { bindingReview: true }, unset: [] }]);
        expect(summaryOf("bound")).toMatchObject({ bindingReview: true });

        binding.chatBindingPatch(target, { review: false });
        expect(chat.chatEntry(target)).not.toHaveProperty("bindingReview");
        expect(binding.chatBinding(target).ok).toBe(true);
        expect(commit()).toEqual([{ op: "meta", set: {}, unset: ["bindingReview"] }]);
        expect(server.chat("c", "bound")!.data).not.toHaveProperty("bindingReview");
        expect(summaryOf("bound")).not.toHaveProperty("bindingReview");

        // `null` unbinds; the other members are untouched.
        binding.chatBindingPatch(target, { personaId: null, modelPresetId: undefined });
        expect(chat.chatEntry(target)).toEqual({
            id: "bound",
            name: "BOUND",
            fmIndex: -1,
            modelPresetId: "m2",
            promptPresetId: "p2",
        });
        expect(binding.chatBinding(target)).toEqual({
            ok: false,
            problems: [{ field: "personaId", reason: "unset" }],
        });
        expect(binding.chatBindingIds(target)).toEqual({
            modelPresetId: "m2",
            promptPresetId: "p2",
            personaId: null,
            review: false,
        });
        expect(commit()).toEqual([{ op: "meta", set: {}, unset: ["bindedPersona"] }]);
        expect(server.chat("c", "bound")!.data).not.toHaveProperty("bindedPersona");

        // Nothing to change: no op (an unbound field unbound again, a review not pending, an equal id).
        binding.chatBindingPatch(target, {});
        binding.chatBindingPatch(target, { personaId: null, review: false, promptPresetId: "p2" });
        binding.chatBindingPatch(target, { modelPresetId: undefined, promptPresetId: undefined, personaId: undefined });
        expect(take().groups).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.findChat(target)).toBeUndefined();

        // All three at once, in one op, with the review: a later confirmation clears it alone.
        binding.chatBindingPatch(target, { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1", review: true });
        expect(commit()).toEqual([
            {
                op: "meta",
                set: { modelPresetId: "m1", promptPresetId: "p1", bindedPersona: "u1", bindingReview: true },
                unset: [],
            },
        ]);
        expect(binding.chatBinding(target)).toEqual({ ok: false, problems: [{ field: "review" }] });
        binding.chatBindingPatch(target, { review: false });
        expect(binding.chatBinding(target)).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });
        expect(commit()).toEqual([{ op: "meta", set: {}, unset: ["bindingReview"] }]);
    });

    it("reads the ids as stored: bindingReview false is kept and no review, a padded id is unchanged and gone, and every problem is reported", async () => {
        const { chat, binding } = await boot();
        expect(chat.chatEntry(ref("reviewed"))).toMatchObject({ bindingReview: false });
        expect(binding.chatBindingIds(ref("reviewed"))).toEqual({
            modelPresetId: "m1",
            promptPresetId: "p1",
            personaId: "u1",
            review: false,
        });
        expect(binding.chatBinding(ref("reviewed"))).toEqual({
            ok: true,
            ids: { modelPresetId: "m1", promptPresetId: "p1", personaId: "u1" },
        });

        expect(binding.chatBindingIds(ref("padded"))).toEqual({
            modelPresetId: " m1 ",
            promptPresetId: "p-gone",
            personaId: "u1",
            review: true,
        });
        expect(binding.chatBinding(ref("padded"))).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "gone" },
                { field: "promptPresetId", reason: "gone" },
                { field: "review" },
            ],
        });
        expect(binding.chatBindingTargetExists("modelPresetId", " m1 ")).toBe(false);
        expect(binding.chatBindingTargetExists("modelPresetId", "m1")).toBe(true);
        expect(binding.chatBindingTargetExists("promptPresetId", "p-gone")).toBe(false);
        expect(binding.chatBindingTargetExists("promptPresetId", "p1")).toBe(true);
        expect(binding.chatBindingTargetExists("personaId", "u1")).toBe(true);
        expect(binding.chatBindingTargetExists("personaId", "m1")).toBe(false);
    });
});

// Slice 3: the ids a context names and the display rule (`chatContextIds`, `chatDisplayIds`), and the
// refusal text of the send guard (`chatBindingRefusalText`, `chatBindingProblems`).
describe("the context ids and the display rule", () => {
    it("chatContextIds names the prompt preset as presetId; chatDisplayIds takes each bound id that names a record, else the tab's", async () => {
        const { binding } = await boot();
        const selection = await import("../selection.svelte");
        selection.selectPreset("p1");
        selection.selectModelPreset("m1");
        selection.selectPersona("u1");
        const tab = { presetId: "p1", modelPresetId: "m1", personaId: "u1" };
        expect(binding.chatContextIds({ modelPresetId: "m2", promptPresetId: "p2", personaId: "u2" })).toEqual({
            presetId: "p2",
            modelPresetId: "m2",
            personaId: "u2",
        });
        expect(binding.chatDisplayIds(ref("bound"))).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u2" });
        // Per field: the gone prompt preset and the padded model preset fall back; the persona holds; the
        // pending review does not matter for a render.
        expect(binding.chatDisplayIds(ref("padded"))).toEqual(tab);
        expect(binding.chatDisplayIds(ref("unbound"))).toEqual(tab);
        expect(binding.chatDisplayIds(ref("nope"))).toEqual(tab);
        selection.selectPreset("p2");
        selection.selectModelPreset("m2");
        selection.selectPersona("u2");
        expect(binding.chatDisplayIds(ref("unbound"))).toEqual({
            presetId: "p2",
            modelPresetId: "m2",
            personaId: "u2",
        });
        expect(binding.chatDisplayIds(ref("padded"))).toEqual({ presetId: "p2", modelPresetId: "m2", personaId: "u1" });
        expect(binding.chatDisplayIds(ref("reviewed"))).toEqual({
            presetId: "p1",
            modelPresetId: "m1",
            personaId: "u1",
        });
        // The send guard stays strict: the display ids are not a complete binding.
        expect(binding.chatBinding(ref("padded"))).toMatchObject({ ok: false });
        expect(binding.chatBinding(ref("unbound"))).toEqual({ ok: false, problems: UNSET });
    });

    it("chatBindingRefusalText lists each problem under the header; chatBindingProblems is empty for a complete binding or a non-member", async () => {
        const { binding } = await boot();
        const { language } = await import("src/lang");
        const strings = language.chatBinding;
        expect(binding.chatBindingProblems(binding.chatBinding(ref("bound")))).toEqual([]);
        expect(binding.chatBindingProblems(undefined)).toEqual([]);
        expect(binding.chatBindingProblems(binding.chatBinding(ref("unbound")))).toEqual(UNSET);
        expect(binding.chatBindingRefusalText(binding.chatBindingProblems(binding.chatBinding(ref("padded"))))).toBe(
            [
                strings.refused,
                `${strings.fields.modelPresetId}: ${strings.gone}`,
                `${strings.fields.promptPresetId}: ${strings.gone}`,
                strings.review,
            ].join("\n"),
        );
        expect(binding.chatBindingRefusalText(UNSET as Parameters<typeof binding.chatBindingRefusalText>[0])).toBe(
            [
                strings.refused,
                `${strings.fields.modelPresetId}: ${strings.unset}`,
                `${strings.fields.promptPresetId}: ${strings.unset}`,
                `${strings.fields.personaId}: ${strings.unset}`,
            ].join("\n"),
        );
        expect(binding.chatBindingRefusalText([])).toBe(strings.refused);
    });
});

describe("reactivity", () => {
    it("a reader re-runs when a bound record is removed or replaced, when the binding is patched, and when a remote summary refresh changes the chat", async () => {
        const { chat, binding, records, probes, flushSync, commit, remoteMeta } = await boot();
        const target = ref("bound");
        const ok = (modelPresetId: string, promptPresetId: string, personaId: string) => ({
            ok: true,
            ids: { modelPresetId, promptPresetId, personaId },
        });
        const probe = probes.createProbe(() => binding.chatBinding(target));
        const ids = probes.createProbe(() => binding.chatBindingIds(target));
        const exists = probes.createProbe(() => binding.chatBindingTargetExists("personaId", "u2"));
        expect(probe.seen).toEqual([ok("m2", "p2", "u2")]);
        expect(exists.seen).toEqual([true]);

        // The persona is deleted: gone, with the raw id kept; no replacement is picked.
        records.trackedRecord<any[]>("personas")!.splice(1, 1);
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ ok: false, problems: [{ field: "personaId", reason: "gone" }] });
        expect(probe.derived()).toEqual(probe.seen.at(-1));
        expect(ids.seen.at(-1)).toMatchObject({ personaId: "u2" });
        expect(exists.seen.at(-1)).toBe(false);
        expect(chat.chatEntry(target)).toMatchObject({ bindedPersona: "u2" });

        // The model presets are replaced by a list without `m2`: gone as well.
        records.replaceRecordList(records.trackedRecord<any[]>("modelPresets")!, [{ id: "m1", name: "M1" }]);
        flushSync();
        expect(probe.seen.at(-1)).toEqual({
            ok: false,
            problems: [
                { field: "modelPresetId", reason: "gone" },
                { field: "personaId", reason: "gone" },
            ],
        });

        // The user picks again: the patch and a record that comes back each re-run the reader.
        binding.chatBindingPatch(target, { personaId: "u1" });
        flushSync();
        expect(probe.seen.at(-1)).toEqual({ ok: false, problems: [{ field: "modelPresetId", reason: "gone" }] });
        expect(ids.seen.at(-1)).toMatchObject({ modelPresetId: "m2", personaId: "u1" });
        records.trackedRecord<any[]>("modelPresets")!.push({ id: "m2", name: "M2 again" });
        flushSync();
        expect(probe.seen.at(-1)).toEqual(ok("m2", "p2", "u1"));
        expect(commit()).toEqual([{ op: "meta", set: { bindedPersona: "u1" }, unset: [] }]);

        // Another tab marks the chat for review and rebinds its prompt preset: the summary list
        // refresh changes the entry, and the reader follows.
        remoteMeta("bound", { bindingReview: true, promptPresetId: "p1" });
        flushSync();
        expect(chat.findChat(target)).toBeUndefined();
        expect(chat.chatEntry(target)).toMatchObject({ promptPresetId: "p1", bindingReview: true });
        expect(probe.seen.at(-1)).toEqual({ ok: false, problems: [{ field: "review" }] });
        expect(ids.seen.at(-1)).toEqual({ modelPresetId: "m2", promptPresetId: "p1", personaId: "u1", review: true });
        remoteMeta("bound", {}, ["bindingReview"]);
        flushSync();
        expect(probe.seen.at(-1)).toEqual(ok("m2", "p1", "u1"));

        const runs = probe.seen.length;
        // A record of another kind changing does not matter to the resolver's answer, and a chat
        // write elsewhere does not re-run this chat's reader.
        binding.chatBindingPatch(ref("unbound"), { modelPresetId: "m1" });
        flushSync();
        expect(probe.seen.length).toBe(runs);
        probe.dispose();
        ids.dispose();
        exists.dispose();
    });
});
