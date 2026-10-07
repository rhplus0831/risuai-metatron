import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 9b (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// "After the challenge, 9b"): the request boundary `withRequestChat` (`request.ts`), over the real
// chat module. The request's chat is pinned and loaded from the start until the request ends: a
// chat that is not listed, could not be loaded, or was replaced under the same ids meanwhile fails
// the request (a streamed reply's source is cancelled); an accepted stream is wrapped
// (`guardStream`): it checks the chat on every chunk and at its end, errors after a replacement, and
// keeps the chat pinned until it ends, fails, or is cancelled. The pin is observed through the LRU:
// a pinned chat survives a trim that evicts the least recently used idle chats; a released one does not.

const stubs = vi.hoisted(() => ({
    readRefs: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("src/ts/storage/serverAuth", () => ({ authFetch: vi.fn(), getNodeServerProxyAuth: async () => "" }));
vi.mock("src/ts/storage/resourceClient", () => ({
    readRefs: (...args: unknown[]) => stubs.readRefs(...args),
    getResourceEpoch: () => "epoch-1",
    epochMismatch: (epoch: string) => new Error(`replaced ${epoch}`),
}));
vi.mock("src/ts/process/request/transport", () => ({ requestServer: vi.fn() }));
vi.mock("src/ts/process/mcp/mcp", () => ({ getTools: vi.fn(async () => []) }));
vi.mock("src/ts/plugins/pluginHooks", () => ({
    pluginHooks: new Proxy({}, { get: () => new Set() }),
}));
vi.mock("src/ts/plugins/apiV3/pluginContext", () => ({
    capturePluginContext: () => undefined,
    invokeHook: async (fn: (...args: unknown[]) => unknown, _context: unknown, ...args: unknown[]) => fn(...args),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuEscape: (text: string) => text,
    risuUnescape: (text: string) => text,
    risuChatParser: (text: string) => text,
}));
vi.mock("src/ts/process/transformers", () => ({ runTransformers: vi.fn() }));
vi.mock("src/ts/process/templates/chatTemplate", () => ({ applyChatTemplate: vi.fn() }));
vi.mock("src/ts/process/stringlize", () => ({ unstringlizeChat: vi.fn() }));
vi.mock("src/ts/model/modellist", () => ({ getModelInfo: vi.fn(), LLMFlags: {}, LLMFormat: {} }));
vi.mock("src/ts/process/request/shared", () => ({
    applyAdditionalParameters: vi.fn(),
    applyParameters: vi.fn(),
    getAdditionalParameters: vi.fn(),
}));
vi.mock("src/ts/util", () => ({ sleep: async () => {}, checkPersonaBinded: () => null }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import {
    assembleChats,
    ensureChatLoaded,
    findChat,
    installCharacterChats,
    seedChats,
    trimLoadedChats,
} from "src/ts/storage/chatStore.svelte";
import { requestChatHeld, withRequestChat } from "../request";
import type { requestDataResponse } from "../request";

/** A parsable revision token (the trim evicts saved chats only; a load compares revisions). */
const REVISION = "00000000-0000-4000-8000-000000000000:1:1";
const target = { chaId: "a", chatId: "a1" };
const OTHERS = Array.from({ length: 9 }, (_, i) => `b${i + 1}`);
const chatOf = (id: string) => ({ id, name: id.toUpperCase(), note: "", localLore: [], message: [] });

/**
 * Character `a` with `a1` held as its summary (the request's chat, read through `stubs.readRefs`) and
 * `b1`..`b9` loaded, every revision held. Nothing is selected.
 */
function install() {
    const raw: Record<string, unknown> = {
        botPresets: [{ id: "preset-1", name: "P" }],
        personas: [{ id: "persona-1", name: "U" }],
        characters: [{ chaId: "a", type: "character", name: "A", chatPage: 0, chats: [] }],
    };
    initializeRecords(takeRecordFields(raw));
    const chats = [
        { characterId: "a", id: "a1", revision: REVISION, name: "A1", fmIndex: -1 },
        ...OTHERS.map((id) => ({ characterId: "a", id, revision: REVISION, data: chatOf(id) as never })),
    ];
    const orders = [{ characterId: "a", revision: REVISION, ids: ["a1", ...OTHERS] }];
    seedChats(chats, orders);
    assembleChats([{ chaId: "a" }], chats, orders);
}

/**
 * Whether `a1` is pinned: the others are marked as used after it, so a trim takes `a1` first unless
 * a pin keeps it (the trim keeps eight idle chats; ten are loaded).
 */
async function pinned(): Promise<boolean> {
    for (const id of OTHERS) {
        await ensureChatLoaded({ chaId: "a", chatId: id });
    }
    trimLoadedChats();
    return findChat(target) !== undefined;
}

/** A source stream the test drives, recording its cancellations. */
function source() {
    let controller!: ReadableStreamDefaultController<unknown>;
    const cancelled: unknown[] = [];
    const stream = new ReadableStream<unknown>({
        start(c) {
            controller = c;
        },
        cancel(reason) {
            cancelled.push(reason);
        },
    });
    return {
        stream,
        cancelled,
        push: (value: unknown) => controller.enqueue(value),
        close: () => controller.close(),
        fail: (error: Error) => controller.error(error),
    };
}

const streaming = (stream: ReadableStream<unknown>): requestDataResponse =>
    ({ type: "streaming", result: stream }) as never;
const ok: requestDataResponse = { type: "success", result: "ok" };
const gone = "The chat this request is for no longer exists";
const replaceA = () => installCharacterChats("a", ["a1", ...OTHERS].map(chatOf) as never, { firstMsgIndex: -1 });

beforeEach(() => {
    stubs.readRefs.mockReset().mockImplementation(async (_refs, options) => ({
        epoch: "epoch-1",
        items: [],
        chatCollections: [],
        chatSummaryCollections: [],
        chats: ((options as { chats?: { characterId: string; id: string }[] }).chats ?? []).map(
            ({ characterId, id }) => ({ characterId, id, revision: REVISION, data: chatOf(id) }),
        ),
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    install();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("withRequestChat", () => {
    it("loads the request's chat before `run`, keeps it pinned through `run`, and releases it after", async () => {
        expect(findChat(target)).toBeUndefined();
        let seenInside: boolean | null = null;
        const result = await withRequestChat(target, async () => {
            expect(findChat(target)?.name).toBe("A1");
            seenInside = await pinned();
            return ok;
        });
        expect(result).toEqual(ok);
        expect(seenInside).toBe(true);
        expect(stubs.readRefs).toHaveBeenCalledTimes(1);
        expect(await pinned()).toBe(false);
    });

    it("runs as it is without a target; fails for a chat that is not listed, one whose load fails, and one deleted or replaced while the load was out", async () => {
        const run = vi.fn(async () => ok);
        expect(await withRequestChat(null, run)).toEqual(ok);
        expect(run).toHaveBeenCalledTimes(1);
        expect(await withRequestChat({ chaId: "a", chatId: "nope" }, run)).toEqual({ type: "fail", result: gone });
        stubs.readRefs.mockRejectedValueOnce(new Error("offline"));
        expect(await withRequestChat(target, run)).toEqual({
            type: "fail",
            result: "The chat could not be loaded: offline",
        });
        // Replaced under the same ids while the load was out: the load belongs to the old owner.
        let release!: () => void;
        stubs.readRefs.mockImplementationOnce(async (...args) => {
            await new Promise<void>((resolve) => (release = resolve));
            return stubs.readRefs.getMockImplementation()!(...args);
        });
        const pending = withRequestChat(target, run);
        await Promise.resolve();
        replaceA();
        release();
        expect(await pending).toEqual({ type: "fail", result: gone });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("drops the reply of a request whose chat was replaced during `run` (a streamed reply's source is cancelled), and keeps the owner the caller captured", async () => {
        const { stream, cancelled } = source();
        const result = await withRequestChat(target, async () => {
            replaceA();
            return streaming(stream);
        });
        expect(result).toEqual({ type: "fail", result: gone });
        await Promise.resolve();
        expect(cancelled).toHaveLength(1);
        // An owner captured before the call (the request began earlier) is checked, not the one at the call.
        await ensureChatLoaded(target);
        expect(await withRequestChat(target, async () => ok, "0/0")).toEqual({ type: "fail", result: gone });
        expect(requestChatHeld(null, undefined)).toBe(true);
        expect(requestChatHeld(target, undefined)).toBe(true);
        expect(requestChatHeld(target, "0/0")).toBe(false);
        expect(requestChatHeld({ chaId: "a", chatId: "nope" }, undefined)).toBe(false);
    });
});

describe("the guarded stream", () => {
    it("passes chunks and the end while the chat is the request's, and releases the pin at the end", async () => {
        const { stream, push, close } = source();
        const result = (await withRequestChat(target, async () => streaming(stream))) as {
            result: ReadableStream<unknown>;
        };
        expect(result.result).not.toBe(stream);
        const reader = result.result.getReader();
        push("one");
        expect(await reader.read()).toEqual({ done: false, value: "one" });
        expect(await pinned()).toBe(true);
        push("two");
        close();
        expect(await reader.read()).toEqual({ done: false, value: "two" });
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(await pinned()).toBe(false);
    });

    it("errors at the next read after the chat was replaced, cancelling the source", async () => {
        const { stream, push, cancelled } = source();
        const result = (await withRequestChat(target, async () => streaming(stream))) as {
            result: ReadableStream<unknown>;
        };
        const reader = result.result.getReader();
        push("one");
        expect(await reader.read()).toEqual({ done: false, value: "one" });
        replaceA();
        push("two");
        await expect(reader.read()).rejects.toThrow(gone);
        expect(cancelled).toHaveLength(1);
    });

    it("releases the pin when the consumer cancels (cancelling the source) and when the source fails", async () => {
        const first = source();
        const cancelling = (await withRequestChat(target, async () => streaming(first.stream))) as {
            result: ReadableStream<unknown>;
        };
        const reader = cancelling.result.getReader();
        expect(await pinned()).toBe(true);
        await reader.cancel("enough");
        expect(first.cancelled).toEqual(["enough"]);
        expect(await pinned()).toBe(false);

        install();
        const second = source();
        const failing = (await withRequestChat(target, async () => streaming(second.stream))) as {
            result: ReadableStream<unknown>;
        };
        const failingReader = failing.result.getReader();
        expect(await pinned()).toBe(true);
        second.fail(new Error("boom"));
        await expect(failingReader.read()).rejects.toThrow("boom");
        expect(await pinned()).toBe(false);
    });
});
