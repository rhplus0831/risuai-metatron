import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database.ts";
import type { ChannelAnswer, GenerationCallbackEvent, GenerationEvent } from "../../../shared/jobs.ts";
import { bootMutations, m, refK } from "../storage/tests/mutationStoresHarness";

// The callback barrier of the job channel over the real stores: the save adapter, the chat module,
// the transport (`generationJobs.ts`, whose chain loads the dispatcher lazily and remembers every
// hydration), and the dispatcher (`jobChannel.ts`) run for real against the server resource store
// in memory. A hook must see the job's changes (hydrated before the callback, also
// when the chat was busy with local work at the time), its own writes must reach the server before
// the answer, a conflict that discards a write fails the callback as a barrier failure, and a
// receipt this client cannot hold fails it before the hook runs. Hydration never becomes an
// outgoing write.

const { server } = vi.hoisted(() => ({ server: { current: null as any } }));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
}));
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: new Map() }));

type Transport = typeof import("./generationJobs");
type Hooks = typeof import("../plugins/pluginHooks");

const serverRef = { characterId: "c", chatId: "k" };
const targets = { chatRef: refK, presetId: "", modelPresetId: "", personaId: "" };

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const transport: Transport = await import("./generationJobs");
    const hooks: Hooks = await import("../plugins/pluginHooks");
    const { fake } = booted;
    const epoch = fake.store.epoch();
    const answers: ChannelAnswer[] = [];
    const follow = {
        send: vi.fn((message: ChannelAnswer) => {
            answers.push(message);
            return true;
        }),
    };
    const apply = (event: GenerationEvent) => transport.applyGenerationEvent("J", refK, event, follow);
    /** The server's copy of `k` as the job's chat `resource` event. */
    const chatEvent = (override: { revision?: string } = {}): GenerationEvent => {
        const record = fake.chat("c", "k")!;
        return {
            type: "resource",
            epoch,
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: override.revision ?? record.revision,
            data: record.data,
            streaming: [],
        };
    };
    /** A callback carrying the receipt of `k` at the server's current revision (or `revision`). */
    const callbackEvent = (id: string, revision = fake.chat("c", "k")!.revision): GenerationCallbackEvent => ({
        type: "callback",
        epoch,
        id,
        jobId: "J",
        name: "editoutput",
        targets,
        revisions: [{ kind: "chats", id: "k", characterId: "c", revision }],
        payload: { text: "t" },
        deadline: Date.now() + 60_000,
    });
    /** The job appends `message` to `k` on the server (its write before the callback). */
    const jobWrites = (message: ReturnType<typeof m>) =>
        fake.chatBatch([
            {
                ...serverRef,
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "append", messages: [message], anchor: { end: true } }],
            },
        ]);
    const mirrorIds = () => (booted.chat.findChat(refK) as Chat).message.map((entry) => entry.chatId);
    const answered = () => vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
    return {
        ...booted,
        transport,
        hooks: hooks.pluginHooks,
        epoch,
        answers,
        follow,
        apply,
        chatEvent,
        callbackEvent,
        jobWrites,
        mirrorIds,
        answered,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
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

describe("the callback barrier over the real stores", () => {
    it("runs the hook on the job's hydrated chat, in socket order despite the lazy dispatcher, without echoing the hydration back", async () => {
        const b = await boot();
        const seen: string[][] = [];
        b.hooks.editoutput.add((text) => {
            seen.push(b.mirrorIds());
            return `${text}!`;
        });
        b.jobWrites(m("d", "D", "char"));
        const receipt = b.fake.chat("c", "k")!.revision;
        b.apply(b.chatEvent());
        b.apply(b.callbackEvent("cb"));
        await b.answered();
        expect(seen).toEqual([["a", "b", "c", "d"]]);
        expect(b.answers).toEqual([{ type: "answer", id: "cb", outcome: "answered", value: "t!" }]);
        expect(b.chat.heldChatRevision(refK)).toBe(receipt);
        // Nothing went out for the hydration or the callback.
        expect(b.fake.batchCount()).toBe(0);
    });

    it("settles local work that kept the hydration out, so the hook sees the job's message and the local change together", async () => {
        const b = await boot();
        const seen: { ids: string[]; note: string | undefined }[] = [];
        b.hooks.editoutput.add((text) => {
            const chat = b.chat.findChat(refK) as Chat;
            seen.push({ ids: chat.message.map((entry) => entry.chatId), note: chat.note });
            return text;
        });
        // A local metadata edit is pending when the job's copy arrives: the copy waits (busy).
        b.chat.setChatMeta(refK, { note: "local note" });
        b.jobWrites(m("d", "D", "char"));
        b.apply(b.chatEvent());
        expect(b.mirrorIds()).toEqual(["a", "b", "c"]);
        b.apply(b.callbackEvent("cb"));
        await b.answered();
        expect(b.answers[0]).toMatchObject({ outcome: "answered", value: "t" });
        expect(seen).toEqual([{ ids: ["a", "b", "c", "d"], note: "local note" }]);
        expect(b.fake.chat("c", "k")!.data.note).toBe("local note");
        expect(b.fake.texts("c", "k")).toEqual(["A", "B", "C", "D"]);
    });

    it("sends the hook's own writes before answering, and fails the callback as a barrier failure when a conflict discards one", async () => {
        const b = await boot();
        let mode: "chat" | "settings" = "chat";
        b.hooks.editoutput.add((text) => {
            if (mode === "chat") {
                b.chat.appendMessage(refK, m("e", "E"));
            } else {
                b.collectionStore.updateSettings({ theme: "from the hook" });
            }
            return text;
        });
        b.apply(b.chatEvent());
        b.apply(b.callbackEvent("writes"));
        await b.answered();
        expect(b.answers[0]).toMatchObject({ id: "writes", outcome: "answered" });
        expect(b.fake.texts("c", "k")).toEqual(["A", "B", "C", "E"]);
        // The scoped flush after the hook conflicts on the settings record another tab changed.
        mode = "settings";
        b.fake.beforeNextBatch = () => {
            b.fake.set("ui", "main", { ...b.record("ui").data, theme: "remote" });
        };
        b.apply(b.callbackEvent("conflict"));
        await vi.waitFor(() => expect(b.answers).toHaveLength(2));
        expect(b.answers[1]).toEqual({
            type: "answer",
            id: "conflict",
            outcome: "failed",
            failure: "barrier",
            error: "A conflict discarded changes the callback made",
            discarded: ["ui/main"],
        });
        expect(b.record("ui").theme).toBe("remote");
    });

    it("fails before the hook runs when the client cannot hold a listed record at the receipt's revision, or holds it from another epoch", async () => {
        const b = await boot();
        const hook = vi.fn((text: string) => text);
        b.hooks.editoutput.add(hook);
        const held = b.fake.chat("c", "k")!.revision;
        const newer = held.replace(/:(\d+)$/, (_, revision: string) => `:${Number(revision) + 1}`);
        b.apply(b.callbackEvent("ahead", newer));
        await b.answered();
        expect(b.answers[0]).toMatchObject({
            id: "ahead",
            outcome: "failed",
            failure: "barrier",
            error: expect.stringContaining("not applied on this client"),
        });
        b.apply(b.callbackEvent("foreign", held.replace(/^[^:]+/, "22222222-2222-4333-8444-555555555555")));
        await vi.waitFor(() => expect(b.answers).toHaveLength(2));
        expect(b.answers[1]).toMatchObject({ id: "foreign", outcome: "failed", failure: "barrier" });
        expect(hook).not.toHaveBeenCalled();
        // The held copy is fine: the same receipt passes.
        b.apply(b.callbackEvent("held", held));
        await vi.waitFor(() => expect(b.answers).toHaveLength(3));
        expect(b.answers[2]).toMatchObject({ id: "held", outcome: "answered" });
        expect(hook).toHaveBeenCalledTimes(1);
        expect(b.fake.batchCount()).toBe(0);
    });
});
