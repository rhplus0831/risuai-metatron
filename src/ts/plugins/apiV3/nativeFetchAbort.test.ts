import { MessageChannel as NodeMessageChannel, MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => "hash"),
    risuChatParser: (s: string) => s,
    risuChatParserScoped: (s: string) => s,
    risuEscape: (s: string) => s,
    risuUnescape: (s: string) => s,
}));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn(), getModules: () => [], getModuleMcps: () => [] }));
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(),
}));

import { fetchNative } from "src/ts/globalApi.svelte";
import { UNREAD_PLUGIN_STREAM_TIMEOUT_MS } from "./factory";
import { executePluginV3, loadV3Plugins } from "./v3.svelte";

type Reply = {
    data: {
        type: string;
        reqId: string;
        error?: string;
        result?: {
            __type: string;
            __specialType: string;
            value: { __type: string; portIndex: number } | null;
            init: { status: number };
        };
    };
    ports: MessagePort[];
};

const url = "https://example.test/plugin-stream";
let guest: Window;
let replyToGuest: (reply: Reply) => void;
const guestPorts = new Set<MessagePort>();
const send = (data: object) => window.dispatchEvent(new MessageEvent("message", { source: guest, data }));
const callNativeFetch = (abortId: string) => {
    const reply = new Promise<Reply>((resolve) => {
        replyToGuest = resolve;
    });
    send({
        type: "CALL_ROOT",
        reqId: abortId,
        method: "nativeFetch",
        args: [url, { signal: { __type: "ABORT_SIGNAL_REF", abortId, aborted: false } }],
    });
    return reply;
};
const bodyPort = (reply: Reply) => {
    expect(reply.data.error).toBeUndefined();
    expect(reply.data.result).toMatchObject({
        __type: "CALLBACK_STREAMS",
        __specialType: "Response",
        value: { __type: "STREAM_PORT", portIndex: 0 },
        init: { status: 200 },
    });
    expect(reply.ports).toHaveLength(1);
    return reply.ports[reply.data.result!.value!.portIndex];
};
const pull = (port: MessagePort) =>
    new Promise<{ done: boolean; value?: Uint8Array; error?: string }>((resolve) => {
        port.onmessage = (event) => {
            port.onmessage = null;
            resolve(event.data);
        };
        port.start();
        port.postMessage({ pull: true });
    });
const hostSignal = () => vi.mocked(fetchNative).mock.calls.at(-1)![1]!.signal!;

beforeEach(async () => {
    vi.mocked(fetchNative).mockReset();
    // Use real MessagePorts; only the iframe's guest endpoint is simulated.
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    vi.stubGlobal("MessagePort", NodeMessagePort);
    if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {});
    guest = {
        postMessage(data: Reply["data"], _origin: string, ports: MessagePort[] = []) {
            for (const port of ports) guestPorts.add(port);
            replyToGuest({ data, ports });
        },
    } as unknown as Window;
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(guest);
    // happy-dom must not execute a second guest: the tests speak its protocol below.
    vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(() => {});
    await executePluginV3({ name: "native-fetch-abort", version: "3.0", script: "" } as never);
});

