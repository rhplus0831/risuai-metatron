import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent } from "../../../shared/jobs.ts";
import { bootMutations, m, refK } from "../storage/tests/mutationStoresHarness";

const { server } = vi.hoisted(() => ({ server: { current: null as any } }));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
    alertClear: vi.fn(),
    alertConfirm: vi.fn(),
    alertInput: vi.fn(),
    alertMd: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertSelect: vi.fn(),
    alertSelectChar: vi.fn(),
    alertToast: vi.fn(),
    alertWait: vi.fn(),
    waitAlert: vi.fn(async () => undefined),
}));
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

vi.mock("./jobChannel", () => ({ rememberHydration: vi.fn(), endJobChannel: vi.fn(), handleChannelEvent: vi.fn() }));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: vi.fn() }));

// Real follow transport and chat module; only the socket and unrelated channel callbacks are doubles.
class Socket {
    static OPEN = 1;
    static all: Socket[] = [];
    readyState = 1;
    sent: unknown[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor() {
        Socket.all.push(this);
    }
    send(text: string) {
        this.sent.push(JSON.parse(text));
    }
    message(event: GenerationEvent) {
        this.onmessage?.({ data: JSON.stringify(event) });
    }
    close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
    }
}

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
    vi.stubGlobal("WebSocket", Socket);
    Socket.all = [];
    vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    vi.spyOn(document, "addEventListener").mockImplementation(() => {});
});
afterEach(() => {
    Socket.all.forEach((socket) => socket.close());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});
async function boot() {
    const b = await bootMutations((fake) => {
        server.current = fake;
    });
    const transport = await import("./generationJobs");
    const epoch = b.fake.store.epoch();
    const follow = transport.followGenerationJob("J", (event) =>
        transport.applyGenerationEvent("J", refK, event, follow),
    );
    await Promise.resolve();
    const socket = Socket.all[0];
    const accepted = (text: string, seq = 0, generationId = "g"): GenerationEvent => ({
        type: "accepted",
        epoch,
        jobId: "J",
        messageId: "b",
        generationId,
        revision: b.fake.chat("c", "k")!.revision,
        text,
        seq,
    });
    const chunk = (
        base: number,
        keep: number,
        text: string,
        seq = base + 1,
        messageId = "b",
        generationId = "g",
    ): GenerationEvent => ({ type: "chunk", epoch, messageId, generationId, base, keep, text, seq });
    const text = () => b.chat.findChat(refK)!.message.find((row) => row.chatId === "b")!.data;
    const resource = (seq: number, value = "B"): GenerationEvent => {
        const record = b.fake.chat("c", "k")!;
        return {
            type: "resource",
            epoch,
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: record.revision,
            data: { ...record.data, message: [m("a", "A", "char"), m("b", value), m("c", "C", "char")] },
            streaming: [{ messageId: "b", generationId: "g", seq }],
        };
    };
    return { ...b, transport, socket, follow, accepted, chunk, text, resource };
}