afterEach(async () => {
    vi.useRealTimers();
    await loadV3Plugins([]);
    for (const port of guestPorts) port.close();
    guestPorts.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("nativeFetch aborts through SandboxHost", () => {
    it("aborts the host fetch after headers while the guest is reading the body", async () => {
        const cancelled = vi.fn();
        vi.mocked(fetchNative).mockResolvedValue(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("first chunk"));
                    },
                    cancel: cancelled,
                }),
            ),
        );
        const reply = await callNativeFetch("reading-body");
        expect(reply.data).toMatchObject({ type: "RESPONSE", reqId: "reading-body" });
        const port = bodyPort(reply);
        const signal = hostSignal();
        const aborted = vi.fn();
        signal.addEventListener("abort", aborted);
        expect(signal.aborted).toBe(false);
        const chunk = await pull(port);
        expect(chunk.done).toBe(false);
        expect(new TextDecoder().decode(chunk.value)).toBe("first chunk");

        send({ type: "ABORT_SIGNAL", abortId: "reading-body" });
        expect(signal.aborted).toBe(true);
        expect(aborted).toHaveBeenCalledTimes(1);
        port.postMessage({ cancel: true });
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    });

    it("ignores late aborts after body completion, a bodyless response or a thrown fetch", async () => {
        for (const outcome of ["finished", "bodyless", "thrown"] as const) {
            if (outcome === "thrown") vi.mocked(fetchNative).mockRejectedValueOnce(new Error("fetch failed"));
            else vi.mocked(fetchNative).mockResolvedValueOnce(new Response(outcome === "finished" ? "done" : null));

            const reply = await callNativeFetch(outcome);
            expect(reply.data).toMatchObject({ type: "RESPONSE", reqId: outcome });
            if (outcome === "finished") {
                const port = bodyPort(reply);
                const chunk = await pull(port);
                expect(chunk.done).toBe(false);
                expect(new TextDecoder().decode(chunk.value)).toBe("done");
                expect(await pull(port)).toEqual({ done: true });
            } else {
                expect(reply.ports).toEqual([]);
                if (outcome === "thrown") expect(reply.data.error).toBe("fetch failed");
                else {
                    expect(reply.data.error).toBeUndefined();
                    expect(reply.data.result).toMatchObject({ __specialType: "Response", value: null });
                }
            }

            const signal = hostSignal();
            const aborted = vi.fn();
            signal.addEventListener("abort", aborted);
            expect(signal.aborted, outcome).toBe(false);
            send({ type: "ABORT_SIGNAL", abortId: outcome });
            expect(signal.aborted, outcome).toBe(false);
            expect(aborted, outcome).not.toHaveBeenCalled();
        }
    });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const bodyOf = (chunks: string[], cancel: () => void) =>
    new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(bytes(chunk));
            },
            cancel,
        }),
    );
const signalRef = (abortId: string) => ({ signal: { __type: "ABORT_SIGNAL_REF", abortId, aborted: false } });

describe("unread nativeFetch bodies expire", () => {
    it("cancels a body the plugin never pulls from at 60 s and tells the plugin why", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const cancelled = vi.fn();
        vi.mocked(fetchNative).mockResolvedValue(bodyOf(["never read"], cancelled));
        const port = bodyPort(await callNativeFetch("unread"));
        const received: unknown[] = [];
        port.onmessage = (event) => received.push(event.data);
        port.start();

        await vi.advanceTimersByTimeAsync(UNREAD_PLUGIN_STREAM_TIMEOUT_MS - 1);
        expect(cancelled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(cancelled).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(received).toEqual([{ done: true, error: "Unread plugin response expired" }]));

        // The stream's end released the call's abort controller.
        const signal = hostSignal();
        send({ type: "ABORT_SIGNAL", abortId: "unread" });
        expect(signal.aborted).toBe(false);
    });

    it("keeps a body the plugin has pulled from, however slowly it reads on", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const cancelled = vi.fn();
        vi.mocked(fetchNative).mockResolvedValue(bodyOf(["first", "second"], cancelled));
        const port = bodyPort(await callNativeFetch("pulled"));

        await vi.advanceTimersByTimeAsync(UNREAD_PLUGIN_STREAM_TIMEOUT_MS - 1);
        const first = await pull(port);
        expect(new TextDecoder().decode(first.value)).toBe("first");
        await vi.advanceTimersByTimeAsync(10 * UNREAD_PLUGIN_STREAM_TIMEOUT_MS);
        expect(cancelled).not.toHaveBeenCalled();
        const second = await pull(port);
        expect(second.done).toBe(false);
        expect(new TextDecoder().decode(second.value)).toBe("second");
        expect(hostSignal().aborted).toBe(false);
    });
});

describe("terminate ends host calls", () => {
    it("aborts a nativeFetch still waiting for headers, and bridges nothing when it resolves later", async () => {
        let resolveFetch!: (response: Response) => void;
        vi.mocked(fetchNative).mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        const replies: Reply[] = [];
        replyToGuest = (reply) => replies.push(reply);
        send({ type: "CALL_ROOT", reqId: "late", method: "nativeFetch", args: [url, signalRef("late")] });
        await vi.waitFor(() => expect(fetchNative).toHaveBeenCalledTimes(1));
        const signal = hostSignal();
        expect(signal.aborted).toBe(false);

        let channels = 0;
        vi.stubGlobal(
            "MessageChannel",
            class extends NodeMessageChannel {
                constructor() {
                    super();
                    channels++;
                }
            },
        );
        await loadV3Plugins([]);
        expect(signal.aborted).toBe(true);

        // A fetch that ignores its signal still resolves; its body is cancelled, never bridged.
        const cancelled = vi.fn();
        resolveFetch(bodyOf(["late"], cancelled));
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
        expect(channels).toBe(0);
        expect(replies.filter((reply) => reply.data.reqId === "late")).toEqual([]);
    });
});