describe("delta replies in the real tab mirror", () => {
    it("reconstructs a continued UTF-16 reply and a trim from buffered text while the display lags", async () => {
        const b = await boot();
        b.socket.message(b.accepted("A😀old suffix"));
        b.socket.message(b.chunk(0, 3, "new suffix"));
        expect(b.text()).toBe("A😀old suffix");
        b.socket.message(b.chunk(1, 13, "!"));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("A😀new suffix!");
        b.socket.message(b.chunk(2, 3, ""));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("A😀");
        expect(b.socket.sent).toEqual([]);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        expect(await b.sync.flushResources()).toEqual({ discarded: [] });
        expect(b.fake.requests).toEqual([]);
    });

    it("reconstructs from the raw stream when a stored checkpoint hides it", async () => {
        const b = await boot();
        b.socket.message(b.accepted("raw"));
        b.socket.message(b.chunk(0, 3, " text"));
        b.socket.message(b.resource(1, "PROCESSED CHECKPOINT"));
        expect(b.text()).toBe("PROCESSED CHECKPOINT");
        b.socket.message(b.chunk(1, 8, " next"));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("raw text next");
        expect(b.socket.sent).toEqual([]);
        expect(b.fake.requests).toEqual([]);
    });

    it.each([
        "no entry",
        "placeholder",
        "other base",
        "other generation",
        "negative keep",
        "fractional keep",
        "oversized keep",
    ])("recovers %s once until accepted, then applies the next chunk", async (miss) => {
        const b = await boot();
        let event = b.chunk(0, 0, "lost");
        if (miss === "placeholder") b.socket.message(b.resource(0));
        else if (miss !== "no entry") {
            b.socket.message(b.accepted("seed"));
            if (miss === "other base") event = b.chunk(9, 4, "lost", 10);
            if (miss === "other generation") event = b.chunk(0, 4, "lost", 1, "b", "unknown");
            if (miss === "negative keep") event = b.chunk(0, -1, "lost");
            if (miss === "fractional keep") event = b.chunk(0, 1.5, "lost");
            if (miss === "oversized keep") event = b.chunk(0, 5, "lost");
        }
        b.socket.message(event);
        b.socket.message(event);
        expect(b.socket.sent).toEqual([{ type: "resyncReply" }]);
        expect(b.chat.isChatBehind(refK)).toBe(false);
        expect(b.fake.requests).toEqual([]);
        b.socket.message(b.accepted("current😀", 10));
        b.socket.message(b.chunk(10, 9, "!", 11));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("current😀!");
        b.socket.message(b.chunk(99, 0, "miss again", 100));
        expect(b.socket.sent).toEqual([{ type: "resyncReply" }, { type: "resyncReply" }]);
        expect(await b.sync.flushResources()).toEqual({ discarded: [] });
        expect(b.fake.requests).toEqual([]);
    });

    it("silently drops a missing message without consuming the follow's recovery slot", async () => {
        const b = await boot();
        b.socket.message(b.chunk(0, 0, "ghost", 1, "missing"));
        expect(b.socket.sent).toEqual([]);
        expect(b.chat.findChat(refK)!.message.map((row) => row.chatId)).toEqual(["a", "b", "c"]);
        b.socket.message(b.chunk(0, 0, "recover", 1));
        expect(b.socket.sent).toEqual([{ type: "resyncReply" }]);
        expect(b.fake.requests).toEqual([]);
    });

    it("silently drops a retired generation's chunk and keeps its successor's stream", async () => {
        const b = await boot();
        b.socket.message(b.accepted("old", 0, "retired"));
        b.socket.message(b.accepted("new", 0, "g"));
        b.socket.message(b.chunk(77, 99, "late", 78, "b", "retired"));
        expect(b.socket.sent).toEqual([]);
        b.socket.message(b.chunk(0, 3, "!"));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("new!");
        expect(b.fake.requests).toEqual([]);
    });
    it("gives a replacement follow its own outstanding reply recovery", async () => {
        const b = await boot();
        b.socket.message(b.chunk(0, 0, "missing base"));
        expect(b.socket.sent).toEqual([{ type: "resyncReply" }]);
        const next = b.transport.followGenerationJob("J", (event) =>
            b.transport.applyGenerationEvent("J", refK, event, next),
        );
        await Promise.resolve();
        const socket = Socket.all[1];
        socket.message(b.chunk(0, 0, "still missing"));
        socket.message(b.chunk(1, 0, "another miss"));
        expect(socket.sent).toEqual([{ type: "resyncReply" }]);
        expect(b.socket.sent).toEqual([{ type: "resyncReply" }]);
        socket.message(b.accepted("current", 3));
        socket.message(b.chunk(3, 7, "!", 4));
        await vi.advanceTimersByTimeAsync(40);
        expect(b.text()).toBe("current!");
        expect(b.fake.requests).toEqual([]);
    });
});
